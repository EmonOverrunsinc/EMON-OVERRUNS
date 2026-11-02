-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.70: REJECT THE AGREEMENT = SIGNED OUT
-- Every login must agree before using the portal. The agreement popup now has a REJECT button: the person is signed out
-- at once, and the next sign in shows the agreement again — nothing of the portal opens until they agree. Every rejection
-- is kept on the server for good (who, which agreement, when, device, IP address); EMON HASAN sees them in Legal Terms.
-- Customers who reject (Public ID + Private PIN) are kept too.
-- Needs 073_legal_terms.sql and 074_customer_portal.sql. Paste all of it in Supabase > SQL Editor > New query and press Run.
-- Safe to run again. The last line says: UPDATE 3.70 READY - ...
-- =====================================================================
do $$ begin
  if to_regprocedure('public.customer_portal(text,text,text)') is null then raise exception 'Run RUN_073_TO_074.sql first, then run this again.'; end if;
end $$;

create table if not exists public.legal_rejections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,      -- no link: the record stays even when the login is deleted later
  customer_id uuid,  -- or the customer
  full_name text,
  email text,
  role text,
  terms_version text not null check (char_length(terms_version) between 1 and 40),
  device text check (char_length(device) <= 400),
  ip_address text,
  rejected_at timestamptz not null default now(),
  check (user_id is not null or customer_id is not null)
);
create index if not exists legal_rejections_time_idx on public.legal_rejections(rejected_at desc);
alter table public.legal_rejections enable row level security;
revoke all on public.legal_rejections from anon, authenticated;
grant select on public.legal_rejections to authenticated;
drop policy if exists "legal rejections: director" on public.legal_rejections;
create policy "legal rejections: director" on public.legal_rejections for select to authenticated using ((select public.is_admin()));
drop trigger if exists legal_rejections_keep on public.legal_rejections;
create trigger legal_rejections_keep before update or delete on public.legal_rejections for each row execute function public.legal_keep();

create or replace function public.legal_ip() returns text
language plpgsql stable set search_path = '' as $$
declare h json;
begin
  begin h := current_setting('request.headers', true)::json; exception when others then return null; end;
  return nullif(left(trim(split_part(coalesce(h ->> 'x-forwarded-for', h ->> 'x-real-ip', h ->> 'cf-connecting-ip', ''), ',', 1)), 60), '');
end;
$$;
revoke execute on function public.legal_ip() from public, anon, authenticated;

-- a login rejects
create or replace function public.reject_legal_terms(p_version text, p_device text) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.profiles;
begin
  if auth.uid() is null then return; end if;
  select * into p from public.profiles where id = auth.uid();
  insert into public.legal_rejections (user_id, full_name, email, role, terms_version, device, ip_address)
  values (auth.uid(), p.full_name, p.email, p.role, left(coalesce(nullif(trim(p_version), ''), '?'), 40), left(p_device, 400), public.legal_ip());
end;
$$;
revoke execute on function public.reject_legal_terms(text, text) from public, anon;
grant execute on function public.reject_legal_terms(text, text) to authenticated;

-- a customer rejects (only with the right Public ID and Private PIN)
create or replace function public.customer_reject_terms(p_public text, p_pin text, p_version text, p_device text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r jsonb := public.cust_signin_check(p_public, p_pin); c public.customers;
begin
  if not (r ->> 'ok')::boolean then return r; end if;
  select * into c from public.customers where id = (r ->> 'id')::uuid;
  insert into public.legal_rejections (customer_id, full_name, email, role, terms_version, device, ip_address)
  values (c.id, trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) || coalesce(' (' || c.account_no || ')', ''), c.email, 'customer',
    left(coalesce(nullif(trim(p_version), ''), '?'), 40), left(p_device, 400), public.legal_ip());
  return jsonb_build_object('ok', true);
end;
$$;
revoke execute on function public.customer_reject_terms(text, text, text, text) from public;
grant execute on function public.customer_reject_terms(text, text, text, text) to anon, authenticated;

select case when to_regprocedure('public.reject_legal_terms(text,text)') is not null
  then 'UPDATE 3.70 READY - Reject signs the person out; every rejection is kept for EMON HASAN'
  else 'NOT READY - send this message to Claude' end as result;
