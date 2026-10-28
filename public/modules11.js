/* EMON OVERRUNS E-PORTAL — Gate Pass AI (3.38).
   A small artificial neural network (12 inputs → 8 hidden neurons → 1 output) that learns from the portal's own records — the
   invoices, payments, overdue days, credit memos and returns of every customer, and every gate pass decision — and gives its
   idea when a Gate Pass is asked for: CLEAR or HOLD, how sure it is, and why. The Director decides; every decision is learned.
   It learns from: (1) the Director's decisions on Requests for Clearance (approved = CLEAR, hold = HOLD) and the gate passes
   issued (CLEAR), each read as the customer's record was on that day; (2) the portal's own Gate Pass rule on every customer,
   month by month for the last 12 months and today (open account, no overdue, within the credit limit, or a trusted customer).
   What it learned is saved in its own folder on the server: the private storage bucket "ai", folder gate-pass/ (one file
   for each time it learns; the list of versions in ai_models). Each suggestion and the decision taken go to ai_gate_log. */
(() => {
  "use strict";
  const E = window.EO;
  const { sb, S, esc, peso, isoToday, isoDay, mdy, $, $$, isAdmin, isStaff, toast, fail, ic, busy, num, fullName } = E;
  const V = window.EO_VIEWS;
  const BUCKET = "ai", FOLDER = "gate-pass";
  const notSet = (e) => ["PGRST205", "PGRST202", "42P01"].includes(e?.code) || /ai_models|ai_gate_log|schema cache|Bucket not found/i.test(e?.message || "");
  const needUpdate = `<div class="empty">The Gate Pass AI needs the database update <b>RUN_041_TO_046.sql</b>. Run it in the Supabase SQL Editor.</div>`;
  // the 12 inputs: [key, what it means]; each is scaled to 0 … 1
  const FEATURES = [["age", "Business with us"], ["invoices", "Invoices"], ["overdue", "Overdue invoices"], ["overdueShare", "Overdue part of all invoiced"],
    ["oldest", "Oldest overdue"], ["balance", "Balance against the credit limit"], ["lastPay", "Days since the last payment"], ["onTime", "Invoices paid on time"],
    ["daysToPay", "Average days to pay"], ["returns", "Returns"], ["recent", "Months with invoices (last 6)"], ["active", "Account open"]];
  // a customer at their best and at their worst (to find what pushes the idea to CLEAR or to HOLD)
  const GOOD = [1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 1], BAD = [0, 0, 1, 1, 1, 1, 1, 0, 1, 1, 0, 0];
  const clamp01 = (v) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  const days = (a, b) => Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 864e5);
  const dayOf = (ts) => (ts ? isoDay(new Date(ts)) : null);
  // how sure, in %: never shown as 100% (it only gives an idea)
  const surePct = (v) => Math.min(99, Math.round(v * 100));

  // ======================================================================
  // The record of a customer as it was on day t, and the 12 inputs made from it
  // recs: { invs: [{ invoice_date, invoice_no, total_amount, payment_terms }], pays: [{ paid_date, amount }], memos: [credit memos] }
  // ======================================================================
  function recordAt(c, recs, t, status = c.status) {
    const invs = (recs.invs || []).filter((i) => String(i.invoice_date) <= t)
      .sort((a, b) => String(a.invoice_date).localeCompare(String(b.invoice_date)) || String(a.invoice_no || "").localeCompare(String(b.invoice_no || "")));
    // the money in, in its order: payments, and approved credit memos, discounts and returns
    const money = [
      ...(recs.pays || []).filter((p) => String(p.paid_date) <= t).map((p) => ({ d: String(p.paid_date), amt: num(p.amount), pay: true })),
      ...(recs.memos || []).filter((m) => ["approved", "paid"].includes(m.status) && m.approved_at && dayOf(m.approved_at) <= t
        && (m.is_return || (m.off_balance ?? ["credit", "discount"].includes(m.requested_action)))).map((m) => ({ d: dayOf(m.approved_at), amt: num(m.request_amount), ret: !!m.is_return }))
    ].sort((a, b) => a.d.localeCompare(b.d));
    // the oldest first: the opening balance, then the invoices by date
    const open = { need: Math.max(0, num(c.opening_balance)) };
    const rows = invs.map((i) => ({ i, need: num(i.total_amount), paidOn: null, due: E.termsDue(i.invoice_date, i.payment_terms) || null }));
    const queue = [open, ...rows];
    let k = 0;
    for (const m of money) {
      let left = m.amt;
      while (left > 0.004 && k < queue.length) {
        const q = queue[k], take = Math.min(left, q.need);
        q.need -= take; left -= take;
        if (q.need <= 0.004) { if (q.i) q.paidOn = m.d; k++; }
      }
    }
    const invoiced = invs.reduce((s, i) => s + num(i.total_amount), 0);
    const moneyIn = money.reduce((s, m) => s + m.amt, 0);
    const bal = Math.max(0, num(c.opening_balance)) + invoiced - moneyIn;
    const over = rows.filter((r) => r.need > 0.004 && r.due && r.due < t);
    const paid = rows.filter((r) => r.paidOn);
    const onTime = paid.filter((r) => !r.due || r.paidOn <= r.due).length;
    const avgDays = paid.length ? Math.round(paid.reduce((s, r) => s + Math.max(0, days(r.i.invoice_date, r.paidOn)), 0) / paid.length) : null;
    const pays = money.filter((m) => m.pay), lastPay = pays.length ? pays[pays.length - 1].d : null;
    const since = [c.application_date, invs[0]?.invoice_date].filter(Boolean).sort()[0] || t;
    const months = Math.max(0, Math.floor(days(since, t) / 30.4));
    const recent = new Set(invs.filter((i) => days(i.invoice_date, t) <= 183).map((i) => String(i.invoice_date).slice(0, 7))).size;
    const limit = c.credit_limit == null ? null : num(c.credit_limit);
    return { t, status, months, nInv: invs.length, invoiced, bal, limit, nOver: over.length, overAmt: over.reduce((s, r) => s + r.need, 0),
      oldest: over.reduce((m, r) => Math.max(m, days(r.due, t)), 0), paidN: paid.length, onTime, avgDays, lastPay, sinceLast: lastPay ? days(lastPay, t) : null,
      returned: money.filter((m) => m.ret).reduce((s, m) => s + m.amt, 0), recent, avgInv: invs.length ? invoiced / invs.length : 0 };
  }
  function inputs(r) {
    const vsLimit = r.limit != null ? (r.limit > 0 ? r.bal / r.limit : r.bal > 0.004 ? 3 : 0) : r.bal / Math.max(r.avgInv, 1);
    return [clamp01(Math.log1p(r.months) / Math.log1p(60)), clamp01(Math.log1p(r.nInv) / Math.log1p(100)), clamp01(r.nOver / 10), clamp01(r.overAmt / Math.max(r.invoiced, 1)),
      clamp01(r.oldest / 180), clamp01(vsLimit / 3), r.sinceLast == null ? (r.nInv ? 1 : 0) : clamp01(r.sinceLast / 365), r.paidN ? r.onTime / r.paidN : 0.5,
      r.paidN ? clamp01(r.avgDays / 120) : 0.5, clamp01(r.returned / Math.max(r.invoiced, 1)), r.recent / 6, r.status === "active" ? 1 : 0];
  }
  // The portal's own Gate Pass rule (the same as the Gate Pass check): an open account, nothing overdue and within the
  // credit limit — or a trusted customer (6 months with us, invoices in 3 of the last 6 months, 5 paid, paid in the last 45
  // days, nothing overdue for more than 30 days, balance not above 150% of the limit).
  function ruleClear(r) {
    if (r.status !== "active") return false;
    const ok = !r.nOver && (r.limit == null || r.bal <= r.limit + 0.004);
    const trusted = r.months >= 6 && r.recent >= 3 && r.paidN >= 5 && r.sinceLast != null && r.sinceLast <= 45 && r.oldest <= 30 && (r.limit == null || r.bal <= r.limit * 1.5 + 0.004);
    return ok || trusted;
  }

  // ======================================================================
  // The neural network: 12 inputs → 8 hidden neurons (tanh) → 1 output (sigmoid) = how likely CLEAR is.
  // Learns with Adam on the whole set at once, with weights for each record (the Director's decisions count more) and the two
  // answers balanced; the start is the same every time (a fixed seed), so the same records give the same network.
  // ======================================================================
  const HIDDEN = 8;
  function seeded(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
  function forward(m, x) {
    const z = m.mean.map((mu, j) => (x[j] - mu) / m.std[j]);
    const h = m.W1.map((row, i) => Math.tanh(row.reduce((s, w, j) => s + w * z[j], m.b1[i])));
    const s = h.reduce((t, v, i) => t + v * m.W2[i], m.b2);
    return { z, h, s, p: sigmoid(s) };
  }
  const predict = (m, x) => forward(m, x).p;
  // the score before the sigmoid (how strongly it leans to CLEAR): it still moves when the network is very sure
  const score = (m, x) => forward(m, x).s;
  async function train(X, y, w, { epochs = X.length > 2000 ? 400 : 900, lr = 0.02, l2 = 2e-3, seed = 20261028, onEpoch } = {}) {
    const n = X.length, d = X[0].length, rnd = seeded(seed);
    const mean = Array.from({ length: d }, (_, j) => X.reduce((s, x) => s + x[j], 0) / n);
    const std = mean.map((mu, j) => Math.sqrt(X.reduce((s, x) => s + (x[j] - mu) ** 2, 0) / n) || 1);
    const scale = Math.sqrt(1 / d);
    const m = { mean, std, W1: Array.from({ length: HIDDEN }, () => Array.from({ length: d }, () => (rnd() * 2 - 1) * scale * 1.7)), b1: Array(HIDDEN).fill(0),
      W2: Array.from({ length: HIDDEN }, () => (rnd() * 2 - 1) * Math.sqrt(1 / HIDDEN) * 1.7), b2: 0 };
    // the two answers count the same in total
    const pos = y.reduce((s, v, i) => s + (v ? w[i] : 0), 0), neg = y.reduce((s, v, i) => s + (v ? 0 : w[i]), 0);
    const cw = w.map((v, i) => v * (y[i] ? (pos ? (pos + neg) / (2 * pos) : 1) : (neg ? (pos + neg) / (2 * neg) : 1)));
    const W = cw.reduce((s, v) => s + v, 0) || 1;
    const Z = X.map((x) => x.map((v, j) => (v - mean[j]) / std[j]));
    const mk = () => ({ W1: m.W1.map((r) => r.map(() => 0)), b1: m.b1.map(() => 0), W2: m.W2.map(() => 0), b2: 0 });
    const M1 = mk(), M2 = mk(), b1 = 0.9, b2 = 0.999, eps = 1e-8;
    let loss = 0;
    for (let ep = 1; ep <= epochs; ep++) {
      const g = mk(); loss = 0;
      for (let k = 0; k < n; k++) {
        const z = Z[k], h = m.W1.map((row, i) => Math.tanh(row.reduce((s, wt, j) => s + wt * z[j], m.b1[i])));
        const p = sigmoid(h.reduce((s, v, i) => s + v * m.W2[i], m.b2));
        loss -= cw[k] * (y[k] ? Math.log(p + 1e-9) : Math.log(1 - p + 1e-9));
        const dz = cw[k] * (p - y[k]);
        for (let i = 0; i < HIDDEN; i++) {
          g.W2[i] += dz * h[i];
          const dh = dz * m.W2[i] * (1 - h[i] * h[i]);
          g.b1[i] += dh;
          for (let j = 0; j < d; j++) g.W1[i][j] += dh * z[j];
        }
        g.b2 += dz;
      }
      // Adam, with a small pull towards 0 on the weights (L2)
      const upd =(val, gr, mo, ve) => { mo = b1 * mo + (1 - b1) * gr; ve = b2 * ve + (1 - b2) * gr * gr; const mh = mo / (1 - b1 ** ep), vh = ve / (1 - b2 ** ep); return [val - (lr * mh) / (Math.sqrt(vh) + eps), mo, ve]; };
      for (let i = 0; i < HIDDEN; i++) {
        for (let j = 0; j < d; j++) { [m.W1[i][j], M1.W1[i][j], M2.W1[i][j]] = upd(m.W1[i][j], g.W1[i][j] / W + l2 * m.W1[i][j], M1.W1[i][j], M2.W1[i][j]); }
        [m.b1[i], M1.b1[i], M2.b1[i]] = upd(m.b1[i], g.b1[i] / W, M1.b1[i], M2.b1[i]);
        [m.W2[i], M1.W2[i], M2.W2[i]] = upd(m.W2[i], g.W2[i] / W + l2 * m.W2[i], M1.W2[i], M2.W2[i]);
      }
      [m.b2, M1.b2, M2.b2] = upd(m.b2, g.b2 / W, M1.b2, M2.b2);
      if (ep % 25 === 0) { if (onEpoch) onEpoch(ep / epochs, loss / W); await new Promise((r) => setTimeout(r, 0)); } // the screen stays free while it learns
    }
    return { ...m, loss: loss / W };
  }

  // ======================================================================
  // Learning: read every customer's records, make the examples, learn, check on the examples it did not learn from, save
  // ======================================================================
  async function loadAll() {
    const rows = (q) => E.allRows(q).then((r) => { if (r.error) throw r.error; return r.data; });
    const [cust, invs, pays, memos, reqs, evs] = await Promise.all([
      rows(() => sb.from("customers").select("id, first_name, last_name, account_no, status, application_date, credit_limit, opening_balance").order("id")),
      rows(() => sb.from("customer_invoices").select("id, customer_id, invoice_no, invoice_date, total_amount, payment_terms").order("id")),
      rows(() => sb.from("payments_received").select("id, customer_id, paid_date, amount").order("id")),
      rows(() => sb.from("credit_memos").select("*").order("id")),
      rows(() => sb.from("order_letters").select("id, customer_id, subject, status, created_at").eq("subject_type", "other").like("subject", "Gate Pass Clearance%").order("id")),
      rows(() => sb.from("customer_events").select("id, customer_id, note, created_at").like("note", "GATE PASS GP-%").order("id"))]);
    const by = (list) => { const g = new Map(); for (const x of list) { if (!g.has(x.customer_id)) g.set(x.customer_id, []); g.get(x.customer_id).push(x); } return g; };
    return { cust, invs: by(invs), pays: by(pays), memos: by(memos), reqs: by(reqs), evs: by(evs) };
  }
  const recsOf = (all, id) => ({ invs: all.invs.get(id) || [], pays: all.pays.get(id) || [], memos: all.memos.get(id) || [] });
  function examples(all) {
    const today = isoToday(), out = [];
    const monthEnds = Array.from({ length: 12 }, (_, k) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - k); d.setDate(0); return isoDay(d); });
    for (const c of all.cust) {
      if (!["active", "suspended", "closed"].includes(c.status)) continue;
      const recs = recsOf(all, c.id), first = [c.application_date, recs.invs.map((i) => i.invoice_date).sort()[0]].filter(Boolean).sort()[0];
      // the rule, today and at each month end since the customer started
      const r0 = recordAt(c, recs, today);
      out.push({ x: inputs(r0), y: ruleClear(r0) ? 1 : 0, w: 1, src: "rule" });
      for (const t of monthEnds) if (first && t >= first) { const r = recordAt(c, recs, t, "active"); out.push({ x: inputs(r), y: ruleClear(r) ? 1 : 0, w: 1, src: "rule" }); }
      // the Director's decisions (and the gate passes issued), as the record was on that day
      for (const o of all.reqs.get(c.id) || []) {
        if (o.status === "pending") continue;
        const r = recordAt(c, recs, dayOf(o.created_at), /account is (SUSPENDED|CLOSED)/i.test(o.subject || "") ? "suspended" : "active");
        out.push({ x: inputs(r), y: o.status === "rejected" ? 0 : 1, w: 4, src: "director" });
      }
      for (const e of all.evs.get(c.id) || []) { const r = recordAt(c, recs, dayOf(e.created_at), "active"); out.push({ x: inputs(r), y: 1, w: 2, src: "issued" }); }
    }
    // a few basic cases it always knows (also on a new server with few records): the best customer CLEAR, the worst HOLD,
    // overdue invoices HOLD, a closed or suspended account HOLD, far over the credit limit HOLD, a new account owing nothing CLEAR
    const base = (change, y) => { const x = GOOD.slice(); for (const [j, v] of Object.entries(change)) x[j] = v; out.push({ x, y, w: 0.5, src: "base" }); };
    base({}, 1); out.push({ x: BAD.slice(), y: 0, w: 0.5, src: "base" });
    base({ 2: 0.3, 3: 0.3, 4: 0.4 }, 0); base({ 11: 0 }, 0); base({ 5: 1 }, 0);
    base({ 0: 0, 1: 0, 6: 0, 7: 0.5, 8: 0.5, 10: 0 }, 1);
    return out;
  }
  async function learn(onStep = () => {}) {
    onStep(0.02, "Reading the customers, invoices, payments, credit memos and gate pass decisions");
    const all = await loadAll();
    let ex = examples(all);
    const rules = ex.filter((e) => e.src === "rule");
    if (rules.length > 4000) { const pick = seeded(11), keep = new Set(rules.filter(() => pick() < 4000 / rules.length)); ex = ex.filter((e) => e.src !== "rule" || keep.has(e)); }
    const real = ex.filter((e) => e.src !== "base").length;
    if (!real) throw new Error("There are no customer records to learn from yet.");
    onStep(0.1, `${real} records read`);
    // a fixed shuffle (the same every time); every 5th record is kept aside to check the network on records it did not learn from
    const rnd = seeded(7), order = ex.map((_, i) => i).filter((i) => ex[i].src !== "base");
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    const test = new Set(order.filter((_, k) => k % 5 === 0));
    const part = (keep) => { const s = ex.filter((_, i) => keep(i)); return [s.map((e) => e.x), s.map((e) => e.y), s.map((e) => e.w)]; };
    const [Xa, ya, wa] = part((i) => !test.has(i));
    const check = await train(Xa, ya, wa, { onEpoch: (f) => onStep(0.1 + f * 0.4, "Learning (checking on records it has not seen)") });
    const tested = [...test].map((i) => ex[i]), right = tested.filter((e) => (predict(check, e.x) >= 0.5 ? 1 : 0) === e.y).length;
    const dTest = tested.filter((e) => e.src === "director"), dRight = dTest.filter((e) => (predict(check, e.x) >= 0.5 ? 1 : 0) === e.y).length;
    const [X, y, w] = part(() => true);
    const m = await train(X, y, w, { onEpoch: (f) => onStep(0.5 + f * 0.45, "Learning from every record") });
    const decisions = ex.filter((e) => e.src === "director").length;
    const model = { kind: "EMON OVERRUNS GATE PASS AI", version: 1, features: FEATURES.map((f) => f[0]), hidden: HIDDEN, mean: m.mean, std: m.std, W1: m.W1, b1: m.b1, W2: m.W2, b2: m.b2,
      trained_at: new Date().toISOString(), trained_by: S.profile?.full_name || "", samples: real, decisions, issued: ex.filter((e) => e.src === "issued").length,
      accuracy: tested.length ? right / tested.length : null, agree: dTest.length ? dRight / dTest.length : null, loss: m.loss };
    onStep(0.96, "Saving what it learned in its folder on the server");
    const stamp = model.trained_at.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
    const path = `${FOLDER}/model-${stamp}.json`;
    const up = await sb.storage.from(BUCKET).upload(path, new Blob([JSON.stringify(model)], { type: "application/json" }), { contentType: "application/json" });
    if (up.error) throw up.error;
    const { data: row, error } = await sb.from("ai_models").insert({ name: FOLDER, path, samples: model.samples, decisions, accuracy: model.accuracy == null ? null : +(model.accuracy * 100).toFixed(2),
      agree: model.agree == null ? null : +(model.agree * 100).toFixed(2), trained_by_name: S.profile?.full_name || null }).select().single();
    if (error) { sb.storage.from(BUCKET).remove([path]).then(() => {}, () => {}); throw error; }
    cache = { row, model };
    onStep(1, "Done");
    return cache;
  }

  // ======================================================================
  // Using what it learned: the newest model from its folder; the idea for one customer and why
  // ======================================================================
  let cache = null; // { row, model } of the newest version
  async function current(force = false) {
    if (cache && !force) return cache;
    const { data: row, error } = await sb.from("ai_models").select("*").eq("name", FOLDER).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    if (!row) return (cache = { row: null, model: null });
    const { data: s, error: e2 } = await sb.storage.from(BUCKET).createSignedUrl(row.path, 120);
    if (e2) throw e2;
    const model = await fetch(s.signedUrl).then((r) => { if (!r.ok) throw new Error("The AI's file could not be read"); return r.json(); });
    return (cache = { row, model });
  }
  // what each input says about this customer, in words
  function said(k, r) {
    const pct = (v) => `${Math.round(v * 100)}%`;
    switch (k) {
      case "age": return `Business with us ${r.months} month${r.months === 1 ? "" : "s"}`;
      case "invoices": return `${r.nInv} invoice${r.nInv === 1 ? "" : "s"} so far`;
      case "overdue": return r.nOver ? `${r.nOver} overdue invoice${r.nOver === 1 ? "" : "s"} (₱ ${peso(r.overAmt)})` : "No overdue invoice";
      case "overdueShare": return r.nOver ? `${pct(r.overAmt / Math.max(r.invoiced, 1))} of all invoiced is overdue` : "No overdue invoice";
      case "oldest": return r.nOver ? `The oldest overdue is ${r.oldest} day${r.oldest === 1 ? "" : "s"} late` : "No overdue invoice";
      case "balance": return r.limit != null ? `Balance ₱ ${peso(r.bal)} is ${r.limit > 0 ? pct(r.bal / r.limit) : "over"} of the credit limit ₱ ${peso(r.limit)}` : `Balance ₱ ${peso(r.bal)} (no credit limit)`;
      case "lastPay": return r.lastPay ? `Last payment ${r.sinceLast} day${r.sinceLast === 1 ? "" : "s"} ago (${mdy(r.lastPay)})` : "No payment yet";
      case "onTime": return r.paidN ? `${pct(r.onTime / r.paidN)} of paid invoices were paid on time (${r.onTime} of ${r.paidN})` : "No invoice paid yet";
      case "daysToPay": return r.paidN ? `Pays in ${r.avgDays} day${r.avgDays === 1 ? "" : "s"} on average` : "No invoice paid yet";
      case "returns": return r.returned > 0 ? `Returns ₱ ${peso(r.returned)} (${pct(r.returned / Math.max(r.invoiced, 1))} of invoiced)` : "No returns";
      case "recent": return `Invoices in ${r.recent} of the last 6 months`;
      case "active": return `The account is ${String(r.status || "").toUpperCase()}`;
      default: return "";
    }
  }
  function idea(model, c, recs) {
    const r = recordAt(c, recs, isoToday()), x = inputs(r), p = predict(model, x), clear = p >= 0.5;
    // why: how much each input moves the score, seen two ways and averaged: this customer with that one input at its best (for
    // HOLD) or worst (for CLEAR), and the best (or worst) customer with this customer's value of that input. On the score, not
    // on how sure it is, so a reason still shows when it is very sure.
    const far = clear ? BAD : GOOD, sign = clear ? -1 : 1, s = score(model, x), sFar = score(model, far);
    const with1 = (base, j, v) => { const a = base.slice(); a[j] = v; return a; };
    const pushes = FEATURES.map(([k], j) => ({ k, effect: sign * (score(model, with1(x, j, far[j])) - s + sFar - score(model, with1(far, j, x[j]))) / 2 }))
      .filter((f) => f.effect > 0).sort((a, b) => b.effect - a.effect);
    const strong = pushes.filter((f) => f.effect > 0.1);
    const reasons = [...new Set((strong.length ? strong : pushes).map((f) => said(f.k, r)))].slice(0, 3);
    return { p, clear, sure: clear ? p : 1 - p, reasons, rule: ruleClear(r), record: r };
  }

  // The AI box in the Gate Pass window: CLEAR or HOLD, how sure, why; the idea is kept to be written with the decision.
  const last = new Map(); // customer id → { row, idea }
  async function box(c, ctx) {
    let cur;
    try { cur = await current(); }
    catch (e) { return notSet(e) ? "" : `<div class="ai-box"><span class="ai-ic">${ic("ai")}</span><div><b>GATE PASS AI</b><small>Could not be read: ${esc(e.message)}</small></div></div>`; }
    if (!cur.model) return `<div class="ai-box"><span class="ai-ic">${ic("ai")}</span><div><b>GATE PASS AI</b><small>It has not learned yet. ${isAdmin() ? `Open <a href="#gateai">Gate Pass AI</a> and press <b>Learn Now</b>.` : "The Director makes it learn on the Gate Pass AI page."}</small></div></div>`;
    const recs = { invs: ctx.invs || [], pays: ctx.pays || [], memos: ctx.memos || [] };
    const d = idea(cur.model, c, recs);
    last.set(c.id, { row: cur.row, idea: d });
    return `<div class="ai-box ${d.clear ? "clear" : "hold"}"><span class="ai-ic">${ic("ai")}</span><div>
      <b>AI SUGGESTS: ${d.clear ? "CLEAR" : "HOLD"}</b> <span class="ai-sure">${surePct(d.sure)}% sure</span>
      ${d.reasons.length ? `<ul>${d.reasons.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
      <small>Learned ${esc(mdy(cur.row.created_at))} from ${cur.row.samples} records and ${cur.row.decisions} Director decision${cur.row.decisions === 1 ? "" : "s"}. The AI only gives an idea; the Director decides.</small></div></div>`;
  }
  // the decision taken on a gate pass, written with the AI's idea (CLEAR: issued or approved; HOLD: on hold)
  async function logDecision(c, decision) {
    const l = last.get(c.id);
    if (!l) return;
    last.delete(c.id);
    await sb.from("ai_gate_log").insert({ customer_id: c.id, model_id: l.row?.id || null, suggestion: l.idea.clear ? "CLEAR" : "HOLD", p_clear: +l.idea.p.toFixed(4),
      reasons: l.idea.reasons.join(" · ").slice(0, 600) || null, decision, decided_by_name: S.profile?.full_name || null }).then(() => {}, () => {});
  }

  // ======================================================================
  // The Gate Pass AI page (the Director): what it learned, Learn Now, every open customer's idea, suggestions and decisions,
  // its folder (the versions)
  // ======================================================================
  V.gateai = async () => {
    if (!isAdmin()) { location.hash = "dashboard"; return; }
    E.shell("gateai", "Gate Pass AI", `<div id="aiBody">${busy()}</div>`);
    const here = E.stillHere();
    const [vers, logs] = await Promise.all([
      sb.from("ai_models").select("*").eq("name", FOLDER).order("created_at", { ascending: false }).limit(50),
      sb.from("ai_gate_log").select("*, customers(first_name, last_name, account_no)").order("created_at", { ascending: false }).limit(100)]);
    if (!here() || !$("#aiBody")) return;
    if (vers.error || logs.error) { const e = vers.error || logs.error; $("#aiBody").innerHTML = notSet(e) ? needUpdate : `<div class="empty">${esc(e.message)}</div>`; return; }
    const v = vers.data || [], lg = logs.data || [], top = v[0];
    const decided = lg.filter((x) => x.decision), agreed = decided.filter((x) => x.decision === x.suggestion).length;
    $("#aiBody").innerHTML = `
      <section class="ai-hero"><span class="ai-ic big">${ic("ai")}</span><div><h2>Gate Pass AI</h2>
        <p>An artificial neural network (12 inputs, 8 neurons, 1 answer) that learns from your own records — invoices, payments, overdue days, credit memos, returns — and from every gate pass decision. When a Gate Pass is asked for, it gives its idea: <b>CLEAR</b> or <b>HOLD</b>, how sure it is, and why. You decide; each decision is learned the next time it learns.</p></div></section>
      <div class="tiles ai-tiles">
        <div class="tile"><span class="tile-ic">${ic("clock")}</span><div class="k">Last Learned</div><div class="v ai-v">${top ? esc(E.dateTime(top.created_at)) : "Not yet"}</div><small>${top ? `by ${esc(top.trained_by_name || "")}` : "Press Learn Now"}</small></div>
        <div class="tile"><span class="tile-ic">${ic("doc")}</span><div class="k">Records Learned From</div><div class="v">${top ? top.samples : 0}</div><small>${top ? `${top.decisions} Director decision${top.decisions === 1 ? "" : "s"}` : ""}</small></div>
        <div class="tile ok"><span class="tile-ic">${ic("check")}</span><div class="k">Right on Records It Had Not Seen</div><div class="v">${top?.accuracy != null ? `${num(top.accuracy).toFixed(0)}%` : "—"}</div><small>${top?.agree != null ? `${num(top.agree).toFixed(0)}% of your decisions` : ""}</small></div>
        <div class="tile"><span class="tile-ic">${ic("shield")}</span><div class="k">Agreed With the Decision</div><div class="v">${decided.length ? `${agreed} / ${decided.length}` : "—"}</div><small>gate passes decided with its idea</small></div>
      </div>
      <div class="btnrow"><button type="button" class="btn primary" id="aiLearn">${ic("ai")} Learn Now</button><span class="muted" id="aiStep"></span></div>
      <div class="ai-prog" id="aiProg" hidden><i></i></div>
      <h3 class="sec">Every Open Customer Today</h3><div id="aiNow">${top ? busy("The AI is reading every customer") : `<div class="empty">The AI has not learned yet. Press <b>Learn Now</b>.</div>`}</div>
      <h3 class="sec">Suggestions and Decisions</h3>
      ${E.grid({ cols: [{ label: "Date / Time", get: (x) => E.dateTime(x.created_at) }, { label: "Customer", html: (x) => `<b>${esc(fullName(x.customers || {}))}</b> <small class="mono">${esc(x.customers?.account_no || "")}</small>` },
        { label: "AI Idea", html: (x) => `${E.pill(x.suggestion === "CLEAR" ? "approved" : "rejected", x.suggestion)} <small>${surePct(x.suggestion === "CLEAR" ? num(x.p_clear) : 1 - num(x.p_clear))}%</small>` },
        { label: "Decision", html: (x) => (x.decision ? E.pill(x.decision === "CLEAR" ? "approved" : "rejected", x.decision) : "") }, { label: "Agreed", get: (x) => (x.decision ? (x.decision === x.suggestion ? "✔" : "✖") : "") },
        { label: "By", get: (x) => x.decided_by_name || "" }], rows: lg, empty: "No gate pass decided with the AI's idea yet." })}
      <h3 class="sec">The AI's Folder on the Server</h3>
      <p class="muted">Bucket <b class="mono">${BUCKET}</b>, folder <b class="mono">${FOLDER}/</b>: one file for each time it learned (the newest is used).</p>
      ${E.grid({ cols: [{ label: "Learned", get: (x) => E.dateTime(x.created_at) }, { label: "File", html: (x) => `<span class="mono">${esc(x.path)}</span>` }, { label: "Records", num: true, get: (x) => String(x.samples) },
        { label: "Director Decisions", num: true, get: (x) => String(x.decisions) }, { label: "Right", num: true, get: (x) => (x.accuracy != null ? `${num(x.accuracy).toFixed(0)}%` : "—") }], rows: v, empty: "Empty: the AI has not learned yet." })}
      ${v.length > 5 ? `<div class="btnrow"><button type="button" class="btn danger" id="aiPrune">${ic("trash")} Delete the Older Files (keep the newest 5)</button></div>` : ""}`;
    $("#aiLearn").onclick = async (e) => {
      e.target.disabled = true; $("#aiProg").hidden = false;
      const show = (f, t) => { if ($("#aiProg i")) $("#aiProg i").style.width = `${Math.round(f * 100)}%`; if ($("#aiStep")) $("#aiStep").textContent = t; };
      try { await new Promise((r) => setTimeout(r, 30)); const r = await learn(show); toast(`The AI learned from ${r.model.samples} records.`); V.gateai(); }
      catch (err) { e.target.disabled = false; $("#aiProg").hidden = true; $("#aiStep").textContent = ""; fail(err, notSet(err) ? "Run the database update RUN_041_TO_046.sql first" : "The AI could not learn"); }
    };
    if ($("#aiPrune")) $("#aiPrune").onclick = async () => {
      const old = v.slice(5);
      if (!(await E.confirmBox(`Delete the ${old.length} older file(s) of the AI? The newest 5 stay.`, { ok: "Delete", danger: true }))) return;
      await sb.storage.from(BUCKET).remove(old.map((x) => x.path)).then(() => {}, () => {});
      const { error } = await sb.from("ai_models").delete().in("id", old.map((x) => x.id));
      if (error) return fail(error, "Could not delete");
      toast("Older files deleted."); V.gateai();
    };
    if (!top) return;
    // every open customer: the AI's idea and the portal's rule, HOLD first
    try {
      const [cur, all] = await Promise.all([current(), loadAll()]);
      if (!here() || !$("#aiNow")) return;
      const list = all.cust.filter((c) => c.status === "active").map((c) => ({ c, d: idea(cur.model, c, recsOf(all, c.id)) })).sort((a, b) => a.d.p - b.d.p);
      $("#aiNow").innerHTML = E.grid({ cols: [{ label: "Customer", html: (x) => `<b>${esc(fullName(x.c))}</b> <small class="mono">${esc(x.c.account_no || "")}</small>` },
        { label: "AI Idea", html: (x) => `${E.pill(x.d.clear ? "approved" : "rejected", x.d.clear ? "CLEAR" : "HOLD")} <small>${surePct(x.d.sure)}%</small>` },
        { label: "Why", get: (x) => x.d.reasons[0] || "" }, { label: "Portal Rule", get: (x) => (x.d.rule ? "CLEAR" : "NOT CLEARED") }], rows: list, onRow: true, empty: "No open customer." });
      E.bindGrid($("#aiNow"), list, (x) => (location.hash = "customer/" + x.c.id));
    } catch (err) { if ($("#aiNow")) $("#aiNow").innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
  };

  E.gateAI = { box, logDecision, learn, current, idea, recordAt, inputs, ruleClear, train, predict };
})();
