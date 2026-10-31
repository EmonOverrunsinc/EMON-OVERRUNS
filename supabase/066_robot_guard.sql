-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.58: PROTECTION FROM ROBOTS (TOO MANY TRIES) + THE DIRECTOR DELETES A SALARY PAYMENT
-- 1. The public parts of the portal (sign-in by username, Verify, ID card checks, the order paper's delivery page) can be
--    used by people who are not signed in. A robot could try them thousands of times (to guess record numbers, usernames,
--    card or paper codes). Now each internet address (IP) gets only a few tries a minute; then: "Too many tries. Please
--    wait a minute and try again." People signed in to the E-Portal are not limited.
-- 2. Only the Director deletes a salary payment (Pay Salary) - the payslip is unpaid again by that amount.
-- Needs RUN_062_TO_065.sql. Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again.
-- The last line says: UPDATE 3.58 READY - ...
-- =====================================================================
create schema if not exists private;
create table if not exists private.rate_hits (
  what text not null,
  ip text not null,
  at timestamptz not null default now()
);
create index if not exists rate_hits_idx on private.rate_hits (what, ip, at);
revoke all on private.rate_hits from public, anon, authenticated;

-- a visitor (not signed in) may call p_what at most p_max times a minute from one internet address
create or replace function private.guard(p_what text, p_max int) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare h json; v_ip text; n int;
begin
  if auth.uid() is not null then return; end if;
  begin h := nullif(current_setting('request.headers', true), '')::json; exception when others then h := null; end;
  v_ip := nullif(trim(coalesce(h ->> 'cf-connecting-ip', split_part(coalesce(h ->> 'x-forwarded-for', ''), ',', 1), h ->> 'x-real-ip', '')), '');
  if v_ip is null then return; end if;
  select count(*) into n from private.rate_hits where what = p_what and ip = v_ip and at > now() - interval '1 minute';
  if n >= p_max then raise exception 'Too many tries. Please wait a minute and try again.'; end if;
  insert into private.rate_hits (what, ip) values (p_what, v_ip);
  if random() < 0.02 then delete from private.rate_hits where at < now() - interval '10 minutes'; end if;
end;
$$;
revoke execute on function private.guard(text, int) from public, anon, authenticated;

-- the sign-in by username and the username check (were SQL functions): the same answer, with the guard
create or replace function public.login_email(p_login text) returns text
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.guard('login_email', 15);
  return case when position('@' in coalesce(p_login, '')) > 0 then lower(trim(p_login))
              else (select lower(p.email) from public.profiles p where lower(p.username) = lower(trim(p_login)) limit 1) end;
end;
$$;
create or replace function public.username_available(p_username text) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.guard('username_available', 30);
  return lower(trim(coalesce(p_username, ''))) ~ '^[a-z0-9._]{3,20}$'
     and not exists (select 1 from public.profiles p where lower(p.username) = lower(trim(p_username)));
end;
$$;

-- the other public functions: the guard is put first in each, with its own number of tries a minute
do $$
declare f record; def text;
begin
  for f in select p.oid, p.proname, x.n from pg_proc p join (values ('verify_record', 30), ('card_state', 20), ('check_employee_card', 20),
      ('card_set_password', 10), ('co_paper_folder', 60), ('delivery_order', 60), ('delivery_find_box', 120), ('delivery_add_box', 300),
      ('delivery_remove_box', 120), ('delivery_save', 60), ('delivery_photos', 60), ('delivery_complete', 20)) x(name, n) on x.name = p.proname
    where p.pronamespace = 'public'::regnamespace loop
    def := pg_get_functiondef(f.oid);
    if position('private.guard(' in def) > 0 then continue; end if;
    if def !~ E'\\nbegin\\s*\\n' then raise exception 'Update 3.58: % has changed - send this message to Claude', f.proname; end if;
    execute regexp_replace(def, E'\\nbegin\\s*\\n', E'\nbegin\n  perform private.guard(''' || f.proname || ''', ' || f.n || E');\n');
    execute format('alter function %s volatile', f.oid::regprocedure);
  end loop;
end $$;

-- 2. the Director deletes a salary payment
create or replace function public.delete_salary_payment(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.salary_payments;
begin
  if not public.is_admin() then raise exception 'Only the Director can delete a salary payment'; end if;
  delete from public.salary_payments where id = p_id returning * into r;
  if r.id is null then raise exception 'Salary payment not found'; end if;
end;
$$;
revoke execute on function public.delete_salary_payment(uuid) from public, anon;
grant execute on function public.delete_salary_payment(uuid) to authenticated;

notify pgrst, 'reload schema';

select case when to_regprocedure('private.guard(text,integer)') is not null
  and position('private.guard(' in pg_get_functiondef('public.verify_record(text)'::regprocedure)) > 0
  and position('private.guard(' in pg_get_functiondef('public.delivery_order(text,text)'::regprocedure)) > 0
  and to_regprocedure('public.delete_salary_payment(uuid)') is not null
  then 'UPDATE 3.58 READY - robots get only a few tries a minute on the public pages; the Director deletes a salary payment'
  else 'NOT READY - send this message to Claude' end as result;
