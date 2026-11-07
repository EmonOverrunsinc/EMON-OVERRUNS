-- =====================================================================
-- EMON OVERRUNS E-PORTAL - UPDATE 3.82: RUN 085 TO 087 TOGETHER (safe to run again, also if some were run before)
-- 085: device login - the devices in use are registered automatically; a NEW device waits for EMON HASAN's approval
-- 086: a coverage added to the customer's account shows as COVERAGE on the customer's own statement
-- 087: the server's messages, notifications and payment notes say COVERAGE (not insurance)
-- Paste all of it in Supabase > SQL Editor > New query and press Run.
-- The last line says: UPDATE 3.82 READY ...
--
-- IF EMON HASAN CANNOT APPROVE A NEW DEVICE (no other device): run this one line in the SQL Editor, then sign in again:
--   update public.user_devices set status = 'approved', how = 'APPROVED IN THE SQL EDITOR', decided_at = now() where status = 'pending';
-- =====================================================================
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.80: DEVICE LOGIN (NEW DEVICE = APPROVAL)
-- * The device a login signs in on is REGISTERED AUTOMATICALLY: the first device of every login, and for the next 3 days
--   every device already in use (so nobody already working is stopped).
-- * After that, a sign in on a NEW DEVICE waits: the person sees "NEW DEVICE - WAITING FOR APPROVAL" and nothing of the
--   portal opens. EMON HASAN is told and approves (or blocks) it on OTHER > Devices.
--   EMON HASAN's own new device is approved from his other device (Devices page).
-- * This is checked by the server too: a login's data comes only to an approved device (with the agreements, 3.73).
-- * EMON HASAN can turn the device approval off and on (Devices page). Removing a device signs it out; it then needs
--   approval again.
-- Customers (Public ID + Private PIN) are not changed.
-- Needs 078_legal_enforce.sql. Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again.
-- The last line says: UPDATE 3.80 READY - ...
--
-- IF EMON HASAN CANNOT APPROVE (no other device): run this one line in the SQL Editor, then sign in again:
--   update public.user_devices set status = 'approved', how = 'APPROVED IN THE SQL EDITOR', decided_at = now() where status = 'pending';
-- =====================================================================
do $$ begin
  if to_regprocedure('public.legal_ok()') is null then raise exception 'Run 078_legal_enforce.sql first, then run this again.'; end if;
end $$;

-- 1. the settings: approval on/off and the automatic registration of the devices already in use (3 days from now)
alter table public.company_settings add column if not exists device_approval boolean not null default true;
alter table public.company_settings add column if not exists device_grace_until timestamptz;
update public.company_settings set device_grace_until = now() + interval '3 days' where id = 1 and device_grace_until is null;

-- 2. the devices of every login
create table if not exists public.user_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  device_id text not null check (device_id ~ '^[A-Za-z0-9-]{16,64}$'),
  name text not null default '',
  status text not null default 'pending' check (status in ('approved','pending','blocked','removed')),
  how text,
  ip_address text,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  decided_by uuid,
  decided_by_name text,
  decided_at timestamptz,
  unique (user_id, device_id)
);
create index if not exists user_devices_pending on public.user_devices (first_seen) where status = 'pending';
alter table public.user_devices enable row level security;
revoke all on public.user_devices from anon;
revoke insert, update, delete, truncate on public.user_devices from authenticated;
grant select on public.user_devices to authenticated;
-- a login sees its own devices; EMON HASAN sees all (changes only by the functions below)
drop policy if exists "devices: own or director" on public.user_devices;
create policy "devices: own or director" on public.user_devices for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

-- 3. the device this request comes from (the portal sends it with every request) is approved for this login
--    (no request headers = not a portal request, e.g. the SQL Editor or a scheduled job: not checked)
create or replace function public.device_ok() returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare h text; j json; info text; dev text;
begin
  if not coalesce((select s.device_approval from public.company_settings s where s.id = 1), true) then return true; end if;
  h := current_setting('request.headers', true);
  if h is null or h in ('', 'null', '{}') then return true; end if;
  begin j := h::json; exception when others then return false; end;
  info := coalesce(j ->> 'x-client-info', '');
  -- a file request (Storage) that does not pass the header on is not checked (the records themselves are)
  if info = '' and coalesce(current_setting('storage.operation', true), '') <> '' then return true; end if;
  dev := substring(info from 'eo-device/([A-Za-z0-9-]{16,64})');
  if dev is null then return false; end if;
  return exists (select 1 from public.user_devices d where d.user_id = auth.uid() and d.device_id = dev and d.status = 'approved');
end;
$$;
revoke execute on function public.device_ok() from public, anon;
grant execute on function public.device_ok() to authenticated;

-- 4. every rule for an active login, staff or EMON HASAN: the agreements (3.73) AND an approved device
create or replace function public.is_active() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active') and public.legal_ok() and public.device_ok();
$$;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active' and p.role = 'admin') and public.legal_ok() and public.device_ok();
$$;
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active' and p.role in ('admin','staff')) and public.legal_ok() and public.device_ok();
$$;

-- 5. the portal asks at every sign in: the device is registered (first device / in use: approved at once) or waits
create or replace function public.device_check(p_device text, p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); p public.profiles; d public.user_devices; on_ boolean; grace timestamptz; st text; how_ text; nm text;
begin
  if uid is null then raise exception 'Sign in first.'; end if;
  if p_device is null or p_device !~ '^[A-Za-z0-9-]{16,64}$' then raise exception 'This device has no device ID. Allow the browser to keep site data and try again.'; end if;
  select * into p from public.profiles where id = uid;
  if not found then raise exception 'Your profile is not ready yet.'; end if;
  select coalesce(s.device_approval, true), s.device_grace_until into on_, grace from public.company_settings s where s.id = 1;
  on_ := coalesce(on_, true);
  nm := left(upper(trim(coalesce(p_name, ''))), 120);
  select * into d from public.user_devices where user_id = uid and device_id = p_device;
  if not found then
    if not exists (select 1 from public.user_devices where user_id = uid) then st := 'approved'; how_ := 'FIRST DEVICE · REGISTERED AUTOMATICALLY';
    elsif grace is not null and now() < grace then st := 'approved'; how_ := 'DEVICE IN USE · REGISTERED AUTOMATICALLY';
    elsif not on_ then st := 'approved'; how_ := 'REGISTERED AUTOMATICALLY (DEVICE APPROVAL OFF)';
    else st := 'pending'; how_ := null; end if;
    insert into public.user_devices (user_id, device_id, name, status, how, ip_address)
      values (uid, p_device, nm, st, how_, public.legal_ip())
      on conflict (user_id, device_id) do nothing;
    select * into d from public.user_devices where user_id = uid and device_id = p_device;
    if d.status = 'pending' and st = 'pending' then
      perform public.notify_admins('NEW DEVICE WAITING FOR APPROVAL',
        coalesce(nullif(p.full_name, ''), p.email, 'A login') || ' signed in on a new device: ' || coalesce(nullif(nm, ''), 'UNKNOWN DEVICE') || '. Approve or block it on Devices.', 'devices');
    end if;
  else
    -- a removed device signing in again asks for approval again (approved at once while the approval is off)
    if d.status = 'removed' then
      update public.user_devices set status = case when on_ then 'pending' else 'approved' end, how = case when on_ then null else 'REGISTERED AUTOMATICALLY (DEVICE APPROVAL OFF)' end,
        decided_by = null, decided_by_name = null, decided_at = null, first_seen = now() where id = d.id;
      if on_ then
        perform public.notify_admins('NEW DEVICE WAITING FOR APPROVAL',
          coalesce(nullif(p.full_name, ''), p.email, 'A login') || ' signed in again on a removed device: ' || coalesce(nullif(nm, ''), d.name, 'UNKNOWN DEVICE') || '. Approve or block it on Devices.', 'devices');
      end if;
    end if;
    update public.user_devices set last_seen = now(), ip_address = coalesce(public.legal_ip(), ip_address), name = coalesce(nullif(nm, ''), name)
      where id = d.id returning * into d;
  end if;
  return jsonb_build_object('status', case when not on_ and d.status <> 'blocked' then 'approved' else d.status end, 'id', d.id, 'name', d.name,
    'how', d.how, 'admin', p.role = 'admin', 'grace_until', grace, 'approval', on_);
end;
$$;
revoke execute on function public.device_check(text, text) from public, anon;
grant execute on function public.device_check(text, text) to authenticated;

-- 6. EMON HASAN approves, blocks or removes a device; a login can remove its OWN other devices (sign them out)
create or replace function public.device_decide(p_id uuid, p_action text) returns void
language plpgsql security definer set search_path = '' as $$
declare d public.user_devices; me public.profiles; adm boolean := public.is_admin();
begin
  select * into d from public.user_devices where id = p_id;
  if not found then raise exception 'This device is not found.'; end if;
  select * into me from public.profiles where id = auth.uid();
  if p_action not in ('approve', 'block', 'remove') then raise exception 'Unknown action.'; end if;
  if not adm and not (p_action = 'remove' and d.user_id = auth.uid() and public.is_active()) then raise exception 'Only EMON HASAN can approve or block a device.'; end if;
  update public.user_devices set
    status = case p_action when 'approve' then 'approved' when 'block' then 'blocked' else 'removed' end,
    how = case p_action when 'approve' then 'APPROVED BY ' || upper(coalesce(me.full_name, me.email, '')) when 'block' then 'BLOCKED BY ' || upper(coalesce(me.full_name, me.email, ''))
      else 'REMOVED BY ' || upper(coalesce(me.full_name, me.email, '')) end,
    decided_by = auth.uid(), decided_by_name = coalesce(me.full_name, me.email), decided_at = now()
  where id = p_id;
  if d.user_id <> auth.uid() then
    perform public.notify_user(d.user_id, case p_action when 'approve' then 'YOUR NEW DEVICE IS APPROVED' when 'block' then 'YOUR DEVICE IS BLOCKED' else 'YOUR DEVICE IS REMOVED' end,
      coalesce(nullif(d.name, ''), 'Your device') || case p_action when 'approve' then ' can now use the E-Portal.' when 'block' then ' cannot use the E-Portal.' else ' is signed out of the E-Portal.' end, 'profile');
  end if;
end;
$$;
revoke execute on function public.device_decide(uuid, text) from public, anon;
grant execute on function public.device_decide(uuid, text) to authenticated;

-- 7. EMON HASAN turns the device approval on / off, or ends the automatic registration now
create or replace function public.device_settings(p_on boolean, p_end_grace boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Only EMON HASAN can change the device approval.'; end if;
  update public.company_settings set device_approval = coalesce(p_on, device_approval),
    device_grace_until = case when coalesce(p_end_grace, false) then now() else device_grace_until end where id = 1;
end;
$$;
revoke execute on function public.device_settings(boolean, boolean) from public, anon;
grant execute on function public.device_settings(boolean, boolean) to authenticated;

-- the login's name with its devices (for the Devices page)
create or replace view public.user_devices_list with (security_invoker = true) as
  select d.*, p.full_name, p.email, p.role from public.user_devices d join public.profiles p on p.id = d.user_id;
grant select on public.user_devices_list to authenticated;

notify pgrst, 'reload schema';

select case when position('device_ok' in pg_get_functiondef('public.is_staff()'::regprocedure)) > 0
  then 'UPDATE 3.80 READY - device login: the devices in use are registered automatically until '
    || to_char((select device_grace_until from public.company_settings where id = 1) at time zone 'Asia/Manila', 'Mon DD YYYY HH12:MI AM')
    || ' (Philippine time); after that a new device waits for approval (OTHER > Devices)'
  else 'NOT READY - send this message to Claude' end as result;

-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.80.1: INSURANCE SHOWN AS INSURANCE ON THE CUSTOMER'S STATEMENT
-- An insurance added to the customer's account (ADD TO ACCOUNT, 3.77) is shown on the customer's own "My Account" and
-- Statement of Account as INSURANCE INS-... (not as an invoice), like on the staff's statement.
-- Needs 080_customer_history.sql. Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again.
-- The last line says: UPDATE 3.80.1 READY - ...
-- =====================================================================
do $$ begin
  if to_regprocedure('public.customer_history(text,text)') is null then raise exception 'Run 080_customer_history.sql first, then run this again.'; end if;
end $$;

create or replace function public.customer_history(p_public text, p_pin text) returns jsonb
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare r jsonb := public.cust_signin_check(p_public, p_pin); c public.customers; ver text;
begin
  if not (r ->> 'ok')::boolean then return r; end if;
  select * into c from public.customers where id = (r ->> 'id')::uuid;
  ver := coalesce((select s.legal_version from public.company_settings s where s.id = 1), '');
  if ver <> '' and not exists (select 1 from public.legal_acceptances a where a.customer_id = c.id and a.terms_version = 'CUSTOMER ' || ver) then
    return jsonb_build_object('ok', false, 'error', 'Agree to the Customer Agreement first.');
  end if;
  return jsonb_build_object('ok', true,
    'customer', jsonb_build_object('first_name', c.first_name, 'last_name', c.last_name, 'account_no', c.account_no,
      'application_date', c.application_date, 'opening_balance', c.opening_balance),
    'invoices', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'invoice_no', i.invoice_no, 'invoice_date', i.invoice_date, 'due_date', i.due_date,
        'total_amount', i.total_amount, 'balance', i.balance, 'pay_status', i.pay_status, 'po_number', i.po_number) order by i.invoice_date desc, i.invoice_no desc)
      from public.invoice_balances i where i.customer_id = c.id), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'receipt_no', p.receipt_no, 'paid_date', p.paid_date, 'amount', p.amount, 'method', p.method)
        order by p.paid_date desc, p.receipt_no desc)
      from public.payments_received p where p.customer_id = c.id), '[]'::jsonb),
    'memos', coalesce((select jsonb_agg(to_jsonb(m) - array['notes', 'status_note', 'factory_status', 'created_by', 'created_by_name', 'approved_by', 'approved_by_name']
        order by m.approved_at desc nulls last)
      from public.credit_memos m where m.customer_id = c.id and m.status in ('approved', 'paid')), '[]'::jsonb),
    'adjustments', coalesce((select jsonb_agg(jsonb_build_object('order_no', o.order_no, 'subject_type', o.subject_type, 'adjust_type', o.adjust_type,
        'amount', o.amount, 'status', o.status, 'applied_at', o.applied_at) order by o.applied_at desc)
      from public.order_letters o where o.customer_id = c.id and o.subject_type in ('charge', 'settlement') and o.status = 'applied'), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(jsonb_build_object('order_no', o.order_no, 'order_date', o.order_date, 'status', o.status,
        'total_boxes', o.total_boxes, 'total_pcs', o.total_pcs, 'total_amount', o.total_amount, 'delivered_at', o.delivered_at) order by o.order_date desc, o.order_no desc)
      from public.customer_orders o where o.customer_id = c.id and o.status <> 'cancelled'), '[]'::jsonb));
end;
$$;
revoke execute on function public.customer_history(text, text) from public;
grant execute on function public.customer_history(text, text) to anon, authenticated;

select case when position('po_number' in pg_get_functiondef('public.customer_history(text,text)'::regprocedure)) > 0
  then 'UPDATE 3.80.1 READY - an insurance added to the account shows as INSURANCE on the customer''s statement'
  else 'NOT READY - send this message to Claude' end as result;

-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.81: THE WORD "INSURANCE" IS NOT SHOWN: "COVERAGE"
-- The messages, notifications and payment notes made by the server say COVERAGE (e.g. "COVERAGE INS-202611-003 ·
-- ORDER OR-..."), like the portal, the certificate and the statement. The payment notes and notifications already
-- saved are changed the same way. Nothing else changes (the numbers INS-..., the amounts and the records stay).
-- Needs 084_insurance_account.sql. Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again.
-- The last line says: UPDATE 3.81 READY - ...
-- =====================================================================
do $$ begin
  if to_regprocedure('public.ins_bill_account(uuid)') is null then raise exception 'Run 084_insurance_account.sql first, then run this again.'; end if;
end $$;

-- 1. the server's own words: every text in the coverage functions that starts with Insurance / INSURANCE
do $$
declare f record; def text; n int := 0;
begin
  for f in select p.oid from pg_proc p join pg_namespace s on s.oid = p.pronamespace
           where s.nspname = 'public' and p.prokind = 'f' and pg_get_functiondef(p.oid) ~ '''(Insurance|INSURANCE)'
  loop
    def := pg_get_functiondef(f.oid);
    def := replace(replace(def, '''Insurance', '''Coverage'), '''INSURANCE', '''COVERAGE');
    execute def;
    n := n + 1;
  end loop;
  raise notice 'coverage words: % function(s) changed', n;
end $$;

-- 2. the payment notes already saved (collection vouchers of a coverage) and the notifications already sent
do $$ begin
  perform public.allow_record_change();
  update public.collection_vouchers set note = 'COVERAGE ' || substr(note, 11) where note like 'INSURANCE INS-%';
  perform set_config('eo.allow_change', 'off', true);
  update public.notifications set title = 'Coverage ' || substr(title, 11) where title like 'Insurance INS-%';
end $$;

notify pgrst, 'reload schema';

select case when not exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace
                             where s.nspname = 'public' and p.prokind = 'f' and pg_get_functiondef(p.oid) ~ '''(Insurance|INSURANCE)')
  then 'UPDATE 3.81 READY - the server says COVERAGE (not insurance) in its messages, notifications and payment notes'
  else 'NOT READY - send this message to Claude' end as result;

select case when position('device_ok' in pg_get_functiondef('public.is_staff()'::regprocedure)) > 0
    and position('po_number' in pg_get_functiondef('public.customer_history(text,text)'::regprocedure)) > 0
    and not exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace
                    where s.nspname = 'public' and p.prokind = 'f' and pg_get_functiondef(p.oid) ~ '''(Insurance|INSURANCE)')
  then 'UPDATE 3.82 READY - device login on (devices in use registered automatically until '
    || to_char((select device_grace_until from public.company_settings where id = 1) at time zone 'Asia/Manila', 'Mon DD YYYY HH12:MI AM')
    || '), COVERAGE on the statement and in the server messages'
  else 'NOT READY - send this message to Claude' end as result;
