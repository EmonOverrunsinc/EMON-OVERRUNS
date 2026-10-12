-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 2.4: deleting a login account (needed for the Google Play Store)
-- A person asks for it in My Profile (Request Account Deletion) or on www.emonoverruns.online/delete-account.
-- The Director then presses Delete on Login Accounts:
--   * the login and the person's details go: name, email, username, photo, signature, chat messages, community
--     posts, notices, and a job application that was not approved (with its files);
--   * a person named in records the business must keep (invoices, receipts, payslips, order letters, the record
--     history ...) keeps those records: the login is removed and the profile becomes "Deleted User".
-- Also: invoices get Terms of Payment (with a due date); payments, discounts and orders are for the account, never
-- for one invoice, and invoices show PAID, PARTIAL PAYMENT or UNPAID from everything paid to the account (oldest
-- first); Verify a record shows the same for an invoice, and a customer still waiting for approval by the
-- application number (since 2.3 the account number is given only on approval).
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

-- ---------- invoices: Terms of Payment ----------
-- Chosen when an invoice is recorded (CASH ON DELIVERY, 7 / 15 / 30 / 45 / 60 / 90 DAYS, or other terms); an invoice
-- recorded before can be given its terms with Add Correction. The due date follows from it.
alter table public.customer_invoices add column if not exists payment_terms text;
do $$ begin
  alter table public.customer_invoices add constraint customer_invoices_payment_terms_check
    check (payment_terms is null or char_length(payment_terms) between 1 and 60);
exception when duplicate_object then null; end $$;

-- ---------- payments, discounts and orders are for the account, never for one invoice ----------
-- A payment is not linked to an invoice any more: what a customer pays (and every approved credit memo or discount,
-- and every settlement adjustment that takes off) goes to the account, and pays the oldest invoices first.
do $$
begin
  perform public.allow_record_change();
  update public.payments_received set invoice_id = null where invoice_id is not null;
end $$;
create or replace function public.payments_account_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.invoice_id := null;
  return new;
end;
$$;
revoke execute on function public.payments_account_only() from public, anon, authenticated;
drop trigger if exists payments_account_only on public.payments_received;
create trigger payments_account_only before insert or update of invoice_id on public.payments_received
  for each row execute function public.payments_account_only();

-- ---------- invoices: PAID, PARTIAL PAYMENT or UNPAID, from everything paid to the account ----------
-- Everything the customer paid or was credited (payments, approved credit memos and discounts, settlement adjustments
-- that take off) pays what is owed oldest first: the opening balance, then each invoice, additional charge and
-- settlement adjustment that adds, in date order. An invoice is PAID when it is paid in full, PARTIAL PAYMENT when
-- part of it is paid, and UNPAID when nothing of it is paid; the invoices' balances add up to the account's balance.
-- The columns of before stay in their place (every screen keeps working); the terms and the due date come after them.
create or replace view public.invoice_balances with (security_invoker = true) as
with pool as (
  select c.id as customer_id,
    coalesce((select sum(p.amount) from public.payments_received p where p.customer_id = c.id), 0)
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
  select i.customer_id, i.id, i.invoice_date, 1, i.created_at, i.total_amount::numeric
    from public.customer_invoices i
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
  select f.invoice_id as id, greatest(0, least(f.amount, coalesce(pl.amount, 0) - f.before))::numeric(14,2) as amount
  from fifo f left join pool pl on pl.customer_id = f.customer_id
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

-- ---------- functions changed in place (like the earlier updates), so everything added to them since stays ----------
-- verify_record: a customer waiting for approval is shown by the application number (2.3); an invoice shows what is
-- paid by the rule above, its balance and its terms; a payment no longer names an invoice.
-- editable_columns: the terms of an invoice can be corrected.
do $$
declare
  fixes text[][] := array[
    ['verify_record', '''type'', ''Customer Account'', ''number'', r.account_no,',
     '''type'', ''Customer Account'', ''number'', coalesce(r.account_no, r.application_no),'],
    ['verify_record', 'jsonb_build_array(''Customer ID'', r.account_no), jsonb_build_array(''Account Name''',
     'case when r.account_no is not null then jsonb_build_array(''Customer ID'', r.account_no) end, jsonb_build_array(''Account Name'''],
    ['verify_record', 'coalesce((select sum(p.amount) from public.payments_received p where p.invoice_id = i.id), 0) as paid',
     'coalesce((select b.amount_paid from public.invoice_balances b where b.id = i.id), 0) as paid'],
    ['verify_record', 'jsonb_build_array(''Paid (PHP)'', to_char(r.paid, ''FM999,999,999,990.00''))));',
     'jsonb_build_array(''Paid (PHP)'', to_char(r.paid, ''FM999,999,999,990.00'')),
          jsonb_build_array(''Balance (PHP)'', to_char(greatest(r.total_amount - r.paid, 0), ''FM999,999,999,990.00''))));'],
    ['verify_record', 'jsonb_build_array(''PO Number'', coalesce(r.po_number,',
     'jsonb_build_array(''Terms of Payment'', coalesce(r.payment_terms,'],
    ['verify_record', 'jsonb_build_array(''Invoice'', coalesce(r.inv, ''General payment'')),', ''],
    ['editable_columns', 'when ''customer_invoices'' then array[''purchase_date'',''po_number'',''total_boxes'',''total_pcs'']',
     'when ''customer_invoices'' then array[''purchase_date'',''po_number'',''total_boxes'',''total_pcs'',''payment_terms'']']
  ];
  f record; def text; new_def text; i int;
begin
  for f in select p.oid, p.proname from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.proname in ('verify_record', 'editable_columns')
  loop
    def := pg_get_functiondef(f.oid);
    new_def := def;
    for i in 1 .. array_length(fixes, 1) loop
      continue when fixes[i][1] <> f.proname;
      -- changed once: when the new text is already there (the script was run before), nothing is changed
      continue when fixes[i][3] <> '' and position(fixes[i][3] in new_def) > 0;
      if position(fixes[i][2] in new_def) = 0 then
        -- a text that is only taken out is already gone when the script runs again
        continue when fixes[i][3] = '';
        raise exception 'Update 2.4: % has changed; text not found: %', f.proname, left(fixes[i][2], 60);
      end if;
      new_def := replace(new_def, fixes[i][2], fixes[i][3]);
    end loop;
    if new_def <> def then execute new_def; end if;
  end loop;
end $$;

select 'UPDATE 2.4 READY - account deletion, invoice payment status, terms of payment' as result;
