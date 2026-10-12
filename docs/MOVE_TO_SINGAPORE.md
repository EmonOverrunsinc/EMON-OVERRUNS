# Moving the E-Portal database to Singapore

The E-Portal's Supabase project **EMON OVERRUNS** (`mgwqjjkwonhzrfndkray`) runs in **us-west-1 (California)**.
A Supabase project cannot change its region, and "Restore to a new project" keeps the same region, so the move is:
a new project in **ap-southeast-1 (Singapore)**, then everything is copied into it, then the portal is switched over.
The California project stays untouched as the backup until the new one has been checked.

Size on OCTOBER 12 2026: 48 tables, about 300 rows, 4 logins (email and password only), 99 files (about 30 MB in the
buckets `records`, `avatars`, `forms`, `documents`; `branding` may hold the logo), database about 17 MB.

## What is needed first

1. **The Singapore project.** Create it in the organization that has the Pro plan (daily backups), region
   **Southeast Asia (Singapore) / ap-southeast-1**, Postgres 17. Keep its database password in a safe place.
2. **Access for Claude.** The Supabase connector must see both projects: reconnect it at
   https://claude.ai/customize/connectors and allow the organization(s) that hold the two projects, then start a new
   session (connectors are read when a session starts). Never paste keys or passwords into the chat.
3. **A quiet hour.** Nobody adds records while the data is copied (about one hour).

## Steps (done by Claude with the Supabase connector)

1. **Schema.** On the Singapore project run, in this order: `portal_init.sql`, `002_customers_invoices_payments.sql`,
   `003_statements.sql`, `004_update_1_1.sql` … `014_update_2_1.sql` (all files of `supabase/` up to 2.1). Then
   compare every `public` function with the old project (`md5(pg_get_functiondef(oid))`) and the table/column list:
   they must match the old project exactly. If update 2.2 was run on the old project, run `015_update_2_2.sql` now
   too; otherwise run it after step 3 (its one-time clean-ups need the data).
2. **Logins.** Copy `auth.users` and `auth.identities` rows as they are (same ids, same password hashes, so everyone
   signs in with the same email/username and password). Test first that the connector may insert into `auth`; if not,
   stop and report (the alternative needs the new project's service key in the environment secrets, not the chat).
3. **Data.** Copy every `public` table in foreign-key order (`profiles` first, then customers, invoices, payments,
   memos, orders, employees, billing, e-bills, statements, attachments, notifications, counters `doc_counters` …):
   read the rows as JSON from the old project, insert them in the new one with `jsonb_populate_recordset`,
   `overriding system value` for identity columns, and the add-only triggers off for the copy
   (`alter table … disable trigger user`, on again right after). Copy `storage.buckets` settings and
   `company_settings` too. Check row counts table by table; they must be equal.
4. **Schedules.** Check `cron.job` on the new project: `emon-monthly-soa` (5 0 1 * *) and `emon-community-cleanup`
   (15 0 * * *) must exist once each (the SQL files make them).
5. **Files.** The files are not in the database. The workspace cannot reach `*.supabase.co`, so the copy runs in the
   Director's browser: a one-time **Move Files** page in the portal (Director only) signs in to both projects, lists
   every stored file (the `attachments` paths, avatars, forms, the logo, signatures), downloads each one from the old
   project and uploads it to the same path in the new one, and shows the count (expected 99). It is removed again
   after the move.
6. **Auth settings by hand** in the new project's dashboard (Authentication): Site URL `https://emonoverruns.online`,
   the redirect URLs of the old project (also `https://emon-overruns.vercel.app/**`), the email templates (the 6-digit
   code emails) and the SMTP settings if a custom sender was set up.
7. **Switch.** In `public/config.js` set `supabaseUrl` to `https://<new ref>.supabase.co` and `supabaseKey` to the new
   project's publishable key, raise the version (`version.json`, `BUILD` in `app.js`, `?v=` in `index.html`), open a
   pull request and merge it. Everyone is asked to sign in again once.
8. **Check.** Sign in as the Director and as an employee; open customers, SOA, invoices, payments, e-bills, files;
   send a Contact Us message; print a receipt. Run the security advisors on the new project.
9. **After one week** without problems, pause the California project (it stays as a backup and costs nothing while
   paused on the Free plan).

## Going back

Until step 7 is merged nothing changes for the users. After it, going back is only `public/config.js` pointing to the
old project again (records added in Singapore meanwhile would have to be copied back).
