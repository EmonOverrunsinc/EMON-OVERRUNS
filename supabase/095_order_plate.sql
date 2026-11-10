-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.98: ORDER TRACKING - THE CAR PLATE NO AND THE PROOF OF DELIVERY
-- * The tracking of a customer order: ORDER CREATED, CONFIRMED, BOX SERIALS ADDED, SORTING, then DELIVERED with the
--   LICENSE PLATE NUMBER of the car and the PROOF OF DELIVERY photo (shown like a courier's tracking).
-- * The car plate no and the proof of delivery photo are optional.
-- * The customer sees the same tracking on their portal (with the plate no).
-- Needs 090_order_tracking.sql. Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again.
-- The last line says: UPDATE 3.98 READY - ...
-- =====================================================================
do $$
begin
  if to_regprocedure('public.order_track(uuid,text,uuid,text)') is null then raise exception 'Update 3.98: run 090_order_tracking.sql first, then this one'; end if;
end $$;

alter table public.customer_orders add column if not exists plate_no text;

-- 1) the car plate no of the delivery (EO-Office on the order; after it is completed: EMON HASAN or who completed it)
create or replace function public.set_order_plate(p_id uuid, p_plate text)
returns public.customer_orders language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders; plate text := nullif(left(upper(btrim(regexp_replace(coalesce(p_plate, ''), '\s+', ' ', 'g'))), 30), '');
begin
  if not public.qc_can_write() and not public.can_edit_delivery(p_id) and coalesce(current_setting('eo.paper_order', true), '') is distinct from p_id::text then raise exception 'Not allowed'; end if;
  select * into o from public.customer_orders where id = p_id for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status <> 'approved' and not public.can_edit_delivery(p_id) then raise exception 'The car plate no of order % cannot be changed now (%)', o.order_no, upper(o.status); end if;
  if plate is null then raise exception 'Write the car plate no'; end if;
  update public.customer_orders set plate_no = plate, updated_at = now(),
    delivery_edited_at = case when o.status = 'completed' then now() else delivery_edited_at end,
    delivery_edited_by_name = case when o.status = 'completed' then (select full_name from public.profiles where id = auth.uid()) else delivery_edited_by_name end
  where id = p_id returning * into o;
  return o;
end $$;
revoke execute on function public.set_order_plate(uuid, text) from public, anon;
grant execute on function public.set_order_plate(uuid, text) to authenticated;

-- the same from the order paper (the Complete Delivery page)
create or replace function public.delivery_plate(p_no text, p_code text, p_plate text)
returns text language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders;
begin
  perform private.guard('delivery_plate', 60);
  o := public.co_paper_open(p_no, p_code);
  o := public.set_order_plate(o.id, p_plate);
  return o.plate_no;
end $$;
revoke execute on function public.delivery_plate(text, text, text) from public;
grant execute on function public.delivery_plate(text, text, text) to anon, authenticated;

-- 2) the car plate no and the proof of delivery photo are OPTIONAL (no rule refuses a delivery without them)
drop trigger if exists customer_orders_delivery_proof on public.customer_orders;
drop function if exists public.customer_orders_delivery_proof();

-- 3) the Complete Delivery page reads the plate no
do $$
declare def text := pg_get_functiondef('public.delivery_order(text,text)'::regprocedure);
begin
  if position('''plate_no''' in def) = 0 then
    if position('''delivered_at'', o.delivered_at, ''delivery_photos''' in def) = 0 then raise exception 'Update 3.98: delivery_order has changed - send this message to Claude'; end if;
    def := replace(def, '''delivered_at'', o.delivered_at, ''delivery_photos''', '''delivered_at'', o.delivered_at, ''plate_no'', o.plate_no, ''delivery_photos''');
    execute def;
  end if;
end $$;

-- 4) the customer's own tracking: the plate no, the box serials added
do $$
declare def text := pg_get_functiondef('public.customer_history(text,text)'::regprocedure);
  a constant text := '''proof_photos'', coalesce(cardinality(o.delivery_photos), 0),';
begin
  if position('''plate_no''' in def) = 0 then
    if position(a in def) = 0 then raise exception 'Update 3.98: customer_history has changed - send this message to Claude'; end if;
    def := replace(def, a, a || ' ''plate_no'', o.plate_no, ''created_at'', o.created_at,
        ''boxes_added'', (select count(b.serial_no) from public.customer_order_boxes b where b.order_id = o.id),
        ''boxes_at'', (select max(b.created_at) from public.customer_order_boxes b where b.order_id = o.id and b.serial_no is not null),');
    execute def;
  end if;
end $$;

notify pgrst, 'reload schema';

select case when to_regprocedure('public.set_order_plate(uuid,text)') is not null and to_regprocedure('public.delivery_plate(text,text,text)') is not null
    and position('''plate_no''' in pg_get_functiondef('public.delivery_order(text,text)'::regprocedure)) > 0
    and position('''plate_no''' in pg_get_functiondef('public.customer_history(text,text)'::regprocedure)) > 0
  then 'UPDATE 3.98 READY - order tracking with the car plate no and the proof of delivery photo'
  else 'NOT READY - send this message to Claude' end as result;
