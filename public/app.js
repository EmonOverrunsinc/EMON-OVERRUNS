/* Emon Overruns Portal — single-page app on Supabase.
   Screens follow the AutoCount pattern: option panel → Inquiry → grid → Preview (report paper). */
(function () {
  "use strict";

  const C = window.EMON_CONFIG;
  const sb = window.supabase.createClient(C.supabaseUrl, C.supabaseKey);
  const app = document.getElementById("app");

  const TYPES = {
    invoice: "Invoice", receipt: "Official Receipt", debit_note: "Debit Note",
    credit_note: "Credit Note", deposit: "Deposit", refund: "Refund", other: "Other"
  };
  const TCODE = { invoice: "IN", receipt: "OR", debit_note: "DN", credit_note: "CN", deposit: "DP", refund: "RF", other: "OT" };
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const S = { session: null, profile: null, chart: null, scanReader: null, lastResult: [] };

  // ---------- helpers ----------
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const peso = (n) => Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pad = (n) => String(n).padStart(2, "0");
  const isoToday = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const dmy = (iso) => { if (!iso) return ""; const [y, m, d] = String(iso).slice(0, 10).split("-"); return `${d}/${m}/${y}`; };
  const stamp = (d = new Date()) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const longDate = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "2-digit" });
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const isAdmin = () => S.profile?.role === "admin";
  const isStaff = () => ["admin", "staff"].includes(S.profile?.role);
  const pill = (s) => `<span class="pill ${esc(s)}">${esc(s.toUpperCase())}</span>`;
  const firstOfYear = () => `${new Date().getFullYear()}-01-01`;

  function toast(msg, err) {
    $$(".toast").forEach((t) => t.remove());
    const t = document.createElement("div");
    t.className = "toast" + (err ? " err" : "");
    t.setAttribute("role", "status");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), err ? 7000 : 3500);
  }
  function fail(error, what) {
    console.error(error);
    toast(`${what}: ${error?.message || error}`, true);
  }

  // Amount in words, Philippine voucher style: "PESOS ONE THOUSAND TWO HUNDRED AND 50/100 ONLY"
  function words(amount) {
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
    if (whole === 0) return `PESOS ZERO${cents ? ` AND ${pad(cents)}/100` : ""} ONLY`;
    const scales = ["", "THOUSAND", "MILLION", "BILLION"];
    const parts = [];
    for (let i = 0; whole > 0; i++, whole = Math.floor(whole / 1000)) {
      const chunk = whole % 1000;
      if (chunk) parts.unshift(under1000(chunk) + (scales[i] ? " " + scales[i] : ""));
    }
    return `PESOS ${parts.join(" ")}${cents ? ` AND ${pad(cents)}/100` : ""} ONLY`;
  }

  // ---------- PDF417 ----------
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
    const hints = new Map([[Z.DecodeHintType.TRY_HARDER, true], [Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.PDF_417]]]);
    const bmp = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas)));
    return new Z.PDF417Reader().decode(bmp, hints).getText();
  }
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
      throw new Error("No PDF417 barcode found in that image. Try a sharper, straight-on photo.");
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  function docNoFromPayload(text) {
    const t = String(text || "").trim();
    if (t.startsWith("EMON|")) return t.split("|")[1];
    return t;
  }

  // ---------- auth ----------
  async function loadProfile() {
    if (!S.session) { S.profile = null; return; }
    const { data, error } = await sb.from("profiles").select("*").eq("id", S.session.user.id).maybeSingle();
    if (error) fail(error, "Could not load your profile");
    S.profile = data;
  }

  function renderLogin(mode = "signin") {
    app.innerHTML = `
      <div class="login">
        <form class="window" id="loginForm" novalidate>
          <div class="wtitle">Emon Overruns Portal — ${mode === "signin" ? "Sign In" : "Create Account"}</div>
          <div class="wbody">
            <div class="brand"><b>${esc(C.company.name)}</b><small>${esc(C.company.address.join(", "))}</small></div>
            <div class="tabs" role="tablist">
              <button type="button" class="${mode === "signin" ? "on" : ""}" id="tabSignin">Sign In</button>
              <button type="button" class="${mode === "signup" ? "on" : ""}" id="tabSignup">Create Account</button>
            </div>
            <fieldset class="opt"><legend>${mode === "signin" ? "Login" : "New User"}</legend>
              <div class="fields wide">
                ${mode === "signup" ? `<label for="lgName">Full Name</label><input type="text" id="lgName" required autocomplete="name">` : ""}
                <label for="lgEmail">Email</label><input type="email" id="lgEmail" required autocomplete="email">
                <label for="lgPass">Password</label><input type="password" id="lgPass" required minlength="6" autocomplete="${mode === "signin" ? "current-password" : "new-password"}">
              </div>
            </fieldset>
            ${mode === "signup" ? `<div class="hint">New accounts start as <b>Pending</b>. An administrator activates them under Users.</div>` : ""}
          </div>
          <div class="wfoot">
            ${mode === "signin" ? `<button type="button" class="btn" id="lgReset">Forgot Password</button>` : ""}
            <button class="btn primary" type="submit">${mode === "signin" ? "Sign In" : "Create Account"}</button>
          </div>
        </form>
      </div>`;
    $("#tabSignin").onclick = () => renderLogin("signin");
    $("#tabSignup").onclick = () => renderLogin("signup");
    if ($("#lgReset")) $("#lgReset").onclick = async () => {
      const email = $("#lgEmail").value.trim();
      if (!email) return toast("Enter your email first, then press Forgot Password.", true);
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      if (error) return fail(error, "Could not send the reset email");
      toast("Password reset email sent to " + email);
    };
    $("#loginForm").onsubmit = async (e) => {
      e.preventDefault();
      const email = $("#lgEmail").value.trim(), password = $("#lgPass").value;
      if (!email || password.length < 6) return toast("Enter your email and a password of at least 6 characters.", true);
      if (mode === "signin") {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) return fail(error, "Sign in failed");
      } else {
        const full_name = $("#lgName").value.trim();
        if (!full_name) return toast("Enter your full name.", true);
        const { data, error } = await sb.auth.signUp({ email, password, options: { data: { full_name }, emailRedirectTo: location.origin + location.pathname } });
        if (error) return fail(error, "Could not create the account");
        if (!data.session) { toast("Account created. Check your email to confirm it, then sign in."); renderLogin("signin"); }
      }
    };
  }

  function renderPending() {
    const st = S.profile?.status || "pending";
    app.innerHTML = `
      <div class="login"><div class="window">
        <div class="wtitle">Emon Overruns Portal</div>
        <div class="wbody">
          <div class="brand"><b>${esc(C.company.name)}</b></div>
          <p>Signed in as <b>${esc(S.session.user.email)}</b>. Account status: ${pill(st)}</p>
          <p>${st === "disabled" ? "This account has been disabled. Contact the administrator." : "Your account is waiting for an administrator to activate it. Try again after you have been approved."}</p>
        </div>
        <div class="wfoot"><button class="btn" id="pRefresh">Check Again</button><button class="btn" id="pOut">Sign Out</button></div>
      </div></div>`;
    $("#pRefresh").onclick = async () => { await loadProfile(); route(); };
    $("#pOut").onclick = () => sb.auth.signOut();
  }

  // ---------- shell ----------
  const MENU = [
    ["dashboard", "Dashboard", () => true],
    ["documents", "Documents", () => true],
    ["newdoc", "Upload", () => isStaff()],
    ["verification", "Verification", () => true],
    ["search", "Search", () => true],
    ["forms", "Download Forms", () => true],
    ["announcements", "Announcements", () => true],
    ["users", "Users", () => isAdmin()]
  ];

  function shell(key, title, body, hint) {
    const items = MENU.filter((m) => m[2]()).map(([k, label]) =>
      `<a href="#${k}" class="${k === key ? "active" : ""}"><u>${esc(label[0])}</u>${esc(label.slice(1))}</a>`).join("");
    app.innerHTML = `
      <div class="titlebar"><span class="logo">EO</span><span>${esc(title)} — ${esc(C.company.name)} [Portal]</span>
        <span class="who"><span>${esc(S.profile.full_name || S.session.user.email)} · ${esc(S.profile.role.toUpperCase())}</span><button id="signOut">Sign Out</button></span></div>
      <nav class="menubar" aria-label="Modules">${items}</nav>
      <div class="band"><h1>${esc(title)}</h1><span class="help" title="${esc(hint || title)}">?</span></div>
      <main id="main">${hint ? `<div class="hint"><b>Hint:</b> ${hint}</div>` : ""}${body}</main>
      <div class="statusbar"><span>User: ${esc(S.session.user.email)}</span><span id="sbRecords">Records: –</span><span>Currency: PHP (₱)</span></div>`;
    $("#signOut").onclick = () => sb.auth.signOut();
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
    return `<div class="grid-wrap"><div class="grid-group">Click a row to open its document</div>
      <div class="grid-scroll"><table class="grid"><thead><tr>${head}</tr></thead><tbody>${bodyHtml}</tbody>${footHtml}</table></div>
      <div class="grid-foot"><span>Record 1 of ${rows.length}</span><span>${rows.length} record(s)</span></div></div>`;
  }
  function bindGrid(container, rows, onRow) {
    if (!onRow) return;
    $$("tbody tr.click", container).forEach((tr) => {
      tr.tabIndex = 0;
      const go = () => onRow(rows[Number(tr.dataset.i)]);
      tr.onclick = go;
      tr.onkeydown = (e) => { if (e.key === "Enter") go(); };
    });
  }
  const DOC_COLS = [
    { label: "Doc No", get: (r) => r.doc_no },
    { label: "Doc Date", get: (r) => dmy(r.doc_date) },
    { label: "T", get: (r) => TCODE[r.doc_type] },
    { label: "Doc Type", get: (r) => TYPES[r.doc_type] },
    { label: "Code", get: (r) => r.party_code || "" },
    { label: "Party Name", get: (r) => r.party_name },
    { label: "Due Date", get: (r) => dmy(r.due_date) },
    { label: "Curr.", get: (r) => r.currency },
    { label: "Status", html: (r) => pill(r.status) },
    { label: "Amount (₱)", key: "amount", num: true, get: (r) => peso(r.amount) }
  ];

  // ---------- report preview window ----------
  function openPreview(title, pages, { landscape = false } = {}) {
    closePreview();
    const pv = document.createElement("div");
    pv.className = "preview";
    pv.innerHTML = `
      <div class="pv-title">Preview — ${esc(title)}</div>
      <div class="pv-tools">
        <button class="btn" id="pvPrint">Print / Save PDF</button>
        <label for="pvZoom">Zoom</label>
        <select id="pvZoom" style="width:auto"><option>50</option><option>75</option><option selected>100</option><option>125</option><option>150</option></select>
        <button class="btn" id="pvClose">Close</button>
      </div>
      <div class="pv-desk" id="pvDesk">${pages.map((p) => `<div class="page${landscape ? " landscape" : ""}">${p}</div>`).join("")}</div>
      <div class="statusbar"><span id="pvCur">Current Page No: 1</span><span>Total Page No: ${pages.length}</span><span id="pvZf">Zoom Factor: 100%</span></div>`;
    document.body.appendChild(pv);
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
  function escClose(e) { if (e.key === "Escape") closePreview(); }
  function closePreview() { $$(".preview").forEach((p) => p.remove()); document.removeEventListener("keydown", escClose); }

  // AutoCount-style listing: stamp, title, range, company line with Page X of Y, rows, then summary, End of Report and criteria.
  function listingPages({ title, range, cols, rows, summary, criteria, perPage = 28 }) {
    const now = stamp();
    const chunks = [];
    for (let i = 0; i < rows.length; i += perPage) chunks.push(rows.slice(i, i + perPage));
    if (!chunks.length) chunks.push([]);
    const head = `<tr>${cols.map((c) => `<th class="${c.num ? "num" : ""}">${esc(c.label)}</th>`).join("")}</tr>`;
    return chunks.map((chunk, pi) => {
      const last = pi === chunks.length - 1;
      const body = chunk.length
        ? chunk.map((r) => r.__sub
          ? `<tr class="sub"><td colspan="${cols.length - 1}" class="num">${esc(r.__sub)}</td><td class="num">${esc(r.__val)}</td></tr>`
          : `<tr>${cols.map((c) => `<td class="${c.num ? "num" : ""}">${esc(c.get(r))}</td>`).join("")}</tr>`).join("")
        : `<tr><td colspan="${cols.length}" style="padding:16px 3px">No records in this range.</td></tr>`;
      return `
        <div class="rp-stamp">Date : ${now}<br>User ID : ${esc((S.profile.full_name || "").toUpperCase())}</div>
        <div class="rp-title">${esc(title)}</div>
        <div class="rp-range">${range}</div>
        <div class="rp-co"><span>${esc(C.company.name)} — ${esc(C.company.address.join(", "))}</span><span>Page ${pi + 1} of ${chunks.length}</span></div>
        <table class="rp"><thead>${head}</thead><tbody>${body}</tbody></table>
        ${last ? `
          <div class="rp-double"></div>
          ${summary ? `<div class="rp-sum-title">${esc(summary.title)}</div>
          <table class="rp sum"><thead><tr>${summary.cols.map((c, i) => `<th class="${i ? "num" : ""}">${esc(c)}</th>`).join("")}</tr></thead>
          <tbody>${summary.rows.map((r) => `<tr>${r.map((v, i) => `<td class="${i ? "num" : ""}">${esc(v)}</td>`).join("")}</tr>`).join("")}
          <tr class="sub">${summary.total.map((v, i) => `<td class="${i ? "num" : ""}">${esc(v)}</td>`).join("")}</tr></tbody></table>` : ""}
          <div class="rp-end">End of Report</div>
          <div class="rp-crit"><b>Report Criteria</b>\n${esc(criteria)}</div>` : ""}
        <div class="rp-foot"><span>${esc(C.company.name)} Portal</span><span>Printed ${now}</span></div>`;
    });
  }

  // Single document voucher (receipt / invoice style) with PDF417.
  function voucherPage(d, files, verifierName) {
    const bc = pdf417DataUrl(d.barcode_payload || d.doc_no);
    const partyLabel = ["receipt", "deposit"].includes(d.doc_type) ? "RECEIVED FROM" : (d.doc_type === "refund" ? "PAID TO" : "BILL TO");
    return `
      <div class="rp-stamp">Date : ${stamp()}<br>User ID : ${esc((S.profile.full_name || "").toUpperCase())}</div>
      <div class="lh"><div class="mark">EO</div><div>
        <div class="co">${esc(C.company.name)}</div>
        <div class="addr">${C.company.address.map(esc).join("<br>")}<br>Email: ${esc(C.company.email)}</div></div></div>
      <div class="vt">${esc(TYPES[d.doc_type].toUpperCase())}</div>
      <div class="vhead">
        <div class="kv">
          <span>${partyLabel}</span><span>:</span><span><b>${esc(d.party_name)}</b>${d.party_code ? ` (${esc(d.party_code)})` : ""}</span>
          <span>DESCRIPTION</span><span>:</span><span>${esc(d.description || "")}</span>
          <span>THE SUM OF</span><span>:</span><span class="words">${esc(words(d.amount))}</span>
        </div>
        <div class="kv">
          <span><b>No.</b></span><span>:</span><span><b>${esc(d.doc_no)}</b></span>
          <span>Date</span><span>:</span><span>${dmy(d.doc_date)}</span>
          ${d.due_date ? `<span>Due Date</span><span>:</span><span>${dmy(d.due_date)}</span>` : ""}
          <span>Status</span><span>:</span><span>${esc(d.status.toUpperCase())}</span>
        </div>
      </div>
      <table class="rp" style="margin-top:14px;width:70%">
        <thead><tr><th>Particulars</th><th>Attachments</th><th class="num">Amount (₱)</th></tr></thead>
        <tbody><tr><td>${esc(TYPES[d.doc_type])}${d.description ? " — " + esc(d.description) : ""}</td><td>${files.length ? files.map((f) => esc(f.file_name)).join("<br>") : "None"}</td><td class="num">${peso(d.amount)}</td></tr>
        <tr class="grand"><td colspan="2" class="num">Total Amount :</td><td class="num">${peso(d.amount)}</td></tr></tbody>
      </table>
      ${d.remarks ? `<p><b>Remarks:</b> ${esc(d.remarks)}</p>` : ""}
      <div style="margin-top:18px">${bc ? `<img src="${bc}" alt="PDF417 barcode for ${esc(d.doc_no)}" style="height:70px;image-rendering:pixelated">` : ""}
        <div style="font:9px var(--font-mono)">${esc(d.barcode_payload || "")}</div></div>
      <div class="sig"><div>Prepared by</div><div>Verified by${verifierName ? ": " + esc(verifierName) : ""}</div></div>
      <div style="margin-top:28px;text-align:right">FOR ${esc(C.company.name)}</div>
      <div class="rp-foot"><span>Scan the PDF417 code in Portal › Search to open this record.</span><span>${esc(d.doc_no)}</span></div>`;
  }

  // ---------- data ----------
  async function fetchDocs(opt = {}) {
    let q = sb.from("documents").select("*");
    if (opt.from) q = q.gte("doc_date", opt.from);
    if (opt.to) q = q.lte("doc_date", opt.to);
    if (opt.type) q = q.eq("doc_type", opt.type);
    if (opt.status) q = q.eq("status", opt.status);
    const sort = { doc_no: ["doc_no", true], doc_date: ["doc_date", false], party_name: ["party_name", true], amount: ["amount", false] }[opt.sort || "doc_date"];
    q = q.order(sort[0], { ascending: sort[1] }).order("doc_no", { ascending: true }).limit(opt.limit || 2000);
    const { data, error } = await q;
    if (error) { fail(error, "Could not load documents"); return []; }
    return data;
  }
  async function profileNames() {
    const { data } = await sb.from("profiles").select("id, full_name, email");
    const m = new Map(); (data || []).forEach((p) => m.set(p.id, p.full_name || p.email)); return m;
  }

  // ---------- Dashboard ----------
  async function viewDashboard() {
    const year = new Date().getFullYear();
    shell("dashboard", "Dashboard", `
      <div class="tiles" id="tiles">${["Total Documents", "Pending Verification", "Total Amount (₱)", "Verified This Month"].map((k) => `<div class="tile"><div class="k">${k}</div><div class="v">…</div></div>`).join("")}</div>
      <div class="cols">
        <div class="box"><h3>Monthly Amount by Document Type — ${year} (₱)</h3><div class="in"><div class="chart-holder"><canvas id="chart" aria-label="Monthly amounts chart"></canvas></div>
          <div class="btnrow"><button class="btn" id="dbMonthly">Preview Monthly Analysis Report</button></div></div></div>
        <div class="box"><h3>Announcements</h3><div class="in" id="dbAnn">Loading…</div></div>
      </div>
      <div class="box" style="margin-top:10px"><h3>Recent Documents</h3><div class="in" id="dbRecent">Loading…</div></div>`);
    const [docs, ann] = await Promise.all([
      fetchDocs({ sort: "doc_date" }),
      sb.from("announcements").select("*").order("pinned", { ascending: false }).order("published_at", { ascending: false }).limit(5)
    ]);
    const live = docs.filter((d) => d.status !== "rejected");
    const ym = isoToday().slice(0, 7);
    const tiles = [
      ["", docs.length.toLocaleString()],
      ["warn", docs.filter((d) => d.status === "pending").length.toLocaleString()],
      ["", "₱ " + peso(live.reduce((s, d) => s + Number(d.amount), 0))],
      ["ok", docs.filter((d) => d.status === "verified" && (d.verified_at || "").slice(0, 7) === ym).length.toLocaleString()]
    ];
    $$("#tiles .tile").forEach((t, i) => { t.className = "tile " + tiles[i][0]; $(".v", t).textContent = tiles[i][1]; });
    setRecords(`Records: ${docs.length}`);

    // chart: stacked bars by type for the current year
    const yearDocs = live.filter((d) => d.doc_date.startsWith(String(year)));
    const palette = { invoice: "#2f5fa8", receipt: "#6fae2c", debit_note: "#e08a00", credit_note: "#b3261e", deposit: "#7a4fb5", refund: "#2a9d8f", other: "#8a94a3" };
    const datasets = Object.keys(TYPES).map((t) => ({
      label: TYPES[t], backgroundColor: palette[t],
      data: MONTHS.map((_, m) => yearDocs.filter((d) => d.doc_type === t && Number(d.doc_date.slice(5, 7)) === m + 1).reduce((s, d) => s + Number(d.amount), 0))
    })).filter((ds) => ds.data.some((v) => v));
    if (S.chart) S.chart.destroy();
    S.chart = new window.Chart($("#chart"), {
      type: "bar",
      data: { labels: MONTHS, datasets: datasets.length ? datasets : [{ label: "No documents yet", data: MONTHS.map(() => 0), backgroundColor: "#c9d6e6" }] },
      options: {
        maintainAspectRatio: false, animation: false,
        scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, ticks: { callback: (v) => "₱" + Number(v).toLocaleString("en-PH") }, grid: { color: "#e3ebf5" } } },
        plugins: { legend: { position: "bottom", labels: { boxWidth: 12 } }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ₱${peso(c.raw)}` } } }
      }
    });
    $("#dbMonthly").onclick = () => previewMonthly(year, live);

    const anns = ann.data || [];
    $("#dbAnn").innerHTML = anns.length ? anns.map(annHtml).join("") : `<div class="empty">No announcements yet.${isAdmin() ? ` <a href="#announcements">Post the first one</a>.` : ""}</div>`;
    const recent = docs.slice(0, 8);
    $("#dbRecent").innerHTML = grid({ cols: DOC_COLS, rows: recent, onRow: true, empty: isStaff() ? "No documents yet. Use Upload to record the first one." : "No documents yet." });
    bindGrid($("#dbRecent"), recent, (r) => (location.hash = "doc/" + r.id));
  }
  function annHtml(a) {
    return `<div class="ann"><h4>${a.pinned ? `<span class="pin">PINNED</span> ` : ""}${esc(a.title)}</h4>
      <div class="meta">${esc(new Date(a.published_at).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }))}</div><p>${esc(a.body)}</p></div>`;
  }
  function previewMonthly(year, docs) {
    const byParty = new Map();
    docs.filter((d) => d.doc_date.startsWith(String(year))).forEach((d) => {
      if (!byParty.has(d.party_name)) byParty.set(d.party_name, Array(12).fill(0));
      byParty.get(d.party_name)[Number(d.doc_date.slice(5, 7)) - 1] += Number(d.amount);
    });
    const rows = [...byParty.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([p, m]) => ({ p, m }));
    const cols = [{ label: "Party", get: (r) => r.p }, ...MONTHS.map((mn, i) => ({ label: `${mn}-${year}`, num: true, get: (r) => peso(r.m[i]) })), { label: "Total", num: true, get: (r) => peso(r.m.reduce((s, v) => s + v, 0)) }];
    const tot = Array(12).fill(0); rows.forEach((r) => r.m.forEach((v, i) => (tot[i] += v)));
    const totalRow = { p: "Total :", m: tot };
    const pages = listingPages({
      title: "Monthly Document Analysis Report", range: "(In Local Currency — PHP)", cols, rows: rows.length ? [...rows, totalRow] : [],
      criteria: `Filter Options: Year: ${year}\n                Status: Pending and Verified (rejected excluded)\nReport Options: Sort By: Party Name`
    });
    openPreview("Monthly Document Analysis", pages, { landscape: true });
  }

  // ---------- Documents (listing / inquiry) ----------
  function viewDocuments() {
    shell("documents", "Document Listing", `
      <div class="options">
        <fieldset class="opt"><legend>Basic Options</legend><div class="fields">
          <label for="fFrom">Date From</label><input type="date" id="fFrom" value="${firstOfYear()}">
          <label for="fTo">Date To</label><input type="date" id="fTo" value="${isoToday()}">
          <label for="fType">Doc Type</label><select id="fType"><option value="">No filter</option>${Object.entries(TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
          <label for="fStatus">Status</label><select id="fStatus"><option value="">No filter</option><option value="pending">Pending</option><option value="verified">Verified</option><option value="rejected">Rejected</option></select>
        </div></fieldset>
        <fieldset class="opt"><legend>Report Options</legend><div class="fields">
          <label for="fSort">Sort By</label><select id="fSort"><option value="doc_date">Document Date</option><option value="doc_no">Document No</option><option value="party_name">Party Name</option><option value="amount">Amount</option></select>
          <label for="fGroup">Group By</label><select id="fGroup"><option value="">None</option><option value="type">Doc Type</option><option value="status">Status</option><option value="party">Party</option></select>
        </div><div class="checks" style="margin-top:6px"><label><input type="checkbox" id="fCrit" checked> Show Criteria In Report</label></div></fieldset>
      </div>
      <div class="btnrow">
        <button class="btn primary" id="bInq">Inquiry</button><button class="btn" id="bPrev">Preview</button>
        ${isStaff() ? `<button class="btn" id="bNew">New Document</button>` : ""}<button class="btn" id="bClose">Close</button>
      </div>
      <div class="tabs"><button class="on" id="tRes">Result</button><button id="tCrit">Criteria</button></div>
      <div id="result"></div><div id="crit" hidden class="grid-wrap"><pre class="rp-crit" style="padding:10px;margin:0" id="critText"></pre></div>`,
      "Set the options, then press <b>Inquiry</b>. <b>Preview</b> opens the printable Document Listing.");
    const opts = () => ({ from: $("#fFrom").value, to: $("#fTo").value, type: $("#fType").value, status: $("#fStatus").value, sort: $("#fSort").value, group: $("#fGroup").value });
    const critText = (o) => `Filter Options: From Date: ${o.from ? longDate(o.from) : "(none)"}\n                To Date: ${o.to ? longDate(o.to) : "(none)"}\n                Doc Type: ${o.type ? TYPES[o.type] : "All"}\n                Status: ${o.status ? o.status : "All"}\nReport Options: Sort By: ${$("#fSort").selectedOptions[0].text}\n                Group By: ${$("#fGroup").selectedOptions[0].text}`;
    const run = async () => {
      const o = opts();
      $("#result").innerHTML = `<div class="grid-wrap"><div class="empty">Loading…</div></div>`;
      const rows = await fetchDocs(o);
      S.lastResult = rows;
      const groupFn = { type: (r) => TYPES[r.doc_type], status: (r) => r.status.toUpperCase(), party: (r) => r.party_name }[o.group];
      $("#result").innerHTML = grid({ cols: DOC_COLS, rows, onRow: true, group: groupFn, foot: { amount: peso(rows.reduce((s, r) => s + Number(r.amount), 0)) } });
      bindGrid($("#result"), rows, (r) => (location.hash = "doc/" + r.id));
      $("#critText").textContent = critText(o);
      setRecords(`Records: ${rows.length}`);
    };
    $("#bInq").onclick = run;
    $("#bClose").onclick = () => (location.hash = "dashboard");
    if ($("#bNew")) $("#bNew").onclick = () => (location.hash = "newdoc");
    $("#tRes").onclick = () => { $("#tRes").classList.add("on"); $("#tCrit").classList.remove("on"); $("#result").hidden = false; $("#crit").hidden = true; };
    $("#tCrit").onclick = () => { $("#tCrit").classList.add("on"); $("#tRes").classList.remove("on"); $("#result").hidden = true; $("#crit").hidden = false; };
    $("#bPrev").onclick = async () => {
      const o = opts();
      const rows = await fetchDocs(o);
      const byType = new Map();
      rows.forEach((r) => { const t = byType.get(r.doc_type) || [0, 0]; t[0]++; t[1] += Number(r.amount); byType.set(r.doc_type, t); });
      const total = rows.reduce((s, r) => s + Number(r.amount), 0);
      const pages = listingPages({
        title: "Document Listing",
        range: `Report From: ${dmy(o.from) || "start"} &nbsp; to &nbsp; ${dmy(o.to) || "today"}`,
        cols: [
          { label: "Date", get: (r) => dmy(r.doc_date) }, { label: "Doc No", get: (r) => r.doc_no }, { label: "T", get: (r) => TCODE[r.doc_type] },
          { label: "Code", get: (r) => r.party_code || "" }, { label: "Party Name", get: (r) => r.party_name }, { label: "Due Date", get: (r) => dmy(r.due_date) },
          { label: "Curr.", get: (r) => r.currency }, { label: "Status", get: (r) => r.status.toUpperCase() }, { label: "Amount", num: true, get: (r) => peso(r.amount) }
        ],
        rows,
        summary: { title: "Summary of Document Listing in Local Currency", cols: ["Document Type", "Count", "Amount (₱)"], rows: [...byType].map(([t, v]) => [TYPES[t], String(v[0]), peso(v[1])]), total: ["Total:", String(rows.length), peso(total)] },
        criteria: $("#fCrit").checked ? critText(o) : "(criteria hidden)"
      });
      openPreview("Document Listing", pages);
    };
    run();
  }

  // ---------- New document / upload ----------
  function viewNewDoc() {
    if (!isStaff()) { toast("Only Staff and Admin users can upload documents.", true); location.hash = "documents"; return; }
    shell("newdoc", "New Document", `
      <form class="window" id="ndForm" novalidate>
        <div class="wtitle">New Document — Upload</div>
        <div class="wbody">
          <div class="formgrid">
            <div class="fields wide">
              <label for="nType">Doc Type</label><select id="nType">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
              <label for="nCode">Party Code</label><input type="text" id="nCode" placeholder="e.g. 300-A001">
              <label for="nParty">Party Name</label><input type="text" id="nParty" required placeholder="Customer or supplier name">
              <label for="nDesc">Description</label><input type="text" id="nDesc" placeholder="e.g. Account payment">
            </div>
            <div class="fields wide">
              <label>Document No</label><input type="text" value="<<New>>" disabled>
              <label for="nDate">Date</label><input type="date" id="nDate" value="${isoToday()}">
              <label for="nDue">Due Date</label><input type="date" id="nDue">
              <label for="nAmt">Amount (₱)</label><input type="number" id="nAmt" step="0.01" min="0" value="0.00" required>
            </div>
          </div>
          <fieldset class="opt"><legend>Attachments</legend>
            <input type="file" id="nFiles" multiple accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt">
            <div id="nFileList" style="margin-top:4px;color:var(--ink-soft)">No files chosen. Scans, photos or PDFs, up to 50 MB each.</div>
          </fieldset>
          <div class="summary-box"><div class="fields wide">
            <span>Amount</span><b id="nSumAmt">₱ 0.00</b>
            <span>In Words</span><span id="nSumWords">PESOS ZERO ONLY</span>
            <span>PDF417</span><span>Assigned on save, from the new document number</span>
          </div></div>
        </div>
        <div class="wfoot">
          <button type="submit" class="btn primary" data-after="view">Save</button>
          <button type="submit" class="btn" data-after="preview">Save &amp; Preview</button>
          <button type="button" class="btn" id="nCancel">Cancel</button>
        </div>
      </form>`, "Fill in the document, attach the scanned copy, then <b>Save</b>. The new record waits in <b>Verification</b> until an admin checks it.");
    const upd = () => { const v = Number($("#nAmt").value || 0); $("#nSumAmt").textContent = "₱ " + peso(v); $("#nSumWords").textContent = words(v); };
    $("#nAmt").oninput = upd;
    $("#nFiles").onchange = (e) => {
      const f = Array.from(e.target.files);
      $("#nFileList").textContent = f.length ? f.map((x) => `${x.name} (${Math.ceil(x.size / 1024)} KB)`).join(", ") : "No files chosen.";
    };
    $("#nCancel").onclick = () => (location.hash = "documents");
    let after = "view";
    $$("#ndForm button[type=submit]").forEach((b) => (b.onclick = () => (after = b.dataset.after)));
    $("#ndForm").onsubmit = async (e) => {
      e.preventDefault();
      const party = $("#nParty").value.trim();
      const amount = Number($("#nAmt").value);
      if (!party) return toast("Enter the party name.", true);
      if (!(amount >= 0)) return toast("Enter an amount of 0 or more.", true);
      const files = Array.from($("#nFiles").files);
      const big = files.find((f) => f.size > 50 * 1024 * 1024);
      if (big) return toast(`${big.name} is larger than 50 MB.`, true);
      $$("#ndForm button").forEach((b) => (b.disabled = true));
      const { data: doc, error } = await sb.from("documents").insert({
        doc_type: $("#nType").value, party_code: $("#nCode").value.trim() || null, party_name: party,
        description: $("#nDesc").value.trim() || null, doc_date: $("#nDate").value || isoToday(),
        due_date: $("#nDue").value || null, amount
      }).select().single();
      if (error) { $$("#ndForm button").forEach((b) => (b.disabled = false)); return fail(error, "Could not save the document"); }
      const failed = await uploadFiles(doc.id, files);
      toast(`Saved ${doc.doc_no}${failed ? ` — ${failed} attachment(s) failed to upload` : ""}.`, failed > 0);
      location.hash = "doc/" + doc.id + (after === "preview" ? "/preview" : "");
    };
  }
  async function uploadFiles(docId, files) {
    let failed = 0;
    for (const f of files) {
      const safe = f.name.replace(/[^\w.\-]+/g, "_");
      const path = `${docId}/${Date.now()}_${safe}`;
      const up = await sb.storage.from("documents").upload(path, f, { contentType: f.type || "application/octet-stream" });
      if (up.error) { failed++; console.error(up.error); continue; }
      const ins = await sb.from("document_files").insert({ document_id: docId, storage_path: path, file_name: f.name, mime: f.type, size: f.size });
      if (ins.error) { failed++; console.error(ins.error); }
    }
    return failed;
  }

  // ---------- Single document ----------
  async function viewDoc(id, autoPreview) {
    shell("documents", "View Document", `<div class="empty">Loading…</div>`);
    const [{ data: d, error }, files, log, names] = await Promise.all([
      sb.from("documents").select("*").eq("id", id).maybeSingle(),
      sb.from("document_files").select("*").eq("document_id", id).order("created_at"),
      sb.from("verification_log").select("*").eq("document_id", id).order("created_at"),
      profileNames()
    ]);
    if (error || !d) { $("#main").innerHTML = `<div class="empty">That document was not found, or you do not have access to it. <a href="#documents">Back to Document Listing</a></div>`; return; }
    const fl = files.data || [];
    const verifier = d.verified_by ? names.get(d.verified_by) : "";
    $(".band h1").textContent = `View Document — ${d.doc_no}`;
    $("#main").innerHTML = `
      <div class="window">
        <div class="wtitle">${esc(TYPES[d.doc_type])} — [${esc(d.doc_no)}] ${pill(d.status)}</div>
        <div class="wbody">
          <div class="formgrid">
            <div class="fields wide">
              <span>Doc Type</span><b>${esc(TYPES[d.doc_type])}</b>
              <span>Party Code</span><span>${esc(d.party_code || "—")}</span>
              <span>Party Name</span><b>${esc(d.party_name)}</b>
              <span>Description</span><span>${esc(d.description || "—")}</span>
              <span>Created By</span><span>${esc(names.get(d.created_by) || "—")}</span>
            </div>
            <div class="fields wide">
              <span>Document No</span><b>${esc(d.doc_no)}</b>
              <span>Date</span><span>${dmy(d.doc_date)}</span>
              <span>Due Date</span><span>${dmy(d.due_date) || "—"}</span>
              <span>Status</span><span>${pill(d.status)}${verifier ? ` by ${esc(verifier)}` : ""}</span>
              <span>Remarks</span><span>${esc(d.remarks || "—")}</span>
            </div>
          </div>
          <div class="summary-box"><div class="fields wide"><span>Amount</span><b>₱ ${peso(d.amount)}</b><span>In Words</span><span>${esc(words(d.amount))}</span></div></div>
          <div class="formgrid">
            <fieldset class="opt"><legend>PDF417 Barcode</legend><div class="barcode-box"><canvas id="bc"></canvas><div class="cap">${esc(d.barcode_payload)}</div></div></fieldset>
            <fieldset class="opt"><legend>Attachments (${fl.length})</legend>
              <div id="fileList">${fl.length ? fl.map((f) => `<div><button class="btn" data-path="${esc(f.storage_path)}" data-name="${esc(f.file_name)}">Open</button> ${esc(f.file_name)} <small>(${Math.ceil((f.size || 0) / 1024)} KB)</small></div>`).join("") : "No files attached."}</div>
              ${isStaff() ? `<div style="margin-top:6px"><label for="addFiles">Add files </label><input type="file" id="addFiles" multiple></div>` : ""}
            </fieldset>
          </div>
          ${isAdmin() ? `<fieldset class="opt"><legend>Verification</legend>
            <div class="fields wide"><label for="vNote">Note</label><input type="text" id="vNote" placeholder="Optional note, shown in the audit trail"></div>
            <div class="btnrow">${d.status !== "verified" ? `<button class="btn ok" data-act="verified">Verify</button>` : ""}${d.status !== "rejected" ? `<button class="btn danger" data-act="rejected">Reject</button>` : ""}${d.status !== "pending" ? `<button class="btn" data-act="reopened">Reopen</button>` : ""}</div></fieldset>` : ""}
          <div><b>Audit Trail</b>${grid({ cols: [
            { label: "Date / Time", get: (r) => stamp(new Date(r.created_at)) }, { label: "Action", get: (r) => r.action.toUpperCase() },
            { label: "By", get: (r) => r.actor_name || "" }, { label: "Note", get: (r) => r.note || "" }], rows: log.data || [] })}</div>
        </div>
        <div class="wfoot">
          <button class="btn primary" id="dPrev">Preview</button>
          <button class="btn" id="dPrint">Print</button>
          ${isAdmin() ? `<button class="btn danger" id="dDel">Delete</button>` : ""}
          <button class="btn" id="dBack">Close</button>
        </div>
      </div>`;
    if (!drawPdf417($("#bc"), d.barcode_payload || d.doc_no)) $("#bc").replaceWith("Barcode could not be drawn.");
    $$("#fileList button").forEach((b) => (b.onclick = async () => {
      const { data, error: e2 } = await sb.storage.from("documents").createSignedUrl(b.dataset.path, 300);
      if (e2) return fail(e2, "Could not open the file");
      window.open(data.signedUrl, "_blank", "noopener");
    }));
    if ($("#addFiles")) $("#addFiles").onchange = async (e) => {
      const failed = await uploadFiles(d.id, Array.from(e.target.files));
      toast(failed ? `${failed} file(s) failed to upload.` : "Attachments added.", failed > 0);
      viewDoc(id);
    };
    $$("[data-act]").forEach((b) => (b.onclick = async () => {
      const { error: e2 } = await sb.rpc("verify_document", { p_id: d.id, p_action: b.dataset.act, p_note: $("#vNote").value.trim() || null });
      if (e2) return fail(e2, "Could not update the status");
      toast(`${d.doc_no} ${b.dataset.act}.`);
      viewDoc(id);
    }));
    const preview = () => openPreview(`${TYPES[d.doc_type]} ${d.doc_no}`, [voucherPage(d, fl, verifier)]);
    $("#dPrev").onclick = preview;
    $("#dPrint").onclick = () => { preview(); setTimeout(() => window.print(), 300); };
    $("#dBack").onclick = () => history.length > 1 ? history.back() : (location.hash = "documents");
    if ($("#dDel")) {
      let armed = false;
      $("#dDel").onclick = async () => {
        if (!armed) { armed = true; $("#dDel").textContent = "Press again to delete"; setTimeout(() => { armed = false; const b = $("#dDel"); if (b) b.textContent = "Delete"; }, 4000); return; }
        if (fl.length) await sb.storage.from("documents").remove(fl.map((f) => f.storage_path));
        const { error: e2 } = await sb.from("documents").delete().eq("id", d.id);
        if (e2) return fail(e2, "Could not delete the document");
        toast(`${d.doc_no} deleted.`);
        location.hash = "documents";
      };
    }
    setRecords(`Document: ${d.doc_no}`);
    if (autoPreview) preview();
  }

  // ---------- Verification ----------
  function viewVerification() {
    shell("verification", "Verification", `
      <div class="options">
        <fieldset class="opt"><legend>Basic Options</legend><div class="fields">
          <label for="vStatus">Status</label><select id="vStatus"><option value="pending">Pending</option><option value="verified">Verified</option><option value="rejected">Rejected</option><option value="">All</option></select>
          <label for="vType">Doc Type</label><select id="vType"><option value="">No filter</option>${Object.entries(TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
        </div></fieldset>
        <fieldset class="opt"><legend>Audit Trail Report</legend><div class="fields">
          <label for="aFrom">Date From</label><input type="date" id="aFrom" value="${isoToday().slice(0, 8)}01">
          <label for="aTo">Date To</label><input type="date" id="aTo" value="${isoToday()}">
        </div></fieldset>
      </div>
      <div class="btnrow"><button class="btn primary" id="vInq">Inquiry</button><button class="btn" id="vPrev">Preview Audit Trail</button><button class="btn" id="vClose">Close</button></div>
      <div id="vResult"></div>`,
      isAdmin() ? "Open a document to check its attachments, or use <b>Verify</b> / <b>Reject</b> directly in the grid." : "Documents waiting for admin verification. Only admins can verify or reject.");
    const run = async () => {
      const rows = await fetchDocs({ status: $("#vStatus").value, type: $("#vType").value, sort: "doc_date" });
      const cols = [...DOC_COLS];
      if (isAdmin()) cols.push({ label: "Action", html: (r) => r.status === "pending" ? `<button class="btn ok" data-v="${r.id}" data-a="verified">Verify</button> <button class="btn danger" data-v="${r.id}" data-a="rejected">Reject</button>` : "" });
      $("#vResult").innerHTML = grid({ cols, rows, onRow: true, foot: { amount: peso(rows.reduce((s, r) => s + Number(r.amount), 0)) }, empty: "Nothing waiting here." });
      bindGrid($("#vResult"), rows, (r) => (location.hash = "doc/" + r.id));
      $$("[data-v]").forEach((b) => (b.onclick = async (e) => {
        e.stopPropagation();
        const { error } = await sb.rpc("verify_document", { p_id: b.dataset.v, p_action: b.dataset.a, p_note: null });
        if (error) return fail(error, "Could not update the status");
        toast(`Document ${b.dataset.a}.`); run();
      }));
      setRecords(`Records: ${rows.length}`);
    };
    $("#vInq").onclick = run;
    $("#vClose").onclick = () => (location.hash = "dashboard");
    $("#vPrev").onclick = async () => {
      const from = $("#aFrom").value, to = $("#aTo").value;
      let q = sb.from("verification_log").select("*, documents(doc_no, doc_type, party_name, amount)").order("created_at");
      if (from) q = q.gte("created_at", from + "T00:00:00");
      if (to) q = q.lte("created_at", to + "T23:59:59.999");
      const { data, error } = await q;
      if (error) return fail(error, "Could not load the audit trail");
      const rows = data || [];
      const byAct = new Map();
      rows.forEach((r) => { const t = byAct.get(r.action) || [0, 0]; t[0]++; t[1] += Number(r.documents?.amount || 0); byAct.set(r.action, t); });
      const pages = listingPages({
        title: "Verification Audit Trail Listing",
        range: `Report From: ${dmy(from)} &nbsp; to &nbsp; ${dmy(to)}`,
        cols: [
          { label: "Date", get: (r) => stamp(new Date(r.created_at)) }, { label: "Doc No", get: (r) => r.documents?.doc_no || "" },
          { label: "T", get: (r) => TCODE[r.documents?.doc_type] || "" }, { label: "Party Name", get: (r) => r.documents?.party_name || "" },
          { label: "Action", get: (r) => r.action.toUpperCase() }, { label: "By", get: (r) => r.actor_name || "" },
          { label: "Note", get: (r) => r.note || "" }, { label: "Amount", num: true, get: (r) => peso(r.documents?.amount) }
        ],
        rows,
        summary: { title: "Summary of Verification Audit Trail in Local Currency", cols: ["Action", "Count", "Amount (₱)"], rows: [...byAct].map(([a, v]) => [a.toUpperCase(), String(v[0]), peso(v[1])]), total: ["Total:", String(rows.length), peso(rows.reduce((s, r) => s + Number(r.documents?.amount || 0), 0))] },
        criteria: `Filter Options: From Date: ${from ? longDate(from) : "(none)"}\n                To Date: ${to ? longDate(to) : "(none)"}\nReport Options: Sort By: Date / Time`
      });
      openPreview("Verification Audit Trail Listing", pages);
    };
    run();
  }

  // ---------- Search & PDF417 scan ----------
  function viewSearch() {
    shell("search", "Search", `
      <div class="options">
        <fieldset class="opt" style="flex:1 1 320px"><legend>Search Data</legend>
          <form id="sForm" class="fields wide"><label for="sQ">Keyword</label>
            <input type="search" id="sQ" placeholder="Doc no, party, code, description, amount or barcode text"></form>
        </fieldset>
        <fieldset class="opt" style="flex:1 1 320px"><legend>PDF417 Barcode</legend>
          <div class="btnrow" style="margin:0">
            <button class="btn" id="sCam">Scan with Camera</button>
            <label class="btn" for="sImg" style="display:inline-block">Upload Barcode Image</label>
            <input type="file" id="sImg" accept="image/*" capture="environment" hidden>
            <button class="btn" id="sStop" hidden>Stop Camera</button>
          </div>
          <div id="sScanMsg" style="margin-top:4px;color:var(--ink-soft)">Every document carries a PDF417 code. Scan it to open the record.</div>
          <video id="sVideo" hidden playsinline muted style="width:100%;max-width:420px;margin-top:6px;border:1px solid var(--panel-line)"></video>
        </fieldset>
      </div>
      <div class="btnrow"><button class="btn primary" id="sGo">Search</button><button class="btn" id="sClose">Close</button></div>
      <div id="sResult"></div>`, "Type any part of a document number, party name or amount, or scan a document's PDF417 barcode.");
    const show = (rows) => {
      $("#sResult").innerHTML = grid({ cols: DOC_COLS, rows, onRow: true, foot: { amount: peso(rows.reduce((s, r) => s + Number(r.amount), 0)) }, empty: "No documents match that search." });
      bindGrid($("#sResult"), rows, (r) => (location.hash = "doc/" + r.id));
      setRecords(`Records: ${rows.length}`);
    };
    const search = async () => {
      const q = $("#sQ").value.trim();
      const { data, error } = await sb.rpc("search_documents", { q });
      if (error) return fail(error, "Search failed");
      show(data || []);
    };
    const openByCode = async (text) => {
      const docNo = docNoFromPayload(text);
      $("#sQ").value = docNo;
      $("#sScanMsg").textContent = `Scanned: ${text}`;
      const { data } = await sb.from("documents").select("id").eq("doc_no", docNo).maybeSingle();
      if (data) { toast(`Found ${docNo}`); location.hash = "doc/" + data.id; }
      else { toast(`No document numbered ${docNo}. Showing closest matches.`, true); search(); }
    };
    $("#sForm").onsubmit = (e) => { e.preventDefault(); search(); };
    $("#sGo").onclick = search;
    $("#sClose").onclick = () => (location.hash = "dashboard");
    $("#sImg").onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      $("#sScanMsg").textContent = "Reading barcode…";
      try { await openByCode(await decodeImageFile(f)); }
      catch (err) { $("#sScanMsg").textContent = err.message; toast(err.message, true); }
      e.target.value = "";
    };
    const stopCam = () => {
      try { S.scanReader?.reset(); } catch (_) {}
      S.scanReader = null;
      if (!$("#sVideo")) return; // already navigated away
      $("#sVideo").hidden = true; $("#sStop").hidden = true; $("#sCam").hidden = false;
    };
    $("#sStop").onclick = stopCam;
    $("#sCam").onclick = async () => {
      if (!navigator.mediaDevices?.getUserMedia) return toast("This browser cannot use the camera. Use Upload Barcode Image instead.", true);
      const reader = new window.ZXing.BrowserPDF417Reader();
      S.scanReader = reader;
      $("#sVideo").hidden = false; $("#sStop").hidden = false; $("#sCam").hidden = true;
      $("#sScanMsg").textContent = "Point the camera at the PDF417 barcode…";
      try {
        await reader.decodeFromVideoDevice(undefined, $("#sVideo"), (res) => {
          if (res && S.scanReader === reader) { stopCam(); openByCode(res.getText()); }
        });
      } catch (err) { stopCam(); fail(err, "Camera could not start"); }
    };
    window.addEventListener("hashchange", stopCam, { once: true });
    search();
  }

  // ---------- Download forms ----------
  async function viewForms() {
    shell("forms", "Download Forms", `
      ${isAdmin() ? `<form class="options" id="fmForm"><fieldset class="opt" style="flex:1 1 100%"><legend>Upload New Form (Admin)</legend>
        <div class="formgrid"><div class="fields wide">
          <label for="fmTitle">Title</label><input type="text" id="fmTitle" required placeholder="e.g. Leave Application Form">
          <label for="fmCat">Category</label><input type="text" id="fmCat" list="fmCats" value="General">
        </div><div class="fields wide"><label for="fmFile">File</label><input type="file" id="fmFile" required></div></div>
        <datalist id="fmCats"><option>General</option><option>HR</option><option>Accounts</option><option>Sales</option><option>Purchasing</option></datalist>
        <div class="btnrow"><button class="btn primary" type="submit">Upload Form</button></div></fieldset></form>` : ""}
      <div id="fmList"><div class="empty">Loading…</div></div>`, "Blank company forms. Press <b>Download</b> to save a copy.");
    const load = async () => {
      const { data, error } = await sb.from("forms").select("*").order("category").order("title");
      if (error) return fail(error, "Could not load forms");
      const rows = data || [];
      const cols = [
        { label: "Title", get: (r) => r.title }, { label: "Category", get: (r) => r.category }, { label: "File", get: (r) => r.file_name },
        { label: "Downloads", num: true, get: (r) => r.downloads }, { label: "Uploaded", get: (r) => dmy(r.created_at) },
        { label: "", html: (r) => `<button class="btn" data-dl="${r.id}">Download</button>${isAdmin() ? ` <button class="btn danger" data-rm="${r.id}">Remove</button>` : ""}` }
      ];
      $("#fmList").innerHTML = grid({ cols, rows, group: (r) => r.category, empty: isAdmin() ? "No forms yet. Upload the first one above." : "No forms have been posted yet." });
      $(".grid-group", $("#fmList"))?.replaceChildren("Company forms by category");
      $$("[data-dl]").forEach((b) => (b.onclick = async () => {
        const f = rows.find((r) => r.id === b.dataset.dl);
        const { data: s, error: e2 } = await sb.storage.from("forms").createSignedUrl(f.storage_path, 120, { download: f.file_name });
        if (e2) return fail(e2, "Could not prepare the download");
        sb.rpc("count_form_download", { p_id: f.id }).then(() => {});
        const a = document.createElement("a"); a.href = s.signedUrl; a.rel = "noopener"; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(load, 800);
      }));
      $$("[data-rm]").forEach((b) => (b.onclick = async () => {
        const f = rows.find((r) => r.id === b.dataset.rm);
        if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Confirm"; return; }
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

  // ---------- Announcements ----------
  async function viewAnnouncements() {
    shell("announcements", "Announcements", `
      ${isAdmin() ? `<form class="window" id="anForm" style="margin-bottom:10px"><div class="wtitle">Post Announcement</div><div class="wbody">
        <div class="fields wide"><label for="anTitle">Title</label><input type="text" id="anTitle" required>
        <label for="anBody">Message</label><textarea id="anBody" rows="4" required></textarea>
        <span></span><label><input type="checkbox" id="anPin"> Pin to the top</label></div></div>
        <div class="wfoot"><button class="btn primary" type="submit">Post</button></div></form>` : ""}
      <div class="box"><h3>All Announcements</h3><div class="in" id="anList">Loading…</div></div>`);
    const load = async () => {
      const { data, error } = await sb.from("announcements").select("*").order("pinned", { ascending: false }).order("published_at", { ascending: false });
      if (error) return fail(error, "Could not load announcements");
      const rows = data || [];
      $("#anList").innerHTML = rows.length ? rows.map((a) => annHtml(a).replace(/<\/div>$/, isAdmin()
        ? `<div class="btnrow"><button class="btn" data-pin="${a.id}" data-v="${a.pinned ? 0 : 1}">${a.pinned ? "Unpin" : "Pin"}</button><button class="btn danger" data-del="${a.id}">Delete</button></div></div>` : "</div>")).join("")
        : `<div class="empty">No announcements yet.</div>`;
      $$("[data-pin]").forEach((b) => (b.onclick = async () => {
        const { error: e2 } = await sb.from("announcements").update({ pinned: b.dataset.v === "1" }).eq("id", b.dataset.pin);
        if (e2) return fail(e2, "Could not update"); load();
      }));
      $$("[data-del]").forEach((b) => (b.onclick = async () => {
        if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Confirm Delete"; return; }
        const { error: e2 } = await sb.from("announcements").delete().eq("id", b.dataset.del);
        if (e2) return fail(e2, "Could not delete"); toast("Announcement deleted."); load();
      }));
      setRecords(`Announcements: ${rows.length}`);
    };
    if ($("#anForm")) $("#anForm").onsubmit = async (e) => {
      e.preventDefault();
      const title = $("#anTitle").value.trim(), body = $("#anBody").value.trim();
      if (!title || !body) return toast("Enter a title and a message.", true);
      const { error } = await sb.from("announcements").insert({ title, body, pinned: $("#anPin").checked });
      if (error) return fail(error, "Could not post");
      toast("Announcement posted."); e.target.reset(); load();
    };
    load();
  }

  // ---------- User management ----------
  async function viewUsers() {
    if (!isAdmin()) { location.hash = "dashboard"; return; }
    shell("users", "User Management", `
      <div class="options"><fieldset class="opt"><legend>Filter</legend><div class="fields">
        <label for="uStatus">Status</label><select id="uStatus"><option value="">All</option><option value="pending">Pending</option><option value="active">Active</option><option value="disabled">Disabled</option></select>
      </div></fieldset></div>
      <div id="uList"><div class="empty">Loading…</div></div>`,
      "New sign-ups arrive as <b>Pending</b>. Set a role and change the status to <b>Active</b> to let them in. Admin: everything. Staff: upload documents. Viewer: read only.");
    const load = async () => {
      let q = sb.from("profiles").select("*").order("created_at", { ascending: false });
      if ($("#uStatus").value) q = q.eq("status", $("#uStatus").value);
      const { data, error } = await q;
      if (error) return fail(error, "Could not load users");
      const rows = data || [];
      const me = S.profile.id;
      const sel = (id, field, val, opts) => `<select data-u="${id}" data-f="${field}" ${id === me ? "disabled" : ""} style="width:auto">${opts.map((o) => `<option ${o === val ? "selected" : ""}>${o}</option>`).join("")}</select>`;
      const cols = [
        { label: "Name", get: (r) => r.full_name || "" }, { label: "Email", get: (r) => r.email || "" },
        { label: "Role", html: (r) => sel(r.id, "role", r.role, ["admin", "staff", "viewer"]) },
        { label: "Status", html: (r) => sel(r.id, "status", r.status, ["pending", "active", "disabled"]) + " " + pill(r.status) },
        { label: "Joined", get: (r) => dmy(r.created_at) },
        { label: "", html: (r) => r.id === me ? "<small>You</small>" : `<button class="btn primary" data-save="${r.id}">Save</button>` }
      ];
      $("#uList").innerHTML = grid({ cols, rows });
      $(".grid-group", $("#uList"))?.replaceChildren("Portal users");
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
  async function route() {
    closePreview();
    if (!S.session) return renderLogin();
    if (!S.profile) await loadProfile();
    if (!S.profile || S.profile.status !== "active") return renderPending();
    const [key, id, extra] = (location.hash.slice(1) || "dashboard").split("/");
    switch (key) {
      case "documents": return viewDocuments();
      case "newdoc": return viewNewDoc();
      case "doc": return viewDoc(id, extra === "preview");
      case "verification": return viewVerification();
      case "search": return viewSearch();
      case "forms": return viewForms();
      case "announcements": return viewAnnouncements();
      case "users": return viewUsers();
      default: return viewDashboard();
    }
  }
  window.addEventListener("hashchange", route);

  // Supabase calls must not run inside the auth callback itself, so routing is deferred a tick.
  let booted = false;
  sb.auth.onAuthStateChange((event, session) => {
    const changedUser = (session?.user?.id || null) !== (S.session?.user?.id || null);
    S.session = session;
    if (!booted || changedUser) { booted = true; S.profile = null; setTimeout(route, 0); }
  });

  // exposed for testing barcode round-trips
  window.EMON = { drawPdf417, decodeCanvas, decodeImageFile, words, docNoFromPayload };
})();
