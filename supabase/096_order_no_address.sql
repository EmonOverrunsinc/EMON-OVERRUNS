-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.99.2: AN ORDER SHOWS NO ADDRESS (PERSONAL DATA)
-- The Complete Delivery page (opened by the QR code of the printed order, also by a person who is not signed in) no
-- longer receives the customer's address from the database.
-- Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again.
-- The last line says: UPDATE 3.99.2 READY - ...
-- =====================================================================
do $$
declare def text := pg_get_functiondef('public.delivery_order(text,text)'::regprocedure);
  a constant text := ' ''address'', coalesce(o.address, c.address),';
begin
  if position('''address''' in def) > 0 then
    if position(a in def) = 0 then raise exception 'Update 3.99.2: delivery_order has changed - send this message to Claude'; end if;
    def := replace(def, a, '');
    execute def;
  end if;
end $$;

notify pgrst, 'reload schema';

select case when position('''address''' in pg_get_functiondef('public.delivery_order(text,text)'::regprocedure)) = 0
  then 'UPDATE 3.99.2 READY - the Complete Delivery page gets no customer address'
  else 'NOT READY - send this message to Claude' end as result;
