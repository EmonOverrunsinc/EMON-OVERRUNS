; EMON OVERRUNS E-Portal for Windows: the Setup program.
; It installs for the signed-in Windows user (no administrator rights needed), adds Start menu and
; desktop shortcuts, and an uninstaller in Settings > Apps.
; Windows 11 is 64-bit only, and so is the app
Target amd64-unicode
!include "MUI2.nsh"
!include "FileFunc.nsh"

!define APPNAME "EMON OVERRUNS E-Portal"
!define EXE "E-Portal.exe"
!define COMPANY "EMON OVERRUNS"
!ifndef VERSION
  !define VERSION "1.3.0"
!endif
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\EMONOVERRUNS.EPortal"

Name "${APPNAME}"
OutFile "dist/EMON-OVERRUNS-E-Portal-Setup-${VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\${APPNAME}"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "${COMPANY} · Ignacio Street, Pasay City"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APPNAME}"
VIAddVersionKey "CompanyName" "${COMPANY}"
VIAddVersionKey "FileDescription" "${APPNAME} Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "© ${COMPANY}"

!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Install the ${APPNAME}"
!define MUI_WELCOMEPAGE_TEXT "This installs the ${APPNAME} on this computer.$\r$\n$\r$\nThe app opens the live E-Portal in its own window, so it always has the newest version. It needs an internet connection.$\r$\n$\r$\nClick Next to install."
!define MUI_FINISHPAGE_TITLE "The E-Portal is installed"
!define MUI_FINISHPAGE_TEXT "Open it from the desktop or the Start menu: ${APPNAME}."
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Open the E-Portal now"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  ; An open E-Portal keeps its files locked: ask to close it first.
  close_check:
    ClearErrors
    IfFileExists "$INSTDIR\${EXE}" 0 install_files
    Delete "$INSTDIR\${EXE}"
    IfErrors 0 install_files
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "The E-Portal is open. Please close it, then click Retry." /SD IDCANCEL IDRETRY close_check
    Abort "Setup was stopped because the E-Portal is still open."
  install_files:
  ; the old version goes first, so no old file stays behind
  RMDir /r "$INSTDIR"
  SetOutPath "$INSTDIR"
  File /r "dist/E-Portal-win32-x64/*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateShortCut "$SMPROGRAMS\${APPNAME}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0
  CreateShortCut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0

  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "${COMPANY}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\${EXE}"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTKEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINSTKEY}" "EstimatedSize" "$0"
SectionEnd

Section "Uninstall"
  close_check:
    ClearErrors
    IfFileExists "$INSTDIR\${EXE}" 0 remove_files
    Delete "$INSTDIR\${EXE}"
    IfErrors 0 remove_files
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "The E-Portal is open. Please close it, then click Retry." /SD IDCANCEL IDRETRY close_check
    Abort "The E-Portal is still open."
  remove_files:
  Delete "$SMPROGRAMS\${APPNAME}.lnk"
  Delete "$DESKTOP\${APPNAME}.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNINSTKEY}"
SectionEnd
