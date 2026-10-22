-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.24: all the job application details on the employee
-- The Director fills the paper job application with the new employee, then types everything into New Employee:
-- permanent address, father's / mother's / spouse's name, date and place of birth, BRC / NID / passport no,
-- gender, religion, blood group, duty hours, education and work experience.
-- Safe to run again.
-- =====================================================================
alter table public.employees add column if not exists permanent_address text;
alter table public.employees add column if not exists father_name text;
alter table public.employees add column if not exists mother_name text;
alter table public.employees add column if not exists spouse_name text;
alter table public.employees add column if not exists date_of_birth date;
alter table public.employees add column if not exists birth_place text;
alter table public.employees add column if not exists id_number text;
alter table public.employees add column if not exists gender text;
alter table public.employees add column if not exists religion text;
alter table public.employees add column if not exists blood_group text;
alter table public.employees add column if not exists duty_hours text;
alter table public.employees add column if not exists education jsonb not null default '[]'::jsonb;
alter table public.employees add column if not exists experience jsonb not null default '[]'::jsonb;

select 'UPDATE 3.24 READY - Employee details' as result;
