-- =====================================================================
-- EMON OVERRUNS E-PORTAL — Update 1.2
-- Orders for customers, employees and billing companies. Every order is carried out as soon as the CEO
-- approves it; there is no verification code any more.
-- Run once in the Supabase SQL Editor after 004_update_1_1.sql. It is safe to run again.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Employees can be suspended: the login is closed until an order reactivates them.
-- ---------------------------------------------------------------------
alter table public.employees drop constraint if exists employees_status_check;
alter table public.employees add constraint employees_status_check check (status in ('waiting','active','inactive','suspended','terminated'));

create or replace function public.employees_sync_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.profile_id is not null then
    update public.profiles set
      role = new.role,
      modules = new.modules,
      full_name = case when lower(email) = 'emonoverruns@gmail.com' then 'EMON OVERRUNS' else trim(new.first_name || ' ' || new.last_name) end,
      status = case when new.status in ('inactive','suspended','terminated') then 'disabled' else 'active' end
    where id = new.profile_id;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Billing companies can be suspended: no new payment vouchers until an order reactivates them.
-- ---------------------------------------------------------------------
alter table public.pay_companies add column if not exists status text not null default 'active';
alter table public.pay_companies add column if not exists status_note text;
alter table public.pay_companies drop constraint if exists pay_companies_status_check;
alter table public.pay_companies add constraint pay_companies_status_check check (status in ('active','suspended'));

create or replace function public.pay_companies_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.status := 'active';
  new.status_note := null;
  new.created_by := auth.uid();
  new.created_by_name := (select full_name from public.profiles where id = auth.uid());
  return new;
end;
$$;

create or replace function public.pay_vouchers_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.pay_companies c where c.id = new.company_id and c.status <> 'active') then
    raise exception 'This company is SUSPENDED. New payments are blocked until it is reactivated by an approved order';
  end if;
  if new.account_id is not null and not exists (select 1 from public.pay_accounts a where a.id = new.account_id and a.company_id = new.company_id) then
    raise exception 'That account belongs to a different company';
  end if;
  new.voucher_no := 'BD' || to_char(new.pay_date, 'YYYYMMDD') || lpad(public.next_counter('BD' || to_char(new.pay_date, 'YYYYMMDD'))::text, 3, '0');
  new.created_by := auth.uid();
  new.created_by_name := (select full_name from public.profiles where id = auth.uid());
  return new;
end;
$$;

-- The totals view lists every company column, so it is made again to include the status.
drop view if exists public.pay_company_totals;
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

-- ---------------------------------------------------------------------
-- Order letters: for one customer, employee or billing company
--   customer: suspension, closure, reactivation, reopen, unpaid, installment, unsettled balance, promise to pay, other
--   employee: suspension, reactivation, termination, memo
--   company:  suspension, reactivation, memo
-- ---------------------------------------------------------------------
alter table public.order_letters add column if not exists employee_id uuid references public.employees(id) on delete set null;
alter table public.order_letters add column if not exists company_id uuid references public.pay_companies(id) on delete set null;
create index if not exists order_letters_employee_idx on public.order_letters(employee_id);
create index if not exists order_letters_company_idx on public.order_letters(company_id);
alter table public.order_letters drop constraint if exists order_letters_subject_type_check;
alter table public.order_letters add constraint order_letters_subject_type_check check (subject_type in
  ('suspension','closure','reactivation','reopen','termination','memo','unpaid','installment','unsettled_balance','promise_to_pay','other'));
alter table public.order_letters drop constraint if exists order_letters_one_subject;
alter table public.order_letters add constraint order_letters_one_subject check (num_nonnulls(customer_id, employee_id, company_id) <= 1);

create or replace function public.order_letters_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare kind text;
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
  new.order_no := 'ORDER-' || to_char(new.order_date, 'YYYY') || '-' || lpad(public.next_counter('ORDER' || to_char(new.order_date, 'YYYY'))::text, 3, '0');
  new.status := 'pending';
  new.approved_by := null; new.approved_by_name := null; new.approved_at := null;
  new.applied_by_name := null; new.applied_at := null; new.applied_result := null;
  new.created_by := auth.uid();
  new.created_by_name := (select full_name from public.profiles where id = auth.uid());
  return new;
end;
$$;

-- Customer orders are seen by everyone signed in (as before) and requested by order-letter or customer staff.
-- Employee orders: the CEO and HR staff, and the employee once approved. Company orders: the CEO and billing staff.
drop policy if exists "ol: read" on public.order_letters;
drop policy if exists "ol: insert" on public.order_letters;
create policy "ol: read" on public.order_letters for select to authenticated using (
  (employee_id is null and company_id is null and (select public.is_active()))
  or (employee_id is not null and ((select public.is_admin()) or (select public.has_module('employees'))
      or (status in ('approved','applied') and exists (select 1 from public.employees e where e.id = employee_id and e.profile_id = (select auth.uid())))))
  or (company_id is not null and ((select public.is_admin()) or (select public.has_module('billing')))));
create policy "ol: insert" on public.order_letters for insert to authenticated with check (
  (customer_id is not null and ((select public.can_write('orders')) or (select public.can_write('customers'))))
  or (employee_id is not null and (select public.can_write('employees')))
  or (company_id is not null and (select public.can_write('billing'))));

-- Internal: carry out an approved order on its customer, employee or company.
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
      update public.customers set status = newst, status_note = o.order_no || ': ' || o.subject where id = c.id;
      res := 'Account ' || c.account_no || ' is now ' || upper(newst);
    else
      res := 'Order recorded on account ' || c.account_no;
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

-- The CEO approves (the order is carried out at once) or rejects.
create or replace function public.review_order_letter(p_id uuid, p_action text, p_note text default null) returns public.order_letters
language plpgsql security definer set search_path = '' as $$
declare o public.order_letters; me text; r jsonb;
begin
  if not public.is_admin() then raise exception 'Only the CEO can approve orders'; end if;
  select * into o from public.order_letters where id = p_id for update;
  if o.id is null then raise exception 'Order not found'; end if;
  if o.status <> 'pending' then raise exception 'This order is already %', upper(o.status); end if;
  me := (select full_name from public.profiles where id = auth.uid());
  perform public.allow_record_change();
  if p_action = 'approve' then
    update public.order_letters set status = 'approved', approved_by = auth.uid(), approved_by_name = me, approved_at = now(), review_note = p_note
    where id = p_id returning * into o;
    r := public.carry_out_order(p_id);
    select * into o from public.order_letters where id = p_id;
    if o.created_by is distinct from auth.uid() then
      perform public.notify_user(o.created_by, 'Order ' || o.order_no || ' approved and carried out', r->>'result', 'order/' || o.id);
    end if;
  elsif p_action = 'reject' then
    update public.order_letters set status = 'rejected', approved_by = auth.uid(), approved_by_name = me, approved_at = now(), review_note = p_note
    where id = p_id returning * into o;
    perform public.notify_user(o.created_by, 'Order ' || o.order_no || ' rejected', coalesce(p_note, o.subject), 'order/' || o.id);
  else
    raise exception 'Unknown action %', p_action;
  end if;
  return o;
end;
$$;
revoke execute on function public.review_order_letter(uuid, text, text) from public, anon;
grant execute on function public.review_order_letter(uuid, text, text) to authenticated;

-- Order letters no longer carry a verification code.
drop function if exists public.apply_order_letter(text, text, uuid);

-- ---------------------------------------------------------------------
-- The CEO's permanent delete: an employee or company with order letters is deleted after its letters.
-- ---------------------------------------------------------------------
create or replace function public.delete_record(p_table text, p_id uuid) returns text[]
language plpgsql security definer set search_path = '' as $$
declare
  j jsonb;
  own_type text;
  paths text[];
  cust uuid;
  since date;
  subs uuid[] := '{}';
begin
  if not public.is_admin() then raise exception 'Only the CEO can delete records'; end if;
  if not public.deletable_table(p_table) then raise exception 'This kind of record cannot be deleted'; end if;
  execute format('select to_jsonb(t) from public.%I t where t.id = $1 for update', p_table) into j using p_id;
  if j is null then raise exception 'Record not found'; end if;
  if p_table = 'customers' and (exists (select 1 from public.customer_invoices x where x.customer_id = p_id)
      or exists (select 1 from public.payments_received x where x.customer_id = p_id)
      or exists (select 1 from public.credit_memos x where x.customer_id = p_id)
      or exists (select 1 from public.order_letters x where x.customer_id = p_id)) then
    raise exception 'This customer has invoices, payments, credit memos or order letters. Delete those first';
  end if;
  if p_table = 'customer_invoices' and exists (select 1 from public.payments_received x where x.invoice_id = p_id) then
    raise exception 'This invoice has payments. Delete its payments first';
  end if;
  if p_table = 'employees' then
    if (j->>'profile_id')::uuid = auth.uid() then raise exception 'You cannot delete your own employee record'; end if;
    if exists (select 1 from public.payslips x where x.employee_id = p_id) then raise exception 'This employee has payslips. Delete the payslips first'; end if;
    if exists (select 1 from public.order_letters x where x.employee_id = p_id) then raise exception 'This employee has order letters. Delete the order letters first'; end if;
  end if;
  if p_table = 'projects' and exists (select 1 from public.project_payments x where x.project_id = p_id) then
    raise exception 'This project has payments. Delete its payments first';
  end if;
  if p_table = 'pay_companies' and exists (select 1 from public.pay_vouchers x where x.company_id = p_id) then
    raise exception 'This company has payment vouchers. Delete the vouchers first';
  end if;
  if p_table = 'pay_companies' and exists (select 1 from public.order_letters x where x.company_id = p_id) then
    raise exception 'This company has order letters. Delete the order letters first';
  end if;
  if p_table = 'pay_accounts' and exists (select 1 from public.pay_vouchers x where x.account_id = p_id) then
    raise exception 'This account has payment vouchers. Delete the vouchers first';
  end if;
  perform public.allow_record_change();

  -- Files: the record's own, a customer's statement copies, a company's account files, and stored photos.
  own_type := case p_table when 'customers' then 'customer' when 'customer_invoices' then 'invoice' when 'payments_received' then 'payment'
    when 'credit_memos' then 'credit_memo' when 'employees' then 'employee' when 'payslips' then 'payslip' when 'projects' then 'project'
    when 'project_payments' then 'project_payment' when 'pay_companies' then 'pay_company' when 'pay_accounts' then 'pay_account'
    when 'pay_vouchers' then 'pay_voucher' when 'job_applications' then 'job_application' when 'order_letters' then 'order_letter' end;
  if p_table = 'customers' then subs := array(select s.id from public.statements s where s.customer_id = p_id); end if;
  if p_table = 'pay_companies' then subs := array(select a.id from public.pay_accounts a where a.company_id = p_id); end if;
  select coalesce(array_agg(a.storage_path), '{}') into paths from public.attachments a
    where (a.owner_type = own_type and a.owner_id = p_id) or a.owner_id = any(subs);
  delete from public.attachments a where (a.owner_type = own_type and a.owner_id = p_id) or a.owner_id = any(subs);
  if j->>'photo_path' is not null then paths := paths || (j->>'photo_path'); end if;

  -- A customer money record changes the statements of account from its month on.
  if p_table in ('customer_invoices','payments_received','credit_memos') then
    cust := (j->>'customer_id')::uuid;
    since := date_trunc('month', case p_table when 'customer_invoices' then (j->>'invoice_date')::date
               when 'payments_received' then (j->>'paid_date')::date
               else coalesce((j->>'approved_at')::timestamptz::date, (j->>'memo_date')::date) end)::date;
  end if;
  if p_table = 'employees' and j->>'profile_id' is not null then
    update public.profiles set status = 'disabled' where id = (j->>'profile_id')::uuid;
  end if;

  delete from public.change_requests where target_table = p_table and target_id = p_id;
  delete from public.record_changes where target_table = p_table and target_id = p_id;
  execute format('delete from public.%I where id = $1', p_table) using p_id;

  if cust is not null then
    select paths || coalesce(array_agg(a.storage_path), '{}') into paths from public.attachments a
      where a.owner_type = 'statement' and a.owner_id in (select s.id from public.statements s where s.customer_id = cust and s.period_end >= since);
    delete from public.attachments a
      where a.owner_type = 'statement' and a.owner_id in (select s.id from public.statements s where s.customer_id = cust and s.period_end >= since);
    delete from public.statements s where s.customer_id = cust and s.period_end >= since;
    perform public.generate_statements(cust);
  end if;
  return paths;
end;
$$;

-- ---------------------------------------------------------------------
-- Public verification: an order letter shows its customer, employee or company.
-- ---------------------------------------------------------------------
create or replace function public.verify_record(p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  raw text := trim(coalesce(p_code, ''));
  cands text[];
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
  foreach c in array cands loop
    -- customer account (account no, application no or public ID)
    select * into r from public.customers cu where upper(cu.account_no) = c or upper(cu.application_no) = c or upper(cu.public_id) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Customer Account', 'number', r.account_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Account Name', r.first_name || ' ' || r.last_name), jsonb_build_array('Account No', r.account_no),
          jsonb_build_array('Application No', r.application_no), jsonb_build_array('Public ID', r.public_id),
          jsonb_build_array('Opened', to_char(r.application_date, 'DD Mon YYYY')), jsonb_build_array('Account Status', upper(r.status))));
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
        'fields', jsonb_build_array(
          jsonb_build_array('Order No', r.order_no), jsonb_build_array('Date', to_char(r.order_date, 'DD Mon YYYY')),
          jsonb_build_array(case when r.employee_id is not null then 'Employee' when r.company_id is not null then 'Company' else 'Account' end,
            coalesce(r.first_name || ' ' || r.last_name || ' (' || r.acct || ')', r.em_first || ' ' || r.em_last || ' (' || r.em_no || ')', r.co_name, '—')),
          jsonb_build_array('Subject', r.subject), jsonb_build_array('Type', initcap(replace(r.subject_type, '_', ' '))),
          jsonb_build_array('Status', upper(r.status)), jsonb_build_array('Approved By', coalesce(r.approved_by_name, '—'))));
    end if;
    select v.*, pc.name as company, pa.account_name, pa.account_number, pa.bank_name
      into r from public.pay_vouchers v join public.pay_companies pc on pc.id = v.company_id left join public.pay_accounts pa on pa.id = v.account_id
      where upper(v.voucher_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Payment Voucher', 'number', r.voucher_no, 'status', 'paid',
        'fields', jsonb_build_array(
          jsonb_build_array('Voucher No', r.voucher_no), jsonb_build_array('Paid To', r.company),
          jsonb_build_array('Account', coalesce(r.account_name || ' ' || coalesce(r.account_number, '') || ' ' || coalesce(r.bank_name, ''), '—')),
          jsonb_build_array('Date', to_char(r.pay_date, 'DD Mon YYYY')),
          jsonb_build_array('Amount (PHP)', to_char(r.amount_php, 'FM999,999,999,990.00')),
          jsonb_build_array('Exchange Rate', to_char(r.exchange_rate, 'FM999,990.0000')),
          jsonb_build_array('Amount (BDT)', to_char(r.amount_bdt, 'FM999,999,999,990.00')),
          jsonb_build_array('Issued By', coalesce(r.created_by_name, '—'))));
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
