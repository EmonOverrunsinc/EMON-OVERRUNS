-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.33: QC Test: Add QC Test with every detail at once
-- The plain QC TEST form is printed from Download Forms and filled in on paper; then Add QC Test takes the goods, the Qty by
-- color (e.g. WHITE 220, MAROON 90, BLACK 100 = the Qty 410), the 10 checks, the mending limit (e.g. 60 PCS or 35%), the score
-- and the notes in one step (qc_add). The Qty prints as QTY FOUND on the 2 stickers. The page of a QC test can change all of it.
-- Needs 024_eo_office.sql and 025_qc_simple.sql. Safe to run again.
-- =====================================================================
do $$ begin
  if to_regclass('public.qc_tests') is null then raise exception 'Run 024_eo_office.sql first, then run this again.'; end if;
end $$;

alter table public.qc_tests add column if not exists qty int check (qty >= 0);
alter table public.qc_tests add column if not exists mending_max text;
alter table public.qc_tests add column if not exists qty_lines jsonb not null default '[]'::jsonb;

-- a number of pieces from what was written (digits only; empty = none)
create or replace function public.qc_pcs(p text) returns int
language sql immutable set search_path = '' as $$
  select nullif(left(regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g'), 9), '')::int;
$$;
revoke execute on function public.qc_pcs(text) from public, anon;

-- the Qty by color: up to 12 lines {c: the color in capitals, q: pieces}; empty lines are left out
create or replace function public.qc_lines(p jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('c', c, 'q', q) order by n), '[]'::jsonb)
  from (select n, nullif(left(upper(trim(coalesce(x ->> 'c', ''))), 30), '') as c, public.qc_pcs(x ->> 'q') as q
        from jsonb_array_elements(case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end) with ordinality as e(x, n)) s
  where (c is not null or q is not null) and n <= 12;
$$;
revoke execute on function public.qc_lines(jsonb) from public, anon;

-- the Qty: the colors added up when they have pieces, otherwise the Qty written
create or replace function public.qc_qty_of(p_lines jsonb, p_qty text) returns int
language sql immutable set search_path = '' as $$
  select coalesce((select sum((x ->> 'q')::int)::int from jsonb_array_elements(p_lines) x where x ->> 'q' is not null), public.qc_pcs(p_qty));
$$;
revoke execute on function public.qc_qty_of(jsonb, text) from public, anon;

-- 1. a new QC test: the number, the goods (with the Qty, the colors and the mending limit) and an empty result
create or replace function public.create_qc(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare t public.qc_tests; ln jsonb := public.qc_lines(p_data -> 'qty_lines'); me text := (select full_name from public.profiles where id = auth.uid()); yr text := to_char(current_date, 'YYYY');
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  insert into public.qc_tests (qc_no, serial_no, item, brand, batch, ctn, qty_lines, qty, mending_max, created_by_name)
  values ('QC-' || yr || '-' || lpad(public.next_counter('QC' || yr)::text, 4, '0'), nullif(left(trim(coalesce(p_data ->> 'serial_no', '')), 60), ''),
    nullif(left(trim(coalesce(p_data ->> 'item', '')), 120), ''), nullif(left(trim(coalesce(p_data ->> 'brand', '')), 80), ''), nullif(left(trim(coalesce(p_data ->> 'batch', '')), 60), ''),
    nullif(left(trim(coalesce(p_data ->> 'ctn', '')), 60), ''), ln, public.qc_qty_of(ln, p_data ->> 'qty'), nullif(left(upper(trim(coalesce(p_data ->> 'mending_max', ''))), 20), ''), me)
  returning * into t;
  insert into public.qc_results (qc_id) values (t.id);
  return jsonb_build_object('id', t.id, 'qc_no', t.qc_no);
end;
$$;
revoke execute on function public.create_qc(jsonb) from public, anon;
grant execute on function public.create_qc(jsonb) to authenticated;

-- 2. the result: p_data = { checks: {key: true}, numbers: {key: 5}, score: 70 (optional), remarks } and, when sent, the goods
--    (serial_no, item, brand, batch, ctn), qty_lines, qty and mending_max (anything not sent stays as it is).
--    Without a score the score is 100 minus 10 for each Fail.
create or replace function public.qc_save(p_id uuid, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare k text; ck jsonb := '{}'::jsonb; nm jsonb := '{}'::jsonb; n int := 0; sc int; t public.qc_tests; me text := (select full_name from public.profiles where id = auth.uid());
  ln jsonb := case when p_data ? 'qty_lines' then public.qc_lines(p_data -> 'qty_lines') end;
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
    serial_no = case when p_data ? 'serial_no' then nullif(left(trim(coalesce(p_data ->> 'serial_no', '')), 60), '') else serial_no end,
    item = case when p_data ? 'item' then nullif(left(trim(coalesce(p_data ->> 'item', '')), 120), '') else item end,
    brand = case when p_data ? 'brand' then nullif(left(trim(coalesce(p_data ->> 'brand', '')), 80), '') else brand end,
    batch = case when p_data ? 'batch' then nullif(left(trim(coalesce(p_data ->> 'batch', '')), 60), '') else batch end,
    ctn = case when p_data ? 'ctn' then nullif(left(trim(coalesce(p_data ->> 'ctn', '')), 60), '') else ctn end,
    qty_lines = coalesce(ln, qty_lines),
    qty = case when ln is not null or p_data ? 'qty' then public.qc_qty_of(coalesce(ln, qty_lines), p_data ->> 'qty') else qty end,
    mending_max = case when p_data ? 'mending_max' then nullif(left(upper(trim(coalesce(p_data ->> 'mending_max', ''))), 20), '') else mending_max end
  where id = p_id returning * into t;
  return jsonb_build_object('ok', true, 'found_count', n, 'score', sc, 'qty', t.qty, 'mending_max', t.mending_max);
end;
$$;
revoke execute on function public.qc_save(uuid, jsonb) from public, anon;
grant execute on function public.qc_save(uuid, jsonb) to authenticated;

-- 3. Add QC Test: the new QC test with its result in one step
create or replace function public.qc_add(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c jsonb;
begin
  c := public.create_qc(p_data);
  return c || public.qc_save((c ->> 'id')::uuid, p_data);
end;
$$;
revoke execute on function public.qc_add(jsonb) from public, anon;
grant execute on function public.qc_add(jsonb) to authenticated;

select 'UPDATE 3.33 READY - Add QC Test: Qty by color, mending limit and notes' as result;
