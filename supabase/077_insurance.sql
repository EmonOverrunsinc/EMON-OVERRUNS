-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.72: EO-OFFICE INSURANCE (ORDER COVERAGE)
-- An insurance coverage for a customer order, bought BEFORE delivery:
--   premium = boxes x PHP 50 + 0.5% of the order value (EMON HASAN can change both in Insurance settings).
-- 1. Staff (EO-Office) or EMON HASAN adds it by the order number: the order details and the premium show.
-- 2. Payment: EMON HASAN's payment QR code and the amount show; after paying, the proof of payment is uploaded and
--    submitted for review.
-- 3. EVA AI reads the payment slip: when the amount on it is the premium, the coverage is issued at once. Otherwise
--    EMON HASAN reviews: APPROVE issues the coverage at once (certificate with EMON HASAN's signature) and makes a
--    COLLECTION VOUCHER for the amount by itself (with the proof as its receipt); REJECT sends it back with a note.
-- 4. The coverage is valid until 15 days after the delivery (it shows "VALID UNTIL 15 DAYS AFTER DELIVERY" before).
--    The order page shows the COVERED badge and EXPIRES date; anyone can verify the certificate (INS-…) or the order.
-- Needs 045_customer_orders.sql and 024_eo_office.sql. Paste all of it in Supabase > SQL Editor > New query and press Run.
-- Safe to run again. The last line says: UPDATE 3.72 READY - ...
-- =====================================================================
do $$ begin
  if to_regclass('public.customer_orders') is null or to_regclass('public.collection_vouchers') is null then raise exception 'Run the earlier updates first (customer orders, EO-Office).'; end if;
end $$;

-- 1. the settings: premium per box, rate of the order value, the payment QR code (a picture in the branding folder)
alter table public.company_settings add column if not exists ins_box_price numeric(12,2) not null default 50 check (ins_box_price >= 0);
alter table public.company_settings add column if not exists ins_rate_pct numeric(6,3) not null default 0.5 check (ins_rate_pct >= 0 and ins_rate_pct <= 100);
alter table public.company_settings add column if not exists pay_qr_path text;
alter table public.company_settings add column if not exists pay_qr_note text;

-- 2. the coverages
create table if not exists public.order_insurance (
  id uuid primary key default gen_random_uuid(),
  ins_no text unique,
  order_id uuid not null references public.customer_orders(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  order_no text,
  customer_name text,
  boxes integer not null default 0 check (boxes >= 0),
  order_amount numeric(14,2) not null default 0,
  box_price numeric(12,2) not null,
  rate_pct numeric(6,3) not null,
  amount numeric(14,2) not null check (amount >= 0),
  status text not null default 'unpaid' check (status in ('unpaid','review','active','rejected','cancelled')),
  pay_method text check (pay_method in ('cash','bank','gcash','check','other')),
  pay_ref text,
  proof_path text,
  proof_at timestamptz,
  proof_by_name text,
  review_note text,
  approved_by uuid references public.profiles(id) on delete set null,
  approved_by_name text,
  approved_at timestamptz,
  issued_at timestamptz,
  valid_until date,
  cv_id uuid references public.collection_vouchers(id) on delete set null,
  eva_amount numeric(14,2),      -- the amount EVA read on the payment slip
  eva_text text,                 -- what EVA read (kept for checking)
  issued_by_eva boolean not null default false,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.order_insurance add column if not exists eva_amount numeric(14,2);
alter table public.order_insurance add column if not exists eva_text text;
alter table public.order_insurance add column if not exists issued_by_eva boolean not null default false;
create index if not exists order_insurance_order_idx on public.order_insurance(order_id);
create index if not exists order_insurance_customer_idx on public.order_insurance(customer_id);
create index if not exists order_insurance_status_idx on public.order_insurance(status, valid_until);
create index if not exists order_insurance_cv_idx on public.order_insurance(cv_id);
create index if not exists order_insurance_created_by_idx on public.order_insurance(created_by);
create index if not exists order_insurance_approved_by_idx on public.order_insurance(approved_by);
create unique index if not exists order_insurance_one_open on public.order_insurance(order_id) where status in ('unpaid','review','active');
alter table public.order_insurance enable row level security;
revoke all on public.order_insurance from anon;
grant select on public.order_insurance to authenticated;
drop policy if exists "ins: read" on public.order_insurance;
create policy "ins: read" on public.order_insurance for select to authenticated using ((select public.co_can_read()));

-- the proof of payment pictures: records/insurance/<id>/…
drop policy if exists "storage records: insurance upload" on storage.objects;
create policy "storage records: insurance upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'records' and coalesce((storage.foldername(name))[1], '') = 'insurance' and ((select public.qc_can_write()) or (select public.is_admin())));
drop policy if exists "storage records: insurance delete" on storage.objects;
create policy "storage records: insurance delete" on storage.objects for delete to authenticated
  using (bucket_id = 'records' and coalesce((storage.foldername(name))[1], '') = 'insurance' and (select public.is_admin()));

-- 3. add a coverage to an order (before delivery)
create or replace function public.request_insurance(p_order uuid) returns public.order_insurance
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare o public.customer_orders; s public.company_settings; r public.order_insurance; me text := (select full_name from public.profiles where id = auth.uid()); ym text := to_char(now(), 'YYYYMM');
begin
  if not (public.qc_can_write() or public.is_admin()) then raise exception 'Not allowed'; end if;
  select * into o from public.customer_orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status not in ('pending', 'approved') or o.delivered_at is not null or o.delivery_request_at is not null then
    raise exception 'Order % is already delivered or %: insurance is added only before the delivery', o.order_no, upper(o.status);
  end if;
  if exists (select 1 from public.order_insurance where order_id = o.id and status in ('unpaid','review','active')) then
    raise exception 'Order % already has an insurance', o.order_no;
  end if;
  select * into s from public.company_settings where id = 1;
  insert into public.order_insurance (ins_no, order_id, customer_id, order_no, customer_name, boxes, order_amount, box_price, rate_pct, amount, created_by_name)
  select 'INS-' || ym || '-' || lpad(public.next_counter('INS' || ym)::text, 3, '0'), o.id, o.customer_id, o.order_no,
    (select trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) from public.customers c where c.id = o.customer_id),
    coalesce(o.total_boxes, 0), coalesce(o.total_amount, 0), coalesce(s.ins_box_price, 50), coalesce(s.ins_rate_pct, 0.5),
    round(coalesce(o.total_boxes, 0) * coalesce(s.ins_box_price, 50) + coalesce(o.total_amount, 0) * coalesce(s.ins_rate_pct, 0.5) / 100, 2), me
  returning * into r;
  return r;
end;
$$;
revoke execute on function public.request_insurance(uuid) from public, anon;
grant execute on function public.request_insurance(uuid) to authenticated;

-- 4. the proof of payment (after paying by the QR code)
create or replace function public.submit_insurance_payment(p_id uuid, p_path text, p_method text, p_ref text) returns public.order_insurance
language plpgsql security definer set search_path = '' as $$
declare r public.order_insurance; me text := (select full_name from public.profiles where id = auth.uid());
begin
  if not (public.qc_can_write() or public.is_admin()) then raise exception 'Not allowed'; end if;
  select * into r from public.order_insurance where id = p_id for update;
  if not found then raise exception 'Insurance not found'; end if;
  if r.status not in ('unpaid', 'rejected') then raise exception 'Insurance % is %: the payment cannot be changed now', r.ins_no, upper(r.status); end if;
  if coalesce(p_path, '') not like 'insurance/' || p_id || '/%' then raise exception 'Upload the proof of payment first'; end if;
  update public.order_insurance set status = 'review', proof_path = p_path, proof_at = now(), proof_by_name = me, review_note = null,
    pay_method = case when p_method in ('cash','bank','gcash','check','other') then p_method else 'gcash' end,
    pay_ref = nullif(left(trim(coalesce(p_ref, '')), 60), ''), updated_at = now()
  where id = p_id returning * into r;
  perform public.notify_user(p.id, 'Insurance ' || r.ins_no || ' payment to review', 'Order ' || r.order_no || ' · PHP ' || to_char(r.amount, 'FM999,999,990.00'), 'insurance/' || r.id)
  from public.profiles p where p.role = 'admin' and p.status = 'active';
  return r;
end;
$$;
revoke execute on function public.submit_insurance_payment(uuid, text, text, text) from public, anon;
grant execute on function public.submit_insurance_payment(uuid, text, text, text) to authenticated;

-- 5. issuing a coverage: the coverage, the expiry and the collection voucher (inside function: EMON HASAN or EVA)
create or replace function public.ins_issue(p_id uuid, p_by_name text, p_note text, p_eva boolean) returns public.order_insurance
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare r public.order_insurance; o public.customer_orders; cv uuid; ym text := to_char(now(), 'YYYYMM');
begin
  select * into r from public.order_insurance where id = p_id for update;
  select * into o from public.customer_orders where id = r.order_id;
  insert into public.collection_vouchers (cv_no, cv_date, received_from, amount, method, reference_no, note, receipt_path, created_by, created_by_name)
  values ('CV-' || ym || '-' || lpad(public.next_counter('CV' || ym)::text, 3, '0'), current_date, left(coalesce(r.customer_name, 'CUSTOMER'), 120), r.amount,
    coalesce(r.pay_method, 'gcash'), r.pay_ref, left('INSURANCE ' || r.ins_no || ' · ORDER ' || coalesce(r.order_no, '') || case when p_eva then ' · VERIFIED BY EVA AI' else '' end, 300),
    r.proof_path, auth.uid(), left(p_by_name, 120))
  returning id into cv;
  update public.order_insurance set status = 'active', review_note = nullif(left(trim(coalesce(p_note, '')), 300), ''), approved_by = case when p_eva then null else auth.uid() end,
    approved_by_name = left(p_by_name, 120), approved_at = now(), issued_at = now(), cv_id = cv, issued_by_eva = p_eva,
    valid_until = case when o.delivered_at is not null then (o.delivered_at at time zone 'Asia/Manila')::date + 15 end, updated_at = now()
  where id = p_id returning * into r;
  return r;
end;
$$;
revoke execute on function public.ins_issue(uuid, text, text, boolean) from public, anon, authenticated;

-- EMON HASAN decides: approve = the coverage is issued and the collection voucher is made by itself
create or replace function public.decide_insurance(p_id uuid, p_action text, p_note text default null) returns public.order_insurance
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare r public.order_insurance; me text := (select full_name from public.profiles where id = auth.uid());
begin
  if not public.is_admin() then raise exception 'Only EMON HASAN can approve an insurance'; end if;
  select * into r from public.order_insurance where id = p_id for update;
  if not found then raise exception 'Insurance not found'; end if;
  if r.status <> 'review' then raise exception 'Insurance % is % (only a payment waiting for review is decided)', r.ins_no, upper(r.status); end if;
  if p_action = 'reject' then
    if coalesce(trim(p_note), '') = '' then raise exception 'Write why the payment is not accepted'; end if;
    update public.order_insurance set status = 'rejected', review_note = left(trim(p_note), 300), approved_by = auth.uid(), approved_by_name = me, approved_at = now(), updated_at = now()
    where id = p_id returning * into r;
  elsif p_action = 'approve' then
    r := public.ins_issue(p_id, me, p_note, false);
  else raise exception 'Unknown action';
  end if;
  if r.created_by is distinct from auth.uid() then
    perform public.notify_user(r.created_by, 'Insurance ' || r.ins_no || case when r.status = 'active' then ' issued' else ' payment not accepted' end,
      'Order ' || r.order_no, 'insurance/' || r.id);
  end if;
  return r;
end;
$$;
revoke execute on function public.decide_insurance(uuid, text, text) from public, anon;
grant execute on function public.decide_insurance(uuid, text, text) to authenticated;

-- EVA AI read the payment slip: the amount on it is the premium → the coverage is issued at once (EMON HASAN is told and
-- sees what EVA read). Any other amount, or nothing read: it stays in review for EMON HASAN.
create or replace function public.eva_issue_insurance(p_id uuid, p_amount numeric, p_text text) returns public.order_insurance
language plpgsql security definer set search_path = '' as $$
declare r public.order_insurance; me text := (select full_name from public.profiles where id = auth.uid());
begin
  if not (public.qc_can_write() or public.is_admin()) then raise exception 'Not allowed'; end if;
  select * into r from public.order_insurance where id = p_id for update;
  if not found then raise exception 'Insurance not found'; end if;
  update public.order_insurance set eva_amount = round(p_amount, 2), eva_text = left(p_text, 2000), updated_at = now() where id = p_id returning * into r;
  if r.status <> 'review' or p_amount is null or abs(round(p_amount, 2) - r.amount) > 0.009 or position(to_char(r.amount, 'FM999999990.00') in replace(coalesce(p_text, ''), ',', '')) = 0 then
    return r; -- not matched: EMON HASAN decides
  end if;
  r := public.ins_issue(p_id, 'EVA AI (payment slip read: PHP ' || to_char(r.amount, 'FM999,999,990.00') || ') · ' || coalesce(me, ''), 'Payment verified by EVA AI', true);
  perform public.notify_user(p.id, 'Insurance ' || r.ins_no || ' issued by EVA AI', 'Payment slip read: PHP ' || to_char(r.amount, 'FM999,999,990.00') || ' · order ' || r.order_no, 'insurance/' || r.id)
  from public.profiles p where p.role = 'admin' and p.status = 'active' and p.id is distinct from auth.uid();
  return r;
end;
$$;
revoke execute on function public.eva_issue_insurance(uuid, numeric, text) from public, anon;
grant execute on function public.eva_issue_insurance(uuid, numeric, text) to authenticated;

-- EMON HASAN cancels a coverage that is not issued (gives back the proof file to delete)
create or replace function public.cancel_insurance(p_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare r public.order_insurance;
begin
  if not public.is_admin() then raise exception 'Only EMON HASAN can cancel an insurance'; end if;
  select * into r from public.order_insurance where id = p_id for update;
  if not found then raise exception 'Insurance not found'; end if;
  if r.status = 'active' then raise exception 'Insurance % is issued: it cannot be cancelled', r.ins_no; end if;
  update public.order_insurance set status = 'cancelled', updated_at = now() where id = p_id;
  return r.proof_path;
end;
$$;
revoke execute on function public.cancel_insurance(uuid) from public, anon;
grant execute on function public.cancel_insurance(uuid) to authenticated;

-- 6. the delivery sets the expiry: delivery day + 15 days
create or replace function public.ins_follow_delivery() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.delivered_at is distinct from old.delivered_at then
    update public.order_insurance set valid_until = case when new.delivered_at is null then null else (new.delivered_at at time zone 'Asia/Manila')::date + 15 end, updated_at = now()
    where order_id = new.id and status = 'active';
  end if;
  return new;
end;
$$;
revoke execute on function public.ins_follow_delivery() from public, anon, authenticated;
drop trigger if exists ins_follow_delivery on public.customer_orders;
create trigger ins_follow_delivery after update of delivered_at on public.customer_orders for each row execute function public.ins_follow_delivery();

-- 7. anyone can verify a certificate (INS-…) or an order (OR-…)
create or replace function public.verify_insurance(p_code text) returns jsonb
language sql stable security definer set search_path = '' set timezone to 'Asia/Manila' as $$
  select coalesce((select jsonb_build_object('found', true, 'ins_no', i.ins_no, 'order_no', i.order_no, 'customer', i.customer_name, 'boxes', i.boxes,
      'issued_at', i.issued_at, 'valid_until', i.valid_until, 'delivered', o.delivered_at is not null,
      'state', case when i.valid_until is null then 'VALID UNTIL 15 DAYS AFTER DELIVERY' when i.valid_until >= current_date then 'VALID' else 'EXPIRED' end)
    from public.order_insurance i join public.customer_orders o on o.id = i.order_id
    where i.status = 'active' and (upper(i.ins_no) = upper(trim(p_code)) or upper(i.order_no) = upper(trim(p_code)))
    order by i.issued_at desc limit 1), jsonb_build_object('found', false));
$$;
revoke execute on function public.verify_insurance(text) from public;
grant execute on function public.verify_insurance(text) to anon, authenticated;

select case when to_regprocedure('public.decide_insurance(uuid,text,text)') is not null
  then 'UPDATE 3.72 READY - EO-Office Insurance: add by order no, pay by QR, proof, EMON HASAN approves, certificate and collection voucher by themselves'
  else 'NOT READY - send this message to Claude' end as result;
