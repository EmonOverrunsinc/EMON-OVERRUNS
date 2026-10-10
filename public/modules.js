/* EMON OVERRUNS E-PORTAL — business modules:
   Dashboard, 1 Customer (profile, statement of account), 2 Invoice, 3 Payment, 4 Credit Memo,
   global search, My Profile and Company Logo. Uses helpers shared by app.js through window.EO. */
(function () {
  "use strict";
  const E = window.EO;
  const { sb, S, C, esc, peso, isoToday, isoDay, mdy, stamp, $, $$, isAdmin, isStaff, pill, toast, fail, words, ic, busy } = E;
  const V = (window.EO_VIEWS = window.EO_VIEWS || {});

  const fullName = (c) => `${c.first_name || ""} ${c.last_name || ""}`.trim();
  const METHOD = { cash: "Cash", bank_transfer: "Bank Transfer", online_transfer: "Online Transfer", deposit: "Bank Deposit" };
  const DEFECT = { fabric_damage: "Fabric Damage (Tears, Holes)", color_issue: "Color Issue", wrong_box: "Wrong Box Delivered", wrong_bundle: "Wrong Bundle", other: "Other" };
  const ACTION = { replacement: "Replacement / Exchange", refund: "Full Refund Transfer", credit: "Credit", discount: "Discount" };
  // The customer's QR code is the Public ID key itself, like a crypto wallet address.
  const custQr = (c) => c.public_id || c.account_no;
  const cleanQ = (q) => String(q || "").replace(/[,%()*\\]/g, " ").trim();
  const num = (v) => Number(v || 0);
  const myName = () => S.profile.full_name || S.session.user.email;
  // randomUUID needs a secure context; fall back to getRandomValues elsewhere.
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (d) => (d ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (d / 4)))).toString(16)));
  // Add Correction / Delete (Director) buttons and the corrections box (modules3.js).
  const tools = (...a) => (E.recordTools ? E.recordTools(...a) : "");
  const bindTools = (root) => E.bindRecordTools && E.bindRecordTools(root);
  const rhBox = (t, id) => (E.rhBox ? E.rhBox(t, id) : "");

  // ---------- files (records bucket + attachments table) ----------
  // Uploaded files are renamed automatically from the record number and what they are,
  // e.g. "INV-202610-0001 Signed Copy" — no file extension is shown.
  const OWNER_NO = {
    customer: ["customers", "account_no"], invoice: ["customer_invoices", "invoice_no"], payment: ["payments_received", "receipt_no"],
    credit_memo: ["credit_memos", "memo_no"], employee: ["employees", "employee_no"], resolution: ["resolutions", "resolution_no"],
    project: ["projects", "project_no"], project_payment: ["project_payments", "payment_no"],
    supplier: ["suppliers", "supplier_no"], supplier_payment: ["supplier_payments", "payment_no"], statement: ["statements", "statement_no"],
    job_application: ["job_applications", "application_no"], payslip: ["payslips", "payslip_no"], order_letter: ["order_letters", "order_no"],
    pay_company: ["pay_companies", "name"], pay_account: ["pay_accounts", "account_name"], pay_voucher: ["pay_vouchers", "voucher_no"],
    stock_bill: ["stock_bills", "bill_no"]
  };
  async function ownerNo(ownerType, ownerId) {
    // a sales report line's file: the e-bill number and the receipt number, e.g. "MF-2026-0001 PN-55"
    if (ownerType === "stock_bill_entry") {
      const { data } = await sb.from("stock_bill_entries").select("receipt_no, stock_bills(bill_no)").eq("id", ownerId).maybeSingle();
      return [data?.stock_bills?.bill_no, data?.receipt_no].filter(Boolean).join(" ");
    }
    const m = OWNER_NO[ownerType];
    if (!m) return "";
    const { data } = await sb.from(m[0]).select(m[1]).eq("id", ownerId).maybeSingle();
    return data?.[m[1]] || "";
  }
  const extOf = (f) => { const m = /\.([a-z0-9]{1,5})$/i.exec(f.name || ""); return m ? m[1].toLowerCase() : (f.type || "").split("/")[1] || "bin"; };
  const slug = (t) => String(t).replace(/[^\w\-]+/g, "_");
  const KIND = {
    photo: "Profile Photo", requirement: "Requirement", signed_form: "Signed Copy", receipt: "Payment Receipt", delivery_receipt: "Delivery Receipt",
    purchase_order: "Purchase Order", proof: "Proof", application: "Application Form", signature: "Signature Form", report: "Report", approval: "Approved Document", other: "Other",
    bill: "E-Bill Copy", shipping_bill: "Shipping Fee Receipt", sales_report: "Sales Report"
  };
  async function autoName(ownerType, ownerId, kind, extraIndex = 0) {
    const [no, existing] = await Promise.all([
      ownerNo(ownerType, ownerId),
      sb.from("attachments").select("id", { count: "exact", head: true }).eq("owner_type", ownerType).eq("owner_id", ownerId).eq("kind", kind)
    ]);
    const n = (existing.count || 0) + extraIndex + 1;
    const label = kind === "signed_form" ? (["customer", "job_application"].includes(ownerType) ? "Signed Application Form" : "Signed Copy") : (KIND[kind] || "File");
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
    if (error) { console.error(error); return ""; }
    return data.signedUrl;
  }
  async function attachmentsOf(ownerType, ownerId) {
    const { data } = await sb.from("attachments").select("*").eq("owner_type", ownerType).eq("owner_id", ownerId).order("created_at", { ascending: false });
    return data || [];
  }
  // A wrong upload can be removed and the right file uploaded again: the Director removes any file,
  // the person who uploaded it within 24 hours. The removal is written in the record's history.
  const canRemove = (f) => !!f && (isAdmin() || (f.uploaded_by === S.profile?.id && Date.now() - new Date(f.created_at).getTime() < 864e5));
  const rmBtn = (f) => canRemove(f) ? `<button type="button" class="btn danger" data-rm="${esc(f.id)}" data-path="${esc(f.storage_path)}" data-name="${esc(f.file_name)}">${ic("trash")} Remove</button>` : "";
  async function removeFile(b) {
    const ok = await E.confirmBox(`Remove <b>${esc(b.dataset.name)}</b>? You can upload the correct file again afterwards.`, { title: "Remove File", ok: "Remove", danger: true });
    if (!ok) return;
    const { data: path, error } = await sb.rpc("remove_attachment", { p_id: b.dataset.rm });
    if (error) return fail(error, "Could not remove the file");
    const rm = await sb.storage.from("records").remove([path || b.dataset.path]);
    if (rm.error) console.error(rm.error);
    toast("File removed. You can upload the correct file now.");
    E.route();
  }
  function filesHtml(list, empty = "No files uploaded.") {
    if (!list.length) return `<div class="empty small">${esc(empty)}</div>`;
    return `<div class="filelist">${list.map((f) => `<div class="file"><span class="kind">${esc(KIND[f.kind] || f.kind)}</span>
      <span class="fname">${esc(f.file_name)}</span><span class="fbtns"><button type="button" class="btn" data-open="${esc(f.storage_path)}" data-mime="${esc(f.mime || "")}" data-name="${esc(f.file_name)}">${ic("eye")} Preview</button>${rmBtn(f)}</span></div>`).join("")}</div>`;
  }
  function bindFiles(root) {
    $$("[data-open]", root).forEach((b) => (b.onclick = () => viewFile({ storage_path: b.dataset.open, mime: b.dataset.mime, file_name: b.dataset.name })));
    $$("[data-rm]", root).forEach((b) => (b.onclick = () => removeFile(b)));
  }
  const isImage = (f) => /^image\//.test(f.mime || "") || /\.(png|jpe?g|gif|webp|heic|bmp)$/i.test(f.storage_path || "");
  // In-page preview of an uploaded file (image or PDF).
  async function viewFile(f) {
    if (!f) return;
    // The saved file keeps its type (e.g. ".jpg") so it opens on any device; the name shown has none.
    const ext = (/\.[a-z0-9]{2,5}$/i.exec(f.storage_path || "") || [""])[0];
    const [url, dl] = await Promise.all([
      signedUrl(f.storage_path, 900),
      sb.storage.from("records").createSignedUrl(f.storage_path, 900, { download: (f.file_name || "file") + ext }).then((r) => r.data?.signedUrl || "", () => "")
    ]);
    if (!url) return toast("The file could not be opened.", true);
    const isPdf = /pdf/.test(f.mime || "") || /\.pdf$/i.test(f.storage_path || "");
    const m = E.modal(`Preview — ${f.file_name || ""}`,
      `<div class="viewer-body">${isImage(f) ? `<img src="${esc(url)}" alt="${esc(f.file_name || "")}">` : isPdf ? `<iframe src="${esc(url)}" title="${esc(f.file_name || "")}"></iframe>` : `<div class="empty">This file type cannot be previewed here.</div>`}</div>`,
      `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">${ic("eye")} Open in New Tab</a><a class="btn" href="${esc(dl || url)}" rel="noopener">${ic("download")} Download</a><button type="button" class="btn primary" data-x>Close</button>`,
      { wide: true, cls: "viewer" });
    $("[data-x]", m.el).onclick = m.close;
  }
  const latestSigned = (att, kind = "signed_form") => att.filter((a) => a.kind === kind).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];

  // ---------- signatures ----------
  // Everyone can upload their signature (My Profile): the Director's counts at once, anyone else's after the Director
  // approves it (User). A document the Director approves prints the Director's approved signature by itself.
  const SIG = { list: null, at: 0, pics: new Map() };
  // A stored signature as a picture (a data URL, kept), so a print can show it at once.
  async function signaturePic(path) {
    if (!path) return "";
    if (!SIG.pics.has(path)) {
      let pic = "";
      try {
        const u = await signedUrl(path, 300);
        const blob = u ? await (await fetch(u)).blob() : null;
        if (blob) pic = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => ok(""); r.readAsDataURL(blob); });
      } catch { pic = ""; }
      if (!/^data:image\//.test(pic)) return "";
      SIG.pics.set(path, pic);
    }
    return SIG.pics.get(path);
  }
  // The Directors' approved signatures, loaded before a print (again after 5 minutes, or at once with force).
  async function loadSignatures(force = false) {
    if (!S.session || S.profile?.status !== "active") return [];
    if (!force && SIG.list && Date.now() - SIG.at < 5 * 60e3) return SIG.list;
    const { data } = await sb.rpc("director_signatures");
    SIG.list = data || []; SIG.at = Date.now();
    await Promise.all(SIG.list.map((x) => signaturePic(x.signature_path)));
    return SIG.list;
  }
  // The approval of a document by the Director, for its print: the name, the date and the signature picture (empty
  // until the Director's signature is uploaded). id: the Director's id; without it the name is used.
  function approvedBy(id, name, at) {
    if (!id && !name) return null;
    const x = (SIG.list || []).find((d) => (id ? d.id === id : d.full_name === name));
    return { name: name || x?.full_name || "", at, pic: x ? SIG.pics.get(x.signature_path) || "" : "" };
  }
  // A photo of a signature made ready to print: the paper made clear, the edges cut off, at most 900 × 320.
  async function cleanSignature(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error("This picture could not be read. Use a JPG or PNG photo.")); i.src = url; });
      const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      const cx = cv.getContext("2d", { willReadFrequently: true }); cx.drawImage(img, 0, 0, w, h);
      const d = cx.getImageData(0, 0, w, h), px = d.data, n = w * h, lum = new Float32Array(n);
      for (let i = 0; i < n; i++) lum[i] = (px[i * 4] * 299 + px[i * 4 + 1] * 587 + px[i * 4 + 2] * 114) / 1000;
      // the paper: a light value most of the picture has; ink is clearly darker than the paper
      const paper = Array.from(lum).sort((a, b) => a - b)[Math.floor(n * 0.6)];
      let x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, Math.min(1, (paper - 25 - lum[i]) / 70));
        px[i * 4 + 3] = Math.round(a * 255);
        if (a > 0.35) { const x = i % w, y = (i / w) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      if (x1 < 0 || (x1 - x0) < 20 || (y1 - y0) < 8) throw new Error("No signature was found in this picture. Sign on white paper with dark ink and take a clear photo.");
      cx.putImageData(d, 0, 0);
      const pad = 10; x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
      const cw = x1 - x0 + 1, ch = y1 - y0 + 1, f = Math.min(1, 900 / cw, 320 / ch);
      const out = document.createElement("canvas"); out.width = Math.round(cw * f); out.height = Math.round(ch * f);
      out.getContext("2d").drawImage(cv, x0, y0, cw, ch, 0, 0, out.width, out.height);
      return await new Promise((ok) => out.toBlob(ok, "image/png"));
    } finally { URL.revokeObjectURL(url); }
  }
  // Upload a signature picture for a person (into their own folder) and give back its path.
  async function uploadSignature(file, userId) {
    const blob = await cleanSignature(file);
    const path = `signature/${userId}/Signature_${Date.now()}.png`;
    const up = await sb.storage.from("records").upload(path, blob, { contentType: "image/png" });
    if (up.error) throw up.error;
    return path;
  }

  // ---------- document cards ----------
  // One card per printable document. Until a signed copy is uploaded the card prints the system form;
  // once the signed copy is uploaded it replaces the form (the system form can no longer be printed here).
  // kind: which upload counts as the signed copy ("approval" for an approved project document).
  // approved ({ name, at }): the Director approved the document. Its print carries the Director's signature, so there is
  // no signed copy to upload; a copy uploaded before the approval can still be opened.
  const DC = new Map();
  function docCard({ key, title, sub = "", ownerType, ownerId, att, print, canUpload = isStaff(), printLabel = "Print / Download", kind = "signed_form", uploadLabel = "Upload Signed Copy", copyName = "Signed copy", approved = null }) {
    DC.set(key, { att, print, kind, copyName });
    const signed = latestSigned(att, kind);
    if (approved) return `<div class="doccard signed esigned">
      <div class="dc-ic">${ic("doc")}<span class="dc-ok">${ic("check")}</span></div>
      <div class="dc-main"><b>${esc(title)}</b><small>Approved${approved.name ? ` by ${esc(approved.name)}` : ""}${approved.at ? ` on ${mdy(approved.at)}` : ""} · the Director's signature is printed on it</small></div>
      <div class="dc-act"><button type="button" class="btn primary" data-dc-print="${esc(key)}">${ic("print")} ${esc(printLabel)}</button>
        ${signed ? `<button type="button" class="btn" data-dc-view="${esc(key)}">${ic("eye")} ${esc(copyName)}</button>` : ""}</div></div>`;
    const upId = `dcUp_${key.replace(/\W/g, "_")}`;
    const mayUpload = signed ? isAdmin() : canUpload;
    return `<div class="doccard${signed ? " signed" : ""}">
      <div class="dc-ic">${ic("doc")}${signed ? `<span class="dc-ok">${ic("check")}</span>` : ""}</div>
      <div class="dc-main"><b>${esc(title)}</b><small>${signed ? `${esc(copyName)} · uploaded ${mdy(signed.created_at)}` : esc(sub || "Print it, have it signed, then upload the signed copy")}</small></div>
      <div class="dc-act">
        ${signed ? `<button type="button" class="btn primary" data-dc-view="${esc(key)}">${ic("eye")} View</button>${rmBtn(signed)}`
          : `<button type="button" class="btn primary" data-dc-print="${esc(key)}">${ic("print")} ${esc(printLabel)}</button>`}
        ${mayUpload ? `<label class="btn" for="${upId}">${ic("upload")} ${signed ? "Replace" : esc(uploadLabel)}</label>
          <input type="file" id="${upId}" hidden accept="image/*,application/pdf" data-dc-up="${esc(key)}" data-owner="${esc(ownerType)}" data-id="${esc(ownerId)}">` : ""}
      </div></div>`;
  }
  function bindDocCards(root, reload) {
    // the Director's signature is loaded first, so an approved document prints with it
    $$("[data-dc-print]", root).forEach((b) => (b.onclick = async () => { b.disabled = true; await loadSignatures().catch(() => {}); b.disabled = false; DC.get(b.dataset.dcPrint)?.print(); }));
    $$("[data-dc-view]", root).forEach((b) => (b.onclick = () => { const d = DC.get(b.dataset.dcView); if (d) viewFile(latestSigned(d.att, d.kind)); }));
    $$("[data-dc-up]", root).forEach((inp) => (inp.onchange = async (e) => {
      const files = Array.from(e.target.files).slice(0, 1);
      if (!files.length) return;
      const card = inp.closest(".doccard");
      card.classList.add("uploading");
      $(".dc-main small", card).innerHTML = `<span class="spin sm"></span> Uploading…`;
      const d = DC.get(inp.dataset.dcUp);
      const f = await uploadRecords(inp.dataset.owner, inp.dataset.id, d?.kind || "signed_form", files);
      toast(f ? "Upload failed." : `${d?.copyName || "Signed copy"} uploaded. It now replaces the system copy.`, f > 0);
      reload();
    }));
    $$("[data-rm]", root).forEach((b) => (b.onclick = () => removeFile(b)));
  }

  const fileField = (id, label, opts = "") => `<label for="${id}">${label}</label><input type="file" id="${id}" ${opts}>`;
  const filesOf = (id) => Array.from(($("#" + id) || {}).files || []);

  // ---------- customer picker ----------
  // statuses: which account statuses may be chosen.
  function customerPicker(holder, { statuses, onPick, preset }) {
    holder.innerHTML = `<div class="picker">
      <div class="picker-row"><input type="search" class="pk-q" placeholder="Type name or account number" aria-label="Find customer">
      <button type="button" class="btn pk-scan">${ic("scan")} Scan QR</button></div>
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
      list.hidden = false;
      list.innerHTML = busy("Searching");
      const w = t.split(/\s+/)[0];
      let qq = sb.from("customers").select("*").or(`first_name.ilike.%${w}%,last_name.ilike.%${w}%,account_no.ilike.%${w}%,business_name.ilike.%${w}%,phone.ilike.%${w}%`).limit(20);
      if (statuses) qq = qq.in("status", statuses);
      const { data } = await qq;
      const words2 = t.toLowerCase().split(/\s+/);
      const rows = (data || []).filter((c) => words2.every((x) => `${fullName(c)} ${c.account_no} ${c.business_name || ""} ${c.phone || ""}`.toLowerCase().includes(x)));
      list.innerHTML = rows.length ? rows.map((c, i) => `<button type="button" data-i="${i}"><b>${esc(fullName(c))}</b> <span class="mono">${esc(c.account_no)}</span> ${pill(c.status)}</button>`).join("")
        : `<div class="empty">No ${statuses ? statuses.join(" / ") + " " : ""}customer matches.</div>`;
      $$("button", list).forEach((b) => (b.onclick = () => choose(rows[Number(b.dataset.i)])));
    };
    q.oninput = () => { clearTimeout(timer); timer = setTimeout(search, 250); };
    $(".pk-scan", holder).onclick = () => E.scanDialog(async (text) => {
      const s = String(text).trim(), q = sb.from("customers").select("*");
      const r = await (E.isCustKey(s) ? q.ilike("public_id", s) : q.eq("account_no", s.startsWith("EMONCUST|") ? s.split("|")[2] || "" : s)).maybeSingle();
      const c = r.data;
      if (!c) return toast("No customer found for that code.", true);
      if (statuses && !statuses.includes(c.status)) return toast(`${fullName(c)}'s account is ${c.status.toUpperCase()} and cannot be used here.`, true);
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
  // Two signature lines. sign (approvedBy): the Director approved the document, so the Director's signature picture stands
  // on the right line, with the name and the date under it.
  const sigCol = (label, sign) => sign
    ? `<div class="sig-on">${sign.pic ? `<img class="esig" src="${esc(sign.pic)}" alt="Signature">` : ""}<div class="line"></div>${label}${sign.name ? `: <b class="nw">${esc(sign.name)}</b>` : ""}${sign.at ? ` &nbsp;·&nbsp; <span class="nw">${esc(mdy(sign.at))}</span>` : ""}</div>`
    : `<div><div class="line"></div>${label}</div>`;
  const sigs = (left, right, sign = null) => `<div class="psig">${sigCol(left)}${sigCol(right, sign)}</div>`;
  // Printed documents carry no status stamps; the signed copy uploaded afterwards is the record.
  const stampHtml = () => "";

  // ======================================================================
  // Dashboard
  // ======================================================================
  V.dashboard = async () => {
    const H = E.hasModule;
    const quick = [
      [E.canWrite("customers"), "#newcustomer", "+ New Customer", "primary"],
      [E.canWrite("invoices"), "#newinvoice", "+ Record Invoice"],
      [E.canWrite("payments") || E.canWrite("invoices"), "#newpayment", "+ Record Payment"],
      [E.canWrite("creditmemos"), "#newcreditmemo", "+ Credit Memo"],
      [["orders", "customers", "employees", "billing"].some(E.canWrite), "#neworder", "+ Request Order"],
      [E.canWrite("billing"), "#newvoucher", "+ Payment Voucher"],
      [true, "#community", "Community"],
      [true, "#verify", "Verify a Record"]
    ].filter((q) => q[0]);
    const today = `${new Date().toLocaleDateString("en-US", { weekday: "long" })}, ${mdy(isoToday())}`;
    E.shell("dashboard", "Dashboard", `
      <section class="hero">${E.logoHtml("hero-logo")}<div>
        <h2>${esc(C.company.name)} <span class="hero-tag">E-PORTAL</span></h2><p>${esc(C.company.address.join(", "))}<br>${esc(C.company.email)} · ${esc(C.company.phone)}</p>
        <p class="welcome">Welcome, <b>${esc(myName())}</b> (${esc(E.personTitle(S.profile.role, S.position).toUpperCase())}) · ${esc(today)}</p></div></section>
      ${isAdmin() ? `<div class="todo" id="dTodo"></div>` : ""}
      ${H("customers") ? `<div class="tiles" id="dTiles">${["Active Customers", "Applications to Review", "Balance Due (₱)", "Payments This Month (₱)"].map((k) => `<div class="tile"><div class="k">${k}</div><div class="v"><span class="spin sm"></span></div></div>`).join("")}</div>` : ""}
      <div class="quick">${quick.map((q) => `<a class="btn ${q[3] || ""}" href="${q[1]}">${esc(q[2])}</a>`).join("")}</div>
      <div class="cols">
        ${H("customers") ? `<div class="box"><h3>Applications Waiting for Review</h3><div class="in" id="dApps">${busy()}</div></div>` : ""}
        <div class="box"><h3>Community <a href="#community" class="box-link">Open</a></h3><div class="in" id="dComm">${busy()}</div></div>
      </div>
      ${H("invoices") || H("payments") ? `<div class="cols" style="margin-top:10px">
        ${H("invoices") ? `<div class="box"><h3>Unpaid Invoices</h3><div class="in" id="dInv">${busy()}</div></div>` : ""}
        ${H("payments") ? `<div class="box"><h3>Recent Payments</h3><div class="in" id="dPay">${busy()}</div></div>` : ""}
      </div>` : ""}`);
    const ym = isoToday().slice(0, 7);
    let soaDone = false; try { soaDone = sessionStorage.getItem("eoSoa") === ym; } catch (_) {}
    if (!soaDone) sb.rpc("generate_statements", {}).then(({ error }) => { if (!error) { try { sessionStorage.setItem("eoSoa", ym); } catch (_) {} } }, () => {});
    loadCommunityBox();
    if (isAdmin()) loadTodo();
    if (!H("customers") && !H("invoices") && !H("payments")) { E.setRecords("Welcome"); return; }
    const [cust, bal, inv, pay] = await Promise.all([
      sb.from("customers").select("id,first_name,last_name,account_no,application_no,status,application_date,business_name").order("created_at", { ascending: false }).limit(1000),
      sb.from("customer_balances").select("balance_due"),
      sb.from("invoice_balances").select("*").in("pay_status", ["unpaid", "partial"]).order("invoice_date", { ascending: false }).limit(8),
      sb.from("payments_received").select("*, customers(first_name,last_name,account_no)").order("created_at", { ascending: false }).limit(200)
    ]);
    if (cust.error) {
      $("#main").insertAdjacentHTML("afterbegin", `<div class="hint err">The customer database is not set up yet. Ask the Director to run the setup script <b>002_customers_invoices_payments.sql</b>.</div>`);
      return;
    }
    const cs = cust.data || [];
    const due = (bal.data || []).reduce((s, b) => s + Math.max(0, num(b.balance_due)), 0);
    const pays = pay.data || [];
    const monthPaid = pays.filter((p) => String(p.paid_date).startsWith(ym)).reduce((s, p) => s + num(p.amount), 0);
    const waiting = cs.filter((c) => ["pending", "verified"].includes(c.status));
    const tiles = [["ok", cs.filter((c) => c.status === "active").length], ["warn", waiting.length], ["", "₱ " + peso(due)], ["ok", "₱ " + peso(monthPaid)]];
    $$("#dTiles .tile").forEach((t, i) => { t.className = "tile " + tiles[i][0]; $(".v", t).textContent = tiles[i][1]; });
    if ($("#dApps")) {
      $("#dApps").innerHTML = E.grid({ cols: [
        { label: "Application", get: (r) => r.application_no }, { label: "Account No", get: (r) => r.account_no },
        { label: "Name", get: fullName }, { label: "Date", get: (r) => mdy(r.application_date) }, { label: "Status", html: (r) => pill(r.status) }],
        rows: waiting.slice(0, 8), onRow: true, empty: "No applications waiting." });
      E.bindGrid($("#dApps"), waiting.slice(0, 8), (r) => (location.hash = "customer/" + r.id));
    }
    if ($("#dInv")) {
      const invs = inv.data || [];
      $("#dInv").innerHTML = E.grid({ cols: [
        { label: "Invoice", get: (r) => r.invoice_no }, { label: "Customer", get: fullName },
        { label: "Balance (₱)", num: true, get: (r) => peso(r.balance) }, { label: "Status", html: (r) => pill(r.pay_status) }],
        rows: invs, onRow: true, empty: "No unpaid invoices." });
      E.bindGrid($("#dInv"), invs, (r) => (location.hash = "invoice/" + r.id));
    }
    if ($("#dPay")) {
      const rp = pays.slice(0, 8);
      $("#dPay").innerHTML = E.grid({ cols: [
        { label: "Receipt", get: (r) => r.receipt_no }, { label: "Customer", get: (r) => fullName(r.customers || {}) },
        { label: "Amount (₱)", num: true, get: (r) => peso(r.amount) }, { label: "Date", get: (r) => mdy(r.paid_date) }],
        rows: rp, onRow: true, empty: "No payments yet." });
      E.bindGrid($("#dPay"), rp, (r) => (location.hash = "payment/" + r.id));
    }
    E.setRecords(`Customers: ${cs.length}`);
  };
  async function loadCommunityBox() {
    const { data, error } = await sb.from("community_posts").select("*").order("created_at", { ascending: false }).limit(4);
    const el = $("#dComm"); if (!el) return;
    if (error) { el.innerHTML = `<div class="empty small">Community is not set up yet.</div>`; return; }
    const rows = data || [];
    const thumbs = await Promise.all(rows.map((p) => (p.photos?.[0] ? signedUrl(p.photos[0], 1800) : "")));
    el.innerHTML = rows.length ? rows.map((p, i) => `<a class="mini-post" href="#community">
        ${thumbs[i] ? `<img src="${esc(thumbs[i])}" alt="">` : ""}
        <div><b class="who">${esc(p.author_name || "")}</b> <span class="pos">${esc(p.author_position || "")}</span><small>${esc(E.timeAgo(p.created_at))}</small>
        <p>${esc((p.body || (p.photos?.length ? "Shared photos" : "")).slice(0, 140))}${(p.body || "").length > 140 ? "…" : ""}</p></div></a>`).join("")
      : `<div class="empty small">No posts yet. <a href="#community">Share the first update</a>.</div>`;
  }
  // Admin to-do: everything waiting for a decision.
  async function loadTodo() {
    const cnt = (q) => q.then((r) => (r.error ? 0 : r.count || 0), () => 0);
    const head = { count: "exact", head: true };
    const [apps, jobs, orders, changes, memos] = await Promise.all([
      cnt(sb.from("customers").select("id", head).in("status", ["pending", "verified"])),
      cnt(sb.from("job_applications").select("id", head).eq("status", "submitted")),
      cnt(sb.from("order_letters").select("id", head).eq("status", "pending")),
      cnt(sb.from("change_requests").select("id", head).eq("status", "pending")),
      cnt(sb.from("credit_memos").select("id", head).eq("status", "pending"))
    ]);
    const el = $("#dTodo"); if (!el) return;
    const items = [[apps, "Customer applications", "#customers"], [jobs, "Job applications", "#jobapps"], [orders, "Orders to approve", "#orders"], [changes, "Corrections", "#changes"], [memos, "Credit memos", "#creditmemos"]];
    el.innerHTML = `<span class="todo-h">Waiting for you:</span>` + items.map(([n, label, href]) => `<a class="todo-chip ${n ? "hot" : ""}" href="${href}"><b>${n}</b> ${esc(label)}</a>`).join("");
  }

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
      <div class="btnrow"><button type="button" class="btn primary" id="cuGo">${ic("search")} Search</button><button type="button" class="btn" id="cuScan">${ic("scan")} Scan QR</button>
        ${E.canWrite("customers") ? `<a class="btn ok" href="#newcustomer">+ New Customer</a>` : ""}${isAdmin() ? `<a class="btn" href="#statements">All Statements (SOA)</a>` : ""}</div>
      <div id="cuRes">${busy("Searching")}</div>`, "All customer accounts. Closed accounts are shown here with a <b>CLOSED</b> mark but are hidden from the top search bar.");
    const run = async () => {
      $("#cuRes").innerHTML = busy("Searching");
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
        { label: "Opened", get: (r) => mdy(r.application_date) }, { label: "Status", html: (r) => pill(r.status) },
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
    if (!E.canWrite("customers")) { toast("Only the Director and employees with Customer access can open customer accounts.", true); location.hash = "customers"; return; }
    E.shell("newcustomer", "New Customer Application", `
      <form class="window" id="ncForm" novalidate>
        <div class="wtitle">Customer Account Application</div>
        <div class="wbody">
          <div class="summary-box"><div class="fields wide">
            <span>Application No</span><b id="ncAppNo">Assigned on submit</b>
            <span>Account No (Customer ID)</span><b id="ncAcctNo">Type the name to see it</b>
            <span>Application Date</span><b>${mdy(isoToday())}</b>
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
            <div class="fields wide"><label for="ncAddr">Address *</label><input type="text" id="ncAddr" required placeholder="House no, street, barangay, city, province">
              <span>Location *</span><div class="checks loc-checks">${Object.entries(LOCATION).map(([k, l]) => `<label><input type="radio" name="ncLoc" value="${k}"> ${esc(l)}</label>`).join("")}</div>
            </div><small>FOUND: the location was checked and found (for example, by a visit or a document). NOT FOUND: it was checked and not found. The Director can change it later from the customer profile.</small></fieldset>
          <fieldset class="opt"><legend>Account</legend><div class="fields wide">
            <label for="ncCredit">Credit Limit (₱)</label><input type="number" id="ncCredit" min="0" step="0.01" inputmode="decimal" placeholder="Optional">
            <label for="ncOpen">Opening Balance (₱)</label><input type="number" id="ncOpen" min="0" step="0.01" inputmode="decimal" placeholder="Optional — leave empty if none">
          </div><small>Credit Limit is kept on the customer record. Opening Balance is an amount the customer already owes when the account is opened: it becomes the account's starting balance.</small></fieldset>
          <fieldset class="opt"><legend>Business</legend><div class="fields wide">
            <label for="ncStart">Business Start Date</label><input type="date" id="ncStart">
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
    // Preview of the account number and application number (the final numbers are given on submit).
    let pvTimer = null, pvSeq = 0;
    const preview = async () => {
      if (!$("#ncFirst")) return; // the form was submitted or left
      const my = ++pvSeq;
      const { data } = await sb.rpc("preview_customer_numbers", { p_first: $("#ncFirst").value.trim(), p_last: $("#ncLast").value.trim() });
      if (my !== pvSeq || !data || !$("#ncAcctNo")) return;
      $("#ncAppNo").textContent = `${data.application_no} (preview)`;
      $("#ncAcctNo").textContent = $("#ncFirst").value.trim() || $("#ncLast").value.trim() ? `${data.account_no} (preview)` : "Type the name to see it";
    };
    ["ncFirst", "ncLast"].forEach((k) => ($("#" + k).oninput = () => { clearTimeout(pvTimer); pvTimer = setTimeout(preview, 300); }));
    preview();
    $$("input[name=ncFbx]").forEach((r) => (r.onchange = () => $$(".fb2").forEach((x) => (x.hidden = r.value !== "yes" || !r.checked))));
    $("#ncPhoto").onchange = (e) => {
      const f = e.target.files[0];
      $("#ncPhotoPrev").innerHTML = f ? `<img src="${URL.createObjectURL(f)}" alt="Profile photo preview">` : "No photo";
    };
    $("#ncCancel").onclick = () => (location.hash = "customers");
    $("#ncForm").onsubmit = async (e) => {
      e.preventDefault();
      clearTimeout(pvTimer);
      const v = (id) => $("#" + id).value.trim();
      if (!v("ncFirst") || !v("ncLast")) return toast("Enter the first and last name.", true);
      if (!v("ncPhone")) return toast("Enter the phone number.", true);
      if (!v("ncAddr")) return toast("Enter the full address.", true);
      const loc = $("input[name=ncLoc]:checked")?.value;
      if (!loc) return toast("Choose the location: FOUND, NO NEED TO CHECK LOCATION or NOT FOUND.", true);
      if (num(v("ncCredit")) < 0 || num(v("ncOpen")) < 0) return toast("The credit limit and opening balance cannot be negative.", true);
      const extra = $("input[name=ncFbx]:checked").value === "yes";
      if (extra && !v("ncFb2")) return toast("Enter the additional Facebook name, or choose No.", true);
      E.setBusy(e.target, true, "Submitting");
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
        location_check: loc, address_verified: loc === "found",
        credit_limit: v("ncCredit") ? num(v("ncCredit")) : null, opening_balance: num(v("ncOpen")) || 0,
        business_start_date: v("ncStart") || null, business_name: v("ncBiz") || null,
        facebook_name: v("ncFb") || null, has_extra_facebook: extra, extra_facebook_name: extra ? v("ncFb2") : null,
        facebook_verified: $("input[name=ncFbv]:checked").value === "yes", phone: v("ncPhone"), email: v("ncEmail") || null
      }).select().single();
      if (error) { E.setBusy(e.target, false); return fail(error, "Could not submit the application"); }
      if (photo_path) await sb.from("attachments").insert({ owner_type: "customer", owner_id: c.id, kind: "photo", storage_path: photo_path, file_name: `${c.account_no} Profile Photo`, mime: photo.type, size: photo.size });
      const failed = await uploadRecords("customer", c.id, "requirement", filesOf("ncReq"));
      if (failed) toast(`${failed} requirement file(s) failed to upload. You can add them from the profile.`, true);
      location.hash = `customer/${c.id}/submitted`;
    };
  };

  // sign: the Director's approval (approvedBy), printed with the Director's signature.
  // A customer's LOCATION check (2.1, in place of the address check): found, no need to check, or not found. A database
  // before 2.1 has only the address check (verified = found).
  const LOCATION = { found: "✔ FOUND", no_need: "NO NEED TO CHECK LOCATION", not_found: "✖ NOT FOUND" };
  const locOf = (c) => (LOCATION[c.location_check] ? c.location_check : c.address_verified ? "found" : "not_found");
  const locFlag = (c) => ({ found: `<span class="flag ok">${ic("check")} Location found</span>`, no_need: `<span class="flag muted">No need to check location</span>`,
    not_found: `<span class="flag bad">${ic("x")} Location not found</span>` })[locOf(c)];
  const locSelect = (c, id) => `<label class="loc-pick" for="${id}">Location <select id="${id}">${Object.entries(LOCATION).map(([k, l]) => `<option value="${k}" ${k === locOf(c) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
  function applicationPage(c, photoUrl, reqs, sign = null) {
    const qr = E.qrDataUrl(custQr(c));
    const bar = E.pdf417DataUrl(c.application_no);
    return `${printHead("CUSTOMER ACCOUNT APPLICATION", `<div class="ph-codes">
        <div><img src="${bar}" alt="Application number barcode" class="ph-bar"><div class="mono">${esc(c.application_no)}</div></div>
        <div><img src="${qr}" alt="Customer QR code" class="ph-qr"><div class="mono key">${esc(c.public_id)}</div></div></div>`)}
      <div class="prow3">${cell("Application No", c.application_no)}${cell("Account No", c.account_no)}${cell("Application Date", mdy(c.application_date))}</div>
      ${box("Customer Information", `<div class="pgrid">
        <div class="pphoto">${photoUrl ? `<img src="${esc(photoUrl)}" alt="">` : "PHOTO"}</div>
        <div class="pgrid2">${cell("First Name", c.first_name)}${cell("Last Name", c.last_name)}
          ${cell("Phone Number", c.phone)}${cell("Email Address", c.email)}
          ${cell("Full Address", c.address, "span2")}</div></div>`)}
      ${box("Business & Facebook", `<div class="pgrid2">
        ${cell("Business Start Date", mdy(c.business_start_date), "span2")}
        ${cell("Facebook Name", c.facebook_name)}${cell("Facebook Account", c.facebook_verified ? "VERIFIED" : "NOT VERIFIED")}
        ${c.has_extra_facebook ? cell("Additional Facebook", "YES — " + (c.extra_facebook_name || ""), "span2") : ""}</div>`)}
      ${box("Requirements Submitted", `<div class="pv" style="padding:6px">${reqs.length ? reqs.map((r) => "☑ " + esc(r.file_name)).join("<br>") : "None uploaded yet"}</div>`)}
      ${box("For Office Use", `<div class="pgrid2">${cell("Issued By", c.issued_by_name)}${cell("Status", c.status.toUpperCase())}
        ${cell("Location", LOCATION[locOf(c)])}${cell("Credit Limit (PHP)", c.credit_limit != null ? peso(c.credit_limit) : "")}
        ${cell("Opening Balance (PHP)", peso(c.opening_balance))}</div>`)}
      <p class="pdecl">I certify that the information above is true and correct, and I agree to the terms of ${esc(C.company.name)}.</p>
      ${sigs("Customer Signature over Printed Name &nbsp; / &nbsp; Date", sign ? "Approved by" : "Approved by (Signature) &nbsp; / &nbsp; Date", sign)}
      <div class="rp-foot"><span>Submit this signed form to the ${esc(C.company.name)} office.</span><span>${esc(c.application_no)}</span></div>`;
  }
  // An approved account: the Director who approved it and when (from its history).
  const isApprovedAccount = (c) => ["active", "suspended", "closed"].includes(c.status);
  async function accountApproval(c) {
    if (!isApprovedAccount(c)) return null;
    const { data } = await sb.from("customer_events").select("actor, actor_name, created_at").eq("customer_id", c.id).eq("action", "approve").order("created_at", { ascending: false }).limit(1);
    const ev = (data || [])[0];
    return { id: ev?.actor || c.reviewed_by, name: ev?.actor_name || "", at: ev?.created_at || c.reviewed_at };
  }
  async function printApplication(c) {
    const [att, ok] = await Promise.all([attachmentsOf("customer", c.id), accountApproval(c), loadSignatures()]);
    const photoUrl = c.photo_path ? await signedUrl(c.photo_path, 900) : "";
    E.openPreview(`Application ${c.application_no}`, [applicationPage(c, photoUrl, att.filter((a) => a.kind === "requirement"), ok ? approvedBy(ok.id, ok.name, ok.at) : null)]);
  }

  // Suspended / closed accounts are marked for everyone who opens them.
  function statusBanner(c) {
    if (c.status === "closed") return `<div class="banner closed">${ic("x")} CLOSED ACCOUNT — new invoices cannot be recorded. It can be reopened only with an approved order letter.${c.status_note ? " " + esc(c.status_note) : ""}</div>`;
    if (c.status === "suspended") return `<div class="banner warn">⚠ SUSPENDED ACCOUNT — new invoices are blocked until the account is reactivated with an approved order letter.${c.status_note ? " " + esc(c.status_note) : ""}</div>`;
    if (c.status === "rejected") return `<div class="banner closed">REJECTED APPLICATION${c.status_note ? " — " + esc(c.status_note) : ""}</div>`;
    return "";
  }
  // Record numbers and codes in a typewriter font; names, dates and amounts in the normal font.
  const idBox = (label, value) => `<div class="idbox"><small>${esc(label)}</small><b class="${/^[A-Z0-9][A-Z0-9-]*\d[A-Z0-9-]*$/i.test(String(value || "")) ? "mono" : ""}">${esc(value || "—")}</b></div>`;
  const fieldLabel = (table, k) => (E.fieldLabel ? E.fieldLabel(table, k) : k.replace(/_/g, " "));
  const showVal = (v) => (v === null || v === undefined || v === "" ? "(empty)" : typeof v === "boolean" ? (v ? "Yes" : "No") : typeof v === "object" ? JSON.stringify(v)
    : /^\d{4}-\d\d-\d\d$/.test(v) ? mdy(v) : String(v));
  const changeText = (r) => Object.keys(r.changes || r.previous || {}).map((k) => `${fieldLabel(r.target_table, k)}: ${showVal(r.previous?.[k])} → ${showVal(r.changes?.[k])}`).join("; ");

  V.customer = async (id, extra) => {
    E.shell("customer", "Customer Profile", busy());
    const c = await getCustomer(id);
    if (!c) { $("#main").innerHTML = `<div class="empty">Customer not found. <a href="#customers">Back to Customers</a></div>`; return; }
    if (extra === "submitted") return renderSubmitted(c);
    const [att, bal, invs, pays, memos, ev, secret, ords, chg] = await Promise.all([
      attachmentsOf("customer", c.id),
      sb.from("customer_balances").select("*").eq("customer_id", c.id).maybeSingle(),
      sb.from("invoice_balances").select("*").eq("customer_id", c.id).order("invoice_date", { ascending: false }),
      sb.from("payments_received").select("*").eq("customer_id", c.id).order("paid_date", { ascending: false }),
      sb.from("credit_memos").select("*").eq("customer_id", c.id).order("memo_date", { ascending: false }),
      sb.from("customer_events").select("*").eq("customer_id", c.id).order("created_at"),
      isAdmin() ? sb.from("customer_secrets").select("private_code").eq("customer_id", c.id).maybeSingle() : Promise.resolve({ data: null }),
      sb.from("order_letters").select("*").eq("customer_id", c.id).order("created_at", { ascending: false }),
      sb.from("record_changes").select("*").eq("target_table", "customers").eq("target_id", c.id).order("created_at")
    ]);
    const b = bal.data || { total_invoiced: 0, total_paid: 0, total_credits: 0, balance_due: 0, total_charges: 0, total_settlement: 0 };
    const photoUrl = c.photo_path ? await signedUrl(c.photo_path) : "";
    const signed = att.filter((a) => a.kind === "signed_form");
    const orders = ords.data || [];
    const canInvoice = c.status === "active" && E.canWrite("invoices");
    const canPay = ["active", "suspended", "closed"].includes(c.status) && (E.canWrite("payments") || E.canWrite("invoices"));
    const canMemo = ["active", "suspended"].includes(c.status) && E.canWrite("creditmemos");
    const canOrder = ["active", "suspended", "closed"].includes(c.status) && (E.canWrite("orders") || E.canWrite("customers"));
    // Active accounts get order requests; a suspended account only a reactivation, a closed one only a reopening.
    const orderBtn = { active: "Request Order", suspended: "Reactivate Account", closed: "Reopen Account" }[c.status];
    const history = [
      ...(ev.data || []).map((r) => ({ at: r.created_at, action: r.action.toUpperCase(), by: r.actor_name || "", note: r.note || "" })),
      ...(chg.data || []).map((r) => r.action === "correction" ? { at: r.created_at, action: `CORRECTION${r.request_no ? " (" + r.request_no + ")" : ""}`, by: r.actor_name || "", note: changeText(r) }
        : { at: r.created_at, action: r.action.toUpperCase(), by: r.actor_name || "", note: r.action === "file removed" ? r.previous?.file || "" : changeText(r) })
    ].sort((x, y) => String(x.at).localeCompare(String(y.at)));
    const tabs = ["Details", "Statement of Account", `Invoices (${(invs.data || []).length})`, `Payments (${(pays.data || []).length})`, `Credit Memos (${(memos.data || []).length})`, `Orders (${orders.length})`, `Files (${att.length})`, "History"];
    $(".band h1").textContent = `Customer — ${fullName(c)}`;
    $("#main").innerHTML = `
      ${statusBanner(c)}
      <section class="cust-hero st-${esc(c.status)}">
        <div class="ch-pic"><div class="ch-photo">${photoUrl ? `<img src="${esc(photoUrl)}" alt="Photo of ${esc(fullName(c))}">` : `<span>${esc(((c.first_name || "")[0] || "") + ((c.last_name || "")[0] || ""))}</span>`}</div>
          ${E.canWrite("customers") ? `<div class="ch-pic-tools"><label class="linkbtn" for="pfPhotoFile">${c.photo_path ? "Change" : "Add Photo"}</label><input type="file" id="pfPhotoFile" accept="image/*" hidden>${c.photo_path ? `<button type="button" class="linkbtn del" id="pfPhotoDel">Remove</button>` : ""}</div>` : ""}</div>
        <div class="ch-main">
          <div class="ch-name"><h2>${esc(fullName(c))}</h2>${pill(c.status)}</div>
          <div class="ch-sub">${[c.business_name, c.phone, c.email].filter(Boolean).map(esc).join(" · ") || "—"}</div>
          <div class="ch-ids">
            ${idBox("Account No", c.account_no)}${idBox("Application No", c.application_no)}${idBox("Opened", mdy(c.application_date))}${c.credit_limit != null ? idBox("Credit Limit", "₱ " + peso(c.credit_limit)) : ""}
            ${isAdmin() ? `<div class="idbox"><small>Private ID</small><b class="mono" id="pvCode" data-code="${esc(secret.data?.private_code || "")}">••••••••</b> <button type="button" class="linkbtn" id="pvShow">Show</button></div>` : ""}
          </div>
          <div class="ch-flags">${locFlag(c)}${isAdmin() && c.status !== "closed" ? locSelect(c, "pfLoc") : ""}${c.facebook_verified ? `<span class="flag ok">${ic("check")} Facebook verified</span>` : ""}</div>
        </div>
        <div class="ch-qr"><canvas id="pfQr" aria-label="Customer QR code"></canvas><small>Public ID</small><b class="mono key" id="pfKey">${esc(c.public_id || "")}</b><button type="button" class="linkbtn" id="pfCopy">${ic("copy")} Copy</button></div>
      </section>
      <div class="tiles">
        ${num(b.opening_balance) > 0 ? `<div class="tile"><div class="k">Opening Balance</div><div class="v">₱ ${peso(b.opening_balance)}</div></div>` : ""}
        <div class="tile"><div class="k">Total Invoiced</div><div class="v">₱ ${peso(b.total_invoiced)}</div></div>
        <div class="tile"><div class="k">Additional Charge</div><div class="v">₱ ${peso(b.total_charges)}</div></div>
        <div class="tile"><div class="k">Settlement Adjustment</div><div class="v">${num(b.total_settlement) < 0 ? "− " : num(b.total_settlement) > 0 ? "+ " : ""}₱ ${peso(Math.abs(num(b.total_settlement)))}</div></div>
        <div class="tile ok"><div class="k">Total Paid</div><div class="v">₱ ${peso(b.total_paid)}</div></div>
        <div class="tile"><div class="k">Credits / Discounts</div><div class="v">₱ ${peso(b.total_credits)}</div></div>
        <div class="tile ${num(b.balance_due) > 0 ? "warn" : "ok"}"><div class="k">Balance Due</div><div class="v">₱ ${peso(b.balance_due)}</div></div>
      </div>
      <div class="actionbar">
        ${canInvoice ? `<a class="btn primary" href="#newinvoice/${c.id}">${ic("plus")} Record Invoice</a>` : ""}
        ${canPay ? `<a class="btn" href="#newpayment/${c.id}">${ic("plus")} Record Payment</a>` : ""}
        ${canMemo ? `<a class="btn" href="#newcreditmemo/${c.id}">${ic("plus")} Credit Memo</a>` : ""}
        ${canOrder ? `<a class="btn" href="#neworder/${c.id}">${ic("doc")} ${orderBtn}</a>` : ""}
        <span class="grow"></span>
        ${tools("customers", c, `${c.account_no} ${fullName(c)}`, { reload: () => V.customer(c.id), afterDelete: () => (location.hash = "customers") })}
      </div>
      <div class="docgrid">${docCard({ key: "app", title: "Customer Application Form", sub: `${c.application_no} · print, have the customer sign it, then upload the signed copy`, ownerType: "customer", ownerId: c.id, att, print: () => printApplication(c), canUpload: isStaff() && c.status !== "closed",
        approved: isApprovedAccount(c) ? (() => { const a = [...(ev.data || [])].reverse().find((x) => x.action === "approve"); return { name: a?.actor_name || "", at: a?.created_at || c.reviewed_at }; })() : null })}</div>
      ${isAdmin() && ["pending", "verified"].includes(c.status) ? reviewPanel(c, signed) : ""}
      <div class="tabs" id="pfTabs">${tabs.map((t, i) => `<button type="button" class="${i ? "" : "on"}" data-t="${i}">${esc(t)}</button>`).join("")}</div>
      <div class="tabpanes">
        <div data-p="0">${detailsTable(c)}${rhBox("customers", c.id)}</div>
        <div data-p="1" hidden id="pfSoa">${busy("Loading statements")}</div>
        <div data-p="2" hidden>${E.grid({ cols: INV_COLS.filter((x) => x.label !== "Customer" && x.label !== "Account No"), rows: invs.data || [], onRow: true, empty: "No invoices yet." })}</div>
        <div data-p="3" hidden>${E.grid({ cols: PAY_COLS.filter((x) => x.label !== "Customer" && x.label !== "Account No"), rows: pays.data || [], onRow: true, empty: "No payments yet." })}</div>
        <div data-p="4" hidden>${E.grid({ cols: MEMO_COLS.filter((x) => x.label !== "Customer"), rows: memos.data || [], onRow: true, empty: "No credit memos." })}</div>
        <div data-p="5" hidden>${E.grid({ cols: [{ label: "Order No", get: (r) => r.order_no }, { label: "Date", get: (r) => mdy(r.order_date) }, { label: "Subject", get: (r) => r.subject }, { label: "Type", get: (r) => r.subject_type.replace(/_/g, " ").toUpperCase() }, { label: "Status", html: (r) => pill(r.status) }, { label: "Result", get: (r) => r.applied_result || "" }], rows: orders, onRow: true, empty: "No orders for this account." })}</div>
        <div data-p="6" hidden>${filesHtml(att)}${isStaff() && c.status !== "closed" ? `<div class="fields wide" style="margin-top:8px">${fileField("pfAdd", "Add Requirement", "multiple")}</div>` : ""}</div>
        <div data-p="7" hidden>${E.grid({ cols: [{ label: "Date / Time", get: (r) => stamp(new Date(r.at)) }, { label: "Action", get: (r) => r.action }, { label: "By", get: (r) => r.by }, { label: "Note", get: (r) => r.note }], rows: history })}</div>
      </div>`;
    E.drawQr($("#pfQr"), custQr(c));
    if ($("#pfLoc")) $("#pfLoc").onchange = (e) => setLocation(c, e.target.value);
    // Change or remove the profile photo. The new photo is kept in Files; the old one leaves Files (and, for the
    // Director, is deleted from storage too).
    const dropOld = (old) => { if (old && isAdmin()) sb.storage.from("records").remove([old]).catch(() => {}); };
    if ($("#pfPhotoFile")) $("#pfPhotoFile").onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      if (!/^image\//.test(f.type)) return toast("Choose a photo (an image file).", true);
      const path = `customer/${c.id}/Profile_Photo_${Date.now()}.${extOf(f)}`;
      const up = await sb.storage.from("records").upload(path, f, { contentType: f.type });
      if (up.error) return fail(up.error, "The photo could not be uploaded");
      const { error } = await sb.rpc("set_customer_photo", { p_id: c.id, p_path: path });
      if (error) return fail(error, "Could not save the photo");
      await sb.from("attachments").insert({ owner_type: "customer", owner_id: c.id, kind: "photo", storage_path: path, file_name: `${c.account_no} Profile Photo`, mime: f.type, size: f.size });
      dropOld(c.photo_path);
      toast("Photo saved."); V.customer(c.id);
    };
    if ($("#pfPhotoDel")) $("#pfPhotoDel").onclick = async () => {
      if (!(await E.confirmBox(`Remove the photo of <b>${esc(fullName(c))}</b>? The profile will show no photo.`, { ok: "Remove Photo", danger: true }))) return;
      const { error } = await sb.rpc("set_customer_photo", { p_id: c.id, p_path: null });
      if (error) return fail(error, "Could not remove the photo");
      dropOld(c.photo_path);
      toast("Photo removed."); V.customer(c.id);
    };
    $("#pfCopy").onclick = async () => {
      try { await navigator.clipboard.writeText(c.public_id); toast("Public ID copied."); }
      catch (_) { getSelection().selectAllChildren($("#pfKey")); toast("Press Ctrl+C (or tap Copy on a phone) to copy the selected Public ID."); }
    };
    $$("#pfTabs button").forEach((t) => (t.onclick = () => {
      $$("#pfTabs button").forEach((x) => x.classList.toggle("on", x === t));
      $$(".tabpanes > div").forEach((p) => (p.hidden = p.dataset.p !== t.dataset.t));
    }));
    E.bindGrid($('[data-p="2"]'), invs.data || [], (r) => (location.hash = "invoice/" + r.id));
    E.bindGrid($('[data-p="3"]'), pays.data || [], (r) => (location.hash = "payment/" + r.id));
    E.bindGrid($('[data-p="4"]'), memos.data || [], (r) => (location.hash = "creditmemo/" + r.id));
    E.bindGrid($('[data-p="5"]'), orders, (r) => (location.hash = "order/" + r.id));
    if (!["pending", "verified", "rejected"].includes(c.status)) renderSoaTab(c, invs.data || [], pays.data || [], memos.data || [], orders);
    else $("#pfSoa").innerHTML = `<div class="empty">Statements start after the account is approved.</div>`;
    bindFiles($("#main"));
    bindDocCards($("#main"), () => V.customer(c.id));
    bindTools($("#main"));
    if ($("#pvShow")) $("#pvShow").onclick = () => { const el = $("#pvCode"); const hidden = el.textContent.startsWith("•"); el.textContent = hidden ? el.dataset.code || "(none)" : "••••••••"; $("#pvShow").textContent = hidden ? "Hide" : "Show"; };
    if ($("#pfAdd")) $("#pfAdd").onchange = async (e) => { const f = await uploadRecords("customer", c.id, "requirement", Array.from(e.target.files)); toast(f ? `${f} file(s) failed to upload.` : "Uploaded.", f > 0); V.customer(c.id); };
    if (isAdmin() && ["pending", "verified"].includes(c.status)) bindReview(c);
    E.setRecords(`Account: ${c.account_no}`);
  };

  function detailsTable(c) {
    const rows = [
      ["First Name", c.first_name], ["Last Name", c.last_name], ["Phone", c.phone], ["Email", c.email],
      ["Full Address", c.address], ["Location", LOCATION[locOf(c)]],
      ["Credit Limit", c.credit_limit != null ? "₱ " + peso(c.credit_limit) : ""], ["Opening Balance", "₱ " + peso(c.opening_balance)],
      ["Business Name", c.business_name], ["Business Start Date", mdy(c.business_start_date)],
      ["Facebook Name", c.facebook_name], ["Additional Facebook", c.has_extra_facebook ? "Yes — " + (c.extra_facebook_name || "") : "No"],
      ["Facebook Account", c.facebook_verified ? "✔ VERIFIED" : "✖ NOT VERIFIED"],
      ["Application Date", mdy(c.application_date)], ["Issued By", c.issued_by_name], ["Account Status", c.status.toUpperCase()], ["Status Note", c.status_note]
    ];
    return `<div class="grid-wrap"><table class="grid kv-table"><tbody>${rows.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v || "—")}</td></tr>`).join("")}</tbody></table></div>`;
  }

  // The Director sets the location check: found, no need to check, or not found.
  async function setLocation(c, loc) {
    if (!LOCATION[loc] || loc === locOf(c)) return;
    const r = await sb.rpc("customer_action", { p_id: c.id, p_action: "location_" + loc, p_note: null });
    if (r.error) return fail(r.error, "Could not update the location");
    toast(`Location: ${LOCATION[loc]}.`);
    V.customer(c.id);
  }
  function reviewPanel(c, signed) {
    return `<fieldset class="opt review"><legend>Director's Review — ${esc(c.application_no)}</legend>
      <ol class="steps">
        <li><b>Check records:</b> look for the same name, phone, email or Facebook name already in the database.
          <div class="btnrow"><button type="button" class="btn primary" id="rvCheck">Check &amp; Verify</button>
          <button type="button" class="btn" id="rvFb">${c.facebook_verified ? "Mark Facebook NOT verified" : "Mark Facebook verified"}</button>
          ${locSelect(c, "rvLoc")}</div><div id="rvResult">${c.status === "verified" ? `<div class="addr-msg ok">✔ Verification successful (already verified).</div>` : ""}</div></li>
        <li><b>Application form signed by the customer:</b> ${signed.length ? `<span class="ok-txt">✔ Uploaded.</span>`
          : `<span class="bad-txt">not uploaded yet.</span> Print the form from the <b>Customer Application Form</b> card above, have the customer sign it, then press <b>Upload Signed Copy</b>.`}
          You do not sign it by hand: your signature is printed on the form when you approve.</li>
        <li><b>Decide:</b>
          <div class="fields wide"><label for="rvNote">Note</label><input type="text" id="rvNote" placeholder="Optional note (shown in history)"></div>
          <div class="btnrow"><button type="button" class="btn ok" id="rvApprove" ${signed.length ? "" : "disabled title=\"Upload the signed application form first\""}>Approve — Activate Account</button>
          <button type="button" class="btn danger" id="rvReject">Reject</button></div></li>
      </ol></fieldset>`;
  }
  function bindReview(c) {
    $("#rvCheck").onclick = async () => {
      const out = $("#rvResult");
      out.innerHTML = busy("Checking records");
      const { data, error } = await sb.rpc("customer_duplicates", { p_id: c.id });
      if (error) { out.innerHTML = ""; return fail(error, "Could not check records"); }
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
          E.grid({ cols: [{ label: "Account No", get: (r) => r.account_no }, { label: "Name", get: fullName }, { label: "Phone", get: (r) => r.phone || "" }, { label: "Status", html: (r) => pill(r.status) }, { label: "Matched On", get: (r) => (r.matched_on || "").replace(/\b\w/g, (x) => x.toUpperCase()) }], rows: data, onRow: true })
          + `<div class="btnrow"><button type="button" class="btn" id="rvAnyway">Not a duplicate — Verify anyway</button></div>`;
        E.bindGrid(out, data, (r) => window.open("#customer/" + r.id, "_blank"));
        $("#rvAnyway").onclick = async () => { await verify(); out.insertAdjacentHTML("beforeend", `<div class="addr-msg ok">✔ Verified by the Director.</div>`); };
      }
    };
    $("#rvFb").onclick = async () => {
      const r = await sb.rpc("customer_action", { p_id: c.id, p_action: c.facebook_verified ? "facebook_unverified" : "facebook_verified", p_note: null });
      if (r.error) return fail(r.error, "Could not update"); V.customer(c.id);
    };
    $("#rvLoc").onchange = (e) => setLocation(c, e.target.value);
    const act = async (a) => {
      const r = await sb.rpc("customer_action", { p_id: c.id, p_action: a, p_note: $("#rvNote").value.trim() || null });
      if (r.error) return fail(r.error, "Could not update the account");
      toast(a === "approve" ? `Approved. ${c.account_no} is now ACTIVE.` : "Application rejected.");
      V.customer(c.id);
    };
    $("#rvApprove").onclick = () => act("approve");
    $("#rvReject").onclick = async () => { if (await E.confirmBox(`Reject the application of <b>${esc(fullName(c))}</b>?`, { ok: "Reject", danger: true })) act("reject"); };
  }

  function renderSubmitted(c) {
    $(".band h1").textContent = "Application Submitted";
    $("#main").innerHTML = `<div class="window submitted">
      <div class="wtitle">✔ The application has been submitted — waiting for review</div>
      <div class="wbody"><div class="sub-grid">
        <div class="fields wide">
          <span>Account Name</span><b>${esc(fullName(c))}</b>
          <span>Account No</span><b class="mono big">${esc(c.account_no)}</b>
          <span>Application No</span><b class="mono">${esc(c.application_no)}</b>
          <span>Application Date</span><b>${mdy(c.application_date)}</b>
          <span>Public ID</span><b class="mono key">${esc(c.public_id)}</b>
          <span>Issued By</span><b>${esc(c.issued_by_name || "")}</b>
          <span>Status</span><span>${pill(c.status)}</span>
        </div>
        <div class="sub-qr"><canvas id="subQr"></canvas><small>Scan to open this account</small></div></div>
        <div class="hint">Next: press <b>Print / Download Application</b>, have the customer sign it, and submit the signed paper to the office. The Director has been notified.</div>
      </div>
      <div class="wfoot"><button type="button" class="btn primary" id="subPrint">${ic("print")} Print / Download Application</button><a class="btn" href="#customer/${c.id}">Open Customer Profile</a><a class="btn" href="#newcustomer">New Customer</a></div></div>`;
    E.drawQr($("#subQr"), custQr(c));
    $("#subPrint").onclick = () => printApplication(c);
  }

  // ======================================================================
  // Statement of Account (SOA)
  // ======================================================================
  const monthStart = (iso) => String(iso).slice(0, 7) + "-01";
  const nextMonth = (iso) => { const d = new Date(monthStart(iso) + "T00:00:00"); d.setMonth(d.getMonth() + 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`; };
  const dayBefore = (iso) => { const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const monthName = (iso) => new Date(monthStart(iso) + "T00:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" });
  // Same rules as the database: invoices, approved Additional Charge orders and Settlement Adjustments that add
  // (on the day they were carried out) debit; payments, approved credit/discount memos (on approval date) and
  // Settlement Adjustments that take money off credit.
  function txnsOf(invs, pays, memos, orders = [], cust = null) {
    const t = [];
    if (num(cust?.opening_balance) > 0) t.push({ date: cust.application_date, ref: cust.account_no, desc: "Opening Balance", debit: num(cust.opening_balance), credit: 0 });
    invs.forEach((i) => t.push({ date: i.invoice_date, ref: i.invoice_no, desc: `Invoice${i.po_number ? " — PO " + i.po_number : ""}`, debit: num(i.total_amount), credit: 0, inv: i }));
    orders.filter((o) => ["charge", "settlement"].includes(o.subject_type) && o.status === "applied" && o.applied_at).forEach((o) => {
      const off = o.subject_type === "settlement" && o.adjust_type === "reduce";
      const what = o.subject_type === "charge" ? "Additional Charge" : "Settlement Adjustment";
      t.push({ date: isoDay(new Date(o.applied_at)), ref: o.order_no, desc: o.subject && o.subject !== what ? `${what} — ${o.subject}` : what, debit: off ? 0 : num(o.amount), credit: off ? num(o.amount) : 0 });
    });
    pays.forEach((p) => t.push({ date: p.paid_date, ref: p.receipt_no, desc: `Payment — ${METHOD[p.method] || p.method}${p.bank_name ? " " + p.bank_name : ""}${p.reference_no ? " Ref " + p.reference_no : ""}`, debit: 0, credit: num(p.amount), pay: p }));
    memos.filter((m) => ["approved", "paid"].includes(m.status) && ["credit", "discount"].includes(m.requested_action) && m.approved_at)
      .forEach((m) => t.push({ date: isoDay(new Date(m.approved_at)), ref: m.memo_no, desc: `Credit Memo — ${ACTION[m.requested_action]}${m.article ? " (" + m.article + ")" : ""}`, debit: 0, credit: num(m.request_amount) }));
    return t.sort((a, b) => a.date.localeCompare(b.date) || (b.debit - a.debit));
  }
  const before = (txns, d) => txns.filter((x) => x.date < d).reduce((s, x) => s + x.debit - x.credit, 0);
  const within = (txns, a, b) => txns.filter((x) => x.date >= a && x.date <= b);

  // Copies attached to the SOA: each invoice's uploaded copy and each payment's receipt for the month.
  async function monthCopies(invoices, payments) {
    const out = [];
    const pick = async (ownerType, rows, kinds, label, noKey, amtKey) => {
      if (!rows.length) return;
      const { data } = await sb.from("attachments").select("*").eq("owner_type", ownerType).in("kind", kinds).in("owner_id", rows.map((r) => r.id)).order("created_at", { ascending: false });
      for (const r of rows) {
        const list = (data || []).filter((a) => a.owner_id === r.id);
        const a = kinds.map((k) => list.find((x) => x.kind === k)).find(Boolean);
        if (!a) continue;
        const img = isImage(a);
        out.push({ label, no: r[noKey], amount: r[amtKey], date: r.invoice_date || r.paid_date, url: img ? await signedUrl(a.storage_path, 1800) : "", pdf: !img });
      }
    };
    await pick("invoice", invoices, ["signed_form"], "Invoice", "invoice_no", "total_amount");
    await pick("payment", payments, ["signed_form", "receipt"], "Payment Receipt", "receipt_no", "amount");
    return out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }
  const copiesSummary = (copies) => {
    const n = (l) => copies.filter((x) => x.label === l).length;
    return [n("Invoice") ? `${n("Invoice")} Invoice(s) Attached` : "", n("Payment Receipt") ? `${n("Payment Receipt")} Payment Receipt(s) Attached` : ""].filter(Boolean).join(" · ");
  };

  // Statement numbers are made by the system: SOA-YYYYMM-<account no> for a month (the same number the monthly
  // statement gets on the 1st), SOA-YYYYMMDD-<account no> for a print of all transactions up to that day.
  const soaNo = (iso, c, day = false) => `SOA-${String(iso).slice(0, day ? 10 : 7).replace(/-/g, "")}-${c.account_no}`;
  // Bank-statement layout: customer name left, statement and account numbers right, running balance, then
  // attached invoice and receipt copies. System-generated: no signature lines.
  function soaPages(c, p, txns, images) {
    let bal = p.opening;
    const rows = txns.map((x) => { bal += x.debit - x.credit; return { ...x, bal }; });
    const deb = txns.reduce((s, x) => s + x.debit, 0), cre = txns.reduce((s, x) => s + x.credit, 0);
    const closing = p.closing ?? (p.opening + deb - cre);
    const head = `<div class="soa-logo">${E.logoHtml("soa-logo-img")}<div class="soa-co">${esc(C.company.name)}</div><div class="soa-addr">${esc(C.company.address.join(", "))} · ${esc(C.company.email)} · ${esc(C.company.phone)}</div></div>
      <div class="ph-title">STATEMENT OF ACCOUNT</div>
      <div class="soa-top"><div class="soa-cust"><b>${esc(fullName(c).toUpperCase())}</b></div>
        <div class="soa-acct"><span>Statement No :</span><b>${esc(p.no || "—")}</b><span>Account No :</span><b>${esc(c.account_no)}</b>
          <span>Period Covered :</span><b>${mdy(p.start)} - ${mdy(p.end)}</b><span>Date Printed :</span><b>${mdy(isoToday())}</b></div></div>`;
    const page1 = `${head}
      <table class="soa-table"><thead><tr><th>DATE</th><th>REFERENCE NO.</th><th>TRANSACTION DESCRIPTION</th><th class="num">DEBIT</th><th class="num">CREDIT</th><th class="num">BALANCE</th></tr></thead>
      <tbody><tr><td>${mdy(p.start)}</td><td></td><td>BEGINNING BALANCE</td><td></td><td></td><td class="num">${peso(p.opening)}</td></tr>
        ${rows.map((x) => `<tr><td>${mdy(x.date)}</td><td>${esc(x.ref)}</td><td>${esc(x.desc)}</td><td class="num">${x.debit ? peso(x.debit) : ""}</td><td class="num">${x.credit ? peso(x.credit) : ""}</td><td class="num">${peso(x.bal)}</td></tr>`).join("")}
        <tr class="soa-end"><td>${mdy(p.end)}</td><td></td><td>ENDING BALANCE</td><td></td><td></td><td class="num">${peso(closing)}</td></tr>
        <tr class="soa-total"><td><b>TOTAL</b></td><td>${rows.length} transaction(s)</td><td>${esc(copiesSummary(images))}</td><td class="num">${peso(deb)}</td><td class="num">${peso(cre)}</td><td></td></tr></tbody></table>
      <div class="soa-due"><span>AMOUNT DUE</span><b>₱ ${peso(closing)}</b><small>${esc(words(Math.max(0, closing)))}</small></div>
      <div class="soa-note">Please examine this statement. Any discrepancy must be reported to ${esc(C.company.name)} within 10 days; otherwise, this statement is considered correct.<br>Payments: ${esc(C.company.phone)} · ${esc(C.company.email)}</div>
      <div class="soa-sys">This is a system-generated statement. No signature is required.</div>
      <div class="soa-thanks">Thank you for your business!</div>`;
    const pages = [page1];
    for (let i = 0; i < images.length; i += 4) {
      const chunk = images.slice(i, i + 4);
      pages.push(`<div class="soa-pg">Page ${pages.length + 1}</div><div class="ph-title" style="text-align:left">ATTACHED DOCUMENTS — ${esc(monthName(p.start).toUpperCase())}</div>
        <div class="soa-imgs">${chunk.map((im) => `<figure>${im.url ? `<img src="${esc(im.url)}" alt="${esc(im.label)} ${esc(im.no)}">` : `<div class="soa-pdf">${esc(im.label)} ${esc(im.no)} — copy on file (PDF)</div>`}
          <figcaption>Acct. No.: ${esc(c.account_no)} &nbsp; ${esc(im.label)} No.: ${esc(im.no)} &nbsp; Amt.: ${peso(im.amount)}</figcaption></figure>`).join("")}</div>`);
    }
    return pages;
  }

  async function printSoa(c, p, allTxns, allInvs) {
    const txns = within(allTxns, p.start, p.end);
    const invs = allInvs.filter((i) => i.invoice_date >= p.start && i.invoice_date <= p.end);
    const pays = txns.filter((x) => x.pay).map((x) => x.pay);
    const images = await monthCopies(invs, pays);
    E.openPreview(`SOA ${p.no || monthName(p.start)}`, soaPages(c, p, txns, images));
  }

  // One SOA for every month, from the month the account opened (or its first record) to this month.
  // A month's saved statement is used when there is one; this month runs to date.
  async function renderSoaTab(c, invs, pays, memos, orders) {
    const box = $("#pfSoa"); if (!box) return;
    const { data } = await sb.from("statements").select("*").eq("customer_id", c.id).order("period_start");
    const txns = txnsOf(invs, pays, memos, orders, c);
    const cm = monthStart(isoToday());
    const saved = new Map((data || []).map((s) => [s.period_start, s]));
    const rows = [];
    for (let m = [monthStart(c.application_date || cm), txns.length ? monthStart(txns[0].date) : cm, ...saved.keys()].sort()[0]; m <= cm; m = nextMonth(m)) {
      const s = saved.get(m);
      if (s) { rows.push({ start: s.period_start, end: s.period_end, opening: num(s.opening_balance), closing: num(s.closing_balance), no: s.statement_no, debit: num(s.total_debit), credit: num(s.total_credit) }); continue; }
      const end = m === cm ? isoToday() : dayBefore(nextMonth(m));
      const t = within(txns, m, end), opening = before(txns, m);
      const debit = t.reduce((x, y) => x + y.debit, 0), credit = t.reduce((x, y) => x + y.credit, 0);
      rows.push({ start: m, end, opening, debit, credit, closing: opening + debit - credit, no: soaNo(m, c), live: m === cm });
    }
    rows.reverse();
    box.innerHTML = `<div class="btnrow"><button type="button" class="btn" id="soaAll">${ic("print")} Print All Transactions</button>${isAdmin() ? `<a class="btn" href="#statements">All Statements (SOA)</a>` : ""}</div>
      ${E.grid({ cols: [
        { label: "Period", get: (r) => r.live ? `${monthName(r.start)} (to date)` : monthName(r.start) }, { label: "Statement No", get: (r) => r.no },
        { label: "Opening (₱)", num: true, get: (r) => peso(r.opening) }, { label: "Debit (₱)", num: true, get: (r) => peso(r.debit) },
        { label: "Credit (₱)", num: true, get: (r) => peso(r.credit) }, { label: "Closing (₱)", num: true, get: (r) => peso(r.closing) },
        { label: "", html: () => `<span class="btn">Print SOA</span>` }], rows, onRow: true })}
      <small>A new statement is created automatically on the 1st of every month. Each month's closing balance is the next month's opening balance.</small>`;
    E.bindGrid(box, rows, (r) => printSoa(c, r, txns, invs));
    $("#soaAll").onclick = () => {
      const start = txns.length ? monthStart(txns[0].date) : monthStart(c.application_date);
      E.openPreview(`All Transactions ${c.account_no}`, soaPages(c, { start, end: isoToday(), opening: 0, no: soaNo(isoToday(), c, true) }, within(txns, start, isoToday()), []));
    };
  }

  // Admin: every customer's SOA for a month.
  V.statements = async () => {
    if (!isAdmin()) { location.hash = "customers"; return; }
    const last = monthStart(new Date(new Date().setDate(0)).toISOString().slice(0, 10));
    E.shell("statements", "All Statements of Account", `
      <div class="options"><fieldset class="opt"><legend>Month</legend><div class="fields"><label for="stMonth">Statement Month</label><input type="month" id="stMonth" value="${last.slice(0, 7)}"></div></fieldset></div>
      <div class="btnrow"><button type="button" class="btn primary" id="stGo">Show</button><button type="button" class="btn" id="stGen">Create Missing Statements Now</button><button type="button" class="btn" id="stPrintAll">${ic("print")} Print All for Month</button><a class="btn" href="#customers">Close</a></div>
      <div id="stRes">${busy()}</div>`, "Statements are created automatically on the 1st of each month for the month just ended. Click a row to print it or upload a copy.");
    let rows = [];
    const load = async () => {
      $("#stRes").innerHTML = busy();
      const m = $("#stMonth").value + "-01";
      const { data, error } = await sb.from("statements").select("*, customers(*)").eq("period_start", m).order("statement_no");
      if (error) return fail(error, "Could not load statements");
      rows = data || [];
      const sum = (k) => peso(rows.reduce((s, r) => s + num(r[k]), 0));
      $("#stRes").innerHTML = E.grid({ cols: [
        { label: "Statement No", get: (r) => r.statement_no }, { label: "Account No", get: (r) => r.customers?.account_no || "" }, { label: "Customer", get: (r) => fullName(r.customers || {}) },
        { label: "Opening (₱)", key: "opening_balance", num: true, get: (r) => peso(r.opening_balance) }, { label: "Debit (₱)", key: "total_debit", num: true, get: (r) => peso(r.total_debit) },
        { label: "Credit (₱)", key: "total_credit", num: true, get: (r) => peso(r.total_credit) }, { label: "Closing (₱)", key: "closing_balance", num: true, get: (r) => peso(r.closing_balance) }],
        rows, onRow: true, foot: { opening_balance: sum("opening_balance"), total_debit: sum("total_debit"), total_credit: sum("total_credit"), closing_balance: sum("closing_balance") }, empty: `No statements for ${monthName(m)} yet.` });
      E.bindGrid($("#stRes"), rows, statementDialog);
      E.setRecords(`Statements: ${rows.length}`);
    };
    const dataFor = async (cid) => {
      const [i, p, m, o, cu] = await Promise.all([
        sb.from("invoice_balances").select("*").eq("customer_id", cid), sb.from("payments_received").select("*").eq("customer_id", cid), sb.from("credit_memos").select("*").eq("customer_id", cid),
        sb.from("order_letters").select("*").eq("customer_id", cid).in("subject_type", ["charge", "settlement"]).eq("status", "applied"),
        sb.from("customers").select("account_no, application_date, opening_balance").eq("id", cid).maybeSingle()]);
      return { invs: i.data || [], txns: txnsOf(i.data || [], p.data || [], m.data || [], o.data || [], cu.data) };
    };
    const asPeriod = (r) => ({ start: r.period_start, end: r.period_end, opening: num(r.opening_balance), closing: num(r.closing_balance), no: r.statement_no });
    async function statementDialog(r) {
      const att = await attachmentsOf("statement", r.id);
      const m = E.modal(`${r.statement_no} — ${fullName(r.customers || {})}`,
        `<div class="docgrid">${docCard({ key: "soa-" + r.id, title: `Statement of Account ${r.statement_no}`, sub: monthName(r.period_start), ownerType: "statement", ownerId: r.id, att,
          print: async () => { m.close(); const x = await dataFor(r.customer_id); printSoa(r.customers, asPeriod(r), x.txns, x.invs); }, uploadLabel: "Upload Copy", copyName: "Copy" })}</div>`,
        `<button type="button" class="btn" data-x>Close</button>`);
      $("[data-x]", m.el).onclick = m.close;
      bindDocCards(m.el, () => { m.close(); statementDialog(r); });
    }
    $("#stGo").onclick = load; $("#stMonth").onchange = load;
    $("#stGen").onclick = async () => { const { data, error } = await sb.rpc("generate_statements", {}); if (error) return fail(error, "Could not create statements"); toast(`${data || 0} new statement(s) created.`); load(); };
    $("#stPrintAll").onclick = async () => {
      if (!rows.length) return toast("No statements for this month.", true);
      const pages = [];
      for (const r of rows) { const x = await dataFor(r.customer_id); const p = asPeriod(r); pages.push(...soaPages(r.customers, p, within(x.txns, p.start, p.end), [])); }
      E.openPreview(`All SOA ${monthName(rows[0].period_start)}`, pages);
    };
    load();
  };

  // ======================================================================
  // 2. Invoice
  // ======================================================================
  const INV_COLS = [
    { label: "Invoice No", get: (r) => r.invoice_no }, { label: "Date", get: (r) => mdy(r.invoice_date) },
    { label: "Account No", get: (r) => r.account_no }, { label: "Customer", get: fullName },
    { label: "PO No", get: (r) => r.po_number || "" }, { label: "Boxes", num: true, get: (r) => r.total_boxes }, { label: "Pcs", num: true, get: (r) => r.total_pcs },
    { label: "Amount (₱)", key: "total_amount", num: true, get: (r) => peso(r.total_amount) },
    { label: "Paid (₱)", key: "amount_paid", num: true, get: (r) => peso(r.amount_paid) },
    { label: "Balance (₱)", key: "balance", num: true, get: (r) => peso(r.balance) },
    { label: "Status", html: (r) => pill(r.pay_status) }
  ];
  V.invoices = async () => {
    E.shell("invoices", "Invoice", `
      <div class="tabs" id="ivTabs"><button type="button" class="on" data-f="open">Active (Unpaid)</button><button type="button" data-f="paid">Paid</button><button type="button" data-f="">All</button></div>
      <div class="btnrow">${E.canWrite("invoices") ? `<a class="btn primary" href="#newinvoice">+ Record Invoice</a>` : ""}</div>
      <div id="ivRes">${busy()}</div>`, "Active invoices still have a balance. Press <b>Record Invoice</b> to add a sale for an ACTIVE customer.");
    const run = async (f) => {
      $("#ivRes").innerHTML = busy();
      let q = sb.from("invoice_balances").select("*").order("invoice_date", { ascending: false }).order("invoice_no", { ascending: false }).limit(2000);
      if (f === "open") q = q.in("pay_status", ["unpaid", "partial"]); else if (f) q = q.eq("pay_status", f);
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
    if (!E.canWrite("invoices")) { toast("Only the Director and employees with Invoice access can record invoices.", true); location.hash = "invoices"; return; }
    E.shell("newinvoice", "Record Invoice", `
      <form class="window" id="niForm" novalidate>
        <div class="wtitle">Record Invoice</div>
        <div class="wbody">
          <fieldset class="opt"><legend>Customer (ACTIVE accounts only)</legend><div id="niCust"></div></fieldset>
          <fieldset class="opt"><legend>Invoice</legend><div class="formgrid">
            <div class="fields wide">
              <label for="niDate">Invoice Date</label><input type="date" id="niDate" value="${isoToday()}">
              <label for="niPDate">Purchase Date</label><input type="date" id="niPDate" value="${isoToday()}">
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
    if (cust && cust.status !== "active") { toast(`${fullName(cust)}'s account is ${cust.status.toUpperCase()} — invoices are blocked.`, true); cust = null; $("#niCust .pk-chosen").innerHTML = ""; }
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
      E.setBusy(e.target, true, "Saving");
      const { data: inv, error } = await sb.from("customer_invoices").insert({
        customer_id: cust.id, invoice_date: $("#niDate").value || isoToday(), purchase_date: $("#niPDate").value || null,
        po_number: $("#niPo").value.trim() || null, total_boxes: Math.max(0, Math.floor(num($("#niBox").value))),
        total_pcs: Math.max(0, Math.floor(num($("#niPcs").value))), total_amount: amt
      }).select().single();
      if (error) { E.setBusy(e.target, false); return fail(error, "Could not record the invoice"); }
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
      toast(`Invoice ${inv.invoice_no} recorded for ${fullName(cust)}.${failed ? ` ${failed} file(s) failed to upload.` : ""}`, failed > 0);
      location.hash = "invoice/" + inv.id;
    };
  };

  V.invoice = async (id) => {
    E.shell("invoice", "Invoice", busy());
    const { data: inv } = await sb.from("invoice_balances").select("*").eq("id", id).maybeSingle();
    if (!inv) { $("#main").innerHTML = `<div class="empty">Invoice not found. <a href="#invoices">Back to Invoices</a></div>`; return; }
    const [pays, att] = await Promise.all([sb.from("payments_received").select("*").eq("invoice_id", id).order("paid_date"), attachmentsOf("invoice", id)]);
    $(".band h1").textContent = `Invoice — ${inv.invoice_no}`;
    $("#main").innerHTML = `<div class="window"><div class="wtitle">${esc(inv.invoice_no)} ${pill(inv.pay_status)}</div><div class="wbody">
      <div class="formgrid"><div class="fields wide">
        <span>Customer</span><span><a href="#customer/${inv.customer_id}"><b>${esc(fullName(inv))}</b> (${esc(inv.account_no)})</a> ${inv.customer_status !== "active" ? pill(inv.customer_status) : ""}</span>
        <span>Invoice Date</span><span>${mdy(inv.invoice_date)}</span><span>Purchase Date</span><span>${mdy(inv.purchase_date) || "—"}</span>
        <span>PO Number</span><span>${esc(inv.po_number || "—")}</span><span>Recorded By</span><span>${esc(inv.created_by_name || "")}</span></div>
      <div class="fields wide"><span>Total Boxes</span><b>${inv.total_boxes}</b><span>Total Pcs</span><b>${inv.total_pcs}</b>
        <span>Total Amount</span><b>₱ ${peso(inv.total_amount)}</b><span>Paid</span><b>₱ ${peso(inv.amount_paid)}</b><span>Balance</span><b>₱ ${peso(inv.balance)}</b></div></div>
      <div class="docgrid">${docCard({ key: "inv", title: `Invoice ${inv.invoice_no}`, sub: `₱ ${peso(inv.total_amount)} · ${mdy(inv.invoice_date)}`, ownerType: "invoice", ownerId: inv.id, att, print: () => E.openPreview(`Invoice ${inv.invoice_no}`, [invoicePage(inv, pays.data || [])]) })}</div>
      <div><b>Payments</b>${E.grid({ cols: PAY_COLS.filter((x) => !["Customer", "Account No", "Invoice"].includes(x.label)), rows: pays.data || [], onRow: true, empty: "No payments yet." })}</div>
      <div><b>Other Files</b>${filesHtml(att.filter((a) => a.kind !== "signed_form"), "No other files.")}</div>
      ${rhBox("customer_invoices", inv.id)}</div>
      <div class="wfoot">${tools("customer_invoices", inv, `Invoice ${inv.invoice_no}`, { reload: () => V.invoice(id), afterDelete: () => (location.hash = "invoices") })}
        ${(E.canWrite("payments") || E.canWrite("invoices")) && ["unpaid", "partial"].includes(inv.pay_status) && !["rejected", "pending", "verified"].includes(inv.customer_status) ? `<a class="btn" href="#newpayment/${inv.customer_id}/${inv.id}">Record Payment</a>` : ""}
        <a class="btn" href="#invoices">Close</a></div></div>`;
    E.bindGrid($("#main"), pays.data || [], (r) => (location.hash = "payment/" + r.id));
    bindFiles($("#main"));
    bindDocCards($("#main"), () => V.invoice(id));
    bindTools($("#main"));
    E.setRecords(`Invoice: ${inv.invoice_no}`);
  };
  function invoicePage(inv, pays) {
    return `${printHead("INVOICE", `<img src="${E.pdf417DataUrl("EMONINV|" + inv.invoice_no)}" alt="" class="ph-bar"><div class="mono">${esc(inv.invoice_no)}</div>`)}
      ${box("Customer", `<div class="pgrid2">${cell("Customer Name", fullName(inv))}${cell("Account No", inv.account_no)}${cell("PO Number", inv.po_number, "span2")}</div>`)}
      ${box("Order", `<div class="prow3">${cell("Invoice Date", mdy(inv.invoice_date))}${cell("Purchase Date", mdy(inv.purchase_date))}${cell("Total Boxes", inv.total_boxes)}</div>
        <div class="prow3">${cell("Total Pcs", inv.total_pcs)}${cell("Total Amount (₱)", peso(inv.total_amount))}${cell("Balance (₱)", peso(inv.balance))}</div>
        <div class="pcell"><div class="pl">Amount in Words</div><div class="pv words">${esc(words(inv.total_amount))}</div></div>`)}
      ${box("Payments Received", pays.length ? `<table class="rp"><thead><tr><th>Receipt No</th><th>Date</th><th>Method</th><th>Reference</th><th class="num">Amount</th></tr></thead><tbody>
        ${pays.map((p) => `<tr><td>${esc(p.receipt_no)}</td><td>${mdy(p.paid_date)}</td><td>${esc(METHOD[p.method])}</td><td>${esc(p.reference_no || "")}</td><td class="num">${peso(p.amount)}</td></tr>`).join("")}</tbody></table>` : `<div class="pv" style="padding:6px">UNPAID</div>`)}
      ${sigs("Received by (Customer Signature) / Date", `Prepared by: ${esc(inv.created_by_name || "")}`)}`;
  }

  // ======================================================================
  // 3. Payment
  // ======================================================================
  const PAY_COLS = [
    { label: "Receipt No", get: (r) => r.receipt_no }, { label: "Date Paid", get: (r) => mdy(r.paid_date) },
    { label: "Account No", get: (r) => r.customers?.account_no || "" }, { label: "Customer", get: (r) => fullName(r.customers || {}) },
    { label: "Method", get: (r) => METHOD[r.method] || r.method }, { label: "Reference", get: (r) => r.reference_no || "" },
    { label: "Invoice", get: (r) => r.invoices?.invoice_no || "" },
    { label: "Amount (₱)", key: "amount", num: true, get: (r) => peso(r.amount) }, { label: "Verified By", get: (r) => r.created_by_name || "" }
  ];
  V.payments = async () => {
    E.shell("payments", "Payment", `
      <div class="btnrow">${E.canWrite("payments") || E.canWrite("invoices") ? `<a class="btn primary" href="#newpayment">+ Record Payment</a>` : ""}</div><div id="pyRes">${busy()}</div>`,
      "All payments received. Each payment gets a receipt number like <b>A-2026-1003-001</b> and a printable acknowledgment.");
    const { data, error } = await sb.from("payments_received").select("*, customers(first_name,last_name,account_no), invoices:customer_invoices(invoice_no)").order("created_at", { ascending: false }).limit(2000);
    if (error) return fail(error, "Could not load payments");
    const rows = data || [];
    $("#pyRes").innerHTML = E.grid({ cols: PAY_COLS, rows, onRow: true, foot: { amount: peso(rows.reduce((s, r) => s + num(r.amount), 0)) }, empty: "No payments yet." });
    E.bindGrid($("#pyRes"), rows, (r) => (location.hash = "payment/" + r.id));
    E.setRecords(`Payments: ${rows.length}`);
  };

  V.newpayment = async (custId, invId) => {
    if (!(E.canWrite("payments") || E.canWrite("invoices"))) { toast("Only the Director and employees with Payment access can record payments.", true); location.hash = "payments"; return; }
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
              <label for="npAcct" class="npb">Deposit Account</label><input type="text" id="npAcct" class="npb" placeholder="Account the money went to">
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
      const { data } = await sb.from("invoice_balances").select("id,invoice_no,balance,invoice_date").eq("customer_id", cust.id).in("pay_status", ["unpaid", "partial"]).order("invoice_date");
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
      E.setBusy(e.target, true, "Saving");
      const { data: p, error } = await sb.from("payments_received").insert({
        customer_id: cust.id, invoice_id: $("#npInv").value || null, amount: amt, method: m, paid_date: $("#npDate").value || isoToday(),
        bank_name: m === "cash" ? null : $("#npBank").value.trim() || null, bank_account: m === "cash" ? null : $("#npAcct").value.trim() || null,
        reference_no: m === "cash" ? null : $("#npRef").value.trim(), notes: $("#npNotes").value.trim() || null
      }).select().single();
      if (error) { E.setBusy(e.target, false); return fail(error, "Could not record the payment"); }
      let failed = await uploadRecords("payment", p.id, "receipt", filesOf("npRcpt"));
      failed += await uploadRecords("payment", p.id, "purchase_order", filesOf("npPo"));
      if (failed) toast(`${failed} file(s) failed to upload.`, true);
      location.hash = `payment/${p.id}/done`;
    };
  };

  V.payment = async (id, extra) => {
    E.shell("payment", "Payment", busy());
    const { data: p } = await sb.from("payments_received").select("*, customers(*), invoices:customer_invoices(invoice_no,total_amount)").eq("id", id).maybeSingle();
    if (!p) { $("#main").innerHTML = `<div class="empty">Payment not found. <a href="#payments">Back to Payments</a></div>`; return; }
    const att = await attachmentsOf("payment", id);
    $(".band h1").textContent = `Payment — ${p.receipt_no}`;
    $("#main").innerHTML = `
      ${extra === "done" ? `<div class="banner ok">✔ Payment successfully recorded — Receipt No <b>${esc(p.receipt_no)}</b>. It has been added to ${esc(fullName(p.customers))}'s account.</div>` : ""}
      <div class="window"><div class="wtitle">${esc(p.receipt_no)}</div><div class="wbody">
      <div class="formgrid"><div class="fields wide">
        <span>Customer</span><span><a href="#customer/${p.customer_id}"><b>${esc(fullName(p.customers))}</b> (${esc(p.customers.account_no)})</a> ${p.customers.status !== "active" ? pill(p.customers.status) : ""}</span>
        <span>Amount</span><b>₱ ${peso(p.amount)}</b><span>In Words</span><span>${esc(words(p.amount))}</span>
        <span>Date Paid</span><span>${mdy(p.paid_date)}</span></div>
      <div class="fields wide"><span>Method</span><span>${esc(METHOD[p.method])}</span><span>Bank</span><span>${esc(p.bank_name || "—")}</span>
        <span>Deposit Account</span><span>${esc(p.bank_account || "—")}</span><span>Reference No</span><span>${esc(p.reference_no || "—")}</span>
        <span>Invoice</span><span>${p.invoice_id ? `<a href="#invoice/${p.invoice_id}">${esc(p.invoices?.invoice_no || "")}</a>` : "General payment"}</span>
        <span>Verified By</span><span>${esc(p.created_by_name || "")}</span></div></div>
      <div class="docgrid">${docCard({ key: "ack", title: `Acknowledgment Receipt ${p.receipt_no}`, sub: `₱ ${peso(p.amount)} · ${mdy(p.paid_date)}`, ownerType: "payment", ownerId: p.id, att, print: () => E.openPreview(`Acknowledgment ${p.receipt_no}`, [ackPage(p)]), uploadLabel: "Upload Copy", copyName: "Copy" })}</div>
      <div><b>Uploaded Receipts &amp; Files</b>${filesHtml(att.filter((a) => a.kind !== "signed_form"), "No receipts uploaded.")}</div>
      ${rhBox("payments_received", p.id)}</div>
      <div class="wfoot">${tools("payments_received", p, `Receipt ${p.receipt_no}`, { reload: () => V.payment(id), afterDelete: () => (location.hash = "payments") })}<a class="btn" href="#payments">Close</a></div></div>`;
    bindFiles($("#main"));
    bindDocCards($("#main"), () => V.payment(id));
    bindTools($("#main"));
    E.setRecords(`Receipt: ${p.receipt_no}`);
  };
  // System-generated: no signature lines.
  function ackPage(p) {
    const c = p.customers;
    return `${printHead("ACKNOWLEDGMENT RECEIPT", `<img src="${E.pdf417DataUrl("EMONPAY|" + p.receipt_no)}" alt="" class="ph-bar"><div class="mono">${esc(p.receipt_no)}</div>`)}
      ${box("Received From", `<div class="pgrid2">${cell("Customer Name", fullName(c))}${cell("Account No", c.account_no)}${cell("Date Paid", mdy(p.paid_date))}${cell("Received & Verified By", p.created_by_name)}</div>`)}
      ${box("Payment Details", `<div class="prow3">${cell("Amount (₱)", peso(p.amount))}${cell("Method", METHOD[p.method])}${cell("Reference No", p.reference_no)}</div>
        <div class="prow3">${cell("Bank", p.bank_name)}${cell("Deposit Account", p.bank_account)}${cell("Applied to Invoice", p.invoices?.invoice_no || "General payment")}</div>
        <div class="pcell"><div class="pl">Amount in Words</div><div class="pv words">${esc(words(p.amount))}</div></div>`)}
      <p class="pdecl">This acknowledges that ${esc(C.company.name)} has received the payment above. Receipt No ${esc(p.receipt_no)}.</p>
      <div class="soa-sys">This is a system-generated receipt. No signature is required.</div>`;
  }

  // ======================================================================
  // 4. Credit Memo (customer complaint)
  // ======================================================================
  const MEMO_COLS = [
    { label: "Report No", get: (r) => r.memo_no }, { label: "Date", get: (r) => mdy(r.memo_date) },
    { label: "Customer", get: (r) => fullName(r.customers || {}) }, { label: "Article", get: (r) => r.article || "" },
    { label: "Defect", get: (r) => DEFECT[r.defect_category] || "" }, { label: "Request", get: (r) => ACTION[r.requested_action] || "" },
    { label: "Amount (₱)", key: "request_amount", num: true, get: (r) => peso(r.request_amount) }, { label: "Status", html: (r) => pill(r.status) }
  ];
  V.creditmemos = async () => {
    E.shell("creditmemos", "Credit Memo", `
      <div class="btnrow">${E.canWrite("creditmemos") ? `<a class="btn primary" href="#newcreditmemo">+ New Credit Memo</a>` : ""}</div><div id="cmRes">${busy()}</div>`,
      "Customer complaints and defect claims. Approved <b>Credit</b> and <b>Discount</b> memos reduce the customer's balance due.");
    const { data, error } = await sb.from("credit_memos").select("*, customers(first_name,last_name,account_no)").order("created_at", { ascending: false }).limit(2000);
    if (error) return fail(error, "Could not load credit memos");
    const rows = data || [];
    $("#cmRes").innerHTML = E.grid({ cols: MEMO_COLS, rows, onRow: true, foot: { request_amount: peso(rows.reduce((s, r) => s + num(r.request_amount), 0)) }, empty: "No credit memos yet." });
    E.bindGrid($("#cmRes"), rows, (r) => (location.hash = "creditmemo/" + r.id));
    E.setRecords(`Credit memos: ${rows.length}`);
  };

  V.newcreditmemo = async (custId) => {
    if (!E.canWrite("creditmemos")) { toast("Only the Director and employees with Credit Memo access can create credit memos.", true); location.hash = "creditmemos"; return; }
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
              <label for="cmAmt">Requested Amount (₱)</label><input type="number" id="cmAmt" min="0" step="0.01" value="0"></div>
              <small id="cmCalc"></small></div></div></fieldset>
          <fieldset class="opt"><legend>Warehouse Verification (Internal Office Use)</legend><div class="fields wide">
            <label for="cmAssign">Assigned By</label><input type="text" id="cmAssign" value="${esc(myName())}">
            <label for="cmNotes">Inspection Notes</label><textarea id="cmNotes" rows="3" placeholder="e.g. PROOF OF VIDEO 60% GREEN SUBMITTED"></textarea>
            <label for="cmFactory">Factory Status</label><textarea id="cmFactory" rows="2" placeholder="e.g. PENDING REVIEW FACTORY — MODINA APPARELS PVT, DHAKA"></textarea>
            ${fileField("cmProof", "Proof (photos / video)", 'multiple accept="image/*,video/*,application/pdf"')}</div></fieldset>
        </div>
        <div class="wfoot"><button type="button" class="btn" id="cmCancel">Cancel</button><button type="submit" class="btn primary">Submit for Approval</button></div>
      </form>`, "After you submit it, the Director reviews and approves it. Approved <b>Credit</b> / <b>Discount</b> amounts are deducted from the account balance.");
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
      E.setBusy(e.target, true, "Submitting");
      const { data: m, error } = await sb.from("credit_memos").insert({
        customer_id: cust.id, memo_date: v("cmDate") || isoToday(), payment_ref: v("cmPay") || null, po_number: v("cmPo") || null,
        article: v("cmArt") || null, brand: v("cmBrand") || null, style: v("cmStyle") || null, batch_no: v("cmBatch") || null, serial_no: v("cmSerial") || null,
        qty: Math.max(0, Math.floor(num(v("cmQty")))), purchase_date: v("cmPDate") || null,
        defect_category: $("input[name=cmDef]:checked").value, defect_detail: v("cmDefD") || null,
        requested_action: $("input[name=cmAct]:checked").value, rate: num(v("cmRate")), request_amount: num(v("cmAmt")),
        assigned_by: v("cmAssign") || null, inspection_notes: v("cmNotes") || null, factory_status: v("cmFactory") || null
      }).select().single();
      if (error) { E.setBusy(e.target, false); return fail(error, "Could not save the credit memo"); }
      const failed = await uploadRecords("credit_memo", m.id, "proof", filesOf("cmProof"));
      toast(`Credit memo ${m.memo_no} submitted for approval.${failed ? ` ${failed} file(s) failed to upload.` : ""}`, failed > 0);
      location.hash = "creditmemo/" + m.id;
    };
  };

  V.creditmemo = async (id) => {
    E.shell("creditmemo", "Credit Memo", busy());
    const { data: m } = await sb.from("credit_memos").select("*, customers(*)").eq("id", id).maybeSingle();
    if (!m) { $("#main").innerHTML = `<div class="empty">Credit memo not found. <a href="#creditmemos">Back to Credit Memos</a></div>`; return; }
    const att = await attachmentsOf("credit_memo", id);
    $(".band h1").textContent = `Credit Memo — ${m.memo_no}`;
    $("#main").innerHTML = `<div class="window"><div class="wtitle">${esc(m.memo_no)} ${pill(m.status)}</div><div class="wbody">
      <div class="formgrid"><div class="fields wide">
        <span>Customer</span><span><a href="#customer/${m.customer_id}"><b>${esc(fullName(m.customers))}</b> (${esc(m.customers.account_no)})</a> ${m.customers.status !== "active" ? pill(m.customers.status) : ""}</span>
        <span>Payment Reference</span><span>${esc(m.payment_ref || "—")}</span><span>Purchase Order</span><span>${esc(m.po_number || "—")}</span>
        <span>Article</span><span>${esc(m.article || "—")}</span><span>Brand / Style</span><span>${esc([m.brand, m.style].filter(Boolean).join(" / ") || "—")}</span>
        <span>Batch / Serial</span><span>${esc([m.batch_no, m.serial_no].filter(Boolean).join(" / ") || "—")}</span>
        <span>Qty</span><span>${m.qty}</span><span>Purchase Date</span><span>${mdy(m.purchase_date) || "—"}</span></div>
      <div class="fields wide">
        <span>Defect</span><span>${esc(DEFECT[m.defect_category])}${m.defect_detail ? " — " + esc(m.defect_detail) : ""}</span>
        <span>Request</span><span>${esc(ACTION[m.requested_action])}${m.rate > 0 ? ` (₱${peso(m.rate)} / pc)` : ""}</span>
        <span>Requested Amount</span><b>₱ ${peso(m.request_amount)}</b>
        <span>Assigned By</span><span>${esc(m.assigned_by || "—")}</span><span>Inspection Notes</span><span>${esc(m.inspection_notes || "—")}</span>
        <span>Factory Status</span><span>${esc(m.factory_status || "—")}</span>
        <span>Approved By</span><span>${esc(m.approved_by_name || "—")} ${m.approved_at ? mdy(m.approved_at) : ""}</span>
        <span>Paid / Settled</span><span>${m.paid_at ? `${esc(m.paid_by_name || "")} ${mdy(m.paid_at)}` : "—"}</span></div></div>
      <div class="docgrid">${docCard({ key: "memo", title: `Credit Memo ${m.memo_no}`, sub: `₱ ${peso(m.request_amount)} · ${mdy(m.memo_date)}`, ownerType: "credit_memo", ownerId: m.id, att, print: () => E.openPreview(`Credit Memo ${m.memo_no}`, [memoPage(m)]),
        approved: memoApproved(m) ? { name: m.approved_by_name, at: m.approved_at } : null })}</div>
      <div><b>Proof</b>${filesHtml(att.filter((a) => a.kind !== "signed_form"), "No proof uploaded.")}</div>
      ${isAdmin() && ["pending", "approved"].includes(m.status) ? `<fieldset class="opt review"><legend>Director's Decision</legend>
        <div class="fields wide"><label for="cmNote">Note</label><input type="text" id="cmNote"></div>
        <div class="btnrow">${m.status === "pending" ? `<button type="button" class="btn ok" data-a="approve">Approve</button><button type="button" class="btn danger" data-a="reject">Reject</button>` : `<button type="button" class="btn ok" data-a="paid">Mark as PAID / Settled</button>`}</div></fieldset>` : ""}
      ${rhBox("credit_memos", m.id)}
      </div><div class="wfoot">${tools("credit_memos", m, `Credit Memo ${m.memo_no}`, { reload: () => V.creditmemo(id), afterDelete: () => (location.hash = "creditmemos") })}<a class="btn" href="#creditmemos">Close</a></div></div>`;
    bindFiles($("#main"));
    bindDocCards($("#main"), () => V.creditmemo(id));
    bindTools($("#main"));
    $$("[data-a]").forEach((b) => (b.onclick = async () => {
      const r = await sb.rpc("credit_memo_action", { p_id: m.id, p_action: b.dataset.a, p_note: $("#cmNote").value.trim() || null });
      if (r.error) return fail(r.error, "Could not update the credit memo");
      toast(`${m.memo_no} updated.`); V.creditmemo(m.id);
    }));
    E.setRecords(`Credit memo: ${m.memo_no}`);
  };
  // A credit memo the Director approved is printed with the Director's signature on "Approval Signature".
  const memoApproved = (m) => ["approved", "paid"].includes(m.status) && !!(m.approved_by || m.approved_by_name);
  function memoPage(m) {
    const c = m.customers;
    const sign = memoApproved(m) ? approvedBy(m.approved_by, m.approved_by_name, m.approved_at) : null;
    return `<div class="cm-head"><div><div class="cm-co">${esc(C.company.name)}</div><div class="cm-date">${esc(mdy(m.memo_date))}</div></div>
        <div class="cm-rep"><div><span>REPORT:</span> <b>${esc(m.memo_no)}</b></div><img src="${E.pdf417DataUrl("EMONCM|" + m.memo_no)}" alt=""></div></div>
      <div class="ph-title" style="text-align:left">CUSTOMER COMPLAINT</div>
      ${box("Customer / Buyer Information", `<div class="pgrid2">${cell("Customer Name", fullName(c).toUpperCase(), "hl")}${cell("Account No", c.account_no, "hl")}
        ${cell("Payment Reference", m.payment_ref)}${cell("Purchase Order", m.po_number)}</div>`)}
      ${box("Garment & Order Details", `<div class="pgrid4">${cell("Garment Description / Article", m.article, "span2 hl")}${cell("Brand", m.brand)}${cell("Style", m.style)}
        ${cell("Batch Number", m.batch_no, "hl")}${cell("Serial Number", m.serial_no)}${cell("Qty", m.qty, "hl")}${cell("Purchase Date", mdy(m.purchase_date), "hl")}</div>`)}
      ${box("Defect Parameters & Customer Request", `<div class="pgrid2"><div class="pcell"><div class="pl">Defect Category</div>
          ${Object.entries(DEFECT).map(([k, v]) => radio(m.defect_category === k, k === m.defect_category && m.defect_detail ? `${v}: ${m.defect_detail}`.toUpperCase() : v)).join("")}</div>
        <div class="pcell"><div class="pl">Requested Action</div>${Object.entries(ACTION).map(([k, v]) => radio(m.requested_action === k, k === "discount" && m.rate > 0 ? `${v} ${peso(m.rate)} PHP` : v)).join("")}</div></div>
        ${cell("Requested Amount", (m.rate > 0 ? `${m.qty} × ${peso(m.rate)} = ` : "") + peso(m.request_amount) + " PHP", "hl")}`)}
      ${box("Warehouse Verification (Internal Office Use) — " + C.company.name, `<div class="pgrid2">
        <div>${cell("Assigned By", m.assigned_by)}${cell("Inspection Notes", m.inspection_notes)}</div>
        <div class="pcell"><div class="pl">Status</div><div class="pv" style="white-space:pre-wrap;font-weight:bold">${esc((m.factory_status || "").toUpperCase())}</div>
</div></div>`)}
      ${sigs("Customer Signature &nbsp; Date: ____________", sign ? "Approval Signature" : "Approval Signature &nbsp; Date: ____________", sign)}`;
  }

  // ======================================================================
  // Global search (top bar)
  // ======================================================================
  V.find = async (q) => {
    const t = cleanQ(q);
    E.shell("find", `Search: ${t}`, `<div id="fdRes">${busy("Searching")}</div>`);
    const tq = $("#tbQ"); if (tq) tq.value = t;
    const done = () => { const sp = $("#tbSpin"); if (sp) sp.hidden = true; };
    if (!t) { done(); $("#fdRes").innerHTML = `<div class="empty">Type something in the search bar.</div>`; return; }
    const sp = $("#tbSpin"); if (sp) sp.hidden = false;
    const w = t.split(/\s+/)[0];
    const H = E.hasModule;
    const none = Promise.resolve({ data: [] });
    const [cs, iv, py, ol, vo, em] = await Promise.all([
      H("customers") ? sb.from("customers").select("*").neq("status", "closed").or(`first_name.ilike.%${w}%,last_name.ilike.%${w}%,account_no.ilike.%${w}%,public_id.ilike.%${w}%,business_name.ilike.%${w}%,phone.ilike.%${w}%`).limit(100) : none,
      H("invoices") ? sb.from("invoice_balances").select("*").neq("customer_status", "closed").or(`invoice_no.ilike.%${w}%,po_number.ilike.%${w}%`).limit(50) : none,
      H("payments") ? sb.from("payments_received").select("*, customers(first_name,last_name,account_no,status)").or(`receipt_no.ilike.%${w}%,reference_no.ilike.%${w}%`).limit(50) : none,
      E.canOpen("orders") || H("employees") || H("billing") ? sb.from("order_letters").select("*, customers(first_name,last_name,account_no), employees(first_name,last_name,employee_no), pay_companies(name)").or(`order_no.ilike.%${w}%,subject.ilike.%${w}%`).limit(30) : none,
      H("billing") ? sb.from("pay_vouchers").select("*, pay_companies(name)").or(`voucher_no.ilike.%${w}%,reference_no.ilike.%${w}%,purpose.ilike.%${w}%`).limit(30) : none,
      H("employees") ? sb.from("employees").select("*").or(`first_name.ilike.%${w}%,last_name.ilike.%${w}%,employee_no.ilike.%${w}%,email.ilike.%${w}%`).limit(30) : none
    ]);
    done();
    if (!$("#fdRes")) return; // navigated away
    const ws = t.toLowerCase().split(/\s+/);
    const custs = (cs.data || []).filter((c) => ws.every((x) => `${fullName(c)} ${c.account_no} ${c.public_id} ${c.business_name || ""} ${c.phone || ""}`.toLowerCase().includes(x)));
    const pays = (py.data || []).filter((p) => p.customers?.status !== "closed");
    const sections = [];
    if (H("customers")) sections.push(["Customers", custs, [{ label: "Account No", get: (r) => r.account_no }, { label: "Name", get: fullName }, { label: "Business", get: (r) => r.business_name || "" }, { label: "Phone", get: (r) => r.phone || "" }, { label: "Status", html: (r) => pill(r.status) }], (r) => "customer/" + r.id]);
    if (H("invoices")) sections.push(["Invoices", iv.data || [], INV_COLS, (r) => "invoice/" + r.id]);
    if (H("payments")) sections.push(["Payments", pays, PAY_COLS, (r) => "payment/" + r.id]);
    const orderFor = (r) => r.employees ? `Employee: ${fullName(r.employees)}` : r.pay_companies ? `Company: ${r.pay_companies.name}` : r.customers ? `Customer: ${fullName(r.customers)}` : "";
    if ((ol.data || []).length) sections.push(["Orders", ol.data, [{ label: "Order No", get: (r) => r.order_no }, { label: "For", get: orderFor }, { label: "Subject", get: (r) => r.subject }, { label: "Status", html: (r) => pill(r.status) }], (r) => "order/" + r.id]);
    if ((vo.data || []).length) sections.push(["Payment Vouchers", vo.data, [{ label: "Voucher No", get: (r) => r.voucher_no }, { label: "Company", get: (r) => r.pay_companies?.name || "" }, { label: "Date", get: (r) => mdy(r.pay_date) }, { label: "PHP", num: true, get: (r) => r.amount_php == null ? "—" : peso(r.amount_php) }, { label: "BDT", num: true, get: (r) => r.amount_bdt == null ? "—" : peso(r.amount_bdt) }], (r) => "voucher/" + r.id]);
    if ((em.data || []).length) sections.push(["Employees", em.data, [{ label: "Employee No", get: (r) => r.employee_no }, { label: "Name", get: fullName }, { label: "Position", get: (r) => r.position || "" }, { label: "Status", html: (r) => pill(r.status) }], (r) => "employee/" + r.id]);
    const total = sections.reduce((s, x) => s + x[1].length, 0);
    $("#main").innerHTML = `<div class="find-sum">${total ? `${ic("search")} ${total} record(s) found for “${esc(t)}”` : `${ic("search")} Nothing found for “${esc(t)}”. Try a different spelling, or <a href="#verify/${encodeURIComponent(t)}">verify it as a record number</a>.`}</div>`
      + sections.map(([title, rows], i) => `<h3>${esc(title)} (${rows.length})</h3><div id="fd${i}"></div>`).join("");
    sections.forEach(([, rows, cols, link], i) => {
      $("#fd" + i).innerHTML = E.grid({ cols, rows, onRow: true, empty: "No matches." });
      E.bindGrid($("#fd" + i), rows, (r) => (location.hash = link(r)));
    });
    E.setRecords(`Found: ${total}`);
  };

  // ======================================================================
  // Signature Verification Form: blank (Download Forms), with boxes to collect a person's signatures; or one person's
  // form with the signature on record. Once the Director approves the signature, the Director's signature is printed
  // in the approval box by itself.
  // ======================================================================
  const SIG_STATUS = { approved: "APPROVED", pending: "WAITING FOR THE DIRECTOR'S APPROVAL", rejected: "NOT APPROVED" };
  const sigPill = (st) => pill(st === "approved" ? "approved" : st === "rejected" ? "rejected" : "pending", st === "pending" ? "WAITING FOR APPROVAL" : SIG_STATUS[st] || "");
  // p: null for the blank form, or { id, full_name, position, employee_no, username, phone, email, signature_pic,
  // signature_status, signature_at, signature_note, approval } (approval: approvedBy, when the signature is approved).
  function signatureFormPage(p = null) {
    const ref = p ? "SVF-" + String(p.id || "").replace(/-/g, "").slice(0, 8).toUpperCase() : "";
    const one = (label, sign) => `<div class="psig one"><div></div>${sigCol(label, sign)}</div>`;
    const sign = p && p.signature_status === "approved" ? p.approval : null;
    const details = p
      ? [["Full Name", p.full_name, "hl"], ["Position / Designation", p.position], ["Employee No / ID No", p.employee_no], ["Username", p.username ? "@" + p.username : ""], ["Phone Number", p.phone], ["Email Address", p.email]]
      : [["Full Name", ""], ["Position / Designation", ""], ["Employee No / ID No", ""], ["Department", ""], ["Phone Number", ""], ["Email Address", ""]];
    const boxes = p
      ? `<div class="sv-one">${p.signature_pic ? `<img src="${esc(p.signature_pic)}" alt="Signature">` : `<span>No signature uploaded yet</span>`}</div>
        <div class="sv-cap">Signature on record${p.signature_at ? ` · uploaded on ${esc(mdy(p.signature_at))}` : ""}</div>`
      : `<div class="sv-boxes">${[1, 2, 3].map((n) => `<div class="sv-box"><span>Signature ${n}</span></div>`).join("")}</div>
        <div class="sv-row"><div class="sv-box sv-ini"><span>Initials</span></div><p>Sign inside each box with black or blue ink, the same way you sign every document. Keep each signature inside its box and do not touch the lines.</p></div>`;
    return `${printHead("SIGNATURE VERIFICATION FORM", `<div class="sb-no"><small>Form No</small><b>EO-SVF</b><small>${p ? `Ref: ${esc(ref)}` : "Version 2.0"}</small></div>`)}
      <div class="sv-form${p ? "" : " blank"}"><p class="sv-intro">${p ? `The signature of <b>${esc(p.full_name || "")}</b> kept on record by ${esc(C.company.name)}.`
        : `Write your details, then sign three times in the boxes below. The Director checks the signatures; once approved, your signature is kept on record by ${esc(C.company.name)}.`}</p>
      ${box("Personal Details", `<div class="pgrid2">${details.map(([k, x, c]) => cell(k, x || "", c || "")).join("")}</div>`)}
      ${box(p ? "Signature" : "Specimen Signatures", boxes)}
      ${box("Declaration", `<p class="pdecl">I confirm that ${p ? "this signature is" : "the signatures above are"} my own. I allow ${esc(C.company.name)} to keep ${p ? "it" : "them"} on record and to print my approved signature on the documents I prepare or approve in the ${esc(E.APP)}.</p>
        ${p ? `<div class="sv-by">Uploaded by <b>${esc(p.full_name || "")}</b>${p.signature_at ? ` on ${esc(mdy(p.signature_at))}` : ""} in the ${esc(E.APP)}.</div>` : sigs("Signature over Printed Name", "Date")}`)}
      ${box("For Office Use — Verification", `${p ? `<div class="sv-status ${esc(p.signature_status || "none")}">Status: <b>${esc(SIG_STATUS[p.signature_status] || "NO SIGNATURE YET")}</b>${p.signature_status === "rejected" && p.signature_note ? ` — ${esc(p.signature_note)}` : ""}</div>` : ""}
        ${p ? one(sign ? "Approved by the Director" : "Verified and Approved by the Director / Date", sign)
          : `${sigs("Received and Checked by / Date", "Verified and Approved by the Director / Date")}<div class="sv-remarks">Remarks:</div>`}`)}
      </div><div class="rp-foot"><span>${esc(E.APP)} — Signature Verification Form EO-SVF</span><span>${p ? esc(ref) : "Keep this form in the person's file"}</span></div>`;
  }
  // One person's form (from My Profile or User): the signature on record and, once approved, the Director's signature.
  async function openSignatureForm(prof, emp = null) {
    const [, pic] = await Promise.all([loadSignatures(), signaturePic(prof.signature_path)]);
    E.openPreview(`Signature Verification Form ${prof.full_name || ""}`.trim(), [signatureFormPage({
      id: prof.id, full_name: prof.full_name, email: prof.email, username: prof.username, position: E.personTitle(prof.role, emp?.position),
      employee_no: emp?.employee_no || "", phone: emp?.phone || "", signature_pic: pic, signature_status: prof.signature_status,
      signature_at: prof.signature_at, signature_note: prof.signature_note,
      approval: prof.signature_status === "approved" ? approvedBy(prof.signature_approved_by, prof.signature_approved_by_name, prof.signature_approved_at) : null })]);
  }
  // The blank form, to print or save as PDF (Download Forms).
  const openBlankSignatureForm = () => E.openPreview("Signature Verification Form", [signatureFormPage(null)], { undated: true });
  // Choose a signature photo: it is cleaned (white paper removed) and shown before it is saved. save(path) stores it.
  function pickSignature(input, userId, title, save) {
    input.onchange = async (e) => {
      const f = e.target.files[0]; e.target.value = "";
      if (!f) return;
      if (f.size > 15 * 1024 * 1024) return toast("Choose a photo under 15 MB.", true);
      let blob;
      try { blob = await cleanSignature(f); } catch (err) { return toast(err.message || "This picture could not be used.", true); }
      const url = URL.createObjectURL(blob);
      const m = E.modal(title, `<div class="sig-check"><img src="${url}" alt="Signature"></div><p class="muted">This is how the signature will be printed. The white paper is taken away.</p>`,
        `<button type="button" class="btn" data-x>Cancel</button><button type="button" class="btn primary" data-ok>${ic("check")} Save Signature</button>`);
      const done = () => { URL.revokeObjectURL(url); m.close(); };
      $("[data-x]", m.el).onclick = done;
      $("[data-ok]", m.el).onclick = async () => {
        const b = $("[data-ok]", m.el); b.disabled = true;
        const path = `signature/${userId}/Signature_${Date.now()}.png`;
        const up = await sb.storage.from("records").upload(path, blob, { contentType: "image/png" });
        if (up.error) { b.disabled = false; return fail(up.error, "Upload failed"); }
        const ok = await save(path);
        if (ok) done(); else b.disabled = false;
      };
    };
  }

  // ======================================================================
  // My Profile (photo, username, employee record, payslip history) and Company Logo
  // ======================================================================
  V.profile = async () => {
    const av = E.publicUrl("avatars", S.profile.avatar_path);
    E.shell("profile", "My Profile", busy());
    // the signature's status may have changed since sign-in (the Director approves it)
    const { data: fresh } = await sb.from("profiles").select("signature_path, signature_status, signature_at, signature_approved_by, signature_approved_by_name, signature_approved_at, signature_note").eq("id", S.profile.id).maybeSingle();
    if (fresh) Object.assign(S.profile, fresh);
    const sp = S.profile, myPic = await signaturePic(sp.signature_path);
    const { data: emp } = await sb.from("employees").select("*").eq("profile_id", S.profile.id).maybeSingle();
    const slips = emp ? (await sb.from("payslips").select("*").eq("employee_id", emp.id).order("pay_date", { ascending: false })).data || [] : [];
    // Approved orders about me (memo, suspension, reactivation): tap one to see and print the letter.
    const myOrders = emp ? (await sb.from("order_letters").select("*").eq("employee_id", emp.id).in("status", ["approved", "applied"]).order("created_at", { ascending: false })).data || [] : [];
    const netTotal = slips.reduce((s, p) => s + num(p.net_pay), 0);
    $("#main").innerHTML = `
      <section class="me-card">
        <div class="me-photo">${av ? `<img src="${esc(av)}" alt="Your photo">` : `<span>${esc(E.initials(myName()))}</span>`}
          <label class="btn small" for="mpFile">${ic("camera")} Change Photo</label><input type="file" id="mpFile" accept="image/*" hidden></div>
        <div class="me-main"><h2>${esc(myName())}</h2>
          <div class="me-sub">${S.profile.username ? `@${esc(S.profile.username)} · ` : ""}${esc(S.session.user.email)} · ${esc(E.personTitle(S.profile.role, emp?.position).toUpperCase())}</div>
          ${emp ? `<div class="ch-ids">${idBox("Employee No", emp.employee_no)}${idBox("Position", emp.position)}${idBox("Date Hired", mdy(emp.date_hired))}${idBox("Monthly Salary (₱)", peso(emp.monthly_salary))}</div>` : ""}
        </div>
      </section>
      <div class="cols">
        <fieldset class="opt"><legend>Username</legend>
          ${S.profile.username ? `<p>Your username is <b>@${esc(S.profile.username)}</b>. You can sign in with it or with your email.</p>`
            : `<p>Set a username so you can sign in without typing your email.</p><div class="fields wide"><label for="mpUser">Username</label><input type="text" id="mpUser" maxlength="20" autocapitalize="none" spellcheck="false" placeholder="3–20 letters, numbers, dot or underscore"></div>
              <div class="btnrow"><button type="button" class="btn primary" id="mpUserSave">Save Username</button></div>`}
        </fieldset>
        <fieldset class="opt"><legend>Password</legend><p>Change the password you sign in with.</p><div class="btnrow"><button type="button" class="btn" id="mpPw">${ic("key")} Change Password</button></div></fieldset>
      </div>
      <fieldset class="opt sigset" id="mpSigBox"><legend>My Signature</legend>
        ${myPic ? `<div class="sig-show"><img src="${esc(myPic)}" alt="My signature"></div><div class="sig-st">${sigPill(sp.signature_status)}${sp.signature_status === "approved" && sp.signature_approved_by_name ? ` <small>by ${esc(sp.signature_approved_by_name)} on ${mdy(sp.signature_approved_at)}</small>` : ""}</div>` : `<p><b>No signature yet.</b></p>`}
        ${sp.signature_status === "rejected" && sp.signature_note ? `<div class="hint err">Not approved: ${esc(sp.signature_note)}. Upload a clearer signature.</div>` : ""}
        <p class="muted">${isAdmin() ? "Your signature is printed by itself on every document you approve (order letters, applications, credit memos, projects and signature forms)."
          : "Upload your signature; the Director approves it, then your Signature Verification Form is ready."} Sign on white paper with dark ink, take a clear photo and upload it: the white paper is taken away for you.</p>
        <div class="btnrow"><label class="btn primary" for="mpSig">${ic("upload")} ${myPic ? "Change Signature" : "Upload Signature"}</label><input type="file" id="mpSig" accept="image/*" hidden>
          ${sp.signature_path ? `<button type="button" class="btn" id="mpSigForm">${ic("print")} Signature Verification Form</button><button type="button" class="btn danger" id="mpSigRm">${ic("trash")} Remove</button>`
            : `<button type="button" class="btn" id="mpSigBlank">${ic("print")} Blank Signature Verification Form</button>`}</div>
      </fieldset>
      ${emp ? `<h3>My Payslip History</h3>
        <div class="tiles"><div class="tile"><div class="k">Payslips</div><div class="v">${slips.length}</div></div><div class="tile ok"><div class="k">Total Received (₱)</div><div class="v">₱ ${peso(netTotal)}</div></div></div>
        <div id="mpSlips">${E.grid({ cols: [{ label: "Payslip No", get: (r) => r.payslip_no }, { label: "Type", get: (r) => r.pay_type.toUpperCase() }, { label: "Period", get: (r) => new Date(r.period_month + "T00:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" }) }, { label: "Pay Date", get: (r) => mdy(r.pay_date) }, { label: "Net Pay (₱)", num: true, get: (r) => peso(r.net_pay) }], rows: slips, onRow: true, empty: "No salary or advance payments recorded yet." })}</div>` : ""}
      ${myOrders.length ? `<h3>My Orders</h3><div id="mpOrders">${E.ordersGrid(myOrders, "")}</div>` : ""}`;
    if (emp) E.bindGrid($("#mpSlips"), slips, (r) => (location.hash = "payslip/" + r.id));
    if (myOrders.length) E.bindGrid($("#mpOrders"), myOrders, (r) => E.printOrder(r.id));
    $("#mpPw").onclick = () => E.changePassword();
    pickSignature($("#mpSig"), sp.id, "My Signature", async (path) => {
      const r = await sb.rpc("set_my_signature", { p_path: path });
      if (r.error) { fail(r.error, "Could not save the signature"); return false; }
      if (isAdmin()) await loadSignatures(true);
      toast(isAdmin() ? "Signature saved. It is printed on the documents you approve." : "Signature saved. It waits for the Director's approval.");
      V.profile(); return true;
    });
    if ($("#mpSigForm")) $("#mpSigForm").onclick = () => openSignatureForm(S.profile, emp);
    if ($("#mpSigBlank")) $("#mpSigBlank").onclick = openBlankSignatureForm;
    if ($("#mpSigRm")) $("#mpSigRm").onclick = async () => {
      if (!(await E.confirmBox("Remove your signature? It is no longer printed on documents.", { ok: "Remove", danger: true }))) return;
      const r = await sb.rpc("set_my_signature", { p_path: null });
      if (r.error) return fail(r.error, "Could not remove the signature");
      if (isAdmin()) await loadSignatures(true);
      toast("Signature removed."); V.profile();
    };
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
    if ($("#mpUserSave")) $("#mpUserSave").onclick = async () => {
      const u = $("#mpUser").value.trim().toLowerCase();
      if (!/^[a-z0-9._]{3,20}$/.test(u)) return toast("Use 3–20 letters, numbers, dot or underscore.", true);
      const r = await sb.rpc("set_my_username", { p_username: u });
      if (r.error) return fail(r.error, "Could not save the username");
      S.profile.username = u; toast(`Username @${u} saved.`); V.profile();
    };
    E.setRecords(emp ? `Employee: ${emp.employee_no}` : "My Profile");
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
  // shared with modules2.js and modules3.js
  Object.assign(E, {
    extOf, viewFile, latestSigned, uploadRecords, signedUrl, attachmentsOf, filesHtml, bindFiles, fileField, filesOf, isImage,
    docCard, bindDocCards, customerPicker, getCustomer, fullName, printHead, box, cell, sigs, sigCol, stampHtml, uuid, cleanQ, idBox, METHOD,
    loadSignatures, approvedBy, signaturePic, uploadSignature, pickSignature, sigPill, signatureFormPage, openSignatureForm, openBlankSignatureForm
  });
})();
