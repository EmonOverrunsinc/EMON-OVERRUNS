-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.44: the Director deletes any customer order (for example a test order), also a
-- COMPLETED one: its boxes, notices and photos go, and the invoice it made goes too (off the customer's balance and the
-- statements of account), unless a payment is on that invoice (remove that payment first).
-- Needs RUN_048_TO_051.sql (already run). Safe to run again.
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

select case when position('COMPLETED (it has its invoice)' in pg_get_functiondef('public.delete_customer_order(uuid)'::regprocedure)) = 0
  then 'UPDATE 3.44 READY - the Director can delete any customer order (a completed one with its invoice too)'
  else 'NOT READY - send this message to Claude' end as result;
