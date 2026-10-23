-- =====================================================================
-- EMON OVERRUNS E-PORTAL - updates 3.23 to 3.28 in one paste
--   033_employee_photo.sql      : employee photo, Emon Hasan's Employee No EO-20260601, link a login account to an employee
--   034_employee_details.sql    : all the job application details on the employee
--   035_employee_approval.sql   : a new employee waits for the Director's approval (the ID card is made then)
--   036_employee_corrections.sql: Request for Update offers every employee detail
--   037_edit_employee.sql       : Edit Employee; the job application details are copied to the employee
--   038_card_password.sql       : Sign In with ID Card = scan the card + the account password (no PIN)
-- Paste all of it in the Supabase SQL Editor and press Run. It is safe to run again (also if some of these were run before).
-- The result at the end must say: UPDATE 3.28 READY - ID card sign-in with the password
-- =====================================================================

-- these updates need the employee ID cards of update 3.21 (032_employee_id.sql)
do $$
begin
  if to_regclass('public.employee_cards') is null then
    raise exception 'Run RUN_031_TO_032.sql first (update 3.21: employee ID cards), then run this again.';
  end if;
end $$;

-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.23
--  1. The Director adds or changes an employee's photo on the employee page (it is also the photo on the ID card).
--  2. Sign In with ID Card: after the card is read, the employee types the E-PORTAL PASSWORD of the account linked
--     to the employee profile (no separate PIN, no Edge Function).
--  3. The Director can link any login account to an employee, also a Director account (it keeps Director access).
--  4. Emon Hasan's Employee No becomes EO-20260601.
-- Safe to run again.
-- =====================================================================

-- 1. employee photo
create or replace function public.set_employee_photo(p_id uuid, p_path text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Only the Director can change the employee photo'; end if;
  if coalesce(p_path, '') !~ ('^employee/' || p_id::text || '/') then raise exception 'Invalid photo'; end if;
  perform public.allow_record_change();
  update public.employees set photo_path = p_path where id = p_id;
  if not found then raise exception 'Employee not found'; end if;
end;
$$;
revoke execute on function public.set_employee_photo(uuid, text) from public, anon;
grant execute on function public.set_employee_photo(uuid, text) to authenticated;

-- 2. the sign-in page reads the card and then asks for the password of the linked account
create or replace function public.card_state(p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare m text[]; c public.employee_cards; sec text; e public.employees; pr public.profiles; nm text;
begin
  m := regexp_match(upper(trim(coalesce(p_code, ''))), '^EMONID\|(EOID-[0-9]{4}-[0-9]{4,})\|([0-9A-F]{40})$');
  if m is null then return jsonb_build_object('state', 'invalid'); end if;
  select * into c from public.employee_cards where card_no = m[1];
  select k.secret into sec from private.employee_card_keys k where k.card_id = c.id;
  if c.id is null or sec is distinct from m[2] then return jsonb_build_object('state', 'invalid'); end if;
  select * into e from public.employees where id = c.employee_id;
  nm := upper(trim(e.first_name || ' ' || e.last_name));
  if c.status = 'replaced' then return jsonb_build_object('state', 'replaced', 'name', nm); end if;
  if c.status <> 'active' then return jsonb_build_object('state', 'ended', 'name', nm); end if;
  if c.valid_until < current_date then return jsonb_build_object('state', 'expired', 'name', nm, 'valid_until', c.valid_until); end if;
  if e.profile_id is null then
    return jsonb_build_object('state', 'no_account', 'name', nm, 'email_hint', regexp_replace(lower(e.email), '^(.)[^@]*', '\1•••'));
  end if;
  select * into pr from public.profiles where id = e.profile_id;
  if e.status <> 'active' or pr.id is null or pr.status <> 'active' then return jsonb_build_object('state', 'blocked', 'name', nm); end if;
  return jsonb_build_object('state', 'password', 'name', nm, 'email', lower(pr.email));
end;
$$;
revoke execute on function public.card_state(text) from public;
grant execute on function public.card_state(text) to anon, authenticated;

-- 3. link a login account to an employee (once). A Director account stays a Director.
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
  if exists (select 1 from public.employees e where e.profile_id = p_profile) then raise exception 'That login account is already linked to another employee'; end if;
  perform public.allow_record_change();
  -- the employee's access is copied onto the login account: a Director account keeps Director access
  update public.employees set profile_id = p_profile,
      role = case when pr.role = 'admin' then 'admin' else role end,
      modules = case when pr.role = 'admin' then coalesce(pr.modules, modules) else modules end,
      status = case when status = 'waiting' then 'active' else status end
    where id = p_employee;
end;
$$;
revoke execute on function public.link_employee_account(uuid, uuid) from public, anon;
grant execute on function public.link_employee_account(uuid, uuid) to authenticated;

-- 4. Emon Hasan: Employee No EO-20260601
do $$
declare e uuid; other text;
begin
  select id into e from public.employees
   where upper(regexp_replace(first_name || ' ' || last_name, '\s+', ' ', 'g')) like '%EMON%HASAN%'
   order by created_at limit 1;
  if e is null then raise notice 'Emon Hasan is not in Employees yet: add him first, then run this again.'; return; end if;
  select first_name || ' ' || last_name into other from public.employees where employee_no = 'EO-20260601' and id <> e;
  if other is not null then raise exception 'EO-20260601 is already used by %', other; end if;
  perform set_config('eo.allow_change', 'on', true);
  update public.employees set employee_no = 'EO-20260601' where id = e and employee_no is distinct from 'EO-20260601';
end $$;

select 'UPDATE 3.23 READY - Employee photo, card sign-in with the password, Emon Hasan '
  || coalesce((select employee_no from public.employees where upper(first_name || ' ' || last_name) like '%EMON%HASAN%' order by created_at limit 1), '(not in Employees yet)') as result;

-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.24: all the job application details on the employee
-- The Director fills the paper job application with the new employee, then types everything into New Employee:
-- permanent address, father's / mother's / spouse's name, date and place of birth, BRC / NID / passport no,
-- gender, religion, blood group, duty hours, education and work experience.
-- Safe to run again.
-- =====================================================================
alter table public.employees add column if not exists permanent_address text;
alter table public.employees add column if not exists father_name text;
alter table public.employees add column if not exists mother_name text;
alter table public.employees add column if not exists spouse_name text;
alter table public.employees add column if not exists date_of_birth date;
alter table public.employees add column if not exists birth_place text;
alter table public.employees add column if not exists id_number text;
alter table public.employees add column if not exists gender text;
alter table public.employees add column if not exists religion text;
alter table public.employees add column if not exists blood_group text;
alter table public.employees add column if not exists duty_hours text;
alter table public.employees add column if not exists education jsonb not null default '[]'::jsonb;
alter table public.employees add column if not exists experience jsonb not null default '[]'::jsonb;

select 'UPDATE 3.24 READY - Employee details' as result;

-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.25: a new employee is approved by the Director
--  1. New Employee saves the details and the portal access as WAITING FOR APPROVAL.
--  2. The Director checks them and presses Approve Employee: the employee ID card is made at that moment and the
--     login opens with the access chosen (before that, a sign-in shows "Waiting for approval").
--  3. Sign In with ID Card: scan the card, type the 4-digit PIN, Sign In (the card-login Edge Function checks the PIN).
-- Employees already in the portal stay approved. Safe to run again.
-- =====================================================================
alter table public.employees add column if not exists approval_status text not null default 'approved';
alter table public.employees drop constraint if exists employees_approval_status_check;
alter table public.employees add constraint employees_approval_status_check check (approval_status in ('pending','approved'));
alter table public.employees add column if not exists approved_at timestamptz;
alter table public.employees add column if not exists approved_by uuid references public.profiles(id) on delete set null;
alter table public.employees add column if not exists approved_by_name text;

-- the login follows the employee; a new employee waiting for approval cannot open the portal yet
create or replace function public.employees_sync_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.profile_id is not null then
    update public.profiles set
      role = new.role,
      modules = new.modules,
      full_name = case when lower(email) = 'emonoverruns@gmail.com' then 'EMON OVERRUNS' else trim(new.first_name || ' ' || new.last_name) end,
      status = case when new.approval_status = 'pending' and role <> 'admin' then 'pending'
                    when new.status in ('inactive','suspended','terminated') then 'disabled' else 'active' end
    where id = new.profile_id;
  end if;
  return new;
end;
$$;

-- the ID card is made when the employee is approved (not while waiting); termination ends it; re-hire makes a new one
create or replace function public.employees_card_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'terminated' and new.approval_status = 'approved' then perform private.issue_card(new.id, private.card_issuer()); end if;
  elsif new.approval_status = 'approved' and old.approval_status = 'pending' then
    if new.status <> 'terminated' and not exists (select 1 from public.employee_cards c where c.employee_id = new.id and c.status = 'active') then
      perform private.issue_card(new.id, coalesce(new.approved_by, private.card_issuer()));
    end if;
  elsif new.status is distinct from old.status then
    if new.status = 'terminated' then
      update public.employee_cards set status = 'revoked', ended_at = now() where employee_id = new.id and status = 'active';
    elsif old.status = 'terminated' and new.approval_status = 'approved' and not exists (select 1 from public.employee_cards c where c.employee_id = new.id and c.status = 'active') then
      perform private.issue_card(new.id, private.card_issuer());
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function public.employees_card_sync() from public, anon, authenticated;
drop trigger if exists employees_card on public.employees;
create trigger employees_card after insert or update of status, approval_status on public.employees for each row execute function public.employees_card_sync();

-- the Director approves a new employee
create or replace function public.approve_employee(p_id uuid) returns public.employees
language plpgsql security definer set search_path = '' as $$
declare e public.employees; me public.profiles;
begin
  if not public.is_admin() then raise exception 'Only the Director approves an employee'; end if;
  select * into e from public.employees where id = p_id for update;
  if e.id is null then raise exception 'Employee not found'; end if;
  if e.approval_status = 'approved' then raise exception 'Employee % is already approved', e.employee_no; end if;
  if e.status = 'terminated' then raise exception 'Employee % is TERMINATED', e.employee_no; end if;
  select * into me from public.profiles where id = auth.uid();
  perform public.allow_record_change();
  update public.employees set approval_status = 'approved', approved_at = now(), approved_by = me.id, approved_by_name = me.full_name
    where id = p_id returning * into e;
  return e;
end;
$$;
revoke execute on function public.approve_employee(uuid) from public, anon;
grant execute on function public.approve_employee(uuid) to authenticated;

-- 3.25: Sign In with ID Card is scan + PIN again (as in 3.21): the sign-in page reads a scanned card first and says what is needed: an account linked to the employee profile
-- (Create Account), the PIN (the account password once, then the PIN is chosen), or just the PIN
create or replace function public.card_state(p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare m text[]; c public.employee_cards; sec text; e public.employees; pr public.profiles; p private.employee_pins; nm text;
begin
  m := regexp_match(upper(trim(coalesce(p_code, ''))), '^EMONID\|(EOID-[0-9]{4}-[0-9]{4,})\|([0-9A-F]{40})$');
  if m is null then return jsonb_build_object('state', 'invalid'); end if;
  select * into c from public.employee_cards where card_no = m[1];
  select k.secret into sec from private.employee_card_keys k where k.card_id = c.id;
  if c.id is null or sec is distinct from m[2] then return jsonb_build_object('state', 'invalid'); end if;
  select * into e from public.employees where id = c.employee_id;
  nm := upper(trim(e.first_name || ' ' || e.last_name));
  if c.status = 'replaced' then return jsonb_build_object('state', 'replaced', 'name', nm); end if;
  if c.status <> 'active' then return jsonb_build_object('state', 'ended', 'name', nm); end if;
  if c.valid_until < current_date then return jsonb_build_object('state', 'expired', 'name', nm, 'valid_until', c.valid_until); end if;
  if e.profile_id is null then
    return jsonb_build_object('state', 'no_account', 'name', nm, 'email_hint', regexp_replace(lower(e.email), '^(.)[^@]*', '\1•••'));
  end if;
  select * into pr from public.profiles where id = e.profile_id;
  if e.status <> 'active' or pr.id is null or pr.status <> 'active' then return jsonb_build_object('state', 'blocked', 'name', nm); end if;
  select * into p from private.employee_pins where employee_id = e.id;
  if p.employee_id is null then return jsonb_build_object('state', 'no_pin', 'name', nm, 'email', lower(pr.email)); end if;
  if p.locked_until > now() then return jsonb_build_object('state', 'locked', 'name', nm, 'until', to_char(p.locked_until, 'FMHH12:MI AM')); end if;
  return jsonb_build_object('state', 'ready', 'name', nm);
end;
$$;
revoke execute on function public.card_state(text) from public;
grant execute on function public.card_state(text) to anon, authenticated;

select 'UPDATE 3.25 READY - Employee approval' as result;

-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.26: Request for Update on an employee offers every detail
-- (present and permanent address, duty hours, parents, spouse, date and place of birth, BRC / NID / passport no,
-- gender, religion, blood group, emergency contact, ...). After the Director approves, the employee shows the new data.
-- Needs 034_employee_details.sql first. Safe to run again.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.editable_columns(p_table text)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case p_table
    when 'customers' then array['first_name','last_name','phone','email','address','business_name','business_start_date','facebook_name','facebook_link','has_extra_facebook','extra_facebook_name','facebook_verified','credit_limit']
    when 'customer_invoices' then array['invoice_date','total_amount','purchase_date','po_number','total_boxes','total_pcs','payment_terms']
    when 'payments_received' then array['method','bank_name','bank_account','reference_no','notes']
    when 'credit_memos' then array['payment_ref','po_number','article','brand','style','batch_no','serial_no','purchase_date','defect_category','defect_detail','assigned_by','inspection_notes','factory_status']
    when 'employees' then array['first_name','last_name','position','phone','address','permanent_address','date_hired','monthly_salary','duty_hours','father_name','mother_name','spouse_name','date_of_birth','birth_place','id_number','gender','religion','blood_group','emergency_name','emergency_relation','emergency_phone','emergency_address']
    when 'payslips' then array['method','reference_no','notes']
    when 'projects' then array['title','description','location','start_date','end_date']
    when 'project_payments' then array['received_by','method','reference_no','notes']
    when 'pay_companies' then array['name','contact_person','contact','address','country','currency','notes']
    when 'pay_accounts' then array['account_name','account_number','bank_name','branch_name','notes']
    when 'pay_vouchers' then array['method','reference_no','notes']
    when 'job_applications' then array['full_name','phone','email','present_address','permanent_address','father_name','mother_name','spouse_name','date_of_birth','birth_place','id_number','gender','religion','blood_group','apply_salary','apply_duty_hours','apply_joining_date','emergency_name','emergency_relation','emergency_phone','emergency_address']
    when 'stock_bills' then array['supplier_bill_no','batch_no','shipment_no','shipment_date','total_boxes','notes','shipping_company','shipping_company_code']
    else null end;
$function$;

select 'UPDATE 3.26 READY - Employee corrections' as result;

-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.27: Edit Employee
-- The Director edits every detail of an employee in one form (also education and work experience), and the change
-- is saved at once. The email can change only while no login account is linked; the photo is changed with Change
-- Photo and the access on Access & Status. Needs 034_employee_details.sql first. Safe to run again.
-- Also: an employee who came from an approved job application gets the details of that application (permanent
-- address, parents, spouse, birth date and place, BRC / NID / passport no, gender, religion, blood group, duty hours,
-- education, work experience, emergency contact, photo) where the employee profile has none yet, and from now on the
-- Director's approval of a job application copies all of these to the employee.
-- =====================================================================
create or replace function public.director_edit_employee(p_id uuid, p_changes jsonb) returns public.employees
language plpgsql security definer set search_path = '' as $$
declare
  allowed constant text[] := array['first_name','last_name','position','email','phone','address','permanent_address','date_hired','monthly_salary','duty_hours',
    'father_name','mother_name','spouse_name','date_of_birth','birth_place','id_number','gender','religion','blood_group',
    'emergency_name','emergency_relation','emergency_phone','emergency_address','education','experience'];
  e public.employees; k text; sets text;
begin
  if not public.is_admin() then raise exception 'Only the Director edits an employee'; end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then raise exception 'Nothing to save'; end if;
  select * into e from public.employees where id = p_id for update;
  if e.id is null then raise exception 'Employee not found'; end if;
  for k in select jsonb_object_keys(p_changes) loop
    if not (k = any(allowed)) then raise exception 'The detail "%" cannot be edited here', k; end if;
  end loop;
  if p_changes ? 'email' and e.profile_id is not null and lower(coalesce(p_changes->>'email', '')) <> lower(e.email) then
    raise exception 'The email is the login of the linked account and cannot be changed';
  end if;
  if coalesce(trim(p_changes->>'first_name'), 'x') = '' or coalesce(trim(p_changes->>'last_name'), 'x') = '' then raise exception 'Enter the first and last name'; end if;
  select string_agg(format('%I = r.%I', x, x), ', ') into sets from jsonb_object_keys(p_changes) x;
  perform public.allow_record_change();
  execute format('update public.employees t set %s from jsonb_populate_record(null::public.employees, $1) r where t.id = $2', sets) using p_changes, p_id;
  select * into e from public.employees where id = p_id;
  return e;
end;
$$;
revoke execute on function public.director_edit_employee(uuid, jsonb) from public, anon;
grant execute on function public.director_edit_employee(uuid, jsonb) to authenticated;

-- the Director's approval of a job application copies all its details to the employee (also the ones added in 3.24)
CREATE OR REPLACE FUNCTION public.review_job_application(p_id uuid, p_action text, p_role text DEFAULT 'staff'::text, p_modules text[] DEFAULT '{}'::text[], p_note text DEFAULT NULL::text)
 RETURNS job_applications
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET "TimeZone" TO 'Asia/Manila'
AS $function$
declare
  a public.job_applications;
  me text;
  login_email text;
  emp_id uuid;
  fname text; lname text;
begin
  if not public.is_admin() then raise exception 'Only the Director can review job applications'; end if;
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
  if login_email is null then raise exception 'This application has no email address, so a login cannot be linked'; end if;
  fname := trim(regexp_replace(a.full_name, '\s+\S+\s*$', ''));
  lname := trim(substring(a.full_name from '(\S+)\s*$'));
  if fname = '' then fname := a.full_name; lname := ''; end if;
  select id into emp_id from public.employees where lower(email) = login_email;
  if emp_id is null then
    insert into public.employees (first_name, last_name, position, email, phone, address, date_hired, photo_path, role, modules, monthly_salary, job_application_id,
                                  emergency_name, emergency_relation, emergency_phone, emergency_address,
                                  permanent_address, father_name, mother_name, spouse_name, date_of_birth, birth_place, id_number, gender, religion, blood_group,
                                  duty_hours, education, experience)
    values (fname, lname, a.position_title, login_email, a.phone, a.present_address, coalesce(a.apply_joining_date, current_date),
            a.photo_path, p_role, coalesce(p_modules, '{}'), coalesce(a.apply_salary, 0), a.id,
            a.emergency_name, a.emergency_relation, a.emergency_phone, a.emergency_address,
            a.permanent_address, a.father_name, a.mother_name, a.spouse_name, a.date_of_birth, a.birth_place, a.id_number, a.gender, a.religion, a.blood_group,
            a.apply_duty_hours, coalesce(a.education, '[]'::jsonb), coalesce(a.experience, '[]'::jsonb))
    returning id into emp_id;
  else
    update public.employees set first_name = fname, last_name = lname, position = a.position_title, phone = a.phone, address = a.present_address,
      date_hired = coalesce(a.apply_joining_date, current_date), photo_path = coalesce(a.photo_path, photo_path), role = p_role,
      modules = coalesce(p_modules, '{}'), monthly_salary = coalesce(a.apply_salary, monthly_salary), job_application_id = a.id,
      termination_date = null, termination_reason = null,
      emergency_name = coalesce(a.emergency_name, emergency_name), emergency_relation = coalesce(a.emergency_relation, emergency_relation),
      emergency_phone = coalesce(a.emergency_phone, emergency_phone), emergency_address = coalesce(a.emergency_address, emergency_address),
      permanent_address = coalesce(a.permanent_address, permanent_address), father_name = coalesce(a.father_name, father_name),
      mother_name = coalesce(a.mother_name, mother_name), spouse_name = coalesce(a.spouse_name, spouse_name),
      date_of_birth = coalesce(a.date_of_birth, date_of_birth), birth_place = coalesce(a.birth_place, birth_place),
      id_number = coalesce(a.id_number, id_number), gender = coalesce(a.gender, gender), religion = coalesce(a.religion, religion),
      blood_group = coalesce(a.blood_group, blood_group), duty_hours = coalesce(a.apply_duty_hours, duty_hours),
      education = case when jsonb_typeof(a.education) <> 'array' then education when jsonb_array_length(a.education) > 0 then a.education else education end,
      experience = case when jsonb_typeof(a.experience) <> 'array' then experience when jsonb_array_length(a.experience) > 0 then a.experience else experience end,
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
$function$;

-- employees from a job application: fill the details the employee profile does not have yet
-- (one application per employee: the one the employee points to, else the newest)
do $$
begin
  perform public.allow_record_change();
  update public.employees e set
    photo_path = coalesce(nullif(trim(e.photo_path), ''), a.photo_path),
    permanent_address = coalesce(nullif(trim(e.permanent_address), ''), a.permanent_address),
    father_name = coalesce(nullif(trim(e.father_name), ''), a.father_name),
    mother_name = coalesce(nullif(trim(e.mother_name), ''), a.mother_name),
    spouse_name = coalesce(nullif(trim(e.spouse_name), ''), a.spouse_name),
    date_of_birth = coalesce(e.date_of_birth, a.date_of_birth),
    birth_place = coalesce(nullif(trim(e.birth_place), ''), a.birth_place),
    id_number = coalesce(nullif(trim(e.id_number), ''), a.id_number),
    gender = coalesce(nullif(trim(e.gender), ''), a.gender),
    religion = coalesce(nullif(trim(e.religion), ''), a.religion),
    blood_group = coalesce(nullif(trim(e.blood_group), ''), a.blood_group),
    duty_hours = coalesce(nullif(trim(e.duty_hours), ''), a.apply_duty_hours),
    education = case when jsonb_typeof(e.education) <> 'array' then coalesce(a.education, '[]'::jsonb) when jsonb_array_length(e.education) > 0 then e.education else coalesce(a.education, '[]'::jsonb) end,
    experience = case when jsonb_typeof(e.experience) <> 'array' then coalesce(a.experience, '[]'::jsonb) when jsonb_array_length(e.experience) > 0 then e.experience else coalesce(a.experience, '[]'::jsonb) end,
    emergency_name = coalesce(nullif(trim(e.emergency_name), ''), a.emergency_name),
    emergency_relation = coalesce(nullif(trim(e.emergency_relation), ''), a.emergency_relation),
    emergency_phone = coalesce(nullif(trim(e.emergency_phone), ''), a.emergency_phone),
    emergency_address = coalesce(nullif(trim(e.emergency_address), ''), a.emergency_address)
  from (select distinct on (x.id) x.id as emp, j.*
          from public.employees x join public.job_applications j on j.id = x.job_application_id or j.employee_id = x.id
         order by x.id, (j.id is not distinct from x.job_application_id) desc, j.created_at desc) a
  where a.emp = e.id;
end $$;

select 'UPDATE 3.27 READY - Edit Employee' as result;

-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.28: Sign In with ID Card = scan the card + the account password (no PIN)
-- The sign-in page reads a scanned card and says what is needed: an account linked to the employee profile
-- (Create Account, or the Director links one), else the password of that account. The 4-digit PIN is no longer used
-- (and the card-login Edge Function is not needed any more). Needs 032_employee_id.sql first. Safe to run again.
-- =====================================================================
create or replace function public.card_state(p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare m text[]; c public.employee_cards; sec text; e public.employees; pr public.profiles; nm text;
begin
  m := regexp_match(upper(trim(coalesce(p_code, ''))), '^EMONID\|(EOID-[0-9]{4}-[0-9]{4,})\|([0-9A-F]{40})$');
  if m is null then return jsonb_build_object('state', 'invalid'); end if;
  select * into c from public.employee_cards where card_no = m[1];
  select k.secret into sec from private.employee_card_keys k where k.card_id = c.id;
  if c.id is null or sec is distinct from m[2] then return jsonb_build_object('state', 'invalid'); end if;
  select * into e from public.employees where id = c.employee_id;
  nm := upper(trim(e.first_name || ' ' || e.last_name));
  if c.status = 'replaced' then return jsonb_build_object('state', 'replaced', 'name', nm); end if;
  if c.status <> 'active' then return jsonb_build_object('state', 'ended', 'name', nm); end if;
  if c.valid_until < current_date then return jsonb_build_object('state', 'expired', 'name', nm, 'valid_until', c.valid_until); end if;
  if e.profile_id is null then
    return jsonb_build_object('state', 'no_account', 'name', nm, 'email_hint', regexp_replace(lower(e.email), '^(.)[^@]*', '\1•••'));
  end if;
  select * into pr from public.profiles where id = e.profile_id;
  if e.status <> 'active' or pr.id is null or pr.status <> 'active' then return jsonb_build_object('state', 'blocked', 'name', nm); end if;
  return jsonb_build_object('state', 'password', 'name', nm, 'email', lower(pr.email));
end;
$$;
revoke execute on function public.card_state(text) from public;
grant execute on function public.card_state(text) to anon, authenticated;

select 'UPDATE 3.28 READY - ID card sign-in with the password' as result;
