-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.19: how a credit memo is settled
-- The customer chooses how the money goes back: ACCOUNT CREDIT (taken off the customer's balance, as before),
-- BANK TRANSFER or CASH (the money is handed back, so the balance does not change - like a refund).
-- Old credit memos have no choice saved and stay ACCOUNT CREDIT.
-- Run once in the Supabase SQL Editor after 030_delete_history.sql. It is safe to run again.
-- =====================================================================

alter table public.credit_memos add column if not exists settle_by text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'credit_memos_settle_by_check') then
    alter table public.credit_memos add constraint credit_memos_settle_by_check check (settle_by in ('account_credit', 'bank_transfer', 'cash'));
  end if;
end $$;
-- true when the memo is taken off the customer's balance: an approved credit or discount settled as account credit
alter table public.credit_memos add column if not exists off_balance boolean
  generated always as (requested_action in ('credit', 'discount') and coalesce(settle_by, 'account_credit') = 'account_credit') stored;


-- the balance and the statement count only the memos taken off the balance

CREATE OR REPLACE FUNCTION public.account_due(p_customer uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET "TimeZone" TO 'Asia/Manila'
AS $function$
  with paid as (
    select coalesce((select sum(p.amount) from public.payments_received p where p.customer_id = p_customer), 0)
         + coalesce((select sum(m.request_amount) from public.credit_memos m where m.customer_id = p_customer and m.status in ('approved','paid')
                       and m.off_balance), 0)
         + coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = p_customer and o.status = 'applied' and o.subject_type = 'settlement' and o.adjust_type = 'reduce'), 0) as total
  ), inv as (
    select x.invoice_no, x.invoice_date, x.is_inv, sum(x.amount) over (order by x.invoice_date, x.at, x.invoice_no) as running
    from (select 'Opening Balance' as invoice_no, c.application_date as invoice_date, c.created_at as at, c.opening_balance as amount, false as is_inv
          from public.customers c where c.id = p_customer and c.opening_balance > 0
          union all
          select i.invoice_no, i.invoice_date, i.created_at as at, i.total_amount as amount, true from public.customer_invoices i where i.customer_id = p_customer
          union all
          select o.order_no, o.applied_at::date, o.applied_at, o.amount, false from public.order_letters o
          where o.customer_id = p_customer and o.status = 'applied' and (o.subject_type = 'charge' or (o.subject_type = 'settlement' and o.adjust_type = 'add'))) x
  ), other as (
    select inv.invoice_no, inv.invoice_date from inv, paid where inv.running > paid.total and not inv.is_inv order by inv.running limit 1
  ), unpaid as (
    select b.invoice_no, b.invoice_date from public.invoice_balances b
    where b.customer_id = p_customer and b.balance > 0.004 order by b.invoice_date, b.created_at limit 1
  ), oldest as (
    select x.invoice_no, x.invoice_date from (select * from other union all select * from unpaid) x order by x.invoice_date limit 1
  )
  select jsonb_build_object(
    'balance_due', coalesce((select b.balance_due from public.customer_balances b where b.customer_id = p_customer), 0),
    'days_overdue', coalesce((select greatest(0, current_date - o.invoice_date) from oldest o), 0),
    'oldest_invoice_no', (select o.invoice_no from oldest o),
    'oldest_invoice_date', (select o.invoice_date from oldest o))
  where public.is_active();
$function$;

CREATE OR REPLACE FUNCTION public.balance_before(p_customer uuid, p_date date)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET "TimeZone" TO 'Asia/Manila'
AS $function$
  select coalesce((select c.opening_balance from public.customers c where c.id = p_customer and c.application_date < p_date), 0)
       + coalesce((select sum(total_amount) from public.customer_invoices where customer_id = p_customer and invoice_date < p_date), 0)
       + coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = p_customer and o.status = 'applied' and (o.subject_type = 'charge' or (o.subject_type = 'settlement' and o.adjust_type = 'add')) and o.applied_at::date < p_date), 0)
       - coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = p_customer and o.status = 'applied' and o.subject_type = 'settlement' and o.adjust_type = 'reduce' and o.applied_at::date < p_date), 0)
       - coalesce((select sum(amount) from public.payments_received where customer_id = p_customer and paid_date < p_date), 0)
       - coalesce((select sum(request_amount) from public.credit_memos where customer_id = p_customer and status in ('approved','paid')
                   and off_balance and approved_at::date < p_date), 0);
$function$;

CREATE OR REPLACE FUNCTION public.statement_amounts(p_customer uuid, p_month date, OUT opening numeric, OUT debit numeric, OUT credit numeric)
 RETURNS record
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET "TimeZone" TO 'Asia/Manila'
AS $function$
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
                 and x.off_balance and x.approved_at::date < nxt and (lo is null or x.approved_at::date >= lo)), 0)
    + coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = c.id and o.status = 'applied'
                 and o.subject_type = 'settlement' and o.adjust_type = 'reduce'
                 and o.applied_at::date < nxt and (lo is null or o.applied_at::date >= lo)), 0);
end;
$function$;


-- an invoice is corrected only by the memos taken off the balance

CREATE OR REPLACE FUNCTION public.fit_invoice_links(p_invoice uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare cap numeric; over numeric; l public.payment_links; why text := 'E-Portal (the invoice now needs less)';
begin
  select i.total_amount - coalesce((select sum(m.request_amount) from public.credit_memos m
           where m.invoice_id = i.id and m.status in ('approved','paid') and m.off_balance), 0)
    into cap from public.customer_invoices i where i.id = p_invoice;
  if cap is null then return; end if;
  over := coalesce((select sum(amount) from public.payment_links where invoice_id = p_invoice and removed_at is null), 0) - greatest(cap, 0);
  while over > 0.004 loop
    select * into l from public.payment_links where invoice_id = p_invoice and removed_at is null order by linked_at desc, id desc limit 1;
    exit when not found;
    update public.payment_links set removed_at = now(), removed_by_name = why where id = l.id;
    if l.amount > over then
      insert into public.payment_links (payment_id, invoice_id, customer_id, amount, linked_by_name)
      values (l.payment_id, l.invoice_id, l.customer_id, l.amount - over, why);
    end if;
    insert into public.customer_events (customer_id, action, note, actor_name)
    values (l.customer_id, 'payment link changed',
            coalesce((select receipt_no from public.payments_received where id = l.payment_id), '') || ' → '
              || coalesce((select invoice_no from public.customer_invoices where id = l.invoice_id), '') || ' · PHP '
              || to_char(l.amount, 'FM999,999,990.00') || ' now PHP ' || to_char(greatest(l.amount - over, 0), 'FM999,999,990.00'), why);
    over := over - l.amount;
  end loop;
end;
$function$;

CREATE OR REPLACE FUNCTION public.link_payment(p_payment uuid, p_invoice uuid, p_amount numeric DEFAULT NULL::numeric)
 RETURNS payment_links
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare p public.payments_received; i public.customer_invoices; l public.payment_links; me text; avail numeric; need numeric; amt numeric;
begin
  if not (public.can_write('payments') or public.can_write('invoices')) then
    raise exception 'You do not have access to link payments';
  end if;
  select * into p from public.payments_received where id = p_payment for update;
  if not found then raise exception 'Payment not found'; end if;
  me := (select full_name from public.profiles where id = auth.uid());
  if p_invoice is null then
    for l in select * from public.payment_links where payment_id = p_payment and removed_at is null loop
      perform public.unlink_payment(l.id);
    end loop;
    return null;
  end if;
  select * into i from public.customer_invoices where id = p_invoice;
  if not found or i.customer_id <> p.customer_id then raise exception 'This invoice is not of the same customer'; end if;
  avail := p.amount - coalesce((select sum(amount) from public.payment_links where payment_id = p_payment and removed_at is null), 0);
  need := i.total_amount
    - coalesce((select sum(m.request_amount) from public.credit_memos m
                where m.invoice_id = i.id and m.status in ('approved','paid') and m.off_balance), 0)
    - coalesce((select sum(amount) from public.payment_links where invoice_id = i.id and removed_at is null), 0);
  if avail <= 0 then raise exception 'Receipt % is already fully linked', p.receipt_no; end if;
  if need <= 0 then raise exception 'Invoice % is already fully paid by linked payments', i.invoice_no; end if;
  amt := coalesce(p_amount, least(avail, need));
  if amt <= 0 then raise exception 'Enter the amount to link'; end if;
  if amt > avail then raise exception 'Only PHP % of receipt % is available', to_char(avail, 'FM999,999,990.00'), p.receipt_no; end if;
  if amt > need then raise exception 'Invoice % needs only PHP %', i.invoice_no, to_char(need, 'FM999,999,990.00'); end if;
  insert into public.payment_links (payment_id, invoice_id, customer_id, amount, linked_by, linked_by_name)
  values (p.id, i.id, p.customer_id, amt, auth.uid(), me)
  returning * into l;
  insert into public.customer_events (customer_id, action, note, actor, actor_name)
  values (p.customer_id, 'payment linked',
          coalesce(p.receipt_no, '') || ' → ' || i.invoice_no || ' · PHP ' || to_char(amt, 'FM999,999,990.00'), auth.uid(), me);
  return l;
end;
$function$;

create or replace view public.customer_balances with (security_invoker = true) as
SELECT id AS customer_id,
    COALESCE(( SELECT sum(i.total_amount) AS sum
           FROM customer_invoices i
          WHERE i.customer_id = c.id), 0::numeric)::numeric(14,2) AS total_invoiced,
    COALESCE(( SELECT sum(p.amount) AS sum
           FROM payments_received p
          WHERE p.customer_id = c.id), 0::numeric)::numeric(14,2) AS total_paid,
    COALESCE(( SELECT sum(m.request_amount) AS sum
           FROM credit_memos m
          WHERE m.customer_id = c.id AND (m.status = ANY (ARRAY['approved'::text, 'paid'::text])) AND m.off_balance), 0::numeric)::numeric(14,2) AS total_credits,
    (opening_balance + COALESCE(( SELECT sum(i.total_amount) AS sum
           FROM customer_invoices i
          WHERE i.customer_id = c.id), 0::numeric) + COALESCE(( SELECT sum(o.amount) AS sum
           FROM order_letters o
          WHERE o.customer_id = c.id AND o.status = 'applied'::text AND (o.subject_type = 'charge'::text OR o.subject_type = 'settlement'::text AND o.adjust_type = 'add'::text)), 0::numeric) - COALESCE(( SELECT sum(p.amount) AS sum
           FROM payments_received p
          WHERE p.customer_id = c.id), 0::numeric) - COALESCE(( SELECT sum(m.request_amount) AS sum
           FROM credit_memos m
          WHERE m.customer_id = c.id AND (m.status = ANY (ARRAY['approved'::text, 'paid'::text])) AND m.off_balance), 0::numeric) - COALESCE(( SELECT sum(o.amount) AS sum
           FROM order_letters o
          WHERE o.customer_id = c.id AND o.status = 'applied'::text AND o.subject_type = 'settlement'::text AND o.adjust_type = 'reduce'::text), 0::numeric))::numeric(14,2) AS balance_due,
    COALESCE(( SELECT sum(o.amount) AS sum
           FROM order_letters o
          WHERE o.customer_id = c.id AND o.status = 'applied'::text AND o.subject_type = 'charge'::text), 0::numeric)::numeric(14,2) AS total_charges,
    COALESCE(( SELECT sum(
                CASE o.adjust_type
                    WHEN 'reduce'::text THEN - o.amount
                    ELSE o.amount
                END) AS sum
           FROM order_letters o
          WHERE o.customer_id = c.id AND o.status = 'applied'::text AND o.subject_type = 'settlement'::text), 0::numeric)::numeric(14,2) AS total_settlement,
    opening_balance
   FROM customers c;

create or replace view public.invoice_balances with (security_invoker = true) as
WITH lp AS (
         SELECT l.invoice_id,
            sum(l.amount) AS amount
           FROM payment_links l
          WHERE l.removed_at IS NULL
          GROUP BY l.invoice_id
        ), lr AS (
         SELECT m.invoice_id,
            sum(m.request_amount) AS amount
           FROM credit_memos m
          WHERE m.invoice_id IS NOT NULL AND (m.status = ANY (ARRAY['approved'::text, 'paid'::text])) AND m.off_balance
          GROUP BY m.invoice_id
        ), inv AS (
         SELECT i_1.id,
            i_1.customer_id,
            i_1.total_amount,
            LEAST(i_1.total_amount, COALESCE(r.amount, 0::numeric)) AS ret,
            GREATEST(0::numeric, COALESCE(r.amount, 0::numeric) - i_1.total_amount) AS ret_extra,
            COALESCE(l.amount, 0::numeric) AS lpay
           FROM customer_invoices i_1
             LEFT JOIN lp l ON l.invoice_id = i_1.id
             LEFT JOIN lr r ON r.invoice_id = i_1.id
        ), inv2 AS (
         SELECT x.id,
            x.customer_id,
            x.total_amount,
            x.ret,
            x.ret_extra,
            x.lpay,
            LEAST(x.total_amount - x.ret, x.lpay) AS direct,
            GREATEST(0::numeric, x.lpay - (x.total_amount - x.ret)) + x.ret_extra AS extra
           FROM inv x
        ), pool AS (
         SELECT c_1.id AS customer_id,
            COALESCE(( SELECT sum(p.amount) AS sum
                   FROM payments_received p
                  WHERE p.customer_id = c_1.id), 0::numeric) - COALESCE(( SELECT sum(l.amount) AS sum
                   FROM payment_links l
                     JOIN payments_received p ON p.id = l.payment_id AND p.customer_id = c_1.id
                     JOIN customer_invoices x ON x.id = l.invoice_id AND x.customer_id = c_1.id
                  WHERE l.removed_at IS NULL), 0::numeric) + COALESCE(( SELECT sum(x.extra) AS sum
                   FROM inv2 x
                  WHERE x.customer_id = c_1.id), 0::numeric) + COALESCE(( SELECT sum(m.request_amount) AS sum
                   FROM credit_memos m
                  WHERE m.customer_id = c_1.id AND (m.status = ANY (ARRAY['approved'::text, 'paid'::text])) AND m.off_balance AND (m.invoice_id IS NULL OR NOT (EXISTS ( SELECT 1
                           FROM customer_invoices x
                          WHERE x.id = m.invoice_id AND x.customer_id = c_1.id)))), 0::numeric) + COALESCE(( SELECT sum(o.amount) AS sum
                   FROM order_letters o
                  WHERE o.customer_id = c_1.id AND o.status = 'applied'::text AND o.subject_type = 'settlement'::text AND o.adjust_type = 'reduce'::text), 0::numeric) AS amount
           FROM customers c_1
        ), owed AS (
         SELECT c_1.id AS customer_id,
            NULL::uuid AS invoice_id,
            c_1.application_date AS d,
            0 AS k,
            c_1.created_at AS t,
            c_1.opening_balance::numeric AS amount
           FROM customers c_1
          WHERE c_1.opening_balance > 0::numeric
        UNION ALL
         SELECT i_1.customer_id,
            i_1.id,
            i_1.invoice_date,
            1,
            i_1.created_at,
            i_1.total_amount - x.ret - x.direct AS "numeric"
           FROM customer_invoices i_1
             JOIN inv2 x ON x.id = i_1.id
        UNION ALL
         SELECT o.customer_id,
            NULL::uuid AS uuid,
            (COALESCE(o.applied_at, o.created_at) AT TIME ZONE 'Asia/Manila'::text)::date AS timezone,
            2,
            o.created_at,
            o.amount::numeric AS amount
           FROM order_letters o
          WHERE o.customer_id IS NOT NULL AND o.status = 'applied'::text AND (o.subject_type = 'charge'::text OR o.subject_type = 'settlement'::text AND o.adjust_type = 'add'::text)
        ), fifo AS (
         SELECT w.invoice_id,
            w.customer_id,
            w.amount,
            COALESCE(sum(w.amount) OVER (PARTITION BY w.customer_id ORDER BY w.d, w.k, w.t, w.invoice_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0::numeric) AS before,
            sum(w.amount) OVER (PARTITION BY w.customer_id) AS total
           FROM owed w
        ), newest AS (
         SELECT DISTINCT ON (i_1.customer_id) i_1.customer_id,
            i_1.id
           FROM customer_invoices i_1
          ORDER BY i_1.customer_id, i_1.invoice_date DESC, i_1.created_at DESC, i_1.id DESC
        ), paid AS (
         SELECT f.invoice_id AS id,
            x.ret,
            (x.direct + GREATEST(0::numeric, LEAST(f.amount, COALESCE(pl.amount, 0::numeric) - f.before)) +
                CASE
                    WHEN nw.id = f.invoice_id THEN GREATEST(0::numeric, COALESCE(pl.amount, 0::numeric) - f.total)
                    ELSE 0::numeric
                END)::numeric(14,2) AS amount
           FROM fifo f
             JOIN inv2 x ON x.id = f.invoice_id
             LEFT JOIN pool pl ON pl.customer_id = f.customer_id
             LEFT JOIN newest nw ON nw.customer_id = f.customer_id
          WHERE f.invoice_id IS NOT NULL
        )
 SELECT i.id,
    i.invoice_no,
    i.customer_id,
    i.invoice_date,
    i.purchase_date,
    i.po_number,
    i.total_boxes,
    i.total_pcs,
    i.total_amount,
    i.created_by,
    i.created_by_name,
    i.created_at,
    c.first_name,
    c.last_name,
    c.account_no,
    c.business_name,
    c.status AS customer_status,
    pd.amount AS amount_paid,
    (i.total_amount - pd.ret - pd.amount)::numeric(14,2) AS balance,
        CASE
            WHEN (pd.ret + pd.amount) >= i.total_amount THEN 'paid'::text
            WHEN (pd.ret + pd.amount) > 0::numeric THEN 'partial'::text
            ELSE 'unpaid'::text
        END AS pay_status,
    i.payment_terms,
        CASE
            WHEN i.payment_terms ~ '^[0-9]{1,3} DAYS$'::text THEN i.invoice_date + split_part(i.payment_terms, ' '::text, 1)::integer
            WHEN i.payment_terms = 'CASH ON DELIVERY'::text THEN i.invoice_date
            ELSE NULL::date
        END AS due_date,
    pd.ret::numeric(14,2) AS amount_returned
   FROM customer_invoices i
     JOIN customers c ON c.id = i.customer_id
     JOIN paid pd ON pd.id = i.id;


select 'UPDATE 3.19 READY - credit memo settled by Account Credit, Bank Transfer or Cash' as result;
