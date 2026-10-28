-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.40: SCAN BOXES while making a customer order
-- Each box scanned (or typed) on the order form - for example U20261238 - fills the order lines from the box database (the
-- Google Sheet, columns A to G: product, brand, CTN, style, qty, batch). When the order is saved, the scanned boxes are put on
-- the order in the same step: all or nothing (a box already on another order stops the save and says which order).
-- Needs RUN_048_TO_051.sql (already run). Safe to run again.
-- =====================================================================
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

select case when to_regprocedure('public.save_order_with_boxes(uuid,jsonb,text[])') is not null and to_regclass('public.box_stock') is not null
  then 'UPDATE 3.40 READY - scan boxes on the order form: the lines fill from the box database and the boxes go on the order'
  else 'NOT READY - send this message to Claude' end as result;
