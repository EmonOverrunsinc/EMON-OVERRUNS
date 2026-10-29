/* EMON OVERRUNS E-PORTAL — single-page app on Supabase (version 1.1).
   Core: shared helpers, barcodes, sign-in (email or username, email codes), top bar, animated slide menu, router.
   Business screens live in modules.js to modules4.js and register themselves in window.EO_VIEWS. */
(function () {
  "use strict";

  const C = window.EMON_CONFIG;
  const APP = "EMON OVERRUNS E-PORTAL";
  const VERSION = "3.46";
  // 2.9: in the Windows app 1.8 the window buttons sit in the top bar (no Windows title bar): leave room and let the bar move the window
  if (window.EOApp && window.EOApp.overlay) document.documentElement.classList.add("eo-overlay");
  const BUILD = "3.46.0"; // the same in index.html (?v=) and in version.json
  window.EO = window.EO || {};
  // 3.36: a save sent twice in a moment (a button pressed twice, Enter and a click together) reaches the server once:
  // the same request (address and content) sent again while the first is on its way gets the answer of the first; a
  // record saved straight to a table also up to 1.5 seconds after it was saved (a server function is asked again once
  // it has answered: it may only read, like Check & Verify). Reading (GET) and file uploads always go to the server.
  const sent = new Map();
  function sendOnce(input, init = {}) {
    const method = String(init.method || "GET").toUpperCase();
    if (method === "GET" || method === "HEAD" || typeof init.body !== "string") return fetch(input, init);
    const url = String(input?.url || input), key = `${method} ${url} ${init.body}`;
    let answer = sent.get(key);
    if (!answer) {
      answer = fetch(input, init);
      sent.set(key, answer);
      const hold = url.includes("/rest/v1/rpc/") ? 0 : 1500;
      answer.then((r) => setTimeout(() => sent.delete(key), r.ok ? hold : 0), () => sent.delete(key));
    }
    return answer.then((r) => r.clone());
  }
  const sb = window.supabase.createClient(C.supabaseUrl, C.supabaseKey, { global: { fetch: sendOnce } });
  const app = document.getElementById("app");
  const S = { session: null, profile: null, lastResult: [] };

  // ---------- helpers ----------
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const peso = (n) => Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pad = (n) => String(n).padStart(2, "0");
  // 2.9: small helpers shared by every section (they were written again in each file)
  const num = (v) => Number(v || 0);
  const fullName = (r) => `${(r && r.first_name) || ""} ${(r && r.last_name) || ""}`.trim();
  const qtyText = (n) => Number(n || 0).toLocaleString("en-PH", { maximumFractionDigits: 2 });
  const bdt = (n) => `BDT ${peso(n)}`;
  const verifyUrl = (code) => `${location.origin}${location.pathname}#verify/${encodeURIComponent(code)}`;
  const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const isoToday = () => isoDay(new Date());
  // Every date shows as MONTH DD YYYY in capitals (AUGUST 01 2026, OCTOBER 09 2026); with the time: OCTOBER 09 2026
  // 3:15 PM. The parts are joined with no-break spaces, so a date is never split over two lines.
  // A saved time (2026-10-05T17:30:00+00:00) shows the day it was where the user is, not the server's UTC day.
  const MON = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
  const mdy = (iso) => {
    if (!iso) return "";
    let s = String(iso);
    if (/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d/.test(s)) { const t = new Date(s.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00")); if (!isNaN(t)) s = isoDay(t); }
    const [y, m, d] = s.slice(0, 10).split("-");
    return MON[Number(m) - 1] && d ? `${MON[Number(m) - 1]}\u00a0${d}\u00a0${y}` : s;
  };
  // 3.36: a month as OCTOBER 2026 (from 2026-10 or any date in it), in every section
  const monthOf = (d) => String(d || "").slice(0, 7);
  const monthText = (d) => { const [y, m] = monthOf(d).split("-"); return MON[Number(m) - 1] ? `${MON[Number(m) - 1]} ${y}` : ""; };
  const stamp = (d = new Date()) => `${mdy(isoDay(d))} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const dateTime = (iso) => { if (!iso) return ""; const d = new Date(iso), h = d.getHours(); return `${mdy(isoDay(d))} ${h % 12 || 12}:${pad(d.getMinutes())} ${h < 12 ? "AM" : "PM"}`; };
  // Dates the database writes as "20 Jun 2026" (record verification) show as JUNE 20 2026 too.
  const fixDates = (v) => String(v ?? "").replace(/\b(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4})\b/g,
    (_, d, m, y) => `${MON.find((x) => x.startsWith(m.toUpperCase()))}\u00a0${pad(d)}\u00a0${y}`);
  // The website (config.js): its name for printed headers, and a link for the screens anyone can see.
  const siteName = () => String(C.company.website || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const siteText = () => (siteName() ? ` · ${esc(siteName())}` : "");
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const isAdmin = () => S.profile?.role === "admin";
  const isStaff = () => ["admin", "staff"].includes(S.profile?.role);
  const meId = () => S.session?.user?.id;
  // a "label | value" table; a row [label, value, html] shows html as it is instead of the value; an empty value shows —
  const kvTable = (rows) => `<div class="grid-wrap"><table class="grid kv-table"><tbody>${rows.map(([k, v, html]) => `<tr><th scope="row">${esc(k)}</th><td>${html || esc(v || "—")}</td></tr>`).join("")}</tbody></table></div>`;
  // 2.4: the Terms of Payment of an invoice, and its due date (none for other terms)
  const TERMS = ["CASH ON DELIVERY", "7 DAYS", "15 DAYS", "30 DAYS", "45 DAYS", "60 DAYS", "90 DAYS"];
  const termsDue = (iso, terms) => {
    if (!iso || !terms) return "";
    if (terms === "CASH ON DELIVERY") return iso;
    const m = /^(\d{1,3}) DAYS$/.exec(terms);
    if (!m) return "";
    const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() + Number(m[1])); return isoDay(d);
  };
  // 2.4: an invoice that is partly paid shows PARTIAL PAYMENT
  const PILL_LABEL = { partial: "PARTIAL PAYMENT" };
  const pill = (s, label) => `<span class="pill ${esc(s)}">${esc(label || PILL_LABEL[s] || String(s || "").replace(/_/g, " ").toUpperCase())}</span>`;
  // The steps of an e-bill: 1 SHIP, 2 RELEASED, 3 SALES, 4 PAID (saved as shipped, released, sold, paid; an e-bill
  // marked "arrived" before Update 2.0 is still at SHIP).
  const EBILL_STEP = { shipped: "SHIP", arrived: "SHIP", released: "RELEASED", sold: "SALES", paid: "PAID" };
  const ebillStep = (s) => EBILL_STEP[s] || String(s || "").toUpperCase();
  const ebillPill = (s) => pill(s, ebillStep(s));
  // The top role is called Director in the portal (stored as "admin"); everyone else is shown with their job position.
  const roleName = (r) => ({ admin: "Director", staff: "Employee", viewer: "Viewer" })[r] || r || "";
  const personTitle = (role, position) => role === "admin" ? "Director" : position || roleName(role);
  // Seen in the last 3 minutes = active now.
  const online = (ts) => !!ts && Date.now() - new Date(ts).getTime() < 3 * 60 * 1000;
  function timeAgo(iso) {
    if (!iso) return "";
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)} day${s < 2 * 86400 ? "" : "s"} ago`;
    return mdy(iso);
  }
  const busy = (text = "Loading") => `<div class="loading" role="status"><span class="spin"></span><span>${esc(text)}<span class="dots"></span></span></div>`;

  // Line icons (stroke drawn with the text colour).
  const ICONS = {
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
    scan: '<path d="M3 8V4h4M17 4h4v4M21 16v4h-4M7 20H3v-4"/><path d="M7 12h10"/>',
    qr: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z"/><path d="M14 14h2v2h-2zM18 14h2M14 18h2M18 18h2v2"/>',
    bell: '<path d="M6 16v-5a6 6 0 1 1 12 0v5l1.6 2H4.4z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
    chat: '<path d="M20.5 12a8.5 8.5 0 0 1-12.3 7.6L3.5 21l1.4-4.5A8.5 8.5 0 1 1 20.5 12z"/>',
    shield: '<path d="M12 3 4.5 6v6c0 4.6 3.2 7.8 7.5 9 4.3-1.2 7.5-4.4 7.5-9V6z"/><path d="m8.8 12 2.2 2.2 4.4-4.4"/>',
    idcard: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2.2"/><path d="M5.6 16.4c.6-1.6 1.9-2.5 3.4-2.5s2.8.9 3.4 2.5M14.5 10h4M14.5 13.5h3"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.4"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
    clip: '<path d="M20.5 11.5 12.4 19.6a5 5 0 0 1-7-7l8.5-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.5 8.6a1.8 1.8 0 0 1-2.6-2.6L15.5 7"/>',
    send: '<path d="M21 3 10 14M21 3l-6.5 18-4.5-7-7-4.5z"/>',
    doc: '<path d="M14 3H6.5a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V7.5z"/><path d="M14 3v4.5h4.5M9 13h6M9 16.5h6"/>',
    print: '<path d="M7 9V3.5h10V9M7 17.5H5a1.5 1.5 0 0 1-1.5-1.5v-5A1.5 1.5 0 0 1 5 9.5h14a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5h-2"/><path d="M7 14h10v6.5H7z"/>',
    upload: '<path d="M12 15.5V4m0 0L7.5 8.5M12 4l4.5 4.5M4 16v4h16v-4"/>',
    download: '<path d="M12 4v11.5m0 0L7.5 11M12 15.5l4.5-4.5M4 16v4h16v-4"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
    edit: '<path d="M4 20h4.2L19.4 8.8a2 2 0 0 0 0-2.8l-1.4-1.4a2 2 0 0 0-2.8 0L4 15.8z"/><path d="m13.5 6.5 4 4"/>',
    trash: '<path d="M4 7h16M9.5 7V4h5v3M6 7l1 13.5h10L18 7"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    back: '<path d="M15 5.5 8.5 12l6.5 6.5"/>',
    next: '<path d="m9 5.5 6.5 6.5L9 18.5"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    out: '<path d="M14.5 4H19v16h-4.5M10 8l-4 4 4 4M6 12h10"/>',
    key: '<circle cx="8" cy="15" r="4.2"/><path d="m11 12 9-9M16.5 6.5 19 9"/>',
    copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5V5a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v9A1.5 1.5 0 0 0 5 15.5h3.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 7 8.5-7"/>',
    home: '<path d="M3.5 11 12 4l8.5 7"/><path d="M6 9.5V20h12V9.5"/>',
    install: '<path d="M12 4v10m0 0-4-4m4 4 4-4"/><rect x="4" y="16" width="16" height="4" rx="1"/>',
    box: '<path d="M21 7.5 12 3 3 7.5v9L12 21l9-4.5z"/><path d="m3 7.5 9 4.5 9-4.5M12 12v9M7.5 5.2l9 4.6"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>',
    wallet: '<rect x="3" y="6" width="18" height="14" rx="2.5"/><path d="M3 10h18M16 15h2"/><path d="M6 6V5a2 2 0 0 1 2-2h9"/>',
    receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
    order: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 10h6M9 14h6M9 18h4"/>',
    tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    building: '<rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M10 21v-3h4v3"/>',
    stamp: '<path d="M9 3h6l-1 7h-4z"/><path d="M5 14h14v3H5zM4 21h16"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    ai: '<circle cx="5" cy="6.5" r="2"/><circle cx="5" cy="17.5" r="2"/><circle cx="12" cy="12" r="2.2"/><circle cx="19" cy="6.5" r="2"/><circle cx="19" cy="17.5" r="2"/><path d="m6.8 7.6 3.4 3.2M6.8 16.4l3.4-3.2M13.8 10.8l3.4-3.2M13.8 13.2l3.4 3.2"/>'
  };
  const ic = (name, cls = "") => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ""}</svg>`;

  // A new message takes the place of the one before, except that an error stays for its time when a message that is
  // not an error comes after it (so "saved" can never hide that something failed); the newer message shows below it.
  // A new error takes the place of every message before it.
  let lastError = 0; // when the last error message showed
  function toast(msg, err) {
    if (err) lastError = Date.now();
    $$(".toast").forEach((t) => { if (err || !t.classList.contains("err")) t.remove(); });
    const t = document.createElement("div");
    t.className = "toast" + (err ? " err" : "");
    t.setAttribute("role", err ? "alert" : "status");
    t.textContent = msg;
    document.body.insertBefore(t, $(".toast")); // the newest first (and lowest on the screen)
    stackToasts();
    setTimeout(() => { t.classList.add("out"); setTimeout(() => { t.remove(); stackToasts(); }, 300); }, err ? 7000 : 3500);
  }
  function stackToasts() {
    let y = 16;
    $$(".toast").forEach((t) => { t.style.bottom = `calc(${y}px + env(safe-area-inset-bottom, 0px))`; y += t.offsetHeight + 8; });
  }
  // 3.29.1: a server that does not answer in time (HTTP 502 / 503 / 504; for sign-up and code emails: the email server)
  // gives no message of its own
  const timedOut = (error) => [502, 503, 504].includes(error?.status);
  function fail(error, what) {
    console.error(error);
    toast(`${what}: ${timedOut(error) ? `the server did not answer in time (HTTP ${error.status}). Please try again in a few minutes.` : error?.message || error}`, true);
  }

  // A dialog window over the page. Returns { el, close }.
  const modalClose = new WeakMap(); // 3.35: a dialog taken away with its page (sign-in) is closed properly (camera off, listener gone)
  function modal(title, body, foot = "", { wide = false, onClose, cls = "" } = {}) {
    const d = document.createElement("div");
    d.className = "modal " + cls;
    d.innerHTML = `<div class="window${wide ? " wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="wtitle"><span>${esc(title)}</span><button type="button" class="wclose" aria-label="Close">${ic("x")}</button></div>
      <div class="wbody">${body}</div>${foot ? `<div class="wfoot">${foot}</div>` : ""}</div>`;
    document.body.appendChild(d);
    let closed = false;
    const onKey = (e) => { if (e.key === "Escape" && d === $$(".modal").pop()) close(); };
    function close() {
      if (closed) return; closed = true;
      document.removeEventListener("keydown", onKey);
      d.classList.add("out");
      setTimeout(() => d.remove(), 180);
      if (onClose) onClose();
    }
    document.addEventListener("keydown", onKey);
    $(".wclose", d).onclick = close;
    d.addEventListener("mousedown", (e) => { if (e.target === d) close(); });
    modalClose.set(d, close);
    return { el: d, close };
  }
  function confirmBox(message, { title = "Please confirm", ok = "OK", danger = false } = {}) {
    return new Promise((resolve) => {
      let answered = false;
      const m = modal(title, `<p class="confirm-msg">${message}</p>`,
        `<button type="button" class="btn" data-no>Cancel</button><button type="button" class="btn primary${danger ? " danger-fill" : ""}" data-yes>${esc(ok)}</button>`,
        { onClose: () => { if (!answered) resolve(false); } });
      $("[data-no]", m.el).onclick = () => m.close();
      $("[data-yes]", m.el).onclick = () => { answered = true; resolve(true); m.close(); };
      $("[data-yes]", m.el).focus();
    });
  }

  // Amount in words, voucher style: "PESOS ONE THOUSAND TWO HUNDRED AND 50/100 ONLY" (unit "TAKA" for BDT).
  function words(amount, unit = "PESOS") {
    const ones = ["", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE", "TEN", "ELEVEN", "TWELVE", "THIRTEEN", "FOURTEEN", "FIFTEEN", "SIXTEEN", "SEVENTEEN", "EIGHTEEN", "NINETEEN"];
    const tens = ["", "", "TWENTY", "THIRTY", "FORTY", "FIFTY", "SIXTY", "SEVENTY", "EIGHTY", "NINETY"];
    const under1000 = (n) => {
      const out = [];
      if (n >= 100) { out.push(ones[Math.floor(n / 100)], "HUNDRED"); n %= 100; }
      if (n >= 20) { out.push(tens[Math.floor(n / 10)] + (n % 10 ? "-" + ones[n % 10] : "")); }
      else if (n > 0) out.push(ones[n]);
      return out.join(" ");
    };
    const total = Math.round(Math.abs(Number(amount || 0)) * 100);
    let whole = Math.floor(total / 100);
    const cents = total % 100;
    if (whole === 0) return `${unit} ZERO${cents ? ` AND ${pad(cents)}/100` : ""} ONLY`;
    const scales = ["", "THOUSAND", "MILLION", "BILLION"];
    const parts = [];
    for (let i = 0; whole > 0; i++, whole = Math.floor(whole / 1000)) {
      const chunk = whole % 1000;
      if (chunk) parts.unshift(under1000(chunk) + (scales[i] ? " " + scales[i] : ""));
    }
    return `${unit} ${parts.join(" ")}${cents ? ` AND ${pad(cents)}/100` : ""} ONLY`;
  }

  // ---------- libraries loaded when needed (2.5) ----------
  // The barcode maker (bwip-js, 1.1 MB) loads once the first page is up and the browser is idle (3.35: no longer with
  // the page, so the first page comes sooner); a print or a barcode wanted before then waits for it. The code reader
  // (ZXing) loads the first time something is scanned or read from a photo without the phone's own barcode reader.
  const LIBS = { bwip: ["vendor/bwip-js-min.js", "bwipjs"], zxing: ["vendor/zxing.min.js", "ZXing"] };
  const libs = {};
  function need(name) {
    const [src, global] = LIBS[name];
    if (window[global]) return Promise.resolve(window[global]);
    return (libs[name] ||= new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src; s.async = true;
      s.onload = () => (window[global] ? resolve(window[global]) : reject(new Error(`Could not start ${src}.`)));
      s.onerror = () => { delete libs[name]; s.remove(); reject(new Error("Could not load a part of the portal. Check the internet connection and try again.")); };
      document.head.appendChild(s);
    }));
  }
  const whenIdle = (f) => (window.requestIdleCallback ? requestIdleCallback(f, { timeout: 4000 }) : setTimeout(f, 1500));
  addEventListener("load", () => whenIdle(() => need("bwip").catch(() => {})), { once: true });

  // ---------- Enter goes to the next box (2.6.2) ----------
  // On a computer, Enter in a box of a form moves to the next box, like a spreadsheet, instead of saving the form;
  // in the last box it saves as before. Boxes with their own Enter (the E-Bill table, search, chat) keep it.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.defaultPrevented || e.shiftKey || e.ctrlKey || e.altKey || e.isComposing) return;
    const t = e.target;
    if (!t.matches || !t.matches("input:not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]):not([type=file]), select")) return;
    const form = t.closest("#main form");
    if (!form) return;
    const boxes = $$("input, select, textarea, button[type=submit]", form)
      .filter((x) => !x.disabled && !x.readOnly && x.type !== "hidden" && x.type !== "file" && x.offsetParent !== null);
    const next = boxes[boxes.indexOf(t) + 1];
    if (!next || next.type === "submit") return;
    e.preventDefault();
    next.focus();
    if (next.tagName === "INPUT" && next.select) try { next.select(); } catch (_) {}
  });

  // ---------- PDF417 and QR ----------
  // Before the barcode maker has loaded, a canvas is drawn as soon as it is there, and a picture address is a mark
  // ("bc:pdf417:…" or "bc:qrcode:…") that the print preview turns into the barcode (fillCodes).
  const codeMark = (kind, text) => { need("bwip").catch(() => {}); return `bc:${kind}:${encodeURIComponent(text)}`; };
  function drawPdf417(canvas, text) {
    if (!window.bwipjs) { need("bwip").then(() => drawPdf417(canvas, text), () => {}); return true; }
    try {
      window.bwipjs.toCanvas(canvas, { bcid: "pdf417", text, scale: 2, height: 10, columns: 6, padding: 4, backgroundcolor: "FFFFFF" });
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  }
  function pdf417DataUrl(text) {
    if (!window.bwipjs) return codeMark("pdf417", text);
    const c = document.createElement("canvas");
    return drawPdf417(c, text) ? c.toDataURL("image/png") : "";
  }
  // 3.41: every code a box label or a paper can carry: QR, PDF417, Data Matrix, Aztec and the line barcodes (Code 128 …)
  const ZX_FORMATS = ["QR_CODE", "PDF_417", "DATA_MATRIX", "AZTEC", "CODE_128", "CODE_39", "CODE_93", "EAN_13", "EAN_8", "UPC_A", "UPC_E", "ITF", "CODABAR"];
  const zxFormats = (Z) => ZX_FORMATS.map((f) => Z.BarcodeFormat[f]).filter((f) => f !== undefined);
  function decodeCanvas(canvas) { // needs the code reader loaded first: await need("zxing")
    const Z = window.ZXing;
    const hints = new Map([[Z.DecodeHintType.TRY_HARDER, true], [Z.DecodeHintType.POSSIBLE_FORMATS, zxFormats(Z)]]);
    const bmp = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas)));
    const r = new Z.MultiFormatReader(); r.setHints(hints);
    return r.decode(bmp).getText();
  }
  function drawQr(canvas, text) {
    if (!window.bwipjs) { need("bwip").then(() => drawQr(canvas, text), () => {}); return true; }
    try { window.bwipjs.toCanvas(canvas, { bcid: "qrcode", text, scale: 4, padding: 2, backgroundcolor: "FFFFFF" }); return true; }
    catch (e) { console.error(e); return false; }
  }
  function qrDataUrl(text) {
    if (!window.bwipjs) return codeMark("qrcode", text);
    const c = document.createElement("canvas"); return drawQr(c, text) ? c.toDataURL("image/png") : "";
  }
  const fillCodes = (html) => html.replace(/bc:(pdf417|qrcode):([^"'\s<>]*)/g, (_, kind, t) => (kind === "pdf417" ? pdf417DataUrl : qrDataUrl)(decodeURIComponent(t)));
  // 2.1: the QR of the website for the foot of every printed page, made once. Error correction Q (a smudge or a fold
  // still scans) keeps it at 29 × 29 modules, so it stays small on paper.
  let webQrUrl = "";
  function websiteQr() {
    if (webQrUrl || !C.company.website || !window.bwipjs) return webQrUrl;
    const c = document.createElement("canvas");
    try { window.bwipjs.toCanvas(c, { bcid: "qrcode", text: C.company.website, eclevel: "Q", scale: 6, padding: 2, backgroundcolor: "FFFFFF" }); webQrUrl = c.toDataURL("image/png"); }
    catch (e) { console.error(e); }
    return webQrUrl;
  }
  // 3.35: the phone's own barcode reader (Chrome on Android and on a Mac) reads a QR code or a PDF417 at once, also a
  // small or dense one; without it (Windows, iPhone) ZXing reads the code. null: there is none.
  let nativeFormats = null;
  async function nativeReader() {
    if (!nativeFormats) {
      const want = ["qr_code", "pdf417", "data_matrix", "aztec", "code_128", "code_39", "code_93", "ean_13", "ean_8", "upc_a", "upc_e", "itf", "codabar"];
      try { nativeFormats = "BarcodeDetector" in window ? (await window.BarcodeDetector.getSupportedFormats()).filter((f) => want.includes(f)) : []; }
      catch (_) { nativeFormats = []; }
    }
    // the phone's reader is used when it reads QR codes and PDF417 (3.41: and every other code it knows too)
    return nativeFormats.includes("qr_code") && nativeFormats.includes("pdf417") ? new window.BarcodeDetector({ formats: nativeFormats }) : null;
  }
  // Try the image as-is and rotated, with a white quiet zone around it.
  async function decodeImageFile(file) {
    const det = await nativeReader();
    if (det) {
      try {
        const bmp = await createImageBitmap(file);
        try { const [code] = await det.detect(bmp); if (code?.rawValue) return code.rawValue; } finally { bmp.close?.(); }
      } catch (_) { /* ZXing tries next */ }
    }
    await need("zxing");
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("That file is not an image the browser can read.")); i.src = url; });
      const maxSide = 1800;
      const k = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.round(img.width * k), h = Math.round(img.height * k), m = 20;
      for (const rot of [0, 90, 180, 270]) {
        const c = document.createElement("canvas");
        const side = rot % 180 === 0;
        c.width = (side ? w : h) + m * 2; c.height = (side ? h : w) + m * 2;
        const g = c.getContext("2d");
        g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
        g.translate(c.width / 2, c.height / 2); g.rotate((rot * Math.PI) / 180);
        g.drawImage(img, -w / 2, -h / 2, w, h);
        try { return decodeCanvas(c); } catch (_) { /* try next orientation */ }
      }
      throw new Error("No QR code or barcode found in that image. Try a sharper photo, taken from the front.");
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // ---------- smaller uploads (2.2.2) ----------
  // Every uploaded or scanned picture is made smaller before it is saved: storage is used less and files open faster,
  // while a printed page stays clear. A document keeps about 4.2 million pixels (an A4 page at about 200 dpi, sharp on
  // paper); a person's photo about 1.2 million, a profile picture about 0.5 million. The picture is saved as JPEG on
  // white, or, for a clean PNG scan that JPEG would not make smaller, as a smaller PNG. PDFs and other files are kept as
  // they are, and so is a picture that is already small or would not get smaller.
  const SLIM = { doc: 4.2e6, photo: 1.2e6, avatar: 0.5e6 };
  // 2.9: a document picture is also made clear: the paper is made white and the ink (handwriting, stamps,
  // signatures) darker, keeping its colour. Only this clear copy is saved.
  function clearInk(g, w, h) {
    const d = g.getImageData(0, 0, w, h), px = d.data, hist = new Uint32Array(256);
    for (let i = 0; i < px.length; i += 16) hist[(px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8]++;
    let n = 0; for (const x of hist) n += x;
    const at = (q) => { let a = 0; for (let v = 0; v < 256; v++) { a += hist[v]; if (a >= n * q) return v; } return 255; };
    const lo = at(0.01), hi = Math.max(lo + 40, at(0.9));
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) { const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo))); lut[v] = Math.round(255 * Math.pow(t, 1.35)); }
    for (let i = 0; i < px.length; i += 4) { px[i] = lut[px[i]]; px[i + 1] = lut[px[i + 1]]; px[i + 2] = lut[px[i + 2]]; }
    g.putImageData(d, 0, 0);
  }
  async function slimFile(file, kind = "doc") {
    if (!file || !/^image\/(jpeg|png|webp|bmp)$/i.test(file.type || "")) return file;
    if (kind !== "doc" && file.size < 300 * 1024) return file;
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) return file;
      const k = Math.min(1, Math.sqrt((SLIM[kind] || SLIM.doc) / (w * h)));
      if (kind !== "doc" && k === 1 && /jpeg/i.test(file.type) && file.size <= 1.5 * 1048576) return file; // small enough already
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
      const g = c.getContext("2d");
      g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
      g.imageSmoothingQuality = "high";
      g.drawImage(img, 0, 0, c.width, c.height);
      if (kind === "doc") clearInk(g, c.width, c.height);
      const encode = (type, q) => new Promise((res) => c.toBlob(res, type, q));
      let best = await encode("image/jpeg", 0.82);
      // a PNG picture (a clean scan) stays a PNG when that file is smaller (3.35: also when it keeps its size)
      if (/png/i.test(file.type)) { const png = await encode("image/png"); if (png && (!best || png.size < best.size)) best = png; }
      if (!best || (kind !== "doc" && best.size >= file.size)) return file;
      const ext = best.type === "image/png" ? ".png" : ".jpg";
      return new File([best], (file.name || "Picture").replace(/\.[^.]*$/, "") + ext, { type: best.type, lastModified: Date.now() });
    } catch (_) {
      return file; // a picture the browser cannot read is saved as it is
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // ---------- company header (every page) ----------
  // Built-in company logo (an uploaded logo under Company Logo replaces the built-in one).
  const DEFAULT_LOGO = "brand/logo.jpg";
  S.logoUrl = DEFAULT_LOGO;
  const publicUrl = (bucket, path) => path ? sb.storage.from(bucket).getPublicUrl(path).data.publicUrl : "";
  async function loadBranding() {
    try {
      const { data } = await sb.from("company_settings").select("logo_path").eq("id", 1).maybeSingle();
      S.logoUrl = data?.logo_path ? publicUrl("branding", data.logo_path) : DEFAULT_LOGO;
    } catch (_) { S.logoUrl = DEFAULT_LOGO; }
    // a page drawn before the logo was known shows it now
    if (S.logoUrl !== DEFAULT_LOGO) $$(`img[src="${DEFAULT_LOGO}"]`).forEach((im) => { if (!im.closest(".boot")) im.src = S.logoUrl; });
  }
  const logoHtml = (cls = "co-logo") => S.logoUrl
    ? `<img class="${cls}" src="${esc(S.logoUrl)}" alt="${esc(C.company.name)} logo">`
    : `<span class="${cls} co-logo-fallback" aria-hidden="true">EO</span>`;

  // ---------- new versions ----------
  // version.json (never kept in the browser) names the version on the server. When it is not the version of this page,
  // a bar offers Update now, and the next page change loads the new version (nothing typed is lost that way).
  let newBuild = "";
  const reloadedFor = (v) => { try { if (v) sessionStorage.setItem("eo-build", v); return sessionStorage.getItem("eo-build"); } catch (_) { return ""; } };
  async function checkVersion() {
    try {
      const r = await fetch("version.json?t=" + Date.now(), { cache: "no-store" });
      if (!r.ok) return;
      const v = String((await r.json()).version || "");
      if (!v || v === BUILD || v === newBuild) return;
      newBuild = v;
      // 2.7: the update is offered in the profile menu (a dot on the profile button shows it is there)
      const pop = $("#userPop");
      if (pop && !$("#upUpdate")) { $(".pop-head", pop).insertAdjacentHTML("afterend", updateItem()); bindUpdate(); }
    } catch (_) { /* offline: checked again later */ }
  }
  const updateItem = () => `<button type="button" id="upUpdate" class="up-update">${ic("install")} Update to version ${esc(newBuild)}<small>A new version is ready</small></button>`;
  function bindUpdate() {
    if ($("#tbUser")) $("#tbUser").classList.toggle("has-update", !!newBuild);
    if ($("#upUpdate")) $("#upUpdate").onclick = () => { reloadedFor(newBuild); location.reload(); };
  }
  setTimeout(checkVersion, 4000);
  setInterval(checkVersion, 5 * 60 * 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) checkVersion(); });
  // the next page change loads the new version (once: if the server still sends this one, the bar stays)
  window.addEventListener("hashchange", () => { if (newBuild && reloadedFor() !== newBuild) { reloadedFor(newBuild); location.reload(); } });

  // ---------- sign in, create account, email codes ----------
  // Sign out of this device only; the same account stays signed in on the user's other phones and computers.
  const signOut = () => sb.auth.signOut({ scope: "local" });
  async function loadProfile() {
    if (!S.session) { S.profile = null; return; }
    const { data, error } = await sb.from("profiles").select("*").eq("id", S.session.user.id).maybeSingle();
    if (error) fail(error, "Could not load your profile");
    S.profile = data;
    // 2.2: the main Director (one account only) edits a customer's details; the job position shown with the user's
    // name (the Director is shown as Director). 3.0: both asked at the same time.
    const [md, pos] = await Promise.all([
      data && data.role === "admin" && data.status === "active" ? sb.rpc("is_main_director").then((r) => r.data, () => false) : false,
      data && data.role !== "admin" ? sb.from("employees").select("position").eq("profile_id", data.id).maybeSingle().then((r) => r.data?.position || "", () => "") : ""
    ]);
    S.mainDirector = md === true; S.position = pos;
  }
  const authRedirect = () => location.origin + location.pathname;
  function authFrame(title, inner) {
    closePreview();
    window.EO.closeChat?.();
    $$(".modal").forEach((x) => modalClose.get(x)?.());
    $$(".chat-panel, .eva-panel, .modal").forEach((x) => x.remove());
    window.EO.eva?.reset();
    app.innerHTML = `
      <div class="login">
        <div class="login-card window">
          <div class="wtitle">${esc(APP)} — ${esc(title)}</div>
          ${inner}
        </div>
        <div class="login-below"><a href="#contact" class="verify-link contact-link">${ic("mail")} Contact Us — send us a message</a><a href="#verify" class="verify-link">${ic("shield")} Verify a record — no sign-in needed</a><small class="legal-links"><a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a> · <a href="/delete-account" target="_blank" rel="noopener">Delete Account</a></small><small>${esc(APP)} · Version ${VERSION}</small></div>
      </div>`;
  }
  const brandBlock = () => `<div class="brand">${logoHtml("login-logo")}<div><b>${esc(C.company.name)}</b><small>E-PORTAL</small></div></div>`;
  const pwField = (id, label, auto) => `<label class="fl" for="${id}">${label}</label>
    <div class="pw"><input type="password" id="${id}" autocomplete="${auto}" minlength="6" required><button type="button" class="pw-eye" data-eye="${id}" aria-label="Show password">${ic("eye")}</button></div>`;
  function bindEyes(root = document) {
    $$("[data-eye]", root).forEach((b) => (b.onclick = () => { const i = $("#" + b.dataset.eye); i.type = i.type === "password" ? "text" : "password"; b.classList.toggle("on", i.type === "text"); }));
  }
  // Disable a form while it works and show a spinner on its main button.
  function setBusy(form, on, label) {
    $$("button", form).forEach((b) => (b.disabled = on));
    const sub = $("button[type=submit]", form);
    if (!sub) return;
    if (on) { sub.dataset.label = sub.textContent; sub.innerHTML = `<span class="spin sm light"></span> ${esc(label || "Please wait")}`; }
    else if (sub.dataset.label) sub.textContent = sub.dataset.label;
  }
  function cooldown(btn, secs) {
    if (!btn) return;
    const label = btn.dataset.label || btn.textContent;
    btn.dataset.label = label;
    let n = secs;
    btn.disabled = true;
    const tm = setInterval(tick, 1000);
    function tick() {
      if (!document.body.contains(btn)) return clearInterval(tm);
      if (n <= 0) { clearInterval(tm); btn.disabled = false; btn.textContent = label; return; }
      btn.textContent = `${label} (${n--}s)`;
    }
    tick();
  }
  // Email or username → the email the account signs in with.
  async function loginEmail(id) {
    const v = String(id || "").trim();
    if (!v) return "";
    if (v.includes("@")) return v.toLowerCase();
    const { data, error } = await sb.rpc("login_email", { p_login: v });
    if (error) { console.error(error); return ""; }
    return data || "";
  }

  function renderLogin(mode = "signin", preset = "") {
    if (mode === "signup") return renderSignup();
    authFrame("Sign In", `<form class="wbody login-form" id="lgForm" novalidate>
      ${brandBlock()}
      <div class="seg" role="tablist"><button type="button" class="on" role="tab" aria-selected="true">Sign In</button><button type="button" role="tab" id="toSignup">Create Account</button></div>
      <label class="fl" for="lgId">Email or Username</label>
      <input type="text" id="lgId" autocomplete="username" autocapitalize="none" spellcheck="false" value="${esc(preset)}" required>
      ${pwField("lgPass", "Password", "current-password")}
      <button class="btn primary big" type="submit">Sign In</button>
      <div class="login-links"><button type="button" class="linkbtn" id="toForgot">Forgot password?</button></div>
      <div class="login-or">or</div>
      <button type="button" class="btn big" id="toCard">${ic("idcard")} Sign In with ID Card</button>
    </form>`);
    bindEyes();
    if (linkError) {
      $("#lgForm .seg").insertAdjacentHTML("beforebegin", `<div class="hint err small" id="lgLinkMsg"><b>${esc(linkError)}</b><br>Sign in below — if your email is not confirmed yet, we will email you a new code. If you forgot your password, press <b>Forgot password?</b>.</div>`);
      linkError = "";
    }
    $(preset ? "#lgPass" : "#lgId").focus();
    $("#toSignup").onclick = () => renderSignup();
    $("#toForgot").onclick = () => renderForgot($("#lgId").value.trim());
    $("#toCard").onclick = () => renderCardLogin();
    $("#lgForm").onsubmit = async (e) => {
      e.preventDefault();
      const id = $("#lgId").value.trim(), password = $("#lgPass").value;
      if (!id || !password) return toast("Enter your email or username and your password.", true);
      setBusy(e.target, true, "Signing in");
      const email = await loginEmail(id);
      if (!email) { setBusy(e.target, false); return toast(`No account uses the username “${id}”. Check it, or sign in with your email.`, true); }
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (!error) return; // the auth listener opens the portal
      setBusy(e.target, false);
      if (/confirm/i.test(error.message)) {
        toast("Your email is not confirmed yet. Enter the code we emailed you.", true);
        sb.auth.resend({ type: "signup", email, options: { emailRedirectTo: authRedirect() } }).then(() => {}, () => {});
        return renderCode(email);
      }
      fail(/invalid login/i.test(error.message) ? "Wrong email/username or password." : error, "Sign-in failed");
    };
  }

  // 3.25: sign in with the employee ID card: SCAN the card (camera only: no photo upload, no typed code).
  // 3.28: then the password of the portal account linked to the employee profile and Sign In (no PIN).
  // 3.30: the first scan (no login yet) makes the password right there: no email, no code; after that scan + password.
  const CARD_CODE = /^EMONID\|EOID-\d{4}-\d{4,}\|[0-9A-F]{40}$/i;
  function renderCardLogin() {
    authFrame("Sign In with ID Card", `<form class="wbody login-form" id="clForm" novalidate>
      ${brandBlock()}
      <div class="cl-scan">
        <button type="button" class="btn big primary" id="clCam">${ic("camera")} Scan My ID Card</button>
        <div class="cl-read" id="clRead" hidden></div>
        <div id="clMsg" hidden></div>
      </div>
      <div id="clStep" hidden>
        ${pwField("clPass", "Password", "current-password")}
        <button class="btn primary big" type="submit" id="clGo">Sign In</button>
      </div>
      <div id="clNew" hidden>
        ${pwField("clNew1", "Make Your Password", "new-password")}
        ${pwField("clNew2", "Confirm Password", "new-password")}
        <button class="btn primary big" type="submit">Save Password and Sign In</button>
      </div>
      <div class="login-links"><button type="button" class="linkbtn" id="clBack">Sign in with email and password</button></div>
    </form>`);
    bindEyes();
    let st = null;
    const show = (sel, on) => ($(sel).hidden = !on);
    const msg = (cls, html) => { const m = $("#clMsg"); m.className = "hint small " + cls; m.innerHTML = html; m.hidden = !html; };
    const reset = () => { st = null; show("#clRead", false); show("#clStep", false); show("#clNew", false); msg("", ""); };
    const take = async (t) => {
      const v = String(t || "").trim();
      reset();
      if (!CARD_CODE.test(v)) { return toast("This is not an EMON OVERRUNS employee ID card. Scan the QR code on the back of your ID card.", true); }
      const r = $("#clRead"); r.hidden = false; r.innerHTML = `<span class="spin sm"></span> Reading the ID card…`;
      const { data, error } = await sb.rpc("card_state", { p_code: v });
      if (error || !data) { r.hidden = true; return toast("The ID card could not be checked. Check the internet and try again.", true); }
      st = { ...data, code: v };
      const no = esc(v.split("|")[1].toUpperCase()), who = data.name ? ` · ${esc(data.name)}` : "";
      r.innerHTML = `${ic("check")} ID card ${no}${who}`;
      r.classList.toggle("bad", !data.email && data.state !== "set_password");
      if (data.email) { show("#clStep", true); return $("#clPass").focus(); } // the card is good: the password, with the keyboard
      if (data.state === "set_password") {
        msg("ok", `<b>Welcome${data.name ? ", " + esc(data.name) : ""}!</b> This is your first sign-in: make your password. Next time, scan your ID card and type this password.`);
        show("#clNew", true); return $("#clNew1").focus();
      }
      if (data.state === "account_exists") return msg("warn", `<b>You already have a portal account with your email ${esc(data.email_hint || "")}.</b> Sign in with your email and password, and ask the Director to link it to your employee profile.`);
      const why = { no_account: "The first sign-in with the ID card needs the database update 039_card_first_password.sql. Ask the Director.", blocked: "Your login is blocked. Ask the Director.",
        replaced: "This ID card was replaced by a newer card. Use your new ID card.", ended: "This ID card is no longer valid.",
        expired: `This ID card expired on ${esc(mdy(data.valid_until))}. Ask the Director for a new card.`, invalid: "This ID card is not valid." }[data.state] || "This ID card cannot sign in.";
      msg("err", why);
      if (data.state === "invalid") r.hidden = true;
    };
    $("#clBack").onclick = () => renderLogin("signin");
    $("#clCam").onclick = () => scanDialog(take, { title: "Scan Your ID Card", hint: "Hold the back of your ID card (the QR code) in front of the camera.", photo: false }); // 3.25: live scan only
    $("#clForm").onsubmit = async (e) => {
      e.preventDefault();
      if (!st) return toast("Scan your ID card first.", true);
      if (st.state === "set_password") {
        const p1 = $("#clNew1").value, p2 = $("#clNew2").value;
        if (p1.length < 6) { toast("Use a password of at least 6 characters.", true); return $("#clNew1").focus(); }
        if (p1 !== p2) { toast("The two passwords do not match.", true); return $("#clNew2").focus(); }
        setBusy(e.target, true, "Saving");
        const { data, error } = await sb.rpc("card_set_password", { p_code: st.code, p_password: p1 });
        if (error) { setBusy(e.target, false); return fail(error, "Could not save the password"); }
        const { error: inErr } = await sb.auth.signInWithPassword({ email: data.email, password: p1 });
        if (!inErr) return toast("Password saved. Welcome!"); // the auth listener opens the portal
        setBusy(e.target, false);
        return fail(inErr, "Sign-in failed");
      }
      if (!st.email) return toast($("#clMsg").textContent || "This ID card cannot sign in.", true);
      const password = $("#clPass").value;
      if (!password) { toast("Type your password.", true); return $("#clPass").focus(); }
      setBusy(e.target, true, "Signing in");
      const { error } = await sb.auth.signInWithPassword({ email: st.email, password });
      if (!error) return; // the auth listener opens the portal
      setBusy(e.target, false);
      if (/confirm/i.test(error.message)) { sb.auth.resend({ type: "signup", email: st.email, options: { emailRedirectTo: authRedirect() } }).then(() => {}, () => {}); toast("Your email is not confirmed yet. Enter the code we emailed you.", true); return renderCode(st.email); }
      $("#clPass").value = ""; $("#clPass").focus();
      fail(/invalid login/i.test(error.message) ? "Wrong password." : error, "Sign-in failed");
    };
  }

  function renderSignup() {
    authFrame("Create Account", `<form class="wbody login-form" id="suForm" novalidate>
      ${brandBlock()}
      <div class="seg" role="tablist"><button type="button" role="tab" id="toSignin">Sign In</button><button type="button" class="on" role="tab" aria-selected="true">Create Account</button></div>
      <label class="fl" for="suName">Full Name</label><input type="text" id="suName" autocomplete="name" required>
      <label class="fl" for="suUser">Username</label>
      <input type="text" id="suUser" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="20" placeholder="3–20 letters, numbers, dot or underscore" required>
      <div class="uname-msg" id="suUserMsg" aria-live="polite"></div>
      <label class="fl" for="suEmail">Email</label><input type="email" id="suEmail" autocomplete="email" required>
      ${pwField("suPass", "Password", "new-password")}
      ${pwField("suPass2", "Confirm Password", "new-password")}
      <button class="btn primary big" type="submit">Create Account</button>
      <div class="hint small">We will email you a confirmation code. After confirming, sign in with your email or username and apply for a job with us.</div>
    </form>`);
    bindEyes();
    $("#suName").focus();
    $("#toSignin").onclick = () => renderLogin("signin");
    let unameOk = false, timer = null, seq = 0;
    const check = async () => {
      const u = $("#suUser").value.trim().toLowerCase(), m = $("#suUserMsg"), my = ++seq;
      unameOk = false;
      if (!u) { m.className = "uname-msg"; m.textContent = ""; return; }
      if (!/^[a-z0-9._]{3,20}$/.test(u)) { m.className = "uname-msg bad"; m.textContent = "Use 3–20 letters, numbers, dot or underscore (no spaces)."; return; }
      m.className = "uname-msg"; m.innerHTML = `<span class="spin sm"></span> Checking…`;
      const { data, error } = await sb.rpc("username_available", { p_username: u });
      if (my !== seq) return;
      if (error) { m.className = "uname-msg"; m.textContent = ""; unameOk = true; return; } // the server checks again on sign-up
      unameOk = !!data;
      m.className = "uname-msg " + (data ? "ok" : "bad");
      m.textContent = data ? `✔ “${u}” is available` : `✖ “${u}” is already taken`;
    };
    $("#suUser").oninput = () => { clearTimeout(timer); timer = setTimeout(check, 300); };
    $("#suForm").onsubmit = async (e) => {
      e.preventDefault();
      const full_name = $("#suName").value.trim(), username = $("#suUser").value.trim().toLowerCase(), email = $("#suEmail").value.trim().toLowerCase();
      const p1 = $("#suPass").value, p2 = $("#suPass2").value;
      if (!full_name) return toast("Enter your full name.", true);
      if (!/^[a-z0-9._]{3,20}$/.test(username)) return toast("Choose a username of 3–20 letters, numbers, dot or underscore.", true);
      if (!/^\S+@\S+\.\S+$/.test(email)) return toast("Enter a valid email address.", true);
      if (p1.length < 6) return toast("Use a password of at least 6 characters.", true);
      if (p1 !== p2) return toast("The two passwords do not match.", true);
      clearTimeout(timer);
      setBusy(e.target, true, "Creating account"); // 3.35: at once, so a second press cannot send the form twice
      await check();
      if (!unameOk) { setBusy(e.target, false); return toast(`The username “${username}” is not available. Choose another.`, true); }
      const { data, error } = await sb.auth.signUp({ email, password: p1, options: { data: { full_name, username }, emailRedirectTo: authRedirect() } });
      setBusy(e.target, false);
      if (error && timedOut(error)) {
        // 3.29.1: the email server was slow. The account may still have been made (then its username is taken now):
        // go on to the code, which can come late; otherwise nothing was made and the person tries again.
        const { data: free } = await sb.rpc("username_available", { p_username: username });
        if (free === false) {
          toast(`Your account was created. The email with the code can take a few minutes to reach ${email}.`);
          return renderCode(email);
        }
        return toast("Could not create the account: the email server did not answer in time. Please try again in a few minutes.", true);
      }
      if (error) return fail(error, "Could not create the account");
      // Supabase answers an already-registered email with a user that has no identities.
      if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        toast(`${email} already has an account. Sign in, or press “Forgot password?”`, true);
        return renderLogin("signin", email);
      }
      if (!data.session) renderCode(email);
    };
  }

  function renderCode(email) {
    authFrame("Confirm Your Email", `<form class="wbody login-form" id="cdForm" novalidate>
      ${brandBlock()}
      <div class="code-ic">${ic("mail")}</div>
      <p class="center">We sent a confirmation code to<br><b>${esc(email)}</b></p>
      <label class="fl center" for="cdCode">Enter the code</label>
      <input type="text" id="cdCode" class="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="••••••" required>
      <button class="btn primary big" type="submit">Confirm</button>
      <div class="login-links"><button type="button" class="linkbtn" id="cdResend">Resend code</button><button type="button" class="linkbtn" id="cdBack">Back to Sign In</button></div>
      <small class="center muted">No email? Check the Spam folder. You can also tap the link inside the email.</small>
    </form>`);
    $("#cdCode").focus();
    $("#cdCode").oninput = (e) => (e.target.value = e.target.value.replace(/\D/g, ""));
    cooldown($("#cdResend"), 60);
    $("#cdResend").onclick = async () => {
      const { error } = await sb.auth.resend({ type: "signup", email, options: { emailRedirectTo: authRedirect() } });
      if (error) return fail(error, "Could not resend the code");
      toast("A new code was sent to " + email);
      cooldown($("#cdResend"), 60);
    };
    $("#cdBack").onclick = () => renderLogin("signin", email);
    $("#cdForm").onsubmit = async (e) => {
      e.preventDefault();
      const token = $("#cdCode").value.trim();
      if (token.length < 6) return toast("Enter the code from the email.", true);
      setBusy(e.target, true, "Checking");
      let { error } = await sb.auth.verifyOtp({ email, token, type: "signup" });
      if (error) ({ error } = await sb.auth.verifyOtp({ email, token, type: "email" }));
      if (error) { setBusy(e.target, false); return fail(/expired|invalid/i.test(error.message) ? "That code is wrong or has expired. Press Resend code." : error, "Could not confirm"); }
      toast("Email confirmed. Welcome to " + APP + "!");
    };
  }

  function renderForgot(preset = "") {
    authFrame("Forgot Password", `<form class="wbody login-form" id="fgForm" novalidate>
      ${brandBlock()}
      <p>Enter your email or username. We will email you a code to set a new password.</p>
      <label class="fl" for="fgId">Email or Username</label>
      <input type="text" id="fgId" autocapitalize="none" spellcheck="false" value="${esc(preset)}" required>
      <button class="btn primary big" type="submit">Send Code</button>
      <div class="login-links"><button type="button" class="linkbtn" id="fgBack">Back to Sign In</button></div>
    </form>`);
    $("#fgId").focus();
    $("#fgBack").onclick = () => renderLogin("signin", $("#fgId").value.trim());
    $("#fgForm").onsubmit = async (e) => {
      e.preventDefault();
      const id = $("#fgId").value.trim();
      if (!id) return toast("Enter your email or username.", true);
      setBusy(e.target, true, "Sending");
      const email = await loginEmail(id);
      if (!email) { setBusy(e.target, false); return toast(`No account uses the username “${id}”.`, true); }
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: authRedirect() });
      setBusy(e.target, false);
      if (error) return fail(error, "Could not send the code");
      toast("Code sent to " + email);
      renderReset(email);
    };
  }

  function renderReset(email) {
    authFrame("Set New Password", `<form class="wbody login-form" id="rsForm" novalidate>
      ${brandBlock()}
      <p class="center">We sent a code to <b>${esc(email)}</b>.</p>
      <label class="fl" for="rsCode">Code from the email</label>
      <input type="text" id="rsCode" class="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="••••••" required>
      ${pwField("rsPass", "New Password", "new-password")}
      ${pwField("rsPass2", "Confirm New Password", "new-password")}
      <button class="btn primary big" type="submit">Save New Password</button>
      <div class="login-links"><button type="button" class="linkbtn" id="rsResend">Resend code</button><button type="button" class="linkbtn" id="rsBack">Back to Sign In</button></div>
    </form>`);
    bindEyes();
    $("#rsCode").focus();
    $("#rsCode").oninput = (e) => (e.target.value = e.target.value.replace(/\D/g, ""));
    cooldown($("#rsResend"), 60);
    $("#rsResend").onclick = async () => {
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: authRedirect() });
      if (error) return fail(error, "Could not resend the code");
      toast("A new code was sent to " + email);
      cooldown($("#rsResend"), 60);
    };
    $("#rsBack").onclick = () => renderLogin("signin", email);
    $("#rsForm").onsubmit = async (e) => {
      e.preventDefault();
      const token = $("#rsCode").value.trim(), p1 = $("#rsPass").value, p2 = $("#rsPass2").value;
      if (token.length < 6) return toast("Enter the code from the email.", true);
      if (p1.length < 6) return toast("Use at least 6 characters.", true);
      if (p1 !== p2) return toast("The two passwords do not match.", true);
      setBusy(e.target, true, "Saving");
      S.resetting = true;
      const { error } = await sb.auth.verifyOtp({ email, token, type: "recovery" });
      if (error) { S.resetting = false; setBusy(e.target, false); return fail(/expired|invalid/i.test(error.message) ? "That code is wrong or has expired. Press Resend code." : error, "Could not check the code"); }
      const r = await sb.auth.updateUser({ password: p1 });
      S.resetting = false;
      if (r.error) fail(r.error, "Signed in, but the new password was not saved");
      else toast("Password changed. You are signed in.");
      S.profile = null;
      history.replaceState(null, "", location.pathname + "#dashboard");
      route();
    };
  }

  // Shown after a password-reset email link, and from "Change Password" in the account menu.
  function renderSetPassword(fromEmail) {
    authFrame("Set New Password", `<form class="wbody login-form" id="pwForm" novalidate>
      ${brandBlock()}
      <p class="center">${esc(S.session?.user?.email || "")}</p>
      ${fromEmail ? "" : pwField("pw0", "Old Password", "current-password")}
      ${pwField("pw1", "New Password", "new-password")}
      ${pwField("pw2", "Confirm New Password", "new-password")}
      <button class="btn primary big" type="submit">Save New Password</button>
      ${fromEmail ? "" : `<div class="login-links"><button type="button" class="linkbtn" id="pwCancel">Cancel</button></div>`}
    </form>`);
    bindEyes();
    if ($("#pwCancel")) $("#pwCancel").onclick = () => route();
    $("#pwForm").onsubmit = async (e) => {
      e.preventDefault();
      const p1 = $("#pw1").value, p2 = $("#pw2").value;
      if (p1.length < 6) return toast("Use at least 6 characters.", true);
      if (p1 !== p2) return toast("The two passwords do not match.", true);
      setBusy(e.target, true, "Saving");
      // 3.23: a change from My Profile needs the old password (a reset from the email link does not)
      if (!fromEmail) {
        const old = $("#pw0").value;
        if (!old) { setBusy(e.target, false); toast("Type your old password.", true); return $("#pw0").focus(); }
        const chk = await sb.auth.signInWithPassword({ email: S.session.user.email, password: old });
        if (chk.error) { setBusy(e.target, false); toast(/invalid login/i.test(chk.error.message) ? "The old password is wrong." : chk.error.message, true); return $("#pw0").focus(); }
      }
      const { error } = await sb.auth.updateUser({ password: p1 });
      setBusy(e.target, false);
      if (error) return fail(error, "Could not save the password");
      toast("Password saved.");
      recovering = false; // 3.35: the email link is used up, so the next page is not this form again
      history.replaceState(null, "", location.pathname + "#dashboard");
      route();
    };
  }

  function renderDisabled() {
    authFrame("Account Disabled", `<div class="wbody login-form">${brandBlock()}
      <div class="banner closed">This account (${esc(S.session.user.email)}) is disabled.</div>
      <p>Contact the Director of ${esc(C.company.name)} if you think this is a mistake.</p>
      <button class="btn big" id="dsOut">Sign Out</button></div>`);
    $("#dsOut").onclick = signOut;
  }
  function renderPending() {
    authFrame("Waiting for Approval", `<div class="wbody login-form">${brandBlock()}
      <p>Signed in as <b>${esc(S.session.user.email)}</b>. Your account is waiting for approval by the Director.</p>
      <div class="login-links"><button class="btn" id="pRefresh">Check Again</button><button class="btn" id="pOut">Sign Out</button></div></div>`);
    $("#pRefresh").onclick = async () => { S.profile = null; route(); };
    $("#pOut").onclick = signOut;
  }

  // Simple page frame (company header + slim bar) for applicants and the public verification page.
  // home: where the E-Portal name links to (the public Verification page links back to its search).
  function miniShell(title, body, { home } = {}) {
    const signed = !!S.session;
    closePreview();
    app.innerHTML = `
      <div class="topbar mini">
        ${home ? `<a class="mini-brand" href="${esc(home)}">${ic("shield")} ${esc(APP)}</a>` : `<span class="mini-brand">${ic("shield")} ${esc(APP)}</span>`}
        <div class="tb-right">${signed
          ? `<span class="mini-user">${esc(S.profile?.full_name || S.session.user.email)}</span><button type="button" class="btn light" id="msOut">${ic("out")} Sign Out</button>`
          : `<a class="btn light" href="#dashboard">${ic("user")} Sign In</a>`}</div>
      </div>
      <div class="content mini-content"><div class="band">${home ? backBtn() : ""}<h1>${esc(title)}</h1></div><main id="main">${body}</main>
        ${signed ? `<div class="mini-legal" id="msLegal"><a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a> · <button type="button" class="linkbtn" id="msDel">Request Account Deletion</button></div>` : ""}</div>`;
    if ($("#msOut")) $("#msOut").onclick = signOut;
    bindBack("#dashboard"); // with no page before: the sign-in page (the Verify page's own link is the Verify page)
    if ($("#msDel")) $("#msDel").onclick = async () => {
      const ref = await requestDeletion();
      if (ref) $("#msLegal").innerHTML = `Account deletion requested. Reference No <b class="mono">${esc(ref)}</b> · <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>`;
    };
  }
  // 2.4: a Back button on the green band. It goes to the page before, and never leaves the portal: Chrome, Edge and the
  // Android and Windows apps know whether the page before is a page of this site (the Navigation API); other browsers
  // use the pages opened in this visit. With no page before, it goes home.
  const visited = [location.hash];
  let goingBack = false;
  window.addEventListener("hashchange", () => {
    if (goingBack) { goingBack = false; return; }
    visited.push(location.hash);
    if (visited.length > 60) visited.shift();
  });
  const backBtn = () => `<button type="button" class="band-back" id="bandBack" aria-label="Back" title="Back">${ic("back")}</button>`;
  function goBack(home) {
    const nav = window.navigation;
    if (nav && "canGoBack" in nav) { if (nav.canGoBack) { history.back(); return; } }
    else {
      visited.pop(); // this page
      while (visited.length && visited[visited.length - 1] === location.hash) visited.pop();
      const before = visited[visited.length - 1];
      if (before) { goingBack = true; location.hash = before; return; }
    }
    location.hash = home || "#dashboard";
  }
  function bindBack(home) {
    const b = $("#bandBack");
    if (b) b.onclick = () => goBack(home);
  }
  // 2.4: a signed-in person asks the Director to delete their account. The request arrives in Contact Messages; the
  // Director then deletes the account on Login Accounts. Gives the reference number, or null.
  async function requestDeletion(position) {
    if (!(await confirmBox("Ask the Director to <b>delete your E-Portal account</b>? When it is deleted you cannot sign in any more, and this cannot be undone.", { title: "Delete My Account", ok: "Send Request", danger: true }))) return null;
    const email = S.session.user.email;
    const msg = `ACCOUNT DELETION REQUEST (signed in)\nAccount email: ${email}${S.profile?.username ? `\nUsername: @${S.profile.username}` : ""}\nPosition: ${personTitle(S.profile?.role, position)}`;
    const { data, error } = await sb.rpc("submit_contact_message", { p_name: S.profile?.full_name || email, p_reply_via: "email", p_reply_to: email, p_message: msg });
    if (error) { fail(error, "Could not send the request"); return null; }
    toast("Account deletion request sent.");
    return data;
  }

  // ---------- shell: company header, top bar, slide-out menu ----------
  const MENU = [
    { k: "dashboard", icon: "home", label: "Dashboard" },
    { k: "customers", icon: "user", label: "Customer" },
    { k: "invoices", icon: "doc", label: "Invoice" },
    { k: "payments", icon: "wallet", label: "Payment" },
    { k: "purchase", icon: "order", label: "Purchase Order" },
    { k: "eooffice", icon: "shield", label: "EO-Office" },
    { k: "billing", icon: "building", label: "Billing" },
    { k: "inventory", icon: "box", label: "E-Bill" }
  ];
  // 3.2: EO-Office holds QC Test, Collection Voucher, Job Applications, Job Positions, Credit Memo and Project: it opens for anyone who may open one of them
  const EO_MODULES = ["eooffice", "creditmemos", "projects", "employees"];
  // Which menu item (module) each page belongs to; pages a user has no access to are blocked.
  const MODULE_OF = {
    customers: "customers", newcustomer: "customers", customer: "customers", statements: "customers", order: "customers",
    invoices: "invoices", newinvoice: "invoices", invoice: "invoices",
    // 2.9: staff who record invoices also record payments (the server allows both)
    payments: ["payments", "invoices"], newpayment: ["payments", "invoices"], payment: ["payments", "invoices"],
    creditmemos: "creditmemos", newcreditmemo: "creditmemos", creditmemo: "creditmemos",
    employees: "employees", newemployee: "employees", editemployee: "employees", employee: "employees", jobapps: "employees", jobapp: "employees", positions: "employees", payroll: "employees",
    projects: "projects", newproject: "projects", project: "projects",
    billing: "billing", newpaycompany: "billing", paycompany: "billing", newvoucher: "billing", voucher: "billing", ebill: ["billing", "inventory"],
    inventory: "inventory", newstockbill: "inventory", stockbill: "inventory",
    eooffice: EO_MODULES, newqc: "eooffice", qc: "eooffice", newcollection: "eooffice", editcollection: "eooffice", collection: "eooffice",
    purchase: "purchase", newpurchase: "purchase", po: "purchase", editpo: "purchase", // 3.31: its own menu access
    custorders: "eooffice", newcustorder: "eooffice", editcustorder: "eooffice", custorder: ["eooffice", "customers"] // 3.37: Customer Order (an order opens from the customer's profile too)
  };
  // Admins see everything; NULL modules = all (older accounts).
  // 3.31: Employees, Payroll and Job Applications come with EO-Office (there is no Employee (HR) access any more)
  const hasModule = (m) => !m || isAdmin() || !S.profile?.modules || S.profile.modules.includes(m === "employees" ? "eooffice" : m);
  const canOpen = (key) => { const m = MODULE_OF[key]; return Array.isArray(m) ? m.some(hasModule) : hasModule(m); };
  // Staff may add records in the sections they can open; viewers only look.
  const canWrite = (m) => isAdmin() || (isStaff() && hasModule(m));
  // 3.43: EVA AI for the Director and the staff the Director ticked "12 EVA AI" for (never given by the old all-access)
  const canAI = () => isAdmin() || (isStaff() && (S.profile?.modules || []).includes("ai"));
  const OTHER = [
    ["verify", "Verification", () => true, "shield"],
    ["changes", "Corrections", () => isAdmin(), "edit"],
    ["contacts", "Contact Messages", () => isAdmin(), "mail"],
    ["logins", "Login Accounts", () => isAdmin(), "key"],
    ["forms", "Download Forms", () => true, "download"],
    ["gateai", "EVA AI", () => isAdmin(), "ai"] // 3.38 (3.38.1: named EVA, EMON Virtual Assistant)
  ];
  const ACTIVE_OF = { employees: "eooffice", newemployee: "eooffice", editemployee: "eooffice", employee: "eooffice", payroll: "eooffice", payslip: "eooffice", creditmemos: "eooffice", newcreditmemo: "eooffice", creditmemo: "eooffice", projects: "eooffice", newproject: "eooffice", project: "eooffice", jobapps: "eooffice", jobapp: "eooffice", positions: "eooffice", newqc: "eooffice", qc: "eooffice", newcollection: "eooffice", editcollection: "eooffice", collection: "eooffice", newpurchase: "purchase", po: "purchase", editpo: "purchase", ebill: "inventory", custorders: "eooffice", newcustorder: "eooffice", editcustorder: "eooffice", custorder: "eooffice", find: "", profile: "", settings: "" };
  // Older addresses from version 1.0.
  const ALIAS = { users: "employees", userres: "employees", resolutions: "purchase", resolution: "purchase", community: "purchase", orders: "dashboard", neworder: "dashboard", editorder: "dashboard", verification: "verify", supplier: "billing", newsupplier: "billing", search: "dashboard" };
  const avatarUrl = () => publicUrl("avatars", S.profile?.avatar_path);
  const initials = (name) => String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
  const isPhone = () => window.innerWidth < 900;

  function drawerOpen(open) {
    document.body.classList.toggle("drawer-open", open);
    const b = $("#tbMenu"); if (b) b.setAttribute("aria-expanded", String(open));
    if (!isPhone()) try { localStorage.setItem("eoDrawer", open ? "1" : "0"); } catch (_) {}
  }
  // Swipe from the left edge to open the menu; swipe it back to close (phones and tablets).
  let swipeBound = false;
  function bindSwipe() {
    if (swipeBound) return;
    swipeBound = true;
    let sx = 0, sy = 0, dx = 0, mode = "", drag = false;
    const width = () => $("#drawer")?.offsetWidth || 264;
    document.addEventListener("touchstart", (e) => {
      mode = "";
      const dr = $("#drawer");
      if (!dr || !isPhone() || e.touches.length !== 1 || $(".modal, .preview, .chat-panel.open")) return;
      const t = e.touches[0];
      sx = t.clientX; sy = t.clientY; dx = 0; drag = false;
      const open = document.body.classList.contains("drawer-open");
      if (!open && sx <= 26) mode = "open";
      else if (open && (dr.contains(e.target) || e.target.id === "scrim")) mode = "close";
    }, { passive: true });
    document.addEventListener("touchmove", (e) => {
      if (!mode) return;
      const t = e.touches[0];
      dx = t.clientX - sx;
      const dy = t.clientY - sy;
      if (!drag) {
        if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) { mode = ""; return; }
        if (Math.abs(dx) < 8) return;
        drag = true;
        document.body.classList.add("drawer-drag");
      }
      const w = width();
      const pos = mode === "open" ? Math.min(0, -w + Math.max(0, dx)) : Math.max(-w, Math.min(0, dx));
      const dr = $("#drawer"), sc = $("#scrim");
      if (dr) dr.style.transform = `translateX(${pos}px)`;
      if (sc) sc.style.opacity = String(Math.max(0, 1 + pos / w));
    }, { passive: true });
    const end = () => {
      const m = mode;
      mode = "";
      if (!m || !drag) return;
      drag = false;
      document.body.classList.remove("drawer-drag");
      const dr = $("#drawer"), sc = $("#scrim");
      if (dr) dr.style.transform = "";
      if (sc) sc.style.opacity = "";
      const w = width();
      drawerOpen(m === "open" ? dx > w * 0.3 : !(-dx > w * 0.3));
    };
    document.addEventListener("touchend", end, { passive: true });
    document.addEventListener("touchcancel", end, { passive: true });
  }

  // 3.35: a page drawn again (after an upload, Approve …) stays where it was read: its old height is held until its new
  // content is in, so the screen does not jump to the top
  function holdHeight(main, h) {
    main.style.minHeight = h + "px";
    const free = () => { mo.disconnect(); clearTimeout(t); requestAnimationFrame(() => (main.style.minHeight = "")); };
    const mo = new MutationObserver(free), t = setTimeout(free, 15000);
    setTimeout(() => mo.observe(main, { childList: true, subtree: true }), 0); // after the page's own "Loading" boxes
  }
  function shell(key, title, body, hint) {
    const cur = ACTIVE_OF[key] ?? (Array.isArray(MODULE_OF[key]) ? MODULE_OF[key][0] : MODULE_OF[key]) ?? key;
    const items = MENU.filter((m) => m.k === "dashboard" || (m.k === "purchase" ? isStaff() && hasModule("purchase") : m.k === "eooffice" ? EO_MODULES.filter((x) => isStaff() || x !== "eooffice").some(hasModule) : hasModule(m.k)));
    const main = items.map((m, i) => `<a href="#${m.k}" style="--i:${i}" class="${m.k === cur ? "active" : ""}"><span class="num">${ic(m.icon)}</span><span class="lbl">${esc(m.label)}</span></a>`).join("");
    const other = OTHER.filter((o) => o[2]()).map(([k, label, , icon], j) => `<a href="#${k}" style="--i:${items.length + j + 1}" class="sub ${k === cur ? "active" : ""}"><span class="num">${ic(icon)}</span><span class="lbl">${esc(label)}</span></a>`).join("");
    const av = avatarUrl();
    const who = S.profile.full_name || S.session.user.email;
    const currency = ["inventory", "newstockbill", "stockbill", "ebill"].includes(key) ? "BDT" : "PHP (₱)";
    // 3.36: no "?" on any page; the dashboard has no title (its greeting stands in its place)
    const bandHtml = key === "dashboard" ? "" : `<div class="band">${backBtn()}<h1>${esc(title)}</h1></div>`;
    const mainHtml = `<main id="main">${hint ? `<div class="hint"><b>Hint:</b> ${hint}</div>` : ""}${body}</main>`;
    // 2.7.2: moving between pages keeps the top bar and the side menu in place (no flash); only the page itself is
    // swapped, with a soft fade. The whole frame is drawn again only when the menu or the person changes.
    const frame = [S.session.user.id, who, av, newBuild, items.map((m) => m.k).join(","), OTHER.filter((o) => o[2]()).map((o) => o[0]).join(",")].join("|");
    const content = $(".layout > .content", app);
    const samePage = app.dataset.page === location.hash;
    app.dataset.page = location.hash;
    const slideIn = (el) => { if (!el || samePage) return; el.classList.remove("page-in", "nav-back"); void el.offsetWidth; el.classList.add("page-in"); if (navDir === "back") el.classList.add("nav-back"); };
    if (content && app.dataset.frame === frame) {
      $$("#drawer a").forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#" + cur));
      $$(".pop").forEach((p) => (p.hidden = true));
      if ($("#tbSpin")) $("#tbSpin").hidden = true;
      if ($("#tbQ") && document.activeElement !== $("#tbQ")) $("#tbQ").value = "";
      const sb2 = $$(".statusbar > span", app);
      if (sb2[1]) sb2[1].textContent = "Records: –";
      if (sb2[2]) sb2[2].textContent = "Currency: " + currency;
      const oldH = samePage ? $("#main", content)?.offsetHeight || 0 : 0;
      content.innerHTML = bandHtml + mainHtml;
      if (oldH) holdHeight($("#main", content), oldH);
      slideIn(content);
      if (!samePage) window.scrollTo({ top: 0 });
      bindBack("#dashboard");
      refreshBadges();
      return;
    }
    app.dataset.frame = frame;
    app.innerHTML = `
      <div class="topbar" id="topbar">
        <button type="button" class="iconbtn burger" id="tbMenu" aria-label="Menu" aria-controls="drawer" aria-expanded="false"><span></span><span></span><span></span></button>
        <form class="tb-search" id="tbSearch" role="search">
          <span class="tb-sic">${ic("search")}</span>
          <input type="search" id="tbQ" placeholder="Search name, account, invoice, receipt…" aria-label="Search records" autocomplete="off">
          <span class="spin sm" id="tbSpin" hidden></span>
          <button type="button" class="scanbtn" id="tbScan" title="Scan a QR code or barcode">${ic("scan")}<span>Scan</span></button>
        </form>
        <div class="tb-right">
          ${canAI() ? `<button type="button" class="iconbtn tb-eva" id="tbEva" aria-label="Ask EVA AI" title="Ask EVA AI">${ic("ai")}</button>` : ""}
          <button type="button" class="iconbtn" id="tbChat" aria-label="Messages" title="Messages">${ic("chat")}<span class="badge" id="tbChatBadge" hidden>0</span></button>
          <button type="button" class="iconbtn" id="tbBell" aria-label="Notifications" title="Notifications" aria-haspopup="true">${ic("bell")}<span class="badge" id="tbBadge" hidden>0</span></button>
          <button type="button" class="avatar-btn" id="tbUser" aria-haspopup="true" aria-label="Your account">
            ${av ? `<img src="${esc(av)}" alt="">` : `<span>${esc(initials(who))}</span>`}
          </button>
        </div>
        <div class="pop" id="mailPop" hidden><div class="pop-head">Notifications</div><div id="mailList">${busy()}</div></div>
        <div class="pop" id="userPop" hidden>
          <div class="pop-head">${esc(S.profile.full_name || "")}<small>${S.profile.username ? "@" + esc(S.profile.username) + " · " : ""}${esc(S.session.user.email)} · ${esc(personTitle(S.profile.role, S.position).toUpperCase())}</small></div>
          <a href="#profile">${ic("user")} My Profile</a>
          <button type="button" id="chPw">${ic("key")} Change Password</button>
          ${window.EOApp?.menu ? `<button type="button" id="upAppMenu">${ic("box")} App Menu (scanner, about)</button>` : ""}
          ${newBuild ? updateItem() : ""}
          ${isAdmin() ? `<a href="#settings">${ic("image")} Company Logo</a>` : ""}
          <button type="button" id="signOut">${ic("out")} Sign Out</button>
        </div>
      </div>
      <div class="layout">
        <nav class="drawer" id="drawer" aria-label="Main menu">
          <div class="drawer-head">${logoHtml("drawer-logo")}<div><b>${esc(C.company.name)}</b><small>E-PORTAL v${VERSION}</small></div></div>
          ${main}
          <div class="drawer-sep" style="--i:${items.length}">Other</div>
          ${other}
        </nav>
        <div class="scrim" id="scrim"></div>
        <div class="content">${bandHtml}${mainHtml}</div>
      </div>
      <div class="statusbar"><span>User: ${esc(who)}</span><span id="sbRecords">Records: –</span><span>Currency: ${currency}</span></div>`;
    slideIn($(".layout > .content", app));
    let saved = null; try { saved = localStorage.getItem("eoDrawer"); } catch (_) {}
    document.body.classList.add("no-anim");
    drawerOpen(isPhone() ? false : saved !== "0");
    requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove("no-anim")));
    bindSwipe();
    bindBack("#dashboard");
    $("#tbMenu").onclick = () => drawerOpen(!document.body.classList.contains("drawer-open"));
    $("#scrim").onclick = () => drawerOpen(false);
    $$("#drawer a").forEach((a) => (a.onclick = () => { if (isPhone()) drawerOpen(false); }));
    $("#signOut").onclick = signOut;
    $("#chPw").onclick = () => renderSetPassword(false);
    if ($("#upAppMenu")) $("#upAppMenu").onclick = () => { $$(".pop").forEach((p) => (p.hidden = true)); window.EOApp.menu().catch(() => {}); };
    bindUpdate();
    $("#tbSearch").onsubmit = (e) => {
      e.preventDefault();
      const q = $("#tbQ").value.trim();
      if (!q) return;
      $("#tbSpin").hidden = false;
      const h = "find/" + encodeURIComponent(q);
      if (location.hash.slice(1) === h) route(); else location.hash = h;
    };
    $("#tbScan").onclick = () => scanDialog((text) => openScanned(text));
    $("#tbChat").onclick = () => { if (window.EO.openChat) window.EO.openChat(); else toast("Messages are not available yet.", true); };
    if ($("#tbEva")) $("#tbEva").onclick = () => window.EO.eva?.open();
    const toggle = (id) => { const el = $(id); const show = el.hidden; $$(".pop").forEach((p) => (p.hidden = true)); el.hidden = !show; if (show && id === "#mailPop") loadMail(); };
    $("#tbBell").onclick = (e) => { e.stopPropagation(); toggle("#mailPop"); };
    $("#tbUser").onclick = (e) => { e.stopPropagation(); toggle("#userPop"); };
    document.onclick = (e) => { if (!e.target.closest(".pop")) $$(".pop").forEach((p) => (p.hidden = true)); };
    refreshBadges();
  }

  // Notification (bell) and unread message (chat) counters; fetched at most every 15 seconds.
  const badgeState = { at: 0, notes: 0, msgs: 0 };
  function paintBadges() {
    const set = (id, n) => { const b = $(id); if (!b) return; b.hidden = !n; b.textContent = n > 99 ? "99+" : String(n || 0); };
    set("#tbBadge", badgeState.notes);
    set("#tbChatBadge", badgeState.msgs);
  }
  async function refreshBadges(force) {
    paintBadges();
    if (!force && Date.now() - badgeState.at < 15000) return;
    badgeState.at = Date.now();
    const [n, m] = await Promise.all([
      sb.from("notifications").select("id", { count: "exact", head: true }).eq("is_read", false),
      sb.rpc("unread_messages_count")
    ]);
    badgeState.notes = n.error ? 0 : n.count || 0;
    badgeState.msgs = m.error ? 0 : Number(m.data || 0);
    paintBadges();
  }
  const refreshBadge = () => refreshBadges(true);
  async function loadMail() {
    const { data, error } = await sb.from("notifications").select("*").order("created_at", { ascending: false }).limit(30);
    const box = $("#mailList"); if (!box) return;
    if (error) { box.innerHTML = `<div class="empty">Notifications could not be loaded.</div>`; return; }
    if (!data.length) { box.innerHTML = `<div class="empty">No notifications yet.</div>`; return; }
    box.innerHTML = data.map((n) => `<a class="mail-item ${n.is_read ? "" : "unread"}" href="#${esc(n.link || "dashboard")}" data-n="${n.id}">
      <b>${esc(n.title)}</b><span>${esc(n.body || "")}</span><small>${esc(timeAgo(n.created_at))}</small></a>`).join("")
      + `<button type="button" class="btn" id="mailAllRead" style="margin:6px">Mark all as read</button>`;
    $$(".mail-item", box).forEach((a) => (a.onclick = () => { sb.from("notifications").update({ is_read: true }).eq("id", Number(a.dataset.n)).then(refreshBadge); }));
    $("#mailAllRead").onclick = async () => { await sb.from("notifications").update({ is_read: true }).eq("is_read", false); loadMail(); refreshBadge(); };
  }

  // Presence ("active now" in Messages) and badge refresh while signed in.
  let timers = [];
  function startTimers() {
    if (timers.length) return;
    const beat = () => { if (S.session && document.visibilityState === "visible") sb.rpc("touch_presence").then(() => {}, () => {}); };
    beat();
    timers = [
      setInterval(beat, 60000),
      setInterval(() => { if (S.session && document.visibilityState === "visible") refreshBadges(true); }, 30000)
    ];
  }
  function stopTimers() { timers.forEach(clearInterval); timers = []; }

  // Scanner: camera (QR or PDF417) or a photo of the code.
  // 3.27: the camera is started here, the back camera first and else any camera (some phones refuse the back camera
  // setting). When it cannot start, the dialog says why, with Try Again and Open Camera (a picture of the code taken
  // with the phone's camera app).
  const CAM_BLOCKED = "The camera is blocked for this website. Tap the icon left of the web address → Permissions → Camera → Allow (on Android also check Settings → Apps → Chrome → Permissions → Camera), then press Try Again.";
  const CAM_BUSY = "The camera is busy or could not start. Close other apps that use the camera, then press Try Again.";
  const CAMERA_PROBLEM = { NotAllowedError: CAM_BLOCKED, SecurityError: CAM_BLOCKED, NotReadableError: CAM_BUSY, AbortError: CAM_BUSY, NotFoundError: "No camera was found on this device.", OverconstrainedError: "No camera was found on this device." };
  // 3.27.2: the QR is on the back of the card, so the back camera is wanted. When the phone gives the front camera,
  // each back camera of the phone (main, wide, zoom) is tried by name; the front camera comes back only when none starts.
  const getCam = (video) => navigator.mediaDevices.getUserMedia({ video, audio: false });
  const isFront = (track) => track.getSettings?.().facingMode === "user" || /front|selfie/i.test(track.label);
  const cameras = async () => (await navigator.mediaDevices.enumerateDevices()).filter((c) => c.kind === "videoinput");
  // 3.35: a sharp picture (asked for; a phone gives 640 × 480 otherwise, too little for a dense PDF417): full HD for the
  // phone's own barcode reader, HD for ZXing (a bigger picture would make each try slower)
  const CAM_SIZE = { hd: { width: { ideal: 1920 }, height: { ideal: 1080 } }, sd: { width: { ideal: 1280 }, height: { ideal: 720 } } };
  async function openCamera(deviceId, size = {}) {
    if (deviceId) return getCam({ deviceId: { exact: deviceId }, ...size }); // Switch Camera
    let stream, last;
    for (const video of [{ facingMode: { ideal: "environment" }, ...size }, true]) {
      try { stream = await getCam(video); break; }
      catch (e) { last = e; if (CAMERA_PROBLEM[e.name] === CAM_BLOCKED) break; } // blocked: another camera will not help
    }
    if (!stream) throw last;
    if (!isFront(stream.getVideoTracks()[0])) return stream;
    const backs = (await cameras()).filter((c) => /back|rear|environment/i.test(c.label));
    if (!backs.length) return stream; // only a front camera (a laptop)
    stream.getTracks().forEach((t) => t.stop()); // a phone opens one camera at a time
    await new Promise((ok) => setTimeout(ok, 400));
    for (const c of backs) { try { return await getCam({ deviceId: { exact: c.deviceId }, ...size }); } catch (_) { /* the next back camera */ } }
    stream = await getCam(true);
    stream.backFailed = true;
    return stream;
  }
  // 3.37 keep: the camera stays open and every new code is given at once (the boxes of an order, one after another); what
  // onText gives back shows under the picture, and a code read before is not given again. onClose: when the scanner closes.
  function scanDialog(onText, { title = "Scan QR Code / Barcode", hint = "Point the camera at the QR code or barcode.", photo = true, keep = false, onClose = null } = {}) {
    let reader = null, stream = null, run = 0, done = false;
    const seen = new Set();
    // 3.35: one camera at a time: Try Again, Switch Camera and Close first stop the camera in use (also one still starting)
    const stop = () => {
      run++;
      try { reader?.reset(); } catch (_) {}
      reader = null;
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
    };
    const m = modal(title, `<div class="scan-view"><video id="scVideo" playsinline muted></video><div class="scan-frame"><i></i></div></div>
      <div id="scMsg" class="scan-msg">${esc(hint)}</div>`,
      `${photo ? `<label class="btn" for="scImg">${ic("image")} Use a Photo</label>` : ""}<input type="file" id="scImg" accept="image/*" hidden>
      <button type="button" class="btn" id="scSwitch" hidden>Switch Camera</button><button type="button" class="btn" id="scRetry" hidden>Try Again</button><label class="btn primary" for="scCap" id="scCapL" hidden>${ic("camera")} Open Camera</label><input type="file" id="scCap" accept="image/*" capture="environment" hidden>
      <button type="button" class="btn" data-close>Close</button>`,
      { cls: "scan-modal", onClose: () => { stop(); if (onClose) onClose(); } });
    const d = m.el;
    const msg = (t) => { const el = $("#scMsg", d); if (el) el.textContent = t; };
    const finish = (text) => {
      if (done) return;
      if (!keep) { done = true; m.close(); onText(text); return; }
      if (seen.has(text)) return;
      seen.add(text);
      try { navigator.vibrate?.(60); } catch (_) {}
      Promise.resolve(onText(text)).then((note) => { if (note && d.isConnected) msg(note); }, (e) => { if (d.isConnected) msg(e?.message || String(e)); });
    };
    $("[data-close]", d).onclick = m.close;
    $("#scImg", d).onchange = $("#scCap", d).onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      msg("Reading the photo…");
      try { finish(await decodeImageFile(f)); }
      catch (err) { msg(err.message); }
      e.target.value = "";
    };
    const noCamera = (e) => {
      if (done || !d.isConnected) return;
      d.classList.add("nocam"); $("#scRetry", d).hidden = $("#scCapL", d).hidden = false;
      msg(`${CAMERA_PROBLEM[e?.name] || "The camera could not start."} Or press Open Camera to take a picture of the code.${e?.name ? ` (${e.name})` : ""}`);
    };
    let cams = [], current = "";
    const start = async (deviceId) => {
      stop(); // the camera in use is closed first
      const my = run, live = () => my === run && !done && d.isConnected;
      d.classList.remove("nocam", "front"); $("#scRetry", d).hidden = true; msg(hint);
      if (!navigator.mediaDevices?.getUserMedia) return noCamera(null);
      const det = await nativeReader();
      const lib = det ? null : need("zxing"); // ZXing loads while the camera starts
      lib?.catch(() => {});
      let s;
      try { s = await openCamera(deviceId, det ? CAM_SIZE.hd : CAM_SIZE.sd); }
      catch (e) { if (live()) noCamera(e); return; }
      if (!live()) return s.getTracks().forEach((t) => t.stop()); // closed, or started again, while the camera started
      stream = s;
      const track = s.getVideoTracks()[0];
      current = track.getSettings?.().deviceId || "";
      d.classList.toggle("front", isFront(track)); // the front camera is shown like a mirror
      if (s.backFailed) { $("#scCapL", d).hidden = false; msg("The back camera did not start, so the front camera is on. Press Switch Camera to try another camera, or Open Camera."); }
      cameras().then((list) => { if (live()) { cams = list; $("#scSwitch", d).hidden = cams.length < 2; } }, () => {});
      const video = $("#scVideo", d);
      if (det) {
        video.srcObject = s;
        video.play().catch(() => {});
        const look = async () => {
          if (!live()) return;
          if (video.readyState >= 2) {
            try { const [code] = await det.detect(video); if (code?.rawValue && live()) { finish(code.rawValue); if (!keep) return; } }
            catch (_) { /* the next picture */ }
          }
          setTimeout(look, 80);
        };
        return look();
      }
      let Z;
      try { Z = await lib; } catch (err) { if (live()) msg(err.message); return; }
      if (!live()) return;
      reader = new Z.BrowserMultiFormatReader(new Map([[Z.DecodeHintType.POSSIBLE_FORMATS, zxFormats(Z)], [Z.DecodeHintType.TRY_HARDER, true]]));
      reader.decodeFromStream(s, video, (res) => { if (res && live()) finish(res.getText()); }).catch((e) => { if (live()) noCamera(e); });
    };
    $("#scRetry", d).onclick = () => start();
    $("#scSwitch", d).onclick = () => { const i = cams.findIndex((c) => c.deviceId === current); start(cams[(i + 1) % cams.length]?.deviceId); };
    start();
  }
  // Customer QR: the customer's Public ID key, like a crypto wallet address (EO + 40 letters and numbers).
  // Older customer QR codes read EMONCUST|<public id>|<account no>.
  // Document barcodes (EMONINV|…, EMONPAY|…, EMONBD|…, EMONORDER|…) and verification links open the Verification page.
  const isCustKey = (t) => /^EO[0-9a-f]{40}$/i.test(String(t || "").trim());
  async function openScanned(text) {
    const t = String(text || "").trim();
    if (!t) return;
    // 3.39: an order paper (the secret code in its barcode, or its QR code) opens its Complete Delivery page, for anyone
    const dv = window.EO.deliveryHashOf?.(t);
    if (dv) { location.hash = dv; return true; }
    if (/#verify\//i.test(t)) { location.hash = "verify/" + encodeURIComponent(t.replace(/^.*#verify\//i, "")); return; }
    // 3.21: an employee ID card: whose it is and whether it is valid (its private code never goes into the address bar)
    if (/^EMONID\|/i.test(t)) { window.EO.showCardCheck?.(t); return true; }
    const key = isCustKey(t);
    if (key || t.startsWith("EMONCUST|")) {
      const q = sb.from("customers").select("id");
      const { data } = await (key ? q.ilike("public_id", t) : q.eq("account_no", t.split("|")[2] || "")).maybeSingle();
      if (data && canOpen("customer")) { location.hash = "customer/" + data.id; return; }
      if (key) { location.hash = "verify/" + encodeURIComponent(t); return; }
    }
    // 3.37: a customer order's barcode opens that order (3.38.1: OR-202610-0001; CO- on the orders printed before)
    const co = /^EMONCO\|((?:CO|OR)-\d{6}-\d+)/i.exec(t);
    if (co && canOpen("custorder")) { location.hash = "custorder/" + co[1].toUpperCase(); return true; }
    // 3.1: a QC form barcode opens that QC form
    const qc = /^EMONQCK?\|(QC-\d{4}-\d+)/i.exec(t);
    if (qc && canOpen("qc")) {
      const { data } = await sb.from("qc_tests").select("id").eq("qc_no", qc[1].toUpperCase()).maybeSingle();
      if (!data) { toast("No QC form found for that code.", true); return false; }
      location.hash = "qc/" + data.id;
      return true;
    }
    if (/^EMON[A-Z]*\|/.test(t)) { location.hash = "verify/" + encodeURIComponent(t); return; }
    location.hash = "find/" + encodeURIComponent(t);
  }
  const setRecords = (txt) => { const e = $("#sbRecords"); if (e) e.textContent = txt; };

  // ---------- grid ----------
  function grid({ cols, rows, onRow, foot, group, empty = "No records match these options." }) {
    if (!rows.length) return `<div class="grid-wrap"><div class="empty">${esc(empty)}</div></div>`;
    const head = cols.map((c) => `<th class="${c.num ? "num" : ""}" scope="col">${esc(c.label)}</th>`).join("");
    const rowHtml = (r, i) => `<tr class="${onRow ? "click" : ""}" data-i="${i}">${cols.map((c) => `<td class="${c.num ? "num" : ""}">${c.html ? c.html(r) : esc(c.get(r))}</td>`).join("")}</tr>`;
    let bodyHtml = "";
    if (group) {
      const groups = new Map();
      rows.forEach((r, i) => { const g = group(r); if (!groups.has(g)) groups.set(g, []); groups.get(g).push([r, i]); });
      for (const [g, list] of groups) {
        bodyHtml += `<tr><td colspan="${cols.length}" style="background:var(--grid-head);font-weight:bold">${esc(g)} (${list.length})</td></tr>`;
        bodyHtml += list.map(([r, i]) => rowHtml(r, i)).join("");
      }
    } else bodyHtml = rows.map(rowHtml).join("");
    const footHtml = foot ? `<tfoot><tr>${cols.map((c) => `<td class="${c.num ? "num" : ""}">${foot[c.key] ?? ""}</td>`).join("")}</tr></tfoot>` : "";
    return `<div class="grid-wrap">${onRow ? `<div class="grid-group">Click a row to open it</div>` : ""}
      <div class="grid-scroll"><table class="grid"><thead><tr>${head}</tr></thead><tbody>${bodyHtml}</tbody>${footHtml}</table></div>
      <div class="grid-foot"><span>Record 1 of ${rows.length}</span><span>${rows.length} record(s)</span></div></div>`;
  }
  function bindGrid(container, rows, onRow) {
    if (!onRow) return;
    $$("tbody tr.click", container).forEach((tr) => {
      tr.tabIndex = 0;
      const go = () => onRow(rows[Number(tr.dataset.i)]);
      tr.onclick = (e) => { if (!e.target.closest("button, a, input, select, label")) go(); };
      tr.onkeydown = (e) => { if (e.key === "Enter") go(); };
    });
  }

  // ---------- the open tab of a record page stays open when the page is drawn again ----------
  // A record page (customer, employee, billing company, e-bill) is drawn again after an upload or a change: the tab
  // that was open (Files, Documents …) opens again, so the new file is in view at once. Another record, or the same
  // record opened again later, starts on its first tab.
  const OPEN_TAB = { key: "", i: 0 };
  function keepTab(sel, key) {
    const btns = $$(sel + " button");
    if (OPEN_TAB.key !== key) { OPEN_TAB.key = key; OPEN_TAB.i = 0; }
    btns.forEach((b, i) => b.addEventListener("click", () => { if (OPEN_TAB.key === key) OPEN_TAB.i = i; }));
    const b = btns[OPEN_TAB.i];
    if (OPEN_TAB.i && b && !b.classList.contains("on")) b.click();
  }
  addEventListener("hashchange", () => { OPEN_TAB.key = ""; });
  // For work that ends later (an upload, a page that loads): true while the person is still on the same page, so the
  // page is drawn only then (not over the page they went to). 3.35: the same page opened again (the menu pressed again)
  // counts as a new page, so the older drawing of it stops.
  let navs = 0; // counted by the router
  const stillHere = () => { const h = location.hash, n = navs; return () => location.hash === h && navs === n; };
  // 3.35: for a list that loads again (a filter, a tab, a search): only the reply of its newest load is used, and only
  // while its page is open; an older, slower reply is dropped. const fresh = loadGuard(); … const ok = fresh(); await …; if (!ok()) return;
  function loadGuard() {
    const here = stillHere();
    let n = 0;
    return () => { const me = ++n; return () => me === n && here(); };
  }
  // 3.35: every row of a list, also past the 1000 rows the server sends at once (the list is asked for in parts).
  // make() builds the query again for each part; it must be ordered by something unique (an id last).
  async function allRows(make, part = 1000) {
    const rows = [];
    for (let from = 0; ; from += part) {
      const { data, error } = await make().range(from, from + part - 1);
      if (error) return { data: rows, error };
      rows.push(...(data || []));
      if (!data || data.length < part) return { data: rows, error: null };
    }
  }

  // ---------- scanning (the E-Portal app for Windows) ----------
  // In the Windows app every document upload gets a Scan button: it opens the Windows scanner window, where the scanner
  // of the computer (an HP printer and others) is chosen and Scan is pressed (2.2). A circle shows the scan, with
  // Cancel; when the page is in, the circle turns green with ✔. Where the upload saves at once (a signed copy, Files, a requirement on a profile …) the page is
  // saved at once and the screen shows it. In a form that is saved with its Submit button, the scanned pages are listed
  // under the upload with Preview and Delete, and are saved with the form. Photos, barcode pictures and chat files have
  // no Scan.
  const SCAN_SKIP = new Set(["scImg", "vfImg", "cvFile", "cvoFile"]);
  const SCAN_IMAGES = new Set(["sgFile", "mpSig"]); // signatures on paper are scanned too
  const scanFits = (inp) => !SCAN_SKIP.has(inp.id) && (!inp.accept || /pdf/.test(inp.accept) || SCAN_IMAGES.has(inp.id));
  // An upload marked data-save-now saves the file at once (data-save-now="preview": a preview opens first, as for a
  // signature); any other upload keeps the pages for its form, which saves them with its Submit button.
  const savesAtOnce = (inp) => inp.hasAttribute("data-save-now");
  let justSaved = null; // { el, id, hash, at }: the screen drawn again after a scanned page was saved shows ✔ Saved
  const RING = 2 * Math.PI * 17;
  const pagesText = (n) => `✔ ${n > 1 ? `${n} pages scanned` : "Scanned"} · saved with the form`;
  const kb = (n) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
  function addScanButtons(root) {
    if (!window.EOApp?.scan || !root?.querySelectorAll) return;
    for (const inp of root.querySelectorAll('input[type="file"]:not([data-scan])')) {
      inp.dataset.scan = "1";
      if (!scanFits(inp)) continue;
      const wrap = document.createElement("span");
      wrap.className = "scan-wrap" + (inp.hidden ? " for-hidden" : "");
      wrap.innerHTML = `<button type="button" class="btn scan-btn" title="Opens the Windows scanner window: choose the scanner, then press Scan there">${ic("doc")} Scan</button>
        <span class="scan-prog" role="progressbar" aria-label="Scan" aria-valuemin="0" aria-valuemax="100" hidden>
          <span class="ring"><svg viewBox="0 0 40 40" aria-hidden="true"><circle class="rb" cx="20" cy="20" r="17"/><circle class="rf" cx="20" cy="20" r="17"
            stroke-dasharray="${RING.toFixed(2)}" stroke-dashoffset="${RING.toFixed(2)}"/></svg><b class="rp">0%</b><span class="rc">${ic("check")}</span></span>
          <span class="st"></span>${window.EOApp.cancelScan ? `<button type="button" class="btn small scan-cancel">${ic("x")} Cancel</button>` : ""}</span>
        <span class="scan-ok" role="status" hidden></span>
        <span class="scan-pages" hidden></span>`;
      inp.replaceWith(wrap);
      wrap.prepend(inp);
      const ui = scanUi(inp, wrap);
      inp._eoUi = ui;
      $(".scan-btn", wrap).onclick = () => scanInto(inp, ui);
      // the same upload on the screen drawn again after its scanned page was saved (and no error came meanwhile)
      if (justSaved && justSaved.el !== inp && inp.id && justSaved.id === inp.id && justSaved.hash === location.hash && Date.now() - justSaved.at < 60000) {
        const ok = lastError < justSaved.at;
        justSaved = null;
        if (ok) ui.done("✔ Saved");
      }
      const cancel = $(".scan-cancel", wrap);
      if (cancel) cancel.onclick = () => { cancel.disabled = true; $(".st", wrap).textContent = "Cancelling…"; window.EOApp.cancelScan().catch(() => {}); };
      // a file chosen the usual way is added to the scanned pages (a single upload takes the chosen file instead)
      inp.addEventListener("change", () => {
        if (inp._eoScan || savesAtOnce(inp)) return;
        if (!inp.multiple) { ui.pages = ui.pages.filter((f) => [...inp.files].includes(f)); ui.render(); return; }
        const picked = [...inp.files], keep = ui.pages.filter((f) => !picked.includes(f));
        if (keep.length) ui.setFiles([...picked, ...keep]);
        ui.render();
      });
      inp.form?.addEventListener("reset", () => setTimeout(() => { ui.pages = []; ui.render(); }));
    }
  }
  const SCAN_UIS = new Set(); // the scan uploads with pictures of scanned pages, freed when they leave the screen
  function freeScanPictures() {
    for (const ui of SCAN_UIS) if (!ui.wrap.isConnected) { ui.free(); SCAN_UIS.delete(ui); }
  }
  function scanUi(inp, wrap) {
    const prog = $(".scan-prog", wrap), rf = $(".rf", wrap), rp = $(".rp", wrap), st = $(".st", wrap), ok = $(".scan-ok", wrap), list = $(".scan-pages", wrap);
    const urls = new Map();
    const ui = {
      pages: [], busy: false, pct: 0, wrap,
      free() { for (const u of urls.values()) URL.revokeObjectURL(u); urls.clear(); },
      // pct null: the scanner window is open (the circle turns without a number)
      show(pct, text) {
        prog.hidden = false; prog.classList.remove("done"); ok.hidden = true;
        const cancel = $(".scan-cancel", wrap);
        if (cancel && !cancel.disabled) cancel.hidden = false;
        if (pct === null || pct === undefined) { prog.classList.add("wait"); rp.textContent = ""; prog.removeAttribute("aria-valuenow"); }
        else {
          prog.classList.remove("wait");
          ui.pct = Math.max(ui.pct, Math.min(99, Math.round(pct)));
          rf.style.strokeDashoffset = (RING * (1 - ui.pct / 100)).toFixed(2);
          rp.textContent = ui.pct + "%"; prog.setAttribute("aria-valuenow", ui.pct);
        }
        if (text) st.textContent = text;
      },
      done(text) {
        prog.classList.remove("wait"); prog.classList.add("done");
        rf.style.strokeDashoffset = "0"; rp.textContent = "100%"; prog.setAttribute("aria-valuenow", 100);
        st.textContent = "";
        const cancel = $(".scan-cancel", wrap);
        if (cancel) cancel.hidden = true;
        ok.textContent = text; ok.hidden = false;
        clearTimeout(ui.fade);
        ui.fade = setTimeout(() => { if (prog.classList.contains("done")) { prog.hidden = true; prog.classList.remove("done"); ui.pct = 0; } }, 2500);
      },
      reset() {
        clearTimeout(ui.fade);
        prog.hidden = true; prog.classList.remove("wait", "done"); ui.pct = 0;
        rf.style.strokeDashoffset = RING.toFixed(2);
        const cancel = $(".scan-cancel", wrap);
        if (cancel) { cancel.disabled = false; cancel.hidden = false; }
      },
      setFiles(files) {
        const dt = new DataTransfer();
        files.forEach((f) => dt.items.add(f));
        inp._eoScan = true; inp.files = dt.files; inp._eoScan = false;
      },
      // the scanned pages kept for the form, each with Preview and Delete
      render() {
        for (const [f, u] of urls) if (!ui.pages.includes(f)) { URL.revokeObjectURL(u); urls.delete(f); }
        list.hidden = !ui.pages.length;
        if (ui.pages.length) SCAN_UIS.add(ui);
        list.innerHTML = ui.pages.map((f, i) => {
          if (!urls.has(f)) urls.set(f, URL.createObjectURL(f));
          return `<span class="scan-page"><img src="${esc(urls.get(f))}" alt=""><span class="sp-name">${ui.pages.length > 1 ? `Page ${i + 1}` : "Scanned page"}<small>${esc(kb(f.size))}</small></span>
            <button type="button" class="btn small" data-sp-view="${i}">${ic("eye")} Preview</button><button type="button" class="btn small danger" data-sp-del="${i}">${ic("trash")} Delete</button></span>`;
        }).join("");
        $$("[data-sp-view]", list).forEach((b) => (b.onclick = () => preview(ui.pages[Number(b.dataset.spView)])));
        $$("[data-sp-del]", list).forEach((b) => (b.onclick = () => remove(ui.pages[Number(b.dataset.spDel)])));
        if (!ui.pages.length) { if (!ui.busy) ui.reset(); ok.hidden = true; }
        else if (!ui.busy) { ok.textContent = pagesText(ui.pages.length); ok.hidden = false; }
      },
    };
    function preview(f) {
      if (!f) return;
      const n = ui.pages.indexOf(f) + 1;
      const m = modal(ui.pages.length > 1 ? `Scanned Page ${n}` : "Scanned Page", `<div class="viewer-body"><img src="${esc(urls.get(f) || "")}" alt="Scanned page"></div>`,
        `<button type="button" class="btn danger" data-del>${ic("trash")} Delete</button><button type="button" class="btn primary" data-x>Close</button>`, { wide: true, cls: "viewer" });
      $("[data-x]", m.el).onclick = m.close;
      $("[data-del]", m.el).onclick = async () => { m.close(); await remove(f); };
    }
    async function remove(f) {
      if (!f || !await confirmBox("Delete this scanned page? It will not be saved.", { title: "Delete Scanned Page", ok: "Delete", danger: true })) return;
      ui.pages = ui.pages.filter((x) => x !== f);
      ui.setFiles([...inp.files].filter((x) => x !== f));
      fireChange(inp);
      ui.render();
      toast("Scanned page deleted.");
    }
    return ui;
  }
  // Waits until the upload has been saved and its screen drawn again (the upload is then no longer on the page), at
  // most `ms`.
  const untilGone = (el, ms) => new Promise((resolve) => {
    const t0 = Date.now(), t = setInterval(() => { if (!el.isConnected || Date.now() - t0 > ms) { clearInterval(t); resolve(!el.isConnected); } }, 150);
  });
  const fireChange = (inp) => { inp._eoScan = true; try { inp.dispatchEvent(new Event("change", { bubbles: true })); } finally { inp._eoScan = false; } };
  async function scanInto(inp, ui) {
    if (ui.busy) return;
    ui.busy = true;
    const wrap = inp.parentNode, btn = $(".scan-btn", wrap), hash = location.hash;
    delete wrap.dataset.abandoned;
    wrap.classList.add("scanning");
    btn.disabled = true;
    ui.pct = 0;
    // 2.2: Scan always opens the Windows scanner window (the scanner is chosen there and its Scan button is pressed);
    // the circle turns while the window is open, and the page is saved by itself when it comes back.
    const onProgress = (p) => ui.show(p && typeof p.pct === "number" && p.stage !== "START" ? p.pct : null, p?.stage === "START" ? "Opening the scanner window" : p?.text);
    ui.show(null, "Opening the scanner window");
    try {
      const r = await window.EOApp.scan({ dialog: true }, onProgress);
      if (r?.cancelled) { ui.reset(); if (!r.quiet) toast("Scan cancelled."); return; }
      if (!r?.ok) { ui.reset(); toast(r?.error || "The scan did not work.", true); return; }
      // 3.0: the scanned page is turned into a file by the browser itself (no per-character loop on megabytes)
      const bytes = await (await fetch(`data:${r.type || "image/jpeg"};base64,${r.data}`)).blob();
      const file = new File([bytes], r.name || `Scan_${Date.now()}.jpg`, { type: r.type || "image/jpeg" });
      if (wrap.dataset.abandoned) return toast("The scanned page was left out (the form was saved without it).", true);
      if (!inp.isConnected && location.hash === hash && inp.id) {
        // the same screen was drawn again during the scan (another upload was saved): the page goes to the new upload
        const again = await redrawn(inp.id, hash);
        if (again) { ui.busy = false; return await deliver(again, again._eoUi, file); }
      }
      if (!inp.isConnected || location.hash !== hash) return toast("The page was scanned, but this screen was closed. Open it again and scan the page there.", true);
      await deliver(inp, ui, file);
    } catch (e) {
      ui.reset();
      toast("The scan did not work: " + (e?.message || e), true);
    } finally {
      ui.busy = false;
      wrap.classList.remove("scanning");
      if (btn.isConnected) btn.disabled = false;
    }
  }
  // The upload with this id once the screen has been drawn again (at most 8 seconds).
  const redrawn = (id, hash) => new Promise((resolve) => {
    const t0 = Date.now(), t = setInterval(() => {
      const el = document.getElementById(id);
      if (el && el._eoUi && location.hash === hash) { clearInterval(t); resolve(el); }
      else if (Date.now() - t0 > 8000 || location.hash !== hash) { clearInterval(t); resolve(null); }
    }, 150);
  });
  // The scanned page into its upload: saved at once, a signature preview, or kept for the form.
  async function deliver(inp, ui, file) {
    const wrap = inp.parentNode, hash = location.hash, btn = $(".scan-btn", wrap);
    ui.busy = true;
    btn.disabled = true; // no second page into this upload while this one is saved
    try {
      if (inp.dataset.saveNow === "preview") {
        // a signature: its preview opens, where it is saved
        ui.setFiles([file]); ui.done("✔ Scanned");
        fireChange(inp);
      } else if (savesAtOnce(inp)) {
        // saved at once: the circle waits for the save; the screen drawn again shows the new file and ✔ Saved
        ui.setFiles([file]);
        ui.show(97, "Saving the page");
        $(".scan-cancel", wrap)?.setAttribute("hidden", "");
        justSaved = { el: inp, id: inp.id, hash, at: Date.now() };
        fireChange(inp);
        if (!await untilGone(inp, 60000)) { if (justSaved?.el === inp) justSaved = null; ui.done("✔ Scanned"); }
      } else {
        ui.pages = inp.multiple ? [...ui.pages, file] : [file];
        ui.setFiles(inp.multiple ? [...inp.files, file] : [file]);
        ui.done(pagesText(ui.pages.length));
        ui.render();
        fireChange(inp);
      }
    } finally {
      ui.busy = false;
      if (btn.isConnected) btn.disabled = false;
    }
  }
  // A form or a dialog is not saved while one of its pages is still being scanned (the page would be left out). With
  // the app for Windows 1.4 (no Cancel) the person may save without that page.
  async function scanGuard(e, area, again) {
    const w = area?.querySelector?.(".scan-wrap.scanning");
    if (!w) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (window.EOApp?.cancelScan) return toast("Wait until the scan has finished (or press Cancel on it), then save.", true);
    if (await confirmBox("A page is still being scanned. Save without that page?", { title: "Scan", ok: "Save Without It" })) {
      w.dataset.abandoned = "1"; w.classList.remove("scanning");
      again();
    }
  }
  document.addEventListener("submit", (e) => scanGuard(e, e.target, () => e.target.requestSubmit()), true);
  // 3.20: what is typed is written in CAPITAL letters (as on the printed documents), except where the exact letters matter:
  // e-mail, web links, user names, passwords and one-time codes (or a field marked data-case="keep")
  const KEEP_AUTO = ["username", "email", "url", "one-time-code", "current-password", "new-password"];
  const keepCase = (el) => el.dataset.case === "keep" || el.getAttribute("autocapitalize") === "none" || ["email", "url"].includes(el.inputMode)
    || KEEP_AUTO.some((k) => (el.getAttribute("autocomplete") || "").split(/\s+/).includes(k));
  const toCaps = (el) => {
    if (!(el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && ["text", "search"].includes(el.type))) || keepCase(el)) return;
    const up = el.value.toUpperCase(); if (up === el.value) return;
    const s = el.selectionStart, f = el.selectionEnd; el.value = up;
    try { if (s != null) el.setSelectionRange(s, f); } catch { /* not every field keeps a cursor */ }
  };
  document.addEventListener("input", (e) => { if (!e.isComposing) toCaps(e.target); }, true);
  document.addEventListener("compositionend", (e) => toCaps(e.target), true);
  document.addEventListener("click", (e) => {
    const b = e.target.closest?.("[data-ok], button[type=submit]");
    if (!b || (b.type === "submit" && b.form)) return; // a form's own Submit is checked when the form is sent
    scanGuard(e, b.closest(".modal, form, .window"), () => b.click());
  }, true);
  if (window.EOApp?.scan) {
    new MutationObserver((list) => {
      for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) addScanButtons(n.matches('input[type="file"]') ? n.parentNode : n);
      if (SCAN_UIS.size) freeScanPictures();
    })
      .observe(document.body, { childList: true, subtree: true });
    addScanButtons(document.body);
  }


  // ---------- report preview window ----------
  // size: "" (A4 portrait), "landscape" (A4 landscape) or "a5l" (A5 landscape slip).
  function openPreview(title, pages, opts = {}) {
    // the barcodes are drawn first: a print made while the barcode maker was still loading opens when it is there
    if (!window.bwipjs) { need("bwip").then(() => openPreview(title, pages, opts), (e) => toast(e.message, true)); return; }
    pages = pages.map(fillCodes);
    const { landscape = false, size = "", undated = false, bare = false, onePage = false } = opts; // bare: only the page itself (no date, no website footer, no page number)
    closePreview();
    const cls = size ? " " + size : landscape ? " landscape" : "";
    // Every printed page shows the date it was printed (report listings and statements already carry their own);
    // a blank form (undated) does not.
    const printed = dateTime(new Date().toISOString());
    const dated = (p) => (undated || /Date Printed|rp-stamp|Printed \d/.test(p) ? "" : `<div class="pg-date">Date Printed: ${esc(printed)}</div>`);
    // and ends with the QR of the website (scan it to open the website)
    const qr = websiteQr(), site = String(C.company.website || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
    // 2.7: an official foot line on every page: issued through the E-Portal, with the website QR
    const web = qr ? `<div class="pg-web"><span class="pg-off">Official document issued through the <b>${esc(APP)}</b><br>Every record can be checked online at ${esc(site)}</span><span>Scan to visit<br><b>${esc(site)}</b></span><img src="${qr}" alt="QR code: ${esc(site)}"></div>` : "";
    S.docTitle = document.title;
    document.title = title; // "Save as PDF" uses this as the file name
    const pv = document.createElement("div");
    pv.className = "preview";
    pv.innerHTML = `
      <div class="pv-title">Preview — ${esc(title)}</div>
      <div class="pv-tools">
        <button type="button" class="btn primary" id="pvPrint">${ic("print")} Print / Save PDF</button>
        <label for="pvZoom">Zoom</label>
        <select id="pvZoom" style="width:auto"><option value="fit">Fit</option><option>50</option><option>75</option><option selected>100</option><option>125</option><option>150</option></select>
        <button type="button" class="btn" id="pvClose">Close</button>
      </div>
      <div class="pv-desk" id="pvDesk">${pages.map((p, i) => (bare ? `<div class="page${cls} bare">${p}</div>` : `<div class="page${cls}">${dated(p)}${onePage ? `<div class="pg-fit">${p}</div>` : p}${web}<div class="pg-num">PAGE ${i + 1} OF ${pages.length}</div></div>`)).join("")}</div>
      <div class="statusbar"><span id="pvCur">Current Page No: 1</span><span>Total Page No: ${pages.length}</span><span id="pvZf">Zoom Factor: 100%</span></div>`;
    document.body.appendChild(pv);
    // 3.0: no watermark (company seal) on printed pages
    document.body.classList.toggle("print-a5l", size === "a5l");
    const desk = $("#pvDesk", pv);
    $("#pvPrint", pv).onclick = () => window.print();
    $("#pvClose", pv).onclick = closePreview;
    // 3.29: every document keeps its A4 layout; on a screen narrower than the page (a phone), Fit shows the whole A4
    // page as it prints. The print itself is always 100%.
    const zoomTo = (v) => {
      let k = v / 100;
      if (v === "fit") { desk.style.zoom = ""; k = Math.min(1, (pv.clientWidth - 32) / ($(".page", desk)?.offsetWidth || 794)); }
      desk.style.zoom = k; $("#pvZf", pv).textContent = `Zoom Factor: ${Math.round(k * 100)}%`;
    };
    const zs = $("#pvZoom", pv);
    if (($(".page", desk)?.offsetWidth || 0) > pv.clientWidth - 32) zs.value = "fit";
    zs.onchange = () => zoomTo(zs.value);
    zoomTo(zs.value);
    pvFit = () => { if (zs.value === "fit") zoomTo("fit"); };
    window.addEventListener("resize", pvFit);
    // 3.29.1: onePage: a page whose content is longer than one A4 sheet is made smaller, so it prints on one sheet.
    // Sizes are measured on the screen (all at the same preview zoom), once the fonts and pictures are in.
    if (onePage) Promise.all([document.fonts?.ready, ...$$("img", desk).map((im) => im.decode().catch(() => {}))]).then(() => $$(".page", desk).forEach((pg) => {
      const fit = $(".pg-fit", pg), foot = $(".pg-web", pg), r = (el) => el.getBoundingClientRect();
      fit.style.zoom = "";
      const mm = r(pg).width / 210; // screen pixels per millimetre
      const room = 293 * mm - (r(fit).top - r(pg).top) - (foot ? r(foot).height : 0) - 9 * mm; // 9 mm: the bottom margin
      if (r(fit).height > room) fit.style.zoom = Math.max(0.6, room / r(fit).height).toFixed(3);
    }));
    desk.onscroll = () => {
      const pg = $$(".page", desk); let cur = 1;
      pg.forEach((p, i) => { if (p.offsetTop - desk.scrollTop < desk.clientHeight / 2) cur = i + 1; });
      $("#pvCur", pv).textContent = `Current Page No: ${cur}`;
    };
    document.addEventListener("keydown", escClose);
  }
  function escClose(e) { if (e.key === "Escape" && !$(".modal")) closePreview(); }
  let pvFit = null; // the open preview fits its page to the screen again when the phone is turned
  function closePreview() {
    const open = $$(".preview");
    if (!open.length) return;
    open.forEach((p) => p.remove());
    document.removeEventListener("keydown", escClose);
    if (pvFit) { window.removeEventListener("resize", pvFit); pvFit = null; }
    document.body.classList.remove("print-a5l");
    document.title = S.docTitle || APP;
  }

  // AutoCount-style listing: stamp, title, range, company line with Page X of Y, rows, then summary, End of Report and criteria.
  // logo: the company logo, name and address head every page.
  function listingPages({ title, range, cols, rows, summary, criteria, perPage = 28, logo = false }) {
    const now = stamp();
    const stampHtml = `<div class="rp-stamp">Date : ${now}<br>User ID : ${esc((S.profile?.full_name || "").toUpperCase())}</div>`;
    const top = logo
      ? `<div class="rp-brand">${logoHtml("ph-logo")}<div><div class="ph-co">${esc(C.company.name)}</div><div class="ph-addr">${esc(C.company.address.join(", "))}<br>${esc(C.company.email)}${siteText()}</div></div>${stampHtml}</div>`
      : stampHtml;
    const chunks = [];
    for (let i = 0; i < rows.length; i += perPage) chunks.push(rows.slice(i, i + perPage));
    if (!chunks.length) chunks.push([]);
    const head = `<tr>${cols.map((c) => `<th class="${c.num ? "num" : ""}">${esc(c.label)}</th>`).join("")}</tr>`;
    return chunks.map((chunk, pi) => {
      const last = pi === chunks.length - 1;
      const body = chunk.length
        ? chunk.map((r) => r.__sub
          ? `<tr class="sub"><td colspan="${cols.length - 1}" class="num">${esc(r.__sub)}</td><td class="num">${esc(r.__val)}</td></tr>`
          : `<tr>${cols.map((c) => `<td class="${c.num ? "num" : ""}">${c.html ? c.html(r) : esc(c.get(r))}</td>`).join("")}</tr>`).join("")
        : `<tr><td colspan="${cols.length}" style="padding:16px 3px">No records in this range.</td></tr>`;
      return `
        ${top}
        <div class="rp-title">${esc(title)}</div>
        <div class="rp-range">${range}</div>
        <div class="rp-co"><span>${logo ? "" : `${esc(C.company.name)} — ${esc(C.company.address.join(", "))}`}</span><span>Page ${pi + 1} of ${chunks.length}</span></div>
        <table class="rp"><thead>${head}</thead><tbody>${body}</tbody></table>
        ${last ? `
          <div class="rp-double"></div>
          ${summary ? `<div class="rp-sum-title">${esc(summary.title)}</div>
          <table class="rp sum"><thead><tr>${summary.cols.map((c, i) => `<th class="${i ? "num" : ""}">${esc(c)}</th>`).join("")}</tr></thead>
          <tbody>${summary.rows.map((r) => `<tr>${r.map((v, i) => `<td class="${i ? "num" : ""}">${esc(v)}</td>`).join("")}</tr>`).join("")}
          <tr class="sub">${summary.total.map((v, i) => `<td class="${i ? "num" : ""}">${esc(v)}</td>`).join("")}</tr></tbody></table>` : ""}
          <div class="rp-end">End of Report</div>
          ${criteria ? `<div class="rp-crit"><b>REPORT</b>\n${esc(criteria)}</div>` : ""}` : ""}
        <div class="rp-foot"><span>${esc(APP)}</span><span>Printed ${now}</span></div>`;
    });
  }

  // ---------- Download forms ----------
  async function viewForms() {
    shell("forms", "Download Forms", `
      ${isAdmin() ? `<form class="options" id="fmForm"><fieldset class="opt" style="flex:1 1 100%"><legend>Upload New Form (Director)</legend>
        <div class="formgrid"><div class="fields wide">
          <label for="fmTitle">Title</label><input type="text" id="fmTitle" required placeholder="e.g. Leave Application Form">
          <label for="fmCat">Category</label><input type="text" id="fmCat" list="fmCats" value="General">
        </div><div class="fields wide"><label for="fmFile">File</label><input type="file" id="fmFile" required></div></div>
        <datalist id="fmCats"><option>General</option><option>HR</option><option>Accounts</option><option>Sales</option><option>Purchasing</option></datalist>
        <div class="btnrow"><button class="btn primary" type="submit">Upload Form</button></div></fieldset></form>` : ""}
      <div class="window fm-built"><div class="wtitle">Forms of the E-Portal</div><div class="wbody">
        <div class="doccard"><div class="dc-ic">${ic("doc")}</div>
          <div class="dc-main"><b>SIGNATURE VERIFICATION FORM</b><small>A4 form to collect a person's signature: boxes for three specimen signatures and the initials, and the Director's approval</small></div>
          <div class="dc-act"><a class="btn primary" id="fmSvfPdf" href="forms/EMON-OVERRUNS-Signature-Verification-Form.pdf" download="EMON-OVERRUNS-Signature-Verification-Form.pdf">${ic("download")} Download PDF</a>
            <button type="button" class="btn" id="fmSvfPrint">${ic("print")} Print</button></div></div>
        <div class="doccard"><div class="dc-ic">${ic("doc")}</div>
          <div class="dc-main"><b>EMPLOYEE JOB APPLICATION FORM</b><small>Empty A4 form for a new employee to fill in by hand: photo, address, emergency contact, personal information, work experience, position and signatures</small></div>
          <div class="dc-act"><button type="button" class="btn primary" id="fmJaPrint">${ic("print")} Print / Download PDF</button></div></div>
        <div class="doccard"><div class="dc-ic">${ic("doc")}</div>
          <div class="dc-main"><b>QC TEST FORM</b><small>Plain A4 form to check the goods by hand (no barcode): goods, Qty by color, the 10 checks, result, notes and a box for the result sticker</small></div>
          <div class="dc-act"><button type="button" class="btn primary" id="fmQcPrint">${ic("print")} Print / Download PDF</button></div></div></div></div>
      <div id="fmList">${busy()}</div>`, "Blank company forms. Press <b>Download</b> to save a copy.");
    $("#fmSvfPrint").onclick = () => window.EO.openBlankSignatureForm();
    $("#fmJaPrint").onclick = () => window.EO.printBlankJobApp(); // 3.24
    $("#fmQcPrint").onclick = () => window.EO.printBlankQc(); // 3.33
    const fresh = loadGuard();
    const load = async () => {
      const ok = fresh();
      const { data, error } = await sb.from("forms").select("*").order("category").order("title");
      if (!ok()) return;
      if (error) return fail(error, "Could not load forms");
      const rows = data || [];
      const cols = [
        { label: "Title", get: (r) => r.title }, { label: "Category", get: (r) => r.category }, { label: "File", get: (r) => r.file_name },
        { label: "Downloads", num: true, get: (r) => r.downloads }, { label: "Uploaded", get: (r) => mdy(r.created_at) },
        { label: "", html: (r) => `<button type="button" class="btn" data-dl="${r.id}">${ic("download")} Download</button>${isAdmin() ? ` <button type="button" class="btn danger" data-rm="${r.id}">Remove</button>` : ""}` }
      ];
      $("#fmList").innerHTML = grid({ cols, rows, group: (r) => r.category, empty: isAdmin() ? "No forms yet. Upload the first one above." : "No forms have been posted yet." });
      $$("[data-dl]").forEach((b) => (b.onclick = async () => {
        const f = rows.find((r) => r.id === b.dataset.dl);
        const { data: s, error: e2 } = await sb.storage.from("forms").createSignedUrl(f.storage_path, 120, { download: f.file_name });
        if (e2) return fail(e2, "Could not prepare the download");
        sb.rpc("count_form_download", { p_id: f.id }).then(() => {}, () => {});
        const a = document.createElement("a"); a.href = s.signedUrl; a.rel = "noopener"; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(load, 800);
      }));
      $$("[data-rm]").forEach((b) => (b.onclick = async () => {
        const f = rows.find((r) => r.id === b.dataset.rm);
        if (!(await confirmBox(`Remove the form <b>${esc(f.title)}</b>?`, { ok: "Remove", danger: true }))) return;
        await sb.storage.from("forms").remove([f.storage_path]);
        const { error: e2 } = await sb.from("forms").delete().eq("id", f.id);
        if (e2) return fail(e2, "Could not remove the form");
        toast(`Removed ${f.title}.`); load();
      }));
      setRecords(`Forms: ${rows.length}`);
    };
    if ($("#fmForm")) $("#fmForm").onsubmit = async (e) => {
      e.preventDefault();
      const title = $("#fmTitle").value.trim(), category = $("#fmCat").value.trim() || "General";
      if (!title || !$("#fmFile").files[0]) return toast("Enter a title and choose a file.", true);
      setBusy(e.target, true, "Uploading"); // 3.35: before the picture is made smaller, so a second press cannot upload it twice
      try {
        const file = await slimFile($("#fmFile").files[0]);
        const path = `${Date.now()}_${file.name.replace(/[^\w.\-]+/g, "_")}`;
        const up = await sb.storage.from("forms").upload(path, file, { contentType: file.type || "application/octet-stream" });
        if (up.error) return fail(up.error, "Upload failed");
        const { error } = await sb.from("forms").insert({ title, category, storage_path: path, file_name: file.name });
        if (error) { sb.storage.from("forms").remove([path]).catch(() => {}); return fail(error, "Could not save the form"); }
        toast(`Uploaded ${title}.`); e.target.reset(); load();
      } finally { setBusy(e.target, false); }
    };
    load();
  }

  // ---------- Login accounts (admin) ----------
  async function viewUsers() {
    if (!isAdmin()) { location.hash = "dashboard"; return; }
    shell("logins", "Login Accounts", `
      <div class="options"><fieldset class="opt"><legend>Filter</legend><div class="fields">
        <label for="uStatus">Status</label><select id="uStatus"><option value="">All</option><option value="pending">Pending (applicants)</option><option value="active">Active</option><option value="disabled">Disabled</option></select>
      </div></fieldset></div>
      <div id="uList">${busy()}</div>`,
      "Everyone who signed up. New sign-ups are <b>Pending</b> applicants. When you approve their job application under <b>Employee → Job Applications</b>, they can use the portal. You can also change an access level or status here, or <b>Delete</b> an account when the person asks for it (their request arrives in <b>Contact Messages</b>).");
    const fresh = loadGuard();
    const load = async () => {
      const ok = fresh();
      let q = sb.from("profiles").select("*").order("created_at", { ascending: false });
      if ($("#uStatus").value) q = q.eq("status", $("#uStatus").value);
      const [{ data, error }, { data: emps }] = await Promise.all([q, sb.from("employees").select("profile_id, position, employee_no, phone").not("profile_id", "is", null)]);
      if (!ok()) return;
      const posOf = new Map((emps || []).map((e) => [e.profile_id, e.position]));
      const empOf = new Map((emps || []).map((e) => [e.profile_id, e]));
      if (error) return fail(error, "Could not load users");
      const rows = data || [];
      const me = S.profile.id;
      const gone = (r) => r.full_name === "Deleted User" && !r.email; // an account deleted in 2.4 that kept records still name
      const sel = (id, field, val, opts, label = (o) => o) => `<select data-u="${id}" data-f="${field}" ${id === me ? "disabled" : ""} style="width:auto">${opts.map((o) => `<option value="${o}" ${o === val ? "selected" : ""}>${esc(label(o))}</option>`).join("")}</select>`;
      const cols = [
        { label: "Name", get: (r) => r.full_name || "" }, { label: "Username", get: (r) => r.username ? "@" + r.username : "" }, { label: "Email", get: (r) => r.email || "" },
        { label: "Position", get: (r) => personTitle(r.role, posOf.get(r.id)) },
        { label: "Access Level", html: (r) => sel(r.id, "role", r.role, ["admin", "staff", "viewer"], roleName) },
        { label: "Status", html: (r) => sel(r.id, "status", r.status, ["pending", "active", "disabled"], (o) => o[0].toUpperCase() + o.slice(1)) + " " + pill(r.status) },
        { label: "Last Seen", html: (r) => r.status === "active" && online(r.last_seen_at) ? `<span class="dot-on"></span> Active now` : esc(r.last_seen_at ? timeAgo(r.last_seen_at) : "—") },
        { label: "Joined", get: (r) => mdy(r.created_at) },
        { label: "Signature", html: (r) => `<button type="button" class="btn small" data-sig="${r.id}">${ic("edit")} ${r.signature_path ? "Signature" : "Add"}</button> ${r.signature_path ? window.EO.sigPill(r.signature_status) : ""}` },
        { label: "", html: (r) => r.id === me ? "<small>You</small>" : gone(r) ? "<small>Deleted</small>"
          : `<button type="button" class="btn primary" data-save="${r.id}">Save</button> <button type="button" class="btn danger" data-del="${r.id}" title="Delete this account">${ic("trash")} Delete</button>` }
      ];
      const waiting = rows.filter((r) => r.signature_status === "pending");
      $("#uList").innerHTML = `${waiting.length ? `<div class="banner warn">${waiting.length} signature(s) waiting for your approval: ${waiting.map((r) => esc(r.full_name || r.email)).join(", ")}. Press <b>Signature</b> to approve.</div>` : ""}${grid({ cols, rows })}`;
      $$("[data-sig]").forEach((b) => (b.onclick = () => signatureDialog(rows.find((r) => r.id === b.dataset.sig), empOf.get(b.dataset.sig), load)));
      $$("[data-save]").forEach((b) => (b.onclick = async () => {
        const id = b.dataset.save;
        const patch = {}; $$(`select[data-u="${id}"]`).forEach((s) => (patch[s.dataset.f] = s.value));
        const { error: e2 } = await sb.from("profiles").update(patch).eq("id", id);
        if (e2) return fail(e2, "Could not save the user");
        toast("User saved."); load();
      }));
      // 2.4: delete an account (when the person asks for it: Request Account Deletion arrives in Contact Messages)
      $$("[data-del]").forEach((b) => (b.onclick = async () => {
        const u = rows.find((r) => r.id === b.dataset.del);
        if (!(await confirmBox(`Delete the account of <b>${esc(u.full_name || u.email)}</b>?<br><br>Their login, name, photo, signature, chat messages, community posts and a job application that was not approved are deleted. Records the business keeps (invoices, receipts, payslips, order letters) stay and show <b>Deleted User</b>. This cannot be undone.`, { title: "Delete Account", ok: "Delete Account", danger: true }))) return;
        b.disabled = true;
        const { data, error: e3 } = await sb.rpc("delete_user_account", { p_id: u.id });
        if (e3) {
          b.disabled = false;
          // the database update 2.4 (017_play_store.sql) is not on the server yet
          if (e3.code === "PGRST202") return toast("Deleting accounts needs database update 2.4 first (017_play_store.sql in the Supabase SQL Editor).", true);
          return fail(e3, "Could not delete the account");
        }
        // the stored files of the account
        if (data?.avatars?.length) await sb.storage.from("avatars").remove(data.avatars);
        if (data?.records?.length) await sb.storage.from("records").remove(data.records);
        toast(data?.result === "deleted" ? "Account deleted." : "Account deleted. The records the business keeps now show Deleted User.");
        load();
      }));
      setRecords(`Users: ${rows.length} · Pending: ${rows.filter((r) => r.status === "pending").length}`);
    };
    $("#uStatus").onchange = load;
    load();
  }
  // A person's signature (Director): see it, approve or reject it, take it off, upload it for them (approved at once),
  // or print their Signature Verification Form.
  async function signatureDialog(u, emp, reload) {
    const X = window.EO, pic = await X.signaturePic(u.signature_path);
    const st = u.signature_status;
    const m = modal(`Signature — ${u.full_name || u.email}`, `
      ${pic ? `<div class="sig-check"><img src="${esc(pic)}" alt="Signature"></div><p>${X.sigPill(st)} ${u.signature_at ? `<small>uploaded on ${mdy(u.signature_at)}</small>` : ""}</p>` : `<p><b>No signature yet.</b> ${esc(u.full_name || "")} can upload it in My Profile, or you can upload it here (approved at once).</p>`}
      ${st === "rejected" && u.signature_note ? `<div class="hint err">Not approved: ${esc(u.signature_note)}</div>` : ""}
      ${st === "pending" ? `<label class="fl" for="sgNote">Note (needed to reject)</label><input type="text" id="sgNote" placeholder="e.g. Too light, sign again with dark ink">` : ""}`,
      `${st === "pending" ? `<button type="button" class="btn ok" data-a="approve">${ic("check")} Approve</button><button type="button" class="btn danger" data-a="reject">Reject</button>` : ""}
       <label class="btn" for="sgFile">${ic("upload")} ${pic ? "Upload New" : "Upload Signature"}</label><input type="file" id="sgFile" accept="image/*" hidden data-save-now="preview">
       ${u.signature_path ? `<button type="button" class="btn" data-form>${ic("print")} Form</button><button type="button" class="btn danger" data-a="remove">Remove</button>` : ""}
       <button type="button" class="btn" data-x>Close</button>`);
    $("[data-x]", m.el).onclick = m.close;
    const act = async (a, path = null) => {
      const note = $("#sgNote", m.el)?.value.trim() || null;
      if (a === "remove" && !(await confirmBox(`Remove the signature of <b>${esc(u.full_name || "")}</b>?`, { ok: "Remove", danger: true }))) return false;
      const { error } = await sb.rpc("signature_action", { p_user: u.id, p_action: a, p_note: note, p_path: path });
      if (error) { fail(error, "Could not update the signature"); return false; }
      await X.loadSignatures(true);
      toast({ approve: "Signature approved. Their Signature Verification Form now carries your signature.", reject: "Signature not approved. They are told why.", remove: "Signature removed.", upload: "Signature saved and approved." }[a]);
      m.close(); reload(); return true;
    };
    $$("[data-a]", m.el).forEach((b) => (b.onclick = () => act(b.dataset.a)));
    if ($("[data-form]", m.el)) $("[data-form]", m.el).onclick = () => { m.close(); X.openSignatureForm(u, emp); };
    X.pickSignature($("#sgFile", m.el), u.id, `Signature — ${u.full_name || u.email}`, (path) => act("upload", path));
  }

  // ---------- router ----------
  const BUILTIN = { forms: viewForms, logins: viewUsers };
  // 2.9: each page is remembered as it was left (scroll, what was typed or chosen, the open tab). Back slides the page
  // in from the left (iOS) and puts it back as it was; a new page slides in from the right.
  let navDir = "fwd", shownHash = null;
  const trail = [], pageMemo = new Map();
  const NO_RESTORE = new Set(["rvLoc", "tbQ"]);
  function memoPage() {
    const main = $("#main");
    if (!shownHash || !main) return;
    const fields = {}, tabs = {};
    // 3.0: a form that saves a record (#new…, #edit…) is not filled in again on Back: it could be saved twice
    const isForm = /^#(new|edit)/.test(shownHash);
    $$("input[id], select[id], textarea[id]", isForm ? document.createElement("div") : main).forEach((el) => {
      if (["file", "password", "hidden", "button", "submit"].includes(el.type) || NO_RESTORE.has(el.id) || el.disabled) return;
      fields[el.id] = el.type === "checkbox" || el.type === "radio" ? el.checked : el.value;
    });
    $$(".tabs[id]", main).forEach((t) => { const i = $$("button", t).findIndex((b) => b.classList.contains("on")); if (i > 0) tabs[t.id] = i; });
    pageMemo.set(shownHash, { y: window.scrollY, fields, tabs });
    if (pageMemo.size > 40) pageMemo.delete(pageMemo.keys().next().value);
  }
  function restorePage(h) {
    const m = pageMemo.get(h);
    if (!m) return;
    for (const [id, v] of Object.entries(m.fields)) {
      const el = document.getElementById(id);
      if (!el || !el.closest("#main")) continue;
      if (typeof v === "boolean") { if (el.checked !== v) { el.checked = v; el.dispatchEvent(new Event("change", { bubbles: true })); } }
      else if (el.value !== v && (el.tagName === "SELECT" ? [...el.options].some((o) => o.value === v) : true)) {
        el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    for (const [id, i] of Object.entries(m.tabs)) { const b = $$(`#${CSS.escape(id)} button`)[i]; if (b) b.click(); }
    // the list may still be loading: wait until the page is long enough, then go back to where it was
    let tries = 0;
    const go = () => {
      if (location.hash !== h) return;
      if (document.documentElement.scrollHeight - innerHeight >= m.y - 4 || tries++ > 20) window.scrollTo(0, m.y);
      else setTimeout(go, 100);
    };
    requestAnimationFrame(go);
  }
  async function route() {
    navs++;
    const h = location.hash || "#dashboard";
    const back = trail.length > 1 && trail[trail.length - 2] === h;
    if (h !== shownHash) memoPage();
    if (back) trail.pop(); else if (trail[trail.length - 1] !== h) { trail.push(h); if (trail.length > 60) trail.shift(); }
    navDir = back ? "back" : "fwd";
    await routePage();
    const again = shownHash === h;
    shownHash = h;
    if (back && !again) restorePage(h);
  }
  async function routePage() {
    justSaved = null; // a page drawn by the router (Remove, a correction, another page) is not the save's redraw
    takeLinkError();
    closePreview();
    $$(".pop").forEach((p) => (p.hidden = true));
    const [rawKey, id, extra] = (location.hash.slice(1) || "dashboard").split("/");
    if (ALIAS[rawKey]) { location.replace("#" + ALIAS[rawKey]); return; }
    const key = rawKey || "dashboard";
    const arg = id ? decodeURIComponent(id) : id;
    const V = window.EO_VIEWS || {};
    if (!S.session) {
      stopTimers();
      window.EO.closeChat?.();
      $$(".chat-panel, .eva-panel").forEach((x) => x.remove());
      if (key === "verify" && V.verify) return V.verify(arg);
      if (key === "delivery" && V.delivery) return V.delivery(arg, extra); // 3.39: Complete Delivery by the order paper, no login
      if (key === "contact" && V.contact) return V.contact();
      if (key === "careers" && V.careers) return V.careers();
      if (key === "signup") return renderLogin("signup");
      return renderLogin();
    }
    if (recovering) { recovering = false; return renderSetPassword(true); }
    if (linkError) { toast(linkError + " You are already signed in."); linkError = ""; }
    if (!S.profile) await loadProfile();
    if (!S.profile) {
      authFrame("Sign In", `<div class="wbody login-form">${brandBlock()}<p>Your profile could not be loaded. Check your internet connection and try again.</p>
        <div class="login-links"><button class="btn" id="npRetry">Try Again</button><button class="btn" id="npOut">Sign Out</button></div></div>`);
      $("#npRetry").onclick = route; $("#npOut").onclick = signOut;
      return;
    }
    if (S.profile.status === "disabled") return renderDisabled();
    if (S.profile.status !== "active") {
      if (key === "verify" && V.verify) return V.verify(arg);
      if (key === "delivery" && V.delivery) return V.delivery(arg, extra);
      if (key === "contact" && V.contact) return V.contact();
      if (key === "careers" && V.careers) return V.careers();
      return V.applicant ? V.applicant(key, arg) : renderPending();
    }
    startTimers();
    if (key === "careers") { location.replace("#" + (isAdmin() ? "positions" : "dashboard")); return; }
    if (!canOpen(key)) { location.replace("#dashboard"); return; } // 3.31: no red message (for example a page left open by the person before)
    const view = V[key] || BUILTIN[key];
    if (view) return view(arg, extra);
    return V.dashboard ? V.dashboard() : shell("dashboard", "Dashboard", "");
  }
  window.addEventListener("hashchange", route);

  // Supabase calls must not run inside the auth callback itself, so routing is deferred a tick.
  let booted = false;
  // A reset-email link arrives as #access_token=…&type=recovery; remember it before supabase-js clears the hash.
  let recovering = /type=recovery/.test(location.hash);
  // An email link that has expired or was already used arrives as #error=…&error_code=otp_expired&error_description=…;
  // keep the reason for the Sign In page and take it out of the address bar.
  let linkError = "";
  function takeLinkError() {
    const h = new URLSearchParams(location.hash.slice(1)), q = new URLSearchParams(location.search);
    const code = h.get("error_code") || q.get("error_code") || "", text = h.get("error_description") || q.get("error_description") || "";
    if (!code && !text) return;
    history.replaceState(null, "", location.pathname);
    linkError = /expired/i.test(code + " " + text) ? "This email link has expired or was already used." : `This email link did not work: ${text || code}.`;
  }
  takeLinkError();
  sb.auth.onAuthStateChange((event, session) => {
    const changedUser = (session?.user?.id || null) !== (S.session?.user?.id || null);
    S.session = session;
    if (S.resetting) return; // the reset-code form finishes and routes itself
    if (event === "PASSWORD_RECOVERY") { booted = true; S.profile = null; setTimeout(() => renderSetPassword(true), 0); return; }
    // 3.0: the first page does not wait more than a moment for the company logo (it is set as soon as it comes)
    if (!booted) { booted = true; S.profile = null; setTimeout(() => Promise.race([loadBranding(), new Promise((r) => setTimeout(r, 350))]).then(route), 0); return; }
    if (changedUser) { S.profile = null; badgeState.at = 0; pageMemo.clear(); trail.length = 0; stopTimers(); setTimeout(route, 0); }
  });

  // exposed for testing barcode round-trips
  window.EMON = { drawPdf417, drawQr, decodeCanvas, decodeImageFile, words, need };
  // shared with modules.js to modules4.js
  Object.assign(window.EO, {
    APP, VERSION, sb, S, C, esc, peso, pad, num, fullName, qtyText, bdt, verifyUrl, isoToday, isoDay, mdy, monthOf, monthText, stamp, dateTime, fixDates, timeAgo, online, $, $$,
    isAdmin, isStaff, canAI, meId, kvTable, pill, ebillStep, ebillPill, toast, fail, words, busy, ic, modal, confirmBox, setBusy,
    shell, miniShell, grid, bindGrid, hasModule, canOpen, canWrite, setRecords, openPreview, closePreview, listingPages, siteName, siteText, 
    drawPdf417, pdf417DataUrl, drawQr, qrDataUrl, decodeImageFile, slimFile, scanDialog, openScanned, isCustKey, keepTab, stillHere, loadGuard, allRows,
    roleName, personTitle, publicUrl, logoHtml, loadBranding, loadProfile, refreshBadge, refreshBadges, initials, avatarUrl, route,
    requestDeletion, TERMS, termsDue, changePassword: () => renderSetPassword(false)
  });
})();
