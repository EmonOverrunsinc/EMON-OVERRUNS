-- =====================================================================
-- EMON OVERRUNS E-PORTAL — Update 1.4
-- Customers: the profile photo can be changed or removed (made empty) by staff with customer access.
-- Each change is written in the customer's History.
-- Run once in the Supabase SQL Editor after 006_update_1_3.sql. It is safe to run again.
-- =====================================================================

create or replace function public.set_customer_photo(p_id uuid, p_path text) returns void
language plpgsql security definer set search_path = '' as $$
declare old text;
begin
  if not public.can_write('customers') then raise exception 'You do not have permission to change the customer photo'; end if;
  if p_path is not null and p_path !~ ('^customer/' || p_id::text || '/') then raise exception 'Invalid photo'; end if;
  select c.photo_path into old from public.customers c where c.id = p_id for update;
  if not found then raise exception 'Customer not found'; end if;
  if old is not distinct from p_path then return; end if;
  perform public.allow_record_change();
  update public.customers set photo_path = p_path where id = p_id;
  insert into public.customer_events (customer_id, action, actor, actor_name)
  values (p_id, case when p_path is null then 'photo removed' when old is null then 'photo added' else 'photo changed' end,
          auth.uid(), (select full_name from public.profiles where id = auth.uid()));
end;
$$;
revoke execute on function public.set_customer_photo(uuid, text) from public, anon;
grant execute on function public.set_customer_photo(uuid, text) to authenticated;
