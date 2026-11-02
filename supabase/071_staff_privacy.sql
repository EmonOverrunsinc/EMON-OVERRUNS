-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.68: SECURITY - STAFF SEE ONLY THE MENUS THEY ARE GIVEN (ON THE SERVER)
-- Found by a hacker test: a staff login with NO menu access could still read the customers (names, addresses, phones),
-- the customers' history and the list of uploaded files (and open the files) of customers, invoices, payments, billing
-- and projects - straight from the server, without the portal's screens. Now the SERVER refuses it: a staff login reads a
-- customer, its history and its files only with the menu for it (1 Customer, 2 Invoice, 3 Payment, 4 Credit Memo or
-- 11 EO-Office); billing files only with 8 Billing; project files only with 7 Project; e-bill files with 10 E-Bill.
-- EMON HASAN sees everything as before. Paste all of it in Supabase > SQL Editor > New query and press Run.
-- Safe to run again. The last line says: UPDATE 3.68 READY - ...
-- =====================================================================

-- which menu a kind of record (or its files' folder) belongs to
create or replace function public.can_see_kind(p_kind text) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_admin() or case coalesce(p_kind, '')
    when 'customer' then public.has_module('customers') or public.has_module('invoices') or public.has_module('payments') or public.has_module('creditmemos') or public.has_module('eooffice')
    when 'statement' then public.has_module('customers') or public.has_module('invoices') or public.has_module('payments')
    when 'invoice' then public.has_module('invoices') or public.has_module('customers') or public.has_module('payments')
    when 'payment' then public.has_module('payments') or public.has_module('invoices') or public.has_module('customers')
    when 'credit_memo' then public.has_module('creditmemos') or public.has_module('customers') or public.has_module('invoices')
    when 'order_letter' then public.has_module('customers')
    when 'pay_company' then public.has_module('billing')
    when 'pay_account' then public.has_module('billing')
    when 'pay_voucher' then public.has_module('billing')
    when 'supplier' then public.has_module('billing')
    when 'supplier_payment' then public.has_module('billing')
    when 'project' then public.has_module('projects')
    when 'project_payment' then public.has_module('projects')
    when 'stock_bill' then public.has_module('inventory') or public.has_module('billing')
    when 'stock_bill_entry' then public.has_module('inventory') or public.has_module('billing')
    else true end;
$$;
revoke execute on function public.can_see_kind(text) from public, anon;
grant execute on function public.can_see_kind(text) to authenticated;

-- customers and their history: only with a menu that works with customers
drop policy if exists "customers: active read" on public.customers;
drop policy if exists "customers: read by menu" on public.customers;
create policy "customers: read by menu" on public.customers for select to authenticated
  using ((select public.is_active()) and (select public.can_see_kind('customer')));
drop policy if exists "cevents: active read" on public.customer_events;
drop policy if exists "cevents: read by menu" on public.customer_events;
create policy "cevents: read by menu" on public.customer_events for select to authenticated
  using ((select public.is_active()) and (select public.can_see_kind('customer')));

-- the list of uploaded files and the files themselves: only with the menu of their record
drop policy if exists "att: by menu" on public.attachments;
create policy "att: by menu" on public.attachments as restrictive for select to authenticated
  using (public.can_see_kind(owner_type));
drop policy if exists "storage records: by menu" on storage.objects;
create policy "storage records: by menu" on storage.objects as restrictive for select to authenticated
  using (bucket_id <> 'records' or public.can_see_kind((storage.foldername(name))[1]));

notify pgrst, 'reload schema';

select case when to_regprocedure('public.can_see_kind(text)') is not null
  and exists (select 1 from pg_policies where policyname = 'customers: read by menu')
  and exists (select 1 from pg_policies where policyname = 'storage records: by menu')
  then 'UPDATE 3.68 READY - staff read customers, their history and files only with the menu for them'
  else 'NOT READY - send this message to Claude' end as result;
