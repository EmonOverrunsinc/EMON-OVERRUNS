/* EMON OVERRUNS E-PORTAL — 3.21 Employee ID Card.
   The card is CR80 size (54 × 85.6 mm), front and back. Copy-resistant printing: fine-line guilloche waves, a security
   rosette behind the photo, microtext lines, a ghost photo, the company seal over the photo corner and a dot background
   that may show COPY on a photocopy. The front carries a PDF417 barcode of the employee no (it opens Verify a Record).
   The back carries the emergency contact, a QR with the private card code (the employee signs in by scanning it and
   typing the password of the portal account, 3.28) and the signature of the Director who issued the card over the company name, address and email.
   Here: the card itself, the Director's ID Card tab (print / download, new card), the card in My Profile
   and the check of a scanned card. 3.23: on the screen the card shows DRAFT ONLY; the print is clean. The sign-in with the card is on the sign-in page (app.js). */
(function () {
  "use strict";
  const E = window.EO;
  const { sb, C, esc, mdy, $, $$, isAdmin, toast, fail, ic, busy, fullName } = E;
  const W = 54, H = 85.6;
  const STAMP = "brand/stamp.png"; // the company stamp (round seal, see-through), on the photo corner and by the Director's signature
  let uid = 0;

  // ---------- the security background (SVG in mm) ----------
  const n2 = (x) => x.toFixed(2);
  // fine sine lines across the card; two families of different colours cross each other
  function waves(color, y0, y1, lines, amp, len, phase, width = 0.07) {
    let d = "";
    for (let i = 0; i < lines; i++) {
      const base = y0 + ((y1 - y0) * i) / Math.max(1, lines - 1), ph = phase + i * 0.42;
      for (let x = -1, first = true; x <= W + 1; x += 0.8, first = false) d += `${first ? "M" : "L"}${n2(x)} ${n2(base + amp * Math.sin((x / len) * 2 * Math.PI + ph))}`;
    }
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}"/>`;
  }
  // a rosette: closed curves r = R + a·sin(kθ + φ), turned a little each
  function rosette(cx, cy, R, a, k, curves, color, width = 0.06) {
    let d = "";
    for (let j = 0; j < curves; j++) {
      const ph = (j * 2 * Math.PI) / curves;
      for (let s = 0; s <= 180; s++) {
        const t = (s / 180) * 2 * Math.PI, r = R + a * Math.sin(k * t + ph);
        d += `${s ? "L" : "M"}${n2(cx + r * Math.cos(t))} ${n2(cy + r * Math.sin(t))}`;
      }
      d += "Z";
    }
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}"/>`;
  }
  // The background tint is made of fine dots; inside the word COPY the dots are bigger and fewer, with the same tone.
  // A copier keeps the big dots and drops the fine ones, so COPY may appear on a photocopy.
  function copyTint(k, color) {
    const words = [];
    for (let y = 12; y < H; y += 17) for (let x = -6 + ((y / 17) % 2) * 13; x < W; x += 26) words.push(`<text x="${x}" y="${y}">COPY</text>`);
    const txt = `<g font-family="Arial, sans-serif" font-weight="900" font-size="9" transform="rotate(-28 27 43)">${words.join("")}</g>`;
    return `<defs>
        <pattern id="pf${k}" width="0.32" height="0.32" patternUnits="userSpaceOnUse"><circle cx="0.16" cy="0.16" r="0.085" fill="${color}"/></pattern>
        <pattern id="pc${k}" width="0.64" height="0.64" patternUnits="userSpaceOnUse"><circle cx="0.32" cy="0.32" r="0.17" fill="${color}"/></pattern>
        <mask id="mw${k}"><rect width="${W}" height="${H}" fill="#000"/><g fill="#fff">${txt}</g></mask>
        <mask id="mb${k}"><rect width="${W}" height="${H}" fill="#fff"/><g fill="#000">${txt}</g></mask>
        <linearGradient id="rb${k}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e3f1ff"/><stop offset=".45" stop-color="#fdf3ff"/><stop offset=".75" stop-color="#fffbe8"/><stop offset="1" stop-color="#e8fff4"/></linearGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#rb${k})"/>
      <rect width="${W}" height="${H}" fill="url(#pf${k})" mask="url(#mb${k})" opacity=".55"/>
      <rect width="${W}" height="${H}" fill="url(#pc${k})" mask="url(#mw${k})" opacity=".55"/>`;
  }
  const MICRO = "EMON OVERRUNS · "; // 3.23: tiny company name in the blue foot (anti-copy microtext)
  const micro = (n) => esc(MICRO.repeat(n));
  const bg = (k, front) => `<svg class="idc-bg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      ${copyTint(k, "#b9c9e6")}
      ${waves("#8fb0e6", 20, 82, 16, 1.6, 19, 0.3)}${waves("#e3a3c8", 22, 84, 14, 1.2, 13, 2.1, 0.06)}
      ${front ? rosette(27, 32.8, 15.5, 2.3, 9, 14, "#7fa2e0") + rosette(27, 32.8, 11.2, 1.3, 13, 10, "#d9a441", 0.05) : rosette(27, 43, 20, 2, 11, 12, "#9fbbe9")}
    </svg>`;
  const band = (k) => `<svg class="idc-bandbg" viewBox="0 0 ${W} 15" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="bd${k}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0a2463"/><stop offset=".6" stop-color="#1f4fa3"/><stop offset="1" stop-color="#2f6fd6"/></linearGradient></defs>
      <rect width="${W}" height="15" fill="url(#bd${k})"/>
      <g opacity=".22">${waves("#ffffff", 1, 14, 8, 0.9, 11, 0.8, 0.06)}</g></svg>`;

  // ---------- the card ----------
  const nameSize = (n) => (n.length <= 16 ? 3.8 : n.length <= 22 ? 3.2 : n.length <= 30 ? 2.7 : 2.3);
  const val = (v) => (v ? esc(v) : "&nbsp;");
  // d: { em, card, photo, holderSig, dirSig, blood, appNo, qr }  (qr: a picture; empty on the screen)
  function front(d) {
    const k = ++uid, name = fullName(d.em).toUpperCase();
    return `<div class="idc-face idc-front">${bg(k, true)}
      <div class="idc-top">${band(k)}${E.logoHtml("idc-logo")}<div class="idc-co"><b>${esc(C.company.name)}</b><small>EMPLOYEE IDENTIFICATION CARD</small></div></div>
      <div class="idc-gold"></div>
      <div class="idc-photo">${d.photo ? `<img class="idc-pic" src="${esc(d.photo)}" alt="">` : `<span>PHOTO</span>`}<img class="idc-seal" src="${STAMP}" alt=""></div>
      ${d.photo ? `<div class="idc-ghost"><img src="${esc(d.photo)}" alt=""></div>` : ""}
      <div class="idc-name" style="font-size:${nameSize(name)}mm">${esc(name)}</div>
      <div class="idc-pos"><span>${esc((d.em.position || "EMPLOYEE").toUpperCase())}</span></div>
      <div class="idc-rows${d.blood ? " three" : ""}"><div><small>ID NO</small><b>${esc(d.em.employee_no)}</b></div>
        <div><small>VALID UNTIL</small><b>${esc(mdy(d.card.valid_until))}</b></div>${d.blood ? `<div><small>BLOOD TYPE</small><b>${esc(d.blood)}</b></div>` : ""}</div>
      <div class="idc-bar"><img src="${esc(E.pdf417DataUrl("EMONEMP|" + d.em.employee_no))}" alt="PDF417 barcode ${esc(d.em.employee_no)}"></div>
      <div class="idc-hsig">${d.holderSig ? `<img src="${esc(d.holderSig)}" alt="">` : ""}<i></i><small>HOLDER'S SIGNATURE</small></div>
      <div class="idc-foot"><span class="idc-micro">${micro(8)}</span><b>${esc(d.card.card_no)}</b></div>
    </div>`;
  }
  function back(d) {
    const k = ++uid, em = d.em, site = String(C.company.website || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
    const row = (l, v) => `<div class="idc-er"><small>${l}</small><b>${val(v)}</b></div>`;
    return `<div class="idc-face idc-back">${bg(k, false)}
      <div class="idc-bhead">IN CASE OF EMERGENCY, PLEASE NOTIFY</div><div class="idc-gold b"></div>
      <div class="idc-emg">${row("NAME", em.emergency_name)}${row("CONTACT NO", em.emergency_phone)}${row("ADDRESS", em.emergency_address)}</div>
      <div class="idc-qrrow"><div class="idc-qr">${d.qr ? `<img src="${esc(d.qr)}" alt="QR code">` : `<span>${ic("key")}<br>QR CODE<br>ON THE<br>PRINTED CARD</span>`}</div>
        <div class="idc-qrtxt"><b class="idc-scan">SCAN TO SIGN IN</b>
          <small>CARD NO</small><b class="mono">${esc(d.card.card_no)}</b><small>ISSUED</small><b>${esc(mdy(d.card.issued_at))}</b>
          <small>APPLICATION NO</small><b class="mono">${val(d.appNo)}</b></div></div>
      ${d.photo ? `<div class="idc-ghost b"><img src="${esc(d.photo)}" alt=""></div>` : ""}
      <div class="idc-sign"><img class="idc-stamp" src="${STAMP}" alt="Company stamp"><div class="idc-sigpic">${d.dirSig ? `<img src="${esc(d.dirSig)}" alt="">` : ""}</div><i></i>
        <b>${esc(C.company.name)}</b><small>${esc(C.company.address.join(", "))}</small><small>${esc(C.company.email)}${site ? ` · ${esc(site)}` : ""}</small></div>
      <p class="idc-note">This card is the property of ${esc(C.company.name)} and is not transferable. If found, please return it to the address above.</p>
      <div class="idc-foot"><span class="idc-micro">${micro(8)}</span><b>${esc(em.employee_no)}</b></div>
    </div>`;
  }
  // The print: front and back side by side on A4, corner marks to cut, a dotted line to fold.
  const sheet = (d) => `<div class="idc-sheet">
      <div class="idc-pair print"><i class="cm tl"></i><i class="cm tr"></i><i class="cm bl"></i><i class="cm br"></i>${front(d)}<div class="idc-fold"></div>${back(d)}</div>
      <div class="idc-howto"><b>EMPLOYEE ID CARD · ${esc(d.card.card_no)} · ${esc(fullName(d.em).toUpperCase())}</b> · Date Printed: ${esc(E.dateTime(new Date().toISOString()))}<br>
        Print at actual size (100%). Cut along the corner marks, fold on the dotted line so the front and the back meet, then laminate.</div></div>`;

  // Everything the card shows: the photo, the holder's signature, the signature of the Director who issued it, the blood type.
  async function cardData(em, card) {
    const [photo, prof, app] = await Promise.all([
      em.photo_path ? E.signedUrl(em.photo_path, 3600) : "",
      em.profile_id ? sb.from("profiles").select("signature_path, signature_status").eq("id", em.profile_id).maybeSingle() : { data: null },
      em.job_application_id ? sb.from("job_applications").select("blood_group, application_no").eq("id", em.job_application_id).maybeSingle() : { data: null },
      E.loadSignatures()
    ]);
    const sig = prof.data?.signature_status === "approved" ? await E.signaturePic(prof.data.signature_path) : "";
    return { em, card, photo, holderSig: sig, dirSig: E.approvedBy(card.issued_by, card.issued_by_name, card.issued_at)?.pic || "", blood: app.data?.blood_group || em.blood_group || "", appNo: app.data?.application_no || "" };
  }

  // ---------- the Director's ID Card tab on the employee profile ----------
  const STATE = { active: "ACTIVE", replaced: "REPLACED", revoked: "ENDED" };
  async function idCardTab(em, el, reload) {
    if (!isAdmin() || !el) return;
    if (em.approval_status === "pending") { el.innerHTML = `<div class="hint warn">The employee ID card is made when the employee is approved: press <b>Approve Employee</b> at the top of this page.</div>`; return; }
    el.innerHTML = busy("Loading the ID card");
    const cards = await sb.from("employee_cards").select("*").eq("employee_id", em.id).order("issued_at", { ascending: false });
    if (cards.error) { el.innerHTML = `<div class="hint err">The ID cards could not be loaded. ${/employee_cards/.test(cards.error.message || "") ? "Run the database update <b>032_employee_id.sql</b> first." : esc(cards.error.message)}</div>`; return; }
    const list = cards.data || [], card = list.find((c) => c.status === "active");
    const d = card ? await cardData(em, card) : null;
    if (!el.isConnected) return;
    const expired = card && card.valid_until < E.isoToday();
    const missing = !em.emergency_name || !em.emergency_phone;
    el.innerHTML = `<div class="idc-panel">
        ${card ? `<div class="idc-pair screen">${front(d)}${back(d)}</div>` : `<div class="empty">${em.status === "terminated" ? "No active ID card: the employee is terminated." : "No active ID card."}</div>`}
        <div class="idc-side">
          ${card ? `<div class="grid-wrap"><table class="grid kv-table"><tbody>
            <tr><th scope="row">Card No</th><td><b class="mono">${esc(card.card_no)}</b> ${expired ? `<span class="pill rejected">EXPIRED</span>` : `<span class="pill approved">ACTIVE</span>`}</td></tr>
            <tr><th scope="row">Issued</th><td>${esc(mdy(card.issued_at))}${card.issued_by_name ? ` · by ${esc(card.issued_by_name)}` : ""}</td></tr>
            <tr><th scope="row">Valid Until</th><td>${esc(mdy(card.valid_until))}</td></tr>
            <tr><th scope="row">Portal Account</th><td>${em.profile_id ? `<span class="pill approved">LINKED</span>` : `<span class="pill pending">NOT LINKED</span> — the card works after ${esc(em.email)} creates an account (Create Account), or after you link the login account in Access &amp; Status`}</td></tr>
            <tr><th scope="row">Printed</th><td>${card.print_count ? `${card.print_count} time${card.print_count === 1 ? "" : "s"} · last ${esc(mdy(card.last_printed_at))}` : "Not printed yet"}</td></tr>
            </tbody></table></div>` : ""}
          ${missing && card ? `<div class="hint warn">The emergency contact is missing. Add it with <b>Correction</b> on this employee (Details), or the card prints empty lines to fill in by hand.</div>` : ""}
          <div class="btnrow">
            ${card ? `<button type="button" class="btn primary" id="idcPrint">${ic("print")} Print / Download ID Card</button>` : ""}
            ${em.status !== "terminated" ? `<button type="button" class="btn" id="idcNew">${ic("plus")} ${card ? "Issue New Card" : "Issue ID Card"}</button>` : ""}
          </div>
          <p class="muted small">Only the Director sees and prints the ID card. A new card stops the old one at once (lost or damaged card). The employee signs in by scanning the card and typing the password of the portal account.</p>
        </div></div>
      ${list.length ? `<h4>Card History</h4>${E.grid({ cols: [{ label: "Card No", get: (r) => r.card_no }, { label: "Issued", get: (r) => mdy(r.issued_at) }, { label: "Issued By", get: (r) => r.issued_by_name || "" },
        { label: "Valid Until", get: (r) => mdy(r.valid_until) }, { label: "Status", get: (r) => STATE[r.status] || r.status.toUpperCase() }, { label: "Ended", get: (r) => (r.ended_at ? mdy(r.ended_at) : "") }], rows: list })}` : ""}`;
    if ($("#idcPrint", el)) $("#idcPrint", el).onclick = async () => {
      const { data: code, error } = await sb.rpc("employee_card_code", { p_card: card.id });
      if (error) return fail(error, "Could not print the ID card");
      E.openPreview(`ID Card ${card.card_no} ${fullName(em)}`, [sheet({ ...d, qr: E.qrDataUrl(code) })], { bare: true });
      idCardTab(em, el, reload);
    };
    if ($("#idcNew", el)) $("#idcNew", el).onclick = async () => {
      if (!(await E.confirmBox(card ? `Issue a new ID card for <b>${esc(fullName(em))}</b>?<br><br>Card <b>${esc(card.card_no)}</b> stops working at once (it cannot sign in any more). Print and give the new card.` : `Issue an ID card for <b>${esc(fullName(em))}</b>?`, { ok: card ? "Issue New Card" : "Issue ID Card" }))) return;
      const { data, error } = await sb.rpc("issue_employee_card", { p_employee: em.id });
      if (error) return fail(error, "Could not issue the ID card");
      toast(`ID card ${data.card_no} issued.`); idCardTab(em, el, reload);
    };
  }

  // ---------- the employee's ID card in My Profile (3.28: signs in with the card and the account password, no PIN) ----------
  async function cardInfoBox(el) {
    if (!el) return;
    const { data, error } = await sb.rpc("my_id_card");
    if (error || !data || !el.isConnected) { el.remove(); return; }
    el.innerHTML = `<fieldset class="opt"><legend>My ID Card</legend>
        <p>Your ID card <b class="mono">${esc(data.card_no)}</b> (valid until ${esc(mdy(data.valid_until))}) signs you in: on the sign-in page press <b>Sign In with ID Card</b>, scan the card and type your password.</p>
        <small class="muted">Anyone with your card and your password can open the portal as you. Lost your card? Tell the Director at once.</small></fieldset>`;
  }

  // ---------- a scanned card (anyone): who it belongs to and whether it is valid ----------
  async function cardCheck(code) {
    const { data, error } = await sb.rpc("check_employee_card", { p_code: code });
    if (error) return { html: `<div class="vf-bad"><div class="vf-seal">!</div><div class="vf-title">CANNOT CHECK RIGHT NOW</div><div class="vf-sub">${esc(error.message)}</div></div>` };
    if (!data?.found) return { html: `<div class="vf-bad"><div class="vf-seal">✖</div><div class="vf-title">NOT A VALID ID CARD</div><div class="vf-sub">This card is not an ${esc(C.company.name)} employee ID card. It may be fake or damaged.</div></div>` };
    const ok = data.state === "VALID";
    return { data, html: `<div class="${ok ? "vf-ok" : "vf-bad"}"><div class="vf-seal">${ok ? ic("check") : "✖"}</div>
      <div class="vf-title">EMPLOYEE ID CARD · ${esc(data.state)}</div><div class="vf-sub">${ok ? `VERIFIED BY ${esc(C.company.name)}` : data.state === "REPLACED" ? "This card was replaced by a newer card." : data.state === "EXPIRED" ? "This card has expired." : "This card is no longer valid."}</div>
      <table class="vf-fields"><tbody>${[["Name", data.name], ["Position", data.position], ["Employee No", data.employee_no], ["Card No", data.card_no], ["Issued", mdy(data.issued_at)], ["Valid Until", mdy(data.valid_until)]]
        .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v || "—")}</td></tr>`).join("")}</tbody></table>
      <div class="vf-when">Checked ${esc(E.dateTime(new Date().toISOString()))}</div></div>` };
  }
  // from a scan inside the portal: a window with the result (the code itself is never put in the address bar)
  async function showCardCheck(code) {
    const r = await cardCheck(code);
    const open = r.data?.employee_id && E.canOpen?.("employee");
    const m = E.modal("Employee ID Card", `<div class="vf-card-check">${r.html}</div>`,
      `${open ? `<button type="button" class="btn primary" data-open>${ic("eye")} Open Employee</button>` : ""}<button type="button" class="btn" data-x>Close</button>`);
    $("[data-x]", m.el).onclick = m.close;
    if (open) $("[data-open]", m.el).onclick = () => { m.close(); location.hash = "employee/" + r.data.employee_id; };
  }

  Object.assign(E, { idCardTab, cardInfoBox, cardCheck, showCardCheck, idCardSheet: sheet });
})();
