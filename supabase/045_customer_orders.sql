-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.37: CUSTOMER ORDER (EO-Office)
-- An order for a customer, like the paper order: DELIVERED TO, ADDRESS, ACCOUNT NO, REFERENCES, DATE, DUE DATE, NOTE,
-- TERMS and the lines QUANTITY | BOXES | CODE | PCS | LOT NO. | PRODUCT | PRICE | AMOUNT (QUANTITY = BOXES x PCS,
-- AMOUNT = QUANTITY x PRICE); up to 4 more columns can be added (COLOR, SIZE ...).
-- The boxes of the order (the Delivery Sheet): each box by its serial no (read from the QR or PDF417 code on the box
-- label, from a photo of it, or typed), with its code, batch no, items, pcs and remarks. A box is on one order only.
-- The Director approves an order (the authorized signature on the printed order); the Director's own orders are
-- approved at once. The delivery: rider name, ID no, plate no, type, date and time, and photos. COMPLETE: the invoice
-- is made for the customer by itself (on the customer's profile and statement) and the order shows it.
-- Needs 024_eo_office.sql. Safe to run again.
-- =====================================================================
do $$ begin
  if to_regprocedure('public.qc_can_write()') is null then raise exception 'Run 024_eo_office.sql first, then run this again.'; end if;
end $$;

create table if not exists public.customer_orders (
  id uuid primary key default gen_random_uuid(),
  order_no text unique,
  customer_id uuid not null references public.customers(id),
  order_date date not null default ((now() at time zone 'Asia/Manila')::date),
  due_date date,
  reference text,
  delivered_to text,
  address text,
  note text,
  payment_terms text,
  extra_columns text[] not null default '{}',
  lines jsonb not null default '[]'::jsonb,
  total_boxes integer not null default 0,
  total_pcs integer not null default 0,
  total_amount numeric(14,2) not null default 0,
  status text not null default 'pending' check (status in ('pending','approved','completed','cancelled')),
  approved_by uuid references public.profiles(id) on delete set null,
  approved_by_name text,
  approved_at timestamptz,
  rider_name text,
  rider_id_no text,
  plate_no text,
  vehicle_type text,
  delivered_at timestamptz,
  delivery_note text,
  delivery_photos text[] not null default '{}',
  completed_at timestamptz,
  completed_by_name text,
  invoice_id uuid references public.customer_invoices(id) on delete set null,
  cancelled_at timestamptz,
  cancelled_by_name text,
  cancel_note text,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists customer_orders_customer_idx on public.customer_orders(customer_id);
create index if not exists customer_orders_status_idx on public.customer_orders(status, order_date);
create index if not exists customer_orders_created_by_idx on public.customer_orders(created_by);
create index if not exists customer_orders_approved_by_idx on public.customer_orders(approved_by);
create index if not exists customer_orders_invoice_idx on public.customer_orders(invoice_id);

create table if not exists public.customer_order_boxes (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.customer_orders(id) on delete cascade,
  serial_no text not null,
  code text,
  batch_no text,
  items text,
  pcs integer not null default 0 check (pcs >= 0),
  remarks text,
  added_how text not null default 'typed' check (added_how in ('scan','photo','typed')),
  added_by_name text,
  created_at timestamptz not null default now(),
  unique (order_id, serial_no)
);
create index if not exists customer_order_boxes_serial_idx on public.customer_order_boxes(serial_no);

-- Read: staff with EO-Office (orders are made there) or with Customer access (the customer's profile shows the orders).
-- Every change goes through the functions below.
create or replace function public.co_can_read() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_staff() and (public.has_module('eooffice') or public.has_module('customers'));
$$;
revoke execute on function public.co_can_read() from public, anon;
grant execute on function public.co_can_read() to authenticated;
alter table public.customer_orders enable row level security;
alter table public.customer_order_boxes enable row level security;
revoke all on public.customer_orders from anon;
revoke all on public.customer_order_boxes from anon;
grant select on public.customer_orders to authenticated;
grant select on public.customer_order_boxes to authenticated;
drop policy if exists "co: read" on public.customer_orders;
create policy "co: read" on public.customer_orders for select to authenticated using ((select public.co_can_read()));
drop policy if exists "cob: read" on public.customer_order_boxes;
create policy "cob: read" on public.customer_order_boxes for select to authenticated using ((select public.co_can_read()));
-- the delivery photos (records/corder/<order>/...): seen by the same people; deleted by EO-Office staff
drop policy if exists "storage records: order files" on storage.objects;
create policy "storage records: order files" on storage.objects as restrictive for select to authenticated
  using (bucket_id <> 'records' or coalesce((storage.foldername(name))[1], '') <> 'corder' or (select public.co_can_read()));
drop policy if exists "storage records: order delete" on storage.objects;
create policy "storage records: order delete" on storage.objects for delete to authenticated
  using (bucket_id = 'records' and coalesce((storage.foldername(name))[1], '') = 'corder' and (select public.qc_can_write()));

-- The added columns made clean: capitals, up to 20 letters, each once, not a column the order has already, up to 4.
create or replace function public.co_clean_columns(p jsonb) returns text[]
language plpgsql immutable set search_path = '' as $$
declare r text[] := '{}'; v text; c text;
begin
  if jsonb_typeof(p) is distinct from 'array' then return r; end if;
  for v in select jsonb_array_elements_text(p) loop
    c := left(upper(regexp_replace(trim(v), '\s+', ' ', 'g')), 20);
    if c = '' or c = any(r) then continue; end if;
    if c in ('QUANTITY','QTY','BOXES','BOX','CODE','PCS','LOT','LOT NO','LOT NO.','PRODUCT','PRICE','AMOUNT') then raise exception 'The order has a % column already', c; end if;
    r := r || c;
  end loop;
  if cardinality(r) > 4 then raise exception 'Up to 4 added columns'; end if;
  return r;
end;
$$;
revoke execute on function public.co_clean_columns(jsonb) from public, anon;

-- The lines made clean: QUANTITY = BOXES x PCS (as written when there are no boxes or pcs), AMOUNT = QUANTITY x PRICE,
-- the added columns kept by their names. Empty lines are skipped; up to 60 lines.
create or replace function public.co_clean_lines(p_lines jsonb, p_cols text[]) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare x jsonb; r jsonb := '[]'::jsonb; n int := 0; bx int; pc int; qty numeric; price numeric; ex jsonb; c text;
begin
  if jsonb_typeof(p_lines) is distinct from 'array' then raise exception 'Add at least one line'; end if;
  for x in select * from jsonb_array_elements(p_lines) loop
    if coalesce(trim(x ->> 'product'), '') = '' and coalesce(trim(x ->> 'code'), '') = '' and coalesce(nullif(x ->> 'qty', '')::numeric, 0) = 0
       and coalesce(nullif(x ->> 'boxes', '')::numeric, 0) = 0 and coalesce(nullif(x ->> 'pcs', '')::numeric, 0) = 0 then continue; end if;
    n := n + 1;
    if n > 60 then raise exception 'An order has up to 60 lines'; end if;
    if coalesce(trim(x ->> 'product'), '') = '' then raise exception 'Write the product on line %', n; end if;
    bx := round(greatest(coalesce(nullif(x ->> 'boxes', '')::numeric, 0), 0));
    pc := round(greatest(coalesce(nullif(x ->> 'pcs', '')::numeric, 0), 0));
    qty := case when bx > 0 and pc > 0 then bx * pc else round(greatest(coalesce(nullif(x ->> 'qty', '')::numeric, 0), 0)) end;
    if qty <= 0 then raise exception 'Write the boxes and pcs (or the quantity) on line %', n; end if;
    price := round(greatest(coalesce(nullif(x ->> 'price', '')::numeric, 0), 0), 2);
    ex := '{}'::jsonb;
    foreach c in array coalesce(p_cols, '{}') loop
      ex := ex || jsonb_build_object(c, left(trim(coalesce(x -> 'extra' ->> c, '')), 60));
    end loop;
    r := r || jsonb_build_array(jsonb_build_object('qty', qty, 'boxes', bx, 'code', left(upper(trim(coalesce(x ->> 'code', ''))), 30), 'pcs', pc,
      'lot', left(upper(trim(coalesce(x ->> 'lot', ''))), 40), 'product', left(trim(x ->> 'product'), 120), 'price', price, 'amount', round(qty * price, 2), 'extra', ex));
  end loop;
  if n = 0 then raise exception 'Add at least one line'; end if;
  return r;
end;
$$;
revoke execute on function public.co_clean_lines(jsonb, text[]) from public, anon;

-- Save an order: new (p_id null) or a change. The person who made it changes it while it waits for the Director; the
-- Director changes it until it is completed. A new order of the Director is approved at once; any other new order
-- goes to the Director to review. Gives back the order.
create or replace function public.save_customer_order(p_id uuid, p_data jsonb) returns public.customer_orders
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare o public.customer_orders; c public.customers; me text := (select full_name from public.profiles where id = auth.uid());
  cols text[]; ln jsonb; d date; boss boolean := public.is_admin();
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  select * into c from public.customers where id = nullif(p_data ->> 'customer_id', '')::uuid;
  if not found then raise exception 'Choose the customer'; end if;
  if c.status <> 'active' then raise exception 'An order is made only for an ACTIVE account (% is %)', coalesce(c.account_no, c.first_name || ' ' || c.last_name), upper(c.status); end if;
  cols := public.co_clean_columns(p_data -> 'extra_columns');
  ln := public.co_clean_lines(p_data -> 'lines', cols);
  d := coalesce(nullif(p_data ->> 'order_date', '')::date, current_date);
  if p_id is not null then
    select * into o from public.customer_orders where id = p_id for update;
    if not found then raise exception 'Order not found'; end if;
    if o.status not in ('pending','approved') then raise exception 'Order % is % and cannot be changed', o.order_no, upper(o.status); end if;
    if not (boss or (o.created_by = auth.uid() and o.status = 'pending')) then
      raise exception '%', case when o.status = 'approved' then 'Order ' || o.order_no || ' is approved: only the Director can change it now' else 'Only the person who made it or the Director can change it' end;
    end if;
  end if;
  if p_id is null then
    insert into public.customer_orders (order_no, customer_id, order_date, created_by_name, status, approved_by, approved_by_name, approved_at)
    values ('CO-' || to_char(d, 'YYYYMM') || '-' || lpad(public.next_counter('CO' || to_char(d, 'YYYYMM'))::text, 4, '0'), c.id, d, me,
      case when boss then 'approved' else 'pending' end, case when boss then auth.uid() end, case when boss then me end, case when boss then now() end)
    returning * into o;
  end if;
  update public.customer_orders set customer_id = c.id, order_date = d, due_date = nullif(p_data ->> 'due_date', '')::date,
    reference = nullif(left(upper(trim(coalesce(p_data ->> 'reference', ''))), 60), ''),
    delivered_to = nullif(left(trim(coalesce(p_data ->> 'delivered_to', '')), 120), ''), address = nullif(left(trim(coalesce(p_data ->> 'address', '')), 300), ''),
    note = nullif(left(trim(coalesce(p_data ->> 'note', '')), 500), ''), payment_terms = nullif(left(upper(trim(coalesce(p_data ->> 'payment_terms', ''))), 60), ''),
    extra_columns = cols, lines = ln,
    total_boxes = (select coalesce(sum((x ->> 'boxes')::int), 0) from jsonb_array_elements(ln) x),
    total_pcs = (select coalesce(sum((x ->> 'qty')::numeric), 0)::int from jsonb_array_elements(ln) x),
    total_amount = (select coalesce(sum((x ->> 'amount')::numeric), 0) from jsonb_array_elements(ln) x), updated_at = now()
  where id = o.id returning * into o;
  if p_id is null and o.status = 'pending' then
    perform public.notify_admins('Customer order ' || o.order_no || ' to review', c.first_name || ' ' || c.last_name || ' · PHP ' || to_char(o.total_amount, 'FM999,999,990.00')
      || ' · ' || o.total_boxes || ' box' || case when o.total_boxes = 1 then '' else 'es' end || ' (from ' || coalesce(me, '') || ')', 'custorder/' || o.id);
  end if;
  return o;
end;
$$;
revoke execute on function public.save_customer_order(uuid, jsonb) from public, anon;
grant execute on function public.save_customer_order(uuid, jsonb) to authenticated;

-- The Director approves an order (the signature goes on the printed order) or cancels it; the person who made an order
-- cancels it while it waits. A completed order has its invoice and cannot be cancelled.
create or replace function public.decide_customer_order(p_id uuid, p_action text, p_note text default null) returns public.customer_orders
language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders; me text := (select full_name from public.profiles where id = auth.uid());
begin
  select * into o from public.customer_orders where id = p_id for update;
  if not found then raise exception 'Order not found'; end if;
  if p_action = 'approve' then
    if not public.is_admin() then raise exception 'Only the Director can approve an order'; end if;
    if o.status <> 'pending' then raise exception 'Order % is % (not waiting for approval)', o.order_no, upper(o.status); end if;
    update public.customer_orders set status = 'approved', approved_by = auth.uid(), approved_by_name = me, approved_at = now(), updated_at = now()
    where id = p_id returning * into o;
    if o.created_by is distinct from auth.uid() then
      perform public.notify_user(o.created_by, 'Customer order ' || o.order_no || ' APPROVED', 'Ready for delivery', 'custorder/' || o.id);
    end if;
  elsif p_action = 'cancel' then
    if o.status not in ('pending','approved') then raise exception 'Order % is % and cannot be cancelled', o.order_no, upper(o.status); end if;
    if not (public.is_admin() or (o.created_by = auth.uid() and o.status = 'pending')) then raise exception 'Only the Director can cancel this order'; end if;
    update public.customer_orders set status = 'cancelled', cancelled_at = now(), cancelled_by_name = me, cancel_note = nullif(left(trim(coalesce(p_note, '')), 300), ''), updated_at = now()
    where id = p_id returning * into o;
    if o.created_by is distinct from auth.uid() then
      perform public.notify_user(o.created_by, 'Customer order ' || o.order_no || ' was cancelled', coalesce(o.cancel_note, ''), 'custorder/' || o.id);
    end if;
  else
    raise exception 'Unknown action';
  end if;
  delete from public.notifications where title = 'Customer order ' || o.order_no || ' to review';
  return o;
end;
$$;
revoke execute on function public.decide_customer_order(uuid, text, text) from public, anon;
grant execute on function public.decide_customer_order(uuid, text, text) to authenticated;

-- A box of the order (from the box label QR / PDF417, a photo of it, or typed). A box serial is on one order only (a
-- cancelled order frees its boxes). Up to 500 boxes.
create or replace function public.add_order_box(p_order uuid, p_data jsonb) returns public.customer_order_boxes
language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders; b public.customer_order_boxes; s text; other text; me text := (select full_name from public.profiles where id = auth.uid());
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  select * into o from public.customer_orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status not in ('pending','approved') then raise exception 'Order % is %: boxes cannot be added', o.order_no, upper(o.status); end if;
  s := left(upper(regexp_replace(trim(coalesce(p_data ->> 'serial_no', '')), '\s+', ' ', 'g')), 60);
  if s = '' then raise exception 'Write the serial no of the box'; end if;
  perform pg_advisory_xact_lock(hashtext('order box ' || s)); -- the same box scanned on two orders at the same moment
  if exists (select 1 from public.customer_order_boxes where order_id = p_order and serial_no = s) then raise exception 'Box % is on this order already', s; end if;
  select x.order_no into other from public.customer_order_boxes y join public.customer_orders x on x.id = y.order_id
  where y.serial_no = s and x.status <> 'cancelled' and x.id <> p_order limit 1;
  if other is not null then raise exception 'Box % is on order % already', s, other; end if;
  if (select count(*) from public.customer_order_boxes where order_id = p_order) >= 500 then raise exception 'An order has up to 500 boxes'; end if;
  insert into public.customer_order_boxes (order_id, serial_no, code, batch_no, items, pcs, remarks, added_how, added_by_name)
  values (p_order, s, nullif(left(upper(trim(coalesce(p_data ->> 'code', ''))), 30), ''), nullif(left(upper(trim(coalesce(p_data ->> 'batch_no', ''))), 40), ''),
    nullif(left(trim(coalesce(p_data ->> 'items', '')), 120), ''), round(greatest(coalesce(nullif(p_data ->> 'pcs', '')::numeric, 0), 0)),
    nullif(left(trim(coalesce(p_data ->> 'remarks', '')), 120), ''), case when p_data ->> 'added_how' in ('scan','photo','typed') then p_data ->> 'added_how' else 'typed' end, me)
  returning * into b;
  update public.customer_orders set updated_at = now() where id = p_order;
  return b;
end;
$$;
revoke execute on function public.add_order_box(uuid, jsonb) from public, anon;
grant execute on function public.add_order_box(uuid, jsonb) to authenticated;

-- A box changed (code, batch no, items, pcs, remarks) or taken off (p_data null), while the order is open.
create or replace function public.change_order_box(p_box uuid, p_data jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare b public.customer_order_boxes; st text; no text;
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  select * into b from public.customer_order_boxes where id = p_box;
  if not found then raise exception 'Box not found'; end if;
  select status, order_no into st, no from public.customer_orders where id = b.order_id for update;
  if st not in ('pending','approved') then raise exception 'Order % is %: its boxes cannot be changed', no, upper(st); end if;
  if p_data is null then
    delete from public.customer_order_boxes where id = p_box;
  else
    update public.customer_order_boxes set code = nullif(left(upper(trim(coalesce(p_data ->> 'code', ''))), 30), ''),
      batch_no = nullif(left(upper(trim(coalesce(p_data ->> 'batch_no', ''))), 40), ''), items = nullif(left(trim(coalesce(p_data ->> 'items', '')), 120), ''),
      pcs = round(greatest(coalesce(nullif(p_data ->> 'pcs', '')::numeric, 0), 0)), remarks = nullif(left(trim(coalesce(p_data ->> 'remarks', '')), 120), '')
    where id = p_box;
  end if;
  update public.customer_orders set updated_at = now() where id = b.order_id;
end;
$$;
revoke execute on function public.change_order_box(uuid, jsonb) from public, anon;
grant execute on function public.change_order_box(uuid, jsonb) to authenticated;

-- The delivery of an approved order: the rider and the vehicle, the date and time, a note.
create or replace function public.set_order_delivery(p_id uuid, p_data jsonb) returns public.customer_orders
language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders;
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  select * into o from public.customer_orders where id = p_id for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status <> 'approved' then raise exception '%', case when o.status = 'pending' then 'Order ' || o.order_no || ' waits for the Director''s approval' else 'Order ' || o.order_no || ' is ' || upper(o.status) end; end if;
  if coalesce(trim(p_data ->> 'rider_name'), '') = '' then raise exception 'Write the rider name'; end if;
  update public.customer_orders set rider_name = left(upper(trim(p_data ->> 'rider_name')), 120), rider_id_no = nullif(left(upper(trim(coalesce(p_data ->> 'rider_id_no', ''))), 60), ''),
    plate_no = nullif(left(upper(trim(coalesce(p_data ->> 'plate_no', ''))), 30), ''), vehicle_type = nullif(left(upper(trim(coalesce(p_data ->> 'vehicle_type', ''))), 40), ''),
    delivered_at = coalesce(nullif(p_data ->> 'delivered_at', '')::timestamptz, delivered_at), delivery_note = nullif(left(trim(coalesce(p_data ->> 'delivery_note', '')), 300), ''),
    updated_at = now()
  where id = p_id returning * into o;
  return o;
end;
$$;
revoke execute on function public.set_order_delivery(uuid, jsonb) from public, anon;
grant execute on function public.set_order_delivery(uuid, jsonb) to authenticated;

-- The delivery photos (up to 5) of an approved order; gives back the photos taken off (to delete their files).
create or replace function public.set_order_photos(p_id uuid, p_photos text[]) returns text[]
language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders; ph text[] := coalesce(p_photos, '{}');
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  select * into o from public.customer_orders where id = p_id for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status <> 'approved' then raise exception 'The delivery photos of order % cannot be changed now (%)', o.order_no, upper(o.status); end if;
  if cardinality(ph) > 5 then raise exception 'Up to 5 delivery photos'; end if;
  if exists (select 1 from unnest(ph) x where x not like 'corder/' || p_id || '/%') then raise exception 'Wrong photo'; end if;
  update public.customer_orders set delivery_photos = ph, updated_at = now() where id = p_id;
  return array(select x from unnest(o.delivery_photos) x where not (x = any(ph)));
end;
$$;
revoke execute on function public.set_order_photos(uuid, text[]) from public, anon;
grant execute on function public.set_order_photos(uuid, text[]) to authenticated;

-- COMPLETE: the order was delivered (the rider and a delivery photo are needed). The invoice is made for the customer
-- by itself (invoice date today, the order's boxes, pcs, amount and terms; PO no = the order no) and the order shows it.
create or replace function public.complete_customer_order(p_id uuid) returns public.customer_orders
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare o public.customer_orders; inv uuid; me text := (select full_name from public.profiles where id = auth.uid());
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  select * into o from public.customer_orders where id = p_id for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status <> 'approved' then raise exception '%', case when o.status = 'pending' then 'Order ' || o.order_no || ' waits for the Director''s approval' else 'Order ' || o.order_no || ' is ' || upper(o.status) end; end if;
  if coalesce(o.rider_name, '') = '' then raise exception 'Add the rider details first'; end if;
  if cardinality(o.delivery_photos) = 0 then raise exception 'Add a delivery photo first'; end if;
  insert into public.customer_invoices (customer_id, invoice_date, purchase_date, po_number, total_boxes, total_pcs, total_amount, payment_terms)
  values (o.customer_id, current_date, o.order_date, o.order_no, o.total_boxes, o.total_pcs, o.total_amount, o.payment_terms)
  returning id into inv;
  update public.customer_orders set status = 'completed', invoice_id = inv, completed_at = now(), completed_by_name = me,
    delivered_at = coalesce(delivered_at, now()), updated_at = now()
  where id = p_id returning * into o;
  if o.created_by is distinct from auth.uid() then
    perform public.notify_user(o.created_by, 'Customer order ' || o.order_no || ' delivered', 'Invoice ' || (select invoice_no from public.customer_invoices where id = inv) || ' was made', 'custorder/' || o.id);
  end if;
  return o;
end;
$$;
revoke execute on function public.complete_customer_order(uuid) from public, anon;
grant execute on function public.complete_customer_order(uuid) to authenticated;

-- The Director deletes an order that is not completed (gives back the delivery photos, to delete their files).
create or replace function public.delete_customer_order(p_id uuid) returns text[]
language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders;
begin
  if not public.is_admin() then raise exception 'Only the Director can delete an order'; end if;
  select * into o from public.customer_orders where id = p_id for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status = 'completed' then raise exception 'Order % is COMPLETED (it has its invoice) and cannot be deleted', o.order_no; end if;
  delete from public.notifications where title = 'Customer order ' || o.order_no || ' to review';
  delete from public.customer_orders where id = p_id;
  return o.delivery_photos;
end;
$$;
revoke execute on function public.delete_customer_order(uuid) from public, anon;
grant execute on function public.delete_customer_order(uuid) to authenticated;

select 'UPDATE 3.37 READY - Customer Order: lines, boxes by scan, the Director''s approval, delivery and the invoice made by itself' as result;
