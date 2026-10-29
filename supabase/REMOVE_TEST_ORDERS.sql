-- =====================================================================
-- EMON OVERRUNS E-PORTAL - ONE TIME: REMOVE THE 2 TEST CUSTOMER ORDERS (for example OR-202610-0001)
-- Each test order goes with its boxes, notices and the invoice it made (off the customer's balance and the SOA).
-- It also adds update 3.44: the Director can delete any customer order from its page (Delete button).
-- SAFE: if the server has MORE than 2 customer orders, nothing is deleted and the list is shown - send it to Claude.
-- If a payment is on a test invoice, nothing is deleted and it says which - remove that payment first.
-- Paste all of it in Supabase > SQL Editor > New query and press Run. The last line says: TEST ORDERS REMOVED - ...
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

-- the test orders go (as the Director)
do $$
declare n int; r record; list text; director uuid;
begin
  select count(*), string_agg(order_no || ' (' || status || ')', ', ' order by order_no) into n, list from public.customer_orders;
  if n > 2 then raise exception 'There are % customer orders: %. Nothing deleted - send this message to Claude.', n, list; end if;
  select id into director from public.profiles where role = 'admin' and status = 'active' order by (email = 'emonoverruns@gmail.com') desc, created_at limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', director, 'role', 'authenticated')::text, true);
  for r in select id, order_no from public.customer_orders order by order_no loop
    perform public.delete_customer_order(r.id);
    raise notice 'deleted %', r.order_no;
  end loop;
  perform set_config('request.jwt.claims', '', true);
end $$;

select case when not exists (select 1 from public.customer_orders)
    and position('COMPLETED (it has its invoice)' in pg_get_functiondef('public.delete_customer_order(uuid)'::regprocedure)) = 0
  then 'TEST ORDERS REMOVED - no customer orders left; the Director can delete an order from its page (update 3.44)'
  else 'NOT DONE - send this message to Claude' end as result;
