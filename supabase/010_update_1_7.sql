-- =====================================================================
-- EMON OVERRUNS E-PORTAL — Update 1.7
-- Wording. The top role is called "Director" (not "CEO") in every message from the database; a person without
-- a job position is shown as "Employee" (not "Staff") in Messages and Community; and some messages read better:
-- "This credit memo is APPROVED and cannot be approved" (was "Cannot approve a approved credit memo"),
-- history says "reactivated by ORDER-…" (was "active by ORDER-…"), Verification says "Additional Charge",
-- "Settlement Adjustment", "Promise to Pay", "Opening Balance" and "Closing Balance".
-- Each function is created again exactly as it is now (same settings, Manila time and permissions), with only these words changed.
-- No records are changed. Run once in the Supabase SQL Editor after 009_update_1_6.sql. It is safe to run again.
-- =====================================================================
do $$
declare
  -- function name ('*' = every function), the exact old text, the new text
  fixes text[][] := array[
    ['*', 'CEO', 'Director'],
    ['chat_contacts', 'when ''staff'' then ''Staff''', 'when ''staff'' then ''Employee'''],
    ['community_posts_before_insert', 'when ''staff'' then ''Staff''', 'when ''staff'' then ''Employee'''],
    ['set_my_username', 'That username is taken or not allowed (3-20 letters, numbers, dot or underscore)',
                        'That username is taken or not allowed (use 3-20 letters, numbers, dots or underscores)'],
    ['review_job_application', 'This application has no email to link a login', 'This application has no email address, so a login cannot be linked'],
    ['credit_memo_action', 'raise exception ''Cannot % a % credit memo'', p_action, m.status;',
                           'raise exception ''This credit memo is % and cannot be %'', upper(m.status), case p_action when ''approve'' then ''approved'' when ''reject'' then ''rejected'' when ''paid'' then ''marked as paid'' else p_action end;'],
    ['project_action', 'raise exception ''Cannot % a % project'', p_action, pr.status;',
                       'raise exception ''This project is % and cannot be %'', upper(pr.status), case p_action when ''approve'' then ''approved'' when ''reject'' then ''rejected'' when ''complete'' then ''completed'' else p_action end;'],
    ['order_letters_before_insert', 'An employee order is a suspension, reactivation, termination or memo', 'An employee order must be a suspension, reactivation, termination or memo'],
    ['order_letters_before_insert', 'A company order is a suspension, reactivation or memo', 'A company order must be a suspension, reactivation or memo'],
    ['order_letters_before_insert', 'Enter the amount the customer will pay and the date', 'Enter the amount the customer will pay and the promise date'],
    ['order_letters_before_insert', 'Choose whether the adjustment adds to the balance or takes it off', 'Choose whether the adjustment adds to the balance or reduces it'],
    ['carry_out_order', 'case o.subject_type when ''reopen'' then ''reopened'' when ''charge'' then',
                        'case o.subject_type when ''reopen'' then ''reopened'' when ''reactivation'' then ''reactivated'' when ''unpaid'' then ''unpaid balance notice'' when ''unsettled_balance'' then ''unsettled balance notice'' when ''other'' then ''order letter'' when ''charge'' then'],
    ['carry_out_order', 'only ACTIVE employees can be suspended', 'only ACTIVE or INACTIVE employees can be suspended'],
    ['verify_record', '''Opening (PHP)''', '''Opening Balance (PHP)'''],
    ['verify_record', '''Closing (PHP)''', '''Closing Balance (PHP)'''],
    ['verify_record', 'initcap(replace(r.subject_type, ''_'', '' ''))',
                      'case r.subject_type when ''promise_to_pay'' then ''Promise to Pay'' when ''charge'' then ''Additional Charge'' when ''settlement'' then ''Settlement Adjustment'' when ''unpaid'' then ''Unpaid Balance'' when ''reopen'' then ''Reopening'' else initcap(replace(r.subject_type, ''_'', '' '')) end'],
    ['verify_record', '''Charge (PHP)''', '''Additional Charge (PHP)''']
  ];
  f record; def text; new_def text; i int;
begin
  for f in select p.oid, p.proname from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and pg_get_userbyid(p.proowner) = current_user
  loop
    def := pg_get_functiondef(f.oid);
    new_def := def;
    for i in 1 .. array_length(fixes, 1) loop
      -- when the new text contains the old one, replace only once (so running this again changes nothing)
      if fixes[i][1] in ('*', f.proname) and (position(fixes[i][2] in fixes[i][3]) = 0 or position(fixes[i][3] in new_def) = 0) then
        new_def := replace(new_def, fixes[i][2], fixes[i][3]);
      end if;
    end loop;
    if new_def <> def then execute new_def; end if;
  end loop;
end $$;
