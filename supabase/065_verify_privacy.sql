-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.57: SECURITY - THE PUBLIC VERIFY PAGE SHOWS NO PRIVATE DATA
-- Record numbers follow each other (INV-202610-0001, 0002 ...), so a visitor who is NOT signed in could try them one by one
-- on the Verify page and collect customer names, account numbers and amounts. Now a visitor sees only: RECORD FOUND, the
-- type, the number, the status and the dates. Names, account numbers and amounts show only to people signed in to the
-- E-Portal - or when the secret key printed on the document (the customer's Public ID, an E-Bill's secret code) is used.
-- Needs RUN_062_TO_064.sql. Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again.
-- The last line says: UPDATE 3.57 READY - ...
-- =====================================================================

-- the full check stays, under its own name, for the portal only
do $$
begin
  if to_regprocedure('public.verify_record_full(text)') is null then
    alter function public.verify_record(text) rename to verify_record_full;
  end if;
end $$;
revoke execute on function public.verify_record_full(text) from public, anon, authenticated;

create or replace function public.verify_record(p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare r jsonb := public.verify_record_full(p_code); pid text;
begin
  if r is null or not coalesce((r ->> 'found')::boolean, false) or public.is_active() then return r; end if;
  -- found by its secret key: an e-bill (only its secret code finds it) or a customer by the Public ID printed on the QR
  if r ->> 'type' in ('E-Bill', 'E-Bill Statistics', 'Stock-Bill Statistics') then return r; end if;
  if r ->> 'type' = 'Customer Account' then
    select f ->> 1 into pid from jsonb_array_elements(coalesce(r -> 'fields', '[]'::jsonb)) f where f ->> 0 = 'Public ID' limit 1;
    if pid is not null and position(upper(replace(pid, '-', '')) in upper(replace(coalesce(p_code, ''), '-', ''))) > 0 then return r; end if;
  end if;
  -- anyone else: the record is real, with its number, status and dates only
  return jsonb_build_object('found', true, 'limited', true, 'type', r ->> 'type', 'number', r ->> 'number', 'status', r ->> 'status',
    'fields', coalesce((select jsonb_agg(f) from jsonb_array_elements(coalesce(r -> 'fields', '[]'::jsonb)) f
      where f ->> 0 ~* '(\mno|date|period|status|type|opened)$' and f ->> 0 !~* '(account|customer|employee|reference|bill no|public)'), '[]'::jsonb));
end;
$$;
revoke execute on function public.verify_record(text) from public;
grant execute on function public.verify_record(text) to anon, authenticated;

notify pgrst, 'reload schema';

select case when to_regprocedure('public.verify_record_full(text)') is not null and to_regprocedure('public.verify_record(text)') is not null
  and not has_function_privilege('anon', 'public.verify_record_full(text)', 'execute')
  then 'UPDATE 3.57 READY - the public Verify page shows no names or amounts to visitors who are not signed in'
  else 'NOT READY - send this message to Claude' end as result;
