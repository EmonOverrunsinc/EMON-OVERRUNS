-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.53: DOWNLOAD FORMS - HIDE / SHOW
-- The Director hides or shows each form on Download Forms (an uploaded form, and the forms of the E-Portal itself:
-- Signature Verification, Job Application, QC Test). A hidden form is seen only by the Director.
-- Needs 060_salary_months.sql. Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again.
-- The last line says: UPDATE 3.53 READY - ...
-- =====================================================================
alter table public.forms add column if not exists visible boolean not null default true;
alter table public.company_settings add column if not exists hidden_forms text[] not null default '{}';

-- read: a hidden form only by the Director
drop policy if exists "forms: active read" on public.forms;
create policy "forms: active read" on public.forms for select to authenticated
  using ((select public.is_active()) and (visible or (select public.is_admin())));

-- the Director hides or shows a form: p_key is an uploaded form's id, or the name of a form of the E-Portal
-- ('signature', 'jobapp', 'qc')
create or replace function public.set_form_visible(p_key text, p_visible boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Only the Director can hide or show a form'; end if;
  if p_key in ('signature', 'jobapp', 'qc') then
    update public.company_settings set hidden_forms = case when p_visible then array_remove(hidden_forms, p_key)
      else array_append(array_remove(hidden_forms, p_key), p_key) end where id = 1;
  else
    update public.forms set visible = p_visible where id = p_key::uuid;
    if not found then raise exception 'Form not found'; end if;
  end if;
end;
$$;
revoke execute on function public.set_form_visible(text, boolean) from public, anon;
grant execute on function public.set_form_visible(text, boolean) to authenticated;

notify pgrst, 'reload schema';

select case when to_regprocedure('public.set_form_visible(text,boolean)') is not null
  then 'UPDATE 3.53 READY - the Director hides or shows each form on Download Forms'
  else 'NOT READY - send this message to Claude' end as result;
