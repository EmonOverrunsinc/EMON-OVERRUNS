-- =====================================================================
-- EMON OVERRUNS E-PORTAL - RUN THIS ONE FILE: updates 3.31 (second part), 3.32 and 3.33 together
--   3.31  no Employee (HR) access any more: 11 EO-Office gives Employees, Payroll and Job Applications  (041_eooffice_hr.sql)
--   3.32  a purchase order takes up to 5 product photos (was 2)                                          (042_po_photos.sql)
--   3.33  QC Test: the Qty of the goods and the mending limit (e.g. 60 PCS or 35%)                       (043_qc_qty.sql)
-- Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again (also when some of these already ran).
-- The last line checks the server and says: UPDATE 3.31 + 3.32 + 3.33 READY - ...
-- =====================================================================

-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.31: no "Employee (HR)" menu access any more: 11 EO-Office gives Employees, Payroll
-- and Job Applications too. Every check of the old HR access now asks for EO-Office, and the old HR access is taken
-- off every login and employee (the Director ticks 11 EO-Office for the people who need it). Safe to run again.
-- =====================================================================

-- 1. the HR access is EO-Office (the server checks 'employees' in many places: they all follow EO-Office now)
create or replace function public.has_module(m text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active'
    and (p.role = 'admin' or p.modules is null or (case when m = 'employees' then 'eooffice' else m end) = any(p.modules)));
$$;
create or replace function public.can_write(m text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active'
    and (p.role = 'admin' or (p.role = 'staff' and (p.modules is null or (case when m = 'employees' then 'eooffice' else m end) = any(p.modules)))));
$$;
revoke execute on function public.has_module(text) from public, anon;
revoke execute on function public.can_write(text) from public, anon;
grant execute on function public.has_module(text) to authenticated;
grant execute on function public.can_write(text) to authenticated;

-- 2. the old HR access is taken off (it gives nothing any more)
do $$
begin
  perform public.allow_record_change();
  update public.employees set modules = array_remove(modules, 'employees') where 'employees' = any(modules);
  update public.profiles set modules = array_remove(modules, 'employees') where 'employees' = any(modules);
end $$;

select 'UPDATE 3.31 READY - EO-Office gives Employees, Payroll and Job Applications (no Employee (HR))' as result;

-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.32: a purchase order takes up to 5 product photos (it was 2). The approved purchase
-- order keeps a small copy of each of them (up to 5) for its PDF. Needs 023_purchase_orders.sql. Safe to run again.
-- =====================================================================
do $$ begin
  if to_regclass('public.purchase_orders') is null then raise exception 'Run 023_purchase_orders.sql first, then run this again.'; end if;
end $$;

-- 1. the product photos (up to 5), set by the maker after the upload
create or replace function public.set_purchase_photos(p_id uuid, p_photos text[]) returns public.purchase_orders
language plpgsql security definer set search_path = '' as $$
declare po public.purchase_orders;
begin
  select * into po from public.purchase_orders where id = p_id for update;
  if not found then raise exception 'Purchase order not found'; end if;
  if po.status not in ('pending','negotiation') then raise exception 'The photos cannot be changed now'; end if;
  if not (public.is_admin() or po.created_by = auth.uid()) then raise exception 'Not allowed'; end if;
  if coalesce(array_length(p_photos, 1), 0) > 5 then raise exception 'Up to 5 product photos'; end if;
  if exists (select 1 from unnest(p_photos) x where x not like 'purchase/' || p_id || '/%') then raise exception 'Wrong photo'; end if;
  update public.purchase_orders set photos = coalesce(p_photos, '{}'), updated_at = now() where id = p_id returning * into po;
  return po;
end;
$$;
revoke execute on function public.set_purchase_photos(uuid, text[]) from public, anon;
grant execute on function public.set_purchase_photos(uuid, text[]) to authenticated;

-- 2. the small copies for the PDF of the approved purchase order (up to 5); one month after approval the full photos
--    are deleted and the PDF keeps showing the small copies
create or replace function public.purchase_order_photos(p_id uuid, p_action text, p_print text[] default null) returns text[]
language plpgsql security definer set search_path = '' as $$
declare po public.purchase_orders; gone text[];
begin
  if not public.is_admin() then raise exception 'Only the Director'; end if;
  select * into po from public.purchase_orders where id = p_id for update;
  if not found or po.status <> 'approved' then raise exception 'Purchase order not approved'; end if;
  if p_action = 'print' then
    if coalesce(array_length(p_print, 1), 0) > 5 or exists (select 1 from unnest(p_print) x where x not like 'data:image/jpeg;base64,%' or length(x) > 400000) then
      raise exception 'Wrong print photos';
    end if;
    update public.purchase_orders set print_photos = p_print where id = p_id;
    return '{}';
  elsif p_action = 'expire' then
    if po.approved_at > now() - interval '30 days' or coalesce(array_length(po.print_photos, 1), 0) = 0 then return '{}'; end if;
    gone := po.photos;
    update public.purchase_orders set photos = '{}' where id = p_id;
    return gone;
  end if;
  raise exception 'Unknown action %', p_action;
end;
$$;
revoke execute on function public.purchase_order_photos(uuid, text, text[]) from public, anon;
grant execute on function public.purchase_order_photos(uuid, text, text[]) to authenticated;

select 'UPDATE 3.32 READY - Purchase Order takes up to 5 photos' as result;

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

-- =====================================================================
-- the check: the 3 updates are on the server now
-- =====================================================================
select case when pg_get_functiondef('public.has_module(text)'::regprocedure) like '%eooffice%'
    and pg_get_functiondef('public.set_purchase_photos(uuid,text[])'::regprocedure) like '%Up to 5 product photos%'
    and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'qc_tests' and column_name = 'mending_max')
  then 'UPDATE 3.31 + 3.32 + 3.33 READY - EO-Office gives Employees and Payroll; Purchase Order 5 photos; QC Test Qty and mending'
  else 'NOT READY - send this message to Claude' end as result;
