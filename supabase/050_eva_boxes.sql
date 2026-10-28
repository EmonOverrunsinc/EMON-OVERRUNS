-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.39: EVA AI for the Director only, and the BOX DATABASE from the Google Sheet
-- 1. EVA AI (its page, its chat, its idea in the Gate Pass window, its files and its log) is for the Director only.
-- 2. box_stock: every box of the Google Sheet DATABASE, columns A to G (serial no, product, brand, CTN, style, qty, batch).
--    The Director presses READ SHEET on the EVA AI page: the new rows come in and the old rows are removed, in one step.
-- 3. A box scanned or typed on a customer order (also on the Complete Delivery page of the order paper) takes its product,
--    brand, CTN, style, qty and batch from box_stock by itself.
-- Needs 048_delivery_paper.sql. Safe to run again.
-- =====================================================================
do $$ begin
  if to_regprocedure('public.delivery_add_box(text,text,jsonb)') is null then raise exception 'Run 048_delivery_paper.sql first, then run this again.'; end if;
end $$;

-- 1. EVA AI: the Director only (was: staff with Customer access)
create or replace function public.ai_can_read() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_admin();
$$;

-- EVA's settings (the Google Sheet link, when it was read last): the Director only
create table if not exists public.ai_settings (
  key text primary key check (char_length(key) between 1 and 60),
  value jsonb not null default '{}'::jsonb,
  updated_by_name text,
  updated_at timestamptz not null default now()
);
alter table public.ai_settings enable row level security;
revoke all on public.ai_settings from anon;
grant select, insert, update, delete on public.ai_settings to authenticated;
drop policy if exists "ai settings: director" on public.ai_settings;
create policy "ai settings: director" on public.ai_settings for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- 2. the box database (read from the sheet; only READ SHEET changes it)
create table if not exists public.box_stock (
  serial_no text primary key check (char_length(serial_no) between 1 and 60),
  product text check (char_length(product) <= 120),
  brand text check (char_length(brand) <= 80),
  ctn text check (char_length(ctn) <= 30),
  style text check (char_length(style) <= 30),
  qty integer not null default 0 check (qty >= 0),
  batch text check (char_length(batch) <= 40),
  read_at timestamptz not null default now()
);
create index if not exists box_stock_batch_idx on public.box_stock(batch);
alter table public.box_stock enable row level security;
revoke all on public.box_stock from anon, authenticated;
grant select on public.box_stock to authenticated;
-- read: the Director and the staff who make customer orders (a typed box fills from it)
drop policy if exists "box stock: read" on public.box_stock;
create policy "box stock: read" on public.box_stock for select to authenticated
  using ((select public.is_admin()) or (select public.co_can_read()));

-- READ SHEET: p_rows = [{serial_no, product, brand, ctn, style, qty, batch}, ...] (columns A to G of the sheet). The old
-- rows are removed and the new ones put in; a serial no written twice keeps its last row. Gives the number of boxes.
create or replace function public.replace_box_stock(p_rows jsonb, p_source text default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer; me text := (select full_name from public.profiles where id = auth.uid());
begin
  if not public.is_admin() then raise exception 'Only the Director can read the box database'; end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'The sheet has no boxes (column A: the serial no).'; end if;
  if jsonb_array_length(p_rows) > 100000 then raise exception 'Up to 100,000 boxes can be read.'; end if;
  delete from public.box_stock where true;
  insert into public.box_stock (serial_no, product, brand, ctn, style, qty, batch)
  select distinct on (x.s) x.s,
    nullif(left(trim(coalesce(x.r ->> 'product', '')), 120), ''), nullif(left(trim(coalesce(x.r ->> 'brand', '')), 80), ''),
    nullif(left(trim(coalesce(x.r ->> 'ctn', '')), 30), ''), nullif(left(upper(trim(coalesce(x.r ->> 'style', ''))), 30), ''),
    case when trim(coalesce(x.r ->> 'qty', '')) ~ '^\d{1,9}(\.\d+)?$' then round(trim(x.r ->> 'qty')::numeric)::integer else 0 end,
    nullif(left(upper(trim(coalesce(x.r ->> 'batch', ''))), 40), '')
  from (select left(upper(regexp_replace(trim(coalesce(e.r ->> 'serial_no', '')), '\s+', ' ', 'g')), 60) s, e.r, e.ord
        from jsonb_array_elements(p_rows) with ordinality as e(r, ord)) x
  where x.s <> ''
  order by x.s, x.ord desc;
  get diagnostics n = row_count;
  insert into public.ai_settings (key, value, updated_by_name, updated_at)
  values ('box_sheet_read', jsonb_build_object('boxes', n, 'source', left(coalesce(p_source, ''), 300), 'read_at', now()), me, now())
  on conflict (key) do update set value = excluded.value, updated_by_name = excluded.updated_by_name, updated_at = excluded.updated_at;
  return n;
end;
$$;
revoke execute on function public.replace_box_stock(jsonb, text) from public, anon;
grant execute on function public.replace_box_stock(jsonb, text) to authenticated;

-- 3. a box put on a customer order takes its details from the box database (when its serial no is there)
alter table public.customer_order_boxes add column if not exists brand text;
alter table public.customer_order_boxes add column if not exists ctn text;
create or replace function public.co_box_from_stock() returns trigger
language plpgsql security definer set search_path = '' as $$
declare s public.box_stock;
begin
  select * into s from public.box_stock where serial_no = new.serial_no;
  if found then
    new.items := coalesce(nullif(trim(s.product), ''), new.items);
    new.brand := coalesce(nullif(nullif(trim(s.brand), ''), '-'), new.brand);
    new.ctn := coalesce(nullif(trim(s.ctn), ''), new.ctn);
    new.code := coalesce(nullif(upper(trim(s.style)), ''), new.code);
    new.pcs := case when s.qty > 0 then s.qty else new.pcs end;
    new.batch_no := coalesce(nullif(upper(trim(s.batch)), ''), new.batch_no);
  end if;
  return new;
end;
$$;
revoke execute on function public.co_box_from_stock() from public, anon, authenticated;
drop trigger if exists cob_stock_bi on public.customer_order_boxes;
create trigger cob_stock_bi before insert on public.customer_order_boxes for each row execute function public.co_box_from_stock();

-- the Complete Delivery page of the order paper shows the brand and the CTN of each box too
create or replace function public.delivery_order(p_no text, p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare o public.customer_orders; c public.customers;
begin
  o := public.co_by_paper(p_no, p_code);
  select * into c from public.customers where id = o.customer_id;
  return jsonb_build_object('id', o.id, 'order_no', o.order_no, 'status', o.status, 'state', public.co_paper_state(o), 'order_date', o.order_date,
    'customer', trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), 'account_no', c.account_no, 'address', coalesce(o.address, c.address),
    'reference', o.reference, 'total_boxes', o.total_boxes, 'total_pcs', o.total_pcs,
    'lines', (select coalesce(jsonb_agg(jsonb_build_object('code', l ->> 'code', 'product', l ->> 'product', 'lot', l ->> 'lot', 'boxes', l -> 'boxes', 'pcs', l -> 'pcs', 'qty', l -> 'qty')), '[]'::jsonb)
      from jsonb_array_elements(coalesce(o.lines, '[]'::jsonb)) l),
    'boxes', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'serial_no', b.serial_no, 'code', b.code, 'batch_no', b.batch_no, 'items', b.items, 'brand', b.brand, 'ctn', b.ctn,
      'pcs', b.pcs, 'remarks', b.remarks) order by b.created_at, b.id), '[]'::jsonb) from public.customer_order_boxes b where b.order_id = o.id),
    'rider_name', o.rider_name, 'rider_id_no', o.rider_id_no, 'plate_no', o.plate_no, 'vehicle_type', o.vehicle_type, 'delivered_at', o.delivered_at,
    'delivery_note', o.delivery_note, 'delivery_photos', to_jsonb(coalesce(o.delivery_photos, '{}')), 'completed_at', o.completed_at, 'completed_by_name', o.completed_by_name);
end;
$$;
create or replace function public.delivery_add_box(p_no text, p_code text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders; b public.customer_order_boxes;
begin
  o := public.co_paper_open(p_no, p_code);
  b := public.add_order_box(o.id, p_data);
  if b.added_by_name is null then update public.customer_order_boxes set added_by_name = 'ORDER PAPER' where id = b.id returning * into b; end if;
  return jsonb_build_object('id', b.id, 'serial_no', b.serial_no, 'code', b.code, 'batch_no', b.batch_no, 'items', b.items, 'brand', b.brand, 'ctn', b.ctn, 'pcs', b.pcs, 'remarks', b.remarks);
end;
$$;
revoke execute on function public.delivery_order(text, text) from public;
grant execute on function public.delivery_order(text, text) to anon, authenticated;
revoke execute on function public.delivery_add_box(text, text, jsonb) from public;
grant execute on function public.delivery_add_box(text, text, jsonb) to anon, authenticated;

select case when position('is_admin' in pg_get_functiondef('public.ai_can_read()'::regprocedure)) > 0
    and position('has_module' in pg_get_functiondef('public.ai_can_read()'::regprocedure)) = 0
    and to_regclass('public.box_stock') is not null and to_regprocedure('public.replace_box_stock(jsonb,text)') is not null
    and exists (select 1 from pg_trigger where tgname = 'cob_stock_bi')
  then 'UPDATE 3.39 READY - EVA AI for the Director only; the box database (READ SHEET) fills the boxes of customer orders'
  else 'NOT READY - send this message to Claude' end as result;
