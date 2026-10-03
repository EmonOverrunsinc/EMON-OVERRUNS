/* Emon Overruns Portal — 5 User (employees & access), 6 Resolution (notices),
   7 Project (application, approval, payments), 8 Billing (supplier portal). */
(function () {
  "use strict";
  const E = window.EO;
  const { sb, S, C, esc, peso, isoToday, dmy, stamp, $, $$, isAdmin, isStaff, pill, toast, fail, words } = E;
  const V = window.EO_VIEWS;
  const num = (v) => Number(v || 0);
  const canWrite = (m) => isAdmin() || (isStaff() && E.hasModule(m));
  const MODULES = [["customers", "1 Customer"], ["invoices", "2 Invoice"], ["payments", "3 Payment"], ["creditmemos", "4 Credit Memo"], ["resolutions", "6 Resolution"], ["projects", "7 Project"], ["billing", "8 Billing"]];
  const fullName = (r) => `${r.first_name || ""} ${r.last_name || ""}`.trim();
  const monthLabel = (iso) => iso ? new Date(String(iso).slice(0, 10) + "T00:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" }) : "";
  async function uploadPhoto(folder, id, file) {
    if (!file) return null;
    const path = `${folder}/${id}/photo_${Date.now()}_${file.name.replace(/[^\w.\-]+/g, "_")}`;
    const up = await sb.storage.from("records").upload(path, file, { contentType: file.type });
    if (up.error) { toast("The photo could not be uploaded.", true); return null; }
    return path;
  }
  // "5 User Resolution" holds two functions, shown as tabs.
  const urTabs = (on) => `<div class="tabs ur-tabs">${isAdmin() ? `<a class="${on === "users" ? "on" : ""}" href="#users">User</a>` : ""}<a class="${on === "resolutions" ? "on" : ""}" href="#resolutions">Resolution</a></div>`;
  V.userres = () => { location.replace("#" + (isAdmin() ? "users" : "resolutions")); };
  const photoBox = (url, fallback) => `<div class="pf-photo">${url ? `<img src="${esc(url)}" alt="">` : `<span>${esc(fallback)}</span>`}</div>`;

  // ======================================================================
  // 5. User — employees and their menu access
  // ======================================================================
  V.users = async () => {
    E.shell("users", "User Resolution — User", `${urTabs("users")}<div class="btnrow"><a class="btn primary" href="#newemployee">+ New Employee</a></div><div id="emRes"></div>`,
      "Create the employee record and choose which menu items they may use. Then the employee opens the portal, presses <b>Create Account</b> with the same email, and gets in straight away with that access.");
    const { data, error } = await sb.from("employees").select("*").order("created_at", { ascending: false });
    if (error) return fail(error, "Could not load employees");
    const rows = data || [];
    $("#emRes").innerHTML = E.grid({ cols: [
      { label: "Employee No", get: (r) => r.employee_no }, { label: "Name", get: fullName }, { label: "Position", get: (r) => r.position || "" },
      { label: "Email", get: (r) => r.email }, { label: "Role", get: (r) => r.role.toUpperCase() },
      { label: "Access", get: (r) => r.role === "admin" ? "Everything" : (r.modules || []).map((m) => (MODULES.find((x) => x[0] === m) || [m, m])[1]).join(", ") || "Dashboard only" },
      { label: "Login", html: (r) => r.status === "waiting" ? `<span class="pill pending">WAITING SIGN-UP</span>` : pill(r.status) }],
      rows, onRow: true, empty: "No employees yet. Press New Employee." });
    E.bindGrid($("#emRes"), rows, (r) => (location.hash = "employee/" + r.id));
    E.setRecords(`Employees: ${rows.length}`);
  };

  const accessFields = (role, mods) => `
    <label for="emRole">Role</label><select id="emRole">
      <option value="staff" ${role === "staff" ? "selected" : ""}>Staff — can add and record</option>
      <option value="viewer" ${role === "viewer" ? "selected" : ""}>Viewer — can only look</option>
      <option value="admin" ${role === "admin" ? "selected" : ""}>Admin — everything, approves</option></select>
    <span>Menu Access</span><div class="checks access">${MODULES.map(([k, l]) => `<label><input type="checkbox" name="emMod" value="${k}" ${mods.includes(k) ? "checked" : ""}> ${l}</label>`).join("")}</div>`;
  const readAccess = () => ({ role: $("#emRole").value, modules: $$("input[name=emMod]:checked").map((x) => x.value) });

  V.newemployee = () => {
    if (!isAdmin()) { location.hash = "dashboard"; return; }
    E.shell("newemployee", "New Employee", `
      <form class="window" id="neForm" novalidate><div class="wtitle">Employee Information</div><div class="wbody">
        <div class="summary-box"><div class="fields wide"><span>Employee No</span><b>Assigned on save (EO-YYYYMM##)</b><span>Created By</span><b>${esc(S.profile.full_name || "")}</b></div></div>
        <fieldset class="opt"><legend>Personal Details</legend><div class="formgrid">
          <div class="fields wide">
            <label for="neFirst">First Name *</label><input type="text" id="neFirst" required>
            <label for="neLast">Last Name *</label><input type="text" id="neLast" required>
            <label for="nePos">Position</label><input type="text" id="nePos" placeholder="e.g. Warehouse Staff">
            <label for="neHired">Date Hired</label><input type="date" id="neHired" value="${isoToday()}">
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
          <span></span><small>The signature form can also be uploaded later from the employee profile.</small></div></fieldset>
        <fieldset class="opt"><legend>Access</legend><div class="fields wide">${accessFields("staff", ["customers"])}</div></fieldset>
      </div><div class="wfoot"><a class="btn" href="#users">Cancel</a><button type="submit" class="btn primary">Save Employee</button></div></form>`);
    $("#neForm").onsubmit = async (e) => {
      e.preventDefault();
      const v = (id) => $("#" + id).value.trim();
      if (!v("neFirst") || !v("neLast")) return toast("Enter the first and last name.", true);
      if (!/^\S+@\S+\.\S+$/.test(v("neEmail"))) return toast("Enter a valid email. The employee signs in with it.", true);
      $$("#neForm button").forEach((b) => (b.disabled = true));
      const id = E.uuid();
      const photo_path = await uploadPhoto("employee", id, $("#nePhoto").files[0]);
      const { data, error } = await sb.from("employees").insert({
        id, first_name: v("neFirst"), last_name: v("neLast"), position: v("nePos") || null, email: v("neEmail"),
        phone: v("nePhone") || null, address: v("neAddr") || null, date_hired: v("neHired") || null, photo_path, ...readAccess()
      }).select().single();
      if (error) { $$("#neForm button").forEach((b) => (b.disabled = false)); return fail(error, "Could not save the employee"); }
      let f = await E.uploadRecords("employee", id, "application", E.filesOf("neApp"));
      f += await E.uploadRecords("employee", id, "signature", E.filesOf("neSig"));
      toast(`Saved ${data.employee_no}.${f ? ` ${f} file(s) failed.` : ""}`, f > 0);
      location.hash = "employee/" + id;
    };
  };

  V.employee = async (id) => {
    if (!isAdmin()) { location.hash = "dashboard"; return; }
    E.shell("employee", "Employee", `<div class="empty">Loading…</div>`);
    const { data: em } = await sb.from("employees").select("*").eq("id", id).maybeSingle();
    if (!em) { $("#main").innerHTML = `<div class="empty">Employee not found. <a href="#users">Back</a></div>`; return; }
    const att = await E.attachmentsOf("employee", id);
    const photo = em.photo_path ? await E.signedUrl(em.photo_path) : "";
    $(".band h1").textContent = `Employee — ${fullName(em)}`;
    $("#main").innerHTML = `
      <div class="profile">${photoBox(photo, (em.first_name[0] || "") + (em.last_name[0] || ""))}
        <div class="pf-main"><h2>${esc(fullName(em))} ${em.status === "waiting" ? `<span class="pill pending">WAITING SIGN-UP</span>` : pill(em.status)}</h2>
          <div class="pf-ids"><span>Employee No <b class="mono">${esc(em.employee_no)}</b></span><span>Position <b>${esc(em.position || "—")}</b></span><span>Hired <b>${dmy(em.date_hired) || "—"}</b></span></div>
          <div class="pf-sub">${esc(em.email)} · ${esc(em.phone || "")} · ${esc(em.address || "")}</div></div></div>
      ${em.status === "waiting" ? `<div class="banner warn">No login yet. Ask ${esc(em.first_name)} to open the portal, tap <b>Create Account</b> and use <b>${esc(em.email)}</b>. They will get in straight away with the access below.</div>` : ""}
      <fieldset class="opt"><legend>Access &amp; Status</legend><div class="fields wide">${accessFields(em.role, em.modules || [])}
        <label for="emStatus">Status</label><select id="emStatus" ${em.status === "waiting" ? "disabled" : ""}>
          <option value="active" ${em.status !== "inactive" ? "selected" : ""}>Active — can sign in</option><option value="inactive" ${em.status === "inactive" ? "selected" : ""}>Inactive — blocked</option></select></div>
        <div class="btnrow"><button class="btn primary" id="emSave">Save Access</button></div></fieldset>
      <fieldset class="opt"><legend>Documents</legend>${E.filesHtml(att)}
        <div class="fields wide" style="margin-top:8px">${E.fileField("emSig", "Upload Signature Form", 'accept="image/*,application/pdf"')}${E.fileField("emApp", "Upload Application", 'multiple accept="image/*,application/pdf"')}</div></fieldset>
      <div class="btnrow"><button class="btn" id="emPrint">Print Employee Record</button><a class="btn" href="#users">Close</a></div>`;
    E.bindFiles($("#main"));
    $("#emSave").onclick = async () => {
      const patch = readAccess();
      if (em.status !== "waiting") patch.status = $("#emStatus").value;
      const { error } = await sb.from("employees").update(patch).eq("id", id);
      if (error) return fail(error, "Could not save");
      toast("Access saved."); V.employee(id);
    };
    const up = (inp, kind) => (inp.onchange = async (e) => { const f = await E.uploadRecords("employee", id, kind, Array.from(e.target.files)); toast(f ? "Upload failed." : "Uploaded.", f > 0); V.employee(id); });
    up($("#emSig"), "signature"); up($("#emApp"), "application");
    $("#emPrint").onclick = () => E.openPreview(`Employee ${em.employee_no}`, [`${E.printHead("EMPLOYEE INFORMATION", `<div class="mono">${esc(em.employee_no)}</div>`)}
      ${E.box("Employee", `<div class="pgrid"><div class="pphoto">${photo ? `<img src="${esc(photo)}" alt="">` : "PHOTO"}</div><div class="pgrid2">
        ${E.cell("First Name", em.first_name)}${E.cell("Last Name", em.last_name)}${E.cell("Position", em.position)}${E.cell("Date Hired", dmy(em.date_hired))}
        ${E.cell("Email", em.email)}${E.cell("Phone", em.phone)}${E.cell("Address", em.address, "span2")}</div></div>`)}
      ${E.box("Portal Access", `<div class="pgrid2">${E.cell("Role", em.role.toUpperCase())}${E.cell("Menu Access", em.role === "admin" ? "Everything" : (em.modules || []).map((m) => (MODULES.find((x) => x[0] === m) || [m, m])[1]).join(", "))}</div>`)}
      ${E.box("Specimen Signature", `<div class="sigbox"><div></div><div></div><div></div></div>`)}
      ${E.sigs("Employee Signature / Date", "Approved by / Date")}`]);
  };

  // ======================================================================
  // 6. Resolution — notices shown for 3 months, newest first
  // ======================================================================
  V.resolutions = async () => {
    const w = canWrite("resolutions");
    E.shell("resolutions", "User Resolution — Resolution", `${urTabs("resolutions")}
      ${w ? `<form class="window" id="rsForm" novalidate style="margin-bottom:10px"><div class="wtitle">New Resolution / Notice</div><div class="wbody">
        <div class="fields wide"><label for="rsSubj">Subject *</label><input type="text" id="rsSubj" required>
        <label for="rsDate">Date</label><input type="date" id="rsDate" value="${isoToday()}">
        <label for="rsBody">Details</label><textarea id="rsBody" rows="4"></textarea>
        ${E.fileField("rsImg", "Report Image", 'accept="image/*,application/pdf"')}</div></div>
        <div class="wfoot"><button class="btn primary" type="submit">Post Resolution</button></div></form>` : ""}
      ${isAdmin() ? `<div class="checks" style="margin-bottom:6px"><label><input type="checkbox" id="rsOld"> Show archive (older than 3 months)</label></div>` : ""}
      <div id="rsList"><div class="empty">Loading…</div></div>`, "Notices stay on this list for <b>3 months</b> and are then removed automatically. The newest is always at the top.");
    const cutoff = (() => { const d = new Date(); d.setMonth(d.getMonth() - 3); return d.toISOString().slice(0, 10); })();
    const load = async () => {
      let q = sb.from("resolutions").select("*").order("resolution_date", { ascending: false }).order("created_at", { ascending: false });
      if (!$("#rsOld")?.checked) q = q.gte("resolution_date", cutoff);
      const { data, error } = await q;
      if (error) return fail(error, "Could not load resolutions");
      const rows = data || [];
      const urls = await Promise.all(rows.map((r) => (r.image_path ? E.signedUrl(r.image_path, 1800) : "")));
      $("#rsList").innerHTML = rows.length ? rows.map((r, i) => `<article class="notice ${r.resolution_date < cutoff ? "old" : ""}">
          <header><span class="mono">${esc(r.resolution_no)}</span><b>${esc(r.subject)}</b><span>${dmy(r.resolution_date)}</span></header>
          <div class="notice-body">${urls[i] ? (/\.pdf$/i.test(r.image_path) ? `<a class="btn" href="${esc(urls[i])}" target="_blank" rel="noopener">Open Report (PDF)</a>` : `<a href="${esc(urls[i])}" target="_blank" rel="noopener"><img src="${esc(urls[i])}" alt="Report image for ${esc(r.subject)}"></a>`) : ""}
            <p>${esc(r.body || "")}</p></div>
          <footer><small>Posted by ${esc(r.created_by_name || "")} · ${r.resolution_date < cutoff ? "ARCHIVED" : "visible until " + dmy(new Date(new Date(r.resolution_date + "T00:00:00").setMonth(new Date(r.resolution_date + "T00:00:00").getMonth() + 3)).toISOString())}</small>
          <button class="btn" data-print="${i}">Print</button>${isAdmin() ? ` <button class="btn danger" data-del="${r.id}">Delete</button>` : ""}</footer></article>`).join("")
        : `<div class="empty">No resolutions in the last 3 months.</div>`;
      $$("[data-print]").forEach((b) => (b.onclick = () => { const r = rows[Number(b.dataset.print)], u = urls[Number(b.dataset.print)];
        E.openPreview(r.resolution_no, [`${E.printHead("RESOLUTION / NOTICE", `<div class="mono">${esc(r.resolution_no)}</div>`)}
          <div class="prow3">${E.cell("Resolution No", r.resolution_no)}${E.cell("Date", dmy(r.resolution_date))}${E.cell("Posted By", r.created_by_name)}</div>
          ${E.box("Subject", `<div class="pv" style="padding:6px;font-weight:bold">${esc(r.subject)}</div>`)}
          ${E.box("Details", `<div class="pv" style="padding:6px;white-space:pre-wrap">${esc(r.body || "")}</div>`)}
          ${u && !/\.pdf$/i.test(r.image_path) ? `<img src="${esc(u)}" alt="" style="max-width:100%;max-height:120mm;align-self:center">` : ""}
          ${E.sigs("Prepared by", "Approved by")}`]); }));
      $$("[data-del]").forEach((b) => (b.onclick = async () => {
        if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Confirm Delete"; return; }
        const { error: e2 } = await sb.from("resolutions").delete().eq("id", b.dataset.del);
        if (e2) return fail(e2, "Could not delete"); load();
      }));
      E.setRecords(`Resolutions: ${rows.length}`);
    };
    if ($("#rsOld")) $("#rsOld").onchange = load;
    if ($("#rsForm")) $("#rsForm").onsubmit = async (e) => {
      e.preventDefault();
      const subject = $("#rsSubj").value.trim();
      if (!subject) return toast("Enter the subject.", true);
      $$("#rsForm button").forEach((b) => (b.disabled = true));
      const id = E.uuid(); const f = $("#rsImg").files[0];
      let image_path = null;
      if (f) { image_path = `resolution/${id}/${Date.now()}_${f.name.replace(/[^\w.\-]+/g, "_")}`; const up = await sb.storage.from("records").upload(image_path, f, { contentType: f.type }); if (up.error) { image_path = null; toast("The image could not be uploaded.", true); } }
      const { data, error } = await sb.from("resolutions").insert({ id, subject, body: $("#rsBody").value.trim() || null, resolution_date: $("#rsDate").value || isoToday(), image_path }).select().single();
      $$("#rsForm button").forEach((b) => (b.disabled = false));
      if (error) return fail(error, "Could not post");
      if (image_path) await sb.from("attachments").insert({ owner_type: "resolution", owner_id: id, kind: "report", storage_path: image_path, file_name: f.name, mime: f.type, size: f.size });
      toast(`Posted ${data.resolution_no}.`); e.target.reset(); $("#rsDate").value = isoToday(); load();
    };
    load();
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
      <div class="tabs" id="pjTabs"><button class="on" data-f="approved">Approved</button><button data-f="pending">Waiting Approval</button><button data-f="completed">Completed</button><button data-f="rejected">Rejected</button><button data-f="">All</button></div>
      <div class="btnrow">${canWrite("projects") ? `<a class="btn primary" href="#newproject">+ New Project Application</a>` : ""}</div><div id="pjRes"></div>`,
      "Submit a project with its budget. Upload the approved document; after admin approval the project moves to <b>Approved</b> and payments can be recorded against its total cost.");
    const run = async (f) => {
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
    if (!canWrite("projects")) { location.hash = "projects"; return; }
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
      $$("#pjForm button").forEach((b) => (b.disabled = true));
      const { data: pr, error } = await sb.from("projects").insert({ title, location: $("#pjLoc").value.trim() || null, description: $("#pjDesc").value.trim() || null,
        start_date: $("#pjStart").value || null, end_date: $("#pjEnd").value || null, total_cost: Math.round(total * 100) / 100 }).select().single();
      if (error) { $$("#pjForm button").forEach((b) => (b.disabled = false)); return fail(error, "Could not submit the project"); }
      const { error: e2 } = await sb.from("project_items").insert(lines.map((l) => ({ ...l, project_id: pr.id })));
      if (e2) fail(e2, "Project saved, but the budget lines could not be saved");
      toast(`Project ${pr.project_no} submitted.`); location.hash = "project/" + pr.id;
    };
  };

  V.project = async (id) => {
    E.shell("project", "Project", `<div class="empty">Loading…</div>`);
    const { data: pr } = await sb.from("project_balances").select("*").eq("id", id).maybeSingle();
    if (!pr) { $("#main").innerHTML = `<div class="empty">Project not found. <a href="#projects">Back</a></div>`; return; }
    const [items, pays, att] = await Promise.all([
      sb.from("project_items").select("*").eq("project_id", id).order("id"),
      sb.from("project_payments").select("*").eq("project_id", id).order("pay_date"),
      E.attachmentsOf("project", id)]);
    const lines = items.data || [], payments = pays.data || [];
    const approvals = att.filter((a) => a.kind === "approval");
    const w = canWrite("projects");
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
        <div><b>Project Budget</b>${E.grid({ cols: [{ label: "Description", get: (r) => r.description }, { label: "Qty", num: true, get: (r) => r.qty }, { label: "Unit Cost (₱)", num: true, get: (r) => peso(r.unit_cost) }, { label: "Amount (₱)", key: "amount", num: true, get: (r) => peso(r.amount) }], rows: lines, foot: { amount: peso(pr.total_cost) } })}</div>
        ${pr.status === "pending" ? `<fieldset class="opt review"><legend>Approval</legend>
          <ol class="steps"><li><b>Print</b> the project application and get it signed.</li>
          <li><b>Upload the approved document</b>${w ? `<div class="fields wide">${E.fileField("pjApproved", "Approved Document", 'accept="image/*,application/pdf"')}</div>` : ""}<div>${approvals.length ? E.filesHtml(approvals) : "<small>Not uploaded yet.</small>"}</div></li>
          ${isAdmin() ? `<li><b>Decide:</b><div class="fields wide"><label for="pjNote">Note</label><input type="text" id="pjNote"></div>
            <div class="btnrow"><button class="btn ok" data-pa="approve" ${approvals.length ? "" : 'disabled title="Upload the approved document first"'}>Approve Project</button><button class="btn danger" data-pa="reject">Reject</button></div></li>` : "<li>Waiting for the administrator to approve.</li>"}</ol></fieldset>` : ""}
        ${pr.status === "approved" && w ? `<form class="opt" id="ppForm" novalidate style="border:1px solid var(--panel-line);background:var(--panel);padding:8px 10px"><b>Record Payment</b>
          <div class="formgrid"><div class="fields wide"><label for="ppDate">Date</label><input type="date" id="ppDate" value="${isoToday()}">
            <label for="ppAmt">Amount (₱) *</label><input type="number" id="ppAmt" min="0.01" step="0.01">
            <label for="ppBy">Received By *</label><input type="text" id="ppBy"></div>
          <div class="fields wide"><label for="ppMethod">Method</label><select id="ppMethod"><option>Cash</option><option>Bank Transfer</option><option>Online Transfer</option><option>Cheque</option></select>
            <label for="ppRef">Reference No</label><input type="text" id="ppRef">
            ${E.fileField("ppRcpt", "Receipt", 'accept="image/*,application/pdf"')}</div></div>
          <div class="btnrow"><button class="btn primary" type="submit">Save Payment</button>${isAdmin() ? `<button class="btn" type="button" data-pa="complete">Mark Project Completed</button>` : ""}</div></form>` : ""}
        <div><b>Payments</b>${E.grid({ cols: [{ label: "Payment No", get: (r) => r.payment_no }, { label: "Date", get: (r) => dmy(r.pay_date) }, { label: "Received By", get: (r) => r.received_by }, { label: "Method", get: (r) => r.method || "" }, { label: "Reference", get: (r) => r.reference_no || "" }, { label: "Amount (₱)", key: "amount", num: true, get: (r) => peso(r.amount) }, { label: "Recorded By", get: (r) => r.created_by_name || "" }], rows: payments, foot: { amount: peso(pr.total_paid) }, empty: pr.status === "approved" ? "No payments yet." : "Payments unlock after the project is approved." })}</div>
        <div><b>Files</b>${E.filesHtml(att)}</div>
      </div><div class="wfoot">${approvals.length ? `<button class="btn primary" id="pjSigned">View Signed / Approved Application</button>` : ""}<button class="btn ${approvals.length ? "" : "primary"}" id="pjPrint">Print Project Application</button><button class="btn" id="pjStmt">Print Payment Record</button><a class="btn" href="#projects">Close</a></div></div>`;
    E.bindFiles($("#main"));
    if ($("#pjApproved")) $("#pjApproved").onchange = async (e) => { const f = await E.uploadRecords("project", id, "approval", Array.from(e.target.files)); toast(f ? "Upload failed." : "Approved document uploaded.", f > 0); V.project(id); };
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
    $("#pjPrint").onclick = () => E.openPreview(`Project ${pr.project_no}`, [`${E.printHead("PROJECT APPLICATION", `<img src="${E.pdf417DataUrl("EMONPRJ|" + pr.project_no)}" alt="" class="ph-bar"><div class="mono">${esc(pr.project_no)}</div>`)}
      ${E.box("Project", `<div class="pgrid2">${E.cell("Project Title", pr.title, "span2")}${E.cell("Location", pr.location)}${E.cell("Start / End", `${dmy(pr.start_date)} → ${dmy(pr.end_date)}`)}${E.cell("Description", pr.description, "span2")}</div>`)}
      ${E.box("Project Budget", `<table class="rp"><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit Cost</th><th class="num">Amount</th></tr></thead><tbody>
        ${lines.map((l) => `<tr><td>${esc(l.description)}</td><td class="num">${l.qty}</td><td class="num">${peso(l.unit_cost)}</td><td class="num">${peso(l.amount)}</td></tr>`).join("")}
        <tr class="grand"><td colspan="3" class="num">TOTAL PROJECT COST (₱)</td><td class="num">${peso(pr.total_cost)}</td></tr></tbody></table>
        <div class="pcell"><div class="pl">Amount in Words</div><div class="pv words">${esc(words(pr.total_cost))}</div></div>`)}
      ${E.sigs(`Prepared by: ${esc(pr.created_by_name || "")}`, "Approved by / Date")}`]);
    if ($("#pjSigned")) $("#pjSigned").onclick = () => E.viewFile(approvals[0]);
    $("#pjStmt").onclick = () => E.openPreview(`Project payments ${pr.project_no}`, E.listingPages({
      title: "Project Payment Record", range: `${esc(pr.project_no)} — ${esc(pr.title)}`,
      cols: [{ label: "Payment No", get: (r) => r.payment_no }, { label: "Date", get: (r) => dmy(r.pay_date) }, { label: "Received By", get: (r) => r.received_by }, { label: "Method", get: (r) => r.method || "" }, { label: "Reference", get: (r) => r.reference_no || "" }, { label: "Amount", num: true, get: (r) => peso(r.amount) }],
      rows: payments,
      summary: { title: "Project Summary (PHP)", cols: ["Item", "", "Amount (₱)"], rows: [["Total Project Cost", "", peso(pr.total_cost)], ["Total Paid", String(payments.length) + " payment(s)", peso(pr.total_paid)]], total: ["Remaining:", "", peso(pr.remaining)] },
      criteria: `Project: ${pr.project_no}\nStatus: ${pr.status.toUpperCase()}\nApproved by: ${pr.approved_by_name || "-"}`
    }));
  };

  // ======================================================================
  // 8. Billing — supplier portal
  // ======================================================================
  V.billing = async () => {
    E.shell("billing", "Billing — Supplier Portal", `<div class="btnrow">${canWrite("billing") ? `<a class="btn primary" href="#newsupplier">+ New Supplier Account</a>` : ""}</div><div id="spRes"></div>`,
      "Supplier accounts with their bank details. Open a supplier to record released batches and payments, see monthly totals, and download the payment record.");
    const { data, error } = await sb.from("supplier_balances").select("*").order("account_name");
    if (error) return fail(error, "Could not load suppliers");
    const rows = data || [];
    const sum = (k) => peso(rows.reduce((s, r) => s + num(r[k]), 0));
    $("#spRes").innerHTML = E.grid({ cols: [
      { label: "Supplier No", get: (r) => r.supplier_no }, { label: "Account Name", get: (r) => r.account_name }, { label: "Bank", get: (r) => r.bank_name || "" },
      { label: "Account No", get: (r) => r.account_number || "" }, { label: "Branch", get: (r) => r.branch_name || "" },
      { label: "Monthly (₱)", key: "monthly_payment", num: true, get: (r) => peso(r.monthly_payment) },
      { label: "Batches (₱)", key: "total_batches", num: true, get: (r) => peso(r.total_batches) },
      { label: "Paid (₱)", key: "total_paid", num: true, get: (r) => peso(r.total_paid) },
      { label: "This Month (₱)", key: "paid_this_month", num: true, get: (r) => peso(r.paid_this_month) },
      { label: "Balance (₱)", key: "balance", num: true, get: (r) => peso(r.balance) }],
      rows, onRow: true, foot: { monthly_payment: sum("monthly_payment"), total_batches: sum("total_batches"), total_paid: sum("total_paid"), paid_this_month: sum("paid_this_month"), balance: sum("balance") }, empty: "No supplier accounts yet." });
    E.bindGrid($("#spRes"), rows, (r) => (location.hash = "supplier/" + r.id));
    E.setRecords(`Suppliers: ${rows.length}`);
  };

  V.newsupplier = () => {
    if (!canWrite("billing")) { location.hash = "billing"; return; }
    E.shell("newsupplier", "New Supplier Account", `
      <form class="window" id="nsForm" novalidate><div class="wtitle">Supplier Account</div><div class="wbody"><div class="formgrid">
        <div class="fields wide"><label for="nsName">Account Name *</label><input type="text" id="nsName" required placeholder="Name the bank account is opened under">
          <label for="nsNo">Account Number</label><input type="text" id="nsNo">
          <label for="nsBank">Bank Name</label><input type="text" id="nsBank">
          <label for="nsBranch">Branch Name</label><input type="text" id="nsBranch"></div>
        <div class="fields wide"><label for="nsCo">Company / Factory</label><input type="text" id="nsCo">
          <label for="nsPhone">Contact Phone</label><input type="tel" id="nsPhone">
          <label for="nsMonthly">Monthly Payment (₱)</label><input type="number" id="nsMonthly" min="0" step="0.01" value="0">
          <label for="nsPhoto">Photo</label><input type="file" id="nsPhoto" accept="image/*"></div></div>
        <div class="fields wide"><label for="nsNotes">Notes</label><input type="text" id="nsNotes"></div></div>
      <div class="wfoot"><a class="btn" href="#billing">Cancel</a><button class="btn primary" type="submit">Save Supplier</button></div></form>`);
    $("#nsForm").onsubmit = async (e) => {
      e.preventDefault();
      const v = (i) => $("#" + i).value.trim();
      if (!v("nsName")) return toast("Enter the account name.", true);
      $$("#nsForm button").forEach((b) => (b.disabled = true));
      const id = E.uuid();
      const photo_path = await uploadPhoto("supplier", id, $("#nsPhoto").files[0]);
      const { data, error } = await sb.from("suppliers").insert({ id, account_name: v("nsName"), account_number: v("nsNo") || null, bank_name: v("nsBank") || null,
        branch_name: v("nsBranch") || null, company: v("nsCo") || null, contact_phone: v("nsPhone") || null, monthly_payment: num(v("nsMonthly")), notes: v("nsNotes") || null, photo_path }).select().single();
      if (error) { $$("#nsForm button").forEach((b) => (b.disabled = false)); return fail(error, "Could not save the supplier"); }
      toast(`Saved ${data.supplier_no}.`); location.hash = "supplier/" + id;
    };
  };

  V.supplier = async (id) => {
    E.shell("supplier", "Supplier", `<div class="empty">Loading…</div>`);
    const { data: s } = await sb.from("supplier_balances").select("*").eq("id", id).maybeSingle();
    if (!s) { $("#main").innerHTML = `<div class="empty">Supplier not found. <a href="#billing">Back</a></div>`; return; }
    const [bt, py] = await Promise.all([
      sb.from("supplier_batches").select("*").eq("supplier_id", id).order("release_date", { ascending: false }),
      sb.from("supplier_payments").select("*, supplier_batches(batch_no)").eq("supplier_id", id).order("pay_date", { ascending: false })]);
    const batches = bt.data || [], pays = py.data || [];
    const photo = s.photo_path ? await E.signedUrl(s.photo_path) : "";
    const monthly = new Map();
    pays.forEach((p) => { const k = String(p.for_month).slice(0, 7); monthly.set(k, (monthly.get(k) || 0) + num(p.amount)); });
    const months = [...monthly.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([k, v]) => ({ month: k + "-01", total: v, count: pays.filter((p) => String(p.for_month).startsWith(k)).length }));
    const paidByBatch = new Map(); pays.forEach((p) => p.batch_id && paidByBatch.set(p.batch_id, (paidByBatch.get(p.batch_id) || 0) + num(p.amount)));
    const w = canWrite("billing");
    $(".band h1").textContent = `Supplier — ${s.account_name}`;
    $("#main").innerHTML = `
      <div class="profile">${photoBox(photo, s.account_name.slice(0, 2).toUpperCase())}
        <div class="pf-main"><h2>${esc(s.account_name)} ${pill(s.status)}</h2>
          <div class="pf-ids"><span>Supplier No <b class="mono">${esc(s.supplier_no)}</b></span><span>Bank <b>${esc(s.bank_name || "—")}</b></span>
            <span>Account No <b class="mono">${esc(s.account_number || "—")}</b></span><span>Branch <b>${esc(s.branch_name || "—")}</b></span></div>
          <div class="pf-sub">${esc(s.company || "")} · ${esc(s.contact_phone || "")} · Monthly payment ₱${peso(s.monthly_payment)}</div></div></div>
      <div class="tiles"><div class="tile"><div class="k">Total Batches Released</div><div class="v">₱ ${peso(s.total_batches)}</div></div>
        <div class="tile ok"><div class="k">Total Paid</div><div class="v">₱ ${peso(s.total_paid)}</div></div>
        <div class="tile"><div class="k">Paid This Month</div><div class="v">₱ ${peso(s.paid_this_month)}</div></div>
        <div class="tile ${num(s.balance) > 0 ? "warn" : "ok"}"><div class="k">Balance</div><div class="v">₱ ${peso(s.balance)}</div></div></div>
      <div class="btnrow"><button class="btn primary" id="spStmt">Download Payment Record</button><a class="btn" href="#billing">Close</a></div>
      ${w ? `<div class="cols">
        <form class="opt" id="sbForm" novalidate style="border:1px solid var(--panel-line);background:var(--panel);padding:8px 10px"><b>Add Released Batch</b><div class="fields wide">
          <label for="sbNo">Batch No *</label><input type="text" id="sbNo"><label for="sbDate">Release Date</label><input type="date" id="sbDate" value="${isoToday()}">
          <label for="sbAmt">Batch Amount (₱) *</label><input type="number" id="sbAmt" min="0" step="0.01"><label for="sbDesc">Description</label><input type="text" id="sbDesc"></div>
          <div class="btnrow"><button class="btn" type="submit">Save Batch</button></div></form>
        <form class="opt" id="spForm" novalidate style="border:1px solid var(--panel-line);background:var(--panel);padding:8px 10px"><b>Record Payment</b><div class="fields wide">
          <label for="spDate">Payment Date</label><input type="date" id="spDate" value="${isoToday()}">
          <label for="spMonth">For Month</label><input type="month" id="spMonth" value="${isoToday().slice(0, 7)}">
          <label for="spAmt">Amount (₱) *</label><input type="number" id="spAmt" min="0.01" step="0.01" value="${num(s.monthly_payment) || ""}">
          <label for="spBatch">For Batch</label><select id="spBatch"><option value="">— Not for a specific batch —</option>${batches.map((b) => `<option value="${b.id}">${esc(b.batch_no)} — ₱${peso(b.amount)}</option>`).join("")}</select>
          <label for="spMethod">Method</label><select id="spMethod"><option>Bank Transfer</option><option>Cash</option><option>Online Transfer</option><option>Deposit</option></select>
          <label for="spRef">Reference No</label><input type="text" id="spRef">
          ${E.fileField("spRcpt", "Receipt", 'accept="image/*,application/pdf"')}</div>
          <div class="btnrow"><button class="btn primary" type="submit">Save Payment</button></div></form></div>` : ""}
      <h3>Monthly Totals</h3><div id="spMonths"></div>
      <h3>Released Batches</h3><div id="spBatches"></div>
      <h3>Payments</h3><div id="spPays"></div>`;
    $("#spMonths").innerHTML = E.grid({ cols: [{ label: "Month", get: (r) => monthLabel(r.month) }, { label: "Payments", num: true, get: (r) => r.count }, { label: "Total Paid (₱)", key: "total", num: true, get: (r) => peso(r.total) }], rows: months, foot: { total: peso(s.total_paid) }, empty: "No payments yet." });
    $("#spBatches").innerHTML = E.grid({ cols: [{ label: "Batch No", get: (r) => r.batch_no }, { label: "Released", get: (r) => dmy(r.release_date) }, { label: "Description", get: (r) => r.description || "" }, { label: "Amount (₱)", key: "amount", num: true, get: (r) => peso(r.amount) }, { label: "Paid (₱)", num: true, get: (r) => peso(paidByBatch.get(r.id) || 0) }, { label: "Balance (₱)", num: true, get: (r) => peso(num(r.amount) - (paidByBatch.get(r.id) || 0)) }], rows: batches, foot: { amount: peso(s.total_batches) }, empty: "No batches released yet." });
    $("#spPays").innerHTML = E.grid({ cols: [{ label: "Payment No", get: (r) => r.payment_no }, { label: "Date", get: (r) => dmy(r.pay_date) }, { label: "For Month", get: (r) => monthLabel(r.for_month) }, { label: "Batch", get: (r) => r.supplier_batches?.batch_no || "" }, { label: "Method", get: (r) => r.method || "" }, { label: "Reference", get: (r) => r.reference_no || "" }, { label: "Amount (₱)", key: "amount", num: true, get: (r) => peso(r.amount) }, { label: "Recorded By", get: (r) => r.created_by_name || "" }], rows: pays, onRow: true, foot: { amount: peso(s.total_paid) }, empty: "No payments yet." });
    E.bindGrid($("#spPays"), pays, (p) => paymentDialog(s, p));
    if ($("#sbForm")) $("#sbForm").onsubmit = async (e) => {
      e.preventDefault();
      const no = $("#sbNo").value.trim(), amt = num($("#sbAmt").value);
      if (!no || !$("#sbAmt").value) return toast("Enter the batch number and amount.", true);
      const { error } = await sb.from("supplier_batches").insert({ supplier_id: id, batch_no: no, release_date: $("#sbDate").value || isoToday(), amount: amt, description: $("#sbDesc").value.trim() || null });
      if (error) return fail(error, "Could not save the batch");
      toast(`Batch ${no} saved.`); V.supplier(id);
    };
    if ($("#spForm")) $("#spForm").onsubmit = async (e) => {
      e.preventDefault();
      const amt = num($("#spAmt").value);
      if (amt <= 0) return toast("Enter the payment amount.", true);
      const { data: p, error } = await sb.from("supplier_payments").insert({ supplier_id: id, pay_date: $("#spDate").value || isoToday(), for_month: ($("#spMonth").value || isoToday().slice(0, 7)) + "-01",
        amount: amt, batch_id: $("#spBatch").value || null, method: $("#spMethod").value, reference_no: $("#spRef").value.trim() || null }).select().single();
      if (error) return fail(error, "Could not save the payment");
      const f = await E.uploadRecords("supplier_payment", p.id, "receipt", E.filesOf("spRcpt"));
      toast(`Payment ${p.payment_no} saved.${f ? " The receipt failed to upload." : ""}`, f > 0); V.supplier(id);
    };
    $("#spStmt").onclick = () => E.openPreview(`Supplier record ${s.supplier_no}`, E.listingPages({
      title: "Supplier Payment Record",
      range: `${esc(s.account_name)} — ${esc(s.bank_name || "")} ${esc(s.account_number || "")} ${s.branch_name ? "(" + esc(s.branch_name) + ")" : ""}`,
      cols: [{ label: "Payment No", get: (r) => r.payment_no }, { label: "Date", get: (r) => dmy(r.pay_date) }, { label: "For Month", get: (r) => monthLabel(r.for_month) }, { label: "Batch", get: (r) => r.supplier_batches?.batch_no || "" }, { label: "Method", get: (r) => r.method || "" }, { label: "Reference", get: (r) => r.reference_no || "" }, { label: "Amount", num: true, get: (r) => peso(r.amount) }],
      rows: pays.slice().reverse(),
      summary: { title: "Monthly Totals (PHP)", cols: ["Month", "Payments", "Total (₱)"], rows: months.map((m) => [monthLabel(m.month), String(m.count), peso(m.total)]), total: ["Total Paid:", String(pays.length), peso(s.total_paid)] },
      criteria: `Supplier: ${s.supplier_no} ${s.account_name}\nBatches released: PHP ${peso(s.total_batches)}\nBalance: PHP ${peso(s.balance)}`
    }));
    async function paymentDialog(sup, p) {
      const att = await E.attachmentsOf("supplier_payment", p.id);
      const signed = E.latestSigned(att);
      const d = document.createElement("div");
      d.className = "modal";
      d.innerHTML = `<div class="window" role="dialog" aria-modal="true" aria-label="Payment ${esc(p.payment_no)}"><div class="wtitle">Payment ${esc(p.payment_no)} — ₱${peso(p.amount)}</div>
        <div class="wbody">${E.signedPanel("supplier_payment", p.id, att, "payment voucher")}${E.filesHtml(att.filter((a) => a.kind !== "signed_form"))}</div>
        <div class="wfoot">${signed ? `<button class="btn primary" id="dvSigned">View Signed Voucher</button>` : ""}<button class="btn" id="dvPrint">Print Voucher</button><button class="btn" id="dvClose">Close</button></div></div>`;
      document.body.appendChild(d);
      E.bindFiles(d);
      E.bindSigned(d, () => { d.remove(); paymentDialog(sup, p); });
      $("#dvClose", d).onclick = () => d.remove();
      if (signed) $("#dvSigned", d).onclick = () => E.viewFile(signed);
      $("#dvPrint", d).onclick = () => { d.remove(); paymentVoucher(sup, p, att); };
    }
    async function paymentVoucher(sup, p, att) {
      const url = att[0] ? await E.signedUrl(att[0].storage_path, 900) : "";
      E.openPreview(`Payment ${p.payment_no}`, [`${E.printHead("SUPPLIER PAYMENT VOUCHER", `<img src="${E.pdf417DataUrl("EMONSP|" + p.payment_no)}" alt="" class="ph-bar"><div class="mono">${esc(p.payment_no)}</div>`)}
        ${E.box("Paid To", `<div class="pgrid2">${E.cell("Account Name", sup.account_name)}${E.cell("Supplier No", sup.supplier_no)}${E.cell("Bank", sup.bank_name)}${E.cell("Account Number", sup.account_number)}${E.cell("Branch", sup.branch_name, "span2")}</div>`)}
        ${E.box("Payment", `<div class="prow3">${E.cell("Payment Date", dmy(p.pay_date))}${E.cell("For Month", monthLabel(p.for_month))}${E.cell("Batch", p.supplier_batches?.batch_no)}</div>
          <div class="prow3">${E.cell("Method", p.method)}${E.cell("Reference No", p.reference_no)}${E.cell("Amount (₱)", peso(p.amount))}</div>
          <div class="pcell"><div class="pl">Amount in Words</div><div class="pv words">${esc(words(p.amount))}</div></div>`)}
        ${url && att[0].mime && att[0].mime.startsWith("image/") ? E.box("Receipt", `<img src="${esc(url)}" alt="" style="max-width:100%;max-height:90mm;display:block;margin:6px auto">`) : ""}
        ${E.sigs(`Prepared by: <b>${esc(p.created_by_name || "")}</b>`, "Received by (Supplier) / Date")}`]);
    }
  };
})();
