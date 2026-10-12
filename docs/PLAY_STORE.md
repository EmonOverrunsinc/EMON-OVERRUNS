# Putting the E-Portal on the Google Play Store

Everything the Play Store asks for is ready in this repository. This page lists what to type and upload, in order.

| Ready | Where |
|---|---|
| Android app 1.4 (Android 16, API 36; App Bundle `.aab`) | GitHub › Actions › **Android app** › newest run |
| Privacy Policy | https://www.emonoverruns.online/privacy |
| Delete Account page | https://www.emonoverruns.online/delete-account |
| App icon 512 × 512 | `apps/android/play/app-icon-512.png` |
| Feature graphic 1024 × 500 | `apps/android/play/feature-graphic-1024x500.png` |
| Phone screenshots 1080 × 1920 (made-up sample customers) | `apps/android/play/phone-1 … phone-6` |

## 1. Before you start (one time)

1. **Google Play Console account**: https://play.google.com/console, US$25 once. Choose **Organization** and give the
   D-U-N-S number of EMON OVERRUNS (free at dnb.com). A **Personal** account must first test the app with 12 testers
   for 14 days in a row before it can be published.
2. **Database update 2.4**: in Supabase › SQL Editor, paste `supabase/017_play_store.sql` and press **Run**. It should
   say `UPDATE 2.4 READY`. This adds the **Delete** button on Login Accounts.
3. **The app key in GitHub** (so GitHub signs the app for you; you never send the key or passwords to anybody):
   GitHub › EMON-OVERRUNS › **Settings › Secrets and variables › Actions › New repository secret**, four times:

   | Name | Value |
   |---|---|
   | `ANDROID_KEYSTORE_BASE64` | the key file `eportal-release.jks` as text (below) |
   | `ANDROID_KEYSTORE_PASSWORD` | the key file's password |
   | `ANDROID_KEY_ALIAS` | `eportal` |
   | `ANDROID_KEY_PASSWORD` | the key's password (often the same) |

   The key file as text, on Windows (PowerShell, in the folder of the file), copied to the clipboard:

       [Convert]::ToBase64String([IO.File]::ReadAllBytes("eportal-release.jks")) | Set-Clipboard

   Then GitHub › **Actions › Android app › Run workflow**. When it is done, download **E-Portal-Android-signed**:
   it holds `EMON-OVERRUNS-E-Portal-1.4.aab` (for the Play Store) and `EMON-OVERRUNS-E-Portal-1.4.apk`.

4. **A login for Google's reviewers**: on the E-Portal tap **Create Account** with
   `emonoverruns+playreview@gmail.com` (the code arrives in emonoverruns@gmail.com), name `Play Review`. Then tell
   Claude, who gives it viewer access **without any customer records** (Google's reviewers must not see real
   customers). Type its password only in Play Console.

## 2. Create the app in Play Console

**Create app**: name `EMON OVERRUNS E-Portal`, language English (United States), **App**, **Free**, accept the declarations.

### App content (Policy › App content)
- **Privacy policy**: `https://www.emonoverruns.online/privacy`
- **App access**: *All or some functionality is restricted* › add instructions: name `Reviewer login`, username
  `emonoverruns+playreview@gmail.com`, password (the one you chose), note: *Sign in on the first screen. The account
  has viewer access without customer records.*
- **Ads**: No, the app has no ads.
- **Content rating**: email emonoverruns@gmail.com, category *All other app types*. Violence, sexuality, language,
  drugs, gambling: **No**. Users can interact or exchange content: **Yes** (staff chat messages). Shares location:
  **No**. Digital purchases: **No**.
- **Target audience**: **18 and over** only. Not designed for children.
- **News app**: No. **COVID-19 app**: No. **Government app**: No.
- **Financial features**: *My app doesn't provide any financial features* (it keeps business records; no loans,
  payments or banking).
- **Health**: no health features.
- **Data safety** (answers):
  - Collects or shares data: **Yes**. Encrypted in transit: **Yes**. People can ask for their data to be deleted:
    **Yes**, link `https://www.emonoverruns.online/delete-account`.
  - Shared with third parties: **No** (Supabase, Vercel and Google work for us as service providers; that is not
    "sharing" in Google's form).
  - Collected (all **required**, purpose **App functionality** and **Account management**, not used for ads):
    - Personal info: Name, Email address, User IDs (username), Address, Phone number, Political or religious beliefs
      (religion on job applications), Other info (gender, date of birth, ID number on job applications)
    - Health info (blood group on job applications)
    - Financial info: Other financial info (invoices, payments, salary)
    - Messages: Other in-app messages
    - Photos and videos: Photos
    - Files and docs
    - App info and performance: Diagnostics (page speed, purpose **Analytics**, not linked to a person)
  - Not collected: location, contacts, calendar, web browsing, device IDs, audio.

### Store listing (Grow users › Store presence › Main store listing)
- **App name**: `EMON OVERRUNS E-Portal`
- **Short description** (74 of 80 letters): `Customer accounts, invoices, payments and record checks for EMON OVERRUNS.`
- **Full description**:

      The official E-Portal of EMON OVERRUNS, Pasay City, Metro Manila.

      For our staff, customers and job applicants:
      • Customer accounts with account numbers, monthly statements (SOA) and balances
      • Invoices, payments received and credit memos
      • Verify a printed record: scan its QR code or barcode to check that it is genuine
      • Employees, payslips and job applications
      • Order letters approved by the Director, with signatures
      • Messages between staff, and Contact Us with a reference number
      • Scan documents with the phone camera; pictures are made smaller and stay clear in print

      Sign-in is needed for the portal. New accounts are checked by the Director.
      Privacy Policy: https://www.emonoverruns.online/privacy

- **App icon**: `app-icon-512.png` · **Feature graphic**: `feature-graphic-1024x500.png`
- **Phone screenshots**: `phone-1-sign-in.png` … `phone-6-invoices.png`
- **Category**: Business · **Email**: emonoverruns@gmail.com · **Website**: https://www.emonoverruns.online

## 3. Upload the app

1. **Test and release** › *Production* (Organization account) or *Closed testing* (Personal account) ›
   **Create new release**.
2. **App signing**: keep **Google-generated key** (recommended) and continue.
3. Upload `EMON-OVERRUNS-E-Portal-1.4.aab`. Release name `1.4`. Release notes: `First release on Google Play.`
4. **Next › Save › Send for review.** Google's review usually takes a few days.

## 4. After the first upload: full screen without the browser bar

Play Console › **Test and release › App integrity › App signing** › copy **SHA-256 certificate fingerprint** of the
*App signing key certificate* (it looks like `AB:CD:12:…`, it is not a password) and send it to Claude. It goes into
`public/.well-known/assetlinks.json` next to the current one, so the app from the Play Store opens full screen.

Phones that have the old E-Portal APK: uninstall it once, then install the E-Portal from the Play Store.

## Every later update
Raise `versionCode` (and `versionName`) in `apps/android/app/build.gradle`; GitHub builds and signs the new `.aab`;
upload it in Play Console as a new release. Most changes need no new app at all: the app always opens the live E-Portal.
