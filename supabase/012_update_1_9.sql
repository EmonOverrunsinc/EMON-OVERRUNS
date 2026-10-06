-- =====================================================================
-- EMON OVERRUNS E-PORTAL — Update 1.9: Inventory (stock-bills)
-- 1. Stock-Bill: stock bought from a billing company, in BDT. The item table has its own columns (Item, Brand,
--    Qty, Price and Total, plus other columns, up to 10) and as many rows as needed; Qty × Price = Total.
--    It also keeps the Total Boxes, Total Qty, Batch No, Shipment No and Shipment Date.
--    Status: SHIPPED → ARRIVED → RELEASED → SOLD → PAID.
-- 2. Release Order: an order letter for an open stock-bill (SHIPPED or ARRIVED) with the release date and the
--    shipping bill. When the Director approves it, the stock-bill is RELEASED, the shipping cost is added to its
--    cost, and its e-bill shows in Billing.
-- 3. Billing: a payment voucher can be linked to a released stock-bill (e-bill).
-- 4. Sales Report: net sales, EOO fees, and other fees and penalties (each with its receipt number).
-- 5. PAID (the Director only): the net profit or loss is shown and a secret code is made for the Statistics
--    Report. Verification shows a stock-bill only for this secret code, never for its number.
-- No records are changed. Run once in the Supabase SQL Editor after 011_update_1_8.sql. It is safe to run again.
-- =====================================================================

-- ---------- 1. tables ----------
create table if not exists public.stock_bills (
  id uuid primary key default gen_random_uuid(),
  bill_no text unique,
  company_id uuid not null references public.pay_companies(id),
  bill_date date not null default ((now() at time zone 'Asia/Manila'))::date,
  supplier_bill_no text,
  -- [{"name": "Item", "type": "text"}, …]; exactly one column each of type qty, price and total
  item_columns jsonb not null default '[]'::jsonb,
  -- one array of values per row, in the order of the columns
  items jsonb not null default '[]'::jsonb,
  total_qty numeric(14,2) not null default 0,
  total_cost numeric(14,2) not null default 0,
  total_boxes integer check (total_boxes is null or total_boxes >= 0),
  batch_no text,
  shipment_no text,
  shipment_date date,
  notes text,
  status text not null default 'shipped' check (status in ('shipped','arrived','released','sold','paid')),
  release_date date,
  shipping_cost numeric(14,2) check (shipping_cost is null or shipping_cost >= 0),
  shipping_bill_no text,
  release_order_no text,
  arrived_at timestamptz,
  released_at timestamptz,
  sold_at timestamptz,
  paid_at timestamptz,
  paid_by_name text,
  created_by uuid references public.profiles(id) default auth.uid(),
  created_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists stock_bills_company_idx on public.stock_bills(company_id);
create index if not exists stock_bills_created_by_idx on public.stock_bills(created_by);

-- Sales Report lines: net sales, EOO fees, other fees and penalties.
create table if not exists public.stock_bill_entries (
  id uuid primary key default gen_random_uuid(),
  stock_bill_id uuid not null references public.stock_bills(id) on delete cascade,
  entry_type text not null check (entry_type in ('sales','eoo_fee','fee','penalty')),
  entry_date date not null default ((now() at time zone 'Asia/Manila'))::date,
  amount numeric(14,2) not null check (amount > 0),
  receipt_no text,
  description text,
  created_by uuid references public.profiles(id) default auth.uid(),
  created_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists stock_bill_entries_bill_idx on public.stock_bill_entries(stock_bill_id);
create index if not exists stock_bill_entries_created_by_idx on public.stock_bill_entries(created_by);

-- History of each stock-bill.
create table if not exists public.stock_bill_events (
  id bigint generated always as identity primary key,
  stock_bill_id uuid not null references public.stock_bills(id) on delete cascade,
  action text not null,
  note text,
  actor uuid references public.profiles(id),
  actor_name text,
  created_at timestamptz not null default now()
);
create index if not exists stock_bill_events_bill_idx on public.stock_bill_events(stock_bill_id);
create index if not exists stock_bill_events_actor_idx on public.stock_bill_events(actor);

-- The secret code of a PAID stock-bill (printed as a QR code on its Statistics Report).
create table if not exists public.stock_bill_secrets (
  stock_bill_id uuid primary key references public.stock_bills(id) on delete cascade,
  secret_code text not null unique,
  created_at timestamptz not null default now()
);

-- Release Order: an order letter for a stock-bill.
alter table public.order_letters add column if not exists stock_bill_id uuid references public.stock_bills(id) on delete set null;
alter table public.order_letters add column if not exists release_date date;
alter table public.order_letters add column if not exists shipping_cost numeric(14,2);
alter table public.order_letters add column if not exists shipping_bill_no text;
-- the stock-bill details on the day the order is made (shown on the letter)
alter table public.order_letters add column if not exists stock_info jsonb;
create index if not exists order_letters_stock_bill_idx on public.order_letters(stock_bill_id);
alter table public.order_letters drop constraint if exists order_letters_one_subject;
alter table public.order_letters add constraint order_letters_one_subject check (num_nonnulls(customer_id, employee_id, company_id, stock_bill_id) <= 1);
alter table public.order_letters drop constraint if exists order_letters_subject_type_check;
alter table public.order_letters add constraint order_letters_subject_type_check check (subject_type in
  ('suspension','closure','reactivation','reopen','termination','memo','unpaid','installment','unsettled_balance','promise_to_pay',
   'balance_certificate','charge','settlement','other','release'));
alter table public.order_letters drop constraint if exists order_letters_shipping_cost_check;
alter table public.order_letters add constraint order_letters_shipping_cost_check check (shipping_cost is null or shipping_cost >= 0);

-- Billing: a payment voucher can pay a stock-bill (e-bill).
alter table public.pay_vouchers add column if not exists stock_bill_id uuid references public.stock_bills(id) on delete set null;
create index if not exists pay_vouchers_stock_bill_idx on public.pay_vouchers(stock_bill_id);

-- Files of a stock-bill and of its sales report lines.
alter table public.attachments drop constraint if exists attachments_owner_type_check;
alter table public.attachments add constraint attachments_owner_type_check check (owner_type in
  ('customer','invoice','payment','credit_memo','employee','resolution','project','project_payment','supplier','supplier_payment',
   'statement','job_application','payslip','order_letter','pay_company','pay_account','pay_voucher','stock_bill','stock_bill_entry'));
alter table public.attachments drop constraint if exists attachments_kind_check;
alter table public.attachments add constraint attachments_kind_check check (kind in
  ('photo','requirement','signed_form','receipt','delivery_receipt','purchase_order','proof','application','signature','report',
   'approval','other','bill','shipping_bill','sales_report'));

-- ---------- 2. a new stock-bill: number, item table and totals ----------
create or replace function public.stock_bills_before_insert() returns trigger
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare
  types text[];
  ncol int;
  iq int; ip int; it int;
  r jsonb; nr jsonb; rows jsonb := '[]'::jsonb;
  q numeric; p numeric; tq numeric := 0; tc numeric := 0;
  k int; empty boolean;
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
  new.items := rows;
  new.total_qty := tq;
  new.total_cost := tc;
  new.supplier_bill_no := nullif(trim(new.supplier_bill_no), '');
  new.batch_no := nullif(trim(new.batch_no), '');
  new.shipment_no := nullif(trim(new.shipment_no), '');
  new.bill_no := 'SB-' || to_char(new.bill_date, 'YYYY') || '-' || lpad(public.next_counter('SB' || to_char(new.bill_date, 'YYYY'))::text, 4, '0');
  new.status := 'shipped';
  new.release_date := null; new.shipping_cost := null; new.shipping_bill_no := null; new.release_order_no := null;
  new.arrived_at := null; new.released_at := null; new.sold_at := null; new.paid_at := null; new.paid_by_name := null;
  new.created_by := auth.uid();
  new.created_by_name := (select full_name from public.profiles where id = auth.uid());
  return new;
end;
$$;
drop trigger if exists stock_bills_bi on public.stock_bills;
create trigger stock_bills_bi before insert on public.stock_bills for each row execute function public.stock_bills_before_insert();

create or replace function public.stock_bills_after_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.stock_bill_events (stock_bill_id, action, note, actor, actor_name)
  values (new.id, 'Stock-Bill added — SHIPPED', 'Total cost BDT ' || to_char(new.total_cost, 'FM999,999,999,990.00'), auth.uid(), new.created_by_name);
  return new;
end;
$$;
drop trigger if exists stock_bills_ai on public.stock_bills;
create trigger stock_bills_ai after insert on public.stock_bills for each row execute function public.stock_bills_after_insert();

-- ---------- 3. Sales Report lines ----------
create or replace function public.stock_bill_entries_before_insert() returns trigger
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare b public.stock_bills;
begin
  select * into b from public.stock_bills x where x.id = new.stock_bill_id;
  if b.id is null then raise exception 'Choose the stock-bill'; end if;
  if b.status = 'paid' then raise exception 'Stock-Bill % is PAID and closed. Nothing more can be added to it', b.bill_no; end if;
  if new.entry_type = 'sales' and b.status not in ('released','sold') then
    raise exception 'Net sales can be added after the stock-bill is RELEASED (it is % now)', upper(b.status);
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
drop trigger if exists stock_bill_entries_bi on public.stock_bill_entries;
create trigger stock_bill_entries_bi before insert on public.stock_bill_entries for each row execute function public.stock_bill_entries_before_insert();

create or replace function public.stock_bill_entries_after_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.stock_bill_events (stock_bill_id, action, note, actor, actor_name)
  values (new.stock_bill_id,
          case new.entry_type when 'sales' then 'net sales' when 'eoo_fee' then 'EOO fee' when 'fee' then 'fee' else 'penalty' end
            || ' BDT ' || to_char(new.amount, 'FM999,999,999,990.00') || ' added',
          concat_ws(' · ', 'Receipt No ' || new.receipt_no, new.description), auth.uid(), new.created_by_name);
  return new;
end;
$$;
drop trigger if exists stock_bill_entries_ai on public.stock_bill_entries;
create trigger stock_bill_entries_ai after insert on public.stock_bill_entries for each row execute function public.stock_bill_entries_after_insert();

revoke execute on function public.stock_bills_before_insert() from public, anon, authenticated;
revoke execute on function public.stock_bills_after_insert() from public, anon, authenticated;
revoke execute on function public.stock_bill_entries_before_insert() from public, anon, authenticated;
revoke execute on function public.stock_bill_entries_after_insert() from public, anon, authenticated;

-- ---------- 4. status: ARRIVED and SOLD (inventory staff), PAID (the Director) ----------
create or replace function public.stock_bill_action(p_id uuid, p_action text, p_note text default null) returns public.stock_bills
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare
  b public.stock_bills;
  me text := (select full_name from public.profiles where id = auth.uid());
  h text;
begin
  select * into b from public.stock_bills where id = p_id for update;
  if b.id is null then raise exception 'Stock-bill not found'; end if;
  if p_action = 'paid' then
    if not public.is_admin() then raise exception 'Only the Director can mark a stock-bill as PAID'; end if;
  elsif not public.can_write('inventory') then
    raise exception 'You do not have access to change stock-bills';
  end if;
  perform public.allow_record_change();
  if p_action = 'arrived' then
    if b.status <> 'shipped' then raise exception 'Stock-Bill % is % — only a SHIPPED stock-bill can be marked as ARRIVED', b.bill_no, upper(b.status); end if;
    update public.stock_bills set status = 'arrived', arrived_at = now() where id = p_id returning * into b;
  elsif p_action = 'sold' then
    if b.status <> 'released' then raise exception 'Stock-Bill % is % — only a RELEASED stock-bill can be marked as SOLD', b.bill_no, upper(b.status); end if;
    if not exists (select 1 from public.stock_bill_entries x where x.stock_bill_id = p_id and x.entry_type = 'sales') then
      raise exception 'Add the net sales in the Sales Report first';
    end if;
    update public.stock_bills set status = 'sold', sold_at = now() where id = p_id returning * into b;
  elsif p_action = 'paid' then
    if b.status <> 'sold' then raise exception 'Stock-Bill % is % — only a SOLD stock-bill can be marked as PAID', b.bill_no, upper(b.status); end if;
    update public.stock_bills set status = 'paid', paid_at = now(), paid_by_name = me where id = p_id returning * into b;
    -- the secret code of the Statistics Report: 24 random characters
    h := upper(md5(gen_random_uuid()::text || clock_timestamp()::text));
    insert into public.stock_bill_secrets (stock_bill_id, secret_code)
    values (p_id, 'SBX-' || substr(h, 1, 6) || '-' || substr(h, 7, 6) || '-' || substr(h, 13, 6) || '-' || substr(h, 19, 6))
    on conflict (stock_bill_id) do nothing;
  else
    raise exception 'Unknown action %', p_action;
  end if;
  insert into public.stock_bill_events (stock_bill_id, action, note, actor, actor_name)
  values (p_id, 'marked ' || upper(b.status), nullif(trim(p_note), ''), auth.uid(), me);
  return b;
end;
$$;
revoke execute on function public.stock_bill_action(uuid, text, text) from public, anon;
grant execute on function public.stock_bill_action(uuid, text, text) to authenticated;

-- Totals of each stock-bill. The profit or loss shows only after the Director marks it PAID.
create or replace view public.stock_bill_totals with (security_invoker = true) as
  select b.*, pc.name as company_name, pc.currency as company_currency,
    coalesce(e.net_sales, 0)::numeric(14,2) as net_sales,
    coalesce(e.eoo_fees, 0)::numeric(14,2) as eoo_fees,
    coalesce(e.other_fees, 0)::numeric(14,2) as other_fees,
    coalesce(e.penalties, 0)::numeric(14,2) as penalties,
    (b.total_cost + coalesce(b.shipping_cost, 0))::numeric(14,2) as bill_total,
    (b.total_cost + coalesce(b.shipping_cost, 0) + coalesce(e.eoo_fees, 0) + coalesce(e.other_fees, 0) + coalesce(e.penalties, 0))::numeric(14,2) as total_expenses,
    coalesce(v.paid, 0)::numeric(14,2) as paid_bdt,
    coalesce(v.vouchers, 0)::int as vouchers_count,
    case when b.status = 'paid' and (select public.has_module('inventory')) then
      (coalesce(e.net_sales, 0) - (b.total_cost + coalesce(b.shipping_cost, 0) + coalesce(e.eoo_fees, 0) + coalesce(e.other_fees, 0) + coalesce(e.penalties, 0)))::numeric(14,2) end as profit
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

-- ---------- 5. who can see and add ----------
alter table public.stock_bills enable row level security;
alter table public.stock_bill_entries enable row level security;
alter table public.stock_bill_events enable row level security;
alter table public.stock_bill_secrets enable row level security;
drop policy if exists "sb: read" on public.stock_bills;
drop policy if exists "sb: insert" on public.stock_bills;
drop policy if exists "sbe: read" on public.stock_bill_entries;
drop policy if exists "sbe: insert" on public.stock_bill_entries;
drop policy if exists "sbv: read" on public.stock_bill_events;
drop policy if exists "sbs: read" on public.stock_bill_secrets;
-- Inventory sees every stock-bill; Billing sees the released ones (its e-bills).
create policy "sb: read" on public.stock_bills for select to authenticated using (
  (select public.has_module('inventory')) or (status in ('released','sold','paid') and (select public.has_module('billing'))));
create policy "sb: insert" on public.stock_bills for insert to authenticated with check ((select public.can_write('inventory')));
create policy "sbe: read" on public.stock_bill_entries for select to authenticated using ((select public.has_module('inventory')));
create policy "sbe: insert" on public.stock_bill_entries for insert to authenticated with check ((select public.can_write('inventory')));
create policy "sbv: read" on public.stock_bill_events for select to authenticated using ((select public.has_module('inventory')));
create policy "sbs: read" on public.stock_bill_secrets for select to authenticated using ((select public.has_module('inventory')));

-- Inventory also sees the billing companies and the payments made for stock-bills.
drop policy if exists "pc: read" on public.pay_companies;
create policy "pc: read" on public.pay_companies for select to authenticated using ((select public.has_module('billing')) or (select public.has_module('inventory')));
drop policy if exists "pv: read" on public.pay_vouchers;
create policy "pv: read" on public.pay_vouchers for select to authenticated using (
  (select public.has_module('billing')) or (stock_bill_id is not null and (select public.has_module('inventory'))));

-- Release orders are seen by Inventory (and the Director); Inventory staff request them.
drop policy if exists "ol: read" on public.order_letters;
create policy "ol: read" on public.order_letters for select to authenticated using (
  (employee_id is null and company_id is null and stock_bill_id is null and (select public.is_active()))
  or (employee_id is not null and ((select public.is_admin()) or (select public.has_module('employees'))
      or (status in ('approved','applied') and exists (select 1 from public.employees e where e.id = order_letters.employee_id and e.profile_id = (select auth.uid())))))
  or (company_id is not null and ((select public.is_admin()) or (select public.has_module('billing'))))
  or (stock_bill_id is not null and (select public.has_module('inventory'))));
drop policy if exists "ol: insert" on public.order_letters;
create policy "ol: insert" on public.order_letters for insert to authenticated with check (
  (customer_id is not null and ((select public.can_write('orders')) or (select public.can_write('customers'))))
  or (employee_id is not null and (select public.can_write('employees')))
  or (company_id is not null and (select public.can_write('billing')))
  or (stock_bill_id is not null and (select public.can_write('inventory'))));

-- Files of stock-bills are seen only by Inventory (and the Director).
drop policy if exists "att: inventory files" on public.attachments;
create policy "att: inventory files" on public.attachments as restrictive for select to authenticated
  using (owner_type not in ('stock_bill','stock_bill_entry') or (select public.has_module('inventory')));
drop policy if exists "storage records: inventory files" on storage.objects;
create policy "storage records: inventory files" on storage.objects as restrictive for select to authenticated
  using (bucket_id <> 'records' or coalesce((storage.foldername(name))[1], '') not in ('stock_bill','stock_bill_entry') or (select public.has_module('inventory')));

-- Saved stock-bills are only added to (like every other record): status changes go through the functions above.
do $$
declare t text;
begin
  foreach t in array array['stock_bills','stock_bill_entries','stock_bill_events','stock_bill_secrets'] loop
    execute format('drop trigger if exists keep_records on public.%I', t);
    execute format('create trigger keep_records before update or delete on public.%I for each row execute function public.keep_records()', t);
    execute format('drop trigger if exists keep_records_truncate on public.%I', t);
    execute format('create trigger keep_records_truncate before truncate on public.%I for each statement execute function public.keep_records()', t);
  end loop;
end $$;

-- ---------- 6. corrections, files and history ----------
-- Details of a stock-bill that can be corrected (amounts and items cannot: the Director deletes a wrong stock-bill).
create or replace function public.editable_columns(p_table text) returns text[]
language sql immutable set search_path = '' as $$
  select case p_table
    when 'customers' then array['first_name','last_name','phone','email','address','business_name','business_start_date','facebook_name','has_extra_facebook','extra_facebook_name','facebook_verified','credit_limit']
    when 'customer_invoices' then array['purchase_date','po_number','total_boxes','total_pcs']
    when 'payments_received' then array['method','bank_name','bank_account','reference_no','notes']
    when 'credit_memos' then array['payment_ref','po_number','article','brand','style','batch_no','serial_no','purchase_date','defect_category','defect_detail','assigned_by','inspection_notes','factory_status']
    when 'employees' then array['first_name','last_name','position','phone','address','date_hired','monthly_salary']
    when 'payslips' then array['method','reference_no','notes']
    when 'projects' then array['title','description','location','start_date','end_date']
    when 'project_payments' then array['received_by','method','reference_no','notes']
    when 'pay_companies' then array['name','contact_person','contact','address','country','currency','notes']
    when 'pay_accounts' then array['account_name','account_number','bank_name','branch_name','notes']
    when 'pay_vouchers' then array['purpose','method','reference_no','notes']
    when 'job_applications' then array['full_name','phone','email','present_address','permanent_address','father_name','mother_name','spouse_name','date_of_birth','birth_place','id_number','gender','religion','blood_group','apply_salary','apply_duty_hours','apply_joining_date']
    when 'stock_bills' then array['supplier_bill_no','batch_no','shipment_no','shipment_date','total_boxes','notes']
    else null end;
$$;

-- Removing a file of a stock-bill is also written in its history.
create or replace function public.remove_attachment(p_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  a public.attachments;
  me text := (select full_name from public.profiles where id = auth.uid());
  tbl text;
  bill uuid;
begin
  select * into a from public.attachments where id = p_id;
  if not found then raise exception 'File not found'; end if;
  if not (public.is_admin() or (public.is_active() and a.uploaded_by = auth.uid() and a.created_at > now() - interval '24 hours')) then
    raise exception 'You can remove your own upload within 24 hours. After that, ask the Director';
  end if;
  perform public.allow_record_change();
  delete from public.attachments where id = p_id;
  if a.owner_type = 'customer' then
    -- removing the customer's current photo also takes it off the profile
    update public.customers set photo_path = null where id = a.owner_id and photo_path = a.storage_path;
    insert into public.customer_events (customer_id, action, note, actor, actor_name)
    values (a.owner_id, 'file removed', a.file_name, auth.uid(), me);
  end if;
  if a.owner_type in ('stock_bill','stock_bill_entry') then
    bill := case when a.owner_type = 'stock_bill' then a.owner_id else (select x.stock_bill_id from public.stock_bill_entries x where x.id = a.owner_id) end;
    if bill is not null then
      insert into public.stock_bill_events (stock_bill_id, action, note, actor, actor_name) values (bill, 'file removed', a.file_name, auth.uid(), me);
    end if;
  end if;
  tbl := case a.owner_type when 'customer' then 'customers' when 'invoice' then 'customer_invoices' when 'payment' then 'payments_received'
    when 'credit_memo' then 'credit_memos' when 'employee' then 'employees' when 'job_application' then 'job_applications'
    when 'payslip' then 'payslips' when 'order_letter' then 'order_letters' when 'pay_company' then 'pay_companies'
    when 'pay_account' then 'pay_accounts' when 'pay_voucher' then 'pay_vouchers' when 'project' then 'projects'
    when 'project_payment' then 'project_payments' when 'statement' then 'statements'
    when 'stock_bill' then 'stock_bills' when 'stock_bill_entry' then 'stock_bill_entries' else a.owner_type end;
  insert into public.record_changes (target_table, target_id, action, changes, previous, target_label, actor, actor_name)
  values (tbl, a.owner_id, 'file removed', jsonb_build_object('file', ''), jsonb_build_object('file', a.file_name), a.file_name, auth.uid(), me);
  return a.storage_path;
end;
$$;
revoke execute on function public.remove_attachment(uuid) from public, anon;
grant execute on function public.remove_attachment(uuid) to authenticated;

-- ---------- 7. the other functions: created again exactly as they are now, with only these lines added ----------
do $$
declare
  -- function name, the exact old text, the new text
  fixes text[][] := array[
    -- Release Order: an order letter for an open stock-bill
    ['order_letters_before_insert', 'declare kind text; d jsonb;', 'declare kind text; d jsonb; bl public.stock_bills;'],
    ['order_letters_before_insert', 'if num_nonnulls(new.customer_id, new.employee_id, new.company_id) <> 1 then',
                                    'if num_nonnulls(new.customer_id, new.employee_id, new.company_id, new.stock_bill_id) <> 1 then'],
    ['order_letters_before_insert', '''Choose one customer, employee or company for this order''', '''Choose one customer, employee, company or stock-bill for this order'''],
    ['order_letters_before_insert', 'when new.company_id is not null then ''company'' else ''customer'' end;',
                                    'when new.company_id is not null then ''company'' when new.stock_bill_id is not null then ''stock_bill'' else ''customer'' end;'],
    ['order_letters_before_insert', 'if kind = ''customer'' and new.subject_type in (''termination'',''memo'') then',
                                    'if kind = ''stock_bill'' then
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
  end if;
  if kind = ''customer'' and new.subject_type in (''termination'',''memo'') then'],
    -- the approved Release Order releases the stock-bill and adds the shipping cost
    ['carry_out_order', 'pc public.pay_companies;', 'pc public.pay_companies;
  bl public.stock_bills;'],
    ['carry_out_order', 'perform public.allow_record_change();', 'perform public.allow_record_change();
  if o.stock_bill_id is not null then
    select * into bl from public.stock_bills where id = o.stock_bill_id for update;
    if bl.id is null then raise exception ''The stock-bill of this order was deleted''; end if;
    if bl.status not in (''shipped'',''arrived'') then raise exception ''Stock-Bill % is % and cannot be released again'', bl.bill_no, upper(bl.status); end if;
    update public.stock_bills set status = ''released'', release_date = o.release_date, shipping_cost = o.shipping_cost,
      shipping_bill_no = o.shipping_bill_no, release_order_no = o.order_no, released_at = now() where id = bl.id;
    insert into public.stock_bill_events (stock_bill_id, action, note, actor, actor_name)
    values (bl.id, ''released by '' || o.order_no, ''Shipping cost BDT '' || to_char(o.shipping_cost, ''FM999,999,999,990.00''), auth.uid(), me);
    res := ''Stock-Bill '' || bl.bill_no || '' is now RELEASED — total cost BDT '' || to_char(bl.total_cost + o.shipping_cost, ''FM999,999,999,990.00'')
      || '' (shipping BDT '' || to_char(o.shipping_cost, ''FM999,999,999,990.00'') || '')'';
    update public.order_letters set status = ''applied'', applied_at = now(), applied_by_name = me, applied_result = res,
      prev_status = bl.status, prev_note = null where id = o.id;
    return jsonb_build_object(''order_no'', o.order_no, ''result'', res, ''status'', ''released'');
  end if;'],
    -- deleting a carried-out Release Order puts the stock-bill back to SHIPPED or ARRIVED
    ['undo_order', 'st text[] := array[''suspension'',''closure'',''reactivation'',''reopen'',''termination''];',
                   'st text[] := array[''suspension'',''closure'',''reactivation'',''reopen'',''termination'',''release''];'],
    ['undo_order', 'and x.company_id is not distinct from o.company_id', 'and x.company_id is not distinct from o.company_id and x.stock_bill_id is not distinct from o.stock_bill_id'],
    ['undo_order', 'perform public.allow_record_change();', 'perform public.allow_record_change();
  if o.stock_bill_id is not null then
    update public.stock_bills set status = coalesce(prev, ''arrived''), release_date = null, shipping_cost = null, shipping_bill_no = null,
      release_order_no = null, released_at = null
    where id = o.stock_bill_id and status = ''released'' returning status into prev;
    if not found then return null; end if;
    insert into public.stock_bill_events (stock_bill_id, action, note, actor, actor_name)
    values (o.stock_bill_id, o.order_no || '' deleted — status back to '' || upper(prev), o.subject, auth.uid(), me);
    return prev;
  end if;'],
    ['order_set_status', 'when o.subject_type = ''reopen'' then array[''active'']', 'when o.subject_type = ''reopen'' then array[''active'']
    when o.subject_type = ''release'' then array[''released'']'],
    -- Billing: a voucher can pay a released stock-bill of the same company, in BDT
    ['pay_vouchers_before_insert', 'new.voucher_no := ''BD'' || to_char(new.pay_date, ''YYYYMMDD'')', 'if new.stock_bill_id is not null then
    if not exists (select 1 from public.stock_bills b where b.id = new.stock_bill_id and b.company_id = new.company_id) then
      raise exception ''That stock-bill belongs to a different company'';
    end if;
    if not exists (select 1 from public.stock_bills b where b.id = new.stock_bill_id and b.status in (''released'',''sold'',''paid'')) then
      raise exception ''Only a released stock-bill (e-bill) can be paid'';
    end if;
    if new.amount_bdt is null then raise exception ''A stock-bill is paid in BDT, but this company is paid in PHP only''; end if;
  end if;
  new.voucher_no := ''BD'' || to_char(new.pay_date, ''YYYYMMDD'')'],
    -- delete: a stock-bill with a release order or payments, and a sold one's release order, are kept
    ['delete_record', 'if p_table = ''pay_accounts'' and exists (select 1 from public.pay_vouchers x where x.account_id = p_id) then',
                      'if p_table = ''stock_bills'' and exists (select 1 from public.order_letters x where x.stock_bill_id = p_id) then
    raise exception ''This stock-bill has a release order. Delete the order letter first'';
  end if;
  if p_table = ''stock_bills'' and exists (select 1 from public.pay_vouchers x where x.stock_bill_id = p_id) then
    raise exception ''This stock-bill has payments in Billing. Delete those payment vouchers first'';
  end if;
  if p_table = ''order_letters'' and j->>''status'' = ''applied''
     and (select b.status from public.stock_bills b where b.id = (j->>''stock_bill_id'')::uuid) in (''sold'',''paid'') then
    raise exception ''This stock-bill is already SOLD or PAID, so its release order cannot be deleted'';
  end if;
  if p_table = ''pay_accounts'' and exists (select 1 from public.pay_vouchers x where x.account_id = p_id) then'],
    ['delete_record', 'when ''order_letters'' then ''order_letter'' end;', 'when ''order_letters'' then ''order_letter'' when ''stock_bills'' then ''stock_bill'' when ''stock_bill_entries'' then ''stock_bill_entry'' end;'],
    ['delete_record', 'if p_table = ''pay_companies'' then subs := array(select a.id from public.pay_accounts a where a.company_id = p_id); end if;',
                      'if p_table = ''pay_companies'' then subs := array(select a.id from public.pay_accounts a where a.company_id = p_id); end if;
  if p_table = ''stock_bills'' then subs := array(select x.id from public.stock_bill_entries x where x.stock_bill_id = p_id); end if;'],
    ['delete_record', 'delete from public.change_requests where target_table = p_table and target_id = p_id;',
                      'if p_table = ''stock_bill_entries'' then
    insert into public.stock_bill_events (stock_bill_id, action, note, actor, actor_name)
    values ((j->>''stock_bill_id'')::uuid,
            case j->>''entry_type'' when ''sales'' then ''net sales'' when ''eoo_fee'' then ''EOO fee'' when ''fee'' then ''fee'' else ''penalty'' end
              || '' BDT '' || to_char((j->>''amount'')::numeric, ''FM999,999,999,990.00'') || '' deleted'',
            concat_ws('' · '', ''Receipt No '' || (j->>''receipt_no''), j->>''description''), auth.uid(), (select full_name from public.profiles where id = auth.uid()));
  end if;
  delete from public.change_requests where target_table = p_table and target_id = p_id;'],
    ['deletable_table', '''job_applications'',''job_positions''), false);', '''job_applications'',''job_positions'',''stock_bills'',''stock_bill_entries''), false);'],
    ['can_see_table', 'when p_table in (''projects'',''project_payments'') then public.has_module(''projects'')',
                      'when p_table in (''projects'',''project_payments'') then public.has_module(''projects'')
    when p_table in (''stock_bills'',''stock_bill_entries'') then public.has_module(''inventory'')'],
    ['record_link', 'when ''job_applications'' then ''jobapp/'' || p_id when ''order_letters'' then ''order/'' || p_id',
                    'when ''job_applications'' then ''jobapp/'' || p_id when ''order_letters'' then ''order/'' || p_id when ''stock_bills'' then ''stockbill/'' || p_id'],
    -- Verification: a stock-bill only for its secret code (with the profit or loss); a release order without figures
    ['verify_record', '-- customer account (account no, application no or public ID)',
                      '-- A stock-bill shows only for the secret code of its Statistics Report (never for its number).
    select b.*, pc.name as co_name, s.secret_code,
      coalesce((select sum(x.amount) from public.stock_bill_entries x where x.stock_bill_id = b.id and x.entry_type = ''sales''), 0) as net_sales,
      coalesce((select sum(x.amount) from public.stock_bill_entries x where x.stock_bill_id = b.id and x.entry_type = ''eoo_fee''), 0) as eoo_fees,
      coalesce((select sum(x.amount) from public.stock_bill_entries x where x.stock_bill_id = b.id and x.entry_type = ''fee''), 0) as other_fees,
      coalesce((select sum(x.amount) from public.stock_bill_entries x where x.stock_bill_id = b.id and x.entry_type = ''penalty''), 0) as penalties
      into r from public.stock_bill_secrets s join public.stock_bills b on b.id = s.stock_bill_id join public.pay_companies pc on pc.id = b.company_id
      where replace(upper(s.secret_code), ''-'', '''') = replace(c, ''-'', '''') limit 1;
    if found then
      return jsonb_build_object(''found'', true, ''type'', ''Stock-Bill Statistics'', ''number'', r.bill_no, ''status'', r.status,
        ''fields'', (select jsonb_agg(f) from jsonb_array_elements(jsonb_build_array(
          jsonb_build_array(''Stock-Bill No'', r.bill_no), jsonb_build_array(''Company'', r.co_name),
          jsonb_build_array(''Bill Date'', to_char(r.bill_date, ''DD Mon YYYY'')),
          case when r.supplier_bill_no is not null then jsonb_build_array(''Supplier Bill No'', r.supplier_bill_no) end,
          jsonb_build_array(''Batch No'', coalesce(r.batch_no, ''—'')), jsonb_build_array(''Shipment No'', coalesce(r.shipment_no, ''—'')),
          jsonb_build_array(''Shipment Date'', coalesce(to_char(r.shipment_date, ''DD Mon YYYY''), ''—'')),
          jsonb_build_array(''Release Date'', coalesce(to_char(r.release_date, ''DD Mon YYYY''), ''—'')),
          jsonb_build_array(''Total Boxes / Qty'', coalesce(r.total_boxes::text, ''—'') || '' / ''
            || case when r.total_qty = trunc(r.total_qty) then to_char(r.total_qty, ''FM999,999,999,990'') else to_char(r.total_qty, ''FM999,999,999,990.00'') end),
          jsonb_build_array(''Bill Cost (BDT)'', to_char(r.total_cost, ''FM999,999,999,990.00'')),
          jsonb_build_array(''Shipping Cost (BDT)'', to_char(coalesce(r.shipping_cost, 0), ''FM999,999,999,990.00'')),
          jsonb_build_array(''Total Cost (BDT)'', to_char(r.total_cost + coalesce(r.shipping_cost, 0), ''FM999,999,999,990.00'')),
          jsonb_build_array(''EOO Fees (BDT)'', to_char(r.eoo_fees, ''FM999,999,999,990.00'')),
          jsonb_build_array(''Other Fees (BDT)'', to_char(r.other_fees, ''FM999,999,999,990.00'')),
          jsonb_build_array(''Penalties (BDT)'', to_char(r.penalties, ''FM999,999,999,990.00'')),
          jsonb_build_array(''Total Expenses (BDT)'', to_char(r.total_cost + coalesce(r.shipping_cost, 0) + r.eoo_fees + r.other_fees + r.penalties, ''FM999,999,999,990.00'')),
          jsonb_build_array(''Net Sales (BDT)'', to_char(r.net_sales, ''FM999,999,999,990.00'')),
          jsonb_build_array(case when r.net_sales < r.total_cost + coalesce(r.shipping_cost, 0) + r.eoo_fees + r.other_fees + r.penalties then ''Net Loss (BDT)'' else ''Net Profit (BDT)'' end,
            to_char(abs(r.net_sales - (r.total_cost + coalesce(r.shipping_cost, 0) + r.eoo_fees + r.other_fees + r.penalties)), ''FM999,999,999,990.00'')),
          jsonb_build_array(''Marked Paid'', to_char(r.paid_at, ''DD Mon YYYY'') || coalesce('' by '' || r.paid_by_name, '''')),
          jsonb_build_array(''Secret Code'', r.secret_code))) f where f <> ''null''::jsonb));
    end if;
    -- customer account (account no, application no or public ID)'],
    ['verify_record', 'select o.*, cu.first_name, cu.last_name, cu.account_no as acct, em.first_name as em_first',
                      '-- A release order shows only that it is a genuine order (no stock-bill figures).
    select o.order_no, o.order_date, o.subject, o.status, o.approved_by_name, pc.name as co_name into r
      from public.order_letters o join public.stock_bills b on b.id = o.stock_bill_id join public.pay_companies pc on pc.id = b.company_id
      where upper(o.order_no) = c limit 1;
    if found then
      return jsonb_build_object(''found'', true, ''type'', ''Order Letter'', ''number'', r.order_no, ''status'', r.status,
        ''fields'', jsonb_build_array(
          jsonb_build_array(''Order No'', r.order_no), jsonb_build_array(''Date'', to_char(r.order_date, ''DD Mon YYYY'')),
          jsonb_build_array(''Company'', r.co_name), jsonb_build_array(''Subject'', r.subject), jsonb_build_array(''Type'', ''Release Order''),
          jsonb_build_array(''Status'', upper(r.status)), jsonb_build_array(''Approved By'', coalesce(r.approved_by_name, ''—''))));
    end if;
    select o.*, cu.first_name, cu.last_name, cu.account_no as acct, em.first_name as em_first']
  ];
  f record; def text; new_def text; i int;
begin
  for f in select p.oid, p.proname from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and pg_get_userbyid(p.proowner) = current_user
             and p.proname in ('order_letters_before_insert', 'carry_out_order', 'undo_order', 'order_set_status', 'pay_vouchers_before_insert',
                               'delete_record', 'deletable_table', 'can_see_table', 'record_link', 'verify_record')
  loop
    def := pg_get_functiondef(f.oid);
    new_def := def;
    for i in 1 .. array_length(fixes, 1) loop
      -- added once: when the new text is already there (the script was run before), nothing is changed
      if fixes[i][1] = f.proname and position(fixes[i][3] in new_def) = 0 then
        if position(fixes[i][2] in new_def) = 0 then raise exception 'Update 1.9: % has changed; text not found: %', f.proname, left(fixes[i][2], 60); end if;
        new_def := replace(new_def, fixes[i][2], fixes[i][3]);
      end if;
    end loop;
    if new_def <> def then execute new_def; end if;
  end loop;
end $$;
