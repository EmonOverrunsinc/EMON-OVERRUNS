-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 2.2: the main Director edits a customer; a decided correction leaves no record;
-- the first SOA is the month the account was opened
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
-- 4. Statements of account (SOA): the first SOA of an account is the month the account was opened (its application
--    date). Entries dated before it (old receipts and purchases recorded later) are in that first SOA, which starts
--    from zero; no SOA is made for the months before, and the ones made before are removed once (a SOA with a signed
--    copy is kept). One SOA a month after that, made automatically on the 1st. An entry recorded later with a date in
--    a month that already has its SOA works the SOAs out again from that month, so they always match the entries.
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
-- (A new opening balance or application date works the monthly statements out again: restate_statements, part 5.)

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

-- ---------- 5. statements of account (SOA) ----------
-- The amounts of the SOA of a month. The first SOA (the month the account was opened) starts from zero and has every
-- entry up to its last day, also the ones dated before; a later month starts from the balance before it.
create or replace function public.statement_amounts(p_customer uuid, p_month date, out opening numeric, out debit numeric, out credit numeric)
language plpgsql stable security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare
  c public.customers;
  m date := date_trunc('month', p_month)::date;
  nxt date := (date_trunc('month', p_month) + interval '1 month')::date;
  lo date; -- the first day counted (null: from the very first entry)
begin
  select * into c from public.customers where id = p_customer;
  if m <= date_trunc('month', c.application_date)::date then opening := 0; lo := null;
  else opening := public.balance_before(c.id, m); lo := m; end if;
  debit := (case when c.application_date < nxt and (lo is null or c.application_date >= lo) then coalesce(c.opening_balance, 0) else 0 end)
    + coalesce((select sum(i.total_amount) from public.customer_invoices i where i.customer_id = c.id and i.invoice_date < nxt and (lo is null or i.invoice_date >= lo)), 0)
    + coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = c.id and o.status = 'applied'
                 and (o.subject_type = 'charge' or (o.subject_type = 'settlement' and o.adjust_type = 'add'))
                 and o.applied_at::date < nxt and (lo is null or o.applied_at::date >= lo)), 0);
  credit := coalesce((select sum(p.amount) from public.payments_received p where p.customer_id = c.id and p.paid_date < nxt and (lo is null or p.paid_date >= lo)), 0)
    + coalesce((select sum(x.request_amount) from public.credit_memos x where x.customer_id = c.id and x.status in ('approved','paid')
                 and x.requested_action in ('credit','discount') and x.approved_at::date < nxt and (lo is null or x.approved_at::date >= lo)), 0)
    + coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = c.id and o.status = 'applied'
                 and o.subject_type = 'settlement' and o.adjust_type = 'reduce'
                 and o.applied_at::date < nxt and (lo is null or o.applied_at::date >= lo)), 0);
end;
$$;
revoke execute on function public.statement_amounts(uuid, date) from public, anon, authenticated;

-- The SOAs that are missing, made for every month that has ended: from the month the account was opened (not from an
-- earlier entry) to last month (a closed account: to the month it was closed). Run on the 1st by the schedule and when
-- the portal is opened.
create or replace function public.generate_statements(p_customer uuid default null) returns integer
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare
  c record;
  a record;
  m date;
  last_m date := (date_trunc('month', current_date) - interval '1 month')::date;
  stop_m date;
  made integer := 0;
begin
  if auth.uid() is not null and not public.is_active() then raise exception 'Not allowed'; end if;
  for c in select * from public.customers cu where cu.status in ('active','suspended','closed') and (p_customer is null or cu.id = p_customer) loop
    stop_m := last_m;
    if c.status = 'closed' then
      stop_m := least(last_m, coalesce((select date_trunc('month', max(created_at))::date from public.customer_events
                                        where customer_id = c.id and (action = 'close' or action like 'closed by %')), last_m));
    end if;
    m := date_trunc('month', c.application_date)::date;
    while m <= stop_m loop
      if not exists (select 1 from public.statements s where s.customer_id = c.id and s.period_start = m) then
        select * into a from public.statement_amounts(c.id, m);
        insert into public.statements (statement_no, customer_id, period_start, period_end, opening_balance, total_debit, total_credit, closing_balance)
        values ('SOA-' || to_char(m, 'YYYYMM') || '-' || c.account_no, c.id, m, ((m + interval '1 month')::date - 1),
                a.opening, a.debit, a.credit, a.opening + a.debit - a.credit);
        made := made + 1;
      end if;
      m := (m + interval '1 month')::date;
    end loop;
  end loop;
  return made;
end;
$$;
revoke execute on function public.generate_statements(uuid) from public, anon;
grant execute on function public.generate_statements(uuid) to authenticated;

-- A customer's SOAs worked out again from the month of p_since on (after an entry dated in a month that has its SOA,
-- or a new opening balance or application date): the SOAs keep their numbers and signed copies; a SOA before the
-- month the account was opened is removed (one with a signed copy is kept); missing months are made. The caller allows
-- the change (allow_record_change, or a trigger).
create or replace function public.restate_statements(p_customer uuid, p_since date) returns integer
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare
  c public.customers;
  s record;
  a record;
  n integer := 0;
begin
  select * into c from public.customers where id = p_customer;
  if c.id is null then return 0; end if;
  delete from public.statements st where st.customer_id = c.id and st.period_start < date_trunc('month', c.application_date)::date
    and not exists (select 1 from public.attachments x where x.owner_type = 'statement' and x.owner_id = st.id);
  for s in select st.id, st.period_start from public.statements st
           where st.customer_id = c.id and st.period_start >= date_trunc('month', least(p_since, c.application_date))::date
           order by st.period_start loop
    select * into a from public.statement_amounts(c.id, s.period_start);
    update public.statements set opening_balance = a.opening, total_debit = a.debit, total_credit = a.credit,
      closing_balance = a.opening + a.debit - a.credit where id = s.id;
    n := n + 1;
  end loop;
  perform public.generate_statements(c.id);
  return n;
end;
$$;
revoke execute on function public.restate_statements(uuid, date) from public, anon, authenticated;

-- A purchase or payment recorded with a date in a month that already has its SOA (an old paper recorded later): the
-- SOAs are worked out again from that month on.
create or replace function public.statements_follow_entry() returns trigger
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare d date := coalesce(to_jsonb(new) ->> 'invoice_date', to_jsonb(new) ->> 'paid_date')::date;
begin
  if d is not null and exists (select 1 from public.statements s where s.customer_id = new.customer_id and s.period_end >= d) then
    perform public.restate_statements(new.customer_id, d);
  end if;
  return null;
end;
$$;
revoke execute on function public.statements_follow_entry() from public, anon, authenticated;
drop trigger if exists statements_follow on public.customer_invoices;
create trigger statements_follow after insert on public.customer_invoices for each row execute function public.statements_follow_entry();
drop trigger if exists statements_follow on public.payments_received;
create trigger statements_follow after insert on public.payments_received for each row execute function public.statements_follow_entry();

-- ---------- 6. once: the SOAs made before for months before the account was opened ----------
-- Removed (unless a signed copy was uploaded on one), and every other SOA worked out again with the rules above.
do $$
declare c record;
begin
  perform public.allow_record_change();
  for c in select distinct s.customer_id from public.statements s loop
    perform public.restate_statements(c.customer_id, '1900-01-01');
  end loop;
end $$;
