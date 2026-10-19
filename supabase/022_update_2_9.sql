-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 2.9: split payment links, link history, corrections without a reason
-- 1. A payment can be linked to several invoices. Each link takes only what the invoice still needs; the rest of the
--    payment stays AVAILABLE and can be linked to another invoice (until then it pays the oldest invoices first). A
--    payment that is fully linked no longer shows in Link a Payment. Every link and unlink is kept as the invoice's
--    linked payment history.
-- 2. When the customer has paid more than everything owed, the extra shows on the newest invoice as a negative
--    balance (for example -123.00), the same amount as the account's negative balance.
-- 3. A correction needs no reason. The person who asked is told when the Director approves it, with the Director's
--    name.
-- 4. Documents issued from the customer's Request menu are written in the customer's history.
-- Run once in the Supabase SQL Editor after 021_join_us.sql. It is safe to run again.
-- =====================================================================

-- ---------- 1. payment links ----------
create table if not exists public.payment_links (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments_received(id) on delete cascade,
  invoice_id uuid not null references public.customer_invoices(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  amount numeric(14,2) not null check (amount > 0),
  linked_at timestamptz not null default now(),
  linked_by uuid references public.profiles(id) on delete set null,
  linked_by_name text,
  removed_at timestamptz,
  removed_by uuid references public.profiles(id) on delete set null,
  removed_by_name text
);
create index if not exists payment_links_payment_idx on public.payment_links(payment_id);
create index if not exists payment_links_invoice_idx on public.payment_links(invoice_id);
create index if not exists payment_links_customer_idx on public.payment_links(customer_id);
create index if not exists payment_links_linked_by_idx on public.payment_links(linked_by);
create index if not exists payment_links_removed_by_idx on public.payment_links(removed_by);
alter table public.payment_links enable row level security;
revoke all on public.payment_links from anon;
grant select on public.payment_links to authenticated;
drop policy if exists "plinks: active read" on public.payment_links;
create policy "plinks: active read" on public.payment_links for select to authenticated using ((select public.is_active()));

-- The links made before (one invoice per payment, update 2.7.3) become link rows: on each invoice the payments are
-- taken in the order they were paid, each up to what the invoice still needed (the rest of a payment stays available,
-- as it was: it paid the oldest invoices). Then the old one-invoice link is cleared.
do $$
declare r record; need numeric; take numeric; cur uuid := null;
begin
  if exists (select 1 from public.payment_links) then return; end if;
  for r in
    select p.id as pay, p.amount, p.customer_id, p.created_by, p.created_by_name, p.created_at, i.id as inv,
           i.total_amount - coalesce((select sum(m.request_amount) from public.credit_memos m
             where m.invoice_id = i.id and m.status in ('approved','paid') and m.requested_action in ('credit','discount')), 0) as owed
    from public.payments_received p join public.customer_invoices i on i.id = p.invoice_id and i.customer_id = p.customer_id
    order by i.id, p.paid_date, p.created_at, p.id
  loop
    if cur is distinct from r.inv then cur := r.inv; need := greatest(0, r.owed); end if;
    take := least(r.amount, need);
    if take > 0 then
      insert into public.payment_links (payment_id, invoice_id, customer_id, amount, linked_at, linked_by_name)
      values (r.pay, r.inv, r.customer_id, take, r.created_at, 'E-Portal (link before update 2.9)');
      need := need - take;
    end if;
  end loop;
  perform set_config('eo.allow_change', 'on', true);
  update public.payments_received set invoice_id = null where invoice_id is not null;
  perform set_config('eo.allow_change', 'off', true);
end $$;

-- What each invoice has been paid: approved returns of the invoice first, then the payment amounts linked to it, then
-- everything else on the account (the unlinked part of each payment, credits, discounts, take-off adjustments) pays the
-- oldest invoices first. What is left after everything owed is paid goes on the newest invoice, so its balance is
-- negative (the customer has paid more than owed).
create or replace view public.invoice_balances with (security_invoker = true) as
with lp as (
  select l.invoice_id, sum(l.amount)::numeric as amount
  from public.payment_links l where l.removed_at is null group by l.invoice_id
),
lr as (
  select m.invoice_id, sum(m.request_amount)::numeric as amount
  from public.credit_memos m
  where m.invoice_id is not null and m.status in ('approved','paid') and m.requested_action in ('credit','discount')
  group by m.invoice_id
),
inv as (
  select i.id, i.customer_id, i.total_amount,
    least(i.total_amount, coalesce(r.amount, 0))::numeric as ret,
    greatest(0, coalesce(r.amount, 0) - i.total_amount)::numeric as ret_extra,
    coalesce(l.amount, 0)::numeric as lpay
  from public.customer_invoices i left join lp l on l.invoice_id = i.id left join lr r on r.invoice_id = i.id
),
inv2 as (
  select x.*, least(x.total_amount - x.ret, x.lpay)::numeric as direct,
    (greatest(0, x.lpay - (x.total_amount - x.ret)) + x.ret_extra)::numeric as extra
  from inv x
),
pool as (
  select c.id as customer_id,
    coalesce((select sum(p.amount) from public.payments_received p where p.customer_id = c.id), 0)
    - coalesce((select sum(l.amount) from public.payment_links l
                join public.payments_received p on p.id = l.payment_id and p.customer_id = c.id
                join public.customer_invoices x on x.id = l.invoice_id and x.customer_id = c.id
                where l.removed_at is null), 0)
    + coalesce((select sum(x.extra) from inv2 x where x.customer_id = c.id), 0)
    + coalesce((select sum(m.request_amount) from public.credit_memos m
                where m.customer_id = c.id and m.status in ('approved','paid') and m.requested_action in ('credit','discount')
                  and (m.invoice_id is null
                    or not exists (select 1 from public.customer_invoices x where x.id = m.invoice_id and x.customer_id = c.id))), 0)
    + coalesce((select sum(o.amount) from public.order_letters o
                where o.customer_id = c.id and o.status = 'applied' and o.subject_type = 'settlement' and o.adjust_type = 'reduce'), 0) as amount
  from public.customers c
),
owed as (
  select c.id as customer_id, null::uuid as invoice_id, c.application_date as d, 0 as k, c.created_at as t, c.opening_balance::numeric as amount
    from public.customers c where c.opening_balance > 0
  union all
  select i.customer_id, i.id, i.invoice_date, 1, i.created_at, (i.total_amount - x.ret - x.direct)::numeric
    from public.customer_invoices i join inv2 x on x.id = i.id
  union all
  select o.customer_id, null::uuid, (coalesce(o.applied_at, o.created_at) at time zone 'Asia/Manila')::date, 2, o.created_at, o.amount::numeric
    from public.order_letters o
    where o.customer_id is not null and o.status = 'applied'
      and (o.subject_type = 'charge' or (o.subject_type = 'settlement' and o.adjust_type = 'add'))
),
fifo as (
  select w.invoice_id, w.customer_id, w.amount,
    coalesce(sum(w.amount) over (partition by w.customer_id order by w.d, w.k, w.t, w.invoice_id
                                 rows between unbounded preceding and 1 preceding), 0) as before,
    sum(w.amount) over (partition by w.customer_id) as total
  from owed w
),
newest as (
  select distinct on (i.customer_id) i.customer_id, i.id
  from public.customer_invoices i order by i.customer_id, i.invoice_date desc, i.created_at desc, i.id desc
),
paid as (
  select f.invoice_id as id, x.ret,
    (x.direct + greatest(0, least(f.amount, coalesce(pl.amount, 0) - f.before))
       + case when nw.id = f.invoice_id then greatest(0, coalesce(pl.amount, 0) - f.total) else 0 end)::numeric(14,2) as amount
  from fifo f join inv2 x on x.id = f.invoice_id left join pool pl on pl.customer_id = f.customer_id
    left join newest nw on nw.customer_id = f.customer_id
  where f.invoice_id is not null
)
select i.id, i.invoice_no, i.customer_id, i.invoice_date, i.purchase_date, i.po_number, i.total_boxes, i.total_pcs,
  i.total_amount, i.created_by, i.created_by_name, i.created_at,
  c.first_name, c.last_name, c.account_no, c.business_name, c.status as customer_status,
  pd.amount as amount_paid,
  (i.total_amount - pd.ret - pd.amount)::numeric(14,2) as balance,
  case when pd.ret + pd.amount >= i.total_amount then 'paid' when pd.ret + pd.amount > 0 then 'partial' else 'unpaid' end as pay_status,
  i.payment_terms,
  case when i.payment_terms ~ '^[0-9]{1,3} DAYS$' then i.invoice_date + split_part(i.payment_terms, ' ', 1)::int
       when i.payment_terms = 'CASH ON DELIVERY' then i.invoice_date end as due_date,
  pd.ret::numeric(14,2) as amount_returned
from public.customer_invoices i
join public.customers c on c.id = i.customer_id
join paid pd on pd.id = i.id;

-- Each payment: its amount, what is linked to invoices, and what is still available to link.
create or replace view public.payment_available with (security_invoker = true) as
select p.id, p.customer_id, p.receipt_no, p.paid_date, p.amount,
  coalesce(l.linked, 0)::numeric(14,2) as linked,
  (p.amount - coalesce(l.linked, 0))::numeric(14,2) as available
from public.payments_received p
left join (select payment_id, sum(amount) as linked from public.payment_links where removed_at is null group by payment_id) l on l.payment_id = p.id;
revoke all on public.payment_available from anon;
grant select on public.payment_available to authenticated;

-- Link a payment to an invoice of the same customer: p_amount (or, when it is not given, as much as the invoice still
-- needs, up to what the payment has available). p_invoice null: take off every link of the payment (the portal before
-- 2.9 unlinked this way). Staff who record payments or invoices, and the Director.
drop function if exists public.link_payment(uuid, uuid);
create or replace function public.link_payment(p_payment uuid, p_invoice uuid, p_amount numeric default null) returns public.payment_links
language plpgsql security definer set search_path = '' as $$
declare p public.payments_received; i public.customer_invoices; l public.payment_links; me text; avail numeric; need numeric; amt numeric;
begin
  if not (public.can_write('payments') or public.can_write('invoices')) then
    raise exception 'You do not have access to link payments';
  end if;
  select * into p from public.payments_received where id = p_payment for update;
  if not found then raise exception 'Payment not found'; end if;
  me := (select full_name from public.profiles where id = auth.uid());
  if p_invoice is null then
    for l in select * from public.payment_links where payment_id = p_payment and removed_at is null loop
      perform public.unlink_payment(l.id);
    end loop;
    return null;
  end if;
  select * into i from public.customer_invoices where id = p_invoice;
  if not found or i.customer_id <> p.customer_id then raise exception 'This invoice is not of the same customer'; end if;
  avail := p.amount - coalesce((select sum(amount) from public.payment_links where payment_id = p_payment and removed_at is null), 0);
  need := i.total_amount
    - coalesce((select sum(m.request_amount) from public.credit_memos m
                where m.invoice_id = i.id and m.status in ('approved','paid') and m.requested_action in ('credit','discount')), 0)
    - coalesce((select sum(amount) from public.payment_links where invoice_id = i.id and removed_at is null), 0);
  if avail <= 0 then raise exception 'Receipt % is already fully linked', p.receipt_no; end if;
  if need <= 0 then raise exception 'Invoice % is already fully paid by linked payments', i.invoice_no; end if;
  amt := coalesce(p_amount, least(avail, need));
  if amt <= 0 then raise exception 'Enter the amount to link'; end if;
  if amt > avail then raise exception 'Only PHP % of receipt % is available', to_char(avail, 'FM999,999,990.00'), p.receipt_no; end if;
  if amt > need then raise exception 'Invoice % needs only PHP %', i.invoice_no, to_char(need, 'FM999,999,990.00'); end if;
  insert into public.payment_links (payment_id, invoice_id, customer_id, amount, linked_by, linked_by_name)
  values (p.id, i.id, p.customer_id, amt, auth.uid(), me)
  returning * into l;
  insert into public.customer_events (customer_id, action, note, actor, actor_name)
  values (p.customer_id, 'payment linked',
          coalesce(p.receipt_no, '') || ' → ' || i.invoice_no || ' · PHP ' || to_char(amt, 'FM999,999,990.00'), auth.uid(), me);
  return l;
end;
$$;
revoke execute on function public.link_payment(uuid, uuid, numeric) from public, anon;
grant execute on function public.link_payment(uuid, uuid, numeric) to authenticated;

-- Take off one link: it stays in the invoice's history as UNLINKED, and its amount is available again.
create or replace function public.unlink_payment(p_link uuid) returns public.payment_links
language plpgsql security definer set search_path = '' as $$
declare l public.payment_links; me text;
begin
  if not (public.can_write('payments') or public.can_write('invoices')) then
    raise exception 'You do not have access to link payments';
  end if;
  select * into l from public.payment_links where id = p_link for update;
  if not found then raise exception 'Link not found'; end if;
  if l.removed_at is not null then raise exception 'This link was already taken off'; end if;
  me := (select full_name from public.profiles where id = auth.uid());
  update public.payment_links set removed_at = now(), removed_by = auth.uid(), removed_by_name = me where id = p_link
    returning * into l;
  insert into public.customer_events (customer_id, action, note, actor, actor_name)
  values (l.customer_id, 'payment unlinked',
          coalesce((select receipt_no from public.payments_received where id = l.payment_id), '') || ' unlinked from '
            || coalesce((select invoice_no from public.customer_invoices where id = l.invoice_id), '') || ' · PHP ' || to_char(l.amount, 'FM999,999,990.00'),
          auth.uid(), me);
  return l;
end;
$$;
revoke execute on function public.unlink_payment(uuid) from public, anon;
grant execute on function public.unlink_payment(uuid) to authenticated;

-- When an invoice needs less than its links give (a return, or a lower amount after a correction), the newest links
-- are taken off and, where only part of one is too much, linked again for what the invoice still needs. What is taken
-- off is available again on the payment. Both show in the invoice's linked payment history.
create or replace function public.fit_invoice_links(p_invoice uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare cap numeric; over numeric; l public.payment_links; why text := 'E-Portal (the invoice now needs less)';
begin
  select i.total_amount - coalesce((select sum(m.request_amount) from public.credit_memos m
           where m.invoice_id = i.id and m.status in ('approved','paid') and m.requested_action in ('credit','discount')), 0)
    into cap from public.customer_invoices i where i.id = p_invoice;
  if cap is null then return; end if;
  over := coalesce((select sum(amount) from public.payment_links where invoice_id = p_invoice and removed_at is null), 0) - greatest(cap, 0);
  while over > 0.004 loop
    select * into l from public.payment_links where invoice_id = p_invoice and removed_at is null order by linked_at desc, id desc limit 1;
    exit when not found;
    update public.payment_links set removed_at = now(), removed_by_name = why where id = l.id;
    if l.amount > over then
      insert into public.payment_links (payment_id, invoice_id, customer_id, amount, linked_by_name)
      values (l.payment_id, l.invoice_id, l.customer_id, l.amount - over, why);
    end if;
    insert into public.customer_events (customer_id, action, note, actor_name)
    values (l.customer_id, 'payment link changed',
            coalesce((select receipt_no from public.payments_received where id = l.payment_id), '') || ' → '
              || coalesce((select invoice_no from public.customer_invoices where id = l.invoice_id), '') || ' · PHP '
              || to_char(l.amount, 'FM999,999,990.00') || ' now PHP ' || to_char(greatest(l.amount - over, 0), 'FM999,999,990.00'), why);
    over := over - l.amount;
  end loop;
end;
$$;
revoke execute on function public.fit_invoice_links(uuid) from public, anon, authenticated;

create or replace function public.links_follow_invoice() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'credit_memos' then
    if new.invoice_id is not null then perform public.fit_invoice_links(new.invoice_id); end if;
  elsif new.total_amount < old.total_amount then
    perform public.fit_invoice_links(new.id);
  end if;
  return null;
end;
$$;
revoke execute on function public.links_follow_invoice() from public, anon, authenticated;
drop trigger if exists links_follow_return on public.credit_memos;
create trigger links_follow_return after insert or update of status, request_amount, invoice_id on public.credit_memos
  for each row execute function public.links_follow_invoice();
drop trigger if exists links_follow_amount on public.customer_invoices;
create trigger links_follow_amount after update of total_amount on public.customer_invoices
  for each row execute function public.links_follow_invoice();

-- The oldest amount not paid (the days overdue on orders and on the Request documents): an invoice is unpaid by its
-- own balance (links first, then oldest first); the opening balance and charges by the oldest-first order.
create or replace function public.account_due(p_customer uuid) returns jsonb
language sql stable security definer set search_path = '' set timezone to 'Asia/Manila' as $$
  with paid as (
    select coalesce((select sum(p.amount) from public.payments_received p where p.customer_id = p_customer), 0)
         + coalesce((select sum(m.request_amount) from public.credit_memos m where m.customer_id = p_customer and m.status in ('approved','paid')
                       and m.requested_action in ('credit','discount')), 0)
         + coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = p_customer and o.status = 'applied' and o.subject_type = 'settlement' and o.adjust_type = 'reduce'), 0) as total
  ), inv as (
    select x.invoice_no, x.invoice_date, x.is_inv, sum(x.amount) over (order by x.invoice_date, x.at, x.invoice_no) as running
    from (select 'Opening Balance' as invoice_no, c.application_date as invoice_date, c.created_at as at, c.opening_balance as amount, false as is_inv
          from public.customers c where c.id = p_customer and c.opening_balance > 0
          union all
          select i.invoice_no, i.invoice_date, i.created_at as at, i.total_amount as amount, true from public.customer_invoices i where i.customer_id = p_customer
          union all
          select o.order_no, o.applied_at::date, o.applied_at, o.amount, false from public.order_letters o
          where o.customer_id = p_customer and o.status = 'applied' and (o.subject_type = 'charge' or (o.subject_type = 'settlement' and o.adjust_type = 'add'))) x
  ), other as (
    select inv.invoice_no, inv.invoice_date from inv, paid where inv.running > paid.total and not inv.is_inv order by inv.running limit 1
  ), unpaid as (
    select b.invoice_no, b.invoice_date from public.invoice_balances b
    where b.customer_id = p_customer and b.balance > 0.004 order by b.invoice_date, b.created_at limit 1
  ), oldest as (
    select x.invoice_no, x.invoice_date from (select * from other union all select * from unpaid) x order by x.invoice_date limit 1
  )
  select jsonb_build_object(
    'balance_due', coalesce((select b.balance_due from public.customer_balances b where b.customer_id = p_customer), 0),
    'days_overdue', coalesce((select greatest(0, current_date - o.invoice_date) from oldest o), 0),
    'oldest_invoice_no', (select o.invoice_no from oldest o),
    'oldest_invoice_date', (select o.invoice_date from oldest o))
  where public.is_active();
$$;
revoke execute on function public.account_due(uuid) from public, anon;
grant execute on function public.account_due(uuid) to authenticated;

-- The online check of an invoice shows its balance as on the invoice page (links, returns, a negative balance when
-- overpaid), and an invoice with linked payments is deleted only after they are unlinked.
do $$
declare
  fixes text[][] := array[
    ['verify_record', 'coalesce((select b.amount_paid from public.invoice_balances b where b.id = i.id), 0) as paid',
                      'coalesce((select b.amount_paid from public.invoice_balances b where b.id = i.id), 0) as paid, (select b.balance from public.invoice_balances b where b.id = i.id) as bal, (select b.pay_status from public.invoice_balances b where b.id = i.id) as pst'],
    ['verify_record', '''status'', case when r.paid >= r.total_amount then ''paid'' when r.paid > 0 then ''partial'' else ''unpaid'' end,',
                      '''status'', coalesce(r.pst, case when r.paid >= r.total_amount then ''paid'' when r.paid > 0 then ''partial'' else ''unpaid'' end),'],
    ['verify_record', 'to_char(greatest(r.total_amount - r.paid, 0), ''FM999,999,999,990.00'')',
                      'to_char(coalesce(r.bal, r.total_amount - r.paid), ''FM999,999,999,990.00'')'],
    ['delete_record', 'exists (select 1 from public.payments_received x where x.invoice_id = p_id) then',
                      'exists (select 1 from public.payment_links x where x.invoice_id = p_id and x.removed_at is null) then'],
    ['delete_record', '''This invoice has payments. Delete its payments first''',
                      '''This invoice has linked payments. Unlink them first (Linked Payments on the invoice)''']
  ];
  f record; def text; new_def text; i int;
begin
  for f in select p.oid, p.proname from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and pg_get_userbyid(p.proowner) = current_user
             and p.proname in ('verify_record', 'delete_record')
  loop
    def := pg_get_functiondef(f.oid);
    new_def := def;
    for i in 1 .. array_length(fixes, 1) loop
      -- added once: when the new text is already there (the script was run before), nothing is changed
      if fixes[i][1] = f.proname and position(fixes[i][3] in new_def) = 0 then
        if position(fixes[i][2] in new_def) = 0 then raise exception 'Update 2.9: % has changed; text not found: %', f.proname, left(fixes[i][2], 60); end if;
        new_def := replace(new_def, fixes[i][2], fixes[i][3]);
      end if;
    end loop;
    if new_def <> def then execute new_def; end if;
  end loop;
end $$;

-- ---------- returns with item lines and the warehouse ----------
-- A return lists up to 20 items (item / serial no, description, boxes, pcs, amount) with totals. Its kind is RETURN OF
-- ITEMS (the goods come back: NOT RECEIVED until the warehouse marks them RECEIVED), PRICE LESS, DAMAGE or OTHERS (no
-- goods come back).
alter table public.credit_memos add column if not exists return_lines jsonb;
alter table public.credit_memos add column if not exists return_kind text;
alter table public.credit_memos add column if not exists return_boxes integer not null default 0;
alter table public.credit_memos add column if not exists warehouse_status text;
alter table public.credit_memos add column if not exists warehouse_at timestamptz;
alter table public.credit_memos add column if not exists warehouse_by_name text;

drop function if exists public.record_return(uuid, numeric, date, text, int, text);
create or replace function public.record_return(p_invoice uuid, p_amount numeric, p_date date, p_items text, p_qty int default 0, p_note text default null,
  p_lines jsonb default null, p_kind text default 'return', p_boxes int default 0)
returns public.credit_memos
language plpgsql security definer set search_path = '' as $$
declare i public.customer_invoices; m public.credit_memos; already numeric; k text := coalesce(nullif(p_kind, ''), 'return');
  label text;
begin
  if not (public.can_write('invoices') or public.can_write('creditmemos')) then
    raise exception 'You do not have access to record returns';
  end if;
  select * into i from public.customer_invoices where id = p_invoice;
  if not found then raise exception 'Invoice not found'; end if;
  if k not in ('return','price_less','damage','other') then raise exception 'Unknown kind of return %', k; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Enter the return amount'; end if;
  if coalesce(trim(p_items), '') = '' then raise exception 'Enter the items returned'; end if;
  if p_lines is not null and (jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) > 20) then
    raise exception 'A return has up to 20 item lines';
  end if;
  select coalesce(sum(request_amount), 0) into already from public.credit_memos
    where invoice_id = p_invoice and is_return and status in ('pending','approved','paid');
  if already + p_amount > i.total_amount then
    raise exception 'The returns (PHP %) cannot be more than the invoice (PHP %)', to_char(already + p_amount, 'FM999,999,990.00'), to_char(i.total_amount, 'FM999,999,990.00');
  end if;
  label := case k when 'return' then 'RETURN OF ITEMS' when 'price_less' then 'PRICE LESS' when 'damage' then 'DAMAGE' else 'OTHERS' end;
  insert into public.credit_memos (memo_date, customer_id, po_number, serial_no, qty, defect_category, defect_detail,
                                   requested_action, request_amount, invoice_id, is_return, inspection_notes,
                                   return_lines, return_kind, return_boxes, warehouse_status)
  values (coalesce(p_date, (now() at time zone 'Asia/Manila')::date), i.customer_id, i.invoice_no, left(trim(p_items), 300), greatest(coalesce(p_qty, 0), 0),
          'other', label || ' · invoice ' || i.invoice_no, 'credit', p_amount, i.id, true, nullif(trim(coalesce(p_note, '')), ''),
          p_lines, k, greatest(coalesce(p_boxes, 0), 0), case when k = 'return' then 'not_received' end)
  returning * into m;
  insert into public.customer_events (customer_id, action, note, actor, actor_name)
  values (i.customer_id, 'return recorded', m.memo_no || ' · ' || label || ' · ' || i.invoice_no || ' · PHP ' || to_char(p_amount, 'FM999,999,990.00'),
          auth.uid(), (select full_name from public.profiles where id = auth.uid()));
  if public.is_admin() then
    m := public.credit_memo_action(m.id, 'approve', 'Return of ' || i.invoice_no);
  end if;
  return m;
end;
$$;
revoke execute on function public.record_return(uuid, numeric, date, text, int, text, jsonb, text, int) from public, anon;
grant execute on function public.record_return(uuid, numeric, date, text, int, text, jsonb, text, int) to authenticated;

-- The warehouse marks the returned items RECEIVED.
create or replace function public.return_received(p_memo uuid) returns public.credit_memos
language plpgsql security definer set search_path = '' as $$
declare m public.credit_memos; me text := (select full_name from public.profiles where id = auth.uid());
begin
  if not (public.can_write('invoices') or public.can_write('creditmemos')) then raise exception 'You do not have access to returns'; end if;
  select * into m from public.credit_memos where id = p_memo for update;
  if not found or not m.is_return then raise exception 'Return not found'; end if;
  if m.warehouse_status is distinct from 'not_received' then raise exception 'Return % is not waiting for the warehouse', m.memo_no; end if;
  perform public.allow_record_change();
  update public.credit_memos set warehouse_status = 'received', warehouse_at = now(), warehouse_by_name = me where id = p_memo returning * into m;
  insert into public.customer_events (customer_id, action, note, actor, actor_name)
  values (m.customer_id, 'return received', m.memo_no || ' · ' || coalesce(m.po_number, '') || ' · received at the warehouse', auth.uid(), me);
  return m;
end;
$$;
revoke execute on function public.return_received(uuid) from public, anon;
grant execute on function public.return_received(uuid) to authenticated;

-- ---------- 2. corrections need no reason; the person who asked is told; the record shows who approved ----------
-- A decided correction still keeps no old details (2.2). The record keeps one line: which details were changed, and
-- the Director who approved them (and who asked) or who edited them directly.
alter table public.change_requests alter column reason drop not null;
alter table public.record_changes add column if not exists requested_by_name text;

create or replace function public.submit_change_request(p_table text, p_id uuid, p_changes jsonb, p_reason text, p_label text default null)
returns public.change_requests
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare
  cols text[] := public.editable_columns(p_table);
  k text;
  old jsonb;
  cr public.change_requests;
begin
  if not public.is_active() then raise exception 'Not allowed'; end if;
  if cols is null then raise exception 'This kind of record cannot be corrected'; end if;
  if not public.can_see_table(p_table) then raise exception 'You do not have access to this kind of record'; end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then raise exception 'Nothing to correct'; end if;
  for k in select jsonb_object_keys(p_changes) loop
    if not (k = any(cols)) then raise exception 'The field "%" cannot be corrected', k; end if;
  end loop;
  execute format('select to_jsonb(t) from public.%I t where t.id = $1', p_table) into old using p_id;
  if old is null then raise exception 'Record not found'; end if;
  insert into public.change_requests (request_no, target_table, target_id, target_label, changes, previous, reason, requested_by, requested_by_name)
  values ('CR-' || to_char(current_date, 'YYYY') || '-' || lpad(public.next_counter('CR' || to_char(current_date, 'YYYY'))::text, 4, '0'),
          p_table, p_id, p_label, p_changes, (select jsonb_object_agg(x, old -> x) from jsonb_object_keys(p_changes) x),
          nullif(trim(coalesce(p_reason, '')), ''), auth.uid(), (select full_name from public.profiles where id = auth.uid()))
  returning * into cr;
  -- The Director's own correction is added straight away (a customer's: the main Director's only).
  if public.is_admin() and (p_table <> 'customers' or public.is_main_director()) then
    return public.decide_change_request(cr.id, 'approve', null);
  end if;
  perform public.notify_admins('Correction request ' || cr.request_no,
    coalesce(p_label, p_table) || coalesce(' - ' || cr.reason, '') || ' (from ' || coalesce(cr.requested_by_name, 'an employee') || ')', 'changes');
  return cr;
end;
$$;
revoke execute on function public.submit_change_request(text, uuid, jsonb, text, text) from public, anon;
grant execute on function public.submit_change_request(text, uuid, jsonb, text, text) to authenticated;

-- A decided correction leaves no record (2.2): approved, the record takes the corrected details; rejected, the record
-- stays as it is. The person who asked is told either way, with the Director's name.
create or replace function public.decide_change_request(p_id uuid, p_action text, p_note text) returns public.change_requests
language plpgsql security definer set search_path = '' as $$
declare cr public.change_requests; me text; prev jsonb;
begin
  select * into cr from public.change_requests where id = p_id for update;
  if cr.id is null then raise exception 'Request not found'; end if;
  if cr.status <> 'pending' then raise exception 'This request is already %', upper(cr.status); end if;
  if p_action not in ('approve', 'reject') then raise exception 'Unknown action %', p_action; end if;
  me := (select full_name from public.profiles where id = auth.uid());
  perform public.allow_record_change();
  if p_action = 'approve' then
    prev := public.apply_record_changes(cr.target_table, cr.target_id, cr.changes);
    cr.status := 'approved'; cr.previous := prev;
    insert into public.record_changes (target_table, target_id, action, changes, request_no, target_label, actor, actor_name, requested_by_name)
    values (cr.target_table, cr.target_id, case when cr.requested_by is distinct from auth.uid() then 'correction approved' else 'edited' end,
            (select jsonb_object_agg(x, 'null'::jsonb) from jsonb_object_keys(cr.changes) x), cr.request_no, cr.target_label, auth.uid(), me,
            case when cr.requested_by is distinct from auth.uid() then cr.requested_by_name end);
    if cr.requested_by is distinct from auth.uid() then
      perform public.notify_user(cr.requested_by, 'Correction ' || cr.request_no || ' approved by Director ' || coalesce(me, ''),
        coalesce(cr.target_label, '') || coalesce(' - ' || nullif(trim(p_note), ''), ''), public.record_link(cr.target_table, cr.target_id));
    end if;
  else
    cr.status := 'rejected';
    if cr.requested_by is distinct from auth.uid() then
      perform public.notify_user(cr.requested_by, 'Correction ' || cr.request_no || ' not approved by Director ' || coalesce(me, ''),
        coalesce(cr.target_label, '') || coalesce(' - ' || nullif(trim(p_note), ''), ''), public.record_link(cr.target_table, cr.target_id));
    end if;
  end if;
  delete from public.notifications where title = 'Correction request ' || cr.request_no;
  delete from public.change_requests where id = p_id;
  cr.review_note := p_note; cr.reviewed_by_name := me; cr.reviewed_at := now();
  return cr;
end;
$$;
revoke execute on function public.decide_change_request(uuid, text, text) from public, anon, authenticated;

-- The main Director's Edit Customer leaves the same one line (which details, edited by whom).
do $$
declare def text; anchor text := '  return jsonb_build_object(''changed'', to_jsonb(changed), ''statements'', restated, ''since'', since);';
  addition text := '  insert into public.record_changes (target_table, target_id, action, changes, target_label, actor, actor_name)
  values (''customers'', p_id, ''edited'', (select jsonb_object_agg(x, ''null''::jsonb) from unnest(changed) x),
          coalesce(c.account_no, c.application_no) || '' '' || c.first_name || '' '' || c.last_name, auth.uid(), (select full_name from public.profiles where id = auth.uid()));
';
begin
  def := pg_get_functiondef('public.director_edit_customer(uuid, jsonb)'::regprocedure);
  if position('''edited'', (select jsonb_object_agg(x, ''null''::jsonb) from unnest(changed) x)' in def) > 0 then return; end if;
  if position(anchor in def) = 0 then raise exception 'Update 2.9: director_edit_customer has changed; text not found'; end if;
  execute replace(def, anchor, addition || anchor);
end $$;

-- ---------- 4. documents issued from the customer's Request menu ----------
create or replace function public.log_customer_document(p_customer uuid, p_document text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;
  if not exists (select 1 from public.customers where id = p_customer) then raise exception 'Customer not found'; end if;
  insert into public.customer_events (customer_id, action, note, actor, actor_name)
  values (p_customer, 'document issued', left(coalesce(p_document, '') || coalesce(' · ' || nullif(trim(p_note), ''), ''), 300),
          auth.uid(), (select full_name from public.profiles where id = auth.uid()));
end;
$$;
revoke execute on function public.log_customer_document(uuid, text, text) from public, anon;
grant execute on function public.log_customer_document(uuid, text, text) to authenticated;

select 'UPDATE 2.9 READY - split payment links (' || (select count(*) from public.payment_links) || ' links), corrections without a reason' as result;
