-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.27: Edit Employee
-- The Director edits every detail of an employee in one form (also education and work experience), and the change
-- is saved at once. The email can change only while no login account is linked; the photo is changed with Change
-- Photo and the access on Access & Status. Needs 034_employee_details.sql first. Safe to run again.
-- Also: an employee who came from an approved job application gets the details of that application (permanent
-- address, parents, spouse, birth date and place, BRC / NID / passport no, gender, religion, blood group, duty hours,
-- education, work experience, emergency contact) where the employee profile has none yet, and from now on the
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
