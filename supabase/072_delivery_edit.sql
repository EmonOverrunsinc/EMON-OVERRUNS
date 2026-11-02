-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.68: EDIT THE DELIVERY OF A COMPLETED ORDER
-- The delivery of a COMPLETED customer order (date and time, note, photos) can be changed only by EMON HASAN (full access)
-- and by the employee who completed that delivery. Nobody else. Every change keeps who changed it and when.
-- Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again.
-- The last line says: UPDATE 3.68 READY - ...
-- =====================================================================

-- 1. who completed the delivery (the login), not only the name
alter table public.customer_orders add column if not exists completed_by uuid references public.profiles(id) on delete set null;
alter table public.customer_orders add column if not exists delivery_edited_at timestamptz;
alter table public.customer_orders add column if not exists delivery_edited_by_name text;
create index if not exists customer_orders_completed_by_idx on public.customer_orders(completed_by);

create or replace function public.co_mark_completed_by() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'completed' and old.status is distinct from 'completed' and new.completed_by is null then
    new.completed_by := auth.uid();
  end if;
  return new;
end;
$$;
revoke execute on function public.co_mark_completed_by() from public, anon, authenticated;
drop trigger if exists co_mark_completed_by on public.customer_orders;
create trigger co_mark_completed_by before update on public.customer_orders for each row execute function public.co_mark_completed_by();

-- the orders completed before: the login whose name is the "completed by" name (only when one login has that name)
update public.customer_orders o set completed_by = p.id
from public.profiles p
where o.status = 'completed' and o.completed_by is null and p.full_name = o.completed_by_name
  and (select count(*) from public.profiles x where x.full_name = o.completed_by_name) = 1;

-- 2. who may change the delivery of a completed order: EMON HASAN, or the employee who completed it
create or replace function public.can_edit_delivery(p_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.customer_orders o where o.id = p_id and o.status = 'completed'
    and (public.is_admin() or (o.completed_by = auth.uid() and public.is_active())));
$$;
revoke execute on function public.can_edit_delivery(uuid) from public, anon;
grant execute on function public.can_edit_delivery(uuid) to authenticated;

-- 3. change the date and time and the note of the delivery
create or replace function public.edit_order_delivery(p_id uuid, p_data jsonb) returns public.customer_orders
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare o public.customer_orders; me text := (select full_name from public.profiles where id = auth.uid());
  at timestamptz := nullif(p_data ->> 'delivered_at', '')::timestamptz;
begin
  select * into o from public.customer_orders where id = p_id for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status <> 'completed' then raise exception 'Order % is %: only a completed delivery is edited here', o.order_no, upper(o.status); end if;
  if not public.can_edit_delivery(p_id) then raise exception 'Only EMON HASAN or the employee who completed the delivery can edit it'; end if;
  if at is not null and at > now() + interval '1 day' then raise exception 'The delivery date cannot be in the future'; end if;
  update public.customer_orders set delivered_at = coalesce(at, delivered_at),
    delivery_note = case when p_data ? 'delivery_note' then nullif(left(trim(coalesce(p_data ->> 'delivery_note', '')), 300), '') else delivery_note end,
    delivery_edited_at = now(), delivery_edited_by_name = me, updated_at = now()
  where id = p_id returning * into o;
  insert into public.customer_events (customer_id, action, note, actor, actor_name)
  values (o.customer_id, 'delivery edited', 'Order ' || o.order_no || ': delivery ' || to_char(o.delivered_at, 'FMMONTH DD YYYY HH12:MI AM') || coalesce(' · ' || o.delivery_note, ''), auth.uid(), me);
  return o;
end;
$$;
revoke execute on function public.edit_order_delivery(uuid, jsonb) from public, anon;
grant execute on function public.edit_order_delivery(uuid, jsonb) to authenticated;

-- 4. the delivery photos of a completed order: the same two people
do $$
declare def text;
  s_old text := 'if o.status <> ''approved'' then raise exception ''The delivery photos';
  s_new text := 'if o.status <> ''approved'' and not public.can_edit_delivery(p_id) then raise exception ''The delivery photos';
  q_old text := 'if not public.qc_can_write() and';
  q_new text := 'if not public.qc_can_write() and not public.can_edit_delivery(p_id) and';
begin
  def := pg_get_functiondef('public.set_order_photos(uuid,text[])'::regprocedure);
  if position('can_edit_delivery' in def) = 0 then
    if position(s_old in def) = 0 or position(q_old in def) = 0 then raise exception 'Could not update set_order_photos: run the updates before this one first'; end if;
    def := replace(replace(def, s_old, s_new), q_old, q_new);
    execute def;
  end if;
end $$;
do $$ begin
  if position('delivery_edited_by_name' in pg_get_functiondef('public.set_order_photos(uuid,text[])'::regprocedure)) = 0 then
    execute replace(pg_get_functiondef('public.set_order_photos(uuid,text[])'::regprocedure),
      'set delivery_photos = ph, updated_at = now()',
      'set delivery_photos = ph, updated_at = now(), delivery_edited_at = case when o.status = ''completed'' then now() else delivery_edited_at end, delivery_edited_by_name = case when o.status = ''completed'' then (select full_name from public.profiles where id = auth.uid()) else delivery_edited_by_name end');
  end if;
end $$;

select case when position('can_edit_delivery' in pg_get_functiondef('public.set_order_photos(uuid,text[])'::regprocedure)) > 0
  and to_regprocedure('public.edit_order_delivery(uuid,jsonb)') is not null
  then 'UPDATE 3.68 READY - the delivery of a completed order is edited only by EMON HASAN and the employee who completed it'
  else 'NOT READY - send this message to Claude' end as result;
