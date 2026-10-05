-- =====================================================================
-- EMON OVERRUNS E-PORTAL — clear the old (test) data, ONE TIME ONLY
-- Deletes every record: customers, invoices, payments, credit memos, statements, orders, billing companies,
-- accounts and vouchers, projects, payslips, job applications and positions, community posts, messages,
-- notifications, corrections, file records and the old 1.0 tables. Numbers start again from 001.
-- Kept: the user logins, the owner's employee record (and its number counter), the company logo and the
-- download forms. Uploaded files stay in Storage (bucket "records") but are no longer linked to anything.
-- It runs only once: after the first run it does nothing, so it can never clear new data later.
-- =====================================================================
do $$
declare t text;
begin
  if exists (select 1 from private.app_secrets where k = 'old_data_cleared') then
    raise notice 'The old data was already cleared on %. Nothing was done.', (select v from private.app_secrets where k = 'old_data_cleared');
    return;
  end if;
  perform set_config('eo.allow_change', 'on', true);
  foreach t in array array[
    'attachments','change_requests','record_changes','notifications','messages','community_posts','announcements','audit_logs',
    'order_letter_codes','order_letters',
    'payments_received','credit_memos','statements','customer_invoices','customer_events','customer_secrets','customers',
    'payslips','job_applications','job_positions',
    'project_payments','project_items','projects',
    'pay_vouchers','pay_accounts','pay_companies',
    'payment_allocations','payments','invoice_items','invoices','accounts',
    'supplier_payments','supplier_batches','suppliers',
    'verification_log','document_files','documents','resolutions'] loop
    if to_regclass('public.' || t) is not null then
      execute format('delete from public.%I', t);
    end if;
  end loop;
  delete from public.employees where lower(email) not in ('mdemon9559@gmail.com','mdemon9559@outlook.com','emonoverruns@gmail.com');
  delete from public.doc_counters where prefix not like 'EMP%';
  insert into private.app_secrets (k, v) values ('old_data_cleared', now()::text);
end $$;
