// EMON OVERRUNS E-Portal for Windows: the live E-Portal in its own window.
// Records, prints and uploads all come from the live site, so the app does not need an update when the
// E-Portal changes. This file only makes the window, the menu and the rules for links, files and the camera.
const { app, BrowserWindow, Menu, shell, dialog, session, clipboard, screen } = require("electron");
const path = require("path");
const fs = require("fs");

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
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
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
