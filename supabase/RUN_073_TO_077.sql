-- EMON OVERRUNS E-PORTAL - RUN_073_TO_077.sql: every update not run yet (073, 074, 075, 076, 077) in one file.
-- Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again, also if you ran some of it before.
-- The last line says: UPDATE 3.72 READY

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

-- ===== 077_insurance =====
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.72: EO-OFFICE INSURANCE (ORDER COVERAGE)
-- An insurance coverage for a PREPARED customer order (approved by EMON HASAN), bought BEFORE delivery:
--   premium = boxes x PHP 50 + 0.5% of the order value (EMON HASAN can change both in Insurance settings).
-- 1. Staff (EO-Office) or EMON HASAN adds it by the order number: the order details and the premium show.
-- 2. Payment: EMON HASAN's payment QR code and the amount show; after paying, the proof of payment is uploaded and
--    submitted for review.
-- 3. EVA AI reads the payment slip: when the amount on it is the premium, the coverage is issued at once. Otherwise
--    EMON HASAN reviews: APPROVE issues the coverage at once (certificate with EMON HASAN's signature) and makes a
--    COLLECTION VOUCHER for the amount by itself (with the proof as its receipt); REJECT sends it back with a note.
-- 4. The coverage is valid until 15 days after the delivery (it shows "VALID UNTIL 15 DAYS AFTER DELIVERY" before).
--    The order page shows the COVERED badge and EXPIRES date; anyone can verify the certificate (INS-…) or the order.
-- Needs 045_customer_orders.sql and 024_eo_office.sql. Paste all of it in Supabase > SQL Editor > New query and press Run.
-- Safe to run again. The last line says: UPDATE 3.72 READY - ...
-- =====================================================================
do $$ begin
  if to_regclass('public.customer_orders') is null or to_regclass('public.collection_vouchers') is null then raise exception 'Run the earlier updates first (customer orders, EO-Office).'; end if;
end $$;

-- 1. the settings: premium per box, rate of the order value, the payment QR code (a picture in the branding folder)
alter table public.company_settings add column if not exists ins_box_price numeric(12,2) not null default 50 check (ins_box_price >= 0);
alter table public.company_settings add column if not exists ins_rate_pct numeric(6,3) not null default 0.5 check (ins_rate_pct >= 0 and ins_rate_pct <= 100);
alter table public.company_settings add column if not exists pay_qr_path text;
alter table public.company_settings add column if not exists pay_qr_note text;

-- 2. the coverages
create table if not exists public.order_insurance (
  id uuid primary key default gen_random_uuid(),
  ins_no text unique,
  order_id uuid not null references public.customer_orders(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  order_no text,
  customer_name text,
  boxes integer not null default 0 check (boxes >= 0),
  order_amount numeric(14,2) not null default 0,
  box_price numeric(12,2) not null,
  rate_pct numeric(6,3) not null,
  amount numeric(14,2) not null check (amount >= 0),
  status text not null default 'unpaid' check (status in ('unpaid','review','active','rejected','cancelled')),
  pay_method text check (pay_method in ('cash','bank','gcash','check','other')),
  pay_ref text,
  proof_path text,
  proof_at timestamptz,
  proof_by_name text,
  review_note text,
  approved_by uuid references public.profiles(id) on delete set null,
  approved_by_name text,
  approved_at timestamptz,
  issued_at timestamptz,
  valid_until date,
  cv_id uuid references public.collection_vouchers(id) on delete set null,
  eva_amount numeric(14,2),      -- the amount EVA read on the payment slip
  eva_text text,                 -- what EVA read (kept for checking)
  issued_by_eva boolean not null default false,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.order_insurance add column if not exists eva_amount numeric(14,2);
alter table public.order_insurance add column if not exists eva_text text;
alter table public.order_insurance add column if not exists issued_by_eva boolean not null default false;
create index if not exists order_insurance_order_idx on public.order_insurance(order_id);
create index if not exists order_insurance_customer_idx on public.order_insurance(customer_id);
create index if not exists order_insurance_status_idx on public.order_insurance(status, valid_until);
create index if not exists order_insurance_cv_idx on public.order_insurance(cv_id);
create index if not exists order_insurance_created_by_idx on public.order_insurance(created_by);
create index if not exists order_insurance_approved_by_idx on public.order_insurance(approved_by);
create unique index if not exists order_insurance_one_open on public.order_insurance(order_id) where status in ('unpaid','review','active');
alter table public.order_insurance enable row level security;
revoke all on public.order_insurance from anon;
grant select on public.order_insurance to authenticated;
drop policy if exists "ins: read" on public.order_insurance;
create policy "ins: read" on public.order_insurance for select to authenticated using ((select public.co_can_read()));

-- the proof of payment pictures: records/insurance/<id>/…
drop policy if exists "storage records: insurance upload" on storage.objects;
create policy "storage records: insurance upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'records' and coalesce((storage.foldername(name))[1], '') = 'insurance' and ((select public.qc_can_write()) or (select public.is_admin())));
drop policy if exists "storage records: insurance delete" on storage.objects;
create policy "storage records: insurance delete" on storage.objects for delete to authenticated
  using (bucket_id = 'records' and coalesce((storage.foldername(name))[1], '') = 'insurance' and (select public.is_admin()));

-- 3. add a coverage to an order (before delivery)
create or replace function public.request_insurance(p_order uuid) returns public.order_insurance
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare o public.customer_orders; s public.company_settings; r public.order_insurance; me text := (select full_name from public.profiles where id = auth.uid()); ym text := to_char(now(), 'YYYYMM');
begin
  if not (public.qc_can_write() or public.is_admin()) then raise exception 'Not allowed'; end if;
  select * into o from public.customer_orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status = 'pending' then raise exception 'Order % waits for EMON HASAN''s approval: the coverage is added when it is PREPARED', o.order_no; end if;
  if o.status <> 'approved' or o.delivered_at is not null or o.delivery_request_at is not null then
    raise exception 'Order % is already delivered or %: insurance is added only before the delivery', o.order_no, upper(o.status);
  end if;
  if exists (select 1 from public.order_insurance where order_id = o.id and status in ('unpaid','review','active')) then
    raise exception 'Order % already has an insurance', o.order_no;
  end if;
  select * into s from public.company_settings where id = 1;
  insert into public.order_insurance (ins_no, order_id, customer_id, order_no, customer_name, boxes, order_amount, box_price, rate_pct, amount, created_by_name)
  select 'INS-' || ym || '-' || lpad(public.next_counter('INS' || ym)::text, 3, '0'), o.id, o.customer_id, o.order_no,
    (select trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) from public.customers c where c.id = o.customer_id),
    coalesce(o.total_boxes, 0), coalesce(o.total_amount, 0), coalesce(s.ins_box_price, 50), coalesce(s.ins_rate_pct, 0.5),
    round(coalesce(o.total_boxes, 0) * coalesce(s.ins_box_price, 50) + coalesce(o.total_amount, 0) * coalesce(s.ins_rate_pct, 0.5) / 100, 2), me
  returning * into r;
  return r;
end;
$$;
revoke execute on function public.request_insurance(uuid) from public, anon;
grant execute on function public.request_insurance(uuid) to authenticated;

-- 4. the proof of payment (after paying by the QR code)
create or replace function public.submit_insurance_payment(p_id uuid, p_path text, p_method text, p_ref text) returns public.order_insurance
language plpgsql security definer set search_path = '' as $$
declare r public.order_insurance; me text := (select full_name from public.profiles where id = auth.uid());
begin
  if not (public.qc_can_write() or public.is_admin()) then raise exception 'Not allowed'; end if;
  select * into r from public.order_insurance where id = p_id for update;
  if not found then raise exception 'Insurance not found'; end if;
  if r.status not in ('unpaid', 'rejected') then raise exception 'Insurance % is %: the payment cannot be changed now', r.ins_no, upper(r.status); end if;
  if coalesce(p_path, '') not like 'insurance/' || p_id || '/%' then raise exception 'Upload the proof of payment first'; end if;
  update public.order_insurance set status = 'review', proof_path = p_path, proof_at = now(), proof_by_name = me, review_note = null,
    pay_method = case when p_method in ('cash','bank','gcash','check','other') then p_method else 'gcash' end,
    pay_ref = nullif(left(trim(coalesce(p_ref, '')), 60), ''), updated_at = now()
  where id = p_id returning * into r;
  perform public.notify_user(p.id, 'Insurance ' || r.ins_no || ' payment to review', 'Order ' || r.order_no || ' · PHP ' || to_char(r.amount, 'FM999,999,990.00'), 'insurance/' || r.id)
  from public.profiles p where p.role = 'admin' and p.status = 'active';
  return r;
end;
$$;
revoke execute on function public.submit_insurance_payment(uuid, text, text, text) from public, anon;
grant execute on function public.submit_insurance_payment(uuid, text, text, text) to authenticated;

-- 5. issuing a coverage: the coverage, the expiry and the collection voucher (inside function: EMON HASAN or EVA)
create or replace function public.ins_issue(p_id uuid, p_by_name text, p_note text, p_eva boolean) returns public.order_insurance
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare r public.order_insurance; o public.customer_orders; cv uuid; ym text := to_char(now(), 'YYYYMM');
begin
  select * into r from public.order_insurance where id = p_id for update;
  select * into o from public.customer_orders where id = r.order_id;
  insert into public.collection_vouchers (cv_no, cv_date, received_from, amount, method, reference_no, note, receipt_path, created_by, created_by_name)
  values ('CV-' || ym || '-' || lpad(public.next_counter('CV' || ym)::text, 3, '0'), current_date, left(coalesce(r.customer_name, 'CUSTOMER'), 120), r.amount,
    coalesce(r.pay_method, 'gcash'), r.pay_ref, left('INSURANCE ' || r.ins_no || ' · ORDER ' || coalesce(r.order_no, '') || case when p_eva then ' · VERIFIED BY EVA AI' else '' end, 300),
    r.proof_path, auth.uid(), left(p_by_name, 120))
  returning id into cv;
  update public.order_insurance set status = 'active', review_note = nullif(left(trim(coalesce(p_note, '')), 300), ''), approved_by = case when p_eva then null else auth.uid() end,
    approved_by_name = left(p_by_name, 120), approved_at = now(), issued_at = now(), cv_id = cv, issued_by_eva = p_eva,
    valid_until = case when o.delivered_at is not null then (o.delivered_at at time zone 'Asia/Manila')::date + 15 end, updated_at = now()
  where id = p_id returning * into r;
  return r;
end;
$$;
revoke execute on function public.ins_issue(uuid, text, text, boolean) from public, anon, authenticated;

-- EMON HASAN decides: approve = the coverage is issued and the collection voucher is made by itself
create or replace function public.decide_insurance(p_id uuid, p_action text, p_note text default null) returns public.order_insurance
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare r public.order_insurance; me text := (select full_name from public.profiles where id = auth.uid());
begin
  if not public.is_admin() then raise exception 'Only EMON HASAN can approve an insurance'; end if;
  select * into r from public.order_insurance where id = p_id for update;
  if not found then raise exception 'Insurance not found'; end if;
  if r.status <> 'review' then raise exception 'Insurance % is % (only a payment waiting for review is decided)', r.ins_no, upper(r.status); end if;
  if p_action = 'reject' then
    if coalesce(trim(p_note), '') = '' then raise exception 'Write why the payment is not accepted'; end if;
    update public.order_insurance set status = 'rejected', review_note = left(trim(p_note), 300), approved_by = auth.uid(), approved_by_name = me, approved_at = now(), updated_at = now()
    where id = p_id returning * into r;
  elsif p_action = 'approve' then
    r := public.ins_issue(p_id, me, p_note, false);
  else raise exception 'Unknown action';
  end if;
  if r.created_by is distinct from auth.uid() then
    perform public.notify_user(r.created_by, 'Insurance ' || r.ins_no || case when r.status = 'active' then ' issued' else ' payment not accepted' end,
      'Order ' || r.order_no, 'insurance/' || r.id);
  end if;
  return r;
end;
$$;
revoke execute on function public.decide_insurance(uuid, text, text) from public, anon;
grant execute on function public.decide_insurance(uuid, text, text) to authenticated;

-- EVA AI read the payment slip: the amount on it is the premium → the coverage is issued at once (EMON HASAN is told and
-- sees what EVA read). Any other amount, or nothing read: it stays in review for EMON HASAN.
create or replace function public.eva_issue_insurance(p_id uuid, p_amount numeric, p_text text) returns public.order_insurance
language plpgsql security definer set search_path = '' as $$
declare r public.order_insurance; me text := (select full_name from public.profiles where id = auth.uid());
begin
  if not (public.qc_can_write() or public.is_admin()) then raise exception 'Not allowed'; end if;
  select * into r from public.order_insurance where id = p_id for update;
  if not found then raise exception 'Insurance not found'; end if;
  update public.order_insurance set eva_amount = round(p_amount, 2), eva_text = left(p_text, 2000), updated_at = now() where id = p_id returning * into r;
  -- the slip shows the premium, or the premium with the bank's transfer fee (PHP 10 or PHP 15, not counted)
  if r.status <> 'review' or p_amount is null or round(p_amount, 2) - r.amount not in (0, 10, 15)
     or position(to_char(round(p_amount, 2), 'FM999999990.00') in replace(coalesce(p_text, ''), ',', '')) = 0 then
    return r; -- not matched: EMON HASAN decides
  end if;
  r := public.ins_issue(p_id, 'EVA AI (payment slip read: PHP ' || to_char(p_amount, 'FM999,999,990.00') ||
    case when round(p_amount, 2) > r.amount then ' with transfer fee PHP ' || to_char(round(p_amount, 2) - r.amount, 'FM990.00') else '' end || ') · ' || coalesce(me, ''), 'Payment verified by EVA AI', true);
  perform public.notify_user(p.id, 'Insurance ' || r.ins_no || ' issued by EVA AI', 'Payment slip read: PHP ' || to_char(p_amount, 'FM999,999,990.00') || ' · order ' || r.order_no, 'insurance/' || r.id)
  from public.profiles p where p.role = 'admin' and p.status = 'active' and p.id is distinct from auth.uid();
  return r;
end;
$$;
revoke execute on function public.eva_issue_insurance(uuid, numeric, text) from public, anon;
grant execute on function public.eva_issue_insurance(uuid, numeric, text) to authenticated;

-- EMON HASAN cancels a coverage that is not issued (gives back the proof file to delete)
create or replace function public.cancel_insurance(p_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare r public.order_insurance;
begin
  if not public.is_admin() then raise exception 'Only EMON HASAN can cancel an insurance'; end if;
  select * into r from public.order_insurance where id = p_id for update;
  if not found then raise exception 'Insurance not found'; end if;
  if r.status = 'active' then raise exception 'Insurance % is issued: it cannot be cancelled', r.ins_no; end if;
  update public.order_insurance set status = 'cancelled', updated_at = now() where id = p_id;
  return r.proof_path;
end;
$$;
revoke execute on function public.cancel_insurance(uuid) from public, anon;
grant execute on function public.cancel_insurance(uuid) to authenticated;

-- 6. the delivery sets the expiry: delivery day + 15 days
create or replace function public.ins_follow_delivery() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.delivered_at is distinct from old.delivered_at then
    update public.order_insurance set valid_until = case when new.delivered_at is null then null else (new.delivered_at at time zone 'Asia/Manila')::date + 15 end, updated_at = now()
    where order_id = new.id and status = 'active';
  end if;
  return new;
end;
$$;
revoke execute on function public.ins_follow_delivery() from public, anon, authenticated;
drop trigger if exists ins_follow_delivery on public.customer_orders;
create trigger ins_follow_delivery after update of delivered_at on public.customer_orders for each row execute function public.ins_follow_delivery();

-- 7. anyone can verify a certificate (INS-…) or an order (OR-…)
create or replace function public.verify_insurance(p_code text) returns jsonb
language sql stable security definer set search_path = '' set timezone to 'Asia/Manila' as $$
  select coalesce((select jsonb_build_object('found', true, 'ins_no', i.ins_no, 'order_no', i.order_no, 'customer', i.customer_name, 'boxes', i.boxes,
      'issued_at', i.issued_at, 'valid_until', i.valid_until, 'delivered', o.delivered_at is not null,
      'state', case when i.valid_until is null then 'VALID UNTIL 15 DAYS AFTER DELIVERY' when i.valid_until >= current_date then 'VALID' else 'EXPIRED' end)
    from public.order_insurance i join public.customer_orders o on o.id = i.order_id
    where i.status = 'active' and (upper(i.ins_no) = upper(trim(p_code)) or upper(i.order_no) = upper(trim(p_code)))
    order by i.issued_at desc limit 1), jsonb_build_object('found', false));
$$;
revoke execute on function public.verify_insurance(text) from public;
grant execute on function public.verify_insurance(text) to anon, authenticated;

select case when to_regprocedure('public.decide_insurance(uuid,text,text)') is not null
  then 'UPDATE 3.72 READY - EO-Office Insurance: add by order no, pay by QR, proof, EMON HASAN approves, certificate and collection voucher by themselves'
  else 'NOT READY - send this message to Claude' end as result;
