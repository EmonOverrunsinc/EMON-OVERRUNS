-- MODINA FASHION: add the BDT payments from the paper file that are not in the portal yet (oldest first).
-- A payment already in the portal (same reference no; for the cash deposit the same date and amount) is skipped,
-- so this is safe to run again. Each new payment gets its own voucher no (BD + date + no), issued by the main Director.
do $$
declare
  co uuid; acc uuid; dir uuid; dir_name text; n int := 0; v uuid; r record;
begin
  select id into co from public.pay_companies where upper(replace(name, ' ', '')) in ('MODINAFASHION', 'MADINAFASHION') limit 1;
  if co is null then raise exception 'Modina Fashion was not found in Billing. Add the company first.'; end if;
  select id into acc from public.pay_accounts where company_id = co
    order by (replace(coalesce(account_number, ''), ' ', '') = '2003203172616001') desc, created_at limit 1;
  select id, full_name into dir, dir_name from public.profiles where role = 'admin' order by created_at limit 1;

  for r in select * from (values
    (date '2026-08-29', 20000::numeric,  'Online Transfer', 'S92633720', 'BKASH TO RIPON ISLAM'),
    (date '2026-08-30', 14000,           'Online Transfer', 'S93167018', 'BKASH TO RIPON ISLAM'),
    (date '2026-09-03', 400000,          'Bank Transfer',   'S97261805', 'PAYMENTS'),
    (date '2026-09-10', 210000,          'Bank Transfer',   'S4736512',  'PAYMENTS'),
    (date '2026-09-10', 554100,          'Deposit',         null,        'CASH DEPOSIT, BRAC BANK'),
    (date '2026-09-18', 200000,          'Bank Transfer',   'S11965242', 'PAYMENTS'),
    (date '2026-09-18', 600000,          'Bank Transfer',   'S11969274', 'PAYMENTS'),
    (date '2026-09-28', 20200,           'Online Transfer', 'S21111051', 'BKASH TO DOLLAR'),
    (date '2026-09-29', 20200,           'Online Transfer', 'S22115525', 'BKASH TO DOLLAR'),
    (date '2026-10-07', 5000,            'Online Transfer', 'S29770887', 'BKASH TO RIPON ISLAM')
  ) as t(d, amt, method, ref, purpose)
  loop
    if r.ref is not null and exists (select 1 from public.pay_vouchers where company_id = co and upper(reference_no) = r.ref) then continue; end if;
    if r.ref is null and exists (select 1 from public.pay_vouchers where company_id = co and pay_date = r.d and amount_bdt = r.amt) then continue; end if;
    insert into public.pay_vouchers (company_id, account_id, pay_date, amount_bdt, method, reference_no, purpose)
      values (co, acc, r.d, r.amt, r.method, r.ref, r.purpose) returning id into v;
    -- the SQL Editor has no signed-in user: the main Director is shown as the one who issued it
    perform set_config('eo.allow_change', 'on', true);
    update public.pay_vouchers set created_by = dir, created_by_name = dir_name where id = v;
    n := n + 1;
  end loop;
  raise notice 'ALL DONE - % Modina Fashion payment(s) added', n;
end $$;

select voucher_no, pay_date, method, reference_no, amount_bdt
from public.pay_vouchers
where company_id = (select id from public.pay_companies where upper(replace(name, ' ', '')) in ('MODINAFASHION', 'MADINAFASHION') limit 1)
order by pay_date, voucher_no;
