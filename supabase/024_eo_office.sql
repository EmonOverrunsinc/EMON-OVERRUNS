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
