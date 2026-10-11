// EMON OVERRUNS E-Portal for Windows: the live E-Portal in its own window.
// Records, prints and uploads all come from the live site, so the app does not need an update when the
// E-Portal changes. This file only makes the window, the menu, the rules for links, files and the camera, and the
// scanning with the scanner of the computer (1.4; 1.5: the scan ends as soon as the page is saved, with its progress).
const { app, BrowserWindow, Menu, shell, dialog, session, clipboard, screen, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFile, spawn } = require("child_process");

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

// EO_MODE: scan (the chosen scanner, or the next one that answers), dialog (the scanner window) or select (choose the
// scanner). The script tells how far it is, one line at a time: STAGE:START, STAGE:CONNECT, STAGE:SOURCE:FEEDER|GLASS,
// STAGE:SCAN, STAGE:WAIT:<code> (warming up / busy), STAGE:WINDOW (the scanner window is open), STAGE:DIALOG and
// STAGE:DIALOG_CLOSED (a window of the scanner is open, e.g. an HP prompt), STAGE:CONVERT, STAGE:SAVE; then OK (the
// page is saved in EO_OUT), DEVICE:<id>|<name> or ERROR:<code>:<text>.
const SCAN_PS = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
function Say([string]$line) { [Console]::Out.WriteLine($line); [Console]::Out.Flush() }
function GetProp($props, $id) { foreach ($p in $props) { if ($p.PropertyID -eq $id) { return $p.Value } }; return $null }
function SetProp($props, $id, $value) { foreach ($p in $props) { if ($p.PropertyID -eq $id) { try { $p.Value = $value } catch {} } } }
function Code($err) { $ex = $err.Exception; while ($ex.InnerException) { $ex = $ex.InnerException }; return ('{0:X8}' -f $ex.HResult) }
$jpeg = '{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}'
Say 'STAGE:START'
# The app starts PowerShell without a window, and Windows then hides the FIRST window this program shows: that would be
# the scanner window, or a window of the scanner's driver (an HP scanner can show one), and the scan would wait for a
# window nobody can see. A window that is never seen takes that first show, so every later window shows normally.
$burn = $null
try {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $burn = New-Object System.Windows.Forms.Form
  $burn.Text = 'E-Portal scan'; $burn.StartPosition = 'Manual'; $burn.Opacity = 0
  $burn.Location = New-Object System.Drawing.Point(-32000, -32000); $burn.Size = New-Object System.Drawing.Size(1, 1)
  $burn.Show(); $burn.Hide()
} catch {}
# A window of the scanner (its own prompt, or the scanner window) is brought in front of the E-Portal, and the app is
# told while one is open.
try {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class EOWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  static System.Threading.Timer timer;
  static EnumProc visit;
  static List<IntPtr> seen = new List<IntPtr>();
  static IntPtr skip;
  static uint me;
  static int open, count;
  public static void Start(IntPtr burn, int pid) {
    skip = burn;
    me = (uint)pid;
    visit = new EnumProc(Visit);
    timer = new System.Threading.Timer(Tick, null, 300, 400);
  }
  static bool Visit(IntPtr h, IntPtr l) {
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    if (pid != me || h == skip || !IsWindowVisible(h)) return true;
    if ((GetWindowLong(h, -16) & 0x00C00000) != 0x00C00000) return true;
    count++;
    if (!seen.Contains(h)) {
      seen.Add(h);
      SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0043);
      SetForegroundWindow(h);
      SetWindowPos(h, new IntPtr(-2), 0, 0, 0, 0, 0x0013);
    }
    return true;
  }
  static void Tick(object state) {
    try {
      lock (seen) {
        count = 0;
        EnumWindows(visit, IntPtr.Zero);
        if (count > 0 && open == 0) { Console.Out.WriteLine("STAGE:DIALOG"); Console.Out.Flush(); }
        if (count == 0 && open > 0) { Console.Out.WriteLine("STAGE:DIALOG_CLOSED"); Console.Out.Flush(); }
        open = count;
      }
    } catch { }
  }
}
'@
  if ($burn) { [EOWin]::Start($burn.Handle, $PID) } else { [EOWin]::Start([IntPtr]::Zero, $PID) }
} catch {}
try {
  if ($env:EO_MODE -eq 'select') {
    $dev = (New-Object -ComObject WIA.CommonDialog).ShowSelectDevice(1, $true, $true)
    Say ('DEVICE:' + $dev.DeviceID + '|' + $dev.Properties.Item('Name').Value)
    [Environment]::Exit(0)
  }
  if ($env:EO_MODE -eq 'dialog') {
    Say 'STAGE:WINDOW'
    $img = (New-Object -ComObject WIA.CommonDialog).ShowAcquireImage(1, [int]$env:EO_INTENT, 131072, $jpeg, $false, $true, $true)
  } else {
    Say 'STAGE:CONNECT'
    $dm = New-Object -ComObject WIA.DeviceManager
    # the chosen scanner first, then the others (an HP printer can be listed twice: USB and Wi-Fi)
    $list = @()
    foreach ($d in $dm.DeviceInfos) { if ($d.Type -eq 1 -and $d.DeviceID -eq $env:EO_DEVICE) { $list += $d } }
    foreach ($d in $dm.DeviceInfos) { if ($d.Type -eq 1 -and $d.DeviceID -ne $env:EO_DEVICE) { $list += $d } }
    if ($list.Count -eq 0) { Say 'ERROR:NO_SCANNER'; [Environment]::Exit(3) }
    $dev = $null; $last = $null
    foreach ($d in $list) {
      try { $dev = $d.Connect(); break }
      catch { $last = $_; if (@('80210005', '8021000A', '80210015') -notcontains (Code $_)) { throw } }
    }
    if (-not $dev) { throw $last }
    # paper in the feeder: the feeder, one page; otherwise the glass
    $caps = GetProp $dev.Properties 3086; $state = GetProp $dev.Properties 3087
    if ($caps -and ($caps -band 1) -and $state -and ($state -band 1)) { SetProp $dev.Properties 3088 1; SetProp $dev.Properties 3096 1; Say 'STAGE:SOURCE:FEEDER' }
    elseif ($caps -and ($caps -band 2)) { SetProp $dev.Properties 3088 2; Say 'STAGE:SOURCE:GLASS' }
    $item = $dev.Items.Item(1)
    SetProp $item.Properties 6146 ([int]$env:EO_INTENT)
    SetProp $item.Properties 6147 ([int]$env:EO_DPI)
    SetProp $item.Properties 6148 ([int]$env:EO_DPI)
    $fmt = $null
    foreach ($f in $item.Formats) { if ($f -eq $jpeg) { $fmt = $jpeg } }
    Say 'STAGE:SCAN'
    # Scanned once: only warming up and busy (both before the paper moves) are tried again, 3 times.
    $img = $null
    for ($try = 1; $try -le 4; $try++) {
      try { if ($fmt) { $img = $item.Transfer($fmt) } else { $img = $item.Transfer() }; break }
      catch {
        $c = Code $_
        if ($try -lt 4 -and @('80210007', '80210006') -contains $c) { Say ('STAGE:WAIT:' + $c); Start-Sleep -Seconds 5; Say 'STAGE:SCAN' } else { throw }
      }
    }
  }
  if (-not $img) { Say 'ERROR:80210064'; [Environment]::Exit(2) }
  if ($img.FormatID -ne $jpeg) {
    Say 'STAGE:CONVERT'
    $ip = New-Object -ComObject WIA.ImageProcess
    $ip.Filters.Add($ip.FilterInfos.Item('Convert').FilterID)
    $ip.Filters.Item(1).Properties.Item('FormatID').Value = $jpeg
    $ip.Filters.Item(1).Properties.Item('Quality').Value = 85
    $img = $ip.Apply($img)
  }
  Say 'STAGE:SAVE'
  if (Test-Path $env:EO_OUT) { Remove-Item $env:EO_OUT -Force }
  $img.SaveFile($env:EO_OUT)
  Say 'OK'
  # end at once: a scanner driver can keep PowerShell open after the page is saved
  [Environment]::Exit(0)
} catch {
  # the scanner's own error code is inside the error PowerShell gives
  $ex = $_.Exception
  while ($ex.InnerException) { $ex = $ex.InnerException }
  Say ('ERROR:' + ('{0:X8}' -f $ex.HResult) + ':' + ($ex.Message -replace '[\r\n]+', ' '))
  [Environment]::Exit(2)
}
`;
// The script is run from a file in the app's folder (antivirus programs distrust long encoded commands); it is
// written again when the app has a new version. UTF-8 with BOM, so Windows PowerShell reads it right.
function scriptFile() {
  const file = path.join(app.getPath("userData"), `scan-${app.getVersion()}.ps1`), body = "﻿" + SCAN_PS;
  try { if (fs.readFileSync(file, "utf8") === body) return file; } catch {}
  try { fs.writeFileSync(file, body, "utf8"); return file; } catch { return null; }
}
// What the scans did, for checking a problem (Scanner › Open Scan Log).
const scanLog = () => path.join(app.getPath("userData"), "scan.log");
function logScan(line) {
  try {
    const f = scanLog();
    try { if (fs.statSync(f).size > 256 * 1024) fs.renameSync(f, f.replace(/\.log$/, ".old.log")); } catch {}
    fs.appendFileSync(f, `${new Date().toISOString()} ${line}\r\n`);
  } catch {}
}
// Closes PowerShell and anything it started (a scanner driver can keep it open, or the scan is cancelled).
function closeProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  logScan(`close PowerShell ${child.pid}`);
  execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => { try { child.kill(); } catch {} });
}
// Runs the scan script. The answer comes as soon as the script prints OK, DEVICE: or ERROR: (it does not wait for
// PowerShell to close, which an HP driver can hold up); PowerShell is then closed if it is still open 3 seconds later.
// onStage gets every STAGE line. While a window of the scanner is open the time limit is 10 minutes (the person may be
// answering it). Gives back { out, cancel }: out is a promise of the answer line.
function powershell(env, { timeout = 180000, onStage } = {}) {
  let finish;
  const out = new Promise((resolve) => {
    let done = false, rest = "", timer = null;
    const file = scriptFile();
    const args = ["-NoProfile", "-NonInteractive", "-NoLogo", "-STA", "-InputFormat", "None", "-ExecutionPolicy", "Bypass"];
    if (file) args.push("-File", file);
    else args.push("-EncodedCommand", Buffer.from(SCAN_PS, "utf16le").toString("base64"));
    const child = spawn("powershell.exe", args, { env: { ...process.env, ...env }, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    logScan(`start ${env.EO_MODE} PowerShell ${child.pid}`);
    const arm = (ms) => { clearTimeout(timer); timer = setTimeout(() => finish("ERROR:TIMEOUT"), ms); };
    arm(timeout);
    finish = (line) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      logScan(`answer ${line}`);
      resolve(line);
      if (line.startsWith("OK") || line.startsWith("DEVICE:")) setTimeout(() => closeProcess(child), 3000);
      else closeProcess(child);
    };
    const take = (line) => {
      line = line.trim();
      if (!line || done) return;
      if (line.startsWith("STAGE:")) {
        logScan(line);
        const st = line.slice(6);
        if (st === "DIALOG") arm(10 * 60000);
        if (st === "DIALOG_CLOSED") arm(timeout);
        if (onStage) onStage(st);
      } else if (line === "OK" || /^(DEVICE|ERROR):/.test(line)) finish(line);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop();
      lines.forEach(take);
    });
    child.on("error", (err) => finish("ERROR:NO_START:" + err.message));
    // a program PowerShell started can hold the output open after PowerShell has ended
    child.on("exit", (code) => setTimeout(() => { take(rest); rest = ""; finish(`ERROR:STOPPED:exit ${code}`); }, 300));
  });
  return { out, cancel: () => finish && finish("ERROR:80210064:cancelled") };
}
const NO_SCANNER = "No scanner was found. Turn on the HP printer and check that it is connected to this computer (USB cable, or the same Wi-Fi), then try again. Scanner › Choose Scanner shows the scanners Windows knows.";
const SCAN_ERRORS = {
  NO_SCANNER, "80210015": NO_SCANNER,
  "80210005": "The scanner is offline. Turn on the printer, wait a moment, then try again.",
  "80210006": "The scanner is busy. Wait until it is free, then try again.",
  "80210007": "The scanner is warming up. Wait a moment, then try again.",
  "80210003": "There is no paper in the document feeder. Put the page on the scanner glass or in the feeder, then try again.",
  "80210002": "The paper is stuck in the scanner. Take it out, then try again.",
  "80210016": "The scanner lid is open. Close it, then try again.",
  "8021000A": "The computer could not reach the scanner. Check the USB cable or the Wi-Fi, then try again.",
  "8021000D": "The scanner is locked. Check the lock switch of the scanner, then try again.",
  "80070021": "Another program is using the scanner (for example HP Smart or HP Scan). Close it, then try again.",
  TIMEOUT: "The scan took too long. Check the scanner, then try again.",
  STOPPED: "The scanner stopped before the page was saved. Check the scanner, then try again.",
  NO_START: "The scan could not start on this computer (Windows PowerShell did not open). Restart the computer, then try again.",
};
// the scanner window cannot help when there is no scanner, or the scanner is held by another program
const NO_WINDOW_HELP = new Set(["NO_SCANNER", "80210015", "80070021", "80210006", "80210007", "NO_START"]);
function scanResult(out) {
  if (out === "OK") return { ok: true };
  const code = (out.match(/^ERROR:([0-9A-F]{8}|[A-Z_]+)/) || [])[1] || "";
  if (code === "80210064" || code === "80210065") return { cancelled: true }; // the scan was cancelled
  return { error: SCAN_ERRORS[code] || `The scan did not work${code ? ` (code ${code})` : ""}. Try the scanner window, or choose your scanner in Scanner › Choose Scanner.`,
    code, offerDialog: !NO_WINDOW_HELP.has(code) };
}

// How far the scan is, for the circle on the E-Portal page. A scanner does not say how much of the page is done, so
// the part while the scanner reads the page follows the time this scanner needed last time (kept per quality).
const STAGE_TEXT = { START: "Starting the scanner", CONNECT: "Connecting to the scanner", SCAN: "Scanning the page",
  WAIT: "The scanner is warming up", WINDOW: "Use the scanner window", DIALOG: "Answer the scanner's window", CONVERT: "Preparing the page",
  SAVE: "Saving the page", DONE: "Scanned" };
function scanPercent(stage, ms, expected) {
  const ease = (t, tau) => 1 - Math.exp(-t / tau);
  switch (stage) {
    case "START": return 1 + 5 * ease(ms, 1500);
    case "CONNECT": return 7 + 7 * ease(ms, 2500);
    case "WAIT": return 15;
    case "SCAN": return 15 + 72 * ease(ms, expected / 2.2);
    case "CONVERT": return 88 + 3 * ease(ms, 1500);
    case "SAVE": return 92 + 3 * ease(ms, 1000);
    case "DONE": return 96;
    default: return null; // the scanner window or a window of the scanner is open: no number
  }
}

let scan = null; // the scan (or the scanner choice) that is running: { cancel }
ipcMain.handle("eo-scan", async (e, opts) => {
  if (!inApp(e.senderFrame ? e.senderFrame.url : "")) return { error: "Scanning is only for the E-Portal." };
  if (process.platform !== "win32") return { error: "Scanning works in the E-Portal app for Windows." };
  if (scan) return { error: "A scan is already running. Wait for it to finish, or press Cancel on it.", code: "RUNNING", offerDialog: false };
  const dialogMode = !!(opts && opts.dialog);
  const s = scanSettings();
  const key = `${s.dpi}-${s.intent}`;
  const expected = Math.min(120000, Math.max(5000, (s.times || {})[key] || (s.dpi >= 300 ? 40000 : s.intent === 2 ? 18000 : 25000)));
  const stampOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}_${String(d.getHours()).padStart(2, "0")}-${String(d.getMinutes()).padStart(2, "0")}-${String(d.getSeconds()).padStart(2, "0")}`;
  const name = `Scan_${stampOf(new Date())}.jpg`;
  const file = path.join(os.tmpdir(), `EO-${process.pid}-${Date.now()}.jpg`);
  let stage = "START", since = Date.now(), before = null, scanFrom = 0, scanMs = 0, dialogSeen = false;
  const send = () => {
    if (e.sender.isDestroyed()) return;
    const pct = scanPercent(stage, Date.now() - since, expected);
    e.sender.send("eo-scan-progress", { stage, text: STAGE_TEXT[stage] || "", pct: pct === null ? null : Math.round(pct) });
  };
  const ticker = setInterval(send, 250);
  const run = powershell({ EO_MODE: dialogMode ? "dialog" : "scan", EO_OUT: file, EO_DPI: String(s.dpi), EO_INTENT: String(s.intent), EO_DEVICE: s.deviceId || "" }, {
    timeout: dialogMode ? 15 * 60000 : 180000,
    onStage: (line) => {
      const st = line.split(":")[0];
      if (st === "SOURCE") return;
      if (st === "DIALOG") { dialogSeen = true; before = { stage, since }; stage = "DIALOG"; since = Date.now(); return send(); }
      if (st === "DIALOG_CLOSED") { if (before && stage === "DIALOG") ({ stage, since } = before); before = null; return send(); }
      if (st === "SCAN") scanFrom = Date.now();
      else if (scanFrom && !scanMs && st !== "WAIT") scanMs = Date.now() - scanFrom;
      if (st === "WAIT") scanFrom = 0;
      stage = st; since = Date.now(); before = null; send();
    },
  });
  // the page closed or reloaded: the scan stops
  const stop = () => run.cancel();
  e.sender.once("destroyed", stop);
  scan = { cancel: run.cancel };
  send();
  try {
    const r = scanResult(await run.out);
    if (!r.ok) return r;
    if (scanFrom && !scanMs) scanMs = Date.now() - scanFrom;
    // the time this scan needed, so the circle follows this scanner next time
    if (scanMs && !dialogMode && !dialogSeen) {
      const times = { ...(scanSettings().times || {}) };
      times[key] = Math.round(times[key] ? times[key] * 0.5 + scanMs * 0.5 : scanMs);
      saveScanSettings({ times });
    }
    const data = await fs.promises.readFile(file);
    if (!data.length) return { error: SCAN_ERRORS.STOPPED, code: "STOPPED", offerDialog: true };
    stage = "DONE"; since = Date.now(); send();
    return { ok: true, name, type: "image/jpeg", data: data.toString("base64") };
  } catch (err) {
    return { error: "The scan did not work: " + err.message, offerDialog: true };
  } finally {
    clearInterval(ticker);
    if (!e.sender.isDestroyed()) e.sender.removeListener("destroyed", stop);
    scan = null;
    fs.promises.unlink(file).catch(() => {});
  }
});
// Cancel on the E-Portal page: PowerShell is closed and the scan answers "cancelled".
ipcMain.handle("eo-scan-cancel", (e) => {
  if (!inApp(e.senderFrame ? e.senderFrame.url : "")) return false;
  if (!scan) return false;
  scan.cancel();
  return true;
});
app.on("before-quit", () => { if (scan) scan.cancel(); });
async function chooseScanner() {
  if (process.platform !== "win32") return;
  if (scan) return dialog.showMessageBox(current(), { type: "info", title: "Scanner", icon: ICON, message: "A scan is running. Choose the scanner when it has finished." });
  const run = powershell({ EO_MODE: "select" }, { timeout: 5 * 60000 });
  scan = { cancel: run.cancel };
  let out;
  try { out = await run.out; } finally { scan = null; }
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
      { type: "separator" },
      // what the scans did, to send when a scan has a problem
      { label: "Open Scan Log", click: () => { logScan("log opened"); shell.openPath(scanLog()).catch(() => {}); } },
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
