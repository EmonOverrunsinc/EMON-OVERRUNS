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
