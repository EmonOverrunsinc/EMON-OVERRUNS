-- EMON OVERRUNS E-PORTAL - RUN_073_TO_076.sql: every update not run yet (073, 074, 075, 076) in one file.
-- Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again. The last line says UPDATE 3.71 READY.

-- ===== 073_legal_terms =====
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.69: LEGAL TERMS, DATA PRIVACY AND E-SIGNATURE CONSENT
-- After signing in, every login (EMON HASAN, staff, applicants) reads the Terms of Use, Data Privacy and Confidentiality
-- Agreement and the Electronic Signature Consent, ticks "I have read all and I agree" and presses Submit. Each acceptance is
-- kept on the server for good: who, name, email, role, the version and fingerprint (SHA-256) of the exact text, date and
-- time, the device and browser, and the internet (IP) address. Nobody can change or delete it. EMON HASAN sees and
-- searches all of them; each person sees their own.
-- Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again.
-- The last line says: UPDATE 3.69 READY - ...
-- =====================================================================

create table if not exists public.legal_acceptances (
  id uuid primary key default gen_random_uuid(),
  ref_no text unique,
  user_id uuid not null, -- no link: the record stays even when the login is deleted later
  full_name text,
  email text,
  role text,
  terms_version text not null check (char_length(terms_version) between 1 and 40),
  terms_hash text not null check (terms_hash ~ '^[0-9a-f]{64}$'),
  agreed boolean not null default true check (agreed),
  device text check (char_length(device) <= 400),
  ip_address text,
  accepted_at timestamptz not null default now(),
  unique (user_id, terms_version)
);
create index if not exists legal_acceptances_time_idx on public.legal_acceptances(accepted_at desc);
alter table public.legal_acceptances enable row level security;
revoke all on public.legal_acceptances from anon, authenticated;
grant select on public.legal_acceptances to authenticated;
drop policy if exists "legal: own or director" on public.legal_acceptances;
create policy "legal: own or director" on public.legal_acceptances for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

-- kept for good: no change, no delete (also not by the table owner through the API)
create or replace function public.legal_keep() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'A legal acceptance is a permanent record and cannot be changed or deleted';
end;
$$;
drop trigger if exists legal_keep on public.legal_acceptances;
create trigger legal_keep before update or delete on public.legal_acceptances for each row execute function public.legal_keep();

-- the acceptance: the name, email and role come from the login; the IP address from the request
create or replace function public.accept_legal_terms(p_version text, p_hash text, p_device text) returns public.legal_acceptances
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare p public.profiles; r public.legal_acceptances; h json; ip text; n int;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select * into p from public.profiles where id = auth.uid();
  if not found then raise exception 'Profile not found'; end if;
  select * into r from public.legal_acceptances where user_id = p.id and terms_version = p_version;
  if found then return r; end if;
  begin h := current_setting('request.headers', true)::json; exception when others then h := null; end;
  ip := left(trim(split_part(coalesce(h ->> 'x-forwarded-for', h ->> 'x-real-ip', h ->> 'cf-connecting-ip', ''), ',', 1)), 60);
  select count(*) + 1 into n from public.legal_acceptances where accepted_at::date = current_date;
  insert into public.legal_acceptances (ref_no, user_id, full_name, email, role, terms_version, terms_hash, device, ip_address)
  values ('LT-' || to_char(now(), 'YYYYMMDD') || lpad(n::text, 3, '0') || '-' || upper(substr(md5(p.id::text || clock_timestamp()::text), 1, 4)),
    p.id, p.full_name, p.email, p.role, left(trim(p_version), 40), lower(trim(p_hash)), left(p_device, 400), nullif(ip, ''))
  returning * into r;
  return r;
end;
$$;
revoke execute on function public.accept_legal_terms(text, text, text) from public, anon;
grant execute on function public.accept_legal_terms(text, text, text) to authenticated;

select case when to_regprocedure('public.accept_legal_terms(text,text,text)') is not null
  then 'UPDATE 3.69 READY - every login accepts the legal terms once; each acceptance is kept on the server for EMON HASAN'
  else 'NOT READY - send this message to Claude' end as result;

-- ===== 074_customer_portal =====
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.69: CUSTOMER SIGN IN WITH PUBLIC ID + PRIVATE PIN, AND THE AGREEMENT
-- Every customer signs in by scanning the QR code of their Public ID and typing their Private PIN (the Private ID that
-- EMON HASAN sees on the customer profile). They then read and agree to all the legal terms. When they agree, the
-- customer profile shows VERIFIED with the date. Each agreement is kept on the server for good (legal_acceptances).
-- 5 wrong PINs lock the customer's sign in for 15 minutes. Nothing about the customer is given without the right PIN.
-- Needs 073_legal_terms.sql and 071_staff_privacy.sql. Paste all of it in Supabase > SQL Editor > New query and press Run.
-- Safe to run again. The last line says: UPDATE 3.69 CUSTOMERS READY - ...
-- =====================================================================
do $$ begin
  if to_regclass('public.legal_acceptances') is null then raise exception 'Run 073_legal_terms.sql first, then run this again.'; end if;
  if to_regprocedure('public.can_see_kind(text)') is null then raise exception 'Run 071_staff_privacy.sql first, then run this again.'; end if;
end $$;

-- 1. an agreement is made by a login or by a customer
alter table public.legal_acceptances alter column user_id drop not null;
alter table public.legal_acceptances add column if not exists customer_id uuid; -- no link: the record stays even if the customer is deleted later
create unique index if not exists legal_acceptances_customer_idx on public.legal_acceptances(customer_id, terms_version) where customer_id is not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'legal_acceptances_who') then
    alter table public.legal_acceptances add constraint legal_acceptances_who check (user_id is not null or customer_id is not null);
  end if;
end $$;

-- 2. wrong PINs (no one reads this table through the API)
create table if not exists public.customer_signin_tries (
  customer_id uuid primary key references public.customers(id) on delete cascade,
  fails integer not null default 0,
  locked_until timestamptz,
  last_ok_at timestamptz,
  last_fail_at timestamptz
);
alter table public.customer_signin_tries enable row level security;
revoke all on public.customer_signin_tries from public, anon, authenticated;

-- the check: the Public ID and the Private PIN; gives back the customer, or why not (never raises: the count of wrong
-- PINs must be kept)
create or replace function public.cust_signin_check(p_public text, p_pin text) returns jsonb
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare c public.customers; t public.customer_signin_tries; code text;
  pub text := upper(regexp_replace(coalesce(p_public, ''), '[^0-9A-Za-z]', '', 'g'));
  pin text := upper(regexp_replace(coalesce(p_pin, ''), '[^0-9A-Za-z]', '', 'g'));
begin
  if pub !~ '^EO[0-9A-F]{10,}$' or pin = '' then return jsonb_build_object('ok', false, 'error', 'Scan your Public ID and type your Private PIN.'); end if;
  select * into c from public.customers where upper(public_id) = pub;
  if not found then perform pg_sleep(0.4); return jsonb_build_object('ok', false, 'error', 'Wrong Public ID or Private PIN.'); end if;
  select * into t from public.customer_signin_tries where customer_id = c.id for update;
  if found and t.locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'Too many wrong Private PINs. Try again after ' || to_char(t.locked_until, 'HH12:MI AM') || '.');
  end if;
  select upper(regexp_replace(private_code, '[^0-9A-Za-z]', '', 'g')) into code from public.customer_secrets where customer_id = c.id;
  if code is null or code <> pin then
    insert into public.customer_signin_tries (customer_id, fails, last_fail_at) values (c.id, 1, now())
    on conflict (customer_id) do update set fails = public.customer_signin_tries.fails + 1, last_fail_at = now(),
      locked_until = case when public.customer_signin_tries.fails + 1 >= 5 then now() + interval '15 minutes' else public.customer_signin_tries.locked_until end;
    update public.customer_signin_tries set fails = 0 where customer_id = c.id and fails >= 5;
    perform pg_sleep(0.4);
    return jsonb_build_object('ok', false, 'error', 'Wrong Public ID or Private PIN.');
  end if;
  if c.status not in ('active', 'suspended', 'closed') then
    return jsonb_build_object('ok', false, 'error', 'This account is not open yet. Ask the office of EMON OVERRUNS.');
  end if;
  insert into public.customer_signin_tries (customer_id, fails, last_ok_at) values (c.id, 0, now())
  on conflict (customer_id) do update set fails = 0, locked_until = null, last_ok_at = now();
  return jsonb_build_object('ok', true, 'id', c.id);
end;
$$;
revoke execute on function public.cust_signin_check(text, text) from public, anon, authenticated;

-- 3. the customer's own page: who they are, the account, the balance, and their agreement of this version
create or replace function public.customer_portal(p_public text, p_pin text, p_version text) returns jsonb
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare r jsonb := public.cust_signin_check(p_public, p_pin); c public.customers; a public.legal_acceptances; bal numeric;
begin
  if not (r ->> 'ok')::boolean then return r; end if;
  select * into c from public.customers where id = (r ->> 'id')::uuid;
  select * into a from public.legal_acceptances where customer_id = c.id and terms_version = p_version;
  begin select balance_due into bal from public.customer_balances where customer_id = c.id; exception when others then bal := null; end;
  return jsonb_build_object('ok', true, 'name', trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), 'business_name', c.business_name,
    'account_no', c.account_no, 'status', c.status, 'opened', c.application_date, 'credit_limit', c.credit_limit, 'balance_due', bal,
    'agreed', case when a.id is null then null else jsonb_build_object('ref_no', a.ref_no, 'accepted_at', a.accepted_at) end);
end;
$$;
revoke execute on function public.customer_portal(text, text, text) from public;
grant execute on function public.customer_portal(text, text, text) to anon, authenticated;

-- 4. the customer agrees: kept for good, written in the customer's history
create or replace function public.customer_accept_terms(p_public text, p_pin text, p_version text, p_hash text, p_device text) returns jsonb
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare r jsonb := public.cust_signin_check(p_public, p_pin); c public.customers; a public.legal_acceptances; h json; ip text; n int;
begin
  if not (r ->> 'ok')::boolean then return r; end if;
  if coalesce(trim(p_version), '') = '' or lower(coalesce(p_hash, '')) !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok', false, 'error', 'Wrong terms.'); end if;
  select * into c from public.customers where id = (r ->> 'id')::uuid;
  select * into a from public.legal_acceptances where customer_id = c.id and terms_version = p_version;
  if a.id is null then
    begin h := current_setting('request.headers', true)::json; exception when others then h := null; end;
    ip := left(trim(split_part(coalesce(h ->> 'x-forwarded-for', h ->> 'x-real-ip', h ->> 'cf-connecting-ip', ''), ',', 1)), 60);
    select count(*) + 1 into n from public.legal_acceptances where accepted_at::date = current_date;
    insert into public.legal_acceptances (ref_no, customer_id, full_name, email, role, terms_version, terms_hash, device, ip_address)
    values ('LT-' || to_char(now(), 'YYYYMMDD') || lpad(n::text, 3, '0') || '-' || upper(substr(md5(c.id::text || clock_timestamp()::text), 1, 4)),
      c.id, trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) || coalesce(' (' || c.account_no || ')', ''), c.email, 'customer',
      left(trim(p_version), 40), lower(trim(p_hash)), left(p_device, 400), nullif(ip, ''))
    returning * into a;
    insert into public.customer_events (customer_id, action, note, actor_name)
    values (c.id, 'legal terms agreed', 'VERIFIED · ' || a.ref_no || ' · terms version ' || a.terms_version, trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')));
  end if;
  return jsonb_build_object('ok', true, 'ref_no', a.ref_no, 'accepted_at', a.accepted_at);
end;
$$;
revoke execute on function public.customer_accept_terms(text, text, text, text, text) from public;
grant execute on function public.customer_accept_terms(text, text, text, text, text) to anon, authenticated;

-- 5. VERIFIED on the customer profile (staff with the Customer menu)
create or replace function public.customer_legal(p_customer uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when public.is_staff() and public.can_see_kind('customer') then
    (select jsonb_build_object('ref_no', a.ref_no, 'accepted_at', a.accepted_at, 'terms_version', a.terms_version)
       from public.legal_acceptances a where a.customer_id = p_customer order by a.accepted_at desc limit 1) end;
$$;
revoke execute on function public.customer_legal(uuid) from public, anon;
grant execute on function public.customer_legal(uuid) to authenticated;

select case when to_regprocedure('public.customer_portal(text,text,text)') is not null and to_regprocedure('public.customer_accept_terms(text,text,text,text,text)') is not null
  then 'UPDATE 3.69 CUSTOMERS READY - customers sign in with the Public ID QR and the Private PIN, agree to the terms, and show VERIFIED'
  else 'NOT READY - send this message to Claude' end as result;

-- ===== 075_legal_reject =====
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.70: REJECT THE AGREEMENT = SIGNED OUT
-- Every login must agree before using the portal. The agreement popup now has a REJECT button: the person is signed out
-- at once, and the next sign in shows the agreement again — nothing of the portal opens until they agree. Every rejection
-- is kept on the server for good (who, which agreement, when, device, IP address); EMON HASAN sees them in Legal Terms.
-- Customers who reject (Public ID + Private PIN) are kept too.
-- Needs 073_legal_terms.sql and 074_customer_portal.sql. Paste all of it in Supabase > SQL Editor > New query and press Run.
-- Safe to run again. The last line says: UPDATE 3.70 READY - ...
-- =====================================================================
do $$ begin
  if to_regprocedure('public.customer_portal(text,text,text)') is null then raise exception 'Run RUN_073_TO_074.sql first, then run this again.'; end if;
end $$;

create table if not exists public.legal_rejections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,      -- no link: the record stays even when the login is deleted later
  customer_id uuid,  -- or the customer
  full_name text,
  email text,
  role text,
  terms_version text not null check (char_length(terms_version) between 1 and 40),
  device text check (char_length(device) <= 400),
  ip_address text,
  rejected_at timestamptz not null default now(),
  check (user_id is not null or customer_id is not null)
);
create index if not exists legal_rejections_time_idx on public.legal_rejections(rejected_at desc);
alter table public.legal_rejections enable row level security;
revoke all on public.legal_rejections from anon, authenticated;
grant select on public.legal_rejections to authenticated;
drop policy if exists "legal rejections: director" on public.legal_rejections;
create policy "legal rejections: director" on public.legal_rejections for select to authenticated using ((select public.is_admin()));
drop trigger if exists legal_rejections_keep on public.legal_rejections;
create trigger legal_rejections_keep before update or delete on public.legal_rejections for each row execute function public.legal_keep();

create or replace function public.legal_ip() returns text
language plpgsql stable set search_path = '' as $$
declare h json;
begin
  begin h := current_setting('request.headers', true)::json; exception when others then return null; end;
  return nullif(left(trim(split_part(coalesce(h ->> 'x-forwarded-for', h ->> 'x-real-ip', h ->> 'cf-connecting-ip', ''), ',', 1)), 60), '');
end;
$$;
revoke execute on function public.legal_ip() from public, anon, authenticated;

-- a login rejects
create or replace function public.reject_legal_terms(p_version text, p_device text) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.profiles;
begin
  if auth.uid() is null then return; end if;
  select * into p from public.profiles where id = auth.uid();
  insert into public.legal_rejections (user_id, full_name, email, role, terms_version, device, ip_address)
  values (auth.uid(), p.full_name, p.email, p.role, left(coalesce(nullif(trim(p_version), ''), '?'), 40), left(p_device, 400), public.legal_ip());
end;
$$;
revoke execute on function public.reject_legal_terms(text, text) from public, anon;
grant execute on function public.reject_legal_terms(text, text) to authenticated;

-- a customer rejects (only with the right Public ID and Private PIN)
create or replace function public.customer_reject_terms(p_public text, p_pin text, p_version text, p_device text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r jsonb := public.cust_signin_check(p_public, p_pin); c public.customers;
begin
  if not (r ->> 'ok')::boolean then return r; end if;
  select * into c from public.customers where id = (r ->> 'id')::uuid;
  insert into public.legal_rejections (customer_id, full_name, email, role, terms_version, device, ip_address)
  values (c.id, trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) || coalesce(' (' || c.account_no || ')', ''), c.email, 'customer',
    left(coalesce(nullif(trim(p_version), ''), '?'), 40), left(p_device, 400), public.legal_ip());
  return jsonb_build_object('ok', true);
end;
$$;
revoke execute on function public.customer_reject_terms(text, text, text, text) from public;
grant execute on function public.customer_reject_terms(text, text, text, text) to anon, authenticated;

select case when to_regprocedure('public.reject_legal_terms(text,text)') is not null
  then 'UPDATE 3.70 READY - Reject signs the person out; every rejection is kept for EMON HASAN'
  else 'NOT READY - send this message to Claude' end as result;

-- ===== 076_legal_evidence =====
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.71: THE SIGNED AGREEMENT RECORD (FOR LEGAL USE)
-- When a person agrees, the server keeps with the agreement (for good, nobody can change or delete it):
--  * their IDs: login, email, username, role, employee no and position (employees), account no (customers)
--  * their device: system, browser, screen, language, time zone, the internet (IP) address
--  * their location when the phone or computer allows it (latitude, longitude, how exact), or that it was not allowed
--  * EMPLOYEES: their signature, drawn after they agree to the Employee Agreement (required)
-- EMON HASAN opens any agreement in Legal Terms and downloads it as a PDF: the full agreement text, the date and time,
-- all the details above, the signature and the fingerprint of the exact text.
-- Needs 075_legal_reject.sql. Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again.
-- The last line says: UPDATE 3.71 READY - ...
-- =====================================================================
do $$ begin
  if to_regprocedure('public.reject_legal_terms(text,text)') is null then raise exception 'Run 075_legal_reject.sql first, then run this again.'; end if;
end $$;

alter table public.legal_acceptances add column if not exists details jsonb;
alter table public.legal_acceptances add column if not exists location jsonb;
alter table public.legal_acceptances add column if not exists signature text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'legal_acceptances_signature_png') then
    alter table public.legal_acceptances add constraint legal_acceptances_signature_png
      check (signature is null or (signature like 'data:image/png;base64,%' and char_length(signature) <= 400000));
  end if;
end $$;

-- the details sent by the device are kept small and as text
create or replace function public.legal_clean(p jsonb, p_max int default 2000) returns jsonb
language sql immutable set search_path = '' as $$
  select case when p is null or jsonb_typeof(p) <> 'object' or char_length(p::text) > p_max then null else p end;
$$;
revoke execute on function public.legal_clean(jsonb, int) from public, anon, authenticated;

-- a login agrees (with the details, the location and, for the Employee Agreement, the signature)
create or replace function public.accept_legal_terms(p_version text, p_hash text, p_device text, p_details jsonb, p_location jsonb, p_signature text)
returns public.legal_acceptances
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare p public.profiles; r public.legal_acceptances; n int; emp record; d jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select * into p from public.profiles where id = auth.uid();
  if not found then raise exception 'Profile not found'; end if;
  select * into r from public.legal_acceptances where user_id = p.id and terms_version = p_version;
  if found then return r; end if;
  if p_version like 'EMPLOYEE %' and coalesce(p_signature, '') not like 'data:image/png;base64,%' then raise exception 'Sign the Employee Agreement first'; end if;
  select e.employee_no, e.position into emp from public.employees e where e.profile_id = p.id limit 1;
  d := coalesce(public.legal_clean(p_details), '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object('login_id', p.id, 'email', p.email, 'username', p.username,
    'role', p.role, 'employee_no', emp.employee_no, 'position', emp.position));
  select count(*) + 1 into n from public.legal_acceptances where accepted_at::date = current_date;
  insert into public.legal_acceptances (ref_no, user_id, full_name, email, role, terms_version, terms_hash, device, ip_address, details, location, signature)
  values ('LT-' || to_char(now(), 'YYYYMMDD') || lpad(n::text, 3, '0') || '-' || upper(substr(md5(p.id::text || clock_timestamp()::text), 1, 4)),
    p.id, p.full_name, p.email, p.role, left(trim(p_version), 40), lower(trim(p_hash)), left(p_device, 400), public.legal_ip(),
    d, public.legal_clean(p_location, 600), case when p_signature like 'data:image/png;base64,%' then p_signature end)
  returning * into r;
  return r;
end;
$$;
revoke execute on function public.accept_legal_terms(text, text, text, jsonb, jsonb, text) from public, anon;
grant execute on function public.accept_legal_terms(text, text, text, jsonb, jsonb, text) to authenticated;

-- the older call (no details) goes through the same rules: the Employee Agreement still needs the signature
create or replace function public.accept_legal_terms(p_version text, p_hash text, p_device text) returns public.legal_acceptances
language sql security definer set search_path = '' as $$
  select public.accept_legal_terms(p_version, p_hash, p_device, null::jsonb, null::jsonb, null::text);
$$;
revoke execute on function public.accept_legal_terms(text, text, text) from public, anon;
grant execute on function public.accept_legal_terms(text, text, text) to authenticated;

-- a customer agrees (with the details and the location; a signature when given)
create or replace function public.customer_accept_terms(p_public text, p_pin text, p_version text, p_hash text, p_device text, p_details jsonb, p_location jsonb, p_signature text)
returns jsonb
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare r jsonb := public.cust_signin_check(p_public, p_pin); c public.customers; a public.legal_acceptances; n int;
begin
  if not (r ->> 'ok')::boolean then return r; end if;
  if coalesce(trim(p_version), '') = '' or lower(coalesce(p_hash, '')) !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok', false, 'error', 'Wrong terms.'); end if;
  select * into c from public.customers where id = (r ->> 'id')::uuid;
  select * into a from public.legal_acceptances where customer_id = c.id and terms_version = p_version;
  if a.id is null then
    select count(*) + 1 into n from public.legal_acceptances where accepted_at::date = current_date;
    insert into public.legal_acceptances (ref_no, customer_id, full_name, email, role, terms_version, terms_hash, device, ip_address, details, location, signature)
    values ('LT-' || to_char(now(), 'YYYYMMDD') || lpad(n::text, 3, '0') || '-' || upper(substr(md5(c.id::text || clock_timestamp()::text), 1, 4)),
      c.id, trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) || coalesce(' (' || c.account_no || ')', ''), c.email, 'customer',
      left(trim(p_version), 40), lower(trim(p_hash)), left(p_device, 400), public.legal_ip(),
      coalesce(public.legal_clean(p_details), '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object('customer_id', c.id, 'account_no', c.account_no,
        'application_no', c.application_no, 'public_id', c.public_id, 'phone', c.phone, 'business_name', c.business_name)),
      public.legal_clean(p_location, 600), case when p_signature like 'data:image/png;base64,%' then p_signature end)
    returning * into a;
    insert into public.customer_events (customer_id, action, note, actor_name)
    values (c.id, 'legal terms agreed', 'VERIFIED · ' || a.ref_no || ' · ' || a.terms_version, trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')));
  end if;
  return jsonb_build_object('ok', true, 'ref_no', a.ref_no, 'accepted_at', a.accepted_at);
end;
$$;
revoke execute on function public.customer_accept_terms(text, text, text, text, text, jsonb, jsonb, text) from public;
grant execute on function public.customer_accept_terms(text, text, text, text, text, jsonb, jsonb, text) to anon, authenticated;

-- a staff member with the Customer menu sees the customer's agreement record (for the VERIFIED badge and its PDF)
create or replace function public.customer_legal(p_customer uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when public.is_staff() and public.can_see_kind('customer') then
    (select jsonb_build_object('ref_no', a.ref_no, 'accepted_at', a.accepted_at, 'terms_version', a.terms_version)
       from public.legal_acceptances a where a.customer_id = p_customer order by a.accepted_at desc limit 1) end;
$$;

select case when to_regprocedure('public.accept_legal_terms(text,text,text,jsonb,jsonb,text)') is not null
  and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'legal_acceptances' and column_name = 'signature')
  then 'UPDATE 3.71 READY - every agreement keeps the IDs, device, location and (employees) the signature; EMON HASAN downloads it as a PDF'
  else 'NOT READY - send this message to Claude' end as result;
