-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.26: Request for Update on an employee offers every detail
-- (present and permanent address, duty hours, parents, spouse, date and place of birth, BRC / NID / passport no,
-- gender, religion, blood group, emergency contact, ...). After the Director approves, the employee shows the new data.
-- Needs 034_employee_details.sql first. Safe to run again.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.editable_columns(p_table text)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case p_table
    when 'customers' then array['first_name','last_name','phone','email','address','business_name','business_start_date','facebook_name','facebook_link','has_extra_facebook','extra_facebook_name','facebook_verified','credit_limit']
    when 'customer_invoices' then array['invoice_date','total_amount','purchase_date','po_number','total_boxes','total_pcs','payment_terms']
    when 'payments_received' then array['method','bank_name','bank_account','reference_no','notes']
    when 'credit_memos' then array['payment_ref','po_number','article','brand','style','batch_no','serial_no','purchase_date','defect_category','defect_detail','assigned_by','inspection_notes','factory_status']
    when 'employees' then array['first_name','last_name','position','phone','address','permanent_address','date_hired','monthly_salary','duty_hours','father_name','mother_name','spouse_name','date_of_birth','birth_place','id_number','gender','religion','blood_group','emergency_name','emergency_relation','emergency_phone','emergency_address']
    when 'payslips' then array['method','reference_no','notes']
    when 'projects' then array['title','description','location','start_date','end_date']
    when 'project_payments' then array['received_by','method','reference_no','notes']
    when 'pay_companies' then array['name','contact_person','contact','address','country','currency','notes']
    when 'pay_accounts' then array['account_name','account_number','bank_name','branch_name','notes']
    when 'pay_vouchers' then array['method','reference_no','notes']
    when 'job_applications' then array['full_name','phone','email','present_address','permanent_address','father_name','mother_name','spouse_name','date_of_birth','birth_place','id_number','gender','religion','blood_group','apply_salary','apply_duty_hours','apply_joining_date','emergency_name','emergency_relation','emergency_phone','emergency_address']
    when 'stock_bills' then array['supplier_bill_no','batch_no','shipment_no','shipment_date','total_boxes','notes','shipping_company','shipping_company_code']
    else null end;
$function$;

select 'UPDATE 3.26 READY - Employee corrections' as result;
