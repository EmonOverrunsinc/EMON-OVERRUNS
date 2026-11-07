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
