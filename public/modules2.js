/* EMON OVERRUNS E-PORTAL — 5 Employee (staff, termination, payslips, job applications, positions, payroll),
   7 Project (application, approval, payments) and 8 Billing (companies → accounts → PHP/BDT payment vouchers). */
(function () {
  "use strict";
  const E = window.EO;
  const { sb, S, C, esc, peso, isoToday, dmy, stamp, $, $$, isAdmin, isStaff, pill, toast, fail, words, ic, busy } = E;
  const V = window.EO_VIEWS;
  const num = (v) => Number(v || 0);
  const fullName = (r) => `${r.first_name || ""} ${r.last_name || ""}`.trim();
  const monthLabel = (iso) => iso ? new Date(String(iso).slice(0, 10) + "T00:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" }) : "";
  const tools = (...a) => (E.recordTools ? E.recordTools(...a) : "");
  const bindTools = (root) => E.bindRecordTools && E.bindRecordTools(root);
  const rhBox = (t, id) => (E.rhBox ? E.rhBox(t, id) : "");
  // Menu access an employee can be given (Community, Verification and Download Forms are open to everyone).
  const MODULES = [["customers", "1 Customer"], ["invoices", "2 Invoice"], ["payments", "3 Payment"], ["creditmemos", "4 Credit Memo"], ["employees", "5 Employee (HR)"], ["projects", "7 Project"], ["billing", "8 Billing"], ["orders", "9 Order Letter"]];
  const accessText = (role, mods) => role === "admin" ? "Everything" : (mods || []).map((m) => (MODULES.find((x) => x[0] === m) || [m, m])[1]).join(", ") || "Dashboard and Community";
  async function uploadPhoto(folder, id, file) {
    if (!file) return null;
    const path = `${folder}/${id}/Photo_${Date.now()}.${E.extOf(file)}`;
    const up = await sb.storage.from("records").upload(path, file, { contentType: file.type });
    if (up.error) { toast("The photo could not be uploaded.", true); return null; }
    return path;
  }
  const photoBox = (url, fallback) => `<div class="ch-photo">${url ? `<img src="${esc(url)}" alt="">` : `<span>${esc(fallback)}</span>`}</div>`;
  const verifiedBadge = (on) => on ? `<span class="vbadge" title="Verified employee">${ic("check")}</span>` : "";

  // ======================================================================
  // 5. Employee
  // ======================================================================
  const empTabs = (on) => `<nav class="subnav">${[["employees", "Employees"], ["jobapps", "Job Applications"], ["positions", "Job Positions"], ["payroll", "Payroll"]]
    .map(([k, l]) => `<a href="#${k}" class="${k === on ? "on" : ""}">${l}</a>`).join("")}</nav>`;

  V.employees = async () => {
    E.shell("employees", "Employee", `${empTabs("employees")}
      <div class="tabs" id="emF"><button type="button" class="on" data-f="current">Current</button><button type="button" data-f="terminated">Terminated</button><button type="button" data-f="">All</button></div>
      <div class="btnrow">${isAdmin() ? `<a class="btn primary" href="#newemployee">+ New Employee</a>` : ""}<a class="btn" href="#jobapps">Job Applications</a></div>
      <div id="emRes">${busy()}</div>`,
      "Employees come from approved job applications, or the CEO adds them here. Open an employee to record salary or advance payments, change access, or terminate.");
    const [{ data, error }, att] = await Promise.all([
      sb.from("employees").select("*").order("created_at", { ascending: false }),
      sb.from("attachments").select("owner_id, kind").eq("owner_type", "employee").in("kind", ["signature", "signed_form", "application"])
    ]);
    if (error) return fail(error, "Could not load employees");
    const docs = new Set((att.data || []).map((a) => a.owner_id));
    const all = (data || []).map((r) => ({ ...r, verified: r.status === "active" && (!!r.job_application_id || docs.has(r.id)) }));
    const run = (f) => {
      const rows = f === "current" ? all.filter((r) => r.status !== "terminated") : f ? all.filter((r) => r.status === f) : all;
      $("#emRes").innerHTML = E.grid({ cols: [
        { label: "Employee No", get: (r) => r.employee_no }, { label: "Name", html: (r) => `${esc(fullName(r))} ${verifiedBadge(r.verified)}` }, { label: "Position", get: (r) => r.position || "" },
        { label: "Email", get: (r) => r.email }, { label: "Role", get: (r) => E.roleName(r.role).toUpperCase() }, { label: "Access", get: (r) => accessText(r.role, r.modules) },
        { label: "Salary (₱)", num: true, get: (r) => peso(r.monthly_salary) },
        { label: "Status", html: (r) => r.status === "waiting" ? `<span class="pill pending">WAITING SIGN-UP</span>` : pill(r.status) }],
        rows, onRow: true, empty: f === "terminated" ? "No terminated employees." : "No employees yet." });
      E.bindGrid($("#emRes"), rows, (r) => (location.hash = "employee/" + r.id));
      E.setRecords(`Employees: ${rows.length}`);
    };
    $$("#emF button").forEach((b) => (b.onclick = () => { $$("#emF button").forEach((x) => x.classList.toggle("on", x === b)); run(b.dataset.f); }));
    run("current");
  };

  const accessFields = (role, mods) => `
    <label for="emRole">Role</label><select id="emRole">
      <option value="staff" ${role === "staff" ? "selected" : ""}>Staff — can add and record</option>
      <option value="viewer" ${role === "viewer" ? "selected" : ""}>Viewer — can only look</option>
      <option value="admin" ${role === "admin" ? "selected" : ""}>CEO — everything, approves</option></select>
    <span>Menu Access</span><div><div class="checks access">${MODULES.map(([k, l]) => `<label><input type="checkbox" name="emMod" value="${k}" ${mods.includes(k) ? "checked" : ""}> ${l}</label>`).join("")}</div>
      <small class="muted">Dashboard, Community, Messages and Verification are open to everyone.</small></div>`;
  const readAccess = () => ({ role: $("#emRole").value, modules: $$("input[name=emMod]:checked").map((x) => x.value) });

  V.newemployee = () => {
    if (!isAdmin()) { location.hash = "employees"; return; }
    E.shell("newemployee", "New Employee", `
      <form class="window" id="neForm" novalidate><div class="wtitle">Employee Information</div><div class="wbody">
        <div class="summary-box"><div class="fields wide"><span>Employee No</span><b>Assigned on save (EO-YYYYMM##)</b><span>Created By</span><b>${esc(S.profile.full_name || "")}</b></div></div>
        <fieldset class="opt"><legend>Personal Details</legend><div class="formgrid">
          <div class="fields wide">
            <label for="neFirst">First Name *</label><input type="text" id="neFirst" required>
            <label for="neLast">Last Name *</label><input type="text" id="neLast" required>
            <label for="nePos">Position</label><input type="text" id="nePos" placeholder="e.g. Warehouse Staff">
            <label for="neHired">Date Hired</label><input type="date" id="neHired" value="${isoToday()}">
            <label for="neSalary">Monthly Salary (₱)</label><input type="number" id="neSalary" min="0" step="0.01" value="0">
          </div>
          <div class="fields wide">
            <label for="neEmail">Email (login) *</label><input type="email" id="neEmail" required>
            <label for="nePhone">Phone</label><input type="tel" id="nePhone">
            <label for="neAddr">Address</label><input type="text" id="neAddr">
            <label for="nePhoto">Photo</label><input type="file" id="nePhoto" accept="image/*">
          </div></div></fieldset>
        <fieldset class="opt"><legend>Documents</legend><div class="fields wide">
          ${E.fileField("neApp", "Application Form", 'multiple accept="image/*,application/pdf"')}
          ${E.fileField("neSig", "Signature Form", 'accept="image/*,application/pdf"')}
          <span></span><small>Documents can also be uploaded later from the employee profile.</small></div></fieldset>
        <fieldset class="opt"><legend>Access</legend><div class="fields wide">${accessFields("staff", ["customers"])}</div></fieldset>
      </div><div class="wfoot"><a class="btn" href="#employees">Cancel</a><button type="submit" class="btn primary">Save Employee</button></div></form>`,
      "The employee then signs up with the same email (Create Account) and gets in straight away with the access chosen here.");
    $("#neForm").onsubmit = async (e) => {
      e.preventDefault();
      const v = (id) => $("#" + id).value.trim();
      if (!v("neFirst") || !v("neLast")) return toast("Enter the first and last name.", true);
      if (!/^\S+@\S+\.\S+$/.test(v("neEmail"))) return toast("Enter a valid email. The employee signs in with it.", true);
      E.setBusy(e.target, true, "Saving");
      const id = E.uuid();
      const photo_path = await uploadPhoto("employee", id, $("#nePhoto").files[0]);
      const { data, error } = await sb.from("employees").insert({
        id, first_name: v("neFirst"), last_name: v("neLast"), position: v("nePos") || null, email: v("neEmail"),
        phone: v("nePhone") || null, address: v("neAddr") || null, date_hired: v("neHired") || null, monthly_salary: num(v("neSalary")), photo_path, ...readAccess()
      }).select().single();
      if (error) { E.setBusy(e.target, false); return fail(error, "Could not save the employee"); }
      let f = await E.uploadRecords("employee", id, "application", E.filesOf("neApp"));
      f += await E.uploadRecords("employee", id, "signature", E.filesOf("neSig"));
      toast(`Saved ${data.employee_no}.${f ? ` ${f} file(s) failed.` : ""}`, f > 0);
      location.hash = "employee/" + id;
    };
  };

  V.employee = async (id) => {
    E.shell("employee", "Employee", busy());
    const { data: em } = await sb.from("employees").select("*").eq("id", id).maybeSingle();
    if (!em) { $("#main").innerHTML = `<div class="empty">Employee not found. <a href="#employees">Back</a></div>`; return; }
    const [att, ps, ja] = await Promise.all([
      E.attachmentsOf("employee", id),
      sb.from("payslips").select("*").eq("employee_id", id).order("pay_date", { ascending: false }),
      em.job_application_id ? sb.from("job_applications").select("*").eq("id", em.job_application_id).maybeSingle() : Promise.resolve({ data: null })
    ]);
    const slips = ps.data || [];
    const app = ja.data;
    const photo = em.photo_path ? await E.signedUrl(em.photo_path) : "";
    const verified = em.status === "active" && (!!em.job_application_id || att.some((a) => ["signature", "signed_form", "application"].includes(a.kind)));
    const canPay = E.canWrite("employees") && em.status !== "terminated";
    const paid = slips.reduce((s, p) => s + num(p.net_pay), 0);
    const advances = slips.reduce((s, p) => s + num(p.advance_amount), 0) - slips.reduce((s, p) => s + num(p.advance_deduction), 0);
    $(".band h1").textContent = `Employee — ${fullName(em)}`;
    $("#main").innerHTML = `
      ${em.status === "terminated" ? `<div class="banner closed">TERMINATED on ${dmy(em.termination_date)} — ${esc(em.termination_reason || "")}. The login is disabled.</div>` : ""}
      ${em.status === "waiting" ? `<div class="banner warn">No login yet. Ask ${esc(em.first_name)} to open the portal, tap <b>Create Account</b> and use <b>${esc(em.email)}</b>. They get in straight away with the access below.</div>` : ""}
      <section class="cust-hero st-${esc(em.status)}">${photoBox(photo, (em.first_name[0] || "") + (em.last_name[0] || ""))}
        <div class="ch-main"><div class="ch-name"><h2>${esc(fullName(em))}</h2>${verifiedBadge(verified)}${em.status === "waiting" ? `<span class="pill pending">WAITING SIGN-UP</span>` : pill(em.status)}</div>
          <div class="ch-sub">${esc(em.position || "—")} · ${esc(em.email)}${em.phone ? " · " + esc(em.phone) : ""}</div>
          <div class="ch-ids">${E.idBox("Employee No", em.employee_no)}${E.idBox("Date Hired", dmy(em.date_hired))}${E.idBox("Monthly Salary (₱)", peso(em.monthly_salary))}${E.idBox("Role", E.roleName(em.role).toUpperCase())}</div></div></section>
      <div class="tiles"><div class="tile ok"><div class="k">Total Paid (₱)</div><div class="v">₱ ${peso(paid)}</div></div>
        <div class="tile ${advances > 0 ? "warn" : ""}"><div class="k">Advance Balance (₱)</div><div class="v">₱ ${peso(Math.max(0, advances))}</div></div>
        <div class="tile"><div class="k">Payslips</div><div class="v">${slips.length}</div></div></div>
      <div class="actionbar">
        ${canPay ? `<button type="button" class="btn primary" id="emPay">${ic("plus")} Record Salary / Advance</button>` : ""}
        <button type="button" class="btn" id="emPrint">${ic("print")} Print Employee Record</button>
        ${isAdmin() && em.status !== "terminated" && em.profile_id !== S.profile.id ? `<button type="button" class="btn danger" id="emTerm">Terminate</button>` : ""}
        ${isAdmin() && em.status === "terminated" ? `<button type="button" class="btn ok" id="emRehire">Re-hire</button>` : ""}
        <span class="grow"></span>
        ${tools("employees", em, `${em.employee_no} ${fullName(em)}`, { reload: () => V.employee(id), afterDelete: () => (location.hash = "employees") })}
      </div>
      <div class="tabs" id="emTabs">${[`Payslips (${slips.length})`, "Documents", ...(isAdmin() ? ["Access & Status"] : []), "Details"].map((t, i) => `<button type="button" class="${i ? "" : "on"}" data-t="${i}">${esc(t)}</button>`).join("")}</div>
      <div class="tabpanes" id="emPanes">
        <div data-p="0"><div id="emSlips">${E.grid({ cols: SLIP_COLS, rows: slips, onRow: true, foot: { net_pay: peso(paid) }, empty: "No salary or advance payments recorded yet." })}</div></div>
        <div data-p="1" hidden>
          ${app ? `<div class="docgrid">${E.docCard({ key: "ja", title: `Job Application Form ${app.application_no}`, sub: `Approved ${app.approval_no || ""}`, ownerType: "job_application", ownerId: app.id, att: await E.attachmentsOf("job_application", app.id), print: () => printJobApp(app), canUpload: isAdmin() })}</div>
            <p><a href="#jobapp/${app.id}">Open job application ${esc(app.application_no)}</a></p>` : ""}
          ${E.filesHtml(att, "No documents uploaded.")}
          ${isAdmin() ? `<div class="fields wide" style="margin-top:8px">${E.fileField("emSig", "Upload Signature Form", 'accept="image/*,application/pdf"')}${E.fileField("emApp", "Upload Application", 'multiple accept="image/*,application/pdf"')}</div>` : ""}
        </div>
        ${isAdmin() ? `<div data-p="2" hidden><fieldset class="opt"><legend>Access &amp; Status</legend><div class="fields wide">${accessFields(em.role, em.modules || [])}
          ${["active", "inactive"].includes(em.status) ? `<label for="emStatus">Login</label><select id="emStatus"><option value="active" ${em.status === "active" ? "selected" : ""}>Active — can sign in</option><option value="inactive" ${em.status === "inactive" ? "selected" : ""}>Inactive — blocked</option></select>` : ""}</div>
          <div class="btnrow"><button type="button" class="btn primary" id="emSave">Save Access</button></div></fieldset></div>` : ""}
        <div data-p="${isAdmin() ? 3 : 2}" hidden><div class="grid-wrap"><table class="grid kv-table"><tbody>${[["Employee No", em.employee_no], ["Name", fullName(em)], ["Position", em.position], ["Email (login)", em.email], ["Phone", em.phone], ["Address", em.address], ["Date Hired", dmy(em.date_hired)], ["Monthly Salary", "₱ " + peso(em.monthly_salary)], ["Access", accessText(em.role, em.modules)], ["Status", em.status.toUpperCase()], ["Terminated", em.termination_date ? `${dmy(em.termination_date)} — ${em.termination_reason || ""}` : ""], ["Created By", em.created_by_name]].map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v || "—")}</td></tr>`).join("")}</tbody></table></div>${rhBox("employees", em.id)}</div>
      </div>`;
    $$("#emTabs button").forEach((t) => (t.onclick = () => { $$("#emTabs button").forEach((x) => x.classList.toggle("on", x === t)); $$("#emPanes > div").forEach((p) => (p.hidden = p.dataset.p !== t.dataset.t)); }));
    E.bindGrid($("#emSlips"), slips, (r) => (location.hash = "payslip/" + r.id));
    E.bindFiles($("#main"));
    E.bindDocCards($("#main"), () => V.employee(id));
    bindTools($("#main"));
    if ($("#emPay")) $("#emPay").onclick = () => payslipDialog(em, (p) => (location.hash = "payslip/" + p.id));
    if ($("#emSave")) $("#emSave").onclick = async () => {
      const acc = readAccess();
      const { error } = await sb.rpc("set_employee_access", { p_id: id, p_role: acc.role, p_modules: acc.modules, p_status: $("#emStatus") ? $("#emStatus").value : null });
      if (error) return fail(error, "Could not save");
      toast("Access saved."); V.employee(id);
    };
    const up = (inp, kind) => inp && (inp.onchange = async (e) => { const f = await E.uploadRecords("employee", id, kind, Array.from(e.target.files)); toast(f ? "Upload failed." : "Uploaded.", f > 0); V.employee(id); });
    up($("#emSig"), "signature"); up($("#emApp"), "application");
    if ($("#emTerm")) $("#emTerm").onclick = () => {
      const m = E.modal(`Terminate ${fullName(em)}`, `<div class="banner closed">The employee's login is disabled immediately. Payslips and records are kept.</div>
        <div class="fields wide"><label for="tmDate">Termination Date</label><input type="date" id="tmDate" value="${isoToday()}">
        <label for="tmReason">Reason *</label><textarea id="tmReason" rows="3" placeholder="e.g. End of contract, resigned, misconduct"></textarea></div>`,
        `<button type="button" class="btn" data-x>Cancel</button><button type="button" class="btn primary danger-fill" data-ok>Terminate Employee</button>`);
      $("[data-x]", m.el).onclick = m.close;
      $("[data-ok]", m.el).onclick = async () => {
        const reason = $("#tmReason", m.el).value.trim();
        if (!reason) return toast("Enter the reason for termination.", true);
        const { error } = await sb.rpc("terminate_employee", { p_id: id, p_date: $("#tmDate", m.el).value || isoToday(), p_reason: reason });
        if (error) return fail(error, "Could not terminate");
        m.close(); toast(`${fullName(em)} terminated.`); V.employee(id);
      };
    };
    if ($("#emRehire")) $("#emRehire").onclick = async () => {
      if (!(await E.confirmBox(`Re-hire <b>${esc(fullName(em))}</b>? Their login is enabled again with the same access.`, { ok: "Re-hire" }))) return;
      const { error } = await sb.rpc("rehire_employee", { p_id: id });
      if (error) return fail(error, "Could not re-hire");
      toast(`${fullName(em)} re-hired.`); V.employee(id);
    };
    $("#emPrint").onclick = () => E.openPreview(`Employee ${em.employee_no}`, [`${E.printHead("EMPLOYEE INFORMATION", `<img src="${E.pdf417DataUrl("EMONEMP|" + em.employee_no)}" alt="" class="ph-bar"><div class="mono">${esc(em.employee_no)}</div>`)}
      ${E.box("Employee", `<div class="pgrid"><div class="pphoto">${photo ? `<img src="${esc(photo)}" alt="">` : "PHOTO"}</div><div class="pgrid2">
        ${E.cell("First Name", em.first_name)}${E.cell("Last Name", em.last_name)}${E.cell("Position", em.position)}${E.cell("Date Hired", dmy(em.date_hired))}
        ${E.cell("Email", em.email)}${E.cell("Phone", em.phone)}${E.cell("Monthly Salary (PHP)", peso(em.monthly_salary))}${E.cell("Status", em.status.toUpperCase())}
        ${E.cell("Address", em.address, "span2")}</div></div>`)}
      ${E.box("Portal Access", `<div class="pgrid2">${E.cell("Role", E.roleName(em.role).toUpperCase())}${E.cell("Menu Access", accessText(em.role, em.modules))}</div>`)}
      ${em.status === "terminated" ? E.box("Termination", `<div class="pgrid2">${E.cell("Date", dmy(em.termination_date))}${E.cell("Reason", em.termination_reason)}</div>`) : ""}
      ${E.box("Specimen Signature", `<div class="sigbox"><div></div><div></div><div></div></div>`)}
      ${E.sigs("Employee Signature / Date", "Approved by / Date")}`]);
    E.setRecords(`Employee: ${em.employee_no}`);
  };

  // ---------- payslips: salary, advance, bonus ----------
  const PAY_TYPE = { salary: "Salary", advance: "Advance", bonus: "Bonus", other: "Other" };
  const SLIP_COLS = [
    { label: "Payslip No", get: (r) => r.payslip_no }, { label: "Type", get: (r) => PAY_TYPE[r.pay_type] || r.pay_type }, { label: "For Month", get: (r) => monthLabel(r.period_month) },
    { label: "Pay Date", get: (r) => dmy(r.pay_date) }, { label: "Method", get: (r) => r.method || "" }, { label: "Net Pay (₱)", key: "net_pay", num: true, get: (r) => peso(r.net_pay) },
    { label: "Recorded By", get: (r) => r.created_by_name || "" }
  ];
  function payslipDialog(em, onDone) {
    const money = (id, label, show, val = 0) => `<div class="fpair" data-for="${show}"><label for="${id}">${label}</label><input type="number" id="${id}" min="0" step="0.01" value="${val}"></div>`;
    const m = E.modal(`Record Payment — ${fullName(em)} (${em.employee_no})`, `
      <div class="seg" id="psType">${Object.entries(PAY_TYPE).map(([k, l], i) => `<button type="button" data-t="${k}" class="${i ? "" : "on"}">${l}</button>`).join("")}</div>
      <div class="formgrid">
        <div class="fields wide">
          <label for="psPeriod">For Month</label><input type="month" id="psPeriod" value="${isoToday().slice(0, 7)}">
          <label for="psDate">Pay Date</label><input type="date" id="psDate" value="${isoToday()}">
          <label for="psMethod">Method</label><select id="psMethod"><option>Cash</option><option>Bank Transfer</option><option>GCash</option><option>Online Transfer</option></select>
          <label for="psRef">Reference No</label><input type="text" id="psRef">
          <label for="psNotes">Notes</label><input type="text" id="psNotes">
        </div>
        <div class="fields wide">
          ${money("psBasic", "Basic Pay (₱)", "salary other", num(em.monthly_salary))}
          ${money("psAllow", "Allowances (₱)", "salary")}
          ${money("psOt", "Overtime Pay (₱)", "salary")}
          ${money("psBonus", "Bonus (₱)", "salary bonus")}
          ${money("psAdv", "Advance Amount (₱)", "advance")}
          ${money("psAdvDed", "Less: Advance Deduction (₱)", "salary")}
          ${money("psOther", "Less: Other Deductions (₱)", "salary other")}
        </div>
      </div>
      <div class="netbox"><span>NET PAY</span><b id="psNet">₱ 0.00</b><small id="psWords"></small></div>`,
      `<button type="button" class="btn" data-x>Cancel</button><button type="button" class="btn primary" data-save>Save &amp; Create Payslip</button>`, { wide: true });
    const d = m.el;
    let type = "salary";
    const val = (id) => { const el = $("#" + id, d); return el && !el.closest(".fpair").hidden ? num(el.value) : 0; };
    const calc = () => {
      const net = val("psBasic") + val("psAllow") + val("psOt") + val("psBonus") + val("psAdv") - val("psAdvDed") - val("psOther");
      $("#psNet", d).textContent = "₱ " + peso(net);
      $("#psNet", d).classList.toggle("neg", net < 0);
      $("#psWords", d).textContent = words(Math.max(0, net));
      return net;
    };
    const setType = (t) => {
      type = t;
      $$("#psType button", d).forEach((b) => b.classList.toggle("on", b.dataset.t === t));
      $$(".fpair", d).forEach((p) => (p.hidden = !p.dataset.for.split(" ").includes(t)));
      if (t === "other") $("label[for=psBasic]", d).textContent = "Amount (₱)"; else $("label[for=psBasic]", d).textContent = "Basic Pay (₱)";
      if (t === "salary" && !num($("#psBasic", d).value)) $("#psBasic", d).value = num(em.monthly_salary);
      if (t === "other") $("#psBasic", d).value = 0;
      const first = $(".fpair:not([hidden]) input", d); if (first) first.focus();
      calc();
    };
    $$("#psType button", d).forEach((b) => (b.onclick = () => setType(b.dataset.t)));
    $$("input", d).forEach((i) => (i.oninput = calc));
    setType("salary");
    $("[data-x]", d).onclick = m.close;
    $("[data-save]", d).onclick = async () => {
      const net = calc();
      if (net <= 0) return toast("The net pay must be more than zero.", true);
      const btn = $("[data-save]", d); btn.disabled = true;
      const { data, error } = await sb.from("payslips").insert({
        employee_id: em.id, pay_type: type, period_month: ($("#psPeriod", d).value || isoToday().slice(0, 7)) + "-01", pay_date: $("#psDate", d).value || isoToday(),
        basic_pay: val("psBasic"), allowances: val("psAllow"), overtime_pay: val("psOt"), bonus: val("psBonus"), advance_amount: val("psAdv"),
        advance_deduction: val("psAdvDed"), other_deductions: val("psOther"), method: $("#psMethod", d).value, reference_no: $("#psRef", d).value.trim() || null, notes: $("#psNotes", d).value.trim() || null
      }).select().single();
      btn.disabled = false;
      if (error) return fail(error, "Could not record the payment");
      m.close();
      toast(`${PAY_TYPE[type]} recorded — payslip ${data.payslip_no}.`);
      onDone(data);
    };
  }
  function payslipPage(p) {
    const em = p.employees;
    const title = { salary: "PAYSLIP", advance: "SALARY ADVANCE RECEIPT", bonus: "BONUS PAYSLIP", other: "PAYMENT RECEIPT" }[p.pay_type] || "PAYSLIP";
    const earn = [["Basic Pay", p.basic_pay, p.pay_type !== "advance"], ["Allowances", p.allowances], ["Overtime Pay", p.overtime_pay], ["Bonus", p.bonus], ["Advance Given", p.advance_amount]].filter((x) => x[2] || num(x[1]) > 0);
    const ded = [["Advance Deduction", p.advance_deduction], ["Other Deductions", p.other_deductions]].filter((x) => num(x[1]) > 0);
    const gross = earn.reduce((s, x) => s + num(x[1]), 0), less = ded.reduce((s, x) => s + num(x[1]), 0);
    return `${E.printHead(title, `<img src="${E.pdf417DataUrl("EMONPS|" + p.payslip_no)}" alt="" class="ph-bar"><div class="mono">${esc(p.payslip_no)}</div>`)}
      ${E.box("Employee", `<div class="pgrid2">${E.cell("Employee Name", fullName(em), "hl")}${E.cell("Employee No", em.employee_no)}${E.cell("Position", em.position)}${E.cell("Payslip No", p.payslip_no)}
        ${E.cell("For Month", monthLabel(p.period_month))}${E.cell("Pay Date", dmy(p.pay_date))}${E.cell("Payment Method", p.method)}${E.cell("Reference No", p.reference_no)}</div>`)}
      <div class="pgrid2 slip-cols">
        ${E.box("Earnings", `<table class="rp"><tbody>${earn.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${peso(v)}</td></tr>`).join("")}<tr class="sub"><td>Total</td><td class="num">${peso(gross)}</td></tr></tbody></table>`)}
        ${E.box("Deductions", `<table class="rp"><tbody>${ded.length ? ded.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${peso(v)}</td></tr>`).join("") : `<tr><td>None</td><td class="num">0.00</td></tr>`}<tr class="sub"><td>Total</td><td class="num">${peso(less)}</td></tr></tbody></table>`)}
      </div>
      <div class="net-print"><span>NET PAY (PHP)</span><b>₱ ${peso(p.net_pay)}</b></div>
      <div class="pcell"><div class="pl">Amount in Words</div><div class="pv words">${esc(words(p.net_pay))}</div></div>
      ${p.notes ? `<p class="pdecl"><b>Notes:</b> ${esc(p.notes)}</p>` : ""}
      <p class="pdecl">I acknowledge receipt of the amount above from ${esc(C.company.name)}.</p>
      ${E.sigs("Received by (Employee Signature) / Date", `Prepared by: <b>${esc(p.created_by_name || "")}</b>`)}`;
  }
  V.payslip = async (id) => {
    E.shell("payslip", "Payslip", busy());
    const { data: p } = await sb.from("payslips").select("*, employees(*)").eq("id", id).maybeSingle();
    if (!p) { $("#main").innerHTML = `<div class="empty">Payslip not found. <a href="#profile">Back</a></div>`; return; }
    const att = await E.attachmentsOf("payslip", id);
    const em = p.employees;
    const hr = E.hasModule("employees");
    $(".band h1").textContent = `Payslip — ${p.payslip_no}`;
    $("#main").innerHTML = `<div class="window"><div class="wtitle">${esc(p.payslip_no)} · ${esc(PAY_TYPE[p.pay_type])}</div><div class="wbody">
      <div class="formgrid"><div class="fields wide"><span>Employee</span><span>${hr ? `<a href="#employee/${em.id}"><b>${esc(fullName(em))}</b></a>` : `<b>${esc(fullName(em))}</b>`} (${esc(em.employee_no)})</span>
        <span>Position</span><span>${esc(em.position || "—")}</span><span>For Month</span><span>${esc(monthLabel(p.period_month))}</span><span>Pay Date</span><span>${dmy(p.pay_date)}</span>
        <span>Method</span><span>${esc(p.method || "—")}${p.reference_no ? " · Ref " + esc(p.reference_no) : ""}</span></div>
        <div class="fields wide"><span>Basic Pay</span><span>₱ ${peso(p.basic_pay)}</span><span>Allowances</span><span>₱ ${peso(p.allowances)}</span><span>Overtime</span><span>₱ ${peso(p.overtime_pay)}</span>
        <span>Bonus</span><span>₱ ${peso(p.bonus)}</span><span>Advance Given</span><span>₱ ${peso(p.advance_amount)}</span><span>Deductions</span><span>₱ ${peso(num(p.advance_deduction) + num(p.other_deductions))}</span>
        <span>Net Pay</span><b class="big">₱ ${peso(p.net_pay)}</b></div></div>
      <div class="docgrid">${E.docCard({ key: "slip", title: `Payslip ${p.payslip_no}`, sub: `Net ₱ ${peso(p.net_pay)} · ${monthLabel(p.period_month)}`, ownerType: "payslip", ownerId: p.id, att, print: () => E.openPreview(`Payslip ${p.payslip_no}`, [payslipPage(p)]), canUpload: E.canWrite("employees") })}</div>
      ${hr ? rhBox("payslips", p.id) : ""}
      </div><div class="wfoot">${hr ? tools("payslips", p, `Payslip ${p.payslip_no}`, { reload: () => V.payslip(id), afterDelete: () => (location.hash = "employee/" + em.id) }) : ""}
        <a class="btn" href="${hr ? "#employee/" + em.id : "#profile"}">Close</a></div></div>`;
    E.bindDocCards($("#main"), () => V.payslip(id));
    bindTools($("#main"));
    E.setRecords(`Payslip: ${p.payslip_no}`);
  };

  V.payroll = async () => {
    E.shell("payroll", "Employee — Payroll", `${empTabs("payroll")}
      <div class="options"><fieldset class="opt"><legend>Month</legend><div class="fields"><label for="prMonth">For Month</label><input type="month" id="prMonth" value="${isoToday().slice(0, 7)}"></div></fieldset></div>
      <div class="btnrow"><button type="button" class="btn" id="prPrint">${ic("print")} Print Payroll</button></div>
      <div id="prRes">${busy()}</div>`, "Every salary, advance and bonus payment for the month. Open a row to see or print the payslip.");
    let rows = [];
    const load = async () => {
      $("#prRes").innerHTML = busy();
      const m = $("#prMonth").value + "-01";
      const { data, error } = await sb.from("payslips").select("*, employees(first_name,last_name,employee_no,position)").eq("period_month", m).order("pay_date");
      if (error) return fail(error, "Could not load payroll");
      rows = data || [];
      const cols = [SLIP_COLS[0], { label: "Employee", get: (r) => fullName(r.employees || {}) }, { label: "Employee No", get: (r) => r.employees?.employee_no || "" }, ...SLIP_COLS.slice(1, 6)];
      $("#prRes").innerHTML = E.grid({ cols, rows, onRow: true, foot: { net_pay: peso(rows.reduce((s, r) => s + num(r.net_pay), 0)) }, empty: `No payments for ${monthLabel(m)}.` });
      E.bindGrid($("#prRes"), rows, (r) => (location.hash = "payslip/" + r.id));
      E.setRecords(`Payslips: ${rows.length}`);
    };
    $("#prMonth").onchange = load;
    $("#prPrint").onclick = () => {
      const byType = new Map(); rows.forEach((r) => { const t = byType.get(r.pay_type) || [0, 0]; t[0]++; t[1] += num(r.net_pay); byType.set(r.pay_type, t); });
      E.openPreview(`Payroll ${monthLabel($("#prMonth").value + "-01")}`, E.listingPages({
        title: "Payroll Listing", range: `For the month of ${monthLabel($("#prMonth").value + "-01")}`,
        cols: [{ label: "Payslip No", get: (r) => r.payslip_no }, { label: "Employee", get: (r) => fullName(r.employees || {}) }, { label: "Emp No", get: (r) => r.employees?.employee_no || "" }, { label: "Type", get: (r) => PAY_TYPE[r.pay_type] }, { label: "Pay Date", get: (r) => dmy(r.pay_date) }, { label: "Method", get: (r) => r.method || "" }, { label: "Net Pay", num: true, get: (r) => peso(r.net_pay) }],
        rows, summary: { title: "Summary by Type (PHP)", cols: ["Type", "Count", "Net Pay (₱)"], rows: [...byType].map(([t, v]) => [PAY_TYPE[t], String(v[0]), peso(v[1])]), total: ["Total:", String(rows.length), peso(rows.reduce((s, r) => s + num(r.net_pay), 0))] },
        criteria: `Month: ${$("#prMonth").value}`
      }));
    };
    load();
  };

  // ---------- job positions ----------
  V.positions = async () => {
    E.shell("positions", "Employee — Job Positions", `${empTabs("positions")}
      ${isAdmin() ? `<form class="window" id="poForm" novalidate style="margin-bottom:10px"><div class="wtitle">New Job Position</div><div class="wbody"><div class="formgrid">
        <div class="fields wide"><label for="poTitle">Position Title *</label><input type="text" id="poTitle" placeholder="e.g. Warehouse Supervisor">
          <label for="poCo">Company Name</label><input type="text" id="poCo" value="${esc(C.company.name)}">
          <label for="poCode">Company Code</label><input type="text" id="poCode" value="EO" maxlength="4" placeholder="2–4 letters, starts the application no"></div>
        <div class="fields wide"><label for="poSal">Monthly Salary (₱)</label><input type="number" id="poSal" min="0" step="0.01" value="0">
          <label for="poHrs">Duty Hours</label><input type="text" id="poHrs" placeholder="e.g. 12 HOURS DAILY">
          <label for="poDesc">Description</label><input type="text" id="poDesc"></div></div></div>
        <div class="wfoot"><button type="submit" class="btn primary">Add Position</button></div></form>` : ""}
      <div id="poRes">${busy()}</div>`, "Open positions are shown to people who create an account, so they can apply. Application numbers start with the company code, e.g. <b>MF20261001</b>.");
    const load = async () => {
      const [{ data, error }, apps] = await Promise.all([sb.from("job_positions").select("*").order("is_open", { ascending: false }).order("title"), sb.from("job_applications").select("position_id")]);
      if (error) return fail(error, "Could not load positions");
      const count = new Map(); (apps.data || []).forEach((a) => count.set(a.position_id, (count.get(a.position_id) || 0) + 1));
      const rows = data || [];
      $("#poRes").innerHTML = E.grid({ cols: [
        { label: "Position", get: (r) => r.title }, { label: "Company", get: (r) => r.company_name }, { label: "Code", get: (r) => r.company_code },
        { label: "Monthly Salary (₱)", num: true, get: (r) => peso(r.monthly_salary) }, { label: "Duty Hours", get: (r) => r.duty_hours || "" },
        { label: "Applications", num: true, get: (r) => count.get(r.id) || 0 }, { label: "Status", html: (r) => r.is_open ? `<span class="pill active">OPEN</span>` : `<span class="pill closed">CLOSED</span>` },
        { label: "", html: (r) => isAdmin() ? `<button type="button" class="btn" data-open="${r.id}" data-v="${r.is_open ? 0 : 1}">${r.is_open ? "Close" : "Re-open"}</button> ${tools("job_positions", r, `Job position ${r.title}`, { reload: load })}` : "" }],
        rows, empty: "No job positions yet." });
      bindTools($("#poRes"));
      $$("[data-open]", $("#poRes")).forEach((b) => (b.onclick = async () => {
        const { error: e2 } = await sb.rpc("set_position_open", { p_id: b.dataset.open, p_open: b.dataset.v === "1" });
        if (e2) return fail(e2, "Could not update"); load();
      }));
      E.setRecords(`Positions: ${rows.length}`);
    };
    if ($("#poForm")) $("#poForm").onsubmit = async (e) => {
      e.preventDefault();
      const v = (i) => $("#" + i).value.trim();
      if (!v("poTitle")) return toast("Enter the position title.", true);
      const { error } = await sb.from("job_positions").insert({ title: v("poTitle"), company_name: v("poCo") || C.company.name, company_code: v("poCode") || "EO", monthly_salary: num(v("poSal")), duty_hours: v("poHrs") || null, description: v("poDesc") || null });
      if (error) return fail(error, "Could not add the position");
      toast(`Position ${v("poTitle")} added.`); e.target.reset(); $("#poCo").value = C.company.name; $("#poCode").value = "EO"; load();
    };
    load();
  };

  // ---------- job applications ----------
  const JA_COLS = [
    { label: "Application No", get: (r) => r.application_no }, { label: "Date", get: (r) => dmy(r.created_at) }, { label: "Applicant", get: (r) => r.full_name },
    { label: "Position", get: (r) => r.position_title }, { label: "Company", get: (r) => r.company_name }, { label: "Phone", get: (r) => r.phone || "" },
    { label: "Status", html: (r) => pill(r.status) }, { label: "Approval No", get: (r) => r.approval_no || "" }
  ];
  V.jobapps = async () => {
    E.shell("jobapps", "Employee — Job Applications", `${empTabs("jobapps")}
      <div class="tabs" id="jaF"><button type="button" class="on" data-f="submitted">Waiting Review</button><button type="button" data-f="approved">Approved</button><button type="button" data-f="rejected">Rejected</button><button type="button" data-f="">All</button></div>
      <div id="jaRes">${busy()}</div>`, "People who created an account and applied for a job. Open one, print the form, have it signed by both sides, upload the signed copy, choose the access and approve.");
    const run = async (f) => {
      $("#jaRes").innerHTML = busy();
      let q = sb.from("job_applications").select("*").order("created_at", { ascending: false });
      if (f) q = q.eq("status", f);
      const { data, error } = await q;
      if (error) return fail(error, "Could not load job applications");
      const rows = data || [];
      $("#jaRes").innerHTML = E.grid({ cols: JA_COLS, rows, onRow: true, empty: f === "submitted" ? "No applications waiting." : "No applications here." });
      E.bindGrid($("#jaRes"), rows, (r) => (location.hash = "jobapp/" + r.id));
      E.setRecords(`Applications: ${rows.length}`);
    };
    $$("#jaF button").forEach((b) => (b.onclick = () => { $$("#jaF button").forEach((x) => x.classList.toggle("on", x === b)); run(b.dataset.f); }));
    run("submitted");
  };

  const EDU_COLS = ["Examination", "Institute / Board", "Result / GPA", "Passing Year"];
  const EXP_COLS = ["Company", "Position", "From", "To"];
  // The printed job application (laid out like the company's paper template).
  function jobAppPage(a, photoUrl) {
    const edu = Array.isArray(a.education) ? a.education : [], exp = Array.isArray(a.experience) ? a.experience : [];
    const row4 = (cells) => `<tr>${cells.map((c) => `<td>${esc(c || "")}</td>`).join("")}</tr>`;
    return `<div class="ja-head">
        <div class="ja-left">${E.logoHtml("ph-logo")}<div><div class="ph-co">${esc(C.company.name)}</div><div class="ph-addr">${esc(C.company.address.join(", "))}<br>${esc(C.company.email)} · ${esc(C.company.phone)}</div></div></div>
        <div class="ja-photo">${photoUrl ? `<img src="${esc(photoUrl)}" alt="">` : "PHOTO"}</div></div>
      <div class="ja-idrow">
        <div class="ja-ids"><div><span>Application No</span><b>${esc(a.application_no)}</b></div><div><span>Name</span><b>${esc(a.full_name)}</b></div>
          <div><span>Phone</span><b>${esc(a.phone || "")}</b></div><div><span>Email</span><b>${esc(a.email || "")}</b></div>
          ${a.status === "approved" ? `<div class="ja-appr">( APPROVED ) ${esc(a.approval_no || "")} ${esc(E.dLong(a.approved_at).replace(/^0/, "").replace(/ (\w{3})\w* /, "-$1-"))}</div>` : ""}</div>
        <div class="ja-qr"><img src="${E.qrDataUrl("EMONJA|" + a.application_no)}" alt="QR code"><img class="ja-bar" src="${E.pdf417DataUrl("EMONJA|" + a.application_no)}" alt=""></div></div>
      <div class="ph-title">JOB APPLICATION FORM</div>
      ${E.box("Address Details", `<div class="pgrid2">${E.cell("Present Address", a.present_address)}${E.cell("Permanent Address", a.permanent_address)}</div>`)}
      ${E.box("Personal Information", `<div class="pgrid2">${E.cell("Full Name", a.full_name, "hl")}${E.cell("Father's Name", a.father_name)}${E.cell("Mother's Name", a.mother_name)}${E.cell("Wife / Husband Name", a.spouse_name)}
        ${E.cell("Date of Birth", E.dLong(a.date_of_birth))}${E.cell("Birth Place", a.birth_place)}${E.cell("BRC / NID / Passport No", a.id_number)}${E.cell("Gender", a.gender)}
        ${E.cell("Religion", a.religion)}${E.cell("Blood Group", a.blood_group)}</div>`)}
      ${E.box("Educational Qualifications", `<table class="rp ja-tbl"><thead><tr>${EDU_COLS.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>
        ${edu.length ? edu.map((r) => row4([r.exam, r.institute, r.result, r.year])).join("") : `<tr><td colspan="4">—</td></tr>`}</tbody></table>`)}
      ${E.box("Work Experience", `<table class="rp ja-tbl"><thead><tr>${EXP_COLS.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>
        ${exp.length ? exp.map((r) => row4([r.company, r.position, r.from, r.to])).join("") : `<tr><td colspan="4">No previous experience</td></tr>`}</tbody></table>`)}
      ${E.box("Apply Job Information", `<div class="pgrid2">${E.cell("Position", a.position_title, "hl")}${E.cell("Company", a.company_name, "hl")}${E.cell("Monthly Salary (PHP)", a.apply_salary != null ? peso(a.apply_salary) : "")}${E.cell("Duty Hours", a.apply_duty_hours)}
        ${E.cell("Joining Date", E.dmyDash(a.apply_joining_date), "span2")}</div>`)}
      ${E.box("Declaration", `<p class="pdecl" style="padding:4px 6px;margin:0">I hereby declare that all the information given above is true and correct to the best of my knowledge. If any information is found false, my application or employment may be cancelled.</p>`)}
      ${E.sigs("Applicant's Signature / Date", `Authorized Signature (${esc(C.company.name)}) / Date`)}`;
  }
  async function printJobApp(a) {
    const photo = a.photo_path ? await E.signedUrl(a.photo_path, 900) : "";
    E.openPreview(`Job Application ${a.application_no}`, [jobAppPage(a, photo)]);
  }

  V.jobapp = async (id) => {
    E.shell("jobapp", "Job Application", busy());
    const { data: a } = await sb.from("job_applications").select("*").eq("id", id).maybeSingle();
    if (!a) { $("#main").innerHTML = `<div class="empty">Job application not found. <a href="#jobapps">Back</a></div>`; return; }
    const att = await E.attachmentsOf("job_application", id);
    const photo = a.photo_path ? await E.signedUrl(a.photo_path) : "";
    const signed = att.some((x) => x.kind === "signed_form");
    const edu = Array.isArray(a.education) ? a.education : [], exp = Array.isArray(a.experience) ? a.experience : [];
    const kv = (rows) => `<div class="grid-wrap"><table class="grid kv-table"><tbody>${rows.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v || "—")}</td></tr>`).join("")}</tbody></table></div>`;
    $(".band h1").textContent = `Job Application — ${a.application_no}`;
    $("#main").innerHTML = `
      ${a.status === "approved" ? `<div class="banner ok">✔ APPROVED ${esc(a.approval_no || "")} on ${dmy(a.approved_at)} by ${esc(a.approved_by_name || "")}${a.employee_id ? ` — <a href="#employee/${a.employee_id}">open employee record</a>` : ""}</div>` : ""}
      ${a.status === "rejected" ? `<div class="banner closed">NOT APPROVED${a.review_note ? " — " + esc(a.review_note) : ""}</div>` : ""}
      <section class="cust-hero st-${esc(a.status)}">${photoBox(photo, E.initials(a.full_name))}
        <div class="ch-main"><div class="ch-name"><h2>${esc(a.full_name)}</h2>${pill(a.status)}</div>
          <div class="ch-sub">${esc(a.position_title)} · ${esc(a.company_name)}</div>
          <div class="ch-ids">${E.idBox("Application No", a.application_no)}${E.idBox("Submitted", dmy(a.created_at))}${E.idBox("Phone", a.phone)}${E.idBox("Email", a.email)}</div></div></section>
      <div class="docgrid">${E.docCard({ key: "ja", title: `Job Application Form ${a.application_no}`, sub: "Print, sign (applicant and admin), then upload the signed copy", ownerType: "job_application", ownerId: a.id, att, print: () => printJobApp(a), canUpload: isAdmin() })}</div>
      ${isAdmin() && a.status === "submitted" ? `<fieldset class="opt review"><legend>CEO Approval</legend><ol class="steps">
        <li><b>Print</b> the job application form above. The applicant and the CEO both sign it.</li>
        <li><b>Upload the signed form:</b> ${signed ? `<span class="ok-txt">✔ Uploaded — it now replaces the system form above.</span>` : `<span class="bad-txt">not uploaded yet</span> — press <b>Upload Signed Copy</b> on the form card.`}</li>
        <li><b>Choose access</b> for the new employee:<div class="fields wide" style="margin-top:6px">${accessFields("staff", ["customers"])}</div></li>
        <li><b>Decide:</b><div class="fields wide"><label for="jaNote">Note</label><input type="text" id="jaNote" placeholder="Optional"></div>
          <div class="btnrow"><button type="button" class="btn ok" id="jaApprove" ${signed ? "" : 'disabled title="Upload the signed application form first"'}>Approve — Create Employee</button><button type="button" class="btn danger" id="jaReject">Reject</button></div></li>
      </ol></fieldset>` : ""}
      <div class="cols">
        <div><h3>Address &amp; Personal Information</h3>${kv([["Present Address", a.present_address], ["Permanent Address", a.permanent_address], ["Father's Name", a.father_name], ["Mother's Name", a.mother_name], ["Wife / Husband Name", a.spouse_name], ["Date of Birth", E.dLong(a.date_of_birth)], ["Birth Place", a.birth_place], ["BRC / NID / Passport No", a.id_number], ["Gender", a.gender], ["Religion", a.religion], ["Blood Group", a.blood_group]])}</div>
        <div><h3>Apply Job Information</h3>${kv([["Position", a.position_title], ["Company", a.company_name], ["Monthly Salary (₱)", a.apply_salary != null ? peso(a.apply_salary) : ""], ["Duty Hours", a.apply_duty_hours], ["Joining Date", E.dmyDash(a.apply_joining_date)]])}</div>
      </div>
      <h3>Educational Qualifications</h3>${E.grid({ cols: [{ label: "Examination", get: (r) => r.exam || "" }, { label: "Institute / Board", get: (r) => r.institute || "" }, { label: "Result / GPA", get: (r) => r.result || "" }, { label: "Passing Year", get: (r) => r.year || "" }], rows: edu, empty: "None given." })}
      <h3>Work Experience</h3>${E.grid({ cols: [{ label: "Company", get: (r) => r.company || "" }, { label: "Position", get: (r) => r.position || "" }, { label: "From", get: (r) => r.from || "" }, { label: "To", get: (r) => r.to || "" }], rows: exp, empty: "No previous experience." })}
      <h3>Requirements &amp; Files</h3>${E.filesHtml(att.filter((x) => x.kind !== "signed_form"), "No requirements uploaded.")}
      ${rhBox("job_applications", a.id)}
      <div class="btnrow">${tools("job_applications", a, `Job application ${a.application_no}`, { reload: () => V.jobapp(id), afterDelete: () => (location.hash = "jobapps") })}<a class="btn" href="#jobapps">Close</a></div>`;
    E.bindFiles($("#main"));
    E.bindDocCards($("#main"), () => V.jobapp(id));
    bindTools($("#main"));
    if ($("#jaApprove")) $("#jaApprove").onclick = async () => {
      const acc = readAccess();
      const { data, error } = await sb.rpc("review_job_application", { p_id: id, p_action: "approve", p_role: acc.role, p_modules: acc.modules, p_note: $("#jaNote").value.trim() || null });
      if (error) return fail(error, "Could not approve");
      toast(`Approved ${data.approval_no}. ${a.full_name} is now an employee and can use the portal.`);
      V.jobapp(id);
    };
    if ($("#jaReject")) $("#jaReject").onclick = async () => {
      if (!(await E.confirmBox(`Reject the job application of <b>${esc(a.full_name)}</b>? The applicant is notified.`, { ok: "Reject", danger: true }))) return;
      const { error } = await sb.rpc("review_job_application", { p_id: id, p_action: "reject", p_note: $("#jaNote").value.trim() || null });
      if (error) return fail(error, "Could not reject");
      toast("Application rejected."); V.jobapp(id);
    };
    E.setRecords(`Application: ${a.application_no}`);
  };

  // ======================================================================
  // 7. Project — application with budget, approval, payments against total cost
  // ======================================================================
  const PRJ_COLS = [
    { label: "Project No", get: (r) => r.project_no }, { label: "Title", get: (r) => r.title }, { label: "Location", get: (r) => r.location || "" },
    { label: "Start", get: (r) => dmy(r.start_date) }, { label: "Total Cost (₱)", key: "total_cost", num: true, get: (r) => peso(r.total_cost) },
    { label: "Paid (₱)", key: "total_paid", num: true, get: (r) => peso(r.total_paid) }, { label: "Remaining (₱)", key: "remaining", num: true, get: (r) => peso(r.remaining) },
    { label: "Status", html: (r) => pill(r.status) }
  ];
  V.projects = async () => {
    E.shell("projects", "Project", `
      <div class="tabs" id="pjTabs"><button type="button" class="on" data-f="approved">Approved</button><button type="button" data-f="pending">Waiting Approval</button><button type="button" data-f="completed">Completed</button><button type="button" data-f="rejected">Rejected</button><button type="button" data-f="">All</button></div>
      <div class="btnrow">${E.canWrite("projects") ? `<a class="btn primary" href="#newproject">+ New Project Application</a>` : ""}</div><div id="pjRes">${busy()}</div>`,
      "Submit a project with its budget. Upload the approved document; after CEO approval the project moves to <b>Approved</b> and payments can be recorded against its total cost.");
    const run = async (f) => {
      $("#pjRes").innerHTML = busy();
      let q = sb.from("project_balances").select("*").order("created_at", { ascending: false });
      if (f) q = q.eq("status", f);
      const { data, error } = await q;
      if (error) return fail(error, "Could not load projects");
      const rows = data || [];
      const sum = (k) => peso(rows.reduce((s, r) => s + num(r[k]), 0));
      $("#pjRes").innerHTML = E.grid({ cols: PRJ_COLS, rows, onRow: true, foot: { total_cost: sum("total_cost"), total_paid: sum("total_paid"), remaining: sum("remaining") }, empty: "No projects here." });
      E.bindGrid($("#pjRes"), rows, (r) => (location.hash = "project/" + r.id));
      E.setRecords(`Projects: ${rows.length}`);
    };
    $$("#pjTabs button").forEach((b) => (b.onclick = () => { $$("#pjTabs button").forEach((x) => x.classList.toggle("on", x === b)); run(b.dataset.f); }));
    run("approved");
  };

  V.newproject = () => {
    if (!E.canWrite("projects")) { location.hash = "projects"; return; }
    E.shell("newproject", "New Project Application", `
      <form class="window" id="pjForm" novalidate><div class="wtitle">Project Application</div><div class="wbody">
        <fieldset class="opt"><legend>Project</legend><div class="formgrid">
          <div class="fields wide"><label for="pjTitle">Project Title *</label><input type="text" id="pjTitle" required>
            <label for="pjLoc">Location</label><input type="text" id="pjLoc">
            <label for="pjDesc">Description</label><textarea id="pjDesc" rows="3"></textarea></div>
          <div class="fields wide"><label for="pjStart">Start Date</label><input type="date" id="pjStart">
            <label for="pjEnd">Target End Date</label><input type="date" id="pjEnd"></div></div></fieldset>
        <fieldset class="opt"><legend>Project Budget</legend>
          <div class="grid-scroll"><table class="grid budget"><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit Cost (₱)</th><th class="num">Amount (₱)</th><th></th></tr></thead><tbody id="pjLines"></tbody>
          <tfoot><tr><td colspan="3" class="num">Total Project Cost</td><td class="num" id="pjTotal">0.00</td><td></td></tr></tfoot></table></div>
          <div class="btnrow"><button type="button" class="btn" id="pjAdd">+ Add Budget Line</button></div>
          <small id="pjWords"></small></fieldset>
      </div><div class="wfoot"><a class="btn" href="#projects">Cancel</a><button type="submit" class="btn primary">Submit for Approval</button></div></form>`);
    const recalc = () => {
      let t = 0;
      $$("#pjLines tr").forEach((tr) => { const a = num($(".q", tr).value) * num($(".u", tr).value); $(".a", tr).textContent = peso(a); t += a; });
      $("#pjTotal").textContent = peso(t); $("#pjWords").textContent = words(t); return t;
    };
    const addLine = () => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td><input type="text" class="d" aria-label="Description"></td><td><input type="number" class="q" value="1" min="0" step="0.01" aria-label="Qty"></td>
        <td><input type="number" class="u" value="0" min="0" step="0.01" aria-label="Unit cost"></td><td class="num a">0.00</td><td><button type="button" class="btn danger" aria-label="Remove line">✕</button></td>`;
      $("#pjLines").appendChild(tr);
      $$("input", tr).forEach((i) => (i.oninput = recalc));
      $("button", tr).onclick = () => { tr.remove(); recalc(); };
    };
    $("#pjAdd").onclick = addLine; addLine(); addLine();
    $("#pjForm").onsubmit = async (e) => {
      e.preventDefault();
      const title = $("#pjTitle").value.trim();
      if (!title) return toast("Enter the project title.", true);
      const lines = $$("#pjLines tr").map((tr) => ({ description: $(".d", tr).value.trim(), qty: num($(".q", tr).value), unit_cost: num($(".u", tr).value) })).filter((l) => l.description);
      if (!lines.length) return toast("Add at least one budget line with a description.", true);
      const total = lines.reduce((s, l) => s + l.qty * l.unit_cost, 0);
      E.setBusy(e.target, true, "Submitting");
      const { data: pr, error } = await sb.from("projects").insert({ title, location: $("#pjLoc").value.trim() || null, description: $("#pjDesc").value.trim() || null,
        start_date: $("#pjStart").value || null, end_date: $("#pjEnd").value || null, total_cost: Math.round(total * 100) / 100 }).select().single();
      if (error) { E.setBusy(e.target, false); return fail(error, "Could not submit the project"); }
      const { error: e2 } = await sb.from("project_items").insert(lines.map((l) => ({ ...l, project_id: pr.id })));
      if (e2) fail(e2, "Project saved, but the budget lines could not be saved");
      toast(`Project ${pr.project_no} submitted.`); location.hash = "project/" + pr.id;
    };
  };

  V.project = async (id) => {
    E.shell("project", "Project", busy());
    const { data: pr } = await sb.from("project_balances").select("*").eq("id", id).maybeSingle();
    if (!pr) { $("#main").innerHTML = `<div class="empty">Project not found. <a href="#projects">Back</a></div>`; return; }
    const [items, pays, att] = await Promise.all([
      sb.from("project_items").select("*").eq("project_id", id).order("id"),
      sb.from("project_payments").select("*").eq("project_id", id).order("pay_date"),
      E.attachmentsOf("project", id)]);
    const lines = items.data || [], payments = pays.data || [];
    const approved = att.some((a) => a.kind === "approval");
    const w = E.canWrite("projects");
    const printApp = () => E.openPreview(`Project ${pr.project_no}`, [`${E.printHead("PROJECT APPLICATION", `<img src="${E.pdf417DataUrl("EMONPRJ|" + pr.project_no)}" alt="" class="ph-bar"><div class="mono">${esc(pr.project_no)}</div>`)}
      ${E.box("Project", `<div class="pgrid2">${E.cell("Project Title", pr.title, "span2")}${E.cell("Location", pr.location)}${E.cell("Start / End", `${dmy(pr.start_date)} → ${dmy(pr.end_date)}`)}${E.cell("Description", pr.description, "span2")}</div>`)}
      ${E.box("Project Budget", `<table class="rp"><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit Cost</th><th class="num">Amount</th></tr></thead><tbody>
        ${lines.map((l) => `<tr><td>${esc(l.description)}</td><td class="num">${l.qty}</td><td class="num">${peso(l.unit_cost)}</td><td class="num">${peso(l.amount)}</td></tr>`).join("")}
        <tr class="grand"><td colspan="3" class="num">TOTAL PROJECT COST (₱)</td><td class="num">${peso(pr.total_cost)}</td></tr></tbody></table>
        <div class="pcell"><div class="pl">Amount in Words</div><div class="pv words">${esc(words(pr.total_cost))}</div></div>`)}
      ${E.sigs(`Prepared by: ${esc(pr.created_by_name || "")}`, "Approved by / Date")}`]);
    $(".band h1").textContent = `Project — ${pr.project_no}`;
    $("#main").innerHTML = `
      <div class="window"><div class="wtitle">${esc(pr.project_no)} — ${esc(pr.title)} ${pill(pr.status)}</div><div class="wbody">
        <div class="formgrid"><div class="fields wide"><span>Location</span><span>${esc(pr.location || "—")}</span><span>Description</span><span>${esc(pr.description || "—")}</span>
          <span>Start / End</span><span>${dmy(pr.start_date) || "—"} → ${dmy(pr.end_date) || "—"}</span></div>
          <div class="fields wide"><span>Submitted By</span><span>${esc(pr.created_by_name || "")}</span><span>Approved By</span><span>${esc(pr.approved_by_name || "—")} ${pr.approved_at ? dmy(pr.approved_at) : ""}</span>
          <span>Note</span><span>${esc(pr.status_note || "—")}</span></div></div>
        <div class="tiles"><div class="tile"><div class="k">Total Project Cost</div><div class="v">₱ ${peso(pr.total_cost)}</div></div>
          <div class="tile ok"><div class="k">Paid</div><div class="v">₱ ${peso(pr.total_paid)}</div></div>
          <div class="tile ${num(pr.remaining) > 0 ? "warn" : "ok"}"><div class="k">Remaining</div><div class="v">₱ ${peso(pr.remaining)}</div></div></div>
        <div class="docgrid">${E.docCard({ key: "prj", title: `Project Application ${pr.project_no}`, sub: "Print it, get it approved and signed, then upload the approved document", ownerType: "project", ownerId: pr.id, att, print: printApp, canUpload: w && pr.status === "pending", kind: "approval", uploadLabel: "Upload Approved Document" })}</div>
        <div><b>Project Budget</b>${E.grid({ cols: [{ label: "Description", get: (r) => r.description }, { label: "Qty", num: true, get: (r) => r.qty }, { label: "Unit Cost (₱)", num: true, get: (r) => peso(r.unit_cost) }, { label: "Amount (₱)", key: "amount", num: true, get: (r) => peso(r.amount) }], rows: lines, foot: { amount: peso(pr.total_cost) } })}</div>
        ${pr.status === "pending" ? `<fieldset class="opt review"><legend>Approval</legend>
          <ol class="steps"><li><b>Print</b> the project application above and get it signed.</li>
          <li><b>Approved document:</b> ${approved ? `<span class="ok-txt">✔ Uploaded — it now replaces the application above.</span>` : `<span class="bad-txt">not uploaded yet</span> — press <b>Upload Approved Document</b> on the card.`}</li>
          ${isAdmin() ? `<li><b>Decide:</b><div class="fields wide"><label for="pjNote">Note</label><input type="text" id="pjNote"></div>
            <div class="btnrow"><button type="button" class="btn ok" data-pa="approve" ${approved ? "" : 'disabled title="Upload the approved document first"'}>Approve Project</button><button type="button" class="btn danger" data-pa="reject">Reject</button></div></li>` : "<li>Waiting for the CEO to approve.</li>"}</ol></fieldset>` : ""}
        ${pr.status === "approved" && w ? `<form class="opt" id="ppForm" novalidate style="border:1px solid var(--panel-line);background:var(--panel);padding:8px 10px"><b>Record Payment</b>
          <div class="formgrid"><div class="fields wide"><label for="ppDate">Date</label><input type="date" id="ppDate" value="${isoToday()}">
            <label for="ppAmt">Amount (₱) *</label><input type="number" id="ppAmt" min="0.01" step="0.01">
            <label for="ppBy">Received By *</label><input type="text" id="ppBy"></div>
          <div class="fields wide"><label for="ppMethod">Method</label><select id="ppMethod"><option>Cash</option><option>Bank Transfer</option><option>Online Transfer</option><option>Cheque</option></select>
            <label for="ppRef">Reference No</label><input type="text" id="ppRef">
            ${E.fileField("ppRcpt", "Receipt", 'accept="image/*,application/pdf"')}</div></div>
          <div class="btnrow"><button class="btn primary" type="submit">Save Payment</button>${isAdmin() ? `<button class="btn" type="button" data-pa="complete">Mark Project Completed</button>` : ""}</div></form>` : ""}
        <div><b>Payments</b>${E.grid({ cols: [{ label: "Payment No", get: (r) => r.payment_no }, { label: "Date", get: (r) => dmy(r.pay_date) }, { label: "Received By", get: (r) => r.received_by }, { label: "Method", get: (r) => r.method || "" }, { label: "Reference", get: (r) => r.reference_no || "" }, { label: "Amount (₱)", key: "amount", num: true, get: (r) => peso(r.amount) }, { label: "Recorded By", get: (r) => r.created_by_name || "" },
          { label: "", html: (r) => tools("project_payments", r, `Project payment ${r.payment_no}`, { reload: () => V.project(id) }) }], rows: payments, foot: { amount: peso(pr.total_paid) }, empty: pr.status === "approved" ? "No payments yet." : "Payments unlock after the project is approved." })}</div>
        <div><b>Other Files</b>${E.filesHtml(att.filter((a) => a.kind !== "approval"), "No other files.")}</div>
        ${rhBox("projects", pr.id)}
      </div><div class="wfoot">${tools("projects", pr, `Project ${pr.project_no}`, { reload: () => V.project(id), afterDelete: () => (location.hash = "projects") })}<button type="button" class="btn" id="pjStmt">${ic("print")} Print Payment Record</button><a class="btn" href="#projects">Close</a></div></div>`;
    E.bindFiles($("#main"));
    E.bindDocCards($("#main"), () => V.project(id));
    bindTools($("#main"));
    $$("[data-pa]").forEach((b) => (b.onclick = async () => {
      const r = await sb.rpc("project_action", { p_id: id, p_action: b.dataset.pa, p_note: $("#pjNote")?.value.trim() || null });
      if (r.error) return fail(r.error, "Could not update the project");
      toast(`${pr.project_no} is now ${r.data.status.toUpperCase()}.`); V.project(id);
    }));
    if ($("#ppForm")) $("#ppForm").onsubmit = async (e) => {
      e.preventDefault();
      const amt = num($("#ppAmt").value), by = $("#ppBy").value.trim();
      if (amt <= 0) return toast("Enter the amount.", true);
      if (!by) return toast("Enter who received the payment.", true);
      if (amt > num(pr.remaining)) toast(`Note: this is more than the remaining ₱${peso(pr.remaining)}.`, true);
      const { data: p, error } = await sb.from("project_payments").insert({ project_id: id, pay_date: $("#ppDate").value || isoToday(), amount: amt, received_by: by, method: $("#ppMethod").value, reference_no: $("#ppRef").value.trim() || null }).select().single();
      if (error) return fail(error, "Could not save the payment");
      await E.uploadRecords("project_payment", p.id, "receipt", E.filesOf("ppRcpt"));
      toast(`Payment ${p.payment_no} saved. Remaining: ₱${peso(num(pr.remaining) - amt)}`); V.project(id);
    };
    $("#pjStmt").onclick = () => E.openPreview(`Project payments ${pr.project_no}`, E.listingPages({
      title: "Project Payment Record", range: `${esc(pr.project_no)} — ${esc(pr.title)}`,
      cols: [{ label: "Payment No", get: (r) => r.payment_no }, { label: "Date", get: (r) => dmy(r.pay_date) }, { label: "Received By", get: (r) => r.received_by }, { label: "Method", get: (r) => r.method || "" }, { label: "Reference", get: (r) => r.reference_no || "" }, { label: "Amount", num: true, get: (r) => peso(r.amount) }],
      rows: payments,
      summary: { title: "Project Summary (PHP)", cols: ["Item", "", "Amount (₱)"], rows: [["Total Project Cost", "", peso(pr.total_cost)], ["Total Paid", String(payments.length) + " payment(s)", peso(pr.total_paid)]], total: ["Remaining:", "", peso(pr.remaining)] },
      criteria: `Project: ${pr.project_no}\nStatus: ${pr.status.toUpperCase()}\nApproved by: ${pr.approved_by_name || "-"}`
    }));
    E.setRecords(`Project: ${pr.project_no}`);
  };

  // ======================================================================
  // 8. Billing — companies, their accounts, and payment vouchers (PHP × rate = BDT)
  // ======================================================================
  const bdt = (n) => `BDT ${peso(n)}`;
  const RATE_KEY = "eoLastRate";
  const lastRate = () => { try { return localStorage.getItem(RATE_KEY) || ""; } catch (_) { return ""; } };
  const VOUCHER_COLS = [
    { label: "Voucher No", get: (r) => r.voucher_no }, { label: "Date", get: (r) => dmy(r.pay_date) },
    { label: "Account", get: (r) => r.pay_accounts ? `${r.pay_accounts.account_name}${r.pay_accounts.account_number ? " · " + r.pay_accounts.account_number : ""}` : "—" },
    { label: "Purpose", get: (r) => r.purpose || "" },
    { label: "Amount (PHP)", key: "amount_php", num: true, get: (r) => peso(r.amount_php) }, { label: "Rate", num: true, get: (r) => Number(r.exchange_rate).toFixed(4) },
    { label: "Amount (BDT)", key: "amount_bdt", num: true, html: (r) => `<b class="bdt">${peso(r.amount_bdt)}</b>` }
  ];
  const ym = (iso) => String(iso).slice(0, 7);

  V.billing = async () => {
    const w = E.canWrite("billing");
    E.shell("billing", "Billing", `
      <div class="tiles" id="blTiles">${["Companies", "Total Paid (PHP)", "Total Paid (BDT)", "This Month (BDT)"].map((k) => `<div class="tile"><div class="k">${k}</div><div class="v"><span class="spin sm"></span></div></div>`).join("")}</div>
      <div class="btnrow">${w ? `<a class="btn primary" href="#newvoucher">${ic("plus")} New Payment</a><a class="btn" href="#newpaycompany">${ic("plus")} Add Company</a>` : ""}</div>
      <div id="blRes">${busy()}</div>`,
      "Add a company, then its accounts. <b>New Payment</b> records the amount in PHP with the exchange rate; the BDT amount is worked out automatically and a payment voucher is created.");
    const { data, error } = await sb.from("pay_company_totals").select("*").order("name");
    if (error) return fail(error, "Could not load billing (run the 1.1 database update)");
    const rows = data || [];
    const sum = (k) => rows.reduce((s, r) => s + num(r[k]), 0);
    const tiles = [["", rows.length], ["", "₱ " + peso(sum("total_php"))], ["ok", bdt(sum("total_bdt"))], ["ok", bdt(sum("month_bdt"))]];
    $$("#blTiles .tile").forEach((t, i) => { t.className = "tile " + tiles[i][0]; $(".v", t).textContent = tiles[i][1]; });
    $("#blRes").innerHTML = E.grid({ cols: [
      { label: "Company", get: (r) => r.name }, { label: "Country", get: (r) => r.country || "" }, { label: "Accounts", num: true, get: (r) => r.accounts_count }, { label: "Vouchers", num: true, get: (r) => r.vouchers_count },
      { label: "Total (PHP)", key: "total_php", num: true, get: (r) => peso(r.total_php) }, { label: "Total (BDT)", key: "total_bdt", num: true, html: (r) => `<b class="bdt">${peso(r.total_bdt)}</b>` },
      { label: "This Month (PHP)", key: "month_php", num: true, get: (r) => peso(r.month_php) }, { label: "This Month (BDT)", key: "month_bdt", num: true, get: (r) => peso(r.month_bdt) },
      { label: "Last Paid", get: (r) => dmy(r.last_paid) }],
      rows, onRow: true, foot: { total_php: peso(sum("total_php")), total_bdt: peso(sum("total_bdt")), month_php: peso(sum("month_php")), month_bdt: peso(sum("month_bdt")) }, empty: "No companies yet. Press Add Company." });
    E.bindGrid($("#blRes"), rows, (r) => (location.hash = "paycompany/" + r.id));
    E.setRecords(`Companies: ${rows.length}`);
  };

  V.newpaycompany = () => {
    if (!E.canWrite("billing")) { location.hash = "billing"; return; }
    E.shell("newpaycompany", "Billing — Add Company", `
      <form class="window" id="pcForm" novalidate><div class="wtitle">Company</div><div class="wbody"><div class="fields wide">
        <label for="pcName">Company Name *</label><input type="text" id="pcName" required placeholder="e.g. Modina Apparels Pvt Ltd">
        <label for="pcCountry">Country</label><input type="text" id="pcCountry" value="Bangladesh">
        <label for="pcContact">Contact</label><input type="text" id="pcContact" placeholder="Person, phone or email">
        <label for="pcNotes">Notes</label><input type="text" id="pcNotes"></div>
        <fieldset class="opt"><legend>First Account (optional — you can add more later)</legend><div class="formgrid">
          <div class="fields wide"><label for="paName">Account Name</label><input type="text" id="paName"><label for="paNo">Account Number</label><input type="text" id="paNo"></div>
          <div class="fields wide"><label for="paBank">Bank Name</label><input type="text" id="paBank"><label for="paBranch">Branch</label><input type="text" id="paBranch"></div></div></fieldset>
      </div><div class="wfoot"><a class="btn" href="#billing">Cancel</a><button type="submit" class="btn primary">Save Company</button></div></form>`);
    $("#pcForm").onsubmit = async (e) => {
      e.preventDefault();
      const v = (i) => $("#" + i).value.trim();
      if (!v("pcName")) return toast("Enter the company name.", true);
      E.setBusy(e.target, true, "Saving");
      const { data: co, error } = await sb.from("pay_companies").insert({ name: v("pcName"), country: v("pcCountry") || "Bangladesh", contact: v("pcContact") || null, notes: v("pcNotes") || null }).select().single();
      if (error) { E.setBusy(e.target, false); return fail(error, "Could not save the company"); }
      if (v("paName")) {
        const { error: e2 } = await sb.from("pay_accounts").insert({ company_id: co.id, account_name: v("paName"), account_number: v("paNo") || null, bank_name: v("paBank") || null, branch_name: v("paBranch") || null });
        if (e2) fail(e2, "Company saved, but the account could not be saved");
      }
      toast(`${co.name} added.`); location.hash = "paycompany/" + co.id;
    };
  };

  V.paycompany = async (id) => {
    E.shell("paycompany", "Billing — Company", busy());
    const [co, accs, vs] = await Promise.all([
      sb.from("pay_company_totals").select("*").eq("id", id).maybeSingle(),
      sb.from("pay_accounts").select("*").eq("company_id", id).order("account_name"),
      sb.from("pay_vouchers").select("*, pay_accounts(account_name,account_number,bank_name,branch_name)").eq("company_id", id).order("pay_date", { ascending: false }).order("voucher_no", { ascending: false })
    ]);
    const c = co.data;
    if (!c) { $("#main").innerHTML = `<div class="empty">Company not found. <a href="#billing">Back</a></div>`; return; }
    const accounts = accs.data || [], vouchers = vs.data || [];
    const w = E.canWrite("billing");
    const months = [...new Set(vouchers.map((v) => ym(v.pay_date)))].sort().reverse().map((m) => {
      const list = vouchers.filter((v) => ym(v.pay_date) === m);
      return { month: m + "-01", count: list.length, php: list.reduce((s, v) => s + num(v.amount_php), 0), bdt: list.reduce((s, v) => s + num(v.amount_bdt), 0), list };
    });
    const accTotals = new Map(); vouchers.forEach((v) => { const t = accTotals.get(v.account_id) || [0, 0]; t[0] += num(v.amount_php); t[1] += num(v.amount_bdt); accTotals.set(v.account_id, t); });
    $(".band h1").textContent = `Billing — ${c.name}`;
    $("#main").innerHTML = `
      <section class="cust-hero"><div class="ch-photo"><span>${esc(E.initials(c.name))}</span></div>
        <div class="ch-main"><div class="ch-name"><h2>${esc(c.name)}</h2></div><div class="ch-sub">${esc([c.country, c.contact].filter(Boolean).join(" · ") || "—")}</div>
          <div class="ch-ids">${E.idBox("Accounts", String(accounts.length))}${E.idBox("Vouchers", String(vouchers.length))}${E.idBox("Last Paid", dmy(c.last_paid))}${E.idBox("Added By", c.created_by_name)}</div></div></section>
      <div class="tiles"><div class="tile"><div class="k">Total Paid (PHP)</div><div class="v">₱ ${peso(c.total_php)}</div></div>
        <div class="tile ok"><div class="k">Total Paid (BDT)</div><div class="v">${bdt(c.total_bdt)}</div></div>
        <div class="tile"><div class="k">This Month (PHP)</div><div class="v">₱ ${peso(c.month_php)}</div></div>
        <div class="tile ok"><div class="k">This Month (BDT)</div><div class="v">${bdt(c.month_bdt)}</div></div></div>
      <div class="actionbar">${w ? `<a class="btn primary" href="#newvoucher/${c.id}">${ic("plus")} New Payment</a>` : ""}<button type="button" class="btn" id="pcRecord">${ic("download")} Download Payment Record</button>
        <span class="grow"></span>${tools("pay_companies", c, c.name, { reload: () => V.paycompany(id), afterDelete: () => (location.hash = "billing") })}</div>
      <div class="tabs" id="pcTabs"><button type="button" class="on" data-t="0">Payment Vouchers (${vouchers.length})</button><button type="button" data-t="1">Monthly Records (${months.length})</button><button type="button" data-t="2">Accounts (${accounts.length})</button></div>
      <div class="tabpanes" id="pcPanes">
        <div data-p="0"><div id="pcVouchers">${E.grid({ cols: VOUCHER_COLS, rows: vouchers, onRow: true, foot: { amount_php: peso(c.total_php), amount_bdt: `<b class="bdt">${peso(c.total_bdt)}</b>` }, empty: "No payments yet." })}</div></div>
        <div data-p="1" hidden><div id="pcMonths">${E.grid({ cols: [{ label: "Month", get: (r) => monthLabel(r.month) }, { label: "Vouchers", num: true, get: (r) => r.count }, { label: "Total (PHP)", num: true, get: (r) => peso(r.php) }, { label: "Total (BDT)", num: true, html: (r) => `<b class="bdt">${peso(r.bdt)}</b>` }, { label: "", html: () => `<span class="btn">${ic("download")} Download</span>` }], rows: months, onRow: true, empty: "No payments yet." })}</div></div>
        <div data-p="2" hidden>
          ${w ? `<form class="opt inline-form" id="paForm" novalidate><b>Add Account</b><div class="formgrid">
            <div class="fields wide"><label for="paName">Account Name *</label><input type="text" id="paName"><label for="paNo">Account Number</label><input type="text" id="paNo"></div>
            <div class="fields wide"><label for="paBank">Bank Name</label><input type="text" id="paBank"><label for="paBranch">Branch</label><input type="text" id="paBranch"></div></div>
            <div class="btnrow"><button type="submit" class="btn primary">Save Account</button></div></form>` : ""}
          <div id="pcAccs">${E.grid({ cols: [{ label: "Account Name", get: (r) => r.account_name }, { label: "Account Number", get: (r) => r.account_number || "" }, { label: "Bank", get: (r) => r.bank_name || "" }, { label: "Branch", get: (r) => r.branch_name || "" },
            { label: "Paid (PHP)", num: true, get: (r) => peso((accTotals.get(r.id) || [0, 0])[0]) }, { label: "Paid (BDT)", num: true, html: (r) => `<b class="bdt">${peso((accTotals.get(r.id) || [0, 0])[1])}</b>` },
            { label: "", html: (r) => tools("pay_accounts", r, `${r.account_name} (${c.name})`, { reload: () => V.paycompany(id) }) }], rows: accounts, empty: "No accounts yet." })}</div>
        </div>
      </div>${rhBox("pay_companies", c.id)}`;
    $$("#pcTabs button").forEach((t) => (t.onclick = () => { $$("#pcTabs button").forEach((x) => x.classList.toggle("on", x === t)); $$("#pcPanes > div").forEach((p) => (p.hidden = p.dataset.p !== t.dataset.t)); }));
    E.bindGrid($("#pcVouchers"), vouchers, (r) => (location.hash = "voucher/" + r.id));
    E.bindGrid($("#pcMonths"), months, (r) => printRecord(c, r.list, `For the month of ${monthLabel(r.month)}`));
    bindTools($("#main"));
    $("#pcRecord").onclick = () => printRecord(c, vouchers, "All payments");
    if ($("#paForm")) $("#paForm").onsubmit = async (e) => {
      e.preventDefault();
      const v = (i) => $("#" + i).value.trim();
      if (!v("paName")) return toast("Enter the account name.", true);
      const { error } = await sb.from("pay_accounts").insert({ company_id: id, account_name: v("paName"), account_number: v("paNo") || null, bank_name: v("paBank") || null, branch_name: v("paBranch") || null });
      if (error) return fail(error, "Could not save the account");
      toast(`Account ${v("paName")} added.`); V.paycompany(id);
    };
    E.setRecords(`Vouchers: ${vouchers.length}`);
  };
  // Payment record (all, or one month) with PHP and BDT shown separately.
  function printRecord(c, list, range) {
    const rows = list.slice().sort((a, b) => String(a.pay_date).localeCompare(String(b.pay_date)) || String(a.voucher_no).localeCompare(String(b.voucher_no)));
    const byMonth = new Map(); rows.forEach((v) => { const t = byMonth.get(ym(v.pay_date)) || [0, 0, 0]; t[0]++; t[1] += num(v.amount_php); t[2] += num(v.amount_bdt); byMonth.set(ym(v.pay_date), t); });
    E.openPreview(`Payment Record ${c.name}`, E.listingPages({
      title: "Payment Record", range: `${esc(c.name)} — ${esc(range)}`,
      cols: [{ label: "Voucher No", get: (r) => r.voucher_no }, { label: "Date", get: (r) => dmy(r.pay_date) }, { label: "Account", get: (r) => r.pay_accounts ? `${r.pay_accounts.account_name} ${r.pay_accounts.account_number || ""}` : "" }, { label: "Purpose", get: (r) => r.purpose || "" },
        { label: "PHP", num: true, get: (r) => peso(r.amount_php) }, { label: "Rate", num: true, get: (r) => Number(r.exchange_rate).toFixed(4) }, { label: "BDT", num: true, html: (r) => `<b>${peso(r.amount_bdt)}</b>` }],
      rows,
      summary: { title: "Monthly Totals", cols: ["Month", "Vouchers", "PHP", "BDT"], rows: [...byMonth].map(([m, t]) => [monthLabel(m + "-01"), String(t[0]), peso(t[1]), peso(t[2])]), total: ["Total:", String(rows.length), peso(rows.reduce((s, v) => s + num(v.amount_php), 0)), peso(rows.reduce((s, v) => s + num(v.amount_bdt), 0))] },
      criteria: `Company: ${c.name}\nRange: ${range}`, logo: true
    }));
  }

  V.newvoucher = async (companyId) => {
    if (!E.canWrite("billing")) { location.hash = "billing"; return; }
    E.shell("newvoucher", "Billing — New Payment", busy());
    const { data: cos, error } = await sb.from("pay_companies").select("id,name").order("name");
    if (error) return fail(error, "Could not load companies");
    if (!(cos || []).length) { $("#main").innerHTML = `<div class="empty">Add a company first. <a class="btn primary" href="#newpaycompany">Add Company</a></div>`; return; }
    $("#main").innerHTML = `
      <form class="window" id="nvForm" novalidate><div class="wtitle">Payment Voucher</div><div class="wbody">
        <div class="summary-box"><div class="fields wide"><span>Voucher No</span><b>Assigned on save (BD + date + number, e.g. BD${isoToday().replace(/-/g, "")}001)</b><span>Issued By</span><b>${esc(S.profile.full_name || "")}</b></div></div>
        <fieldset class="opt"><legend>Paid To</legend><div class="fields wide">
          <label for="nvCo">Company *</label><select id="nvCo"><option value="">— Choose company —</option>${cos.map((c) => `<option value="${c.id}" ${c.id === companyId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
          <label for="nvAcc">Account *</label><select id="nvAcc"><option value="">— Choose the company first —</option></select></div></fieldset>
        <fieldset class="opt"><legend>Amount</legend><div class="formgrid">
          <div class="fields wide">
            <label for="nvDate">Payment Date</label><input type="date" id="nvDate" value="${isoToday()}">
            <label for="nvPhp">Amount (PHP) *</label><input type="number" id="nvPhp" min="0.01" step="0.01" placeholder="e.g. 200">
            <label for="nvRate">Exchange Rate *</label><input type="number" id="nvRate" min="0.0001" step="0.0001" value="${esc(lastRate())}" placeholder="BDT per 1 PHP, e.g. 2.05">
          </div>
          <div class="bdt-calc"><small>Amount in BDT (automatic)</small><b id="nvBdt">BDT 0.00</b><span id="nvFormula">PHP × rate = BDT</span><small id="nvWords"></small></div></div></fieldset>
        <fieldset class="opt"><legend>Details</legend><div class="fields wide">
          <label for="nvPurpose">Purpose</label><input type="text" id="nvPurpose" placeholder="e.g. Batch payment, monthly payment">
          <label for="nvMethod">Method</label><select id="nvMethod"><option>Bank Transfer</option><option>Cash</option><option>Online Transfer</option><option>Deposit</option></select>
          <label for="nvRef">Reference No</label><input type="text" id="nvRef">
          <label for="nvNotes">Notes</label><input type="text" id="nvNotes">
          <label for="nvRcpt">Receipt</label><input type="file" id="nvRcpt" accept="image/*,application/pdf">
          <span></span><div id="nvPrev" class="rcpt-prev">No receipt chosen</div></div></fieldset>
      </div><div class="wfoot"><a class="btn" href="#billing">Cancel</a><button type="submit" class="btn primary">Save &amp; Create Voucher</button></div></form>`;
    const loadAcc = async () => {
      const sel = $("#nvAcc"), co = $("#nvCo").value;
      if (!co) { sel.innerHTML = `<option value="">— Choose the company first —</option>`; return; }
      sel.innerHTML = `<option value="">Loading…</option>`;
      const { data } = await sb.from("pay_accounts").select("*").eq("company_id", co).order("account_name");
      const list = data || [];
      sel.innerHTML = list.length ? list.map((a) => `<option value="${a.id}">${esc(a.account_name)}${a.account_number ? " · " + esc(a.account_number) : ""}${a.bank_name ? " · " + esc(a.bank_name) : ""}</option>`).join("")
        : `<option value="">— No accounts yet: add one in the company profile —</option>`;
    };
    const calc = () => {
      const php = num($("#nvPhp").value), rate = num($("#nvRate").value);
      const b = Math.round(php * rate * 100) / 100;
      $("#nvBdt").textContent = bdt(b);
      $("#nvFormula").textContent = php && rate ? `${peso(php)} × ${rate} = ${peso(b)}` : "PHP × rate = BDT";
      $("#nvWords").textContent = b ? words(b, "TAKA") : "";
    };
    $("#nvCo").onchange = loadAcc; loadAcc();
    $("#nvPhp").oninput = calc; $("#nvRate").oninput = calc; calc();
    $("#nvRcpt").onchange = (e) => {
      const f = e.target.files[0];
      $("#nvPrev").innerHTML = !f ? "No receipt chosen" : /^image\//.test(f.type) ? `<img src="${URL.createObjectURL(f)}" alt="Receipt preview">` : esc(f.name);
    };
    $("#nvForm").onsubmit = async (e) => {
      e.preventDefault();
      const co = $("#nvCo").value, acc = $("#nvAcc").value, php = num($("#nvPhp").value), rate = num($("#nvRate").value);
      if (!co) return toast("Choose the company.", true);
      if (!acc) return toast("Choose the account (add one in the company profile if the list is empty).", true);
      if (php <= 0) return toast("Enter the amount in PHP.", true);
      if (rate <= 0) return toast("Enter the exchange rate.", true);
      E.setBusy(e.target, true, "Saving");
      const { data: v, error: err } = await sb.from("pay_vouchers").insert({ company_id: co, account_id: acc, pay_date: $("#nvDate").value || isoToday(), amount_php: php, exchange_rate: rate,
        purpose: $("#nvPurpose").value.trim() || null, method: $("#nvMethod").value, reference_no: $("#nvRef").value.trim() || null, notes: $("#nvNotes").value.trim() || null }).select().single();
      if (err) { E.setBusy(e.target, false); return fail(err, "Could not save the payment"); }
      try { localStorage.setItem(RATE_KEY, String(rate)); } catch (_) {}
      const f = await E.uploadRecords("pay_voucher", v.id, "receipt", E.filesOf("nvRcpt"));
      toast(`Voucher ${v.voucher_no} created — BDT ${peso(v.amount_bdt)}.${f ? " The receipt failed to upload." : ""}`, f > 0);
      location.hash = "voucher/" + v.id;
    };
    E.setRecords("New payment voucher");
  };

  // The voucher: PDF417 barcode, BDT amount a little bigger, receipt photo fitted in its box.
  // System-generated: no signature line.
  function voucherPage(v, receiptUrl) {
    const a = v.pay_accounts || {};
    return `${E.printHead("PAYMENT VOUCHER", `<img src="${E.pdf417DataUrl("EMONBD|" + v.voucher_no)}" alt="" class="ph-bar"><div class="mono">${esc(v.voucher_no)}</div>`)}
      <div class="vno-row"><span>Voucher No: <b>${esc(v.voucher_no)}</b></span><span>Issued by: <b>${esc(v.created_by_name || "")}</b></span><span>Date: <b>${esc(E.dShort(v.pay_date))}</b></span></div>
      ${E.box("Paid To", `<div class="pgrid2">${E.cell("Company", v.pay_companies?.name, "hl")}${E.cell("Account Name", a.account_name)}${E.cell("Account Number", a.account_number)}${E.cell("Bank / Branch", [a.bank_name, a.branch_name].filter(Boolean).join(" — "))}</div>`)}
      ${E.box("Payment", `<div class="prow3">${E.cell("Purpose", v.purpose)}${E.cell("Method", v.method)}${E.cell("Reference No", v.reference_no)}</div>
        <table class="rp v-amt"><tbody>
          <tr><td>Amount (Philippine Peso)</td><td class="num">PHP ${peso(v.amount_php)}</td></tr>
          <tr><td>Exchange Rate (BDT per 1 PHP)</td><td class="num">× ${Number(v.exchange_rate).toFixed(4)}</td></tr>
          <tr class="v-bdt"><td>Amount (Bangladeshi Taka)</td><td class="num">BDT ${peso(v.amount_bdt)}</td></tr></tbody></table>
        <div class="pcell"><div class="pl">Amount in Words</div><div class="pv words">${esc(words(v.amount_bdt, "TAKA"))}</div></div>`)}
      ${receiptUrl ? `<div class="pbox v-rcpt"><div class="pbox-h">Receipt</div><div class="v-rcpt-in"><img src="${esc(receiptUrl)}" alt="Receipt"></div></div>` : ""}
      ${v.notes ? `<p class="pdecl"><b>Notes:</b> ${esc(v.notes)}</p>` : ""}
      <div class="soa-sys">This is a system-generated voucher. No signature is required.</div>
      <div class="rp-foot"><span>Scan the barcode in the ${esc(E.APP)} to verify this voucher.</span><span>${esc(v.voucher_no)}</span></div>`;
  }
  V.voucher = async (id) => {
    E.shell("voucher", "Billing — Payment Voucher", busy());
    const { data: v } = await sb.from("pay_vouchers").select("*, pay_companies(name,country), pay_accounts(account_name,account_number,bank_name,branch_name)").eq("id", id).maybeSingle();
    if (!v) { $("#main").innerHTML = `<div class="empty">Voucher not found. <a href="#billing">Back</a></div>`; return; }
    const att = await E.attachmentsOf("pay_voucher", id);
    const rcpt = att.find((a) => a.kind === "receipt" && E.isImage(a));
    const print = async () => E.openPreview(`Voucher ${v.voucher_no}`, [voucherPage(v, rcpt ? await E.signedUrl(rcpt.storage_path, 1800) : "")]);
    const a = v.pay_accounts || {};
    $(".band h1").textContent = `Payment Voucher — ${v.voucher_no}`;
    $("#main").innerHTML = `<div class="window"><div class="wtitle">${esc(v.voucher_no)} · ${esc(v.pay_companies?.name || "")}</div><div class="wbody">
      <div class="formgrid"><div class="fields wide">
        <span>Paid To</span><a href="#paycompany/${v.company_id}"><b>${esc(v.pay_companies?.name || "")}</b></a>
        <span>Account</span><span>${esc([a.account_name, a.account_number, a.bank_name, a.branch_name].filter(Boolean).join(" · ") || "—")}</span>
        <span>Date</span><span>${dmy(v.pay_date)}</span><span>Purpose</span><span>${esc(v.purpose || "—")}</span>
        <span>Method</span><span>${esc(v.method || "—")}${v.reference_no ? " · Ref " + esc(v.reference_no) : ""}</span><span>Issued By</span><span>${esc(v.created_by_name || "")}</span></div>
        <div class="amt-panel"><div><small>Amount (PHP)</small><b>₱ ${peso(v.amount_php)}</b></div><div><small>Exchange Rate</small><b>× ${Number(v.exchange_rate).toFixed(4)}</b></div>
          <div class="hl"><small>Amount (BDT)</small><b>${bdt(v.amount_bdt)}</b></div><small class="muted">${esc(words(v.amount_bdt, "TAKA"))}</small></div></div>
      <div class="docgrid">${E.docCard({ key: "pv", title: `Payment Voucher ${v.voucher_no}`, sub: `${bdt(v.amount_bdt)} · ${dmy(v.pay_date)}`, ownerType: "pay_voucher", ownerId: v.id, att, print, canUpload: E.canWrite("billing") })}</div>
      <div><b>Receipt</b>${E.filesHtml(att.filter((x) => x.kind !== "signed_form"), "No receipt uploaded.")}
        ${E.canWrite("billing") ? `<div class="fields wide" style="margin-top:6px">${E.fileField("vAddRcpt", "Add Receipt", 'accept="image/*,application/pdf"')}</div>` : ""}</div>
      ${rhBox("pay_vouchers", v.id)}</div>
      <div class="wfoot">${tools("pay_vouchers", v, `Voucher ${v.voucher_no}`, { reload: () => V.voucher(id), afterDelete: () => (location.hash = "paycompany/" + v.company_id) })}<a class="btn" href="#paycompany/${v.company_id}">Close</a></div></div>`;
    E.bindFiles($("#main"));
    E.bindDocCards($("#main"), () => V.voucher(id));
    bindTools($("#main"));
    if ($("#vAddRcpt")) $("#vAddRcpt").onchange = async (e) => { const f = await E.uploadRecords("pay_voucher", id, "receipt", Array.from(e.target.files)); toast(f ? "Upload failed." : "Receipt uploaded.", f > 0); V.voucher(id); };
    E.setRecords(`Voucher: ${v.voucher_no}`);
  };

  Object.assign(E, { printJobApp, jobAppPage, EDU_COLS, EXP_COLS, MODULES });
})();
