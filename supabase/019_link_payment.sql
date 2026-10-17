-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 2.7.3: link a customer payment to an invoice
-- A payment linked to an invoice pays that invoice first (any amount over the invoice goes to the customer's other
-- invoices). Payments that are not linked pay the oldest invoices first, as before. Linking and unlinking is done on
-- the invoice page (Link a Payment) and written in the customer's history.
-- Run once in the Supabase SQL Editor after 018_invoice_po.sql. It is safe to run again.
-- =====================================================================

create or replace view public.invoice_balances with (security_invoker = true) as
with linked as (
  select p.invoice_id, sum(p.amount)::numeric as amount
  from public.payments_received p where p.invoice_id is not null group by p.invoice_id
),
inv as (
  select i.id, i.customer_id,
    least(i.total_amount, coalesce(l.amount, 0))::numeric as direct,
    greatest(0, coalesce(l.amount, 0) - i.total_amount)::numeric as extra
  from public.customer_invoices i left join linked l on l.invoice_id = i.id
),
pool as (
  select c.id as customer_id,
    coalesce((select sum(p.amount) from public.payments_received p
              where p.customer_id = c.id and (p.invoice_id is null
                or not exists (select 1 from public.customer_invoices x where x.id = p.invoice_id and x.customer_id = c.id))), 0)
    + coalesce((select sum(x.extra) from inv x where x.customer_id = c.id), 0)
    + coalesce((select sum(m.request_amount) from public.credit_memos m
                where m.customer_id = c.id and m.status in ('approved','paid') and m.requested_action in ('credit','discount')), 0)
    + coalesce((select sum(o.amount) from public.order_letters o
                where o.customer_id = c.id and o.status = 'applied' and o.subject_type = 'settlement' and o.adjust_type = 'reduce'), 0) as amount
  from public.customers c
),
owed as (
  select c.id as customer_id, null::uuid as invoice_id, c.application_date as d, 0 as k, c.created_at as t, c.opening_balance::numeric as amount
    from public.customers c where c.opening_balance > 0
  union all
  select i.customer_id, i.id, i.invoice_date, 1, i.created_at, (i.total_amount - x.direct)::numeric
    from public.customer_invoices i join inv x on x.id = i.id
  union all
  select o.customer_id, null::uuid, (coalesce(o.applied_at, o.created_at) at time zone 'Asia/Manila')::date, 2, o.created_at, o.amount::numeric
    from public.order_letters o
    where o.customer_id is not null and o.status = 'applied'
      and (o.subject_type = 'charge' or (o.subject_type = 'settlement' and o.adjust_type = 'add'))
),
fifo as (
  select w.invoice_id, w.customer_id, w.amount,
    coalesce(sum(w.amount) over (partition by w.customer_id order by w.d, w.k, w.t, w.invoice_id
                                 rows between unbounded preceding and 1 preceding), 0) as before
  from owed w
),
paid as (
  select f.invoice_id as id, (x.direct + greatest(0, least(f.amount, coalesce(pl.amount, 0) - f.before)))::numeric(14,2) as amount
  from fifo f join inv x on x.id = f.invoice_id left join pool pl on pl.customer_id = f.customer_id
  where f.invoice_id is not null
)
select i.id, i.invoice_no, i.customer_id, i.invoice_date, i.purchase_date, i.po_number, i.total_boxes, i.total_pcs,
  i.total_amount, i.created_by, i.created_by_name, i.created_at,
  c.first_name, c.last_name, c.account_no, c.business_name, c.status as customer_status,
  pd.amount as amount_paid,
  (i.total_amount - pd.amount)::numeric(14,2) as balance,
  case when pd.amount >= i.total_amount then 'paid' when pd.amount > 0 then 'partial' else 'unpaid' end as pay_status,
  i.payment_terms,
  case when i.payment_terms ~ '^[0-9]{1,3} DAYS$' then i.invoice_date + split_part(i.payment_terms, ' ', 1)::int
       when i.payment_terms = 'CASH ON DELIVERY' then i.invoice_date end as due_date
from public.customer_invoices i
join public.customers c on c.id = i.customer_id
join paid pd on pd.id = i.id;

-- Link a payment to an invoice of the same customer (p_invoice null: unlink). Staff who record payments or invoices,
-- and the Director.
create or replace function public.link_payment(p_payment uuid, p_invoice uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.payments_received; i public.customer_invoices;
begin
  if not (public.can_write('payments') or public.can_write('invoices')) then
    raise exception 'You do not have access to link payments';
  end if;
  select * into p from public.payments_received where id = p_payment;
  if not found then raise exception 'Payment not found'; end if;
  if p_invoice is not null then
    select * into i from public.customer_invoices where id = p_invoice;
    if not found or i.customer_id <> p.customer_id then raise exception 'This invoice is not of the same customer'; end if;
  end if;
  if p.invoice_id is not distinct from p_invoice then return; end if;
  perform set_config('eo.allow_change', 'on', true);
  update public.payments_received set invoice_id = p_invoice where id = p_payment;
  insert into public.customer_events (customer_id, action, note, actor, actor_name)
  values (p.customer_id, case when p_invoice is null then 'payment unlinked' else 'payment linked' end,
          coalesce(p.receipt_no, '') || case when p_invoice is null then '' else ' → ' || i.invoice_no end,
          auth.uid(), (select full_name from public.profiles where id = auth.uid()));
  perform set_config('eo.allow_change', 'off', true);
end;
$$;
revoke execute on function public.link_payment(uuid, uuid) from public, anon;
grant execute on function public.link_payment(uuid, uuid) to authenticated;

select 'UPDATE 2.7.3 READY - payments can be linked to an invoice' as result,
  (select count(*) from public.payments_received where invoice_id is not null) as payments_already_linked;
