/* EMON OVERRUNS E-PORTAL — EO-Office (3.1, QC Test made simple in 3.3, Pass / Fail in 3.8, plain stickers in 3.9): QC Test and Collection Voucher.
   QC TEST: a ticket. A new QC test needs no required field; it gets a number QC-YYYY-#### and its blank QC TEST form (a PDF417 barcode, the
   10 checks, the Result box; no stickers on it) opens to print. After the check on paper, open it (scan the barcode or search the number)
   and choose Pass or Fail for each check (a number of pieces for each Fail) and the total score (suggested as 100 minus 10 for each Fail,
   written by the person); a total of 80 passes. Save = submit: the 2 stickers (nothing else on the page) open to print. The page shows
   PASS or FAIL and the scan option for the filled form. No lock and no private code.
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

  // The 10 checks, each one Pass or Fail. A Fail takes 10 points off 100 (the person may write another total).
  const CHECKS = [
    ["colors", "COLORS EQUAL"], ["sizes", "SIZES EQUAL"], ["bundle_colors", "BUNDLE COLORS COMPLETE"], ["wrong_bundle", "BUNDLE CORRECT"], ["stain", "NO STAIN"],
    ["missing_label", "LABEL PRESENT"], ["missing_tag", "TAG PRESENT"], ["mistake_package", "PACKAGE CORRECT"],
    ["mending", "MENDING NOT MORE THAN"], ["label_info", "LABEL INFORMATION CORRECT"]];
  const PASS_MARK = 80; // the requirement to pass the QC test: a total score of 80 or more
  const verdict = (score) => (score == null || score === "" ? "" : Number(score) >= PASS_MARK ? "PASS" : "FAIL");

  // ======================================================================
  // EO-Office page: mini dashboard, QC Test tab, Collection Voucher tab
  // ======================================================================
  // The pages of EO-Office: QC Test and Collection Voucher (this page), Employees and Payroll (3.23), Job Applications, Job Positions, Credit Memo and Project
  const eoTabs = (on) => `<nav class="subnav">${[["eooffice", "EO-Office", "eooffice"], ["employees", "Employees", "employees"], ["payroll", "Payroll", "employees"], ["jobapps", "Job Applications", "employees"], ["positions", "Job Positions", "employees"], ["creditmemos", "Credit Memo", "creditmemos"], ["projects", "Project", "projects"]]
    .filter((x) => E.hasModule(x[2]) && (x[0] !== "eooffice" || E.isStaff())).map(([k, l]) => `<a href="#${k}" class="${k === on ? "on" : ""}">${l}</a>`).join("")}</nav>`;
  V.eooffice = async (tab, month) => {
    E.shell("eooffice", "EO-Office", `${eoTabs("eooffice")}<div id="eoBody">${busy()}</div>`, "QC Test forms and Collection Vouchers. Job Applications, Job Positions, Credit Memo and Project are here too.");
    if (!E.hasModule("eooffice") || !E.isStaff()) { $("#eoBody").innerHTML = `<div class="empty">Choose Job Applications, Job Positions, Credit Memo or Project above.</div>`; return; }
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
    const qNow = tests.filter((t) => monthOf(E.isoDay(new Date(t.created_at))) === now), scored = qNow.filter((t) => t.score != null);
    const passNow = scored.filter((t) => verdict(t.score) === "PASS").length;
    const avgScore = scored.length ? Math.round(scored.reduce((s, t) => s + t.score, 0) / scored.length) : null;
    const six = Array.from({ length: 6 }, (_, i) => prevMonth(now, 5 - i)).map((m) => ({ m, total: sum(byMonth.get(m) || []) }));
    const top = Math.max(1, ...six.map((x) => x.total));
    const t = tab || "qc";
    $("#eoBody").innerHTML = `
      <div class="eo-mini">
        <div class="tiles">
          <div class="tile"><span class="tile-ic">${ic("shield")}</span><div class="k">QC Tests This Month</div><div class="v">${qNow.length}</div><small>${avgScore == null ? "No result yet" : `${passNow} pass · ${scored.length - passNow} fail · average ${avgScore} / 100`}</small></div>
          <div class="tile"><span class="tile-ic">${ic("wallet")}</span><div class="k">Collection This Month (₱)</div><div class="v">${peso(sum(byMonth.get(now) || []))}</div><small>${(byMonth.get(now) || []).length} voucher(s)</small></div>
          <div class="tile"><span class="tile-ic">${ic("wallet")}</span><div class="k">Collection Last Month (₱)</div><div class="v">${peso(sum(byMonth.get(last) || []))}</div><small>${monthName(last)}</small></div>
        </div>
        <div class="eo-bars" aria-label="Collection by month">${six.map((x) => `<button type="button" class="eo-bar${x.m === now ? " now" : ""}" data-m="${x.m}" title="${esc(monthName(x.m))}: ₱ ${peso(x.total)}">
          <span class="eo-fill" style="height:${Math.max(3, Math.round((x.total / top) * 100))}%"></span><small>₱ ${short(x.total)}</small><b>${monthShort(x.m)}</b></button>`).join("")}</div>
      </div>
      <div class="tabs" id="eoTabs"><button type="button" data-t="qc" class="${t === "qc" ? "on" : ""}">QC Test</button><button type="button" data-t="cv" class="${t === "cv" ? "on" : ""}">Collection Voucher</button></div>
      <div id="eoTab"></div>`;
    const qcCols = [{ label: "QC No", get: (r) => r.qc_no }, { label: "Date", get: (r) => mdy(r.created_at) }, { label: "Serial No", get: (r) => r.serial_no || "" },
      { label: "Item", get: (r) => r.item || "" }, { label: "Brand", get: (r) => r.brand || "" }, { label: "Batch", get: (r) => r.batch || "" }, { label: "CTN", get: (r) => r.ctn || "" },
      { label: "Score", num: true, get: (r) => (r.score == null ? "—" : `${r.score} / 100`) },
      { label: "Result", html: (r) => { const v = verdict(r.score); return v ? pill(v === "PASS" ? "approved" : "rejected", v) : ""; } }, { label: "Status", html: (r) => pill(r.status === "done" ? "approved" : "pending", r.status === "done" ? "TESTED" : "NOT TESTED YET") }];
    const cvCols = [{ label: "Voucher No", get: (r) => r.cv_no }, { label: "Date", get: (r) => mdy(r.cv_date) }, { label: "Received From", get: (r) => r.received_from },
      { label: "Method", get: (r) => METHODS[r.method] || r.method }, { label: "Amount (₱)", num: true, get: (r) => peso(r.amount) },
      { label: "Receipt", html: (r) => (r.receipt_path ? pill("approved", "ON FILE") : pill("pending", "NO RECEIPT")) }, { label: "Made By", get: (r) => r.created_by_name || "" }];
    const show = (k, m) => {
      $$("#eoTabs button").forEach((b) => b.classList.toggle("on", b.dataset.t === k));
      const box = $("#eoTab");
      if (k === "qc") {
        box.innerHTML = `${canW() ? `<div class="btnrow"><a class="btn primary" href="#newqc">${ic("plus")} New QC Test</a></div>` : ""}
          <p class="muted" style="margin:4px 0 8px">Print the form, check the goods on the paper, then open it (scan its barcode or search the number) and update the result.</p>
          <div class="qc-find"><input type="search" id="qcFind" placeholder="Search: QC No, serial, item, brand, batch, CTN — or scan the barcode" aria-label="Search QC tests" autocomplete="off">
            <button type="button" class="btn" id="qcScan">${ic("scan")} Scan</button></div>
          <div id="qcGrid"></div>`;
        // a barcode (typed by a scanner, or the QC number) opens that QC test at once; any other words filter the list
        const norm = (q) => { const m = /EMONQCK?\|\s*(QC-\d{4}-\d+)/i.exec(q); return (m ? m[1] : q).trim().toLowerCase(); };
        // the words of each test, made once (the list is filtered on every key)
        const hay = tests.map((r) => [r.qc_no, r.serial_no, r.item, r.brand, r.batch, r.ctn].map((x) => String(x || "").toLowerCase()));
        let shown = tests, lastW = null;
        const paint = () => {
          const w = norm($("#qcFind").value);
          if (w === lastW) return;
          lastW = w;
          shown = w ? tests.filter((r, i) => hay[i].some((x) => x.includes(w))) : tests;
          $("#qcGrid").innerHTML = E.grid({ cols: qcCols, rows: shown, onRow: true, empty: w ? "No QC test matches that." : "No QC tests yet." });
          E.bindGrid($("#qcGrid"), shown, (r) => (location.hash = "qc/" + r.id));
        };
        $("#qcFind").oninput = paint;
        $("#qcFind").onkeydown = (e) => { if (e.key === "Enter" && shown.length === 1) { e.preventDefault(); location.hash = "qc/" + shown[0].id; } };
        $("#qcScan").onclick = () => E.scanDialog((text) => E.openScanned(text));
        paint();
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
  // QC Test — a ticket: make it, print it, check the goods on the paper, then update it here
  // ======================================================================
  V.newqc = () => {
    if (!canW()) { location.hash = "eooffice"; return; }
    E.shell("newqc", "New QC Test", `<form class="window" id="qcForm" novalidate><div class="wtitle">QC Test Form</div><div class="wbody">
      <p class="muted" style="margin-top:0">Write the details of the goods (none is required). The form gets a number (QC-${new Date().getFullYear()}-0001, 0002 …) and a barcode. Print it, check the goods on the paper, then open it again here (scan the barcode or search the number) and update the result.</p>
      <fieldset class="opt"><legend>Goods</legend><div class="fields wide">
        <label for="qcSerial">Serial No</label><input type="text" id="qcSerial" maxlength="60">
        <label for="qcItem">Item</label><input type="text" id="qcItem" maxlength="120" placeholder="e.g. Jeans">
        <label for="qcBrand">Brand</label><input type="text" id="qcBrand" maxlength="80">
        <label for="qcBatch">Batch</label><input type="text" id="qcBatch" maxlength="60">
        <label for="qcCtn">CTN</label><input type="text" id="qcCtn" maxlength="60" placeholder="Carton number"></div></fieldset>
      </div><div class="wfoot"><button type="button" class="btn" id="qcCancel">Cancel</button><button type="submit" class="btn primary">Create and Print Form</button></div></form>`);
    $("#qcCancel").onclick = () => history.back();
    $("#qcForm").onsubmit = async (e) => {
      e.preventDefault();
      E.setBusy(e.target, true, "Creating");
      const { data, error } = await sb.rpc("create_qc", { p_data: { serial_no: $("#qcSerial").value, item: $("#qcItem").value, brand: $("#qcBrand").value, batch: $("#qcBatch").value, ctn: $("#qcCtn").value } });
      if (error) { E.setBusy(e.target, false); return fail(error, notSet(error) ? "Run the database update 025_qc_simple.sql first" : "Could not create the QC form"); }
      FRESH.add(data.id); // the blank form opens for printing
      location.hash = "qc/" + data.id;
    };
  };
  const FRESH = new Set();

  const boxTick = (on) => `<span class="qc-box${on ? " on" : ""}"></span>`;
  const numOf = (r, k) => (r?.numbers?.[k] ?? (k === "mending" ? r?.mending_limit : "") ?? "");
  // One check is "fail" (ticked), "pass" or "" (not checked yet). A saved test has every check decided, so a check that is not a
  // fail is a pass; r.choice (the screen before it is saved) says it directly.
  const choiceOf = (t, r, k) => (r?.choice ? r.choice[k] || "" : r?.checks?.[k] ? "fail" : t.status === "done" ? "pass" : "");
  const tally = (t, r) => {
    let pass = 0, fail = 0, open = 0;
    for (const [k] of CHECKS) { const c = choiceOf(t, r, k); if (c === "fail") fail++; else if (c === "pass") pass++; else open++; }
    const score = t.score != null ? Number(t.score) : open ? null : 100 - 10 * fail;
    return { pass, fail, open, score, verdict: verdict(score) };
  };
  // QTY FOUND (on the sticker only): the pieces written for the Fail checks, added together
  const qtyFound = (t, r) => CHECKS.reduce((n, [k]) => n + (choiceOf(t, r, k) === "fail" ? parseInt(String(r?.numbers?.[k] ?? "").replace(/[^\d]/g, ""), 10) || 0 : 0), 0);
  // What the stickers and the Result box say: once every check is decided (nothing before that)
  const resultOf = (t, r) => {
    const T = r ? tally(t, r) : null;
    return T && !T.open && T.score != null ? { ...T, qty: qtyFound(t, r), when: t.tested_at || new Date().toISOString(), by: t.tested_by_name || S.profile?.full_name || "" } : null;
  };
  // The result sticker: the logo, the barcode with the QC number, the date, the pieces found, the result and who checked it.
  const qcCard = (t, res) => `<div class="qc-card"><div class="qc-card-h">${E.logoHtml("qc-card-logo")}<b>QC TEST RESULT</b></div>
    <div class="qc-card-code"><img src="${E.pdf417DataUrl("EMONQC|" + t.qc_no)}" alt="" class="ph-bar"><div class="mono">${esc(t.qc_no)}</div></div>
    <div class="qc-card-row"><span>Checked Date</span><b>${res ? esc(mdy(res.when)) : ""}</b></div>
    <div class="qc-card-row"><span>Qty Found</span><b>${res ? res.qty : ""}</b></div>
    <div class="qc-card-row"><span>Result</span><b class="qc-res">${res ? `Pass ${res.pass} · Fail ${res.fail}` : ""}</b><b class="qc-verdict${res?.verdict === "FAIL" ? " fail" : ""}">${res ? res.verdict : ""}</b></div>
    <div class="qc-card-row"><span>Check By</span><b>${res ? esc(res.by) : ""}</b></div></div>`;
  // The QC form on paper: blank to write on (the form made when the QC test is created), or with the result.
  function qcPage(t, r = null) {
    const T = r ? tally(t, r) : null, res = resultOf(t, r);
    const right = `<img src="${E.pdf417DataUrl("EMONQC|" + t.qc_no)}" alt="" class="ph-bar"><div class="mono">${esc(t.qc_no)}</div>`;
    const rows = CHECKS.map(([k, label], i) => { const c = r ? choiceOf(t, r, k) : "";
      return `<tr><td class="qx-n">${i + 1}</td><td class="qx-c">${esc(label)}${k === "mending" ? " ___ PCS" : ""}</td>
        <td class="qx-b">${boxTick(c === "pass")}</td><td class="qx-b">${boxTick(c === "fail")}</td><td class="qx-q"><span class="qc-line">${c === "fail" ? esc(String(numOf(r, k))) : ""}</span></td></tr>`; }).join("");
    const sum = (k, v) => `<div class="qx-sum"><small>${esc(k)}</small><b>${v ? esc(v) : "&nbsp;"}</b></div>`;
    // 3.17: certificate style: date · QC no · checks across the top, the goods as "Label : value" lines, the 10 checks with PASS / FAIL / QTY FOUND, the result strip and the signature lines
    return `${E.printHead("QC TEST", right)}
      ${E.cxTop([["Date", mdy(t.created_at)], ["QC No", t.qc_no], ["Checks", "10"]])}
      ${E.cxSec("Goods")}${E.cxKv([["Item", t.item || ""], ["Brand", t.brand || ""], ["Serial No", t.serial_no || ""], ["Batch", t.batch || ""], ["CTN", t.ctn || ""]])}
      <div class="qx-h">QUALITY CHECK <small>Tick PASS or FAIL for each check. For a FAIL write the Qty Found (pieces).</small></div>
      <table class="qx-t"><thead><tr><th class="qx-n">#</th><th class="qx-c">Check</th><th class="qx-b">Pass</th><th class="qx-b">Fail</th><th class="qx-q">Qty Found</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="qx-h">RESULT</div>
      <div class="qx-res">${sum("Total Pass", T && !T.open ? String(T.pass) : "")}${sum("Total Fail", T && !T.open ? String(T.fail) : "")}${sum("Qty Found", res ? String(res.qty) : "")}
        <div class="qx-sum qx-verdict"><small>QC Result</small><span>${boxTick(res?.verdict === "PASS")} PASS</span><span>${boxTick(res?.verdict === "FAIL")} FAIL</span></div></div>
      <p class="qx-need">To PASS the QC test the score must be ${PASS_MARK} or more. Each FAIL takes 10 points off.</p>
      <div class="qx-sign"><div><b>${res ? esc(res.by) : "&nbsp;"}</b><span>Checked By · Signature over Printed Name</span></div><div><b>${res ? esc(mdy(res.when)) : "&nbsp;"}</b><span>Checked Date</span></div></div>`;
  }
  // The 2 stickers on plain paper: nothing else on the page (no heading, no footer, no date).
  const stickerPage = (t, res) => `<div class="qc-cards qc-sticker">${qcCard(t, res)}${qcCard(t, res)}</div>`;
  const openStickers = (t, r) => E.openPreview(`QC Stickers ${t.qc_no}`, [stickerPage(t, resultOf(t, r))], { bare: true });

  V.qc = async (id) => {
    E.shell("qc", "QC Test", busy());
    const here = E.stillHere();
    const [tq, rq] = await Promise.all([sb.from("qc_tests").select("*").eq("id", id).maybeSingle(), sb.from("qc_results").select("*").eq("qc_id", id).maybeSingle()]);
    if (!here()) return;
    if (tq.error && notSet(tq.error)) { $("#main").innerHTML = needUpdate; return; }
    const t = tq.data;
    if (!t) { $("#main").innerHTML = `<div class="empty">QC form not found. <a href="#eooffice">Back to EO-Office</a></div>`; return; }
    if (rq.error && /qc_results|permission/i.test(rq.error.message || "")) { $("#main").innerHTML = `<div class="empty">QC Test needs the database update <b>025_qc_simple.sql</b>. Run it in the Supabase SQL Editor.</div>`; return; }
    const r = rq.data || { checks: {}, numbers: {}, docs: [] };
    $(".band h1") && ($(".band h1").textContent = `QC Test — ${t.qc_no}`);
    draw(t, r);
    if (FRESH.delete(id)) E.openPreview(`QC Form ${t.qc_no}`, [qcPage(t)]);
    E.setRecords(`QC test: ${t.qc_no}`);
  };

  function draw(t, r) {
    const here = E.stillHere();
    let busyUp = false; // a paper copy is being uploaded
    const docs = [...(r.docs || [])];
    const start = Object.fromEntries(CHECKS.map(([k]) => [k, choiceOf(t, r, k)]));
    const done = t.status === "done", res = done ? resultOf(t, r) : null;
    let manual = t.score != null && t.score !== 100 - 10 * Object.values(start).filter((c) => c === "fail").length;
    const head = `<div class="pgrid2 qc-head">${E.cell("QC No", t.qc_no)}${E.cell("Date", mdy(t.created_at))}${E.cell("Serial No", t.serial_no || "")}${E.cell("Item", t.item || "")}
      ${E.cell("Brand", t.brand || "")}${E.cell("Batch", t.batch || "")}${E.cell("CTN", t.ctn || "")}</div>`;
    $("#main").innerHTML = `<div class="window"><div class="wtitle">${esc(t.qc_no)}${t.item ? ` · ${esc(t.item)}` : ""} ${pill(done ? "approved" : "pending", done ? "TESTED" : "NOT TESTED YET")}</div><div class="wbody">
      ${res ? `<div class="qc-banner ${res.verdict.toLowerCase()}"><b>${res.verdict}</b><span>${res.score} / 100 · Pass ${res.pass} · Fail ${res.fail}${res.fail ? ` · Qty Found ${res.qty}` : ""}</span><small>Checked ${esc(mdy(res.when))}${res.by ? ` by ${esc(res.by)}` : ""}</small></div>` : ""}
      ${head}
      <fieldset class="opt"><legend>Quality Check</legend>
        <p class="muted" style="margin-top:0">Print the form, check the goods on the paper, then choose Pass or Fail for each check here. For a Fail write the Qty Found (how many pieces); the Qty Found is added up. When you press Save, the 2 stickers open to print.</p>
        <div class="btnrow" style="margin:0 0 8px"><button type="button" class="btn small" id="qcAllPass">${ic("check")} All Pass</button><span class="qc-tally" id="qcTally"></span></div>
        <div class="qc-list" id="qcList">${CHECKS.map(([k, label], i) => `<div class="qc-row pf" data-k="${k}"><span class="qc-n">${i + 1}</span>
          <span class="qc-t"><b>${esc(label)}${k === "mending" ? " PCS" : ""}</b></span>
          <span class="qc-pf" role="radiogroup" aria-label="${esc(label)}"><label class="qc-pass"><input type="radio" name="qc_${k}" value="pass"${start[k] === "pass" ? " checked" : ""}><span>Pass</span></label><label class="qc-fail"><input type="radio" name="qc_${k}" value="fail"${start[k] === "fail" ? " checked" : ""}><span>Fail</span></label></span>
          <input type="text" class="qc-num" data-n="${k}" inputmode="numeric" maxlength="9" placeholder="Qty found" value="${esc(String(numOf(r, k)))}" aria-label="${esc(label)} Qty Found"${start[k] === "fail" ? "" : " hidden"}></div>`).join("")}</div>
        <div class="qc-score"><label for="qcTotal">Total Score</label><input type="number" id="qcTotal" min="0" max="100" step="1" inputmode="numeric" value="${t.score ?? 100}"><span class="qc-big">/ 100</span>
          <span class="qc-verd" id="qcVerd"></span><small class="muted" id="qcHint"></small></div></fieldset>
      <fieldset class="opt"><legend>Scan the Filled Form</legend>
        <p class="muted" style="margin-top:0">Scan or upload the filled paper form (up to 6 files). Only the form logo is shown; press it to open.</p>
        <div class="qc-docs" id="qcDocs"></div>
        <div class="btnrow"><label class="btn primary" for="qcUp" id="qcUpL">${ic("upload")} Upload Paper Copy</label><input type="file" id="qcUp" hidden multiple accept="image/*,application/pdf" data-save-now></div></fieldset>
    </div><div class="wfoot"><button type="button" class="btn primary" id="qcSave">${ic("check")} ${done ? "Update" : "Save"}</button><button type="button" class="btn" id="qcSticker"${done ? "" : " disabled"}>${ic("print")} Print 2 Stickers</button>
      <button type="button" class="btn" id="qcBlank">${ic("print")} Print Blank Form</button><button type="button" class="btn" id="qcPdf">${ic("print")} Print Filled Form</button>${isAdmin() ? `<button type="button" class="btn danger" id="qcDel">${ic("trash")} Delete</button>` : ""}<a class="btn" href="#eooffice">Close</a></div></div>`;
    const choice = (k) => $(`#qcList input[name="qc_${k}"]:checked`)?.value || "";
    const read = () => {
      const pick = {}, checks = {}, numbers = {};
      for (const [k] of CHECKS) { const v = choice(k); pick[k] = v; checks[k] = v === "fail"; const n = $(`#qcList input[data-n="${k}"]`).value.trim(); if (v === "fail" && n) numbers[k] = n; }
      return { choice: pick, checks, numbers, score: $("#qcTotal").value };
    };
    const refresh = () => {
      let pass = 0, fail = 0, qty = 0;
      for (const [k] of CHECKS) { const v = choice(k), box = $(`#qcList input[data-n="${k}"]`); if (v === "pass") pass++; else if (v === "fail") { fail++; qty += parseInt(box.value, 10) || 0; } box.hidden = v !== "fail"; }
      const open = CHECKS.length - pass - fail;
      if (!manual) $("#qcTotal").value = 100 - 10 * fail;
      $("#qcTally").innerHTML = `Pass <b>${pass}</b> · Fail <b>${fail}</b>${fail ? ` · Qty Found <b>${qty}</b>` : ""}${open ? ` · Not checked <b>${open}</b>` : ""}`;
      const v = open || $("#qcTotal").value === "" ? "" : verdict($("#qcTotal").value);
      $("#qcVerd").textContent = v; $("#qcVerd").className = `qc-verd ${v.toLowerCase()}`;
      $("#qcHint").textContent = manual ? `To pass: ${PASS_MARK} or more.` : `Suggested: 100 − 10 for each Fail. You can write another total. To pass: ${PASS_MARK} or more.`;
    };
    $("#qcList").onchange = (e) => {
      if (e.target.type !== "radio") return;
      refresh();
      if (e.target.value === "fail") $(`#qcList input[data-n="${e.target.name.slice(3)}"]`)?.focus();
    };
    $("#qcList").oninput = (e) => { if (e.target.classList.contains("qc-num")) { e.target.value = e.target.value.replace(/\D/g, ""); refresh(); } }; // the Qty Found is a whole number
    $("#qcTotal").oninput = () => { manual = true; refresh(); };
    $("#qcAllPass").onclick = () => { for (const [k] of CHECKS) { if (!choice(k)) $(`#qcList input[name="qc_${k}"][value="pass"]`).checked = true; } refresh(); };
    refresh();

    // Save = submit: the result is kept and the 2 stickers open to print
    $("#qcSave").onclick = async (e) => {
      const v = read(); const s = Number(v.score);
      const open = CHECKS.filter(([k]) => !v.choice[k]);
      if (open.length) { $(`#qcList [data-k="${open[0][0]}"]`)?.scrollIntoView({ block: "center" }); return toast(`Choose Pass or Fail for every check (${open.length} not checked).`, true); }
      const noQty = CHECKS.find(([k]) => v.choice[k] === "fail" && !(parseInt(v.numbers[k], 10) > 0));
      if (noQty) { const box = $(`#qcList input[data-n="${noQty[0]}"]`); box.scrollIntoView({ block: "center" }); box.focus(); return toast(`Write the Qty Found for: ${noQty[1]}.`, true); }
      if (v.score === "" || !Number.isInteger(s) || s < 0 || s > 100) return toast("Write the total score from 0 to 100.", true);
      if (busyUp) return toast("Wait until the paper copy is uploaded.", true);
      const btn = e.currentTarget; btn.disabled = true;
      const { data: d, error } = await sb.rpc("qc_save", { p_id: t.id, p_data: { checks: v.checks, numbers: v.numbers, score: s, remarks: r.remarks || "" } });
      if (error) { btn.disabled = false; return fail(error, /qc_save|schema cache/i.test(error.message) ? "Run the database update 025_qc_simple.sql first" : "Could not save the result"); }
      if (!here()) return; // the person went to another page while it was saved
      toast(`Saved. Total score ${d.score} / 100 — ${verdict(d.score)}.`);
      t.status = "done"; t.score = d.score; t.found_count = d.found_count; t.tested_at = new Date().toISOString(); t.tested_by_name = S.profile?.full_name || "";
      const saved = { ...r, checks: Object.fromEntries(Object.entries(v.checks).filter(([, x]) => x)), numbers: v.numbers, docs };
      draw(t, saved);
      openStickers(t, saved);
    };
    $("#qcSticker").onclick = () => {
      if (t.status !== "done") return;
      if (read().score !== String(t.score) || CHECKS.some(([k]) => choice(k) !== start[k])) return toast("Press Save first: the stickers print the saved result.", true);
      openStickers(t, r);
    };
    $("#qcBlank").onclick = () => E.openPreview(`QC Form ${t.qc_no}`, [qcPage(t)]);
    $("#qcPdf").onclick = () => { const v = read(); E.openPreview(`QC Test ${t.qc_no}`, [qcPage({ ...t, score: v.score === "" ? null : Number(v.score) }, { choice: v.choice, numbers: v.numbers })]); };
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
        if (busyUp) return toast("Wait until the paper copy is uploaded.", true);
        const { data: d, error } = await sb.rpc("qc_set_docs", { p_id: t.id, p_docs: keep });
        if (error) return fail(error, "Could not remove the file");
        docs.splice(0, docs.length, ...keep);
        if (d.removed?.length) sb.storage.from("records").remove(d.removed).then(() => {}, () => {});
        if (here()) paintDocs();
      }));
    };
    paintDocs();
    $("#qcUp").onchange = async (e) => {
      const picked = Array.from(e.target.files).slice(0, 6 - docs.length); e.target.value = "";
      if (!picked.length || busyUp) return;
      busyUp = true; $("#qcSave").disabled = true;
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
      const finish = () => { busyUp = false; if (here() && $("#qcSave")) { $("#qcSave").disabled = false; lab.classList.remove("disabled"); } };
      if (!added.length) return finish();
      const { error } = await sb.rpc("qc_set_docs", { p_id: t.id, p_docs: [...docs, ...added] });
      if (error) { sb.storage.from("records").remove(added).then(() => {}, () => {}); finish(); return fail(error, "Could not save the paper copy"); }
      docs.push(...added);
      finish();
      toast("Paper copy saved.");
      if (here()) paintDocs();
    };
    if ($("#qcDel")) $("#qcDel").onclick = async () => {
      if (!(await E.confirmBox(`Delete QC form <b>${esc(t.qc_no)}</b> with its result and paper copies? This cannot be undone.`, { ok: "Delete", danger: true }))) return;
      const { data: gone, error } = await sb.rpc("delete_qc", { p_id: t.id });
      if (error) return fail(error, "Could not delete");
      if (gone?.length) sb.storage.from("records").remove(gone).then(() => {}, () => {});
      toast("Deleted."); location.hash = "eooffice";
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
      let acc = 0, paper = 255; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= w * h * 0.95) { paper = v; break; } }
      if (paper < 120) return file; // a dark picture: nothing to cut
      const rowCov = (mask, x0, x1, y) => { let n = 0; for (let x = x0; x <= x1; x++) if (mask(lum[y * w + x])) n++; return n / (x1 - x0 + 1); };
      const colCov = (mask, y0, y1, x) => { let n = 0; for (let y = y0; y <= y1; y++) if (mask(lum[y * w + x])) n++; return n / (y1 - y0 + 1); };
      // 1. the paper: bright rows and columns (a dark table around it is cut)
      const bright = (v) => v >= paper - 45;
      let y0 = 0, y1 = h - 1, x0 = 0, x1 = w - 1;
      // (a narrow receipt strip is a small part of a row, so a row counts when 12% of it is paper)
      while (y0 < y1 && rowCov(bright, 0, w - 1, y0) < 0.12) y0++;
      while (y1 > y0 && rowCov(bright, 0, w - 1, y1) < 0.12) y1--;
      while (x0 < x1 && colCov(bright, y0, y1, x0) < 0.35) x0++;
      while (x1 > x0 && colCov(bright, y0, y1, x1) < 0.35) x1--;
      if (y1 - y0 < h * 0.25 || x1 - x0 < w * 0.1) return file; // no paper found: keep the picture
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
      if (d - c < w * 0.1 || b - a < h * 0.1) return file; // too small to be a receipt: keep the picture
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
    const here = E.stillHere();
    const { data: v } = await sb.from("collection_vouchers").select("*").eq("id", id).maybeSingle();
    if (!here()) return;
    if (!v) { $("#main").innerHTML = `<div class="empty">Collection voucher not found.</div>`; return; }
    cvForm(v);
  };
  const canChange = (v) => isAdmin() || (v.created_by === meId() && Date.now() - new Date(v.created_at).getTime() < 864e5);

  async function cvForm(v) {
    if (!canW()) { location.hash = "eooffice"; return; }
    E.shell(v ? "editcollection" : "newcollection", v ? `Edit ${v.cv_no}` : "New Collection Voucher", `
      <form class="window" id="cvoForm" novalidate><div class="wtitle">${v ? `Collection Voucher ${esc(v.cv_no)}` : "Collection Voucher"}</div><div class="wbody">
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
          <div class="btnrow"><label class="btn primary" for="cvoFile">${ic("camera")} ${v?.receipt_path ? "Change Receipt" : "Add Receipt"}</label><input type="file" id="cvoFile" hidden accept="image/*,application/pdf">
            <label class="chk" id="cvWholeL" hidden><input type="checkbox" id="cvWhole"> Keep the whole picture (do not cut)</label></div></fieldset>
      </div><div class="wfoot"><button type="button" class="btn" id="cvCancel">Cancel</button><button type="submit" class="btn primary">${v ? "Save" : "Save Collection Voucher"}</button></div></form>`);
    const here = E.stillHere();
    if (v && !canChange(v)) { toast("Only the Director can change this voucher now.", true); location.hash = "collection/" + v.id; return; }
    let orig = null, ready = null, pending = null, token = 0, shownUrl = ""; // the picture chosen, the cleaned copy to save, the cleaning that is running
    const oldUrl = v?.receipt_path ? (await E.signedMap([v.receipt_path])).get(v.receipt_path) : "";
    if (!here() || !$("#cvPrev")) return;
    const paint = (src, note = "") => { const el = $("#cvPrev"); if (!el) return; el.innerHTML = src ? `<img src="${esc(src)}" alt="Receipt">${note ? `<small>${esc(note)}</small>` : ""}` : ""; };
    paint(oldUrl, oldUrl ? "Receipt on file" : "");
    // The newest choice wins; Save waits for the cleaning to finish.
    const prepare = () => {
      if (!orig) return Promise.resolve();
      const mine = ++token, whole = $("#cvWhole").checked, pic = orig;
      if ($("#cvPrev")) $("#cvPrev").innerHTML = busy("Cleaning the picture");
      pending = (async () => {
        const cut = whole ? pic : await cutEmpty(pic);
        const out = await E.slimFile(cut, "doc");
        if (mine !== token) return; // another picture was chosen meanwhile
        ready = out;
        if (shownUrl) URL.revokeObjectURL(shownUrl);
        shownUrl = URL.createObjectURL(out);
        paint(shownUrl, whole ? "Whole picture. This is the picture that will be saved." : cut === pic ? "Nothing to cut. This is the picture that will be saved." : "The empty area was cut off. This is the picture that will be saved.");
      })();
      return pending;
    };
    $("#cvoFile").onchange = async (e) => {
      const f = e.target.files[0]; e.target.value = "";
      if (!f) return;
      orig = f; ready = null; $("#cvWholeL").hidden = !/^image\//.test(f.type);
      if (!/^image\//.test(f.type)) { token++; ready = f; paint("", ""); $("#cvPrev").innerHTML = `<div class="empty small">${esc(f.name)}</div>`; return; }
      await prepare();
    };
    $("#cvWhole").onchange = prepare;
    $("#cvCancel").onclick = () => history.back();
    $("#cvoForm").onsubmit = async (e) => {
      e.preventDefault();
      const from = $("#cvFrom").value.trim(), amt = num($("#cvAmt").value);
      if (!from) return toast("Write who the money was collected from.", true);
      if (!(amt > 0)) return toast("Write the amount collected.", true);
      E.setBusy(e.target, true, "Saving");
      if (pending) await pending.catch(() => {}); // the receipt picture is ready before it is saved
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

  Object.assign(E, { cutEmpty, eoTabs, qcVerdict: verdict });
})();
