// EMON OVERRUNS E-Portal for Windows: the live E-Portal in its own window.
// Records, prints and uploads all come from the live site, so the app does not need an update when the
// E-Portal changes. This file only makes the window, the menu, the rules for links, files and the camera, and the
// scanning with the scanner of the computer (1.4).
const { app, BrowserWindow, Menu, shell, dialog, session, clipboard, screen, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFile } = require("child_process");

const HOME = process.env.EO_URL || "https://emon-overruns.vercel.app/#dashboard";
const SITE = new URL(HOME).origin;
const FILES = "https://mgwqjjkwonhzrfndkray.supabase.co"; // uploaded files open from signed links
const ICON = path.join(__dirname, "icon.png");

const originOf = (u) => { try { return new URL(u).origin; } catch { return ""; } };
const inApp = (u) => [SITE, FILES].includes(originOf(u));

// Links to other sites, e-mail and phone numbers open outside the app.
function openOutside(u) {
  if (/^(https?:|mailto:|tel:)/i.test(u || "")) shell.openExternal(u).catch(() => {});
}

// ---------- window size and place, kept for the next start ----------
const stateFile = () => path.join(app.getPath("userData"), "window.json");
function savedState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    const b = s.bounds, cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    const seen = screen.getAllDisplays().some(({ workArea: w }) => cx >= w.x && cx <= w.x + w.width && cy >= w.y && cy <= w.y + w.height);
    return seen ? s : null;
  } catch { return null; }
}
function saveState(win) {
  try { fs.writeFileSync(stateFile(), JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized() })); } catch {}
}

// ---------- the rules every E-Portal window follows ----------
function wire(win) {
  const wc = win.webContents;
  // Pages of the E-Portal and uploaded files open in a new app window; anything else in the browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (inApp(url)) {
      return { action: "allow", overrideBrowserWindowOptions: { width: 1100, height: 800, icon: ICON, autoHideMenuBar: true, backgroundColor: "#ffffff" } };
    }
    openOutside(url);
    return { action: "deny" };
  });
  wc.on("did-create-window", (child) => wire(child));
  wc.on("will-navigate", (e, url) => {
    if (inApp(url)) return;
    e.preventDefault();
    openOutside(url);
  });
  // No internet: a page that tries again by itself
  wc.on("did-fail-load", (e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || !inApp(url)) return; // -3: stopped on purpose (for example a download)
    win.loadFile(path.join(__dirname, "offline.html"), { query: { u: url } });
  });
  // Right-click: cut, copy, paste and spelling
  wc.on("context-menu", (e, p) => {
    const items = [];
    for (const s of (p.dictionarySuggestions || []).slice(0, 4)) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
    if (items.length) items.push({ type: "separator" });
    if (p.isEditable) {
      items.push({ role: "cut", enabled: p.editFlags.canCut }, { role: "copy", enabled: p.editFlags.canCopy },
        { role: "paste", enabled: p.editFlags.canPaste }, { type: "separator" }, { role: "selectAll" });
    } else if (p.selectionText && p.selectionText.trim()) {
      items.push({ role: "copy" });
    }
    if (p.linkURL && /^https?:/.test(p.linkURL)) items.push({ label: "Copy Link", click: () => clipboard.writeText(p.linkURL) });
    if (p.mediaType === "image" && p.srcURL) items.push({ label: "Save Image As…", click: () => wc.downloadURL(p.srcURL) });
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
}

function createWindow() {
  const st = savedState();
  const win = new BrowserWindow({
    width: 1280, height: 860, ...(st ? st.bounds : {}),
    minWidth: 360, minHeight: 480,
    title: "EMON OVERRUNS E-Portal",
    icon: ICON,
    backgroundColor: "#ffffff",
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true, preload: path.join(__dirname, "preload.js") },
  });
  win.once("ready-to-show", () => {
    if (!st || st.maximized) win.maximize(); // the first start fills the screen
    win.show();
  });
  win.on("close", () => saveState(win));
  wire(win);
  win.loadURL(HOME);
  return win;
}

// ---------- scanning with the scanner of this computer (an HP printer and others) ----------
// Windows Image Acquisition (the scanner driver that comes with the printer, or the one Windows adds for a printer on
// the same Wi-Fi) is used through PowerShell: no other program is needed. The page is saved as a JPEG and given to the
// E-Portal page, which uploads it.
const scanFile = () => path.join(app.getPath("userData"), "scanner.json");
const QUALITY = [
  { label: "Colour, 200 dpi (recommended)", dpi: 200, intent: 1 },
  { label: "Grey, 200 dpi (smaller files)", dpi: 200, intent: 2 },
  { label: "Colour, 300 dpi (best)", dpi: 300, intent: 1 },
];
function scanSettings() {
  try { return { dpi: 200, intent: 1, ...JSON.parse(fs.readFileSync(scanFile(), "utf8")) }; } catch { return { dpi: 200, intent: 1 }; }
}
function saveScanSettings(change) {
  try { fs.writeFileSync(scanFile(), JSON.stringify({ ...scanSettings(), ...change })); } catch {}
}

// EO_MODE: scan (the chosen scanner, or the first one), dialog (the scanner window) or select (choose the scanner).
const SCAN_PS = `
$ErrorActionPreference = 'Stop'
$jpeg = '{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}'
function SetProp($props, $id, $value) { foreach ($p in $props) { if ($p.PropertyID -eq $id) { try { $p.Value = $value } catch {} } } }
try {
  if ($env:EO_MODE -eq 'select') {
    $dev = (New-Object -ComObject WIA.CommonDialog).ShowSelectDevice(1, $true, $true)
    Write-Output ('DEVICE:' + $dev.DeviceID + '|' + $dev.Properties.Item('Name').Value)
    exit 0
  }
  if ($env:EO_MODE -eq 'dialog') {
    $img = (New-Object -ComObject WIA.CommonDialog).ShowAcquireImage(1, [int]$env:EO_INTENT, 131072, $jpeg, $false, $true, $true)
  } else {
    $dm = New-Object -ComObject WIA.DeviceManager
    $info = $null
    foreach ($d in $dm.DeviceInfos) { if ($d.Type -eq 1 -and $d.DeviceID -eq $env:EO_DEVICE) { $info = $d } }
    if (-not $info) { foreach ($d in $dm.DeviceInfos) { if ($d.Type -eq 1 -and -not $info) { $info = $d } } }
    if (-not $info) { Write-Output 'ERROR:NO_SCANNER'; exit 3 }
    $item = $info.Connect().Items.Item(1)
    SetProp $item.Properties 6146 ([int]$env:EO_INTENT)
    SetProp $item.Properties 6147 ([int]$env:EO_DPI)
    SetProp $item.Properties 6148 ([int]$env:EO_DPI)
    try { $img = $item.Transfer($jpeg) } catch { $img = $item.Transfer() }
  }
  if (-not $img) { Write-Output 'ERROR:80210064'; exit 2 }
  if ($img.FormatID -ne $jpeg) {
    $ip = New-Object -ComObject WIA.ImageProcess
    $ip.Filters.Add($ip.FilterInfos.Item('Convert').FilterID)
    $ip.Filters.Item(1).Properties.Item('FormatID').Value = $jpeg
    $ip.Filters.Item(1).Properties.Item('Quality').Value = 85
    $img = $ip.Apply($img)
  }
  if (Test-Path $env:EO_OUT) { Remove-Item $env:EO_OUT -Force }
  $img.SaveFile($env:EO_OUT)
  Write-Output 'OK'
} catch {
  # the scanner's own error code is inside the error PowerShell gives
  $ex = $_.Exception
  while ($ex.InnerException) { $ex = $ex.InnerException }
  Write-Output ('ERROR:' + ('{0:X8}' -f $ex.HResult) + ':' + $ex.Message)
  exit 2
}
`;
function powershell(env, timeout = 180000) {
  return new Promise((resolve) => {
    const enc = Buffer.from(SCAN_PS, "utf16le").toString("base64");
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc],
      { env: { ...process.env, ...env }, windowsHide: true, timeout, maxBuffer: 1 << 20 },
      (err, stdout) => resolve(String(stdout || "").trim().split(/\r?\n/).pop() || (err && err.killed ? "ERROR:TIMEOUT" : "ERROR:" + (err ? err.message : "?"))));
  });
}
const NO_SCANNER = "No scanner was found. Turn on the HP printer and check that it is connected to this computer (USB cable, or the same Wi-Fi), then try again. Scanner › Choose Scanner shows the scanners Windows knows.";
const SCAN_ERRORS = {
  NO_SCANNER, "80210015": NO_SCANNER,
  "80210005": "The scanner is offline. Turn on the printer, wait a moment, then try again.",
  "80210006": "The scanner is busy. Wait until it is free, then try again.",
  "80210003": "There is no paper in the document feeder. Put the page on the scanner glass or in the feeder, then try again.",
  "80210002": "The paper is stuck in the scanner. Take it out, then try again.",
  "80210016": "The scanner lid is open. Close it, then try again.",
  "8021000A": "The computer could not reach the scanner. Check the USB cable or the Wi-Fi, then try again.",
  TIMEOUT: "The scan took too long. Check the scanner, then try again.",
};
function scanResult(out) {
  if (out === "OK") return { ok: true };
  const code = (out.match(/^ERROR:([0-9A-F]{8}|[A-Z_]+)/) || [])[1] || "";
  if (code === "80210064" || code === "80210065") return { cancelled: true }; // the scan was cancelled
  return { error: SCAN_ERRORS[code] || `The scan did not work${code ? ` (code ${code})` : ""}. Try the scanner window, or choose your scanner in Scanner › Choose Scanner.` };
}
let scanning = false;
ipcMain.handle("eo-scan", async (e, opts) => {
  if (!inApp(e.senderFrame ? e.senderFrame.url : "")) return { error: "Scanning is only for the E-Portal." };
  if (process.platform !== "win32") return { error: "Scanning works in the E-Portal app for Windows." };
  if (scanning) return { error: "A scan is already running. Wait for it to finish." };
  scanning = true;
  const s = scanSettings();
  const stampOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}_${String(d.getHours()).padStart(2, "0")}-${String(d.getMinutes()).padStart(2, "0")}-${String(d.getSeconds()).padStart(2, "0")}`;
  const name = `Scan_${stampOf(new Date())}.jpg`;
  const out = path.join(os.tmpdir(), `EO-${process.pid}-${Date.now()}.jpg`);
  try {
    const r = scanResult(await powershell({ EO_MODE: opts && opts.dialog ? "dialog" : "scan", EO_OUT: out, EO_DPI: String(s.dpi), EO_INTENT: String(s.intent), EO_DEVICE: s.deviceId || "" }));
    if (!r.ok) return r;
    const data = await fs.promises.readFile(out);
    return { ok: true, name, type: "image/jpeg", data: data.toString("base64") };
  } catch (err) {
    return { error: "The scan did not work: " + err.message };
  } finally {
    scanning = false;
    fs.promises.unlink(out).catch(() => {});
  }
});
async function chooseScanner() {
  if (process.platform !== "win32") return;
  const out = await powershell({ EO_MODE: "select" }, 120000);
  const m = out.match(/^DEVICE:([^|]*)\|(.*)$/);
  if (m) {
    saveScanSettings({ deviceId: m[1], deviceName: m[2] });
    dialog.showMessageBox(current(), { type: "info", title: "Scanner", icon: ICON, message: `Scanner: ${m[2]}`, detail: "The Scan buttons of the E-Portal now use this scanner." });
  } else {
    const r = scanResult(out);
    if (r.error) dialog.showMessageBox(current(), { type: "warning", title: "Scanner", icon: ICON, message: r.error });
  }
  buildMenu();
}

const current = () => BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
const history = (w) => w && w.webContents.navigationHistory;

function buildMenu() {
  const about = () => dialog.showMessageBox(current(), {
    type: "info", title: "About", icon: ICON, buttons: ["OK"],
    message: "EMON OVERRUNS E-Portal",
    detail: `Version ${app.getVersion()}\nIgnacio Street, Pasay City, Metro Manila 1300\n\n${SITE}`,
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "E-Portal", submenu: [
      { label: "Dashboard", accelerator: "Alt+Home", click: () => current() && current().loadURL(HOME) },
      { label: "Print…", accelerator: "CmdOrCtrl+P", click: () => current() && current().webContents.print() },
      { label: "Reload", accelerator: "F5", click: () => current() && current().webContents.reload() },
      { label: "Reload", accelerator: "CmdOrCtrl+R", visible: false, click: () => current() && current().webContents.reload() },
      { type: "separator" },
      { label: "Open in Browser", click: () => current() && openOutside(current().webContents.getURL()) },
      { type: "separator" },
      { role: "quit", label: "Exit" },
    ] },
    { role: "editMenu" },
    { label: "View", submenu: [
      { label: "Back", accelerator: "Alt+Left", click: () => { const h = history(current()); if (h && h.canGoBack()) h.goBack(); } },
      { label: "Forward", accelerator: "Alt+Right", click: () => { const h = history(current()); if (h && h.canGoForward()) h.goForward(); } },
      { type: "separator" },
      { role: "zoomIn" }, { role: "zoomOut" }, { role: "resetZoom" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ] },
    { label: "Scanner", submenu: [
      { label: `Choose Scanner…${scanSettings().deviceName ? `  (${scanSettings().deviceName})` : ""}`, click: () => chooseScanner() },
      { type: "separator" },
      ...QUALITY.map((q) => ({ label: q.label, type: "radio", checked: scanSettings().dpi === q.dpi && scanSettings().intent === q.intent,
        click: () => saveScanSettings({ dpi: q.dpi, intent: q.intent }) })),
    ] },
    { label: "Help", submenu: [{ label: "About E-Portal", click: about }] },
  ]));
}

// One E-Portal at a time: opening it again brings the open window to the front.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); }
  });
  app.on("web-contents-created", (e, wc) => wc.on("will-attach-webview", (ev) => ev.preventDefault()));
  app.whenReady().then(() => {
    // The camera (scanning codes), the clipboard and full screen are allowed for the E-Portal only.
    session.defaultSession.setPermissionRequestHandler((wc, permission, done, details) => done(inApp(details.requestingUrl || wc.getURL())));
    session.defaultSession.setPermissionCheckHandler((wc, permission, origin) => inApp(origin));
    buildMenu();
    createWindow();
  });
  app.on("window-all-closed", () => app.quit());
}
