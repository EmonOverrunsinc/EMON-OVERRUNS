/* EMON OVERRUNS E-PORTAL — job applicant portal, 6 Community, 9 Order Letter, Verification (public),
   Messages (chat), Corrections, and the Add Correction / Delete (Director) tools used on every record
   (saved records are never edited; only the Director deletes, permanently). */
(function () {
  "use strict";
  const E = window.EO;
  const { sb, S, C, esc, peso, isoToday, mdy, $, $$, isAdmin, isStaff, pill, toast, fail, words, ic, busy } = E;
  const V = window.EO_VIEWS;
  const num = (v) => Number(v || 0);
  const fullName = (r) => `${r.first_name || ""} ${r.last_name || ""}`.trim();
  const meId = () => S.session?.user?.id;

  // Large phone photos are resized before upload (max 1600 px, JPEG).
  async function shrinkImage(file, max = 1600, quality = 0.85) {
    if (!/^image\/(jpeg|png|webp|bmp)$/i.test(file.type) || file.size < 400 * 1024) return file;
    try {
      const url = URL.createObjectURL(file);
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      URL.revokeObjectURL(url);
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      const g = c.getContext("2d");
      g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", quality));
      return blob && blob.size < file.size ? new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" }) : file;
    } catch (_) { return file; }
  }
  async function signedMap(paths) {
    const list = [...new Set(paths.filter(Boolean))];
    if (!list.length) return new Map();
    const { data } = await sb.storage.from("records").createSignedUrls(list, 3600);
    return new Map((data || []).filter((x) => x.signedUrl).map((x) => [x.path, x.signedUrl]));
  }
  function lightbox(url, name = "") {
    const m = E.modal(name || "Photo", `<div class="viewer-body"><img src="${esc(url)}" alt="${esc(name)}"></div>`,
      `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">${ic("download")} Open / Download</a><button type="button" class="btn primary" data-x>Close</button>`, { wide: true, cls: "viewer" });
    $("[data-x]", m.el).onclick = m.close;
  }
  const avatarOf = (c) => c.avatar_path ? `<img src="${esc(E.publicUrl("avatars", c.avatar_path))}" alt="">` : `<span>${esc(E.initials(c.full_name))}</span>`;

  // ======================================================================
  // Records are only added: Add Correction on every record (staff: Request Correction, approved by the Director).
  // Only the Director deletes a record, and then it is gone for good.
  // ======================================================================
  const F = (k, label, type = "text", opts) => ({ k, label, type, opts });
  const METHODS = [["cash", "Cash"], ["bank_transfer", "Bank Transfer"], ["online_transfer", "Online Transfer"], ["deposit", "Bank Deposit"]];
  // Details that can be corrected — must match editable_columns() in the database. Amounts, transaction dates and
  // record numbers are never corrected: a wrong money record is deleted by the Director and recorded again.
  const FIELDS = {
    customers: [F("first_name", "First Name"), F("last_name", "Last Name"), F("phone", "Phone"), F("email", "Email", "email"), F("address", "Full Address"), F("business_name", "Business Name"), F("business_start_date", "Business Start Date", "date"), F("facebook_name", "Facebook Name"), F("has_extra_facebook", "Has Additional Facebook Account", "bool"), F("extra_facebook_name", "Additional Facebook Name"), F("facebook_verified", "Facebook Verified", "bool"), F("credit_limit", "Credit Limit (₱)", "money")],
    customer_invoices: [F("purchase_date", "Purchase Date", "date"), F("po_number", "PO Number"), F("total_boxes", "Total Boxes", "int"), F("total_pcs", "Total Pcs", "int")],
    payments_received: [F("method", "Method", "select", METHODS), F("bank_name", "Bank Name"), F("bank_account", "Deposit Account"), F("reference_no", "Reference No"), F("notes", "Notes")],
    credit_memos: [F("payment_ref", "Payment Reference"), F("po_number", "Purchase Order"), F("article", "Article"), F("brand", "Brand"), F("style", "Style"), F("batch_no", "Batch No"), F("serial_no", "Serial No"), F("purchase_date", "Purchase Date", "date"),
      F("defect_category", "Defect Category", "select", [["fabric_damage", "Fabric Damage"], ["color_issue", "Color Issue"], ["wrong_box", "Wrong Box Delivered"], ["wrong_bundle", "Wrong Bundle"], ["other", "Other"]]), F("defect_detail", "Defect Details"),
      F("assigned_by", "Assigned By"), F("inspection_notes", "Inspection Notes", "textarea"), F("factory_status", "Factory Status", "textarea")],
    employees: [F("first_name", "First Name"), F("last_name", "Last Name"), F("position", "Position"), F("phone", "Phone"), F("address", "Address"), F("date_hired", "Date Hired", "date"), F("monthly_salary", "Monthly Salary (₱)", "money")],
    payslips: [F("method", "Method"), F("reference_no", "Reference No"), F("notes", "Notes")],
    projects: [F("title", "Title"), F("description", "Description", "textarea"), F("location", "Location"), F("start_date", "Start Date", "date"), F("end_date", "End Date", "date")],
    project_payments: [F("received_by", "Received By"), F("method", "Method"), F("reference_no", "Reference No"), F("notes", "Notes")],
    pay_companies: [F("name", "Company Name"), F("contact_person", "Contact Person"), F("contact", "Phone / Email"), F("address", "Address"), F("currency", "Currency", "select", [["PHP", "PHP"], ["BDT", "BDT"], ["BOTH", "PHP, BDT"]]), F("notes", "Notes")],
    pay_accounts: [F("account_name", "Account Name"), F("account_number", "Account Number"), F("bank_name", "Bank Name"), F("branch_name", "Branch"), F("notes", "Notes")],
    pay_vouchers: [F("purpose", "Purpose"), F("method", "Method"), F("reference_no", "Reference No"), F("notes", "Notes")],
    job_applications: [F("full_name", "Full Name"), F("phone", "Phone"), F("email", "Email", "email"), F("present_address", "Present Address"), F("permanent_address", "Permanent Address"), F("father_name", "Father's Name"), F("mother_name", "Mother's Name"), F("spouse_name", "Wife's / Husband's Name"), F("date_of_birth", "Date of Birth", "date"), F("birth_place", "Birth Place"), F("id_number", "BRC / NID / Passport No"), F("gender", "Gender"), F("religion", "Religion"), F("blood_group", "Blood Group"), F("apply_salary", "Expected Monthly Salary (₱)", "money"), F("apply_duty_hours", "Duty Hours"), F("apply_joining_date", "Joining Date", "date")],
    stock_bills: [F("supplier_bill_no", "Bill No"), F("batch_no", "Batch No"), F("shipment_no", "System Record No"), F("shipment_date", "Shipment Date", "date"), F("total_boxes", "Total Boxes", "int"), F("notes", "Notes")]
  };
  // Money records: their amounts and dates are not corrected (the Director deletes a wrong one and it is recorded again).
  const MONEY = ["customer_invoices", "payments_received", "credit_memos", "payslips", "pay_vouchers", "project_payments", "order_letters", "stock_bills", "stock_bill_entries"];
  // Records the Director can delete — must match deletable_table() in the database.
  const DELETABLE = ["customers", "customer_invoices", "payments_received", "credit_memos", "order_letters", "employees", "payslips", "projects", "project_payments", "pay_companies", "pay_accounts", "pay_vouchers", "job_applications", "job_positions", "stock_bills", "stock_bill_entries"];
  const TABLE_NAME = { customers: "Customer", customer_invoices: "Invoice", payments_received: "Payment", credit_memos: "Credit Memo", employees: "Employee", payslips: "Payslip", projects: "Project", project_payments: "Project Payment", pay_companies: "Billing Company", pay_accounts: "Billing Account", pay_vouchers: "Payment Voucher", job_applications: "Job Application", order_letters: "Order Letter", stock_bills: "E-Bill", stock_bill_entries: "Sales Report Line" };
  const ROUTE_OF = { customers: "customer", customer_invoices: "invoice", payments_received: "payment", credit_memos: "creditmemo", employees: "employee", payslips: "payslip", projects: "project", pay_companies: "paycompany", pay_vouchers: "voucher", job_applications: "jobapp", order_letters: "order", stock_bills: "stockbill" };
  // What can be changed on an order waiting for approval (see update_pending_order in the database).
  const ORDER_FIELDS = { subject: "Subject", details: "Details", resolution: "Resolution / Terms", order_date: "Order Date", amount: "Amount", first_due_date: "Due Date",
    installments: "Installments", installment_amount: "Installment Amount", installment_every: "Pay", closure_reason: "Reason for Closure", adjust_type: "Adjustment",
    release_date: "Released Date", price_per_box: "Price per Box (PHP)", exchange_rate: "Exchange Rate", release_php: "Total (PHP)", release_bdt: "Released Charge (BDT)",
    shipping_cost: "Shipping Fee (BDT)", shipping_bill_no: "Shipping Fee Receipt No" };
  const fieldLabel = (table, k) => (FIELDS[table] || []).find((f) => f.k === k)?.label || (table === "order_letters" && ORDER_FIELDS[k]) || k.replace(/_/g, " ");
  const showVal = (v) => (v === null || v === undefined || v === "" ? "(empty)" : typeof v === "boolean" ? (v ? "Yes" : "No") : typeof v === "object" ? JSON.stringify(v) : String(v));
  const changeList = (table, ch, prev) => Object.keys(ch || {}).map((k) => `${fieldLabel(table, k)}: ${showVal(prev?.[k])} → ${showVal(ch[k])}`).join("; ");

  function fieldInput(f, v) {
    const id = "ed_" + f.k;
    if (f.type === "bool") return `<span>${esc(f.label)}</span><label class="sw"><input type="checkbox" id="${id}" ${v ? "checked" : ""}> Yes</label>`;
    const lab = `<label for="${id}">${esc(f.label)}</label>`;
    if (f.type === "textarea") return `${lab}<textarea id="${id}" rows="3">${esc(v ?? "")}</textarea>`;
    if (f.type === "select") return `${lab}<select id="${id}">${f.opts.map(([k, l]) => `<option value="${k}" ${k === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    const t = { date: "date", money: "number", rate: "number", int: "number", email: "email" }[f.type] || "text";
    const step = { money: "0.01", rate: "0.0001", int: "1" }[f.type];
    const val = f.type === "date" ? String(v || "").slice(0, 10) : v ?? "";
    return `${lab}<input type="${t}" id="${id}" value="${esc(val)}" ${step ? `step="${step}" min="0"` : ""}>`;
  }
  function readField(f, root) {
    const el = $("#ed_" + f.k, root);
    if (f.type === "bool") return el.checked;
    const s = el.value.trim();
    if (f.type === "money" || f.type === "rate") return s === "" ? null : Number(s);
    if (f.type === "int") return s === "" ? null : Math.floor(Number(s));
    return s === "" ? null : s;
  }
  const same = (f, a, b) => {
    if (f.type === "money" || f.type === "rate" || f.type === "int") return (a == null || a === "" ? null : Number(a)) === (b == null ? null : Number(b));
    if (f.type === "bool") return !!a === !!b;
    if (f.type === "date") return String(a || "").slice(0, 10) === String(b || "");
    return String(a ?? "") === String(b ?? "");
  };

  // The saved record is not edited: a correction record is added with the new details and keeps the original ones.
  function correctRecord(table, row, label, reload) {
    const fields = FIELDS[table];
    if (!fields) return toast("This record cannot be corrected.", true);
    const admin = isAdmin();
    const m = E.modal(`${admin ? "Add Correction" : "Request Correction"} — ${label}`, `
      <div class="hint">The saved record is not edited. ${admin ? "A correction record is added" : "When the Director approves, a correction record is added"} with the new details, and the original details are kept with it.</div>
      <div class="fields wide edit-grid">${fields.map((f) => fieldInput(f, row[f.k])).join("")}</div>
      ${MONEY.includes(table) ? `<small class="muted">Amounts and transaction dates cannot be corrected. If they are wrong, ${admin ? "delete this record" : "ask the Director to delete this record"} and record it again.</small>` : ""}
      <label class="fl" for="edReason">Reason for the correction *</label><textarea id="edReason" rows="2" placeholder="e.g. The wrong phone number was typed"></textarea>`,
      `<button type="button" class="btn" data-x>Close</button><button type="button" class="btn primary" data-ok>${admin ? "Add Correction" : "Send for Approval"}</button>`, { wide: true });
    $("[data-x]", m.el).onclick = m.close;
    $("[data-ok]", m.el).onclick = async () => {
      const changes = {};
      for (const f of fields) { const v = readField(f, m.el); if (!same(f, row[f.k], v)) changes[f.k] = v; }
      if (!Object.keys(changes).length) return toast("Nothing was changed.", true);
      const reason = $("#edReason", m.el).value.trim();
      if (!reason) return toast("Write the reason for the correction.", true);
      const btn = $("[data-ok]", m.el); btn.disabled = true;
      const { data, error } = await sb.rpc("submit_change_request", { p_table: table, p_id: row.id, p_changes: changes, p_reason: reason, p_label: label });
      btn.disabled = false;
      if (error) return fail(error, admin ? "Could not add the correction" : "Could not send the correction");
      m.close();
      toast(admin ? `Correction ${data.request_no} added.` : `Correction ${data.request_no} sent to the Director for approval.`);
      if (reload) reload();
    };
  }
  // The Director deletes a record permanently, with its files. Nothing of it is shown afterwards.
  async function deleteRecord(table, row, label, afterDelete) {
    if (!isAdmin()) return;
    // A carried-out order letter is also undone (see undo_order in the database).
    const undo = table === "order_letters" && row.status === "applied" && row.stock_bill_id
      ? `<br><br>This Released Notice was carried out, so deleting it also <b>undoes it</b>: the e-bill goes back to SHIP, and its released date, released charge and shipping fee are removed.`
      : table === "order_letters" && row.status === "applied"
      ? `<br><br>This order was carried out, so deleting it also <b>undoes it</b>: the status goes back to what it was before the order (if no later order changed it again), and a charge or settlement adjustment is removed from the balance and the statements.` : "";
    if (!(await E.confirmBox(`Delete <b>${esc(label)}</b> permanently? It will be removed from the portal with its files and cannot be brought back.${undo}`, { title: "Delete Record", ok: "Delete", danger: true }))) return;
    const { data: paths, error } = await sb.rpc("delete_record", { p_table: table, p_id: row.id });
    if (error) return fail(error, "Could not delete");
    const files = [...new Set((paths || []).filter(Boolean))];
    if (files.length) await sb.storage.from("records").remove(files).then(() => {}, () => {});
    toast(`${label} deleted.`);
    if (afterDelete) afterDelete();
  }
  const RT = new Map();
  function recordTools(table, row, label, opts = {}) {
    if (!S.profile || !row) return "";
    const admin = isAdmin();
    const fix = !!FIELDS[table], del = admin && DELETABLE.includes(table);
    if (!fix && !del) return "";
    if (RT.size > 300) RT.clear();
    const id = "rt" + Math.random().toString(36).slice(2, 9);
    RT.set(id, { table, row, label, ...opts });
    return `<span class="rtools" data-rt="${id}">${fix ? `<button type="button" class="btn" data-rt-fix>${ic("edit")} ${admin ? "Add Correction" : "Request Correction"}</button>` : ""}${del ? `<button type="button" class="btn danger" data-rt-del>${ic("trash")} Delete</button>` : ""}</span>`;
  }
  function bindRecordTools(root = document) {
    $$("[data-rt]", root).forEach((w) => {
      const o = RT.get(w.dataset.rt); if (!o) return;
      const fx = $("[data-rt-fix]", w), dl = $("[data-rt-del]", w);
      if (fx) fx.onclick = (e) => { e.stopPropagation(); correctRecord(o.table, o.row, o.label, o.reload); };
      if (dl) dl.onclick = (e) => { e.stopPropagation(); deleteRecord(o.table, o.row, o.label, o.afterDelete || o.reload); };
    });
    $$("[data-rh]", root).forEach((el) => { const [t, id] = el.dataset.rh.split(":"); recordHistory(el, t, id); });
  }
  // Corrections added to one record (with requests still waiting), newest first. Director only.
  const rhBox = (table, id) => isAdmin() ? `<div class="rhist" data-rh="${esc(table)}:${esc(id)}" hidden></div>` : "";
  async function recordHistory(el, table, id) {
    const [done, reqs] = await Promise.all([
      sb.from("record_changes").select("*").eq("target_table", table).eq("target_id", id).order("created_at", { ascending: false }),
      sb.from("change_requests").select("*").eq("target_table", table).eq("target_id", id).order("created_at", { ascending: false })
    ]);
    if (!el.isConnected) return;
    const why = new Map((reqs.data || []).map((r) => [r.request_no, r.reason]));
    const rows = [
      ...(reqs.data || []).filter((r) => r.status === "pending").map((r) => ({ at: r.created_at, no: r.request_no, st: "pending", what: "Correction request", detail: changeList(table, r.changes, r.previous), why: r.reason, by: r.requested_by_name })),
      ...(done.data || []).map((r) => r.action === "file removed"
        ? { at: r.created_at, no: "", st: "removed", what: "File removed", detail: r.previous?.file || "", why: "", by: r.actor_name }
        : r.action === "order changed" ? { at: r.created_at, no: "", st: "changed", what: "Changed before approval", detail: changeList(table, r.changes, r.previous), why: "", by: r.actor_name }
        : { at: r.created_at, no: r.request_no || "", st: "approved", what: "Correction", detail: changeList(table, r.changes, r.previous), why: why.get(r.request_no) || "", by: r.actor_name })
    ];
    if (!rows.length) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = `<b>Corrections</b>${E.grid({ cols: [
      { label: "Date / Time", get: (r) => E.stamp(new Date(r.at)) }, { label: "Correction No", get: (r) => r.no }, { label: "Type", html: (r) => `${esc(r.what)} ${pill(r.st)}` },
      { label: "Original → Corrected", get: (r) => r.detail || "—" }, { label: "Reason", get: (r) => r.why || "" }, { label: "By", get: (r) => r.by || "" }], rows })}`;
  }

  // ======================================================================
  // Corrections (requests and the log) — the Director only
  // ======================================================================
  V.changes = async () => {
    if (!isAdmin()) { location.hash = "dashboard"; return; }
    E.shell("changes", "Corrections", `
      <div class="tabs" id="crF"><button type="button" class="on" data-f="pending">Waiting for Approval</button><button type="button" data-f="approved">Approved</button><button type="button" data-f="rejected">Rejected</button><button type="button" data-f="">All</button><button type="button" data-f="log">Correction Log</button></div>
      <div id="crRes">${busy()}</div>`,
      "Saved records are never edited. Employees send <b>corrections</b> (wrong details) here; <b>Approve</b> adds the correction record. Your own corrections are added straight away. Only you can see corrections.");
    const run = async (f) => {
      $("#crRes").innerHTML = busy();
      if (f === "log") {
        const { data, error } = await sb.from("record_changes").select("*").order("created_at", { ascending: false }).limit(500);
        if (error) return fail(error, "Could not load the correction log");
        const rows = data || [];
        $("#crRes").innerHTML = E.grid({ cols: [
          { label: "Date / Time", get: (r) => E.stamp(new Date(r.created_at)) }, { label: "Record", get: (r) => `${TABLE_NAME[r.target_table] || r.target_table}: ${r.target_label || ""}` },
          { label: "Original → Corrected", get: (r) => r.action === "file removed" ? `File removed: ${r.previous?.file || ""}` : changeList(r.target_table, r.changes, r.previous) },
          { label: "By", get: (r) => r.actor_name || "" }, { label: "Correction No", get: (r) => r.request_no || "" }], rows, empty: "No corrections yet." });
        return E.setRecords(`Corrections: ${rows.length}`);
      }
      let q = sb.from("change_requests").select("*").order("created_at", { ascending: false }).limit(300);
      if (f) q = q.eq("status", f);
      const { data, error } = await q;
      if (error) return fail(error, "Could not load corrections");
      const rows = data || [];
      $("#crRes").innerHTML = rows.length ? rows.map((r) => `<article class="cr-card st-${esc(r.status)}">
          <header><b class="mono">${esc(r.request_no)}</b>${pill(r.status)}<span>${esc(TABLE_NAME[r.target_table] || r.target_table)}: ${ROUTE_OF[r.target_table] ? `<a href="#${ROUTE_OF[r.target_table]}/${r.target_id}">${esc(r.target_label || "open record")}</a>` : esc(r.target_label || "")}</span><small>${esc(E.dateTime(r.created_at))} · by ${esc(r.requested_by_name || "")}</small></header>
          <div class="cr-reason"><b>Reason:</b> ${esc(r.reason)}</div>
          <table class="grid cr-diff"><thead><tr><th>Field</th><th>Original</th><th>Corrected</th></tr></thead><tbody>
            ${Object.keys(r.changes || {}).map((k) => `<tr><td>${esc(fieldLabel(r.target_table, k))}</td><td class="old">${esc(showVal(r.previous?.[k]))}</td><td class="new">${esc(showVal(r.changes[k]))}</td></tr>`).join("")}</tbody></table>
          ${r.status !== "pending" ? `<div class="cr-done">${r.status === "approved" ? "Approved" : "Rejected"} by ${esc(r.reviewed_by_name || "")} · ${esc(E.dateTime(r.reviewed_at))}${r.review_note ? " — " + esc(r.review_note) : ""}</div>`
            : `<div class="cr-act"><input type="text" placeholder="Note (optional)" data-note="${r.id}"><button type="button" class="btn ok" data-cr="${r.id}" data-a="approve">${ic("check")} Approve</button><button type="button" class="btn danger" data-cr="${r.id}" data-a="reject">Reject</button></div>`}
        </article>`).join("") : `<div class="empty">${f === "pending" ? "Nothing waiting for approval." : "Nothing here."}</div>`;
      $$("[data-cr]").forEach((b) => (b.onclick = async () => {
        const note = $(`[data-note="${b.dataset.cr}"]`).value.trim() || null;
        b.disabled = true;
        const { error: e2 } = await sb.rpc("review_change_request", { p_id: b.dataset.cr, p_action: b.dataset.a, p_note: note });
        if (e2) { b.disabled = false; return fail(e2, "Could not update the request"); }
        toast(b.dataset.a === "reject" ? "Request rejected." : "Approved — the correction was added to the record."); run(f); E.refreshBadge();
      }));
      E.setRecords(`Requests: ${rows.length}`);
    };
    $$("#crF button").forEach((b) => (b.onclick = () => { $$("#crF button").forEach((x) => x.classList.toggle("on", x === b)); run(b.dataset.f); }));
    run("pending");
  };

  // ======================================================================
  // Job applicant portal (new sign-ups that are not employees yet)
  // ======================================================================
  let applicantTimer = null;
  V.applicant = async () => {
    E.miniShell("Apply for a Job", busy());
    clearInterval(applicantTimer);
    // Once the application is approved the account becomes active: open the full portal.
    applicantTimer = setInterval(async () => {
      if (!$(".mini-content") || !S.session) return clearInterval(applicantTimer);
      const { data } = await sb.from("profiles").select("status").eq("id", meId()).maybeSingle();
      if (data?.status === "active") { clearInterval(applicantTimer); S.profile = null; toast("Your application was approved. Welcome!"); E.route(); }
    }, 60000);
    const [apps, pos] = await Promise.all([
      sb.from("job_applications").select("*").eq("profile_id", meId()).order("created_at", { ascending: false }),
      sb.from("job_positions").select("*").eq("is_open", true).order("title")
    ]);
    if (apps.error) { $("#main").innerHTML = `<div class="empty">Job applications are not available yet. Please try again later.</div>`; return; }
    const last = (apps.data || [])[0];
    if (last && last.status !== "rejected") return applicantStatus(last);
    applicantPositions(pos.data || [], last);
  };
  function applicantPositions(positions, rejected) {
    $("#main").innerHTML = `
      <section class="welcome-card"><h2>Welcome, ${esc(S.profile.full_name || "")}!</h2>
        <p>Your account is ready. To work with ${esc(C.company.name)}, choose a position below and fill in the job application. After you submit, download the application form, sign it, and bring it to the office. The Director approves it and gives you access to the portal.</p>
        ${rejected ? `<div class="banner closed">Your last application ${esc(rejected.application_no)} was not approved${rejected.review_note ? " (" + esc(rejected.review_note) + ")" : ""}. You may apply again.</div>` : ""}</section>
      <h3>Open Positions</h3>
      <div class="pos-grid">${positions.map((p) => `<article class="pos-card"><h4>${esc(p.title)}</h4><div class="pos-co">${esc(p.company_name)}</div>
          <div class="pos-meta">${num(p.monthly_salary) ? `<span>₱ ${peso(p.monthly_salary)} / month</span>` : ""}${p.duty_hours ? `<span>${esc(p.duty_hours)}</span>` : ""}</div>
          ${p.description ? `<p>${esc(p.description)}</p>` : ""}<button type="button" class="btn primary" data-apply="${p.id}">Apply Now</button></article>`).join("")}
        <article class="pos-card other"><h4>Other Position</h4><div class="pos-co">${esc(C.company.name)}</div><p>Apply for a position that is not listed.</p><button type="button" class="btn" data-apply="">Apply</button></article></div>`;
    $$("[data-apply]").forEach((b) => (b.onclick = () => applicationForm(positions.find((p) => p.id === b.dataset.apply) || null)));
  }

  const eduRow = (r = {}) => `<tr><td><input type="text" class="e1" value="${esc(r.exam || "")}" placeholder="e.g. SSC"></td><td><input type="text" class="e2" value="${esc(r.institute || "")}"></td><td><input type="text" class="e3" value="${esc(r.result || "")}"></td><td><input type="text" class="e4" value="${esc(r.year || "")}" inputmode="numeric"></td><td><button type="button" class="btn danger" aria-label="Remove row">✕</button></td></tr>`;
  const expRow = (r = {}) => `<tr><td><input type="text" class="x1" value="${esc(r.company || "")}"></td><td><input type="text" class="x2" value="${esc(r.position || "")}"></td><td><input type="text" class="x3" value="${esc(r.from || "")}" placeholder="2022"></td><td><input type="text" class="x4" value="${esc(r.to || "")}" placeholder="2024"></td><td><button type="button" class="btn danger" aria-label="Remove row">✕</button></td></tr>`;
  // The job application form (same fields as the printed company template). Once submitted it is not edited.
  function applicationForm(pos) {
    const v = (d = "") => esc(d ?? "");
    $(".band h1").textContent = "Job Application Form";
    $("#main").innerHTML = `
      <form class="window jaform" id="jaForm" novalidate><div class="wtitle">Job Application — ${esc(pos ? pos.title : "Other Position")}</div><div class="wbody">
        <fieldset class="opt"><legend>Position Applied For</legend><div class="formgrid">
          <div class="fields wide">
            ${pos ? `<span>Position</span><b>${esc(pos.title)}</b><span>Company</span><b>${esc(pos.company_name)}</b>`
              : `<label for="jaPos">Position *</label><input type="text" id="jaPos" placeholder="Position you are applying for">`}
            <label for="jaSal">Expected Monthly Salary (₱)</label><input type="number" id="jaSal" min="0" step="0.01" value="${v(pos ? pos.monthly_salary : "")}">
          </div>
          <div class="fields wide">
            <label for="jaHrs">Duty Hours</label><input type="text" id="jaHrs" value="${v(pos ? pos.duty_hours || "" : "")}">
            <label for="jaJoin">Joining Date</label><input type="date" id="jaJoin">
          </div></div></fieldset>
        <fieldset class="opt"><legend>Applicant</legend><div class="formgrid">
          <div class="fields wide">
            <label for="jaName">Full Name *</label><input type="text" id="jaName" value="${v(S.profile.full_name || "")}">
            <label for="jaPhone">Phone *</label><input type="tel" id="jaPhone">
            <label for="jaEmail">Email</label><input type="email" id="jaEmail" value="${v(S.session.user.email)}">
          </div>
          <div class="fields wide">
            <label for="jaPhoto">Photo *</label><input type="file" id="jaPhoto" accept="image/*">
            <span></span><div id="jaPhotoPrev" class="photo-prev">No photo</div>
          </div></div></fieldset>
        <fieldset class="opt"><legend>Address Details</legend><div class="fields wide">
          <label for="jaPres">Present Address *</label><input type="text" id="jaPres">
          <label for="jaPerm">Permanent Address</label><input type="text" id="jaPerm"></div></fieldset>
        <fieldset class="opt"><legend>Personal Information</legend><div class="formgrid">
          <div class="fields wide">
            <label for="jaFather">Father's Name</label><input type="text" id="jaFather">
            <label for="jaMother">Mother's Name</label><input type="text" id="jaMother">
            <label for="jaSpouse">Wife's / Husband's Name</label><input type="text" id="jaSpouse">
            <label for="jaDob">Date of Birth</label><input type="date" id="jaDob">
            <label for="jaBirth">Birth Place</label><input type="text" id="jaBirth">
          </div>
          <div class="fields wide">
            <label for="jaIdNo">BRC / NID / Passport No</label><input type="text" id="jaIdNo">
            <label for="jaGender">Gender</label><select id="jaGender">${["", "Male", "Female"].map((g) => `<option>${g}</option>`).join("")}</select>
            <label for="jaRel">Religion</label><input type="text" id="jaRel">
            <label for="jaBlood">Blood Group</label><select id="jaBlood">${["", "A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"].map((g) => `<option>${g}</option>`).join("")}</select>
          </div></div></fieldset>
        <fieldset class="opt"><legend>Educational Qualifications</legend>
          <div class="grid-scroll"><table class="grid budget"><thead><tr>${E.EDU_COLS.map((c) => `<th>${c}</th>`).join("")}<th></th></tr></thead><tbody id="jaEdu">${[{ exam: "SSC" }, { exam: "HSC" }].map(eduRow).join("")}</tbody></table></div>
          <div class="btnrow"><button type="button" class="btn" id="jaEduAdd">+ Add Row</button></div></fieldset>
        <fieldset class="opt"><legend>Work Experience</legend>
          <div class="grid-scroll"><table class="grid budget"><thead><tr>${E.EXP_COLS.map((c) => `<th>${c}</th>`).join("")}<th></th></tr></thead><tbody id="jaExp"></tbody></table></div>
          <div class="btnrow"><button type="button" class="btn" id="jaExpAdd">+ Add Experience</button></div></fieldset>
        <fieldset class="opt"><legend>Requirements</legend><div class="fields wide">${E.fileField("jaReq", "Upload Requirements", 'multiple accept="image/*,application/pdf"')}</div>
          <small>NID or birth certificate, certificates, CV, police clearance — photos or PDF.</small></fieldset>
        <label class="decl"><input type="checkbox" id="jaDecl"> I hereby declare that all the information given above is true and correct to the best of my knowledge.</label>
        <small class="muted">Check everything before you submit: a submitted application cannot be changed.</small>
      </div><div class="wfoot"><button type="button" class="btn" id="jaCancel">Cancel</button><button type="submit" class="btn primary">Submit Application</button></div></form>`;
    const rows = (sel, html) => { $(sel).insertAdjacentHTML("beforeend", html); bindRemove(); };
    const bindRemove = () => $$("#jaEdu button, #jaExp button").forEach((b) => (b.onclick = () => b.closest("tr").remove()));
    bindRemove();
    $("#jaEduAdd").onclick = () => rows("#jaEdu", eduRow());
    $("#jaExpAdd").onclick = () => rows("#jaExp", expRow());
    $("#jaPhoto").onchange = (e) => { const f = e.target.files[0]; $("#jaPhotoPrev").innerHTML = f ? `<img src="${URL.createObjectURL(f)}" alt="Photo preview">` : "No photo"; };
    $("#jaCancel").onclick = () => V.applicant();
    $("#jaForm").onsubmit = async (e) => {
      e.preventDefault();
      const g = (id) => ($("#" + id)?.value || "").trim();
      if (!pos && !g("jaPos")) return toast("Enter the position you are applying for.", true);
      if (!g("jaName")) return toast("Enter your full name.", true);
      if (!g("jaPhone")) return toast("Enter your phone number.", true);
      if (!g("jaPres")) return toast("Enter your present address.", true);
      const photo = $("#jaPhoto").files[0];
      if (!photo) return toast("Add your photo.", true);
      if (!$("#jaDecl").checked) return toast("Tick the declaration to confirm the information is true.", true);
      const education = $$("#jaEdu tr").map((tr) => ({ exam: $(".e1", tr).value.trim(), institute: $(".e2", tr).value.trim(), result: $(".e3", tr).value.trim(), year: $(".e4", tr).value.trim() })).filter((r) => r.exam || r.institute);
      const experience = $$("#jaExp tr").map((tr) => ({ company: $(".x1", tr).value.trim(), position: $(".x2", tr).value.trim(), from: $(".x3", tr).value.trim(), to: $(".x4", tr).value.trim() })).filter((r) => r.company || r.position);
      const rec = {
        full_name: g("jaName"), phone: g("jaPhone"), email: g("jaEmail") || null, present_address: g("jaPres"), permanent_address: g("jaPerm") || null,
        father_name: g("jaFather") || null, mother_name: g("jaMother") || null, spouse_name: g("jaSpouse") || null, date_of_birth: g("jaDob") || null,
        birth_place: g("jaBirth") || null, id_number: g("jaIdNo") || null, gender: g("jaGender") || null, religion: g("jaRel") || null, blood_group: g("jaBlood") || null,
        education, experience, apply_salary: g("jaSal") === "" ? null : num(g("jaSal")), apply_duty_hours: g("jaHrs") || null, apply_joining_date: g("jaJoin") || null, declaration: true
      };
      E.setBusy(e.target, true, "Submitting");
      const id = E.uuid();
      const { data: app, error } = await sb.from("job_applications").insert({ id, ...rec, position_id: pos?.id || null, position_title: pos ? pos.title : g("jaPos"), company_name: pos ? pos.company_name : C.company.name, company_code: pos ? pos.company_code : "EO" }).select().single();
      if (error) { E.setBusy(e.target, false); return fail(error, "Could not submit the application"); }
      if (!(await addApplicationPhoto(app, photo))) toast("The photo could not be uploaded. Add it from My Job Application.", true);
      const failed = await E.uploadRecords("job_application", app.id, "requirement", E.filesOf("jaReq"));
      if (failed) toast(`${failed} requirement file(s) failed to upload.`, true);
      toast(`Application ${app.application_no} submitted. The Director has been notified.`);
      applicantStatus(app);
    };
  }
  // The photo is added once, right after submitting (or later from the status page if that upload failed).
  async function addApplicationPhoto(app, file) {
    const f = await shrinkImage(file, 900);
    const path = `job_application/${app.id}/Photo_${Date.now()}.${E.extOf(f)}`;
    const up = await sb.storage.from("records").upload(path, f, { contentType: f.type });
    if (up.error) return false;
    const { error } = await sb.rpc("set_application_photo", { p_id: app.id, p_path: path });
    if (error) return false;
    app.photo_path = path;
    return true;
  }
  async function applicantStatus(a) {
    $(".band h1").textContent = "My Job Application";
    const att = await E.attachmentsOf("job_application", a.id);
    $("#main").innerHTML = `
      <section class="app-status st-${esc(a.status)}">
        <div class="as-ic">${a.status === "approved" ? ic("check") : ic("doc")}</div>
        <div><h2>${a.status === "approved" ? "Approved — welcome to the team!" : "Application submitted — under review"}</h2>
          <p>${a.status === "approved" ? `Approval No <b>${esc(a.approval_no || "")}</b>. Sign out and sign in again to open the portal.`
            : "Next: download the application form, sign it, and bring it to the office. The office uploads your signed form and the Director approves your application (the Director's signature is printed by the portal). This page opens the full portal by itself once you are approved."}</p></div></section>
      <div class="ch-ids big-ids">${E.idBox("Application No", a.application_no)}${E.idBox("Position", a.position_title)}${E.idBox("Company", a.company_name)}${E.idBox("Submitted", mdy(a.created_at))}${E.idBox("Status", a.status.toUpperCase())}</div>
      <div class="docgrid">${E.docCard({ key: "myja", title: `Job Application Form ${a.application_no}`, sub: "Download, print and sign", ownerType: "job_application", ownerId: a.id, att, print: () => E.printJobApp(a), canUpload: false, printLabel: "Download / Print Form",
        approved: a.status === "approved" && a.approved_by_name ? { name: a.approved_by_name, at: a.approved_at } : null })}</div>
      <h3>My Requirements</h3>${E.filesHtml(att.filter((x) => x.kind !== "signed_form"), "No requirements uploaded yet.")}
      ${a.status === "submitted" ? `<div class="fields wide" style="margin:8px 0">${E.fileField("asReq", "Add Requirements", 'multiple accept="image/*,application/pdf"')}${a.photo_path ? "" : E.fileField("asPhoto", "Add Your Photo", 'accept="image/*"')}</div>
        <div class="btnrow"><button type="button" class="btn" id="asCheck">Check Status</button></div>` : ""}`;
    E.bindFiles($("#main"));
    E.bindDocCards($("#main"), () => applicantStatus(a));
    if ($("#asPhoto")) $("#asPhoto").onchange = async (e) => { const f = e.target.files[0]; if (!f) return; const ok = await addApplicationPhoto(a, f); toast(ok ? "Photo added." : "The photo could not be added.", !ok); applicantStatus(a); };
    if ($("#asCheck")) $("#asCheck").onclick = async () => { S.profile = null; E.route(); };
    if ($("#asReq")) $("#asReq").onchange = async (e) => { const f = await E.uploadRecords("job_application", a.id, "requirement", Array.from(e.target.files)); toast(f ? "Upload failed." : "Uploaded.", f > 0); applicantStatus(a); };
  }

  // ======================================================================
  // 6. Community — posts and work photos, removed after 30 days
  // ======================================================================
  V.community = async () => {
    E.shell("community", "Community", `
      <form class="composer" id="cmpForm">
        <div class="cmp-av">${E.avatarUrl() ? `<img src="${esc(E.avatarUrl())}" alt="">` : `<span>${esc(E.initials(S.profile.full_name))}</span>`}</div>
        <div class="cmp-main"><textarea id="cmpText" rows="2" placeholder="Share an update or photos of your work, ${esc((S.profile.full_name || "").split(" ")[0])}…"></textarea>
          <div class="cmp-prev" id="cmpPrev"></div>
          <div class="cmp-bar"><label class="btn" for="cmpPhotos">${ic("image")} Photos</label><input type="file" id="cmpPhotos" accept="image/*" multiple hidden>
            <small class="muted">Posts are removed automatically after 30 days.</small><button type="submit" class="btn primary">${ic("send")} Post</button></div></div>
      </form>
      <div id="feed">${busy()}</div>`);
    let picked = [];
    const showPicked = () => {
      $("#cmpPrev").innerHTML = picked.map((f, i) => `<div class="thumb"><img src="${URL.createObjectURL(f)}" alt=""><button type="button" data-rm="${i}" aria-label="Remove photo">×</button></div>`).join("");
      $$("#cmpPrev [data-rm]").forEach((b) => (b.onclick = () => { picked.splice(Number(b.dataset.rm), 1); showPicked(); }));
    };
    $("#cmpPhotos").onchange = (e) => { picked = picked.concat(Array.from(e.target.files)).slice(0, 10); e.target.value = ""; showPicked(); };
    $("#cmpForm").onsubmit = async (e) => {
      e.preventDefault();
      const body = $("#cmpText").value.trim();
      if (!body && !picked.length) return toast("Write something or add a photo.", true);
      E.setBusy(e.target, true, "Posting");
      const id = E.uuid(), photos = [];
      for (const [i, raw] of picked.entries()) {
        const f = await shrinkImage(raw);
        const path = `community/${id}/${i + 1}_${Date.now()}.${E.extOf(f)}`;
        const up = await sb.storage.from("records").upload(path, f, { contentType: f.type });
        if (!up.error) photos.push(path); else console.error(up.error);
      }
      const { error } = await sb.from("community_posts").insert({ id, body: body || null, photos });
      E.setBusy(e.target, false);
      if (error) return fail(error, "Could not post");
      picked = []; $("#cmpText").value = ""; showPicked();
      toast("Posted."); loadFeed();
    };
    if (isAdmin()) cleanupOld();
    loadFeed();
  };
  async function cleanupOld() {
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    const { data } = await sb.from("community_posts").select("id, photos").lt("created_at", cutoff);
    if (!data?.length) return;
    const files = data.flatMap((p) => p.photos || []);
    if (files.length) await sb.storage.from("records").remove(files);
    await sb.from("community_posts").delete().in("id", data.map((p) => p.id));
  }
  async function loadFeed() {
    const box = $("#feed"); if (!box) return;
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    const [{ data, error }, people] = await Promise.all([
      sb.from("community_posts").select("*").gte("created_at", cutoff).order("created_at", { ascending: false }).limit(100),
      sb.rpc("chat_contacts")
    ]);
    if (!$("#feed")) return;
    if (error) { box.innerHTML = `<div class="empty">Community is not set up yet (run the 1.1 database update).</div>`; return; }
    const posts = data || [];
    const who = new Map((people.data || []).map((p) => [p.id, p]));
    if (S.profile) who.set(S.profile.id, { ...S.profile });
    const urls = await signedMap(posts.flatMap((p) => p.photos || []));
    box.innerHTML = posts.length ? posts.map((p) => {
      const a = who.get(p.author_id) || { full_name: p.author_name };
      const left = Math.max(0, 30 - Math.floor((Date.now() - new Date(p.created_at).getTime()) / 86400000));
      const ph = (p.photos || []).map((x) => urls.get(x)).filter(Boolean);
      return `<article class="post">
        <header><div class="post-av">${avatarOf(a)}</div>
          <div class="post-who"><b class="who">${esc(p.author_name || "")}</b><span class="pos">${esc(p.author_position || "")}</span><small>${esc(E.dateTime(p.created_at))} · ${left} day${left === 1 ? "" : "s"} left</small></div>
          ${p.author_id === meId() || isAdmin() ? `<button type="button" class="iconlink" data-del="${p.id}" title="Delete post" aria-label="Delete post">${ic("trash")}</button>` : ""}</header>
        ${p.body ? `<p class="post-body">${esc(p.body)}</p>` : ""}
        ${ph.length ? `<div class="post-photos n${Math.min(ph.length, 4)}">${ph.slice(0, 4).map((u, i) => `<button type="button" class="pp" data-img="${esc(u)}">${`<img src="${esc(u)}" alt="Photo ${i + 1}" loading="lazy">`}${i === 3 && ph.length > 4 ? `<span class="more">+${ph.length - 4}</span>` : ""}</button>`).join("")}</div>` : ""}
      </article>`;
    }).join("") : `<div class="empty">No posts in the last 30 days. Be the first to share an update!</div>`;
    $$("[data-img]", box).forEach((b) => (b.onclick = () => lightbox(b.dataset.img)));
    $$("[data-del]", box).forEach((b) => (b.onclick = async () => {
      if (!(await E.confirmBox("Delete this post?", { ok: "Delete", danger: true }))) return;
      const p = posts.find((x) => x.id === b.dataset.del);
      const { error: e2 } = await sb.from("community_posts").delete().eq("id", p.id);
      if (e2) return fail(e2, "Could not delete the post");
      if (p.photos?.length && isAdmin()) sb.storage.from("records").remove(p.photos).then(() => {}, () => {});
      toast("Post deleted."); loadFeed();
    }));
    E.setRecords(`Posts: ${posts.length}`);
  }

  // ======================================================================
  // 9. Order Letter — for a customer, an employee, a billing company or an e-bill (Released Notice). Staff send a request;
  // the Director approves it and it is carried out at once (the Director's own order is carried out straight away).
  // Order letters are numbered EO-YYYY-MM-#### by the database.
  // ======================================================================
  const SUBJ = {
    suspension: ["Suspension", "Suspension of Account"], closure: ["Closure", "Closure of Account"], reactivation: ["Reactivation", "Reactivation of Account"], reopen: ["Reopening", "Reopening of Account"],
    termination: ["Termination", "Termination of Employment"], memo: ["Notice / Memo", "Memorandum"],
    unpaid: ["Unpaid Balance", "Notice of Unpaid Balance"], installment: ["Installment", "Installment Payment Arrangement"], unsettled_balance: ["Unsettled Balance", "Demand for Unsettled Balance"],
    promise_to_pay: ["Promise to Pay", "Promise to Pay Agreement"], balance_certificate: ["Balance Certificate", "Account Balance Certificate"],
    charge: ["Additional Charge", "Additional Charge"], settlement: ["Settlement Adjustment", "Settlement Adjustment"], other: ["Other", ""],
    release: ["Released Notice", "Released Notice"]
  };
  const TITLE = {
    suspension: "SUSPENSION ORDER", closure: "CLOSURE ORDER", reactivation: "REACTIVATION ORDER", reopen: "REOPENING ORDER", termination: "TERMINATION ORDER",
    memo: "MEMORANDUM ORDER", unpaid: "UNPAID BALANCE ORDER", installment: "INSTALLMENT ORDER", unsettled_balance: "UNSETTLED BALANCE ORDER", promise_to_pay: "PROMISE TO PAY ORDER",
    balance_certificate: "ACCOUNT BALANCE CERTIFICATE", charge: "ADDITIONAL CHARGE ORDER", settlement: "SETTLEMENT ADJUSTMENT ORDER", other: "ORDER", release: "RELEASED ORDER"
  };
  const AMOUNT_TYPES = ["unpaid", "installment", "unsettled_balance", "promise_to_pay", "charge", "settlement"];
  // Only two orders change the balance (once approved): an Additional Charge adds to it, and a Settlement Adjustment
  // adds to it or takes it off (chosen on the order). The others are about money the customer already owes.
  const ADJ = { reduce: ["−", "Less", "Take off the balance"], add: ["+", "Add", "Add to the balance"] };
  const signedAmt = (o) => (o.subject_type === "settlement" && o.adjust_type === "reduce" ? "−" : "") + peso(o.amount);
  // Who an order is for, who may request it, and which orders fit each status.
  const KINDS = {
    customer: { label: "Customer", write: () => E.canWrite("orders") || E.canWrite("customers"), subject: {},
      types: (st) => st === "suspended" ? ["reactivation", "closure", "charge", "settlement", "balance_certificate"] : st === "closed" ? ["reopen", "settlement", "balance_certificate"]
        : ["suspension", "closure", "unpaid", "installment", "unsettled_balance", "promise_to_pay", "charge", "settlement", "balance_certificate", "other"] },
    employee: { label: "Employee", write: () => E.canWrite("employees"), subject: { suspension: "Suspension from Work", reactivation: "Return to Work" },
      types: (st) => st === "suspended" ? ["reactivation", "termination", "memo"] : st === "terminated" ? ["memo"] : st === "waiting" ? ["termination", "memo"] : ["suspension", "termination", "memo"] },
    company: { label: "Billing Company", write: () => E.canWrite("billing"), subject: { suspension: "Suspension of Payments", reactivation: "Reactivation of Payments", memo: "Notice" },
      types: (st) => st === "suspended" ? ["reactivation", "memo"] : ["suspension", "memo"] },
    // Released Notice: only an e-bill at SHIP can be released (Inventory), found by its batch no.
    stock_bill: { label: "E-Bill", write: () => E.canWrite("inventory"), subject: {}, types: () => ["release"] }
  };
  const rateText = (n) => Number(n || 0).toLocaleString("en-PH", { maximumFractionDigits: 4 });
  const batchOf = (o) => o.stock_info?.batch_no || "";
  // The kind of order as shown in lists and on the letter: a Released Notice shows its batch no ("Released Notice I-17").
  const typeName = (o) => (o.subject_type === "release" ? `Released Notice${batchOf(o) ? " " + batchOf(o) : ""}` : SUBJ[o.subject_type]?.[0] || o.subject_type);
  // A Released Notice is in BDT: the status bar says so.
  const setCurrency = (bdt) => { const c = $(".statusbar span:last-child"); if (c) c.textContent = `Currency: ${bdt ? "BDT" : "PHP (₱)"}`; };
  const kindOf = (o) => o.employee_id ? "employee" : o.company_id ? "company" : o.stock_bill_id ? "stock_bill" : "customer";
  const forName = (o) => o.employee_id ? (o.employees ? `${o.employees.employee_no} ${fullName(o.employees)}` : "")
    : o.company_id ? (o.pay_companies?.name || "") : o.stock_bill_id ? [o.stock_info?.bill_no, o.stock_info?.company].filter(Boolean).join(" ")
    : o.customers ? `${o.customers.account_no} ${fullName(o.customers)}` : "";
  const ORDER_LIST = "*, customers(first_name,last_name,account_no,status), employees(first_name,last_name,employee_no,status), pay_companies(name,status), stock_bills(bill_no,status)";
  const ORDER_ALL = "*, customers(*), employees(*), pay_companies(*), stock_bills(id,bill_no,status)";
  const qtyText = (n) => Number(n || 0).toLocaleString("en-PH", { maximumFractionDigits: 2 });
  const dayOf = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const EVERY = { month: "Every month", "15 days": "Every 15 days", week: "Every week" };
  const CLOSE_REASONS = ["Requested by the customer", "Unpaid balance", "Violation of terms", "Business closed", "Other"];
  // Installment plan: due dates from the first due date, the last installment takes what is left after rounding.
  const nextDue = (iso, every, i) => {
    const d = new Date(iso + "T00:00:00");
    if (every === "week" || every === "15 days") d.setDate(d.getDate() + (every === "week" ? 7 : 15) * i);
    else { const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + i); d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); }
    return dayOf(d);
  };
  function schedule(amount, n, first, every, each) {
    if (!(amount > 0) || !(n >= 1) || !first) return [];
    const per = each > 0 ? each : Math.round((amount / n) * 100) / 100;
    let left = amount;
    return Array.from({ length: n }, (_, i) => {
      const amt = i === n - 1 ? Math.round(left * 100) / 100 : Math.min(per, left);
      left = Math.round((left - amt) * 100) / 100;
      return { no: i + 1, date: nextDue(first, every, i), amount: amt, left };
    });
  }
  const ORDER_COLS = [
    { label: "Order No", get: (r) => r.order_no }, { label: "Date", get: (r) => mdy(r.order_date) },
    { label: "For", get: (r) => `${KINDS[kindOf(r)].label}: ${forName(r) || "—"}` },
    { label: "Type", get: (r) => typeName(r) }, { label: "Subject", get: (r) => r.subject },
    { label: "Amount (₱)", num: true, get: (r) => (r.amount != null ? signedAmt(r) : r.subject_type === "balance_certificate" && r.balance_due != null ? peso(r.balance_due) : "") }, { label: "Status", html: (r) => pill(r.status) }
  ];
  const canOrder = () => Object.values(KINDS).some((k) => k.write());
  V.orders = async () => {
    E.shell("orders", "Order Letter", `
      <div class="tabs" id="olF"><button type="button" class="on" data-f="pending">Waiting for Approval</button><button type="button" data-f="applied">Applied</button><button type="button" data-f="rejected">Rejected</button><button type="button" data-f="">All</button></div>
      <div class="btnrow">${canOrder() ? `<a class="btn primary" href="#neworder">${ic("plus")} Request Order</a>` : ""}</div>
      <div id="olRes">${busy()}</div>`,
      "Orders for customers, employees, billing companies and e-bills (Released Notice). Employees send a request; the Director approves it and it is carried out at once.");
    const run = async (f) => {
      $("#olRes").innerHTML = busy();
      let q = sb.from("order_letters").select(ORDER_LIST).order("created_at", { ascending: false }).limit(1000);
      if (f === "applied") q = q.in("status", ["approved", "applied"]); else if (f) q = q.eq("status", f);
      const { data, error } = await q;
      if (error) return fail(error, "Could not load orders (run the 1.3 database update)");
      const rows = data || [];
      $("#olRes").innerHTML = E.grid({ cols: ORDER_COLS, rows, onRow: true, empty: "No orders here." });
      E.bindGrid($("#olRes"), rows, (r) => (location.hash = "order/" + r.id));
      E.setRecords(`Orders: ${rows.length}`);
    };
    $$("#olF button").forEach((b) => (b.onclick = () => { $$("#olF button").forEach((x) => x.classList.toggle("on", x === b)); run(b.dataset.f); }));
    run("pending");
  };
  // Orders shown on a customer, employee or company page.
  const ordersGrid = (rows, empty) => E.grid({ cols: ORDER_COLS.filter((c) => c.label !== "For"), rows, onRow: true, empty });

  // Ready-made wording for each kind of order (the request form fills it in; it can be changed).
  // d: { name, acct, bal, days, amt, n, each, every, due, date, reason }
  function defaultDetails(kind, t, w, d) {
    const when = E.mdy(d.date || isoToday());
    if (kind === "stock_bill") {
      if (!w) return "";
      // Released Notice: price per box (PHP) × boxes = total (PHP); × the exchange rate of the day = BDT; + the shipping fee
      const boxes = num(w.total_boxes), ppb = num(d.ppb), rt = num(d.rate), ship = d.ship === "" || d.ship == null ? null : num(d.ship);
      const php = Math.round(ppb * boxes * 100) / 100, charge = Math.round(php * rt * 100) / 100, done = ppb > 0 && rt > 0;
      const total = Math.round((num(w.total_cost) + charge + (ship || 0)) * 100) / 100;
      return `This is to notify that the goods of E-Bill ${w.bill_no} from ${String(w.company_name || "[company]").toUpperCase()}${w.batch_no ? `, Batch No ${w.batch_no}` : ""}${w.supplier_bill_no ? `, Bill No ${w.supplier_bill_no}` : ""}${w.shipment_no ? `, System Record No ${w.shipment_no}` : ""} (${boxes} box(es), total qty ${qtyText(w.total_qty)}) are RELEASED on ${E.mdy(d.release || isoToday())}. `
        + `Released charge: ${boxes} box(es) × PHP ${ppb > 0 ? peso(ppb) : "[price per box]"} = PHP ${ppb > 0 ? peso(php) : "[total]"}; at the exchange rate of the day (BDT ${rt > 0 ? rateText(rt) : "[rate]"} for 1 PHP) this is BDT ${done ? peso(charge) : "[amount]"}. `
        + `Shipping fee: BDT ${ship == null ? "[amount]" : peso(ship)}. Total cost of the e-bill: BDT ${peso(w.total_cost)} (bill) + BDT ${done ? peso(charge) : "[released charge]"} + BDT ${ship == null ? "[shipping fee]" : peso(ship)} = BDT ${done && ship != null ? peso(total) : "[total]"}.`;
    }
    if (kind === "employee") return {
      suspension: `This is to inform you that you are SUSPENDED from work effective ${when}. Your portal login is closed until you are reactivated by an approved order.`,
      reactivation: `This is to inform you that your suspension is lifted and you are REACTIVATED effective ${when}. Your portal login is open again and you may return to work.`,
      termination: `This is to inform you that your employment with ${C.company.name} is TERMINATED effective ${when}. Your portal login is closed. Please complete your clearance with the office.`
    }[t] || "";
    if (kind === "company") {
      const name = w?.name || "[company]";
      return {
        suspension: `Please be informed that payments to ${name} are SUSPENDED effective ${when}. No new payment vouchers will be issued until the company is reactivated by an approved order.`,
        reactivation: `Please be informed that payments to ${name} are REACTIVATED effective ${when}.`
      }[t] || "";
    }
    const name = w ? fullName(w).toUpperCase() : "[customer]", acct = w ? w.account_no : "[account]";
    const p = (n) => (n ? `PHP ${peso(n)}` : "PHP [amount]"), due = d.due ? E.mdy(d.due) : "[date]";
    const late = d.days ? ` (${d.days} day(s) overdue)` : "";
    return {
      suspension: `We regret to inform you that your account ${acct} (${name}) is SUSPENDED effective ${when}. New orders and invoices are on hold until the account is reactivated by an approved order.`,
      closure: `Please be informed that your account ${acct} (${name}) is CLOSED effective ${when}. Reason: ${d.reason || "[reason]"}. ${d.bal > 0 ? `The remaining balance of PHP ${peso(d.bal)} must still be settled.` : "The account has no remaining balance."} No new invoices will be recorded on this account.`,
      reactivation: `We are pleased to inform you that your account ${acct} (${name}) is REACTIVATED effective ${when}. You may place orders again.`,
      reopen: `We are pleased to inform you that your account ${acct} (${name}) is REOPENED effective ${when}. You may place orders again.`,
      unpaid: `Our records show an unpaid balance of ${p(d.amt)} on your account ${acct}${late}. Please settle it on or before ${due}.`,
      unsettled_balance: `Despite previous reminders, the balance of ${p(d.amt)} on account ${acct} remains unsettled${late}. Please settle it on or before ${due}.`,
      promise_to_pay: `I, ${name}, holder of account ${acct}, acknowledge an outstanding balance of PHP ${peso(d.bal)} as of ${when}${late}. I promise to pay ${p(d.amt)} on or before ${due}. I understand that if I do not pay by this date, ${C.company.name} may suspend my account.`,
      installment: `I, ${name}, holder of account ${acct}, agree to pay the balance of ${p(d.amt)} in ${d.n || "[number]"} installment(s) of ${p(d.each)} ${(EVERY[d.every] || EVERY.month).toLowerCase()}, starting ${due}, as shown in the installment schedule. I understand that if I miss a payment, ${C.company.name} may suspend my account.`,
      charge: `Please be informed that an additional charge of ${p(d.amt)} is added to your account ${acct} (${name}) effective ${when}. Your previous balance is PHP ${peso(d.bal)} and your new balance is PHP ${peso(d.bal + (d.amt || 0))}. Please pay on or before ${due}.`,
      settlement: d.adj ? `As agreed for the settlement of account ${acct} (${name}), ${p(d.amt)} is ${d.adj === "reduce" ? "deducted from" : "added to"} the balance effective ${when}. Previous balance: PHP ${peso(d.bal)}. New balance: PHP ${peso(d.bal + (d.adj === "reduce" ? -1 : 1) * (d.amt || 0))}.${d.due ? ` Please settle the balance on or before ${due}.` : ""}`
        : `Settlement adjustment of ${p(d.amt)} on account ${acct} (${name}) effective ${when}. [Choose: take off the balance or add to it]`,
      balance_certificate: "This certificate is issued upon the request of the account holder for whatever purpose it may serve."
    }[t] || "";
  }

  // #neworder, #neworder/<customer id>, #neworder/employee/<id>, #neworder/company/<id>; with an order waiting for
  // approval (from #editorder/<id>) the same form changes that order: who it is for and the kind of order stay the same.
  V.neworder = async (a, b, edit = null) => {
    const allowed = Object.keys(KINDS).filter((k) => KINDS[k].write());
    if (!allowed.length && !edit) { toast("You cannot request orders.", true); location.hash = "dashboard"; return; }
    let kind = edit ? kindOf(edit) : KINDS[a] ? a : "customer";
    let presetId = KINDS[a] ? b : a;
    if (!edit && !allowed.includes(kind)) { kind = allowed[0]; presetId = null; }
    E.shell(edit ? "editorder" : "neworder", edit ? "Edit Order" : "Request Order", `
      <form class="window" id="noForm" novalidate><div class="wtitle">${edit ? `Edit Order ${esc(edit.order_no)}` : "Order Request"}</div><div class="wbody">
        <div class="summary-box"><div class="fields wide"><span>Order No</span><b>${edit ? esc(edit.order_no) : `Assigned on save (EO-${isoToday().slice(0, 7)}-0001, …)`}</b><span>Prepared By</span><b>${esc((edit ? edit.created_by_name : S.profile.full_name) || "")}</b></div></div>
        <fieldset class="opt"><legend>Order For</legend>
          ${allowed.length > 1 && !edit ? `<div class="subj-grid" id="noKinds">${allowed.map((k) => `<label class="subj"><input type="radio" name="noKind" value="${k}" ${k === kind ? "checked" : ""}><span>${esc(KINDS[k].label)}</span></label>`).join("")}</div>` : ""}
          <div id="noWho"></div><div class="due-info" id="noDueInfo" hidden></div></fieldset>
        <fieldset class="opt"><legend>Order</legend><div class="subj-grid" id="noTypes"></div>
          <div class="fields wide" style="margin-top:8px"><label for="noSubj">Subject *</label><input type="text" id="noSubj">
            <label for="noDate">Order Date</label><input type="date" id="noDate" value="${isoToday()}"></div></fieldset>
        <fieldset class="opt" id="noRelBox" hidden><legend>Released</legend><div class="formgrid">
          <div class="fields wide"><label for="noRelDate">Released Date *</label><input type="date" id="noRelDate" value="${isoToday()}">
            <label for="noPpb">Price per Box (PHP) *</label><input type="number" id="noPpb" min="0.01" step="0.01" placeholder="e.g. 3200">
            <label for="noRate">Exchange Rate of Today *</label><input type="number" id="noRate" min="0.0001" step="0.0001" placeholder="BDT for 1 PHP, e.g. 2">
            <label for="noShipAmt">Shipping Fee (BDT) *</label><input type="number" id="noShipAmt" min="0" step="0.01" placeholder="0 if there is none">
            <label for="noShipFile">Shipping Fee Receipt (photo or PDF)</label><input type="file" id="noShipFile" accept="image/*,application/pdf"></div>
          <div class="bdt-calc rel-calc"><small>Total (PHP)</small><span id="noRelPhp">—</span><small>Released Charge (BDT)</small><span id="noRelBdt">—</span>
            <small>Total Cost (BDT): bill + released charge + shipping fee</small><b id="noRelTotal">BDT 0.00</b><span id="noRelCalc"></span><small id="noRelWords"></small></div></div></fieldset>
        <fieldset class="opt" id="noCloseBox" hidden><legend>Closure</legend><div class="fields wide">
          <label for="noReason">Reason for Closure *</label><select id="noReason"><option value="">— Choose the reason —</option>${CLOSE_REASONS.map((r) => `<option>${esc(r)}</option>`).join("")}</select>
          <label for="noReason2" class="noOther">Other Reason *</label><input type="text" id="noReason2" class="noOther" placeholder="Write the reason"></div></fieldset>
        <fieldset class="opt" id="noAmtBox" hidden><legend id="noAmtLeg">Amount &amp; Terms</legend><div class="formgrid">
          <div class="fields wide noAdjRow"><span>Adjustment *</span><div class="subj-grid" id="noAdj">${Object.entries(ADJ).map(([k, [sign, , label]]) => `<label class="subj"><input type="radio" name="noAdj" value="${k}"><span>${sign} ${esc(label)}</span></label>`).join("")}</div></div>
          <div class="fields wide"><label for="noAmt" id="noAmtL">Amount (₱)</label><input type="number" id="noAmt" min="0" step="0.01"><label for="noDue" id="noDueL">Due Date</label><input type="date" id="noDue"></div>
          <div class="fields wide noInst"><label for="noN">Number of Installments</label><input type="number" id="noN" min="1" step="1">
            <label for="noEvery">Pay</label><select id="noEvery">${Object.entries(EVERY).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("")}</select>
            <label for="noInst">Installment Amount (₱)</label><input type="number" id="noInst" min="0" step="0.01"></div></div>
          <div id="noSched"></div></fieldset>
        <fieldset class="opt"><legend id="noLetterLeg">Letter</legend><div class="fields wide">
          <label for="noDetails" id="noDetailsL">Details *</label><textarea id="noDetails" rows="5"></textarea>
          <label for="noRes">Resolution / Terms</label><textarea id="noRes" rows="3" placeholder="Optional: conditions, what must be done"></textarea></div></fieldset>
      </div><div class="wfoot"><button type="button" class="btn" id="noCancel">Cancel</button><button type="submit" class="btn primary" id="noSubmit">${edit ? "Save Changes" : isAdmin() ? "Submit Order" : "Send for Approval"}</button></div></form>`,
      edit ? "Change the order while it waits for approval: who it is for and the kind of order stay the same. It keeps its number and is checked again when you save."
        : "Choose who the order is for and the kind of order: the details are filled in for you. The order waits for approval, so it can still be changed (Edit Order); once the Director approves it, it is carried out at once.");
    let who = null, due = null, dirty = false;
    const touched = new Set();
    const types = () => (edit ? [edit.subject_type] : KINDS[kind].types(who?.status));
    const type = () => $("input[name=noType]:checked")?.value || types()[0];
    const bal = () => num(due?.balance_due);
    const reason = () => ($("#noReason").value === "Other" ? $("#noReason2").value.trim() : $("#noReason").value);
    const plusDays = (n) => { const x = new Date(); x.setDate(x.getDate() + n); return dayOf(x); };
    // Amount, due date and wording for the chosen kind of order.
    const refresh = () => {
      if (!$("#noForm")) return; // the page was left while the amount due was loading
      const t = type(), cust = kind === "customer";
      // Released Notice: price per box × boxes = PHP; × the exchange rate = BDT; bill + that + the shipping fee = total cost
      const rel = kind === "stock_bill", shipRaw = $("#noShipAmt").value.trim();
      $("#noRelBox").hidden = !rel;
      if (rel) {
        const boxes = num(who?.total_boxes), ppb = num($("#noPpb").value), rt = num($("#noRate").value);
        const php = Math.round(ppb * boxes * 100) / 100, charge = Math.round(php * rt * 100) / 100;
        const bill = num(who?.total_cost), ship = num(shipRaw), total = Math.round((bill + charge + ship) * 100) / 100;
        $("#noRelPhp").textContent = who ? `${boxes} box(es) × ₱ ${peso(ppb)} = ₱ ${peso(php)}` : "Find the e-bill first";
        $("#noRelBdt").textContent = who ? `₱ ${peso(php)} × ${rateText(rt)} = BDT ${peso(charge)}` : "—";
        $("#noRelTotal").textContent = `BDT ${peso(total)}`;
        $("#noRelCalc").textContent = who ? `${peso(bill)} + ${peso(charge)} + ${peso(ship)} = ${peso(total)}` : "";
        $("#noRelWords").textContent = who && total ? words(total, "TAKA") : "";
      }
      const amtOn = cust && AMOUNT_TYPES.includes(t);
      $("#noAmtBox").hidden = !amtOn;
      $("#noCloseBox").hidden = !(cust && t === "closure");
      $$(".noOther").forEach((x) => (x.hidden = $("#noReason").value !== "Other"));
      $$(".noInst").forEach((x) => (x.hidden = t !== "installment"));
      $$(".noAdjRow").forEach((x) => (x.hidden = t !== "settlement"));
      const adj = $("input[name=noAdj]:checked")?.value;
      const L = { promise_to_pay: ["Promise to Pay", "Amount the Customer Will Pay (₱)", "Promise Date (Due Date)"], installment: ["Installment Plan", "Total Amount (₱)", "First Due Date"],
        unpaid: ["Amount Due", "Amount Due (₱)", "Pay On or Before"], unsettled_balance: ["Amount Due", "Amount Due (₱)", "Settle On or Before"],
        charge: ["Additional Charge — added to the balance once approved", "Charge Amount (₱)", "Pay On or Before"],
        settlement: ["Settlement Adjustment — added to or taken off the balance once approved", "Adjustment Amount (₱)", "Settle On or Before (optional)"] }[t];
      if (L) { $("#noAmtLeg").textContent = L[0]; $("#noAmtL").textContent = L[1]; $("#noDueL").textContent = L[2]; }
      if (amtOn && !touched.has("noAmt")) $("#noAmt").value = !["charge", "settlement"].includes(t) && bal() > 0 ? bal().toFixed(2) : "";
      if (amtOn && !touched.has("noDue")) $("#noDue").value = t === "settlement" ? "" : plusDays(t === "installment" ? 30 : 7);
      const amt = num($("#noAmt").value), n = Math.floor(num($("#noN").value)), every = $("#noEvery").value;
      if (t === "installment" && n > 0 && amt > 0 && !touched.has("noInst")) $("#noInst").value = (Math.round((amt / n) * 100) / 100).toFixed(2);
      const each = num($("#noInst").value);
      const rows = t === "installment" ? schedule(amt, n, $("#noDue").value, every, each) : [];
      $("#noSched").innerHTML = rows.length ? `<div class="sched-h">Installment Schedule</div>${E.grid({ cols: [{ label: "No.", get: (r) => r.no }, { label: "Due Date", get: (r) => mdy(r.date) }, { label: "Amount (₱)", num: true, get: (r) => peso(r.amount) }, { label: "Balance After (₱)", num: true, get: (r) => peso(r.left) }], rows })}` : "";
      $("#noLetterLeg").textContent = t === "balance_certificate" ? "Certificate" : "Letter";
      $("#noDetailsL").textContent = t === "balance_certificate" ? "Purpose *" : "Details *";
      if (!dirty) $("#noDetails").value = wording();
    };
    // The letter's wording for what is in the form now.
    const wording = () => defaultDetails(kind, type(), who, { bal: bal(), days: num(due?.days_overdue), amt: num($("#noAmt").value), n: Math.floor(num($("#noN").value)),
      each: num($("#noInst").value), every: $("#noEvery").value, due: $("#noDue").value, date: $("#noDate").value, reason: reason(), adj: $("input[name=noAdj]:checked")?.value,
      release: $("#noRelDate").value, ship: $("#noShipAmt").value.trim(), ppb: $("#noPpb").value, rate: $("#noRate").value });
    // Changing an order: the form starts with what the order has now. Its wording keeps changing with the figures only
    // when it was not written by hand.
    let filled = false;
    const prefill = () => {
      const o = edit, set = (id, v) => { if (v != null && v !== "") $("#" + id).value = v; };
      set("noSubj", o.subject); set("noDate", o.order_date); set("noRes", o.resolution);
      if (o.amount != null) set("noAmt", Number(o.amount).toFixed(2));
      set("noDue", o.first_due_date); set("noN", o.installments); set("noEvery", o.installment_every);
      if (o.installment_amount != null) set("noInst", Number(o.installment_amount).toFixed(2));
      ["noAmt", "noDue", "noInst"].forEach((id) => touched.add(id));
      if (o.closure_reason) {
        if (CLOSE_REASONS.includes(o.closure_reason)) $("#noReason").value = o.closure_reason;
        else { $("#noReason").value = "Other"; $("#noReason2").value = o.closure_reason; }
      }
      if (o.adjust_type) { const r = $(`input[name=noAdj][value="${o.adjust_type}"]`); if (r) r.checked = true; }
      set("noRelDate", o.release_date); set("noPpb", o.price_per_box); set("noRate", o.exchange_rate); set("noShipAmt", o.shipping_cost);
      $("#noDetails").value = o.details || "";
      dirty = true; refresh();
      dirty = (o.details || "").trim() !== wording().trim();
      filled = true;
    };
    const showTypes = () => {
      $("#noTypes").innerHTML = types().map((k, i) => `<label class="subj"><input type="radio" name="noType" value="${k}" ${i ? "" : "checked"}><span>${esc(SUBJ[k][0])}</span></label>`).join("");
      const pick = () => { $("#noSubj").value = kind === "stock_bill" && who ? `RELEASED NOTICE FOR ${who.batch_no || who.bill_no}` : KINDS[kind].subject[type()] || SUBJ[type()][1]; touched.clear(); dirty = false; refresh(); };
      $$("input[name=noType]").forEach((r) => (r.onchange = pick));
      if (edit) { if (!filled) prefill(); else refresh(); return; }
      pick();
    };
    // A customer's amount due today and days overdue, shown above the order and used in its wording.
    const loadDue = async () => {
      const box = $("#noDueInfo");
      due = null; box.hidden = true;
      if (kind !== "customer" || !who) return;
      const { data } = await sb.rpc("account_due", { p_customer: who.id });
      due = data || null;
      if (!due) return;
      box.hidden = false;
      box.innerHTML = `Amount due today: <b>₱ ${peso(due.balance_due)}</b>${num(due.days_overdue) > 0 ? ` · <b>${due.days_overdue}</b> day(s) overdue (oldest unpaid invoice ${esc(due.oldest_invoice_no || "")} of ${mdy(due.oldest_invoice_date)})` : num(due.balance_due) > 0 ? "" : " · nothing overdue"}`;
      refresh();
    };
    // The e-bill's details, filled in from the e-bill found by its batch no.
    const showBill = () => {
      const box = $("#noDueInfo");
      box.hidden = !(kind === "stock_bill" && who);
      if (box.hidden) return;
      box.innerHTML = `<div class="sb-top">${[["E-Bill No", who.bill_no], ["Company", who.company_name], ["Bill No", who.supplier_bill_no], ["Batch No", who.batch_no],
        ["System Record No", who.shipment_no], ["Shipment Date", mdy(who.shipment_date)], ["Total Boxes", who.total_boxes == null ? "" : String(who.total_boxes)],
        ["Total Qty", qtyText(who.total_qty)], ["Bill Cost (BDT)", peso(who.total_cost)]]
        .map(([k, v]) => `<div><small>${esc(k)}</small><b>${esc(v || "—")}</b></div>`).join("")}</div>`;
    };
    // The customer, employee, company or e-bill the order is for.
    const showWho = async (id) => {
      who = null; due = null; dirty = false;
      setCurrency(kind === "stock_bill");
      $("#noDueInfo").hidden = true;
      const box = $("#noWho");
      if (edit) {
        if (kind === "stock_bill") {
          const { data } = await sb.from("stock_bill_totals").select("id, bill_no, company_name, supplier_bill_no, batch_no, shipment_no, shipment_date, total_boxes, total_qty, total_cost, status").eq("id", edit.stock_bill_id).maybeSingle();
          who = data || null;
        } else who = (kind === "employee" ? edit.employees : kind === "company" ? edit.pay_companies : edit.customers) || null;
        const name = !who ? "—" : kind === "stock_bill" ? `Batch No ${who.batch_no || "—"} · E-Bill ${who.bill_no} (${who.company_name || ""})`
          : kind === "employee" ? `${who.employee_no} — ${fullName(who)}` : kind === "company" ? who.name : `${fullName(who)} (${who.account_no || ""})`;
        box.innerHTML = `<div class="fields wide"><span>${esc(KINDS[kind].label)}</span><b>${esc(name)}</b></div>`;
        if (kind === "stock_bill") showBill();
        // a customer's amount due is needed first, to tell whether the wording was written by hand
        if (kind === "customer" && who) due = (await sb.rpc("account_due", { p_customer: who.id })).data || null;
        showTypes();
        if (kind === "customer") loadDue();
        return;
      }
      if (kind === "customer") {
        box.innerHTML = "";
        E.customerPicker(box, { statuses: ["active", "suspended", "closed"], onPick: (c) => { who = c; dirty = false; showTypes(); loadDue(); }, preset: (id && (await E.getCustomer(id))) || undefined });
      } else if (kind === "stock_bill") {
        box.innerHTML = busy();
        const [{ data, error }, pend] = await Promise.all([
          sb.from("stock_bill_totals").select("id, bill_no, company_name, supplier_bill_no, batch_no, shipment_no, shipment_date, total_boxes, total_qty, total_cost, status")
            .in("status", ["shipped", "arrived"]).order("created_at", { ascending: false }),
          sb.from("order_letters").select("stock_bill_id, order_no").eq("status", "pending").not("stock_bill_id", "is", null)
        ]);
        if (error) { box.innerHTML = ""; return fail(error, "Could not load the e-bills"); }
        const waiting = new Map((pend.data || []).map((o) => [o.stock_bill_id, o.order_no]));
        const list = data || [];
        // Type the batch no and press Find (the e-bill no also works): the e-bill's details fill in.
        box.innerHTML = `<div class="fields wide"><label for="noBatch">Batch No *</label><div class="find-row"><input type="text" id="noBatch" list="noBatchList" placeholder="e.g. I-17" autocomplete="off"><button type="button" class="btn" id="noFind">${ic("search")} Find</button></div></div>
          <datalist id="noBatchList">${list.filter((r) => r.batch_no && !waiting.has(r.id)).map((r) => `<option value="${esc(r.batch_no)}">${esc(`${r.bill_no} — ${r.company_name || ""}`)}</option>`).join("")}</datalist>
          <div id="noFound">${list.length ? "" : `<div class="hint">No e-bills at SHIP. Only an e-bill at SHIP can be released.</div>`}</div>`;
        const choose = (r) => { who = r; dirty = false; showBill(); showTypes(); };
        const find = () => {
          const q = $("#noBatch").value.trim().toLowerCase(), say = (html) => ($("#noFound").innerHTML = html);
          who = null; showBill(); say("");
          if (!q) { showTypes(); return toast("Type the batch no.", true); }
          const hits = list.filter((r) => String(r.batch_no || "").trim().toLowerCase() === q || String(r.bill_no).toLowerCase() === q);
          const free = hits.filter((r) => !waiting.has(r.id));
          if (!hits.length) say(`<div class="hint err">No e-bill at SHIP has Batch No ${esc($("#noBatch").value.trim())}. Only an e-bill at SHIP can be released.</div>`);
          else if (!free.length) say(`<div class="hint err">Batch No ${esc($("#noBatch").value.trim())} already has Released Notice ${esc(waiting.get(hits[0].id))} waiting for the Director's approval.</div>`);
          else if (free.length === 1) return choose(free[0]);
          else {
            // several e-bills have this batch no: choose one
            say(`<div class="fields wide"><label for="noPick">E-Bill *</label><select id="noPick"><option value="">— ${free.length} e-bills have this batch no: choose one —</option>
              ${free.map((r) => `<option value="${r.id}">${esc(`${r.bill_no} — ${r.company_name || ""}`)}</option>`).join("")}</select></div>`);
            $("#noPick").onchange = () => choose(free.find((r) => r.id === $("#noPick").value) || null);
          }
          showTypes();
        };
        $("#noFind").onclick = find;
        $("#noBatch").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); find(); } };
        // a batch no picked from the list is found at once
        $("#noBatch").onchange = () => { if (list.some((r) => String(r.batch_no || "").trim().toLowerCase() === $("#noBatch").value.trim().toLowerCase())) find(); };
        // opened from an e-bill: that e-bill is filled in
        who = list.find((r) => r.id === id && !waiting.has(r.id)) || null;
        if (who) $("#noBatch").value = who.batch_no || who.bill_no;
        showBill();
      } else {
        const emp = kind === "employee";
        box.innerHTML = busy();
        const { data, error } = emp ? await sb.from("employees").select("*").order("first_name") : await sb.from("pay_companies").select("*").order("name");
        if (error) { box.innerHTML = ""; return fail(error, "Could not load the list"); }
        // An order is never for your own employee record.
        const list = (data || []).filter((r) => !(emp && r.profile_id === S.profile.id));
        box.innerHTML = `<div class="fields wide"><label for="noPick">${emp ? "Employee" : "Company"} *</label><select id="noPick"><option value="">— Choose ${emp ? "the employee" : "the company"} —</option>
          ${list.map((r) => `<option value="${r.id}" ${r.id === id ? "selected" : ""}>${esc(emp ? `${r.employee_no} — ${fullName(r)}` : r.name)} (${esc(String(r.status).toUpperCase())})</option>`).join("")}</select></div>`;
        $("#noPick").onchange = () => { who = list.find((r) => r.id === $("#noPick").value) || null; dirty = false; showTypes(); };
        who = list.find((r) => r.id === id) || null;
      }
      showTypes();
    };
    $$("input[name=noKind]").forEach((r) => (r.onchange = () => { kind = r.value; showWho(null); }));
    ["noAmt", "noN", "noDue", "noInst"].forEach((id) => ($("#" + id).oninput = () => { touched.add(id); refresh(); }));
    ["noDate", "noEvery", "noReason", "noReason2", "noRelDate", "noShipAmt", "noPpb", "noRate"].forEach((id) => ($("#" + id).oninput = refresh));
    $$("input[name=noAdj]").forEach((r) => (r.onchange = refresh));
    $("#noReason").onchange = refresh;
    $("#noDetails").oninput = () => (dirty = true);
    $("#noCancel").onclick = () => history.back();
    await showWho(presetId);
    $("#noForm").onsubmit = async (e) => {
      e.preventDefault();
      const t = type(), cust = kind === "customer";
      if (!who) return toast(kind === "stock_bill" ? "Type the batch no and press Find." : `Choose the ${KINDS[kind].label.toLowerCase()}.`, true);
      if (!types().includes(t)) return toast(`This ${KINDS[kind].label.toLowerCase()} is ${String(who.status).toUpperCase()} — choose one of the orders shown.`, true);
      if (!$("#noSubj").value.trim()) return toast("Enter the subject.", true);
      if (kind === "stock_bill") {
        if (!$("#noRelDate").value) return toast("Enter the released date.", true);
        if (who.shipment_date && $("#noRelDate").value < who.shipment_date) return toast("The released date cannot be before the shipment date.", true);
        if (!(num(who.total_boxes) > 0)) return toast(`E-Bill ${who.bill_no} has no total boxes. Correct the e-bill first.`, true);
        if (!(num($("#noPpb").value) > 0)) return toast("Enter the price per box (PHP).", true);
        if (!(num($("#noRate").value) > 0)) return toast("Enter the exchange rate of today (BDT for 1 PHP).", true);
        if ($("#noShipAmt").value.trim() === "" || num($("#noShipAmt").value) < 0) return toast("Enter the shipping fee (0 if there is none).", true);
      }
      if (cust && t === "closure" && !reason()) return toast("Choose the reason for closing the account.", true);
      const amtOn = cust && AMOUNT_TYPES.includes(t), amt = num($("#noAmt").value), n = Math.floor(num($("#noN").value));
      if (amtOn && amt <= 0) return toast("Enter the amount.", true);
      if (["promise_to_pay", "installment"].includes(t) && !$("#noDue").value) return toast("Enter the due date.", true);
      if (t === "installment" && n < 1) return toast("Enter the number of installments.", true);
      const adj = $("input[name=noAdj]:checked")?.value;
      if (t === "settlement" && !adj) return toast("Choose: take the amount off the balance, or add it to the balance.", true);
      if (!$("#noDetails").value.trim()) return toast(t === "balance_certificate" ? "Write the purpose of the certificate." : "Write the details of the order.", true);
      const rec = {
        order_date: $("#noDate").value || isoToday(), subject: $("#noSubj").value.trim(),
        details: $("#noDetails").value.trim(), resolution: $("#noRes").value.trim() || null,
        amount: amtOn ? amt : null, first_due_date: amtOn ? $("#noDue").value || null : null,
        installments: t === "installment" ? n : null, installment_amount: t === "installment" && $("#noInst").value ? num($("#noInst").value) : null,
        installment_every: t === "installment" ? $("#noEvery").value : null, closure_reason: cust && t === "closure" ? reason() : null,
        adjust_type: t === "settlement" ? adj : null,
        ...(kind === "stock_bill" ? { release_date: $("#noRelDate").value, price_per_box: num($("#noPpb").value), exchange_rate: num($("#noRate").value), shipping_cost: num($("#noShipAmt").value) } : {})
      };
      E.setBusy(e.target, true, edit ? "Saving" : "Submitting");
      const { data, error } = edit ? await sb.rpc("update_pending_order", { p_id: edit.id, p_changes: rec })
        : await sb.from("order_letters").insert({ [kind === "employee" ? "employee_id" : kind === "company" ? "company_id" : kind === "stock_bill" ? "stock_bill_id" : "customer_id"]: who.id,
          subject_type: t, ...rec }).select().single();
      if (error) { E.setBusy(e.target, false); return fail(error, "Could not save the order"); }
      // the shipping fee receipt goes with the Released Notice
      const upFail = kind === "stock_bill" ? await E.uploadRecords("order_letter", data.id, "shipping_bill", E.filesOf("noShipFile")) : 0;
      const upNote = upFail ? " The shipping fee receipt failed to upload: upload it again on the order." : "";
      // Every order waits for approval first, the Director's too, so it can still be checked and changed.
      toast(edit ? `${data.order_no} saved.${upNote}` : isAdmin() ? `${data.order_no} saved. Check it, then press Approve & Carry Out.${upNote}`
        : `${data.order_no} sent to the Director for approval.${upNote}`, !!upNote);
      location.hash = "order/" + data.id;
    };
  };

  // The Authorized Representative: once the Director approves, the Director's signature over the name.
  const authBlock = (approved, o, sign) => `<div class="ol-auth${sign?.pic ? " has-sig" : ""}">${sign?.pic ? `<img class="esig" src="${esc(sign.pic)}" alt="Signature">` : ""}<div class="ol-auth-name">${approved ? esc(o.approved_by_name || "") : "&nbsp;"}</div><div class="line"></div>Authorized Representative</div>`;
  // A printed paragraph: dates (10-14-2026) and record numbers (EO-2026-10-0001, I-17) are not split over two lines.
  const para = (s) => esc(s).replace(/\b(\d{2}-\d{2}-\d{4}|[A-Z]{1,6}(?:-\d+)+)\b/g, '<span class="nw">$1</span>').replace(/\n/g, "<br>");
  // The printed order, laid out like an official order: details of the order, the customer / employee /
  // company information, the order itself with what it is about (amount due, promise, installment schedule,
  // reason for closing) and the decision, then APPROVED / DISAPPROVED with the date signed and one line for
  // the authorized representative. A balance certificate has its own layout.
  function letterPage(o) {
    if (o.subject_type === "balance_certificate") return certificatePage(o);
    const kind = kindOf(o);
    const w = (kind === "employee" ? o.employees : kind === "company" ? o.pay_companies : o.customers) || {};
    const v = (x) => (x == null || x === "" ? "—" : esc(x));
    const tr = (k, html) => `<tr><th>${esc(k)}</th><td>${html}</td></tr>`;
    const php = (n) => `PHP ${peso(n)}`;
    const contact = [w.phone, w.email].filter(Boolean).join(" · ");
    const si = o.stock_info || {};
    const info = kind === "stock_bill" ? [["E-Bill No", si.bill_no], ["Company", si.company], ["Bill No", si.supplier_bill_no], ["Batch No", si.batch_no], ["System Record No", si.shipment_no],
        ["Shipment Date", si.shipment_date ? E.mdy(si.shipment_date) : ""], ["Total Boxes", si.total_boxes == null ? "" : String(si.total_boxes)], ["Total Qty", si.total_qty == null ? "" : qtyText(si.total_qty)]]
      : kind === "employee" ? [["Name of Employee", fullName(w)], ["Employee No", w.employee_no], ["Position", w.position], ["Date Hired", w.date_hired ? E.mdy(w.date_hired) : ""], ["Contact Details", contact], ["Address", w.address]]
      // a company: its name and the authorized person only
      : kind === "company" ? [["Name of Company", w.name], ["Authorized Person", w.contact_person]]
      // a customer: the name and account no only; all the details when the account is closed, reactivated or reopened
      : ["closure", "reactivation", "reopen"].includes(o.subject_type)
        ? [["Name of Customer", fullName(w)], ["Account No", w.account_no], ["Business Name", w.business_name], ["Address", w.address], ["Contact Details", contact]]
      : [["Name of Customer", fullName(w)], ["Account No", w.account_no]];
    const approved = ["approved", "applied"].includes(o.status), rejected = o.status === "rejected";
    const signed = (approved || rejected) && o.approved_at ? E.mdy(dayOf(o.approved_at)) : "";
    const sign = approved ? E.approvedBy(o.approved_by, o.approved_by_name, o.approved_at) : null;
    const overdue = o.days_overdue != null ? tr("No. of Days Overdue", `${o.days_overdue} day(s)`) : "";
    const t = o.subject_type;
    // What the order is about, by kind of order. A Released Notice is all in BDT: price per box (PHP) × boxes = total
    // (PHP), × the exchange rate of the day = the released charge (BDT), + the bill cost and the shipping fee = total cost.
    const relTotal = num(si.bill_cost) + num(o.release_bdt) + num(o.shipping_cost);
    const about = t === "release" ? `${tr("Released Date", `<b>${v(E.mdy(o.release_date))}</b>`)}
        ${o.release_bdt != null ? `${tr("Price per Box", `PHP ${peso(o.price_per_box)}`)}${tr("Total (PHP)", `PHP ${peso(o.release_php)} <small>(${esc(si.total_boxes ?? "")} boxes × PHP ${peso(o.price_per_box)})</small>`)}
        ${tr("Exchange Rate of the Day", `BDT ${rateText(o.exchange_rate)} for 1 PHP`)}${tr("Released Charge (BDT)", `<b>BDT ${peso(o.release_bdt)}</b> <small>(PHP ${peso(o.release_php)} × ${rateText(o.exchange_rate)})</small>`)}` : ""}
        ${tr("Bill Cost (BDT)", `BDT ${peso(si.bill_cost)}`)}${tr("Shipping Fee (BDT)", `BDT ${peso(o.shipping_cost)}`)}
        ${tr("Total Cost (BDT)", `<b>BDT ${peso(relTotal)}</b> <small>(${esc(words(relTotal, "TAKA"))})</small>`)}`
      : t === "promise_to_pay" ? `${o.balance_due != null ? tr("Amount Due Today", php(o.balance_due)) : ""}${overdue}
        ${o.amount != null ? tr("Amount to Pay", `<b>${php(o.amount)}</b> <small>(${esc(words(o.amount))})</small>`) : ""}${o.first_due_date ? tr("Promise Date (Due Date)", `<b>${v(E.mdy(o.first_due_date))}</b>`) : ""}`
      : t === "installment" ? `${o.balance_due != null ? tr("Amount Due Today", php(o.balance_due)) : ""}${o.amount != null ? tr("Total Amount", `<b>${php(o.amount)}</b> <small>(${esc(words(o.amount))})</small>`) : ""}
        ${o.installments ? tr("Installments", `${o.installments} × ${php(o.installment_amount)}, ${esc((EVERY[o.installment_every] || EVERY.month).toLowerCase())}`) : ""}${o.first_due_date ? tr("First Due Date", v(E.mdy(o.first_due_date))) : ""}`
      : ["unpaid", "unsettled_balance"].includes(t) ? `${o.amount != null ? tr("Amount Due", `<b>${php(o.amount)}</b> <small>(${esc(words(o.amount))})</small>`) : ""}${overdue}${o.first_due_date ? tr("Pay On or Before", `<b>${v(E.mdy(o.first_due_date))}</b>`) : ""}`
      : t === "closure" && kind === "customer" ? `${tr("Reason for Closure", `<b>${v(o.closure_reason)}</b>`)}${o.balance_due != null ? tr("Closing Balance", php(o.balance_due)) : ""}`
      : t === "charge" ? `${o.balance_due != null ? tr("Previous Balance", php(o.balance_due)) : ""}${tr("Additional Charge", `<b>${php(o.amount)}</b> <small>(${esc(words(o.amount))})</small>`)}
        ${o.balance_due != null ? tr("New Balance", `<b>${php(num(o.balance_due) + num(o.amount))}</b>`) : ""}${o.first_due_date ? tr("Pay On or Before", `<b>${v(E.mdy(o.first_due_date))}</b>`) : ""}`
      : t === "settlement" ? `${o.balance_due != null ? tr("Previous Balance", php(o.balance_due)) : ""}
        ${tr("Settlement Adjustment", `<b>${ADJ[o.adjust_type]?.[1] || ""} ${php(o.amount)}</b> <small>(${esc(words(o.amount))})</small>`)}
        ${o.balance_due != null ? tr("New Balance", `<b>${php(num(o.balance_due) + (o.adjust_type === "reduce" ? -1 : 1) * num(o.amount))}</b>`) : ""}${o.first_due_date ? tr("Settle On or Before", `<b>${v(E.mdy(o.first_due_date))}</b>`) : ""}`
      : o.amount != null ? tr("Amount", `PHP ${peso(o.amount)} <small>(${esc(words(o.amount))})</small>`) : "";
    const plan = t === "installment" ? schedule(num(o.amount), num(o.installments), o.first_due_date, o.installment_every, num(o.installment_amount)) : [];
    // a Released Notice: "RELEASED I-17 ORDER FOR MODINA FASHION", type "RELEASED NOTICE I-17"
    const title = t === "release" ? `RELEASED ${batchOf(o) ? batchOf(o) + " " : ""}ORDER FOR ${String(si.company || "").toUpperCase()}`.trim() : TITLE[t] || "ORDER";
    return `${E.printHead(title, `<img src="${E.pdf417DataUrl("EMONORDER|" + o.order_no)}" alt="" class="ph-bar"><div class="mono">${esc(o.order_no)}</div>`)}
      <div class="ol-sec">DETAILS OF ORDER</div>
      <table class="ol-kv"><tbody>${tr("Type of Order", t === "release" ? `<b>${v(typeName(o).toUpperCase())}</b>` : v(o.subject))}${tr("Order For", v(KINDS[kind].label))}
        ${tr("Place of Issue", v(`${C.company.name} Main Office, ${C.company.address.join(", ")}`))}${tr("Order Date", v(E.mdy(o.order_date)))}${tr("Order No", `<b>${v(o.order_no)}</b>`)}</tbody></table>
      <p class="ol-intro">The following contains important information about this order, including the date it takes effect. Please keep this order for your records.</p>
      <div class="ol-sec">${esc(KINDS[kind].label.toUpperCase())} INFORMATION</div>
      <table class="ol-grid"><tbody>${info.map(([k, x]) => tr(k, v(x))).join("")}</tbody></table>
      <div class="ol-sec">ORDER</div>
      <table class="ol-grid"><tbody>
        ${tr("Subject", `<b>${v((o.subject || "").toUpperCase())}</b>`)}${about}
        ${tr(t === "promise_to_pay" || t === "installment" ? "Agreement" : "Details", o.details ? para(o.details) : "—")}
        ${o.resolution ? tr("Resolution / Terms", para(o.resolution)) : ""}
        ${tr("Effective Date", approved && o.approved_at ? v(signed) : "On approval")}
        <tr class="ol-dec"><th>DECISION</th><td>${approved ? "APPROVED" : rejected ? "DISAPPROVED" : "WAITING FOR APPROVAL"}</td></tr></tbody></table>
      ${plan.length ? `<div class="ol-sec">INSTALLMENT SCHEDULE</div>
        <table class="ol-grid ol-sched"><thead><tr><th>No.</th><th>Due Date</th><th>Amount (PHP)</th><th>Balance After (PHP)</th></tr></thead>
        <tbody>${plan.map((r) => `<tr><td>${r.no}</td><td>${esc(E.mdy(r.date))}</td><td class="num">${peso(r.amount)}</td><td class="num">${peso(r.left)}</td></tr>`).join("")}</tbody></table>` : ""}
      <div class="ol-sign">
        <div class="ol-ad"><span class="${approved ? "on" : ""}">APPROVED</span> / <span class="${rejected ? "on" : ""}">DISAPPROVED</span>
          <div>Date Signed: <span class="ol-date">${signed ? esc(signed) : "&nbsp;"}</span></div></div>
        ${authBlock(approved, o, sign)}
      </div>
      <div class="rp-foot"><span>Scan the barcode in the ${esc(E.APP)} to verify this order.</span><span>${esc(o.order_no)}</span></div>`;
  }
  // Account Balance Certificate: only the customer's name and account number (no personal details), the amount due
  // as of the date and one line for the authorized representative.
  function certificatePage(o) {
    const c = o.customers || {};
    const v = (x) => (x == null || x === "" ? "—" : esc(x));
    const tr = (k, html) => `<tr><th>${esc(k)}</th><td>${html}</td></tr>`;
    const approved = ["approved", "applied"].includes(o.status);
    const issued = approved && o.approved_at ? E.mdy(dayOf(o.approved_at)) : "";
    const sign = approved ? E.approvedBy(o.approved_by, o.approved_by_name, o.approved_at) : null;
    const asOf = E.mdy(o.order_date), bal = num(o.balance_due);
    return `${E.printHead("ACCOUNT BALANCE CERTIFICATE", `<img src="${E.pdf417DataUrl("EMONORDER|" + o.order_no)}" alt="" class="ph-bar"><div class="mono">${esc(o.order_no)}</div>`)}
      <div class="cert-no"><span>Certificate No: <b>${esc(o.order_no)}</b></span><span>Date Issued: <b>${issued ? esc(issued) : "—"}</b></span></div>
      <p class="cert-to">TO WHOM IT MAY CONCERN:</p>
      <p class="cert-body">This is to certify that <b>${esc(fullName(c).toUpperCase())}</b>, holder of account <b>${esc(c.account_no || "")}</b> with ${esc(C.company.name)},
        ${bal > 0 ? `has an outstanding balance of <b>PHP ${peso(bal)}</b> (${esc(words(bal))}) as of ${esc(asOf)}.` : `has <b>no outstanding balance</b> as of ${esc(asOf)}.`}</p>
      <div class="ol-sec">ACCOUNT DETAILS</div>
      <table class="ol-grid"><tbody>${tr("Name of Customer", v(fullName(c)))}${tr("Account No", v(c.account_no))}</tbody></table>
      <div class="ol-sec">BALANCE</div>
      <table class="ol-grid"><tbody>${tr("Current Amount Due", `<b>PHP ${peso(bal)}</b>`)}${tr("Amount in Words", esc(words(bal)))}${tr("As Of", esc(asOf))}
        ${bal > 0 ? tr("No. of Days Overdue", `${num(o.days_overdue)} day(s)`) : ""}</tbody></table>
      <p class="cert-body">${para(o.details || "")}</p>
      <p class="cert-body">Issued${issued ? ` on ${esc(issued)}` : ""} at ${esc(C.company.name)} Main Office, ${esc(C.company.address.join(", "))}.</p>
      ${approved ? "" : `<div class="cert-wait">NOT VALID UNTIL APPROVED</div>`}
      <div class="ol-sign one">${authBlock(approved, o, sign)}</div>
      <div class="rp-foot"><span>Scan the barcode in the ${esc(E.APP)} to verify this certificate.</span><span>${esc(o.order_no)}</span></div>`;
  }
  // Print an order by its id (used from My Profile).
  async function printOrder(id) {
    const [{ data: o, error }] = await Promise.all([sb.from("order_letters").select(ORDER_ALL).eq("id", id).maybeSingle(), E.loadSignatures()]);
    if (error || !o) return toast("This order could not be opened.", true);
    E.openPreview(`Order ${o.order_no}`, [letterPage(o)]);
  }

  // An order can be changed while it waits for approval: by the person who sent it, or by the Director.
  const canEditOrder = (o) => o.status === "pending" && (isAdmin() || (o.created_by === S.profile?.id && KINDS[kindOf(o)].write()));
  // #editorder/<id>: the Request Order form with the order filled in
  V.editorder = async (id) => {
    E.shell("editorder", "Edit Order", busy());
    const { data: o } = await sb.from("order_letters").select(ORDER_ALL).eq("id", id).maybeSingle();
    if (location.hash !== "#editorder/" + id) return;
    if (!o) { $("#main").innerHTML = `<div class="empty">Order not found. <a href="#orders">Back</a></div>`; return; }
    if (!canEditOrder(o)) {
      toast(o.status === "pending" ? "Only the person who sent this order or the Director can change it." : `Order ${o.order_no} is already ${String(o.status).toUpperCase()}. Only an order waiting for approval can be changed.`, true);
      location.hash = "order/" + id; return;
    }
    return V.neworder(null, null, o);
  };

  V.order = async (id) => {
    E.shell("order", "Order Letter", busy());
    const { data: o } = await sb.from("order_letters").select(ORDER_ALL).eq("id", id).maybeSingle();
    if (!o) { $("#main").innerHTML = `<div class="empty">Order not found. <a href="#orders">Back</a></div>`; return; }
    const att = await E.attachmentsOf("order_letter", id);
    const kind = kindOf(o), si = o.stock_info || {};
    const w = kind === "employee" ? o.employees : kind === "company" ? o.pay_companies : kind === "stock_bill" ? { status: o.stock_bills?.status } : o.customers;
    const page = { customer: "customer/" + o.customer_id, employee: "employee/" + o.employee_id, company: "paycompany/" + o.company_id, stock_bill: "stockbill/" + o.stock_bill_id }[kind];
    const whoHtml = kind === "stock_bill" ? `<a href="#${page}"><b>${esc(si.bill_no || "")}</b> (${esc(si.company || "")})</a> ${w.status ? E.ebillPill(w.status) : ""}` : !w ? "—" : `<a href="#${page}"><b>${esc(kind === "company" ? w.name : fullName(w))}</b>${kind === "company" ? "" : ` (${esc(kind === "employee" ? w.employee_no : w.account_no)})`}</a> ${pill(w.status)}`;
    const closeTo = E.canOpen("orders") ? "orders" : page;
    $(".band h1").textContent = `Order — ${o.order_no}`;
    const editable = canEditOrder(o);
    const banner = {
      pending: `<div class="banner warn">${isAdmin() ? "Waiting for approval. Check the order (Print Preview), change it with <b>Edit Order</b> if needed, then press <b>Approve &amp; Carry Out</b>."
        : `Waiting for the Director to approve.${editable ? " You can still change it with <b>Edit Order</b>." : ""} Once approved, it is carried out straight away.`}</div>`,
      approved: `<div class="banner ok">✔ APPROVED by ${esc(o.approved_by_name || "")} on ${mdy(dayOf(o.approved_at))}.</div>`,
      applied: `<div class="banner ok">✔ APPROVED by ${esc(o.approved_by_name || "")} and carried out on ${mdy(dayOf(o.applied_at))} — ${esc(o.applied_result || "")}</div>`,
      rejected: `<div class="banner closed">DISAPPROVED by ${esc(o.approved_by_name || "")}${o.review_note ? " — " + esc(o.review_note) : ""}</div>`
    }[o.status] || "";
    $("#main").innerHTML = `${banner}
      <div class="window"><div class="wtitle">${esc(o.order_no)} — ${esc(typeName(o))} ${pill(o.status)}</div><div class="wbody">
        <div class="formgrid"><div class="fields wide">
          <span>${esc(KINDS[kind].label)}</span><span>${whoHtml}</span>
          <span>Subject</span><b>${esc(o.subject)}</b><span>Order Date</span><span>${mdy(o.order_date)}</span>
          <span>Prepared By</span><span>${esc(o.created_by_name || "")}</span></div>
          <div class="fields wide">${o.balance_due != null ? `<span>Amount Due</span><span>₱ ${peso(o.balance_due)}${o.days_overdue ? ` · ${o.days_overdue} day(s) overdue` : ""}</span>` : ""}
            ${o.subject_type === "release" ? `<span>Released Date</span><b>${mdy(o.release_date)}</b>
              ${o.release_bdt != null ? `<span>Price per Box</span><span>₱ ${peso(o.price_per_box)} × ${esc(si.total_boxes ?? "")} boxes = ₱ ${peso(o.release_php)}</span>
              <span>Exchange Rate</span><span>BDT ${rateText(o.exchange_rate)} for 1 PHP</span><span>Released Charge</span><b>BDT ${peso(o.release_bdt)}</b>` : ""}
              <span>Bill Cost</span><span>BDT ${peso(si.bill_cost)}</span><span>Shipping Fee</span><span>BDT ${peso(o.shipping_cost)}</span>
              <span>Total Cost</span><b>BDT ${peso(num(si.bill_cost) + num(o.release_bdt) + num(o.shipping_cost))}</b>` : ""}
            ${o.closure_reason ? `<span>Reason for Closure</span><b>${esc(o.closure_reason)}</b>` : ""}${o.amount != null ? `<span>${o.subject_type === "promise_to_pay" ? "Amount to Pay" : o.subject_type === "charge" ? "Charge Amount" : o.subject_type === "settlement" ? "Adjustment" : "Amount"}</span><b>${o.subject_type === "settlement" ? `${ADJ[o.adjust_type]?.[0] || ""} ` : ""}₱ ${peso(o.amount)}</b>` : ""}
            ${["charge", "settlement"].includes(o.subject_type) && o.balance_due != null ? `<span>New Balance</span><b>₱ ${peso(num(o.balance_due) + (o.adjust_type === "reduce" ? -1 : 1) * num(o.amount))}</b>` : ""}
            ${o.installments ? `<span>Installments</span><span>${o.installments} × ₱ ${peso(o.installment_amount)}, ${esc((EVERY[o.installment_every] || EVERY.month).toLowerCase())}</span>` : ""}${o.first_due_date ? `<span>${o.subject_type === "installment" ? "First Due Date" : "Due Date"}</span><span>${mdy(o.first_due_date)}</span>` : ""}</div></div>
        <div class="letter-box"><div class="lb-h">Details</div><p>${esc(o.details || "").replace(/\n/g, "<br>")}</p>${o.resolution ? `<div class="lb-h">Resolution / Terms</div><p>${esc(o.resolution).replace(/\n/g, "<br>")}</p>` : ""}</div>
        <div class="docgrid">${E.docCard({ key: "ol", title: `${o.subject_type === "balance_certificate" ? "Account Balance Certificate" : "Order"} ${o.order_no}`,
          sub: o.status === "rejected" ? "Disapproved by the Director" : "The Director's signature is printed on it once approved", ownerType: "order_letter", ownerId: o.id, att, canUpload: false,
          print: () => E.openPreview(`Order ${o.order_no}`, [letterPage(o)]), approved: ["approved", "applied"].includes(o.status) ? { name: o.approved_by_name, at: o.approved_at } : null })}</div>
        ${att.some((a) => a.kind !== "signed_form") ? `<div class="sb-subh">Files</div>${E.filesHtml(att.filter((a) => a.kind !== "signed_form"))}` : ""}
        ${isAdmin() && o.status === "pending" ? `<fieldset class="opt review"><legend>Director's Approval</legend><div class="fields wide"><label for="olNote">Note</label><input type="text" id="olNote" placeholder="Optional"></div>
          <div class="btnrow"><button type="button" class="btn ok" id="olApprove">${ic("check")} ${o.subject_type === "balance_certificate" ? "Approve &amp; Issue" : "Approve &amp; Carry Out"}</button><button type="button" class="btn danger" id="olReject">Reject</button></div></fieldset>` : ""}
        ${rhBox("order_letters", o.id)}
      </div><div class="wfoot">${editable ? `<a class="btn" href="#editorder/${o.id}" id="olEdit">${ic("edit")} Edit Order</a>` : ""}${recordTools("order_letters", o, `Order ${o.order_no}`, { reload: () => V.order(id), afterDelete: () => (location.hash = closeTo) })}<a class="btn" href="#${closeTo}">Close</a></div></div>`;
    E.bindDocCards($("#main"), () => V.order(id));
    if (kind === "stock_bill") setCurrency(true);
    E.bindFiles($("#main"));
    bindRecordTools($("#main"));
    const review = async (action) => {
      const { data: r, error } = await sb.rpc("review_order_letter", { p_id: id, p_action: action, p_note: $("#olNote").value.trim() || null });
      if (error) return fail(error, "Could not update the order");
      toast(action === "approve" ? `${o.order_no} carried out — ${r?.applied_result || "done"}.` : `${o.order_no} rejected.`);
      V.order(id);
    };
    if ($("#olApprove")) $("#olApprove").onclick = () => review("approve");
    if ($("#olReject")) $("#olReject").onclick = async () => { if (await E.confirmBox(`Reject order <b>${esc(o.order_no)}</b>?`, { ok: "Reject", danger: true })) review("reject"); };
    E.setRecords(`Order: ${o.order_no}`);
  };

  // ======================================================================
  // Verification — anyone can check a record by number, QR code or barcode
  // ======================================================================
  const OPEN = {
    "Customer Account": ["customers", "account_no", "customer"], Invoice: ["customer_invoices", "invoice_no", "invoice"], "Payment Receipt": ["payments_received", "receipt_no", "payment"],
    "Credit Memo": ["credit_memos", "memo_no", "creditmemo"], "Statement of Account": ["statements", "statement_no", "customer", "customer_id"], "Order Letter": ["order_letters", "order_no", "order"],
    "Payment Voucher": ["pay_vouchers", "voucher_no", "voucher"], Payslip: ["payslips", "payslip_no", "payslip"], "Job Application": ["job_applications", "application_no", "jobapp"],
    Employee: ["employees", "employee_no", "employee"], Project: ["projects", "project_no", "project"], "Project Payment": ["project_payments", "payment_no", "project", "project_id"],
    "E-Bill Statistics": ["stock_bills", "bill_no", "stockbill"], "Stock-Bill Statistics": ["stock_bills", "bill_no", "stockbill"]
  };
  const verifyUrl = (no) => `${location.origin}${location.pathname}#verify/${encodeURIComponent(no)}`;
  V.verify = async (code) => {
    const inside = !!(S.session && S.profile?.status === "active");
    const body = `
      <section class="verify-hero">
        <div class="vh-badge">${ic("shield")}</div>
        <h2>Verify a Record</h2>
        <p>Type the record number, or scan its QR code or barcode, then press <b>Verify</b>. Anyone can check a record.</p>
        <form id="vfForm" class="vf-form" autocomplete="off">
          <input type="text" id="vfCode" aria-label="Record number" placeholder="e.g. INV-202610-0001 · A-2026-1004-001 · BD20261004001 · EO-2026-10-0001" value="${esc(code || "")}" autocapitalize="characters" spellcheck="false">
          <button type="submit" class="btn primary">${ic("check")} Verify</button>
        </form>
        <div class="btnrow center"><button type="button" class="btn" id="vfScan">${ic("camera")} Scan with Camera</button><label class="btn" for="vfImg">${ic("image")} Upload Photo of Code</label><input type="file" id="vfImg" accept="image/*" hidden></div>
      </section>
      <div id="vfResult"></div>`;
    if (inside) E.shell("verify", "Verification", body); else E.miniShell("Verification", body, { home: "#verify" });
    const run = async (raw) => {
      const t = String(raw || "").trim();
      if (!t) return toast("Type a record number or scan its code.", true);
      $("#vfCode").value = t.replace(/^.*#verify\//i, "");
      $("#vfResult").innerHTML = `<div class="vf-wait">${busy("Searching the records")}</div>`;
      const shown = $("#vfCode").value;
      if (decodeURIComponent(location.hash.slice(1)) !== "verify/" + shown) history.replaceState(null, "", "#verify/" + encodeURIComponent(shown));
      const [{ data, error }] = await Promise.all([sb.rpc("verify_record", { p_code: t }), new Promise((r) => setTimeout(r, 450))]);
      const out = $("#vfResult"); if (!out) return;
      if (error) { out.innerHTML = `<div class="vf-bad"><div class="vf-seal">!</div><div class="vf-title">CANNOT CHECK RIGHT NOW</div><div class="vf-sub">${esc(error.message)}</div></div>`; return; }
      if (!data?.found) {
        out.innerHTML = `<div class="vf-bad"><div class="vf-seal">✖</div><div class="vf-title">NO RECORD FOUND</div>
          <div class="vf-sub">“${esc(shown)}” is not a record in the ${esc(E.APP)}. Check the number and try again.</div></div>`;
        return;
      }
      const checked = new Date();
      // A found record shows on its own (no search box above it). Verification in the menu, or the
      // E-Portal name on the public page, opens the search again.
      $(".verify-hero").hidden = true;
      window.scrollTo(0, 0);
      // Anyone can verify and view; only employees signed in to the portal get the Validated Print.
      out.innerHTML = `<div class="vf-ok">
        <div class="vf-seal">${ic("check")}</div>
        <div class="vf-title">RECORD FOUND</div>
        <div class="vf-sub">VERIFIED BY ${esc(C.company.name)}</div>
        <div class="vf-type">${esc(data.type)} · <b class="mono">${esc(data.number)}</b> ${data.status ? pill(data.status) : ""}</div>
        <table class="vf-fields"><tbody>${(data.fields || []).map(([k, v]) => `<tr class="${/^Net (Profit|Loss)/.test(k) ? "vf-hl" : ""}"><th>${esc(k)}</th><td>${esc(E.fixDates(v))}</td></tr>`).join("")}</tbody></table>
        <div class="vf-when">Checked ${esc(E.dateTime(checked.toISOString()))}</div>
        ${inside ? `<div class="btnrow center"><button type="button" class="btn primary" id="vfPrint">${ic("print")} Validated Print</button>${OPEN[data.type] ? `<button type="button" class="btn" id="vfOpen">${ic("eye")} Open Record</button>` : ""}</div>` : ""}</div>`;
      if ($("#vfPrint")) $("#vfPrint").onclick = () => validatedPrint(data, checked);
      if ($("#vfOpen")) $("#vfOpen").onclick = async () => {
        const [table, col, route, via] = OPEN[data.type];
        const { data: row } = await sb.from(table).select(via ? `id, ${via}` : "id").eq(col, data.number).maybeSingle();
        if (!row) return toast("You do not have access to open this record.", true);
        location.hash = `${route}/${via ? row[via] : row.id}`;
      };
    };
    $("#vfForm").onsubmit = (e) => { e.preventDefault(); run($("#vfCode").value); };
    $("#vfScan").onclick = () => E.scanDialog((t) => run(t), { title: "Scan to Verify" });
    $("#vfImg").onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      $("#vfResult").innerHTML = `<div class="vf-wait">${busy("Reading the code")}</div>`;
      try { run(await E.decodeImageFile(f)); } catch (err) { $("#vfResult").innerHTML = `<div class="vf-bad"><div class="vf-seal">✖</div><div class="vf-title">CODE NOT READ</div><div class="vf-sub">${esc(err.message)}</div></div>`; }
      e.target.value = "";
    };
    if (code) run(code); else $("#vfCode").focus();
  };
  // Validated Print (A4), typewriter style: "VERIFIED BY …", RECORD FOUND with the search result, the record's details
  // (no amount due), then the validation number, time, the employee who printed it and a QR code to check it online
  // (for a customer, made from the Public ID key). System-generated: no signature.
  function validatedPrint(d, when) {
    const vno = "V" + when.toISOString().replace(/\D/g, "").slice(2, 14);
    const at = E.dateTime(when.toISOString());
    // Stored codes in plain words (cash → Cash); empty values are left out.
    const plain = (v) => /^[a-z][a-z ]*$/.test(String(v)) ? String(v).replace(/\b[a-z]/g, (x) => x.toUpperCase()) : String(v);
    const fields = (d.fields || []).filter(([k, v]) => v != null && !["", "—", "-"].includes(String(v).trim()) && !/^amount due/i.test(k));
    const idField = fields.find(([, v]) => String(v) === String(d.number));
    const idLabel = d.type === "Customer Account" ? "Customer ID" : idField ? idField[0] : "Record No";
    const who = fields.find(([k]) => ["Account Name", "Customer", "Received From", "Employee", "Name", "Applicant", "Paid To", "Account", "Company"].includes(k));
    const rest = fields.filter((f) => f !== idField);
    // the QR code checks the record again: a customer by the Public ID key, an e-bill only by its secret code
    const key = d.type === "Customer Account" ? (fields.find(([k]) => k === "Public ID") || [])[1] : /Bill Statistics$/.test(d.type) ? (fields.find(([k]) => k === "Secret Code") || [])[1] : null;
    const row = (k, v) => `<tr><th>${esc(k)}</th><td${k === "Public ID" ? ' class="key"' : ""}>${esc(v)}</td></tr>`;
    const rows = rest.map(([k, v]) => row(k, E.fixDates(plain(v)))).join("");
    const page = `<div class="vp">${E.printHead(`VERIFIED BY ${C.company.name}`)}
      <div class="vp-true"><span class="vp-seal">✔</span><div><b>RECORD FOUND</b><small>Search result: ${esc(d.number)}${who ? " · " + esc(who[1]) : ""}</small><small>Checked in the ${esc(E.APP)} on ${esc(at)}</small></div></div>
      ${E.box("Record Details", `<table class="vp-fields${rest.length > 16 ? " many" : ""}"><tbody>${row("Record Type", d.type)}${row(idLabel, d.number)}${rows}
        ${d.status && !rest.some(([k]) => /status/i.test(k)) ? row("Status", String(d.status).toUpperCase()) : ""}</tbody></table>`)}
      ${E.box("Validation", `<div class="vp-valid"><table class="vp-fields"><tbody>${row("Validation No", vno)}${row("Validated On", at)}${row("Validated By", S.profile?.full_name || "")}</tbody></table>
        <div class="vp-qr"><img src="${E.qrDataUrl(verifyUrl(key || d.number))}" alt="Verification QR code"><small>Scan to verify online</small></div></div>`)}
      <div class="vp-sys">This is a system-generated document. No signature is required.</div></div>`;
    E.openPreview(`Validated ${d.number}`, [page]);
  }

  // ======================================================================
  // Messages — chat between admin and employees, with photos and documents
  // ======================================================================
  const CH = { other: null, contacts: [], msgs: [], timer: null, tick: 0, busy: false };
  function openChat(withId) {
    let p = $(".chat-panel");
    if (!p) {
      p = document.createElement("div");
      p.className = "chat-panel";
      p.setAttribute("role", "dialog");
      p.setAttribute("aria-label", "Messages");
      p.innerHTML = `<div class="cp-head"><button type="button" class="cp-back" aria-label="Back to people">${ic("back")}</button><div class="cp-title">${ic("chat")} Messages</div><button type="button" class="cp-x" aria-label="Close messages">${ic("x")}</button></div>
        <div class="cp-body"><aside class="cp-list"><input type="search" class="cp-q" placeholder="Search people" aria-label="Search people"><div class="cp-contacts">${busy()}</div></aside>
          <section class="cp-conv"><div class="cp-empty">${ic("chat")}<p>Choose a person to start chatting.</p></div></section></div>`;
      document.body.appendChild(p);
      $(".cp-x", p).onclick = closeChat;
      $(".cp-back", p).onclick = () => { p.classList.remove("in-conv"); CH.other = null; };
      $(".cp-q", p).oninput = () => renderContacts();
      document.addEventListener("keydown", chatKey);
    }
    requestAnimationFrame(() => p.classList.add("open"));
    loadContacts().then(() => { if (withId) openConversation(withId); });
    clearInterval(CH.timer);
    CH.timer = setInterval(pollChat, 4000);
  }
  function chatKey(e) { if (e.key === "Escape" && !$(".modal") && $(".chat-panel.open")) closeChat(); }
  function closeChat() {
    const p = $(".chat-panel"); if (!p) return;
    clearInterval(CH.timer); CH.timer = null; CH.other = null;
    p.classList.remove("open");
    document.removeEventListener("keydown", chatKey);
    setTimeout(() => p.remove(), 320);
    E.refreshBadge();
  }
  async function loadContacts() {
    const { data, error } = await sb.rpc("chat_contacts");
    const box = $(".cp-contacts"); if (!box) return;
    if (error) { box.innerHTML = `<div class="empty small">Messages are not set up yet (run the 1.1 database update).</div>`; return; }
    CH.contacts = data || [];
    renderContacts();
  }
  function renderContacts() {
    const box = $(".cp-contacts"); if (!box) return;
    const q = ($(".cp-q")?.value || "").toLowerCase();
    const list = CH.contacts.filter((c) => !q || `${c.full_name} ${c.job_position}`.toLowerCase().includes(q));
    box.innerHTML = list.length ? list.map((c) => `<button type="button" class="cp-contact ${c.id === CH.other ? "on" : ""}" data-c="${c.id}">
        <span class="cp-av">${avatarOf(c)}<i class="dot ${E.online(c.last_seen_at) ? "on" : ""}"></i></span>
        <span class="cp-who"><b>${esc(c.full_name || "")}${c.verified ? `<span class="vbadge sm" title="Verified">${ic("check")}</span>` : ""}</b><small>${esc(c.job_position || "")} · ${E.online(c.last_seen_at) ? `<span class="on-txt">Active now</span>` : "Not active"}</small></span>
        ${c.unread ? `<span class="badge">${c.unread}</span>` : c.last_at ? `<small class="cp-time">${esc(E.timeAgo(c.last_at))}</small>` : ""}</button>`).join("")
      : `<div class="empty small">${CH.contacts.length ? "No one matches." : "No one else is active in the portal yet."}</div>`;
    $$(".cp-contact", box).forEach((b) => (b.onclick = () => openConversation(b.dataset.c)));
  }
  async function openConversation(otherId) {
    const p = $(".chat-panel"); if (!p) return;
    const c = CH.contacts.find((x) => x.id === otherId);
    if (!c) return toast("That person is not available for messages.", true);
    CH.other = otherId; CH.msgs = [];
    p.classList.add("in-conv");
    renderContacts();
    $(".cp-conv", p).innerHTML = `<div class="cv-head"><span class="cp-av">${avatarOf(c)}<i class="dot ${E.online(c.last_seen_at) ? "on" : ""}"></i></span>
        <div><b>${esc(c.full_name || "")}${c.verified ? `<span class="vbadge sm" title="Verified">${ic("check")}</span>` : ""}</b><small>${esc(c.job_position || "")} · ${E.online(c.last_seen_at) ? `<span class="on-txt">Active now</span>` : `Last seen ${esc(c.last_seen_at ? E.timeAgo(c.last_seen_at) : "—")}`}</small></div></div>
      <div class="cv-msgs" id="cvMsgs">${busy()}</div>
      <form class="cv-compose" id="cvForm"><label class="cv-attach" title="Send a photo or document" for="cvFile">${ic("clip")}</label>
        <input type="file" id="cvFile" hidden accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt">
        <input type="text" id="cvText" placeholder="Write a message…" autocomplete="off" aria-label="Message">
        <button type="submit" class="cv-send" aria-label="Send">${ic("send")}</button></form>`;
    $("#cvForm").onsubmit = (e) => { e.preventDefault(); sendMessage(); };
    $("#cvFile").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) sendMessage(f); };
    await loadMessages(true);
    $("#cvText")?.focus();
  }
  async function loadMessages(full) {
    const other = CH.other, me = meId();
    if (!other) return;
    let q = sb.from("messages").select("*").or(`and(sender_id.eq.${me},recipient_id.eq.${other}),and(sender_id.eq.${other},recipient_id.eq.${me})`).order("created_at", { ascending: true });
    const last = CH.msgs[CH.msgs.length - 1];
    if (!full && last) q = q.gt("created_at", last.created_at); else q = q.limit(300);
    const { data, error } = await q;
    if (error || other !== CH.other) return;
    const fresh = (data || []).filter((m) => !CH.msgs.some((x) => x.id === m.id));
    if (!full && !fresh.length) return;
    CH.msgs = full ? data || [] : CH.msgs.concat(fresh);
    if (CH.msgs.some((m) => m.sender_id === other && !m.read_at)) {
      sb.rpc("mark_messages_read", { p_other: other }).then(() => { E.refreshBadge(); }, () => {});
      const c = CH.contacts.find((x) => x.id === other);
      if (c && c.unread) { c.unread = 0; renderContacts(); }
    }
    await renderMessages();
  }
  async function renderMessages() {
    const box = $("#cvMsgs"); if (!box) return;
    const urls = await signedMap(CH.msgs.filter((m) => m.file_path).map((m) => m.file_path));
    const me = meId();
    let lastDay = "";
    box.innerHTML = CH.msgs.length ? CH.msgs.map((m) => {
      const day = new Date(m.created_at).toDateString();
      const sep = day !== lastDay ? `<div class="cv-day">${esc(E.mdy(m.created_at))}</div>` : "";
      lastDay = day;
      const u = m.file_path ? urls.get(m.file_path) : "";
      const isImg = /^image\//.test(m.file_mime || "");
      const file = m.file_path ? (isImg && u ? `<button type="button" class="cv-img" data-img="${esc(u)}"><img src="${esc(u)}" alt="${esc(m.file_name || "Photo")}" loading="lazy"></button>`
        : `<a class="cv-file" href="${esc(u || "#")}" target="_blank" rel="noopener" download="${esc(m.file_name || "file")}">${ic("doc")} ${esc(m.file_name || "Document")}</a>`) : "";
      return `${sep}<div class="cv-msg ${m.sender_id === me ? "me" : "them"}">${file}${m.body ? `<div class="cv-text">${esc(m.body)}</div>` : ""}
        <small>${esc(new Date(m.created_at).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" }))}${m.sender_id === me ? (m.read_at ? " · Seen" : " · Sent") : ""}</small></div>`;
    }).join("") : `<div class="cp-empty small"><p>No messages yet. Say hello!</p></div>`;
    $$("[data-img]", box).forEach((b) => (b.onclick = () => lightbox(b.dataset.img)));
    box.scrollTop = box.scrollHeight;
  }
  async function sendMessage(file) {
    const other = CH.other; if (!other || CH.busy) return;
    const input = $("#cvText");
    const body = file ? "" : input.value.trim();
    if (!file && !body) return;
    CH.busy = true;
    const btn = $(".cv-send"); if (btn) btn.disabled = true;
    let rec = { recipient_id: other, body: body || null };
    if (file) {
      if (file.size > 25 * 1024 * 1024) { CH.busy = false; if (btn) btn.disabled = false; return toast("This file is too big. Files up to 25 MB can be sent.", true); }
      const f = await shrinkImage(file);
      const path = `chat/${E.uuid()}/${f.name.replace(/[^\w.\-]+/g, "_")}`;
      const up = await sb.storage.from("records").upload(path, f, { contentType: f.type || "application/octet-stream" });
      if (up.error) { CH.busy = false; if (btn) btn.disabled = false; return fail(up.error, "Could not send the file"); }
      rec = { ...rec, file_path: path, file_name: file.name, file_mime: f.type || "application/octet-stream" };
    }
    const { error } = await sb.from("messages").insert(rec);
    CH.busy = false; if (btn) btn.disabled = false;
    if (error) return fail(error, "Could not send the message");
    if (!file && input) input.value = "";
    await loadMessages(false);
  }
  async function pollChat() {
    if (!$(".chat-panel") || document.visibilityState !== "visible") return;
    CH.tick++;
    if (CH.other) await loadMessages(false);
    if (CH.tick % 4 === 0) loadContacts();
  }

  Object.assign(E, { recordTools, bindRecordTools, correctRecord, deleteRecord, rhBox, fieldLabel, ordersGrid, printOrder, openChat, closeChat, shrinkImage, signedMap, lightbox });
})();
