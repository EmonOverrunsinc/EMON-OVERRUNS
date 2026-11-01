-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.65: STAFF PRINT / DOWNLOAD NEEDS APPROVAL
-- An employee who presses Print / Download on an INVOICE, a PAYMENT (acknowledgment receipt) or a STATEMENT OF ACCOUNT
-- sends a request; EMON HASAN approves or rejects it (Print Requests, and Waiting for you on the Dashboard). Approved,
-- the employee can print that document once within 24 hours. EMON HASAN prints at any time.
-- Paste all of it in Supabase > SQL Editor > New query and press Run. Safe to run again.
-- The last line says: UPDATE 3.65 READY - ...
-- =====================================================================
create table if not exists public.print_requests (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('invoice', 'payment', 'soa')),
  record_id uuid not null,
  label text not null check (char_length(label) <= 200),
  requested_by uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  requested_by_name text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'used')),
  decided_by_name text,
  decided_at timestamptz,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists print_requests_by_idx on public.print_requests (requested_by, kind, record_id);
create index if not exists print_requests_status_idx on public.print_requests (status);
alter table public.print_requests enable row level security;
drop policy if exists print_requests_read on public.print_requests;
create policy print_requests_read on public.print_requests for select to authenticated
  using (requested_by = (select auth.uid()) or (select public.is_admin()));
revoke insert, update, delete on public.print_requests from anon, authenticated;
grant select on public.print_requests to authenticated;

-- an employee asks to print (the same waiting request is returned when asked again)
create or replace function public.request_print(p_kind text, p_record uuid, p_label text) returns public.print_requests
language plpgsql security definer set search_path = '' as $$
declare r public.print_requests; me text; a record;
begin
  if not public.is_active() then raise exception 'Not allowed'; end if;
  if p_kind not in ('invoice', 'payment', 'soa') then raise exception 'Unknown document'; end if;
  select * into r from public.print_requests where requested_by = auth.uid() and kind = p_kind and record_id = p_record and status = 'pending' limit 1;
  if found then return r; end if;
  me := (select full_name from public.profiles where id = auth.uid());
  insert into public.print_requests (kind, record_id, label, requested_by, requested_by_name)
  values (p_kind, p_record, left(coalesce(nullif(trim(p_label), ''), p_kind), 200), auth.uid(), me) returning * into r;
  for a in select id from public.profiles where role = 'admin' and status = 'active' loop
    perform public.notify_user(a.id, 'Print request: ' || r.label, coalesce(me, 'An employee') || ' asks to print / download ' || r.label, 'printreqs');
  end loop;
  return r;
end;
$$;
revoke execute on function public.request_print(text, uuid, text) from public, anon;
grant execute on function public.request_print(text, uuid, text) to authenticated;

-- EMON HASAN approves (true) or rejects (false)
create or replace function public.decide_print(p_id uuid, p_ok boolean) returns public.print_requests
language plpgsql security definer set search_path = '' as $$
declare r public.print_requests;
begin
  if not public.is_admin() then raise exception 'Only EMON HASAN approves a print'; end if;
  update public.print_requests set status = case when p_ok then 'approved' else 'rejected' end, decided_at = now(),
    decided_by_name = (select full_name from public.profiles where id = auth.uid())
  where id = p_id and status = 'pending' returning * into r;
  if r.id is null then raise exception 'This request was decided already'; end if;
  perform public.notify_user(r.requested_by, 'Print ' || case when p_ok then 'approved: ' else 'not approved: ' end || r.label,
    case when p_ok then 'You can print / download it once within 24 hours.' else 'EMON HASAN did not approve printing it.' end, null);
  return r;
end;
$$;
revoke execute on function public.decide_print(uuid, boolean) from public, anon;
grant execute on function public.decide_print(uuid, boolean) to authenticated;

-- the employee prints the approved document: used once, within 24 hours of the approval
create or replace function public.use_print(p_kind text, p_record uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare rid uuid;
begin
  select id into rid from public.print_requests where requested_by = auth.uid() and kind = p_kind and record_id = p_record
    and status = 'approved' and decided_at > now() - interval '24 hours' order by decided_at desc limit 1;
  if rid is null then return false; end if;
  update public.print_requests set status = 'used', used_at = now() where id = rid;
  return true;
end;
$$;
revoke execute on function public.use_print(text, uuid) from public, anon;
grant execute on function public.use_print(text, uuid) to authenticated;

notify pgrst, 'reload schema';

select case when to_regprocedure('public.request_print(text,uuid,text)') is not null and to_regprocedure('public.use_print(text,uuid)') is not null
  then 'UPDATE 3.65 READY - staff print / download of an invoice, payment or SOA needs EMON HASAN''s approval'
  else 'NOT READY - send this message to Claude' end as result;
