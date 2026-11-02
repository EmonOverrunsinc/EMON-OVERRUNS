-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.75: KYC VERIFICATION WITH A LIVE FACE CHECK (OPTIONAL)
-- Every login can verify who they are, when they want (it is optional, nothing is blocked without it):
--  * the ID: type, ID number, expiry, date of birth, a photo of the front (and the back)
--  * a LIVE FACE check by the camera: the person follows moves shown on the screen (look straight, turn left, turn
--    right, smile ...); a photo is taken at each move and the movement between them is measured (a printed photo or a
--    screen does not pass). The photos and the check results are kept.
-- EMON HASAN compares the face with the ID and APPROVES (KYC VERIFIED) or REJECTS (with the reason). The person is told.
-- The KYC photos are seen only by the person and EMON HASAN. Every submission is kept (a new one replaces a waiting one).
-- Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again.
-- The last line says: UPDATE 3.75 READY - ...
-- =====================================================================

create table if not exists public.kyc_verifications (
  id uuid primary key default gen_random_uuid(),
  ref_no text unique,
  user_id uuid not null references public.profiles(id) on delete cascade,
  full_name text,
  email text,
  role text,
  id_type text not null check (char_length(id_type) between 2 and 60),
  id_number text not null check (char_length(id_number) between 3 and 40),
  id_expiry date,
  birth_date date,
  id_front_path text not null,
  id_back_path text,
  selfie_paths text[] not null,
  liveness jsonb,
  device text check (char_length(device) <= 400),
  ip_address text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'replaced')),
  review_note text check (char_length(review_note) <= 300),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_by_name text,
  reviewed_at timestamptz,
  submitted_at timestamptz not null default now()
);
create index if not exists kyc_verifications_user_idx on public.kyc_verifications(user_id, submitted_at desc);
create index if not exists kyc_verifications_status_idx on public.kyc_verifications(status);
alter table public.kyc_verifications enable row level security;
revoke all on public.kyc_verifications from anon, authenticated;
grant select on public.kyc_verifications to authenticated;
drop policy if exists "kyc: own or EMON HASAN" on public.kyc_verifications;
create policy "kyc: own or EMON HASAN" on public.kyc_verifications for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

-- the KYC photos: records/kyc/<the person's id>/... seen and added only by the person (and seen by EMON HASAN)
drop policy if exists "storage records: kyc upload" on storage.objects;
create policy "storage records: kyc upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'records' and coalesce((storage.foldername(name))[1], '') = 'kyc'
              and (storage.foldername(name))[2] = (select auth.uid())::text and (select public.is_active()));
drop policy if exists "storage records: kyc private" on storage.objects;
create policy "storage records: kyc private" on storage.objects as restrictive for select to authenticated
  using (bucket_id <> 'records' or coalesce((storage.foldername(name))[1], '') <> 'kyc'
         or (storage.foldername(name))[2] = (select auth.uid())::text or (select public.is_admin()));

-- a login sends the KYC (a waiting one of the same login is replaced)
create or replace function public.submit_kyc(p jsonb) returns public.kyc_verifications
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare me public.profiles; r public.kyc_verifications; dir text; sel text[]; n int; f text;
begin
  if not public.is_active() then raise exception 'Sign in first'; end if;
  select * into me from public.profiles where id = auth.uid();
  dir := 'kyc/' || me.id::text || '/';
  select coalesce(array_agg(x), '{}') into sel from jsonb_array_elements_text(coalesce(p -> 'selfies', '[]'::jsonb)) x;
  if coalesce(trim(p ->> 'id_type'), '') = '' then raise exception 'Choose the type of ID'; end if;
  if char_length(coalesce(trim(p ->> 'id_number'), '')) < 3 then raise exception 'Type the ID number'; end if;
  if coalesce(p ->> 'id_front', '') = '' then raise exception 'Add the photo of the front of the ID'; end if;
  if cardinality(sel) < 3 then raise exception 'Do the live face check first'; end if;
  if not coalesce((p -> 'liveness' ->> 'passed')::boolean, false) then raise exception 'The live face check did not pass. Do it again in good light'; end if;
  foreach f in array sel || array[p ->> 'id_front'] || case when coalesce(p ->> 'id_back', '') <> '' then array[p ->> 'id_back'] else '{}'::text[] end loop
    if f not like dir || '%' then raise exception 'The KYC photos must be in your own folder'; end if;
    if not exists (select 1 from storage.objects o where o.bucket_id = 'records' and o.name = f) then raise exception 'A KYC photo was not found. Do it again'; end if;
  end loop;
  update public.kyc_verifications set status = 'replaced' where user_id = me.id and status = 'pending';
  select count(*) + 1 into n from public.kyc_verifications where submitted_at::date = current_date;
  insert into public.kyc_verifications (ref_no, user_id, full_name, email, role, id_type, id_number, id_expiry, birth_date, id_front_path, id_back_path,
    selfie_paths, liveness, device, ip_address)
  values ('KYC-' || to_char(now(), 'YYYYMMDD') || lpad(n::text, 3, '0') || '-' || upper(substr(md5(me.id::text || clock_timestamp()::text), 1, 4)),
    me.id, me.full_name, me.email, me.role, left(upper(trim(p ->> 'id_type')), 60), left(upper(trim(p ->> 'id_number')), 40),
    nullif(p ->> 'id_expiry', '')::date, nullif(p ->> 'birth_date', '')::date, p ->> 'id_front', nullif(p ->> 'id_back', ''), sel,
    case when char_length((p -> 'liveness')::text) <= 6000 then p -> 'liveness' end, left(p ->> 'device', 400), public.legal_ip())
  returning * into r;
  if not public.is_admin() then
    perform public.notify_admins('KYC verification to review', coalesce(me.full_name, me.email) || ' sent the KYC (' || r.id_type || ') with the live face check · ' || r.ref_no, 'kyc');
  end if;
  return r;
end;
$$;
revoke execute on function public.submit_kyc(jsonb) from public, anon;
grant execute on function public.submit_kyc(jsonb) to authenticated;

-- EMON HASAN approves (KYC VERIFIED) or rejects (with the reason); the person is told
create or replace function public.decide_kyc(p_id uuid, p_ok boolean, p_note text) returns public.kyc_verifications
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare r public.kyc_verifications; me text := (select full_name from public.profiles where id = auth.uid());
begin
  if not public.is_admin() then raise exception 'Only EMON HASAN can do this'; end if;
  select * into r from public.kyc_verifications where id = p_id for update;
  if not found then raise exception 'KYC not found'; end if;
  if r.status <> 'pending' then raise exception 'This KYC is % already', upper(r.status); end if;
  if not p_ok and coalesce(trim(p_note), '') = '' then raise exception 'Type the reason for rejecting'; end if;
  update public.kyc_verifications set status = case when p_ok then 'approved' else 'rejected' end, review_note = nullif(left(trim(coalesce(p_note, '')), 300), ''),
    reviewed_by = auth.uid(), reviewed_by_name = me, reviewed_at = now()
  where id = p_id returning * into r;
  if r.user_id is distinct from auth.uid() then
    perform public.notify_user(r.user_id, case when p_ok then 'KYC VERIFIED' else 'KYC not approved' end,
      case when p_ok then 'Your identity is verified (' || r.ref_no || ').' else 'Reason: ' || r.review_note || '. You can send the KYC again from My Profile.' end, 'profile');
  end if;
  return r;
end;
$$;
revoke execute on function public.decide_kyc(uuid, boolean, text) from public, anon;
grant execute on function public.decide_kyc(uuid, boolean, text) to authenticated;

-- the KYC state of a login (for the badge): approved / pending / rejected / none — the person or EMON HASAN
create or replace function public.kyc_state(p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case when p_user = auth.uid() or public.is_admin() then coalesce(
    (select 'approved' from public.kyc_verifications where user_id = p_user and status = 'approved' limit 1),
    (select status from public.kyc_verifications where user_id = p_user and status in ('pending', 'rejected') order by submitted_at desc limit 1), 'none') end;
$$;
revoke execute on function public.kyc_state(uuid) from public, anon;
grant execute on function public.kyc_state(uuid) to authenticated;

notify pgrst, 'reload schema';

select case when to_regprocedure('public.submit_kyc(jsonb)') is not null and exists (select 1 from pg_policies where policyname = 'storage records: kyc private')
  then 'UPDATE 3.75 READY - optional KYC verification with a live face check; EMON HASAN approves (KYC VERIFIED)'
  else 'NOT READY - send this message to Claude' end as result;
