-- =====================================================================
-- EMON OVERRUNS E-PORTAL - UPDATE 3.74: RUN 080 + 081 TOGETHER
-- 080: customers see their own orders, invoices, payments and download their SOA (after agreeing)
-- 081: the order is modified as delivered (the invoice and the SOA follow); the first order stays kept
-- Needs RUN_073_TO_078.sql and 079. Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again.
-- The last lines say: UPDATE 3.74 READY ... and UPDATE 3.74 ORDERS READY ...
-- =====================================================================
-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.74: THE CUSTOMER SEES THEIR OWN HISTORY AND SOA
-- After signing in with the Public ID + Private PIN and agreeing to the Customer Agreement, the customer sees on
-- "My Account": their orders, invoices, payments, credit memos and adjustments, and downloads the Statement of Account
-- (SOA) of the current month (and of earlier months). Only their own account; nothing until they agreed.
-- Needs RUN_073_TO_078.sql. Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again.
-- The last line says: UPDATE 3.74 READY - ...
-- =====================================================================
do $$ begin
  if to_regprocedure('public.cust_signin_check(text,text)') is null then raise exception 'Run RUN_073_TO_078.sql first, then run this again.'; end if;
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
        'total_amount', i.total_amount, 'balance', i.balance, 'pay_status', i.pay_status) order by i.invoice_date desc, i.invoice_no desc)
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

select case when to_regprocedure('public.customer_history(text,text)') is not null
  then 'UPDATE 3.74 READY - customers see their own orders, invoices, payments and download their SOA after agreeing'
  else 'NOT READY - send this message to Claude' end as result;

-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.74: THE ORDER IS MODIFIED AS DELIVERED
-- When more (or fewer) pcs are delivered than ordered, the invoice is charged as delivered (3.56) AND now the order
-- itself is modified to the delivery: each line's pcs and amount become the pcs delivered x the line's price, and the
-- order totals (boxes, pcs, amount) follow. So the order, the invoice and the SOA all show the same amount.
-- * What was first ordered stays kept on each line (ordered_qty, ordered_amount) and the order page shows it.
-- * Lines with no box (e.g. a fee) and boxes without pcs stay as ordered.
-- * It runs when the order is completed, when the boxes of a completed order change, and once now for the completed
--   orders (an order whose invoice could not follow, e.g. payments linked above the delivery, stays as it is).
-- Needs 064_charge_as_delivered.sql. Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again.
-- The last line says: UPDATE 3.74 ORDERS READY - ...
-- =====================================================================
do $$ begin
  if to_regprocedure('public.co_delivered(uuid)') is null then raise exception 'Run 064_charge_as_delivered.sql first, then run this again.'; end if;
end $$;

-- a completed order's lines and totals become what was delivered (the first order stays kept on each line)
create or replace function public.co_follow_delivered(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders; d jsonb; nl jsonb;
begin
  select * into o from public.customer_orders where id = p_order;
  if not found or o.status <> 'completed' then return; end if;
  d := public.co_delivered(p_order);
  if d is null or not coalesce((d ->> 'has_pcs')::boolean, false) then return; end if;
  select coalesce(jsonb_agg(case
      when dl is null or coalesce((dl ->> 'boxes')::int, 0) = 0
        or ((dl ->> 'delivered')::numeric = coalesce(nullif(x.v ->> 'qty', '')::numeric, 0) and (dl ->> 'amount')::numeric = (dl ->> 'ordered_amount')::numeric) then x.v
      else x.v || jsonb_build_object('qty', (dl ->> 'delivered')::numeric, 'amount', (dl ->> 'amount')::numeric, 'boxes', (dl ->> 'boxes')::int,
        'ordered_qty', coalesce(x.v -> 'ordered_qty', x.v -> 'qty'), 'ordered_amount', coalesce(x.v -> 'ordered_amount', to_jsonb((dl ->> 'ordered_amount')::numeric)),
        'ordered_boxes', coalesce(x.v -> 'ordered_boxes', x.v -> 'boxes'))
    end order by x.ord), '[]'::jsonb)
  into nl
  from jsonb_array_elements(coalesce(o.lines, '[]'::jsonb)) with ordinality x(v, ord)
  left join lateral (select l from jsonb_array_elements(coalesce(d -> 'lines', '[]'::jsonb)) l where (l ->> 'i')::int = x.ord - 1 limit 1) dd(dl) on true;
  update public.customer_orders set lines = nl,
    total_pcs = round((d ->> 'pcs')::numeric)::int, total_amount = round((d ->> 'amount')::numeric, 2), total_boxes = (d ->> 'boxes')::int,
    ordered_total_amount = coalesce(ordered_total_amount, o.total_amount), ordered_total_pcs = coalesce(ordered_total_pcs, o.total_pcs),
    ordered_total_boxes = coalesce(ordered_total_boxes, o.total_boxes), updated_at = now()
  where id = p_order and (lines, total_pcs, total_amount, total_boxes) is distinct from
    (nl, round((d ->> 'pcs')::numeric)::int, round((d ->> 'amount')::numeric, 2), (d ->> 'boxes')::int);
end;
$$;
revoke execute on function public.co_follow_delivered(uuid) from public, anon, authenticated;

-- the first order's totals (kept once, when the order is first modified as delivered)
alter table public.customer_orders add column if not exists ordered_total_amount numeric(14,2);
alter table public.customer_orders add column if not exists ordered_total_pcs integer;
alter table public.customer_orders add column if not exists ordered_total_boxes integer;

-- the invoice charged as delivered (3.56), then the order modified as delivered (3.74)
create or replace function public.co_charge_as_delivered(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders; d jsonb; amt numeric; linked numeric;
begin
  select * into o from public.customer_orders where id = p_order;
  if not found or o.status <> 'completed' or o.invoice_id is null then return; end if;
  d := public.co_delivered(p_order);
  amt := (d ->> 'amount')::numeric;
  select coalesce(sum(amount), 0) into linked from public.payment_links where invoice_id = o.invoice_id and removed_at is null;
  if linked > amt then
    raise exception 'Payments of PHP % are linked to the invoice of order %: the delivery (PHP %) cannot be charged less than that',
      to_char(linked, 'FM999,999,990.00'), o.order_no, to_char(amt, 'FM999,999,990.00');
  end if;
  perform public.allow_record_change();
  update public.customer_invoices set total_amount = amt, total_pcs = round((d ->> 'pcs')::numeric)::int,
    total_boxes = case when (d ->> 'has_pcs')::boolean then (d ->> 'boxes')::int else o.total_boxes end
  where id = o.invoice_id and (total_amount, total_pcs, total_boxes) is distinct from
    (amt, round((d ->> 'pcs')::numeric)::int, case when (d ->> 'has_pcs')::boolean then (d ->> 'boxes')::int else o.total_boxes end);
  perform set_config('eo.allow_change', 'off', true);
  perform public.co_follow_delivered(p_order); -- 3.74: the order is modified as delivered
end;
$$;
revoke execute on function public.co_charge_as_delivered(uuid) from public, anon, authenticated;

-- the orders completed before: modified as delivered now (one that cannot follow stays as it is)
create temp table if not exists follow_result (line text);
truncate follow_result;
do $$
declare r record; before numeric; after numeric;
begin
  for r in select o.id, o.order_no, o.total_amount from public.customer_orders o where o.status = 'completed' and o.invoice_id is not null order by o.order_no loop
    begin
      perform public.co_charge_as_delivered(r.id);
      select total_amount into after from public.customer_orders where id = r.id;
      if after is distinct from r.total_amount then
        insert into follow_result values (r.order_no || '  ORDER PHP ' || to_char(r.total_amount, 'FM999,999,990.00') || ' -> ' || to_char(after, 'FM999,999,990.00') || ' (as delivered)');
      end if;
    exception when others then
      insert into follow_result values (r.order_no || '  NOT CHANGED: ' || sqlerrm);
    end;
  end loop;
end $$;
select line as result from follow_result
union all
select case when position('co_follow_delivered' in pg_get_functiondef('public.co_charge_as_delivered(uuid)'::regprocedure)) > 0
  then 'UPDATE 3.74 ORDERS READY - the order is modified as delivered; the invoice and the SOA follow (' || (select count(*) from follow_result where line like '%as delivered%') || ' order(s) changed now)'
  else 'NOT READY - send this message to Claude' end;
