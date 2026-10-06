# E-Portal apps for Windows and Android

Both apps open the live E-Portal (https://emon-overruns.vercel.app). Records, prints and uploads come from the
site, so a change to the E-Portal reaches the apps at once and the apps rarely need a new version.

## Windows 11: `windows/`
An Electron window with the E-Portal:
- Links to other sites, e-mail and phone open outside the app.
- E-Portal pages and uploaded files that open in a new tab get their own app window.
- The camera (scanning codes) and the clipboard are allowed for the E-Portal only.
- Without internet it shows a page that tries again by itself.
- Only one copy of the app runs at a time, and it remembers its window size.

The Setup program installs for the signed-in Windows user, with no administrator rights. It adds Start menu and
desktop shortcuts, and an uninstaller in **Settings › Apps**.

GitHub builds it when `apps/windows` changes (`.github/workflows/windows-app.yml`): open **Actions › Windows app**,
then the newest run, and download **EMON-OVERRUNS-E-Portal-Setup-<version>.exe** under Artifacts (sign in to GitHub).
Artifacts are kept for 90 days, so keep a copy of the installer.

Build it yourself (Linux, macOS or Windows; needs Node.js and NSIS's `makensis`):

    cd apps/windows
    npm install
    npm run build      # → dist/EMON-OVERRUNS-E-Portal-Setup-<version>.exe

The program is not code-signed, so Windows SmartScreen asks once: **More info › Run anyway**.

## Android: `android/`
A Trusted Web Activity (package `com.emonoverruns.eportal`): the E-Portal opens full screen in the phone's Chrome.
Printing (Save as PDF), uploads, the camera and downloads work as they do in Chrome.
The site confirms the app in `public/.well-known/assetlinks.json` with the fingerprint of the release key. Without
that file the app still works, but shows an address bar.

Build: GitHub Actions (`.github/workflows/android-app.yml`) builds an **unsigned** APK when `apps/android` changes,
and keeps it with the build log under the run's Artifacts (**Actions › Android app**). The release key is **not** in this public repository. EMON
OVERRUNS keeps it (`eportal-release.jks`, alias `eportal`). Sign the downloaded APK with it:

    zipalign -p -f 4 E-Portal-unsigned.apk E-Portal-aligned.apk
    apksigner sign --ks eportal-release.jks --ks-key-alias eportal --out EMON-OVERRUNS-E-Portal.apk E-Portal-aligned.apk

Raise `versionCode` in `android/app/build.gradle` for each new APK, so phones accept it as an update. Always sign
with the same key: a different key cannot update the installed app, and it would also need a new fingerprint in
`assetlinks.json`.
