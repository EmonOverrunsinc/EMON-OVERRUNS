-- =====================================================================
-- EMON OVERRUNS E-PORTAL — Update 1.3
-- Billing companies: currency (PHP, BDT or both), address, contact person and photo.
-- Orders: amount due and days overdue on customer orders, installment schedule, reason for closing,
-- and the Account Balance Certificate.
-- Run once in the Supabase SQL Editor after 005_update_1_2.sql. It is safe to run again.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Billing companies: currency, address, contact person, photo
-- ---------------------------------------------------------------------
drop view if exists public.pay_company_totals;
alter table public.pay_companies add column if not exists currency text not null default 'BOTH';
alter table public.pay_companies drop constraint if exists pay_companies_currency_check;
alter table public.pay_companies add constraint pay_companies_currency_check check (currency in ('PHP','BDT','BOTH'));
alter table public.pay_companies add column if not exists address text;
alter table public.pay_companies add column if not exists contact_person text;

-- A voucher is in the company's currency: PHP, BDT, or PHP and BDT (PHP × rate = BDT).
alter table public.pay_vouchers alter column amount_bdt drop expression if exists;
alter table public.pay_vouchers alter column amount_php drop not null;
alter table public.pay_vouchers alter column exchange_rate drop not null;
alter table public.pay_vouchers drop constraint if exists pay_vouchers_amount_check;
alter table public.pay_vouchers add constraint pay_vouchers_amount_check check (coalesce(amount_php, 0) > 0 or coalesce(amount_bdt, 0) > 0);

create or replace function public.pay_companies_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.status := 'active';
  new.status_note := null;
  new.currency := upper(coalesce(new.currency, 'BOTH'));
  new.created_by := auth.uid();
  new.created_by_name := (select full_name from public.profiles where id = auth.uid());
  return new;
end;
$$;

create or replace function public.pay_vouchers_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare co public.pay_companies;
begin
  select * into co from public.pay_companies c where c.id = new.company_id;
  if co.id is null then raise exception 'Choose the company'; end if;
  if co.status <> 'active' then
    raise exception 'This company is SUSPENDED. New payments are blocked until it is reactivated by an approved order';
  end if;
  if new.account_id is not null and not exists (select 1 from public.pay_accounts a where a.id = new.account_id and a.company_id = new.company_id) then
    raise exception 'That account belongs to a different company';
  end if;
  if co.currency = 'PHP' then
    if coalesce(new.amount_php, 0) <= 0 then raise exception 'Enter the amount in PHP'; end if;
    new.exchange_rate := null; new.amount_bdt := null;
  elsif co.currency = 'BDT' then
    if coalesce(new.amount_bdt, 0) <= 0 then raise exception 'Enter the amount in BDT'; end if;
    new.amount_php := null; new.exchange_rate := null;
  else
    if coalesce(new.amount_php, 0) <= 0 then raise exception 'Enter the amount in PHP'; end if;
    if coalesce(new.exchange_rate, 0) <= 0 then raise exception 'Enter the exchange rate'; end if;
    new.amount_bdt := round(new.amount_php * new.exchange_rate, 2);
  end if;
  new.voucher_no := 'BD' || to_char(new.pay_date, 'YYYYMMDD') || lpad(public.next_counter('BD' || to_char(new.pay_date, 'YYYYMMDD'))::text, 3, '0');
  new.created_by := auth.uid();
  new.created_by_name := (select full_name from public.profiles where id = auth.uid());
  return new;
end;
$$;

create view public.pay_company_totals with (security_invoker = true) as
  select c.*,
    (select count(*) from public.pay_accounts a where a.company_id = c.id)::int as accounts_count,
    (select count(*) from public.pay_vouchers v where v.company_id = c.id)::int as vouchers_count,
    coalesce((select sum(v.amount_php) from public.pay_vouchers v where v.company_id = c.id), 0)::numeric(16,2) as total_php,
    coalesce((select sum(v.amount_bdt) from public.pay_vouchers v where v.company_id = c.id), 0)::numeric(16,2) as total_bdt,
    coalesce((select sum(v.amount_php) from public.pay_vouchers v where v.company_id = c.id and date_trunc('month', v.pay_date) = date_trunc('month', current_date)), 0)::numeric(16,2) as month_php,
    coalesce((select sum(v.amount_bdt) from public.pay_vouchers v where v.company_id = c.id and date_trunc('month', v.pay_date) = date_trunc('month', current_date)), 0)::numeric(16,2) as month_bdt,
    (select max(v.pay_date) from public.pay_vouchers v where v.company_id = c.id) as last_paid
  from public.pay_companies c;
revoke all on public.pay_company_totals from anon;
grant select on public.pay_company_totals to authenticated;

-- The company photo is added or changed by billing staff (saved records are otherwise never edited).
create or replace function public.set_company_photo(p_id uuid, p_path text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.can_write('billing') then raise exception 'You do not have permission to change the company photo'; end if;
  if coalesce(p_path, '') !~ ('^pay_company/' || p_id::text || '/') then raise exception 'Invalid photo'; end if;
  perform public.allow_record_change();
  update public.pay_companies set photo_path = p_path where id = p_id;
  if not found then raise exception 'Company not found'; end if;
end;
$$;
revoke execute on function public.set_company_photo(uuid, text) from public, anon;
grant execute on function public.set_company_photo(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- Orders: amount due and days overdue, installment schedule, reason for closing, balance certificate
-- ---------------------------------------------------------------------
alter table public.order_letters add column if not exists balance_due numeric(14,2);
alter table public.order_letters add column if not exists days_overdue integer;
alter table public.order_letters add column if not exists closure_reason text;
alter table public.order_letters add column if not exists installment_every text;
alter table public.order_letters drop constraint if exists order_letters_installment_every_check;
alter table public.order_letters add constraint order_letters_installment_every_check check (installment_every is null or installment_every in ('month','15 days','week'));
alter table public.order_letters drop constraint if exists order_letters_subject_type_check;
alter table public.order_letters add constraint order_letters_subject_type_check check (subject_type in
  ('suspension','closure','reactivation','reopen','termination','memo','unpaid','installment','unsettled_balance','promise_to_pay','balance_certificate','other'));

-- What a customer owes now and since when: payments and credits pay the oldest invoices first, so the
-- oldest invoice not yet covered tells how many days the account is overdue.
create or replace function public.account_due(p_customer uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with paid as (
    select coalesce((select sum(p.amount) from public.payments_received p where p.customer_id = p_customer), 0)
         + coalesce((select sum(m.request_amount) from public.credit_memos m where m.customer_id = p_customer and m.status in ('approved','paid')
                       and m.requested_action in ('credit','discount')), 0) as total
  ), inv as (
    select i.invoice_no, i.invoice_date, sum(i.total_amount) over (order by i.invoice_date, i.created_at, i.invoice_no) as running
    from public.customer_invoices i where i.customer_id = p_customer
  ), oldest as (
    select inv.invoice_no, inv.invoice_date from inv, paid where inv.running > paid.total order by inv.running limit 1
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

create or replace function public.order_letters_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare kind text; d jsonb;
begin
  if num_nonnulls(new.customer_id, new.employee_id, new.company_id) <> 1 then
    raise exception 'Choose one customer, employee or company for this order';
  end if;
  kind := case when new.employee_id is not null then 'employee' when new.company_id is not null then 'company' else 'customer' end;
  if kind = 'employee' and new.subject_type not in ('suspension','reactivation','termination','memo') then
    raise exception 'An employee order is a suspension, reactivation, termination or memo';
  end if;
  if kind = 'company' and new.subject_type not in ('suspension','reactivation','memo') then
    raise exception 'A company order is a suspension, reactivation or memo';
  end if;
  if kind = 'customer' and new.subject_type in ('termination','memo') then
    raise exception 'This order cannot be made for a customer';
  end if;
  -- A customer order keeps the amount due and the days overdue of the day it is made.
  if kind = 'customer' then
    d := public.account_due(new.customer_id);
    new.balance_due := coalesce((d->>'balance_due')::numeric, 0);
    new.days_overdue := coalesce((d->>'days_overdue')::int, 0);
  else
    new.balance_due := null; new.days_overdue := null;
  end if;
  if new.subject_type = 'closure' then
    if coalesce(trim(new.closure_reason), '') = '' then raise exception 'Choose the reason for closing the account'; end if;
  else
    new.closure_reason := null;
  end if;
  if new.subject_type = 'installment' then
    if coalesce(new.amount, 0) <= 0 or coalesce(new.installments, 0) < 1 or new.first_due_date is null then
      raise exception 'Enter the amount, the number of installments and the first due date';
    end if;
    new.installment_every := coalesce(new.installment_every, 'month');
    new.installment_amount := coalesce(new.installment_amount, round(new.amount / new.installments, 2));
  else
    new.installment_every := null;
  end if;
  if new.subject_type = 'promise_to_pay' and (coalesce(new.amount, 0) <= 0 or new.first_due_date is null) then
    raise exception 'Enter the amount the customer will pay and the date';
  end if;
  new.order_no := 'ORDER-' || to_char(new.order_date, 'YYYY') || '-' || lpad(public.next_counter('ORDER' || to_char(new.order_date, 'YYYY'))::text, 3, '0');
  new.status := 'pending';
  new.approved_by := null; new.approved_by_name := null; new.approved_at := null;
  new.applied_by_name := null; new.applied_at := null; new.applied_result := null;
  new.created_by := auth.uid();
  new.created_by_name := (select full_name from public.profiles where id = auth.uid());
  return new;
end;
$$;

create or replace function public.carry_out_order(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  o public.order_letters;
  c public.customers;
  e public.employees;
  pc public.pay_companies;
  newst text;
  res text;
  me text := (select full_name from public.profiles where id = auth.uid());
begin
  select * into o from public.order_letters where id = p_id for update;
  perform public.allow_record_change();
  if o.customer_id is not null then
    select * into c from public.customers where id = o.customer_id for update;
    newst := case o.subject_type when 'suspension' then 'suspended' when 'closure' then 'closed' when 'reactivation' then 'active' when 'reopen' then 'active' else null end;
    if o.subject_type = 'suspension' and c.status <> 'active' then raise exception 'Account % is % — only ACTIVE accounts can be suspended', c.account_no, upper(c.status); end if;
    if o.subject_type = 'closure' and c.status not in ('active','suspended') then raise exception 'Account % is % and cannot be closed', c.account_no, upper(c.status); end if;
    if o.subject_type = 'reactivation' and c.status <> 'suspended' then raise exception 'Account % is % — only SUSPENDED accounts can be reactivated', c.account_no, upper(c.status); end if;
    if o.subject_type = 'reopen' and c.status <> 'closed' then raise exception 'Account % is % — only CLOSED accounts can be reopened', c.account_no, upper(c.status); end if;
    if newst is not null then
      update public.customers set status = newst, status_note = o.order_no || ': ' || o.subject || coalesce(' — ' || o.closure_reason, '') where id = c.id;
      res := 'Account ' || c.account_no || ' is now ' || upper(newst);
    else
      res := case when o.subject_type = 'balance_certificate'
        then 'Account Balance Certificate issued for account ' || c.account_no || ' — PHP ' || to_char(coalesce(o.balance_due, 0), 'FM999,999,999,990.00') || ' due'
        else 'Order recorded on account ' || c.account_no end;
    end if;
    insert into public.customer_events (customer_id, action, note, actor, actor_name)
    values (c.id, case o.subject_type when 'reopen' then 'reopened' else coalesce(newst, replace(o.subject_type, '_', ' ')) end || ' by ' || o.order_no, o.subject, auth.uid(), me);
  elsif o.employee_id is not null then
    select * into e from public.employees where id = o.employee_id for update;
    if o.subject_type <> 'memo' and e.profile_id = auth.uid() then raise exception 'You cannot suspend, reactivate or terminate your own employee record'; end if;
    if o.subject_type = 'suspension' then
      if e.status not in ('active','inactive') then raise exception 'Employee % is % — only ACTIVE employees can be suspended', e.employee_no, upper(e.status); end if;
      newst := 'suspended';
    elsif o.subject_type = 'reactivation' then
      if e.status <> 'suspended' then raise exception 'Employee % is % — only SUSPENDED employees can be reactivated', e.employee_no, upper(e.status); end if;
      newst := case when e.profile_id is null then 'waiting' else 'active' end;
    elsif o.subject_type = 'termination' then
      if e.status = 'terminated' then raise exception 'Employee % is already TERMINATED', e.employee_no; end if;
      newst := 'terminated';
    end if;
    if newst = 'terminated' then
      update public.employees set status = 'terminated', termination_date = current_date, termination_reason = o.order_no || ': ' || o.subject where id = e.id;
    elsif newst is not null then
      update public.employees set status = newst where id = e.id;
    end if;
    res := case when newst is null then 'Memo recorded for employee ' || e.employee_no else 'Employee ' || e.employee_no || ' is now ' || upper(newst) end;
  elsif o.company_id is not null then
    select * into pc from public.pay_companies where id = o.company_id for update;
    if o.subject_type = 'suspension' then
      if pc.status <> 'active' then raise exception '% is % — only ACTIVE companies can be suspended', pc.name, upper(pc.status); end if;
      newst := 'suspended';
    elsif o.subject_type = 'reactivation' then
      if pc.status <> 'suspended' then raise exception '% is % — only SUSPENDED companies can be reactivated', pc.name, upper(pc.status); end if;
      newst := 'active';
    end if;
    if newst is not null then
      update public.pay_companies set status = newst, status_note = o.order_no || ': ' || o.subject where id = pc.id;
      res := pc.name || ' is now ' || upper(newst);
    else
      res := 'Memo recorded for ' || pc.name;
    end if;
  else
    res := 'Order carried out';
  end if;
  update public.order_letters set status = 'applied', applied_at = now(), applied_by_name = me, applied_result = res where id = o.id;
  return jsonb_build_object('order_no', o.order_no, 'result', res, 'status', newst);
end;
$$;
revoke execute on function public.carry_out_order(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Customer Public ID: Base64 of "<customer id>|<NAME>", so decoding it shows whose account it is.
-- (The Private ID stays a sealed fingerprint that only the CEO sees.)
-- ---------------------------------------------------------------------
create or replace function public.customer_public_id(p_data jsonb) returns text
language sql immutable set search_path = '' as $$
  select replace(encode(convert_to(coalesce(p_data->>'account_no', '') || '|'
    || upper(trim(coalesce(p_data->>'first_name', '') || ' ' || coalesce(p_data->>'last_name', ''))), 'UTF8'), 'base64'), E'\n', '');
$$;
revoke execute on function public.customer_public_id(jsonb) from public, anon, authenticated;
do $$
begin
  if not exists (select 1 from private.app_secrets where k = 'customer_ids_base64') then
    perform set_config('eo.allow_change', 'on', true);
    update public.customers c set public_id = public.customer_public_id(to_jsonb(c));
    insert into private.app_secrets (k, v) values ('customer_ids_base64', now()::text);
  end if;
end $$;

-- Details that can be corrected: billing companies add the contact person, address and currency.
create or replace function public.editable_columns(p_table text) returns text[]
language sql immutable set search_path = '' as $$
  select case p_table
    when 'customers' then array['first_name','last_name','phone','email','address','business_name','business_start_date','facebook_name','has_extra_facebook','extra_facebook_name','facebook_verified']
    when 'customer_invoices' then array['purchase_date','po_number','total_boxes','total_pcs']
    when 'payments_received' then array['method','bank_name','bank_account','reference_no','notes']
    when 'credit_memos' then array['payment_ref','po_number','article','brand','style','batch_no','serial_no','purchase_date','defect_category','defect_detail','assigned_by','inspection_notes','factory_status']
    when 'employees' then array['first_name','last_name','position','phone','address','date_hired','monthly_salary']
    when 'payslips' then array['method','reference_no','notes']
    when 'projects' then array['title','description','location','start_date','end_date']
    when 'project_payments' then array['received_by','method','reference_no','notes']
    when 'pay_companies' then array['name','contact_person','contact','address','country','currency','notes']
    when 'pay_accounts' then array['account_name','account_number','bank_name','branch_name','notes']
    when 'pay_vouchers' then array['purpose','method','reference_no','notes']
    when 'job_applications' then array['full_name','phone','email','present_address','permanent_address','father_name','mother_name','spouse_name','date_of_birth','birth_place','id_number','gender','religion','blood_group','apply_salary','apply_duty_hours','apply_joining_date']
    else null end;
$$;
revoke execute on function public.editable_columns(text) from public, anon;

-- Public verification: a voucher shows its own currency; a balance certificate shows the amount due;
-- a customer account shows the amount due to signed-in portal users.
create or replace function public.verify_record(p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  raw text := trim(coalesce(p_code, ''));
  cands text[];
  dec text;
  c text;
  r record;
  amt text;
begin
  if raw = '' then return jsonb_build_object('found', false); end if;
  if raw ~* '#verify/' then raw := regexp_replace(raw, '^.*#verify/', '', 'i'); end if;
  raw := split_part(split_part(raw, '?', 1), '&', 1);
  cands := array(
    select distinct upper(trim(x)) from unnest(string_to_array(raw, '|')) x
    where trim(x) <> '' and upper(trim(x)) not in ('EMON','EMONCUST','EMONINV','EMONPAY','EMONCM','EMONPRJ','EMONSP','EMONPS','EMONBD','ORDER','EMONJA','EMONSOA'));
  -- A customer's Public ID is Base64 of "<customer id>|<name>": decoding it finds the account.
  begin
    dec := convert_from(decode(raw, 'base64'), 'UTF8');
    if position('|' in dec) > 1 then cands := cands || upper(trim(split_part(dec, '|', 1))); end if;
  exception when others then null;
  end;
  foreach c in array cands loop
    -- customer account (account no, application no or public ID)
    select * into r from public.customers cu where upper(cu.account_no) = c or upper(cu.application_no) = c or upper(cu.public_id) = c limit 1;
    if found then
      -- The amount due shows only to signed-in portal users (not on the public page) and never on the Validated Print.
      return jsonb_build_object('found', true, 'type', 'Customer Account', 'number', r.account_no, 'status', r.status,
        'fields', (select jsonb_agg(f) from jsonb_array_elements(jsonb_build_array(
          jsonb_build_array('Customer ID', r.account_no), jsonb_build_array('Account Name', r.first_name || ' ' || r.last_name),
          case when public.is_active() then jsonb_build_array('Amount Due (PHP)',
            to_char(coalesce((select b.balance_due from public.customer_balances b where b.customer_id = r.id), 0), 'FM999,999,999,990.00')) end,
          jsonb_build_array('Application No', r.application_no), jsonb_build_array('Public ID', r.public_id),
          jsonb_build_array('Opened', to_char(r.application_date, 'DD Mon YYYY')), jsonb_build_array('Account Status', upper(r.status)))) f where f <> 'null'::jsonb));
    end if;
    select i.*, cu.first_name, cu.last_name, cu.account_no as acct,
      coalesce((select sum(p.amount) from public.payments_received p where p.invoice_id = i.id), 0) as paid
      into r from public.customer_invoices i join public.customers cu on cu.id = i.customer_id where upper(i.invoice_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Invoice', 'number', r.invoice_no,
        'status', case when r.paid >= r.total_amount then 'paid' when r.paid > 0 then 'partial' else 'unpaid' end,
        'fields', jsonb_build_array(
          jsonb_build_array('Invoice No', r.invoice_no), jsonb_build_array('Customer', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Account No', r.acct), jsonb_build_array('Invoice Date', to_char(r.invoice_date, 'DD Mon YYYY')),
          jsonb_build_array('PO Number', coalesce(r.po_number, '—')), jsonb_build_array('Boxes / Pcs', r.total_boxes || ' / ' || r.total_pcs),
          jsonb_build_array('Amount (PHP)', to_char(r.total_amount, 'FM999,999,999,990.00')),
          jsonb_build_array('Paid (PHP)', to_char(r.paid, 'FM999,999,999,990.00'))));
    end if;
    select p.*, cu.first_name, cu.last_name, cu.account_no as acct, i.invoice_no as inv
      into r from public.payments_received p join public.customers cu on cu.id = p.customer_id left join public.customer_invoices i on i.id = p.invoice_id
      where upper(p.receipt_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Payment Receipt', 'number', r.receipt_no, 'status', 'received',
        'fields', jsonb_build_array(
          jsonb_build_array('Receipt No', r.receipt_no), jsonb_build_array('Received From', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Account No', r.acct), jsonb_build_array('Date Paid', to_char(r.paid_date, 'DD Mon YYYY')),
          jsonb_build_array('Amount (PHP)', to_char(r.amount, 'FM999,999,999,990.00')), jsonb_build_array('Method', replace(r.method, '_', ' ')),
          jsonb_build_array('Reference', coalesce(r.reference_no, '—')), jsonb_build_array('Invoice', coalesce(r.inv, 'General payment')),
          jsonb_build_array('Verified By', coalesce(r.created_by_name, '—'))));
    end if;
    select m.*, cu.first_name, cu.last_name, cu.account_no as acct
      into r from public.credit_memos m join public.customers cu on cu.id = m.customer_id where upper(m.memo_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Credit Memo', 'number', r.memo_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Report No', r.memo_no), jsonb_build_array('Customer', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Customer ID', r.acct), jsonb_build_array('Date', to_char(r.memo_date, 'DD Mon YYYY')),
          jsonb_build_array('Request', replace(r.requested_action, '_', ' ')), jsonb_build_array('Amount (PHP)', to_char(r.request_amount, 'FM999,999,999,990.00')),
          jsonb_build_array('Status', upper(r.status))));
    end if;
    select s.*, cu.first_name, cu.last_name, cu.account_no as acct
      into r from public.statements s join public.customers cu on cu.id = s.customer_id where upper(s.statement_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Statement of Account', 'number', r.statement_no, 'status', 'issued',
        'fields', jsonb_build_array(
          jsonb_build_array('Statement No', r.statement_no), jsonb_build_array('Customer', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Account No', r.acct), jsonb_build_array('Period', to_char(r.period_start, 'DD Mon YYYY') || ' – ' || to_char(r.period_end, 'DD Mon YYYY')),
          jsonb_build_array('Opening (PHP)', to_char(r.opening_balance, 'FM999,999,999,990.00')),
          jsonb_build_array('Closing (PHP)', to_char(r.closing_balance, 'FM999,999,999,990.00'))));
    end if;
    select o.*, cu.first_name, cu.last_name, cu.account_no as acct, em.first_name as em_first, em.last_name as em_last, em.employee_no as em_no, pc.name as co_name
      into r from public.order_letters o left join public.customers cu on cu.id = o.customer_id
      left join public.employees em on em.id = o.employee_id left join public.pay_companies pc on pc.id = o.company_id
      where upper(o.order_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Order Letter', 'number', r.order_no, 'status', r.status,
        'fields', (select jsonb_agg(f) from jsonb_array_elements(jsonb_build_array(
          jsonb_build_array('Order No', r.order_no), jsonb_build_array('Date', to_char(r.order_date, 'DD Mon YYYY')),
          jsonb_build_array(case when r.employee_id is not null then 'Employee' when r.company_id is not null then 'Company' else 'Account' end,
            coalesce(r.first_name || ' ' || r.last_name || ' (' || r.acct || ')', r.em_first || ' ' || r.em_last || ' (' || r.em_no || ')', r.co_name, '—')),
          jsonb_build_array('Subject', r.subject), jsonb_build_array('Type', initcap(replace(r.subject_type, '_', ' '))),
          case when r.subject_type = 'balance_certificate' then jsonb_build_array('Amount Due (PHP)', to_char(r.balance_due, 'FM999,999,999,990.00')) end,
          jsonb_build_array('Status', upper(r.status)), jsonb_build_array('Approved By', coalesce(r.approved_by_name, '—')))) f where f <> 'null'::jsonb));
    end if;
    select v.*, pc.name as company, pa.account_name, pa.account_number, pa.bank_name
      into r from public.pay_vouchers v join public.pay_companies pc on pc.id = v.company_id left join public.pay_accounts pa on pa.id = v.account_id
      where upper(v.voucher_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Payment Voucher', 'number', r.voucher_no, 'status', 'paid',
        'fields', (select jsonb_agg(f) from jsonb_array_elements(jsonb_build_array(
          jsonb_build_array('Voucher No', r.voucher_no), jsonb_build_array('Paid To', r.company),
          jsonb_build_array('Account', coalesce(r.account_name || ' ' || coalesce(r.account_number, '') || ' ' || coalesce(r.bank_name, ''), '—')),
          jsonb_build_array('Date', to_char(r.pay_date, 'DD Mon YYYY')),
          case when r.amount_php is not null then jsonb_build_array('Amount (PHP)', to_char(r.amount_php, 'FM999,999,999,990.00')) end,
          case when r.exchange_rate is not null then jsonb_build_array('Exchange Rate', to_char(r.exchange_rate, 'FM999,990.0000')) end,
          case when r.amount_bdt is not null then jsonb_build_array('Amount (BDT)', to_char(r.amount_bdt, 'FM999,999,999,990.00')) end,
          jsonb_build_array('Issued By', coalesce(r.created_by_name, '—')))) f where f <> 'null'::jsonb));
    end if;
    select s.*, e.first_name, e.last_name, e.employee_no, e.position
      into r from public.payslips s join public.employees e on e.id = s.employee_id where upper(s.payslip_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Payslip', 'number', r.payslip_no, 'status', 'paid',
        'fields', jsonb_build_array(
          jsonb_build_array('Payslip No', r.payslip_no), jsonb_build_array('Employee', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Employee No', r.employee_no), jsonb_build_array('Type', initcap(r.pay_type)),
          jsonb_build_array('Period', to_char(r.period_month, 'FMMonth YYYY')), jsonb_build_array('Pay Date', to_char(r.pay_date, 'DD Mon YYYY')),
          jsonb_build_array('Net Pay (PHP)', to_char(r.net_pay, 'FM999,999,999,990.00'))));
    end if;
    select * into r from public.job_applications j where upper(j.application_no) = c or upper(j.approval_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Job Application', 'number', r.application_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Application No', r.application_no), jsonb_build_array('Applicant', r.full_name),
          jsonb_build_array('Position', r.position_title), jsonb_build_array('Company', r.company_name),
          jsonb_build_array('Submitted', to_char(r.created_at, 'DD Mon YYYY')), jsonb_build_array('Status', upper(r.status)),
          jsonb_build_array('Approval No', coalesce(r.approval_no, '—'))));
    end if;
    select * into r from public.employees e where upper(e.employee_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Employee', 'number', r.employee_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Employee No', r.employee_no), jsonb_build_array('Name', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Position', coalesce(r.position, '—')), jsonb_build_array('Status', upper(r.status))));
    end if;
    select * into r from public.projects p where upper(p.project_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Project', 'number', r.project_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Project No', r.project_no), jsonb_build_array('Title', r.title),
          jsonb_build_array('Total Cost (PHP)', to_char(r.total_cost, 'FM999,999,999,990.00')), jsonb_build_array('Status', upper(r.status))));
    end if;
    select x.*, p.project_no, p.title into r from public.project_payments x join public.projects p on p.id = x.project_id where upper(x.payment_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Project Payment', 'number', r.payment_no, 'status', 'paid',
        'fields', jsonb_build_array(
          jsonb_build_array('Payment No', r.payment_no), jsonb_build_array('Project', r.project_no || ' — ' || r.title),
          jsonb_build_array('Date', to_char(r.pay_date, 'DD Mon YYYY')), jsonb_build_array('Amount (PHP)', to_char(r.amount, 'FM999,999,999,990.00')),
          jsonb_build_array('Received By', r.received_by)));
    end if;
    select * into r from public.documents d where upper(d.doc_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Document', 'number', r.doc_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Document No', r.doc_no), jsonb_build_array('Party', r.party_name),
          jsonb_build_array('Date', to_char(r.doc_date, 'DD Mon YYYY')), jsonb_build_array('Amount (PHP)', to_char(r.amount, 'FM999,999,999,990.00')),
          jsonb_build_array('Status', upper(r.status))));
    end if;
  end loop;
  return jsonb_build_object('found', false, 'code', raw);
end;
$$;
grant execute on function public.verify_record(text) to anon, authenticated;
