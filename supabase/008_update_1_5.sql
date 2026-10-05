-- =====================================================================
-- EMON OVERRUNS E-PORTAL — Update 1.5
-- Customers: a changed or removed photo also leaves the customer's Files.
-- Order letters: "Additional Charge" and "Settlement Adjustment". When approved, a charge is added to the customer's
-- balance; a settlement adjustment is added to it or taken off it (chosen on the order). Both show on the profile and
-- in the Statement of Account, with the order number as the reference.
-- Deleting an order letter (CEO) also undoes it: the status before the order comes back, and a charge or
-- adjustment leaves the balance and the statements.
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
-- Order letters: Additional Charge and Settlement Adjustment (customers). Once approved:
--   charge                      → added to the balance (debit)
--   settlement, adjust 'add'    → added to the balance (debit)
--   settlement, adjust 'reduce' → taken off the balance (credit)
-- ---------------------------------------------------------------------
alter table public.order_letters add column if not exists adjust_type text;
-- The status (and note) a customer, employee or company had before the order changed it, so deleting it can undo it.
alter table public.order_letters add column if not exists prev_status text;
alter table public.order_letters add column if not exists prev_note text;
alter table public.order_letters drop constraint if exists order_letters_adjust_type_check;
alter table public.order_letters add constraint order_letters_adjust_type_check check (adjust_type is null or adjust_type in ('add','reduce'));
alter table public.order_letters drop constraint if exists order_letters_subject_type_check;
alter table public.order_letters add constraint order_letters_subject_type_check check (subject_type in
  ('suspension','closure','reactivation','reopen','termination','memo','unpaid','installment','unsettled_balance','promise_to_pay','balance_certificate',
   'charge','settlement','other'));

-- What a customer owes: invoices, approved Additional Charges and Settlement Adjustments that add, less payments,
-- approved credit/discount memos and Settlement Adjustments that take money off.
-- total_charges = Additional Charges; total_settlement = Settlement Adjustments (added minus taken off).
create or replace view public.customer_balances with (security_invoker = true) as
  select c.id as customer_id,
    coalesce((select sum(total_amount) from public.customer_invoices i where i.customer_id = c.id), 0)::numeric(14,2) as total_invoiced,
    coalesce((select sum(amount) from public.payments_received p where p.customer_id = c.id), 0)::numeric(14,2) as total_paid,
    coalesce((select sum(request_amount) from public.credit_memos m where m.customer_id = c.id and m.status in ('approved','paid') and m.requested_action in ('credit','discount')), 0)::numeric(14,2) as total_credits,
    (coalesce((select sum(total_amount) from public.customer_invoices i where i.customer_id = c.id), 0)
      + coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = c.id and o.status = 'applied' and (o.subject_type = 'charge' or (o.subject_type = 'settlement' and o.adjust_type = 'add'))), 0)
      - coalesce((select sum(amount) from public.payments_received p where p.customer_id = c.id), 0)
      - coalesce((select sum(request_amount) from public.credit_memos m where m.customer_id = c.id and m.status in ('approved','paid') and m.requested_action in ('credit','discount')), 0)
      - coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = c.id and o.status = 'applied' and o.subject_type = 'settlement' and o.adjust_type = 'reduce'), 0))::numeric(14,2) as balance_due,
    coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = c.id and o.status = 'applied' and o.subject_type = 'charge'), 0)::numeric(14,2) as total_charges,
    coalesce((select sum(case o.adjust_type when 'reduce' then -o.amount else o.amount end) from public.order_letters o
              where o.customer_id = c.id and o.status = 'applied' and o.subject_type = 'settlement'), 0)::numeric(14,2) as total_settlement
  from public.customers c;

-- Balance of a customer before a date (for the statements): order charges and adjustments count from the day
-- they were carried out.
create or replace function public.balance_before(p_customer uuid, p_date date) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce((select sum(total_amount) from public.customer_invoices where customer_id = p_customer and invoice_date < p_date), 0)
       + coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = p_customer and o.status = 'applied' and (o.subject_type = 'charge' or (o.subject_type = 'settlement' and o.adjust_type = 'add')) and o.applied_at::date < p_date), 0)
       - coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = p_customer and o.status = 'applied' and o.subject_type = 'settlement' and o.adjust_type = 'reduce' and o.applied_at::date < p_date), 0)
       - coalesce((select sum(amount) from public.payments_received where customer_id = p_customer and paid_date < p_date), 0)
       - coalesce((select sum(request_amount) from public.credit_memos where customer_id = p_customer and status in ('approved','paid')
                   and requested_action in ('credit','discount') and approved_at::date < p_date), 0);
$$;
revoke execute on function public.balance_before(uuid, date) from public, anon;
grant execute on function public.balance_before(uuid, date) to authenticated;

-- Monthly statements: the month's debit includes the order charges and added adjustments of that month; its credit
-- the adjustments taken off.
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
             + coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = c.id and o.status = 'applied' and (o.subject_type = 'charge' or (o.subject_type = 'settlement' and o.adjust_type = 'add'))
                          and o.applied_at::date >= m and o.applied_at::date < nxt), 0);
        cre := coalesce((select sum(amount) from public.payments_received where customer_id = c.id and paid_date >= m and paid_date < nxt), 0)
             + coalesce((select sum(request_amount) from public.credit_memos where customer_id = c.id and status in ('approved','paid')
                          and requested_action in ('credit','discount') and approved_at::date >= m and approved_at::date < nxt), 0)
             + coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = c.id and o.status = 'applied' and o.subject_type = 'settlement' and o.adjust_type = 'reduce'
                          and o.applied_at::date >= m and o.applied_at::date < nxt), 0);
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

-- Amount due and days overdue: charges and added adjustments are paid in date order together with the invoices;
-- adjustments taken off count like payments.
create or replace function public.account_due(p_customer uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with paid as (
    select coalesce((select sum(p.amount) from public.payments_received p where p.customer_id = p_customer), 0)
         + coalesce((select sum(m.request_amount) from public.credit_memos m where m.customer_id = p_customer and m.status in ('approved','paid')
                       and m.requested_action in ('credit','discount')), 0)
         + coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = p_customer and o.status = 'applied' and o.subject_type = 'settlement' and o.adjust_type = 'reduce'), 0) as total
  ), inv as (
    select x.invoice_no, x.invoice_date, sum(x.amount) over (order by x.invoice_date, x.at, x.invoice_no) as running
    from (select i.invoice_no, i.invoice_date, i.created_at as at, i.total_amount as amount from public.customer_invoices i where i.customer_id = p_customer
          union all
          select o.order_no, o.applied_at::date, o.applied_at, o.amount from public.order_letters o
          where o.customer_id = p_customer and o.status = 'applied' and (o.subject_type = 'charge' or (o.subject_type = 'settlement' and o.adjust_type = 'add'))) x
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
  if new.subject_type = 'settlement' then
    if coalesce(new.amount, 0) <= 0 then raise exception 'Enter the adjustment amount'; end if;
    if coalesce(new.adjust_type, '') not in ('add','reduce') then raise exception 'Choose whether the adjustment adds to the balance or takes it off'; end if;
  else
    new.adjust_type := null;
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
  prev_st text;
  prev_nt text;
  me text := (select full_name from public.profiles where id = auth.uid());
begin
  select * into o from public.order_letters where id = p_id for update;
  perform public.allow_record_change();
  if o.customer_id is not null then
    select * into c from public.customers where id = o.customer_id for update;
    prev_st := c.status; prev_nt := c.status_note;
    newst := case o.subject_type when 'suspension' then 'suspended' when 'closure' then 'closed' when 'reactivation' then 'active' when 'reopen' then 'active' else null end;
    if o.subject_type = 'suspension' and c.status <> 'active' then raise exception 'Account % is % — only ACTIVE accounts can be suspended', c.account_no, upper(c.status); end if;
    if o.subject_type = 'closure' and c.status not in ('active','suspended') then raise exception 'Account % is % and cannot be closed', c.account_no, upper(c.status); end if;
    if o.subject_type = 'reactivation' and c.status <> 'suspended' then raise exception 'Account % is % — only SUSPENDED accounts can be reactivated', c.account_no, upper(c.status); end if;
    if o.subject_type = 'reopen' and c.status <> 'closed' then raise exception 'Account % is % — only CLOSED accounts can be reopened', c.account_no, upper(c.status); end if;
    if o.subject_type = 'charge' and c.status not in ('active','suspended') then raise exception 'Account % is % — a charge cannot be added', c.account_no, upper(c.status); end if;
    if o.subject_type = 'settlement' and c.status not in ('active','suspended','closed') then raise exception 'Account % is % — no settlement adjustment can be made', c.account_no, upper(c.status); end if;
    if newst is not null then
      update public.customers set status = newst, status_note = o.order_no || ': ' || o.subject || coalesce(' — ' || o.closure_reason, '') where id = c.id;
      res := 'Account ' || c.account_no || ' is now ' || upper(newst);
    else
      res := case when o.subject_type = 'balance_certificate'
        then 'Account Balance Certificate issued for account ' || c.account_no || ' — PHP ' || to_char(coalesce(o.balance_due, 0), 'FM999,999,999,990.00') || ' due'
        when o.subject_type = 'charge'
        then 'Charge of PHP ' || to_char(o.amount, 'FM999,999,999,990.00') || ' added to account ' || c.account_no || ' — new balance PHP '
          || to_char(coalesce((select b.balance_due from public.customer_balances b where b.customer_id = c.id), 0) + o.amount, 'FM999,999,999,990.00')
        when o.subject_type = 'settlement'
        then 'Settlement adjustment: PHP ' || to_char(o.amount, 'FM999,999,999,990.00') || case o.adjust_type when 'reduce' then ' taken off' else ' added to' end
          || ' account ' || c.account_no || ' — new balance PHP '
          || to_char(coalesce((select b.balance_due from public.customer_balances b where b.customer_id = c.id), 0)
                     + case o.adjust_type when 'reduce' then -o.amount else o.amount end, 'FM999,999,999,990.00')
        else 'Order recorded on account ' || c.account_no end;
    end if;
    insert into public.customer_events (customer_id, action, note, actor, actor_name)
    values (c.id, case o.subject_type when 'reopen' then 'reopened' when 'charge' then 'charge PHP ' || to_char(o.amount, 'FM999,999,999,990.00')
                  when 'settlement' then 'settlement adjustment ' || case o.adjust_type when 'reduce' then '−' else '+' end || 'PHP ' || to_char(o.amount, 'FM999,999,999,990.00')
                  else coalesce(newst, replace(o.subject_type, '_', ' ')) end || ' by ' || o.order_no, o.subject, auth.uid(), me);
  elsif o.employee_id is not null then
    select * into e from public.employees where id = o.employee_id for update;
    prev_st := e.status;
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
    prev_st := pc.status; prev_nt := pc.status_note;
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
  update public.order_letters set status = 'applied', applied_at = now(), applied_by_name = me, applied_result = res,
    prev_status = case when newst is not null then prev_st end, prev_note = case when newst is not null then prev_nt end where id = o.id;
  return jsonb_build_object('order_no', o.order_no, 'result', res, 'status', newst);
end;
$$;
revoke execute on function public.carry_out_order(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Deleting an order letter undoes it (the CEO deletes records)
-- ---------------------------------------------------------------------
-- The status an order set: customers suspended / closed / active, employees suspended / terminated / active or
-- waiting (no login yet), companies suspended / active.
create or replace function public.order_set_status(o public.order_letters) returns text[]
language sql stable set search_path = '' as $$
  select case
    when o.subject_type = 'suspension' then array['suspended']
    when o.subject_type = 'closure' then array['closed']
    when o.subject_type = 'termination' then array['terminated']
    when o.subject_type = 'reopen' then array['active']
    when o.subject_type = 'reactivation' and o.employee_id is not null then array['active','waiting']
    when o.subject_type = 'reactivation' then array['active']
  end;
$$;
revoke execute on function public.order_set_status(public.order_letters) from public, anon, authenticated;

-- Undo what an applied order did. A status is put back only when this order is the last one that changed the
-- status of that customer, employee or company, and the status is still the one it set. The status before the
-- order was saved when it was carried out; for older orders it is the status the order before it set, or the
-- first status (active; an employee without a login: waiting).
create or replace function public.undo_order(p_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  o public.order_letters;
  b public.order_letters;
  st text[] := array['suspension','closure','reactivation','reopen','termination'];
  prev text;
  me text := (select full_name from public.profiles where id = auth.uid());
begin
  select * into o from public.order_letters where id = p_id;
  if o.id is null or o.status <> 'applied' or not (o.subject_type = any(st)) then return null; end if;
  if exists (select 1 from public.order_letters x where x.status = 'applied' and x.id <> o.id and x.subject_type = any(st)
             and x.customer_id is not distinct from o.customer_id and x.employee_id is not distinct from o.employee_id
             and x.company_id is not distinct from o.company_id and x.applied_at > o.applied_at) then
    return null;
  end if;
  prev := o.prev_status;
  if prev is null then
    select * into b from public.order_letters x where x.status = 'applied' and x.id <> o.id and x.subject_type = any(st)
      and x.customer_id is not distinct from o.customer_id and x.employee_id is not distinct from o.employee_id
      and x.company_id is not distinct from o.company_id and x.applied_at < o.applied_at
    order by x.applied_at desc limit 1;
    if b.id is not null then prev := (public.order_set_status(b))[1]; end if;
    if prev = 'active' and b.employee_id is not null then
      prev := case when (select e.profile_id from public.employees e where e.id = b.employee_id) is null then 'waiting' else 'active' end;
    end if;
  end if;
  perform public.allow_record_change();
  if o.customer_id is not null then
    update public.customers set status = coalesce(prev, 'active'), status_note = o.prev_note
    where id = o.customer_id and status = any(public.order_set_status(o)) returning status into prev;
    if not found then return null; end if;
    insert into public.customer_events (customer_id, action, note, actor, actor_name)
    values (o.customer_id, o.order_no || ' deleted — status back to ' || upper(prev), o.subject, auth.uid(), me);
  elsif o.employee_id is not null then
    update public.employees set
      status = coalesce(prev, case when profile_id is null then 'waiting' else 'active' end),
      termination_date = case when o.subject_type = 'termination' then null else termination_date end,
      termination_reason = case when o.subject_type = 'termination' then null else termination_reason end
    where id = o.employee_id and status = any(public.order_set_status(o)) returning status into prev;
    if not found then return null; end if;
  elsif o.company_id is not null then
    update public.pay_companies set status = coalesce(prev, 'active'), status_note = o.prev_note
    where id = o.company_id and status = any(public.order_set_status(o)) returning status into prev;
    if not found then return null; end if;
  end if;
  return prev;
end;
$$;
revoke execute on function public.undo_order(uuid) from public, anon, authenticated;
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
  -- An applied order letter is undone: the status before it comes back; a charge or settlement adjustment leaves
  -- the balance, so the statements are made again from its month on.
  if p_table = 'order_letters' and j->>'status' = 'applied' then
    perform public.undo_order(p_id);
    if j->>'subject_type' in ('charge','settlement') and j->>'customer_id' is not null then
      cust := (j->>'customer_id')::uuid;
      since := date_trunc('month', (j->>'applied_at')::timestamptz::date)::date;
    end if;
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
revoke execute on function public.delete_record(text, uuid) from public, anon;
grant execute on function public.delete_record(text, uuid) to authenticated;

-- Verification: an Additional Charge or Settlement Adjustment order shows its amount.
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
          case when r.subject_type = 'settlement' then jsonb_build_array('Settlement Adjustment (PHP)',
            case r.adjust_type when 'reduce' then 'Less ' else 'Add ' end || to_char(r.amount, 'FM999,999,999,990.00')) end,
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
