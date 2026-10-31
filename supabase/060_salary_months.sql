-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.52: MONTH-END SALARY
-- At the end of every month the Director submits the salary each employee earned that month (EO-Office > Payroll >
-- Submit Month Salary). What is paid (Record Salary / Advance - the payslips) is taken off it, so every employee shows
-- SALARY EARNED, PAID and SALARY DUE (unpaid), with a history month by month.
-- Needs RUN_052_TO_059.sql (already run). Paste all of it in Supabase > SQL Editor > New query and press Run.
-- Safe to run again. The last line says: UPDATE 3.52 READY - ...
-- =====================================================================
create table if not exists public.salary_months (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  period_month date not null check (period_month = date_trunc('month', period_month)::date),
  amount numeric(14,2) not null check (amount >= 0),
  notes text check (notes is null or char_length(notes) <= 300),
  submitted_by uuid references public.profiles(id) on delete set null default auth.uid(),
  submitted_by_name text,
  submitted_at timestamptz not null default now(),
  unique (employee_id, period_month)
);
create index if not exists salary_months_month_idx on public.salary_months(period_month);
create index if not exists salary_months_submitted_by_idx on public.salary_months(submitted_by);

alter table public.salary_months enable row level security;
revoke all on public.salary_months from anon;
grant select on public.salary_months to authenticated;
-- read: the Director, staff with Employee (HR) access, and the employee (their own); every change through the functions below
drop policy if exists "sm: read" on public.salary_months;
create policy "sm: read" on public.salary_months for select to authenticated
  using ((select public.is_admin()) or (select public.has_module('employees'))
         or exists (select 1 from public.employees e where e.id = employee_id and e.profile_id = (select auth.uid())));

-- The Director submits a month's salary: p_items = [{employee_id, amount, notes}]. A month submitted before is
-- changed to the new amount. An amount of 0 (or empty) takes that employee's month off. Gives back how many were saved.
create or replace function public.submit_salary_month(p_month date, p_items jsonb) returns integer
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare m date := date_trunc('month', p_month)::date; x jsonb; k integer := 0; amt numeric; me text := (select full_name from public.profiles where id = auth.uid());
begin
  if not public.is_admin() then raise exception 'Only the Director can submit the month''s salary'; end if;
  if m is null or m > date_trunc('month', current_date)::date then raise exception 'Choose this month or a month before'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' then raise exception 'Nothing to submit'; end if;
  for x in select * from jsonb_array_elements(p_items) loop
    if not exists (select 1 from public.employees where id = (x ->> 'employee_id')::uuid) then raise exception 'Employee not found'; end if;
    amt := round(coalesce(nullif(x ->> 'amount', '')::numeric, 0), 2);
    if amt < 0 then raise exception 'A salary cannot be less than 0'; end if;
    if amt = 0 then
      delete from public.salary_months where employee_id = (x ->> 'employee_id')::uuid and period_month = m;
      continue;
    end if;
    insert into public.salary_months (employee_id, period_month, amount, notes, submitted_by, submitted_by_name)
    values ((x ->> 'employee_id')::uuid, m, amt, nullif(left(trim(coalesce(x ->> 'notes', '')), 300), ''), auth.uid(), me)
    on conflict (employee_id, period_month) do update set amount = excluded.amount, notes = excluded.notes,
      submitted_by = excluded.submitted_by, submitted_by_name = excluded.submitted_by_name, submitted_at = now();
    k := k + 1;
  end loop;
  return k;
end;
$$;
revoke execute on function public.submit_salary_month(date, jsonb) from public, anon;
grant execute on function public.submit_salary_month(date, jsonb) to authenticated;

notify pgrst, 'reload schema';

select case when to_regclass('public.salary_months') is not null and to_regprocedure('public.submit_salary_month(date,jsonb)') is not null
  then 'UPDATE 3.52 READY - the Director submits the month''s salary; every employee shows salary earned, paid and due'
  else 'NOT READY - send this message to Claude' end as result;
