-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.41: FIND A BOX by its serial no on the Complete Delivery page of the order paper
-- The page (opened by the order paper, signed in or not) looks the serial no up in the box database (the Google Sheet) before
-- the box is added: a box found is added with its details; a box not found is not added (Add Box types it by hand).
-- Needs RUN_048_TO_051.sql (already run). Safe to run again.
-- =====================================================================
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

select case when to_regprocedure('public.delivery_find_box(text,text,text)') is not null
  then 'UPDATE 3.41 READY - the Complete Delivery page finds each box in the box database before it is added'
  else 'NOT READY - send this message to Claude' end as result;
