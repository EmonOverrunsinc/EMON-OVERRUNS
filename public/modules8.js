/* EMON OVERRUNS E-PORTAL — Gate Pass Clearance for Delivery (3.5).
   One simple rule on the customer profile: an ACTIVE (open) account that keeps within its credit limit and pays before it is
   overdue is cleared for delivery, and the portal issues a GATE PASS CLEARANCE FOR DELIVERY. Any other account is not cleared
   and the portal says why (suspended or closed, an overdue invoice, over the credit limit). Every gate pass issued is written
   in the customer's history. */
(() => {
  "use strict";
  const E = window.EO;
  const { sb, S, C, esc, peso, isoToday, mdy, $, isAdmin, toast, ic, num, fullName, verifyUrl } = E;

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
  Object.assign(E, { gatePass, gateCheck });
})();
