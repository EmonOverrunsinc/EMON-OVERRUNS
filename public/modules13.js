/* EMON OVERRUNS E-PORTAL — 3.69: LEGAL TERMS, DATA PRIVACY, CONFIDENTIALITY AND ELECTRONIC SIGNATURE CONSENT.
   After signing in, every login reads the terms, ticks "I have read all and I agree" and presses Submit. The server keeps
   each acceptance for good (073_legal_terms.sql): who, the version and SHA-256 fingerprint of the exact text, date and
   time, device and IP address. Legal Terms (menu OTHER): EMON HASAN sees and finds every acceptance and who has not
   accepted yet, and prints any of them; every other login sees the terms and their own acceptance. */
(function () {
  "use strict";
  const E = window.EO, V = (window.EO_VIEWS = window.EO_VIEWS || {});
  const { sb, S, C, esc, $, $$, isAdmin, toast, fail, ic, busy } = E;

  // 3 agreements: PORTAL TERMS OF USE (every login), EMPLOYEE AGREEMENT (employees and staff, besides the portal terms) and
  // CUSTOMER AGREEMENT (customers, by Public ID + Private PIN). Each has its own version and record.
  // the current version comes from the server (company_settings.legal_version, 078) so the screen and the server rule
  // always ask for the same one; a new version = everyone agrees again
  let REL = "3.72 · NOVEMBER 02 2026";
  let synced = null;
  const syncVersion = () => (synced ||= sb.from("company_settings").select("legal_version").eq("id", 1).maybeSingle()
    .then(({ data, error }) => { if (!error && data?.legal_version) REL = data.legal_version; }, () => {}));
  syncVersion();
  const isCurrent = (v) => String(v || "").endsWith(" " + REL);
  const TYPES = { portal: "PORTAL TERMS OF USE", employee: "EMPLOYEE AGREEMENT", customer: "CUSTOMER AGREEMENT" };
  const VER = (t) => `${t.toUpperCase()} ${REL}`;
  const typeOf = (v) => (/^EMPLOYEE /.test(v || "") ? "employee" : /^CUSTOMER /.test(v || "") ? "customer" : "portal");
  const needsOf = (p) => (p?.role === "staff" ? ["portal", "employee"] : ["portal"]);
  const co = () => C.company.name;
  const addr = () => C.company.address.join(", ");

  // ---------- the terms (one text: what is shown, printed and fingerprinted) ----------
  const SECTIONS = () => [
    ["SUMMARY", `<div class="lg-warn"><b>IMPORTANT.</b> Everything in this portal is <b>CONFIDENTIAL</b> property of ${esc(co())}. You must <b>NOT</b> leak, share, copy, photograph,
      screenshot, forward or sell any data from it. Doing so is a <b>crime punishable by law</b> in the Philippines (Data Privacy Act of 2012, Cybercrime Prevention Act of 2012,
      Revised Penal Code) and in other countries, with imprisonment and fines, besides dismissal and damages. Your approved signatures are your <b>electronic signature</b>
      and are as valid as your handwritten signature on every document made in this portal.
      Every record made in the portal — invoices, payments, charges and all other data — is <b>valid as an original</b>; if you see any mistake, <b>contact the office
      immediately</b>; failure to pay allows legal action. All information you give must be <b>true</b>, and an employee is <b>responsible for every record they submit</b>.</div>`],
    ["1. ABOUT THE PORTAL AND THESE TERMS", `<p>The EMON OVERRUNS E-PORTAL (the "Portal"), its website, Windows and Android apps are owned and run by <b>${esc(co())}</b>, ${esc(addr())}, Philippines,
      managed by <b>EMON HASAN</b>, Managing Director, who is the Personal Information Controller and Data Protection Officer (${esc(C.company.email)}).</p>
      <p>These terms bind every person who signs in: the Managing Director, employees, staff, applicants, customers, billing companies and any other user ("you").
      By ticking <b>"I have read all and I agree"</b> and pressing <b>Submit</b> you accept all of them. If you do not agree, sign out and do not use the Portal.</p>`],
    ["2. TERMS OF USE", `<ol>
      <li>Use the Portal only for your work or business with ${esc(co())} and only in the menus given to you.</li>
      <li>Your login, password and ID card are personal. Never share them or let another person use them. Everything done with your login is your act.</li>
      <li>Every action is recorded on the server: who, what, date and time, device and internet (IP) address. Screens carry your name and every print carries
        "Printed by" with your name. Printing and downloading of protected records needs the approval of EMON HASAN.</li>
      <li>It is forbidden to: get into records or menus not given to you; try to break, test or go around the security; copy or export data in bulk; take photos or
        screenshots of screens; send data to personal email, chat or social media; or use any data for yourself, another business or a competitor.</li>
      <li>${esc(co())} may stop or remove any login at any time to protect the business and its customers.</li></ol>`],
    ["3. DATA PRIVACY NOTICE AND CONSENT (REPUBLIC ACT No. 10173)", `<p><b>What we collect:</b> names, addresses, phone numbers, email, birth date, photos, IDs and documents, specimen and approved signatures,
      employment and payroll data, customer accounts and money records (orders, invoices, payments, balances, statements), delivery records and photos, location
      checks, and for every login: device, browser, IP address and the time of each action.</p>
      <p><b>Why:</b> to run the business (customer accounts, orders, delivery, billing and collection, payroll and human resources), to check and verify documents,
      to keep the Portal secure, to prevent fraud, and to follow the law (for example tax and labor rules).</p>
      <p><b>Legal basis:</b> your consent, the contract with you, legal obligations and the legitimate interests of ${esc(co())} (Sections 12 and 13 of the Data Privacy Act of 2012).</p>
      <p><b>Where and how long:</b> on secure cloud servers in Singapore with encrypted connections and access only by menu. ${esc(co())} stays responsible for this
      transfer (Section 21). Records are kept while needed for these purposes and as long as the law requires (for example books of accounts for the Bureau of
      Internal Revenue), then deleted or made anonymous.</p>
      <p><b>Your rights:</b> to be informed, to access, to object, to correct, to erasure or blocking, to data portability, to damages, and to complain to the
      National Privacy Commission (privacy.gov.ph). Write to EMON HASAN at ${esc(C.company.email)}. Some records cannot be erased while the law requires
      them to be kept.</p>
      <p><b>Other countries:</b> where a user, customer or record is under the laws of another country, the stricter rule applies, including where applicable the
      EU General Data Protection Regulation (EU) 2016/679, the UK GDPR, the Singapore Personal Data Protection Act 2012, the data protection and cyber security laws
      of Bangladesh, and the privacy laws of the United States and of any other country concerned.</p>`],
    ["4. CONFIDENTIALITY AND NON-DISCLOSURE", `<ol>
      <li>All information in the Portal is confidential and belongs to ${esc(co())}: customers and their accounts, balances, purchase history, prices, suppliers,
        stock, orders, deliveries, payroll, employees and every document.</li>
      <li>You must <b>NOT</b> leak, disclose, share, copy, photograph, screenshot, record, print without approval, forward, sell or use it for any purpose other
        than your work — during your work and <b>after it ends</b>, with no time limit.</li>
      <li><b>Leaking or sharing data is punishable by law</b>, including: Republic Act No. 10173 (Data Privacy Act of 2012), Sections 25 to 33 — unauthorized processing,
        access due to negligence, unauthorized purposes, intentional breach, malicious and unauthorized disclosure — with imprisonment of up to six (6) years and fines
        of up to five million pesos (PHP 5,000,000) per offense; Republic Act No. 10175 (Cybercrime Prevention Act of 2012) — illegal access, data interference and misuse
        of devices; the Revised Penal Code, Articles 290 to 292 — discovery and revelation of secrets, including industrial secrets; and the laws of any other country
        where the act is done or felt.</li>
      <li>A breach is also a just cause for dismissal (Labor Code, Article 297: serious misconduct, fraud or willful breach of trust) and makes you liable for all
        damages, costs and attorney's fees under the Civil Code.</li>
      <li>Report at once to EMON HASAN any loss, leak, wrong access or lost phone or ID card (within 24 hours). When your work ends, return or delete all company data.</li></ol>`],
    ["5. ELECTRONIC SIGNATURE CONSENT", `<ol>
      <li>Under Republic Act No. 8792 (Electronic Commerce Act of 2000, Sections 7 and 8) and the Rules on Electronic Evidence (A.M. No. 01-7-01-SC), an electronic
        signature has the same legal effect as a handwritten signature.</li>
      <li>You agree that your <b>three (3) specimen signatures</b> given on your application or Signature Verification Form, and your signature submitted and
        approved by EMON HASAN in the Portal, are <b>your electronic signature</b>.</li>
      <li>Every document made, submitted or approved in the Portal that carries your signature or your name as the person who made, submitted, approved, completed,
        received or printed it — orders, invoices, receipts, vouchers, delivery records, gate passes, payslips, certificates, requests, acknowledgments and all
        others — is <b>valid and binding like a document signed by your own hand</b>, and you will not deny it.</li>
      <li>Pressing Submit, Approve, Complete or any similar button with your login is your signed act.</li>
      <li>This consent is also given under the laws of other countries where they apply, including the US ESIGN Act and UETA, the EU eIDAS Regulation (EU) No 910/2014,
        the Singapore Electronic Transactions Act and the Bangladesh Information and Communication Technology Act 2006.</li>
      <li>You may withdraw this consent in writing to EMON HASAN; you then stop using the Portal. Documents signed before stay valid.</li></ol>`],
    ["6. RECORDS MADE IN THE PORTAL, CHARGES AND PAYMENT", `<ol>
      <li>Every record that ${esc(co())} or EMON HASAN makes, adds or approves in the Portal — customer accounts, orders, delivery records, invoices, payments received,
        receipts, credit memos and returns, additional charges, settlement adjustments, statements of account, balance certificates, gate passes, e-bills, vouchers,
        payroll and every other record or system data — is an <b>official business record</b> of ${esc(co())}, made in the regular course of business, and is
        <b>valid and binding as an original document</b> (Republic Act No. 8792 and the Rules on Electronic Evidence), also when it is printed, downloaded, sent by
        email or checked by its QR code or barcode.</li>
      <li>You agree that the amounts, charges, quantities, dates and balances in these records are <b>true and correct</b>, and that the balance shown on your account
        and statement of account is the amount you owe.</li>
      <li><b>If there is any mistake or issue</b> in a record, you must <b>contact the office of ${esc(co())} IMMEDIATELY</b> (${esc(addr())} · ${esc(C.company.email)}) so it can be
        checked and fixed. A record not questioned in writing within seven (7) days from the day you receive or can see it is taken as correct and accepted by you.</li>
      <li>Every invoice and charge must be paid in full on or before its due date. <b>If you fail to pay</b>, ${esc(co())} may, without further notice: hold or stop
        deliveries (gate pass FREEZE ACCOUNT), suspend or close the account, add the charges and adjustments allowed by the agreement, send collection letters, refer
        the account to collection, and <b>take legal action against you</b> — including a civil case or small claims case for the amount due, with interest, damages,
        costs of collection and attorney's fees — and file a criminal complaint where the law allows (for example under Batas Pambansa Blg. 22 for a bounced check,
        or for estafa under the Revised Penal Code).</li>
      <li>These records may be used as evidence before any barangay, office, agency or court in the Philippines or in another country.</li></ol>`],
    ["7. THE INFORMATION YOU GIVE IS TRUE", `<ol>
      <li>You declare that <b>all information and documents you give</b> to ${esc(co())} — in your application, IDs, address, phone, business details, photos,
        signatures, orders, payments, receipts and every message — are <b>true, correct and complete</b>, and are yours or given with the owner's permission.</li>
      <li>You will tell the office at once when any of it changes (address, phone, business, authorized persons).</li>
      <li>Giving false, misleading or incomplete information is a ground to refuse, suspend or close your account and to stop deliveries, and may be punishable
        by law (for example falsification or estafa under the Revised Penal Code). You are responsible for any loss it causes.</li></ol>`],
    ["8. FOR EMPLOYEES AND STAFF: RESPONSIBILITY FOR WHAT YOU RECORD", `<ol>
      <li>Before you submit any record — customer, order, delivery, box, invoice, payment, receipt, charge, credit memo, purchase order, QC test, payroll, upload
        or any other data — <b>you check it</b>. Pressing Submit, Save, Approve or Complete means <b>you have verified that it is true, correct and complete</b>.</li>
      <li>If a record you made is <b>misleading, has missing information or is mistaken</b>, you <b>directly agree that you are responsible for it</b> and accept the
        blame for that record and for any problem it causes, including liability for the loss as allowed by law, disciplinary action under the company rules and the
        Labor Code, and legal action where the law allows.</li>
      <li>Every record keeps your name, the date and time, your device and IP address (made by, submitted by, completed by, printed by). This is proof of who
        recorded it, and you will not deny a record made with your login.</li>
      <li>When you find a mistake, report it at once to EMON HASAN and ask for a correction in the portal. Never change, hide or delete a record to cover a mistake.</li></ol>`],
    ["9. RECORD OF YOUR ACCEPTANCE", `<p>When you press Submit, the server keeps for good: your name, email, role, the date and time, your device and browser, your IP address, the version of these
      terms and the fingerprint (SHA-256) of their exact text, with an acceptance number (LT-…). Nobody can change or delete it. It is proof of your consent and
      may be used by ${esc(co())} before any office or court. You can see and print your acceptance any time in the menu <b>Legal Terms</b>.</p>`],
    ["10. CHANGES AND GOVERNING LAW", `<p>When these terms change, a new version is shown and must be accepted again. These terms are governed by the laws of the Republic of the Philippines;
      the courts of Pasay City, Metro Manila, have jurisdiction. If one part is held invalid, the rest stays in force.</p>`]
  ];
  const WHO = { portal: "every person who signs in to the Portal: the Managing Director, employees, staff, applicants and any other user",
    employee: "every employee and staff member of " + co() + " who uses the Portal, during the work and after it ends",
    customer: "every customer of " + co() + ", its owners and authorized persons, and anyone who signs in with the customer's Public ID and Private PIN" };
  const SUMMARY = {
    portal: () => SECTIONS()[0][1],
    employee: () => `<div class="lg-warn"><b>IMPORTANT FOR EVERY EMPLOYEE.</b> <b>Check every record before you submit it.</b> By submitting you confirm it is <b>true, correct and complete</b>;
      if it is <b>misleading, missing information or mistaken, you are responsible and accept the blame</b> for it. Everything in the portal is <b>CONFIDENTIAL</b>: leaking or sharing
      it is a <b>crime punishable by law</b>, besides dismissal and damages. Your approved signatures and every action with your login are your <b>electronic signature</b>, valid like
      your handwritten signature.</div>`,
    customer: () => `<div class="lg-warn"><b>IMPORTANT FOR EVERY CUSTOMER.</b> All information you give must be <b>true</b>. Every record of your account — orders, deliveries,
      invoices, payments, charges, adjustments and statements — is <b>valid as an original document</b>. If you see any mistake, <b>contact the office of ${esc(co())} IMMEDIATELY</b>.
      Pay every invoice on time: <b>failure to pay allows legal action</b>. Your signatures and everything done with your Public ID and Private PIN bind you. Your personal data is
      protected under the Data Privacy Act of 2012.</div>` };
  const about = (t) => `<p>The EMON OVERRUNS E-PORTAL (the "Portal"), its website, Windows and Android apps are owned and run by <b>${esc(co())}</b>, ${esc(addr())}, Philippines,
      managed by <b>EMON HASAN</b>, Managing Director, who is the Personal Information Controller and Data Protection Officer (${esc(C.company.email)}).</p>
      <p>This <b>${esc(TYPES[t])}</b> binds ${esc(WHO[t])} ("you"). By ticking <b>"I have read all and I agree"</b> and pressing <b>Submit</b> you accept all of it.
      If you do not agree, sign out and do not use the Portal.</p>`;
  const PIN = () => `<ol><li>Your <b>Public ID</b> (QR code) and your <b>Private PIN</b> open your account. Keep your Private PIN secret; never give it to another person.</li>
      <li>Every sign in, agreement and confirmation made with your Public ID and Private PIN is <b>your act</b>.</li>
      <li>If you lose your papers or someone knows your Private PIN, tell the office at once to get a new one. 5 wrong Private PINs lock the sign in for 15 minutes.</li></ol>`;
  const ESIGN_CUST = () => `<ol><li>Under Republic Act No. 8792 (Electronic Commerce Act of 2000) and the Rules on Electronic Evidence (A.M. No. 01-7-01-SC), an electronic signature has the same
      legal effect as a handwritten signature.</li>
      <li>Your signatures on your <b>Customer Application Form</b> and on orders, delivery receipts and other papers, kept in the Portal, and every agreement or confirmation you
      make with your Public ID and Private PIN, are <b>valid and binding like your handwritten signature</b>, and you will not deny them.</li></ol>`;
  function sectionsFor(t) {
    const x = Object.fromEntries(SECTIONS().map(([h, b]) => [h.replace(/^\d+\.\s*/, ""), b]));
    const k = (name) => [name, x[name]];
    const list = {
      portal: [["ABOUT THE PORTAL AND THESE TERMS", about(t)], k("TERMS OF USE"), k("DATA PRIVACY NOTICE AND CONSENT (REPUBLIC ACT No. 10173)"), k("CONFIDENTIALITY AND NON-DISCLOSURE"),
        k("ELECTRONIC SIGNATURE CONSENT"), k("RECORDS MADE IN THE PORTAL, CHARGES AND PAYMENT"), k("THE INFORMATION YOU GIVE IS TRUE"), k("RECORD OF YOUR ACCEPTANCE"), k("CHANGES AND GOVERNING LAW")],
      employee: [["ABOUT THE PORTAL AND THIS AGREEMENT", about(t)], ["RESPONSIBILITY FOR WHAT YOU RECORD", x["FOR EMPLOYEES AND STAFF: RESPONSIBILITY FOR WHAT YOU RECORD"]],
        k("CONFIDENTIALITY AND NON-DISCLOSURE"), k("ELECTRONIC SIGNATURE CONSENT"), k("RECORDS MADE IN THE PORTAL, CHARGES AND PAYMENT"), k("THE INFORMATION YOU GIVE IS TRUE"),
        k("RECORD OF YOUR ACCEPTANCE"), k("CHANGES AND GOVERNING LAW")],
      customer: [["ABOUT THE PORTAL AND THIS AGREEMENT", about(t)], k("THE INFORMATION YOU GIVE IS TRUE"), ["YOUR ACCOUNT RECORDS, CHARGES AND PAYMENT", x["RECORDS MADE IN THE PORTAL, CHARGES AND PAYMENT"]],
        ["YOUR PUBLIC ID AND PRIVATE PIN", PIN()], k("DATA PRIVACY NOTICE AND CONSENT (REPUBLIC ACT No. 10173)"), ["ELECTRONIC SIGNATURE CONSENT", ESIGN_CUST()],
        k("RECORD OF YOUR ACCEPTANCE"), k("CHANGES AND GOVERNING LAW")] }[t];
    return [["SUMMARY", SUMMARY[t]()], ...list.map(([h, b], i) => [`${i + 1}. ${h}`, b])];
  }
  const termsHtml = (t = "portal") => sectionsFor(t).map(([h, b]) => `<section class="lg-sec"><h4>${esc(h)}</h4>${b}</section>`).join("");
  const plain = (t = "portal") => { const d = document.createElement("div"); d.innerHTML = `${VER(t)}\n${termsHtml(t)}`; return d.textContent.replace(/\s+/g, " ").trim(); };
  async function sha256(text) {
    if (window.crypto?.subtle) {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    // no secure context (very old browser): a plain 64-hex fingerprint of the text so the record still names the text
    let h = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f, 0x165667b1, 0xd3a2646c];
    for (let i = 0; i < text.length; i++) h = h.map((x, k) => Math.imul(x ^ text.charCodeAt(i), 16777619 + k * 2) >>> 0);
    return h.map((x) => x.toString(16).padStart(8, "0")).join("");
  }
  const device = () => {
    const ua = navigator.userAgent || "";
    const os = /Android/i.test(ua) ? "Android" : /iPhone|iPad/i.test(ua) ? "iPhone/iPad" : /Windows/i.test(ua) ? "Windows" : /Mac OS/i.test(ua) ? "Mac" : /Linux/i.test(ua) ? "Linux" : "Other";
    const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
    const app = /Electron/i.test(ua) ? " · Windows app" : /; wv\)/.test(ua) ? " · Android app" : "";
    return `${os} · ${br}${app} · screen ${screen.width}x${screen.height} · ${ua}`.slice(0, 400);
  };

  // 3.71: what the device can tell (kept with the agreement)
  const deviceDetails = () => {
    const ua = navigator.userAgent || "";
    let tz = ""; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (_) {}
    return { device: device().split(" · ").slice(0, 3).join(" · "), screen: `${screen.width}x${screen.height}`, time_zone: tz, language: navigator.language || "",
      platform: navigator.userAgentData?.platform || navigator.platform || "", touch: (navigator.maxTouchPoints || 0) > 0, cpu_cores: navigator.hardwareConcurrency || null,
      local_time: new Date().toString().slice(0, 60), user_agent: ua.slice(0, 300) };
  };
  // the location, when the phone or computer allows it (asks the person); never blocks for long
  const getLocation = () => new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({ status: "not available on this device" });
    let done = false; const end = (v) => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => end({ status: "no answer from the device" }), 9000);
    navigator.geolocation.getCurrentPosition(
      (p) => end({ status: "allowed", lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), accuracy_m: Math.round(p.coords.accuracy || 0), at: new Date(p.timestamp || Date.now()).toISOString() }),
      (e) => end({ status: e && e.code === 1 ? "not allowed by the person" : "not available" }), { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
  });
  const locText = (l) => (!l ? "—" : l.status === "allowed" ? `${l.lat}, ${l.lng} (within ${l.accuracy_m} m) · maps.google.com/?q=${l.lat},${l.lng}` : String(l.status || "—").toUpperCase());
  // the signature pad (finger, pen or mouse)
  function sigPad(canvas) {
    const ctx = canvas.getContext("2d"); let drawing = false, last = null, inked = false;
    const fit = () => { const r = canvas.getBoundingClientRect(); canvas.width = Math.max(300, Math.round(r.width * 2)); canvas.height = Math.round(canvas.width * 0.32);
      ctx.lineWidth = 5; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#0b1f4d"; ctx.clearRect(0, 0, canvas.width, canvas.height); inked = false; };
    const pt = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * (canvas.width / r.width), (e.clientY - r.top) * (canvas.height / r.height)]; };
    canvas.addEventListener("pointerdown", (e) => { e.preventDefault(); canvas.setPointerCapture?.(e.pointerId); drawing = true; last = pt(e); });
    canvas.addEventListener("pointermove", (e) => { if (!drawing) return; const p2 = pt(e); ctx.beginPath(); ctx.moveTo(...last); ctx.lineTo(...p2); ctx.stroke(); last = p2; if (!inked) { inked = true; canvas.dispatchEvent(new Event("inked")); } });
    const up = () => { drawing = false; }; canvas.addEventListener("pointerup", up); canvas.addEventListener("pointerleave", up); canvas.addEventListener("pointercancel", up);
    requestAnimationFrame(fit);
    return { clear: () => { fit(); canvas.dispatchEvent(new Event("inked")); }, inked: () => inked, png: () => canvas.toDataURL("image/png") };
  }

  // ---------- the print: the terms, and the acceptance when there is one ----------
  function pages(acc, t = "portal") {
    if (acc) t = typeOf(acc.terms_version);
    const head = E.printHead(TYPES[t], `<div class="mono">${esc(acc?.ref_no || "VERSION " + VER(t))}</div>`);
    const secs = sectionsFor(t);
    const one = (list, first) => `${first ? head : ""}<div class="lg-print">${list.map(([h, b]) => `<section class="lg-sec"><h4>${esc(h)}</h4>${b}</section>`).join("")}</div>`;
    const d = acc?.details || {};
    const accBox = acc ? `<div class="lg-print"><section class="lg-sec lg-acc"><h4>AGREEMENT RECORD</h4><table class="ol-grid"><tbody>
        ${[["Acceptance No", acc.ref_no], ["Agreement", TYPES[t]], ["Version", acc.terms_version], ["Name", acc.full_name], ["Role", acc.role === "admin" ? "Managing Director (full access)" : acc.role === "staff" ? "Employee (staff)" : acc.role],
          ["Email", acc.email || d.email], ["Username", d.username], ["Employee No", d.employee_no], ["Position", d.position], ["Account No", d.account_no], ["Application No", d.application_no],
          ["Business Name", d.business_name], ["Phone", d.phone], ["Public ID", d.public_id], ["Login ID", d.login_id || acc.user_id], ["Customer ID", d.customer_id || acc.customer_id],
          ["Agreed On (Date and Time)", `${E.dateTime(acc.accepted_at)} (Philippine time)`], ["Agreed", "YES — \"I have read all and I agree\" ticked and submitted"],
          ["Location", acc.location?.status === "allowed" ? locText(acc.location) : ""], ["IP Address", acc.ip_address || "—"], ["Device", d.device || String(acc.device || "").split(" · ").slice(0, 3).join(" · ")],
          ["Screen · Language · Time Zone", [d.screen, d.language, d.time_zone].filter(Boolean).join(" · ")], ["Device Local Time", d.local_time], ["Browser", d.user_agent || acc.device],
          ["Text Fingerprint (SHA-256)", acc.terms_hash]].filter(([, v]) => v != null && v !== "").map(([k, v]) => `<tr><th>${esc(String(k).toUpperCase())}</th><td>${esc(String(v).toUpperCase())}</td></tr>`).join("")}
      </tbody></table>
      <p class="pdecl">THIS RECORD WAS MADE BY THE EMON OVERRUNS E-PORTAL SERVER WHEN THE PERSON ABOVE PRESSED SUBMIT. IT CANNOT BE CHANGED OR DELETED. IT IS AN ELECTRONIC DOCUMENT AND AN ELECTRONIC SIGNATURE UNDER REPUBLIC ACT NO. 8792.</p></section></div>` : "";
    const out = [one(secs.slice(0, 3), true)];
    for (let i = 3; i < secs.length; i += 2) out.push(one(secs.slice(i, i + 2), false));
    out[out.length - 1] += accBox;
    return out;
  }
  const printTerms = (acc, t = "portal") => E.openPreview(acc ? `${TYPES[typeOf(acc.terms_version)]} ${acc.ref_no} ${acc.full_name || ""}` : `${TYPES[t]} ${REL}`, pages(acc, t));

  // ---------- the popup after signing in ----------
  let checking = null;
  // 3.70: true when this login has agreed to everything it needs; false while an agreement is waiting (the portal is not
  // drawn behind it: nothing can be used until they agree; Reject signs them out)
  async function legalGate() {
    if (!S.session || !S.profile) return false;
    if (S.legalOk === S.profile.id) return true;
    if ($(".legal-ov")) return false;
    if (checking) return checking;
    checking = (async () => {
      await syncVersion();
      const needs = needsOf(S.profile);
      const { data, error } = await sb.from("legal_acceptances").select("terms_version").eq("user_id", S.profile.id).in("terms_version", needs.map(VER));
      if (error) { if (/legal_acceptances|does not exist|schema cache|42P01|PGRST20/.test(error.message + (error.code || ""))) { S.legalOk = S.profile.id; return true; } return false; } // the server has not 073 yet
      const have = new Set((data || []).map((r) => r.terms_version));
      let missing = needs.filter((t) => !have.has(VER(t)));
      // the portal terms agreed on the Create Account form (kept with the account): the record is made now, without asking again
      const meta = S.session.user?.user_metadata || {};
      if (missing.includes("portal") && meta.legal_agreed === VER("portal")) {
        const r = await sb.rpc("accept_legal_terms", { p_version: VER("portal"), p_hash: await sha256(plain("portal")), p_device: `${device()} · agreed on the Create Account form ${meta.legal_agreed_at || ""}`.slice(0, 400) });
        if (!r.error) missing = missing.filter((t) => t !== "portal");
      }
      if (!missing.length) { S.legalOk = S.profile.id; return true; }
      show({ type: missing[0], step: needs.length > 1 ? `${needs.indexOf(missing[0]) + 1} of ${needs.length}` : "" });
      return false;
    })().finally(() => { checking = null; });
    return checking;
  }
  function show(opts = {}) {
    const who = opts.who || S.profile?.full_name || S.profile?.email || "";
    const t = opts.type || "portal";
    const ov = document.createElement("div");
    ov.className = "legal-ov";
    ov.innerHTML = `<div class="legal-win" role="dialog" aria-modal="true" aria-labelledby="lgTitle">
      <div class="legal-head">${E.logoHtml("lg-logo")}<div><b id="lgTitle">${esc(TYPES[t])}${opts.step ? ` <span class="lg-step">${esc(opts.step)}</span>` : ""}</b><small>${esc(co())} E-PORTAL · Version ${esc(VER(t))}</small></div></div>
      <div class="legal-body" id="lgBody" tabindex="0">${termsHtml(t)}<p class="lg-end">— END OF THE ${esc(TYPES[t])} —</p></div>
      <div class="legal-foot">
        <label class="lg-agree"><input type="checkbox" id="lgAgree"> <span><b>I have read all and I agree</b> to all of this ${esc(TYPES[t])}.</span></label>
        <small class="muted">${ic("shield")} When you submit, your IDs, device, IP address and location (if your device allows it) are kept with your agreement.</small>
        <div class="btnrow"><button type="button" class="btn" id="lgPrint">${ic("print")} Print / Download</button><button type="button" class="btn danger" id="lgOut">${ic("x")} Reject</button>
          <button type="button" class="btn primary" id="lgSubmit" disabled>${ic("check")} Submit</button></div>
        <small class="muted">Signed in as ${esc(who)}. ${opts.onSubmit ? "Your account opens only after you agree." : "The portal opens only after you agree."} <b>Reject</b> signs you out; the agreement shows again at your next sign in. <b class="lg-strict">Not agreed in <span class="lg-timer">3:00</span> = signed out.</b></small></div></div>`;
    document.body.appendChild(ov);
    let pad = null;
    // 3.75.1: STRICT: not agreed within 3 minutes = signed out (a login only; a customer goes back to its sign in)
    const LIMIT = window.EO_LEGAL_LIMIT || 180; // (a test can make it shorter)
    let left = LIMIT;
    const tick = setInterval(async () => {
      if (!ov.isConnected) return clearInterval(tick);
      left--;
      const t = $(".lg-timer", ov); if (t) t.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
      if (left > 0) return;
      clearInterval(tick); ov.remove();
      if (opts.onSubmit) { toast("Not agreed in time. Sign in again to agree.", true); return opts.onOut?.(); }
      S.legalOk = null;
      await sb.auth.signOut({ scope: "local" });
      toast("Not agreed in time: you are signed out. You can use the portal only after you agree.", true);
    }, 1000);
    // the Submit button is always visible: grey until "I agree" is ticked (and the employee signs), then blue
    const ready = () => {
      const btn = $("#lgSubmit", ov), off = !$("#lgAgree", ov).checked;
      btn.disabled = off;
      btn.style.cssText = off ? "background:#8fa1c4;border-color:#8fa1c4;color:#fff;opacity:1;cursor:not-allowed" : "background:#0a66c2;border-color:#0a66c2;color:#fff;opacity:1";
      btn.title = off ? "Tick \"I have read all and I agree\" first" : "";
    };
    ready();
    $("#lgAgree", ov).onchange = (e) => {
      ready();
    };
    $("#lgOut", ov).onclick = async () => {
      if (!(await E.confirmBox(`<b>Reject the ${esc(TYPES[t])}?</b><br><br>You will be signed out now. You cannot use the portal until you agree. The rejection is recorded.`, { title: "Reject", ok: "Reject and Sign Out", danger: true }))) return;
      ov.remove();
      if (opts.onReject) { await Promise.resolve(opts.onReject(device())).catch(() => {}); toast("Rejected. You are signed out."); return opts.onOut?.(); }
      await sb.rpc("reject_legal_terms", { p_version: VER(t), p_device: device() }).then(() => {}, () => {});
      S.legalOk = null;
      await sb.auth.signOut({ scope: "local" });
      toast("Rejected. You are signed out. You can use the portal only after you agree.");
    };
    $("#lgPrint", ov).onclick = () => {
      ov.hidden = true; printTerms(null, t);
      const timer = setInterval(() => { if (!$(".preview")) { clearInterval(timer); ov.hidden = false; } }, 400);
    };
    $("#lgSubmit", ov).onclick = async (e) => {
      if (!$("#lgAgree", ov).checked) return;
      const btn = e.currentTarget; btn.disabled = true;
      const busyTxt = btn.innerHTML; btn.innerHTML = `<span class="spin sm"></span> Saving…`;
      const extra = { details: deviceDetails(), location: await getLocation(), signature: null }; // 3.73.3: no signature on the agreements
      btn.innerHTML = busyTxt;
      if (opts.onSubmit) { // a customer (Public ID + Private PIN, no login)
        const r = await opts.onSubmit(await sha256(plain(t)), device(), extra);
        if (!r?.ok) { ready(); return toast(r?.error || "Could not record your agreement.", true); }
        ov.classList.add("out"); setTimeout(() => ov.remove(), 220);
        toast(`Thank you. Your agreement ${r.ref_no || ""} is recorded. Your account is VERIFIED.`);
        return opts.after?.(r);
      }
      const base = { p_version: VER(t), p_hash: await sha256(plain(t)), p_device: device() };
      let { data, error } = await sb.rpc("accept_legal_terms", { ...base, p_details: extra.details, p_location: extra.location, p_signature: extra.signature });
      if (error && /function|schema cache|PGRST202/i.test(error.message + (error.code || ""))) ({ data, error } = await sb.rpc("accept_legal_terms", base)); // the server has not 076 yet
      if (error) { ready(); return fail(error, "Could not record your agreement"); }
      ov.classList.add("out"); setTimeout(() => { ov.remove(); E.route(); }, 220); // the next agreement, if there is one; else the portal opens
      toast(`Thank you. Your ${TYPES[t]} ${data?.ref_no || ""} is recorded.`);
    };
  }

  // ---------- Legal Terms page (menu OTHER) ----------
  V.legal = async () => {
    E.shell("legal", "Legal Terms", `<div id="lgRes">${busy()}</div>`, isAdmin()
      ? `Every login and customer agrees before using the portal. Each agreement is kept on the server for good: who, their IDs, date and time, device, IP address, location (when allowed) and the fingerprint of the exact text. Only the latest version (${REL}) shows here, one line per person; older agreements stay kept on the server. Press a line to open the person's signed agreements and download them as a PDF.`
      : "The terms you accepted, and your acceptance record. Print or download it any time.");
    const here = E.stillHere();
    await syncVersion();
    const [acc, profs, rej] = await Promise.all([
      sb.from("legal_acceptances").select("*").order("accepted_at", { ascending: false }).limit(2000),
      isAdmin() ? sb.from("profiles").select("id, full_name, email, role, status").order("full_name") : Promise.resolve({ data: [] }),
      isAdmin() ? sb.from("legal_rejections").select("*").order("rejected_at", { ascending: false }).limit(500).then((r) => r, () => ({ data: [] })) : Promise.resolve({ data: [] })]);
    if (!here() || !$("#lgRes")) return;
    if (acc.error) { $("#lgRes").innerHTML = `<div class="empty">The server needs update 3.69 first (073_legal_terms.sql).</div>`; return; }
    const rows = (acc.data || []).filter((r) => isCurrent(r.terms_version)); // 3.73: only the latest version shows (the older ones stay kept on the server)
    // 3.73.4: one line per person — the latest; a rejection shows only when the person has not agreed after it
    const who = (r) => r.user_id || r.customer_id || r.id;
    const agreedAt = new Map(); rows.forEach((r) => { const k = who(r) + "|" + r.terms_version; if (!agreedAt.has(k)) agreedAt.set(k, r.accepted_at); });
    const seenRej = new Set();
    const rejected = (rej.data || []).filter((r) => isCurrent(r.terms_version) && !(agreedAt.get(who(r) + "|" + r.terms_version) > r.rejected_at) && !seenRej.has(who(r)) && seenRej.add(who(r)));
    if (!isAdmin()) {
      const needs = needsOf(S.profile);
      $("#lgRes").innerHTML = needs.map((t) => {
        const mine = rows.find((r) => r.terms_version === VER(t));
        return `<fieldset class="opt"><legend>${esc(TYPES[t])}</legend>${mine ? `<div class="banner ok">✅ You accepted it on <b>${esc(E.dateTime(mine.accepted_at))}</b> · ${esc(mine.ref_no || "")}</div>` : `<div class="banner warn">Not accepted yet.</div>`}
          <div class="btnrow"><button type="button" class="btn" data-read="${t}">${ic("doc")} Read</button><button type="button" class="btn primary" data-pr="${t}">${ic("print")} Print / Download</button></div></fieldset>`;
      }).join("");
      $$("#lgRes [data-read]").forEach((b) => (b.onclick = () => showTerms(b.dataset.read)));
      $$("#lgRes [data-pr]").forEach((b) => (b.onclick = () => printTerms(rows.find((r) => r.terms_version === VER(b.dataset.pr)) || null, b.dataset.pr)));
      return;
    }
    const has = new Set(rows.map((r) => `${r.user_id}|${r.terms_version}`));
    const missingOf = (p) => needsOf(p).filter((t) => !has.has(`${p.id}|${VER(t)}`));
    const waiting = (profs.data || []).filter((p) => p.status === "active" && missingOf(p).length);
    const done = { size: (profs.data || []).filter((p) => p.status === "active" && !missingOf(p).length).length };
    const custOk = new Set(rows.filter((r) => r.customer_id && r.terms_version === VER("customer")).map((r) => r.customer_id)).size;
    const byWho = new Map(); rows.forEach((r) => { const k = who(r); if (!byWho.has(k)) byWho.set(k, []); byWho.get(k).push(r); });
    const people = [...byWho.values()].map((all) => ({ ...all[0], all, kinds: all.map((r) => TYPES[typeOf(r.terms_version)]).reverse().join(" + ") }));
    const printAll = (p) => E.openPreview(`${p.kinds} ${p.full_name || ""}`, p.all.slice().reverse().flatMap((r) => pages(r)));
    const draw = () => {
      const q = ($("#lgQ")?.value || "").trim().toLowerCase();
      const list = people.filter((r) => !q || [...r.all.map((x) => x.ref_no), r.full_name, r.email, r.ip_address, r.device, r.role, r.kinds].some((x) => String(x || "").toLowerCase().includes(q)));
      $("#lgList").innerHTML = E.grid({ cols: [
        { label: "Acceptance No", get: (r) => r.ref_no || "" }, { label: "Name", get: (r) => r.full_name || "" }, { label: "Email", get: (r) => r.email || "" },
        { label: "Role", get: (r) => (r.role === "admin" ? "Full Access" : r.role || "") }, { label: "Agreement", get: (r) => r.kinds },
        { label: "Accepted On", get: (r) => E.dateTime(r.accepted_at) }, { label: "IP Address", get: (r) => r.ip_address || "" },
        { label: "Location", get: (r) => (r.location?.status === "allowed" ? "✔ FOUND" : "") },
        { label: "Device", get: (r) => String(r.device || "").split(" · ").slice(0, 3).join(" · ") }], rows: list, onRow: true, empty: "No acceptance matches." });
      E.bindGrid($("#lgList"), list, printAll);
    };
    $("#lgRes").innerHTML = `<div class="tiles"><div class="tile"><span class="tile-ic">${ic("shield")}</span><div class="k">Logins Fully Accepted</div><div class="v">${done.size}</div><small>portal + employee agreements</small></div>
        <div class="tile"><span class="tile-ic">${ic("clock")}</span><div class="k">Not Yet Accepted</div><div class="v">${waiting.length}</div><small>active logins</small></div>
        <div class="tile"><span class="tile-ic">${ic("check")}</span><div class="k">Customers Verified</div><div class="v">${custOk}</div><small>customer agreement</small></div>
        <div class="tile"><span class="tile-ic">${ic("doc")}</span><div class="k">People Agreed</div><div class="v">${people.length}</div></div></div>
      <div class="btnrow">${Object.entries(TYPES).map(([t, n]) => `<button type="button" class="btn" data-pt="${t}">${ic("print")} ${esc(n)}</button>`).join("")}</div>
      <div class="btnrow"><input type="search" id="lgQ" placeholder="Find by name, email, acceptance no, agreement, IP or device" style="flex:1;min-width:200px"></div>
      <div id="lgList"></div>
      ${waiting.length ? `<h3 class="sec">Not Yet Accepted</h3><p class="muted">They see the agreements the next time they sign in; the portal opens for them only after they submit.</p>
        <table class="grid"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Still to Accept</th></tr></thead><tbody>${waiting.map((p) => `<tr><td>${esc(p.full_name || "")}</td><td>${esc(p.email || "")}</td><td>${esc(p.role === "admin" ? "Full Access" : p.role || "")}</td><td>${esc(missingOf(p).map((t) => TYPES[t]).join(", "))}</td></tr>`).join("")}</tbody></table>` : ""}`;
    if (rejected.length) $("#lgRes").insertAdjacentHTML("beforeend", `<h3 class="sec">Rejected (${rejected.length})</h3><p class="muted">They were signed out at once and cannot use the portal until they agree.</p>
      <table class="grid"><thead><tr><th>Date / Time</th><th>Name</th><th>Email</th><th>Role</th><th>Agreement</th><th>IP Address</th><th>Device</th></tr></thead><tbody>${rejected.map((r) => `<tr><td>${esc(E.dateTime(r.rejected_at))}</td><td>${esc(r.full_name || "")}</td><td>${esc(r.email || "")}</td><td>${esc(r.role === "admin" ? "Full Access" : r.role || "")}</td><td>${esc(TYPES[typeOf(r.terms_version)])}</td><td>${esc(r.ip_address || "")}</td><td>${esc(String(r.device || "").split(" · ").slice(0, 3).join(" · "))}</td></tr>`).join("")}</tbody></table>`);
    $$("#lgRes [data-pt]").forEach((b) => (b.onclick = () => printTerms(null, b.dataset.pt)));
    $("#lgQ").oninput = draw;
    draw();
  };

  // ---------- 3.69: CUSTOMER SIGN IN: scan the Public ID QR, type the Private PIN; agree; VERIFIED ----------
  const CUST_KEY = /EO[0-9A-F]{40}/i;
  function renderCustLogin(scanned = "") {
    let pub = "";
    E.authFrame("Customer Sign In", `<form class="wbody login-form" id="cuForm" novalidate>
      ${E.brandBlock()}
      <div class="cl-scan"><button type="button" class="btn big primary" id="cuCam">${ic("camera")} Scan My Public ID</button>
        <div class="cl-read" id="cuRead" hidden></div></div>
      <div id="cuStep" hidden>
        <label class="fl" for="cuPin">Private PIN</label>
        <input type="password" id="cuPin" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="20" placeholder="XXXX-XXXX-XXXX" inputmode="text">
        <button class="btn primary big" type="submit">Sign In</button></div>
      <div class="hint small">Scan the QR code of your <b>Public ID</b> (on your customer papers), then type your <b>Private PIN</b> given by ${esc(co())}. Keep your Private PIN secret.</div>
      <div class="login-links"><button type="button" class="linkbtn" id="cuBack">Back to Sign In</button></div></form>`);
    const take = (t) => {
      const m = String(t || "").match(CUST_KEY);
      if (!m) return toast("This is not an EMON OVERRUNS customer Public ID. Scan the QR code of your Public ID.", true);
      pub = m[0].toUpperCase();
      const r = $("#cuRead"); r.hidden = false; r.innerHTML = `${ic("check")} Public ID ${esc(pub.slice(0, 6))}…${esc(pub.slice(-4))}`;
      $("#cuStep").hidden = false; $("#cuPin").focus();
    };
    $("#cuCam").onclick = () => E.scanDialog(take, { title: "Scan Your Public ID", hint: "Hold the QR code of your Public ID in front of the camera." });
    if (scanned) take(scanned); // 3.90: already scanned on Sign In
    $("#cuBack").onclick = () => E.route();
    $("#cuForm").onsubmit = async (e) => {
      e.preventDefault();
      const pin = $("#cuPin").value.trim();
      if (!pub) return toast("Scan your Public ID first.", true);
      if (!pin) { toast("Type your Private PIN.", true); return $("#cuPin").focus(); }
      E.setBusy(e.target, true, "Signing in");
      await syncVersion();
      const { data, error } = await sb.rpc("customer_portal", { p_public: pub, p_pin: pin, p_version: VER("customer") });
      E.setBusy(e.target, false);
      if (error) return fail(error, "Could not sign in");
      if (!data?.ok) { $("#cuPin").value = ""; $("#cuPin").focus(); return toast(data?.error || "Wrong Public ID or Private PIN.", true); }
      const open = (d) => custHome(d, () => E.route(), { pub, pin });
      if (data.agreed) return open(data);
      show({ type: "customer", who: `${data.name} (${data.account_no || ""})`, onOut: () => renderCustLogin(),
        onReject: (dev) => sb.rpc("customer_reject_terms", { p_public: pub, p_pin: pin, p_version: VER("customer"), p_device: dev }),
        onSubmit: async (hash, dev, extra = {}) => {
          const base = { p_public: pub, p_pin: pin, p_version: VER("customer"), p_hash: hash, p_device: dev };
          let r = await sb.rpc("customer_accept_terms", { ...base, p_details: extra.details || null, p_location: extra.location || null, p_signature: extra.signature || null });
          if (r.error && /function|schema cache|PGRST202/i.test(r.error.message + (r.error.code || ""))) r = await sb.rpc("customer_accept_terms", base); // the server has not 076 yet
          return r.error ? { ok: false, error: r.error.message } : r.data; },
        after: (r) => open({ ...data, agreed: r }) });
    };
  }
  function custHome(d, out, key = {}) {
    const peso = (n) => Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    // 3.74: no agreement button once agreed (it shows only once); the history and the SOA instead
    E.authFrame("My Account", `<div class="wbody login-form cust-home">
      ${E.brandBlock()}<h3 class="cust-name">${esc(d.name)}<small>${esc([Number(d.credit_limit) >= 1000000 ? "" : d.business_name, d.account_no].filter(Boolean).join(" · "))}</small></h3>
      ${Number(d.credit_limit) >= 1000000 ? `<div class="vip-badge big">${ic("shield")} VIP CUSTOMER${d.business_name ? `<small>${esc(d.business_name)}</small>` : ""}</div>` : ""}
      <div class="cust-ver ${d.agreed ? "ok" : ""}">${d.agreed ? "✅ <b>VERIFIED</b>" : "<b>NOT VERIFIED</b>"}</div>
      <table class="grid cust-tbl"><tbody>
        <tr><th>Account No</th><td>${esc(d.account_no || "")}</td></tr><tr><th>Account Status</th><td>${E.pill(d.status)}</td></tr>
        <tr><th>Customer Since</th><td>${esc(E.mdy(d.opened) || "")}</td></tr>
        ${d.credit_limit != null ? `<tr><th>Credit Limit</th><td>₱ ${peso(d.credit_limit)}</td></tr>` : ""}
        ${d.balance_due != null ? `<tr><th>Balance Due</th><td><b>₱ ${peso(d.balance_due)}</b></td></tr>` : ""}</tbody></table>
      <div id="chHist" class="cust-hist">${busy()}</div>
      <p class="hint small">If anything here is wrong, contact the office of ${esc(co())} immediately: ${esc(addr())} · ${esc(C.company.email)}.</p>
      <div class="btnrow"><button type="button" class="btn primary" id="chOut">Sign Out</button></div></div>`);
    $("#chOut").onclick = out;
    if (key.pub && key.pin && d.agreed) custHistory(key);
    else if ($("#chHist")) $("#chHist").innerHTML = "";
  }
  // 3.88: the tracking of a customer's order: where it is now, and every step with its date and time
  const C_TRACK = { sorting: "SORTING", preparing: "PREPARING", assigned: "ASSIGNED FOR DELIVERY", out_for_delivery: "OUT FOR DELIVERY" };
  function custSteps(o) {
    const t = o.tracking || [], last = (k) => [...t].reverse().find((x) => x.step === k);
    return [["ORDER CREATED", o.order_date], ["CONFIRMED", o.approved_at], ...Object.keys(C_TRACK).map((k) => [C_TRACK[k], last(k)?.at, k === "assigned" ? last(k)?.employee : ""]),
      ["DELIVERED", o.delivered_at], ["COMPLETED", o.completed_at], ...(o.proof_photos ? [["PROOF OF DELIVERY", null, `${o.proof_photos} photo(s)`, true]] : [])];
  }
  function custTrack(o) {
    if (o.status === "cancelled") return { pill: ["rejected", "CANCELLED"], at: null };
    const done = custSteps(o).filter((x) => x[1]);
    const lastDone = done.reduce((m, x) => (!m || String(x[1]) >= String(m[1]) ? x : m), null);
    return { pill: [o.status === "completed" ? "applied" : o.status === "pending" ? "pending" : "approved", lastDone ? lastDone[0] : "ORDER CREATED"], at: lastDone?.[1] || null };
  }
  function custTrackShow(o) {
    if (!o) return;
    const steps = custSteps(o), lastI = steps.reduce((m, x, i) => (x[1] ? i : m), -1);
    const m = E.modal(`Tracking — ${o.order_no}`, `<section class="trk${o.status === "cancelled" ? " off" : ""}"><ol class="trk-list">${steps.map(([t, at, sub, done], i) => {
        const ok = !!at || done, cls = ok ? "done" : o.status !== "cancelled" && i === lastI + 1 ? "now" : "";
        return `<li class="${cls}"><span class="trk-dot">${ok ? "✓" : i + 1}</span><div><b>${esc(t)}</b><small>${esc(at ? E.dateTime(at) : "")}${at && sub ? " · " : ""}${esc(sub || "")}</small></div></li>`;
      }).join("")}${o.status === "cancelled" ? `<li class="cancel"><span class="trk-dot">✕</span><div><b>CANCELLED</b><small></small></div></li>` : ""}</ol></section>`,
      `<button type="button" class="btn" data-x>Close</button>`);
    $("[data-x]", m.el).onclick = m.close;
  }
  // 3.74: the customer's orders, invoices, payments and the SOA (current month first; earlier months to choose)
  async function custHistory(key) {
    const box = $("#chHist");
    const { data, error } = await sb.rpc("customer_history", { p_public: key.pub, p_pin: key.pin });
    if (!box || !box.isConnected) return;
    if (error || !data?.ok) { box.innerHTML = /customer_history|schema cache|PGRST202/.test(error?.message || "") ? "" : `<div class="banner warn">${esc(data?.error || error?.message || "Could not load your history.")}</div>`; return; }
    const peso = (n) => Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const soa = E.custSoa ? E.custSoa(data) : null;
    const tbl = (title, head, rows, empty) => `<h4 class="cust-h">${esc(title)}</h4>${rows.length ? `<div class="tblwrap"><table class="grid cust-list"><thead><tr>${head.map((h, i) => `<th${i >= head.length - 1 ? ' class="num"' : ""}>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>` : `<div class="muted small">${esc(empty)}</div>`}`;
    const cur = soa?.months[0];
    box.innerHTML = `${soa ? `<div class="cust-soa"><div><small>STATEMENT OF ACCOUNT</small><b>${esc(soa.monthText(cur).toUpperCase())} (TO DATE)</b><span>${esc(soa.period(cur).no)}</span></div>
        <button type="button" class="btn primary" id="chSoa">${ic("download")} Download SOA</button></div>
        ${soa.months.length > 1 ? `<div class="btnrow"><select id="chSoaM">${soa.months.map((m, i) => `<option value="${m}">${esc(soa.monthText(m).toUpperCase())}${i ? "" : " (TO DATE)"}</option>`).join("")}</select><button type="button" class="btn" id="chSoaOld">${ic("print")} Other Month</button></div>` : ""}` : ""}
      ${tbl("MY ORDERS", ["Order No", "Date", "Status", "Boxes", "Amount (₱)"], (data.orders || []).slice(0, 30).map((o, oi) => `<tr class="click" data-co="${oi}"><td>${esc(o.order_no || "")}</td><td>${esc(E.mdy(o.order_date))}</td><td>${E.pill(...custTrack(o).pill)}<br><small>${esc(custTrack(o).at ? E.dateTime(custTrack(o).at) : "")}</small></td><td>${esc(String(o.total_boxes || 0))}</td><td class="num">${peso(o.total_amount)}</td></tr>`), "No orders yet.")}
      ${tbl("MY INVOICES", ["Invoice No", "Date", "Status", "Balance (₱)", "Amount (₱)"], (data.invoices || []).slice(0, 30).map((i) => `<tr><td>${esc(E.insOfInvoice?.(i) ? `COVERAGE ${E.insOfInvoice(i)}` : i.invoice_no || "")}</td><td>${esc(E.mdy(i.invoice_date))}</td><td>${E.pill(i.pay_status || "")}</td><td>${peso(i.balance)}</td><td class="num">${peso(i.total_amount)}</td></tr>`), "No invoices yet.")}
      ${tbl("MY PAYMENTS", ["Receipt No", "Date", "Amount (₱)"], (data.payments || []).slice(0, 30).map((p) => `<tr><td>${esc(p.receipt_no || "")}</td><td>${esc(E.mdy(p.paid_date))}</td><td class="num">${peso(p.amount)}</td></tr>`), "No payments yet.")}`;
    $$("[data-co]", box).forEach((tr) => (tr.onclick = () => custTrackShow((data.orders || [])[Number(tr.dataset.co)]))); // 3.88: the tracking
    if ($("#chSoa")) $("#chSoa").onclick = () => soa.print(cur);
    if ($("#chSoaOld")) $("#chSoaOld").onclick = () => soa.print($("#chSoaM").value);
  }
  // VERIFIED on the customer profile (staff)
  async function custVerified(el, customerId) {
    if (!el) return;
    const { data, error } = await sb.rpc("customer_legal", { p_customer: customerId });
    if (error || !el.isConnected) return;
    if (data && isAdmin()) {
      el.innerHTML = `<button type="button" class="ver-badge" title="Open the customer's signed agreement (PDF) · ${esc(E.dateTime(data.accepted_at))} · ${esc(data.ref_no || "")}">${ic("check")} VERIFIED</button>`;
      el.firstChild.onclick = async () => { const { data: a } = await sb.from("legal_acceptances").select("*").eq("customer_id", customerId).order("accepted_at", { ascending: false }).limit(1).maybeSingle(); if (a) printTerms(a); };
      return;
    }
    el.innerHTML = data ? `<span class="ver-badge" title="Agreed to all the legal terms on ${esc(E.dateTime(data.accepted_at))} · ${esc(data.ref_no || "")}">${ic("check")} VERIFIED</span>` : `<span class="ver-badge no" title="The customer has not signed in and agreed to the legal terms yet">NOT VERIFIED</span>`;
  }

  // the terms in a window (the Create Account form, before signing in)
  const showTerms = (t = "portal") => {
    if (typeof t !== "string") t = "portal";
    const m = E.modal(TYPES[t], `<div class="legal-body page-like">${termsHtml(t)}</div>`, `<button type="button" class="btn primary" data-x>Close</button>`, { wide: true });
    $("[data-x]", m.el).onclick = m.close;
  };
  Object.assign(E, { legalGate, showTerms, renderCustLogin, custVerified, legalVersion: () => VER("portal") });
})();
