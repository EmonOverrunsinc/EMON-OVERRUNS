#!/bin/bash
# Builds the Windows Setup program: dist/EMON-OVERRUNS-E-Portal-Setup-<version>.exe
# Needs Node.js (npm install first) and NSIS (makensis). Works on Windows, Linux or macOS.
set -euo pipefail
cd "$(dirname "$0")"
VERSION=$(node -p "require('./package.json').version")
rm -rf dist
npx --no-install electron-packager . "E-Portal" --platform=win32 --arch=x64 --out=dist --overwrite --asar \
  --icon=icon.ico --executable-name="E-Portal" --app-version="$VERSION" --build-version="$VERSION" \
  --app-copyright="EMON OVERRUNS" \
  --win32metadata.CompanyName="EMON OVERRUNS" --win32metadata.FileDescription="EMON OVERRUNS E-Portal" \
  --win32metadata.ProductName="EMON OVERRUNS E-Portal" --win32metadata.InternalName="E-Portal" \
  --win32metadata.OriginalFilename="E-Portal.exe" \
  --ignore='^/(dist|build\.sh|installer\.nsi|icon\.ico|README\.md|test)($|/)'
# English screens only: Chromium uses en-US when a language file is missing, and the installer is smaller
find dist/E-Portal-win32-x64/locales -type f ! -name 'en-US.pak' -delete
makensis -V2 -DVERSION="$VERSION" installer.nsi
ls -l dist/*.exe
