-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.59: THE DIRECTOR VERIFIES THE BOXES OF AN ORDER AND LOCKS THEM
-- On the order page (Boxes tab) the Director checks each ORDER line against the boxes ADDED (a wrong box shows
-- ❌ NOT ORDERED), fixes them (remove the wrong box, or give its price), then presses VERIFY & LOCK BOXES: from then on
-- no box of that order can be added, changed or removed - by anyone, also on the order paper's delivery page - until
-- the Director presses UNLOCK. Deleting the whole order (Director) still works.
-- Needs RUN_062_TO_066.sql. Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again.
-- The last line says: UPDATE 3.59 READY - ...
-- =====================================================================
alter table public.customer_orders add column if not exists boxes_verified_at timestamptz;
alter table public.customer_orders add column if not exists boxes_verified_by uuid references public.profiles(id) on delete set null;
alter table public.customer_orders add column if not exists boxes_verified_by_name text;
create index if not exists customer_orders_boxes_verified_by_idx on public.customer_orders(boxes_verified_by);

-- the boxes of a locked order cannot change (the order itself being deleted takes its boxes with it)
create or replace function public.co_boxes_locked() returns trigger
language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders;
begin
  select * into o from public.customer_orders where id = case when tg_op = 'INSERT' then new.order_id else old.order_id end;
  if found and o.boxes_verified_at is not null then
    raise exception 'The boxes of order % were verified and locked by % - ask the Director to unlock them', o.order_no, coalesce(o.boxes_verified_by_name, 'the Director');
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke execute on function public.co_boxes_locked() from public, anon, authenticated;
drop trigger if exists co_boxes_locked on public.customer_order_boxes;
create trigger co_boxes_locked before insert or update or delete on public.customer_order_boxes
  for each row execute function public.co_boxes_locked();

-- the Director verifies and locks the boxes (p_lock true), or unlocks them to fix (false)
create or replace function public.lock_order_boxes(p_order uuid, p_lock boolean) returns public.customer_orders
language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders;
begin
  if not public.is_admin() then raise exception 'Only the Director verifies and locks the boxes'; end if;
  select * into o from public.customer_orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  if p_lock and not exists (select 1 from public.customer_order_boxes where order_id = p_order) then raise exception 'Order % has no boxes to verify', o.order_no; end if;
  perform public.allow_record_change();
  update public.customer_orders set boxes_verified_at = case when p_lock then now() end, boxes_verified_by = case when p_lock then auth.uid() end,
    boxes_verified_by_name = case when p_lock then (select full_name from public.profiles where id = auth.uid()) end, updated_at = now()
  where id = p_order returning * into o;
  perform set_config('eo.allow_change', 'off', true);
  return o;
end;
$$;
revoke execute on function public.lock_order_boxes(uuid, boolean) from public, anon;
grant execute on function public.lock_order_boxes(uuid, boolean) to authenticated;

notify pgrst, 'reload schema';

select case when to_regprocedure('public.lock_order_boxes(uuid,boolean)') is not null
  and exists (select 1 from pg_trigger where tgname = 'co_boxes_locked')
  then 'UPDATE 3.59 READY - the Director verifies and locks the boxes of an order (Boxes tab)'
  else 'NOT READY - send this message to Claude' end as result;
