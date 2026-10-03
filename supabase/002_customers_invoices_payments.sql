-- Emon Overruns Portal, part 2: branding, menu access, customers, invoices, payments, credit memos,
-- users (employees), resolutions, projects, billing (suppliers), notifications.
-- Safe to run once after portal_init.sql. Invoices live in customer_invoices (an older, unrelated
-- "invoices" table may already exist in this project and is left untouched).

-- ---------- Counters (shared helper) ----------
create or replace function public.next_counter(p_key text) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  insert into public.doc_counters as c (prefix, last_no) values (p_key, 1)
    on conflict (prefix) do update set last_no = c.last_no + 1
    returning last_no into n;
  return n;
end;
$$;
revoke execute on function public.next_counter(text) from public, anon, authenticated;

-- ---------- Profile photo and per-user menu access ----------
alter table public.profiles add column if not exists avatar_path text;
-- modules: which menu items a user may use. NULL means all (used for admins and older accounts).
alter table public.profiles add column if not exists modules text[];

create or replace function public.has_module(m text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active'
    and (p.role = 'admin' or p.modules is null or m = any(p.modules)));
$$;
create or replace function public.can_write(m text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active'
    and (p.role = 'admin' or (p.role = 'staff' and (p.modules is null or m = any(p.modules)))));
$$;
revoke execute on function public.has_module(text) from public, anon;
revoke execute on function public.can_write(text) from public, anon;
grant execute on function public.has_module(text) to authenticated;
grant execute on function public.can_write(text) to authenticated;

-- Users may update only their own photo; admins can update anything (existing policy).
create or replace function public.set_my_avatar(p_path text) returns void
language sql security definer set search_path = '' as $$
  update public.profiles set avatar_path = p_path where id = auth.uid();
$$;
revoke execute on function public.set_my_avatar(text) from public, anon;
grant execute on function public.set_my_avatar(text) to authenticated;

-- ---------- Company settings (logo) ----------
create table if not exists public.company_settings (
  id integer primary key default 1 check (id = 1),
  logo_path text,
  updated_at timestamptz not null default now()
);
insert into public.company_settings (id) values (1) on conflict do nothing;
alter table public.company_settings enable row level security;
create policy "settings: anyone read" on public.company_settings for select to anon, authenticated using (true);
create policy "settings: admin update" on public.company_settings for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- ---------- Customers ----------
create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  account_no text unique,
  application_no text unique,
  public_id text unique,
  first_name text not null,
  last_name text not null,
  photo_path text,
  address text not null,
  address_verified boolean not null default false,
  address_lat double precision,
  address_lon double precision,
  business_start_date date,
  business_name text,
  facebook_name text,
  has_extra_facebook boolean not null default false,
  extra_facebook_name text,
  facebook_verified boolean not null default false,
  phone text,
  email text,
  application_date date not null default current_date,
  status text not null default 'pending'
    check (status in ('pending','verified','active','rejected','suspended','closed')),
  status_note text,
  issued_by uuid references public.profiles(id) default auth.uid(),
  issued_by_name text,
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists customers_status_idx on public.customers(status);
create index if not exists customers_issued_by_idx on public.customers(issued_by);
create index if not exists customers_reviewed_by_idx on public.customers(reviewed_by);
create index if not exists customers_name_idx on public.customers(lower(last_name), lower(first_name));

-- Private code lives apart so only admins can read it.
create table if not exists public.customer_secrets (
  customer_id uuid primary key references public.customers(id) on delete cascade,
  private_code text not null
);
alter table public.customer_secrets enable row level security;
create policy "secrets: admin read" on public.customer_secrets for select to authenticated
  using ((select public.is_admin()));

create or replace function public.customers_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  ym text := to_char(coalesce(new.application_date, current_date), 'YYYYMM');
  yr text := to_char(coalesce(new.application_date, current_date), 'YYYY');
  initials text := upper(left(regexp_replace(new.first_name, '[^A-Za-z]', '', 'g'), 1) || left(regexp_replace(new.last_name, '[^A-Za-z]', '', 'g'), 1));
begin
  if initials = '' or initials is null then initials := 'XX'; end if;
  new.account_no := initials || '-' || ym || lpad(public.next_counter('ACC' || ym)::text, 3, '0');
  new.application_no := 'EO-' || yr || '-' || lpad(public.next_counter('APP' || yr)::text, 5, '0');
  new.public_id := 'EO' || upper(substr(md5(gen_random_uuid()::text), 1, 8));
  new.status := 'pending';
  new.issued_by := auth.uid();
  new.issued_by_name := (select full_name from public.profiles where id = auth.uid());
  new.reviewed_by := null;
  new.reviewed_at := null;
  new.facebook_verified := coalesce(new.facebook_verified, false);
  return new;
end;
$$;
drop trigger if exists customers_bi on public.customers;
create trigger customers_bi before insert on public.customers
  for each row execute function public.customers_before_insert();

alter table public.customers enable row level security;
create policy "customers: active read" on public.customers for select to authenticated
  using ((select public.is_active()));
create policy "customers: staff insert" on public.customers for insert to authenticated
  with check ((select public.can_write('customers')));
create policy "customers: admin update" on public.customers for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- ---------- Customer history ----------
create table if not exists public.customer_events (
  id bigint generated always as identity primary key,
  customer_id uuid not null references public.customers(id) on delete cascade,
  action text not null,
  note text,
  actor uuid references public.profiles(id),
  actor_name text,
  created_at timestamptz not null default now()
);
create index if not exists customer_events_customer_idx on public.customer_events(customer_id);
create index if not exists customer_events_actor_idx on public.customer_events(actor);
alter table public.customer_events enable row level security;
create policy "cevents: active read" on public.customer_events for select to authenticated
  using ((select public.is_active()));

-- ---------- Notifications (the mail icon) ----------
create table if not exists public.notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  body text,
  link text,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications(user_id, is_read);
alter table public.notifications enable row level security;
create policy "notif: own read" on public.notifications for select to authenticated
  using (user_id = (select auth.uid()));
create policy "notif: own update" on public.notifications for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create or replace function public.customers_after_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.customer_secrets (customer_id, private_code)
  values (new.id, upper(substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 10)));
  insert into public.customer_events (customer_id, action, actor, actor_name)
  values (new.id, 'application submitted', auth.uid(), new.issued_by_name);
  insert into public.notifications (user_id, title, body, link)
  select p.id, 'New customer application ' || new.application_no,
         new.first_name || ' ' || new.last_name || ' (' || new.account_no || ') is waiting for review.',
         'customer/' || new.id
  from public.profiles p where p.role = 'admin' and p.status = 'active';
  return new;
end;
$$;
drop trigger if exists customers_ai on public.customers;
create trigger customers_ai after insert on public.customers
  for each row execute function public.customers_after_insert();

-- Admin actions: verify / approve / reject / suspend / reactivate / close / set facebook flag.
create or replace function public.customer_action(p_id uuid, p_action text, p_note text default null)
returns public.customers
language plpgsql security definer set search_path = '' as $$
declare
  c public.customers;
  new_status text;
begin
  if not public.is_admin() then raise exception 'Only an admin can do this'; end if;
  select * into c from public.customers where id = p_id for update;
  if c.id is null then raise exception 'Customer not found'; end if;
  if c.status = 'closed' then raise exception 'This account is permanently closed'; end if;
  new_status := case p_action
    when 'verify' then 'verified'
    when 'approve' then 'active'
    when 'reject' then 'rejected'
    when 'suspend' then 'suspended'
    when 'reactivate' then 'active'
    when 'close' then 'closed'
    when 'facebook_verified' then c.status
    when 'facebook_unverified' then c.status
    else null end;
  if new_status is null then raise exception 'Unknown action %', p_action; end if;
  if p_action = 'approve' and c.status not in ('pending','verified') then raise exception 'Only pending or verified applications can be approved'; end if;
  if p_action = 'reactivate' and c.status <> 'suspended' then raise exception 'Only suspended accounts can be reactivated'; end if;
  if p_action = 'suspend' and c.status <> 'active' then raise exception 'Only active accounts can be suspended'; end if;
  update public.customers set
    status = new_status,
    status_note = coalesce(p_note, status_note),
    facebook_verified = case p_action when 'facebook_verified' then true when 'facebook_unverified' then false else facebook_verified end,
    reviewed_by = case when p_action in ('verify','approve','reject') then auth.uid() else reviewed_by end,
    reviewed_at = case when p_action in ('verify','approve','reject') then now() else reviewed_at end
  where id = p_id returning * into c;
  insert into public.customer_events (customer_id, action, note, actor, actor_name)
  values (p_id, replace(p_action, '_', ' '), p_note, auth.uid(), (select full_name from public.profiles where id = auth.uid()));
  return c;
end;
$$;

-- Possible duplicates: same name, phone, email or Facebook name.
create or replace function public.customer_duplicates(p_id uuid)
returns table (id uuid, account_no text, first_name text, last_name text, phone text, email text, facebook_name text, status text, matched_on text)
language sql stable security invoker set search_path = '' as $$
  select o.id, o.account_no, o.first_name, o.last_name, o.phone, o.email, o.facebook_name, o.status,
    concat_ws(', ',
      case when lower(o.first_name) = lower(c.first_name) and lower(o.last_name) = lower(c.last_name) then 'name' end,
      case when nullif(regexp_replace(o.phone, '\D', '', 'g'), '') = nullif(regexp_replace(c.phone, '\D', '', 'g'), '') then 'phone' end,
      case when nullif(lower(o.email), '') = nullif(lower(c.email), '') then 'email' end,
      case when nullif(lower(o.facebook_name), '') = nullif(lower(c.facebook_name), '') then 'facebook' end)
  from public.customers c
  join public.customers o on o.id <> c.id
  where c.id = p_id and (
       (lower(o.first_name) = lower(c.first_name) and lower(o.last_name) = lower(c.last_name))
    or nullif(regexp_replace(o.phone, '\D', '', 'g'), '') = nullif(regexp_replace(c.phone, '\D', '', 'g'), '')
    or nullif(lower(o.email), '') = nullif(lower(c.email), '')
    or nullif(lower(o.facebook_name), '') = nullif(lower(c.facebook_name), ''));
$$;

-- ---------- Attachments (customers, invoices, payments) ----------
create table if not exists public.attachments (
  id uuid primary key default gen_random_uuid(),
  owner_type text not null check (owner_type in ('customer','invoice','payment','credit_memo','employee','resolution','project','project_payment','supplier','supplier_payment')),
  owner_id uuid not null,
  kind text not null check (kind in ('photo','requirement','signed_form','receipt','delivery_receipt','purchase_order','proof','application','signature','report','approval','other')),
  storage_path text not null,
  file_name text not null,
  mime text,
  size bigint,
  uploaded_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists attachments_owner_idx on public.attachments(owner_type, owner_id);
create index if not exists attachments_uploaded_by_idx on public.attachments(uploaded_by);
alter table public.attachments enable row level security;
create policy "att: active read" on public.attachments for select to authenticated
  using ((select public.is_active()) and (owner_type <> 'employee' or (select public.is_admin())));
create policy "att: staff insert" on public.attachments for insert to authenticated
  with check ((select public.is_staff()));
create policy "att: admin delete" on public.attachments for delete to authenticated
  using ((select public.is_admin()));

-- ---------- Invoices ----------
create table if not exists public.customer_invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_no text unique,
  customer_id uuid not null references public.customers(id),
  invoice_date date not null default current_date,
  purchase_date date,
  po_number text,
  total_boxes integer not null default 0 check (total_boxes >= 0),
  total_pcs integer not null default 0 check (total_pcs >= 0),
  total_amount numeric(14,2) not null check (total_amount >= 0),
  created_by uuid references public.profiles(id) default auth.uid(),
  created_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists cinv_customer_idx on public.customer_invoices(customer_id);
create index if not exists cinv_created_by_idx on public.customer_invoices(created_by);

create or replace function public.customer_invoices_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare st text;
begin
  select status into st from public.customers where id = new.customer_id;
  if st is null then raise exception 'Customer not found'; end if;
  if st <> 'active' then raise exception 'Invoices can only be recorded for ACTIVE accounts (this account is %)', upper(st); end if;
  new.invoice_no := 'INV-' || to_char(new.invoice_date, 'YYYYMM') || '-' || lpad(public.next_counter('CINV' || to_char(new.invoice_date, 'YYYYMM'))::text, 4, '0');
  new.created_by := auth.uid();
  new.created_by_name := (select full_name from public.profiles where id = auth.uid());
  return new;
end;
$$;
drop trigger if exists cinv_bi on public.customer_invoices;
create trigger cinv_bi before insert on public.customer_invoices
  for each row execute function public.customer_invoices_before_insert();

alter table public.customer_invoices enable row level security;
create policy "inv: active read" on public.customer_invoices for select to authenticated using ((select public.is_active()));
create policy "inv: staff insert" on public.customer_invoices for insert to authenticated with check ((select public.can_write('invoices')));
create policy "inv: admin delete" on public.customer_invoices for delete to authenticated using ((select public.is_admin()));

-- ---------- Payments ----------
create table if not exists public.payments_received (
  id uuid primary key default gen_random_uuid(),
  receipt_no text unique,
  customer_id uuid not null references public.customers(id),
  invoice_id uuid references public.customer_invoices(id) on delete set null,
  amount numeric(14,2) not null check (amount > 0),
  method text not null check (method in ('cash','bank_transfer','online_transfer','deposit')),
  bank_name text,
  bank_account text,
  reference_no text,
  paid_date date not null default current_date,
  notes text,
  created_by uuid references public.profiles(id) default auth.uid(),
  created_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists payrec_customer_idx on public.payments_received(customer_id);
create index if not exists payrec_invoice_idx on public.payments_received(invoice_id);
create index if not exists payrec_created_by_idx on public.payments_received(created_by);

create or replace function public.payments_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare st text;
begin
  select status into st from public.customers where id = new.customer_id;
  if st is null then raise exception 'Customer not found'; end if;
  if st in ('pending','verified','rejected') then raise exception 'Payments can only be recorded for approved accounts (this account is %)', upper(st); end if;
  if new.invoice_id is not null and not exists (select 1 from public.customer_invoices i where i.id = new.invoice_id and i.customer_id = new.customer_id) then
    raise exception 'That invoice belongs to a different customer';
  end if;
  new.receipt_no := 'A-' || to_char(new.paid_date, 'YYYY') || '-' || to_char(new.paid_date, 'MMDD') || '-' || lpad(public.next_counter('PAY' || to_char(new.paid_date, 'YYYYMMDD'))::text, 3, '0');
  new.created_by := auth.uid();
  new.created_by_name := (select full_name from public.profiles where id = auth.uid());
  return new;
end;
$$;
drop trigger if exists payments_bi on public.payments_received;
create trigger payments_bi before insert on public.payments_received
  for each row execute function public.payments_before_insert();

alter table public.payments_received enable row level security;
create policy "pay: active read" on public.payments_received for select to authenticated using ((select public.is_active()));
create policy "pay: staff insert" on public.payments_received for insert to authenticated with check ((select public.can_write('payments')) or (select public.can_write('invoices')));
create policy "pay: admin delete" on public.payments_received for delete to authenticated using ((select public.is_admin()));

-- ---------- Balances ----------
create or replace view public.invoice_balances with (security_invoker = true) as
  select i.*, c.first_name, c.last_name, c.account_no, c.business_name, c.status as customer_status,
    coalesce((select sum(p.amount) from public.payments_received p where p.invoice_id = i.id), 0)::numeric(14,2) as amount_paid,
    (i.total_amount - coalesce((select sum(p.amount) from public.payments_received p where p.invoice_id = i.id), 0))::numeric(14,2) as balance,
    case when coalesce((select sum(p.amount) from public.payments_received p where p.invoice_id = i.id), 0) >= i.total_amount then 'paid'
         when coalesce((select sum(p.amount) from public.payments_received p where p.invoice_id = i.id), 0) > 0 then 'partial'
         else 'unpaid' end as pay_status
  from public.customer_invoices i join public.customers c on c.id = i.customer_id;

-- ---------- Credit memos (customer complaint / defect claims) ----------
create table if not exists public.credit_memos (
  id uuid primary key default gen_random_uuid(),
  memo_no text unique,
  memo_date date not null default current_date,
  customer_id uuid not null references public.customers(id),
  payment_ref text,
  po_number text,
  article text,
  brand text,
  style text,
  batch_no text,
  serial_no text,
  qty integer not null default 0 check (qty >= 0),
  purchase_date date,
  defect_category text not null check (defect_category in ('fabric_damage','color_issue','wrong_box','wrong_bundle','other')),
  defect_detail text,
  requested_action text not null check (requested_action in ('replacement','refund','credit','discount')),
  rate numeric(14,2) not null default 0 check (rate >= 0),
  request_amount numeric(14,2) not null default 0 check (request_amount >= 0),
  assigned_by text,
  inspection_notes text,
  factory_status text,
  status text not null default 'pending' check (status in ('pending','approved','rejected','paid')),
  status_note text,
  approved_by uuid references public.profiles(id),
  approved_by_name text,
  approved_at timestamptz,
  paid_by_name text,
  paid_at timestamptz,
  created_by uuid references public.profiles(id) default auth.uid(),
  created_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists credit_memos_customer_idx on public.credit_memos(customer_id);
create index if not exists credit_memos_created_by_idx on public.credit_memos(created_by);
create index if not exists credit_memos_approved_by_idx on public.credit_memos(approved_by);

create or replace function public.credit_memos_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare st text;
begin
  select status into st from public.customers where id = new.customer_id;
  if st is null then raise exception 'Customer not found'; end if;
  if st in ('pending','verified','rejected','closed') then raise exception 'Credit memos can only be recorded for approved, open accounts (this account is %)', upper(st); end if;
  new.memo_no := 'EOC-' || to_char(new.memo_date, 'YYYYMM') || lpad(public.next_counter('EOC' || to_char(new.memo_date, 'YYYYMM'))::text, 3, '0');
  new.status := 'pending';
  new.approved_by := null; new.approved_at := null; new.paid_at := null;
  new.created_by := auth.uid();
  new.created_by_name := (select full_name from public.profiles where id = auth.uid());
  return new;
end;
$$;
drop trigger if exists credit_memos_bi on public.credit_memos;
create trigger credit_memos_bi before insert on public.credit_memos
  for each row execute function public.credit_memos_before_insert();

create or replace function public.credit_memos_after_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.notifications (user_id, title, body, link)
  select p.id, 'Credit memo ' || new.memo_no || ' needs review',
         'Requested ' || new.requested_action || ' of PHP ' || to_char(new.request_amount, 'FM999,999,990.00'),
         'creditmemo/' || new.id
  from public.profiles p where p.role = 'admin' and p.status = 'active';
  return new;
end;
$$;
drop trigger if exists credit_memos_ai on public.credit_memos;
create trigger credit_memos_ai after insert on public.credit_memos
  for each row execute function public.credit_memos_after_insert();

alter table public.credit_memos enable row level security;
create policy "cm: active read" on public.credit_memos for select to authenticated using ((select public.is_active()));
create policy "cm: staff insert" on public.credit_memos for insert to authenticated with check ((select public.can_write('creditmemos')));

create or replace function public.credit_memo_action(p_id uuid, p_action text, p_note text default null)
returns public.credit_memos
language plpgsql security definer set search_path = '' as $$
declare m public.credit_memos; me text;
begin
  if not public.is_admin() then raise exception 'Only an admin can do this'; end if;
  select * into m from public.credit_memos where id = p_id for update;
  if m.id is null then raise exception 'Credit memo not found'; end if;
  me := (select full_name from public.profiles where id = auth.uid());
  if p_action = 'approve' and m.status = 'pending' then
    update public.credit_memos set status = 'approved', approved_by = auth.uid(), approved_by_name = me, approved_at = now(), status_note = coalesce(p_note, status_note) where id = p_id returning * into m;
  elsif p_action = 'reject' and m.status = 'pending' then
    update public.credit_memos set status = 'rejected', approved_by = auth.uid(), approved_by_name = me, approved_at = now(), status_note = coalesce(p_note, status_note) where id = p_id returning * into m;
  elsif p_action = 'paid' and m.status = 'approved' then
    update public.credit_memos set status = 'paid', paid_by_name = me, paid_at = now(), status_note = coalesce(p_note, status_note) where id = p_id returning * into m;
  else
    raise exception 'Cannot % a % credit memo', p_action, m.status;
  end if;
  insert into public.customer_events (customer_id, action, note, actor, actor_name)
  values (m.customer_id, 'credit memo ' || m.memo_no || ' ' || m.status, p_note, auth.uid(), me);
  return m;
end;
$$;

-- Approved or paid credit/discount memos reduce what the customer owes.
create or replace view public.customer_balances with (security_invoker = true) as
  select c.id as customer_id,
    coalesce((select sum(total_amount) from public.customer_invoices i where i.customer_id = c.id), 0)::numeric(14,2) as total_invoiced,
    coalesce((select sum(amount) from public.payments_received p where p.customer_id = c.id), 0)::numeric(14,2) as total_paid,
    coalesce((select sum(request_amount) from public.credit_memos m where m.customer_id = c.id and m.status in ('approved','paid') and m.requested_action in ('credit','discount')), 0)::numeric(14,2) as total_credits,
    (coalesce((select sum(total_amount) from public.customer_invoices i where i.customer_id = c.id), 0)
      - coalesce((select sum(amount) from public.payments_received p where p.customer_id = c.id), 0)
      - coalesce((select sum(request_amount) from public.credit_memos m where m.customer_id = c.id and m.status in ('approved','paid') and m.requested_action in ('credit','discount')), 0))::numeric(14,2) as balance_due
  from public.customers c;

-- ---------- Grants ----------
revoke execute on function public.customer_action(uuid, text, text) from public, anon;
revoke execute on function public.customer_duplicates(uuid) from public, anon;
grant execute on function public.customer_action(uuid, text, text) to authenticated;
grant execute on function public.customer_duplicates(uuid) to authenticated;
revoke execute on function public.customers_before_insert() from public, anon, authenticated;
revoke execute on function public.customers_after_insert() from public, anon, authenticated;
revoke execute on function public.customer_invoices_before_insert() from public, anon, authenticated;
revoke execute on function public.payments_before_insert() from public, anon, authenticated;
revoke execute on function public.credit_memos_before_insert() from public, anon, authenticated;
revoke execute on function public.credit_memos_after_insert() from public, anon, authenticated;
revoke execute on function public.credit_memo_action(uuid, text, text) from public, anon;
grant execute on function public.credit_memo_action(uuid, text, text) to authenticated;
revoke select on public.invoice_balances, public.customer_balances from anon;

-- ---------- Storage ----------
insert into storage.buckets (id, name, public) values ('branding', 'branding', true) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('records', 'records', false) on conflict (id) do nothing;

create policy "storage branding: admin upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'branding' and (select public.is_admin()));
create policy "storage branding: admin update" on storage.objects for update to authenticated
  using (bucket_id = 'branding' and (select public.is_admin()));
create policy "storage avatars: own upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "storage records: active read" on storage.objects for select to authenticated
  using (bucket_id = 'records' and (select public.is_active()) and ((storage.foldername(name))[1] <> 'employee' or (select public.is_admin())));
create policy "storage records: staff upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'records' and (select public.is_staff()));
create policy "storage records: admin delete" on storage.objects for delete to authenticated
  using (bucket_id = 'records' and (select public.is_admin()));

-- =====================================================================
-- 5. User (employees). Admin creates the record and picks menu access;
--    the employee then signs up with the same email and is let in automatically.
-- =====================================================================
create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  employee_no text unique,
  first_name text not null,
  last_name text not null,
  position text,
  email text not null,
  phone text,
  address text,
  date_hired date,
  photo_path text,
  role text not null default 'staff' check (role in ('admin','staff','viewer')),
  modules text[] not null default '{}',
  status text not null default 'waiting' check (status in ('waiting','active','inactive')),
  profile_id uuid references public.profiles(id) on delete set null,
  created_by uuid references public.profiles(id) default auth.uid(),
  created_by_name text,
  created_at timestamptz not null default now()
);
create unique index if not exists employees_email_uq on public.employees(lower(email));
create index if not exists employees_profile_idx on public.employees(profile_id);
create index if not exists employees_created_by_idx on public.employees(created_by);

create or replace function public.employees_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare ym text := to_char(current_date, 'YYYYMM'); p uuid;
begin
  new.employee_no := 'EO-' || ym || lpad(public.next_counter('EMP' || ym)::text, 2, '0');
  new.email := lower(trim(new.email));
  new.created_by := auth.uid();
  new.created_by_name := (select full_name from public.profiles where id = auth.uid());
  -- Already has a login with this email? Link it now.
  select id into p from public.profiles where lower(email) = new.email;
  if p is not null then new.profile_id := p; new.status := 'active'; else new.status := 'waiting'; end if;
  return new;
end;
$$;
drop trigger if exists employees_bi on public.employees;
create trigger employees_bi before insert on public.employees
  for each row execute function public.employees_before_insert();

-- Keep the login (profile) in step with the employee record.
create or replace function public.employees_sync_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.profile_id is not null then
    update public.profiles set
      role = new.role,
      modules = new.modules,
      full_name = new.first_name || ' ' || new.last_name,
      status = case when new.status = 'inactive' then 'disabled' else 'active' end
    where id = new.profile_id;
  end if;
  return new;
end;
$$;
drop trigger if exists employees_sync on public.employees;
create trigger employees_sync after insert or update on public.employees
  for each row execute function public.employees_sync_profile();

alter table public.employees enable row level security;
create policy "emp: admin or self read" on public.employees for select to authenticated
  using ((select public.is_admin()) or profile_id = (select auth.uid()));
create policy "emp: admin insert" on public.employees for insert to authenticated with check ((select public.is_admin()));
create policy "emp: admin update" on public.employees for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "emp: admin delete" on public.employees for delete to authenticated using ((select public.is_admin()));

-- New sign-ups: owner emails become admin; emails registered as employees get their access right away.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  first_user boolean;
  emp public.employees;
begin
  select not exists (select 1 from public.profiles) into first_user;
  select * into emp from public.employees e where lower(e.email) = lower(new.email) limit 1;
  insert into public.profiles (id, email, full_name, role, status, modules)
  values (
    new.id, new.email,
    coalesce(case when emp.id is not null then emp.first_name || ' ' || emp.last_name end, new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    case when first_user or lower(new.email) = 'emonoverruns@gmail.com' then 'admin' when emp.id is not null then emp.role else 'viewer' end,
    case when first_user or lower(new.email) = 'emonoverruns@gmail.com' then 'active'
         when emp.id is not null then (case when emp.status = 'inactive' then 'disabled' else 'active' end) else 'pending' end,
    case when emp.id is not null and not (first_user or lower(new.email) = 'emonoverruns@gmail.com') then emp.modules end
  );
  if emp.id is not null then
    update public.employees set profile_id = new.id, status = case when status = 'inactive' then 'inactive' else 'active' end where id = emp.id;
  end if;
  return new;
end;
$$;

-- =====================================================================
-- 6. Resolution (notices). Shown for 3 months, newest first.
-- =====================================================================
create table if not exists public.resolutions (
  id uuid primary key default gen_random_uuid(),
  resolution_no text unique,
  subject text not null,
  body text,
  resolution_date date not null default current_date,
  image_path text,
  created_by uuid references public.profiles(id) default auth.uid(),
  created_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists resolutions_date_idx on public.resolutions(resolution_date desc);
create index if not exists resolutions_created_by_idx on public.resolutions(created_by);
create or replace function public.resolutions_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.resolution_no := 'RES-' || to_char(new.resolution_date, 'YYYY') || '-' || lpad(public.next_counter('RES' || to_char(new.resolution_date, 'YYYY'))::text, 3, '0');
  new.created_by := auth.uid();
  new.created_by_name := (select full_name from public.profiles where id = auth.uid());
  return new;
end;
$$;
drop trigger if exists resolutions_bi on public.resolutions;
create trigger resolutions_bi before insert on public.resolutions
  for each row execute function public.resolutions_before_insert();
alter table public.resolutions enable row level security;
-- Everyone active sees notices from the last 3 months; admins also see older ones.
create policy "res: read recent" on public.resolutions for select to authenticated
  using (((select public.is_active()) and resolution_date >= (current_date - interval '3 months')) or (select public.is_admin()));
create policy "res: write" on public.resolutions for insert to authenticated with check ((select public.can_write('resolutions')));
create policy "res: admin delete" on public.resolutions for delete to authenticated using ((select public.is_admin()));

-- =====================================================================
-- 7. Project: application + budget -> approval (with approved document) -> payments.
-- =====================================================================
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  project_no text unique,
  title text not null,
  description text,
  location text,
  start_date date,
  end_date date,
  total_cost numeric(14,2) not null default 0 check (total_cost >= 0),
  status text not null default 'pending' check (status in ('pending','approved','rejected','completed')),
  status_note text,
  approved_by_name text,
  approved_at timestamptz,
  created_by uuid references public.profiles(id) default auth.uid(),
  created_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists projects_created_by_idx on public.projects(created_by);
create table if not exists public.project_items (
  id bigint generated always as identity primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  description text not null,
  qty numeric(14,2) not null default 1,
  unit_cost numeric(14,2) not null default 0,
  amount numeric(14,2) generated always as (qty * unit_cost) stored
);
create index if not exists project_items_project_idx on public.project_items(project_id);
create table if not exists public.project_payments (
  id uuid primary key default gen_random_uuid(),
  payment_no text unique,
  project_id uuid not null references public.projects(id) on delete cascade,
  pay_date date not null default current_date,
  amount numeric(14,2) not null check (amount > 0),
  received_by text not null,
  method text,
  reference_no text,
  notes text,
  created_by uuid references public.profiles(id) default auth.uid(),
  created_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists project_payments_project_idx on public.project_payments(project_id);
create index if not exists project_payments_created_by_idx on public.project_payments(created_by);

create or replace function public.projects_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.project_no := 'PRJ-' || to_char(current_date, 'YYYY') || '-' || lpad(public.next_counter('PRJ' || to_char(current_date, 'YYYY'))::text, 3, '0');
  new.status := 'pending'; new.approved_at := null; new.approved_by_name := null;
  new.created_by := auth.uid();
  new.created_by_name := (select full_name from public.profiles where id = auth.uid());
  return new;
end;
$$;
drop trigger if exists projects_bi on public.projects;
create trigger projects_bi before insert on public.projects
  for each row execute function public.projects_before_insert();

create or replace function public.project_payments_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare st text;
begin
  select status into st from public.projects where id = new.project_id;
  if st is distinct from 'approved' then raise exception 'Payments can only be recorded on APPROVED projects (this project is %)', upper(coalesce(st, 'missing')); end if;
  new.payment_no := 'PP-' || to_char(new.pay_date, 'YYYYMM') || '-' || lpad(public.next_counter('PP' || to_char(new.pay_date, 'YYYYMM'))::text, 3, '0');
  new.created_by := auth.uid();
  new.created_by_name := (select full_name from public.profiles where id = auth.uid());
  return new;
end;
$$;
drop trigger if exists project_payments_bi on public.project_payments;
create trigger project_payments_bi before insert on public.project_payments
  for each row execute function public.project_payments_before_insert();

create or replace function public.project_action(p_id uuid, p_action text, p_note text default null)
returns public.projects
language plpgsql security definer set search_path = '' as $$
declare pr public.projects; me text;
begin
  if not public.is_admin() then raise exception 'Only an admin can do this'; end if;
  select * into pr from public.projects where id = p_id for update;
  if pr.id is null then raise exception 'Project not found'; end if;
  me := (select full_name from public.profiles where id = auth.uid());
  if p_action = 'approve' and pr.status = 'pending' then
    if not exists (select 1 from public.attachments a where a.owner_type = 'project' and a.owner_id = p_id and a.kind = 'approval') then
      raise exception 'Upload the approved project document first';
    end if;
    update public.projects set status = 'approved', approved_by_name = me, approved_at = now(), status_note = coalesce(p_note, status_note) where id = p_id returning * into pr;
  elsif p_action = 'reject' and pr.status = 'pending' then
    update public.projects set status = 'rejected', approved_by_name = me, approved_at = now(), status_note = coalesce(p_note, status_note) where id = p_id returning * into pr;
  elsif p_action = 'complete' and pr.status = 'approved' then
    update public.projects set status = 'completed', status_note = coalesce(p_note, status_note) where id = p_id returning * into pr;
  else
    raise exception 'Cannot % a % project', p_action, pr.status;
  end if;
  return pr;
end;
$$;

create or replace view public.project_balances with (security_invoker = true) as
  select p.*,
    coalesce((select sum(amount) from public.project_payments x where x.project_id = p.id), 0)::numeric(14,2) as total_paid,
    (p.total_cost - coalesce((select sum(amount) from public.project_payments x where x.project_id = p.id), 0))::numeric(14,2) as remaining
  from public.projects p;

alter table public.projects enable row level security;
alter table public.project_items enable row level security;
alter table public.project_payments enable row level security;
create policy "prj: read" on public.projects for select to authenticated using ((select public.has_module('projects')));
create policy "prj: insert" on public.projects for insert to authenticated with check ((select public.can_write('projects')));
create policy "prji: read" on public.project_items for select to authenticated using ((select public.has_module('projects')));
create policy "prji: insert" on public.project_items for insert to authenticated
  with check ((select public.can_write('projects')) and exists (select 1 from public.projects p where p.id = project_id and p.status = 'pending'));
create policy "prjp: read" on public.project_payments for select to authenticated using ((select public.has_module('projects')));
create policy "prjp: insert" on public.project_payments for insert to authenticated with check ((select public.can_write('projects')));

-- =====================================================================
-- 8. Billing (supplier portal): supplier accounts, released batches, payments.
-- =====================================================================
create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  supplier_no text unique,
  account_name text not null,
  account_number text,
  bank_name text,
  branch_name text,
  company text,
  contact_phone text,
  photo_path text,
  notes text,
  monthly_payment numeric(14,2) not null default 0 check (monthly_payment >= 0),
  status text not null default 'active' check (status in ('active','inactive')),
  created_by uuid references public.profiles(id) default auth.uid(),
  created_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists suppliers_created_by_idx on public.suppliers(created_by);
create table if not exists public.supplier_batches (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  batch_no text not null,
  release_date date not null default current_date,
  amount numeric(14,2) not null check (amount >= 0),
  description text,
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists supplier_batches_supplier_idx on public.supplier_batches(supplier_id);
create index if not exists supplier_batches_created_by_idx on public.supplier_batches(created_by);
create table if not exists public.supplier_payments (
  id uuid primary key default gen_random_uuid(),
  payment_no text unique,
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  batch_id uuid references public.supplier_batches(id) on delete set null,
  pay_date date not null default current_date,
  for_month date not null default date_trunc('month', current_date)::date,
  amount numeric(14,2) not null check (amount > 0),
  method text,
  reference_no text,
  notes text,
  created_by uuid references public.profiles(id) default auth.uid(),
  created_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists supplier_payments_supplier_idx on public.supplier_payments(supplier_id);
create index if not exists supplier_payments_batch_idx on public.supplier_payments(batch_id);
create index if not exists supplier_payments_created_by_idx on public.supplier_payments(created_by);

create or replace function public.suppliers_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.supplier_no := 'SUP-' || lpad(public.next_counter('SUP')::text, 4, '0');
  new.created_by := auth.uid();
  new.created_by_name := (select full_name from public.profiles where id = auth.uid());
  return new;
end;
$$;
drop trigger if exists suppliers_bi on public.suppliers;
create trigger suppliers_bi before insert on public.suppliers
  for each row execute function public.suppliers_before_insert();
create or replace function public.supplier_payments_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.batch_id is not null and not exists (select 1 from public.supplier_batches b where b.id = new.batch_id and b.supplier_id = new.supplier_id) then
    raise exception 'That batch belongs to a different supplier';
  end if;
  new.for_month := date_trunc('month', coalesce(new.for_month, new.pay_date))::date;
  new.payment_no := 'SP-' || to_char(new.pay_date, 'YYYYMM') || '-' || lpad(public.next_counter('SP' || to_char(new.pay_date, 'YYYYMM'))::text, 3, '0');
  new.created_by := auth.uid();
  new.created_by_name := (select full_name from public.profiles where id = auth.uid());
  return new;
end;
$$;
drop trigger if exists supplier_payments_bi on public.supplier_payments;
create trigger supplier_payments_bi before insert on public.supplier_payments
  for each row execute function public.supplier_payments_before_insert();

create or replace view public.supplier_balances with (security_invoker = true) as
  select s.*,
    coalesce((select sum(amount) from public.supplier_batches b where b.supplier_id = s.id), 0)::numeric(14,2) as total_batches,
    coalesce((select sum(amount) from public.supplier_payments p where p.supplier_id = s.id), 0)::numeric(14,2) as total_paid,
    coalesce((select sum(amount) from public.supplier_payments p where p.supplier_id = s.id and p.for_month = date_trunc('month', current_date)::date), 0)::numeric(14,2) as paid_this_month,
    (coalesce((select sum(amount) from public.supplier_batches b where b.supplier_id = s.id), 0)
      - coalesce((select sum(amount) from public.supplier_payments p where p.supplier_id = s.id), 0))::numeric(14,2) as balance
  from public.suppliers s;

alter table public.suppliers enable row level security;
alter table public.supplier_batches enable row level security;
alter table public.supplier_payments enable row level security;
create policy "sup: read" on public.suppliers for select to authenticated using ((select public.has_module('billing')));
create policy "sup: insert" on public.suppliers for insert to authenticated with check ((select public.can_write('billing')));
create policy "sup: update" on public.suppliers for update to authenticated using ((select public.can_write('billing'))) with check ((select public.can_write('billing')));
create policy "supb: read" on public.supplier_batches for select to authenticated using ((select public.has_module('billing')));
create policy "supb: insert" on public.supplier_batches for insert to authenticated with check ((select public.can_write('billing')));
create policy "supp: read" on public.supplier_payments for select to authenticated using ((select public.has_module('billing')));
create policy "supp: insert" on public.supplier_payments for insert to authenticated with check ((select public.can_write('billing')));

-- ---------- Grants for the new functions/views ----------
revoke execute on function public.employees_before_insert() from public, anon, authenticated;
revoke execute on function public.employees_sync_profile() from public, anon, authenticated;
revoke execute on function public.resolutions_before_insert() from public, anon, authenticated;
revoke execute on function public.projects_before_insert() from public, anon, authenticated;
revoke execute on function public.project_payments_before_insert() from public, anon, authenticated;
revoke execute on function public.suppliers_before_insert() from public, anon, authenticated;
revoke execute on function public.supplier_payments_before_insert() from public, anon, authenticated;
revoke execute on function public.project_action(uuid, text, text) from public, anon;
grant execute on function public.project_action(uuid, text, text) to authenticated;
revoke select on public.project_balances, public.supplier_balances from anon;
