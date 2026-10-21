/* EMON OVERRUNS E-PORTAL — business modules:
   Dashboard, 1 Customer (profile, statement of account), 2 Invoice, 3 Payment, 4 Credit Memo,
   global search, My Profile and Company Logo. Uses helpers shared by app.js through window.EO. */
(function () {
  "use strict";
  const E = window.EO;
  const { sb, S, C, esc, peso, isoToday, isoDay, mdy, stamp, $, $$, isAdmin, isStaff, pill, toast, fail, words, ic, busy, num, fullName } = E;
  const V = (window.EO_VIEWS = window.EO_VIEWS || {});

  const METHOD = { cash: "Cash", bank_transfer: "Bank Transfer", online_transfer: "Online Transfer", deposit: "Bank Deposit" };
  const DEFECT = { fabric_damage: "Fabric Damage (Tears, Holes)", color_issue: "Color Issue", wrong_box: "Wrong Box Delivered", wrong_bundle: "Wrong Bundle", other: "Other" };
  const ACTION = { replacement: "Replacement / Exchange", refund: "Full Refund Transfer", credit: "Credit", discount: "Discount" };
  // The customer's QR code is the Public ID key itself, like a crypto wallet address.
  const custQr = (c) => c.public_id || c.account_no;
  const cleanQ = (q) => String(q || "").replace(/[,%()*\\]/g, " ").trim();
  const myName = () => S.profile.full_name || S.session.user.email;
  // randomUUID needs a secure context; fall back to getRandomValues elsewhere.
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (d) => (d ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (d / 4)))).toString(16)));
  // Edit / Delete (Director) buttons and the corrections box (modules3.js).
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
    for (const raw of files) {
      if (raw.size > 50 * 1024 * 1024) { failed++; toast("A file larger than 50 MB was skipped.", true); continue; }
      const f = await E.slimFile(raw); // 2.2.2: a smaller picture, still clear in print
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
    // 2.7.3: a paper copy update that waits for the Director is kept apart (att.pending) until it is approved
    const all = data || [], att = all.filter((a) => !a.pending);
    att.pending = all.filter((a) => a.pending);
    return att;
  }
  // A wrong upload can be removed and the right file uploaded again: the Director removes any file,
  // the person who uploaded it within 24 hours. The removal is written in the record's history.
  const canRemove = (f) => !!f && (isAdmin() || (S.profile?.status === "active" && f.uploaded_by === S.profile?.id && Date.now() - new Date(f.created_at).getTime() < 864e5));
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

  // ---------- document cards ----------
  // One card per printable document. Until a signed copy is uploaded the card prints the system form;
  // once the signed copy is uploaded it replaces the form (the system form can no longer be printed here).
  // kind: which upload counts as the signed copy ("approval" for an approved project document).
  // approved ({ name, at }): the Director approved the document. Its print carries the Director's signature, so there is
  // no signed copy to upload; a copy uploaded before the approval can still be opened.
  const DC = new Map();
  function docCard({ key, title, sub = "", ownerType, ownerId, att, print, canUpload = isStaff(), printLabel = "Print / Download", kind = "signed_form", uploadLabel = "Upload Signed Copy", copyName = "Signed copy", approved = null, tag = "" }) {
    const tg = tag ? `<span class="dc-tag">${esc(tag)}</span>` : "";
    DC.set(key, { att, print, kind, copyName });
    const signed = latestSigned(att, kind);
    if (approved) return `<div class="doccard signed esigned">
      <div class="dc-ic">${ic("doc")}<span class="dc-ok">${ic("check")}</span></div>
      <div class="dc-main">${tg}<b>${esc(title)}</b><small>Approved${approved.name ? ` by ${esc(approved.name)}` : ""}${approved.at ? ` on ${mdy(approved.at)}` : ""} · the Director's signature is printed on it</small></div>
      <div class="dc-act"><button type="button" class="btn primary" data-dc-print="${esc(key)}">${ic("print")} ${esc(printLabel)}</button>
        ${signed ? `<button type="button" class="btn" data-dc-view="${esc(key)}">${ic("eye")} ${esc(copyName)}</button>` : ""}</div></div>`;
    const upId = `dcUp_${key.replace(/\W/g, "_")}`;
    const mayUpload = signed ? isAdmin() : canUpload;
    return `<div class="doccard${signed ? " signed" : ""}">
      <div class="dc-ic">${ic("doc")}${signed ? `<span class="dc-ok">${ic("check")}</span>` : ""}</div>
      <div class="dc-main">${tg}<b>${esc(title)}</b><small>${signed ? `${esc(copyName)} · uploaded ${mdy(signed.created_at)}` : esc(sub || "Print it, have it signed, then upload the signed copy")}</small></div>
      <div class="dc-act">
        ${signed ? `<button type="button" class="btn primary" data-dc-view="${esc(key)}">${ic("eye")} View</button>${rmBtn(signed)}`
          : `<button type="button" class="btn primary" data-dc-print="${esc(key)}">${ic("print")} ${esc(printLabel)}</button>`}
        ${mayUpload ? `<label class="btn" for="${upId}">${ic("upload")} ${signed ? "Replace" : esc(uploadLabel)}</label>
          <input type="file" id="${upId}" hidden accept="image/*,application/pdf" data-save-now data-dc-up="${esc(key)}" data-owner="${esc(ownerType)}" data-id="${esc(ownerId)}">` : ""}
      </div></div>`;
  }
  // 2.6: a card for a paper copy (scanned or uploaded): View / Replace / Remove, or Add when there is none yet
  // kinds: the kinds of upload shown here (the newest one); a new upload is saved as kind.
  function copyCard({ key, title, sub = "", ownerType, ownerId, att, kind, kinds = [kind], canUpload = isStaff(), addLabel = "Upload", tag = "" }) {
    const shown = att.filter((a) => kinds.includes(a.kind));
    const f = [...shown].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    // 2.7.3: with a copy on file, a new scan or upload is an Update; an employee's Update waits for the Director
    const wait = (att.pending || []).filter((a) => kinds.includes(a.kind))[0];
    DC.set(key, { att: shown.map((a) => ({ ...a, kind })), kind, copyName: title, plain: true, update: !!f, wait });
    const upId = `dcUp_${key.replace(/\W/g, "_")}`;
    const mayUpdate = canUpload && !(wait && !isAdmin());
    return `<div class="doccard${f ? " signed" : ""}">
      <div class="dc-ic">${ic("doc")}${f ? `<span class="dc-ok">${ic("check")}</span>` : ""}</div>
      <div class="dc-main">${tag ? `<span class="dc-tag">${esc(tag)}</span>` : ""}<b>${esc(title)}</b><small>${f ? `On file · uploaded ${mdy(f.created_at)}` : esc(sub || "No copy yet")}</small>
        ${wait ? `<small class="dc-wait">${ic("clock")} Update waiting for the Director's approval · sent ${mdy(wait.created_at)}</small>` : ""}</div>
      <div class="dc-act">${f ? `<button type="button" class="btn primary" data-dc-view="${esc(key)}">${ic("eye")} View</button>${rmBtn(f)}` : ""}
        ${wait ? `<button type="button" class="btn" data-dc-viewp="${esc(key)}">${ic("eye")} View Update</button>
          ${isAdmin() ? `<button type="button" class="btn ok" data-dc-ok="${esc(wait.id)}">${ic("check")} Approve</button><button type="button" class="btn danger" data-dc-no="${esc(wait.id)}">${ic("x")} Reject</button>` : ""}` : ""}
        ${mayUpdate ? `<label class="btn${f ? "" : " primary"}" for="${upId}"${window.EOApp ? " hidden" : ""}>${ic("upload")} ${f ? "Update" : esc(addLabel)}</label>
          <input type="file" id="${upId}" hidden accept="image/*,application/pdf" data-save-now data-dc-up="${esc(key)}" data-owner="${esc(ownerType)}" data-id="${esc(ownerId)}"${f ? ' data-scan-label="Update"' : ""}>` : ""}
      </div></div>`;
  }
  function bindDocCards(root, reload) {
    // the Director's signature is loaded first, so an approved document prints with it
    $$("[data-dc-print]", root).forEach((b) => (b.onclick = async () => { b.disabled = true; await loadSignatures().catch(() => {}); b.disabled = false; DC.get(b.dataset.dcPrint)?.print(); }));
    $$("[data-dc-view]", root).forEach((b) => (b.onclick = () => { const d = DC.get(b.dataset.dcView); if (d) viewFile(latestSigned(d.att, d.kind)); }));
    $$("[data-dc-up]", root).forEach((inp) => (inp.onchange = async (e) => {
      const files = Array.from(e.target.files).slice(0, 1);
      if (!files.length) return;
      const here = E.stillHere();
      const card = inp.closest(".doccard");
      card.classList.add("uploading");
      $(".dc-main small", card).innerHTML = `<span class="spin sm"></span> Uploading…`;
      const d = DC.get(inp.dataset.dcUp);
      const f = await uploadRecords(inp.dataset.owner, inp.dataset.id, d?.kind || "signed_form", files);
      toast(f ? "Upload failed." : d?.plain && d.update && !isAdmin() ? "Update sent to the Director for approval." : d?.plain ? `${d.copyName} saved.` : `${d?.copyName || "Signed copy"} uploaded. It now replaces the system copy.`, f > 0);
      if (here()) reload();
    }));
    $$("[data-rm]", root).forEach((b) => (b.onclick = () => removeFile(b)));
    $$("[data-dc-viewp]", root).forEach((b) => (b.onclick = () => { const d = DC.get(b.dataset.dcViewp); if (d?.wait) viewFile(d.wait); }));
    const decide = async (b, ok) => {
      if (!ok && !(await E.confirmBox("Reject this paper copy update? It is deleted and the copy on file stays.", { title: "Reject Update", ok: "Reject", danger: true }))) return;
      b.disabled = true;
      const { data: path, error } = await sb.rpc("decide_attachment", { p_id: ok ? b.dataset.dcOk : b.dataset.dcNo, p_ok: ok });
      if (error) { b.disabled = false; return fail(error, "Could not decide the update"); }
      if (path) sb.storage.from("records").remove([path]).catch(() => {});
      toast(ok ? "Update approved: it is now the copy on file." : "Update rejected."); reload();
    };
    $$("[data-dc-ok]", root).forEach((b) => (b.onclick = () => decide(b, true)));
    $$("[data-dc-no]", root).forEach((b) => (b.onclick = () => decide(b, false)));
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
      list.hidden = true; q.value = fullName(c); // 2.9: the chosen name stays in the box
      chosen.innerHTML = `<div class="chosen"><b>${esc(fullName(c))}</b> <span class="mono">${esc(c.account_no)}</span> ${pill(c.status)}
        ${c.business_name ? `<small>${esc(c.business_name)}</small>` : ""}</div>`;
      onPick(c);
    };
    const search = async () => {
      const t = cleanQ(q.value);
      if (t.length < 2) { list.hidden = true; return; }
      list.hidden = false;
      list.innerHTML = busy("Searching");
      // 2.9: every typed word (its first 2-3 letters are enough) must start a word of the name, account no, business
      // or phone; first-name matches come first, then last-name matches, then the rest
      const words2 = t.toLowerCase().split(/\s+/).filter(Boolean);
      const w = words2.slice().sort((a, b) => b.length - a.length)[0];
      let qq = sb.from("customers").select("*").or(`first_name.ilike.%${w}%,last_name.ilike.%${w}%,account_no.ilike.%${w}%,business_name.ilike.%${w}%,phone.ilike.%${w}%`).limit(60);
      if (statuses) qq = qq.in("status", statuses);
      const { data } = await qq;
      if (cleanQ(q.value) !== t) return; // newer typing is already searching
      const starts = (txt, x) => String(txt || "").toLowerCase().split(/[\s\-.,/]+/).some((y) => y.startsWith(x));
      const rank = (c) => (starts(c.first_name, words2[0]) ? 0 : starts(c.last_name, words2[0]) ? 1 : 2);
      const rows = (data || []).filter((c) => words2.every((x) => starts(`${fullName(c)} ${c.business_name || ""}`, x) || String(c.account_no || "").toLowerCase().includes(x) || String(c.phone || "").includes(x)))
        .sort((a, b) => rank(a) - rank(b) || fullName(a).localeCompare(fullName(b))).slice(0, 20);
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

  // ---------- the customer check (one person, one account) ----------
  // A Facebook link (facebook.com, m.facebook.com, fb.com …); only these open as a link.
  const FB_LINK = /^(https?:\/\/)?((www|m|web|mbasic|touch|mobile)\.)?(facebook\.com|fb\.com|fb\.me)\/\S+$/i;
  const fbLinkHtml = (u) => (u && FB_LINK.test(u) ? `<a href="${esc(/^https?:\/\//i.test(u) ? u : "https://" + u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a>` : "");
  // Why a match stops the application (the database says the same when the form is sent).
  const blockReason = (r) => `This person cannot open an account: ${/Facebook link/.test(r.matched_on || "")
    ? `the same Facebook link is on account ${r.account_no || ""} (${String(r.status || "").toUpperCase()})`
    : `account ${r.account_no || ""} with the same ${r.matched_on} was CLOSED`}.`;
  // The accounts that may be the same person: BLOCKED (the same Facebook link, or the same name or Facebook name as a
  // CLOSED account), or only similar (the same name or Facebook name as an open account).
  function personCheckHtml(rows) {
    if (!rows.length) return "";
    const first = rows.find((r) => r.blocked);
    const head = first ? `<div class="addr-msg bad">✖ BLOCKED — ${esc(blockReason(first))}</div>`
      : `<div class="addr-msg warn">⚠ ${rows.length} account(s) with the same name or Facebook name. Check that it is not the same person.</div>`;
    return head + E.grid({ cols: [{ label: "Account No", get: (r) => r.account_no || "" }, { label: "Name", get: fullName }, { label: "Facebook Name", get: (r) => r.facebook_name || "" },
      { label: "Status", html: (r) => pill(r.status) }, { label: "Same", get: (r) => r.matched_on || "" },
      { label: "Check", html: (r) => (r.blocked ? `<b class="bad-txt">BLOCKED</b>` : "Similar") }], rows });
  }

  // ---------- Edit Customer (the main Director, 2.2) ----------
  // Every detail of a customer in one form, saved at once; like an approved correction it keeps no old details, only one line naming the details and who edited them (2.9). Not here:
  // the account number, application number and Public ID (on printed papers and QR codes), the status (its own steps)
  // and the photo (Change Photo). A new opening balance or opening date (the application date) also updates the
  // monthly statements: after Save everything is updated at once.
  function editCustomer(c, reload) {
    if (!S.mainDirector) return toast("Only the main Director can edit a customer's details.", true);
    const v = (x) => esc(x ?? "");
    const day = (x) => String(x || "").slice(0, 10);
    const yes = (on, name, a, b) => `<div class="checks"><label><input type="radio" name="${name}" value="no" ${on ? "" : "checked"}> ${a}</label><label><input type="radio" name="${name}" value="yes" ${on ? "checked" : ""}> ${b}</label></div>`;
    const m = E.modal(`Edit Customer — ${fullName(c)}`, `
      <div class="hint">Change any detail, then press <b>Save</b>. The customer shows the new details at once, and the customer's History shows only that you edited these details (not the old ones).
        Account No <b>${esc(c.account_no || "")}</b>, the application number and the Public ID stay the same.</div>
      <fieldset class="opt"><legend>Personal Details</legend><div class="fields wide">
        <label for="ecFirst">First Name *</label><input type="text" id="ecFirst" value="${v(c.first_name)}" autocomplete="off">
        <label for="ecLast">Last Name *</label><input type="text" id="ecLast" value="${v(c.last_name)}" autocomplete="off">
        <label for="ecPhone">Phone Number</label><input type="tel" id="ecPhone" value="${v(c.phone)}">
        <label for="ecEmail">Email Address</label><input type="email" id="ecEmail" value="${v(c.email)}">
      </div></fieldset>
      <div id="ecCheck" class="person-check" aria-live="polite"></div>
      <fieldset class="opt"><legend>Full Address</legend><div class="fields wide">
        <label for="ecAddr">Address *</label><input type="text" id="ecAddr" value="${v(c.address)}">
        <span>Location *</span><div class="checks loc-checks">${Object.entries(LOCATION).map(([k, l]) => `<label><input type="radio" name="ecLoc" value="${k}" ${locOf(c) === k ? "checked" : ""}> ${esc(l)}</label>`).join("")}</div>
      </div></fieldset>
      <fieldset class="opt"><legend>Account</legend><div class="fields wide">
        <label for="ecDate">Opening Date *</label><input type="date" id="ecDate" value="${day(c.application_date)}" max="${isoToday()}">
        <label for="ecCredit">Credit Limit (₱)</label><input type="number" id="ecCredit" min="0" step="0.01" inputmode="decimal" value="${c.credit_limit ?? ""}" placeholder="None">
        <label for="ecOpen">Opening Balance (₱)</label><input type="number" id="ecOpen" min="0" step="0.01" inputmode="decimal" value="${Number(c.opening_balance) ? c.opening_balance : ""}" placeholder="None">
      </div><small>The first SOA is the month of the opening date. After <b>Save</b>, the account, the SOA and the balance are all updated.</small></fieldset>
      <fieldset class="opt"><legend>Business</legend><div class="fields wide">
        <label for="ecStart">Business Start Date</label><input type="date" id="ecStart" value="${day(c.business_start_date)}">
        <label for="ecBiz">Business Name</label><input type="text" id="ecBiz" value="${v(c.business_name)}">
      </div></fieldset>
      <fieldset class="opt"><legend>Facebook</legend><div class="fields wide">
        <label for="ecFb">Facebook Name</label><input type="text" id="ecFb" value="${v(c.facebook_name)}">
        <label for="ecFbLink">Facebook Account Link</label><input type="url" id="ecFbLink" inputmode="url" autocomplete="off" value="${v(c.facebook_link)}" placeholder="https://www.facebook.com/…">
        <span>Additional Facebook Account?</span>${yes(c.has_extra_facebook, "ecFbx", "No", "Yes")}
        <label for="ecFb2" class="ec-fb2">Additional Facebook Name</label><input type="text" id="ecFb2" class="ec-fb2" value="${v(c.extra_facebook_name)}">
        <span>Facebook Account</span>${yes(c.facebook_verified, "ecFbv", "Not Verified", "Verified")}
      </div></fieldset>`,
      `<button type="button" class="btn" data-x>Cancel</button><button type="button" class="btn primary" data-ok>${ic("check")} Save</button>`, { wide: true, cls: "edit-customer" });
    const el = m.el, val = (id) => $("#" + id, el).value.trim();
    const radio = (name) => $(`input[name=${name}]:checked`, el)?.value;
    const extra = () => { const on = radio("ecFbx") === "yes"; $$(".ec-fb2", el).forEach((x) => (x.hidden = !on)); };
    extra();
    $$("input[name=ecFbx]", el).forEach((r) => (r.onchange = () => { extra(); check(); }));
    // the same person check as a new application (this account itself left out)
    let timer = null, seq = 0;
    const check = async () => {
      const my = ++seq;
      const first = val("ecFirst"), last = val("ecLast"), fb = val("ecFb"), link = val("ecFbLink"), fb2 = radio("ecFbx") === "yes" ? val("ecFb2") : "";
      if (!(first && last) && !fb && !fb2 && !link) return ($("#ecCheck", el).innerHTML = "");
      const { data, error } = await sb.rpc("customer_person_check", { p_first: first, p_last: last, p_fb_name: fb || null, p_fb_extra: fb2 || null, p_fb_link: link || null });
      if (my !== seq || !el.isConnected) return;
      $("#ecCheck", el).innerHTML = personCheckHtml(error ? [] : (data || []).filter((r) => r.id !== c.id));
    };
    ["ecFirst", "ecLast", "ecFb", "ecFb2", "ecFbLink"].forEach((k) => $("#" + k, el).addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(check, 400); }));
    check();
    $("[data-x]", el).onclick = m.close;
    $("[data-ok]", el).onclick = async () => {
      const num = (id) => (val(id) === "" ? null : Number(val(id)));
      const now = {
        first_name: val("ecFirst"), last_name: val("ecLast"), phone: val("ecPhone") || null, email: val("ecEmail") || null,
        address: val("ecAddr"), location_check: radio("ecLoc") || null, application_date: val("ecDate") || null,
        credit_limit: num("ecCredit"), opening_balance: num("ecOpen") ?? 0, business_start_date: val("ecStart") || null,
        business_name: val("ecBiz") || null, facebook_name: val("ecFb") || null, facebook_link: val("ecFbLink") || null,
        has_extra_facebook: radio("ecFbx") === "yes", extra_facebook_name: radio("ecFbx") === "yes" ? val("ecFb2") || null : null,
        facebook_verified: radio("ecFbv") === "yes" };
      if (!now.first_name || !now.last_name) return toast("Enter the first name and the last name.", true);
      if (!now.address) return toast("Enter the address.", true);
      if (!now.location_check) return toast("Choose the location check.", true);
      if (!now.application_date) return toast("Enter the opening date.", true);
      if (now.application_date > isoToday()) return toast("The opening date cannot be after today.", true);
      if ((now.credit_limit ?? 0) < 0 || now.opening_balance < 0 || Number.isNaN(now.credit_limit) || Number.isNaN(now.opening_balance)) return toast("Enter amounts of zero or more.", true);
      if (now.facebook_link && !FB_LINK.test(now.facebook_link)) return toast("Enter the Facebook account link, for example https://www.facebook.com/name — or leave it empty.", true);
      // only what changed is sent
      const same = (k) => {
        const a = c[k], b = now[k];
        if (["credit_limit", "opening_balance"].includes(k)) return (a == null || a === "" ? null : Number(a)) === (b == null ? null : Number(b)) || (k === "opening_balance" && !Number(a) && !Number(b));
        if (["application_date", "business_start_date"].includes(k)) return String(a || "").slice(0, 10) === String(b || "");
        if (typeof b === "boolean") return !!a === b;
        if (k === "location_check") return locOf(c) === b;
        return String(a ?? "") === String(b ?? "");
      };
      const changes = Object.fromEntries(Object.keys(now).filter((k) => !same(k)).map((k) => [k, now[k]]));
      if (!Object.keys(changes).length) return toast("Nothing was changed.", true);
      const btn = $("[data-ok]", el); btn.disabled = true;
      const { data, error } = await sb.rpc("director_edit_customer", { p_id: c.id, p_changes: changes });
      btn.disabled = false;
      if (error) return fail(error, "Could not save");
      m.close();
      const n = (data?.changed || []).length, st = data?.statements || 0;
      toast(`✔ Saved — all updated: ${n} detail${n === 1 ? "" : "s"} changed${st ? `, ${st} SOA${st === 1 ? "" : "s"} updated` : ""}.`);
      if (reload) reload();
    };
  }

  // ---------- print helpers ----------
  function printHead(title, rightHtml = "") {
    return `<div class="ph">
      <div class="ph-left">${E.logoHtml("ph-logo")}<div><div class="ph-co">${esc(C.company.name)}</div>
        <div class="ph-addr">${esc(C.company.address.join(", "))}<br>${esc(C.company.email)}${E.siteText()}</div></div></div>
      <div class="ph-right">${rightHtml}</div></div>
      <div class="ph-title">${esc(title)}</div>`;
  }
  const val = (v) => (v === "" || v == null ? "&nbsp;" : esc(v)); // an empty value keeps its line on paper
  const cell = (label, value, cls = "") => `<div class="pcell ${cls}"><div class="pl">${esc(label)}</div><div class="pv">${val(value)}</div></div>`;
  const box = (title, inner) => `<div class="pbox"><div class="pbox-h">${esc(title)}</div>${inner}</div>`;

  // Two signature lines. sign (approvedBy): the Director approved the document, so the Director's signature picture stands
  // on the right line, with the name and the date under it.
  const sigCol = (label, sign) => sign
    ? `<div class="sig-on">${sign.pic ? `<img class="esig" src="${esc(sign.pic)}" alt="Signature">` : ""}<div class="line"></div>${label}${sign.name ? `: <b class="nw">${esc(sign.name)}</b>` : ""}${sign.at ? ` &nbsp;·&nbsp; <span class="nw">${esc(mdy(sign.at))}</span>` : ""}</div>`
    : `<div><div class="line"></div>${label}</div>`;
  const sigs = (left, right, sign = null) => `<div class="psig">${sigCol(left)}${sigCol(right, sign)}</div>`;
  // 3.17 certificate style: a top row (left · centre number · right), a thin section title and "Label : value" lines
  const cxTop = (items) => `<div class="cx-top">${items.map(([k, v]) => `<div><small>${esc(k)}</small><b>${val(v)}</b></div>`).join("")}</div>`;
  const cxSec = (title, note = "") => `<div class="cx-sec">${esc(title)}${note ? `<small>${esc(note)}</small>` : ""}</div>`;
  const cxKv = (pairs) => `<div class="cx-kv">${pairs.map(([k, v, cls = ""]) => `<div class="cx-r ${cls}"><span>${esc(k)}</span><i>:</i><b>${val(v)}</b></div>`).join("")}</div>`;

  // ======================================================================
  // Dashboard
  // ======================================================================
  V.dashboard = async () => {
    const H = E.hasModule;
    const quick = [
      [E.canWrite("customers"), "#newcustomer", "New Customer", "user", "blue"],
      [E.canWrite("invoices"), "#newinvoice", "Record Invoice", "doc", "indigo"],
      [E.canWrite("payments") || E.canWrite("invoices"), "#newpayment", "Record Payment", "wallet", "green"],
      [E.canWrite("creditmemos"), "#newcreditmemo", "Credit Memo", "tag", "orange"],
      [E.canWrite("billing"), "#newvoucher", "Payment Voucher", "receipt", "teal"],
      [isStaff(), "#newpurchase", "Purchase Order", "order", "pink"],
      [true, "#verify", "Verify a Record", "shield", "gray"]
    ].filter((q) => q[0]);
    const today = `${new Date().toLocaleDateString("en-US", { weekday: "long" })}, ${mdy(isoToday())}`;
    // 2.7: a greeting by the time of day (Manila time, as every date in the portal)
    const hr = new Date().getHours(), greet = hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";
    const first = String(myName() || "").trim().split(/\s+/)[0] || "";
    const tileIc = ["users", "order", "wallet", "check"];
    E.shell("dashboard", "Dashboard", `
      <section class="hero home-hero">${E.logoHtml("hero-logo")}<div>
        <p class="hero-date">${esc(today)}</p>
        <h2>${esc(greet)}${first ? `, ${esc(first.charAt(0) + first.slice(1).toLowerCase())}` : ""}</h2>
        <p class="welcome">Welcome to the ${esc(C.company.name)} <span class="hero-tag">E-PORTAL</span> · <b>${esc(E.personTitle(S.profile.role, S.position))}</b></p></div></section>
      ${isAdmin() ? `<div class="todo" id="dTodo"></div>` : ""}
      ${H("customers") ? `<div class="tiles" id="dTiles">${["Active Customers", "Applications to Review", "Balance Due (₱)", "Payments This Month (₱)"].map((k, i) => `<div class="tile"><span class="tile-ic">${ic(tileIc[i])}</span><div class="k">${k}</div><div class="v"><span class="spin sm"></span></div></div>`).join("")}</div>` : ""}
      <h3 class="home-h">Quick Actions</h3>
      <div class="quick">${quick.map((q) => `<a class="qa qa-${q[4]}" href="${q[1]}"><span class="qa-ic">${ic(q[3])}</span><span class="qa-l">${esc(q[2])}</span></a>`).join("")}</div>
      <div class="cols">
        ${H("customers") ? `<div class="box"><h3>Applications Waiting for Review</h3><div class="in" id="dApps">${busy()}</div></div>` : ""}
        ${isStaff() ? `<div class="box"><h3>Purchase Orders <a href="#purchase" class="box-link">Open</a></h3><div class="in" id="dComm">${busy()}</div></div>` : ""}
      </div>
      ${H("invoices") || H("payments") ? `<div class="cols" style="margin-top:10px">
        ${H("invoices") ? `<div class="box"><h3>Invoices <a href="#invoices" class="box-link">Open</a></h3><div class="in">
          <div id="dInv">${busy()}</div></div></div>` : ""}
        ${H("payments") ? `<div class="box"><h3>Recent Payments</h3><div class="in" id="dPay">${busy()}</div></div>` : ""}
      </div>` : ""}`);
    const ym = isoToday().slice(0, 7);
    let soaDone = false; try { soaDone = sessionStorage.getItem("eoSoa") === ym; } catch (_) {}
    if (!soaDone) sb.rpc("generate_statements", {}).then(({ error }) => { if (!error) { try { sessionStorage.setItem("eoSoa", ym); } catch (_) {} } }, () => {});
    loadCommunityBox();
    if (isAdmin()) loadTodo();
    if (!H("customers") && !H("invoices") && !H("payments")) { E.setRecords("Welcome"); return; }
    const nextMonth = (m) => { const [y, n] = m.split("-").map(Number); return n === 12 ? `${y + 1}-01-01` : `${y}-${String(n + 1).padStart(2, "0")}-01`; };
    // 2.5: only what the dashboard shows is loaded (the 8 newest invoices and payments, this month's payment amounts)
    // 3.0: the customers waiting (a short list) and the number of active customers are asked for: not 1000 rows
    const [cust, bal, inv, pay, month, activeN] = await Promise.all([
      sb.from("customers").select("id,first_name,last_name,account_no,application_no,status,application_date,business_name").in("status", ["pending", "verified"]).order("created_at", { ascending: false }).limit(50),
      sb.from("customer_balances").select("balance_due"),
      sb.from("invoice_balances").select("id,invoice_no,first_name,last_name,balance,pay_status").order("invoice_date", { ascending: false }).order("invoice_no", { ascending: false }).limit(8),
      sb.from("payments_received").select("id,receipt_no,amount,paid_date,customers(first_name,last_name)").order("created_at", { ascending: false }).limit(8),
      sb.from("payments_received").select("amount").gte("paid_date", ym + "-01").lt("paid_date", nextMonth(ym)),
      sb.from("customers").select("id", { count: "exact", head: true }).eq("status", "active")
    ]);
    if (cust.error) {
      $("#main").insertAdjacentHTML("afterbegin", `<div class="hint err">The customer database is not set up yet. Ask the Director to run the setup script <b>002_customers_invoices_payments.sql</b>.</div>`);
      return;
    }
    const cs = cust.data || [];
    const due = (bal.data || []).reduce((s, b) => s + Math.max(0, num(b.balance_due)), 0);
    const pays = pay.data || [];
    const monthPaid = (month.data || []).reduce((s, p) => s + num(p.amount), 0);
    const waiting = cs.filter((c) => ["pending", "verified"].includes(c.status));
    const tiles = [["ok", activeN.count || 0], ["warn", waiting.length], ["", "₱ " + peso(due)], ["ok", "₱ " + peso(monthPaid)]];
    $$("#dTiles .tile").forEach((t, i) => { t.className = "tile " + tiles[i][0]; $(".v", t).textContent = tiles[i][1]; });
    if ($("#dApps")) {
      $("#dApps").innerHTML = E.grid({ cols: [
        { label: "Application", get: (r) => r.application_no },
        { label: "Name", get: fullName }, { label: "Date", get: (r) => mdy(r.application_date) }, { label: "Status", html: (r) => pill(r.status) }],
        rows: waiting.slice(0, 8), onRow: true, empty: "No applications waiting." });
      E.bindGrid($("#dApps"), waiting.slice(0, 8), (r) => (location.hash = "customer/" + r.id));
    }
    if ($("#dInv")) {
      // 2.4.3: the newest invoices with their status (PAID / PARTIAL PAYMENT / UNPAID); three columns, so the status
      // shows on a phone too: the invoice (with the customer under it), what is still due, and the status
      const rows = inv.data || [];
      $("#dInv").innerHTML = E.grid({ cols: [
        { label: "Invoice / Customer", html: (r) => `<b>${esc(r.invoice_no)}</b><br><small>${esc(fullName(r))}</small>` },
        { label: "Balance (₱)", num: true, get: (r) => peso(r.balance) },
        { label: "Status", html: payPill }],
        rows, onRow: true, empty: "No invoices yet." });
      E.bindGrid($("#dInv"), rows, (r) => (location.hash = "invoice/" + r.id));
    }
    if ($("#dPay")) {
      const rp = pays;
      $("#dPay").innerHTML = E.grid({ cols: [
        { label: "Receipt", get: (r) => r.receipt_no }, { label: "Customer", get: (r) => fullName(r.customers || {}) },
        { label: "Amount (₱)", num: true, get: (r) => peso(r.amount) }, { label: "Date", get: (r) => mdy(r.paid_date) }],
        rows: rp, onRow: true, empty: "No payments yet." });
      E.bindGrid($("#dPay"), rp, (r) => (location.hash = "payment/" + r.id));
    }
    E.setRecords(`Customers: ${activeN.count || 0}`);
  };
  // 3.0: Purchase Orders on the dashboard: the ones waiting for review, then this month's approved lots with their
  // quantity and average price.
  async function loadCommunityBox() {
    const el0 = $("#dComm"); if (!el0) return;
    const { data, error } = await sb.from("purchase_orders").select("id, po_no, lot_name, status, total_qty, total_amount, po_date, pending_update").order("created_at", { ascending: false }).limit(300);
    const el = $("#dComm"); if (!el) return;
    if (error) { el.innerHTML = `<div class="empty small">Purchase Orders need the database update 023_purchase_orders.sql.</div>`; return; }
    const rows = data || [], m = isoToday().slice(0, 7);
    const wait = rows.filter((p) => ["pending", "negotiation"].includes(p.status) || p.pending_update);
    const appr = rows.filter((p) => p.status === "approved" && String(p.po_date).slice(0, 7) === m);
    const q = appr.reduce((s, p) => s + num(p.total_qty), 0), a = appr.reduce((s, p) => s + num(p.total_amount), 0);
    const line = (p) => `<a class="po-rv" href="#po/${p.id}"><b>${esc(p.po_no)}</b><span>${esc(p.lot_name)} · ${Number(p.total_qty).toLocaleString("en-PH")} pcs · avg BDT ${peso(num(p.total_qty) ? num(p.total_amount) / num(p.total_qty) : 0)}</span>${pill(p.status === "approved" ? "approved" : "pending", p.status === "negotiation" ? "NEGOTIATION" : p.pending_update ? "UPDATE" : p.status.toUpperCase())}</a>`;
    el.innerHTML = `${wait.length ? `<div class="po-dh">${isAdmin() ? "Waiting for your review" : "Purchase order requests"} (${wait.length})</div>${wait.slice(0, 4).map(line).join("")}` : ""}
      <div class="po-dh">Approved this month · ${appr.length} lot${appr.length === 1 ? "" : "s"} · ${q.toLocaleString("en-PH")} pcs · average BDT ${peso(q ? a / q : 0)}</div>
      ${appr.length ? appr.slice(0, 5).map(line).join("") : `<div class="empty small">No approved purchase orders this month. <a href="#newpurchase">New Purchase Order</a></div>`}`;
  }
  // Admin to-do: everything waiting for a decision.
  async function loadTodo() {
    const cnt = (q) => q.then((r) => (r.error ? 0 : r.count || 0), () => 0);
    const head = { count: "exact", head: true };
    const [apps, jobs, changes, memos, contacts, copies, pos] = await Promise.all([
      cnt(sb.from("customers").select("id", head).in("status", ["pending", "verified"])),
      cnt(sb.from("job_applications").select("id", head).eq("status", "submitted")),
      cnt(sb.from("change_requests").select("id", head).eq("status", "pending")),
      cnt(sb.from("credit_memos").select("id", head).eq("status", "pending")),
      cnt(sb.from("contact_messages").select("id", head).eq("status", "new")),
      sb.from("attachments").select("owner_type, owner_id").eq("pending", true).order("created_at").limit(50).then((r) => r.data || [], () => []),
      cnt(sb.from("purchase_orders").select("id", head).eq("status", "pending"))
    ]);
    const el = $("#dTodo"); if (!el) return;
    const items = [[apps, "Customer applications", "#customers"], [jobs, "Job applications", "#jobapps"], [changes, "Corrections", "#changes"], [memos, "Credit memos", "#creditmemos"], [contacts, "Contact messages", "#contacts"], [pos, "Purchase orders", "#purchase"]];
    if (copies.length) items.push([copies.length, "Paper copy updates", `#${copies[0].owner_type}/${copies[0].owner_id}`]);
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
      const rows = (data || []).filter((c) => ws.every((x) => `${fullName(c)} ${c.account_no || ""} ${c.business_name || ""} ${c.phone || ""} ${c.public_id}`.toLowerCase().includes(x)))
        .map((c) => ({ ...c, due: num(bm.get(c.id)?.balance_due) }));
      // 2.9: names that start with what was typed come first (first name, then last name)
      if (ws.length) { const st0 = (v) => String(v || "").toLowerCase().startsWith(ws[0]); const rk = (c) => (st0(c.first_name) ? 0 : st0(c.last_name) ? 1 : 2); rows.sort((a, b) => rk(a) - rk(b)); }
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
          <div id="ncCheck" class="person-check" aria-live="polite"></div>
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
            <label for="ncFbLink">Facebook Account Link</label><input type="url" id="ncFbLink" inputmode="url" autocomplete="off" placeholder="https://www.facebook.com/…">
            <span>Additional Facebook Account?</span><div class="checks"><label><input type="radio" name="ncFbx" value="no" checked> No</label><label><input type="radio" name="ncFbx" value="yes"> Yes</label></div>
            <label for="ncFb2" class="fb2" hidden>Additional Facebook Name</label><input type="text" id="ncFb2" class="fb2" hidden>
            <span>Facebook Account</span><div class="checks"><label><input type="radio" name="ncFbv" value="no" checked> Not Verified</label><label><input type="radio" name="ncFbv" value="yes"> Verified</label></div>
          </div><small>Facebook Account Link is optional: copy the link of the customer's Facebook profile. One person can have only one account: a person whose account was CLOSED, or whose Facebook link is already on another account, cannot open an account.</small></fieldset>
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
      $("#ncAcctNo").textContent = $("#ncFirst").value.trim() || $("#ncLast").value.trim() ? `${data.account_no} (given when approved)` : "Type the name to see it";
    };
    ["ncFirst", "ncLast"].forEach((k) => ($("#" + k).oninput = () => { clearTimeout(pvTimer); pvTimer = setTimeout(preview, 300); }));
    preview();
    // The customer check while the name and Facebook are typed: the same person cannot open a second account.
    let ckTimer = null, ckSeq = 0, blockedWhy = "";
    const personCheck = async () => {
      const my = ++ckSeq;
      const first = $("#ncFirst")?.value.trim() || "", last = $("#ncLast")?.value.trim() || "", fb = $("#ncFb")?.value.trim() || "", link = $("#ncFbLink")?.value.trim() || "";
      const fb2 = $("input[name=ncFbx]:checked")?.value === "yes" ? $("#ncFb2").value.trim() : "";
      if (!(first && last) && !fb && !fb2 && !link) { blockedWhy = ""; if ($("#ncCheck")) $("#ncCheck").innerHTML = ""; return; }
      const { data, error } = await sb.rpc("customer_person_check", { p_first: first, p_last: last, p_fb_name: fb || null, p_fb_extra: fb2 || null, p_fb_link: link || null });
      if (my !== ckSeq || !$("#ncCheck")) return;
      const rows = error ? [] : data || []; // a failed check is made again by the database when the form is sent
      blockedWhy = rows.find((r) => r.blocked) ? blockReason(rows.find((r) => r.blocked)) : "";
      $("#ncCheck").innerHTML = personCheckHtml(rows);
    };
    ["ncFirst", "ncLast", "ncFb", "ncFb2", "ncFbLink"].forEach((k) => $("#" + k).addEventListener("input", () => { clearTimeout(ckTimer); ckTimer = setTimeout(personCheck, 400); }));
    $$("input[name=ncFbx]").forEach((r) => r.addEventListener("change", () => { clearTimeout(ckTimer); ckTimer = setTimeout(personCheck, 100); }));
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
      if (v("ncFbLink") && !FB_LINK.test(v("ncFbLink"))) return toast("Enter the Facebook account link, for example https://www.facebook.com/name — or leave it empty.", true);
      if (blockedWhy) return toast(blockedWhy, true);
      if (num(v("ncCredit")) < 0 || num(v("ncOpen")) < 0) return toast("The credit limit and opening balance cannot be negative.", true);
      const extra = $("input[name=ncFbx]:checked").value === "yes";
      if (extra && !v("ncFb2")) return toast("Enter the additional Facebook name, or choose No.", true);
      E.setBusy(e.target, true, "Submitting");
      const id = uuid();
      let photo_path = null;
      const photo = await E.slimFile($("#ncPhoto").files[0], "photo");
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
        facebook_name: v("ncFb") || null, facebook_link: v("ncFbLink") || null, has_extra_facebook: extra, extra_facebook_name: extra ? v("ncFb2") : null,
        facebook_verified: $("input[name=ncFbv]:checked").value === "yes", phone: v("ncPhone"), email: v("ncEmail") || null
      }).select().single();
      if (error) { E.setBusy(e.target, false); return fail(error, "Could not submit the application"); }
      if (photo_path) await sb.from("attachments").insert({ owner_type: "customer", owner_id: c.id, kind: "photo", storage_path: photo_path, file_name: `${c.account_no || c.application_no} Profile Photo`, mime: photo.type, size: photo.size });
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
  const locSelect = (c, id) => `<label class="loc-pick" for="${id}">Location <select id="${id}">${Object.entries(LOCATION).map(([k, l]) => `<option value="${k}" ${k === locOf(c) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
  function applicationPage(c, photoUrl, reqs, sign = null) {
    const qr = E.qrDataUrl(custQr(c));
    const bar = E.pdf417DataUrl(c.application_no);
    // 3.2: no photo box; the customer's QR code with the public key stands in that place (left of the customer details)
    return `${printHead("CUSTOMER ACCOUNT APPLICATION", `<img src="${bar}" alt="Application number barcode" class="ph-bar"><div class="mono">${esc(c.application_no)}</div>`)}
      <div class="prow3">${cell("Application No", c.application_no)}${cell("Account No", c.account_no)}${cell("Application Date", mdy(c.application_date))}</div>
      ${box("Customer Information", `<div class="pgrid">
        <div class="pphoto pqr"><img src="${qr}" alt="Customer QR code"><div class="mono key">${esc(c.public_id)}</div></div>
        <div class="pgrid2">${cell("First Name", c.first_name)}${cell("Last Name", c.last_name)}
          ${cell("Phone Number", c.phone)}${cell("Email Address", c.email)}
          ${cell("Delivery Address", c.address, "span2")}</div></div>`)}
      ${box("Requirements Submitted", `<div class="pv preq">${reqs.length ? reqs.map((r) => `<div><span class="ok-mark">✔</span> ${esc(r.file_name)}</div>`).join("") : "None uploaded yet"}</div>`)}
      ${box("For Office Use", `<div class="pgrid2">${cell("Issued By", c.issued_by_name)}${cell("Status", c.status.toUpperCase())}
        ${cell("Credit Limit (PHP)", c.credit_limit != null ? peso(c.credit_limit) : "")}
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
    const pages = [applicationPage(c, null, att.filter((a) => a.kind === "requirement"), ok ? approvedBy(ok.id, ok.name, ok.at) : null)];
    // an approved account: page 2 is the Record Validation (verified / approved by, E-Portal record date, paper copy)
    if (ok) pages.push(await validationPage(c, att));
    E.openPreview(`Application ${c.application_no}`, pages);
  }

  // 2.6.5 Record Validation (A4, page 2 of an approved account's application print): the account's log validation like the old paper form — verified by / date,
  // approved by / date — with the date it was recorded in the E-Portal, the paper form on file, and a QR to check it.
  async function validationPage(c, att) {
    const ev = await sb.from("customer_events").select("action, actor, actor_name, created_at").eq("customer_id", c.id).in("action", ["verify", "approve"]).order("created_at", { ascending: false });
    const last = (a) => (ev.data || []).find((x) => x.action === a);
    const ver = last("verify"), apr = last("approve"), ok = isApprovedAccount(c);
    const paper = att.filter((a) => a.kind === "signed_form" || a.kind === "application").sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    const when = new Date(), vno = "V" + when.toISOString().replace(/\D/g, "").slice(2, 14), at = E.dateTime(when.toISOString());
    const row = (k, v) => `<tr><th>${esc(k)}</th><td${k === "Public ID" ? ' class="key"' : ""}>${esc(v || "—")}</td></tr>`;
    const complete = ok && !!paper;
    return `<div class="vp">${printHead("RECORD VALIDATION")}
      <div class="vp-true${complete ? "" : " part"}"><span class="vp-seal">${complete ? "✔" : "!"}</span><div><b>${complete ? "RECORD COMPLETE" : ok ? "PAPER FORM NOT ON FILE" : "NOT YET APPROVED"}</b>
        <small>${esc(fullName(c))} · ${esc(c.account_no || c.application_no)}</small><small>Recorded in the ${esc(E.APP)} on ${esc(mdy(c.created_at))}</small></div></div>
      ${box("Customer Record", `<table class="vp-fields"><tbody>${row("Account Name", fullName(c))}${row("Account No", c.account_no)}${row("Application No", c.application_no)}
        ${c.business_name ? row("Business Name", c.business_name) : ""}${row(ok ? "Opening Date" : "Application Date", mdy(c.application_date))}${row("E-Portal Record Date", mdy(c.created_at))}
        ${row("Account Status", String(c.status).toUpperCase())}${row("Public ID", c.public_id)}${row("Paper Application Form", paper ? `On file · scanned ${mdy(paper.created_at)}` : "Not on file")}</tbody></table>`)}
      ${box("Log Validation", `<table class="vp-fields"><tbody>${row("Verified By", ver?.actor_name || (ok && !ver ? "Approved directly by the Director" : ""))}${row("Date of Verification", ver ? mdy(ver.created_at) : "")}
        ${row("Approved By", ok ? apr?.actor_name || "" : "")}${row("Approval Date", ok ? mdy(apr?.created_at || c.reviewed_at) : "")}</tbody></table>`)}
      ${box("E-Portal Validation", `<div class="vp-valid"><table class="vp-fields"><tbody>${row("Validation No", vno)}${row("Validated On", at)}${row("Validated By", S.profile?.full_name || "")}</tbody></table>
        <div class="vp-qr"><img src="${E.qrDataUrl(`${location.origin}${location.pathname}#verify/${encodeURIComponent(c.public_id || c.account_no || "")}`)}" alt="Verification QR code"><small>Scan to verify online</small></div></div>`)}
      ${sigs("Verified by (Signature) &nbsp; / &nbsp; Date", ok ? "Approved by" : "Approved by (Signature) &nbsp; / &nbsp; Date", ok ? approvedBy(apr?.actor || c.reviewed_by, apr?.actor_name || "", apr?.created_at || c.reviewed_at) : null)}
      <div class="vp-sys">This record is kept in the ${esc(E.APP)}. Scan the QR code to check it.</div></div>`;
  }

  // Suspended / closed accounts are marked for everyone who opens them.
  function statusBanner(c) {
    if (c.status === "closed") return `<div class="banner closed">${ic("x")} CLOSED ACCOUNT — new invoices cannot be recorded; payments can still be recorded. ${c.status_note ? " " + esc(c.status_note) : ""}</div>`;
    if (c.status === "suspended") return `<div class="banner warn">⚠ SUSPENDED ACCOUNT — new invoices are blocked while the account is suspended; payments can still be recorded.${c.status_note ? " " + esc(c.status_note) : ""}</div>`;
    if (c.status === "rejected") return `<div class="banner closed">REJECTED APPLICATION${c.status_note ? " — " + esc(c.status_note) : ""}</div>`;
    return "";
  }
  // Record numbers and codes in a typewriter font; names, dates and amounts in the normal font.
  const idBox = (label, value) => `<div class="idbox"><small>${esc(label)}</small><b class="${/^[A-Z0-9][A-Z0-9-]*\d[A-Z0-9-]*$/i.test(String(value || "")) ? "mono" : ""}">${esc(value || "—")}</b></div>`;
  const fieldLabel = (table, k) => (E.fieldLabel ? E.fieldLabel(table, k) : k.replace(/_/g, " "));
  const showVal = (v) => E.showVal(v);
  const changeText = (r) => Object.keys(r.changes || r.previous || {}).map((k) => `${fieldLabel(r.target_table, k)}: ${showVal(r.previous?.[k])} → ${showVal(r.changes?.[k])}`).join("; ");

  V.customer = async (id, extra) => {
    E.shell("customer", "Customer Profile", busy());
    // 3.0: the customer and everything on the page are asked for at the same time (all need only the id)
    const [c, att, bal, invs, pays, memos, ev, secret, ords, chg] = await Promise.all([
      getCustomer(id),
      attachmentsOf("customer", id),
      sb.from("customer_balances").select("*").eq("customer_id", id).maybeSingle(),
      sb.from("invoice_balances").select("*").eq("customer_id", id).order("invoice_date", { ascending: false }),
      sb.from("payments_received").select("*").eq("customer_id", id).order("paid_date", { ascending: false }),
      sb.from("credit_memos").select("*").eq("customer_id", id).order("memo_date", { ascending: false }),
      sb.from("customer_events").select("*").eq("customer_id", id).order("created_at"),
      isAdmin() ? sb.from("customer_secrets").select("private_code").eq("customer_id", id).maybeSingle() : Promise.resolve({ data: null }),
      sb.from("order_letters").select("*").eq("customer_id", id).order("created_at", { ascending: false }),
      sb.from("record_changes").select("*").eq("target_table", "customers").eq("target_id", id).order("created_at")
    ]);
    if (!c) { $("#main").innerHTML = `<div class="empty">Customer not found. <a href="#customers">Back to Customers</a></div>`; return; }
    if (extra === "submitted") return renderSubmitted(c);
    const b = bal.data || { total_invoiced: 0, total_paid: 0, total_credits: 0, balance_due: 0, total_charges: 0, total_settlement: 0 };
    const photoUrl = c.photo_path ? await signedUrl(c.photo_path) : "";
    const signed = att.filter((a) => a.kind === "signed_form" || a.kind === "application");
    const orders = ords.data || [];
    const canInvoice = c.status === "active" && E.canWrite("invoices");
    const canPay = ["active", "suspended", "closed"].includes(c.status) && (E.canWrite("payments") || E.canWrite("invoices"));
    const canMemo = ["active", "suspended"].includes(c.status) && E.canWrite("creditmemos");
    const history = [
      ...(ev.data || []).map((r) => ({ src: "event", id: r.id, at: r.created_at, action: E.gateEventLabel?.(r) || r.action.toUpperCase(), by: r.actor_name || "", note: r.note || "" })),
      ...(chg.data || []).map((r) => ({ src: "change", id: r.id, ...(r.action === "correction" ? { at: r.created_at, action: `CORRECTION${r.request_no ? " (" + r.request_no + ")" : ""}`, by: r.actor_name || "", note: changeText(r) }
        : r.action === "edited" || r.action === "correction approved" ? { at: r.created_at, action: r.action === "edited" ? "EDITED BY DIRECTOR" : `CORRECTION APPROVED BY DIRECTOR${r.request_no ? " (" + r.request_no + ")" : ""}`,
          by: r.actor_name || "", note: `${Object.keys(r.changes || {}).map((k) => fieldLabel("customers", k)).join(", ")}${r.requested_by_name ? ` · asked by ${r.requested_by_name}` : ""}` }
        : { at: r.created_at, action: r.action.toUpperCase(), by: r.actor_name || "", note: r.action === "file removed" ? r.previous?.file || "" : changeText(r) }) }))
    ].sort((x, y) => String(x.at).localeCompare(String(y.at)));
    const overdue = (invs.data || []).filter(isOverdue).sort((x, y) => String(x.due_date).localeCompare(String(y.due_date)));
    const rets = [], cms = [];
    for (const m of memos.data || []) (m.is_return ? rets : cms).push(m);
    const tabs = ["Details", "Statement of Account", `Invoices (${(invs.data || []).length})`, `Payments (${(pays.data || []).length})`, `Credit Memos (${cms.length})`, `Documents (${att.length})`, "History", `Overdue (${overdue.length})`, `Returns (${rets.length})`, `Gate Pass (${E.gateHistoryRows ? E.gateHistoryRows(orders, ev.data || []).length : 0})`];
    $(".band h1").textContent = `Customer — ${fullName(c)}`;
    $("#main").innerHTML = `
      ${statusBanner(c)}
      <section class="cust-hero st-${esc(c.status)}">
        <div class="ch-pic"><div class="ch-photo">${photoUrl ? `<img src="${esc(photoUrl)}" alt="Photo of ${esc(fullName(c))}">` : `<span>${esc(((c.first_name || "")[0] || "") + ((c.last_name || "")[0] || ""))}</span>`}</div>
          ${E.canWrite("customers") ? `<div class="ch-pic-tools"><label class="linkbtn" for="pfPhotoFile">${c.photo_path ? "Change" : "Add Photo"}</label><input type="file" id="pfPhotoFile" accept="image/*" hidden>${c.photo_path ? `<button type="button" class="linkbtn del" id="pfPhotoDel">Remove</button>` : ""}</div>` : ""}</div>
        <div class="ch-main">
          <div class="ch-name"><h2>${esc(fullName(c))}</h2>${pill(c.status)}${isApprovedAccount(c) && isStaff() ? `<span id="pfStanding"></span>` : ""}</div>
          <div class="ch-sub">${[c.business_name, c.phone, c.email].filter(Boolean).map(esc).join(" · ") || "—"}</div>
          <div class="ch-ids">
            ${idBox("Account No", c.account_no)}${idBox("Application No", c.application_no)}${idBox("Opened", mdy(c.application_date))}${c.credit_limit != null ? idBox("Credit Limit", "₱ " + peso(c.credit_limit)) : ""}
            ${isAdmin() ? `<div class="idbox"><small>Private ID</small><b class="mono" id="pvCode" data-code="${esc(secret.data?.private_code || "")}">••••••••</b> <button type="button" class="linkbtn" id="pvShow">Show</button></div>` : ""}
          </div>
        </div>
        <div class="ch-qr"><canvas id="pfQr" aria-label="Customer QR code"></canvas><small>Public ID</small><b class="mono key" id="pfKey">${esc(c.public_id || "")}</b><button type="button" class="linkbtn" id="pfCopy">${ic("copy")} Copy</button></div>
      </section>
      <div class="due-card ${num(b.balance_due) > 0 ? "warn" : num(b.balance_due) < 0 ? "credit" : "ok"}"><div><div class="k">Balance Due</div><div class="v">₱ ${peso(b.balance_due)}</div></div>
        <small>${num(b.balance_due) > 0 ? "Amount the customer still owes" : num(b.balance_due) < 0 ? `Overpaid · ₱ ${peso(-num(b.balance_due))} is ready for the customer's next invoice (it is used by itself)` : "Nothing due · fully paid"} · see Details for the full summary</small></div>
      <div class="actionbar">
        ${canInvoice ? `<a class="btn primary" href="#newinvoice/${c.id}">${ic("plus")} Record Invoice</a>` : ""}
        ${canPay ? `<a class="btn" href="#newpayment/${c.id}">${ic("plus")} Record Payment</a>` : ""}
        ${canMemo ? `<a class="btn" href="#newcreditmemo/${c.id}">${ic("plus")} Credit Memo</a>` : ""}
        ${isApprovedAccount(c) && isStaff() ? `<button type="button" class="btn" id="pfRequest">${ic("stamp")} Request</button>` : ""}
        <span class="grow"></span>
        ${tools("customers", c, `${c.account_no || c.application_no} ${fullName(c)}`, { reload: () => V.customer(c.id), afterDelete: () => (location.hash = "customers"), noFix: isApprovedAccount(c) && isStaff() && !S.mainDirector })}
      </div>
      ${isApprovedAccount(c) && isStaff() ? E.requestsHtml(c, orders) : ""}
      <div class="docgrid">${docCard({ key: "app", title: "Customer Application Form", tag: "System Generated", sub: `${c.application_no} · made by the E-Portal · print it for the customer to sign`, ownerType: "customer", ownerId: c.id, att, kind: "__system", canUpload: false, print: () => printApplication(c),
        approved: isApprovedAccount(c) ? (() => { const a = [...(ev.data || [])].reverse().find((x) => x.action === "approve"); return { name: a?.actor_name || "", at: a?.created_at || c.reviewed_at }; })() : null })}
        ${signed.length ? "" : copyCard({ key: "appcopy", title: "Customer Application Form", tag: "Signed Paper Copy", sub: "Scan or upload the form signed by the customer", ownerType: "customer", ownerId: c.id, att, kind: "signed_form", kinds: ["signed_form", "application"], canUpload: isStaff() && c.status !== "closed" })}</div>
      ${isAdmin() && ["pending", "verified"].includes(c.status) ? reviewPanel(c, signed) : ""}
      <div class="tabs" id="pfTabs">${tabs.map((t, i) => `<button type="button" class="${i ? "" : "on"}" data-t="${i}">${esc(t)}</button>`).join("")}</div>
      <div class="tabpanes">
        <div data-p="0">${detailsTable(c, b)}${rhBox("customers", c.id)}</div>
        <div data-p="1" hidden id="pfSoa">${busy("Loading statements")}</div>
        <div data-p="2" hidden>${E.grid({ cols: INV_COLS.filter((x) => x.label !== "Customer" && x.label !== "Account No"), rows: invs.data || [], onRow: true, empty: "No invoices yet." })}</div>
        <div data-p="3" hidden><div id="pfFree"></div>${E.grid({ cols: PAY_COLS.filter((x) => x.label !== "Customer" && x.label !== "Account No"), rows: pays.data || [], onRow: true, empty: "No payments yet." })}</div>
        <div data-p="4" hidden>${cms.length ? `<div class="btnrow"><button type="button" class="btn small" data-hprint="cm">${ic("print")} Print</button></div>` : ""}${E.grid({ cols: CM_HIST, rows: cms, onRow: true, empty: "No credit memos." })}</div>
        <div data-p="5" hidden>${filesHtml(att.map((a) => a.kind === "signed_form" ? { ...a, kind: "application" } : a), "No documents yet.")}${isStaff() && c.status !== "closed" ? `<div class="fields wide" style="margin-top:8px">${fileField("pfAdd", "Add Requirement", "multiple data-save-now")}</div>` : ""}</div>
        <div data-p="7" hidden>${overdue.length ? `<div class="btnrow"><button type="button" class="btn small" data-hprint="od">${ic("print")} Print</button></div>` : ""}${E.grid({ cols: OD_HIST, rows: overdue, onRow: true, empty: "No overdue invoice." })}</div>
        <div data-p="8" hidden>${rets.length ? `<div class="btnrow"><button type="button" class="btn small" data-hprint="rt">${ic("print")} Print</button></div>` : ""}${E.grid({ cols: RET_HIST, rows: rets, onRow: true, empty: "No returns." })}</div>
        <div data-p="9" hidden>${E.gateHistoryHtml ? E.gateHistoryHtml(orders, ev.data || []) : ""}</div>
        <div data-p="6" hidden>${E.grid({ cols: [{ label: "Date / Time", get: (r) => stamp(new Date(r.at)) }, { label: "Action", get: (r) => r.action }, { label: "By", get: (r) => r.by }, { label: "Note", get: (r) => r.note },
          ...(isAdmin() ? [{ label: "", html: (r) => `<button type="button" class="btn small danger" data-hdel="${r.src}:${r.id}" aria-label="Delete this history line">${ic("trash")}</button>` }] : [])], rows: history })}</div>
      </div>`;
    E.drawQr($("#pfQr"), custQr(c));
    if ($("#pfLoc")) $("#pfLoc").onchange = (e) => setLocation(c, e.target.value);
    // Change or remove the profile photo. The new photo is kept in Files; the old one leaves Files (and, for the
    // Director, is deleted from storage too).
    const dropOld = (old) => { if (old && isAdmin()) sb.storage.from("records").remove([old]).catch(() => {}); };
    if ($("#pfPhotoFile")) $("#pfPhotoFile").onchange = async (e) => {
      if (!e.target.files[0]) return;
      if (!/^image\//.test(e.target.files[0].type)) return toast("Choose a photo (an image file).", true);
      const f = await E.slimFile(e.target.files[0], "photo");
      const path = `customer/${c.id}/Profile_Photo_${Date.now()}.${extOf(f)}`;
      const up = await sb.storage.from("records").upload(path, f, { contentType: f.type });
      if (up.error) return fail(up.error, "The photo could not be uploaded");
      const { error } = await sb.rpc("set_customer_photo", { p_id: c.id, p_path: path });
      if (error) return fail(error, "Could not save the photo");
      await sb.from("attachments").insert({ owner_type: "customer", owner_id: c.id, kind: "photo", storage_path: path, file_name: `${c.account_no || c.application_no} Profile Photo`, mime: f.type, size: f.size });
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
    E.keepTab("#pfTabs", "customer:" + c.id);
    E.bindGrid($('[data-p="2"]'), invs.data || [], (r) => (location.hash = "invoice/" + r.id));
    E.bindGrid($('[data-p="3"]'), pays.data || [], (r) => (location.hash = "payment/" + r.id));
    // payments with money not yet linked to an invoice, and the credit (overpaid) that is ready for other invoices
    sb.from("payment_available").select("receipt_no, available").eq("customer_id", c.id).gt("available", 0.004).then(({ data, error }) => {
      const el = $("#pfFree"); if (!el || error || !data?.length) return;
      const sum = data.reduce((t, r) => t + num(r.available), 0);
      el.innerHTML = `<div class="pay-free">${data.length} payment${data.length === 1 ? "" : "s"} not linked to an invoice yet: <b>₱ ${peso(sum)}</b> (${data.slice(0, 6).map((r) => esc(r.receipt_no || "")).join(", ")}${data.length > 6 ? " …" : ""}). They pay the oldest invoices first, or link them on an invoice (Link a Payment).${num(b.balance_due) < 0 ? ` Overpaid credit ready for other invoices: <b>₱ ${peso(-num(b.balance_due))}</b>.` : ""}</div>`;
    }, () => {});
    E.bindGrid($('[data-p="4"]'), cms, (r) => (location.hash = "creditmemo/" + r.id));
    E.bindGrid($('[data-p="7"]'), overdue, (r) => (location.hash = "invoice/" + r.id));
    E.bindGrid($('[data-p="8"]'), rets, (r) => (location.hash = "creditmemo/" + r.id));
    // 3.13: print the Overdue, Returns or Credit Memo history of this customer
    $$("[data-hprint]").forEach((b) => (b.onclick = () => {
      const k = b.dataset.hprint, set = { od: ["Overdue Invoices", OD_HIST, overdue], rt: ["Return History", RET_HIST, rets], cm: ["Credit Memo History", CM_HIST, cms] }[k];
      const total = k === "od" ? set[2].reduce((t, r) => t + num(r.balance), 0) : set[2].reduce((t, r) => t + num(r.request_amount), 0);
      E.openPreview(`${set[0]} ${c.account_no || ""}`, E.listingPages({ title: set[0], range: `${fullName(c)} · Account No ${c.account_no || ""} · as of ${mdy(isoToday())}`, logo: true,
        cols: set[1].filter((x) => !x.html).concat(set[1].filter((x) => x.html).map((x) => ({ label: x.label, get: x.text }))), rows: set[2],
        summary: { title: "Summary", cols: ["", "Count", k === "od" ? "Balance Overdue (₱)" : "Total Amount (₱)"], rows: [], total: ["Total:", String(set[2].length), peso(total)] },
        criteria: `Customer: ${fullName(c)} (${c.account_no || ""})` }));
    }));
    if (!["pending", "verified", "rejected"].includes(c.status)) renderSoaTab(c, invs.data || [], pays.data || [], memos.data || [], orders);
    else $("#pfSoa").innerHTML = `<div class="empty">Statements start after the account is approved.</div>`;
    bindFiles($("#main"));
    bindDocCards($("#main"), () => V.customer(c.id));
    bindTools($("#main"));
    const gctx = { b, invs: invs.data || [], pays: pays.data || [], memos: memos.data || [], orders };
    if ($("#pfRequest")) $("#pfRequest").onclick = () => E.customerRequest(c, gctx);
    E.bindRequests(c, orders, gctx);
    E.standingBadge($("#pfStanding"), c, gctx);
    // 3.12: the Director deletes a history line
    $$("[data-hdel]").forEach((b) => (b.onclick = async () => {
      const [src, hid] = b.dataset.hdel.split(":");
      const row = history.find((h) => h.src === src && String(h.id) === hid);
      if (!(await E.confirmBox(`Delete this history line?<br><b>${esc(row?.action || "")}</b> ${esc(row?.note || "")}<br>It cannot be brought back.`, { ok: "Delete", danger: true }))) return;
      const { error } = await sb.rpc("delete_history_line", { p_source: src, p_id: Number(hid) });
      if (error) return fail(error, /delete_history_line|schema cache/i.test(error.message || "") ? "Run the database update 030_delete_history.sql first" : "Could not delete the history line");
      toast("History line deleted."); V.customer(c.id);
    }));
    if ($("#pvShow")) $("#pvShow").onclick = () => { const el = $("#pvCode"); const hidden = el.textContent.startsWith("•"); el.textContent = hidden ? el.dataset.code || "(none)" : "••••••••"; $("#pvShow").textContent = hidden ? "Hide" : "Show"; };
    if ($("#pfAdd")) $("#pfAdd").onchange = async (e) => { const here = E.stillHere(), f = await uploadRecords("customer", c.id, "requirement", Array.from(e.target.files)); toast(f ? `${f} file(s) failed to upload.` : "Uploaded.", f > 0); if (here()) V.customer(c.id); };
    if (isAdmin() && ["pending", "verified"].includes(c.status)) bindReview(c);
    E.setRecords(c.account_no ? `Account: ${c.account_no}` : `Application: ${c.application_no}`);
  };

  // 2.7: the account amounts are listed here; the profile shows only the Balance Due
  function detailsTable(c, b = null) {
    const st = b ? num(b.total_settlement) : 0;
    const money = b ? [["Total Invoiced", "₱ " + peso(b.total_invoiced)], ["Additional Charge", "₱ " + peso(b.total_charges)],
      ["Settlement Adjustment", `${st < 0 ? "− " : st > 0 ? "+ " : ""}₱ ${peso(Math.abs(st))}`], ["Total Paid", "₱ " + peso(b.total_paid)],
      ["Credits / Discounts", "₱ " + peso(b.total_credits)], ["Balance Due", "₱ " + peso(b.balance_due)]] : [];
    const rows = [
      ["First Name", c.first_name], ["Last Name", c.last_name], ["Phone", c.phone], ["Email", c.email],
      ["Full Address", c.address],
      ["Credit Limit", c.credit_limit != null ? "₱ " + peso(c.credit_limit) : ""], ["Opening Balance", "₱ " + peso(c.opening_balance)], ...money,
      ["Business Name", c.business_name], ["Business Start Date", mdy(c.business_start_date)],
      ["Facebook Name", c.facebook_name], ["Facebook Account Link", c.facebook_link, fbLinkHtml(c.facebook_link)],
      ["Additional Facebook", c.has_extra_facebook ? "Yes — " + (c.extra_facebook_name || "") : "No"],
      [["pending", "verified", "rejected"].includes(c.status) ? "Application Date" : "Opening Date", mdy(c.application_date)], ["Issued By", c.issued_by_name], ["Account Status", c.status.toUpperCase()], ["Status Note", c.status_note]
    ];
    return `<div class="grid-wrap"><table class="grid kv-table"><tbody>${rows.map(([k, v, html]) => `<tr><th scope="row">${esc(k)}</th><td>${html || esc(v || "—")}</td></tr>`).join("")}</tbody></table></div>`;
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
        <li><b>Check records:</b> look for the same name, Facebook name or Facebook link in other accounts. A person whose account was CLOSED, or whose Facebook link is already on another account, cannot open an account.
          <div class="btnrow"><button type="button" class="btn primary" id="rvCheck">Check &amp; Verify</button>
          <button type="button" class="btn" id="rvFb">${c.facebook_verified ? "Mark Facebook NOT verified" : "Mark Facebook verified"}</button>
          ${locSelect(c, "rvLoc")}</div><div id="rvResult">${c.status === "verified" ? `<div class="addr-msg ok">✔ Verification successful (already verified).</div>` : ""}</div></li>
        <li><b>Application form signed by the customer:</b> ${signed.length ? `<span class="ok-txt">✔ Uploaded.</span>`
          : `<span class="bad-txt">not uploaded yet.</span> Print the form from the <b>System Generated</b> card above, have the customer sign it, then scan or upload it on the <b>Signed Paper Copy</b> card.`}
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
      } else if (data.some((r) => r.blocked)) {
        out.innerHTML = personCheckHtml(data);
        E.bindGrid(out, data, (r) => window.open("#customer/" + r.id, "_blank"));
      } else {
        out.innerHTML = `<div class="addr-msg warn">⚠ ${data.length} account(s) with the same name or Facebook name. Check that it is not the same person:</div>` +
          E.grid({ cols: [{ label: "Account No", get: (r) => r.account_no }, { label: "Name", get: fullName }, { label: "Phone", get: (r) => r.phone || "" }, { label: "Status", html: (r) => pill(r.status) }, { label: "Matched On", get: (r) => (r.matched_on || "").replace(/\b\w/g, (x) => x.toUpperCase()) }], rows: data, onRow: true })
          + `<div class="btnrow"><button type="button" class="btn" id="rvAnyway">Not the same person — Verify anyway</button></div>`;
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
      toast(a === "approve" ? `Approved. ${r.data?.account_no || c.account_no || "The account"} is now ACTIVE.` : "Application rejected.");
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
          <span>Account No</span><b class="mono big">${c.account_no ? esc(c.account_no) : "Given when the Director approves"}</b>
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
  // Settlement Adjustments that take money off credit. Each line is named in short business words in capitals (2.2):
  // a sale is its INVOICE (the invoice number), a payment is PAYMENT RECEIVED, a memo is CREDIT MEMO or DISCOUNT.
  function txnsOf(invs, pays, memos, orders = [], cust = null) {
    const t = [];
    if (num(cust?.opening_balance) > 0) t.push({ date: cust.application_date, ref: cust.account_no, desc: "OPENING BALANCE", debit: num(cust.opening_balance), credit: 0 });
    invs.forEach((i) => t.push({ date: i.invoice_date, ref: i.invoice_no, desc: "INVOICE", debit: num(i.total_amount), credit: 0, inv: i }));
    orders.filter((o) => ["charge", "settlement"].includes(o.subject_type) && o.status === "applied" && o.applied_at).forEach((o) => {
      const off = o.subject_type === "settlement" && o.adjust_type === "reduce";
      t.push({ date: isoDay(new Date(o.applied_at)), ref: o.order_no, desc: o.subject_type === "charge" ? "ADDITIONAL CHARGE" : "SETTLEMENT ADJUSTMENT", debit: off ? 0 : num(o.amount), credit: off ? num(o.amount) : 0 });
    });
    pays.forEach((p) => t.push({ date: p.paid_date, ref: p.receipt_no, desc: "PAYMENT RECEIVED", debit: 0, credit: num(p.amount), pay: p }));
    memos.filter((m) => ["approved", "paid"].includes(m.status) && ["credit", "discount"].includes(m.requested_action) && m.approved_at)
      .forEach((m) => t.push({ date: isoDay(new Date(m.approved_at)), ref: m.memo_no, desc: m.is_return ? `RETURN${m.po_number ? " · " + m.po_number : ""}` : m.requested_action === "discount" ? "DISCOUNT" : "CREDIT MEMO", debit: 0, credit: num(m.request_amount) }));
    return t.sort((a, b) => a.date.localeCompare(b.date) || (b.debit - a.debit));
  }
  // The first SOA of an account is the month the account was opened (its application date): entries dated before it
  // (old receipts and purchases recorded later) are in that first SOA, which starts from zero. No SOA is made for the
  // months before (2.2).
  const openMonth = (c) => monthStart(c?.application_date || isoToday());
  const coveredFrom = (c, start, txns) => (monthStart(start) === openMonth(c) ? [start, ...txns.map((x) => x.date)].sort()[0] : start);
  const before = (txns, d) => txns.filter((x) => x.date < d).reduce((s, x) => s + x.debit - x.credit, 0);
  const within = (txns, a, b) => txns.filter((x) => x.date >= a && x.date <= b);

  // Copies attached to the SOA: each invoice's uploaded copy and each payment's receipt for the month.
  async function monthCopies(invoices, payments) {
    const out = [];
    const pick = async (ownerType, rows, kinds, label, noOf, amtKey) => {
      if (!rows.length) return;
      const { data } = await sb.from("attachments").select("*").eq("owner_type", ownerType).in("kind", kinds).in("owner_id", rows.map((r) => r.id)).order("created_at", { ascending: false });
      for (const r of rows) {
        const list = (data || []).filter((a) => a.owner_id === r.id);
        const a = kinds.map((k) => list.find((x) => x.kind === k)).find(Boolean);
        if (!a) continue;
        const img = isImage(a);
        out.push({ label, no: noOf(r), amount: r[amtKey], date: r.invoice_date || r.paid_date, url: img ? await signedUrl(a.storage_path, 1800) : "", pdf: !img });
      }
    };
    await pick("invoice", invoices, ["signed_form"], "INVOICE", (r) => r.invoice_no, "total_amount");
    await pick("payment", payments, ["signed_form", "receipt"], "RECEIPT", (r) => r.receipt_no, "amount");
    return out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }
  const copiesSummary = (copies) => (copies.length ? `${copies.length} DOCUMENT${copies.length === 1 ? "" : "S"} ATTACHED` : "");

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
    const head = `<div class="soa-logo">${E.logoHtml("soa-logo-img")}<div class="soa-co">${esc(C.company.name)}</div><div class="soa-addr">${esc(C.company.address.join(", "))} · ${esc(C.company.email)}${E.siteText()}</div></div>
      <div class="ph-title">STATEMENT OF ACCOUNT</div>
      <div class="soa-top"><div class="soa-cust"><b>${esc(fullName(c).toUpperCase())}</b></div>
        <div class="soa-acct"><span>Statement No :</span><b>${esc(p.no || "—")}</b><span>Account No :</span><b>${esc(c.account_no)}</b>
          <span>Period Covered :</span><b>${mdy(p.from || p.start)} - ${mdy(p.end)}</b><span>Date Printed :</span><b>${mdy(isoToday())}</b></div></div>`;
    const page1 = `${head}
      <table class="soa-table"><thead><tr><th>DATE</th><th>REFERENCE NO.</th><th>TRANSACTION DESCRIPTION</th><th class="num">DEBIT</th><th class="num">CREDIT</th><th class="num">BALANCE</th></tr></thead>
      <tbody><tr><td>${mdy(p.from || p.start)}</td><td></td><td>BEGINNING BALANCE</td><td></td><td></td><td class="num">${peso(p.opening)}</td></tr>
        ${rows.map((x) => `<tr><td>${mdy(x.date)}</td><td>${esc(x.ref)}</td><td>${esc(x.desc)}</td><td class="num">${x.debit ? peso(x.debit) : ""}</td><td class="num">${x.credit ? peso(x.credit) : ""}</td><td class="num">${peso(x.bal)}</td></tr>`).join("")}
        <tr class="soa-end"><td>${mdy(p.end)}</td><td></td><td>ENDING BALANCE</td><td></td><td></td><td class="num">${peso(closing)}</td></tr>
        <tr class="soa-total"><td><b>TOTAL</b></td><td>${rows.length} TRANSACTION${rows.length === 1 ? "" : "S"}</td><td>${esc(copiesSummary(images))}</td><td class="num">${peso(deb)}</td><td class="num">${peso(cre)}</td><td></td></tr></tbody></table>
      <div class="soa-due"><span>AMOUNT DUE</span><b>₱ ${peso(closing)}</b><small>${esc(closing < 0 ? `OVERPAID — ${words(-closing)}` : words(closing))}</small></div>
      <div class="soa-note">PLEASE EXAMINE THIS STATEMENT. REPORT ANY DISCREPANCY TO ${esc(C.company.name.toUpperCase())} WITHIN 10 DAYS; OTHERWISE, IT IS CONSIDERED CORRECT.<br>PAYMENTS: ${esc(C.company.email)}</div>
      <div class="soa-sys">SYSTEM-GENERATED STATEMENT. NO SIGNATURE REQUIRED.</div>
      <div class="soa-thanks">THANK YOU FOR YOUR BUSINESS.</div>`;
    const pages = [page1];
    for (let i = 0; i < images.length; i += 4) {
      const chunk = images.slice(i, i + 4);
      pages.push(`<div class="soa-pg">Page ${pages.length + 1}</div><div class="ph-title" style="text-align:left">ATTACHED DOCUMENTS — ${esc(monthName(p.start).toUpperCase())}</div>
        <div class="soa-imgs">${chunk.map((im) => `<figure>${im.url ? `<img src="${esc(im.url)}" alt="${esc(im.label)} ${esc(im.no)}">` : `<div class="soa-pdf">${esc(im.label)} ${esc(im.no)} — COPY ON FILE (PDF)</div>`}
          <figcaption>ACCOUNT NO. ${esc(c.account_no)} &nbsp;·&nbsp; ${esc(im.label)} ${esc(im.no)} &nbsp;·&nbsp; ₱ ${peso(im.amount)}</figcaption></figure>`).join("")}</div>`);
    }
    return pages;
  }

  async function printSoa(c, p, allTxns, allInvs) {
    const from = p.from || coveredFrom(c, p.start, allTxns);
    const txns = within(allTxns, from, p.end);
    const invs = allInvs.filter((i) => i.invoice_date >= from && i.invoice_date <= p.end);
    const pays = txns.filter((x) => x.pay).map((x) => x.pay);
    const images = await monthCopies(invs, pays);
    E.openPreview(`SOA ${p.no || monthName(p.start)}`, soaPages(c, { ...p, from }, txns, images));
  }

  // One SOA a month, from the month the account was opened to this month (the first one also has the entries dated
  // before it). A month's saved statement is used when there is one; this month runs to date.
  async function renderSoaTab(c, invs, pays, memos, orders) {
    const box = $("#pfSoa"); if (!box) return;
    const { data } = await sb.from("statements").select("*").eq("customer_id", c.id).order("period_start");
    if (!box.isConnected) return; // another page was opened while the statements loaded
    const txns = txnsOf(invs, pays, memos, orders, c);
    const cm = monthStart(isoToday()), open = openMonth(c);
    const saved = new Map((data || []).filter((s) => s.period_start >= open).map((s) => [s.period_start, s]));
    const rows = [];
    for (let m = open; m <= cm; m = nextMonth(m)) {
      const s = saved.get(m), from = coveredFrom(c, m, txns);
      if (s) { rows.push({ start: s.period_start, from, end: s.period_end, opening: num(s.opening_balance), closing: num(s.closing_balance), no: s.statement_no, debit: num(s.total_debit), credit: num(s.total_credit) }); continue; }
      const end = m === cm ? isoToday() : dayBefore(nextMonth(m));
      const t = within(txns, from, end), opening = m === open ? 0 : before(txns, m);
      const debit = t.reduce((x, y) => x + y.debit, 0), credit = t.reduce((x, y) => x + y.credit, 0);
      rows.push({ start: m, from, end, opening, debit, credit, closing: opening + debit - credit, no: soaNo(m, c), live: m === cm });
    }
    rows.reverse();
    box.innerHTML = `<div class="btnrow"><button type="button" class="btn" id="soaAll">${ic("print")} Print All Transactions</button>${isAdmin() ? `<a class="btn" href="#statements">All Statements (SOA)</a>` : ""}</div>
      ${E.grid({ cols: [
        { label: "Period", get: (r) => (r.live ? `${monthName(r.start)} (to date)` : monthName(r.start)).toUpperCase() }, { label: "Statement No", get: (r) => r.no },
        { label: "Opening (₱)", num: true, get: (r) => peso(r.opening) }, { label: "Debit (₱)", num: true, get: (r) => peso(r.debit) },
        { label: "Credit (₱)", num: true, get: (r) => peso(r.credit) }, { label: "Closing (₱)", num: true, get: (r) => peso(r.closing) },
        { label: "", html: () => `<span class="btn">Print SOA</span>` }], rows, onRow: true })}
      <small>One statement a month, made automatically on the 1st for the month just ended. The first is the month the account was opened (with any earlier entries); each month's closing balance is the next month's opening balance.</small>`;
    E.bindGrid(box, rows, (r) => printSoa(c, r, txns, invs));
    $("#soaAll", box).onclick = () => {
      const start = txns.length ? monthStart(txns[0].date) : monthStart(c.application_date);
      E.openPreview(`All Transactions ${c.account_no}`, soaPages(c, { start, end: isoToday(), opening: 0, no: soaNo(isoToday(), c, true) }, within(txns, start, isoToday()), []));
    };
  }

  // Admin: every customer's SOA for a month.
  V.statements = async () => {
    if (!isAdmin()) { location.hash = "customers"; return; }
    const last = monthStart(new Date(new Date().setDate(0)).toISOString().slice(0, 10));
    E.shell("statements", "Statements of Account", `
      <div class="options"><fieldset class="opt"><legend>Month</legend><div class="fields"><label for="stMonth">Statement Month</label><input type="month" id="stMonth" value="${last.slice(0, 7)}"></div></fieldset></div>
      <div class="btnrow"><button type="button" class="btn primary" id="stGo">Show</button><button type="button" class="btn" id="stPrintAll">${ic("print")} Print All for Month</button><a class="btn" href="#customers">Close</a></div>
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
    $("#stPrintAll").onclick = async () => {
      if (!rows.length) return toast("No statements for this month.", true);
      const pages = [];
      for (const r of rows) { const x = await dataFor(r.customer_id); const p = asPeriod(r); p.from = coveredFrom(r.customers, p.start, x.txns); pages.push(...soaPages(r.customers, p, within(x.txns, p.from, p.end), [])); }
      E.openPreview(`All SOA ${monthName(rows[0].period_start)}`, pages);
    };
    load();
  };

  // ======================================================================
  // 2. Invoice
  // ======================================================================
  // 3.13: an invoice not fully paid after its due date is OVERDUE (what is paid comes from invoice_balances: a payment not
  // linked to an invoice pays the oldest invoices first by itself)
  const isOverdue = (r) => r.pay_status !== "paid" && num(r.balance) > 0.004 && r.due_date && r.due_date < isoToday();
  const daysOver = (r) => Math.max(0, Math.floor((new Date(isoToday() + "T00:00:00") - new Date(r.due_date + "T00:00:00")) / 86400000));
  const payPill = (r) => `${pill(r.pay_status)}${isOverdue(r) ? ` ${pill("overdue")}` : ""}`;
  const INV_COLS = [
    { label: "Invoice No", get: (r) => r.invoice_no }, { label: "Date", get: (r) => mdy(r.invoice_date) },
    { label: "Terms", get: (r) => r.payment_terms || "" }, { label: "Due Date", get: (r) => mdy(r.due_date) },
    { label: "Account No", get: (r) => r.account_no }, { label: "Customer", get: fullName },
    { label: "Boxes", num: true, get: (r) => r.total_boxes }, { label: "Pcs", num: true, get: (r) => r.total_pcs },
    { label: "Amount (₱)", key: "total_amount", num: true, get: (r) => peso(r.total_amount) },
    { label: "Returned (₱)", key: "amount_returned", num: true, get: (r) => (num(r.amount_returned) ? peso(r.amount_returned) : "") },
    { label: "Paid (₱)", key: "amount_paid", num: true, get: (r) => peso(r.amount_paid) },
    { label: "Balance (₱)", key: "balance", num: true, get: (r) => peso(r.balance) },
    { label: "Status", html: payPill }
  ];
  // 2.4.3: the tabs are All, Unpaid, Partial Payment and Paid. What is paid comes from the database (invoice_balances): everything paid to the customer's account pays the oldest
  // invoices first (payments are never for one invoice).
  const INV_TABS = [["", "All"], ["unpaid", "Unpaid"], ["partial", "Partial Payment"], ["overdue", "Overdue"], ["paid", "Paid"]];
  const invPick = (all, f) => (f === "overdue" ? all.filter(isOverdue) : f ? all.filter((r) => r.pay_status === f) : all);
  V.invoices = async () => {
    E.shell("invoices", "Invoice", `
      <div class="tabs" id="ivTabs">${INV_TABS.map(([f, l], i) => `<button type="button" class="${i ? "" : "on"}" data-f="${f}">${l} <span data-n="${f}"></span></button>`).join("")}</div>
      <div class="btnrow">${E.canWrite("invoices") ? `<a class="btn primary" href="#newinvoice">+ Record Invoice</a>` : ""}</div>
      <div id="ivRes">${busy()}</div>`, "Every invoice is <b>PAID</b> (in full), <b>PARTIAL PAYMENT</b> or <b>UNPAID</b> (nothing paid yet). Payments, credit memos, discounts and settlement adjustments are for the customer's account: they pay the oldest invoices first. Press <b>Record Invoice</b> to add a sale for an ACTIVE customer.");
    const { data, error } = await sb.from("invoice_balances").select("*").order("invoice_date", { ascending: false }).order("invoice_no", { ascending: false }).limit(5000);
    if (error) return fail(error, "Could not load invoices");
    const all = data || [];
    if (!$("#ivTabs")) return; // another page was opened while the invoices loaded
    $$("#ivTabs [data-n]").forEach((x) => (x.textContent = `(${invPick(all, x.dataset.n).length})`));
    const run = (f) => {
      const rows = invPick(all, f);
      const sum = (k) => peso(rows.reduce((s, r) => s + num(r[k]), 0));
      $("#ivRes").innerHTML = E.grid({ cols: INV_COLS, rows, onRow: true, foot: { total_amount: sum("total_amount"), amount_returned: sum("amount_returned"), amount_paid: sum("amount_paid"), balance: sum("balance") }, empty: "No invoices here." });
      E.bindGrid($("#ivRes"), rows, (r) => (location.hash = "invoice/" + r.id));
      E.setRecords(`Invoices: ${rows.length}`);
    };
    $$("#ivTabs button").forEach((b) => (b.onclick = () => { $$("#ivTabs button").forEach((x) => x.classList.toggle("on", x === b)); run(b.dataset.f); }));
    run("");
  };

  V.newinvoice = async (custId) => {
    if (!E.canWrite("invoices")) { toast("Only the Director and employees with Invoice access can record invoices.", true); location.hash = "invoices"; return; }
    E.shell("newinvoice", "Record Invoice", `
      <form class="window" id="niForm" novalidate>
        <div class="wtitle">Record Invoice</div>
        <div class="wbody">
          <fieldset class="opt"><legend>Customer (ACTIVE accounts only)</legend><div id="niCust"></div><div id="niCredit"></div></fieldset>
          <fieldset class="opt"><legend>Invoice</legend><div class="formgrid">
            <div class="fields wide">
              <label for="niDate">Invoice Date</label><input type="date" id="niDate" value="${isoToday()}" max="${isoToday()}">
              <span>Invoice No</span><small>Given by the system when you submit (INV-YYYYMM-####).</small>
            </div>
            <div class="fields wide">
              <label for="niBox">Total Boxes</label><input type="number" id="niBox" min="0" step="1" value="0">
              <label for="niPcs">Total Pcs</label><input type="number" id="niPcs" min="0" step="1" value="0">
              <label for="niAmt">Total Amount (₱) *</label><input type="number" id="niAmt" min="0" step="0.01" required>
            </div></div>
            <div class="summary-box" style="margin-top:6px"><span id="niWords">PESOS ZERO ONLY</span></div></fieldset>
          <fieldset class="opt"><legend>Terms of Payment</legend><div class="fields wide">
            <label for="niTerms">Terms of Payment *</label><select id="niTerms" required><option value="">— Choose the terms —</option>${E.TERMS.map((t) => `<option>${t}</option>`).join("")}<option value="OTHER">OTHER (type the terms)</option></select>
            <label for="niTermsX" class="nitx" hidden>Other Terms *</label><input type="text" id="niTermsX" class="nitx" maxlength="60" placeholder="e.g. 2 POST-DATED CHECKS" hidden>
            <span>Due Date</span><b id="niDue">—</b></div>
            <small class="muted">Payments are recorded with <b>Record Payment</b> for the customer's account: they pay the oldest invoices first.</small></fieldset>
          <fieldset class="opt"><legend>Purchase Order</legend><div class="fields wide">
            <label for="niPo">PO Number</label><input type="text" id="niPo" maxlength="60" placeholder="e.g. PO-2026-0145"></div></fieldset>
          <fieldset class="opt"><legend>Documents</legend><div class="fields wide">
            ${fileField("niInvF", "Invoice Paper Copy (scan or upload)", 'accept="image/*,application/pdf"')}
            ${fileField("niDr", "Delivery Receipt", 'multiple accept="image/*,application/pdf"')}</div></fieldset>
        </div>
        <div class="wfoot"><button type="button" class="btn" id="niCancel">Cancel</button><button type="submit" class="btn primary">Submit Invoice</button></div>
      </form>`, "The invoice is saved to the customer's account and added to their balance due. Choose its <b>Terms of Payment</b>: the due date follows from it.");
    let cust = null;
    const showCredit = async (c) => {
      const el = $("#niCredit"); if (!el) return;
      el.innerHTML = "";
      const { data } = await sb.from("customer_balances").select("balance_due").eq("customer_id", c.id).maybeSingle();
      if (cust?.id !== c.id || !el.isConnected) return;
      if (data && num(data.balance_due) < 0) el.innerHTML = `<div class="credit-note">${fullName(c)} has overpaid: <b>₱ ${peso(-num(data.balance_due))}</b> is ready for this invoice. It is used by itself, oldest invoice first.</div>`;
    };
    customerPicker($("#niCust"), { statuses: ["active"], onPick: (c) => { cust = c; showCredit(c); }, preset: (await getCustomer(custId)) || undefined });
    if (cust && cust.status !== "active") { toast(`${fullName(cust)}'s account is ${cust.status.toUpperCase()} — invoices are blocked.`, true); cust = null; $("#niCust .pk-chosen").innerHTML = ""; }
    $("#niAmt").oninput = () => ($("#niWords").textContent = words($("#niAmt").value));
    // the terms chosen (OTHER: the terms typed, in capitals) and the due date that follows
    const terms = () => ($("#niTerms").value === "OTHER" ? $("#niTermsX").value.trim().replace(/\s+/g, " ").toUpperCase() : $("#niTerms").value);
    const showDue = () => {
      $$(".nitx").forEach((x) => (x.hidden = $("#niTerms").value !== "OTHER"));
      const due = E.termsDue($("#niDate").value || isoToday(), terms());
      $("#niDue").textContent = due ? mdy(due) : $("#niTerms").value ? "— (see the terms)" : "—";
    };
    $("#niTerms").onchange = showDue; $("#niTermsX").oninput = showDue; $("#niDate").addEventListener("change", showDue);
    $("#niCancel").onclick = () => history.back();
    $("#niForm").onsubmit = async (e) => {
      e.preventDefault();
      if (!cust) return toast("Choose an ACTIVE customer first.", true);
      const amt = num($("#niAmt").value);
      if (!$("#niAmt").value || amt < 0) return toast("Enter the total amount.", true);
      const t = terms();
      if (!t) return toast($("#niTerms").value === "OTHER" ? "Type the terms of payment." : "Choose the terms of payment.", true);
      E.setBusy(e.target, true, "Saving");
      const row = {
        customer_id: cust.id, invoice_date: $("#niDate").value || isoToday(), purchase_date: $("#niDate").value || isoToday(),
        po_number: $("#niPo").value.trim().toUpperCase() || null,
        total_boxes: Math.max(0, Math.floor(num($("#niBox").value))),
        total_pcs: Math.max(0, Math.floor(num($("#niPcs").value))), total_amount: amt, payment_terms: t
      };
      let { data: inv, error } = await sb.from("customer_invoices").insert(row).select().single();
      // before database update 2.4 (017_play_store.sql) the server has no terms of payment: the invoice is saved without them
      let noTerms = false;
      if (error && error.code === "PGRST204" && /payment_terms/.test(error.message || "")) {
        delete row.payment_terms; noTerms = true;
        ({ data: inv, error } = await sb.from("customer_invoices").insert(row).select().single());
      }
      if (error) { E.setBusy(e.target, false); return fail(error, "Could not record the invoice"); }
      let failed = 0;
      failed += await uploadRecords("invoice", inv.id, "signed_form", filesOf("niInvF"));
      failed += await uploadRecords("invoice", inv.id, "delivery_receipt", filesOf("niDr"));
      toast(`Invoice ${inv.invoice_no} recorded for ${fullName(cust)}.${noTerms ? " The Terms of Payment were not saved: the server needs database update 2.4 first (017_play_store.sql); after it, add them with Edit." : ""}${failed ? ` ${failed} file(s) failed to upload.` : ""}`, failed > 0 || noTerms);
      location.hash = "invoice/" + inv.id;
    };
  };

  V.invoice = async (id) => {
    E.shell("invoice", "Invoice", busy());
    const here = E.stillHere();
    // 2.9: everything the page needs is asked for at once. Returns (2.8, update 020) and payment links (update 022) are
    // empty lists on a database without those updates.
    const [ib, att, rt, lk] = await Promise.all([
      sb.from("invoice_balances").select("*").eq("id", id).maybeSingle(),
      attachmentsOf("invoice", id),
      sb.from("credit_memos").select("*").eq("invoice_id", id).order("memo_date"),
      sb.from("payment_links").select("*, payments_received(receipt_no, paid_date, amount)").eq("invoice_id", id).order("linked_at")
    ]);
    if (!here()) return;
    const inv = ib.data;
    if (!inv) { $("#main").innerHTML = `<div class="empty">Invoice not found. <a href="#invoices">Back to Invoices</a></div>`; return; }
    const rets = (rt.data || []).filter((m) => m.is_return);
    // 3.14: what was taken off this invoice: approved returns and credit / discount memos of this invoice
    const deds = (rt.data || []).filter((m) => ["approved", "paid"].includes(m.status) && ["credit", "discount"].includes(m.requested_action));
    const linksOn = !lk.error, links = lk.data || [], active = links.filter((l) => !l.removed_at);
    const canReturn = E.canWrite("invoices") || E.canWrite("creditmemos");
    const canLink = linksOn && (E.canWrite("payments") || E.canWrite("invoices"));
    const returned = num(inv.amount_returned), bal = num(inv.balance);
    // what the invoice still needs from linked payments (other payments pay it only through the oldest-first order)
    const need = num(inv.total_amount) - returned - active.reduce((s, l) => s + num(l.amount), 0);
    $(".band h1").textContent = `Invoice — ${inv.invoice_no}`;
    $("#main").innerHTML = `<div class="window"><div class="wtitle">${esc(inv.invoice_no)} ${payPill(inv)}</div><div class="wbody">
      <div class="formgrid"><div class="fields wide">
        <span>Customer</span><span><a href="#customer/${inv.customer_id}"><b>${esc(fullName(inv))}</b> (${esc(inv.account_no)})</a> ${inv.customer_status !== "active" ? pill(inv.customer_status) : ""}</span>
        <span>Invoice Date</span><span>${mdy(inv.invoice_date)}</span>
        <span>PO Number</span><span>${esc(inv.po_number || "—")}</span>
        <span>Terms of Payment</span><span>${esc(inv.payment_terms || "—")}</span><span>Due Date</span><span>${mdy(inv.due_date) || "—"}</span>
        <span>Recorded By</span><span>${esc(inv.created_by_name || "")}</span></div>
      <div class="fields wide"><span>Total Boxes</span><b>${inv.total_boxes}</b><span>Total Pcs</span><b>${inv.total_pcs}</b>
        <span>Total Amount</span><b>₱ ${peso(inv.total_amount)}</b>${returned > 0 ? `<span>Returned</span><b>− ₱ ${peso(returned)}</b>` : ""}<span>Paid</span><b>₱ ${peso(inv.amount_paid)}</b>
        <span>Balance</span><b class="${bal < 0 ? "neg" : ""}">₱ ${peso(bal)}</b>
        <span>Payment Status</span><span>${payPill(inv)}${isOverdue(inv) ? ` <small class="muted">${daysOver(inv)} day(s) overdue</small>` : ""}${bal < 0 ? ` <small class="muted">overpaid ₱ ${peso(-bal)}</small>` : ""}</span></div></div>
      <small class="muted">A payment linked to this invoice pays it first; only what the invoice needs is taken, the rest of the payment stays available for another invoice. Other payments, discounts and orders pay the customer's oldest invoices first.${bal < 0 ? " A negative balance means the customer has paid more than everything owed." : ""}</small>
      <div class="linked-pays"><div class="lp-head"><b>Returns</b>${canReturn ? `<button type="button" class="btn small" id="ivReturn">${ic("back")} Record Return</button>` : ""}</div>
        ${rets.length ? rets.map((r) => `<div class="lp-row lp-ret"><a href="#creditmemo/${r.id}"><b>${esc(r.memo_no || "")}</b></a><span>${mdy(r.memo_date)} · ${esc(r.serial_no || "")}${r.qty ? ` · ${r.qty} pcs` : ""}</span><b>− ₱ ${peso(r.request_amount)}</b>
          ${r.status === "pending" ? `<span class="pill pending">WAITING FOR APPROVAL</span>` : r.status === "rejected" ? pill("rejected") : `<span class="pill active">TAKEN OFF</span>`}${r.warehouse_status ? ` <span class="pill ${r.warehouse_status === "received" ? "active" : "pending"}">${WAREHOUSE[r.warehouse_status] || ""}</span>` : ""}</div>`).join("")
          : `<div class="empty small">No returns on this invoice.</div>`}</div>
      <div class="linked-pays"><div class="lp-head"><b>Linked Payments</b>${canLink && need > 0.004 ? `<button type="button" class="btn small" id="ivLink">${ic("plus")} Link a Payment</button>` : ""}</div>
        ${!linksOn ? `<div class="empty small">Linking payments needs the database update 022_update_2_9.sql.</div>`
          : links.length ? links.map((l) => `<div class="lp-row${l.removed_at ? " lp-off" : ""}"><a href="#payment/${l.payment_id}"><b>${esc(l.payments_received?.receipt_no || "")}</b></a>
            <span>Paid ${mdy(l.payments_received?.paid_date)} · ₱ ${peso(l.payments_received?.amount)}<small>Linked ${esc(E.dateTime(l.linked_at))}${l.linked_by_name ? ` by ${esc(l.linked_by_name)}` : ""}${l.removed_at ? ` · unlinked ${esc(E.dateTime(l.removed_at))}${l.removed_by_name ? ` by ${esc(l.removed_by_name)}` : ""}` : ""}</small></span>
            <b>₱ ${peso(l.amount)}</b>${l.removed_at ? `<span class="pill rejected">UNLINKED</span>` : canLink ? `<button type="button" class="linkbtn" data-unlink="${l.id}">Unlink</button>` : `<span class="pill active">LINKED</span>`}</div>`).join("")
          : `<div class="empty small">No payment is linked to this invoice.</div>`}
        ${linksOn && active.length ? `<div class="lp-sum"><span>Linked to this invoice</span><b>₱ ${peso(active.reduce((s, l) => s + num(l.amount), 0))}</b>${need > 0.004 ? `<span>Still needed from a payment</span><b>₱ ${peso(need)}</b>` : ""}</div>` : ""}</div>
      <div class="docgrid">${docCard({ key: "inv", title: `Invoice ${inv.invoice_no}`, tag: "System Generated", sub: `Made by the E-Portal · ₱ ${peso(inv.total_amount)} · ${mdy(inv.invoice_date)}${deds.length ? ` · CORRECTED: ₱ ${peso(num(inv.total_amount) - deds.reduce((t, m) => t + num(m.request_amount), 0))}` : ""}`, ownerType: "invoice", ownerId: inv.id, att, kind: "__system", canUpload: false, print: () => E.openPreview(`Invoice ${inv.invoice_no}`, [invoicePage(inv, active, deds)]) })}
        ${copyCard({ key: "invcopy", title: `Invoice ${inv.invoice_no}`, tag: "Paper Copy", sub: "Scan or upload the paper invoice", ownerType: "invoice", ownerId: inv.id, att, kind: "signed_form" })}</div>
      <div><b>Other Files</b>${filesHtml(att.filter((a) => a.kind !== "signed_form"), "No other files.")}</div>
      ${rhBox("customer_invoices", inv.id)}</div>
      <div class="wfoot">${tools("customer_invoices", inv, `Invoice ${inv.invoice_no}`, { reload: () => V.invoice(id), afterDelete: () => (location.hash = "invoices") })}
        ${(E.canWrite("payments") || E.canWrite("invoices")) && ["active", "suspended", "closed"].includes(inv.customer_status) ? `<a class="btn" href="#newpayment/${inv.customer_id}">Record Payment</a>` : ""}
        <a class="btn" href="#invoices">Close</a></div></div>`;
    bindFiles($("#main"));
    bindDocCards($("#main"), () => V.invoice(id));
    bindTools($("#main"));
    // 2.9: record a return with up to 20 item lines (item, description, boxes, pcs, amount) and their totals. RETURN OF
    // ITEMS waits for the warehouse (NOT RECEIVED until it is marked RECEIVED); PRICE LESS, DAMAGE and OTHERS bring no
    // goods back. The amount is taken off this invoice (the Director's at once, an employee's after approval).
    if ($("#ivReturn")) $("#ivReturn").onclick = () => {
      const left = num(inv.total_amount) - rets.filter((r) => r.status !== "rejected").reduce((a, r) => a + num(r.request_amount), 0);
      const line = () => `<tr class="rt-line"><td data-l="Item / Serial No"><input type="text" class="rtI" maxlength="60" placeholder="e.g. G2026034G"></td><td data-l="Description"><input type="text" class="rtD" maxlength="80" placeholder="e.g. Ladies short pant"></td>
        <td data-l="Boxes"><input type="number" class="rtB" min="0" step="1" inputmode="numeric"></td><td data-l="Pcs"><input type="number" class="rtP" min="0" step="1" inputmode="numeric"></td>
        <td data-l="Amount (₱)"><input type="number" class="rtA" min="0" step="0.01" inputmode="decimal"></td><td><button type="button" class="linkbtn del rtX" aria-label="Remove line">${ic("x")}</button></td></tr>`;
      const m = E.modal(`Record Return — ${inv.invoice_no}`, `<form id="rtForm" novalidate>
          <div class="fields wide"><span>Kind</span><div class="subj-grid" id="rtKind">${Object.entries(RET_KIND).map(([k, v], i) => `<label class="subj"><input type="radio" name="rtK" value="${k}" ${i ? "" : "checked"}><span>${esc(v)}</span></label>`).join("")}</div>
            <label for="rtDate">Return Date</label><input type="date" id="rtDate" value="${isoToday()}"></div>
          <div class="grid-wrap rt-wrap"><table class="grid rt-table"><thead><tr><th>Item / Serial No</th><th>Description</th><th class="num">Boxes</th><th class="num">Pcs</th><th class="num">Amount (₱)</th><th></th></tr></thead>
            <tbody id="rtLines">${line()}</tbody><tfoot><tr><td colspan="2"><button type="button" class="btn small" id="rtAdd">${ic("plus")} Add Item</button> <small class="muted">up to 20 items</small></td>
            <td class="num" id="rtTB">0</td><td class="num" id="rtTP">0</td><td class="num" id="rtTA">0.00</td><td></td></tr></tfoot></table></div>
          <div class="fields wide"><label for="rtAmt">Return Amount (₱) *</label><input type="number" id="rtAmt" min="0.01" step="0.01" inputmode="decimal" placeholder="Up to ${peso(left)}">
            <label for="rtNote">Note</label><input type="text" id="rtNote" maxlength="300" placeholder="Optional, e.g. refund 14,000 given"></div>
        </form><p class="muted" style="margin:8px 0 0" id="rtHint"></p>`,
        `<button type="button" class="btn" id="rtCancel">Cancel</button><button type="button" class="btn primary" id="rtSave">${ic("check")} Save Return</button>`, { wide: true });
      const lines = () => $$("#rtLines .rt-line", m.el).map((tr) => ({ item: $(".rtI", tr).value.trim(), desc: $(".rtD", tr).value.trim(),
        boxes: Math.max(0, Math.round(num($(".rtB", tr).value))), pcs: Math.max(0, Math.round(num($(".rtP", tr).value))), amount: Math.max(0, num($(".rtA", tr).value)) }))
        .filter((l) => l.item || l.desc || l.pcs || l.boxes || l.amount);
      const kind = () => $("input[name=rtK]:checked", m.el)?.value || "return";
      let amtTyped = false;
      const sum = () => {
        const ls = lines(), tb = ls.reduce((s, l) => s + l.boxes, 0), tp = ls.reduce((s, l) => s + l.pcs, 0), ta = ls.reduce((s, l) => s + l.amount, 0);
        $("#rtTB", m.el).textContent = tb; $("#rtTP", m.el).textContent = tp; $("#rtTA", m.el).textContent = peso(ta);
        if (!amtTyped && ta > 0) $("#rtAmt", m.el).value = ta.toFixed(2);
        $("#rtAdd", m.el).disabled = $$("#rtLines .rt-line", m.el).length >= 20;
        $("#rtHint", m.el).textContent = `${kind() === "return" ? "The items come back: the return shows NOT RECEIVED until the warehouse marks it RECEIVED. " : "No goods come back (the warehouse status is not needed). "}The amount is taken off this invoice and the customer's balance, and shows as RETURN on the statement of account.${isAdmin() ? "" : " It waits for the Director's approval."}`;
      };
      const bindLines = () => $$("#rtLines .rt-line", m.el).forEach((tr) => {
        $$("input", tr).forEach((x) => (x.oninput = sum));
        $(".rtX", tr).onclick = () => { if ($$("#rtLines .rt-line", m.el).length > 1) tr.remove(); else $$("input", tr).forEach((x) => (x.value = "")); sum(); };
      });
      $("#rtAdd", m.el).onclick = () => { if ($$("#rtLines .rt-line", m.el).length >= 20) return; $("#rtLines", m.el).insertAdjacentHTML("beforeend", line()); bindLines(); sum(); $("#rtLines .rt-line:last-child .rtI", m.el).focus(); };
      $("#rtAmt", m.el).oninput = () => (amtTyped = true);
      $$("input[name=rtK]", m.el).forEach((r) => (r.onchange = sum));
      bindLines(); sum();
      $("#rtCancel", m.el).onclick = m.close;
      $("#rtSave", m.el).onclick = async () => {
        const ls = lines(), amt = num($("#rtAmt", m.el).value);
        if (!ls.length || ls.some((l) => !l.item && !l.desc)) return toast("Write the item or description on every line.", true);
        if (!(amt > 0)) return toast("Enter the return amount.", true);
        if (amt > left + 0.001) return toast(`The return cannot be more than ₱ ${peso(left)}.`, true);
        const b = $("#rtSave", m.el); b.disabled = true;
        const items = ls.map((l) => l.item || l.desc).join(", ");
        const { error } = await sb.rpc("record_return", { p_invoice: inv.id, p_amount: amt, p_date: $("#rtDate", m.el).value || null, p_items: items.slice(0, 300),
          p_qty: ls.reduce((s, l) => s + l.pcs, 0), p_note: $("#rtNote", m.el).value.trim() || null, p_lines: ls, p_kind: kind(), p_boxes: ls.reduce((s, l) => s + l.boxes, 0) });
        if (error) { b.disabled = false; return fail(error, /record_return|p_lines/.test(error.message || "") ? "Run the database update 022_update_2_9.sql first" : "Could not save the return"); }
        m.close(); toast(isAdmin() ? "Return saved and taken off the invoice." : "Return saved. It waits for the Director's approval."); V.invoice(id);
      };
      setTimeout(() => $(".rtI", m.el)?.focus(), 50);
    };
    // 2.9: unlink one link (it stays in the list as UNLINKED, and its amount is available again)
    $$("[data-unlink]").forEach((b) => (b.onclick = async () => {
      const l = links.find((x) => x.id === b.dataset.unlink);
      if (!l || !(await E.confirmBox(`Unlink receipt <b>${esc(l.payments_received?.receipt_no || "")}</b> (₱ ${peso(l.amount)}) from ${esc(inv.invoice_no)}? The amount becomes available to link again.`, { ok: "Unlink" }))) return;
      b.disabled = true;
      const { error } = await sb.rpc("unlink_payment", { p_link: l.id });
      if (error) { b.disabled = false; return fail(error, "Could not unlink the payment"); }
      toast("Payment unlinked. Its amount is available again."); V.invoice(id);
    }));
    // 2.9: link a payment of this customer that still has an amount available; only what the invoice needs is taken
    if ($("#ivLink")) $("#ivLink").onclick = async () => {
      const { data: av, error } = await sb.from("payment_available").select("*").eq("customer_id", inv.customer_id).gt("available", 0).order("paid_date");
      if (error) return fail(error, "Could not load the payments");
      const opts = av || [];
      const m = E.modal(`Link a Payment — ${inv.invoice_no}`, opts.length
        ? `<p class="muted" style="margin-top:0">Choose the payment of ${esc(fullName(inv))} that paid this invoice. It still needs <b>₱ ${peso(need)}</b> from a linked payment; only that is taken and the rest of the payment stays available.</p>
          <div class="pay-free">All payments of this customer with money left (any date): ${opts.length} · <b>₱ ${peso(opts.reduce((t, r) => t + num(r.available), 0))}</b> ready for invoices.</div>
          <div class="lp-pick">${opts.map((p) => `<div class="lp-opt" data-pay="${p.id}"><b>${esc(p.receipt_no || "")}</b><span>${mdy(p.paid_date)}</span><b>₱ ${peso(p.amount)}</b>
            <small>Available to link: <b>₱ ${peso(p.available)}</b>${num(p.linked) > 0 ? ` (₱ ${peso(p.linked)} already linked to other invoices)` : ""}</small>
            <div class="lp-amt"><label for="lpA${p.id}">Amount to link (₱)</label><input type="number" id="lpA${p.id}" min="0.01" step="0.01" inputmode="decimal" value="${Math.min(num(p.available), need).toFixed(2)}">
              <button type="button" class="btn small primary" data-go="${p.id}">${ic("check")} Link</button></div></div>`).join("")}</div>`
        : `<div class="empty">No payment of ${esc(fullName(inv))} has an amount left to link: every payment is fully linked. Record the payment first.</div>`);
      $$("[data-go]", m.el).forEach((b) => (b.onclick = async () => {
        const p = opts.find((x) => x.id === b.dataset.go), amt = num($(`#lpA${p.id}`, m.el).value);
        if (!(amt > 0)) return toast("Enter the amount to link.", true);
        if (amt > num(p.available) + 0.004) return toast(`Only ₱ ${peso(p.available)} of ${p.receipt_no} is available.`, true);
        if (amt > need + 0.004) return toast(`This invoice needs only ₱ ${peso(need)}.`, true);
        b.disabled = true;
        const { error: e2 } = await sb.rpc("link_payment", { p_payment: p.id, p_invoice: inv.id, p_amount: amt });
        if (e2) { b.disabled = false; return fail(e2, /link_payment|payment_links/.test(e2.message || "") ? "Run the database update 022_update_2_9.sql first" : "Could not link the payment"); }
        m.close(); toast(`₱ ${peso(amt)} of ${p.receipt_no} linked to this invoice.`); V.invoice(id);
      }));
    };
    E.setRecords(`Invoice: ${inv.invoice_no}`);
  };
  // The invoice print. links: the payments linked to it (2.9), listed with the amount each one paid.
  function invoicePage(inv, links = [], deds = []) {
    const bal = num(inv.balance);
    const off = deds.reduce((t, m) => t + num(m.request_amount), 0), corrected = Math.max(0, num(inv.total_amount) - off);
    // 3.14: a return or credit memo taken off this invoice: the invoice shows what was taken off and the corrected amount
    const fix = deds.length ? box("Corrected Invoice", `<table class="ptl"><thead><tr><th>Taken Off By</th><th>Date</th><th>Type</th><th class="num">Amount (₱)</th></tr></thead><tbody>
        <tr><td colspan="3"><b>Original Invoice Amount</b></td><td class="num"><b>${peso(inv.total_amount)}</b></td></tr>
        ${deds.map((m) => `<tr><td>${esc(m.memo_no || "")}</td><td>${esc(mdy(m.approved_at || m.memo_date))}</td><td>${m.is_return ? "RETURN" : m.requested_action === "discount" ? "DISCOUNT" : "CREDIT MEMO"}</td><td class="num">− ${peso(m.request_amount)}</td></tr>`).join("")}
        <tr><td colspan="3"><b>Corrected Invoice Amount</b></td><td class="num"><b>${peso(corrected)}</b></td></tr></tbody></table>
        <div class="pcell"><div class="pl">Corrected Amount in Words</div><div class="pv words">${esc(words(corrected))}</div></div>`) : "";
    return `${printHead(deds.length ? "INVOICE (CORRECTED)" : "INVOICE", `<img src="${E.pdf417DataUrl("EMONINV|" + inv.invoice_no)}" alt="" class="ph-bar"><div class="mono">${esc(inv.invoice_no)}</div>`)}
      ${box("Customer", `<div class="pgrid2">${cell("Customer Name", fullName(inv))}${cell("Account No", inv.account_no)}</div>`)}
      ${box("Invoice", `<div class="prow3">${cell("Invoice No", inv.invoice_no)}${cell("Invoice Date", mdy(inv.invoice_date))}${cell("Total Boxes", inv.total_boxes)}</div>
        <div class="prow3">${cell("Total Pcs", inv.total_pcs)}${cell("Terms of Payment", inv.payment_terms || "—")}${cell("Due Date", mdy(inv.due_date) || "—")}</div>
        ${inv.po_number ? `<div class="pcell"><div class="pl">PO Number</div><div class="pv">${esc(inv.po_number)}</div></div>` : ""}
        <div class="pcell"><div class="pl">Amount in Words</div><div class="pv words">${esc(words(inv.total_amount))}</div></div>`)}
      ${fix}
      ${box("Payment", `<div class="pgrid2">${cell("Payment Status", ({ paid: "PAID", partial: "PARTIAL PAYMENT", unpaid: "UNPAID" }[inv.pay_status] || String(inv.pay_status || "").toUpperCase()) + (isOverdue(inv) ? ` · OVERDUE ${daysOver(inv)} DAY(S)` : "") + (bal < 0 ? " (OVERPAID)" : ""))}${cell("Total Amount (₱)", peso(inv.total_amount))}${num(inv.amount_returned) > 0 ? cell("Returned (₱)", peso(inv.amount_returned)) : ""}${cell("Paid (₱)", peso(inv.amount_paid))}${cell("Balance (₱)", peso(bal))}</div>
        ${links.length ? `<table class="ptl"><thead><tr><th>Linked Payment (Receipt No)</th><th>Date Paid</th><th class="num">Amount Linked (₱)</th></tr></thead><tbody>
          ${links.map((l) => `<tr><td>${esc(l.payments_received?.receipt_no || "")}</td><td>${mdy(l.payments_received?.paid_date)}</td><td class="num">${peso(l.amount)}</td></tr>`).join("")}</tbody></table>` : ""}`)}
      ${sigs("Received by (Customer Signature) / Date", `Prepared by: ${esc(inv.created_by_name || "")}`)}`;
  }

  // ======================================================================
  // 3. Payment
  // ======================================================================
  const PAY_COLS = [
    { label: "Receipt No", get: (r) => r.receipt_no }, { label: "Date Paid", get: (r) => mdy(r.paid_date) },
    { label: "Account No", get: (r) => r.customers?.account_no || "" }, { label: "Customer", get: (r) => fullName(r.customers || {}) },
    { label: "Method", get: (r) => METHOD[r.method] || r.method }, { label: "Reference", get: (r) => r.reference_no || "" },
    { label: "Amount (₱)", key: "amount", num: true, get: (r) => peso(r.amount) }, { label: "Verified By", get: (r) => r.created_by_name || "" }
  ];
  V.payments = async () => {
    E.shell("payments", "Payment", `
      <div class="btnrow">${E.canWrite("payments") || E.canWrite("invoices") ? `<a class="btn primary" href="#newpayment">+ Record Payment</a>` : ""}</div><div id="pyRes">${busy()}</div>`,
      "All payments received. Each payment gets a receipt number like <b>A-2026-1003-001</b> and a printable acknowledgment.");
    const { data, error } = await sb.from("payments_received").select("*, customers(first_name,last_name,account_no)").order("created_at", { ascending: false }).limit(2000);
    if (error) return fail(error, "Could not load payments");
    const rows = data || [];
    $("#pyRes").innerHTML = E.grid({ cols: PAY_COLS, rows, onRow: true, foot: { amount: peso(rows.reduce((s, r) => s + num(r.amount), 0)) }, empty: "No payments yet." });
    E.bindGrid($("#pyRes"), rows, (r) => (location.hash = "payment/" + r.id));
    E.setRecords(`Payments: ${rows.length}`);
  };

  V.newpayment = async (custId) => {
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
              <span>For</span><span>The customer's account (pays the oldest invoices first)</span>
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
</div></fieldset>
          <fieldset class="opt"><legend>Notes</legend><input type="text" id="npNotes" placeholder="Optional"></fieldset>
        </div>
        <div class="wfoot"><button type="button" class="btn" id="npCancel">Cancel</button><button type="submit" class="btn primary">Submit Payment</button></div>
      </form>`);
    let cust = null;
    customerPicker($("#npCust"), { statuses: ["active", "suspended", "closed"], onPick: (c) => (cust = c), preset: (await getCustomer(custId)) || undefined });
    const methodUi = () => { const m = $("#npMethod").value; $$(".npb").forEach((x) => (x.hidden = m === "cash")); };
    $("#npMethod").onchange = methodUi; methodUi();
    $("#npAmt").oninput = () => ($("#npWords").textContent = words($("#npAmt").value));
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
        customer_id: cust.id, amount: amt, method: m, paid_date: $("#npDate").value || isoToday(),
        bank_name: m === "cash" ? null : $("#npBank").value.trim() || null, bank_account: m === "cash" ? null : $("#npAcct").value.trim() || null,
        reference_no: m === "cash" ? null : $("#npRef").value.trim(), notes: $("#npNotes").value.trim() || null
      }).select().single();
      if (error) { E.setBusy(e.target, false); return fail(error, "Could not record the payment"); }
      let failed = await uploadRecords("payment", p.id, "receipt", filesOf("npRcpt"));
      if (failed) toast(`${failed} file(s) failed to upload.`, true);
      location.hash = `payment/${p.id}/done`;
    };
  };

  V.payment = async (id, extra) => {
    E.shell("payment", "Payment", busy());
    const { data: p } = await sb.from("payments_received").select("*, customers(*)").eq("id", id).maybeSingle();
    if (!p) { $("#main").innerHTML = `<div class="empty">Payment not found. <a href="#payments">Back to Payments</a></div>`; return; }
    // 2.9: the invoices this payment is linked to (update 022), and what is still available to link
    const [att, lk] = await Promise.all([attachmentsOf("payment", id),
      sb.from("payment_links").select("*, customer_invoices(invoice_no)").eq("payment_id", id).is("removed_at", null).order("linked_at")]);
    const links = lk.data || [], linked = links.reduce((s, l) => s + num(l.amount), 0);
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
        <span>Description</span><span>PAYMENT RECEIVED</span>
        <span>Verified By</span><span>${esc(p.created_by_name || "")}</span></div></div>
      ${lk.error ? "" : `<div class="linked-pays"><div class="lp-head"><b>Linked to Invoices</b></div>
        ${links.length ? links.map((l) => `<div class="lp-row"><a href="#invoice/${l.invoice_id}"><b>${esc(l.customer_invoices?.invoice_no || "")}</b></a><span>Linked ${esc(E.dateTime(l.linked_at))}${l.linked_by_name ? ` by ${esc(l.linked_by_name)}` : ""}</span><b>₱ ${peso(l.amount)}</b><span class="pill active">LINKED</span></div>`).join("")
          : `<div class="empty small">Not linked to an invoice: it pays the customer's oldest invoices first. Link it on the invoice page (Link a Payment).</div>`}
        <div class="lp-sum"><span>Available to link</span><b>₱ ${peso(num(p.amount) - linked)}</b></div></div>`}
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
        <div class="prow3">${cell("Bank", p.bank_name)}${cell("Deposit Account", p.bank_account)}${cell("Description", "PAYMENT RECEIVED")}</div>
        <div class="pcell"><div class="pl">Amount in Words</div><div class="pv words">${esc(words(p.amount))}</div></div>`)}
      <p class="pdecl">This acknowledges that ${esc(C.company.name)} has received the payment above. Receipt No ${esc(p.receipt_no)}.</p>
      <div class="soa-sys">This is a system-generated receipt. No signature is required.</div>`;
  }

  // ======================================================================
  // 4. Credit Memo (customer complaint)
  // ======================================================================
  // 2.9: the kinds of return (RETURN OF ITEMS brings goods back to the warehouse)
  const RET_KIND = { return: "Return of Items", price_less: "Price Less", damage: "Damage", other: "Others" };
  const WAREHOUSE = { not_received: "NOT RECEIVED", received: "RECEIVED AT WAREHOUSE" };
  const MEMO_COLS = [
    { label: "Report No", get: (r) => r.memo_no }, { label: "Date", get: (r) => mdy(r.memo_date) },
    { label: "Customer", get: (r) => fullName(r.customers || {}) }, { label: "Article", get: (r) => r.article || "" },
    { label: "Defect", get: (r) => (r.is_return ? "Return" : DEFECT[r.defect_category] || "") }, { label: "Request", get: (r) => (r.is_return ? `Return · ${r.po_number || ""}` : ACTION[r.requested_action] || "") },
    { label: "Amount (₱)", key: "request_amount", num: true, get: (r) => peso(r.request_amount) }, { label: "Status", html: (r) => pill(r.status) }
  ];
  // 3.13: the customer's Overdue, Returns and Credit Memo histories (screen and print); text: the status in words for the print
  const memoState = (m) => (m.status === "pending" ? "WAITING FOR APPROVAL" : m.status === "rejected" ? "REJECTED" : m.status === "paid" ? "PAID" : "APPROVED");
  const MEMO_STATUS_COL = { label: "Status", html: (r) => pill(r.status === "pending" ? "pending" : r.status === "rejected" ? "rejected" : "approved", memoState(r)), text: memoState };
  const OD_HIST = [{ label: "Invoice No", get: (r) => r.invoice_no }, { label: "Invoice Date", get: (r) => mdy(r.invoice_date) }, { label: "Due Date", get: (r) => mdy(r.due_date) },
    { label: "Days Overdue", num: true, get: (r) => String(daysOver(r)) }, { label: "Amount (₱)", num: true, get: (r) => peso(r.total_amount) }, { label: "Balance (₱)", num: true, get: (r) => peso(r.balance) }];
  const RET_HIST = [{ label: "Date", get: (r) => mdy(r.memo_date) }, { label: "Return No", get: (r) => r.memo_no }, { label: "Invoice No", get: (r) => r.po_number || "" },
    { label: "Qty Box", num: true, get: (r) => String(retLines(r).reduce((t, l) => t + num(l.boxes), 0)) }, { label: "Total Amount (₱)", num: true, get: (r) => peso(r.request_amount) },
    MEMO_STATUS_COL];
  const CM_HIST = [{ label: "Date", get: (r) => mdy(r.memo_date) }, { label: "Report No", get: (r) => r.memo_no }, { label: "Request", get: (r) => ACTION[r.requested_action] || "" },
    { label: "Invoice No", get: (r) => r.po_number || "" }, { label: "Amount (₱)", num: true, get: (r) => peso(r.request_amount) },
    MEMO_STATUS_COL];
  V.creditmemos = async () => {
    E.shell("creditmemos", "Credit Memo", `${E.eoTabs("creditmemos")}
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
              <label for="cmQty">Qty</label><input type="number" id="cmQty" min="0" step="1" value="0">
              <label for="cmPDate">Purchase Date</label><input type="date" id="cmPDate">
            </div></div></fieldset>
          <fieldset class="opt"><legend>Serial No of Issue Boxes (up to ${SN_MAX})</legend>
            <div class="sn-grid">${Array.from({ length: SN_MAX }, (_, i) => `<label><small>Box ${i + 1}</small><input type="text" class="cm-sn" maxlength="40" aria-label="Serial No of box ${i + 1}"></label>`).join("")}</div></fieldset>
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
        article: v("cmArt") || null, brand: v("cmBrand") || null, style: v("cmStyle") || null, batch_no: v("cmBatch") || null, serial_no: $$(".cm-sn").map((x) => x.value.trim().replace(/,/g, " ")).filter(Boolean).join(", ") || null,
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
        <span>Request</span><span>${m.is_return ? `Return of invoice ${m.invoice_id ? `<a href="#invoice/${m.invoice_id}">${esc(m.po_number || "")}</a>` : esc(m.po_number || "")}` : esc(ACTION[m.requested_action])}${m.rate > 0 ? ` (₱${peso(m.rate)} / pc)` : ""}</span>
        <span>Requested Amount</span><b>₱ ${peso(m.request_amount)}</b>
        <span>Assigned By</span><span>${esc(m.assigned_by || "—")}</span><span>Inspection Notes</span><span>${esc(m.inspection_notes || "—")}</span>
        <span>Factory Status</span><span>${esc(m.factory_status || "—")}</span>
        <span>Approved By</span><span>${esc(m.approved_by_name || "—")} ${m.approved_at ? mdy(m.approved_at) : ""}</span>
        <span>Paid / Settled</span><span>${m.paid_at ? `${esc(m.paid_by_name || "")} ${mdy(m.paid_at)}` : "—"}</span></div></div>
      ${m.is_return ? returnBox(m) : ""}
      <div class="docgrid">${docCard({ key: "memo", title: `${m.is_return ? "Return" : "Credit Memo"} ${m.memo_no}`, tag: m.is_return ? "System Generated" : undefined, sub: `₱ ${peso(m.request_amount)} · ${mdy(m.memo_date)}`, ownerType: "credit_memo", ownerId: m.id, att, print: () => E.openPreview(`${m.is_return ? "Return" : "Credit Memo"} ${m.memo_no}`, m.is_return ? returnPage(m) : [memoPage(m)]),
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
    if ($("#rtRecv")) $("#rtRecv").onclick = async (e) => {
      if (!(await E.confirmBox(`Mark the items of <b>${esc(m.memo_no)}</b> as RECEIVED at the warehouse?`, { ok: "Received" }))) return;
      e.target.disabled = true;
      const { error } = await sb.rpc("return_received", { p_memo: m.id });
      if (error) { e.target.disabled = false; return fail(error, "Could not mark the return received"); }
      toast("Return received at the warehouse."); V.creditmemo(m.id);
    };
    $$("[data-a]").forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      const r = await sb.rpc("credit_memo_action", { p_id: m.id, p_action: b.dataset.a, p_note: $("#cmNote").value.trim() || null });
      if (r.error) { b.disabled = false; return fail(r.error, "Could not update the credit memo"); }
      toast(`${m.memo_no} updated.`); V.creditmemo(m.id);
    }));
    E.setRecords(`Credit memo: ${m.memo_no}`);
  };
  // 2.9: a return's items (up to 20 lines) with totals, and the warehouse status (RETURN OF ITEMS only).
  const retLines = (m) => (Array.isArray(m.return_lines) && m.return_lines.length ? m.return_lines
    : [{ item: m.serial_no || "", desc: "", boxes: m.return_boxes || 0, pcs: m.qty || 0, amount: num(m.request_amount) }]);
  function returnBox(m) {
    const ls = retLines(m), can = (E.canWrite("invoices") || E.canWrite("creditmemos")) && m.warehouse_status === "not_received" && m.status !== "rejected";
    return `<div class="linked-pays"><div class="lp-head"><b>Returned Items · ${esc(RET_KIND[m.return_kind] || "Return of Items")}</b>
        ${m.warehouse_status ? `<span class="pill ${m.warehouse_status === "received" ? "active" : "pending"}">${WAREHOUSE[m.warehouse_status]}</span>` : `<span class="pill">NO GOODS RETURNED</span>`}</div>
      <div class="grid-wrap"><table class="grid"><thead><tr><th>#</th><th>Item / Serial No</th><th>Description</th><th class="num">Boxes</th><th class="num">Pcs</th><th class="num">Amount (₱)</th></tr></thead><tbody>
        ${ls.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.item || "")}</td><td>${esc(l.desc || "")}</td><td class="num">${num(l.boxes)}</td><td class="num">${num(l.pcs)}</td><td class="num">${peso(l.amount)}</td></tr>`).join("")}</tbody>
        <tfoot><tr><td colspan="3">TOTAL</td><td class="num">${ls.reduce((s, l) => s + num(l.boxes), 0)}</td><td class="num">${ls.reduce((s, l) => s + num(l.pcs), 0)}</td><td class="num">${peso(m.request_amount)}</td></tr></tfoot></table></div>
      ${m.warehouse_status === "received" ? `<small class="muted">Received at the warehouse ${esc(E.dateTime(m.warehouse_at))}${m.warehouse_by_name ? ` by ${esc(m.warehouse_by_name)}` : ""}.</small>` : ""}
      ${can ? `<div class="btnrow"><button type="button" class="btn ok" id="rtRecv">${ic("check")} Mark Received at Warehouse</button></div>` : ""}</div>`;
  }
  // The return's own printed form (system generated, in the company form style).
  function returnPage(m) {
    const c = m.customers, ls = retLines(m), sign = memoApproved(m) ? approvedBy(m.approved_by, m.approved_by_name, m.approved_at) : null;
    const wh = m.warehouse_status ? WAREHOUSE[m.warehouse_status] : "NO GOODS RETURNED";
    const sum = (k) => ls.reduce((s2, l) => s2 + num(l[k]), 0);
    return E.pagedDoc({
      head: printHead("RETURN", `<img src="${E.pdf417DataUrl("EMONCM|" + m.memo_no)}" alt="" class="ph-bar"><div class="mono">${esc(m.memo_no)}</div>`),
      contHead: printHead(`RETURN ${m.memo_no} (CONTINUED)`, ""),
      top: `${box("Customer", `<div class="pgrid2">${cell("Customer Name", fullName(c))}${cell("Account No", c.account_no)}${cell("Invoice No", m.po_number)}${cell("Return Date", mdy(m.memo_date))}</div>`)}
        ${box("Return", `<div class="pgrid2">${cell("Kind of Return", (RET_KIND[m.return_kind] || "Return of Items").toUpperCase())}${cell("Status", ({ pending: "WAITING FOR APPROVAL", approved: "APPROVED · TAKEN OFF THE INVOICE", paid: "APPROVED · SETTLED", rejected: "NOT APPROVED" }[m.status] || String(m.status).toUpperCase()))}
          ${cell("Warehouse", wh + (m.warehouse_status === "received" && m.warehouse_at ? ` · ${mdy(m.warehouse_at)}` : ""))}${cell("Recorded By", m.created_by_name || "")}</div>`)}`,
      boxTitle: "Returned Items", thead: `<tr><th>#</th><th>Item / Serial No</th><th>Description</th><th class="num">Boxes</th><th class="num">Pcs</th><th class="num">Amount (PHP)</th></tr>`,
      rows: ls, rowHtml: (l, i) => `<tr><td>${i + 1}</td><td>${esc(l.item || "")}</td><td>${esc(l.desc || "")}</td><td class="num">${num(l.boxes)}</td><td class="num">${num(l.pcs)}</td><td class="num">${peso(l.amount)}</td></tr>`,
      totalRow: `<tr class="ptl-tot"><td colspan="3">TOTAL RETURNS</td><td class="num">${sum("boxes")} BOX</td><td class="num">${sum("pcs")} PCS</td><td class="num">${peso(m.request_amount)}</td></tr>`,
      bottom: `<div class="pcell"><div class="pl">Amount in Words</div><div class="pv words">${esc(words(m.request_amount))}</div></div>${m.inspection_notes ? cell("Note", m.inspection_notes) : ""}
        <p class="pdecl">The amount above is taken off invoice ${esc(m.po_number || "")} and the customer's balance once approved.${m.warehouse_status ? " The returned items are checked and received at the warehouse." : ""}</p>
        ${sigs("Received by (Warehouse) &nbsp; / &nbsp; Date", sign ? "Approved by" : "Approved by (Signature) &nbsp; / &nbsp; Date", sign)}`,
      caps: { single: 12, first: 14, next: 26, last: 12 }
    });
  }
  // A credit memo the Director approved is printed with the Director's signature on "Approval Signature".
  const memoApproved = (m) => ["approved", "paid"].includes(m.status) && !!(m.approved_by || m.approved_by_name);
  // 3.18: the serial numbers of the issue boxes (up to SN_MAX) are kept in serial_no, separated by commas
  const SN_MAX = 20;
  const serialsOf = (m) => String(m.serial_no || "").split(/\s*,\s*/).filter(Boolean);
  function memoPage(m) {
    const c = m.customers;
    const sign = memoApproved(m) ? approvedBy(m.approved_by, m.approved_by_name, m.approved_at) : null;
    const sns = serialsOf(m);
    const tick = (on, label) => `<div class="cx-tick"><span class="qc-box${on ? " on" : ""}"></span>${esc(label)}</div>`;
    const ticks = (map, key, text) => Object.entries(map).map(([k, v]) => tick(key === k, key === k ? text(k, v) : v)).join("");
    return `${printHead("CREDIT MEMO", `<img src="${E.pdf417DataUrl("EMONCM|" + m.memo_no)}" alt="" class="ph-bar"><div class="mono">${esc(m.memo_no)}</div>`)}
      ${cxTop([["Memo Date", mdy(m.memo_date)], ["Credit Memo No", m.memo_no], ["Purchase Date", mdy(m.purchase_date)]])}
      ${cxSec("Customer")}${cxKv([["Customer Name", fullName(c).toUpperCase()], ["Account No", c.account_no], ["Purchase Order", m.po_number], ["Payment Reference", m.payment_ref]])}
      ${cxSec("Goods")}${cxKv([["Article", m.article], ["Brand", m.brand], ["Style", m.style], ["Batch No", m.batch_no], ["Qty", m.qty]])}
      ${sns.length ? `${cxSec("Issue Boxes · Serial No", `${sns.length} box${sns.length === 1 ? "" : "es"}`)}<div class="cx-sn">${Array.from({ length: Math.ceil(sns.length / 5) * 5 }, (_, i) => `<div><small>${i + 1}</small><b>${val(sns[i])}</b></div>`).join("")}</div>` : ""}
      ${cxSec("Customer Complaint")}
      <div class="cx-ticks"><div><small>Defect</small>${ticks(DEFECT, m.defect_category, (k, v) => (m.defect_detail ? `${v}: ${m.defect_detail}`.toUpperCase() : v))}</div>
        <div><small>Customer Request</small>${ticks(ACTION, m.requested_action, (k, v) => (k === "discount" && m.rate > 0 ? `${v} ${peso(m.rate)} PHP` : v))}</div></div>
      <div class="cx-amt"><div><small>Credit Amount (PHP)</small><b>${esc(peso(m.request_amount))}</b>${m.rate > 0 ? `<span>${esc(`${m.qty} × ${peso(m.rate)}`)}</span>` : ""}</div>
        <div><small>Amount in Words</small><span class="words">${esc(words(m.request_amount))}</span></div></div>
      ${cxSec("Warehouse Check", "Office use only")}${cxKv([["Assigned By", m.assigned_by], ["Status", (m.factory_status || "").toUpperCase()], ["Inspection Notes", m.inspection_notes, "wide"]])}
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
    if (/^EMONQCK?\|/i.test(t) && (await E.openScanned(t)) !== false) { done(); return; } // a QC form code opens that form (if there is none, the search goes on) // a typed or pasted QC form code opens the (locked) QC form
    const [cs, iv, py, vo, em, qc, cv] = await Promise.all([
      H("customers") ? sb.from("customers").select("*").neq("status", "closed").or(`first_name.ilike.%${w}%,last_name.ilike.%${w}%,account_no.ilike.%${w}%,public_id.ilike.%${w}%,business_name.ilike.%${w}%,phone.ilike.%${w}%`).limit(100) : none,
      H("invoices") ? sb.from("invoice_balances").select("*").neq("customer_status", "closed").or(`invoice_no.ilike.%${w}%,po_number.ilike.%${w}%`).limit(50) : none,
      H("payments") ? sb.from("payments_received").select("*, customers(first_name,last_name,account_no,status)").or(`receipt_no.ilike.%${w}%,reference_no.ilike.%${w}%`).limit(50) : none,
      H("billing") ? sb.from("pay_vouchers").select("*, pay_companies(name)").or(`voucher_no.ilike.%${w}%,reference_no.ilike.%${w}%,purpose.ilike.%${w}%`).limit(30) : none,
      H("employees") ? sb.from("employees").select("*").or(`first_name.ilike.%${w}%,last_name.ilike.%${w}%,employee_no.ilike.%${w}%,email.ilike.%${w}%`).limit(30) : none,
      isStaff() && H("eooffice") ? sb.from("qc_tests").select("*").or(`qc_no.ilike.%${w}%,serial_no.ilike.%${w}%,item.ilike.%${w}%,brand.ilike.%${w}%,batch.ilike.%${w}%`).limit(30) : none,
      isStaff() && H("eooffice") ? sb.from("collection_vouchers").select("*").or(`cv_no.ilike.%${w}%,received_from.ilike.%${w}%,reference_no.ilike.%${w}%`).limit(30) : none
    ]);
    done();
    if (!$("#fdRes")) return; // navigated away
    const ws = t.toLowerCase().split(/\s+/);
    const custs = (cs.data || []).filter((c) => ws.every((x) => `${fullName(c)} ${c.account_no || ""} ${c.public_id} ${c.business_name || ""} ${c.phone || ""}`.toLowerCase().includes(x)));
    const pays = (py.data || []).filter((p) => p.customers?.status !== "closed");
    const sections = [];
    if (H("customers")) sections.push(["Customers", custs, [{ label: "Account No", get: (r) => r.account_no }, { label: "Name", get: fullName }, { label: "Business", get: (r) => r.business_name || "" }, { label: "Phone", get: (r) => r.phone || "" }, { label: "Status", html: (r) => pill(r.status) }], (r) => "customer/" + r.id]);
    if (H("invoices")) sections.push(["Invoices", iv.data || [], INV_COLS, (r) => "invoice/" + r.id]);
    if (H("payments")) sections.push(["Payments", pays, PAY_COLS, (r) => "payment/" + r.id]);
    if ((vo.data || []).length) sections.push(["Payment Vouchers", vo.data, [{ label: "Voucher No", get: (r) => r.voucher_no }, { label: "Company", get: (r) => r.pay_companies?.name || "" }, { label: "Date", get: (r) => mdy(r.pay_date) }, { label: "PHP", num: true, get: (r) => r.amount_php == null ? "—" : peso(r.amount_php) }, { label: "BDT", num: true, get: (r) => r.amount_bdt == null ? "—" : peso(r.amount_bdt) }], (r) => "voucher/" + r.id]);
    if ((em.data || []).length) sections.push(["Employees", em.data, [{ label: "Employee No", get: (r) => r.employee_no }, { label: "Name", get: fullName }, { label: "Position", get: (r) => r.position || "" }, { label: "Status", html: (r) => pill(r.status) }], (r) => "employee/" + r.id]);
    if ((qc.data || []).length) sections.push(["QC Forms", qc.data, [{ label: "QC No", get: (r) => r.qc_no }, { label: "Serial No", get: (r) => r.serial_no || "" }, { label: "Item", get: (r) => r.item || "" }, { label: "Brand", get: (r) => r.brand || "" },
      { label: "Batch", get: (r) => r.batch || "" }, { label: "Score", num: true, get: (r) => (r.score == null ? "—" : `${r.score} / 100`) }, { label: "Result", get: (r) => E.qcVerdict?.(r.score) || "" }], (r) => "qc/" + r.id]);
    if ((cv.data || []).length) sections.push(["Collection Vouchers", cv.data, [{ label: "Voucher No", get: (r) => r.cv_no }, { label: "Date", get: (r) => mdy(r.cv_date) }, { label: "Received From", get: (r) => r.received_from },
      { label: "Amount (₱)", num: true, get: (r) => peso(r.amount) }], (r) => "collection/" + r.id]);
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
        <p class="muted">${isAdmin() ? "Your signature is printed by itself on every document you approve (applications, credit memos, projects and signature forms)."
          : "Upload your signature; the Director approves it, then your Signature Verification Form is ready."} Sign on white paper with dark ink, take a clear photo and upload it: the white paper is taken away for you.</p>
        <div class="btnrow"><label class="btn primary" for="mpSig">${ic("upload")} ${myPic ? "Change Signature" : "Upload Signature"}</label><input type="file" id="mpSig" accept="image/*" hidden data-save-now="preview">
          ${sp.signature_path ? `<button type="button" class="btn" id="mpSigForm">${ic("print")} Signature Verification Form</button><button type="button" class="btn danger" id="mpSigRm">${ic("trash")} Remove</button>`
            : `<button type="button" class="btn" id="mpSigBlank">${ic("print")} Blank Signature Verification Form</button>`}</div>
      </fieldset>
      ${isAdmin() ? "" : `<fieldset class="opt" id="mpDelBox"><legend>Delete My Account</legend>
        <p>Ask the Director to delete your E-Portal account. Your login, name, photo, signature and messages are deleted.
          Business records the law requires us to keep (such as invoices, receipts and payslips) stay, shown as <b>Deleted User</b>.
          <a href="/delete-account" target="_blank" rel="noopener">More about deleting an account</a> · <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a></p>
        <div class="btnrow"><button type="button" class="btn danger" id="mpDel">${ic("trash")} Request Account Deletion</button></div>
        <div id="mpDelDone"></div></fieldset>`}
      ${emp ? `<h3>My Payslip History</h3>
        <div class="tiles"><div class="tile"><div class="k">Payslips</div><div class="v">${slips.length}</div></div><div class="tile ok"><div class="k">Total Received (₱)</div><div class="v">₱ ${peso(netTotal)}</div></div></div>
        <div id="mpSlips">${E.grid({ cols: [{ label: "Payslip No", get: (r) => r.payslip_no }, { label: "Type", get: (r) => r.pay_type.toUpperCase() }, { label: "Period", get: (r) => new Date(r.period_month + "T00:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" }) }, { label: "Pay Date", get: (r) => mdy(r.pay_date) }, { label: "Net Pay (₱)", num: true, get: (r) => peso(r.net_pay) }], rows: slips, onRow: true, empty: "No salary or advance payments recorded yet." })}</div>` : ""}`;
    if (emp) E.bindGrid($("#mpSlips"), slips, (r) => (location.hash = "payslip/" + r.id));
    $("#mpPw").onclick = () => E.changePassword();
    // 2.4: the request goes to the Director's Contact Messages, who then deletes the account on Login Accounts
    if ($("#mpDel")) $("#mpDel").onclick = async () => {
      $("#mpDel").disabled = true;
      const ref = await E.requestDeletion(emp?.position);
      if (!ref) { $("#mpDel").disabled = false; return; }
      $("#mpDelDone").innerHTML = `<div class="hint ok">Request sent. Reference No <b class="mono">${esc(ref)}</b>. The Director will reply to ${esc(S.session.user.email)} and delete your account within 30 days.</div>`;
    };
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
      if (!e.target.files[0]) return;
      const f = await E.slimFile(e.target.files[0], "avatar"); // 2.2.2: a large phone photo is made small first
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
    docCard, bindDocCards, customerPicker, getCustomer, fullName, printHead, box, cell, sigs, sigCol, cxTop, cxSec, cxKv, uuid, cleanQ, idBox, METHOD,
    loadSignatures, approvedBy, signaturePic, pickSignature, sigPill, signatureFormPage, openSignatureForm, openBlankSignatureForm, editCustomer
  });
})();
