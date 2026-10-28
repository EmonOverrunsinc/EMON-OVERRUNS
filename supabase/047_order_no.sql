-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.38.1: Customer Order numbers OR-YYYYMM-#### (were CO-YYYYMM-####)
-- New orders get OR-202610-0002 and so on: the same count goes on. The orders made already get the new name too
-- (CO-202610-0001 becomes OR-202610-0001), with the PO number of their invoice and their notices.
-- Needs 045_customer_orders.sql (RUN_041_TO_046.sql). Safe to run again.
-- =====================================================================
do $$
declare def text;
begin
  if to_regprocedure('public.save_customer_order(uuid,jsonb)') is null then
    raise exception 'Run RUN_041_TO_046.sql first, then run this again.';
  end if;
  -- the new number: only the letters change (the count of the month stays the same)
  def := pg_get_functiondef('public.save_customer_order(uuid,jsonb)'::regprocedure);
  if position('''CO-'' || to_char(d' in def) > 0 then
    execute replace(def, '''CO-'' || to_char(d', '''OR-'' || to_char(d');
  end if;
  -- the orders made already: their invoice's PO number, their notices, then the order itself
  perform set_config('eo.allow_change', 'on', true);
  update public.customer_invoices i set po_number = 'OR' || substr(i.po_number, 3)
    from public.customer_orders o where o.invoice_id = i.id and i.po_number = o.order_no and o.order_no like 'CO-%';
  update public.notifications set title = replace(title, 'Customer order CO-', 'Customer order OR-') where title like 'Customer order CO-%';
  update public.customer_orders set order_no = 'OR' || substr(order_no, 3) where order_no like 'CO-%';
end $$;

select case when position('''OR-'' || to_char(d' in pg_get_functiondef('public.save_customer_order(uuid,jsonb)'::regprocedure)) > 0
    and not exists (select 1 from public.customer_orders where order_no like 'CO-%')
  then 'UPDATE 3.38.1 READY - Customer Order numbers are OR-YYYYMM-#### now (' || (select count(*) from public.customer_orders) || ' order(s))'
  else 'NOT READY - send this message to Claude' end as result;
