/* EMON OVERRUNS E-PORTAL — Purchase Orders (3.0, in place of Community).
   A purchase order asks to buy one lot: photos (up to 2), lot name, date, processing time, the authorized responsible
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
  const MAX_LINES = 20, MAX_PHOTOS = 2;
  const ST = { pending: "WAITING FOR REVIEW", negotiation: "PRICE NEGOTIATION", approved: "APPROVED", cancelled: "CANCELLED" };
  const stPill = (p) => `${pill(p.status === "negotiation" ? "pending" : p.status, ST[p.status])}${p.arrived_at ? " " + pill("active", "ARRIVED") : ""}${p.pending_update ? " " + pill("pending", "UPDATE WAITING") : ""}`;
  const avg = (p) => (num(p.total_qty) ? num(p.total_amount) / num(p.total_qty) : 0);
  const qtyText = E.qtyText || ((n) => Number(n || 0).toLocaleString("en-PH"));
  const monthOf = (d) => String(d || "").slice(0, 7);
  const monthName = (m) => new Date(m + "-01T00:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" }).toUpperCase();
  const notSet = (e) => /purchase_orders|save_purchase_order|schema cache/i.test(e?.message || "");
  const needUpdate = `<div class="empty">Purchase Orders need the database update <b>023_purchase_orders.sql</b>. Run it in the Supabase SQL Editor.</div>`;

  // ---------- list: review box, requests, approved by month, cancelled ----------
  V.purchase = async (tab, month) => {
    E.shell("purchase", "Purchase Order", `<div class="btnrow"><a class="btn primary" href="#newpurchase">${ic("plus")} New Purchase Order</a></div>
      <div id="poBody">${busy()}</div>`, "Requests to buy a lot. The Director approves, asks for a new price (negotiation) or cancels. Approved lots are listed by month with their quantity and average price.");
    const { data, error } = await sb.from("purchase_orders").select("*").order("created_at", { ascending: false }).limit(2000);
    if (!$("#poBody")) return;
    if (error) { $("#poBody").innerHTML = notSet(error) ? needUpdate : `<div class="empty">${esc(error.message)}</div>`; return; }
    const all = data || [];
    const waiting = all.filter((p) => ["pending", "negotiation"].includes(p.status) || p.pending_update);
    const approved = all.filter((p) => p.status === "approved"), cancelled = all.filter((p) => p.status === "cancelled");
    const months = [...new Set(approved.map((p) => monthOf(p.approved_at ? E.isoDay?.(new Date(p.approved_at)) || p.po_date : p.po_date)))].sort().reverse();
    const mOf = (p) => monthOf(p.po_date);
    const t = tab || (isAdmin() && waiting.length ? "requests" : "approved");
    const cols = [
      { label: "Lot No", get: (r) => r.po_no }, { label: "Date", get: (r) => mdy(r.po_date) }, { label: "Lot Name", get: (r) => r.lot_name },
      { label: "Quantity", num: true, get: (r) => qtyText(r.total_qty) }, { label: "Average Price (₱)", num: true, get: (r) => peso(avg(r)) },
      { label: "Total (₱)", num: true, get: (r) => peso(r.total_amount) }, { label: "Made By", get: (r) => r.created_by_name || "" }, { label: "Status", html: stPill }];
    const monthRows = [...new Set(approved.map(mOf))].sort().reverse().map((m) => {
      const rs = approved.filter((p) => mOf(p) === m), q = rs.reduce((s, p) => s + num(p.total_qty), 0), a = rs.reduce((s, p) => s + num(p.total_amount), 0);
      return { m, n: rs.length, q, a, avg: q ? a / q : 0 };
    });
    void months;
    $("#poBody").innerHTML = `
      ${isAdmin() && waiting.length ? `<div class="po-review"><div class="po-review-h">${ic("bell")} <b>Review</b> · ${waiting.length} purchase order${waiting.length === 1 ? "" : "s"} waiting for you</div>
        ${waiting.slice(0, 6).map((p) => `<a class="po-rv" href="#po/${p.id}"><b>${esc(p.po_no)}</b><span>${esc(p.lot_name)} · ${qtyText(p.total_qty)} pcs · ₱ ${peso(p.total_amount)}</span>${stPill(p)}</a>`).join("")}</div>` : ""}
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
          <div class="lp-sum"><span>Lots</span><b>${rs.length}</b><span>Total quantity</span><b>${qtyText(q)}</b><span>Average price</span><b>₱ ${peso(q ? a / q : 0)}</b><span>Total</span><b>₱ ${peso(a)}</b></div>`;
        E.bindGrid(box, rs, (r) => (location.hash = "po/" + r.id));
        $("#poBack").onclick = () => show("approved");
        return;
      }
      box.innerHTML = E.grid({ cols: [{ label: "Month", get: (r) => monthName(r.m) }, { label: "Approved Lots", num: true, get: (r) => r.n }, { label: "Total Quantity", num: true, get: (r) => qtyText(r.q) },
        { label: "Average Price (₱)", num: true, get: (r) => peso(r.avg) }, { label: "Total (₱)", num: true, get: (r) => peso(r.a) }], rows: monthRows, onRow: true, empty: "No approved purchase orders yet." });
      E.bindGrid(box, monthRows, (r) => show("approved", r.m));
    };
    $$("#poTabs button").forEach((b) => (b.onclick = () => show(b.dataset.t)));
    show(t, month);
    E.setRecords(`Purchase orders: ${all.length}`);
  };

  // ---------- new / edit form ----------
  const lineRow = (l = {}, i = 0) => `<tr class="po-line"><td class="po-n">${i + 1}</td>
    <td><input type="text" class="pI" maxlength="120" value="${esc(l.item || "")}" placeholder="Item name"></td>
    <td><input type="text" class="pB" maxlength="80" value="${esc(l.brand || "")}" placeholder="Brand"></td>
    <td><input type="number" class="pP" min="0" step="0.01" inputmode="decimal" value="${l.price ?? ""}"></td>
    <td><input type="number" class="pQ" min="0" step="1" inputmode="numeric" value="${l.qty ?? ""}"></td>
    <td><select class="pT"><option value="negotiable" ${l.terms === "fixed" ? "" : "selected"}>Negotiable</option><option value="fixed" ${l.terms === "fixed" ? "selected" : ""}>Fixed</option></select></td>
    <td><input type="text" class="pN" maxlength="200" value="${esc(l.note || "")}" placeholder="Note"></td>
    <td class="num pA">0.00</td><td><button type="button" class="linkbtn del pX" aria-label="Remove line">${ic("x")}</button></td></tr>`;
  function linesEditor(box, items, onChange) {
    box.innerHTML = `<div class="grid-wrap"><table class="grid po-lines"><thead><tr><th>#</th><th>Item Name *</th><th>Brand</th><th class="num">Demand Price (₱)</th><th class="num">Quantity *</th><th>Price</th><th>Note</th><th class="num">Total (₱)</th><th></th></tr></thead>
      <tbody>${(items.length ? items : [{}]).map(lineRow).join("")}</tbody>
      <tfoot><tr><td colspan="4"><button type="button" class="btn small po-add">${ic("plus")} Add Item</button> <small class="muted">up to ${MAX_LINES}</small></td><td class="num po-tq">0</td><td colspan="2" class="num po-avg"></td><td class="num po-ta">0.00</td><td></td></tr></tfoot></table></div>`;
    const read = () => $$(".po-line", box).map((tr) => ({ item: $(".pI", tr).value.trim(), brand: $(".pB", tr).value.trim(), price: num($(".pP", tr).value), qty: num($(".pQ", tr).value), terms: $(".pT", tr).value, note: $(".pN", tr).value.trim() }))
      .filter((l) => l.item || l.brand || l.qty);
    const sum = () => {
      $$(".po-line", box).forEach((tr, i) => { $(".po-n", tr).textContent = i + 1; $(".pA", tr).textContent = peso(num($(".pP", tr).value) * num($(".pQ", tr).value)); });
      const ls = read(), q = ls.reduce((s, l) => s + l.qty, 0), a = ls.reduce((s, l) => s + l.price * l.qty, 0);
      $(".po-tq", box).textContent = qtyText(q); $(".po-ta", box).textContent = peso(a); $(".po-avg", box).textContent = q ? `Average ₱ ${peso(a / q)}` : "";
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
          <label class="po-drop" for="poFiles">${ic("camera")}<b>Please upload the product photos (up to 2)</b><span>অনুগ্রহ করে পণ্যের ছবি আপলোড করুন (সর্বোচ্চ ২টি)</span></label>
          <input type="file" id="poFiles" accept="image/*" multiple hidden></fieldset>
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
    let keep = [...(p?.photos || [])], picked = [];
    const urls = keep.length ? await E.signedMap(keep) : new Map();
    const showPics = () => {
      $("#poPics").innerHTML = [...keep.map((k, i) => ({ src: urls.get(k), rm: "k" + i })), ...picked.map((f, i) => ({ src: URL.createObjectURL(f), rm: "p" + i }))]
        .map((x) => `<div class="po-pic"><img src="${esc(x.src || "")}" alt="Product photo"><button type="button" data-rm="${x.rm}" aria-label="Remove photo">×</button></div>`).join("");
      $$("#poPics [data-rm]").forEach((b) => (b.onclick = () => { const k = b.dataset.rm; if (k[0] === "k") keep.splice(Number(k.slice(1)), 1); else picked.splice(Number(k.slice(1)), 1); showPics(); }));
      $(".po-drop").hidden = keep.length + picked.length >= MAX_PHOTOS;
    };
    showPics();
    $("#poFiles").onchange = (e) => { picked = picked.concat(Array.from(e.target.files)).slice(0, MAX_PHOTOS - keep.length); e.target.value = ""; showPics(); };
    $("#poCancel").onclick = () => history.back();
    $("#poForm").onsubmit = async (e) => {
      e.preventDefault();
      const items = ed.read(), lot = $("#poLot").value.trim();
      if (!lot) return toast("Write the lot name.", true);
      if (!items.length) return toast("Add at least one item.", true);
      const bad = items.findIndex((l) => !l.item || !(l.qty > 0));
      if (bad >= 0) return toast(`Line ${bad + 1}: write the item name and the quantity.`, true);
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
        if (r.error) toast("The photos could not be saved: " + r.error.message, true);
        if (gone.length) sb.storage.from("records").remove(gone).then(() => {}, () => {});
      }
      toast(p ? "Saved." : `Purchase order ${po.po_no} submitted. The Director reviews it.`);
      location.hash = "po/" + po.id;
    };
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
    if (!here()) return;
    const mine = p.created_by === meId(), open = ["pending", "negotiation"].includes(p.status);
    $(".band h1").textContent = `Purchase Order — ${p.po_no}`;
    const lines = (p.items || []).map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.item)}</td><td>${esc(l.brand || "")}</td><td class="num">${isAdmin() && open ? `<input type="number" class="ngP" data-i="${i}" min="0" step="0.01" value="${l.price}">` : peso(l.price)}</td>
      <td class="num">${qtyText(l.qty)}</td><td>${l.terms === "fixed" ? "Fixed" : "Negotiable"}</td><td>${esc(l.note || "")}</td><td class="num ngA">${peso(l.amount)}</td></tr>`).join("");
    $("#main").innerHTML = `<div class="window"><div class="wtitle">${esc(p.po_no)} · ${esc(p.lot_name)} ${stPill(p)}</div><div class="wbody">
      ${p.photos?.length ? `<div class="po-hero n${p.photos.length}">${p.photos.map((x) => `<button type="button" class="pp" data-img="${esc(urls.get(x) || "")}"><img src="${esc(urls.get(x) || "")}" alt="Product photo"></button>`).join("")}</div>` : p.status === "cancelled" ? `<small class="muted">The photos were deleted when the purchase order was cancelled.</small>` : ""}
      ${p.status === "negotiation" ? `<div class="banner warn">${ic("bell")} EMON OVERRUNS authority does not agree with that price. Please negotiate the price, then ${mine ? "press <b>Edit</b>, change the details and submit again" : "the maker edits and submits again"}.${p.director_note ? " Note: " + esc(p.director_note) : ""}</div>` : ""}
      ${p.status === "approved" ? `<div class="banner ok">${ic("check")} APPROVED by Director ${esc(p.approved_by_name || "")} · ${esc(E.dateTime(p.approved_at))}. Buy this lot at the approved price.${p.arrived_at ? ` <b>Arrived at the warehouse</b> ${esc(E.dateTime(p.arrived_at))}${p.arrived_by_name ? " · " + esc(p.arrived_by_name) : ""}.` : ""}</div>` : ""}
      ${p.status === "cancelled" ? `<div class="banner closed">CANCELLED by ${esc(p.cancelled_by_name || "")} · ${esc(E.dateTime(p.cancelled_at))}${p.director_note ? " — " + esc(p.director_note) : ""}</div>` : ""}
      <div class="formgrid"><div class="fields wide"><span>Lot No</span><b class="mono">${esc(p.po_no)}</b><span>Lot Name</span><b>${esc(p.lot_name)}</b><span>Date</span><span>${mdy(p.po_date)}</span>
        <span>Processing Time</span><span>${esc(p.processing_time || "—")}</span></div>
        <div class="fields wide"><span>Authorized Responsible</span><span>${esc(p.authorized_person || "—")}</span><span>Request Created By</span><span>${esc(p.created_by_name || "")} · ${esc(E.dateTime(p.created_at))}</span>
        <span>Average Price</span><b>₱ ${peso(avg(p))}</b></div></div>
      <div class="grid-wrap"><table class="grid po-lines"><thead><tr><th>#</th><th>Item Name</th><th>Brand</th><th class="num">Demand Price (₱)</th><th class="num">Quantity</th><th>Price</th><th>Note</th><th class="num">Total (₱)</th></tr></thead>
        <tbody>${lines}</tbody><tfoot><tr><td colspan="4">TOTAL</td><td class="num">${qtyText(p.total_qty)}</td><td colspan="2" class="num">Average ₱ <span id="ngAvg">${peso(avg(p))}</span></td><td class="num" id="ngTot">${peso(p.total_amount)}</td></tr></tfoot></table></div>
      ${p.notes ? `<div class="po-notes"><b>Notes / Details</b><p>${esc(p.notes)}</p></div>` : ""}
      ${p.pending_update ? `<div class="linked-pays"><div class="lp-head"><b>Update asked by ${esc(p.pending_update.by || "")} · ${esc(E.dateTime(p.update_requested_at))}</b></div>
        ${E.grid({ cols: [{ label: "Item", get: (l) => l.item }, { label: "Brand", get: (l) => l.brand || "" }, { label: "Price (₱)", num: true, get: (l) => peso(l.price) }, { label: "Quantity", num: true, get: (l) => qtyText(l.qty) }, { label: "Total (₱)", num: true, get: (l) => peso(l.amount) }], rows: p.pending_update.items || [] })}
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
    if ($("#poPdf")) $("#poPdf").onclick = async () => { await E.loadSignatures(); E.openPreview(`Purchase Order ${p.po_no}`, [poPage(p, urls)]); };
    E.setRecords(`Purchase order: ${p.po_no}`);
  };

  // ---------- the approved purchase order (PDF) ----------
  function poPage(p, urls) {
    const sign = E.approvedBy(p.approved_by, p.approved_by_name, p.approved_at);
    const pics = (p.photos || []).map((x) => urls.get(x)).filter(Boolean);
    return `${E.printHead("PURCHASE ORDER", `<img src="${E.pdf417DataUrl("EMONPO|" + p.po_no)}" alt="" class="ph-bar"><div class="mono">${esc(p.po_no)}</div>`)}
      ${pics.length ? `<div class="po-print-pics n${pics.length}">${pics.map((u) => `<img src="${esc(u)}" alt="Product photo">`).join("")}</div>` : ""}
      ${E.box("Lot", `<div class="pgrid2">${E.cell("Lot No", p.po_no)}${E.cell("Lot Name", p.lot_name)}${E.cell("Date", mdy(p.po_date))}${E.cell("Processing Time", p.processing_time || "—")}
        ${E.cell("Authorized Responsible", p.authorized_person || "—")}${E.cell("Request Created By", p.created_by_name || "")}</div>`)}
      ${E.box("Items", `<table class="ptl"><thead><tr><th>#</th><th>Item Name</th><th>Brand</th><th class="num">Price (PHP)</th><th class="num">Qty</th><th>Price</th><th class="num">Total (PHP)</th></tr></thead><tbody>
        ${(p.items || []).map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.item)}${l.note ? `<br><small>${esc(l.note)}</small>` : ""}</td><td>${esc(l.brand || "")}</td><td class="num">${peso(l.price)}</td><td class="num">${qtyText(l.qty)}</td><td>${l.terms === "fixed" ? "FIXED" : "NEGOTIABLE"}</td><td class="num">${peso(l.amount)}</td></tr>`).join("")}
        <tr class="ptl-tot"><td colspan="4">TOTAL · AVERAGE PRICE PHP ${peso(avg(p))}</td><td class="num">${qtyText(p.total_qty)}</td><td></td><td class="num">${peso(p.total_amount)}</td></tr></tbody></table>
        ${p.notes ? E.cell("Notes / Details", p.notes) : ""}`)}
      <p class="pdecl">EMON OVERRUNS authority approved this lot — buy this purchase order immediately at the approved price.</p>
      <p class="po-warn"><b>Warning:</b> this approval does not mean the products must be bought only at the approved price. Depending on the market, the price of this lot can sometimes be higher or lower. This order is for this lot, and all product designs are APPROVED to buy. For a different price, the person who made the purchase order requests an update, and the new details show here after the EOA approves it.</p>
      ${E.sigs("Request Created By: " + esc(p.created_by_name || ""), "Approved by", sign)}`;
  }
})();
