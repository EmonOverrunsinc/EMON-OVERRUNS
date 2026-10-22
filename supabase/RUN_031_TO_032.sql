-- =====================================================================
-- EMON OVERRUNS E-PORTAL - updates 3.19 and 3.21 in one paste
--   031_settle_by.sql   : credit memo Settle By (Account Credit / Bank Transfer / Cash)
--   032_employee_id.sql : Employee ID Card, emergency contact, sign-in with the ID card + PIN
-- Paste all of it in the Supabase SQL Editor and press Run. It is safe to run again (also if 031 was run before).
-- =====================================================================

-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.19: how a credit memo is settled
-- The customer chooses how the money goes back: ACCOUNT CREDIT (taken off the customer's balance, as before),
-- BANK TRANSFER or CASH (the money is handed back, so the balance does not change - like a refund).
-- Old credit memos have no choice saved and stay ACCOUNT CREDIT.
-- Run once in the Supabase SQL Editor after 030_delete_history.sql. It is safe to run again.
-- =====================================================================

alter table public.credit_memos add column if not exists settle_by text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'credit_memos_settle_by_check') then
    alter table public.credit_memos add constraint credit_memos_settle_by_check check (settle_by in ('account_credit', 'bank_transfer', 'cash'));
  end if;
end $$;
-- true when the memo is taken off the customer's balance: an approved credit or discount settled as account credit
alter table public.credit_memos add column if not exists off_balance boolean
  generated always as (requested_action in ('credit', 'discount') and coalesce(settle_by, 'account_credit') = 'account_credit') stored;


-- the balance and the statement count only the memos taken off the balance

CREATE OR REPLACE FUNCTION public.account_due(p_customer uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET "TimeZone" TO 'Asia/Manila'
AS $function$
  with paid as (
    select coalesce((select sum(p.amount) from public.payments_received p where p.customer_id = p_customer), 0)
         + coalesce((select sum(m.request_amount) from public.credit_memos m where m.customer_id = p_customer and m.status in ('approved','paid')
                       and m.off_balance), 0)
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
$function$;

CREATE OR REPLACE FUNCTION public.balance_before(p_customer uuid, p_date date)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET "TimeZone" TO 'Asia/Manila'
AS $function$
  select coalesce((select c.opening_balance from public.customers c where c.id = p_customer and c.application_date < p_date), 0)
       + coalesce((select sum(total_amount) from public.customer_invoices where customer_id = p_customer and invoice_date < p_date), 0)
       + coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = p_customer and o.status = 'applied' and (o.subject_type = 'charge' or (o.subject_type = 'settlement' and o.adjust_type = 'add')) and o.applied_at::date < p_date), 0)
       - coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = p_customer and o.status = 'applied' and o.subject_type = 'settlement' and o.adjust_type = 'reduce' and o.applied_at::date < p_date), 0)
       - coalesce((select sum(amount) from public.payments_received where customer_id = p_customer and paid_date < p_date), 0)
       - coalesce((select sum(request_amount) from public.credit_memos where customer_id = p_customer and status in ('approved','paid')
                   and off_balance and approved_at::date < p_date), 0);
$function$;

CREATE OR REPLACE FUNCTION public.statement_amounts(p_customer uuid, p_month date, OUT opening numeric, OUT debit numeric, OUT credit numeric)
 RETURNS record
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET "TimeZone" TO 'Asia/Manila'
AS $function$
declare
  c public.customers;
  m date := date_trunc('month', p_month)::date;
  nxt date := (date_trunc('month', p_month) + interval '1 month')::date;
  lo date; -- the first day counted (null: from the very first entry)
begin
  select * into c from public.customers where id = p_customer;
  if m <= date_trunc('month', c.application_date)::date then opening := 0; lo := null;
  else opening := public.balance_before(c.id, m); lo := m; end if;
  debit := (case when c.application_date < nxt and (lo is null or c.application_date >= lo) then coalesce(c.opening_balance, 0) else 0 end)
    + coalesce((select sum(i.total_amount) from public.customer_invoices i where i.customer_id = c.id and i.invoice_date < nxt and (lo is null or i.invoice_date >= lo)), 0)
    + coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = c.id and o.status = 'applied'
                 and (o.subject_type = 'charge' or (o.subject_type = 'settlement' and o.adjust_type = 'add'))
                 and o.applied_at::date < nxt and (lo is null or o.applied_at::date >= lo)), 0);
  credit := coalesce((select sum(p.amount) from public.payments_received p where p.customer_id = c.id and p.paid_date < nxt and (lo is null or p.paid_date >= lo)), 0)
    + coalesce((select sum(x.request_amount) from public.credit_memos x where x.customer_id = c.id and x.status in ('approved','paid')
                 and x.off_balance and x.approved_at::date < nxt and (lo is null or x.approved_at::date >= lo)), 0)
    + coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = c.id and o.status = 'applied'
                 and o.subject_type = 'settlement' and o.adjust_type = 'reduce'
                 and o.applied_at::date < nxt and (lo is null or o.applied_at::date >= lo)), 0);
end;
$function$;


-- an invoice is corrected only by the memos taken off the balance

CREATE OR REPLACE FUNCTION public.fit_invoice_links(p_invoice uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare cap numeric; over numeric; l public.payment_links; why text := 'E-Portal (the invoice now needs less)';
begin
  select i.total_amount - coalesce((select sum(m.request_amount) from public.credit_memos m
           where m.invoice_id = i.id and m.status in ('approved','paid') and m.off_balance), 0)
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
$function$;

CREATE OR REPLACE FUNCTION public.link_payment(p_payment uuid, p_invoice uuid, p_amount numeric DEFAULT NULL::numeric)
 RETURNS payment_links
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
                where m.invoice_id = i.id and m.status in ('approved','paid') and m.off_balance), 0)
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
$function$;

create or replace view public.customer_balances with (security_invoker = true) as
SELECT id AS customer_id,
    COALESCE(( SELECT sum(i.total_amount) AS sum
           FROM customer_invoices i
          WHERE i.customer_id = c.id), 0::numeric)::numeric(14,2) AS total_invoiced,
    COALESCE(( SELECT sum(p.amount) AS sum
           FROM payments_received p
          WHERE p.customer_id = c.id), 0::numeric)::numeric(14,2) AS total_paid,
    COALESCE(( SELECT sum(m.request_amount) AS sum
           FROM credit_memos m
          WHERE m.customer_id = c.id AND (m.status = ANY (ARRAY['approved'::text, 'paid'::text])) AND m.off_balance), 0::numeric)::numeric(14,2) AS total_credits,
    (opening_balance + COALESCE(( SELECT sum(i.total_amount) AS sum
           FROM customer_invoices i
          WHERE i.customer_id = c.id), 0::numeric) + COALESCE(( SELECT sum(o.amount) AS sum
           FROM order_letters o
          WHERE o.customer_id = c.id AND o.status = 'applied'::text AND (o.subject_type = 'charge'::text OR o.subject_type = 'settlement'::text AND o.adjust_type = 'add'::text)), 0::numeric) - COALESCE(( SELECT sum(p.amount) AS sum
           FROM payments_received p
          WHERE p.customer_id = c.id), 0::numeric) - COALESCE(( SELECT sum(m.request_amount) AS sum
           FROM credit_memos m
          WHERE m.customer_id = c.id AND (m.status = ANY (ARRAY['approved'::text, 'paid'::text])) AND m.off_balance), 0::numeric) - COALESCE(( SELECT sum(o.amount) AS sum
           FROM order_letters o
          WHERE o.customer_id = c.id AND o.status = 'applied'::text AND o.subject_type = 'settlement'::text AND o.adjust_type = 'reduce'::text), 0::numeric))::numeric(14,2) AS balance_due,
    COALESCE(( SELECT sum(o.amount) AS sum
           FROM order_letters o
          WHERE o.customer_id = c.id AND o.status = 'applied'::text AND o.subject_type = 'charge'::text), 0::numeric)::numeric(14,2) AS total_charges,
    COALESCE(( SELECT sum(
                CASE o.adjust_type
                    WHEN 'reduce'::text THEN - o.amount
                    ELSE o.amount
                END) AS sum
           FROM order_letters o
          WHERE o.customer_id = c.id AND o.status = 'applied'::text AND o.subject_type = 'settlement'::text), 0::numeric)::numeric(14,2) AS total_settlement,
    opening_balance
   FROM customers c;

create or replace view public.invoice_balances with (security_invoker = true) as
WITH lp AS (
         SELECT l.invoice_id,
            sum(l.amount) AS amount
           FROM payment_links l
          WHERE l.removed_at IS NULL
          GROUP BY l.invoice_id
        ), lr AS (
         SELECT m.invoice_id,
            sum(m.request_amount) AS amount
           FROM credit_memos m
          WHERE m.invoice_id IS NOT NULL AND (m.status = ANY (ARRAY['approved'::text, 'paid'::text])) AND m.off_balance
          GROUP BY m.invoice_id
        ), inv AS (
         SELECT i_1.id,
            i_1.customer_id,
            i_1.total_amount,
            LEAST(i_1.total_amount, COALESCE(r.amount, 0::numeric)) AS ret,
            GREATEST(0::numeric, COALESCE(r.amount, 0::numeric) - i_1.total_amount) AS ret_extra,
            COALESCE(l.amount, 0::numeric) AS lpay
           FROM customer_invoices i_1
             LEFT JOIN lp l ON l.invoice_id = i_1.id
             LEFT JOIN lr r ON r.invoice_id = i_1.id
        ), inv2 AS (
         SELECT x.id,
            x.customer_id,
            x.total_amount,
            x.ret,
            x.ret_extra,
            x.lpay,
            LEAST(x.total_amount - x.ret, x.lpay) AS direct,
            GREATEST(0::numeric, x.lpay - (x.total_amount - x.ret)) + x.ret_extra AS extra
           FROM inv x
        ), pool AS (
         SELECT c_1.id AS customer_id,
            COALESCE(( SELECT sum(p.amount) AS sum
                   FROM payments_received p
                  WHERE p.customer_id = c_1.id), 0::numeric) - COALESCE(( SELECT sum(l.amount) AS sum
                   FROM payment_links l
                     JOIN payments_received p ON p.id = l.payment_id AND p.customer_id = c_1.id
                     JOIN customer_invoices x ON x.id = l.invoice_id AND x.customer_id = c_1.id
                  WHERE l.removed_at IS NULL), 0::numeric) + COALESCE(( SELECT sum(x.extra) AS sum
                   FROM inv2 x
                  WHERE x.customer_id = c_1.id), 0::numeric) + COALESCE(( SELECT sum(m.request_amount) AS sum
                   FROM credit_memos m
                  WHERE m.customer_id = c_1.id AND (m.status = ANY (ARRAY['approved'::text, 'paid'::text])) AND m.off_balance AND (m.invoice_id IS NULL OR NOT (EXISTS ( SELECT 1
                           FROM customer_invoices x
                          WHERE x.id = m.invoice_id AND x.customer_id = c_1.id)))), 0::numeric) + COALESCE(( SELECT sum(o.amount) AS sum
                   FROM order_letters o
                  WHERE o.customer_id = c_1.id AND o.status = 'applied'::text AND o.subject_type = 'settlement'::text AND o.adjust_type = 'reduce'::text), 0::numeric) AS amount
           FROM customers c_1
        ), owed AS (
         SELECT c_1.id AS customer_id,
            NULL::uuid AS invoice_id,
            c_1.application_date AS d,
            0 AS k,
            c_1.created_at AS t,
            c_1.opening_balance::numeric AS amount
           FROM customers c_1
          WHERE c_1.opening_balance > 0::numeric
        UNION ALL
         SELECT i_1.customer_id,
            i_1.id,
            i_1.invoice_date,
            1,
            i_1.created_at,
            i_1.total_amount - x.ret - x.direct AS "numeric"
           FROM customer_invoices i_1
             JOIN inv2 x ON x.id = i_1.id
        UNION ALL
         SELECT o.customer_id,
            NULL::uuid AS uuid,
            (COALESCE(o.applied_at, o.created_at) AT TIME ZONE 'Asia/Manila'::text)::date AS timezone,
            2,
            o.created_at,
            o.amount::numeric AS amount
           FROM order_letters o
          WHERE o.customer_id IS NOT NULL AND o.status = 'applied'::text AND (o.subject_type = 'charge'::text OR o.subject_type = 'settlement'::text AND o.adjust_type = 'add'::text)
        ), fifo AS (
         SELECT w.invoice_id,
            w.customer_id,
            w.amount,
            COALESCE(sum(w.amount) OVER (PARTITION BY w.customer_id ORDER BY w.d, w.k, w.t, w.invoice_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0::numeric) AS before,
            sum(w.amount) OVER (PARTITION BY w.customer_id) AS total
           FROM owed w
        ), newest AS (
         SELECT DISTINCT ON (i_1.customer_id) i_1.customer_id,
            i_1.id
           FROM customer_invoices i_1
          ORDER BY i_1.customer_id, i_1.invoice_date DESC, i_1.created_at DESC, i_1.id DESC
        ), paid AS (
         SELECT f.invoice_id AS id,
            x.ret,
            (x.direct + GREATEST(0::numeric, LEAST(f.amount, COALESCE(pl.amount, 0::numeric) - f.before)) +
                CASE
                    WHEN nw.id = f.invoice_id THEN GREATEST(0::numeric, COALESCE(pl.amount, 0::numeric) - f.total)
                    ELSE 0::numeric
                END)::numeric(14,2) AS amount
           FROM fifo f
             JOIN inv2 x ON x.id = f.invoice_id
             LEFT JOIN pool pl ON pl.customer_id = f.customer_id
             LEFT JOIN newest nw ON nw.customer_id = f.customer_id
          WHERE f.invoice_id IS NOT NULL
        )
 SELECT i.id,
    i.invoice_no,
    i.customer_id,
    i.invoice_date,
    i.purchase_date,
    i.po_number,
    i.total_boxes,
    i.total_pcs,
    i.total_amount,
    i.created_by,
    i.created_by_name,
    i.created_at,
    c.first_name,
    c.last_name,
    c.account_no,
    c.business_name,
    c.status AS customer_status,
    pd.amount AS amount_paid,
    (i.total_amount - pd.ret - pd.amount)::numeric(14,2) AS balance,
        CASE
            WHEN (pd.ret + pd.amount) >= i.total_amount THEN 'paid'::text
            WHEN (pd.ret + pd.amount) > 0::numeric THEN 'partial'::text
            ELSE 'unpaid'::text
        END AS pay_status,
    i.payment_terms,
        CASE
            WHEN i.payment_terms ~ '^[0-9]{1,3} DAYS$'::text THEN i.invoice_date + split_part(i.payment_terms, ' '::text, 1)::integer
            WHEN i.payment_terms = 'CASH ON DELIVERY'::text THEN i.invoice_date
            ELSE NULL::date
        END AS due_date,
    pd.ret::numeric(14,2) AS amount_returned
   FROM customer_invoices i
     JOIN customers c ON c.id = i.customer_id
     JOIN paid pd ON pd.id = i.id;


select 'UPDATE 3.19 READY - credit memo settled by Account Credit, Bank Transfer or Cash' as result;

-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.21: Employee ID Card
-- * Emergency contact on the employee and on the job application (copied to the employee when the Director approves).
-- * Every approved employee gets an ID card by itself: card no EOID-YYYY-####, valid for 1 year, issued by the Director
--   who approved or added the employee. A new card replaces the old one; termination ends the card; re-hire issues a new one.
-- * The back of the card carries a QR with a private card code. The employee signs in by scanning the card and typing a
--   4-digit PIN (set once in My Profile). 5 wrong PINs lock the PIN for 15 minutes; the Director can reset a PIN.
-- * Only the Director prints the card. The private code and the PIN are kept in the private schema (not readable through the API).
-- Run once in the Supabase SQL Editor after 031_settle_by.sql. It is safe to run again.
-- =====================================================================

-- 1. emergency contact
alter table public.employees add column if not exists emergency_name text, add column if not exists emergency_relation text,
  add column if not exists emergency_phone text, add column if not exists emergency_address text;
alter table public.job_applications add column if not exists emergency_name text, add column if not exists emergency_relation text,
  add column if not exists emergency_phone text, add column if not exists emergency_address text;

-- corrections may change the emergency contact
CREATE OR REPLACE FUNCTION public.editable_columns(p_table text)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case p_table
    when 'customers' then array['first_name','last_name','phone','email','address','business_name','business_start_date','facebook_name','facebook_link','has_extra_facebook','extra_facebook_name','facebook_verified','credit_limit']
    when 'customer_invoices' then array['invoice_date','total_amount','purchase_date','po_number','total_boxes','total_pcs','payment_terms']
    when 'payments_received' then array['method','bank_name','bank_account','reference_no','notes']
    when 'credit_memos' then array['payment_ref','po_number','article','brand','style','batch_no','serial_no','purchase_date','defect_category','defect_detail','assigned_by','inspection_notes','factory_status']
    when 'employees' then array['first_name','last_name','position','phone','address','date_hired','monthly_salary','emergency_name','emergency_relation','emergency_phone','emergency_address']
    when 'payslips' then array['method','reference_no','notes']
    when 'projects' then array['title','description','location','start_date','end_date']
    when 'project_payments' then array['received_by','method','reference_no','notes']
    when 'pay_companies' then array['name','contact_person','contact','address','country','currency','notes']
    when 'pay_accounts' then array['account_name','account_number','bank_name','branch_name','notes']
    when 'pay_vouchers' then array['purpose','method','reference_no','notes']
    when 'job_applications' then array['full_name','phone','email','present_address','permanent_address','father_name','mother_name','spouse_name','date_of_birth','birth_place','id_number','gender','religion','blood_group','apply_salary','apply_duty_hours','apply_joining_date','emergency_name','emergency_relation','emergency_phone','emergency_address']
    when 'stock_bills' then array['supplier_bill_no','batch_no','shipment_no','shipment_date','total_boxes','notes','shipping_company','shipping_company_code']
    else null end;
$function$;

-- the Director's approval of a job application copies the emergency contact to the employee
CREATE OR REPLACE FUNCTION public.review_job_application(p_id uuid, p_action text, p_role text DEFAULT 'staff'::text, p_modules text[] DEFAULT '{}'::text[], p_note text DEFAULT NULL::text)
 RETURNS job_applications
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET "TimeZone" TO 'Asia/Manila'
AS $function$
declare
  a public.job_applications;
  me text;
  login_email text;
  emp_id uuid;
  fname text; lname text;
begin
  if not public.is_admin() then raise exception 'Only the Director can review job applications'; end if;
  select * into a from public.job_applications where id = p_id for update;
  if a.id is null then raise exception 'Job application not found'; end if;
  if a.status <> 'submitted' then raise exception 'This application is already %', upper(a.status); end if;
  me := (select full_name from public.profiles where id = auth.uid());
  perform public.allow_record_change();
  if p_action = 'reject' then
    update public.job_applications set status = 'rejected', review_note = p_note, approved_by_name = me, approved_at = now() where id = p_id returning * into a;
    perform public.notify_user(a.profile_id, 'Job application ' || a.application_no || ' was not approved', coalesce(p_note, ''), 'dashboard');
    return a;
  end if;
  if p_action <> 'approve' then raise exception 'Unknown action %', p_action; end if;
  if p_role not in ('admin','staff','viewer') then raise exception 'Choose a role'; end if;
  if not exists (select 1 from public.attachments x where x.owner_type = 'job_application' and x.owner_id = p_id and x.kind = 'signed_form') then
    raise exception 'Upload the signed application form first';
  end if;
  login_email := lower(coalesce((select p.email from public.profiles p where p.id = a.profile_id), a.email));
  if login_email is null then raise exception 'This application has no email address, so a login cannot be linked'; end if;
  fname := trim(regexp_replace(a.full_name, '\s+\S+\s*$', ''));
  lname := trim(substring(a.full_name from '(\S+)\s*$'));
  if fname = '' then fname := a.full_name; lname := ''; end if;
  select id into emp_id from public.employees where lower(email) = login_email;
  if emp_id is null then
    insert into public.employees (first_name, last_name, position, email, phone, address, date_hired, photo_path, role, modules, monthly_salary, job_application_id,
                                  emergency_name, emergency_relation, emergency_phone, emergency_address)
    values (fname, lname, a.position_title, login_email, a.phone, a.present_address, coalesce(a.apply_joining_date, current_date),
            a.photo_path, p_role, coalesce(p_modules, '{}'), coalesce(a.apply_salary, 0), a.id,
            a.emergency_name, a.emergency_relation, a.emergency_phone, a.emergency_address)
    returning id into emp_id;
  else
    update public.employees set first_name = fname, last_name = lname, position = a.position_title, phone = a.phone, address = a.present_address,
      date_hired = coalesce(a.apply_joining_date, current_date), photo_path = coalesce(a.photo_path, photo_path), role = p_role,
      modules = coalesce(p_modules, '{}'), monthly_salary = coalesce(a.apply_salary, monthly_salary), job_application_id = a.id,
      termination_date = null, termination_reason = null,
      emergency_name = coalesce(a.emergency_name, emergency_name), emergency_relation = coalesce(a.emergency_relation, emergency_relation),
      emergency_phone = coalesce(a.emergency_phone, emergency_phone), emergency_address = coalesce(a.emergency_address, emergency_address),
      profile_id = coalesce(profile_id, a.profile_id),
      status = case when coalesce(profile_id, a.profile_id) is null then 'waiting' else 'active' end
    where id = emp_id;
  end if;
  update public.job_applications set status = 'approved', review_note = p_note, approved_by_name = me, approved_at = now(), employee_id = emp_id,
    approval_no = 'A' || to_char(current_date, 'YYYY') || lpad(public.next_counter('APR' || to_char(current_date, 'YYYY'))::text, 4, '0')
  where id = p_id returning * into a;
  perform public.notify_user(a.profile_id, 'Your job application was approved', a.approval_no || ' — welcome to ' || a.company_name || '. You can now use the portal.', 'dashboard');
  return a;
end;
$function$;

-- 2. the ID cards
create table if not exists public.employee_cards (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  card_no text not null unique,
  issued_at timestamptz not null default now(),
  valid_until date not null,
  issued_by uuid references public.profiles(id) on delete set null,
  issued_by_name text,
  status text not null default 'active' check (status in ('active', 'replaced', 'revoked')),
  ended_at timestamptz,
  print_count int not null default 0,
  last_printed_at timestamptz,
  last_login_at timestamptz
);
create unique index if not exists employee_cards_one_active on public.employee_cards (employee_id) where status = 'active';
create index if not exists employee_cards_employee on public.employee_cards (employee_id);
alter table public.employee_cards enable row level security;
revoke all on public.employee_cards from anon, authenticated;
grant select on public.employee_cards to authenticated;
drop policy if exists "ecards: director" on public.employee_cards;
create policy "ecards: director" on public.employee_cards for select to authenticated using ((select public.is_admin()));
drop policy if exists "ecards: own" on public.employee_cards;
create policy "ecards: own" on public.employee_cards for select to authenticated
  using (exists (select 1 from public.employees e where e.id = employee_id and e.profile_id = (select auth.uid())));

-- the private part (never readable through the API): the card code and the employee's PIN
create schema if not exists private;
create table if not exists private.employee_card_keys (
  card_id uuid primary key references public.employee_cards(id) on delete cascade,
  secret text not null
);
create table if not exists private.employee_pins (
  employee_id uuid primary key references public.employees(id) on delete cascade,
  pin_hash text not null,
  set_at timestamptz not null default now(),
  failed int not null default 0,
  locked_until timestamptz
);
revoke all on private.employee_card_keys, private.employee_pins from public;
insert into private.app_secrets (k, v)
  select 'card_pin_key', md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text)
  where not exists (select 1 from private.app_secrets where k = 'card_pin_key');

create or replace function private.pin_hash(p_employee uuid, p_pin text) returns text
language sql stable security definer set search_path = '' as $$
  select encode(sha256(convert_to(p_employee::text || '|' || coalesce(p_pin, '') || '|' || k.v, 'UTF8')), 'hex')
  from private.app_secrets k where k.k = 'card_pin_key';
$$;
revoke execute on function private.pin_hash(uuid, text) from public;

-- a new card for the employee (the card before it is replaced); p_by: the Director who issues it
create or replace function private.issue_card(p_employee uuid, p_by uuid) returns public.employee_cards
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare c public.employee_cards; yr text := to_char(current_date, 'YYYY');
begin
  update public.employee_cards set status = 'replaced', ended_at = now() where employee_id = p_employee and status = 'active';
  insert into public.employee_cards (employee_id, card_no, valid_until, issued_by, issued_by_name)
  values (p_employee, 'EOID-' || yr || '-' || lpad(public.next_counter('EOID' || yr)::text, 4, '0'), (current_date + interval '1 year')::date,
          p_by, (select full_name from public.profiles where id = p_by))
  returning * into c;
  insert into private.employee_card_keys (card_id, secret)
  values (c.id, upper(left(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 40)));
  return c;
end;
$$;
revoke execute on function private.issue_card(uuid, uuid) from public;

-- who issues a card made by itself: the Director signed in, else the main Director, else the first Director
create or replace function private.card_issuer() returns uuid
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.id from public.profiles p where p.id = auth.uid() and p.role = 'admin'),
                  (select p.id from public.profiles p where lower(p.email) = 'emonoverruns@gmail.com' limit 1),
                  (select p.id from public.profiles p where p.role = 'admin' and p.status = 'active' order by p.created_at limit 1));
$$;
revoke execute on function private.card_issuer() from public;

-- an employee added or approved gets a card; termination ends it; re-hire issues a new one
create or replace function public.employees_card_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'terminated' then perform private.issue_card(new.id, private.card_issuer()); end if;
  elsif new.status is distinct from old.status then
    if new.status = 'terminated' then
      update public.employee_cards set status = 'revoked', ended_at = now() where employee_id = new.id and status = 'active';
    elsif old.status = 'terminated' and not exists (select 1 from public.employee_cards c where c.employee_id = new.id and c.status = 'active') then
      perform private.issue_card(new.id, private.card_issuer());
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function public.employees_card_sync() from public, anon, authenticated;
drop trigger if exists employees_card on public.employees;
create trigger employees_card after insert or update of status on public.employees for each row execute function public.employees_card_sync();

-- employees already in the portal get their first card now
do $$
declare e record;
begin
  for e in select x.id from public.employees x
           where x.status <> 'terminated' and not exists (select 1 from public.employee_cards c where c.employee_id = x.id) loop
    perform private.issue_card(e.id, private.card_issuer());
  end loop;
end $$;

-- 3. the Director: a new card, the code for the print (counted), the PIN state, reset the PIN
create or replace function public.issue_employee_card(p_employee uuid) returns public.employee_cards
language plpgsql security definer set search_path = '' as $$
declare st text;
begin
  if not public.is_admin() then raise exception 'Only the Director can issue an ID card'; end if;
  select status into st from public.employees where id = p_employee;
  if st is null then raise exception 'Employee not found'; end if;
  if st = 'terminated' then raise exception 'A terminated employee cannot get an ID card'; end if;
  return private.issue_card(p_employee, auth.uid());
end;
$$;
revoke execute on function public.issue_employee_card(uuid) from public, anon;
grant execute on function public.issue_employee_card(uuid) to authenticated;

create or replace function public.employee_card_code(p_card uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare t text;
begin
  if not public.is_admin() then raise exception 'Only the Director can print an ID card'; end if;
  select 'EMONID|' || c.card_no || '|' || k.secret into t
  from public.employee_cards c join private.employee_card_keys k on k.card_id = c.id where c.id = p_card and c.status = 'active';
  if t is null then raise exception 'This ID card is no longer active'; end if;
  update public.employee_cards set print_count = print_count + 1, last_printed_at = now() where id = p_card;
  return t;
end;
$$;
revoke execute on function public.employee_card_code(uuid) from public, anon;
grant execute on function public.employee_card_code(uuid) to authenticated;

create or replace function public.employee_pin_state(p_employee uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Only the Director can see this'; end if;
  return coalesce((select jsonb_build_object('pin_set', true, 'set_at', p.set_at, 'locked_until', case when p.locked_until > now() then p.locked_until end)
                   from private.employee_pins p where p.employee_id = p_employee), jsonb_build_object('pin_set', false));
end;
$$;
revoke execute on function public.employee_pin_state(uuid) from public, anon;
grant execute on function public.employee_pin_state(uuid) to authenticated;

create or replace function public.reset_card_pin(p_employee uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Only the Director can reset a PIN'; end if;
  delete from private.employee_pins where employee_id = p_employee;
  return true;
end;
$$;
revoke execute on function public.reset_card_pin(uuid) from public, anon;
grant execute on function public.reset_card_pin(uuid) to authenticated;

-- 4. the employee: my card, my PIN
create or replace function public.my_id_card() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('card_no', c.card_no, 'valid_until', c.valid_until, 'issued_at', c.issued_at, 'employee_no', e.employee_no,
                            'pin_set', exists (select 1 from private.employee_pins p where p.employee_id = e.id))
  from public.employees e join public.employee_cards c on c.employee_id = e.id and c.status = 'active'
  where e.profile_id = auth.uid() and e.status = 'active'
  limit 1;
$$;
revoke execute on function public.my_id_card() from public, anon;
grant execute on function public.my_id_card() to authenticated;

create or replace function public.set_card_pin(p_pin text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare e uuid;
begin
  select id into e from public.employees where profile_id = auth.uid() and status = 'active';
  if e is null then raise exception 'Only an active employee has an ID card PIN'; end if;
  if coalesce(p_pin, '') !~ '^[0-9]{4}$' then raise exception 'The PIN is 4 numbers'; end if;
  if p_pin ~ '^([0-9])\1{3}$' or p_pin in ('0123', '1234', '2345', '3456', '4567', '5678', '6789', '9876', '8765', '7654', '6543', '5432', '4321', '3210') then
    raise exception 'This PIN is too easy to guess. Choose another one';
  end if;
  insert into private.employee_pins (employee_id, pin_hash, set_at) values (e, private.pin_hash(e, p_pin), now())
  on conflict (employee_id) do update set pin_hash = excluded.pin_hash, set_at = now(), failed = 0, locked_until = null;
  return true;
end;
$$;
revoke execute on function public.set_card_pin(text) from public, anon;
grant execute on function public.set_card_pin(text) to authenticated;

-- 5. sign in with the card: checked by the card-login Edge Function only (service role). Gives back the account email,
-- or the reason the card cannot sign in. A wrong PIN is counted; the 5th locks the PIN for 15 minutes.
create or replace function public.card_login(p_code text, p_pin text) returns jsonb
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare m text[]; c public.employee_cards; sec text; e public.employees; pr public.profiles; p private.employee_pins; left_n int;
begin
  m := regexp_match(upper(trim(coalesce(p_code, ''))), '^EMONID\|(EOID-[0-9]{4}-[0-9]{4,})\|([0-9A-F]{40})$');
  if m is null then return jsonb_build_object('ok', false, 'error', 'This is not an EMON OVERRUNS employee ID card.'); end if;
  select * into c from public.employee_cards where card_no = m[1];
  select k.secret into sec from private.employee_card_keys k where k.card_id = c.id;
  if c.id is null or sec is distinct from m[2] then return jsonb_build_object('ok', false, 'error', 'This ID card is not valid.'); end if;
  if c.status = 'replaced' then return jsonb_build_object('ok', false, 'error', 'This ID card was replaced by a newer card. Use your new ID card.'); end if;
  if c.status <> 'active' then return jsonb_build_object('ok', false, 'error', 'This ID card is no longer valid.'); end if;
  if c.valid_until < current_date then
    return jsonb_build_object('ok', false, 'error', 'This ID card expired on ' || to_char(c.valid_until, 'FMMONTH DD YYYY') || '. Ask the Director for a new card.');
  end if;
  select * into e from public.employees where id = c.employee_id;
  if e.profile_id is null then
    return jsonb_build_object('ok', false, 'error', 'Your portal account is not ready yet. Press Create Account and use ' || e.email || ' first.');
  end if;
  select * into pr from public.profiles where id = e.profile_id;
  if e.status <> 'active' or pr.id is null or pr.status <> 'active' then
    return jsonb_build_object('ok', false, 'error', 'Your login is blocked. Ask the Director.');
  end if;
  select * into p from private.employee_pins where employee_id = e.id for update;
  if p.employee_id is null then
    return jsonb_build_object('ok', false, 'error', 'Set your 4-digit ID card PIN first: sign in with your email and password, then open My Profile.');
  end if;
  if p.locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'Too many wrong PINs. Try again after ' || to_char(p.locked_until, 'FMHH12:MI AM') || ', or ask the Director to reset your PIN.');
  end if;
  if p.pin_hash <> private.pin_hash(e.id, p_pin) then
    update private.employee_pins set
      failed = case when failed + 1 >= 5 then 0 else failed + 1 end,
      locked_until = case when failed + 1 >= 5 then now() + interval '15 minutes' else null end
    where employee_id = e.id;
    left_n := 4 - p.failed;
    if left_n <= 0 then
      return jsonb_build_object('ok', false, 'error', 'Wrong PIN 5 times. The PIN is locked for 15 minutes.');
    end if;
    return jsonb_build_object('ok', false, 'error', 'Wrong PIN. ' || left_n || case when left_n = 1 then ' try' else ' tries' end || ' left.');
  end if;
  update private.employee_pins set failed = 0, locked_until = null where employee_id = e.id;
  update public.employee_cards set last_login_at = now() where id = c.id;
  return jsonb_build_object('ok', true, 'email', lower(pr.email));
end;
$$;
revoke execute on function public.card_login(text, text) from public, anon, authenticated;
grant execute on function public.card_login(text, text) to service_role;

-- 6. anyone may check a scanned card (the code on the card is needed, so card numbers cannot be tried one by one)
create or replace function public.check_employee_card(p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare m text[]; c public.employee_cards; sec text; e public.employees;
begin
  m := regexp_match(upper(trim(coalesce(p_code, ''))), '^EMONID\|(EOID-[0-9]{4}-[0-9]{4,})\|([0-9A-F]{40})$');
  if m is null then return jsonb_build_object('found', false); end if;
  select * into c from public.employee_cards where card_no = m[1];
  select k.secret into sec from private.employee_card_keys k where k.card_id = c.id;
  if c.id is null or sec is distinct from m[2] then return jsonb_build_object('found', false); end if;
  select * into e from public.employees where id = c.employee_id;
  return jsonb_build_object('found', true, 'card_no', c.card_no, 'employee_id', case when public.is_staff() then e.id end,
    'name', upper(trim(e.first_name || ' ' || e.last_name)), 'position', e.position, 'employee_no', e.employee_no,
    'issued_at', c.issued_at, 'valid_until', c.valid_until,
    'state', case when c.status = 'replaced' then 'REPLACED' when c.status <> 'active' or e.status = 'terminated' then 'NOT VALID'
                  when c.valid_until < current_date then 'EXPIRED' else 'VALID' end);
end;
$$;
revoke execute on function public.check_employee_card(text) from public;
grant execute on function public.check_employee_card(text) to anon, authenticated;

select 'UPDATE 3.21 READY - Employee ID Card' as result;

select 'ALL DONE - updates 3.19 and 3.21 are in' as result;
