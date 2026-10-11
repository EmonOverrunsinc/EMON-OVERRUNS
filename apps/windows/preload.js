// EMON OVERRUNS E-Portal for Windows: what the E-Portal page may ask of the app. Only scanning; the app itself checks
// that the request comes from the E-Portal.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("EOApp", {
  windows: true,
  // Scan one page with the scanner of this computer (an HP printer and others, through Windows). dialog: true opens
  // the scanner window, where the scanner, colour and size can be chosen. Gives back { ok, name, type, data (base64) },
  // { cancelled: true } or { error }.
  scan: (opts) => ipcRenderer.invoke("eo-scan", { dialog: !!(opts && opts.dialog) }),
});
