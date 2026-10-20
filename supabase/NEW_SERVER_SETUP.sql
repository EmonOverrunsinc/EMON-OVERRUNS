-- =====================================================================
-- EMON OVERRUNS E-PORTAL - NEW SERVER SETUP (everything up to update 2.2) in ONE file. RUN ONLY THIS FILE, ONCE,
-- on the NEW, EMPTY project.
-- Supabase > your new project > SQL Editor > New query > paste ALL of this file > Run (if asked: "Run this query").
-- At the end it shows: E-PORTAL SERVER READY. If anything fails, nothing is changed and it can be run again.
-- Run it only ONCE: on a project that is already set up it stops with "already exists" and changes nothing.
-- The file has only plain letters (special characters are written [[U+....]] and put back before it runs), and
-- Windows line breaks are taken out, so copy and paste works.
-- Then: the first account that signs up on the E-Portal becomes the Director (Admin).
-- =====================================================================
do $run$
declare
  s text := $sql$
-- ======== portal_init.sql ========
-- Emon Overruns Portal: schema, security and storage

-- ---------- Profiles ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  role text not null default 'viewer' check (role in ('admin','staff','viewer')),
  status text not null default 'pending' check (status in ('pending','active','disabled')),
  created_at timestamptz not null default now()
);

create or replace function public.is_active() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active');
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active' and p.role = 'admin');
$$;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active' and p.role in ('admin','staff'));
$$;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  first_user boolean;
begin
  select not exists (select 1 from public.profiles) into first_user;
  insert into public.profiles (id, email, full_name, role, status)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    case when first_user or lower(new.email) = 'emonoverruns@gmail.com' then 'admin' else 'viewer' end,
    case when first_user or lower(new.email) = 'emonoverruns@gmail.com' then 'active' else 'pending' end
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
create policy "profiles: read own or admin" on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));
create policy "profiles: admin update" on public.profiles for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "profiles: admin delete" on public.profiles for delete to authenticated
  using ((select public.is_admin()));

-- ---------- Documents ----------
create table if not exists public.doc_counters (
  prefix text primary key,
  last_no integer not null default 0
);
alter table public.doc_counters enable row level security;  -- no policies: only definer functions touch it

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  doc_no text unique,
  doc_type text not null check (doc_type in ('invoice','receipt','debit_note','credit_note','deposit','refund','other')),
  doc_date date not null default current_date,
  due_date date,
  party_code text,
  party_name text not null,
  description text,
  amount numeric(14,2) not null default 0,
  currency text not null default 'PHP',
  status text not null default 'pending' check (status in ('pending','verified','rejected')),
  remarks text,
  verified_by uuid references public.profiles(id),
  verified_at timestamptz,
  barcode_payload text,
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists documents_doc_date_idx on public.documents(doc_date);
create index if not exists documents_status_idx on public.documents(status);
create index if not exists documents_created_by_idx on public.documents(created_by);
create index if not exists documents_verified_by_idx on public.documents(verified_by);

create or replace function public.documents_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  pfx text;
  n integer;
begin
  pfx := case new.doc_type
    when 'invoice' then 'INV' when 'receipt' then 'OR' when 'debit_note' then 'DN'
    when 'credit_note' then 'CN' when 'deposit' then 'DEP' when 'refund' then 'PV' else 'DOC' end;
  insert into public.doc_counters as c (prefix, last_no) values (pfx, 1)
    on conflict (prefix) do update set last_no = c.last_no + 1
    returning last_no into n;
  new.doc_no := pfx || '-' || lpad(n::text, 6, '0');
  new.status := 'pending';
  new.verified_by := null;
  new.verified_at := null;
  new.created_by := auth.uid();
  new.barcode_payload := 'EMON|' || new.doc_no || '|' || new.doc_type || '|' || new.doc_date::text || '|' || to_char(new.amount, 'FM999999999990.00');
  return new;
end;
$$;

drop trigger if exists documents_bi on public.documents;
create trigger documents_bi before insert on public.documents
  for each row execute function public.documents_before_insert();

alter table public.documents enable row level security;
create policy "documents: active read" on public.documents for select to authenticated
  using ((select public.is_active()));
create policy "documents: staff insert" on public.documents for insert to authenticated
  with check ((select public.is_staff()));
create policy "documents: admin delete" on public.documents for delete to authenticated
  using ((select public.is_admin()));

-- ---------- Files ----------
create table if not exists public.document_files (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  storage_path text not null,
  file_name text not null,
  mime text,
  size bigint,
  uploaded_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists document_files_doc_idx on public.document_files(document_id);
create index if not exists document_files_uploaded_by_idx on public.document_files(uploaded_by);
alter table public.document_files enable row level security;
create policy "files: active read" on public.document_files for select to authenticated
  using ((select public.is_active()));
create policy "files: staff insert" on public.document_files for insert to authenticated
  with check ((select public.is_staff()));
create policy "files: admin delete" on public.document_files for delete to authenticated
  using ((select public.is_admin()));

-- ---------- Verification log ----------
create table if not exists public.verification_log (
  id bigint generated always as identity primary key,
  document_id uuid not null references public.documents(id) on delete cascade,
  action text not null check (action in ('created','verified','rejected','reopened')),
  note text,
  actor uuid references public.profiles(id),
  actor_name text,
  created_at timestamptz not null default now()
);
create index if not exists verification_log_doc_idx on public.verification_log(document_id);
create index if not exists verification_log_actor_idx on public.verification_log(actor);
alter table public.verification_log enable row level security;
create policy "log: active read" on public.verification_log for select to authenticated
  using ((select public.is_active()));

create or replace function public.documents_after_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.verification_log (document_id, action, actor, actor_name)
  values (new.id, 'created', auth.uid(), (select full_name from public.profiles where id = auth.uid()));
  return new;
end;
$$;
drop trigger if exists documents_ai on public.documents;
create trigger documents_ai after insert on public.documents
  for each row execute function public.documents_after_insert();

create or replace function public.verify_document(p_id uuid, p_action text, p_note text default null)
returns public.documents
language plpgsql security definer set search_path = '' as $$
declare
  d public.documents;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can verify documents';
  end if;
  if p_action not in ('verified','rejected','reopened') then
    raise exception 'Invalid action %', p_action;
  end if;
  update public.documents set
    status = case when p_action = 'reopened' then 'pending' else p_action end,
    remarks = coalesce(p_note, remarks),
    verified_by = case when p_action = 'reopened' then null else auth.uid() end,
    verified_at = case when p_action = 'reopened' then null else now() end
  where id = p_id returning * into d;
  if d.id is null then
    raise exception 'Document not found';
  end if;
  insert into public.verification_log (document_id, action, note, actor, actor_name)
  values (p_id, p_action, p_note, auth.uid(), (select full_name from public.profiles where id = auth.uid()));
  return d;
end;
$$;

create or replace function public.search_documents(q text)
returns setof public.documents
language sql stable security invoker set search_path = '' as $$
  select * from public.documents d
  where q is null or q = ''
     or d.doc_no ilike '%' || q || '%'
     or d.party_name ilike '%' || q || '%'
     or coalesce(d.party_code, '') ilike '%' || q || '%'
     or coalesce(d.description, '') ilike '%' || q || '%'
     or coalesce(d.barcode_payload, '') = q
     or d.amount::text = q
  order by d.doc_date desc, d.doc_no desc
  limit 500;
$$;

-- ---------- Announcements ----------
create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  pinned boolean not null default false,
  created_by uuid references public.profiles(id) default auth.uid(),
  published_at timestamptz not null default now()
);
create index if not exists announcements_created_by_idx on public.announcements(created_by);
alter table public.announcements enable row level security;
create policy "ann: active read" on public.announcements for select to authenticated
  using ((select public.is_active()));
create policy "ann: admin insert" on public.announcements for insert to authenticated
  with check ((select public.is_admin()));
create policy "ann: admin update" on public.announcements for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "ann: admin delete" on public.announcements for delete to authenticated
  using ((select public.is_admin()));

-- ---------- Download forms ----------
create table if not exists public.forms (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  category text not null default 'General',
  storage_path text not null,
  file_name text not null,
  downloads integer not null default 0,
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists forms_created_by_idx on public.forms(created_by);
alter table public.forms enable row level security;
create policy "forms: active read" on public.forms for select to authenticated
  using ((select public.is_active()));
create policy "forms: admin insert" on public.forms for insert to authenticated
  with check ((select public.is_admin()));
create policy "forms: admin delete" on public.forms for delete to authenticated
  using ((select public.is_admin()));

create or replace function public.count_form_download(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_active() then raise exception 'Not allowed'; end if;
  update public.forms set downloads = downloads + 1 where id = p_id;
end;
$$;

-- ---------- Function grants ----------
revoke execute on function public.verify_document(uuid, text, text) from public, anon;
revoke execute on function public.count_form_download(uuid) from public, anon;
revoke execute on function public.search_documents(text) from public, anon;
revoke execute on function public.is_active() from public, anon;
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.is_staff() from public, anon;
grant execute on function public.is_active() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_staff() to authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.documents_before_insert() from public, anon, authenticated;
revoke execute on function public.documents_after_insert() from public, anon, authenticated;
grant execute on function public.verify_document(uuid, text, text) to authenticated;
grant execute on function public.count_form_download(uuid) to authenticated;
grant execute on function public.search_documents(text) to authenticated;

-- ---------- Storage ----------
insert into storage.buckets (id, name, public) values ('documents', 'documents', false)
  on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('forms', 'forms', false)
  on conflict (id) do nothing;

create policy "storage documents: active read" on storage.objects for select to authenticated
  using (bucket_id = 'documents' and (select public.is_active()));
create policy "storage documents: staff upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and (select public.is_staff()));
create policy "storage documents: admin delete" on storage.objects for delete to authenticated
  using (bucket_id = 'documents' and (select public.is_admin()));
create policy "storage forms: active read" on storage.objects for select to authenticated
  using (bucket_id = 'forms' and (select public.is_active()));
create policy "storage forms: admin upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'forms' and (select public.is_admin()));
create policy "storage forms: admin delete" on storage.objects for delete to authenticated
  using (bucket_id = 'forms' and (select public.is_admin()));

-- ---------- Existing accounts become active admins (owner accounts created before the portal) ----------
insert into public.profiles (id, email, full_name, role, status)
select u.id, u.email, coalesce(u.raw_user_meta_data->>'full_name', split_part(u.email, '@', 1)), 'admin', 'active'
from auth.users u
on conflict (id) do nothing;

-- ======== 002_customers_invoices_payments.sql ========
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
  owner_type text not null check (owner_type in ('customer','invoice','payment','credit_memo','employee','resolution','project','project_payment','supplier','supplier_payment','statement')),
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


-- =====================================================================
-- Statements of account (SOA). One per customer per month, created on the 1st
-- for the month just ended. Opening balance = everything before the month;
-- closing balance becomes next month's opening. Credits count when approved.
-- =====================================================================
create table if not exists public.statements (
  id uuid primary key default gen_random_uuid(),
  statement_no text unique,
  customer_id uuid not null references public.customers(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  opening_balance numeric(14,2) not null default 0,
  total_debit numeric(14,2) not null default 0,
  total_credit numeric(14,2) not null default 0,
  closing_balance numeric(14,2) not null default 0,
  generated_at timestamptz not null default now(),
  unique (customer_id, period_start)
);
create index if not exists statements_period_idx on public.statements(period_start);
alter table public.statements enable row level security;
create policy "soa: active read" on public.statements for select to authenticated using ((select public.is_active()));

-- Balance of a customer before a date (invoices [[U+2212]] payments [[U+2212]] approved credit/discount memos).
create or replace function public.balance_before(p_customer uuid, p_date date) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce((select sum(total_amount) from public.customer_invoices where customer_id = p_customer and invoice_date < p_date), 0)
       - coalesce((select sum(amount) from public.payments_received where customer_id = p_customer and paid_date < p_date), 0)
       - coalesce((select sum(request_amount) from public.credit_memos where customer_id = p_customer and status in ('approved','paid')
                   and requested_action in ('credit','discount') and approved_at::date < p_date), 0);
$$;

-- Creates any missing monthly statements up to the last complete month. Safe to call any time.
create or replace function public.generate_statements(p_customer uuid default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  c record;
  m date;
  first_m date;
  last_m date := (date_trunc('month', current_date) - interval '1 month')::date;
  stop_m date;
  nxt date;
  op numeric; deb numeric; cre numeric;
  made integer := 0;
begin
  if auth.uid() is not null and not public.is_active() then raise exception 'Not allowed'; end if;
  for c in select * from public.customers cu where cu.status in ('active','suspended','closed') and (p_customer is null or cu.id = p_customer) loop
    first_m := date_trunc('month', least(
      c.application_date,
      coalesce((select min(invoice_date) from public.customer_invoices where customer_id = c.id), c.application_date),
      coalesce((select min(paid_date) from public.payments_received where customer_id = c.id), c.application_date)))::date;
    stop_m := last_m;
    if c.status = 'closed' then
      stop_m := least(last_m, coalesce((select date_trunc('month', max(created_at))::date from public.customer_events where customer_id = c.id and action = 'close'), last_m));
    end if;
    m := first_m;
    while m <= stop_m loop
      nxt := (m + interval '1 month')::date;
      if not exists (select 1 from public.statements s where s.customer_id = c.id and s.period_start = m) then
        op := public.balance_before(c.id, m);
        deb := coalesce((select sum(total_amount) from public.customer_invoices where customer_id = c.id and invoice_date >= m and invoice_date < nxt), 0);
        cre := coalesce((select sum(amount) from public.payments_received where customer_id = c.id and paid_date >= m and paid_date < nxt), 0)
             + coalesce((select sum(request_amount) from public.credit_memos where customer_id = c.id and status in ('approved','paid')
                          and requested_action in ('credit','discount') and approved_at::date >= m and approved_at::date < nxt), 0);
        insert into public.statements (statement_no, customer_id, period_start, period_end, opening_balance, total_debit, total_credit, closing_balance)
        values ('SOA-' || to_char(m, 'YYYYMM') || '-' || c.account_no, c.id, m, (nxt - 1), op, deb, cre, op + deb - cre);
        made := made + 1;
      end if;
      m := nxt;
    end loop;
  end loop;
  return made;
end;
$$;
revoke execute on function public.balance_before(uuid, date) from public, anon;
grant execute on function public.balance_before(uuid, date) to authenticated;
revoke execute on function public.generate_statements(uuid) from public, anon;
grant execute on function public.generate_statements(uuid) to authenticated;

-- Run automatically at 00:05 on the 1st of each month (Manila time = UTC+8, so 16:05 UTC on the last day
-- would be midnight; we use 00:05 UTC on the 1st = 08:05 AM Manila). If pg_cron is not available,
-- the portal creates missing statements the next time someone opens the dashboard.
do $$
begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'emon-monthly-soa';
  perform cron.schedule('emon-monthly-soa', '5 0 1 * *', 'select public.generate_statements()');
exception when others then
  raise notice 'pg_cron not available (%); statements will be created when the portal is opened.', sqlerrm;
end $$;

-- ======== 003_statements.sql ========
-- Emon Overruns Portal, part 3: statements of account (SOA).
-- Only needed if you ran an earlier version of 002_customers_invoices_payments.sql before SOA was added.
-- Safe to run more than once.
alter table public.attachments drop constraint if exists attachments_owner_type_check;
alter table public.attachments add constraint attachments_owner_type_check check (owner_type in
  ('customer','invoice','payment','credit_memo','employee','resolution','project','project_payment','supplier','supplier_payment','statement'));

-- =====================================================================
-- Statements of account (SOA). One per customer per month, created on the 1st
-- for the month just ended. Opening balance = everything before the month;
-- closing balance becomes next month's opening. Credits count when approved.
-- =====================================================================
create table if not exists public.statements (
  id uuid primary key default gen_random_uuid(),
  statement_no text unique,
  customer_id uuid not null references public.customers(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  opening_balance numeric(14,2) not null default 0,
  total_debit numeric(14,2) not null default 0,
  total_credit numeric(14,2) not null default 0,
  closing_balance numeric(14,2) not null default 0,
  generated_at timestamptz not null default now(),
  unique (customer_id, period_start)
);
create index if not exists statements_period_idx on public.statements(period_start);
alter table public.statements enable row level security;
drop policy if exists "soa: active read" on public.statements;
create policy "soa: active read" on public.statements for select to authenticated using ((select public.is_active()));

-- Balance of a customer before a date (invoices [[U+2212]] payments [[U+2212]] approved credit/discount memos).
create or replace function public.balance_before(p_customer uuid, p_date date) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce((select sum(total_amount) from public.customer_invoices where customer_id = p_customer and invoice_date < p_date), 0)
       - coalesce((select sum(amount) from public.payments_received where customer_id = p_customer and paid_date < p_date), 0)
       - coalesce((select sum(request_amount) from public.credit_memos where customer_id = p_customer and status in ('approved','paid')
                   and requested_action in ('credit','discount') and approved_at::date < p_date), 0);
$$;

-- Creates any missing monthly statements up to the last complete month. Safe to call any time.
create or replace function public.generate_statements(p_customer uuid default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  c record;
  m date;
  first_m date;
  last_m date := (date_trunc('month', current_date) - interval '1 month')::date;
  stop_m date;
  nxt date;
  op numeric; deb numeric; cre numeric;
  made integer := 0;
begin
  if auth.uid() is not null and not public.is_active() then raise exception 'Not allowed'; end if;
  for c in select * from public.customers cu where cu.status in ('active','suspended','closed') and (p_customer is null or cu.id = p_customer) loop
    first_m := date_trunc('month', least(
      c.application_date,
      coalesce((select min(invoice_date) from public.customer_invoices where customer_id = c.id), c.application_date),
      coalesce((select min(paid_date) from public.payments_received where customer_id = c.id), c.application_date)))::date;
    stop_m := last_m;
    if c.status = 'closed' then
      stop_m := least(last_m, coalesce((select date_trunc('month', max(created_at))::date from public.customer_events where customer_id = c.id and action = 'close'), last_m));
    end if;
    m := first_m;
    while m <= stop_m loop
      nxt := (m + interval '1 month')::date;
      if not exists (select 1 from public.statements s where s.customer_id = c.id and s.period_start = m) then
        op := public.balance_before(c.id, m);
        deb := coalesce((select sum(total_amount) from public.customer_invoices where customer_id = c.id and invoice_date >= m and invoice_date < nxt), 0);
        cre := coalesce((select sum(amount) from public.payments_received where customer_id = c.id and paid_date >= m and paid_date < nxt), 0)
             + coalesce((select sum(request_amount) from public.credit_memos where customer_id = c.id and status in ('approved','paid')
                          and requested_action in ('credit','discount') and approved_at::date >= m and approved_at::date < nxt), 0);
        insert into public.statements (statement_no, customer_id, period_start, period_end, opening_balance, total_debit, total_credit, closing_balance)
        values ('SOA-' || to_char(m, 'YYYYMM') || '-' || c.account_no, c.id, m, (nxt - 1), op, deb, cre, op + deb - cre);
        made := made + 1;
      end if;
      m := nxt;
    end loop;
  end loop;
  return made;
end;
$$;
revoke execute on function public.balance_before(uuid, date) from public, anon;
grant execute on function public.balance_before(uuid, date) to authenticated;
revoke execute on function public.generate_statements(uuid) from public, anon;
grant execute on function public.generate_statements(uuid) to authenticated;

-- Run automatically at 00:05 on the 1st of each month (Manila time = UTC+8, so 16:05 UTC on the last day
-- would be midnight; we use 00:05 UTC on the 1st = 08:05 AM Manila). If pg_cron is not available,
-- the portal creates missing statements the next time someone opens the dashboard.
do $$
begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'emon-monthly-soa';
  perform cron.schedule('emon-monthly-soa', '5 0 1 * *', 'select public.generate_statements()');
exception when others then
  raise notice 'pg_cron not available (%); statements will be created when the portal is opened.', sqlerrm;
end $$;

-- ======== 004_update_1_1.sql ========
-- EMON OVERRUNS E-PORTAL [[U+2014]] Update 1.1
-- Usernames & presence, job positions and applications, employee termination and payslips,
-- community (30-day posts), messages, order letters, billing v2 (PHP [[U+2192]] BDT vouchers),
-- corrections (saved records are never edited; only the CEO deletes, permanently), customer Public and Private IDs
-- made from the customer's data, and public record verification.
-- Run once after 002 (and 003). Safe to run again.

-- =====================================================================
-- Helpers
-- =====================================================================
create or replace function public.notify_admins(p_title text, p_body text, p_link text) returns void
language sql security definer set search_path = '' as $$
  insert into public.notifications (user_id, title, body, link)
  select p.id, p_title, p_body, p_link from public.profiles p where p.role = 'admin' and p.status = 'active';
$$;
create or replace function public.notify_user(p_user uuid, p_title text, p_body text, p_link text) returns void
language sql security definer set search_path = '' as $$
  insert into public.notifications (user_id, title, body, link)
  select p_user, p_title, p_body, p_link where p_user is not null;
$$;
revoke execute on function public.notify_admins(text, text, text) from public, anon, authenticated;
revoke execute on function public.notify_user(uuid, text, text, text) from public, anon, authenticated;

-- Saved records are never edited, and only the CEO deletes them (see "Records are only added" at the end of this script).
-- Only the approval functions below may change a status, apply an approved correction or delete; they call this first.
create or replace function public.allow_record_change() returns void
language sql set search_path = '' as $$
  select set_config('eo.allow_change', 'on', true);
$$;
revoke execute on function public.allow_record_change() from public, anon, authenticated;

-- =====================================================================
-- Usernames, presence, sign-in by username
-- =====================================================================
alter table public.profiles add column if not exists username text;
alter table public.profiles add column if not exists last_seen_at timestamptz;
create unique index if not exists profiles_username_uq on public.profiles (lower(username)) where username is not null;

create or replace function public.touch_presence() returns void
language sql security definer set search_path = '' as $$
  update public.profiles set last_seen_at = now() where id = auth.uid();
$$;
create or replace function public.login_email(p_login text) returns text
language sql stable security definer set search_path = '' as $$
  select case when position('@' in coalesce(p_login, '')) > 0 then lower(trim(p_login))
              else (select lower(p.email) from public.profiles p where lower(p.username) = lower(trim(p_login)) limit 1) end;
$$;
create or replace function public.username_available(p_username text) returns boolean
language sql stable security definer set search_path = '' as $$
  select lower(trim(coalesce(p_username, ''))) ~ '^[a-z0-9._]{3,20}$'
     and not exists (select 1 from public.profiles p where lower(p.username) = lower(trim(p_username)));
$$;
create or replace function public.set_my_username(p_username text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.username_available(p_username) then raise exception 'That username is taken or not allowed (3-20 letters, numbers, dot or underscore)'; end if;
  update public.profiles set username = lower(trim(p_username)) where id = auth.uid();
end;
$$;
revoke execute on function public.touch_presence() from public, anon;
revoke execute on function public.set_my_username(text) from public, anon;
grant execute on function public.touch_presence() to authenticated;
grant execute on function public.set_my_username(text) to authenticated;
grant execute on function public.login_email(text) to anon, authenticated;
grant execute on function public.username_available(text) to anon, authenticated;

-- =====================================================================
-- Employees: salary, termination, link to job application
-- =====================================================================
alter table public.employees add column if not exists monthly_salary numeric(14,2) not null default 0;
alter table public.employees add column if not exists termination_date date;
alter table public.employees add column if not exists termination_reason text;
alter table public.employees add column if not exists job_application_id uuid;
alter table public.employees drop constraint if exists employees_status_check;
alter table public.employees add constraint employees_status_check check (status in ('waiting','active','inactive','terminated'));

create or replace function public.employees_sync_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.profile_id is not null then
    update public.profiles set
      role = new.role,
      modules = new.modules,
      full_name = case when lower(email) = 'emonoverruns@gmail.com' then 'EMON OVERRUNS' else trim(new.first_name || ' ' || new.last_name) end,
      status = case when new.status in ('inactive','terminated') then 'disabled' else 'active' end
    where id = new.profile_id;
  end if;
  return new;
end;
$$;

-- HR staff (menu access "employees") can see employees; admins manage them.
drop policy if exists "emp: admin or self read" on public.employees;
create policy "emp: admin or self read" on public.employees for select to authenticated
  using ((select public.is_admin()) or (select public.has_module('employees')) or profile_id = (select auth.uid()));

create or replace function public.terminate_employee(p_id uuid, p_date date, p_reason text) returns public.employees
language plpgsql security definer set search_path = '' as $$
declare e public.employees;
begin
  if not public.is_admin() then raise exception 'Only the CEO can do this'; end if;
  select * into e from public.employees where id = p_id for update;
  if e.id is null then raise exception 'Employee not found'; end if;
  if e.profile_id = auth.uid() then raise exception 'You cannot terminate your own account'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Enter the reason for termination'; end if;
  perform public.allow_record_change();
  update public.employees set status = 'terminated', termination_date = coalesce(p_date, current_date), termination_reason = p_reason
  where id = p_id returning * into e;
  perform public.notify_admins('Employee terminated: ' || e.first_name || ' ' || e.last_name, e.employee_no || ' [[U+2014]] ' || p_reason, 'employee/' || e.id);
  return e;
end;
$$;
create or replace function public.rehire_employee(p_id uuid) returns public.employees
language plpgsql security definer set search_path = '' as $$
declare e public.employees;
begin
  if not public.is_admin() then raise exception 'Only the CEO can do this'; end if;
  perform public.allow_record_change();
  update public.employees set status = case when profile_id is null then 'waiting' else 'active' end,
    termination_date = null, termination_reason = null
  where id = p_id returning * into e;
  if e.id is null then raise exception 'Employee not found'; end if;
  return e;
end;
$$;
-- Portal access (role, menu access, login on/off) is set here; personal details change only by an approved correction.
create or replace function public.set_employee_access(p_id uuid, p_role text, p_modules text[], p_status text default null) returns public.employees
language plpgsql security definer set search_path = '' as $$
declare e public.employees;
begin
  if not public.is_admin() then raise exception 'Only the CEO can do this'; end if;
  if p_role not in ('admin','staff','viewer') then raise exception 'Choose a role'; end if;
  select * into e from public.employees where id = p_id for update;
  if e.id is null then raise exception 'Employee not found'; end if;
  if e.profile_id = auth.uid() then raise exception 'You cannot change your own access'; end if;
  if p_status is not null and (p_status not in ('active','inactive') or e.status not in ('active','inactive')) then
    raise exception 'The login can only be switched between Active and Inactive';
  end if;
  perform public.allow_record_change();
  update public.employees set role = p_role, modules = coalesce(p_modules, '{}'), status = coalesce(p_status, status)
  where id = p_id returning * into e;
  return e;
end;
$$;
revoke execute on function public.terminate_employee(uuid, date, text) from public, anon;
revoke execute on function public.rehire_employee(uuid) from public, anon;
revoke execute on function public.set_employee_access(uuid, text, text[], text) from public, anon;
grant execute on function public.terminate_employee(uuid, date, text) to authenticated;
grant execute on function public.rehire_employee(uuid) to authenticated;
grant execute on function public.set_employee_access(uuid, text, text[], text) to authenticated;

-- New sign-ups: owner emails become admin; registered employees get their access; everyone else applies for a job.
-- The company's own login (emonoverruns@gmail.com) is named EMON OVERRUNS, so what it approves or records shows the
-- company name; a person's login shows the person's name.
update public.profiles set full_name = 'EMON OVERRUNS' where lower(email) = 'emonoverruns@gmail.com';
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  first_user boolean;
  emp public.employees;
  uname text;
  owner boolean;
begin
  select not exists (select 1 from public.profiles) into first_user;
  owner := first_user or lower(new.email) = 'emonoverruns@gmail.com';
  select * into emp from public.employees e where lower(e.email) = lower(new.email) and e.status <> 'terminated' limit 1;
  uname := lower(trim(new.raw_user_meta_data->>'username'));
  if uname is null or uname !~ '^[a-z0-9._]{3,20}$' or exists (select 1 from public.profiles p where lower(p.username) = uname) then
    uname := null;
  end if;
  insert into public.profiles (id, email, full_name, role, status, modules, username)
  values (
    new.id, new.email,
    case when lower(new.email) = 'emonoverruns@gmail.com' then 'EMON OVERRUNS'
         else coalesce(case when emp.id is not null then trim(emp.first_name || ' ' || emp.last_name) end, new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)) end,
    case when owner then 'admin' when emp.id is not null then emp.role else 'viewer' end,
    case when owner then 'active' when emp.id is not null then (case when emp.status = 'inactive' then 'disabled' else 'active' end) else 'pending' end,
    case when emp.id is not null and not owner then emp.modules end,
    uname
  );
  if emp.id is not null then
    update public.employees set profile_id = new.id, status = case when status = 'inactive' then 'inactive' else 'active' end where id = emp.id;
  end if;
  return new;
end;
$$;

-- =====================================================================
-- Job positions and job applications
-- =====================================================================
create table if not exists public.job_positions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  company_name text not null default 'EMON OVERRUNS',
  company_code text not null default 'EO',
  monthly_salary numeric(14,2) not null default 0,
  duty_hours text,
  description text,
  is_open boolean not null default true,
  created_at timestamptz not null default now()
);
create or replace function public.job_positions_normalize() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.company_code := upper(regexp_replace(coalesce(new.company_code, 'EO'), '[^A-Za-z]', '', 'g'));
  if new.company_code = '' then new.company_code := 'EO'; end if;
  new.company_code := left(new.company_code, 4);
  return new;
end;
$$;
drop trigger if exists job_positions_bi on public.job_positions;
create trigger job_positions_bi before insert or update on public.job_positions
  for each row execute function public.job_positions_normalize();
alter table public.job_positions enable row level security;
drop policy if exists "pos: read" on public.job_positions;
drop policy if exists "pos: admin write" on public.job_positions;
drop policy if exists "pos: admin insert" on public.job_positions;
create policy "pos: read" on public.job_positions for select to authenticated using (true);
create policy "pos: admin insert" on public.job_positions for insert to authenticated with check ((select public.is_admin()));
-- Positions are never edited or deleted; the admin opens or closes them for applications.
create or replace function public.set_position_open(p_id uuid, p_open boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Only the CEO can do this'; end if;
  perform public.allow_record_change();
  update public.job_positions set is_open = coalesce(p_open, false) where id = p_id;
  if not found then raise exception 'Position not found'; end if;
end;
$$;
revoke execute on function public.set_position_open(uuid, boolean) from public, anon;
grant execute on function public.set_position_open(uuid, boolean) to authenticated;

create table if not exists public.job_applications (
  id uuid primary key default gen_random_uuid(),
  application_no text unique,
  profile_id uuid references public.profiles(id) on delete set null default auth.uid(),
  position_id uuid references public.job_positions(id) on delete set null,
  position_title text not null,
  company_name text not null,
  company_code text,
  full_name text not null,
  phone text,
  email text,
  photo_path text,
  present_address text,
  permanent_address text,
  father_name text,
  mother_name text,
  spouse_name text,
  date_of_birth date,
  birth_place text,
  id_number text,
  gender text,
  religion text,
  blood_group text,
  education jsonb not null default '[]',
  experience jsonb not null default '[]',
  apply_salary numeric(14,2),
  apply_duty_hours text,
  apply_joining_date date,
  declaration boolean not null default false,
  status text not null default 'submitted' check (status in ('submitted','approved','rejected')),
  approval_no text,
  approved_at timestamptz,
  approved_by_name text,
  review_note text,
  employee_id uuid references public.employees(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists job_applications_profile_idx on public.job_applications(profile_id);
create index if not exists job_applications_position_idx on public.job_applications(position_id);
create index if not exists job_applications_employee_idx on public.job_applications(employee_id);

create or replace function public.job_applications_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare code text; ym text := to_char(current_date, 'YYYYMM');
begin
  if not public.is_admin() then new.profile_id := auth.uid(); end if;
  if new.profile_id is not null and exists (select 1 from public.job_applications j where j.profile_id = new.profile_id and j.status in ('submitted','approved')) then
    raise exception 'You already have a job application in progress';
  end if;
  if new.position_id is not null then
    select p.title, p.company_name, p.company_code into new.position_title, new.company_name, code from public.job_positions p where p.id = new.position_id;
  end if;
  code := upper(left(regexp_replace(coalesce(code, new.company_code, 'EO'), '[^A-Za-z]', '', 'g'), 4));
  if code = '' then code := 'EO'; end if;
  new.company_code := code;
  new.application_no := code || ym || lpad(public.next_counter('JA' || code || ym)::text, 2, '0');
  new.status := 'submitted';
  new.approval_no := null; new.approved_at := null; new.approved_by_name := null; new.review_note := null; new.employee_id := null;
  if new.email is null and new.profile_id is not null then select p.email into new.email from public.profiles p where p.id = new.profile_id; end if;
  return new;
end;
$$;
drop trigger if exists job_applications_bi on public.job_applications;
create trigger job_applications_bi before insert on public.job_applications
  for each row execute function public.job_applications_before_insert();

-- A submitted application is never edited (earlier drafts of 1.1 let the applicant edit it).
drop trigger if exists job_applications_bu on public.job_applications;
drop function if exists public.job_applications_before_update();

create or replace function public.job_applications_after_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.notify_admins('New job application ' || new.application_no, new.full_name || ' applied for ' || new.position_title || ' (' || new.company_name || ')', 'jobapp/' || new.id);
  return new;
end;
$$;
drop trigger if exists job_applications_ai on public.job_applications;
create trigger job_applications_ai after insert on public.job_applications
  for each row execute function public.job_applications_after_insert();

alter table public.job_applications enable row level security;
drop policy if exists "ja: read" on public.job_applications;
drop policy if exists "ja: insert" on public.job_applications;
drop policy if exists "ja: update" on public.job_applications;
drop policy if exists "ja: admin delete" on public.job_applications;
create policy "ja: read" on public.job_applications for select to authenticated
  using (profile_id = (select auth.uid()) or (select public.is_admin()) or (select public.has_module('employees')));
create policy "ja: insert" on public.job_applications for insert to authenticated
  with check (profile_id = (select auth.uid()) or (select public.is_admin()));
-- A submitted application is not edited; the applicant only adds the photo (once) right after submitting.
create or replace function public.set_application_photo(p_id uuid, p_path text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(p_path, '') !~ ('^job_application/' || p_id::text || '/') then raise exception 'Invalid photo'; end if;
  perform public.allow_record_change();
  update public.job_applications set photo_path = p_path
  where id = p_id and photo_path is null and status = 'submitted' and (profile_id = auth.uid() or public.is_admin());
  if not found then raise exception 'The photo can only be added once, while the application is under review'; end if;
end;
$$;
revoke execute on function public.set_application_photo(uuid, text) from public, anon;
grant execute on function public.set_application_photo(uuid, text) to authenticated;

-- Approve (creates or re-activates the employee with the chosen access) or reject.
create or replace function public.review_job_application(p_id uuid, p_action text, p_role text default 'staff', p_modules text[] default '{}', p_note text default null)
returns public.job_applications
language plpgsql security definer set search_path = '' as $$
declare
  a public.job_applications;
  me text;
  login_email text;
  emp_id uuid;
  fname text; lname text;
begin
  if not public.is_admin() then raise exception 'Only the CEO can review job applications'; end if;
  select * into a from public.job_applications where id = p_id for update;
  if a.id is null then raise exception 'Job application not found'; end if;
  if a.status <> 'submitted' then raise exception 'This application is already %', upper(a.status); end if;
  me := (select full_name from public.profiles where id = auth.uid());
  perform public.allow_record_change();
  if p_action = 'reject' then
    update public.job_applications set status = 'rejected', review_note = p_note, approved_by_name = me, approved_at = now() where id = p_id returning * into a;
    perform public.notify_user(a.profile_id, 'Job application ' || a.application_no || ' was not approved', coalesce(p_note, ''), 'dashboard');
    return a;
  end if;
  if p_action <> 'approve' then raise exception 'Unknown action %', p_action; end if;
  if p_role not in ('admin','staff','viewer') then raise exception 'Choose a role'; end if;
  if not exists (select 1 from public.attachments x where x.owner_type = 'job_application' and x.owner_id = p_id and x.kind = 'signed_form') then
    raise exception 'Upload the signed application form first';
  end if;
  login_email := lower(coalesce((select p.email from public.profiles p where p.id = a.profile_id), a.email));
  if login_email is null then raise exception 'This application has no email to link a login'; end if;
  fname := trim(regexp_replace(a.full_name, '\s+\S+\s*$', ''));
  lname := trim(substring(a.full_name from '(\S+)\s*$'));
  if fname = '' then fname := a.full_name; lname := ''; end if;
  select id into emp_id from public.employees where lower(email) = login_email;
  if emp_id is null then
    insert into public.employees (first_name, last_name, position, email, phone, address, date_hired, photo_path, role, modules, monthly_salary, job_application_id)
    values (fname, lname, a.position_title, login_email, a.phone, a.present_address, coalesce(a.apply_joining_date, current_date),
            a.photo_path, p_role, coalesce(p_modules, '{}'), coalesce(a.apply_salary, 0), a.id)
    returning id into emp_id;
  else
    update public.employees set first_name = fname, last_name = lname, position = a.position_title, phone = a.phone, address = a.present_address,
      date_hired = coalesce(a.apply_joining_date, current_date), photo_path = coalesce(a.photo_path, photo_path), role = p_role,
      modules = coalesce(p_modules, '{}'), monthly_salary = coalesce(a.apply_salary, monthly_salary), job_application_id = a.id,
      termination_date = null, termination_reason = null,
      profile_id = coalesce(profile_id, a.profile_id),
      status = case when coalesce(profile_id, a.profile_id) is null then 'waiting' else 'active' end
    where id = emp_id;
  end if;
  update public.job_applications set status = 'approved', review_note = p_note, approved_by_name = me, approved_at = now(), employee_id = emp_id,
    approval_no = 'A' || to_char(current_date, 'YYYY') || lpad(public.next_counter('APR' || to_char(current_date, 'YYYY'))::text, 4, '0')
  where id = p_id returning * into a;
  perform public.notify_user(a.profile_id, 'Your job application was approved', a.approval_no || ' [[U+2014]] welcome to ' || a.company_name || '. You can now use the portal.', 'dashboard');
  return a;
end;
$$;
revoke execute on function public.review_job_application(uuid, text, text, text[], text) from public, anon;
grant execute on function public.review_job_application(uuid, text, text, text[], text) to authenticated;

-- =====================================================================
-- Payslips: salary, advance, bonus
-- =====================================================================
create table if not exists public.payslips (
  id uuid primary key default gen_random_uuid(),
  payslip_no text unique,
  employee_id uuid not null references public.employees(id) on delete cascade,
  pay_type text not null default 'salary' check (pay_type in ('salary','advance','bonus','other')),
  period_month date not null default date_trunc('month', current_date)::date,
  pay_date date not null default current_date,
  basic_pay numeric(14,2) not null default 0 check (basic_pay >= 0),
  allowances numeric(14,2) not null default 0 check (allowances >= 0),
  overtime_pay numeric(14,2) not null default 0 check (overtime_pay >= 0),
  bonus numeric(14,2) not null default 0 check (bonus >= 0),
  advance_amount numeric(14,2) not null default 0 check (advance_amount >= 0),
  advance_deduction numeric(14,2) not null default 0 check (advance_deduction >= 0),
  other_deductions numeric(14,2) not null default 0 check (other_deductions >= 0),
  net_pay numeric(14,2) generated always as (basic_pay + allowances + overtime_pay + bonus + advance_amount - advance_deduction - other_deductions) stored,
  method text,
  reference_no text,
  notes text,
  created_by uuid references public.profiles(id) default auth.uid(),
  created_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists payslips_employee_idx on public.payslips(employee_id);
create index if not exists payslips_created_by_idx on public.payslips(created_by);
create or replace function public.payslips_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.employees e where e.id = new.employee_id and e.status <> 'terminated') then
    raise exception 'Payments can only be recorded for current employees';
  end if;
  new.period_month := date_trunc('month', coalesce(new.period_month, new.pay_date))::date;
  new.payslip_no := 'PS-' || to_char(new.pay_date, 'YYYYMM') || '-' || lpad(public.next_counter('PS' || to_char(new.pay_date, 'YYYYMM'))::text, 3, '0');
  new.created_by := auth.uid();
  new.created_by_name := (select full_name from public.profiles where id = auth.uid());
  return new;
end;
$$;
drop trigger if exists payslips_bi on public.payslips;
create trigger payslips_bi before insert on public.payslips
  for each row execute function public.payslips_before_insert();
alter table public.payslips enable row level security;
drop policy if exists "ps: read" on public.payslips;
drop policy if exists "ps: insert" on public.payslips;
create policy "ps: read" on public.payslips for select to authenticated
  using ((select public.is_admin()) or (select public.has_module('employees'))
         or exists (select 1 from public.employees e where e.id = employee_id and e.profile_id = (select auth.uid())));
create policy "ps: insert" on public.payslips for insert to authenticated with check ((select public.can_write('employees')));

-- =====================================================================
-- Community: posts and work photos, removed after 30 days
-- =====================================================================
create table if not exists public.community_posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid references public.profiles(id) on delete set null default auth.uid(),
  author_name text,
  author_position text,
  body text,
  photos text[] not null default '{}',
  created_at timestamptz not null default now(),
  constraint community_posts_not_empty check (coalesce(length(trim(body)), 0) > 0 or cardinality(photos) > 0)
);
create index if not exists community_posts_created_idx on public.community_posts(created_at desc);
create index if not exists community_posts_author_idx on public.community_posts(author_id);
create or replace function public.community_posts_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r text;
begin
  new.author_id := auth.uid();
  new.created_at := now();
  select p.full_name, p.role into new.author_name, r from public.profiles p where p.id = auth.uid();
  select e.position into new.author_position from public.employees e where e.profile_id = auth.uid() and e.status = 'active' limit 1;
  if new.author_position is null then
    new.author_position := case r when 'admin' then 'Managing Director' when 'staff' then 'Staff' else 'Member' end;
  end if;
  return new;
end;
$$;
drop trigger if exists community_posts_bi on public.community_posts;
create trigger community_posts_bi before insert on public.community_posts
  for each row execute function public.community_posts_before_insert();
alter table public.community_posts enable row level security;
drop policy if exists "cp: read" on public.community_posts;
drop policy if exists "cp: insert" on public.community_posts;
drop policy if exists "cp: delete" on public.community_posts;
create policy "cp: read" on public.community_posts for select to authenticated
  using ((select public.is_active()) and (created_at > now() - interval '30 days' or (select public.is_admin())));
create policy "cp: insert" on public.community_posts for insert to authenticated with check ((select public.is_active()));
create policy "cp: delete" on public.community_posts for delete to authenticated
  using (author_id = (select auth.uid()) or (select public.is_admin()));

-- =====================================================================
-- Messages between admin and employees
-- =====================================================================
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade default auth.uid(),
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  body text,
  file_path text,
  file_name text,
  file_mime text,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  constraint messages_not_empty check (coalesce(length(trim(body)), 0) > 0 or file_path is not null)
);
create index if not exists messages_pair_idx on public.messages(sender_id, recipient_id, created_at);
create index if not exists messages_recipient_idx on public.messages(recipient_id, read_at);
create or replace function public.messages_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.sender_id := auth.uid();
  new.read_at := null;
  new.created_at := now();
  return new;
end;
$$;
drop trigger if exists messages_bi on public.messages;
create trigger messages_bi before insert on public.messages
  for each row execute function public.messages_before_insert();
alter table public.messages enable row level security;
drop policy if exists "msg: read" on public.messages;
drop policy if exists "msg: send" on public.messages;
create policy "msg: read" on public.messages for select to authenticated
  using ((select public.is_active()) and (sender_id = (select auth.uid()) or recipient_id = (select auth.uid())));
-- Staff cannot read other people's profiles, so the recipient check runs as a helper.
create or replace function public.profile_is_active(p_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = p_id and p.status = 'active');
$$;
revoke execute on function public.profile_is_active(uuid) from public, anon;
grant execute on function public.profile_is_active(uuid) to authenticated;
create policy "msg: send" on public.messages for insert to authenticated
  with check ((select public.is_active()) and sender_id = (select auth.uid()) and public.profile_is_active(recipient_id));

create or replace function public.mark_messages_read(p_other uuid) returns void
language sql security definer set search_path = '' as $$
  update public.messages set read_at = now() where recipient_id = auth.uid() and sender_id = p_other and read_at is null;
$$;
create or replace function public.unread_messages_count() returns integer
language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.messages where recipient_id = auth.uid() and read_at is null;
$$;
-- Everyone active you can message, with presence, verified badge and unread count.
create or replace function public.chat_contacts()
returns table (id uuid, full_name text, role text, job_position text, avatar_path text, last_seen_at timestamptz, verified boolean, unread integer, last_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_active() then raise exception 'Not allowed'; end if;
  return query
  select p.id, p.full_name, p.role,
    coalesce(e.position, case p.role when 'admin' then 'Managing Director' when 'staff' then 'Staff' else 'Member' end),
    p.avatar_path, p.last_seen_at,
    (p.role = 'admin' or (e.id is not null and e.status = 'active' and (e.job_application_id is not null
       or exists (select 1 from public.attachments a where a.owner_type = 'employee' and a.owner_id = e.id and a.kind in ('signature','signed_form','application'))))),
    (select count(*)::int from public.messages m where m.sender_id = p.id and m.recipient_id = auth.uid() and m.read_at is null),
    (select max(m.created_at) from public.messages m where (m.sender_id = p.id and m.recipient_id = auth.uid()) or (m.sender_id = auth.uid() and m.recipient_id = p.id))
  from public.profiles p
  left join public.employees e on e.profile_id = p.id
  where p.status = 'active' and p.id <> auth.uid()
  order by 9 desc nulls last, 2;
end;
$$;
revoke execute on function public.mark_messages_read(uuid) from public, anon;
revoke execute on function public.unread_messages_count() from public, anon;
revoke execute on function public.chat_contacts() from public, anon;
grant execute on function public.mark_messages_read(uuid) to authenticated;
grant execute on function public.unread_messages_count() to authenticated;
grant execute on function public.chat_contacts() to authenticated;

-- =====================================================================
-- Order requests and order letters: the only way to suspend, close, reactivate or reopen an account.
--  * A request (suspend, close, unpaid notice, installment, [[U+2026]]) is carried out as soon as the CEO approves it.
--  * Reactivating a suspended account or reopening a closed one needs an approved order letter: its QR code
--    (or verification code) is scanned to carry it out.
-- =====================================================================
create table if not exists public.order_letters (
  id uuid primary key default gen_random_uuid(),
  order_no text unique,
  customer_id uuid references public.customers(id) on delete set null,
  order_date date not null default current_date,
  subject_type text not null check (subject_type in ('suspension','closure','reactivation','reopen','unpaid','installment','unsettled_balance','promise_to_pay','other')),
  subject text not null,
  details text,
  resolution text,
  amount numeric(14,2),
  installments integer,
  installment_amount numeric(14,2),
  first_due_date date,
  status text not null default 'pending',
  review_note text,
  approved_by uuid references public.profiles(id),
  approved_by_name text,
  approved_at timestamptz,
  applied_by_name text,
  applied_at timestamptz,
  applied_result text,
  created_by uuid references public.profiles(id) default auth.uid(),
  created_by_name text,
  created_at timestamptz not null default now()
);
alter table public.order_letters drop constraint if exists order_letters_subject_type_check;
alter table public.order_letters add constraint order_letters_subject_type_check check (subject_type in ('suspension','closure','reactivation','reopen','unpaid','installment','unsettled_balance','promise_to_pay','other'));
alter table public.order_letters drop constraint if exists order_letters_status_check;
alter table public.order_letters add constraint order_letters_status_check check (status in ('pending','approved','rejected','applied'));
create index if not exists order_letters_customer_idx on public.order_letters(customer_id);
create index if not exists order_letters_created_by_idx on public.order_letters(created_by);
create index if not exists order_letters_approved_by_idx on public.order_letters(approved_by);
create table if not exists public.order_letter_codes (
  order_id uuid primary key references public.order_letters(id) on delete cascade,
  code text not null
);
create or replace function public.order_letters_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.order_no := 'ORDER-' || to_char(new.order_date, 'YYYY') || '-' || lpad(public.next_counter('ORDER' || to_char(new.order_date, 'YYYY'))::text, 3, '0');
  new.status := 'pending';
  new.approved_by := null; new.approved_by_name := null; new.approved_at := null;
  new.applied_by_name := null; new.applied_at := null; new.applied_result := null;
  new.created_by := auth.uid();
  new.created_by_name := (select full_name from public.profiles where id = auth.uid());
  return new;
end;
$$;
drop trigger if exists order_letters_bi on public.order_letters;
create trigger order_letters_bi before insert on public.order_letters
  for each row execute function public.order_letters_before_insert();
create or replace function public.order_letters_after_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.notify_admins('Order ' || new.order_no || ' needs approval', new.subject, 'order/' || new.id);
  return new;
end;
$$;
drop trigger if exists order_letters_ai on public.order_letters;
create trigger order_letters_ai after insert on public.order_letters
  for each row execute function public.order_letters_after_insert();

alter table public.order_letters enable row level security;
alter table public.order_letter_codes enable row level security;
drop policy if exists "ol: read" on public.order_letters;
drop policy if exists "ol: insert" on public.order_letters;
drop policy if exists "olc: admin read" on public.order_letter_codes;
create policy "ol: read" on public.order_letters for select to authenticated using ((select public.is_active()));
create policy "ol: insert" on public.order_letters for insert to authenticated
  with check ((select public.can_write('orders')) or (select public.can_write('customers')));
create policy "olc: admin read" on public.order_letter_codes for select to authenticated using ((select public.is_admin()));

-- Internal: carry out an order on its account (status change for suspend / close / reactivate / reopen).
create or replace function public.carry_out_order(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  o public.order_letters;
  c public.customers;
  newst text;
  res text;
  me text := (select full_name from public.profiles where id = auth.uid());
begin
  select * into o from public.order_letters where id = p_id for update;
  perform public.allow_record_change();
  if o.customer_id is not null then
    select * into c from public.customers where id = o.customer_id for update;
    newst := case o.subject_type when 'suspension' then 'suspended' when 'closure' then 'closed' when 'reactivation' then 'active' when 'reopen' then 'active' else null end;
    if o.subject_type = 'suspension' and c.status <> 'active' then raise exception 'Account % is % [[U+2014]] only ACTIVE accounts can be suspended', c.account_no, upper(c.status); end if;
    if o.subject_type = 'closure' and c.status not in ('active','suspended') then raise exception 'Account % is % and cannot be closed', c.account_no, upper(c.status); end if;
    if o.subject_type = 'reactivation' and c.status <> 'suspended' then raise exception 'Account % is % [[U+2014]] only SUSPENDED accounts can be reactivated', c.account_no, upper(c.status); end if;
    if o.subject_type = 'reopen' and c.status <> 'closed' then raise exception 'Account % is % [[U+2014]] only CLOSED accounts can be reopened', c.account_no, upper(c.status); end if;
    if newst is not null then
      update public.customers set status = newst, status_note = o.order_no || ': ' || o.subject where id = c.id;
      res := 'Account ' || c.account_no || ' is now ' || upper(newst);
    else
      res := 'Order recorded on account ' || c.account_no;
    end if;
    insert into public.customer_events (customer_id, action, note, actor, actor_name)
    values (c.id, case o.subject_type when 'reopen' then 'reopened' else coalesce(newst, replace(o.subject_type, '_', ' ')) end || ' by ' || o.order_no, o.subject, auth.uid(), me);
  else
    res := 'Order carried out';
  end if;
  update public.order_letters set status = 'applied', applied_at = now(), applied_by_name = me, applied_result = res where id = o.id;
  return jsonb_build_object('order_no', o.order_no, 'result', res, 'status', newst);
end;
$$;
revoke execute on function public.carry_out_order(uuid) from public, anon, authenticated;

-- The CEO approves or rejects. A request is carried out straight away; a reactivation or reopening
-- order letter gets its verification code instead (carried out when the code is scanned).
create or replace function public.review_order_letter(p_id uuid, p_action text, p_note text default null) returns public.order_letters
language plpgsql security definer set search_path = '' as $$
declare o public.order_letters; me text; r jsonb;
begin
  if not public.is_admin() then raise exception 'Only the CEO can approve orders'; end if;
  select * into o from public.order_letters where id = p_id for update;
  if o.id is null then raise exception 'Order not found'; end if;
  if o.status <> 'pending' then raise exception 'This order is already %', upper(o.status); end if;
  me := (select full_name from public.profiles where id = auth.uid());
  perform public.allow_record_change();
  if p_action = 'approve' then
    update public.order_letters set status = 'approved', approved_by = auth.uid(), approved_by_name = me, approved_at = now(), review_note = p_note
    where id = p_id returning * into o;
    if o.subject_type in ('reactivation','reopen') then
      insert into public.order_letter_codes (order_id, code)
      values (p_id, upper(substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 8)))
      on conflict (order_id) do nothing;
      perform public.notify_user(o.created_by, 'Order letter ' || o.order_no || ' approved', o.subject, 'order/' || o.id);
    else
      r := public.carry_out_order(p_id);
      select * into o from public.order_letters where id = p_id;
      perform public.notify_user(o.created_by, 'Order ' || o.order_no || ' approved and carried out', r->>'result', 'order/' || o.id);
    end if;
  elsif p_action = 'reject' then
    update public.order_letters set status = 'rejected', approved_by = auth.uid(), approved_by_name = me, approved_at = now(), review_note = p_note
    where id = p_id returning * into o;
    perform public.notify_user(o.created_by, 'Order ' || o.order_no || ' rejected', coalesce(p_note, o.subject), 'order/' || o.id);
  else
    raise exception 'Unknown action %', p_action;
  end if;
  return o;
end;
$$;

-- Scanning the order letter's QR (or typing its number and code) carries out a reactivation or reopening.
create or replace function public.apply_order_letter(p_order_no text, p_code text, p_customer uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  o public.order_letters;
  k text;
begin
  if not (public.can_write('customers') or public.can_write('orders')) then raise exception 'You do not have permission to apply order letters'; end if;
  select * into o from public.order_letters where upper(order_no) = upper(trim(coalesce(p_order_no, ''))) for update;
  if o.id is null then raise exception 'Order letter % was not found', p_order_no; end if;
  if o.status = 'applied' then raise exception 'Order letter % was already applied on %', o.order_no, to_char(o.applied_at, 'DD Mon YYYY'); end if;
  if o.status <> 'approved' then raise exception 'Order letter % is not approved (status: %)', o.order_no, upper(o.status); end if;
  select x.code into k from public.order_letter_codes x where x.order_id = o.id;
  if k is null or upper(trim(coalesce(p_code, ''))) <> k then raise exception 'The verification code does not match order letter %', o.order_no; end if;
  if p_customer is not null and o.customer_id is distinct from p_customer then raise exception 'Order letter % is for a different account', o.order_no; end if;
  return public.carry_out_order(o.id);
end;
$$;
revoke execute on function public.review_order_letter(uuid, text, text) from public, anon;
revoke execute on function public.apply_order_letter(text, text, uuid) from public, anon;
grant execute on function public.review_order_letter(uuid, text, text) to authenticated;
grant execute on function public.apply_order_letter(text, text, uuid) to authenticated;

-- Suspend / close / reactivate / reopen go through orders (see above).
create or replace function public.customer_action(p_id uuid, p_action text, p_note text default null)
returns public.customers
language plpgsql security definer set search_path = '' as $$
declare
  c public.customers;
  new_status text;
begin
  if not public.is_admin() then raise exception 'Only the CEO can do this'; end if;
  if p_action in ('suspend','close','reactivate') then
    raise exception 'Use an approved order to suspend, close, reactivate or reopen an account';
  end if;
  select * into c from public.customers where id = p_id for update;
  if c.id is null then raise exception 'Customer not found'; end if;
  if c.status = 'closed' then raise exception 'This account is closed'; end if;
  new_status := case p_action
    when 'verify' then 'verified'
    when 'approve' then 'active'
    when 'reject' then 'rejected'
    when 'facebook_verified' then c.status
    when 'facebook_unverified' then c.status
    else null end;
  if new_status is null then raise exception 'Unknown action %', p_action; end if;
  if p_action = 'approve' and c.status not in ('pending','verified') then raise exception 'Only pending or verified applications can be approved'; end if;
  perform public.allow_record_change();
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

-- =====================================================================
-- Billing v2: companies [[U+2192]] accounts [[U+2192]] payment vouchers (PHP [[U+00D7]] rate = BDT)
-- =====================================================================
create table if not exists public.pay_companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  country text not null default 'Bangladesh',
  contact text,
  notes text,
  photo_path text,
  created_by uuid references public.profiles(id) default auth.uid(),
  created_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists pay_companies_created_by_idx on public.pay_companies(created_by);
create table if not exists public.pay_accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.pay_companies(id) on delete cascade,
  account_name text not null,
  account_number text,
  bank_name text,
  branch_name text,
  notes text,
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists pay_accounts_company_idx on public.pay_accounts(company_id);
create index if not exists pay_accounts_created_by_idx on public.pay_accounts(created_by);
create table if not exists public.pay_vouchers (
  id uuid primary key default gen_random_uuid(),
  voucher_no text unique,
  company_id uuid not null references public.pay_companies(id),
  account_id uuid references public.pay_accounts(id) on delete set null,
  pay_date date not null default current_date,
  amount_php numeric(14,2) not null check (amount_php > 0),
  exchange_rate numeric(12,4) not null check (exchange_rate > 0),
  amount_bdt numeric(16,2) generated always as (round(amount_php * exchange_rate, 2)) stored,
  purpose text,
  method text,
  reference_no text,
  notes text,
  created_by uuid references public.profiles(id) default auth.uid(),
  created_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists pay_vouchers_company_idx on public.pay_vouchers(company_id);
create index if not exists pay_vouchers_account_idx on public.pay_vouchers(account_id);
create index if not exists pay_vouchers_created_by_idx on public.pay_vouchers(created_by);

create or replace function public.pay_companies_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.created_by := auth.uid();
  new.created_by_name := (select full_name from public.profiles where id = auth.uid());
  return new;
end;
$$;
drop trigger if exists pay_companies_bi on public.pay_companies;
create trigger pay_companies_bi before insert on public.pay_companies
  for each row execute function public.pay_companies_before_insert();
create or replace function public.pay_vouchers_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.account_id is not null and not exists (select 1 from public.pay_accounts a where a.id = new.account_id and a.company_id = new.company_id) then
    raise exception 'That account belongs to a different company';
  end if;
  new.voucher_no := 'BD' || to_char(new.pay_date, 'YYYYMMDD') || lpad(public.next_counter('BD' || to_char(new.pay_date, 'YYYYMMDD'))::text, 3, '0');
  new.created_by := auth.uid();
  new.created_by_name := (select full_name from public.profiles where id = auth.uid());
  return new;
end;
$$;
drop trigger if exists pay_vouchers_bi on public.pay_vouchers;
create trigger pay_vouchers_bi before insert on public.pay_vouchers
  for each row execute function public.pay_vouchers_before_insert();

create or replace view public.pay_company_totals with (security_invoker = true) as
  select c.*,
    (select count(*) from public.pay_accounts a where a.company_id = c.id)::int as accounts_count,
    (select count(*) from public.pay_vouchers v where v.company_id = c.id)::int as vouchers_count,
    coalesce((select sum(v.amount_php) from public.pay_vouchers v where v.company_id = c.id), 0)::numeric(16,2) as total_php,
    coalesce((select sum(v.amount_bdt) from public.pay_vouchers v where v.company_id = c.id), 0)::numeric(16,2) as total_bdt,
    coalesce((select sum(v.amount_php) from public.pay_vouchers v where v.company_id = c.id and date_trunc('month', v.pay_date) = date_trunc('month', current_date)), 0)::numeric(16,2) as month_php,
    coalesce((select sum(v.amount_bdt) from public.pay_vouchers v where v.company_id = c.id and date_trunc('month', v.pay_date) = date_trunc('month', current_date)), 0)::numeric(16,2) as month_bdt,
    (select max(v.pay_date) from public.pay_vouchers v where v.company_id = c.id) as last_paid
  from public.pay_companies c;
revoke select on public.pay_company_totals from anon;

alter table public.pay_companies enable row level security;
alter table public.pay_accounts enable row level security;
alter table public.pay_vouchers enable row level security;
drop policy if exists "pc: read" on public.pay_companies;
drop policy if exists "pc: insert" on public.pay_companies;
drop policy if exists "pa: read" on public.pay_accounts;
drop policy if exists "pa: insert" on public.pay_accounts;
drop policy if exists "pv: read" on public.pay_vouchers;
drop policy if exists "pv: insert" on public.pay_vouchers;
create policy "pc: read" on public.pay_companies for select to authenticated using ((select public.has_module('billing')));
create policy "pc: insert" on public.pay_companies for insert to authenticated with check ((select public.can_write('billing')));
create policy "pa: read" on public.pay_accounts for select to authenticated using ((select public.has_module('billing')));
create policy "pa: insert" on public.pay_accounts for insert to authenticated with check ((select public.can_write('billing')));
create policy "pv: read" on public.pay_vouchers for select to authenticated using ((select public.has_module('billing')));
create policy "pv: insert" on public.pay_vouchers for insert to authenticated with check ((select public.can_write('billing')));

-- =====================================================================
-- Corrections, and permanent delete by the CEO
--  * Wrong details (a phone number, a reference) [[U+2192]] a CORRECTION record is added; it keeps the original values.
--    Staff send it to the CEO for approval; the CEO's own corrections are added straight away.
--  * A wrong record is deleted by the CEO: it is removed permanently, with its files, and is not shown anywhere.
--  * Nothing else edits or deletes a saved record (see "Records are only added" at the end of this script).
-- The CEO is the "admin" role.
-- =====================================================================

-- Earlier drafts of 1.1 had cancel records and admin edit/delete functions.
drop function if exists public.admin_update_record(text, uuid, jsonb, text);
drop function if exists public.admin_delete_record(text, uuid, text);
drop function if exists public.submit_change_request(text, uuid, jsonb, text, text, text);
drop function if exists public.apply_record_cancel(text, uuid, text, text, text);
drop function if exists public.cancellable_table(text);
drop function if exists public.void_fields(text, timestamptz, text);
drop function if exists public.records_insert_clean() cascade;

-- Approval steps change only the status of a record, never its details.
create or replace function public.credit_memo_action(p_id uuid, p_action text, p_note text default null)
returns public.credit_memos
language plpgsql security definer set search_path = '' as $$
declare m public.credit_memos; me text;
begin
  if not public.is_admin() then raise exception 'Only the CEO can do this'; end if;
  select * into m from public.credit_memos where id = p_id for update;
  if m.id is null then raise exception 'Credit memo not found'; end if;
  me := (select full_name from public.profiles where id = auth.uid());
  perform public.allow_record_change();
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
create or replace function public.project_action(p_id uuid, p_action text, p_note text default null)
returns public.projects
language plpgsql security definer set search_path = '' as $$
declare pr public.projects; me text;
begin
  if not public.is_admin() then raise exception 'Only the CEO can do this'; end if;
  select * into pr from public.projects where id = p_id for update;
  if pr.id is null then raise exception 'Project not found'; end if;
  me := (select full_name from public.profiles where id = auth.uid());
  perform public.allow_record_change();
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

-- Statements of account: a closed account's statements stop at the month it was closed
-- (also when it was closed by an order letter).
create or replace function public.generate_statements(p_customer uuid default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  c record;
  m date;
  first_m date;
  last_m date := (date_trunc('month', current_date) - interval '1 month')::date;
  stop_m date;
  nxt date;
  op numeric; deb numeric; cre numeric;
  made integer := 0;
begin
  if auth.uid() is not null and not public.is_active() then raise exception 'Not allowed'; end if;
  for c in select * from public.customers cu where cu.status in ('active','suspended','closed') and (p_customer is null or cu.id = p_customer) loop
    first_m := date_trunc('month', least(
      c.application_date,
      coalesce((select min(invoice_date) from public.customer_invoices where customer_id = c.id), c.application_date),
      coalesce((select min(paid_date) from public.payments_received where customer_id = c.id), c.application_date)))::date;
    stop_m := last_m;
    if c.status = 'closed' then
      stop_m := least(last_m, coalesce((select date_trunc('month', max(created_at))::date from public.customer_events
                                        where customer_id = c.id and (action = 'close' or action like 'closed by %')), last_m));
    end if;
    m := first_m;
    while m <= stop_m loop
      nxt := (m + interval '1 month')::date;
      if not exists (select 1 from public.statements s where s.customer_id = c.id and s.period_start = m) then
        op := public.balance_before(c.id, m);
        deb := coalesce((select sum(total_amount) from public.customer_invoices where customer_id = c.id and invoice_date >= m and invoice_date < nxt), 0);
        cre := coalesce((select sum(amount) from public.payments_received where customer_id = c.id and paid_date >= m and paid_date < nxt), 0)
             + coalesce((select sum(request_amount) from public.credit_memos where customer_id = c.id and status in ('approved','paid')
                          and requested_action in ('credit','discount') and approved_at::date >= m and approved_at::date < nxt), 0);
        insert into public.statements (statement_no, customer_id, period_start, period_end, opening_balance, total_debit, total_credit, closing_balance)
        values ('SOA-' || to_char(m, 'YYYYMM') || '-' || c.account_no, c.id, m, (nxt - 1), op, deb, cre, op + deb - cre);
        made := made + 1;
      end if;
      m := nxt;
    end loop;
  end loop;
  return made;
end;
$$;

-- Details that can be corrected. Amounts, transaction dates and record numbers are never corrected:
-- a wrong money record is deleted by the CEO and recorded again.
create or replace function public.editable_columns(p_table text) returns text[]
language sql immutable set search_path = '' as $$
  select case p_table
    when 'customers' then array['first_name','last_name','phone','email','address','business_name','business_start_date','facebook_name','has_extra_facebook','extra_facebook_name','facebook_verified']
    when 'customer_invoices' then array['purchase_date','po_number','total_boxes','total_pcs']
    when 'payments_received' then array['method','bank_name','bank_account','reference_no','notes']
    when 'credit_memos' then array['payment_ref','po_number','article','brand','style','batch_no','serial_no','purchase_date','defect_category','defect_detail','assigned_by','inspection_notes','factory_status']
    when 'employees' then array['first_name','last_name','position','phone','address','date_hired','monthly_salary']
    when 'payslips' then array['method','reference_no','notes']
    when 'projects' then array['title','description','location','start_date','end_date']
    when 'project_payments' then array['received_by','method','reference_no','notes']
    when 'pay_companies' then array['name','country','contact','notes']
    when 'pay_accounts' then array['account_name','account_number','bank_name','branch_name','notes']
    when 'pay_vouchers' then array['purpose','method','reference_no','notes']
    when 'job_applications' then array['full_name','phone','email','present_address','permanent_address','father_name','mother_name','spouse_name','date_of_birth','birth_place','id_number','gender','religion','blood_group','apply_salary','apply_duty_hours','apply_joining_date']
    else null end;
$$;
-- Records the CEO can delete.
create or replace function public.deletable_table(p_table text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(p_table in ('customers','customer_invoices','payments_received','credit_memos','order_letters','employees','payslips',
                              'projects','project_payments','pay_companies','pay_accounts','pay_vouchers','job_applications','job_positions'), false);
$$;
-- Who may see (and so ask to correct) each kind of record.
create or replace function public.can_see_table(p_table text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when p_table in ('employees','payslips','job_applications') then public.is_admin() or public.has_module('employees')
    when p_table in ('pay_companies','pay_accounts','pay_vouchers') then public.has_module('billing')
    when p_table in ('projects','project_payments') then public.has_module('projects')
    else public.is_active() end;
$$;

create table if not exists public.change_requests (
  id uuid primary key default gen_random_uuid(),
  request_no text unique,
  target_table text not null,
  target_id uuid not null,
  target_label text,
  changes jsonb not null,
  previous jsonb,
  reason text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  review_note text,
  reviewed_by_name text,
  reviewed_at timestamptz,
  requested_by uuid references public.profiles(id) default auth.uid(),
  requested_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists change_requests_target_idx on public.change_requests(target_table, target_id);
create index if not exists change_requests_requested_by_idx on public.change_requests(requested_by);
create table if not exists public.record_changes (
  id bigint generated always as identity primary key,
  target_table text not null,
  target_id uuid not null,
  action text not null,
  changes jsonb,
  previous jsonb,
  request_no text,
  target_label text,
  actor uuid references public.profiles(id) on delete set null,
  actor_name text,
  created_at timestamptz not null default now()
);
create index if not exists record_changes_target_idx on public.record_changes(target_table, target_id);
create index if not exists record_changes_actor_idx on public.record_changes(actor);
alter table public.change_requests enable row level security;
alter table public.record_changes enable row level security;
drop policy if exists "cr: read" on public.change_requests;
drop policy if exists "rc: read" on public.record_changes;
-- Only the CEO sees correction records; staff only send requests.
create policy "cr: read" on public.change_requests for select to authenticated using ((select public.is_admin()));
create policy "rc: read" on public.record_changes for select to authenticated using ((select public.is_admin()));

-- Internal: put approved corrected details on the record and return the values they replace.
create or replace function public.apply_record_changes(p_table text, p_id uuid, p_changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  cols text[] := public.editable_columns(p_table);
  k text;
  setlist text := '';
  old jsonb;
begin
  if cols is null then raise exception 'This kind of record cannot be corrected'; end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then raise exception 'Nothing to correct'; end if;
  for k in select jsonb_object_keys(p_changes) loop
    if not (k = any(cols)) then raise exception 'The field "%" cannot be corrected', k; end if;
    setlist := setlist || case when setlist = '' then '' else ', ' end || format('%I = r.%I', k, k);
  end loop;
  execute format('select to_jsonb(t) from public.%I t where t.id = $1 for update', p_table) into old using p_id;
  if old is null then raise exception 'Record not found'; end if;
  perform public.allow_record_change();
  execute format('update public.%I t set %s from jsonb_populate_record(null::public.%I, $1) r where t.id = $2', p_table, setlist, p_table)
    using p_changes, p_id;
  return (select jsonb_object_agg(x, old -> x) from jsonb_object_keys(p_changes) x);
end;
$$;

-- Internal: the portal page of a record (staff are told about their requests there).
create or replace function public.record_link(p_table text, p_id uuid) returns text
language sql stable set search_path = '' as $$
  select coalesce(case p_table
    when 'customers' then 'customer/' || p_id when 'customer_invoices' then 'invoice/' || p_id when 'payments_received' then 'payment/' || p_id
    when 'credit_memos' then 'creditmemo/' || p_id when 'employees' then 'employee/' || p_id when 'payslips' then 'payslip/' || p_id
    when 'projects' then 'project/' || p_id when 'pay_companies' then 'paycompany/' || p_id when 'pay_vouchers' then 'voucher/' || p_id
    when 'job_applications' then 'jobapp/' || p_id when 'order_letters' then 'order/' || p_id
    when 'project_payments' then (select 'project/' || x.project_id from public.project_payments x where x.id = p_id)
    when 'pay_accounts' then (select 'paycompany/' || x.company_id from public.pay_accounts x where x.id = p_id)
    end, 'dashboard');
$$;
revoke execute on function public.record_link(text, uuid) from public, anon, authenticated;

-- Internal: approve (add the correction record) or reject a request.
create or replace function public.decide_change_request(p_id uuid, p_action text, p_note text) returns public.change_requests
language plpgsql security definer set search_path = '' as $$
declare cr public.change_requests; me text; prev jsonb;
begin
  select * into cr from public.change_requests where id = p_id for update;
  if cr.id is null then raise exception 'Request not found'; end if;
  if cr.status <> 'pending' then raise exception 'This request is already %', upper(cr.status); end if;
  me := (select full_name from public.profiles where id = auth.uid());
  perform public.allow_record_change();
  if p_action = 'approve' then
    prev := public.apply_record_changes(cr.target_table, cr.target_id, cr.changes);
    insert into public.record_changes (target_table, target_id, action, changes, previous, request_no, target_label, actor, actor_name)
    values (cr.target_table, cr.target_id, 'correction', cr.changes, prev, cr.request_no, cr.target_label, auth.uid(), me);
    update public.change_requests set status = 'approved', previous = prev, review_note = p_note, reviewed_by_name = me, reviewed_at = now()
    where id = p_id returning * into cr;
    if cr.requested_by is distinct from auth.uid() then
      perform public.notify_user(cr.requested_by, 'Correction ' || cr.request_no || ' approved', coalesce(cr.target_label, cr.target_table), public.record_link(cr.target_table, cr.target_id));
    end if;
  elsif p_action = 'reject' then
    update public.change_requests set status = 'rejected', review_note = p_note, reviewed_by_name = me, reviewed_at = now() where id = p_id returning * into cr;
    perform public.notify_user(cr.requested_by, 'Correction ' || cr.request_no || ' rejected', coalesce(p_note, ''), public.record_link(cr.target_table, cr.target_id));
  else
    raise exception 'Unknown action %', p_action;
  end if;
  return cr;
end;
$$;

create or replace function public.submit_change_request(p_table text, p_id uuid, p_changes jsonb, p_reason text, p_label text default null)
returns public.change_requests
language plpgsql security definer set search_path = '' as $$
declare
  cols text[] := public.editable_columns(p_table);
  k text;
  old jsonb;
  cr public.change_requests;
begin
  if not public.is_active() then raise exception 'Not allowed'; end if;
  if cols is null then raise exception 'This kind of record cannot be corrected'; end if;
  if not public.can_see_table(p_table) then raise exception 'You do not have access to this kind of record'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Write the reason'; end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then raise exception 'Nothing to correct'; end if;
  for k in select jsonb_object_keys(p_changes) loop
    if not (k = any(cols)) then raise exception 'The field "%" cannot be corrected', k; end if;
  end loop;
  execute format('select to_jsonb(t) from public.%I t where t.id = $1', p_table) into old using p_id;
  if old is null then raise exception 'Record not found'; end if;
  insert into public.change_requests (request_no, target_table, target_id, target_label, changes, previous, reason, requested_by, requested_by_name)
  values ('CR-' || to_char(current_date, 'YYYY') || '-' || lpad(public.next_counter('CR' || to_char(current_date, 'YYYY'))::text, 4, '0'),
          p_table, p_id, p_label, p_changes, (select jsonb_object_agg(x, old -> x) from jsonb_object_keys(p_changes) x),
          trim(p_reason), auth.uid(), (select full_name from public.profiles where id = auth.uid()))
  returning * into cr;
  -- The CEO's own correction is added straight away.
  if public.is_admin() then
    return public.decide_change_request(cr.id, 'approve', null);
  end if;
  perform public.notify_admins('Correction request ' || cr.request_no, coalesce(p_label, p_table) || ' [[U+2014]] ' || trim(p_reason), 'changes');
  return cr;
end;
$$;

create or replace function public.review_change_request(p_id uuid, p_action text, p_note text default null) returns public.change_requests
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Only the CEO can approve corrections'; end if;
  return public.decide_change_request(p_id, p_action, p_note);
end;
$$;

-- The CEO deletes a record permanently, with its files and its corrections. A record that other records
-- depend on is deleted after them (for example an invoice after its payments). Statements of account from
-- that month on are made again without the deleted record. Returns the file paths for the app to remove.
create or replace function public.delete_record(p_table text, p_id uuid) returns text[]
language plpgsql security definer set search_path = '' as $$
declare
  j jsonb;
  own_type text;
  paths text[];
  cust uuid;
  since date;
  subs uuid[] := '{}';
begin
  if not public.is_admin() then raise exception 'Only the CEO can delete records'; end if;
  if not public.deletable_table(p_table) then raise exception 'This kind of record cannot be deleted'; end if;
  execute format('select to_jsonb(t) from public.%I t where t.id = $1 for update', p_table) into j using p_id;
  if j is null then raise exception 'Record not found'; end if;
  if p_table = 'customers' and (exists (select 1 from public.customer_invoices x where x.customer_id = p_id)
      or exists (select 1 from public.payments_received x where x.customer_id = p_id)
      or exists (select 1 from public.credit_memos x where x.customer_id = p_id)
      or exists (select 1 from public.order_letters x where x.customer_id = p_id)) then
    raise exception 'This customer has invoices, payments, credit memos or order letters. Delete those first';
  end if;
  if p_table = 'customer_invoices' and exists (select 1 from public.payments_received x where x.invoice_id = p_id) then
    raise exception 'This invoice has payments. Delete its payments first';
  end if;
  if p_table = 'employees' then
    if (j->>'profile_id')::uuid = auth.uid() then raise exception 'You cannot delete your own employee record'; end if;
    if exists (select 1 from public.payslips x where x.employee_id = p_id) then raise exception 'This employee has payslips. Delete the payslips first'; end if;
  end if;
  if p_table = 'projects' and exists (select 1 from public.project_payments x where x.project_id = p_id) then
    raise exception 'This project has payments. Delete its payments first';
  end if;
  if p_table = 'pay_companies' and exists (select 1 from public.pay_vouchers x where x.company_id = p_id) then
    raise exception 'This company has payment vouchers. Delete the vouchers first';
  end if;
  if p_table = 'pay_accounts' and exists (select 1 from public.pay_vouchers x where x.account_id = p_id) then
    raise exception 'This account has payment vouchers. Delete the vouchers first';
  end if;
  perform public.allow_record_change();

  -- Files: the record's own, a customer's statement copies, a company's account files, and stored photos.
  own_type := case p_table when 'customers' then 'customer' when 'customer_invoices' then 'invoice' when 'payments_received' then 'payment'
    when 'credit_memos' then 'credit_memo' when 'employees' then 'employee' when 'payslips' then 'payslip' when 'projects' then 'project'
    when 'project_payments' then 'project_payment' when 'pay_companies' then 'pay_company' when 'pay_accounts' then 'pay_account'
    when 'pay_vouchers' then 'pay_voucher' when 'job_applications' then 'job_application' when 'order_letters' then 'order_letter' end;
  if p_table = 'customers' then subs := array(select s.id from public.statements s where s.customer_id = p_id); end if;
  if p_table = 'pay_companies' then subs := array(select a.id from public.pay_accounts a where a.company_id = p_id); end if;
  select coalesce(array_agg(a.storage_path), '{}') into paths from public.attachments a
    where (a.owner_type = own_type and a.owner_id = p_id) or a.owner_id = any(subs);
  delete from public.attachments a where (a.owner_type = own_type and a.owner_id = p_id) or a.owner_id = any(subs);
  if j->>'photo_path' is not null then paths := paths || (j->>'photo_path'); end if;

  -- A customer money record changes the statements of account from its month on.
  if p_table in ('customer_invoices','payments_received','credit_memos') then
    cust := (j->>'customer_id')::uuid;
    since := date_trunc('month', case p_table when 'customer_invoices' then (j->>'invoice_date')::date
               when 'payments_received' then (j->>'paid_date')::date
               else coalesce((j->>'approved_at')::timestamptz::date, (j->>'memo_date')::date) end)::date;
  end if;
  if p_table = 'employees' and j->>'profile_id' is not null then
    update public.profiles set status = 'disabled' where id = (j->>'profile_id')::uuid;
  end if;

  delete from public.change_requests where target_table = p_table and target_id = p_id;
  delete from public.record_changes where target_table = p_table and target_id = p_id;
  execute format('delete from public.%I where id = $1', p_table) using p_id;

  if cust is not null then
    select paths || coalesce(array_agg(a.storage_path), '{}') into paths from public.attachments a
      where a.owner_type = 'statement' and a.owner_id in (select s.id from public.statements s where s.customer_id = cust and s.period_end >= since);
    delete from public.attachments a
      where a.owner_type = 'statement' and a.owner_id in (select s.id from public.statements s where s.customer_id = cust and s.period_end >= since);
    delete from public.statements s where s.customer_id = cust and s.period_end >= since;
    perform public.generate_statements(cust);
  end if;
  return paths;
end;
$$;

revoke execute on function public.apply_record_changes(text, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.decide_change_request(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.deletable_table(text) from public, anon;
revoke execute on function public.can_see_table(text) from public, anon;
grant execute on function public.deletable_table(text) to authenticated;
grant execute on function public.can_see_table(text) to authenticated;
revoke execute on function public.submit_change_request(text, uuid, jsonb, text, text) from public, anon;
revoke execute on function public.review_change_request(uuid, text, text) from public, anon;
revoke execute on function public.delete_record(text, uuid) from public, anon;
grant execute on function public.submit_change_request(text, uuid, jsonb, text, text) to authenticated;
grant execute on function public.review_change_request(uuid, text, text) to authenticated;
grant execute on function public.delete_record(text, uuid) to authenticated;
revoke execute on function public.generate_statements(uuid) from public, anon;
grant execute on function public.generate_statements(uuid) to authenticated;
revoke execute on function public.credit_memo_action(uuid, text, text) from public, anon;
grant execute on function public.credit_memo_action(uuid, text, text) to authenticated;
revoke execute on function public.project_action(uuid, text, text) from public, anon;
grant execute on function public.project_action(uuid, text, text) to authenticated;

-- =====================================================================
-- Customer Public ID and Private ID, made from all of the customer's data
--  * Public ID  = EO + the first 10 characters of the SHA-256 fingerprint of the whole application record.
--  * Private ID = a fingerprint of the same data sealed with a secret key that never leaves the database,
--    so it cannot be worked out from the data. Only admins can read it (customer_secrets).
-- =====================================================================
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table if not exists private.app_secrets (k text primary key, v text not null);
revoke all on private.app_secrets from public, anon, authenticated;
insert into private.app_secrets (k, v)
values ('customer_id_key', md5(gen_random_uuid()::text || clock_timestamp()::text) || md5(gen_random_uuid()::text || random()::text))
on conflict (k) do nothing;

create or replace function public.customer_public_id(p_data jsonb) returns text
language plpgsql stable security definer set search_path = '' as $$
declare h text; n int := 0;
begin
  loop
    h := 'EO' || upper(left(encode(sha256(convert_to(p_data::text || case when n > 0 then '#' || n else '' end, 'UTF8')), 'hex'), 10));
    exit when not exists (select 1 from public.customers c where c.public_id = h);
    n := n + 1;
  end loop;
  return h;
end;
$$;
create or replace function public.customer_private_id(p_data jsonb) returns text
language sql stable security definer set search_path = '' as $$
  select regexp_replace(upper(left(encode(sha256(convert_to(k.v || '|' || p_data::text || '|' || k.v, 'UTF8')), 'hex'), 12)), '(.{4})(?!$)', '\1-', 'g')
  from private.app_secrets k where k.k = 'customer_id_key';
$$;
revoke execute on function public.customer_public_id(jsonb) from public, anon, authenticated;
revoke execute on function public.customer_private_id(jsonb) from public, anon, authenticated;

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
  new.status := 'pending';
  new.issued_by := auth.uid();
  new.issued_by_name := (select full_name from public.profiles where id = auth.uid());
  new.reviewed_by := null;
  new.reviewed_at := null;
  new.facebook_verified := coalesce(new.facebook_verified, false);
  new.public_id := public.customer_public_id(to_jsonb(new) - 'public_id');
  return new;
end;
$$;
create or replace function public.customers_after_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.customer_secrets (customer_id, private_code)
  values (new.id, public.customer_private_id(to_jsonb(new)));
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
-- Customers saved before this update get their IDs made the same way, once.
do $$
begin
  if not exists (select 1 from private.app_secrets where k = 'customer_ids_made') then
    perform set_config('eo.allow_change', 'on', true);
    update public.customers c set public_id = public.customer_public_id(to_jsonb(c) - 'public_id');
    update public.customer_secrets s set private_code = public.customer_private_id(to_jsonb(c))
      from public.customers c where c.id = s.customer_id;
    insert into private.app_secrets (k, v) values ('customer_ids_made', now()::text);
  end if;
end $$;

-- =====================================================================
-- Public verification: anyone can check a record number, QR or barcode
-- =====================================================================
create or replace function public.verify_record(p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  raw text := trim(coalesce(p_code, ''));
  cands text[];
  c text;
  r record;
  amt text;
begin
  if raw = '' then return jsonb_build_object('found', false); end if;
  if raw ~* '#verify/' then raw := regexp_replace(raw, '^.*#verify/', '', 'i'); end if;
  raw := split_part(split_part(raw, '?', 1), '&', 1);
  cands := array(
    select distinct upper(trim(x)) from unnest(string_to_array(raw, '|')) x
    where trim(x) <> '' and upper(trim(x)) not in ('EMON','EMONCUST','EMONINV','EMONPAY','EMONCM','EMONPRJ','EMONSP','EMONPS','EMONBD','ORDER','EMONJA','EMONSOA'));
  foreach c in array cands loop
    -- customer account (account no, application no or public ID)
    select * into r from public.customers cu where upper(cu.account_no) = c or upper(cu.application_no) = c or upper(cu.public_id) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Customer Account', 'number', r.account_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Account Name', r.first_name || ' ' || r.last_name), jsonb_build_array('Account No', r.account_no),
          jsonb_build_array('Application No', r.application_no), jsonb_build_array('Public ID', r.public_id),
          jsonb_build_array('Opened', to_char(r.application_date, 'DD Mon YYYY')), jsonb_build_array('Account Status', upper(r.status))));
    end if;
    select i.*, cu.first_name, cu.last_name, cu.account_no as acct,
      coalesce((select sum(p.amount) from public.payments_received p where p.invoice_id = i.id), 0) as paid
      into r from public.customer_invoices i join public.customers cu on cu.id = i.customer_id where upper(i.invoice_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Invoice', 'number', r.invoice_no,
        'status', case when r.paid >= r.total_amount then 'paid' when r.paid > 0 then 'partial' else 'unpaid' end,
        'fields', jsonb_build_array(
          jsonb_build_array('Invoice No', r.invoice_no), jsonb_build_array('Customer', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Account No', r.acct), jsonb_build_array('Invoice Date', to_char(r.invoice_date, 'DD Mon YYYY')),
          jsonb_build_array('PO Number', coalesce(r.po_number, '[[U+2014]]')), jsonb_build_array('Boxes / Pcs', r.total_boxes || ' / ' || r.total_pcs),
          jsonb_build_array('Amount (PHP)', to_char(r.total_amount, 'FM999,999,999,990.00')),
          jsonb_build_array('Paid (PHP)', to_char(r.paid, 'FM999,999,999,990.00'))));
    end if;
    select p.*, cu.first_name, cu.last_name, cu.account_no as acct, i.invoice_no as inv
      into r from public.payments_received p join public.customers cu on cu.id = p.customer_id left join public.customer_invoices i on i.id = p.invoice_id
      where upper(p.receipt_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Payment Receipt', 'number', r.receipt_no, 'status', 'received',
        'fields', jsonb_build_array(
          jsonb_build_array('Receipt No', r.receipt_no), jsonb_build_array('Received From', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Account No', r.acct), jsonb_build_array('Date Paid', to_char(r.paid_date, 'DD Mon YYYY')),
          jsonb_build_array('Amount (PHP)', to_char(r.amount, 'FM999,999,999,990.00')), jsonb_build_array('Method', replace(r.method, '_', ' ')),
          jsonb_build_array('Reference', coalesce(r.reference_no, '[[U+2014]]')), jsonb_build_array('Invoice', coalesce(r.inv, 'General payment')),
          jsonb_build_array('Verified By', coalesce(r.created_by_name, '[[U+2014]]'))));
    end if;
    select m.*, cu.first_name, cu.last_name, cu.account_no as acct
      into r from public.credit_memos m join public.customers cu on cu.id = m.customer_id where upper(m.memo_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Credit Memo', 'number', r.memo_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Report No', r.memo_no), jsonb_build_array('Customer', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Customer ID', r.acct), jsonb_build_array('Date', to_char(r.memo_date, 'DD Mon YYYY')),
          jsonb_build_array('Request', replace(r.requested_action, '_', ' ')), jsonb_build_array('Amount (PHP)', to_char(r.request_amount, 'FM999,999,999,990.00')),
          jsonb_build_array('Status', upper(r.status))));
    end if;
    select s.*, cu.first_name, cu.last_name, cu.account_no as acct
      into r from public.statements s join public.customers cu on cu.id = s.customer_id where upper(s.statement_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Statement of Account', 'number', r.statement_no, 'status', 'issued',
        'fields', jsonb_build_array(
          jsonb_build_array('Statement No', r.statement_no), jsonb_build_array('Customer', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Account No', r.acct), jsonb_build_array('Period', to_char(r.period_start, 'DD Mon YYYY') || ' [[U+2013]] ' || to_char(r.period_end, 'DD Mon YYYY')),
          jsonb_build_array('Opening (PHP)', to_char(r.opening_balance, 'FM999,999,999,990.00')),
          jsonb_build_array('Closing (PHP)', to_char(r.closing_balance, 'FM999,999,999,990.00'))));
    end if;
    select o.*, cu.first_name, cu.last_name, cu.account_no as acct
      into r from public.order_letters o left join public.customers cu on cu.id = o.customer_id where upper(o.order_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Order Letter', 'number', r.order_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Order No', r.order_no), jsonb_build_array('Date', to_char(r.order_date, 'DD Mon YYYY')),
          jsonb_build_array('Account', coalesce(r.first_name || ' ' || r.last_name || ' (' || r.acct || ')', '[[U+2014]]')),
          jsonb_build_array('Subject', r.subject), jsonb_build_array('Type', initcap(replace(r.subject_type, '_', ' '))),
          jsonb_build_array('Status', upper(r.status)), jsonb_build_array('Approved By', coalesce(r.approved_by_name, '[[U+2014]]'))));
    end if;
    select v.*, pc.name as company, pa.account_name, pa.account_number, pa.bank_name
      into r from public.pay_vouchers v join public.pay_companies pc on pc.id = v.company_id left join public.pay_accounts pa on pa.id = v.account_id
      where upper(v.voucher_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Payment Voucher', 'number', r.voucher_no, 'status', 'paid',
        'fields', jsonb_build_array(
          jsonb_build_array('Voucher No', r.voucher_no), jsonb_build_array('Paid To', r.company),
          jsonb_build_array('Account', coalesce(r.account_name || ' ' || coalesce(r.account_number, '') || ' ' || coalesce(r.bank_name, ''), '[[U+2014]]')),
          jsonb_build_array('Date', to_char(r.pay_date, 'DD Mon YYYY')),
          jsonb_build_array('Amount (PHP)', to_char(r.amount_php, 'FM999,999,999,990.00')),
          jsonb_build_array('Exchange Rate', to_char(r.exchange_rate, 'FM999,990.0000')),
          jsonb_build_array('Amount (BDT)', to_char(r.amount_bdt, 'FM999,999,999,990.00')),
          jsonb_build_array('Issued By', coalesce(r.created_by_name, '[[U+2014]]'))));
    end if;
    select s.*, e.first_name, e.last_name, e.employee_no, e.position
      into r from public.payslips s join public.employees e on e.id = s.employee_id where upper(s.payslip_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Payslip', 'number', r.payslip_no, 'status', 'paid',
        'fields', jsonb_build_array(
          jsonb_build_array('Payslip No', r.payslip_no), jsonb_build_array('Employee', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Employee No', r.employee_no), jsonb_build_array('Type', initcap(r.pay_type)),
          jsonb_build_array('Period', to_char(r.period_month, 'FMMonth YYYY')), jsonb_build_array('Pay Date', to_char(r.pay_date, 'DD Mon YYYY')),
          jsonb_build_array('Net Pay (PHP)', to_char(r.net_pay, 'FM999,999,999,990.00'))));
    end if;
    select * into r from public.job_applications j where upper(j.application_no) = c or upper(j.approval_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Job Application', 'number', r.application_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Application No', r.application_no), jsonb_build_array('Applicant', r.full_name),
          jsonb_build_array('Position', r.position_title), jsonb_build_array('Company', r.company_name),
          jsonb_build_array('Submitted', to_char(r.created_at, 'DD Mon YYYY')), jsonb_build_array('Status', upper(r.status)),
          jsonb_build_array('Approval No', coalesce(r.approval_no, '[[U+2014]]'))));
    end if;
    select * into r from public.employees e where upper(e.employee_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Employee', 'number', r.employee_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Employee No', r.employee_no), jsonb_build_array('Name', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Position', coalesce(r.position, '[[U+2014]]')), jsonb_build_array('Status', upper(r.status))));
    end if;
    select * into r from public.projects p where upper(p.project_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Project', 'number', r.project_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Project No', r.project_no), jsonb_build_array('Title', r.title),
          jsonb_build_array('Total Cost (PHP)', to_char(r.total_cost, 'FM999,999,999,990.00')), jsonb_build_array('Status', upper(r.status))));
    end if;
    select x.*, p.project_no, p.title into r from public.project_payments x join public.projects p on p.id = x.project_id where upper(x.payment_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Project Payment', 'number', r.payment_no, 'status', 'paid',
        'fields', jsonb_build_array(
          jsonb_build_array('Payment No', r.payment_no), jsonb_build_array('Project', r.project_no || ' [[U+2014]] ' || r.title),
          jsonb_build_array('Date', to_char(r.pay_date, 'DD Mon YYYY')), jsonb_build_array('Amount (PHP)', to_char(r.amount, 'FM999,999,999,990.00')),
          jsonb_build_array('Received By', r.received_by)));
    end if;
    select * into r from public.documents d where upper(d.doc_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Document', 'number', r.doc_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Document No', r.doc_no), jsonb_build_array('Party', r.party_name),
          jsonb_build_array('Date', to_char(r.doc_date, 'DD Mon YYYY')), jsonb_build_array('Amount (PHP)', to_char(r.amount, 'FM999,999,999,990.00')),
          jsonb_build_array('Status', upper(r.status))));
    end if;
  end loop;
  return jsonb_build_object('found', false, 'code', raw);
end;
$$;
grant execute on function public.verify_record(text) to anon, authenticated;

-- =====================================================================
-- Files: new record types, applicants' own uploads, chat and community photos
-- =====================================================================
alter table public.attachments drop constraint if exists attachments_owner_type_check;
alter table public.attachments add constraint attachments_owner_type_check check (owner_type in
  ('customer','invoice','payment','credit_memo','employee','resolution','project','project_payment','supplier','supplier_payment','statement',
   'job_application','payslip','order_letter','pay_company','pay_account','pay_voucher'));

drop policy if exists "att: active read" on public.attachments;
create policy "att: active read" on public.attachments for select to authenticated using (
  ((select public.is_active()) and (owner_type not in ('employee','job_application','payslip') or (select public.is_admin()) or (select public.has_module('employees'))))
  or (owner_type = 'job_application' and exists (select 1 from public.job_applications j where j.id = owner_id and j.profile_id = (select auth.uid())))
  or (owner_type = 'payslip' and exists (select 1 from public.payslips s join public.employees e on e.id = s.employee_id where s.id = owner_id and e.profile_id = (select auth.uid())))
  or (owner_type = 'employee' and exists (select 1 from public.employees e where e.id = owner_id and e.profile_id = (select auth.uid())))
);
drop policy if exists "att: staff insert" on public.attachments;
create policy "att: staff insert" on public.attachments for insert to authenticated with check (
  (select public.is_staff())
  or (owner_type = 'job_application' and exists (select 1 from public.job_applications j where j.id = owner_id and j.profile_id = (select auth.uid())))
);

drop policy if exists "storage records: active read" on storage.objects;
create policy "storage records: active read" on storage.objects for select to authenticated using (
  bucket_id = 'records' and (
    ((select public.is_active()) and ((storage.foldername(name))[1] not in ('employee','job_application','payslip') or (select public.is_admin()) or (select public.has_module('employees'))))
    or ((storage.foldername(name))[1] = 'job_application' and exists (select 1 from public.job_applications j where j.id::text = (storage.foldername(name))[2] and j.profile_id = (select auth.uid())))
    or ((storage.foldername(name))[1] = 'employee' and exists (select 1 from public.employees e where e.id::text = (storage.foldername(name))[2] and e.profile_id = (select auth.uid())))
    or ((storage.foldername(name))[1] = 'payslip' and exists (select 1 from public.payslips s join public.employees e on e.id = s.employee_id where s.id::text = (storage.foldername(name))[2] and e.profile_id = (select auth.uid())))
  ));
drop policy if exists "storage records: staff upload" on storage.objects;
create policy "storage records: staff upload" on storage.objects for insert to authenticated with check (
  bucket_id = 'records' and (
    (select public.is_staff())
    or ((storage.foldername(name))[1] in ('chat','community') and (select public.is_active()))
    or ((storage.foldername(name))[1] = 'job_application' and exists (select 1 from public.job_applications j where j.id::text = (storage.foldername(name))[2] and j.profile_id = (select auth.uid())))
  ));

-- =====================================================================
-- Grants for internal trigger functions
-- =====================================================================
revoke execute on function public.job_positions_normalize() from public, anon, authenticated;
revoke execute on function public.job_applications_before_insert() from public, anon, authenticated;
revoke execute on function public.job_applications_after_insert() from public, anon, authenticated;
revoke execute on function public.payslips_before_insert() from public, anon, authenticated;
revoke execute on function public.community_posts_before_insert() from public, anon, authenticated;
revoke execute on function public.messages_before_insert() from public, anon, authenticated;
revoke execute on function public.order_letters_before_insert() from public, anon, authenticated;
revoke execute on function public.order_letters_after_insert() from public, anon, authenticated;
revoke execute on function public.pay_companies_before_insert() from public, anon, authenticated;
revoke execute on function public.pay_vouchers_before_insert() from public, anon, authenticated;
revoke execute on function public.editable_columns(text) from public, anon;

-- Community posts disappear after 30 days (daily clean-up at 00:15 UTC = 08:15 Manila).
do $$
begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'emon-community-cleanup';
  perform cron.schedule('emon-community-cleanup', '15 0 * * *', $q$delete from public.community_posts where created_at < now() - interval '30 days'$q$);
exception when others then
  raise notice 'pg_cron not available (%); old community posts are hidden after 30 days and removed when the CEO opens Community.', sqlerrm;
end $$;

-- =====================================================================
-- Records are only added
-- Saved records are never edited, and only the CEO deletes them (permanently, with delete_record).
-- Only the approval steps above (status changes and approved corrections) may change a saved row.
-- =====================================================================
create or replace function public.keep_records() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- Allowed: an approval step of this portal, or a change made by the database itself (inside another trigger).
  if pg_trigger_depth() > 1 or current_setting('eo.allow_change', true) = 'on' then
    return case when tg_level = 'STATEMENT' then null when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'Saved records cannot be edited or deleted. Add a correction instead (the CEO can delete a record).';
end;
$$;
revoke execute on function public.keep_records() from public, anon, authenticated;
do $$
declare t text;
begin
  foreach t in array array['customers','customer_secrets','customer_events','customer_invoices','payments_received','credit_memos','statements',
                           'employees','job_positions','job_applications','payslips','order_letters','order_letter_codes',
                           'pay_companies','pay_accounts','pay_vouchers','projects','project_items','project_payments',
                           'attachments','change_requests','record_changes'] loop
    execute format('drop trigger if exists keep_records on public.%I', t);
    execute format('create trigger keep_records before update or delete on public.%I for each row execute function public.keep_records()', t);
    execute format('drop trigger if exists keep_records_truncate on public.%I', t);
    execute format('create trigger keep_records_truncate before truncate on public.%I for each statement execute function public.keep_records()', t);
  end loop;
end $$;

-- Remove the old direct edit / delete permissions.
drop policy if exists "customers: admin update" on public.customers;
drop policy if exists "inv: admin delete" on public.customer_invoices;
drop policy if exists "pay: admin delete" on public.payments_received;
drop policy if exists "att: admin delete" on public.attachments;
drop policy if exists "emp: admin update" on public.employees;
drop policy if exists "emp: admin delete" on public.employees;
-- Uploaded files are removed only by the CEO (with a deleted record, or old community photos).
drop policy if exists "storage records: admin delete" on storage.objects;
create policy "storage records: admin delete" on storage.objects for delete to authenticated
  using (bucket_id = 'records' and (select public.is_admin()));

-- ======== 005_update_1_2.sql ========
-- =====================================================================
-- EMON OVERRUNS E-PORTAL [[U+2014]] Update 1.2
-- Orders for customers, employees and billing companies. Every order is carried out as soon as the CEO
-- approves it; there is no verification code any more.
-- Run once in the Supabase SQL Editor after 004_update_1_1.sql. It is safe to run again.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Employees can be suspended: the login is closed until an order reactivates them.
-- ---------------------------------------------------------------------
alter table public.employees drop constraint if exists employees_status_check;
alter table public.employees add constraint employees_status_check check (status in ('waiting','active','inactive','suspended','terminated'));

create or replace function public.employees_sync_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.profile_id is not null then
    update public.profiles set
      role = new.role,
      modules = new.modules,
      full_name = case when lower(email) = 'emonoverruns@gmail.com' then 'EMON OVERRUNS' else trim(new.first_name || ' ' || new.last_name) end,
      status = case when new.status in ('inactive','suspended','terminated') then 'disabled' else 'active' end
    where id = new.profile_id;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Billing companies can be suspended: no new payment vouchers until an order reactivates them.
-- ---------------------------------------------------------------------
alter table public.pay_companies add column if not exists status text not null default 'active';
alter table public.pay_companies add column if not exists status_note text;
alter table public.pay_companies drop constraint if exists pay_companies_status_check;
alter table public.pay_companies add constraint pay_companies_status_check check (status in ('active','suspended'));

create or replace function public.pay_companies_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.status := 'active';
  new.status_note := null;
  new.created_by := auth.uid();
  new.created_by_name := (select full_name from public.profiles where id = auth.uid());
  return new;
end;
$$;

create or replace function public.pay_vouchers_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.pay_companies c where c.id = new.company_id and c.status <> 'active') then
    raise exception 'This company is SUSPENDED. New payments are blocked until it is reactivated by an approved order';
  end if;
  if new.account_id is not null and not exists (select 1 from public.pay_accounts a where a.id = new.account_id and a.company_id = new.company_id) then
    raise exception 'That account belongs to a different company';
  end if;
  new.voucher_no := 'BD' || to_char(new.pay_date, 'YYYYMMDD') || lpad(public.next_counter('BD' || to_char(new.pay_date, 'YYYYMMDD'))::text, 3, '0');
  new.created_by := auth.uid();
  new.created_by_name := (select full_name from public.profiles where id = auth.uid());
  return new;
end;
$$;

-- The totals view lists every company column, so it is made again to include the status.
drop view if exists public.pay_company_totals;
create view public.pay_company_totals with (security_invoker = true) as
  select c.*,
    (select count(*) from public.pay_accounts a where a.company_id = c.id)::int as accounts_count,
    (select count(*) from public.pay_vouchers v where v.company_id = c.id)::int as vouchers_count,
    coalesce((select sum(v.amount_php) from public.pay_vouchers v where v.company_id = c.id), 0)::numeric(16,2) as total_php,
    coalesce((select sum(v.amount_bdt) from public.pay_vouchers v where v.company_id = c.id), 0)::numeric(16,2) as total_bdt,
    coalesce((select sum(v.amount_php) from public.pay_vouchers v where v.company_id = c.id and date_trunc('month', v.pay_date) = date_trunc('month', current_date)), 0)::numeric(16,2) as month_php,
    coalesce((select sum(v.amount_bdt) from public.pay_vouchers v where v.company_id = c.id and date_trunc('month', v.pay_date) = date_trunc('month', current_date)), 0)::numeric(16,2) as month_bdt,
    (select max(v.pay_date) from public.pay_vouchers v where v.company_id = c.id) as last_paid
  from public.pay_companies c;
revoke all on public.pay_company_totals from anon;
grant select on public.pay_company_totals to authenticated;

-- ---------------------------------------------------------------------
-- Order letters: for one customer, employee or billing company
--   customer: suspension, closure, reactivation, reopen, unpaid, installment, unsettled balance, promise to pay, other
--   employee: suspension, reactivation, termination, memo
--   company:  suspension, reactivation, memo
-- ---------------------------------------------------------------------
alter table public.order_letters add column if not exists employee_id uuid references public.employees(id) on delete set null;
alter table public.order_letters add column if not exists company_id uuid references public.pay_companies(id) on delete set null;
create index if not exists order_letters_employee_idx on public.order_letters(employee_id);
create index if not exists order_letters_company_idx on public.order_letters(company_id);
alter table public.order_letters drop constraint if exists order_letters_subject_type_check;
alter table public.order_letters add constraint order_letters_subject_type_check check (subject_type in
  ('suspension','closure','reactivation','reopen','termination','memo','unpaid','installment','unsettled_balance','promise_to_pay','other'));
alter table public.order_letters drop constraint if exists order_letters_one_subject;
alter table public.order_letters add constraint order_letters_one_subject check (num_nonnulls(customer_id, employee_id, company_id) <= 1);

create or replace function public.order_letters_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare kind text;
begin
  if num_nonnulls(new.customer_id, new.employee_id, new.company_id) <> 1 then
    raise exception 'Choose one customer, employee or company for this order';
  end if;
  kind := case when new.employee_id is not null then 'employee' when new.company_id is not null then 'company' else 'customer' end;
  if kind = 'employee' and new.subject_type not in ('suspension','reactivation','termination','memo') then
    raise exception 'An employee order is a suspension, reactivation, termination or memo';
  end if;
  if kind = 'company' and new.subject_type not in ('suspension','reactivation','memo') then
    raise exception 'A company order is a suspension, reactivation or memo';
  end if;
  if kind = 'customer' and new.subject_type in ('termination','memo') then
    raise exception 'This order cannot be made for a customer';
  end if;
  new.order_no := 'ORDER-' || to_char(new.order_date, 'YYYY') || '-' || lpad(public.next_counter('ORDER' || to_char(new.order_date, 'YYYY'))::text, 3, '0');
  new.status := 'pending';
  new.approved_by := null; new.approved_by_name := null; new.approved_at := null;
  new.applied_by_name := null; new.applied_at := null; new.applied_result := null;
  new.created_by := auth.uid();
  new.created_by_name := (select full_name from public.profiles where id = auth.uid());
  return new;
end;
$$;

-- Customer orders are seen by everyone signed in (as before) and requested by order-letter or customer staff.
-- Employee orders: the CEO and HR staff, and the employee once approved. Company orders: the CEO and billing staff.
drop policy if exists "ol: read" on public.order_letters;
drop policy if exists "ol: insert" on public.order_letters;
create policy "ol: read" on public.order_letters for select to authenticated using (
  (employee_id is null and company_id is null and (select public.is_active()))
  or (employee_id is not null and ((select public.is_admin()) or (select public.has_module('employees'))
      or (status in ('approved','applied') and exists (select 1 from public.employees e where e.id = employee_id and e.profile_id = (select auth.uid())))))
  or (company_id is not null and ((select public.is_admin()) or (select public.has_module('billing')))));
create policy "ol: insert" on public.order_letters for insert to authenticated with check (
  (customer_id is not null and ((select public.can_write('orders')) or (select public.can_write('customers'))))
  or (employee_id is not null and (select public.can_write('employees')))
  or (company_id is not null and (select public.can_write('billing'))));

-- Internal: carry out an approved order on its customer, employee or company.
create or replace function public.carry_out_order(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  o public.order_letters;
  c public.customers;
  e public.employees;
  pc public.pay_companies;
  newst text;
  res text;
  me text := (select full_name from public.profiles where id = auth.uid());
begin
  select * into o from public.order_letters where id = p_id for update;
  perform public.allow_record_change();
  if o.customer_id is not null then
    select * into c from public.customers where id = o.customer_id for update;
    newst := case o.subject_type when 'suspension' then 'suspended' when 'closure' then 'closed' when 'reactivation' then 'active' when 'reopen' then 'active' else null end;
    if o.subject_type = 'suspension' and c.status <> 'active' then raise exception 'Account % is % [[U+2014]] only ACTIVE accounts can be suspended', c.account_no, upper(c.status); end if;
    if o.subject_type = 'closure' and c.status not in ('active','suspended') then raise exception 'Account % is % and cannot be closed', c.account_no, upper(c.status); end if;
    if o.subject_type = 'reactivation' and c.status <> 'suspended' then raise exception 'Account % is % [[U+2014]] only SUSPENDED accounts can be reactivated', c.account_no, upper(c.status); end if;
    if o.subject_type = 'reopen' and c.status <> 'closed' then raise exception 'Account % is % [[U+2014]] only CLOSED accounts can be reopened', c.account_no, upper(c.status); end if;
    if newst is not null then
      update public.customers set status = newst, status_note = o.order_no || ': ' || o.subject where id = c.id;
      res := 'Account ' || c.account_no || ' is now ' || upper(newst);
    else
      res := 'Order recorded on account ' || c.account_no;
    end if;
    insert into public.customer_events (customer_id, action, note, actor, actor_name)
    values (c.id, case o.subject_type when 'reopen' then 'reopened' else coalesce(newst, replace(o.subject_type, '_', ' ')) end || ' by ' || o.order_no, o.subject, auth.uid(), me);
  elsif o.employee_id is not null then
    select * into e from public.employees where id = o.employee_id for update;
    if o.subject_type <> 'memo' and e.profile_id = auth.uid() then raise exception 'You cannot suspend, reactivate or terminate your own employee record'; end if;
    if o.subject_type = 'suspension' then
      if e.status not in ('active','inactive') then raise exception 'Employee % is % [[U+2014]] only ACTIVE employees can be suspended', e.employee_no, upper(e.status); end if;
      newst := 'suspended';
    elsif o.subject_type = 'reactivation' then
      if e.status <> 'suspended' then raise exception 'Employee % is % [[U+2014]] only SUSPENDED employees can be reactivated', e.employee_no, upper(e.status); end if;
      newst := case when e.profile_id is null then 'waiting' else 'active' end;
    elsif o.subject_type = 'termination' then
      if e.status = 'terminated' then raise exception 'Employee % is already TERMINATED', e.employee_no; end if;
      newst := 'terminated';
    end if;
    if newst = 'terminated' then
      update public.employees set status = 'terminated', termination_date = current_date, termination_reason = o.order_no || ': ' || o.subject where id = e.id;
    elsif newst is not null then
      update public.employees set status = newst where id = e.id;
    end if;
    res := case when newst is null then 'Memo recorded for employee ' || e.employee_no else 'Employee ' || e.employee_no || ' is now ' || upper(newst) end;
  elsif o.company_id is not null then
    select * into pc from public.pay_companies where id = o.company_id for update;
    if o.subject_type = 'suspension' then
      if pc.status <> 'active' then raise exception '% is % [[U+2014]] only ACTIVE companies can be suspended', pc.name, upper(pc.status); end if;
      newst := 'suspended';
    elsif o.subject_type = 'reactivation' then
      if pc.status <> 'suspended' then raise exception '% is % [[U+2014]] only SUSPENDED companies can be reactivated', pc.name, upper(pc.status); end if;
      newst := 'active';
    end if;
    if newst is not null then
      update public.pay_companies set status = newst, status_note = o.order_no || ': ' || o.subject where id = pc.id;
      res := pc.name || ' is now ' || upper(newst);
    else
      res := 'Memo recorded for ' || pc.name;
    end if;
  else
    res := 'Order carried out';
  end if;
  update public.order_letters set status = 'applied', applied_at = now(), applied_by_name = me, applied_result = res where id = o.id;
  return jsonb_build_object('order_no', o.order_no, 'result', res, 'status', newst);
end;
$$;
revoke execute on function public.carry_out_order(uuid) from public, anon, authenticated;

-- The CEO approves (the order is carried out at once) or rejects.
create or replace function public.review_order_letter(p_id uuid, p_action text, p_note text default null) returns public.order_letters
language plpgsql security definer set search_path = '' as $$
declare o public.order_letters; me text; r jsonb;
begin
  if not public.is_admin() then raise exception 'Only the CEO can approve orders'; end if;
  select * into o from public.order_letters where id = p_id for update;
  if o.id is null then raise exception 'Order not found'; end if;
  if o.status <> 'pending' then raise exception 'This order is already %', upper(o.status); end if;
  me := (select full_name from public.profiles where id = auth.uid());
  perform public.allow_record_change();
  if p_action = 'approve' then
    update public.order_letters set status = 'approved', approved_by = auth.uid(), approved_by_name = me, approved_at = now(), review_note = p_note
    where id = p_id returning * into o;
    r := public.carry_out_order(p_id);
    select * into o from public.order_letters where id = p_id;
    if o.created_by is distinct from auth.uid() then
      perform public.notify_user(o.created_by, 'Order ' || o.order_no || ' approved and carried out', r->>'result', 'order/' || o.id);
    end if;
  elsif p_action = 'reject' then
    update public.order_letters set status = 'rejected', approved_by = auth.uid(), approved_by_name = me, approved_at = now(), review_note = p_note
    where id = p_id returning * into o;
    perform public.notify_user(o.created_by, 'Order ' || o.order_no || ' rejected', coalesce(p_note, o.subject), 'order/' || o.id);
  else
    raise exception 'Unknown action %', p_action;
  end if;
  return o;
end;
$$;
revoke execute on function public.review_order_letter(uuid, text, text) from public, anon;
grant execute on function public.review_order_letter(uuid, text, text) to authenticated;

-- Order letters no longer carry a verification code.
drop function if exists public.apply_order_letter(text, text, uuid);

-- ---------------------------------------------------------------------
-- The CEO's permanent delete: an employee or company with order letters is deleted after its letters.
-- ---------------------------------------------------------------------
create or replace function public.delete_record(p_table text, p_id uuid) returns text[]
language plpgsql security definer set search_path = '' as $$
declare
  j jsonb;
  own_type text;
  paths text[];
  cust uuid;
  since date;
  subs uuid[] := '{}';
begin
  if not public.is_admin() then raise exception 'Only the CEO can delete records'; end if;
  if not public.deletable_table(p_table) then raise exception 'This kind of record cannot be deleted'; end if;
  execute format('select to_jsonb(t) from public.%I t where t.id = $1 for update', p_table) into j using p_id;
  if j is null then raise exception 'Record not found'; end if;
  if p_table = 'customers' and (exists (select 1 from public.customer_invoices x where x.customer_id = p_id)
      or exists (select 1 from public.payments_received x where x.customer_id = p_id)
      or exists (select 1 from public.credit_memos x where x.customer_id = p_id)
      or exists (select 1 from public.order_letters x where x.customer_id = p_id)) then
    raise exception 'This customer has invoices, payments, credit memos or order letters. Delete those first';
  end if;
  if p_table = 'customer_invoices' and exists (select 1 from public.payments_received x where x.invoice_id = p_id) then
    raise exception 'This invoice has payments. Delete its payments first';
  end if;
  if p_table = 'employees' then
    if (j->>'profile_id')::uuid = auth.uid() then raise exception 'You cannot delete your own employee record'; end if;
    if exists (select 1 from public.payslips x where x.employee_id = p_id) then raise exception 'This employee has payslips. Delete the payslips first'; end if;
    if exists (select 1 from public.order_letters x where x.employee_id = p_id) then raise exception 'This employee has order letters. Delete the order letters first'; end if;
  end if;
  if p_table = 'projects' and exists (select 1 from public.project_payments x where x.project_id = p_id) then
    raise exception 'This project has payments. Delete its payments first';
  end if;
  if p_table = 'pay_companies' and exists (select 1 from public.pay_vouchers x where x.company_id = p_id) then
    raise exception 'This company has payment vouchers. Delete the vouchers first';
  end if;
  if p_table = 'pay_companies' and exists (select 1 from public.order_letters x where x.company_id = p_id) then
    raise exception 'This company has order letters. Delete the order letters first';
  end if;
  if p_table = 'pay_accounts' and exists (select 1 from public.pay_vouchers x where x.account_id = p_id) then
    raise exception 'This account has payment vouchers. Delete the vouchers first';
  end if;
  perform public.allow_record_change();

  -- Files: the record's own, a customer's statement copies, a company's account files, and stored photos.
  own_type := case p_table when 'customers' then 'customer' when 'customer_invoices' then 'invoice' when 'payments_received' then 'payment'
    when 'credit_memos' then 'credit_memo' when 'employees' then 'employee' when 'payslips' then 'payslip' when 'projects' then 'project'
    when 'project_payments' then 'project_payment' when 'pay_companies' then 'pay_company' when 'pay_accounts' then 'pay_account'
    when 'pay_vouchers' then 'pay_voucher' when 'job_applications' then 'job_application' when 'order_letters' then 'order_letter' end;
  if p_table = 'customers' then subs := array(select s.id from public.statements s where s.customer_id = p_id); end if;
  if p_table = 'pay_companies' then subs := array(select a.id from public.pay_accounts a where a.company_id = p_id); end if;
  select coalesce(array_agg(a.storage_path), '{}') into paths from public.attachments a
    where (a.owner_type = own_type and a.owner_id = p_id) or a.owner_id = any(subs);
  delete from public.attachments a where (a.owner_type = own_type and a.owner_id = p_id) or a.owner_id = any(subs);
  if j->>'photo_path' is not null then paths := paths || (j->>'photo_path'); end if;

  -- A customer money record changes the statements of account from its month on.
  if p_table in ('customer_invoices','payments_received','credit_memos') then
    cust := (j->>'customer_id')::uuid;
    since := date_trunc('month', case p_table when 'customer_invoices' then (j->>'invoice_date')::date
               when 'payments_received' then (j->>'paid_date')::date
               else coalesce((j->>'approved_at')::timestamptz::date, (j->>'memo_date')::date) end)::date;
  end if;
  if p_table = 'employees' and j->>'profile_id' is not null then
    update public.profiles set status = 'disabled' where id = (j->>'profile_id')::uuid;
  end if;

  delete from public.change_requests where target_table = p_table and target_id = p_id;
  delete from public.record_changes where target_table = p_table and target_id = p_id;
  execute format('delete from public.%I where id = $1', p_table) using p_id;

  if cust is not null then
    select paths || coalesce(array_agg(a.storage_path), '{}') into paths from public.attachments a
      where a.owner_type = 'statement' and a.owner_id in (select s.id from public.statements s where s.customer_id = cust and s.period_end >= since);
    delete from public.attachments a
      where a.owner_type = 'statement' and a.owner_id in (select s.id from public.statements s where s.customer_id = cust and s.period_end >= since);
    delete from public.statements s where s.customer_id = cust and s.period_end >= since;
    perform public.generate_statements(cust);
  end if;
  return paths;
end;
$$;

-- ---------------------------------------------------------------------
-- Public verification: an order letter shows its customer, employee or company.
-- ---------------------------------------------------------------------
create or replace function public.verify_record(p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  raw text := trim(coalesce(p_code, ''));
  cands text[];
  c text;
  r record;
  amt text;
begin
  if raw = '' then return jsonb_build_object('found', false); end if;
  if raw ~* '#verify/' then raw := regexp_replace(raw, '^.*#verify/', '', 'i'); end if;
  raw := split_part(split_part(raw, '?', 1), '&', 1);
  cands := array(
    select distinct upper(trim(x)) from unnest(string_to_array(raw, '|')) x
    where trim(x) <> '' and upper(trim(x)) not in ('EMON','EMONCUST','EMONINV','EMONPAY','EMONCM','EMONPRJ','EMONSP','EMONPS','EMONBD','ORDER','EMONJA','EMONSOA'));
  foreach c in array cands loop
    -- customer account (account no, application no or public ID)
    select * into r from public.customers cu where upper(cu.account_no) = c or upper(cu.application_no) = c or upper(cu.public_id) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Customer Account', 'number', r.account_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Account Name', r.first_name || ' ' || r.last_name), jsonb_build_array('Account No', r.account_no),
          jsonb_build_array('Application No', r.application_no), jsonb_build_array('Public ID', r.public_id),
          jsonb_build_array('Opened', to_char(r.application_date, 'DD Mon YYYY')), jsonb_build_array('Account Status', upper(r.status))));
    end if;
    select i.*, cu.first_name, cu.last_name, cu.account_no as acct,
      coalesce((select sum(p.amount) from public.payments_received p where p.invoice_id = i.id), 0) as paid
      into r from public.customer_invoices i join public.customers cu on cu.id = i.customer_id where upper(i.invoice_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Invoice', 'number', r.invoice_no,
        'status', case when r.paid >= r.total_amount then 'paid' when r.paid > 0 then 'partial' else 'unpaid' end,
        'fields', jsonb_build_array(
          jsonb_build_array('Invoice No', r.invoice_no), jsonb_build_array('Customer', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Account No', r.acct), jsonb_build_array('Invoice Date', to_char(r.invoice_date, 'DD Mon YYYY')),
          jsonb_build_array('PO Number', coalesce(r.po_number, '[[U+2014]]')), jsonb_build_array('Boxes / Pcs', r.total_boxes || ' / ' || r.total_pcs),
          jsonb_build_array('Amount (PHP)', to_char(r.total_amount, 'FM999,999,999,990.00')),
          jsonb_build_array('Paid (PHP)', to_char(r.paid, 'FM999,999,999,990.00'))));
    end if;
    select p.*, cu.first_name, cu.last_name, cu.account_no as acct, i.invoice_no as inv
      into r from public.payments_received p join public.customers cu on cu.id = p.customer_id left join public.customer_invoices i on i.id = p.invoice_id
      where upper(p.receipt_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Payment Receipt', 'number', r.receipt_no, 'status', 'received',
        'fields', jsonb_build_array(
          jsonb_build_array('Receipt No', r.receipt_no), jsonb_build_array('Received From', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Account No', r.acct), jsonb_build_array('Date Paid', to_char(r.paid_date, 'DD Mon YYYY')),
          jsonb_build_array('Amount (PHP)', to_char(r.amount, 'FM999,999,999,990.00')), jsonb_build_array('Method', replace(r.method, '_', ' ')),
          jsonb_build_array('Reference', coalesce(r.reference_no, '[[U+2014]]')), jsonb_build_array('Invoice', coalesce(r.inv, 'General payment')),
          jsonb_build_array('Verified By', coalesce(r.created_by_name, '[[U+2014]]'))));
    end if;
    select m.*, cu.first_name, cu.last_name, cu.account_no as acct
      into r from public.credit_memos m join public.customers cu on cu.id = m.customer_id where upper(m.memo_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Credit Memo', 'number', r.memo_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Report No', r.memo_no), jsonb_build_array('Customer', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Customer ID', r.acct), jsonb_build_array('Date', to_char(r.memo_date, 'DD Mon YYYY')),
          jsonb_build_array('Request', replace(r.requested_action, '_', ' ')), jsonb_build_array('Amount (PHP)', to_char(r.request_amount, 'FM999,999,999,990.00')),
          jsonb_build_array('Status', upper(r.status))));
    end if;
    select s.*, cu.first_name, cu.last_name, cu.account_no as acct
      into r from public.statements s join public.customers cu on cu.id = s.customer_id where upper(s.statement_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Statement of Account', 'number', r.statement_no, 'status', 'issued',
        'fields', jsonb_build_array(
          jsonb_build_array('Statement No', r.statement_no), jsonb_build_array('Customer', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Account No', r.acct), jsonb_build_array('Period', to_char(r.period_start, 'DD Mon YYYY') || ' [[U+2013]] ' || to_char(r.period_end, 'DD Mon YYYY')),
          jsonb_build_array('Opening (PHP)', to_char(r.opening_balance, 'FM999,999,999,990.00')),
          jsonb_build_array('Closing (PHP)', to_char(r.closing_balance, 'FM999,999,999,990.00'))));
    end if;
    select o.*, cu.first_name, cu.last_name, cu.account_no as acct, em.first_name as em_first, em.last_name as em_last, em.employee_no as em_no, pc.name as co_name
      into r from public.order_letters o left join public.customers cu on cu.id = o.customer_id
      left join public.employees em on em.id = o.employee_id left join public.pay_companies pc on pc.id = o.company_id
      where upper(o.order_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Order Letter', 'number', r.order_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Order No', r.order_no), jsonb_build_array('Date', to_char(r.order_date, 'DD Mon YYYY')),
          jsonb_build_array(case when r.employee_id is not null then 'Employee' when r.company_id is not null then 'Company' else 'Account' end,
            coalesce(r.first_name || ' ' || r.last_name || ' (' || r.acct || ')', r.em_first || ' ' || r.em_last || ' (' || r.em_no || ')', r.co_name, '[[U+2014]]')),
          jsonb_build_array('Subject', r.subject), jsonb_build_array('Type', initcap(replace(r.subject_type, '_', ' '))),
          jsonb_build_array('Status', upper(r.status)), jsonb_build_array('Approved By', coalesce(r.approved_by_name, '[[U+2014]]'))));
    end if;
    select v.*, pc.name as company, pa.account_name, pa.account_number, pa.bank_name
      into r from public.pay_vouchers v join public.pay_companies pc on pc.id = v.company_id left join public.pay_accounts pa on pa.id = v.account_id
      where upper(v.voucher_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Payment Voucher', 'number', r.voucher_no, 'status', 'paid',
        'fields', jsonb_build_array(
          jsonb_build_array('Voucher No', r.voucher_no), jsonb_build_array('Paid To', r.company),
          jsonb_build_array('Account', coalesce(r.account_name || ' ' || coalesce(r.account_number, '') || ' ' || coalesce(r.bank_name, ''), '[[U+2014]]')),
          jsonb_build_array('Date', to_char(r.pay_date, 'DD Mon YYYY')),
          jsonb_build_array('Amount (PHP)', to_char(r.amount_php, 'FM999,999,999,990.00')),
          jsonb_build_array('Exchange Rate', to_char(r.exchange_rate, 'FM999,990.0000')),
          jsonb_build_array('Amount (BDT)', to_char(r.amount_bdt, 'FM999,999,999,990.00')),
          jsonb_build_array('Issued By', coalesce(r.created_by_name, '[[U+2014]]'))));
    end if;
    select s.*, e.first_name, e.last_name, e.employee_no, e.position
      into r from public.payslips s join public.employees e on e.id = s.employee_id where upper(s.payslip_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Payslip', 'number', r.payslip_no, 'status', 'paid',
        'fields', jsonb_build_array(
          jsonb_build_array('Payslip No', r.payslip_no), jsonb_build_array('Employee', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Employee No', r.employee_no), jsonb_build_array('Type', initcap(r.pay_type)),
          jsonb_build_array('Period', to_char(r.period_month, 'FMMonth YYYY')), jsonb_build_array('Pay Date', to_char(r.pay_date, 'DD Mon YYYY')),
          jsonb_build_array('Net Pay (PHP)', to_char(r.net_pay, 'FM999,999,999,990.00'))));
    end if;
    select * into r from public.job_applications j where upper(j.application_no) = c or upper(j.approval_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Job Application', 'number', r.application_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Application No', r.application_no), jsonb_build_array('Applicant', r.full_name),
          jsonb_build_array('Position', r.position_title), jsonb_build_array('Company', r.company_name),
          jsonb_build_array('Submitted', to_char(r.created_at, 'DD Mon YYYY')), jsonb_build_array('Status', upper(r.status)),
          jsonb_build_array('Approval No', coalesce(r.approval_no, '[[U+2014]]'))));
    end if;
    select * into r from public.employees e where upper(e.employee_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Employee', 'number', r.employee_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Employee No', r.employee_no), jsonb_build_array('Name', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Position', coalesce(r.position, '[[U+2014]]')), jsonb_build_array('Status', upper(r.status))));
    end if;
    select * into r from public.projects p where upper(p.project_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Project', 'number', r.project_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Project No', r.project_no), jsonb_build_array('Title', r.title),
          jsonb_build_array('Total Cost (PHP)', to_char(r.total_cost, 'FM999,999,999,990.00')), jsonb_build_array('Status', upper(r.status))));
    end if;
    select x.*, p.project_no, p.title into r from public.project_payments x join public.projects p on p.id = x.project_id where upper(x.payment_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Project Payment', 'number', r.payment_no, 'status', 'paid',
        'fields', jsonb_build_array(
          jsonb_build_array('Payment No', r.payment_no), jsonb_build_array('Project', r.project_no || ' [[U+2014]] ' || r.title),
          jsonb_build_array('Date', to_char(r.pay_date, 'DD Mon YYYY')), jsonb_build_array('Amount (PHP)', to_char(r.amount, 'FM999,999,999,990.00')),
          jsonb_build_array('Received By', r.received_by)));
    end if;
    select * into r from public.documents d where upper(d.doc_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Document', 'number', r.doc_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Document No', r.doc_no), jsonb_build_array('Party', r.party_name),
          jsonb_build_array('Date', to_char(r.doc_date, 'DD Mon YYYY')), jsonb_build_array('Amount (PHP)', to_char(r.amount, 'FM999,999,999,990.00')),
          jsonb_build_array('Status', upper(r.status))));
    end if;
  end loop;
  return jsonb_build_object('found', false, 'code', raw);
end;
$$;
grant execute on function public.verify_record(text) to anon, authenticated;

-- ======== 006_update_1_3.sql ========
-- =====================================================================
-- EMON OVERRUNS E-PORTAL [[U+2014]] Update 1.3
-- Billing companies: currency (PHP, BDT or both), address, contact person and photo.
-- Orders: amount due and days overdue on customer orders, installment schedule, reason for closing,
-- and the Account Balance Certificate.
-- Customers: the Public ID becomes a wallet-style key (EO + 40 letters and numbers); its QR code is the key itself.
-- Run once in the Supabase SQL Editor after 005_update_1_2.sql. It is safe to run again.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Billing companies: currency, address, contact person, photo
-- ---------------------------------------------------------------------
drop view if exists public.pay_company_totals;
alter table public.pay_companies add column if not exists currency text not null default 'BOTH';
alter table public.pay_companies drop constraint if exists pay_companies_currency_check;
alter table public.pay_companies add constraint pay_companies_currency_check check (currency in ('PHP','BDT','BOTH'));
alter table public.pay_companies add column if not exists address text;
alter table public.pay_companies add column if not exists contact_person text;

-- A voucher is in the company's currency: PHP, BDT, or PHP and BDT (PHP [[U+00D7]] rate = BDT).
alter table public.pay_vouchers alter column amount_bdt drop expression if exists;
alter table public.pay_vouchers alter column amount_php drop not null;
alter table public.pay_vouchers alter column exchange_rate drop not null;
alter table public.pay_vouchers drop constraint if exists pay_vouchers_amount_check;
alter table public.pay_vouchers add constraint pay_vouchers_amount_check check (coalesce(amount_php, 0) > 0 or coalesce(amount_bdt, 0) > 0);

create or replace function public.pay_companies_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.status := 'active';
  new.status_note := null;
  new.currency := upper(coalesce(new.currency, 'BOTH'));
  new.created_by := auth.uid();
  new.created_by_name := (select full_name from public.profiles where id = auth.uid());
  return new;
end;
$$;

create or replace function public.pay_vouchers_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare co public.pay_companies;
begin
  select * into co from public.pay_companies c where c.id = new.company_id;
  if co.id is null then raise exception 'Choose the company'; end if;
  if co.status <> 'active' then
    raise exception 'This company is SUSPENDED. New payments are blocked until it is reactivated by an approved order';
  end if;
  if new.account_id is not null and not exists (select 1 from public.pay_accounts a where a.id = new.account_id and a.company_id = new.company_id) then
    raise exception 'That account belongs to a different company';
  end if;
  if co.currency = 'PHP' then
    if coalesce(new.amount_php, 0) <= 0 then raise exception 'Enter the amount in PHP'; end if;
    new.exchange_rate := null; new.amount_bdt := null;
  elsif co.currency = 'BDT' then
    if coalesce(new.amount_bdt, 0) <= 0 then raise exception 'Enter the amount in BDT'; end if;
    new.amount_php := null; new.exchange_rate := null;
  else
    if coalesce(new.amount_php, 0) <= 0 then raise exception 'Enter the amount in PHP'; end if;
    if coalesce(new.exchange_rate, 0) <= 0 then raise exception 'Enter the exchange rate'; end if;
    new.amount_bdt := round(new.amount_php * new.exchange_rate, 2);
  end if;
  new.voucher_no := 'BD' || to_char(new.pay_date, 'YYYYMMDD') || lpad(public.next_counter('BD' || to_char(new.pay_date, 'YYYYMMDD'))::text, 3, '0');
  new.created_by := auth.uid();
  new.created_by_name := (select full_name from public.profiles where id = auth.uid());
  return new;
end;
$$;

create view public.pay_company_totals with (security_invoker = true) as
  select c.*,
    (select count(*) from public.pay_accounts a where a.company_id = c.id)::int as accounts_count,
    (select count(*) from public.pay_vouchers v where v.company_id = c.id)::int as vouchers_count,
    coalesce((select sum(v.amount_php) from public.pay_vouchers v where v.company_id = c.id), 0)::numeric(16,2) as total_php,
    coalesce((select sum(v.amount_bdt) from public.pay_vouchers v where v.company_id = c.id), 0)::numeric(16,2) as total_bdt,
    coalesce((select sum(v.amount_php) from public.pay_vouchers v where v.company_id = c.id and date_trunc('month', v.pay_date) = date_trunc('month', current_date)), 0)::numeric(16,2) as month_php,
    coalesce((select sum(v.amount_bdt) from public.pay_vouchers v where v.company_id = c.id and date_trunc('month', v.pay_date) = date_trunc('month', current_date)), 0)::numeric(16,2) as month_bdt,
    (select max(v.pay_date) from public.pay_vouchers v where v.company_id = c.id) as last_paid
  from public.pay_companies c;
revoke all on public.pay_company_totals from anon;
grant select on public.pay_company_totals to authenticated;

-- The company photo is added or changed by billing staff (saved records are otherwise never edited).
create or replace function public.set_company_photo(p_id uuid, p_path text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.can_write('billing') then raise exception 'You do not have permission to change the company photo'; end if;
  if coalesce(p_path, '') !~ ('^pay_company/' || p_id::text || '/') then raise exception 'Invalid photo'; end if;
  perform public.allow_record_change();
  update public.pay_companies set photo_path = p_path where id = p_id;
  if not found then raise exception 'Company not found'; end if;
end;
$$;
revoke execute on function public.set_company_photo(uuid, text) from public, anon;
grant execute on function public.set_company_photo(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- Orders: amount due and days overdue, installment schedule, reason for closing, balance certificate
-- ---------------------------------------------------------------------
alter table public.order_letters add column if not exists balance_due numeric(14,2);
alter table public.order_letters add column if not exists days_overdue integer;
alter table public.order_letters add column if not exists closure_reason text;
alter table public.order_letters add column if not exists installment_every text;
alter table public.order_letters drop constraint if exists order_letters_installment_every_check;
alter table public.order_letters add constraint order_letters_installment_every_check check (installment_every is null or installment_every in ('month','15 days','week'));
alter table public.order_letters drop constraint if exists order_letters_subject_type_check;
alter table public.order_letters add constraint order_letters_subject_type_check check (subject_type in
  ('suspension','closure','reactivation','reopen','termination','memo','unpaid','installment','unsettled_balance','promise_to_pay','balance_certificate','other'));

-- What a customer owes now and since when: payments and credits pay the oldest invoices first, so the
-- oldest invoice not yet covered tells how many days the account is overdue.
create or replace function public.account_due(p_customer uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with paid as (
    select coalesce((select sum(p.amount) from public.payments_received p where p.customer_id = p_customer), 0)
         + coalesce((select sum(m.request_amount) from public.credit_memos m where m.customer_id = p_customer and m.status in ('approved','paid')
                       and m.requested_action in ('credit','discount')), 0) as total
  ), inv as (
    select i.invoice_no, i.invoice_date, sum(i.total_amount) over (order by i.invoice_date, i.created_at, i.invoice_no) as running
    from public.customer_invoices i where i.customer_id = p_customer
  ), oldest as (
    select inv.invoice_no, inv.invoice_date from inv, paid where inv.running > paid.total order by inv.running limit 1
  )
  select jsonb_build_object(
    'balance_due', coalesce((select b.balance_due from public.customer_balances b where b.customer_id = p_customer), 0),
    'days_overdue', coalesce((select greatest(0, current_date - o.invoice_date) from oldest o), 0),
    'oldest_invoice_no', (select o.invoice_no from oldest o),
    'oldest_invoice_date', (select o.invoice_date from oldest o))
  where public.is_active();
$$;
revoke execute on function public.account_due(uuid) from public, anon;
grant execute on function public.account_due(uuid) to authenticated;

create or replace function public.order_letters_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare kind text; d jsonb;
begin
  if num_nonnulls(new.customer_id, new.employee_id, new.company_id) <> 1 then
    raise exception 'Choose one customer, employee or company for this order';
  end if;
  kind := case when new.employee_id is not null then 'employee' when new.company_id is not null then 'company' else 'customer' end;
  if kind = 'employee' and new.subject_type not in ('suspension','reactivation','termination','memo') then
    raise exception 'An employee order is a suspension, reactivation, termination or memo';
  end if;
  if kind = 'company' and new.subject_type not in ('suspension','reactivation','memo') then
    raise exception 'A company order is a suspension, reactivation or memo';
  end if;
  if kind = 'customer' and new.subject_type in ('termination','memo') then
    raise exception 'This order cannot be made for a customer';
  end if;
  -- A customer order keeps the amount due and the days overdue of the day it is made.
  if kind = 'customer' then
    d := public.account_due(new.customer_id);
    new.balance_due := coalesce((d->>'balance_due')::numeric, 0);
    new.days_overdue := coalesce((d->>'days_overdue')::int, 0);
  else
    new.balance_due := null; new.days_overdue := null;
  end if;
  if new.subject_type = 'closure' then
    if coalesce(trim(new.closure_reason), '') = '' then raise exception 'Choose the reason for closing the account'; end if;
  else
    new.closure_reason := null;
  end if;
  if new.subject_type = 'installment' then
    if coalesce(new.amount, 0) <= 0 or coalesce(new.installments, 0) < 1 or new.first_due_date is null then
      raise exception 'Enter the amount, the number of installments and the first due date';
    end if;
    new.installment_every := coalesce(new.installment_every, 'month');
    new.installment_amount := coalesce(new.installment_amount, round(new.amount / new.installments, 2));
  else
    new.installment_every := null;
  end if;
  if new.subject_type = 'promise_to_pay' and (coalesce(new.amount, 0) <= 0 or new.first_due_date is null) then
    raise exception 'Enter the amount the customer will pay and the date';
  end if;
  new.order_no := 'ORDER-' || to_char(new.order_date, 'YYYY') || '-' || lpad(public.next_counter('ORDER' || to_char(new.order_date, 'YYYY'))::text, 3, '0');
  new.status := 'pending';
  new.approved_by := null; new.approved_by_name := null; new.approved_at := null;
  new.applied_by_name := null; new.applied_at := null; new.applied_result := null;
  new.created_by := auth.uid();
  new.created_by_name := (select full_name from public.profiles where id = auth.uid());
  return new;
end;
$$;

create or replace function public.carry_out_order(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  o public.order_letters;
  c public.customers;
  e public.employees;
  pc public.pay_companies;
  newst text;
  res text;
  me text := (select full_name from public.profiles where id = auth.uid());
begin
  select * into o from public.order_letters where id = p_id for update;
  perform public.allow_record_change();
  if o.customer_id is not null then
    select * into c from public.customers where id = o.customer_id for update;
    newst := case o.subject_type when 'suspension' then 'suspended' when 'closure' then 'closed' when 'reactivation' then 'active' when 'reopen' then 'active' else null end;
    if o.subject_type = 'suspension' and c.status <> 'active' then raise exception 'Account % is % [[U+2014]] only ACTIVE accounts can be suspended', c.account_no, upper(c.status); end if;
    if o.subject_type = 'closure' and c.status not in ('active','suspended') then raise exception 'Account % is % and cannot be closed', c.account_no, upper(c.status); end if;
    if o.subject_type = 'reactivation' and c.status <> 'suspended' then raise exception 'Account % is % [[U+2014]] only SUSPENDED accounts can be reactivated', c.account_no, upper(c.status); end if;
    if o.subject_type = 'reopen' and c.status <> 'closed' then raise exception 'Account % is % [[U+2014]] only CLOSED accounts can be reopened', c.account_no, upper(c.status); end if;
    if newst is not null then
      update public.customers set status = newst, status_note = o.order_no || ': ' || o.subject || coalesce(' [[U+2014]] ' || o.closure_reason, '') where id = c.id;
      res := 'Account ' || c.account_no || ' is now ' || upper(newst);
    else
      res := case when o.subject_type = 'balance_certificate'
        then 'Account Balance Certificate issued for account ' || c.account_no || ' [[U+2014]] PHP ' || to_char(coalesce(o.balance_due, 0), 'FM999,999,999,990.00') || ' due'
        else 'Order recorded on account ' || c.account_no end;
    end if;
    insert into public.customer_events (customer_id, action, note, actor, actor_name)
    values (c.id, case o.subject_type when 'reopen' then 'reopened' else coalesce(newst, replace(o.subject_type, '_', ' ')) end || ' by ' || o.order_no, o.subject, auth.uid(), me);
  elsif o.employee_id is not null then
    select * into e from public.employees where id = o.employee_id for update;
    if o.subject_type <> 'memo' and e.profile_id = auth.uid() then raise exception 'You cannot suspend, reactivate or terminate your own employee record'; end if;
    if o.subject_type = 'suspension' then
      if e.status not in ('active','inactive') then raise exception 'Employee % is % [[U+2014]] only ACTIVE employees can be suspended', e.employee_no, upper(e.status); end if;
      newst := 'suspended';
    elsif o.subject_type = 'reactivation' then
      if e.status <> 'suspended' then raise exception 'Employee % is % [[U+2014]] only SUSPENDED employees can be reactivated', e.employee_no, upper(e.status); end if;
      newst := case when e.profile_id is null then 'waiting' else 'active' end;
    elsif o.subject_type = 'termination' then
      if e.status = 'terminated' then raise exception 'Employee % is already TERMINATED', e.employee_no; end if;
      newst := 'terminated';
    end if;
    if newst = 'terminated' then
      update public.employees set status = 'terminated', termination_date = current_date, termination_reason = o.order_no || ': ' || o.subject where id = e.id;
    elsif newst is not null then
      update public.employees set status = newst where id = e.id;
    end if;
    res := case when newst is null then 'Memo recorded for employee ' || e.employee_no else 'Employee ' || e.employee_no || ' is now ' || upper(newst) end;
  elsif o.company_id is not null then
    select * into pc from public.pay_companies where id = o.company_id for update;
    if o.subject_type = 'suspension' then
      if pc.status <> 'active' then raise exception '% is % [[U+2014]] only ACTIVE companies can be suspended', pc.name, upper(pc.status); end if;
      newst := 'suspended';
    elsif o.subject_type = 'reactivation' then
      if pc.status <> 'suspended' then raise exception '% is % [[U+2014]] only SUSPENDED companies can be reactivated', pc.name, upper(pc.status); end if;
      newst := 'active';
    end if;
    if newst is not null then
      update public.pay_companies set status = newst, status_note = o.order_no || ': ' || o.subject where id = pc.id;
      res := pc.name || ' is now ' || upper(newst);
    else
      res := 'Memo recorded for ' || pc.name;
    end if;
  else
    res := 'Order carried out';
  end if;
  update public.order_letters set status = 'applied', applied_at = now(), applied_by_name = me, applied_result = res where id = o.id;
  return jsonb_build_object('order_no', o.order_no, 'result', res, 'status', newst);
end;
$$;
revoke execute on function public.carry_out_order(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Customer Public ID: a wallet-style key, like a crypto wallet address: "EO" and 40 letters and numbers
-- (e.g. EO7a3F9c2B[[U+2026]]). It is made from the customer ID with a secret key that never leaves the database, so it
-- cannot be worked out or guessed, and it never changes. The customer's QR code is the key itself.
-- (The Private ID stays a sealed fingerprint that only the CEO sees.)
-- ---------------------------------------------------------------------
create or replace function public.customer_public_id(p_data jsonb) returns text
language plpgsql stable security definer set search_path = '' as $$
declare sk text; h text; m text; o text; n int := 0; i int;
begin
  select s.v into sk from private.app_secrets s where s.k = 'customer_id_key';
  loop
    h := left(encode(sha256(convert_to(coalesce(sk, '') || '|public|' || coalesce(p_data->>'account_no', p_data->>'id', '') || '|' || n || '|' || coalesce(sk, ''), 'UTF8')), 'hex'), 40);
    -- Capital letters where a second fingerprint says so, like the checksum in a wallet address.
    m := encode(sha256(convert_to(h, 'UTF8')), 'hex');
    o := 'EO';
    for i in 1..40 loop
      o := o || case when substr(m, i, 1) >= '8' and substr(h, i, 1) between 'a' and 'f' then upper(substr(h, i, 1)) else substr(h, i, 1) end;
    end loop;
    exit when not exists (select 1 from public.customers c where upper(c.public_id) = upper(o) and c.id is distinct from (p_data->>'id')::uuid);
    n := n + 1;
  end loop;
  return o;
end;
$$;
revoke execute on function public.customer_public_id(jsonb) from public, anon, authenticated;
-- Customers saved before this update get their key once.
do $$
begin
  if not exists (select 1 from private.app_secrets where k = 'customer_ids_key') then
    perform set_config('eo.allow_change', 'on', true);
    update public.customers c set public_id = public.customer_public_id(to_jsonb(c));
    insert into private.app_secrets (k, v) values ('customer_ids_key', now()::text);
  end if;
end $$;

-- Details that can be corrected: billing companies add the contact person, address and currency.
create or replace function public.editable_columns(p_table text) returns text[]
language sql immutable set search_path = '' as $$
  select case p_table
    when 'customers' then array['first_name','last_name','phone','email','address','business_name','business_start_date','facebook_name','has_extra_facebook','extra_facebook_name','facebook_verified']
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
    else null end;
$$;
revoke execute on function public.editable_columns(text) from public, anon;

-- Public verification: a voucher shows its own currency; a balance certificate shows the amount due;
-- a customer account shows the amount due to signed-in portal users.
create or replace function public.verify_record(p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  raw text := trim(coalesce(p_code, ''));
  cands text[];
  c text;
  r record;
  amt text;
begin
  if raw = '' then return jsonb_build_object('found', false); end if;
  if raw ~* '#verify/' then raw := regexp_replace(raw, '^.*#verify/', '', 'i'); end if;
  raw := split_part(split_part(raw, '?', 1), '&', 1);
  cands := array(
    select distinct upper(trim(x)) from unnest(string_to_array(raw, '|')) x
    where trim(x) <> '' and upper(trim(x)) not in ('EMON','EMONCUST','EMONINV','EMONPAY','EMONCM','EMONPRJ','EMONSP','EMONPS','EMONBD','ORDER','EMONJA','EMONSOA'));
  foreach c in array cands loop
    -- customer account (account no, application no or public ID)
    select * into r from public.customers cu where upper(cu.account_no) = c or upper(cu.application_no) = c or upper(cu.public_id) = c limit 1;
    if found then
      -- The amount due shows only to signed-in portal users (not on the public page) and never on the Validated Print.
      return jsonb_build_object('found', true, 'type', 'Customer Account', 'number', r.account_no, 'status', r.status,
        'fields', (select jsonb_agg(f) from jsonb_array_elements(jsonb_build_array(
          jsonb_build_array('Customer ID', r.account_no), jsonb_build_array('Account Name', r.first_name || ' ' || r.last_name),
          case when public.is_active() then jsonb_build_array('Amount Due (PHP)',
            to_char(coalesce((select b.balance_due from public.customer_balances b where b.customer_id = r.id), 0), 'FM999,999,999,990.00')) end,
          jsonb_build_array('Application No', r.application_no), jsonb_build_array('Public ID', r.public_id),
          jsonb_build_array('Opened', to_char(r.application_date, 'DD Mon YYYY')), jsonb_build_array('Account Status', upper(r.status)))) f where f <> 'null'::jsonb));
    end if;
    select i.*, cu.first_name, cu.last_name, cu.account_no as acct,
      coalesce((select sum(p.amount) from public.payments_received p where p.invoice_id = i.id), 0) as paid
      into r from public.customer_invoices i join public.customers cu on cu.id = i.customer_id where upper(i.invoice_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Invoice', 'number', r.invoice_no,
        'status', case when r.paid >= r.total_amount then 'paid' when r.paid > 0 then 'partial' else 'unpaid' end,
        'fields', jsonb_build_array(
          jsonb_build_array('Invoice No', r.invoice_no), jsonb_build_array('Customer', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Account No', r.acct), jsonb_build_array('Invoice Date', to_char(r.invoice_date, 'DD Mon YYYY')),
          jsonb_build_array('PO Number', coalesce(r.po_number, '[[U+2014]]')), jsonb_build_array('Boxes / Pcs', r.total_boxes || ' / ' || r.total_pcs),
          jsonb_build_array('Amount (PHP)', to_char(r.total_amount, 'FM999,999,999,990.00')),
          jsonb_build_array('Paid (PHP)', to_char(r.paid, 'FM999,999,999,990.00'))));
    end if;
    select p.*, cu.first_name, cu.last_name, cu.account_no as acct, i.invoice_no as inv
      into r from public.payments_received p join public.customers cu on cu.id = p.customer_id left join public.customer_invoices i on i.id = p.invoice_id
      where upper(p.receipt_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Payment Receipt', 'number', r.receipt_no, 'status', 'received',
        'fields', jsonb_build_array(
          jsonb_build_array('Receipt No', r.receipt_no), jsonb_build_array('Received From', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Account No', r.acct), jsonb_build_array('Date Paid', to_char(r.paid_date, 'DD Mon YYYY')),
          jsonb_build_array('Amount (PHP)', to_char(r.amount, 'FM999,999,999,990.00')), jsonb_build_array('Method', replace(r.method, '_', ' ')),
          jsonb_build_array('Reference', coalesce(r.reference_no, '[[U+2014]]')), jsonb_build_array('Invoice', coalesce(r.inv, 'General payment')),
          jsonb_build_array('Verified By', coalesce(r.created_by_name, '[[U+2014]]'))));
    end if;
    select m.*, cu.first_name, cu.last_name, cu.account_no as acct
      into r from public.credit_memos m join public.customers cu on cu.id = m.customer_id where upper(m.memo_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Credit Memo', 'number', r.memo_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Report No', r.memo_no), jsonb_build_array('Customer', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Customer ID', r.acct), jsonb_build_array('Date', to_char(r.memo_date, 'DD Mon YYYY')),
          jsonb_build_array('Request', replace(r.requested_action, '_', ' ')), jsonb_build_array('Amount (PHP)', to_char(r.request_amount, 'FM999,999,999,990.00')),
          jsonb_build_array('Status', upper(r.status))));
    end if;
    select s.*, cu.first_name, cu.last_name, cu.account_no as acct
      into r from public.statements s join public.customers cu on cu.id = s.customer_id where upper(s.statement_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Statement of Account', 'number', r.statement_no, 'status', 'issued',
        'fields', jsonb_build_array(
          jsonb_build_array('Statement No', r.statement_no), jsonb_build_array('Customer', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Account No', r.acct), jsonb_build_array('Period', to_char(r.period_start, 'DD Mon YYYY') || ' [[U+2013]] ' || to_char(r.period_end, 'DD Mon YYYY')),
          jsonb_build_array('Opening (PHP)', to_char(r.opening_balance, 'FM999,999,999,990.00')),
          jsonb_build_array('Closing (PHP)', to_char(r.closing_balance, 'FM999,999,999,990.00'))));
    end if;
    select o.*, cu.first_name, cu.last_name, cu.account_no as acct, em.first_name as em_first, em.last_name as em_last, em.employee_no as em_no, pc.name as co_name
      into r from public.order_letters o left join public.customers cu on cu.id = o.customer_id
      left join public.employees em on em.id = o.employee_id left join public.pay_companies pc on pc.id = o.company_id
      where upper(o.order_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Order Letter', 'number', r.order_no, 'status', r.status,
        'fields', (select jsonb_agg(f) from jsonb_array_elements(jsonb_build_array(
          jsonb_build_array('Order No', r.order_no), jsonb_build_array('Date', to_char(r.order_date, 'DD Mon YYYY')),
          jsonb_build_array(case when r.employee_id is not null then 'Employee' when r.company_id is not null then 'Company' else 'Account' end,
            coalesce(r.first_name || ' ' || r.last_name || ' (' || r.acct || ')', r.em_first || ' ' || r.em_last || ' (' || r.em_no || ')', r.co_name, '[[U+2014]]')),
          jsonb_build_array('Subject', r.subject), jsonb_build_array('Type', initcap(replace(r.subject_type, '_', ' '))),
          case when r.subject_type = 'balance_certificate' then jsonb_build_array('Amount Due (PHP)', to_char(r.balance_due, 'FM999,999,999,990.00')) end,
          jsonb_build_array('Status', upper(r.status)), jsonb_build_array('Approved By', coalesce(r.approved_by_name, '[[U+2014]]')))) f where f <> 'null'::jsonb));
    end if;
    select v.*, pc.name as company, pa.account_name, pa.account_number, pa.bank_name
      into r from public.pay_vouchers v join public.pay_companies pc on pc.id = v.company_id left join public.pay_accounts pa on pa.id = v.account_id
      where upper(v.voucher_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Payment Voucher', 'number', r.voucher_no, 'status', 'paid',
        'fields', (select jsonb_agg(f) from jsonb_array_elements(jsonb_build_array(
          jsonb_build_array('Voucher No', r.voucher_no), jsonb_build_array('Paid To', r.company),
          jsonb_build_array('Account', coalesce(r.account_name || ' ' || coalesce(r.account_number, '') || ' ' || coalesce(r.bank_name, ''), '[[U+2014]]')),
          jsonb_build_array('Date', to_char(r.pay_date, 'DD Mon YYYY')),
          case when r.amount_php is not null then jsonb_build_array('Amount (PHP)', to_char(r.amount_php, 'FM999,999,999,990.00')) end,
          case when r.exchange_rate is not null then jsonb_build_array('Exchange Rate', to_char(r.exchange_rate, 'FM999,990.0000')) end,
          case when r.amount_bdt is not null then jsonb_build_array('Amount (BDT)', to_char(r.amount_bdt, 'FM999,999,999,990.00')) end,
          jsonb_build_array('Issued By', coalesce(r.created_by_name, '[[U+2014]]')))) f where f <> 'null'::jsonb));
    end if;
    select s.*, e.first_name, e.last_name, e.employee_no, e.position
      into r from public.payslips s join public.employees e on e.id = s.employee_id where upper(s.payslip_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Payslip', 'number', r.payslip_no, 'status', 'paid',
        'fields', jsonb_build_array(
          jsonb_build_array('Payslip No', r.payslip_no), jsonb_build_array('Employee', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Employee No', r.employee_no), jsonb_build_array('Type', initcap(r.pay_type)),
          jsonb_build_array('Period', to_char(r.period_month, 'FMMonth YYYY')), jsonb_build_array('Pay Date', to_char(r.pay_date, 'DD Mon YYYY')),
          jsonb_build_array('Net Pay (PHP)', to_char(r.net_pay, 'FM999,999,999,990.00'))));
    end if;
    select * into r from public.job_applications j where upper(j.application_no) = c or upper(j.approval_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Job Application', 'number', r.application_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Application No', r.application_no), jsonb_build_array('Applicant', r.full_name),
          jsonb_build_array('Position', r.position_title), jsonb_build_array('Company', r.company_name),
          jsonb_build_array('Submitted', to_char(r.created_at, 'DD Mon YYYY')), jsonb_build_array('Status', upper(r.status)),
          jsonb_build_array('Approval No', coalesce(r.approval_no, '[[U+2014]]'))));
    end if;
    select * into r from public.employees e where upper(e.employee_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Employee', 'number', r.employee_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Employee No', r.employee_no), jsonb_build_array('Name', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Position', coalesce(r.position, '[[U+2014]]')), jsonb_build_array('Status', upper(r.status))));
    end if;
    select * into r from public.projects p where upper(p.project_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Project', 'number', r.project_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Project No', r.project_no), jsonb_build_array('Title', r.title),
          jsonb_build_array('Total Cost (PHP)', to_char(r.total_cost, 'FM999,999,999,990.00')), jsonb_build_array('Status', upper(r.status))));
    end if;
    select x.*, p.project_no, p.title into r from public.project_payments x join public.projects p on p.id = x.project_id where upper(x.payment_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Project Payment', 'number', r.payment_no, 'status', 'paid',
        'fields', jsonb_build_array(
          jsonb_build_array('Payment No', r.payment_no), jsonb_build_array('Project', r.project_no || ' [[U+2014]] ' || r.title),
          jsonb_build_array('Date', to_char(r.pay_date, 'DD Mon YYYY')), jsonb_build_array('Amount (PHP)', to_char(r.amount, 'FM999,999,999,990.00')),
          jsonb_build_array('Received By', r.received_by)));
    end if;
    select * into r from public.documents d where upper(d.doc_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Document', 'number', r.doc_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Document No', r.doc_no), jsonb_build_array('Party', r.party_name),
          jsonb_build_array('Date', to_char(r.doc_date, 'DD Mon YYYY')), jsonb_build_array('Amount (PHP)', to_char(r.amount, 'FM999,999,999,990.00')),
          jsonb_build_array('Status', upper(r.status))));
    end if;
  end loop;
  return jsonb_build_object('found', false, 'code', raw);
end;
$$;
grant execute on function public.verify_record(text) to anon, authenticated;

-- ======== 007_update_1_4.sql ========
-- =====================================================================
-- EMON OVERRUNS E-PORTAL [[U+2014]] Update 1.4
-- Customers: the profile photo can be changed or removed (made empty) by staff with customer access.
-- Each change is written in the customer's History.
-- Run once in the Supabase SQL Editor after 006_update_1_3.sql. It is safe to run again.
-- =====================================================================

create or replace function public.set_customer_photo(p_id uuid, p_path text) returns void
language plpgsql security definer set search_path = '' as $$
declare old text;
begin
  if not public.can_write('customers') then raise exception 'You do not have permission to change the customer photo'; end if;
  if p_path is not null and p_path !~ ('^customer/' || p_id::text || '/') then raise exception 'Invalid photo'; end if;
  select c.photo_path into old from public.customers c where c.id = p_id for update;
  if not found then raise exception 'Customer not found'; end if;
  if old is not distinct from p_path then return; end if;
  perform public.allow_record_change();
  update public.customers set photo_path = p_path where id = p_id;
  insert into public.customer_events (customer_id, action, actor, actor_name)
  values (p_id, case when p_path is null then 'photo removed' when old is null then 'photo added' else 'photo changed' end,
          auth.uid(), (select full_name from public.profiles where id = auth.uid()));
end;
$$;
revoke execute on function public.set_customer_photo(uuid, text) from public, anon;
grant execute on function public.set_customer_photo(uuid, text) to authenticated;

-- ======== 008_update_1_5.sql ========
-- =====================================================================
-- EMON OVERRUNS E-PORTAL [[U+2014]] Update 1.5
-- Customers: a changed or removed photo also leaves the customer's Files.
-- Order letters: "Additional Charge" and "Settlement Adjustment". When approved, a charge is added to the customer's
-- balance; a settlement adjustment is added to it or taken off it (chosen on the order). Both show on the profile and
-- in the Statement of Account, with the order number as the reference.
-- Deleting an order letter (CEO) also undoes it: the status before the order comes back, and a charge or
-- adjustment leaves the balance and the statements.
-- Run once in the Supabase SQL Editor after 007_update_1_4.sql. It is safe to run again.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Customer photo: the old photo also leaves Files
-- ---------------------------------------------------------------------
create or replace function public.set_customer_photo(p_id uuid, p_path text) returns void
language plpgsql security definer set search_path = '' as $$
declare old text;
begin
  if not public.can_write('customers') then raise exception 'You do not have permission to change the customer photo'; end if;
  if p_path is not null and p_path !~ ('^customer/' || p_id::text || '/') then raise exception 'Invalid photo'; end if;
  select c.photo_path into old from public.customers c where c.id = p_id for update;
  if not found then raise exception 'Customer not found'; end if;
  if old is not distinct from p_path then return; end if;
  perform public.allow_record_change();
  update public.customers set photo_path = p_path where id = p_id;
  -- The old photo is no longer listed in the customer's Files.
  if old is not null then
    delete from public.attachments a where a.owner_type = 'customer' and a.owner_id = p_id and a.kind = 'photo' and a.storage_path = old;
  end if;
  insert into public.customer_events (customer_id, action, actor, actor_name)
  values (p_id, case when p_path is null then 'photo removed' when old is null then 'photo added' else 'photo changed' end,
          auth.uid(), (select full_name from public.profiles where id = auth.uid()));
end;
$$;
revoke execute on function public.set_customer_photo(uuid, text) from public, anon;
grant execute on function public.set_customer_photo(uuid, text) to authenticated;
-- Photos changed or removed before this update leave Files too.
do $$
begin
  perform set_config('eo.allow_change', 'on', true);
  delete from public.attachments a using public.customers c
  where a.owner_type = 'customer' and a.owner_id = c.id and a.kind = 'photo' and a.storage_path is distinct from c.photo_path;
end $$;

-- ---------------------------------------------------------------------
-- Order letters: Additional Charge and Settlement Adjustment (customers). Once approved:
--   charge                      [[U+2192]] added to the balance (debit)
--   settlement, adjust 'add'    [[U+2192]] added to the balance (debit)
--   settlement, adjust 'reduce' [[U+2192]] taken off the balance (credit)
-- ---------------------------------------------------------------------
alter table public.order_letters add column if not exists adjust_type text;
-- The status (and note) a customer, employee or company had before the order changed it, so deleting it can undo it.
alter table public.order_letters add column if not exists prev_status text;
alter table public.order_letters add column if not exists prev_note text;
alter table public.order_letters drop constraint if exists order_letters_adjust_type_check;
alter table public.order_letters add constraint order_letters_adjust_type_check check (adjust_type is null or adjust_type in ('add','reduce'));
alter table public.order_letters drop constraint if exists order_letters_subject_type_check;
alter table public.order_letters add constraint order_letters_subject_type_check check (subject_type in
  ('suspension','closure','reactivation','reopen','termination','memo','unpaid','installment','unsettled_balance','promise_to_pay','balance_certificate',
   'charge','settlement','other'));

-- What a customer owes: invoices, approved Additional Charges and Settlement Adjustments that add, less payments,
-- approved credit/discount memos and Settlement Adjustments that take money off.
-- total_charges = Additional Charges; total_settlement = Settlement Adjustments (added minus taken off).
create or replace view public.customer_balances with (security_invoker = true) as
  select c.id as customer_id,
    coalesce((select sum(total_amount) from public.customer_invoices i where i.customer_id = c.id), 0)::numeric(14,2) as total_invoiced,
    coalesce((select sum(amount) from public.payments_received p where p.customer_id = c.id), 0)::numeric(14,2) as total_paid,
    coalesce((select sum(request_amount) from public.credit_memos m where m.customer_id = c.id and m.status in ('approved','paid') and m.requested_action in ('credit','discount')), 0)::numeric(14,2) as total_credits,
    (coalesce((select sum(total_amount) from public.customer_invoices i where i.customer_id = c.id), 0)
      + coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = c.id and o.status = 'applied' and (o.subject_type = 'charge' or (o.subject_type = 'settlement' and o.adjust_type = 'add'))), 0)
      - coalesce((select sum(amount) from public.payments_received p where p.customer_id = c.id), 0)
      - coalesce((select sum(request_amount) from public.credit_memos m where m.customer_id = c.id and m.status in ('approved','paid') and m.requested_action in ('credit','discount')), 0)
      - coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = c.id and o.status = 'applied' and o.subject_type = 'settlement' and o.adjust_type = 'reduce'), 0))::numeric(14,2) as balance_due,
    coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = c.id and o.status = 'applied' and o.subject_type = 'charge'), 0)::numeric(14,2) as total_charges,
    coalesce((select sum(case o.adjust_type when 'reduce' then -o.amount else o.amount end) from public.order_letters o
              where o.customer_id = c.id and o.status = 'applied' and o.subject_type = 'settlement'), 0)::numeric(14,2) as total_settlement
  from public.customers c;

-- Balance of a customer before a date (for the statements): order charges and adjustments count from the day
-- they were carried out.
create or replace function public.balance_before(p_customer uuid, p_date date) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce((select sum(total_amount) from public.customer_invoices where customer_id = p_customer and invoice_date < p_date), 0)
       + coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = p_customer and o.status = 'applied' and (o.subject_type = 'charge' or (o.subject_type = 'settlement' and o.adjust_type = 'add')) and o.applied_at::date < p_date), 0)
       - coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = p_customer and o.status = 'applied' and o.subject_type = 'settlement' and o.adjust_type = 'reduce' and o.applied_at::date < p_date), 0)
       - coalesce((select sum(amount) from public.payments_received where customer_id = p_customer and paid_date < p_date), 0)
       - coalesce((select sum(request_amount) from public.credit_memos where customer_id = p_customer and status in ('approved','paid')
                   and requested_action in ('credit','discount') and approved_at::date < p_date), 0);
$$;
revoke execute on function public.balance_before(uuid, date) from public, anon;
grant execute on function public.balance_before(uuid, date) to authenticated;

-- Monthly statements: the month's debit includes the order charges and added adjustments of that month; its credit
-- the adjustments taken off.
create or replace function public.generate_statements(p_customer uuid default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  c record;
  m date;
  first_m date;
  last_m date := (date_trunc('month', current_date) - interval '1 month')::date;
  stop_m date;
  nxt date;
  op numeric; deb numeric; cre numeric;
  made integer := 0;
begin
  if auth.uid() is not null and not public.is_active() then raise exception 'Not allowed'; end if;
  for c in select * from public.customers cu where cu.status in ('active','suspended','closed') and (p_customer is null or cu.id = p_customer) loop
    first_m := date_trunc('month', least(
      c.application_date,
      coalesce((select min(invoice_date) from public.customer_invoices where customer_id = c.id), c.application_date),
      coalesce((select min(paid_date) from public.payments_received where customer_id = c.id), c.application_date)))::date;
    stop_m := last_m;
    if c.status = 'closed' then
      stop_m := least(last_m, coalesce((select date_trunc('month', max(created_at))::date from public.customer_events
                                        where customer_id = c.id and (action = 'close' or action like 'closed by %')), last_m));
    end if;
    m := first_m;
    while m <= stop_m loop
      nxt := (m + interval '1 month')::date;
      if not exists (select 1 from public.statements s where s.customer_id = c.id and s.period_start = m) then
        op := public.balance_before(c.id, m);
        deb := coalesce((select sum(total_amount) from public.customer_invoices where customer_id = c.id and invoice_date >= m and invoice_date < nxt), 0)
             + coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = c.id and o.status = 'applied' and (o.subject_type = 'charge' or (o.subject_type = 'settlement' and o.adjust_type = 'add'))
                          and o.applied_at::date >= m and o.applied_at::date < nxt), 0);
        cre := coalesce((select sum(amount) from public.payments_received where customer_id = c.id and paid_date >= m and paid_date < nxt), 0)
             + coalesce((select sum(request_amount) from public.credit_memos where customer_id = c.id and status in ('approved','paid')
                          and requested_action in ('credit','discount') and approved_at::date >= m and approved_at::date < nxt), 0)
             + coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = c.id and o.status = 'applied' and o.subject_type = 'settlement' and o.adjust_type = 'reduce'
                          and o.applied_at::date >= m and o.applied_at::date < nxt), 0);
        insert into public.statements (statement_no, customer_id, period_start, period_end, opening_balance, total_debit, total_credit, closing_balance)
        values ('SOA-' || to_char(m, 'YYYYMM') || '-' || c.account_no, c.id, m, (nxt - 1), op, deb, cre, op + deb - cre);
        made := made + 1;
      end if;
      m := nxt;
    end loop;
  end loop;
  return made;
end;
$$;
revoke execute on function public.generate_statements(uuid) from public, anon;
grant execute on function public.generate_statements(uuid) to authenticated;

-- Amount due and days overdue: charges and added adjustments are paid in date order together with the invoices;
-- adjustments taken off count like payments.
create or replace function public.account_due(p_customer uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with paid as (
    select coalesce((select sum(p.amount) from public.payments_received p where p.customer_id = p_customer), 0)
         + coalesce((select sum(m.request_amount) from public.credit_memos m where m.customer_id = p_customer and m.status in ('approved','paid')
                       and m.requested_action in ('credit','discount')), 0)
         + coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = p_customer and o.status = 'applied' and o.subject_type = 'settlement' and o.adjust_type = 'reduce'), 0) as total
  ), inv as (
    select x.invoice_no, x.invoice_date, sum(x.amount) over (order by x.invoice_date, x.at, x.invoice_no) as running
    from (select i.invoice_no, i.invoice_date, i.created_at as at, i.total_amount as amount from public.customer_invoices i where i.customer_id = p_customer
          union all
          select o.order_no, o.applied_at::date, o.applied_at, o.amount from public.order_letters o
          where o.customer_id = p_customer and o.status = 'applied' and (o.subject_type = 'charge' or (o.subject_type = 'settlement' and o.adjust_type = 'add'))) x
  ), oldest as (
    select inv.invoice_no, inv.invoice_date from inv, paid where inv.running > paid.total order by inv.running limit 1
  )
  select jsonb_build_object(
    'balance_due', coalesce((select b.balance_due from public.customer_balances b where b.customer_id = p_customer), 0),
    'days_overdue', coalesce((select greatest(0, current_date - o.invoice_date) from oldest o), 0),
    'oldest_invoice_no', (select o.invoice_no from oldest o),
    'oldest_invoice_date', (select o.invoice_date from oldest o))
  where public.is_active();
$$;
revoke execute on function public.account_due(uuid) from public, anon;
grant execute on function public.account_due(uuid) to authenticated;

create or replace function public.order_letters_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare kind text; d jsonb;
begin
  if num_nonnulls(new.customer_id, new.employee_id, new.company_id) <> 1 then
    raise exception 'Choose one customer, employee or company for this order';
  end if;
  kind := case when new.employee_id is not null then 'employee' when new.company_id is not null then 'company' else 'customer' end;
  if kind = 'employee' and new.subject_type not in ('suspension','reactivation','termination','memo') then
    raise exception 'An employee order is a suspension, reactivation, termination or memo';
  end if;
  if kind = 'company' and new.subject_type not in ('suspension','reactivation','memo') then
    raise exception 'A company order is a suspension, reactivation or memo';
  end if;
  if kind = 'customer' and new.subject_type in ('termination','memo') then
    raise exception 'This order cannot be made for a customer';
  end if;
  -- A customer order keeps the amount due and the days overdue of the day it is made.
  if kind = 'customer' then
    d := public.account_due(new.customer_id);
    new.balance_due := coalesce((d->>'balance_due')::numeric, 0);
    new.days_overdue := coalesce((d->>'days_overdue')::int, 0);
  else
    new.balance_due := null; new.days_overdue := null;
  end if;
  if new.subject_type = 'closure' then
    if coalesce(trim(new.closure_reason), '') = '' then raise exception 'Choose the reason for closing the account'; end if;
  else
    new.closure_reason := null;
  end if;
  if new.subject_type = 'installment' then
    if coalesce(new.amount, 0) <= 0 or coalesce(new.installments, 0) < 1 or new.first_due_date is null then
      raise exception 'Enter the amount, the number of installments and the first due date';
    end if;
    new.installment_every := coalesce(new.installment_every, 'month');
    new.installment_amount := coalesce(new.installment_amount, round(new.amount / new.installments, 2));
  else
    new.installment_every := null;
  end if;
  if new.subject_type = 'promise_to_pay' and (coalesce(new.amount, 0) <= 0 or new.first_due_date is null) then
    raise exception 'Enter the amount the customer will pay and the date';
  end if;
  if new.subject_type = 'charge' and coalesce(new.amount, 0) <= 0 then
    raise exception 'Enter the charge amount';
  end if;
  if new.subject_type = 'settlement' then
    if coalesce(new.amount, 0) <= 0 then raise exception 'Enter the adjustment amount'; end if;
    if coalesce(new.adjust_type, '') not in ('add','reduce') then raise exception 'Choose whether the adjustment adds to the balance or takes it off'; end if;
  else
    new.adjust_type := null;
  end if;
  new.order_no := 'ORDER-' || to_char(new.order_date, 'YYYY') || '-' || lpad(public.next_counter('ORDER' || to_char(new.order_date, 'YYYY'))::text, 3, '0');
  new.status := 'pending';
  new.approved_by := null; new.approved_by_name := null; new.approved_at := null;
  new.applied_by_name := null; new.applied_at := null; new.applied_result := null;
  new.created_by := auth.uid();
  new.created_by_name := (select full_name from public.profiles where id = auth.uid());
  return new;
end;
$$;

create or replace function public.carry_out_order(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  o public.order_letters;
  c public.customers;
  e public.employees;
  pc public.pay_companies;
  newst text;
  res text;
  prev_st text;
  prev_nt text;
  me text := (select full_name from public.profiles where id = auth.uid());
begin
  select * into o from public.order_letters where id = p_id for update;
  perform public.allow_record_change();
  if o.customer_id is not null then
    select * into c from public.customers where id = o.customer_id for update;
    prev_st := c.status; prev_nt := c.status_note;
    newst := case o.subject_type when 'suspension' then 'suspended' when 'closure' then 'closed' when 'reactivation' then 'active' when 'reopen' then 'active' else null end;
    if o.subject_type = 'suspension' and c.status <> 'active' then raise exception 'Account % is % [[U+2014]] only ACTIVE accounts can be suspended', c.account_no, upper(c.status); end if;
    if o.subject_type = 'closure' and c.status not in ('active','suspended') then raise exception 'Account % is % and cannot be closed', c.account_no, upper(c.status); end if;
    if o.subject_type = 'reactivation' and c.status <> 'suspended' then raise exception 'Account % is % [[U+2014]] only SUSPENDED accounts can be reactivated', c.account_no, upper(c.status); end if;
    if o.subject_type = 'reopen' and c.status <> 'closed' then raise exception 'Account % is % [[U+2014]] only CLOSED accounts can be reopened', c.account_no, upper(c.status); end if;
    if o.subject_type = 'charge' and c.status not in ('active','suspended') then raise exception 'Account % is % [[U+2014]] a charge cannot be added', c.account_no, upper(c.status); end if;
    if o.subject_type = 'settlement' and c.status not in ('active','suspended','closed') then raise exception 'Account % is % [[U+2014]] no settlement adjustment can be made', c.account_no, upper(c.status); end if;
    if newst is not null then
      update public.customers set status = newst, status_note = o.order_no || ': ' || o.subject || coalesce(' [[U+2014]] ' || o.closure_reason, '') where id = c.id;
      res := 'Account ' || c.account_no || ' is now ' || upper(newst);
    else
      res := case when o.subject_type = 'balance_certificate'
        then 'Account Balance Certificate issued for account ' || c.account_no || ' [[U+2014]] PHP ' || to_char(coalesce(o.balance_due, 0), 'FM999,999,999,990.00') || ' due'
        when o.subject_type = 'charge'
        then 'Charge of PHP ' || to_char(o.amount, 'FM999,999,999,990.00') || ' added to account ' || c.account_no || ' [[U+2014]] new balance PHP '
          || to_char(coalesce((select b.balance_due from public.customer_balances b where b.customer_id = c.id), 0) + o.amount, 'FM999,999,999,990.00')
        when o.subject_type = 'settlement'
        then 'Settlement adjustment: PHP ' || to_char(o.amount, 'FM999,999,999,990.00') || case o.adjust_type when 'reduce' then ' taken off' else ' added to' end
          || ' account ' || c.account_no || ' [[U+2014]] new balance PHP '
          || to_char(coalesce((select b.balance_due from public.customer_balances b where b.customer_id = c.id), 0)
                     + case o.adjust_type when 'reduce' then -o.amount else o.amount end, 'FM999,999,999,990.00')
        else 'Order recorded on account ' || c.account_no end;
    end if;
    insert into public.customer_events (customer_id, action, note, actor, actor_name)
    values (c.id, case o.subject_type when 'reopen' then 'reopened' when 'charge' then 'charge PHP ' || to_char(o.amount, 'FM999,999,999,990.00')
                  when 'settlement' then 'settlement adjustment ' || case o.adjust_type when 'reduce' then '[[U+2212]]' else '+' end || 'PHP ' || to_char(o.amount, 'FM999,999,999,990.00')
                  else coalesce(newst, replace(o.subject_type, '_', ' ')) end || ' by ' || o.order_no, o.subject, auth.uid(), me);
  elsif o.employee_id is not null then
    select * into e from public.employees where id = o.employee_id for update;
    prev_st := e.status;
    if o.subject_type <> 'memo' and e.profile_id = auth.uid() then raise exception 'You cannot suspend, reactivate or terminate your own employee record'; end if;
    if o.subject_type = 'suspension' then
      if e.status not in ('active','inactive') then raise exception 'Employee % is % [[U+2014]] only ACTIVE employees can be suspended', e.employee_no, upper(e.status); end if;
      newst := 'suspended';
    elsif o.subject_type = 'reactivation' then
      if e.status <> 'suspended' then raise exception 'Employee % is % [[U+2014]] only SUSPENDED employees can be reactivated', e.employee_no, upper(e.status); end if;
      newst := case when e.profile_id is null then 'waiting' else 'active' end;
    elsif o.subject_type = 'termination' then
      if e.status = 'terminated' then raise exception 'Employee % is already TERMINATED', e.employee_no; end if;
      newst := 'terminated';
    end if;
    if newst = 'terminated' then
      update public.employees set status = 'terminated', termination_date = current_date, termination_reason = o.order_no || ': ' || o.subject where id = e.id;
    elsif newst is not null then
      update public.employees set status = newst where id = e.id;
    end if;
    res := case when newst is null then 'Memo recorded for employee ' || e.employee_no else 'Employee ' || e.employee_no || ' is now ' || upper(newst) end;
  elsif o.company_id is not null then
    select * into pc from public.pay_companies where id = o.company_id for update;
    prev_st := pc.status; prev_nt := pc.status_note;
    if o.subject_type = 'suspension' then
      if pc.status <> 'active' then raise exception '% is % [[U+2014]] only ACTIVE companies can be suspended', pc.name, upper(pc.status); end if;
      newst := 'suspended';
    elsif o.subject_type = 'reactivation' then
      if pc.status <> 'suspended' then raise exception '% is % [[U+2014]] only SUSPENDED companies can be reactivated', pc.name, upper(pc.status); end if;
      newst := 'active';
    end if;
    if newst is not null then
      update public.pay_companies set status = newst, status_note = o.order_no || ': ' || o.subject where id = pc.id;
      res := pc.name || ' is now ' || upper(newst);
    else
      res := 'Memo recorded for ' || pc.name;
    end if;
  else
    res := 'Order carried out';
  end if;
  update public.order_letters set status = 'applied', applied_at = now(), applied_by_name = me, applied_result = res,
    prev_status = case when newst is not null then prev_st end, prev_note = case when newst is not null then prev_nt end where id = o.id;
  return jsonb_build_object('order_no', o.order_no, 'result', res, 'status', newst);
end;
$$;
revoke execute on function public.carry_out_order(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Deleting an order letter undoes it (the CEO deletes records)
-- ---------------------------------------------------------------------
-- The status an order set: customers suspended / closed / active, employees suspended / terminated / active or
-- waiting (no login yet), companies suspended / active.
create or replace function public.order_set_status(o public.order_letters) returns text[]
language sql stable set search_path = '' as $$
  select case
    when o.subject_type = 'suspension' then array['suspended']
    when o.subject_type = 'closure' then array['closed']
    when o.subject_type = 'termination' then array['terminated']
    when o.subject_type = 'reopen' then array['active']
    when o.subject_type = 'reactivation' and o.employee_id is not null then array['active','waiting']
    when o.subject_type = 'reactivation' then array['active']
  end;
$$;
revoke execute on function public.order_set_status(public.order_letters) from public, anon, authenticated;

-- Undo what an applied order did. A status is put back only when this order is the last one that changed the
-- status of that customer, employee or company, and the status is still the one it set. The status before the
-- order was saved when it was carried out; for older orders it is the status the order before it set, or the
-- first status (active; an employee without a login: waiting).
create or replace function public.undo_order(p_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  o public.order_letters;
  b public.order_letters;
  st text[] := array['suspension','closure','reactivation','reopen','termination'];
  prev text;
  me text := (select full_name from public.profiles where id = auth.uid());
begin
  select * into o from public.order_letters where id = p_id;
  if o.id is null or o.status <> 'applied' or not (o.subject_type = any(st)) then return null; end if;
  if exists (select 1 from public.order_letters x where x.status = 'applied' and x.id <> o.id and x.subject_type = any(st)
             and x.customer_id is not distinct from o.customer_id and x.employee_id is not distinct from o.employee_id
             and x.company_id is not distinct from o.company_id and x.applied_at > o.applied_at) then
    return null;
  end if;
  prev := o.prev_status;
  if prev is null then
    select * into b from public.order_letters x where x.status = 'applied' and x.id <> o.id and x.subject_type = any(st)
      and x.customer_id is not distinct from o.customer_id and x.employee_id is not distinct from o.employee_id
      and x.company_id is not distinct from o.company_id and x.applied_at < o.applied_at
    order by x.applied_at desc limit 1;
    if b.id is not null then prev := (public.order_set_status(b))[1]; end if;
    if prev = 'active' and b.employee_id is not null then
      prev := case when (select e.profile_id from public.employees e where e.id = b.employee_id) is null then 'waiting' else 'active' end;
    end if;
  end if;
  perform public.allow_record_change();
  if o.customer_id is not null then
    update public.customers set status = coalesce(prev, 'active'), status_note = o.prev_note
    where id = o.customer_id and status = any(public.order_set_status(o)) returning status into prev;
    if not found then return null; end if;
    insert into public.customer_events (customer_id, action, note, actor, actor_name)
    values (o.customer_id, o.order_no || ' deleted [[U+2014]] status back to ' || upper(prev), o.subject, auth.uid(), me);
  elsif o.employee_id is not null then
    update public.employees set
      status = coalesce(prev, case when profile_id is null then 'waiting' else 'active' end),
      termination_date = case when o.subject_type = 'termination' then null else termination_date end,
      termination_reason = case when o.subject_type = 'termination' then null else termination_reason end
    where id = o.employee_id and status = any(public.order_set_status(o)) returning status into prev;
    if not found then return null; end if;
  elsif o.company_id is not null then
    update public.pay_companies set status = coalesce(prev, 'active'), status_note = o.prev_note
    where id = o.company_id and status = any(public.order_set_status(o)) returning status into prev;
    if not found then return null; end if;
  end if;
  return prev;
end;
$$;
revoke execute on function public.undo_order(uuid) from public, anon, authenticated;
create or replace function public.delete_record(p_table text, p_id uuid) returns text[]
language plpgsql security definer set search_path = '' as $$
declare
  j jsonb;
  own_type text;
  paths text[];
  cust uuid;
  since date;
  subs uuid[] := '{}';
begin
  if not public.is_admin() then raise exception 'Only the CEO can delete records'; end if;
  if not public.deletable_table(p_table) then raise exception 'This kind of record cannot be deleted'; end if;
  execute format('select to_jsonb(t) from public.%I t where t.id = $1 for update', p_table) into j using p_id;
  if j is null then raise exception 'Record not found'; end if;
  if p_table = 'customers' and (exists (select 1 from public.customer_invoices x where x.customer_id = p_id)
      or exists (select 1 from public.payments_received x where x.customer_id = p_id)
      or exists (select 1 from public.credit_memos x where x.customer_id = p_id)
      or exists (select 1 from public.order_letters x where x.customer_id = p_id)) then
    raise exception 'This customer has invoices, payments, credit memos or order letters. Delete those first';
  end if;
  if p_table = 'customer_invoices' and exists (select 1 from public.payments_received x where x.invoice_id = p_id) then
    raise exception 'This invoice has payments. Delete its payments first';
  end if;
  if p_table = 'employees' then
    if (j->>'profile_id')::uuid = auth.uid() then raise exception 'You cannot delete your own employee record'; end if;
    if exists (select 1 from public.payslips x where x.employee_id = p_id) then raise exception 'This employee has payslips. Delete the payslips first'; end if;
    if exists (select 1 from public.order_letters x where x.employee_id = p_id) then raise exception 'This employee has order letters. Delete the order letters first'; end if;
  end if;
  if p_table = 'projects' and exists (select 1 from public.project_payments x where x.project_id = p_id) then
    raise exception 'This project has payments. Delete its payments first';
  end if;
  if p_table = 'pay_companies' and exists (select 1 from public.pay_vouchers x where x.company_id = p_id) then
    raise exception 'This company has payment vouchers. Delete the vouchers first';
  end if;
  if p_table = 'pay_companies' and exists (select 1 from public.order_letters x where x.company_id = p_id) then
    raise exception 'This company has order letters. Delete the order letters first';
  end if;
  if p_table = 'pay_accounts' and exists (select 1 from public.pay_vouchers x where x.account_id = p_id) then
    raise exception 'This account has payment vouchers. Delete the vouchers first';
  end if;
  perform public.allow_record_change();

  -- Files: the record's own, a customer's statement copies, a company's account files, and stored photos.
  own_type := case p_table when 'customers' then 'customer' when 'customer_invoices' then 'invoice' when 'payments_received' then 'payment'
    when 'credit_memos' then 'credit_memo' when 'employees' then 'employee' when 'payslips' then 'payslip' when 'projects' then 'project'
    when 'project_payments' then 'project_payment' when 'pay_companies' then 'pay_company' when 'pay_accounts' then 'pay_account'
    when 'pay_vouchers' then 'pay_voucher' when 'job_applications' then 'job_application' when 'order_letters' then 'order_letter' end;
  if p_table = 'customers' then subs := array(select s.id from public.statements s where s.customer_id = p_id); end if;
  if p_table = 'pay_companies' then subs := array(select a.id from public.pay_accounts a where a.company_id = p_id); end if;
  select coalesce(array_agg(a.storage_path), '{}') into paths from public.attachments a
    where (a.owner_type = own_type and a.owner_id = p_id) or a.owner_id = any(subs);
  delete from public.attachments a where (a.owner_type = own_type and a.owner_id = p_id) or a.owner_id = any(subs);
  if j->>'photo_path' is not null then paths := paths || (j->>'photo_path'); end if;

  -- A customer money record changes the statements of account from its month on.
  if p_table in ('customer_invoices','payments_received','credit_memos') then
    cust := (j->>'customer_id')::uuid;
    since := date_trunc('month', case p_table when 'customer_invoices' then (j->>'invoice_date')::date
               when 'payments_received' then (j->>'paid_date')::date
               else coalesce((j->>'approved_at')::timestamptz::date, (j->>'memo_date')::date) end)::date;
  end if;
  -- An applied order letter is undone: the status before it comes back; a charge or settlement adjustment leaves
  -- the balance, so the statements are made again from its month on.
  if p_table = 'order_letters' and j->>'status' = 'applied' then
    perform public.undo_order(p_id);
    if j->>'subject_type' in ('charge','settlement') and j->>'customer_id' is not null then
      cust := (j->>'customer_id')::uuid;
      since := date_trunc('month', (j->>'applied_at')::timestamptz::date)::date;
    end if;
  end if;
  if p_table = 'employees' and j->>'profile_id' is not null then
    update public.profiles set status = 'disabled' where id = (j->>'profile_id')::uuid;
  end if;

  delete from public.change_requests where target_table = p_table and target_id = p_id;
  delete from public.record_changes where target_table = p_table and target_id = p_id;
  execute format('delete from public.%I where id = $1', p_table) using p_id;

  if cust is not null then
    select paths || coalesce(array_agg(a.storage_path), '{}') into paths from public.attachments a
      where a.owner_type = 'statement' and a.owner_id in (select s.id from public.statements s where s.customer_id = cust and s.period_end >= since);
    delete from public.attachments a
      where a.owner_type = 'statement' and a.owner_id in (select s.id from public.statements s where s.customer_id = cust and s.period_end >= since);
    delete from public.statements s where s.customer_id = cust and s.period_end >= since;
    perform public.generate_statements(cust);
  end if;
  return paths;
end;
$$;
revoke execute on function public.delete_record(text, uuid) from public, anon;
grant execute on function public.delete_record(text, uuid) to authenticated;

-- Verification: an Additional Charge or Settlement Adjustment order shows its amount.
create or replace function public.verify_record(p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  raw text := trim(coalesce(p_code, ''));
  cands text[];
  c text;
  r record;
  amt text;
begin
  if raw = '' then return jsonb_build_object('found', false); end if;
  if raw ~* '#verify/' then raw := regexp_replace(raw, '^.*#verify/', '', 'i'); end if;
  raw := split_part(split_part(raw, '?', 1), '&', 1);
  cands := array(
    select distinct upper(trim(x)) from unnest(string_to_array(raw, '|')) x
    where trim(x) <> '' and upper(trim(x)) not in ('EMON','EMONCUST','EMONINV','EMONPAY','EMONCM','EMONPRJ','EMONSP','EMONPS','EMONBD','ORDER','EMONJA','EMONSOA'));
  foreach c in array cands loop
    -- customer account (account no, application no or public ID)
    select * into r from public.customers cu where upper(cu.account_no) = c or upper(cu.application_no) = c or upper(cu.public_id) = c limit 1;
    if found then
      -- The amount due shows only to signed-in portal users (not on the public page) and never on the Validated Print.
      return jsonb_build_object('found', true, 'type', 'Customer Account', 'number', r.account_no, 'status', r.status,
        'fields', (select jsonb_agg(f) from jsonb_array_elements(jsonb_build_array(
          jsonb_build_array('Customer ID', r.account_no), jsonb_build_array('Account Name', r.first_name || ' ' || r.last_name),
          case when public.is_active() then jsonb_build_array('Amount Due (PHP)',
            to_char(coalesce((select b.balance_due from public.customer_balances b where b.customer_id = r.id), 0), 'FM999,999,999,990.00')) end,
          jsonb_build_array('Application No', r.application_no), jsonb_build_array('Public ID', r.public_id),
          jsonb_build_array('Opened', to_char(r.application_date, 'DD Mon YYYY')), jsonb_build_array('Account Status', upper(r.status)))) f where f <> 'null'::jsonb));
    end if;
    select i.*, cu.first_name, cu.last_name, cu.account_no as acct,
      coalesce((select sum(p.amount) from public.payments_received p where p.invoice_id = i.id), 0) as paid
      into r from public.customer_invoices i join public.customers cu on cu.id = i.customer_id where upper(i.invoice_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Invoice', 'number', r.invoice_no,
        'status', case when r.paid >= r.total_amount then 'paid' when r.paid > 0 then 'partial' else 'unpaid' end,
        'fields', jsonb_build_array(
          jsonb_build_array('Invoice No', r.invoice_no), jsonb_build_array('Customer', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Account No', r.acct), jsonb_build_array('Invoice Date', to_char(r.invoice_date, 'DD Mon YYYY')),
          jsonb_build_array('PO Number', coalesce(r.po_number, '[[U+2014]]')), jsonb_build_array('Boxes / Pcs', r.total_boxes || ' / ' || r.total_pcs),
          jsonb_build_array('Amount (PHP)', to_char(r.total_amount, 'FM999,999,999,990.00')),
          jsonb_build_array('Paid (PHP)', to_char(r.paid, 'FM999,999,999,990.00'))));
    end if;
    select p.*, cu.first_name, cu.last_name, cu.account_no as acct, i.invoice_no as inv
      into r from public.payments_received p join public.customers cu on cu.id = p.customer_id left join public.customer_invoices i on i.id = p.invoice_id
      where upper(p.receipt_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Payment Receipt', 'number', r.receipt_no, 'status', 'received',
        'fields', jsonb_build_array(
          jsonb_build_array('Receipt No', r.receipt_no), jsonb_build_array('Received From', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Account No', r.acct), jsonb_build_array('Date Paid', to_char(r.paid_date, 'DD Mon YYYY')),
          jsonb_build_array('Amount (PHP)', to_char(r.amount, 'FM999,999,999,990.00')), jsonb_build_array('Method', replace(r.method, '_', ' ')),
          jsonb_build_array('Reference', coalesce(r.reference_no, '[[U+2014]]')), jsonb_build_array('Invoice', coalesce(r.inv, 'General payment')),
          jsonb_build_array('Verified By', coalesce(r.created_by_name, '[[U+2014]]'))));
    end if;
    select m.*, cu.first_name, cu.last_name, cu.account_no as acct
      into r from public.credit_memos m join public.customers cu on cu.id = m.customer_id where upper(m.memo_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Credit Memo', 'number', r.memo_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Report No', r.memo_no), jsonb_build_array('Customer', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Customer ID', r.acct), jsonb_build_array('Date', to_char(r.memo_date, 'DD Mon YYYY')),
          jsonb_build_array('Request', replace(r.requested_action, '_', ' ')), jsonb_build_array('Amount (PHP)', to_char(r.request_amount, 'FM999,999,999,990.00')),
          jsonb_build_array('Status', upper(r.status))));
    end if;
    select s.*, cu.first_name, cu.last_name, cu.account_no as acct
      into r from public.statements s join public.customers cu on cu.id = s.customer_id where upper(s.statement_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Statement of Account', 'number', r.statement_no, 'status', 'issued',
        'fields', jsonb_build_array(
          jsonb_build_array('Statement No', r.statement_no), jsonb_build_array('Customer', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Account No', r.acct), jsonb_build_array('Period', to_char(r.period_start, 'DD Mon YYYY') || ' [[U+2013]] ' || to_char(r.period_end, 'DD Mon YYYY')),
          jsonb_build_array('Opening (PHP)', to_char(r.opening_balance, 'FM999,999,999,990.00')),
          jsonb_build_array('Closing (PHP)', to_char(r.closing_balance, 'FM999,999,999,990.00'))));
    end if;
    select o.*, cu.first_name, cu.last_name, cu.account_no as acct, em.first_name as em_first, em.last_name as em_last, em.employee_no as em_no, pc.name as co_name
      into r from public.order_letters o left join public.customers cu on cu.id = o.customer_id
      left join public.employees em on em.id = o.employee_id left join public.pay_companies pc on pc.id = o.company_id
      where upper(o.order_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Order Letter', 'number', r.order_no, 'status', r.status,
        'fields', (select jsonb_agg(f) from jsonb_array_elements(jsonb_build_array(
          jsonb_build_array('Order No', r.order_no), jsonb_build_array('Date', to_char(r.order_date, 'DD Mon YYYY')),
          jsonb_build_array(case when r.employee_id is not null then 'Employee' when r.company_id is not null then 'Company' else 'Account' end,
            coalesce(r.first_name || ' ' || r.last_name || ' (' || r.acct || ')', r.em_first || ' ' || r.em_last || ' (' || r.em_no || ')', r.co_name, '[[U+2014]]')),
          jsonb_build_array('Subject', r.subject), jsonb_build_array('Type', initcap(replace(r.subject_type, '_', ' '))),
          case when r.subject_type = 'balance_certificate' then jsonb_build_array('Amount Due (PHP)', to_char(r.balance_due, 'FM999,999,999,990.00')) end,
          case when r.subject_type = 'charge' then jsonb_build_array('Charge (PHP)', to_char(r.amount, 'FM999,999,999,990.00')) end,
          case when r.subject_type = 'settlement' then jsonb_build_array('Settlement Adjustment (PHP)',
            case r.adjust_type when 'reduce' then 'Less ' else 'Add ' end || to_char(r.amount, 'FM999,999,999,990.00')) end,
          jsonb_build_array('Status', upper(r.status)), jsonb_build_array('Approved By', coalesce(r.approved_by_name, '[[U+2014]]')))) f where f <> 'null'::jsonb));
    end if;
    select v.*, pc.name as company, pa.account_name, pa.account_number, pa.bank_name
      into r from public.pay_vouchers v join public.pay_companies pc on pc.id = v.company_id left join public.pay_accounts pa on pa.id = v.account_id
      where upper(v.voucher_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Payment Voucher', 'number', r.voucher_no, 'status', 'paid',
        'fields', (select jsonb_agg(f) from jsonb_array_elements(jsonb_build_array(
          jsonb_build_array('Voucher No', r.voucher_no), jsonb_build_array('Paid To', r.company),
          jsonb_build_array('Account', coalesce(r.account_name || ' ' || coalesce(r.account_number, '') || ' ' || coalesce(r.bank_name, ''), '[[U+2014]]')),
          jsonb_build_array('Date', to_char(r.pay_date, 'DD Mon YYYY')),
          case when r.amount_php is not null then jsonb_build_array('Amount (PHP)', to_char(r.amount_php, 'FM999,999,999,990.00')) end,
          case when r.exchange_rate is not null then jsonb_build_array('Exchange Rate', to_char(r.exchange_rate, 'FM999,990.0000')) end,
          case when r.amount_bdt is not null then jsonb_build_array('Amount (BDT)', to_char(r.amount_bdt, 'FM999,999,999,990.00')) end,
          jsonb_build_array('Issued By', coalesce(r.created_by_name, '[[U+2014]]')))) f where f <> 'null'::jsonb));
    end if;
    select s.*, e.first_name, e.last_name, e.employee_no, e.position
      into r from public.payslips s join public.employees e on e.id = s.employee_id where upper(s.payslip_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Payslip', 'number', r.payslip_no, 'status', 'paid',
        'fields', jsonb_build_array(
          jsonb_build_array('Payslip No', r.payslip_no), jsonb_build_array('Employee', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Employee No', r.employee_no), jsonb_build_array('Type', initcap(r.pay_type)),
          jsonb_build_array('Period', to_char(r.period_month, 'FMMonth YYYY')), jsonb_build_array('Pay Date', to_char(r.pay_date, 'DD Mon YYYY')),
          jsonb_build_array('Net Pay (PHP)', to_char(r.net_pay, 'FM999,999,999,990.00'))));
    end if;
    select * into r from public.job_applications j where upper(j.application_no) = c or upper(j.approval_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Job Application', 'number', r.application_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Application No', r.application_no), jsonb_build_array('Applicant', r.full_name),
          jsonb_build_array('Position', r.position_title), jsonb_build_array('Company', r.company_name),
          jsonb_build_array('Submitted', to_char(r.created_at, 'DD Mon YYYY')), jsonb_build_array('Status', upper(r.status)),
          jsonb_build_array('Approval No', coalesce(r.approval_no, '[[U+2014]]'))));
    end if;
    select * into r from public.employees e where upper(e.employee_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Employee', 'number', r.employee_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Employee No', r.employee_no), jsonb_build_array('Name', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Position', coalesce(r.position, '[[U+2014]]')), jsonb_build_array('Status', upper(r.status))));
    end if;
    select * into r from public.projects p where upper(p.project_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Project', 'number', r.project_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Project No', r.project_no), jsonb_build_array('Title', r.title),
          jsonb_build_array('Total Cost (PHP)', to_char(r.total_cost, 'FM999,999,999,990.00')), jsonb_build_array('Status', upper(r.status))));
    end if;
    select x.*, p.project_no, p.title into r from public.project_payments x join public.projects p on p.id = x.project_id where upper(x.payment_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Project Payment', 'number', r.payment_no, 'status', 'paid',
        'fields', jsonb_build_array(
          jsonb_build_array('Payment No', r.payment_no), jsonb_build_array('Project', r.project_no || ' [[U+2014]] ' || r.title),
          jsonb_build_array('Date', to_char(r.pay_date, 'DD Mon YYYY')), jsonb_build_array('Amount (PHP)', to_char(r.amount, 'FM999,999,999,990.00')),
          jsonb_build_array('Received By', r.received_by)));
    end if;
    select * into r from public.documents d where upper(d.doc_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Document', 'number', r.doc_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Document No', r.doc_no), jsonb_build_array('Party', r.party_name),
          jsonb_build_array('Date', to_char(r.doc_date, 'DD Mon YYYY')), jsonb_build_array('Amount (PHP)', to_char(r.amount, 'FM999,999,999,990.00')),
          jsonb_build_array('Status', upper(r.status))));
    end if;
  end loop;
  return jsonb_build_object('found', false, 'code', raw);
end;
$$;
grant execute on function public.verify_record(text) to anon, authenticated;

-- ======== 009_update_1_6.sql ========
-- =====================================================================
-- EMON OVERRUNS E-PORTAL [[U+2014]] Update 1.6
-- Dates follow Manila time (Asia/Manila, UTC+8).
-- The database clock runs on UTC, so between midnight and 8 AM in Manila it still counted "today" as the day before:
-- the application date and account number of a new customer, days overdue, order / approval / project numbers,
-- termination dates, dates on the Verification page, and the month an order letter or a credit memo falls in on the statements.
-- After this update the database works these out in Manila time, and new records get the Manila date by default.
-- No records are changed. Run once in the Supabase SQL Editor after 008_update_1_5.sql. It is safe to run again
-- (and again after any later update that replaces one of these functions).
-- =====================================================================

-- 1. Every portal function that works out a date (numbers, statements, amount due, verification, orders) uses Manila time.
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
             and p.prosrc ~* '(current_date|::date|to_char\(|date_trunc\(|date_part\(|extract\()'
             and pg_get_userbyid(p.proowner) = current_user
  loop
    execute format('alter function %s set timezone to %L', f, 'Asia/Manila');
  end loop;
end $$;

-- 2. "Today" as the default date of new records is the Manila day.
do $$
declare r record;
begin
  for r in select c.table_name, c.column_name, c.column_default from information_schema.columns c
           join pg_class k on k.relname = c.table_name and k.relnamespace = 'public'::regnamespace and k.relkind = 'r'
           where c.table_schema = 'public' and c.column_default ilike '%current_date%' and pg_get_userbyid(k.relowner) = current_user
  loop
    execute format('alter table public.%I alter column %I set default %s', r.table_name, r.column_name,
                   regexp_replace(r.column_default, 'current_date', '((now() at time zone ''Asia/Manila''))::date', 'gi'));
  end loop;
end $$;

-- ======== 010_update_1_7.sql ========
-- =====================================================================
-- EMON OVERRUNS E-PORTAL [[U+2014]] Update 1.7
-- Wording. The top role is called "Director" (not "CEO") in every message from the database; a person without
-- a job position is shown as "Employee" (not "Staff") in Messages and Community; and some messages read better:
-- "This credit memo is APPROVED and cannot be approved" (was "Cannot approve a approved credit memo"),
-- history says "reactivated by ORDER-[[U+2026]]" (was "active by ORDER-[[U+2026]]"), Verification says "Additional Charge",
-- "Settlement Adjustment", "Promise to Pay", "Opening Balance" and "Closing Balance".
-- Each function is created again exactly as it is now (same settings, Manila time and permissions), with only these words changed.
-- No records are changed. Run once in the Supabase SQL Editor after 009_update_1_6.sql. It is safe to run again.
-- =====================================================================
do $$
declare
  -- function name ('*' = every function), the exact old text, the new text
  fixes text[][] := array[
    ['*', 'CEO', 'Director'],
    ['chat_contacts', 'when ''staff'' then ''Staff''', 'when ''staff'' then ''Employee'''],
    ['community_posts_before_insert', 'when ''staff'' then ''Staff''', 'when ''staff'' then ''Employee'''],
    ['set_my_username', 'That username is taken or not allowed (3-20 letters, numbers, dot or underscore)',
                        'That username is taken or not allowed (use 3-20 letters, numbers, dots or underscores)'],
    ['review_job_application', 'This application has no email to link a login', 'This application has no email address, so a login cannot be linked'],
    ['credit_memo_action', 'raise exception ''Cannot % a % credit memo'', p_action, m.status;',
                           'raise exception ''This credit memo is % and cannot be %'', upper(m.status), case p_action when ''approve'' then ''approved'' when ''reject'' then ''rejected'' when ''paid'' then ''marked as paid'' else p_action end;'],
    ['project_action', 'raise exception ''Cannot % a % project'', p_action, pr.status;',
                       'raise exception ''This project is % and cannot be %'', upper(pr.status), case p_action when ''approve'' then ''approved'' when ''reject'' then ''rejected'' when ''complete'' then ''completed'' else p_action end;'],
    ['order_letters_before_insert', 'An employee order is a suspension, reactivation, termination or memo', 'An employee order must be a suspension, reactivation, termination or memo'],
    ['order_letters_before_insert', 'A company order is a suspension, reactivation or memo', 'A company order must be a suspension, reactivation or memo'],
    ['order_letters_before_insert', 'Enter the amount the customer will pay and the date', 'Enter the amount the customer will pay and the promise date'],
    ['order_letters_before_insert', 'Choose whether the adjustment adds to the balance or takes it off', 'Choose whether the adjustment adds to the balance or reduces it'],
    ['carry_out_order', 'case o.subject_type when ''reopen'' then ''reopened'' when ''charge'' then',
                        'case o.subject_type when ''reopen'' then ''reopened'' when ''reactivation'' then ''reactivated'' when ''unpaid'' then ''unpaid balance notice'' when ''unsettled_balance'' then ''unsettled balance notice'' when ''other'' then ''order letter'' when ''charge'' then'],
    ['carry_out_order', 'only ACTIVE employees can be suspended', 'only ACTIVE or INACTIVE employees can be suspended'],
    ['verify_record', '''Opening (PHP)''', '''Opening Balance (PHP)'''],
    ['verify_record', '''Closing (PHP)''', '''Closing Balance (PHP)'''],
    ['verify_record', 'initcap(replace(r.subject_type, ''_'', '' ''))',
                      'case r.subject_type when ''promise_to_pay'' then ''Promise to Pay'' when ''charge'' then ''Additional Charge'' when ''settlement'' then ''Settlement Adjustment'' when ''unpaid'' then ''Unpaid Balance'' when ''reopen'' then ''Reopening'' else initcap(replace(r.subject_type, ''_'', '' '')) end'],
    ['verify_record', '''Charge (PHP)''', '''Additional Charge (PHP)''']
  ];
  f record; def text; new_def text; i int;
begin
  for f in select p.oid, p.proname from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and pg_get_userbyid(p.proowner) = current_user
  loop
    def := pg_get_functiondef(f.oid);
    new_def := def;
    for i in 1 .. array_length(fixes, 1) loop
      -- when the new text contains the old one, replace only once (so running this again changes nothing)
      if fixes[i][1] in ('*', f.proname) and (position(fixes[i][2] in fixes[i][3]) = 0 or position(fixes[i][3] in new_def) = 0) then
        new_def := replace(new_def, fixes[i][2], fixes[i][3]);
      end if;
    end loop;
    if new_def <> def then execute new_def; end if;
  end loop;
end $$;

-- ======== 011_update_1_8.sql ========
-- =====================================================================
-- EMON OVERRUNS E-PORTAL [[U+2014]] Update 1.8
-- 1. Uploaded files: a wrong file can be removed and uploaded again, in every upload section.
--    The Director removes any file; the person who uploaded a file can remove it within 24 hours.
--    Every removal is written in the record's history.
-- 2. Customer account:
--    - Credit Limit: a value kept on the record (nothing is blocked by it).
--    - Opening Balance: an amount the customer already owed when the account was opened. It counts from the
--      application date in the balance, the SOA, the monthly statements and the amount due.
--    - The address is verified by hand (no map search): Verified or Not Verified when the form is submitted,
--      and the Director can mark it later.
--    - The form shows a preview of the account number and application number.
-- No records are changed. Run once in the Supabase SQL Editor after 010_update_1_7.sql. It is safe to run again.
-- =====================================================================

-- ---------- 1. remove an uploaded file ----------
create or replace function public.remove_attachment(p_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  a public.attachments;
  me text := (select full_name from public.profiles where id = auth.uid());
  tbl text;
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
  tbl := case a.owner_type when 'customer' then 'customers' when 'invoice' then 'customer_invoices' when 'payment' then 'payments_received'
    when 'credit_memo' then 'credit_memos' when 'employee' then 'employees' when 'job_application' then 'job_applications'
    when 'payslip' then 'payslips' when 'order_letter' then 'order_letters' when 'pay_company' then 'pay_companies'
    when 'pay_account' then 'pay_accounts' when 'pay_voucher' then 'pay_vouchers' when 'project' then 'projects'
    when 'project_payment' then 'project_payments' when 'statement' then 'statements' else a.owner_type end;
  insert into public.record_changes (target_table, target_id, action, changes, previous, target_label, actor, actor_name)
  values (tbl, a.owner_id, 'file removed', jsonb_build_object('file', ''), jsonb_build_object('file', a.file_name), a.file_name, auth.uid(), me);
  return a.storage_path;
end;
$$;
revoke execute on function public.remove_attachment(uuid) from public, anon;
grant execute on function public.remove_attachment(uuid) to authenticated;

-- The person who uploaded a file may delete the stored file within 24 hours (the Director always could).
drop policy if exists "storage records: uploader delete" on storage.objects;
create policy "storage records: uploader delete" on storage.objects for delete to authenticated
  using (bucket_id = 'records' and created_at > now() - interval '24 hours'
         and (owner_id = (select auth.uid())::text or owner = (select auth.uid())));

-- ---------- 2. customer account ----------
alter table public.customers add column if not exists credit_limit numeric(14,2);
alter table public.customers add column if not exists opening_balance numeric(14,2) not null default 0;
alter table public.customers drop constraint if exists customers_credit_limit_check;
alter table public.customers add constraint customers_credit_limit_check check (credit_limit is null or credit_limit >= 0);
alter table public.customers drop constraint if exists customers_opening_balance_check;
alter table public.customers add constraint customers_opening_balance_check check (opening_balance >= 0);

-- the credit limit can be corrected like the other details
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
    else null end;
$$;

-- The account number and application number the next application will get (the final numbers are given on submit).
create or replace function public.preview_customer_numbers(p_first text, p_last text) returns jsonb
language sql stable security definer set search_path = '' set timezone to 'Asia/Manila' as $$
  select jsonb_build_object(
    'account_no', coalesce(nullif(upper(left(regexp_replace(coalesce(p_first, ''), '[^A-Za-z]', '', 'g'), 1) || left(regexp_replace(coalesce(p_last, ''), '[^A-Za-z]', '', 'g'), 1)), ''), 'XX')
                  || '-' || to_char(current_date, 'YYYYMM')
                  || lpad((coalesce((select d.last_no from public.doc_counters d where d.prefix = 'ACC' || to_char(current_date, 'YYYYMM')), 0) + 1)::text, 3, '0'),
    'application_no', 'EO-' || to_char(current_date, 'YYYY') || '-'
                  || lpad((coalesce((select d.last_no from public.doc_counters d where d.prefix = 'APP' || to_char(current_date, 'YYYY')), 0) + 1)::text, 5, '0'))
  where public.can_write('customers');
$$;
revoke execute on function public.preview_customer_numbers(text, text) from public, anon;
grant execute on function public.preview_customer_numbers(text, text) to authenticated;

-- Balance of every customer: the opening balance is part of what the customer owes.
create or replace view public.customer_balances with (security_invoker = true) as
  select c.id as customer_id,
    coalesce((select sum(total_amount) from public.customer_invoices i where i.customer_id = c.id), 0)::numeric(14,2) as total_invoiced,
    coalesce((select sum(amount) from public.payments_received p where p.customer_id = c.id), 0)::numeric(14,2) as total_paid,
    coalesce((select sum(request_amount) from public.credit_memos m where m.customer_id = c.id and m.status in ('approved','paid') and m.requested_action in ('credit','discount')), 0)::numeric(14,2) as total_credits,
    (c.opening_balance
      + coalesce((select sum(total_amount) from public.customer_invoices i where i.customer_id = c.id), 0)
      + coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = c.id and o.status = 'applied' and (o.subject_type = 'charge' or (o.subject_type = 'settlement' and o.adjust_type = 'add'))), 0)
      - coalesce((select sum(amount) from public.payments_received p where p.customer_id = c.id), 0)
      - coalesce((select sum(request_amount) from public.credit_memos m where m.customer_id = c.id and m.status in ('approved','paid') and m.requested_action in ('credit','discount')), 0)
      - coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = c.id and o.status = 'applied' and o.subject_type = 'settlement' and o.adjust_type = 'reduce'), 0))::numeric(14,2) as balance_due,
    coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = c.id and o.status = 'applied' and o.subject_type = 'charge'), 0)::numeric(14,2) as total_charges,
    coalesce((select sum(case o.adjust_type when 'reduce' then -o.amount else o.amount end) from public.order_letters o
              where o.customer_id = c.id and o.status = 'applied' and o.subject_type = 'settlement'), 0)::numeric(14,2) as total_settlement,
    c.opening_balance::numeric(14,2) as opening_balance
  from public.customers c;

-- The other functions are created again exactly as they are now (same settings, Manila time and permissions),
-- with only these lines changed.
do $$
declare
  -- function name, the exact old text, the new text (the new text always contains the old one, so it is added once)
  fixes text[][] := array[
    -- the opening balance counts from the application date
    ['balance_before', 'select coalesce((select sum(total_amount) from public.customer_invoices where customer_id = p_customer and invoice_date < p_date), 0)',
                       'select coalesce((select c.opening_balance from public.customers c where c.id = p_customer and c.application_date < p_date), 0)
       + coalesce((select sum(total_amount) from public.customer_invoices where customer_id = p_customer and invoice_date < p_date), 0)'],
    ['generate_statements', 'deb := coalesce((select sum(total_amount) from public.customer_invoices',
                            'deb := (case when c.application_date >= m and c.application_date < nxt then c.opening_balance else 0 end)
             + coalesce((select sum(total_amount) from public.customer_invoices'],
    ['account_due', 'from (select i.invoice_no, i.invoice_date, i.created_at as at, i.total_amount as amount from public.customer_invoices i where i.customer_id = p_customer',
                    'from (select ''Opening Balance'' as invoice_no, c.application_date as invoice_date, c.created_at as at, c.opening_balance as amount
          from public.customers c where c.id = p_customer and c.opening_balance > 0
          union all
          select i.invoice_no, i.invoice_date, i.created_at as at, i.total_amount as amount from public.customer_invoices i where i.customer_id = p_customer'],
    -- the Director marks an address verified or not verified by hand
    ['customer_action', 'when ''facebook_unverified'' then c.status',
                        'when ''facebook_unverified'' then c.status
    when ''address_verified'' then c.status
    when ''address_unverified'' then c.status'],
    ['customer_action', 'facebook_verified = case p_action when ''facebook_verified'' then true when ''facebook_unverified'' then false else facebook_verified end,',
                        'facebook_verified = case p_action when ''facebook_verified'' then true when ''facebook_unverified'' then false else facebook_verified end,
    address_verified = case p_action when ''address_verified'' then true when ''address_unverified'' then false else address_verified end,']
  ];
  f record; def text; new_def text; i int;
begin
  for f in select p.oid, p.proname from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and pg_get_userbyid(p.proowner) = current_user
             and p.proname in ('balance_before', 'generate_statements', 'account_due', 'customer_action')
  loop
    def := pg_get_functiondef(f.oid);
    new_def := def;
    for i in 1 .. array_length(fixes, 1) loop
      if fixes[i][1] = f.proname and position(fixes[i][3] in new_def) = 0 then
        if position(fixes[i][2] in new_def) = 0 then raise exception 'Update 1.8: % has changed; text not found: %', f.proname, left(fixes[i][2], 60); end if;
        new_def := replace(new_def, fixes[i][2], fixes[i][3]);
      end if;
    end loop;
    if new_def <> def then execute new_def; end if;
  end loop;
end $$;

-- ======== 012_update_1_9.sql ========
-- =====================================================================
-- EMON OVERRUNS E-PORTAL [[U+2014]] Update 1.9: Inventory (stock-bills)
-- 1. Stock-Bill: stock bought from a billing company, in BDT. The item table has its own columns (Item, Brand,
--    Qty, Price and Total, plus other columns, up to 10) and as many rows as needed; Qty [[U+00D7]] Price = Total.
--    It also keeps the Total Boxes, Total Qty, Batch No, Shipment No and Shipment Date.
--    Status: SHIPPED [[U+2192]] ARRIVED [[U+2192]] RELEASED [[U+2192]] SOLD [[U+2192]] PAID.
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
  -- [{"name": "Item", "type": "text"}, [[U+2026]]]; exactly one column each of type qty, price and total
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
  -- Every row is checked again here: Qty [[U+00D7]] Price = Total, and the totals of the bill come from the rows.
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
  values (new.id, 'Stock-Bill added [[U+2014]] SHIPPED', 'Total cost BDT ' || to_char(new.total_cost, 'FM999,999,999,990.00'), auth.uid(), new.created_by_name);
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
          concat_ws(' [[U+00B7]] ', 'Receipt No ' || new.receipt_no, new.description), auth.uid(), new.created_by_name);
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
    if b.status <> 'shipped' then raise exception 'Stock-Bill % is % [[U+2014]] only a SHIPPED stock-bill can be marked as ARRIVED', b.bill_no, upper(b.status); end if;
    update public.stock_bills set status = 'arrived', arrived_at = now() where id = p_id returning * into b;
  elsif p_action = 'sold' then
    if b.status <> 'released' then raise exception 'Stock-Bill % is % [[U+2014]] only a RELEASED stock-bill can be marked as SOLD', b.bill_no, upper(b.status); end if;
    if not exists (select 1 from public.stock_bill_entries x where x.stock_bill_id = p_id and x.entry_type = 'sales') then
      raise exception 'Add the net sales in the Sales Report first';
    end if;
    update public.stock_bills set status = 'sold', sold_at = now() where id = p_id returning * into b;
  elsif p_action = 'paid' then
    if b.status <> 'sold' then raise exception 'Stock-Bill % is % [[U+2014]] only a SOLD stock-bill can be marked as PAID', b.bill_no, upper(b.status); end if;
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
    res := ''Stock-Bill '' || bl.bill_no || '' is now RELEASED [[U+2014]] total cost BDT '' || to_char(bl.total_cost + o.shipping_cost, ''FM999,999,999,990.00'')
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
    values (o.stock_bill_id, o.order_no || '' deleted [[U+2014]] status back to '' || upper(prev), o.subject, auth.uid(), me);
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
            concat_ws('' [[U+00B7]] '', ''Receipt No '' || (j->>''receipt_no''), j->>''description''), auth.uid(), (select full_name from public.profiles where id = auth.uid()));
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
          jsonb_build_array(''Batch No'', coalesce(r.batch_no, ''[[U+2014]]'')), jsonb_build_array(''Shipment No'', coalesce(r.shipment_no, ''[[U+2014]]'')),
          jsonb_build_array(''Shipment Date'', coalesce(to_char(r.shipment_date, ''DD Mon YYYY''), ''[[U+2014]]'')),
          jsonb_build_array(''Release Date'', coalesce(to_char(r.release_date, ''DD Mon YYYY''), ''[[U+2014]]'')),
          jsonb_build_array(''Total Boxes / Qty'', coalesce(r.total_boxes::text, ''[[U+2014]]'') || '' / ''
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
          jsonb_build_array(''Status'', upper(r.status)), jsonb_build_array(''Approved By'', coalesce(r.approved_by_name, ''[[U+2014]]''))));
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

-- ======== 013_update_2_0.sql ========
-- =====================================================================
-- EMON OVERRUNS E-PORTAL [[U+2014]] Update 2.0: E-Bill, the Released Notice and orders that can be changed
-- 1. A stock-bill is now called an E-Bill. Its number is the company's letters, the year and a number, for example
--    MF-2026-0001 for MODINA FASHION (the first letters of the company's first and last word, like the initials
--    of a customer's account number). The batch no and the total boxes are needed on a new e-bill.
-- 2. The steps of an e-bill: 1 SHIP [[U+2192]] 2 RELEASED [[U+2192]] 3 SALES [[U+2192]] 4 PAID (no ARRIVED step). They are saved as
--    shipped, released, sold and paid, as before.
-- 3. Released Notice: the order letter for an e-bill, found by its Batch No. Price per box (PHP) [[U+00D7]] total boxes =
--    total (PHP); [[U+00D7]] the exchange rate of the day = the released charge (BDT); plus the shipping fee (BDT).
--    Once the Director approves it, the e-bill is RELEASED and the released charge and the shipping fee are added
--    to its total cost.
-- 4. Order letters are numbered EO-YYYY-MM-#### (for example EO-2026-10-0001), counted again each month.
--    Orders made before keep their numbers.
-- 5. An order waiting for approval can be changed by the person who sent it or by the Director. It is checked again
--    like a new order, keeps its number, and the change is recorded.
-- 6. Signatures: everyone can upload their signature (My Profile); the Director's counts at once, anyone else's waits
--    for the Director's approval (User). A document the Director approves prints the Director's approved signature by
--    itself, so no signed copy is uploaded; a project is approved without an uploaded approved document.
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

-- The steps of an e-bill as they are shown: 1 SHIP, 2 RELEASED, 3 SALES, 4 PAID (an e-bill marked ARRIVED before
-- this update is still at SHIP).
create or replace function public.ebill_status_name(p_status text) returns text
language sql immutable set search_path = '' as $$
  select case p_status when 'shipped' then 'SHIP' when 'arrived' then 'SHIP' when 'sold' then 'SALES' else upper(coalesce(p_status, '')) end;
$$;
revoke execute on function public.ebill_status_name(text) from public, anon;
grant execute on function public.ebill_status_name(text) to authenticated;

-- ---------- 2. e-bill number: company letters-YYYY-#### ----------
-- The first letters of the company's first and last word, leaving out Ltd, Inc, Co and the like
-- (MODINA FASHION [[U+2192]] MF, Modina Apparels Ltd [[U+2192]] MA); a one-word name gives its first two letters (ZARA [[U+2192]] ZA).
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
  -- Every row is checked again here: Qty [[U+00D7]] Price = Total, and the totals of the bill come from the rows.
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
  values (new.id, 'E-Bill added [[U+2014]] SHIP', 'Bill cost BDT ' || to_char(new.total_cost, 'FM999,999,999,990.00') || ' [[U+00B7]] ' || new.total_boxes || ' box(es)', auth.uid(), new.created_by_name);
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
    raise exception 'Net sales can be added after the e-bill is RELEASED (it is at % now)', public.ebill_status_name(b.status);
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

-- ---------- 4. steps: SALES (inventory staff), PAID (the Director); there is no ARRIVED step ----------
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
    if b.status <> 'released' then raise exception 'E-Bill % is at % [[U+2014]] only a RELEASED e-bill can be marked as SALES', b.bill_no, public.ebill_status_name(b.status); end if;
    if not exists (select 1 from public.stock_bill_entries x where x.stock_bill_id = p_id and x.entry_type = 'sales') then
      raise exception 'Add the net sales in the Sales Report first';
    end if;
    update public.stock_bills set status = 'sold', sold_at = now() where id = p_id returning * into b;
  elsif p_action = 'paid' then
    if b.status <> 'sold' then raise exception 'E-Bill % is at % [[U+2014]] only an e-bill at SALES can be marked as PAID', b.bill_no, public.ebill_status_name(b.status); end if;
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
  values (p_id, 'marked ' || public.ebill_status_name(b.status), nullif(trim(p_note), ''), auth.uid(), me);
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

-- ---------- 6. an order waiting for approval can be changed ----------
-- A new order tells the Director that it needs approval (but not the Director who made it).
create or replace function public.order_letters_after_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.notifications (user_id, title, body, link)
  select p.id, 'Order ' || new.order_no || ' needs approval', new.subject, 'order/' || new.id
  from public.profiles p where p.role = 'admin' and p.status = 'active' and p.id is distinct from auth.uid();
  return new;
end;
$$;

-- The person who sent the order, or the Director, changes it while it waits for approval. The kind of order and who it
-- is for stay the same. The changed order goes through the same checks as a new order (and its amounts are counted
-- again), keeps its number and stays WAITING FOR APPROVAL. The change is recorded and the Director is told.
create or replace function public.update_pending_order(p_id uuid, p_changes jsonb) returns public.order_letters
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare
  o public.order_letters;
  chk public.order_letters;
  j jsonb; oj jsonb; cj jsonb;
  k text;
  editable text[] := array['subject','details','resolution','order_date','amount','first_due_date','installments','installment_amount',
    'installment_every','closure_reason','adjust_type','release_date','price_per_box','exchange_rate','shipping_cost','shipping_bill_no'];
  ch jsonb := '{}'::jsonb; prev jsonb := '{}'::jsonb;
  me text := (select full_name from public.profiles where id = auth.uid());
begin
  if not public.is_active() then raise exception 'Your account is not active'; end if;
  select * into o from public.order_letters where id = p_id for update;
  if o.id is null then raise exception 'Order not found'; end if;
  if o.status <> 'pending' then
    raise exception 'Order % is already %. Only an order waiting for approval can be changed', o.order_no, upper(o.status);
  end if;
  if not (public.is_admin() or (o.created_by = auth.uid() and (
       (o.customer_id is not null and (public.can_write('orders') or public.can_write('customers')))
    or (o.employee_id is not null and public.can_write('employees'))
    or (o.company_id is not null and public.can_write('billing'))
    or (o.stock_bill_id is not null and public.can_write('inventory'))))) then
    raise exception 'Only the person who sent this order or the Director can change it';
  end if;
  if jsonb_typeof(p_changes) is distinct from 'object' then raise exception 'Nothing to change'; end if;
  select x into k from jsonb_object_keys(p_changes) x where not (x = any(editable)) limit 1;
  if k is not null then raise exception 'This cannot be changed on an order: %', k; end if;
  oj := to_jsonb(o);
  j := oj || p_changes;
  j := j || jsonb_build_object('subject', nullif(trim(j->>'subject'), ''), 'details', nullif(trim(j->>'details'), ''),
                               'resolution', nullif(trim(j->>'resolution'), ''));
  if j->>'subject' is null then raise exception 'Enter the subject'; end if;
  if j->>'details' is null then raise exception 'Write the details of the order'; end if;
  -- Checked like a new order: the changed order is saved as a new one and taken back at once; only its checked values
  -- are kept. For the check, this order is set aside, so it does not count as an order already waiting.
  perform public.allow_record_change();
  begin
    update public.order_letters set status = 'rejected' where id = p_id;
    insert into public.order_letters
    select (jsonb_populate_record(null::public.order_letters, j || jsonb_build_object('id', gen_random_uuid(), 'order_no', null))).*
    returning * into chk;
    raise exception using errcode = 'EO2CK', message = 'checked';
  exception when sqlstate 'EO2CK' then
    null;
  end;
  cj := to_jsonb(chk);
  foreach k in array editable || array['release_php','release_bdt'] loop
    if (oj->k) is distinct from (cj->k) then
      ch := ch || jsonb_build_object(k, cj->k);
      prev := prev || jsonb_build_object(k, oj->k);
    end if;
  end loop;
  if ch = '{}'::jsonb then return o; end if;
  update public.order_letters set subject = chk.subject, details = chk.details, resolution = chk.resolution, order_date = chk.order_date,
    amount = chk.amount, first_due_date = chk.first_due_date, installments = chk.installments, installment_amount = chk.installment_amount,
    installment_every = chk.installment_every, closure_reason = chk.closure_reason, adjust_type = chk.adjust_type,
    release_date = chk.release_date, price_per_box = chk.price_per_box, exchange_rate = chk.exchange_rate,
    release_php = chk.release_php, release_bdt = chk.release_bdt, shipping_cost = chk.shipping_cost, shipping_bill_no = chk.shipping_bill_no,
    stock_info = chk.stock_info, balance_due = chk.balance_due, days_overdue = chk.days_overdue
  where id = p_id returning * into o;
  insert into public.record_changes (target_table, target_id, action, changes, previous, target_label, actor, actor_name)
  values ('order_letters', p_id, 'order changed', ch, prev, o.order_no, auth.uid(), me);
  if not public.is_admin() then
    perform public.notify_admins('Order ' || o.order_no || ' was changed', o.subject, 'order/' || o.id);
  end if;
  return o;
end;
$$;
revoke execute on function public.update_pending_order(uuid, jsonb) from public, anon;
grant execute on function public.update_pending_order(uuid, jsonb) to authenticated;

-- ---------- 7. signatures ----------
-- A signature is a picture in the records storage under signature/<the person's id>/. The Director's own signature counts
-- at once; anyone else's waits until the Director approves it.
alter table public.profiles add column if not exists signature_path text;
alter table public.profiles add column if not exists signature_status text check (signature_status is null or signature_status in ('pending','approved','rejected'));
alter table public.profiles add column if not exists signature_at timestamptz;
alter table public.profiles add column if not exists signature_approved_by uuid references public.profiles(id) on delete set null;
alter table public.profiles add column if not exists signature_approved_by_name text;
alter table public.profiles add column if not exists signature_approved_at timestamptz;
alter table public.profiles add column if not exists signature_note text;
create index if not exists profiles_signature_approved_by_idx on public.profiles(signature_approved_by);

-- My own signature (p_path null takes it off).
create or replace function public.set_my_signature(p_path text) returns public.profiles
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare me public.profiles;
begin
  select * into me from public.profiles where id = auth.uid() for update;
  if me.id is null or me.status <> 'active' then raise exception 'Your account is not active'; end if;
  if p_path is not null and p_path not like 'signature/' || me.id::text || '/%' then raise exception 'Upload the signature to your own folder'; end if;
  if p_path is not null and not exists (select 1 from storage.objects o where o.bucket_id = 'records' and o.name = p_path) then
    raise exception 'The signature file was not found. Upload it again';
  end if;
  update public.profiles set signature_path = p_path, signature_at = case when p_path is null then null else now() end,
    signature_status = case when p_path is null then null when me.role = 'admin' then 'approved' else 'pending' end,
    signature_approved_by = case when p_path is not null and me.role = 'admin' then me.id end,
    signature_approved_by_name = case when p_path is not null and me.role = 'admin' then me.full_name end,
    signature_approved_at = case when p_path is not null and me.role = 'admin' then now() end,
    signature_note = null
  where id = me.id returning * into me;
  if p_path is not null and me.role <> 'admin' then
    perform public.notify_admins(coalesce(me.full_name, 'Someone') || ' uploaded a signature', 'Approve it in User', 'logins');
  end if;
  return me;
end;
$$;
revoke execute on function public.set_my_signature(text) from public, anon;
grant execute on function public.set_my_signature(text) to authenticated;

-- The Director approves or rejects someone's signature, takes it off, or uploads it for them (approved at once).
create or replace function public.signature_action(p_user uuid, p_action text, p_note text default null, p_path text default null) returns public.profiles
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare u public.profiles; me text := (select full_name from public.profiles where id = auth.uid());
begin
  if not public.is_admin() then raise exception 'Only the Director can approve signatures'; end if;
  select * into u from public.profiles where id = p_user for update;
  if u.id is null then raise exception 'User not found'; end if;
  if p_action = 'upload' then
    if p_path is null or p_path not like 'signature/' || u.id::text || '/%' then raise exception 'Upload the signature to the person''s own folder'; end if;
    if not exists (select 1 from storage.objects o where o.bucket_id = 'records' and o.name = p_path) then raise exception 'The signature file was not found. Upload it again'; end if;
    update public.profiles set signature_path = p_path, signature_at = now(), signature_status = 'approved', signature_approved_by = auth.uid(),
      signature_approved_by_name = me, signature_approved_at = now(), signature_note = nullif(trim(p_note), '')
    where id = u.id returning * into u;
  elsif p_action in ('approve','reject') then
    if u.signature_path is null then raise exception 'There is no signature to %', p_action; end if;
    if u.signature_status <> 'pending' then raise exception 'This signature is already %', upper(u.signature_status); end if;
    if p_action = 'reject' and nullif(trim(p_note), '') is null then raise exception 'Write why the signature is not approved'; end if;
    update public.profiles set signature_status = case p_action when 'approve' then 'approved' else 'rejected' end, signature_approved_by = auth.uid(),
      signature_approved_by_name = me, signature_approved_at = now(), signature_note = nullif(trim(p_note), '')
    where id = u.id returning * into u;
    perform public.notify_user(u.id, case p_action when 'approve' then 'Your signature is approved' else 'Your signature was not approved' end,
      coalesce(nullif(trim(p_note), ''), 'Your Signature Verification Form is ready in My Profile'), 'profile');
  elsif p_action = 'remove' then
    update public.profiles set signature_path = null, signature_status = null, signature_at = null, signature_approved_by = null,
      signature_approved_by_name = null, signature_approved_at = null, signature_note = nullif(trim(p_note), '')
    where id = u.id returning * into u;
  else
    raise exception 'Unknown action %', p_action;
  end if;
  return u;
end;
$$;
revoke execute on function public.signature_action(uuid, text, text, text) from public, anon;
grant execute on function public.signature_action(uuid, text, text, text) to authenticated;

-- The Directors' approved signatures, for the documents they approve (and the signature forms they approve).
create or replace function public.director_signatures() returns table (id uuid, full_name text, signature_path text)
language sql stable security definer set search_path = '' as $$
  select p.id, p.full_name, p.signature_path from public.profiles p
  where p.role = 'admin' and p.signature_status = 'approved' and p.signature_path is not null and public.is_active();
$$;
revoke execute on function public.director_signatures() from public, anon;
grant execute on function public.director_signatures() to authenticated;

-- Storage: a signature picture is seen by its owner and the Director; a Director's approved signature by everyone
-- signed in (it is printed on the documents the Director approves). Everyone may upload into their own folder.
create or replace function public.is_director_signature(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.role = 'admin' and p.signature_status = 'approved' and p.signature_path = p_name);
$$;
revoke execute on function public.is_director_signature(text) from public, anon;
grant execute on function public.is_director_signature(text) to authenticated;
drop policy if exists "storage records: signatures" on storage.objects;
create policy "storage records: signatures" on storage.objects as restrictive for select to authenticated
  using (bucket_id <> 'records' or coalesce((storage.foldername(name))[1], '') <> 'signature'
         or (storage.foldername(name))[2] = (select auth.uid())::text or (select public.is_admin()) or public.is_director_signature(name));
drop policy if exists "storage records: own signature" on storage.objects;
create policy "storage records: own signature" on storage.objects for insert to authenticated
  with check (bucket_id = 'records' and (storage.foldername(name))[1] = 'signature'
              and (storage.foldername(name))[2] = (select auth.uid())::text and (select public.is_active()));

-- ---------- 8. the other functions: created again exactly as they are now, with only these lines changed ----------

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
    -- Released Notice, found by the e-bill''s batch no: price per box (PHP) [[U+00D7]] total boxes = total (PHP);
    -- [[U+00D7]] the exchange rate of the day = the released charge (BDT); plus the shipping fee (BDT).
    if new.subject_type <> ''release'' then raise exception ''An e-bill order must be a Released Notice''; end if;
    select * into bl from public.stock_bills b where b.id = new.stock_bill_id;
    if bl.id is null then raise exception ''Choose the e-bill''; end if;
    if bl.status not in (''shipped'',''arrived'') then
      raise exception ''E-Bill % is already at %. Only an e-bill at SHIP can be released'', bl.bill_no, public.ebill_status_name(bl.status);
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
    res := ''Stock-Bill '' || bl.bill_no || '' is now RELEASED [[U+2014]] total cost BDT '' || to_char(bl.total_cost + o.shipping_cost, ''FM999,999,999,990.00'')
      || '' (shipping BDT '' || to_char(o.shipping_cost, ''FM999,999,999,990.00'') || '')'';
',
     '    if bl.id is null then raise exception ''The e-bill of this order was deleted''; end if;
    if bl.status not in (''shipped'',''arrived'') then raise exception ''E-Bill % is at % and cannot be released again'', bl.bill_no, public.ebill_status_name(bl.status); end if;
    -- the released charge and the shipping fee are added to the e-bill''s total cost
    update public.stock_bills set status = ''released'', release_date = o.release_date, shipping_cost = o.shipping_cost,
      shipping_bill_no = o.shipping_bill_no, release_order_no = o.order_no, released_at = now(),
      release_price_per_box = o.price_per_box, release_exchange_rate = o.exchange_rate, release_php = o.release_php, release_bdt = o.release_bdt
    where id = bl.id;
    insert into public.stock_bill_events (stock_bill_id, action, note, actor, actor_name)
    values (bl.id, ''released by '' || o.order_no,
      case when o.release_bdt is not null then bl.total_boxes || '' boxes [[U+00D7]] PHP '' || to_char(o.price_per_box, ''FM999,999,999,990.00'')
        || '' = PHP '' || to_char(o.release_php, ''FM999,999,999,990.00'') || '' [[U+00D7]] '' || rtrim(rtrim(to_char(o.exchange_rate, ''FM999,990.0000''), ''0''), ''.'')
        || '' = BDT '' || to_char(o.release_bdt, ''FM999,999,999,990.00'') || '' [[U+00B7]] '' else '''' end
        || ''Shipping fee BDT '' || to_char(o.shipping_cost, ''FM999,999,999,990.00''), auth.uid(), me);
    res := ''E-Bill '' || bl.bill_no || '' is now RELEASED [[U+2014]] total cost BDT ''
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
    ['undo_order', '    values (o.stock_bill_id, o.order_no || '' deleted [[U+2014]] status back to '' || upper(prev), o.subject, auth.uid(), me);',
     '    values (o.stock_bill_id, o.order_no || '' deleted [[U+2014]] status back to '' || public.ebill_status_name(prev), o.subject, auth.uid(), me);'],
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
     '''This e-bill is already at SALES or PAID, so its Released Notice cannot be deleted'''],
    ['verify_record', '-- A stock-bill shows only for the secret code of its Statistics Report (never for its number).',
     '-- An e-bill shows only for the secret code of its Statistics Report (never for its number).'],
    ['verify_record', '''type'', ''Stock-Bill Statistics''',
     '''type'', ''E-Bill Statistics'''],
    ['verify_record', 'jsonb_build_array(''Stock-Bill No'', r.bill_no)',
     'jsonb_build_array(''E-Bill No'', r.bill_no)'],
    ['verify_record', 'jsonb_build_array(''Supplier Bill No'', r.supplier_bill_no)',
     'jsonb_build_array(''Bill No'', r.supplier_bill_no)'],
    ['verify_record', 'jsonb_build_array(''Shipment No'', coalesce(r.shipment_no, ''[[U+2014]]''))',
     'jsonb_build_array(''System Record No'', coalesce(r.shipment_no, ''[[U+2014]]''))'],
    ['verify_record', 'jsonb_build_array(''Release Date'', coalesce(to_char(r.release_date, ''DD Mon YYYY''), ''[[U+2014]]''))',
     'jsonb_build_array(''Released Date'', coalesce(to_char(r.release_date, ''DD Mon YYYY''), ''[[U+2014]]''))'],
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
     'jsonb_build_array(''Type'', ''Released Notice'' || coalesce('' '' || r.batch_no, ''''))'],
    ['project_action', '    if not exists (select 1 from public.attachments a where a.owner_type = ''project'' and a.owner_id = p_id and a.kind = ''approval'') then
      raise exception ''Upload the approved project document first'';
    end if;
',
     '    -- 2.0: no uploaded approved document is needed: the Director''s signature is printed on the approved project
']
  ];
  f record; def text; new_def text; i int;
begin
  for f in select p.oid, p.proname from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and pg_get_userbyid(p.proowner) = current_user
             and p.proname in ('order_letters_before_insert', 'carry_out_order', 'undo_order', 'pay_vouchers_before_insert', 'delete_record', 'verify_record', 'project_action')
  loop
    def := pg_get_functiondef(f.oid);
    new_def := def;
    for i in 1 .. array_length(fixes, 1) loop
      -- changed once: when the new text is already there (the script was run before), nothing is changed
      if fixes[i][1] = f.proname and position(fixes[i][3] in new_def) = 0 then
        if position(fixes[i][2] in new_def) = 0 then raise exception 'Update 2.0: % has changed; text not found: %', f.proname, left(fixes[i][2], 60); end if;
        new_def := replace(new_def, fixes[i][2], fixes[i][3]);
      end if;
    end loop;
    if new_def <> def then execute new_def; end if;
  end loop;
end $$;

-- ======== 014_update_2_1.sql ========
-- =====================================================================
-- EMON OVERRUNS E-PORTAL [[U+2014]] Update 2.1: Director Portal, memo payments on e-bills, shipping company, deletes for good
-- 1. A memo to a company (Director Portal, before called Order Letter) can have an amount in PESOS with the exchange
--    rate of the day: the amount in BDT is counted by itself (PHP [[U+00D7]] rate, for example [[U+00D7]] 2.01). The memo can name one
--    e-bill of that company: once the Director approves the memo, the BDT amount is paid on that e-bill. The e-bill's
--    balance goes down; its total cost and its profit stay the same.
-- 2. E-Bill (before called Inventory): the shipping company's name and code.
-- 3. Sales Report lines can still be added after an e-bill is PAID.
-- 4. Billing no longer pays e-bills (a payment voucher linked to an e-bill before still counts as paid).
-- 5. What the Director deletes is gone for good: no "deleted" line is written in any history, and the history lines
--    and notices the record made go with it. The old "deleted" lines, and the lines and notices of records deleted
--    before, are removed once.
-- 6. Project budget: each line is its description and amount (the main figure); the qty is optional, and there is no
--    unit cost any more.
-- 7. A customer's LOCATION check takes the place of the address check: FOUND, NO NEED TO CHECK LOCATION or NOT FOUND.
-- 8. A correction the Director approves changes the record and leaves no history: the request, its notices and the log
--    line are not kept. The approved corrections kept before are removed once.
-- 9. The customer check: the Facebook link of a customer, and the same person cannot open a second account (the same
--    Facebook link as another account, or the same name or Facebook name as a CLOSED account).
-- Run once in the Supabase SQL Editor after 013_update_2_0.sql. It is safe to run again.
-- =====================================================================

-- ---------- 1. memo payments ----------
-- the memo's amount in BDT (amount in PHP [[U+00D7]] exchange rate) and the e-bill it pays. The e-bill is checked when the memo
-- is saved, and an e-bill named in a memo cannot be deleted (delete_record). It has no foreign key on purpose: a second
-- link from order_letters to stock_bills would make the app's order lists ambiguous.
alter table public.order_letters add column if not exists amount_bdt numeric(14,2);
alter table public.order_letters add column if not exists memo_bill_id uuid;
alter table public.order_letters drop constraint if exists order_letters_memo_bill_id_fkey;
create index if not exists order_letters_memo_bill_idx on public.order_letters(memo_bill_id);

-- A memo's payment on an e-bill: made when the Director approves the memo, and removed with the memo.
create table if not exists public.stock_bill_payments (
  id uuid primary key default gen_random_uuid(),
  stock_bill_id uuid not null references public.stock_bills(id) on delete cascade,
  order_id uuid not null unique references public.order_letters(id) on delete cascade,
  order_no text not null,
  pay_date date not null,
  subject text,
  amount_php numeric(14,2) not null check (amount_php > 0),
  exchange_rate numeric(12,4) not null check (exchange_rate > 0),
  amount_bdt numeric(14,2) not null check (amount_bdt > 0),
  approved_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists stock_bill_payments_bill_idx on public.stock_bill_payments(stock_bill_id);
alter table public.stock_bill_payments enable row level security;
drop policy if exists "sbp: read" on public.stock_bill_payments;
create policy "sbp: read" on public.stock_bill_payments for select to authenticated
  using ((select public.has_module('inventory')) or (select public.has_module('billing')));
drop trigger if exists keep_records on public.stock_bill_payments;
create trigger keep_records before update or delete on public.stock_bill_payments for each row execute function public.keep_records();
drop trigger if exists keep_records_truncate on public.stock_bill_payments;
create trigger keep_records_truncate before truncate on public.stock_bill_payments for each statement execute function public.keep_records();

-- ---------- 2. the shipping company of an e-bill ----------
alter table public.stock_bills add column if not exists shipping_company text;
alter table public.stock_bills add column if not exists shipping_company_code text;

-- ---------- 3. totals: what is paid and the balance ----------
-- Paid = the memo payments (and the payment vouchers linked before 2.1); Balance = total cost [[U+2212]] paid.
-- (the columns stay in the same order; the new ones are at the end)
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
    (coalesce(v.paid, 0) + coalesce(m.paid, 0))::numeric(14,2) as paid_bdt,
    coalesce(v.vouchers, 0)::int as vouchers_count,
    case when b.status = 'paid' and (select public.has_module('inventory')) then
      (coalesce(e.net_sales, 0) - (b.total_cost + coalesce(b.release_bdt, 0) + coalesce(b.shipping_cost, 0) + coalesce(e.eoo_fees, 0) + coalesce(e.other_fees, 0) + coalesce(e.penalties, 0)))::numeric(14,2) end as profit,
    b.release_price_per_box, b.release_exchange_rate, b.release_php, b.release_bdt,
    b.shipping_company, b.shipping_company_code,
    coalesce(m.paid, 0)::numeric(14,2) as memo_paid_bdt,
    coalesce(m.memos, 0)::int as memos_count,
    (b.total_cost + coalesce(b.release_bdt, 0) + coalesce(b.shipping_cost, 0) - coalesce(v.paid, 0) - coalesce(m.paid, 0))::numeric(14,2) as balance_bdt
  from public.stock_bills b
  left join public.pay_companies pc on pc.id = b.company_id
  left join lateral (select sum(x.amount) filter (where x.entry_type = 'sales') as net_sales,
                            sum(x.amount) filter (where x.entry_type = 'eoo_fee') as eoo_fees,
                            sum(x.amount) filter (where x.entry_type = 'fee') as other_fees,
                            sum(x.amount) filter (where x.entry_type = 'penalty') as penalties
                     from public.stock_bill_entries x where x.stock_bill_id = b.id) e on true
  left join lateral (select sum(p.amount_bdt) as paid, count(*) as vouchers from public.pay_vouchers p where p.stock_bill_id = b.id) v on true
  left join lateral (select sum(p.amount_bdt) as paid, count(*) as memos from public.stock_bill_payments p where p.stock_bill_id = b.id) m on true;
revoke select on public.stock_bill_totals from anon;
grant select on public.stock_bill_totals to authenticated;

-- The e-bills of a company with what is paid and the balance, for a memo (the Director, or Billing staff who write memos).
create or replace function public.memo_ebills(p_company uuid)
returns table (id uuid, bill_no text, batch_no text, status text, bill_date date, total_bdt numeric, paid_bdt numeric, balance_bdt numeric)
language sql stable security definer set search_path = '' set timezone to 'Asia/Manila' as $$
  select t.id, t.bill_no, t.batch_no, t.status, t.bill_date, t.bill_total, t.paid_bdt, t.balance_bdt
  from public.stock_bill_totals t
  where t.company_id = p_company and (public.is_admin() or public.can_write('billing'))
  order by t.bill_date desc, t.bill_no desc;
$$;
revoke execute on function public.memo_ebills(uuid) from public, anon;
grant execute on function public.memo_ebills(uuid) to authenticated;

-- ---------- 4. Project budget: the amount is the main figure, the qty is optional ----------
-- A budget line is its description and its amount; the qty can be left empty (it is only shown). Lines saved before
-- keep their amount (it was qty [[U+00D7]] unit cost).
alter table public.project_items alter column amount drop expression if exists;
alter table public.project_items alter column qty drop not null;
alter table public.project_items alter column qty drop default;
alter table public.project_items alter column unit_cost drop not null;
alter table public.project_items alter column unit_cost drop default;
alter table public.project_items drop constraint if exists project_items_qty_check;
alter table public.project_items add constraint project_items_qty_check check (qty is null or qty > 0);
alter table public.project_items drop constraint if exists project_items_amount_check;
alter table public.project_items add constraint project_items_amount_check check (amount is not null and amount >= 0);

create or replace function public.project_items_before_insert() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.description := nullif(trim(new.description), '');
  if new.description is null then raise exception 'Write the description of each budget line'; end if;
  -- a line made the old way (qty [[U+00D7]] unit cost) gets its amount from them
  if new.amount is null and new.qty is not null and new.unit_cost is not null then new.amount := round(new.qty * new.unit_cost, 2); end if;
  if new.amount is null or new.amount <= 0 then raise exception 'Enter the amount of each budget line'; end if;
  return new;
end;
$$;
revoke execute on function public.project_items_before_insert() from public, anon, authenticated;
drop trigger if exists project_items_bi on public.project_items;
create trigger project_items_bi before insert on public.project_items for each row execute function public.project_items_before_insert();

-- ---------- 4b. a customer's LOCATION check: found, no need to check, or not found ----------
-- It takes the place of the address check (verified or not): an address verified before is FOUND, one not verified is
-- NOT FOUND. The old yes/no field stays in step with it (FOUND = yes).
alter table public.customers add column if not exists location_check text;
do $$
begin
  if exists (select 1 from public.customers where location_check is null) then
    perform public.allow_record_change();
    update public.customers set location_check = case when address_verified then 'found' else 'not_found' end where location_check is null;
  end if;
end $$;
alter table public.customers drop constraint if exists customers_location_check_check;
alter table public.customers add constraint customers_location_check_check check (location_check in ('found','no_need','not_found'));
alter table public.customers alter column location_check set not null;

create or replace function public.customers_location_before_insert() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- an app before 2.1 sends only the address check (yes or no)
  new.location_check := coalesce(new.location_check, case when new.address_verified then 'found' else 'not_found' end);
  new.address_verified := new.location_check = 'found';
  return new;
end;
$$;
revoke execute on function public.customers_location_before_insert() from public, anon, authenticated;
drop trigger if exists customers_location_bi on public.customers;
create trigger customers_location_bi before insert on public.customers for each row execute function public.customers_location_before_insert();

-- ---------- 4c. the customer check: the same person cannot open a second account ----------
-- A customer can have the link of their Facebook account. The check looks only at the name, the Facebook name and the
-- Facebook link (not the address, phone or email). BLOCKED: the same Facebook link as another account (one that was not
-- rejected), or the same name or Facebook name as a CLOSED account. The same name as an open account is only a warning
-- (two people can have the same name).
alter table public.customers add column if not exists facebook_link text;

-- A Facebook link made comparable, whatever way it was copied (https://, www., m., fb.com, a slash at the end, ?[[U+2026]] after
-- it): id:<number> for a numeric profile, u:<username>, p:<path> for a share link or page, x:<link> for any other site.
-- Empty when there is no link.
create or replace function public.facebook_key(p_link text) returns text
language sql immutable set search_path = '' as $$
  select case
    when raw = '' then null
    -- a link of another website: compared as it is
    when not fb and raw ~ '[/:]' then 'x:' || regexp_replace(raw, '/+$', '')
    when p ~ '^profile\.php$' then 'id:' || nullif(substring(q from '(?:^|&)id=([0-9]+)'), '')
    when p ~ '^people/[^/]+/[0-9]+' then 'id:' || substring(p from '^people/[^/]+/([0-9]+)')
    when split_part(p, '/', 1) ~ '^[0-9]+$' then 'id:' || split_part(p, '/', 1)
    when split_part(p, '/', 1) in ('share', 'p', 'pages', 'groups', 'people', 'story.php', 'permalink.php', 'photo.php') then 'p:' || p
    when p = '' then null
    else 'u:' || split_part(p, '/', 1) end
  from (select raw, fb, regexp_replace(split_part(k, '?', 1), '/+$', '') as p, coalesce(substring(k from '\?(.*)$'), '') as q
        from (select raw, fb, case when fb then regexp_replace(raw, '^(https?://)?((www|m|web|mbasic|touch|mobile)\.)?(facebook\.com|fb\.com|fb\.me)(/|$)', '')
                                   else ltrim(raw, '@') end as k
              from (select raw, raw ~ '^(https?://)?((www|m|web|mbasic|touch|mobile)\.)?(facebook\.com|fb\.com|fb\.me)(/|$)' as fb
                    from (select regexp_replace(lower(trim(coalesce(p_link, ''))), '#.*$', '') as raw) r0) r1) r2) r3;
$$;

-- Every account that may be the same person (internal: used by the checks below).
create or replace function public.customer_matches(p_first text, p_last text, p_fb_name text, p_fb_extra text, p_fb_link text, p_except uuid default null)
returns table (id uuid, account_no text, first_name text, last_name text, phone text, email text, facebook_name text, facebook_link text,
  status text, matched_on text, blocked boolean)
language sql stable security definer set search_path = '' as $$
  with me as (
    select lower(regexp_replace(trim(coalesce(p_first, '')), '\s+', ' ', 'g')) as f, lower(regexp_replace(trim(coalesce(p_last, '')), '\s+', ' ', 'g')) as l,
      array_remove(array[nullif(lower(regexp_replace(trim(coalesce(p_fb_name, '')), '\s+', ' ', 'g')), ''),
                         nullif(lower(regexp_replace(trim(coalesce(p_fb_extra, '')), '\s+', ' ', 'g')), '')], null) as fb,
      public.facebook_key(p_fb_link) as k)
  select o.id, o.account_no, o.first_name, o.last_name, o.phone, o.email, o.facebook_name, o.facebook_link, o.status,
    concat_ws(', ', case when x.by_name then 'name' end, case when x.by_fb then 'Facebook name' end, case when x.by_link then 'Facebook link' end),
    (x.by_link and o.status <> 'rejected') or ((x.by_name or x.by_fb) and o.status = 'closed')
  from public.customers o cross join me
  cross join lateral (select
      me.f <> '' and me.l <> '' and lower(regexp_replace(trim(o.first_name), '\s+', ' ', 'g')) = me.f
        and lower(regexp_replace(trim(o.last_name), '\s+', ' ', 'g')) = me.l as by_name,
      cardinality(me.fb) > 0 and array_remove(array[nullif(lower(regexp_replace(trim(coalesce(o.facebook_name, '')), '\s+', ' ', 'g')), ''),
        nullif(lower(regexp_replace(trim(coalesce(o.extra_facebook_name, '')), '\s+', ' ', 'g')), '')], null) && me.fb as by_fb,
      me.k is not null and public.facebook_key(o.facebook_link) = me.k as by_link) x
  where (p_except is null or o.id <> p_except) and (x.by_name or x.by_fb or x.by_link)
  order by 11 desc, o.created_at;
$$;
revoke execute on function public.customer_matches(text, text, text, text, text, uuid) from public, anon, authenticated;

-- Why this person cannot open an account (empty when they can).
create or replace function public.customer_block_reason(p_first text, p_last text, p_fb_name text, p_fb_extra text, p_fb_link text, p_except uuid default null)
returns text language sql stable security definer set search_path = '' as $$
  select 'This person cannot open an account: ' || case
      when m.matched_on like '%Facebook link%' then 'the same Facebook link is on account ' || coalesce(m.account_no, '') || ' (' || upper(m.status) || ')'
      else 'account ' || coalesce(m.account_no, '') || ' with the same ' || m.matched_on || ' was CLOSED' end || '.'
  from public.customer_matches(p_first, p_last, p_fb_name, p_fb_extra, p_fb_link, p_except) m
  where m.blocked limit 1;
$$;
revoke execute on function public.customer_block_reason(text, text, text, text, text, uuid) from public, anon, authenticated;

-- The check of a saved application (Check & Verify): the Director, or staff who add customers.
drop function if exists public.customer_duplicates(uuid);
create function public.customer_duplicates(p_id uuid)
returns table (id uuid, account_no text, first_name text, last_name text, phone text, email text, facebook_name text, facebook_link text,
  status text, matched_on text, blocked boolean)
language sql stable security definer set search_path = '' as $$
  select m.* from public.customers c
  cross join lateral public.customer_matches(c.first_name, c.last_name, c.facebook_name, c.extra_facebook_name, c.facebook_link, c.id) m
  where c.id = p_id and (public.is_admin() or public.can_write('customers'));
$$;
revoke execute on function public.customer_duplicates(uuid) from public, anon;
grant execute on function public.customer_duplicates(uuid) to authenticated;

-- The same check while a new application is typed (before it is saved).
create or replace function public.customer_person_check(p_first text, p_last text, p_fb_name text, p_fb_extra text, p_fb_link text)
returns table (id uuid, account_no text, first_name text, last_name text, phone text, email text, facebook_name text, facebook_link text,
  status text, matched_on text, blocked boolean)
language sql stable security definer set search_path = '' as $$
  select m.* from public.customer_matches(p_first, p_last, p_fb_name, p_fb_extra, p_fb_link) m
  where public.is_admin() or public.can_write('customers');
$$;
revoke execute on function public.customer_person_check(text, text, text, text, text) from public, anon;
grant execute on function public.customer_person_check(text, text, text, text, text) to authenticated;

-- A new application of a person who cannot open an account is refused.
create or replace function public.customers_check_person() returns trigger
language plpgsql security definer set search_path = '' as $$
declare why text;
begin
  new.facebook_link := nullif(trim(new.facebook_link), '');
  why := public.customer_block_reason(new.first_name, new.last_name, new.facebook_name, new.extra_facebook_name, new.facebook_link, new.id);
  if why is not null then raise exception '%', why; end if;
  return new;
end;
$$;
revoke execute on function public.customers_check_person() from public, anon, authenticated;
drop trigger if exists customers_check_person_bi on public.customers;
create trigger customers_check_person_bi before insert on public.customers for each row execute function public.customers_check_person();

-- (customer_action, in the block below, checks again before an application is verified or approved)
create or replace function public.customer_raise_if_blocked(p_id uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
declare why text;
begin
  select public.customer_block_reason(c.first_name, c.last_name, c.facebook_name, c.extra_facebook_name, c.facebook_link, c.id) into why
  from public.customers c where c.id = p_id;
  if why is not null then raise exception '%', why; end if;
end;
$$;
revoke execute on function public.customer_raise_if_blocked(uuid) from public, anon, authenticated;

-- ---------- 5. changed functions (in the block below) ----------
-- order_letters_before_insert: a company memo's amount (PHP), exchange rate and BDT amount, and the e-bill it pays.
-- update_pending_order: the e-bill of a memo can be changed while the memo waits for approval.
-- carry_out_order: an approved memo pays its BDT amount on the e-bill it names.
-- stock_bills_before_insert, editable_columns: the shipping company's name and code.
-- stock_bill_entries_before_insert: Sales Report lines after PAID.
-- delete_record, undo_order, remove_attachment: what the Director deletes leaves no line in any history.
-- verify_record: an e-bill's secret code shows what is paid, the balance and the shipping company.
-- customer_action: the Director sets a customer's location check (found, no need to check, not found).
-- decide_change_request: an approved correction changes the record and leaves no history.
-- customer_action (again): an application of a person who cannot open an account is not verified or approved.
-- editable_columns: the Facebook link of a customer can be corrected.
do $$
declare
  -- function name, the exact old text, the new text
  fixes text[][] := array[
    ['order_letters_before_insert', 'declare kind text; d jsonb; bl public.stock_bills;
',
     'declare kind text; d jsonb; bl public.stock_bills; mb public.stock_bills;
'],
    ['order_letters_before_insert', '  else
    new.release_date := null; new.shipping_cost := null; new.shipping_bill_no := null; new.stock_info := null;
    new.price_per_box := null; new.exchange_rate := null; new.release_php := null; new.release_bdt := null;
  end if;
',
     '  else
    new.release_date := null; new.shipping_cost := null; new.shipping_bill_no := null; new.stock_info := null;
    new.price_per_box := null; new.release_php := null; new.release_bdt := null;
    if not (kind = ''company'' and new.subject_type = ''memo'') then new.exchange_rate := null; end if;
  end if;
  -- 2.1: a memo to a company can have an amount in PESOS and the exchange rate of the day: the amount in BDT is counted
  -- (PHP [[U+00D7]] rate). The memo can name one e-bill of the company: once approved, the BDT amount is paid on that e-bill.
  if kind = ''company'' and new.subject_type = ''memo'' then
    if new.memo_bill_id is not null then
      select * into mb from public.stock_bills b where b.id = new.memo_bill_id;
      if mb.id is null or mb.company_id is distinct from new.company_id then raise exception ''Choose an e-bill of this company''; end if;
      if new.amount is null then raise exception ''Enter the memo amount in PESOS: it is paid on E-Bill %'', mb.bill_no; end if;
    end if;
    if new.amount is not null and new.amount <= 0 then raise exception ''The memo amount must be more than 0''; end if;
    if new.amount is not null and coalesce(new.exchange_rate, 0) <= 0 then raise exception ''Enter the exchange rate (BDT for 1 PHP)''; end if;
    if new.amount is null then new.exchange_rate := null; end if;
    new.amount_bdt := round(new.amount * new.exchange_rate, 2);
    new.stock_info := case when mb.id is not null then jsonb_build_object(''bill_no'', mb.bill_no, ''batch_no'', mb.batch_no, ''status'', mb.status,
      ''total_cost'', mb.total_cost + coalesce(mb.release_bdt, 0) + coalesce(mb.shipping_cost, 0)) end;
  else
    new.amount_bdt := null; new.memo_bill_id := null;
  end if;
'],
    ['update_pending_order', '''release_date'',''price_per_box'',''exchange_rate'',''shipping_cost'',''shipping_bill_no''];',
     '''release_date'',''price_per_box'',''exchange_rate'',''shipping_cost'',''shipping_bill_no'',''memo_bill_id''];'],
    ['update_pending_order', 'foreach k in array editable || array[''release_php'',''release_bdt''] loop',
     'foreach k in array editable || array[''release_php'',''release_bdt'',''amount_bdt''] loop'],
    ['update_pending_order', 'shipping_bill_no = chk.shipping_bill_no,
    stock_info = chk.stock_info,',
     'shipping_bill_no = chk.shipping_bill_no,
    amount_bdt = chk.amount_bdt, memo_bill_id = chk.memo_bill_id,
    stock_info = chk.stock_info,'],
    ['carry_out_order', '  bl public.stock_bills;
  newst text;
',
     '  bl public.stock_bills;
  bill_total numeric;
  paid_before numeric;
  newst text;
'],
    ['carry_out_order', '    if newst is not null then
      update public.pay_companies set status = newst, status_note = o.order_no || '': '' || o.subject where id = pc.id;
      res := pc.name || '' is now '' || upper(newst);
    else
      res := ''Memo recorded for '' || pc.name;
    end if;
',
     '    if newst is not null then
      update public.pay_companies set status = newst, status_note = o.order_no || '': '' || o.subject where id = pc.id;
      res := pc.name || '' is now '' || upper(newst);
    elsif o.memo_bill_id is not null and o.amount_bdt > 0 then
      -- 2.1: the memo pays its BDT amount on the e-bill it names (the e-bill''s balance goes down)
      select * into bl from public.stock_bills where id = o.memo_bill_id for update;
      if bl.id is null then raise exception ''The e-bill of this memo was deleted''; end if;
      bill_total := bl.total_cost + coalesce(bl.release_bdt, 0) + coalesce(bl.shipping_cost, 0);
      paid_before := coalesce((select sum(p.amount_bdt) from public.stock_bill_payments p where p.stock_bill_id = bl.id), 0)
        + coalesce((select sum(v.amount_bdt) from public.pay_vouchers v where v.stock_bill_id = bl.id), 0);
      insert into public.stock_bill_payments (stock_bill_id, order_id, order_no, pay_date, subject, amount_php, exchange_rate, amount_bdt, approved_by_name)
      values (bl.id, o.id, o.order_no, current_date, o.subject, o.amount, o.exchange_rate, o.amount_bdt, me);
      insert into public.stock_bill_events (stock_bill_id, action, note, actor, actor_name)
      values (bl.id, ''paid by memo '' || o.order_no, ''PHP '' || to_char(o.amount, ''FM999,999,999,990.00'') || '' [[U+00D7]] ''
        || rtrim(rtrim(to_char(o.exchange_rate, ''FM999,990.0000''), ''0''), ''.'') || '' = BDT '' || to_char(o.amount_bdt, ''FM999,999,999,990.00'')
        || '' [[U+00B7]] balance BDT '' || to_char(bill_total - paid_before - o.amount_bdt, ''FM999,999,999,990.00''), auth.uid(), me);
      update public.order_letters set stock_info = coalesce(stock_info, ''{}''::jsonb) || jsonb_build_object(''bill_no'', bl.bill_no, ''batch_no'', bl.batch_no,
        ''status'', bl.status, ''total_cost'', bill_total, ''paid_before'', paid_before, ''balance_after'', bill_total - paid_before - o.amount_bdt)
      where id = o.id;
      res := ''Memo recorded for '' || pc.name || '': BDT '' || to_char(o.amount_bdt, ''FM999,999,999,990.00'') || '' paid on E-Bill '' || bl.bill_no
        || coalesce('' (Batch No '' || bl.batch_no || '')'', '''') || '' [[U+2014]] balance BDT '' || to_char(bill_total - paid_before - o.amount_bdt, ''FM999,999,999,990.00'');
    else
      res := ''Memo recorded for '' || pc.name
        || coalesce('': PHP '' || to_char(o.amount, ''FM999,999,999,990.00'') || '' = BDT '' || to_char(o.amount_bdt, ''FM999,999,999,990.00''), '''');
    end if;
'],
    ['undo_order', '    insert into public.stock_bill_events (stock_bill_id, action, note, actor, actor_name)
    values (o.stock_bill_id, o.order_no || '' deleted [[U+2014]] status back to '' || public.ebill_status_name(prev), o.subject, auth.uid(), me);
',
     '    -- 2.1: no line is written in the history (the order''s own line is removed by delete_record)
'],
    ['undo_order', '    insert into public.customer_events (customer_id, action, note, actor, actor_name)
    values (o.customer_id, o.order_no || '' deleted [[U+2014]] status back to '' || upper(prev), o.subject, auth.uid(), me);
',
     ''],
    ['delete_record', '  if p_table = ''stock_bills'' and exists (select 1 from public.pay_vouchers x where x.stock_bill_id = p_id) then
    raise exception ''This e-bill has payments in Billing. Delete those payment vouchers first'';
  end if;
  if p_table = ''order_letters'' and j->>''status'' = ''applied''
',
     '  if p_table = ''stock_bills'' and exists (select 1 from public.pay_vouchers x where x.stock_bill_id = p_id) then
    raise exception ''This e-bill has payments in Billing. Delete those payment vouchers first'';
  end if;
  if p_table = ''stock_bills'' and exists (select 1 from public.order_letters x where x.memo_bill_id = p_id) then
    raise exception ''This e-bill is named in memo %. Delete the memo first'',
      (select string_agg(x.order_no, '', '' order by x.order_no) from public.order_letters x where x.memo_bill_id = p_id);
  end if;
  if p_table = ''order_letters'' and j->>''status'' = ''applied''
'],
    ['delete_record', '  if p_table = ''stock_bill_entries'' then
    insert into public.stock_bill_events (stock_bill_id, action, note, actor, actor_name)
    values ((j->>''stock_bill_id'')::uuid,
            case j->>''entry_type'' when ''sales'' then ''net sales'' when ''eoo_fee'' then ''EOO fee'' when ''fee'' then ''fee'' else ''penalty'' end
              || '' BDT '' || to_char((j->>''amount'')::numeric, ''FM999,999,999,990.00'') || '' deleted'',
            concat_ws('' [[U+00B7]] '', ''Receipt No '' || (j->>''receipt_no''), j->>''description''), auth.uid(), (select full_name from public.profiles where id = auth.uid()));
  end if;
',
     '  -- 2.1: what the Director deletes is gone for good: no "deleted" line, and the history lines and notices it made go too
  if p_table = ''stock_bill_entries'' then
    delete from public.stock_bill_events x where x.id = (select y.id from public.stock_bill_events y
      where y.stock_bill_id = (j->>''stock_bill_id'')::uuid and y.created_at = (j->>''created_at'')::timestamptz
        and y.action = case j->>''entry_type'' when ''sales'' then ''net sales'' when ''eoo_fee'' then ''EOO fee'' when ''fee'' then ''fee'' else ''penalty'' end
          || '' BDT '' || to_char((j->>''amount'')::numeric, ''FM999,999,999,990.00'') || '' added''
      order by y.id limit 1);
  end if;
  if p_table = ''order_letters'' then
    delete from public.customer_events x where x.customer_id = (j->>''customer_id'')::uuid and right(x.action, length(j->>''order_no'') + 4) = '' by '' || (j->>''order_no'');
    delete from public.stock_bill_events x where x.stock_bill_id in ((j->>''stock_bill_id'')::uuid, (j->>''memo_bill_id'')::uuid)
      and x.action in (''released by '' || (j->>''order_no''), ''paid by memo '' || (j->>''order_no''));
  end if;
  delete from public.notifications n where n.link = case p_table when ''customers'' then ''customer/'' when ''order_letters'' then ''order/''
    when ''job_applications'' then ''jobapp/'' when ''credit_memos'' then ''creditmemo/'' when ''employees'' then ''employee/'' end || p_id::text;
'],
    ['remove_attachment', '    insert into public.customer_events (customer_id, action, note, actor, actor_name)
    values (a.owner_id, ''file removed'', a.file_name, auth.uid(), me);
',
     '    -- 2.1: a file the Director removes leaves no line in any history
    if not public.is_admin() then
      insert into public.customer_events (customer_id, action, note, actor, actor_name)
      values (a.owner_id, ''file removed'', a.file_name, auth.uid(), me);
    end if;
'],
    ['remove_attachment', '  if a.owner_type in (''stock_bill'',''stock_bill_entry'') then
',
     '  if a.owner_type in (''stock_bill'',''stock_bill_entry'') and not public.is_admin() then
'],
    ['remove_attachment', '  insert into public.record_changes (target_table, target_id, action, changes, previous, target_label, actor, actor_name)
  values (tbl, a.owner_id, ''file removed'', jsonb_build_object(''file'', ''''), jsonb_build_object(''file'', a.file_name), a.file_name, auth.uid(), me);
',
     '  if not public.is_admin() then
    insert into public.record_changes (target_table, target_id, action, changes, previous, target_label, actor, actor_name)
    values (tbl, a.owner_id, ''file removed'', jsonb_build_object(''file'', ''''), jsonb_build_object(''file'', a.file_name), a.file_name, auth.uid(), me);
  end if;
'],
    ['stock_bill_entries_before_insert', '  if b.status = ''paid'' then raise exception ''E-Bill % is PAID and closed. Nothing more can be added to it'', b.bill_no; end if;
  if new.entry_type = ''sales'' and b.status not in (''released'',''sold'') then
',
     '  -- 2.1: Sales Report lines can still be added after the e-bill is PAID
  if new.entry_type = ''sales'' and b.status not in (''released'',''sold'',''paid'') then
'],
    ['stock_bills_before_insert', '  new.shipment_no := nullif(trim(new.shipment_no), '''');
  ini := public.company_initials(',
     '  new.shipment_no := nullif(trim(new.shipment_no), '''');
  -- 2.1: the shipping company''s name and code
  new.shipping_company := nullif(trim(new.shipping_company), '''');
  new.shipping_company_code := nullif(trim(new.shipping_company_code), '''');
  ini := public.company_initials('],
    ['editable_columns', 'when ''stock_bills'' then array[''supplier_bill_no'',''batch_no'',''shipment_no'',''shipment_date'',''total_boxes'',''notes'']',
     'when ''stock_bills'' then array[''supplier_bill_no'',''batch_no'',''shipment_no'',''shipment_date'',''total_boxes'',''notes'',''shipping_company'',''shipping_company_code'']'],
    ['verify_record', '    -- An e-bill shows only for the secret code of its Statistics Report (never for its number).
',
     '    -- An e-bill shows only for its secret code, printed on the E-Bill once it is PAID (never for its number).
'],
    ['verify_record', '      coalesce((select sum(x.amount) from public.stock_bill_entries x where x.stock_bill_id = b.id and x.entry_type = ''penalty''), 0) as penalties
      into r from',
     '      coalesce((select sum(x.amount) from public.stock_bill_entries x where x.stock_bill_id = b.id and x.entry_type = ''penalty''), 0) as penalties,
      coalesce((select sum(p.amount_bdt) from public.stock_bill_payments p where p.stock_bill_id = b.id), 0)
        + coalesce((select sum(v.amount_bdt) from public.pay_vouchers v where v.stock_bill_id = b.id), 0) as paid_bdt
      into r from'],
    ['verify_record', '''type'', ''E-Bill Statistics'',',
     '''type'', ''E-Bill'','],
    ['verify_record', '          jsonb_build_array(''Shipment Date'', coalesce(to_char(r.shipment_date, ''DD Mon YYYY''), ''[[U+2014]]'')),
          jsonb_build_array(''Released Date'', coalesce(to_char(r.release_date, ''DD Mon YYYY''), ''[[U+2014]]'')),
',
     '          jsonb_build_array(''Shipment Date'', coalesce(to_char(r.shipment_date, ''DD Mon YYYY''), ''[[U+2014]]'')),
          case when r.shipping_company is not null or r.shipping_company_code is not null then
            jsonb_build_array(''Shipping Company'', concat_ws('' [[U+00B7]] Code '', r.shipping_company, r.shipping_company_code)) end,
          jsonb_build_array(''Released Date'', coalesce(to_char(r.release_date, ''DD Mon YYYY''), ''[[U+2014]]'')),
'],
    ['verify_record', '          jsonb_build_array(''Total Cost (BDT)'', to_char(r.total_cost + coalesce(r.release_bdt, 0) + coalesce(r.shipping_cost, 0), ''FM999,999,999,990.00'')),
          jsonb_build_array(''EOO Fees (BDT)'',',
     '          jsonb_build_array(''Total Cost (BDT)'', to_char(r.total_cost + coalesce(r.release_bdt, 0) + coalesce(r.shipping_cost, 0), ''FM999,999,999,990.00'')),
          jsonb_build_array(''Paid (BDT)'', to_char(r.paid_bdt, ''FM999,999,999,990.00'')),
          jsonb_build_array(''Balance (BDT)'', to_char(r.total_cost + coalesce(r.release_bdt, 0) + coalesce(r.shipping_cost, 0) - r.paid_bdt, ''FM999,999,999,990.00'')),
          jsonb_build_array(''EOO Fees (BDT)'','],
    ['customer_action', '    when ''address_unverified'' then c.status
    else null end;',
     '    when ''address_unverified'' then c.status
    when ''location_found'' then c.status
    when ''location_no_need'' then c.status
    when ''location_not_found'' then c.status
    else null end;'],
    ['customer_action', '    address_verified = case p_action when ''address_verified'' then true when ''address_unverified'' then false else address_verified end,
',
     '    -- 2.1: the location check (the old address check stays in step with it: FOUND = verified)
    address_verified = case when p_action in (''address_verified'',''location_found'') then true
      when p_action in (''address_unverified'',''location_no_need'',''location_not_found'') then false else address_verified end,
    location_check = case when p_action in (''address_verified'',''location_found'') then ''found'' when p_action = ''location_no_need'' then ''no_need''
      when p_action in (''address_unverified'',''location_not_found'') then ''not_found'' else location_check end,
'],
    ['customer_action', '  values (p_id, replace(p_action, ''_'', '' ''), p_note,',
     '  values (p_id, case p_action when ''location_found'' then ''location: found'' when ''location_no_need'' then ''location: no need to check''
    when ''location_not_found'' then ''location: not found'' else replace(p_action, ''_'', '' '') end, p_note,'],
    ['decide_change_request', '    prev := public.apply_record_changes(cr.target_table, cr.target_id, cr.changes);
    insert into public.record_changes (target_table, target_id, action, changes, previous, request_no, target_label, actor, actor_name)
    values (cr.target_table, cr.target_id, ''correction'', cr.changes, prev, cr.request_no, cr.target_label, auth.uid(), me);
    update public.change_requests set status = ''approved'', previous = prev, review_note = p_note, reviewed_by_name = me, reviewed_at = now()
    where id = p_id returning * into cr;
    if cr.requested_by is distinct from auth.uid() then
      perform public.notify_user(cr.requested_by, ''Correction '' || cr.request_no || '' approved'', coalesce(cr.target_label, cr.target_table), public.record_link(cr.target_table, cr.target_id));
    end if;
',
     '    -- 2.1: the record takes the corrected details and the correction leaves no history: the request and its notice
    -- are removed, and no log line is written
    prev := public.apply_record_changes(cr.target_table, cr.target_id, cr.changes);
    delete from public.notifications where title = ''Correction request '' || cr.request_no;
    delete from public.change_requests where id = p_id;
    cr.status := ''approved''; cr.previous := prev; cr.review_note := p_note; cr.reviewed_by_name := me; cr.reviewed_at := now();
'],
    ['customer_action', '  if p_action = ''approve'' and c.status not in (''pending'',''verified'') then raise exception ''Only pending or verified applications can be approved''; end if;
  perform public.allow_record_change();
',
     '  if p_action = ''approve'' and c.status not in (''pending'',''verified'') then raise exception ''Only pending or verified applications can be approved''; end if;
  -- 2.1: the same person cannot open a second account (the same Facebook link as another account, or the same name or
  -- Facebook name as a CLOSED account)
  if p_action in (''verify'',''approve'') then perform public.customer_raise_if_blocked(c.id); end if;
  perform public.allow_record_change();
'],
    ['editable_columns', '''facebook_name'',''has_extra_facebook'',''extra_facebook_name'',''facebook_verified'',''credit_limit'']',
     '''facebook_name'',''facebook_link'',''has_extra_facebook'',''extra_facebook_name'',''facebook_verified'',''credit_limit'']']
  ];
  f record; def text; new_def text; i int;
begin
  for f in select p.oid, p.proname from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and pg_get_userbyid(p.proowner) = current_user
             and p.proname in ('order_letters_before_insert', 'update_pending_order', 'carry_out_order', 'undo_order', 'delete_record', 'remove_attachment', 'stock_bill_entries_before_insert', 'stock_bills_before_insert', 'editable_columns', 'verify_record', 'customer_action', 'decide_change_request')
  loop
    def := pg_get_functiondef(f.oid);
    new_def := def;
    for i in 1 .. array_length(fixes, 1) loop
      -- changed once: when the new text is already there (the script was run before), nothing is changed
      if fixes[i][1] = f.proname and (fixes[i][3] = '' or position(fixes[i][3] in new_def) = 0) then
        if position(fixes[i][2] in new_def) = 0 then
          -- a text that is only taken out is already gone when the script runs again
          continue when fixes[i][3] = '';
          raise exception 'Update 2.1: % has changed; text not found: %', f.proname, left(fixes[i][2], 60);
        end if;
        new_def := replace(new_def, fixes[i][2], fixes[i][3]);
      end if;
    end loop;
    if new_def <> def then execute new_def; end if;
  end loop;
end $$;

-- ---------- 6. once: the "deleted" lines, the lines and notices of records deleted before, and approved corrections ----------
do $$
begin
  perform public.allow_record_change();
  -- "[[U+2026]] deleted" lines (a Sales Report line, a Released Notice or an order letter that was deleted)
  delete from public.stock_bill_events e where e.action ~ ' deleted$' or e.action ~ ' deleted [[U+2014]] status back to ';
  delete from public.customer_events e where e.action ~ ' deleted [[U+2014]] status back to ';
  -- "[[U+2026]] added" lines of Sales Report lines deleted before
  delete from public.stock_bill_events e
  where e.action ~ '^(net sales|EOO fee|fee|penalty) BDT [0-9,.]+ added$'
    and not exists (select 1 from public.stock_bill_entries x where x.stock_bill_id = e.stock_bill_id and x.created_at = e.created_at
      and case x.entry_type when 'sales' then 'net sales' when 'eoo_fee' then 'EOO fee' when 'fee' then 'fee' else 'penalty' end
          || ' BDT ' || to_char(x.amount, 'FM999,999,999,990.00') || ' added' = e.action);
  -- lines of order letters deleted before ("closed by ORDER-2026-005", "released by EO-2026-10-0001")
  delete from public.customer_events e where e.action ~ ' by [A-Z]+-[0-9][0-9-]*$'
    and not exists (select 1 from public.order_letters o where right(e.action, length(o.order_no) + 4) = ' by ' || o.order_no);
  delete from public.stock_bill_events e where e.action ~ '^(released by|paid by memo) '
    and not exists (select 1 from public.order_letters o where e.action in ('released by ' || o.order_no, 'paid by memo ' || o.order_no));
  -- files the Director removed
  delete from public.stock_bill_events e where e.action = 'file removed' and e.actor in (select p.id from public.profiles p where p.role = 'admin');
  delete from public.customer_events e where e.action = 'file removed' and e.actor in (select p.id from public.profiles p where p.role = 'admin');
  delete from public.record_changes r where r.action = 'file removed' and r.actor in (select p.id from public.profiles p where p.role = 'admin');
  -- 2.1: approved corrections leave no history: their requests, log lines and notices
  delete from public.notifications n using public.change_requests r
    where r.status = 'approved' and n.title in ('Correction request ' || r.request_no, 'Correction ' || r.request_no || ' approved');
  delete from public.record_changes r where r.action = 'correction';
  delete from public.change_requests r where r.status = 'approved';
  -- notices that open a record deleted before
  delete from public.notifications n where
       (split_part(n.link, '/', 1) = 'order' and not exists (select 1 from public.order_letters x where x.id::text = split_part(n.link, '/', 2)))
    or (split_part(n.link, '/', 1) = 'customer' and not exists (select 1 from public.customers x where x.id::text = split_part(n.link, '/', 2)))
    or (split_part(n.link, '/', 1) = 'jobapp' and not exists (select 1 from public.job_applications x where x.id::text = split_part(n.link, '/', 2)))
    or (split_part(n.link, '/', 1) = 'creditmemo' and not exists (select 1 from public.credit_memos x where x.id::text = split_part(n.link, '/', 2)))
    or (split_part(n.link, '/', 1) = 'employee' and not exists (select 1 from public.employees x where x.id::text = split_part(n.link, '/', 2)));
end $$;

-- ======== 015_update_2_2.sql ========
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 2.2: the main Director edits a customer; a decided correction leaves no record;
-- the first SOA is the month the account was opened
-- 1. The main Director: one account only, the first Director account (made first). Only the main Director edits a
--    customer's details. Every other account, another Director account too, sends a correction request for a
--    customer, and only the main Director approves or rejects it.
-- 2. Edit Customer (main Director): every detail of a customer in one form (name, phone, email, address and location
--    check, business, Facebook, credit limit, opening balance, application date), saved at once. Like an approved
--    correction it leaves no history. When the opening balance or the application date changes, the customer's
--    monthly statements are worked out again (they keep their numbers and signed copies).
--    Not edited here: the account number, application number and Public ID (they are on printed papers and QR codes),
--    the status (it has its own steps) and the photo (Change Photo).
-- 3. A correction leaves no record once it is decided: an approved one changes the record (as since 2.1); a rejected
--    one is removed too, and the person who asked gets one notice. The decided corrections and their notices kept
--    before are removed once.
-- 4. Statements of account (SOA): the first SOA of an account is the month the account was opened (its application
--    date). Entries dated before it (old receipts and purchases recorded later) are in that first SOA, which starts
--    from zero; no SOA is made for the months before, and the ones made before are removed once (a SOA with a signed
--    copy is kept). One SOA a month after that, made automatically on the 1st. An entry recorded later with a date in
--    a month that already has its SOA works the SOAs out again from that month, so they always match the entries.
-- 5. Contact Us on the sign-in page: anyone sends a message with their name and how to reply (email, call, SMS,
--    WhatsApp, Viber or Facebook) and gets a reference number like MS-202609010001 (MS-, the date, then 0001, 0002 ...
--    that day). The Director reads them in Contact Messages and marks them replied.
-- Run once in the Supabase SQL Editor after 014_update_2_1.sql. No other records are changed. It is safe to run again.
-- =====================================================================

-- ---------- 1. the main Director ----------
-- One row: the profile of the main Director. Nobody reads or writes it from the portal (row level security with no
-- policy); the functions below read it.
create table if not exists public.main_director (
  only_one boolean primary key default true check (only_one),
  profile_id uuid not null references public.profiles(id) on delete restrict,
  set_at timestamptz not null default now()
);
alter table public.main_director enable row level security;
revoke all on public.main_director from anon, authenticated;
-- the first Director account is the main Director (kept when it is set)
insert into public.main_director (profile_id)
  select p.id from public.profiles p where p.role = 'admin' order by p.created_at, p.id limit 1
  on conflict (only_one) do nothing;

-- The main Director's profile: the one kept above, or (on a new portal, before it is kept) the first Director account.
create or replace function public.main_director_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select coalesce((select m.profile_id from public.main_director m),
                  (select p.id from public.profiles p where p.role = 'admin' order by p.created_at, p.id limit 1));
$$;
revoke execute on function public.main_director_id() from public, anon, authenticated;

-- Is the person signed in the main Director (and an active Director)?
create or replace function public.is_main_director() returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and auth.uid() = public.main_director_id() and public.is_admin();
$$;
revoke execute on function public.is_main_director() from public, anon;
grant execute on function public.is_main_director() to authenticated;

-- ---------- 2. Edit Customer ----------
-- (A new opening balance or application date works the monthly statements out again: restate_statements, part 5.)

-- The main Director edits a customer's details at once. p_changes: only the details that change, for example
-- {"phone": "0917...", "opening_balance": 2500}. Gives back { changed: [names], statements: n, since: date }.
create or replace function public.director_edit_customer(p_id uuid, p_changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare
  allowed constant text[] := array['first_name', 'last_name', 'phone', 'email', 'address', 'location_check', 'business_name',
    'business_start_date', 'facebook_name', 'facebook_link', 'has_extra_facebook', 'extra_facebook_name', 'facebook_verified',
    'credit_limit', 'opening_balance', 'application_date'];
  c public.customers;
  n public.customers;
  k text;
  why text;
  was text;
  changed text[] := '{}';
  restated integer := 0;
  since date := null;
begin
  if not public.is_main_director() then
    raise exception 'Only the main Director can edit a customer''s details. Send a correction request instead.';
  end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then raise exception 'Nothing to save'; end if;
  for k in select jsonb_object_keys(p_changes) loop
    if not (k = any(allowed)) then raise exception 'The detail "%" cannot be edited here', k; end if;
  end loop;
  select * into c from public.customers where id = p_id for update;
  if c.id is null then raise exception 'Customer not found'; end if;
  n := jsonb_populate_record(c, p_changes);
  -- tidy and check, as for a new application
  n.first_name := nullif(btrim(n.first_name), '');
  n.last_name := nullif(btrim(n.last_name), '');
  n.address := nullif(btrim(n.address), '');
  n.phone := nullif(btrim(n.phone), '');
  n.email := nullif(btrim(n.email), '');
  n.business_name := nullif(btrim(n.business_name), '');
  n.facebook_name := nullif(btrim(n.facebook_name), '');
  n.extra_facebook_name := nullif(btrim(n.extra_facebook_name), '');
  n.facebook_link := nullif(btrim(n.facebook_link), '');
  if n.first_name is null or n.last_name is null then raise exception 'Enter the first name and the last name'; end if;
  if n.address is null then raise exception 'Enter the address'; end if;
  if n.location_check is null or n.location_check not in ('found', 'no_need', 'not_found') then
    raise exception 'Choose the location check: FOUND, NO NEED TO CHECK LOCATION or NOT FOUND';
  end if;
  n.address_verified := n.location_check = 'found';
  n.has_extra_facebook := coalesce(n.has_extra_facebook, false);
  if not n.has_extra_facebook then n.extra_facebook_name := null; end if;
  n.facebook_verified := coalesce(n.facebook_verified, false);
  if n.credit_limit is not null and n.credit_limit < 0 then raise exception 'The credit limit cannot be below zero'; end if;
  n.opening_balance := coalesce(n.opening_balance, 0);
  if n.opening_balance < 0 then raise exception 'The opening balance cannot be below zero'; end if;
  if n.application_date is null then raise exception 'Enter the opening date'; end if;
  if n.application_date > current_date then raise exception 'The opening date cannot be after today'; end if;
  -- One person, one account: the edit may not make this account the same person as another account. A match that
  -- was there before the edit does not stop it.
  why := public.customer_block_reason(n.first_name, n.last_name, n.facebook_name, n.extra_facebook_name, n.facebook_link, n.id);
  if why is not null then
    was := public.customer_block_reason(c.first_name, c.last_name, c.facebook_name, c.extra_facebook_name, c.facebook_link, c.id);
    if was is distinct from why then raise exception '%', why; end if;
  end if;
  foreach k in array allowed loop
    if (to_jsonb(n) -> k) is distinct from (to_jsonb(c) -> k) then changed := changed || k; end if;
  end loop;
  if cardinality(changed) = 0 then return jsonb_build_object('changed', '[]'::jsonb, 'statements', 0, 'since', null); end if;
  perform public.allow_record_change();
  update public.customers set
    first_name = n.first_name, last_name = n.last_name, phone = n.phone, email = n.email,
    address = n.address, location_check = n.location_check, address_verified = n.address_verified,
    business_name = n.business_name, business_start_date = n.business_start_date,
    facebook_name = n.facebook_name, facebook_link = n.facebook_link, has_extra_facebook = n.has_extra_facebook,
    extra_facebook_name = n.extra_facebook_name, facebook_verified = n.facebook_verified,
    credit_limit = n.credit_limit, opening_balance = n.opening_balance, application_date = n.application_date
  where id = p_id;
  -- the monthly statements follow a new opening balance or application date
  if 'opening_balance' = any(changed) or 'application_date' = any(changed) then
    since := least(c.application_date, n.application_date);
    restated := public.restate_statements(p_id, since);
  end if;
  return jsonb_build_object('changed', to_jsonb(changed), 'statements', restated, 'since', since);
end;
$$;
revoke execute on function public.director_edit_customer(uuid, jsonb) from public, anon;
grant execute on function public.director_edit_customer(uuid, jsonb) to authenticated;

-- ---------- 3. corrections ----------
-- A correction request. The Director's own correction is added straight away, except a customer's: that is the main
-- Director's (Edit Customer), so another Director account sends it for approval like any other account.
create or replace function public.submit_change_request(p_table text, p_id uuid, p_changes jsonb, p_reason text, p_label text default null)
returns public.change_requests
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare
  cols text[] := public.editable_columns(p_table);
  k text;
  old jsonb;
  cr public.change_requests;
begin
  if not public.is_active() then raise exception 'Not allowed'; end if;
  if cols is null then raise exception 'This kind of record cannot be corrected'; end if;
  if not public.can_see_table(p_table) then raise exception 'You do not have access to this kind of record'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Write the reason'; end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then raise exception 'Nothing to correct'; end if;
  for k in select jsonb_object_keys(p_changes) loop
    if not (k = any(cols)) then raise exception 'The field "%" cannot be corrected', k; end if;
  end loop;
  execute format('select to_jsonb(t) from public.%I t where t.id = $1', p_table) into old using p_id;
  if old is null then raise exception 'Record not found'; end if;
  insert into public.change_requests (request_no, target_table, target_id, target_label, changes, previous, reason, requested_by, requested_by_name)
  values ('CR-' || to_char(current_date, 'YYYY') || '-' || lpad(public.next_counter('CR' || to_char(current_date, 'YYYY'))::text, 4, '0'),
          p_table, p_id, p_label, p_changes, (select jsonb_object_agg(x, old -> x) from jsonb_object_keys(p_changes) x),
          trim(p_reason), auth.uid(), (select full_name from public.profiles where id = auth.uid()))
  returning * into cr;
  -- The Director's own correction is added straight away (a customer's: the main Director's only).
  if public.is_admin() and (p_table <> 'customers' or public.is_main_director()) then
    return public.decide_change_request(cr.id, 'approve', null);
  end if;
  perform public.notify_admins('Correction request ' || cr.request_no, coalesce(p_label, p_table) || ' - ' || trim(p_reason), 'changes');
  return cr;
end;
$$;
revoke execute on function public.submit_change_request(text, uuid, jsonb, text, text) from public, anon;
grant execute on function public.submit_change_request(text, uuid, jsonb, text, text) to authenticated;

-- The Director approves or rejects a correction; a customer's correction: the main Director only.
create or replace function public.review_change_request(p_id uuid, p_action text, p_note text default null) returns public.change_requests
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Only the Director can approve corrections'; end if;
  if (select r.target_table from public.change_requests r where r.id = p_id) = 'customers' and not public.is_main_director() then
    raise exception 'Only the main Director can approve or reject a correction of a customer';
  end if;
  return public.decide_change_request(p_id, p_action, p_note);
end;
$$;
revoke execute on function public.review_change_request(uuid, text, text) from public, anon;
grant execute on function public.review_change_request(uuid, text, text) to authenticated;

-- A decided correction leaves no record: approved, the record takes the corrected details; rejected, the record stays
-- as it is. Either way the request and its notice are removed; the person who asked is told when it was rejected.
create or replace function public.decide_change_request(p_id uuid, p_action text, p_note text) returns public.change_requests
language plpgsql security definer set search_path = '' as $$
declare cr public.change_requests; me text; prev jsonb;
begin
  select * into cr from public.change_requests where id = p_id for update;
  if cr.id is null then raise exception 'Request not found'; end if;
  if cr.status <> 'pending' then raise exception 'This request is already %', upper(cr.status); end if;
  if p_action not in ('approve', 'reject') then raise exception 'Unknown action %', p_action; end if;
  me := (select full_name from public.profiles where id = auth.uid());
  perform public.allow_record_change();
  if p_action = 'approve' then
    prev := public.apply_record_changes(cr.target_table, cr.target_id, cr.changes);
    cr.status := 'approved'; cr.previous := prev;
  else
    cr.status := 'rejected';
    if cr.requested_by is distinct from auth.uid() then
      perform public.notify_user(cr.requested_by, 'Correction ' || cr.request_no || ' not approved',
        coalesce(cr.target_label, '') || coalesce(' - ' || nullif(trim(p_note), ''), ''), public.record_link(cr.target_table, cr.target_id));
    end if;
  end if;
  delete from public.notifications where title = 'Correction request ' || cr.request_no;
  delete from public.change_requests where id = p_id;
  cr.review_note := p_note; cr.reviewed_by_name := me; cr.reviewed_at := now();
  return cr;
end;
$$;
revoke execute on function public.decide_change_request(uuid, text, text) from public, anon, authenticated;

-- ---------- 4. once: the decided corrections kept before, and their notices ----------
do $$
begin
  perform public.allow_record_change();
  delete from public.notifications n
  where n.title like 'Correction %' and ((n.title like '% rejected' and n.title not like '% not approved') or (n.title like '% approved' and n.title not like '% not approved')
     or (n.title like 'Correction request %'
         and not exists (select 1 from public.change_requests r where r.status = 'pending' and n.title = 'Correction request ' || r.request_no)));
  delete from public.change_requests r where r.status <> 'pending';
end $$;

-- ---------- 5. statements of account (SOA) ----------
-- The amounts of the SOA of a month. The first SOA (the month the account was opened) starts from zero and has every
-- entry up to its last day, also the ones dated before; a later month starts from the balance before it.
create or replace function public.statement_amounts(p_customer uuid, p_month date, out opening numeric, out debit numeric, out credit numeric)
language plpgsql stable security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare
  c public.customers;
  m date := date_trunc('month', p_month)::date;
  nxt date := (date_trunc('month', p_month) + interval '1 month')::date;
  lo date; -- the first day counted (null: from the very first entry)
begin
  select * into c from public.customers where id = p_customer;
  if m <= date_trunc('month', c.application_date)::date then opening := 0; lo := null;
  else opening := public.balance_before(c.id, m); lo := m; end if;
  debit := (case when c.application_date < nxt and (lo is null or c.application_date >= lo) then coalesce(c.opening_balance, 0) else 0 end)
    + coalesce((select sum(i.total_amount) from public.customer_invoices i where i.customer_id = c.id and i.invoice_date < nxt and (lo is null or i.invoice_date >= lo)), 0)
    + coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = c.id and o.status = 'applied'
                 and (o.subject_type = 'charge' or (o.subject_type = 'settlement' and o.adjust_type = 'add'))
                 and o.applied_at::date < nxt and (lo is null or o.applied_at::date >= lo)), 0);
  credit := coalesce((select sum(p.amount) from public.payments_received p where p.customer_id = c.id and p.paid_date < nxt and (lo is null or p.paid_date >= lo)), 0)
    + coalesce((select sum(x.request_amount) from public.credit_memos x where x.customer_id = c.id and x.status in ('approved','paid')
                 and x.requested_action in ('credit','discount') and x.approved_at::date < nxt and (lo is null or x.approved_at::date >= lo)), 0)
    + coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = c.id and o.status = 'applied'
                 and o.subject_type = 'settlement' and o.adjust_type = 'reduce'
                 and o.applied_at::date < nxt and (lo is null or o.applied_at::date >= lo)), 0);
end;
$$;
revoke execute on function public.statement_amounts(uuid, date) from public, anon, authenticated;

-- The SOAs that are missing, made for every month that has ended: from the month the account was opened (not from an
-- earlier entry) to last month (a closed account: to the month it was closed). Run on the 1st by the schedule and when
-- the portal is opened.
create or replace function public.generate_statements(p_customer uuid default null) returns integer
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare
  c record;
  a record;
  m date;
  last_m date := (date_trunc('month', current_date) - interval '1 month')::date;
  stop_m date;
  made integer := 0;
begin
  if auth.uid() is not null and not public.is_active() then raise exception 'Not allowed'; end if;
  for c in select * from public.customers cu where cu.status in ('active','suspended','closed') and (p_customer is null or cu.id = p_customer) loop
    stop_m := last_m;
    if c.status = 'closed' then
      stop_m := least(last_m, coalesce((select date_trunc('month', max(created_at))::date from public.customer_events
                                        where customer_id = c.id and (action = 'close' or action like 'closed by %')), last_m));
    end if;
    m := date_trunc('month', c.application_date)::date;
    while m <= stop_m loop
      if not exists (select 1 from public.statements s where s.customer_id = c.id and s.period_start = m) then
        select * into a from public.statement_amounts(c.id, m);
        insert into public.statements (statement_no, customer_id, period_start, period_end, opening_balance, total_debit, total_credit, closing_balance)
        values ('SOA-' || to_char(m, 'YYYYMM') || '-' || c.account_no, c.id, m, ((m + interval '1 month')::date - 1),
                a.opening, a.debit, a.credit, a.opening + a.debit - a.credit);
        made := made + 1;
      end if;
      m := (m + interval '1 month')::date;
    end loop;
  end loop;
  return made;
end;
$$;
revoke execute on function public.generate_statements(uuid) from public, anon;
grant execute on function public.generate_statements(uuid) to authenticated;

-- A customer's SOAs worked out again from the month of p_since on (after an entry dated in a month that has its SOA,
-- or a new opening balance or application date): the SOAs keep their numbers and signed copies; a SOA before the
-- month the account was opened is removed (one with a signed copy is kept); missing months are made. The caller allows
-- the change (allow_record_change, or a trigger).
create or replace function public.restate_statements(p_customer uuid, p_since date) returns integer
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare
  c public.customers;
  s record;
  a record;
  n integer := 0;
begin
  select * into c from public.customers where id = p_customer;
  if c.id is null then return 0; end if;
  delete from public.statements st where st.customer_id = c.id and st.period_start < date_trunc('month', c.application_date)::date
    and not exists (select 1 from public.attachments x where x.owner_type = 'statement' and x.owner_id = st.id);
  for s in select st.id, st.period_start from public.statements st
           where st.customer_id = c.id and st.period_start >= date_trunc('month', least(p_since, c.application_date))::date
           order by st.period_start loop
    select * into a from public.statement_amounts(c.id, s.period_start);
    update public.statements set opening_balance = a.opening, total_debit = a.debit, total_credit = a.credit,
      closing_balance = a.opening + a.debit - a.credit where id = s.id;
    n := n + 1;
  end loop;
  perform public.generate_statements(c.id);
  return n;
end;
$$;
revoke execute on function public.restate_statements(uuid, date) from public, anon, authenticated;

-- A purchase or payment recorded with a date in a month that already has its SOA (an old paper recorded later): the
-- SOAs are worked out again from that month on.
create or replace function public.statements_follow_entry() returns trigger
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare d date := coalesce(to_jsonb(new) ->> 'invoice_date', to_jsonb(new) ->> 'paid_date')::date;
begin
  if d is not null and exists (select 1 from public.statements s where s.customer_id = new.customer_id and s.period_end >= d) then
    perform public.restate_statements(new.customer_id, d);
  end if;
  return null;
end;
$$;
revoke execute on function public.statements_follow_entry() from public, anon, authenticated;
drop trigger if exists statements_follow on public.customer_invoices;
create trigger statements_follow after insert on public.customer_invoices for each row execute function public.statements_follow_entry();
drop trigger if exists statements_follow on public.payments_received;
create trigger statements_follow after insert on public.payments_received for each row execute function public.statements_follow_entry();

-- ---------- 6. once: the SOAs made before for months before the account was opened ----------
-- Removed (unless a signed copy was uploaded on one), and every other SOA worked out again with the rules above.
do $$
declare c record;
begin
  perform public.allow_record_change();
  for c in select distinct s.customer_id from public.statements s loop
    perform public.restate_statements(c.customer_id, '1900-01-01');
  end loop;
end $$;

-- ---------- 7. Contact Us ----------
create table if not exists public.contact_messages (
  id uuid primary key default gen_random_uuid(),
  ref_no text not null unique,
  name text not null,
  reply_via text not null check (reply_via in ('email', 'call', 'sms', 'whatsapp', 'viber', 'facebook')),
  reply_to text not null,
  message text not null,
  status text not null default 'new' check (status in ('new', 'replied')),
  replied_by_name text,
  replied_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists contact_messages_created_idx on public.contact_messages (created_at desc);
alter table public.contact_messages enable row level security;
revoke all on public.contact_messages from anon, authenticated;
grant select on public.contact_messages to authenticated;
drop policy if exists "contact: director reads" on public.contact_messages;
create policy "contact: director reads" on public.contact_messages for select to authenticated using ((select public.is_admin()));

-- A message from the Contact Us form (no sign-in needed). Gives back its reference number, MS-YYYYMMDD#### (Manila date).
create or replace function public.submit_contact_message(p_name text, p_reply_via text, p_reply_to text, p_message text) returns text
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare
  n text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  via text := lower(btrim(coalesce(p_reply_via, '')));
  rt text := btrim(coalesce(p_reply_to, ''));
  msg text := btrim(coalesce(p_message, ''));
  ref text;
begin
  if char_length(n) < 2 or char_length(n) > 120 then raise exception 'Enter your name'; end if;
  if via not in ('email', 'call', 'sms', 'whatsapp', 'viber', 'facebook') then raise exception 'Choose how we should reply'; end if;
  if via = 'email' and rt !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter your email address'; end if;
  if via in ('call', 'sms', 'whatsapp', 'viber') and regexp_replace(rt, '[^0-9]', '', 'g') !~ '^[0-9]{7,15}$' then
    raise exception 'Enter your mobile number';
  end if;
  if char_length(rt) < 3 or char_length(rt) > 200 then raise exception 'Enter where we should reply'; end if;
  if char_length(msg) < 2 then raise exception 'Write your message'; end if;
  if char_length(msg) > 2000 then raise exception 'The message is too long (2,000 letters at most)'; end if;
  -- a flood of messages is stopped: 5 an hour from the same contact, 60 an hour from everyone together
  if (select count(*) from public.contact_messages m where lower(m.reply_to) = lower(rt) and m.created_at > now() - interval '1 hour') >= 5
     or (select count(*) from public.contact_messages m where m.created_at > now() - interval '1 hour') >= 60 then
    raise exception 'Too many messages were sent. Please try again later.';
  end if;
  ref := 'MS-' || to_char(current_date, 'YYYYMMDD') || lpad(public.next_counter('MS' || to_char(current_date, 'YYYYMMDD'))::text, 4, '0');
  insert into public.contact_messages (ref_no, name, reply_via, reply_to, message) values (ref, n, via, rt, msg);
  perform public.notify_admins('Contact message ' || ref, n || ' - ' || left(msg, 120), 'contacts');
  return ref;
end;
$$;
revoke execute on function public.submit_contact_message(text, text, text, text) from public;
grant execute on function public.submit_contact_message(text, text, text, text) to anon, authenticated;

-- The Director marks a message replied (or new again), or deletes it (gone for good, with its notice).
create or replace function public.contact_message_action(p_id uuid, p_action text) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.contact_messages;
begin
  if not public.is_admin() then raise exception 'Only the Director can do this'; end if;
  select * into m from public.contact_messages where id = p_id;
  if m.id is null then raise exception 'Message not found'; end if;
  if p_action = 'replied' then
    update public.contact_messages set status = 'replied', replied_at = now(),
      replied_by_name = (select full_name from public.profiles where id = auth.uid()) where id = p_id;
  elsif p_action = 'new' then
    update public.contact_messages set status = 'new', replied_at = null, replied_by_name = null where id = p_id;
  elsif p_action = 'delete' then
    delete from public.contact_messages where id = p_id;
  else
    raise exception 'Unknown action %', p_action;
  end if;
  if p_action in ('replied', 'delete') then delete from public.notifications where title = 'Contact message ' || m.ref_no; end if;
end;
$$;
revoke execute on function public.contact_message_action(uuid, text) from public, anon;
grant execute on function public.contact_message_action(uuid, text) to authenticated;

-- ======== 016_update_2_3.sql ========
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 2.3: customer account numbers and application numbers
-- 1. Account number = the first letters of the first and last name + the year and month of the account's opening date +
--    a serial for all customers (001, 002, 003 ... never started again), for example MV-202606001. It is made when the
--    application is APPROVED (a pending application has none, and a rejected one never takes a serial, so the next
--    approved customer gets it). From then on it is locked for good: nobody can change it (not even the main Director,
--    and a new opening date does not change it). A serial is used once only: a deleted customer's number is never
--    given again.
-- 2. Application number = EO-<year>-<5 random digits>, for example EO-2026-48213: easy to remember and to search, and
--    different for every customer. It is also locked, and never given again.
-- 3. The customers saved so far get the new numbers once (serials in the Director's order: MV 001, PR 002, RR 003,
--    KC 004, NW 005, SA 006), with their monthly statement numbers.
-- Run once in the Supabase SQL Editor after 015_update_2_2.sql. It is safe to run again.
-- =====================================================================

-- ---------- every number ever given (never deleted, so never given twice) ----------
create table if not exists public.issued_numbers (
  number text primary key,
  kind text not null check (kind in ('account', 'application')),
  issued_at timestamptz not null default now()
);
alter table public.issued_numbers enable row level security;
revoke all on public.issued_numbers from anon, authenticated;

-- ---------- 3. the customers saved so far (once, before the numbers are locked) ----------
do $$
declare r record; n int := 0; app text; acct text;
begin
  if exists (select 1 from public.issued_numbers) then return; end if; -- done before
  perform public.allow_record_change();
  for r in
    select c.* from public.customers c
    order by case left(c.account_no, 2) when 'MV' then 1 when 'PR' then 2 when 'RR' then 3 when 'KC' then 4 when 'NW' then 5 when 'SA' then 6 else 7 end,
             c.application_date, c.created_at
  loop
    n := n + 1;
    acct := left(r.account_no, 2) || '-' || to_char(r.application_date, 'YYYYMM') || lpad(n::text, 3, '0');
    loop
      app := 'EO-' || to_char(r.application_date, 'YYYY') || '-' || lpad((10000 + floor(random() * 90000))::int::text, 5, '0');
      exit when not exists (select 1 from public.issued_numbers where number = app) and not exists (select 1 from public.customers where application_no = app);
    end loop;
    update public.statements set statement_no = replace(statement_no, r.account_no, acct) where customer_id = r.id;
    update public.notifications set body = replace(body, r.account_no, acct) where body like '%' || r.account_no || '%';
    update public.notifications set title = replace(title, r.application_no, app) where title like '%' || r.application_no || '%';
    update public.order_letters set applied_result = replace(applied_result, r.account_no, acct) where customer_id = r.id and applied_result like '%' || r.account_no || '%';
    update public.customers set account_no = acct, application_no = app where id = r.id;
    insert into public.issued_numbers (number, kind) values (acct, 'account'), (app, 'application');
  end loop;
  insert into public.doc_counters (prefix, last_no) values ('ACCOUNT', n)
    on conflict (prefix) do update set last_no = greatest(public.doc_counters.last_no, excluded.last_no);
end $$;

-- ---------- 1 and 2. the numbers of a new customer ----------
create or replace function public.customers_before_insert() returns trigger
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare
  d date := coalesce(new.application_date, current_date);
  app text;
begin
  -- the account number is made when the application is approved (customers_account_number)
  new.account_no := null;
  loop
    app := 'EO-' || to_char(d, 'YYYY') || '-' || lpad((10000 + floor(random() * 90000))::int::text, 5, '0');
    exit when not exists (select 1 from public.issued_numbers where number = app);
  end loop;
  new.application_no := app;
  insert into public.issued_numbers (number, kind) values (app, 'application');
  new.status := 'pending';
  new.issued_by := auth.uid();
  new.issued_by_name := (select full_name from public.profiles where id = auth.uid());
  new.reviewed_by := null;
  new.reviewed_at := null;
  new.facebook_verified := coalesce(new.facebook_verified, false);
  new.public_id := public.customer_public_id(to_jsonb(new) - 'public_id');
  return new;
end;
$$;
revoke execute on function public.customers_before_insert() from public, anon, authenticated;

-- ---------- the account number, made when the application is approved ----------
create or replace function public.customers_account_number() returns trigger
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare initials text;
begin
  if new.status = 'active' and old.status in ('pending', 'verified') and new.account_no is null then
    initials := upper(left(regexp_replace(new.first_name, '[^A-Za-z]', '', 'g'), 1) || left(regexp_replace(new.last_name, '[^A-Za-z]', '', 'g'), 1));
    if initials = '' or initials is null then initials := 'XX'; end if;
    new.account_no := initials || '-' || to_char(coalesce(new.application_date, current_date), 'YYYYMM')
                      || lpad(public.next_counter('ACCOUNT')::text, 3, '0');
    insert into public.issued_numbers (number, kind) values (new.account_no, 'account');
  end if;
  return new;
end;
$$;
revoke execute on function public.customers_account_number() from public, anon, authenticated;
drop trigger if exists customers_account_number on public.customers;
create trigger customers_account_number before update of status on public.customers
  for each row execute function public.customers_account_number();

-- the notice of a new application names its application number (the account number comes on approval)
create or replace function public.customers_after_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.customer_secrets (customer_id, private_code)
  values (new.id, public.customer_private_id(to_jsonb(new)));
  insert into public.customer_events (customer_id, action, actor, actor_name)
  values (new.id, 'application submitted', auth.uid(), new.issued_by_name);
  insert into public.notifications (user_id, title, body, link)
  select p.id, 'New customer application ' || new.application_no,
         new.first_name || ' ' || new.last_name || ' is waiting for review.',
         'customer/' || new.id
  from public.profiles p where p.role = 'admin' and p.status = 'active';
  return new;
end;
$$;
revoke execute on function public.customers_after_insert() from public, anon, authenticated;

-- ---------- the numbers are locked ----------
create or replace function public.customers_numbers_locked() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.account_no is not null and new.account_no is distinct from old.account_no then
    raise exception 'The account number % is locked and cannot be changed', old.account_no;
  end if;
  if new.application_no is distinct from old.application_no then
    raise exception 'The application number % is locked and cannot be changed', old.application_no;
  end if;
  return new;
end;
$$;
revoke execute on function public.customers_numbers_locked() from public, anon, authenticated;
drop trigger if exists customers_numbers_locked on public.customers;
create trigger customers_numbers_locked before update of account_no, application_no on public.customers
  for each row execute function public.customers_numbers_locked();

-- ---------- the numbers shown on the New Customer form before it is saved ----------
create or replace function public.preview_customer_numbers(p_first text, p_last text) returns jsonb
language sql stable security definer set search_path = '' set timezone to 'Asia/Manila' as $$
  select jsonb_build_object(
    'account_no', coalesce(nullif(upper(left(regexp_replace(coalesce(p_first, ''), '[^A-Za-z]', '', 'g'), 1) || left(regexp_replace(coalesce(p_last, ''), '[^A-Za-z]', '', 'g'), 1)), ''), 'XX')
                  || '-' || to_char(current_date, 'YYYYMM')
                  || lpad((coalesce((select d.last_no from public.doc_counters d where d.prefix = 'ACCOUNT'), 0) + 1)::text, 3, '0'),
    'application_no', 'EO-' || to_char(current_date, 'YYYY') || '-(random)')
  where public.can_write('customers');
$$;
revoke execute on function public.preview_customer_numbers(text, text) from public, anon;
grant execute on function public.preview_customer_numbers(text, text) to authenticated;

select 'UPDATE 2.3 READY - ' || (select count(*) from public.customers) || ' customers, next serial '
       || lpad((coalesce((select last_no from public.doc_counters where prefix = 'ACCOUNT'), 0) + 1)::text, 3, '0') as result;

-- ======== 017_play_store.sql ========
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 2.4: deleting a login account (needed for the Google Play Store)
-- A person asks for it in My Profile (Request Account Deletion) or on www.emonoverruns.online/delete-account.
-- The Director then presses Delete on Login Accounts:
--   * the login and the person's details go: name, email, username, photo, signature, chat messages, community
--     posts, notices, and a job application that was not approved (with its files);
--   * a person named in records the business must keep (invoices, receipts, payslips, order letters, the record
--     history ...) keeps those records: the login is removed and the profile becomes "Deleted User".
-- Also: invoices get Terms of Payment (with a due date); payments, discounts and orders are for the account, never
-- for one invoice, and invoices show PAID, PARTIAL PAYMENT or UNPAID from everything paid to the account (oldest
-- first); Verify a record shows the same for an invoice, and a customer still waiting for approval by the
-- application number (since 2.3 the account number is given only on approval).
-- Run once in the Supabase SQL Editor after 016_update_2_3.sql. It is safe to run again.
-- =====================================================================

-- the Director may remove profile photos (the files of a deleted account)
drop policy if exists "storage avatars: admin read" on storage.objects;
create policy "storage avatars: admin read" on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and (select public.is_admin()));
drop policy if exists "storage avatars: admin delete" on storage.objects;
create policy "storage avatars: admin delete" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (select public.is_admin()));

-- Returns how the account went ('deleted', or 'anonymized' when kept records name it) and the stored files of the
-- account, which the portal then removes from storage.
create or replace function public.delete_user_account(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p public.profiles;
  avs text[] := '{}';
  recs text[] := '{}';
  how text;
begin
  if not public.is_admin() then raise exception 'Only the Director can delete an account'; end if;
  if p_id = auth.uid() then raise exception 'You cannot delete your own account'; end if;
  if exists (select 1 from public.main_director where profile_id = p_id) then
    raise exception 'The main Director''s account cannot be deleted';
  end if;
  select * into p from public.profiles where id = p_id;
  if p.id is null then raise exception 'Account not found'; end if;
  perform public.allow_record_change();

  -- the stored files of the account
  if p.avatar_path is not null then avs := avs || p.avatar_path; end if;
  if p.signature_path is not null then recs := recs || p.signature_path; end if;
  recs := recs || coalesce((select array_agg(m.file_path) from public.messages m
                            where (m.sender_id = p_id or m.recipient_id = p_id) and m.file_path is not null), '{}');
  recs := recs || coalesce((select array_agg(x) from public.community_posts c, unnest(c.photos) x where c.author_id = p_id), '{}');
  recs := recs || coalesce((select array_agg(j.photo_path) from public.job_applications j
                            where j.profile_id = p_id and j.status <> 'approved' and j.photo_path is not null), '{}');
  recs := recs || coalesce((select array_agg(a.storage_path) from public.attachments a
                            join public.job_applications j on a.owner_type = 'job_application' and a.owner_id = j.id
                            where j.profile_id = p_id and j.status <> 'approved'), '{}');

  -- the person's own things (a job application that was approved belongs to the employee record and stays)
  delete from public.attachments a using public.job_applications j
    where a.owner_type = 'job_application' and a.owner_id = j.id and j.profile_id = p_id and j.status <> 'approved';
  delete from public.job_applications where profile_id = p_id and status <> 'approved';
  delete from public.messages where sender_id = p_id or recipient_id = p_id;
  delete from public.community_posts where author_id = p_id;
  delete from public.notifications where user_id = p_id;

  begin
    delete from auth.users where id = p_id; -- the profile goes with it
    how := 'deleted';
  exception when foreign_key_violation then
    -- kept records still point to this profile: the login and the personal details are removed instead
    update public.profiles set full_name = 'Deleted User', email = null, username = null, avatar_path = null,
      signature_path = null, signature_status = null, signature_at = null, signature_note = null,
      status = 'disabled', last_seen_at = null
    where id = p_id;
    update auth.users set email = 'deleted-' || p_id || '@deleted.invalid', phone = null, encrypted_password = '',
      raw_user_meta_data = '{}'::jsonb, banned_until = 'infinity'
    where id = p_id;
    delete from auth.identities where user_id = p_id;
    delete from auth.sessions where user_id = p_id;
    how := 'anonymized';
  end;
  return jsonb_build_object('result', how, 'avatars', to_jsonb(avs), 'records', to_jsonb(recs));
end;
$$;
revoke execute on function public.delete_user_account(uuid) from public, anon;
grant execute on function public.delete_user_account(uuid) to authenticated;

-- ---------- invoices: Terms of Payment ----------
-- Chosen when an invoice is recorded (CASH ON DELIVERY, 7 / 15 / 30 / 45 / 60 / 90 DAYS, or other terms); an invoice
-- recorded before can be given its terms with Add Correction. The due date follows from it.
alter table public.customer_invoices add column if not exists payment_terms text;
do $$ begin
  alter table public.customer_invoices add constraint customer_invoices_payment_terms_check
    check (payment_terms is null or char_length(payment_terms) between 1 and 60);
exception when duplicate_object then null; end $$;

-- ---------- payments, discounts and orders are for the account, never for one invoice ----------
-- A payment is not linked to an invoice any more: what a customer pays (and every approved credit memo or discount,
-- and every settlement adjustment that takes off) goes to the account, and pays the oldest invoices first.
do $$
begin
  perform public.allow_record_change();
  update public.payments_received set invoice_id = null where invoice_id is not null;
end $$;
create or replace function public.payments_account_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.invoice_id := null;
  return new;
end;
$$;
revoke execute on function public.payments_account_only() from public, anon, authenticated;
drop trigger if exists payments_account_only on public.payments_received;
create trigger payments_account_only before insert or update of invoice_id on public.payments_received
  for each row execute function public.payments_account_only();

-- ---------- invoices: PAID, PARTIAL PAYMENT or UNPAID, from everything paid to the account ----------
-- Everything the customer paid or was credited (payments, approved credit memos and discounts, settlement adjustments
-- that take off) pays what is owed oldest first: the opening balance, then each invoice, additional charge and
-- settlement adjustment that adds, in date order. An invoice is PAID when it is paid in full, PARTIAL PAYMENT when
-- part of it is paid, and UNPAID when nothing of it is paid; the invoices' balances add up to the account's balance.
-- The columns of before stay in their place (every screen keeps working); the terms and the due date come after them.
create or replace view public.invoice_balances with (security_invoker = true) as
with pool as (
  select c.id as customer_id,
    coalesce((select sum(p.amount) from public.payments_received p where p.customer_id = c.id), 0)
    + coalesce((select sum(m.request_amount) from public.credit_memos m
                where m.customer_id = c.id and m.status in ('approved','paid') and m.requested_action in ('credit','discount')), 0)
    + coalesce((select sum(o.amount) from public.order_letters o
                where o.customer_id = c.id and o.status = 'applied' and o.subject_type = 'settlement' and o.adjust_type = 'reduce'), 0) as amount
  from public.customers c
),
owed as (
  select c.id as customer_id, null::uuid as invoice_id, c.application_date as d, 0 as k, c.created_at as t, c.opening_balance::numeric as amount
    from public.customers c where c.opening_balance > 0
  union all
  select i.customer_id, i.id, i.invoice_date, 1, i.created_at, i.total_amount::numeric
    from public.customer_invoices i
  union all
  select o.customer_id, null::uuid, (coalesce(o.applied_at, o.created_at) at time zone 'Asia/Manila')::date, 2, o.created_at, o.amount::numeric
    from public.order_letters o
    where o.customer_id is not null and o.status = 'applied'
      and (o.subject_type = 'charge' or (o.subject_type = 'settlement' and o.adjust_type = 'add'))
),
fifo as (
  select w.invoice_id, w.customer_id, w.amount,
    coalesce(sum(w.amount) over (partition by w.customer_id order by w.d, w.k, w.t, w.invoice_id
                                 rows between unbounded preceding and 1 preceding), 0) as before
  from owed w
),
paid as (
  select f.invoice_id as id, greatest(0, least(f.amount, coalesce(pl.amount, 0) - f.before))::numeric(14,2) as amount
  from fifo f left join pool pl on pl.customer_id = f.customer_id
  where f.invoice_id is not null
)
select i.id, i.invoice_no, i.customer_id, i.invoice_date, i.purchase_date, i.po_number, i.total_boxes, i.total_pcs,
  i.total_amount, i.created_by, i.created_by_name, i.created_at,
  c.first_name, c.last_name, c.account_no, c.business_name, c.status as customer_status,
  pd.amount as amount_paid,
  (i.total_amount - pd.amount)::numeric(14,2) as balance,
  case when pd.amount >= i.total_amount then 'paid' when pd.amount > 0 then 'partial' else 'unpaid' end as pay_status,
  i.payment_terms,
  case when i.payment_terms ~ '^[0-9]{1,3} DAYS$' then i.invoice_date + split_part(i.payment_terms, ' ', 1)::int
       when i.payment_terms = 'CASH ON DELIVERY' then i.invoice_date end as due_date
from public.customer_invoices i
join public.customers c on c.id = i.customer_id
join paid pd on pd.id = i.id;

-- ---------- functions changed in place (like the earlier updates), so everything added to them since stays ----------
-- verify_record: a customer waiting for approval is shown by the application number (2.3); an invoice shows what is
-- paid by the rule above, its balance and its terms; a payment no longer names an invoice.
-- editable_columns: the terms of an invoice can be corrected.
do $$
declare
  fixes text[][] := array[
    ['verify_record', '''type'', ''Customer Account'', ''number'', r.account_no,',
     '''type'', ''Customer Account'', ''number'', coalesce(r.account_no, r.application_no),'],
    ['verify_record', 'jsonb_build_array(''Customer ID'', r.account_no), jsonb_build_array(''Account Name''',
     'case when r.account_no is not null then jsonb_build_array(''Customer ID'', r.account_no) end, jsonb_build_array(''Account Name'''],
    ['verify_record', 'coalesce((select sum(p.amount) from public.payments_received p where p.invoice_id = i.id), 0) as paid',
     'coalesce((select b.amount_paid from public.invoice_balances b where b.id = i.id), 0) as paid'],
    ['verify_record', 'jsonb_build_array(''Paid (PHP)'', to_char(r.paid, ''FM999,999,999,990.00''))));',
     'jsonb_build_array(''Paid (PHP)'', to_char(r.paid, ''FM999,999,999,990.00'')),
          jsonb_build_array(''Balance (PHP)'', to_char(greatest(r.total_amount - r.paid, 0), ''FM999,999,999,990.00''))));'],
    ['verify_record', 'jsonb_build_array(''PO Number'', coalesce(r.po_number,',
     'jsonb_build_array(''Terms of Payment'', coalesce(r.payment_terms,'],
    ['verify_record', 'jsonb_build_array(''Invoice'', coalesce(r.inv, ''General payment'')),', ''],
    ['editable_columns', 'when ''customer_invoices'' then array[''purchase_date'',''po_number'',''total_boxes'',''total_pcs'']',
     'when ''customer_invoices'' then array[''purchase_date'',''po_number'',''total_boxes'',''total_pcs'',''payment_terms'']']
  ];
  f record; def text; new_def text; i int;
begin
  for f in select p.oid, p.proname from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.proname in ('verify_record', 'editable_columns')
  loop
    def := pg_get_functiondef(f.oid);
    new_def := def;
    for i in 1 .. array_length(fixes, 1) loop
      continue when fixes[i][1] <> f.proname;
      -- changed once: when the new text is already there (the script was run before), nothing is changed
      continue when fixes[i][3] <> '' and position(fixes[i][3] in new_def) > 0;
      if position(fixes[i][2] in new_def) = 0 then
        -- a text that is only taken out is already gone when the script runs again
        continue when fixes[i][3] = '';
        raise exception 'Update 2.4: % has changed; text not found: %', f.proname, left(fixes[i][2], 60);
      end if;
      new_def := replace(new_def, fixes[i][2], fixes[i][3]);
    end loop;
    if new_def <> def then execute new_def; end if;
  end loop;
end $$;

select 'UPDATE 2.4 READY - account deletion, invoice payment status, terms of payment' as result;

-- ======== 018_invoice_po.sql ========
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 2.6: every detail of an invoice can be corrected
-- The invoice date and the total amount join the details that Add Correction can change (with the Terms of
-- Payment, boxes, pieces, PO Number and PO Date). The Director's correction changes the invoice at once; an employee's
-- waits for the Director. When the date or the amount changes, the statements of account are made again from that
-- month on, and the invoice's PAID / PARTIAL PAYMENT / UNPAID status follows by itself.
-- Run once in the Supabase SQL Editor after 017_play_store.sql. It is safe to run again.
-- =====================================================================

do $$
declare
  f record; def text;
  old_cols text := 'when ''customer_invoices'' then array[''purchase_date'',''po_number'',''total_boxes'',''total_pcs'',''payment_terms'']';
  new_cols text := 'when ''customer_invoices'' then array[''invoice_date'',''total_amount'',''purchase_date'',''po_number'',''total_boxes'',''total_pcs'',''payment_terms'']';
begin
  for f in select p.oid from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'editable_columns' loop
    def := pg_get_functiondef(f.oid);
    if position(new_cols in def) > 0 then continue; end if; -- run before
    if position(old_cols in def) = 0 then raise exception 'Update 2.6: editable_columns has changed; run 017_play_store.sql first'; end if;
    execute replace(def, old_cols, new_cols);
  end loop;
end $$;

-- A corrected invoice date or amount makes the statements again from the earlier of the two months.
create or replace function public.statements_follow_invoice_change() returns trigger
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare d date := least(old.invoice_date, new.invoice_date);
begin
  if (new.invoice_date is distinct from old.invoice_date or new.total_amount is distinct from old.total_amount)
     and exists (select 1 from public.statements s where s.customer_id = new.customer_id and s.period_end >= d) then
    perform public.restate_statements(new.customer_id, d);
  end if;
  return null;
end;
$$;
revoke execute on function public.statements_follow_invoice_change() from public, anon, authenticated;
drop trigger if exists statements_follow_change on public.customer_invoices;
create trigger statements_follow_change after update of invoice_date, total_amount on public.customer_invoices
  for each row execute function public.statements_follow_invoice_change();

select 'UPDATE 2.6 READY - every detail of an invoice can be corrected' as result;

-- ======== 019_link_payment.sql ========
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 2.7.3: link a customer payment to an invoice
-- A payment linked to an invoice pays that invoice first (any amount over the invoice goes to the customer's other
-- invoices). Payments that are not linked pay the oldest invoices first, as before. Linking and unlinking is done on
-- the invoice page (Link a Payment) and written in the customer's history.
-- An employee who uploads or scans a new paper copy of a customer's application form or of an invoice (when one is
-- already on file) sends it to the Director: it waits as an update until the Director approves it (then it replaces
-- the old copy) or rejects it (then it is deleted). The Director's own update replaces the copy at once.
-- Run once in the Supabase SQL Editor after 018_invoice_po.sql. It is safe to run again.
-- =====================================================================

create or replace view public.invoice_balances with (security_invoker = true) as
with linked as (
  select p.invoice_id, sum(p.amount)::numeric as amount
  from public.payments_received p where p.invoice_id is not null group by p.invoice_id
),
inv as (
  select i.id, i.customer_id,
    least(i.total_amount, coalesce(l.amount, 0))::numeric as direct,
    greatest(0, coalesce(l.amount, 0) - i.total_amount)::numeric as extra
  from public.customer_invoices i left join linked l on l.invoice_id = i.id
),
pool as (
  select c.id as customer_id,
    coalesce((select sum(p.amount) from public.payments_received p
              where p.customer_id = c.id and (p.invoice_id is null
                or not exists (select 1 from public.customer_invoices x where x.id = p.invoice_id and x.customer_id = c.id))), 0)
    + coalesce((select sum(x.extra) from inv x where x.customer_id = c.id), 0)
    + coalesce((select sum(m.request_amount) from public.credit_memos m
                where m.customer_id = c.id and m.status in ('approved','paid') and m.requested_action in ('credit','discount')), 0)
    + coalesce((select sum(o.amount) from public.order_letters o
                where o.customer_id = c.id and o.status = 'applied' and o.subject_type = 'settlement' and o.adjust_type = 'reduce'), 0) as amount
  from public.customers c
),
owed as (
  select c.id as customer_id, null::uuid as invoice_id, c.application_date as d, 0 as k, c.created_at as t, c.opening_balance::numeric as amount
    from public.customers c where c.opening_balance > 0
  union all
  select i.customer_id, i.id, i.invoice_date, 1, i.created_at, (i.total_amount - x.direct)::numeric
    from public.customer_invoices i join inv x on x.id = i.id
  union all
  select o.customer_id, null::uuid, (coalesce(o.applied_at, o.created_at) at time zone 'Asia/Manila')::date, 2, o.created_at, o.amount::numeric
    from public.order_letters o
    where o.customer_id is not null and o.status = 'applied'
      and (o.subject_type = 'charge' or (o.subject_type = 'settlement' and o.adjust_type = 'add'))
),
fifo as (
  select w.invoice_id, w.customer_id, w.amount,
    coalesce(sum(w.amount) over (partition by w.customer_id order by w.d, w.k, w.t, w.invoice_id
                                 rows between unbounded preceding and 1 preceding), 0) as before
  from owed w
),
paid as (
  select f.invoice_id as id, (x.direct + greatest(0, least(f.amount, coalesce(pl.amount, 0) - f.before)))::numeric(14,2) as amount
  from fifo f join inv x on x.id = f.invoice_id left join pool pl on pl.customer_id = f.customer_id
  where f.invoice_id is not null
)
select i.id, i.invoice_no, i.customer_id, i.invoice_date, i.purchase_date, i.po_number, i.total_boxes, i.total_pcs,
  i.total_amount, i.created_by, i.created_by_name, i.created_at,
  c.first_name, c.last_name, c.account_no, c.business_name, c.status as customer_status,
  pd.amount as amount_paid,
  (i.total_amount - pd.amount)::numeric(14,2) as balance,
  case when pd.amount >= i.total_amount then 'paid' when pd.amount > 0 then 'partial' else 'unpaid' end as pay_status,
  i.payment_terms,
  case when i.payment_terms ~ '^[0-9]{1,3} DAYS$' then i.invoice_date + split_part(i.payment_terms, ' ', 1)::int
       when i.payment_terms = 'CASH ON DELIVERY' then i.invoice_date end as due_date
from public.customer_invoices i
join public.customers c on c.id = i.customer_id
join paid pd on pd.id = i.id;

-- 2.4 made every payment an account payment (the link was cleared on save). A link made with link_payment below is kept.
create or replace function public.payments_account_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and current_setting('eo.allow_change', true) = 'on' then return new; end if;
  new.invoice_id := case when tg_op = 'UPDATE' then old.invoice_id else null end;
  return new;
end;
$$;
revoke execute on function public.payments_account_only() from public, anon, authenticated;

-- Link a payment to an invoice of the same customer (p_invoice null: unlink). Staff who record payments or invoices,
-- and the Director.
create or replace function public.link_payment(p_payment uuid, p_invoice uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.payments_received; i public.customer_invoices;
begin
  if not (public.can_write('payments') or public.can_write('invoices')) then
    raise exception 'You do not have access to link payments';
  end if;
  select * into p from public.payments_received where id = p_payment;
  if not found then raise exception 'Payment not found'; end if;
  if p_invoice is not null then
    select * into i from public.customer_invoices where id = p_invoice;
    if not found or i.customer_id <> p.customer_id then raise exception 'This invoice is not of the same customer'; end if;
  end if;
  if p.invoice_id is not distinct from p_invoice then return; end if;
  perform set_config('eo.allow_change', 'on', true);
  update public.payments_received set invoice_id = p_invoice where id = p_payment;
  insert into public.customer_events (customer_id, action, note, actor, actor_name)
  values (p.customer_id, case when p_invoice is null then 'payment unlinked' else 'payment linked' end,
          coalesce(p.receipt_no, '') || case when p_invoice is null then '' else ' [[U+2192]] ' || i.invoice_no end,
          auth.uid(), (select full_name from public.profiles where id = auth.uid()));
  perform set_config('eo.allow_change', 'off', true);
end;
$$;
revoke execute on function public.link_payment(uuid, uuid) from public, anon;
grant execute on function public.link_payment(uuid, uuid) to authenticated;

-- ---------- a new paper copy waits for the Director ----------
alter table public.attachments add column if not exists pending boolean not null default false;

create or replace function public.attachments_pending_copy() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.pending := false;
  if new.owner_type in ('customer','invoice') and new.kind in ('signed_form','application') and not public.is_admin()
     and exists (select 1 from public.attachments a where a.owner_type = new.owner_type and a.owner_id = new.owner_id
                 and a.kind in ('signed_form','application') and not a.pending) then
    new.pending := true;
    insert into public.notifications (user_id, title, body, link)
    select p.id, 'Paper copy update to approve',
           coalesce((select full_name from public.profiles where id = auth.uid()), 'An employee') || ' sent a new paper copy: ' || new.file_name,
           new.owner_type || '/' || new.owner_id
    from public.profiles p where p.role = 'admin' and p.status = 'active';
  end if;
  return new;
end;
$$;
revoke execute on function public.attachments_pending_copy() from public, anon, authenticated;
drop trigger if exists attachments_pending_copy on public.attachments;
create trigger attachments_pending_copy before insert on public.attachments
  for each row execute function public.attachments_pending_copy();

-- The Director approves (the update replaces the old copy) or rejects (the update is deleted; the file's path is
-- given back so the portal removes the file too).
create or replace function public.decide_attachment(p_id uuid, p_ok boolean) returns text
language plpgsql security definer set search_path = '' as $$
declare a public.attachments;
begin
  if not public.is_admin() then raise exception 'Only the Director approves a paper copy update'; end if;
  select * into a from public.attachments where id = p_id and pending;
  if not found then raise exception 'This update was already decided'; end if;
  perform set_config('eo.allow_change', 'on', true);
  if p_ok then
    update public.attachments set pending = false, created_at = now() where id = p_id;
  else
    delete from public.attachments where id = p_id;
  end if;
  perform set_config('eo.allow_change', 'off', true);
  if a.uploaded_by is not null and a.uploaded_by <> auth.uid() then
    insert into public.notifications (user_id, title, body, link)
    values (a.uploaded_by, case when p_ok then 'Paper copy approved' else 'Paper copy not approved' end, a.file_name,
            a.owner_type || '/' || a.owner_id);
  end if;
  return case when p_ok then null else a.storage_path end;
end;
$$;
revoke execute on function public.decide_attachment(uuid, boolean) from public, anon;
grant execute on function public.decide_attachment(uuid, boolean) to authenticated;

select 'UPDATE 2.7.3 READY - payments can be linked to an invoice; paper copy updates wait for the Director'
  || ' (payments already linked: ' || (select count(*) from public.payments_received where invoice_id is not null) || ')' as result;

-- ======== 020_invoice_return.sql ========
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 2.8: returns on an invoice
-- Record Return on the invoice page: the items the customer gave back, the quantity and the amount. The return is
-- kept as a credit memo marked RETURN and linked to that invoice: once approved (the Director's own return is approved
-- at once) its amount is taken off that invoice first, the customer's balance goes down by the same amount, and the
-- statement of account shows a RETURN line.
-- Run once in the Supabase SQL Editor after 019_link_payment.sql. It is safe to run again.
-- =====================================================================

alter table public.credit_memos add column if not exists invoice_id uuid references public.customer_invoices(id) on delete set null;
alter table public.credit_memos add column if not exists is_return boolean not null default false;
create index if not exists credit_memos_invoice_idx on public.credit_memos(invoice_id);

-- What each invoice has been paid: approved returns of the invoice first (they lower what is owed), then payments
-- linked to it, then everything else on the account (unlinked payments, credits, discounts, take-off adjustments)
-- pays the oldest invoices first.
create or replace view public.invoice_balances with (security_invoker = true) as
with lp as (
  select p.invoice_id, sum(p.amount)::numeric as amount
  from public.payments_received p where p.invoice_id is not null group by p.invoice_id
),
lr as (
  select m.invoice_id, sum(m.request_amount)::numeric as amount
  from public.credit_memos m
  where m.invoice_id is not null and m.status in ('approved','paid') and m.requested_action in ('credit','discount')
  group by m.invoice_id
),
inv as (
  select i.id, i.customer_id, i.total_amount,
    least(i.total_amount, coalesce(r.amount, 0))::numeric as ret,
    greatest(0, coalesce(r.amount, 0) - i.total_amount)::numeric as ret_extra,
    coalesce(l.amount, 0)::numeric as lpay
  from public.customer_invoices i left join lp l on l.invoice_id = i.id left join lr r on r.invoice_id = i.id
),
inv2 as (
  select x.*, least(x.total_amount - x.ret, x.lpay)::numeric as direct,
    (greatest(0, x.lpay - (x.total_amount - x.ret)) + x.ret_extra)::numeric as extra
  from inv x
),
pool as (
  select c.id as customer_id,
    coalesce((select sum(p.amount) from public.payments_received p
              where p.customer_id = c.id and (p.invoice_id is null
                or not exists (select 1 from public.customer_invoices x where x.id = p.invoice_id and x.customer_id = c.id))), 0)
    + coalesce((select sum(x.extra) from inv2 x where x.customer_id = c.id), 0)
    + coalesce((select sum(m.request_amount) from public.credit_memos m
                where m.customer_id = c.id and m.status in ('approved','paid') and m.requested_action in ('credit','discount')
                  and (m.invoice_id is null
                    or not exists (select 1 from public.customer_invoices x where x.id = m.invoice_id and x.customer_id = c.id))), 0)
    + coalesce((select sum(o.amount) from public.order_letters o
                where o.customer_id = c.id and o.status = 'applied' and o.subject_type = 'settlement' and o.adjust_type = 'reduce'), 0) as amount
  from public.customers c
),
owed as (
  select c.id as customer_id, null::uuid as invoice_id, c.application_date as d, 0 as k, c.created_at as t, c.opening_balance::numeric as amount
    from public.customers c where c.opening_balance > 0
  union all
  select i.customer_id, i.id, i.invoice_date, 1, i.created_at, (i.total_amount - x.ret - x.direct)::numeric
    from public.customer_invoices i join inv2 x on x.id = i.id
  union all
  select o.customer_id, null::uuid, (coalesce(o.applied_at, o.created_at) at time zone 'Asia/Manila')::date, 2, o.created_at, o.amount::numeric
    from public.order_letters o
    where o.customer_id is not null and o.status = 'applied'
      and (o.subject_type = 'charge' or (o.subject_type = 'settlement' and o.adjust_type = 'add'))
),
fifo as (
  select w.invoice_id, w.customer_id, w.amount,
    coalesce(sum(w.amount) over (partition by w.customer_id order by w.d, w.k, w.t, w.invoice_id
                                 rows between unbounded preceding and 1 preceding), 0) as before
  from owed w
),
paid as (
  select f.invoice_id as id, x.ret,
    (x.direct + greatest(0, least(f.amount, coalesce(pl.amount, 0) - f.before)))::numeric(14,2) as amount
  from fifo f join inv2 x on x.id = f.invoice_id left join pool pl on pl.customer_id = f.customer_id
  where f.invoice_id is not null
)
select i.id, i.invoice_no, i.customer_id, i.invoice_date, i.purchase_date, i.po_number, i.total_boxes, i.total_pcs,
  i.total_amount, i.created_by, i.created_by_name, i.created_at,
  c.first_name, c.last_name, c.account_no, c.business_name, c.status as customer_status,
  pd.amount as amount_paid,
  (i.total_amount - pd.ret - pd.amount)::numeric(14,2) as balance,
  case when pd.ret + pd.amount >= i.total_amount then 'paid' when pd.ret + pd.amount > 0 then 'partial' else 'unpaid' end as pay_status,
  i.payment_terms,
  case when i.payment_terms ~ '^[0-9]{1,3} DAYS$' then i.invoice_date + split_part(i.payment_terms, ' ', 1)::int
       when i.payment_terms = 'CASH ON DELIVERY' then i.invoice_date end as due_date,
  pd.ret::numeric(14,2) as amount_returned
from public.customer_invoices i
join public.customers c on c.id = i.customer_id
join paid pd on pd.id = i.id;

-- Record a return on an invoice. Staff who record invoices or credit memos, and the Director (whose return is
-- approved at once; an employee's waits for the Director in Credit Memo).
create or replace function public.record_return(p_invoice uuid, p_amount numeric, p_date date, p_items text, p_qty int default 0, p_note text default null)
returns public.credit_memos
language plpgsql security definer set search_path = '' as $$
declare i public.customer_invoices; m public.credit_memos; already numeric;
begin
  if not (public.can_write('invoices') or public.can_write('creditmemos')) then
    raise exception 'You do not have access to record returns';
  end if;
  select * into i from public.customer_invoices where id = p_invoice;
  if not found then raise exception 'Invoice not found'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Enter the return amount'; end if;
  if coalesce(trim(p_items), '') = '' then raise exception 'Enter the items returned'; end if;
  select coalesce(sum(request_amount), 0) into already from public.credit_memos
    where invoice_id = p_invoice and is_return and status in ('pending','approved','paid');
  if already + p_amount > i.total_amount then
    raise exception 'The returns (PHP %) cannot be more than the invoice (PHP %)', to_char(already + p_amount, 'FM999,999,990.00'), to_char(i.total_amount, 'FM999,999,990.00');
  end if;
  insert into public.credit_memos (memo_date, customer_id, po_number, serial_no, qty, defect_category, defect_detail,
                                   requested_action, request_amount, invoice_id, is_return, inspection_notes)
  values (coalesce(p_date, (now() at time zone 'Asia/Manila')::date), i.customer_id, i.invoice_no, trim(p_items), greatest(coalesce(p_qty, 0), 0),
          'other', 'RETURN of invoice ' || i.invoice_no, 'credit', p_amount, i.id, true, nullif(trim(coalesce(p_note, '')), ''))
  returning * into m;
  insert into public.customer_events (customer_id, action, note, actor, actor_name)
  values (i.customer_id, 'return recorded', m.memo_no || ' [[U+00B7]] ' || i.invoice_no || ' [[U+00B7]] PHP ' || to_char(p_amount, 'FM999,999,990.00'),
          auth.uid(), (select full_name from public.profiles where id = auth.uid()));
  if public.is_admin() then
    m := public.credit_memo_action(m.id, 'approve', 'Return of ' || i.invoice_no);
  end if;
  return m;
end;
$$;
revoke execute on function public.record_return(uuid, numeric, date, text, int, text) from public, anon;
grant execute on function public.record_return(uuid, numeric, date, text, int, text) to authenticated;

select 'UPDATE 2.8 READY - returns can be recorded on an invoice' as result;

-- ======== 021_join_us.sql ========
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 2.9: Join Us
-- The open job positions can be seen by anyone (the Join Us page on the sign-in screen). Applying still needs a free
-- account, so every application keeps its status and the applicant can follow it.
-- Run once in the Supabase SQL Editor after 020_invoice_return.sql. It is safe to run again.
-- =====================================================================

grant select on public.job_positions to anon;
drop policy if exists "pos: public open" on public.job_positions;
create policy "pos: public open" on public.job_positions for select to anon using (is_open);

select 'UPDATE 2.9 READY - open job positions are shown on Join Us' as result;

-- ======== 022_update_2_9.sql ========
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 2.9: split payment links, link history, corrections without a reason
-- 1. A payment can be linked to several invoices. Each link takes only what the invoice still needs; the rest of the
--    payment stays AVAILABLE and can be linked to another invoice (until then it pays the oldest invoices first). A
--    payment that is fully linked no longer shows in Link a Payment. Every link and unlink is kept as the invoice's
--    linked payment history.
-- 2. When the customer has paid more than everything owed, the extra shows on the newest invoice as a negative
--    balance (for example -123.00), the same amount as the account's negative balance.
-- 3. A correction needs no reason. The person who asked is told when the Director approves it, with the Director's
--    name.
-- 4. Documents issued from the customer's Request menu are written in the customer's history.
-- Run once in the Supabase SQL Editor after 021_join_us.sql. It is safe to run again.
-- =====================================================================

-- ---------- 1. payment links ----------
create table if not exists public.payment_links (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments_received(id) on delete cascade,
  invoice_id uuid not null references public.customer_invoices(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  amount numeric(14,2) not null check (amount > 0),
  linked_at timestamptz not null default now(),
  linked_by uuid references public.profiles(id) on delete set null,
  linked_by_name text,
  removed_at timestamptz,
  removed_by uuid references public.profiles(id) on delete set null,
  removed_by_name text
);
create index if not exists payment_links_payment_idx on public.payment_links(payment_id);
create index if not exists payment_links_invoice_idx on public.payment_links(invoice_id);
create index if not exists payment_links_customer_idx on public.payment_links(customer_id);
create index if not exists payment_links_linked_by_idx on public.payment_links(linked_by);
create index if not exists payment_links_removed_by_idx on public.payment_links(removed_by);
alter table public.payment_links enable row level security;
revoke all on public.payment_links from anon;
grant select on public.payment_links to authenticated;
drop policy if exists "plinks: active read" on public.payment_links;
create policy "plinks: active read" on public.payment_links for select to authenticated using ((select public.is_active()));

-- The links made before (one invoice per payment, update 2.7.3) become link rows: on each invoice the payments are
-- taken in the order they were paid, each up to what the invoice still needed (the rest of a payment stays available,
-- as it was: it paid the oldest invoices). Then the old one-invoice link is cleared.
do $$
declare r record; need numeric; take numeric; cur uuid := null;
begin
  if exists (select 1 from public.payment_links) then return; end if;
  for r in
    select p.id as pay, p.amount, p.customer_id, p.created_by, p.created_by_name, p.created_at, i.id as inv,
           i.total_amount - coalesce((select sum(m.request_amount) from public.credit_memos m
             where m.invoice_id = i.id and m.status in ('approved','paid') and m.requested_action in ('credit','discount')), 0) as owed
    from public.payments_received p join public.customer_invoices i on i.id = p.invoice_id and i.customer_id = p.customer_id
    order by i.id, p.paid_date, p.created_at, p.id
  loop
    if cur is distinct from r.inv then cur := r.inv; need := greatest(0, r.owed); end if;
    take := least(r.amount, need);
    if take > 0 then
      insert into public.payment_links (payment_id, invoice_id, customer_id, amount, linked_at, linked_by_name)
      values (r.pay, r.inv, r.customer_id, take, r.created_at, 'E-Portal (link before update 2.9)');
      need := need - take;
    end if;
  end loop;
  perform set_config('eo.allow_change', 'on', true);
  update public.payments_received set invoice_id = null where invoice_id is not null;
  perform set_config('eo.allow_change', 'off', true);
end $$;

-- What each invoice has been paid: approved returns of the invoice first, then the payment amounts linked to it, then
-- everything else on the account (the unlinked part of each payment, credits, discounts, take-off adjustments) pays the
-- oldest invoices first. What is left after everything owed is paid goes on the newest invoice, so its balance is
-- negative (the customer has paid more than owed).
create or replace view public.invoice_balances with (security_invoker = true) as
with lp as (
  select l.invoice_id, sum(l.amount)::numeric as amount
  from public.payment_links l where l.removed_at is null group by l.invoice_id
),
lr as (
  select m.invoice_id, sum(m.request_amount)::numeric as amount
  from public.credit_memos m
  where m.invoice_id is not null and m.status in ('approved','paid') and m.requested_action in ('credit','discount')
  group by m.invoice_id
),
inv as (
  select i.id, i.customer_id, i.total_amount,
    least(i.total_amount, coalesce(r.amount, 0))::numeric as ret,
    greatest(0, coalesce(r.amount, 0) - i.total_amount)::numeric as ret_extra,
    coalesce(l.amount, 0)::numeric as lpay
  from public.customer_invoices i left join lp l on l.invoice_id = i.id left join lr r on r.invoice_id = i.id
),
inv2 as (
  select x.*, least(x.total_amount - x.ret, x.lpay)::numeric as direct,
    (greatest(0, x.lpay - (x.total_amount - x.ret)) + x.ret_extra)::numeric as extra
  from inv x
),
pool as (
  select c.id as customer_id,
    coalesce((select sum(p.amount) from public.payments_received p where p.customer_id = c.id), 0)
    - coalesce((select sum(l.amount) from public.payment_links l
                join public.payments_received p on p.id = l.payment_id and p.customer_id = c.id
                join public.customer_invoices x on x.id = l.invoice_id and x.customer_id = c.id
                where l.removed_at is null), 0)
    + coalesce((select sum(x.extra) from inv2 x where x.customer_id = c.id), 0)
    + coalesce((select sum(m.request_amount) from public.credit_memos m
                where m.customer_id = c.id and m.status in ('approved','paid') and m.requested_action in ('credit','discount')
                  and (m.invoice_id is null
                    or not exists (select 1 from public.customer_invoices x where x.id = m.invoice_id and x.customer_id = c.id))), 0)
    + coalesce((select sum(o.amount) from public.order_letters o
                where o.customer_id = c.id and o.status = 'applied' and o.subject_type = 'settlement' and o.adjust_type = 'reduce'), 0) as amount
  from public.customers c
),
owed as (
  select c.id as customer_id, null::uuid as invoice_id, c.application_date as d, 0 as k, c.created_at as t, c.opening_balance::numeric as amount
    from public.customers c where c.opening_balance > 0
  union all
  select i.customer_id, i.id, i.invoice_date, 1, i.created_at, (i.total_amount - x.ret - x.direct)::numeric
    from public.customer_invoices i join inv2 x on x.id = i.id
  union all
  select o.customer_id, null::uuid, (coalesce(o.applied_at, o.created_at) at time zone 'Asia/Manila')::date, 2, o.created_at, o.amount::numeric
    from public.order_letters o
    where o.customer_id is not null and o.status = 'applied'
      and (o.subject_type = 'charge' or (o.subject_type = 'settlement' and o.adjust_type = 'add'))
),
fifo as (
  select w.invoice_id, w.customer_id, w.amount,
    coalesce(sum(w.amount) over (partition by w.customer_id order by w.d, w.k, w.t, w.invoice_id
                                 rows between unbounded preceding and 1 preceding), 0) as before,
    sum(w.amount) over (partition by w.customer_id) as total
  from owed w
),
newest as (
  select distinct on (i.customer_id) i.customer_id, i.id
  from public.customer_invoices i order by i.customer_id, i.invoice_date desc, i.created_at desc, i.id desc
),
paid as (
  select f.invoice_id as id, x.ret,
    (x.direct + greatest(0, least(f.amount, coalesce(pl.amount, 0) - f.before))
       + case when nw.id = f.invoice_id then greatest(0, coalesce(pl.amount, 0) - f.total) else 0 end)::numeric(14,2) as amount
  from fifo f join inv2 x on x.id = f.invoice_id left join pool pl on pl.customer_id = f.customer_id
    left join newest nw on nw.customer_id = f.customer_id
  where f.invoice_id is not null
)
select i.id, i.invoice_no, i.customer_id, i.invoice_date, i.purchase_date, i.po_number, i.total_boxes, i.total_pcs,
  i.total_amount, i.created_by, i.created_by_name, i.created_at,
  c.first_name, c.last_name, c.account_no, c.business_name, c.status as customer_status,
  pd.amount as amount_paid,
  (i.total_amount - pd.ret - pd.amount)::numeric(14,2) as balance,
  case when pd.ret + pd.amount >= i.total_amount then 'paid' when pd.ret + pd.amount > 0 then 'partial' else 'unpaid' end as pay_status,
  i.payment_terms,
  case when i.payment_terms ~ '^[0-9]{1,3} DAYS$' then i.invoice_date + split_part(i.payment_terms, ' ', 1)::int
       when i.payment_terms = 'CASH ON DELIVERY' then i.invoice_date end as due_date,
  pd.ret::numeric(14,2) as amount_returned
from public.customer_invoices i
join public.customers c on c.id = i.customer_id
join paid pd on pd.id = i.id;

-- Each payment: its amount, what is linked to invoices, and what is still available to link.
create or replace view public.payment_available with (security_invoker = true) as
select p.id, p.customer_id, p.receipt_no, p.paid_date, p.amount,
  coalesce(l.linked, 0)::numeric(14,2) as linked,
  (p.amount - coalesce(l.linked, 0))::numeric(14,2) as available
from public.payments_received p
left join (select payment_id, sum(amount) as linked from public.payment_links where removed_at is null group by payment_id) l on l.payment_id = p.id;
revoke all on public.payment_available from anon;
grant select on public.payment_available to authenticated;

-- Link a payment to an invoice of the same customer: p_amount (or, when it is not given, as much as the invoice still
-- needs, up to what the payment has available). p_invoice null: take off every link of the payment (the portal before
-- 2.9 unlinked this way). Staff who record payments or invoices, and the Director.
drop function if exists public.link_payment(uuid, uuid);
create or replace function public.link_payment(p_payment uuid, p_invoice uuid, p_amount numeric default null) returns public.payment_links
language plpgsql security definer set search_path = '' as $$
declare p public.payments_received; i public.customer_invoices; l public.payment_links; me text; avail numeric; need numeric; amt numeric;
begin
  if not (public.can_write('payments') or public.can_write('invoices')) then
    raise exception 'You do not have access to link payments';
  end if;
  select * into p from public.payments_received where id = p_payment for update;
  if not found then raise exception 'Payment not found'; end if;
  me := (select full_name from public.profiles where id = auth.uid());
  if p_invoice is null then
    for l in select * from public.payment_links where payment_id = p_payment and removed_at is null loop
      perform public.unlink_payment(l.id);
    end loop;
    return null;
  end if;
  select * into i from public.customer_invoices where id = p_invoice;
  if not found or i.customer_id <> p.customer_id then raise exception 'This invoice is not of the same customer'; end if;
  avail := p.amount - coalesce((select sum(amount) from public.payment_links where payment_id = p_payment and removed_at is null), 0);
  need := i.total_amount
    - coalesce((select sum(m.request_amount) from public.credit_memos m
                where m.invoice_id = i.id and m.status in ('approved','paid') and m.requested_action in ('credit','discount')), 0)
    - coalesce((select sum(amount) from public.payment_links where invoice_id = i.id and removed_at is null), 0);
  if avail <= 0 then raise exception 'Receipt % is already fully linked', p.receipt_no; end if;
  if need <= 0 then raise exception 'Invoice % is already fully paid by linked payments', i.invoice_no; end if;
  amt := coalesce(p_amount, least(avail, need));
  if amt <= 0 then raise exception 'Enter the amount to link'; end if;
  if amt > avail then raise exception 'Only PHP % of receipt % is available', to_char(avail, 'FM999,999,990.00'), p.receipt_no; end if;
  if amt > need then raise exception 'Invoice % needs only PHP %', i.invoice_no, to_char(need, 'FM999,999,990.00'); end if;
  insert into public.payment_links (payment_id, invoice_id, customer_id, amount, linked_by, linked_by_name)
  values (p.id, i.id, p.customer_id, amt, auth.uid(), me)
  returning * into l;
  insert into public.customer_events (customer_id, action, note, actor, actor_name)
  values (p.customer_id, 'payment linked',
          coalesce(p.receipt_no, '') || ' [[U+2192]] ' || i.invoice_no || ' [[U+00B7]] PHP ' || to_char(amt, 'FM999,999,990.00'), auth.uid(), me);
  return l;
end;
$$;
revoke execute on function public.link_payment(uuid, uuid, numeric) from public, anon;
grant execute on function public.link_payment(uuid, uuid, numeric) to authenticated;

-- Take off one link: it stays in the invoice's history as UNLINKED, and its amount is available again.
create or replace function public.unlink_payment(p_link uuid) returns public.payment_links
language plpgsql security definer set search_path = '' as $$
declare l public.payment_links; me text;
begin
  if not (public.can_write('payments') or public.can_write('invoices')) then
    raise exception 'You do not have access to link payments';
  end if;
  select * into l from public.payment_links where id = p_link for update;
  if not found then raise exception 'Link not found'; end if;
  if l.removed_at is not null then raise exception 'This link was already taken off'; end if;
  me := (select full_name from public.profiles where id = auth.uid());
  update public.payment_links set removed_at = now(), removed_by = auth.uid(), removed_by_name = me where id = p_link
    returning * into l;
  insert into public.customer_events (customer_id, action, note, actor, actor_name)
  values (l.customer_id, 'payment unlinked',
          coalesce((select receipt_no from public.payments_received where id = l.payment_id), '') || ' unlinked from '
            || coalesce((select invoice_no from public.customer_invoices where id = l.invoice_id), '') || ' [[U+00B7]] PHP ' || to_char(l.amount, 'FM999,999,990.00'),
          auth.uid(), me);
  return l;
end;
$$;
revoke execute on function public.unlink_payment(uuid) from public, anon;
grant execute on function public.unlink_payment(uuid) to authenticated;

-- When an invoice needs less than its links give (a return, or a lower amount after a correction), the newest links
-- are taken off and, where only part of one is too much, linked again for what the invoice still needs. What is taken
-- off is available again on the payment. Both show in the invoice's linked payment history.
create or replace function public.fit_invoice_links(p_invoice uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare cap numeric; over numeric; l public.payment_links; why text := 'E-Portal (the invoice now needs less)';
begin
  select i.total_amount - coalesce((select sum(m.request_amount) from public.credit_memos m
           where m.invoice_id = i.id and m.status in ('approved','paid') and m.requested_action in ('credit','discount')), 0)
    into cap from public.customer_invoices i where i.id = p_invoice;
  if cap is null then return; end if;
  over := coalesce((select sum(amount) from public.payment_links where invoice_id = p_invoice and removed_at is null), 0) - greatest(cap, 0);
  while over > 0.004 loop
    select * into l from public.payment_links where invoice_id = p_invoice and removed_at is null order by linked_at desc, id desc limit 1;
    exit when not found;
    update public.payment_links set removed_at = now(), removed_by_name = why where id = l.id;
    if l.amount > over then
      insert into public.payment_links (payment_id, invoice_id, customer_id, amount, linked_by_name)
      values (l.payment_id, l.invoice_id, l.customer_id, l.amount - over, why);
    end if;
    insert into public.customer_events (customer_id, action, note, actor_name)
    values (l.customer_id, 'payment link changed',
            coalesce((select receipt_no from public.payments_received where id = l.payment_id), '') || ' [[U+2192]] '
              || coalesce((select invoice_no from public.customer_invoices where id = l.invoice_id), '') || ' [[U+00B7]] PHP '
              || to_char(l.amount, 'FM999,999,990.00') || ' now PHP ' || to_char(greatest(l.amount - over, 0), 'FM999,999,990.00'), why);
    over := over - l.amount;
  end loop;
end;
$$;
revoke execute on function public.fit_invoice_links(uuid) from public, anon, authenticated;

create or replace function public.links_follow_invoice() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'credit_memos' then
    if new.invoice_id is not null then perform public.fit_invoice_links(new.invoice_id); end if;
  elsif new.total_amount < old.total_amount then
    perform public.fit_invoice_links(new.id);
  end if;
  return null;
end;
$$;
revoke execute on function public.links_follow_invoice() from public, anon, authenticated;
drop trigger if exists links_follow_return on public.credit_memos;
create trigger links_follow_return after insert or update of status, request_amount, invoice_id on public.credit_memos
  for each row execute function public.links_follow_invoice();
drop trigger if exists links_follow_amount on public.customer_invoices;
create trigger links_follow_amount after update of total_amount on public.customer_invoices
  for each row execute function public.links_follow_invoice();

-- The oldest amount not paid (the days overdue on orders and on the Request documents): an invoice is unpaid by its
-- own balance (links first, then oldest first); the opening balance and charges by the oldest-first order.
create or replace function public.account_due(p_customer uuid) returns jsonb
language sql stable security definer set search_path = '' set timezone to 'Asia/Manila' as $$
  with paid as (
    select coalesce((select sum(p.amount) from public.payments_received p where p.customer_id = p_customer), 0)
         + coalesce((select sum(m.request_amount) from public.credit_memos m where m.customer_id = p_customer and m.status in ('approved','paid')
                       and m.requested_action in ('credit','discount')), 0)
         + coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = p_customer and o.status = 'applied' and o.subject_type = 'settlement' and o.adjust_type = 'reduce'), 0) as total
  ), inv as (
    select x.invoice_no, x.invoice_date, x.is_inv, sum(x.amount) over (order by x.invoice_date, x.at, x.invoice_no) as running
    from (select 'Opening Balance' as invoice_no, c.application_date as invoice_date, c.created_at as at, c.opening_balance as amount, false as is_inv
          from public.customers c where c.id = p_customer and c.opening_balance > 0
          union all
          select i.invoice_no, i.invoice_date, i.created_at as at, i.total_amount as amount, true from public.customer_invoices i where i.customer_id = p_customer
          union all
          select o.order_no, o.applied_at::date, o.applied_at, o.amount, false from public.order_letters o
          where o.customer_id = p_customer and o.status = 'applied' and (o.subject_type = 'charge' or (o.subject_type = 'settlement' and o.adjust_type = 'add'))) x
  ), other as (
    select inv.invoice_no, inv.invoice_date from inv, paid where inv.running > paid.total and not inv.is_inv order by inv.running limit 1
  ), unpaid as (
    select b.invoice_no, b.invoice_date from public.invoice_balances b
    where b.customer_id = p_customer and b.balance > 0.004 order by b.invoice_date, b.created_at limit 1
  ), oldest as (
    select x.invoice_no, x.invoice_date from (select * from other union all select * from unpaid) x order by x.invoice_date limit 1
  )
  select jsonb_build_object(
    'balance_due', coalesce((select b.balance_due from public.customer_balances b where b.customer_id = p_customer), 0),
    'days_overdue', coalesce((select greatest(0, current_date - o.invoice_date) from oldest o), 0),
    'oldest_invoice_no', (select o.invoice_no from oldest o),
    'oldest_invoice_date', (select o.invoice_date from oldest o))
  where public.is_active();
$$;
revoke execute on function public.account_due(uuid) from public, anon;
grant execute on function public.account_due(uuid) to authenticated;

-- The online check of an invoice shows its balance as on the invoice page (links, returns, a negative balance when
-- overpaid), and an invoice with linked payments is deleted only after they are unlinked.
do $$
declare
  fixes text[][] := array[
    ['verify_record', 'coalesce((select b.amount_paid from public.invoice_balances b where b.id = i.id), 0) as paid',
                      'coalesce((select b.amount_paid from public.invoice_balances b where b.id = i.id), 0) as paid, (select b.balance from public.invoice_balances b where b.id = i.id) as bal, (select b.pay_status from public.invoice_balances b where b.id = i.id) as pst'],
    ['verify_record', '''status'', case when r.paid >= r.total_amount then ''paid'' when r.paid > 0 then ''partial'' else ''unpaid'' end,',
                      '''status'', coalesce(r.pst, case when r.paid >= r.total_amount then ''paid'' when r.paid > 0 then ''partial'' else ''unpaid'' end),'],
    ['verify_record', 'to_char(greatest(r.total_amount - r.paid, 0), ''FM999,999,999,990.00'')',
                      'to_char(coalesce(r.bal, r.total_amount - r.paid), ''FM999,999,999,990.00'')'],
    ['delete_record', 'exists (select 1 from public.payments_received x where x.invoice_id = p_id) then',
                      'exists (select 1 from public.payment_links x where x.invoice_id = p_id and x.removed_at is null) then'],
    ['delete_record', '''This invoice has payments. Delete its payments first''',
                      '''This invoice has linked payments. Unlink them first (Linked Payments on the invoice)''']
  ];
  f record; def text; new_def text; i int;
begin
  for f in select p.oid, p.proname from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and pg_get_userbyid(p.proowner) = current_user
             and p.proname in ('verify_record', 'delete_record')
  loop
    def := pg_get_functiondef(f.oid);
    new_def := def;
    for i in 1 .. array_length(fixes, 1) loop
      -- added once: when the new text is already there (the script was run before), nothing is changed
      if fixes[i][1] = f.proname and position(fixes[i][3] in new_def) = 0 then
        if position(fixes[i][2] in new_def) = 0 then raise exception 'Update 2.9: % has changed; text not found: %', f.proname, left(fixes[i][2], 60); end if;
        new_def := replace(new_def, fixes[i][2], fixes[i][3]);
      end if;
    end loop;
    if new_def <> def then execute new_def; end if;
  end loop;
end $$;

-- ---------- returns with item lines and the warehouse ----------
-- A return lists up to 20 items (item / serial no, description, boxes, pcs, amount) with totals. Its kind is RETURN OF
-- ITEMS (the goods come back: NOT RECEIVED until the warehouse marks them RECEIVED), PRICE LESS, DAMAGE or OTHERS (no
-- goods come back).
alter table public.credit_memos add column if not exists return_lines jsonb;
alter table public.credit_memos add column if not exists return_kind text;
alter table public.credit_memos add column if not exists return_boxes integer not null default 0;
alter table public.credit_memos add column if not exists warehouse_status text;
alter table public.credit_memos add column if not exists warehouse_at timestamptz;
alter table public.credit_memos add column if not exists warehouse_by_name text;

drop function if exists public.record_return(uuid, numeric, date, text, int, text);
create or replace function public.record_return(p_invoice uuid, p_amount numeric, p_date date, p_items text, p_qty int default 0, p_note text default null,
  p_lines jsonb default null, p_kind text default 'return', p_boxes int default 0)
returns public.credit_memos
language plpgsql security definer set search_path = '' as $$
declare i public.customer_invoices; m public.credit_memos; already numeric; k text := coalesce(nullif(p_kind, ''), 'return');
  label text;
begin
  if not (public.can_write('invoices') or public.can_write('creditmemos')) then
    raise exception 'You do not have access to record returns';
  end if;
  select * into i from public.customer_invoices where id = p_invoice;
  if not found then raise exception 'Invoice not found'; end if;
  if k not in ('return','price_less','damage','other') then raise exception 'Unknown kind of return %', k; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Enter the return amount'; end if;
  if coalesce(trim(p_items), '') = '' then raise exception 'Enter the items returned'; end if;
  if p_lines is not null and (jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) > 20) then
    raise exception 'A return has up to 20 item lines';
  end if;
  select coalesce(sum(request_amount), 0) into already from public.credit_memos
    where invoice_id = p_invoice and is_return and status in ('pending','approved','paid');
  if already + p_amount > i.total_amount then
    raise exception 'The returns (PHP %) cannot be more than the invoice (PHP %)', to_char(already + p_amount, 'FM999,999,990.00'), to_char(i.total_amount, 'FM999,999,990.00');
  end if;
  label := case k when 'return' then 'RETURN OF ITEMS' when 'price_less' then 'PRICE LESS' when 'damage' then 'DAMAGE' else 'OTHERS' end;
  insert into public.credit_memos (memo_date, customer_id, po_number, serial_no, qty, defect_category, defect_detail,
                                   requested_action, request_amount, invoice_id, is_return, inspection_notes,
                                   return_lines, return_kind, return_boxes, warehouse_status)
  values (coalesce(p_date, (now() at time zone 'Asia/Manila')::date), i.customer_id, i.invoice_no, left(trim(p_items), 300), greatest(coalesce(p_qty, 0), 0),
          'other', label || ' [[U+00B7]] invoice ' || i.invoice_no, 'credit', p_amount, i.id, true, nullif(trim(coalesce(p_note, '')), ''),
          p_lines, k, greatest(coalesce(p_boxes, 0), 0), case when k = 'return' then 'not_received' end)
  returning * into m;
  insert into public.customer_events (customer_id, action, note, actor, actor_name)
  values (i.customer_id, 'return recorded', m.memo_no || ' [[U+00B7]] ' || label || ' [[U+00B7]] ' || i.invoice_no || ' [[U+00B7]] PHP ' || to_char(p_amount, 'FM999,999,990.00'),
          auth.uid(), (select full_name from public.profiles where id = auth.uid()));
  if public.is_admin() then
    m := public.credit_memo_action(m.id, 'approve', 'Return of ' || i.invoice_no);
  end if;
  return m;
end;
$$;
revoke execute on function public.record_return(uuid, numeric, date, text, int, text, jsonb, text, int) from public, anon;
grant execute on function public.record_return(uuid, numeric, date, text, int, text, jsonb, text, int) to authenticated;

-- The warehouse marks the returned items RECEIVED.
create or replace function public.return_received(p_memo uuid) returns public.credit_memos
language plpgsql security definer set search_path = '' as $$
declare m public.credit_memos; me text := (select full_name from public.profiles where id = auth.uid());
begin
  if not (public.can_write('invoices') or public.can_write('creditmemos')) then raise exception 'You do not have access to returns'; end if;
  select * into m from public.credit_memos where id = p_memo for update;
  if not found or not m.is_return then raise exception 'Return not found'; end if;
  if m.warehouse_status is distinct from 'not_received' then raise exception 'Return % is not waiting for the warehouse', m.memo_no; end if;
  perform public.allow_record_change();
  update public.credit_memos set warehouse_status = 'received', warehouse_at = now(), warehouse_by_name = me where id = p_memo returning * into m;
  insert into public.customer_events (customer_id, action, note, actor, actor_name)
  values (m.customer_id, 'return received', m.memo_no || ' [[U+00B7]] ' || coalesce(m.po_number, '') || ' [[U+00B7]] received at the warehouse', auth.uid(), me);
  return m;
end;
$$;
revoke execute on function public.return_received(uuid) from public, anon;
grant execute on function public.return_received(uuid) to authenticated;

-- ---------- 2. corrections need no reason; the person who asked is told; the record shows who approved ----------
-- A decided correction still keeps no old details (2.2). The record keeps one line: which details were changed, and
-- the Director who approved them (and who asked) or who edited them directly.
alter table public.change_requests alter column reason drop not null;
alter table public.record_changes add column if not exists requested_by_name text;

create or replace function public.submit_change_request(p_table text, p_id uuid, p_changes jsonb, p_reason text, p_label text default null)
returns public.change_requests
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare
  cols text[] := public.editable_columns(p_table);
  k text;
  old jsonb;
  cr public.change_requests;
begin
  if not public.is_active() then raise exception 'Not allowed'; end if;
  if cols is null then raise exception 'This kind of record cannot be corrected'; end if;
  if not public.can_see_table(p_table) then raise exception 'You do not have access to this kind of record'; end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then raise exception 'Nothing to correct'; end if;
  for k in select jsonb_object_keys(p_changes) loop
    if not (k = any(cols)) then raise exception 'The field "%" cannot be corrected', k; end if;
  end loop;
  execute format('select to_jsonb(t) from public.%I t where t.id = $1', p_table) into old using p_id;
  if old is null then raise exception 'Record not found'; end if;
  insert into public.change_requests (request_no, target_table, target_id, target_label, changes, previous, reason, requested_by, requested_by_name)
  values ('CR-' || to_char(current_date, 'YYYY') || '-' || lpad(public.next_counter('CR' || to_char(current_date, 'YYYY'))::text, 4, '0'),
          p_table, p_id, p_label, p_changes, (select jsonb_object_agg(x, old -> x) from jsonb_object_keys(p_changes) x),
          nullif(trim(coalesce(p_reason, '')), ''), auth.uid(), (select full_name from public.profiles where id = auth.uid()))
  returning * into cr;
  -- The Director's own correction is added straight away (a customer's: the main Director's only).
  if public.is_admin() and (p_table <> 'customers' or public.is_main_director()) then
    return public.decide_change_request(cr.id, 'approve', null);
  end if;
  perform public.notify_admins('Correction request ' || cr.request_no,
    coalesce(p_label, p_table) || coalesce(' - ' || cr.reason, '') || ' (from ' || coalesce(cr.requested_by_name, 'an employee') || ')', 'changes');
  return cr;
end;
$$;
revoke execute on function public.submit_change_request(text, uuid, jsonb, text, text) from public, anon;
grant execute on function public.submit_change_request(text, uuid, jsonb, text, text) to authenticated;

-- A decided correction leaves no record (2.2): approved, the record takes the corrected details; rejected, the record
-- stays as it is. The person who asked is told either way, with the Director's name.
create or replace function public.decide_change_request(p_id uuid, p_action text, p_note text) returns public.change_requests
language plpgsql security definer set search_path = '' as $$
declare cr public.change_requests; me text; prev jsonb;
begin
  select * into cr from public.change_requests where id = p_id for update;
  if cr.id is null then raise exception 'Request not found'; end if;
  if cr.status <> 'pending' then raise exception 'This request is already %', upper(cr.status); end if;
  if p_action not in ('approve', 'reject') then raise exception 'Unknown action %', p_action; end if;
  me := (select full_name from public.profiles where id = auth.uid());
  perform public.allow_record_change();
  if p_action = 'approve' then
    prev := public.apply_record_changes(cr.target_table, cr.target_id, cr.changes);
    cr.status := 'approved'; cr.previous := prev;
    insert into public.record_changes (target_table, target_id, action, changes, request_no, target_label, actor, actor_name, requested_by_name)
    values (cr.target_table, cr.target_id, case when cr.requested_by is distinct from auth.uid() then 'correction approved' else 'edited' end,
            (select jsonb_object_agg(x, 'null'::jsonb) from jsonb_object_keys(cr.changes) x), cr.request_no, cr.target_label, auth.uid(), me,
            case when cr.requested_by is distinct from auth.uid() then cr.requested_by_name end);
    if cr.requested_by is distinct from auth.uid() then
      perform public.notify_user(cr.requested_by, 'Correction ' || cr.request_no || ' approved by Director ' || coalesce(me, ''),
        coalesce(cr.target_label, '') || coalesce(' - ' || nullif(trim(p_note), ''), ''), public.record_link(cr.target_table, cr.target_id));
    end if;
  else
    cr.status := 'rejected';
    if cr.requested_by is distinct from auth.uid() then
      perform public.notify_user(cr.requested_by, 'Correction ' || cr.request_no || ' not approved by Director ' || coalesce(me, ''),
        coalesce(cr.target_label, '') || coalesce(' - ' || nullif(trim(p_note), ''), ''), public.record_link(cr.target_table, cr.target_id));
    end if;
  end if;
  delete from public.notifications where title = 'Correction request ' || cr.request_no;
  delete from public.change_requests where id = p_id;
  cr.review_note := p_note; cr.reviewed_by_name := me; cr.reviewed_at := now();
  return cr;
end;
$$;
revoke execute on function public.decide_change_request(uuid, text, text) from public, anon, authenticated;

-- The main Director's Edit Customer leaves the same one line (which details, edited by whom).
do $$
declare def text; anchor text := '  return jsonb_build_object(''changed'', to_jsonb(changed), ''statements'', restated, ''since'', since);';
  addition text := '  insert into public.record_changes (target_table, target_id, action, changes, target_label, actor, actor_name)
  values (''customers'', p_id, ''edited'', (select jsonb_object_agg(x, ''null''::jsonb) from unnest(changed) x),
          coalesce(c.account_no, c.application_no) || '' '' || c.first_name || '' '' || c.last_name, auth.uid(), (select full_name from public.profiles where id = auth.uid()));
';
begin
  def := pg_get_functiondef('public.director_edit_customer(uuid, jsonb)'::regprocedure);
  if position('''edited'', (select jsonb_object_agg(x, ''null''::jsonb) from unnest(changed) x)' in def) > 0 then return; end if;
  if position(anchor in def) = 0 then raise exception 'Update 2.9: director_edit_customer has changed; text not found'; end if;
  execute replace(def, anchor, addition || anchor);
end $$;

-- ---------- 4. documents issued from the customer's Request menu ----------
create or replace function public.log_customer_document(p_customer uuid, p_document text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;
  if not exists (select 1 from public.customers where id = p_customer) then raise exception 'Customer not found'; end if;
  insert into public.customer_events (customer_id, action, note, actor, actor_name)
  values (p_customer, 'document issued', left(coalesce(p_document, '') || coalesce(' [[U+00B7]] ' || nullif(trim(p_note), ''), ''), 300),
          auth.uid(), (select full_name from public.profiles where id = auth.uid()));
end;
$$;
revoke execute on function public.log_customer_document(uuid, text, text) from public, anon;
grant execute on function public.log_customer_document(uuid, text, text) to authenticated;

select 'UPDATE 2.9 READY - split payment links (' || (select count(*) from public.payment_links) || ' links), corrections without a reason' as result;

-- ======== 023_purchase_orders.sql ========
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
  total_amount numeric(14,2) not null default 0, -- BDT (taka)
  photos text[] not null default '{}',
  voices text[] not null default '{}',
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
alter table public.purchase_orders add column if not exists voices text[] not null default '{}';
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
    perform public.notify_admins('Purchase order ' || po.po_no || ' to review', po.lot_name || ' [[U+00B7]] BDT ' || to_char(po.total_amount, 'FM999,999,990.00') || ' (from ' || coalesce(me, '') || ')', 'po/' || po.id);
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

-- Voice notes (up to 10 recordings or attached audio files) for the Director to listen to before deciding. They are deleted
-- from the server as soon as the purchase order is approved (or cancelled or deleted).
create or replace function public.set_purchase_voices(p_id uuid, p_voices text[]) returns public.purchase_orders
language plpgsql security definer set search_path = '' as $$
declare po public.purchase_orders;
begin
  select * into po from public.purchase_orders where id = p_id for update;
  if not found then raise exception 'Purchase order not found'; end if;
  if po.status not in ('pending','negotiation') then raise exception 'The voice notes cannot be changed now'; end if;
  if not (public.is_admin() or po.created_by = auth.uid()) then raise exception 'Not allowed'; end if;
  if coalesce(array_length(p_voices, 1), 0) > 10 then raise exception 'Up to 10 voice notes'; end if;
  if exists (select 1 from unnest(p_voices) x where x not like 'purchase/' || p_id || '/voice%') then raise exception 'Wrong voice note'; end if;
  update public.purchase_orders set voices = coalesce(p_voices, '{}'), updated_at = now() where id = p_id returning * into po;
  return po;
end;
$$;
revoke execute on function public.set_purchase_voices(uuid, text[]) from public, anon;
grant execute on function public.set_purchase_voices(uuid, text[]) to authenticated;

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
    gone := po.voices; -- the voice notes are deleted from the server once the order is approved
    update public.purchase_orders set status = 'approved', approved_by = auth.uid(), approved_by_name = me, approved_at = now(), voices = '{}',
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
    gone := po.photos || po.voices;
    update public.purchase_orders set status = 'cancelled', photos = '{}', voices = '{}', cancelled_by_name = me, cancelled_at = now(),
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
  return po.photos || po.voices;
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

-- ======== 024_eo_office.sql ========
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.1: EO-Office (QC Test and Collection Voucher)
--
-- QC TEST: a quality check form. The form has a header (serial no, item, brand, batch, CTN) and 10 problems to look for
-- (COLORS EQUALLY, SIZES EQUALLY, UNFULFILLED BUNDLE COLORS, WRONG BUNDLE, STAIN, MISSING LABEL, MISSING TAG, MISTAKE
-- PACKAGE, MENDING MORE THAN __, LABEL INFORMATION INCORRECT). Every problem found takes 10 points off 100.
-- Each form gets a number QC-YYYY-#### (PDF417 barcode on the paper) and a PRIVATE CODE, printed on the blank form.
-- The server keeps only a scrambled (hashed) copy of the private code. The form stays LOCKED: anyone who scans the
-- barcode sees only the empty form. The result, the uploaded paper copy and the PDF copy need the private code
-- (5 wrong codes lock the form until the Director gives a new code).
--
-- COLLECTION VOUCHER: money collected, recorded month by month, with the receipt picture (the empty paper around it is cut off
-- in the portal before it is saved).
--
-- Run once in the Supabase SQL Editor after 023_purchase_orders.sql. It is safe to run again.
-- =====================================================================

-- ---------- QC TEST ----------
create table if not exists public.qc_tests (
  id uuid primary key default gen_random_uuid(),
  qc_no text unique,
  serial_no text,
  item text not null,
  brand text,
  batch text,
  ctn text,
  status text not null default 'locked' check (status in ('locked','done')),
  found_count int,
  score int,
  tested_at timestamptz,
  tested_by_name text,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists qc_tests_created_by_idx on public.qc_tests(created_by);
create index if not exists qc_tests_created_idx on public.qc_tests(created_at);
alter table public.qc_tests enable row level security;
revoke all on public.qc_tests from anon;
grant select on public.qc_tests to authenticated;
drop policy if exists "qc: read" on public.qc_tests;
create policy "qc: read" on public.qc_tests for select to authenticated using ((select public.is_staff()) and (select public.has_module('eooffice')));

-- The private part: the hashed private code, the wrong-code counter and the result. Nobody reads this table directly.
create table if not exists public.qc_results (
  qc_id uuid primary key references public.qc_tests(id) on delete cascade,
  code_hash text not null,
  failed_attempts int not null default 0,
  checks jsonb not null default '{}'::jsonb,
  mending_limit text,
  remarks text,
  docs text[] not null default '{}'
);
alter table public.qc_results enable row level security;
revoke all on public.qc_results from anon, authenticated;

create or replace function public.qc_can_write() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_staff() and public.has_module('eooffice');
$$;
revoke execute on function public.qc_can_write() from public, anon;
grant execute on function public.qc_can_write() to authenticated;

-- A private code looks like 7K3F-9A2C-D41E. It is never stored as written.
create or replace function public.qc_norm(p_code text) returns text
language sql immutable set search_path = '' as $$
  select upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
$$;
create or replace function public.qc_hash(p_id uuid, p_code text) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(p_id::text || ':' || public.qc_norm(p_code), 'UTF8')), 'hex');
$$;
create or replace function public.qc_make_code() returns text
language sql volatile set search_path = '' as $$
  select upper(substr(h, 1, 4) || '-' || substr(h, 5, 4) || '-' || substr(h, 9, 4))
  from (select replace(gen_random_uuid()::text, '-', '') as h) x;
$$;
revoke execute on function public.qc_norm(text), public.qc_hash(uuid, text), public.qc_make_code() from public, anon, authenticated;

-- Checks the private code. Gives 'ok', 'wrong', 'locked' (5 wrong codes) or 'none'. A wrong code is counted; this
-- function does not raise, so the count is kept.
create or replace function public.qc_try(p_id uuid, p_code text) returns text
language plpgsql security definer set search_path = '' as $$
declare r public.qc_results;
begin
  select * into r from public.qc_results where qc_id = p_id for update;
  if not found then return 'none'; end if;
  if r.failed_attempts >= 5 then return 'locked'; end if;
  if r.code_hash = public.qc_hash(p_id, p_code) then
    if r.failed_attempts > 0 then update public.qc_results set failed_attempts = 0 where qc_id = p_id; end if;
    return 'ok';
  end if;
  update public.qc_results set failed_attempts = failed_attempts + 1 where qc_id = p_id;
  return case when r.failed_attempts + 1 >= 5 then 'locked' else 'wrong' end;
end;
$$;
revoke execute on function public.qc_try(uuid, text) from public, anon, authenticated;

create or replace function public.qc_bad(p_state text, p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('ok', false, 'state', p_state,
    'left', greatest(5 - coalesce((select failed_attempts from public.qc_results where qc_id = p_id), 5), 0));
$$;
revoke execute on function public.qc_bad(text, uuid) from public, anon, authenticated;

-- A new QC form: the number, the private code (given back once, to print on the blank form) and the empty, locked form.
create or replace function public.create_qc(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare t public.qc_tests; code text; me text := (select full_name from public.profiles where id = auth.uid()); yr text := to_char(current_date, 'YYYY');
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  if coalesce(trim(p_data ->> 'item'), '') = '' then raise exception 'Write the item'; end if;
  insert into public.qc_tests (qc_no, serial_no, item, brand, batch, ctn, created_by_name)
  values ('QC-' || yr || '-' || lpad(public.next_counter('QC' || yr)::text, 4, '0'), nullif(left(trim(coalesce(p_data ->> 'serial_no', '')), 60), ''),
    left(trim(p_data ->> 'item'), 120), nullif(left(trim(coalesce(p_data ->> 'brand', '')), 80), ''), nullif(left(trim(coalesce(p_data ->> 'batch', '')), 60), ''),
    nullif(left(trim(coalesce(p_data ->> 'ctn', '')), 60), ''), me)
  returning * into t;
  code := public.qc_make_code();
  insert into public.qc_results (qc_id, code_hash) values (t.id, public.qc_hash(t.id, code));
  return jsonb_build_object('id', t.id, 'qc_no', t.qc_no, 'code', code);
end;
$$;
revoke execute on function public.create_qc(jsonb) from public, anon;
grant execute on function public.create_qc(jsonb) to authenticated;

-- Opens the private part with the code: the checks, the remarks and the paper copies.
create or replace function public.qc_open(p_id uuid, p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s text; r public.qc_results;
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  s := public.qc_try(p_id, p_code);
  if s = 'none' then raise exception 'QC form not found'; end if;
  if s <> 'ok' then return public.qc_bad(s, p_id); end if;
  select * into r from public.qc_results where qc_id = p_id;
  return jsonb_build_object('ok', true, 'checks', r.checks, 'mending_limit', r.mending_limit, 'remarks', r.remarks, 'docs', to_jsonb(r.docs));
end;
$$;
revoke execute on function public.qc_open(uuid, text) from public, anon;
grant execute on function public.qc_open(uuid, text) to authenticated;

-- Saves the result (needs the code again): each problem found takes 10 points off 100.
create or replace function public.qc_save(p_id uuid, p_code text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare s text; k text; ck jsonb := '{}'::jsonb; n int := 0; me text := (select full_name from public.profiles where id = auth.uid());
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  s := public.qc_try(p_id, p_code);
  if s = 'none' then raise exception 'QC form not found'; end if;
  if s <> 'ok' then return public.qc_bad(s, p_id); end if;
  foreach k in array array['colors','sizes','bundle_colors','wrong_bundle','stain','missing_label','missing_tag','mistake_package','mending','label_info'] loop
    if coalesce((p_data -> 'checks' ->> k)::boolean, false) then n := n + 1; ck := ck || jsonb_build_object(k, true); end if;
  end loop;
  update public.qc_results set checks = ck, mending_limit = nullif(left(trim(coalesce(p_data ->> 'mending_limit', '')), 20), ''),
    remarks = nullif(left(trim(coalesce(p_data ->> 'remarks', '')), 1000), '') where qc_id = p_id;
  update public.qc_tests set status = 'done', found_count = n, score = 100 - 10 * n, tested_at = now(), tested_by_name = me where id = p_id;
  return jsonb_build_object('ok', true, 'found_count', n, 'score', 100 - 10 * n);
end;
$$;
revoke execute on function public.qc_save(uuid, text, jsonb) from public, anon;
grant execute on function public.qc_save(uuid, text, jsonb) to authenticated;

-- The uploaded paper copies of the filled form (up to 6). Gives back the files that are no longer used.
create or replace function public.qc_set_docs(p_id uuid, p_code text, p_docs text[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s text; old text[];
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  s := public.qc_try(p_id, p_code);
  if s = 'none' then raise exception 'QC form not found'; end if;
  if s <> 'ok' then return public.qc_bad(s, p_id); end if;
  if coalesce(array_length(p_docs, 1), 0) > 6 then raise exception 'Up to 6 pictures'; end if;
  if exists (select 1 from unnest(p_docs) x where x not like 'qc/' || p_id || '/%') then raise exception 'Wrong file'; end if;
  select docs into old from public.qc_results where qc_id = p_id;
  update public.qc_results set docs = coalesce(p_docs, '{}') where qc_id = p_id;
  return jsonb_build_object('ok', true, 'removed', to_jsonb(array(select x from unnest(old) x where x <> all (coalesce(p_docs, '{}')))));
end;
$$;
revoke execute on function public.qc_set_docs(uuid, text, text[]) from public, anon;
grant execute on function public.qc_set_docs(uuid, text, text[]) to authenticated;

-- A new private code: the Director any time; the person who made the form only until a result is saved (the blank form was lost).
create or replace function public.qc_new_code(p_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare t public.qc_tests; code text;
begin
  select * into t from public.qc_tests where id = p_id for update;
  if not found then raise exception 'QC form not found'; end if;
  if not (public.is_admin() or (t.created_by = auth.uid() and t.status = 'locked' and public.qc_can_write())) then raise exception 'Only the Director can give a new code'; end if;
  code := public.qc_make_code();
  update public.qc_results set code_hash = public.qc_hash(p_id, code), failed_attempts = 0 where qc_id = p_id;
  return code;
end;
$$;
revoke execute on function public.qc_new_code(uuid) from public, anon;
grant execute on function public.qc_new_code(uuid) to authenticated;

-- The Director deletes a QC form; gives back the paper copies so the portal deletes the files.
create or replace function public.delete_qc(p_id uuid) returns text[]
language plpgsql security definer set search_path = '' as $$
declare gone text[];
begin
  if not public.is_admin() then raise exception 'Only the Director can delete a QC form'; end if;
  select docs into gone from public.qc_results where qc_id = p_id;
  delete from public.qc_tests where id = p_id;
  return coalesce(gone, '{}');
end;
$$;
revoke execute on function public.delete_qc(uuid) from public, anon;
grant execute on function public.delete_qc(uuid) to authenticated;

-- ---------- COLLECTION VOUCHER ----------
create table if not exists public.collection_vouchers (
  id uuid primary key default gen_random_uuid(),
  cv_no text unique,
  cv_date date not null default ((now() at time zone 'Asia/Manila')::date),
  received_from text not null,
  amount numeric(14,2) not null check (amount > 0),
  method text not null default 'cash' check (method in ('cash','bank','gcash','check','other')),
  reference_no text,
  note text,
  receipt_path text,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists collection_vouchers_date_idx on public.collection_vouchers(cv_date);
create index if not exists collection_vouchers_created_by_idx on public.collection_vouchers(created_by);
alter table public.collection_vouchers enable row level security;
revoke all on public.collection_vouchers from anon;
grant select on public.collection_vouchers to authenticated;
drop policy if exists "cv: read" on public.collection_vouchers;
create policy "cv: read" on public.collection_vouchers for select to authenticated using ((select public.is_staff()) and (select public.has_module('eooffice')));

-- New voucher (p_id null) or a change: the Director any time, the person who made it for 24 hours.
create or replace function public.save_collection(p_id uuid, p_data jsonb) returns public.collection_vouchers
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare v public.collection_vouchers; me text := (select full_name from public.profiles where id = auth.uid()); amt numeric; mth text;
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  if coalesce(trim(p_data ->> 'received_from'), '') = '' then raise exception 'Write who the money was collected from'; end if;
  amt := coalesce(nullif(p_data ->> 'amount', '')::numeric, 0);
  if amt <= 0 then raise exception 'Write the amount collected'; end if;
  mth := case when p_data ->> 'method' in ('cash','bank','gcash','check','other') then p_data ->> 'method' else 'cash' end;
  if p_id is null then
    insert into public.collection_vouchers (cv_no, cv_date, received_from, amount, method, reference_no, note, created_by_name)
    values ('CV-' || to_char(coalesce(nullif(p_data ->> 'cv_date', '')::date, current_date), 'YYYYMM') || '-' || lpad(public.next_counter('CV' || to_char(coalesce(nullif(p_data ->> 'cv_date', '')::date, current_date), 'YYYYMM'))::text, 3, '0'),
      coalesce(nullif(p_data ->> 'cv_date', '')::date, current_date), left(trim(p_data ->> 'received_from'), 120), round(amt, 2), mth,
      nullif(left(trim(coalesce(p_data ->> 'reference_no', '')), 60), ''), nullif(left(trim(coalesce(p_data ->> 'note', '')), 300), ''), me)
    returning * into v;
    return v;
  end if;
  select * into v from public.collection_vouchers where id = p_id for update;
  if not found then raise exception 'Collection voucher not found'; end if;
  if not (public.is_admin() or (v.created_by = auth.uid() and v.created_at > now() - interval '24 hours')) then
    raise exception 'Only the Director can change this voucher now (the person who made it can change it for 24 hours)';
  end if;
  update public.collection_vouchers set cv_date = coalesce(nullif(p_data ->> 'cv_date', '')::date, cv_date), received_from = left(trim(p_data ->> 'received_from'), 120),
    amount = round(amt, 2), method = mth, reference_no = nullif(left(trim(coalesce(p_data ->> 'reference_no', '')), 60), ''),
    note = nullif(left(trim(coalesce(p_data ->> 'note', '')), 300), ''), updated_at = now()
  where id = p_id returning * into v;
  return v;
end;
$$;
revoke execute on function public.save_collection(uuid, jsonb) from public, anon;
grant execute on function public.save_collection(uuid, jsonb) to authenticated;

-- The receipt picture (already cleaned and cut in the portal). Gives back the old file so it is deleted.
create or replace function public.set_collection_receipt(p_id uuid, p_path text) returns text
language plpgsql security definer set search_path = '' as $$
declare v public.collection_vouchers;
begin
  select * into v from public.collection_vouchers where id = p_id for update;
  if not found then raise exception 'Collection voucher not found'; end if;
  if not (public.is_admin() or (v.created_by = auth.uid() and v.created_at > now() - interval '24 hours')) then raise exception 'Only the Director can change this voucher now'; end if;
  if p_path is not null and p_path not like 'collection/' || p_id || '/%' then raise exception 'Wrong file'; end if;
  update public.collection_vouchers set receipt_path = p_path, updated_at = now() where id = p_id;
  return v.receipt_path;
end;
$$;
revoke execute on function public.set_collection_receipt(uuid, text) from public, anon;
grant execute on function public.set_collection_receipt(uuid, text) to authenticated;

create or replace function public.delete_collection(p_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v public.collection_vouchers;
begin
  if not public.is_admin() then raise exception 'Only the Director can delete a collection voucher'; end if;
  select * into v from public.collection_vouchers where id = p_id;
  if not found then raise exception 'Collection voucher not found'; end if;
  delete from public.collection_vouchers where id = p_id;
  return v.receipt_path;
end;
$$;
revoke execute on function public.delete_collection(uuid) from public, anon;
grant execute on function public.delete_collection(uuid) to authenticated;

select 'UPDATE 3.1 READY - EO-Office' as result;

-- ======== 025_qc_simple.sql ========
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.3: QC Test made simple (no lock, no private code)
-- The QC form is a ticket: make it (QC-YYYY-####, barcode), print it, check the goods on the paper, then open it in the portal
-- (scan the barcode or search the number) and update: a tick and a number for each problem, the total score (written by the
-- person; suggested as 100 minus 10 for each tick), remarks and the paper copy.
-- Run once in the Supabase SQL Editor after 024_eo_office.sql. It is safe to run again.
-- =====================================================================

-- the old lock and private code go away
drop function if exists public.qc_open(uuid, text);
drop function if exists public.qc_save(uuid, text, jsonb);
drop function if exists public.qc_set_docs(uuid, text, text[]);
drop function if exists public.qc_new_code(uuid);
drop function if exists public.qc_try(uuid, text);
drop function if exists public.qc_bad(text, uuid);
drop function if exists public.qc_hash(uuid, text);
drop function if exists public.qc_make_code();
drop function if exists public.qc_norm(text);
drop function if exists public.create_qc(jsonb);

alter table public.qc_results alter column code_hash drop not null;
alter table public.qc_results add column if not exists numbers jsonb not null default '{}'::jsonb;
-- the result is read by staff with EO-Office access (changes only through the functions below)
grant select on public.qc_results to authenticated;
drop policy if exists "qcr: read" on public.qc_results;
create policy "qcr: read" on public.qc_results for select to authenticated using ((select public.is_staff()) and (select public.has_module('eooffice')));

-- A new QC form: the number and the empty form.
create or replace function public.create_qc(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare t public.qc_tests; me text := (select full_name from public.profiles where id = auth.uid()); yr text := to_char(current_date, 'YYYY');
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  if coalesce(trim(p_data ->> 'item'), '') = '' then raise exception 'Write the item'; end if;
  insert into public.qc_tests (qc_no, serial_no, item, brand, batch, ctn, created_by_name)
  values ('QC-' || yr || '-' || lpad(public.next_counter('QC' || yr)::text, 4, '0'), nullif(left(trim(coalesce(p_data ->> 'serial_no', '')), 60), ''),
    left(trim(p_data ->> 'item'), 120), nullif(left(trim(coalesce(p_data ->> 'brand', '')), 80), ''), nullif(left(trim(coalesce(p_data ->> 'batch', '')), 60), ''),
    nullif(left(trim(coalesce(p_data ->> 'ctn', '')), 60), ''), me)
  returning * into t;
  insert into public.qc_results (qc_id) values (t.id);
  return jsonb_build_object('id', t.id, 'qc_no', t.qc_no);
end;
$$;
revoke execute on function public.create_qc(jsonb) from public, anon;
grant execute on function public.create_qc(jsonb) to authenticated;

-- Saves the result: p_data = { checks: {key: true}, numbers: {key: 5}, score: 70 (optional), remarks }.
-- Without a score the score is 100 minus 10 for each tick.
create or replace function public.qc_save(p_id uuid, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare k text; ck jsonb := '{}'::jsonb; nm jsonb := '{}'::jsonb; n int := 0; sc int; me text := (select full_name from public.profiles where id = auth.uid());
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  if not exists (select 1 from public.qc_tests where id = p_id) then raise exception 'QC form not found'; end if;
  foreach k in array array['colors','sizes','bundle_colors','wrong_bundle','stain','missing_label','missing_tag','mistake_package','mending','label_info'] loop
    if coalesce((p_data -> 'checks' ->> k)::boolean, false) then n := n + 1; ck := ck || jsonb_build_object(k, true); end if;
    if nullif(trim(coalesce(p_data -> 'numbers' ->> k, '')), '') is not null then nm := nm || jsonb_build_object(k, left(trim(p_data -> 'numbers' ->> k), 12)); end if;
  end loop;
  sc := coalesce(nullif(trim(coalesce(p_data ->> 'score', '')), '')::int, 100 - 10 * n);
  if sc < 0 or sc > 100 then raise exception 'The score is from 0 to 100'; end if;
  update public.qc_results set checks = ck, numbers = nm, remarks = nullif(left(trim(coalesce(p_data ->> 'remarks', '')), 1000), '') where qc_id = p_id;
  update public.qc_tests set status = 'done', found_count = n, score = sc, tested_at = now(), tested_by_name = me where id = p_id;
  return jsonb_build_object('ok', true, 'found_count', n, 'score', sc);
end;
$$;
revoke execute on function public.qc_save(uuid, jsonb) from public, anon;
grant execute on function public.qc_save(uuid, jsonb) to authenticated;

-- The paper copies of the filled form (up to 6). Gives back the files that are no longer used.
create or replace function public.qc_set_docs(p_id uuid, p_docs text[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare old text[];
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  if not exists (select 1 from public.qc_results where qc_id = p_id) then raise exception 'QC form not found'; end if;
  if coalesce(array_length(p_docs, 1), 0) > 6 then raise exception 'Up to 6 pictures'; end if;
  if exists (select 1 from unnest(p_docs) x where x not like 'qc/' || p_id || '/%') then raise exception 'Wrong file'; end if;
  select docs into old from public.qc_results where qc_id = p_id;
  update public.qc_results set docs = coalesce(p_docs, '{}') where qc_id = p_id;
  return jsonb_build_object('ok', true, 'removed', to_jsonb(array(select x from unnest(old) x where x <> all (coalesce(p_docs, '{}')))));
end;
$$;
revoke execute on function public.qc_set_docs(uuid, text[]) from public, anon;
grant execute on function public.qc_set_docs(uuid, text[]) to authenticated;

select 'UPDATE 3.3 READY - QC Test simple' as result;

-- ======== 026_eo_office_fixes.sql ========
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.4: EO-Office fixes
--  1. QC paper copies and collection receipts (and purchase order photos / voice notes) can be read only by the people who may
--     see those sections (before, any signed-in person could read the files if they knew where they were)
--  2. People with EO-Office can delete (replace) those files, not only the uploader within 24 hours
--  3. A collection receipt can be changed only by people with EO-Office access
--  4. The old private-code column of QC forms is removed; two people changing the paper copies at once cannot lose a file
-- Run once in the Supabase SQL Editor after 025_qc_simple.sql. It is safe to run again.
-- =====================================================================

drop policy if exists "storage records: eooffice files" on storage.objects;
create policy "storage records: eooffice files" on storage.objects as restrictive for select to authenticated
  using (bucket_id <> 'records' or coalesce((storage.foldername(name))[1], '') not in ('qc', 'collection')
         or ((select public.is_staff()) and (select public.has_module('eooffice'))));

drop policy if exists "storage records: purchase files" on storage.objects;
create policy "storage records: purchase files" on storage.objects as restrictive for select to authenticated
  using (bucket_id <> 'records' or coalesce((storage.foldername(name))[1], '') <> 'purchase' or (select public.is_staff()));

drop policy if exists "storage records: eooffice delete" on storage.objects;
create policy "storage records: eooffice delete" on storage.objects for delete to authenticated
  using (bucket_id = 'records' and coalesce((storage.foldername(name))[1], '') in ('qc', 'collection')
         and (select public.is_staff()) and (select public.has_module('eooffice')));

alter table public.qc_results drop column if exists code_hash;

create or replace function public.set_collection_receipt(p_id uuid, p_path text) returns text
language plpgsql security definer set search_path = '' as $$
declare v public.collection_vouchers;
begin
  if not (public.is_admin() or public.qc_can_write()) then raise exception 'Not allowed'; end if;
  select * into v from public.collection_vouchers where id = p_id for update;
  if not found then raise exception 'Collection voucher not found'; end if;
  if not (public.is_admin() or (v.created_by = auth.uid() and v.created_at > now() - interval '24 hours')) then raise exception 'Only the Director can change this voucher now'; end if;
  if p_path is not null and p_path not like 'collection/' || p_id || '/%' then raise exception 'Wrong file'; end if;
  update public.collection_vouchers set receipt_path = p_path, updated_at = now() where id = p_id;
  return v.receipt_path;
end;
$$;
revoke execute on function public.set_collection_receipt(uuid, text) from public, anon;
grant execute on function public.set_collection_receipt(uuid, text) to authenticated;

create or replace function public.qc_set_docs(p_id uuid, p_docs text[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare old text[];
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  perform 1 from public.qc_results where qc_id = p_id for update;
  if not found then raise exception 'QC form not found'; end if;
  if coalesce(array_length(p_docs, 1), 0) > 6 then raise exception 'Up to 6 pictures'; end if;
  if exists (select 1 from unnest(p_docs) x where x not like 'qc/' || p_id || '/%') then raise exception 'Wrong file'; end if;
  select docs into old from public.qc_results where qc_id = p_id;
  update public.qc_results set docs = coalesce(p_docs, '{}') where qc_id = p_id;
  return jsonb_build_object('ok', true, 'removed', to_jsonb(array(select x from unnest(old) x where x <> all (coalesce(p_docs, '{}')))));
end;
$$;
revoke execute on function public.qc_set_docs(uuid, text[]) from public, anon;
grant execute on function public.qc_set_docs(uuid, text[]) to authenticated;

select 'UPDATE 3.4 READY - EO-Office fixes' as result;

-- ======== 027_ebill_release.sql ========
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.7: Released Notice written on the E-Bill itself (no order letter, no Director Portal)
-- The person with E-Bill access writes the Released Notice on the e-bill: released date, price per box (PHP), exchange rate
-- (BDT for 1 PHP), shipping fee (BDT), shipping bill no. The portal works out
--   price per box x total boxes = PHP, x exchange rate = released charge (BDT), + shipping fee = added to the total cost.
-- The e-bill becomes RELEASED at once; the notice is numbered RN-YYYYMM-###. The Director can undo a notice that has no
-- sales report yet (the e-bill goes back to SHIP).
-- Run once in the Supabase SQL Editor after 026_eo_office_fixes.sql. It is safe to run again.
-- =====================================================================

create or replace function public.release_stock_bill(p_id uuid, p_data jsonb) returns public.stock_bills
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare
  b public.stock_bills; me text := (select full_name from public.profiles where id = auth.uid());
  d date := nullif(p_data ->> 'release_date', '')::date;
  price numeric := nullif(p_data ->> 'price_per_box', '')::numeric;
  rate numeric := nullif(p_data ->> 'exchange_rate', '')::numeric;
  ship numeric := nullif(p_data ->> 'shipping_cost', '')::numeric;
  php numeric; bdt numeric; no text;
begin
  if not public.can_write('inventory') then raise exception 'You do not have access to release e-bills'; end if;
  select * into b from public.stock_bills where id = p_id for update;
  if b.id is null then raise exception 'E-Bill not found'; end if;
  if b.status not in ('shipped', 'arrived') then
    raise exception 'E-Bill % is already at %. Only an e-bill at SHIP can be released', b.bill_no, public.ebill_status_name(b.status);
  end if;
  if coalesce(b.total_boxes, 0) <= 0 then raise exception 'E-Bill % has no total boxes. Correct the e-bill first', b.bill_no; end if;
  if d is null then raise exception 'Enter the released date'; end if;
  if b.shipment_date is not null and d < b.shipment_date then raise exception 'The released date cannot be before the shipment date'; end if;
  if coalesce(price, 0) <= 0 then raise exception 'Enter the price per box (PHP)'; end if;
  if coalesce(rate, 0) <= 0 then raise exception 'Enter the exchange rate (BDT for 1 PHP)'; end if;
  if ship is null or ship < 0 then raise exception 'Enter the shipping fee (0 if there is none)'; end if;
  php := round(price * b.total_boxes, 2);
  bdt := round(php * rate, 2);
  no := 'RN-' || to_char(d, 'YYYYMM') || '-' || lpad(public.next_counter('RN' || to_char(d, 'YYYYMM'))::text, 3, '0');
  perform public.allow_record_change();
  update public.stock_bills set status = 'released', release_date = d, shipping_cost = ship, shipping_bill_no = nullif(left(trim(coalesce(p_data ->> 'shipping_bill_no', '')), 60), ''),
    release_order_no = no, released_at = now(), release_price_per_box = price, release_exchange_rate = rate, release_php = php, release_bdt = bdt
  where id = p_id returning * into b;
  insert into public.stock_bill_events (stock_bill_id, action, note, actor, actor_name)
  values (p_id, 'released by ' || no,
    b.total_boxes || ' boxes [[U+00D7]] PHP ' || to_char(price, 'FM999,999,999,990.00') || ' = PHP ' || to_char(php, 'FM999,999,999,990.00') || ' [[U+00D7]] '
      || rtrim(rtrim(to_char(rate, 'FM999,990.0000'), '0'), '.') || ' = BDT ' || to_char(bdt, 'FM999,999,999,990.00') || ' [[U+00B7]] Shipping fee BDT ' || to_char(ship, 'FM999,999,999,990.00'),
    auth.uid(), me);
  return b;
end;
$$;
revoke execute on function public.release_stock_bill(uuid, jsonb) from public, anon;
grant execute on function public.release_stock_bill(uuid, jsonb) to authenticated;

create or replace function public.unrelease_stock_bill(p_id uuid) returns public.stock_bills
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare b public.stock_bills; me text := (select full_name from public.profiles where id = auth.uid()); old text;
begin
  if not public.is_admin() then raise exception 'Only the Director can undo a Released Notice'; end if;
  select * into b from public.stock_bills where id = p_id for update;
  if b.id is null then raise exception 'E-Bill not found'; end if;
  if b.status <> 'released' then raise exception 'E-Bill % is at %: a Released Notice can be undone only while it is RELEASED', b.bill_no, public.ebill_status_name(b.status); end if;
  if exists (select 1 from public.stock_bill_entries x where x.stock_bill_id = p_id and x.entry_type = 'sales') then
    raise exception 'E-Bill % has a sales report. Delete it first, then undo the Released Notice', b.bill_no;
  end if;
  old := b.release_order_no;
  perform public.allow_record_change();
  update public.stock_bills set status = 'shipped', release_date = null, shipping_cost = null, shipping_bill_no = null, release_order_no = null, released_at = null,
    release_price_per_box = null, release_exchange_rate = null, release_php = null, release_bdt = null where id = p_id returning * into b;
  insert into public.stock_bill_events (stock_bill_id, action, note, actor, actor_name) values (p_id, 'released notice undone', old, auth.uid(), me);
  return b;
end;
$$;
revoke execute on function public.unrelease_stock_bill(uuid) from public, anon;
grant execute on function public.unrelease_stock_bill(uuid) to authenticated;

select 'UPDATE 3.7 READY - E-Bill Released Notice' as result;
$sql$;
begin
  s := replace(s, chr(13), '');  -- Windows line breaks
  s := replace(s, '[[U+00B7]]', chr(183));
  s := replace(s, '[[U+00D7]]', chr(215));
  s := replace(s, '[[U+2013]]', chr(8211));
  s := replace(s, '[[U+2014]]', chr(8212));
  s := replace(s, '[[U+2026]]', chr(8230));
  s := replace(s, '[[U+2192]]', chr(8594));
  s := replace(s, '[[U+2212]]', chr(8722));
  execute s;
end
$run$;

-- ---------- the result ----------
select case when to_regclass('public.customers') is not null
             and to_regclass('public.contact_messages') is not null
             and to_regclass('public.main_director') is not null
             and to_regprocedure('public.statement_amounts(uuid,date)') is not null
             and to_regprocedure('public.director_edit_customer(uuid,jsonb)') is not null
             and exists (select 1 from storage.buckets where id = 'records')
             and exists (select 1 from pg_trigger where tgname = 'statements_follow')
        then 'E-PORTAL SERVER READY - ' || (select count(*) from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE')
             || ' tables, ' || (select count(*) from pg_proc where pronamespace = 'public'::regnamespace) || ' functions. Next: sign up on the E-Portal.'
        else 'NOT COMPLETE: tell Claude' end as result;
