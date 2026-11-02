-- EMON OVERRUNS E-PORTAL - RUN_073_TO_074.sql (update 3.69): 073_legal_terms + 074_customer_portal
-- Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again. The last line says UPDATE 3.69 CUSTOMERS READY.

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
