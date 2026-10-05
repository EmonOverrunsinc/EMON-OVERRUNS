-- =====================================================================
-- EMON OVERRUNS E-PORTAL — Update 1.6
-- Dates follow Manila time (Asia/Manila, UTC+8).
-- The database clock runs on UTC, so between midnight and 8 AM in Manila it still counted "today" as the day before:
-- the application date and account number of a new customer, days overdue, order / approval / project numbers,
-- termination dates, dates on the Verification page, and the month an order letter or a credit memo falls in on the statements.
-- After this update the database works these out in Manila time, and new records get the Manila date by default.
-- No records are changed. Run once in the Supabase SQL Editor after 008_update_1_5.sql. It is safe to run again
-- (and again after any later update that replaces one of these functions).
-- =====================================================================

-- 1. Every portal function that works out a date (numbers, statements, amount due, verification, orders) uses Manila time.
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
             and p.prosrc ~* '(current_date|::date|to_char\(|date_trunc\(|date_part\(|extract\()'
             and pg_get_userbyid(p.proowner) = current_user
  loop
    execute format('alter function %s set timezone to %L', f, 'Asia/Manila');
  end loop;
end $$;

-- 2. "Today" as the default date of new records is the Manila day.
do $$
declare r record;
begin
  for r in select c.table_name, c.column_name, c.column_default from information_schema.columns c
           join pg_class k on k.relname = c.table_name and k.relnamespace = 'public'::regnamespace and k.relkind = 'r'
           where c.table_schema = 'public' and c.column_default ilike '%current_date%' and pg_get_userbyid(k.relowner) = current_user
  loop
    execute format('alter table public.%I alter column %I set default %s', r.table_name, r.column_name,
                   regexp_replace(r.column_default, 'current_date', '((now() at time zone ''Asia/Manila''))::date', 'gi'));
  end loop;
end $$;
