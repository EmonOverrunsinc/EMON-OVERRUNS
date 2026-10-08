# Emon Overruns Portal (E-Portal v2.1)

**Live:** https://emon-overruns.vercel.app

Business portal for **EMON OVERRUNS**, Ignacio Street, Pasay City, Metro Manila 1300.
It is laid out like AutoCount: option panel, then Inquiry, Preview and Print, then a grid, and printable report pages.

## Modules (side menu)
| Menu | What it does |
|---|---|
| Dashboard | Totals, what is waiting for the Director (applications, orders, corrections, credit memos) and the monthly chart |
| 1. Customer | Application with photo and requirements, account no (shown as a preview on the form), address check, credit limit, opening balance, wallet-style Public ID with its QR, approval, profile with balance, monthly SOA and history |
| 2. Invoice | Sales for ACTIVE customers (PO, boxes, pcs, amount, receipts, delivery receipt) |
| 3. Payment | Cash, bank transfer, online transfer or deposit, with a printable acknowledgment receipt |
| 4. Credit Memo | Complaints and defect claims; approved credits and discounts reduce the balance due |
| 5. Employee | Employees, job applications, positions, payroll and payslips |
| 6. Community | Company posts (kept 30 days) and chat |
| 7. Project | Projects with their budget (each line with its amount; the qty is optional) and payments |
| 8. Billing | Billing companies (PHP, BDT or both) and payment vouchers (e-bills are paid with a memo in the Director Portal) |
| 9. Director Portal | Order letters for customers, employees, billing companies and e-bills (closure, reactivation, additional charge, settlement adjustment, balance certificate, Released Notice, memo and more). A memo to a company can have an amount in PESOS with the exchange rate of the day (the BDT amount is counted for you) and can name one e-bill of the company: once approved, the BDT amount is paid on that e-bill and its balance goes down. Every order waits for approval first and can be changed until then (Edit Order, by the person who sent it or the Director); once the Director approves it, it is carried out at once. The letter shows only the customer's name and account no (all details for a closed, reactivated or reopened account), or the company's name and authorized person |
| 10. E-Bill | E-bills in BDT with their own item columns and rows and the uploaded bill (batch no and total boxes needed; shipping company name and code); Released Notice: an order letter found by the batch no, price per box (PHP) × boxes = total (PHP), × the exchange rate of the day = released charge (BDT), plus the shipping fee, all shown in BDT and added to the e-bill's total cost once approved; Sales Report (net sales, EOO fees, other fees and penalties with their receipts; more can be added after PAID); payments by memo with the paid amount and the balance; steps 1 SHIP → 2 RELEASED → 3 SALES → 4 PAID (no payment is needed to mark it PAID); the profit or loss shows after the Director marks it PAID. One document, **E-BILL** with its batch no (for example E-BILL I-17), shows every record like a statement of account: the account summary, items, statement with the running balance, Sales Report, Released Notice, payments, history and files; after PAID also the profit or loss and the secret code |
| Verification | Anyone can check a record by its number or by scanning its QR / PDF417 code, without signing in. An e-bill is shown only for the secret code printed on its E-Bill once it is PAID |
| Corrections | Records are only added; corrections and cancellations are approved by the Director. What the Director deletes is gone for good, with its files, history lines and notices |
| User | Logins, access levels, which modules each person can open, and everyone's signature: approve, reject, remove or upload it (Director) |
| Download Forms | Blank company forms, and the built-in **SIGNATURE VERIFICATION FORM** (A4 PDF with boxes for three specimen signatures, the initials and the Director's approval) |
| My Profile | Photo, username, password, payslips, and **My Signature**: upload a photo of your signature (the white paper is taken away) and print your Signature Verification Form |

**Signatures (2.0):** everyone uploads their signature in My Profile. The Director's signature counts at once; anyone
else's waits until the Director approves it in User, and then their Signature Verification Form carries the Director's
signature. Every document the Director approves (order letters and certificates, customer applications, credit memos,
job applications, projects) prints the Director's signature, name and date by itself, so no signed copy is uploaded
after approval. A customer's or applicant's own signed form can still be uploaded before approval.

Amounts are in **PHP (₱)** (Billing also uses BDT; E-Bill uses BDT). Dates show as MM-DD-YYYY in Manila time. Vouchers print the amount in words, for example "PESOS ONE THOUSAND … AND 50/100 ONLY".

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
`014_update_2_1.sql` (Update 2.1: a memo to a company in PESOS × the exchange rate = BDT, paid on the e-bill it names once approved; the shipping company of an e-bill; Sales Report lines after PAID; what the Director deletes leaves no line in any history, and the old "deleted" lines are removed; a project budget line is its amount, with the qty optional).

## Setup (one time)
1. **Database**: in Supabase (project *EMONOVERRUNS*), open **SQL Editor**, paste `supabase/portal_init.sql` and run it.
   This creates the tables, security rules, document numbering, audit trail and the `documents` and `forms` storage buckets.
   The existing account (mdemon9559@gmail.com) becomes an active Admin, and so will emonoverruns@gmail.com when it signs up.
2. **Host the site**: upload the `public/` folder to any static host, such as Vercel, Netlify or Cloudflare Pages. There is no build step.
   - Vercel: New Project, Import, choose this folder, Framework "Other", Output directory `public`.
   - Netlify: drag the `public` folder onto app.netlify.com/drop.
3. **Auth links**: in Supabase, open **Authentication › URL Configuration** and set **Site URL** to your site address (for example https://emon-portal.vercel.app).
   Otherwise sign-up confirmation emails point to the wrong place.

## Daily use
- New staff click **Create Account**. They wait as *Pending* until an admin opens **Users**, sets the role and status to *Active*, and presses Save.
- **Upload**: fill in the document, attach the scan, and press Save. The record gets its number and PDF417 code and appears in **Verification**.
- **Preview** shows the report on A4 paper. **Print / Save PDF** opens the browser's print dialog.
- Scan the PDF417 on any printed voucher in **Search** to jump straight to the record.

## Apps for Windows and Android
- **Windows 11**: `EMON-OVERRUNS-E-Portal-Setup-<version>.exe` installs the E-Portal as an app, with a desktop shortcut.
- **Android**: `EMON-OVERRUNS-E-Portal-<version>.apk` opens the E-Portal full screen in Chrome.
- How they are built and signed: [apps/README.md](apps/README.md).

## Files
- `public/index.html`, `app.js`, `modules.js` to `modules4.js`, `styles.css`: the app
- `public/config.js`: Supabase URL, publishable key and company details
- `public/vendor/`: bundled libraries (supabase-js, bwip-js for PDF417, ZXing scanner, Chart.js)
- `supabase/portal_init.sql`: database setup
- `public/.well-known/assetlinks.json`: lets the Android app open the E-Portal full screen
- `apps/windows/`, `apps/android/`: the Windows and Android apps
