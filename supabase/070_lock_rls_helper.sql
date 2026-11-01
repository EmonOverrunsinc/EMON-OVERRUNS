-- =====================================================================
-- EMON OVERRUNS E-PORTAL - SECURITY CHECK FIX: rls_auto_enable
-- rls_auto_enable is a helper Supabase made for the setting "automatically turn on row level security for new tables".
-- It only runs by itself when a new table is made (a visitor cannot really use it), but it should not be open to
-- visitors at all: this closes it. Then it shows who has FULL ACCESS (Director) logins.
-- Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again.
-- =====================================================================
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end $$;

select 'FULL ACCESS: ' || coalesce(full_name, '') || ' · ' || coalesce(email, '') || ' · since ' || to_char(created_at, 'FMMONTH DD YYYY') as result
from public.profiles where role = 'admin' and status = 'active'
union all
select case when to_regprocedure('public.rls_auto_enable()') is null or not has_function_privilege('anon', 'public.rls_auto_enable()', 'execute')
  then 'OK     rls_auto_enable is closed to visitors' else 'NOT READY - send this message to Claude' end;
