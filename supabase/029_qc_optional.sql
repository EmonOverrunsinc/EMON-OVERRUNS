-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.9: a new QC test needs no required field (the item may be empty)
-- Run once in the Supabase SQL Editor. It is safe to run again.
-- =====================================================================
alter table public.qc_tests alter column item drop not null;

create or replace function public.create_qc(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare t public.qc_tests; me text := (select full_name from public.profiles where id = auth.uid()); yr text := to_char(current_date, 'YYYY');
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  insert into public.qc_tests (qc_no, serial_no, item, brand, batch, ctn, created_by_name)
  values ('QC-' || yr || '-' || lpad(public.next_counter('QC' || yr)::text, 4, '0'), nullif(left(trim(coalesce(p_data ->> 'serial_no', '')), 60), ''),
    nullif(left(trim(coalesce(p_data ->> 'item', '')), 120), ''), nullif(left(trim(coalesce(p_data ->> 'brand', '')), 80), ''), nullif(left(trim(coalesce(p_data ->> 'batch', '')), 60), ''),
    nullif(left(trim(coalesce(p_data ->> 'ctn', '')), 60), ''), me)
  returning * into t;
  insert into public.qc_results (qc_id) values (t.id);
  return jsonb_build_object('id', t.id, 'qc_no', t.qc_no);
end;
$$;
revoke execute on function public.create_qc(jsonb) from public, anon;
grant execute on function public.create_qc(jsonb) to authenticated;

select 'UPDATE 3.9 READY - QC test: nothing required' as result;
