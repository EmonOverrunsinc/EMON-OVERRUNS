-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.7: Released Notice written on the E-Bill itself (no order letter, no Director Portal)
-- The person with E-Bill access writes the Released Notice on the e-bill: released date, price per box (PHP), exchange rate
-- (BDT for 1 PHP), shipping fee (BDT), shipping bill no. The portal works out
--   price per box x total boxes = PHP, x exchange rate = released charge (BDT), + shipping fee = added to the total cost.
-- The e-bill becomes RELEASED at once; the notice is numbered RN-YYYYMM-###. The Director can undo a notice that has no
-- sales report yet (the e-bill goes back to SHIP).
-- Run once in the Supabase SQL Editor after 026_eo_office_fixes.sql. It is safe to run again.
-- =====================================================================

create or replace function public.release_stock_bill(p_id uuid, p_data jsonb) returns public.stock_bills
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare
  b public.stock_bills; me text := (select full_name from public.profiles where id = auth.uid());
  d date := nullif(p_data ->> 'release_date', '')::date;
  price numeric := nullif(p_data ->> 'price_per_box', '')::numeric;
  rate numeric := nullif(p_data ->> 'exchange_rate', '')::numeric;
  ship numeric := nullif(p_data ->> 'shipping_cost', '')::numeric;
  php numeric; bdt numeric; no text;
begin
  if not public.can_write('inventory') then raise exception 'You do not have access to release e-bills'; end if;
  select * into b from public.stock_bills where id = p_id for update;
  if b.id is null then raise exception 'E-Bill not found'; end if;
  if b.status not in ('shipped', 'arrived') then
    raise exception 'E-Bill % is already at %. Only an e-bill at SHIP can be released', b.bill_no, public.ebill_status_name(b.status);
  end if;
  if coalesce(b.total_boxes, 0) <= 0 then raise exception 'E-Bill % has no total boxes. Correct the e-bill first', b.bill_no; end if;
  if d is null then raise exception 'Enter the released date'; end if;
  if b.shipment_date is not null and d < b.shipment_date then raise exception 'The released date cannot be before the shipment date'; end if;
  if coalesce(price, 0) <= 0 then raise exception 'Enter the price per box (PHP)'; end if;
  if coalesce(rate, 0) <= 0 then raise exception 'Enter the exchange rate (BDT for 1 PHP)'; end if;
  if ship is null or ship < 0 then raise exception 'Enter the shipping fee (0 if there is none)'; end if;
  php := round(price * b.total_boxes, 2);
  bdt := round(php * rate, 2);
  no := 'RN-' || to_char(d, 'YYYYMM') || '-' || lpad(public.next_counter('RN' || to_char(d, 'YYYYMM'))::text, 3, '0');
  perform public.allow_record_change();
  update public.stock_bills set status = 'released', release_date = d, shipping_cost = ship, shipping_bill_no = nullif(left(trim(coalesce(p_data ->> 'shipping_bill_no', '')), 60), ''),
    release_order_no = no, released_at = now(), release_price_per_box = price, release_exchange_rate = rate, release_php = php, release_bdt = bdt
  where id = p_id returning * into b;
  insert into public.stock_bill_events (stock_bill_id, action, note, actor, actor_name)
  values (p_id, 'released by ' || no,
    b.total_boxes || ' boxes × PHP ' || to_char(price, 'FM999,999,999,990.00') || ' = PHP ' || to_char(php, 'FM999,999,999,990.00') || ' × '
      || rtrim(rtrim(to_char(rate, 'FM999,990.0000'), '0'), '.') || ' = BDT ' || to_char(bdt, 'FM999,999,999,990.00') || ' · Shipping fee BDT ' || to_char(ship, 'FM999,999,999,990.00'),
    auth.uid(), me);
  return b;
end;
$$;
revoke execute on function public.release_stock_bill(uuid, jsonb) from public, anon;
grant execute on function public.release_stock_bill(uuid, jsonb) to authenticated;

create or replace function public.unrelease_stock_bill(p_id uuid) returns public.stock_bills
language plpgsql security definer set search_path = '' set timezone to 'Asia/Manila' as $$
declare b public.stock_bills; me text := (select full_name from public.profiles where id = auth.uid()); old text;
begin
  if not public.is_admin() then raise exception 'Only the Director can undo a Released Notice'; end if;
  select * into b from public.stock_bills where id = p_id for update;
  if b.id is null then raise exception 'E-Bill not found'; end if;
  if b.status <> 'released' then raise exception 'E-Bill % is at %: a Released Notice can be undone only while it is RELEASED', b.bill_no, public.ebill_status_name(b.status); end if;
  if exists (select 1 from public.stock_bill_entries x where x.stock_bill_id = p_id and x.entry_type = 'sales') then
    raise exception 'E-Bill % has a sales report. Delete it first, then undo the Released Notice', b.bill_no;
  end if;
  old := b.release_order_no;
  perform public.allow_record_change();
  update public.stock_bills set status = 'shipped', release_date = null, shipping_cost = null, shipping_bill_no = null, release_order_no = null, released_at = null,
    release_price_per_box = null, release_exchange_rate = null, release_php = null, release_bdt = null where id = p_id returning * into b;
  insert into public.stock_bill_events (stock_bill_id, action, note, actor, actor_name) values (p_id, 'released notice undone', old, auth.uid(), me);
  return b;
end;
$$;
revoke execute on function public.unrelease_stock_bill(uuid) from public, anon;
grant execute on function public.unrelease_stock_bill(uuid) to authenticated;

select 'UPDATE 3.7 READY - E-Bill Released Notice' as result;
