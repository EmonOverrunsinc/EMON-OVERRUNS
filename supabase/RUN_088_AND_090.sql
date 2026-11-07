-- =====================================================================
-- EMON OVERRUNS E-PORTAL - UPDATE 3.88: RUN 088 AND 090 TOGETHER (safe to run again, also if one was run before)
-- 088: CASH ON DELIVERY is written COD (the saved invoices and orders too; a COD invoice is due on its invoice date)
-- 090: order tracking like a courier (created, confirmed, sorting, preparing, assigned, out for delivery, delivered,
--      completed, proof of delivery); the customer sees it on My Account
-- Paste all of it in Supabase > SQL Editor > New query and press Run.
-- The last line says: UPDATE 3.88 READY ...
-- =====================================================================
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.84: CASH ON DELIVERY IS WRITTEN "COD"
-- The terms of payment CASH ON DELIVERY are now COD everywhere: on the invoices and orders already saved, and for the
-- new ones. A COD invoice is due on its invoice date, as before (an old CASH ON DELIVERY counts the same).
-- Needs 083_insurance_due_extension.sql. Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again.
-- The last line says: UPDATE 3.84 READY - ...
-- =====================================================================
do $$ begin
  if to_regclass('public.invoice_balances') is null then raise exception 'Run the earlier updates first, then run this again.'; end if;
end $$;

-- 1. the invoice's due date: COD = the invoice date (the view is changed only in that one place)
do $$
declare def text := pg_get_viewdef('public.invoice_balances'::regclass);
begin
  if position('''COD''' in def) = 0 then
    if position('i.payment_terms = ''CASH ON DELIVERY''::text' in def) = 0 then raise exception 'Update 3.84: invoice_balances has changed - send this message to Claude'; end if;
    def := replace(def, 'i.payment_terms = ''CASH ON DELIVERY''::text', 'i.payment_terms = ANY (ARRAY[''COD''::text, ''CASH ON DELIVERY''::text])');
    execute 'create or replace view public.invoice_balances with (security_invoker = true) as ' || def;
  end if;
end $$;

-- 2. the invoices and orders already saved with CASH ON DELIVERY: COD
do $$ begin
  perform public.allow_record_change();
  update public.customer_invoices set payment_terms = 'COD' where payment_terms = 'CASH ON DELIVERY';
  perform set_config('eo.allow_change', 'off', true);
  update public.customer_orders set payment_terms = 'COD' where payment_terms = 'CASH ON DELIVERY';
end $$;

notify pgrst, 'reload schema';

select case when position('''COD''' in pg_get_viewdef('public.invoice_balances'::regclass)) > 0
    and not exists (select 1 from public.customer_invoices where payment_terms = 'CASH ON DELIVERY')
    and not exists (select 1 from public.customer_orders where payment_terms = 'CASH ON DELIVERY')
  then 'UPDATE 3.84 READY - CASH ON DELIVERY is now COD (' || (select count(*) from public.customer_invoices where payment_terms = 'COD') || ' COD invoice(s))'
  else 'NOT READY - send this message to Claude' end as result;

-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.88: ORDER TRACKING (LIKE A COURIER)
-- Every customer order shows its tracking, step by step, with the date, the time and who did it:
--   1 ORDER CREATED -> 2 CONFIRMED (approved by EMON HASAN) -> 3 SORTING -> 4 PREPARING -> 5 ASSIGNED FOR DELIVERY (the
--   employee who delivers) -> 6 OUT FOR DELIVERY -> 7 DELIVERED -> 8 COMPLETED -> PROOF OF DELIVERY (the photos, optional)
-- Steps 3 to 6 are pressed on the order page (after EMON HASAN's approval, before it is completed); the others come by
-- themselves from the order. The employee who is assigned is told. The customer sees the tracking on "My Account".
-- Needs 086_insurance_on_statement.sql. Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again.
-- The last line says: UPDATE 3.88 READY - ...
-- =====================================================================
do $$ begin
  if to_regprocedure('public.co_can_read()') is null or to_regprocedure('public.customer_history(text,text)') is null then
    raise exception 'Run the earlier updates first, then run this again.';
  end if;
end $$;

-- 1. the tracking steps of an order (kept as they were pressed: date, time and who)
create table if not exists public.order_tracking (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.customer_orders(id) on delete cascade,
  step text not null check (step in ('sorting', 'preparing', 'assigned', 'out_for_delivery')),
  at timestamptz not null default now(),
  by_id uuid,
  by_name text,
  employee_id uuid references public.employees(id) on delete set null,
  employee_name text,
  note text
);
create index if not exists order_tracking_order on public.order_tracking (order_id, at);
alter table public.order_tracking enable row level security;
revoke all on public.order_tracking from anon;
revoke insert, update, delete, truncate on public.order_tracking from authenticated;
grant select on public.order_tracking to authenticated;
drop policy if exists "order tracking: read" on public.order_tracking;
create policy "order tracking: read" on public.order_tracking for select to authenticated using ((select public.co_can_read()));

-- 2. a step pressed on the order page: SORTING, PREPARING, ASSIGNED (with the employee) or OUT FOR DELIVERY
create or replace function public.order_track(p_order uuid, p_step text, p_employee uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders; e public.employees; r public.order_tracking; me text;
begin
  if not public.qc_can_write() then raise exception 'You cannot update the tracking of an order.'; end if;
  if p_step is null or p_step not in ('sorting', 'preparing', 'assigned', 'out_for_delivery') then raise exception 'Unknown tracking step.'; end if;
  select * into o from public.customer_orders where id = p_order;
  if not found then raise exception 'Order not found.'; end if;
  if o.status <> 'approved' then
    raise exception 'Order % is %: the tracking steps are pressed after EMON HASAN approves the order and before it is completed.', o.order_no, upper(o.status);
  end if;
  if p_step = 'assigned' then
    select * into e from public.employees where id = p_employee;
    if not found or e.status = 'terminated' then raise exception 'Choose the employee who delivers the order.'; end if;
  end if;
  me := coalesce((select p.full_name from public.profiles p where p.id = auth.uid()), '');
  insert into public.order_tracking (order_id, step, by_id, by_name, employee_id, employee_name, note)
  values (p_order, p_step, auth.uid(), left(me, 120), e.id,
          case when e.id is not null then left(btrim(coalesce(e.first_name, '') || ' ' || coalesce(e.last_name, '')), 120) end,
          nullif(left(btrim(coalesce(p_note, '')), 300), ''))
  returning * into r;
  if p_step = 'assigned' and e.profile_id is not null then
    perform public.notify_user(e.profile_id, 'Delivery assigned to you: ' || o.order_no,
      'Order ' || o.order_no || ' · ' || coalesce(o.total_boxes, 0) || ' box(es)' || coalesce(' · ' || r.note, ''), 'custorder/' || o.id);
  end if;
  return to_jsonb(r);
end;
$$;
revoke execute on function public.order_track(uuid, text, uuid, text) from public, anon;
grant execute on function public.order_track(uuid, text, uuid, text) to authenticated;

-- 3. the customer's "My Account": each order with its tracking
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
        'total_boxes', o.total_boxes, 'total_pcs', o.total_pcs, 'total_amount', o.total_amount, 'delivered_at', o.delivered_at,
        'approved_at', o.approved_at, 'completed_at', o.completed_at, 'proof_photos', coalesce(cardinality(o.delivery_photos), 0),
        'tracking', (select jsonb_agg(jsonb_build_object('step', t.step, 'at', t.at, 'employee', t.employee_name) order by t.at)
                     from public.order_tracking t where t.order_id = o.id)) order by o.order_date desc, o.order_no desc)
      from public.customer_orders o where o.customer_id = c.id and o.status <> 'cancelled'), '[]'::jsonb));
end;
$$;
revoke execute on function public.customer_history(text, text) from public;
grant execute on function public.customer_history(text, text) to anon, authenticated;

notify pgrst, 'reload schema';

select case when to_regprocedure('public.order_track(uuid,text,uuid,text)') is not null
    and position('order_tracking' in pg_get_functiondef('public.customer_history(text,text)'::regprocedure)) > 0
  then 'UPDATE 3.88 READY - order tracking: created, confirmed, sorting, preparing, assigned, out for delivery, delivered, completed, proof of delivery'
  else 'NOT READY - send this message to Claude' end as result;

select case when position('''COD''' in pg_get_viewdef('public.invoice_balances'::regclass)) > 0
    and not exists (select 1 from public.customer_invoices where payment_terms = 'CASH ON DELIVERY')
    and to_regprocedure('public.order_track(uuid,text,uuid,text)') is not null
    and position('order_tracking' in pg_get_functiondef('public.customer_history(text,text)'::regprocedure)) > 0
  then 'UPDATE 3.88 READY - COD, and the order tracking (created, confirmed, sorting, preparing, assigned, out for delivery, delivered, completed, proof of delivery)'
  else 'NOT READY - send this message to Claude' end as result;
