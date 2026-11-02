-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.77: INSURANCE - PAY NOW OR ADD TO THE ACCOUNT; NOT PAID IN 3 DAYS = CANCELLED
-- 1. PAY NOW: as before (QR code + payment slip); paid, a COLLECTION VOUCHER is issued with the coverage.
-- 2. ADD TO ACCOUNT: the premium is billed to the customer's account as its own INVOICE (with an invoice no, on the
--    SOA and the balance); the coverage is issued at once. No voucher (the customer pays the invoice later).
-- 3. A coverage not paid (no slip sent, not billed to the account) within 3 DAYS is CANCELLED by itself.
-- Needs 077_insurance.sql. Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again.
-- The last line says: UPDATE 3.77 READY - ...
-- =====================================================================
do $$ begin
  if to_regclass('public.order_insurance') is null then raise exception 'Run 077_insurance.sql first, then run this again.'; end if;
end $$;

alter table public.order_insurance drop constraint if exists order_insurance_pay_method_check;
alter table public.order_insurance add constraint order_insurance_pay_method_check check (pay_method in ('cash','bank','gcash','check','other','account'));
alter table public.order_insurance add column if not exists invoice_id uuid references public.customer_invoices(id) on delete set null;
alter table public.order_insurance add column if not exists pay_by date;
create index if not exists order_insurance_invoice_idx on public.order_insurance(invoice_id);
update public.order_insurance set pay_by = (created_at at time zone 'Asia/Manila')::date + 3 where pay_by is null;
alter table public.order_insurance alter column pay_by set default ((now() at time zone 'Asia/Manila')::date + 3);

-- ADD TO ACCOUNT: the premium becomes an invoice of the customer; the coverage is issued at once
create or replace function public.ins_bill_account(p_id uuid) returns public.order_insurance
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare r public.order_insurance; o public.customer_orders; inv uuid; ino text; me text := (select full_name from public.profiles where id = auth.uid());
begin
  if not (public.qc_can_write() or public.is_admin()) then raise exception 'Not allowed'; end if;
  select * into r from public.order_insurance where id = p_id for update;
  if not found then raise exception 'Insurance not found'; end if;
  if r.status not in ('unpaid', 'rejected') then raise exception 'Insurance % is %: it cannot be billed to the account', r.ins_no, upper(r.status); end if;
  select * into o from public.customer_orders where id = r.order_id;
  insert into public.customer_invoices (customer_id, invoice_date, purchase_date, po_number, total_boxes, total_pcs, total_amount, payment_terms)
  values (r.customer_id, current_date, current_date, r.ins_no, 0, 0, r.amount, coalesce(nullif(o.payment_terms, ''), '15 DAYS'))
  returning id, invoice_no into inv, ino;
  update public.order_insurance set status = 'active', pay_method = 'account', pay_ref = ino, invoice_id = inv,
    review_note = 'BILLED TO THE CUSTOMER''S ACCOUNT · INVOICE ' || ino, approved_by = auth.uid(), approved_by_name = left(coalesce(me, ''), 120),
    approved_at = now(), issued_at = now(), issued_by_eva = false,
    valid_until = case when o.delivered_at is not null then (o.delivered_at at time zone 'Asia/Manila')::date + 15 end, updated_at = now()
  where id = p_id returning * into r;
  if not public.is_admin() then
    perform public.notify_admins('Insurance ' || r.ins_no || ' billed to the account', 'Order ' || coalesce(r.order_no, '') || ' · ' || coalesce(r.customer_name, '') || ' · invoice ' || ino || ' · ₱ ' || to_char(r.amount, 'FM999,999,990.00'), 'insurance/' || r.id);
  end if;
  return r;
end;
$$;
revoke execute on function public.ins_bill_account(uuid) from public, anon;
grant execute on function public.ins_bill_account(uuid) to authenticated;

-- NOT PAID IN 3 DAYS: cancelled by itself (asked by the portal when the insurance pages open, and every hour when
-- the server's scheduler is on)
create or replace function public.ins_expire_unpaid() returns integer
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare n int;
begin
  update public.order_insurance set status = 'cancelled', review_note = 'NOT PAID WITHIN 3 DAYS - CANCELLED AUTOMATICALLY', updated_at = now()
  where status = 'unpaid' and coalesce(pay_by, (created_at at time zone 'Asia/Manila')::date + 3) < current_date;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.ins_expire_unpaid() from public, anon;
grant execute on function public.ins_expire_unpaid() to authenticated;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'eo-insurance-expire';
    perform cron.schedule('eo-insurance-expire', '7 * * * *', 'select public.ins_expire_unpaid()');
  end if;
exception when others then null; -- no scheduler: the portal asks when the insurance pages open
end $$;
do $$ begin perform public.ins_expire_unpaid(); end $$;

notify pgrst, 'reload schema';

select case when to_regprocedure('public.ins_bill_account(uuid)') is not null
  then 'UPDATE 3.77 READY - insurance: PAY NOW (voucher) or ADD TO ACCOUNT (invoice); not paid in 3 days = cancelled automatically'
  else 'NOT READY - send this message to Claude' end as result;
