-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.76: EO-OFFICE INSURANCE GIVES 2 DATES
-- 1. BENEFITS EXPIRE: the coverage benefits end 15 days after the delivery (as before).
-- 2. PAYMENT DUE EXTENSION: the invoice of the insured order gets 15 MORE DAYS to pay after its due date.
--    The due date comes from the order's terms (7, 15 or 30 DAYS ...) and then +15 days.
--    Example: ordered NOV 15 on 15 DAYS terms -> due NOV 30 -> with the insurance DEC 15.
--    The invoice, the overdue list, the SOA and the customer's page all use the extended due date.
--    A cancelled coverage takes the extension off again. EMON HASAN sets the days in the insurance settings (default 15).
-- Needs 077_insurance.sql. Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again.
-- The last line says: UPDATE 3.76 READY - ...
-- =====================================================================
do $$ begin
  if to_regclass('public.order_insurance') is null then raise exception 'Run 077_insurance.sql first, then run this again.'; end if;
end $$;

alter table public.company_settings add column if not exists ins_due_days integer not null default 15 check (ins_due_days between 0 and 120);
alter table public.customer_invoices add column if not exists due_extension_days integer not null default 0 check (due_extension_days between 0 and 365);

-- the invoice's due date includes the extension (the view is changed only in that one line)
do $$
declare def text := pg_get_viewdef('public.invoice_balances'::regclass);
begin
  if position('due_extension_days' in def) = 0 then
    if position('END AS due_date' in def) = 0 then raise exception 'Update 3.76: invoice_balances has changed - send this message to Claude'; end if;
    def := replace(def, 'END AS due_date', 'END + i.due_extension_days AS due_date');
    execute 'create or replace view public.invoice_balances with (security_invoker = true) as ' || def;
  end if;
end $$;

-- the insured order's invoice: +N days while its coverage is active (0 again when there is none)
create or replace function public.ins_apply_due(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare inv uuid; days int;
begin
  select o.invoice_id into inv from public.customer_orders o where o.id = p_order;
  if inv is null then return; end if;
  days := case when exists (select 1 from public.order_insurance i where i.order_id = p_order and i.status = 'active')
    then coalesce((select s.ins_due_days from public.company_settings s where s.id = 1), 15) else 0 end;
  if (select due_extension_days from public.customer_invoices where id = inv) is distinct from days then
    perform public.allow_record_change();
    update public.customer_invoices set due_extension_days = days where id = inv;
    perform set_config('eo.allow_change', 'off', true);
  end if;
end;
$$;
revoke execute on function public.ins_apply_due(uuid) from public, anon, authenticated;

create or replace function public.ins_due_trg() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'order_insurance' then perform public.ins_apply_due(new.order_id);
  else perform public.ins_apply_due(new.id); end if;
  return null;
end;
$$;
revoke execute on function public.ins_due_trg() from public, anon, authenticated;
drop trigger if exists ins_due_on_insurance on public.order_insurance;
create trigger ins_due_on_insurance after insert or update of status on public.order_insurance for each row execute function public.ins_due_trg();
drop trigger if exists ins_due_on_order on public.customer_orders;
create trigger ins_due_on_order after update of invoice_id on public.customer_orders for each row when (new.invoice_id is not null) execute function public.ins_due_trg();

-- a coverage deleted (cancelled before payment) takes the extension off too
create or replace function public.ins_due_del() returns trigger
language plpgsql security definer set search_path = '' as $$
begin perform public.ins_apply_due(old.order_id); return null; end;
$$;
revoke execute on function public.ins_due_del() from public, anon, authenticated;
drop trigger if exists ins_due_on_delete on public.order_insurance;
create trigger ins_due_on_delete after delete on public.order_insurance for each row execute function public.ins_due_del();

-- the insured orders already invoiced: extended now
do $$ declare r record; begin
  for r in select distinct order_id from public.order_insurance where status = 'active' loop perform public.ins_apply_due(r.order_id); end loop;
end $$;

notify pgrst, 'reload schema';

select case when position('due_extension_days' in pg_get_viewdef('public.invoice_balances'::regclass)) > 0
  then 'UPDATE 3.76 READY - the insurance gives 2 dates: benefits expire (delivery + 15 days) and payment due extension (invoice due date + '
    || (select ins_due_days from public.company_settings where id = 1) || ' days)'
  else 'NOT READY - send this message to Claude' end as result;
