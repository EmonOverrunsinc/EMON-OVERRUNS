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
