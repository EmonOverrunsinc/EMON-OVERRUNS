-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 2.2: the main Director edits a customer; a decided correction leaves no record
-- 1. The main Director: one account only, the first Director account (made first). Only the main Director edits a
--    customer's details. Every other account, another Director account too, sends a correction request for a
--    customer, and only the main Director approves or rejects it.
-- 2. Edit Customer (main Director): every detail of a customer in one form (name, phone, email, address and location
--    check, business, Facebook, credit limit, opening balance, application date), saved at once. Like an approved
--    correction it leaves no history. When the opening balance or the application date changes, the customer's
--    monthly statements are worked out again (they keep their numbers and signed copies).
--    Not edited here: the account number, application number and Public ID (they are on printed papers and QR codes),
--    the status (it has its own steps) and the photo (Change Photo).
-- 3. A correction leaves no record once it is decided: an approved one changes the record (as since 2.1); a rejected
--    one is removed too, and the person who asked gets one notice. The decided corrections and their notices kept
--    before are removed once.
-- Run once in the Supabase SQL Editor after 014_update_2_1.sql. No other records are changed. It is safe to run again.
-- =====================================================================

-- ---------- 1. the main Director ----------
-- One row: the profile of the main Director. Nobody reads or writes it from the portal (row level security with no
-- policy); the functions below read it.
create table if not exists public.main_director (
  only_one boolean primary key default true check (only_one),
  profile_id uuid not null references public.profiles(id) on delete restrict,
  set_at timestamptz not null default now()
);
alter table public.main_director enable row level security;
revoke all on public.main_director from anon, authenticated;
-- the first Director account is the main Director (kept when it is set)
insert into public.main_director (profile_id)
  select p.id from public.profiles p where p.role = 'admin' order by p.created_at, p.id limit 1
  on conflict (only_one) do nothing;

-- The main Director's profile: the one kept above, or (on a new portal, before it is kept) the first Director account.
create or replace function public.main_director_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select coalesce((select m.profile_id from public.main_director m),
                  (select p.id from public.profiles p where p.role = 'admin' order by p.created_at, p.id limit 1));
$$;
revoke execute on function public.main_director_id() from public, anon, authenticated;

-- Is the person signed in the main Director (and an active Director)?
create or replace function public.is_main_director() returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and auth.uid() = public.main_director_id() and public.is_admin();
$$;
revoke execute on function public.is_main_director() from public, anon;
grant execute on function public.is_main_director() to authenticated;

-- ---------- 2. Edit Customer ----------
-- The amounts of a customer's monthly statements from the month of p_since on, worked out again (after the opening
-- balance or the application date changed): the statements keep their numbers and signed copies. Months that were
-- missing are made. The sums are the ones generate_statements uses.
create or replace function public.restate_statements(p_customer uuid, p_since date) returns integer
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare
  c public.customers;
  s record;
  m date; nxt date;
  op numeric; deb numeric; cre numeric;
  n integer := 0;
begin
  select * into c from public.customers where id = p_customer;
  if c.id is null then return 0; end if;
  perform public.allow_record_change();
  for s in select st.id, st.period_start from public.statements st
           where st.customer_id = p_customer and st.period_start >= date_trunc('month', p_since)::date order by st.period_start loop
    m := s.period_start;
    nxt := (m + interval '1 month')::date;
    op := public.balance_before(c.id, m);
    deb := (case when c.application_date >= m and c.application_date < nxt then c.opening_balance else 0 end)
         + coalesce((select sum(total_amount) from public.customer_invoices where customer_id = c.id and invoice_date >= m and invoice_date < nxt), 0)
         + coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = c.id and o.status = 'applied' and (o.subject_type = 'charge' or (o.subject_type = 'settlement' and o.adjust_type = 'add'))
                      and o.applied_at::date >= m and o.applied_at::date < nxt), 0);
    cre := coalesce((select sum(amount) from public.payments_received where customer_id = c.id and paid_date >= m and paid_date < nxt), 0)
         + coalesce((select sum(request_amount) from public.credit_memos where customer_id = c.id and status in ('approved','paid')
                      and requested_action in ('credit','discount') and approved_at::date >= m and approved_at::date < nxt), 0)
         + coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = c.id and o.status = 'applied' and o.subject_type = 'settlement' and o.adjust_type = 'reduce'
                      and o.applied_at::date >= m and o.applied_at::date < nxt), 0);
    update public.statements set opening_balance = op, total_debit = deb, total_credit = cre, closing_balance = op + deb - cre where id = s.id;
    n := n + 1;
  end loop;
  perform public.generate_statements(p_customer);
  return n;
end;
$$;
revoke execute on function public.restate_statements(uuid, date) from public, anon, authenticated;

-- The main Director edits a customer's details at once. p_changes: only the details that change, for example
-- {"phone": "0917...", "opening_balance": 2500}. Gives back { changed: [names], statements: n, since: date }.
create or replace function public.director_edit_customer(p_id uuid, p_changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare
  allowed constant text[] := array['first_name', 'last_name', 'phone', 'email', 'address', 'location_check', 'business_name',
    'business_start_date', 'facebook_name', 'facebook_link', 'has_extra_facebook', 'extra_facebook_name', 'facebook_verified',
    'credit_limit', 'opening_balance', 'application_date'];
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
    raise exception 'Only the main Director can edit a customer''s details. Send a correction request instead.';
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
  if n.application_date is null then raise exception 'Enter the application date'; end if;
  if n.application_date > current_date then raise exception 'The application date cannot be after today'; end if;
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
    first_name = n.first_name, last_name = n.last_name, phone = n.phone, email = n.email,
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
  return jsonb_build_object('changed', to_jsonb(changed), 'statements', restated, 'since', since);
end;
$$;
revoke execute on function public.director_edit_customer(uuid, jsonb) from public, anon;
grant execute on function public.director_edit_customer(uuid, jsonb) to authenticated;

-- ---------- 3. corrections ----------
-- A correction request. The Director's own correction is added straight away, except a customer's: that is the main
-- Director's (Edit Customer), so another Director account sends it for approval like any other account.
create or replace function public.submit_change_request(p_table text, p_id uuid, p_changes jsonb, p_reason text, p_label text default null)
returns public.change_requests
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare
  cols text[] := public.editable_columns(p_table);
  k text;
  old jsonb;
  cr public.change_requests;
begin
  if not public.is_active() then raise exception 'Not allowed'; end if;
  if cols is null then raise exception 'This kind of record cannot be corrected'; end if;
  if not public.can_see_table(p_table) then raise exception 'You do not have access to this kind of record'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Write the reason'; end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then raise exception 'Nothing to correct'; end if;
  for k in select jsonb_object_keys(p_changes) loop
    if not (k = any(cols)) then raise exception 'The field "%" cannot be corrected', k; end if;
  end loop;
  execute format('select to_jsonb(t) from public.%I t where t.id = $1', p_table) into old using p_id;
  if old is null then raise exception 'Record not found'; end if;
  insert into public.change_requests (request_no, target_table, target_id, target_label, changes, previous, reason, requested_by, requested_by_name)
  values ('CR-' || to_char(current_date, 'YYYY') || '-' || lpad(public.next_counter('CR' || to_char(current_date, 'YYYY'))::text, 4, '0'),
          p_table, p_id, p_label, p_changes, (select jsonb_object_agg(x, old -> x) from jsonb_object_keys(p_changes) x),
          trim(p_reason), auth.uid(), (select full_name from public.profiles where id = auth.uid()))
  returning * into cr;
  -- The Director's own correction is added straight away (a customer's: the main Director's only).
  if public.is_admin() and (p_table <> 'customers' or public.is_main_director()) then
    return public.decide_change_request(cr.id, 'approve', null);
  end if;
  perform public.notify_admins('Correction request ' || cr.request_no, coalesce(p_label, p_table) || ' - ' || trim(p_reason), 'changes');
  return cr;
end;
$$;
revoke execute on function public.submit_change_request(text, uuid, jsonb, text, text) from public, anon;
grant execute on function public.submit_change_request(text, uuid, jsonb, text, text) to authenticated;

-- The Director approves or rejects a correction; a customer's correction: the main Director only.
create or replace function public.review_change_request(p_id uuid, p_action text, p_note text default null) returns public.change_requests
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Only the Director can approve corrections'; end if;
  if (select r.target_table from public.change_requests r where r.id = p_id) = 'customers' and not public.is_main_director() then
    raise exception 'Only the main Director can approve or reject a correction of a customer';
  end if;
  return public.decide_change_request(p_id, p_action, p_note);
end;
$$;
revoke execute on function public.review_change_request(uuid, text, text) from public, anon;
grant execute on function public.review_change_request(uuid, text, text) to authenticated;

-- A decided correction leaves no record: approved, the record takes the corrected details; rejected, the record stays
-- as it is. Either way the request and its notice are removed; the person who asked is told when it was rejected.
create or replace function public.decide_change_request(p_id uuid, p_action text, p_note text) returns public.change_requests
language plpgsql security definer set search_path = '' as $$
declare cr public.change_requests; me text; prev jsonb;
begin
  select * into cr from public.change_requests where id = p_id for update;
  if cr.id is null then raise exception 'Request not found'; end if;
  if cr.status <> 'pending' then raise exception 'This request is already %', upper(cr.status); end if;
  if p_action not in ('approve', 'reject') then raise exception 'Unknown action %', p_action; end if;
  me := (select full_name from public.profiles where id = auth.uid());
  perform public.allow_record_change();
  if p_action = 'approve' then
    prev := public.apply_record_changes(cr.target_table, cr.target_id, cr.changes);
    cr.status := 'approved'; cr.previous := prev;
  else
    cr.status := 'rejected';
    if cr.requested_by is distinct from auth.uid() then
      perform public.notify_user(cr.requested_by, 'Correction ' || cr.request_no || ' not approved',
        coalesce(cr.target_label, '') || coalesce(' - ' || nullif(trim(p_note), ''), ''), public.record_link(cr.target_table, cr.target_id));
    end if;
  end if;
  delete from public.notifications where title = 'Correction request ' || cr.request_no;
  delete from public.change_requests where id = p_id;
  cr.review_note := p_note; cr.reviewed_by_name := me; cr.reviewed_at := now();
  return cr;
end;
$$;
revoke execute on function public.decide_change_request(uuid, text, text) from public, anon, authenticated;

-- ---------- 4. once: the decided corrections kept before, and their notices ----------
do $$
begin
  perform public.allow_record_change();
  delete from public.notifications n
  where n.title like 'Correction %' and ((n.title like '% rejected' and n.title not like '% not approved') or (n.title like '% approved' and n.title not like '% not approved')
     or (n.title like 'Correction request %'
         and not exists (select 1 from public.change_requests r where r.status = 'pending' and n.title = 'Correction request ' || r.request_no)));
  delete from public.change_requests r where r.status <> 'pending';
end $$;
