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
