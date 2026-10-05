-- EMON OVERRUNS E-PORTAL — Update 1.1
-- Usernames & presence, job positions and applications, employee termination and payslips,
-- community (30-day posts), messages, order letters, billing v2 (PHP → BDT vouchers),
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
  perform public.notify_admins('Employee terminated: ' || e.first_name || ' ' || e.last_name, e.employee_no || ' — ' || p_reason, 'employee/' || e.id);
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
  perform public.notify_user(a.profile_id, 'Your job application was approved', a.approval_no || ' — welcome to ' || a.company_name || '. You can now use the portal.', 'dashboard');
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
--  * A request (suspend, close, unpaid notice, installment, …) is carried out as soon as the CEO approves it.
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
    if o.subject_type = 'suspension' and c.status <> 'active' then raise exception 'Account % is % — only ACTIVE accounts can be suspended', c.account_no, upper(c.status); end if;
    if o.subject_type = 'closure' and c.status not in ('active','suspended') then raise exception 'Account % is % and cannot be closed', c.account_no, upper(c.status); end if;
    if o.subject_type = 'reactivation' and c.status <> 'suspended' then raise exception 'Account % is % — only SUSPENDED accounts can be reactivated', c.account_no, upper(c.status); end if;
    if o.subject_type = 'reopen' and c.status <> 'closed' then raise exception 'Account % is % — only CLOSED accounts can be reopened', c.account_no, upper(c.status); end if;
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
-- Billing v2: companies → accounts → payment vouchers (PHP × rate = BDT)
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
--  * Wrong details (a phone number, a reference) → a CORRECTION record is added; it keeps the original values.
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
  perform public.notify_admins('Correction request ' || cr.request_no, coalesce(p_label, p_table) || ' — ' || trim(p_reason), 'changes');
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
          jsonb_build_array('PO Number', coalesce(r.po_number, '—')), jsonb_build_array('Boxes / Pcs', r.total_boxes || ' / ' || r.total_pcs),
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
          jsonb_build_array('Reference', coalesce(r.reference_no, '—')), jsonb_build_array('Invoice', coalesce(r.inv, 'General payment')),
          jsonb_build_array('Verified By', coalesce(r.created_by_name, '—'))));
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
          jsonb_build_array('Account No', r.acct), jsonb_build_array('Period', to_char(r.period_start, 'DD Mon YYYY') || ' – ' || to_char(r.period_end, 'DD Mon YYYY')),
          jsonb_build_array('Opening (PHP)', to_char(r.opening_balance, 'FM999,999,999,990.00')),
          jsonb_build_array('Closing (PHP)', to_char(r.closing_balance, 'FM999,999,999,990.00'))));
    end if;
    select o.*, cu.first_name, cu.last_name, cu.account_no as acct
      into r from public.order_letters o left join public.customers cu on cu.id = o.customer_id where upper(o.order_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Order Letter', 'number', r.order_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Order No', r.order_no), jsonb_build_array('Date', to_char(r.order_date, 'DD Mon YYYY')),
          jsonb_build_array('Account', coalesce(r.first_name || ' ' || r.last_name || ' (' || r.acct || ')', '—')),
          jsonb_build_array('Subject', r.subject), jsonb_build_array('Type', initcap(replace(r.subject_type, '_', ' '))),
          jsonb_build_array('Status', upper(r.status)), jsonb_build_array('Approved By', coalesce(r.approved_by_name, '—'))));
    end if;
    select v.*, pc.name as company, pa.account_name, pa.account_number, pa.bank_name
      into r from public.pay_vouchers v join public.pay_companies pc on pc.id = v.company_id left join public.pay_accounts pa on pa.id = v.account_id
      where upper(v.voucher_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Payment Voucher', 'number', r.voucher_no, 'status', 'paid',
        'fields', jsonb_build_array(
          jsonb_build_array('Voucher No', r.voucher_no), jsonb_build_array('Paid To', r.company),
          jsonb_build_array('Account', coalesce(r.account_name || ' ' || coalesce(r.account_number, '') || ' ' || coalesce(r.bank_name, ''), '—')),
          jsonb_build_array('Date', to_char(r.pay_date, 'DD Mon YYYY')),
          jsonb_build_array('Amount (PHP)', to_char(r.amount_php, 'FM999,999,999,990.00')),
          jsonb_build_array('Exchange Rate', to_char(r.exchange_rate, 'FM999,990.0000')),
          jsonb_build_array('Amount (BDT)', to_char(r.amount_bdt, 'FM999,999,999,990.00')),
          jsonb_build_array('Issued By', coalesce(r.created_by_name, '—'))));
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
          jsonb_build_array('Approval No', coalesce(r.approval_no, '—'))));
    end if;
    select * into r from public.employees e where upper(e.employee_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Employee', 'number', r.employee_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Employee No', r.employee_no), jsonb_build_array('Name', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Position', coalesce(r.position, '—')), jsonb_build_array('Status', upper(r.status))));
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
          jsonb_build_array('Payment No', r.payment_no), jsonb_build_array('Project', r.project_no || ' — ' || r.title),
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
