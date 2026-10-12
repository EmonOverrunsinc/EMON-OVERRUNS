# Emon Overruns Portal (E-Portal v2.2)

**Live:** https://emon-overruns.vercel.app

Business portal for **EMON OVERRUNS**, Pasay City, Metro Manila · emonoverruns@gmail.com · emonoverruns.online.
It is laid out like AutoCount: option panel, then Inquiry, Preview and Print, then a grid, and printable report pages.

## Modules (side menu)
| Menu | What it does |
|---|---|
| Dashboard | Totals, what is waiting for the Director (applications, orders, corrections, credit memos) and the monthly chart |
| 1. Customer | Application with photo and requirements, account no (shown as a preview on the form), Facebook name and Facebook account link, LOCATION check (FOUND, NO NEED TO CHECK LOCATION or NOT FOUND), one person one account (see below), credit limit, opening balance, wallet-style Public ID with its QR, approval, profile with balance, monthly SOA and history |
| 2. Invoice | Sales for ACTIVE customers: one date (the invoice date), boxes, pcs, amount, the invoice copy, receipts and delivery receipt (no PO number or purchase date from 2.2; old invoices keep theirs) |
| 3. Payment | Cash, bank transfer, online transfer or deposit, with a printable acknowledgment receipt |
| 4. Credit Memo | Complaints and defect claims; approved credits and discounts reduce the balance due |
| 5. Employee | Employees, job applications, positions, payroll and payslips |
| 6. Community | Company posts (kept 30 days) and chat |
| 7. Project | Projects with their budget (each line with its amount; the qty is optional) and payments |
| 8. Billing | Billing companies (PHP, BDT or both) and payment vouchers (e-bills are paid with a memo in the Director Portal) |
| 9. Director Portal | Order letters for customers, employees, billing companies and e-bills (closure, reactivation, additional charge, settlement adjustment, balance certificate, Released Notice, memo and more). A memo to a company can have an amount in PESOS with the exchange rate of the day (the BDT amount is counted for you) and can name one e-bill of the company: once approved, the BDT amount is paid on that e-bill and its balance goes down. Every order waits for approval first and can be changed until then (Edit Order, by the person who sent it or the Director); once the Director approves it, it is carried out at once. The letter shows only the customer's name and account no (all details for a closed, reactivated or reopened account), or the company's name and authorized person |
| 10. E-Bill | E-bills in BDT with their own item columns and rows and the uploaded bill (batch no and total boxes needed; shipping company name and code); Released Notice: an order letter found by the batch no, price per box (PHP) × boxes = total (PHP), × the exchange rate of the day = released charge (BDT), plus the shipping fee, all shown in BDT and added to the e-bill's total cost once approved; Sales Report (net sales, EOO fees, other fees and penalties with their receipts; more can be added after PAID); payments by memo with the paid amount and the balance; steps 1 SHIP → 2 RELEASED → 3 SALES → 4 PAID (no payment is needed to mark it PAID); the profit or loss shows after the Director marks it PAID. One document, **E-BILL** with its batch no (for example E-BILL I-17), shows every record like a statement of account: the account summary, items, statement with the running balance, Sales Report, Released Notice, payments, history and files; after PAID also the profit or loss and the secret code |
| Verification | Anyone can check a record by its number or by scanning its QR / PDF417 code, without signing in. An e-bill is shown only for the secret code printed on its E-Bill once it is PAID |
| Contact Messages | **Contact Us** on the sign-in page (no sign-in needed): the visitor's name, how to reply (email, phone call, SMS, WhatsApp, Viber or Facebook) and the message; they get a reference number like **MS-202609010001** (MS-, the date, then 0001, 0002 … that day). The Director reads them here (the dashboard counts the new ones), replies with one press on the email, number or Facebook link, and marks them replied or deletes them (2.2) |
| Corrections | Records are only added; corrections and cancellations are approved by the Director. Approve puts the new details on the record, Reject leaves the record as it is, and either way the correction is then removed: it leaves no record (2.2; the person who asked is told when it is rejected). A customer's details are corrected by the main Director only (see Edit Customer below). What the Director deletes is gone for good, with its files, history lines and notices |
| User | Logins, access levels, which modules each person can open, and everyone's signature: approve, reject, remove or upload it (Director) |
| Download Forms | Blank company forms, and the built-in **SIGNATURE VERIFICATION FORM** (A4 PDF with boxes for three specimen signatures, the initials and the Director's approval) |
| My Profile | Photo, username, password, payslips, and **My Signature**: upload a photo of your signature (the white paper is taken away) and print your Signature Verification Form |

**Signatures (2.0):** everyone uploads their signature in My Profile. The Director's signature counts at once; anyone
else's waits until the Director approves it in User, and then their Signature Verification Form carries the Director's
signature. Every document the Director approves (order letters and certificates, customer applications, credit memos,
job applications, projects) prints the Director's signature, name and date by itself, so no signed copy is uploaded
after approval. A customer's or applicant's own signed form can still be uploaded before approval. The signature stands
above its line and never covers the name, the date or any other words (2.1).

**Edit Customer (2.2):** only the **main Director** (the first Director account, EMON HASAN) has **Edit Customer** on a
customer. It changes every detail at once: name, phone, email, address and LOCATION, application date, credit limit,
opening balance, business start date and name, Facebook name and link, the additional Facebook account and the
Facebook check. The customer shows the new details straight away and the edit leaves no history. A new opening balance
or application date also updates the customer's monthly statements (signed copies stay). The one-person-one-account
check runs on the form, so a Facebook link that is on another account is refused. The account no, the application
number, the Public ID, the status and the photo do not change here (the photo has its own Change / Remove). Any other
account, including the second Director account, sends **Request Correction** instead, and only the main Director
approves or rejects it.

**Statement of account (2.2):** one SOA a month, made automatically on the 1st for the month just ended (no button
to press). The first SOA is the month the account was opened (its application date): old receipts and purchases
recorded later with their own earlier dates are in that first SOA, which starts from zero, so there is no SOA for the
months before the account was opened. An old paper recorded after a month's SOA was made updates that SOA and the ones
after it by itself. The lines are short, in capitals: **INVOICE** (with the invoice number), **PAYMENT RECEIVED**,
**CREDIT MEMO** or **DISCOUNT**, **ADDITIONAL CHARGE**, **SETTLEMENT ADJUSTMENT** and **OPENING BALANCE**. A payment
shows **PAYMENT RECEIVED** on its page and receipt (and the invoice it is for, if any; no longer "General payment").

**Invoice payment status (2.4):** every invoice shows **PAID**, **PARTIAL PAYMENT** or **UNPAID**, worked out from
everything the customer paid: a payment recorded for an invoice pays that invoice; all other payments, approved credit
memos and discounts, and settlement adjustments that take off pay what is owed **oldest first** (the opening balance,
then each invoice, additional charge and settlement adjustment that adds, by date). So the invoices' balances always
add up to the customer's balance. **Invoices** has the tabs **Active** (still a balance), **Unpaid**, **Partial
Payment**, **Closed (Paid)** and **All**; the **Dashboard** has an **Invoices** box with **Active** (with what is still
due) and **Closed (Paid)**; the invoice page, its print and **Verify a record** show the status, what is paid and the
balance (`invoice_balances` in `supabase/017_play_store.sql`).

**Cleaner screens (2.4):** the screens no longer show the company header (logo, Pasay City, email and website) at the
top; the printed documents and PDFs keep it. Every page except the Dashboard has a **Back** button on the green band
(it goes to the page before, and never leaves the portal). The browser tab and an installed app are named
**EMON OVERRUNS**.

**Privacy and account deletion (2.4, for the Google Play Store):** the **Privacy Policy** is at
`/privacy` (www.emonoverruns.online/privacy) and **Delete Account** at `/delete-account`, both linked on the sign-in page.
A person asks for deletion on that page (no sign-in), in **My Profile › Request Account Deletion**, or on the applicant
page; the request arrives in **Contact Messages** with a reference number. The Director then presses **Delete** on
**Login Accounts**: the login, name, photo, signature, chat messages, community posts and a job application that was not
approved go (with their files). Records the business must keep stay, and their account shows **Deleted User**
(`supabase/017_play_store.sql`, `delete_user_account`).

**Smaller uploads (2.2.2):** every uploaded or scanned picture is made smaller before it is saved, so storage lasts
longer and files open faster, while a printed page stays clear: a document or scan keeps about 4.2 million pixels (an A4
page at about 200 dpi; a 300 dpi scan of 2.6 MB is saved as about 0.6 MB), a customer's or employee's photo about 1.2
million and a profile picture about 0.5 million, as JPEG. PDFs, small pictures and pictures that would not get smaller
are saved as they are (`slimFile` in `public/app.js`).

**Company details on every page (2.2):** headers, prints and PDFs show **Pasay City, Metro Manila**, the email
**emonoverruns@gmail.com** and the website **emonoverruns.online**; no phone number is shown anywhere. They are set in
`public/config.js` (`company`). Report listings end with **REPORT** (what the report shows) instead of "Report
Criteria".

**One person, one account (2.1):** the customer check looks only at the name, the Facebook name and the Facebook account
link (not the address, phone or email), while the application is typed and again at Check & Verify and Approve. It is
**BLOCKED** when the same Facebook link is already on another account, or the same name or Facebook name is on a CLOSED
account: a person whose account was closed cannot open a new one. The same name as an open account is only a warning
(two people can share a name), and the Director can still verify.

**Printed pages (2.1):** every page starts 20 mm from the top edge, so the holes of a 2-hole punch (about 9–15 mm from
the top) never cut a barcode, the logo or any words. The company address line also shows emonoverruns.online.

**New versions (2.1):** `public/version.json` names the version on the server. When it changes, an open E-Portal shows
"A new version … is ready — Update now" and loads it at the next page change. When you release a version, change it
in three places: `version.json`, `BUILD` in `app.js`, and `?v=` in `index.html`.

**Website QR (2.1):** every printed page and PDF ends with a small QR code (13 mm) of the website
**https://emonoverruns.online**, with the address under "Scan to visit". Scanning it opens the website. The address is
set in `public/config.js` (`company.website`).

Amounts are in **PHP (₱)** (Billing also uses BDT; E-Bill uses BDT). Dates show as MONTH DD YYYY in capitals, for example AUGUST 01 2026 or OCTOBER 09 2026, in Manila time (on screens, cards, prints and PDFs; the date fields still open the calendar). Vouchers print the amount in words, for example "PESOS ONE THOUSAND … AND 50/100 ONLY".

Numbers: account no initials-YYYYMM### (e.g. EH-202610001), payment receipt A-YYYY-MMDD-###, credit memo EOC-YYYYMM###, order letter EO-YYYY-MM-#### (e.g. EO-2026-10-0001; orders made before update 2.0 keep ORDER-YYYY-###), e-bill company letters-YYYY-#### (e.g. MF-2026-0001 for MODINA FASHION).

Database scripts, run once each in this order in the Supabase SQL Editor: `portal_init.sql`, `002_customers_invoices_payments.sql`,
`003_statements.sql`, `004_update_1_1.sql`, `005_update_1_2.sql` (orders for customers, employees and billing companies),
`006_update_1_3.sql` (billing currency PHP / BDT / both, order details, balance certificate, wallet-style Public ID key),
`007_update_1_4.sql` (change or remove a customer's photo),
`008_update_1_5.sql` (order letter Additional Charge added to the balance and the SOA; old photos leave Files),
`009_update_1_6.sql` (dates follow Manila time: between midnight and 8 AM the database no longer uses the day before;
run it again after any later update that replaces a function, so the replaced function keeps Manila time).
`010_update_1_7.sql` (wording: the database says Director instead of CEO, Employee instead of Staff, and clearer messages and history lines).
`011_update_1_8.sql` (a wrong upload can be removed and uploaded again; customer credit limit, opening balance, address checked by hand, account number preview).
`012_update_1_9.sql` (Inventory, now E-Bill: stock-bills, release order, e-bills in Billing, sales report, PAID with the profit or loss and the secret code).
`013_update_2_0.sql` (Update 2.0: E-Bill numbers by company letters, the steps SHIP → RELEASED → SALES → PAID with no ARRIVED step, the Released Notice with price per box, exchange rate and shipping fee in BDT, order letters numbered EO-YYYY-MM-####, an order waiting for approval can be changed, and signatures: uploaded in My Profile, approved by the Director, printed on approved documents).
`014_update_2_1.sql` (Update 2.1: a memo to a company in PESOS × the exchange rate = BDT, paid on the e-bill it names once approved; the shipping company of an e-bill; Sales Report lines after PAID; what the Director deletes leaves no line in any history, and the old "deleted" lines are removed; a project budget line is its amount, with the qty optional; a customer's LOCATION check — FOUND, NO NEED TO CHECK LOCATION or NOT FOUND — takes the place of the address check; an approved correction changes the record and leaves no history, and the approved corrections kept before are removed; the Facebook account link and the one-person-one-account check).
`015_update_2_2.sql` (Update 2.2: Contact Us with MS- reference numbers and the Director's Contact Messages; the first SOA of an account is the month it was opened, with any earlier entries, and the SOAs made before for months before it are removed; an old paper recorded later updates the SOAs by itself; the main Director — the first Director account — edits every detail of a customer with Edit Customer, with no history, and the monthly statements follow a new opening balance or application date; a customer correction from anyone else waits for the main Director; a rejected correction is removed like an approved one, so a decided correction leaves no record, and the decided corrections kept before are removed).

**The server** (since 2.2.1, OCTOBER 2026): the Supabase project EMON OVERRUNS (`cvmqjerbbejvmzypbawi`) in Singapore
(ap-southeast-1), organization EMON HASAN, set up with `supabase/NEW_SERVER_SETUP.sql`. The first project (California)
was deleted by mistake with its records, files and logins; the records are entered again from the papers. Settings,
email texts and the first sign-up: [docs/SINGAPORE_SERVER.md](docs/SINGAPORE_SERVER.md).

## Setup (one time)
1. **Database**: in a new, empty Supabase project open **SQL Editor**, paste all of `supabase/NEW_SERVER_SETUP.sql`
   and press Run, once. It holds every database file above, in order, up to update 2.2 (made by
   `python3 supabase/build_new_server_setup.py`), and ends with **E-PORTAL SERVER READY**: the tables, security rules,
   numbering, audit trail, storage buckets and monthly schedules. Then point `public/config.js` to the project (Project
   URL and publishable key) and raise the version (`version.json`, `BUILD` in `app.js`, `?v=` in `index.html`).
2. **Host the site**: upload the `public/` folder to any static host, such as Vercel, Netlify or Cloudflare Pages. There is no build step.
   - Vercel: New Project, Import, choose this folder, Framework "Other", Output directory `public`.
   - Netlify: drag the `public` folder onto app.netlify.com/drop.
3. **Auth links**: in Supabase, open **Authentication › URL Configuration** and set **Site URL** to your site address
   (https://emonoverruns.online), and add `https://emonoverruns.online/**` and `https://emon-overruns.vercel.app/**` under
   **Redirect URLs**. Otherwise sign-up confirmation emails point to the wrong place. Also in **Authentication**: custom
   **SMTP Settings** (Supabase's own sender only reaches the organization's members), the 6-digit code `{{ .Token }}` in
   the **Confirm signup** and **Reset password** emails, and **Confirm email** kept ON; see
   [docs/SINGAPORE_SERVER.md](docs/SINGAPORE_SERVER.md).
4. **Website address**: in Vercel, open the project › **Settings › Domains**, add `emonoverruns.online` (and
   `www.emonoverruns.online`), and set the DNS records Vercel shows at the place where the domain was bought.
5. **First sign-up**: the Director signs up first. The first account becomes an active Director and the main Director;
   emonoverruns@gmail.com also becomes a Director when it signs up. Everyone else waits as *Pending* (see Daily use).

## Supabase Pro plan
The organization EMON HASAN is on the **Free** plan (OCTOBER 2026): no daily backups to restore, and the project is
paused after 7 days of little use. Changing it to **Pro** (Organization › Billing) turns on, with nothing to set:
- the project is never paused;
- a backup of the database every day, the last 7 days kept (**Database › Backups**: restore or download). Files
  (photos, receipts) are not inside these backups;
- room for 8 GB of data, 100 GB of files and 250 GB of downloads a month; logs kept 7 days; help from Supabase support.

Switches to turn on in the Supabase dashboard (they cannot be set from the portal):
- **Authentication › Sign In / Providers › Email › Prevent use of leaked passwords** (Pro only): a password known from
  a data leak is refused.
- **Authentication › Emails › SMTP Settings** (needed on the Singapore project): send the sign-in code emails from your
  own address, for example emonoverruns@gmail.com with a Google App Password. Supabase's own email service sends only a
  few emails an hour, and only to the members of the organization.

Not used, because they cost extra: Point-in-Time Recovery, image resizing (the portal already makes every picture
smaller before upload, 2.2.2) and a custom domain for the database address.

## Daily use
- New staff click **Create Account**. They wait as *Pending* until an admin opens **Users**, sets the role and status to *Active*, and presses Save.
- **Upload**: fill in the document, attach the scan, and press Save. The record gets its number and PDF417 code and appears in **Verification**.
- **Preview** shows the report on A4 paper. **Print / Save PDF** opens the browser's print dialog.
- Scan the PDF417 on any printed voucher in **Search** to jump straight to the record.

## Apps for Windows and Android
- **Windows 11**: `EMON-OVERRUNS-E-Portal-Setup-<version>.exe` installs the E-Portal as an app, with a desktop shortcut.
  From version 1.4 it scans with the computer's scanner (any scanner Windows knows, the same one the Windows Scan app
  uses; no HP Smart app is needed): a **Scan** button stands beside
  every document upload, the scanned page is uploaded, and a green ✔ shows it. From E-Portal 2.2, **Scan** always opens
  the Windows scanner window: choose the scanner (colour and size too), press **Scan** there, and the page is saved by
  itself (no new app is needed).
  From version 1.6 the app **updates itself**: at start and every 4 hours it looks for a newer version (the release
  `windows-v<version>` that GitHub Actions publishes when `apps/windows/package.json` gets a new version on main),
  downloads it, checks its SHA-256, and asks **Restart now** or **Later** (Later installs it when the app is closed).
  **Help › Check for Updates…** looks at once. Download: https://github.com/EmonOverrunsinc/EMON-OVERRUNS/releases/latest
- **Android**: `EMON-OVERRUNS-E-Portal-<version>.apk` opens the E-Portal full screen in Chrome.
- How they are built and signed: [apps/README.md](apps/README.md).

## Files
- `public/index.html`, `app.js`, `modules.js` to `modules4.js`, `styles.css`: the app
- `public/config.js`: Supabase URL, publishable key and company details
- `public/vendor/`: bundled libraries (supabase-js, bwip-js for PDF417, ZXing scanner, Chart.js)
- `supabase/portal_init.sql`: database setup
- `public/.well-known/assetlinks.json`: lets the Android app open the E-Portal full screen
- `apps/windows/`, `apps/android/`: the Windows and Android apps
