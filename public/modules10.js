/* EMON OVERRUNS E-PORTAL — Customer Order (3.37), in EO-Office.
   An order for a customer, like the paper order: DELIVERED TO, ADDRESS, ACCOUNT NO, REFERENCES, DATE, DUE DATE, TERMS, NOTE and the
   lines QUANTITY | BOXES | CODE | PCS | LOT NO. | PRODUCT | PRICE | AMOUNT (QUANTITY = BOXES × PCS, AMOUNT = QUANTITY × PRICE), with up
   to 4 columns of its own (COLOR, SIZE …). The page of the order holds its boxes (the Delivery Sheet): each box is scanned from the QR
   or PDF417 code on its label (one after another, the camera stays open), read from a photo of the label, or typed. The Director
   approves (the authorized signature on the printed order; the Director's own orders are approved at once). The delivery: the rider,
   ID no, plate no, type, date and time, and photos; COMPLETE makes the customer's invoice by itself, and the printed order shows it. */
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
  const VEHICLES = ["MOTORCYCLE", "TRICYCLE", "CAR", "VAN", "TRUCK", "OTHER"];
  // the status of an order: its pill and words
  const STATUS = { pending: ["pending", "WAITING FOR APPROVAL"], approved: ["approved", "APPROVED"], completed: ["applied", "COMPLETED"], cancelled: ["rejected", "CANCELLED"] };
  const stPill = (o) => pill(...(STATUS[o.status] || ["pending", String(o.status).toUpperCase()]));
  const open = (o) => ["pending", "approved"].includes(o.status);
  const boxesText = (n) => `${qtyText(n)} BOX${num(n) === 1 ? "" : "ES"}`;
  // the due date: as written, or from the terms (30 DAYS after the order date …)
  const dueOf = (o) => o.due_date || E.termsDue(o.order_date, o.payment_terms) || "";
  const custName = (o) => fullName(o.customers || {});

  // ======================================================================
  // The list (EO-Office › Customer Order)
  // ======================================================================
  const TABS = [["open", "Open"], ["pending", "Waiting"], ["completed", "Completed"], ["cancelled", "Cancelled"], ["all", "All"]];
  V.custorders = async (tab) => {
    E.shell("custorders", "Customer Order", `${E.eoTabs("custorders")}<div id="coBody">${busy()}</div>`);
    if (!E.hasModule("eooffice") || !E.isStaff()) { location.hash = "eooffice"; return; }
    const here = E.stillHere();
    const { data, error } = await E.allRows(() => sb.from("customer_orders").select("id, order_no, order_date, status, total_boxes, total_pcs, total_amount, reference, created_by_name, customers(first_name, last_name, account_no)")
      .order("created_at", { ascending: false }).order("id"));
    if (!here() || !$("#coBody")) return;
    if (error) { $("#coBody").innerHTML = notSet(error) ? needUpdate : `<div class="empty">${esc(error.message)}</div>`; return; }
    const rows = data || [], count = (st) => rows.filter((o) => st.includes(o.status)).length;
    const m = isoToday().slice(0, 7), doneM = rows.filter((o) => o.status === "completed" && String(o.order_date).slice(0, 7) === m);
    let t = TABS.some((x) => x[0] === tab) ? tab : "open";
    $("#coBody").innerHTML = `
      <div class="tiles co-tiles">
        <div class="tile ${count(["pending"]) ? "warn" : ""}"><span class="tile-ic">${ic("clock")}</span><div class="k">Waiting for Approval</div><div class="v">${count(["pending"])}</div></div>
        <div class="tile"><span class="tile-ic">${ic("box")}</span><div class="k">Approved · To Deliver</div><div class="v">${count(["approved"])}</div></div>
        <div class="tile ok"><span class="tile-ic">${ic("check")}</span><div class="k">Delivered This Month (₱)</div><div class="v">${peso(doneM.reduce((s, o) => s + num(o.total_amount), 0))}</div><small>${doneM.length} order(s)</small></div>
      </div>
      <div class="btnrow">${canW() ? `<a class="btn primary" href="#newcustorder">${ic("plus")} New Customer Order</a>` : ""}<button type="button" class="btn" id="coScan">${ic("scan")} Scan</button></div>
      <div class="tabs" id="coTabs">${TABS.map(([k, l]) => `<button type="button" data-t="${k}" class="${k === t ? "on" : ""}">${l}</button>`).join("")}</div>
      <input type="search" id="coFind" class="co-find" placeholder="Search: order no, customer, account no, reference" aria-label="Search orders" autocomplete="off">
      <div id="coGrid"></div>`;
    const hay = rows.map((o) => [o.order_no, custName(o), o.customers?.account_no, o.reference].join(" ").toLowerCase());
    const cols = [{ label: "Order No", get: (o) => o.order_no }, { label: "Date", get: (o) => mdy(o.order_date) }, { label: "Customer", html: (o) => `<b>${esc(custName(o))}</b><br><small class="mono">${esc(o.customers?.account_no || "")}</small>` },
      { label: "Boxes", num: true, get: (o) => qtyText(o.total_boxes) }, { label: "Pcs", num: true, get: (o) => qtyText(o.total_pcs) }, { label: "Amount (₱)", num: true, get: (o) => peso(o.total_amount) },
      { label: "Status", html: stPill }];
    const paint = () => {
      const w = $("#coFind").value.trim().toLowerCase();
      const shown = rows.filter((o, i) => (t === "all" || (t === "open" ? open(o) : o.status === t)) && (!w || hay[i].includes(w)));
      $("#coGrid").innerHTML = E.grid({ cols, rows: shown, onRow: true, empty: w ? "No order matches that." : "No orders here." });
      E.bindGrid($("#coGrid"), shown, (o) => (location.hash = "custorder/" + o.id));
    };
    $$("#coTabs button").forEach((b) => (b.onclick = () => { t = b.dataset.t; $$("#coTabs button").forEach((x) => x.classList.toggle("on", x === b)); paint(); }));
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
  const canEdit = (o) => canW() && (isAdmin() ? open(o) : o.status === "pending" && o.created_by === meId());

  function orderForm(o, preset) {
    const terms0 = o?.payment_terms || "";
    const known = !terms0 || E.TERMS.includes(terms0);
    E.shell(o ? "editcustorder" : "newcustorder", o ? `Edit ${o.order_no}` : "New Customer Order", `
      <form class="window" id="coForm" novalidate><div class="wtitle">${o ? `Customer Order ${esc(o.order_no)}` : "Customer Order"}</div><div class="wbody">
        <fieldset class="opt"><legend>Customer (ACTIVE accounts only)</legend><div id="coCust"></div></fieldset>
        <fieldset class="opt"><legend>Order</legend><div class="formgrid">
          <div class="fields wide">
            <label for="coDate">Date</label><input type="date" id="coDate" value="${esc(o?.order_date || isoToday())}">
            <label for="coRef">References (Lot No)</label><input type="text" id="coRef" maxlength="60" value="${esc(o?.reference || "")}" placeholder="e.g. SS-05">
            <label for="coTerms">Terms of Payment</label><select id="coTerms"><option value="">— Choose the terms —</option>${E.TERMS.map((x) => `<option ${x === terms0 ? "selected" : ""}>${x}</option>`).join("")}<option value="OTHER" ${known ? "" : "selected"}>OTHER (type the terms)</option></select>
            <label for="coTermsX" class="cotx" ${known ? "hidden" : ""}>Other Terms</label><input type="text" id="coTermsX" class="cotx" maxlength="60" value="${known ? "" : esc(terms0)}" ${known ? "hidden" : ""}>
            <label for="coDue">Due Date</label><input type="date" id="coDue" value="${esc(o?.due_date || "")}">
          </div>
          <div class="fields wide">
            <label for="coTo">Delivered To</label><input type="text" id="coTo" maxlength="120" value="${esc(o?.delivered_to || "")}" placeholder="The customer's name when empty">
            <label for="coAddr">Address</label><input type="text" id="coAddr" maxlength="300" value="${esc(o?.address || "")}" placeholder="The customer's address when empty">
            <label for="coNote">Note</label><input type="text" id="coNote" maxlength="500" value="${esc(o?.note || "")}">
            <span>Order No</span><small>${o ? `<b class="mono">${esc(o.order_no)}</b>` : "Given by the system when you save (CO-YYYYMM-####)."}</small>
          </div></div></fieldset>
        <fieldset class="opt"><legend>Order Lines</legend><div id="coLines"></div></fieldset>
      </div><div class="wfoot"><button type="button" class="btn" id="coCancel">Cancel</button><button type="submit" class="btn primary">${o ? "Save" : isAdmin() ? "Save Order" : "Save and Send to the Director"}</button></div></form>`,
      isAdmin() ? "" : "The order goes to the Director to approve. After the approval the Director's signature is on the printed order, and the delivery can start.");
    let cust = preset && preset.status === "active" ? preset : null;
    const fillFrom = (c) => {
      if (!$("#coTo").value.trim()) $("#coTo").placeholder = fullName(c);
      if (!$("#coAddr").value.trim()) $("#coAddr").placeholder = c.address || "";
    };
    E.customerPicker($("#coCust"), { statuses: ["active"], onPick: (c) => { cust = c; fillFrom(c); }, preset: cust || undefined });
    if (preset && !cust) toast(`${fullName(preset)}'s account is ${String(preset.status).toUpperCase()}: an order is made only for an ACTIVE account.`, true);
    const ed = linesEditor($("#coLines"), o?.lines || [], o?.extra_columns || []);
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
      const { data: row, error } = await sb.rpc("save_customer_order", { p_id: o?.id || null, p_data: { customer_id: cust.id, order_date: $("#coDate").value || null, due_date: $("#coDue").value || null,
        reference: $("#coRef").value, payment_terms: terms(), delivered_to: $("#coTo").value, address: $("#coAddr").value, note: $("#coNote").value, extra_columns: cols, lines } });
      if (error) { E.setBusy(e.target, false); return fail(error, notSet(error) ? "Run the database update RUN_041_TO_046.sql first" : "Could not save the order"); }
      toast(o ? "Saved." : row.status === "approved" ? `Order ${row.order_no} saved and approved.` : `Order ${row.order_no} saved and sent to the Director.`);
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
      box.innerHTML = `<div class="grid-wrap co-wrap"><table class="grid co-lines edit"><thead><tr><th>#</th><th class="num">Quantity</th><th class="num">Boxes</th><th>Code</th><th class="num">Pcs</th><th>Lot No.</th><th>Product *</th>
          ${cols.map((c, i) => `<th>${esc(c)} <button type="button" class="co-xcol" data-xc="${i}" aria-label="Remove the column ${esc(c)}" title="Remove the column">×</button></th>`).join("")}<th class="num">Price (₱)</th><th class="num">Amount (₱)</th><th></th></tr></thead>
        <tbody>${(ls.length ? ls : [{}]).map(lineRow).join("")}</tbody>
        <tfoot><tr><td></td><td class="num co-tq">0</td><td class="num co-tb">0</td><td colspan="${4 + cols.length}"><b>TOTAL AMOUNT</b></td><td></td><td class="num co-ta">0.00</td><td></td></tr></tfoot></table></div>
        <div class="btnrow"><button type="button" class="btn small co-add">${ic("plus")} Add Line</button><button type="button" class="btn small co-addc">${ic("plus")} Add Column</button>
          <small class="muted">Quantity = boxes × pcs. Up to ${MAX_LINES} lines and ${MAX_COLS} added columns (for example COLOR or SIZE).</small></div>
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
    return { read: () => ({ lines: all().filter((l) => !blank(l)), cols }) };
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
  // id: the order's id, or its number (CO-202610-0001: from an invoice or a scanned order)
  V.custorder = async (id) => {
    E.shell("custorder", "Customer Order", busy());
    const here = E.stillHere(), no = /^CO-\d{6}-\d+$/i.test(id || "") ? id.toUpperCase() : null;
    const boxesOf = (oid) => sb.from("customer_order_boxes").select("*").eq("order_id", oid).order("created_at").order("id");
    const [{ data: o, error }, bx0] = await Promise.all([
      sb.from("customer_orders").select("*, customers(*)").eq(no ? "order_no" : "id", no || id).maybeSingle(), no ? null : boxesOf(id)]);
    if (!here()) return;
    if (error && notSet(error)) { $("#main").innerHTML = needUpdate; return; }
    if (!o) { $("#main").innerHTML = `<div class="empty">Order not found. <a href="#custorders">All orders</a></div>`; return; }
    const bx = bx0 || (await boxesOf(o.id));
    const [inv, urls] = await Promise.all([
      o.invoice_id ? sb.from("invoice_balances").select("*").eq("id", o.invoice_id).maybeSingle().then((r) => r.data, () => null) : null,
      o.delivery_photos?.length ? E.signedMap(o.delivery_photos) : new Map()]);
    if (!here()) return;
    draw(o, bx.data || [], inv, urls);
  };

  function draw(o, boxes, inv, urls) {
    const c = o.customers || {}, cols = o.extra_columns || [], w = canW();
    const sumPcs = boxes.reduce((s, b) => s + num(b.pcs), 0);
    $(".band h1") && ($(".band h1").textContent = `Customer Order — ${o.order_no}`);
    const banner = o.status === "pending" ? `<div class="banner warn">${ic("clock")} Waiting for the Director's approval. After the approval the Director's signature is on the printed order and the delivery can start.</div>`
      : o.status === "cancelled" ? `<div class="banner closed">CANCELLED${o.cancelled_by_name ? ` by ${esc(o.cancelled_by_name)}` : ""}${o.cancelled_at ? ` on ${esc(mdy(o.cancelled_at))}` : ""}${o.cancel_note ? ` — ${esc(o.cancel_note)}` : ""}</div>`
      : o.status === "completed" ? `<div class="banner ok">✔ DELIVERED and COMPLETED${o.completed_at ? ` on ${esc(mdy(o.completed_at))}` : ""}${o.completed_by_name ? ` by ${esc(o.completed_by_name)}` : ""}${inv ? ` — invoice <b>${esc(inv.invoice_no)}</b> was made for the customer` : ""}</div>` : "";
    $("#main").innerHTML = `<div class="window"><div class="wtitle">${esc(o.order_no)} · ₱ ${peso(o.total_amount)} <span class="co-st">${stPill(o)}</span></div><div class="wbody">
      ${banner}
      ${isAdmin() && o.status === "pending" ? `<fieldset class="opt review"><legend>Director's Decision</legend><div class="btnrow"><button type="button" class="btn ok" id="coApprove">${ic("check")} Approve Order</button><button type="button" class="btn danger" id="coCancelO">Cancel Order</button></div></fieldset>` : ""}
      <div class="pgrid2 qc-head">${E.cell("Order No", o.order_no)}${E.cell("Date", mdy(o.order_date))}
        <div class="pcell"><div class="pl">Customer</div><div class="pv">${E.canOpen("customer") ? `<a href="#customer/${c.id}"><b>${esc(fullName(c))}</b></a>` : `<b>${esc(fullName(c))}</b>`}</div></div>${E.cell("Account No", c.account_no || "")}
        ${E.cell("Delivered To", o.delivered_to || fullName(c))}${E.cell("Address", o.address || c.address || "")}${E.cell("References", o.reference || "")}${E.cell("Terms of Payment", o.payment_terms || "")}
        ${E.cell("Due Date", mdy(dueOf(o)))}${E.cell("Total", `${boxesText(o.total_boxes)} · ${qtyText(o.total_pcs)} PCS`, "hl")}${E.cell("Made By", o.created_by_name || "")}${E.cell("Approved By", o.approved_by_name ? `${o.approved_by_name} · ${mdy(o.approved_at)}` : "")}
        ${o.note ? E.cell("Note", o.note) : ""}</div>
      <h3 class="sec">Order Lines</h3>
      <div class="grid-wrap co-wrap"><table class="grid co-lines"><thead><tr><th>#</th><th class="num">Quantity</th><th class="num">Boxes</th><th>Code</th><th class="num">Pcs</th><th>Lot No.</th><th>Product</th>${cols.map((x) => `<th>${esc(x)}</th>`).join("")}<th class="num">Price (₱)</th><th class="num">Amount (₱)</th></tr></thead>
        <tbody>${(o.lines || []).map((l, i) => `<tr><td>${i + 1}</td><td class="num">${qtyText(l.qty)}</td><td class="num">${l.boxes ? qtyText(l.boxes) : ""}</td><td>${esc(l.code || "")}</td><td class="num">${l.pcs ? qtyText(l.pcs) : ""}</td><td>${esc(l.lot || "")}</td><td>${esc(l.product)}</td>
          ${cols.map((x) => `<td>${esc(l.extra?.[x] || "")}</td>`).join("")}<td class="num">${peso(l.price)}</td><td class="num">${peso(l.amount)}</td></tr>`).join("")}</tbody>
        <tfoot><tr><td></td><td class="num">${qtyText(o.total_pcs)}</td><td class="num">${qtyText(o.total_boxes)}</td><td colspan="${4 + cols.length}"><b>TOTAL AMOUNT</b></td><td></td><td class="num"><b>${peso(o.total_amount)}</b></td></tr></tfoot></table></div>
      <p class="muted">${esc(E.words(o.total_amount))}</p>
      <fieldset class="opt" id="coBoxes"><legend>Boxes · Delivery Sheet</legend>${boxesHtml(o, boxes, sumPcs, w)}</fieldset>
      ${o.status === "approved" || o.status === "completed" ? `<fieldset class="opt" id="coDel"><legend>Delivery</legend>${deliveryHtml(o, urls, w)}</fieldset>` : ""}
      ${o.status === "completed" ? `<fieldset class="opt"><legend>Invoice</legend>${inv ? `<div class="pgrid2 qc-head">
          <div class="pcell"><div class="pl">Invoice No</div><div class="pv">${E.canOpen("invoice") ? `<a href="#invoice/${inv.id}"><b>${esc(inv.invoice_no)}</b></a>` : `<b>${esc(inv.invoice_no)}</b>`}</div></div>
          ${E.cell("Invoice Date", mdy(inv.invoice_date))}${E.cell("Terms of Payment", inv.payment_terms || "")}${E.cell("Due Date", mdy(inv.due_date))}${E.cell("Amount (₱)", peso(inv.total_amount), "hl")}${E.cell("Balance (₱)", peso(inv.balance))}
          <div class="pcell"><div class="pl">Status</div><div class="pv">${payPill(inv)}</div></div></div>` : `<div class="empty small">The invoice is on the customer's account.</div>`}</fieldset>` : ""}
    </div><div class="wfoot"><button type="button" class="btn primary" id="coPdf">${ic("print")} Print Order</button><button type="button" class="btn" id="coSheet">${ic("print")} Delivery Sheet</button>
      ${canEdit(o) ? `<a class="btn" href="#editcustorder/${o.id}">${ic("edit")} Edit</a>` : ""}
      ${(isAdmin() ? o.status === "approved" : o.status === "pending" && o.created_by === meId()) ? `<button type="button" class="btn danger" id="coCancelO">Cancel Order</button>` : ""}
      ${isAdmin() && o.status !== "completed" ? `<button type="button" class="btn danger" id="coDelO">${ic("trash")} Delete</button>` : ""}
      <a class="btn" href="${E.hasModule("eooffice") && E.isStaff() ? "#custorders" : "#customer/" + c.id}">Close</a></div></div>`;
    const reload = () => V.custorder(o.id);
    if ($("#coApprove")) $("#coApprove").onclick = async (e) => {
      if (!(await E.confirmBox(`Approve order <b>${esc(o.order_no)}</b> for <b>${esc(fullName(c))}</b> (₱ ${peso(o.total_amount)}, ${esc(boxesText(o.total_boxes))})? Your signature goes on the printed order.`, { ok: "Approve Order" }))) return;
      e.target.disabled = true;
      const { error } = await sb.rpc("decide_customer_order", { p_id: o.id, p_action: "approve", p_note: null });
      if (error) { e.target.disabled = false; return fail(error, "Could not approve"); }
      toast(`Order ${o.order_no} approved.`); reload();
    };
    if ($("#coCancelO")) $("#coCancelO").onclick = () => cancelOrder(o, reload);
    if ($("#coDelO")) $("#coDelO").onclick = async () => {
      if (!(await E.confirmBox(`Delete order <b>${esc(o.order_no)}</b> and its ${boxes.length} box(es)? This cannot be undone.`, { ok: "Delete", danger: true }))) return;
      const { data: gone, error } = await sb.rpc("delete_customer_order", { p_id: o.id });
      if (error) return fail(error, "Could not delete");
      if (gone?.length) sb.storage.from("records").remove(gone).then(() => {}, () => {});
      toast("Deleted."); location.hash = "custorders";
    };
    $("#coPdf").onclick = async () => { await E.loadSignatures().catch(() => {}); E.openPreview(`Customer Order ${o.order_no}`, orderPages(o, inv)); };
    $("#coSheet").onclick = () => E.openPreview(`Delivery Sheet ${o.order_no}`, sheetPages(o, boxes));
    bindBoxes(o, boxes, reload);
    if (o.status === "approved" && w) bindDelivery(o, boxes, urls, reload);
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
  function boxesHtml(o, boxes, sumPcs, w) {
    const codes = new Map();
    (o.lines || []).forEach((l) => { const k = l.code || "—"; codes.set(k, (codes.get(k) || 0) + num(l.boxes)); });
    const got = new Map();
    boxes.forEach((b) => { const k = b.code || "—"; got.set(k, (got.get(k) || 0) + 1); });
    const chips = [...new Set([...codes.keys(), ...got.keys()])].filter((k) => codes.get(k) || got.get(k))
      .map((k) => { const n = got.get(k) || 0, want = codes.get(k) || 0; return `<span class="co-chip ${want && n === want ? "ok" : n > want ? "over" : ""}">Code ${esc(k)}: <b>${n}</b>${want ? ` / ${want}` : ""}</span>`; }).join("");
    return `<div class="co-count"><b>${boxes.length}</b> of ${qtyText(o.total_boxes)} boxes · <b>${qtyText(sumPcs)}</b> of ${qtyText(o.total_pcs)} pcs ${chips}</div>
      ${w && open(o) ? `<div class="btnrow"><button type="button" class="btn primary" id="cbScan">${ic("scan")} Scan Boxes</button><label class="btn" for="cbPhoto">${ic("image")} Box Label Photo</label><input type="file" id="cbPhoto" accept="image/*" multiple hidden>
        <button type="button" class="btn" id="cbType">${ic("edit")} Type a Box</button></div>
        <p class="muted" style="margin:0 0 8px">Scan the QR or PDF417 code on each box label (the camera stays open: one box after another), read it from a photo, or type the serial no (for example L20260667) and the pcs.</p>` : ""}
      ${E.grid({ cols: [{ label: "#", get: (b) => String(boxes.indexOf(b) + 1) }, { label: "Serial No", html: (b) => `<b class="mono">${esc(b.serial_no)}</b>` }, { label: "Code", get: (b) => b.code || "" },
        { label: "Batch No", get: (b) => b.batch_no || "" }, { label: "Items", get: (b) => b.items || "" }, { label: "Pcs", num: true, get: (b) => qtyText(b.pcs) }, { label: "Remarks", get: (b) => b.remarks || "" },
        ...(w && open(o) ? [{ label: "", html: (b) => `<span class="co-bact"><button type="button" class="btn small" data-be="${b.id}" aria-label="Change box ${esc(b.serial_no)}">${ic("edit")}</button><button type="button" class="btn small danger" data-bx="${b.id}" aria-label="Remove box ${esc(b.serial_no)}">×</button></span>` }] : [])],
        rows: boxes, empty: "No boxes yet." })}`;
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
      const one = (o.lines || []).length === 1 ? o.lines[0] : null, last = boxes[boxes.length - 1];
      const line = one || (d.code && (o.lines || []).find((l) => l.code === String(d.code).toUpperCase()));
      return { ...d, code: d.code || one?.code || last?.code || "", batch_no: d.batch_no || line?.lot || last?.batch_no || "", items: d.items || line?.product || last?.items || "",
        pcs: d.pcs || line?.pcs || last?.pcs || "" };
    };
    let added = 0;
    const add = async (d, how) => {
      const box = fill(d);
      if (!box.serial_no) return "✖ No serial no in that code.";
      const { data, error } = await sb.rpc("add_order_box", { p_order: o.id, p_data: { ...box, added_how: how } });
      if (error) return `✖ ${error.message}`;
      boxes.push(data); added++;
      return `✔ Box ${data.serial_no} added${data.pcs ? ` (${qtyText(data.pcs)} pcs)` : ""} · ${boxes.length} of ${qtyText(o.total_boxes)} boxes`;
    };
    $("#cbScan").onclick = () => E.scanDialog((text) => add(readLabel(text), "scan"), {
      title: `Scan Boxes — ${o.order_no}`, hint: "Point the camera at the QR or PDF417 code of each box label. Every box is added at once; press Close when done.", keep: true,
      onClose: () => { if (added) { toast(`${added} box(es) added.`); reload(); } } });
    $("#cbPhoto").onchange = async (e) => {
      const files = Array.from(e.target.files); e.target.value = "";
      if (!files.length) return;
      const notes = [];
      for (const f of files) {
        try { notes.push(await add(readLabel(await E.decodeImageFile(f)), "photo")); }
        catch (err) { notes.push(`✖ ${f.name}: ${err.message}`); }
      }
      const bad = notes.filter((n) => n.startsWith("✖"));
      if (bad.length) toast(bad.join(" "), true); else toast(`${added} box(es) added.`);
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
      if (!(await E.confirmBox(`Remove box <b>${esc(x.serial_no)}</b> from this order?`, { ok: "Remove", danger: true }))) return;
      b.disabled = true;
      const { error } = await sb.rpc("change_order_box", { p_box: x.id, p_data: null });
      if (error) { b.disabled = false; return fail(error, "Could not remove the box"); }
      toast("Box removed."); reload();
    }));
  }
  // Type a box (x null) or change one; save(d) gives true when it is saved.
  function boxForm(o, x, save) {
    const codes = [...new Set((o.lines || []).map((l) => l.code).filter(Boolean))];
    const m = E.modal(x ? `Box ${x.serial_no}` : "Type a Box", `<div class="fields wide">
        <label for="bfSer">Serial No *</label><input type="text" id="bfSer" maxlength="60" value="${esc(x?.serial_no || "")}" ${x ? "readonly" : ""} placeholder="e.g. L20260667">
        <label for="bfCode">Code</label><input type="text" id="bfCode" maxlength="30" list="bfCodes" value="${esc(x?.code || (codes.length === 1 ? codes[0] : ""))}"><datalist id="bfCodes">${codes.map((k) => `<option value="${esc(k)}">`).join("")}</datalist>
        <label for="bfBatch">Batch No</label><input type="text" id="bfBatch" maxlength="40" value="${esc(x?.batch_no || "")}">
        <label for="bfItems">Items</label><input type="text" id="bfItems" maxlength="120" value="${esc(x?.items || "")}">
        <label for="bfPcs">Pcs</label><input type="number" id="bfPcs" min="0" step="1" inputmode="numeric" value="${x ? num(x.pcs) : ""}">
        <label for="bfRem">Remarks</label><input type="text" id="bfRem" maxlength="120" value="${esc(x?.remarks || "")}"></div>`,
      `<button type="button" class="btn" data-x>Cancel</button><button type="button" class="btn primary" data-ok>${x ? "Save" : "Add Box"}</button>`);
    if (!x) {
      // a box typed from the line of its code: the batch no, items and pcs of that line
      $("#bfCode", m.el).onchange = () => { const l = (o.lines || []).find((y) => y.code === $("#bfCode", m.el).value.trim().toUpperCase()); if (!l) return;
        if (!$("#bfBatch", m.el).value) $("#bfBatch", m.el).value = l.lot || ""; if (!$("#bfItems", m.el).value) $("#bfItems", m.el).value = l.product || ""; if (!$("#bfPcs", m.el).value && l.pcs) $("#bfPcs", m.el).value = l.pcs; };
      $("#bfCode", m.el).onchange();
    }
    $("[data-x]", m.el).onclick = m.close;
    $("[data-ok]", m.el).onclick = async (e) => {
      const d = { serial_no: $("#bfSer", m.el).value.trim(), code: $("#bfCode", m.el).value.trim(), batch_no: $("#bfBatch", m.el).value.trim(), items: $("#bfItems", m.el).value.trim(),
        pcs: $("#bfPcs", m.el).value, remarks: $("#bfRem", m.el).value.trim() };
      if (!d.serial_no) return toast("Write the serial no of the box.", true);
      e.target.disabled = true;
      if (await save(d)) m.close(); else e.target.disabled = false;
    };
    $(x ? "#bfPcs" : "#bfSer", m.el).focus();
  }

  // ---------- delivery: the rider, the photos, COMPLETE ----------
  const localDT = (iso) => { const d = iso ? new Date(iso) : new Date(), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
  function deliveryHtml(o, urls, w) {
    const pics = (o.delivery_photos || []).map((p) => ({ p, u: urls.get(p) || "" }));
    const edit = o.status === "approved" && w;
    const photos = `<div class="po-photos co-photos">${pics.map((x, i) => `<div class="po-pic"><button type="button" class="co-ph" data-ph="${esc(x.u)}" aria-label="Open delivery photo ${i + 1}"><img src="${esc(x.u)}" alt="Delivery photo"></button>${edit ? `<button type="button" data-rmph="${esc(x.p)}" aria-label="Remove photo">×</button>` : ""}</div>`).join("")}</div>`;
    if (!edit) return `<div class="pgrid2 qc-head">${E.cell("Rider Name", o.rider_name || "")}${E.cell("ID No", o.rider_id_no || "")}${E.cell("Plate No", o.plate_no || "")}${E.cell("Type", o.vehicle_type || "")}
      ${E.cell("Date and Time", o.delivered_at ? E.dateTime(o.delivered_at) : "")}${E.cell("Note", o.delivery_note || "")}</div>${pics.length ? photos : ""}`;
    return `<div class="fields wide co-del">
        <label for="dvName">Rider Name *</label><input type="text" id="dvName" maxlength="120" value="${esc(o.rider_name || "")}">
        <label for="dvId">ID No</label><input type="text" id="dvId" maxlength="60" value="${esc(o.rider_id_no || "")}">
        <label for="dvPlate">Plate No</label><input type="text" id="dvPlate" maxlength="30" value="${esc(o.plate_no || "")}">
        <label for="dvType">Type</label><select id="dvType"><option value="">—</option>${VEHICLES.map((v) => `<option ${v === o.vehicle_type ? "selected" : ""}>${v}</option>`).join("")}</select>
        <label for="dvAt">Date and Time</label><input type="datetime-local" id="dvAt" value="${esc(localDT(o.delivered_at))}">
        <label for="dvNote">Note</label><input type="text" id="dvNote" maxlength="300" value="${esc(o.delivery_note || "")}"></div>
      <div class="btnrow"><button type="button" class="btn" id="dvSave">${ic("check")} Save Rider Details</button></div>
      <h4 class="co-h4">Check Photos (up to ${MAX_PHOTOS})</h4>${photos}
      <div class="btnrow"><label class="btn" for="dvPic" id="dvPicL" ${pics.length >= MAX_PHOTOS ? "hidden" : ""}>${ic("camera")} Add Photo</label><input type="file" id="dvPic" accept="image/*" multiple hidden></div>
      <div class="co-done"><button type="button" class="btn ok big" id="dvDone">${ic("check")} Complete Delivery</button>
        <small>The rider details and a check photo are needed. COMPLETE makes the customer's invoice by itself (₱ ${peso(o.total_amount)}).</small></div>`;
  }
  function bindDelivery(o, boxes, urls, reload) {
    const data = () => ({ rider_name: $("#dvName").value.trim(), rider_id_no: $("#dvId").value.trim(), plate_no: $("#dvPlate").value.trim(), vehicle_type: $("#dvType").value,
      delivered_at: $("#dvAt").value ? new Date($("#dvAt").value).toISOString() : null, delivery_note: $("#dvNote").value.trim() });
    const saveRider = async () => {
      const d = data();
      if (!d.rider_name) { toast("Write the rider name.", true); return false; }
      const { error } = await sb.rpc("set_order_delivery", { p_id: o.id, p_data: d });
      if (error) { fail(error, "Could not save the rider details"); return false; }
      Object.assign(o, d, { rider_name: d.rider_name.toUpperCase() });
      return true;
    };
    $("#dvSave").onclick = async (e) => { e.target.disabled = true; const ok = await saveRider(); e.target.disabled = false; if (ok) toast("Rider details saved."); };
    // the page is drawn again after a photo is added or taken off: the rider details typed are saved first, so they stay
    const keepRider = async () => { if ($("#dvName")?.value.trim()) await saveRider(); };
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
      await keepRider();
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
      await keepRider();
      if (await setPhotos((o.delivery_photos || []).filter((p) => p !== b.dataset.rmph))) reload();
    }));
    $("#dvDone").onclick = async (e) => {
      if (!(await saveRider())) return;
      if (!(o.delivery_photos || []).length) return toast("Add a check photo first.", true);
      const short = boxes.length !== num(o.total_boxes);
      const msg = `Complete the delivery of <b>${esc(o.order_no)}</b>?<br><br>The invoice is made for <b>${esc(custName(o))}</b> by itself: <b>₱ ${peso(o.total_amount)}</b>, ${esc(boxesText(o.total_boxes))}, ${qtyText(o.total_pcs)} pcs${o.payment_terms ? `, ${esc(o.payment_terms)}` : ""}.`
        + (short ? `<br><br><b>Note:</b> ${boxes.length} box(es) were scanned, the order has ${qtyText(o.total_boxes)}.` : "") + "<br><br>This cannot be undone.";
      if (!(await E.confirmBox(msg, { title: "Complete Delivery", ok: "Complete Delivery" }))) return;
      e.target.disabled = true;
      const { error } = await sb.rpc("complete_customer_order", { p_id: o.id });
      if (error) { e.target.disabled = false; return fail(error, "Could not complete the order"); }
      toast(`Order ${o.order_no} completed. The invoice was made.`); reload();
    };
  }

  // ======================================================================
  // Prints: the CUSTOMER ORDER (with the invoice and the delivery when completed) and the DELIVERY SHEET
  // ======================================================================
  const codesHtml = (o, extra = "") => `<img src="${E.pdf417DataUrl("EMONCO|" + o.order_no)}" alt="" class="ph-bar"><div class="mono">${esc(o.order_no)}</div>${extra}`;
  function orderPages(o, inv) {
    const c = o.customers || {}, cols = o.extra_columns || [];
    const sign = o.approved_by ? E.approvedBy(o.approved_by, o.approved_by_name, o.approved_at) : null;
    const done = o.status === "completed";
    const bottom = `<p class="pdecl">${esc(E.words(o.total_amount))} · ${esc(boxesText(o.total_boxes))} · ${qtyText(o.total_pcs)} PCS</p>
      ${done && inv ? E.box("Invoice", `<div class="pgrid2">${E.cell("Invoice No", inv.invoice_no)}${E.cell("Invoice Date", mdy(inv.invoice_date))}${E.cell("Terms of Payment", inv.payment_terms || "")}${E.cell("Due Date", mdy(inv.due_date))}
        ${E.cell("Amount (₱)", peso(inv.total_amount), "hl")}${E.cell("Status", inv.pay_status === "paid" ? "PAID" : inv.pay_status === "partial" ? "PARTIAL PAYMENT" : "UNPAID")}</div>`) : ""}
      ${o.rider_name ? E.box(done ? "Done Delivery · Delivery By" : "Delivery By", `<div class="pgrid2">${E.cell("Rider Name", o.rider_name)}${E.cell("ID No", o.rider_id_no || "")}${E.cell("Plate No", o.plate_no || "")}${E.cell("Type", o.vehicle_type || "")}
        ${E.cell("Date and Time", o.delivered_at ? E.dateTime(o.delivered_at) : "")}${E.cell("Note", o.delivery_note || "")}</div>`) : ""}
      ${o.status === "cancelled" ? `<p class="po-warn"><b>CANCELLED</b>${o.cancel_note ? ` — ${esc(o.cancel_note)}` : ""}</p>` : ""}
      ${E.sigs("Issued by: " + esc(o.created_by_name || ""), "Authorized Signature", sign)}`;
    const extraBoxes = (done && inv ? 1 : 0) + (o.rider_name ? 1 : 0);
    return E.pagedDoc({
      head: E.printHead("CUSTOMER ORDER", codesHtml(o, `<div class="co-bigbox">${esc(boxesText(o.total_boxes))}</div>`)), contHead: E.printHead(`CUSTOMER ORDER ${o.order_no} (CONTINUED)`, ""),
      top: E.box("Order", `<div class="pgrid2">${E.cell("Delivered To", o.delivered_to || fullName(c))}${E.cell("Account No", c.account_no || "")}${E.cell("Address", o.address || c.address || "")}${E.cell("References", o.reference || "")}
        ${E.cell("Date", mdy(o.order_date))}${E.cell("Due Date", mdy(dueOf(o)))}${E.cell("Terms of Payment", o.payment_terms || "")}${E.cell("Note", o.note || "")}</div>`),
      boxTitle: "Order Lines (₱)", thead: `<tr><th class="num">Quantity</th><th class="num">Boxes</th><th>Code</th><th class="num">Pcs</th><th>Lot No.</th><th>Product</th>${cols.map((x) => `<th>${esc(x)}</th>`).join("")}<th class="num">Price</th><th class="num">Amount</th></tr>`,
      rows: o.lines || [], rowHtml: (l) => `<tr><td class="num">${qtyText(l.qty)}</td><td class="num">${l.boxes ? qtyText(l.boxes) : ""}</td><td>${esc(l.code || "")}</td><td class="num">${l.pcs ? qtyText(l.pcs) : ""}</td><td>${esc(l.lot || "")}</td><td>${esc(l.product)}</td>
        ${cols.map((x) => `<td>${esc(l.extra?.[x] || "")}</td>`).join("")}<td class="num">${peso(l.price)}</td><td class="num">${peso(l.amount)}</td></tr>`,
      totalRow: `<tr class="ptl-tot"><td class="num">${qtyText(o.total_pcs)}</td><td class="num">${qtyText(o.total_boxes)}</td><td colspan="${4 + cols.length}">TOTAL AMOUNT</td><td></td><td class="num">${peso(o.total_amount)}</td></tr>`,
      bottom, caps: { single: extraBoxes === 2 ? 6 : extraBoxes ? 9 : 13, first: 18, next: 26, last: extraBoxes === 2 ? 8 : extraBoxes ? 11 : 15 } });
  }
  function sheetPages(o, boxes) {
    const c = o.customers || {}, pcs = boxes.reduce((s, b) => s + num(b.pcs), 0);
    const rows = boxes.length >= 24 ? boxes : [...boxes, ...Array(24 - boxes.length).fill(null)]; // empty lines to write by hand, like the paper sheet
    const line = (k, v) => `<div class="cs-f"><small>${esc(k)}</small><b>${v ? esc(v) : "&nbsp;"}</b></div>`;
    return E.pagedDoc({
      head: E.printHead("DELIVERY SHEET", codesHtml(o)), contHead: E.printHead(`DELIVERY SHEET ${o.order_no} (CONTINUED)`, ""),
      top: E.box("Delivery To", `<div class="pgrid2">${E.cell("Customer", o.delivered_to || fullName(c))}${E.cell("Account No", c.account_no || "")}${E.cell("Address", o.address || c.address || "")}${E.cell("Order No", o.order_no)}</div>`),
      boxTitle: "Boxes", thead: `<tr><th>#</th><th>Serial No.</th><th>Code</th><th>Batch No.</th><th>Items</th><th class="num">Qty (Pcs)</th><th>Remarks</th></tr>`,
      rows, rowHtml: (b, i) => b ? `<tr><td>${i + 1}</td><td class="mono">${esc(b.serial_no)}</td><td>${esc(b.code || "")}</td><td>${esc(b.batch_no || "")}</td><td>${esc(b.items || "")}</td><td class="num">${qtyText(b.pcs)}</td><td>${esc(b.remarks || "")}</td></tr>`
        : `<tr class="cs-empty"><td>${i + 1}</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>`,
      totalRow: `<tr class="ptl-tot"><td colspan="5">TOTAL · ${esc(boxesText(boxes.length))}</td><td class="num">${qtyText(pcs)}</td><td></td></tr>`,
      bottom: `<div class="cs-foot">${line("Assign By", o.created_by_name || "")}${line("Total Box", String(boxes.length))}${line("Notes", o.delivery_note || o.note || "")}${line("Rider Name", o.rider_name || "")}
        ${line("ID No", o.rider_id_no || "")}${line("Plate No", o.plate_no || "")}${line("Date", o.delivered_at ? mdy(o.delivered_at) : "")}${line("Time", o.delivered_at ? new Date(o.delivered_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "")}
        ${line("Type", o.vehicle_type || "")}${line("Total Boxes", String(o.total_boxes))}${line("Order No", o.order_no)}${line("Verified By", "")}</div>`,
      caps: { single: 24, first: 28, next: 34, last: 22 } });
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

  Object.assign(E, { customerOrdersOf: ordersOf, customerOrdersHtml: ordersHtml, readBoxLabel: readLabel });
})();
