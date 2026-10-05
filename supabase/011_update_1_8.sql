-- =====================================================================
-- EMON OVERRUNS E-PORTAL — Update 1.8
-- 1. Uploaded files: a wrong file can be removed and uploaded again, in every upload section.
--    The Director removes any file; the person who uploaded a file can remove it within 24 hours.
--    Every removal is written in the record's history.
-- 2. Customer account:
--    - Credit Limit: a value kept on the record (nothing is blocked by it).
--    - Opening Balance: an amount the customer already owed when the account was opened. It counts from the
--      application date in the balance, the SOA, the monthly statements and the amount due.
--    - The address is verified by hand (no map search): Verified or Not Verified when the form is submitted,
--      and the Director can mark it later.
--    - The form shows a preview of the account number and application number.
-- No records are changed. Run once in the Supabase SQL Editor after 010_update_1_7.sql. It is safe to run again.
-- =====================================================================

-- ---------- 1. remove an uploaded file ----------
create or replace function public.remove_attachment(p_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  a public.attachments;
  me text := (select full_name from public.profiles where id = auth.uid());
  tbl text;
begin
  select * into a from public.attachments where id = p_id;
  if not found then raise exception 'File not found'; end if;
  if not (public.is_admin() or (public.is_active() and a.uploaded_by = auth.uid() and a.created_at > now() - interval '24 hours')) then
    raise exception 'You can remove your own upload within 24 hours. After that, ask the Director';
  end if;
  perform public.allow_record_change();
  delete from public.attachments where id = p_id;
  if a.owner_type = 'customer' then
    -- removing the customer's current photo also takes it off the profile
    update public.customers set photo_path = null where id = a.owner_id and photo_path = a.storage_path;
    insert into public.customer_events (customer_id, action, note, actor, actor_name)
    values (a.owner_id, 'file removed', a.file_name, auth.uid(), me);
  end if;
  tbl := case a.owner_type when 'customer' then 'customers' when 'invoice' then 'customer_invoices' when 'payment' then 'payments_received'
    when 'credit_memo' then 'credit_memos' when 'employee' then 'employees' when 'job_application' then 'job_applications'
    when 'payslip' then 'payslips' when 'order_letter' then 'order_letters' when 'pay_company' then 'pay_companies'
    when 'pay_account' then 'pay_accounts' when 'pay_voucher' then 'pay_vouchers' when 'project' then 'projects'
    when 'project_payment' then 'project_payments' when 'statement' then 'statements' else a.owner_type end;
  insert into public.record_changes (target_table, target_id, action, changes, previous, target_label, actor, actor_name)
  values (tbl, a.owner_id, 'file removed', jsonb_build_object('file', ''), jsonb_build_object('file', a.file_name), a.file_name, auth.uid(), me);
  return a.storage_path;
end;
$$;
revoke execute on function public.remove_attachment(uuid) from public, anon;
grant execute on function public.remove_attachment(uuid) to authenticated;

-- The person who uploaded a file may delete the stored file within 24 hours (the Director always could).
drop policy if exists "storage records: uploader delete" on storage.objects;
create policy "storage records: uploader delete" on storage.objects for delete to authenticated
  using (bucket_id = 'records' and created_at > now() - interval '24 hours'
         and (owner_id = (select auth.uid())::text or owner = (select auth.uid())));

-- ---------- 2. customer account ----------
alter table public.customers add column if not exists credit_limit numeric(14,2);
alter table public.customers add column if not exists opening_balance numeric(14,2) not null default 0;
alter table public.customers drop constraint if exists customers_credit_limit_check;
alter table public.customers add constraint customers_credit_limit_check check (credit_limit is null or credit_limit >= 0);
alter table public.customers drop constraint if exists customers_opening_balance_check;
alter table public.customers add constraint customers_opening_balance_check check (opening_balance >= 0);

-- the credit limit can be corrected like the other details
create or replace function public.editable_columns(p_table text) returns text[]
language sql immutable set search_path = '' as $$
  select case p_table
    when 'customers' then array['first_name','last_name','phone','email','address','business_name','business_start_date','facebook_name','has_extra_facebook','extra_facebook_name','facebook_verified','credit_limit']
    when 'customer_invoices' then array['purchase_date','po_number','total_boxes','total_pcs']
    when 'payments_received' then array['method','bank_name','bank_account','reference_no','notes']
    when 'credit_memos' then array['payment_ref','po_number','article','brand','style','batch_no','serial_no','purchase_date','defect_category','defect_detail','assigned_by','inspection_notes','factory_status']
    when 'employees' then array['first_name','last_name','position','phone','address','date_hired','monthly_salary']
    when 'payslips' then array['method','reference_no','notes']
    when 'projects' then array['title','description','location','start_date','end_date']
    when 'project_payments' then array['received_by','method','reference_no','notes']
    when 'pay_companies' then array['name','contact_person','contact','address','country','currency','notes']
    when 'pay_accounts' then array['account_name','account_number','bank_name','branch_name','notes']
    when 'pay_vouchers' then array['purpose','method','reference_no','notes']
    when 'job_applications' then array['full_name','phone','email','present_address','permanent_address','father_name','mother_name','spouse_name','date_of_birth','birth_place','id_number','gender','religion','blood_group','apply_salary','apply_duty_hours','apply_joining_date']
    else null end;
$$;

-- The account number and application number the next application will get (the final numbers are given on submit).
create or replace function public.preview_customer_numbers(p_first text, p_last text) returns jsonb
language sql stable security definer set search_path = '' set timezone to 'Asia/Manila' as $$
  select jsonb_build_object(
    'account_no', coalesce(nullif(upper(left(regexp_replace(coalesce(p_first, ''), '[^A-Za-z]', '', 'g'), 1) || left(regexp_replace(coalesce(p_last, ''), '[^A-Za-z]', '', 'g'), 1)), ''), 'XX')
                  || '-' || to_char(current_date, 'YYYYMM')
                  || lpad((coalesce((select d.last_no from public.doc_counters d where d.prefix = 'ACC' || to_char(current_date, 'YYYYMM')), 0) + 1)::text, 3, '0'),
    'application_no', 'EO-' || to_char(current_date, 'YYYY') || '-'
                  || lpad((coalesce((select d.last_no from public.doc_counters d where d.prefix = 'APP' || to_char(current_date, 'YYYY')), 0) + 1)::text, 5, '0'))
  where public.can_write('customers');
$$;
revoke execute on function public.preview_customer_numbers(text, text) from public, anon;
grant execute on function public.preview_customer_numbers(text, text) to authenticated;

-- Balance of every customer: the opening balance is part of what the customer owes.
create or replace view public.customer_balances with (security_invoker = true) as
  select c.id as customer_id,
    coalesce((select sum(total_amount) from public.customer_invoices i where i.customer_id = c.id), 0)::numeric(14,2) as total_invoiced,
    coalesce((select sum(amount) from public.payments_received p where p.customer_id = c.id), 0)::numeric(14,2) as total_paid,
    coalesce((select sum(request_amount) from public.credit_memos m where m.customer_id = c.id and m.status in ('approved','paid') and m.requested_action in ('credit','discount')), 0)::numeric(14,2) as total_credits,
    (c.opening_balance
      + coalesce((select sum(total_amount) from public.customer_invoices i where i.customer_id = c.id), 0)
      + coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = c.id and o.status = 'applied' and (o.subject_type = 'charge' or (o.subject_type = 'settlement' and o.adjust_type = 'add'))), 0)
      - coalesce((select sum(amount) from public.payments_received p where p.customer_id = c.id), 0)
      - coalesce((select sum(request_amount) from public.credit_memos m where m.customer_id = c.id and m.status in ('approved','paid') and m.requested_action in ('credit','discount')), 0)
      - coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = c.id and o.status = 'applied' and o.subject_type = 'settlement' and o.adjust_type = 'reduce'), 0))::numeric(14,2) as balance_due,
    coalesce((select sum(o.amount) from public.order_letters o where o.customer_id = c.id and o.status = 'applied' and o.subject_type = 'charge'), 0)::numeric(14,2) as total_charges,
    coalesce((select sum(case o.adjust_type when 'reduce' then -o.amount else o.amount end) from public.order_letters o
              where o.customer_id = c.id and o.status = 'applied' and o.subject_type = 'settlement'), 0)::numeric(14,2) as total_settlement,
    c.opening_balance::numeric(14,2) as opening_balance
  from public.customers c;

-- The other functions are created again exactly as they are now (same settings, Manila time and permissions),
-- with only these lines changed.
do $$
declare
  -- function name, the exact old text, the new text (the new text always contains the old one, so it is added once)
  fixes text[][] := array[
    -- the opening balance counts from the application date
    ['balance_before', 'select coalesce((select sum(total_amount) from public.customer_invoices where customer_id = p_customer and invoice_date < p_date), 0)',
                       'select coalesce((select c.opening_balance from public.customers c where c.id = p_customer and c.application_date < p_date), 0)
       + coalesce((select sum(total_amount) from public.customer_invoices where customer_id = p_customer and invoice_date < p_date), 0)'],
    ['generate_statements', 'deb := coalesce((select sum(total_amount) from public.customer_invoices',
                            'deb := (case when c.application_date >= m and c.application_date < nxt then c.opening_balance else 0 end)
             + coalesce((select sum(total_amount) from public.customer_invoices'],
    ['account_due', 'from (select i.invoice_no, i.invoice_date, i.created_at as at, i.total_amount as amount from public.customer_invoices i where i.customer_id = p_customer',
                    'from (select ''Opening Balance'' as invoice_no, c.application_date as invoice_date, c.created_at as at, c.opening_balance as amount
          from public.customers c where c.id = p_customer and c.opening_balance > 0
          union all
          select i.invoice_no, i.invoice_date, i.created_at as at, i.total_amount as amount from public.customer_invoices i where i.customer_id = p_customer'],
    -- the Director marks an address verified or not verified by hand
    ['customer_action', 'when ''facebook_unverified'' then c.status',
                        'when ''facebook_unverified'' then c.status
    when ''address_verified'' then c.status
    when ''address_unverified'' then c.status'],
    ['customer_action', 'facebook_verified = case p_action when ''facebook_verified'' then true when ''facebook_unverified'' then false else facebook_verified end,',
                        'facebook_verified = case p_action when ''facebook_verified'' then true when ''facebook_unverified'' then false else facebook_verified end,
    address_verified = case p_action when ''address_verified'' then true when ''address_unverified'' then false else address_verified end,']
  ];
  f record; def text; new_def text; i int;
begin
  for f in select p.oid, p.proname from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and pg_get_userbyid(p.proowner) = current_user
             and p.proname in ('balance_before', 'generate_statements', 'account_due', 'customer_action')
  loop
    def := pg_get_functiondef(f.oid);
    new_def := def;
    for i in 1 .. array_length(fixes, 1) loop
      if fixes[i][1] = f.proname and position(fixes[i][3] in new_def) = 0 then
        if position(fixes[i][2] in new_def) = 0 then raise exception 'Update 1.8: % has changed; text not found: %', f.proname, left(fixes[i][2], 60); end if;
        new_def := replace(new_def, fixes[i][2], fixes[i][3]);
      end if;
    end loop;
    if new_def <> def then execute new_def; end if;
  end loop;
end $$;
