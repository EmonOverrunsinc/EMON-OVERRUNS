/* Emon Overruns Portal — business modules:
   Dashboard, 1 Customer, 2 Invoice, 3 Payment, 4 Credit Memo, 5 User Resolution, 7 Project, 8 Billing,
   plus My Photo and Company Logo. Uses helpers shared by app.js through window.EO. */
(function () {
  "use strict";
  const E = window.EO;
  const { sb, S, C, esc, peso, isoToday, dmy, stamp, $, $$, isAdmin, isStaff, pill, toast, fail, words } = E;
  const V = (window.EO_VIEWS = window.EO_VIEWS || {});

  const fullName = (c) => `${c.first_name || ""} ${c.last_name || ""}`.trim();
  const METHOD = { cash: "Cash", bank_transfer: "Bank Transfer", online_transfer: "Online Transfer", deposit: "Bank Deposit" };
  const DEFECT = { fabric_damage: "Fabric Damage (Tears, Holes)", color_issue: "Color Issue", wrong_box: "Wrong Box Delivered", wrong_bundle: "Wrong Bundle", other: "Other" };
  const ACTION = { replacement: "Replacement / Exchange", refund: "Full Refund Transfer", credit: "Credit", discount: "Discount" };
  const custQr = (c) => `EMONCUST|${c.public_id}|${c.account_no}`;
  const cleanQ = (q) => String(q || "").replace(/[,%()*\\]/g, " ").trim();
  const num = (v) => Number(v || 0);
  const myName = () => S.profile.full_name || S.session.user.email;
  // randomUUID needs a secure context; fall back to getRandomValues elsewhere.
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (d) => (d ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (d / 4)))).toString(16)));

  // ---------- files (records bucket + attachments table) ----------
  // Uploaded files are renamed automatically from the record number and what they are,
  // e.g. "INV-202610-0001 Signed Copy" — no file extension is shown.
  const OWNER_NO = {
    customer: ["customers", "account_no"], invoice: ["invoices", "invoice_no"], payment: ["payments_received", "receipt_no"],
    credit_memo: ["credit_memos", "memo_no"], employee: ["employees", "employee_no"], resolution: ["resolutions", "resolution_no"],
    project: ["projects", "project_no"], project_payment: ["project_payments", "payment_no"],
    supplier: ["suppliers", "supplier_no"], supplier_payment: ["supplier_payments", "payment_no"]
  };
  async function ownerNo(ownerType, ownerId) {
    const m = OWNER_NO[ownerType];
    if (!m) return "";
    const { data } = await sb.from(m[0]).select(m[1]).eq("id", ownerId).maybeSingle();
    return data?.[m[1]] || "";
  }
  const extOf = (f) => { const m = /\.([a-z0-9]{1,5})$/i.exec(f.name || ""); return m ? m[1].toLowerCase() : (f.type || "").split("/")[1] || "bin"; };
  const slug = (t) => String(t).replace(/[^\w\-]+/g, "_");
  async function autoName(ownerType, ownerId, kind, extraIndex = 0) {
    const [no, existing] = await Promise.all([
      ownerNo(ownerType, ownerId),
      sb.from("attachments").select("id", { count: "exact", head: true }).eq("owner_type", ownerType).eq("owner_id", ownerId).eq("kind", kind)
    ]);
    const n = (existing.count || 0) + extraIndex + 1;
    const label = kind === "signed_form" && ownerType !== "customer" ? "Signed Copy" : (KIND[kind] || "File");
    return `${no ? no + " " : ""}${label}${n > 1 ? " " + n : ""}`;
  }
  async function uploadRecords(ownerType, ownerId, kind, files) {
    let failed = 0;
    for (const f of files) {
      if (f.size > 50 * 1024 * 1024) { failed++; toast("A file larger than 50 MB was skipped.", true); continue; }
      const name = await autoName(ownerType, ownerId, kind);
      const path = `${ownerType}/${ownerId}/${slug(name)}_${Date.now()}.${extOf(f)}`;
      const up = await sb.storage.from("records").upload(path, f, { contentType: f.type || "application/octet-stream" });
      if (up.error) { failed++; console.error(up.error); continue; }
      const ins = await sb.from("attachments").insert({ owner_type: ownerType, owner_id: ownerId, kind, storage_path: path, file_name: name, mime: f.type, size: f.size });
      if (ins.error) { failed++; console.error(ins.error); }
    }
    return failed;
  }
  async function signedUrl(path, secs = 600) {
    const { data, error } = await sb.storage.from("records").createSignedUrl(path, secs);
    if (error) { fail(error, "Could not open the file"); return ""; }
    return data.signedUrl;
  }
  async function attachmentsOf(ownerType, ownerId) {
    const { data } = await sb.from("attachments").select("*").eq("owner_type", ownerType).eq("owner_id", ownerId).order("created_at", { ascending: false });
    return data || [];
  }
  const KIND = { photo: "Profile Photo", requirement: "Requirement", signed_form: "Signed Application Form", receipt: "Payment Receipt", delivery_receipt: "Delivery Receipt", purchase_order: "Purchase Order", proof: "Proof", other: "Other" };
  function filesHtml(list) {
    if (!list.length) return `<div class="empty">No files uploaded.</div>`;
    return `<div class="filelist">${list.map((f) => `<div class="file"><span class="kind">${esc(KIND[f.kind] || f.kind)}</span>
      <span class="fname">${esc(f.file_name)}</span><button class="btn" data-open="${esc(f.storage_path)}" data-mime="${esc(f.mime || "")}" data-name="${esc(f.file_name)}">Preview</button></div>`).join("")}</div>`;
  }
  function bindFiles(root) {
    $$("[data-open]", root).forEach((b) => (b.onclick = () => viewFile({ storage_path: b.dataset.open, mime: b.dataset.mime, file_name: b.dataset.name })));
  }
  // In-page preview of an uploaded file (image or PDF).
  async function viewFile(f) {
    const url = await signedUrl(f.storage_path, 900);
    if (!url) return;
    const isImg = /^image\//.test(f.mime || "") || /\.(png|jpe?g|gif|webp|heic)$/i.test(f.storage_path || "");
    const isPdf = /pdf/.test(f.mime || "") || /\.pdf$/i.test(f.storage_path || "");
    const d = document.createElement("div");
    d.className = "modal viewer";
    d.innerHTML = `<div class="window" role="dialog" aria-modal="true" aria-label="Preview ${esc(f.file_name || "")}">
      <div class="wtitle">Preview — ${esc(f.file_name || "")}</div>
      <div class="viewer-body">${isImg ? `<img src="${esc(url)}" alt="${esc(f.file_name || "")}">` : isPdf ? `<iframe src="${esc(url)}" title="${esc(f.file_name || "")}"></iframe>` : `<div class="empty">This file type cannot be previewed here.</div>`}</div>
      <div class="wfoot"><a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Open / Download</a><button class="btn primary" id="vwClose">Close</button></div></div>`;
    document.body.appendChild(d);
    const close = () => { d.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    $("#vwClose", d).onclick = close;
    d.onclick = (e) => { if (e.target === d) close(); };
  }

  // "Signed Copy": print the form, sign it, upload it; from then on the signed upload is the document.
  function signedPanel(ownerType, ownerId, att, what) {
    const signed = att.filter((a) => a.kind === "signed_form");
    return `<fieldset class="opt signed"><legend>Signed Copy</legend>
      ${signed.length ? `<div class="signed-list">${signed.map((f, i) => `<div class="file"><span class="kind">${i ? "Earlier upload" : "Signed copy"}</span><span class="fname">${esc(f.file_name)} <small>${dmy(f.created_at)}</small></span>
        <button class="btn primary" data-open="${esc(f.storage_path)}" data-mime="${esc(f.mime || "")}" data-name="${esc(f.file_name)}">Preview</button></div>`).join("")}</div>`
        : `<small>Not uploaded yet. Print the ${esc(what)}, have it signed, then upload a photo or scan here.</small>`}
      ${isStaff() ? `<div class="fields wide" style="margin-top:6px"><label for="sgUp">${signed.length ? "Replace with new signed copy" : "Upload signed copy"}</label><input type="file" id="sgUp" accept="image/*,application/pdf" data-owner="${ownerType}" data-id="${ownerId}"></div>` : ""}
    </fieldset>`;
  }
  function bindSigned(root, reload) {
    const inp = $("#sgUp", root);
    if (inp) inp.onchange = async (e) => {
      const files = Array.from(e.target.files);
      if (!files.length) return;
      const f = await uploadRecords(inp.dataset.owner, inp.dataset.id, "signed_form", files);
      toast(f ? "Upload failed." : "Signed copy uploaded.", f > 0);
      reload();
    };
  }
  const latestSigned = (att) => att.filter((a) => a.kind === "signed_form").sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];

  const fileField = (id, label, opts = "") => `<label for="${id}">${label}</label><input type="file" id="${id}" ${opts}>`;
  const filesOf = (id) => Array.from(($("#" + id) || {}).files || []);

  // ---------- customer picker ----------
  // statuses: which account statuses may be chosen.
  function customerPicker(holder, { statuses, onPick, preset }) {
    holder.innerHTML = `<div class="picker">
      <div class="picker-row"><input type="search" class="pk-q" placeholder="Type name or account number" aria-label="Find customer">
      <button type="button" class="btn pk-scan">Scan QR</button></div>
      <div class="pk-list" hidden></div><div class="pk-chosen"></div></div>`;
    const q = $(".pk-q", holder), list = $(".pk-list", holder), chosen = $(".pk-chosen", holder);
    let timer = null;
    const choose = (c) => {
      list.hidden = true; q.value = "";
      chosen.innerHTML = `<div class="chosen"><b>${esc(fullName(c))}</b> <span class="mono">${esc(c.account_no)}</span> ${pill(c.status)}
        ${c.business_name ? `<small>${esc(c.business_name)}</small>` : ""}</div>`;
      onPick(c);
    };
    const search = async () => {
      const t = cleanQ(q.value);
      if (t.length < 2) { list.hidden = true; return; }
      const w = t.split(/\s+/)[0];
      let qq = sb.from("customers").select("*").or(`first_name.ilike.%${w}%,last_name.ilike.%${w}%,account_no.ilike.%${w}%,business_name.ilike.%${w}%,phone.ilike.%${w}%`).limit(20);
      if (statuses) qq = qq.in("status", statuses);
      const { data } = await qq;
      const words2 = t.toLowerCase().split(/\s+/);
      const rows = (data || []).filter((c) => words2.every((x) => `${fullName(c)} ${c.account_no} ${c.business_name || ""} ${c.phone || ""}`.toLowerCase().includes(x)));
      list.hidden = false;
      list.innerHTML = rows.length ? rows.map((c, i) => `<button type="button" data-i="${i}"><b>${esc(fullName(c))}</b> <span class="mono">${esc(c.account_no)}</span> ${pill(c.status)}</button>`).join("")
        : `<div class="empty">No ${statuses ? statuses.join(" / ") + " " : ""}customer matches.</div>`;
      $$("button", list).forEach((b) => (b.onclick = () => choose(rows[Number(b.dataset.i)])));
    };
    q.oninput = () => { clearTimeout(timer); timer = setTimeout(search, 250); };
    $(".pk-scan", holder).onclick = () => E.scanDialog(async (text) => {
      const pid = String(text).startsWith("EMONCUST|") ? String(text).split("|")[1] : null;
      let r = pid ? await sb.from("customers").select("*").eq("public_id", pid).maybeSingle() : await sb.from("customers").select("*").eq("account_no", String(text).trim()).maybeSingle();
      const c = r.data;
      if (!c) return toast("No customer found for that code.", true);
      if (statuses && !statuses.includes(c.status)) return toast(`${fullName(c)} is ${c.status.toUpperCase()} and cannot be used here.`, true);
      choose(c);
    });
    if (preset) choose(preset);
  }
  async function getCustomer(id) {
    if (!id) return null;
    const { data } = await sb.from("customers").select("*").eq("id", id).maybeSingle();
    return data;
  }

  // ---------- print helpers ----------
  function printHead(title, rightHtml = "") {
    return `<div class="ph">
      <div class="ph-left">${E.logoHtml("ph-logo")}<div><div class="ph-co">${esc(C.company.name)}</div>
        <div class="ph-addr">${esc(C.company.address.join(", "))}<br>${esc(C.company.email)} · ${esc(C.company.phone)}</div></div></div>
      <div class="ph-right">${rightHtml}</div></div>
      <div class="ph-title">${esc(title)}</div>`;
  }
  const box = (title, inner) => `<div class="pbox"><div class="pbox-h">${esc(title)}</div>${inner}</div>`;
  const cell = (label, value, cls = "") => `<div class="pcell ${cls}"><div class="pl">${esc(label)}</div><div class="pv">${value === "" || value == null ? "&nbsp;" : esc(value)}</div></div>`;
  const radio = (on, label) => `<div class="pradio"><span class="dot ${on ? "on" : ""}"></span>${esc(label)}</div>`;
  const sigs = (left, right) => `<div class="psig"><div><div class="line"></div>${left}</div><div><div class="line"></div>${right}</div></div>`;
  // Printed documents carry no status stamps; the signed copy uploaded afterwards is the record.
  const stampHtml = () => "";

  // ======================================================================
  // Dashboard
  // ======================================================================
  V.dashboard = async () => {
    E.shell("dashboard", "Dashboard", `
      <section class="hero">${E.logoHtml("hero-logo")}<div>
        <h2>${esc(C.company.name)}</h2><p>${esc(C.company.address.join(", "))}<br>${esc(C.company.email)} · ${esc(C.company.phone)}</p>
        <p class="welcome">Welcome, <b>${esc(myName())}</b> (${esc(S.profile.role.toUpperCase())})</p></div></section>
      <div class="tiles" id="dTiles">${["Active Customers", "Applications to Review", "Balance Due (₱)", "Payments This Month (₱)"].map((k) => `<div class="tile"><div class="k">${k}</div><div class="v">…</div></div>`).join("")}</div>
      <div class="quick">
        ${isStaff() ? `<a class="btn primary" href="#newcustomer">+ New Customer</a><a class="btn" href="#newinvoice">+ Record Invoice</a><a class="btn" href="#newpayment">+ Record Payment</a><a class="btn" href="#newcreditmemo">+ Credit Memo</a>` : ""}
      </div>
      <div class="cols">
        <div class="box"><h3>Applications Waiting for Review</h3><div class="in" id="dApps">Loading…</div></div>
        <div class="box"><h3>Latest Resolutions</h3><div class="in" id="dAnn">Loading…</div></div>
      </div>
      <div class="cols" style="margin-top:10px">
        <div class="box"><h3>Unpaid Invoices</h3><div class="in" id="dInv">Loading…</div></div>
        <div class="box"><h3>Recent Payments</h3><div class="in" id="dPay">Loading…</div></div>
      </div>`);
    const ym = isoToday().slice(0, 7);
    const [cust, bal, inv, pay, ann] = await Promise.all([
      sb.from("customers").select("id,first_name,last_name,account_no,application_no,status,application_date,business_name").order("created_at", { ascending: false }).limit(1000),
      sb.from("customer_balances").select("balance_due"),
      sb.from("invoice_balances").select("*").neq("pay_status", "paid").order("invoice_date", { ascending: false }).limit(8),
      sb.from("payments_received").select("*, customers(first_name,last_name,account_no)").order("created_at", { ascending: false }).limit(200),
      sb.from("resolutions").select("resolution_no,subject,body,resolution_date").order("resolution_date", { ascending: false }).limit(4)
    ]);
    if (cust.error) {
      $("#main").insertAdjacentHTML("afterbegin", `<div class="hint err">The customer database is not set up yet. Ask the administrator to run the setup script <b>002_customers_invoices_payments.sql</b>.</div>`);
      return;
    }
    const cs = cust.data || [];
    const due = (bal.data || []).reduce((s, b) => s + Math.max(0, num(b.balance_due)), 0);
    const pays = pay.data || [];
    const monthPaid = pays.filter((p) => String(p.paid_date).startsWith(ym)).reduce((s, p) => s + num(p.amount), 0);
    const waiting = cs.filter((c) => ["pending", "verified"].includes(c.status));
    const tiles = [["ok", cs.filter((c) => c.status === "active").length], ["warn", waiting.length], ["", "₱ " + peso(due)], ["ok", "₱ " + peso(monthPaid)]];
    $$("#dTiles .tile").forEach((t, i) => { t.className = "tile " + tiles[i][0]; $(".v", t).textContent = tiles[i][1]; });
    $("#dApps").innerHTML = E.grid({ cols: [
      { label: "Application", get: (r) => r.application_no }, { label: "Account No", get: (r) => r.account_no },
      { label: "Name", get: fullName }, { label: "Date", get: (r) => dmy(r.application_date) }, { label: "Status", html: (r) => pill(r.status) }],
      rows: waiting.slice(0, 8), onRow: true, empty: "No applications waiting." });
    E.bindGrid($("#dApps"), waiting.slice(0, 8), (r) => (location.hash = "customer/" + r.id));
    const invs = inv.data || [];
    $("#dInv").innerHTML = E.grid({ cols: [
      { label: "Invoice", get: (r) => r.invoice_no }, { label: "Customer", get: fullName },
      { label: "Balance (₱)", num: true, get: (r) => peso(r.balance) }, { label: "Status", html: (r) => pill(r.pay_status) }],
      rows: invs, onRow: true, empty: "No unpaid invoices." });
    E.bindGrid($("#dInv"), invs, (r) => (location.hash = "invoice/" + r.id));
    const rp = pays.slice(0, 8);
    $("#dPay").innerHTML = E.grid({ cols: [
      { label: "Receipt", get: (r) => r.receipt_no }, { label: "Customer", get: (r) => fullName(r.customers || {}) },
      { label: "Amount (₱)", num: true, get: (r) => peso(r.amount) }, { label: "Date", get: (r) => dmy(r.paid_date) }],
      rows: rp, onRow: true, empty: "No payments yet." });
    E.bindGrid($("#dPay"), rp, (r) => (location.hash = "payment/" + r.id));
    const a = ann.data || [];
    $("#dAnn").innerHTML = a.length ? a.map((x) => `<a class="ann" href="#resolutions" style="display:block;color:inherit;text-decoration:none"><h4><span class="mono">${esc(x.resolution_no)}</span> ${esc(x.subject)}</h4><div class="meta">${dmy(x.resolution_date)}</div>${x.body ? `<p>${esc(x.body.length > 160 ? x.body.slice(0, 160) + "…" : x.body)}</p>` : ""}</a>`).join("") : `<div class="empty">No resolutions in the last 3 months.</div>`;
    E.setRecords(`Customers: ${cs.length}`);
  };

  // ======================================================================
  // 1. Customer
  // ======================================================================
  V.customers = async () => {
    E.shell("customers", "Customer", `
      <div class="options"><fieldset class="opt" style="flex:1 1 320px"><legend>Search Customer</legend>
        <form id="cuForm" class="fields wide">
          <label for="cuQ">Name / Account</label><input type="search" id="cuQ" placeholder="Name, account no, business or phone">
          <label for="cuSt">Status</label><select id="cuSt"><option value="">All</option><option value="active">Active</option><option value="pending">Pending review</option><option value="verified">Verified</option><option value="suspended">Suspended</option><option value="closed">Closed</option><option value="rejected">Rejected</option></select>
        </form></fieldset></div>
      <div class="btnrow"><button class="btn primary" id="cuGo">Search</button><button class="btn" id="cuScan">Scan QR</button>
        ${isStaff() ? `<a class="btn ok" href="#newcustomer">+ New Customer</a>` : ""}</div>
      <div id="cuRes"></div>`, "All customer accounts. Closed accounts are shown here with a <b>CLOSED</b> mark but are hidden from the top search bar.");
    const run = async () => {
      const t = cleanQ($("#cuQ").value), st = $("#cuSt").value;
      let q = sb.from("customers").select("*").order("created_at", { ascending: false }).limit(1000);
      if (st) q = q.eq("status", st);
      if (t) { const w = t.split(/\s+/)[0]; q = q.or(`first_name.ilike.%${w}%,last_name.ilike.%${w}%,account_no.ilike.%${w}%,business_name.ilike.%${w}%,phone.ilike.%${w}%,public_id.ilike.%${w}%`); }
      const [{ data, error }, bal] = await Promise.all([q, sb.from("customer_balances").select("*")]);
      if (error) return fail(error, "Could not load customers");
      const bm = new Map((bal.data || []).map((b) => [b.customer_id, b]));
      const ws = t.toLowerCase().split(/\s+/).filter(Boolean);
      const rows = (data || []).filter((c) => ws.every((x) => `${fullName(c)} ${c.account_no} ${c.business_name || ""} ${c.phone || ""} ${c.public_id}`.toLowerCase().includes(x)))
        .map((c) => ({ ...c, due: num(bm.get(c.id)?.balance_due) }));
      $("#cuRes").innerHTML = E.grid({ cols: [
        { label: "Account No", get: (r) => r.account_no }, { label: "Name", html: (r) => `${esc(fullName(r))}${r.status === "closed" ? ' <span class="closed-mark">CLOSED</span>' : ""}` },
        { label: "Business", get: (r) => r.business_name || "" }, { label: "Phone", get: (r) => r.phone || "" },
        { label: "Opened", get: (r) => dmy(r.application_date) }, { label: "Status", html: (r) => pill(r.status) },
        { label: "Balance Due (₱)", key: "due", num: true, get: (r) => peso(r.due) }],
        rows, onRow: true, foot: { due: peso(rows.reduce((s, r) => s + r.due, 0)) }, empty: "No customers found." });
      E.bindGrid($("#cuRes"), rows, (r) => (location.hash = "customer/" + r.id));
      E.setRecords(`Customers: ${rows.length}`);
    };
    $("#cuForm").onsubmit = (e) => { e.preventDefault(); run(); };
    $("#cuGo").onclick = run; $("#cuSt").onchange = run;
    $("#cuScan").onclick = () => E.scanDialog(E.openScanned);
    run();
  };

  V.newcustomer = () => {
    if (!isStaff()) { toast("Only Staff and Admin users can open customer accounts.", true); location.hash = "customers"; return; }
    E.shell("newcustomer", "New Customer Application", `
      <form class="window" id="ncForm" novalidate>
        <div class="wtitle">Customer Account Application</div>
        <div class="wbody">
          <div class="summary-box"><div class="fields wide">
            <span>Application No</span><b>Assigned on submit</b>
            <span>Account No</span><b>Assigned on submit (initials-YYYYMM###)</b>
            <span>Application Date</span><b>${dmy(isoToday())}</b>
            <span>Issued By</span><b>${esc(myName())}</b></div></div>
          <fieldset class="opt"><legend>Personal Details</legend><div class="formgrid">
            <div class="fields wide">
              <label for="ncFirst">First Name *</label><input type="text" id="ncFirst" required autocomplete="given-name">
              <label for="ncLast">Last Name *</label><input type="text" id="ncLast" required autocomplete="family-name">
              <label for="ncPhone">Phone Number *</label><input type="tel" id="ncPhone" required placeholder="09xxxxxxxxx">
              <label for="ncEmail">Email Address</label><input type="email" id="ncEmail">
            </div>
            <div class="fields wide">
              <label for="ncPhoto">Profile Photo</label><input type="file" id="ncPhoto" accept="image/*">
              <span></span><div id="ncPhotoPrev" class="photo-prev">No photo</div>
            </div></div></fieldset>
          <fieldset class="opt"><legend>Full Address</legend>
            <div class="fields wide"><label for="ncAddr">Address *</label>
              <div class="addr-row"><input type="text" id="ncAddr" required placeholder="House no, street, barangay, city, province"><button type="button" class="btn" id="ncVerify">Verify Address</button></div>
              <span></span><div id="ncAddrMsg" class="addr-msg">Not checked yet.</div></div></fieldset>
          <fieldset class="opt"><legend>Business</legend><div class="fields wide">
            <label for="ncStart">Date Starting in Business</label><input type="date" id="ncStart">
            <label for="ncBiz">Business Name</label><input type="text" id="ncBiz">
          </div></fieldset>
          <fieldset class="opt"><legend>Facebook</legend><div class="fields wide">
            <label for="ncFb">Facebook Name</label><input type="text" id="ncFb">
            <span>Additional Facebook Account?</span><div class="checks"><label><input type="radio" name="ncFbx" value="no" checked> No</label><label><input type="radio" name="ncFbx" value="yes"> Yes</label></div>
            <label for="ncFb2" class="fb2" hidden>Additional Facebook Name</label><input type="text" id="ncFb2" class="fb2" hidden>
            <span>Facebook Account</span><div class="checks"><label><input type="radio" name="ncFbv" value="no" checked> Not Verified</label><label><input type="radio" name="ncFbv" value="yes"> Verified</label></div>
          </div></fieldset>
          <fieldset class="opt"><legend>Requirements</legend>
            <div class="fields wide">${fileField("ncReq", "Upload Requirements", 'multiple accept="image/*,application/pdf"')}</div>
            <small>Valid ID, business permit, proof of address, or any other requirement. You can add more later from the customer profile.</small></fieldset>
        </div>
        <div class="wfoot"><button type="button" class="btn" id="ncCancel">Cancel</button><button type="submit" class="btn primary">Submit Application</button></div>
      </form>`, "Fill in the application and press <b>Submit Application</b>. The account number, application number and QR code are created automatically.");
    let geo = null;
    $$("input[name=ncFbx]").forEach((r) => (r.onchange = () => $$(".fb2").forEach((x) => (x.hidden = r.value !== "yes" || !r.checked))));
    $("#ncPhoto").onchange = (e) => {
      const f = e.target.files[0];
      $("#ncPhotoPrev").innerHTML = f ? `<img src="${URL.createObjectURL(f)}" alt="Profile photo preview">` : "No photo";
    };
    $("#ncAddr").oninput = () => { geo = null; $("#ncAddrMsg").className = "addr-msg"; $("#ncAddrMsg").textContent = "Not checked yet."; };
    $("#ncVerify").onclick = async () => {
      const a = $("#ncAddr").value.trim();
      if (a.length < 5) return toast("Type the full address first.", true);
      const m = $("#ncAddrMsg"); m.className = "addr-msg"; m.textContent = "Checking the map…";
      geo = await verifyAddress(a);
      if (geo) { m.className = "addr-msg ok"; m.innerHTML = `✔ VERIFIED — location found: ${esc(geo.display)} <a href="https://www.openstreetmap.org/?mlat=${geo.lat}&mlon=${geo.lon}#map=17/${geo.lat}/${geo.lon}" target="_blank" rel="noopener">View map</a>`; }
      else { m.className = "addr-msg bad"; m.textContent = "✖ ADDRESS NOT FOUND — check the spelling or add the barangay and city."; }
    };
    $("#ncCancel").onclick = () => (location.hash = "customers");
    $("#ncForm").onsubmit = async (e) => {
      e.preventDefault();
      const v = (id) => $("#" + id).value.trim();
      if (!v("ncFirst") || !v("ncLast")) return toast("Enter the first and last name.", true);
      if (!v("ncPhone")) return toast("Enter the phone number.", true);
      if (!v("ncAddr")) return toast("Enter the full address.", true);
      const extra = $("input[name=ncFbx]:checked").value === "yes";
      if (extra && !v("ncFb2")) return toast("Enter the additional Facebook name, or choose No.", true);
      const btns = $$("#ncForm button"); btns.forEach((b) => (b.disabled = true));
      const id = uuid();
      let photo_path = null;
      const photo = $("#ncPhoto").files[0];
      if (photo) {
        photo_path = `customer/${id}/Profile_Photo_${Date.now()}.${extOf(photo)}`;
        const up = await sb.storage.from("records").upload(photo_path, photo, { contentType: photo.type });
        if (up.error) { photo_path = null; toast("The photo could not be uploaded; the application is saved without it.", true); }
      }
      const { data: c, error } = await sb.from("customers").insert({
        id, first_name: v("ncFirst"), last_name: v("ncLast"), photo_path, address: v("ncAddr"),
        address_verified: !!geo, address_lat: geo?.lat ?? null, address_lon: geo?.lon ?? null,
        business_start_date: v("ncStart") || null, business_name: v("ncBiz") || null,
        facebook_name: v("ncFb") || null, has_extra_facebook: extra, extra_facebook_name: extra ? v("ncFb2") : null,
        facebook_verified: $("input[name=ncFbv]:checked").value === "yes", phone: v("ncPhone"), email: v("ncEmail") || null
      }).select().single();
      if (error) { btns.forEach((b) => (b.disabled = false)); return fail(error, "Could not submit the application"); }
      if (photo_path) await sb.from("attachments").insert({ owner_type: "customer", owner_id: c.id, kind: "photo", storage_path: photo_path, file_name: `${c.account_no} Profile Photo`, mime: photo.type, size: photo.size });
      const failed = await uploadRecords("customer", c.id, "requirement", filesOf("ncReq"));
      if (failed) toast(`${failed} requirement file(s) failed to upload. You can add them from the profile.`, true);
      location.hash = `customer/${c.id}/submitted`;
    };
  };

  async function verifyAddress(a) {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ph&q=${encodeURIComponent(a)}`, { headers: { Accept: "application/json" } });
      const j = await r.json();
      if (!j.length) return null;
      return { lat: Number(j[0].lat), lon: Number(j[0].lon), display: j[0].display_name };
    } catch (_) { return null; }
  }

  function applicationPage(c, photoUrl, reqs) {
    const qr = E.qrDataUrl(custQr(c));
    const bar = E.pdf417DataUrl(c.application_no);
    return `${printHead("CUSTOMER ACCOUNT APPLICATION", `<div class="ph-codes">
        <div><img src="${bar}" alt="Application number barcode" class="ph-bar"><div class="mono">${esc(c.application_no)}</div></div>
        <div><img src="${qr}" alt="Customer QR code" class="ph-qr"><div class="mono">${esc(c.public_id)}</div></div></div>`)}
      <div class="prow3">${cell("Application No", c.application_no)}${cell("Account No", c.account_no)}${cell("Application Date", dmy(c.application_date))}</div>
      ${box("Customer Information", `<div class="pgrid">
        <div class="pphoto">${photoUrl ? `<img src="${esc(photoUrl)}" alt="">` : "PHOTO"}</div>
        <div class="pgrid2">${cell("First Name", c.first_name)}${cell("Last Name", c.last_name)}
          ${cell("Phone Number", c.phone)}${cell("Email Address", c.email)}
          ${cell("Full Address", c.address, "span2")}</div></div>`)}
      ${box("Business Start & Social", `<div class="pgrid2">
        ${cell("Date Starting in Business", dmy(c.business_start_date), "span2")}
        ${cell("Facebook Name", c.facebook_name)}${cell("Facebook Account", c.facebook_verified ? "VERIFIED" : "NOT VERIFIED")}
        ${c.has_extra_facebook ? cell("Additional Facebook", "YES — " + (c.extra_facebook_name || ""), "span2") : ""}</div>`)}
      ${box("Requirements Submitted", `<div class="pv" style="padding:6px">${reqs.length ? reqs.map((r) => "☑ " + esc(r.file_name)).join("<br>") : "None uploaded yet"}</div>`)}
      ${box("Office Use", `<div class="pgrid2">${cell("Issued By", c.issued_by_name)}${cell("Status", c.status.toUpperCase())}</div>`)}
      <p class="pdecl">I certify that the information above is true and correct, and I agree to the terms of ${esc(C.company.name)}.</p>
      ${sigs("Customer Signature over Printed Name &nbsp; / &nbsp; Date", "Approved by (Signature) &nbsp; / &nbsp; Date")}
      <div class="rp-foot"><span>Submit this signed form to the ${esc(C.company.name)} office.</span><span>${esc(c.application_no)}</span></div>`;
  }
  async function printApplication(c) {
    const att = await attachmentsOf("customer", c.id);
    const photoUrl = c.photo_path ? await signedUrl(c.photo_path, 900) : "";
    E.openPreview(`Application ${c.application_no}`, [applicationPage(c, photoUrl, att.filter((a) => a.kind === "requirement"))]);
  }

  V.customer = async (id, extra) => {
    E.shell("customer", "Customer Profile", `<div class="empty">Loading…</div>`);
    const c = await getCustomer(id);
    if (!c) { $("#main").innerHTML = `<div class="empty">Customer not found. <a href="#customers">Back to Customer list</a></div>`; return; }
    if (extra === "submitted") return renderSubmitted(c);
    const [att, bal, invs, pays, memos, ev, secret] = await Promise.all([
      attachmentsOf("customer", c.id),
      sb.from("customer_balances").select("*").eq("customer_id", c.id).maybeSingle(),
      sb.from("invoice_balances").select("*").eq("customer_id", c.id).order("invoice_date", { ascending: false }),
      sb.from("payments_received").select("*").eq("customer_id", c.id).order("paid_date", { ascending: false }),
      sb.from("credit_memos").select("*").eq("customer_id", c.id).order("memo_date", { ascending: false }),
      sb.from("customer_events").select("*").eq("customer_id", c.id).order("created_at"),
      isAdmin() ? sb.from("customer_secrets").select("private_code").eq("customer_id", c.id).maybeSingle() : Promise.resolve({ data: null })
    ]);
    const b = bal.data || { total_invoiced: 0, total_paid: 0, total_credits: 0, balance_due: 0 };
    const photoUrl = c.photo_path ? await signedUrl(c.photo_path) : "";
    const signed = att.filter((a) => a.kind === "signed_form");
    const canInvoice = c.status === "active" && isStaff();
    const canPay = ["active", "suspended", "closed"].includes(c.status) && isStaff();
    const canMemo = ["active", "suspended"].includes(c.status) && isStaff();
    $(".band h1").textContent = `Customer — ${fullName(c)}`;
    $("#main").innerHTML = `
      ${c.status === "closed" ? `<div class="banner closed">CLOSED ACCOUNT — permanently closed. New invoices cannot be recorded.${c.status_note ? " Reason: " + esc(c.status_note) : ""}</div>` : ""}
      ${c.status === "suspended" ? `<div class="banner warn">SUSPENDED — new invoices are blocked until the account is reactivated.${c.status_note ? " Reason: " + esc(c.status_note) : ""}</div>` : ""}
      <div class="profile">
        <div class="pf-photo">${photoUrl ? `<img src="${esc(photoUrl)}" alt="Photo of ${esc(fullName(c))}">` : `<span>${esc((c.first_name[0] || "") + (c.last_name[0] || ""))}</span>`}</div>
        <div class="pf-main">
          <h2>${esc(fullName(c))} ${pill(c.status)}</h2>
          <div class="pf-ids"><span>Account No <b class="mono">${esc(c.account_no)}</b></span><span>Application <b class="mono">${esc(c.application_no)}</b></span><span>Public ID <b class="mono">${esc(c.public_id)}</b></span>
            ${isAdmin() ? `<span>Private Code <b class="mono" id="pvCode" data-code="${esc(secret.data?.private_code || "")}">••••••••</b> <button class="btn" id="pvShow">Show</button></span>` : ""}</div>
          <div class="pf-sub">${esc(c.business_name || "")} · ${esc(c.phone || "")} · ${esc(c.email || "")}</div>
        </div>
        <div class="pf-qr"><canvas id="pfQr" aria-label="Customer QR code"></canvas></div>
      </div>
      <div class="tiles">
        <div class="tile"><div class="k">Total Invoiced</div><div class="v">₱ ${peso(b.total_invoiced)}</div></div>
        <div class="tile ok"><div class="k">Total Paid</div><div class="v">₱ ${peso(b.total_paid)}</div></div>
        <div class="tile"><div class="k">Credits / Discounts</div><div class="v">₱ ${peso(b.total_credits)}</div></div>
        <div class="tile ${num(b.balance_due) > 0 ? "warn" : "ok"}"><div class="k">Balance Due</div><div class="v">₱ ${peso(b.balance_due)}</div></div>
      </div>
      <div class="btnrow">
        ${latestSigned(att) ? `<button class="btn primary" id="pfSigned">View Signed Application</button>` : ""}
        <button class="btn" id="pfPrint">${latestSigned(att) ? "Print Blank Application" : "Download / Print Application"}</button>
        ${canInvoice ? `<a class="btn primary" href="#newinvoice/${c.id}">Record Invoice</a>` : ""}
        ${canPay ? `<a class="btn" href="#newpayment/${c.id}">Record Payment</a>` : ""}
        ${canMemo ? `<a class="btn" href="#newcreditmemo/${c.id}">New Credit Memo</a>` : ""}
      </div>
      ${!["pending", "verified"].includes(c.status) ? signedPanel("customer", c.id, att, "application") : ""}
      ${isAdmin() && ["active", "suspended"].includes(c.status) ? statusPanel(c) : ""}
      ${isAdmin() && ["pending", "verified"].includes(c.status) ? reviewPanel(c, signed) : ""}
      <div class="tabs" id="pfTabs">${["Details", "Invoices", "Payments", "Credit Memos", "Files", "History"].map((t, i) => `<button class="${i ? "" : "on"}" data-t="${i}">${t}</button>`).join("")}</div>
      <div class="tabpanes">
        <div data-p="0">${detailsTable(c)}</div>
        <div data-p="1" hidden>${E.grid({ cols: INV_COLS.filter((x) => x.label !== "Customer" && x.label !== "Account No"), rows: invs.data || [], onRow: true, empty: "No invoices yet." })}</div>
        <div data-p="2" hidden>${E.grid({ cols: PAY_COLS.filter((x) => x.label !== "Customer" && x.label !== "Account No"), rows: pays.data || [], onRow: true, empty: "No payments yet." })}</div>
        <div data-p="3" hidden>${E.grid({ cols: MEMO_COLS.filter((x) => x.label !== "Customer"), rows: memos.data || [], onRow: true, empty: "No credit memos." })}</div>
        <div data-p="4" hidden>${filesHtml(att)}${isStaff() && c.status !== "closed" ? `<div class="fields wide" style="margin-top:8px">${fileField("pfAdd", "Add Requirement", "multiple")}</div>` : ""}</div>
        <div data-p="5" hidden>${E.grid({ cols: [{ label: "Date / Time", get: (r) => stamp(new Date(r.created_at)) }, { label: "Action", get: (r) => r.action.toUpperCase() }, { label: "By", get: (r) => r.actor_name || "" }, { label: "Note", get: (r) => r.note || "" }], rows: ev.data || [] })}</div>
      </div>`;
    E.drawQr($("#pfQr"), custQr(c));
    $$("#pfTabs button").forEach((t) => (t.onclick = () => {
      $$("#pfTabs button").forEach((x) => x.classList.toggle("on", x === t));
      $$(".tabpanes > div").forEach((p) => (p.hidden = p.dataset.p !== t.dataset.t));
    }));
    E.bindGrid($('[data-p="1"]'), invs.data || [], (r) => (location.hash = "invoice/" + r.id));
    E.bindGrid($('[data-p="2"]'), pays.data || [], (r) => (location.hash = "payment/" + r.id));
    E.bindGrid($('[data-p="3"]'), memos.data || [], (r) => (location.hash = "creditmemo/" + r.id));
    bindFiles($("#main"));
    $("#pfPrint").onclick = () => printApplication(c);
    if ($("#pfSigned")) $("#pfSigned").onclick = () => viewFile(latestSigned(att));
    bindSigned($("#main"), () => V.customer(c.id));
    if ($("#pvShow")) $("#pvShow").onclick = () => { const el = $("#pvCode"); const hidden = el.textContent.startsWith("•"); el.textContent = hidden ? el.dataset.code || "(none)" : "••••••••"; $("#pvShow").textContent = hidden ? "Hide" : "Show"; };
    if ($("#pfAdd")) $("#pfAdd").onchange = async (e) => { const f = await uploadRecords("customer", c.id, "requirement", Array.from(e.target.files)); toast(f ? `${f} file(s) failed.` : "Uploaded.", f > 0); V.customer(c.id); };
    if (isAdmin() && ["pending", "verified"].includes(c.status)) bindReview(c, signed);
    if (isAdmin() && ["active", "suspended"].includes(c.status)) bindStatus(c);
  };

  function detailsTable(c) {
    const rows = [
      ["First Name", c.first_name], ["Last Name", c.last_name], ["Phone", c.phone], ["Email", c.email],
      ["Full Address", c.address], ["Address Check", c.address_verified ? "✔ VERIFIED (location found)" : "✖ NOT VERIFIED"],
      ["Business Name", c.business_name], ["Date Starting in Business", dmy(c.business_start_date)],
      ["Facebook Name", c.facebook_name], ["Additional Facebook", c.has_extra_facebook ? "Yes — " + (c.extra_facebook_name || "") : "No"],
      ["Facebook Account", c.facebook_verified ? "✔ VERIFIED" : "✖ NOT VERIFIED"],
      ["Application Date", dmy(c.application_date)], ["Issued By", c.issued_by_name], ["Status Note", c.status_note]
    ];
    return `<div class="grid-wrap"><table class="grid kv-table"><tbody>${rows.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v || "—")}</td></tr>`).join("")}</tbody></table></div>`;
  }

  function reviewPanel(c, signed) {
    return `<fieldset class="opt review"><legend>Admin Review — ${esc(c.application_no)}</legend>
      <ol class="steps">
        <li><b>Check records:</b> look for the same name, phone, email or Facebook name already in the database.
          <div class="btnrow"><button class="btn primary" id="rvCheck">Check &amp; Verify</button>
          <button class="btn" id="rvFb">${c.facebook_verified ? "Mark Facebook NOT verified" : "Mark Facebook verified"}</button></div><div id="rvResult">${c.status === "verified" ? `<div class="addr-msg ok">✔ Verification successful (already verified).</div>` : ""}</div></li>
        <li><b>Upload the signed application form</b> (photo or scan).
          <div class="fields wide">${fileField("rvSigned", "Signed Form", 'accept="image/*,application/pdf"')}</div>
          <div id="rvSignedList">${signed.length ? filesHtml(signed) : "<small>Not uploaded yet.</small>"}</div></li>
        <li><b>Decide:</b>
          <div class="fields wide"><label for="rvNote">Note</label><input type="text" id="rvNote" placeholder="Optional note (shown in history)"></div>
          <div class="btnrow"><button class="btn ok" id="rvApprove" ${signed.length ? "" : "disabled title=\"Upload the signed application form first\""}>Approve — Activate Account</button>
          <button class="btn danger" id="rvReject">Reject</button></div></li>
      </ol></fieldset>`;
  }
  function bindReview(c, signed) {
    $("#rvCheck").onclick = async () => {
      const { data, error } = await sb.rpc("customer_duplicates", { p_id: c.id });
      if (error) return fail(error, "Could not check records");
      const out = $("#rvResult");
      const verify = async () => {
        if (c.status === "verified") return;
        const r = await sb.rpc("customer_action", { p_id: c.id, p_action: "verify", p_note: null });
        if (r.error) return fail(r.error, "Could not verify");
        c.status = "verified"; toast("Verification successful.");
      };
      if (!data.length) {
        out.innerHTML = `<div class="addr-msg ok">✔ VERIFICATION SUCCESSFUL — no matching record found.</div>`;
        await verify();
      } else {
        out.innerHTML = `<div class="addr-msg bad">✖ ${data.length} similar record(s) found. Check before approving:</div>` +
          E.grid({ cols: [{ label: "Account No", get: (r) => r.account_no }, { label: "Name", get: fullName }, { label: "Phone", get: (r) => r.phone || "" }, { label: "Status", html: (r) => pill(r.status) }, { label: "Matched On", get: (r) => r.matched_on }], rows: data, onRow: true })
          + `<div class="btnrow"><button class="btn" id="rvAnyway">Not a duplicate — Verify anyway</button></div>`;
        E.bindGrid(out, data, (r) => window.open("#customer/" + r.id, "_blank"));
        $("#rvAnyway").onclick = async () => { await verify(); out.insertAdjacentHTML("beforeend", `<div class="addr-msg ok">✔ Verified by admin.</div>`); };
      }
    };
    $("#rvFb").onclick = async () => {
      const r = await sb.rpc("customer_action", { p_id: c.id, p_action: c.facebook_verified ? "facebook_unverified" : "facebook_verified", p_note: null });
      if (r.error) return fail(r.error, "Could not update"); V.customer(c.id);
    };
    $("#rvSigned").onchange = async (e) => {
      const f = await uploadRecords("customer", c.id, "signed_form", Array.from(e.target.files));
      if (f) return toast("Upload failed.", true);
      toast("Signed form uploaded. Preview it, then Approve or Reject."); V.customer(c.id);
    };
    const act = async (a) => {
      const r = await sb.rpc("customer_action", { p_id: c.id, p_action: a, p_note: $("#rvNote").value.trim() || null });
      if (r.error) return fail(r.error, "Could not update the account");
      toast(a === "approve" ? `Approved. ${c.account_no} is now ACTIVE.` : "Application rejected.");
      V.customer(c.id);
    };
    $("#rvApprove").onclick = () => act("approve");
    let armed = false;
    $("#rvReject").onclick = () => { if (!armed) { armed = true; $("#rvReject").textContent = "Press again to reject"; return; } act("reject"); };
  }

  function renderSubmitted(c) {
    $(".band h1").textContent = "Application Submitted";
    $("#main").innerHTML = `<div class="window submitted">
      <div class="wtitle">✔ Your application has been submitted — waiting for review</div>
      <div class="wbody"><div class="sub-grid">
        <div class="fields wide">
          <span>Account Name</span><b>${esc(fullName(c))}</b>
          <span>Account Number</span><b class="mono big">${esc(c.account_no)}</b>
          <span>Application ID</span><b class="mono">${esc(c.application_no)}</b>
          <span>Application Date</span><b>${dmy(c.application_date)}</b>
          <span>Public ID</span><b class="mono">${esc(c.public_id)}</b>
          <span>Issued By</span><b>${esc(c.issued_by_name || "")}</b>
          <span>Status</span><span>${pill(c.status)}</span>
        </div>
        <div class="sub-qr"><canvas id="subQr"></canvas><small>Scan to open this account</small></div></div>
        <div class="hint">Next: press <b>Download / Print Application</b>, have the customer sign it, and submit the signed paper to the office. The administrator has been notified.</div>
      </div>
      <div class="wfoot"><button class="btn primary" id="subPrint">Download / Print Application</button><a class="btn" href="#customer/${c.id}">Open Customer Profile</a><a class="btn" href="#newcustomer">New Customer</a></div></div>`;
    E.drawQr($("#subQr"), custQr(c));
    $("#subPrint").onclick = () => printApplication(c);
  }

  // ======================================================================
  // 2. Invoice
  // ======================================================================
  const INV_COLS = [
    { label: "Invoice No", get: (r) => r.invoice_no }, { label: "Date", get: (r) => dmy(r.invoice_date) },
    { label: "Account No", get: (r) => r.account_no }, { label: "Customer", get: fullName },
    { label: "PO No", get: (r) => r.po_number || "" }, { label: "Boxes", num: true, get: (r) => r.total_boxes }, { label: "Pcs", num: true, get: (r) => r.total_pcs },
    { label: "Amount (₱)", key: "total_amount", num: true, get: (r) => peso(r.total_amount) },
    { label: "Paid (₱)", key: "amount_paid", num: true, get: (r) => peso(r.amount_paid) },
    { label: "Balance (₱)", key: "balance", num: true, get: (r) => peso(r.balance) },
    { label: "Status", html: (r) => pill(r.pay_status) }
  ];
  V.invoices = async () => {
    E.shell("invoices", "Invoice", `
      <div class="tabs" id="ivTabs"><button class="on" data-f="open">Active (Unpaid)</button><button data-f="paid">Paid</button><button data-f="">All</button></div>
      <div class="btnrow">${isStaff() ? `<a class="btn primary" href="#newinvoice">+ Record Invoice</a>` : ""}</div>
      <div id="ivRes"></div>`, "Active invoices still have a balance. Press <b>Record Invoice</b> to add a sale for an ACTIVE customer.");
    const run = async (f) => {
      let q = sb.from("invoice_balances").select("*").order("invoice_date", { ascending: false }).order("invoice_no", { ascending: false }).limit(2000);
      if (f === "open") q = q.neq("pay_status", "paid"); else if (f === "paid") q = q.eq("pay_status", "paid");
      const { data, error } = await q;
      if (error) return fail(error, "Could not load invoices");
      const rows = data || [];
      const sum = (k) => peso(rows.reduce((s, r) => s + num(r[k]), 0));
      $("#ivRes").innerHTML = E.grid({ cols: INV_COLS, rows, onRow: true, foot: { total_amount: sum("total_amount"), amount_paid: sum("amount_paid"), balance: sum("balance") }, empty: "No invoices here." });
      E.bindGrid($("#ivRes"), rows, (r) => (location.hash = "invoice/" + r.id));
      E.setRecords(`Invoices: ${rows.length}`);
    };
    $$("#ivTabs button").forEach((b) => (b.onclick = () => { $$("#ivTabs button").forEach((x) => x.classList.toggle("on", x === b)); run(b.dataset.f); }));
    run("open");
  };

  V.newinvoice = async (custId) => {
    if (!isStaff()) { toast("Only Staff and Admin users can record invoices.", true); location.hash = "invoices"; return; }
    E.shell("newinvoice", "Record Invoice", `
      <form class="window" id="niForm" novalidate>
        <div class="wtitle">Record Invoice</div>
        <div class="wbody">
          <fieldset class="opt"><legend>Customer (ACTIVE accounts only)</legend><div id="niCust"></div></fieldset>
          <fieldset class="opt"><legend>Invoice</legend><div class="formgrid">
            <div class="fields wide">
              <label for="niDate">Invoice Date</label><input type="date" id="niDate" value="${isoToday()}">
              <label for="niPDate">Date of Purchase</label><input type="date" id="niPDate" value="${isoToday()}">
              <label for="niPo">PO Number</label><input type="text" id="niPo">
            </div>
            <div class="fields wide">
              <label for="niBox">Total Boxes</label><input type="number" id="niBox" min="0" step="1" value="0">
              <label for="niPcs">Total Pcs</label><input type="number" id="niPcs" min="0" step="1" value="0">
              <label for="niAmt">Total Amount (₱) *</label><input type="number" id="niAmt" min="0" step="0.01" required>
            </div></div>
            <div class="summary-box" style="margin-top:6px"><span id="niWords">PESOS ZERO ONLY</span></div></fieldset>
          <fieldset class="opt"><legend>Payment</legend>
            <div class="checks"><label><input type="radio" name="niPaid" value="unpaid" checked> Unpaid</label><label><input type="radio" name="niPaid" value="paid"> Paid</label></div>
            <div id="niPayBox" hidden><div class="formgrid" style="margin-top:6px">
              <div class="fields wide">
                <span>Paid By</span><div class="checks"><label><input type="radio" name="niMethod" value="cash" checked> Cash</label><label><input type="radio" name="niMethod" value="bank_transfer"> Bank</label></div>
                <label for="niBank" class="nibank" hidden>Bank Name</label><input type="text" id="niBank" class="nibank" hidden>
                <label for="niRef" class="nibank" hidden>Reference No</label><input type="text" id="niRef" class="nibank" hidden>
              </div>
              <div class="fields wide">
                <label for="niPAmt">Amount Paid (₱)</label><input type="number" id="niPAmt" min="0" step="0.01">
                <label for="niPDt">Date Paid</label><input type="date" id="niPDt" value="${isoToday()}">
                ${fileField("niRcpt", "Payment Receipt", 'accept="image/*,application/pdf"')}
                <span></span><small>Optional — leave empty to skip.</small>
              </div></div></div></fieldset>
          <fieldset class="opt"><legend>Documents</legend><div class="fields wide">
            ${fileField("niDr", "Delivery Receipt", 'multiple accept="image/*,application/pdf"')}
            ${fileField("niPoF", "Purchase Order", 'multiple accept="image/*,application/pdf"')}</div></fieldset>
        </div>
        <div class="wfoot"><button type="button" class="btn" id="niCancel">Cancel</button><button type="submit" class="btn primary">Submit Invoice</button></div>
      </form>`, "The invoice is saved to the customer's account and added to their balance due.");
    let cust = null;
    customerPicker($("#niCust"), { statuses: ["active"], onPick: (c) => (cust = c), preset: (await getCustomer(custId)) || undefined });
    if (cust && cust.status !== "active") { toast(`${fullName(cust)} is ${cust.status.toUpperCase()} — invoices are blocked.`, true); cust = null; $("#niCust .pk-chosen").innerHTML = ""; }
    $("#niAmt").oninput = () => { $("#niWords").textContent = words($("#niAmt").value); if (!$("#niPAmt").dataset.touched) $("#niPAmt").value = $("#niAmt").value; };
    $("#niPAmt").oninput = () => ($("#niPAmt").dataset.touched = "1");
    $$("input[name=niPaid]").forEach((r) => (r.onchange = () => ($("#niPayBox").hidden = $("input[name=niPaid]:checked").value !== "paid")));
    $$("input[name=niMethod]").forEach((r) => (r.onchange = () => $$(".nibank").forEach((x) => (x.hidden = $("input[name=niMethod]:checked").value !== "bank_transfer"))));
    $("#niCancel").onclick = () => history.back();
    $("#niForm").onsubmit = async (e) => {
      e.preventDefault();
      if (!cust) return toast("Choose an ACTIVE customer first.", true);
      const amt = num($("#niAmt").value);
      if (!$("#niAmt").value || amt < 0) return toast("Enter the total amount.", true);
      const paid = $("input[name=niPaid]:checked").value === "paid";
      const method = $("input[name=niMethod]:checked").value;
      const pAmt = num($("#niPAmt").value || amt);
      if (paid && pAmt <= 0) return toast("Enter the amount paid.", true);
      if (paid && method === "bank_transfer" && !$("#niRef").value.trim()) return toast("Enter the bank reference number.", true);
      $$("#niForm button").forEach((b) => (b.disabled = true));
      const { data: inv, error } = await sb.from("invoices").insert({
        customer_id: cust.id, invoice_date: $("#niDate").value || isoToday(), purchase_date: $("#niPDate").value || null,
        po_number: $("#niPo").value.trim() || null, total_boxes: Math.max(0, Math.floor(num($("#niBox").value))),
        total_pcs: Math.max(0, Math.floor(num($("#niPcs").value))), total_amount: amt
      }).select().single();
      if (error) { $$("#niForm button").forEach((b) => (b.disabled = false)); return fail(error, "Could not record the invoice"); }
      let failed = 0;
      if (paid) {
        const { data: p, error: pe } = await sb.from("payments_received").insert({
          customer_id: cust.id, invoice_id: inv.id, amount: pAmt, method, paid_date: $("#niPDt").value || isoToday(),
          bank_name: method === "bank_transfer" ? $("#niBank").value.trim() || null : null,
          reference_no: method === "bank_transfer" ? $("#niRef").value.trim() : null
        }).select().single();
        if (pe) fail(pe, "Invoice saved, but the payment could not be recorded");
        else failed += await uploadRecords("payment", p.id, "receipt", filesOf("niRcpt"));
      }
      failed += await uploadRecords("invoice", inv.id, "delivery_receipt", filesOf("niDr"));
      failed += await uploadRecords("invoice", inv.id, "purchase_order", filesOf("niPoF"));
      toast(`Invoice ${inv.invoice_no} recorded to ${fullName(cust)}.${failed ? ` ${failed} file(s) failed to upload.` : ""}`, failed > 0);
      location.hash = "invoice/" + inv.id;
    };
  };

  V.invoice = async (id) => {
    E.shell("invoice", "Invoice", `<div class="empty">Loading…</div>`);
    const { data: inv } = await sb.from("invoice_balances").select("*").eq("id", id).maybeSingle();
    if (!inv) { $("#main").innerHTML = `<div class="empty">Invoice not found. <a href="#invoices">Back to Invoices</a></div>`; return; }
    const [pays, att] = await Promise.all([sb.from("payments_received").select("*").eq("invoice_id", id).order("paid_date"), attachmentsOf("invoice", id)]);
    $(".band h1").textContent = `Invoice — ${inv.invoice_no}`;
    $("#main").innerHTML = `<div class="window"><div class="wtitle">${esc(inv.invoice_no)} ${pill(inv.pay_status)}</div><div class="wbody">
      <div class="formgrid"><div class="fields wide">
        <span>Customer</span><a href="#customer/${inv.customer_id}"><b>${esc(fullName(inv))}</b> (${esc(inv.account_no)})</a>
        <span>Invoice Date</span><span>${dmy(inv.invoice_date)}</span><span>Date of Purchase</span><span>${dmy(inv.purchase_date) || "—"}</span>
        <span>PO Number</span><span>${esc(inv.po_number || "—")}</span><span>Recorded By</span><span>${esc(inv.created_by_name || "")}</span></div>
      <div class="fields wide"><span>Total Boxes</span><b>${inv.total_boxes}</b><span>Total Pcs</span><b>${inv.total_pcs}</b>
        <span>Total Amount</span><b>₱ ${peso(inv.total_amount)}</b><span>Paid</span><b>₱ ${peso(inv.amount_paid)}</b><span>Balance</span><b>₱ ${peso(inv.balance)}</b></div></div>
      <div><b>Payments</b>${E.grid({ cols: PAY_COLS.filter((x) => !["Customer", "Account No", "Invoice"].includes(x.label)), rows: pays.data || [], onRow: true, empty: "No payments yet." })}</div>
      ${signedPanel("invoice", inv.id, att, "invoice")}
      <div><b>Files</b>${filesHtml(att)}</div></div>
      <div class="wfoot">${latestSigned(att) ? `<button class="btn primary" id="ivSigned">View Signed Invoice</button>` : ""}<button class="btn ${latestSigned(att) ? "" : "primary"}" id="ivPrint">Print Invoice</button>
        ${isStaff() && inv.pay_status !== "paid" && inv.customer_status !== "rejected" ? `<a class="btn" href="#newpayment/${inv.customer_id}/${inv.id}">Record Payment</a>` : ""}
        <a class="btn" href="#invoices">Close</a></div></div>`;
    E.bindGrid($("#main"), pays.data || [], (r) => (location.hash = "payment/" + r.id));
    bindFiles($("#main"));
    $("#ivPrint").onclick = () => E.openPreview(`Invoice ${inv.invoice_no}`, [invoicePage(inv, pays.data || [])]);
    if ($("#ivSigned")) $("#ivSigned").onclick = () => viewFile(latestSigned(att));
    bindSigned($("#main"), () => V.invoice(id));
  };
  function invoicePage(inv, pays) {
    return `${printHead("INVOICE", `<img src="${E.pdf417DataUrl("EMONINV|" + inv.invoice_no)}" alt="" class="ph-bar"><div class="mono">${esc(inv.invoice_no)}</div>`)}
      ${box("Customer", `<div class="pgrid2">${cell("Customer Name", fullName(inv))}${cell("Account No", inv.account_no)}${cell("PO Number", inv.po_number, "span2")}</div>`)}
      ${box("Order", `<div class="prow3">${cell("Invoice Date", dmy(inv.invoice_date))}${cell("Date of Purchase", dmy(inv.purchase_date))}${cell("Total Boxes", inv.total_boxes)}</div>
        <div class="prow3">${cell("Total Pcs", inv.total_pcs)}${cell("Total Amount (₱)", peso(inv.total_amount))}${cell("Balance (₱)", peso(inv.balance))}</div>
        <div class="pcell"><div class="pl">Amount in Words</div><div class="pv words">${esc(words(inv.total_amount))}</div></div>`)}
      ${box("Payments Received", pays.length ? `<table class="rp"><thead><tr><th>Receipt No</th><th>Date</th><th>Method</th><th>Reference</th><th class="num">Amount</th></tr></thead><tbody>
        ${pays.map((p) => `<tr><td>${esc(p.receipt_no)}</td><td>${dmy(p.paid_date)}</td><td>${esc(METHOD[p.method])}</td><td>${esc(p.reference_no || "")}</td><td class="num">${peso(p.amount)}</td></tr>`).join("")}</tbody></table>` : `<div class="pv" style="padding:6px">UNPAID</div>`)}
      ${inv.pay_status === "paid" ? stampHtml("PAID", "paid") : ""}
      ${sigs("Received by (Customer Signature) / Date", `Prepared by: ${esc(inv.created_by_name || "")}`)}`;
  }

  // ======================================================================
  // 3. Payment
  // ======================================================================
  const PAY_COLS = [
    { label: "Receipt No", get: (r) => r.receipt_no }, { label: "Date Paid", get: (r) => dmy(r.paid_date) },
    { label: "Account No", get: (r) => r.customers?.account_no || "" }, { label: "Customer", get: (r) => fullName(r.customers || {}) },
    { label: "Method", get: (r) => METHOD[r.method] || r.method }, { label: "Reference", get: (r) => r.reference_no || "" },
    { label: "Invoice", get: (r) => r.invoices?.invoice_no || "" },
    { label: "Amount (₱)", key: "amount", num: true, get: (r) => peso(r.amount) }, { label: "Verified By", get: (r) => r.created_by_name || "" }
  ];
  V.payments = async () => {
    E.shell("payments", "Payment", `
      <div class="btnrow">${isStaff() ? `<a class="btn primary" href="#newpayment">+ Record Payment</a>` : ""}</div><div id="pyRes"></div>`,
      "All payments received. Each payment gets a receipt number like <b>A-2026-1003-001</b> and a printable acknowledgment.");
    const { data, error } = await sb.from("payments_received").select("*, customers(first_name,last_name,account_no), invoices(invoice_no)").order("created_at", { ascending: false }).limit(2000);
    if (error) return fail(error, "Could not load payments");
    const rows = data || [];
    $("#pyRes").innerHTML = E.grid({ cols: PAY_COLS, rows, onRow: true, foot: { amount: peso(rows.reduce((s, r) => s + num(r.amount), 0)) }, empty: "No payments yet." });
    E.bindGrid($("#pyRes"), rows, (r) => (location.hash = "payment/" + r.id));
    E.setRecords(`Payments: ${rows.length}`);
  };

  V.newpayment = async (custId, invId) => {
    if (!isStaff()) { toast("Only Staff and Admin users can record payments.", true); location.hash = "payments"; return; }
    E.shell("newpayment", "Record Payment", `
      <form class="window" id="npForm" novalidate>
        <div class="wtitle">Record Payment</div>
        <div class="wbody">
          <fieldset class="opt"><legend>Customer</legend><div id="npCust"></div></fieldset>
          <fieldset class="opt"><legend>Payment</legend><div class="formgrid">
            <div class="fields wide">
              <label for="npAmt">Amount (₱) *</label><input type="number" id="npAmt" min="0.01" step="0.01" required>
              <label for="npMethod">Payment Method</label><select id="npMethod">${Object.entries(METHOD).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
              <label for="npDate">Date Paid</label><input type="date" id="npDate" value="${isoToday()}">
              <label for="npInv">Apply to Invoice</label><select id="npInv"><option value="">— General payment (no specific invoice) —</option></select>
            </div>
            <div class="fields wide">
              <label for="npBank" class="npb">Bank Name</label><input type="text" id="npBank" class="npb" placeholder="e.g. BDO, BPI, GCash">
              <label for="npAcct" class="npb">Deposit Bank Account</label><input type="text" id="npAcct" class="npb" placeholder="Account the money went to">
              <label for="npRef" class="npb">Reference No</label><input type="text" id="npRef" class="npb">
              <span>Verified By</span><b>${esc(myName())}</b>
            </div></div>
            <div class="summary-box" style="margin-top:6px"><span id="npWords">PESOS ZERO ONLY</span></div></fieldset>
          <fieldset class="opt"><legend>Documents</legend><div class="fields wide">
            ${fileField("npRcpt", "Receipt / Deposit Slip", 'multiple accept="image/*,application/pdf"')}
            ${fileField("npPo", "Purchase Order (if any)", 'multiple accept="image/*,application/pdf"')}</div></fieldset>
          <fieldset class="opt"><legend>Notes</legend><input type="text" id="npNotes" placeholder="Optional"></fieldset>
        </div>
        <div class="wfoot"><button type="button" class="btn" id="npCancel">Cancel</button><button type="submit" class="btn primary">Submit Payment</button></div>
      </form>`);
    let cust = null;
    const loadInv = async () => {
      const sel = $("#npInv"); sel.innerHTML = `<option value="">— General payment (no specific invoice) —</option>`;
      if (!cust) return;
      const { data } = await sb.from("invoice_balances").select("id,invoice_no,balance,invoice_date").eq("customer_id", cust.id).neq("pay_status", "paid").order("invoice_date");
      (data || []).forEach((i) => sel.insertAdjacentHTML("beforeend", `<option value="${i.id}" data-bal="${i.balance}">${esc(i.invoice_no)} — balance ₱${peso(i.balance)}</option>`));
      if (invId) { sel.value = invId; const o = sel.selectedOptions[0]; if (o?.dataset.bal && !$("#npAmt").value) { $("#npAmt").value = o.dataset.bal; $("#npWords").textContent = words(o.dataset.bal); } }
    };
    customerPicker($("#npCust"), { statuses: ["active", "suspended", "closed"], onPick: (c) => { cust = c; loadInv(); }, preset: (await getCustomer(custId)) || undefined });
    const methodUi = () => { const m = $("#npMethod").value; $$(".npb").forEach((x) => (x.hidden = m === "cash")); };
    $("#npMethod").onchange = methodUi; methodUi();
    $("#npAmt").oninput = () => ($("#npWords").textContent = words($("#npAmt").value));
    $("#npInv").onchange = () => { const o = $("#npInv").selectedOptions[0]; if (o?.dataset.bal && !$("#npAmt").value) { $("#npAmt").value = o.dataset.bal; $("#npWords").textContent = words(o.dataset.bal); } };
    $("#npCancel").onclick = () => history.back();
    $("#npForm").onsubmit = async (e) => {
      e.preventDefault();
      if (!cust) return toast("Choose the customer first.", true);
      const amt = num($("#npAmt").value);
      if (amt <= 0) return toast("Enter the amount received.", true);
      const m = $("#npMethod").value;
      if (m !== "cash" && !$("#npRef").value.trim()) return toast("Enter the reference number.", true);
      $$("#npForm button").forEach((b) => (b.disabled = true));
      const { data: p, error } = await sb.from("payments_received").insert({
        customer_id: cust.id, invoice_id: $("#npInv").value || null, amount: amt, method: m, paid_date: $("#npDate").value || isoToday(),
        bank_name: m === "cash" ? null : $("#npBank").value.trim() || null, bank_account: m === "cash" ? null : $("#npAcct").value.trim() || null,
        reference_no: m === "cash" ? null : $("#npRef").value.trim(), notes: $("#npNotes").value.trim() || null
      }).select().single();
      if (error) { $$("#npForm button").forEach((b) => (b.disabled = false)); return fail(error, "Could not record the payment"); }
      let failed = await uploadRecords("payment", p.id, "receipt", filesOf("npRcpt"));
      failed += await uploadRecords("payment", p.id, "purchase_order", filesOf("npPo"));
      if (failed) toast(`${failed} file(s) failed to upload.`, true);
      location.hash = `payment/${p.id}/done`;
    };
  };

  V.payment = async (id, extra) => {
    E.shell("payment", "Payment", `<div class="empty">Loading…</div>`);
    const { data: p } = await sb.from("payments_received").select("*, customers(*), invoices(invoice_no,total_amount)").eq("id", id).maybeSingle();
    if (!p) { $("#main").innerHTML = `<div class="empty">Payment not found. <a href="#payments">Back to Payments</a></div>`; return; }
    const att = await attachmentsOf("payment", id);
    $(".band h1").textContent = `Payment — ${p.receipt_no}`;
    $("#main").innerHTML = `
      ${extra === "done" ? `<div class="banner ok">✔ Payment successfully recorded — Receipt No <b>${esc(p.receipt_no)}</b>. It has been added to ${esc(fullName(p.customers))}'s account.</div>` : ""}
      <div class="window"><div class="wtitle">${esc(p.receipt_no)}</div><div class="wbody">
      <div class="formgrid"><div class="fields wide">
        <span>Customer</span><a href="#customer/${p.customer_id}"><b>${esc(fullName(p.customers))}</b> (${esc(p.customers.account_no)})</a>
        <span>Amount</span><b>₱ ${peso(p.amount)}</b><span>In Words</span><span>${esc(words(p.amount))}</span>
        <span>Date Paid</span><span>${dmy(p.paid_date)}</span></div>
      <div class="fields wide"><span>Method</span><span>${esc(METHOD[p.method])}</span><span>Bank</span><span>${esc(p.bank_name || "—")}</span>
        <span>Deposit Account</span><span>${esc(p.bank_account || "—")}</span><span>Reference No</span><span>${esc(p.reference_no || "—")}</span>
        <span>Invoice</span><span>${p.invoice_id ? `<a href="#invoice/${p.invoice_id}">${esc(p.invoices?.invoice_no || "")}</a>` : "General payment"}</span>
        <span>Verified By</span><span>${esc(p.created_by_name || "")}</span></div></div>
      ${signedPanel("payment", p.id, att, "acknowledgment receipt")}
      <div><b>Files</b>${filesHtml(att)}</div></div>
      <div class="wfoot">${latestSigned(att) ? `<button class="btn primary" id="pySigned">View Signed Receipt</button>` : ""}<button class="btn ${latestSigned(att) ? "" : "primary"}" id="pyPrint">Download Acknowledgment Receipt</button><a class="btn" href="#payments">Close</a></div></div>`;
    bindFiles($("#main"));
    $("#pyPrint").onclick = () => E.openPreview(`Acknowledgment ${p.receipt_no}`, [ackPage(p)]);
    if ($("#pySigned")) $("#pySigned").onclick = () => viewFile(latestSigned(att));
    bindSigned($("#main"), () => V.payment(id));
  };
  function ackPage(p) {
    const c = p.customers;
    return `${printHead("ACKNOWLEDGMENT RECEIPT", `<img src="${E.pdf417DataUrl("EMONPAY|" + p.receipt_no)}" alt="" class="ph-bar"><div class="mono">${esc(p.receipt_no)}</div>`)}
      <div class="ack-ok">PAYMENT SUCCESSFULLY RECEIVED</div>
      ${box("Received From", `<div class="pgrid2">${cell("Customer Name", fullName(c))}${cell("Account No", c.account_no)}${cell("Date Paid", dmy(p.paid_date), "span2")}</div>`)}
      ${box("Payment Details", `<div class="prow3">${cell("Amount (₱)", peso(p.amount))}${cell("Method", METHOD[p.method])}${cell("Reference No", p.reference_no)}</div>
        <div class="prow3">${cell("Bank", p.bank_name)}${cell("Deposit Account", p.bank_account)}${cell("Applied to Invoice", p.invoices?.invoice_no || "General payment")}</div>
        <div class="pcell"><div class="pl">Amount in Words</div><div class="pv words">${esc(words(p.amount))}</div></div>`)}
      <p class="pdecl">This acknowledges that ${esc(C.company.name)} has received the payment above. Receipt No ${esc(p.receipt_no)}.</p>
      ${stampHtml("RECEIVED", "paid")}
      ${sigs(`Received &amp; verified by: <b>${esc(p.created_by_name || "")}</b>`, "Customer Signature / Date")}`;
  }

  // ======================================================================
  // 4. Credit Memo (customer complaint)
  // ======================================================================
  const MEMO_COLS = [
    { label: "Report No", get: (r) => r.memo_no }, { label: "Date", get: (r) => dmy(r.memo_date) },
    { label: "Customer", get: (r) => fullName(r.customers || {}) }, { label: "Article", get: (r) => r.article || "" },
    { label: "Defect", get: (r) => DEFECT[r.defect_category] || "" }, { label: "Request", get: (r) => ACTION[r.requested_action] || "" },
    { label: "Amount (₱)", key: "request_amount", num: true, get: (r) => peso(r.request_amount) }, { label: "Status", html: (r) => pill(r.status) }
  ];
  V.creditmemos = async () => {
    E.shell("creditmemos", "Credit Memo", `
      <div class="btnrow">${isStaff() ? `<a class="btn primary" href="#newcreditmemo">+ New Credit Memo</a>` : ""}</div><div id="cmRes"></div>`,
      "Customer complaints and defect claims. Approved <b>Credit</b> and <b>Discount</b> memos reduce the customer's balance due.");
    const { data, error } = await sb.from("credit_memos").select("*, customers(first_name,last_name,account_no)").order("created_at", { ascending: false }).limit(2000);
    if (error) return fail(error, "Could not load credit memos");
    const rows = data || [];
    $("#cmRes").innerHTML = E.grid({ cols: MEMO_COLS, rows, onRow: true, foot: { request_amount: peso(rows.reduce((s, r) => s + num(r.request_amount), 0)) }, empty: "No credit memos yet." });
    E.bindGrid($("#cmRes"), rows, (r) => (location.hash = "creditmemo/" + r.id));
    E.setRecords(`Credit memos: ${rows.length}`);
  };

  V.newcreditmemo = async (custId) => {
    if (!isStaff()) { toast("Only Staff and Admin users can create credit memos.", true); location.hash = "creditmemos"; return; }
    E.shell("newcreditmemo", "New Credit Memo", `
      <form class="window" id="cmForm" novalidate>
        <div class="wtitle">Customer Complaint / Credit Memo</div>
        <div class="wbody">
          <fieldset class="opt"><legend>Customer / Buyer Information</legend><div id="cmCust"></div>
            <div class="fields wide" style="margin-top:6px">
              <label for="cmPay">Payment Reference</label><input type="text" id="cmPay" list="cmPays" placeholder="e.g. A-2026-0701-001 12,000 RECEIVED"><datalist id="cmPays"></datalist>
              <label for="cmPo">Purchase Order</label><input type="text" id="cmPo">
              <label for="cmDate">Report Date</label><input type="date" id="cmDate" value="${isoToday()}">
            </div></fieldset>
          <fieldset class="opt"><legend>Garment &amp; Order Details</legend><div class="formgrid">
            <div class="fields wide">
              <label for="cmArt">Garment Description / Article</label><input type="text" id="cmArt" placeholder="e.g. LADIES SHORT PANT">
              <label for="cmBrand">Brand</label><input type="text" id="cmBrand">
              <label for="cmStyle">Style</label><input type="text" id="cmStyle">
            </div>
            <div class="fields wide">
              <label for="cmBatch">Batch Number</label><input type="text" id="cmBatch">
              <label for="cmSerial">Serial Number</label><input type="text" id="cmSerial">
              <label for="cmQty">Qty</label><input type="number" id="cmQty" min="0" step="1" value="0">
              <label for="cmPDate">Purchase Date</label><input type="date" id="cmPDate">
            </div></div></fieldset>
          <fieldset class="opt"><legend>Defect Parameters &amp; Customer Request</legend><div class="formgrid">
            <div><b>Defect Category</b>${Object.entries(DEFECT).map(([k, v], i) => `<label class="rline"><input type="radio" name="cmDef" value="${k}" ${i ? "" : "checked"}> ${v}</label>`).join("")}
              <div class="fields wide"><label for="cmDefD">Details</label><input type="text" id="cmDefD" placeholder="e.g. DOMINANT 60% GREEN"></div></div>
            <div><b>Requested Action</b>${Object.entries(ACTION).map(([k, v]) => `<label class="rline"><input type="radio" name="cmAct" value="${k}" ${k === "discount" ? "checked" : ""}> ${v}</label>`).join("")}
              <div class="fields wide"><label for="cmRate">Rate per pc (₱)</label><input type="number" id="cmRate" min="0" step="0.01" value="0">
              <label for="cmAmt">Request Amount (₱)</label><input type="number" id="cmAmt" min="0" step="0.01" value="0"></div>
              <small id="cmCalc"></small></div></div></fieldset>
          <fieldset class="opt"><legend>Warehouse Verification (Internal Office Use)</legend><div class="fields wide">
            <label for="cmAssign">Assigned By</label><input type="text" id="cmAssign" value="${esc(myName())}">
            <label for="cmNotes">Inspection Notes</label><textarea id="cmNotes" rows="3" placeholder="e.g. PROOF OF VIDEO 60% GREEN SUBMITTED"></textarea>
            <label for="cmFactory">Status / Factory</label><textarea id="cmFactory" rows="2" placeholder="e.g. PENDING REVIEW FACTORY — MODINA APPARELS PVT, DHAKA"></textarea>
            ${fileField("cmProof", "Proof (photos / video)", 'multiple accept="image/*,video/*,application/pdf"')}</div></fieldset>
        </div>
        <div class="wfoot"><button type="button" class="btn" id="cmCancel">Cancel</button><button type="submit" class="btn primary">Submit for Approval</button></div>
      </form>`, "After submitting, the administrator reviews and approves it. Approved <b>Credit</b> / <b>Discount</b> amounts are deducted from the account balance.");
    let cust = null;
    const loadPays = async () => {
      const dl = $("#cmPays"); dl.innerHTML = ""; if (!cust) return;
      const { data } = await sb.from("payments_received").select("receipt_no,amount").eq("customer_id", cust.id).order("paid_date", { ascending: false }).limit(20);
      (data || []).forEach((p) => dl.insertAdjacentHTML("beforeend", `<option value="${esc(p.receipt_no)} ${esc(peso(p.amount))} RECEIVED">`));
    };
    customerPicker($("#cmCust"), { statuses: ["active", "suspended"], onPick: (c) => { cust = c; loadPays(); }, preset: (await getCustomer(custId)) || undefined });
    const calc = () => {
      const q = num($("#cmQty").value), r = num($("#cmRate").value);
      if (r > 0) { $("#cmAmt").value = (q * r).toFixed(2); $("#cmCalc").textContent = `${q} × ₱${peso(r)} = ₱${peso(q * r)}`; } else $("#cmCalc").textContent = "";
    };
    $("#cmQty").oninput = calc; $("#cmRate").oninput = calc;
    $("#cmCancel").onclick = () => history.back();
    $("#cmForm").onsubmit = async (e) => {
      e.preventDefault();
      if (!cust) return toast("Choose the customer first.", true);
      const v = (id) => $("#" + id).value.trim();
      $$("#cmForm button").forEach((b) => (b.disabled = true));
      const { data: m, error } = await sb.from("credit_memos").insert({
        customer_id: cust.id, memo_date: v("cmDate") || isoToday(), payment_ref: v("cmPay") || null, po_number: v("cmPo") || null,
        article: v("cmArt") || null, brand: v("cmBrand") || null, style: v("cmStyle") || null, batch_no: v("cmBatch") || null, serial_no: v("cmSerial") || null,
        qty: Math.max(0, Math.floor(num(v("cmQty")))), purchase_date: v("cmPDate") || null,
        defect_category: $("input[name=cmDef]:checked").value, defect_detail: v("cmDefD") || null,
        requested_action: $("input[name=cmAct]:checked").value, rate: num(v("cmRate")), request_amount: num(v("cmAmt")),
        assigned_by: v("cmAssign") || null, inspection_notes: v("cmNotes") || null, factory_status: v("cmFactory") || null
      }).select().single();
      if (error) { $$("#cmForm button").forEach((b) => (b.disabled = false)); return fail(error, "Could not save the credit memo"); }
      const failed = await uploadRecords("credit_memo", m.id, "proof", filesOf("cmProof"));
      toast(`Credit memo ${m.memo_no} submitted for approval.${failed ? ` ${failed} file(s) failed.` : ""}`, failed > 0);
      location.hash = "creditmemo/" + m.id;
    };
  };

  V.creditmemo = async (id) => {
    E.shell("creditmemo", "Credit Memo", `<div class="empty">Loading…</div>`);
    const { data: m } = await sb.from("credit_memos").select("*, customers(*)").eq("id", id).maybeSingle();
    if (!m) { $("#main").innerHTML = `<div class="empty">Credit memo not found. <a href="#creditmemos">Back</a></div>`; return; }
    const att = await attachmentsOf("credit_memo", id);
    $(".band h1").textContent = `Credit Memo — ${m.memo_no}`;
    $("#main").innerHTML = `<div class="window"><div class="wtitle">${esc(m.memo_no)} ${pill(m.status)}</div><div class="wbody">
      <div class="formgrid"><div class="fields wide">
        <span>Customer</span><a href="#customer/${m.customer_id}"><b>${esc(fullName(m.customers))}</b> (${esc(m.customers.account_no)})</a>
        <span>Payment Ref</span><span>${esc(m.payment_ref || "—")}</span><span>Purchase Order</span><span>${esc(m.po_number || "—")}</span>
        <span>Article</span><span>${esc(m.article || "—")}</span><span>Brand / Style</span><span>${esc([m.brand, m.style].filter(Boolean).join(" / ") || "—")}</span>
        <span>Batch / Serial</span><span>${esc([m.batch_no, m.serial_no].filter(Boolean).join(" / ") || "—")}</span>
        <span>Qty</span><span>${m.qty}</span><span>Purchase Date</span><span>${dmy(m.purchase_date) || "—"}</span></div>
      <div class="fields wide">
        <span>Defect</span><span>${esc(DEFECT[m.defect_category])}${m.defect_detail ? " — " + esc(m.defect_detail) : ""}</span>
        <span>Request</span><span>${esc(ACTION[m.requested_action])}${m.rate > 0 ? ` (₱${peso(m.rate)} / pc)` : ""}</span>
        <span>Request Amount</span><b>₱ ${peso(m.request_amount)}</b>
        <span>Assigned By</span><span>${esc(m.assigned_by || "—")}</span><span>Inspection Notes</span><span>${esc(m.inspection_notes || "—")}</span>
        <span>Factory Status</span><span>${esc(m.factory_status || "—")}</span>
        <span>Approved By</span><span>${esc(m.approved_by_name || "—")} ${m.approved_at ? dmy(m.approved_at) : ""}</span>
        <span>Paid / Settled</span><span>${m.paid_at ? `${esc(m.paid_by_name || "")} ${dmy(m.paid_at)}` : "—"}</span></div></div>
      ${signedPanel("credit_memo", m.id, att, "credit memo")}
      <div><b>Proof</b>${filesHtml(att.filter((a) => a.kind !== "signed_form"))}</div>
      ${isAdmin() && ["pending", "approved"].includes(m.status) ? `<fieldset class="opt"><legend>Admin Decision</legend>
        <div class="fields wide"><label for="cmNote">Note</label><input type="text" id="cmNote"></div>
        <div class="btnrow">${m.status === "pending" ? `<button class="btn ok" data-a="approve">Approve</button><button class="btn danger" data-a="reject">Reject</button>` : `<button class="btn ok" data-a="paid">Mark as PAID / Settled</button>`}</div></fieldset>` : ""}
      </div><div class="wfoot">${latestSigned(att) ? `<button class="btn primary" id="cmSigned">View Signed Credit Memo</button>` : ""}<button class="btn ${latestSigned(att) ? "" : "primary"}" id="cmPrint">Print Credit Memo</button><a class="btn" href="#creditmemos">Close</a></div></div>`;
    bindFiles($("#main"));
    $$("[data-a]").forEach((b) => (b.onclick = async () => {
      const r = await sb.rpc("credit_memo_action", { p_id: m.id, p_action: b.dataset.a, p_note: $("#cmNote").value.trim() || null });
      if (r.error) return fail(r.error, "Could not update the credit memo");
      toast(`${m.memo_no} updated.`); V.creditmemo(m.id);
    }));
    $("#cmPrint").onclick = () => E.openPreview(`Credit Memo ${m.memo_no}`, [memoPage(m)]);
    if ($("#cmSigned")) $("#cmSigned").onclick = () => viewFile(latestSigned(att));
    bindSigned($("#main"), () => V.creditmemo(id));
  };
  function memoPage(m) {
    const c = m.customers;
    const stampTxt = { approved: "APPROVED", rejected: "REJECTED", paid: "APPROVED", pending: "PENDING" }[m.status];
    return `<div class="cm-head"><div><div class="cm-co">${esc(C.company.name)}</div><div class="cm-date">${esc(new Date(m.memo_date + "T00:00:00").toLocaleDateString("en-US", { month: "long", day: "2-digit", year: "numeric" }).toUpperCase())}</div></div>
        <div class="cm-rep"><div><span>REPORT:</span> <b>${esc(m.memo_no)}</b></div><img src="${E.pdf417DataUrl("EMONCM|" + m.memo_no)}" alt=""></div></div>
      ${stampHtml(stampTxt, m.status)}
      <div class="ph-title" style="text-align:left">CUSTOMER COMPLAINT</div>
      ${box("Customer / Buyer Information", `<div class="pgrid2">${cell("Customer Name", fullName(c).toUpperCase(), "hl")}${cell("Customer ID", c.account_no, "hl")}
        ${cell("Payment Reference", m.payment_ref)}${cell("Purchase Order", m.po_number)}</div>`)}
      ${box("Garment & Order Details", `<div class="pgrid4">${cell("Garment Description / Article", m.article, "span2 hl")}${cell("Brand", m.brand)}${cell("Style", m.style)}
        ${cell("Batch Number", m.batch_no, "hl")}${cell("Serial Number", m.serial_no)}${cell("Qty", m.qty, "hl")}${cell("Purchase Date", dmy(m.purchase_date), "hl")}</div>`)}
      ${box("Defect Parameters & Customer Request", `<div class="pgrid2"><div class="pcell"><div class="pl">Defect Category</div>
          ${Object.entries(DEFECT).map(([k, v]) => radio(m.defect_category === k, k === m.defect_category && m.defect_detail ? `${v}: ${m.defect_detail}`.toUpperCase() : v)).join("")}</div>
        <div class="pcell"><div class="pl">Requested Action</div>${Object.entries(ACTION).map(([k, v]) => radio(m.requested_action === k, k === "discount" && m.rate > 0 ? `${v} ${peso(m.rate)} PHP` : v)).join("")}</div></div>
        ${cell("Request Amount", (m.rate > 0 ? `${m.qty} × ${peso(m.rate)} = ` : "") + peso(m.request_amount) + " PHP", "hl")}`)}
      ${box("Warehouse Verification (Internal Office Use) " + C.company.name, `<div class="pgrid2">
        <div>${cell("Assigned By", m.assigned_by)}${cell("Inspection Notes", m.inspection_notes)}</div>
        <div class="pcell"><div class="pl">Status</div><div class="pv" style="white-space:pre-wrap;font-weight:bold">${esc((m.factory_status || "").toUpperCase())}</div>
</div></div>`)}
      ${sigs("Customer Signature &nbsp; Date: ____________", "Approval Signature &nbsp; Date: ____________")}`;
  }

  // Account status (suspend / reactivate / close) — admin panel inside the customer profile.
  function statusPanel(c) {
    return `<fieldset class="opt review"><legend>Account Status (Admin)</legend>
      <div class="fields wide"><label for="stNote">Reason *</label><input type="text" id="stNote" placeholder="Why is this action taken?"></div>
      <div class="btnrow">
        ${c.status === "active" ? `<button class="btn" data-st="suspend">Suspend Account</button>` : ""}
        ${c.status === "suspended" ? `<button class="btn ok" data-st="reactivate">Reactivate Account</button>` : ""}
        <button class="btn danger" data-st="close">Close Permanently</button></div>
      <small>Suspended: new invoices are blocked until reactivated. Closed: permanent, no new invoices, hidden from the top search.</small></fieldset>`;
  }
  function bindStatus(c) {
    $$("[data-st]").forEach((b) => (b.onclick = async () => {
      const note = $("#stNote").value.trim();
      if (!note) return toast("Enter the reason first.", true);
      if (b.dataset.st === "close" && b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Press again — this cannot be undone"; return; }
      const r = await sb.rpc("customer_action", { p_id: c.id, p_action: b.dataset.st, p_note: note });
      if (r.error) return fail(r.error, "Could not update the account");
      toast(`${c.account_no} is now ${r.data.status.toUpperCase()}.`); V.customer(c.id);
    }));
  }

  // ======================================================================
  // Global search (top bar)
  // ======================================================================
  V.find = async (q) => {
    const t = cleanQ(q);
    E.shell("find", `Search: ${t}`, `<div id="fdRes" class="empty">Searching…</div>`);
    if (!t) { $("#fdRes").textContent = "Type something in the search bar."; return; }
    const w = t.split(/\s+/)[0];
    const [cs, iv, py] = await Promise.all([
      sb.from("customers").select("*").neq("status", "closed").or(`first_name.ilike.%${w}%,last_name.ilike.%${w}%,account_no.ilike.%${w}%,public_id.ilike.%${w}%,business_name.ilike.%${w}%,phone.ilike.%${w}%`).limit(100),
      sb.from("invoice_balances").select("*").neq("customer_status", "closed").or(`invoice_no.ilike.%${w}%,po_number.ilike.%${w}%`).limit(50),
      sb.from("payments_received").select("*, customers(first_name,last_name,account_no,status)").or(`receipt_no.ilike.%${w}%,reference_no.ilike.%${w}%`).limit(50)
    ]);
    const ws = t.toLowerCase().split(/\s+/);
    const custs = (cs.data || []).filter((c) => ws.every((x) => `${fullName(c)} ${c.account_no} ${c.public_id} ${c.business_name || ""} ${c.phone || ""}`.toLowerCase().includes(x)));
    const pays = (py.data || []).filter((p) => p.customers?.status !== "closed");
    $("#main").innerHTML = `<h3>Customers (${custs.length})</h3><div id="fdC"></div><h3>Invoices (${(iv.data || []).length})</h3><div id="fdI"></div><h3>Payments (${pays.length})</h3><div id="fdP"></div>`;
    $("#fdC").innerHTML = E.grid({ cols: [{ label: "Account No", get: (r) => r.account_no }, { label: "Name", get: fullName }, { label: "Business", get: (r) => r.business_name || "" }, { label: "Phone", get: (r) => r.phone || "" }, { label: "Status", html: (r) => pill(r.status) }], rows: custs, onRow: true, empty: "No customers match." });
    E.bindGrid($("#fdC"), custs, (r) => (location.hash = "customer/" + r.id));
    $("#fdI").innerHTML = E.grid({ cols: INV_COLS, rows: iv.data || [], onRow: true, empty: "No invoices match." });
    E.bindGrid($("#fdI"), iv.data || [], (r) => (location.hash = "invoice/" + r.id));
    $("#fdP").innerHTML = E.grid({ cols: PAY_COLS, rows: pays, onRow: true, empty: "No payments match." });
    E.bindGrid($("#fdP"), pays, (r) => (location.hash = "payment/" + r.id));
    const tq = $("#tbQ"); if (tq) tq.value = t;
  };

  // ======================================================================
  // My Photo / Company Logo
  // ======================================================================
  V.profile = () => {
    const av = E.publicUrl("avatars", S.profile.avatar_path);
    E.shell("profile", "My Photo", `<div class="window"><div class="wtitle">${esc(myName())}</div><div class="wbody">
      <div class="profile-photo">${av ? `<img src="${esc(av)}" alt="Your photo">` : `<span>No photo yet</span>`}</div>
      <div class="fields wide"><label for="mpFile">Upload Photo</label><input type="file" id="mpFile" accept="image/*"></div>
      <small>This photo shows at the top right of every page after you sign in.</small></div></div>`);
    $("#mpFile").onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      if (f.size > 5 * 1024 * 1024) return toast("Choose a photo under 5 MB.", true);
      const path = `${S.session.user.id}/Photo_${Date.now()}.${extOf(f)}`;
      const up = await sb.storage.from("avatars").upload(path, f, { contentType: f.type });
      if (up.error) return fail(up.error, "Upload failed");
      const r = await sb.rpc("set_my_avatar", { p_path: path });
      if (r.error) return fail(r.error, "Could not save the photo");
      S.profile.avatar_path = path; toast("Photo saved."); V.profile();
    };
  };
  V.settings = () => {
    if (!isAdmin()) { location.hash = "dashboard"; return; }
    E.shell("settings", "Company Logo", `<div class="window"><div class="wtitle">Company Logo</div><div class="wbody">
      <div class="profile-photo logo">${E.logoHtml("hero-logo")}</div>
      <div class="fields wide"><label for="lgFile">Upload Logo</label><input type="file" id="lgFile" accept="image/*"></div>
      <small>PNG with a transparent background looks best. The logo shows on the login page, every page header, the dashboard and all printouts.</small></div></div>`);
    $("#lgFile").onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      const path = `Logo_${Date.now()}.${extOf(f)}`;
      const up = await sb.storage.from("branding").upload(path, f, { contentType: f.type });
      if (up.error) return fail(up.error, "Upload failed");
      const r = await sb.from("company_settings").update({ logo_path: path, updated_at: new Date().toISOString() }).eq("id", 1);
      if (r.error) return fail(r.error, "Could not save the logo");
      await E.loadBranding(); toast("Logo saved."); V.settings();
    };
  };
  // shared with modules2.js
  Object.assign(E, { extOf, viewFile, signedPanel, bindSigned, latestSigned, uploadRecords, signedUrl, attachmentsOf, filesHtml, bindFiles, fileField, filesOf, printHead, box, cell, sigs, stampHtml, uuid, cleanQ });
})();
