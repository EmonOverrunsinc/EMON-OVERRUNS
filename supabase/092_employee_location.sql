-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.93: THE EMPLOYEE'S ASSIGNED LOCATION
-- EMON HASAN writes where an employee is assigned to work (the address of the workplace) on New / Edit Employee.
-- It shows on the employee's page and on the Employee Details print (with the approval, the ID card, the KYC ID and the
-- devices; no signature lines).
-- Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again.
-- The last line says: UPDATE 3.93 READY - ...
-- =====================================================================
alter table public.employees add column if not exists work_location text;

-- Edit Employee may change it too (the list of details EMON HASAN can edit gets work_location)
do $$
declare def text := pg_get_functiondef('public.director_edit_employee(uuid,jsonb)'::regprocedure);
begin
  if position('''work_location''' in def) = 0 then
    if position('''education'',''experience''];' in def) = 0 then raise exception 'Update 3.93: director_edit_employee has changed - send this message to Claude'; end if;
    def := replace(def, '''education'',''experience''];', '''education'',''experience'',''work_location''];');
    execute def;
  end if;
end $$;

notify pgrst, 'reload schema';

select case when position('''work_location''' in pg_get_functiondef('public.director_edit_employee(uuid,jsonb)'::regprocedure)) > 0
    and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employees' and column_name = 'work_location')
  then 'UPDATE 3.93 READY - employees have an Assigned Location (New / Edit Employee, the employee page and the Employee Details print)'
  else 'NOT READY - send this message to Claude' end as result;
