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
