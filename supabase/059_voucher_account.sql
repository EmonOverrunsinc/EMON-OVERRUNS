-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.48: CHANGE THE ACCOUNT of a payment voucher
-- On the voucher page, the Director (or Billing staff) chooses which of the company's accounts the payment went to, or adds a
-- new account there. Only the account changes (the amount, date and voucher no stay). Safe to run again.
-- =====================================================================
create or replace function public.set_voucher_account(p_voucher uuid, p_account uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.pay_vouchers;
begin
  if not (public.is_admin() or public.can_write('billing')) then raise exception 'Not allowed'; end if;
  select * into v from public.pay_vouchers where id = p_voucher for update;
  if not found then raise exception 'Voucher not found'; end if;
  if p_account is not null and not exists (select 1 from public.pay_accounts a where a.id = p_account and a.company_id = v.company_id) then
    raise exception 'That account belongs to a different company';
  end if;
  perform public.allow_record_change();
  update public.pay_vouchers set account_id = p_account where id = p_voucher;
  perform set_config('eo.allow_change', 'off', true);
end;
$$;
revoke execute on function public.set_voucher_account(uuid, uuid) from public, anon;
grant execute on function public.set_voucher_account(uuid, uuid) to authenticated;

select case when to_regprocedure('public.set_voucher_account(uuid,uuid)') is not null
  then 'UPDATE 3.48 READY - change the account of a payment voucher (or add a new account) on the voucher page'
  else 'NOT READY - send this message to Claude' end as result;
