-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.73: NO AGREEMENT, NO USE (ON THE SERVER)
-- Until a login has agreed to the CURRENT version of the agreements, the server gives it no data at all — not only the
-- screen: every rule that needs an active login (staff, EMON HASAN) also needs the agreement. A login can still sign in,
-- read its own profile and agree (or reject). Employees and staff need the Portal Terms of Use AND the Employee Agreement;
-- EMON HASAN and other logins need the Portal Terms of Use. Customers (Public ID + Private PIN) agree on their own page.
-- The current version is kept here (company_settings.legal_version); the portal shows only that version. A new version
-- = everyone agrees again.
-- Needs RUN_073_TO_077.sql. Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again.
-- The last line says: UPDATE 3.73 READY - ...
-- =====================================================================
do $$ begin
  if to_regclass('public.legal_acceptances') is null then raise exception 'Run RUN_073_TO_077.sql first, then run this again.'; end if;
end $$;

-- 1. the current version of the agreements
alter table public.company_settings add column if not exists legal_version text;
update public.company_settings set legal_version = '3.72 · NOVEMBER 02 2026' where id = 1 and coalesce(legal_version, '') = '';

-- 2. has this login agreed to the current version? (no version set = nothing to agree to)
create or replace function public.legal_ok() returns boolean
language sql stable security definer set search_path = '' as $$
  with v as (select coalesce((select s.legal_version from public.company_settings s where s.id = 1), '') as ver)
  select (select ver from v) = ''
    or (exists (select 1 from public.legal_acceptances a where a.user_id = auth.uid() and a.terms_version = 'PORTAL ' || (select ver from v))
        and (coalesce((select p.role from public.profiles p where p.id = auth.uid()), '') <> 'staff'
             or exists (select 1 from public.legal_acceptances a where a.user_id = auth.uid() and a.terms_version = 'EMPLOYEE ' || (select ver from v))));
$$;
revoke execute on function public.legal_ok() from public, anon;
grant execute on function public.legal_ok() to authenticated;

-- 3. every rule for an active login, staff or EMON HASAN now also needs the agreement
create or replace function public.is_active() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active') and public.legal_ok();
$$;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active' and p.role = 'admin') and public.legal_ok();
$$;
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active' and p.role in ('admin','staff')) and public.legal_ok();
$$;

select case when position('legal_ok' in pg_get_functiondef('public.is_staff()'::regprocedure)) > 0
  then 'UPDATE 3.73 READY - no agreement, no use: the server gives no data until the current agreements are accepted (version ' || (select legal_version from public.company_settings where id = 1) || ')'
  else 'NOT READY - send this message to Claude' end as result;
