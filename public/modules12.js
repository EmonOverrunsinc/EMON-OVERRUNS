/* EMON OVERRUNS E-PORTAL — EVA CHAT and the BOX DATABASE (3.39). For the Director only.
   EVA Chat: ask in simple words ("how much due this customer", "sales this month", "U20261240 what item?", "stock L-13")
   and EVA answers from the records on the server at that moment. It understands the question with a small artificial
   neural network (an intent classifier: the words of the question → 24 neurons → what is asked), trained in the browser on
   example questions; it finds the customer (name or account no), box (serial no), batch, order or invoice named, and the
   time asked about (today, this month, OCTOBER …); "this customer" is the customer of the page open, or the one asked
   about before.
   Box database: the boxes of the Google Sheet DATABASE, columns A to G (serial no, product, brand, CTN, style, qty, batch).
   READ SHEET reads the sheet (shared as "Anyone with the link can view") and replaces the old rows; a CSV file of the sheet
   can be read too. A box scanned on a customer order takes its details from it (on the server). */
(() => {
  "use strict";
  const E = window.EO;
  const { sb, S, esc, peso, isoToday, isoDay, mdy, $, $$, isAdmin, toast, fail, ic, num, fullName, qtyText } = E;

  // ======================================================================
  // Words: the same word written a little wrong ("cureent", "balanse") is read as the word it is close to
  // ======================================================================
  const lev = (a, b) => {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > 2) return 9;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length];
  };
  const norm = (t) => String(t || "").toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9_\s]/g, " ").replace(/\s+/g, " ").trim();
  // what a word means (English, Tagalog and Bangla words the office uses)
  const CONCEPTS = {
    due: "due dues balance balances balanse owe owes owed owing utang baki outstanding receivable receivables payable debt unpaid current",
    pay: "pay paid payment payments pays bayad collect collected collection collections received receive deposit deposits remit joma",
    sale: "sale sales sold sell selling revenue income billing billed turnover benta bikri",
    inv: "invoice invoices inv bill bills",
    order: "order orders delivery deliveries deliver delivered",
    box: "box boxes carton cartons ctn bale bales serial",
    stock: "stock stocks inventory available left warehouse remain remaining",
    late: "overdue late delay delayed lapsed",
    last: "last latest recent newest",
    gate: "gate gatepass pass clearance clear release hold",
    limit: "limit",
    credit: "credit",
    many: "many count number ilan",
    much: "much magkano koto",
    total: "total all sum overall whole entire",
    top: "top most highest biggest largest maximum",
    who: "who which",
    cust: "customer customers client clients account accounts buyer buyers",
    status: "status active suspended closed",
    info: "details detail info information about profile",
    help: "help commands guide options menu",
    greet: "hi hello hey morning afternoon evening salam assalamualaikum kumusta helo",
    thanks: "thanks thank salamat thx ty",
    when: "when kailan kobe date",
    item: "item items product products",
    batch: "batch batches lot lots"
  };
  const CONCEPT_OF = new Map();
  for (const [k, list] of Object.entries(CONCEPTS)) for (const w of list.split(" ")) CONCEPT_OF.set(w, k);
  // words that point to the customer already talked about
  const CTX = new Set(["he", "she", "his", "her", "him", "they", "them", "their", "this", "that", "same"]);

  // ======================================================================
  // What can be asked (the answers are below), with example questions for the network to learn from.
  // {c} a customer, {s} a box serial no, {b} a batch, {o} an order no, {i} an invoice no.
  // ======================================================================
  const EXAMPLES = {
    due: ["how much due {c}", "{c} due", "due of {c}", "how much due this customer", "this customer due how much", "{c} balance", "balance of {c}", "how much {c} owe",
      "how much does {c} owe us", "what is the balance of {c}", "current due {c}", "{c} how much due have", "how much due have this customer", "koto baki {c}", "utang ni {c}",
      "magkano utang ni {c}", "remaining balance {c}", "outstanding of {c}", "amount due {c}", "check due {c}", "due amount", "how much due", "his balance", "her due",
      "their due how much", "current due amount", "{c} current due", "balance", "due", "how much he owe", "show due {c}", "{c} utang", "baki koto"],
    total_due: ["total due", "total due all customers", "how much all customers owe", "total balance", "total outstanding", "all due amount", "how much money to collect",
      "total receivable", "sum of all balance", "total utang", "how much we will collect", "all customer due total", "total due of all", "all balance", "how much market due",
      "overall due"],
    top_due: ["who has most due", "top due customers", "highest balance customer", "which customer owe most", "biggest due", "top 5 balance", "who owes the most",
      "list customers with due", "customers with balance", "who have due", "due list", "top customers due", "most due customer", "which customers have balance"],
    overdue: ["overdue", "overdue customers", "who is late", "late payment customers", "overdue invoices", "who did not pay on time", "{c} overdue", "is {c} late",
      "overdue of {c}", "past due list", "which invoice overdue", "how much overdue", "late invoices", "delay payment list", "total overdue", "who is overdue"],
    last_payment: ["last payment {c}", "when {c} paid", "{c} last paid", "last pay of {c}", "when did {c} pay last", "latest payment {c}", "{c} last bayad",
      "last payment", "when last paid", "last payment received", "when he paid last", "last payment of this customer", "recent payment {c}", "kailan bayad ni {c}"],
    payments: ["collection today", "payments today", "how much received today", "payment this month", "how much collect this month", "total payment this month",
      "collection this week", "{c} payments", "payments of {c}", "how much {c} paid", "{c} total paid", "money received today", "deposits today", "bayad today",
      "collection yesterday", "payments last month", "how much collected", "collection", "total collection", "payment received october"],
    sales: ["sales this month", "sales today", "how much sales this week", "total invoice this month", "invoice total today", "how much sold this month",
      "revenue this month", "billing this month", "total billed today", "sales report", "how much business this month", "benta today", "sales yesterday",
      "sales last month", "total sales", "sales", "how much sale october", "invoiced this year"],
    invoices: ["invoices of {c}", "{c} invoices", "unpaid invoices {c}", "{c} open invoice", "show invoice {i}", "{i}", "invoice {i}", "{i} status", "is {i} paid",
      "how many invoice {c}", "list invoice", "unpaid invoices", "open invoices", "{c} unpaid invoice", "check invoice {i}"],
    orders: ["open orders", "pending orders", "orders waiting approval", "how many orders", "orders today", "{o}", "order {o}", "{o} status", "status of order {o}",
      "{c} orders", "orders of {c}", "delivery today", "prepared orders", "orders to deliver", "what orders are open", "order list", "customer orders",
      "how many order pending", "orders this month", "check order {o}"],
    gate: ["gate pass {c}", "can i clear {c}", "should i give gate pass to {c}", "clear or hold {c}", "{c} gate pass", "is {c} ok for gate pass", "eva idea {c}",
      "release {c}", "can {c} take goods", "hold {c}", "clearance {c}", "can i release goods to {c}", "what eva says about {c}", "gate pass this customer",
      "clear this customer", "should i hold him", "gatepass {c}"],
    limit: ["credit limit {c}", "{c} credit limit", "how much more can {c} take", "limit of {c}", "available credit {c}", "{c} limit", "credit of {c}",
      "max credit {c}", "credit limit", "his credit limit", "how much credit left {c}", "credit available this customer"],
    customer_info: ["{c}", "about {c}", "who is {c}", "{c} details", "show {c}", "{c} profile", "tell me about {c}", "info {c}", "customer {c}", "{c} account",
      "open {c}", "{c} status", "is {c} active", "details of this customer", "account status {c}", "customer details"],
    count_customers: ["how many customers", "total customers", "number of customers", "how many active customers", "how many accounts", "customer count",
      "how many suspended", "how many closed accounts", "count customers", "how many customer we have", "ilan customer"],
    box: ["{s}", "box {s}", "what is {s}", "{s} what item", "item of {s}", "where is box {s}", "{s} details", "check box {s}", "{s} sold", "serial {s}",
      "find box {s}", "{s} qty", "info {s}", "what item in {s}", "{s} brand", "{s} which batch"],
    stock: ["stock {b}", "{b} stock", "how many boxes {b}", "{b} boxes in stock", "how many box left {b}", "stock", "total stock", "how many boxes in stock",
      "stock of this brand", "inventory", "boxes left", "what batch available", "batch list", "{b}", "how many box {b} left", "available boxes", "stock summary",
      "how many boxes", "box stock", "stock by product", "how many pcs in stock", "{b} how many box", "stock report"],
    help: ["help", "what can you do", "how to use", "what can i ask", "commands", "menu", "options", "guide", "how to ask", "what you know"],
    greet: ["hi", "hello", "hey", "good morning", "good afternoon", "good evening", "assalamualaikum", "salam", "kumusta", "hello eva", "hi eva", "eva"],
    thanks: ["thanks", "thank you", "salamat", "ok thanks", "thx", "ty", "great thanks", "good job", "thank you eva"]
  };
  const INTENTS = Object.keys(EXAMPLES);
  const VOCAB = new Set([...CONCEPT_OF.keys()]);
  for (const list of Object.values(EXAMPLES)) for (const ex of list) for (const w of norm(ex.replace(/\{\w\}/g, " ")).split(" ")) if (w) VOCAB.add(w);
  ["today", "yesterday", "week", "month", "year", "ngayon", "kahapon", "aj", "kal", "january", "february", "march", "april", "may", "june", "july", "august",
    "september", "october", "november", "december", "days"].forEach((w) => VOCAB.add(w));
  const fixWord = (w) => {
    if (VOCAB.has(w) || w.length < 4 || /\d/.test(w)) return w;
    let best = w, bd = w.length >= 7 ? 2 : 1;
    for (const v of VOCAB) { if (Math.abs(v.length - w.length) > bd) continue; const d = lev(w, v); if (d < bd || (d === bd && best === w)) { best = v; bd = d; } }
    return best;
  };

  // ======================================================================
  // The network: the question's words, their meanings, pairs of words and what was found in it (a customer, a box, …),
  // hashed into 1024 inputs → 24 neurons (tanh) → one output for each kind of question (softmax). Learns with Adam; the
  // start is the same every time (a fixed seed).
  // ======================================================================
  const D = 1024, H = 24;
  const hashOf = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) % D; };
  function featuresOf(words, flags) {
    const f = new Set(["bias"]);
    words.forEach((w, i) => { f.add("w:" + w); const c = CONCEPT_OF.get(w); if (c) f.add("c:" + c); if (i + 1 < words.length) f.add("b:" + w + "_" + words[i + 1]); });
    for (const k of flags) f.add("e:" + k);
    return [...new Set([...f].map(hashOf))];
  }
  function seeded(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  let NET = null;
  function forwardNet(m, idx) {
    const h = new Float32Array(H);
    for (let j = 0; j < H; j++) { let s = m.b1[j]; for (const i of idx) s += m.W1[i * H + j]; h[j] = Math.tanh(s); }
    const K = m.K, z = new Float32Array(K);
    let mx = -1e9;
    for (let k = 0; k < K; k++) { let s = m.b2[k]; for (let j = 0; j < H; j++) s += h[j] * m.W2[j * K + k]; z[k] = s; if (s > mx) mx = s; }
    let t = 0; for (let k = 0; k < K; k++) { z[k] = Math.exp(z[k] - mx); t += z[k]; }
    for (let k = 0; k < K; k++) z[k] /= t;
    return { h, p: z };
  }
  function trainNet() {
    const data = [];
    for (const [intent, list] of Object.entries(EXAMPLES)) for (const ex of list) { const q = readQuestion(ex, null, true); data.push({ x: featuresOf(q.words, q.flags), y: INTENTS.indexOf(intent) }); }
    const K = INTENTS.length, rnd = seeded(339);
    const m = { K, W1: new Float32Array(D * H).map(() => (rnd() * 2 - 1) * 0.1), b1: new Float32Array(H), W2: new Float32Array(H * K).map(() => (rnd() * 2 - 1) * Math.sqrt(1 / H)), b2: new Float32Array(K) };
    const P = ["W1", "b1", "W2", "b2"], M1 = {}, M2 = {}, G = {};
    for (const k of P) { M1[k] = new Float32Array(m[k].length); M2[k] = new Float32Array(m[k].length); G[k] = new Float32Array(m[k].length); }
    const lr = 0.03, l2 = 1e-4, n = data.length;
    for (let ep = 1; ep <= 120; ep++) {
      for (const k of P) G[k].fill(0);
      for (const { x, y } of data) {
        const { h, p } = forwardNet(m, x);
        const dh = new Float32Array(H);
        for (let k = 0; k < K; k++) {
          const dz = p[k] - (k === y ? 1 : 0);
          G.b2[k] += dz;
          for (let j = 0; j < H; j++) { G.W2[j * K + k] += h[j] * dz; dh[j] += m.W2[j * K + k] * dz; }
        }
        for (let j = 0; j < H; j++) { const g = dh[j] * (1 - h[j] * h[j]); G.b1[j] += g; for (const i of x) G.W1[i * H + j] += g; }
      }
      const c1 = 1 - 0.9 ** ep, c2 = 1 - 0.999 ** ep;
      for (const k of P) {
        const w = m[k], g = G[k], a = M1[k], b = M2[k], reg = k[0] === "W" ? l2 : 0;
        for (let i = 0; i < w.length; i++) {
          const gi = g[i] / n + reg * w[i];
          a[i] = 0.9 * a[i] + 0.1 * gi; b[i] = 0.999 * b[i] + 0.001 * gi * gi;
          w[i] -= (lr * (a[i] / c1)) / (Math.sqrt(b[i] / c2) + 1e-8);
        }
      }
    }
    return m;
  }
  function classify(q) {
    if (!NET) NET = trainNet();
    const { p } = forwardNet(NET, featuresOf(q.words, q.flags));
    return INTENTS.map((k, i) => ({ k, p: p[i] })).sort((a, b) => b.p - a.p);
  }

  // ======================================================================
  // Reading a question: the codes in it (order, invoice, box serial, account, batch), the customer named, the time asked
  // about, then the words for the network
  // ======================================================================
  const RE = { order: /\b(?:OR|CO)-\d{6}-\d{1,6}\b/gi, invoice: /\bINV-\d{6}-\d{1,6}\b/gi, account: /\b[A-Z]{1,4}-\d{6,10}\b/gi, serial: /\b[A-Z]{1,2}\d{6,9}\b/gi, batch: /\b[A-Z]{1,3}-\d{1,3}\b/gi };
  const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  function periodOf(t) {
    const today = isoToday(), d0 = new Date(today + "T00:00:00");
    const at = (y, m, d) => isoDay(new Date(y, m, d));
    const y = d0.getFullYear(), m = d0.getMonth();
    if (/\b(today|ngayon|aj|now)\b/.test(t)) return { from: today, to: today, label: "today" };
    if (/\b(yesterday|kahapon|kal)\b/.test(t)) { const x = at(y, m, d0.getDate() - 1); return { from: x, to: x, label: "yesterday" }; }
    let r = /\blast (\d{1,3}) days?\b/.exec(t);
    if (r) return { from: at(y, m, d0.getDate() - Number(r[1]) + 1), to: today, label: `the last ${r[1]} days` };
    if (/\blast week\b/.test(t)) { const mon = d0.getDate() - ((d0.getDay() + 6) % 7); return { from: at(y, m, mon - 7), to: at(y, m, mon - 1), label: "last week" }; }
    if (/\bweek\b/.test(t)) { const mon = d0.getDate() - ((d0.getDay() + 6) % 7); return { from: at(y, m, mon), to: today, label: "this week" }; }
    if (/\b(last|previous) month\b/.test(t)) return { from: at(y, m - 1, 1), to: at(y, m, 0), label: MONTHS[(m + 11) % 12].toUpperCase() + " " + (m ? y : y - 1) };
    if (/\blast year\b/.test(t)) return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31`, label: String(y - 1) };
    if (/\b(this year|year)\b/.test(t)) return { from: `${y}-01-01`, to: today, label: String(y) };
    r = new RegExp(`\\b(${MONTHS.join("|")}|${MONTHS.map((x) => x.slice(0, 3)).join("|")})\\b(?:\\s+(20\\d\\d))?`).exec(t);
    if (r && !(r[1] === "may" && !r[2] && !/\bin may\b/.test(t))) {
      const mi = MONTHS.findIndex((x) => x.startsWith(r[1].slice(0, 3))), yy = r[2] ? Number(r[2]) : mi > m ? y - 1 : y;
      return { from: at(yy, mi, 1), to: at(yy, mi + 1, 0), label: MONTHS[mi].toUpperCase() + " " + yy };
    }
    if (/\bmonth\b/.test(t)) return { from: at(y, m, 1), to: today, label: MONTHS[m].toUpperCase() + " " + y };
    return null;
  }
  // the customers, for names and account numbers (kept for 20 seconds)
  let CUST = null;
  async function customers() {
    if (CUST && Date.now() - CUST.at < 20000) return CUST.list;
    const r = await E.allRows(() => sb.from("customers").select("id, first_name, last_name, business_name, account_no, status, credit_limit, opening_balance, application_date").order("id"));
    if (r.error) throw r.error;
    const list = r.data.map((c) => ({ ...c, toks: [...new Set(norm(`${c.first_name || ""} ${c.last_name || ""} ${c.business_name || ""}`).split(" ").filter((w) => w.length >= 2))] }));
    CUST = { at: Date.now(), list };
    return list;
  }
  // the customers a question names: by account no, or by the words of the name (written a little wrong too)
  function namedCustomers(words, list, accounts) {
    for (const a of accounts) { const c = list.find((x) => String(x.account_no || "").toUpperCase() === a); if (c) return { list: [c], used: [] }; }
    const cand = words.filter((w) => w.length >= 2 && !CTX.has(w) && !/^\d+$/.test(w));
    if (!cand.length) return { list: [], used: [] };
    // a word EVA knows (eva, april …) counts for a name only next to another word of that name (or the whole name written)
    const sim = (q, t) => q === t ? 1 : VOCAB.has(q) ? 0 : q.length >= 3 && (t.startsWith(q) || q.startsWith(t)) && Math.min(q.length, t.length) >= 3 ? 0.85
      : Math.min(q.length, t.length) >= 4 && lev(q, t) <= 1 ? 0.8 : Math.min(q.length, t.length) >= 7 && lev(q, t) <= 2 ? 0.65 : 0;
    const scored = [];
    for (const c of list) {
      let sum = 0, top = 0, exact = 0; const used = new Set();
      for (const t of c.toks) {
        let best = 0, bq = "";
        for (const q of cand) { const s = sim(q, t); if (s > best) { best = s; bq = q; } }
        if (best) { sum += best; used.add(bq); if (!VOCAB.has(bq)) top = Math.max(top, best); if (best === 1) exact++; }
      }
      if (top >= 0.8 || (c.toks.length >= 2 && exact === c.toks.length)) scored.push({ c, score: sum + 0.1 * (sum / Math.max(1, c.toks.length)), used: [...used] });
    }
    scored.sort((a, b) => b.score - a.score);
    if (!scored.length) return { list: [], used: [] };
    const same = scored.filter((x) => scored[0].score - x.score < 0.15);
    return { list: same.slice(0, 6).map((x) => x.c), used: scored[0].used };
  }
  // q: { text, words, flags, codes, period, named }
  function readQuestion(text, custList, training = false) {
    let raw = String(text || "");
    const codes = { order: [], invoice: [], account: [], serial: [], batch: [] }, flags = new Set();
    if (training) {
      raw = raw.replace(/\{c\}/g, () => { flags.add("cust"); return " "; }).replace(/\{s\}/g, () => { flags.add("serial"); return " "; }).replace(/\{b\}/g, () => { flags.add("batch"); return " "; })
        .replace(/\{o\}/g, () => { flags.add("order"); return " "; }).replace(/\{i\}/g, () => { flags.add("invoice"); return " "; });
    } else {
      for (const k of ["order", "invoice", "account", "serial", "batch"]) raw = raw.replace(RE[k], (x) => { codes[k].push(x.toUpperCase()); flags.add(k === "account" ? "cust" : k); return " "; });
    }
    const t = norm(raw);
    let words = t ? t.split(" ") : [];
    const period = periodOf(t);
    if (period) flags.add("period");
    if (words.some((w) => CTX.has(w))) flags.add("ctx");
    let named = { list: [], used: [] };
    if (!training && custList) {
      named = namedCustomers(words, custList, codes.account);
      if (named.list.length) { flags.add("cust"); words = words.filter((w) => !named.used.includes(w)); }
    }
    return { text: String(text || ""), words: words.map(fixWord), rest: words, flags: [...flags], codes, period, named };
  }

  // ======================================================================
  // The answers (each reads the server now). An answer: { html, chips: [[label, question]], cust }
  // ======================================================================
  const money = (v) => `₱ ${peso(v)}`;
  const nameOf = (c) => fullName(c || {}).toUpperCase();
  const custLink = (c) => `<a href="#customer/${esc(c.id)}">${esc(nameOf(c))}</a>${c.account_no ? ` <small class="mono">${esc(c.account_no)}</small>` : ""}`;
  const daysBetween = (a, b) => Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 864e5);
  const isOver = (i) => i.pay_status !== "paid" && num(i.balance) > 0.004 && i.due_date && i.due_date < isoToday();
  const table = (head, rows) => `<table class="eva-t"><thead><tr>${head.map((h) => `<th${/₱|Boxes|Pcs|Days|#/.test(h) ? ' class="num"' : ""}>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((v, i) => `<td${/₱|Boxes|Pcs|Days|#/.test(head[i]) ? ' class="num"' : ""}>${v}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  const ORDER_ST = { pending: "1 · CREATE ORDER (waits for your approval)", approved: "2 · PREPARED (ready to deliver)", completed: "3 · COMPLETE (delivered)", cancelled: "CANCELLED" };
  const rows = async (make) => { const r = await E.allRows(make); if (r.error) throw r.error; return r.data; };
  const one = async (q) => { const { data, error } = await q; if (error) throw error; return data; };

  async function aDue(c) {
    const [b, invs] = await Promise.all([one(sb.from("customer_balances").select("*").eq("customer_id", c.id).maybeSingle()),
      one(sb.from("invoice_balances").select("id, invoice_no, due_date, balance, pay_status").eq("customer_id", c.id))]);
    const due = num(b?.balance_due), open = (invs || []).filter((i) => i.pay_status !== "paid" && num(i.balance) > 0.004), over = open.filter(isOver);
    const oldest = over.reduce((m, i) => Math.max(m, daysBetween(i.due_date, isoToday())), 0);
    const lim = c.credit_limit == null ? null : num(c.credit_limit);
    return { cust: c, html: `${custLink(c)} — current due: <b class="eva-amt">${money(due)}</b>${due < 0 ? ` (overpaid: ${money(-due)} is ready for the next invoice)` : due === 0 ? " · fully paid" : ""}
      <br>${open.length ? `${open.length} unpaid invoice${open.length === 1 ? "" : "s"}${over.length ? `, <b>${over.length} overdue</b> (${money(over.reduce((s, i) => s + num(i.balance), 0))}, the oldest ${oldest} day${oldest === 1 ? "" : "s"} late)` : ", nothing overdue"}` : "No unpaid invoice."}
      ${lim != null ? `<br>Credit limit ${money(lim)}${due > lim + 0.004 ? ` — <b>over the limit by ${money(due - lim)}</b>` : ` — ${money(Math.max(0, lim - due))} still free`}` : ""}
      ${String(c.status) !== "active" ? `<br>The account is <b>${esc(String(c.status).toUpperCase())}</b>.` : ""}`,
      chips: [["Last payment", "last payment of this customer"], ["Unpaid invoices", "unpaid invoices of this customer"], ["Gate pass idea", "gate pass this customer"]] };
  }
  async function balances() {
    const [bal, list] = await Promise.all([rows(() => sb.from("customer_balances").select("customer_id, balance_due").order("customer_id")), customers()]);
    const byId = new Map(list.map((c) => [c.id, c]));
    return bal.map((b) => ({ c: byId.get(b.customer_id), due: num(b.balance_due) })).filter((x) => x.c);
  }
  async function aTotalDue() {
    const all = await balances(), owing = all.filter((x) => x.due > 0.004).sort((a, b) => b.due - a.due);
    const total = owing.reduce((s, x) => s + x.due, 0), credit = all.filter((x) => x.due < -0.004).reduce((s, x) => s - x.due, 0);
    return { html: `Total due of all customers (still to collect): <b class="eva-amt">${money(total)}</b> from ${owing.length} customer${owing.length === 1 ? "" : "s"}.${credit > 0 ? `<br>Overpaid credit (customers paid more): ${money(credit)}.` : ""}
      ${owing.length ? `<br>Most due: ${owing.slice(0, 3).map((x) => `${custLink(x.c)} ${money(x.due)}`).join(" · ")}` : ""}`, chips: [["Top 10 due", "who has most due"], ["Overdue", "overdue customers"]] };
  }
  async function aTopDue() {
    const owing = (await balances()).filter((x) => x.due > 0.004).sort((a, b) => b.due - a.due);
    if (!owing.length) return { html: "No customer owes anything now." };
    return { html: `The customers who owe the most (${owing.length} owe something):${table(["#", "Customer", "Due ₱"], owing.slice(0, 10).map((x, i) => [String(i + 1), custLink(x.c), peso(x.due)]))}`, chips: [["Total due", "total due"], ["Overdue", "overdue customers"]] };
  }
  async function aOverdue(c) {
    const q = sb.from("invoice_balances").select("id, invoice_no, customer_id, first_name, last_name, account_no, due_date, balance, pay_status").neq("pay_status", "paid").gt("balance", 0).lt("due_date", isoToday());
    const list = await rows(() => (c ? q.eq("customer_id", c.id) : q).order("due_date"));
    if (c) {
      if (!list.length) return { cust: c, html: `${custLink(c)} has no overdue invoice.` };
      return { cust: c, html: `${custLink(c)} — ${list.length} overdue invoice${list.length === 1 ? "" : "s"}, <b class="eva-amt">${money(list.reduce((s, i) => s + num(i.balance), 0))}</b>:
        ${table(["Invoice", "Due Date", "Days Late", "Balance ₱"], list.slice(0, 10).map((i) => [`<a href="#invoice/${esc(i.id)}">${esc(i.invoice_no)}</a>`, esc(mdy(i.due_date)), String(daysBetween(i.due_date, isoToday())), peso(i.balance)]))}` };
    }
    if (!list.length) return { html: "No invoice is overdue now. 👍" };
    const g = new Map();
    for (const i of list) { const x = g.get(i.customer_id) || { c: { id: i.customer_id, first_name: i.first_name, last_name: i.last_name, account_no: i.account_no }, amt: 0, n: 0, days: 0 }; x.amt += num(i.balance); x.n++; x.days = Math.max(x.days, daysBetween(i.due_date, isoToday())); g.set(i.customer_id, x); }
    const top = [...g.values()].sort((a, b) => b.amt - a.amt);
    return { html: `Overdue now: <b class="eva-amt">${money(list.reduce((s, i) => s + num(i.balance), 0))}</b> on ${list.length} invoice${list.length === 1 ? "" : "s"} of ${top.length} customer${top.length === 1 ? "" : "s"}.
      ${table(["Customer", "Invoices", "Oldest Days", "Overdue ₱"], top.slice(0, 10).map((x) => [custLink(x.c), String(x.n), String(x.days), peso(x.amt)]))}` };
  }
  async function aLastPayment(c) {
    if (c) {
      const p = await one(sb.from("payments_received").select("id, receipt_no, paid_date, amount").eq("customer_id", c.id).order("paid_date", { ascending: false }).order("created_at", { ascending: false }).limit(1).maybeSingle());
      if (!p) return { cust: c, html: `${custLink(c)} has not paid yet (no payment recorded).` };
      const d = daysBetween(p.paid_date, isoToday());
      return { cust: c, html: `Last payment of ${custLink(c)}: <b class="eva-amt">${money(p.amount)}</b> on <b>${esc(mdy(p.paid_date))}</b> (${d === 0 ? "today" : `${d} day${d === 1 ? "" : "s"} ago`}) · receipt <a href="#payment/${esc(p.id)}">${esc(p.receipt_no || "")}</a>`,
        chips: [["Due now", "how much due this customer"], ["All payments", "payments of this customer"]] };
    }
    const list = await one(sb.from("payments_received").select("id, receipt_no, paid_date, amount, customers(id, first_name, last_name, account_no)").order("paid_date", { ascending: false }).order("created_at", { ascending: false }).limit(5));
    if (!list?.length) return { html: "No payment recorded yet." };
    return { html: `The last payments received:${table(["Date", "Customer", "Receipt", "Amount ₱"], list.map((p) => [esc(mdy(p.paid_date)), p.customers ? custLink(p.customers) : "", `<a href="#payment/${esc(p.id)}">${esc(p.receipt_no || "")}</a>`, peso(p.amount)]))}` };
  }
  const monthPeriod = () => periodOf("this month");
  async function sumIn(table_, dateCol, amtCol, p) {
    const list = await rows(() => sb.from(table_).select(`${dateCol}, ${amtCol}`).gte(dateCol, p.from).lte(dateCol, p.to).order(dateCol));
    return { n: list.length, sum: list.reduce((s, r) => s + num(r[amtCol]), 0) };
  }
  async function aPayments(c, period) {
    if (c) {
      const list = await rows(() => sb.from("payments_received").select("id, receipt_no, paid_date, amount").eq("customer_id", c.id).order("paid_date", { ascending: false }));
      const inP = period ? list.filter((p) => p.paid_date >= period.from && p.paid_date <= period.to) : list;
      if (!list.length) return { cust: c, html: `${custLink(c)} has not paid yet (no payment recorded).` };
      return { cust: c, html: `${custLink(c)} paid <b class="eva-amt">${money(inP.reduce((s, p) => s + num(p.amount), 0))}</b> ${period ? `in ${esc(period.label)}` : "in all"} (${inP.length} payment${inP.length === 1 ? "" : "s"}).
        ${inP.length ? table(["Date", "Receipt", "Amount ₱"], inP.slice(0, 8).map((p) => [esc(mdy(p.paid_date)), `<a href="#payment/${esc(p.id)}">${esc(p.receipt_no || "")}</a>`, peso(p.amount)])) : ""}` };
    }
    const p = period || monthPeriod(), r = await sumIn("payments_received", "paid_date", "amount", p);
    const t = p.label === "today" ? null : await sumIn("payments_received", "paid_date", "amount", periodOf("today"));
    return { html: `Payments received ${p.label === "today" || p.label === "yesterday" ? "" : "in "}${esc(p.label)}: <b class="eva-amt">${money(r.sum)}</b> (${r.n} payment${r.n === 1 ? "" : "s"}).${t ? `<br>Today: ${money(t.sum)} (${t.n}).` : ""}`,
      chips: [["Sales this month", "sales this month"], ["Last payments", "last payment received"]] };
  }
  async function aSales(period) {
    const p = period || monthPeriod(), r = await sumIn("customer_invoices", "invoice_date", "total_amount", p);
    const t = p.label === "today" ? null : await sumIn("customer_invoices", "invoice_date", "total_amount", periodOf("today"));
    return { html: `Sales (invoices) ${p.label === "today" || p.label === "yesterday" ? "" : "in "}${esc(p.label)}: <b class="eva-amt">${money(r.sum)}</b> on ${r.n} invoice${r.n === 1 ? "" : "s"}.${t ? `<br>Today: ${money(t.sum)} (${t.n}).` : ""}`,
      chips: [["Collection this month", "collection this month"], ["Total due", "total due"]] };
  }
  async function aInvoices(c, no) {
    if (no) {
      const i = await one(sb.from("invoice_balances").select("*").eq("invoice_no", no).maybeSingle());
      if (!i) return { html: `Invoice ${esc(no)} is not found.` };
      const st = { paid: "PAID", partial: "PARTIAL PAYMENT", unpaid: "UNPAID" }[i.pay_status] || String(i.pay_status || "").toUpperCase();
      return { cust: { id: i.customer_id, first_name: i.first_name, last_name: i.last_name, account_no: i.account_no }, html: `Invoice <a href="#invoice/${esc(i.id)}"><b>${esc(i.invoice_no)}</b></a> of ${custLink({ id: i.customer_id, first_name: i.first_name, last_name: i.last_name, account_no: i.account_no })}
        <br>Date ${esc(mdy(i.invoice_date))} · amount ${money(i.total_amount)} · paid ${money(i.amount_paid)} · balance <b>${money(i.balance)}</b> · <b>${esc(st)}</b>${isOver(i) ? ` · OVERDUE ${daysBetween(i.due_date, isoToday())} day(s)` : ""}
        ${i.due_date ? `<br>Due date ${esc(mdy(i.due_date))}` : ""}${i.po_number ? ` · order ${esc(i.po_number)}` : ""}` };
    }
    const q = sb.from("invoice_balances").select("id, invoice_no, invoice_date, due_date, total_amount, balance, pay_status, customer_id, first_name, last_name, account_no").neq("pay_status", "paid").gt("balance", 0);
    const list = await rows(() => (c ? q.eq("customer_id", c.id) : q).order("invoice_date"));
    if (c) {
      if (!list.length) return { cust: c, html: `${custLink(c)} has no unpaid invoice.` };
      return { cust: c, html: `${custLink(c)} — ${list.length} unpaid invoice${list.length === 1 ? "" : "s"}, balance <b class="eva-amt">${money(list.reduce((s, i) => s + num(i.balance), 0))}</b>:
        ${table(["Invoice", "Date", "Due Date", "Balance ₱"], list.slice(0, 10).map((i) => [`<a href="#invoice/${esc(i.id)}">${esc(i.invoice_no)}</a>${isOver(i) ? " ⚠" : ""}`, esc(mdy(i.invoice_date)), esc(mdy(i.due_date) || ""), peso(i.balance)]))}` };
    }
    return { html: `${list.length} unpaid invoice${list.length === 1 ? "" : "s"} now, balance <b class="eva-amt">${money(list.reduce((s, i) => s + num(i.balance), 0))}</b> (${list.filter(isOver).length} overdue).`, chips: [["Overdue", "overdue customers"], ["Top due", "who has most due"]] };
  }
  async function aOrders(c, no, period) {
    const sel = "id, order_no, status, order_date, total_boxes, total_pcs, total_amount, invoice_id, rider_name, customer_id, customers(id, first_name, last_name, account_no)";
    if (no) {
      const o = await one(sb.from("customer_orders").select(sel).in("order_no", [no, no.replace(/^CO-/, "OR-"), no.replace(/^OR-/, "CO-")]).limit(1).maybeSingle());
      if (!o) return { html: `Order ${esc(no)} is not found.` };
      const inv = o.invoice_id ? await one(sb.from("customer_invoices").select("id, invoice_no").eq("id", o.invoice_id).maybeSingle()) : null;
      return { cust: o.customers, html: `Order <a href="#custorder/${esc(o.id)}"><b>${esc(o.order_no)}</b></a> of ${o.customers ? custLink(o.customers) : ""}: <b>${esc(ORDER_ST[o.status] || o.status)}</b>
        <br>${esc(mdy(o.order_date))} · ${qtyText(o.total_boxes)} box${num(o.total_boxes) === 1 ? "" : "es"} · ${qtyText(o.total_pcs)} pcs · ${money(o.total_amount)}${inv ? `<br>Invoice <a href="#invoice/${esc(inv.id)}">${esc(inv.invoice_no)}</a> (made and billed)` : ""}${o.rider_name ? ` · rider ${esc(o.rider_name)}` : ""}` };
    }
    let q = sb.from("customer_orders").select(sel);
    if (c) q = q.eq("customer_id", c.id);
    if (period) q = q.gte("order_date", period.from).lte("order_date", period.to);
    else if (!c) q = q.in("status", ["pending", "approved"]);
    const list = await rows(() => q.order("order_date", { ascending: false }).order("order_no", { ascending: false }));
    const shown = list.slice(0, 10), row = (o) => [`<a href="#custorder/${esc(o.id)}">${esc(o.order_no)}</a>`, o.customers ? esc(nameOf(o.customers)) : "", esc(ORDER_ST[o.status]?.split(" (")[0] || o.status), qtyText(o.total_boxes), peso(o.total_amount)];
    if (!list.length) return { cust: c || undefined, html: c ? `${custLink(c)} has no customer order${period ? ` in ${esc(period.label)}` : ""}.` : period ? `No customer order in ${esc(period.label)}.` : "No customer order is open now (nothing waits for approval or delivery)." };
    const pend = list.filter((o) => o.status === "pending").length, prep = list.filter((o) => o.status === "approved").length;
    return { cust: c || undefined, html: `${c ? `${custLink(c)} — ` : ""}${list.length} order${list.length === 1 ? "" : "s"}${period ? ` in ${esc(period.label)}` : c ? "" : " open"}${pend || prep ? ` (${pend} wait${pend === 1 ? "s" : ""} for your approval, ${prep} prepared to deliver)` : ""}:
      ${table(["Order", "Customer", "Status", "Boxes", "Amount ₱"], shown.map(row))}` };
  }
  // what EVA's network says about a gate pass for the customer (the same idea as in the Gate Pass window)
  async function aGate(c) {
    const ai = E.gateAI;
    const cur = ai ? await ai.current().catch(() => ({ model: null })) : { model: null };
    if (!cur.model) return { cust: c, html: `EVA has not learned yet${cur.old ? " with the records it reads now" : ""}. Open <a href="#gateai">EVA AI</a> and press <b>Learn Now</b>, then ask again.` };
    const [full, invs, pays, memos, letters, corders] = await Promise.all([
      one(sb.from("customers").select("*").eq("id", c.id).maybeSingle()),
      rows(() => sb.from("customer_invoices").select("id, customer_id, invoice_no, invoice_date, total_amount, payment_terms").eq("customer_id", c.id).order("id")),
      rows(() => sb.from("payments_received").select("id, customer_id, paid_date, amount, payment_links(id, invoice_id, amount, removed_at)").eq("customer_id", c.id).order("id")),
      rows(() => sb.from("credit_memos").select("*").eq("customer_id", c.id).order("id")),
      rows(() => sb.from("order_letters").select("id, customer_id, subject_type, subject, status, adjust_type, amount, approved_at, applied_at, created_at").eq("customer_id", c.id).order("id")),
      rows(() => sb.from("customer_orders").select("id, customer_id, status, total_amount, created_at, completed_at, cancelled_at").eq("customer_id", c.id).order("id"))]);
    const d = ai.idea(cur.model, full || c, { invs, pays, memos, letters, corders });
    return { cust: c, html: `<div class="eva-idea ${d.clear ? "clear" : "hold"}"><b>EVA SUGGESTS: ${d.clear ? "CLEAR" : "HOLD"}</b> for ${custLink(c)} · ${Math.min(99, Math.round(d.sure * 100))}% sure
      ${d.reasons.length ? `<ul>${d.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}<small>The portal's Gate Pass rule says: ${d.rule ? "CLEAR" : "NOT CLEARED"}. EVA only gives an idea; you decide.</small></div>` };
  }
  async function aLimit(c) {
    const b = await one(sb.from("customer_balances").select("balance_due").eq("customer_id", c.id).maybeSingle());
    const due = num(b?.balance_due);
    if (c.credit_limit == null) return { cust: c, html: `${custLink(c)} has no credit limit. Current due ${money(due)}.` };
    const lim = num(c.credit_limit);
    return { cust: c, html: `Credit limit of ${custLink(c)}: <b class="eva-amt">${money(lim)}</b> · current due ${money(due)} · ${due > lim + 0.004 ? `<b>over the limit by ${money(due - lim)}</b>` : `<b>${money(lim - due)}</b> still free`}` };
  }
  async function aCustomer(c) {
    const [b, invs, last, ords] = await Promise.all([one(sb.from("customer_balances").select("balance_due").eq("customer_id", c.id).maybeSingle()),
      one(sb.from("invoice_balances").select("due_date, balance, pay_status").eq("customer_id", c.id)),
      one(sb.from("payments_received").select("paid_date, amount").eq("customer_id", c.id).order("paid_date", { ascending: false }).limit(1).maybeSingle()),
      one(sb.from("customer_orders").select("status").eq("customer_id", c.id).in("status", ["pending", "approved"]))]);
    const over = (invs || []).filter(isOver);
    return { cust: c, html: `${custLink(c)} · <b>${esc(String(c.status || "").toUpperCase())}</b>${c.application_date ? ` · customer since ${esc(mdy(c.application_date))}` : ""}
      <br>Current due <b class="eva-amt">${money(b?.balance_due)}</b>${over.length ? ` · ${over.length} overdue invoice${over.length === 1 ? "" : "s"}` : " · nothing overdue"}${c.credit_limit != null ? ` · credit limit ${money(c.credit_limit)}` : ""}
      <br>${last ? `Last payment ${money(last.amount)} on ${esc(mdy(last.paid_date))}` : "No payment yet"} · ${(ords || []).length} open order${(ords || []).length === 1 ? "" : "s"}`,
      chips: [["Gate pass idea", "gate pass this customer"], ["Unpaid invoices", "unpaid invoices of this customer"], ["Orders", "orders of this customer"]] };
  }
  async function aCount() {
    const list = await customers(), by = (s) => list.filter((c) => c.status === s).length;
    return { html: `<b>${list.length}</b> customer accounts: ${by("active")} active, ${by("suspended")} suspended, ${by("closed")} closed${list.length - by("active") - by("suspended") - by("closed") ? `, ${list.length - by("active") - by("suspended") - by("closed")} waiting (applications)` : ""}.` };
  }

  // ---------- boxes (the box database read from the sheet) ----------
  let BOX = null;
  async function boxData() {
    if (BOX && Date.now() - BOX.at < 5000) return BOX;
    const [stock, onOrders] = await Promise.all([rows(() => sb.from("box_stock").select("serial_no, product, brand, ctn, style, qty, batch").order("serial_no")),
      rows(() => sb.from("customer_order_boxes").select("serial_no, customer_orders(id, order_no, status, customer_id)").order("id"))]);
    const where = new Map();
    for (const b of onOrders) if (b.customer_orders && b.customer_orders.status !== "cancelled") where.set(b.serial_no, b.customer_orders);
    BOX = { at: Date.now(), stock, where, batches: [...new Set(stock.map((b) => b.batch).filter(Boolean))] };
    return BOX;
  }
  const STOCK_STOP = new Set(["how", "what", "which", "the", "of", "in", "for", "this", "brand", "product", "by", "have", "has", "are", "there", "show", "much", "pcs", "piece", "pieces", "now"]);
  const boxState = (o) => (!o ? "IN STOCK" : o.status === "completed" ? "DELIVERED" : "ON ORDER");
  async function aBox(serial) {
    const [b, on] = await Promise.all([one(sb.from("box_stock").select("*").eq("serial_no", serial).maybeSingle()),
      one(sb.from("customer_order_boxes").select("serial_no, items, pcs, customer_orders(id, order_no, status, customers(id, first_name, last_name, account_no))").eq("serial_no", serial))]);
    const o = (on || []).map((x) => x.customer_orders).find((x) => x && x.status !== "cancelled");
    if (!b && !o) return { html: `Box <b class="mono">${esc(serial)}</b> is not in the box database. If it is in your Google Sheet, press <b>Read Sheet</b> on the <a href="#gateai">EVA AI</a> page.` };
    const st = boxState(o);
    return { cust: o?.customers, html: `Box <b class="mono">${esc(serial)}</b>: <b>${esc(st)}</b>${o ? ` · order <a href="#custorder/${esc(o.id)}">${esc(o.order_no)}</a>${o.customers ? ` for ${custLink(o.customers)}` : ""}` : ""}
      ${b ? table(["Product", "Brand", "CTN", "Style", "Pcs", "Batch"], [[esc(b.product || ""), esc(b.brand || ""), esc(b.ctn || ""), esc(b.style || ""), qtyText(b.qty), esc(b.batch || "")]]) : "<br>(not in the box database: the order's details are shown on the order)"}` };
  }
  async function aStock(q) {
    const d = await boxData();
    if (!d.stock.length) return { html: `The box database is empty. Open <a href="#gateai">EVA AI</a> and press <b>Read Sheet</b> (your Google Sheet DATABASE, columns A to G).` };
    let batch = q.codes.batch[0] || "";
    if (!batch) { const w = q.rest.find((x) => d.batches.some((b) => b.replace("-", "").toLowerCase() === x)); if (w) batch = d.batches.find((b) => b.replace("-", "").toLowerCase() === w); }
    let pick = d.stock, label = "all batches";
    if (batch) { pick = d.stock.filter((b) => b.batch === batch); label = `batch ${batch}`; }
    else {
      // a brand or product named ("stock zara", "stock ladies blawase")
      const words = q.rest.filter((w) => w.length >= 3 && !CONCEPT_OF.has(fixWord(w)) && !STOCK_STOP.has(w));
      if (words.length) {
        const hit = (txt) => { const t = norm(txt).split(" "); return words.every((w) => t.some((x) => x === w || (x.length >= 4 && w.length >= 4 && lev(x, w) <= 1))); };
        const byBrand = d.stock.filter((b) => hit(b.brand || "")), byProd = d.stock.filter((b) => hit(b.product || "") || hit(`${b.product || ""} ${b.brand || ""}`));
        if (byBrand.length) { pick = byBrand; label = `brand ${String(byBrand[0].brand).toUpperCase()}`; }
        else if (byProd.length) { pick = byProd; label = words.join(" ").toUpperCase(); }
      }
    }
    if (!pick.length) return { html: `No box of ${esc(label)} in the box database.` };
    const sum = (list) => ({ n: list.length, pcs: list.reduce((s, b) => s + num(b.qty), 0) });
    const inS = pick.filter((b) => !d.where.has(b.serial_no)), onO = pick.filter((b) => d.where.get(b.serial_no)?.status && d.where.get(b.serial_no).status !== "completed"), done = pick.filter((b) => d.where.get(b.serial_no)?.status === "completed");
    const a = sum(inS), o = sum(onO), dn = sum(done);
    let html = `Stock of <b>${esc(label)}</b>: <b class="eva-amt">${qtyText(a.n)} box${a.n === 1 ? "" : "es"}</b> in stock (${qtyText(a.pcs)} pcs)${o.n ? ` · ${qtyText(o.n)} on open orders` : ""}${dn.n ? ` · ${qtyText(dn.n)} delivered` : ""} · ${qtyText(pick.length)} in the sheet.`;
    if (!batch) {
      const g = new Map();
      for (const b of inS) { const k = b.batch || "—"; const x = g.get(k) || { n: 0, pcs: 0 }; x.n++; x.pcs += num(b.qty); g.set(k, x); }
      const top = [...g.entries()].sort((x, y) => y[1].n - x[1].n).slice(0, 12);
      if (top.length > 1) html += table(["Batch", "Boxes", "Pcs"], top.map(([k, x]) => [esc(k), qtyText(x.n), qtyText(x.pcs)]));
    } else {
      const g = new Map();
      for (const b of inS) { const k = `${b.product || ""}${b.brand && b.brand !== "-" ? ` · ${b.brand}` : ""}`; const x = g.get(k) || { n: 0, pcs: 0 }; x.n++; x.pcs += num(b.qty); g.set(k, x); }
      const top = [...g.entries()].sort((x, y) => y[1].n - x[1].n).slice(0, 12);
      if (top.length) html += table(["Product · Brand", "Boxes", "Pcs"], top.map(([k, x]) => [esc(k), qtyText(x.n), qtyText(x.pcs)]));
    }
    return { html };
  }

  const HELP = [["How much due this customer?", "how much due this customer"], ["Total due", "total due"], ["Who has the most due?", "who has most due"], ["Overdue customers", "overdue customers"],
    ["Sales this month", "sales this month"], ["Collection today", "collection today"], ["Open orders", "open orders"], ["Stock", "stock"], ["How many customers?", "how many customers"]];
  const helpHtml = () => `I am <b>EVA</b>, your AI assistant. I read the records on your server and answer in a moment. Ask me in simple words, for example:
    <ul class="eva-ex"><li>how much due <i>Precious Roman</i> · this customer due how much</li><li>total due · who has most due · overdue customers</li>
    <li>last payment of <i>name</i> · collection today · sales this month</li><li>open orders · OR-202610-0001 · INV-202610-0001</li>
    <li>gate pass <i>name</i> (my CLEAR / HOLD idea) · credit limit <i>name</i></li><li>U20261240 (a box) · stock L-13 · stock zara</li></ul>`;

  // ======================================================================
  // One question → one answer. A question that needs a customer and names none asks for it; the next message may answer.
  // ======================================================================
  const NEEDS_CUST = new Set(["due", "limit", "gate", "customer_info"]);
  const CAN_CUST = new Set(["due", "limit", "gate", "customer_info", "overdue", "last_payment", "payments", "invoices", "orders"]);
  const ctx = { last: null, waiting: null }; // the customer talked about; a question waiting for its customer
  async function pageCustomer(list) {
    const [k, id] = decodeURIComponent(location.hash.slice(1)).split("/");
    if (!id) return null;
    let cid = null;
    if (k === "customer") cid = id;
    else if (k === "custorder") cid = (await sb.from("customer_orders").select("customer_id").eq(/^(CO|OR)-/i.test(id) ? "order_no" : "id", id).maybeSingle()).data?.customer_id;
    else if (k === "invoice") cid = (await sb.from("customer_invoices").select("customer_id").eq("id", id).maybeSingle()).data?.customer_id;
    return cid ? list.find((c) => c.id === cid) || null : null;
  }
  async function answer(text, pickedId = null) {
    const list = await customers();
    const q = readQuestion(text, list);
    const ranked = classify(q);
    let intent = ranked[0].k;
    const sure = ranked[0].p;
    // what the codes in the question say at once
    if (q.codes.serial.length && !["stock"].includes(intent)) intent = "box";
    else if (q.codes.order.length && intent !== "box") intent = "orders";
    else if (q.codes.invoice.length) intent = "invoices";
    else if (q.codes.batch.length && !["box", "orders", "invoices"].includes(intent)) intent = "stock";
    // a customer picked from a list, named in the question, of the page open, or the one talked about before
    let cust = pickedId ? list.find((c) => c.id === pickedId) : null;
    if (!cust && q.named.list.length > 1) {
      const intentFor = CAN_CUST.has(intent) ? intent : "customer_info";
      ctx.waiting = { intent: intentFor, text };
      return { html: `I found ${q.named.list.length} customers with that name. Which one?`, pick: q.named.list };
    }
    if (!cust && q.named.list.length === 1) cust = q.named.list[0];
    // only a name was written as the answer to "which customer?": the waiting question is answered
    if (cust && ctx.waiting && (sure < 0.6 || intent === "customer_info") && q.words.length <= 1) { intent = ctx.waiting.intent; }
    else if (!cust && ctx.waiting && sure < 0.35) return { html: "I did not find that customer. Write the name as on the account, or the account no (for example PR-202610001)." };
    ctx.waiting = null;
    if (intent === "due" && !cust && q.words.some((w) => ["total", "all", "overall", "sum"].includes(w))) intent = "total_due";
    if (!cust && CAN_CUST.has(intent) && (q.flags.includes("ctx") || NEEDS_CUST.has(intent))) cust = (await pageCustomer(list)) || ctx.last;
    if (!cust && NEEDS_CUST.has(intent)) {
      ctx.waiting = { intent, text };
      return { html: `Which customer? Write the name or the account no.${intent === "due" ? " (Ask <b>total due</b> for all customers.)" : ""}` };
    }
    if (sure < 0.3 && !q.codes.serial.length && !q.codes.order.length && !q.codes.invoice.length && !q.codes.batch.length && !cust) return { html: `Sorry, I did not understand that. ${helpHtml()}`, chips: HELP };
    let r;
    switch (intent) {
      case "due": r = await aDue(cust); break;
      case "total_due": r = await aTotalDue(); break;
      case "top_due": r = await aTopDue(); break;
      case "overdue": r = await aOverdue(cust); break;
      case "last_payment": r = await aLastPayment(cust); break;
      case "payments": r = await aPayments(cust, q.period); break;
      case "sales": r = await aSales(q.period); break;
      case "invoices": r = await aInvoices(cust, q.codes.invoice[0]); break;
      case "orders": r = await aOrders(cust, q.codes.order[0], q.period); break;
      case "gate": r = await aGate(cust); break;
      case "limit": r = await aLimit(cust); break;
      case "customer_info": r = cust ? await aCustomer(cust) : { html: `Which customer? Write the name or the account no.` }; break;
      case "count_customers": r = await aCount(); break;
      case "box": r = q.codes.serial.length ? await aBox(q.codes.serial[0]) : { html: "Write the serial no of the box (for example U20261240)." }; break;
      case "stock": r = await aStock(q); break;
      case "greet": r = { html: `Hello${S.profile?.full_name ? " " + esc(String(S.profile.full_name).split(" ")[0].toLowerCase().replace(/^./, (x) => x.toUpperCase())) : ""}! I am EVA. Ask me about a customer's due, payments, sales, orders, boxes or stock.`, chips: HELP.slice(0, 6) }; break;
      case "thanks": r = { html: "You're welcome! 😊" }; break;
      default: r = { html: helpHtml(), chips: HELP };
    }
    if (r.cust?.id) ctx.last = (await customers()).find((c) => c.id === r.cust.id) || r.cust;
    return { ...r, intent, sure };
  }

  // ======================================================================
  // The chat (in the EVA panel and on the EVA AI page; one conversation)
  // ======================================================================
  const LOG = [];
  const evaIc = () => `<span class="eva-av">${ic("ai")}</span>`;
  function msgHtml(m, seen = null) {
    const nw = !seen || seen.has(m) ? "" : " new";
    seen?.add(m);
    if (m.who === "me") return `<div class="eva-msg me${nw}"><div class="eva-b">${esc(m.text)}</div></div>`;
    return `<div class="eva-msg ai${nw}">${evaIc()}<div class="eva-b">${m.html}${m.pick ? `<div class="eva-chips">${m.pick.map((c) => `<button type="button" class="eva-chip" data-cust="${esc(c.id)}">${esc(nameOf(c))}${c.account_no ? ` · ${esc(c.account_no)}` : ""}</button>`).join("")}</div>` : ""}
      ${m.chips?.length ? `<div class="eva-chips">${m.chips.map(([l, a]) => `<button type="button" class="eva-chip" data-ask="${esc(a)}">${esc(l)}</button>`).join("")}</div>` : ""}</div></div>`;
  }
  const views = new Set(); // the chat boxes open (panel, page)
  const WELCOME = { who: "ai", html: `Hello! I am <b>EVA</b>. Ask me anything about your customers, money, orders or boxes.`, chips: HELP };
  function paint() {
    for (const el of views) {
      if (!el.isConnected) { views.delete(el); continue; }
      const log = $(".eva-log", el);
      const seen = el.evaSeen || (el.evaSeen = new WeakSet());
      log.innerHTML = LOG.length ? LOG.map((m) => msgHtml(m, seen)).join("") : msgHtml(WELCOME, seen);
      log.scrollTop = log.scrollHeight;
    }
  }
  let busyAsk = false;
  async function ask(text, pickedId = null, shown = text) {
    text = String(text || "").trim();
    if (!text || busyAsk) return;
    busyAsk = true;
    LOG.push({ who: "me", text: shown });
    LOG.push({ who: "ai", html: `<span class="eva-dots"><i></i><i></i><i></i></span>` });
    paint();
    try { const r = await answer(text, pickedId); LOG[LOG.length - 1] = { who: "ai", ...r }; }
    catch (e) { LOG[LOG.length - 1] = { who: "ai", html: /box_stock|ai_settings|schema cache|PGRST20/.test(e?.message || "") ? "This needs the database update <b>RUN_048_TO_051.sql</b>. Run it in the Supabase SQL Editor." : `Sorry, I could not read that: ${esc(e?.message || e)}` }; }
    busyAsk = false;
    if (LOG.length > 120) LOG.splice(0, LOG.length - 120);
    paint();
  }
  // a chat box in el (the panel's body or a part of the EVA AI page)
  function mount(el) {
    el.innerHTML = `<div class="eva-chat"><div class="eva-log" aria-live="polite"></div>
      <form class="eva-ask" autocomplete="off"><input type="text" class="eva-q" maxlength="300" data-case="keep" placeholder="Ask EVA… e.g. how much due this customer" aria-label="Ask EVA">
        <button type="submit" class="btn primary" aria-label="Send">${ic("send")}<span>Send</span></button></form></div>`;
    views.add(el);
    if (!NET) setTimeout(() => { if (!NET) NET = trainNet(); }, 400); // the network learns while the chat opens
    const input = $(".eva-q", el);
    $(".eva-ask", el).onsubmit = (e) => { e.preventDefault(); const t = input.value; input.value = ""; ask(t); };
    el.addEventListener("click", (e) => {
      const b = e.target.closest(".eva-chip");
      if (b?.dataset.ask) ask(b.dataset.ask);
      else if (b?.dataset.cust) { const w = ctx.waiting; ask(w ? w.text : "about this customer", b.dataset.cust, b.textContent.trim()); }
      else if (e.target.closest(".eva-b a[href^='#']") && el.closest(".eva-panel") && matchMedia("(max-width: 760px)").matches) closePanel();
    });
    paint();
    return input;
  }
  // the EVA panel (top bar button, the Director only): "this customer" is the customer of the page open
  function openPanel() {
    if (!isAdmin()) return;
    let p = $(".eva-panel");
    if (!p) {
      p = document.createElement("aside");
      p.className = "eva-panel"; p.setAttribute("aria-label", "EVA AI chat");
      p.innerHTML = `<div class="ep-head"><span class="ep-title">${ic("ai")} EVA AI <small>ask me</small></span><a href="#gateai" class="ep-page" title="EVA AI page">${ic("doc")}</a>
        <button type="button" class="ep-x" aria-label="Close">${ic("x")}</button></div><div class="ep-ctx" hidden></div><div class="ep-body"></div>`;
      document.body.appendChild(p);
      $(".ep-x", p).onclick = closePanel;
      $(".ep-page", p).onclick = () => closePanel();
      mount($(".ep-body", p));
      document.addEventListener("keydown", panelKey);
    }
    requestAnimationFrame(() => p.classList.add("open"));
    showContext();
    setTimeout(() => $(".eva-q", p)?.focus(), 250);
  }
  function closePanel() { const p = $(".eva-panel"); if (p) p.classList.remove("open"); }
  function panelKey(e) { if (e.key === "Escape" && !$(".modal") && $(".eva-panel.open")) closePanel(); }
  async function showContext() {
    const p = $(".eva-panel"), el = p && $(".ep-ctx", p);
    if (!el) return;
    const c = await customers().then(pageCustomer).catch(() => null);
    el.hidden = !c;
    if (c) el.innerHTML = `${ic("user")} This customer: <b>${esc(nameOf(c))}</b>${c.account_no ? ` <small class="mono">${esc(c.account_no)}</small>` : ""}`;
  }
  addEventListener("hashchange", () => { if ($(".eva-panel.open")) showContext(); });

  // ======================================================================
  // The box database: READ SHEET (Google Sheet, columns A to G) or a CSV file; the old rows are replaced
  // ======================================================================
  const NOT_SHARED = "The sheet could not be read. In Google Sheets press Share → General access → \"Anyone with the link\" (Viewer), then press Read Sheet again.";
  const sheetIdOf = (url) => (/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/.exec(url || "") || /^\s*([a-zA-Z0-9_-]{30,})\s*$/.exec(url || "") || [])[1] || "";
  const cellText = (c) => (c == null || c.v == null ? "" : typeof c.v === "number" ? String(Number.isInteger(c.v) ? c.v : +c.v.toFixed(4)) : String(c.v)).trim();
  // the rows of the sheet (JSONP: works from the browser without a key, for a sheet anyone with the link can view)
  function readSheet(url, tab) {
    const id = sheetIdOf(url);
    if (!id) return Promise.reject(new Error("This is not a Google Sheet link. Copy the link from the address bar of the sheet."));
    const cb = "__evaSheet" + Date.now();
    const gid = (/[#&?]gid=(\d+)/.exec(url) || [])[1];
    const qs = new URLSearchParams({ tqx: `out:json;responseHandler:${cb}`, headers: "0", tq: "select A, B, C, D, E, F, G" });
    if (tab) qs.set("sheet", tab); else if (gid) qs.set("gid", gid);
    return new Promise((ok, bad) => {
      const s = document.createElement("script");
      const done = (fn, v) => { clearTimeout(timer); try { delete window[cb]; } catch (_) { window[cb] = undefined; } s.remove(); fn(v); };
      const timer = setTimeout(() => done(bad, new Error(NOT_SHARED)), 25000);
      window[cb] = (resp) => {
        if (!resp || resp.status === "error") return done(bad, new Error((resp?.errors || []).map((x) => x.detailed_message || x.message).filter(Boolean).join(" ") || NOT_SHARED));
        done(ok, (resp.table?.rows || []).map((r) => (r.c || []).slice(0, 7).map(cellText)));
      };
      s.onerror = () => done(bad, new Error(NOT_SHARED));
      // a sheet not shared answers with Google's sign-in page, not with the rows: the answer is never called
      s.onload = () => setTimeout(() => { if (window[cb]) done(bad, new Error(NOT_SHARED)); }, 1500);
      s.src = `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?${qs}`;
      document.head.appendChild(s);
    });
  }
  // a CSV file (Google Sheets: File → Download → CSV): its columns A to G
  function readCsv(text) {
    const out = []; let row = [], cell = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
      else if (ch === '"') q = true;
      else if (ch === ",") { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); out.push(row); row = []; cell = ""; }
      else cell += ch;
    }
    if (cell || row.length) { row.push(cell); out.push(row); }
    return out.map((r) => r.slice(0, 7).map((x) => x.trim()));
  }
  // rows of A to G → boxes (a first row of titles, rows with no serial no and the same serial no twice are left out)
  function boxesOf(table_) {
    const list = table_.filter((r) => r[0] && /\d/.test(r[0]) && !/^serial/i.test(r[0]));
    return list.map((r) => ({ serial_no: r[0], product: r[1] || "", brand: r[2] || "", ctn: r[3] || "", style: r[4] || "", qty: (String(r[5] || "").match(/\d+(\.\d+)?/) || [""])[0], batch: r[6] || "" }));
  }
  async function saveBoxes(boxes, source) {
    if (!boxes.length) throw new Error("No boxes found: column A must have the serial no (for example U20261240).");
    const { data, error } = await sb.rpc("replace_box_stock", { p_rows: boxes, p_source: source });
    if (error) throw error;
    BOX = null;
    return data;
  }
  // the Box Database part of the EVA AI page
  async function boxSection(el) {
    const [set, read, cnt] = await Promise.all([sb.from("ai_settings").select("*").in("key", ["box_sheet", "box_sheet_read"]),
      sb.from("ai_settings").select("value").eq("key", "box_sheet_read").maybeSingle(), sb.from("box_stock").select("serial_no", { count: "exact", head: true })]);
    if (set.error || cnt.error) { const e = set.error || cnt.error; el.innerHTML = `<div class="empty">${/ai_settings|box_stock|schema cache|PGRST20/.test(e.message || "") ? "The box database needs the database update <b>RUN_048_TO_051.sql</b>. Run it in the Supabase SQL Editor." : esc(e.message)}</div>`; return; }
    const cfg = (set.data || []).find((x) => x.key === "box_sheet")?.value || {}, last = read.data?.value || null;
    el.innerHTML = `<p class="muted">EVA and the box scan read your boxes from the Google Sheet <b>DATABASE</b>, columns <b>A to G</b>: serial no, product, brand, CTN, style, qty, batch. Each <b>Read Sheet</b> brings the new rows and removes the old ones. A box scanned on a customer order fills its details from here.</p>
      <div class="fields wide eva-sheet"><label for="bsUrl">Google Sheet Link</label><input type="url" id="bsUrl" placeholder="https://docs.google.com/spreadsheets/d/…" value="${esc(cfg.url || "")}">
        <label for="bsTab">Sheet (tab) Name</label><input type="text" id="bsTab" maxlength="60" data-case="keep" value="${esc(cfg.tab || "DATABASE")}"></div>
      <div class="btnrow"><button type="button" class="btn primary" id="bsRead">${ic("download")} Read Sheet</button>
        <label class="btn" for="bsCsv">${ic("upload")} Read a CSV File</label><input type="file" id="bsCsv" accept=".csv,text/csv" hidden><span class="muted" id="bsStep"></span></div>
      <div class="tiles ai-tiles"><div class="tile"><span class="tile-ic">${ic("box")}</span><div class="k">Boxes in the Database</div><div class="v">${qtyText(cnt.count || 0)}</div><small>${last ? `read ${esc(E.dateTime(last.read_at))}` : "not read yet"}</small></div></div>
      <small class="muted">The sheet must be shared: Share → General access → "Anyone with the link" (Viewer). Or download it (File → Download → CSV) and press Read a CSV File.</small>`;
    const step = (t) => { if ($("#bsStep")) $("#bsStep").textContent = t; };
    const done = (n) => { toast(`${qtyText(n)} boxes read. The old box data was removed.`); boxSection(el); };
    $("#bsRead").onclick = async (e) => {
      const url = $("#bsUrl").value.trim(), tab = $("#bsTab").value.trim();
      if (!sheetIdOf(url)) return toast("Paste the link of your Google Sheet first.", true);
      e.target.disabled = true; step("Reading the sheet…");
      try {
        await sb.from("ai_settings").upsert({ key: "box_sheet", value: { url, tab }, updated_by_name: S.profile?.full_name || null, updated_at: new Date().toISOString() });
        const boxes = boxesOf(await readSheet(url, tab));
        step(`Saving ${qtyText(boxes.length)} boxes…`);
        done(await saveBoxes(boxes, `Google Sheet ${tab || ""}`.trim()));
      } catch (err) { e.target.disabled = false; step(""); fail(err, "Could not read the sheet"); }
    };
    $("#bsCsv").onchange = async (e) => {
      const f = e.target.files[0]; e.target.value = "";
      if (!f) return;
      step("Reading the file…");
      try { const boxes = boxesOf(readCsv(await f.text())); step(`Saving ${qtyText(boxes.length)} boxes…`); done(await saveBoxes(boxes, `CSV ${f.name}`)); }
      catch (err) { step(""); fail(err, "Could not read the file"); }
    };
  }

  E.eva = { open: openPanel, close: closePanel, mount, ask, answer, readQuestion, classify, boxSection, boxesOf, readCsv, sheetIdOf, reset: () => { LOG.length = 0; ctx.last = null; ctx.waiting = null; CUST = null; BOX = null; paint(); } };
})();
