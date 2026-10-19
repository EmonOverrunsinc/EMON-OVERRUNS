-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 2.9: Join Us
-- The open job positions can be seen by anyone (the Join Us page on the sign-in screen). Applying still needs a free
-- account, so every application keeps its status and the applicant can follow it.
-- Run once in the Supabase SQL Editor after 020_invoice_return.sql. It is safe to run again.
-- =====================================================================

grant select on public.job_positions to anon;
drop policy if exists "pos: public open" on public.job_positions;
create policy "pos: public open" on public.job_positions for select to anon using (is_open);

select 'UPDATE 2.9 READY - open job positions are shown on Join Us' as result;
