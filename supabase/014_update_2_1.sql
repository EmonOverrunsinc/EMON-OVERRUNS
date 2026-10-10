-- =====================================================================
-- EMON OVERRUNS E-PORTAL — Update 2.1: Director Portal, memo payments on e-bills, shipping company, deletes for good
-- 1. A memo to a company (Director Portal, before called Order Letter) can have an amount in PESOS with the exchange
--    rate of the day: the amount in BDT is counted by itself (PHP × rate, for example × 2.01). The memo can name one
--    e-bill of that company: once the Director approves the memo, the BDT amount is paid on that e-bill. The e-bill's
--    balance goes down; its total cost and its profit stay the same.
-- 2. E-Bill (before called Inventory): the shipping company's name and code.
-- 3. Sales Report lines can still be added after an e-bill is PAID.
-- 4. Billing no longer pays e-bills (a payment voucher linked to an e-bill before still counts as paid).
-- 5. What the Director deletes is gone for good: no "deleted" line is written in any history, and the history lines
--    and notices the record made go with it. The old "deleted" lines, and the lines and notices of records deleted
--    before, are removed once.
-- 6. Project budget: each line is its description and amount (the main figure); the qty is optional, and there is no
--    unit cost any more.
-- 7. A customer's LOCATION check takes the place of the address check: FOUND, NO NEED TO CHECK LOCATION or NOT FOUND.
-- 8. A correction the Director approves changes the record and leaves no history: the request, its notices and the log
--    line are not kept. The approved corrections kept before are removed once.
-- Run once in the Supabase SQL Editor after 013_update_2_0.sql. It is safe to run again.
-- =====================================================================

-- ---------- 1. memo payments ----------
-- the memo's amount in BDT (amount in PHP × exchange rate) and the e-bill it pays. The e-bill is checked when the memo
-- is saved, and an e-bill named in a memo cannot be deleted (delete_record). It has no foreign key on purpose: a second
-- link from order_letters to stock_bills would make the app's order lists ambiguous.
alter table public.order_letters add column if not exists amount_bdt numeric(14,2);
alter table public.order_letters add column if not exists memo_bill_id uuid;
alter table public.order_letters drop constraint if exists order_letters_memo_bill_id_fkey;
create index if not exists order_letters_memo_bill_idx on public.order_letters(memo_bill_id);

-- A memo's payment on an e-bill: made when the Director approves the memo, and removed with the memo.
create table if not exists public.stock_bill_payments (
  id uuid primary key default gen_random_uuid(),
  stock_bill_id uuid not null references public.stock_bills(id) on delete cascade,
  order_id uuid not null unique references public.order_letters(id) on delete cascade,
  order_no text not null,
  pay_date date not null,
  subject text,
  amount_php numeric(14,2) not null check (amount_php > 0),
  exchange_rate numeric(12,4) not null check (exchange_rate > 0),
  amount_bdt numeric(14,2) not null check (amount_bdt > 0),
  approved_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists stock_bill_payments_bill_idx on public.stock_bill_payments(stock_bill_id);
alter table public.stock_bill_payments enable row level security;
drop policy if exists "sbp: read" on public.stock_bill_payments;
create policy "sbp: read" on public.stock_bill_payments for select to authenticated
  using ((select public.has_module('inventory')) or (select public.has_module('billing')));
drop trigger if exists keep_records on public.stock_bill_payments;
create trigger keep_records before update or delete on public.stock_bill_payments for each row execute function public.keep_records();
drop trigger if exists keep_records_truncate on public.stock_bill_payments;
create trigger keep_records_truncate before truncate on public.stock_bill_payments for each statement execute function public.keep_records();

-- ---------- 2. the shipping company of an e-bill ----------
alter table public.stock_bills add column if not exists shipping_company text;
alter table public.stock_bills add column if not exists shipping_company_code text;

-- ---------- 3. totals: what is paid and the balance ----------
-- Paid = the memo payments (and the payment vouchers linked before 2.1); Balance = total cost − paid.
-- (the columns stay in the same order; the new ones are at the end)
create or replace view public.stock_bill_totals with (security_invoker = true) as
  select b.id, b.bill_no, b.company_id, b.bill_date, b.supplier_bill_no, b.item_columns, b.items, b.total_qty, b.total_cost, b.total_boxes,
    b.batch_no, b.shipment_no, b.shipment_date, b.notes, b.status, b.release_date, b.shipping_cost, b.shipping_bill_no, b.release_order_no,
    b.arrived_at, b.released_at, b.sold_at, b.paid_at, b.paid_by_name, b.created_by, b.created_by_name, b.created_at,
    pc.name as company_name, pc.currency as company_currency,
    coalesce(e.net_sales, 0)::numeric(14,2) as net_sales,
    coalesce(e.eoo_fees, 0)::numeric(14,2) as eoo_fees,
    coalesce(e.other_fees, 0)::numeric(14,2) as other_fees,
    coalesce(e.penalties, 0)::numeric(14,2) as penalties,
    (b.total_cost + coalesce(b.release_bdt, 0) + coalesce(b.shipping_cost, 0))::numeric(14,2) as bill_total,
    (b.total_cost + coalesce(b.release_bdt, 0) + coalesce(b.shipping_cost, 0) + coalesce(e.eoo_fees, 0) + coalesce(e.other_fees, 0) + coalesce(e.penalties, 0))::numeric(14,2) as total_expenses,
    (coalesce(v.paid, 0) + coalesce(m.paid, 0))::numeric(14,2) as paid_bdt,
    coalesce(v.vouchers, 0)::int as vouchers_count,
    case when b.status = 'paid' and (select public.has_module('inventory')) then
      (coalesce(e.net_sales, 0) - (b.total_cost + coalesce(b.release_bdt, 0) + coalesce(b.shipping_cost, 0) + coalesce(e.eoo_fees, 0) + coalesce(e.other_fees, 0) + coalesce(e.penalties, 0)))::numeric(14,2) end as profit,
    b.release_price_per_box, b.release_exchange_rate, b.release_php, b.release_bdt,
    b.shipping_company, b.shipping_company_code,
    coalesce(m.paid, 0)::numeric(14,2) as memo_paid_bdt,
    coalesce(m.memos, 0)::int as memos_count,
    (b.total_cost + coalesce(b.release_bdt, 0) + coalesce(b.shipping_cost, 0) - coalesce(v.paid, 0) - coalesce(m.paid, 0))::numeric(14,2) as balance_bdt
  from public.stock_bills b
  left join public.pay_companies pc on pc.id = b.company_id
  left join lateral (select sum(x.amount) filter (where x.entry_type = 'sales') as net_sales,
                            sum(x.amount) filter (where x.entry_type = 'eoo_fee') as eoo_fees,
                            sum(x.amount) filter (where x.entry_type = 'fee') as other_fees,
                            sum(x.amount) filter (where x.entry_type = 'penalty') as penalties
                     from public.stock_bill_entries x where x.stock_bill_id = b.id) e on true
  left join lateral (select sum(p.amount_bdt) as paid, count(*) as vouchers from public.pay_vouchers p where p.stock_bill_id = b.id) v on true
  left join lateral (select sum(p.amount_bdt) as paid, count(*) as memos from public.stock_bill_payments p where p.stock_bill_id = b.id) m on true;
revoke select on public.stock_bill_totals from anon;
grant select on public.stock_bill_totals to authenticated;

-- The e-bills of a company with what is paid and the balance, for a memo (the Director, or Billing staff who write memos).
create or replace function public.memo_ebills(p_company uuid)
returns table (id uuid, bill_no text, batch_no text, status text, bill_date date, total_bdt numeric, paid_bdt numeric, balance_bdt numeric)
language sql stable security definer set search_path = '' set timezone to 'Asia/Manila' as $$
  select t.id, t.bill_no, t.batch_no, t.status, t.bill_date, t.bill_total, t.paid_bdt, t.balance_bdt
  from public.stock_bill_totals t
  where t.company_id = p_company and (public.is_admin() or public.can_write('billing'))
  order by t.bill_date desc, t.bill_no desc;
$$;
revoke execute on function public.memo_ebills(uuid) from public, anon;
grant execute on function public.memo_ebills(uuid) to authenticated;

-- ---------- 4. Project budget: the amount is the main figure, the qty is optional ----------
-- A budget line is its description and its amount; the qty can be left empty (it is only shown). Lines saved before
-- keep their amount (it was qty × unit cost).
alter table public.project_items alter column amount drop expression if exists;
alter table public.project_items alter column qty drop not null;
alter table public.project_items alter column qty drop default;
alter table public.project_items alter column unit_cost drop not null;
alter table public.project_items alter column unit_cost drop default;
alter table public.project_items drop constraint if exists project_items_qty_check;
alter table public.project_items add constraint project_items_qty_check check (qty is null or qty > 0);
alter table public.project_items drop constraint if exists project_items_amount_check;
alter table public.project_items add constraint project_items_amount_check check (amount is not null and amount >= 0);

create or replace function public.project_items_before_insert() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.description := nullif(trim(new.description), '');
  if new.description is null then raise exception 'Write the description of each budget line'; end if;
  -- a line made the old way (qty × unit cost) gets its amount from them
  if new.amount is null and new.qty is not null and new.unit_cost is not null then new.amount := round(new.qty * new.unit_cost, 2); end if;
  if new.amount is null or new.amount <= 0 then raise exception 'Enter the amount of each budget line'; end if;
  return new;
end;
$$;
revoke execute on function public.project_items_before_insert() from public, anon, authenticated;
drop trigger if exists project_items_bi on public.project_items;
create trigger project_items_bi before insert on public.project_items for each row execute function public.project_items_before_insert();

-- ---------- 4b. a customer's LOCATION check: found, no need to check, or not found ----------
-- It takes the place of the address check (verified or not): an address verified before is FOUND, one not verified is
-- NOT FOUND. The old yes/no field stays in step with it (FOUND = yes).
alter table public.customers add column if not exists location_check text;
do $$
begin
  if exists (select 1 from public.customers where location_check is null) then
    perform public.allow_record_change();
    update public.customers set location_check = case when address_verified then 'found' else 'not_found' end where location_check is null;
  end if;
end $$;
alter table public.customers drop constraint if exists customers_location_check_check;
alter table public.customers add constraint customers_location_check_check check (location_check in ('found','no_need','not_found'));
alter table public.customers alter column location_check set not null;

create or replace function public.customers_location_before_insert() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- an app before 2.1 sends only the address check (yes or no)
  new.location_check := coalesce(new.location_check, case when new.address_verified then 'found' else 'not_found' end);
  new.address_verified := new.location_check = 'found';
  return new;
end;
$$;
revoke execute on function public.customers_location_before_insert() from public, anon, authenticated;
drop trigger if exists customers_location_bi on public.customers;
create trigger customers_location_bi before insert on public.customers for each row execute function public.customers_location_before_insert();

-- ---------- 5. changed functions (in the block below) ----------
-- order_letters_before_insert: a company memo's amount (PHP), exchange rate and BDT amount, and the e-bill it pays.
-- update_pending_order: the e-bill of a memo can be changed while the memo waits for approval.
-- carry_out_order: an approved memo pays its BDT amount on the e-bill it names.
-- stock_bills_before_insert, editable_columns: the shipping company's name and code.
-- stock_bill_entries_before_insert: Sales Report lines after PAID.
-- delete_record, undo_order, remove_attachment: what the Director deletes leaves no line in any history.
-- verify_record: an e-bill's secret code shows what is paid, the balance and the shipping company.
-- customer_action: the Director sets a customer's location check (found, no need to check, not found).
-- decide_change_request: an approved correction changes the record and leaves no history.
do $$
declare
  -- function name, the exact old text, the new text
  fixes text[][] := array[
    ['order_letters_before_insert', 'declare kind text; d jsonb; bl public.stock_bills;
',
     'declare kind text; d jsonb; bl public.stock_bills; mb public.stock_bills;
'],
    ['order_letters_before_insert', '  else
    new.release_date := null; new.shipping_cost := null; new.shipping_bill_no := null; new.stock_info := null;
    new.price_per_box := null; new.exchange_rate := null; new.release_php := null; new.release_bdt := null;
  end if;
',
     '  else
    new.release_date := null; new.shipping_cost := null; new.shipping_bill_no := null; new.stock_info := null;
    new.price_per_box := null; new.release_php := null; new.release_bdt := null;
    if not (kind = ''company'' and new.subject_type = ''memo'') then new.exchange_rate := null; end if;
  end if;
  -- 2.1: a memo to a company can have an amount in PESOS and the exchange rate of the day: the amount in BDT is counted
  -- (PHP × rate). The memo can name one e-bill of the company: once approved, the BDT amount is paid on that e-bill.
  if kind = ''company'' and new.subject_type = ''memo'' then
    if new.memo_bill_id is not null then
      select * into mb from public.stock_bills b where b.id = new.memo_bill_id;
      if mb.id is null or mb.company_id is distinct from new.company_id then raise exception ''Choose an e-bill of this company''; end if;
      if new.amount is null then raise exception ''Enter the memo amount in PESOS: it is paid on E-Bill %'', mb.bill_no; end if;
    end if;
    if new.amount is not null and new.amount <= 0 then raise exception ''The memo amount must be more than 0''; end if;
    if new.amount is not null and coalesce(new.exchange_rate, 0) <= 0 then raise exception ''Enter the exchange rate (BDT for 1 PHP)''; end if;
    if new.amount is null then new.exchange_rate := null; end if;
    new.amount_bdt := round(new.amount * new.exchange_rate, 2);
    new.stock_info := case when mb.id is not null then jsonb_build_object(''bill_no'', mb.bill_no, ''batch_no'', mb.batch_no, ''status'', mb.status,
      ''total_cost'', mb.total_cost + coalesce(mb.release_bdt, 0) + coalesce(mb.shipping_cost, 0)) end;
  else
    new.amount_bdt := null; new.memo_bill_id := null;
  end if;
'],
    ['update_pending_order', '''release_date'',''price_per_box'',''exchange_rate'',''shipping_cost'',''shipping_bill_no''];',
     '''release_date'',''price_per_box'',''exchange_rate'',''shipping_cost'',''shipping_bill_no'',''memo_bill_id''];'],
    ['update_pending_order', 'foreach k in array editable || array[''release_php'',''release_bdt''] loop',
     'foreach k in array editable || array[''release_php'',''release_bdt'',''amount_bdt''] loop'],
    ['update_pending_order', 'shipping_bill_no = chk.shipping_bill_no,
    stock_info = chk.stock_info,',
     'shipping_bill_no = chk.shipping_bill_no,
    amount_bdt = chk.amount_bdt, memo_bill_id = chk.memo_bill_id,
    stock_info = chk.stock_info,'],
    ['carry_out_order', '  bl public.stock_bills;
  newst text;
',
     '  bl public.stock_bills;
  bill_total numeric;
  paid_before numeric;
  newst text;
'],
    ['carry_out_order', '    if newst is not null then
      update public.pay_companies set status = newst, status_note = o.order_no || '': '' || o.subject where id = pc.id;
      res := pc.name || '' is now '' || upper(newst);
    else
      res := ''Memo recorded for '' || pc.name;
    end if;
',
     '    if newst is not null then
      update public.pay_companies set status = newst, status_note = o.order_no || '': '' || o.subject where id = pc.id;
      res := pc.name || '' is now '' || upper(newst);
    elsif o.memo_bill_id is not null and o.amount_bdt > 0 then
      -- 2.1: the memo pays its BDT amount on the e-bill it names (the e-bill''s balance goes down)
      select * into bl from public.stock_bills where id = o.memo_bill_id for update;
      if bl.id is null then raise exception ''The e-bill of this memo was deleted''; end if;
      bill_total := bl.total_cost + coalesce(bl.release_bdt, 0) + coalesce(bl.shipping_cost, 0);
      paid_before := coalesce((select sum(p.amount_bdt) from public.stock_bill_payments p where p.stock_bill_id = bl.id), 0)
        + coalesce((select sum(v.amount_bdt) from public.pay_vouchers v where v.stock_bill_id = bl.id), 0);
      insert into public.stock_bill_payments (stock_bill_id, order_id, order_no, pay_date, subject, amount_php, exchange_rate, amount_bdt, approved_by_name)
      values (bl.id, o.id, o.order_no, current_date, o.subject, o.amount, o.exchange_rate, o.amount_bdt, me);
      insert into public.stock_bill_events (stock_bill_id, action, note, actor, actor_name)
      values (bl.id, ''paid by memo '' || o.order_no, ''PHP '' || to_char(o.amount, ''FM999,999,999,990.00'') || '' × ''
        || rtrim(rtrim(to_char(o.exchange_rate, ''FM999,990.0000''), ''0''), ''.'') || '' = BDT '' || to_char(o.amount_bdt, ''FM999,999,999,990.00'')
        || '' · balance BDT '' || to_char(bill_total - paid_before - o.amount_bdt, ''FM999,999,999,990.00''), auth.uid(), me);
      update public.order_letters set stock_info = coalesce(stock_info, ''{}''::jsonb) || jsonb_build_object(''bill_no'', bl.bill_no, ''batch_no'', bl.batch_no,
        ''status'', bl.status, ''total_cost'', bill_total, ''paid_before'', paid_before, ''balance_after'', bill_total - paid_before - o.amount_bdt)
      where id = o.id;
      res := ''Memo recorded for '' || pc.name || '': BDT '' || to_char(o.amount_bdt, ''FM999,999,999,990.00'') || '' paid on E-Bill '' || bl.bill_no
        || coalesce('' (Batch No '' || bl.batch_no || '')'', '''') || '' — balance BDT '' || to_char(bill_total - paid_before - o.amount_bdt, ''FM999,999,999,990.00'');
    else
      res := ''Memo recorded for '' || pc.name
        || coalesce('': PHP '' || to_char(o.amount, ''FM999,999,999,990.00'') || '' = BDT '' || to_char(o.amount_bdt, ''FM999,999,999,990.00''), '''');
    end if;
'],
    ['undo_order', '    insert into public.stock_bill_events (stock_bill_id, action, note, actor, actor_name)
    values (o.stock_bill_id, o.order_no || '' deleted — status back to '' || public.ebill_status_name(prev), o.subject, auth.uid(), me);
',
     '    -- 2.1: no line is written in the history (the order''s own line is removed by delete_record)
'],
    ['undo_order', '    insert into public.customer_events (customer_id, action, note, actor, actor_name)
    values (o.customer_id, o.order_no || '' deleted — status back to '' || upper(prev), o.subject, auth.uid(), me);
',
     ''],
    ['delete_record', '  if p_table = ''stock_bills'' and exists (select 1 from public.pay_vouchers x where x.stock_bill_id = p_id) then
    raise exception ''This e-bill has payments in Billing. Delete those payment vouchers first'';
  end if;
  if p_table = ''order_letters'' and j->>''status'' = ''applied''
',
     '  if p_table = ''stock_bills'' and exists (select 1 from public.pay_vouchers x where x.stock_bill_id = p_id) then
    raise exception ''This e-bill has payments in Billing. Delete those payment vouchers first'';
  end if;
  if p_table = ''stock_bills'' and exists (select 1 from public.order_letters x where x.memo_bill_id = p_id) then
    raise exception ''This e-bill is named in memo %. Delete the memo first'',
      (select string_agg(x.order_no, '', '' order by x.order_no) from public.order_letters x where x.memo_bill_id = p_id);
  end if;
  if p_table = ''order_letters'' and j->>''status'' = ''applied''
'],
    ['delete_record', '  if p_table = ''stock_bill_entries'' then
    insert into public.stock_bill_events (stock_bill_id, action, note, actor, actor_name)
    values ((j->>''stock_bill_id'')::uuid,
            case j->>''entry_type'' when ''sales'' then ''net sales'' when ''eoo_fee'' then ''EOO fee'' when ''fee'' then ''fee'' else ''penalty'' end
              || '' BDT '' || to_char((j->>''amount'')::numeric, ''FM999,999,999,990.00'') || '' deleted'',
            concat_ws('' · '', ''Receipt No '' || (j->>''receipt_no''), j->>''description''), auth.uid(), (select full_name from public.profiles where id = auth.uid()));
  end if;
',
     '  -- 2.1: what the Director deletes is gone for good: no "deleted" line, and the history lines and notices it made go too
  if p_table = ''stock_bill_entries'' then
    delete from public.stock_bill_events x where x.id = (select y.id from public.stock_bill_events y
      where y.stock_bill_id = (j->>''stock_bill_id'')::uuid and y.created_at = (j->>''created_at'')::timestamptz
        and y.action = case j->>''entry_type'' when ''sales'' then ''net sales'' when ''eoo_fee'' then ''EOO fee'' when ''fee'' then ''fee'' else ''penalty'' end
          || '' BDT '' || to_char((j->>''amount'')::numeric, ''FM999,999,999,990.00'') || '' added''
      order by y.id limit 1);
  end if;
  if p_table = ''order_letters'' then
    delete from public.customer_events x where x.customer_id = (j->>''customer_id'')::uuid and right(x.action, length(j->>''order_no'') + 4) = '' by '' || (j->>''order_no'');
    delete from public.stock_bill_events x where x.stock_bill_id in ((j->>''stock_bill_id'')::uuid, (j->>''memo_bill_id'')::uuid)
      and x.action in (''released by '' || (j->>''order_no''), ''paid by memo '' || (j->>''order_no''));
  end if;
  delete from public.notifications n where n.link = case p_table when ''customers'' then ''customer/'' when ''order_letters'' then ''order/''
    when ''job_applications'' then ''jobapp/'' when ''credit_memos'' then ''creditmemo/'' when ''employees'' then ''employee/'' end || p_id::text;
'],
    ['remove_attachment', '    insert into public.customer_events (customer_id, action, note, actor, actor_name)
    values (a.owner_id, ''file removed'', a.file_name, auth.uid(), me);
',
     '    -- 2.1: a file the Director removes leaves no line in any history
    if not public.is_admin() then
      insert into public.customer_events (customer_id, action, note, actor, actor_name)
      values (a.owner_id, ''file removed'', a.file_name, auth.uid(), me);
    end if;
'],
    ['remove_attachment', '  if a.owner_type in (''stock_bill'',''stock_bill_entry'') then
',
     '  if a.owner_type in (''stock_bill'',''stock_bill_entry'') and not public.is_admin() then
'],
    ['remove_attachment', '  insert into public.record_changes (target_table, target_id, action, changes, previous, target_label, actor, actor_name)
  values (tbl, a.owner_id, ''file removed'', jsonb_build_object(''file'', ''''), jsonb_build_object(''file'', a.file_name), a.file_name, auth.uid(), me);
',
     '  if not public.is_admin() then
    insert into public.record_changes (target_table, target_id, action, changes, previous, target_label, actor, actor_name)
    values (tbl, a.owner_id, ''file removed'', jsonb_build_object(''file'', ''''), jsonb_build_object(''file'', a.file_name), a.file_name, auth.uid(), me);
  end if;
'],
    ['stock_bill_entries_before_insert', '  if b.status = ''paid'' then raise exception ''E-Bill % is PAID and closed. Nothing more can be added to it'', b.bill_no; end if;
  if new.entry_type = ''sales'' and b.status not in (''released'',''sold'') then
',
     '  -- 2.1: Sales Report lines can still be added after the e-bill is PAID
  if new.entry_type = ''sales'' and b.status not in (''released'',''sold'',''paid'') then
'],
    ['stock_bills_before_insert', '  new.shipment_no := nullif(trim(new.shipment_no), '''');
  ini := public.company_initials(',
     '  new.shipment_no := nullif(trim(new.shipment_no), '''');
  -- 2.1: the shipping company''s name and code
  new.shipping_company := nullif(trim(new.shipping_company), '''');
  new.shipping_company_code := nullif(trim(new.shipping_company_code), '''');
  ini := public.company_initials('],
    ['editable_columns', 'when ''stock_bills'' then array[''supplier_bill_no'',''batch_no'',''shipment_no'',''shipment_date'',''total_boxes'',''notes'']',
     'when ''stock_bills'' then array[''supplier_bill_no'',''batch_no'',''shipment_no'',''shipment_date'',''total_boxes'',''notes'',''shipping_company'',''shipping_company_code'']'],
    ['verify_record', '    -- An e-bill shows only for the secret code of its Statistics Report (never for its number).
',
     '    -- An e-bill shows only for its secret code, printed on the E-Bill once it is PAID (never for its number).
'],
    ['verify_record', '      coalesce((select sum(x.amount) from public.stock_bill_entries x where x.stock_bill_id = b.id and x.entry_type = ''penalty''), 0) as penalties
      into r from',
     '      coalesce((select sum(x.amount) from public.stock_bill_entries x where x.stock_bill_id = b.id and x.entry_type = ''penalty''), 0) as penalties,
      coalesce((select sum(p.amount_bdt) from public.stock_bill_payments p where p.stock_bill_id = b.id), 0)
        + coalesce((select sum(v.amount_bdt) from public.pay_vouchers v where v.stock_bill_id = b.id), 0) as paid_bdt
      into r from'],
    ['verify_record', '''type'', ''E-Bill Statistics'',',
     '''type'', ''E-Bill'','],
    ['verify_record', '          jsonb_build_array(''Shipment Date'', coalesce(to_char(r.shipment_date, ''DD Mon YYYY''), ''—'')),
          jsonb_build_array(''Released Date'', coalesce(to_char(r.release_date, ''DD Mon YYYY''), ''—'')),
',
     '          jsonb_build_array(''Shipment Date'', coalesce(to_char(r.shipment_date, ''DD Mon YYYY''), ''—'')),
          case when r.shipping_company is not null or r.shipping_company_code is not null then
            jsonb_build_array(''Shipping Company'', concat_ws('' · Code '', r.shipping_company, r.shipping_company_code)) end,
          jsonb_build_array(''Released Date'', coalesce(to_char(r.release_date, ''DD Mon YYYY''), ''—'')),
'],
    ['verify_record', '          jsonb_build_array(''Total Cost (BDT)'', to_char(r.total_cost + coalesce(r.release_bdt, 0) + coalesce(r.shipping_cost, 0), ''FM999,999,999,990.00'')),
          jsonb_build_array(''EOO Fees (BDT)'',',
     '          jsonb_build_array(''Total Cost (BDT)'', to_char(r.total_cost + coalesce(r.release_bdt, 0) + coalesce(r.shipping_cost, 0), ''FM999,999,999,990.00'')),
          jsonb_build_array(''Paid (BDT)'', to_char(r.paid_bdt, ''FM999,999,999,990.00'')),
          jsonb_build_array(''Balance (BDT)'', to_char(r.total_cost + coalesce(r.release_bdt, 0) + coalesce(r.shipping_cost, 0) - r.paid_bdt, ''FM999,999,999,990.00'')),
          jsonb_build_array(''EOO Fees (BDT)'','],
    ['customer_action', '    when ''address_unverified'' then c.status
    else null end;',
     '    when ''address_unverified'' then c.status
    when ''location_found'' then c.status
    when ''location_no_need'' then c.status
    when ''location_not_found'' then c.status
    else null end;'],
    ['customer_action', '    address_verified = case p_action when ''address_verified'' then true when ''address_unverified'' then false else address_verified end,
',
     '    -- 2.1: the location check (the old address check stays in step with it: FOUND = verified)
    address_verified = case when p_action in (''address_verified'',''location_found'') then true
      when p_action in (''address_unverified'',''location_no_need'',''location_not_found'') then false else address_verified end,
    location_check = case when p_action in (''address_verified'',''location_found'') then ''found'' when p_action = ''location_no_need'' then ''no_need''
      when p_action in (''address_unverified'',''location_not_found'') then ''not_found'' else location_check end,
'],
    ['customer_action', '  values (p_id, replace(p_action, ''_'', '' ''), p_note,',
     '  values (p_id, case p_action when ''location_found'' then ''location: found'' when ''location_no_need'' then ''location: no need to check''
    when ''location_not_found'' then ''location: not found'' else replace(p_action, ''_'', '' '') end, p_note,'],
    ['decide_change_request', '    prev := public.apply_record_changes(cr.target_table, cr.target_id, cr.changes);
    insert into public.record_changes (target_table, target_id, action, changes, previous, request_no, target_label, actor, actor_name)
    values (cr.target_table, cr.target_id, ''correction'', cr.changes, prev, cr.request_no, cr.target_label, auth.uid(), me);
    update public.change_requests set status = ''approved'', previous = prev, review_note = p_note, reviewed_by_name = me, reviewed_at = now()
    where id = p_id returning * into cr;
    if cr.requested_by is distinct from auth.uid() then
      perform public.notify_user(cr.requested_by, ''Correction '' || cr.request_no || '' approved'', coalesce(cr.target_label, cr.target_table), public.record_link(cr.target_table, cr.target_id));
    end if;
',
     '    -- 2.1: the record takes the corrected details and the correction leaves no history: the request and its notice
    -- are removed, and no log line is written
    prev := public.apply_record_changes(cr.target_table, cr.target_id, cr.changes);
    delete from public.notifications where title = ''Correction request '' || cr.request_no;
    delete from public.change_requests where id = p_id;
    cr.status := ''approved''; cr.previous := prev; cr.review_note := p_note; cr.reviewed_by_name := me; cr.reviewed_at := now();
']
  ];
  f record; def text; new_def text; i int;
begin
  for f in select p.oid, p.proname from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and pg_get_userbyid(p.proowner) = current_user
             and p.proname in ('order_letters_before_insert', 'update_pending_order', 'carry_out_order', 'undo_order', 'delete_record', 'remove_attachment', 'stock_bill_entries_before_insert', 'stock_bills_before_insert', 'editable_columns', 'verify_record', 'customer_action', 'decide_change_request')
  loop
    def := pg_get_functiondef(f.oid);
    new_def := def;
    for i in 1 .. array_length(fixes, 1) loop
      -- changed once: when the new text is already there (the script was run before), nothing is changed
      if fixes[i][1] = f.proname and (fixes[i][3] = '' or position(fixes[i][3] in new_def) = 0) then
        if position(fixes[i][2] in new_def) = 0 then
          -- a text that is only taken out is already gone when the script runs again
          continue when fixes[i][3] = '';
          raise exception 'Update 2.1: % has changed; text not found: %', f.proname, left(fixes[i][2], 60);
        end if;
        new_def := replace(new_def, fixes[i][2], fixes[i][3]);
      end if;
    end loop;
    if new_def <> def then execute new_def; end if;
  end loop;
end $$;

-- ---------- 6. once: the "deleted" lines, the lines and notices of records deleted before, and approved corrections ----------
do $$
begin
  perform public.allow_record_change();
  -- "… deleted" lines (a Sales Report line, a Released Notice or an order letter that was deleted)
  delete from public.stock_bill_events e where e.action ~ ' deleted$' or e.action ~ ' deleted — status back to ';
  delete from public.customer_events e where e.action ~ ' deleted — status back to ';
  -- "… added" lines of Sales Report lines deleted before
  delete from public.stock_bill_events e
  where e.action ~ '^(net sales|EOO fee|fee|penalty) BDT [0-9,.]+ added$'
    and not exists (select 1 from public.stock_bill_entries x where x.stock_bill_id = e.stock_bill_id and x.created_at = e.created_at
      and case x.entry_type when 'sales' then 'net sales' when 'eoo_fee' then 'EOO fee' when 'fee' then 'fee' else 'penalty' end
          || ' BDT ' || to_char(x.amount, 'FM999,999,999,990.00') || ' added' = e.action);
  -- lines of order letters deleted before ("closed by ORDER-2026-005", "released by EO-2026-10-0001")
  delete from public.customer_events e where e.action ~ ' by [A-Z]+-[0-9][0-9-]*$'
    and not exists (select 1 from public.order_letters o where right(e.action, length(o.order_no) + 4) = ' by ' || o.order_no);
  delete from public.stock_bill_events e where e.action ~ '^(released by|paid by memo) '
    and not exists (select 1 from public.order_letters o where e.action in ('released by ' || o.order_no, 'paid by memo ' || o.order_no));
  -- files the Director removed
  delete from public.stock_bill_events e where e.action = 'file removed' and e.actor in (select p.id from public.profiles p where p.role = 'admin');
  delete from public.customer_events e where e.action = 'file removed' and e.actor in (select p.id from public.profiles p where p.role = 'admin');
  delete from public.record_changes r where r.action = 'file removed' and r.actor in (select p.id from public.profiles p where p.role = 'admin');
  -- 2.1: approved corrections leave no history: their requests, log lines and notices
  delete from public.notifications n using public.change_requests r
    where r.status = 'approved' and n.title in ('Correction request ' || r.request_no, 'Correction ' || r.request_no || ' approved');
  delete from public.record_changes r where r.action = 'correction';
  delete from public.change_requests r where r.status = 'approved';
  -- notices that open a record deleted before
  delete from public.notifications n where
       (split_part(n.link, '/', 1) = 'order' and not exists (select 1 from public.order_letters x where x.id::text = split_part(n.link, '/', 2)))
    or (split_part(n.link, '/', 1) = 'customer' and not exists (select 1 from public.customers x where x.id::text = split_part(n.link, '/', 2)))
    or (split_part(n.link, '/', 1) = 'jobapp' and not exists (select 1 from public.job_applications x where x.id::text = split_part(n.link, '/', 2)))
    or (split_part(n.link, '/', 1) = 'creditmemo' and not exists (select 1 from public.credit_memos x where x.id::text = split_part(n.link, '/', 2)))
    or (split_part(n.link, '/', 1) = 'employee' and not exists (select 1 from public.employees x where x.id::text = split_part(n.link, '/', 2)));
end $$;
