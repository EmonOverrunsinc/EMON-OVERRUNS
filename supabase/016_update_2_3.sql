-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 2.3: customer account numbers and application numbers
-- 1. Account number = the first letters of the first and last name + the year and month of the account's opening date +
--    a serial for all customers (001, 002, 003 ... never started again), for example MV-202606001. It is made once,
--    when the customer is saved, and is locked for good: nobody can change it (not even the main Director, and a new
--    opening date does not change it). A serial is used once only: a deleted customer's number is never given again.
-- 2. Application number = EO-<year>-<5 random digits>, for example EO-2026-48213: easy to remember and to search, and
--    different for every customer. It is also locked, and never given again.
-- 3. The customers saved so far get the new numbers once (serials in the Director's order: MV 001, PR 002, RR 003,
--    KC 004, NW 005, SA 006), with their monthly statement numbers.
-- Run once in the Supabase SQL Editor after 015_update_2_2.sql. It is safe to run again.
-- =====================================================================

-- ---------- every number ever given (never deleted, so never given twice) ----------
create table if not exists public.issued_numbers (
  number text primary key,
  kind text not null check (kind in ('account', 'application')),
  issued_at timestamptz not null default now()
);
alter table public.issued_numbers enable row level security;
revoke all on public.issued_numbers from anon, authenticated;

-- ---------- 3. the customers saved so far (once, before the numbers are locked) ----------
do $$
declare r record; n int := 0; app text; acct text;
begin
  if exists (select 1 from public.issued_numbers) then return; end if; -- done before
  perform public.allow_record_change();
  for r in
    select c.* from public.customers c
    order by case left(c.account_no, 2) when 'MV' then 1 when 'PR' then 2 when 'RR' then 3 when 'KC' then 4 when 'NW' then 5 when 'SA' then 6 else 7 end,
             c.application_date, c.created_at
  loop
    n := n + 1;
    acct := left(r.account_no, 2) || '-' || to_char(r.application_date, 'YYYYMM') || lpad(n::text, 3, '0');
    loop
      app := 'EO-' || to_char(r.application_date, 'YYYY') || '-' || lpad((10000 + floor(random() * 90000))::int::text, 5, '0');
      exit when not exists (select 1 from public.issued_numbers where number = app) and not exists (select 1 from public.customers where application_no = app);
    end loop;
    update public.statements set statement_no = replace(statement_no, r.account_no, acct) where customer_id = r.id;
    update public.notifications set body = replace(body, r.account_no, acct) where body like '%' || r.account_no || '%';
    update public.notifications set title = replace(title, r.application_no, app) where title like '%' || r.application_no || '%';
    update public.order_letters set applied_result = replace(applied_result, r.account_no, acct) where customer_id = r.id and applied_result like '%' || r.account_no || '%';
    update public.customers set account_no = acct, application_no = app where id = r.id;
    insert into public.issued_numbers (number, kind) values (acct, 'account'), (app, 'application');
  end loop;
  insert into public.doc_counters (prefix, last_no) values ('ACCOUNT', n)
    on conflict (prefix) do update set last_no = greatest(public.doc_counters.last_no, excluded.last_no);
end $$;

-- ---------- 1 and 2. the numbers of a new customer ----------
create or replace function public.customers_before_insert() returns trigger
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare
  d date := coalesce(new.application_date, current_date);
  initials text := upper(left(regexp_replace(new.first_name, '[^A-Za-z]', '', 'g'), 1) || left(regexp_replace(new.last_name, '[^A-Za-z]', '', 'g'), 1));
  app text;
begin
  if initials = '' or initials is null then initials := 'XX'; end if;
  -- the serial for all customers: never started again and never given twice
  new.account_no := initials || '-' || to_char(d, 'YYYYMM') || lpad(public.next_counter('ACCOUNT')::text, 3, '0');
  loop
    app := 'EO-' || to_char(d, 'YYYY') || '-' || lpad((10000 + floor(random() * 90000))::int::text, 5, '0');
    exit when not exists (select 1 from public.issued_numbers where number = app);
  end loop;
  new.application_no := app;
  insert into public.issued_numbers (number, kind) values (new.account_no, 'account'), (app, 'application');
  new.status := 'pending';
  new.issued_by := auth.uid();
  new.issued_by_name := (select full_name from public.profiles where id = auth.uid());
  new.reviewed_by := null;
  new.reviewed_at := null;
  new.facebook_verified := coalesce(new.facebook_verified, false);
  new.public_id := public.customer_public_id(to_jsonb(new) - 'public_id');
  return new;
end;
$$;
revoke execute on function public.customers_before_insert() from public, anon, authenticated;

-- ---------- the numbers are locked ----------
create or replace function public.customers_numbers_locked() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.account_no is distinct from old.account_no then
    raise exception 'The account number % is locked and cannot be changed', old.account_no;
  end if;
  if new.application_no is distinct from old.application_no then
    raise exception 'The application number % is locked and cannot be changed', old.application_no;
  end if;
  return new;
end;
$$;
revoke execute on function public.customers_numbers_locked() from public, anon, authenticated;
drop trigger if exists customers_numbers_locked on public.customers;
create trigger customers_numbers_locked before update of account_no, application_no on public.customers
  for each row execute function public.customers_numbers_locked();

-- ---------- the numbers shown on the New Customer form before it is saved ----------
create or replace function public.preview_customer_numbers(p_first text, p_last text) returns jsonb
language sql stable security definer set search_path = '' set timezone to 'Asia/Manila' as $$
  select jsonb_build_object(
    'account_no', coalesce(nullif(upper(left(regexp_replace(coalesce(p_first, ''), '[^A-Za-z]', '', 'g'), 1) || left(regexp_replace(coalesce(p_last, ''), '[^A-Za-z]', '', 'g'), 1)), ''), 'XX')
                  || '-' || to_char(current_date, 'YYYYMM')
                  || lpad((coalesce((select d.last_no from public.doc_counters d where d.prefix = 'ACCOUNT'), 0) + 1)::text, 3, '0'),
    'application_no', 'EO-' || to_char(current_date, 'YYYY') || '-(random)')
  where public.can_write('customers');
$$;
revoke execute on function public.preview_customer_numbers(text, text) from public, anon;
grant execute on function public.preview_customer_numbers(text, text) to authenticated;

select 'UPDATE 2.3 READY - ' || (select count(*) from public.customers) || ' customers, next serial '
       || lpad((coalesce((select last_no from public.doc_counters where prefix = 'ACCOUNT'), 0) + 1)::text, 3, '0') as result;
