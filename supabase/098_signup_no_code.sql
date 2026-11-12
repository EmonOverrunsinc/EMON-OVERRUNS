-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.99.9: Create Account without an email code
-- Run this BEFORE "Confirm email" is turned OFF in Supabase (Authentication > Sign In / Providers > Email).
-- Without the email code nobody proves the email is theirs, so a new account is never linked to an employee
-- by its email any more and never becomes the Director: every new account is a Pending applicant, and the
-- Director links it to the employee (Employee > Access & Status > Link Login Account).
-- The first scan of an employee ID card (039) still makes a linked login at once (that login is confirmed
-- when it is made, so it is still linked here). Safe to run again.
-- =====================================================================
do $$ begin
  if to_regprocedure('public.handle_new_user()') is null then raise exception 'Update 3.99.9: the sign-up function is missing: send this message to Claude.'; end if;
end $$;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  first_user boolean;
  emp public.employees;
  uname text;
  owner boolean;
begin
  select not exists (select 1 from public.profiles) into first_user;
  owner := first_user;
  -- only a login that is already confirmed when it is made (the ID card's first password) is linked by the email
  if new.email_confirmed_at is not null then
    select * into emp from public.employees e where lower(e.email) = lower(new.email) and e.status <> 'terminated' and e.profile_id is null limit 1;
  end if;
  uname := lower(trim(new.raw_user_meta_data->>'username'));
  if uname is null or uname !~ '^[a-z0-9._]{3,20}$' or exists (select 1 from public.profiles p where lower(p.username) = uname) then
    uname := null;
  end if;
  insert into public.profiles (id, email, full_name, role, status, modules, username)
  values (
    new.id, new.email,
    coalesce(case when emp.id is not null then trim(emp.first_name || ' ' || emp.last_name) end, nullif(trim(new.raw_user_meta_data->>'full_name'), ''), split_part(new.email, '@', 1)),
    case when owner then 'admin' when emp.id is not null then emp.role else 'viewer' end,
    case when owner then 'active' when emp.id is not null then (case when emp.status = 'inactive' then 'disabled' else 'active' end) else 'pending' end,
    case when emp.id is not null and not owner then emp.modules end,
    uname
  );
  if emp.id is not null then
    update public.employees set profile_id = new.id, status = case when status = 'inactive' then 'inactive' else 'active' end where id = emp.id;
  end if;
  return new;
end;
$$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

select 'UPDATE 3.99.9 READY' as result;
