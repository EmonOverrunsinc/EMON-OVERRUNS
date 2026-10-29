-- =====================================================================
-- EMON OVERRUNS E-PORTAL - ALL DATABASE UPDATES 052 TO 059 IN ONE FILE (versions 3.40 to 3.48)
--   052 scan boxes on the order form · 053 find & add a box by serial no · 054 Director chooses who uses EVA AI
--   055 the Director deletes any customer order (a completed one with its invoice)
--   056 no rider / car details; delivery by the order paper without sign-in waits for approval
--   057 add a box without a serial no · 058 delivery photo optional · 059 voucher account (pick or add)
-- Needs RUN_048_TO_051.sql (already run). SAFE TO RUN AGAIN: parts you ran before are only made again, no data is changed.
-- Paste all of it in Supabase > SQL Editor > New query and press Run. The last line says: UPDATE 3.48 READY - ...
-- =====================================================================

-- ##################### RUN_052_TO_054.sql #####################
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - RUN THIS ONE FILE: updates 3.40 to 3.43
--   052  SCAN BOXES on the order form: the lines fill from the box database, the boxes go on the order (052_order_scan.sql)
--   053  FIND & ADD a box by its serial no on the Complete Delivery page                               (053_box_find.sql)
--   054  WHO CAN USE EVA AI is chosen by the Director (Menu Access: 12 EVA AI)                         (054_ai_access.sql)
-- Needs RUN_048_TO_051.sql (already run). Paste all of it in Supabase > SQL Editor > New query and press Run.
-- Safe to run again (also if 052 or 053 was run before). The last line says: UPDATE 3.43 READY - ...
-- =====================================================================

-- ===== 052_order_scan.sql =====
-- EMON OVERRUNS E-PORTAL - Update 3.40: SCAN BOXES while making a customer order
-- Each box scanned (or typed) on the order form - for example U20261238 - fills the order lines from the box database (the
-- Google Sheet, columns A to G: product, brand, CTN, style, qty, batch). When the order is saved, the scanned boxes are put on
-- the order in the same step: all or nothing (a box already on another order stops the save and says which order).
-- Needs RUN_048_TO_051.sql (already run). Safe to run again.
do $$ begin
  if to_regclass('public.box_stock') is null then raise exception 'Run RUN_048_TO_051.sql first, then run this again.'; end if;
end $$;

-- the order (as save_customer_order) and its scanned boxes (as add_order_box: each takes its details from box_stock)
create or replace function public.save_order_with_boxes(p_id uuid, p_data jsonb, p_boxes text[]) returns public.customer_orders
language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders; s text;
begin
  if cardinality(coalesce(p_boxes, '{}')) > 500 then raise exception 'An order has up to 500 boxes'; end if;
  o := public.save_customer_order(p_id, p_data);
  foreach s in array coalesce(p_boxes, '{}') loop
    s := left(upper(regexp_replace(trim(coalesce(s, '')), '\s+', ' ', 'g')), 60);
    continue when s = '' or exists (select 1 from public.customer_order_boxes where order_id = o.id and serial_no = s);
    perform public.add_order_box(o.id, jsonb_build_object('serial_no', s, 'added_how', 'scan'));
    -- the boxes keep the order they were scanned in (all are saved in one moment)
    update public.customer_order_boxes set created_at = clock_timestamp() where order_id = o.id and serial_no = s;
  end loop;
  select * into o from public.customer_orders where id = o.id;
  return o;
end;
$$;
revoke execute on function public.save_order_with_boxes(uuid, jsonb, text[]) from public, anon;
grant execute on function public.save_order_with_boxes(uuid, jsonb, text[]) to authenticated;


-- ===== 053_box_find.sql =====
-- EMON OVERRUNS E-PORTAL - Update 3.41: FIND A BOX by its serial no on the Complete Delivery page of the order paper
-- The page (opened by the order paper, signed in or not) looks the serial no up in the box database (the Google Sheet) before
-- the box is added: a box found is added with its details; a box not found is not added (Add Box types it by hand).
-- Needs RUN_048_TO_051.sql (already run). Safe to run again.
do $$ begin
  if to_regclass('public.box_stock') is null then raise exception 'Run RUN_048_TO_051.sql first, then run this again.'; end if;
end $$;

-- the box of a serial no in the box database (null: not there); only with an order paper that can be delivered now
create or replace function public.delivery_find_box(p_no text, p_code text, p_serial text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare o public.customer_orders; s public.box_stock;
begin
  o := public.co_by_paper(p_no, p_code);
  if o.status <> 'approved' then raise exception '%', public.co_paper_state(o); end if;
  select * into s from public.box_stock where serial_no = left(upper(regexp_replace(trim(coalesce(p_serial, '')), '\s+', ' ', 'g')), 60);
  if not found then return null; end if;
  return jsonb_build_object('serial_no', s.serial_no, 'product', s.product, 'brand', s.brand, 'ctn', s.ctn, 'style', s.style, 'qty', s.qty, 'batch', s.batch);
end;
$$;
revoke execute on function public.delivery_find_box(text, text, text) from public;
grant execute on function public.delivery_find_box(text, text, text) to anon, authenticated;


-- ===== 054_ai_access.sql =====
-- EMON OVERRUNS E-PORTAL - Update 3.43: WHO CAN USE EVA AI is chosen by the Director
-- Menu Access has a new tick box "12 EVA AI" (Employees - Access & Status). The Director always has EVA; a staff login has
-- it only when the Director ticks it (old logins with every menu do not get it by themselves). EVA answers only from
-- what that person may already see. Learn Now and the box database stay with the Director.
-- Needs RUN_048_TO_051.sql (already run). Safe to run again.
do $$ begin
  if to_regclass('public.ai_models') is null then raise exception 'Run RUN_048_TO_051.sql first, then run this again.'; end if;
end $$;

create or replace function public.ai_can_read() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_admin() or (public.is_staff() and exists (select 1 from public.profiles p
    where p.id = auth.uid() and p.status = 'active' and 'ai' = any(coalesce(p.modules, '{}'))));
$$;
revoke execute on function public.ai_can_read() from public, anon;
grant execute on function public.ai_can_read() to authenticated;


select case when to_regprocedure('public.save_order_with_boxes(uuid,jsonb,text[])') is not null
    and to_regprocedure('public.delivery_find_box(text,text,text)') is not null
    and position('''ai''' in pg_get_functiondef('public.ai_can_read()'::regprocedure)) > 0
  then 'UPDATE 3.43 READY - box scan on the order form; Find & Add on the Complete Delivery page; the Director chooses who can use EVA AI'
  else 'NOT READY - send this message to Claude' end as result;

-- ##################### 055_order_delete.sql #####################
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.44: the Director deletes any customer order (for example a test order), also a
-- COMPLETED one: its boxes, notices and photos go, and the invoice it made goes too (off the customer's balance and the
-- statements of account), unless a payment is on that invoice (remove that payment first).
-- Needs RUN_048_TO_051.sql (already run). Safe to run again.
-- =====================================================================
do $$ begin
  if to_regprocedure('public.delete_customer_order(uuid)') is null then raise exception 'Run 045_customer_orders.sql first, then run this again.'; end if;
end $$;

create or replace function public.delete_customer_order(p_id uuid) returns text[]
language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders; ino text; paths text[];
begin
  if not public.is_admin() then raise exception 'Only the Director can delete an order'; end if;
  select * into o from public.customer_orders where id = p_id for update;
  if not found then raise exception 'Order not found'; end if;
  paths := coalesce(o.delivery_photos, '{}');
  if o.invoice_id is not null then
    select invoice_no into ino from public.customer_invoices where id = o.invoice_id;
    if exists (select 1 from public.payment_links where invoice_id = o.invoice_id and removed_at is null)
        or exists (select 1 from public.payments_received where invoice_id = o.invoice_id) then
      raise exception 'Invoice % of order % has a payment. Remove that payment from the invoice first', ino, o.order_no;
    end if;
  end if;
  delete from public.notifications where title like 'Customer order ' || o.order_no || ' %'
    or (ino is not null and title = 'Invoice ' || ino || ' billed');
  delete from public.customer_orders where id = p_id;
  -- the invoice the order made: as when the Director deletes an invoice (its files; the statements made again)
  if o.invoice_id is not null and ino is not null then
    paths := paths || coalesce(public.delete_record('customer_invoices', o.invoice_id), '{}');
  end if;
  return paths;
end;
$$;
revoke execute on function public.delete_customer_order(uuid) from public, anon;
grant execute on function public.delete_customer_order(uuid) to authenticated;

select case when position('COMPLETED (it has its invoice)' in pg_get_functiondef('public.delete_customer_order(uuid)'::regprocedure)) = 0
  then 'UPDATE 3.44 READY - the Director can delete any customer order (a completed one with its invoice too)'
  else 'NOT READY - send this message to Claude' end as result;

-- ##################### RUN_056_TO_058.sql #####################
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - RUN THIS ONE FILE: updates 3.45, 3.46 and 3.47
--   056  no rider / car details; COMPLETE DELIVERY by the order paper without EO-Office sign-in waits for the Director's approval
--   057  ADD BOX without a serial no: kept on the order, not counted as a box
--   058  the DELIVERY PHOTO is optional: COMPLETE DELIVERY works with or without a photo
-- Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again (also after RUN_056_057.sql).
-- The last line says: UPDATE 3.47 READY - ...
-- =====================================================================
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.45: NO RIDER / CAR DETAILS, and COMPLETE DELIVERY by the order paper needs approval
-- 1. A customer order has no rider name, ID no, plate no or vehicle type any more: COMPLETE needs the delivery photo only.
-- 2. COMPLETE DELIVERY on the page opened by the order paper's QR code (VERIFICATION):
--    - signed in with EO-Office (or the Director): the order is COMPLETED at once (the invoice is made and billed);
--    - not signed in (or signed in without EO-Office): the delivery is SUBMITTED and waits for the Director's approval.
--      The Director approves it (COMPLETED, the invoice is made) or rejects it (the delivery can be done again).
-- Needs RUN_048_TO_051.sql (already run). Safe to run again.
-- =====================================================================
do $$ begin
  if to_regprocedure('public.delivery_complete(text,text)') is null then raise exception 'Run RUN_048_TO_051.sql first, then run this again.'; end if;
end $$;

alter table public.customer_orders add column if not exists delivery_request_at timestamptz;
alter table public.customer_orders add column if not exists delivery_request_by text;

-- 1. COMPLETE: no rider details; the delivery photo is optional (3.47)
create or replace function public.complete_customer_order(p_id uuid) returns public.customer_orders
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare o public.customer_orders; inv uuid; ino text; me text := (select full_name from public.profiles where id = auth.uid());
  paper boolean := coalesce(current_setting('eo.paper_order', true), '') = p_id::text;
begin
  if not public.qc_can_write() and not paper then raise exception 'Not allowed'; end if;
  select * into o from public.customer_orders where id = p_id for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status <> 'approved' then raise exception '%', case when o.status = 'pending' then 'Order ' || o.order_no || ' waits for the Director''s approval' else 'Order ' || o.order_no || ' is ' || upper(o.status) end; end if;
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

-- 2. the order paper's page: a delivery SUBMITTED waits for the Director (nothing more can be changed on the paper's page)
create or replace function public.co_paper_open(p_no text, p_code text) returns public.customer_orders
language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders;
begin
  o := public.co_by_paper(p_no, p_code);
  if o.status <> 'approved' then raise exception '%', public.co_paper_state(o); end if;
  if o.delivery_request_at is not null and not public.qc_can_write() then
    raise exception 'The delivery of order % was submitted and waits for the Director''s approval', o.order_no;
  end if;
  perform set_config('eo.paper_order', o.id::text, true);
  return o;
end;
$$;
revoke execute on function public.co_paper_open(text, text) from public, anon, authenticated;

-- what the page shows (no prices, no rider details)
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
    'boxes', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'serial_no', b.serial_no, 'code', b.code, 'batch_no', b.batch_no, 'items', b.items, 'pcs', b.pcs, 'remarks', b.remarks,
      'brand', b.brand, 'ctn', b.ctn) order by b.created_at, b.id), '[]'::jsonb) from public.customer_order_boxes b where b.order_id = o.id),
    'delivered_at', o.delivered_at, 'delivery_photos', to_jsonb(coalesce(o.delivery_photos, '{}')), 'completed_at', o.completed_at, 'completed_by_name', o.completed_by_name,
    'request_at', o.delivery_request_at, 'request_by', o.delivery_request_by, 'can_complete', auth.uid() is not null and public.qc_can_write());
end;
$$;
revoke execute on function public.delivery_order(text, text) from public;
grant execute on function public.delivery_order(text, text) to anon, authenticated;

-- COMPLETE DELIVERY on the paper's page: 'completed' (signed in with EO-Office) or 'submitted' (waits for the Director)
drop function if exists public.delivery_complete(text, text);
create function public.delivery_complete(p_no text, p_code text) returns text
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare o public.customer_orders; allowed boolean := auth.uid() is not null and public.qc_can_write();
  who text := coalesce((select full_name from public.profiles where id = auth.uid()), 'NOT SIGNED IN');
begin
  o := public.co_paper_open(p_no, p_code);
  if allowed then
    perform set_config('eo.paper_order', '', true);
    o := public.complete_customer_order(o.id);
    return 'completed';
  end if;
  update public.customer_orders set delivery_request_at = now(), delivery_request_by = left('ORDER PAPER · ' || who, 120), delivered_at = now(), updated_at = now()
    where id = o.id returning * into o;
  perform public.notify_admins('Customer order ' || o.order_no || ' delivery waits for approval',
    'Submitted by the order paper (' || who || ') · ' || (select count(*) from public.customer_order_boxes where order_id = o.id) || ' of ' || o.total_boxes
    || ' boxes · ' || cardinality(o.delivery_photos) || ' photo(s). Approve it to complete the order and bill the invoice.', 'custorder/' || o.id);
  return 'submitted';
end;
$$;
revoke execute on function public.delivery_complete(text, text) from public;
grant execute on function public.delivery_complete(text, text) to anon, authenticated;

-- 3. the Director approves a submitted delivery (COMPLETED, the invoice is made and billed) or rejects it (done again)
create or replace function public.decide_delivery(p_id uuid, p_action text) returns public.customer_orders
language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders;
begin
  if not public.is_admin() then raise exception 'Only the Director can approve a delivery'; end if;
  select * into o from public.customer_orders where id = p_id for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status <> 'approved' or o.delivery_request_at is null then raise exception 'No delivery of order % waits for approval', o.order_no; end if;
  if p_action = 'approve' then
    o := public.complete_customer_order(p_id);
    update public.customer_orders set completed_by_name = left(o.delivery_request_by || ' · APPROVED BY ' || coalesce(o.completed_by_name, ''), 120) where id = p_id returning * into o;
  elsif p_action = 'reject' then
    update public.customer_orders set delivery_request_at = null, delivery_request_by = null, delivered_at = null, updated_at = now() where id = p_id returning * into o;
  else raise exception 'Unknown action'; end if;
  delete from public.notifications where title = 'Customer order ' || o.order_no || ' delivery waits for approval';
  return o;
end;
$$;
revoke execute on function public.decide_delivery(uuid, text) from public, anon;
grant execute on function public.decide_delivery(uuid, text) to authenticated;

-- EMON OVERRUNS E-PORTAL - Update 3.46: ADD BOX without a serial no
-- A line with a serial no is a box (it counts as a box). A line added without one (items, pcs, code, batch no) is kept on
-- the order and the Delivery Sheet but is NOT counted as a box.
-- Needs 056_delivery_approval.sql (already run). Safe to run again.
do $$ begin
  if to_regprocedure('public.decide_delivery(uuid,text)') is null then raise exception 'Run 056_delivery_approval.sql first, then run this again.'; end if;
end $$;

alter table public.customer_order_boxes alter column serial_no drop not null;

-- a box (serial no) or a line without one (it needs the items or the pcs)
create or replace function public.add_order_box(p_order uuid, p_data jsonb) returns public.customer_order_boxes
language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders; b public.customer_order_boxes; s text; other text; me text := (select full_name from public.profiles where id = auth.uid());
begin
  if not public.qc_can_write() and coalesce(current_setting('eo.paper_order', true), '') is distinct from p_order::text then raise exception 'Not allowed'; end if;
  select * into o from public.customer_orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status not in ('pending','approved') then raise exception 'Order % is %: boxes cannot be added', o.order_no, upper(o.status); end if;
  s := nullif(left(upper(regexp_replace(trim(coalesce(p_data ->> 'serial_no', '')), '\s+', ' ', 'g')), 60), '');
  if s is null then
    if coalesce(trim(p_data ->> 'items'), '') = '' and coalesce(nullif(p_data ->> 'pcs', '')::numeric, 0) <= 0 then
      raise exception 'Write the serial no, or the items and pcs';
    end if;
  else
    perform pg_advisory_xact_lock(hashtext('order box ' || s)); -- the same box scanned on two orders at the same moment
    if exists (select 1 from public.customer_order_boxes where order_id = p_order and serial_no = s) then raise exception 'Box % is on this order already', s; end if;
    select x.order_no into other from public.customer_order_boxes y join public.customer_orders x on x.id = y.order_id
    where y.serial_no = s and x.status <> 'cancelled' and x.id <> p_order limit 1;
    if other is not null then raise exception 'Box % is on order % already', s, other; end if;
  end if;
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

-- the Director's notice of a submitted delivery counts the boxes only (lines without a serial no are not boxes)
do $$
declare def text := pg_get_functiondef('public.delivery_complete(text,text)'::regprocedure);
begin
  if position('count(serial_no) from public.customer_order_boxes' in def) = 0 then
    def := replace(def, 'count(*) from public.customer_order_boxes', 'count(serial_no) from public.customer_order_boxes');
    execute def;
  end if;
end $$;

-- EMON OVERRUNS E-PORTAL - Update 3.47: the DELIVERY PHOTO is optional
-- COMPLETE DELIVERY (and SUBMIT on the order paper's page) works with or without a photo. Photos added are kept as before.
-- Needs RUN_056_057.sql (already run). Safe to run again.
do $$
declare f text; def text;
begin
  if to_regprocedure('public.decide_delivery(uuid,text)') is null then raise exception 'Run RUN_056_057.sql first, then run this again.'; end if;
  foreach f in array array['complete_customer_order(uuid)', 'delivery_complete(text,text)'] loop
    def := pg_get_functiondef(('public.' || f)::regprocedure);
    if position('Add a delivery photo first' in def) > 0 then
      def := replace(replace(def, 'if cardinality(o.delivery_photos) = 0 then raise exception ''Add a delivery photo first''; end if;', ''),
        'if cardinality(o.delivery_photos) = 0 then raise exception ''Add a delivery photo first''; end if;', '');
      if position('Add a delivery photo first' in def) > 0 then raise exception 'Could not update %', f; end if;
      execute def;
    end if;
  end loop;
end $$;


select case when position('rider' in pg_get_functiondef('public.complete_customer_order(uuid)'::regprocedure)) = 0
    and position('Add a delivery photo first' in pg_get_functiondef('public.complete_customer_order(uuid)'::regprocedure)) = 0
    and position('Add a delivery photo first' in pg_get_functiondef('public.delivery_complete(text,text)'::regprocedure)) = 0
    and to_regprocedure('public.decide_delivery(uuid,text)') is not null
    and (select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'customer_order_boxes' and column_name = 'serial_no') = 'YES'
  then 'UPDATE 3.47 READY - no rider details; delivery photo optional; paper delivery needs the Director''s approval; Add Box without a serial no'
  else 'NOT READY - send this message to Claude' end as result;

-- ##################### 059_voucher_account.sql #####################
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.48: CHANGE THE ACCOUNT of a payment voucher
-- On the voucher page, the Director (or Billing staff) chooses which of the company's accounts the payment went to, or adds a
-- new account there. Only the account changes (the amount, date and voucher no stay). Safe to run again.
-- =====================================================================
create or replace function public.set_voucher_account(p_voucher uuid, p_account uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.pay_vouchers;
begin
  if not (public.is_admin() or public.can_write('billing')) then raise exception 'Not allowed'; end if;
  select * into v from public.pay_vouchers where id = p_voucher for update;
  if not found then raise exception 'Voucher not found'; end if;
  if p_account is not null and not exists (select 1 from public.pay_accounts a where a.id = p_account and a.company_id = v.company_id) then
    raise exception 'That account belongs to a different company';
  end if;
  perform public.allow_record_change();
  update public.pay_vouchers set account_id = p_account where id = p_voucher;
  perform set_config('eo.allow_change', 'off', true);
end;
$$;
revoke execute on function public.set_voucher_account(uuid, uuid) from public, anon;
grant execute on function public.set_voucher_account(uuid, uuid) to authenticated;

-- the portal sees the new function at once
notify pgrst, 'reload schema';

select case when to_regprocedure('public.set_voucher_account(uuid,uuid)') is not null
  then 'UPDATE 3.48 READY - change the account of a payment voucher (or add a new account) on the voucher page'
  else 'NOT READY - send this message to Claude' end as result;
