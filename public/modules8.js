/* EMON OVERRUNS E-PORTAL — Gate Pass Clearance for Delivery (3.5) and the customer's Request menu (3.10).
   One simple rule on the customer profile: an ACTIVE (open) account that keeps within its credit limit and pays before it is
   overdue is cleared for delivery, and the portal issues a GATE PASS CLEARANCE FOR DELIVERY. Any other account is not cleared
   and the portal says why (suspended or closed, an overdue invoice, over the credit limit). Every gate pass issued is written
   in the customer's history.
   REQUEST (on the customer profile): Account Balance Certificate, Gate Pass, and the account status requests: Restrict
   (suspend), Lift Restriction, Close and Reopen. A status request waits for the Director, who approves or rejects it on the
   same profile (the Director's own request is carried out at once); a closed account also gets its Certificate of Closure. */
(() => {
  "use strict";
  const E = window.EO;
  const { sb, S, C, esc, peso, isoToday, mdy, $, $$, isAdmin, isStaff, toast, fail, ic, num, fullName, verifyUrl } = E;
  const V = window.EO_VIEWS;

  // What the records say today: cleared or not, and why not.
  function gateCheck(c, ctx) {
    const today = isoToday();
    const bal = num(ctx.b?.balance_due);
    const overdue = (ctx.invs || []).filter((i) => num(i.balance) > 0.004 && i.due_date && i.due_date < today);
    const owed = overdue.reduce((s, i) => s + num(i.balance), 0);
    const limit = c.credit_limit == null ? null : num(c.credit_limit);
    const reasons = [];
    if (c.status !== "active") reasons.push(`The account is ${String(c.status || "").toUpperCase()}, not open.`);
    if (overdue.length) reasons.push(`${overdue.length} overdue invoice${overdue.length === 1 ? "" : "s"} (₱ ${peso(owed)}): ${overdue.slice(0, 4).map((i) => i.invoice_no).join(", ")}${overdue.length > 4 ? " …" : ""}.`);
    if (limit != null && bal > limit + 0.004) reasons.push(`Over the credit limit: balance ₱ ${peso(bal)} is above the limit ₱ ${peso(limit)}.`);
    return { ok: !reasons.length, reasons, overdue, owed, bal, limit, today };
  }
  const stampNo = (c) => {
    const d = new Date(), p2 = (n) => String(n).padStart(2, "0");
    return `GP-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}-${c.account_no || c.application_no}`;
  };
  const tr2 = (k, html) => `<tr><th>${esc(k)}</th><td>${html}</td></tr>`;
  // The person issuing: the Director's own signature is printed; anyone else signs the paper.
  const issuerBlock = () => {
    const sign = isAdmin() ? E.approvedBy(S.session?.user?.id, S.profile?.full_name, new Date().toISOString()) : null;
    return `<div class="ol-sign one"><div class="ol-auth${sign?.pic ? " has-sig" : ""}">${sign?.pic ? `<img class="esig" src="${esc(sign.pic)}" alt="Signature">` : ""}<div class="ol-auth-name">${esc(S.profile?.full_name || "")}</div><div class="line"></div>${isAdmin() ? "Director · Authorized Representative" : "Issued by · Authorized Representative"}</div></div>`;
  };
  const codes = (c, no) => `<div class="ph-codes"><div><img src="${E.pdf417DataUrl("EMONCUST|" + (c.account_no || c.application_no))}" alt="" class="ph-bar"><div class="mono">${esc(no)}</div></div>
    ${c.public_id ? `<img src="${E.qrDataUrl(verifyUrl(c.public_id))}" alt="Verification QR code" class="ph-qr">` : ""}</div>`;

  // ----------------------------------------------------------------------
  // 3.15: the Gate Pass looks at the customer's whole record first (invoices, payments, overdue, credit memos, returns,
  // the gaps between payments, how many days the customer takes to pay) and then clears the delivery or says why not.
  // A delivery that is not cleared can be sent to the Director as a Request for Clearance: approved = the gate pass
  // prints (cleared by the Director); rejected = HOLD FOR DELIVERY, with the Director's note. Every request is kept.
  // ----------------------------------------------------------------------
  const GATE = "Gate Pass Clearance";
  const isGate = (o) => o.subject_type === "other" && String(o.subject || "").startsWith(GATE);
  const dayDiff = (a, b) => Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000);
  function analyse(c, ctx) {
    const g = gateCheck(c, ctx), today = g.today;
    const invs = [...(ctx.invs || [])].sort((x, y) => String(x.invoice_date).localeCompare(String(y.invoice_date)) || String(x.invoice_no).localeCompare(String(y.invoice_no)));
    const pays = [...(ctx.pays || [])].sort((x, y) => String(x.paid_date).localeCompare(String(y.paid_date)));
    // when each invoice was fully paid: payments pay the oldest invoices first (as the account does)
    const q = pays.map((p) => ({ d: p.paid_date, left: num(p.amount) }));
    let qi = 0;
    const rows = invs.map((i) => {
      let need = num(i.total_amount) - num(i.amount_returned), last = null;
      while (need > 0.004 && qi < q.length) { const take = Math.min(need, q[qi].left); need -= take; q[qi].left -= take; last = q[qi].d; if (q[qi].left <= 0.004) qi++; }
      // paid or not comes from the server (invoice_balances); the payments only date it
      const paidOn = i.pay_status === "paid" ? (need <= 0.004 ? last || i.invoice_date : pays.length ? pays[pays.length - 1].paid_date : i.invoice_date) : null;
      return { i, paidOn, days: paidOn ? Math.max(0, dayDiff(i.invoice_date, paidOn)) : null, late: paidOn && i.due_date && paidOn > i.due_date ? dayDiff(i.due_date, paidOn) : 0 };
    });
    const paid = rows.filter((r) => r.paidOn), late = paid.filter((r) => r.late > 0);
    const avgDays = paid.length ? Math.round(paid.reduce((t, r) => t + r.days, 0) / paid.length) : null;
    const onTime = paid.length ? Math.round(((paid.length - late.length) / paid.length) * 100) : null;
    const gaps = pays.slice(1).map((p, k) => ({ p, gap: dayDiff(pays[k].paid_date, p.paid_date) }));
    const avgGap = gaps.length ? Math.round(gaps.reduce((t, x) => t + x.gap, 0) / gaps.length) : null;
    const lastPay = pays.length ? pays[pays.length - 1].paid_date : null;
    const cms = [], rets = [];
    for (const m of ctx.memos || []) (m.is_return ? rets : cms).push(m);
    const approvedSum = (list) => list.reduce((t, m) => t + (["approved", "paid"].includes(m.status) ? num(m.request_amount) : 0), 0);
    const cmApproved = approvedSum(cms), retApproved = approvedSum(rets), sinceLast = lastPay ? dayDiff(lastPay, today) : null;
    const overdueNow = g.overdue.map((i) => ({ i, days: dayDiff(i.due_date, today) }));
    const rating = !invs.length ? "NEW ACCOUNT" : overdueNow.length ? "OVERDUE NOW" : onTime == null ? "NO PAYMENT YET" : onTime >= 80 ? "GOOD PAYER" : onTime >= 50 ? "FAIR PAYER" : "SLOW PAYER";
    const notes = [];
    if (late.length && !overdueNow.length) notes.push(`Paid late before (${late.length} invoice${late.length === 1 ? "" : "s"}, at most ${Math.max(...late.map((r) => r.late))} days late), but nothing is overdue now.`);
    if (!late.length && paid.length) notes.push(`Every invoice was paid on or before its due date (${paid.length} paid).`);
    if (sinceLast > 60) notes.push(`No payment for ${sinceLast} days (last payment ${mdy(lastPay)}).`);
    if (retApproved > 0) notes.push(`Returns approved: ₱ ${peso(retApproved)}.`);
    return { ...g, invs, pays, rows, paid, late, avgDays, onTime, gaps, avgGap, lastPay, sinceLast, cms, rets, cmApproved, retApproved, overdueNow, rating, notes,
      invoiced: invs.reduce((t, i) => t + num(i.total_amount), 0), paidTotal: pays.reduce((t, p) => t + num(p.amount), 0) };
  }
  const tile = (k, v, small = "") => `<div class="ga-tile"><small>${esc(k)}</small><b>${v}</b>${small ? `<span>${small}</span>` : ""}</div>`;
  function analysisHtml(a) {
    const daysTxt = (n) => (n == null ? "—" : `${n} day${n === 1 ? "" : "s"}`);
    return `<div class="ga-tiles">
        ${tile("Rating", esc(a.rating))}${tile("Invoices", String(a.invs.length), `₱ ${peso(a.invoiced)}`)}${tile("Paid", String(a.paid.length), `₱ ${peso(a.paidTotal)} received`)}
        ${tile("Overdue Now", String(a.overdueNow.length), a.overdueNow.length ? `₱ ${peso(a.owed)}` : "none")}
        ${tile("Average Days to Pay", daysTxt(a.avgDays))}${tile("Paid on Time", a.onTime == null ? "—" : a.onTime + "%", a.late.length ? `${a.late.length} late` : "")}
        ${tile("Average Gap Between Payments", daysTxt(a.avgGap))}${tile("Last Payment", a.lastPay ? esc(mdy(a.lastPay)) : "—", a.lastPay ? `${a.sinceLast} days ago` : "")}
        ${tile("Balance Due", `₱ ${peso(a.bal)}`, a.limit != null ? `limit ₱ ${peso(a.limit)}` : "no credit limit")}
        ${tile("Credit Memos", String(a.cms.length), `₱ ${peso(a.cmApproved)} approved`)}${tile("Returns", String(a.rets.length), `₱ ${peso(a.retApproved)} approved`)}</div>
      ${a.notes.length ? `<ul class="ga-notes">${a.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
      ${a.overdueNow.length ? `<div class="ga-h">Overdue Invoices</div><table class="ga-t"><thead><tr><th>Invoice No</th><th>Due Date</th><th class="num">Days Overdue</th><th class="num">Balance (₱)</th></tr></thead><tbody>
        ${a.overdueNow.map((x) => `<tr><td>${esc(x.i.invoice_no)}</td><td>${esc(mdy(x.i.due_date))}</td><td class="num">${x.days}</td><td class="num">${peso(x.i.balance)}</td></tr>`).join("")}</tbody></table>` : ""}
      ${a.rows.length ? `<div class="ga-h">Invoice Payment Record</div><table class="ga-t"><thead><tr><th>Invoice No</th><th>Date</th><th>Due</th><th>Paid On</th><th class="num">Days to Pay</th><th class="num">Days Late</th></tr></thead><tbody>
        ${a.rows.slice(-12).reverse().map((r) => `<tr><td>${esc(r.i.invoice_no)}</td><td>${esc(mdy(r.i.invoice_date))}</td><td>${esc(mdy(r.i.due_date) || "—")}</td><td>${r.paidOn ? esc(mdy(r.paidOn)) : "<b>NOT PAID</b>"}</td><td class="num">${r.days ?? "—"}</td><td class="num">${r.late || ""}</td></tr>`).join("")}</tbody></table>` : ""}
      ${a.pays.length ? `<div class="ga-h">Payments and Gaps</div><table class="ga-t"><thead><tr><th>Date Paid</th><th>Receipt No</th><th class="num">Amount (₱)</th><th class="num">Days Since the Payment Before</th></tr></thead><tbody>
        ${a.pays.slice(-12).map((p, j, last) => { const k = a.pays.length - last.length + j; return `<tr><td>${esc(mdy(p.paid_date))}</td><td>${esc(p.receipt_no || "")}</td><td class="num">${peso(p.amount)}</td><td class="num">${k ? a.gaps[k - 1].gap : "—"}</td></tr>`; }).reverse().join("")}</tbody></table>` : ""}`;
  }
  const summaryText = (a) => `Rating ${a.rating} · invoices ${a.invs.length} · overdue now ${a.overdueNow.length} · average ${a.avgDays ?? "—"} days to pay · ${a.onTime ?? "—"}% on time · balance PHP ${peso(a.bal)}`;

  function gatePage(c, no, a, approved = null) {
    return `${E.printHead("GATE PASS CLEARANCE FOR DELIVERY", codes(c, no))}
      <div class="cert-no"><span>Gate Pass No: <b>${esc(no)}</b></span><span>Date Issued: <b>${esc(E.dateTime(new Date().toISOString()))}</b></span></div>
      <div class="dc-head gp-clear"><b>CLEARED FOR DELIVERY</b><small>${approved ? `Cleared by the Director's approval of request ${esc(approved.order_no)}${approved.review_note ? ": " + esc(approved.review_note) : "."}` : "This account is open, within its credit limit and has no overdue invoice."}</small></div>
      <p class="cert-to">TO WHOM IT MAY CONCERN:</p>
      <p class="cert-body">This is to certify that the account of <b>${esc(fullName(c).toUpperCase())}</b>, Account No <b class="nw">${esc(c.account_no || "")}</b>, was checked by ${esc(C.company.name)}
        on <span class="nw">${esc(mdy(a.today))}</span>${approved ? " and the delivery was approved by the Director" : `. The account is <b>ACTIVE</b>, ${a.limit != null ? "within its credit limit, " : ""}and every invoice is paid on or before its due date`}.
        This gate pass clears the delivery of goods to this account on <span class="nw">${esc(mdy(a.today))}</span> only.</p>
      <div class="ol-sec">ACCOUNT</div>
      <table class="ol-grid"><tbody>${tr2("Name of Customer", esc(fullName(c)))}${tr2("Account No", esc(c.account_no || "—"))}${c.business_name ? tr2("Business Name", esc(c.business_name)) : ""}
        ${tr2("Account Status", esc(String(c.status || "").toUpperCase()))}${tr2("Credit Limit", a.limit != null ? `PHP ${peso(a.limit)}` : "No limit set")}
        ${tr2("Balance Due Today", `PHP ${peso(Math.max(a.bal, 0))}`)}${tr2("Overdue Invoices", a.overdueNow.length ? `${a.overdueNow.length} · PHP ${peso(a.owed)}` : "None")}</tbody></table>
      <div class="ol-sec">PAYMENT RECORD</div>
      <table class="ol-grid"><tbody>${tr2("Rating", esc(a.rating))}${tr2("Invoices / Paid", `${a.invs.length} / ${a.paid.length}`)}${tr2("Average Days to Pay", a.avgDays == null ? "—" : `${a.avgDays} days`)}
        ${tr2("Paid on Time", a.onTime == null ? "—" : `${a.onTime}%${a.late.length ? ` (${a.late.length} late)` : ""}`)}${tr2("Average Gap Between Payments", a.avgGap == null ? "—" : `${a.avgGap} days`)}
        ${tr2("Last Payment", a.lastPay ? esc(mdy(a.lastPay)) : "—")}</tbody></table>
      <p class="pdecl">A new gate pass is issued for each delivery day. The warehouse releases the goods only against a gate pass of the day of delivery.</p>
      ${issuerBlock()}
      <div class="rp-foot"><span>Scan the QR code to check this account online.</span><span>${esc(no)}</span></div>`;
  }
  async function issueGate(c, a, approved = null) {
    await E.loadSignatures().catch(() => {});
    const no = stampNo(c);
    issueDoc(c, "Gate Pass", no, gatePage(c, no, a, approved), approved ? `Cleared by the Director (${approved.order_no})` : `Cleared for delivery · balance PHP ${peso(a.bal)}`);
  }

  async function gatePass(c, ctx) {
    const m = E.modal(`Gate Pass — ${fullName(c)} (${c.account_no || ""})`, `<div class="ga-run" id="gaRun"><div class="ga-bar"><i></i></div>
      <ul>${["Reading the invoices", "Reading the payments", "Checking overdue invoices", "Credit memos and returns", "Gaps between payments and days to pay", "Making the decision"].map((t) => `<li>${esc(t)}…</li>`).join("")}</ul></div><div id="gaOut" hidden></div>`,
      `<button type="button" class="btn" data-x>Close</button>`, { wide: true });
    $("[data-x]", m.el).onclick = m.close;
    const a = analyse(c, ctx);
    // the analysis is shown step by step
    const lis = $$("#gaRun li", m.el);
    for (let k = 0; k < lis.length; k++) {
      await new Promise((r) => setTimeout(r, 260));
      if (!m.el.isConnected) return;
      lis[k].classList.add("done"); $("#gaRun .ga-bar i", m.el).style.width = `${Math.round(((k + 1) / lis.length) * 100)}%`;
    }
    await new Promise((r) => setTimeout(r, 200));
    if (!m.el.isConnected) return;
    const wait = (ctx.orders || []).find((o) => isGate(o) && o.status === "pending");
    $("#gaRun", m.el).hidden = true;
    const out = $("#gaOut", m.el); out.hidden = false;
    out.innerHTML = `<div class="gp-verdict ${a.ok ? "ok" : "no"}"><span>${ic(a.ok ? "check" : "x")}</span><div><b>${a.ok ? "CLEARED FOR DELIVERY" : "NOT CLEARED FOR DELIVERY"}</b>
        <small>${a.ok ? "The account is open, within its credit limit and has no overdue invoice." : "Why the gate pass is not issued:"}</small></div></div>
      ${a.reasons.length ? `<ul class="gp-why">${a.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
      ${analysisHtml(a)}
      ${!a.ok ? (wait ? `<div class="rq-item"><span>${ic("clock")}</span><div><b>Request for Clearance · ${esc(wait.order_no)}</b><small>Sent by ${esc(wait.created_by_name || "")} · waiting for the Director</small></div></div>`
        : `<div class="fields wide" style="margin-top:10px"><label for="gaNote">${isAdmin() ? "Director's note" : "Note for the Director"}</label><textarea id="gaNote" rows="2" maxlength="600" placeholder="e.g. customer promised to pay on Friday; delivery is needed today"></textarea></div>`) : ""}`;
    const foot = $(".wfoot", m.el);
    const add = (html) => { foot.insertAdjacentHTML("beforeend", html); };
    if (a.ok) {
      add(`<button type="button" class="btn primary" data-issue>${ic("print")} Issue Gate Pass</button>`);
      $("[data-issue]", m.el).onclick = () => { m.close(); issueGate(c, a); };
      return;
    }
    if (wait && isAdmin()) {
      add(`<button type="button" class="btn danger" data-hold>${ic("x")} Hold for Delivery</button><button type="button" class="btn primary" data-appr>${ic("check")} Approve Clearance</button>`);
      $("[data-appr]", m.el).onclick = () => { m.close(); decideGate(c, ctx, wait, "approve", a); };
      $("[data-hold]", m.el).onclick = () => { m.close(); decideGate(c, ctx, wait, "reject", a); };
      return;
    }
    if (wait || !canRequest()) return;
    const send = async (decide) => {
      const note = $("#gaNote", m.el).value.trim();
      if (decide === "reject" && !note) { $("#gaNote", m.el).focus(); return toast("Write why the delivery is on hold.", true); }
      $$("[data-req],[data-appr],[data-hold]", m.el).forEach((b) => (b.disabled = true));
      const row = { customer_id: c.id, subject_type: "other", subject: `${GATE}: ${a.reasons.join(" ").slice(0, 240)}`, details: [note, summaryText(a)].filter(Boolean).join("\n"), order_date: isoToday() };
      const { data: o, error } = await sb.from("order_letters").insert(row).select().single();
      if (error) { $$("[data-req],[data-appr],[data-hold]", m.el).forEach((b) => (b.disabled = false)); return fail(error, "Could not send the request"); }
      m.close();
      if (!decide) { toast(`Request for Clearance ${o.order_no} sent to the Director.`); return V.customer(c.id); }
      const e2 = await applyDecision(c, a, o, decide, note);
      if (e2) { fail(e2, "Could not record the decision"); return V.customer(c.id); }
    };
    if (isAdmin()) {
      add(`<button type="button" class="btn danger" data-hold>${ic("x")} Hold for Delivery</button><button type="button" class="btn primary" data-appr>${ic("check")} Approve Clearance &amp; Issue</button>`);
      $("[data-appr]", m.el).onclick = () => send("approve");
      $("[data-hold]", m.el).onclick = () => send("reject");
    } else {
      add(`<button type="button" class="btn primary" data-req>${ic("send")} Request for Clearance</button>`);
      $("[data-req]", m.el).onclick = () => send(null);
    }
  }
  // The Director decides a Request for Clearance (from the profile or the gate pass window): a note, then approve / hold
  // The decision on a Request for Clearance; approved = the gate pass prints. Gives back the error, if any.
  async function applyDecision(c, a, o, action, note) {
    const { data: r, error } = await sb.rpc("review_order_letter", { p_id: o.id, p_action: action, p_note: note || null });
    if (error) return error;
    toast(action === "approve" ? "Clearance approved." : "HOLD FOR DELIVERY recorded.");
    await V.customer(c.id);
    if (action === "approve") issueGate(c, a, { ...o, ...(r || {}), review_note: note });
    return null;
  }
  function decideGate(c, ctx, o, action, a = analyse(c, ctx)) {
    const m = E.modal(`${action === "approve" ? "Approve Clearance" : "Hold for Delivery"} — ${o.order_no}`, `
      <div class="gp-verdict ${action === "approve" ? "ok" : "no"}"><span>${ic(action === "approve" ? "check" : "x")}</span><div><b>${action === "approve" ? "APPROVE: CLEAR THE DELIVERY" : "REJECT: HOLD FOR DELIVERY"}</b>
        <small>Asked by ${esc(o.created_by_name || "")} on ${esc(mdy(o.order_date))}${o.details ? " · " + esc(o.details.split("\n")[0]) : ""}</small></div></div>
      ${a.reasons.length ? `<ul class="gp-why">${a.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
      ${analysisHtml(a)}
      <div class="fields wide" style="margin-top:10px"><label for="gdNote">Director's note${action === "reject" ? " *" : ""}</label><textarea id="gdNote" rows="2" maxlength="600" placeholder="${action === "approve" ? "e.g. approved for today's delivery only" : "e.g. hold until the overdue invoices are paid"}"></textarea></div>`,
      `<button type="button" class="btn" data-x>Cancel</button><button type="button" class="btn ${action === "approve" ? "primary" : "danger"}" data-ok>${action === "approve" ? `${ic("check")} Approve &amp; Print Gate Pass` : `${ic("x")} Hold for Delivery`}</button>`, { wide: true });
    $("[data-x]", m.el).onclick = m.close;
    $("[data-ok]", m.el).onclick = async (e) => {
      const note = $("#gdNote", m.el).value.trim();
      if (action === "reject" && !note) { $("#gdNote", m.el).focus(); return toast("Write why the delivery is on hold.", true); }
      const btn = e.currentTarget; btn.disabled = true;
      m.close();
      const error = await applyDecision(c, a, o, action, note);
      if (error) fail(error, "Could not record the decision");
    };
  }
  // The Gate Pass history of the customer: every Request for Clearance (waiting / approved / on hold) and every gate pass issued
  function gateHistoryRows(orders, events) {
    return [
      ...(orders || []).filter(isGate).map((o) => ({ at: o.created_at, no: o.order_no, what: "Request for Clearance", by: o.created_by_name || "",
        st: o.status === "pending" ? "WAITING FOR THE DIRECTOR" : o.status === "rejected" ? "REJECTED · HOLD FOR DELIVERY" : "APPROVED · CLEAR",
        tone: o.status === "pending" ? "pending" : o.status === "rejected" ? "rejected" : "approved", note: [o.details?.split("\n")[0], o.review_note ? `Director: ${o.review_note}` : "", o.approved_by_name ? `decided by ${o.approved_by_name}` : ""].filter(Boolean).join(" · "), o })),
      ...(events || []).filter((e) => /^GATE PASS GP-/.test(e.note || "")).map((e) => ({ at: e.created_at, no: (e.note.match(/GP-\S+/) || [""])[0], what: "Gate Pass Issued", by: e.actor_name || "", st: "ISSUED · CLEAR", tone: "approved", note: e.note.replace(/^GATE PASS \S+\s*·?\s*/, "") }))
    ].sort((x, y) => String(y.at).localeCompare(String(x.at)));
  }
  // the History tab line of an approved Request for Clearance (the server writes it as "other by <request no>")
  const gateEventLabel = (ev) => (/^other by /i.test(ev.action) && String(ev.note || "").startsWith(GATE) ? `GATE PASS CLEARANCE APPROVED (${ev.action.replace(/^other by /i, "")})` : null);
  function gateHistoryHtml(orders, events) {
    const rows = gateHistoryRows(orders, events);
    if (!rows.length) return `<div class="empty">No gate pass or request for clearance yet.</div>`;
    return `<table class="grid"><thead><tr><th>Date / Time</th><th>No</th><th>Type</th><th>Status</th><th>Note</th><th>By</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${esc(E.dateTime(r.at))}</td><td>${esc(r.no)}</td><td>${esc(r.what)}</td><td>${E.pill(r.tone, r.st)}</td><td>${esc(r.note)}</td><td>${esc(r.by)}</td></tr>`).join("")}</tbody></table>`;
  }

  // ======================================================================
  // REQUEST menu on the customer profile
  // ======================================================================
  const docNo = (pre, c) => `${pre}-${isoToday().replace(/-/g, "")}-${c.account_no || c.application_no}`;
  const php2 = (n) => `PHP ${peso(n)}`;
  const para = (t) => esc(t).replace(/\n/g, "<br>");
  // the status requests: what it is called, who it is for, and what the account becomes
  const STATUS_REQ = {
    suspension: { title: "Restrict Account", sub: "Restrict (suspend) this account: no new invoices until the restriction is lifted", from: ["active"], to: "SUSPENDED (RESTRICTED)", icon: "shield" },
    reactivation: { title: "Lift Restriction", sub: "Make the restricted account active again", from: ["suspended"], to: "ACTIVE", icon: "check" },
    closure: { title: "Close Account", sub: "Close this account: no new invoices or deliveries", from: ["active", "suspended"], to: "CLOSED", icon: "x" },
    reopen: { title: "Reopen Account", sub: "Make the closed account active again", from: ["closed"], to: "ACTIVE", icon: "check" }
  };
  const pendingOf = (orders) => (orders || []).filter((o) => STATUS_REQ[o.subject_type] && o.status === "pending");
  const canRequest = () => E.canWrite("customers") || E.canWrite("orders");

  function balancePage(c, ctx, no, purpose) {
    const b = ctx.b || {}, bal = num(b.balance_due), today = isoToday(), asOf = mdy(today);
    const open = (ctx.invs || []).filter((i) => num(i.balance) > 0.004).sort((x, y) => String(x.invoice_date).localeCompare(String(y.invoice_date)));
    const days = (d) => (d && d < today ? Math.floor((new Date(today + "T00:00:00") - new Date(d + "T00:00:00")) / 86400000) : 0);
    const st = num(b.total_settlement), ret = (ctx.invs || []).reduce((s2, i) => s2 + num(i.amount_returned), 0);
    return `${E.printHead("ACCOUNT BALANCE CERTIFICATE", codes(c, no))}
      <div class="cert-no"><span>Certificate No: <b>${esc(no)}</b></span><span>Date Issued: <b>${esc(asOf)}</b></span></div>
      <p class="cert-to">TO WHOM IT MAY CONCERN:</p>
      <p class="cert-body">This is to certify that, based on the records of ${esc(C.company.name)}, the account of <b>${esc(fullName(c).toUpperCase())}</b>, Account No <b class="nw">${esc(c.account_no || "")}</b>,
        ${bal > 0.004 ? `has a <b>total outstanding balance of PHP ${peso(bal)}</b> (${esc(E.words(bal))}) as of <span class="nw">${esc(asOf)}</span>.`
          : bal < -0.004 ? `has <b>no outstanding balance</b> as of <span class="nw">${esc(asOf)}</span>: the account has paid PHP ${peso(-bal)} more than the amount owed (balance <b>PHP ${peso(bal)}</b>).`
          : `has <b>no outstanding balance</b> as of <span class="nw">${esc(asOf)}</span>. The account is fully paid.`}</p>
      <div class="ol-sec">ACCOUNT DETAILS</div>
      <table class="ol-grid"><tbody>${tr2("Name of Customer", esc(fullName(c)))}${tr2("Account No", esc(c.account_no || "—"))}${c.business_name ? tr2("Business Name", esc(c.business_name)) : ""}
        ${tr2("Account Status", esc(String(c.status || "").toUpperCase()))}${tr2("Account Opened", esc(mdy(c.application_date) || "—"))}</tbody></table>
      <div class="ol-sec">ACCOUNT SUMMARY</div>
      <table class="ol-grid"><tbody>${num(c.opening_balance) ? tr2("Opening Balance", php2(c.opening_balance)) : ""}${tr2("Total Invoiced", php2(b.total_invoiced))}
        ${num(b.total_charges) ? tr2("Additional Charges", php2(b.total_charges)) : ""}${st ? tr2("Settlement Adjustments", `${st < 0 ? "−" : "+"} ${php2(Math.abs(st))}`) : ""}
        ${tr2("Total Payments", `− ${php2(b.total_paid)}`)}${num(b.total_credits) ? tr2(`Credits / Discounts${ret ? " / Returns" : ""}`, `− ${php2(b.total_credits)}`) : ""}
        ${tr2("Total Outstanding Balance", `<b>${php2(bal)}</b>`)}${tr2("Amount in Words", esc(bal < -0.004 ? `OVERPAID — ${E.words(-bal)}` : E.words(bal)))}${tr2("As Of", esc(asOf))}</tbody></table>
      ${open.length ? `<div class="ol-sec">UNPAID INVOICES</div>
      <table class="ol-grid ol-sched"><thead><tr><th>Invoice No</th><th>Invoice Date</th><th>Due Date</th><th class="num">Days Overdue</th><th class="num">Balance (PHP)</th></tr></thead><tbody>
        ${open.map((i) => `<tr><td class="nw">${esc(i.invoice_no)}</td><td>${esc(mdy(i.invoice_date))}</td><td>${esc(mdy(i.due_date) || "—")}</td><td class="num">${days(i.due_date) || "—"}</td><td class="num">${peso(i.balance)}</td></tr>`).join("")}</tbody></table>` : ""}
      <p class="cert-body">${purpose ? `This certificate is issued upon the request of the account holder for: ${para(purpose)}.` : "This certificate is issued upon the request of the account holder for whatever purpose it may serve."}
        Payments received after the date above are not included.</p>
      ${issuerBlock()}
      <div class="rp-foot"><span>Scan the QR code to check this account online.</span><span>${esc(no)}</span></div>`;
  }
  function closurePage(c, ctx, no, ord) {
    const bal = num(ctx.b?.balance_due);
    const when = ord?.applied_at ? mdy(ord.applied_at) : ord?.order_date ? mdy(ord.order_date) : "";
    return `${E.printHead("CERTIFICATE OF ACCOUNT CLOSURE", codes(c, no))}
      <div class="cert-no"><span>Certificate No: <b>${esc(no)}</b></span><span>Date Issued: <b>${esc(mdy(isoToday()))}</b></span></div>
      <p class="cert-to">TO WHOM IT MAY CONCERN:</p>
      <p class="cert-body">This is to certify that the account of <b>${esc(fullName(c).toUpperCase())}</b>, Account No <b class="nw">${esc(c.account_no || "")}</b>, with ${esc(C.company.name)}
        is <b>CLOSED</b>${when ? ` effective <span class="nw">${esc(when)}</span>` : ""}. No new purchases, invoices or deliveries are made on this account.
        ${bal > 0.004 ? `The remaining balance of <b>PHP ${peso(bal)}</b> (${esc(E.words(bal))}) must still be settled.` : bal < -0.004 ? `The account has a credit of PHP ${peso(-bal)} (balance PHP ${peso(bal)}).` : "The account has no remaining balance."}</p>
      <div class="ol-sec">ACCOUNT DETAILS</div>
      <table class="ol-grid"><tbody>${tr2("Name of Customer", esc(fullName(c)))}${tr2("Account No", esc(c.account_no || "—"))}${c.business_name ? tr2("Business Name", esc(c.business_name)) : ""}
        ${tr2("Account Opened", esc(mdy(c.application_date) || "—"))}${tr2("Account Status", "<b>CLOSED</b>")}</tbody></table>
      <div class="ol-sec">CLOSURE</div>
      <table class="ol-grid"><tbody>${tr2("Date Closed", esc(when || "—"))}${tr2("Reason for Closure", `<b>${esc(ord?.closure_reason || c.status_note || "—")}</b>`)}${ord ? tr2("Request No", esc(ord.order_no)) : ""}
        ${tr2("Balance at Issue", `<b>${php2(bal)}</b>`)}</tbody></table>
      <p class="cert-body">This certificate is issued upon request for whatever purpose it may serve. The account can be reopened only with the approval of the Director of ${esc(C.company.name)}.</p>
      ${issuerBlock()}
      <div class="rp-foot"><span>Scan the QR code to check this account online.</span><span>${esc(no)}</span></div>`;
  }
  // The Customer Information Update Form: the old and the new details, the customer's signature and the Director's approval
  function updatePage(c, r, no) {
    const keys = Object.keys(r.changes || {}), ok = r.atOnce || r.req?.status === "approved";
    const sign = ok ? E.approvedBy(S.session?.user?.id, S.profile?.full_name, new Date().toISOString()) : null;
    const val = (k, v) => esc(E.showVal(k === "credit_limit" && v != null ? `₱ ${peso(v)}` : v));
    return `${E.printHead("CUSTOMER INFORMATION UPDATE FORM", codes(c, no))}
      <div class="cert-no"><span>Request No: <b>${esc(no)}</b></span><span>Date: <b>${esc(mdy(isoToday()))}</b></span></div>
      <div class="uf-state ${ok ? "ok" : "wait"}">${ok ? "APPROVED — THE PROFILE SHOWS THE NEW INFORMATION" : "WAITING FOR THE DIRECTOR'S APPROVAL"}</div>
      <div class="ol-sec">ACCOUNT</div>
      <table class="ol-grid"><tbody>${tr2("Name of Customer", esc(fullName(r.previous)))}${tr2("Account No", esc(c.account_no || "—"))}${tr2("Account Status", esc(String(c.status || "").toUpperCase()))}</tbody></table>
      <div class="ol-sec">UPDATED INFORMATION</div>
      <table class="ol-grid uf-grid"><thead><tr><th>Detail</th><th>Old Information</th><th>New Information</th></tr></thead><tbody>
        ${keys.map((k) => `<tr><td>${esc(E.fieldLabel("customers", k))}</td><td>${val(k, r.previous?.[k])}</td><td><b>${val(k, r.changes[k])}</b></td></tr>`).join("")}</tbody></table>
      <p class="cert-body">I confirm that the new information above is true and correct, and I ask ${esc(C.company.name)} to update my account with it.</p>
      <div class="ol-sign"><div class="ol-auth"><div class="ol-auth-name">${esc(fullName(r.previous).toUpperCase())}</div><div class="line"></div>Customer · Signature over Printed Name / Date</div>
        <div class="ol-auth${sign?.pic ? " has-sig" : ""}">${sign?.pic ? `<img class="esig" src="${esc(sign.pic)}" alt="Signature">` : ""}<div class="ol-auth-name">${sign ? esc(S.profile?.full_name || "") : ""}</div><div class="line"></div>Approved by · Director${sign ? ` · ${esc(mdy(isoToday()))}` : " / Date"}</div></div>
      <div class="rp-foot"><span>Scan the QR code to check this account online.</span><span>${esc(no)}</span></div>`;
  }
  async function printUpdate(c, r) {
    await E.loadSignatures().catch(() => {});
    const no = r.req?.request_no || docNo("UF", c);
    issueDoc(c, "Customer Information Update Form", no, updatePage(c, r, no), Object.keys(r.changes || {}).map((k) => E.fieldLabel("customers", k)).join(", "));
  }
  // Print a document and write it in the customer's history
  const issueDoc = (c, title, no, page, note) => {
    E.openPreview(`${title} ${no}`, [page]);
    sb.rpc("log_customer_document", { p_customer: c.id, p_document: `${title.toUpperCase()} ${no}`, p_note: note || null }).then(() => {}, () => {});
  };

  // The Request menu. ctx: { b, invs, orders }
  function customerRequest(c, ctx) {
    const wait = pendingOf(ctx.orders)[0];
    const opts = [
      ["update", "edit", "Update Information", isAdmin() && S.mainDirector ? "Change the customer's details. Saved at once; the Update Form prints with the old and new details."
        : "Change the customer's details. The Update Form prints with the old and new details; the Director approves the change.", isStaff()],
      ["balance", "wallet", "Account Balance Certificate", "The total outstanding balance as of today, with the unpaid invoices", true],
      ["gate", "check", "Gate Pass", "Checks the whole payment record (invoices, payments, overdue, credit memos, returns, days to pay), then issues the Gate Pass Clearance for Delivery or says why not; a delivery not cleared can be sent to the Director", true],
      ...Object.entries(STATUS_REQ).filter(([, x]) => x.from.includes(c.status)).map(([k, x]) => [k, x.icon, x.title,
        wait ? `${wait.order_no} (${STATUS_REQ[wait.subject_type].title}) is waiting for the Director` : !canRequest() ? "You have no access to make this request" : `${x.sub}. ${isAdmin() ? "As the Director it is done at once." : "The Director approves it."}`,
        !wait && canRequest()]),
      ...(c.status === "closed" ? [["closurecert", "doc", "Certificate of Account Closure", "Print the certificate of this closed account", true]] : [])
    ];
    const m = E.modal(`Request — ${fullName(c)} (${c.account_no || ""})`, `<div class="rq-list">${opts.map(([k, icon, t, sub, on]) =>
      `<button type="button" class="rq-opt" data-rq="${k}"${on ? "" : " disabled"}>${ic(icon)}<span><b>${esc(t)}</b><small>${esc(sub)}</small></span></button>`).join("")}</div>`,
      `<button type="button" class="btn" data-x>Close</button>`);
    $("[data-x]", m.el).onclick = m.close;
    $$("[data-rq]", m.el).forEach((b) => (b.onclick = async () => {
      const k = b.dataset.rq; m.close();
      if (k === "gate") return gatePass(c, ctx);
      if (k === "update") return E.correctRecord("customers", c, `${c.account_no || c.application_no} ${fullName(c)}`, () => V.customer(c.id), { onSaved: (r) => printUpdate(c, r) });
      await E.loadSignatures().catch(() => {});
      if (k === "balance") return balanceForm(c, ctx);
      if (k === "closurecert") {
        const ord = (ctx.orders || []).filter((o) => o.subject_type === "closure" && o.status === "applied").sort((x, y) => String(y.applied_at || y.created_at).localeCompare(String(x.applied_at || x.created_at)))[0];
        const no = docNo("CA", c);
        return issueDoc(c, "Certificate of Account Closure", no, closurePage(c, ctx, no, ord));
      }
      statusForm(c, k, ctx);
    }));
  }
  function balanceForm(c, ctx) {
    const bal = num(ctx.b?.balance_due);
    const m = E.modal("Account Balance Certificate", `<div class="summary-box"><div class="fields wide"><span>Customer</span><b>${esc(fullName(c))} (${esc(c.account_no || "")})</b>
        <span>Total Outstanding Balance</span><b class="${bal < 0 ? "neg" : ""}">₱ ${peso(bal)}</b><span>As Of</span><b>${esc(mdy(isoToday()))}</b></div></div>
      <div class="fields wide" style="margin-top:10px"><label for="rqPurpose">Purpose (optional)</label><input type="text" id="rqPurpose" maxlength="160" placeholder="e.g. bank requirement, settlement of account"></div>`,
      `<button type="button" class="btn" data-x>Cancel</button><button type="button" class="btn primary" data-ok>${ic("print")} Print / Download</button>`);
    $("[data-x]", m.el).onclick = m.close;
    $("[data-ok]", m.el).onclick = () => {
      const purpose = $("#rqPurpose", m.el).value.trim(), no = docNo("AB", c);
      m.close(); issueDoc(c, "Account Balance Certificate", no, balancePage(c, ctx, no, purpose), `PHP ${peso(bal)}${purpose ? " · " + purpose : ""}`);
    };
  }
  // Restrict / lift / close / reopen: the reason, then it waits for the Director (the Director's own is done at once)
  function statusForm(c, kind, ctx) {
    const x = STATUS_REQ[kind], bal = num(ctx.b?.balance_due);
    const m = E.modal(`${x.title} — ${fullName(c)}`, `<div class="summary-box"><div class="fields wide"><span>Account</span><b>${esc(c.account_no || "")} · ${esc(String(c.status).toUpperCase())}</b>
        <span>Becomes</span><b>${esc(x.to)}</b><span>Balance Due</span><b class="${bal < 0 ? "neg" : ""}">₱ ${peso(bal)}</b></div></div>
      <div class="fields wide" style="margin-top:10px"><label for="rqWhy">Reason *</label><input type="text" id="rqWhy" maxlength="200" placeholder="${kind === "suspension" ? "e.g. overdue invoices not paid" : kind === "closure" ? "e.g. customer asked to close the account" : "e.g. balance settled"}">
        <label for="rqNote">Note</label><textarea id="rqNote" rows="2" maxlength="600" placeholder="Optional"></textarea></div>
      <p class="muted" style="margin:8px 0 0">${isAdmin() ? "As the Director, the account changes as soon as you send it." : "The Director is told and approves or rejects it on this profile."}</p>`,
      `<button type="button" class="btn" data-x>Cancel</button><button type="button" class="btn primary" data-ok>${ic("send")} ${isAdmin() ? `${esc(x.title)} Now` : "Send Request"}</button>`);
    $("[data-x]", m.el).onclick = m.close;
    $("[data-ok]", m.el).onclick = async (e) => {
      const why = $("#rqWhy", m.el).value.trim(), note = $("#rqNote", m.el).value.trim();
      if (!why) { $("#rqWhy", m.el).focus(); return toast("Write the reason.", true); }
      const btn = e.currentTarget; btn.disabled = true;
      const row = { customer_id: c.id, subject_type: kind, subject: `${x.title}: ${why}`, details: note || null, order_date: isoToday(), closure_reason: kind === "closure" ? why : null };
      const { data: o, error } = await sb.from("order_letters").insert(row).select().single();
      if (error) { btn.disabled = false; return fail(error, "Could not send the request"); }
      if (isAdmin()) {
        const { error: e2 } = await sb.rpc("review_order_letter", { p_id: o.id, p_action: "approve", p_note: null });
        if (e2) { m.close(); fail(e2, `Request ${o.order_no} was saved but could not be carried out`); return V.customer(c.id); }
        m.close(); toast(`Done: account ${c.account_no} is now ${x.to}.`);
      } else { m.close(); toast(`Request ${o.order_no} sent to the Director.`); }
      V.customer(c.id);
    };
  }
  // The requests waiting for the Director, shown on the customer profile
  function requestsHtml(c, orders) {
    const list = [...pendingOf(orders), ...(orders || []).filter((o) => isGate(o) && o.status === "pending")];
    if (!list.length) return "";
    return `<div class="rq-wait">${list.map((o) => `<div class="rq-item" data-o="${o.id}"><span>${ic("clock")}</span><div><b>${esc(isGate(o) ? "Request for Clearance (Gate Pass)" : STATUS_REQ[o.subject_type].title)} · ${esc(o.order_no)}</b>
      <small>${esc(o.subject.replace(/^[^:]*:\s*/, ""))}${o.details ? " — " + esc(o.details) : ""} · asked by ${esc(o.created_by_name || "")} on ${esc(mdy(o.order_date))} · waiting for the Director</small></div>
      ${isAdmin() ? `<button type="button" class="btn small primary" data-ap="${o.id}">${ic("check")} Approve</button><button type="button" class="btn small danger" data-rj="${o.id}">${ic("x")} Reject</button>` : ""}</div>`).join("")}</div>`;
  }
  function bindRequests(c, orders, ctx = {}) {
    const by = (id) => (orders || []).find((o) => o.id === id);
    $$("[data-ap]").forEach((b) => (b.onclick = async () => {
      const o = by(b.dataset.ap); if (!o) return;
      if (isGate(o)) return decideGate(c, { ...ctx, orders }, o, "approve");
      if (!(await E.confirmBox(`Approve <b>${esc(STATUS_REQ[o.subject_type].title)}</b> (${esc(o.order_no)})? Account <b>${esc(c.account_no)}</b> becomes <b>${esc(STATUS_REQ[o.subject_type].to)}</b>.`, { ok: "Approve" }))) return;
      const { error } = await sb.rpc("review_order_letter", { p_id: o.id, p_action: "approve", p_note: null });
      if (error) return fail(error, "Could not approve");
      toast(`Approved: account ${c.account_no} is now ${STATUS_REQ[o.subject_type].to}.`); V.customer(c.id);
    }));
    $$("[data-rj]").forEach((b) => (b.onclick = async () => {
      const o = by(b.dataset.rj); if (!o) return;
      if (isGate(o)) return decideGate(c, { ...ctx, orders }, o, "reject");
      if (!(await E.confirmBox(`Reject <b>${esc(STATUS_REQ[o.subject_type].title)}</b> (${esc(o.order_no)})? The account stays as it is.`, { ok: "Reject", danger: true }))) return;
      const { error } = await sb.rpc("review_order_letter", { p_id: o.id, p_action: "reject", p_note: null });
      if (error) return fail(error, "Could not reject");
      toast("Rejected. The account stays as it is."); V.customer(c.id);
    }));
  }
  // A notification link "order/<id>" opens the customer of that request
  V.order = async (id) => {
    const { data } = await sb.from("order_letters").select("customer_id").eq("id", id).maybeSingle();
    location.replace(data?.customer_id ? "#customer/" + data.customer_id : "#dashboard");
  };

  Object.assign(E, { gatePass, gateCheck, customerRequest, requestsHtml, bindRequests, gateHistoryHtml, gateHistoryRows, gateEventLabel });
})();
