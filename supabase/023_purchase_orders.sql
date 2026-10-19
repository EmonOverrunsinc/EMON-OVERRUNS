-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.0: Purchase Orders (replaces Community)
-- A purchase order is a request to buy one lot: lot name, date, processing time, the authorized responsible person,
-- up to 20 item lines (item name, brand, demand price, quantity, negotiable / fixed, note; each line is price x qty),
-- notes and up to 2 product photos. It is numbered LOT-YYYYMM-### on submit and waits for the Director:
--   APPROVE      -> APPROVED (can no longer be edited or deleted); the person who made it is told
--   NEGOTIATE    -> the Director changes the prices; NEGOTIATION, the person is told (notice and a message) and can
--                   edit and submit again
--   CANCEL       -> CANCELLED (the details are kept, the photos are deleted)
-- After approval the person who made it can ask for an update (new details), which the Director approves, and the
-- lot can be marked ARRIVED at the warehouse.
-- Run once in the Supabase SQL Editor after 022_update_2_9.sql. It is safe to run again.
-- =====================================================================

create table if not exists public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  po_no text unique,
  lot_name text not null,
  po_date date not null default ((now() at time zone 'Asia/Manila')::date),
  processing_time text,
  authorized_person text,
  notes text,
  items jsonb not null default '[]'::jsonb,
  total_qty numeric(14,2) not null default 0,
  total_amount numeric(14,2) not null default 0,
  photos text[] not null default '{}',
  status text not null default 'pending' check (status in ('pending','negotiation','approved','cancelled')),
  director_note text,
  pending_update jsonb,
  update_requested_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_by uuid references public.profiles(id) on delete set null,
  approved_by_name text,
  approved_at timestamptz,
  cancelled_by_name text,
  cancelled_at timestamptz,
  arrived_at timestamptz,
  arrived_by_name text
);
create index if not exists purchase_orders_status_idx on public.purchase_orders(status, po_date);
create index if not exists purchase_orders_created_by_idx on public.purchase_orders(created_by);
create index if not exists purchase_orders_approved_by_idx on public.purchase_orders(approved_by);
alter table public.purchase_orders enable row level security;
revoke all on public.purchase_orders from anon;
grant select on public.purchase_orders to authenticated;
drop policy if exists "po: staff read" on public.purchase_orders;
create policy "po: staff read" on public.purchase_orders for select to authenticated using ((select public.is_staff()));

-- The item lines checked and counted: up to 20, each with a name and a quantity; amount = price x quantity.
create or replace function public.po_clean_items(p_items jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare r jsonb := '[]'::jsonb; x jsonb; n int := 0; price numeric; qty numeric;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then raise exception 'Add the items'; end if;
  for x in select * from jsonb_array_elements(p_items) loop
    if coalesce(trim(x ->> 'item'), '') = '' and coalesce(trim(x ->> 'brand'), '') = '' and coalesce((x ->> 'qty')::numeric, 0) = 0 then continue; end if;
    n := n + 1;
    if n > 20 then raise exception 'A purchase order has up to 20 items'; end if;
    if coalesce(trim(x ->> 'item'), '') = '' then raise exception 'Write the item name on line %', n; end if;
    price := greatest(coalesce(nullif(x ->> 'price', '')::numeric, 0), 0);
    qty := greatest(coalesce(nullif(x ->> 'qty', '')::numeric, 0), 0);
    if qty <= 0 then raise exception 'Write the quantity on line %', n; end if;
    r := r || jsonb_build_array(jsonb_build_object('item', left(trim(x ->> 'item'), 120), 'brand', left(trim(coalesce(x ->> 'brand', '')), 80),
      'price', price, 'qty', qty, 'terms', case when x ->> 'terms' = 'fixed' then 'fixed' else 'negotiable' end,
      'note', left(trim(coalesce(x ->> 'note', '')), 200), 'amount', round(price * qty, 2)));
  end loop;
  if n = 0 then raise exception 'Add at least one item'; end if;
  return r;
end;
$$;

-- Save a purchase order: new (p_id null) or the maker's (or the Director's) changes while it waits. A change after a
-- negotiation sends it back to the Director. Gives back the purchase order.
create or replace function public.save_purchase_order(p_id uuid, p_data jsonb) returns public.purchase_orders
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare po public.purchase_orders; it jsonb; me text := (select full_name from public.profiles where id = auth.uid());
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;
  if coalesce(trim(p_data ->> 'lot_name'), '') = '' then raise exception 'Write the lot name'; end if;
  it := public.po_clean_items(p_data -> 'items');
  if p_id is null then
    insert into public.purchase_orders (po_no, lot_name, po_date, processing_time, authorized_person, notes, items, total_qty, total_amount, created_by_name)
    values ('LOT-' || to_char(current_date, 'YYYYMM') || '-' || lpad(public.next_counter('LOT' || to_char(current_date, 'YYYYMM'))::text, 3, '0'),
            left(trim(p_data ->> 'lot_name'), 120), coalesce(nullif(p_data ->> 'po_date', '')::date, current_date),
            nullif(left(trim(coalesce(p_data ->> 'processing_time', '')), 80), ''), nullif(left(trim(coalesce(p_data ->> 'authorized_person', '')), 120), ''),
            nullif(trim(coalesce(p_data ->> 'notes', '')), ''), it,
            (select sum((x ->> 'qty')::numeric) from jsonb_array_elements(it) x), (select sum((x ->> 'amount')::numeric) from jsonb_array_elements(it) x), me)
    returning * into po;
    perform public.notify_admins('Purchase order ' || po.po_no || ' to review', po.lot_name || ' · PHP ' || to_char(po.total_amount, 'FM999,999,990.00') || ' (from ' || coalesce(me, '') || ')', 'po/' || po.id);
    return po;
  end if;
  select * into po from public.purchase_orders where id = p_id for update;
  if not found then raise exception 'Purchase order not found'; end if;
  if po.status not in ('pending','negotiation') then raise exception 'Purchase order % is % and cannot be changed', po.po_no, upper(po.status); end if;
  if not (public.is_admin() or po.created_by = auth.uid()) then raise exception 'Only the person who made it or the Director can change it'; end if;
  update public.purchase_orders set lot_name = left(trim(p_data ->> 'lot_name'), 120), po_date = coalesce(nullif(p_data ->> 'po_date', '')::date, po_date),
    processing_time = nullif(left(trim(coalesce(p_data ->> 'processing_time', '')), 80), ''), authorized_person = nullif(left(trim(coalesce(p_data ->> 'authorized_person', '')), 120), ''),
    notes = nullif(trim(coalesce(p_data ->> 'notes', '')), ''), items = it,
    total_qty = (select sum((x ->> 'qty')::numeric) from jsonb_array_elements(it) x), total_amount = (select sum((x ->> 'amount')::numeric) from jsonb_array_elements(it) x),
    status = case when po.created_by = auth.uid() then 'pending' else po.status end, updated_at = now()
  where id = p_id returning * into po;
  if po.created_by = auth.uid() and not public.is_admin() then
    perform public.notify_admins('Purchase order ' || po.po_no || ' to review', po.lot_name || ' was changed and sent again (from ' || coalesce(me, '') || ')', 'po/' || po.id);
  end if;
  return po;
end;
$$;
revoke execute on function public.save_purchase_order(uuid, jsonb) from public, anon;
grant execute on function public.save_purchase_order(uuid, jsonb) to authenticated;

-- The product photos (up to 2), set by the maker after the upload.
create or replace function public.set_purchase_photos(p_id uuid, p_photos text[]) returns public.purchase_orders
language plpgsql security definer set search_path = '' as $$
declare po public.purchase_orders;
begin
  select * into po from public.purchase_orders where id = p_id for update;
  if not found then raise exception 'Purchase order not found'; end if;
  if po.status not in ('pending','negotiation') then raise exception 'The photos cannot be changed now'; end if;
  if not (public.is_admin() or po.created_by = auth.uid()) then raise exception 'Not allowed'; end if;
  if coalesce(array_length(p_photos, 1), 0) > 2 then raise exception 'Up to 2 product photos'; end if;
  if exists (select 1 from unnest(p_photos) x where x not like 'purchase/' || p_id || '/%') then raise exception 'Wrong photo'; end if;
  update public.purchase_orders set photos = coalesce(p_photos, '{}'), updated_at = now() where id = p_id returning * into po;
  return po;
end;
$$;
revoke execute on function public.set_purchase_photos(uuid, text[]) from public, anon;
grant execute on function public.set_purchase_photos(uuid, text[]) to authenticated;

-- The Director decides: approve, negotiate (with new prices for the lines: p_items), or cancel. A cancel gives back
-- the photo paths so the portal deletes the files; the details stay.
create or replace function public.decide_purchase_order(p_id uuid, p_action text, p_note text default null, p_items jsonb default null) returns text[]
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare po public.purchase_orders; me text := (select full_name from public.profiles where id = auth.uid()); it jsonb; gone text[];
begin
  if not public.is_admin() then raise exception 'Only the Director decides a purchase order'; end if;
  select * into po from public.purchase_orders where id = p_id for update;
  if not found then raise exception 'Purchase order not found'; end if;
  if po.status not in ('pending','negotiation') then raise exception 'Purchase order % is already %', po.po_no, upper(po.status); end if;
  if p_action = 'approve' then
    update public.purchase_orders set status = 'approved', approved_by = auth.uid(), approved_by_name = me, approved_at = now(),
      director_note = nullif(trim(coalesce(p_note, '')), ''), updated_at = now() where id = p_id;
    perform public.notify_user(po.created_by, 'Your ' || po.lot_name || ' lot was APPROVED (' || po.po_no || ')',
      'Approved by Director ' || coalesce(me, '') || '. Buy at the approved price.', 'po/' || po.id);
  elsif p_action = 'negotiate' then
    it := case when p_items is null then po.items else public.po_clean_items(p_items) end;
    update public.purchase_orders set status = 'negotiation', items = it,
      total_qty = (select sum((x ->> 'qty')::numeric) from jsonb_array_elements(it) x), total_amount = (select sum((x ->> 'amount')::numeric) from jsonb_array_elements(it) x),
      director_note = nullif(trim(coalesce(p_note, '')), ''), updated_at = now() where id = p_id;
    perform public.notify_user(po.created_by, 'Price not agreed: ' || po.lot_name || ' (' || po.po_no || ')',
      'EMON OVERRUNS authority does not agree with that price. Please negotiate the price, then edit and submit again.' || coalesce(' Note: ' || nullif(trim(p_note), ''), ''), 'po/' || po.id);
    if po.created_by is not null and po.created_by <> auth.uid() then
      insert into public.messages (sender_id, recipient_id, body)
      values (auth.uid(), po.created_by, 'Purchase order ' || po.po_no || ' (' || po.lot_name || '): EMON OVERRUNS authority does not agree with that price. '
        || 'Please negotiate the price, then edit the details and submit again.' || coalesce(' Note: ' || nullif(trim(p_note), ''), ''));
    end if;
  elsif p_action = 'cancel' then
    gone := po.photos;
    update public.purchase_orders set status = 'cancelled', photos = '{}', cancelled_by_name = me, cancelled_at = now(),
      director_note = nullif(trim(coalesce(p_note, '')), ''), updated_at = now() where id = p_id;
    perform public.notify_user(po.created_by, 'Purchase order ' || po.po_no || ' was cancelled', po.lot_name || coalesce(' - ' || nullif(trim(p_note), ''), ''), 'po/' || po.id);
  else
    raise exception 'Unknown action %', p_action;
  end if;
  delete from public.notifications where title = 'Purchase order ' || po.po_no || ' to review';
  return coalesce(gone, '{}');
end;
$$;
revoke execute on function public.decide_purchase_order(uuid, text, text, jsonb) from public, anon;
grant execute on function public.decide_purchase_order(uuid, text, text, jsonb) to authenticated;

-- After approval: the maker asks for an update (new details wait for the Director), the Director applies or refuses it,
-- and the lot is marked ARRIVED at the warehouse.
create or replace function public.purchase_order_after(p_id uuid, p_action text, p_data jsonb default null) returns public.purchase_orders
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare po public.purchase_orders; me text := (select full_name from public.profiles where id = auth.uid()); it jsonb;
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;
  select * into po from public.purchase_orders where id = p_id for update;
  if not found then raise exception 'Purchase order not found'; end if;
  if po.status <> 'approved' then raise exception 'Purchase order % is not approved', po.po_no; end if;
  if p_action = 'request_update' then
    if not (po.created_by = auth.uid() or public.is_admin()) then raise exception 'Only the person who made it can ask for an update'; end if;
    it := public.po_clean_items(p_data -> 'items');
    update public.purchase_orders set pending_update = jsonb_build_object('items', it, 'notes', nullif(trim(coalesce(p_data ->> 'notes', '')), ''),
        'processing_time', nullif(trim(coalesce(p_data ->> 'processing_time', '')), ''), 'by', me), update_requested_at = now() where id = p_id returning * into po;
    perform public.notify_admins('Purchase order ' || po.po_no || ' update to review', po.lot_name || ' (from ' || coalesce(me, '') || ')', 'po/' || po.id);
  elsif p_action in ('accept_update', 'refuse_update') then
    if not public.is_admin() then raise exception 'Only the Director decides an update'; end if;
    if po.pending_update is null then raise exception 'No update is waiting'; end if;
    if p_action = 'accept_update' then
      it := po.pending_update -> 'items';
      update public.purchase_orders set items = it, notes = coalesce(po.pending_update ->> 'notes', notes),
        processing_time = coalesce(po.pending_update ->> 'processing_time', processing_time),
        total_qty = (select sum((x ->> 'qty')::numeric) from jsonb_array_elements(it) x), total_amount = (select sum((x ->> 'amount')::numeric) from jsonb_array_elements(it) x),
        approved_by = auth.uid(), approved_by_name = me, approved_at = now(), pending_update = null, update_requested_at = null, updated_at = now()
      where id = p_id returning * into po;
    else
      update public.purchase_orders set pending_update = null, update_requested_at = null where id = p_id returning * into po;
    end if;
    perform public.notify_user(po.created_by, 'Update of ' || po.po_no || case when p_action = 'accept_update' then ' approved' else ' not approved' end, po.lot_name, 'po/' || po.id);
    delete from public.notifications where title = 'Purchase order ' || po.po_no || ' update to review';
  elsif p_action = 'arrived' then
    if po.arrived_at is not null then raise exception 'Already marked arrived'; end if;
    update public.purchase_orders set arrived_at = now(), arrived_by_name = me where id = p_id returning * into po;
  else
    raise exception 'Unknown action %', p_action;
  end if;
  return po;
end;
$$;
revoke execute on function public.purchase_order_after(uuid, text, jsonb) from public, anon;
grant execute on function public.purchase_order_after(uuid, text, jsonb) to authenticated;

-- A purchase order still waiting can be deleted by its maker or the Director (gives back the photo paths); an approved
-- or cancelled one cannot.
create or replace function public.delete_purchase_order(p_id uuid) returns text[]
language plpgsql security definer set search_path = '' as $$
declare po public.purchase_orders;
begin
  select * into po from public.purchase_orders where id = p_id for update;
  if not found then raise exception 'Purchase order not found'; end if;
  if po.status not in ('pending','negotiation') then raise exception 'Purchase order % is % and cannot be deleted', po.po_no, upper(po.status); end if;
  if not (public.is_admin() or po.created_by = auth.uid()) then raise exception 'Not allowed'; end if;
  delete from public.notifications where title = 'Purchase order ' || po.po_no || ' to review';
  delete from public.purchase_orders where id = p_id;
  return po.photos;
end;
$$;
revoke execute on function public.delete_purchase_order(uuid) from public, anon;
grant execute on function public.delete_purchase_order(uuid) to authenticated;

-- After approval the Director's portal keeps small copies of the product photos for the PDF (print_photos); one
-- month after approval the full photos are deleted from storage, and the PDF keeps showing the small copies.
alter table public.purchase_orders add column if not exists print_photos text[] not null default '{}';
create or replace function public.purchase_order_photos(p_id uuid, p_action text, p_print text[] default null) returns text[]
language plpgsql security definer set search_path = '' as $$
declare po public.purchase_orders; gone text[];
begin
  if not public.is_admin() then raise exception 'Only the Director'; end if;
  select * into po from public.purchase_orders where id = p_id for update;
  if not found or po.status <> 'approved' then raise exception 'Purchase order not approved'; end if;
  if p_action = 'print' then
    if coalesce(array_length(p_print, 1), 0) > 2 or exists (select 1 from unnest(p_print) x where x not like 'data:image/jpeg;base64,%' or length(x) > 400000) then
      raise exception 'Wrong print photos';
    end if;
    update public.purchase_orders set print_photos = p_print where id = p_id;
    return '{}';
  elsif p_action = 'expire' then
    if po.approved_at > now() - interval '30 days' or coalesce(array_length(po.print_photos, 1), 0) = 0 then return '{}'; end if;
    gone := po.photos;
    update public.purchase_orders set photos = '{}' where id = p_id;
    return gone;
  end if;
  raise exception 'Unknown action %', p_action;
end;
$$;
revoke execute on function public.purchase_order_photos(uuid, text, text[]) from public, anon;
grant execute on function public.purchase_order_photos(uuid, text, text[]) to authenticated;

-- ---------- an approved employee is linked to a login account once ----------
-- The Director links an employee (no login yet) to an existing login account. The link cannot be removed, and an
-- employee linked to a login account cannot be deleted.
create or replace function public.link_employee_account(p_employee uuid, p_profile uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare em public.employees; pr public.profiles;
begin
  if not public.is_admin() then raise exception 'Only the Director links a login account'; end if;
  select * into em from public.employees where id = p_employee for update;
  if not found then raise exception 'Employee not found'; end if;
  if em.profile_id is not null then raise exception 'Employee % is already linked to a login account', em.employee_no; end if;
  if em.status in ('terminated') then raise exception 'Employee % is TERMINATED', em.employee_no; end if;
  select * into pr from public.profiles where id = p_profile;
  if not found then raise exception 'Login account not found'; end if;
  if pr.role = 'admin' then raise exception 'A Director account cannot be linked to an employee'; end if;
  if exists (select 1 from public.employees e where e.profile_id = p_profile) then raise exception 'That login account is already linked to another employee'; end if;
  perform public.allow_record_change();
  update public.employees set profile_id = p_profile, status = case when status = 'waiting' then 'active' else status end where id = p_employee;
end;
$$;
revoke execute on function public.link_employee_account(uuid, uuid) from public, anon;
grant execute on function public.link_employee_account(uuid, uuid) to authenticated;

create or replace function public.employees_keep_linked() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.profile_id is not null then raise exception 'This employee is linked to a login account and cannot be deleted'; end if;
  return old;
end;
$$;
revoke execute on function public.employees_keep_linked() from public, anon, authenticated;
drop trigger if exists employees_keep_linked on public.employees;
create trigger employees_keep_linked before delete on public.employees for each row execute function public.employees_keep_linked();

select 'UPDATE 3.0 READY - Purchase Orders' as result;
