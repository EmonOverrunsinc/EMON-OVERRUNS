/* EMON OVERRUNS E-PORTAL — job applicant portal, Verification (public),
   Messages (chat), Corrections, and the Edit / Delete (Director) tools used on every record
   (saved records are never edited; only the Director deletes, permanently). */
(function () {
  "use strict";
  const E = window.EO;
  const { sb, S, C, esc, peso, isoToday, mdy, $, $$, isAdmin, isStaff, pill, toast, fail, words, ic, busy, num, fullName, verifyUrl, qtyText } = E;
  const V = window.EO_VIEWS;
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
  // Records: Edit on every record for the Director (staff: Request Correction, approved by the Director).
  // Only the Director deletes a record, and then it is gone for good.
  // ======================================================================
  const F = (k, label, type = "text", opts) => ({ k, label, type, opts });
  const METHODS = [["cash", "Cash"], ["bank_transfer", "Bank Transfer"], ["online_transfer", "Online Transfer"], ["deposit", "Bank Deposit"]];
  // Details that can be corrected — must match editable_columns() in the database. Amounts, transaction dates and
  // record numbers are never corrected: a wrong money record is deleted by the Director and recorded again.
  const FIELDS = {
    customers: [F("first_name", "First Name"), F("last_name", "Last Name"), F("phone", "Phone"), F("email", "Email", "email"), F("address", "Full Address"), F("business_name", "Business Name"), F("business_start_date", "Business Start Date", "date"), F("facebook_name", "Facebook Name"), F("facebook_link", "Facebook Account Link", "url"), F("has_extra_facebook", "Has Additional Facebook Account", "bool"), F("extra_facebook_name", "Additional Facebook Name"), F("facebook_verified", "Facebook Verified", "bool"), F("credit_limit", "Credit Limit (₱)", "money")],
    customer_invoices: [F("invoice_date", "Invoice Date", "date"), F("total_amount", "Total Amount (₱)", "money"), F("payment_terms", "Terms of Payment", "terms"), F("total_boxes", "Total Boxes", "int"), F("total_pcs", "Total Pcs", "int"),
      F("po_number", "PO Number")], // 2.6: every detail of an invoice; 2.6.1: PO Number only
    payments_received: [F("method", "Method", "select", METHODS), F("bank_name", "Bank Name"), F("bank_account", "Deposit Account"), F("reference_no", "Reference No"), F("notes", "Notes")],
    credit_memos: [F("payment_ref", "Payment Reference"), F("po_number", "Purchase Order"), F("article", "Article"), F("brand", "Brand"), F("style", "Style"), F("batch_no", "Batch No"), F("serial_no", "Serial No"), F("purchase_date", "Purchase Date", "date"),
      F("defect_category", "Defect Category", "select", [["fabric_damage", "Fabric Damage"], ["color_issue", "Color Issue"], ["wrong_box", "Wrong Box Delivered"], ["wrong_bundle", "Wrong Bundle"], ["other", "Other"]]), F("defect_detail", "Defect Details"),
      F("assigned_by", "Assigned By"), F("inspection_notes", "Inspection Notes", "textarea"), F("factory_status", "Factory Status", "textarea")],
    // 3.26: every detail of the employee (as on the paper job application)
    employees: [F("first_name", "First Name"), F("last_name", "Last Name"), F("position", "Position"), F("phone", "Phone"), F("address", "Present Address"), F("permanent_address", "Permanent Address"),
      F("date_hired", "Date Hired", "date"), F("monthly_salary", "Monthly Salary (₱)", "money"), F("duty_hours", "Duty Hours"),
      F("father_name", "Father's Name"), F("mother_name", "Mother's Name"), F("spouse_name", "Wife's / Husband's Name"), F("date_of_birth", "Date of Birth", "date"), F("birth_place", "Birth Place"),
      F("id_number", "BRC / NID / Passport No"), F("gender", "Gender", "select", [["Male", "Male"], ["Female", "Female"]]), F("religion", "Religion"),
      F("blood_group", "Blood Group", "select", ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"].map((g) => [g, g])),
      F("emergency_name", "Emergency Contact Name"), F("emergency_relation", "Emergency Contact Relationship"), F("emergency_phone", "Emergency Contact No"), F("emergency_address", "Emergency Contact Address")],
    payslips: [F("method", "Method"), F("reference_no", "Reference No"), F("notes", "Notes")],
    projects: [F("title", "Title"), F("description", "Description", "textarea"), F("location", "Location"), F("start_date", "Start Date", "date"), F("end_date", "End Date", "date")],
    project_payments: [F("received_by", "Received By"), F("method", "Method"), F("reference_no", "Reference No"), F("notes", "Notes")],
    pay_companies: [F("name", "Company Name"), F("contact_person", "Contact Person"), F("contact", "Phone / Email"), F("address", "Address"), F("currency", "Currency", "select", [["PHP", "PHP"], ["BDT", "BDT"], ["BOTH", "PHP, BDT"]]), F("notes", "Notes")],
    pay_accounts: [F("account_name", "Account Name"), F("account_number", "Account Number"), F("bank_name", "Bank Name"), F("branch_name", "Branch"), F("notes", "Notes")],
    pay_vouchers: [F("method", "Method"), F("reference_no", "Reference No"), F("notes", "Notes")],
    job_applications: [F("full_name", "Full Name"), F("phone", "Phone"), F("email", "Email", "email"), F("present_address", "Present Address"), F("permanent_address", "Permanent Address"), F("father_name", "Father's Name"), F("mother_name", "Mother's Name"), F("spouse_name", "Wife's / Husband's Name"), F("date_of_birth", "Date of Birth", "date"), F("birth_place", "Birth Place"), F("id_number", "BRC / NID / Passport No"), F("gender", "Gender"), F("religion", "Religion"), F("blood_group", "Blood Group"), F("apply_salary", "Expected Monthly Salary (₱)", "money"), F("apply_duty_hours", "Duty Hours"), F("apply_joining_date", "Joining Date", "date"),
      F("emergency_name", "Emergency Contact Name"), F("emergency_relation", "Emergency Contact Relationship"), F("emergency_phone", "Emergency Contact No"), F("emergency_address", "Emergency Contact Address")],
    stock_bills: [F("supplier_bill_no", "Bill No"), F("batch_no", "Batch No"), F("shipment_no", "System Record No"), F("shipment_date", "Shipment Date", "date"), F("total_boxes", "Total Boxes", "int"), F("notes", "Notes"),
      F("shipping_company", "Shipping Company"), F("shipping_company_code", "Shipping Company Code")]
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
    shipping_cost: "Shipping Fee (BDT)", shipping_bill_no: "Shipping Fee Receipt No", amount_bdt: "Amount (BDT)", memo_bill_id: "Pay on E-Bill" };
  const fieldLabel = (table, k) => (FIELDS[table] || []).find((f) => f.k === k)?.label || (table === "order_letters" && ORDER_FIELDS[k]) || k.replace(/_/g, " ");
  const showVal = (v) => (v === null || v === undefined || v === "" ? "(empty)" : typeof v === "boolean" ? (v ? "Yes" : "No") : typeof v === "object" ? JSON.stringify(v)
    : /^\d{4}-\d\d-\d\d$/.test(v) ? mdy(v) : String(v));
  // names: e-bill numbers by id (the e-bill a memo pays is saved as its id)
  // the details named in an approved or direct edit (2.9: only their names are kept)
  const fieldNames = (table, ch) => Object.keys(ch || {}).map((k) => fieldLabel(table, k)).join(", ");
  const changeList = (table, ch, prev, names) => Object.keys(ch || {}).map((k) => {
    const v = (x) => (k === "memo_bill_id" ? (x ? names?.get(x) || "another e-bill" : "(none)") : showVal(x));
    return `${fieldLabel(table, k)}: ${v(prev?.[k])} → ${v(ch[k])}`;
  }).join("; ");

  function fieldInput(f, v) {
    const id = "ed_" + f.k;
    if (f.type === "bool") return `<span>${esc(f.label)}</span><label class="sw"><input type="checkbox" id="${id}" ${v ? "checked" : ""}> Yes</label>`;
    const lab = `<label for="${id}">${esc(f.label)}</label>`;
    if (f.type === "textarea") return `${lab}<textarea id="${id}" rows="3">${esc(v ?? "")}</textarea>`;
    if (f.type === "select") {
      // 3.35: an empty value (or an old one not in the list) shows as it is, so Save does not change it by itself
      const blank = v == null || v === "", known = f.opts.some(([k]) => k === v);
      const keep = blank ? `<option value="" selected>—</option>` : known ? "" : `<option value="${esc(v)}" selected>${esc(v)}</option>`;
      return `${lab}<select id="${id}">${keep}${f.opts.map(([k, l]) => `<option value="${k}" ${k === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    }
    // 2.4: the Terms of Payment of an invoice: the usual terms, or other terms typed in
    if (f.type === "terms") {
      const other = !!v && !E.TERMS.includes(v);
      return `${lab}<select id="${id}" onchange="this.parentNode.querySelector('#${id}_x').hidden = this.parentNode.querySelector('[for=${id}_x]').hidden = this.value !== 'OTHER'">
          <option value="">—</option>${E.TERMS.map((t) => `<option ${t === v ? "selected" : ""}>${t}</option>`).join("")}<option value="OTHER" ${other ? "selected" : ""}>OTHER (type the terms)</option></select>
        <label for="${id}_x" ${other ? "" : "hidden"}>Other Terms</label><input type="text" id="${id}_x" maxlength="60" value="${esc(other ? v : "")}" ${other ? "" : "hidden"}>`;
    }
    const t = { date: "date", money: "number", rate: "number", int: "number", email: "email", url: "url" }[f.type] || "text";
    const step = { money: "0.01", rate: "0.0001", int: "1" }[f.type];
    const val = f.type === "date" ? String(v || "").slice(0, 10) : v ?? "";
    return `${lab}<input type="${t}" id="${id}" value="${esc(val)}" ${step ? `step="${step}" min="0"` : ""}>`;
  }
  function readField(f, root) {
    const el = $("#ed_" + f.k, root);
    if (f.type === "bool") return el.checked;
    if (f.type === "terms") {
      const t = el.value === "OTHER" ? $("#ed_" + f.k + "_x", root).value.trim().replace(/\s+/g, " ").toUpperCase() : el.value;
      return t || null;
    }
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

  // The Director edits a record directly: it takes the new details at once (a customer's: the main Director's only, 2.2).
  // An employee asks for a correction: the Director approves it, and the employee is told who approved it (2.9). No reason
  // is needed; an employee may add a note for the Director. A decided correction keeps no old details: the record shows only which details were changed and by whom.
  const correctsAtOnce = (table) => (table === "customers" ? !!S.mainDirector : isAdmin());
  function correctRecord(table, row, label, reload, opts = {}) {
    const fields = FIELDS[table];
    if (!fields) return toast("This record cannot be corrected.", true);
    const admin = correctsAtOnce(table), boss = table === "customers" ? "main Director" : "Director";
    const m = E.modal(`${admin ? "Edit" : "Request Correction"} — ${label}`, `
      <div class="hint">${admin ? `Saved at once by you (Director ${esc(S.profile?.full_name || "")}): the record shows the new details straight away.` : `Sent to the ${boss} for approval. When the ${boss} approves, the record takes the new details and you are told who approved it.`}</div>
      <div class="fields wide edit-grid">${fields.map((f) => fieldInput(f, row[f.k])).join("")}</div>
      ${MONEY.includes(table) && table !== "customer_invoices" ? `<small class="muted">Amounts and transaction dates cannot be changed here. If they are wrong, ${isAdmin() ? "delete this record" : "ask the Director to delete this record"} and record it again.</small>` : ""}
      ${admin ? "" : `<label class="fl" for="edReason">Note for the ${boss} (optional)</label><textarea id="edReason" rows="2" placeholder="Optional"></textarea>`}`,
      `<button type="button" class="btn" data-x>Close</button><button type="button" class="btn primary" data-ok>${admin ? `${ic("check")} Save Changes` : "Send for Approval"}</button>`, { wide: true });
    $("[data-x]", m.el).onclick = m.close;
    $("[data-ok]", m.el).onclick = async () => {
      const changes = {};
      for (const f of fields) { const v = readField(f, m.el); if (!same(f, row[f.k], v)) changes[f.k] = v; }
      if (!Object.keys(changes).length) return toast("Nothing was changed.", true);
      const reason = admin ? "" : $("#edReason", m.el).value.trim();
      const btn = $("[data-ok]", m.el); btn.disabled = true;
      const { data, error } = await sb.rpc("submit_change_request", { p_table: table, p_id: row.id, p_changes: changes, p_reason: reason, p_label: label });
      if (error) {
        btn.disabled = false;
        return fail(error, /reason/i.test(error.message || "") ? "Run the database update 022_update_2_9.sql first (a correction then needs no reason)" : admin ? "Could not save the changes" : "Could not send the correction");
      }
      m.close();
      toast(admin ? "Saved — the record shows the new details." : `Correction ${data.request_no} sent to the ${boss} for approval. You will be told when it is approved.`);
      // 3.11: the customer's Update Information request prints the update form after the page is drawn again
      if (reload) await reload();
      opts.onSaved?.({ req: data, changes, previous: row, atOnce: admin });
    };
  }
  // The Director deletes a record permanently, with its files. Nothing of it is shown afterwards.
  async function deleteRecord(table, row, label, afterDelete) {
    if (!isAdmin()) return;
    // A carried-out order letter is also undone (see undo_order in the database).
    const undo = table === "order_letters" && row.status === "applied" && row.stock_bill_id
      ? `<br><br>This Released Notice was carried out, so deleting it also <b>undoes it</b>: the e-bill goes back to SHIP, and its released date, released charge and shipping fee are removed.`
      : table === "order_letters" && row.status === "applied" && row.memo_bill_id
      ? `<br><br>This memo paid <b>BDT ${peso(row.amount_bdt)}</b> on E-Bill ${esc(row.stock_info?.bill_no || "")}, so deleting it also <b>removes that payment</b>: the e-bill's balance goes back up.`
      : table === "order_letters" && row.status === "applied"
      ? `<br><br>This order was carried out, so deleting it also <b>undoes it</b>: the status goes back to what it was before the order (if no later order changed it again), and a charge or settlement adjustment is removed from the balance and the statements.` : "";
    if (!(await E.confirmBox(`Delete <b>${esc(label)}</b> permanently? It will be removed from the portal with its files and its history lines, and cannot be brought back.${undo}`, { title: "Delete Record", ok: "Delete", danger: true }))) return;
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
    const fix = !!FIELDS[table] && !opts.noFix, del = admin && DELETABLE.includes(table);
    if (!fix && !del) return "";
    if (RT.size > 2000) RT.delete(RT.keys().next().value); // 3.35: the oldest goes (never the buttons of the page being drawn)
    const id = "rt" + Math.random().toString(36).slice(2, 9);
    RT.set(id, { table, row, label, ...opts });
    const fixLabel = table === "customers" && S.mainDirector ? "Edit Customer" : correctsAtOnce(table) ? "Edit" : "Request Correction";
    return `<span class="rtools" data-rt="${id}">${fix ? `<button type="button" class="btn" data-rt-fix>${ic("edit")} ${fixLabel}</button>` : ""}${del ? `<button type="button" class="btn danger" data-rt-del>${ic("trash")} Delete</button>` : ""}</span>`;
  }
  function bindRecordTools(root = document) {
    $$("[data-rt]", root).forEach((w) => {
      const o = RT.get(w.dataset.rt); if (!o) return;
      const fx = $("[data-rt-fix]", w), dl = $("[data-rt-del]", w);
      if (fx) fx.onclick = (e) => {
        e.stopPropagation();
        if (o.table === "customers" && S.mainDirector && E.editCustomer) E.editCustomer(o.row, o.reload);
        else correctRecord(o.table, o.row, o.label, o.reload);
      };
      if (dl) dl.onclick = (e) => { e.stopPropagation(); deleteRecord(o.table, o.row, o.label, o.afterDelete || o.reload); };
    });
  }
  // 3.22: record pages show no change history
  const rhBox = () => "";

  // ======================================================================
  // Corrections (requests and the log) — the Director only
  // ======================================================================
  V.changes = async () => {
    if (!isAdmin()) { location.hash = "dashboard"; return; }
    E.shell("changes", "Corrections", `
      <div class="tabs" id="crF"><button type="button" class="on" data-f="pending">Waiting for Approval</button><button type="button" data-f="log">Change Log</button></div>
      <div id="crRes">${busy()}</div>`,
      "Employees send <b>corrections</b> (wrong details) here. <b>Approve</b> puts the new details on the record; <b>Reject</b> leaves the record as it is. Either way the person who asked is told, with your name, and the correction is removed: the record keeps only a line naming the details changed and that you approved them (no old details). You edit records yourself with <b>Edit</b>: the record changes straight away. A customer's details are changed by the main Director only (<b>Edit Customer</b> on the customer).");
    const fresh = E.loadGuard();
    const run = async (f) => {
      const ok = fresh(); // 3.35: the tab chosen last wins
      $("#crRes").innerHTML = busy();
      if (f === "log") {
        const { data, error } = await sb.from("record_changes").select("*").order("created_at", { ascending: false }).limit(500);
        if (!ok()) return; // another tab or page was opened meanwhile
        if (error) return fail(error, "Could not load the change log");
        const rows = data || [];
        $("#crRes").innerHTML = E.grid({ cols: [
          { label: "Date / Time", get: (r) => E.stamp(new Date(r.created_at)) }, { label: "Record", get: (r) => `${TABLE_NAME[r.target_table] || r.target_table}: ${r.target_label || ""}` },
          { label: "Change", get: (r) => r.action === "file removed" ? `File removed: ${r.previous?.file || ""}` : r.action === "edited" ? `Edited: ${fieldNames(r.target_table, r.changes)}`
            : r.action === "correction approved" ? `Correction approved: ${fieldNames(r.target_table, r.changes)}${r.requested_by_name ? ` (asked by ${r.requested_by_name})` : ""}` : changeList(r.target_table, r.changes, r.previous) },
          { label: "By", get: (r) => r.actor_name || "" }, { label: "Correction No", get: (r) => r.request_no || "" }], rows, empty: "No changes yet." });
        return E.setRecords(`Changes: ${rows.length}`);
      }
      // a decided correction is removed (2.2): only the ones waiting are here
      const q = sb.from("change_requests").select("*").eq("status", "pending").order("created_at", { ascending: false }).limit(300);
      const { data, error } = await q;
      if (!ok()) return; // another tab or page was opened meanwhile
      if (error) return fail(error, "Could not load corrections");
      const rows = data || [];
      $("#crRes").innerHTML = rows.length ? rows.map((r) => `<article class="cr-card st-${esc(r.status)}">
          <header><b class="mono">${esc(r.request_no)}</b>${pill(r.status)}<span>${esc(TABLE_NAME[r.target_table] || r.target_table)}: ${ROUTE_OF[r.target_table] ? `<a href="#${ROUTE_OF[r.target_table]}/${r.target_id}">${esc(r.target_label || "open record")}</a>` : esc(r.target_label || "")}</span><small>${esc(E.dateTime(r.created_at))} · by ${esc(r.requested_by_name || "")}</small></header>
          ${r.reason ? `<div class="cr-reason"><b>Note:</b> ${esc(r.reason)}</div>` : ""}
          <table class="grid cr-diff"><thead><tr><th>Field</th><th>Original</th><th>Corrected</th></tr></thead><tbody>
            ${Object.keys(r.changes || {}).map((k) => `<tr><td>${esc(fieldLabel(r.target_table, k))}</td><td class="old">${esc(showVal(r.previous?.[k]))}</td><td class="new">${esc(showVal(r.changes[k]))}</td></tr>`).join("")}</tbody></table>
          ${r.status !== "pending" ? `<div class="cr-done">${r.status === "approved" ? "Approved" : "Rejected"} by ${esc(r.reviewed_by_name || "")} · ${esc(E.dateTime(r.reviewed_at))}${r.review_note ? " — " + esc(r.review_note) : ""}</div>`
            : r.target_table === "customers" && !S.mainDirector ? `<div class="cr-done">Waiting for the main Director: a customer's details are changed by the main Director only.</div>`
            : `<div class="cr-act"><input type="text" placeholder="Note (optional)" data-note="${r.id}"><button type="button" class="btn ok" data-cr="${r.id}" data-a="approve">${ic("check")} Approve</button><button type="button" class="btn danger" data-cr="${r.id}" data-a="reject">Reject</button></div>`}
        </article>`).join("") : `<div class="empty">${f === "pending" ? "Nothing waiting for approval." : "Nothing here."}</div>`;
      $$("[data-cr]").forEach((b) => (b.onclick = async () => {
        const note = $(`[data-note="${b.dataset.cr}"]`).value.trim() || null;
        b.disabled = true;
        const { error: e2 } = await sb.rpc("review_change_request", { p_id: b.dataset.cr, p_action: b.dataset.a, p_note: note });
        if (e2) { b.disabled = false; return fail(e2, "Could not update the request"); }
        toast(b.dataset.a === "reject" ? "Rejected — the record stays as it is, and the correction is removed. The person who asked is told." : "Approved — the record shows the new details. The person who asked is told you approved it."); run(f); E.refreshBadge();
      }));
      E.setRecords(`Requests: ${rows.length}`);
    };
    $$("#crF button").forEach((b) => (b.onclick = () => { $$("#crF button").forEach((x) => x.classList.toggle("on", x === b)); run(b.dataset.f); }));
    run("pending");
  };

  // ======================================================================
  // 2.9 Join Us (public): the open job positions; Apply → create an account (or sign in) → that position's form
  // ======================================================================
  const APPLY_KEY = "eoApplyPos";
  const keepApply = (id) => { try { id ? sessionStorage.setItem(APPLY_KEY, id) : sessionStorage.removeItem(APPLY_KEY); } catch (_) {} };
  V.careers = async () => {
    E.miniShell("Join Us", busy("Loading open positions"), { home: "#dashboard" });
    const { data, error } = await sb.from("job_positions").select("id, title, company_name, monthly_salary, duty_hours, description").eq("is_open", true).order("title");
    const list = error ? [] : data || [];
    $("#main").innerHTML = `
      <section class="verify-hero join-hero">
        <div class="vh-badge">${ic("users")}</div>
        <h2>Work with ${esc(C.company.name)}</h2>
        <p>${list.length ? "Choose an open position and apply in a few minutes. Create your free account, fill in the job application, and we will get back to you." : "Thank you for your interest in joining our team."}</p>
      </section>
      ${list.length ? `<h3 class="home-h">Open Positions <span class="muted">(${list.length})</span></h3>
        <div class="pos-grid">${list.map((p) => `<article class="pos-card"><h4>${esc(p.title)}</h4><div class="pos-co">${esc(p.company_name || C.company.name)}</div>
          <div class="pos-meta">${num(p.monthly_salary) ? `<span>₱ ${peso(p.monthly_salary)} / month</span>` : ""}${p.duty_hours ? `<span>${esc(p.duty_hours)}</span>` : ""}</div>
          ${p.description ? `<p>${esc(p.description)}</p>` : "<p></p>"}<button type="button" class="btn primary" data-join="${p.id}">Apply Now</button></article>`).join("")}</div>`
      : `<div class="join-empty"><div class="je-ic">${ic("doc")}</div><h3>No open positions right now</h3>
          <p>We post new jobs here first. Please check again soon — or send us a message and we will keep you in mind for the next opening.</p>
          <div class="btnrow center"><a class="btn primary" href="#contact">${ic("mail")} Contact Us</a><a class="btn" href="#dashboard">Back to Sign In</a></div></div>`}`;
    $$("[data-join]").forEach((b) => (b.onclick = () => {
      keepApply(b.dataset.join);
      if (!S.session) { toast("Create your free account to apply. Already have one? Sign in."); location.hash = "signup"; return; }
      location.hash = "dashboard";
    }));
  };

  // ======================================================================
  // Job applicant portal (new sign-ups that are not employees yet)
  // ======================================================================
  let applicantTimer = null;
  V.applicant = async () => {
    E.miniShell("Welcome", busy());
    clearInterval(applicantTimer);
    // Once the application is approved the account becomes active: open the full portal.
    applicantTimer = setInterval(async () => {
      if (!$(".mini-content") || !S.session) return clearInterval(applicantTimer);
      const { data } = await sb.from("profiles").select("status").eq("id", meId()).maybeSingle();
      if (data?.status === "active") { clearInterval(applicantTimer); S.profile = null; toast("Your application was approved. Welcome!"); E.route(); }
    }, 60000);
    const apps = await sb.from("job_applications").select("*").eq("profile_id", meId()).order("created_at", { ascending: false });
    if (apps.error) { $("#main").innerHTML = `<div class="empty">Job applications are not available yet. Please try again later.</div>`; return; }
    const last = (apps.data || [])[0];
    if (last && last.status !== "rejected") { keepApply(""); return applicantStatus(last); }
    // 3.24: no job applications on the portal any more: the Director adds the employee (or links this account)
    keepApply("");
    $(".band h1").textContent = "Welcome";
    // 3.25: an employee profile waiting for the Director's approval
    const mine = await sb.from("employees").select("employee_no, approval_status").eq("profile_id", meId()).maybeSingle();
    const waiting = mine.data?.approval_status === "pending";
    $("#main").innerHTML = waiting ? `<section class="welcome-card"><h2>Welcome, ${esc(S.profile.full_name || "")}!</h2>
      <p>Your employee profile <b>${esc(mine.data.employee_no || "")}</b> is <b>waiting for the Director's approval</b>. This page opens the portal by itself once it is approved.</p>
      <div class="btnrow"><button type="button" class="btn" id="apCheck">Check Again</button></div></section>` : `<section class="welcome-card"><h2>Welcome, ${esc(S.profile.full_name || "")}!</h2>
      <p>Your account <b>${esc(S.session.user.email)}</b> is ready. To work with ${esc(C.company.name)}, fill in the paper Employee Job Application Form at the office.
        The Director adds you as an employee with this email (or links this account to your employee profile). This page opens the portal by itself once that is done.</p>
      <div class="btnrow"><button type="button" class="btn" id="apCheck">Check Again</button></div></section>`;
    $("#apCheck").onclick = () => { S.profile = null; E.route(); };
  };
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
      ${a.status === "submitted" ? `<div class="fields wide" style="margin:8px 0">${E.fileField("asReq", "Add Requirements", 'multiple accept="image/*,application/pdf" data-save-now')}${a.photo_path ? "" : E.fileField("asPhoto", "Add Your Photo", 'accept="image/*"')}</div>
        <div class="btnrow"><button type="button" class="btn" id="asCheck">Check Status</button></div>` : ""}`;
    E.bindFiles($("#main"));
    E.bindDocCards($("#main"), () => applicantStatus(a));
    if ($("#asPhoto")) $("#asPhoto").onchange = async (e) => { const f = e.target.files[0]; if (!f) return; const ok = await addApplicationPhoto(a, f); toast(ok ? "Photo added." : "The photo could not be added.", !ok); applicantStatus(a); };
    if ($("#asCheck")) $("#asCheck").onclick = async () => { S.profile = null; E.route(); };
    if ($("#asReq")) $("#asReq").onchange = async (e) => { const here = E.stillHere(), f = await E.uploadRecords("job_application", a.id, "requirement", Array.from(e.target.files)); toast(f ? `${f} file(s) failed to upload.` : "Uploaded.", f > 0); if (here()) applicantStatus(a); };
  }


  // ======================================================================
  // Verification — anyone can check a record by number, QR code or barcode
  // ======================================================================
  const OPEN = {
    "Customer Account": ["customers", "account_no", "customer"], Invoice: ["customer_invoices", "invoice_no", "invoice"], "Payment Receipt": ["payments_received", "receipt_no", "payment"],
    "Credit Memo": ["credit_memos", "memo_no", "creditmemo"], "Statement of Account": ["statements", "statement_no", "customer", "customer_id"],
    "Payment Voucher": ["pay_vouchers", "voucher_no", "voucher"], Payslip: ["payslips", "payslip_no", "payslip"], "Job Application": ["job_applications", "application_no", "jobapp"],
    Employee: ["employees", "employee_no", "employee"], Project: ["projects", "project_no", "project"], "Project Payment": ["project_payments", "payment_no", "project", "project_id"],
    "E-Bill": ["stock_bills", "bill_no", "stockbill"], "E-Bill Statistics": ["stock_bills", "bill_no", "stockbill"], "Stock-Bill Statistics": ["stock_bills", "bill_no", "stockbill"]
  };
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
      // 3.21: an employee ID card is checked by its full code; only the card no shows (the code never goes into the address)
      if (/^EMONID\|/i.test(t) && E.cardCheck) {
        $("#vfCode").value = (t.split("|")[1] || "").toUpperCase();
        if (/^verify\/./.test(decodeURIComponent(location.hash.slice(1)))) history.replaceState(null, "", "#verify");
        $("#vfResult").innerHTML = `<div class="vf-wait">${busy("Checking the ID card")}</div>`;
        const r = await E.cardCheck(t);
        if ($("#vfResult")) $("#vfResult").innerHTML = r.html;
        return;
      }
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
    const key = d.type === "Customer Account" ? (fields.find(([k]) => k === "Public ID") || [])[1]
      : /^(E-Bill|E-Bill Statistics|Stock-Bill Statistics)$/.test(d.type) ? (fields.find(([k]) => k === "Secret Code") || [])[1] : null;
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
  // Contact Us (no sign-in needed) and the Director's Contact Messages (2.2)
  // ======================================================================
  const REPLY_VIA = { email: "Email", call: "Phone Call", sms: "SMS / Text", whatsapp: "WhatsApp", viber: "Viber", facebook: "Facebook Messenger" };
  const REPLY_TO = { email: "Your Email Address", call: "Your Mobile Number", sms: "Your Mobile Number", whatsapp: "Your WhatsApp Number",
    viber: "Your Viber Number", facebook: "Your Facebook Name or Profile Link" };
  V.contact = async () => {
    const inside = !!(S.session && S.profile?.status === "active");
    const body = `
      <section class="verify-hero contact-hero">
        <div class="vh-badge">${ic("mail")}</div>
        <h2>Contact Us</h2>
        <p>Send us a message and tell us how to reply. You get a reference number for your message.</p>
        <form id="ctForm" class="ct-form" novalidate>
          <label class="fl" for="ctName">Your Name *</label><input type="text" id="ctName" maxlength="120" autocomplete="name" required>
          <span class="fl">How Should We Reply? *</span>
          <div class="checks ct-via">${Object.entries(REPLY_VIA).map(([k, l], i) => `<label><input type="radio" name="ctVia" value="${k}" ${i ? "" : "checked"}> ${esc(l)}</label>`).join("")}</div>
          <label class="fl" for="ctTo" id="ctToL">${REPLY_TO.email} *</label><input type="text" id="ctTo" maxlength="200" autocomplete="email" required>
          <label class="fl" for="ctMsg">Message *</label><textarea id="ctMsg" rows="5" maxlength="2000" required></textarea>
          <small class="ct-count" id="ctCount">0 / 2,000</small>
          <input type="text" id="ctWeb" class="ct-hp" tabindex="-1" autocomplete="off" aria-hidden="true">
          <button type="submit" class="btn primary big">${ic("send")} Send Message</button>
        </form>
        <div id="ctDone" hidden></div>
      </section>`;
    if (inside) E.shell("contact", "Contact Us", body); else E.miniShell("Contact Us", body, { home: "#dashboard" });
    const via = () => $("input[name=ctVia]:checked").value;
    const relabel = () => {
      const v = via();
      $("#ctToL").textContent = REPLY_TO[v] + " *";
      $("#ctTo").type = v === "email" ? "email" : v === "facebook" ? "text" : "tel";
      $("#ctTo").autocomplete = v === "email" ? "email" : v === "facebook" ? "off" : "tel";
    };
    $$("input[name=ctVia]").forEach((r) => (r.onchange = relabel));
    $("#ctMsg").oninput = () => ($("#ctCount").textContent = `${$("#ctMsg").value.length.toLocaleString("en-US")} / 2,000`);
    $("#ctName").focus();
    $("#ctForm").onsubmit = async (e) => {
      e.preventDefault();
      const name = $("#ctName").value.trim(), to = $("#ctTo").value.trim(), msg = $("#ctMsg").value.trim(), v = via();
      if (name.length < 2) return toast("Enter your name.", true);
      if (v === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return toast("Enter your email address.", true);
      if (["call", "sms", "whatsapp", "viber"].includes(v) && !/^[0-9]{7,15}$/.test(to.replace(/[^0-9]/g, ""))) return toast("Enter your mobile number.", true);
      if (to.length < 3) return toast(`Enter ${REPLY_TO[v].toLowerCase()}.`, true);
      if (msg.length < 2) return toast("Write your message.", true);
      E.setBusy(e.target, true, "Sending");
      if ($("#ctWeb").value) { await new Promise((r) => setTimeout(r, 800)); E.setBusy(e.target, false); return; } // a robot filled the hidden box
      const { data: ref, error } = await sb.rpc("submit_contact_message", { p_name: name, p_reply_via: v, p_reply_to: to, p_message: msg });
      E.setBusy(e.target, false);
      if (error) return fail(error, "Could not send the message");
      $("#ctForm").hidden = true;
      const done = $("#ctDone");
      done.hidden = false;
      done.innerHTML = `<div class="ct-ok"><div class="vf-seal">✔</div><div class="vf-title">MESSAGE SENT</div>
        <div class="ct-ref-l">Your Reference No</div><div class="ct-ref mono" id="ctRef">${esc(ref)}</div>
        <p>Thank you, ${esc(name)}. Keep this number. We will reply by <b>${esc(REPLY_VIA[v])}</b> to <b>${esc(to)}</b>.</p>
        <div class="btnrow center"><button type="button" class="btn" id="ctCopy">${ic("copy")} Copy Reference No</button><button type="button" class="btn" id="ctAgain">${ic("mail")} Send Another Message</button>${inside ? "" : `<a class="btn primary" href="#dashboard">${ic("user")} Sign In</a>`}</div></div>`;
      $("#ctCopy").onclick = () => navigator.clipboard?.writeText(ref).then(() => toast("Reference No copied."), () => {});
      $("#ctAgain").onclick = () => V.contact();
      $("h2", done.closest(".contact-hero"))?.scrollIntoView({ block: "start", behavior: "smooth" });
    };
  };

  // Where to reply: a link that opens the email, call, SMS, WhatsApp, Viber or Facebook (Philippine 09… numbers as +63).
  const intl = (to) => { const d = String(to).replace(/[^0-9]/g, ""); return d.startsWith("0") ? "63" + d.slice(1) : d; };
  function replyLink(m) {
    const to = m.reply_to, t = esc(to);
    switch (m.reply_via) {
      case "email": return `<a href="mailto:${esc(encodeURIComponent(to).replace(/%40/g, "@"))}?subject=${esc(encodeURIComponent("Re: " + m.ref_no + " - " + C.company.name))}">${t}</a>`;
      case "call": return `<a href="tel:+${intl(to)}">${t}</a>`;
      case "sms": return `<a href="sms:+${intl(to)}">${t}</a>`;
      case "whatsapp": return `<a href="https://wa.me/${intl(to)}" target="_blank" rel="noopener">${t}</a>`;
      case "viber": return `<a href="viber://chat?number=%2B${intl(to)}">${t}</a>`;
      default: return /^https?:\/\/(www\.|m\.)?(facebook|fb)\.com\//i.test(to) ? `<a href="${esc(to)}" target="_blank" rel="noopener">${t}</a>` : t;
    }
  }
  V.contacts = async () => {
    if (!isAdmin()) { location.hash = "dashboard"; return; }
    E.shell("contacts", "Contact Messages", `
      <div class="tabs" id="ctF"><button type="button" class="on" data-f="new">New</button><button type="button" data-f="replied">Replied</button><button type="button" data-f="">All</button></div>
      <div id="ctRes">${busy()}</div>`,
      "Messages sent with <b>Contact Us</b> on the sign-in page, each with its reference number. Reply the way the person asked (press the email, number or Facebook link), then press <b>Mark Replied</b>.");
    const fresh = E.loadGuard();
    const run = async (f) => {
      const ok = fresh(); // 3.35: the tab chosen last wins
      $("#ctRes").innerHTML = busy();
      let q = sb.from("contact_messages").select("*").order("created_at", { ascending: false }).limit(500);
      if (f) q = q.eq("status", f);
      const { data, error } = await q;
      if (!ok()) return;
      if (error) return fail(error, "Could not load the messages");
      const rows = data || [];
      $("#ctRes").innerHTML = rows.length ? rows.map((m) => `<article class="cr-card ct-card ${m.status === "replied" ? "st-approved" : ""}">
          <header><b class="mono">${esc(m.ref_no)}</b> ${pill(m.status === "new" ? "pending" : "approved", m.status === "new" ? "NEW" : "REPLIED")} <span class="ct-from">${esc(m.name)}</span>
            <small>${esc(E.dateTime(m.created_at))} · Reply by <b>${esc(REPLY_VIA[m.reply_via] || m.reply_via)}</b>: ${replyLink(m)}</small></header>
          <div class="ct-msg">${esc(m.message)}</div>
          ${m.status === "replied" ? `<div class="cr-done">Replied by ${esc(m.replied_by_name || "")} · ${esc(E.dateTime(m.replied_at))}</div>` : ""}
          <div class="cr-act">${m.status === "new" ? `<button type="button" class="btn ok" data-ct="${m.id}" data-a="replied">${ic("check")} Mark Replied</button>` : `<button type="button" class="btn" data-ct="${m.id}" data-a="new">Mark as New</button>`}
            <button type="button" class="btn danger" data-ct="${m.id}" data-a="delete">${ic("trash")} Delete</button></div>
        </article>`).join("") : `<div class="empty">${f === "new" ? "No new messages." : "No messages."}</div>`;
      $$("[data-ct]").forEach((b) => (b.onclick = async () => {
        const m = rows.find((r) => r.id === b.dataset.ct), a = b.dataset.a;
        if (a === "delete" && !await E.confirmBox(`Delete message <b>${esc(m.ref_no)}</b> from ${esc(m.name)}? It is gone for good.`, { title: "Delete Message", ok: "Delete", danger: true })) return;
        b.disabled = true;
        const { error: e2 } = await sb.rpc("contact_message_action", { p_id: m.id, p_action: a });
        if (e2) { b.disabled = false; return fail(e2, "Could not update the message"); }
        toast(a === "replied" ? `${m.ref_no} marked replied.` : a === "new" ? `${m.ref_no} is new again.` : `${m.ref_no} deleted.`);
        run(f); E.refreshBadge();
      }));
      E.setRecords(`Messages: ${rows.length}`);
    };
    $$("#ctF button").forEach((b) => (b.onclick = () => { $$("#ctF button").forEach((x) => x.classList.toggle("on", x === b)); run(b.dataset.f); }));
    run("new");
  };

  // ======================================================================
  // Messages — chat between admin and employees, with photos and documents
  // ======================================================================
  const CH = { other: null, contacts: [], msgs: [], timer: null, tick: 0, busy: false };
  function openChat(withId) {
    clearTimeout(CH.closing); // 3.31: opened again while it was still closing: it stays open
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
    }
    document.addEventListener("keydown", chatKey);
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
    CH.closing = setTimeout(() => p.remove(), 320);
    if (E.S.session) E.refreshBadge();
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
    // 3.35: the last 2 minutes are asked again, so a message sent at the same moment as the last one shown (saved a
    // moment earlier, but stored a moment later) still comes; each message shows once, in time order
    if (!full && last) q = q.gt("created_at", new Date(new Date(last.created_at).getTime() - 120000).toISOString()); else q = q.limit(300);
    const { data, error } = await q;
    if (error || other !== CH.other) return;
    const fresh = (data || []).filter((m) => !CH.msgs.some((x) => x.id === m.id));
    if (!full && !fresh.length) return;
    CH.msgs = full ? data || [] : CH.msgs.concat(fresh).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    if (CH.msgs.some((m) => m.sender_id === other && !m.read_at)) {
      sb.rpc("mark_messages_read", { p_other: other }).then(() => { E.refreshBadge(); }, () => {});
      const c = CH.contacts.find((x) => x.id === other);
      if (c && c.unread) { c.unread = 0; renderContacts(); }
    }
    await renderMessages();
  }
  // the time under a message, and for my own messages Sent or Seen
  const msgFoot = (m, me) => `${esc(new Date(m.created_at).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" }))}${m.sender_id === me ? (m.read_at ? ` · <b class="cv-seen">✓✓ Seen</b>` : " · ✓ Sent") : ""}`;
  // 3.35: the address of each file in the chat is kept for 50 minutes (it is valid for an hour), so a new message does
  // not load every photo again; the chat stays where it was read unless the newest message was in view
  const chatUrls = new Map(); // path → { url, at }
  async function renderMessages() {
    const old = Date.now() - 50 * 60e3;
    const want = [...new Set(CH.msgs.map((m) => m.file_path).filter((p) => p && !(chatUrls.get(p)?.at > old)))];
    if (want.length) (await signedMap(want)).forEach((url, p) => chatUrls.set(p, { url, at: Date.now() }));
    const box = $("#cvMsgs"); if (!box) return;
    const atEnd = !box.querySelector(".cv-msg") || box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    const me = meId();
    let lastDay = "";
    box.innerHTML = CH.msgs.length ? CH.msgs.map((m) => {
      const day = new Date(m.created_at).toDateString();
      const sep = day !== lastDay ? `<div class="cv-day">${esc(E.mdy(m.created_at))}</div>` : "";
      lastDay = day;
      const u = m.file_path ? chatUrls.get(m.file_path)?.url || "" : "";
      const isImg = /^image\//.test(m.file_mime || "");
      const file = m.file_path ? (isImg && u ? `<button type="button" class="cv-img" data-img="${esc(u)}"><img src="${esc(u)}" alt="${esc(m.file_name || "Photo")}" loading="lazy"></button>`
        : `<a class="cv-file" href="${esc(u || "#")}" target="_blank" rel="noopener" download="${esc(m.file_name || "file")}">${ic("doc")} ${esc(m.file_name || "Document")}</a>`) : "";
      return `${sep}<div class="cv-msg ${m.sender_id === me ? "me" : "them"}" data-mid="${esc(m.id)}">${file}${m.body ? `<div class="cv-text">${esc(m.body)}</div>` : ""}
        <small>${msgFoot(m, me)}</small></div>`;
    }).join("") : `<div class="cp-empty small"><p>No messages yet. Say hello!</p></div>`;
    $$("[data-img]", box).forEach((b) => (b.onclick = () => lightbox(b.dataset.img)));
    if (atEnd) box.scrollTop = box.scrollHeight;
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
    const box = $("#cvMsgs"); if (box) box.scrollTop = box.scrollHeight; // a message just sent is always in view
  }
  // 3.31: "Seen" shows by itself when the other person reads a message (not only after opening the chat again)
  async function refreshSeen() {
    const other = CH.other, me = meId(), ids = CH.msgs.filter((m) => m.sender_id === me && !m.read_at).map((m) => m.id);
    if (!ids.length) return;
    const { data } = await sb.from("messages").select("id, read_at").in("id", ids).not("read_at", "is", null);
    if (!data?.length || other !== CH.other) return;
    // only the small line under each message changes (the chat is not drawn again, so nothing flickers)
    data.forEach((r) => {
      const m = CH.msgs.find((x) => x.id === r.id); if (!m) return;
      m.read_at = r.read_at;
      const s = $(`#cvMsgs .cv-msg[data-mid="${r.id}"] small`); if (s) s.innerHTML = msgFoot(m, me);
    });
  }
  async function pollChat() {
    if (!$(".chat-panel") || document.visibilityState !== "visible") return;
    CH.tick++;
    if (CH.other) { await loadMessages(false); await refreshSeen(); }
    if (CH.tick % 4 === 0) loadContacts();
  }

  Object.assign(E, { showVal, recordTools, bindRecordTools, correctRecord, deleteRecord, rhBox, fieldLabel, openChat, closeChat, shrinkImage, signedMap, lightbox });
})();
