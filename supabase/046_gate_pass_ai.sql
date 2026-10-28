-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 3.38: GATE PASS AI
-- A small artificial neural network learns from the portal's own records (invoices, payments, overdue days, credit memos,
-- returns and every gate pass decision of the Director) and gives its idea when a Gate Pass is asked for: CLEAR or HOLD,
-- how sure it is, and why. The Director decides.
-- 1. Its own folder on the server: the private storage bucket "ai" (folder gate-pass/: one file for each time it learns).
--    The Director makes it learn (writes the files); staff with Customer access read the newest file to see its idea.
-- 2. ai_models: the list of what it learned (the file, how many records and Director decisions, how often it was right).
-- 3. ai_gate_log: each idea shown in a Gate Pass and the decision taken (CLEAR or HOLD), to see how often it agrees.
-- Needs 045_customer_orders.sql. Safe to run again.
-- =====================================================================
do $$ begin
  if to_regclass('public.customer_orders') is null then raise exception 'Run 045_customer_orders.sql first, then run this again.'; end if;
end $$;

-- 1. the folder
insert into storage.buckets (id, name, public) values ('ai', 'ai', false) on conflict (id) do nothing;
create or replace function public.ai_can_read() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_staff() and public.has_module('customers');
$$;
revoke execute on function public.ai_can_read() from public, anon;
grant execute on function public.ai_can_read() to authenticated;
drop policy if exists "storage ai: read" on storage.objects;
create policy "storage ai: read" on storage.objects for select to authenticated
  using (bucket_id = 'ai' and (select public.ai_can_read()));
drop policy if exists "storage ai: director writes" on storage.objects;
create policy "storage ai: director writes" on storage.objects for insert to authenticated
  with check (bucket_id = 'ai' and (select public.is_admin()));
drop policy if exists "storage ai: director deletes" on storage.objects;
create policy "storage ai: director deletes" on storage.objects for delete to authenticated
  using (bucket_id = 'ai' and (select public.is_admin()));

-- 2. what it learned
create table if not exists public.ai_models (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'gate-pass',
  path text not null,
  samples integer not null default 0 check (samples >= 0),
  decisions integer not null default 0 check (decisions >= 0),
  accuracy numeric(5,2) check (accuracy between 0 and 100),
  agree numeric(5,2) check (agree between 0 and 100),
  trained_by uuid references public.profiles(id) on delete set null default auth.uid(),
  trained_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists ai_models_name_idx on public.ai_models(name, created_at desc);
create index if not exists ai_models_trained_by_idx on public.ai_models(trained_by);
alter table public.ai_models enable row level security;
revoke all on public.ai_models from anon;
grant select, insert, delete on public.ai_models to authenticated;
drop policy if exists "ai models: read" on public.ai_models;
create policy "ai models: read" on public.ai_models for select to authenticated using ((select public.ai_can_read()));
drop policy if exists "ai models: director adds" on public.ai_models;
create policy "ai models: director adds" on public.ai_models for insert to authenticated
  with check ((select public.is_admin()) and path like 'gate-pass/%' and trained_by = (select auth.uid()));
drop policy if exists "ai models: director deletes" on public.ai_models;
create policy "ai models: director deletes" on public.ai_models for delete to authenticated using ((select public.is_admin()));

-- 3. its ideas and the decisions taken
create table if not exists public.ai_gate_log (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  model_id uuid references public.ai_models(id) on delete set null,
  suggestion text not null check (suggestion in ('CLEAR','HOLD')),
  p_clear numeric(5,4) not null check (p_clear between 0 and 1),
  reasons text check (char_length(reasons) <= 600),
  decision text check (decision in ('CLEAR','HOLD')),
  decided_by_name text,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists ai_gate_log_customer_idx on public.ai_gate_log(customer_id);
create index if not exists ai_gate_log_model_idx on public.ai_gate_log(model_id);
create index if not exists ai_gate_log_created_by_idx on public.ai_gate_log(created_by);
create index if not exists ai_gate_log_time_idx on public.ai_gate_log(created_at desc);
alter table public.ai_gate_log enable row level security;
revoke all on public.ai_gate_log from anon;
grant select, insert on public.ai_gate_log to authenticated;
drop policy if exists "ai log: read" on public.ai_gate_log;
create policy "ai log: read" on public.ai_gate_log for select to authenticated using ((select public.ai_can_read()));
drop policy if exists "ai log: add" on public.ai_gate_log;
create policy "ai log: add" on public.ai_gate_log for insert to authenticated
  with check ((select public.ai_can_read()) and created_by = (select auth.uid()));

select 'UPDATE 3.38 READY - Gate Pass AI: its folder (bucket ai), what it learned (ai_models) and its ideas with the decisions (ai_gate_log)' as result;
