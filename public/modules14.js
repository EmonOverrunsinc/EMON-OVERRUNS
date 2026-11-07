/* EMON OVERRUNS E-PORTAL — 3.72: EO-OFFICE COVERAGE (ORDER COVERAGE).
   Added BEFORE delivery by the order number: premium = boxes x PHP 50 + 0.5% of the order value (EMON HASAN sets both).
   Pay by EMON HASAN's QR code (the amount under it) → upload the proof of payment → EMON HASAN approves → the coverage is
   issued (certificate PDF with EMON HASAN's signature) and a collection voucher is made by itself. Valid until 15 days
   after the delivery. The order page shows COVERED and the EXPIRES date; anyone can verify the certificate (INS-…). */
(function () {
  "use strict";
  const E = window.EO, V = (window.EO_VIEWS = window.EO_VIEWS || {});
  const { sb, S, C, esc, peso, mdy, $, $$, isAdmin, toast, fail, ic, busy, num, fullName } = E;
  // 3.76: the payment due extension of an insured order's invoice (days after its due date; insurance settings)
  let DUE = 15;
  const METHODS = { gcash: "GCash / Online", bank: "Bank Transfer / Deposit", cash: "Cash", check: "Check", other: "Other" };
  const PAID_BY = { ...METHODS, account: "ADDED TO THE CUSTOMER'S ACCOUNT" }; // 3.77
  const expireUnpaid = () => sb.rpc("ins_expire_unpaid").then(() => {}, () => {}); // 3.77: not paid in 3 days = cancelled
  const ST = { unpaid: ["pending", "WAITING FOR PAYMENT"], review: ["pending", "PAYMENT IN REVIEW"], rejected: ["rejected", "PAYMENT NOT ACCEPTED"], cancelled: ["rejected", "CANCELLED"] };
  const canW = () => isAdmin() || E.canWrite("eooffice");
  const notSet = (e) => /order_insurance|ins_box_price|does not exist|schema cache|PGRST20|42P01|42703/.test(String(e?.message || "") + (e?.code || ""));
  const needUpdate = `<div class="empty">Coverage needs the database update 3.72 (077_insurance.sql). Ask EMON HASAN to run it.</div>`;

  async function settings() {
    const { data } = await sb.from("company_settings").select("*").eq("id", 1).maybeSingle();
    if (data?.ins_due_days != null) DUE = Number(data.ins_due_days);
    return data || { ins_box_price: 50, ins_rate_pct: 0.5 };
  }
  // EMON HASAN's InstaPay QR is the default until another one is uploaded in Coverage Settings
  const DEFAULT_QR = "brand/pay-qr-instapay.png";
  const qrUrl = (s) => (s?.pay_qr_path ? E.publicUrl("branding", s.pay_qr_path) : DEFAULT_QR);
  const round2 = (n) => Math.round(num(n) * 100) / 100;
  // the premium: boxes x price per box + rate % of the order value
  const calc = (boxes, value, bp, rate) => { const a = round2(num(boxes) * num(bp)), b = round2(num(value) * num(rate) / 100); return { a, b, total: round2(a + b) }; };
  const calcHtml = (boxes, value, bp, rate) => {
    const c = calc(boxes, value, bp, rate);
    return `<table class="grid ins-calc"><tbody>
      <tr><td>${E.qtyText(boxes)} box(es) × ₱ ${peso(bp)}</td><td class="num">₱ ${peso(c.a)}</td></tr>
      <tr><td>Order value ₱ ${peso(value)} × ${num(rate)}%</td><td class="num">₱ ${peso(c.b)}</td></tr>
      <tr class="tot"><td><b>COVERAGE PREMIUM</b></td><td class="num"><b>₱ ${peso(c.total)}</b></td></tr></tbody></table>`;
  };
  // ---------- 3.72: EVA reads the payment slip (text reading runs on this device; nothing is sent away) ----------
  let ocrLib = null;
  const loadOcr = () => (ocrLib ||= new Promise((ok, bad) => {
    if (window.Tesseract) return ok(window.Tesseract);
    const sc = document.createElement("script"); sc.src = "vendor/ocr/tesseract.min.js"; sc.async = true;
    sc.onload = () => (window.Tesseract ? ok(window.Tesseract) : bad(new Error("EVA could not start the reader")));
    sc.onerror = () => { ocrLib = null; bad(new Error("EVA could not load the reader. Check the internet.")); };
    document.head.appendChild(sc);
  }));
  const moneyIn = (text) => {
    const out = new Set();
    for (const m of String(text || "").replace(/[Oo](?=[\d,.]*\d)/g, "0").matchAll(/(?:₱|PHP|Php|P)?\s?((?:\d{1,3}(?:[,\s]\d{3})+|\d+)[.,]\d{2})(?!\d)/g)) {
      const v = Number(m[1].replace(/[,\s](?=\d{3}\b)/g, "").replace(",", ".")); if (v > 0 && v < 1e8) out.add(Math.round(v * 100) / 100);
    }
    return [...out];
  };
  // the reference no of a payment slip (GCash, Maya, InstaPay, banks): after "Ref No / Reference / Trace / Transaction /
  // Confirmation", on the same line or the next; spaces inside the number are taken out. Without a label: the longest
  // number of 10 to 20 digits on the slip (not the amount, not a phone number).
  function findRef(text, amounts = []) {
    const t = String(text || "");
    const fix = (v) => v.replace(/[Oo]/g, "0").replace(/[Il|]/g, "1").replace(/[\s-]/g, "");
    const label = /(?:ref(?:erence)?\.?\s*(?:no|number|#|code|id)?|trace\.?\s*(?:no|number)?|transaction\.?\s*(?:no|number|id|ref)?|txn\.?\s*(?:no|id)?|confirmation\.?\s*(?:no|number|code)?|invoice\.?\s*no|control\.?\s*no)\.?\s*[:#.]?/ig;
    let m;
    while ((m = label.exec(t))) {
      const after = t.slice(m.index + m[0].length, m.index + m[0].length + 60).replace(/^[\s:#.]+/, "");
      const v = (after.match(/^([A-Z0-9](?:[A-Z0-9]|[ -](?=[A-Z0-9])){5,40})/i) || [])[1];
      if (v) { const r = fix(v); if (/\d{4,}/.test(r) && r.length >= 6) return r.slice(0, 40); }
    }
    const nums = [...t.matchAll(/(?<![\d.,])(\d[\d ]{8,24}\d)(?![\d.,])/g)].map((x) => x[1].replace(/\s/g, ""))
      .filter((d) => d.length >= 10 && d.length <= 20 && !/^(?:0?9\d{9}|639\d{9})$/.test(d) && !amounts.some((a) => d === String(Math.round(a * 100))));
    return nums.sort((a, b) => b.length - a.length)[0] || "";
  }
  async function evaRead(file, onStep) {
    const T = await loadOcr();
    const base = new URL("vendor/ocr/", location.href).href;
    const w = await T.createWorker("eng", 1, { workerPath: base + "worker.min.js", corePath: base, langPath: base.replace(/\/$/, ""), gzip: true,
      logger: (m) => onStep?.(m.status, m.progress) });
    try {
      const { data } = await w.recognize(file);
      const text = String(data?.text || "").replace(/[ \t]+/g, " ").trim();
      const ref = findRef(text, moneyIn(text));
      return { text, amounts: moneyIn(text), ref };
    } finally { w.terminate().catch?.(() => {}); }
  }

  // the coverage state of an insurance
  function stateOf(i) {
    if (i.status !== "active") return { k: ST[i.status]?.[0] || "pending", label: ST[i.status]?.[1] || String(i.status).toUpperCase(), rank: i.status === "review" ? 1 : i.status === "unpaid" ? 2 : 4 };
    if (!i.valid_until) return { k: "valid", label: "COVERED · VALID UNTIL 15 DAYS AFTER DELIVERY", short: "15 DAYS AFTER DELIVERY", rank: 0 };
    return i.valid_until >= E.isoToday() ? { k: "valid", label: `COVERED · EXPIRES ${mdy(i.valid_until)}`, short: mdy(i.valid_until), rank: 0 } : { k: "expired", label: `EXPIRED ${mdy(i.valid_until)}`, short: `EXPIRED ${mdy(i.valid_until)}`, rank: 3 };
  }
  const badge = (i) => { const s = stateOf(i); return `<span class="ins-badge ${s.k}">${ic(s.k === "valid" ? "shield" : s.k === "expired" ? "clock" : s.k === "rejected" ? "x" : "clock")} ${esc(s.label)}</span>`; };
  // 3.72.1: only a PREPARED order (approved by EMON HASAN), before delivery
  const eligible = (o) => o.status === "approved" && !o.delivered_at && !o.delivery_request_at;
  const FEES = [0, 10, 15]; // the bank's transfer fee on a slip is not counted

  // ======================================================================
  // The Coverage page (EO-Office): new by order no, the list (valid on top), EMON HASAN's settings
  // ======================================================================
  V.insurance = async (id) => {
    if (id) return insPage(id);
    E.shell("insurance", "Coverage", `${E.eoTabs("insurance")}<div id="insBody" class="insx">${busy()}</div>`, "Order coverage, added before delivery: boxes × ₱ 50 + 0.5% of the order value. Free exchange of mistaken items, free return of a mistaken delivery (shipping fee covered) and exchange of unsold sealed boxes, until 15 days after delivery.");
    const here = E.stillHere();
    await expireUnpaid();
    const [rs, s] = await Promise.all([sb.from("order_insurance").select("*").order("created_at", { ascending: false }).limit(1000), settings()]);
    // 3.77: the invoice no of each insured order (and of a premium billed to the account)
    const invNo = new Map();
    if (!rs.error && (rs.data || []).length) {
      const ords = await sb.from("customer_orders").select("id, invoice_id").in("id", [...new Set(rs.data.map((r) => r.order_id))]).then((r) => r.data || [], () => []);
      const ids = [...new Set([...ords.map((x) => x.invoice_id), ...rs.data.map((r) => r.invoice_id)].filter(Boolean))];
      const invs = ids.length ? await sb.from("customer_invoices").select("id, invoice_no").in("id", ids).then((r) => r.data || [], () => []) : [];
      const no = new Map(invs.map((x) => [x.id, x.invoice_no]));
      ords.forEach((x) => x.invoice_id && invNo.set(x.id, no.get(x.invoice_id)));
      rs.data.forEach((r) => { r._inv = invNo.get(r.order_id) || ""; r._prem = r.invoice_id ? no.get(r.invoice_id) || "" : ""; });
    }
    if (!here() || !$("#insBody")) return;
    if (rs.error) { $("#insBody").innerHTML = notSet(rs.error) ? needUpdate : `<div class="empty">${esc(rs.error.message)}</div>`; return; }
    const rows = (rs.data || []).map((i) => ({ ...i, _s: stateOf(i) })).sort((x, y) => x._s.rank - y._s.rank || String(x._s.rank === 0 ? x.valid_until || "9999" : "").localeCompare(String(y._s.rank === 0 ? y.valid_until || "9999" : "")) || String(y.created_at).localeCompare(String(x.created_at)));
    const n = (k) => rows.filter((r) => r._s.k === k).length;
    const collected = rows.filter((r) => r.status === "active").reduce((t, r) => t + num(r.amount), 0);
    $("#insBody").innerHTML = `<div class="tiles">
        <div class="tile"><span class="tile-ic">${ic("shield")}</span><div class="k">Valid Coverages</div><div class="v">${n("valid")}</div></div>
        <div class="tile"><span class="tile-ic">${ic("clock")}</span><div class="k">Payment in Review</div><div class="v">${rows.filter((r) => r.status === "review").length}</div></div>
        <div class="tile"><span class="tile-ic">${ic("clock")}</span><div class="k">Waiting for Payment</div><div class="v">${rows.filter((r) => r.status === "unpaid" || r.status === "rejected").length}</div></div>
        ${S.hideMoney ? "" : `<div class="tile"><span class="tile-ic">${ic("doc")}</span><div class="k">Premiums Collected</div><div class="v">₱ ${peso(collected)}</div></div>`}</div>
      ${canW() ? `<fieldset class="opt"><legend>New Coverage</legend><div class="ins-find"><input type="text" id="insNo" placeholder="Order No, e.g. OR-202611-0002" autocapitalize="characters" spellcheck="false">
        <button type="button" class="btn" id="insScan">${ic("camera")} Scan</button><button type="button" class="btn primary" id="insFind">${ic("search")} Find Order</button></div><div id="insOrder"></div></fieldset>` : ""}
      ${isAdmin() ? settingsHtml(s) : ""}
      <h3 class="sec">Coverages <small class="muted">valid first</small></h3>
      <div id="insList">${E.grid({ cols: [
        { label: "Coverage No", get: (r) => r.ins_no || "" }, { label: "Order No", get: (r) => r.order_no || "" }, { label: "Invoice No", get: (r) => r._inv || "" }, { label: "Customer", get: (r) => r.customer_name || "" },
        { label: "Boxes", num: true, get: (r) => E.qtyText(r.boxes) }, { label: "Premium (₱)", num: true, get: (r) => peso(r.amount) }, { label: "Payment", html: (r) => (r.status === "active" ? `<span class="ins-badge valid">PAID</span>` : r.status === "review" ? `<span class="ins-badge pending">TO CHECK</span>` : `<span class="ins-badge pending">NOT PAID</span>`) },
        { label: "Status", html: (r) => badge(r) }, { label: "Created", get: (r) => E.dateTime(r.created_at) }], rows, onRow: true, empty: "No coverage yet." })}</div>`;
    E.bindGrid($("#insList"), rows, (r) => (location.hash = "insurance/" + r.id));
    if (isAdmin()) bindSettings(s);
    if (!canW()) return;
    const find = async () => {
      const no = $("#insNo").value.trim().toUpperCase().replace(/^.*\|/, "");
      if (!no) return toast("Type or scan the order number.", true);
      $("#insOrder").innerHTML = busy("Finding the order");
      const { data: o } = await sb.from("customer_orders").select("*, customers(first_name, last_name, account_no)").eq("order_no", no).maybeSingle();
      if (!o) { $("#insOrder").innerHTML = `<div class="empty small">Order ${esc(no)} not found.</div>`; return; }
      const { data: open } = await sb.from("order_insurance").select("id, ins_no, status").eq("order_id", o.id).in("status", ["unpaid", "review", "active"]).limit(1);
      const c = calc(o.total_boxes, o.total_amount, s.ins_box_price, s.ins_rate_pct);
      $("#insOrder").innerHTML = `<div class="ins-ord">${E.cell("Order No", o.order_no)}${E.cell("Customer", fullName(o.customers || {}))}${E.cell("Account No", o.customers?.account_no || "")}
          ${E.cell("Order Status", String(o.status).toUpperCase())}${E.cell("Boxes", E.qtyText(o.total_boxes))}${E.cell("Order Value (₱)", peso(o.total_amount))}</div>
        ${calcHtml(o.total_boxes, o.total_amount, s.ins_box_price, s.ins_rate_pct)}
        ${open?.length ? `<div class="banner warn">Order ${esc(o.order_no)} already has coverage <a href="#insurance/${open[0].id}">${esc(open[0].ins_no)}</a>.</div>`
          : o.status === "pending" ? `<div class="banner warn">Order ${esc(o.order_no)} waits for EMON HASAN's approval: the coverage is added when it is PREPARED.</div>`
          : !eligible(o) ? `<div class="banner warn">Order ${esc(o.order_no)} is already delivered or ${esc(String(o.status).toUpperCase())}: coverage is added only before delivery.</div>`
          : `<div class="btnrow"><button type="button" class="btn primary" id="insAdd">${ic("shield")} Add Coverage · ₱ ${peso(c.total)}</button></div>`}`;
      if ($("#insAdd")) $("#insAdd").onclick = async (e) => { e.currentTarget.disabled = true; addFor(o.id); };
    };
    $("#insFind").onclick = find;
    $("#insNo").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); find(); } };
    $("#insScan").onclick = () => E.scanDialog((t) => { const m = String(t || "").match(/OR-\d{6}-\d{3,}/i); $("#insNo").value = m ? m[0].toUpperCase() : String(t || "").trim(); find(); }, { title: "Scan the Order Paper" });
  };
  async function addFor(orderId) {
    const { data, error } = await sb.rpc("request_insurance", { p_order: orderId });
    if (error) return fail(error, "Could not add the coverage");
    toast(`Coverage ${data.ins_no} added. Pay by the QR code, then submit the proof of payment.`);
    location.hash = "insurance/" + data.id;
  }

  function settingsHtml(s) {
    const q = qrUrl(s);
    return `<fieldset class="opt"><legend>Coverage Settings (EMON HASAN)</legend><div class="ins-set">
      <div class="fields"><label for="isBp">Price per Box (₱)</label><input type="number" id="isBp" min="0" step="0.01" value="${esc(s.ins_box_price ?? 50)}">
        <label for="isRate">Rate of the Order Value (%)</label><input type="number" id="isRate" min="0" max="100" step="0.001" value="${esc(s.ins_rate_pct ?? 0.5)}">
        ${s.ins_due_days != null ? `<label for="isDue">Payment Due Extension (days after the invoice due date)</label><input type="number" id="isDue" min="0" max="120" step="1" value="${esc(s.ins_due_days)}">` : ""}
        <label for="isNote">Payment Note (under the QR)</label><input type="text" id="isNote" maxlength="160" placeholder="e.g. GCASH 0917 000 0000 · EMON HASAN" value="${esc(s.pay_qr_note || "")}"></div>
      <div class="ins-qr-set"><img src="${esc(q)}" alt="Payment QR code"><small class="muted">${s.pay_qr_path ? "Uploaded QR" : "InstaPay QR (default)"}</small>
        <label class="btn" for="isQr">${ic("image")} Change Payment QR</label><input type="file" id="isQr" accept="image/*" hidden></div></div>
      <div class="btnrow"><button type="button" class="btn primary" id="isSave">${ic("check")} Save Settings</button></div></fieldset>`;
  }
  function bindSettings(s) {
    $("#isSave").onclick = async () => {
      const r = await sb.from("company_settings").update({ ins_box_price: num($("#isBp").value), ins_rate_pct: num($("#isRate").value), pay_qr_note: $("#isNote").value.trim() || null, ...($("#isDue") ? { ins_due_days: Math.round(num($("#isDue").value)) } : {}), updated_at: new Date().toISOString() }).eq("id", 1);
      if (r.error) return fail(r.error, "Could not save");
      toast("Coverage settings saved."); V.insurance();
    };
    $("#isQr").onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      const path = `PayQR_${Date.now()}.${E.extOf(f)}`;
      const up = await sb.storage.from("branding").upload(path, f, { contentType: f.type });
      if (up.error) return fail(up.error, "Upload failed");
      const r = await sb.from("company_settings").update({ pay_qr_path: path, updated_at: new Date().toISOString() }).eq("id", 1);
      if (r.error) return fail(r.error, "Could not save the QR code");
      toast("Payment QR saved."); V.insurance();
    };
  }

  // ======================================================================
  // One insurance: the order, the premium, the payment (QR + proof), the review, the coverage and its certificate
  // ======================================================================
  async function insPage(id) {
    E.shell("insurance", "Coverage", busy());
    const here = E.stillHere();
    await expireUnpaid();
    const { data: i, error } = await sb.from("order_insurance").select("*").eq("id", id).maybeSingle();
    if (!here()) return;
    if (error) { $("#main").innerHTML = notSet(error) ? needUpdate : `<div class="empty">${esc(error.message)}</div>`; return; }
    if (!i) { $("#main").innerHTML = `<div class="empty">Coverage not found. <a href="#insurance">Back to Coverage</a></div>`; return; }
    const [o, s, cv, inv, proof] = await Promise.all([
      sb.from("customer_orders").select("*, customers(first_name, last_name, account_no)").eq("id", i.order_id).maybeSingle().then((r) => r.data),
      settings(),
      i.cv_id ? sb.from("collection_vouchers").select("id, cv_no").eq("id", i.cv_id).maybeSingle().then((r) => r.data, () => null) : null,
      null, i.proof_path ? E.signedMap([i.proof_path]).then((m) => m.get(i.proof_path) || "") : ""]);
    const invoice = o?.invoice_id ? (await sb.from("customer_invoices").select("id, invoice_no").eq("id", o.invoice_id).maybeSingle()).data : inv;
    const prem = i.invoice_id ? (await sb.from("customer_invoices").select("id, invoice_no").eq("id", i.invoice_id).maybeSingle()).data : null; // 3.77: billed to the account
    if (!here()) return;
    const st = stateOf(i), q = qrUrl(s), isPdf = /\.pdf$/i.test(i.proof_path || "");
    $(".band h1") && ($(".band h1").textContent = `Coverage — ${i.ins_no}`);
    const payBox = ["unpaid", "rejected"].includes(i.status) && canW() ? `<fieldset class="opt ins-pay"><legend>Payment</legend>
        ${i.status === "rejected" ? `<div class="banner warn"><b>Payment not accepted</b>${i.review_note ? `: ${esc(i.review_note)}` : ""}. Submit the right proof again.</div>` : ""}
        ${i.pay_by && i.status === "unpaid" ? `<div class="banner warn ins-payby">${ic("clock")} <b>PAY BY ${esc(mdy(i.pay_by))}</b> — not paid within 3 days, this coverage is <b>CANCELLED automatically</b>.</div>` : ""}
        <div class="ins-choice"><div><b>1 · PAY NOW</b><small>QR code + payment slip below → a collection voucher is issued</small></div>
          <div><b>2 · ADD TO ACCOUNT</b><small>bill ₱ ${peso(i.amount)} to the customer's account as an invoice (paid later); the coverage is issued now</small>
          <button type="button" class="btn" id="ipAcct">${ic("doc")} Add to Customer Account</button></div></div>
        <div class="ins-paygrid"><div class="ins-qr"><button type="button" class="ins-qr-btn" id="ipQrBig" aria-label="Show the QR code big"><img src="${esc(q)}" alt="EMON OVERRUNS payment QR code"></button>
          <div class="btnrow center"><button type="button" class="btn small" id="ipQrZoom">${ic("eye")} Big QR</button><a class="btn small" href="${esc(q)}" download="EMON-OVERRUNS-InstaPay-QR.png">${ic("download")} Save QR</a></div>
          <div class="ins-amt"><small>SCAN WITH ANY BANK OR E-WALLET APP (INSTAPAY) · AMOUNT TO PAY</small><b>₱ ${peso(i.amount)}</b>${s.pay_qr_note ? `<span>${esc(s.pay_qr_note)}</span>` : ""}<span class="mono">Ref: ${esc(i.ins_no)}</span></div></div>
          <div><ol class="ins-steps"><li>Scan the QR code and pay <b>₱ ${peso(i.amount)}</b>.</li><li>Save the payment receipt (screenshot).</li><li>Choose the receipt in <b>Proof of Payment</b>: EVA reads the amount and the reference no, then press <b>Submit</b>.</li><li>EMON HASAN checks the payment: the coverage is issued by itself.</li></ol>
            <div id="ipEva"></div>
            <div class="fields wide"><label for="ipFile">Proof of Payment *</label><input type="file" id="ipFile" accept="image/*,application/pdf" data-scan="1">
              <label for="ipMethod">Paid By</label><select id="ipMethod">${Object.entries(METHODS).map(([k, l]) => `<option value="${k}" ${k === (i.pay_method || "gcash") ? "selected" : ""}>${l}</option>`).join("")}</select>
              <label for="ipRef">Reference No</label><input type="text" id="ipRef" maxlength="60" value="${esc(i.pay_ref || "")}" placeholder="e.g. GCash ref no"></div>
            <div class="btnrow"><button type="button" class="btn primary" id="ipSend">${ic("send")} Submit for Review</button></div></div></div></fieldset>` : "";
    const proofBox = i.proof_path ? `<fieldset class="opt"><legend>Proof of Payment</legend><div class="pgrid2 qc-head">${E.cell("Paid By", METHODS[i.pay_method] || i.pay_method || "")}${E.cell("Reference No", i.pay_ref || "")}${E.cell("Submitted", i.proof_at ? `${E.dateTime(i.proof_at)} · ${i.proof_by_name || ""}` : "")}${E.cell("Amount (₱)", peso(i.amount), "hl")}</div>
        ${i.eva_amount != null || i.issued_by_eva ? `<div class="banner ${i.issued_by_eva ? "ok" : "warn"}">${ic("ai")} <b>EVA AI</b> read <b>₱ ${peso(i.eva_amount)}</b> on the payment slip${i.issued_by_eva ? `${num(i.eva_amount) > num(i.amount) ? ` (₱ ${peso(i.amount)} + ₱ ${peso(num(i.eva_amount) - num(i.amount))} transfer fee, not counted)` : ""} — <b>STATUS: PAID</b>. The coverage was issued by itself.` : ` — STATUS: NOT PAID (premium ₱ ${peso(i.amount)}): EMON HASAN checks it.`}</div>` : i.status === "review" && i.proof_path ? `<div class="banner warn">${ic("ai")} EVA AI could not read the amount on this proof: EMON HASAN checks it.</div>` : ""}
        ${proof ? (isPdf ? `<button type="button" class="btn" id="ipOpen">${ic("eye")} Open the Proof (PDF)</button>` : `<button type="button" class="cv-receipt" id="ipOpen" aria-label="Open the proof"><img src="${esc(proof)}" alt="Proof of payment"></button>`) : ""}
        ${i.status === "review" && isAdmin() ? `<div class="fields wide" style="margin-top:10px"><label for="ipNote">EMON HASAN's note</label><input type="text" id="ipNote" maxlength="300" placeholder="needed to reject"></div>
          <div class="btnrow"><button type="button" class="btn danger" id="ipNo">${ic("x")} Reject</button><button type="button" class="btn ok" id="ipOk">${ic("check")} Payment Received · Issue Coverage</button></div>` : i.status === "review" ? `<div class="banner info">Waiting for EMON HASAN to check the payment.</div>` : ""}</fieldset>` : "";
    $("#main").innerHTML = `${E.eoTabs("insurance")}<div class="insx">
      <div class="ins-head ${st.k}"><div class="ins-seal">${ic("shield")}</div><div><small>${esc(i.ins_no)} · ORDER ${esc(i.order_no || "")}</small><b>${esc(st.label)}</b>
        <span>${esc(i.customer_name || "")} · ${E.qtyText(i.boxes)} box(es) · premium ₱ ${peso(i.amount)}</span></div>${i.status === "active" ? `<span class="ins-paidchip">${ic("check")} STATUS: PAID</span>` : ""}</div>
      ${i.status === "active" ? `<div class="btnrow"><button type="button" class="btn primary" id="ipCert">${ic("download")} Coverage Certificate (PDF)</button>${cv ? `<a class="btn" href="#collection/${cv.id}">${ic("doc")} Collection Voucher ${esc(cv.cv_no)}</a>` : ""}${prem ? `<a class="btn" href="#invoice/${prem.id}">${ic("doc")} Premium Invoice ${esc(prem.invoice_no)} (billed to the account)</a>` : ""}</div>` : ""}
      <fieldset class="opt"><legend>Order</legend><div class="pgrid2 qc-head">
        <div class="pcell"><div class="pl">Order No</div><div class="pv">${o ? `<a href="#custorder/${o.id}"><b>${esc(o.order_no)}</b></a>` : esc(i.order_no || "")}</div></div>
        ${E.cell("Customer", i.customer_name || "")}${E.cell("Account No", o?.customers?.account_no || "")}${E.cell("Order Status", o ? String(o.status).toUpperCase() : "")}
        ${E.cell("Delivered", o?.delivered_at ? E.dateTime(o.delivered_at) : "NOT YET")}${E.cell("Invoice No", invoice?.invoice_no || "")}${o?.status === "completed" ? E.cell("Covered Value (₱, as delivered)", peso(o.total_amount), "hl") : ""}
        ${o ? E.cell("Boxes (order now)", E.qtyText(o.total_boxes)) + E.cell("Order Amount now (₱)", peso(o.total_amount)) : ""}</div></fieldset>
      <fieldset class="opt"><legend>Coverage Charge (fixed)</legend>${calcHtml(i.boxes, i.order_amount, i.box_price, i.rate_pct)}<p class="muted">${esc(E.words(i.amount, "PESOS"))}</p>
        <div class="ins-due"><small>PAYMENT DUE WITH THIS COVERAGE</small><b>${esc(dueSum(o?.payment_terms))}</b><span>counted from the invoice date · benefits expire 15 days after the delivery</span></div>
        ${o && (num(o.total_amount) !== num(i.order_amount) || num(o.total_boxes) !== num(i.boxes)) ? `<div class="banner info">The order was changed after the coverage was added: now ${E.qtyText(o.total_boxes)} box(es) · ₱ ${peso(o.total_amount)}. The coverage charge stays the same (₱ ${peso(i.amount)}), fixed when it was added.</div>` : `<p class="muted">The coverage charge is fixed when it is added: it stays the same if the order changes later.</p>`}</fieldset>
      ${payBox}${proofBox}
      <fieldset class="opt"><legend>Benefits and Terms</legend>${benefitsHtml(i)}</fieldset>
      <div class="btnrow">${isAdmin() && i.status !== "active" && i.status !== "cancelled" ? `<button type="button" class="btn danger" id="ipCancel">${ic("trash")} Cancel</button>` : ""}<a class="btn" href="#insurance">Back</a></div></div>`;
    const bigQr = () => { const m = E.modal("Scan to Pay — InstaPay", `<div class="ins-qr-full"><img src="${esc(q)}" alt="Payment QR code"><b>₱ ${peso(i.amount)}</b><span>${esc(s.pay_qr_note || "")}</span><span class="mono">Ref: ${esc(i.ins_no)}</span></div>`, `<button type="button" class="btn primary" data-x>Close</button>`, { wide: true }); $("[data-x]", m.el).onclick = m.close; };
    if ($("#ipQrBig")) { $("#ipQrBig").onclick = bigQr; $("#ipQrZoom").onclick = bigQr; }
    if ($("#ipOpen")) $("#ipOpen").onclick = () => E.viewFile({ storage_path: i.proof_path, mime: isPdf ? "application/pdf" : "image/jpeg", file_name: `${i.ins_no} Proof of Payment` });
    if ($("#ipCert")) $("#ipCert").onclick = () => printCert(i, o, invoice, cv);
    if ($("#ipAcct")) $("#ipAcct").onclick = async (e) => { // 3.77: ADD TO ACCOUNT: an invoice of the premium; issued now
      const btn = e.currentTarget;
      if (!(await E.confirmBox(`Bill the premium <b>₱ ${esc(peso(i.amount))}</b> of <b>${esc(i.ins_no)}</b> to <b>${esc(i.customer_name || "the customer")}</b>'s account?<br><br>An invoice is made (on the SOA and the balance) and the coverage is issued now.`, { title: "Add to Customer Account", ok: "Add to Account" }))) return;
      btn.disabled = true;
      const { data: r, error } = await sb.rpc("ins_bill_account", { p_id: i.id });
      if (error) { btn.disabled = false; return fail(error, /ins_bill_account|schema cache|PGRST202/.test(error.message || "") ? "Run the database update 084_insurance_account.sql first" : "Could not bill it to the account"); }
      toast(`Coverage ${r.ins_no} issued · billed to the account: invoice ${r.pay_ref}.`); insPage(i.id);
    };
    // the slip: scanned with the camera or uploaded; EVA reads it at once
    let eva = null, evaFile = null;
    const readSlip = async (raw) => {
      evaFile = raw; eva = null;
      const box = $("#ipEva"); if (!box || !raw) return;
      if (/pdf/i.test(raw.type)) { box.innerHTML = `<div class="banner warn">${ic("ai")} EVA reads photos only: this PDF goes to EMON HASAN to check.</div>`; return; }
      const url = URL.createObjectURL(raw);
      box.innerHTML = `<div class="eva-read"><img src="${esc(url)}" alt="Payment slip"><div><b>${ic("ai")} EVA is reading the payment slip…</b><div class="ga-bar"><i id="ipEvaBar"></i></div><small id="ipEvaStep">Starting</small></div></div>`;
      try {
        const r = await evaRead(raw, (st, pr) => { const b = $("#ipEvaBar"), t = $("#ipEvaStep"); if (b) b.style.width = `${Math.round((pr || 0) * 100)}%`; if (t) t.textContent = st || ""; });
        if (evaFile !== raw || !$("#ipEva")) return;
        const fee = (a) => FEES.find((f) => Math.abs(a - num(i.amount) - f) < 0.009);
        const hit = [...r.amounts].sort((a, b) => fee(a) - fee(b)).find((a) => fee(a) != null);
        eva = { ...r, matched: hit != null, amount: hit ?? (r.amounts.length ? Math.max(...r.amounts) : null), fee: hit != null ? fee(hit) : 0 };
        if (r.ref) { $("#ipRef").value = r.ref.slice(0, 60); $("#ipRef").classList.add("eva-filled"); }
        $("#ipEva").innerHTML = `<div class="eva-read ${eva.matched ? "ok" : "no"}"><img src="${esc(url)}" alt="Payment slip"><div>
          <b>${ic(eva.matched ? "check" : "x")} ${eva.matched ? `EVA READ ₱ ${peso(hit)}${eva.fee ? ` (₱ ${peso(i.amount)} + ₱ ${peso(eva.fee)} transfer fee)` : ""} — STATUS: PAID` : r.amounts.length ? `EVA READ ₱ ${r.amounts.map(peso).join(", ₱ ")} — STATUS: NOT PAID (premium ₱ ${peso(i.amount)})` : "EVA COULD NOT READ AN AMOUNT — STATUS: TO CHECK"}</b>
          <small>${eva.matched ? "Press Submit: the coverage is issued at once." : "You can still submit: EMON HASAN checks the payment."}${r.ref ? ` · Reference no <b>${esc(r.ref)}</b> filled in by EVA` : " · Reference no not found: type it"}</small></div></div>`;
      } catch (err) { if ($("#ipEva")) $("#ipEva").innerHTML = `<div class="banner warn">${ic("ai")} EVA could not read it (${esc(err.message)}). Submit it: EMON HASAN checks the payment.</div>`; }
    };
    if ($("#ipFile")) $("#ipFile").onchange = (e) => readSlip(e.target.files[0]);
    if ($("#ipSend")) $("#ipSend").onclick = async (e) => {
      const raw = $("#ipFile").files[0] || evaFile;
      if (!raw) { $("#ipFile").focus(); return toast("Scan or upload the payment slip.", true); }
      const btn = e.currentTarget; btn.disabled = true; toast("Uploading the proof…");
      const f = /pdf/i.test(raw.type) ? raw : await E.slimFile(raw, "photo");
      const path = `insurance/${i.id}/proof_${Date.now()}.${E.extOf(f)}`;
      const up = await sb.storage.from("records").upload(path, f, { contentType: f.type || "image/jpeg" });
      if (up.error) { btn.disabled = false; return fail(up.error, "Upload failed"); }
      const { error: e2 } = await sb.rpc("submit_insurance_payment", { p_id: i.id, p_path: path, p_method: $("#ipMethod").value, p_ref: $("#ipRef").value.trim() });
      if (e2) { btn.disabled = false; sb.storage.from("records").remove([path]).then(() => {}, () => {}); return fail(e2, "Could not submit"); }
      if (eva && eva.text) {
        const { data: r2 } = await sb.rpc("eva_issue_insurance", { p_id: i.id, p_amount: eva.amount, p_text: eva.text.slice(0, 2000) });
        if (r2?.status === "active") return paidCard(r2);
      }
      toast("Proof of payment submitted. EMON HASAN will check it."); insPage(i.id);
    };
    // PAYMENT RECEIVED: the coverage is issued (EVA matched the amount)
    const paidCard = (r) => {
      const st2 = stateOf(r);
      const m = E.modal("Payment Received", `<div class="ins-paid"><div class="ins-seal big">${ic("check")}</div><b>PAYMENT RECEIVED</b>
        <span>₱ ${peso(r.amount)}${num(r.eva_amount) > num(r.amount) ? ` (slip ₱ ${peso(r.eva_amount)} with ₱ ${peso(num(r.eva_amount) - num(r.amount))} transfer fee)` : ""} · read and verified by EVA AI</span><div class="ins-paid-cov">${ic("shield")} YOUR COVERAGE IS ISSUED<small>${esc(r.ins_no)} · ORDER ${esc(r.order_no || "")}</small><em>${r.valid_until ? `EXPIRES ${esc(mdy(r.valid_until))}` : "VALID UNTIL 15 DAYS AFTER DELIVERY"}</em></div>
        <small class="muted">A collection voucher was made by itself. EMON HASAN can see what EVA read.</small></div>`,
        `<button type="button" class="btn primary" data-x>${ic("download")} Open the Coverage</button>`);
      $("[data-x]", m.el).onclick = () => { m.close(); insPage(r.id); };
      toast(`Payment received. Coverage ${r.ins_no} issued — ${st2.label}.`);
    };
    const decide = async (action) => {
      const note = $("#ipNote").value.trim();
      if (action === "reject" && !note) { $("#ipNote").focus(); return toast("Write why the payment is not accepted.", true); }
      if (action === "approve" && !(await E.confirmBox(`Payment of <b>₱ ${peso(i.amount)}</b> received for <b>${esc(i.ins_no)}</b>?<br><br>The coverage is issued now (certificate with your signature) and a collection voucher is made by itself.`, { title: "Issue Coverage", ok: "Issue Coverage" }))) return;
      const { error: e2 } = await sb.rpc("decide_insurance", { p_id: i.id, p_action: action, p_note: note || null });
      if (e2) return fail(e2, "Could not save");
      toast(action === "approve" ? `Coverage ${i.ins_no} issued. The collection voucher was made.` : "Payment not accepted: sent back."); insPage(i.id);
    };
    if ($("#ipOk")) $("#ipOk").onclick = () => decide("approve");
    if ($("#ipNo")) $("#ipNo").onclick = () => decide("reject");
    if ($("#ipCancel")) $("#ipCancel").onclick = async () => {
      if (!(await E.confirmBox(`Cancel coverage <b>${esc(i.ins_no)}</b>?`, { ok: "Cancel Coverage", danger: true }))) return;
      const { data: gone, error: e2 } = await sb.rpc("cancel_insurance", { p_id: i.id });
      if (e2) return fail(e2, "Could not cancel");
      if (gone) sb.storage.from("records").remove([gone]).then(() => {}, () => {});
      toast("Cancelled."); location.hash = "insurance";
    };
    E.setRecords?.(`Coverage: ${i.ins_no}`);
  }

  // the coverage, in insurance wording (screen and certificate)
  const benefitsHtml = (i) => `<div class="ins-terms"><h4>WHAT IS COVERED</h4><ol>
      <li><b>WRONG ITEM:</b> an item delivered that is not in the order (wrong style, size, colour or quality) is exchanged free of charge.</li>
      <li><b>WRONG BUNDLE:</b> a bundle with the wrong items or the wrong number of pieces is exchanged or completed free of charge.</li>
      <li><b>WRONG BOX:</b> a box delivered by mistake (not in the order, or meant for another customer) is collected and replaced free — ${esc(C.company.name)} pays the shipping fee both ways.</li>
      <li><b>WRONG QUANTITY:</b> boxes or pieces missing against the order and the delivery list are delivered free or credited to the account.</li>
      <li><b>UNSOLD BOXES:</b> sealed boxes not sold can be returned and exchanged for new items of the same value.</li>
      <li><b>PAYMENT DUE EXTENSION:</b> the invoice of this order gets <b>${DUE} more days</b> to pay after its due date (e.g. ordered NOV 15 on 15 DAYS terms: due NOV 30 → <b>DEC 15</b>).</li></ol>
    <h4>POLICY PERIOD</h4><ol>
      <li><b>BENEFITS EXPIRE:</b> from the date of issue until <b>15 days after the delivery</b>${i?.valid_until ? ` (<b>${esc(mdy(i.valid_until))}</b>)` : ""}. No claim is accepted after that.</li>
      <li><b>PAYMENT DUE EXTENSION:</b> the invoice due date (from the terms: 7, 15 or 30 days) <b>+ ${DUE} days</b>${i?._due ? ` (<b>${esc(mdy(i._due.base))} → ${esc(mdy(i._due.ext))}</b>)` : ""}.</li></ol>
    <h4>CONDITIONS</h4><ol>
      <li>The box must be kept <b>SEALED</b> as delivered. <b>An opened box cannot be claimed</b> (the seal and the box serial no are checked against the delivery list).</li>
      <li>Only the covered boxes of order ${esc(i?.order_no || "")} are covered. Every exchange is for items of the same value; there is no cash refund.</li></ol>
    <h4>EXCLUSIONS — NOT COVERED</h4><ol>
      <li>Damage, loss or theft after delivery; opened boxes; items already sold; change of mind; any claim after the expiry date.</li></ol>
    <h4>CLAIMS AND PREMIUM</h4><ol>
      <li>To claim, contact the office of ${esc(C.company.name)} with the certificate no and the box serial nos before the expiry date.</li>
      <li>The premium is not refundable once the coverage is issued. This coverage is a service of ${esc(C.company.name)} under the Customer Agreement accepted in the E-Portal.</li></ol></div>`;

  // ---------- the certificate (PDF) ----------
  // 3.73.4: VERIFIED BY EVA AI (or the person who checked the slip by hand) and ISSUED BY the person who approved it
  // (EMON HASAN when EVA AI issued it by itself), with the signature.
  const DIRECTOR = "EMON HASAN";
  function certSigners(i) {
    const approver = (!i.issued_by_eva && String(i.approved_by_name || "").split(" · ").pop().trim()) || DIRECTOR;
    return { approver, verified: { name: i.issued_by_eva ? "EVA AI" : approver, note: "" }, issued: { name: approver, note: `Coverage issued · ${E.dateTime(i.approved_at)}` } };
  }
  // 3.76: the invoice due date of an insured order: before and after the extension
  const plusDays = (iso, n) => { const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  async function dueOf(invoice) {
    if (!invoice?.id) return null;
    const [b, c] = await Promise.all([sb.from("invoice_balances").select("due_date").eq("id", invoice.id).maybeSingle(), sb.from("customer_invoices").select("*").eq("id", invoice.id).maybeSingle()]);
    const ext = b.data?.due_date, days = Number(c.data?.due_extension_days || 0);
    return ext && days ? { base: plusDays(ext, -days), ext, days } : null;
  }
  // 3.78: the payment terms in days (7 DAYS -> 7; COD -> 0; other words -> null)
  const termsDays = (t) => { const m = String(t || "").toUpperCase().match(/^(\d{1,3}) DAYS$/); return m ? Number(m[1]) : /^COD$|CASH/i.test(String(t || "").trim()) ? 0 : null; };
  // the due days of an insured order, in words: 7 DAYS TERMS + 15 DAYS COVERAGE = 22 DAYS
  const dueSum = (terms) => { const d = termsDays(terms); return d == null ? `TERMS + ${DUE} DAYS COVERAGE` : `${d} DAYS TERMS + ${DUE} DAYS COVERAGE = ${d + DUE} DAYS`; };

  // ---------- 3.78 the certificate: EMON OVERRUNS document design (navy band, gold lines, field boxes), A4 landscape,
  // A4 portrait, 1 page like an original certificate of insurance: FRONT = the schedule; BACK = the policy wording ----------
  async function printCert(i, o, invoice, cv) {
    await E.loadSignatures?.().catch(() => {});
    await settings().catch(() => {});
    const st = stateOf(i), c = o?.customers || {}, ok = st.k === "valid";
    const who = certSigners(i);
    const sign = E.approvedBy(i.issued_by_eva ? null : i.approved_by, who.approver, i.approved_at) || { name: who.approver, at: i.approved_at, pic: "" };
    i = { ...i, _due: await dueOf(invoice) };
    const until = i.valid_until ? mdy(i.valid_until) : "15 DAYS AFTER DELIVERY";
    const name = i.customer_name || fullName(c), boxes = `${E.qtyText(i.boxes)} ${Number(i.boxes) === 1 ? "BOX" : "BOXES"}`;
    const covered = o?.status === "completed" ? o.total_amount : i.order_amount;
    const terms = o?.payment_terms || "", td = termsDays(terms);
    const dueDate = i._due ? mdy(i._due.ext) : "COUNTED FROM THE INVOICE DATE";
    const v = (x) => (x === "" || x == null ? "&nbsp;" : esc(x));
    const fld = (label, value, cls = "") => `<div class="c2-fld ${cls}"><small>${esc(label)}</small><b>${v(value)}</b></div>`;
    const sec = (t, right = "") => `<div class="c2-sec"><span>${esc(t)}</span>${right ? `<em>${esc(right)}</em>` : ""}</div>`;
    const kv = (rows) => `<table class="c2-kv">${rows.map(([k, x, cls = ""]) => `<tr class="${cls}"><th>${esc(k)}</th><td>${v(x)}</td></tr>`).join("")}</table>`;
    const band = (title, right) => `<div class="c2-band"><div class="c2-logo">${E.logoHtml("c2-logo-img")}</div>
      <div class="c2-co"><b>${esc(C.company.name)}</b><span class="c2-tag">Factory Branded Overruns &nbsp;|&nbsp; Est. 2023</span><span>${esc(C.company.address.join(", "))} &nbsp;·&nbsp; ${esc(C.company.email)}${E.siteText()}</span></div>
      <div class="c2-title"><b>${title}</b><i></i>${right}</div></div><div class="c2-gold"></div>`;
    // 3.78.2: a PDF417 barcode of the order no / the invoice no (scanned, it opens the record)
    const codeBox = (label, payload, text) => `<div class="c2-sig"><div class="c2-sec"><span>${esc(label)}</span></div><div class="c2-sigbox c2-code">
      ${payload ? `<img class="c2-codebar" src="${E.pdf417DataUrl(payload)}" alt="PDF417 barcode: ${esc(text)}">` : ""}<b class="mono">${v(text)}</b></div></div>`;
    const sig = (label, p, pic) => `<div class="c2-sig"><div class="c2-sec"><span>${esc(label)}</span></div><div class="c2-sigbox">
      ${pic ? `<img class="c2-esig" src="${esc(pic)}" alt="Signature">` : ""}<div class="c2-line"></div><b>${v(p.name)}</b><small>${esc(p.note || "Signature over Printed Name / Date")}</small></div></div>`;
    const rows = [
      ["WRONG ITEM", "An item not in the order (style, size, colour or quality)", "Free exchange"],
      ["WRONG BUNDLE", "A bundle with the wrong items or the wrong number of pieces", "Exchanged or completed free"],
      ["WRONG BOX", "A box delivered by mistake or meant for another customer", "Collected and replaced · shipping both ways paid"],
      ["WRONG QUANTITY", "Boxes or pieces missing against the order and the delivery list", "Delivered free or credited"],
      ["UNSOLD BOXES", "Sealed boxes not sold", "Exchanged for new items of the same value"],
      ["PAYMENT DUE EXTENSION", "Extra days to pay the invoice of this order", `+${DUE} days after the terms`]];
    const front = `<div class="c2 ${st.k}"><div class="c2-wm">${ic("shield")}</div>
      ${band("COVERAGE CERTIFICATE", `<div class="c2-no"><small>CERT. NO.</small><span>${esc(i.ins_no)}</span></div><div class="c2-orig">ORIGINAL</div>`)}
      <div class="c2-fields">
        ${fld("CUSTOMER", name, "w2")}${fld("ACCOUNT NO.", c.account_no || "")}${fld("DATE ISSUED", i.issued_at ? mdy(i.issued_at) : "")}
        ${fld("ORDER NO.", i.order_no || "")}${fld("INVOICE NO.", invoice?.invoice_no || (o?.status === "completed" ? "" : "AFTER DELIVERY"))}${fld("BOXES COVERED", boxes)}${fld("COVERED VALUE", `PHP ${peso(covered)}${o?.status === "completed" ? " · AS DELIVERED" : ""}`)}
      </div>
      <div class="c2-main">
        <div class="c2-left">
          ${sec("SCHEDULE OF COVERAGE", ok ? "STATUS: COVERED" : `STATUS: ${st.label}`)}
          <table class="c2-tbl"><thead><tr><th>#</th><th>COVERAGE</th><th>WHAT IS COVERED</th><th>BENEFIT</th></tr></thead>
            <tbody>${rows.map((r, k) => `<tr><td>${k + 1}</td><td><b>${esc(r[0])}</b></td><td>${esc(r[1])}</td><td>${esc(r[2])}</td></tr>`).join("")}</tbody></table>
          <div class="c2-dates">
            <div class="c2-date"><small>BENEFITS EXPIRE · CLAIMS UNTIL</small><b>${esc(until)}</b><span>15 days after the delivery · no claim is accepted after this date</span></div>

          </div>
        </div>
        <div class="c2-right"><div>
          ${sec("PREMIUM")}
          ${kv([["CALCULATION", `${boxes} × PHP ${peso(i.box_price)} + ${num(i.rate_pct)}%`], ["PREMIUM", `PHP ${peso(i.amount)}`, "tot"], ["IN WORDS", E.words(i.amount, "PESOS")],
            ["PAID BY", PAID_BY[i.pay_method] || i.pay_method || ""], ...(i.pay_method === "account" ? [["PREMIUM INVOICE", i.pay_ref || ""]] : [["REFERENCE NO.", i.pay_ref || ""], ["COLLECTION VOUCHER", cv?.cv_no || ""]])])}
          </div><div>${sec("PAYMENT DUE")}
          <div class="c2-eq">
            <div class="c2-eqb"><b>${td == null ? esc(terms || "—") : `${td}`}</b><small>${td == null ? "TERMS" : "DAYS · TERMS"}</small></div><i>+</i>
            <div class="c2-eqb"><b>${DUE}</b><small>DAYS · COVERAGE</small></div><i>=</i>
            <div class="c2-eqb tot"><b>${td == null ? "—" : td + DUE}</b><small>DAYS TO PAY</small></div>
          </div>
          <div class="c2-eqdue"><small>DUE DATE</small><b>${esc(i._due ? mdy(i._due.ext) : "COUNTED FROM THE INVOICE DATE")}</b></div>
          <div class="c2-ver"><img src="${E.qrDataUrl(E.verifyUrl(i.ins_no))}" alt="QR code: verify" class="c2-qr"><div><b>VERIFY THIS CERTIFICATE</b><span>Scan the QR code or enter ${esc(i.ins_no)} at ${esc(E.siteName?.() || "emonoverruns.online")}</span>
            <img src="${E.pdf417DataUrl("EMONINS|" + i.ins_no)}" alt="" class="c2-bar"></div></div>
        </div></div>
      </div>
      <div class="c2-decl">${sec("CERTIFICATION")}
        <p><b>THIS IS TO CERTIFY</b> that the customer named above is covered by the EO-OFFICE COVERAGE of ${esc(C.company.name)} for the <b>${esc(boxes)}</b> of order <b>${esc(i.order_no || "")}</b>, with a covered value of <b>PHP ${peso(covered)}</b>, for the benefits in the Schedule of Coverage, from <b>${esc(i.issued_at ? mdy(i.issued_at) : "")}</b> until the benefits expire on <b>${esc(until)}</b>, and that the invoice of this order is payable within <b>${esc(td == null ? `its terms + ${DUE} days` : `${td + DUE} days (${td} days terms + ${DUE} days coverage)`)}</b>, subject to the terms and conditions of the EO-OFFICE COVERAGE.</p>
        <p><b>IN WITNESS WHEREOF</b>, ${esc(C.company.name)} has caused this certificate to be signed by its authorized signatory at Pasay City, Metro Manila, Philippines, on <b>${esc(i.approved_at ? mdy(i.approved_at) : mdy(E.isoToday()))}</b>.</p></div>
      <div class="c2-sigs">
        ${codeBox("ORDER NO.", i.order_no ? "EMONCO|" + i.order_no : "", i.order_no || "")}
        ${codeBox("INVOICE NO.", invoice?.invoice_no ? "EMONINV|" + invoice.invoice_no : "", invoice?.invoice_no || "AFTER DELIVERY")}
        ${sig("ISSUED BY", { name: who.approver, note: `Authorized Signatory · ${i.approved_at ? mdy(i.approved_at) : ""}` }, sign.pic)}
      </div>
      <div class="c2-foot"><span>This certificate is valid only when its number is verified by the QR code. The terms of the EO-OFFICE COVERAGE in the E-Portal form part of this certificate.</span><span>${esc(C.company.name)} &nbsp;|&nbsp; Pasay City, Metro Manila</span></div></div>`;
    E.openPreview(`Coverage Certificate ${i.ins_no}`, [front], { bare: true }); // 3.78.3: 1 page, A4 portrait
  }

  // ======================================================================
  // On the customer order page: COVERED badge with the EXPIRES date, or Add Coverage before delivery
  // ======================================================================
  async function insOrderStrip(o, el) {
    if (!el || !o) return;
    const { data, error } = await sb.from("order_insurance").select("*").eq("order_id", o.id).neq("status", "cancelled").order("created_at", { ascending: false }).limit(1);
    if (error || !el.isConnected) return;
    const i = data?.[0];
    if (i) { el.innerHTML = ""; return; } // 3.87: an order with coverage shows only the badge at the top (COVERED · due date · claims)
    if (!eligible(o) || !canW()) return;
    const s = await settings(); if (!el.isConnected) return;
    const c = calc(o.total_boxes, o.total_amount, s.ins_box_price, s.ins_rate_pct);
    el.innerHTML = `<div class="ins-strip none"><span class="ins-seal">${ic("shield")}</span><span><small>NO COVERAGE</small><b>Protect this order before delivery</b></span>
      <button type="button" class="btn primary small" id="coInsAdd">${ic("shield")} Add Coverage · ₱ ${peso(c.total)}</button></div>`;
    $("#coInsAdd").onclick = async (e) => { e.currentTarget.disabled = true; addFor(o.id); };
  }

  // ---------- Verification: an insurance certificate (INS-…) or an order with coverage (OR-…) ----------
  async function insVerify(code) {
    const t = String(code || "").trim().replace(/^EMONINS\|/i, "");
    if (!/^(INS|OR)-/i.test(t)) return null;
    const { data, error } = await sb.rpc("verify_insurance", { p_code: t });
    if (error || !data?.found) return null;
    const ok = data.state !== "EXPIRED";
    return `<div class="${ok ? "vf-ok" : "vf-bad"}"><div class="vf-seal">${ic("shield")}</div><div class="vf-title">COVERAGE ${ok ? "FOUND" : "EXPIRED"}</div>
      <div class="vf-sub"><b>${esc(data.state === "VALID" ? `VALID UNTIL ${mdy(data.valid_until)}` : data.state === "EXPIRED" ? `EXPIRED ${mdy(data.valid_until)}` : data.state)}</b></div>
      <table class="grid vf-ins"><tbody><tr><th>Certificate No</th><td>${esc(data.ins_no)}</td></tr><tr><th>Order No</th><td>${esc(data.order_no || "")}</td></tr>
        <tr><th>Customer</th><td>${esc(data.customer || "")}</td></tr><tr><th>Boxes Covered</th><td>${E.qtyText(data.boxes)}</td></tr>
        <tr><th>Issued</th><td>${esc(E.dateTime(data.issued_at))}</td></tr><tr><th>Delivered</th><td>${data.delivered ? "YES" : "NOT YET"}</td></tr></tbody></table>
      <small>Checked ${esc(E.dateTime(new Date().toISOString()))} · ${esc(E.APP)}</small></div>`;
  }

  // ---------- 3.72: ADD COVERAGE on the new order form (below all the items) ----------
  async function insOffer(el, readLines, onToggle) {
    if (!el || !canW()) return;
    if (!isAdmin()) { el.innerHTML = `<div class="ins-strip none"><span class="ins-seal">${ic("shield")}</span><span><small>COVERAGE</small><b>Add coverage when EMON HASAN approves this order (PREPARED), before delivery</b></span></div>`; return; }
    const { data: s, error } = await sb.from("company_settings").select("ins_box_price, ins_rate_pct").eq("id", 1).maybeSingle();
    if (error || !s || !el.isConnected) return; // the server has not 077 yet
    el.innerHTML = `<label class="ins-offer" for="coInsOn"><input type="checkbox" id="coInsOn"><span class="ins-seal">${ic("shield")}</span>
      <span class="ins-offer-txt"><b>ADD COVERAGE <i>recommended</i></b><small>Free exchange of mistaken items · free return of a mistaken delivery (shipping fee covered) · exchange of unsold sealed boxes · valid until 15 days after delivery</small>
        <small class="ins-offer-calc" id="coInsCalc"></small></span><span class="ins-offer-amt" id="coInsAmt">₱ 0.00</span></label>`;
    const update = () => {
      const ls = readLines() || [];
      const boxes = ls.reduce((t, l) => t + num(l.boxes), 0), value = ls.reduce((t, l) => t + (num(l.amount) || num(l.qty) * num(l.price)), 0);
      const c = calc(boxes, value, s.ins_box_price, s.ins_rate_pct);
      $("#coInsAmt").textContent = `₱ ${peso(c.total)}`;
      $("#coInsCalc").textContent = `${E.qtyText(boxes)} box(es) × ₱ ${peso(s.ins_box_price)} + ${num(s.ins_rate_pct)}% of ₱ ${peso(value)}`;
    };
    update();
    const form = el.closest("form"); ["input", "change", "click"].forEach((ev) => form?.addEventListener(ev, () => setTimeout(update, 0)));
    $("#coInsOn").onchange = (e) => { el.querySelector(".ins-offer").classList.toggle("on", e.target.checked); onToggle(e.target.checked); };
  }

  // ---------- 3.73.4: the coverage on the invoice and the order (information only; the premium is fixed when issued and
  // is not added to the invoice; if the order changes later, the premium stays the same) ----------
  async function insForOrder(orderId) {
    const { data, error } = await sb.from("order_insurance").select("*").eq("order_id", orderId).eq("status", "active").limit(1);
    return error ? null : data?.[0] || null;
  }
  async function insForInvoice(invoiceId) {
    const { data: o, error } = await sb.from("customer_orders").select("id").eq("invoice_id", invoiceId).limit(1);
    return error || !o?.[0] ? null : insForOrder(o[0].id);
  }
  const insNote = "Paid separately · fixed when issued · not added to this invoice (stays the same if the order changes)";
  const insBox = (i) => !i ? "" : `<a class="ins-strip valid ins-inv" href="#insurance/${i.id}"><span class="ins-seal">${ic("shield")}</span><span><small>COVERAGE ${esc(i.ins_no)} · STATUS: PAID</small>
      <b>Coverage ₱ ${peso(i.amount)}</b><span class="ins-note">${esc(insNote)}</span></span><span class="ins-exp"><small>BENEFITS EXPIRE</small><b>${esc(stateOf(i).short || "")}</b><small>PAYMENT DUE +${DUE} DAYS</small></span></a>`;
  const insPrintBox = (i) => !i ? "" : E.box("Coverage", `<div class="prow3">${E.cell("Certificate No", i.ins_no)}${E.cell("Coverage Amount (₱)", peso(i.amount))}${E.cell("Benefits Expire", i.valid_until ? mdy(i.valid_until) : "15 DAYS AFTER DELIVERY")}</div><div class="prow3">${E.cell("Payment Due Extension", `+${DUE} DAYS AFTER THE DUE DATE`)}</div>
      <div class="pcell"><div class="pl">Note</div><div class="pv">STATUS: PAID · ${esc(insNote.toUpperCase())}</div></div>`);

  // 3.78.2: a small COVERED badge at the top of the order page and the invoice page: the extended DUE DATE and the
  // CLAIMS UNTIL date; pressed, it opens the insurance
  async function insMini(el, { orderId, invoiceId, terms, invoiceDue } = {}) {
    if (!el) return;
    const i = orderId ? await insForOrder(orderId) : invoiceId ? await insForInvoice(invoiceId) : null;
    if (!i || !el.isConnected) return;
    await settings().catch(() => {});
    let due = invoiceDue || null;
    if (!due) {
      const { data: o } = await sb.from("customer_orders").select("invoice_id, payment_terms").eq("id", i.order_id).maybeSingle();
      terms = terms || o?.payment_terms;
      if (o?.invoice_id) due = (await dueOf({ id: o.invoice_id }))?.ext || null;
    }
    if (!el.isConnected) return;
    const st = stateOf(i);
    // 3.87: the wording: COVERED · the coverage no, the payment due date with the coverage days, and the last day for claims
    el.innerHTML = `<a class="ins-mini ${st.k}" href="#insurance/${i.id}" title="Open coverage ${esc(i.ins_no)}">${ic("shield")}<span><b>${st.k === "valid" ? "COVERED" : esc(st.label)} <em>${esc(i.ins_no)}</em></b>
      <small>PAYMENT DUE: ${esc(due ? `${mdy(due)} (+${DUE} DAYS)` : dueSum(terms))}</small><small>CLAIMS UNTIL: ${esc(i.valid_until ? mdy(i.valid_until) : "15 DAYS AFTER DELIVERY")}</small></span></a>`;
  }

  Object.assign(E, { insMini, insCert: printCert, insDueOf: dueOf, insOrderStrip, insVerify, insOffer, insForOrder, insForInvoice, insBox, insPrintBox });
})();
