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
  const { sb, S, C, esc, peso, isoToday, isoDay, mdy, $, $$, isAdmin, isStaff, toast, fail, ic, num, fullName, verifyUrl } = E;
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
    return `<div class="ol-sign one"><div class="ol-auth${sign?.pic ? " has-sig" : ""}">${sign?.pic ? `<img class="esig" src="${esc(sign.pic)}" alt="Signature">` : ""}<div class="ol-auth-name">${esc(S.profile?.full_name || "")}</div><div class="line"></div>${isAdmin() ? "Managing Director · Authorized Representative" : "Issued by · Authorized Representative"}</div></div>`;
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
  // the trusted-customer rule (3.16): every line must be met
  const TRUST = { months: 6, activeMonths: 3, paidInvoices: 5, lastPayDays: 45, overdueDays: 30, limitPct: 150 };
  const isGate = (o) => o.subject_type === "other" && String(o.subject || "").startsWith(GATE);
  const dayDiff = (a, b) => Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000);
  function analyse(c, ctx) {
    const g = gateCheck(c, ctx), today = g.today;
    const invs = [...(ctx.invs || [])].sort((x, y) => String(x.invoice_date).localeCompare(String(y.invoice_date)) || String(x.invoice_no).localeCompare(String(y.invoice_no)));
    const pays = [...(ctx.pays || [])].sort((x, y) => String(x.paid_date).localeCompare(String(y.paid_date)));
    // when each invoice was fully paid, in the account's order (invoice_balances): a payment linked to an invoice pays that
    // invoice; the rest of the money (unlinked payments, what a link leaves over, credits not on an invoice, reduce
    // adjustments) pays the opening balance first and then the oldest invoices
    const mine = new Set(invs.map((i) => i.id)), direct = {}, q = [];
    for (const p of pays) {
      let left = num(p.amount);
      for (const l of p.payment_links || []) if (!l.removed_at && mine.has(l.invoice_id)) { (direct[l.invoice_id] ||= []).push({ d: p.paid_date, amt: num(l.amount) }); left -= num(l.amount); }
      if (left > 0.004) q.push({ d: p.paid_date, left });
    }
    for (const m of ctx.memos || []) if (["approved", "paid"].includes(m.status) && (m.off_balance ?? ["credit", "discount"].includes(m.requested_action)) && !mine.has(m.invoice_id) && m.approved_at) q.push({ d: isoDay(new Date(m.approved_at)), left: num(m.request_amount) });
    for (const o of ctx.orders || []) if (o.status === "applied" && o.subject_type === "settlement" && o.adjust_type === "reduce" && o.applied_at) q.push({ d: isoDay(new Date(o.applied_at)), left: num(o.amount) });
    let qi = 0;
    const pay = (need, last) => {
      while (need > 0.004 && qi < q.length) { const take = Math.min(need, q[qi].left); if (take > 0) { need -= take; q[qi].left -= take; if (!last || q[qi].d > last) last = q[qi].d; } if (q[qi].left <= 0.004) qi++; }
      return [need, last];
    };
    // linked payments first (what a link leaves over joins the rest), then the opening balance, then the oldest invoices
    const start = invs.map((i) => {
      let need = num(i.total_amount) - num(i.amount_returned), last = null;
      for (const x of direct[i.id] || []) {
        const take = Math.max(0, Math.min(need, x.amt)); if (take > 0) { need -= take; if (!last || x.d > last) last = x.d; }
        if (x.amt - take > 0.004) q.push({ d: x.d, left: x.amt - take });
      }
      return [need, last];
    });
    q.sort((x, y) => String(x.d).localeCompare(String(y.d)));
    pay(Math.max(0, num(c.opening_balance)), null);
    const rows = invs.map((i, k) => {
      let [need, last] = start[k];
      [need, last] = pay(need, last);
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
    // 3.16: a trusted customer (old, buys regularly, keeps paying) is cleared by itself even with a recent overdue or over the
    // credit limit; a new account never is (it goes to the Director)
    const since = [c.application_date, invs[0]?.invoice_date].filter(Boolean).sort()[0] || today;
    const months = Math.floor(dayDiff(since, today) / 30.4);
    const recentMonths = new Set(invs.filter((i) => dayDiff(i.invoice_date, today) <= 183).map((i) => String(i.invoice_date).slice(0, 7))).size;
    const oldestOver = overdueNow.reduce((m, x) => Math.max(m, x.days), 0);
    const trust = [
      [`Business with us for ${TRUST.months} months or more`, months >= TRUST.months, `since ${mdy(since)} (${months} month${months === 1 ? "" : "s"})`],
      [`Buys regularly (invoices in ${TRUST.activeMonths} of the last 6 months)`, recentMonths >= TRUST.activeMonths, `${recentMonths} of 6 months`],
      [`At least ${TRUST.paidInvoices} invoices paid`, paid.length >= TRUST.paidInvoices, `${paid.length} paid`],
      [`Paid in the last ${TRUST.lastPayDays} days`, sinceLast != null && sinceLast <= TRUST.lastPayDays, lastPay ? `last payment ${mdy(lastPay)}` : "no payment yet"],
      [`Overdue not older than ${TRUST.overdueDays} days`, oldestOver <= TRUST.overdueDays, overdueNow.length ? `oldest ${oldestOver} days` : "nothing overdue"],
      [`Balance not above ${TRUST.limitPct}% of the credit limit`, g.limit == null || g.bal <= (g.limit * TRUST.limitPct) / 100 + 0.004, g.limit == null ? "no limit set" : `balance ₱ ${peso(g.bal)} · limit ₱ ${peso(g.limit)}`]
    ].map(([label, ok, why]) => ({ label, ok, why }));
    const trusted = c.status === "active" && trust.every((x) => x.ok);
    return { ...g, ok: g.ok || trusted, byTrust: !g.ok && trusted, trust, trusted, since, months,
      invs, pays, rows, paid, late, avgDays, onTime, gaps, avgGap, lastPay, sinceLast, cms, rets, cmApproved, retApproved, overdueNow, rating, notes,
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
      <div class="ga-h">Trusted Customer Check ${a.trusted ? `<span class="pill approved">TRUSTED CUSTOMER</span>` : `<span class="pill pending">NOT YET</span>`}</div>
      <ul class="ga-trust">${a.trust.map((t) => `<li class="${t.ok ? "ok" : "no"}"><b>${t.ok ? "✔" : "✖"}</b> ${esc(t.label)} <small>${esc(t.why)}</small></li>`).join("")}</ul>
      ${a.notes.length ? `<ul class="ga-notes">${a.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
      ${a.overdueNow.length ? `<div class="ga-h">Overdue Invoices</div><table class="ga-t"><thead><tr><th>Invoice No</th><th>Due Date</th><th class="num">Days Overdue</th><th class="num">Balance (₱)</th></tr></thead><tbody>
        ${a.overdueNow.map((x) => `<tr><td>${esc(x.i.invoice_no)}</td><td>${esc(mdy(x.i.due_date))}</td><td class="num">${x.days}</td><td class="num">${peso(x.i.balance)}</td></tr>`).join("")}</tbody></table>` : ""}
      ${a.rows.length ? `<div class="ga-h">Invoice Payment Record</div><table class="ga-t"><thead><tr><th>Invoice No</th><th>Date</th><th>Due</th><th>Paid On</th><th class="num">Days to Pay</th><th class="num">Days Late</th></tr></thead><tbody>
        ${a.rows.slice(-12).reverse().map((r) => `<tr><td>${esc(r.i.invoice_no)}</td><td>${esc(mdy(r.i.invoice_date))}</td><td>${esc(mdy(r.i.due_date) || "—")}</td><td>${r.paidOn ? esc(mdy(r.paidOn)) : "<b>NOT PAID</b>"}</td><td class="num">${r.days ?? "—"}</td><td class="num">${r.late || ""}</td></tr>`).join("")}</tbody></table>` : ""}
      ${a.pays.length ? `<div class="ga-h">Payments and Gaps</div><table class="ga-t"><thead><tr><th>Date Paid</th><th>Receipt No</th><th class="num">Amount (₱)</th><th class="num">Days Since the Payment Before</th></tr></thead><tbody>
        ${a.pays.slice(-12).map((p, j, last) => { const k = a.pays.length - last.length + j; return `<tr><td>${esc(mdy(p.paid_date))}</td><td>${esc(p.receipt_no || "")}</td><td class="num">${peso(p.amount)}</td><td class="num">${k ? a.gaps[k - 1].gap : "—"}</td></tr>`; }).reverse().join("")}</tbody></table>` : ""}`;
  }

  function gatePage(c, no, a, approved = null) {
    return `${E.printHead("GATE PASS CLEARANCE FOR DELIVERY", codes(c, no))}
      <div class="cert-no"><span>Gate Pass No: <b>${esc(no)}</b></span><span>Date Issued: <b>${esc(E.dateTime(new Date().toISOString()))}</b></span></div>
      <div class="dc-head gp-clear"><b>CLEARED FOR DELIVERY</b><small>${approved ? `Cleared by EMON HASAN's approval of request ${esc(approved.order_no)}${approved.review_note ? ": " + esc(approved.review_note) : "."}` : a.byTrust ? `Cleared as a trusted customer: business since ${esc(mdy(a.since))}, buys regularly and keeps paying.` : "This account is open, within its credit limit and has no overdue invoice."}</small></div>
      <p class="cert-to">TO WHOM IT MAY CONCERN:</p>
      <p class="cert-body">This is to certify that the account of <b>${esc(fullName(c).toUpperCase())}</b>, Account No <b class="nw">${esc(c.account_no || "")}</b>, was checked by ${esc(C.company.name)}
        on <span class="nw">${esc(mdy(a.today))}</span>${approved ? " and the delivery was approved by EMON HASAN" : a.byTrust ? ". The account is <b>ACTIVE</b> and is cleared as a <b>TRUSTED CUSTOMER</b> (an old account that buys regularly and keeps paying)" : `. The account is <b>ACTIVE</b>, ${a.limit != null ? "within its credit limit, " : ""}and every invoice is paid on or before its due date`}.
        This gate pass clears the delivery of goods to this account on <span class="nw">${esc(mdy(a.today))}</span> only.</p>
      <div class="ol-sec">ACCOUNT</div>
      <table class="ol-grid"><tbody>${tr2("Name of Customer", esc(fullName(c)))}${tr2("Account No", esc(c.account_no || "—"))}${c.business_name ? tr2("Business Name", esc(c.business_name)) : ""}
        ${tr2("Account Status", esc(String(c.status || "").toUpperCase()))}${tr2("Credit Limit", a.limit != null ? `PHP ${peso(a.limit)}` : "No limit set")}
        ${tr2("Balance Due Today", `PHP ${peso(Math.max(a.bal, 0))}`)}${tr2("Overdue Invoices", a.overdueNow.length ? `${a.overdueNow.length} · PHP ${peso(a.owed)}` : "None")}</tbody></table>
      <div class="ol-sec">PAYMENT RECORD</div>
      <table class="ol-grid"><tbody>${tr2("Rating", esc(a.rating))}${tr2("Invoices / Paid", `${a.invs.length} / ${a.paid.length}`)}${tr2("Average Days to Pay", a.avgDays == null ? "—" : `${a.avgDays} days`)}
        ${tr2("Paid on Time", a.onTime == null ? "—" : `${a.onTime}%${a.late.length ? ` (${a.late.length} late)` : ""}`)}${tr2("Average Gap Between Payments", a.avgGap == null ? "—" : `${a.avgGap} days`)}
        ${tr2("Last Payment", a.lastPay ? esc(mdy(a.lastPay)) : "—")}${tr2("Business With Us Since", `${esc(mdy(a.since))} (${a.months} months)`)}
        ${a.byTrust ? tr2("Cleared As", "<b>TRUSTED CUSTOMER</b>") : ""}</tbody></table>
      <p class="pdecl">A new gate pass is issued for each delivery day. The warehouse releases the goods only against a gate pass of the day of delivery.</p>
      ${issuerBlock()}
      <div class="rp-foot"><span>Scan the QR code to check this account online.</span><span>${esc(no)}</span></div>`;
  }
  async function issueGate(c, a, approved = null) {
    E.gateAI?.logDecision(c, "CLEAR"); // 3.38: the decision is written with the AI's idea
    await E.loadSignatures().catch(() => {});
    const no = stampNo(c);
    issueDoc(c, "Gate Pass", no, gatePage(c, no, a, approved), approved ? `Cleared by EMON HASAN (${approved.order_no})` : `${a.byTrust ? "Cleared as a trusted customer" : "Cleared for delivery"} · balance PHP ${peso(a.bal)}`);
  }

  // The Director decides a Request for Clearance (from the profile or the gate pass window): a note, then approve / hold
  // The decision on a Request for Clearance; approved = the gate pass prints. Gives back the error, if any.
  async function applyDecision(c, a, o, action, note) {
    const here = E.stillHere();
    const { data: r, error } = await sb.rpc("review_order_letter", { p_id: o.id, p_action: action, p_note: note || null });
    if (error) return error;
    E.gateAI?.logDecision(c, action === "approve" ? "CLEAR" : "HOLD");
    toast(action === "approve" ? "Clearance approved." : "HOLD FOR DELIVERY recorded.");
    if (!here()) return null; // 3.35: the person went to another page meanwhile: the decision is saved, nothing pops up there
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
      <div class="fields wide" style="margin-top:10px"><label for="gdNote">EMON HASAN's note${action === "reject" ? " *" : ""}</label><textarea id="gdNote" rows="2" maxlength="600" placeholder="${action === "approve" ? "e.g. approved for today's delivery only" : "e.g. hold until the overdue invoices are paid"}"></textarea></div>`,
      `<button type="button" class="btn" data-x>Cancel</button><button type="button" class="btn ${action === "approve" ? "primary" : "danger"}" data-ok>${action === "approve" ? `${ic("check")} Approve &amp; Print Gate Pass` : `${ic("x")} Hold for Delivery`}</button>`, { wide: true });
    $("[data-x]", m.el).onclick = m.close;
    aiIdea(c, ctx, m.el);
    $("[data-ok]", m.el).onclick = async (e) => {
      const note = $("#gdNote", m.el).value.trim();
      if (action === "reject" && !note) { $("#gdNote", m.el).focus(); return toast("Write why the delivery is on hold.", true); }
      const btn = e.currentTarget; btn.disabled = true;
      m.close();
      const error = await applyDecision(c, a, o, action, note);
      if (error) fail(error, "Could not record the decision");
    };
  }
  // 3.38: EVA's idea (the AI) (CLEAR or HOLD, how sure, why), under the portal's own check
  const aiIdea = (c, ctx, root) => {
    if (!E.gateAI) return;
    E.gateAI.box(c, ctx).then((html) => { const v = $(".gp-verdict", root); if (html && v && root.isConnected) v.insertAdjacentHTML("afterend", html); }, () => {});
  };
  // The Gate Pass history of the customer: every Request for Clearance (waiting / approved / on hold) and every gate pass issued
  // 3.69: ONE line for each request: what the system said (and EVA AI), what EMON HASAN did, and the status
  // (CLEARED, or FREEZE ACCOUNT while it is on hold). EVA AI's own HOLD ideas and the gate passes issued are lines too.
  const U = (x) => String(x || "").toUpperCase();
  const pctHold = (l) => Math.round((1 - Number(l.p_clear)) * 100);
  function gateHistoryRows(orders, events, ai = []) {
    const why = (o) => String(o.subject || "").replace(/^Gate Pass Clearance:?\s*/, "");
    const aiNear = (o) => (ai || []).find((l) => l.suggestion === "HOLD" && Math.abs(new Date(l.created_at) - new Date(o.approved_at || o.created_at)) < 6 * 3600 * 1000);
    const rows = [];
    for (const o of (orders || []).filter(isGate)) {
      const hold = aiNear(o);
      const r = { at: o.created_at, when: o.status === "pending" ? o.created_at : o.approved_at || o.created_at, no: o.order_no, sys: hold ? "SYSTEM + AI REJECT · NOT CLEAR" : "SYSTEM REJECT · NOT CLEAR", sysNote: [why(o), hold ? `EVA AI: HOLD ${pctHold(hold)}% sure` : ""].filter(Boolean).join(" · "), asked: o.created_by_name || "", o };
      if (o.status === "rejected") Object.assign(r, { act: `HOLD BY ${U(o.approved_by_name)}`, actTone: "rejected", actNote: [E.dateTime(o.approved_at), o.review_note].filter(Boolean).join(" · "), st: "FREEZE ACCOUNT", tone: "rejected" });
      else if (o.status === "pending") Object.assign(r, { act: "WAITING FOR EMON HASAN", actTone: "pending", actNote: o.details?.split("\n")[0] || "", st: "WAITING", tone: "pending" });
      else Object.assign(r, { act: `APPROVED BY ${U(o.approved_by_name)}`, actTone: "approved", actNote: [E.dateTime(o.approved_at), o.review_note].filter(Boolean).join(" · "), st: `CLEARED BY ${U(o.approved_by_name)}`, tone: "approved" });
      rows.push(r);
    }
    for (const e of (events || []).filter((e) => /^GATE PASS GP-/.test(e.note || ""))) rows.push({ at: e.created_at, no: (e.note.match(/GP-\S+/) || [""])[0], sys: "SYSTEM CLEAR", sysTone: "approved", sysNote: e.note.replace(/^GATE PASS \S+\s*·?\s*/, ""),
      act: `GATE PASS ISSUED BY ${U(e.actor_name)}`, actTone: "approved", actNote: "", st: "CLEARED", tone: "approved" });
    // EVA AI said HOLD on a gate pass that was decided without a request (a trusted customer, or EMON HASAN at once)
    const used = new Set((orders || []).filter(isGate).map(aiNear).filter(Boolean).map((l) => l.id));
    for (const l of (ai || []).filter((l) => l.suggestion === "HOLD" && !used.has(l.id) && l.decision)) {
      const ok = l.decision === "CLEAR";
      rows.push({ at: l.created_at, no: "EVA AI", sys: "AI REJECT · HOLD", sysNote: `${pctHold(l)}% sure${l.reasons ? " · " + l.reasons : ""}`,
        act: `${ok ? "CLEARED" : "HOLD"} BY ${U(l.decided_by_name)}`, actTone: ok ? "approved" : "rejected", actNote: ok ? "the AI's HOLD was not agreed" : "agreed with the AI",
        st: ok ? `CLEARED BY ${U(l.decided_by_name)}` : "FREEZE ACCOUNT", tone: ok ? "approved" : "rejected" });
    }
    return rows.sort((x, y) => String(y.when || y.at).localeCompare(String(x.when || x.at)));
  }
  // the gate pass now: the newest line decides (FREEZE ACCOUNT while on hold, CLEARED BY name when cleared)
  function gateNow(rows) {
    const r = rows[0];
    if (!r) return "";
    const cls = r.tone === "approved" ? "ok" : "no";
    return `<div class="gp-verdict gp-now ${cls}"><span>${ic(cls === "ok" ? "check" : r.tone === "pending" ? "clock" : "x")}</span><div><b>${esc(r.st)}</b>
      <small>${esc(r.no)} · System: ${esc(r.sys)} · Action: ${esc(r.act)}${r.actNote ? " · " + esc(r.actNote) : ""}</small></div></div>`;
  }
  // the History tab line of an approved Request for Clearance (the server writes it as "other by <request no>")
  const gateEventLabel = (ev) => (/^other by /i.test(ev.action) && String(ev.note || "").startsWith(GATE) ? `GATE PASS CLEARANCE APPROVED (${ev.action.replace(/^other by /i, "")})` : null);
  function gateHistoryHtml(orders, events, ai = []) {
    const rows = gateHistoryRows(orders, events, ai);
    if (!rows.length) return `<div class="empty">No gate pass or request for clearance yet.</div>`;
    return `${gateNow(rows)}<div class="grid-wrap"><table class="grid gp-hist"><thead><tr><th>Date / Time</th><th>No</th><th>System Result</th><th>Action of EMON HASAN</th><th>Status</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${esc(E.dateTime(r.at))}${r.asked ? `<small>asked by ${esc(r.asked)}</small>` : ""}</td><td>${esc(r.no)}</td>
        <td>${E.pill(r.sysTone || "rejected", r.sys)}${r.sysNote ? `<small>${esc(r.sysNote)}</small>` : ""}</td>
        <td>${E.pill(r.actTone, r.act)}${r.actNote ? `<small>${esc(r.actNote)}</small>` : ""}</td>
        <td>${E.pill(r.tone, r.st)}</td></tr>`).join("")}</tbody></table></div>`;
  }

  // ======================================================================
  // REQUEST menu on the customer profile
  // ======================================================================
  const docNo = (pre, c) => `${pre}-${isoToday().replace(/-/g, "")}-${c.account_no || c.application_no}`;
  const php2 = (n) => `PHP ${peso(n)}`;
  // the status requests: what it is called, who it is for, and what the account becomes
  const STATUS_REQ = {
    suspension: { title: "Restrict Account", sub: "Restrict (suspend) this account: no new invoices until the restriction is lifted", from: ["active"], to: "SUSPENDED (RESTRICTED)", icon: "shield" },
    reactivation: { title: "Lift Restriction", sub: "Make the restricted account active again", from: ["suspended"], to: "ACTIVE", icon: "check" },
    closure: { title: "Close Account", sub: "Close this account (blacklist): no new invoices or deliveries", from: ["active", "suspended"], to: "CLOSED", icon: "x" },
    reopen: { title: "Reopen Account", sub: "Make the closed account active again", from: ["closed"], to: "ACTIVE", icon: "check" }
  };
  const pendingOf = (orders) => (orders || []).filter((o) => STATUS_REQ[o.subject_type] && o.status === "pending");
  const canRequest = () => E.canWrite("customers") || E.canWrite("orders");

  function balancePage(c, ctx, no) {
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
      <p class="cert-body">This certificate is issued upon the request of the account holder.
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
      <p class="cert-body">This certificate is issued upon request. The account can be reopened only with the approval of EMON HASAN of ${esc(C.company.name)}.</p>
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
        <div class="ol-auth${sign?.pic ? " has-sig" : ""}">${sign?.pic ? `<img class="esig" src="${esc(sign.pic)}" alt="Signature">` : ""}<div class="ol-auth-name">${sign ? esc(S.profile?.full_name || "") : ""}</div><div class="line"></div>Approved by · Managing Director${sign ? ` · ${esc(mdy(isoToday()))}` : " / Date"}</div></div>
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
        : "Change the customer's details. The Update Form prints with the old and new details; EMON HASAN approves the change.", isStaff()],
      ["balance", "wallet", "Account Balance Certificate", "The total outstanding balance as of today, with the unpaid invoices", true],
      ...Object.entries(STATUS_REQ).filter(([, x]) => x.from.includes(c.status)).map(([k, x]) => [k, x.icon, x.title,
        wait ? `${wait.order_no} (${STATUS_REQ[wait.subject_type].title}) is waiting for EMON HASAN` : !canRequest() ? "You have no access to make this request" : `${x.sub}. ${isAdmin() ? "As EMON HASAN it is done at once." : "EMON HASAN approves it."}`,
        !wait && canRequest()]),
      ...(c.status === "closed" ? [["closurecert", "doc", "Certificate of Account Closure", "Print the certificate of this closed account", true]] : [])
    ];
    const m = E.modal(`Request — ${fullName(c)} (${c.account_no || ""})`, `<div class="rq-list">${opts.map(([k, icon, t, sub, on]) =>
      `<button type="button" class="rq-opt" data-rq="${k}"${on ? "" : " disabled"}>${ic(icon)}<span><b>${esc(t)}</b><small>${esc(sub)}</small></span></button>`).join("")}</div>`,
      `<button type="button" class="btn" data-x>Close</button>`);
    $("[data-x]", m.el).onclick = m.close;
    $$("[data-rq]", m.el).forEach((b) => (b.onclick = async () => {
      const k = b.dataset.rq; m.close();
      if (k === "update") return E.correctRecord("customers", c, `${c.account_no || c.application_no} ${fullName(c)}`, () => V.customer(c.id), { onSaved: (r) => printUpdate(c, r) });
      await E.loadSignatures().catch(() => {});
      if (k === "balance") { const no = docNo("AB", c); return E.openPreview(`Account Balance Certificate ${no}`, [balancePage(c, ctx, no)]); } // 3.97: only generated (not recorded)
      if (k === "closurecert") {
        const ord = (ctx.orders || []).filter((o) => o.subject_type === "closure" && o.status === "applied").sort((x, y) => String(y.applied_at || y.created_at).localeCompare(String(x.applied_at || x.created_at)))[0];
        const no = docNo("CA", c);
        return issueDoc(c, "Certificate of Account Closure", no, closurePage(c, ctx, no, ord));
      }
      statusForm(c, k, ctx);
    }));
  }
  // Restrict / lift / close / reopen: the reason, then it waits for the Director (the Director's own is done at once)
  function statusForm(c, kind, ctx) {
    const x = STATUS_REQ[kind], bal = num(ctx.b?.balance_due);
    const m = E.modal(`${x.title} — ${fullName(c)}`, `<div class="summary-box"><div class="fields wide"><span>Account</span><b>${esc(c.account_no || "")} · ${esc(String(c.status).toUpperCase())}</b>
        <span>Becomes</span><b>${esc(x.to)}</b><span>Balance Due</span><b class="${bal < 0 ? "neg" : ""}">₱ ${peso(bal)}</b></div></div>
      <div class="fields wide" style="margin-top:10px"><label for="rqWhy">Reason *</label><input type="text" id="rqWhy" maxlength="200" placeholder="${kind === "suspension" ? "e.g. overdue invoices not paid" : kind === "closure" ? "e.g. customer asked to close the account" : "e.g. balance settled"}">
        <label for="rqNote">Note</label><textarea id="rqNote" rows="2" maxlength="600" placeholder="Optional"></textarea></div>
      <p class="muted" style="margin:8px 0 0">${isAdmin() ? "As EMON HASAN, the account changes as soon as you send it." : "EMON HASAN is told and approves or rejects it on this profile."}</p>`,
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
      } else { m.close(); toast(`Request ${o.order_no} sent to EMON HASAN.`); }
      V.customer(c.id);
    };
  }
  // The requests waiting for the Director, shown on the customer profile
  function requestsHtml(c, orders) {
    const list = [...pendingOf(orders), ...(orders || []).filter((o) => isGate(o) && o.status === "pending")];
    if (!list.length) return "";
    return `<div class="rq-wait">${list.map((o) => `<div class="rq-item" data-o="${o.id}"><span>${ic("clock")}</span><div><b>${esc(isGate(o) ? "Request for Clearance (Gate Pass)" : STATUS_REQ[o.subject_type].title)} · ${esc(o.order_no)}</b>
      <small>${esc(o.subject.replace(/^[^:]*:\s*/, ""))}${o.details ? " — " + esc(o.details) : ""} · asked by ${esc(o.created_by_name || "")} on ${esc(mdy(o.order_date))} · waiting for EMON HASAN</small></div>
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

  // 3.18: the account standing next to the customer's name: TRUSTED CUSTOMER (passes every trusted check), NEW ACCOUNT
  // (with us less than TRUST.months) or REGULAR CUSTOMER. A click shows the full record and the trusted checks.
  function standingBadge(el, c, ctx) {
    if (!el) return;
    const a = analyse(c, ctx);
    const [kind, label] = a.trusted ? ["trusted", "TRUSTED CUSTOMER"] : a.months < TRUST.months ? ["new", "NEW ACCOUNT"] : ["regular", "REGULAR CUSTOMER"];
    const sinceTxt = `since ${mdy(a.since)} · ${a.months} month${a.months === 1 ? "" : "s"}`;
    el.innerHTML = `<button type="button" class="stand ${kind}" title="${esc(sinceTxt)} · ${esc(a.rating)}">${ic(kind === "trusted" ? "shield" : kind === "new" ? "plus" : "user")}<b>${label}</b><small>${esc(a.rating)}</small></button>`;
    $("button", el).onclick = () => E.modal(`${label} · ${fullName(c)}`, `<p class="stand-since">Business with us ${esc(sinceTxt)}</p>${analysisHtml(a)}`, "", { wide: true });
  }

  Object.assign(E, { standingBadge, gateCheck, customerRequest, requestsHtml, bindRequests, gateHistoryHtml, gateHistoryRows, gateEventLabel });
})();
