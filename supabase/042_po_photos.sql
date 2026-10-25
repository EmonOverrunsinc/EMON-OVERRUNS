-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.32: a purchase order takes up to 5 product photos (it was 2). The approved purchase
-- order keeps a small copy of each of them (up to 5) for its PDF. Needs 023_purchase_orders.sql. Safe to run again.
-- =====================================================================
do $$ begin
  if to_regclass('public.purchase_orders') is null then raise exception 'Run 023_purchase_orders.sql first, then run this again.'; end if;
end $$;

-- 1. the product photos (up to 5), set by the maker after the upload
create or replace function public.set_purchase_photos(p_id uuid, p_photos text[]) returns public.purchase_orders
language plpgsql security definer set search_path = '' as $$
declare po public.purchase_orders;
begin
  select * into po from public.purchase_orders where id = p_id for update;
  if not found then raise exception 'Purchase order not found'; end if;
  if po.status not in ('pending','negotiation') then raise exception 'The photos cannot be changed now'; end if;
  if not (public.is_admin() or po.created_by = auth.uid()) then raise exception 'Not allowed'; end if;
  if coalesce(array_length(p_photos, 1), 0) > 5 then raise exception 'Up to 5 product photos'; end if;
  if exists (select 1 from unnest(p_photos) x where x not like 'purchase/' || p_id || '/%') then raise exception 'Wrong photo'; end if;
  update public.purchase_orders set photos = coalesce(p_photos, '{}'), updated_at = now() where id = p_id returning * into po;
  return po;
end;
$$;
revoke execute on function public.set_purchase_photos(uuid, text[]) from public, anon;
grant execute on function public.set_purchase_photos(uuid, text[]) to authenticated;

-- 2. the small copies for the PDF of the approved purchase order (up to 5); one month after approval the full photos
--    are deleted and the PDF keeps showing the small copies
create or replace function public.purchase_order_photos(p_id uuid, p_action text, p_print text[] default null) returns text[]
language plpgsql security definer set search_path = '' as $$
declare po public.purchase_orders; gone text[];
begin
  if not public.is_admin() then raise exception 'Only the Director'; end if;
  select * into po from public.purchase_orders where id = p_id for update;
  if not found or po.status <> 'approved' then raise exception 'Purchase order not approved'; end if;
  if p_action = 'print' then
    if coalesce(array_length(p_print, 1), 0) > 5 or exists (select 1 from unnest(p_print) x where x not like 'data:image/jpeg;base64,%' or length(x) > 400000) then
      raise exception 'Wrong print photos';
    end if;
    update public.purchase_orders set print_photos = p_print where id = p_id;
    return '{}';
  elsif p_action = 'expire' then
    if po.approved_at > now() - interval '30 days' or coalesce(array_length(po.print_photos, 1), 0) = 0 then return '{}'; end if;
    gone := po.photos;
    update public.purchase_orders set photos = '{}' where id = p_id;
    return gone;
  end if;
  raise exception 'Unknown action %', p_action;
end;
$$;
revoke execute on function public.purchase_order_photos(uuid, text, text[]) from public, anon;
grant execute on function public.purchase_order_photos(uuid, text, text[]) to authenticated;

select 'UPDATE 3.32 READY - Purchase Order takes up to 5 photos' as result;
