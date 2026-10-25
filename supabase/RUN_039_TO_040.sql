-- =====================================================================
-- EMON OVERRUNS E-PORTAL - RUN THIS ONE FILE: updates 3.30 and 3.31 together
--   3.30  the first ID card scan makes the password (no email, no code)        (039_card_first_password.sql)
--   3.31  5 Purchase Order is a menu access of its own; Employee (HR) is 6       (040_purchase_access.sql)
-- Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again (also when 039 already ran).
-- The last line says: UPDATE 3.31 READY - 5 Purchase Order is a menu access
-- =====================================================================

-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.30: the first scan of the ID card makes the password (no email, no code)
-- Sign In with ID Card: an employee whose card is good and who has no portal login yet makes a password right after
-- the scan. The login is made at once (no email is sent, nothing to confirm) and is linked to the employee profile.
-- After that the employee scans the card and types the password (3.28). A login that was started with Create Account
-- but never confirmed gets the password the same way. Needs 038_card_password.sql first. Safe to run again.
-- =====================================================================
create extension if not exists pgcrypto with schema extensions;
do $$ begin
  if to_regclass('public.employee_cards') is null then raise exception 'Run RUN_033_TO_038.sql first, then run this again.'; end if;
  if to_regprocedure('extensions.crypt(text,text)') is null then raise exception 'pgcrypto is not in the extensions schema: send this message to Claude.'; end if;
  if not (has_table_privilege('auth.users', 'insert') and has_table_privilege('auth.users', 'update') and has_table_privilege('auth.identities', 'insert')) then
    raise exception 'This database does not let the update make logins (auth.users): send this message to Claude.';
  end if;
end $$;

-- 1. what a scanned card needs: 'set_password' the first time (no confirmed login yet); 'account_exists' when a
--    confirmed login with the employee's email is not linked to the employee profile yet
create or replace function public.card_state(p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare m text[]; c public.employee_cards; sec text; e public.employees; pr public.profiles; nm text; uid uuid; ok timestamptz;
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
  if e.status not in ('active', 'waiting') then return jsonb_build_object('state', 'blocked', 'name', nm); end if;
  if e.profile_id is null then
    select u.email_confirmed_at into ok from auth.users u where lower(u.email) = lower(trim(e.email)) order by u.email_confirmed_at nulls last limit 1;
    if ok is not null then
      return jsonb_build_object('state', 'account_exists', 'name', nm, 'email_hint', regexp_replace(lower(e.email), '^(.)[^@]*', '\1•••'));
    end if;
    return jsonb_build_object('state', 'set_password', 'name', nm);
  end if;
  select * into pr from public.profiles where id = e.profile_id;
  select u.id, u.email_confirmed_at into uid, ok from auth.users u where u.id = e.profile_id;
  if e.status <> 'active' or pr.id is null or pr.status <> 'active' or uid is null then return jsonb_build_object('state', 'blocked', 'name', nm); end if;
  if ok is null then return jsonb_build_object('state', 'set_password', 'name', nm); end if; -- started with Create Account, never confirmed
  return jsonb_build_object('state', 'password', 'name', nm, 'email', lower(pr.email));
end;
$$;
revoke execute on function public.card_state(text) from public;
grant execute on function public.card_state(text) to anon, authenticated;

-- 2. the first scan makes the login with the password (only for a good card of an employee without a confirmed login)
create or replace function public.card_set_password(p_code text, p_password text) returns jsonb
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare c public.employee_cards; e public.employees; s jsonb; uid uuid; em text; nm text; pw text;
begin
  select * into c from public.employee_cards
    where card_no = (regexp_match(upper(trim(coalesce(p_code, ''))), '^EMONID\|(EOID-[0-9]{4}-[0-9]{4,})\|'))[1];
  if c.id is not null then perform 1 from public.employees where id = c.employee_id for update; end if; -- one scan at a time
  s := public.card_state(p_code);
  if s->>'state' is distinct from 'set_password' then
    raise exception '%', case s->>'state'
      when 'password' then 'This ID card already has a password. Scan the card and type your password.'
      when 'account_exists' then 'You already have a portal account with your email. Sign in with your email and password.'
      when 'blocked' then 'Your login is blocked. Ask the Director.'
      when 'expired' then 'This ID card has expired. Ask the Director for a new card.'
      when 'replaced' then 'This ID card was replaced by a newer card. Use your new ID card.'
      when 'ended' then 'This ID card is no longer valid.'
      else 'This ID card is not valid.' end;
  end if;
  if length(coalesce(p_password, '')) < 6 then raise exception 'Use a password of at least 6 characters.'; end if;
  if length(p_password) > 72 then raise exception 'Use a password of at most 72 characters.'; end if;
  select * into e from public.employees where id = c.employee_id;
  em := lower(trim(e.email)); nm := trim(e.first_name || ' ' || e.last_name);
  if em !~ '^[^@\s]+@[^@\s]+$' then raise exception 'Your employee profile has no email. Ask the Director to add it.'; end if;
  pw := extensions.crypt(p_password, extensions.gen_salt('bf', 10));
  uid := coalesce(e.profile_id, (select u.id from auth.users u where lower(u.email) = em limit 1));
  if uid is null then
    -- a new login, confirmed at once (no email): the sign-up trigger makes its profile and links this employee by the email
    uid := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
        created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
      values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', em, pw, now(),
        '{"provider": "email", "providers": ["email"]}', jsonb_build_object('full_name', nm, 'email_verified', true), now(), now(), '', '', '', '');
    insert into auth.identities (user_id, provider_id, identity_data, provider, created_at, updated_at)
      values (uid, uid::text, jsonb_build_object('sub', uid::text, 'email', em, 'email_verified', true, 'phone_verified', false), 'email', now(), now());
  else
    -- a login started with Create Account but never confirmed: it gets this password and is confirmed
    update auth.users set encrypted_password = pw, email_confirmed_at = coalesce(email_confirmed_at, now()), updated_at = now() where id = uid;
  end if;
  -- the login belongs to this employee (also a login started before the employee profile was made)
  insert into public.profiles (id, email, full_name, role, status) values (uid, em, nm, e.role, 'active') on conflict (id) do nothing;
  perform public.allow_record_change();
  update public.employees set profile_id = uid, status = case when status = 'waiting' then 'active' else status end
    where id = e.id and profile_id is null;
  return jsonb_build_object('email', em);
end;
$$;
revoke execute on function public.card_set_password(text, text) from public;
grant execute on function public.card_set_password(text, text) to anon, authenticated;

select 'UPDATE 3.30 READY - the first ID card scan makes the password' as result;

-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.31: Purchase Order is a menu access of its own (5 Purchase Order; Employee (HR) is 6)
-- The Director ticks 5 Purchase Order on Access & Status for each employee who may use it. Before, every employee had
-- it: this update gives it once to every employee and staff login of today, so nobody loses it; the Director takes it
-- away where it is not wanted. The server checks it too. Needs 023_purchase_orders.sql. Safe to run again.
-- =====================================================================
do $$ begin
  if to_regclass('public.purchase_orders') is null then raise exception 'Run 023_purchase_orders.sql first, then run this again.'; end if;
end $$;

-- 1. who may use Purchase Order: the Director, and staff with the Purchase Order menu
create or replace function public.po_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_staff() and public.has_module('purchase');
$$;
revoke execute on function public.po_staff() from public, anon;
grant execute on function public.po_staff() to authenticated;

drop policy if exists "po: staff read" on public.purchase_orders;
create policy "po: staff read" on public.purchase_orders for select to authenticated using ((select public.po_staff()));

drop policy if exists "storage records: purchase files" on storage.objects;
create policy "storage records: purchase files" on storage.objects as restrictive for select to authenticated
  using (bucket_id <> 'records' or coalesce((storage.foldername(name))[1], '') <> 'purchase' or (select public.po_staff()));

-- 2. every change of a purchase order made by a signed-in person needs the Purchase Order menu
create or replace function public.purchase_orders_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null and not public.has_module('purchase') then
    raise exception 'You have no access to Purchase Order. Ask the Director.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke execute on function public.purchase_orders_guard() from public, anon, authenticated;
drop trigger if exists purchase_orders_guard on public.purchase_orders;
create trigger purchase_orders_guard before insert or update or delete on public.purchase_orders
  for each row execute function public.purchase_orders_guard();

-- 3. once: everyone who has Purchase Order today keeps it (staff employees and staff logins)
do $$
begin
  if not exists (select 1 from private.app_secrets where k = 'purchase_menu_given') then
    perform public.allow_record_change();
    update public.employees set modules = modules || array['purchase']
      where role = 'staff' and status <> 'terminated' and not ('purchase' = any(modules));
    update public.profiles set modules = modules || array['purchase']
      where role = 'staff' and modules is not null and not ('purchase' = any(modules));
    insert into private.app_secrets (k, v) values ('purchase_menu_given', now()::text);
  end if;
end $$;

select 'UPDATE 3.31 READY - 5 Purchase Order is a menu access' as result;
