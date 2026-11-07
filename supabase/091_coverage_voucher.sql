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
