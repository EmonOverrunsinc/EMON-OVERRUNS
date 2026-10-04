// Minimal service worker so Windows/Android can install the portal as an app.
// It does not cache anything: every page and record always comes fresh from the server.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
