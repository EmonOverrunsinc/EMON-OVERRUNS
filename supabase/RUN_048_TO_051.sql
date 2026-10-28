-- =====================================================================
-- EMON OVERRUNS E-PORTAL - RUN THIS ONE FILE: update 3.39
--   048  COMPLETE DELIVERY by the order paper: each order has a secret code in the barcode and the QR code of its printed
--        paper; whoever scans it (signed in or not) opens the order's Complete Delivery page            (048_delivery_paper.sql)
--   049  the Director deletes any lot (purchase order), also an approved one                          (049_lot_delete.sql)
--   050  EVA AI for the Director only; the BOX DATABASE read from the Google Sheet (columns A to G) fills the boxes
--        scanned on customer orders                                                                    (050_eva_boxes.sql)
--   051  COMPLETE DELIVERY makes the customer's invoice and bills it by itself; the Director is told  (051_order_invoice.sql)
-- Needs RUN_041_TO_046.sql and 047_order_no.sql (already run). Paste all of it in Supabase > SQL Editor > New query and press
-- Run. Safe to run again (also after RUN_048_TO_049.sql). The last line says: UPDATE 3.39 READY - ...
-- =====================================================================

-- ======== 048_delivery_paper.sql ========
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.39: COMPLETE DELIVERY by the order paper
-- Every customer order has a secret code. It is printed in the barcode and the QR code of the order paper (the Customer
-- Order and the Delivery Sheet). Whoever scans that paper - with the portal's scanner or a phone camera, signed in or not -
-- opens the order's Complete Delivery page: scan or add the boxes, add the rider and the photos (the car, the proof of
-- delivery), and COMPLETE DELIVERY (the invoice is made by itself, as before). The order number alone is not enough: the
-- secret code of the paper is needed. Only an APPROVED order can be delivered; after COMPLETE the paper opens nothing more
-- to change. Prices are not shown on that page.
-- Needs 045_customer_orders.sql and 047_order_no.sql. Safe to run again.
-- =====================================================================

-- 1. the secret code of each order (12 letters and digits), also for the orders made already
alter table public.customer_orders add column if not exists delivery_code text;
update public.customer_orders set delivery_code = substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 12) where delivery_code is null;
alter table public.customer_orders alter column delivery_code set default substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 12);

-- 2. the box, rider, photo and COMPLETE functions also work for the order of a paper checked below
do $$
declare f text; p text; def text;
begin
  if to_regprocedure('public.complete_customer_order(uuid)') is null then raise exception 'Run RUN_041_TO_046.sql first, then run this again.'; end if;
  foreach f in array array['add_order_box(uuid,jsonb)|p_order', 'set_order_delivery(uuid,jsonb)|p_id', 'set_order_photos(uuid,text[])|p_id', 'complete_customer_order(uuid)|p_id'] loop
    p := split_part(f, '|', 2);
    def := pg_get_functiondef(('public.' || split_part(f, '|', 1))::regprocedure);
    if position('eo.paper_order' in def) = 0 then
      def := replace(def, 'if not public.qc_can_write() then raise exception ''Not allowed''; end if;',
        'if not public.qc_can_write() and coalesce(current_setting(''eo.paper_order'', true), '''') is distinct from ' || p || '::text then raise exception ''Not allowed''; end if;');
      if position('eo.paper_order' in def) = 0 then raise exception 'Could not update %', f; end if;
      execute def;
    end if;
  end loop;
end $$;

-- 3. the order of a paper: its number and its secret code (whoever holds the paper)
create or replace function public.co_by_paper(p_no text, p_code text) returns public.customer_orders
language plpgsql stable security definer set search_path = '' as $$
declare o public.customer_orders;
begin
  if coalesce(trim(p_code), '') <> '' then
    select * into o from public.customer_orders where order_no = upper(trim(p_no)) and delivery_code = lower(trim(p_code));
  end if;
  if o.id is null then raise exception 'This order paper is not known. Scan the barcode or the QR code of the printed order again.'; end if;
  return o;
end;
$$;
revoke execute on function public.co_by_paper(text, text) from public, anon, authenticated;

-- why an order cannot be delivered now
create or replace function public.co_paper_state(o public.customer_orders) returns text
language sql stable security definer set search_path = '' set timezone to 'Asia/Manila' as $$
  select case o.status
    when 'pending' then 'Order ' || o.order_no || ' waits for the Director''s approval: the delivery starts after it.'
    when 'completed' then 'Order ' || o.order_no || ' was delivered and completed on ' || to_char(o.completed_at, 'FMMONTH DD YYYY') || '.'
    when 'cancelled' then 'Order ' || o.order_no || ' was CANCELLED.'
    else '' end;
$$;
revoke execute on function public.co_paper_state(public.customer_orders) from public, anon, authenticated;

-- an approved order of a paper, ready for the box, rider, photo and COMPLETE functions
create or replace function public.co_paper_open(p_no text, p_code text) returns public.customer_orders
language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders;
begin
  o := public.co_by_paper(p_no, p_code);
  if o.status <> 'approved' then raise exception '%', public.co_paper_state(o); end if;
  perform set_config('eo.paper_order', o.id::text, true);
  return o;
end;
$$;
revoke execute on function public.co_paper_open(text, text) from public, anon, authenticated;

-- 4. what the Complete Delivery page shows (no prices)
create or replace function public.delivery_order(p_no text, p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare o public.customer_orders; c public.customers;
begin
  o := public.co_by_paper(p_no, p_code);
  select * into c from public.customers where id = o.customer_id;
  return jsonb_build_object('id', o.id, 'order_no', o.order_no, 'status', o.status, 'state', public.co_paper_state(o), 'order_date', o.order_date,
    'customer', trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), 'account_no', c.account_no, 'address', coalesce(o.address, c.address),
    'reference', o.reference, 'total_boxes', o.total_boxes, 'total_pcs', o.total_pcs,
    'lines', (select coalesce(jsonb_agg(jsonb_build_object('code', l ->> 'code', 'product', l ->> 'product', 'lot', l ->> 'lot', 'boxes', l -> 'boxes', 'pcs', l -> 'pcs', 'qty', l -> 'qty')), '[]'::jsonb)
      from jsonb_array_elements(coalesce(o.lines, '[]'::jsonb)) l),
    'boxes', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'serial_no', b.serial_no, 'code', b.code, 'batch_no', b.batch_no, 'items', b.items, 'pcs', b.pcs, 'remarks', b.remarks)
      order by b.created_at, b.id), '[]'::jsonb) from public.customer_order_boxes b where b.order_id = o.id),
    'rider_name', o.rider_name, 'rider_id_no', o.rider_id_no, 'plate_no', o.plate_no, 'vehicle_type', o.vehicle_type, 'delivered_at', o.delivered_at,
    'delivery_note', o.delivery_note, 'delivery_photos', to_jsonb(coalesce(o.delivery_photos, '{}')), 'completed_at', o.completed_at, 'completed_by_name', o.completed_by_name);
end;
$$;

-- 5. a box scanned or typed on the paper's page; a box taken off again
create or replace function public.delivery_add_box(p_no text, p_code text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders; b public.customer_order_boxes;
begin
  o := public.co_paper_open(p_no, p_code);
  b := public.add_order_box(o.id, p_data);
  if b.added_by_name is null then update public.customer_order_boxes set added_by_name = 'ORDER PAPER' where id = b.id returning * into b; end if;
  return jsonb_build_object('id', b.id, 'serial_no', b.serial_no, 'code', b.code, 'batch_no', b.batch_no, 'items', b.items, 'pcs', b.pcs, 'remarks', b.remarks);
end;
$$;
create or replace function public.delivery_remove_box(p_no text, p_code text, p_box uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders;
begin
  o := public.co_paper_open(p_no, p_code);
  delete from public.customer_order_boxes where id = p_box and order_id = o.id;
  if not found then raise exception 'Box not found on order %', o.order_no; end if;
  update public.customer_orders set updated_at = now() where id = o.id;
end;
$$;

-- 6. the rider, the photos, COMPLETE DELIVERY (the same rules as on the order page)
create or replace function public.delivery_save(p_no text, p_code text, p_data jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders;
begin
  o := public.co_paper_open(p_no, p_code);
  perform public.set_order_delivery(o.id, p_data);
end;
$$;
create or replace function public.delivery_photos(p_no text, p_code text, p_photos text[]) returns text[]
language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders;
begin
  o := public.co_paper_open(p_no, p_code);
  return public.set_order_photos(o.id, p_photos);
end;
$$;
create or replace function public.delivery_complete(p_no text, p_code text) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders;
begin
  o := public.co_paper_open(p_no, p_code);
  o := public.complete_customer_order(o.id);
  if o.completed_by_name is null then
    update public.customer_orders set completed_by_name = left('ORDER PAPER · ' || coalesce(o.rider_name, ''), 120) where id = o.id returning * into o;
    perform public.notify_admins('Customer order ' || o.order_no || ' delivered', 'Completed by the order paper · rider ' || coalesce(o.rider_name, '') || ' · invoice '
      || coalesce((select invoice_no from public.customer_invoices where id = o.invoice_id), ''), 'custorder/' || o.id);
  end if;
end;
$$;
do $$
declare f text;
begin
  foreach f in array array['delivery_order(text,text)', 'delivery_add_box(text,text,jsonb)', 'delivery_remove_box(text,text,uuid)', 'delivery_save(text,text,jsonb)',
    'delivery_photos(text,text,text[])', 'delivery_complete(text,text)'] loop
    execute 'revoke execute on function public.' || f || ' from public';
    execute 'grant execute on function public.' || f || ' to anon, authenticated';
  end loop;
end $$;

-- 7. the photos taken on the paper's page: put in, seen and taken off only in the folder of an APPROVED order
--    (records/corder/<order>/delivery_...); the order's folder is known only to whoever opened the paper
create or replace function public.co_paper_folder(p_name text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare oid uuid;
begin
  if coalesce((storage.foldername(p_name))[1], '') <> 'corder' then return false; end if;
  begin oid := ((storage.foldername(p_name))[2])::uuid; exception when others then return false; end;
  return p_name like 'corder/' || oid || '/delivery\_%' and exists (select 1 from public.customer_orders where id = oid and status = 'approved');
end;
$$;
revoke execute on function public.co_paper_folder(text) from public;
grant execute on function public.co_paper_folder(text) to anon;
drop policy if exists "storage records: paper delivery upload" on storage.objects;
create policy "storage records: paper delivery upload" on storage.objects for insert to anon
  with check (bucket_id = 'records' and public.co_paper_folder(name));
drop policy if exists "storage records: paper delivery read" on storage.objects;
create policy "storage records: paper delivery read" on storage.objects for select to anon
  using (bucket_id = 'records' and public.co_paper_folder(name));
drop policy if exists "storage records: paper delivery delete" on storage.objects;
create policy "storage records: paper delivery delete" on storage.objects for delete to anon
  using (bucket_id = 'records' and public.co_paper_folder(name));

select case when to_regprocedure('public.delivery_complete(text,text)') is not null
    and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'customer_orders' and column_name = 'delivery_code')
    and not exists (select 1 from public.customer_orders where delivery_code is null)
    and position('eo.paper_order' in pg_get_functiondef('public.complete_customer_order(uuid)'::regprocedure)) > 0
  then 'UPDATE 3.39 READY - Complete Delivery by the order paper (secret code in its barcode and QR code)'
  else 'NOT READY - send this message to Claude' end as result;

-- ======== 049_lot_delete.sql ========
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.39: the Director deletes any purchase order (lot), also an APPROVED one (for example a
-- wrong or test lot). Its notices go too; its photos and voice notes are given back so their files are deleted.
-- Only the Director. Safe to run again.
-- =====================================================================
create or replace function public.delete_purchase_order(p_id uuid) returns text[]
language plpgsql security definer set search_path = '' as $$
declare po public.purchase_orders;
begin
  if not public.is_admin() then raise exception 'Only the Director can delete a purchase order'; end if;
  select * into po from public.purchase_orders where id = p_id for update;
  if not found then raise exception 'Purchase order not found'; end if;
  delete from public.notifications where title like 'Purchase order ' || po.po_no || ' %';
  delete from public.purchase_orders where id = p_id;
  return coalesce(po.photos, '{}') || coalesce(po.voices, '{}');
end;
$$;
revoke execute on function public.delete_purchase_order(uuid) from public, anon;
grant execute on function public.delete_purchase_order(uuid) to authenticated;

select case when position('cannot be deleted' in pg_get_functiondef('public.delete_purchase_order(uuid)'::regprocedure)) = 0
  then 'UPDATE 3.39 READY - the Director can delete any lot (purchase order), also an approved one'
  else 'NOT READY - send this message to Claude' end as result;

-- ======== 050_eva_boxes.sql ========
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.39: EVA AI for the Director only, and the BOX DATABASE from the Google Sheet
-- 1. EVA AI (its page, its chat, its idea in the Gate Pass window, its files and its log) is for the Director only.
-- 2. box_stock: every box of the Google Sheet DATABASE, columns A to G (serial no, product, brand, CTN, style, qty, batch).
--    The Director presses READ SHEET on the EVA AI page: the new rows come in and the old rows are removed, in one step.
-- 3. A box scanned or typed on a customer order (also on the Complete Delivery page of the order paper) takes its product,
--    brand, CTN, style, qty and batch from box_stock by itself.
-- Needs 048_delivery_paper.sql. Safe to run again.
-- =====================================================================
do $$ begin
  if to_regprocedure('public.delivery_add_box(text,text,jsonb)') is null then raise exception 'Run 048_delivery_paper.sql first, then run this again.'; end if;
end $$;

-- 1. EVA AI: the Director only (was: staff with Customer access)
create or replace function public.ai_can_read() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_admin();
$$;

-- EVA's settings (the Google Sheet link, when it was read last): the Director only
create table if not exists public.ai_settings (
  key text primary key check (char_length(key) between 1 and 60),
  value jsonb not null default '{}'::jsonb,
  updated_by_name text,
  updated_at timestamptz not null default now()
);
alter table public.ai_settings enable row level security;
revoke all on public.ai_settings from anon;
grant select, insert, update, delete on public.ai_settings to authenticated;
drop policy if exists "ai settings: director" on public.ai_settings;
create policy "ai settings: director" on public.ai_settings for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- 2. the box database (read from the sheet; only READ SHEET changes it)
create table if not exists public.box_stock (
  serial_no text primary key check (char_length(serial_no) between 1 and 60),
  product text check (char_length(product) <= 120),
  brand text check (char_length(brand) <= 80),
  ctn text check (char_length(ctn) <= 30),
  style text check (char_length(style) <= 30),
  qty integer not null default 0 check (qty >= 0),
  batch text check (char_length(batch) <= 40),
  read_at timestamptz not null default now()
);
create index if not exists box_stock_batch_idx on public.box_stock(batch);
alter table public.box_stock enable row level security;
revoke all on public.box_stock from anon, authenticated;
grant select on public.box_stock to authenticated;
-- read: the Director and the staff who make customer orders (a typed box fills from it)
drop policy if exists "box stock: read" on public.box_stock;
create policy "box stock: read" on public.box_stock for select to authenticated
  using ((select public.is_admin()) or (select public.co_can_read()));

-- READ SHEET: p_rows = [{serial_no, product, brand, ctn, style, qty, batch}, ...] (columns A to G of the sheet). The old
-- rows are removed and the new ones put in; a serial no written twice keeps its last row. Gives the number of boxes.
create or replace function public.replace_box_stock(p_rows jsonb, p_source text default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer; me text := (select full_name from public.profiles where id = auth.uid());
begin
  if not public.is_admin() then raise exception 'Only the Director can read the box database'; end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'The sheet has no boxes (column A: the serial no).'; end if;
  if jsonb_array_length(p_rows) > 100000 then raise exception 'Up to 100,000 boxes can be read.'; end if;
  delete from public.box_stock where true;
  insert into public.box_stock (serial_no, product, brand, ctn, style, qty, batch)
  select distinct on (x.s) x.s,
    nullif(left(trim(coalesce(x.r ->> 'product', '')), 120), ''), nullif(left(trim(coalesce(x.r ->> 'brand', '')), 80), ''),
    nullif(left(trim(coalesce(x.r ->> 'ctn', '')), 30), ''), nullif(left(upper(trim(coalesce(x.r ->> 'style', ''))), 30), ''),
    case when trim(coalesce(x.r ->> 'qty', '')) ~ '^\d{1,9}(\.\d+)?$' then round(trim(x.r ->> 'qty')::numeric)::integer else 0 end,
    nullif(left(upper(trim(coalesce(x.r ->> 'batch', ''))), 40), '')
  from (select left(upper(regexp_replace(trim(coalesce(e.r ->> 'serial_no', '')), '\s+', ' ', 'g')), 60) s, e.r, e.ord
        from jsonb_array_elements(p_rows) with ordinality as e(r, ord)) x
  where x.s <> ''
  order by x.s, x.ord desc;
  get diagnostics n = row_count;
  insert into public.ai_settings (key, value, updated_by_name, updated_at)
  values ('box_sheet_read', jsonb_build_object('boxes', n, 'source', left(coalesce(p_source, ''), 300), 'read_at', now()), me, now())
  on conflict (key) do update set value = excluded.value, updated_by_name = excluded.updated_by_name, updated_at = excluded.updated_at;
  return n;
end;
$$;
revoke execute on function public.replace_box_stock(jsonb, text) from public, anon;
grant execute on function public.replace_box_stock(jsonb, text) to authenticated;

-- 3. a box put on a customer order takes its details from the box database (when its serial no is there)
alter table public.customer_order_boxes add column if not exists brand text;
alter table public.customer_order_boxes add column if not exists ctn text;
create or replace function public.co_box_from_stock() returns trigger
language plpgsql security definer set search_path = '' as $$
declare s public.box_stock;
begin
  select * into s from public.box_stock where serial_no = new.serial_no;
  if found then
    new.items := coalesce(nullif(trim(s.product), ''), new.items);
    new.brand := coalesce(nullif(nullif(trim(s.brand), ''), '-'), new.brand);
    new.ctn := coalesce(nullif(trim(s.ctn), ''), new.ctn);
    new.code := coalesce(nullif(upper(trim(s.style)), ''), new.code);
    new.pcs := case when s.qty > 0 then s.qty else new.pcs end;
    new.batch_no := coalesce(nullif(upper(trim(s.batch)), ''), new.batch_no);
  end if;
  return new;
end;
$$;
revoke execute on function public.co_box_from_stock() from public, anon, authenticated;
drop trigger if exists cob_stock_bi on public.customer_order_boxes;
create trigger cob_stock_bi before insert on public.customer_order_boxes for each row execute function public.co_box_from_stock();

-- the Complete Delivery page of the order paper shows the brand and the CTN of each box too
create or replace function public.delivery_order(p_no text, p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare o public.customer_orders; c public.customers;
begin
  o := public.co_by_paper(p_no, p_code);
  select * into c from public.customers where id = o.customer_id;
  return jsonb_build_object('id', o.id, 'order_no', o.order_no, 'status', o.status, 'state', public.co_paper_state(o), 'order_date', o.order_date,
    'customer', trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), 'account_no', c.account_no, 'address', coalesce(o.address, c.address),
    'reference', o.reference, 'total_boxes', o.total_boxes, 'total_pcs', o.total_pcs,
    'lines', (select coalesce(jsonb_agg(jsonb_build_object('code', l ->> 'code', 'product', l ->> 'product', 'lot', l ->> 'lot', 'boxes', l -> 'boxes', 'pcs', l -> 'pcs', 'qty', l -> 'qty')), '[]'::jsonb)
      from jsonb_array_elements(coalesce(o.lines, '[]'::jsonb)) l),
    'boxes', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'serial_no', b.serial_no, 'code', b.code, 'batch_no', b.batch_no, 'items', b.items, 'brand', b.brand, 'ctn', b.ctn,
      'pcs', b.pcs, 'remarks', b.remarks) order by b.created_at, b.id), '[]'::jsonb) from public.customer_order_boxes b where b.order_id = o.id),
    'rider_name', o.rider_name, 'rider_id_no', o.rider_id_no, 'plate_no', o.plate_no, 'vehicle_type', o.vehicle_type, 'delivered_at', o.delivered_at,
    'delivery_note', o.delivery_note, 'delivery_photos', to_jsonb(coalesce(o.delivery_photos, '{}')), 'completed_at', o.completed_at, 'completed_by_name', o.completed_by_name);
end;
$$;
create or replace function public.delivery_add_box(p_no text, p_code text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders; b public.customer_order_boxes;
begin
  o := public.co_paper_open(p_no, p_code);
  b := public.add_order_box(o.id, p_data);
  if b.added_by_name is null then update public.customer_order_boxes set added_by_name = 'ORDER PAPER' where id = b.id returning * into b; end if;
  return jsonb_build_object('id', b.id, 'serial_no', b.serial_no, 'code', b.code, 'batch_no', b.batch_no, 'items', b.items, 'brand', b.brand, 'ctn', b.ctn, 'pcs', b.pcs, 'remarks', b.remarks);
end;
$$;
revoke execute on function public.delivery_order(text, text) from public;
grant execute on function public.delivery_order(text, text) to anon, authenticated;
revoke execute on function public.delivery_add_box(text, text, jsonb) from public;
grant execute on function public.delivery_add_box(text, text, jsonb) to anon, authenticated;

select case when position('is_admin' in pg_get_functiondef('public.ai_can_read()'::regprocedure)) > 0
    and position('has_module' in pg_get_functiondef('public.ai_can_read()'::regprocedure)) = 0
    and to_regclass('public.box_stock') is not null and to_regprocedure('public.replace_box_stock(jsonb,text)') is not null
    and exists (select 1 from pg_trigger where tgname = 'cob_stock_bi')
  then 'UPDATE 3.39 READY - EVA AI for the Director only; the box database (READ SHEET) fills the boxes of customer orders'
  else 'NOT READY - send this message to Claude' end as result;

-- ======== 051_order_invoice.sql ========
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.39: COMPLETE DELIVERY makes the customer's invoice and bills it by itself
-- (as since 3.37: the invoice is on the customer's account at once - Balance Due and the statement of account). Now also:
-- the Director is told which invoice was billed (an order completed by staff), and an invoice made from the order paper
-- (no sign-in) shows "E-PORTAL · <order no>" as the one who made it. The invoice shows the order no as ORDER NO.
-- Needs 048_delivery_paper.sql. Safe to run again.
-- =====================================================================
do $$ begin
  if to_regprocedure('public.delivery_complete(text,text)') is null then raise exception 'Run 048_delivery_paper.sql first, then run this again.'; end if;
end $$;

-- COMPLETE: the order was delivered (the rider and a delivery photo are needed). The invoice is made and billed to the
-- customer by itself (invoice date today, the order's boxes, pcs, amount and terms; order no = the order's no).
create or replace function public.complete_customer_order(p_id uuid) returns public.customer_orders
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare o public.customer_orders; inv uuid; ino text; me text := (select full_name from public.profiles where id = auth.uid());
  paper boolean := coalesce(current_setting('eo.paper_order', true), '') = p_id::text;
begin
  if not public.qc_can_write() and not paper then raise exception 'Not allowed'; end if;
  select * into o from public.customer_orders where id = p_id for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status <> 'approved' then raise exception '%', case when o.status = 'pending' then 'Order ' || o.order_no || ' waits for the Director''s approval' else 'Order ' || o.order_no || ' is ' || upper(o.status) end; end if;
  if coalesce(o.rider_name, '') = '' then raise exception 'Add the rider details first'; end if;
  if cardinality(o.delivery_photos) = 0 then raise exception 'Add a delivery photo first'; end if;
  insert into public.customer_invoices (customer_id, invoice_date, purchase_date, po_number, total_boxes, total_pcs, total_amount, payment_terms)
  values (o.customer_id, current_date, o.order_date, o.order_no, o.total_boxes, o.total_pcs, o.total_amount, o.payment_terms)
  returning id, invoice_no into inv, ino;
  update public.customer_orders set status = 'completed', invoice_id = inv, completed_at = now(), completed_by_name = me,
    delivered_at = coalesce(delivered_at, now()), updated_at = now()
  where id = p_id returning * into o;
  -- the one who made the order is told (a Director who made it hears it once, with the Director's notice below)
  if o.created_by is distinct from auth.uid() and not ((paper or not public.is_admin())
      and exists (select 1 from public.profiles where id = o.created_by and role = 'admin' and status = 'active')) then
    perform public.notify_user(o.created_by, 'Customer order ' || o.order_no || ' delivered', 'Invoice ' || ino || ' was made and billed', 'custorder/' || o.id);
  end if;
  -- the Director is told (not for the Director's own COMPLETE; the order paper sends its own notice)
  if not paper and not public.is_admin() then
    perform public.notify_admins('Invoice ' || ino || ' billed', 'Customer order ' || o.order_no || ' delivered by ' || coalesce(me, '') || ' · ₱ '
      || to_char(o.total_amount, 'FM999,999,999,990.00') || ' billed to ' || (select trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')) from public.customers where id = o.customer_id), 'invoice/' || inv);
  end if;
  return o;
end;
$$;
revoke execute on function public.complete_customer_order(uuid) from public, anon;
grant execute on function public.complete_customer_order(uuid) to authenticated;

-- COMPLETE DELIVERY by the order paper: the invoice made shows "E-PORTAL · <order no>" as its maker
create or replace function public.delivery_complete(p_no text, p_code text) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders;
begin
  o := public.co_paper_open(p_no, p_code);
  o := public.complete_customer_order(o.id);
  if o.completed_by_name is null then
    update public.customer_orders set completed_by_name = left('ORDER PAPER · ' || coalesce(o.rider_name, ''), 120) where id = o.id returning * into o;
    perform set_config('eo.allow_change', 'on', true);
    update public.customer_invoices set created_by_name = 'E-PORTAL · ' || o.order_no where id = o.invoice_id and created_by_name is null;
    perform set_config('eo.allow_change', 'off', true);
    perform public.notify_admins('Customer order ' || o.order_no || ' delivered', 'Completed by the order paper · rider ' || coalesce(o.rider_name, '') || ' · invoice '
      || coalesce((select invoice_no from public.customer_invoices where id = o.invoice_id), '') || ' billed', 'custorder/' || o.id);
  end if;
end;
$$;
revoke execute on function public.delivery_complete(text, text) from public;
grant execute on function public.delivery_complete(text, text) to anon, authenticated;

select case when position('billed' in pg_get_functiondef('public.complete_customer_order(uuid)'::regprocedure)) > 0
    and position('eo.paper_order' in pg_get_functiondef('public.complete_customer_order(uuid)'::regprocedure)) > 0
    and position('E-PORTAL' in pg_get_functiondef('public.delivery_complete(text,text)'::regprocedure)) > 0
  then 'UPDATE 3.39 READY - COMPLETE DELIVERY makes the invoice and bills it to the customer by itself'
  else 'NOT READY - send this message to Claude' end as result;

-- =====================================================================
-- the check: all four updates are on the server now
-- =====================================================================
select case when to_regprocedure('public.delivery_complete(text,text)') is not null
    and not exists (select 1 from public.customer_orders where delivery_code is null)
    and position('eo.paper_order' in pg_get_functiondef('public.complete_customer_order(uuid)'::regprocedure)) > 0
    and position('billed' in pg_get_functiondef('public.complete_customer_order(uuid)'::regprocedure)) > 0
    and position('cannot be deleted' in pg_get_functiondef('public.delete_purchase_order(uuid)'::regprocedure)) = 0
    and position('has_module' in pg_get_functiondef('public.ai_can_read()'::regprocedure)) = 0
    and to_regclass('public.box_stock') is not null and exists (select 1 from pg_trigger where tgname = 'cob_stock_bi')
  then 'UPDATE 3.39 READY - Complete Delivery by the order paper; invoice made and billed by itself; EVA AI (chat) for the Director only; box database from the Google Sheet; the Director deletes any lot'
  else 'NOT READY - send this message to Claude' end as result;
