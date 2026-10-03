-- Emon Overruns Portal, part 2: branding, customers, invoices, payments, notifications.
-- Safe to run once after portal_init.sql.

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

-- ---------- Profile photo ----------
alter table public.profiles add column if not exists avatar_path text;

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
  new.application_no := 'APP-' || yr || '-' || lpad(public.next_counter('APP' || yr)::text, 5, '0');
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
  with check ((select public.is_staff()));
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
  owner_type text not null check (owner_type in ('customer','invoice','payment','credit_memo')),
  owner_id uuid not null,
  kind text not null check (kind in ('photo','requirement','signed_form','receipt','delivery_receipt','purchase_order','proof','other')),
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
  using ((select public.is_active()));
create policy "att: staff insert" on public.attachments for insert to authenticated
  with check ((select public.is_staff()));
create policy "att: admin delete" on public.attachments for delete to authenticated
  using ((select public.is_admin()));

-- ---------- Invoices ----------
create table if not exists public.invoices (
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
create index if not exists invoices_customer_idx on public.invoices(customer_id);
create index if not exists invoices_created_by_idx on public.invoices(created_by);

create or replace function public.invoices_before_insert() returns trigger
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
drop trigger if exists invoices_bi on public.invoices;
create trigger invoices_bi before insert on public.invoices
  for each row execute function public.invoices_before_insert();

alter table public.invoices enable row level security;
create policy "inv: active read" on public.invoices for select to authenticated using ((select public.is_active()));
create policy "inv: staff insert" on public.invoices for insert to authenticated with check ((select public.is_staff()));
create policy "inv: admin delete" on public.invoices for delete to authenticated using ((select public.is_admin()));

-- ---------- Payments ----------
create table if not exists public.payments_received (
  id uuid primary key default gen_random_uuid(),
  receipt_no text unique,
  customer_id uuid not null references public.customers(id),
  invoice_id uuid references public.invoices(id) on delete set null,
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
  if new.invoice_id is not null and not exists (select 1 from public.invoices i where i.id = new.invoice_id and i.customer_id = new.customer_id) then
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
create policy "pay: staff insert" on public.payments_received for insert to authenticated with check ((select public.is_staff()));
create policy "pay: admin delete" on public.payments_received for delete to authenticated using ((select public.is_admin()));

-- ---------- Balances ----------
create or replace view public.invoice_balances with (security_invoker = true) as
  select i.*, c.first_name, c.last_name, c.account_no, c.business_name, c.status as customer_status,
    coalesce((select sum(p.amount) from public.payments_received p where p.invoice_id = i.id), 0)::numeric(14,2) as amount_paid,
    (i.total_amount - coalesce((select sum(p.amount) from public.payments_received p where p.invoice_id = i.id), 0))::numeric(14,2) as balance,
    case when coalesce((select sum(p.amount) from public.payments_received p where p.invoice_id = i.id), 0) >= i.total_amount then 'paid'
         when coalesce((select sum(p.amount) from public.payments_received p where p.invoice_id = i.id), 0) > 0 then 'partial'
         else 'unpaid' end as pay_status
  from public.invoices i join public.customers c on c.id = i.customer_id;

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
create policy "cm: staff insert" on public.credit_memos for insert to authenticated with check ((select public.is_staff()));

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
    coalesce((select sum(total_amount) from public.invoices i where i.customer_id = c.id), 0)::numeric(14,2) as total_invoiced,
    coalesce((select sum(amount) from public.payments_received p where p.customer_id = c.id), 0)::numeric(14,2) as total_paid,
    coalesce((select sum(request_amount) from public.credit_memos m where m.customer_id = c.id and m.status in ('approved','paid') and m.requested_action in ('credit','discount')), 0)::numeric(14,2) as total_credits,
    (coalesce((select sum(total_amount) from public.invoices i where i.customer_id = c.id), 0)
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
revoke execute on function public.invoices_before_insert() from public, anon, authenticated;
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
  using (bucket_id = 'records' and (select public.is_active()));
create policy "storage records: staff upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'records' and (select public.is_staff()));
create policy "storage records: admin delete" on storage.objects for delete to authenticated
  using (bucket_id = 'records' and (select public.is_admin()));
