// EMON OVERRUNS E-Portal for Windows: what the E-Portal page may ask of the app. Only scanning; the app itself checks
// that the request comes from the E-Portal.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("EOApp", {
  windows: true,
  // Scan one page with the scanner of this computer (an HP printer and others, through Windows). dialog: true opens
  // the scanner window, where the scanner, colour and size can be chosen. onProgress (1.5) gets { stage, text, pct }
  // while it runs (pct is null while the scanner window is open). Gives back { ok, name, type, data (base64) },
  // { cancelled: true } or { error }.
  scan: (opts, onProgress) => {
    const listen = (_e, p) => { if (typeof onProgress === "function") { try { onProgress(p); } catch {} } };
    ipcRenderer.on("eo-scan-progress", listen);
    return ipcRenderer.invoke("eo-scan", { dialog: !!(opts && opts.dialog) })
      .finally(() => ipcRenderer.removeListener("eo-scan-progress", listen));
  },
  // Stops the scan that is running (1.5).
  cancelScan: () => ipcRenderer.invoke("eo-scan-cancel"),
});
