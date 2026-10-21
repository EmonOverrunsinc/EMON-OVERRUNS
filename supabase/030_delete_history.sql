-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.12: the Director can delete a line of a customer's History
-- (a history line is a customer event, or a record change of the customer). Only the Director; nothing else is changed.
-- Run once in the Supabase SQL Editor. It is safe to run again.
-- =====================================================================
create or replace function public.delete_history_line(p_source text, p_id bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if not public.is_admin() then raise exception 'Only the Director can delete history'; end if;
  perform public.allow_record_change();
  if p_source = 'event' then
    delete from public.customer_events where id = p_id;
  elsif p_source = 'change' then
    delete from public.record_changes where id = p_id and target_table = 'customers';
  else
    raise exception 'Unknown history line';
  end if;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'History line not found'; end if;
  return jsonb_build_object('ok', true);
end;
$$;
revoke execute on function public.delete_history_line(text, bigint) from public, anon;
grant execute on function public.delete_history_line(text, bigint) to authenticated;

select 'UPDATE 3.12 READY - the Director can delete history lines' as result;
