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
