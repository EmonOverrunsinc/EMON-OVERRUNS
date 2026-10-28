-- =====================================================================
-- EMON OVERRUNS E-PORTAL - RUN THIS ONE FILE: every update from 3.31 to 3.38 together
--   3.31  no Employee (HR) access any more: 11 EO-Office gives Employees, Payroll and Job Applications  (041_eooffice_hr.sql)
--   3.32  a purchase order takes up to 5 product photos (was 2)                                          (042_po_photos.sql)
--   3.33  QC Test: Add QC Test with every detail (Qty by color, mending limit, notes); Qty on the stickers (043_qc_qty.sql)
--   3.36  the duplicate customer check finds more (swapped names, names together or apart, accents, the
--         same phone); a purchase order (lot) is deleted by the Director only                          (044_duplicate_check.sql)
--   3.37  CUSTOMER ORDER in EO-Office: lines, boxes by scan, the Director's approval, delivery, and the
--         invoice made by itself when the delivery is completed                                       (045_customer_orders.sql)
--   3.38  GATE PASS AI: its folder on the server (bucket ai), what it learned and its ideas             (046_gate_pass_ai.sql)
-- Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again (also when some of these already ran,
-- for example RUN_041_TO_044.sql). The last line checks the server and says: UPDATE 3.31 TO 3.38 READY - ...
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

-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.36: the duplicate customer check finds more; a lot is deleted by the Director only
-- 1. The same person is found also when the name is typed another way: first and last name swapped, written together or
--    apart (DELA CRUZ = DELACRUZ, MARIA CLARA + SANTOS = MARIA + CLARA SANTOS), with dots, dashes or accents (MA. THERESA
--    PEÑAFLOR = MA THERESA PENAFLOR); the Facebook name the same way. The same PHONE number (0917…, +63 917…, with
--    spaces or dashes) is found too: it shows as SIMILAR for the Director to check (a phone never blocks an account: a
--    family can share one). A CLOSED account or the same Facebook link still blocks, as before.
-- 2. A purchase order (lot) is deleted by the Director only (before: also by the person who made it).
-- Needs 014_update_2_1.sql and 023_purchase_orders.sql. Safe to run again.
-- =====================================================================
do $$ begin
  if to_regprocedure('public.facebook_key(text)') is null then raise exception 'Run 014_update_2_1.sql first, then run this again.'; end if;
  if to_regclass('public.purchase_orders') is null then raise exception 'Run 023_purchase_orders.sql first, then run this again.'; end if;
end $$;

-- a name made comparable: small letters without accents, dots, dashes or spaces (MA. THERESA → matheresa); empty = null
create or replace function public.name_key(p text) returns text
language sql immutable set search_path = '' as $$
  select nullif(regexp_replace(translate(lower(coalesce(p, '')), 'áàâäãåéèêëíìîïóòôöõúùûüñç', 'aaaaaaeeeeiiiiooooouuuunc'), '[^a-z0-9]', '', 'g'), '');
$$;
revoke execute on function public.name_key(text) from public, anon;

-- a phone number made comparable: its last 10 digits (0917 123 4567, +63 917 123 4567 and 639171234567 are the same);
-- null when it has fewer than 7 digits
create or replace function public.phone_key(p text) returns text
language sql immutable set search_path = '' as $$
  select case when length(d) < 7 then null else right(d, 10) end
  from (select regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') as d) x;
$$;
revoke execute on function public.phone_key(text) from public, anon;

-- Every account that may be the same person (internal: used by the checks below). p_phone: a match on the phone is
-- SIMILAR only (never BLOCKED).
drop function if exists public.customer_matches(text, text, text, text, text, uuid);
create or replace function public.customer_matches(p_first text, p_last text, p_fb_name text, p_fb_extra text, p_fb_link text,
  p_except uuid default null, p_phone text default null)
returns table (id uuid, account_no text, first_name text, last_name text, phone text, email text, facebook_name text, facebook_link text,
  status text, matched_on text, blocked boolean)
language sql stable security definer set search_path = '' as $$
  with me as (
    select public.name_key(p_first) || public.name_key(p_last) as full_name,
      array_remove(array[public.name_key(p_fb_name), public.name_key(p_fb_extra)], null) as fb,
      public.facebook_key(p_fb_link) as k, public.phone_key(p_phone) as ph)
  select o.id, o.account_no, o.first_name, o.last_name, o.phone, o.email, o.facebook_name, o.facebook_link, o.status,
    concat_ws(', ', case when x.by_name then 'name' end, case when x.by_fb then 'Facebook name' end,
      case when x.by_link then 'Facebook link' end, case when x.by_phone then 'phone' end),
    (x.by_link and o.status <> 'rejected') or ((x.by_name or x.by_fb) and o.status = 'closed')
  from public.customers o cross join me
  cross join lateral (select
      me.full_name is not null and me.full_name in (public.name_key(o.first_name) || public.name_key(o.last_name),
                                                    public.name_key(o.last_name) || public.name_key(o.first_name)) as by_name,
      cardinality(me.fb) > 0 and array_remove(array[public.name_key(o.facebook_name), public.name_key(o.extra_facebook_name)], null) && me.fb as by_fb,
      me.k is not null and public.facebook_key(o.facebook_link) = me.k as by_link,
      me.ph is not null and public.phone_key(o.phone) = me.ph as by_phone) x
  where (p_except is null or o.id <> p_except) and (x.by_name or x.by_fb or x.by_link or x.by_phone)
  order by 11 desc, o.created_at;
$$;
revoke execute on function public.customer_matches(text, text, text, text, text, uuid, text) from public, anon, authenticated;

-- Why this person cannot open an account (empty when they can). The phone is not asked: it never blocks.
create or replace function public.customer_block_reason(p_first text, p_last text, p_fb_name text, p_fb_extra text, p_fb_link text, p_except uuid default null)
returns text language sql stable security definer set search_path = '' as $$
  select 'This person cannot open an account: ' || case
      when m.matched_on like '%Facebook link%' then 'the same Facebook link is on account ' || coalesce(m.account_no, '') || ' (' || upper(m.status) || ')'
      else 'account ' || coalesce(m.account_no, '') || ' with the same ' || m.matched_on || ' was CLOSED' end || '.'
  from public.customer_matches(p_first, p_last, p_fb_name, p_fb_extra, p_fb_link, p_except) m
  where m.blocked limit 1;
$$;
revoke execute on function public.customer_block_reason(text, text, text, text, text, uuid) from public, anon, authenticated;

-- The check of a saved application (Check & Verify): now with its phone number too.
create or replace function public.customer_duplicates(p_id uuid)
returns table (id uuid, account_no text, first_name text, last_name text, phone text, email text, facebook_name text, facebook_link text,
  status text, matched_on text, blocked boolean)
language sql stable security definer set search_path = '' as $$
  select m.* from public.customers c
  cross join lateral public.customer_matches(c.first_name, c.last_name, c.facebook_name, c.extra_facebook_name, c.facebook_link, c.id, c.phone) m
  where c.id = p_id and (public.is_admin() or public.can_write('customers'));
$$;
revoke execute on function public.customer_duplicates(uuid) from public, anon;
grant execute on function public.customer_duplicates(uuid) to authenticated;

-- The same check while a new application is typed (before it is saved): without the phone (for an older portal) …
create or replace function public.customer_person_check(p_first text, p_last text, p_fb_name text, p_fb_extra text, p_fb_link text)
returns table (id uuid, account_no text, first_name text, last_name text, phone text, email text, facebook_name text, facebook_link text,
  status text, matched_on text, blocked boolean)
language sql stable security definer set search_path = '' as $$
  select m.* from public.customer_matches(p_first, p_last, p_fb_name, p_fb_extra, p_fb_link) m
  where public.is_admin() or public.can_write('customers');
$$;
revoke execute on function public.customer_person_check(text, text, text, text, text) from public, anon;
grant execute on function public.customer_person_check(text, text, text, text, text) to authenticated;

-- … and with the phone (3.36)
create or replace function public.customer_person_check(p_first text, p_last text, p_fb_name text, p_fb_extra text, p_fb_link text, p_phone text)
returns table (id uuid, account_no text, first_name text, last_name text, phone text, email text, facebook_name text, facebook_link text,
  status text, matched_on text, blocked boolean)
language sql stable security definer set search_path = '' as $$
  select m.* from public.customer_matches(p_first, p_last, p_fb_name, p_fb_extra, p_fb_link, null, p_phone) m
  where public.is_admin() or public.can_write('customers');
$$;
revoke execute on function public.customer_person_check(text, text, text, text, text, text) from public, anon;
grant execute on function public.customer_person_check(text, text, text, text, text, text) to authenticated;

-- 2. A purchase order still waiting is deleted by the Director only (gives back the photo and voice paths); an approved
--    or cancelled one cannot be deleted.
create or replace function public.delete_purchase_order(p_id uuid) returns text[]
language plpgsql security definer set search_path = '' as $$
declare po public.purchase_orders;
begin
  if not public.is_admin() then raise exception 'Only the Director can delete a purchase order'; end if;
  select * into po from public.purchase_orders where id = p_id for update;
  if not found then raise exception 'Purchase order not found'; end if;
  if po.status not in ('pending','negotiation') then raise exception 'Purchase order % is % and cannot be deleted', po.po_no, upper(po.status); end if;
  delete from public.notifications where title = 'Purchase order ' || po.po_no || ' to review';
  delete from public.purchase_orders where id = p_id;
  return po.photos || po.voices;
end;
$$;
revoke execute on function public.delete_purchase_order(uuid) from public, anon;
grant execute on function public.delete_purchase_order(uuid) to authenticated;

select 'UPDATE 3.36 READY - the duplicate customer check finds swapped names, names typed together or apart, accents and the same phone; a lot is deleted by the Director only' as result;

-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.37: CUSTOMER ORDER (EO-Office)
-- An order for a customer, like the paper order: DELIVERED TO, ADDRESS, ACCOUNT NO, REFERENCES, DATE, DUE DATE, NOTE,
-- TERMS and the lines QUANTITY | BOXES | CODE | PCS | LOT NO. | PRODUCT | PRICE | AMOUNT (QUANTITY = BOXES x PCS,
-- AMOUNT = QUANTITY x PRICE); up to 4 more columns can be added (COLOR, SIZE ...).
-- The boxes of the order (the Delivery Sheet): each box by its serial no (read from the QR or PDF417 code on the box
-- label, from a photo of it, or typed), with its code, batch no, items, pcs and remarks. A box is on one order only.
-- The Director approves an order (the authorized signature on the printed order); the Director's own orders are
-- approved at once. The delivery: rider name, ID no, plate no, type, date and time, and photos. COMPLETE: the invoice
-- is made for the customer by itself (on the customer's profile and statement) and the order shows it.
-- Needs 024_eo_office.sql. Safe to run again.
-- =====================================================================
do $$ begin
  if to_regprocedure('public.qc_can_write()') is null then raise exception 'Run 024_eo_office.sql first, then run this again.'; end if;
end $$;

create table if not exists public.customer_orders (
  id uuid primary key default gen_random_uuid(),
  order_no text unique,
  customer_id uuid not null references public.customers(id),
  order_date date not null default ((now() at time zone 'Asia/Manila')::date),
  due_date date,
  reference text,
  delivered_to text,
  address text,
  note text,
  payment_terms text,
  extra_columns text[] not null default '{}',
  lines jsonb not null default '[]'::jsonb,
  total_boxes integer not null default 0,
  total_pcs integer not null default 0,
  total_amount numeric(14,2) not null default 0,
  status text not null default 'pending' check (status in ('pending','approved','completed','cancelled')),
  approved_by uuid references public.profiles(id) on delete set null,
  approved_by_name text,
  approved_at timestamptz,
  rider_name text,
  rider_id_no text,
  plate_no text,
  vehicle_type text,
  delivered_at timestamptz,
  delivery_note text,
  delivery_photos text[] not null default '{}',
  completed_at timestamptz,
  completed_by_name text,
  invoice_id uuid references public.customer_invoices(id) on delete set null,
  cancelled_at timestamptz,
  cancelled_by_name text,
  cancel_note text,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists customer_orders_customer_idx on public.customer_orders(customer_id);
create index if not exists customer_orders_status_idx on public.customer_orders(status, order_date);
create index if not exists customer_orders_created_by_idx on public.customer_orders(created_by);
create index if not exists customer_orders_approved_by_idx on public.customer_orders(approved_by);
create index if not exists customer_orders_invoice_idx on public.customer_orders(invoice_id);

create table if not exists public.customer_order_boxes (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.customer_orders(id) on delete cascade,
  serial_no text not null,
  code text,
  batch_no text,
  items text,
  pcs integer not null default 0 check (pcs >= 0),
  remarks text,
  added_how text not null default 'typed' check (added_how in ('scan','photo','typed')),
  added_by_name text,
  created_at timestamptz not null default now(),
  unique (order_id, serial_no)
);
create index if not exists customer_order_boxes_serial_idx on public.customer_order_boxes(serial_no);

-- Read: staff with EO-Office (orders are made there) or with Customer access (the customer's profile shows the orders).
-- Every change goes through the functions below.
create or replace function public.co_can_read() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_staff() and (public.has_module('eooffice') or public.has_module('customers'));
$$;
revoke execute on function public.co_can_read() from public, anon;
grant execute on function public.co_can_read() to authenticated;
alter table public.customer_orders enable row level security;
alter table public.customer_order_boxes enable row level security;
revoke all on public.customer_orders from anon;
revoke all on public.customer_order_boxes from anon;
grant select on public.customer_orders to authenticated;
grant select on public.customer_order_boxes to authenticated;
drop policy if exists "co: read" on public.customer_orders;
create policy "co: read" on public.customer_orders for select to authenticated using ((select public.co_can_read()));
drop policy if exists "cob: read" on public.customer_order_boxes;
create policy "cob: read" on public.customer_order_boxes for select to authenticated using ((select public.co_can_read()));
-- the delivery photos (records/corder/<order>/...): seen by the same people; deleted by EO-Office staff
drop policy if exists "storage records: order files" on storage.objects;
create policy "storage records: order files" on storage.objects as restrictive for select to authenticated
  using (bucket_id <> 'records' or coalesce((storage.foldername(name))[1], '') <> 'corder' or (select public.co_can_read()));
drop policy if exists "storage records: order delete" on storage.objects;
create policy "storage records: order delete" on storage.objects for delete to authenticated
  using (bucket_id = 'records' and coalesce((storage.foldername(name))[1], '') = 'corder' and (select public.qc_can_write()));

-- The added columns made clean: capitals, up to 20 letters, each once, not a column the order has already, up to 4.
create or replace function public.co_clean_columns(p jsonb) returns text[]
language plpgsql immutable set search_path = '' as $$
declare r text[] := '{}'; v text; c text;
begin
  if jsonb_typeof(p) is distinct from 'array' then return r; end if;
  for v in select jsonb_array_elements_text(p) loop
    c := left(upper(regexp_replace(trim(v), '\s+', ' ', 'g')), 20);
    if c = '' or c = any(r) then continue; end if;
    if c in ('QUANTITY','QTY','BOXES','BOX','CODE','PCS','LOT','LOT NO','LOT NO.','PRODUCT','PRICE','AMOUNT') then raise exception 'The order has a % column already', c; end if;
    r := r || c;
  end loop;
  if cardinality(r) > 4 then raise exception 'Up to 4 added columns'; end if;
  return r;
end;
$$;
revoke execute on function public.co_clean_columns(jsonb) from public, anon;

-- The lines made clean: QUANTITY = BOXES x PCS (as written when there are no boxes or pcs), AMOUNT = QUANTITY x PRICE,
-- the added columns kept by their names. Empty lines are skipped; up to 60 lines.
create or replace function public.co_clean_lines(p_lines jsonb, p_cols text[]) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare x jsonb; r jsonb := '[]'::jsonb; n int := 0; bx int; pc int; qty numeric; price numeric; ex jsonb; c text;
begin
  if jsonb_typeof(p_lines) is distinct from 'array' then raise exception 'Add at least one line'; end if;
  for x in select * from jsonb_array_elements(p_lines) loop
    if coalesce(trim(x ->> 'product'), '') = '' and coalesce(trim(x ->> 'code'), '') = '' and coalesce(nullif(x ->> 'qty', '')::numeric, 0) = 0
       and coalesce(nullif(x ->> 'boxes', '')::numeric, 0) = 0 and coalesce(nullif(x ->> 'pcs', '')::numeric, 0) = 0 then continue; end if;
    n := n + 1;
    if n > 60 then raise exception 'An order has up to 60 lines'; end if;
    if coalesce(trim(x ->> 'product'), '') = '' then raise exception 'Write the product on line %', n; end if;
    bx := round(greatest(coalesce(nullif(x ->> 'boxes', '')::numeric, 0), 0));
    pc := round(greatest(coalesce(nullif(x ->> 'pcs', '')::numeric, 0), 0));
    qty := case when bx > 0 and pc > 0 then bx * pc else round(greatest(coalesce(nullif(x ->> 'qty', '')::numeric, 0), 0)) end;
    if qty <= 0 then raise exception 'Write the boxes and pcs (or the quantity) on line %', n; end if;
    price := round(greatest(coalesce(nullif(x ->> 'price', '')::numeric, 0), 0), 2);
    ex := '{}'::jsonb;
    foreach c in array coalesce(p_cols, '{}') loop
      ex := ex || jsonb_build_object(c, left(trim(coalesce(x -> 'extra' ->> c, '')), 60));
    end loop;
    r := r || jsonb_build_array(jsonb_build_object('qty', qty, 'boxes', bx, 'code', left(upper(trim(coalesce(x ->> 'code', ''))), 30), 'pcs', pc,
      'lot', left(upper(trim(coalesce(x ->> 'lot', ''))), 40), 'product', left(trim(x ->> 'product'), 120), 'price', price, 'amount', round(qty * price, 2), 'extra', ex));
  end loop;
  if n = 0 then raise exception 'Add at least one line'; end if;
  return r;
end;
$$;
revoke execute on function public.co_clean_lines(jsonb, text[]) from public, anon;

-- Save an order: new (p_id null) or a change. The person who made it changes it while it waits for the Director; the
-- Director changes it until it is completed. A new order of the Director is approved at once; any other new order
-- goes to the Director to review. Gives back the order.
create or replace function public.save_customer_order(p_id uuid, p_data jsonb) returns public.customer_orders
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare o public.customer_orders; c public.customers; me text := (select full_name from public.profiles where id = auth.uid());
  cols text[]; ln jsonb; d date; boss boolean := public.is_admin();
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  select * into c from public.customers where id = nullif(p_data ->> 'customer_id', '')::uuid;
  if not found then raise exception 'Choose the customer'; end if;
  if c.status <> 'active' then raise exception 'An order is made only for an ACTIVE account (% is %)', coalesce(c.account_no, c.first_name || ' ' || c.last_name), upper(c.status); end if;
  cols := public.co_clean_columns(p_data -> 'extra_columns');
  ln := public.co_clean_lines(p_data -> 'lines', cols);
  d := coalesce(nullif(p_data ->> 'order_date', '')::date, current_date);
  if p_id is not null then
    select * into o from public.customer_orders where id = p_id for update;
    if not found then raise exception 'Order not found'; end if;
    if o.status not in ('pending','approved') then raise exception 'Order % is % and cannot be changed', o.order_no, upper(o.status); end if;
    if not (boss or (o.created_by = auth.uid() and o.status = 'pending')) then
      raise exception '%', case when o.status = 'approved' then 'Order ' || o.order_no || ' is approved: only the Director can change it now' else 'Only the person who made it or the Director can change it' end;
    end if;
  end if;
  if p_id is null then
    insert into public.customer_orders (order_no, customer_id, order_date, created_by_name, status, approved_by, approved_by_name, approved_at)
    values ('CO-' || to_char(d, 'YYYYMM') || '-' || lpad(public.next_counter('CO' || to_char(d, 'YYYYMM'))::text, 4, '0'), c.id, d, me,
      case when boss then 'approved' else 'pending' end, case when boss then auth.uid() end, case when boss then me end, case when boss then now() end)
    returning * into o;
  end if;
  update public.customer_orders set customer_id = c.id, order_date = d, due_date = nullif(p_data ->> 'due_date', '')::date,
    reference = nullif(left(upper(trim(coalesce(p_data ->> 'reference', ''))), 60), ''),
    delivered_to = nullif(left(trim(coalesce(p_data ->> 'delivered_to', '')), 120), ''), address = nullif(left(trim(coalesce(p_data ->> 'address', '')), 300), ''),
    note = nullif(left(trim(coalesce(p_data ->> 'note', '')), 500), ''), payment_terms = nullif(left(upper(trim(coalesce(p_data ->> 'payment_terms', ''))), 60), ''),
    extra_columns = cols, lines = ln,
    total_boxes = (select coalesce(sum((x ->> 'boxes')::int), 0) from jsonb_array_elements(ln) x),
    total_pcs = (select coalesce(sum((x ->> 'qty')::numeric), 0)::int from jsonb_array_elements(ln) x),
    total_amount = (select coalesce(sum((x ->> 'amount')::numeric), 0) from jsonb_array_elements(ln) x), updated_at = now()
  where id = o.id returning * into o;
  if p_id is null and o.status = 'pending' then
    perform public.notify_admins('Customer order ' || o.order_no || ' to review', c.first_name || ' ' || c.last_name || ' · PHP ' || to_char(o.total_amount, 'FM999,999,990.00')
      || ' · ' || o.total_boxes || ' box' || case when o.total_boxes = 1 then '' else 'es' end || ' (from ' || coalesce(me, '') || ')', 'custorder/' || o.id);
  end if;
  return o;
end;
$$;
revoke execute on function public.save_customer_order(uuid, jsonb) from public, anon;
grant execute on function public.save_customer_order(uuid, jsonb) to authenticated;

-- The Director approves an order (the signature goes on the printed order) or cancels it; the person who made an order
-- cancels it while it waits. A completed order has its invoice and cannot be cancelled.
create or replace function public.decide_customer_order(p_id uuid, p_action text, p_note text default null) returns public.customer_orders
language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders; me text := (select full_name from public.profiles where id = auth.uid());
begin
  select * into o from public.customer_orders where id = p_id for update;
  if not found then raise exception 'Order not found'; end if;
  if p_action = 'approve' then
    if not public.is_admin() then raise exception 'Only the Director can approve an order'; end if;
    if o.status <> 'pending' then raise exception 'Order % is % (not waiting for approval)', o.order_no, upper(o.status); end if;
    update public.customer_orders set status = 'approved', approved_by = auth.uid(), approved_by_name = me, approved_at = now(), updated_at = now()
    where id = p_id returning * into o;
    if o.created_by is distinct from auth.uid() then
      perform public.notify_user(o.created_by, 'Customer order ' || o.order_no || ' APPROVED', 'Ready for delivery', 'custorder/' || o.id);
    end if;
  elsif p_action = 'cancel' then
    if o.status not in ('pending','approved') then raise exception 'Order % is % and cannot be cancelled', o.order_no, upper(o.status); end if;
    if not (public.is_admin() or (o.created_by = auth.uid() and o.status = 'pending')) then raise exception 'Only the Director can cancel this order'; end if;
    update public.customer_orders set status = 'cancelled', cancelled_at = now(), cancelled_by_name = me, cancel_note = nullif(left(trim(coalesce(p_note, '')), 300), ''), updated_at = now()
    where id = p_id returning * into o;
    if o.created_by is distinct from auth.uid() then
      perform public.notify_user(o.created_by, 'Customer order ' || o.order_no || ' was cancelled', coalesce(o.cancel_note, ''), 'custorder/' || o.id);
    end if;
  else
    raise exception 'Unknown action';
  end if;
  delete from public.notifications where title = 'Customer order ' || o.order_no || ' to review';
  return o;
end;
$$;
revoke execute on function public.decide_customer_order(uuid, text, text) from public, anon;
grant execute on function public.decide_customer_order(uuid, text, text) to authenticated;

-- A box of the order (from the box label QR / PDF417, a photo of it, or typed). A box serial is on one order only (a
-- cancelled order frees its boxes). Up to 500 boxes.
create or replace function public.add_order_box(p_order uuid, p_data jsonb) returns public.customer_order_boxes
language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders; b public.customer_order_boxes; s text; other text; me text := (select full_name from public.profiles where id = auth.uid());
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  select * into o from public.customer_orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status not in ('pending','approved') then raise exception 'Order % is %: boxes cannot be added', o.order_no, upper(o.status); end if;
  s := left(upper(regexp_replace(trim(coalesce(p_data ->> 'serial_no', '')), '\s+', ' ', 'g')), 60);
  if s = '' then raise exception 'Write the serial no of the box'; end if;
  perform pg_advisory_xact_lock(hashtext('order box ' || s)); -- the same box scanned on two orders at the same moment
  if exists (select 1 from public.customer_order_boxes where order_id = p_order and serial_no = s) then raise exception 'Box % is on this order already', s; end if;
  select x.order_no into other from public.customer_order_boxes y join public.customer_orders x on x.id = y.order_id
  where y.serial_no = s and x.status <> 'cancelled' and x.id <> p_order limit 1;
  if other is not null then raise exception 'Box % is on order % already', s, other; end if;
  if (select count(*) from public.customer_order_boxes where order_id = p_order) >= 500 then raise exception 'An order has up to 500 boxes'; end if;
  insert into public.customer_order_boxes (order_id, serial_no, code, batch_no, items, pcs, remarks, added_how, added_by_name)
  values (p_order, s, nullif(left(upper(trim(coalesce(p_data ->> 'code', ''))), 30), ''), nullif(left(upper(trim(coalesce(p_data ->> 'batch_no', ''))), 40), ''),
    nullif(left(trim(coalesce(p_data ->> 'items', '')), 120), ''), round(greatest(coalesce(nullif(p_data ->> 'pcs', '')::numeric, 0), 0)),
    nullif(left(trim(coalesce(p_data ->> 'remarks', '')), 120), ''), case when p_data ->> 'added_how' in ('scan','photo','typed') then p_data ->> 'added_how' else 'typed' end, me)
  returning * into b;
  update public.customer_orders set updated_at = now() where id = p_order;
  return b;
end;
$$;
revoke execute on function public.add_order_box(uuid, jsonb) from public, anon;
grant execute on function public.add_order_box(uuid, jsonb) to authenticated;

-- A box changed (code, batch no, items, pcs, remarks) or taken off (p_data null), while the order is open.
create or replace function public.change_order_box(p_box uuid, p_data jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare b public.customer_order_boxes; st text; no text;
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  select * into b from public.customer_order_boxes where id = p_box;
  if not found then raise exception 'Box not found'; end if;
  select status, order_no into st, no from public.customer_orders where id = b.order_id for update;
  if st not in ('pending','approved') then raise exception 'Order % is %: its boxes cannot be changed', no, upper(st); end if;
  if p_data is null then
    delete from public.customer_order_boxes where id = p_box;
  else
    update public.customer_order_boxes set code = nullif(left(upper(trim(coalesce(p_data ->> 'code', ''))), 30), ''),
      batch_no = nullif(left(upper(trim(coalesce(p_data ->> 'batch_no', ''))), 40), ''), items = nullif(left(trim(coalesce(p_data ->> 'items', '')), 120), ''),
      pcs = round(greatest(coalesce(nullif(p_data ->> 'pcs', '')::numeric, 0), 0)), remarks = nullif(left(trim(coalesce(p_data ->> 'remarks', '')), 120), '')
    where id = p_box;
  end if;
  update public.customer_orders set updated_at = now() where id = b.order_id;
end;
$$;
revoke execute on function public.change_order_box(uuid, jsonb) from public, anon;
grant execute on function public.change_order_box(uuid, jsonb) to authenticated;

-- The delivery of an approved order: the rider and the vehicle, the date and time, a note.
create or replace function public.set_order_delivery(p_id uuid, p_data jsonb) returns public.customer_orders
language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders;
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  select * into o from public.customer_orders where id = p_id for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status <> 'approved' then raise exception '%', case when o.status = 'pending' then 'Order ' || o.order_no || ' waits for the Director''s approval' else 'Order ' || o.order_no || ' is ' || upper(o.status) end; end if;
  if coalesce(trim(p_data ->> 'rider_name'), '') = '' then raise exception 'Write the rider name'; end if;
  update public.customer_orders set rider_name = left(upper(trim(p_data ->> 'rider_name')), 120), rider_id_no = nullif(left(upper(trim(coalesce(p_data ->> 'rider_id_no', ''))), 60), ''),
    plate_no = nullif(left(upper(trim(coalesce(p_data ->> 'plate_no', ''))), 30), ''), vehicle_type = nullif(left(upper(trim(coalesce(p_data ->> 'vehicle_type', ''))), 40), ''),
    delivered_at = coalesce(nullif(p_data ->> 'delivered_at', '')::timestamptz, delivered_at), delivery_note = nullif(left(trim(coalesce(p_data ->> 'delivery_note', '')), 300), ''),
    updated_at = now()
  where id = p_id returning * into o;
  return o;
end;
$$;
revoke execute on function public.set_order_delivery(uuid, jsonb) from public, anon;
grant execute on function public.set_order_delivery(uuid, jsonb) to authenticated;

-- The delivery photos (up to 5) of an approved order; gives back the photos taken off (to delete their files).
create or replace function public.set_order_photos(p_id uuid, p_photos text[]) returns text[]
language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders; ph text[] := coalesce(p_photos, '{}');
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  select * into o from public.customer_orders where id = p_id for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status <> 'approved' then raise exception 'The delivery photos of order % cannot be changed now (%)', o.order_no, upper(o.status); end if;
  if cardinality(ph) > 5 then raise exception 'Up to 5 delivery photos'; end if;
  if exists (select 1 from unnest(ph) x where x not like 'corder/' || p_id || '/%') then raise exception 'Wrong photo'; end if;
  update public.customer_orders set delivery_photos = ph, updated_at = now() where id = p_id;
  return array(select x from unnest(o.delivery_photos) x where not (x = any(ph)));
end;
$$;
revoke execute on function public.set_order_photos(uuid, text[]) from public, anon;
grant execute on function public.set_order_photos(uuid, text[]) to authenticated;

-- COMPLETE: the order was delivered (the rider and a delivery photo are needed). The invoice is made for the customer
-- by itself (invoice date today, the order's boxes, pcs, amount and terms; PO no = the order no) and the order shows it.
create or replace function public.complete_customer_order(p_id uuid) returns public.customer_orders
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare o public.customer_orders; inv uuid; me text := (select full_name from public.profiles where id = auth.uid());
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  select * into o from public.customer_orders where id = p_id for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status <> 'approved' then raise exception '%', case when o.status = 'pending' then 'Order ' || o.order_no || ' waits for the Director''s approval' else 'Order ' || o.order_no || ' is ' || upper(o.status) end; end if;
  if coalesce(o.rider_name, '') = '' then raise exception 'Add the rider details first'; end if;
  if cardinality(o.delivery_photos) = 0 then raise exception 'Add a delivery photo first'; end if;
  insert into public.customer_invoices (customer_id, invoice_date, purchase_date, po_number, total_boxes, total_pcs, total_amount, payment_terms)
  values (o.customer_id, current_date, o.order_date, o.order_no, o.total_boxes, o.total_pcs, o.total_amount, o.payment_terms)
  returning id into inv;
  update public.customer_orders set status = 'completed', invoice_id = inv, completed_at = now(), completed_by_name = me,
    delivered_at = coalesce(delivered_at, now()), updated_at = now()
  where id = p_id returning * into o;
  if o.created_by is distinct from auth.uid() then
    perform public.notify_user(o.created_by, 'Customer order ' || o.order_no || ' delivered', 'Invoice ' || (select invoice_no from public.customer_invoices where id = inv) || ' was made', 'custorder/' || o.id);
  end if;
  return o;
end;
$$;
revoke execute on function public.complete_customer_order(uuid) from public, anon;
grant execute on function public.complete_customer_order(uuid) to authenticated;

-- The Director deletes an order that is not completed (gives back the delivery photos, to delete their files).
create or replace function public.delete_customer_order(p_id uuid) returns text[]
language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders;
begin
  if not public.is_admin() then raise exception 'Only the Director can delete an order'; end if;
  select * into o from public.customer_orders where id = p_id for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status = 'completed' then raise exception 'Order % is COMPLETED (it has its invoice) and cannot be deleted', o.order_no; end if;
  delete from public.notifications where title = 'Customer order ' || o.order_no || ' to review';
  delete from public.customer_orders where id = p_id;
  return o.delivery_photos;
end;
$$;
revoke execute on function public.delete_customer_order(uuid) from public, anon;
grant execute on function public.delete_customer_order(uuid) to authenticated;

select 'UPDATE 3.37 READY - Customer Order: lines, boxes by scan, the Director''s approval, delivery and the invoice made by itself' as result;

-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.38: GATE PASS AI
-- A small artificial neural network learns from the portal's own records (invoices, payments, overdue days, credit memos,
-- returns and every gate pass decision of the Director) and gives its idea when a Gate Pass is asked for: CLEAR or HOLD,
-- how sure it is, and why. The Director decides.
-- 1. Its own folder on the server: the private storage bucket "ai" (folder gate-pass/: one file for each time it learns).
--    The Director makes it learn (writes the files); staff with Customer access read the newest file to see its idea.
-- 2. ai_models: the list of what it learned (the file, how many records and Director decisions, how often it was right).
-- 3. ai_gate_log: each idea shown in a Gate Pass and the decision taken (CLEAR or HOLD), to see how often it agrees.
-- Needs 045_customer_orders.sql. Safe to run again.
-- =====================================================================
do $$ begin
  if to_regclass('public.customer_orders') is null then raise exception 'Run 045_customer_orders.sql first, then run this again.'; end if;
end $$;

-- 1. the folder
insert into storage.buckets (id, name, public) values ('ai', 'ai', false) on conflict (id) do nothing;
create or replace function public.ai_can_read() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_staff() and public.has_module('customers');
$$;
revoke execute on function public.ai_can_read() from public, anon;
grant execute on function public.ai_can_read() to authenticated;
drop policy if exists "storage ai: read" on storage.objects;
create policy "storage ai: read" on storage.objects for select to authenticated
  using (bucket_id = 'ai' and (select public.ai_can_read()));
drop policy if exists "storage ai: director writes" on storage.objects;
create policy "storage ai: director writes" on storage.objects for insert to authenticated
  with check (bucket_id = 'ai' and (select public.is_admin()));
drop policy if exists "storage ai: director deletes" on storage.objects;
create policy "storage ai: director deletes" on storage.objects for delete to authenticated
  using (bucket_id = 'ai' and (select public.is_admin()));

-- 2. what it learned
create table if not exists public.ai_models (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'gate-pass',
  path text not null,
  samples integer not null default 0 check (samples >= 0),
  decisions integer not null default 0 check (decisions >= 0),
  accuracy numeric(5,2) check (accuracy between 0 and 100),
  agree numeric(5,2) check (agree between 0 and 100),
  trained_by uuid references public.profiles(id) on delete set null default auth.uid(),
  trained_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists ai_models_name_idx on public.ai_models(name, created_at desc);
create index if not exists ai_models_trained_by_idx on public.ai_models(trained_by);
alter table public.ai_models enable row level security;
revoke all on public.ai_models from anon;
grant select, insert, delete on public.ai_models to authenticated;
drop policy if exists "ai models: read" on public.ai_models;
create policy "ai models: read" on public.ai_models for select to authenticated using ((select public.ai_can_read()));
drop policy if exists "ai models: director adds" on public.ai_models;
create policy "ai models: director adds" on public.ai_models for insert to authenticated
  with check ((select public.is_admin()) and path like 'gate-pass/%' and trained_by = (select auth.uid()));
drop policy if exists "ai models: director deletes" on public.ai_models;
create policy "ai models: director deletes" on public.ai_models for delete to authenticated using ((select public.is_admin()));

-- 3. its ideas and the decisions taken
create table if not exists public.ai_gate_log (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  model_id uuid references public.ai_models(id) on delete set null,
  suggestion text not null check (suggestion in ('CLEAR','HOLD')),
  p_clear numeric(5,4) not null check (p_clear between 0 and 1),
  reasons text check (char_length(reasons) <= 600),
  decision text check (decision in ('CLEAR','HOLD')),
  decided_by_name text,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists ai_gate_log_customer_idx on public.ai_gate_log(customer_id);
create index if not exists ai_gate_log_model_idx on public.ai_gate_log(model_id);
create index if not exists ai_gate_log_created_by_idx on public.ai_gate_log(created_by);
create index if not exists ai_gate_log_time_idx on public.ai_gate_log(created_at desc);
alter table public.ai_gate_log enable row level security;
revoke all on public.ai_gate_log from anon;
grant select, insert on public.ai_gate_log to authenticated;
drop policy if exists "ai log: read" on public.ai_gate_log;
create policy "ai log: read" on public.ai_gate_log for select to authenticated using ((select public.ai_can_read()));
drop policy if exists "ai log: add" on public.ai_gate_log;
create policy "ai log: add" on public.ai_gate_log for insert to authenticated
  with check ((select public.ai_can_read()) and created_by = (select auth.uid()));

select 'UPDATE 3.38 READY - Gate Pass AI: its folder (bucket ai), what it learned (ai_models) and its ideas with the decisions (ai_gate_log)' as result;

-- =====================================================================
-- the check: every update is on the server now
-- =====================================================================
select case when pg_get_functiondef('public.has_module(text)'::regprocedure) like '%eooffice%'
    and pg_get_functiondef('public.set_purchase_photos(uuid,text[])'::regprocedure) like '%Up to 5 product photos%'
    and to_regprocedure('public.qc_add(jsonb)') is not null
    and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'qc_tests' and column_name = 'qty_lines')
    and to_regprocedure('public.customer_person_check(text,text,text,text,text,text)') is not null
    and pg_get_functiondef('public.delete_purchase_order(uuid)'::regprocedure) like '%Only the Director can delete a purchase order%'
    and to_regprocedure('public.complete_customer_order(uuid)') is not null and to_regclass('public.customer_order_boxes') is not null
    and to_regclass('public.ai_models') is not null and to_regclass('public.ai_gate_log') is not null and exists (select 1 from storage.buckets where id = 'ai')
  then 'UPDATE 3.31 TO 3.38 READY - EO-Office HR access; Purchase Order 5 photos; Add QC Test; better duplicate check; lot delete by the Director only; Customer Order; Gate Pass AI'
  else 'NOT READY - send this message to Claude' end as result;
