-- =====================================================================
-- EMON OVERRUNS E-PORTAL - Update 2.4: deleting a login account (needed for the Google Play Store)
-- A person asks for it in My Profile (Request Account Deletion) or on www.emonoverruns.online/delete-account.
-- The Director then presses Delete on Login Accounts:
--   * the login and the person's details go: name, email, username, photo, signature, chat messages, community
--     posts, notices, and a job application that was not approved (with its files);
--   * a person named in records the business must keep (invoices, receipts, payslips, order letters, the record
--     history ...) keeps those records: the login is removed and the profile becomes "Deleted User".
-- Run once in the Supabase SQL Editor after 016_update_2_3.sql. It is safe to run again.
-- =====================================================================

-- the Director may remove profile photos (the files of a deleted account)
drop policy if exists "storage avatars: admin read" on storage.objects;
create policy "storage avatars: admin read" on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and (select public.is_admin()));
drop policy if exists "storage avatars: admin delete" on storage.objects;
create policy "storage avatars: admin delete" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (select public.is_admin()));

-- Returns how the account went ('deleted', or 'anonymized' when kept records name it) and the stored files of the
-- account, which the portal then removes from storage.
create or replace function public.delete_user_account(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p public.profiles;
  avs text[] := '{}';
  recs text[] := '{}';
  how text;
begin
  if not public.is_admin() then raise exception 'Only the Director can delete an account'; end if;
  if p_id = auth.uid() then raise exception 'You cannot delete your own account'; end if;
  if exists (select 1 from public.main_director where profile_id = p_id) then
    raise exception 'The main Director''s account cannot be deleted';
  end if;
  select * into p from public.profiles where id = p_id;
  if p.id is null then raise exception 'Account not found'; end if;
  perform public.allow_record_change();

  -- the stored files of the account
  if p.avatar_path is not null then avs := avs || p.avatar_path; end if;
  if p.signature_path is not null then recs := recs || p.signature_path; end if;
  recs := recs || coalesce((select array_agg(m.file_path) from public.messages m
                            where (m.sender_id = p_id or m.recipient_id = p_id) and m.file_path is not null), '{}');
  recs := recs || coalesce((select array_agg(x) from public.community_posts c, unnest(c.photos) x where c.author_id = p_id), '{}');
  recs := recs || coalesce((select array_agg(j.photo_path) from public.job_applications j
                            where j.profile_id = p_id and j.status <> 'approved' and j.photo_path is not null), '{}');
  recs := recs || coalesce((select array_agg(a.storage_path) from public.attachments a
                            join public.job_applications j on a.owner_type = 'job_application' and a.owner_id = j.id
                            where j.profile_id = p_id and j.status <> 'approved'), '{}');

  -- the person's own things (a job application that was approved belongs to the employee record and stays)
  delete from public.attachments a using public.job_applications j
    where a.owner_type = 'job_application' and a.owner_id = j.id and j.profile_id = p_id and j.status <> 'approved';
  delete from public.job_applications where profile_id = p_id and status <> 'approved';
  delete from public.messages where sender_id = p_id or recipient_id = p_id;
  delete from public.community_posts where author_id = p_id;
  delete from public.notifications where user_id = p_id;

  begin
    delete from auth.users where id = p_id; -- the profile goes with it
    how := 'deleted';
  exception when foreign_key_violation then
    -- kept records still point to this profile: the login and the personal details are removed instead
    update public.profiles set full_name = 'Deleted User', email = null, username = null, avatar_path = null,
      signature_path = null, signature_status = null, signature_at = null, signature_note = null,
      status = 'disabled', last_seen_at = null
    where id = p_id;
    update auth.users set email = 'deleted-' || p_id || '@deleted.invalid', phone = null, encrypted_password = '',
      raw_user_meta_data = '{}'::jsonb, banned_until = 'infinity'
    where id = p_id;
    delete from auth.identities where user_id = p_id;
    delete from auth.sessions where user_id = p_id;
    how := 'anonymized';
  end;
  return jsonb_build_object('result', how, 'avatars', to_jsonb(avs), 'records', to_jsonb(recs));
end;
$$;
revoke execute on function public.delete_user_account(uuid) from public, anon;
grant execute on function public.delete_user_account(uuid) to authenticated;

select 'UPDATE 2.4 READY - account deletion added' as result;
