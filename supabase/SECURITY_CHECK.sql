-- =====================================================================
-- EMON OVERRUNS E-PORTAL - SECURITY CHECK (READ ONLY: it changes nothing)
-- Paste all of it in Supabase > SQL Editor > New query and press Run. Every line should say OK.
-- A line that says CHECK: send a screenshot to Claude.
-- =====================================================================
with t as (
  select 1 as n, case when count(*) = 0 then 'OK     every table is protected by row level security'
    else 'CHECK  tables WITHOUT row level security (anyone could read them): ' || string_agg(relname, ', ') end as result
  from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity
  union all
  select 2, case when count(*) = 0 then 'OK     no table can be changed by a visitor who is not signed in'
    else 'CHECK  tables a visitor can change: ' || string_agg(distinct tablename, ', ') end
  from pg_policies where schemaname = 'public' and ('anon' = any(roles) or 'public' = any(roles)) and cmd <> 'SELECT'
  union all
  select 3, 'OK     tables a visitor can read (public on purpose): ' || coalesce(string_agg(distinct tablename, ', '), 'none')
  from pg_policies where schemaname = 'public' and ('anon' = any(roles) or 'public' = any(roles)) and cmd = 'SELECT'
  union all
  select 4, case when count(*) = 0 then 'OK     every view follows the rules of its tables (security invoker)'
    else 'CHECK  views that skip the table rules: ' || string_agg(relname, ', ') end
  from pg_class where relnamespace = 'public'::regnamespace and relkind = 'v'
    and not coalesce('security_invoker=true' = any(reloptions) or 'security_invoker=on' = any(reloptions), false)
  union all
  select 5, case when count(*) = 0 then 'OK     every special function has a fixed search path'
    else 'CHECK  special functions without a fixed search path: ' || string_agg(proname, ', ') end
  from pg_proc p where pronamespace = 'public'::regnamespace and prosecdef
    and not exists (select 1 from unnest(coalesce(proconfig, '{}')) c where c like 'search_path=%')
  union all
  select 6, case when count(*) filter (where proname not in ('card_set_password','card_state','check_employee_card','co_paper_folder',
      'delivery_add_box','delivery_complete','delivery_find_box','delivery_order','delivery_photos','delivery_remove_box','delivery_save',
      'login_email','submit_contact_message','username_available','verify_record')) = 0
    then 'OK     visitors can run only the public functions (sign-in, ID card, delivery paper with its secret code, verify, contact us)'
    else 'CHECK  other functions a visitor can run: ' || string_agg(proname, ', ') filter (where proname not in ('card_set_password','card_state',
      'check_employee_card','co_paper_folder','delivery_add_box','delivery_complete','delivery_find_box','delivery_order','delivery_photos',
      'delivery_remove_box','delivery_save','login_email','submit_contact_message','username_available','verify_record')) end
  from pg_proc p where pronamespace = 'public'::regnamespace and prosecdef and has_function_privilege('anon', p.oid, 'execute')
  union all
  select 7, case when to_regprocedure('public.verify_record_full(text)') is not null and not has_function_privilege('anon', 'public.verify_record_full(text)', 'execute')
    then 'OK     the public Verify page shows no names or amounts to visitors (3.57)'
    else 'CHECK  run RUN_062_TO_067.sql: the public Verify page still shows names and amounts by record number' end
  union all
  select 8, case when count(*) filter (where public and id not in ('branding', 'avatars')) = 0
    then 'OK     files (documents, records, forms, AI) are private; only the logo and profile photos are public'
    else 'CHECK  public file buckets: ' || string_agg(id, ', ') filter (where public and id not in ('branding', 'avatars')) end
  from storage.buckets
  union all
  select 9, case when to_regprocedure('private.guard(text,integer)') is not null
    and position('private.guard(' in pg_get_functiondef('public.verify_record(text)'::regprocedure)) > 0
    then 'OK     robots get only a few tries a minute on the public pages (3.58)'
    else 'CHECK  run RUN_062_TO_067.sql: robots can try the public pages without a limit' end
  union all
  select 10, 'INFO   Director logins: ' || count(*) || ' (keep it to the people you trust)'
  from public.profiles where role = 'admin' and status = 'active'
)
select result from t order by n;
