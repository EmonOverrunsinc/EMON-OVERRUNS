-- =====================================================================
-- EMON OVERRUNS E-PORTAL - updates 3.1 to 3.7 in ONE paste: EO-Office (QC Test, Collection Voucher), QC made simple,
-- EO-Office fixes, and the Released Notice on the E-Bill.
-- Paste ALL of this into the Supabase SQL Editor and press Run once. It is safe to run again.
-- (It is the same as running 024, 025, 026 and 027 one after the other.)
-- =====================================================================

-- >>>>>>>>>> 024_eo_office.sql <<<<<<<<<<
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.1: EO-Office (QC Test and Collection Voucher)
--
-- QC TEST: a quality check form. The form has a header (serial no, item, brand, batch, CTN) and 10 problems to look for
-- (COLORS EQUALLY, SIZES EQUALLY, UNFULFILLED BUNDLE COLORS, WRONG BUNDLE, STAIN, MISSING LABEL, MISSING TAG, MISTAKE
-- PACKAGE, MENDING MORE THAN __, LABEL INFORMATION INCORRECT). Every problem found takes 10 points off 100.
-- Each form gets a number QC-YYYY-#### (PDF417 barcode on the paper) and a PRIVATE CODE, printed on the blank form.
-- The server keeps only a scrambled (hashed) copy of the private code. The form stays LOCKED: anyone who scans the
-- barcode sees only the empty form. The result, the uploaded paper copy and the PDF copy need the private code
-- (5 wrong codes lock the form until the Director gives a new code).
--
-- COLLECTION VOUCHER: money collected, recorded month by month, with the receipt picture (the empty paper around it is cut off
-- in the portal before it is saved).
--
-- Run once in the Supabase SQL Editor after 023_purchase_orders.sql. It is safe to run again.
-- =====================================================================

-- ---------- QC TEST ----------
create table if not exists public.qc_tests (
  id uuid primary key default gen_random_uuid(),
  qc_no text unique,
  serial_no text,
  item text not null,
  brand text,
  batch text,
  ctn text,
  status text not null default 'locked' check (status in ('locked','done')),
  found_count int,
  score int,
  tested_at timestamptz,
  tested_by_name text,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists qc_tests_created_by_idx on public.qc_tests(created_by);
create index if not exists qc_tests_created_idx on public.qc_tests(created_at);
alter table public.qc_tests enable row level security;
revoke all on public.qc_tests from anon;
grant select on public.qc_tests to authenticated;
drop policy if exists "qc: read" on public.qc_tests;
create policy "qc: read" on public.qc_tests for select to authenticated using ((select public.is_staff()) and (select public.has_module('eooffice')));

-- The private part: the hashed private code, the wrong-code counter and the result. Nobody reads this table directly.
create table if not exists public.qc_results (
  qc_id uuid primary key references public.qc_tests(id) on delete cascade,
  code_hash text not null,
  failed_attempts int not null default 0,
  checks jsonb not null default '{}'::jsonb,
  mending_limit text,
  remarks text,
  docs text[] not null default '{}'
);
alter table public.qc_results enable row level security;
revoke all on public.qc_results from anon, authenticated;

create or replace function public.qc_can_write() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_staff() and public.has_module('eooffice');
$$;
revoke execute on function public.qc_can_write() from public, anon;
grant execute on function public.qc_can_write() to authenticated;

-- A private code looks like 7K3F-9A2C-D41E. It is never stored as written.
create or replace function public.qc_norm(p_code text) returns text
language sql immutable set search_path = '' as $$
  select upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
$$;
create or replace function public.qc_hash(p_id uuid, p_code text) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(p_id::text || ':' || public.qc_norm(p_code), 'UTF8')), 'hex');
$$;
create or replace function public.qc_make_code() returns text
language sql volatile set search_path = '' as $$
  select upper(substr(h, 1, 4) || '-' || substr(h, 5, 4) || '-' || substr(h, 9, 4))
  from (select replace(gen_random_uuid()::text, '-', '') as h) x;
$$;
revoke execute on function public.qc_norm(text), public.qc_hash(uuid, text), public.qc_make_code() from public, anon, authenticated;

-- Checks the private code. Gives 'ok', 'wrong', 'locked' (5 wrong codes) or 'none'. A wrong code is counted; this
-- function does not raise, so the count is kept.
create or replace function public.qc_try(p_id uuid, p_code text) returns text
language plpgsql security definer set search_path = '' as $$
declare r public.qc_results;
begin
  select * into r from public.qc_results where qc_id = p_id for update;
  if not found then return 'none'; end if;
  if r.failed_attempts >= 5 then return 'locked'; end if;
  if r.code_hash = public.qc_hash(p_id, p_code) then
    if r.failed_attempts > 0 then update public.qc_results set failed_attempts = 0 where qc_id = p_id; end if;
    return 'ok';
  end if;
  update public.qc_results set failed_attempts = failed_attempts + 1 where qc_id = p_id;
  return case when r.failed_attempts + 1 >= 5 then 'locked' else 'wrong' end;
end;
$$;
revoke execute on function public.qc_try(uuid, text) from public, anon, authenticated;

create or replace function public.qc_bad(p_state text, p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('ok', false, 'state', p_state,
    'left', greatest(5 - coalesce((select failed_attempts from public.qc_results where qc_id = p_id), 5), 0));
$$;
revoke execute on function public.qc_bad(text, uuid) from public, anon, authenticated;

-- A new QC form: the number, the private code (given back once, to print on the blank form) and the empty, locked form.
create or replace function public.create_qc(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare t public.qc_tests; code text; me text := (select full_name from public.profiles where id = auth.uid()); yr text := to_char(current_date, 'YYYY');
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  if coalesce(trim(p_data ->> 'item'), '') = '' then raise exception 'Write the item'; end if;
  insert into public.qc_tests (qc_no, serial_no, item, brand, batch, ctn, created_by_name)
  values ('QC-' || yr || '-' || lpad(public.next_counter('QC' || yr)::text, 4, '0'), nullif(left(trim(coalesce(p_data ->> 'serial_no', '')), 60), ''),
    left(trim(p_data ->> 'item'), 120), nullif(left(trim(coalesce(p_data ->> 'brand', '')), 80), ''), nullif(left(trim(coalesce(p_data ->> 'batch', '')), 60), ''),
    nullif(left(trim(coalesce(p_data ->> 'ctn', '')), 60), ''), me)
  returning * into t;
  code := public.qc_make_code();
  insert into public.qc_results (qc_id, code_hash) values (t.id, public.qc_hash(t.id, code));
  return jsonb_build_object('id', t.id, 'qc_no', t.qc_no, 'code', code);
end;
$$;
revoke execute on function public.create_qc(jsonb) from public, anon;
grant execute on function public.create_qc(jsonb) to authenticated;

-- Opens the private part with the code: the checks, the remarks and the paper copies.
create or replace function public.qc_open(p_id uuid, p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s text; r public.qc_results;
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  s := public.qc_try(p_id, p_code);
  if s = 'none' then raise exception 'QC form not found'; end if;
  if s <> 'ok' then return public.qc_bad(s, p_id); end if;
  select * into r from public.qc_results where qc_id = p_id;
  return jsonb_build_object('ok', true, 'checks', r.checks, 'mending_limit', r.mending_limit, 'remarks', r.remarks, 'docs', to_jsonb(r.docs));
end;
$$;
revoke execute on function public.qc_open(uuid, text) from public, anon;
grant execute on function public.qc_open(uuid, text) to authenticated;

-- Saves the result (needs the code again): each problem found takes 10 points off 100.
create or replace function public.qc_save(p_id uuid, p_code text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare s text; k text; ck jsonb := '{}'::jsonb; n int := 0; me text := (select full_name from public.profiles where id = auth.uid());
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  s := public.qc_try(p_id, p_code);
  if s = 'none' then raise exception 'QC form not found'; end if;
  if s <> 'ok' then return public.qc_bad(s, p_id); end if;
  foreach k in array array['colors','sizes','bundle_colors','wrong_bundle','stain','missing_label','missing_tag','mistake_package','mending','label_info'] loop
    if coalesce((p_data -> 'checks' ->> k)::boolean, false) then n := n + 1; ck := ck || jsonb_build_object(k, true); end if;
  end loop;
  update public.qc_results set checks = ck, mending_limit = nullif(left(trim(coalesce(p_data ->> 'mending_limit', '')), 20), ''),
    remarks = nullif(left(trim(coalesce(p_data ->> 'remarks', '')), 1000), '') where qc_id = p_id;
  update public.qc_tests set status = 'done', found_count = n, score = 100 - 10 * n, tested_at = now(), tested_by_name = me where id = p_id;
  return jsonb_build_object('ok', true, 'found_count', n, 'score', 100 - 10 * n);
end;
$$;
revoke execute on function public.qc_save(uuid, text, jsonb) from public, anon;
grant execute on function public.qc_save(uuid, text, jsonb) to authenticated;

-- The uploaded paper copies of the filled form (up to 6). Gives back the files that are no longer used.
create or replace function public.qc_set_docs(p_id uuid, p_code text, p_docs text[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s text; old text[];
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  s := public.qc_try(p_id, p_code);
  if s = 'none' then raise exception 'QC form not found'; end if;
  if s <> 'ok' then return public.qc_bad(s, p_id); end if;
  if coalesce(array_length(p_docs, 1), 0) > 6 then raise exception 'Up to 6 pictures'; end if;
  if exists (select 1 from unnest(p_docs) x where x not like 'qc/' || p_id || '/%') then raise exception 'Wrong file'; end if;
  select docs into old from public.qc_results where qc_id = p_id;
  update public.qc_results set docs = coalesce(p_docs, '{}') where qc_id = p_id;
  return jsonb_build_object('ok', true, 'removed', to_jsonb(array(select x from unnest(old) x where x <> all (coalesce(p_docs, '{}')))));
end;
$$;
revoke execute on function public.qc_set_docs(uuid, text, text[]) from public, anon;
grant execute on function public.qc_set_docs(uuid, text, text[]) to authenticated;

-- A new private code: the Director any time; the person who made the form only until a result is saved (the blank form was lost).
create or replace function public.qc_new_code(p_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare t public.qc_tests; code text;
begin
  select * into t from public.qc_tests where id = p_id for update;
  if not found then raise exception 'QC form not found'; end if;
  if not (public.is_admin() or (t.created_by = auth.uid() and t.status = 'locked' and public.qc_can_write())) then raise exception 'Only the Director can give a new code'; end if;
  code := public.qc_make_code();
  update public.qc_results set code_hash = public.qc_hash(p_id, code), failed_attempts = 0 where qc_id = p_id;
  return code;
end;
$$;
revoke execute on function public.qc_new_code(uuid) from public, anon;
grant execute on function public.qc_new_code(uuid) to authenticated;

-- The Director deletes a QC form; gives back the paper copies so the portal deletes the files.
create or replace function public.delete_qc(p_id uuid) returns text[]
language plpgsql security definer set search_path = '' as $$
declare gone text[];
begin
  if not public.is_admin() then raise exception 'Only the Director can delete a QC form'; end if;
  select docs into gone from public.qc_results where qc_id = p_id;
  delete from public.qc_tests where id = p_id;
  return coalesce(gone, '{}');
end;
$$;
revoke execute on function public.delete_qc(uuid) from public, anon;
grant execute on function public.delete_qc(uuid) to authenticated;

-- ---------- COLLECTION VOUCHER ----------
create table if not exists public.collection_vouchers (
  id uuid primary key default gen_random_uuid(),
  cv_no text unique,
  cv_date date not null default ((now() at time zone 'Asia/Manila')::date),
  received_from text not null,
  amount numeric(14,2) not null check (amount > 0),
  method text not null default 'cash' check (method in ('cash','bank','gcash','check','other')),
  reference_no text,
  note text,
  receipt_path text,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists collection_vouchers_date_idx on public.collection_vouchers(cv_date);
create index if not exists collection_vouchers_created_by_idx on public.collection_vouchers(created_by);
alter table public.collection_vouchers enable row level security;
revoke all on public.collection_vouchers from anon;
grant select on public.collection_vouchers to authenticated;
drop policy if exists "cv: read" on public.collection_vouchers;
create policy "cv: read" on public.collection_vouchers for select to authenticated using ((select public.is_staff()) and (select public.has_module('eooffice')));

-- New voucher (p_id null) or a change: the Director any time, the person who made it for 24 hours.
create or replace function public.save_collection(p_id uuid, p_data jsonb) returns public.collection_vouchers
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare v public.collection_vouchers; me text := (select full_name from public.profiles where id = auth.uid()); amt numeric; mth text;
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  if coalesce(trim(p_data ->> 'received_from'), '') = '' then raise exception 'Write who the money was collected from'; end if;
  amt := coalesce(nullif(p_data ->> 'amount', '')::numeric, 0);
  if amt <= 0 then raise exception 'Write the amount collected'; end if;
  mth := case when p_data ->> 'method' in ('cash','bank','gcash','check','other') then p_data ->> 'method' else 'cash' end;
  if p_id is null then
    insert into public.collection_vouchers (cv_no, cv_date, received_from, amount, method, reference_no, note, created_by_name)
    values ('CV-' || to_char(coalesce(nullif(p_data ->> 'cv_date', '')::date, current_date), 'YYYYMM') || '-' || lpad(public.next_counter('CV' || to_char(coalesce(nullif(p_data ->> 'cv_date', '')::date, current_date), 'YYYYMM'))::text, 3, '0'),
      coalesce(nullif(p_data ->> 'cv_date', '')::date, current_date), left(trim(p_data ->> 'received_from'), 120), round(amt, 2), mth,
      nullif(left(trim(coalesce(p_data ->> 'reference_no', '')), 60), ''), nullif(left(trim(coalesce(p_data ->> 'note', '')), 300), ''), me)
    returning * into v;
    return v;
  end if;
  select * into v from public.collection_vouchers where id = p_id for update;
  if not found then raise exception 'Collection voucher not found'; end if;
  if not (public.is_admin() or (v.created_by = auth.uid() and v.created_at > now() - interval '24 hours')) then
    raise exception 'Only the Director can change this voucher now (the person who made it can change it for 24 hours)';
  end if;
  update public.collection_vouchers set cv_date = coalesce(nullif(p_data ->> 'cv_date', '')::date, cv_date), received_from = left(trim(p_data ->> 'received_from'), 120),
    amount = round(amt, 2), method = mth, reference_no = nullif(left(trim(coalesce(p_data ->> 'reference_no', '')), 60), ''),
    note = nullif(left(trim(coalesce(p_data ->> 'note', '')), 300), ''), updated_at = now()
  where id = p_id returning * into v;
  return v;
end;
$$;
revoke execute on function public.save_collection(uuid, jsonb) from public, anon;
grant execute on function public.save_collection(uuid, jsonb) to authenticated;

-- The receipt picture (already cleaned and cut in the portal). Gives back the old file so it is deleted.
create or replace function public.set_collection_receipt(p_id uuid, p_path text) returns text
language plpgsql security definer set search_path = '' as $$
declare v public.collection_vouchers;
begin
  select * into v from public.collection_vouchers where id = p_id for update;
  if not found then raise exception 'Collection voucher not found'; end if;
  if not (public.is_admin() or (v.created_by = auth.uid() and v.created_at > now() - interval '24 hours')) then raise exception 'Only the Director can change this voucher now'; end if;
  if p_path is not null and p_path not like 'collection/' || p_id || '/%' then raise exception 'Wrong file'; end if;
  update public.collection_vouchers set receipt_path = p_path, updated_at = now() where id = p_id;
  return v.receipt_path;
end;
$$;
revoke execute on function public.set_collection_receipt(uuid, text) from public, anon;
grant execute on function public.set_collection_receipt(uuid, text) to authenticated;

create or replace function public.delete_collection(p_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v public.collection_vouchers;
begin
  if not public.is_admin() then raise exception 'Only the Director can delete a collection voucher'; end if;
  select * into v from public.collection_vouchers where id = p_id;
  if not found then raise exception 'Collection voucher not found'; end if;
  delete from public.collection_vouchers where id = p_id;
  return v.receipt_path;
end;
$$;
revoke execute on function public.delete_collection(uuid) from public, anon;
grant execute on function public.delete_collection(uuid) to authenticated;

select 'UPDATE 3.1 READY - EO-Office' as result;

-- >>>>>>>>>> 025_qc_simple.sql <<<<<<<<<<
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.3: QC Test made simple (no lock, no private code)
-- The QC form is a ticket: make it (QC-YYYY-####, barcode), print it, check the goods on the paper, then open it in the portal
-- (scan the barcode or search the number) and update: a tick and a number for each problem, the total score (written by the
-- person; suggested as 100 minus 10 for each tick), remarks and the paper copy.
-- Run once in the Supabase SQL Editor after 024_eo_office.sql. It is safe to run again.
-- =====================================================================

-- the old lock and private code go away
drop function if exists public.qc_open(uuid, text);
drop function if exists public.qc_save(uuid, text, jsonb);
drop function if exists public.qc_set_docs(uuid, text, text[]);
drop function if exists public.qc_new_code(uuid);
drop function if exists public.qc_try(uuid, text);
drop function if exists public.qc_bad(text, uuid);
drop function if exists public.qc_hash(uuid, text);
drop function if exists public.qc_make_code();
drop function if exists public.qc_norm(text);
drop function if exists public.create_qc(jsonb);

alter table public.qc_results alter column code_hash drop not null;
alter table public.qc_results add column if not exists numbers jsonb not null default '{}'::jsonb;
-- the result is read by staff with EO-Office access (changes only through the functions below)
grant select on public.qc_results to authenticated;
drop policy if exists "qcr: read" on public.qc_results;
create policy "qcr: read" on public.qc_results for select to authenticated using ((select public.is_staff()) and (select public.has_module('eooffice')));

-- A new QC form: the number and the empty form.
create or replace function public.create_qc(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare t public.qc_tests; me text := (select full_name from public.profiles where id = auth.uid()); yr text := to_char(current_date, 'YYYY');
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  if coalesce(trim(p_data ->> 'item'), '') = '' then raise exception 'Write the item'; end if;
  insert into public.qc_tests (qc_no, serial_no, item, brand, batch, ctn, created_by_name)
  values ('QC-' || yr || '-' || lpad(public.next_counter('QC' || yr)::text, 4, '0'), nullif(left(trim(coalesce(p_data ->> 'serial_no', '')), 60), ''),
    left(trim(p_data ->> 'item'), 120), nullif(left(trim(coalesce(p_data ->> 'brand', '')), 80), ''), nullif(left(trim(coalesce(p_data ->> 'batch', '')), 60), ''),
    nullif(left(trim(coalesce(p_data ->> 'ctn', '')), 60), ''), me)
  returning * into t;
  insert into public.qc_results (qc_id) values (t.id);
  return jsonb_build_object('id', t.id, 'qc_no', t.qc_no);
end;
$$;
revoke execute on function public.create_qc(jsonb) from public, anon;
grant execute on function public.create_qc(jsonb) to authenticated;

-- Saves the result: p_data = { checks: {key: true}, numbers: {key: 5}, score: 70 (optional), remarks }.
-- Without a score the score is 100 minus 10 for each tick.
create or replace function public.qc_save(p_id uuid, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare k text; ck jsonb := '{}'::jsonb; nm jsonb := '{}'::jsonb; n int := 0; sc int; me text := (select full_name from public.profiles where id = auth.uid());
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  if not exists (select 1 from public.qc_tests where id = p_id) then raise exception 'QC form not found'; end if;
  foreach k in array array['colors','sizes','bundle_colors','wrong_bundle','stain','missing_label','missing_tag','mistake_package','mending','label_info'] loop
    if coalesce((p_data -> 'checks' ->> k)::boolean, false) then n := n + 1; ck := ck || jsonb_build_object(k, true); end if;
    if nullif(trim(coalesce(p_data -> 'numbers' ->> k, '')), '') is not null then nm := nm || jsonb_build_object(k, left(trim(p_data -> 'numbers' ->> k), 12)); end if;
  end loop;
  sc := coalesce(nullif(trim(coalesce(p_data ->> 'score', '')), '')::int, 100 - 10 * n);
  if sc < 0 or sc > 100 then raise exception 'The score is from 0 to 100'; end if;
  update public.qc_results set checks = ck, numbers = nm, remarks = nullif(left(trim(coalesce(p_data ->> 'remarks', '')), 1000), '') where qc_id = p_id;
  update public.qc_tests set status = 'done', found_count = n, score = sc, tested_at = now(), tested_by_name = me where id = p_id;
  return jsonb_build_object('ok', true, 'found_count', n, 'score', sc);
end;
$$;
revoke execute on function public.qc_save(uuid, jsonb) from public, anon;
grant execute on function public.qc_save(uuid, jsonb) to authenticated;

-- The paper copies of the filled form (up to 6). Gives back the files that are no longer used.
create or replace function public.qc_set_docs(p_id uuid, p_docs text[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare old text[];
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  if not exists (select 1 from public.qc_results where qc_id = p_id) then raise exception 'QC form not found'; end if;
  if coalesce(array_length(p_docs, 1), 0) > 6 then raise exception 'Up to 6 pictures'; end if;
  if exists (select 1 from unnest(p_docs) x where x not like 'qc/' || p_id || '/%') then raise exception 'Wrong file'; end if;
  select docs into old from public.qc_results where qc_id = p_id;
  update public.qc_results set docs = coalesce(p_docs, '{}') where qc_id = p_id;
  return jsonb_build_object('ok', true, 'removed', to_jsonb(array(select x from unnest(old) x where x <> all (coalesce(p_docs, '{}')))));
end;
$$;
revoke execute on function public.qc_set_docs(uuid, text[]) from public, anon;
grant execute on function public.qc_set_docs(uuid, text[]) to authenticated;

select 'UPDATE 3.3 READY - QC Test simple' as result;

-- >>>>>>>>>> 026_eo_office_fixes.sql <<<<<<<<<<
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.4: EO-Office fixes
--  1. QC paper copies and collection receipts (and purchase order photos / voice notes) can be read only by the people who may
--     see those sections (before, any signed-in person could read the files if they knew where they were)
--  2. People with EO-Office can delete (replace) those files, not only the uploader within 24 hours
--  3. A collection receipt can be changed only by people with EO-Office access
--  4. The old private-code column of QC forms is removed; two people changing the paper copies at once cannot lose a file
-- Run once in the Supabase SQL Editor after 025_qc_simple.sql. It is safe to run again.
-- =====================================================================

drop policy if exists "storage records: eooffice files" on storage.objects;
create policy "storage records: eooffice files" on storage.objects as restrictive for select to authenticated
  using (bucket_id <> 'records' or coalesce((storage.foldername(name))[1], '') not in ('qc', 'collection')
         or ((select public.is_staff()) and (select public.has_module('eooffice'))));

drop policy if exists "storage records: purchase files" on storage.objects;
create policy "storage records: purchase files" on storage.objects as restrictive for select to authenticated
  using (bucket_id <> 'records' or coalesce((storage.foldername(name))[1], '') <> 'purchase' or (select public.is_staff()));

drop policy if exists "storage records: eooffice delete" on storage.objects;
create policy "storage records: eooffice delete" on storage.objects for delete to authenticated
  using (bucket_id = 'records' and coalesce((storage.foldername(name))[1], '') in ('qc', 'collection')
         and (select public.is_staff()) and (select public.has_module('eooffice')));

alter table public.qc_results drop column if exists code_hash;

create or replace function public.set_collection_receipt(p_id uuid, p_path text) returns text
language plpgsql security definer set search_path = '' as $$
declare v public.collection_vouchers;
begin
  if not (public.is_admin() or public.qc_can_write()) then raise exception 'Not allowed'; end if;
  select * into v from public.collection_vouchers where id = p_id for update;
  if not found then raise exception 'Collection voucher not found'; end if;
  if not (public.is_admin() or (v.created_by = auth.uid() and v.created_at > now() - interval '24 hours')) then raise exception 'Only the Director can change this voucher now'; end if;
  if p_path is not null and p_path not like 'collection/' || p_id || '/%' then raise exception 'Wrong file'; end if;
  update public.collection_vouchers set receipt_path = p_path, updated_at = now() where id = p_id;
  return v.receipt_path;
end;
$$;
revoke execute on function public.set_collection_receipt(uuid, text) from public, anon;
grant execute on function public.set_collection_receipt(uuid, text) to authenticated;

create or replace function public.qc_set_docs(p_id uuid, p_docs text[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare old text[];
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  perform 1 from public.qc_results where qc_id = p_id for update;
  if not found then raise exception 'QC form not found'; end if;
  if coalesce(array_length(p_docs, 1), 0) > 6 then raise exception 'Up to 6 pictures'; end if;
  if exists (select 1 from unnest(p_docs) x where x not like 'qc/' || p_id || '/%') then raise exception 'Wrong file'; end if;
  select docs into old from public.qc_results where qc_id = p_id;
  update public.qc_results set docs = coalesce(p_docs, '{}') where qc_id = p_id;
  return jsonb_build_object('ok', true, 'removed', to_jsonb(array(select x from unnest(old) x where x <> all (coalesce(p_docs, '{}')))));
end;
$$;
revoke execute on function public.qc_set_docs(uuid, text[]) from public, anon;
grant execute on function public.qc_set_docs(uuid, text[]) to authenticated;

select 'UPDATE 3.4 READY - EO-Office fixes' as result;

-- >>>>>>>>>> 027_ebill_release.sql <<<<<<<<<<
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.7: Released Notice written on the E-Bill itself (no order letter, no Director Portal)
-- The person with E-Bill access writes the Released Notice on the e-bill: released date, price per box (PHP), exchange rate
-- (BDT for 1 PHP), shipping fee (BDT), shipping bill no. The portal works out
--   price per box x total boxes = PHP, x exchange rate = released charge (BDT), + shipping fee = added to the total cost.
-- The e-bill becomes RELEASED at once; the notice is numbered RN-YYYYMM-###. The Director can undo a notice that has no
-- sales report yet (the e-bill goes back to SHIP).
-- Run once in the Supabase SQL Editor after 026_eo_office_fixes.sql. It is safe to run again.
-- =====================================================================

create or replace function public.release_stock_bill(p_id uuid, p_data jsonb) returns public.stock_bills
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare
  b public.stock_bills; me text := (select full_name from public.profiles where id = auth.uid());
  d date := nullif(p_data ->> 'release_date', '')::date;
  price numeric := nullif(p_data ->> 'price_per_box', '')::numeric;
  rate numeric := nullif(p_data ->> 'exchange_rate', '')::numeric;
  ship numeric := nullif(p_data ->> 'shipping_cost', '')::numeric;
  php numeric; bdt numeric; no text;
begin
  if not public.can_write('inventory') then raise exception 'You do not have access to release e-bills'; end if;
  select * into b from public.stock_bills where id = p_id for update;
  if b.id is null then raise exception 'E-Bill not found'; end if;
  if b.status not in ('shipped', 'arrived') then
    raise exception 'E-Bill % is already at %. Only an e-bill at SHIP can be released', b.bill_no, public.ebill_status_name(b.status);
  end if;
  if coalesce(b.total_boxes, 0) <= 0 then raise exception 'E-Bill % has no total boxes. Correct the e-bill first', b.bill_no; end if;
  if d is null then raise exception 'Enter the released date'; end if;
  if b.shipment_date is not null and d < b.shipment_date then raise exception 'The released date cannot be before the shipment date'; end if;
  if coalesce(price, 0) <= 0 then raise exception 'Enter the price per box (PHP)'; end if;
  if coalesce(rate, 0) <= 0 then raise exception 'Enter the exchange rate (BDT for 1 PHP)'; end if;
  if ship is null or ship < 0 then raise exception 'Enter the shipping fee (0 if there is none)'; end if;
  php := round(price * b.total_boxes, 2);
  bdt := round(php * rate, 2);
  no := 'RN-' || to_char(d, 'YYYYMM') || '-' || lpad(public.next_counter('RN' || to_char(d, 'YYYYMM'))::text, 3, '0');
  perform public.allow_record_change();
  update public.stock_bills set status = 'released', release_date = d, shipping_cost = ship, shipping_bill_no = nullif(left(trim(coalesce(p_data ->> 'shipping_bill_no', '')), 60), ''),
    release_order_no = no, released_at = now(), release_price_per_box = price, release_exchange_rate = rate, release_php = php, release_bdt = bdt
  where id = p_id returning * into b;
  insert into public.stock_bill_events (stock_bill_id, action, note, actor, actor_name)
  values (p_id, 'released by ' || no,
    b.total_boxes || ' boxes × PHP ' || to_char(price, 'FM999,999,999,990.00') || ' = PHP ' || to_char(php, 'FM999,999,999,990.00') || ' × '
      || rtrim(rtrim(to_char(rate, 'FM999,990.0000'), '0'), '.') || ' = BDT ' || to_char(bdt, 'FM999,999,999,990.00') || ' · Shipping fee BDT ' || to_char(ship, 'FM999,999,999,990.00'),
    auth.uid(), me);
  return b;
end;
$$;
revoke execute on function public.release_stock_bill(uuid, jsonb) from public, anon;
grant execute on function public.release_stock_bill(uuid, jsonb) to authenticated;

create or replace function public.unrelease_stock_bill(p_id uuid) returns public.stock_bills
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare b public.stock_bills; me text := (select full_name from public.profiles where id = auth.uid()); old text;
begin
  if not public.is_admin() then raise exception 'Only the Director can undo a Released Notice'; end if;
  select * into b from public.stock_bills where id = p_id for update;
  if b.id is null then raise exception 'E-Bill not found'; end if;
  if b.status <> 'released' then raise exception 'E-Bill % is at %: a Released Notice can be undone only while it is RELEASED', b.bill_no, public.ebill_status_name(b.status); end if;
  if exists (select 1 from public.stock_bill_entries x where x.stock_bill_id = p_id and x.entry_type = 'sales') then
    raise exception 'E-Bill % has a sales report. Delete it first, then undo the Released Notice', b.bill_no;
  end if;
  old := b.release_order_no;
  perform public.allow_record_change();
  update public.stock_bills set status = 'shipped', release_date = null, shipping_cost = null, shipping_bill_no = null, release_order_no = null, released_at = null,
    release_price_per_box = null, release_exchange_rate = null, release_php = null, release_bdt = null where id = p_id returning * into b;
  insert into public.stock_bill_events (stock_bill_id, action, note, actor, actor_name) values (p_id, 'released notice undone', old, auth.uid(), me);
  return b;
end;
$$;
revoke execute on function public.unrelease_stock_bill(uuid) from public, anon;
grant execute on function public.unrelease_stock_bill(uuid) to authenticated;

select 'UPDATE 3.7 READY - E-Bill Released Notice' as result;

select 'ALL DONE - updates 3.1 to 3.7 are in' as result;
