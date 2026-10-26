-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.33: QC Test: the Qty of the goods and the mending limit
-- The Qty (pieces, e.g. 420) prints in Goods on the QC TEST form and as QTY FOUND on the 2 stickers. The mending limit
-- (e.g. 60 PCS or 35%) prints in check 9: MENDING NOT MORE THAN 35%. Both can be written when the QC test is made and
-- when its result is saved. (The notes are kept in remarks, as before.) Needs 024_eo_office.sql. Safe to run again.
-- =====================================================================
do $$ begin
  if to_regclass('public.qc_tests') is null then raise exception 'Run 024_eo_office.sql first, then run this again.'; end if;
end $$;

alter table public.qc_tests add column if not exists qty int check (qty >= 0);
alter table public.qc_tests add column if not exists mending_max text;

-- a number of pieces from what was written (digits only; empty = none)
create or replace function public.qc_pcs(p text) returns int
language sql immutable set search_path = '' as $$
  select nullif(left(regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g'), 9), '')::int;
$$;
revoke execute on function public.qc_pcs(text) from public, anon;

-- 1. a new QC form: the number, the goods (also the Qty and the mending limit) and the empty result
create or replace function public.create_qc(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare t public.qc_tests; me text := (select full_name from public.profiles where id = auth.uid()); yr text := to_char(current_date, 'YYYY');
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  insert into public.qc_tests (qc_no, serial_no, item, brand, batch, ctn, qty, mending_max, created_by_name)
  values ('QC-' || yr || '-' || lpad(public.next_counter('QC' || yr)::text, 4, '0'), nullif(left(trim(coalesce(p_data ->> 'serial_no', '')), 60), ''),
    nullif(left(trim(coalesce(p_data ->> 'item', '')), 120), ''), nullif(left(trim(coalesce(p_data ->> 'brand', '')), 80), ''), nullif(left(trim(coalesce(p_data ->> 'batch', '')), 60), ''),
    nullif(left(trim(coalesce(p_data ->> 'ctn', '')), 60), ''), public.qc_pcs(p_data ->> 'qty'), nullif(left(upper(trim(coalesce(p_data ->> 'mending_max', ''))), 20), ''), me)
  returning * into t;
  insert into public.qc_results (qc_id) values (t.id);
  return jsonb_build_object('id', t.id, 'qc_no', t.qc_no);
end;
$$;
revoke execute on function public.create_qc(jsonb) from public, anon;
grant execute on function public.create_qc(jsonb) to authenticated;

-- 2. the result: p_data = { checks: {key: true}, numbers: {key: 5}, score: 70 (optional), remarks, qty, mending_max }.
--    Without a score the score is 100 minus 10 for each Fail. The Qty and the mending limit stay as they are when not sent.
create or replace function public.qc_save(p_id uuid, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare k text; ck jsonb := '{}'::jsonb; nm jsonb := '{}'::jsonb; n int := 0; sc int; t public.qc_tests; me text := (select full_name from public.profiles where id = auth.uid());
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
  update public.qc_tests set status = 'done', found_count = n, score = sc, tested_at = now(), tested_by_name = me,
    qty = case when p_data ? 'qty' then public.qc_pcs(p_data ->> 'qty') else qty end,
    mending_max = case when p_data ? 'mending_max' then nullif(left(upper(trim(coalesce(p_data ->> 'mending_max', ''))), 20), '') else mending_max end
  where id = p_id returning * into t;
  return jsonb_build_object('ok', true, 'found_count', n, 'score', sc, 'qty', t.qty, 'mending_max', t.mending_max);
end;
$$;
revoke execute on function public.qc_save(uuid, jsonb) from public, anon;
grant execute on function public.qc_save(uuid, jsonb) to authenticated;

select 'UPDATE 3.33 READY - QC Test: Qty, mending limit and notes' as result;
