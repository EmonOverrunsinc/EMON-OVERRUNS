-- =====================================================================
-- EMON OVERRUNS E-PORTAL - ALL DATABASE UPDATES 062 TO 064 IN ONE FILE (versions 3.54 to 3.56)
--   062  the Director edits a COMPLETED customer order (like ARS-2); its invoice changes with it   (062_edit_completed_order.sql)
--   063  PAYROLL: Issue Payslip (unpaid salary), then Pay Salary with the employee's ID card scan    (063_payroll_pay_salary.sql)
--   064  the INVOICE CHARGES THE PCS DELIVERED (batch no + code = the line price); NOT ORDERED boxes: add price (064_charge_as_delivered.sql)
-- Needs RUN_060_TO_061.sql (already run). SAFE TO RUN AGAIN (also if 062 was run before).
-- Paste all of it in Supabase > SQL Editor > New query and press Run. The last lines say: UPDATE 3.56 READY - ...
-- (and above it, each completed order whose invoice changed to the pcs delivered: OR-... PHP old -> new)
-- =====================================================================

-- ===== 062_edit_completed_order.sql =====
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.54: THE DIRECTOR EDITS A COMPLETED CUSTOMER ORDER
-- A COMPLETED order (delivered, with its invoice) can be changed by the Director: Edit on the order page, and its boxes
-- (add, change, remove). Saving it changes its invoice too (boxes, pcs, amount, terms, order date), so the order and the
-- invoice always say the same; the statements of account follow by themselves. Staff cannot change a completed order.
-- The customer of a completed order stays the same, and the amount cannot go below the payments linked to its invoice.
-- Needs RUN_060_TO_061.sql (already run). Paste all of it in Supabase > SQL Editor > New query and press Run.
-- Safe to run again. The last line says: UPDATE 3.54 READY - ...
-- =====================================================================
do $$
declare def text; n text;
  -- save_customer_order: the Director may change a completed order (of an account that is not ACTIVE any more too)
  s_old1 text := 'if o.status not in (''pending'',''approved'') then raise exception ''Order % is % and cannot be changed''';
  s_new1 text := 'if o.status not in (''pending'',''approved'') and not (boss and o.status = ''completed'') then raise exception ''Order % is % and cannot be changed''';
  s_old2 text := 'if c.status <> ''active'' then raise exception ''An order is made only for an ACTIVE account';
  s_new2 text := 'if c.status <> ''active'' and not exists (select 1 from public.customer_orders x where x.id = p_id and x.status = ''completed'' and x.customer_id = c.id) then raise exception ''An order is made only for an ACTIVE account';
  s_old3 text := '  if p_id is null and o.status = ''pending'' then';
  s_new3 text := '  -- 3.54: a completed order changes its invoice too
  if o.status = ''completed'' and o.invoice_id is not null then
    if (select customer_id from public.customer_invoices where id = o.invoice_id) is distinct from o.customer_id then
      raise exception ''Order % is completed: its customer cannot be changed (the invoice is for that customer)'', o.order_no;
    end if;
    if (select coalesce(sum(amount), 0) from public.payment_links where invoice_id = o.invoice_id and removed_at is null) > o.total_amount then
      raise exception ''Payments of PHP % are linked to the invoice of order %: the amount cannot be less than that'',
        to_char((select sum(amount) from public.payment_links where invoice_id = o.invoice_id and removed_at is null), ''FM999,999,990.00''), o.order_no;
    end if;
    perform public.allow_record_change();
    update public.customer_invoices set total_boxes = o.total_boxes, total_pcs = o.total_pcs, total_amount = o.total_amount,
      payment_terms = o.payment_terms, purchase_date = o.order_date where id = o.invoice_id;
    perform set_config(''eo.allow_change'', ''off'', true);
  end if;
  if p_id is null and o.status = ''pending'' then';
  -- the boxes of a completed order: the Director adds, changes and removes them
  b_old1 text := 'if o.status not in (''pending'',''approved'') then raise exception ''Order % is %: boxes cannot be added''';
  b_new1 text := 'if o.status not in (''pending'',''approved'') and not (o.status = ''completed'' and public.is_admin()) then raise exception ''Order % is %: boxes cannot be added''';
  b_old2 text := 'if st not in (''pending'',''approved'') then raise exception ''Order % is %: its boxes cannot be changed''';
  b_new2 text := 'if st not in (''pending'',''approved'') and not (st = ''completed'' and public.is_admin()) then raise exception ''Order % is %: its boxes cannot be changed''';
begin
  def := pg_get_functiondef('public.save_customer_order(uuid,jsonb)'::regprocedure);
  if position('3.54: a completed order' in def) = 0 then
    if position(s_old1 in def) = 0 or position(s_old2 in def) = 0 or position(s_old3 in def) = 0 then
      raise exception 'Update 3.54: save_customer_order has changed - send this message to Claude';
    end if;
    execute replace(replace(replace(def, s_old1, s_new1), s_old2, s_new2), s_old3, s_new3);
  end if;
  foreach n in array array['public.add_order_box(uuid,jsonb)', 'public.change_order_box(uuid,jsonb)'] loop
    def := pg_get_functiondef(n::regprocedure);
    if position('''completed'' and public.is_admin()' in def) > 0 then continue; end if;
    if position(b_old1 in def) = 0 and position(b_old2 in def) = 0 then
      raise exception 'Update 3.54: % has changed - send this message to Claude', n;
    end if;
    execute replace(replace(def, b_old1, b_new1), b_old2, b_new2);
  end loop;
end $$;

notify pgrst, 'reload schema';

select case when position('3.54: a completed order' in pg_get_functiondef('public.save_customer_order(uuid,jsonb)'::regprocedure)) > 0
  and position('''completed'' and public.is_admin()' in pg_get_functiondef('public.add_order_box(uuid,jsonb)'::regprocedure)) > 0
  and position('''completed'' and public.is_admin()' in pg_get_functiondef('public.change_order_box(uuid,jsonb)'::regprocedure)) > 0
  then 'UPDATE 3.54 READY - the Director edits a completed customer order (like ARS-2); its invoice changes with it'
  else 'NOT READY - send this message to Claude' end as result;

-- ===== 063_payroll_pay_salary.sql =====
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.55: PAYROLL - ISSUE PAYSLIP, THEN PAY SALARY WITH THE EMPLOYEE'S ID CARD
-- 1. ISSUE PAYSLIP: choose the employee and the month; earnings less deductions = NET SALARY. The payslip is UNPAID and
--    its net salary goes on the employee's account as UNPAID SALARY. One salary payslip per employee per month.
-- 2. PAY SALARY: choose the employee, the date and the payslip (payslip no); the amount (all or part of what is left);
--    then the employee's ID card QR is scanned: only the card of that employee is accepted. The payment is recorded
--    (SP-YYYYMM-###) and linked to the payslip; the payslip is PAID (or PART PAID) and the unpaid salary goes down.
-- Payslips recorded before this update were paid when they were made: they stay PAID. The month-end salary submit
-- of 3.52 is not used any more (its records are kept).
-- Needs 062_edit_completed_order.sql (already run). Paste all of it in Supabase > SQL Editor > New query and press Run.
-- Safe to run again. The last line says: UPDATE 3.55 READY - ...
-- =====================================================================

-- a payslip issued by this update waits for its payment (issued_at); one made before was paid when it was made
alter table public.payslips add column if not exists issued_at timestamptz;
alter table public.payslips add column if not exists deduction_note text check (deduction_note is null or char_length(deduction_note) <= 200);

-- the salary payments: each pays (all or part of) one payslip, after the employee's ID card was scanned
create table if not exists public.salary_payments (
  id uuid primary key default gen_random_uuid(),
  payment_no text unique,
  employee_id uuid not null references public.employees(id) on delete cascade,
  payslip_id uuid not null references public.payslips(id) on delete cascade,
  amount numeric(14,2) not null check (amount > 0),
  pay_date date not null default current_date,
  method text check (method is null or char_length(method) <= 40),
  reference_no text check (reference_no is null or char_length(reference_no) <= 60),
  notes text check (notes is null or char_length(notes) <= 300),
  card_no text,
  verified_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists salary_payments_employee_idx on public.salary_payments(employee_id);
create index if not exists salary_payments_payslip_idx on public.salary_payments(payslip_id);
create index if not exists salary_payments_date_idx on public.salary_payments(pay_date);
create index if not exists salary_payments_created_by_idx on public.salary_payments(created_by);
create index if not exists payslips_period_idx on public.payslips(period_month);

alter table public.salary_payments enable row level security;
revoke all on public.salary_payments from anon;
grant select on public.salary_payments to authenticated;
-- read: as the payslips (the Director, EO-Office, and the employee their own); a payment is made only by pay_salary()
drop policy if exists "sp: read" on public.salary_payments;
create policy "sp: read" on public.salary_payments for select to authenticated
  using ((select public.is_admin()) or (select public.has_module('employees'))
         or exists (select 1 from public.employees e where e.id = employee_id and e.profile_id = (select auth.uid())));

-- every payslip with what was paid and what is left: PAID / PARTIAL / UNPAID
create or replace view public.payslip_balances with (security_invoker = true) as
select s.id, s.payslip_no, s.employee_id, s.pay_type, s.period_month, s.pay_date, s.net_pay, s.issued_at,
  (s.advance_deduction + s.other_deductions) as deductions,
  case when s.issued_at is null then s.net_pay else coalesce(p.paid, 0) end as paid,
  case when s.issued_at is null then 0 else greatest(s.net_pay - coalesce(p.paid, 0), 0) end as balance,
  case when s.issued_at is null or coalesce(p.paid, 0) >= s.net_pay then 'paid' when coalesce(p.paid, 0) > 0 then 'partial' else 'unpaid' end as status,
  p.last_paid
from public.payslips s
left join (select payslip_id, sum(amount) as paid, max(pay_date) as last_paid from public.salary_payments group by payslip_id) p on p.payslip_id = s.id;
grant select on public.payslip_balances to authenticated;

-- 1. ISSUE PAYSLIP: p_data = {employee_id, pay_type, period_month, pay_date, basic_pay, allowances, overtime_pay, bonus,
--    advance_amount, advance_deduction, other_deductions, deduction_note, notes}
create or replace function public.issue_payslip(p_data jsonb) returns public.payslips
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare e public.employees; s public.payslips; t text := coalesce(nullif(p_data ->> 'pay_type', ''), 'salary');
  m date := date_trunc('month', coalesce(nullif(p_data ->> 'period_month', '')::date, current_date))::date; dup text;
  amt numeric[];
begin
  if not public.can_write('employees') then raise exception 'Not allowed'; end if;
  select * into e from public.employees where id = nullif(p_data ->> 'employee_id', '')::uuid;
  if not found then raise exception 'Choose the employee'; end if;
  if e.status = 'terminated' then raise exception '% is terminated: no payslip can be issued', upper(e.first_name || ' ' || e.last_name); end if;
  if t not in ('salary', 'advance', 'bonus', 'other') then raise exception 'Choose the payslip type'; end if;
  if t = 'salary' then
    select payslip_no into dup from public.payslips where employee_id = e.id and pay_type = 'salary' and period_month = m limit 1;
    if dup is not null then raise exception 'The salary payslip of % for % is issued already (%)', upper(e.first_name || ' ' || e.last_name), to_char(m, 'FMMONTH YYYY'), dup; end if;
  end if;
  amt := array[coalesce(nullif(p_data ->> 'basic_pay', '')::numeric, 0), coalesce(nullif(p_data ->> 'allowances', '')::numeric, 0),
    coalesce(nullif(p_data ->> 'overtime_pay', '')::numeric, 0), coalesce(nullif(p_data ->> 'bonus', '')::numeric, 0),
    coalesce(nullif(p_data ->> 'advance_amount', '')::numeric, 0), coalesce(nullif(p_data ->> 'advance_deduction', '')::numeric, 0),
    coalesce(nullif(p_data ->> 'other_deductions', '')::numeric, 0)];
  if exists (select 1 from unnest(amt) x where x < 0) then raise exception 'An amount cannot be less than 0'; end if;
  if amt[1] + amt[2] + amt[3] + amt[4] + amt[5] - amt[6] - amt[7] <= 0 then raise exception 'The net salary must be more than 0'; end if;
  insert into public.payslips (employee_id, pay_type, period_month, pay_date, basic_pay, allowances, overtime_pay, bonus, advance_amount,
    advance_deduction, other_deductions, deduction_note, notes, issued_at)
  values (e.id, t, m, coalesce(nullif(p_data ->> 'pay_date', '')::date, current_date), round(amt[1], 2), round(amt[2], 2), round(amt[3], 2), round(amt[4], 2),
    round(amt[5], 2), round(amt[6], 2), round(amt[7], 2), nullif(left(trim(coalesce(p_data ->> 'deduction_note', '')), 200), ''),
    nullif(left(trim(coalesce(p_data ->> 'notes', '')), 500), ''), now())
  returning * into s;
  if e.profile_id is not null then
    perform public.notify_user(e.profile_id, 'Payslip ' || s.payslip_no || ' issued',
      'Net salary PHP ' || to_char(s.net_pay, 'FM999,999,990.00') || ' for ' || to_char(m, 'FMMONTH YYYY') || ' (unpaid until it is paid)', 'payslip/' || s.id);
  end if;
  return s;
end;
$$;
revoke execute on function public.issue_payslip(jsonb) from public, anon;
grant execute on function public.issue_payslip(jsonb) to authenticated;

-- 2. PAY SALARY: the payslip, the amount, the date, how it was paid, and the code of the employee's ID card (scanned)
create or replace function public.pay_salary(p_payslip uuid, p_amount numeric, p_date date, p_method text, p_ref text, p_notes text, p_card text)
returns public.salary_payments
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare s public.payslips; e public.employees; c public.employee_cards; sec text; mm text[]; paid numeric; left_amt numeric;
  amt numeric := round(coalesce(p_amount, 0), 2); d date := coalesce(p_date, current_date); r public.salary_payments;
  me text := (select full_name from public.profiles where id = auth.uid());
begin
  if not public.can_write('employees') then raise exception 'Not allowed'; end if;
  select * into s from public.payslips where id = p_payslip for update;
  if not found then raise exception 'Payslip not found'; end if;
  select * into e from public.employees where id = s.employee_id;
  if s.issued_at is null then raise exception 'Payslip % was paid when it was made', s.payslip_no; end if;
  select coalesce(sum(amount), 0) into paid from public.salary_payments where payslip_id = s.id;
  left_amt := s.net_pay - paid;
  if left_amt <= 0 then raise exception 'Payslip % is paid already', s.payslip_no; end if;
  if amt <= 0 then raise exception 'Enter the amount to pay'; end if;
  if amt > left_amt then raise exception 'Only PHP % is left to pay on payslip %', to_char(left_amt, 'FM999,999,990.00'), s.payslip_no; end if;
  if d > current_date then raise exception 'The pay date cannot be after today'; end if;
  -- the employee's ID card: the card of this employee, valid today
  mm := regexp_match(upper(trim(coalesce(p_card, ''))), '^EMONID\|(EOID-[0-9]{4}-[0-9]{4,})\|([0-9A-F]{40})$');
  if mm is null then raise exception 'Scan the QR code on the employee''s ID card first'; end if;
  select * into c from public.employee_cards where card_no = mm[1];
  select k.secret into sec from private.employee_card_keys k where k.card_id = c.id;
  if c.id is null or sec is distinct from mm[2] then raise exception 'This ID card is not valid'; end if;
  if c.employee_id <> s.employee_id then raise exception 'This ID card is not the card of % - scan the card of the employee who is paid', upper(e.first_name || ' ' || e.last_name); end if;
  if c.status <> 'active' then raise exception 'This ID card is no longer valid (%) - use the new card', upper(c.status); end if;
  if c.valid_until < current_date then raise exception 'This ID card expired on %', to_char(c.valid_until, 'FMMONTH DD YYYY'); end if;
  insert into public.salary_payments (payment_no, employee_id, payslip_id, amount, pay_date, method, reference_no, notes, card_no, created_by_name)
  values ('SP-' || to_char(d, 'YYYYMM') || '-' || lpad(public.next_counter('SP' || to_char(d, 'YYYYMM'))::text, 3, '0'), s.employee_id, s.id, amt, d,
    nullif(left(trim(coalesce(p_method, '')), 40), ''), nullif(left(trim(coalesce(p_ref, '')), 60), ''), nullif(left(trim(coalesce(p_notes, '')), 300), ''), c.card_no, me)
  returning * into r;
  if e.profile_id is not null then
    perform public.notify_user(e.profile_id, 'Salary paid - ' || r.payment_no,
      'PHP ' || to_char(amt, 'FM999,999,990.00') || ' paid on payslip ' || s.payslip_no
      || case when amt < left_amt then ' (PHP ' || to_char(left_amt - amt, 'FM999,999,990.00') || ' still unpaid)' else ' (paid in full)' end, 'payslip/' || s.id);
  end if;
  return r;
end;
$$;
revoke execute on function public.pay_salary(uuid, numeric, date, text, text, text, text) from public, anon;
grant execute on function public.pay_salary(uuid, numeric, date, text, text, text, text) to authenticated;

-- the Verify page shows a payslip PAID, PART PAID or UNPAID (it said PAID for every payslip)
do $$
declare f record; def text;
  old_s text := '''type'', ''Payslip'', ''number'', r.payslip_no, ''status'', ''paid''';
  new_s text := '''type'', ''Payslip'', ''number'', r.payslip_no, ''status'', coalesce((select b.status from public.payslip_balances b where b.id = r.id), ''paid'')';
begin
  for f in select p.oid from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosrc like '%' || old_s || '%' loop
    def := pg_get_functiondef(f.oid);
    execute replace(def, old_s, new_s);
  end loop;
end $$;

notify pgrst, 'reload schema';

select case when to_regprocedure('public.issue_payslip(jsonb)') is not null and to_regclass('public.salary_payments') is not null
  and to_regprocedure('public.pay_salary(uuid,numeric,date,text,text,text,text)') is not null and to_regclass('public.payslip_balances') is not null
  then 'UPDATE 3.55 READY - Payroll: Issue Payslip (unpaid salary), then Pay Salary with the employee''s ID card scan'
  else 'NOT READY - send this message to Claude' end as result;

-- ===== 064_charge_as_delivered.sql =====
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.56: THE INVOICE CHARGES THE PCS DELIVERED (THE DELIVERY LIST)
-- Every box delivered goes to the order line with the same BATCH NO and CODE (else the same product) and is charged at
-- that line's price per pc. So the invoice is the pcs of the delivery list x the price: more pcs delivered are charged
-- more, fewer pcs are charged less (a line with no box delivered is not charged). The order keeps what was ordered.
-- * A completed order's invoice follows by itself when its boxes change (added, changed, removed) or the order is edited.
-- * Boxes without pcs (0) are charged as ordered; an order with no pcs on its boxes is charged as ordered.
-- * A box that matches no line (another item, code or batch no) is NOT ORDERED and not charged: the order page lists
--   it with its items and the Director adds its price - it is added to the order as a line and the invoice follows.
-- * A line with no boxes (e.g. a fee) is charged as ordered.
-- * The invoice cannot go below the payments linked to it.
-- * The invoices of the orders completed before this update are charged as delivered now (not below linked payments).
-- Needs 063_payroll_pay_salary.sql. Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again.
-- The last line says: UPDATE 3.56 READY - ...
-- =====================================================================

-- what an order delivered: each line with the pcs of its boxes and the amount, and the totals
create or replace function public.co_delivered(p_order uuid) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare o public.customer_orders; res jsonb;
begin
  select * into o from public.customer_orders where id = p_order;
  if not found then return null; end if;
  with ln as (
    select (x.ord - 1)::int as i, x.v, upper(trim(coalesce(x.v ->> 'code', ''))) as code, upper(trim(coalesce(x.v ->> 'lot', ''))) as lot,
      upper(trim(coalesce(x.v ->> 'product', ''))) as prod, coalesce(nullif(x.v ->> 'price', '')::numeric, 0) as price,
      coalesce(nullif(x.v ->> 'qty', '')::numeric, 0) as qty, coalesce(nullif(x.v ->> 'boxes', '')::numeric, 0) as nbox,
      coalesce(nullif(x.v ->> 'amount', '')::numeric, coalesce(nullif(x.v ->> 'qty', '')::numeric, 0) * coalesce(nullif(x.v ->> 'price', '')::numeric, 0)) as amt
    from jsonb_array_elements(coalesce(o.lines, '[]'::jsonb)) with ordinality x(v, ord)
  ), bx as (
    select b.id, b.serial_no, upper(trim(coalesce(b.code, ''))) as code, upper(trim(coalesce(b.batch_no, ''))) as lot,
      upper(trim(coalesce(b.items, ''))) as item, coalesce(b.pcs, 0) as pcs
    from public.customer_order_boxes b where b.order_id = p_order
  ), pick as (
    select bx.*, m.i, m.rk from bx left join lateral (
      select ln.i, case when ln.code = bx.code and ln.lot = bx.lot then 0
          when bx.lot <> '' and ln.lot = bx.lot and (ln.code = '' or bx.code = '') then 1
          when bx.code <> '' and ln.code = bx.code and (ln.lot = '' or bx.lot = '') then 2
          when bx.item <> '' and ln.prod = bx.item then 3
          when bx.item <> '' and ln.prod <> '' and (position(ln.prod in bx.item) > 0 or position(bx.item in ln.prod) > 0) then 4
          else 9 end as rk
      from ln where ln.nbox > 0 order by 2, ln.i limit 1) m on true
  ), per as (
    select ln.i, ln.v, ln.price, ln.qty, ln.nbox, ln.amt,
      count(p.id) filter (where p.rk < 9) as boxes_in, coalesce(sum(p.pcs) filter (where p.rk < 9), 0) as pcs_in,
      count(p.id) filter (where p.rk < 9 and p.pcs = 0) as zero_in
    from ln left join pick p on p.i = ln.i group by ln.i, ln.v, ln.price, ln.qty, ln.nbox, ln.amt
  ), tot as (select coalesce(sum(pcs), 0) as pcs, count(*) filter (where serial_no is not null) as boxes from bx),
  lines as (
    select per.*, case when per.nbox = 0 or per.zero_in > 0 or (select pcs from tot) = 0 then per.qty else per.pcs_in end as dqty
    from per
  ), lines2 as (
    select lines.*, case when lines.nbox = 0 or lines.zero_in > 0 or (select pcs from tot) = 0 then lines.amt else round(lines.dqty * lines.price, 2) end as damt from lines
  ), odd as (
    select coalesce(sum(p.pcs), 0) as pcs from pick p where p.rk is null or p.rk = 9
  ), oddl as (
    select p.code, p.lot, p.item, count(*) filter (where p.serial_no is not null) as boxes, count(*) as lines, coalesce(sum(p.pcs), 0) as pcs,
      string_agg(coalesce(p.serial_no, '-'), ', ' order by p.serial_no) as serials
    from pick p where p.rk is null or p.rk = 9 group by p.code, p.lot, p.item
  )
  select jsonb_build_object(
    'has_pcs', (select pcs from tot) > 0,
    'boxes', (select boxes from tot),
    'pcs', (select coalesce(sum(dqty), 0) from lines2),
    'odd_pcs', (select pcs from odd),
    'odd', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'lot', lot, 'items', item, 'boxes', boxes, 'lines', lines, 'pcs', pcs, 'serials', serials) order by lot, code, item) from oddl), '[]'::jsonb),
    'ordered_amount', o.total_amount, 'ordered_pcs', o.total_pcs,
    'amount', (select coalesce(sum(damt), 0) from lines2),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('i', i, 'product', v ->> 'product', 'code', v ->> 'code', 'lot', v ->> 'lot', 'price', price,
       'ordered', qty, 'delivered', dqty, 'boxes', boxes_in, 'amount', damt, 'ordered_amount', amt) order by i) from lines2), '[]'::jsonb))
  into res;
  return res;
end;
$$;
revoke execute on function public.co_delivered(uuid) from public, anon;
grant execute on function public.co_delivered(uuid) to authenticated;

-- a completed order's invoice: charged as delivered (boxes, pcs, amount); not below the payments linked to it
create or replace function public.co_charge_as_delivered(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders; d jsonb; amt numeric; linked numeric;
begin
  select * into o from public.customer_orders where id = p_order;
  if not found or o.status <> 'completed' or o.invoice_id is null then return; end if;
  d := public.co_delivered(p_order);
  amt := (d ->> 'amount')::numeric;
  select coalesce(sum(amount), 0) into linked from public.payment_links where invoice_id = o.invoice_id and removed_at is null;
  if linked > amt then
    raise exception 'Payments of PHP % are linked to the invoice of order %: the delivery (PHP %) cannot be charged less than that',
      to_char(linked, 'FM999,999,990.00'), o.order_no, to_char(amt, 'FM999,999,990.00');
  end if;
  perform public.allow_record_change();
  update public.customer_invoices set total_amount = amt, total_pcs = round((d ->> 'pcs')::numeric)::int,
    total_boxes = case when (d ->> 'has_pcs')::boolean then (d ->> 'boxes')::int else o.total_boxes end
  where id = o.invoice_id and (total_amount, total_pcs, total_boxes) is distinct from
    (amt, round((d ->> 'pcs')::numeric)::int, case when (d ->> 'has_pcs')::boolean then (d ->> 'boxes')::int else o.total_boxes end);
  perform set_config('eo.allow_change', 'off', true);
end;
$$;
revoke execute on function public.co_charge_as_delivered(uuid) from public, anon, authenticated;

-- NOT ORDERED boxes (no line of the order): the Director gives their price; they are added to the order as a line
-- (items, code, batch no, boxes, pcs, price) and the invoice follows. p_code / p_lot / p_items name the group listed.
create or replace function public.price_not_ordered(p_order uuid, p_code text, p_lot text, p_items text, p_price numeric) returns public.customer_orders
language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders; g jsonb; pr numeric := round(coalesce(p_price, 0), 2); ln jsonb;
  k text := upper(trim(coalesce(p_code, ''))); l text := upper(trim(coalesce(p_lot, ''))); it text := upper(trim(coalesce(p_items, '')));
begin
  if not public.is_admin() then raise exception 'Only the Director gives the price'; end if;
  select * into o from public.customer_orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status = 'cancelled' then raise exception 'Order % is CANCELLED', o.order_no; end if;
  if pr <= 0 then raise exception 'Enter the price per pc'; end if;
  select x into g from jsonb_array_elements(public.co_delivered(p_order) -> 'odd') x
    where x ->> 'code' = k and x ->> 'lot' = l and x ->> 'items' = it limit 1;
  if g is null then raise exception 'These boxes are not NOT ORDERED any more - open the order again'; end if;
  if jsonb_array_length(coalesce(o.lines, '[]'::jsonb)) >= 60 then raise exception 'An order has up to 60 lines'; end if;
  ln := jsonb_build_object('qty', (g ->> 'pcs')::numeric, 'boxes', (g ->> 'boxes')::int, 'code', k, 'pcs', 0, 'lot', l,
    'product', coalesce(nullif(trim(coalesce(p_items, '')), ''), 'ITEMS NOT ORDERED'), 'price', pr, 'amount', round((g ->> 'pcs')::numeric * pr, 2),
    'extra', '{}'::jsonb, 'added', 'NOT ORDERED - PRICE ADDED ' || to_char(now() at time zone 'Asia/Manila', 'YYYY-MM-DD'));
  update public.customer_orders set lines = coalesce(lines, '[]'::jsonb) || jsonb_build_array(ln),
    total_boxes = total_boxes + (g ->> 'boxes')::int, total_pcs = total_pcs + round((g ->> 'pcs')::numeric)::int,
    total_amount = total_amount + round((g ->> 'pcs')::numeric * pr, 2), updated_at = now()
  where id = p_order returning * into o;
  perform public.co_charge_as_delivered(p_order);
  return o;
end;
$$;
revoke execute on function public.price_not_ordered(uuid, text, text, text, numeric) from public, anon;
grant execute on function public.price_not_ordered(uuid, text, text, text, numeric) to authenticated;

-- the boxes of a completed order change: its invoice follows
create or replace function public.co_boxes_charge() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.co_charge_as_delivered(case when tg_op = 'DELETE' then old.order_id else new.order_id end);
  return null;
end;
$$;
revoke execute on function public.co_boxes_charge() from public, anon, authenticated;
drop trigger if exists co_boxes_charge on public.customer_order_boxes;
create trigger co_boxes_charge after insert or update or delete on public.customer_order_boxes
  for each row execute function public.co_boxes_charge();

do $$
declare def text;
  c_old text := '  where id = p_id returning * into o;';
  c_new text := '  where id = p_id returning * into o;
  perform public.co_charge_as_delivered(p_id); -- 3.56: charged as delivered';
  s_new text := '-- 3.54: a completed order changes its invoice too; 3.56: charged as delivered (the pcs of its boxes x the price of their line)
  if o.status = ''completed'' and o.invoice_id is not null then
    if (select customer_id from public.customer_invoices where id = o.invoice_id) is distinct from o.customer_id then
      raise exception ''Order % is completed: its customer cannot be changed (the invoice is for that customer)'', o.order_no;
    end if;
    perform public.allow_record_change();
    update public.customer_invoices set payment_terms = o.payment_terms, purchase_date = o.order_date where id = o.invoice_id;
    perform set_config(''eo.allow_change'', ''off'', true);
    perform public.co_charge_as_delivered(o.id);
  end if;';
begin
  -- completing an order: the invoice is charged as delivered
  def := pg_get_functiondef('public.complete_customer_order(uuid)'::regprocedure);
  if position('3.56: charged as delivered' in def) = 0 then
    if position(c_old in def) = 0 then raise exception 'Update 3.56: complete_customer_order has changed - send this message to Claude'; end if;
    execute replace(def, c_old, c_new);
  end if;
  -- editing a completed order (3.54): the invoice is charged as delivered
  def := pg_get_functiondef('public.save_customer_order(uuid,jsonb)'::regprocedure);
  if position('3.56: charged as delivered' in def) = 0 then
    if position('-- 3.54: a completed order changes its invoice too' in def) = 0 then raise exception 'Update 3.56: run 062_edit_completed_order.sql first'; end if;
    execute regexp_replace(def, '-- 3\.54: a completed order changes its invoice too.*?perform set_config\(''eo\.allow_change'', ''off'', true\);\s*end if;', s_new);
  end if;
end $$;

-- the orders completed before: their invoices are charged as delivered (one that would go below its linked payments stays)
create temp table if not exists charge_result (line text);
truncate charge_result;
do $$
declare r record; before numeric; after numeric;
begin
  for r in select o.id, o.order_no, o.invoice_id from public.customer_orders o where o.status = 'completed' and o.invoice_id is not null order by o.order_no loop
    select total_amount into before from public.customer_invoices where id = r.invoice_id;
    begin
      perform public.co_charge_as_delivered(r.id);
      select total_amount into after from public.customer_invoices where id = r.invoice_id;
      if after is distinct from before then
        insert into charge_result values (r.order_no || '  PHP ' || to_char(before, 'FM999,999,990.00') || ' -> ' || to_char(after, 'FM999,999,990.00'));
      end if;
    exception when others then
      insert into charge_result values (r.order_no || '  NOT CHANGED: ' || sqlerrm);
    end;
  end loop;
end $$;

notify pgrst, 'reload schema';

select line as result from charge_result
union all
select case when to_regprocedure('public.co_delivered(uuid)') is not null
  and position('3.56: charged as delivered' in pg_get_functiondef('public.complete_customer_order(uuid)'::regprocedure)) > 0
  and position('3.56: charged as delivered' in pg_get_functiondef('public.save_customer_order(uuid,jsonb)'::regprocedure)) > 0
  and to_regprocedure('public.price_not_ordered(uuid,text,text,text,numeric)') is not null
  then 'UPDATE 3.56 READY - the invoice charges the pcs delivered (batch no + code = the price of the order line); NOT ORDERED boxes get their price'
  else 'NOT READY - send this message to Claude' end;

