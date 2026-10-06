-- =====================================================================
-- EMON OVERRUNS E-PORTAL — Update 1.10: E-Bill and the Released Notice
-- 1. A stock-bill is now called an E-Bill. Its number is the company's letters, the year and a number, for example
--    MF-2026-0001 for MODINA FASHION (the first letters of the company's first and last word, like the initials
--    of a customer's account number). The batch no and the total boxes are needed on a new e-bill.
-- 2. The status goes SHIPPED → RELEASED → SOLD → PAID (no ARRIVED step).
-- 3. Released Notice: the order letter for an e-bill, found by its Batch No. Price per box (PHP) × total boxes =
--    total (PHP); × the exchange rate of the day = the released charge (BDT); plus the shipping fee (BDT).
--    Once the Director approves it, the e-bill is RELEASED and the released charge and the shipping fee are added
--    to its total cost.
-- 4. Order letters are numbered EO-YYYY-MM-#### (for example EO-2026-10-0001), counted again each month.
--    Orders made before keep their numbers.
-- No records are changed or removed. Run once in the Supabase SQL Editor after 012_update_1_9.sql.
-- It is safe to run again.
-- =====================================================================

-- ---------- 1. the released charge, on the order and on the e-bill ----------
alter table public.order_letters add column if not exists price_per_box numeric(14,2) check (price_per_box is null or price_per_box > 0);
alter table public.order_letters add column if not exists exchange_rate numeric(12,4) check (exchange_rate is null or exchange_rate > 0);
alter table public.order_letters add column if not exists release_php numeric(14,2);
alter table public.order_letters add column if not exists release_bdt numeric(14,2);
alter table public.stock_bills add column if not exists release_price_per_box numeric(14,2);
alter table public.stock_bills add column if not exists release_exchange_rate numeric(12,4);
alter table public.stock_bills add column if not exists release_php numeric(14,2);
alter table public.stock_bills add column if not exists release_bdt numeric(14,2);

-- ---------- 2. e-bill number: company letters-YYYY-#### ----------
-- The first letters of the company's first and last word, leaving out Ltd, Inc, Co and the like
-- (MODINA FASHION → MF, Modina Apparels Ltd → MA); a one-word name gives its first two letters (ZARA → ZA).
create or replace function public.company_initials(p_name text) returns text
language sql immutable set search_path = '' as $$
  with w as (
    select upper(x) as word, n from regexp_split_to_table(coalesce(p_name, ''), '[^A-Za-z]+') with ordinality t(x, n)
    where x <> '' and upper(x) not in ('LTD','LIMITED','INC','CO','CORP','CORPORATION','COMPANY','LLC','PLC','PVT','PRIVATE','PTE','THE','AND','OF'))
  select coalesce(
    case when (select count(*) from w) >= 2 then (select left(word, 1) from w order by n limit 1) || (select left(word, 1) from w order by n desc limit 1)
         when (select count(*) from w) = 1 then (select left(word, 2) from w) end,
    'EB');
$$;
revoke execute on function public.company_initials(text) from public, anon;
grant execute on function public.company_initials(text) to authenticated;

-- The number the next e-bill of a company will get (the final number is given on save).
create or replace function public.preview_ebill_no(p_company uuid, p_date date default null) returns text
language sql stable security definer set search_path = '' set timezone to 'Asia/Manila' as $$
  select x.ini || '-' || x.yr || '-' || lpad((coalesce((select d.last_no from public.doc_counters d where d.prefix = 'EB' || x.ini || x.yr), 0) + 1)::text, 4, '0')
  from (select public.company_initials(pc.name) as ini, to_char(coalesce(p_date, current_date), 'YYYY') as yr
        from public.pay_companies pc where pc.id = p_company) x
  where public.can_write('inventory');
$$;
revoke execute on function public.preview_ebill_no(uuid, date) from public, anon;
grant execute on function public.preview_ebill_no(uuid, date) to authenticated;

-- A new e-bill: number, item table and totals (as before), and the total boxes are needed.
create or replace function public.stock_bills_before_insert() returns trigger
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare
  types text[];
  ncol int;
  iq int; ip int; it int;
  r jsonb; nr jsonb; rows jsonb := '[]'::jsonb;
  q numeric; p numeric; tq numeric := 0; tc numeric := 0;
  k int; empty boolean;
  ini text; yr text;
begin
  if not exists (select 1 from public.pay_companies c where c.id = new.company_id) then raise exception 'Choose the company'; end if;
  if jsonb_typeof(new.item_columns) is distinct from 'array' or jsonb_typeof(new.items) is distinct from 'array' then
    raise exception 'The item table is not complete';
  end if;
  ncol := jsonb_array_length(new.item_columns);
  if ncol < 3 or ncol > 10 then raise exception 'The item table must have 3 to 10 columns'; end if;
  if exists (select 1 from jsonb_array_elements(new.item_columns) c where coalesce(trim(c->>'name'), '') = '') then
    raise exception 'Every column needs a name';
  end if;
  types := array(select coalesce(c->>'type', 'text') from jsonb_array_elements(new.item_columns) with ordinality t(c, n) order by n);
  if exists (select 1 from unnest(types) x where x not in ('text','qty','price','total'))
     or cardinality(array_positions(types, 'qty')) <> 1 or cardinality(array_positions(types, 'price')) <> 1 or cardinality(array_positions(types, 'total')) <> 1 then
    raise exception 'The item table must have one Qty, one Price and one Total column';
  end if;
  new.item_columns := (select jsonb_agg(jsonb_build_object('name', left(trim(c->>'name'), 40), 'type', coalesce(c->>'type', 'text')) order by n)
                       from jsonb_array_elements(new.item_columns) with ordinality t(c, n));
  iq := array_position(types, 'qty') - 1; ip := array_position(types, 'price') - 1; it := array_position(types, 'total') - 1;
  -- Every row is checked again here: Qty × Price = Total, and the totals of the bill come from the rows.
  for r in select value from jsonb_array_elements(new.items) loop
    if jsonb_typeof(r) is distinct from 'array' or jsonb_array_length(r) <> ncol then raise exception 'Each item row must have % values', ncol; end if;
    begin
      q := coalesce(nullif(trim(r->>iq), '')::numeric, 0);
      p := coalesce(nullif(trim(r->>ip), '')::numeric, 0);
    exception when others then
      raise exception 'Qty and Price must be numbers';
    end;
    if q < 0 or p < 0 then raise exception 'Qty and Price cannot be less than 0'; end if;
    nr := '[]'::jsonb; empty := q = 0 and p = 0;
    for k in 0 .. ncol - 1 loop
      if types[k + 1] = 'text' and coalesce(trim(r->>k), '') <> '' then empty := false; end if;
      nr := nr || case types[k + 1] when 'qty' then to_jsonb(q) when 'price' then to_jsonb(p) when 'total' then to_jsonb(round(q * p, 2))
                  else to_jsonb(left(trim(coalesce(r->>k, '')), 200)) end;
    end loop;
    continue when empty;
    rows := rows || jsonb_build_array(nr);
    tq := tq + q; tc := tc + round(q * p, 2);
  end loop;
  if jsonb_array_length(rows) = 0 or tc <= 0 then raise exception 'Add at least one item with its Qty and Price'; end if;
  -- the Released Notice counts its charge by the box
  if coalesce(new.total_boxes, 0) <= 0 then raise exception 'Enter the total boxes'; end if;
  new.items := rows;
  new.total_qty := tq;
  new.total_cost := tc;
  new.supplier_bill_no := nullif(trim(new.supplier_bill_no), '');
  new.batch_no := nullif(trim(new.batch_no), '');
  -- the Released Notice finds the e-bill by its batch no
  if new.batch_no is null then raise exception 'Enter the batch no'; end if;
  new.shipment_no := nullif(trim(new.shipment_no), '');
  ini := public.company_initials((select c.name from public.pay_companies c where c.id = new.company_id));
  yr := to_char(new.bill_date, 'YYYY');
  new.bill_no := ini || '-' || yr || '-' || lpad(public.next_counter('EB' || ini || yr)::text, 4, '0');
  new.status := 'shipped';
  new.release_date := null; new.shipping_cost := null; new.shipping_bill_no := null; new.release_order_no := null;
  new.release_price_per_box := null; new.release_exchange_rate := null; new.release_php := null; new.release_bdt := null;
  new.arrived_at := null; new.released_at := null; new.sold_at := null; new.paid_at := null; new.paid_by_name := null;
  new.created_by := auth.uid();
  new.created_by_name := (select full_name from public.profiles where id = auth.uid());
  return new;
end;
$$;

create or replace function public.stock_bills_after_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.stock_bill_events (stock_bill_id, action, note, actor, actor_name)
  values (new.id, 'E-Bill added — SHIPPED', 'Bill cost BDT ' || to_char(new.total_cost, 'FM999,999,999,990.00') || ' · ' || new.total_boxes || ' box(es)', auth.uid(), new.created_by_name);
  return new;
end;
$$;

-- ---------- 3. Sales Report lines (the wording says e-bill) ----------
create or replace function public.stock_bill_entries_before_insert() returns trigger
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare b public.stock_bills;
begin
  select * into b from public.stock_bills x where x.id = new.stock_bill_id;
  if b.id is null then raise exception 'Choose the e-bill'; end if;
  if b.status = 'paid' then raise exception 'E-Bill % is PAID and closed. Nothing more can be added to it', b.bill_no; end if;
  if new.entry_type = 'sales' and b.status not in ('released','sold') then
    raise exception 'Net sales can be added after the e-bill is RELEASED (it is % now)', upper(b.status);
  end if;
  new.receipt_no := nullif(trim(new.receipt_no), '');
  new.description := nullif(trim(new.description), '');
  if new.entry_type in ('fee','penalty') and new.receipt_no is null then
    raise exception 'Enter the receipt number of the %', case new.entry_type when 'fee' then 'fee' else 'penalty' end;
  end if;
  new.created_by := auth.uid();
  new.created_by_name := (select full_name from public.profiles where id = auth.uid());
  return new;
end;
$$;

-- ---------- 4. status: SOLD (inventory staff), PAID (the Director); there is no ARRIVED step ----------
create or replace function public.stock_bill_action(p_id uuid, p_action text, p_note text default null) returns public.stock_bills
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare
  b public.stock_bills;
  me text := (select full_name from public.profiles where id = auth.uid());
  h text;
begin
  select * into b from public.stock_bills where id = p_id for update;
  if b.id is null then raise exception 'E-bill not found'; end if;
  if p_action = 'paid' then
    if not public.is_admin() then raise exception 'Only the Director can mark an e-bill as PAID'; end if;
  elsif not public.can_write('inventory') then
    raise exception 'You do not have access to change e-bills';
  end if;
  perform public.allow_record_change();
  if p_action = 'sold' then
    if b.status <> 'released' then raise exception 'E-Bill % is % — only a RELEASED e-bill can be marked as SOLD', b.bill_no, upper(b.status); end if;
    if not exists (select 1 from public.stock_bill_entries x where x.stock_bill_id = p_id and x.entry_type = 'sales') then
      raise exception 'Add the net sales in the Sales Report first';
    end if;
    update public.stock_bills set status = 'sold', sold_at = now() where id = p_id returning * into b;
  elsif p_action = 'paid' then
    if b.status <> 'sold' then raise exception 'E-Bill % is % — only a SOLD e-bill can be marked as PAID', b.bill_no, upper(b.status); end if;
    update public.stock_bills set status = 'paid', paid_at = now(), paid_by_name = me where id = p_id returning * into b;
    -- the secret code of the Statistics Report: 24 random characters
    h := upper(md5(gen_random_uuid()::text || clock_timestamp()::text));
    insert into public.stock_bill_secrets (stock_bill_id, secret_code)
    values (p_id, 'EBX-' || substr(h, 1, 6) || '-' || substr(h, 7, 6) || '-' || substr(h, 13, 6) || '-' || substr(h, 19, 6))
    on conflict (stock_bill_id) do nothing;
  else
    raise exception 'Unknown action %', p_action;
  end if;
  insert into public.stock_bill_events (stock_bill_id, action, note, actor, actor_name)
  values (p_id, 'marked ' || upper(b.status), nullif(trim(p_note), ''), auth.uid(), me);
  return b;
end;
$$;

-- ---------- 5. totals: the released charge is part of the e-bill's total cost ----------
-- (the columns stay in the same order, with the released charge at the end)
create or replace view public.stock_bill_totals with (security_invoker = true) as
  select b.id, b.bill_no, b.company_id, b.bill_date, b.supplier_bill_no, b.item_columns, b.items, b.total_qty, b.total_cost, b.total_boxes,
    b.batch_no, b.shipment_no, b.shipment_date, b.notes, b.status, b.release_date, b.shipping_cost, b.shipping_bill_no, b.release_order_no,
    b.arrived_at, b.released_at, b.sold_at, b.paid_at, b.paid_by_name, b.created_by, b.created_by_name, b.created_at,
    pc.name as company_name, pc.currency as company_currency,
    coalesce(e.net_sales, 0)::numeric(14,2) as net_sales,
    coalesce(e.eoo_fees, 0)::numeric(14,2) as eoo_fees,
    coalesce(e.other_fees, 0)::numeric(14,2) as other_fees,
    coalesce(e.penalties, 0)::numeric(14,2) as penalties,
    (b.total_cost + coalesce(b.release_bdt, 0) + coalesce(b.shipping_cost, 0))::numeric(14,2) as bill_total,
    (b.total_cost + coalesce(b.release_bdt, 0) + coalesce(b.shipping_cost, 0) + coalesce(e.eoo_fees, 0) + coalesce(e.other_fees, 0) + coalesce(e.penalties, 0))::numeric(14,2) as total_expenses,
    coalesce(v.paid, 0)::numeric(14,2) as paid_bdt,
    coalesce(v.vouchers, 0)::int as vouchers_count,
    case when b.status = 'paid' and (select public.has_module('inventory')) then
      (coalesce(e.net_sales, 0) - (b.total_cost + coalesce(b.release_bdt, 0) + coalesce(b.shipping_cost, 0) + coalesce(e.eoo_fees, 0) + coalesce(e.other_fees, 0) + coalesce(e.penalties, 0)))::numeric(14,2) end as profit,
    b.release_price_per_box, b.release_exchange_rate, b.release_php, b.release_bdt
  from public.stock_bills b
  left join public.pay_companies pc on pc.id = b.company_id
  left join lateral (select sum(x.amount) filter (where x.entry_type = 'sales') as net_sales,
                            sum(x.amount) filter (where x.entry_type = 'eoo_fee') as eoo_fees,
                            sum(x.amount) filter (where x.entry_type = 'fee') as other_fees,
                            sum(x.amount) filter (where x.entry_type = 'penalty') as penalties
                     from public.stock_bill_entries x where x.stock_bill_id = b.id) e on true
  left join lateral (select sum(p.amount_bdt) as paid, count(*) as vouchers from public.pay_vouchers p where p.stock_bill_id = b.id) v on true;
revoke select on public.stock_bill_totals from anon;
grant select on public.stock_bill_totals to authenticated;

-- ---------- 6. the other functions: created again exactly as they are now, with only these lines changed ----------

do $$
declare
  -- function name, the exact old text, the new text
  fixes text[][] := array[
    ['order_letters_before_insert', '''Choose one customer, employee, company or stock-bill for this order''',
     '''Choose one customer, employee, company or e-bill for this order'''],
    ['order_letters_before_insert', '  if kind = ''stock_bill'' then
    if new.subject_type <> ''release'' then raise exception ''A stock-bill order must be a release order''; end if;
    select * into bl from public.stock_bills b where b.id = new.stock_bill_id;
    if bl.id is null then raise exception ''Choose the stock-bill''; end if;
    if bl.status not in (''shipped'',''arrived'') then
      raise exception ''Stock-Bill % is already %. Only an open stock-bill (SHIPPED or ARRIVED) can be released'', bl.bill_no, upper(bl.status);
    end if;
    if exists (select 1 from public.order_letters x where x.stock_bill_id = bl.id and x.status = ''pending'') then
      raise exception ''Stock-Bill % already has a release order waiting for approval'', bl.bill_no;
    end if;
    if new.release_date is null then raise exception ''Enter the release date''; end if;
    if bl.shipment_date is not null and new.release_date < bl.shipment_date then raise exception ''The release date cannot be before the shipment date''; end if;
    if new.shipping_cost is null or new.shipping_cost < 0 then raise exception ''Enter the shipping bill amount (0 if there is none)''; end if;
    new.shipping_bill_no := nullif(trim(new.shipping_bill_no), '''');
    new.amount := null;
    new.stock_info := jsonb_build_object(''bill_no'', bl.bill_no, ''company'', (select pc.name from public.pay_companies pc where pc.id = bl.company_id),
      ''supplier_bill_no'', bl.supplier_bill_no, ''batch_no'', bl.batch_no, ''shipment_no'', bl.shipment_no, ''shipment_date'', bl.shipment_date,
      ''total_boxes'', bl.total_boxes, ''total_qty'', bl.total_qty, ''bill_cost'', bl.total_cost, ''status'', bl.status);
  elsif new.subject_type = ''release'' then
    raise exception ''A release order is only for a stock-bill'';
  else
    new.release_date := null; new.shipping_cost := null; new.shipping_bill_no := null; new.stock_info := null;
',
     '  if kind = ''stock_bill'' then
    -- Released Notice, found by the e-bill''s batch no: price per box (PHP) × total boxes = total (PHP);
    -- × the exchange rate of the day = the released charge (BDT); plus the shipping fee (BDT).
    if new.subject_type <> ''release'' then raise exception ''An e-bill order must be a Released Notice''; end if;
    select * into bl from public.stock_bills b where b.id = new.stock_bill_id;
    if bl.id is null then raise exception ''Choose the e-bill''; end if;
    if bl.status not in (''shipped'',''arrived'') then
      raise exception ''E-Bill % is already %. Only a SHIPPED e-bill can be released'', bl.bill_no, upper(bl.status);
    end if;
    if exists (select 1 from public.order_letters x where x.stock_bill_id = bl.id and x.status = ''pending'') then
      raise exception ''E-Bill % already has a Released Notice waiting for approval'', bl.bill_no;
    end if;
    if coalesce(bl.total_boxes, 0) <= 0 then raise exception ''E-Bill % has no total boxes. Correct the e-bill first'', bl.bill_no; end if;
    if new.release_date is null then raise exception ''Enter the released date''; end if;
    if bl.shipment_date is not null and new.release_date < bl.shipment_date then raise exception ''The released date cannot be before the shipment date''; end if;
    if coalesce(new.price_per_box, 0) <= 0 then raise exception ''Enter the price per box (PHP)''; end if;
    if coalesce(new.exchange_rate, 0) <= 0 then raise exception ''Enter the exchange rate (BDT for 1 PHP)''; end if;
    if new.shipping_cost is null or new.shipping_cost < 0 then raise exception ''Enter the shipping fee (0 if there is none)''; end if;
    new.release_php := round(new.price_per_box * bl.total_boxes, 2);
    new.release_bdt := round(new.release_php * new.exchange_rate, 2);
    new.shipping_bill_no := nullif(trim(new.shipping_bill_no), '''');
    new.amount := null;
    new.stock_info := jsonb_build_object(''bill_no'', bl.bill_no, ''company'', (select pc.name from public.pay_companies pc where pc.id = bl.company_id),
      ''supplier_bill_no'', bl.supplier_bill_no, ''batch_no'', bl.batch_no, ''shipment_no'', bl.shipment_no, ''shipment_date'', bl.shipment_date,
      ''total_boxes'', bl.total_boxes, ''total_qty'', bl.total_qty, ''bill_cost'', bl.total_cost, ''status'', bl.status,
      ''total_cost'', bl.total_cost + new.release_bdt + new.shipping_cost);
  elsif new.subject_type = ''release'' then
    raise exception ''A Released Notice is only for an e-bill'';
  else
    new.release_date := null; new.shipping_cost := null; new.shipping_bill_no := null; new.stock_info := null;
    new.price_per_box := null; new.exchange_rate := null; new.release_php := null; new.release_bdt := null;
'],
    ['order_letters_before_insert', 'new.order_no := ''ORDER-'' || to_char(new.order_date, ''YYYY'') || ''-'' || lpad(public.next_counter(''ORDER'' || to_char(new.order_date, ''YYYY''))::text, 3, ''0'');',
     '-- order letters are numbered EO-YYYY-MM-#### (EO-2026-10-0001), counted again each month
  new.order_no := ''EO-'' || to_char(new.order_date, ''YYYY-MM'') || ''-'' || lpad(public.next_counter(''EOORDER'' || to_char(new.order_date, ''YYYYMM''))::text, 4, ''0'');'],
    ['carry_out_order', '    if bl.id is null then raise exception ''The stock-bill of this order was deleted''; end if;
    if bl.status not in (''shipped'',''arrived'') then raise exception ''Stock-Bill % is % and cannot be released again'', bl.bill_no, upper(bl.status); end if;
    update public.stock_bills set status = ''released'', release_date = o.release_date, shipping_cost = o.shipping_cost,
      shipping_bill_no = o.shipping_bill_no, release_order_no = o.order_no, released_at = now() where id = bl.id;
    insert into public.stock_bill_events (stock_bill_id, action, note, actor, actor_name)
    values (bl.id, ''released by '' || o.order_no, ''Shipping cost BDT '' || to_char(o.shipping_cost, ''FM999,999,999,990.00''), auth.uid(), me);
    res := ''Stock-Bill '' || bl.bill_no || '' is now RELEASED — total cost BDT '' || to_char(bl.total_cost + o.shipping_cost, ''FM999,999,999,990.00'')
      || '' (shipping BDT '' || to_char(o.shipping_cost, ''FM999,999,999,990.00'') || '')'';
',
     '    if bl.id is null then raise exception ''The e-bill of this order was deleted''; end if;
    if bl.status not in (''shipped'',''arrived'') then raise exception ''E-Bill % is % and cannot be released again'', bl.bill_no, upper(bl.status); end if;
    -- the released charge and the shipping fee are added to the e-bill''s total cost
    update public.stock_bills set status = ''released'', release_date = o.release_date, shipping_cost = o.shipping_cost,
      shipping_bill_no = o.shipping_bill_no, release_order_no = o.order_no, released_at = now(),
      release_price_per_box = o.price_per_box, release_exchange_rate = o.exchange_rate, release_php = o.release_php, release_bdt = o.release_bdt
    where id = bl.id;
    insert into public.stock_bill_events (stock_bill_id, action, note, actor, actor_name)
    values (bl.id, ''released by '' || o.order_no,
      case when o.release_bdt is not null then bl.total_boxes || '' boxes × PHP '' || to_char(o.price_per_box, ''FM999,999,999,990.00'')
        || '' = PHP '' || to_char(o.release_php, ''FM999,999,999,990.00'') || '' × '' || rtrim(rtrim(to_char(o.exchange_rate, ''FM999,990.0000''), ''0''), ''.'')
        || '' = BDT '' || to_char(o.release_bdt, ''FM999,999,999,990.00'') || '' · '' else '''' end
        || ''Shipping fee BDT '' || to_char(o.shipping_cost, ''FM999,999,999,990.00''), auth.uid(), me);
    res := ''E-Bill '' || bl.bill_no || '' is now RELEASED — total cost BDT ''
      || to_char(bl.total_cost + coalesce(o.release_bdt, 0) + o.shipping_cost, ''FM999,999,999,990.00'')
      || '' (released charge BDT '' || to_char(coalesce(o.release_bdt, 0), ''FM999,999,999,990.00'')
      || '', shipping fee BDT '' || to_char(o.shipping_cost, ''FM999,999,999,990.00'') || '')'';
'],
    ['undo_order', '    update public.stock_bills set status = coalesce(prev, ''arrived''), release_date = null, shipping_cost = null, shipping_bill_no = null,
      release_order_no = null, released_at = null
',
     '    update public.stock_bills set status = coalesce(prev, ''shipped''), release_date = null, shipping_cost = null, shipping_bill_no = null,
      release_order_no = null, released_at = null, release_price_per_box = null, release_exchange_rate = null, release_php = null, release_bdt = null
'],
    ['pay_vouchers_before_insert', '''That stock-bill belongs to a different company''',
     '''That e-bill belongs to a different company'''],
    ['pay_vouchers_before_insert', '''Only a released stock-bill (e-bill) can be paid''',
     '''Only a RELEASED e-bill can be paid'''],
    ['pay_vouchers_before_insert', '''A stock-bill is paid in BDT, but this company is paid in PHP only''',
     '''An e-bill is paid in BDT, but this company is paid in PHP only'''],
    ['delete_record', '''This stock-bill has a release order. Delete the order letter first''',
     '''This e-bill has a Released Notice. Delete the order letter first'''],
    ['delete_record', '''This stock-bill has payments in Billing. Delete those payment vouchers first''',
     '''This e-bill has payments in Billing. Delete those payment vouchers first'''],
    ['delete_record', '''This stock-bill is already SOLD or PAID, so its release order cannot be deleted''',
     '''This e-bill is already SOLD or PAID, so its Released Notice cannot be deleted'''],
    ['verify_record', '-- A stock-bill shows only for the secret code of its Statistics Report (never for its number).',
     '-- An e-bill shows only for the secret code of its Statistics Report (never for its number).'],
    ['verify_record', '''type'', ''Stock-Bill Statistics''',
     '''type'', ''E-Bill Statistics'''],
    ['verify_record', 'jsonb_build_array(''Stock-Bill No'', r.bill_no)',
     'jsonb_build_array(''E-Bill No'', r.bill_no)'],
    ['verify_record', 'jsonb_build_array(''Supplier Bill No'', r.supplier_bill_no)',
     'jsonb_build_array(''Bill No'', r.supplier_bill_no)'],
    ['verify_record', 'jsonb_build_array(''Shipment No'', coalesce(r.shipment_no, ''—''))',
     'jsonb_build_array(''System Record No'', coalesce(r.shipment_no, ''—''))'],
    ['verify_record', 'jsonb_build_array(''Release Date'', coalesce(to_char(r.release_date, ''DD Mon YYYY''), ''—''))',
     'jsonb_build_array(''Released Date'', coalesce(to_char(r.release_date, ''DD Mon YYYY''), ''—''))'],
    ['verify_record', 'jsonb_build_array(''Shipping Cost (BDT)'', to_char(coalesce(r.shipping_cost, 0), ''FM999,999,999,990.00'')),',
     'jsonb_build_array(''Released Charge (BDT)'', to_char(coalesce(r.release_bdt, 0), ''FM999,999,999,990.00'')),
          jsonb_build_array(''Shipping Fee (BDT)'', to_char(coalesce(r.shipping_cost, 0), ''FM999,999,999,990.00'')),'],
    ['verify_record', 'r.total_cost + coalesce(r.shipping_cost, 0)',
     'r.total_cost + coalesce(r.release_bdt, 0) + coalesce(r.shipping_cost, 0)'],
    ['verify_record', '-- A release order shows only that it is a genuine order (no stock-bill figures).
    select o.order_no, o.order_date, o.subject, o.status, o.approved_by_name, pc.name as co_name into r',
     '-- A Released Notice shows only that it is a genuine order (no e-bill figures).
    select o.order_no, o.order_date, o.subject, o.status, o.approved_by_name, pc.name as co_name, b.batch_no into r'],
    ['verify_record', 'jsonb_build_array(''Type'', ''Release Order'')',
     'jsonb_build_array(''Type'', ''Released Notice'' || coalesce('' '' || r.batch_no, ''''))']
  ];
  f record; def text; new_def text; i int;
begin
  for f in select p.oid, p.proname from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and pg_get_userbyid(p.proowner) = current_user
             and p.proname in ('order_letters_before_insert', 'carry_out_order', 'undo_order', 'pay_vouchers_before_insert', 'delete_record', 'verify_record')
  loop
    def := pg_get_functiondef(f.oid);
    new_def := def;
    for i in 1 .. array_length(fixes, 1) loop
      -- changed once: when the new text is already there (the script was run before), nothing is changed
      if fixes[i][1] = f.proname and position(fixes[i][3] in new_def) = 0 then
        if position(fixes[i][2] in new_def) = 0 then raise exception 'Update 1.10: % has changed; text not found: %', f.proname, left(fixes[i][2], 60); end if;
        new_def := replace(new_def, fixes[i][2], fixes[i][3]);
      end if;
    end loop;
    if new_def <> def then execute new_def; end if;
  end loop;
end $$;
