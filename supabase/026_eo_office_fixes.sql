-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.4: EO-Office fixes
--  1. QC paper copies and collection receipts (and purchase order photos / voice notes) can be read only by the people who may
--     see those sections (before, any signed-in person could read the files if they knew where they were)
--  2. People with EO-Office can delete (replace) those files, not only the uploader within 24 hours
--  3. A collection receipt can be changed only by people with EO-Office access
--  4. The old private-code column of QC forms is removed; two people changing the paper copies at once cannot lose a file
-- Run once in the Supabase SQL Editor after 025_qc_simple.sql. It is safe to run again.
-- =====================================================================

drop policy if exists "storage records: eooffice files" on storage.objects;
create policy "storage records: eooffice files" on storage.objects as restrictive for select to authenticated
  using (bucket_id <> 'records' or coalesce((storage.foldername(name))[1], '') not in ('qc', 'collection')
         or ((select public.is_staff()) and (select public.has_module('eooffice'))));

drop policy if exists "storage records: purchase files" on storage.objects;
create policy "storage records: purchase files" on storage.objects as restrictive for select to authenticated
  using (bucket_id <> 'records' or coalesce((storage.foldername(name))[1], '') <> 'purchase' or (select public.is_staff()));

drop policy if exists "storage records: eooffice delete" on storage.objects;
create policy "storage records: eooffice delete" on storage.objects for delete to authenticated
  using (bucket_id = 'records' and coalesce((storage.foldername(name))[1], '') in ('qc', 'collection')
         and (select public.is_staff()) and (select public.has_module('eooffice')));

alter table public.qc_results drop column if exists code_hash;

create or replace function public.set_collection_receipt(p_id uuid, p_path text) returns text
language plpgsql security definer set search_path = '' as $$
declare v public.collection_vouchers;
begin
  if not (public.is_admin() or public.qc_can_write()) then raise exception 'Not allowed'; end if;
  select * into v from public.collection_vouchers where id = p_id for update;
  if not found then raise exception 'Collection voucher not found'; end if;
  if not (public.is_admin() or (v.created_by = auth.uid() and v.created_at > now() - interval '24 hours')) then raise exception 'Only the Director can change this voucher now'; end if;
  if p_path is not null and p_path not like 'collection/' || p_id || '/%' then raise exception 'Wrong file'; end if;
  update public.collection_vouchers set receipt_path = p_path, updated_at = now() where id = p_id;
  return v.receipt_path;
end;
$$;
revoke execute on function public.set_collection_receipt(uuid, text) from public, anon;
grant execute on function public.set_collection_receipt(uuid, text) to authenticated;

create or replace function public.qc_set_docs(p_id uuid, p_docs text[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare old text[];
begin
  if not public.qc_can_write() then raise exception 'Not allowed'; end if;
  perform 1 from public.qc_results where qc_id = p_id for update;
  if not found then raise exception 'QC form not found'; end if;
  if coalesce(array_length(p_docs, 1), 0) > 6 then raise exception 'Up to 6 pictures'; end if;
  if exists (select 1 from unnest(p_docs) x where x not like 'qc/' || p_id || '/%') then raise exception 'Wrong file'; end if;
  select docs into old from public.qc_results where qc_id = p_id;
  update public.qc_results set docs = coalesce(p_docs, '{}') where qc_id = p_id;
  return jsonb_build_object('ok', true, 'removed', to_jsonb(array(select x from unnest(old) x where x <> all (coalesce(p_docs, '{}')))));
end;
$$;
revoke execute on function public.qc_set_docs(uuid, text[]) from public, anon;
grant execute on function public.qc_set_docs(uuid, text[]) to authenticated;

select 'UPDATE 3.4 READY - EO-Office fixes' as result;
