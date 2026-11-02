-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.73.3: NO SIGNATURE ON THE AGREEMENTS
-- Employees no longer draw a signature when they agree to the Employee Agreement; the agreement record (and its PDF)
-- keeps the IDs, device, IP address, location (when allowed), date and time and the fingerprint of the text.
-- Needs RUN_073_TO_078.sql. Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again.
-- The last line says: UPDATE 3.73.3 READY - ...
-- =====================================================================
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
  select e.employee_no, e.position into emp from public.employees e where e.profile_id = p.id limit 1;
  d := coalesce(public.legal_clean(p_details), '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object('login_id', p.id, 'email', p.email, 'username', p.username,
    'role', p.role, 'employee_no', emp.employee_no, 'position', emp.position));
  select count(*) + 1 into n from public.legal_acceptances where accepted_at::date = current_date;
  insert into public.legal_acceptances (ref_no, user_id, full_name, email, role, terms_version, terms_hash, device, ip_address, details, location, signature)
  values ('LT-' || to_char(now(), 'YYYYMMDD') || lpad(n::text, 3, '0') || '-' || upper(substr(md5(p.id::text || clock_timestamp()::text), 1, 4)),
    p.id, p.full_name, p.email, p.role, left(trim(p_version), 40), lower(trim(p_hash)), left(p_device, 400), public.legal_ip(),
    d, public.legal_clean(p_location, 600), null)
  returning * into r;
  return r;
end;
$$;
revoke execute on function public.accept_legal_terms(text, text, text, jsonb, jsonb, text) from public, anon;
grant execute on function public.accept_legal_terms(text, text, text, jsonb, jsonb, text) to authenticated;

select case when position('Sign the Employee Agreement first' in pg_get_functiondef('public.accept_legal_terms(text,text,text,jsonb,jsonb,text)'::regprocedure)) = 0
  then 'UPDATE 3.73.3 READY - no signature on the agreements'
  else 'NOT READY - send this message to Claude' end as result;
