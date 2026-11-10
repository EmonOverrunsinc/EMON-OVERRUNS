-- =====================================================================
-- EMON OVERRUNS E-PORTAL - RUN 096 AND 097 TOGETHER (both safe to run again)
-- 096: an order shows no address · 097: the type of car of a delivery
-- Needs RUN_090_AND_095.sql. Paste all of it in Supabase > SQL Editor > New query and press Run.
-- The last line says: UPDATE 3.99.3 READY
-- =====================================================================
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.99.2: AN ORDER SHOWS NO ADDRESS (PERSONAL DATA)
-- The Complete Delivery page (opened by the QR code of the printed order, also by a person who is not signed in) no
-- longer receives the customer's address from the database.
-- Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again.
-- The last line says: UPDATE 3.99.2 READY - ...
-- =====================================================================
do $$
declare def text := pg_get_functiondef('public.delivery_order(text,text)'::regprocedure);
  a constant text := ' ''address'', coalesce(o.address, c.address),';
begin
  if position('''address''' in def) > 0 then
    if position(a in def) = 0 then raise exception 'Update 3.99.2: delivery_order has changed - send this message to Claude'; end if;
    def := replace(def, a, '');
    execute def;
  end if;
end $$;

notify pgrst, 'reload schema';

select case when position('''address''' in pg_get_functiondef('public.delivery_order(text,text)'::regprocedure)) = 0
  then 'UPDATE 3.99.2 READY - the Complete Delivery page gets no customer address'
  else 'NOT READY - send this message to Claude' end as result;

-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.99.3: THE TYPE OF CAR OF A DELIVERY
-- With the car plate no, a delivery can say what type of car it was (VAN, TRUCK, MOTORCYCLE ...). Both are optional.
-- It shows on the tracking, on Proof of Delivery, on the printed order and on the customer's own tracking.
-- Needs 095_order_plate.sql (RUN_090_AND_095.sql). Paste all of it in Supabase > SQL Editor > New query and press Run.
-- Safe to run again. The last line says: UPDATE 3.99.3 READY - ...
-- =====================================================================
do $$
begin
  if to_regprocedure('public.set_order_plate(uuid,text)') is null then raise exception 'Update 3.99.3: run RUN_090_AND_095.sql first, then this one'; end if;
end $$;

alter table public.customer_orders add column if not exists vehicle_type text;

-- the car of the delivery: its plate no and its type (either can be empty)
create or replace function public.set_order_car(p_id uuid, p_plate text, p_type text)
returns public.customer_orders language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders;
  plate text := nullif(left(upper(btrim(regexp_replace(coalesce(p_plate, ''), '\s+', ' ', 'g'))), 30), '');
  kind text := nullif(left(upper(btrim(regexp_replace(coalesce(p_type, ''), '\s+', ' ', 'g'))), 40), '');
begin
  if not public.qc_can_write() and not public.can_edit_delivery(p_id) and coalesce(current_setting('eo.paper_order', true), '') is distinct from p_id::text then raise exception 'Not allowed'; end if;
  select * into o from public.customer_orders where id = p_id for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status <> 'approved' and not public.can_edit_delivery(p_id) then raise exception 'The car of order % cannot be changed now (%)', o.order_no, upper(o.status); end if;
  update public.customer_orders set plate_no = plate, vehicle_type = kind, updated_at = now(),
    delivery_edited_at = case when o.status = 'completed' then now() else delivery_edited_at end,
    delivery_edited_by_name = case when o.status = 'completed' then (select full_name from public.profiles where id = auth.uid()) else delivery_edited_by_name end
  where id = p_id returning * into o;
  return o;
end $$;
revoke execute on function public.set_order_car(uuid, text, text) from public, anon;
grant execute on function public.set_order_car(uuid, text, text) to authenticated;

-- the same from the order paper (the Complete Delivery page)
create or replace function public.delivery_car(p_no text, p_code text, p_plate text, p_type text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders;
begin
  perform private.guard('delivery_car', 60);
  o := public.co_paper_open(p_no, p_code);
  o := public.set_order_car(o.id, p_plate, p_type);
  return jsonb_build_object('plate_no', o.plate_no, 'vehicle_type', o.vehicle_type);
end $$;
revoke execute on function public.delivery_car(text, text, text, text) from public;
grant execute on function public.delivery_car(text, text, text, text) to anon, authenticated;

-- the Complete Delivery page and the customer's own tracking read the type of car
do $$
declare def text := pg_get_functiondef('public.delivery_order(text,text)'::regprocedure);
begin
  if position('''vehicle_type''' in def) = 0 then
    if position('''plate_no'', o.plate_no,' in def) = 0 then raise exception 'Update 3.99.3: delivery_order has changed - send this message to Claude'; end if;
    def := replace(def, '''plate_no'', o.plate_no,', '''plate_no'', o.plate_no, ''vehicle_type'', o.vehicle_type,');
    execute def;
  end if;
  def := pg_get_functiondef('public.customer_history(text,text)'::regprocedure);
  if position('''vehicle_type''' in def) = 0 then
    if position('''plate_no'', o.plate_no,' in def) = 0 then raise exception 'Update 3.99.3: customer_history has changed - send this message to Claude'; end if;
    def := replace(def, '''plate_no'', o.plate_no,', '''plate_no'', o.plate_no, ''vehicle_type'', o.vehicle_type,');
    execute def;
  end if;
end $$;

notify pgrst, 'reload schema';

select case when to_regprocedure('public.set_order_car(uuid,text,text)') is not null and to_regprocedure('public.delivery_car(text,text,text,text)') is not null
    and position('''vehicle_type''' in pg_get_functiondef('public.delivery_order(text,text)'::regprocedure)) > 0
    and position('''vehicle_type''' in pg_get_functiondef('public.customer_history(text,text)'::regprocedure)) > 0
  then 'UPDATE 3.99.3 READY - a delivery has the type of car with its plate no'
  else 'NOT READY - send this message to Claude' end as result;
