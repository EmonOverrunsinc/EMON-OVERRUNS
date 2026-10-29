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
