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
