/* EMON OVERRUNS E-PORTAL — Customer Order (3.37), in EO-Office.
   An order for a customer, like the paper order: the CUSTOMER (3.38.1: no Delivered To, the order goes to the customer it is for),
   ADDRESS, ACCOUNT NO, BATCH NO (3.39; was REFERENCES), DATE, DUE DATE, TERMS, NOTE and the
   lines QUANTITY | BOXES | CODE | PCS | LOT NO. | PRODUCT | PRICE | AMOUNT (QUANTITY = BOXES × PCS, AMOUNT = QUANTITY × PRICE), with up
   to 4 columns of its own (COLOR, SIZE …). The page of the order holds its boxes (the Delivery Sheet): each box is scanned from the QR
   or PDF417 code on its label (one after another, the camera stays open), read from a photo of the label, or typed. The Director
   approves (the authorized signature on the printed order; the Director's own orders are approved at once). The delivery: the boxes
   and the photos (3.45: no rider or car details); COMPLETE makes the customer's invoice by itself, and the printed order shows it.
   3.39: the status in 3 steps: 1 CREATE ORDER (waiting for the Director) → 2 PREPARED (approved) → 3 COMPLETE (delivered). The order
   paper carries a secret code in its barcode and QR code: whoever scans it — signed in or not — opens the order's Complete Delivery
   page (boxes, photos, COMPLETE DELIVERY; 3.45: without EO-Office sign-in it is SUBMITTED and the Director approves it). The printed order has no address and only the Director's approval signature;
   COMPLETE makes the invoice and bills it to the customer. A box whose serial no is in the box database (the Google Sheet, read on
   the EVA AI page) takes its items, brand, CTN, code, pcs and batch from it. */
(() => {
  "use strict";
  const E = window.EO;
  const { sb, S, esc, peso, isoToday, mdy, $, $$, isAdmin, meId, pill, toast, fail, ic, busy, num, fullName, qtyText } = E;
  const V = window.EO_VIEWS;
  const canW = () => E.canWrite("eooffice");
  const notSet = (e) => ["PGRST205", "PGRST202", "42P01"].includes(e?.code) || /customer_order|schema cache/i.test(e?.message || "");
  const needUpdate = `<div class="empty">Customer Order needs the database update <b>RUN_041_TO_046.sql</b>. Run it in the Supabase SQL Editor.</div>`;
  const rand = () => Math.random().toString(36).slice(2, 8);
  const MAX_LINES = 60, MAX_COLS = 4, MAX_PHOTOS = 5;
  // the status of an order in 3 steps (3.39): 1 CREATE ORDER (made, waiting for the Director) → 2 PREPARED (approved: ready to
  // deliver) → 3 COMPLETE (delivered); or CANCELLED
  const STATUS = { pending: ["pending", "CREATE ORDER"], approved: ["approved", "PREPARED"], completed: ["applied", "COMPLETED"], cancelled: ["rejected", "CANCELLED"] };
  const stPill = (o) => o.status === "approved" && o.delivery_request_at ? pill("pending", "DELIVERY SUBMITTED") // 3.45: waits for the Director
    : pill(...(STATUS[o.status] || ["pending", String(o.status).toUpperCase()]));
  const open = (o) => ["pending", "approved"].includes(o.status);
  // 3.54: the Director also changes a COMPLETED order (and its boxes); its invoice changes with it
  const fixable = (o) => open(o) || (o.status === "completed" && isAdmin());
  const boxesText = (n) => `${qtyText(n)} BOX${num(n) === 1 ? "" : "ES"}`;
  // 3.46: a line with a serial no is a box; a line added without one (items, pcs) is kept but not counted as a box
  const nBoxes = (bs) => bs.filter((b) => b.serial_no).length;
  const serHtml = (b) => b.serial_no ? `<b class="mono">${esc(b.serial_no)}</b>` : `<span class="bx-loose" title="No serial no: not counted as a box">-</span>`;
  const boxNo = (bs, b) => b.serial_no ? String(bs.filter((x) => x.serial_no).indexOf(b) + 1) : "—";
  const boxName = (b) => b.serial_no ? `box <b>${esc(b.serial_no)}</b>` : `the line <b>${esc(b.items || "without serial no")}</b>`;
  // the due date: as written, or from the terms (30 DAYS after the order date …)
  const dueOf = (o) => o.due_date || E.termsDue(o.order_date, o.payment_terms) || "";
  const custName = (o) => fullName(o.customers || {});
  // 3.39: the Complete Delivery page of an order paper (its number and its secret code)
  const deliveryHash = (no, code) => `delivery/${encodeURIComponent(no)}/${encodeURIComponent(code)}`;
  const deliveryUrl = (no, code) => `${location.origin}${location.pathname}#${deliveryHash(no, code)}`;

  // ======================================================================
  // The list (EO-Office › Customer Order)
  // ======================================================================
  V.custorders = async () => {
    E.shell("custorders", "Customer Order", `${E.eoTabs("custorders")}<div id="coBody">${busy()}</div>`);
    if (!E.hasModule("eooffice") || !E.isStaff()) { location.hash = "eooffice"; return; }
    const here = E.stillHere();
    const { data, error } = await E.allRows(() => sb.from("customer_orders").select("*, customers(first_name, last_name, account_no)")
      .order("created_at", { ascending: false }).order("id"));
    if (!here() || !$("#coBody")) return;
    if (error) { $("#coBody").innerHTML = notSet(error) ? needUpdate : `<div class="empty">${esc(error.message)}</div>`; return; }
    const rows = data || [], count = (st) => rows.filter((o) => st.includes(o.status)).length;
    const m = isoToday().slice(0, 7), doneM = rows.filter((o) => o.status === "completed" && String(o.order_date).slice(0, 7) === m);
    // 3.42: every order (newest first); the months with orders to open one month; the search finds in every order
    const months = [...new Set(rows.map((o) => String(o.order_date || "").slice(0, 7)).filter(Boolean))].sort().reverse();
    const mLabel = (k) => E.monthText ? E.monthText(k) : k;
    let month = "";
    $("#coBody").innerHTML = `
      <div class="co-top-search"><input type="search" id="coFind" class="co-find" placeholder="Search every order: order no, customer, account no, batch no" aria-label="Search orders" autocomplete="off">
        <button type="button" class="btn" id="coScan">${ic("scan")} Scan</button>${canW() ? `<a class="btn primary" href="#newcustorder">${ic("plus")} New Customer Order</a>` : ""}</div>
      <div class="tiles co-tiles">
        <div class="tile ${count(["pending"]) ? "warn" : ""}"><span class="tile-ic">${ic("clock")}</span><div class="k">Waiting for Approval</div><div class="v">${count(["pending"])}</div></div>
        <div class="tile"><span class="tile-ic">${ic("box")}</span><div class="k">Prepared · To Deliver</div><div class="v">${count(["approved"])}</div></div>
        <div class="tile ok"><span class="tile-ic">${ic("check")}</span><div class="k">Completed This Month (₱)</div><div class="v">${peso(doneM.reduce((s, o) => s + num(o.total_amount), 0))}</div><small>${doneM.length} order(s)</small></div>
      </div>
      <div class="co-months" id="coMonths"><button type="button" data-m="" class="on">All Orders <small>${rows.length}</small></button>${months.map((k) => `<button type="button" data-m="${k}">${esc(mLabel(k))} <small>${rows.filter((o) => String(o.order_date).startsWith(k)).length}</small></button>`).join("")}</div>
      <div id="coGrid"></div>`;
    const hay = rows.map((o) => [o.order_no, custName(o), o.customers?.account_no, o.reference, STATUS[o.status]?.[1]].join(" ").toLowerCase());
    const cols = [{ label: "Order No", get: (o) => o.order_no }, { label: "Date", get: (o) => mdy(o.order_date) }, { label: "Customer", html: (o) => `<b>${esc(custName(o))}</b><br><small class="mono">${esc(o.customers?.account_no || "")}</small>` },
      { label: "Batch No", get: (o) => o.reference || "" }, { label: "Boxes", num: true, get: (o) => qtyText(o.total_boxes) }, { label: "Pcs", num: true, get: (o) => qtyText(o.total_pcs) }, { label: "Amount (₱)", num: true, get: (o) => peso(o.total_amount) },
      { label: "Status", html: stPill }];
    const paint = () => {
      const w = $("#coFind").value.trim().toLowerCase();
      // a search looks in every month; a month shows its orders
      const shown = rows.filter((o, i) => (w ? hay[i].includes(w) : !month || String(o.order_date).startsWith(month)));
      $("#coGrid").innerHTML = (w ? `<p class="muted">${shown.length} order(s) match “${esc(w)}” (every month)</p>` : month ? `<h3 class="sec">${esc(mLabel(month))} · ${shown.length} order(s)</h3>` : "")
        + E.grid({ cols, rows: shown, onRow: true, empty: w ? "No order matches that." : "No orders here." });
      E.bindGrid($("#coGrid"), shown, (o) => (location.hash = "custorder/" + o.id));
    };
    $$("#coMonths button").forEach((b) => (b.onclick = () => { month = b.dataset.m; $("#coFind").value = ""; $$("#coMonths button").forEach((x) => x.classList.toggle("on", x === b)); paint(); }));
    $("#coFind").oninput = paint;
    $("#coScan").onclick = () => E.scanDialog((text) => E.openScanned(text));
    paint();
    E.setRecords(`Customer orders: ${rows.length}`);
  };

  // ======================================================================
  // New / Edit Order
  // ======================================================================
  V.newcustorder = async (custId) => {
    if (!canW()) { location.hash = "custorders"; return; }
    const here = E.stillHere();
    const c = custId ? await E.getCustomer(custId) : null;
    if (here()) orderForm(null, c);
  };
  V.editcustorder = async (id) => {
    E.shell("editcustorder", "Edit Customer Order", busy());
    const here = E.stillHere();
    const { data: o, error } = await sb.from("customer_orders").select("*, customers(*)").eq("id", id).maybeSingle();
    if (!here()) return;
    if (error && notSet(error)) { $("#main").innerHTML = needUpdate; return; }
    if (!o) { $("#main").innerHTML = `<div class="empty">Order not found.</div>`; return; }
    if (!canEdit(o)) { location.hash = "custorder/" + id; return; }
    orderForm(o, o.customers);
  };
  const canEdit = (o) => canW() && (isAdmin() ? fixable(o) : o.status === "pending" && o.created_by === meId());

  function orderForm(o, preset) {
    const terms0 = o?.payment_terms || "";
    const known = !terms0 || E.TERMS.includes(terms0);
    E.shell(o ? "editcustorder" : "newcustorder", o ? `Edit ${o.order_no}` : "New Customer Order", `
      <form class="window" id="coForm" novalidate><div class="wtitle">${o ? `Customer Order ${esc(o.order_no)}` : "Customer Order"}</div><div class="wbody">
        ${o?.status === "completed" ? `<div class="banner warn">This order is COMPLETED. Saving it changes its invoice too (boxes, pcs, amount, terms, date). The customer stays the same.</div>` : ""}
        <fieldset class="opt"><legend>Customer (ACTIVE accounts only)</legend><div id="coCust"></div></fieldset>
        <fieldset class="opt"><legend>Order</legend><div class="formgrid">
          <div class="fields wide">
            <label for="coDate">Date</label><input type="date" id="coDate" value="${esc(o?.order_date || isoToday())}">
            <label for="coRef">Batch No</label><input type="text" id="coRef" maxlength="60" value="${esc(o?.reference || "")}" placeholder="e.g. SS-13">
            <label for="coTerms">Terms of Payment</label><select id="coTerms"><option value="">— Choose the terms —</option>${E.TERMS.map((x) => `<option ${x === terms0 ? "selected" : ""}>${x}</option>`).join("")}<option value="OTHER" ${known ? "" : "selected"}>OTHER (type the terms)</option></select>
            <label for="coTermsX" class="cotx" ${known ? "hidden" : ""}>Other Terms</label><input type="text" id="coTermsX" class="cotx" maxlength="60" value="${known ? "" : esc(terms0)}" ${known ? "hidden" : ""}>
            <label for="coDue">Due Date</label><input type="date" id="coDue" value="${esc(o?.due_date || "")}">
          </div>
          <div class="fields wide">
            <label for="coAddr">Address</label><input type="text" id="coAddr" maxlength="300" value="${esc(o?.address || "")}" placeholder="The customer's address when empty">
            <label for="coNote">Note</label><input type="text" id="coNote" maxlength="500" value="${esc(o?.note || "")}">
            <span>Order No</span><small>${o ? `<b class="mono">${esc(o.order_no)}</b>` : "Given by the system when you save (OR-YYYYMM-####)."}</small>
          </div></div></fieldset>
        <fieldset class="opt"><legend>Scan Boxes</legend>
          <div class="btnrow cf-scan"><button type="button" class="btn primary" id="cfScan">${ic("scan")} Scan Boxes</button>
            <label class="btn" for="cfPhoto">${ic("image")} Box Label Photo</label><input type="file" id="cfPhoto" accept="image/*" multiple hidden>
            <span class="cf-type"><input type="text" id="cfSer" maxlength="60" placeholder="or type a serial no, e.g. U20261238" aria-label="Box serial no"><button type="button" class="btn" id="cfAdd">${ic("plus")} Add</button></span></div>
          <p class="muted" style="margin:6px 0">Each box scanned fills the order lines from the box database (your Google Sheet): product and brand, code (style), pcs and lot no (batch). Then write the price. The boxes go on the order when you save it.</p>
          <div id="cfList"></div></fieldset>
        <fieldset class="opt"><legend>Order Lines</legend><div id="coLines"></div></fieldset>
      </div><div class="wfoot"><button type="button" class="btn" id="coCancel">Cancel</button><button type="submit" class="btn primary">${o ? "Save" : isAdmin() ? "Save Order" : "Save and Send to the Director"}</button></div></form>`,
      isAdmin() ? "" : "CREATE ORDER: the order goes to the Director to approve. Approved, it is PREPARED: the Director's signature is on the printed order and the delivery can start.");
    let cust = preset && preset.status === "active" ? preset : null;
    const fillFrom = (c) => { if (!$("#coAddr").value.trim()) $("#coAddr").placeholder = c.address || ""; };
    E.customerPicker($("#coCust"), { statuses: ["active"], onPick: (c) => { cust = c; fillFrom(c); }, preset: cust || undefined });
    if (preset && !cust) toast(`${fullName(preset)}'s account is ${String(preset.status).toUpperCase()}: an order is made only for an ACTIVE account.`, true);
    const ed = linesEditor($("#coLines"), o?.lines || [], o?.extra_columns || []);
    // 3.40: boxes scanned (or typed) on the form: each fills the lines from the box database and goes on the order when saved
    const picked = [];
    const listBoxes = () => {
      const pcs = picked.reduce((t, b) => t + num(b.qty), 0);
      $("#cfList").innerHTML = picked.length ? `<p class="cf-sum"><b>${boxesText(picked.length)}</b> scanned · ${qtyText(pcs)} pcs</p>${E.grid({ cols: [{ label: "#", get: (b) => String(picked.indexOf(b) + 1) },
        { label: "Serial No", html: (b) => `<b class="mono">${esc(b.serial_no)}</b>` }, { label: "Product", get: (b) => b.product || "" }, { label: "Brand", get: (b) => b.brand || "" }, { label: "CTN", get: (b) => b.ctn || "" },
        { label: "Code", get: (b) => b.style || "" }, { label: "Pcs", num: true, get: (b) => qtyText(b.qty) }, { label: "Batch", get: (b) => b.batch || "" },
        { label: "", html: (b) => `<button type="button" class="btn small danger" data-cfx="${esc(b.serial_no)}" aria-label="Remove box ${esc(b.serial_no)}">×</button>` }], rows: picked })}` : "";
      $$("[data-cfx]").forEach((x) => (x.onclick = () => { const i = picked.findIndex((b) => b.serial_no === x.dataset.cfx); if (i < 0) return; ed.addBox(picked[i], -1); picked.splice(i, 1); listBoxes(); }));
    };
    const scanBox = async (raw) => {
      const ser = String(raw || "").trim().toUpperCase().replace(/\s+/g, " ").slice(0, 60);
      if (!ser) return "✖ No serial no in that code.";
      if (picked.some((b) => b.serial_no === ser)) return `✖ Box ${ser} is scanned already.`;
      const [st, on] = await Promise.all([sb.from("box_stock").select("*").eq("serial_no", ser).maybeSingle(),
        sb.from("customer_order_boxes").select("order_id, customer_orders(order_no, status)").eq("serial_no", ser)]);
      if (st.error) return `✖ ${/box_stock|schema cache/i.test(st.error.message || "") ? "The box database needs the database update RUN_048_TO_051.sql." : st.error.message}`;
      if (!st.data) return `✖ Box ${ser} is not in the box database (the Google Sheet). ${isAdmin() ? "Press Read Sheet on the EVA AI page." : "The Director reads the sheet on the EVA AI page."}`;
      const other = (on.data || []).find((x) => x.customer_orders && x.customer_orders.status !== "cancelled" && x.order_id !== o?.id);
      if (other) return `✖ Box ${ser} is on order ${other.customer_orders.order_no} already.`;
      const b = st.data;
      if (!ed.addBox(b, 1)) return `✖ The order has up to ${MAX_LINES} lines.`;
      picked.push(b); listBoxes();
      if (!$("#coRef").value.trim()) $("#coRef").value = [...new Set(picked.map((x) => x.batch).filter(Boolean))].join(", ").slice(0, 60);
      return `✔ Box ${ser}: ${[b.product, b.brand && b.brand !== "-" ? b.brand : "", b.qty ? `${qtyText(b.qty)} pcs` : "", b.batch].filter(Boolean).join(" · ")} · ${boxesText(picked.length)}`;
    };
    $("#cfScan").onclick = () => E.scanDialog((text) => scanBox(readLabel(text).serial_no), {
      title: "Scan Boxes — Customer Order", hint: "Point the camera at the QR or PDF417 code of each box label. Each box fills the order lines; press Close when done.", keep: true });
    const typed = async () => { const r = await scanBox($("#cfSer").value); toast(r.slice(2), r.startsWith("✖")); if (r.startsWith("✔")) $("#cfSer").value = ""; $("#cfSer").focus(); };
    $("#cfAdd").onclick = typed;
    $("#cfSer").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); typed(); } };
    $("#cfPhoto").onchange = async (e) => {
      const files = Array.from(e.target.files); e.target.value = "";
      const notes = [];
      for (const f of files) { try { notes.push(await scanBox(readLabel(await E.decodeImageFile(f)).serial_no)); } catch (err) { notes.push(`✖ ${f.name}: ${err.message}`); } }
      const bad = notes.filter((n) => n.startsWith("✖"));
      if (notes.length) toast(bad.length ? bad.map((n) => n.slice(2)).join(" ") : notes[notes.length - 1].slice(2), !!bad.length);
    };
    const terms = () => ($("#coTerms").value === "OTHER" ? $("#coTermsX").value.trim().replace(/\s+/g, " ").toUpperCase() : $("#coTerms").value);
    $("#coTerms").onchange = () => $$(".cotx").forEach((x) => (x.hidden = $("#coTerms").value !== "OTHER"));
    $("#coCancel").onclick = () => history.back();
    $("#coForm").onsubmit = async (e) => {
      e.preventDefault();
      if (!cust) return toast("Choose the customer (an ACTIVE account).", true);
      const { lines, cols } = ed.read();
      if (!lines.length) return toast("Add at least one line.", true);
      const bad = lines.findIndex((l) => !l.product || !(l.qty > 0));
      if (bad >= 0) return toast(`Line ${bad + 1}: write the product, and the boxes and pcs (or the quantity).`, true);
      E.setBusy(e.target, true, "Saving");
      const p_data = { customer_id: cust.id, order_date: $("#coDate").value || null, due_date: $("#coDue").value || null,
        reference: $("#coRef").value, payment_terms: terms(), address: $("#coAddr").value, note: $("#coNote").value, extra_columns: cols, lines };
      const { data: row, error } = picked.length ? await sb.rpc("save_order_with_boxes", { p_id: o?.id || null, p_data, p_boxes: picked.map((b) => b.serial_no) })
        : await sb.rpc("save_customer_order", { p_id: o?.id || null, p_data });
      if (error) { E.setBusy(e.target, false); return fail(error, /save_order_with_boxes/.test(error.message || "") && notSet(error) ? "Run the database update 052_order_scan.sql first" : notSet(error) ? "Run the database update RUN_041_TO_046.sql first" : o?.status === "completed" && /cannot be changed/.test(error.message || "") ? "Run the database update 062_edit_completed_order.sql first" : "Could not save the order"); }
      const withB = picked.length ? ` with ${boxesText(picked.length)}` : "";
      toast(o ? `Saved${withB}.${o.status === "completed" ? " The invoice was changed too." : ""}` : row.status === "approved" ? `Order ${row.order_no} saved and approved${withB}.` : `Order ${row.order_no} saved and sent to the Director${withB}.`);
      location.hash = "custorder/" + row.id;
    };
  }

  // The lines of the form: QUANTITY = BOXES × PCS by itself (typed when there are no boxes or pcs), AMOUNT = QUANTITY × PRICE;
  // + Add Line, + Add Column (up to 4 columns of the order's own; × takes one off).
  function linesEditor(box, lines, cols0) {
    let cols = [...cols0];
    const val = (v) => (v == null || v === "" || v === 0 ? "" : esc(v));
    const lineRow = (l = {}) => `<tr class="co-line">
      <td class="co-n"></td>
      <td><input type="number" class="cQ" min="0" step="1" inputmode="numeric" aria-label="Quantity" value="${val(l.qty)}"></td>
      <td><input type="number" class="cB" min="0" step="1" inputmode="numeric" aria-label="Boxes" value="${val(l.boxes)}"></td>
      <td><input type="text" class="cC" maxlength="30" aria-label="Code" value="${val(l.code)}"></td>
      <td><input type="number" class="cP" min="0" step="1" inputmode="numeric" aria-label="Pcs per box" value="${val(l.pcs)}"></td>
      <td><input type="text" class="cL" maxlength="40" aria-label="Lot No" value="${val(l.lot)}"></td>
      <td><input type="text" class="cN" maxlength="120" aria-label="Product" value="${val(l.product)}"></td>
      ${cols.map((c) => `<td><input type="text" class="cX" data-c="${esc(c)}" maxlength="60" aria-label="${esc(c)}" value="${val(l.extra?.[c])}"></td>`).join("")}
      <td><input type="number" class="cR" min="0" step="0.01" inputmode="decimal" aria-label="Price" value="${val(l.price)}"></td>
      <td class="num cA">0.00</td>
      <td><button type="button" class="btn small cDel" aria-label="Remove line">×</button></td></tr>`;
    const draw = (ls) => {
      box.innerHTML = `<div class="grid-wrap co-wrap"><table class="grid co-lines edit"><thead><tr><th>#</th><th class="num">Total Pcs</th><th class="num">Boxes</th><th>Code</th><th class="num">Pcs / Box</th><th>Lot No.</th><th>Product *</th>
          ${cols.map((c, i) => `<th>${esc(c)} <button type="button" class="co-xcol" data-xc="${i}" aria-label="Remove the column ${esc(c)}" title="Remove the column">×</button></th>`).join("")}<th class="num">Price (₱)</th><th class="num">Amount (₱)</th><th></th></tr></thead>
        <tbody>${(ls.length ? ls : [{}]).map(lineRow).join("")}</tbody>
        <tfoot><tr><td></td><td class="num co-tq">0</td><td class="num co-tb">0</td><td colspan="${4 + cols.length}"><b>TOTAL AMOUNT</b></td><td></td><td class="num co-ta">0.00</td><td></td></tr></tfoot></table></div>
        <div class="btnrow"><button type="button" class="btn small co-add">${ic("plus")} Add Line</button><button type="button" class="btn small co-addc">${ic("plus")} Add Column</button>
          <small class="muted">Total Pcs = boxes × pcs per box (or type the total pcs). Up to ${MAX_LINES} lines and ${MAX_COLS} added columns (for example COLOR or SIZE).</small></div>
        <div class="summary-box co-words"></div>`;
      bind(); sum();
    };
    const read1 = (tr) => {
      const b = num($(".cB", tr).value), p = num($(".cP", tr).value);
      const q = b > 0 && p > 0 ? b * p : num($(".cQ", tr).value);
      return { qty: q, boxes: b, code: $(".cC", tr).value.trim(), pcs: p, lot: $(".cL", tr).value.trim(), product: $(".cN", tr).value.trim(), price: num($(".cR", tr).value),
        extra: Object.fromEntries($$(".cX", tr).map((x) => [x.dataset.c, x.value.trim()])) };
    };
    const blank = (l) => !l.product && !l.code && !l.qty && !l.boxes && !l.pcs;
    const all = () => $$(".co-line", box).map(read1);
    const sum = () => {
      let tq = 0, tb = 0, ta = 0;
      $$(".co-line", box).forEach((tr, i) => {
        const l = read1(tr), auto = l.boxes > 0 && l.pcs > 0, q = $(".cQ", tr);
        $(".co-n", tr).textContent = i + 1;
        q.readOnly = auto; q.classList.toggle("auto", auto);
        if (auto) q.value = l.qty;
        $(".cA", tr).textContent = peso(l.qty * l.price);
        tq += l.qty; tb += l.boxes; ta += l.qty * l.price;
      });
      $(".co-tq", box).textContent = qtyText(tq); $(".co-tb", box).textContent = qtyText(tb); $(".co-ta", box).textContent = peso(ta);
      $(".co-words", box).textContent = `${boxesText(tb)} · ${qtyText(tq)} PCS · ${E.words(ta)}`;
      $(".co-add", box).disabled = $$(".co-line", box).length >= MAX_LINES;
      $(".co-addc", box).disabled = cols.length >= MAX_COLS;
    };
    const bind = () => {
      $$(".co-line", box).forEach((tr) => {
        $$("input", tr).forEach((x) => (x.oninput = sum));
        $(".cDel", tr).onclick = () => { if ($$(".co-line", box).length > 1) tr.remove(); else $$("input", tr).forEach((x) => (x.value = "")); sum(); };
      });
      $$(".co-xcol", box).forEach((b) => (b.onclick = () => { const ls = all(); cols.splice(Number(b.dataset.xc), 1); draw(ls); }));
      $(".co-add", box).onclick = () => { if ($$(".co-line", box).length >= MAX_LINES) return; $("tbody", box).insertAdjacentHTML("beforeend", lineRow({})); bind(); sum(); $(".co-line:last-child .cB", box).focus(); };
      $(".co-addc", box).onclick = () => addColumn((name) => { const ls = all(); cols.push(name); draw(ls); });
    };
    draw(lines);
    const keyOf = (l) => [l.code, l.lot, l.product, l.pcs || ""].map((v) => String(v ?? "").trim().toUpperCase()).join("|");
    // d = 1: the box goes on its line; d = -1: it comes off (an empty line goes); false when there is no room for a new line
    const addBox = (b, d = 1) => {
      const f = { code: String(b.style || "").toUpperCase(), lot: String(b.batch || "").toUpperCase(), product: [b.product, b.brand && b.brand !== "-" ? b.brand : ""].filter(Boolean).join(" · ").toUpperCase(), pcs: num(b.qty) };
      const k = keyOf(f), tr = $$(".co-line", box).find((r) => keyOf(read1(r)) === k);
      if (tr) {
        const n = Math.max(0, num($(".cB", tr).value) + d);
        if (n) $(".cB", tr).value = n; else if ($$(".co-line", box).length > 1) tr.remove(); else $$("input", tr).forEach((x) => (x.value = ""));
        sum(); return true;
      }
      if (d < 0) return true;
      let row = $$(".co-line", box).find((r) => blank(read1(r)));
      if (!row) {
        if ($$(".co-line", box).length >= MAX_LINES) return false;
        $("tbody", box).insertAdjacentHTML("beforeend", lineRow({})); bind(); row = $(".co-line:last-child", box);
      }
      $(".cB", row).value = 1; $(".cC", row).value = f.code; $(".cP", row).value = f.pcs || ""; $(".cL", row).value = f.lot; $(".cN", row).value = f.product;
      sum(); return true;
    };
    return { read: () => ({ lines: all().filter((l) => !blank(l)), cols }), addBox };
  }
  // the name of a new column (in capitals, once, not a column the order has already)
  function addColumn(done) {
    const m = E.modal("Add Column", `<div class="fields wide"><label for="acName">Column Name</label><input type="text" id="acName" maxlength="20" placeholder="e.g. COLOR, SIZE, STYLE"></div>`,
      `<button type="button" class="btn" data-x>Cancel</button><button type="button" class="btn primary" data-ok>Add Column</button>`);
    const go = () => {
      const n = $("#acName", m.el).value.trim().replace(/\s+/g, " ").toUpperCase();
      if (!n) return toast("Write the column name.", true);
      if (["QUANTITY", "QTY", "BOXES", "BOX", "CODE", "PCS", "LOT", "LOT NO", "LOT NO.", "PRODUCT", "PRICE", "AMOUNT"].includes(n) || $$(".co-lines thead th").some((th) => th.firstChild?.textContent.trim().toUpperCase() === n)) return toast(`The order has a ${n} column already.`, true);
      m.close(); done(n);
    };
    $("[data-x]", m.el).onclick = m.close;
    $("[data-ok]", m.el).onclick = go;
    $("#acName", m.el).onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } };
    $("#acName", m.el).focus();
  }

  // ======================================================================
  // The page of an order: details, lines, boxes, the Director's decision, delivery, invoice, prints
  // ======================================================================
  // id: the order's id, or its number (OR-202610-0001: from an invoice or a scanned order; 3.38.1: CO- before, both are found)
  V.custorder = async (id) => {
    E.shell("custorder", "Customer Order", busy());
    const here = E.stillHere(), m = /^(?:CO|OR)-(\d{6}-\d+)$/i.exec(id || ""), nos = m ? [`OR-${m[1]}`, `CO-${m[1]}`] : null;
    const boxesOf = (oid) => sb.from("customer_order_boxes").select("*").eq("order_id", oid).order("created_at").order("id");
    const [{ data: o, error }, bx0] = await Promise.all([
      (nos ? sb.from("customer_orders").select("*, customers(*)").in("order_no", nos) : sb.from("customer_orders").select("*, customers(*)").eq("id", id)).maybeSingle(), nos ? null : boxesOf(id)]);
    if (!here()) return;
    if (error && notSet(error)) { $("#main").innerHTML = needUpdate; return; }
    if (!o) { $("#main").innerHTML = `<div class="empty">Order not found. <a href="#custorders">All orders</a></div>`; return; }
    const bx = bx0 || (await boxesOf(o.id));
    const [inv, urls, dl] = await Promise.all([
      o.invoice_id ? sb.from("invoice_balances").select("*").eq("id", o.invoice_id).maybeSingle().then((r) => r.data, () => null) : null,
      o.delivery_photos?.length ? E.signedMap(o.delivery_photos) : new Map(),
      sb.rpc("co_delivered", { p_order: o.id }).then((r) => (r.error ? null : r.data), () => null)]); // 3.56: what is charged as delivered
    if (!here()) return;
    o._dl = dl;
    draw(o, bx.data || [], inv, urls);
  };

  // 3.39: the page of an order in the style of a profile: the head (order no, status, customer, its numbers, the QR code of the
  // order paper), the 3 steps, the amount, the buttons, and tabs: the lines, the boxes, the delivery, the invoice
  function draw(o, boxes, inv, urls) {
    const c = o.customers || {}, cols = o.extra_columns || [], w = canW();
    const sumPcs = boxes.reduce((s, b) => s + num(b.pcs), 0);
    const deliverNow = !!o.delivery_code && o.status === "approved"; // the paper's Complete Delivery page (048)
    $(".band h1") && ($(".band h1").textContent = `Customer Order — ${o.order_no}`);
    const step = o.status === "completed" ? 3 : o.status === "approved" ? 2 : 1;
    const steps = [["CREATE ORDER", `${o.created_by_name ? esc(o.created_by_name) + " · " : ""}${esc(mdy(o.created_at || o.order_date))}`],
      ["PREPARED", o.approved_at ? `Approved by ${esc(o.approved_by_name || "")} · ${esc(mdy(o.approved_at))}` : "Waiting for the Director's approval"],
      ["COMPLETED", o.completed_at ? `Delivered · ${esc(mdy(o.completed_at))}` : step === 2 ? "Ready for delivery" : "Delivery"]];
    const stepper = `<ol class="co-steps${o.status === "cancelled" ? " off" : ""}">${steps.map(([l, sub], i) => {
      const k = i + 1, done = k < step || o.status === "completed", now = !done && k === step;
      return `<li class="${done ? "done" : now ? "now" : ""}"><span class="co-sn">${done ? "✓" : k}</span><div><b>${l}</b><small>${sub}</small></div></li>`;
    }).join("")}</ol>`;
    const banner = o.status === "pending" ? `<div class="banner warn">${ic("clock")} CREATE ORDER — waiting for the Director's approval. Approved, the order is PREPARED: the Director's signature is on the printed order and the delivery can start.</div>`
      : o.status === "cancelled" ? `<div class="banner closed">CANCELLED${o.cancelled_by_name ? ` by ${esc(o.cancelled_by_name)}` : ""}${o.cancelled_at ? ` on ${esc(mdy(o.cancelled_at))}` : ""}${o.cancel_note ? ` — ${esc(o.cancel_note)}` : ""}</div>`
      : o.status === "approved" && o.delivery_request_at ? `<div class="banner warn">${ic("clock")} DELIVERY SUBMITTED — ${esc(o.delivery_request_by || "ORDER PAPER")} · ${esc(E.dateTime(o.delivery_request_at))}. It waits for the Director's approval: approved, the order is COMPLETED and the invoice is made and billed.</div>`
      : o.status === "completed" ? `<div class="banner ok">✔ COMPLETED — DELIVERED${o.completed_at ? ` on ${esc(mdy(o.completed_at))}` : ""}${o.completed_by_name ? ` by ${esc(o.completed_by_name)}` : ""}${inv ? ` — invoice <b>${esc(inv.invoice_no)}</b> was made for the customer` : ""}</div>` : "";
    const head = `<section class="cust-hero co-hero">
      <div class="ch-pic"><div class="ch-photo co-ic">${ic("box")}</div></div>
      <div class="ch-main">
        <div class="ch-name"><h2>${esc(o.order_no)}</h2>${stPill(o)}</div>
        <div class="ch-sub">${E.canOpen("customer") ? `<a href="#customer/${c.id}"><b>${esc(fullName(c))}</b></a>` : `<b>${esc(fullName(c))}</b>`}${c.account_no ? ` · <span class="mono">${esc(c.account_no)}</span>` : ""}${o.address || c.address ? ` · ${esc(o.address || c.address)}` : ""}</div>
        <div class="ch-ids">${E.idBox("Date", mdy(o.order_date))}${E.idBox("Batch No", o.reference || "")}${E.idBox("Terms of Payment", o.payment_terms || "")}${E.idBox("Due Date", mdy(dueOf(o)))}${E.idBox("Boxes · Pcs", `${qtyText(o.total_boxes)} · ${qtyText(o.total_pcs)}`)}</div>
      </div>
      ${deliverNow ? `<div class="ch-qr"><canvas id="coQr" aria-label="QR code: Complete Delivery"></canvas><small>Verification</small></div>` : ""}
    </section>`;
    const deliverBtn = (cls = "") => `<a class="btn ok ${cls}" href="#${deliveryHash(o.order_no, o.delivery_code)}">${ic("check")} Complete Delivery</a>`;
    const linesHtml = `<div class="grid-wrap co-wrap"><table class="grid co-lines"><thead><tr><th>#</th><th class="num">Boxes</th><th class="num">Pcs</th><th>Code</th><th>Lot No.</th><th>Product</th>${cols.map((x) => `<th>${esc(x)}</th>`).join("")}<th class="num">Price (₱)</th><th class="num">Amount (₱)</th></tr></thead>
        <tbody>${(o.lines || []).map((l, i) => `<tr><td>${i + 1}</td><td class="num">${l.boxes ? qtyText(l.boxes) : ""}</td><td class="num">${qtyText(l.qty)}</td><td>${esc(l.code || "")}</td><td>${esc(l.lot || "")}</td><td>${esc(l.product)}</td>
          ${cols.map((x) => `<td>${esc(l.extra?.[x] || "")}</td>`).join("")}<td class="num">${peso(l.price)}</td><td class="num">${peso(l.amount)}</td></tr>`).join("")}</tbody>
        <tfoot><tr><td></td><td class="num">${qtyText(o.total_boxes)}</td><td class="num">${qtyText(o.total_pcs)}</td><td colspan="${3 + cols.length}"><b>TOTAL AMOUNT</b></td><td></td><td class="num"><b>${peso(o.total_amount)}</b></td></tr></tfoot></table></div>`;
    const delHtml = o.status === "pending" ? `<div class="empty">The delivery starts when the order is PREPARED (approved by the Director).</div>`
      : o.status === "cancelled" ? `<div class="empty">CANCELLED: no delivery.</div>`
      : deliverNow ? `${(o.delivery_photos || []).length ? deliveryHtml(o, urls, false) : ""}${o.delivery_request_at ? "" : `<div class="co-done">${deliverBtn("big")}
          <small>Scan or add the boxes, add the photos of the delivery, then COMPLETE DELIVERY. Whoever holds the printed order can do it too: scan its QR code (VERIFICATION). Not signed in, the delivery waits for the Director's approval.</small></div>`}`
      : deliveryHtml(o, urls, w);
    const invHtml = inv ? `<div class="pgrid2 qc-head">
          <div class="pcell"><div class="pl">Invoice No</div><div class="pv">${E.canOpen("invoice") ? `<a href="#invoice/${inv.id}"><b>${esc(inv.invoice_no)}</b></a>` : `<b>${esc(inv.invoice_no)}</b>`}</div></div>
          ${E.cell("Invoice Date", mdy(inv.invoice_date))}${E.cell("Terms of Payment", inv.payment_terms || "")}${E.cell("Due Date", mdy(inv.due_date))}${E.cell("Amount (₱)", peso(inv.total_amount), "hl")}${E.cell("Balance (₱)", peso(inv.balance))}
          <div class="pcell"><div class="pl">Status</div><div class="pv">${payPill(inv)}</div></div></div>` : `<div class="empty small">The invoice is on the customer's account.</div>`;
    const tabs = ["Order Lines", `Boxes (${nBoxes(boxes)})`, "Delivery", ...(o.status === "completed" ? ["Invoice"] : [])];
    $("#main").innerHTML = `${head}${stepper}${banner}
      ${isAdmin() && o.status === "approved" && o.delivery_request_at ? `<fieldset class="opt review"><legend>Delivery Approval</legend><p class="muted" style="margin:0 0 8px">${nBoxes(boxes)} of ${qtyText(o.total_boxes)} boxes · ${(o.delivery_photos || []).length} photo(s): see the Boxes and Delivery tabs.</p><div class="btnrow"><button type="button" class="btn ok" id="coDvOk">${ic("check")} Approve Delivery · COMPLETE</button><button type="button" class="btn danger" id="coDvNo">Reject</button></div></fieldset>` : ""}
      ${isAdmin() && o.status === "pending" ? `<fieldset class="opt review"><legend>Director's Decision</legend><div class="btnrow"><button type="button" class="btn ok" id="coApprove">${ic("check")} Approve · 2 PREPARED</button><button type="button" class="btn danger" id="coCancelO">Cancel Order</button></div></fieldset>` : ""}
      <div class="due-card co-amt"><div><div class="k">Order Amount</div><div class="v">₱ ${peso(o.total_amount)}</div></div><small>${esc(E.words(o.total_amount))}${o.note ? ` · Note: ${esc(o.note)}` : ""}</small></div>
      <div class="actionbar">
        <button type="button" class="btn primary" id="coAll">${ic("download")} Download All Details (PDF)</button>
        ${deliverNow ? deliverBtn() : ""}
        <button type="button" class="btn" id="coPdf">${ic("print")} Print / Download Order</button><button type="button" class="btn" id="coSheet">${ic("print")} Delivery Sheet</button>
        ${canEdit(o) ? `<a class="btn" href="#editcustorder/${o.id}">${ic("edit")} Edit</a>` : ""}
        <span class="grow"></span>
        ${(isAdmin() ? o.status === "approved" : o.status === "pending" && o.created_by === meId()) ? `<button type="button" class="btn danger" id="coCancelO">Cancel Order</button>` : ""}
        ${isAdmin() ? `<button type="button" class="btn danger" id="coDelO">${ic("trash")} Delete</button>` : ""}
      </div>
      <div class="tabs" id="coPfTabs">${tabs.map((x, i) => `<button type="button" class="${i ? "" : "on"}" data-t="${i}">${esc(x)}</button>`).join("")}</div>
      <div class="tabpanes">
        <div data-p="0">${linesHtml}</div>
        <div data-p="1" hidden id="coBoxes">${boxesHtml(o, boxes, sumPcs, w)}</div>
        <div data-p="2" hidden id="coDel">${delHtml}</div>
        ${o.status === "completed" ? `<div data-p="3" hidden>${invHtml}</div>` : ""}
      </div>`;
    $$("#coPfTabs button").forEach((b) => (b.onclick = () => {
      $$("#coPfTabs button").forEach((x) => x.classList.toggle("on", x === b));
      $$(".tabpanes > div").forEach((x) => (x.hidden = x.dataset.p !== b.dataset.t));
    }));
    E.keepTab("#coPfTabs", "order:" + o.id);
    if (deliverNow) E.drawQr($("#coQr"), deliveryUrl(o.order_no, o.delivery_code));
    const reload = () => V.custorder(o.id);
    if ($("#coApprove")) $("#coApprove").onclick = async (e) => {
      if (!(await E.confirmBox(`Approve order <b>${esc(o.order_no)}</b> for <b>${esc(fullName(c))}</b> (₱ ${peso(o.total_amount)}, ${esc(boxesText(o.total_boxes))})? It becomes PREPARED and your signature goes on the printed order.`, { ok: "Approve Order" }))) return;
      e.target.disabled = true;
      const { error } = await sb.rpc("decide_customer_order", { p_id: o.id, p_action: "approve", p_note: null });
      if (error) { e.target.disabled = false; return fail(error, "Could not approve"); }
      toast(`Order ${o.order_no} approved: PREPARED.`); reload();
    };
    if ($("#coCancelO")) $("#coCancelO").onclick = () => cancelOrder(o, reload);
    // 3.45: a delivery submitted by the order paper (not signed in with EO-Office): the Director approves or rejects it
    const decideDelivery = async (e, action) => {
      const ok = action === "approve"
        ? await E.confirmBox(`Approve the delivery of <b>${esc(o.order_no)}</b>?<br><br>The order becomes COMPLETED and the invoice is made and billed to <b>${esc(custName(o))}</b>: <b>₱ ${peso(o.total_amount)}</b>.`, { title: "Approve Delivery", ok: "Approve Delivery" })
        : await E.confirmBox(`Reject the delivery submitted for <b>${esc(o.order_no)}</b>? The order stays PREPARED and the delivery can be done again.`, { ok: "Reject", danger: true });
      if (!ok) return;
      e.target.disabled = true;
      const { error } = await sb.rpc("decide_delivery", { p_id: o.id, p_action: action });
      if (error) { e.target.disabled = false; return fail(error, "Could not save"); }
      toast(action === "approve" ? `Order ${o.order_no} completed. The invoice was made and billed to ${custName(o)}.` : "Delivery rejected."); reload();
    };
    if ($("#coDvOk")) $("#coDvOk").onclick = (e) => decideDelivery(e, "approve");
    if ($("#coDvNo")) $("#coDvNo").onclick = (e) => decideDelivery(e, "reject");
    if ($("#coDelO")) $("#coDelO").onclick = async () => {
      if (!(await E.confirmBox(`Delete order <b>${esc(o.order_no)}</b> and its ${nBoxes(boxes)} box(es)?${inv ? ` Its invoice <b>${esc(inv.invoice_no)}</b> is deleted too (off the customer's balance).` : ""} This cannot be undone.`, { ok: "Delete", danger: true }))) return;
      const { data: gone, error } = await sb.rpc("delete_customer_order", { p_id: o.id });
      if (error) return fail(error, "Could not delete");
      if (gone?.length) sb.storage.from("records").remove(gone).then(() => {}, () => {});
      toast("Deleted."); location.hash = "custorders";
    };
    $("#coPdf").onclick = async () => { await E.loadSignatures().catch(() => {}); E.openPreview(`Customer Order ${o.order_no}`, orderPages(o, inv)); };
    $("#coSheet").onclick = () => E.openPreview(`Delivery Sheet ${o.order_no}`, sheetPages(o, boxes));
    // 3.38.1: everything in one PDF: the order (with its invoice and delivery), the Delivery Sheet with the boxes, the check photos
    $("#coAll").onclick = async () => { await E.loadSignatures().catch(() => {}); E.openPreview(`Customer Order ${o.order_no} — All Details`, allPages(o, inv, boxes, urls)); };
    bindBoxes(o, boxes, reload);
    if (o.status === "approved" && w && !deliverNow) bindDelivery(o, boxes, urls, reload);
    $$("[data-ph]").forEach((b) => (b.onclick = () => E.lightbox(b.dataset.ph)));
    E.setRecords(`Customer order: ${o.order_no}`);
  }
  const payPill = (i) => pill(i.pay_status);

  function cancelOrder(o, reload) {
    const m = E.modal(`Cancel ${o.order_no}`, `<p>Cancel this order? Its boxes become free for another order.</p><div class="fields wide"><label for="ccNote">Note</label><input type="text" id="ccNote" maxlength="300" placeholder="Optional: why it is cancelled"></div>`,
      `<button type="button" class="btn" data-x>Back</button><button type="button" class="btn danger" data-ok>Cancel Order</button>`);
    $("[data-x]", m.el).onclick = m.close;
    $("[data-ok]", m.el).onclick = async (e) => {
      e.target.disabled = true;
      const { error } = await sb.rpc("decide_customer_order", { p_id: o.id, p_action: "cancel", p_note: $("#ccNote", m.el).value.trim() || null });
      if (error) { e.target.disabled = false; return fail(error, "Could not cancel"); }
      m.close(); toast(`Order ${o.order_no} cancelled.`); reload();
    };
  }

  // ---------- the boxes (Delivery Sheet) ----------
  // 3.49: the boxes still missing, one row for each CODE + BATCH (lot) of the order's lines, so the warehouse finds them easily.
  // A box added counts for its own code + batch (or the same batch / the same code when the line has only one of them);
  // a row with all its boxes here is not listed. Boxes that match no line are listed as NOT ON THE ORDER.
  function boxCheck(lines, boxes) {
    const up = (v) => String(v || "").trim().toUpperCase();
    const rows = [];
    lines.forEach((l) => {
      const n = num(l.boxes); if (!n) return;
      const code = up(l.code), batch = up(l.lot);
      let r = rows.find((x) => x.code === code && x.batch === batch);
      if (!r) rows.push(r = { code, batch, name: l.product || "", want: 0, got: 0 });
      r.want += n;
    });
    const extra = [], left = [];
    let other = 0; // 3.55: boxes of the order with another code / batch than its lines (not MISSING when the order has room for them)
    const free = (x) => x.got < x.want;
    boxes.filter((b) => b.serial_no).forEach((b) => {
      const code = up(b.code), batch = up(b.batch_no);
      const r = rows.find((x) => free(x) && x.code === code && x.batch === batch)
        || rows.find((x) => free(x) && batch && x.batch === batch && (!x.code || !code))
        || rows.find((x) => free(x) && code && x.code === code && (!x.batch || !batch));
      if (r) r.got++; else left.push(b);
    });
    left.forEach((b) => {
      const code = up(b.code), batch = up(b.batch_no), item = up(b.items);
      const r = rows.find((x) => free(x) && item && up(x.name) && (item.includes(up(x.name)) || up(x.name).includes(item))) || rows.find(free);
      if (r) { r.got++; other++; return; }
      let e = extra.find((x) => x.code === code && x.batch === batch); if (!e) extra.push(e = { code, batch, name: b.items || "", n: 0 }); e.n++;
    });
    if (!rows.length && !extra.length) return "";
    const open = rows.filter((r) => r.got < r.want).sort((x, y) => (x.batch + x.code).localeCompare(y.batch + y.code));
    const miss = open.reduce((t, r) => t + r.want - r.got, 0), ext = extra.reduce((t, e) => t + e.n, 0);
    const cell = (v) => (v ? esc(v) : "—");
    const tr = (r, n, cls, st) => `<tr class="${cls}"><td class="bx-n">${qtyText(n)}</td><td class="bx-b">${cell(r.batch)}</td><td class="bx-c">${cell(r.code)}</td>
      <td class="bx-p">${esc(r.name)}</td><td>${r.want ? `${qtyText(r.got)} of ${qtyText(r.want)}` : ""}</td><td><span class="bx-st ${cls}">${st}</span></td></tr>`;
    const sum = !miss && !ext ? `<div class="bx-sum ok">✔ Every box of the order is here.${other ? ` <small>(${boxesText(other)} with another code / batch no than the order lines)</small>` : ""}</div>`
      : `<div class="bx-sum ${miss ? "miss" : "extra"}">${miss ? `<b>${boxesText(miss)} MISSING</b>` : ""}${miss && ext ? " · " : ""}${ext ? `<b>${boxesText(ext)} NOT ON THE ORDER</b>` : ""}</div>`;
    const body = open.map((r) => tr(r, r.want - r.got, "miss", "MISSING")).join("") + extra.map((e) => tr(e, e.n, "extra", "NOT ON THE ORDER")).join("");
    return `<div class="bx-check">${sum}${body ? `<div class="grid-scroll"><table class="bx-table"><thead><tr><th>BOXES</th><th>BATCH NO</th><th>CODE</th><th>PRODUCT</th><th>HERE</th><th></th></tr></thead><tbody>${body}</tbody></table></div>` : ""}</div>`;
  }
  // 3.55: ORDER against DELIVERED (SCANNED while the order is open), boxes and pcs, ✅ when they match, ❌ when not
  const matchMark = (want, got) => (num(got) === num(want) ? `<span class="cm-ok">✅</span>` : `<span class="cm-bad">❌ ${num(got) > num(want) ? "+" : ""}${qtyText(num(got) - num(want))}</span>`);
  // 3.56: the invoice charges the pcs delivered: each box at the price of the order line with its batch no and code
  const amtMark = (want, got) => (Math.abs(num(got) - num(want)) < 0.005 ? `<span class="cm-ok">✅</span>` : `<span class="cm-bad">❌ ${num(got) > num(want) ? "+" : "−"}₱ ${peso(Math.abs(num(got) - num(want)))}</span>`);
  const countMatch = (o, boxes, pcs) => {
    const got = o.status === "completed" ? "DELIVERED" : "SCANNED", dl = o._dl;
    return `<table class="co-match"><thead><tr><th></th><th>ORDER</th><th>${got}</th><th></th></tr></thead><tbody>
      <tr><th>BOX</th><td>${qtyText(o.total_boxes)}</td><td>${nBoxes(boxes)}</td><td>${matchMark(o.total_boxes, nBoxes(boxes))}</td></tr>
      <tr><th>PCS</th><td>${qtyText(o.total_pcs)}</td><td>${qtyText(pcs)}</td><td>${matchMark(o.total_pcs, pcs)}</td></tr>
      ${dl?.has_pcs ? `<tr class="cm-amt"><th>AMOUNT</th><td>₱ ${peso(o.total_amount)}</td><td>₱ ${peso(dl.amount)}</td><td>${amtMark(o.total_amount, dl.amount)}</td></tr>` : ""}</tbody></table>${chargeTable(o)}`;
  };
  const chargeTable = (o) => {
    const dl = o._dl;
    if (!dl?.has_pcs) return "";
    const ls = (dl.lines || []).filter((l) => num(l.ordered) || num(l.delivered));
    if (!ls.some((l) => num(l.ordered) !== num(l.delivered)) && !num(dl.odd_pcs)) return "";
    const done = o.status === "completed", diff = (l) => num(l.delivered) - num(l.ordered);
    const dt = (n) => (n ? `<b class="${n > 0 ? "cm-plus" : "cm-bad"}">${n > 0 ? "+" : ""}${qtyText(n)}</b>` : "✅");
    return `<div class="co-charge"><div class="cc-h">${done ? "CHARGED AS DELIVERED — the invoice" : "WILL BE CHARGED AS SCANNED"}: ₱ ${peso(o.total_amount)} ordered → <b>₱ ${peso(dl.amount)}</b> ${amtMark(o.total_amount, dl.amount)}</div>
      <div class="grid-scroll"><table class="bx-table cc-table"><thead><tr><th>PRODUCT</th><th>BATCH NO</th><th>CODE</th><th class="num">PRICE (₱)</th><th class="num">ORDER PCS</th><th class="num">${done ? "DELIVERED" : "SCANNED"} PCS</th><th class="num">DIFFERENCE</th><th class="num">AMOUNT (₱)</th></tr></thead><tbody>
      ${ls.map((l) => `<tr><td>${esc(l.product || "")}</td><td>${esc(l.lot || "—")}</td><td>${esc(l.code || "—")}</td><td class="num">${peso(l.price)}</td><td class="num">${qtyText(l.ordered)}</td><td class="num">${qtyText(l.delivered)}</td><td class="num">${dt(diff(l))}</td><td class="num">${peso(l.amount)}</td></tr>`).join("")}
      ${num(dl.odd_pcs) ? `<tr><td colspan="5">Boxes with no matching line (at the average price)</td><td class="num">${qtyText(dl.odd_pcs)}</td><td class="num">${dt(num(dl.odd_pcs))}</td><td class="num">${peso(dl.odd_amount)}</td></tr>` : ""}
      <tr class="cc-tot"><td colspan="4">TOTAL</td><td class="num">${qtyText(o.total_pcs)}</td><td class="num">${qtyText(dl.pcs)}</td><td class="num">${dt(num(dl.pcs) - num(o.total_pcs))}</td><td class="num">${peso(dl.amount)}</td></tr></tbody></table></div></div>`;
  };
  function boxesHtml(o, boxes, sumPcs, w) {
    return `${countMatch(o, boxes, sumPcs)}${boxCheck(o.lines || [], boxes)}
      ${w && fixable(o) ? `<div class="btnrow"><button type="button" class="btn primary" id="cbScan">${ic("scan")} Scan Boxes</button><label class="btn" for="cbPhoto">${ic("image")} Box Label Photo</label><input type="file" id="cbPhoto" accept="image/*" multiple hidden>
        <button type="button" class="btn" id="cbType">📦 Add Box</button></div>
        <div class="box-find"><input type="text" id="cbFind" maxlength="60" placeholder="Serial no, e.g. U20261238" aria-label="Find a box by its serial no" autocomplete="off"><button type="button" class="btn primary" id="cbFindGo">${ic("search")} Find &amp; Add</button></div>
        <div id="cbFound" class="box-found" aria-live="polite">${foundHtml(o.id)}</div>
        <p class="muted" style="margin:0 0 8px">Scan each box label (the camera stays open: scan, scan, scan) or find it by its serial no: a box found in the box database (your Google Sheet) is added with all its details at once. Add Box: type a box that is not in the sheet by hand.</p>` : ""}
      ${E.grid({ cols: [{ label: "#", get: (b) => boxNo(boxes, b) }, { label: "Serial No", html: serHtml }, { label: "Code", get: (b) => b.code || "" },
        { label: "Batch No", get: (b) => b.batch_no || "" }, { label: "Items", get: (b) => b.items || "" }, { label: "Brand", get: (b) => b.brand || "" }, { label: "CTN", get: (b) => b.ctn || "" },
        { label: "Pcs", num: true, get: (b) => qtyText(b.pcs) }, { label: "Remarks", get: (b) => b.remarks || "" },
        ...(w && fixable(o) ? [{ label: "", html: (b) => `<span class="co-bact"><button type="button" class="btn small" data-be="${b.id}" aria-label="Change ${esc(b.serial_no || b.items || "line")}">${ic("edit")}</button><button type="button" class="btn small danger" data-bx="${b.id}" aria-label="Remove ${esc(b.serial_no || b.items || "line")}">×</button></span>` }] : [])],
        rows: boxes, empty: "No boxes yet." })}`;
  }
  // what a box added says: its items, brand and pcs (3.39: filled from the box database when the serial no is there)
  const boxSays = (b) => { const t = [b.items, b.brand, b.pcs ? `${qtyText(b.pcs)} pcs` : ""].filter(Boolean).join(" · "); return t ? `: ${t}` : ""; };
  // 3.41: a box is found in the box database (the Google Sheet) by its serial no before it is added; the last result stays
  // shown under the Find box (the page is drawn again after each box)
  const FOUND = new Map(); // order id → [ok, text]
  const foundHtml = (oid) => { const f = FOUND.get(oid); return f ? `<div class="bf-res ${f[0] ? "ok" : "bad"}">${esc(f[1])}</div>` : ""; };
  const serialOf = (raw) => String(raw || "").trim().toUpperCase().replace(/\s+/g, " ").slice(0, 60);
  async function findBox(ser, rpc) {
    const r = rpc ? await rpc("delivery_find_box", { p_serial: ser }) : await sb.from("box_stock").select("*").eq("serial_no", ser).maybeSingle();
    if (r.error) throw new Error(/delivery_find_box/.test(r.error.message || "") && notSet(r.error) ? "Finding boxes needs the database update 053_box_find.sql." : /box_stock/.test(r.error.message || "") ? "The box database needs the database update RUN_048_TO_051.sql." : r.error.message);
    return r.data || null;
  }
  const foundSays = (b) => [b.product, b.brand && b.brand !== "-" ? b.brand : "", b.ctn ? `CTN ${b.ctn}` : "", b.style ? `Code ${b.style}` : "", b.qty ? `${qtyText(b.qty)} pcs` : "", b.batch].filter(Boolean).join(" · ");
  // a serial no (scanned or typed): found in the box database → added with its details; not found → not added
  async function addFound(raw, how, add, rpc, boxes) {
    const ser = serialOf(raw);
    if (!ser) return "✖ No serial no in that code.";
    if (boxes.some((x) => x.serial_no === ser)) return `✔ Box ${ser} is on this order (checked)`;
    let b;
    try { b = await findBox(ser, rpc); } catch (e) { return `✖ ${e.message}`; }
    if (!b) return `✖ Box ${ser} is not in the box database (the Google Sheet). Press Add Box to type its details.`;
    const r = await add({ serial_no: ser, code: b.style || "", batch_no: b.batch || "", items: b.product || "", pcs: b.qty || "" }, how);
    const n = (/(\d[\d,]* of [\d,]+ boxes)$/.exec(r) || [])[1];
    return r.startsWith("✔") && !/checked/.test(r) ? `✔ Found and added: ${ser} · ${foundSays(b)}${n ? ` · ${n}` : ""}` : r;
  }
  // the Find box: Enter or Find & Add; the result stays under it, ready for the next serial no
  function bindFind(pre, oid, run, reload) {
    const input = $(`#${pre}Find`);
    if (!input) return;
    const go = async () => {
      const v = input.value.trim();
      if (!v) return input.focus();
      $(`#${pre}FindGo`).disabled = true;
      const r = await run(v);
      FOUND.set(oid, [r.startsWith("✔"), r.slice(2)]);
      if (r.startsWith("✔")) { await reload(); setTimeout(() => $(`#${pre}Find`)?.focus(), 50); }
      else { $(`#${pre}Found`).innerHTML = foundHtml(oid); $(`#${pre}FindGo`).disabled = false; input.select(); }
    };
    $(`#${pre}FindGo`).onclick = go;
    input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } };
  }
  // A box label read: the serial no (L20260667) and what else the code carries (QTY: 252 PCS, STYLE: 01, ITEMS: …, BATCH …).
  function readLabel(text) {
    const t = String(text || "").replace(/\s+/g, " ").trim();
    const pick = (re) => (re.exec(t) || [])[1] || "";
    const serial = pick(/\b([A-Z]{1,4}-?\d{6,})\b/i) || (t.length <= 40 ? t : t.split(/[\s|;,]+/)[0]);
    return { serial_no: serial.slice(0, 60).toUpperCase(), pcs: pick(/\b(?:QTY|QUANTITY|PCS)\s*[:=]?\s*(\d{1,6})/i) || pick(/\b(\d{1,6})\s*PCS\b/i),
      code: pick(/\b(?:STYLE|CODE)\s*[:=]?\s*([A-Z0-9-]{1,30})/i), batch_no: pick(/\b(?:BATCH|LOT)\s*(?:NO\.?)?\s*[:=]?\s*([A-Z0-9-]{2,40})/i),
      items: pick(/\bITEMS?\s*[:=]\s*(.{1,120}?)(?=\s+(?:QTY|QUANTITY|STYLE|CODE|CTN|BATCH|LOT)\b|[|;]|$)/i).trim() };
  }
  function bindBoxes(o, boxes, reload) {
    if (!$("#cbScan")) return;
    // what a box takes from the order when its label does not say: the one line of the order, or the box added before
    const fill = (d) => {
      if (!d.serial_no) return d; // 3.46: a line without a serial no keeps only what was typed
      const one = (o.lines || []).length === 1 ? o.lines[0] : null, last = boxes[boxes.length - 1];
      const line = one || (d.code && (o.lines || []).find((l) => l.code === String(d.code).toUpperCase()));
      return { ...d, code: d.code || one?.code || last?.code || "", batch_no: d.batch_no || line?.lot || last?.batch_no || "", items: d.items || line?.product || last?.items || "",
        pcs: d.pcs || line?.pcs || last?.pcs || "" };
    };
    let added = 0;
    const add = async (d, how) => {
      const box = fill(d);
      if (!box.serial_no && how !== "typed") return "✖ No serial no in that code.";
      const { data, error } = await sb.rpc("add_order_box", { p_order: o.id, p_data: { ...box, added_how: how } });
      if (error) return /on this order already/i.test(error.message || "") ? `✔ Box ${box.serial_no} is on this order (checked)` : `✖ ${error.message}`;
      boxes.push(data); added++;
      if (!data.serial_no) return `✔ Added${boxSays(data)} — no serial no: not counted as a box`;
      return `✔ Box ${data.serial_no} added${boxSays(data)} · ${nBoxes(boxes)} of ${qtyText(o.total_boxes)} boxes`;
    };
    const found = (raw, how) => addFound(raw, how, add, null, boxes);
    bindFind("cb", o.id, (v) => found(v, "typed"), reload);
    $("#cbScan").onclick = () => E.scanDialog((text) => found(readLabel(text).serial_no, "scan"), {
      title: `Scan Boxes — ${o.order_no}`, hint: "Point the camera at the code of each box label (QR, PDF417 or barcode). Each box found in the box database is added at once: scan the next one. Press Close when done.", keep: true,
      onClose: () => { if (added) { toast(`${added} box(es) added.`); reload(); } } });
    $("#cbPhoto").onchange = async (e) => {
      const files = Array.from(e.target.files); e.target.value = "";
      if (!files.length) return;
      const notes = [];
      for (const f of files) {
        try { notes.push(await found(readLabel(await E.decodeImageFile(f)).serial_no, "photo")); }
        catch (err) { notes.push(`✖ ${f.name}: ${err.message}`); }
      }
      const bad = notes.filter((n) => n.startsWith("✖"));
      if (bad.length) toast(bad.map((n) => n.slice(2)).join(" "), true); else toast(`${added} box(es) added.`);
      if (added) reload();
    };
    $("#cbType").onclick = () => boxForm(o, null, async (d) => { const r = await add(d, "typed"); if (r.startsWith("✖")) { toast(r.slice(2), true); return false; } toast(r.slice(2)); reload(); return true; });
    $$("[data-be]").forEach((b) => (b.onclick = () => {
      const x = boxes.find((y) => y.id === b.dataset.be);
      boxForm(o, x, async (d) => {
        const { error } = await sb.rpc("change_order_box", { p_box: x.id, p_data: d });
        if (error) { fail(error, "Could not save the box"); return false; }
        toast("Saved."); reload(); return true;
      });
    }));
    $$("[data-bx]").forEach((b) => (b.onclick = async () => {
      const x = boxes.find((y) => y.id === b.dataset.bx);
      if (!(await E.confirmBox(`Remove ${boxName(x)} from this order?`, { ok: "Remove", danger: true }))) return;
      b.disabled = true;
      const { error } = await sb.rpc("change_order_box", { p_box: x.id, p_data: null });
      if (error) { b.disabled = false; return fail(error, "Could not remove the box"); }
      toast("Box removed."); reload();
    }));
  }
  // Type a box (x null) or change one; save(d) gives true when it is saved.
  function boxForm(o, x, save) {
    const codes = [...new Set((o.lines || []).map((l) => l.code).filter(Boolean))];
    const m = E.modal(x ? (x.serial_no ? `Box ${x.serial_no}` : "Line without serial no") : "📦 Add Box", `<div class="fields wide">
        <label for="bfSer">Serial No</label><input type="text" id="bfSer" maxlength="60" value="${esc(x?.serial_no || "")}" ${x ? "readonly" : ""} placeholder="e.g. L20260667 · empty: not counted as a box">
        <label for="bfCode">Code</label><input type="text" id="bfCode" maxlength="30" list="bfCodes" value="${esc(x?.code || (codes.length === 1 ? codes[0] : ""))}"><datalist id="bfCodes">${codes.map((k) => `<option value="${esc(k)}">`).join("")}</datalist>
        <label for="bfBatch">Batch No</label><input type="text" id="bfBatch" maxlength="40" value="${esc(x?.batch_no || "")}">
        <label for="bfItems">Items</label><input type="text" id="bfItems" maxlength="120" value="${esc(x?.items || "")}">
        <label for="bfPcs">Pcs</label><input type="number" id="bfPcs" min="0" step="1" inputmode="numeric" value="${x ? num(x.pcs) : ""}">
        <label for="bfRem">Remarks</label><input type="text" id="bfRem" maxlength="120" value="${esc(x?.remarks || "")}"></div>
        <p class="muted" id="bfFrom" style="margin:8px 0 0" hidden></p>${x ? "" : `<p class="muted" style="margin:8px 0 0">With a serial no it counts as a box. Without one it is added (items, pcs) but not counted as a box.</p>`}`,
      `<button type="button" class="btn" data-x>Cancel</button><button type="button" class="btn primary" data-ok>${x ? "Save" : "Add Box"}</button>`);
    if (!x) {
      // a box typed from the line of its code: the batch no, items and pcs of that line
      $("#bfCode", m.el).onchange = () => { const l = (o.lines || []).find((y) => y.code === $("#bfCode", m.el).value.trim().toUpperCase()); if (!l) return;
        if (!$("#bfBatch", m.el).value) $("#bfBatch", m.el).value = l.lot || ""; if (!$("#bfItems", m.el).value) $("#bfItems", m.el).value = l.product || ""; if (!$("#bfPcs", m.el).value && l.pcs) $("#bfPcs", m.el).value = l.pcs; };
      $("#bfCode", m.el).onchange();
      // 3.39: a serial no in the box database (the Google Sheet) fills the box
      if (S.session) $("#bfSer", m.el).onchange = async () => {
        const ser = $("#bfSer", m.el).value.trim().toUpperCase().replace(/\s+/g, " ");
        if (!ser) return;
        const { data: b } = await sb.from("box_stock").select("*").eq("serial_no", ser).maybeSingle().then((r) => r, () => ({ data: null }));
        if (!b || !m.el.isConnected) return;
        if (b.style) $("#bfCode", m.el).value = b.style;
        if (b.batch) $("#bfBatch", m.el).value = b.batch;
        if (b.product) $("#bfItems", m.el).value = b.product;
        if (b.qty) $("#bfPcs", m.el).value = b.qty;
        $("#bfFrom", m.el).hidden = false;
        $("#bfFrom", m.el).textContent = `From the box database: ${[b.product, b.brand && b.brand !== "-" ? b.brand : "", b.ctn ? "CTN " + b.ctn : "", b.batch].filter(Boolean).join(" · ")}`;
      };
    }
    $("[data-x]", m.el).onclick = m.close;
    $("[data-ok]", m.el).onclick = async (e) => {
      const d = { serial_no: $("#bfSer", m.el).value.trim(), code: $("#bfCode", m.el).value.trim(), batch_no: $("#bfBatch", m.el).value.trim(), items: $("#bfItems", m.el).value.trim(),
        pcs: $("#bfPcs", m.el).value, remarks: $("#bfRem", m.el).value.trim() };
      if (!d.serial_no && !d.items && !num(d.pcs)) return toast("Write the serial no, or the items and pcs.", true);
      e.target.disabled = true;
      if (await save(d)) m.close(); else e.target.disabled = false;
    };
    $(x ? "#bfPcs" : "#bfSer", m.el).focus();
  }

  // ---------- delivery: the photos, COMPLETE (3.45: no rider or car details) ----------
  function deliveryHtml(o, urls, w) {
    const pics = (o.delivery_photos || []).map((p) => ({ p, u: urls.get(p) || "" }));
    const edit = o.status === "approved" && w;
    const photos = `<div class="po-photos co-photos">${pics.map((x, i) => `<div class="po-pic"><button type="button" class="co-ph" data-ph="${esc(x.u)}" aria-label="Open delivery photo ${i + 1}"><img src="${esc(x.u)}" alt="Delivery photo"></button>${edit ? `<button type="button" data-rmph="${esc(x.p)}" aria-label="Remove photo">×</button>` : ""}</div>`).join("")}</div>`;
    if (!edit) return `<div class="pgrid2 qc-head">${E.cell("Delivered", o.delivered_at ? E.dateTime(o.delivered_at) : "")}${E.cell(o.status === "completed" ? "Completed By" : "Submitted By", o.completed_by_name || o.delivery_request_by || "")}</div>${pics.length ? photos : ""}`;
    return `<h4 class="co-h4">Delivery Photos (optional, up to ${MAX_PHOTOS})</h4>${photos}
      <div class="btnrow"><label class="btn" for="dvPic" id="dvPicL" ${pics.length >= MAX_PHOTOS ? "hidden" : ""}>${ic("camera")} Add Photo</label><input type="file" id="dvPic" accept="image/*" multiple hidden></div>
      <div class="co-done"><button type="button" class="btn ok big" id="dvDone">${ic("check")} Complete Delivery</button>
        <small>A photo of the delivery is optional. COMPLETE makes the customer's invoice by itself (₱ ${peso(o.total_amount)}).</small></div>`;
  }
  function bindDelivery(o, boxes, urls, reload) {
    const setPhotos = async (list) => {
      const { data: gone, error } = await sb.rpc("set_order_photos", { p_id: o.id, p_photos: list });
      if (error) { fail(error, "Could not save the photos"); return false; }
      if (gone?.length) sb.storage.from("records").remove(gone).then(() => {}, () => {});
      return true;
    };
    $("#dvPic").onchange = async (e) => {
      const files = Array.from(e.target.files); e.target.value = "";
      if (!files.length) return;
      const room = MAX_PHOTOS - (o.delivery_photos || []).length;
      if (files.length > room) toast(`Up to ${MAX_PHOTOS} photos: only ${room} more can be added.`, true);
      toast("Uploading the photo…");
      const paths = [];
      for (const raw of files.slice(0, room)) {
        const f = await E.slimFile(raw, "photo");
        const path = `corder/${o.id}/delivery_${Date.now()}_${rand()}.${E.extOf(f)}`;
        const up = await sb.storage.from("records").upload(path, f, { contentType: f.type || "image/jpeg" });
        if (up.error) { toast("A photo could not be uploaded: " + up.error.message, true); continue; }
        paths.push(path);
      }
      if (paths.length && !(await setPhotos([...(o.delivery_photos || []), ...paths]))) sb.storage.from("records").remove(paths).then(() => {}, () => {});
      reload();
    };
    $$("[data-rmph]").forEach((b) => (b.onclick = async () => {
      if (!(await E.confirmBox("Remove this photo?", { ok: "Remove", danger: true }))) return;
      if (await setPhotos((o.delivery_photos || []).filter((p) => p !== b.dataset.rmph))) reload();
    }));
    $("#dvDone").onclick = async (e) => {
      const short = nBoxes(boxes) !== num(o.total_boxes);
      const msg = `Complete the delivery of <b>${esc(o.order_no)}</b>?<br><br>The invoice is made and billed to <b>${esc(custName(o))}</b> by itself: <b>₱ ${peso(o.total_amount)}</b>, ${esc(boxesText(o.total_boxes))}, ${qtyText(o.total_pcs)} pcs${o.payment_terms ? `, ${esc(o.payment_terms)}` : ""}.`
        + (short ? `<br><br><b>Note:</b> ${nBoxes(boxes)} box(es) were scanned, the order has ${qtyText(o.total_boxes)}.` : "") + "<br><br>This cannot be undone.";
      if (!(await E.confirmBox(msg, { title: "Complete Delivery", ok: "Complete Delivery" }))) return;
      e.target.disabled = true;
      const { error } = await sb.rpc("complete_customer_order", { p_id: o.id });
      if (error) { e.target.disabled = false; return fail(error, "Could not complete the order"); }
      toast(`Order ${o.order_no} completed. The invoice was made and billed to ${custName(o)}.`); reload();
    };
  }

  // ======================================================================
  // Prints: the CUSTOMER ORDER (with the invoice and the delivery when completed) and the DELIVERY SHEET
  // ======================================================================
  // 3.39: the barcode carries the paper's secret code, and the QR code opens its Complete Delivery page (any phone camera)
  const codesHtml = (o, extra = "") => {
    const bar = `<img src="${E.pdf417DataUrl("EMONCO|" + o.order_no + (o.delivery_code ? "|" + o.delivery_code : ""))}" alt="" class="ph-bar"><div class="mono">${esc(o.order_no)}</div>${extra}`;
    return o.delivery_code ? `<div class="ph-codes co-codes"><div>${bar}</div><div class="co-qr"><img src="${E.qrDataUrl(deliveryUrl(o.order_no, o.delivery_code))}" alt="QR code: verification" class="ph-qr"><small class="co-verify">VERIFICATION</small></div></div>` : bar;
  };
  function orderPages(o, inv) {
    const c = o.customers || {}, cols = o.extra_columns || [];
    const sign = o.approved_by ? E.approvedBy(o.approved_by, o.approved_by_name, o.approved_at) : null;
    const done = o.status === "completed";
    const bottom = `<p class="pdecl">${esc(E.words(o.total_amount))} · ${esc(boxesText(o.total_boxes))} · ${qtyText(o.total_pcs)} PCS</p>
      ${done && inv ? E.box("Invoice", `<div class="pgrid2">${E.cell("Invoice No", inv.invoice_no)}${E.cell("Invoice Date", mdy(inv.invoice_date))}${E.cell("Terms of Payment", inv.payment_terms || "")}${E.cell("Due Date", mdy(inv.due_date))}
        ${E.cell("Amount (₱)", peso(inv.total_amount), "hl")}${E.cell("Status", inv.pay_status === "paid" ? "PAID" : inv.pay_status === "partial" ? "PARTIAL PAYMENT" : "UNPAID")}</div>`) : ""}
      ${o.status === "cancelled" ? `<p class="po-warn"><b>CANCELLED</b>${o.cancel_note ? ` — ${esc(o.cancel_note)}` : ""}</p>` : ""}
      <div class="psig one"><div></div>${E.sigCol("Authorized Signature", sign)}</div>`; // 3.39: only the Director's approval signature
    const extraBoxes = done && inv ? 1 : 0;
    return E.pagedDoc({
      head: E.printHead("CUSTOMER ORDER", codesHtml(o, `<div class="co-bigbox">${esc(boxesText(o.total_boxes))}</div>`)), contHead: E.printHead(`CUSTOMER ORDER ${o.order_no} (CONTINUED)`, ""),
      // 3.39: no address on the order (the customer's account says where it goes)
      top: stLine(o) + E.box("Order", `<div class="pgrid2">${E.cell("Customer", fullName(c))}${E.cell("Account No", c.account_no || "")}${E.cell("Order No", o.order_no)}${E.cell("Batch No", o.reference || "")}
        ${E.cell("Date", mdy(o.order_date))}${E.cell("Due Date", mdy(dueOf(o)))}${E.cell("Terms of Payment", o.payment_terms || "")}${E.cell("Note", o.note || "")}</div>`),
      boxTitle: "Order Lines (₱)", thead: `<tr><th class="num">Boxes</th><th class="num">Pcs</th><th>Code</th><th>Lot No.</th><th>Product</th>${cols.map((x) => `<th>${esc(x)}</th>`).join("")}<th class="num">Price</th><th class="num">Amount</th></tr>`,
      rows: o.lines || [], rowHtml: (l) => `<tr><td class="num">${l.boxes ? qtyText(l.boxes) : ""}</td><td class="num">${qtyText(l.qty)}</td><td>${esc(l.code || "")}</td><td>${esc(l.lot || "")}</td><td>${esc(l.product)}</td>
        ${cols.map((x) => `<td>${esc(l.extra?.[x] || "")}</td>`).join("")}<td class="num">${peso(l.price)}</td><td class="num">${peso(l.amount)}</td></tr>`,
      totalRow: `<tr class="ptl-tot"><td class="num">${qtyText(o.total_boxes)}</td><td class="num">${qtyText(o.total_pcs)}</td><td colspan="${3 + cols.length}">TOTAL · ${esc(boxesText(o.total_boxes))} · ${qtyText(o.total_pcs)} PCS</td><td></td><td class="num">${peso(o.total_amount)}</td></tr>`,
      bottom, caps: { single: extraBoxes === 2 ? 6 : extraBoxes ? 9 : 13, first: 18, next: 26, last: extraBoxes === 2 ? 8 : extraBoxes ? 11 : 15 } });
  }
  function sheetPages(o, boxes) {
    const c = o.customers || {}, pcs = boxes.reduce((s, b) => s + num(b.pcs), 0);
    const rows = boxes.length >= 24 ? boxes : [...boxes, ...Array(24 - boxes.length).fill(null)]; // empty lines to write by hand, like the paper sheet
    const line = (k, v) => `<div class="cs-f"><small>${esc(k)}</small><b>${v ? esc(v) : "&nbsp;"}</b></div>`;
    return E.pagedDoc({
      head: E.printHead("DELIVERY SHEET", codesHtml(o)), contHead: E.printHead(`DELIVERY SHEET ${o.order_no} (CONTINUED)`, ""),
      top: E.box("Customer", `<div class="pgrid2">${E.cell("Customer", fullName(c))}${E.cell("Account No", c.account_no || "")}${E.cell("Order No", o.order_no)}${E.cell("Batch No", o.reference || "")}</div>`),
      boxTitle: "Boxes", thead: `<tr><th>#</th><th>Serial No.</th><th>Code</th><th>Batch No.</th><th>Items</th><th>Brand</th><th>CTN</th><th class="num">Pcs</th><th>Remarks</th></tr>`,
      rows, rowHtml: (b, i) => b ? `<tr><td>${i + 1}</td><td class="mono">${b.serial_no ? esc(b.serial_no) : "-"}</td><td>${esc(b.code || "")}</td><td>${esc(b.batch_no || "")}</td><td>${esc(b.items || "")}</td><td>${esc(b.brand || "")}</td><td>${esc(b.ctn || "")}</td><td class="num">${qtyText(b.pcs)}</td><td>${esc(b.remarks || "")}</td></tr>`
        : `<tr class="cs-empty"><td>${i + 1}</td>${"<td></td>".repeat(8)}</tr>`,
      // 3.39: no boxes scanned yet: the total is written by hand with the lines; one TOTAL BOXES below (the order's)
      totalRow: boxes.length ? `<tr class="ptl-tot"><td colspan="7">TOTAL · ${esc(boxesText(nBoxes(boxes)))}</td><td class="num">${qtyText(pcs)}</td><td></td></tr>` : `<tr class="ptl-tot"><td colspan="7">TOTAL</td><td></td><td></td></tr>`,
      bottom: `<div class="cs-foot">${line("Assign By", o.created_by_name || "")}${line("Total Boxes", String(o.total_boxes))}${line("Notes", o.delivery_note || o.note || "")}${line("Date", o.delivered_at ? mdy(o.delivered_at) : "")}${line("Time", o.delivered_at ? new Date(o.delivered_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "")}
        ${line("Order No", o.order_no)}<div class="cs-f cs-w2"><small>Verified By</small><b>&nbsp;</b></div></div>`,
      caps: { single: 24, first: 28, next: 34, last: 22 } });
  }

  // 3.41: the order's status, under the title of a print
  const ST_PRINT = { pending: "CREATE ORDER (WAITING FOR APPROVAL)", approved: "PREPARED", completed: "COMPLETED", cancelled: "CANCELLED" };
  const stLine = (o) => `<p class="co-stline">STATUS: <b>${esc(ST_PRINT[o.status] || String(o.status || "").toUpperCase())}</b></p>`;
  // 3.41 Download All Details: everything of the order in one PDF, on as few pages as it takes (1 page for a small order):
  // the order and its lines, every box (no empty lines), the invoice, the delivery, the photos and the approval signature
  function allPages(o, inv, boxes, urls) {
    const c = o.customers || {}, cols = o.extra_columns || [], done = o.status === "completed";
    const sign = o.approved_by ? E.approvedBy(o.approved_by, o.approved_by_name, o.approved_at) : null;
    const pics = (o.delivery_photos || []).map((x) => urls.get(x)).filter(Boolean);
    const lines = o.lines || [];
    const top = `${stLine(o)}${E.box("Order", `<div class="pgrid2">${E.cell("Customer", fullName(c))}${E.cell("Account No", c.account_no || "")}${E.cell("Order No", o.order_no)}${E.cell("Batch No", o.reference || "")}
        ${E.cell("Date", mdy(o.order_date))}${E.cell("Due Date", mdy(dueOf(o)))}${E.cell("Terms of Payment", o.payment_terms || "")}${E.cell("Note", o.note || "")}</div>`)}
      ${E.box("Order Lines (₱)", `<table class="ptl ad-t"><thead><tr><th class="num">Boxes</th><th class="num">Pcs</th><th>Code</th><th>Lot No.</th><th>Product</th>${cols.map((x) => `<th>${esc(x)}</th>`).join("")}<th class="num">Price</th><th class="num">Amount</th></tr></thead><tbody>
        ${lines.map((l) => `<tr><td class="num">${l.boxes ? qtyText(l.boxes) : ""}</td><td class="num">${qtyText(l.qty)}</td><td>${esc(l.code || "")}</td><td>${esc(l.lot || "")}</td><td>${esc(l.product)}</td>${cols.map((x) => `<td>${esc(l.extra?.[x] || "")}</td>`).join("")}<td class="num">${peso(l.price)}</td><td class="num">${peso(l.amount)}</td></tr>`).join("")}
        <tr class="ptl-tot"><td class="num">${qtyText(o.total_boxes)}</td><td class="num">${qtyText(o.total_pcs)}</td><td colspan="${4 + cols.length}">TOTAL · ${esc(E.words(o.total_amount))}</td><td class="num">${peso(o.total_amount)}</td></tr></tbody></table>`)}`;
    const bottom = `${done && inv ? E.box("Invoice", `<div class="prow3">${E.cell("Invoice No", inv.invoice_no)}${E.cell("Invoice Date", mdy(inv.invoice_date))}${E.cell("Due Date", mdy(inv.due_date))}</div>
        <div class="prow3">${E.cell("Amount (₱)", peso(inv.total_amount))}${E.cell("Terms of Payment", inv.payment_terms || "")}${E.cell("Status", inv.pay_status === "paid" ? "PAID" : inv.pay_status === "partial" ? "PARTIAL PAYMENT" : "UNPAID")}</div>`) : ""}
      ${o.delivered_at ? E.box(done ? "Done Delivery" : "Delivery", `<div class="prow3">${E.cell("Date and Time", E.dateTime(o.delivered_at))}${E.cell(done ? "Completed By" : "Submitted By", o.completed_by_name || o.delivery_request_by || "")}${E.cell("Note", o.delivery_note || "")}</div>`) : ""}
      ${pics.length ? E.box("Delivery Photos", `<div class="ad-pics">${pics.map((u) => `<img src="${esc(u)}" alt="Delivery photo">`).join("")}</div>`) : ""}
      ${o.status === "cancelled" ? `<p class="po-warn"><b>CANCELLED</b>${o.cancel_note ? ` — ${esc(o.cancel_note)}` : ""}</p>` : ""}
      <div class="psig one"><div></div>${E.sigCol("Authorized Signature", sign)}</div>`;
    // how many box lines go on a page: what the order, its lines and the end take is left out
    const used = 9 + lines.length + (done && inv ? 4 : 0) + (o.delivered_at ? 3 : 0) + (pics.length ? 7 : 0);
    const rows = boxes.length ? boxes : [null];
    return E.pagedDoc({
      head: E.printHead("CUSTOMER ORDER — ALL DETAILS", codesHtml(o, `<div class="co-bigbox">${esc(boxesText(o.total_boxes))}</div>`)), contHead: E.printHead(`CUSTOMER ORDER ${o.order_no} — ALL DETAILS (CONTINUED)`, ""),
      top, boxTitle: `Boxes (${nBoxes(boxes)} of ${qtyText(o.total_boxes)})`,
      thead: `<tr><th>#</th><th>Serial No.</th><th>Code</th><th>Batch No.</th><th>Items</th><th>Brand</th><th>CTN</th><th class="num">Pcs</th></tr>`,
      rows, rowHtml: (b, i) => b ? `<tr class="ad-r"><td>${i + 1}</td><td class="mono">${b.serial_no ? esc(b.serial_no) : "-"}</td><td>${esc(b.code || "")}</td><td>${esc(b.batch_no || "")}</td><td>${esc(b.items || "")}</td><td>${esc(b.brand || "")}</td><td>${esc(b.ctn || "")}</td><td class="num">${qtyText(b.pcs)}</td></tr>`
        : `<tr class="ad-r"><td colspan="8">No boxes yet.</td></tr>`,
      totalRow: boxes.length ? `<tr class="ptl-tot"><td colspan="7">TOTAL · ${esc(boxesText(nBoxes(boxes)))}</td><td class="num">${qtyText(boxes.reduce((t, b) => t + num(b.pcs), 0))}</td></tr>` : "",
      bottom, caps: { single: Math.max(4, 40 - used), first: Math.max(8, 46 - 9 - lines.length), next: 52, last: Math.max(6, 50 - used + 9 + lines.length) } });
  }

  // ======================================================================
  // 3.39 COMPLETE DELIVERY by the order paper: #delivery/<order no>/<secret code> (the barcode or the QR code of the printed
  // order). Whoever holds the paper — signed in or not — does the delivery in 3 steps: 1 the boxes (scanned one after another,
  // read from a label photo, or typed), 2 the photos of the delivery, 3 COMPLETE DELIVERY (the invoice is made by itself).
  // 3.45: no rider or car details; not signed in with EO-Office, COMPLETE DELIVERY is SUBMITTED and the Director approves it. No prices.
  // ======================================================================
  // what a scanned order paper opens: its barcode (EMONCO|OR-…|code) or its QR code (…#delivery/OR-…/code); "" for anything else
  const deliveryHashOf = (text) => {
    const t = String(text || "").trim();
    const u = /#(delivery\/[^/\s]+\/[0-9a-f]{6,40})\b/i.exec(t);
    if (u) return u[1];
    const m = /^EMONCO\|((?:CO|OR)-\d{6}-\d+)\|([0-9a-f]{6,40})$/i.exec(t);
    return m ? deliveryHash(m[1].toUpperCase(), m[2].toLowerCase()) : "";
  };
  V.delivery = async (no, code) => {
    const inside = !!(S.session && S.profile?.status === "active");
    const body = `<div id="pdBody">${busy("Opening the order")}</div>`;
    if (inside) E.shell("delivery", "Complete Delivery", body); else E.miniShell("Complete Delivery", body, { home: "#verify" });
    const here = E.stillHere();
    const args = { p_no: String(no || "").toUpperCase(), p_code: String(code || "").toLowerCase() };
    const { data: d, error } = await sb.rpc("delivery_order", args);
    if (!here() || !$("#pdBody")) return;
    if (error) { $("#pdBody").innerHTML = `<div class="empty">${notSet(error) ? "The Complete Delivery page needs the database update <b>048_delivery_paper.sql</b>." : esc(error.message)}</div>`; return; }
    const photos = d.delivery_photos || [];
    const urls = photos.length && d.status === "approved" ? await E.signedMap(photos).catch(() => new Map()) : new Map();
    if (!here() || !$("#pdBody")) return;
    paintDelivery(d, args, urls, inside);
  };
  function paintDelivery(d, args, urls, inside) {
    const boxes = d.boxes || [], photos = d.delivery_photos || [], lines = d.lines || [], pcs = boxes.reduce((s, b) => s + num(b.pcs), 0);
    const reload = () => V.delivery(args.p_no, args.p_code);
    const rpc = (fn, extra = {}) => sb.rpc(fn, { ...args, ...extra });
    const orderLink = inside && E.canOpen("custorder") ? `<a class="btn" href="#custorder/${d.id}">${ic("doc")} Open the Order</a>` : "";
    const head = `<section class="cust-hero co-hero pd-head">
      <div class="ch-pic"><div class="ch-photo co-ic">${ic("box")}</div></div>
      <div class="ch-main"><div class="ch-name"><h2>${esc(d.order_no)}</h2>${stPill(d)}</div>
        <div class="ch-sub"><b>${esc(d.customer)}</b>${d.account_no ? ` · <span class="mono">${esc(d.account_no)}</span>` : ""}${d.address ? ` · ${esc(d.address)}` : ""}</div>
        <div class="ch-ids">${E.idBox("Batch No", d.reference || "")}${E.idBox("Boxes", `${nBoxes(boxes)} of ${qtyText(d.total_boxes)}`)}${E.idBox("Pcs", `${qtyText(pcs)} of ${qtyText(d.total_pcs)}`)}</div></div>
    </section>`;
    if (d.status !== "approved") { // completed, waiting or cancelled: what was done; nothing to change
      $("#pdBody").innerHTML = `${head}<div class="banner ${d.status === "completed" ? "ok" : d.status === "cancelled" ? "closed" : "warn"}">${d.status === "completed" ? "✔ COMPLETED — " : ""}${esc(d.state)}</div>
        ${d.status === "completed" ? `<div class="pgrid2 qc-head">${E.cell("Date and Time", d.delivered_at ? E.dateTime(d.delivered_at) : "")}${E.cell("Completed By", d.completed_by_name || "")}${E.cell("Boxes", String(nBoxes(boxes)))}${E.cell("Photos", String(photos.length))}</div>` : ""}
        <div class="btnrow">${orderLink}</div>`;
      return;
    }
    if (d.request_at && !d.can_complete) { // 3.45: submitted: the Director approves it
      $("#pdBody").innerHTML = `${head}<div class="banner warn">${ic("clock")} DELIVERY SUBMITTED — ${esc(E.dateTime(d.request_at))}. It waits for the Director's approval: approved, the order is COMPLETED.</div>
        <div class="pgrid2 qc-head">${E.cell("Submitted By", d.request_by || "")}${E.cell("Boxes", `${nBoxes(boxes)} of ${qtyText(d.total_boxes)}`)}${E.cell("Pcs", `${qtyText(pcs)} of ${qtyText(d.total_pcs)}`)}${E.cell("Photos", String(photos.length))}</div>
        <div class="btnrow">${orderLink}</div>`;
      return;
    }
    const submitOnly = d.can_complete === false; // not signed in with EO-Office: the Director approves the delivery
    const tick = (on, label) => `<li class="${on ? "ok" : ""}">${on ? "✔" : "○"} ${esc(label)}</li>`;
    $("#pdBody").innerHTML = `${head}
      <div class="banner">${ic("box")} PREPARED — ready for delivery. Do the steps below.</div>
      <section class="pd-step"><h3><span class="pd-n">1</span> Boxes <small>${nBoxes(boxes)} of ${qtyText(d.total_boxes)} boxes · ${qtyText(pcs)} of ${qtyText(d.total_pcs)} pcs</small></h3>
        ${boxCheck(lines, boxes)}
        <div class="btnrow"><button type="button" class="btn primary" id="pdScan">${ic("scan")} Scan Boxes</button><label class="btn" for="pdLabel">${ic("image")} Box Label Photo</label><input type="file" id="pdLabel" accept="image/*" multiple hidden>
          <button type="button" class="btn" id="pdType">📦 Add Box</button></div>
        <div class="box-find"><input type="text" id="pdFind" maxlength="60" placeholder="Serial no, e.g. U20261238" aria-label="Find a box by its serial no" autocomplete="off"><button type="button" class="btn primary" id="pdFindGo">${ic("search")} Find &amp; Add</button></div>
        <div id="pdFound" class="box-found" aria-live="polite">${foundHtml(d.id)}</div>
        ${E.grid({ cols: [{ label: "#", get: (b) => boxNo(boxes, b) }, { label: "Serial No", html: serHtml }, { label: "Code", get: (b) => b.code || "" },
          { label: "Items", get: (b) => b.items || "" }, { label: "Brand", get: (b) => b.brand || "" }, { label: "Pcs", num: true, get: (b) => qtyText(b.pcs) },
          { label: "", html: (b) => `<button type="button" class="btn small danger" data-pdx="${b.id}" aria-label="Remove ${esc(b.serial_no || b.items || "line")}">×</button>` }], rows: boxes, empty: "No boxes yet: scan the QR or PDF417 code on each box label." })}
      </section>
      <section class="pd-step"><h3><span class="pd-n">2</span> Delivery Photos</h3>
        <h4 class="co-h4">Photos: the proof of delivery (optional, up to ${MAX_PHOTOS})</h4>
        <div class="po-photos co-photos">${photos.map((x, i) => `<div class="po-pic"><button type="button" class="co-ph" data-ph="${esc(urls.get(x) || "")}" aria-label="Open photo ${i + 1}"><img src="${esc(urls.get(x) || "")}" alt="Delivery photo"></button><button type="button" data-pdrm="${esc(x)}" aria-label="Remove photo">×</button></div>`).join("")}</div>
        <div class="btnrow"><label class="btn" for="pdPic" ${photos.length >= MAX_PHOTOS ? "hidden" : ""}>${ic("camera")} Add Photo</label><input type="file" id="pdPic" accept="image/*" multiple hidden></div>
      </section>
      <section class="pd-step"><h3><span class="pd-n">3</span> Complete Delivery</h3>
        <ul class="pd-check">${tick(nBoxes(boxes) > 0, `Boxes: ${nBoxes(boxes)} of ${qtyText(d.total_boxes)}`)}${tick(photos.length > 0, photos.length ? `Photos: ${photos.length}` : "A photo of the delivery (optional)")}</ul>
        <div class="co-done"><button type="button" class="btn ok big" id="pdDone">${ic("check")} ${submitOnly ? "Submit Delivery for Approval" : "Complete Delivery"}</button><small>${submitOnly
          ? "You are not signed in with EO-Office: the delivery is SUBMITTED and the Director approves it. Approved, the order is COMPLETED and the invoice is made."
          : "The order becomes COMPLETED and the customer's invoice is made and billed by itself."}</small></div>
      </section>
      <div class="btnrow">${orderLink}</div>`;
    // step 1: the boxes (what a label does not say comes from the order's line of that code, or the box before)
    let added = 0;
    const fill = (x) => {
      if (!x.serial_no) return x; // 3.46: a line without a serial no keeps only what was typed
      const one = lines.length === 1 ? lines[0] : null, last = boxes[boxes.length - 1];
      const line = one || (x.code && lines.find((l) => String(l.code || "").toUpperCase() === String(x.code).toUpperCase()));
      return { ...x, code: x.code || one?.code || last?.code || "", batch_no: x.batch_no || line?.lot || last?.batch_no || "", items: x.items || line?.product || last?.items || "", pcs: x.pcs || line?.pcs || last?.pcs || "" };
    };
    const add = async (x, how) => {
      const b = fill(x);
      if (!b.serial_no && how !== "typed") return "✖ No serial no in that code.";
      const { data, error } = await rpc("delivery_add_box", { p_data: { ...b, added_how: how } });
      if (error) return /on this order already/i.test(error.message || "") ? `✔ Box ${b.serial_no} is on this order (checked)` : `✖ ${error.message}`;
      boxes.push(data); added++;
      if (!data.serial_no) return `✔ Added${boxSays(data)} — no serial no: not counted as a box`;
      return `✔ Box ${data.serial_no} added${boxSays(data)} · ${nBoxes(boxes)} of ${qtyText(d.total_boxes)} boxes`;
    };
    const found = (raw, how) => addFound(raw, how, add, rpc, boxes);
    bindFind("pd", d.id, (v) => found(v, "typed"), reload);
    $("#pdScan").onclick = () => E.scanDialog((text) => found(readLabel(text).serial_no, "scan"), {
      title: `Scan Boxes — ${d.order_no}`, hint: "Point the camera at the code of each box label (QR, PDF417 or barcode). Each box found in the box database is added at once: scan the next one. Press Close when done.", keep: true,
      onClose: () => { if (added) { toast(`${added} box(es) added.`); reload(); } } });
    $("#pdLabel").onchange = async (e) => {
      const files = Array.from(e.target.files); e.target.value = "";
      if (!files.length) return;
      const notes = [];
      for (const f of files) {
        try { notes.push(await found(readLabel(await E.decodeImageFile(f)).serial_no, "photo")); }
        catch (err) { notes.push(`✖ ${f.name}: ${err.message}`); }
      }
      const bad = notes.filter((n) => n.startsWith("✖"));
      if (bad.length) toast(bad.map((n) => n.slice(2)).join(" "), true); else toast(`${added} box(es) added.`);
      if (added) reload();
    };
    $("#pdType").onclick = () => boxForm({ lines }, null, async (x) => { const r = await add(x, "typed"); if (r.startsWith("✖")) { toast(r.slice(2), true); return false; } toast(r.slice(2)); reload(); return true; });
    $$("[data-pdx]").forEach((b) => (b.onclick = async () => {
      const x = boxes.find((y) => y.id === b.dataset.pdx);
      if (!(await E.confirmBox(`Remove ${boxName(x)} from this order?`, { ok: "Remove", danger: true }))) return;
      b.disabled = true;
      const { error } = await rpc("delivery_remove_box", { p_box: x.id });
      if (error) { b.disabled = false; return fail(error, "Could not remove the box"); }
      toast("Box removed."); reload();
    }));
    // step 2: the photos
    const setPhotos = async (list) => {
      const { data: gone, error } = await rpc("delivery_photos", { p_photos: list });
      if (error) { fail(error, "Could not save the photos"); return false; }
      if (gone?.length) sb.storage.from("records").remove(gone).then(() => {}, () => {});
      return true;
    };
    $("#pdPic").onchange = async (e) => {
      const files = Array.from(e.target.files); e.target.value = "";
      if (!files.length) return;
      const room = MAX_PHOTOS - photos.length;
      if (files.length > room) toast(`Up to ${MAX_PHOTOS} photos: only ${room} more can be added.`, true);
      toast("Uploading the photo…");
      const paths = [];
      for (const raw of files.slice(0, room)) {
        const f = await E.slimFile(raw, "photo");
        const path = `corder/${d.id}/delivery_${Date.now()}_${rand()}.${E.extOf(f)}`;
        const up = await sb.storage.from("records").upload(path, f, { contentType: f.type || "image/jpeg" });
        if (up.error) { toast("A photo could not be uploaded: " + up.error.message, true); continue; }
        paths.push(path);
      }
      if (paths.length && !(await setPhotos([...photos, ...paths]))) sb.storage.from("records").remove(paths).then(() => {}, () => {});
      reload();
    };
    $$("[data-pdrm]").forEach((b) => (b.onclick = async () => {
      if (!(await E.confirmBox("Remove this photo?", { ok: "Remove", danger: true }))) return;
      if (await setPhotos(photos.filter((x) => x !== b.dataset.pdrm))) reload();
    }));
    // step 3: COMPLETE DELIVERY
    $("#pdDone").onclick = async (e) => {
      const short = nBoxes(boxes) !== num(d.total_boxes);
      const msg = `Complete the delivery of <b>${esc(d.order_no)}</b> for <b>${esc(d.customer)}</b>?`
        + (short ? `<br><br><b>Note:</b> ${nBoxes(boxes)} box(es) were scanned, the order has ${qtyText(d.total_boxes)}.` : "")
        + (submitOnly ? "<br><br>The delivery is SUBMITTED and waits for the Director's approval." : "<br><br>The order becomes COMPLETED and the invoice is made. This cannot be undone.");
      const title = submitOnly ? "Submit Delivery" : "Complete Delivery";
      if (!(await E.confirmBox(msg, { title, ok: title }))) return;
      e.target.disabled = true;
      const { data: res, error } = await rpc("delivery_complete");
      if (error) { e.target.disabled = false; return fail(error, "Could not complete the delivery"); }
      if (res === "submitted") { toast(`Order ${d.order_no}: delivery SUBMITTED. The Director approves it. Thank you!`); reload(); return; }
      toast(`Order ${d.order_no}: COMPLETED. Thank you!`);
      if (inside && E.canOpen("custorder")) location.hash = "custorder/" + d.id; else reload();
    };
    $$("[data-ph]").forEach((b) => (b.onclick = () => E.lightbox(b.dataset.ph)));
  }

  // A customer's orders (on the customer's profile)
  async function ordersOf(custId) {
    const { data, error } = await sb.from("customer_orders").select("id, order_no, order_date, status, total_boxes, total_amount").eq("customer_id", custId).order("created_at", { ascending: false }).limit(200);
    return error ? null : data || [];
  }
  function ordersHtml(rows, custId) {
    return `${canW() ? `<div class="btnrow"><a class="btn primary" href="#newcustorder/${custId}">${ic("plus")} New Customer Order</a></div>` : ""}
      ${E.grid({ cols: [{ label: "Order No", get: (o) => o.order_no }, { label: "Date", get: (o) => mdy(o.order_date) }, { label: "Boxes", num: true, get: (o) => qtyText(o.total_boxes) },
        { label: "Amount (₱)", num: true, get: (o) => peso(o.total_amount) }, { label: "Status", html: stPill }], rows, onRow: true, empty: "No customer orders yet." })}`;
  }

  Object.assign(E, { customerOrdersOf: ordersOf, customerOrdersHtml: ordersHtml, readBoxLabel: readLabel, deliveryHashOf });
})();
