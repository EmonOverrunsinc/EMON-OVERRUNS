# Emon Overruns Portal

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
| 7. Project | Projects with their costs and payments |
| 8. Billing | Billing companies (PHP, BDT or both), payment vouchers, and e-bills (released stock-bills) that a payment can be linked to |
| 9. Order Letter | Requests for customers, employees, billing companies and stock-bills (closure, reactivation, additional charge, settlement adjustment, balance certificate, release order and more); the Director approves and it is carried out at once |
| 10. Inventory | Stock-bills in BDT with their own item columns and rows and the uploaded bill; Release Order (release date and shipping bill); Sales Report (net sales, EOO fees, other fees and penalties with their receipts); status SHIPPED → ARRIVED → RELEASED → SOLD → PAID; the profit or loss shows after the Director marks it PAID, with a Statistics Report and its secret code |
| Verification | Anyone can check a record by its number or by scanning its QR / PDF417 code, without signing in. A stock-bill is shown only for the secret code on its Statistics Report |
| Corrections | Records are only added; corrections and cancellations are approved by the Director |
| User | Logins, access levels and which modules each person can open (Director) |
| Download Forms | Blank company forms |

Amounts are in **PHP (₱)** (Billing also uses BDT; Inventory uses BDT). Dates show as MM-DD-YYYY in Manila time. Vouchers print the amount in words, for example "PESOS ONE THOUSAND … AND 50/100 ONLY".

Numbers: account no initials-YYYYMM### (e.g. EH-202610001), payment receipt A-YYYY-MMDD-###, credit memo EOC-YYYYMM###, order letter ORDER-YYYY-###, stock-bill SB-YYYY-####.

Database scripts, run once each in this order in the Supabase SQL Editor: `portal_init.sql`, `002_customers_invoices_payments.sql`,
`003_statements.sql`, `004_update_1_1.sql`, `005_update_1_2.sql` (orders for customers, employees and billing companies),
`006_update_1_3.sql` (billing currency PHP / BDT / both, order details, balance certificate, wallet-style Public ID key),
`007_update_1_4.sql` (change or remove a customer's photo),
`008_update_1_5.sql` (order letter Additional Charge added to the balance and the SOA; old photos leave Files),
`009_update_1_6.sql` (dates follow Manila time: between midnight and 8 AM the database no longer uses the day before;
run it again after any later update that replaces a function, so the replaced function keeps Manila time).
`010_update_1_7.sql` (wording: the database says Director instead of CEO, Employee instead of Staff, and clearer messages and history lines).
`011_update_1_8.sql` (a wrong upload can be removed and uploaded again; customer credit limit, opening balance, address checked by hand, account number preview).
`012_update_1_9.sql` (Inventory: stock-bills, release order, e-bills in Billing, sales report, PAID with the profit or loss and the secret code).

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

## Files
- `public/index.html`, `app.js`, `modules.js` to `modules4.js`, `styles.css`: the app
- `public/config.js`: Supabase URL, publishable key and company details
- `public/vendor/`: bundled libraries (supabase-js, bwip-js for PDF417, ZXing scanner, Chart.js)
- `supabase/portal_init.sql`: database setup
