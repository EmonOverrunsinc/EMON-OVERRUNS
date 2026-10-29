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

-- 1. COMPLETE: the delivery photo is needed (no rider details any more)
create or replace function public.complete_customer_order(p_id uuid) returns public.customer_orders
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare o public.customer_orders; inv uuid; ino text; me text := (select full_name from public.profiles where id = auth.uid());
  paper boolean := coalesce(current_setting('eo.paper_order', true), '') = p_id::text;
begin
  if not public.qc_can_write() and not paper then raise exception 'Not allowed'; end if;
  select * into o from public.customer_orders where id = p_id for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status <> 'approved' then raise exception '%', case when o.status = 'pending' then 'Order ' || o.order_no || ' waits for the Director''s approval' else 'Order ' || o.order_no || ' is ' || upper(o.status) end; end if;
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
  if cardinality(o.delivery_photos) = 0 then raise exception 'Add a delivery photo first'; end if;
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

select case when position('rider' in pg_get_functiondef('public.complete_customer_order(uuid)'::regprocedure)) = 0
    and to_regprocedure('public.decide_delivery(uuid,text)') is not null
    and (select data_type from information_schema.routines where routine_schema = 'public' and routine_name = 'delivery_complete') = 'text'
  then 'UPDATE 3.45 READY - no rider details; a delivery by the order paper without sign-in waits for the Director''s approval'
  else 'NOT READY - send this message to Claude' end as result;
