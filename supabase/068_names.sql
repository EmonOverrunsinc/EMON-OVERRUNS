-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.61: YOUR NAME, NOT "THE DIRECTOR"
-- Every message of the server (errors, notices, approvals) says EMON HASAN instead of "the Director" / "the main Director"
-- (for example: "Only EMON HASAN can delete a salary payment", "... ask EMON HASAN to unlock them").
-- Nothing else changes: no data, no rights. Paste all of it in Supabase > SQL Editor > New query and press Run.
-- Safe to run again. The last line says: UPDATE 3.61 READY - ...
-- =====================================================================
do $$
declare f record; def text; n int := 0;
begin
  for f in select p.oid from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
             and pg_get_functiondef(p.oid) ~ '(the main Director|The main Director|the Director|The Director|pproved by Director )' loop
    def := pg_get_functiondef(f.oid);
    def := replace(replace(def, 'the main Director', 'EMON HASAN'), 'The main Director', 'EMON HASAN');
    def := replace(replace(def, 'the Director', 'EMON HASAN'), 'The Director', 'EMON HASAN');
    def := replace(replace(def, 'Approved by Director ', 'Approved by '), 'approved by Director ', 'approved by ');
    execute def;
    n := n + 1;
  end loop;
  raise notice 'Update 3.61: % server functions now say EMON HASAN', n;
end $$;

notify pgrst, 'reload schema';

select case when not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
    and pg_get_functiondef(p.oid) ~ '(the Director|The Director)')
  then 'UPDATE 3.61 READY - every message of the server says EMON HASAN instead of "the Director"'
  else 'NOT READY - send this message to Claude' end as result;
