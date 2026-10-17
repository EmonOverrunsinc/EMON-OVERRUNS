-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 2.8: returns on an invoice
-- Record Return on the invoice page: the items the customer gave back, the quantity and the amount. The return is
-- kept as a credit memo marked RETURN and linked to that invoice: once approved (the Director's own return is approved
-- at once) its amount is taken off that invoice first, the customer's balance goes down by the same amount, and the
-- statement of account shows a RETURN line.
-- Run once in the Supabase SQL Editor after 019_link_payment.sql. It is safe to run again.
-- =====================================================================

alter table public.credit_memos add column if not exists invoice_id uuid references public.customer_invoices(id) on delete set null;
alter table public.credit_memos add column if not exists is_return boolean not null default false;
create index if not exists credit_memos_invoice_idx on public.credit_memos(invoice_id);

-- What each invoice has been paid: approved returns of the invoice first (they lower what is owed), then payments
-- linked to it, then everything else on the account (unlinked payments, credits, discounts, take-off adjustments)
-- pays the oldest invoices first.
create or replace view public.invoice_balances with (security_invoker = true) as
with lp as (
  select p.invoice_id, sum(p.amount)::numeric as amount
  from public.payments_received p where p.invoice_id is not null group by p.invoice_id
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
    coalesce((select sum(p.amount) from public.payments_received p
              where p.customer_id = c.id and (p.invoice_id is null
                or not exists (select 1 from public.customer_invoices x where x.id = p.invoice_id and x.customer_id = c.id))), 0)
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
                                 rows between unbounded preceding and 1 preceding), 0) as before
  from owed w
),
paid as (
  select f.invoice_id as id, x.ret,
    (x.direct + greatest(0, least(f.amount, coalesce(pl.amount, 0) - f.before)))::numeric(14,2) as amount
  from fifo f join inv2 x on x.id = f.invoice_id left join pool pl on pl.customer_id = f.customer_id
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

-- Record a return on an invoice. Staff who record invoices or credit memos, and the Director (whose return is
-- approved at once; an employee's waits for the Director in Credit Memo).
create or replace function public.record_return(p_invoice uuid, p_amount numeric, p_date date, p_items text, p_qty int default 0, p_note text default null)
returns public.credit_memos
language plpgsql security definer set search_path = '' as $$
declare i public.customer_invoices; m public.credit_memos; already numeric;
begin
  if not (public.can_write('invoices') or public.can_write('creditmemos')) then
    raise exception 'You do not have access to record returns';
  end if;
  select * into i from public.customer_invoices where id = p_invoice;
  if not found then raise exception 'Invoice not found'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Enter the return amount'; end if;
  if coalesce(trim(p_items), '') = '' then raise exception 'Enter the items returned'; end if;
  select coalesce(sum(request_amount), 0) into already from public.credit_memos
    where invoice_id = p_invoice and is_return and status in ('pending','approved','paid');
  if already + p_amount > i.total_amount then
    raise exception 'The returns (PHP %) cannot be more than the invoice (PHP %)', to_char(already + p_amount, 'FM999,999,990.00'), to_char(i.total_amount, 'FM999,999,990.00');
  end if;
  insert into public.credit_memos (memo_date, customer_id, po_number, serial_no, qty, defect_category, defect_detail,
                                   requested_action, request_amount, invoice_id, is_return, inspection_notes)
  values (coalesce(p_date, (now() at time zone 'Asia/Manila')::date), i.customer_id, i.invoice_no, trim(p_items), greatest(coalesce(p_qty, 0), 0),
          'other', 'RETURN of invoice ' || i.invoice_no, 'credit', p_amount, i.id, true, nullif(trim(coalesce(p_note, '')), ''))
  returning * into m;
  insert into public.customer_events (customer_id, action, note, actor, actor_name)
  values (i.customer_id, 'return recorded', m.memo_no || ' · ' || i.invoice_no || ' · PHP ' || to_char(p_amount, 'FM999,999,990.00'),
          auth.uid(), (select full_name from public.profiles where id = auth.uid()));
  if public.is_admin() then
    m := public.credit_memo_action(m.id, 'approve', 'Return of ' || i.invoice_no);
  end if;
  return m;
end;
$$;
revoke execute on function public.record_return(uuid, numeric, date, text, int, text) from public, anon;
grant execute on function public.record_return(uuid, numeric, date, text, int, text) to authenticated;

select 'UPDATE 2.8 READY - returns can be recorded on an invoice' as result;
