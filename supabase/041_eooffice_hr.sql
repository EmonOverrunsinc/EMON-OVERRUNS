-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.31: no "Employee (HR)" menu access any more: 11 EO-Office gives Employees, Payroll
-- and Job Applications too. Every check of the old HR access now asks for EO-Office, and the old HR access is taken
-- off every login and employee (the Director ticks 11 EO-Office for the people who need it). Safe to run again.
-- =====================================================================

-- 1. the HR access is EO-Office (the server checks 'employees' in many places: they all follow EO-Office now)
create or replace function public.has_module(m text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active'
    and (p.role = 'admin' or p.modules is null or (case when m = 'employees' then 'eooffice' else m end) = any(p.modules)));
$$;
create or replace function public.can_write(m text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active'
    and (p.role = 'admin' or (p.role = 'staff' and (p.modules is null or (case when m = 'employees' then 'eooffice' else m end) = any(p.modules)))));
$$;
revoke execute on function public.has_module(text) from public, anon;
revoke execute on function public.can_write(text) from public, anon;
grant execute on function public.has_module(text) to authenticated;
grant execute on function public.can_write(text) to authenticated;

-- 2. the old HR access is taken off (it gives nothing any more)
do $$
begin
  perform public.allow_record_change();
  update public.employees set modules = array_remove(modules, 'employees') where 'employees' = any(modules);
  update public.profiles set modules = array_remove(modules, 'employees') where 'employees' = any(modules);
end $$;

select 'UPDATE 3.31 READY - EO-Office gives Employees, Payroll and Job Applications (no Employee (HR))' as result;
