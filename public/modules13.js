/* EMON OVERRUNS E-PORTAL — 3.69: LEGAL TERMS, DATA PRIVACY, CONFIDENTIALITY AND ELECTRONIC SIGNATURE CONSENT.
   After signing in, every login reads the terms, ticks "I have read all and I agree" and presses Submit. The server keeps
   each acceptance for good (073_legal_terms.sql): who, the version and SHA-256 fingerprint of the exact text, date and
   time, device and IP address. Legal Terms (menu OTHER): EMON HASAN sees and finds every acceptance and who has not
   accepted yet, and prints any of them; every other login sees the terms and their own acceptance. */
(function () {
  "use strict";
  const E = window.EO, V = (window.EO_VIEWS = window.EO_VIEWS || {});
  const { sb, S, C, esc, $, $$, isAdmin, toast, fail, ic, busy } = E;

  const VERSION = "3.69 · NOVEMBER 02 2026";
  const co = () => C.company.name;
  const addr = () => C.company.address.join(", ");

  // ---------- the terms (one text: what is shown, printed and fingerprinted) ----------
  const SECTIONS = () => [
    ["SUMMARY", `<div class="lg-warn"><b>IMPORTANT.</b> Everything in this portal is <b>CONFIDENTIAL</b> property of ${esc(co())}. You must <b>NOT</b> leak, share, copy, photograph,
      screenshot, forward or sell any data from it. Doing so is a <b>crime punishable by law</b> in the Philippines (Data Privacy Act of 2012, Cybercrime Prevention Act of 2012,
      Revised Penal Code) and in other countries, with imprisonment and fines, besides dismissal and damages. Your approved signatures are your <b>electronic signature</b>
      and are as valid as your handwritten signature on every document made in this portal.</div>`],
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
    ["6. RECORD OF YOUR ACCEPTANCE", `<p>When you press Submit, the server keeps for good: your name, email, role, the date and time, your device and browser, your IP address, the version of these
      terms and the fingerprint (SHA-256) of their exact text, with an acceptance number (LT-…). Nobody can change or delete it. It is proof of your consent and
      may be used by ${esc(co())} before any office or court. You can see and print your acceptance any time in the menu <b>Legal Terms</b>.</p>`],
    ["7. CHANGES AND GOVERNING LAW", `<p>When these terms change, a new version is shown and must be accepted again. These terms are governed by the laws of the Republic of the Philippines;
      the courts of Pasay City, Metro Manila, have jurisdiction. If one part is held invalid, the rest stays in force.</p>`]
  ];
  const termsHtml = () => SECTIONS().map(([h, b]) => `<section class="lg-sec"><h4>${esc(h)}</h4>${b}</section>`).join("");
  const plain = () => { const d = document.createElement("div"); d.innerHTML = `${VERSION}\n${termsHtml()}`; return d.textContent.replace(/\s+/g, " ").trim(); };
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

  // ---------- the print: the terms, and the acceptance when there is one ----------
  function pages(acc) {
    const head = E.printHead("LEGAL TERMS, DATA PRIVACY AND E-SIGNATURE CONSENT", `<div class="mono">${esc(acc?.ref_no || "VERSION " + VERSION)}</div>`);
    const secs = SECTIONS();
    const one = (list, first) => `${first ? head : ""}<div class="lg-print">${list.map(([h, b]) => `<section class="lg-sec"><h4>${esc(h)}</h4>${b}</section>`).join("")}</div>`;
    const accBox = acc ? `<div class="lg-print"><section class="lg-sec lg-acc"><h4>ACCEPTANCE RECORD</h4><table class="ol-grid"><tbody>
        ${[["Acceptance No", acc.ref_no], ["Name", acc.full_name], ["Email", acc.email], ["Role", acc.role === "admin" ? "Managing Director (full access)" : acc.role],
          ["Terms Version", acc.terms_version], ["Accepted On", E.dateTime(acc.accepted_at)], ["Agreed", "YES — \"I have read all and I agree\" ticked and submitted"],
          ["Device", acc.device], ["IP Address", acc.ip_address || "—"], ["Text Fingerprint (SHA-256)", acc.terms_hash]].map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v || "")}</td></tr>`).join("")}
      </tbody></table><p class="pdecl">This record was made by the EMON OVERRUNS E-PORTAL server when the person above pressed Submit. It cannot be changed or deleted.</p></section></div>` : "";
    return [one(secs.slice(0, 3), true), one(secs.slice(3, 5), false), one(secs.slice(5), false) + accBox];
  }
  const printTerms = (acc) => E.openPreview(acc ? `Legal Terms ${acc.ref_no} ${acc.full_name || ""}` : `Legal Terms ${VERSION}`, pages(acc));

  // ---------- the popup after signing in ----------
  let checking = null;
  async function legalGate() {
    if (!S.session || !S.profile || S.legalOk === S.profile.id || $(".legal-ov")) return;
    if (checking) return checking;
    checking = (async () => {
      const { data, error } = await sb.from("legal_acceptances").select("id").eq("user_id", S.profile.id).eq("terms_version", VERSION).limit(1);
      if (error) { if (/legal_acceptances|does not exist|schema cache|42P01|PGRST20/.test(error.message + (error.code || ""))) S.legalOk = S.profile.id; return; } // the server has not 073 yet
      if (data?.length) { S.legalOk = S.profile.id; return; }
      show();
    })().finally(() => { checking = null; });
    return checking;
  }
  function show() {
    const ov = document.createElement("div");
    ov.className = "legal-ov";
    ov.innerHTML = `<div class="legal-win" role="dialog" aria-modal="true" aria-labelledby="lgTitle">
      <div class="legal-head">${E.logoHtml("lg-logo")}<div><b id="lgTitle">Legal Terms, Data Privacy &amp; E-Signature Consent</b><small>${esc(co())} E-PORTAL · Version ${esc(VERSION)}</small></div></div>
      <div class="legal-body" id="lgBody" tabindex="0">${termsHtml()}<p class="lg-end">— END OF TERMS —</p></div>
      <div class="legal-foot">
        <label class="lg-agree"><input type="checkbox" id="lgAgree"> <span><b>I have read all and I agree</b> to the Terms of Use, the Data Privacy Notice and Consent, the Confidentiality and Non-Disclosure terms and the Electronic Signature Consent above.</span></label>
        <div class="btnrow"><button type="button" class="btn" id="lgPrint">${ic("print")} Print / Download</button><button type="button" class="btn" id="lgOut">Sign Out</button>
          <button type="button" class="btn primary" id="lgSubmit" disabled>${ic("check")} Submit</button></div>
        <small class="muted">Signed in as ${esc(S.profile.full_name || S.profile.email || "")}. The portal opens after you submit.</small></div></div>`;
    document.body.appendChild(ov);
    $("#lgAgree", ov).onchange = (e) => { $("#lgSubmit", ov).disabled = !e.target.checked; };
    $("#lgOut", ov).onclick = () => { ov.remove(); sb.auth.signOut({ scope: "local" }); };
    $("#lgPrint", ov).onclick = () => {
      ov.hidden = true; printTerms(null);
      const t = setInterval(() => { if (!$(".preview")) { clearInterval(t); ov.hidden = false; } }, 400);
    };
    $("#lgSubmit", ov).onclick = async (e) => {
      if (!$("#lgAgree", ov).checked) return;
      const btn = e.currentTarget; btn.disabled = true;
      const { data, error } = await sb.rpc("accept_legal_terms", { p_version: VERSION, p_hash: await sha256(plain()), p_device: device() });
      if (error) { btn.disabled = false; return fail(error, "Could not record your agreement"); }
      S.legalOk = S.profile.id;
      ov.classList.add("out"); setTimeout(() => ov.remove(), 220);
      toast(`Thank you. Your agreement ${data?.ref_no || ""} is recorded.`);
    };
  }

  // ---------- Legal Terms page (menu OTHER) ----------
  V.legal = async () => {
    E.shell("legal", "Legal Terms", `<div id="lgRes">${busy()}</div>`, isAdmin()
      ? "Every login accepts these terms once after signing in. Each acceptance is kept on the server for good: who, when, device, IP address and the fingerprint of the exact text. Find anyone here and print their record."
      : "The terms you accepted, and your acceptance record. Print or download it any time.");
    const here = E.stillHere();
    const [acc, profs] = await Promise.all([
      sb.from("legal_acceptances").select("*").order("accepted_at", { ascending: false }).limit(2000),
      isAdmin() ? sb.from("profiles").select("id, full_name, email, role, status").order("full_name") : Promise.resolve({ data: [] })]);
    if (!here() || !$("#lgRes")) return;
    if (acc.error) { $("#lgRes").innerHTML = `<div class="empty">The server needs update 3.69 first (073_legal_terms.sql).</div>`; return; }
    const rows = acc.data || [];
    if (!isAdmin()) {
      const mine = rows.find((r) => r.terms_version === VERSION) || rows[0];
      $("#lgRes").innerHTML = `${mine ? `<div class="banner ok">✅ You accepted these terms on <b>${esc(E.dateTime(mine.accepted_at))}</b> · ${esc(mine.ref_no || "")}</div>` : ""}
        <div class="btnrow"><button type="button" class="btn primary" id="lgPr">${ic("print")} Print / Download</button></div><div class="legal-body page-like">${termsHtml()}</div>`;
      $("#lgPr").onclick = () => printTerms(mine || null);
      return;
    }
    const done = new Set(rows.filter((r) => r.terms_version === VERSION).map((r) => r.user_id));
    const waiting = (profs.data || []).filter((p) => p.status === "active" && !done.has(p.id));
    const draw = () => {
      const q = ($("#lgQ")?.value || "").trim().toLowerCase();
      const list = rows.filter((r) => !q || [r.ref_no, r.full_name, r.email, r.ip_address, r.device, r.role].some((x) => String(x || "").toLowerCase().includes(q)));
      $("#lgList").innerHTML = E.grid({ cols: [
        { label: "Acceptance No", get: (r) => r.ref_no || "" }, { label: "Name", get: (r) => r.full_name || "" }, { label: "Email", get: (r) => r.email || "" },
        { label: "Role", get: (r) => (r.role === "admin" ? "Full Access" : r.role || "") }, { label: "Version", get: (r) => r.terms_version },
        { label: "Accepted On", get: (r) => E.dateTime(r.accepted_at) }, { label: "IP Address", get: (r) => r.ip_address || "" },
        { label: "Device", get: (r) => String(r.device || "").split(" · ").slice(0, 3).join(" · ") }], rows: list, onRow: true, empty: "No acceptance matches." });
      E.bindGrid($("#lgList"), list, (r) => printTerms(r));
    };
    $("#lgRes").innerHTML = `<div class="tiles"><div class="tile"><span class="tile-ic">${ic("shield")}</span><div class="k">Accepted (this version)</div><div class="v">${done.size}</div></div>
        <div class="tile"><span class="tile-ic">${ic("clock")}</span><div class="k">Not Yet Accepted</div><div class="v">${waiting.length}</div><small>active logins</small></div>
        <div class="tile"><span class="tile-ic">${ic("doc")}</span><div class="k">All Records</div><div class="v">${rows.length}</div></div></div>
      <div class="btnrow"><input type="search" id="lgQ" placeholder="Find by name, email, acceptance no, IP or device" style="flex:1;min-width:200px"><button type="button" class="btn" id="lgPr">${ic("print")} Print the Terms</button></div>
      <div id="lgList"></div>
      ${waiting.length ? `<h3 class="sec">Not Yet Accepted</h3><p class="muted">They see the terms the next time they sign in; the portal opens for them only after they submit.</p>
        <table class="grid"><thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead><tbody>${waiting.map((p) => `<tr><td>${esc(p.full_name || "")}</td><td>${esc(p.email || "")}</td><td>${esc(p.role === "admin" ? "Full Access" : p.role || "")}</td></tr>`).join("")}</tbody></table>` : ""}`;
    $("#lgQ").oninput = draw;
    $("#lgPr").onclick = () => printTerms(null);
    draw();
  };

  Object.assign(E, { legalGate, LEGAL_VERSION: VERSION });
})();
