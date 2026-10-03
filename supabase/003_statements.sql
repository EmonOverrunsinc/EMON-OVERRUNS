-- Emon Overruns Portal, part 3: statements of account (SOA).
-- Only needed if you ran an earlier version of 002_customers_invoices_payments.sql before SOA was added.
-- Safe to run more than once.
alter table public.attachments drop constraint if exists attachments_owner_type_check;
alter table public.attachments add constraint attachments_owner_type_check check (owner_type in
  ('customer','invoice','payment','credit_memo','employee','resolution','project','project_payment','supplier','supplier_payment','statement'));

-- =====================================================================
-- Statements of account (SOA). One per customer per month, created on the 1st
-- for the month just ended. Opening balance = everything before the month;
-- closing balance becomes next month's opening. Credits count when approved.
-- =====================================================================
create table if not exists public.statements (
  id uuid primary key default gen_random_uuid(),
  statement_no text unique,
  customer_id uuid not null references public.customers(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  opening_balance numeric(14,2) not null default 0,
  total_debit numeric(14,2) not null default 0,
  total_credit numeric(14,2) not null default 0,
  closing_balance numeric(14,2) not null default 0,
  generated_at timestamptz not null default now(),
  unique (customer_id, period_start)
);
create index if not exists statements_period_idx on public.statements(period_start);
alter table public.statements enable row level security;
drop policy if exists "soa: active read" on public.statements;
create policy "soa: active read" on public.statements for select to authenticated using ((select public.is_active()));

-- Balance of a customer before a date (invoices − payments − approved credit/discount memos).
create or replace function public.balance_before(p_customer uuid, p_date date) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce((select sum(total_amount) from public.customer_invoices where customer_id = p_customer and invoice_date < p_date), 0)
       - coalesce((select sum(amount) from public.payments_received where customer_id = p_customer and paid_date < p_date), 0)
       - coalesce((select sum(request_amount) from public.credit_memos where customer_id = p_customer and status in ('approved','paid')
                   and requested_action in ('credit','discount') and approved_at::date < p_date), 0);
$$;

-- Creates any missing monthly statements up to the last complete month. Safe to call any time.
create or replace function public.generate_statements(p_customer uuid default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  c record;
  m date;
  first_m date;
  last_m date := (date_trunc('month', current_date) - interval '1 month')::date;
  stop_m date;
  nxt date;
  op numeric; deb numeric; cre numeric;
  made integer := 0;
begin
  if auth.uid() is not null and not public.is_active() then raise exception 'Not allowed'; end if;
  for c in select * from public.customers cu where cu.status in ('active','suspended','closed') and (p_customer is null or cu.id = p_customer) loop
    first_m := date_trunc('month', least(
      c.application_date,
      coalesce((select min(invoice_date) from public.customer_invoices where customer_id = c.id), c.application_date),
      coalesce((select min(paid_date) from public.payments_received where customer_id = c.id), c.application_date)))::date;
    stop_m := last_m;
    if c.status = 'closed' then
      stop_m := least(last_m, coalesce((select date_trunc('month', max(created_at))::date from public.customer_events where customer_id = c.id and action = 'close'), last_m));
    end if;
    m := first_m;
    while m <= stop_m loop
      nxt := (m + interval '1 month')::date;
      if not exists (select 1 from public.statements s where s.customer_id = c.id and s.period_start = m) then
        op := public.balance_before(c.id, m);
        deb := coalesce((select sum(total_amount) from public.customer_invoices where customer_id = c.id and invoice_date >= m and invoice_date < nxt), 0);
        cre := coalesce((select sum(amount) from public.payments_received where customer_id = c.id and paid_date >= m and paid_date < nxt), 0)
             + coalesce((select sum(request_amount) from public.credit_memos where customer_id = c.id and status in ('approved','paid')
                          and requested_action in ('credit','discount') and approved_at::date >= m and approved_at::date < nxt), 0);
        insert into public.statements (statement_no, customer_id, period_start, period_end, opening_balance, total_debit, total_credit, closing_balance)
        values ('SOA-' || to_char(m, 'YYYYMM') || '-' || c.account_no, c.id, m, (nxt - 1), op, deb, cre, op + deb - cre);
        made := made + 1;
      end if;
      m := nxt;
    end loop;
  end loop;
  return made;
end;
$$;
revoke execute on function public.balance_before(uuid, date) from public, anon;
grant execute on function public.balance_before(uuid, date) to authenticated;
revoke execute on function public.generate_statements(uuid) from public, anon;
grant execute on function public.generate_statements(uuid) to authenticated;

-- Run automatically at 00:05 on the 1st of each month (Manila time = UTC+8, so 16:05 UTC on the last day
-- would be midnight; we use 00:05 UTC on the 1st = 08:05 AM Manila). If pg_cron is not available,
-- the portal creates missing statements the next time someone opens the dashboard.
do $$
begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'emon-monthly-soa';
  perform cron.schedule('emon-monthly-soa', '5 0 1 * *', 'select public.generate_statements()');
exception when others then
  raise notice 'pg_cron not available (%); statements will be created when the portal is opened.', sqlerrm;
end $$;
