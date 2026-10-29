-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.43: WHO CAN USE EVA AI is chosen by the Director
-- Menu Access has a new tick box "12 EVA AI" (Employees - Access & Status). The Director always has EVA; a staff login has
-- it only when the Director ticks it (old logins with every menu do not get it by themselves). EVA answers only from
-- what that person may already see. Learn Now and the box database stay with the Director.
-- Needs RUN_048_TO_051.sql (already run). Safe to run again.
-- =====================================================================
do $$ begin
  if to_regclass('public.ai_models') is null then raise exception 'Run RUN_048_TO_051.sql first, then run this again.'; end if;
end $$;

create or replace function public.ai_can_read() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_admin() or (public.is_staff() and exists (select 1 from public.profiles p
    where p.id = auth.uid() and p.status = 'active' and 'ai' = any(coalesce(p.modules, '{}'))));
$$;
revoke execute on function public.ai_can_read() from public, anon;
grant execute on function public.ai_can_read() to authenticated;

select case when position('''ai''' in pg_get_functiondef('public.ai_can_read()'::regprocedure)) > 0
  then 'UPDATE 3.43 READY - the Director chooses who can use EVA AI (Menu Access: 12 EVA AI)'
  else 'NOT READY - send this message to Claude' end as result;
