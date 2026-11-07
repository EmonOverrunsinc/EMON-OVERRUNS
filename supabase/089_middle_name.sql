-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.85: THE CUSTOMER'S MIDDLE NAME
-- A new customer has First Name, MIDDLE NAME and Last Name. A customer who has no middle name ticks "I don't have a
-- middle name" (the box goes away). EMON HASAN can add or change it on Edit Customer. The middle name shows in the
-- customer's name (FIRST MIDDLE LAST) on the customer pages and documents. Customers already saved stay as they are.
-- Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again.
-- The last line says: UPDATE 3.85 READY - ...
-- =====================================================================
alter table public.customers add column if not exists middle_name text;
alter table public.customers add column if not exists no_middle_name boolean not null default false;

-- a new customer: the middle name tidied (none when "I don't have a middle name" is ticked)
create or replace function public.customers_middle_name() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.no_middle_name := coalesce(new.no_middle_name, false);
  new.middle_name := case when new.no_middle_name then null else nullif(btrim(new.middle_name), '') end;
  return new;
end;
$$;
drop trigger if exists customers_middle_name_bi on public.customers;
create trigger customers_middle_name_bi before insert on public.customers for each row execute function public.customers_middle_name();

-- EMON HASAN's Edit Customer: the middle name can be added or changed too
CREATE OR REPLACE FUNCTION public.director_edit_customer(p_id uuid, p_changes jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET "TimeZone" TO 'Asia/Manila'
AS $function$
declare
  allowed constant text[] := array['first_name', 'last_name', 'phone', 'email', 'address', 'location_check', 'business_name',
    'business_start_date', 'facebook_name', 'facebook_link', 'has_extra_facebook', 'extra_facebook_name', 'facebook_verified',
    'credit_limit', 'opening_balance', 'application_date', 'middle_name', 'no_middle_name'];
  c public.customers;
  n public.customers;
  k text;
  why text;
  was text;
  changed text[] := '{}';
  restated integer := 0;
  since date := null;
begin
  if not public.is_main_director() then
    raise exception 'Only EMON HASAN can edit a customer''s details. Send a correction request instead.';
  end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then raise exception 'Nothing to save'; end if;
  for k in select jsonb_object_keys(p_changes) loop
    if not (k = any(allowed)) then raise exception 'The detail "%" cannot be edited here', k; end if;
  end loop;
  select * into c from public.customers where id = p_id for update;
  if c.id is null then raise exception 'Customer not found'; end if;
  n := jsonb_populate_record(c, p_changes);
  -- tidy and check, as for a new application
  n.first_name := nullif(btrim(n.first_name), '');
  n.last_name := nullif(btrim(n.last_name), '');
  n.no_middle_name := coalesce(n.no_middle_name, false);
  n.middle_name := case when n.no_middle_name then null else nullif(btrim(n.middle_name), '') end; -- 3.85
  n.address := nullif(btrim(n.address), '');
  n.phone := nullif(btrim(n.phone), '');
  n.email := nullif(btrim(n.email), '');
  n.business_name := nullif(btrim(n.business_name), '');
  n.facebook_name := nullif(btrim(n.facebook_name), '');
  n.extra_facebook_name := nullif(btrim(n.extra_facebook_name), '');
  n.facebook_link := nullif(btrim(n.facebook_link), '');
  if n.first_name is null or n.last_name is null then raise exception 'Enter the first name and the last name'; end if;
  if n.address is null then raise exception 'Enter the address'; end if;
  if n.location_check is null or n.location_check not in ('found', 'no_need', 'not_found') then
    raise exception 'Choose the location check: FOUND, NO NEED TO CHECK LOCATION or NOT FOUND';
  end if;
  n.address_verified := n.location_check = 'found';
  n.has_extra_facebook := coalesce(n.has_extra_facebook, false);
  if not n.has_extra_facebook then n.extra_facebook_name := null; end if;
  n.facebook_verified := coalesce(n.facebook_verified, false);
  if n.credit_limit is not null and n.credit_limit < 0 then raise exception 'The credit limit cannot be below zero'; end if;
  n.opening_balance := coalesce(n.opening_balance, 0);
  if n.opening_balance < 0 then raise exception 'The opening balance cannot be below zero'; end if;
  if n.application_date is null then raise exception 'Enter the opening date'; end if;
  if n.application_date > current_date then raise exception 'The opening date cannot be after today'; end if;
  -- One person, one account: the edit may not make this account the same person as another account. A match that
  -- was there before the edit does not stop it.
  why := public.customer_block_reason(n.first_name, n.last_name, n.facebook_name, n.extra_facebook_name, n.facebook_link, n.id);
  if why is not null then
    was := public.customer_block_reason(c.first_name, c.last_name, c.facebook_name, c.extra_facebook_name, c.facebook_link, c.id);
    if was is distinct from why then raise exception '%', why; end if;
  end if;
  foreach k in array allowed loop
    if (to_jsonb(n) -> k) is distinct from (to_jsonb(c) -> k) then changed := changed || k; end if;
  end loop;
  if cardinality(changed) = 0 then return jsonb_build_object('changed', '[]'::jsonb, 'statements', 0, 'since', null); end if;
  perform public.allow_record_change();
  update public.customers set
    first_name = n.first_name, middle_name = n.middle_name, no_middle_name = n.no_middle_name, last_name = n.last_name, phone = n.phone, email = n.email,
    address = n.address, location_check = n.location_check, address_verified = n.address_verified,
    business_name = n.business_name, business_start_date = n.business_start_date,
    facebook_name = n.facebook_name, facebook_link = n.facebook_link, has_extra_facebook = n.has_extra_facebook,
    extra_facebook_name = n.extra_facebook_name, facebook_verified = n.facebook_verified,
    credit_limit = n.credit_limit, opening_balance = n.opening_balance, application_date = n.application_date
  where id = p_id;
  -- the monthly statements follow a new opening balance or application date
  if 'opening_balance' = any(changed) or 'application_date' = any(changed) then
    since := least(c.application_date, n.application_date);
    restated := public.restate_statements(p_id, since);
  end if;
  insert into public.record_changes (target_table, target_id, action, changes, target_label, actor, actor_name)
  values ('customers', p_id, 'edited', (select jsonb_object_agg(x, 'null'::jsonb) from unnest(changed) x),
          coalesce(c.account_no, c.application_no) || ' ' || c.first_name || ' ' || c.last_name, auth.uid(), (select full_name from public.profiles where id = auth.uid()));
  return jsonb_build_object('changed', to_jsonb(changed), 'statements', restated, 'since', since);
end;
$function$;

notify pgrst, 'reload schema';

select case when position('middle_name' in pg_get_functiondef('public.director_edit_customer(uuid,jsonb)'::regprocedure)) > 0
    and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'customers' and column_name = 'middle_name')
  then 'UPDATE 3.85 READY - customers have a middle name (or "I don''t have a middle name")'
  else 'NOT READY - send this message to Claude' end as result;
