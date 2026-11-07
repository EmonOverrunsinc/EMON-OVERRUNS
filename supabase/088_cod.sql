-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.84: CASH ON DELIVERY IS WRITTEN "COD"
-- The terms of payment CASH ON DELIVERY are now COD everywhere: on the invoices and orders already saved, and for the
-- new ones. A COD invoice is due on its invoice date, as before (an old CASH ON DELIVERY counts the same).
-- Needs 083_insurance_due_extension.sql. Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again.
-- The last line says: UPDATE 3.84 READY - ...
-- =====================================================================
do $$ begin
  if to_regclass('public.invoice_balances') is null then raise exception 'Run the earlier updates first, then run this again.'; end if;
end $$;

-- 1. the invoice's due date: COD = the invoice date (the view is changed only in that one place)
do $$
declare def text := pg_get_viewdef('public.invoice_balances'::regclass);
begin
  if position('''COD''' in def) = 0 then
    if position('i.payment_terms = ''CASH ON DELIVERY''::text' in def) = 0 then raise exception 'Update 3.84: invoice_balances has changed - send this message to Claude'; end if;
    def := replace(def, 'i.payment_terms = ''CASH ON DELIVERY''::text', 'i.payment_terms = ANY (ARRAY[''COD''::text, ''CASH ON DELIVERY''::text])');
    execute 'create or replace view public.invoice_balances with (security_invoker = true) as ' || def;
  end if;
end $$;

-- 2. the invoices and orders already saved with CASH ON DELIVERY: COD
do $$ begin
  perform public.allow_record_change();
  update public.customer_invoices set payment_terms = 'COD' where payment_terms = 'CASH ON DELIVERY';
  perform set_config('eo.allow_change', 'off', true);
  update public.customer_orders set payment_terms = 'COD' where payment_terms = 'CASH ON DELIVERY';
end $$;

notify pgrst, 'reload schema';

select case when position('''COD''' in pg_get_viewdef('public.invoice_balances'::regclass)) > 0
    and not exists (select 1 from public.customer_invoices where payment_terms = 'CASH ON DELIVERY')
    and not exists (select 1 from public.customer_orders where payment_terms = 'CASH ON DELIVERY')
  then 'UPDATE 3.84 READY - CASH ON DELIVERY is now COD (' || (select count(*) from public.customer_invoices where payment_terms = 'COD') || ' COD invoice(s))'
  else 'NOT READY - send this message to Claude' end as result;
