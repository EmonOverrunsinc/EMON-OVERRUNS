/* EMON OVERRUNS E-PORTAL — job applicant portal, 6 Community, 9 Order Letter, Verification (public),
   Messages (chat), Change Requests, and the Edit / Request Change / Delete tools used on every record. */
(function () {
  "use strict";
  const E = window.EO;
  const { sb, S, C, esc, peso, isoToday, dmy, $, $$, isAdmin, isStaff, pill, toast, fail, words, ic, busy } = E;
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
  // Edit / Request Change / Delete (every record)
  // ======================================================================
  const F = (k, label, type = "text", opts) => ({ k, label, type, opts });
  const METHODS = [["cash", "Cash"], ["bank_transfer", "Bank Transfer"], ["online_transfer", "Online Transfer"], ["deposit", "Bank Deposit"]];
  // Must match editable_columns() in the database.
  const FIELDS = {
    customers: [F("first_name", "First Name"), F("last_name", "Last Name"), F("phone", "Phone"), F("email", "Email", "email"), F("address", "Full Address"), F("business_name", "Business Name"), F("business_start_date", "Date Starting in Business", "date"), F("facebook_name", "Facebook Name"), F("has_extra_facebook", "Has Additional Facebook", "bool"), F("extra_facebook_name", "Additional Facebook Name"), F("facebook_verified", "Facebook Verified", "bool")],
    customer_invoices: [F("invoice_date", "Invoice Date", "date"), F("purchase_date", "Date of Purchase", "date"), F("po_number", "PO Number"), F("total_boxes", "Total Boxes", "int"), F("total_pcs", "Total Pcs", "int"), F("total_amount", "Total Amount (₱)", "money")],
    payments_received: [F("paid_date", "Date Paid", "date"), F("amount", "Amount (₱)", "money"), F("method", "Method", "select", METHODS), F("bank_name", "Bank Name"), F("bank_account", "Deposit Account"), F("reference_no", "Reference No"), F("notes", "Notes")],
    credit_memos: [F("memo_date", "Report Date", "date"), F("payment_ref", "Payment Reference"), F("po_number", "Purchase Order"), F("article", "Article"), F("brand", "Brand"), F("style", "Style"), F("batch_no", "Batch No"), F("serial_no", "Serial No"), F("qty", "Qty", "int"), F("purchase_date", "Purchase Date", "date"),
      F("defect_category", "Defect Category", "select", [["fabric_damage", "Fabric Damage"], ["color_issue", "Color Issue"], ["wrong_box", "Wrong Box Delivered"], ["wrong_bundle", "Wrong Bundle"], ["other", "Other"]]), F("defect_detail", "Defect Details"),
      F("requested_action", "Requested Action", "select", [["replacement", "Replacement / Exchange"], ["refund", "Full Refund Transfer"], ["credit", "Credit"], ["discount", "Discount"]]), F("rate", "Rate per pc (₱)", "money"), F("request_amount", "Request Amount (₱)", "money"),
      F("assigned_by", "Assigned By"), F("inspection_notes", "Inspection Notes", "textarea"), F("factory_status", "Factory Status", "textarea")],
    employees: [F("first_name", "First Name"), F("last_name", "Last Name"), F("position", "Position"), F("phone", "Phone"), F("address", "Address"), F("date_hired", "Date Hired", "date"), F("monthly_salary", "Monthly Salary (₱)", "money")],
    payslips: [F("pay_date", "Pay Date", "date"), F("period_month", "For Month (1st day)", "date"), F("basic_pay", "Basic Pay (₱)", "money"), F("allowances", "Allowances (₱)", "money"), F("overtime_pay", "Overtime Pay (₱)", "money"), F("bonus", "Bonus (₱)", "money"), F("advance_amount", "Advance Amount (₱)", "money"), F("advance_deduction", "Advance Deduction (₱)", "money"), F("other_deductions", "Other Deductions (₱)", "money"), F("method", "Method"), F("reference_no", "Reference No"), F("notes", "Notes")],
    projects: [F("title", "Title"), F("description", "Description", "textarea"), F("location", "Location"), F("start_date", "Start Date", "date"), F("end_date", "End Date", "date")],
    project_payments: [F("pay_date", "Date", "date"), F("amount", "Amount (₱)", "money"), F("received_by", "Received By"), F("method", "Method"), F("reference_no", "Reference No"), F("notes", "Notes")],
    pay_companies: [F("name", "Company Name"), F("country", "Country"), F("contact", "Contact"), F("notes", "Notes")],
    pay_accounts: [F("account_name", "Account Name"), F("account_number", "Account Number"), F("bank_name", "Bank Name"), F("branch_name", "Branch"), F("notes", "Notes")],
    pay_vouchers: [F("pay_date", "Payment Date", "date"), F("amount_php", "Amount (PHP)", "money"), F("exchange_rate", "Exchange Rate", "rate"), F("purpose", "Purpose"), F("method", "Method"), F("reference_no", "Reference No"), F("notes", "Notes")],
    job_applications: [F("full_name", "Full Name"), F("phone", "Phone"), F("email", "Email", "email"), F("present_address", "Present Address"), F("permanent_address", "Permanent Address"), F("father_name", "Father's Name"), F("mother_name", "Mother's Name"), F("spouse_name", "Wife / Husband Name"), F("date_of_birth", "Date of Birth", "date"), F("birth_place", "Birth Place"), F("id_number", "BRC / NID / Passport No"), F("gender", "Gender"), F("religion", "Religion"), F("blood_group", "Blood Group"), F("position_title", "Position"), F("company_name", "Company"), F("apply_salary", "Monthly Salary (₱)", "money"), F("apply_duty_hours", "Duty Hours"), F("apply_joining_date", "Joining Date", "date")],
    order_letters: [F("subject", "Subject"), F("details", "Details", "textarea"), F("resolution", "Resolution / Terms", "textarea"), F("amount", "Amount (₱)", "money"), F("installments", "Number of Installments", "int"), F("installment_amount", "Installment Amount (₱)", "money"), F("first_due_date", "First Due Date", "date")],
    job_positions: [F("title", "Position Title"), F("company_name", "Company Name"), F("company_code", "Company Code"), F("monthly_salary", "Monthly Salary (₱)", "money"), F("duty_hours", "Duty Hours"), F("description", "Description"), F("is_open", "Open for applications", "bool")],
    community_posts: [F("body", "Post", "textarea")]
  };
  const TABLE_NAME = { customers: "Customer", customer_invoices: "Invoice", payments_received: "Payment", credit_memos: "Credit Memo", employees: "Employee", payslips: "Payslip", projects: "Project", project_payments: "Project Payment", pay_companies: "Billing Company", pay_accounts: "Billing Account", pay_vouchers: "Payment Voucher", job_applications: "Job Application", order_letters: "Order Letter", job_positions: "Job Position", community_posts: "Community Post" };
  const ROUTE_OF = { customers: "customer", customer_invoices: "invoice", payments_received: "payment", credit_memos: "creditmemo", employees: "employee", payslips: "payslip", projects: "project", pay_companies: "paycompany", pay_vouchers: "voucher", job_applications: "jobapp", order_letters: "order" };
  const OWNER_OF = { customers: "customer", customer_invoices: "invoice", payments_received: "payment", credit_memos: "credit_memo", employees: "employee", payslips: "payslip", projects: "project", project_payments: "project_payment", pay_companies: "pay_company", pay_accounts: "pay_account", pay_vouchers: "pay_voucher", job_applications: "job_application", order_letters: "order_letter" };
  const fieldLabel = (table, k) => (FIELDS[table] || []).find((f) => f.k === k)?.label || k.replace(/_/g, " ");
  const showVal = (v) => (v === null || v === undefined || v === "" ? "(empty)" : typeof v === "boolean" ? (v ? "Yes" : "No") : typeof v === "object" ? JSON.stringify(v) : String(v));

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

  // Admins edit directly (logged); everyone else sends a change request for the admin to approve.
  function editRecord(table, row, label, reload) {
    const fields = FIELDS[table];
    if (!fields) return toast("This record cannot be changed here.", true);
    const admin = isAdmin();
    const m = E.modal(`${admin ? "Edit" : "Request Change"} — ${label}`, `
      <div class="hint">${admin ? "Changes are saved straight away and recorded in the change log." : "Correct the fields that are wrong and say why. The administrator reviews the request; once approved, the new details show on the record."}</div>
      <div class="fields wide edit-grid">${fields.map((f) => fieldInput(f, row[f.k])).join("")}</div>
      ${admin ? "" : `<label class="fl" for="edReason">Reason for the change *</label><textarea id="edReason" rows="2" placeholder="e.g. Wrong phone number was typed"></textarea>`}`,
      `<button type="button" class="btn" data-x>Cancel</button><button type="button" class="btn primary" data-ok>${admin ? "Save Changes" : "Submit Request"}</button>`, { wide: true });
    $("[data-x]", m.el).onclick = m.close;
    $("[data-ok]", m.el).onclick = async () => {
      const changes = {};
      for (const f of fields) { const v = readField(f, m.el); if (!same(f, row[f.k], v)) changes[f.k] = v; }
      if (!Object.keys(changes).length) return toast("Nothing was changed.", true);
      const btn = $("[data-ok]", m.el); btn.disabled = true;
      let r;
      if (admin) r = await sb.rpc("admin_update_record", { p_table: table, p_id: row.id, p_changes: changes, p_label: label });
      else {
        const reason = $("#edReason", m.el).value.trim();
        if (!reason) { btn.disabled = false; return toast("Explain why the change is needed.", true); }
        r = await sb.rpc("submit_change_request", { p_table: table, p_id: row.id, p_changes: changes, p_reason: reason, p_label: label });
      }
      btn.disabled = false;
      if (r.error) return fail(r.error, admin ? "Could not save the changes" : "Could not send the request");
      m.close();
      toast(admin ? "Changes saved." : `Change request ${r.data.request_no} sent to the administrator.`);
      if (admin && reload) reload();
    };
  }
  async function deleteRecord(table, id, label, afterDelete) {
    if (!(await E.confirmBox(`Delete <b>${esc(label)}</b> permanently? This cannot be undone.`, { title: "Delete record", ok: "Delete", danger: true }))) return;
    const { error } = await sb.rpc("admin_delete_record", { p_table: table, p_id: id, p_label: label });
    if (error) return fail(error, "Could not delete");
    const ot = OWNER_OF[table];
    if (ot) {
      const { data } = await sb.from("attachments").select("id, storage_path").eq("owner_type", ot).eq("owner_id", id);
      if (data?.length) { await sb.storage.from("records").remove(data.map((a) => a.storage_path)); await sb.from("attachments").delete().in("id", data.map((a) => a.id)); }
    }
    toast(`${label} deleted.`);
    if (afterDelete) afterDelete();
  }
  const RT = new Map();
  function recordTools(table, row, label, opts = {}) {
    if (!FIELDS[table] || !S.profile) return "";
    if (RT.size > 300) RT.clear();
    const id = "rt" + Math.random().toString(36).slice(2, 9);
    RT.set(id, { table, row, label, ...opts });
    return `<span class="rtools" data-rt="${id}">${isAdmin()
      ? `<button type="button" class="btn" data-rt-edit>${ic("edit")} Edit</button><button type="button" class="btn danger" data-rt-del>${ic("trash")} Delete</button>`
      : `<button type="button" class="btn" data-rt-edit>${ic("edit")} Request Change</button>`}</span>`;
  }
  function bindRecordTools(root = document) {
    $$("[data-rt]", root).forEach((w) => {
      const o = RT.get(w.dataset.rt); if (!o) return;
      const ed = $("[data-rt-edit]", w), del = $("[data-rt-del]", w);
      if (ed) ed.onclick = (e) => { e.stopPropagation(); editRecord(o.table, o.row, o.label, o.reload); };
      if (del) del.onclick = (e) => { e.stopPropagation(); deleteRecord(o.table, o.row.id, o.label, o.afterDelete); };
    });
  }

  // ======================================================================
  // Change Requests
  // ======================================================================
  V.changes = async () => {
    const admin = isAdmin();
    E.shell("changes", "Change Requests", `
      <div class="tabs" id="crF"><button type="button" class="on" data-f="pending">Waiting Review</button><button type="button" data-f="approved">Approved</button><button type="button" data-f="rejected">Rejected</button><button type="button" data-f="">All</button>${admin ? `<button type="button" data-f="log">Change Log</button>` : ""}</div>
      <div id="crRes">${busy()}</div>`,
      admin ? "Requests from staff to correct records. <b>Approve</b> applies the new values to the record; every change is kept in the <b>Change Log</b>."
        : "Your requests to correct records. To ask for a correction, open the record and press <b>Request Change</b>.");
    const run = async (f) => {
      $("#crRes").innerHTML = busy();
      if (f === "log") {
        const { data, error } = await sb.from("record_changes").select("*").order("created_at", { ascending: false }).limit(500);
        if (error) return fail(error, "Could not load the change log");
        const rows = data || [];
        $("#crRes").innerHTML = E.grid({ cols: [
          { label: "Date / Time", get: (r) => E.stamp(new Date(r.created_at)) }, { label: "Record", get: (r) => `${TABLE_NAME[r.target_table] || r.target_table}: ${r.target_label || ""}` },
          { label: "Action", get: (r) => r.action.toUpperCase() }, { label: "Changes", get: (r) => r.action === "delete" ? "Record deleted" : Object.keys(r.changes || {}).map((k) => `${fieldLabel(r.target_table, k)}: ${showVal(r.previous?.[k])} → ${showVal(r.changes[k])}`).join("; ") },
          { label: "By", get: (r) => r.actor_name || "" }, { label: "Request", get: (r) => r.request_no || "Direct edit" }], rows, empty: "No changes yet." });
        return E.setRecords(`Changes: ${rows.length}`);
      }
      let q = sb.from("change_requests").select("*").order("created_at", { ascending: false }).limit(300);
      if (f) q = q.eq("status", f);
      const { data, error } = await q;
      if (error) return fail(error, "Could not load change requests");
      const rows = data || [];
      $("#crRes").innerHTML = rows.length ? rows.map((r) => `<article class="cr-card st-${esc(r.status)}">
          <header><b class="mono">${esc(r.request_no)}</b>${pill(r.status)}<span>${esc(TABLE_NAME[r.target_table] || r.target_table)}: ${ROUTE_OF[r.target_table] ? `<a href="#${ROUTE_OF[r.target_table]}/${r.target_id}">${esc(r.target_label || "open record")}</a>` : esc(r.target_label || "")}</span><small>${esc(E.dateTime(r.created_at))} · by ${esc(r.requested_by_name || "")}</small></header>
          <div class="cr-reason"><b>Reason:</b> ${esc(r.reason)}</div>
          <table class="grid cr-diff"><thead><tr><th>Field</th><th>Current</th><th>Requested</th></tr></thead><tbody>
            ${Object.keys(r.changes || {}).map((k) => `<tr><td>${esc(fieldLabel(r.target_table, k))}</td><td class="old">${esc(showVal(r.previous?.[k]))}</td><td class="new">${esc(showVal(r.changes[k]))}</td></tr>`).join("")}</tbody></table>
          ${r.status !== "pending" ? `<div class="cr-done">${r.status === "approved" ? "Approved" : "Rejected"} by ${esc(r.reviewed_by_name || "")} · ${esc(E.dateTime(r.reviewed_at))}${r.review_note ? " — " + esc(r.review_note) : ""}</div>`
            : admin ? `<div class="cr-act"><input type="text" placeholder="Note (optional)" data-note="${r.id}"><button type="button" class="btn ok" data-cr="${r.id}" data-a="approve">${ic("check")} Approve</button><button type="button" class="btn danger" data-cr="${r.id}" data-a="reject">Reject</button></div>` : `<div class="cr-done">Waiting for the administrator.</div>`}
        </article>`).join("") : `<div class="empty">${f === "pending" ? "No requests waiting." : "No requests here."}</div>`;
      $$("[data-cr]").forEach((b) => (b.onclick = async () => {
        const note = $(`[data-note="${b.dataset.cr}"]`).value.trim() || null;
        b.disabled = true;
        const { error: e2 } = await sb.rpc("review_change_request", { p_id: b.dataset.cr, p_action: b.dataset.a, p_note: note });
        if (e2) { b.disabled = false; return fail(e2, "Could not review the request"); }
        toast(b.dataset.a === "approve" ? "Approved — the record now shows the new details." : "Request rejected."); run(f); E.refreshBadge();
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
        <p>Your account is ready. To work with ${esc(C.company.name)}, choose a position below and fill in the job application. After you submit, download the application form, sign it, and bring it to the office. The administrator approves it and gives you access to the portal.</p>
        ${rejected ? `<div class="banner closed">Your last application ${esc(rejected.application_no)} was not approved${rejected.review_note ? ": " + esc(rejected.review_note) : "."} You may apply again.</div>` : ""}</section>
      <h3>Open Positions</h3>
      <div class="pos-grid">${positions.map((p) => `<article class="pos-card"><h4>${esc(p.title)}</h4><div class="pos-co">${esc(p.company_name)}</div>
          <div class="pos-meta">${num(p.monthly_salary) ? `<span>₱ ${peso(p.monthly_salary)} / month</span>` : ""}${p.duty_hours ? `<span>${esc(p.duty_hours)}</span>` : ""}</div>
          ${p.description ? `<p>${esc(p.description)}</p>` : ""}<button type="button" class="btn primary" data-apply="${p.id}">Apply Now</button></article>`).join("")}
        <article class="pos-card other"><h4>Other Position</h4><div class="pos-co">${esc(C.company.name)}</div><p>Apply for a position that is not listed.</p><button type="button" class="btn" data-apply="">Apply</button></article></div>`;
    $$("[data-apply]").forEach((b) => (b.onclick = () => applicationForm(positions.find((p) => p.id === b.dataset.apply) || null)));
  }

  const eduRow = (r = {}) => `<tr><td><input type="text" class="e1" value="${esc(r.exam || "")}" placeholder="e.g. SSC"></td><td><input type="text" class="e2" value="${esc(r.institute || "")}"></td><td><input type="text" class="e3" value="${esc(r.result || "")}"></td><td><input type="text" class="e4" value="${esc(r.year || "")}" inputmode="numeric"></td><td><button type="button" class="btn danger" aria-label="Remove row">✕</button></td></tr>`;
  const expRow = (r = {}) => `<tr><td><input type="text" class="x1" value="${esc(r.company || "")}"></td><td><input type="text" class="x2" value="${esc(r.position || "")}"></td><td><input type="text" class="x3" value="${esc(r.from || "")}" placeholder="2022"></td><td><input type="text" class="x4" value="${esc(r.to || "")}" placeholder="2024"></td><td><button type="button" class="btn danger" aria-label="Remove row">✕</button></td></tr>`;
  // The job application form (same fields as the printed company template). `existing` = edit while under review.
  function applicationForm(pos, existing) {
    const a = existing || {};
    const v = (k, d = "") => esc(a[k] ?? d);
    $(".band h1").textContent = existing ? `Edit Application ${existing.application_no}` : "Job Application Form";
    $("#main").innerHTML = `
      <form class="window jaform" id="jaForm" novalidate><div class="wtitle">Job Application — ${esc(existing ? existing.position_title : pos ? pos.title : "Other Position")}</div><div class="wbody">
        <fieldset class="opt"><legend>Apply Job Information</legend><div class="formgrid">
          <div class="fields wide">
            ${pos || existing ? `<span>Position</span><b>${esc(existing ? existing.position_title : pos.title)}</b><span>Company</span><b>${esc(existing ? existing.company_name : pos.company_name)}</b>`
              : `<label for="jaPos">Position *</label><input type="text" id="jaPos" placeholder="Position you apply for">`}
            <label for="jaSal">Expected Monthly Salary (₱)</label><input type="number" id="jaSal" min="0" step="0.01" value="${v("apply_salary", pos ? pos.monthly_salary : "")}">
          </div>
          <div class="fields wide">
            <label for="jaHrs">Duty Hours</label><input type="text" id="jaHrs" value="${v("apply_duty_hours", pos ? pos.duty_hours || "" : "")}">
            <label for="jaJoin">Joining Date</label><input type="date" id="jaJoin" value="${v("apply_joining_date")}">
          </div></div></fieldset>
        <fieldset class="opt"><legend>Applicant</legend><div class="formgrid">
          <div class="fields wide">
            <label for="jaName">Full Name *</label><input type="text" id="jaName" value="${v("full_name", S.profile.full_name || "")}">
            <label for="jaPhone">Phone *</label><input type="tel" id="jaPhone" value="${v("phone")}">
            <label for="jaEmail">Email</label><input type="email" id="jaEmail" value="${v("email", S.session.user.email)}">
          </div>
          <div class="fields wide">
            <label for="jaPhoto">Photo ${existing ? "" : "*"}</label><input type="file" id="jaPhoto" accept="image/*">
            <span></span><div id="jaPhotoPrev" class="photo-prev">${existing?.photo_path ? "Photo on file" : "No photo"}</div>
          </div></div></fieldset>
        <fieldset class="opt"><legend>Address Details</legend><div class="fields wide">
          <label for="jaPres">Present Address *</label><input type="text" id="jaPres" value="${v("present_address")}">
          <label for="jaPerm">Permanent Address</label><input type="text" id="jaPerm" value="${v("permanent_address")}"></div></fieldset>
        <fieldset class="opt"><legend>Personal Information</legend><div class="formgrid">
          <div class="fields wide">
            <label for="jaFather">Father's Name</label><input type="text" id="jaFather" value="${v("father_name")}">
            <label for="jaMother">Mother's Name</label><input type="text" id="jaMother" value="${v("mother_name")}">
            <label for="jaSpouse">Wife / Husband Name</label><input type="text" id="jaSpouse" value="${v("spouse_name")}">
            <label for="jaDob">Date of Birth</label><input type="date" id="jaDob" value="${v("date_of_birth")}">
            <label for="jaBirth">Birth Place</label><input type="text" id="jaBirth" value="${v("birth_place")}">
          </div>
          <div class="fields wide">
            <label for="jaIdNo">BRC / NID / Passport No</label><input type="text" id="jaIdNo" value="${v("id_number")}">
            <label for="jaGender">Gender</label><select id="jaGender">${["", "Male", "Female"].map((g) => `<option ${a.gender === g ? "selected" : ""}>${g}</option>`).join("")}</select>
            <label for="jaRel">Religion</label><input type="text" id="jaRel" value="${v("religion")}">
            <label for="jaBlood">Blood Group</label><select id="jaBlood">${["", "A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"].map((g) => `<option ${a.blood_group === g ? "selected" : ""}>${g}</option>`).join("")}</select>
          </div></div></fieldset>
        <fieldset class="opt"><legend>Educational Qualifications</legend>
          <div class="grid-scroll"><table class="grid budget"><thead><tr>${E.EDU_COLS.map((c) => `<th>${c}</th>`).join("")}<th></th></tr></thead><tbody id="jaEdu">${(a.education?.length ? a.education : [{ exam: "SSC" }, { exam: "HSC" }]).map(eduRow).join("")}</tbody></table></div>
          <div class="btnrow"><button type="button" class="btn" id="jaEduAdd">+ Add Row</button></div></fieldset>
        <fieldset class="opt"><legend>Work Experience</legend>
          <div class="grid-scroll"><table class="grid budget"><thead><tr>${E.EXP_COLS.map((c) => `<th>${c}</th>`).join("")}<th></th></tr></thead><tbody id="jaExp">${(a.experience || []).map(expRow).join("")}</tbody></table></div>
          <div class="btnrow"><button type="button" class="btn" id="jaExpAdd">+ Add Experience</button></div></fieldset>
        <fieldset class="opt"><legend>Requirements</legend><div class="fields wide">${E.fileField("jaReq", "Upload Requirements", 'multiple accept="image/*,application/pdf"')}</div>
          <small>NID or birth certificate, certificates, CV, police clearance — photos or PDF.</small></fieldset>
        <label class="decl"><input type="checkbox" id="jaDecl" ${a.declaration ? "checked" : ""}> I hereby declare that all the information given above is true and correct to the best of my knowledge.</label>
      </div><div class="wfoot"><button type="button" class="btn" id="jaCancel">Cancel</button><button type="submit" class="btn primary">${existing ? "Save Changes" : "Submit Application"}</button></div></form>`;
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
      if (!pos && !existing && !g("jaPos")) return toast("Enter the position you apply for.", true);
      if (!g("jaName")) return toast("Enter your full name.", true);
      if (!g("jaPhone")) return toast("Enter your phone number.", true);
      if (!g("jaPres")) return toast("Enter your present address.", true);
      const photo = $("#jaPhoto").files[0];
      if (!existing && !photo) return toast("Add your photo.", true);
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
      let app;
      if (existing) {
        const { data, error } = await sb.from("job_applications").update(rec).eq("id", existing.id).select().single();
        if (error) { E.setBusy(e.target, false); return fail(error, "Could not save the changes"); }
        app = data;
      } else {
        const id = E.uuid();
        const { data, error } = await sb.from("job_applications").insert({ id, ...rec, position_id: pos?.id || null, position_title: pos ? pos.title : g("jaPos"), company_name: pos ? pos.company_name : C.company.name, company_code: pos ? pos.company_code : "EO" }).select().single();
        if (error) { E.setBusy(e.target, false); return fail(error, "Could not submit the application"); }
        app = data;
      }
      if (photo) {
        const f = await shrinkImage(photo, 900);
        const path = `job_application/${app.id}/Photo_${Date.now()}.${E.extOf(f)}`;
        const up = await sb.storage.from("records").upload(path, f, { contentType: f.type });
        if (!up.error) { await sb.from("job_applications").update({ photo_path: path }).eq("id", app.id); app.photo_path = path; }
        else toast("The photo could not be uploaded. Add it again from Edit Application.", true);
      }
      const failed = await E.uploadRecords("job_application", app.id, "requirement", E.filesOf("jaReq"));
      if (failed) toast(`${failed} requirement file(s) failed to upload.`, true);
      toast(existing ? "Application updated." : `Application ${app.application_no} submitted. The administrator has been notified.`);
      applicantStatus(app);
    };
  }
  async function applicantStatus(a) {
    $(".band h1").textContent = "My Job Application";
    const att = await E.attachmentsOf("job_application", a.id);
    $("#main").innerHTML = `
      <section class="app-status st-${esc(a.status)}">
        <div class="as-ic">${a.status === "approved" ? ic("check") : ic("doc")}</div>
        <div><h2>${a.status === "approved" ? "Approved — welcome to the team!" : "Application submitted — under review"}</h2>
          <p>${a.status === "approved" ? `Approval No <b>${esc(a.approval_no || "")}</b>. Sign out and sign in again to open the portal.`
            : "Next: download the application form, sign it, and bring it to the office. The administrator signs it too, uploads the signed copy and approves your application. This page opens the full portal by itself once you are approved."}</p></div></section>
      <div class="ch-ids big-ids">${E.idBox("Application No", a.application_no)}${E.idBox("Position", a.position_title)}${E.idBox("Company", a.company_name)}${E.idBox("Submitted", dmy(a.created_at))}${E.idBox("Status", a.status.toUpperCase())}</div>
      <div class="docgrid">${E.docCard({ key: "myja", title: `Job Application Form ${a.application_no}`, sub: "Download, print and sign", ownerType: "job_application", ownerId: a.id, att, print: () => E.printJobApp(a), canUpload: false, printLabel: "Download / Print Form" })}</div>
      <h3>My Requirements</h3>${E.filesHtml(att.filter((x) => x.kind !== "signed_form"), "No requirements uploaded yet.")}
      ${a.status === "submitted" ? `<div class="fields wide" style="margin:8px 0">${E.fileField("asReq", "Add Requirements", 'multiple accept="image/*,application/pdf"')}</div>
        <div class="btnrow"><button type="button" class="btn" id="asEdit">${ic("edit")} Edit Application</button><button type="button" class="btn" id="asCheck">Check Status</button></div>` : ""}`;
    E.bindFiles($("#main"));
    E.bindDocCards($("#main"), () => applicantStatus(a));
    if ($("#asEdit")) $("#asEdit").onclick = () => applicationForm(null, a);
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
  // 9. Order Letter — suspension, closure, reactivation, payment arrangements
  // ======================================================================
  const SUBJ = {
    suspension: ["Suspension", "Suspension of Account"], closure: ["Closure", "Closure of Account"], reactivation: ["Reactivation", "Reactivation of Account"],
    unpaid: ["Unpaid", "Notice of Unpaid Balance"], installment: ["Installment", "Installment Payment Arrangement"], unsettled_balance: ["Unsettled Balance", "Demand for Unsettled Balance"],
    promise_to_pay: ["Promise to Pay", "Promise to Pay Agreement"], other: ["Other", ""]
  };
  const AMOUNT_TYPES = ["unpaid", "installment", "unsettled_balance", "promise_to_pay"];
  const ORDER_COLS = [
    { label: "Order No", get: (r) => r.order_no }, { label: "Date", get: (r) => dmy(r.order_date) },
    { label: "Account", get: (r) => r.customers ? `${r.customers.account_no} ${fullName(r.customers)}` : "—" },
    { label: "Type", get: (r) => SUBJ[r.subject_type]?.[0] || r.subject_type }, { label: "Subject", get: (r) => r.subject },
    { label: "Amount (₱)", num: true, get: (r) => (r.amount != null ? peso(r.amount) : "") }, { label: "Status", html: (r) => pill(r.status) }
  ];
  const canApply = () => E.canWrite("orders") || E.canWrite("customers");
  V.orders = async () => {
    E.shell("orders", "Order Letter", `
      <div class="tabs" id="olF"><button type="button" class="on" data-f="pending">Waiting Approval</button><button type="button" data-f="approved">Approved</button><button type="button" data-f="applied">Applied</button><button type="button" data-f="rejected">Rejected</button><button type="button" data-f="">All</button></div>
      <div class="btnrow">${canApply() ? `<a class="btn primary" href="#neworder">${ic("plus")} New Order Letter</a><button type="button" class="btn" id="olApply">${ic("qr")} Apply Order Letter (Scan QR)</button>` : ""}</div>
      <div id="olRes">${busy()}</div>`,
      "Order letters suspend, close or reactivate an account, or record a payment arrangement. The admin approves the letter; its QR code carries a verification code. Scanning the QR (or typing the code) carries out the order.");
    const run = async (f) => {
      $("#olRes").innerHTML = busy();
      let q = sb.from("order_letters").select("*, customers(first_name,last_name,account_no,status)").order("created_at", { ascending: false }).limit(1000);
      if (f) q = q.eq("status", f);
      const { data, error } = await q;
      if (error) return fail(error, "Could not load order letters (run the 1.1 database update)");
      const rows = data || [];
      $("#olRes").innerHTML = E.grid({ cols: ORDER_COLS, rows, onRow: true, empty: "No order letters here." });
      E.bindGrid($("#olRes"), rows, (r) => (location.hash = "order/" + r.id));
      E.setRecords(`Order letters: ${rows.length}`);
    };
    $$("#olF button").forEach((b) => (b.onclick = () => { $$("#olF button").forEach((x) => x.classList.toggle("on", x === b)); run(b.dataset.f); }));
    if ($("#olApply")) $("#olApply").onclick = () => applyOrderDialog({ onDone: () => run("applied") });
    run("pending");
  };

  function defaultDetails(t, c, amt, n, inst, due, dt) {
    const acct = c ? `${c.account_no} (${fullName(c)})` : "[account]";
    const when = E.dLong(dt || isoToday()), dueTxt = due ? E.dLong(due) : "[due date]", a = amt ? `PHP ${peso(amt)}` : "PHP [amount]";
    return {
      suspension: `We regret to inform you that your account ${acct} is SUSPENDED effective ${when}. New orders and invoices are on hold until the account is reactivated by an approved order letter.`,
      closure: `Please be informed that your account ${acct} is permanently CLOSED effective ${when}. No new invoices will be recorded on this account.`,
      reactivation: `We are pleased to inform you that your account ${acct} is REACTIVATED effective ${when}. You may place orders again.`,
      unpaid: `Our records show an unpaid balance of ${a} on your account ${acct}. Please settle it on or before ${dueTxt}.`,
      installment: `As agreed, the balance of ${a} on account ${acct} will be paid in ${n || "[number]"} installment(s) of PHP ${inst ? peso(inst) : "[amount]"} each, starting ${dueTxt}.`,
      unsettled_balance: `Despite previous reminders, the balance of ${a} on account ${acct} remains unsettled. Please settle it within seven (7) days from receipt of this letter.`,
      promise_to_pay: `The account holder of ${acct} promises to pay ${a} on or before ${dueTxt} to settle the outstanding balance.`,
      other: ""
    }[t] || "";
  }

  V.neworder = async (custId) => {
    if (!canApply()) { toast("You cannot create order letters.", true); location.hash = "orders"; return; }
    E.shell("neworder", "New Order Letter", `
      <form class="window" id="noForm" novalidate><div class="wtitle">Order Letter</div><div class="wbody">
        <div class="summary-box"><div class="fields wide"><span>Order No</span><b>Assigned on save (ORDER-${new Date().getFullYear()}-###)</b><span>Prepared By</span><b>${esc(S.profile.full_name || "")}</b></div></div>
        <fieldset class="opt"><legend>Account</legend><div id="noCust"></div></fieldset>
        <fieldset class="opt"><legend>Subject</legend><div class="subj-grid">${Object.entries(SUBJ).map(([k, [l]], i) => `<label class="subj"><input type="radio" name="noType" value="${k}" ${i ? "" : "checked"}><span>${esc(l)}</span></label>`).join("")}</div>
          <div class="fields wide" style="margin-top:8px"><label for="noSubj">Subject *</label><input type="text" id="noSubj" value="${esc(SUBJ.suspension[1])}">
            <label for="noDate">Order Date</label><input type="date" id="noDate" value="${isoToday()}"></div></fieldset>
        <fieldset class="opt" id="noAmtBox" hidden><legend>Amount &amp; Terms</legend><div class="formgrid">
          <div class="fields wide"><label for="noAmt">Amount (₱)</label><input type="number" id="noAmt" min="0" step="0.01"><label for="noDue">First Due Date</label><input type="date" id="noDue"></div>
          <div class="fields wide noInst"><label for="noN">Number of Installments</label><input type="number" id="noN" min="1" step="1"><label for="noInst">Installment Amount (₱)</label><input type="number" id="noInst" min="0" step="0.01"></div></div></fieldset>
        <fieldset class="opt"><legend>Letter</legend><div class="fields wide">
          <label for="noDetails">Details *</label><textarea id="noDetails" rows="5"></textarea>
          <label for="noRes">Resolution / Terms</label><textarea id="noRes" rows="3" placeholder="Optional: conditions, what the customer must do"></textarea></div></fieldset>
      </div><div class="wfoot"><a class="btn" href="#orders">Cancel</a><button type="submit" class="btn primary">Submit for Approval</button></div></form>`,
      "After you submit, the administrator approves the letter. The approved letter gets a QR code; scanning it (or typing its verification code) carries out the order.");
    let cust = null, dirty = false;
    const type = () => $("input[name=noType]:checked").value;
    const refresh = () => {
      const t = type();
      $("#noAmtBox").hidden = !AMOUNT_TYPES.includes(t);
      $$(".noInst").forEach((x) => (x.hidden = t !== "installment"));
      const n = num($("#noN").value), amt = num($("#noAmt").value);
      if (t === "installment" && n > 0 && amt > 0 && !$("#noInst").dataset.touched) $("#noInst").value = (Math.round((amt / n) * 100) / 100).toFixed(2);
      if (!dirty) $("#noDetails").value = defaultDetails(t, cust, amt, n, num($("#noInst").value), $("#noDue").value, $("#noDate").value);
    };
    E.customerPicker($("#noCust"), { statuses: ["active", "suspended"], onPick: (c) => { cust = c; refresh(); }, preset: (await E.getCustomer(custId)) || undefined });
    $$("input[name=noType]").forEach((r) => (r.onchange = () => { const t = type(); if (SUBJ[t][1]) $("#noSubj").value = SUBJ[t][1]; else { $("#noSubj").value = ""; $("#noSubj").focus(); } refresh(); }));
    ["noAmt", "noN", "noDue", "noDate"].forEach((id) => ($("#" + id).oninput = refresh));
    $("#noInst").oninput = () => { $("#noInst").dataset.touched = "1"; refresh(); };
    $("#noDetails").oninput = () => (dirty = true);
    refresh();
    $("#noForm").onsubmit = async (e) => {
      e.preventDefault();
      const t = type();
      if (!cust) return toast("Choose the account.", true);
      if (!$("#noSubj").value.trim()) return toast("Enter the subject.", true);
      if (!$("#noDetails").value.trim()) return toast("Write the details of the order.", true);
      if (t === "suspension" && cust.status !== "active") return toast(`${cust.account_no} is ${cust.status.toUpperCase()} — only ACTIVE accounts can be suspended.`, true);
      if (t === "reactivation" && cust.status !== "suspended") return toast(`${cust.account_no} is ${cust.status.toUpperCase()} — only SUSPENDED accounts can be reactivated.`, true);
      E.setBusy(e.target, true, "Submitting");
      const amtOn = AMOUNT_TYPES.includes(t);
      const { data, error } = await sb.from("order_letters").insert({
        customer_id: cust.id, order_date: $("#noDate").value || isoToday(), subject_type: t, subject: $("#noSubj").value.trim(),
        details: $("#noDetails").value.trim(), resolution: $("#noRes").value.trim() || null,
        amount: amtOn && $("#noAmt").value ? num($("#noAmt").value) : null, first_due_date: amtOn ? $("#noDue").value || null : null,
        installments: t === "installment" && $("#noN").value ? Math.floor(num($("#noN").value)) : null, installment_amount: t === "installment" && $("#noInst").value ? num($("#noInst").value) : null
      }).select().single();
      if (error) { E.setBusy(e.target, false); return fail(error, "Could not save the order letter"); }
      toast(`Order letter ${data.order_no} sent for approval.`);
      location.hash = "order/" + data.id;
    };
  };

  const orderQr = (o, code) => `EMONORDER|${o.order_no}|${code}`;
  function letterPage(o, code) {
    const c = o.customers || {};
    const qr = code ? E.qrDataUrl(orderQr(o, code)) : "";
    const dear = c.first_name ? `Dear ${esc(fullName(c))},` : "Dear Sir / Madam,";
    return `${E.printHead("ORDER LETTER", `<img src="${E.pdf417DataUrl("EMONORDER|" + o.order_no)}" alt="" class="ph-bar"><div class="mono">${esc(o.order_no)}</div>`)}
      <div class="ol-top"><div><div><b>Order No:</b> ${esc(o.order_no)}</div><div><b>Date:</b> ${esc(E.dLong(o.order_date))}</div></div>
        <div class="ol-to"><b>To:</b> ${esc(fullName(c).toUpperCase())}<br>Account No: ${esc(c.account_no || "")}<br>${esc(c.address || "")}</div></div>
      <div class="ol-subj">SUBJECT: ${esc((o.subject || "").toUpperCase())}</div>
      <p>${dear}</p>
      <div class="ol-body">${esc(o.details || "").replace(/\n/g, "<br>")}</div>
      ${o.amount != null ? `<table class="rp ol-amt"><tbody><tr><td>Amount</td><td class="num">PHP ${peso(o.amount)}</td></tr>
        ${o.installments ? `<tr><td>Installments</td><td class="num">${o.installments} × PHP ${peso(o.installment_amount)}</td></tr>` : ""}
        ${o.first_due_date ? `<tr><td>${o.installments ? "First Due Date" : "Due Date"}</td><td class="num">${esc(E.dLong(o.first_due_date))}</td></tr>` : ""}</tbody></table>
        <div class="pcell"><div class="pl">Amount in Words</div><div class="pv words">${esc(words(o.amount))}</div></div>` : ""}
      ${o.resolution ? `<div class="ol-res"><b>Resolution / Terms:</b><br>${esc(o.resolution).replace(/\n/g, "<br>")}</div>` : ""}
      <p class="pdecl">This order is issued by ${esc(C.company.name)} and takes effect once verified through the ${esc(E.APP)}.</p>
      <div class="ol-foot">
        <div class="ol-sigs">${E.sigs(`Prepared by: <b>${esc(o.created_by_name || "")}</b>`, `Approved by: <b>${esc(o.approved_by_name || "")}</b>`)}</div>
        ${qr ? `<div class="ol-qr"><img src="${qr}" alt="Order QR code"><div>Verification Code</div><b class="mono">${esc(code)}</b><small>Scan in the E-Portal to verify and carry out this order</small></div>` : ""}
      </div>`;
  }

  V.order = async (id) => {
    E.shell("order", "Order Letter", busy());
    const { data: o } = await sb.from("order_letters").select("*, customers(*)").eq("id", id).maybeSingle();
    if (!o) { $("#main").innerHTML = `<div class="empty">Order letter not found. <a href="#orders">Back</a></div>`; return; }
    const [att, codeRes] = await Promise.all([
      E.attachmentsOf("order_letter", id),
      isAdmin() && ["approved", "applied"].includes(o.status) ? sb.from("order_letter_codes").select("code").eq("order_id", id).maybeSingle() : Promise.resolve({ data: null })
    ]);
    const code = codeRes.data?.code || "";
    const c = o.customers || {};
    $(".band h1").textContent = `Order Letter — ${o.order_no}`;
    const banner = {
      pending: `<div class="banner warn">Waiting for the administrator to approve this order letter.</div>`,
      approved: `<div class="banner ok">✔ APPROVED by ${esc(o.approved_by_name || "")} on ${dmy(o.approved_at)}. ${isAdmin() ? "Print the letter: its QR code carries the verification code." : "The administrator prints the letter with its QR code."} Scan the QR (or type the code) to carry out the order.</div>`,
      applied: `<div class="banner ok">✔ APPLIED on ${dmy(o.applied_at)} by ${esc(o.applied_by_name || "")} — ${esc(o.applied_result || "")}</div>`,
      rejected: `<div class="banner closed">REJECTED by ${esc(o.approved_by_name || "")}${o.review_note ? " — " + esc(o.review_note) : ""}</div>`
    }[o.status] || "";
    $("#main").innerHTML = `${banner}
      <div class="window"><div class="wtitle">${esc(o.order_no)} — ${esc(SUBJ[o.subject_type]?.[0] || "")} ${pill(o.status)}</div><div class="wbody">
        <div class="formgrid"><div class="fields wide">
          <span>Account</span><span>${c.id ? `<a href="#customer/${c.id}"><b>${esc(fullName(c))}</b> (${esc(c.account_no)})</a> ${pill(c.status)}` : "—"}</span>
          <span>Subject</span><b>${esc(o.subject)}</b><span>Order Date</span><span>${dmy(o.order_date)}</span>
          <span>Prepared By</span><span>${esc(o.created_by_name || "")}</span></div>
          <div class="fields wide">${o.amount != null ? `<span>Amount</span><b>₱ ${peso(o.amount)}</b>` : ""}${o.installments ? `<span>Installments</span><span>${o.installments} × ₱ ${peso(o.installment_amount)}</span>` : ""}${o.first_due_date ? `<span>Due Date</span><span>${dmy(o.first_due_date)}</span>` : ""}
          ${isAdmin() && code ? `<span>Verification Code</span><b class="mono code-chip">${esc(code)}</b>` : ""}</div></div>
        <div class="letter-box"><div class="lb-h">Details</div><p>${esc(o.details || "").replace(/\n/g, "<br>")}</p>${o.resolution ? `<div class="lb-h">Resolution / Terms</div><p>${esc(o.resolution).replace(/\n/g, "<br>")}</p>` : ""}</div>
        <div class="docgrid">${E.docCard({ key: "ol", title: `Order Letter ${o.order_no}`, sub: o.status === "approved" && !isAdmin() ? "Printed by the administrator with the QR code" : "Print it, have it signed, then upload the signed copy", ownerType: "order_letter", ownerId: o.id, att, print: () => E.openPreview(`Order Letter ${o.order_no}`, [letterPage(o, code)]) })}</div>
        ${isAdmin() && o.status === "pending" ? `<fieldset class="opt review"><legend>Admin Approval</legend><div class="fields wide"><label for="olNote">Note</label><input type="text" id="olNote" placeholder="Optional"></div>
          <div class="btnrow"><button type="button" class="btn ok" id="olApprove">${ic("check")} Approve — Create QR Code</button><button type="button" class="btn danger" id="olReject">Reject</button></div></fieldset>` : ""}
        ${o.status === "approved" && canApply() ? `<fieldset class="opt review"><legend>Carry Out This Order</legend><p>Scan the QR code on the printed letter, or type its verification code.</p>
          <div class="btnrow"><button type="button" class="btn primary" id="olApplyBtn">${ic("qr")} Scan / Enter Code</button></div></fieldset>` : ""}
      </div><div class="wfoot">${o.status === "pending" || isAdmin() ? recordTools("order_letters", o, `Order letter ${o.order_no}`, { reload: () => V.order(id), afterDelete: () => (location.hash = "orders") }) : ""}<a class="btn" href="#orders">Close</a></div></div>`;
    E.bindDocCards($("#main"), () => V.order(id));
    bindRecordTools($("#main"));
    const review = async (action) => {
      const { error } = await sb.rpc("review_order_letter", { p_id: id, p_action: action, p_note: $("#olNote").value.trim() || null });
      if (error) return fail(error, "Could not update the order letter");
      toast(action === "approve" ? `${o.order_no} approved. Print it — the QR code carries the verification code.` : `${o.order_no} rejected.`);
      V.order(id);
    };
    if ($("#olApprove")) $("#olApprove").onclick = () => review("approve");
    if ($("#olReject")) $("#olReject").onclick = async () => { if (await E.confirmBox(`Reject order letter <b>${esc(o.order_no)}</b>?`, { ok: "Reject", danger: true })) review("reject"); };
    if ($("#olApplyBtn")) $("#olApplyBtn").onclick = () => applyOrderDialog({ preset: { no: o.order_no }, customer: c.id ? c : null, onDone: () => V.order(id) });
    E.setRecords(`Order: ${o.order_no}`);
  };

  // Scan the order letter's QR (or type its number and code); a match carries out the order.
  function parseOrder(text) {
    const p = String(text || "").trim().split("|").map((x) => x.trim());
    if (/^(EMON)?ORDER$/i.test(p[0])) return { no: p[1] || "", code: p[2] || "" };
    if (/^ORDER-/i.test(p[0])) return { no: p[0], code: p[1] || "" };
    return null;
  }
  function applyOrderDialog({ customer = null, preset = {}, onDone, auto = false } = {}) {
    const m = E.modal("Apply Order Letter", `
      <p>Scan the QR code on the approved order letter, or type the order number and its verification code.</p>
      <div class="btnrow center"><button type="button" class="btn primary" data-scan>${ic("scan")} Scan QR Code</button></div>
      <div class="fields wide"><label for="apNo">Order No</label><input type="text" id="apNo" placeholder="ORDER-${new Date().getFullYear()}-001" value="${esc(preset.no || "")}" autocapitalize="characters">
        <label for="apCode">Verification Code</label><input type="text" id="apCode" class="mono" placeholder="8 characters" value="${esc(preset.code || "")}" autocapitalize="characters"></div>
      ${customer ? `<small class="muted">Only an order letter for <b>${esc(customer.account_no)}</b> ${esc(fullName(customer))} can be applied here.</small>` : ""}
      <div id="apMsg"></div>`,
      `<button type="button" class="btn" data-x>Close</button><button type="button" class="btn primary" data-ok>${ic("check")} Verify &amp; Apply</button>`);
    const d = m.el;
    $("[data-x]", d).onclick = m.close;
    const apply = async () => {
      const no = $("#apNo", d).value.trim().toUpperCase(), code = $("#apCode", d).value.trim().toUpperCase();
      if (!no || !code) return toast("Enter the order number and the verification code, or scan the QR code.", true);
      const msg = $("#apMsg", d);
      msg.innerHTML = busy("Checking the order letter");
      const { data, error } = await sb.rpc("apply_order_letter", { p_order_no: no, p_code: code, p_customer: customer?.id || null });
      if (error) { msg.innerHTML = `<div class="vf-bad small"><b>✖ NOT APPLIED</b><span>${esc(error.message)}</span></div>`; return; }
      msg.innerHTML = `<div class="vf-ok small"><b>✔ TRUE — ${esc(data.order_no)} VERIFIED</b><span>${esc(data.result)}</span></div>`;
      $("[data-ok]", d).remove();
      toast(data.result);
      if (onDone) onDone(data);
    };
    $("[data-ok]", d).onclick = apply;
    $("[data-scan]", d).onclick = () => E.scanDialog((text) => {
      const p = parseOrder(text);
      if (!p) return toast("That QR code is not an order letter.", true);
      $("#apNo", d).value = p.no; $("#apCode", d).value = p.code;
      if (p.no && p.code) apply();
    }, { title: "Scan Order Letter QR" });
    if (auto && preset.no && preset.code) apply();
  }
  // From the top-bar scanner: staff carry out the order; everyone else sees the verification.
  function applyOrderScan(text) {
    const p = parseOrder(text);
    if (!p) return;
    if (canApply()) applyOrderDialog({ preset: p, auto: true });
    else location.hash = "verify/" + encodeURIComponent(p.no);
  }

  // ======================================================================
  // Verification — anyone can check a record by number, QR code or barcode
  // ======================================================================
  const OPEN = {
    "Customer Account": ["customers", "account_no", "customer"], Invoice: ["customer_invoices", "invoice_no", "invoice"], "Payment Receipt": ["payments_received", "receipt_no", "payment"],
    "Credit Memo": ["credit_memos", "memo_no", "creditmemo"], "Statement of Account": ["statements", "statement_no", "customer", "customer_id"], "Order Letter": ["order_letters", "order_no", "order"],
    "Payment Voucher": ["pay_vouchers", "voucher_no", "voucher"], Payslip: ["payslips", "payslip_no", "payslip"], "Job Application": ["job_applications", "application_no", "jobapp"],
    Employee: ["employees", "employee_no", "employee"], Project: ["projects", "project_no", "project"], "Project Payment": ["project_payments", "payment_no", "project", "project_id"]
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
          <input type="text" id="vfCode" aria-label="Record number" placeholder="e.g. INV-202610-0001 · A-2026-1004-001 · BD20261004001 · ORDER-2026-001" value="${esc(code || "")}" autocapitalize="characters" spellcheck="false">
          <button type="submit" class="btn primary">${ic("check")} Verify</button>
        </form>
        <div class="btnrow center"><button type="button" class="btn" id="vfScan">${ic("camera")} Scan with Camera</button><label class="btn" for="vfImg">${ic("image")} Upload Photo of Code</label><input type="file" id="vfImg" accept="image/*" hidden></div>
      </section>
      <div id="vfResult"></div>`;
    if (inside) E.shell("verify", "Verification", body); else E.miniShell("Verification", body);
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
      out.innerHTML = `<div class="vf-ok">
        <div class="vf-seal">${ic("check")}</div>
        <div class="vf-title">TRUE RECORD</div>
        <div class="vf-sub">VERIFIED BY ${esc(E.APP)}</div>
        <div class="vf-type">${esc(data.type)} · <b class="mono">${esc(data.number)}</b> ${data.status ? pill(data.status) : ""}</div>
        <table class="vf-fields"><tbody>${(data.fields || []).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v ?? "")}</td></tr>`).join("")}</tbody></table>
        <div class="vf-when">Checked ${esc(E.dateTime(checked.toISOString()))}</div>
        <div class="btnrow center"><button type="button" class="btn primary" id="vfPrint">${ic("print")} Validated Print</button>${inside && OPEN[data.type] ? `<button type="button" class="btn" id="vfOpen">${ic("eye")} Open Record</button>` : ""}</div></div>`;
      $("#vfPrint").onclick = () => validatedPrint(data, checked);
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
  // "Transaction Receipt" slip: company name, details, verified line and the temporary-receipt notice.
  function validatedPrint(d, when) {
    const vno = "V" + when.toISOString().replace(/\D/g, "").slice(2, 14);
    const page = `<div class="tr-slip">
      <div class="tr-head"><div class="tr-logo">${E.logoHtml("tr-logo-img")}</div><div><div class="tr-co">${esc(C.company.name)}</div>
        <div class="tr-addr">${esc(C.company.address.join(", "))} · ${esc(C.company.email)} · ${esc(C.company.phone)}</div></div></div>
      <div class="tr-title">Transaction Receipt</div>
      <div class="tr-body"><table class="tr-fields"><tbody>
          <tr><th>Record Type</th><td>${esc(d.type)}</td></tr><tr><th>Record No</th><td><b>${esc(d.number)}</b></td></tr>
          ${(d.fields || []).filter(([, v]) => String(v) !== String(d.number)).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v ?? "")}</td></tr>`).join("")}
        </tbody></table>
        <div class="tr-qr"><img src="${E.qrDataUrl(verifyUrl(d.number))}" alt="Verification QR"><small>Scan to verify online</small></div></div>
      <div class="tr-verified">✔ TRUE RECORD — VERIFIED BY ${esc(E.APP)}<span>Validated ${esc(E.dateTime(when.toISOString()))} · Validation No ${esc(vno)}</span></div>
      <div class="tr-note">THIS ACKNOWLEDGEMENT WILL SERVE AS A TEMPORARY RECEIPT. FOR RECORD USE ONLY — NOT VALID AS AN OFFICIAL RECEIPT. ASK FOR THE ORIGINAL RECEIPT. THANK YOU.</div>
    </div>`;
    E.openPreview(`Validated ${d.number}`, [page], { size: "a5l" });
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
        <div><b>${esc(c.full_name || "")}${c.verified ? `<span class="vbadge sm" title="Verified employee">${ic("check")}</span>` : ""}</b><small>${esc(c.job_position || "")} · ${E.online(c.last_seen_at) ? `<span class="on-txt">Active now</span>` : `Last seen ${esc(c.last_seen_at ? E.timeAgo(c.last_seen_at) : "—")}`}</small></div></div>
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
      const sep = day !== lastDay ? `<div class="cv-day">${esc(E.dShort(m.created_at))}</div>` : "";
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
      if (file.size > 25 * 1024 * 1024) { CH.busy = false; if (btn) btn.disabled = false; return toast("Files up to 25 MB can be sent.", true); }
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

  Object.assign(E, { recordTools, bindRecordTools, editRecord, deleteRecord, fieldLabel, applyOrderDialog, applyOrderScan, openChat, closeChat, shrinkImage, signedMap, lightbox });
})();
