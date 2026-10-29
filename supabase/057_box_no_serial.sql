-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.46: ADD BOX without a serial no
-- A line with a serial no is a box (it counts as a box). A line added without one (items, pcs, code, batch no) is kept on
-- the order and the Delivery Sheet but is NOT counted as a box.
-- Needs 056_delivery_approval.sql (already run). Safe to run again.
-- =====================================================================
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

select case when (select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'customer_order_boxes' and column_name = 'serial_no') = 'YES'
    and position('Write the serial no, or the items and pcs' in pg_get_functiondef('public.add_order_box(uuid,jsonb)'::regprocedure)) > 0
  then 'UPDATE 3.46 READY - Add Box without a serial no: kept on the order, not counted as a box'
  else 'NOT READY - send this message to Claude' end as result;
