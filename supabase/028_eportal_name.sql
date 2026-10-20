-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.8: "E-PORTAL SYSTEM" (or "E-PORTAL SYSTEMS") becomes "E-PORTAL"
-- Wherever a saved name is exactly "E-Portal System" / "E-Portal Systems" (any capitals): the name of an account, "made by",
-- "prepared by", "issued by", "checked by" ... on the saved records. Only a whole name is changed; written notes and
-- messages are not touched. Nothing else is changed. Run once in the Supabase SQL Editor. It is safe to run again.
-- =====================================================================
do $$
declare c record; n bigint; total bigint := 0;
begin
  perform public.allow_record_change(); -- saved records are normally add-only; this one name change is allowed
  for c in
    select col.table_name, col.column_name
    from information_schema.columns col
    join information_schema.tables t on t.table_schema = col.table_schema and t.table_name = col.table_name
    where col.table_schema = 'public' and t.table_type = 'BASE TABLE' and col.data_type = 'text' and col.is_generated = 'NEVER'
    order by col.table_name, col.column_name
  loop
    execute format('update public.%I set %I = %L where regexp_replace(upper(btrim(%I)), %L, %L, %L) in (%L, %L)',
      c.table_name, c.column_name, 'E-PORTAL', c.column_name, '\s+', ' ', 'g', 'E-PORTAL SYSTEM', 'E-PORTAL SYSTEMS');
    get diagnostics n = row_count;
    total := total + n;
  end loop;
  perform set_config('eo.renamed', total::text, false);
end $$;

select 'UPDATE 3.8 READY - E-PORTAL name: ' || current_setting('eo.renamed', true) || ' saved name(s) changed' as result;
