-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.54: THE DIRECTOR EDITS A COMPLETED CUSTOMER ORDER
-- A COMPLETED order (delivered, with its invoice) can be changed by the Director: Edit on the order page, and its boxes
-- (add, change, remove). Saving it changes its invoice too (boxes, pcs, amount, terms, order date), so the order and the
-- invoice always say the same; the statements of account follow by themselves. Staff cannot change a completed order.
-- The customer of a completed order stays the same, and the amount cannot go below the payments linked to its invoice.
-- Needs RUN_060_TO_061.sql (already run). Paste all of it in Supabase > SQL Editor > New query and press Run.
-- Safe to run again. The last line says: UPDATE 3.54 READY - ...
-- =====================================================================
do $$
declare def text; n text;
  -- save_customer_order: the Director may change a completed order (of an account that is not ACTIVE any more too)
  s_old1 text := 'if o.status not in (''pending'',''approved'') then raise exception ''Order % is % and cannot be changed''';
  s_new1 text := 'if o.status not in (''pending'',''approved'') and not (boss and o.status = ''completed'') then raise exception ''Order % is % and cannot be changed''';
  s_old2 text := 'if c.status <> ''active'' then raise exception ''An order is made only for an ACTIVE account';
  s_new2 text := 'if c.status <> ''active'' and not exists (select 1 from public.customer_orders x where x.id = p_id and x.status = ''completed'' and x.customer_id = c.id) then raise exception ''An order is made only for an ACTIVE account';
  s_old3 text := '  if p_id is null and o.status = ''pending'' then';
  s_new3 text := '  -- 3.54: a completed order changes its invoice too
  if o.status = ''completed'' and o.invoice_id is not null then
    if (select customer_id from public.customer_invoices where id = o.invoice_id) is distinct from o.customer_id then
      raise exception ''Order % is completed: its customer cannot be changed (the invoice is for that customer)'', o.order_no;
    end if;
    if (select coalesce(sum(amount), 0) from public.payment_links where invoice_id = o.invoice_id and removed_at is null) > o.total_amount then
      raise exception ''Payments of PHP % are linked to the invoice of order %: the amount cannot be less than that'',
        to_char((select sum(amount) from public.payment_links where invoice_id = o.invoice_id and removed_at is null), ''FM999,999,990.00''), o.order_no;
    end if;
    perform public.allow_record_change();
    update public.customer_invoices set total_boxes = o.total_boxes, total_pcs = o.total_pcs, total_amount = o.total_amount,
      payment_terms = o.payment_terms, purchase_date = o.order_date where id = o.invoice_id;
    perform set_config(''eo.allow_change'', ''off'', true);
  end if;
  if p_id is null and o.status = ''pending'' then';
  -- the boxes of a completed order: the Director adds, changes and removes them
  b_old1 text := 'if o.status not in (''pending'',''approved'') then raise exception ''Order % is %: boxes cannot be added''';
  b_new1 text := 'if o.status not in (''pending'',''approved'') and not (o.status = ''completed'' and public.is_admin()) then raise exception ''Order % is %: boxes cannot be added''';
  b_old2 text := 'if st not in (''pending'',''approved'') then raise exception ''Order % is %: its boxes cannot be changed''';
  b_new2 text := 'if st not in (''pending'',''approved'') and not (st = ''completed'' and public.is_admin()) then raise exception ''Order % is %: its boxes cannot be changed''';
begin
  def := pg_get_functiondef('public.save_customer_order(uuid,jsonb)'::regprocedure);
  if position('3.54: a completed order' in def) = 0 then
    if position(s_old1 in def) = 0 or position(s_old2 in def) = 0 or position(s_old3 in def) = 0 then
      raise exception 'Update 3.54: save_customer_order has changed - send this message to Claude';
    end if;
    execute replace(replace(replace(def, s_old1, s_new1), s_old2, s_new2), s_old3, s_new3);
  end if;
  foreach n in array array['public.add_order_box(uuid,jsonb)', 'public.change_order_box(uuid,jsonb)'] loop
    def := pg_get_functiondef(n::regprocedure);
    if position('''completed'' and public.is_admin()' in def) > 0 then continue; end if;
    if position(b_old1 in def) = 0 and position(b_old2 in def) = 0 then
      raise exception 'Update 3.54: % has changed - send this message to Claude', n;
    end if;
    execute replace(replace(def, b_old1, b_new1), b_old2, b_new2);
  end loop;
end $$;

notify pgrst, 'reload schema';

select case when position('3.54: a completed order' in pg_get_functiondef('public.save_customer_order(uuid,jsonb)'::regprocedure)) > 0
  and position('''completed'' and public.is_admin()' in pg_get_functiondef('public.add_order_box(uuid,jsonb)'::regprocedure)) > 0
  and position('''completed'' and public.is_admin()' in pg_get_functiondef('public.change_order_box(uuid,jsonb)'::regprocedure)) > 0
  then 'UPDATE 3.54 READY - the Director edits a completed customer order (like ARS-2); its invoice changes with it'
  else 'NOT READY - send this message to Claude' end as result;
