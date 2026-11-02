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
