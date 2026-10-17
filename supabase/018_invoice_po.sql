-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 2.6: every detail of an invoice can be corrected
-- The invoice date and the total amount join the details that Add Correction can change (with the Terms of
-- Payment, boxes, pieces, PO Number and PO Date). The Director's correction changes the invoice at once; an employee's
-- waits for the Director. When the date or the amount changes, the statements of account are made again from that
-- month on, and the invoice's PAID / PARTIAL PAYMENT / UNPAID status follows by itself.
-- Run once in the Supabase SQL Editor after 017_play_store.sql. It is safe to run again.
-- =====================================================================

do $$
declare
  f record; def text;
  old_cols text := 'when ''customer_invoices'' then array[''purchase_date'',''po_number'',''total_boxes'',''total_pcs'',''payment_terms'']';
  new_cols text := 'when ''customer_invoices'' then array[''invoice_date'',''total_amount'',''purchase_date'',''po_number'',''total_boxes'',''total_pcs'',''payment_terms'']';
begin
  for f in select p.oid from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'editable_columns' loop
    def := pg_get_functiondef(f.oid);
    if position(new_cols in def) > 0 then continue; end if; -- run before
    if position(old_cols in def) = 0 then raise exception 'Update 2.6: editable_columns has changed; run 017_play_store.sql first'; end if;
    execute replace(def, old_cols, new_cols);
  end loop;
end $$;

-- A corrected invoice date or amount makes the statements again from the earlier of the two months.
create or replace function public.statements_follow_invoice_change() returns trigger
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare d date := least(old.invoice_date, new.invoice_date);
begin
  if (new.invoice_date is distinct from old.invoice_date or new.total_amount is distinct from old.total_amount)
     and exists (select 1 from public.statements s where s.customer_id = new.customer_id and s.period_end >= d) then
    perform public.restate_statements(new.customer_id, d);
  end if;
  return null;
end;
$$;
revoke execute on function public.statements_follow_invoice_change() from public, anon, authenticated;
drop trigger if exists statements_follow_change on public.customer_invoices;
create trigger statements_follow_change after update of invoice_date, total_amount on public.customer_invoices
  for each row execute function public.statements_follow_invoice_change();

select 'UPDATE 2.6 READY - every detail of an invoice can be corrected' as result;
