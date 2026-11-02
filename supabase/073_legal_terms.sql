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
