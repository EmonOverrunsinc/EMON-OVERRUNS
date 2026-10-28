-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.39: the Director deletes any purchase order (lot), also an APPROVED one (for example a
-- wrong or test lot). Its notices go too; its photos and voice notes are given back so their files are deleted.
-- Only the Director. Safe to run again.
-- =====================================================================
create or replace function public.delete_purchase_order(p_id uuid) returns text[]
language plpgsql security definer set search_path = '' as $$
declare po public.purchase_orders;
begin
  if not public.is_admin() then raise exception 'Only the Director can delete a purchase order'; end if;
  select * into po from public.purchase_orders where id = p_id for update;
  if not found then raise exception 'Purchase order not found'; end if;
  delete from public.notifications where title like 'Purchase order ' || po.po_no || ' %';
  delete from public.purchase_orders where id = p_id;
  return coalesce(po.photos, '{}') || coalesce(po.voices, '{}');
end;
$$;
revoke execute on function public.delete_purchase_order(uuid) from public, anon;
grant execute on function public.delete_purchase_order(uuid) to authenticated;

select case when position('cannot be deleted' in pg_get_functiondef('public.delete_purchase_order(uuid)'::regprocedure)) = 0
  then 'UPDATE 3.39 READY - the Director can delete any lot (purchase order), also an approved one'
  else 'NOT READY - send this message to Claude' end as result;
