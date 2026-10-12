-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 2.4: deleting a login account (needed for the Google Play Store)
-- A person asks for it in My Profile (Request Account Deletion) or on www.emonoverruns.online/delete-account.
-- The Director then presses Delete on Login Accounts:
--   * the login and the person's details go: name, email, username, photo, signature, chat messages, community
--     posts, notices, and a job application that was not approved (with its files);
--   * a person named in records the business must keep (invoices, receipts, payslips, order letters, the record
--     history ...) keeps those records: the login is removed and the profile becomes "Deleted User".
-- Also: Verify a record shows a customer still waiting for approval by the application number (since 2.3 the
-- account number is given only on approval).
-- Run once in the Supabase SQL Editor after 016_update_2_3.sql. It is safe to run again.
-- =====================================================================

-- the Director may remove profile photos (the files of a deleted account)
drop policy if exists "storage avatars: admin read" on storage.objects;
create policy "storage avatars: admin read" on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and (select public.is_admin()));
drop policy if exists "storage avatars: admin delete" on storage.objects;
create policy "storage avatars: admin delete" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (select public.is_admin()));

-- Returns how the account went ('deleted', or 'anonymized' when kept records name it) and the stored files of the
-- account, which the portal then removes from storage.
create or replace function public.delete_user_account(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p public.profiles;
  avs text[] := '{}';
  recs text[] := '{}';
  how text;
begin
  if not public.is_admin() then raise exception 'Only the Director can delete an account'; end if;
  if p_id = auth.uid() then raise exception 'You cannot delete your own account'; end if;
  if exists (select 1 from public.main_director where profile_id = p_id) then
    raise exception 'The main Director''s account cannot be deleted';
  end if;
  select * into p from public.profiles where id = p_id;
  if p.id is null then raise exception 'Account not found'; end if;
  perform public.allow_record_change();

  -- the stored files of the account
  if p.avatar_path is not null then avs := avs || p.avatar_path; end if;
  if p.signature_path is not null then recs := recs || p.signature_path; end if;
  recs := recs || coalesce((select array_agg(m.file_path) from public.messages m
                            where (m.sender_id = p_id or m.recipient_id = p_id) and m.file_path is not null), '{}');
  recs := recs || coalesce((select array_agg(x) from public.community_posts c, unnest(c.photos) x where c.author_id = p_id), '{}');
  recs := recs || coalesce((select array_agg(j.photo_path) from public.job_applications j
                            where j.profile_id = p_id and j.status <> 'approved' and j.photo_path is not null), '{}');
  recs := recs || coalesce((select array_agg(a.storage_path) from public.attachments a
                            join public.job_applications j on a.owner_type = 'job_application' and a.owner_id = j.id
                            where j.profile_id = p_id and j.status <> 'approved'), '{}');

  -- the person's own things (a job application that was approved belongs to the employee record and stays)
  delete from public.attachments a using public.job_applications j
    where a.owner_type = 'job_application' and a.owner_id = j.id and j.profile_id = p_id and j.status <> 'approved';
  delete from public.job_applications where profile_id = p_id and status <> 'approved';
  delete from public.messages where sender_id = p_id or recipient_id = p_id;
  delete from public.community_posts where author_id = p_id;
  delete from public.notifications where user_id = p_id;

  begin
    delete from auth.users where id = p_id; -- the profile goes with it
    how := 'deleted';
  exception when foreign_key_violation then
    -- kept records still point to this profile: the login and the personal details are removed instead
    update public.profiles set full_name = 'Deleted User', email = null, username = null, avatar_path = null,
      signature_path = null, signature_status = null, signature_at = null, signature_note = null,
      status = 'disabled', last_seen_at = null
    where id = p_id;
    update auth.users set email = 'deleted-' || p_id || '@deleted.invalid', phone = null, encrypted_password = '',
      raw_user_meta_data = '{}'::jsonb, banned_until = 'infinity'
    where id = p_id;
    delete from auth.identities where user_id = p_id;
    delete from auth.sessions where user_id = p_id;
    how := 'anonymized';
  end;
  return jsonb_build_object('result', how, 'avatars', to_jsonb(avs), 'records', to_jsonb(recs));
end;
$$;
revoke execute on function public.delete_user_account(uuid) from public, anon;
grant execute on function public.delete_user_account(uuid) to authenticated;

-- ---------- Verify a record: a customer waiting for approval has no account number yet (2.3) ----------
create or replace function public.verify_record(p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  raw text := trim(coalesce(p_code, ''));
  cands text[];
  c text;
  r record;
  amt text;
begin
  if raw = '' then return jsonb_build_object('found', false); end if;
  if raw ~* '#verify/' then raw := regexp_replace(raw, '^.*#verify/', '', 'i'); end if;
  raw := split_part(split_part(raw, '?', 1), '&', 1);
  cands := array(
    select distinct upper(trim(x)) from unnest(string_to_array(raw, '|')) x
    where trim(x) <> '' and upper(trim(x)) not in ('EMON','EMONCUST','EMONINV','EMONPAY','EMONCM','EMONPRJ','EMONSP','EMONPS','EMONBD','ORDER','EMONJA','EMONSOA'));
  foreach c in array cands loop
    -- customer account (account no, application no or public ID)
    select * into r from public.customers cu where upper(cu.account_no) = c or upper(cu.application_no) = c or upper(cu.public_id) = c limit 1;
    if found then
      -- The amount due shows only to signed-in portal users (not on the public page) and never on the Validated Print.
      return jsonb_build_object('found', true, 'type', 'Customer Account', 'number', coalesce(r.account_no, r.application_no), 'status', r.status,
        'fields', (select jsonb_agg(f) from jsonb_array_elements(jsonb_build_array(
          case when r.account_no is not null then jsonb_build_array('Customer ID', r.account_no) end, jsonb_build_array('Account Name', r.first_name || ' ' || r.last_name),
          case when public.is_active() then jsonb_build_array('Amount Due (PHP)',
            to_char(coalesce((select b.balance_due from public.customer_balances b where b.customer_id = r.id), 0), 'FM999,999,999,990.00')) end,
          jsonb_build_array('Application No', r.application_no), jsonb_build_array('Public ID', r.public_id),
          jsonb_build_array('Opened', to_char(r.application_date, 'DD Mon YYYY')), jsonb_build_array('Account Status', upper(r.status)))) f where f <> 'null'::jsonb));
    end if;
    select i.*, cu.first_name, cu.last_name, cu.account_no as acct,
      coalesce((select sum(p.amount) from public.payments_received p where p.invoice_id = i.id), 0) as paid
      into r from public.customer_invoices i join public.customers cu on cu.id = i.customer_id where upper(i.invoice_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Invoice', 'number', r.invoice_no,
        'status', case when r.paid >= r.total_amount then 'paid' when r.paid > 0 then 'partial' else 'unpaid' end,
        'fields', jsonb_build_array(
          jsonb_build_array('Invoice No', r.invoice_no), jsonb_build_array('Customer', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Account No', r.acct), jsonb_build_array('Invoice Date', to_char(r.invoice_date, 'DD Mon YYYY')),
          jsonb_build_array('PO Number', coalesce(r.po_number, chr(8212))), jsonb_build_array('Boxes / Pcs', r.total_boxes || ' / ' || r.total_pcs),
          jsonb_build_array('Amount (PHP)', to_char(r.total_amount, 'FM999,999,999,990.00')),
          jsonb_build_array('Paid (PHP)', to_char(r.paid, 'FM999,999,999,990.00'))));
    end if;
    select p.*, cu.first_name, cu.last_name, cu.account_no as acct, i.invoice_no as inv
      into r from public.payments_received p join public.customers cu on cu.id = p.customer_id left join public.customer_invoices i on i.id = p.invoice_id
      where upper(p.receipt_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Payment Receipt', 'number', r.receipt_no, 'status', 'received',
        'fields', jsonb_build_array(
          jsonb_build_array('Receipt No', r.receipt_no), jsonb_build_array('Received From', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Account No', r.acct), jsonb_build_array('Date Paid', to_char(r.paid_date, 'DD Mon YYYY')),
          jsonb_build_array('Amount (PHP)', to_char(r.amount, 'FM999,999,999,990.00')), jsonb_build_array('Method', replace(r.method, '_', ' ')),
          jsonb_build_array('Reference', coalesce(r.reference_no, chr(8212))), jsonb_build_array('Invoice', coalesce(r.inv, 'General payment')),
          jsonb_build_array('Verified By', coalesce(r.created_by_name, chr(8212)))));
    end if;
    select m.*, cu.first_name, cu.last_name, cu.account_no as acct
      into r from public.credit_memos m join public.customers cu on cu.id = m.customer_id where upper(m.memo_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Credit Memo', 'number', r.memo_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Report No', r.memo_no), jsonb_build_array('Customer', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Customer ID', r.acct), jsonb_build_array('Date', to_char(r.memo_date, 'DD Mon YYYY')),
          jsonb_build_array('Request', replace(r.requested_action, '_', ' ')), jsonb_build_array('Amount (PHP)', to_char(r.request_amount, 'FM999,999,999,990.00')),
          jsonb_build_array('Status', upper(r.status))));
    end if;
    select s.*, cu.first_name, cu.last_name, cu.account_no as acct
      into r from public.statements s join public.customers cu on cu.id = s.customer_id where upper(s.statement_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Statement of Account', 'number', r.statement_no, 'status', 'issued',
        'fields', jsonb_build_array(
          jsonb_build_array('Statement No', r.statement_no), jsonb_build_array('Customer', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Account No', r.acct), jsonb_build_array('Period', to_char(r.period_start, 'DD Mon YYYY') || (' ' || chr(8211) || ' ') || to_char(r.period_end, 'DD Mon YYYY')),
          jsonb_build_array('Opening (PHP)', to_char(r.opening_balance, 'FM999,999,999,990.00')),
          jsonb_build_array('Closing (PHP)', to_char(r.closing_balance, 'FM999,999,999,990.00'))));
    end if;
    select o.*, cu.first_name, cu.last_name, cu.account_no as acct, em.first_name as em_first, em.last_name as em_last, em.employee_no as em_no, pc.name as co_name
      into r from public.order_letters o left join public.customers cu on cu.id = o.customer_id
      left join public.employees em on em.id = o.employee_id left join public.pay_companies pc on pc.id = o.company_id
      where upper(o.order_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Order Letter', 'number', r.order_no, 'status', r.status,
        'fields', (select jsonb_agg(f) from jsonb_array_elements(jsonb_build_array(
          jsonb_build_array('Order No', r.order_no), jsonb_build_array('Date', to_char(r.order_date, 'DD Mon YYYY')),
          jsonb_build_array(case when r.employee_id is not null then 'Employee' when r.company_id is not null then 'Company' else 'Account' end,
            coalesce(r.first_name || ' ' || r.last_name || ' (' || r.acct || ')', r.em_first || ' ' || r.em_last || ' (' || r.em_no || ')', r.co_name, chr(8212))),
          jsonb_build_array('Subject', r.subject), jsonb_build_array('Type', initcap(replace(r.subject_type, '_', ' '))),
          case when r.subject_type = 'balance_certificate' then jsonb_build_array('Amount Due (PHP)', to_char(r.balance_due, 'FM999,999,999,990.00')) end,
          case when r.subject_type = 'charge' then jsonb_build_array('Charge (PHP)', to_char(r.amount, 'FM999,999,999,990.00')) end,
          case when r.subject_type = 'settlement' then jsonb_build_array('Settlement Adjustment (PHP)',
            case r.adjust_type when 'reduce' then 'Less ' else 'Add ' end || to_char(r.amount, 'FM999,999,999,990.00')) end,
          jsonb_build_array('Status', upper(r.status)), jsonb_build_array('Approved By', coalesce(r.approved_by_name, chr(8212))))) f where f <> 'null'::jsonb));
    end if;
    select v.*, pc.name as company, pa.account_name, pa.account_number, pa.bank_name
      into r from public.pay_vouchers v join public.pay_companies pc on pc.id = v.company_id left join public.pay_accounts pa on pa.id = v.account_id
      where upper(v.voucher_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Payment Voucher', 'number', r.voucher_no, 'status', 'paid',
        'fields', (select jsonb_agg(f) from jsonb_array_elements(jsonb_build_array(
          jsonb_build_array('Voucher No', r.voucher_no), jsonb_build_array('Paid To', r.company),
          jsonb_build_array('Account', coalesce(r.account_name || ' ' || coalesce(r.account_number, '') || ' ' || coalesce(r.bank_name, ''), chr(8212))),
          jsonb_build_array('Date', to_char(r.pay_date, 'DD Mon YYYY')),
          case when r.amount_php is not null then jsonb_build_array('Amount (PHP)', to_char(r.amount_php, 'FM999,999,999,990.00')) end,
          case when r.exchange_rate is not null then jsonb_build_array('Exchange Rate', to_char(r.exchange_rate, 'FM999,990.0000')) end,
          case when r.amount_bdt is not null then jsonb_build_array('Amount (BDT)', to_char(r.amount_bdt, 'FM999,999,999,990.00')) end,
          jsonb_build_array('Issued By', coalesce(r.created_by_name, chr(8212))))) f where f <> 'null'::jsonb));
    end if;
    select s.*, e.first_name, e.last_name, e.employee_no, e.position
      into r from public.payslips s join public.employees e on e.id = s.employee_id where upper(s.payslip_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Payslip', 'number', r.payslip_no, 'status', 'paid',
        'fields', jsonb_build_array(
          jsonb_build_array('Payslip No', r.payslip_no), jsonb_build_array('Employee', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Employee No', r.employee_no), jsonb_build_array('Type', initcap(r.pay_type)),
          jsonb_build_array('Period', to_char(r.period_month, 'FMMonth YYYY')), jsonb_build_array('Pay Date', to_char(r.pay_date, 'DD Mon YYYY')),
          jsonb_build_array('Net Pay (PHP)', to_char(r.net_pay, 'FM999,999,999,990.00'))));
    end if;
    select * into r from public.job_applications j where upper(j.application_no) = c or upper(j.approval_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Job Application', 'number', r.application_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Application No', r.application_no), jsonb_build_array('Applicant', r.full_name),
          jsonb_build_array('Position', r.position_title), jsonb_build_array('Company', r.company_name),
          jsonb_build_array('Submitted', to_char(r.created_at, 'DD Mon YYYY')), jsonb_build_array('Status', upper(r.status)),
          jsonb_build_array('Approval No', coalesce(r.approval_no, chr(8212)))));
    end if;
    select * into r from public.employees e where upper(e.employee_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Employee', 'number', r.employee_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Employee No', r.employee_no), jsonb_build_array('Name', r.first_name || ' ' || r.last_name),
          jsonb_build_array('Position', coalesce(r.position, chr(8212))), jsonb_build_array('Status', upper(r.status))));
    end if;
    select * into r from public.projects p where upper(p.project_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Project', 'number', r.project_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Project No', r.project_no), jsonb_build_array('Title', r.title),
          jsonb_build_array('Total Cost (PHP)', to_char(r.total_cost, 'FM999,999,999,990.00')), jsonb_build_array('Status', upper(r.status))));
    end if;
    select x.*, p.project_no, p.title into r from public.project_payments x join public.projects p on p.id = x.project_id where upper(x.payment_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Project Payment', 'number', r.payment_no, 'status', 'paid',
        'fields', jsonb_build_array(
          jsonb_build_array('Payment No', r.payment_no), jsonb_build_array('Project', r.project_no || (' ' || chr(8212) || ' ') || r.title),
          jsonb_build_array('Date', to_char(r.pay_date, 'DD Mon YYYY')), jsonb_build_array('Amount (PHP)', to_char(r.amount, 'FM999,999,999,990.00')),
          jsonb_build_array('Received By', r.received_by)));
    end if;
    select * into r from public.documents d where upper(d.doc_no) = c limit 1;
    if found then
      return jsonb_build_object('found', true, 'type', 'Document', 'number', r.doc_no, 'status', r.status,
        'fields', jsonb_build_array(
          jsonb_build_array('Document No', r.doc_no), jsonb_build_array('Party', r.party_name),
          jsonb_build_array('Date', to_char(r.doc_date, 'DD Mon YYYY')), jsonb_build_array('Amount (PHP)', to_char(r.amount, 'FM999,999,999,990.00')),
          jsonb_build_array('Status', upper(r.status))));
    end if;
  end loop;
  return jsonb_build_object('found', false, 'code', raw);
end;
$$;
revoke execute on function public.verify_record(text) from public;
grant execute on function public.verify_record(text) to anon, authenticated;

select 'UPDATE 2.4 READY - account deletion added' as result;
