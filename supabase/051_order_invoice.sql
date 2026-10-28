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
