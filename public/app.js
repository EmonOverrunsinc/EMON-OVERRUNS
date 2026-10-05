/* EMON OVERRUNS E-PORTAL — single-page app on Supabase (version 1.1).
   Core: shared helpers, barcodes, sign-in (email or username, email codes), top bar, animated slide menu, router.
   Business screens live in modules.js, modules2.js and modules3.js and register themselves in window.EO_VIEWS. */
(function () {
  "use strict";

  const C = window.EMON_CONFIG;
  const APP = "EMON OVERRUNS E-PORTAL";
  const VERSION = "1.2";
  window.EO = window.EO || {};
  const sb = window.supabase.createClient(C.supabaseUrl, C.supabaseKey);
  const app = document.getElementById("app");
  const S = { session: null, profile: null, chart: null, lastResult: [] };

  // ---------- helpers ----------
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const peso = (n) => Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pad = (n) => String(n).padStart(2, "0");
  const isoToday = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const dmy = (iso) => { if (!iso) return ""; const [y, m, d] = String(iso).slice(0, 10).split("-"); return `${d}/${m}/${y}`; };
  const stamp = (d = new Date()) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const longDate = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "2-digit" });
  const asDate = (iso) => new Date(String(iso).slice(0, 10) + "T00:00:00");
  // 01 FEBRUARY 1994 · 04 Oct 2026 · 01-01-2026 · 4 Oct 2026, 3:15 PM
  const dLong = (iso) => iso ? asDate(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" }).toUpperCase() : "";
  const dShort = (iso) => iso ? asDate(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "";
  const dmyDash = (iso) => iso ? dmy(iso).replace(/\//g, "-") : "";
  const dateTime = (iso) => iso ? new Date(iso).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }) : "";
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const isAdmin = () => S.profile?.role === "admin";
  const isStaff = () => ["admin", "staff"].includes(S.profile?.role);
  const pill = (s) => `<span class="pill ${esc(s)}">${esc(String(s || "").replace(/_/g, " ").toUpperCase())}</span>`;
  // The top role is called CEO in the portal (stored as "admin").
  const roleName = (r) => ({ admin: "CEO", staff: "Staff", viewer: "Viewer" })[r] || r || "";
  // Seen in the last 3 minutes = active now.
  const online = (ts) => !!ts && Date.now() - new Date(ts).getTime() < 3 * 60 * 1000;
  function timeAgo(iso) {
    if (!iso) return "";
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)} day${s < 2 * 86400 ? "" : "s"} ago`;
    return dShort(iso);
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
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    out: '<path d="M14.5 4H19v16h-4.5M10 8l-4 4 4 4M6 12h10"/>',
    key: '<circle cx="8" cy="15" r="4.2"/><path d="m11 12 9-9M16.5 6.5 19 9"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 7 8.5-7"/>',
    home: '<path d="M3.5 11 12 4l8.5 7"/><path d="M6 9.5V20h12V9.5"/>',
    install: '<path d="M12 4v10m0 0-4-4m4 4 4-4"/><rect x="4" y="16" width="16" height="4" rx="1"/>'
  };
  const ic = (name, cls = "") => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ""}</svg>`;

  function toast(msg, err) {
    $$(".toast").forEach((t) => t.remove());
    const t = document.createElement("div");
    t.className = "toast" + (err ? " err" : "");
    t.setAttribute("role", err ? "alert" : "status");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 300); }, err ? 7000 : 3500);
  }
  function fail(error, what) {
    console.error(error);
    toast(`${what}: ${error?.message || error}`, true);
  }

  // A dialog window over the page. Returns { el, close }.
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

  // ---------- PDF417 and QR ----------
  function drawPdf417(canvas, text) {
    try {
      window.bwipjs.toCanvas(canvas, { bcid: "pdf417", text, scale: 2, height: 10, columns: 6, padding: 4, backgroundcolor: "FFFFFF" });
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  }
  function pdf417DataUrl(text) {
    const c = document.createElement("canvas");
    return drawPdf417(c, text) ? c.toDataURL("image/png") : "";
  }
  function decodeCanvas(canvas) {
    const Z = window.ZXing;
    const hints = new Map([[Z.DecodeHintType.TRY_HARDER, true], [Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.PDF_417, Z.BarcodeFormat.QR_CODE]]]);
    const bmp = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas)));
    const r = new Z.MultiFormatReader(); r.setHints(hints);
    return r.decode(bmp).getText();
  }
  function drawQr(canvas, text) {
    try { window.bwipjs.toCanvas(canvas, { bcid: "qrcode", text, scale: 4, padding: 2, backgroundcolor: "FFFFFF" }); return true; }
    catch (e) { console.error(e); return false; }
  }
  function qrDataUrl(text) { const c = document.createElement("canvas"); return drawQr(c, text) ? c.toDataURL("image/png") : ""; }
  // Try the image as-is and rotated, with a white quiet zone around it.
  async function decodeImageFile(file) {
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
      throw new Error("No QR code or barcode found in that image. Try a sharper, straight-on photo.");
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // ---------- company header (every page) ----------
  // Built-in company logo and seal (an uploaded logo under Company Logo replaces the built-in one).
  const DEFAULT_LOGO = "brand/logo.jpg";
  const SEAL = "brand/seal.jpg";
  // "Install App": the browser offers this event when the portal can be installed (Edge/Chrome on Windows, Android).
  let installEvt = null;
  const installed = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; $$(".install-app").forEach((b) => (b.hidden = false)); });
  window.addEventListener("appinstalled", () => { installEvt = null; $$(".install-app").forEach((b) => (b.hidden = true)); toast(`${APP} installed. Find it in the Start menu or on your home screen.`); });
  async function installApp() {
    if (installEvt) { installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; $$(".install-app").forEach((b) => (b.hidden = true)); return; }
    toast("To install: open the browser menu (⋯ or ⋮) and choose “Install EMON OVERRUNS E-PORTAL” / “Apps → Install this site as an app”.");
  }
  S.logoUrl = DEFAULT_LOGO;
  const publicUrl = (bucket, path) => path ? sb.storage.from(bucket).getPublicUrl(path).data.publicUrl : "";
  async function loadBranding() {
    try {
      const { data } = await sb.from("company_settings").select("logo_path").eq("id", 1).maybeSingle();
      S.logoUrl = data?.logo_path ? publicUrl("branding", data.logo_path) : DEFAULT_LOGO;
    } catch (_) { S.logoUrl = DEFAULT_LOGO; }
  }
  const logoHtml = (cls = "co-logo") => S.logoUrl
    ? `<img class="${cls}" src="${esc(S.logoUrl)}" alt="${esc(C.company.name)} logo">`
    : `<span class="${cls} co-logo-fallback" aria-hidden="true">EO</span>`;
  function companyHeader() {
    return `<header class="co-head">${logoHtml()}<div class="co-text">
      <b>${esc(C.company.name)} <span class="co-tag">E-PORTAL</span></b>
      <span>${esc(C.company.address.join(", "))}</span>
      <span>${esc(C.company.email)} · ${esc(C.company.phone)}</span></div></header>`;
  }

  // ---------- sign in, create account, email codes ----------
  async function loadProfile() {
    if (!S.session) { S.profile = null; return; }
    const { data, error } = await sb.from("profiles").select("*").eq("id", S.session.user.id).maybeSingle();
    if (error) fail(error, "Could not load your profile");
    S.profile = data;
  }
  const authRedirect = () => location.origin + location.pathname;
  function authFrame(title, inner) {
    closePreview();
    $$(".chat-panel, .modal").forEach((x) => x.remove());
    app.innerHTML = `${companyHeader()}
      <div class="login">
        <div class="login-card window">
          <div class="wtitle">${esc(APP)} — ${esc(title)}</div>
          ${inner}
        </div>
        <div class="login-below"><a href="#verify" class="verify-link">${ic("shield")} Verify a record — no sign-in needed</a><small>${esc(APP)} · Version ${VERSION}</small></div>
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
    </form>`);
    bindEyes();
    $(preset ? "#lgPass" : "#lgId").focus();
    $("#toSignup").onclick = () => renderSignup();
    $("#toForgot").onclick = () => renderForgot($("#lgId").value.trim());
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
      fail(/invalid login/i.test(error.message) ? "Wrong email/username or password." : error, "Sign in failed");
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
      await check();
      if (!unameOk) return toast(`The username “${username}” is not available. Choose another.`, true);
      setBusy(e.target, true, "Creating account");
      const { data, error } = await sb.auth.signUp({ email, password: p1, options: { data: { full_name, username }, emailRedirectTo: authRedirect() } });
      setBusy(e.target, false);
      if (error) return fail(error, "Could not create the account");
      // Supabase answers an already-registered email with a user that has no identities.
      if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        toast(`${email} already has an account. Sign in, or press Forgot password.`, true);
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
      ${pwField("pw1", "New Password", "new-password")}
      ${pwField("pw2", "Confirm New Password", "new-password")}
      <button class="btn primary big" type="submit">Save Password</button>
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
      const { error } = await sb.auth.updateUser({ password: p1 });
      setBusy(e.target, false);
      if (error) return fail(error, "Could not save the password");
      toast("Password saved.");
      history.replaceState(null, "", location.pathname + "#dashboard");
      route();
    };
  }

  function renderDisabled() {
    authFrame("Account Disabled", `<div class="wbody login-form">${brandBlock()}
      <div class="banner closed">This account (${esc(S.session.user.email)}) is disabled.</div>
      <p>Contact the CEO of ${esc(C.company.name)} if you think this is a mistake.</p>
      <button class="btn big" id="dsOut">Sign Out</button></div>`);
    $("#dsOut").onclick = () => sb.auth.signOut();
  }
  function renderPending() {
    authFrame("Waiting for Approval", `<div class="wbody login-form">${brandBlock()}
      <p>Signed in as <b>${esc(S.session.user.email)}</b>. Your account is waiting for the CEO.</p>
      <div class="login-links"><button class="btn" id="pRefresh">Check Again</button><button class="btn" id="pOut">Sign Out</button></div></div>`);
    $("#pRefresh").onclick = async () => { S.profile = null; route(); };
    $("#pOut").onclick = () => sb.auth.signOut();
  }

  // Simple page frame (company header + slim bar) for applicants and the public verification page.
  // home: where the E-Portal name links to (the public Verification page links back to its search).
  function miniShell(title, body, { home } = {}) {
    const signed = !!S.session;
    closePreview();
    app.innerHTML = `${companyHeader()}
      <div class="topbar mini">
        ${home ? `<a class="mini-brand" href="${esc(home)}">${ic("shield")} ${esc(APP)}</a>` : `<span class="mini-brand">${ic("shield")} ${esc(APP)}</span>`}
        <div class="tb-right">${signed
          ? `<span class="mini-user">${esc(S.profile?.full_name || S.session.user.email)}</span><button type="button" class="btn light" id="msOut">${ic("out")} Sign Out</button>`
          : `<a class="btn light" href="#dashboard">${ic("user")} Sign In</a>`}</div>
      </div>
      <div class="content mini-content"><div class="band"><h1>${esc(title)}</h1></div><main id="main">${body}</main></div>`;
    if ($("#msOut")) $("#msOut").onclick = () => sb.auth.signOut();
  }

  // ---------- shell: company header, top bar, slide-out menu ----------
  const MENU = [
    { k: "dashboard", n: "", label: "Dashboard" },
    { k: "customers", n: "1", label: "Customer" },
    { k: "invoices", n: "2", label: "Invoice" },
    { k: "payments", n: "3", label: "Payment" },
    { k: "creditmemos", n: "4", label: "Credit Memo" },
    { k: "employees", n: "5", label: "Employee" },
    { k: "community", n: "6", label: "Community" },
    { k: "projects", n: "7", label: "Project" },
    { k: "billing", n: "8", label: "Billing" },
    { k: "orders", n: "9", label: "Order Letter" }
  ];
  // Which menu item (module) each page belongs to; pages a user has no access to are blocked.
  const MODULE_OF = {
    customers: "customers", newcustomer: "customers", customer: "customers", statements: "customers",
    invoices: "invoices", newinvoice: "invoices", invoice: "invoices",
    payments: "payments", newpayment: "payments", payment: "payments",
    creditmemos: "creditmemos", newcreditmemo: "creditmemos", creditmemo: "creditmemos",
    employees: "employees", newemployee: "employees", employee: "employees", jobapps: "employees", jobapp: "employees", positions: "employees", payroll: "employees",
    projects: "projects", newproject: "projects", project: "projects",
    billing: "billing", newpaycompany: "billing", paycompany: "billing", newvoucher: "billing", voucher: "billing",
    orders: ["orders", "customers"], neworder: ["orders", "customers", "employees", "billing"], order: ["orders", "customers", "employees", "billing"]
  };
  // Admins see everything; NULL modules = all (older accounts).
  const hasModule = (m) => !m || isAdmin() || !S.profile?.modules || S.profile.modules.includes(m);
  const canOpen = (key) => { const m = MODULE_OF[key]; return Array.isArray(m) ? m.some(hasModule) : hasModule(m); };
  // Staff may add records in the sections they can open; viewers only look.
  const canWrite = (m) => isAdmin() || (isStaff() && hasModule(m));
  const OTHER = [
    ["verify", "Verification", () => true],
    ["changes", "Corrections", () => isAdmin()],
    ["logins", "User", () => isAdmin()],
    ["forms", "Download Forms", () => true]
  ];
  const ACTIVE_OF = { orders: "orders", neworder: "orders", order: "orders", payslip: "employees", find: "", profile: "", settings: "" };
  // Older addresses from version 1.0.
  const ALIAS = { users: "employees", userres: "employees", resolutions: "community", resolution: "community", verification: "verify", supplier: "billing", newsupplier: "billing", search: "dashboard" };
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

  function shell(key, title, body, hint) {
    const cur = ACTIVE_OF[key] ?? (Array.isArray(MODULE_OF[key]) ? MODULE_OF[key][0] : MODULE_OF[key]) ?? key;
    const items = MENU.filter((m) => m.k === "dashboard" || m.k === "community" || hasModule(m.k));
    const main = items.map((m, i) => `<a href="#${m.k}" style="--i:${i}" class="${m.k === cur ? "active" : ""}"><span class="num">${m.n || ic("home")}</span><span class="lbl">${esc(m.label)}</span></a>`).join("");
    const other = OTHER.filter((o) => o[2]()).map(([k, label], j) => `<a href="#${k}" style="--i:${items.length + j + 1}" class="sub ${k === cur ? "active" : ""}"><span class="lbl">${esc(label)}</span></a>`).join("");
    const av = avatarUrl();
    const who = S.profile.full_name || S.session.user.email;
    app.innerHTML = `
      ${companyHeader()}
      <div class="topbar" id="topbar">
        <button type="button" class="iconbtn burger" id="tbMenu" aria-label="Menu" aria-controls="drawer" aria-expanded="false"><span></span><span></span><span></span></button>
        <form class="tb-search" id="tbSearch" role="search">
          <span class="tb-sic">${ic("search")}</span>
          <input type="search" id="tbQ" placeholder="Search name, account, invoice, receipt…" aria-label="Search records" autocomplete="off">
          <span class="spin sm" id="tbSpin" hidden></span>
          <button type="button" class="scanbtn" id="tbScan" title="Scan a QR code or barcode">${ic("scan")}<span>Scan</span></button>
        </form>
        <div class="tb-right">
          <button type="button" class="iconbtn install-app" id="tbInstall" title="Install the E-Portal as an app" ${installEvt ? "" : "hidden"}>${ic("install")}<span class="tb-install-txt">Install App</span></button>
          <button type="button" class="iconbtn" id="tbChat" aria-label="Messages" title="Messages">${ic("chat")}<span class="badge" id="tbChatBadge" hidden>0</span></button>
          <button type="button" class="iconbtn" id="tbBell" aria-label="Notifications" title="Notifications" aria-haspopup="true">${ic("bell")}<span class="badge" id="tbBadge" hidden>0</span></button>
          <button type="button" class="avatar-btn" id="tbUser" aria-haspopup="true" aria-label="Your account">
            ${av ? `<img src="${esc(av)}" alt="">` : `<span>${esc(initials(who))}</span>`}
          </button>
        </div>
        <div class="pop" id="mailPop" hidden><div class="pop-head">Notifications</div><div id="mailList">${busy()}</div></div>
        <div class="pop" id="userPop" hidden>
          <div class="pop-head">${esc(S.profile.full_name || "")}<small>${S.profile.username ? "@" + esc(S.profile.username) + " · " : ""}${esc(S.session.user.email)} · ${esc(roleName(S.profile.role).toUpperCase())}</small></div>
          <a href="#profile">${ic("user")} My Profile</a>
          <button type="button" id="chPw">${ic("key")} Change Password</button>
          ${installed() ? "" : `<button type="button" id="upInstall">${ic("install")} Install as App</button>`}
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
        <div class="content">
          <div class="band"><h1>${esc(title)}</h1><span class="help" title="${esc(hint ? hint.replace(/<[^>]+>/g, "") : title)}">?</span></div>
          <main id="main">${hint ? `<div class="hint"><b>Hint:</b> ${hint}</div>` : ""}${body}</main>
        </div>
      </div>
      <div class="statusbar"><span>User: ${esc(who)}</span><span id="sbRecords">Records: –</span><span>Currency: PHP (₱)</span></div>`;
    let saved = null; try { saved = localStorage.getItem("eoDrawer"); } catch (_) {}
    document.body.classList.add("no-anim");
    drawerOpen(isPhone() ? false : saved !== "0");
    requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove("no-anim")));
    bindSwipe();
    $("#tbMenu").onclick = () => drawerOpen(!document.body.classList.contains("drawer-open"));
    $("#scrim").onclick = () => drawerOpen(false);
    $$("#drawer a").forEach((a) => (a.onclick = () => { if (isPhone()) drawerOpen(false); }));
    $("#signOut").onclick = () => sb.auth.signOut();
    $("#chPw").onclick = () => renderSetPassword(false);
    $("#tbInstall").onclick = installApp;
    if ($("#upInstall")) $("#upInstall").onclick = installApp;
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
  function scanDialog(onText, { title = "Scan QR Code / Barcode", hint = "Point the camera at the QR code or barcode." } = {}) {
    let reader = null, done = false;
    const m = modal(title, `<div class="scan-view"><video id="scVideo" playsinline muted></video><div class="scan-frame"><i></i></div></div>
      <div id="scMsg" class="scan-msg">${esc(hint)}</div>`,
      `<label class="btn" for="scImg">${ic("image")} Use a Photo</label><input type="file" id="scImg" accept="image/*" hidden><button type="button" class="btn" data-close>Close</button>`,
      { cls: "scan-modal", onClose: () => { try { reader?.reset(); } catch (_) {} } });
    const d = m.el;
    const msg = (t) => { const el = $("#scMsg", d); if (el) el.textContent = t; };
    const finish = (text) => { if (done) return; done = true; m.close(); onText(text); };
    $("[data-close]", d).onclick = m.close;
    $("#scImg", d).onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      msg("Reading the photo…");
      try { finish(await decodeImageFile(f)); }
      catch (err) { msg(err.message); }
      e.target.value = "";
    };
    if (navigator.mediaDevices?.getUserMedia) {
      const Z = window.ZXing;
      const hints = new Map([[Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.QR_CODE, Z.BarcodeFormat.PDF_417]]]);
      reader = new Z.BrowserMultiFormatReader(hints);
      reader.decodeFromVideoDevice(undefined, $("#scVideo", d), (res) => { if (res) finish(res.getText()); })
        .catch(() => { d.classList.add("nocam"); msg("Camera is not available. Use a photo instead."); });
    } else { d.classList.add("nocam"); msg("Camera is not available here. Use a photo instead."); }
  }
  // Customer QR: EMONCUST|<public id>|<account no>.
  // Document barcodes (EMONINV|…, EMONPAY|…, EMONBD|…, EMONORDER|…) and verification links open the Verification page.
  async function openScanned(text) {
    const t = String(text || "").trim();
    if (!t) return;
    if (/#verify\//i.test(t)) { location.hash = "verify/" + encodeURIComponent(t.replace(/^.*#verify\//i, "")); return; }
    if (t.startsWith("EMONCUST|")) {
      const pid = t.split("|")[1];
      const { data } = await sb.from("customers").select("id").eq("public_id", pid).maybeSingle();
      if (data && canOpen("customer")) { location.hash = "customer/" + data.id; return; }
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

  // ---------- report preview window ----------
  // size: "" (A4 portrait), "landscape" (A4 landscape) or "a5l" (A5 landscape slip).
  function openPreview(title, pages, { landscape = false, size = "" } = {}) {
    closePreview();
    const cls = size ? " " + size : landscape ? " landscape" : "";
    S.docTitle = document.title;
    document.title = title; // "Save as PDF" uses this as the file name
    const pv = document.createElement("div");
    pv.className = "preview";
    pv.innerHTML = `
      <div class="pv-title">Preview — ${esc(title)}</div>
      <div class="pv-tools">
        <button type="button" class="btn primary" id="pvPrint">${ic("print")} Print / Save PDF</button>
        <label for="pvZoom">Zoom</label>
        <select id="pvZoom" style="width:auto"><option>50</option><option>75</option><option selected>100</option><option>125</option><option>150</option></select>
        <button type="button" class="btn" id="pvClose">Close</button>
      </div>
      <div class="pv-desk" id="pvDesk">${pages.map((p) => `<div class="page${cls}"><img class="wm" src="${SEAL}" alt="">${p}</div>`).join("")}</div>
      <div class="statusbar"><span id="pvCur">Current Page No: 1</span><span>Total Page No: ${pages.length}</span><span id="pvZf">Zoom Factor: 100%</span></div>`;
    document.body.appendChild(pv);
    document.body.classList.toggle("print-a5l", size === "a5l");
    const desk = $("#pvDesk", pv);
    $("#pvPrint", pv).onclick = () => window.print();
    $("#pvClose", pv).onclick = closePreview;
    $("#pvZoom", pv).onchange = (e) => { desk.style.zoom = e.target.value / 100; $("#pvZf", pv).textContent = `Zoom Factor: ${e.target.value}%`; };
    desk.onscroll = () => {
      const pg = $$(".page", desk); let cur = 1;
      pg.forEach((p, i) => { if (p.offsetTop - desk.scrollTop < desk.clientHeight / 2) cur = i + 1; });
      $("#pvCur", pv).textContent = `Current Page No: ${cur}`;
    };
    document.addEventListener("keydown", escClose);
  }
  function escClose(e) { if (e.key === "Escape" && !$(".modal")) closePreview(); }
  function closePreview() {
    const open = $$(".preview");
    if (!open.length) return;
    open.forEach((p) => p.remove());
    document.removeEventListener("keydown", escClose);
    document.body.classList.remove("print-a5l");
    document.title = S.docTitle || APP;
  }

  // AutoCount-style listing: stamp, title, range, company line with Page X of Y, rows, then summary, End of Report and criteria.
  // logo: the company logo, name and address head every page.
  function listingPages({ title, range, cols, rows, summary, criteria, perPage = 28, logo = false }) {
    const now = stamp();
    const stampHtml = `<div class="rp-stamp">Date : ${now}<br>User ID : ${esc((S.profile?.full_name || "").toUpperCase())}</div>`;
    const top = logo
      ? `<div class="rp-brand">${logoHtml("ph-logo")}<div><div class="ph-co">${esc(C.company.name)}</div><div class="ph-addr">${esc(C.company.address.join(", "))}<br>${esc(C.company.email)} · ${esc(C.company.phone)}</div></div>${stampHtml}</div>`
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
          ${criteria ? `<div class="rp-crit"><b>Report Criteria</b>\n${esc(criteria)}</div>` : ""}` : ""}
        <div class="rp-foot"><span>${esc(APP)}</span><span>Printed ${now}</span></div>`;
    });
  }

  // ---------- Download forms ----------
  async function viewForms() {
    shell("forms", "Download Forms", `
      ${isAdmin() ? `<form class="options" id="fmForm"><fieldset class="opt" style="flex:1 1 100%"><legend>Upload New Form (CEO)</legend>
        <div class="formgrid"><div class="fields wide">
          <label for="fmTitle">Title</label><input type="text" id="fmTitle" required placeholder="e.g. Leave Application Form">
          <label for="fmCat">Category</label><input type="text" id="fmCat" list="fmCats" value="General">
        </div><div class="fields wide"><label for="fmFile">File</label><input type="file" id="fmFile" required></div></div>
        <datalist id="fmCats"><option>General</option><option>HR</option><option>Accounts</option><option>Sales</option><option>Purchasing</option></datalist>
        <div class="btnrow"><button class="btn primary" type="submit">Upload Form</button></div></fieldset></form>` : ""}
      <div id="fmList">${busy()}</div>`, "Blank company forms. Press <b>Download</b> to save a copy.");
    const load = async () => {
      const { data, error } = await sb.from("forms").select("*").order("category").order("title");
      if (error) return fail(error, "Could not load forms");
      const rows = data || [];
      const cols = [
        { label: "Title", get: (r) => r.title }, { label: "Category", get: (r) => r.category }, { label: "File", get: (r) => r.file_name },
        { label: "Downloads", num: true, get: (r) => r.downloads }, { label: "Uploaded", get: (r) => dmy(r.created_at) },
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
      const file = $("#fmFile").files[0], title = $("#fmTitle").value.trim(), category = $("#fmCat").value.trim() || "General";
      if (!title || !file) return toast("Enter a title and choose a file.", true);
      const path = `${Date.now()}_${file.name.replace(/[^\w.\-]+/g, "_")}`;
      const up = await sb.storage.from("forms").upload(path, file, { contentType: file.type || "application/octet-stream" });
      if (up.error) return fail(up.error, "Upload failed");
      const { error } = await sb.from("forms").insert({ title, category, storage_path: path, file_name: file.name });
      if (error) return fail(error, "Could not save the form");
      toast(`Uploaded ${title}.`); e.target.reset(); load();
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
      "Everyone who signed up. New sign-ups are <b>Pending</b> applicants: they apply for a job, and approving the job application under <b>Employee → Job Applications</b> lets them in. You can also change a role or status here.");
    const load = async () => {
      let q = sb.from("profiles").select("*").order("created_at", { ascending: false });
      if ($("#uStatus").value) q = q.eq("status", $("#uStatus").value);
      const { data, error } = await q;
      if (error) return fail(error, "Could not load users");
      const rows = data || [];
      const me = S.profile.id;
      const sel = (id, field, val, opts, label = (o) => o) => `<select data-u="${id}" data-f="${field}" ${id === me ? "disabled" : ""} style="width:auto">${opts.map((o) => `<option value="${o}" ${o === val ? "selected" : ""}>${esc(label(o))}</option>`).join("")}</select>`;
      const cols = [
        { label: "Name", get: (r) => r.full_name || "" }, { label: "Username", get: (r) => r.username ? "@" + r.username : "" }, { label: "Email", get: (r) => r.email || "" },
        { label: "Role", html: (r) => sel(r.id, "role", r.role, ["admin", "staff", "viewer"], roleName) },
        { label: "Status", html: (r) => sel(r.id, "status", r.status, ["pending", "active", "disabled"]) + " " + pill(r.status) },
        { label: "Last Seen", html: (r) => r.status === "active" && online(r.last_seen_at) ? `<span class="dot-on"></span> Active now` : esc(r.last_seen_at ? timeAgo(r.last_seen_at) : "—") },
        { label: "Joined", get: (r) => dmy(r.created_at) },
        { label: "", html: (r) => r.id === me ? "<small>You</small>" : `<button type="button" class="btn primary" data-save="${r.id}">Save</button>` }
      ];
      $("#uList").innerHTML = grid({ cols, rows });
      $$("[data-save]").forEach((b) => (b.onclick = async () => {
        const id = b.dataset.save;
        const patch = {}; $$(`select[data-u="${id}"]`).forEach((s) => (patch[s.dataset.f] = s.value));
        const { error: e2 } = await sb.from("profiles").update(patch).eq("id", id);
        if (e2) return fail(e2, "Could not save the user");
        toast("User saved."); load();
      }));
      setRecords(`Users: ${rows.length} · Pending: ${rows.filter((r) => r.status === "pending").length}`);
    };
    $("#uStatus").onchange = load;
    load();
  }

  // ---------- router ----------
  const BUILTIN = { forms: viewForms, logins: viewUsers };
  async function route() {
    closePreview();
    $$(".pop").forEach((p) => (p.hidden = true));
    const [rawKey, id, extra] = (location.hash.slice(1) || "dashboard").split("/");
    if (ALIAS[rawKey]) { location.replace("#" + ALIAS[rawKey]); return; }
    const key = rawKey || "dashboard";
    const arg = id ? decodeURIComponent(id) : id;
    const V = window.EO_VIEWS || {};
    if (!S.session) {
      stopTimers();
      $$(".chat-panel").forEach((x) => x.remove());
      if (key === "verify" && V.verify) return V.verify(arg);
      return renderLogin();
    }
    if (recovering) { recovering = false; return renderSetPassword(true); }
    if (!S.profile) await loadProfile();
    if (!S.profile) {
      authFrame("Sign In", `<div class="wbody login-form">${brandBlock()}<p>Your profile could not be loaded. Check the connection and try again.</p>
        <div class="login-links"><button class="btn" id="npRetry">Try Again</button><button class="btn" id="npOut">Sign Out</button></div></div>`);
      $("#npRetry").onclick = route; $("#npOut").onclick = () => sb.auth.signOut();
      return;
    }
    if (S.profile.status === "disabled") return renderDisabled();
    if (S.profile.status !== "active") {
      if (key === "verify" && V.verify) return V.verify(arg);
      return V.applicant ? V.applicant(key, arg) : renderPending();
    }
    startTimers();
    if (!canOpen(key)) { toast("You do not have access to that section. Ask the CEO.", true); location.hash = "dashboard"; return; }
    const view = V[key] || BUILTIN[key];
    if (view) return view(arg, extra);
    return V.dashboard ? V.dashboard() : shell("dashboard", "Dashboard", "");
  }
  window.addEventListener("hashchange", route);

  // Supabase calls must not run inside the auth callback itself, so routing is deferred a tick.
  let booted = false;
  // A reset-email link arrives as #access_token=…&type=recovery; remember it before supabase-js clears the hash.
  let recovering = /type=recovery/.test(location.hash);
  sb.auth.onAuthStateChange((event, session) => {
    const changedUser = (session?.user?.id || null) !== (S.session?.user?.id || null);
    S.session = session;
    if (S.resetting) return; // the reset-code form finishes and routes itself
    if (event === "PASSWORD_RECOVERY") { booted = true; S.profile = null; setTimeout(() => renderSetPassword(true), 0); return; }
    if (!booted) { booted = true; S.profile = null; setTimeout(() => loadBranding().then(route), 0); return; }
    if (changedUser) { S.profile = null; badgeState.at = 0; stopTimers(); setTimeout(route, 0); }
  });

  // exposed for testing barcode round-trips
  window.EMON = { drawPdf417, drawQr, decodeCanvas, decodeImageFile, words };
  // shared with modules.js, modules2.js and modules3.js
  Object.assign(window.EO, {
    APP, VERSION, sb, S, C, esc, peso, pad, isoToday, dmy, stamp, longDate, dLong, dShort, dmyDash, dateTime, timeAgo, online, $, $$,
    isAdmin, isStaff, pill, toast, fail, words, busy, ic, modal, confirmBox, setBusy,
    shell, miniShell, grid, bindGrid, hasModule, canOpen, canWrite, setRecords, openPreview, closePreview, listingPages,
    drawPdf417, pdf417DataUrl, drawQr, qrDataUrl, decodeImageFile, scanDialog, openScanned,
    roleName, publicUrl, logoHtml, companyHeader, loadBranding, loadProfile, refreshBadge, refreshBadges, initials, avatarUrl, route,
    changePassword: () => renderSetPassword(false)
  });
})();
