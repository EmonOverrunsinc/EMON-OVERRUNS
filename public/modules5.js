/* EMON OVERRUNS E-PORTAL — Purchase Orders (3.0, in place of Community).
   A purchase order asks to buy one lot: photos (up to 5), lot name, date, processing time, the authorized responsible
   person, up to 20 item lines (item, brand, demand price, quantity, negotiable / fixed, note; price x qty), notes. It is
   numbered LOT-YYYYMM-### and waits for the Director: Approve, Negotiate (new prices, the maker edits and submits
   again) or Cancel (photos deleted, details kept). Approved lots are listed by month with their quantity and average
   price, print as a signed PDF, can be updated with the Director's approval and marked arrived at the warehouse. */
(() => {
  "use strict";
  const E = window.EO;
  const { sb, S, C, esc, peso, isoToday, mdy, $, $$, isAdmin, isStaff, pill, toast, fail, ic, busy, num } = E;
  const V = window.EO_VIEWS;
  const meId = () => S.session?.user?.id;
  const MAX_LINES = 20, MAX_PHOTOS = 5; // 3.32: 5 photos (needs 042_po_photos.sql; the server allowed 2 before)
  const ST = { pending: "WAITING FOR REVIEW", negotiation: "PRICE NEGOTIATION", approved: "APPROVED", cancelled: "CANCELLED" };
  const stPill = (p) => `${pill(p.status === "negotiation" ? "pending" : p.status, ST[p.status])}${p.arrived_at ? " " + pill("active", "ARRIVED") : ""}${p.pending_update ? " " + pill("pending", "UPDATE WAITING") : ""}`;
  const avg = (p) => (num(p.total_qty) ? num(p.total_amount) / num(p.total_qty) : 0);
  // The big total: everything included (all item lines), in BDT with the amount in words
  const netBox = (p) => `<div class="po-net"><small>TOTAL NET COST · ALL ITEMS INCLUDED</small><b>BDT ${peso(p.total_amount)}</b>
    <span>${esc(E.words(p.total_amount, "TAKA"))}</span><span class="po-net-s">${qtyText(p.total_qty)} pcs · ${(p.items || []).length} item${(p.items || []).length === 1 ? "" : "s"} · average BDT ${peso(avg(p))} each</span></div>`;
  const qtyText = E.qtyText;
  const monthOf = (d) => String(d || "").slice(0, 7);
  const monthName = (m) => new Date(m + "-01T00:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" }).toUpperCase();
  const notSet = (e) => /purchase_orders|save_purchase_order|schema cache/i.test(e?.message || "");
  const needUpdate = `<div class="empty">Purchase Orders need the database update <b>023_purchase_orders.sql</b>. Run it in the Supabase SQL Editor.</div>`;

  // ---------- list: review box, requests, approved by month, cancelled ----------
  V.purchase = async (tab, month) => {
    E.shell("purchase", "Purchase Order", `<div class="btnrow"><a class="btn primary" href="#newpurchase">${ic("plus")} New Purchase Order</a></div>
      <div id="poBody">${busy()}</div>`, "Requests to buy a lot. The Director approves, asks for a new price (negotiation) or cancels. Approved lots are listed by month with their quantity and average price.");
    // 3.32: not the small photo copies kept for the PDF (print_photos, up to 5 per approved order): only the order page needs them
    const { data, error } = await sb.from("purchase_orders").select("id, po_no, po_date, lot_name, total_qty, total_amount, created_by_name, created_at, status, arrived_at, pending_update, photos, approved_at")
      .order("created_at", { ascending: false }).limit(2000);
    if (!$("#poBody")) return;
    if (error) { $("#poBody").innerHTML = notSet(error) ? needUpdate : `<div class="empty">${esc(error.message)}</div>`; return; }
    const all = data || [];
    expirePhotos(all);
    const waiting = all.filter((p) => ["pending", "negotiation"].includes(p.status) || p.pending_update);
    const approved = all.filter((p) => p.status === "approved"), cancelled = all.filter((p) => p.status === "cancelled");
    const mOf = (p) => monthOf(p.po_date);
    const t = tab || (isAdmin() && waiting.length ? "requests" : "approved");
    const cols = [
      { label: "Lot No", get: (r) => r.po_no }, { label: "Date", get: (r) => mdy(r.po_date) }, { label: "Lot Name", get: (r) => r.lot_name },
      { label: "Quantity", num: true, get: (r) => qtyText(r.total_qty) }, { label: "Average Price (BDT)", num: true, get: (r) => peso(avg(r)) },
      { label: "Total (BDT)", num: true, get: (r) => peso(r.total_amount) }, { label: "Made By", get: (r) => r.created_by_name || "" }, { label: "Status", html: stPill }];
    const monthRows = [...new Set(approved.map(mOf))].sort().reverse().map((m) => {
      const rs = approved.filter((p) => mOf(p) === m), q = rs.reduce((s, p) => s + num(p.total_qty), 0), a = rs.reduce((s, p) => s + num(p.total_amount), 0);
      return { m, n: rs.length, q, a, avg: q ? a / q : 0 };
    });
    $("#poBody").innerHTML = `
      ${isAdmin() && waiting.length ? `<div class="po-review"><div class="po-review-h">${ic("bell")} <b>Review</b> · ${waiting.length} purchase order${waiting.length === 1 ? "" : "s"} waiting for you</div>
        ${waiting.slice(0, 6).map((p) => `<a class="po-rv" href="#po/${p.id}"><b>${esc(p.po_no)}</b><span>${esc(p.lot_name)} · ${qtyText(p.total_qty)} pcs · BDT ${peso(p.total_amount)}</span>${stPill(p)}</a>`).join("")}</div>` : ""}
      <div class="tabs" id="poTabs">${[["requests", `Requests (${waiting.length})`], ["approved", "Approved by Month"], ["cancelled", `Cancelled (${cancelled.length})`]].map(([k, l]) => `<button type="button" data-t="${k}" class="${k === t ? "on" : ""}">${esc(l)}</button>`).join("")}</div>
      <div id="poTab"></div>`;
    const show = (k, m) => {
      $$("#poTabs button").forEach((b) => b.classList.toggle("on", b.dataset.t === k));
      const box = $("#poTab");
      if (k === "requests") { box.innerHTML = E.grid({ cols, rows: waiting, onRow: true, empty: "No purchase orders waiting." }); E.bindGrid(box, waiting, (r) => (location.hash = "po/" + r.id)); return; }
      if (k === "cancelled") { box.innerHTML = E.grid({ cols, rows: cancelled, onRow: true, empty: "No cancelled purchase orders." }); E.bindGrid(box, cancelled, (r) => (location.hash = "po/" + r.id)); return; }
      if (m) {
        const rs = approved.filter((p) => mOf(p) === m), q = rs.reduce((s, p) => s + num(p.total_qty), 0), a = rs.reduce((s, p) => s + num(p.total_amount), 0);
        box.innerHTML = `<div class="btnrow"><button type="button" class="btn small" id="poBack">${ic("back")} All months</button><b class="po-mh">${esc(monthName(m))}</b></div>
          ${E.grid({ cols, rows: rs, onRow: true, foot: {}, empty: "No approved purchase orders this month." })}
          <div class="lp-sum"><span>Lots</span><b>${rs.length}</b><span>Total quantity</span><b>${qtyText(q)}</b><span>Average price</span><b>BDT ${peso(q ? a / q : 0)}</b><span>Total</span><b>BDT ${peso(a)}</b></div>`;
        E.bindGrid(box, rs, (r) => (location.hash = "po/" + r.id));
        $("#poBack").onclick = () => show("approved");
        return;
      }
      box.innerHTML = E.grid({ cols: [{ label: "Month", get: (r) => monthName(r.m) }, { label: "Approved Lots", num: true, get: (r) => r.n }, { label: "Total Quantity", num: true, get: (r) => qtyText(r.q) },
        { label: "Average Price (BDT)", num: true, get: (r) => peso(r.avg) }, { label: "Total (BDT)", num: true, get: (r) => peso(r.a) }], rows: monthRows, onRow: true, empty: "No approved purchase orders yet." });
      E.bindGrid(box, monthRows, (r) => show("approved", r.m));
    };
    $$("#poTabs button").forEach((b) => (b.onclick = () => show(b.dataset.t)));
    show(t, month);
    E.setRecords(`Purchase orders: ${all.length}`);
  };

  // ---------- new / edit form ----------
  const lineRow = (l = {}, i = 0) => `<tr class="po-line"><td class="po-n">${i + 1}</td>
    <td data-l="Item Name"><input type="text" class="pI" maxlength="120" value="${esc(l.item || "")}" placeholder="Item name"></td>
    <td data-l="Brand"><input type="text" class="pB" maxlength="80" value="${esc(l.brand || "")}" placeholder="Brand"></td>
    <td data-l="Demand Price (BDT)"><input type="number" class="pP" min="0" step="0.01" inputmode="decimal" value="${l.price ?? ""}"></td>
    <td data-l="Quantity"><input type="number" class="pQ" min="0" step="1" inputmode="numeric" value="${l.qty ?? ""}"></td>
    <td data-l="Price"><select class="pT"><option value="negotiable" ${l.terms === "fixed" ? "" : "selected"}>Negotiable</option><option value="fixed" ${l.terms === "fixed" ? "selected" : ""}>Fixed</option></select></td>
    <td data-l="Note"><input type="text" class="pN" maxlength="200" value="${esc(l.note || "")}" placeholder="Note"></td>
    <td class="num pA" data-l="Total (BDT)">0.00</td><td><button type="button" class="linkbtn del pX" aria-label="Remove line">${ic("x")}</button></td></tr>`;
  function linesEditor(box, items, onChange) {
    box.innerHTML = `<div class="grid-wrap"><table class="grid po-lines edit"><thead><tr><th>#</th><th>Item Name *</th><th>Brand</th><th class="num">Demand Price (BDT)</th><th class="num">Quantity *</th><th>Price</th><th>Note</th><th class="num">Total (BDT)</th><th></th></tr></thead>
      <tbody>${(items.length ? items : [{}]).map(lineRow).join("")}</tbody>
      <tfoot><tr><td colspan="4"><button type="button" class="btn small po-add">${ic("plus")} Add Item</button> <small class="muted">up to ${MAX_LINES}</small></td><td class="num po-tq">0</td><td colspan="2" class="num po-avg"></td><td class="num po-ta">0.00</td><td></td></tr></tfoot></table></div>`;
    const read = () => $$(".po-line", box).map((tr) => ({ item: $(".pI", tr).value.trim(), brand: $(".pB", tr).value.trim(), price: num($(".pP", tr).value), qty: num($(".pQ", tr).value), terms: $(".pT", tr).value, note: $(".pN", tr).value.trim() }))
      .filter((l) => l.item || l.brand || l.qty);
    const sum = () => {
      $$(".po-line", box).forEach((tr, i) => { $(".po-n", tr).textContent = i + 1; $(".pA", tr).textContent = peso(num($(".pP", tr).value) * num($(".pQ", tr).value)); });
      const ls = read(), q = ls.reduce((s, l) => s + l.qty, 0), a = ls.reduce((s, l) => s + l.price * l.qty, 0);
      $(".po-tq", box).textContent = qtyText(q); $(".po-ta", box).textContent = peso(a); $(".po-avg", box).textContent = q ? `Average BDT ${peso(a / q)}` : "";
      $(".po-add", box).disabled = $$(".po-line", box).length >= MAX_LINES;
      if (onChange) onChange();
    };
    const bind = () => $$(".po-line", box).forEach((tr) => {
      $$("input, select", tr).forEach((x) => (x.oninput = x.onchange = sum));
      $(".pX", tr).onclick = () => { if ($$(".po-line", box).length > 1) tr.remove(); else $$("input", tr).forEach((x) => (x.value = "")); sum(); };
    });
    $(".po-add", box).onclick = () => { if ($$(".po-line", box).length >= MAX_LINES) return; $("tbody", box).insertAdjacentHTML("beforeend", lineRow({}, 0)); bind(); sum(); $(".po-line:last-child .pI", box).focus(); };
    bind(); sum();
    return { read };
  }

  // ---------- voice notes (3.0): record with the microphone or attach an audio file, up to 10; listen, delete, record again ----------
  const MAX_VOICES = 10, MAX_SECONDS = 120;
  const voiceMime = () => (window.MediaRecorder ? ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((m) => MediaRecorder.isTypeSupported(m)) || "" : "");
  function voiceEditor(box, keep, urls) {
    const picked = []; let rec = null, stream = null, timer = null, t0 = 0;
    box.innerHTML = `<div class="vo-bar"><button type="button" class="btn primary vo-rec">${ic("mic")} Record</button><button type="button" class="btn danger vo-stop" hidden>■ Stop</button>
        <span class="vo-time" aria-live="polite"></span><label class="btn vo-attach" for="voFile">${ic("clip")} Attach audio file</label><input type="file" id="voFile" accept="audio/*" multiple hidden></div>
      <div class="vo-list"></div>
      <small class="muted">Up to ${MAX_VOICES} voice notes (${MAX_SECONDS / 60} minutes each). Press <b>Record</b>, speak, press <b>Stop</b>, then listen. The Director listens before deciding; the voice notes are deleted from the server when the order is approved.</small>`;
    const list = $(".vo-list", box), recBtn = $(".vo-rec", box), stopBtn = $(".vo-stop", box), clock = $(".vo-time", box);
    const total = () => keep.length + picked.length;
    const render = () => {
      const items = [...keep.map((k, i) => ({ src: urls.get(k), kind: "k", i })), ...picked.map((x, i) => ({ src: x.url, kind: "p", i }))];
      list.innerHTML = items.map((x, n) => `<div class="vo-row"><b>Voice ${n + 1}</b><audio controls preload="metadata" src="${esc(x.src || "")}"></audio>
        <button type="button" class="linkbtn del" data-rm="${x.kind}${x.i}" aria-label="Delete voice ${n + 1}">${ic("trash")} Delete</button></div>`).join("");
      $$("[data-rm]", list).forEach((b) => (b.onclick = () => { const k = b.dataset.rm; if (k[0] === "k") keep.splice(Number(k.slice(1)), 1); else { URL.revokeObjectURL(picked[Number(k.slice(1))].url); picked.splice(Number(k.slice(1)), 1); } render(); }));
      const full = total() >= MAX_VOICES;
      recBtn.disabled = full || !!rec; $(".vo-attach", box).classList.toggle("disabled", full);
    };
    const add = (file) => { if (total() >= MAX_VOICES) return toast(`Up to ${MAX_VOICES} voice notes.`, true); picked.push({ file, url: URL.createObjectURL(file) }); render(); };
    const done = () => { clearInterval(timer); timer = null; stopBtn.hidden = true; recBtn.hidden = false; clock.textContent = ""; stream?.getTracks().forEach((t) => t.stop()); stream = null; rec = null; render(); };
    recBtn.onclick = async () => {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast("Recording does not work on this device. Use Attach audio file.", true);
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
      catch (_) { return toast("The microphone is not allowed. Allow the microphone for this app, then press Record again.", true); }
      const mime = voiceMime(), chunks = [];
      rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 32000 });
      rec.ondataavailable = (e) => e.data?.size && chunks.push(e.data);
      rec.onstop = () => {
        const type = (rec?.mimeType || mime || "audio/webm").split(";")[0], ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
        const blob = new Blob(chunks, { type });
        done();
        if (blob.size > 800) add(new File([blob], `voice_${Date.now()}.${ext}`, { type })); else toast("Nothing was recorded.", true);
      };
      rec.start(1000); t0 = Date.now(); recBtn.hidden = true; stopBtn.hidden = false;
      timer = setInterval(() => {
        if (!box.isConnected) { try { rec?.stop(); } catch (_) {} return; }
        const sec = Math.floor((Date.now() - t0) / 1000); clock.textContent = `● ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
        if (sec >= MAX_SECONDS) stopBtn.click();
      }, 250);
    };
    stopBtn.onclick = () => { try { rec?.stop(); } catch (_) { done(); } };
    $("#voFile", box).onchange = (e) => { for (const f of Array.from(e.target.files)) { if (!/^audio\//.test(f.type)) { toast(`${f.name} is not an audio file.`, true); continue; } if (f.size > 8 * 1024 * 1024) { toast(`${f.name} is larger than 8 MB.`, true); continue; } add(f); } e.target.value = ""; };
    render();
    return { keep: () => keep, files: () => picked.map((x) => x.file), recording: () => !!rec };
  }

  V.newpurchase = (id) => poForm(null);
  V.editpo = async (id) => {
    E.shell("editpo", "Edit Purchase Order", busy());
    const { data: p } = await sb.from("purchase_orders").select("*").eq("id", id).maybeSingle();
    if (!p) { $("#main").innerHTML = `<div class="empty">Purchase order not found.</div>`; return; }
    if (!["pending", "negotiation"].includes(p.status) || !(isAdmin() || p.created_by === meId())) { location.hash = "po/" + id; return; }
    poForm(p);
  };
  async function poForm(p) {
    if (!isStaff()) { location.hash = "dashboard"; return; }
    E.shell(p ? "editpo" : "newpurchase", p ? `Edit ${p.po_no}` : "New Purchase Order", `
      <form class="window" id="poForm" novalidate><div class="wtitle">${p ? `Purchase Order ${esc(p.po_no)}` : "Purchase Order"}</div><div class="wbody">
        <fieldset class="opt"><legend>Product Photos</legend>
          <div class="po-photos" id="poPics"></div>
          <label class="po-drop" for="poFiles">${ic("camera")}<b>Please upload the product photos (up to ${MAX_PHOTOS})</b><span>অনুগ্রহ করে পণ্যের ছবি আপলোড করুন (সর্বোচ্চ ৫টি)</span></label>
          <input type="file" id="poFiles" accept="image/*" multiple hidden></fieldset>
        <fieldset class="opt"><legend>Voice Notes</legend><div id="poVoice"></div></fieldset>
        <fieldset class="opt"><legend>Lot</legend><div class="fields wide">
          <label for="poLot">Lot Name *</label><input type="text" id="poLot" maxlength="120" value="${esc(p?.lot_name || "")}" placeholder="e.g. Zara">
          <label for="poDate">Date</label><input type="date" id="poDate" value="${esc(p?.po_date || isoToday())}">
          <label for="poProc">Processing Time</label><input type="text" id="poProc" maxlength="80" value="${esc(p?.processing_time || "")}" placeholder="e.g. 7 days">
          <label for="poAuth">Authorized Responsible Person</label><input type="text" id="poAuth" maxlength="120" value="${esc(p?.authorized_person || "")}">
          <span>Request Created By</span><b>${esc(p?.created_by_name || S.profile?.full_name || "")}</b></div></fieldset>
        <fieldset class="opt"><legend>Items</legend><div id="poLines"></div></fieldset>
        <fieldset class="opt"><legend>Notes / Details</legend><textarea id="poNotes" rows="3">${esc(p?.notes || "")}</textarea></fieldset>
        ${p?.status === "negotiation" ? `<div class="banner warn">${ic("bell")} EMON OVERRUNS authority does not agree with the price. Negotiate, change the prices and submit again.${p.director_note ? " Note: " + esc(p.director_note) : ""}</div>` : ""}
      </div><div class="wfoot"><button type="button" class="btn" id="poCancel">Cancel</button><button type="submit" class="btn primary">${p ? (isAdmin() ? "Save" : "Submit Again") : "Submit Purchase Order"}</button></div></form>`);
    const ed = linesEditor($("#poLines"), p?.items || []);
    const vurls = p?.voices?.length ? await E.signedMap(p.voices) : new Map();
    const vo = voiceEditor($("#poVoice"), [...(p?.voices || [])], vurls);
    let keep = [...(p?.photos || [])], picked = [];
    const urls = keep.length ? await E.signedMap(keep) : new Map();
    const showPics = () => {
      $("#poPics").innerHTML = [...keep.map((k, i) => ({ src: urls.get(k), rm: "k" + i })), ...picked.map((f, i) => ({ src: URL.createObjectURL(f), rm: "p" + i }))]
        .map((x) => `<div class="po-pic"><img src="${esc(x.src || "")}" alt="Product photo"><button type="button" data-rm="${x.rm}" aria-label="Remove photo">×</button></div>`).join("");
      $$("#poPics [data-rm]").forEach((b) => (b.onclick = () => { const k = b.dataset.rm; if (k[0] === "k") keep.splice(Number(k.slice(1)), 1); else picked.splice(Number(k.slice(1)), 1); showPics(); }));
      $(".po-drop").hidden = keep.length + picked.length >= MAX_PHOTOS;
    };
    showPics();
    $("#poFiles").onchange = (e) => {
      const all = picked.concat(Array.from(e.target.files)); e.target.value = "";
      if (keep.length + all.length > MAX_PHOTOS) toast(`Up to ${MAX_PHOTOS} photos: only the first ${MAX_PHOTOS} are kept.`, true);
      picked = all.slice(0, MAX_PHOTOS - keep.length); showPics();
    };
    $("#poCancel").onclick = () => history.back();
    $("#poForm").onsubmit = async (e) => {
      e.preventDefault();
      const items = ed.read(), lot = $("#poLot").value.trim();
      if (!lot) return toast("Write the lot name.", true);
      if (!items.length) return toast("Add at least one item.", true);
      const bad = items.findIndex((l) => !l.item || !(l.qty > 0));
      if (bad >= 0) return toast(`Line ${bad + 1}: write the item name and the quantity.`, true);
      if (vo.recording()) return toast("Press Stop to finish the recording first.", true);
      E.setBusy(e.target, true, "Saving");
      const { data: po, error } = await sb.rpc("save_purchase_order", { p_id: p?.id || null, p_data: { lot_name: lot, po_date: $("#poDate").value || null, processing_time: $("#poProc").value.trim(),
        authorized_person: $("#poAuth").value.trim(), notes: $("#poNotes").value.trim(), items } });
      if (error) { E.setBusy(e.target, false); return fail(error, notSet(error) ? "Run the database update 023_purchase_orders.sql first" : "Could not save the purchase order"); }
      const paths = [...keep];
      for (const [i, raw] of picked.entries()) {
        const f = await E.slimFile(raw, "photo");
        const path = `purchase/${po.id}/${i + 1}_${Date.now()}.${E.extOf(f)}`;
        const up = await sb.storage.from("records").upload(path, f, { contentType: f.type });
        if (!up.error) paths.push(path);
      }
      const gone = (p?.photos || []).filter((x) => !paths.includes(x));
      if (paths.join() !== (p?.photos || []).join()) {
        const r = await sb.rpc("set_purchase_photos", { p_id: po.id, p_photos: paths });
        // 3.32: when the photos are not saved the order keeps its old photos and the new uploads are taken off again
        if (r.error) {
          toast(/Up to 2 product photos/.test(r.error.message) ? "The photos could not be saved: more than 2 photos need the database update 042_po_photos.sql. Ask the Director."
            : "The photos could not be saved: " + r.error.message, true);
          const added = paths.filter((x) => !keep.includes(x));
          if (added.length) sb.storage.from("records").remove(added).then(() => {}, () => {});
        } else if (gone.length) sb.storage.from("records").remove(gone).then(() => {}, () => {});
      }
      // the voice notes: the kept ones and the new ones
      const vpaths = [...vo.keep()];
      for (const [i, f] of vo.files().entries()) {
        const path = `purchase/${po.id}/voice_${i + 1}_${Date.now()}.${E.extOf(f)}`;
        const up = await sb.storage.from("records").upload(path, f, { contentType: f.type });
        if (!up.error) vpaths.push(path); else toast("A voice note could not be uploaded: " + up.error.message, true);
      }
      const vgone = (p?.voices || []).filter((x) => !vpaths.includes(x));
      if (vpaths.join() !== (p?.voices || []).join()) {
        const r = await sb.rpc("set_purchase_voices", { p_id: po.id, p_voices: vpaths });
        if (r.error) toast("The voice notes could not be saved: " + r.error.message, true);
        if (vgone.length) sb.storage.from("records").remove(vgone).then(() => {}, () => {});
      }
      toast(p ? "Saved." : `Purchase order ${po.po_no} submitted. The Director reviews it.`);
      location.hash = "po/" + po.id;
    };
  }

  // A small copy of each product photo (JPEG, at most 900 px) kept with the approved purchase order for its PDF; the
  // full photos are deleted one month after approval and the PDF keeps the small copies.
  async function printCopies(urls) {
    const out = [];
    for (const u of urls) {
      try {
        const img = await new Promise((res, rej) => { const i = new Image(); i.crossOrigin = "anonymous"; i.onload = () => res(i); i.onerror = rej; i.src = u; });
        const k = Math.min(1, 900 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement("canvas"); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
        let q = 0.72, d = c.toDataURL("image/jpeg", q);
        while (d.length > 380000 && q > 0.35) { q -= 0.12; d = c.toDataURL("image/jpeg", q); }
        out.push(d);
      } catch (_) { /* a photo that cannot be read is left out */ }
    }
    return out;
  }
  const keepPrint = async (p, urls) => {
    if (!isAdmin() || p.status !== "approved" || p.print_photos?.length || !p.photos?.length) return;
    const copies = await printCopies(p.photos.map((x) => urls.get(x)).filter(Boolean));
    if (copies.length) { const r = await sb.rpc("purchase_order_photos", { p_id: p.id, p_action: "print", p_print: copies }); if (!r.error) p.print_photos = copies; }
  };
  // one month after approval: the full photos are deleted (the PDF keeps the small copies; the server keeps the photos
  // of an order that has no small copies)
  async function expirePhotos(rows) {
    if (!isAdmin()) return;
    const old = rows.filter((p) => p.status === "approved" && p.photos?.length && Date.now() - new Date(p.approved_at).getTime() > 30 * 86400000);
    for (const p of old) {
      const { data: gone } = await sb.rpc("purchase_order_photos", { p_id: p.id, p_action: "expire", p_print: null });
      if (gone?.length) sb.storage.from("records").remove(gone).then(() => {}, () => {});
    }
  }

  // ---------- one purchase order ----------
  V.po = async (id) => {
    E.shell("po", "Purchase Order", busy());
    const here = E.stillHere();
    const { data: p, error } = await sb.from("purchase_orders").select("*").eq("id", id).maybeSingle();
    if (!here()) return;
    if (error && notSet(error)) { $("#main").innerHTML = needUpdate; return; }
    if (!p) { $("#main").innerHTML = `<div class="empty">Purchase order not found. <a href="#purchase">Back to Purchase Orders</a></div>`; return; }
    const urls = p.photos?.length ? await E.signedMap(p.photos) : new Map();
    const vurls = p.voices?.length ? await E.signedMap(p.voices) : new Map();
    if (!here()) return;
    const mine = p.created_by === meId(), open = ["pending", "negotiation"].includes(p.status);
    $(".band h1").textContent = `Purchase Order — ${p.po_no}`;
    const lines = (p.items || []).map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.item)}</td><td>${esc(l.brand || "")}</td><td class="num">${isAdmin() && open ? `<input type="number" class="ngP" data-i="${i}" min="0" step="0.01" value="${l.price}">` : peso(l.price)}</td>
      <td class="num">${qtyText(l.qty)}</td><td>${l.terms === "fixed" ? "Fixed" : "Negotiable"}</td><td>${esc(l.note || "")}</td><td class="num ngA">${peso(l.amount)}</td></tr>`).join("");
    $("#main").innerHTML = `<div class="window"><div class="wtitle">${esc(p.po_no)} · ${esc(p.lot_name)} ${stPill(p)}</div><div class="wbody">
      ${(() => { const src = p.photos?.length ? p.photos.map((x) => urls.get(x) || "") : p.print_photos || [];
        return src.length ? `<div class="po-hero n${src.length}">${src.map((u) => `<button type="button" class="pp" data-img="${esc(u)}"><img src="${esc(u)}" alt="Product photo"></button>`).join("")}</div>` : p.status === "cancelled" ? `<small class="muted">The photos were deleted when the purchase order was cancelled.</small>` : ""; })()}
      ${p.status === "negotiation" ? `<div class="banner warn">${ic("bell")} EMON OVERRUNS authority does not agree with that price. Please negotiate the price, then ${mine ? "press <b>Edit</b>, change the details and submit again" : "the maker edits and submits again"}.${p.director_note ? " Note: " + esc(p.director_note) : ""}</div>` : ""}
      ${p.status === "approved" ? `<div class="banner ok">${ic("check")} APPROVED by Director ${esc(p.approved_by_name || "")} · ${esc(E.dateTime(p.approved_at))}. Buy this lot at the approved price.${p.arrived_at ? ` <b>Arrived at the warehouse</b> ${esc(E.dateTime(p.arrived_at))}${p.arrived_by_name ? " · " + esc(p.arrived_by_name) : ""}.` : ""}</div>` : ""}
      ${p.status === "cancelled" ? `<div class="banner closed">CANCELLED by ${esc(p.cancelled_by_name || "")} · ${esc(E.dateTime(p.cancelled_at))}${p.director_note ? " — " + esc(p.director_note) : ""}</div>` : ""}
      <div class="formgrid"><div class="fields wide"><span>Lot No</span><b class="mono">${esc(p.po_no)}</b><span>Lot Name</span><b>${esc(p.lot_name)}</b><span>Date</span><span>${mdy(p.po_date)}</span>
        <span>Processing Time</span><span>${esc(p.processing_time || "—")}</span></div>
        <div class="fields wide"><span>Authorized Responsible</span><span>${esc(p.authorized_person || "—")}</span><span>Request Created By</span><span>${esc(p.created_by_name || "")} · ${esc(E.dateTime(p.created_at))}</span>
        <span>Average Price</span><b>BDT ${peso(avg(p))}</b></div></div>
      <div class="grid-wrap"><table class="grid po-lines"><thead><tr><th>#</th><th>Item Name</th><th>Brand</th><th class="num">Demand Price (BDT)</th><th class="num">Quantity</th><th>Price</th><th>Note</th><th class="num">Total (BDT)</th></tr></thead>
        <tbody>${lines}</tbody><tfoot><tr><td colspan="4">TOTAL</td><td class="num">${qtyText(p.total_qty)}</td><td colspan="2" class="num">Average BDT <span id="ngAvg">${peso(avg(p))}</span></td><td class="num" id="ngTot">${peso(p.total_amount)}</td></tr></tfoot></table></div>
      ${netBox(p)}
      ${p.voices?.length ? `<div class="po-notes po-voices"><b>${ic("mic")} Voice notes (${p.voices.length})</b>${p.voices.map((v, i) => `<div class="vo-row"><b>Voice ${i + 1}</b><audio controls preload="metadata" src="${esc(vurls.get(v) || "")}"></audio></div>`).join("")}
        <small class="muted">${isAdmin() ? "Listen before you decide. The voice notes are deleted from the server when you approve." : "They are deleted from the server when the Director approves."}</small></div>` : ""}
      ${p.notes ? `<div class="po-notes"><b>Notes / Details</b><p>${esc(p.notes)}</p></div>` : ""}
      ${p.pending_update ? `<div class="linked-pays"><div class="lp-head"><b>Update asked by ${esc(p.pending_update.by || "")} · ${esc(E.dateTime(p.update_requested_at))}</b></div>
        ${E.grid({ cols: [{ label: "Item", get: (l) => l.item }, { label: "Brand", get: (l) => l.brand || "" }, { label: "Price (BDT)", num: true, get: (l) => peso(l.price) }, { label: "Quantity", num: true, get: (l) => qtyText(l.qty) }, { label: "Total (BDT)", num: true, get: (l) => peso(l.amount) }], rows: p.pending_update.items || [] })}
        ${isAdmin() ? `<div class="btnrow"><button type="button" class="btn ok" data-up="accept_update">${ic("check")} Approve Update</button><button type="button" class="btn danger" data-up="refuse_update">Refuse</button></div>` : ""}</div>` : ""}
      ${isAdmin() && open ? `<fieldset class="opt review"><legend>Director's Decision</legend><div class="fields wide"><label for="poNote">Note</label><input type="text" id="poNote" placeholder="Optional; sent with a negotiation or a cancel"></div>
        <p class="muted" style="margin:4px 0">To negotiate, change the prices in the table above, then press <b>Negotiate</b>: ${esc(p.created_by_name || "the maker")} is told (notice and message) and submits again.</p>
        <div class="btnrow"><button type="button" class="btn ok" data-d="approve">${ic("check")} Approve</button><button type="button" class="btn" data-d="negotiate">${ic("edit")} Negotiate</button><button type="button" class="btn danger" data-d="cancel">Cancel Order</button></div></fieldset>` : ""}
      </div><div class="wfoot">
        ${open && (mine || isAdmin()) ? `<a class="btn" href="#editpo/${p.id}">${ic("edit")} Edit</a><button type="button" class="btn danger" id="poDel">${ic("trash")} Delete</button>` : ""}
        ${p.status === "approved" ? `<button type="button" class="btn primary" id="poPdf">${ic("print")} PDF</button>${!p.arrived_at ? `<button type="button" class="btn" id="poArr">${ic("box")} Mark Arrived at Warehouse</button>` : ""}${(mine || isAdmin()) && !p.pending_update ? `<button type="button" class="btn" id="poUpd">${ic("edit")} Request Update</button>` : ""}` : ""}
        <a class="btn" href="#purchase">Close</a></div></div>`;
    $$("[data-img]").forEach((b) => (b.onclick = () => b.dataset.img && E.lightbox(b.dataset.img)));
    // the Director's new prices: totals follow as they are typed
    const ngItems = () => (p.items || []).map((l, i) => { const x = $(`.ngP[data-i="${i}"]`); const price = x ? num(x.value) : num(l.price); return { ...l, price, amount: Math.round(price * num(l.qty) * 100) / 100 }; });
    $$(".ngP").forEach((x) => (x.oninput = () => {
      const it = ngItems(); $$(".ngA").forEach((td, i) => (td.textContent = peso(it[i].amount)));
      const a = it.reduce((s, l) => s + l.amount, 0); $("#ngTot").textContent = peso(a); $("#ngAvg").textContent = peso(num(p.total_qty) ? a / num(p.total_qty) : 0);
    }));
    $$("[data-d]").forEach((b) => (b.onclick = async () => {
      const a = b.dataset.d, note = $("#poNote").value.trim();
      if (a === "cancel" && !(await E.confirmBox(`Cancel <b>${esc(p.po_no)}</b> (${esc(p.lot_name)})? Its photos are deleted; the details are kept in Cancelled.`, { ok: "Cancel Order", danger: true }))) return;
      if (a === "negotiate" && !ngItems().some((l, i) => l.price !== num(p.items[i].price)) && !note) return toast("Change a price or write a note for the negotiation.", true);
      b.disabled = true;
      const { data: gone, error: e2 } = await sb.rpc("decide_purchase_order", { p_id: p.id, p_action: a, p_note: note || null, p_items: a === "negotiate" ? ngItems() : null });
      if (e2) { b.disabled = false; return fail(e2, "Could not save the decision"); }
      if (gone?.length) sb.storage.from("records").remove(gone).then(() => {}, () => {});
      toast(a === "approve" ? `${p.po_no} approved. ${p.created_by_name || "The maker"} is told.` : a === "negotiate" ? `Sent back for negotiation. ${p.created_by_name || "The maker"} is told.` : `${p.po_no} cancelled.`);
      E.refreshBadge?.(); V.po(id);
    }));
    $$("[data-up]").forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      const { error: e2 } = await sb.rpc("purchase_order_after", { p_id: p.id, p_action: b.dataset.up, p_data: null });
      if (e2) { b.disabled = false; return fail(e2, "Could not decide the update"); }
      toast(b.dataset.up === "accept_update" ? "Update approved: the purchase order shows the new details." : "Update refused."); V.po(id);
    }));
    if ($("#poDel")) $("#poDel").onclick = async () => {
      if (!(await E.confirmBox(`Delete purchase order <b>${esc(p.po_no)}</b>? This cannot be undone.`, { ok: "Delete", danger: true }))) return;
      const { data: gone, error: e2 } = await sb.rpc("delete_purchase_order", { p_id: p.id });
      if (e2) return fail(e2, "Could not delete");
      if (gone?.length) sb.storage.from("records").remove(gone).then(() => {}, () => {});
      toast("Deleted."); location.hash = "purchase";
    };
    if ($("#poArr")) $("#poArr").onclick = async (e) => {
      if (!(await E.confirmBox(`Mark lot <b>${esc(p.lot_name)}</b> (${esc(p.po_no)}) as ARRIVED at the warehouse?`, { ok: "Arrived" }))) return;
      e.target.disabled = true;
      const { error: e2 } = await sb.rpc("purchase_order_after", { p_id: p.id, p_action: "arrived", p_data: null });
      if (e2) { e.target.disabled = false; return fail(e2, "Could not mark it arrived"); }
      toast("Marked arrived at the warehouse."); V.po(id);
    };
    if ($("#poUpd")) $("#poUpd").onclick = () => {
      const m = E.modal(`Request Update — ${p.po_no}`, `<p class="muted" style="margin-top:0">The market price can go up or down. Change the items and prices; the Director approves the update and the purchase order then shows the new details.</p>
        <div id="upLines"></div><div class="fields wide"><label for="upProc">Processing Time</label><input type="text" id="upProc" value="${esc(p.processing_time || "")}"><label for="upNotes">Notes</label><input type="text" id="upNotes" value="${esc(p.notes || "")}"></div>`,
        `<button type="button" class="btn" data-x>Cancel</button><button type="button" class="btn primary" data-ok>Send to the Director</button>`, { wide: true });
      const ed = linesEditor($("#upLines", m.el), p.items || []);
      $("[data-x]", m.el).onclick = m.close;
      $("[data-ok]", m.el).onclick = async (e) => {
        const items = ed.read(); if (!items.length) return toast("Add at least one item.", true);
        e.target.disabled = true;
        const { error: e2 } = await sb.rpc("purchase_order_after", { p_id: p.id, p_action: "request_update", p_data: { items, processing_time: $("#upProc", m.el).value, notes: $("#upNotes", m.el).value } });
        if (e2) { e.target.disabled = false; return fail(e2, "Could not send the update"); }
        m.close(); toast("Update sent to the Director."); V.po(id);
      };
    };
    keepPrint(p, urls);
    if ($("#poPdf")) $("#poPdf").onclick = async () => { await Promise.all([E.loadSignatures(), keepPrint(p, urls)]); E.openPreview(`Purchase Order ${p.po_no}`, poPage(p, urls)); };
    E.setRecords(`Purchase order: ${p.po_no}`);
  };

  // A document with a long list of lines is split over pages: page 1 has the head and the top part, the next pages a short
  // head and more lines, the last page the total and the bottom part (declaration, signatures). Never cut off.
  // caps: single = lines when everything is on one page, first / next = lines on a page when there are more pages, last = lines
  // on the last page when it also carries the bottom (otherwise the bottom gets a page of its own).
  function pagedDoc({ head, top = "", contHead, thead, rows, rowHtml, totalRow, boxTitle, bottom, caps }) {
    const table = (chunk, from, total) => E.box(boxTitle, `<table class="ptl"><thead>${thead}</thead><tbody>${chunk.map((r, i) => rowHtml(r, from + i)).join("")}${total ? totalRow : ""}</tbody></table>`);
    if (rows.length <= caps.single) return [`${head}${top}${table(rows, 0, true)}${bottom}`];
    const chunks = [rows.slice(0, caps.first)];
    for (let i = caps.first; i < rows.length; i += caps.next) chunks.push(rows.slice(i, i + caps.next));
    const pages = []; let from = 0;
    chunks.forEach((c, k) => {
      const last = k === chunks.length - 1, carry = last && c.length <= caps.last;
      pages.push(`${k ? contHead : head + top}${table(c, from, last)}${carry ? bottom : ""}`);
      from += c.length;
    });
    if (!(chunks[chunks.length - 1].length <= caps.last)) pages.push(`${contHead}${bottom}`);
    return pages;
  }

  // ---------- the approved purchase order (PDF) ----------
  function poPage(p, urls) {
    const sign = E.approvedBy(p.approved_by, p.approved_by_name, p.approved_at);
    const pics = p.print_photos?.length ? p.print_photos : (p.photos || []).map((x) => urls.get(x)).filter(Boolean);
    const right = `<img src="${E.pdf417DataUrl("EMONPO|" + p.po_no)}" alt="" class="ph-bar"><div class="mono">${esc(p.po_no)}</div>`;
    const rows = p.items || [];
    return pagedDoc({
      head: E.printHead("PURCHASE ORDER", right), contHead: E.printHead(`PURCHASE ORDER ${p.po_no} (CONTINUED)`, ""),
      top: `${pics.length ? `<div class="po-print-pics n${pics.length}">${pics.map((u) => `<img src="${esc(u)}" alt="Product photo">`).join("")}</div>` : ""}
        ${E.box("Lot", `<div class="pgrid2">${E.cell("Lot No", p.po_no)}${E.cell("Lot Name", p.lot_name)}${E.cell("Date", mdy(p.po_date))}${E.cell("Processing Time", p.processing_time || "—")}
          ${E.cell("Authorized Responsible", p.authorized_person || "—")}${E.cell("Request Created By", p.created_by_name || "")}</div>`)}`,
      boxTitle: "Items (BDT — taka)", thead: `<tr><th>#</th><th>Item Name</th><th>Brand</th><th class="num">Price (BDT)</th><th class="num">Qty</th><th>Price</th><th class="num">Total (BDT)</th></tr>`,
      rows, rowHtml: (l, i) => `<tr><td>${i + 1}</td><td>${esc(l.item)}${l.note ? `<br><small>${esc(l.note)}</small>` : ""}</td><td>${esc(l.brand || "")}</td><td class="num">${peso(l.price)}</td><td class="num">${qtyText(l.qty)}</td><td>${l.terms === "fixed" ? "FIXED" : "NEGOTIABLE"}</td><td class="num">${peso(l.amount)}</td></tr>`,
      totalRow: `<tr class="ptl-tot"><td colspan="4">TOTAL · AVERAGE PRICE BDT ${peso(avg(p))}</td><td class="num">${qtyText(p.total_qty)}</td><td></td><td class="num">${peso(p.total_amount)}</td></tr>`,
      bottom: `${netBox(p)}${p.notes ? E.box("Notes / Details", `<div class="pcell"><div class="pv" style="white-space:pre-wrap">${esc(p.notes)}</div></div>`) : ""}
        <p class="pdecl">EMON OVERRUNS authority approved this lot — buy this purchase order immediately at the approved price.</p>
        <p class="po-warn"><b>Warning:</b> this approval does not mean the products must be bought only at the approved price. Depending on the market, the price of this lot can sometimes be higher or lower. This order is for this lot, and all product designs are APPROVED to buy. For a different price, the person who made the purchase order requests an update, and the new details show here after the EOA approves it.</p>
        ${E.sigs("Request Created By: " + esc(p.created_by_name || ""), "Approved by", sign)}`,
      caps: pics.length ? { single: 5, first: 9, next: 22, last: 11 } : { single: 11, first: 15, next: 22, last: 11 }
    });
  }
  E.pagedDoc = pagedDoc;
})();
