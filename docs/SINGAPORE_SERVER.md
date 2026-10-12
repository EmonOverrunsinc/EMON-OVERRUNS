# The E-Portal server (Singapore)

Since version 2.2.1 (OCTOBER 2026) the E-Portal uses the Supabase project **EMON OVERRUNS**:

| | |
|---|---|
| Project ID | `cvmqjerbbejvmzypbawi` |
| Address | https://cvmqjerbbejvmzypbawi.supabase.co |
| Region | Southeast Asia (Singapore), `ap-southeast-1` |
| Organization | EMON HASAN |
| Database | Postgres 17 |

`public/config.js` holds the address and the publishable key (a public key, safe in the browser). The secret key and the
database password never go into this repository or a chat.

## What happened

The first project (`mgwqjjkwonhzrfndkray`, California) was deleted by mistake in OCTOBER 2026, during the move to
Singapore. Supabase cannot bring back a deleted project, so its records, uploaded files and logins are gone. The records
are entered again from the papers.

The Singapore project was set up in one step with `supabase/NEW_SERVER_SETUP.sql` and checked on OCTOBER 12 2026:
44 tables, 111 functions, the storage buckets `records`, `avatars`, `branding`, `forms` and `documents`, and the monthly
and daily schedules `emon-monthly-soa` and `emon-community-cleanup`.

## Settings by hand (Supabase dashboard › Authentication)

1. **URL Configuration**: Site URL `https://emonoverruns.online`; Redirect URLs `https://emonoverruns.online/**` and
   `https://emon-overruns.vercel.app/**`.
2. **Emails › SMTP Settings**: turn on custom SMTP. Supabase's own sender only sends to the members of the
   organization (Team) and only a few emails an hour, so staff would get no code. With Gmail: host `smtp.gmail.com`,
   port `465`, username `emonoverruns@gmail.com`, password a Google **App Password** (Google Account › Security ›
   2-Step Verification › App passwords; typed only in the Supabase dashboard), sender email `emonoverruns@gmail.com`,
   sender name `EMON OVERRUNS E-PORTAL`.
3. **Emails › Templates**: the portal asks for the code from the email, so **Confirm signup** and **Reset password**
   must show `{{ .Token }}` (the texts below).
4. **Sign In / Providers › Email**: keep **Confirm email** ON. Without it anybody could sign up with the company email
   or a registered employee's email and get in.

### Confirm signup

Subject: `EMON OVERRUNS E-PORTAL - your sign-up code`

```html
<h2>EMON OVERRUNS E-PORTAL</h2>
<p>Your sign-up code:</p>
<p style="font-size:28px;font-weight:bold;letter-spacing:4px">{{ .Token }}</p>
<p>Enter this code on the E-Portal to finish your sign-up.</p>
<p>If you did not sign up, please ignore this email.</p>
<p style="color:#666">EMON OVERRUNS · Pasay City, Metro Manila · emonoverruns.online</p>
```

### Reset password

Subject: `EMON OVERRUNS E-PORTAL - your password reset code`

```html
<h2>EMON OVERRUNS E-PORTAL</h2>
<p>Your password reset code:</p>
<p style="font-size:28px;font-weight:bold;letter-spacing:4px">{{ .Token }}</p>
<p>Enter this code on the E-Portal to set a new password.</p>
<p>If you did not ask for this, please ignore this email.</p>
<p style="color:#666">EMON OVERRUNS · Pasay City, Metro Manila · emonoverruns.online</p>
```

## First sign-up

The first account that signs up becomes an active Director and the **main Director** (the only one who can use Edit
Customer). So the Director signs up first, with the Director's own email and the name EMON HASAN, as soon as the website
is on 2.2.1. Then the staff sign up; each one waits as Pending until the Director opens **Users**, sets the role and
Active, and presses Save. The company email `emonoverruns@gmail.com` also becomes a Director when it signs up.

## Plan and backups

The organization EMON HASAN is on the **Free** plan: there are no daily backups to restore, and a project with little
use for 7 days is paused. The **Pro** plan (Organization › Billing) keeps 7 daily backups and never pauses the project.
Pro is paid per organization: if an organization with no projects still has Pro, change that one to Free.

Never press **Delete project** (Project Settings › General). A deleted project cannot be brought back, not even on Pro.
