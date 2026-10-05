-- =====================================================================
-- EMON OVERRUNS E-PORTAL — Update 1.5
-- Customers: a changed or removed photo also leaves the customer's Files.
-- Order letters: "Additional Charge". When it is approved, its amount is added to the customer's balance and
-- shows on the profile and in the Statement of Account, with the order number as the reference.
-- Run once in the Supabase SQL Editor after 007_update_1_4.sql. It is safe to run again.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Customer photo: the old photo also leaves Files
-- ---------------------------------------------------------------------
create or replace function public.set_customer_photo(p_id uuid, p_path text) returns void
language plpgsql security definer set search_path = '' as $$
declare old text;
begin
  if not public.can_write('customers') then raise exception 'You do not have permission to change the customer photo'; end if;
  if p_path is not null and p_path !~ ('^customer/' || p_id::text || '/') then raise exception 'Invalid photo'; end if;
  select c.photo_path into old from public.customers c where c.id = p_id for update;
  if not found then raise exception 'Customer not found'; end if;
  if old is not distinct from p_path then return; end if;
  perform public.allow_record_change();
  update public.customers set photo_path = p_path where id = p_id;
  -- The old photo is no longer listed in the customer's Files.
  if old is not null then
    delete from public.attachments a where a.owner_type = 'customer' and a.owner_id = p_id and a.kind = 'photo' and a.storage_path = old;
  end if;
  insert into public.customer_events (customer_id, action, actor, actor_name)
  values (p_id, case when p_path is null then 'photo removed' when old is null then 'photo added' else 'photo changed' end,
          auth.uid(), (select full_name from public.profiles where id = auth.uid()));
end;
$$;
revoke execute on function public.set_customer_photo(uuid, text) from public, anon;
grant execute on function public.set_customer_photo(uuid, text) to authenticated;
-- Photos changed or removed before this update leave Files too.
do $$
begin
  perform set_config('eo.allow_change', 'on', true);
  delete from public.attachments a using public.customers c
  where a.owner_type = 'customer' and a.owner_id = c.id and a.kind = 'photo' and a.storage_path is distinct from c.photo_path;
end $$;

-- ---------------------------------------------------------------------
-- Order letters: Additional Charge (customers). The approved charge is added to the balance.
-- ---------------------------------------------------------------------
alter table public.order_letters drop constraint if exists order_letters_subject_type_check;
alter table public.order_letters add constraint order_letters_subject_type_check check (subject_type in
  ('suspension','closure','reactivation','reopen','termination','memo','unpaid','installment','unsettled_balance','promise_to_pay','balance_certificate','charge','other'));

-- What a customer owes: invoices and approved charges, less payments and approved credit/discount memos.
create or replace view public.customer_balances with (security_invoker = true) as
  select c.id as customer_id,
    coalesce((select sum(total_amount) from public.customer_invoices i where i.customer_id = c.id), 0)::numeric(14,2) as total_invoiced,
    coalesce((select sum(amount) from public.payments_received p where p.customer_id = c.id), 0)::numeric(14,2) as total_paid,
    coalesce((select sum(request_amount) from public.credit_memos m where m.customer_id = c.id and m.status in ('approved','paid') and m.requested_action in ('credit','discount')), 0)::numeric(14,2) as total_credits,
    (coalesce((select sum(total_amount) from public.customer_invoices i where i.customer_id = c.id), 0)
      + coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = c.id and o.subject_type = 'charge' and o.status = 'applied'), 0)
      - coalesce((select sum(amount) from public.payments_received p where p.customer_id = c.id), 0)
      - coalesce((select sum(request_amount) from public.credit_memos m where m.customer_id = c.id and m.status in ('approved','paid') and m.requested_action in ('credit','discount')), 0))::numeric(14,2) as balance_due,
    coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = c.id and o.subject_type = 'charge' and o.status = 'applied'), 0)::numeric(14,2) as total_charges
  from public.customers c;

-- Balance of a customer before a date (for the statements): charges count from the day they were added.
create or replace function public.balance_before(p_customer uuid, p_date date) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce((select sum(total_amount) from public.customer_invoices where customer_id = p_customer and invoice_date < p_date), 0)
       + coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = p_customer and o.subject_type = 'charge' and o.status = 'applied'
                   and o.applied_at::date < p_date), 0)
       - coalesce((select sum(amount) from public.payments_received where customer_id = p_customer and paid_date < p_date), 0)
       - coalesce((select sum(request_amount) from public.credit_memos where customer_id = p_customer and status in ('approved','paid')
                   and requested_action in ('credit','discount') and approved_at::date < p_date), 0);
$$;
revoke execute on function public.balance_before(uuid, date) from public, anon;
grant execute on function public.balance_before(uuid, date) to authenticated;

-- Monthly statements: the month's debit includes the charges added that month.
create or replace function public.generate_statements(p_customer uuid default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  c record;
  m date;
  first_m date;
  last_m date := (date_trunc('month', current_date) - interval '1 month')::date;
  stop_m date;
  nxt date;
  op numeric; deb numeric; cre numeric;
  made integer := 0;
begin
  if auth.uid() is not null and not public.is_active() then raise exception 'Not allowed'; end if;
  for c in select * from public.customers cu where cu.status in ('active','suspended','closed') and (p_customer is null or cu.id = p_customer) loop
    first_m := date_trunc('month', least(
      c.application_date,
      coalesce((select min(invoice_date) from public.customer_invoices where customer_id = c.id), c.application_date),
      coalesce((select min(paid_date) from public.payments_received where customer_id = c.id), c.application_date)))::date;
    stop_m := last_m;
    if c.status = 'closed' then
      stop_m := least(last_m, coalesce((select date_trunc('month', max(created_at))::date from public.customer_events
                                        where customer_id = c.id and (action = 'close' or action like 'closed by %')), last_m));
    end if;
    m := first_m;
    while m <= stop_m loop
      nxt := (m + interval '1 month')::date;
      if not exists (select 1 from public.statements s where s.customer_id = c.id and s.period_start = m) then
        op := public.balance_before(c.id, m);
        deb := coalesce((select sum(total_amount) from public.customer_invoices where customer_id = c.id and invoice_date >= m and invoice_date < nxt), 0)
             + coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = c.id and o.subject_type = 'charge' and o.status = 'applied'
                          and o.applied_at::date >= m and o.applied_at::date < nxt), 0);
        cre := coalesce((select sum(amount) from public.payments_received where customer_id = c.id and paid_date >= m and paid_date < nxt), 0)
             + coalesce((select sum(request_amount) from public.credit_memos where customer_id = c.id and status in ('approved','paid')
                          and requested_action in ('credit','discount') and approved_at::date >= m and approved_at::date < nxt), 0);
        insert into public.statements (statement_no, customer_id, period_start, period_end, opening_balance, total_debit, total_credit, closing_balance)
        values ('SOA-' || to_char(m, 'YYYYMM') || '-' || c.account_no, c.id, m, (nxt - 1), op, deb, cre, op + deb - cre);
        made := made + 1;
      end if;
      m := nxt;
    end loop;
  end loop;
  return made;
end;
$$;
revoke execute on function public.generate_statements(uuid) from public, anon;
grant execute on function public.generate_statements(uuid) to authenticated;

-- Amount due and days overdue: charges are paid in date order together with the invoices.
create or replace function public.account_due(p_customer uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with paid as (
    select coalesce((select sum(p.amount) from public.payments_received p where p.customer_id = p_customer), 0)
         + coalesce((select sum(m.request_amount) from public.credit_memos m where m.customer_id = p_customer and m.status in ('approved','paid')
                       and m.requested_action in ('credit','discount')), 0) as total
  ), inv as (
    select x.invoice_no, x.invoice_date, sum(x.amount) over (order by x.invoice_date, x.at, x.invoice_no) as running
    from (select i.invoice_no, i.invoice_date, i.created_at as at, i.total_amount as amount from public.customer_invoices i where i.customer_id = p_customer
          union all
          select o.order_no, o.applied_at::date, o.applied_at, o.amount from public.order_letters o
          where o.customer_id = p_customer and o.subject_type = 'charge' and o.status = 'applied') x
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
  if new.subject_type = 'charge' and coalesce(new.amount, 0) <= 0 then
    raise exception 'Enter the charge amount';
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
    if o.subject_type = 'charge' and c.status not in ('active','suspended') then raise exception 'Account % is % — a charge cannot be added', c.account_no, upper(c.status); end if;
    if newst is not null then
      update public.customers set status = newst, status_note = o.order_no || ': ' || o.subject || coalesce(' — ' || o.closure_reason, '') where id = c.id;
      res := 'Account ' || c.account_no || ' is now ' || upper(newst);
    else
      res := case when o.subject_type = 'balance_certificate'
        then 'Account Balance Certificate issued for account ' || c.account_no || ' — PHP ' || to_char(coalesce(o.balance_due, 0), 'FM999,999,999,990.00') || ' due'
        when o.subject_type = 'charge'
        then 'Charge of PHP ' || to_char(o.amount, 'FM999,999,999,990.00') || ' added to account ' || c.account_no || ' — new balance PHP '
          || to_char(coalesce((select b.balance_due from public.customer_balances b where b.customer_id = c.id), 0) + o.amount, 'FM999,999,999,990.00')
        else 'Order recorded on account ' || c.account_no end;
    end if;
    insert into public.customer_events (customer_id, action, note, actor, actor_name)
    values (c.id, case o.subject_type when 'reopen' then 'reopened' when 'charge' then 'charge PHP ' || to_char(o.amount, 'FM999,999,999,990.00')
                  else coalesce(newst, replace(o.subject_type, '_', ' ')) end || ' by ' || o.order_no, o.subject, auth.uid(), me);
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

-- Verification: an Additional Charge order shows its amount.
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
          case when r.subject_type = 'charge' then jsonb_build_array('Charge (PHP)', to_char(r.amount, 'FM999,999,999,990.00')) end,
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
