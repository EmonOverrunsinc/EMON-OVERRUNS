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
