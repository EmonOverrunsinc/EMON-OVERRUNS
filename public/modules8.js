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
  const { sb, S, C, esc, peso, isoToday, mdy, $, $$, isAdmin, toast, fail, ic, num, fullName, verifyUrl } = E;
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
    return { ok: !reasons.length, reasons, overdue, bal, limit, today };
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

  function gatePage(c, no, g) {
    return `${E.printHead("GATE PASS CLEARANCE FOR DELIVERY", codes(c, no))}
      <div class="cert-no"><span>Gate Pass No: <b>${esc(no)}</b></span><span>Date Issued: <b>${esc(E.dateTime(new Date().toISOString()))}</b></span></div>
      <div class="dc-head gp-clear"><b>CLEARED FOR DELIVERY</b><small>This account is open, within its credit limit and has no overdue invoice.</small></div>
      <p class="cert-to">TO WHOM IT MAY CONCERN:</p>
      <p class="cert-body">This is to certify that the account of <b>${esc(fullName(c).toUpperCase())}</b>, Account No <b class="nw">${esc(c.account_no || "")}</b>, was checked by ${esc(C.company.name)}
        on <span class="nw">${esc(mdy(g.today))}</span>. The account is <b>ACTIVE</b>, ${g.limit != null ? "within its credit limit, " : ""}and every invoice is paid on or before its due date.
        This gate pass clears the delivery of goods to this account on <span class="nw">${esc(mdy(g.today))}</span> only.</p>
      <div class="ol-sec">ACCOUNT</div>
      <table class="ol-grid"><tbody>${tr2("Name of Customer", esc(fullName(c)))}${tr2("Account No", esc(c.account_no || "—"))}${c.business_name ? tr2("Business Name", esc(c.business_name)) : ""}
        ${tr2("Account Status", "ACTIVE")}${tr2("Credit Limit", g.limit != null ? `PHP ${peso(g.limit)}` : "No limit set")}
        ${tr2("Balance Due Today", `PHP ${peso(Math.max(g.bal, 0))}`)}${tr2("Overdue Invoices", "None")}</tbody></table>
      <p class="pdecl">A new gate pass is issued for each delivery day. The warehouse releases the goods only against a gate pass of the day of delivery.</p>
      ${issuerBlock()}
      <div class="rp-foot"><span>Scan the QR code to check this account online.</span><span>${esc(no)}</span></div>`;
  }

  async function gatePass(c, ctx) {
    const g = gateCheck(c, ctx);
    const m = E.modal(`Gate Pass — ${fullName(c)} (${c.account_no || ""})`, `
      <div class="gp-verdict ${g.ok ? "ok" : "no"}"><span>${ic(g.ok ? "check" : "x")}</span><div><b>${g.ok ? "CLEARED FOR DELIVERY" : "NOT CLEARED FOR DELIVERY"}</b>
        <small>${g.ok ? "The account is open, within its credit limit and has no overdue invoice." : "A gate pass cannot be issued yet."}</small></div></div>
      <div class="summary-box"><div class="fields wide"><span>Account Status</span><b>${esc(String(c.status).toUpperCase())}</b>
        <span>Credit Limit</span><b>${g.limit != null ? "₱ " + peso(g.limit) : "No limit set"}</b>
        <span>Balance Due</span><b class="${g.bal < 0 ? "neg" : ""}">₱ ${peso(g.bal)}</b>
        <span>Overdue Invoices</span><b>${g.overdue.length ? g.overdue.length : "None"}</b></div></div>
      ${g.reasons.length ? `<ul class="gp-why">${g.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}`,
      `<button type="button" class="btn" data-x>Close</button>${g.ok ? `<button type="button" class="btn primary" data-ok>${ic("print")} Issue Gate Pass</button>` : ""}`);
    $("[data-x]", m.el).onclick = m.close;
    if (g.ok) $("[data-ok]", m.el).onclick = async () => {
      m.close();
      await E.loadSignatures().catch(() => {});
      const no = stampNo(c);
      E.openPreview(`Gate Pass ${no}`, [gatePage(c, no, g)]);
      sb.rpc("log_customer_document", { p_customer: c.id, p_document: `GATE PASS ${no}`, p_note: `Cleared for delivery · balance PHP ${peso(g.bal)}` }).then(() => {}, () => {});
    };
  }
  // ======================================================================
  // REQUEST menu on the customer profile
  // ======================================================================
  const docNo = (pre, c) => { const d = new Date(), p2 = (n) => String(n).padStart(2, "0"); return `${pre}-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${c.account_no || c.application_no}`; };
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
    const when = ord?.applied_at ? mdy(E.isoDay(new Date(ord.applied_at))) : ord?.order_date ? mdy(ord.order_date) : "";
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
  // Print a document and write it in the customer's history
  const issueDoc = (c, title, no, page, note) => {
    E.openPreview(`${title} ${no}`, [page]);
    sb.rpc("log_customer_document", { p_customer: c.id, p_document: `${title.toUpperCase()} ${no}`, p_note: note || null }).then(() => {}, () => {});
  };

  // The Request menu. ctx: { b, invs, orders }
  function customerRequest(c, ctx) {
    const wait = pendingOf(ctx.orders)[0];
    const opts = [
      ["balance", "wallet", "Account Balance Certificate", "The total outstanding balance as of today, with the unpaid invoices", true],
      ["gate", "check", "Gate Pass", "Gate Pass Clearance for Delivery (only for an open account with no overdue invoice, within its credit limit)", true],
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
    const list = pendingOf(orders);
    if (!list.length) return "";
    return `<div class="rq-wait">${list.map((o) => `<div class="rq-item" data-o="${o.id}"><span>${ic("clock")}</span><div><b>${esc(STATUS_REQ[o.subject_type].title)} · ${esc(o.order_no)}</b>
      <small>${esc(o.subject.replace(/^[^:]*:\s*/, ""))}${o.details ? " — " + esc(o.details) : ""} · asked by ${esc(o.created_by_name || "")} on ${esc(mdy(o.order_date))} · waiting for the Director</small></div>
      ${isAdmin() ? `<button type="button" class="btn small primary" data-ap="${o.id}">${ic("check")} Approve</button><button type="button" class="btn small danger" data-rj="${o.id}">${ic("x")} Reject</button>` : ""}</div>`).join("")}</div>`;
  }
  function bindRequests(c, orders) {
    const by = (id) => (orders || []).find((o) => o.id === id);
    $$("[data-ap]").forEach((b) => (b.onclick = async () => {
      const o = by(b.dataset.ap); if (!o) return;
      if (!(await E.confirmBox(`Approve <b>${esc(STATUS_REQ[o.subject_type].title)}</b> (${esc(o.order_no)})? Account <b>${esc(c.account_no)}</b> becomes <b>${esc(STATUS_REQ[o.subject_type].to)}</b>.`, { ok: "Approve" }))) return;
      const { error } = await sb.rpc("review_order_letter", { p_id: o.id, p_action: "approve", p_note: null });
      if (error) return fail(error, "Could not approve");
      toast(`Approved: account ${c.account_no} is now ${STATUS_REQ[o.subject_type].to}.`); V.customer(c.id);
    }));
    $$("[data-rj]").forEach((b) => (b.onclick = async () => {
      const o = by(b.dataset.rj); if (!o) return;
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

  Object.assign(E, { gatePass, gateCheck, customerRequest, requestsHtml, bindRequests });
})();
