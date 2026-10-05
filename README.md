# Emon Overruns Portal

**Live:** https://emon-overruns.vercel.app

Business portal for **EMON OVERRUNS**, Ignacio Street, Pasay City, Metro Manila 1300.
It is laid out like AutoCount: option panel, then Inquiry, Preview and Print, then a grid, and printable report pages.

## Modules
| Menu | What it does | Who |
|---|---|---|
| Dashboard | Totals, monthly ₱ chart, recent documents, announcements, Monthly Analysis report | Everyone |
| Documents | Filter by date, type and status. Inquiry grid, Group By, and a printable **Document Listing** with summary and criteria | Everyone |
| Upload | New document with attachments. Gets an auto number (INV-, OR-, DN-, CN-, DEP-, PV-) and a **PDF417 barcode** | Staff, Admin |
| Verification | Pending queue with Verify, Reject and Reopen, plus a printable **Verification Audit Trail Listing** | Admin acts, everyone views |
| Search | Keyword search, or **scan a PDF417** by camera or from a photo to open the document | Everyone |
| Download Forms | Blank company forms by category, with download counts | Admin uploads, everyone downloads |
| Announcements | Post and pin notices. The newest show on the Dashboard | Admin posts |
| Users | Activate sign-ups and set roles (admin, staff, viewer) | Admin |

All amounts are in **PHP (₱)**. Vouchers print the amount in words, for example "PESOS ONE THOUSAND … AND 50/100 ONLY".

## Business modules (side menu)
1. **Customer:** application form with address check, photo, Facebook and requirement uploads. It assigns the account no (initials-YYYYMM###, e.g. EH-202610001), application no, QR public ID and a hidden private code, then prints an application for signing. Admin review covers the duplicate check, the signed-form upload and approve/reject.
2. **Invoice:** record a sale for an ACTIVE customer (PO, boxes, pcs, amount, paid or unpaid with cash or bank details, receipts, delivery receipt, PO upload).
3. **Payment:** cash, bank transfer, online transfer or deposit. Receipt no A-YYYY-MMDD-###, with a printable acknowledgment receipt.
4. **Credit Memo:** customer complaint or defect claim (report no EOC-YYYYMM###). Admin approve/reject and mark paid. Approved credit or discount amounts reduce the balance due.
5. **User Resolution:** suspend, reactivate or permanently close accounts. Closed accounts cannot get new invoices and are hidden from the top search.
7. **Project** and 8. **Billing:** coming soon.

Database scripts, run once each in this order in the Supabase SQL Editor: `portal_init.sql`, `002_customers_invoices_payments.sql`,
`003_statements.sql`, `004_update_1_1.sql`, `005_update_1_2.sql` (orders for customers, employees and billing companies),
`006_update_1_3.sql` (billing currency PHP / BDT / both, order details, balance certificate, wallet-style Public ID key).

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
- `public/index.html`, `app.js`, `styles.css`: the app
- `public/config.js`: Supabase URL, publishable key and company details
- `public/vendor/`: bundled libraries (supabase-js, bwip-js for PDF417, ZXing scanner, Chart.js)
- `supabase/portal_init.sql`: database setup
