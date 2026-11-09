-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.96: STAFF CANNOT SEE MONEY HISTORY · SSS
-- * An employee WITHOUT "13 See Balances & History" can still RECORD invoices, payments and credit memos, but the
--   database gives them ONLY the records they made themselves: no other invoices, no payment history, no credit memos
--   of others, no statements of account (SOA). EMON HASAN (and an employee given "13 See Balances & History") sees all.
--   Recording a payment shows them only the customer's TOTAL TO PAY.
-- * An employee can have an SSS No and a monthly SSS contribution. A payslip takes the SSS contribution off the salary
--   (it is printed on its own line: SSS CONTRIBUTION, with the SSS No).
-- Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again.
-- The last line says: UPDATE 3.96 READY - ...
-- =====================================================================

-- 1) who may see the money history: EMON HASAN, or an employee with "13 See Balances & History"
create or replace function public.sees_money()
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_admin() or (public.is_active() and public.has_module('money'));
$$;
revoke execute on function public.sees_money() from public, anon;
grant execute on function public.sees_money() to authenticated;

-- 2) the records: everyone else sees only what they made
drop policy if exists "inv: active read" on public.customer_invoices;
create policy "inv: active read" on public.customer_invoices for select to authenticated
  using ((select public.is_active()) and ((select public.sees_money()) or created_by = (select auth.uid())));

drop policy if exists "pay: active read" on public.payments_received;
create policy "pay: active read" on public.payments_received for select to authenticated
  using ((select public.is_active()) and ((select public.sees_money()) or created_by = (select auth.uid())));

drop policy if exists "cm: active read" on public.credit_memos;
create policy "cm: active read" on public.credit_memos for select to authenticated
  using ((select public.is_active()) and ((select public.sees_money()) or created_by = (select auth.uid())));

drop policy if exists "plinks: active read" on public.payment_links;
create policy "plinks: active read" on public.payment_links for select to authenticated
  using ((select public.is_active()) and ((select public.sees_money())
    or exists (select 1 from public.payments_received p where p.id = payment_links.payment_id and p.created_by = (select auth.uid()))));

drop policy if exists "soa: active read" on public.statements;
create policy "soa: active read" on public.statements for select to authenticated
  using ((select public.sees_money()));

-- 3) SSS: the employee's SSS No and monthly contribution; the payslip's SSS contribution
alter table public.employees add column if not exists sss_no text;
alter table public.employees add column if not exists sss_amount numeric(12,2) not null default 0;
alter table public.payslips add column if not exists sss_deduction numeric(12,2) not null default 0;
alter table public.payslips add column if not exists sss_no text;
comment on column public.payslips.sss_deduction is 'The SSS contribution taken off this payslip. It is INCLUDED in other_deductions (so net_pay stays right); the payslip prints it on its own line.';

-- Edit Employee may change the SSS No and the contribution
do $$
declare def text := pg_get_functiondef('public.director_edit_employee(uuid,jsonb)'::regprocedure);
begin
  if position('''sss_no''' in def) = 0 then
    if position('''work_location''];' in def) = 0 then raise exception 'Update 3.96: director_edit_employee has changed - send this message to Claude (run 092 first)'; end if;
    def := replace(def, '''work_location''];', '''work_location'',''sss_no'',''sss_amount''];');
    execute def;
  end if;
end $$;

-- Issue Payslip: the SSS contribution (it is taken off the salary and kept on the payslip with the SSS No)
create or replace function public.issue_payslip(p_data jsonb)
returns public.payslips language plpgsql security definer set search_path = '' set "TimeZone" = 'Asia/Manila' as $$
declare e public.employees; s public.payslips; t text := coalesce(nullif(p_data ->> 'pay_type', ''), 'salary');
  m date := date_trunc('month', coalesce(nullif(p_data ->> 'period_month', '')::date, current_date))::date; dup text;
  amt numeric[]; sss numeric := round(coalesce(nullif(p_data ->> 'sss_deduction', '')::numeric, 0), 2);
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
  if exists (select 1 from unnest(amt) x where x < 0) or sss < 0 then raise exception 'An amount cannot be less than 0'; end if;
  if amt[1] + amt[2] + amt[3] + amt[4] + amt[5] - amt[6] - amt[7] - sss <= 0 then raise exception 'The net salary must be more than 0'; end if;
  insert into public.payslips (employee_id, pay_type, period_month, pay_date, basic_pay, allowances, overtime_pay, bonus, advance_amount,
    advance_deduction, other_deductions, sss_deduction, sss_no, deduction_note, notes, issued_at)
  values (e.id, t, m, coalesce(nullif(p_data ->> 'pay_date', '')::date, current_date), round(amt[1], 2), round(amt[2], 2), round(amt[3], 2), round(amt[4], 2),
    round(amt[5], 2), round(amt[6], 2), round(amt[7], 2) + sss, sss, case when sss > 0 or nullif(trim(coalesce(e.sss_no, '')), '') is not null then nullif(trim(coalesce(e.sss_no, '')), '') end,
    nullif(left(trim(coalesce(p_data ->> 'deduction_note', '')), 200), ''), nullif(left(trim(coalesce(p_data ->> 'notes', '')), 500), ''), now())
  returning * into s;
  if e.profile_id is not null then
    perform public.notify_user(e.profile_id, 'Payslip ' || s.payslip_no || ' issued',
      'Net salary PHP ' || to_char(s.net_pay, 'FM999,999,990.00') || ' for ' || to_char(m, 'FMMONTH YYYY') || ' (unpaid until it is paid)', 'payslip/' || s.id);
  end if;
  return s;
end $$;
revoke execute on function public.issue_payslip(jsonb) from public, anon;
grant execute on function public.issue_payslip(jsonb) to authenticated;

notify pgrst, 'reload schema';

select case when to_regprocedure('public.sees_money()') is not null
    and exists (select 1 from pg_policy where polrelid = 'public.statements'::regclass and pg_get_expr(polqual, polrelid) like '%sees_money%')
    and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'payslips' and column_name = 'sss_deduction')
    and position('''sss_no''' in pg_get_functiondef('public.director_edit_employee(uuid,jsonb)'::regprocedure)) > 0
  then 'UPDATE 3.96 READY - staff see only the invoices, payments and credit memos they recorded (no SOA); SSS No and SSS contribution on payslips'
  else 'NOT READY - send this message to Claude' end as result;
