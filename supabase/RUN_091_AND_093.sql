-- =====================================================================
-- EMON OVERRUNS E-PORTAL - RUN 091 AND 093 TOGETHER (both safe to run again)
-- 091: coverage Add to Account = an UNPAID voucher · 093: the Collection Voucher account, QR key and verification
-- Paste all of it in Supabase > SQL Editor > New query and press Run.
-- The last line says: UPDATE 3.95 READY
-- =====================================================================
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.91: COVERAGE "ADD TO ACCOUNT" = AN UNPAID VOUCHER (NO INVOICE)
-- * A coverage added to the customer's account makes NO invoice any more. An UNPAID collection voucher is issued in
--   EO-Office (Collection Voucher) for the coverage amount, with a PAY BEFORE date: 1 month. The coverage starts at once.
-- * An unpaid voucher is NOT counted in the collection.
-- * When the customer pays (cash, bank transfer, GCash, check, or cash received by an employee), press RECEIVE PAYMENT on
--   the voucher: it becomes PAID on that date, with the amount received, and only then it is counted.
-- * A coverage billed by an invoice before (the old way) can be changed to an unpaid voucher by EMON HASAN on the
--   coverage page (Change to Unpaid Voucher) - only when nothing was paid on that invoice; the invoice is then removed.
-- Needs 084_insurance_account.sql. Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again.
-- The last line says: UPDATE 3.91 READY - ...
-- =====================================================================
do $$ begin
  if to_regprocedure('public.ins_bill_account(uuid)') is null then raise exception 'Run 084_insurance_account.sql first, then run this again.'; end if;
end $$;

-- 1. a voucher is PAID (counted) or UNPAID (to collect, not counted), with its pay-before date and who received the money
alter table public.collection_vouchers add column if not exists status text not null default 'paid';
alter table public.collection_vouchers add column if not exists issued_on date;
alter table public.collection_vouchers add column if not exists pay_by date;
alter table public.collection_vouchers add column if not exists paid_at timestamptz;
alter table public.collection_vouchers add column if not exists paid_by_name text;
alter table public.collection_vouchers add column if not exists received_by text;
alter table public.collection_vouchers add column if not exists ins_id uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'collection_vouchers_status_chk') then
    alter table public.collection_vouchers add constraint collection_vouchers_status_chk check (status in ('paid', 'unpaid'));
  end if;
end $$;
create index if not exists collection_vouchers_unpaid on public.collection_vouchers (pay_by) where status = 'unpaid';
-- an unpaid voucher's method is ACCOUNT (to collect) until the payment is received
alter table public.collection_vouchers drop constraint if exists collection_vouchers_method_check;
alter table public.collection_vouchers add constraint collection_vouchers_method_check check (method in ('cash', 'bank', 'gcash', 'check', 'other', 'account'));

-- 2. ADD TO ACCOUNT: the coverage is issued and an UNPAID voucher is made (pay before: 1 month); no invoice
create or replace function public.ins_bill_account(p_id uuid) returns public.order_insurance
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare r public.order_insurance; o public.customer_orders; cv uuid; cvno text; ym text := to_char(now(), 'YYYYMM');
  due date := (current_date + interval '1 month')::date; me text := (select full_name from public.profiles where id = auth.uid());
begin
  if not (public.qc_can_write() or public.is_admin()) then raise exception 'Not allowed'; end if;
  select * into r from public.order_insurance where id = p_id for update;
  if not found then raise exception 'Coverage not found'; end if;
  if r.status not in ('unpaid', 'rejected') then raise exception 'Coverage % is %: it cannot be added to the account', r.ins_no, upper(r.status); end if;
  select * into o from public.customer_orders where id = r.order_id;
  insert into public.collection_vouchers (cv_no, cv_date, issued_on, received_from, amount, method, note, status, pay_by, ins_id, created_by, created_by_name)
  values ('CV-' || ym || '-' || lpad(public.next_counter('CV' || ym)::text, 3, '0'), current_date, current_date, left(coalesce(r.customer_name, 'CUSTOMER'), 120),
    r.amount, 'account', left('COVERAGE ' || r.ins_no || ' · ORDER ' || coalesce(r.order_no, '') || ' · ADDED TO THE ACCOUNT', 300), 'unpaid', due, r.id,
    auth.uid(), left(coalesce(me, ''), 120))
  returning id, cv_no into cv, cvno;
  update public.order_insurance set status = 'active', pay_method = 'account', pay_ref = cvno, cv_id = cv, invoice_id = null, pay_by = due,
    review_note = 'ADDED TO THE CUSTOMER''S ACCOUNT · VOUCHER ' || cvno || ' UNPAID · PAY BEFORE ' || upper(to_char(due, 'FMMonth DD YYYY')),
    approved_by = auth.uid(), approved_by_name = left(coalesce(me, ''), 120), approved_at = now(), issued_at = now(), issued_by_eva = false,
    valid_until = case when o.delivered_at is not null then (o.delivered_at at time zone 'Asia/Manila')::date + 15 end, updated_at = now()
  where id = p_id returning * into r;
  if not public.is_admin() then
    perform public.notify_admins('Coverage ' || r.ins_no || ' added to the account',
      'Order ' || coalesce(r.order_no, '') || ' · ' || coalesce(r.customer_name, '') || ' · unpaid voucher ' || cvno || ' · ₱ ' || to_char(r.amount, 'FM999,999,990.00'), 'collection/' || cv);
  end if;
  return r;
end;
$$;
revoke execute on function public.ins_bill_account(uuid) from public, anon;
grant execute on function public.ins_bill_account(uuid) to authenticated;

-- 3. RECEIVE PAYMENT on an unpaid voucher: PAID on that date with the amount received (then it is counted)
create or replace function public.cv_receive(p_id uuid, p_amount numeric, p_method text, p_ref text, p_received_by text, p_date date) returns public.collection_vouchers
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare v public.collection_vouchers; amt numeric; mth text; d date := coalesce(p_date, current_date); me text := (select full_name from public.profiles where id = auth.uid());
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  select * into v from public.collection_vouchers where id = p_id for update;
  if not found then raise exception 'Collection voucher not found'; end if;
  if v.status <> 'unpaid' then raise exception 'Voucher % is already paid', v.cv_no; end if;
  amt := round(coalesce(p_amount, v.amount), 2);
  if amt is null or amt <= 0 then raise exception 'Write the amount received'; end if;
  if d > current_date then raise exception 'The payment date cannot be after today'; end if;
  mth := case when p_method in ('cash', 'bank', 'gcash', 'check', 'other') then p_method else 'cash' end;
  update public.collection_vouchers set status = 'paid', amount = amt, method = mth, cv_date = d,
    reference_no = nullif(left(btrim(coalesce(p_ref, '')), 60), ''), received_by = nullif(left(btrim(coalesce(p_received_by, '')), 120), ''),
    paid_at = now(), paid_by_name = left(coalesce(me, ''), 120), updated_at = now()
  where id = p_id returning * into v;
  if v.ins_id is not null then
    update public.order_insurance set review_note = 'ADDED TO THE CUSTOMER''S ACCOUNT · VOUCHER ' || v.cv_no || ' PAID ' || upper(to_char(d, 'FMMonth DD YYYY'))
      || ' · ₱ ' || to_char(amt, 'FM999,999,990.00'), updated_at = now() where id = v.ins_id;
  end if;
  if not public.is_admin() then
    perform public.notify_admins('Voucher ' || v.cv_no || ' paid', coalesce(v.received_from, '') || ' · ₱ ' || to_char(amt, 'FM999,999,990.00') || ' · ' || upper(mth)
      || coalesce(' · received by ' || v.received_by, ''), 'collection/' || v.id);
  end if;
  return v;
end;
$$;
revoke execute on function public.cv_receive(uuid, numeric, text, text, text, date) from public, anon;
grant execute on function public.cv_receive(uuid, numeric, text, text, text, date) to authenticated;

-- 4. a coverage billed by an invoice before: changed to an unpaid voucher (EMON HASAN; only when nothing was paid on it)
create or replace function public.ins_move_to_voucher(p_id uuid) returns public.order_insurance
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare r public.order_insurance; i record; cv uuid; cvno text; ym text := to_char(now(), 'YYYYMM'); due date; me text := (select full_name from public.profiles where id = auth.uid());
begin
  if not public.is_admin() then raise exception 'Only EMON HASAN can change how a coverage is billed.'; end if;
  select * into r from public.order_insurance where id = p_id for update;
  if not found then raise exception 'Coverage not found'; end if;
  if r.invoice_id is null then raise exception 'Coverage % has no invoice.', r.ins_no; end if;
  select b.id, b.invoice_no, b.invoice_date, b.total_amount, b.balance into i from public.invoice_balances b where b.id = r.invoice_id;
  if i.id is null then raise exception 'The invoice of coverage % is not found.', r.ins_no; end if;
  if exists (select 1 from public.payment_links x where x.invoice_id = i.id and x.removed_at is null) or coalesce(i.balance, 0) < coalesce(i.total_amount, 0) - 0.004 then
    raise exception 'Invoice % of coverage % is already (partly) paid: it stays as it is.', i.invoice_no, r.ins_no;
  end if;
  due := (i.invoice_date + interval '1 month')::date;
  insert into public.collection_vouchers (cv_no, cv_date, issued_on, received_from, amount, method, note, status, pay_by, ins_id, created_by, created_by_name)
  values ('CV-' || ym || '-' || lpad(public.next_counter('CV' || ym)::text, 3, '0'), i.invoice_date, i.invoice_date, left(coalesce(r.customer_name, 'CUSTOMER'), 120),
    r.amount, 'account', left('COVERAGE ' || r.ins_no || ' · ORDER ' || coalesce(r.order_no, '') || ' · ADDED TO THE ACCOUNT (WAS INVOICE ' || i.invoice_no || ')', 300),
    'unpaid', due, r.id, auth.uid(), left(coalesce(me, ''), 120))
  returning id, cv_no into cv, cvno;
  update public.order_insurance set invoice_id = null, cv_id = cv, pay_ref = cvno, pay_by = due,
    review_note = 'ADDED TO THE CUSTOMER''S ACCOUNT · VOUCHER ' || cvno || ' UNPAID · PAY BEFORE ' || upper(to_char(due, 'FMMonth DD YYYY')) || ' (WAS INVOICE ' || i.invoice_no || ')',
    updated_at = now()
  where id = p_id returning * into r;
  perform public.delete_record('customer_invoices', i.id);
  return r;
end;
$$;
revoke execute on function public.ins_move_to_voucher(uuid) from public, anon;
grant execute on function public.ins_move_to_voucher(uuid) to authenticated;

notify pgrst, 'reload schema';

select case when position('''unpaid''' in pg_get_functiondef('public.ins_bill_account(uuid)'::regprocedure)) > 0
    and to_regprocedure('public.cv_receive(uuid,numeric,text,text,text,date)') is not null
  then 'UPDATE 3.91 READY - coverage added to the account = an UNPAID voucher (pay before 1 month; counted when paid); '
    || (select count(*) from public.order_insurance where invoice_id is not null and pay_method = 'account') || ' coverage(s) still billed by invoice (change them on the coverage page)'
  else 'NOT READY - send this message to Claude' end as result;

-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.95: THE COLLECTION VOUCHER - ACCOUNT, QR KEY AND VERIFICATION
-- * A collection voucher can be from a CUSTOMER (their account no shows on the voucher) or an EMPLOYEE (their ID no
--   shows); for anyone else nothing shows. A coverage voucher gets the customer's account by itself.
-- * The QR code of an UNPAID voucher holds a secret key (it is never printed as text). RECEIVE PAYMENT by cash, bank,
--   GCash, check or other is locked until the voucher's QR code is scanned (the key must match). Paid through the
--   CUSTOMER ACCOUNT needs no scan.
-- * Anyone can check a voucher on the Verification page (scan its barcode or type its number): a few details and
--   PAID / UNPAID / EXPIRED.
-- Needs 091_coverage_voucher.sql first.
-- Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again.
-- The last line says: UPDATE 3.95 READY - ...
-- =====================================================================
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'collection_vouchers' and column_name = 'status') then
    raise exception 'Update 3.95: run 091_coverage_voucher.sql first, then this one';
  end if;
end $$;

-- 1) who the money is from: a customer or an employee, and their account no / ID no at that time
alter table public.collection_vouchers
  add column if not exists customer_id uuid references public.customers(id) on delete set null,
  add column if not exists employee_id uuid references public.employees(id) on delete set null,
  add column if not exists payer_no text;
create index if not exists collection_vouchers_customer_idx on public.collection_vouchers (customer_id);
create index if not exists collection_vouchers_employee_idx on public.collection_vouchers (employee_id);
alter table public.collection_vouchers drop constraint if exists collection_vouchers_one_payer;
alter table public.collection_vouchers add constraint collection_vouchers_one_payer check (customer_id is null or employee_id is null);

-- the coverage vouchers made before: the customer of the coverage
update public.collection_vouchers v set customer_id = i.customer_id, payer_no = c.account_no
  from public.order_insurance i join public.customers c on c.id = i.customer_id
  where (i.cv_id = v.id or i.id = v.ins_id) and v.customer_id is null and v.employee_id is null;

-- and from now on: when a coverage gets its voucher (paid, or added to the account), the voucher gets the customer
create or replace function public.cv_payer_from_coverage()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.cv_id is not null and new.customer_id is not null then
    update public.collection_vouchers v set customer_id = new.customer_id,
        payer_no = (select c.account_no from public.customers c where c.id = new.customer_id)
      where v.id = new.cv_id and v.customer_id is null and v.employee_id is null;
  end if;
  return null;
end $$;
revoke execute on function public.cv_payer_from_coverage() from public, anon, authenticated;
drop trigger if exists order_insurance_cv_payer on public.order_insurance;
create trigger order_insurance_cv_payer after insert or update of cv_id on public.order_insurance
  for each row when (new.cv_id is not null) execute function public.cv_payer_from_coverage();

-- 2) New / Edit Collection Voucher saves the customer or the employee (their account no / ID no is read here)
create or replace function public.save_collection(p_id uuid, p_data jsonb)
returns public.collection_vouchers language plpgsql security definer set search_path = '' set "TimeZone" = 'Asia/Manila' as $$
declare v public.collection_vouchers; me text := (select full_name from public.profiles where id = auth.uid()); amt numeric; mth text;
  who boolean := p_data ? 'customer_id' or p_data ? 'employee_id';
  cust uuid := nullif(p_data ->> 'customer_id', '')::uuid; emp uuid := nullif(p_data ->> 'employee_id', '')::uuid; pno text;
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  if coalesce(trim(p_data ->> 'received_from'), '') = '' then raise exception 'Write who the money was collected from'; end if;
  amt := coalesce(nullif(p_data ->> 'amount', '')::numeric, 0);
  if amt <= 0 then raise exception 'Write the amount collected'; end if;
  mth := case when p_data ->> 'method' in ('cash','bank','gcash','check','other') then p_data ->> 'method' else 'cash' end;
  if cust is not null and emp is not null then raise exception 'Choose a customer or an employee, not both'; end if;
  if cust is not null then
    select account_no into pno from public.customers where id = cust;
    if not found then raise exception 'Customer not found'; end if;
  elsif emp is not null then
    select employee_no into pno from public.employees where id = emp;
    if not found then raise exception 'Employee not found'; end if;
  end if;
  if p_id is null then
    insert into public.collection_vouchers (cv_no, cv_date, received_from, amount, method, reference_no, note, created_by_name, customer_id, employee_id, payer_no)
    values ('CV-' || to_char(coalesce(nullif(p_data ->> 'cv_date', '')::date, current_date), 'YYYYMM') || '-' || lpad(public.next_counter('CV' || to_char(coalesce(nullif(p_data ->> 'cv_date', '')::date, current_date), 'YYYYMM'))::text, 3, '0'),
      coalesce(nullif(p_data ->> 'cv_date', '')::date, current_date), left(trim(p_data ->> 'received_from'), 120), round(amt, 2), mth,
      nullif(left(trim(coalesce(p_data ->> 'reference_no', '')), 60), ''), nullif(left(trim(coalesce(p_data ->> 'note', '')), 300), ''), me, cust, emp, pno)
    returning * into v;
    return v;
  end if;
  select * into v from public.collection_vouchers where id = p_id for update;
  if not found then raise exception 'Collection voucher not found'; end if;
  if not (public.is_admin() or (v.created_by = auth.uid() and v.created_at > now() - interval '24 hours')) then
    raise exception 'Only EMON HASAN can change this voucher now (the person who made it can change it for 24 hours)';
  end if;
  update public.collection_vouchers set cv_date = coalesce(nullif(p_data ->> 'cv_date', '')::date, cv_date), received_from = left(trim(p_data ->> 'received_from'), 120),
    amount = round(amt, 2), method = case when status = 'unpaid' then method else mth end, reference_no = nullif(left(trim(coalesce(p_data ->> 'reference_no', '')), 60), ''),
    note = nullif(left(trim(coalesce(p_data ->> 'note', '')), 300), ''), updated_at = now(),
    customer_id = case when who then cust else customer_id end, employee_id = case when who then emp else employee_id end, payer_no = case when who then pno else payer_no end
  where id = p_id returning * into v;
  return v;
end $$;
revoke execute on function public.save_collection(uuid, jsonb) from public, anon;
grant execute on function public.save_collection(uuid, jsonb) to authenticated;

-- the employees to choose from on the voucher form (name and ID no only; EO-Office may not open the employee list)
create or replace function public.cv_employees()
returns table (id uuid, employee_no text, name text, status text) language sql stable security definer set search_path = '' as $$
  select e.id, e.employee_no, btrim(coalesce(e.first_name, '') || ' ' || coalesce(e.last_name, '')), e.status
  from public.employees e
  where public.qc_can_write() and e.employee_no is not null
  order by (e.status = 'active') desc, e.first_name, e.last_name;
$$;
revoke execute on function public.cv_employees() from public, anon;
grant execute on function public.cv_employees() to authenticated;

-- 3) the secret key in the QR code of an unpaid voucher (only these functions read it)
create table if not exists public.collection_voucher_keys (
  cv_id uuid primary key references public.collection_vouchers(id) on delete cascade,
  pay_key text not null,
  created_at timestamptz not null default now()
);
alter table public.collection_voucher_keys enable row level security;
revoke all on table public.collection_voucher_keys from anon, authenticated;

-- the key for the QR code, made the first time the unpaid voucher is printed
create or replace function public.cv_pay_key(p_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare k text;
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  if not exists (select 1 from public.collection_vouchers where id = p_id and status = 'unpaid') then return null; end if;
  insert into public.collection_voucher_keys (cv_id, pay_key) values (p_id, upper(left(replace(gen_random_uuid()::text, '-', ''), 12)))
    on conflict (cv_id) do nothing;
  select pay_key into k from public.collection_voucher_keys where cv_id = p_id;
  return k;
end $$;
revoke execute on function public.cv_pay_key(uuid) from public, anon;
grant execute on function public.cv_pay_key(uuid) to authenticated;

-- does the scanned QR code belong to this voucher? (Receive Payment shows it at once)
create or replace function public.cv_check_key(p_id uuid, p_key text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.qc_can_write() and exists (select 1 from public.collection_voucher_keys k where k.cv_id = p_id and k.pay_key = upper(btrim(coalesce(p_key, ''))));
$$;
revoke execute on function public.cv_check_key(uuid, text) from public, anon;
grant execute on function public.cv_check_key(uuid, text) to authenticated;

-- 4) RECEIVE PAYMENT: cash, bank, GCash, check or other needs the key of the voucher's QR code; the customer account does not
drop function if exists public.cv_receive(uuid, numeric, text, text, text, date);
create or replace function public.cv_receive(p_id uuid, p_amount numeric, p_method text, p_ref text, p_received_by text, p_date date, p_key text default null)
returns public.collection_vouchers language plpgsql security definer set search_path = '' set "TimeZone" = 'Asia/Manila' as $$
declare v public.collection_vouchers; amt numeric; mth text; d date := coalesce(p_date, current_date); me text := (select full_name from public.profiles where id = auth.uid());
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  select * into v from public.collection_vouchers where id = p_id for update;
  if not found then raise exception 'Collection voucher not found'; end if;
  if v.status <> 'unpaid' then raise exception 'Voucher % is already paid', v.cv_no; end if;
  amt := round(coalesce(p_amount, v.amount), 2);
  if amt is null or amt <= 0 then raise exception 'Write the amount received'; end if;
  if d > current_date then raise exception 'The payment date cannot be after today'; end if;
  mth := case when p_method in ('cash', 'bank', 'gcash', 'check', 'other', 'account') then p_method else 'cash' end;
  if mth = 'account' then
    if v.customer_id is null then raise exception 'Customer Account is only for the voucher of a customer'; end if;
  elsif not exists (select 1 from public.collection_voucher_keys k where k.cv_id = p_id and k.pay_key = upper(btrim(coalesce(p_key, '')))) then
    raise exception 'Scan the QR code of voucher % first: it unlocks Receive Payment (cash, bank, GCash, check, other)', v.cv_no;
  end if;
  update public.collection_vouchers set status = 'paid', amount = amt, method = mth, cv_date = d,
    reference_no = nullif(left(btrim(coalesce(p_ref, '')), 60), ''), received_by = nullif(left(btrim(coalesce(p_received_by, '')), 120), ''),
    paid_at = now(), paid_by_name = left(coalesce(me, ''), 120), updated_at = now()
  where id = p_id returning * into v;
  delete from public.collection_voucher_keys where cv_id = p_id; -- paid: the key is not needed any more
  if v.ins_id is not null then
    update public.order_insurance set review_note = 'ADDED TO THE CUSTOMER''S ACCOUNT · VOUCHER ' || v.cv_no || ' PAID ' || upper(to_char(d, 'FMMonth DD YYYY'))
      || ' · ₱ ' || to_char(amt, 'FM999,999,990.00'), updated_at = now() where id = v.ins_id;
  end if;
  if not public.is_admin() then
    perform public.notify_admins('Voucher ' || v.cv_no || ' paid', coalesce(v.received_from, '') || ' · ₱ ' || to_char(amt, 'FM999,999,990.00') || ' · '
      || case when mth = 'account' then 'CUSTOMER ACCOUNT' else upper(mth) || ' · QR CODE CHECKED' end || coalesce(' · received by ' || v.received_by, ''), 'collection/' || v.id);
  end if;
  return v;
end $$;
revoke execute on function public.cv_receive(uuid, numeric, text, text, text, date, text) from public, anon;
grant execute on function public.cv_receive(uuid, numeric, text, text, text, date, text) to authenticated;

-- 5) the Verification page: a few details and PAID / UNPAID / EXPIRED, for anyone (no name, no account)
create or replace function public.cv_verify(p_code text)
returns jsonb language sql stable security definer set search_path = '' set "TimeZone" = 'Asia/Manila' as $$
  select coalesce((select jsonb_build_object('found', true, 'cv_no', v.cv_no,
      'purpose', case when v.ins_id is not null or v.note ilike 'COVERAGE INS-%' or exists (select 1 from public.order_insurance i where i.cv_id = v.id) then 'COVERAGE' else 'COLLECTION' end,
      'amount', v.amount, 'issued_on', coalesce(v.issued_on, v.cv_date), 'paid_on', case when v.status = 'paid' then v.cv_date end, 'pay_by', v.pay_by,
      'state', case when v.status = 'paid' then 'PAID' when v.pay_by < current_date then 'EXPIRED' else 'UNPAID' end)
    from public.collection_vouchers v
    where upper(v.cv_no) = upper(btrim(split_part(regexp_replace(btrim(coalesce(p_code, '')), '^EMONCV\|', '', 'i'), '|', 1)))),
    jsonb_build_object('found', false));
$$;
revoke execute on function public.cv_verify(text) from public;
grant execute on function public.cv_verify(text) to anon, authenticated;

notify pgrst, 'reload schema';

select case when exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'collection_vouchers' and column_name = 'payer_no')
    and to_regclass('public.collection_voucher_keys') is not null
    and to_regprocedure('public.cv_receive(uuid,numeric,text,text,text,date,text)') is not null
    and to_regprocedure('public.cv_receive(uuid,numeric,text,text,text,date)') is null
    and to_regprocedure('public.cv_verify(text)') is not null and to_regprocedure('public.cv_employees()') is not null
  then 'UPDATE 3.95 READY - collection vouchers show the customer account / employee ID, the QR code unlocks Receive Payment, the barcode checks PAID / UNPAID'
  else 'NOT READY - send this message to Claude' end as result;
