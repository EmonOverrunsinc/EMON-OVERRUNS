-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.81: THE WORD "INSURANCE" IS NOT SHOWN: "COVERAGE"
-- The messages, notifications and payment notes made by the server say COVERAGE (e.g. "COVERAGE INS-202611-003 ·
-- ORDER OR-..."), like the portal, the certificate and the statement. The payment notes and notifications already
-- saved are changed the same way. Nothing else changes (the numbers INS-..., the amounts and the records stay).
-- Needs 084_insurance_account.sql. Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again.
-- The last line says: UPDATE 3.81 READY - ...
-- =====================================================================
do $$ begin
  if to_regprocedure('public.ins_bill_account(uuid)') is null then raise exception 'Run 084_insurance_account.sql first, then run this again.'; end if;
end $$;

-- 1. the server's own words: every text in the coverage functions that starts with Insurance / INSURANCE
do $$
declare f record; def text; n int := 0;
begin
  for f in select p.oid from pg_proc p join pg_namespace s on s.oid = p.pronamespace
           where s.nspname = 'public' and p.prokind = 'f' and pg_get_functiondef(p.oid) ~ '''(Insurance|INSURANCE)'
  loop
    def := pg_get_functiondef(f.oid);
    def := replace(replace(def, '''Insurance', '''Coverage'), '''INSURANCE', '''COVERAGE');
    execute def;
    n := n + 1;
  end loop;
  raise notice 'coverage words: % function(s) changed', n;
end $$;

-- 2. the payment notes already saved (collection vouchers of a coverage) and the notifications already sent
do $$ begin
  perform public.allow_record_change();
  update public.collection_vouchers set note = 'COVERAGE ' || substr(note, 11) where note like 'INSURANCE INS-%';
  perform set_config('eo.allow_change', 'off', true);
  update public.notifications set title = 'Coverage ' || substr(title, 11) where title like 'Insurance INS-%';
end $$;

notify pgrst, 'reload schema';

select case when not exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace
                             where s.nspname = 'public' and p.prokind = 'f' and pg_get_functiondef(p.oid) ~ '''(Insurance|INSURANCE)')
  then 'UPDATE 3.81 READY - the server says COVERAGE (not insurance) in its messages, notifications and payment notes'
  else 'NOT READY - send this message to Claude' end as result;
