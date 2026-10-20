/* EMON OVERRUNS E-PORTAL — EO-Office (3.1): QC Test and Collection Voucher.
   QC TEST: a quality-check form with a header (serial no, item, brand, batch, CTN) and 10 problems to look for; every
   problem found takes 10 points off 100. The form gets a number QC-YYYY-#### with a PDF417 barcode and a PRIVATE CODE
   printed on the blank form. The server keeps only a scrambled copy of the code and the form stays LOCKED: whoever scans
   the barcode sees the empty form only. The result, the uploaded paper copy and the PDF copy need the private code.
   COLLECTION VOUCHER: money collected, recorded month by month, with the receipt picture; the empty paper around the
   receipt is cut off before it is saved. The EO-Office page opens with a mini dashboard of both. */
(() => {
  "use strict";
  const E = window.EO;
  const { sb, S, esc, peso, isoToday, mdy, $, $$, isAdmin, pill, toast, fail, ic, busy, num } = E;
  const V = window.EO_VIEWS;
  const meId = () => S.session?.user?.id;
  const canW = () => E.canWrite("eooffice");
  const notSet = (e) => /qc_tests|collection_vouchers|create_qc|save_collection|qc_open|schema cache/i.test(e?.message || "");
  const needUpdate = `<div class="empty">EO-Office needs the database update <b>024_eo_office.sql</b>. Run it in the Supabase SQL Editor.</div>`;
  const monthOf = (d) => String(d || "").slice(0, 7);
  const monthName = (m) => new Date(m + "-01T00:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" }).toUpperCase();
  const monthShort = (m) => new Date(m + "-01T00:00:00").toLocaleDateString("en-US", { month: "short" }).toUpperCase();
  const thisMonth = () => isoToday().slice(0, 7);
  const prevMonth = (m, n = 1) => { const d = new Date(m + "-01T00:00:00"); d.setMonth(d.getMonth() - n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
  const short = (n) => { n = num(n); return n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K" : String(Math.round(n)); };
  const rand = () => Math.random().toString(36).slice(2, 8);
  const METHODS = { cash: "Cash", bank: "Bank Transfer / Deposit", gcash: "GCash / Online", check: "Check", other: "Other" };

  // The 10 problems; each one found takes 10 points off 100. The first two are found when NOT equal.
  const CHECKS = [
    ["colors", "COLORS EQUALLY", "tick when the colors are not equal"], ["sizes", "SIZES EQUALLY", "tick when the sizes are not equal"],
    ["bundle_colors", "UNFULFILLED BUNDLE COLORS", ""], ["wrong_bundle", "WRONG BUNDLE", ""], ["stain", "STAIN", ""],
    ["missing_label", "MISSING LABEL", ""], ["missing_tag", "MISSING TAG", ""], ["mistake_package", "MISTAKE PACKAGE", ""],
    ["mending", "MENDING MORE THAN", ""], ["label_info", "LABEL INFORMATION INCORRECT", ""]];

  // ======================================================================
  // EO-Office page: mini dashboard, QC Test tab, Collection Voucher tab
  // ======================================================================
  // The pages of EO-Office: QC Test and Collection Voucher (this page), Job Applications, Job Positions, Credit Memo and Project
  const eoTabs = (on) => `<nav class="subnav">${[["eooffice", "EO-Office", "eooffice"], ["jobapps", "Job Applications", "employees"], ["positions", "Job Positions", "employees"], ["creditmemos", "Credit Memo", "creditmemos"], ["projects", "Project", "projects"]]
    .filter((x) => E.hasModule(x[2])).map(([k, l]) => `<a href="#${k}" class="${k === on ? "on" : ""}">${l}</a>`).join("")}</nav>`;
  V.eooffice = async (tab, month) => {
    E.shell("eooffice", "EO-Office", `${eoTabs("eooffice")}<div id="eoBody">${busy()}</div>`, "QC Test forms and Collection Vouchers. Job Applications, Job Positions, Credit Memo and Project are here too.");
    if (!E.hasModule("eooffice")) { $("#eoBody").innerHTML = `<div class="empty">Choose Job Applications, Job Positions, Credit Memo or Project above.</div>`; return; }
    const here = E.stillHere();
    const [qc, cv] = await Promise.all([
      sb.from("qc_tests").select("*").order("created_at", { ascending: false }).limit(2000),
      sb.from("collection_vouchers").select("*").order("cv_date", { ascending: false }).order("created_at", { ascending: false }).limit(5000)]);
    if (!here() || !$("#eoBody")) return;
    const bad = qc.error || cv.error;
    if (bad) { $("#eoBody").innerHTML = notSet(bad) ? needUpdate : `<div class="empty">${esc(bad.message)}</div>`; return; }
    const tests = qc.data || [], vouchers = cv.data || [];
    const now = thisMonth(), last = prevMonth(now);
    const sum = (rows) => rows.reduce((s, v) => s + num(v.amount), 0);
    const byMonth = new Map();
    vouchers.forEach((v) => { const m = monthOf(v.cv_date); if (!byMonth.has(m)) byMonth.set(m, []); byMonth.get(m).push(v); });
    const monthRows = [...byMonth.keys()].sort().reverse().map((m) => ({ m, n: byMonth.get(m).length, total: sum(byMonth.get(m)) }));
    const qNow = tests.filter((t) => monthOf(t.created_at) === now), scored = qNow.filter((t) => t.score != null);
    const avgScore = scored.length ? Math.round(scored.reduce((s, t) => s + t.score, 0) / scored.length) : null;
    const six = Array.from({ length: 6 }, (_, i) => prevMonth(now, 5 - i)).map((m) => ({ m, total: sum(byMonth.get(m) || []) }));
    const top = Math.max(1, ...six.map((x) => x.total));
    const t = tab || "qc";
    $("#eoBody").innerHTML = `
      <div class="eo-mini">
        <div class="tiles">
          <div class="tile"><span class="tile-ic">${ic("shield")}</span><div class="k">QC Tests This Month</div><div class="v">${qNow.length}</div><small>${avgScore == null ? "No result yet" : `Average score ${avgScore} / 100`}</small></div>
          <div class="tile"><span class="tile-ic">${ic("wallet")}</span><div class="k">Collection This Month (₱)</div><div class="v">${peso(sum(byMonth.get(now) || []))}</div><small>${(byMonth.get(now) || []).length} voucher(s)</small></div>
          <div class="tile"><span class="tile-ic">${ic("wallet")}</span><div class="k">Collection Last Month (₱)</div><div class="v">${peso(sum(byMonth.get(last) || []))}</div><small>${monthName(last)}</small></div>
        </div>
        <div class="eo-bars" aria-label="Collection by month">${six.map((x) => `<button type="button" class="eo-bar${x.m === now ? " now" : ""}" data-m="${x.m}" title="${esc(monthName(x.m))}: ₱ ${peso(x.total)}">
          <span class="eo-fill" style="height:${Math.max(3, Math.round((x.total / top) * 100))}%"></span><small>₱ ${short(x.total)}</small><b>${monthShort(x.m)}</b></button>`).join("")}</div>
      </div>
      <div class="tabs" id="eoTabs"><button type="button" data-t="qc" class="${t === "qc" ? "on" : ""}">QC Test</button><button type="button" data-t="cv" class="${t === "cv" ? "on" : ""}">Collection Voucher</button></div>
      <div id="eoTab"></div>`;
    const qcCols = [{ label: "QC No", get: (r) => r.qc_no }, { label: "Date", get: (r) => mdy(r.created_at.slice(0, 10)) }, { label: "Serial No", get: (r) => r.serial_no || "" },
      { label: "Item", get: (r) => r.item }, { label: "Brand", get: (r) => r.brand || "" }, { label: "Batch", get: (r) => r.batch || "" }, { label: "CTN", get: (r) => r.ctn || "" },
      { label: "Score", num: true, get: (r) => (r.score == null ? "—" : `${r.score} / 100`) }, { label: "Status", html: (r) => pill(r.status === "done" ? "approved" : "pending", r.status === "done" ? "TESTED" : "LOCKED · NOT TESTED") }];
    const cvCols = [{ label: "Voucher No", get: (r) => r.cv_no }, { label: "Date", get: (r) => mdy(r.cv_date) }, { label: "Received From", get: (r) => r.received_from },
      { label: "Method", get: (r) => METHODS[r.method] || r.method }, { label: "Amount (₱)", num: true, get: (r) => peso(r.amount) },
      { label: "Receipt", html: (r) => (r.receipt_path ? pill("approved", "ON FILE") : pill("pending", "NO RECEIPT")) }, { label: "Made By", get: (r) => r.created_by_name || "" }];
    const show = (k, m) => {
      $$("#eoTabs button").forEach((b) => b.classList.toggle("on", b.dataset.t === k));
      const box = $("#eoTab");
      if (k === "qc") {
        box.innerHTML = `${canW() ? `<div class="btnrow"><a class="btn primary" href="#newqc">${ic("plus")} New QC Test</a></div>` : ""}
          <p class="muted" style="margin:4px 0 8px">Every problem found takes 10 points off 100. Scan the barcode of a form to open it; the result and the paper copy need its private code.</p>
          ${E.grid({ cols: qcCols, rows: tests, onRow: true, empty: "No QC tests yet." })}`;
        E.bindGrid(box, tests, (r) => (location.hash = "qc/" + r.id));
        return;
      }
      if (m) {
        const rs = byMonth.get(m) || [];
        box.innerHTML = `<div class="btnrow"><button type="button" class="btn small" id="cvBack">${ic("back")} All months</button><b class="po-mh">${esc(monthName(m))}</b>
          <button type="button" class="btn small" id="cvPrintM">${ic("print")} PDF</button></div>
          ${E.grid({ cols: cvCols, rows: rs, onRow: true, empty: "No collection this month." })}
          <div class="lp-sum"><span>Vouchers</span><b>${rs.length}</b><span>Total collected</span><b>₱ ${peso(sum(rs))}</b></div>`;
        E.bindGrid(box, rs, (r) => (location.hash = "collection/" + r.id));
        $("#cvBack").onclick = () => show("cv");
        $("#cvPrintM").onclick = () => E.openPreview(`Collection ${monthName(m)}`, monthPages(m, rs));
        return;
      }
      box.innerHTML = `${canW() ? `<div class="btnrow"><a class="btn primary" href="#newcollection">${ic("plus")} New Collection Voucher</a></div>` : ""}
        ${E.grid({ cols: [{ label: "Month", get: (r) => monthName(r.m) }, { label: "Vouchers", num: true, get: (r) => r.n }, { label: "Total Collected (₱)", num: true, get: (r) => peso(r.total) }],
          rows: monthRows, onRow: true, empty: "No collection recorded yet." })}`;
      E.bindGrid(box, monthRows, (r) => show("cv", r.m));
    };
    $$("#eoTabs button").forEach((b) => (b.onclick = () => show(b.dataset.t)));
    $$(".eo-bar").forEach((b) => (b.onclick = () => show("cv", b.dataset.m)));
    show(t, month);
    E.setRecords(`QC tests: ${tests.length} · vouchers: ${vouchers.length}`);
  };

  // ======================================================================
  // QC Test
  // ======================================================================
  V.newqc = () => {
    if (!canW()) { location.hash = "eooffice"; return; }
    E.shell("newqc", "New QC Test", `<form class="window" id="qcForm" novalidate><div class="wtitle">QC Test Form</div><div class="wbody">
      <p class="muted" style="margin-top:0">Write the details of the goods. The form gets a number (QC-${new Date().getFullYear()}-0001, 0002 …) and a PRIVATE CODE that is printed on the blank form. Print the form, test the goods on the paper, then unlock the form with the private code to save the result.</p>
      <fieldset class="opt"><legend>Goods</legend><div class="fields wide">
        <label for="qcSerial">Serial No</label><input type="text" id="qcSerial" maxlength="60">
        <label for="qcItem">Item *</label><input type="text" id="qcItem" maxlength="120" placeholder="e.g. Jeans">
        <label for="qcBrand">Brand</label><input type="text" id="qcBrand" maxlength="80">
        <label for="qcBatch">Batch</label><input type="text" id="qcBatch" maxlength="60">
        <label for="qcCtn">CTN</label><input type="text" id="qcCtn" maxlength="60" placeholder="Carton number"></div></fieldset>
      </div><div class="wfoot"><button type="button" class="btn" id="qcCancel">Cancel</button><button type="submit" class="btn primary">Create QC Form</button></div></form>`);
    $("#qcCancel").onclick = () => history.back();
    $("#qcForm").onsubmit = async (e) => {
      e.preventDefault();
      const item = $("#qcItem").value.trim();
      if (!item) return toast("Write the item.", true);
      E.setBusy(e.target, true, "Creating");
      const { data, error } = await sb.rpc("create_qc", { p_data: { serial_no: $("#qcSerial").value, item, brand: $("#qcBrand").value, batch: $("#qcBatch").value, ctn: $("#qcCtn").value } });
      if (error) { E.setBusy(e.target, false); return fail(error, notSet(error) ? "Run the database update 024_eo_office.sql first" : "Could not create the QC form"); }
      FRESH.set(data.id, data.code);
      location.hash = "qc/" + data.id;
    };
  };

  const FRESH = new Map(); // id -> private code, shown once after the form is made
  const UN = new Map();    // id -> { code, data }: forms unlocked on this screen (forgotten when the person leaves the QC page)
  addEventListener("hashchange", () => { if (!/^#qc\//.test(location.hash)) UN.clear(); });

  const boxTick = (on) => `<span class="qc-box${on ? " on" : ""}"></span>`;
  // The QC form on paper. o.code: the blank form to print (with the private code); o.result: the filled form.
  function qcPage(t, o = {}) {
    const r = o.result, found = r ? CHECKS.filter(([k]) => r.checks?.[k]).length : null;
    const right = `<img src="${E.pdf417DataUrl("EMONQC|" + t.qc_no)}" alt="" class="ph-bar"><div class="mono">${esc(t.qc_no)}</div>`;
    const rows = CHECKS.map(([k, label, hint], i) => `<tr><td>${i + 1}</td><td><b>${esc(label)}</b>${k === "mending" ? ` <span class="qc-line">${r ? esc(r.mending_limit || "") : ""}</span> PCS` : ""}${hint ? `<br><small>(${esc(hint)})</small>` : ""}</td>
      <td class="num">−10</td><td class="qc-tickc">${boxTick(r && r.checks?.[k])}</td></tr>`).join("");
    return `${E.printHead("QC TEST FORM", right)}
      ${E.box("Goods", `<div class="pgrid2">${E.cell("QC No", t.qc_no)}${E.cell("Date", mdy(t.created_at.slice(0, 10)))}${E.cell("Serial No", t.serial_no || "")}${E.cell("Item", t.item)}
        ${E.cell("Brand", t.brand || "")}${E.cell("Batch", t.batch || "")}${E.cell("CTN", t.ctn || "")}${E.cell("Form Made By", t.created_by_name || "")}</div>`)}
      ${E.box("Quality Check — each problem found takes 10 points off 100", `<table class="ptl qc-ptl"><thead><tr><th>#</th><th>Check</th><th class="num">Points</th><th class="qc-tickc">Problem Found</th></tr></thead><tbody>${rows}</tbody></table>`)}
      ${E.box("Result", `<div class="pgrid2">${E.cell("Problems Found", r ? String(found) : "")}${E.cell("Points Taken Off (10 each)", r ? String(found * 10) : "")}
        ${E.cell("Score (100 − points taken off)", r ? `${100 - found * 10} / 100` : "          / 100", "hl")}${E.cell("Tested By / Date", r ? `${t.tested_by_name || ""} · ${t.tested_at ? mdy(t.tested_at.slice(0, 10)) : ""}` : "")}</div>
        <div class="pcell"><div class="pl">Remarks</div><div class="pv qc-rem">${r ? esc(r.remarks || "") || "&nbsp;" : "&nbsp;<br>&nbsp;"}</div></div>`)}
      ${o.code ? E.box("Private Code — keep this page private", `<div class="qc-codebox"><div><div class="qc-code">${esc(o.code)}</div>
          <p class="pdecl">To open this form on the portal: scan the barcode at the top, then scan the QR code beside this text or type the private code. Without the private code the form stays locked and only the empty form can be seen.
          The server keeps only a scrambled copy of the code.</p></div><img src="${E.qrDataUrl("EMONQCK|" + t.qc_no + "|" + o.code)}" alt="Private code QR" class="qc-qr"></div>`) : ""}
      ${E.sigs("Tested by", "Checked by")}`;
  }

  // The result as read from the server; the paper copy is added with the private code.
  async function tryOpen(t, code) {
    const { data, error } = await sb.rpc("qc_open", { p_id: t.id, p_code: code });
    if (error) { fail(error, "Could not open the form"); return { ok: false, state: "error" }; }
    if (data.ok) UN.set(t.id, { code, data });
    return data;
  }
  const badMsg = (d) => d.state === "locked" ? "Too many wrong codes. This form is locked. Ask the Director for a new private code." : d.state === "wrong" ? `That private code is wrong. ${d.left} ${d.left === 1 ? "try" : "tries"} left.` : "Could not open the form.";

  V.qc = async (id) => {
    E.shell("qc", "QC Test", busy());
    const here = E.stillHere();
    const { data: t, error } = await sb.from("qc_tests").select("*").eq("id", id).maybeSingle();
    if (!here()) return;
    if (error && notSet(error)) { $("#main").innerHTML = needUpdate; return; }
    if (!t) { $("#main").innerHTML = `<div class="empty">QC form not found. <a href="#eooffice">Back to EO-Office</a></div>`; return; }
    let msg = "";
    // a private code scanned from the paper (QR) opens the form at once
    const pend = E.qcPending; E.qcPending = null;
    if (!UN.has(id) && pend && pend.id === id) { const d = await tryOpen(t, pend.code); if (!here()) return; if (!d.ok) msg = badMsg(d); }
    $(".band h1") && ($(".band h1").textContent = `QC Test — ${t.qc_no}`);
    draw(t, UN.get(id), msg);
    if (FRESH.has(id)) { const code = FRESH.get(id); FRESH.delete(id); created(t, code); }
    E.setRecords(`QC test: ${t.qc_no}`);
  };

  // After a form is made (or a new code given): the private code is shown once, with the blank form to print.
  function created(t, code, again = false) {
    const m = E.modal(again ? `New Private Code — ${t.qc_no}` : `QC Form ${t.qc_no} Created`, `
      <p style="margin-top:0">${again ? "The old private code no longer works." : "The form is locked on the server."} Print the blank form now: the private code is printed on it and <b>is not shown again</b>.</p>
      <div class="qc-codebig">${esc(code)}</div>
      <p class="muted">Write it down or print the form, then keep the paper private.</p>`,
      `<button type="button" class="btn" data-x>Close</button><button type="button" class="btn primary" data-pr>${ic("print")} Print Blank Form</button>`);
    $("[data-x]", m.el).onclick = m.close;
    $("[data-pr]", m.el).onclick = () => E.openPreview(`QC Form ${t.qc_no}`, [qcPage(t, { code })]);
  }

  function draw(t, open, msg = "") {
    const mine = t.created_by === meId();
    const scoreLine = t.score != null ? `<span>Score <b>${t.score} / 100</b> · tested by ${esc(t.tested_by_name || "")} on ${esc(mdy((t.tested_at || "").slice(0, 10)))}</span>` : `<span>Not tested yet</span>`;
    const head = `<div class="pgrid2 qc-head">${E.cell("QC No", t.qc_no)}${E.cell("Date", mdy(t.created_at.slice(0, 10)))}${E.cell("Serial No", t.serial_no || "")}${E.cell("Item", t.item)}
      ${E.cell("Brand", t.brand || "")}${E.cell("Batch", t.batch || "")}${E.cell("CTN", t.ctn || "")}${E.cell("Form Made By", t.created_by_name || "")}</div>`;
    const code = (isAdmin() || (mine && t.status === "locked")) ? `<button type="button" class="btn" id="qcNew">${ic("key")} New Private Code</button>` : "";
    const del = isAdmin() ? `<button type="button" class="btn danger" id="qcDel">${ic("trash")} Delete</button>` : "";
    if (!open) {
      $("#main").innerHTML = `<div class="window"><div class="wtitle">${esc(t.qc_no)} · ${esc(t.item)} ${pill(t.status === "done" ? "approved" : "pending", t.status === "done" ? "TESTED" : "NOT TESTED")}</div><div class="wbody">
        <div class="qc-lock">${ic("shield")}<div><b>THIS FORM IS LOCKED</b><span>Only the empty form is shown. Scan the PRIVATE CODE printed on the paper form (or type it) to unlock the result, the paper copy and the PDF.</span></div></div>
        ${head}<div class="qc-sub">${scoreLine}</div>
        <fieldset class="opt"><legend>Quality Check</legend><div class="qc-list locked">${CHECKS.map(([, label], i) => `<div class="qc-row"><span class="qc-n">${i + 1}</span><b>${esc(label)}</b><span class="qc-pts">−10</span>${boxTick(false)}</div>`).join("")}</div></fieldset>
        <fieldset class="opt"><legend>Unlock with the Private Code</legend>
          <div class="qc-unlock"><input type="text" id="qcCode" maxlength="20" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX" aria-label="Private code">
            <button type="button" class="btn primary" id="qcGo">${ic("key")} Unlock</button><button type="button" class="btn" id="qcScan">${ic("scan")} Scan Private Code</button></div>
          <div class="qc-msg" id="qcMsg" role="status">${esc(msg)}</div></fieldset>
      </div><div class="wfoot">${code}${del}<a class="btn" href="#eooffice">Close</a></div></div>`;
      const go = async (c) => {
        if (!String(c).trim()) return toast("Write or scan the private code.", true);
        $("#qcGo").disabled = true;
        const d = await tryOpen(t, c);
        if (d.ok) { toast("Unlocked."); return draw(t, UN.get(t.id)); }
        if ($("#qcGo")) { $("#qcGo").disabled = false; $("#qcMsg").textContent = badMsg(d); }
      };
      $("#qcGo").onclick = () => go($("#qcCode").value);
      $("#qcCode").onkeydown = (e) => { if (e.key === "Enter") go($("#qcCode").value); };
      $("#qcScan").onclick = () => E.scanDialog((text) => {
        const m = /^EMONQCK\|([^|]+)\|(.+)$/i.exec(String(text).trim());
        if (m && m[1].toUpperCase() !== t.qc_no) return toast("That private code belongs to another form.", true);
        const c = m ? m[2] : String(text).trim();
        $("#qcCode").value = c; go(c);
      }, { title: "Scan the Private Code", hint: "Point the camera at the QR code in the Private Code box of the paper form." });
      bindActions(t);
      return;
    }
    const { code: pc, data } = open;
    const checks = { ...(data.checks || {}) };
    const docs = [...(data.docs || [])];
    $("#main").innerHTML = `<div class="window"><div class="wtitle">${esc(t.qc_no)} · ${esc(t.item)} ${pill("active", "UNLOCKED")}</div><div class="wbody">
      ${head}
      <fieldset class="opt"><legend>Quality Check — tick a row when the problem is found (−10 points)</legend><div class="qc-list" id="qcList">${CHECKS.map(([k, label, hint], i) => `<label class="qc-row"><span class="qc-n">${i + 1}</span>
        <span class="qc-t"><b>${esc(label)}</b>${k === "mending" ? ` <input type="text" id="qcMend" class="qc-mend" maxlength="20" inputmode="numeric" value="${esc(data.mending_limit || "")}" placeholder="__" aria-label="Mending more than how many pieces"> PCS` : ""}${hint ? `<small>${esc(hint)}</small>` : ""}</span>
        <span class="qc-pts">−10</span><input type="checkbox" data-k="${k}" ${checks[k] ? "checked" : ""}></label>`).join("")}</div>
        <div class="qc-score" id="qcScore"></div></fieldset>
      <fieldset class="opt"><legend>Remarks</legend><textarea id="qcRem" rows="3" maxlength="1000">${esc(data.remarks || "")}</textarea></fieldset>
      <fieldset class="opt"><legend>Paper Copy of the Filled Form</legend>
        <p class="muted" style="margin-top:0">Upload the filled paper (a photo or a scan, up to 6). The pictures are kept private: only the form logo is shown; press it to open.</p>
        <div class="qc-docs" id="qcDocs"></div>
        <div class="btnrow"><label class="btn primary" for="qcUp" id="qcUpL">${ic("upload")} Upload Paper Copy</label><input type="file" id="qcUp" hidden multiple accept="image/*,application/pdf" data-save-now></div></fieldset>
    </div><div class="wfoot"><button type="button" class="btn primary" id="qcSave">${ic("check")} Save Result</button><button type="button" class="btn" id="qcPdf">${ic("print")} PDF Copy</button>
      <button type="button" class="btn" id="qcLock">${ic("shield")} Lock Again</button>${code}${del}<a class="btn" href="#eooffice">Close</a></div></div>`;
    const score = () => {
      const n = $$("#qcList input[data-k]").filter((i) => i.checked).length;
      $("#qcScore").innerHTML = `<span>Problems found <b>${n}</b></span><span>Points taken off <b>${n * 10}</b></span><span class="qc-big">SCORE <b>${100 - n * 10}</b> / 100</span>`;
    };
    $$("#qcList input[data-k]").forEach((i) => (i.onchange = score));
    score();
    const read = () => { const c = {}; $$("#qcList input[data-k]").forEach((i) => { c[i.dataset.k] = i.checked; }); return { checks: c, mending_limit: $("#qcMend").value.trim(), remarks: $("#qcRem").value.trim() }; };
    const relock = (d) => { UN.delete(t.id); draw(t, null, badMsg(d)); };
    $("#qcSave").onclick = async (e) => {
      e.target.disabled = true;
      const { data: d, error } = await sb.rpc("qc_save", { p_id: t.id, p_code: pc, p_data: read() });
      e.target.disabled = false;
      if (error) return fail(error, "Could not save the result");
      if (!d.ok) return relock(d);
      toast(`Result saved: ${d.score} / 100.`);
      Object.assign(data, read());
      t.status = "done"; t.score = d.score; t.found_count = d.found_count; t.tested_at = new Date().toISOString(); t.tested_by_name = S.profile?.full_name || "";
      draw(t, UN.get(t.id));
    };
    $("#qcPdf").onclick = () => E.openPreview(`QC Test ${t.qc_no}`, [qcPage(t, { result: { ...read(), checks: read().checks } })]);
    $("#qcLock").onclick = () => { UN.delete(t.id); draw(t, null); };
    // paper copies: only the form logo is shown, press to open
    const paintDocs = () => {
      $("#qcDocs").innerHTML = docs.length ? docs.map((p, i) => `<div class="qc-doc"><button type="button" class="qc-doc-open" data-i="${i}" aria-label="Open the paper copy ${i + 1}">${E.logoHtml("qc-doc-logo")}
          <b>QC FORM</b><small>Press to open${docs.length > 1 ? ` · ${i + 1}` : ""}</small></button><button type="button" class="qc-doc-rm" data-r="${i}" aria-label="Remove">${ic("trash")}</button></div>`).join("")
        : `<div class="empty small">No paper copy uploaded.</div>`;
      $("#qcUpL").hidden = docs.length >= 6;
      $$("#qcDocs .qc-doc-open").forEach((b) => (b.onclick = () => E.viewFile({ storage_path: docs[Number(b.dataset.i)], mime: "", file_name: `${t.qc_no} QC Form` })));
      $$("#qcDocs .qc-doc-rm").forEach((b) => (b.onclick = async () => {
        if (!(await E.confirmBox(`Remove this paper copy of <b>${esc(t.qc_no)}</b>? You can upload it again.`, { ok: "Remove", danger: true }))) return;
        const keep = docs.filter((_, i) => i !== Number(b.dataset.r));
        const { data: d, error } = await sb.rpc("qc_set_docs", { p_id: t.id, p_code: pc, p_docs: keep });
        if (error) return fail(error, "Could not remove the file");
        if (!d.ok) return relock(d);
        docs.splice(0, docs.length, ...keep);
        if (d.removed?.length) sb.storage.from("records").remove(d.removed).then(() => {}, () => {});
        paintDocs();
      }));
    };
    paintDocs();
    $("#qcUp").onchange = async (e) => {
      const picked = Array.from(e.target.files).slice(0, 6 - docs.length); e.target.value = "";
      if (!picked.length) return;
      const lab = $("#qcUpL"); lab.classList.add("disabled");
      const added = [];
      for (const raw of picked) {
        if (raw.size > 25 * 1024 * 1024) { toast(`${raw.name} is larger than 25 MB and was skipped.`, true); continue; }
        const f = await E.slimFile(raw);
        const path = `qc/${t.id}/doc_${Date.now()}_${rand()}.${E.extOf(f)}`;
        const up = await sb.storage.from("records").upload(path, f, { contentType: f.type || "application/octet-stream" });
        if (up.error) { toast("A file could not be uploaded: " + up.error.message, true); continue; }
        added.push(path);
      }
      lab.classList.remove("disabled");
      if (!added.length) return;
      const { data: d, error } = await sb.rpc("qc_set_docs", { p_id: t.id, p_code: pc, p_docs: [...docs, ...added] });
      if (error || !d.ok) { sb.storage.from("records").remove(added).then(() => {}, () => {}); return error ? fail(error, "Could not save the paper copy") : relock(d); }
      docs.push(...added);
      toast("Paper copy saved. It is kept private.");
      paintDocs();
    };
    bindActions(t);
  }

  function bindActions(t) {
    if ($("#qcNew")) $("#qcNew").onclick = async () => {
      if (!(await E.confirmBox(`Give <b>${esc(t.qc_no)}</b> a new private code? The old code stops working.`, { ok: "New Code" }))) return;
      const { data: code, error } = await sb.rpc("qc_new_code", { p_id: t.id });
      if (error) return fail(error, "Could not give a new code");
      UN.delete(t.id);
      created(t, code, true);
    };
    if ($("#qcDel")) $("#qcDel").onclick = async () => {
      if (!(await E.confirmBox(`Delete QC form <b>${esc(t.qc_no)}</b> with its result and paper copies? This cannot be undone.`, { ok: "Delete", danger: true }))) return;
      const { data: gone, error } = await sb.rpc("delete_qc", { p_id: t.id });
      if (error) return fail(error, "Could not delete");
      if (gone?.length) sb.storage.from("records").remove(gone).then(() => {}, () => {});
      UN.delete(t.id); toast("Deleted."); location.hash = "eooffice";
    };
  }

  // ======================================================================
  // Collection Voucher
  // ======================================================================
  // The receipt picture with its empty area cut off: the paper is found (a dark table around it is cut), then the blank
  // paper above, below and at the sides of the writing. Gives the picture as it was when nothing can be cut.
  async function cutEmpty(file) {
    if (!file || !/^image\/(jpeg|png|webp|bmp)$/i.test(file.type || "")) return file;
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
      const W = img.naturalWidth, H = img.naturalHeight;
      if (!W || !H) return file;
      const k = Math.min(1, 900 / Math.max(W, H)), w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k));
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      const g = cv.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0, w, h);
      const px = g.getImageData(0, 0, w, h).data, lum = new Uint8Array(w * h), hist = new Uint32Array(256);
      for (let i = 0; i < w * h; i++) { const v = (px[i * 4] * 299 + px[i * 4 + 1] * 587 + px[i * 4 + 2] * 114) / 1000 | 0; lum[i] = v; hist[v]++; }
      let acc = 0, paper = 255; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= w * h * 0.85) { paper = v; break; } }
      if (paper < 120) return file; // a dark picture: nothing to cut
      const rowCov = (mask, x0, x1, y) => { let n = 0; for (let x = x0; x <= x1; x++) if (mask(lum[y * w + x])) n++; return n / (x1 - x0 + 1); };
      const colCov = (mask, y0, y1, x) => { let n = 0; for (let y = y0; y <= y1; y++) if (mask(lum[y * w + x])) n++; return n / (y1 - y0 + 1); };
      // 1. the paper: bright rows and columns (a dark table around it is cut)
      const bright = (v) => v >= paper - 45;
      let y0 = 0, y1 = h - 1, x0 = 0, x1 = w - 1;
      while (y0 < y1 && rowCov(bright, 0, w - 1, y0) < 0.35) y0++;
      while (y1 > y0 && rowCov(bright, 0, w - 1, y1) < 0.35) y1--;
      while (x0 < x1 && colCov(bright, y0, y1, x0) < 0.35) x0++;
      while (x1 > x0 && colCov(bright, y0, y1, x1) < 0.35) x1--;
      // 2. the writing: dark rows and columns inside the paper; the blank paper around it is cut
      const ink = (v) => v < paper - 40;
      const minI = (len) => Math.max(2 / len, 0.004);
      let a = y0, b = y1, c = x0, d = x1;
      while (a < b && rowCov(ink, x0, x1, a) < minI(x1 - x0 + 1)) a++;
      while (b > a && rowCov(ink, x0, x1, b) < minI(x1 - x0 + 1)) b--;
      while (c < d && colCov(ink, a, b, c) < minI(b - a + 1)) c++;
      while (d > c && colCov(ink, a, b, d) < minI(b - a + 1)) d--;
      if (b - a < h * 0.04 || d - c < w * 0.04) { a = y0; b = y1; c = x0; d = x1; } // no writing found: keep the paper
      const padY = Math.round((b - a) * 0.03) + 6, padX = Math.round((d - c) * 0.03) + 6;
      a = Math.max(y0, a - padY); b = Math.min(y1, b + padY); c = Math.max(x0, c - padX); d = Math.min(x1, d + padX);
      if ((d - c + 1) * (b - a + 1) > w * h * 0.97) return file; // nothing worth cutting
      const out = document.createElement("canvas"), sx = W / w, sy = H / h;
      const L = Math.max(1, Math.round((d - c + 1) * sx)), T = Math.max(1, Math.round((b - a + 1) * sy));
      out.width = L; out.height = T;
      out.getContext("2d").drawImage(img, Math.round(c * sx), Math.round(a * sy), L, T, 0, 0, L, T);
      const blob = await new Promise((ok) => out.toBlob(ok, "image/jpeg", 0.92));
      return blob ? new File([blob], (file.name || "Receipt").replace(/\.[^.]*$/, "") + ".jpg", { type: "image/jpeg", lastModified: Date.now() }) : file;
    } catch (_) { return file; } finally { URL.revokeObjectURL(url); }
  }

  V.newcollection = () => cvForm(null);
  V.editcollection = async (id) => {
    E.shell("editcollection", "Edit Collection Voucher", busy());
    const { data: v } = await sb.from("collection_vouchers").select("*").eq("id", id).maybeSingle();
    if (!v) { $("#main").innerHTML = `<div class="empty">Collection voucher not found.</div>`; return; }
    cvForm(v);
  };
  const canChange = (v) => isAdmin() || (v.created_by === meId() && Date.now() - new Date(v.created_at).getTime() < 864e5);

  async function cvForm(v) {
    if (!canW()) { location.hash = "eooffice"; return; }
    E.shell(v ? "editcollection" : "newcollection", v ? `Edit ${v.cv_no}` : "New Collection Voucher", `
      <form class="window" id="cvForm" novalidate><div class="wtitle">${v ? `Collection Voucher ${esc(v.cv_no)}` : "Collection Voucher"}</div><div class="wbody">
        <fieldset class="opt"><legend>Collection</legend><div class="fields wide">
          <label for="cvDate">Date</label><input type="date" id="cvDate" value="${esc(v?.cv_date || isoToday())}">
          <label for="cvFrom">Received From *</label><input type="text" id="cvFrom" maxlength="120" value="${esc(v?.received_from || "")}" placeholder="Name of the customer or person">
          <label for="cvAmt">Amount Collected (₱) *</label><input type="number" id="cvAmt" min="0" step="0.01" inputmode="decimal" value="${v ? num(v.amount) : ""}">
          <label for="cvMethod">Method</label><select id="cvMethod">${Object.entries(METHODS).map(([k, l]) => `<option value="${k}" ${v?.method === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
          <label for="cvRef">Reference No</label><input type="text" id="cvRef" maxlength="60" value="${esc(v?.reference_no || "")}">
          <label for="cvNote">Note</label><input type="text" id="cvNote" maxlength="300" value="${esc(v?.note || "")}"></div></fieldset>
        <fieldset class="opt"><legend>Receipt Picture</legend>
          <p class="muted" style="margin-top:0">Take or choose a picture of the receipt. The empty area around it is cut off and the paper is made clear before it is saved.</p>
          <div class="cv-prev" id="cvPrev"></div>
          <div class="btnrow"><label class="btn primary" for="cvFile">${ic("camera")} ${v?.receipt_path ? "Change Receipt" : "Add Receipt"}</label><input type="file" id="cvFile" hidden accept="image/*,application/pdf">
            <label class="chk" id="cvWholeL" hidden><input type="checkbox" id="cvWhole"> Keep the whole picture (do not cut)</label></div></fieldset>
      </div><div class="wfoot"><button type="button" class="btn" id="cvCancel">Cancel</button><button type="submit" class="btn primary">${v ? "Save" : "Save Collection Voucher"}</button></div></form>`);
    if (v && !canChange(v)) { toast("Only the Director can change this voucher now.", true); location.hash = "collection/" + v.id; return; }
    let orig = null, ready = null; // the picture chosen, and the cleaned copy to save
    const oldUrl = v?.receipt_path ? (await E.signedMap([v.receipt_path])).get(v.receipt_path) : "";
    const paint = (src, note = "") => { $("#cvPrev").innerHTML = src ? `<img src="${esc(src)}" alt="Receipt">${note ? `<small>${esc(note)}</small>` : ""}` : ""; };
    paint(oldUrl, oldUrl ? "Receipt on file" : "");
    const prepare = async () => {
      if (!orig) return;
      $("#cvPrev").innerHTML = busy("Cleaning the picture");
      const f = $("#cvWhole").checked ? orig : await cutEmpty(orig);
      ready = await E.slimFile(f, "doc");
      paint(URL.createObjectURL(ready), ready === orig || ready.size === orig.size && $("#cvWhole").checked ? "Whole picture" : "The empty area was cut off. This is the picture that will be saved.");
    };
    $("#cvFile").onchange = async (e) => {
      const f = e.target.files[0]; e.target.value = "";
      if (!f) return;
      orig = f; $("#cvWholeL").hidden = !/^image\//.test(f.type);
      if (!/^image\//.test(f.type)) { ready = f; paint("", ""); $("#cvPrev").innerHTML = `<div class="empty small">${esc(f.name)}</div>`; return; }
      await prepare();
    };
    $("#cvWhole").onchange = prepare;
    $("#cvCancel").onclick = () => history.back();
    $("#cvForm").onsubmit = async (e) => {
      e.preventDefault();
      const from = $("#cvFrom").value.trim(), amt = num($("#cvAmt").value);
      if (!from) return toast("Write who the money was collected from.", true);
      if (!(amt > 0)) return toast("Write the amount collected.", true);
      E.setBusy(e.target, true, "Saving");
      const { data: row, error } = await sb.rpc("save_collection", { p_id: v?.id || null, p_data: { cv_date: $("#cvDate").value || null, received_from: from, amount: amt,
        method: $("#cvMethod").value, reference_no: $("#cvRef").value, note: $("#cvNote").value } });
      if (error) { E.setBusy(e.target, false); return fail(error, notSet(error) ? "Run the database update 024_eo_office.sql first" : "Could not save the voucher"); }
      if (ready) {
        const path = `collection/${row.id}/receipt_${Date.now()}_${rand()}.${E.extOf(ready)}`;
        const up = await sb.storage.from("records").upload(path, ready, { contentType: ready.type || "image/jpeg" });
        if (up.error) toast("The receipt could not be uploaded: " + up.error.message, true);
        else {
          const r = await sb.rpc("set_collection_receipt", { p_id: row.id, p_path: path });
          if (r.error) { toast("The receipt could not be saved: " + r.error.message, true); sb.storage.from("records").remove([path]).then(() => {}, () => {}); }
          else if (r.data) sb.storage.from("records").remove([r.data]).then(() => {}, () => {});
        }
      }
      toast(v ? "Saved." : `Collection voucher ${row.cv_no} saved.`);
      location.hash = "collection/" + row.id;
    };
  }

  V.collection = async (id) => {
    E.shell("collection", "Collection Voucher", busy());
    const here = E.stillHere();
    const { data: v, error } = await sb.from("collection_vouchers").select("*").eq("id", id).maybeSingle();
    if (!here()) return;
    if (error && notSet(error)) { $("#main").innerHTML = needUpdate; return; }
    if (!v) { $("#main").innerHTML = `<div class="empty">Collection voucher not found. <a href="#eooffice/cv">Back to EO-Office</a></div>`; return; }
    const url = v.receipt_path ? (await E.signedMap([v.receipt_path])).get(v.receipt_path) || "" : "";
    if (!here()) return;
    const isPdf = /\.pdf$/i.test(v.receipt_path || "");
    $(".band h1") && ($(".band h1").textContent = `Collection Voucher — ${v.cv_no}`);
    $("#main").innerHTML = `<div class="window"><div class="wtitle">${esc(v.cv_no)} · ₱ ${peso(v.amount)}</div><div class="wbody">
      <div class="pgrid2 qc-head">${E.cell("Voucher No", v.cv_no)}${E.cell("Date", mdy(v.cv_date))}${E.cell("Received From", v.received_from)}${E.cell("Amount (₱)", peso(v.amount), "hl")}
        ${E.cell("Method", METHODS[v.method] || v.method)}${E.cell("Reference No", v.reference_no || "")}${E.cell("Note", v.note || "")}${E.cell("Recorded By", v.created_by_name || "")}</div>
      <p class="muted">${esc(E.words(v.amount, "PESOS"))}</p>
      <fieldset class="opt"><legend>Receipt</legend>${url ? (isPdf ? `<button type="button" class="btn" id="cvOpen">${ic("eye")} Open the Receipt (PDF)</button>`
        : `<button type="button" class="cv-receipt" id="cvOpen" aria-label="Open the receipt"><img src="${esc(url)}" alt="Receipt"></button>`) : `<div class="empty small">No receipt picture.</div>`}</fieldset>
    </div><div class="wfoot"><button type="button" class="btn primary" id="cvPdf">${ic("print")} PDF</button>
      ${canW() && canChange(v) ? `<a class="btn" href="#editcollection/${v.id}">${ic("edit")} Edit</a>` : ""}${isAdmin() ? `<button type="button" class="btn danger" id="cvDel">${ic("trash")} Delete</button>` : ""}
      <a class="btn" href="#eooffice/cv">Close</a></div></div>`;
    if ($("#cvOpen")) $("#cvOpen").onclick = () => E.viewFile({ storage_path: v.receipt_path, mime: isPdf ? "application/pdf" : "image/jpeg", file_name: `${v.cv_no} Receipt` });
    $("#cvPdf").onclick = () => E.openPreview(`Collection Voucher ${v.cv_no}`, [cvPage(v, isPdf ? "" : url)]);
    if ($("#cvDel")) $("#cvDel").onclick = async () => {
      if (!(await E.confirmBox(`Delete collection voucher <b>${esc(v.cv_no)}</b> (₱ ${peso(v.amount)} from ${esc(v.received_from)})? This cannot be undone.`, { ok: "Delete", danger: true }))) return;
      const { data: gone, error: e2 } = await sb.rpc("delete_collection", { p_id: v.id });
      if (e2) return fail(e2, "Could not delete");
      if (gone) sb.storage.from("records").remove([gone]).then(() => {}, () => {});
      toast("Deleted."); location.hash = "eooffice/cv";
    };
    E.setRecords(`Collection voucher: ${v.cv_no}`);
  };

  function cvPage(v, pic) {
    return `${E.printHead("COLLECTION VOUCHER", `<img src="${E.pdf417DataUrl("EMONCV|" + v.cv_no)}" alt="" class="ph-bar"><div class="mono">${esc(v.cv_no)}</div>`)}
      ${E.box("Collection", `<div class="pgrid2">${E.cell("Voucher No", v.cv_no)}${E.cell("Date", mdy(v.cv_date))}${E.cell("Received From", v.received_from)}${E.cell("Amount Collected (₱)", peso(v.amount), "hl")}
        ${E.cell("Method", METHODS[v.method] || v.method)}${E.cell("Reference No", v.reference_no || "")}${E.cell("Recorded By", v.created_by_name || "")}${E.cell("Note", v.note || "")}</div>
        <div class="pcell"><div class="pl">Amount in Words</div><div class="pv">${esc(E.words(v.amount, "PESOS"))}</div></div>`)}
      ${pic ? E.box("Receipt", `<div class="cv-print"><img src="${esc(pic)}" alt="Receipt"></div>`) : ""}
      ${E.sigs("Collected by", "Received by")}`;
  }

  // The month's vouchers as a PDF, split over pages when the list is long.
  function monthPages(m, rs) {
    const sorted = [...rs].sort((a, b) => String(a.cv_date).localeCompare(String(b.cv_date)) || String(a.cv_no).localeCompare(String(b.cv_no)));
    const total = sorted.reduce((s, v) => s + num(v.amount), 0);
    return E.pagedDoc({
      head: E.printHead("MONTHLY COLLECTION", `<div class="sb-no"><small>Month</small><b>${esc(monthName(m))}</b></div>`), contHead: E.printHead(`MONTHLY COLLECTION ${monthName(m)} (CONTINUED)`, ""),
      top: "", boxTitle: `Collection Vouchers — ${monthName(m)}`,
      thead: `<tr><th>#</th><th>Voucher No</th><th>Date</th><th>Received From</th><th>Method</th><th class="num">Amount (₱)</th></tr>`,
      rows: sorted, rowHtml: (v, i) => `<tr><td>${i + 1}</td><td>${esc(v.cv_no)}</td><td>${esc(mdy(v.cv_date))}</td><td>${esc(v.received_from)}</td><td>${esc(METHODS[v.method] || v.method)}</td><td class="num">${peso(v.amount)}</td></tr>`,
      totalRow: `<tr class="ptl-tot"><td colspan="5">TOTAL COLLECTED · ${sorted.length} VOUCHER(S)</td><td class="num">${peso(total)}</td></tr>`,
      bottom: `<p class="pdecl">${esc(E.words(total, "PESOS"))}</p>${E.sigs("Prepared by", "Checked by")}`,
      caps: { single: 22, first: 26, next: 32, last: 16 } });
  }

  Object.assign(E, { cutEmpty, eoTabs });
})();
