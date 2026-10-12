// Automatic update of the Windows app (1.6.0).
// Each new version is published by GitHub Actions as a release of the EMON-OVERRUNS repository, with the Setup program
// and windows-update.json ({ version, file, url, size, sha256 }). The app reads that file at start and every 4 hours;
// when a newer version is there, it downloads the Setup program in the background, checks its size and SHA-256, and
// then asks "Restart now" or "Later". Later installs it when the app is closed. The Setup runs silently (/S) and
// opens the app again (/RELAUNCH).
const { app, dialog, net } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const REPO = "https://github.com/EmonOverrunsinc/EMON-OVERRUNS/releases";
const MANIFEST = `${REPO}/latest/download/windows-update.json`;
const EVERY = 4 * 60 * 60 * 1000;

let ready = null;     // { version, file } of a checked Setup program waiting to be installed
let busy = false;
let asked = "";       // the version already offered in this run (asked once; Later = install on close)
let opts = { window: () => null, icon: undefined, log: () => {} };

const newer = (a, b) => {
  const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
  return false;
};
const folder = () => path.join(app.getPath("userData"), "updates");

async function sha256(file) {
  const h = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(file), h);
  return h.digest("hex");
}

async function readManifest() {
  const res = await net.fetch(`${MANIFEST}?t=${Date.now()}`, { cache: "no-store" });
  if (res.status === 404) return null; // no Windows release yet
  if (!res.ok) throw new Error(`update list: HTTP ${res.status}`);
  const m = await res.json();
  if (!/^\d+\.\d+\.\d+$/.test(m.version || "")) throw new Error("update list: no version");
  if (!/^EMON-OVERRUNS-E-Portal-Setup-\d+\.\d+\.\d+\.exe$/.test(m.file || "")) throw new Error("update list: bad file name");
  // the Setup program comes only from this repository's releases
  if (m.url !== `${REPO}/download/windows-v${m.version}/${m.file}`) throw new Error("update list: bad address");
  if (!/^[0-9a-f]{64}$/.test(m.sha256 || "") || !(m.size > 1e6)) throw new Error("update list: no check sum");
  return m;
}

async function download(m) {
  fs.mkdirSync(folder(), { recursive: true });
  const file = path.join(folder(), m.file);
  if (fs.existsSync(file) && fs.statSync(file).size === m.size && (await sha256(file)) === m.sha256) return file;
  // old downloads go
  for (const f of fs.readdirSync(folder())) fs.rmSync(path.join(folder(), f), { force: true });
  const part = file + ".part";
  const res = await net.fetch(m.url, { cache: "no-store" });
  if (!res.ok || !res.body) throw new Error(`download: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(part));
  const size = fs.statSync(part).size, sum = await sha256(part);
  if (size !== m.size || sum !== m.sha256) { fs.rmSync(part, { force: true }); throw new Error("download: the check sum does not match"); }
  fs.renameSync(part, file);
  return file;
}

// Starts the silent Setup, which waits for the app to close, installs and opens the app again.
function install(relaunch) {
  if (!ready || process.platform !== "win32") return false;
  const args = ["/S"];
  if (relaunch) args.push("/RELAUNCH");
  try {
    spawn(ready.file, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
    opts.log(`update: installing ${ready.version}`);
    ready = null;
    return true;
  } catch (err) {
    opts.log(`update: could not start the Setup: ${err.message}`);
    return false;
  }
}

async function offer() {
  if (!ready || asked === ready.version) return;
  asked = ready.version;
  const w = opts.window();
  const box = {
    type: "info", title: "Update", icon: opts.icon, buttons: ["Restart now", "Later"], defaultId: 0, cancelId: 1,
    message: `A new version of the E-Portal is ready: ${ready.version}`,
    detail: `You have version ${app.getVersion()}.\n\nRestart now to update (about 30 seconds), or choose Later: the update is installed when you close the E-Portal.`,
  };
  const r = w ? await dialog.showMessageBox(w, box) : await dialog.showMessageBox(box);
  if (r.response === 0 && install(true)) app.quit();
}

async function check(byHand) {
  if (busy) { if (byHand) note("The E-Portal is already checking for a new version."); return; }
  busy = true;
  try {
    const m = await readManifest();
    if (!m || !newer(m.version, app.getVersion())) {
      if (byHand) note(`The E-Portal is up to date (version ${app.getVersion()}).`);
      return;
    }
    if (!ready || ready.version !== m.version) {
      opts.log(`update: downloading ${m.version}`);
      ready = { version: m.version, file: await download(m) };
      opts.log(`update: ${m.version} ready`);
    }
    if (byHand) asked = "";
    await offer();
  } catch (err) {
    opts.log(`update: ${err.message}`);
    if (byHand) note("The check for a new version did not work. Please check the internet and try again.", err.message);
  } finally {
    busy = false;
  }
}

function note(message, detail) {
  const w = opts.window();
  const box = { type: "info", title: "Update", icon: opts.icon, message, detail };
  return w ? dialog.showMessageBox(w, box) : dialog.showMessageBox(box);
}

function start(o) {
  opts = { ...opts, ...o };
  if (!app.isPackaged || process.platform !== "win32") return;
  setTimeout(() => check(false), 15000);
  setInterval(() => check(false), EVERY);
  // "Later": the update is installed when the E-Portal is closed (it opens again only when asked)
  app.on("will-quit", () => { if (ready) install(false); });
}

module.exports = { start, check: () => check(true), newer };
