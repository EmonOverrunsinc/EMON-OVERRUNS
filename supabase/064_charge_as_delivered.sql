-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.56: THE INVOICE CHARGES THE PCS DELIVERED (THE DELIVERY LIST)
-- Every box delivered goes to the order line with the same BATCH NO and CODE (else the same product) and is charged at
-- that line's price per pc. So the invoice is the pcs of the delivery list x the price: more pcs delivered are charged
-- more, fewer pcs are charged less (a line with no box delivered is not charged). The order keeps what was ordered.
-- * A completed order's invoice follows by itself when its boxes change (added, changed, removed) or the order is edited.
-- * Boxes without pcs (0) are charged as ordered; an order with no pcs on its boxes is charged as ordered.
-- * A box that matches no line is charged at the order's average price per pc.
-- * A line with no boxes (e.g. a fee) is charged as ordered.
-- * The invoice cannot go below the payments linked to it.
-- * The invoices of the orders completed before this update are charged as delivered now (not below linked payments).
-- Needs 063_payroll_pay_salary.sql. Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again.
-- The last line says: UPDATE 3.56 READY - ...
-- =====================================================================

-- what an order delivered: each line with the pcs of its boxes and the amount, and the totals
create or replace function public.co_delivered(p_order uuid) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare o public.customer_orders; res jsonb;
begin
  select * into o from public.customer_orders where id = p_order;
  if not found then return null; end if;
  with ln as (
    select (x.ord - 1)::int as i, x.v, upper(trim(coalesce(x.v ->> 'code', ''))) as code, upper(trim(coalesce(x.v ->> 'lot', ''))) as lot,
      upper(trim(coalesce(x.v ->> 'product', ''))) as prod, coalesce(nullif(x.v ->> 'price', '')::numeric, 0) as price,
      coalesce(nullif(x.v ->> 'qty', '')::numeric, 0) as qty, coalesce(nullif(x.v ->> 'boxes', '')::numeric, 0) as nbox,
      coalesce(nullif(x.v ->> 'amount', '')::numeric, coalesce(nullif(x.v ->> 'qty', '')::numeric, 0) * coalesce(nullif(x.v ->> 'price', '')::numeric, 0)) as amt
    from jsonb_array_elements(coalesce(o.lines, '[]'::jsonb)) with ordinality x(v, ord)
  ), bx as (
    select b.id, b.serial_no, upper(trim(coalesce(b.code, ''))) as code, upper(trim(coalesce(b.batch_no, ''))) as lot,
      upper(trim(coalesce(b.items, ''))) as item, coalesce(b.pcs, 0) as pcs
    from public.customer_order_boxes b where b.order_id = p_order
  ), pick as (
    select bx.*, m.i, m.rk from bx left join lateral (
      select ln.i, case when ln.code = bx.code and ln.lot = bx.lot then 0
          when bx.lot <> '' and ln.lot = bx.lot and (ln.code = '' or bx.code = '') then 1
          when bx.code <> '' and ln.code = bx.code and (ln.lot = '' or bx.lot = '') then 2
          when bx.item <> '' and ln.prod = bx.item then 3
          when bx.item <> '' and ln.prod <> '' and (position(ln.prod in bx.item) > 0 or position(bx.item in ln.prod) > 0) then 4
          when (select count(*) from ln l2 where l2.nbox > 0) = 1 then 5 else 9 end as rk
      from ln where ln.nbox > 0 order by 2, ln.i limit 1) m on true
  ), per as (
    select ln.i, ln.v, ln.price, ln.qty, ln.nbox, ln.amt,
      count(p.id) filter (where p.rk < 9) as boxes_in, coalesce(sum(p.pcs) filter (where p.rk < 9), 0) as pcs_in,
      count(p.id) filter (where p.rk < 9 and p.pcs = 0) as zero_in
    from ln left join pick p on p.i = ln.i group by ln.i, ln.v, ln.price, ln.qty, ln.nbox, ln.amt
  ), tot as (select coalesce(sum(pcs), 0) as pcs, count(*) filter (where serial_no is not null) as boxes from bx),
  lines as (
    select per.*, case when per.nbox = 0 or per.zero_in > 0 or (select pcs from tot) = 0 then per.qty else per.pcs_in end as dqty
    from per
  ), lines2 as (
    select lines.*, case when lines.nbox = 0 or lines.zero_in > 0 or (select pcs from tot) = 0 then lines.amt else round(lines.dqty * lines.price, 2) end as damt from lines
  ), odd as (
    select coalesce(sum(p.pcs), 0) as pcs from pick p where p.rk = 9
  )
  select jsonb_build_object(
    'has_pcs', (select pcs from tot) > 0,
    'boxes', (select boxes from tot),
    'pcs', (select coalesce(sum(dqty), 0) from lines2) + (select pcs from odd),
    'odd_pcs', (select pcs from odd),
    'odd_amount', round((select pcs from odd) * case when o.total_pcs > 0 then o.total_amount / o.total_pcs else 0 end, 2),
    'ordered_amount', o.total_amount, 'ordered_pcs', o.total_pcs,
    'amount', (select coalesce(sum(damt), 0) from lines2) + round((select pcs from odd) * case when o.total_pcs > 0 then o.total_amount / o.total_pcs else 0 end, 2),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('i', i, 'product', v ->> 'product', 'code', v ->> 'code', 'lot', v ->> 'lot', 'price', price,
       'ordered', qty, 'delivered', dqty, 'boxes', boxes_in, 'amount', damt, 'ordered_amount', amt) order by i) from lines2), '[]'::jsonb))
  into res;
  return res;
end;
$$;
revoke execute on function public.co_delivered(uuid) from public, anon;
grant execute on function public.co_delivered(uuid) to authenticated;

-- a completed order's invoice: charged as delivered (boxes, pcs, amount); not below the payments linked to it
create or replace function public.co_charge_as_delivered(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.customer_orders; d jsonb; amt numeric; linked numeric;
begin
  select * into o from public.customer_orders where id = p_order;
  if not found or o.status <> 'completed' or o.invoice_id is null then return; end if;
  d := public.co_delivered(p_order);
  amt := (d ->> 'amount')::numeric;
  select coalesce(sum(amount), 0) into linked from public.payment_links where invoice_id = o.invoice_id and removed_at is null;
  if linked > amt then
    raise exception 'Payments of PHP % are linked to the invoice of order %: the delivery (PHP %) cannot be charged less than that',
      to_char(linked, 'FM999,999,990.00'), o.order_no, to_char(amt, 'FM999,999,990.00');
  end if;
  perform public.allow_record_change();
  update public.customer_invoices set total_amount = amt, total_pcs = round((d ->> 'pcs')::numeric)::int,
    total_boxes = case when (d ->> 'has_pcs')::boolean then (d ->> 'boxes')::int else o.total_boxes end
  where id = o.invoice_id and (total_amount, total_pcs, total_boxes) is distinct from
    (amt, round((d ->> 'pcs')::numeric)::int, case when (d ->> 'has_pcs')::boolean then (d ->> 'boxes')::int else o.total_boxes end);
  perform set_config('eo.allow_change', 'off', true);
end;
$$;
revoke execute on function public.co_charge_as_delivered(uuid) from public, anon, authenticated;

-- the boxes of a completed order change: its invoice follows
create or replace function public.co_boxes_charge() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.co_charge_as_delivered(case when tg_op = 'DELETE' then old.order_id else new.order_id end);
  return null;
end;
$$;
revoke execute on function public.co_boxes_charge() from public, anon, authenticated;
drop trigger if exists co_boxes_charge on public.customer_order_boxes;
create trigger co_boxes_charge after insert or update or delete on public.customer_order_boxes
  for each row execute function public.co_boxes_charge();

do $$
declare def text;
  c_old text := '  where id = p_id returning * into o;';
  c_new text := '  where id = p_id returning * into o;
  perform public.co_charge_as_delivered(p_id); -- 3.56: charged as delivered';
  s_new text := '-- 3.54: a completed order changes its invoice too; 3.56: charged as delivered (the pcs of its boxes x the price of their line)
  if o.status = ''completed'' and o.invoice_id is not null then
    if (select customer_id from public.customer_invoices where id = o.invoice_id) is distinct from o.customer_id then
      raise exception ''Order % is completed: its customer cannot be changed (the invoice is for that customer)'', o.order_no;
    end if;
    perform public.allow_record_change();
    update public.customer_invoices set payment_terms = o.payment_terms, purchase_date = o.order_date where id = o.invoice_id;
    perform set_config(''eo.allow_change'', ''off'', true);
    perform public.co_charge_as_delivered(o.id);
  end if;';
begin
  -- completing an order: the invoice is charged as delivered
  def := pg_get_functiondef('public.complete_customer_order(uuid)'::regprocedure);
  if position('3.56: charged as delivered' in def) = 0 then
    if position(c_old in def) = 0 then raise exception 'Update 3.56: complete_customer_order has changed - send this message to Claude'; end if;
    execute replace(def, c_old, c_new);
  end if;
  -- editing a completed order (3.54): the invoice is charged as delivered
  def := pg_get_functiondef('public.save_customer_order(uuid,jsonb)'::regprocedure);
  if position('3.56: charged as delivered' in def) = 0 then
    if position('-- 3.54: a completed order changes its invoice too' in def) = 0 then raise exception 'Update 3.56: run 062_edit_completed_order.sql first'; end if;
    execute regexp_replace(def, '-- 3\.54: a completed order changes its invoice too.*?perform set_config\(''eo\.allow_change'', ''off'', true\);\s*end if;', s_new);
  end if;
end $$;

-- the orders completed before: their invoices are charged as delivered (one that would go below its linked payments stays)
create temp table if not exists charge_result (line text);
truncate charge_result;
do $$
declare r record; before numeric; after numeric;
begin
  for r in select o.id, o.order_no, o.invoice_id from public.customer_orders o where o.status = 'completed' and o.invoice_id is not null order by o.order_no loop
    select total_amount into before from public.customer_invoices where id = r.invoice_id;
    begin
      perform public.co_charge_as_delivered(r.id);
      select total_amount into after from public.customer_invoices where id = r.invoice_id;
      if after is distinct from before then
        insert into charge_result values (r.order_no || '  PHP ' || to_char(before, 'FM999,999,990.00') || ' -> ' || to_char(after, 'FM999,999,990.00'));
      end if;
    exception when others then
      insert into charge_result values (r.order_no || '  NOT CHANGED: ' || sqlerrm);
    end;
  end loop;
end $$;

notify pgrst, 'reload schema';

select line as result from charge_result
union all
select case when to_regprocedure('public.co_delivered(uuid)') is not null
  and position('3.56: charged as delivered' in pg_get_functiondef('public.complete_customer_order(uuid)'::regprocedure)) > 0
  and position('3.56: charged as delivered' in pg_get_functiondef('public.save_customer_order(uuid,jsonb)'::regprocedure)) > 0
  then 'UPDATE 3.56 READY - the invoice charges the pcs delivered (batch no + code = the price of the order line)'
  else 'NOT READY - send this message to Claude' end;
