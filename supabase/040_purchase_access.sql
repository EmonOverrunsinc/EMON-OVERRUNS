-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.31: Purchase Order is a menu access of its own (5 Purchase Order; Employee (HR) is 6)
-- The Director ticks 5 Purchase Order on Access & Status for each employee who may use it. Before, every employee had
-- it: this update gives it once to every employee and staff login of today, so nobody loses it; the Director takes it
-- away where it is not wanted. The server checks it too. Needs 023_purchase_orders.sql. Safe to run again.
-- =====================================================================
do $$ begin
  if to_regclass('public.purchase_orders') is null then raise exception 'Run 023_purchase_orders.sql first, then run this again.'; end if;
end $$;

-- 1. who may use Purchase Order: the Director, and staff with the Purchase Order menu
create or replace function public.po_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_staff() and public.has_module('purchase');
$$;
revoke execute on function public.po_staff() from public, anon;
grant execute on function public.po_staff() to authenticated;

drop policy if exists "po: staff read" on public.purchase_orders;
create policy "po: staff read" on public.purchase_orders for select to authenticated using ((select public.po_staff()));

drop policy if exists "storage records: purchase files" on storage.objects;
create policy "storage records: purchase files" on storage.objects as restrictive for select to authenticated
  using (bucket_id <> 'records' or coalesce((storage.foldername(name))[1], '') <> 'purchase' or (select public.po_staff()));

-- 2. every change of a purchase order made by a signed-in person needs the Purchase Order menu
create or replace function public.purchase_orders_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null and not public.has_module('purchase') then
    raise exception 'You have no access to Purchase Order. Ask the Director.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke execute on function public.purchase_orders_guard() from public, anon, authenticated;
drop trigger if exists purchase_orders_guard on public.purchase_orders;
create trigger purchase_orders_guard before insert or update or delete on public.purchase_orders
  for each row execute function public.purchase_orders_guard();

-- 3. once: everyone who has Purchase Order today keeps it (staff employees and staff logins)
do $$
begin
  if not exists (select 1 from private.app_secrets where k = 'purchase_menu_given') then
    perform public.allow_record_change();
    update public.employees set modules = modules || array['purchase']
      where role = 'staff' and status <> 'terminated' and not ('purchase' = any(modules));
    update public.profiles set modules = modules || array['purchase']
      where role = 'staff' and modules is not null and not ('purchase' = any(modules));
    insert into private.app_secrets (k, v) values ('purchase_menu_given', now()::text);
  end if;
end $$;

select 'UPDATE 3.31 READY - 5 Purchase Order is a menu access' as result;
