-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.36: the duplicate customer check finds more; a lot is deleted by the Director only
-- 1. The same person is found also when the name is typed another way: first and last name swapped, written together or
--    apart (DELA CRUZ = DELACRUZ, MARIA CLARA + SANTOS = MARIA + CLARA SANTOS), with dots, dashes or accents (MA. THERESA
--    PEÑAFLOR = MA THERESA PENAFLOR); the Facebook name the same way. The same PHONE number (0917…, +63 917…, with
--    spaces or dashes) is found too: it shows as SIMILAR for the Director to check (a phone never blocks an account: a
--    family can share one). A CLOSED account or the same Facebook link still blocks, as before.
-- 2. A purchase order (lot) is deleted by the Director only (before: also by the person who made it).
-- Needs 014_update_2_1.sql and 023_purchase_orders.sql. Safe to run again.
-- =====================================================================
do $$ begin
  if to_regprocedure('public.facebook_key(text)') is null then raise exception 'Run 014_update_2_1.sql first, then run this again.'; end if;
  if to_regclass('public.purchase_orders') is null then raise exception 'Run 023_purchase_orders.sql first, then run this again.'; end if;
end $$;

-- a name made comparable: small letters without accents, dots, dashes or spaces (MA. THERESA → matheresa); empty = null
create or replace function public.name_key(p text) returns text
language sql immutable set search_path = '' as $$
  select nullif(regexp_replace(translate(lower(coalesce(p, '')), 'áàâäãåéèêëíìîïóòôöõúùûüñç', 'aaaaaaeeeeiiiiooooouuuunc'), '[^a-z0-9]', '', 'g'), '');
$$;
revoke execute on function public.name_key(text) from public, anon;

-- a phone number made comparable: its last 10 digits (0917 123 4567, +63 917 123 4567 and 639171234567 are the same);
-- null when it has fewer than 7 digits
create or replace function public.phone_key(p text) returns text
language sql immutable set search_path = '' as $$
  select case when length(d) < 7 then null else right(d, 10) end
  from (select regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') as d) x;
$$;
revoke execute on function public.phone_key(text) from public, anon;

-- Every account that may be the same person (internal: used by the checks below). p_phone: a match on the phone is
-- SIMILAR only (never BLOCKED).
drop function if exists public.customer_matches(text, text, text, text, text, uuid);
create or replace function public.customer_matches(p_first text, p_last text, p_fb_name text, p_fb_extra text, p_fb_link text,
  p_except uuid default null, p_phone text default null)
returns table (id uuid, account_no text, first_name text, last_name text, phone text, email text, facebook_name text, facebook_link text,
  status text, matched_on text, blocked boolean)
language sql stable security definer set search_path = '' as $$
  with me as (
    select public.name_key(p_first) || public.name_key(p_last) as full_name,
      array_remove(array[public.name_key(p_fb_name), public.name_key(p_fb_extra)], null) as fb,
      public.facebook_key(p_fb_link) as k, public.phone_key(p_phone) as ph)
  select o.id, o.account_no, o.first_name, o.last_name, o.phone, o.email, o.facebook_name, o.facebook_link, o.status,
    concat_ws(', ', case when x.by_name then 'name' end, case when x.by_fb then 'Facebook name' end,
      case when x.by_link then 'Facebook link' end, case when x.by_phone then 'phone' end),
    (x.by_link and o.status <> 'rejected') or ((x.by_name or x.by_fb) and o.status = 'closed')
  from public.customers o cross join me
  cross join lateral (select
      me.full_name is not null and me.full_name in (public.name_key(o.first_name) || public.name_key(o.last_name),
                                                    public.name_key(o.last_name) || public.name_key(o.first_name)) as by_name,
      cardinality(me.fb) > 0 and array_remove(array[public.name_key(o.facebook_name), public.name_key(o.extra_facebook_name)], null) && me.fb as by_fb,
      me.k is not null and public.facebook_key(o.facebook_link) = me.k as by_link,
      me.ph is not null and public.phone_key(o.phone) = me.ph as by_phone) x
  where (p_except is null or o.id <> p_except) and (x.by_name or x.by_fb or x.by_link or x.by_phone)
  order by 11 desc, o.created_at;
$$;
revoke execute on function public.customer_matches(text, text, text, text, text, uuid, text) from public, anon, authenticated;

-- Why this person cannot open an account (empty when they can). The phone is not asked: it never blocks.
create or replace function public.customer_block_reason(p_first text, p_last text, p_fb_name text, p_fb_extra text, p_fb_link text, p_except uuid default null)
returns text language sql stable security definer set search_path = '' as $$
  select 'This person cannot open an account: ' || case
      when m.matched_on like '%Facebook link%' then 'the same Facebook link is on account ' || coalesce(m.account_no, '') || ' (' || upper(m.status) || ')'
      else 'account ' || coalesce(m.account_no, '') || ' with the same ' || m.matched_on || ' was CLOSED' end || '.'
  from public.customer_matches(p_first, p_last, p_fb_name, p_fb_extra, p_fb_link, p_except) m
  where m.blocked limit 1;
$$;
revoke execute on function public.customer_block_reason(text, text, text, text, text, uuid) from public, anon, authenticated;

-- The check of a saved application (Check & Verify): now with its phone number too.
create or replace function public.customer_duplicates(p_id uuid)
returns table (id uuid, account_no text, first_name text, last_name text, phone text, email text, facebook_name text, facebook_link text,
  status text, matched_on text, blocked boolean)
language sql stable security definer set search_path = '' as $$
  select m.* from public.customers c
  cross join lateral public.customer_matches(c.first_name, c.last_name, c.facebook_name, c.extra_facebook_name, c.facebook_link, c.id, c.phone) m
  where c.id = p_id and (public.is_admin() or public.can_write('customers'));
$$;
revoke execute on function public.customer_duplicates(uuid) from public, anon;
grant execute on function public.customer_duplicates(uuid) to authenticated;

-- The same check while a new application is typed (before it is saved): without the phone (for an older portal) …
create or replace function public.customer_person_check(p_first text, p_last text, p_fb_name text, p_fb_extra text, p_fb_link text)
returns table (id uuid, account_no text, first_name text, last_name text, phone text, email text, facebook_name text, facebook_link text,
  status text, matched_on text, blocked boolean)
language sql stable security definer set search_path = '' as $$
  select m.* from public.customer_matches(p_first, p_last, p_fb_name, p_fb_extra, p_fb_link) m
  where public.is_admin() or public.can_write('customers');
$$;
revoke execute on function public.customer_person_check(text, text, text, text, text) from public, anon;
grant execute on function public.customer_person_check(text, text, text, text, text) to authenticated;

-- … and with the phone (3.36)
create or replace function public.customer_person_check(p_first text, p_last text, p_fb_name text, p_fb_extra text, p_fb_link text, p_phone text)
returns table (id uuid, account_no text, first_name text, last_name text, phone text, email text, facebook_name text, facebook_link text,
  status text, matched_on text, blocked boolean)
language sql stable security definer set search_path = '' as $$
  select m.* from public.customer_matches(p_first, p_last, p_fb_name, p_fb_extra, p_fb_link, null, p_phone) m
  where public.is_admin() or public.can_write('customers');
$$;
revoke execute on function public.customer_person_check(text, text, text, text, text, text) from public, anon;
grant execute on function public.customer_person_check(text, text, text, text, text, text) to authenticated;

-- 2. A purchase order still waiting is deleted by the Director only (gives back the photo and voice paths); an approved
--    or cancelled one cannot be deleted.
create or replace function public.delete_purchase_order(p_id uuid) returns text[]
language plpgsql security definer set search_path = '' as $$
declare po public.purchase_orders;
begin
  if not public.is_admin() then raise exception 'Only the Director can delete a purchase order'; end if;
  select * into po from public.purchase_orders where id = p_id for update;
  if not found then raise exception 'Purchase order not found'; end if;
  if po.status not in ('pending','negotiation') then raise exception 'Purchase order % is % and cannot be deleted', po.po_no, upper(po.status); end if;
  delete from public.notifications where title = 'Purchase order ' || po.po_no || ' to review';
  delete from public.purchase_orders where id = p_id;
  return po.photos || po.voices;
end;
$$;
revoke execute on function public.delete_purchase_order(uuid) from public, anon;
grant execute on function public.delete_purchase_order(uuid) to authenticated;

select 'UPDATE 3.36 READY - the duplicate customer check finds swapped names, names typed together or apart, accents and the same phone; a lot is deleted by the Director only' as result;
