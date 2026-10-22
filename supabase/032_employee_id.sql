-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.21: Employee ID Card
-- * Emergency contact on the employee and on the job application (copied to the employee when the Director approves).
-- * Every approved employee gets an ID card by itself: card no EOID-YYYY-####, valid for 1 year, issued by the Director
--   who approved or added the employee. A new card replaces the old one; termination ends the card; re-hire issues a new one.
-- * The back of the card carries a QR with a private card code. The employee signs in by scanning the card and typing a
--   4-digit PIN (set once in My Profile). 5 wrong PINs lock the PIN for 15 minutes; the Director can reset a PIN.
-- * Only the Director prints the card. The private code and the PIN are kept in the private schema (not readable through the API).
-- Run once in the Supabase SQL Editor after 031_settle_by.sql. It is safe to run again.
-- =====================================================================

-- 1. emergency contact
alter table public.employees add column if not exists emergency_name text, add column if not exists emergency_relation text,
  add column if not exists emergency_phone text, add column if not exists emergency_address text;
alter table public.job_applications add column if not exists emergency_name text, add column if not exists emergency_relation text,
  add column if not exists emergency_phone text, add column if not exists emergency_address text;

-- corrections may change the emergency contact
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
    when 'employees' then array['first_name','last_name','position','phone','address','date_hired','monthly_salary','emergency_name','emergency_relation','emergency_phone','emergency_address']
    when 'payslips' then array['method','reference_no','notes']
    when 'projects' then array['title','description','location','start_date','end_date']
    when 'project_payments' then array['received_by','method','reference_no','notes']
    when 'pay_companies' then array['name','contact_person','contact','address','country','currency','notes']
    when 'pay_accounts' then array['account_name','account_number','bank_name','branch_name','notes']
    when 'pay_vouchers' then array['purpose','method','reference_no','notes']
    when 'job_applications' then array['full_name','phone','email','present_address','permanent_address','father_name','mother_name','spouse_name','date_of_birth','birth_place','id_number','gender','religion','blood_group','apply_salary','apply_duty_hours','apply_joining_date','emergency_name','emergency_relation','emergency_phone','emergency_address']
    when 'stock_bills' then array['supplier_bill_no','batch_no','shipment_no','shipment_date','total_boxes','notes','shipping_company','shipping_company_code']
    else null end;
$function$;

-- the Director's approval of a job application copies the emergency contact to the employee
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
                                  emergency_name, emergency_relation, emergency_phone, emergency_address)
    values (fname, lname, a.position_title, login_email, a.phone, a.present_address, coalesce(a.apply_joining_date, current_date),
            a.photo_path, p_role, coalesce(p_modules, '{}'), coalesce(a.apply_salary, 0), a.id,
            a.emergency_name, a.emergency_relation, a.emergency_phone, a.emergency_address)
    returning id into emp_id;
  else
    update public.employees set first_name = fname, last_name = lname, position = a.position_title, phone = a.phone, address = a.present_address,
      date_hired = coalesce(a.apply_joining_date, current_date), photo_path = coalesce(a.photo_path, photo_path), role = p_role,
      modules = coalesce(p_modules, '{}'), monthly_salary = coalesce(a.apply_salary, monthly_salary), job_application_id = a.id,
      termination_date = null, termination_reason = null,
      emergency_name = coalesce(a.emergency_name, emergency_name), emergency_relation = coalesce(a.emergency_relation, emergency_relation),
      emergency_phone = coalesce(a.emergency_phone, emergency_phone), emergency_address = coalesce(a.emergency_address, emergency_address),
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

-- 2. the ID cards
create table if not exists public.employee_cards (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  card_no text not null unique,
  issued_at timestamptz not null default now(),
  valid_until date not null,
  issued_by uuid references public.profiles(id) on delete set null,
  issued_by_name text,
  status text not null default 'active' check (status in ('active', 'replaced', 'revoked')),
  ended_at timestamptz,
  print_count int not null default 0,
  last_printed_at timestamptz,
  last_login_at timestamptz
);
create unique index if not exists employee_cards_one_active on public.employee_cards (employee_id) where status = 'active';
create index if not exists employee_cards_employee on public.employee_cards (employee_id);
alter table public.employee_cards enable row level security;
revoke all on public.employee_cards from anon, authenticated;
grant select on public.employee_cards to authenticated;
drop policy if exists "ecards: director" on public.employee_cards;
create policy "ecards: director" on public.employee_cards for select to authenticated using ((select public.is_admin()));
drop policy if exists "ecards: own" on public.employee_cards;
create policy "ecards: own" on public.employee_cards for select to authenticated
  using (exists (select 1 from public.employees e where e.id = employee_id and e.profile_id = (select auth.uid())));

-- the private part (never readable through the API): the card code and the employee's PIN
create schema if not exists private;
create table if not exists private.employee_card_keys (
  card_id uuid primary key references public.employee_cards(id) on delete cascade,
  secret text not null
);
create table if not exists private.employee_pins (
  employee_id uuid primary key references public.employees(id) on delete cascade,
  pin_hash text not null,
  set_at timestamptz not null default now(),
  failed int not null default 0,
  locked_until timestamptz
);
revoke all on private.employee_card_keys, private.employee_pins from public;
insert into private.app_secrets (k, v)
  select 'card_pin_key', md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text)
  where not exists (select 1 from private.app_secrets where k = 'card_pin_key');

create or replace function private.pin_hash(p_employee uuid, p_pin text) returns text
language sql stable security definer set search_path = '' as $$
  select encode(sha256(convert_to(p_employee::text || '|' || coalesce(p_pin, '') || '|' || k.v, 'UTF8')), 'hex')
  from private.app_secrets k where k.k = 'card_pin_key';
$$;
revoke execute on function private.pin_hash(uuid, text) from public;

-- a new card for the employee (the card before it is replaced); p_by: the Director who issues it
create or replace function private.issue_card(p_employee uuid, p_by uuid) returns public.employee_cards
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare c public.employee_cards; yr text := to_char(current_date, 'YYYY');
begin
  update public.employee_cards set status = 'replaced', ended_at = now() where employee_id = p_employee and status = 'active';
  insert into public.employee_cards (employee_id, card_no, valid_until, issued_by, issued_by_name)
  values (p_employee, 'EOID-' || yr || '-' || lpad(public.next_counter('EOID' || yr)::text, 4, '0'), (current_date + interval '1 year')::date,
          p_by, (select full_name from public.profiles where id = p_by))
  returning * into c;
  insert into private.employee_card_keys (card_id, secret)
  values (c.id, upper(left(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 40)));
  return c;
end;
$$;
revoke execute on function private.issue_card(uuid, uuid) from public;

-- who issues a card made by itself: the Director signed in, else the main Director, else the first Director
create or replace function private.card_issuer() returns uuid
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.id from public.profiles p where p.id = auth.uid() and p.role = 'admin'),
                  (select p.id from public.profiles p where lower(p.email) = 'emonoverruns@gmail.com' limit 1),
                  (select p.id from public.profiles p where p.role = 'admin' and p.status = 'active' order by p.created_at limit 1));
$$;
revoke execute on function private.card_issuer() from public;

-- an employee added or approved gets a card; termination ends it; re-hire issues a new one
create or replace function public.employees_card_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'terminated' then perform private.issue_card(new.id, private.card_issuer()); end if;
  elsif new.status is distinct from old.status then
    if new.status = 'terminated' then
      update public.employee_cards set status = 'revoked', ended_at = now() where employee_id = new.id and status = 'active';
    elsif old.status = 'terminated' and not exists (select 1 from public.employee_cards c where c.employee_id = new.id and c.status = 'active') then
      perform private.issue_card(new.id, private.card_issuer());
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function public.employees_card_sync() from public, anon, authenticated;
drop trigger if exists employees_card on public.employees;
create trigger employees_card after insert or update of status on public.employees for each row execute function public.employees_card_sync();

-- employees already in the portal get their first card now
do $$
declare e record;
begin
  for e in select x.id from public.employees x
           where x.status <> 'terminated' and not exists (select 1 from public.employee_cards c where c.employee_id = x.id) loop
    perform private.issue_card(e.id, private.card_issuer());
  end loop;
end $$;

-- 3. the Director: a new card, the code for the print (counted), the PIN state, reset the PIN
create or replace function public.issue_employee_card(p_employee uuid) returns public.employee_cards
language plpgsql security definer set search_path = '' as $$
declare st text;
begin
  if not public.is_admin() then raise exception 'Only the Director can issue an ID card'; end if;
  select status into st from public.employees where id = p_employee;
  if st is null then raise exception 'Employee not found'; end if;
  if st = 'terminated' then raise exception 'A terminated employee cannot get an ID card'; end if;
  return private.issue_card(p_employee, auth.uid());
end;
$$;
revoke execute on function public.issue_employee_card(uuid) from public, anon;
grant execute on function public.issue_employee_card(uuid) to authenticated;

create or replace function public.employee_card_code(p_card uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare t text;
begin
  if not public.is_admin() then raise exception 'Only the Director can print an ID card'; end if;
  select 'EMONID|' || c.card_no || '|' || k.secret into t
  from public.employee_cards c join private.employee_card_keys k on k.card_id = c.id where c.id = p_card and c.status = 'active';
  if t is null then raise exception 'This ID card is no longer active'; end if;
  update public.employee_cards set print_count = print_count + 1, last_printed_at = now() where id = p_card;
  return t;
end;
$$;
revoke execute on function public.employee_card_code(uuid) from public, anon;
grant execute on function public.employee_card_code(uuid) to authenticated;

create or replace function public.employee_pin_state(p_employee uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Only the Director can see this'; end if;
  return coalesce((select jsonb_build_object('pin_set', true, 'set_at', p.set_at, 'locked_until', case when p.locked_until > now() then p.locked_until end)
                   from private.employee_pins p where p.employee_id = p_employee), jsonb_build_object('pin_set', false));
end;
$$;
revoke execute on function public.employee_pin_state(uuid) from public, anon;
grant execute on function public.employee_pin_state(uuid) to authenticated;

create or replace function public.reset_card_pin(p_employee uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Only the Director can reset a PIN'; end if;
  delete from private.employee_pins where employee_id = p_employee;
  return true;
end;
$$;
revoke execute on function public.reset_card_pin(uuid) from public, anon;
grant execute on function public.reset_card_pin(uuid) to authenticated;

-- 4. the employee: my card, my PIN
create or replace function public.my_id_card() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('card_no', c.card_no, 'valid_until', c.valid_until, 'issued_at', c.issued_at, 'employee_no', e.employee_no,
                            'pin_set', exists (select 1 from private.employee_pins p where p.employee_id = e.id))
  from public.employees e join public.employee_cards c on c.employee_id = e.id and c.status = 'active'
  where e.profile_id = auth.uid() and e.status = 'active'
  limit 1;
$$;
revoke execute on function public.my_id_card() from public, anon;
grant execute on function public.my_id_card() to authenticated;

create or replace function public.set_card_pin(p_pin text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare e uuid;
begin
  select id into e from public.employees where profile_id = auth.uid() and status = 'active';
  if e is null then raise exception 'Only an active employee has an ID card PIN'; end if;
  if coalesce(p_pin, '') !~ '^[0-9]{4}$' then raise exception 'The PIN is 4 numbers'; end if;
  if p_pin ~ '^([0-9])\1{3}$' or p_pin in ('0123', '1234', '2345', '3456', '4567', '5678', '6789', '9876', '8765', '7654', '6543', '5432', '4321', '3210') then
    raise exception 'This PIN is too easy to guess. Choose another one';
  end if;
  insert into private.employee_pins (employee_id, pin_hash, set_at) values (e, private.pin_hash(e, p_pin), now())
  on conflict (employee_id) do update set pin_hash = excluded.pin_hash, set_at = now(), failed = 0, locked_until = null;
  return true;
end;
$$;
revoke execute on function public.set_card_pin(text) from public, anon;
grant execute on function public.set_card_pin(text) to authenticated;

-- 5. sign in with the card: checked by the card-login Edge Function only (service role). Gives back the account email,
-- or the reason the card cannot sign in. A wrong PIN is counted; the 5th locks the PIN for 15 minutes.
create or replace function public.card_login(p_code text, p_pin text) returns jsonb
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare m text[]; c public.employee_cards; sec text; e public.employees; pr public.profiles; p private.employee_pins; left_n int;
begin
  m := regexp_match(upper(trim(coalesce(p_code, ''))), '^EMONID\|(EOID-[0-9]{4}-[0-9]{4,})\|([0-9A-F]{40})$');
  if m is null then return jsonb_build_object('ok', false, 'error', 'This is not an EMON OVERRUNS employee ID card.'); end if;
  select * into c from public.employee_cards where card_no = m[1];
  select k.secret into sec from private.employee_card_keys k where k.card_id = c.id;
  if c.id is null or sec is distinct from m[2] then return jsonb_build_object('ok', false, 'error', 'This ID card is not valid.'); end if;
  if c.status = 'replaced' then return jsonb_build_object('ok', false, 'error', 'This ID card was replaced by a newer card. Use your new ID card.'); end if;
  if c.status <> 'active' then return jsonb_build_object('ok', false, 'error', 'This ID card is no longer valid.'); end if;
  if c.valid_until < current_date then
    return jsonb_build_object('ok', false, 'error', 'This ID card expired on ' || to_char(c.valid_until, 'FMMONTH DD YYYY') || '. Ask the Director for a new card.');
  end if;
  select * into e from public.employees where id = c.employee_id;
  if e.profile_id is null then
    return jsonb_build_object('ok', false, 'error', 'Your portal account is not ready yet. Press Create Account and use ' || e.email || ' first.');
  end if;
  select * into pr from public.profiles where id = e.profile_id;
  if e.status <> 'active' or pr.id is null or pr.status <> 'active' then
    return jsonb_build_object('ok', false, 'error', 'Your login is blocked. Ask the Director.');
  end if;
  select * into p from private.employee_pins where employee_id = e.id for update;
  if p.employee_id is null then
    return jsonb_build_object('ok', false, 'error', 'Set your 4-digit ID card PIN first: sign in with your email and password, then open My Profile.');
  end if;
  if p.locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'Too many wrong PINs. Try again after ' || to_char(p.locked_until, 'FMHH12:MI AM') || ', or ask the Director to reset your PIN.');
  end if;
  if p.pin_hash <> private.pin_hash(e.id, p_pin) then
    update private.employee_pins set
      failed = case when failed + 1 >= 5 then 0 else failed + 1 end,
      locked_until = case when failed + 1 >= 5 then now() + interval '15 minutes' else null end
    where employee_id = e.id;
    left_n := 4 - p.failed;
    if left_n <= 0 then
      return jsonb_build_object('ok', false, 'error', 'Wrong PIN 5 times. The PIN is locked for 15 minutes.');
    end if;
    return jsonb_build_object('ok', false, 'error', 'Wrong PIN. ' || left_n || case when left_n = 1 then ' try' else ' tries' end || ' left.');
  end if;
  update private.employee_pins set failed = 0, locked_until = null where employee_id = e.id;
  update public.employee_cards set last_login_at = now() where id = c.id;
  return jsonb_build_object('ok', true, 'email', lower(pr.email));
end;
$$;
revoke execute on function public.card_login(text, text) from public, anon, authenticated;
grant execute on function public.card_login(text, text) to service_role;

-- 6. anyone may check a scanned card (the code on the card is needed, so card numbers cannot be tried one by one)
create or replace function public.check_employee_card(p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare m text[]; c public.employee_cards; sec text; e public.employees;
begin
  m := regexp_match(upper(trim(coalesce(p_code, ''))), '^EMONID\|(EOID-[0-9]{4}-[0-9]{4,})\|([0-9A-F]{40})$');
  if m is null then return jsonb_build_object('found', false); end if;
  select * into c from public.employee_cards where card_no = m[1];
  select k.secret into sec from private.employee_card_keys k where k.card_id = c.id;
  if c.id is null or sec is distinct from m[2] then return jsonb_build_object('found', false); end if;
  select * into e from public.employees where id = c.employee_id;
  return jsonb_build_object('found', true, 'card_no', c.card_no, 'employee_id', case when public.is_staff() then e.id end,
    'name', upper(trim(e.first_name || ' ' || e.last_name)), 'position', e.position, 'employee_no', e.employee_no,
    'issued_at', c.issued_at, 'valid_until', c.valid_until,
    'state', case when c.status = 'replaced' then 'REPLACED' when c.status <> 'active' or e.status = 'terminated' then 'NOT VALID'
                  when c.valid_until < current_date then 'EXPIRED' else 'VALID' end);
end;
$$;
revoke execute on function public.check_employee_card(text) from public;
grant execute on function public.check_employee_card(text) to anon, authenticated;

-- 7. the sign-in page reads a scanned card first and says what is needed: an account linked to the employee profile
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

select 'UPDATE 3.21 READY - Employee ID Card' as result;
