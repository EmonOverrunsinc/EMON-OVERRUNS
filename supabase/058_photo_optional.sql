-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.47: the DELIVERY PHOTO is optional
-- COMPLETE DELIVERY (and SUBMIT on the order paper's page) works with or without a photo. Photos added are kept as before.
-- Needs RUN_056_057.sql (already run). Safe to run again.
-- =====================================================================
do $$
declare f text; def text;
begin
  if to_regprocedure('public.decide_delivery(uuid,text)') is null then raise exception 'Run RUN_056_057.sql first, then run this again.'; end if;
  foreach f in array array['complete_customer_order(uuid)', 'delivery_complete(text,text)'] loop
    def := pg_get_functiondef(('public.' || f)::regprocedure);
    if position('Add a delivery photo first' in def) > 0 then
      def := replace(replace(def, 'if cardinality(o.delivery_photos) = 0 then raise exception ''Add a delivery photo first''; end if;', ''),
        'if cardinality(o.delivery_photos) = 0 then raise exception ''Add a delivery photo first''; end if;', '');
      if position('Add a delivery photo first' in def) > 0 then raise exception 'Could not update %', f; end if;
      execute def;
    end if;
  end loop;
end $$;

select case when position('Add a delivery photo first' in pg_get_functiondef('public.complete_customer_order(uuid)'::regprocedure)) = 0
    and position('Add a delivery photo first' in pg_get_functiondef('public.delivery_complete(text,text)'::regprocedure)) = 0
  then 'UPDATE 3.47 READY - the delivery photo is optional'
  else 'NOT READY - send this message to Claude' end as result;
