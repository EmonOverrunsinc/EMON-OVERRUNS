/* EMON OVERRUNS E-PORTAL — EVA CHAT and the BOX DATABASE (3.39). For the Director only.
   EVA Chat: ask in simple words ("how much due this customer", "sales this month", "U20261240 what item?", "stock L-13")
   and EVA answers from the records on the server at that moment. It understands the question with a small artificial
   neural network (an intent classifier: the words of the question → 24 neurons → what is asked), trained in the browser on
   example questions; it finds the customer (name or account no), box (serial no), batch, order or invoice named, and the
   time asked about (today, this month, OCTOBER …); "this customer" is the customer of the page open, or the one asked
   about before.
   3.60: EVA knows every account of the portal too: billing companies and their bank accounts (vouchers, PHP and BDT sent),
   e-bills, payroll and employees, credit memos, lots (purchase orders), projects, what waits for the Director's approval and a
   business summary; any record number (receipt, voucher, payslip, lot, QC form …) opens its record, and words it does not
   understand are looked for in every record. The chat is kept on this device (until sign-out), with a time on each message,
   quick questions and New Chat.
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
    sale: "sale sales sold sell selling revenue income billed turnover benta bikri",
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
    batch: "batch batches",
    // 3.60: the other accounts of the portal
    emp: "employee employees staff worker workers empleyado karmachari",
    salary: "salary salaries wage wages sahod sweldo beton payroll payslip payslips",
    company: "company companies supplier suppliers party parties firm",
    voucher: "voucher vouchers billing remittance sent send transfer",
    bdt: "bdt taka tk bangladesh",
    ebill: "ebill ebills shipment shipments",
    lot: "lot lots purchase po",
    project: "project projects budget",
    memo: "memo memos return returns refund refunds replacement",
    approve: "approve approval approvals todo task tasks decide",
    summary: "summary overview report dashboard business situation",
    find: "find search look lookup"
  };
  const CONCEPT_OF = new Map();
  for (const [k, list] of Object.entries(CONCEPTS)) for (const w of list.split(" ")) CONCEPT_OF.set(w, k);
  // words that point to the customer already talked about
  const CTX = new Set(["he", "she", "his", "her", "him", "they", "them", "their", "this", "that", "same"]);

  // ======================================================================
  // What can be asked (the answers are below), with example questions for the network to learn from.
  // {c} a customer, {s} a box serial no, {b} a batch, {o} an order no, {i} an invoice no; 3.60: {p} a billing company or its
  // bank account, {m} an employee, {l} a lot (purchase order), {j} a project, {e} an e-bill no.
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
      "list customers with due", "customers with balance", "who have due", "due list", "top customers due", "most due customer", "which customers have balance", "top due", "due top 10"],
    overdue: ["overdue", "overdue customers", "who is late", "late payment customers", "overdue invoices", "who did not pay on time", "{c} overdue", "is {c} late",
      "overdue of {c}", "past due list", "which invoice overdue", "how much overdue", "late invoices", "delay payment list", "total overdue", "who is overdue"],
    last_payment: ["last payment {c}", "when {c} paid", "{c} last paid", "last pay of {c}", "when did {c} pay last", "latest payment {c}", "{c} last bayad",
      "last payment", "when last paid", "last payment received", "when he paid last", "last payment of this customer", "recent payment {c}", "kailan bayad ni {c}"],
    payments: ["collection today", "payments today", "how much received today", "payment this month", "how much collect this month", "total payment this month",
      "collection this week", "{c} payments", "payments of {c}", "how much {c} paid", "{c} total paid", "money received today", "deposits today", "bayad today",
      "collection yesterday", "payments last month", "how much collected", "collection", "total collection", "payment received october"],
    sales: ["sales this month", "sales today", "how much sales this week", "total invoice this month", "invoice total today", "how much sold this month",
      "revenue this month", "invoices this month", "total billed today", "sales report", "how much business this month", "benta today", "sales yesterday",
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
    thanks: ["thanks", "thank you", "salamat", "ok thanks", "thx", "ty", "great thanks", "good job", "thank you eva"],
    // 3.60: billing companies and their bank accounts, vouchers, e-bills, payroll, employees, credit memos, lots, projects, approvals, summary
    company: ["{p}", "about {p}", "{p} details", "{p} account", "{p} accounts", "{p} bank account", "account of {p}", "how much paid to {p}", "how much sent to {p}",
      "{p} vouchers", "vouchers of {p}", "{p} total paid", "{p} this month", "how much we paid {p} this month", "{p} last payment", "when did we pay {p}", "{p} ebill",
      "{p} ebills", "{p} balance", "{p} bdt", "{p} taka", "show {p}", "open {p}", "company {p}", "info {p}", "payments to {p}", "{p} payment", "{p} status",
      "total sent to {p}", "{p} voucher list"],
    billing: ["billing", "billing companies", "billing summary", "how much sent to bangladesh", "how much paid to companies this month", "total vouchers this month",
      "vouchers today", "voucher list", "payment vouchers", "how much bdt sent", "total taka sent this month", "companies list", "which company we paid most",
      "billing this month", "how much remittance this month", "last vouchers", "how many companies", "billing total", "vouchers this month", "sent this month",
      "how much we sent", "total billing", "bdt sent today"],
    ebills: ["ebill", "ebills", "ebill balance", "unpaid ebills", "ebill status", "how many ebills", "ebill list", "ebills not paid", "shipment status",
      "which ebill not paid", "ebill total", "ebill profit", "released ebills", "ebills this month", "{e}", "ebill {e}", "{e} status", "{e} paid", "is {e} paid",
      "{e} balance", "ebill of batch {b}", "{b} ebill", "shipments", "ebill summary", "profit of ebills", "ebills at ship", "this ebill"],
    payroll: ["payroll", "salary", "salary this month", "how much salary paid this month", "unpaid salary", "salary due", "how much salary to pay", "total salary",
      "salary not paid", "who is not paid salary", "payslips", "unpaid payslips", "salary report", "salary paid today", "sahod", "sweldo", "monthly salary total",
      "how much payroll", "staff salary", "employees salary", "salary paid last month", "salary summary", "how much salary we owe"],
    employee: ["{m}", "about {m}", "who is {m}", "{m} details", "{m} salary", "salary of {m}", "how much salary {m}", "{m} unpaid salary", "unpaid salary of {m}",
      "{m} payslip", "{m} last salary", "when {m} got salary", "{m} position", "employee {m}", "is {m} active", "{m} id card", "{m} sahod", "show {m}", "{m} profile",
      "how much we owe {m}", "salary of this employee", "this employee salary", "employee details", "his salary", "her salary"],
    employees: ["how many employees", "employees", "employee list", "staff list", "how many staff", "active employees", "total employees", "who are the employees",
      "list of staff", "how many workers", "employees count", "new employees", "terminated employees", "all employees", "staff"],
    memos: ["credit memos", "credit memo", "pending credit memos", "memos", "how many credit memos", "returns", "return of items", "memo list", "refunds",
      "credit memo this month", "memos waiting", "replacement requests", "credit memo total", "returns this month", "refund list"],
    purchase: ["purchase orders", "lots", "lot list", "pending lots", "{l}", "lot {l}", "{l} status", "{l} qty", "how many lots", "purchase order list",
      "lots this month", "approved lots", "lots waiting approval", "purchase this month", "{l} details", "about {l}", "{l} amount", "new lots", "purchase order {l}",
      "this lot", "lot details", "purchase summary"],
    projects: ["projects", "project list", "{j}", "project {j}", "{j} budget", "{j} paid", "{j} remaining", "how much paid for projects", "project budget",
      "how many projects", "projects remaining", "about {j}", "{j} status", "project cost", "open projects", "this project", "project details", "{j} details"],
    todo: ["what is waiting", "waiting for me", "what to approve", "pending approvals", "anything to approve", "what needs my approval", "approvals", "to do",
      "my tasks", "what is pending", "anything new", "notifications", "what should i do", "waiting for you", "pending work", "any request", "what do i need to approve"],
    summary: ["summary", "business summary", "how is business", "overview", "report", "today report", "business report", "how is the business this month",
      "dashboard", "give me summary", "all summary", "monthly report", "status report", "situation", "how are we doing", "full report", "summary this month",
      "summary today", "report this month", "everything"],
    search: ["find", "search", "search for", "look for", "find record", "where is", "find this", "search records", "find number", "find name", "search all",
      "look up", "lookup", "can you find"]
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
  // 3.60: what the network learned is kept on this device; it learns again when the portal or EVA's examples change
  const fnv = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
  const NET_KEY = "eoEvaNet:" + fnv(JSON.stringify([E.VERSION, EXAMPLES, CONCEPTS, D, H]));
  const b64 = (f) => { const u = new Uint8Array(f.buffer); let s = ""; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); return btoa(s); };
  const unb64 = (s) => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return new Float32Array(u.buffer); };
  function getNet() {
    if (NET) return NET;
    try {
      const m = JSON.parse(localStorage.getItem(NET_KEY) || "null");
      if (m && m.K === INTENTS.length) { NET = { K: m.K, W1: unb64(m.W1), b1: unb64(m.b1), W2: unb64(m.W2), b2: unb64(m.b2) }; return NET; }
    } catch (_) {}
    NET = trainNet();
    try {
      Object.keys(localStorage).filter((k) => k.startsWith("eoEvaNet:") && k !== NET_KEY).forEach((k) => localStorage.removeItem(k));
      localStorage.setItem(NET_KEY, JSON.stringify({ K: NET.K, W1: b64(NET.W1), b1: b64(NET.b1), W2: b64(NET.W2), b2: b64(NET.b2) }));
    } catch (_) {}
    return NET;
  }
  function classify(q) {
    const { p } = forwardNet(getNet(), featuresOf(q.words, q.flags));
    return INTENTS.map((k, i) => ({ k, p: p[i] })).sort((a, b) => b.p - a.p);
  }

  // ======================================================================
  // Reading a question: the codes in it (record numbers, order, invoice, box serial, account, batch), the account named (a
  // customer; 3.60: an employee, a billing company or its bank account, a lot, a project), the time asked about, then the
  // words for the network
  // ======================================================================
  const RE = {
    // 3.60: the other record numbers: receipt, voucher, credit memo, collection voucher, payslip, salary and project payment, project,
    // lot, QC form, order letter, employee, customer application, ID card, released notice, statement, contact message, correction
    doc: /\b(?:A-\d{4}-\d{4}-?\d{1,5}|BD\d{11,14}|EOC-\d{8,12}|CV-\d{6}-\d{1,5}|PS-\d{6}-\d{1,5}|SP-\d{6}-\d{1,5}|PP-\d{6}-\d{1,5}|PRJ-\d{4}-\d{1,5}|LOT-\d{6}-\d{1,5}|QC-\d{4}-\d{1,5}|EO-\d{4}-\d{2}-\d{1,5}|ORDER-\d{4}-\d{1,5}|EO-\d{8}|EO-\d{4}-\d{5}|EOID-\d{4}-\d{1,5}|RN-\d{6}-\d{1,5}|SOA-\d{6}-[A-Z]{1,4}-\d{6,10}|MS-\d{12,14}|CR-\d{4}-\d{1,5})\b/gi,
    ebill: /\b(?!QC-|CR-)[A-Z]{2}-20\d\d-\d{4}\b/gi, // an e-bill: the company's initials, the year and its number (MF-2026-0001)
    order: /\b(?:OR|CO)-\d{6}-\d{1,6}\b/gi, invoice: /\bINV-\d{6}-\d{1,6}\b/gi, account: /\b[A-Z]{1,4}-\d{6,10}\b/gi, serial: /\b[A-Z]{1,2}\d{6,9}\b/gi, batch: /\b[A-Z]{1,3}-\d{1,3}\b/gi
  };
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
  // 3.60: the other accounts, for their names (each read only when the login may open it; kept for 20 seconds)
  let ENTS = null;
  const toksOf = (s) => [...new Set(norm(s).split(" ").filter((w) => w.length >= 2))];
  async function entities() {
    if (ENTS && Date.now() - ENTS.at < 20000) return ENTS;
    const none = Promise.resolve([]);
    const read = (mod, make) => (E.hasModule(mod) ? E.allRows(make).then((r) => (r.error ? [] : r.data || []), () => []) : none);
    const [customer, employee, company, account, lot, project] = await Promise.all([customers().catch(() => []),
      read("employees", () => sb.from("employees").select("id, employee_no, first_name, last_name, position, status, approval_status, monthly_salary, date_hired").order("id")),
      read("billing", () => sb.from("pay_companies").select("id, name, country, status").order("id")),
      read("billing", () => sb.from("pay_accounts").select("id, company_id, account_name, account_number, bank_name").order("id")),
      read("purchase", () => sb.from("purchase_orders").select("id, po_no, lot_name, status").order("id")),
      read("projects", () => sb.from("projects").select("id, project_no, title, status").order("id"))]);
    const add = (list, text) => list.map((x) => ({ ...x, toks: toksOf(text(x)) }));
    ENTS = { at: Date.now(), customer, employee: add(employee, (x) => `${x.first_name} ${x.last_name}`), company: add(company, (x) => x.name),
      account: add(account, (x) => x.account_name), lot: add(lot, (x) => x.lot_name), project: add(project, (x) => x.title) };
    return ENTS;
  }
  // the kinds of accounts EVA knows by name; hint: words that point to the kind when a name fits two kinds
  const KINDS = {
    customer: { label: "customer", flag: "cust", hint: ["due", "balance", "utang", "invoice", "invoices", "order", "orders", "gate", "limit", "customer", "overdue"] },
    employee: { label: "employee", flag: "emp", hint: ["salary", "payslip", "sahod", "sweldo", "employee", "staff", "position", "card"] },
    company: { label: "billing company", flag: "party", hint: ["company", "voucher", "vouchers", "bdt", "taka", "sent", "billing", "ebill", "ebills", "supplier"] },
    account: { label: "bank account", flag: "party", hint: ["bank", "voucher", "vouchers", "sent"] },
    lot: { label: "lot", flag: "lot", hint: ["lot", "lots", "purchase", "po"] },
    project: { label: "project", flag: "proj", hint: ["project", "projects", "budget"] },
    ebill: { label: "e-bill", flag: "ebill", hint: [] }
  };
  // a lot or a project is named by words like "zara" or "warehouse": it counts only with its word (lot, project …) or alone
  const BARE = new Set(["about", "show", "open", "details", "detail", "info", "status", "what", "is", "the", "of", "who", "tell", "me"]);
  // the accounts of a list a question names: by account no (customers), or by the words of the name (written a little wrong too)
  function namedIn(words, list, accounts = []) {
    for (const a of accounts) { const c = list.find((x) => String(x.account_no || "").toUpperCase() === a); if (c) return { list: [c], used: [], score: 9 }; }
    const cand = words.filter((w) => w.length >= 2 && !CTX.has(w) && !/^\d+$/.test(w));
    if (!cand.length) return { list: [], used: [], score: 0 };
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
    if (!scored.length) return { list: [], used: [], score: 0 };
    const same = scored.filter((x) => scored[0].score - x.score < 0.15);
    return { list: same.slice(0, 6).map((x) => x.c), used: scored[0].used, score: scored[0].score };
  }
  const PH = { c: "cust", s: "serial", b: "batch", o: "order", i: "invoice", p: "party", m: "emp", l: "lot", j: "proj", e: "ebill" };
  // q: { text, words, rest, flags, codes, period, named: { list, used }, kind }. ents: entities(), or a list of customers.
  // kind: the kind of account named; "mixed" when the name fits accounts of two kinds (each then has its _kind)
  function readQuestion(text, ents, training = false) {
    let raw = String(text || "").replace(/\b(?:e|stock)[\s-]?bill(s?)\b/gi, " ebill$1 ");
    const codes = { doc: [], ebill: [], order: [], invoice: [], account: [], serial: [], batch: [] }, flags = new Set();
    if (training) raw = raw.replace(/\{(\w)\}/g, (_, k) => { flags.add(PH[k]); return " "; });
    else for (const k of Object.keys(codes)) raw = raw.replace(RE[k], (x) => { codes[k].push(x.toUpperCase()); flags.add(k === "account" ? "cust" : k); return " "; });
    const t = norm(raw);
    let words = t ? t.split(" ") : [];
    const period = periodOf(t);
    if (period) flags.add("period");
    // "this customer", "his due" …: the account talked about ("this month", "this week" … are a time, not an account)
    if (t.replace(/\b(?:this|that|same) (?:month|week|year|day)\b/g, " ").split(" ").some((w) => CTX.has(w))) flags.add("ctx");
    let named = { list: [], used: [] }, kind = null;
    if (!training && ents) {
      const all = Array.isArray(ents) ? { customer: ents } : ents, fixed = words.map(fixWord);
      let cands = [];
      for (const k of Object.keys(KINDS)) {
        if (!all[k]?.length) continue;
        const r = namedIn(words, all[k], k === "customer" ? codes.account : []);
        if (!r.list.length) continue;
        const hint = KINDS[k].hint.some((h) => fixed.includes(h));
        if ((k === "lot" || k === "project") && !hint && !words.every((w) => r.used.includes(w) || BARE.has(w))) continue;
        cands.push({ k, r, s: r.score + (hint ? 1 : 0) });
      }
      // a bank account named like its own company: the company (its answer shows the account too)
      const cos = cands.find((c) => c.k === "company");
      if (cos) cands = cands.filter((c) => c.k !== "account" || !c.r.list.every((a) => cos.r.list.some((co) => co.id === a.company_id)));
      cands.sort((a, b) => b.s - a.s);
      const top = cands.filter((c) => cands[0].s - c.s < 0.15);
      if (top.length === 1) { named = top[0].r; kind = top[0].k; }
      else if (top.length > 1) { kind = "mixed"; named = { list: top.flatMap((c) => c.r.list.map((x) => ({ ...x, _kind: c.k }))), used: [...new Set(top.flatMap((c) => c.r.used))] }; }
      if (kind) { flags.add(KINDS[top[0].k].flag); words = words.filter((w) => !named.used.includes(w)); }
    }
    return { text: String(text || ""), words: words.map(fixWord), rest: words, flags: [...flags], codes, period, named, kind };
  }

  // ======================================================================
  // The answers (each reads the server now). An answer: { html, chips: [[label, question]], cust }
  // ======================================================================
  const money = (v) => `₱ ${peso(v)}`;
  const nameOf = (c) => fullName(c || {}).toUpperCase();
  const custLink = (c) => `<a href="#customer/${esc(c.id)}">${esc(nameOf(c))}</a>${c.account_no ? ` <small class="mono">${esc(c.account_no)}</small>` : ""}`;
  const daysBetween = (a, b) => Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 864e5);
  const isOver = (i) => i.pay_status !== "paid" && num(i.balance) > 0.004 && i.due_date && i.due_date < isoToday();
  const NUM_COL = /₱|Boxes|Pcs|Days|#|BDT|PHP|Qty|Vouchers/;
  const table = (head, rows) => `<table class="eva-t"><thead><tr>${head.map((h) => `<th${NUM_COL.test(h) ? ' class="num"' : ""}>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((v, i) => `<td${NUM_COL.test(head[i]) ? ' class="num"' : ""}>${v}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  const ORDER_ST = { pending: "CREATE ORDER (waits for your approval)", approved: "PREPARED (ready to deliver)", completed: "COMPLETE (delivered)", cancelled: "CANCELLED" };
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
    const sel = "id, order_no, status, order_date, total_boxes, total_pcs, total_amount, invoice_id, customer_id, customers(id, first_name, last_name, account_no)";
    if (no) {
      const o = await one(sb.from("customer_orders").select(sel).in("order_no", [no, no.replace(/^CO-/, "OR-"), no.replace(/^OR-/, "CO-")]).limit(1).maybeSingle());
      if (!o) return { html: `Order ${esc(no)} is not found.` };
      const inv = o.invoice_id ? await one(sb.from("customer_invoices").select("id, invoice_no").eq("id", o.invoice_id).maybeSingle()) : null;
      return { cust: o.customers, html: `Order <a href="#custorder/${esc(o.id)}"><b>${esc(o.order_no)}</b></a> of ${o.customers ? custLink(o.customers) : ""}: <b>${esc(ORDER_ST[o.status] || o.status)}</b>
        <br>${esc(mdy(o.order_date))} · ${qtyText(o.total_boxes)} box${num(o.total_boxes) === 1 ? "" : "es"} · ${qtyText(o.total_pcs)} pcs · ${money(o.total_amount)}${inv ? `<br>Invoice <a href="#invoice/${esc(inv.id)}">${esc(inv.invoice_no)}</a> (made and billed)` : ""}` };
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

  // ---------- 3.60: the other accounts (each answer reads the server now; a login without that menu is told so) ----------
  const noAccess = (what) => ({ html: `You have no access to <b>${esc(what)}</b>. Ask the Director to tick it in your Menu Access.` });
  const bdtM = (v) => `BDT ${peso(v)}`;
  const sumOf = (list, k) => list.reduce((s, x) => s + num(x[k]), 0);
  const inPeriod = (d, p) => !!d && String(d).slice(0, 10) >= p.from && String(d).slice(0, 10) <= p.to;
  const plural = (n, one, many = one + "s") => `${qtyText(n)} ${n === 1 ? one : many}`;
  const during = (p) => `${p.label === "today" || p.label === "yesterday" ? "" : "in "}${esc(p.label)}`;
  const vAmt = (v) => [v.amount_php != null ? money(v.amount_php) : "", v.amount_bdt != null ? bdtM(v.amount_bdt) : ""].filter(Boolean).join(" = ");
  const empLink = (m) => `<a href="#employee/${esc(m.id)}">${esc(fullName(m).toUpperCase())}</a>${m.employee_no ? ` <small class="mono">${esc(m.employee_no)}</small>` : ""}`;
  const coLink = (c) => `<a href="#paycompany/${esc(c.id)}">${esc(String(c.name || "").toUpperCase())}</a>`;
  const ebLink = (b) => `<a href="#stockbill/${esc(b.id)}">${esc(b.bill_no)}</a>`;
  const poLink = (p) => `<a href="#po/${esc(p.id)}">${esc(p.po_no)}</a>`;
  const prjLink = (p) => `<a href="#project/${esc(p.id)}">${esc(p.project_no || p.title)}</a>`;
  const EMP_ST = { active: "ACTIVE", waiting: "WAITING SIGN-UP", inactive: "INACTIVE", suspended: "SUSPENDED", terminated: "TERMINATED" };
  const SLIP_ST = { paid: "PAID", partial: "PART PAID", unpaid: "UNPAID" };
  const EB_ST = { shipped: "SHIP", arrived: "SHIP", released: "RELEASED", sold: "SALES", paid: "PAID" };
  const PO_ST = { pending: "WAITING FOR REVIEW", negotiation: "NEGOTIATION", approved: "APPROVED", cancelled: "CANCELLED" };
  const PRJ_ST = { pending: "WAITING FOR APPROVAL", approved: "APPROVED", rejected: "NOT APPROVED", completed: "COMPLETED" };
  const MEMO_ST = { pending: "WAITING FOR APPROVAL", approved: "APPROVED", paid: "SETTLED", rejected: "NOT APPROVED" };

  // an employee: salary, unpaid salary, this month's payslip, the last salary paid
  async function aEmployee(m) {
    const [bal, pays] = await Promise.all([
      E.readPay(sb.from("payslip_balances").select("id, payslip_no, pay_type, period_month, pay_date, net_pay, paid, balance, status, issued_at").eq("employee_id", m.id).order("pay_date", { ascending: false })),
      E.readPay(sb.from("salary_payments").select("amount, pay_date").eq("employee_id", m.id).order("pay_date", { ascending: false }).limit(1))]);
    const open = bal.rows.filter((s) => num(s.balance) > 0.004), month = isoToday().slice(0, 7) + "-01";
    const slip = bal.rows.find((s) => s.pay_type === "salary" && String(s.period_month).slice(0, 10) === month);
    const legacy = bal.rows.find((s) => !s.issued_at); // a payslip from before 3.55 was paid when it was made
    const last = [pays.rows[0], legacy && { amount: legacy.net_pay, pay_date: legacy.pay_date }].filter(Boolean).sort((a, b) => String(b.pay_date).localeCompare(String(a.pay_date)))[0];
    return { ent: { kind: "employee", item: m }, html: `${empLink(m)}${m.position ? ` · ${esc(m.position)}` : ""} · <b>${esc(m.approval_status === "pending" ? "WAITING FOR APPROVAL" : EMP_ST[m.status] || String(m.status || "").toUpperCase())}</b>
      <br>Monthly salary ${money(m.monthly_salary)}${m.date_hired ? ` · hired ${esc(mdy(m.date_hired))}` : ""}
      ${bal.missing ? "" : `<br>Unpaid salary: <b class="eva-amt">${money(sumOf(open, "balance"))}</b>${open.length ? ` on ${open.map((s) => `<a href="#payslip/${esc(s.id)}">${esc(s.payslip_no)}</a>`).join(", ")}` : " · nothing unpaid"}
      <br>${slip ? `Salary payslip of ${esc(E.monthText(month))}: <a href="#payslip/${esc(slip.id)}">${esc(slip.payslip_no)}</a> ${money(slip.net_pay)} · <b>${SLIP_ST[slip.status] || ""}</b>` : `No salary payslip for ${esc(E.monthText(month))} yet.`}
      <br>${last ? `Last salary paid: ${money(last.amount)} on ${esc(mdy(last.pay_date))}` : "No salary paid yet."}`}`,
      chips: [["Payroll", "payroll"], ["Unpaid salary (all)", "unpaid salary"], ["All employees", "how many employees"]] };
  }
  // payroll: salary paid in the time asked (this month), the unpaid salary by employee, who has this month's payslip
  async function aPayroll(period) {
    if (!E.hasModule("employees")) return noAccess("Payroll");
    const p = period || monthPeriod();
    const [bal, pays, made, ents] = await Promise.all([
      E.readPay(sb.from("payslip_balances").select("id, employee_id, pay_type, period_month, balance")),
      E.readPay(sb.from("salary_payments").select("amount").gte("pay_date", p.from).lte("pay_date", p.to)),
      E.readPay(sb.from("payslips").select("net_pay, issued_at").is("issued_at", null).gte("pay_date", p.from).lte("pay_date", p.to)), entities()]);
    if (bal.missing) return { html: `Payroll needs the database update <b>063_payroll_pay_salary.sql</b>. Run it in the Supabase SQL Editor.` };
    const byId = new Map(ents.employee.map((e) => [e.id, e])), owe = new Map();
    for (const b of bal.rows) if (num(b.balance) > 0.004) owe.set(b.employee_id, (owe.get(b.employee_id) || 0) + num(b.balance));
    const top = [...owe.entries()].sort((a, b) => b[1] - a[1]), month = isoToday().slice(0, 7) + "-01";
    const staff = ents.employee.filter((e) => e.status !== "terminated" && e.approval_status !== "pending");
    const withSlip = new Set(bal.rows.filter((s) => s.pay_type === "salary" && String(s.period_month).slice(0, 10) === month).map((s) => s.employee_id));
    return { html: `Salary paid ${during(p)}: <b class="eva-amt">${money(sumOf(pays.rows, "amount") + sumOf(made.rows, "net_pay"))}</b> (${plural(pays.rows.length + made.rows.length, "payment")}).
      <br>Unpaid salary (payslips issued, not paid yet): <b class="eva-amt">${money(top.reduce((s, [, v]) => s + v, 0))}</b>${top.length ? ` · ${plural(top.length, "employee")}` : " · nothing unpaid"}
      ${top.length ? table(["Employee", "Unpaid ₱"], top.slice(0, 10).map(([id, v]) => [byId.get(id) ? empLink(byId.get(id)) : "", peso(v)])) : ""}
      ${staff.length ? `<br>Salary payslips of ${esc(E.monthText(month))}: <b>${staff.filter((e) => withSlip.has(e.id)).length} of ${staff.length}</b> employees · monthly salaries ${money(sumOf(staff, "monthly_salary"))}` : ""}`,
      chips: [["All employees", "how many employees"], ["Salary last month", "salary paid last month"]] };
  }
  async function aEmployees() {
    if (!E.hasModule("employees")) return noAccess("Employees");
    const list = (await entities()).employee;
    if (!list.length) return { html: "No employee yet." };
    const by = (s) => list.filter((e) => e.status === s).length, pend = list.filter((e) => e.approval_status === "pending").length;
    // working: not terminated or inactive, and approved (an employee waiting to sign up works and is paid too)
    const work = list.filter((e) => !["terminated", "inactive"].includes(e.status) && e.approval_status !== "pending").sort((a, b) => String(a.employee_no).localeCompare(String(b.employee_no)));
    const parts = [[by("active"), "active"], [by("waiting"), "waiting to sign up"], [by("suspended"), "suspended"], [by("inactive"), "inactive"], [by("terminated"), "terminated"]].filter(([n]) => n);
    return { html: `<b>${list.length}</b> employee${list.length === 1 ? "" : "s"}: ${parts.map(([n, l]) => `${n} ${l}`).join(", ")}${pend ? ` · <b>${pend} waiting for your approval</b>` : ""}.
      <br>Monthly salaries of the working employees: ${money(sumOf(work, "monthly_salary"))}
      ${work.length ? table(["Employee", "Position", "Salary ₱"], work.slice(0, 12).map((e) => [empLink(e), esc(e.position || ""), peso(e.monthly_salary)])) : ""}`,
      chips: [["Payroll", "payroll"], ["Unpaid salary", "unpaid salary"]] };
  }
  // a billing company (or one of its bank accounts): paid in all and in the time asked, its accounts, e-bills, last vouchers
  async function aCompany(c, acct, period) {
    const [t, accts, vs, bills] = await Promise.all([
      one(sb.from("pay_company_totals").select("*").eq("id", c.id).maybeSingle()),
      rows(() => sb.from("pay_accounts").select("id, account_name, account_number, bank_name").eq("company_id", c.id).order("id")),
      rows(() => sb.from("pay_vouchers").select("id, voucher_no, pay_date, amount_php, amount_bdt, account_id").eq("company_id", c.id).order("id")),
      E.hasModule("inventory") || E.hasModule("billing") ? rows(() => sb.from("stock_bill_totals").select("id, bill_no, status, balance_bdt").eq("company_id", c.id).order("id")).catch(() => []) : []]);
    const p = period || monthPeriod(), inP = vs.filter((v) => inPeriod(v.pay_date, p)), onA = acct ? vs.filter((v) => v.account_id === acct.id) : [];
    const last = vs.slice().sort((a, b) => String(b.pay_date).localeCompare(String(a.pay_date)) || String(b.voucher_no).localeCompare(String(a.voucher_no))).slice(0, 3);
    const open = bills.filter((b) => b.status !== "paid");
    return { ent: { kind: "company", item: c }, html: `${coLink(c)}${c.country ? ` · ${esc(c.country)}` : ""}${c.status && c.status !== "active" ? ` · <b>${esc(String(c.status).toUpperCase())}</b>` : ""}
      <br>Paid in all: <b class="eva-amt">${money(t?.total_php)}</b> = ${bdtM(t?.total_bdt)} on ${plural(vs.length, "voucher")}${t?.last_paid ? ` · last paid ${esc(mdy(t.last_paid))}` : ""}
      <br>Paid ${during(p)}: ${money(sumOf(inP, "amount_php"))} = ${bdtM(sumOf(inP, "amount_bdt"))} (${plural(inP.length, "voucher")})
      ${acct ? `<br>Account <b>${esc(acct.account_name)}</b>${acct.bank_name ? ` · ${esc(acct.bank_name)}` : ""}${acct.account_number ? ` <span class="mono">${esc(acct.account_number)}</span>` : ""}: ${money(sumOf(onA, "amount_php"))} = ${bdtM(sumOf(onA, "amount_bdt"))} on ${plural(onA.length, "voucher")}` : ""}
      ${bills.length ? `<br>E-Bills: ${bills.length}${open.length ? ` · <b>${open.length} not paid, balance ${bdtM(sumOf(open, "balance_bdt"))}</b>` : " · all paid"}` : ""}
      ${accts.length ? table(["Bank Account", "Bank", "Account No"], accts.slice(0, 8).map((a) => [esc(a.account_name), esc(a.bank_name || ""), `<span class="mono">${esc(a.account_number || "")}</span>`])) : ""}
      ${last.length ? table(["Last Voucher", "Date", "PHP", "BDT"], last.map((v) => [`<a href="#voucher/${esc(v.id)}">${esc(v.voucher_no)}</a>`, esc(mdy(v.pay_date)), v.amount_php == null ? "—" : peso(v.amount_php), v.amount_bdt == null ? "—" : peso(v.amount_bdt)])) : ""}`,
      chips: [["Billing this month", "billing this month"], ["E-Bills", "ebill balance"]] };
  }
  // billing: the vouchers of the time asked (this month) by company, and everything sent
  async function aBilling(period) {
    if (!E.hasModule("billing")) return noAccess("Billing");
    const p = period || monthPeriod();
    const [cos, vs] = await Promise.all([rows(() => sb.from("pay_company_totals").select("id, name, total_php, total_bdt").order("id")),
      rows(() => sb.from("pay_vouchers").select("company_id, amount_php, amount_bdt").gte("pay_date", p.from).lte("pay_date", p.to).order("id"))]);
    if (!cos.length) return { html: `No billing company yet. Add one in <a href="#billing">Billing</a>.` };
    const g = new Map();
    for (const v of vs) { const x = g.get(v.company_id) || { n: 0, php: 0, bdt: 0 }; x.n++; x.php += num(v.amount_php); x.bdt += num(v.amount_bdt); g.set(v.company_id, x); }
    const byId = new Map(cos.map((c) => [c.id, c])), top = [...g.entries()].sort((a, b) => b[1].bdt - a[1].bdt || b[1].php - a[1].php);
    return { html: `Billing ${during(p)}: <b class="eva-amt">${money(sumOf(vs, "amount_php"))}</b> = ${bdtM(sumOf(vs, "amount_bdt"))} on ${plural(vs.length, "voucher")} to ${plural(g.size, "company", "companies")}.
      ${top.length ? table(["Company", "Vouchers", "PHP", "BDT"], top.slice(0, 10).map(([id, x]) => [byId.get(id) ? coLink(byId.get(id)) : "", String(x.n), peso(x.php), peso(x.bdt)])) : ""}
      <br>All time: ${money(sumOf(cos, "total_php"))} = ${bdtM(sumOf(cos, "total_bdt"))} · ${plural(cos.length, "billing company", "billing companies")}`,
      chips: [["Billing last month", "billing last month"], ["E-Bills", "ebill balance"]] };
  }
  // e-bills: one (its no, its Released Notice no, its batch or the e-bill page open) or all of them
  const ebillCard = (b) => `E-Bill <b>${ebLink(b)}</b> · ${esc(b.company_name || "")}${b.batch_no ? ` · batch ${esc(b.batch_no)}` : ""} · <b>${esc(EB_ST[b.status] || String(b.status || "").toUpperCase())}</b>
    <br>${esc(mdy(b.bill_date))}${b.total_boxes ? ` · ${plural(b.total_boxes, "box", "boxes")}` : ""} · bill total ${bdtM(b.bill_total)} · paid ${bdtM(b.paid_bdt)} · balance <b class="eva-amt">${bdtM(b.balance_bdt)}</b>${b.profit != null ? ` · profit ${bdtM(b.profit)}` : ""}
    ${b.release_order_no ? `<br>Released Notice ${esc(b.release_order_no)}${b.release_date ? ` · ${esc(mdy(b.release_date))}` : ""}` : ""}`;
  async function aEbills(q, page = null) {
    if (!E.hasModule("inventory") && !E.hasModule("billing")) return noAccess("E-Bill");
    const no = q.codes.ebill[0] || q.codes.doc.find((d) => /^RN-/.test(d)), batch = q.codes.batch[0];
    if (no || batch || page) {
      const list = await rows(() => { const x = sb.from("stock_bill_totals").select("*"); return (page ? x.eq("id", page.id) : no ? x.or(`bill_no.eq.${no},release_order_no.eq.${no}`) : x.ilike("batch_no", batch)).order("id"); });
      if (!list.length) return { html: no ? `E-Bill ${esc(no)} is not found.` : `No e-bill of batch ${esc(batch)}.` };
      return { html: list.slice(0, 4).map(ebillCard).join(`<hr class="eva-hr">`) };
    }
    const all = await rows(() => sb.from("stock_bill_totals").select("id, bill_no, company_name, batch_no, status, balance_bdt, profit").order("id"));
    if (!all.length) return { html: "No e-bill yet." };
    const open = all.filter((b) => b.status !== "paid").sort((a, b) => num(b.balance_bdt) - num(a.balance_bdt)), withProfit = all.filter((b) => b.profit != null);
    return { html: `<b>${all.length}</b> e-bill${all.length === 1 ? "" : "s"}: ${["SHIP", "RELEASED", "SALES", "PAID"].map((s) => `${all.filter((b) => EB_ST[b.status] === s).length} ${s}`).join(" · ")}.
      <br>Not paid yet: <b class="eva-amt">${bdtM(sumOf(open, "balance_bdt"))}</b> on ${plural(open.length, "e-bill")}${withProfit.length ? ` · net profit of the paid e-bills ${bdtM(sumOf(withProfit, "profit"))}` : ""}
      ${open.length ? table(["E-Bill", "Company", "Batch", "Status", "Balance BDT"], open.slice(0, 10).map((b) => [ebLink(b), esc(b.company_name || ""), esc(b.batch_no || ""), esc(EB_ST[b.status] || b.status), peso(b.balance_bdt)])) : ""}`,
      chips: [["Billing this month", "billing this month"]] };
  }
  // lots (purchase orders): one, or what waits for review and what was approved in the time asked (this month)
  async function aPurchase(lot, period) {
    if (!E.hasModule("purchase")) return noAccess("Purchase Order");
    if (lot) {
      const p = await one(sb.from("purchase_orders").select("id, po_no, lot_name, po_date, status, total_qty, total_amount, approved_by_name, arrived_at, pending_update").eq("id", lot.id).maybeSingle());
      if (!p) return { html: "That purchase order is not found." };
      return { ent: { kind: "lot", item: lot }, html: `Purchase order <b>${poLink(p)}</b> · lot <b>${esc(p.lot_name)}</b> · <b>${esc(PO_ST[p.status] || p.status)}</b>${p.pending_update ? " · an UPDATE waits for your review" : ""}
        <br>${esc(mdy(p.po_date))} · ${qtyText(p.total_qty)} pcs · ${bdtM(p.total_amount)} · average ${bdtM(num(p.total_qty) ? num(p.total_amount) / num(p.total_qty) : 0)} a pc${p.arrived_at ? ` · ARRIVED ${esc(mdy(p.arrived_at))}` : ""}${p.approved_by_name ? `<br>Approved by ${esc(p.approved_by_name)}` : ""}` };
    }
    const list = await rows(() => sb.from("purchase_orders").select("id, po_no, lot_name, po_date, status, total_qty, total_amount, pending_update").order("po_date", { ascending: false }).order("id"));
    if (!list.length) return { html: `No purchase order yet. <a href="#newpurchase">New Purchase Order</a>` };
    const p = period || monthPeriod(), wait = list.filter((x) => ["pending", "negotiation"].includes(x.status) || x.pending_update);
    const appr = list.filter((x) => x.status === "approved" && inPeriod(x.po_date, p));
    const row = (x) => [poLink(x), esc(x.lot_name), esc(x.pending_update ? "UPDATE" : PO_ST[x.status] || x.status), qtyText(x.total_qty), peso(x.total_amount)];
    return { html: `${plural(list.length, "purchase order")} (lots) · waiting for review: <b>${wait.length}</b>
      <br>Approved ${during(p)}: ${plural(appr.length, "lot")} · ${qtyText(sumOf(appr, "total_qty"))} pcs · ${bdtM(sumOf(appr, "total_amount"))}
      ${table(["Lot No", "Lot", "Status", "Qty", "BDT"], (wait.length ? wait : appr.length ? appr : list).slice(0, 10).map(row))}` };
  }
  // projects: one (budget, paid, remaining) or all of them
  async function aProjects(prj) {
    if (!E.hasModule("projects")) return noAccess("Project");
    if (prj) {
      const p = await one(sb.from("project_balances").select("*").eq("id", prj.id).maybeSingle());
      if (!p) return { html: "That project is not found." };
      return { ent: { kind: "project", item: prj }, html: `Project <b>${prjLink(p)}</b> · <b>${esc(String(p.title || "").toUpperCase())}</b> · ${esc(PRJ_ST[p.status] || p.status)}
        <br>Budget ${money(p.total_cost)} · paid ${money(p.total_paid)} · remaining <b class="eva-amt">${money(p.remaining)}</b>${p.location ? `<br>${esc(p.location)}` : ""}${p.start_date ? ` · ${esc(mdy(p.start_date))}${p.end_date ? ` to ${esc(mdy(p.end_date))}` : ""}` : ""}` };
    }
    const list = await rows(() => sb.from("project_balances").select("id, project_no, title, status, total_cost, total_paid, remaining").order("id"));
    if (!list.length) return { html: "No project yet." };
    const open = list.filter((p) => ["pending", "approved"].includes(p.status));
    return { html: `${plural(list.length, "project")} (${open.length} open): budget ${money(sumOf(list, "total_cost"))} · paid ${money(sumOf(list, "total_paid"))} · remaining on the open ones <b class="eva-amt">${money(sumOf(open, "remaining"))}</b>
      ${table(["Project", "Title", "Status", "Remaining ₱"], (open.length ? open : list).slice(0, 10).map((p) => [prjLink(p), esc(p.title), esc(PRJ_ST[p.status] || p.status), peso(p.remaining)]))}` };
  }
  async function aMemos(period, c = null) {
    if (!E.hasModule("creditmemos")) return noAccess("Credit Memo");
    const list = await rows(() => { const x = sb.from("credit_memos").select("id, memo_no, memo_date, status, request_amount, customers(id, first_name, last_name, account_no)"); return (c ? x.eq("customer_id", c.id) : x).order("memo_date", { ascending: false }).order("id"); });
    if (!list.length) return { cust: c || undefined, html: c ? `${custLink(c)} has no credit memo.` : "No credit memo yet." };
    const by = (s) => list.filter((m) => m.status === s), pend = by("pending"), inP = period ? list.filter((m) => inPeriod(m.memo_date, period)) : null;
    return { cust: c || undefined, html: `${c ? `${custLink(c)} — ` : ""}${plural(list.length, "credit memo")}: <b>${pend.length} waiting for approval</b>${pend.length ? ` (${money(sumOf(pend, "request_amount"))})` : ""} · ${by("approved").length} approved · ${by("paid").length} settled · ${by("rejected").length} not approved
      ${inP ? `<br>In ${esc(period.label)}: ${plural(inP.length, "credit memo")} · ${money(sumOf(inP, "request_amount"))}` : ""}
      ${table([pend.length ? "Waiting" : "Latest", "Customer", "Status", "Amount ₱"], (pend.length ? pend : list).slice(0, 8).map((m) => [`<a href="#creditmemo/${esc(m.id)}">${esc(m.memo_no)}</a>`, m.customers ? custLink(m.customers) : "", esc(MEMO_ST[m.status] || m.status), peso(m.request_amount)]))}` };
  }
  // what waits for the Director (the same list as the dashboard's Waiting for you)
  async function aTodo() {
    const items = E.todoItems ? await E.todoItems() : [];
    if (!items.length) return { html: "Nothing is waiting for you now. 👍", chips: [["Business summary", "business summary"]] };
    return { html: `Waiting for you: <b class="eva-amt">${items.reduce((s, [n]) => s + n, 0)}</b><ul class="eva-todo">${items.map(([n, label, href]) => `<li><a href="${esc(href)}"><b>${n}</b> ${esc(label)}${n === 1 ? "" : "s"}</a></li>`).join("")}</ul>` };
  }
  // the business at a glance: sales, payments and billing of the time asked (this month); the rest as it is now
  async function aSummary(period) {
    const p = period || monthPeriod(), H = E.hasModule, skip = Promise.resolve(null), safe = (x) => Promise.resolve().then(x).catch(() => null);
    const [sales, coll, bal, over, ords, todo, eb, bill, sal, lots] = await Promise.all([
      H("invoices") ? safe(() => sumIn("customer_invoices", "invoice_date", "total_amount", p)) : skip,
      H("payments") || H("invoices") ? safe(() => sumIn("payments_received", "paid_date", "amount", p)) : skip,
      H("customers") ? safe(balances) : skip,
      H("invoices") ? safe(() => rows(() => sb.from("invoice_balances").select("id, balance").neq("pay_status", "paid").gt("balance", 0).lt("due_date", isoToday()).order("id"))) : skip,
      H("customers") || H("eooffice") ? safe(() => rows(() => sb.from("customer_orders").select("id, status").in("status", ["pending", "approved"]).order("id"))) : skip,
      E.todoItems ? safe(E.todoItems) : skip,
      H("inventory") || H("billing") ? safe(() => rows(() => sb.from("stock_bill_totals").select("id, balance_bdt").neq("status", "paid").order("id"))) : skip,
      H("billing") ? safe(() => rows(() => sb.from("pay_vouchers").select("id, amount_php, amount_bdt").gte("pay_date", p.from).lte("pay_date", p.to).order("id"))) : skip,
      H("employees") ? safe(() => E.readPay(sb.from("payslip_balances").select("balance")).then((r) => (r.missing ? null : r.rows))) : skip,
      H("purchase") ? safe(() => rows(() => sb.from("purchase_orders").select("id, status, pending_update").order("id"))) : skip]);
    const L = [];
    if (sales) L.push(["Sales (invoices)", `${money(sales.sum)} · ${plural(sales.n, "invoice")}`, "#invoices"]);
    if (coll) L.push(["Payments received", `${money(coll.sum)} · ${plural(coll.n, "payment")}`, "#payments"]);
    if (bal) { const owing = bal.filter((x) => x.due > 0.004); L.push(["Total due (to collect)", `${money(sumOf(owing, "due"))} · ${plural(owing.length, "customer")}`, "#customers"]); }
    if (over) L.push(["Overdue", `${money(sumOf(over, "balance"))} · ${plural(over.length, "invoice")}`, "#invoices"]);
    if (ords) L.push(["Open customer orders", `${ords.length} (${ords.filter((o) => o.status === "pending").length} wait for approval)`, "#custorders"]);
    if (bill) L.push(["Billing sent", `${money(sumOf(bill, "amount_php"))} = ${bdtM(sumOf(bill, "amount_bdt"))}`, "#billing"]);
    if (eb) L.push(["E-Bills not paid", `${bdtM(sumOf(eb, "balance_bdt"))} · ${plural(eb.length, "e-bill")}`, "#inventory"]);
    if (sal) L.push(["Unpaid salary", money(sumOf(sal, "balance")), "#payroll"]);
    if (lots) L.push(["Lots waiting for review", String(lots.filter((x) => ["pending", "negotiation"].includes(x.status) || x.pending_update).length), "#purchase"]);
    if (todo) L.push(["Waiting for you", String(todo.reduce((s, [n]) => s + n, 0)), "#dashboard"]);
    if (!L.length) return { html: "I could not read the records for a summary." };
    return { html: `Business summary · <b>${esc(p.label.toUpperCase())}</b><table class="eva-t eva-sum"><tbody>${L.map(([k, v, h]) => `<tr><td><a href="${h}">${esc(k)}</a></td><td class="num">${v}</td></tr>`).join("")}</tbody></table>
      <small class="muted">Sales, payments and billing are for ${esc(p.label)}; the others are as they are now.</small>`,
      chips: [["Waiting for me", "what is waiting for me"], ["Overdue", "overdue customers"], ["Billing", "billing this month"], ["Unpaid salary", "unpaid salary"]] };
  }

  // ---------- 3.60: a record number of any kind → the record ----------
  const empOf = (ents, id) => { const m = ents.employee.find((x) => x.id === id); return m ? empLink(m) : "an employee"; };
  // [number, menu, table, column, what is read, the answer] or [number, menu, table, column, what is read, null, the account's own answer]
  const DOCS = [
    [/^A-/, ["payments", "invoices"], "payments_received", "receipt_no", "id, receipt_no, paid_date, amount, method, customers(id, first_name, last_name, account_no)",
      (r) => `Payment receipt <a href="#payment/${esc(r.id)}"><b>${esc(r.receipt_no)}</b></a>: <b class="eva-amt">${money(r.amount)}</b>${r.customers ? ` from ${custLink(r.customers)}` : ""} on ${esc(mdy(r.paid_date))}${r.method ? ` · ${esc(String(r.method).toUpperCase())}` : ""}`],
    [/^BD/, "billing", "pay_vouchers", "voucher_no", "id, voucher_no, pay_date, amount_php, amount_bdt, purpose, pay_companies(id, name), pay_accounts(account_name, bank_name)",
      (r) => `Payment voucher <a href="#voucher/${esc(r.id)}"><b>${esc(r.voucher_no)}</b></a>: <b class="eva-amt">${vAmt(r)}</b>${r.pay_companies ? ` to ${coLink(r.pay_companies)}` : ""}${r.pay_accounts ? ` · ${esc(r.pay_accounts.account_name)}${r.pay_accounts.bank_name ? ` (${esc(r.pay_accounts.bank_name)})` : ""}` : ""} on ${esc(mdy(r.pay_date))}${r.purpose ? `<br>${esc(r.purpose)}` : ""}`],
    [/^EOC-/, "creditmemos", "credit_memos", "memo_no", "id, memo_no, memo_date, status, request_amount, customers(id, first_name, last_name, account_no)",
      (r) => `Credit memo <a href="#creditmemo/${esc(r.id)}"><b>${esc(r.memo_no)}</b></a>: ${money(r.request_amount)}${r.customers ? ` for ${custLink(r.customers)}` : ""} · <b>${esc(MEMO_ST[r.status] || r.status)}</b> · ${esc(mdy(r.memo_date))}`],
    [/^CV-/, "eooffice", "collection_vouchers", "cv_no", "id, cv_no, cv_date, received_from, amount, method",
      (r) => `Collection voucher <a href="#collection/${esc(r.id)}"><b>${esc(r.cv_no)}</b></a>: <b class="eva-amt">${money(r.amount)}</b> received from <b>${esc(r.received_from)}</b> on ${esc(mdy(r.cv_date))}${r.method ? ` · ${esc(String(r.method).toUpperCase())}` : ""}`],
    [/^PS-/, "employees", "payslip_balances", "payslip_no", "id, payslip_no, employee_id, period_month, net_pay, paid, balance, status",
      (r, e) => `Payslip <a href="#payslip/${esc(r.id)}"><b>${esc(r.payslip_no)}</b></a> of ${empOf(e, r.employee_id)} for ${esc(E.monthText(r.period_month))}: net ${money(r.net_pay)} · paid ${money(r.paid)} · unpaid <b class="eva-amt">${money(r.balance)}</b> · <b>${SLIP_ST[r.status] || ""}</b>`],
    [/^SP-/, "employees", "salary_payments", "payment_no", "id, payment_no, amount, pay_date, employee_id, payslip_id, payslips(payslip_no)",
      (r, e) => `Salary payment <a href="#payslip/${esc(r.payslip_id)}"><b>${esc(r.payment_no)}</b></a>: <b class="eva-amt">${money(r.amount)}</b> paid to ${empOf(e, r.employee_id)} on ${esc(mdy(r.pay_date))}${r.payslips ? ` · payslip ${esc(r.payslips.payslip_no)}` : ""}`],
    [/^PP-/, "projects", "project_payments", "payment_no", "id, payment_no, amount, pay_date, received_by, project_id, projects(project_no, title)",
      (r) => `Project payment <a href="#project/${esc(r.project_id)}"><b>${esc(r.payment_no)}</b></a>: <b class="eva-amt">${money(r.amount)}</b> on ${esc(mdy(r.pay_date))}${r.projects ? ` for ${esc(r.projects.title)} (${esc(r.projects.project_no)})` : ""}${r.received_by ? ` · received by ${esc(r.received_by)}` : ""}`],
    [/^PRJ-/, "projects", "projects", "project_no", "id, project_no, title, status", null, (r) => aProjects(r)],
    [/^LOT-/, "purchase", "purchase_orders", "po_no", "id, po_no, lot_name, status", null, (r) => aPurchase(r)],
    [/^QC-/, "eooffice", "qc_tests", "qc_no", "id, qc_no, serial_no, item, brand, batch, score",
      (r) => `QC form <a href="#qc/${esc(r.id)}"><b>${esc(r.qc_no)}</b></a>: ${esc([r.item, r.brand, r.batch && `batch ${r.batch}`, r.serial_no].filter(Boolean).join(" · "))}${r.score != null ? ` · score <b>${r.score} / 100</b>${E.qcVerdict ? ` · ${esc(E.qcVerdict(r.score))}` : ""}` : ""}`],
    [/^(?:EO-\d{4}-\d{2}-|ORDER-)/, "customers", "order_letters", "order_no", "id, order_no, order_date, subject, status, customers(id, first_name, last_name, account_no)",
      (r) => `Order letter <a href="#order/${esc(r.id)}"><b>${esc(r.order_no)}</b></a>: ${esc(r.subject || "")} · <b>${esc(String(r.status || "").toUpperCase())}</b> · ${esc(mdy(r.order_date))}${r.customers ? ` · ${custLink(r.customers)}` : ""}`],
    [/^EO-\d{8}$/, "employees", "employees", "employee_no", "id", null, (r, e) => { const m = e.employee.find((x) => x.id === r.id); return m ? aEmployee(m) : null; }],
    [/^EO-\d{4}-\d{5}$/, "customers", "customers", "application_no", "id", null, (r, e) => { const c = e.customer.find((x) => x.id === r.id); return c ? aCustomer(c) : null; }],
    [/^EOID-/, "employees", "employee_cards", "card_no", "id, card_no, status, employee_id", null, async (r, e) => {
      const m = e.employee.find((x) => x.id === r.employee_id); if (!m) return null;
      const a = await aEmployee(m); return { ...a, html: `ID card <b>${esc(r.card_no)}</b> (${esc(String(r.status || "").toUpperCase())}) belongs to:<br>${a.html}` }; }],
    [/^RN-/, ["inventory", "billing"], "stock_bill_totals", "release_order_no", "*", ebillCard],
    [/^SOA-/, "customers", "statements", "statement_no", "id, statement_no, period_start, period_end, closing_balance, customers(id, first_name, last_name, account_no)",
      (r) => `Statement of account <b>${esc(r.statement_no)}</b>${r.customers ? ` of ${custLink(r.customers)}` : ""}: ${esc(mdy(r.period_start))} to ${esc(mdy(r.period_end))} · closing balance <b class="eva-amt">${money(r.closing_balance)}</b>`],
    [/^MS-/, null, "contact_messages", "ref_no", "id, ref_no, name, status, message, created_at",
      (r) => `Contact message <a href="#contacts"><b>${esc(r.ref_no)}</b></a> from <b>${esc(r.name)}</b> · ${esc(String(r.status || "").toUpperCase())} · ${esc(E.dateTime(r.created_at))}<br>${esc(String(r.message || "").slice(0, 180))}`],
    [/^CR-/, null, "change_requests", "request_no", "id, request_no, target_label, status, requested_by_name",
      (r) => `Correction <a href="#changes"><b>${esc(r.request_no)}</b></a>: ${esc(r.target_label || "")} · <b>${esc(String(r.status || "").toUpperCase())}</b>${r.requested_by_name ? ` · asked by ${esc(r.requested_by_name)}` : ""}`]
  ];
  const MENU_NAME = { payments: "Payment", invoices: "Invoice", billing: "Billing", creditmemos: "Credit Memo", eooffice: "EO-Office", employees: "Employees", projects: "Project", purchase: "Purchase Order", customers: "Customer", inventory: "E-Bill" };
  async function aFind(code) {
    const d = DOCS.find(([re]) => re.test(code));
    if (!d) return { html: `<a href="#find/${encodeURIComponent(code)}">Search for ${esc(code)}</a>` };
    const [, mod, tbl, col, sel, show, own] = d, mods = [].concat(mod || []);
    if (mods.length && !mods.some((m) => E.hasModule(m))) return noAccess(MENU_NAME[mods[0]] || mods[0]);
    const [r, ents] = await Promise.all([one(sb.from(tbl).select(sel).eq(col, code).limit(1).maybeSingle()).catch(() => null), entities()]);
    if (!r) return { html: `${esc(code)} is not found.` };
    return (own && (await own(r, ents))) || { html: show ? show(r, ents) : esc(code) };
  }

  // ---------- 3.60: words EVA did not understand → looked for in every record (names and numbers) ----------
  const SEARCH_STOP = new Set(["find", "search", "look", "lookup", "up", "for", "record", "records", "about", "is", "a", "an", "and", "or", "me", "can", "you", "please", "pls",
    "where", "all", "any", "number", "name", "who", "to", "on", "at", "my", "our", "the", "of", "in", "this", "that", "what", "which", "show", "check", "open", "give", "details"]);
  const textOf = (r) => Object.entries(r).filter(([k]) => !/(^|_)id$/.test(k)).map(([, v]) => (v && typeof v === "object" ? Object.values(v).join(" ") : v ?? "")).join(" ").toLowerCase();
  // [the kind, the menu(s), what is asked, the record's name, its page, its details]
  const FINDS = [
    ["Customer", ["customers"], (l) => sb.from("customers").select("id, first_name, last_name, business_name, account_no, phone, public_id").or(`first_name.ilike.${l},last_name.ilike.${l},business_name.ilike.${l},account_no.ilike.${l},phone.ilike.${l},public_id.ilike.${l}`).limit(30),
      (r) => fullName(r).toUpperCase(), (r) => `#customer/${r.id}`, (r) => [r.account_no, r.business_name].filter(Boolean).join(" · ")],
    ["Employee", ["employees"], (l) => sb.from("employees").select("id, first_name, last_name, employee_no, position, phone, email").or(`first_name.ilike.${l},last_name.ilike.${l},employee_no.ilike.${l},position.ilike.${l},phone.ilike.${l},email.ilike.${l}`).limit(20),
      (r) => fullName(r).toUpperCase(), (r) => `#employee/${r.id}`, (r) => [r.employee_no, r.position].filter(Boolean).join(" · ")],
    ["Billing Company", ["billing"], (l) => sb.from("pay_companies").select("id, name, country, contact_person").or(`name.ilike.${l},contact_person.ilike.${l},contact.ilike.${l}`).limit(20),
      (r) => String(r.name).toUpperCase(), (r) => `#paycompany/${r.id}`, (r) => [r.country, r.contact_person].filter(Boolean).join(" · ")],
    ["Bank Account", ["billing"], (l) => sb.from("pay_accounts").select("id, company_id, account_name, account_number, bank_name, pay_companies(name)").or(`account_name.ilike.${l},account_number.ilike.${l},bank_name.ilike.${l}`).limit(20),
      (r) => r.account_name, (r) => `#paycompany/${r.company_id}`, (r) => [r.bank_name, r.account_number, r.pay_companies?.name].filter(Boolean).join(" · ")],
    ["Lot", ["purchase"], (l) => sb.from("purchase_orders").select("id, po_no, lot_name, status").or(`lot_name.ilike.${l},po_no.ilike.${l},authorized_person.ilike.${l}`).limit(20),
      (r) => r.lot_name, (r) => `#po/${r.id}`, (r) => `${r.po_no} · ${PO_ST[r.status] || r.status}`],
    ["Project", ["projects"], (l) => sb.from("projects").select("id, project_no, title, location, status").or(`title.ilike.${l},project_no.ilike.${l},location.ilike.${l}`).limit(20),
      (r) => r.title, (r) => `#project/${r.id}`, (r) => [r.project_no, PRJ_ST[r.status] || r.status].filter(Boolean).join(" · ")],
    ["E-Bill", ["inventory", "billing"], (l) => sb.from("stock_bill_totals").select("id, bill_no, batch_no, company_name, status, supplier_bill_no, shipment_no").or(`bill_no.ilike.${l},batch_no.ilike.${l},supplier_bill_no.ilike.${l},shipment_no.ilike.${l},company_name.ilike.${l}`).limit(20),
      (r) => r.bill_no, (r) => `#stockbill/${r.id}`, (r) => [r.company_name, r.batch_no && `batch ${r.batch_no}`, EB_ST[r.status]].filter(Boolean).join(" · ")],
    ["Collection Voucher", ["eooffice"], (l) => sb.from("collection_vouchers").select("id, cv_no, received_from, amount, reference_no").or(`received_from.ilike.${l},cv_no.ilike.${l},reference_no.ilike.${l}`).limit(20),
      (r) => r.cv_no, (r) => `#collection/${r.id}`, (r) => `${r.received_from} · ${money(r.amount)}`],
    ["QC Form", ["eooffice"], (l) => sb.from("qc_tests").select("id, qc_no, item, brand, batch, serial_no").or(`qc_no.ilike.${l},item.ilike.${l},brand.ilike.${l},serial_no.ilike.${l}`).limit(20),
      (r) => r.qc_no, (r) => `#qc/${r.id}`, (r) => [r.item, r.brand, r.batch, r.serial_no].filter(Boolean).join(" · ")],
    ["Invoice", ["invoices"], (l) => sb.from("invoice_balances").select("id, invoice_no, po_number, first_name, last_name, balance").or(`invoice_no.ilike.${l},po_number.ilike.${l}`).limit(20),
      (r) => r.invoice_no, (r) => `#invoice/${r.id}`, (r) => `${fullName(r).toUpperCase()} · balance ${money(r.balance)}`],
    ["Payment", ["payments", "invoices"], (l) => sb.from("payments_received").select("id, receipt_no, reference_no, amount, paid_date").or(`receipt_no.ilike.${l},reference_no.ilike.${l}`).limit(20),
      (r) => r.receipt_no, (r) => `#payment/${r.id}`, (r) => `${money(r.amount)} · ${mdy(r.paid_date)}`],
    ["Payment Voucher", ["billing"], (l) => sb.from("pay_vouchers").select("id, voucher_no, reference_no, purpose, amount_php, amount_bdt, pay_companies(name)").or(`voucher_no.ilike.${l},reference_no.ilike.${l},purpose.ilike.${l}`).limit(20),
      (r) => r.voucher_no, (r) => `#voucher/${r.id}`, (r) => [r.pay_companies?.name, vAmt(r)].filter(Boolean).join(" · ")]
  ];
  async function aSearch(q, unsure = false) {
    const ws = [...new Set(q.rest.filter((w) => w.length >= 2 && !SEARCH_STOP.has(w)))], said = ws.join(" ");
    if (!ws.length) return unsure ? { html: `Sorry, I did not understand that. ${helpHtml()}`, chips: HELP } : { html: "What should I find? Write a name or a number." };
    const like = `%${ws.slice().sort((a, b) => b.length - a.length)[0]}%`; // the longest word is asked from the server; every word must be in the record
    const res = await Promise.all(FINDS.map(([, mods, ask]) => (mods.some((m) => E.hasModule(m)) ? ask(like).then((r) => r.data || [], () => []) : [])));
    const hits = [];
    res.forEach((list, i) => { const [kind, , , name, link, detail] = FINDS[i]; for (const r of list) if (ws.every((w) => textOf(r).includes(w))) hits.push([kind, name(r), link(r), detail(r)]); });
    if (!hits.length) return { html: unsure ? `Sorry, I did not understand that, and nothing named “${esc(said)}” is in the records. ${helpHtml()}` : `Nothing named “${esc(said)}” is in the records.`, chips: HELP };
    return { html: `I found ${plural(hits.length, "record")} for “${esc(said)}”:${table(["Kind", "Record", "Details"], hits.slice(0, 12).map(([k, n, h, d]) => [esc(k), `<a href="${esc(h)}">${esc(n || "")}</a>`, esc(d || "")]))}
      ${hits.length > 12 ? `<a href="#find/${encodeURIComponent(said)}">See all in Search</a>` : ""}` };
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
    // 3.60: the e-bill of the batch
    if (batch && (E.hasModule("inventory") || E.hasModule("billing"))) {
      const eb = await rows(() => sb.from("stock_bill_totals").select("id, bill_no, status, balance_bdt").ilike("batch_no", batch).order("id")).catch(() => []);
      if (eb.length) html += `<br>E-Bill of batch ${esc(batch)}: ${eb.map((b) => `${ebLink(b)} · ${esc(EB_ST[b.status] || b.status)}${b.status !== "paid" ? ` · balance ${bdtM(b.balance_bdt)}` : ""}`).join(" · ")}`;
    }
    return { html };
  }

  const HELP = [["Business summary", "business summary"], ["Waiting for me", "what is waiting for me"], ["How much due this customer?", "how much due this customer"], ["Total due", "total due"],
    ["Who has the most due?", "who has most due"], ["Overdue customers", "overdue customers"], ["Sales this month", "sales this month"], ["Collection today", "collection today"],
    ["Open orders", "open orders"], ["Billing this month", "billing this month"], ["E-Bill balance", "ebill balance"], ["Unpaid salary", "unpaid salary"],
    ["Lots waiting", "lots waiting approval"], ["Projects", "projects"], ["Stock", "stock"], ["How many customers?", "how many customers"]];
  const helpHtml = () => `I am <b>EVA</b>, your AI assistant. I read the records on your server and answer in a moment. Ask me in simple words, for example:
    <ul class="eva-ex"><li><b>Customers:</b> how much due <i>Precious Roman</i> · this customer due how much · total due · who has most due · overdue customers · last payment of <i>name</i> · gate pass <i>name</i> · credit limit <i>name</i></li>
    <li><b>Money:</b> business summary · what is waiting for me · collection today · sales this month</li>
    <li><b>Orders and boxes:</b> open orders · OR-202610-0001 · INV-202610-0001 · U20261240 · stock L-13 · stock zara</li>
    <li><b>Billing:</b> billing this month · <i>company name</i> (its bank accounts, vouchers and e-bills) · BD20261031001</li>
    <li><b>E-Bill:</b> ebill balance · MF-2026-0001 · ebill of batch I-17</li>
    <li><b>Payroll:</b> unpaid salary · salary this month · <i>employee name</i> salary · how many employees · PS-202610-001</li>
    <li><b>More:</b> lots waiting approval · <i>lot name</i> · projects · credit memos · any name or number: I look for it in every record</li></ul>`;

  // ======================================================================
  // One question → one answer. A question that needs a customer and names none asks for it; the next message may answer.
  // 3.60: the name of another kind of account (employee, billing company or its bank account, lot, project) gives that
  // account's answer; a name of two accounts → which one?; "this …" is the account of the page open, or the one asked
  // about before.
  // ======================================================================
  const NEEDS_CUST = new Set(["due", "limit", "gate", "customer_info"]);
  const CAN_CUST = new Set(["due", "limit", "gate", "customer_info", "overdue", "last_payment", "payments", "invoices", "orders"]);
  // the customer talked about; a question waiting for its customer; the question of a "which one?"; the other accounts talked about
  const ctx = { last: null, waiting: null, pickText: "", lastOf: {} };
  // the account of the page open (a customer: also of an order, invoice or payment; an employee: of a payslip; a company: of a voucher)
  async function pageContext(ents) {
    const [k, id] = decodeURIComponent(location.hash.slice(1)).split("/");
    if (!id) return null;
    const of = (kind, x) => (x ? { kind, item: x } : null);
    const read = async (tbl, col, by = "id") => (await sb.from(tbl).select(col).eq(by, id).maybeSingle()).data?.[col];
    const cust = (cid) => of("customer", ents.customer.find((c) => c.id === cid));
    switch (k) {
      case "customer": return cust(id);
      case "custorder": return cust(await read("customer_orders", "customer_id", /^(CO|OR)-/i.test(id) ? "order_no" : "id"));
      case "invoice": return cust(await read("customer_invoices", "customer_id"));
      case "payment": return cust(await read("payments_received", "customer_id"));
      case "employee": return of("employee", ents.employee.find((x) => x.id === id));
      case "payslip": { const eid = await read("payslips", "employee_id"); return of("employee", ents.employee.find((x) => x.id === eid)); }
      case "paycompany": return of("company", ents.company.find((x) => x.id === id));
      case "voucher": { const co = await read("pay_vouchers", "company_id"); return of("company", ents.company.find((x) => x.id === co)); }
      case "po": return of("lot", ents.lot.find((x) => x.id === id));
      case "project": return of("project", ents.project.find((x) => x.id === id));
      case "stockbill": return of("ebill", (await sb.from("stock_bill_totals").select("id, bill_no").eq("id", id).maybeSingle()).data);
      default: return null;
    }
  }
  const pageCustomer = async (ents) => { const pc = await pageContext(ents); return pc?.kind === "customer" ? pc.item : null; };
  const labelOf = (kind, x) => (kind === "customer" ? nameOf(x) : kind === "employee" ? fullName(x).toUpperCase() : kind === "company" ? String(x.name || "").toUpperCase()
    : kind === "account" ? x.account_name : kind === "lot" ? `${x.lot_name} · ${x.po_no}` : kind === "project" ? x.title : x.bill_no) || "";
  // a choice of "which one?": { id, kind, label }
  const pickOf = (x, kind) => {
    const k = x._kind || kind;
    const more = k === "customer" ? x.account_no : k === "employee" ? [x.employee_no, "employee"].filter(Boolean).join(" · ")
      : k === "account" ? [x.bank_name, "bank account"].filter(Boolean).join(" · ") : k === "lot" ? "lot" : KINDS[k]?.label;
    return { id: x.id, kind: k, label: `${labelOf(k, x)}${more ? ` · ${more}` : ""}` };
  };
  // the answer about an account of another kind
  function accountAnswer(kind, x, q, ents) {
    if (kind === "employee") return aEmployee(x);
    if (kind === "company") return aCompany(x, null, q.period);
    if (kind === "account") { const co = ents.company.find((c) => c.id === x.company_id); return co ? aCompany(co, x, q.period) : { html: "The company of that bank account is not found." }; }
    if (kind === "lot") return aPurchase(x, q.period);
    if (kind === "project") return aProjects(x);
    return aEbills(q, x);
  }
  const OWN_KIND = { employee: "employee", company: "company", purchase: "lot", projects: "project", ebills: "ebill" };
  const KIND_INTENT = { employee: "employee", company: "company", account: "company", lot: "purchase", project: "projects" };
  async function answer(text, picked = null) {
    const ents = await entities(), list = ents.customer;
    const q = readQuestion(text, ctx.waiting ? { customer: list } : ents);
    const ranked = classify(q);
    let intent = ranked[0].k;
    const sure = ranked[0].p;
    const done = async (r) => {
      if (r.cust?.id) ctx.last = (await customers()).find((c) => c.id === r.cust.id) || r.cust;
      if (r.ent) ctx.lastOf[r.ent.kind] = r.ent.item;
      return { ...r, intent, sure };
    };
    // what the codes in the question say at once
    if (q.codes.doc.length) intent = "find";
    else if (q.codes.ebill.length) intent = "ebills";
    else if (q.codes.serial.length && !["stock"].includes(intent)) intent = "box";
    else if (q.codes.order.length && intent !== "box") intent = "orders";
    else if (q.codes.invoice.length) intent = "invoices";
    else if (q.codes.batch.length && !["box", "orders", "invoices", "ebills"].includes(intent)) intent = "stock";
    const coded = ["doc", "ebill", "serial", "order", "invoice", "batch"].some((k) => q.codes[k].length);
    // the account: picked from a list ("which one?") or named in the question
    const pk = picked == null ? null : typeof picked === "object" ? picked : { kind: "customer", id: picked };
    const kind = pk ? pk.kind : q.kind;
    let item = pk ? (ents[pk.kind] || []).find((x) => x.id === pk.id) || null : null;
    if (!pk && q.named.list.length > 1) {
      if (kind === "customer") ctx.waiting = { intent: CAN_CUST.has(intent) ? intent : "customer_info", text };
      ctx.pickText = text;
      return { html: `I found ${q.named.list.length} ${kind === "customer" ? "customers" : "accounts"} with that name. Which one?`, pick: q.named.list.map((x) => pickOf(x, kind)) };
    }
    if (!pk && q.named.list.length === 1) item = q.named.list[0];
    // a named account that is not a customer: its own answer (the codes in the question come first)
    if (item && kind !== "customer" && !coded) { ctx.waiting = null; intent = KIND_INTENT[kind] || intent; return done(await accountAnswer(kind, item, q, ents)); }
    let cust = kind === "customer" ? item : null;
    // a customer picked from "which one?" for a question of only the name: the customer's details
    if (cust && pk && !ctx.waiting && !q.words.some((w) => !BARE.has(w))) intent = "customer_info";
    // only a name was written as the answer to "which customer?": the waiting question is answered
    if (cust && ctx.waiting && (sure < 0.6 || intent === "customer_info") && q.words.length <= 1) { intent = ctx.waiting.intent; }
    else if (!cust && ctx.waiting && sure < 0.35) return { html: "I did not find that customer. Write the name as on the account, or the account no (for example PR-202610001)." };
    ctx.waiting = null;
    if (intent === "due" && !cust && q.words.some((w) => ["total", "all", "overall", "sum"].includes(w))) intent = "total_due";
    // "this employee", "this company", "this lot", "this project", "this ebill": the page open, or the one asked about before
    const own = OWN_KIND[intent];
    if (own && !coded && !cust && (q.flags.includes("ctx") || intent === "employee")) {
      const pc = await pageContext(ents).catch(() => null), got = pc?.kind === own ? pc.item : ctx.lastOf[own];
      if (got) return done(await accountAnswer(own, got, q, ents));
    }
    if (!cust && CAN_CUST.has(intent) && (q.flags.includes("ctx") || NEEDS_CUST.has(intent))) cust = (await pageCustomer(ents).catch(() => null)) || ctx.last;
    if (!cust && NEEDS_CUST.has(intent)) {
      ctx.waiting = { intent, text };
      return { html: `Which customer? Write the name or the account no.${intent === "due" ? " (Ask <b>total due</b> for all customers.)" : ""}` };
    }
    // not understood, or only words EVA does not know (a name, a phone or account number): they are looked for in every record
    if ((sure < 0.3 || !q.words.some((w) => VOCAB.has(w))) && !coded && !cust) return done(await aSearch(q, true));
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
      // 3.60
      case "find": r = await aFind(q.codes.doc[0]); break;
      case "ebills": r = await aEbills(q); break;
      case "billing": r = await aBilling(q.period); break;
      case "company": r = cust ? await aCustomer(cust) : await aBilling(q.period); break;
      case "payroll": r = await aPayroll(q.period); break;
      case "employee": r = cust ? await aCustomer(cust) : { html: "Which employee? Write the name or the employee no (for example EO-20260601).", chips: [["All employees", "how many employees"], ["Payroll", "payroll"]] }; break;
      case "employees": r = await aEmployees(); break;
      case "memos": r = await aMemos(q.period, cust); break;
      case "purchase": r = await aPurchase(null, q.period); break;
      case "projects": r = await aProjects(null); break;
      case "todo": r = await aTodo(); break;
      case "summary": r = await aSummary(q.period); break;
      case "search": r = await aSearch(q); break;
      case "greet": r = { html: `Hello${S.profile?.full_name ? " " + esc(String(S.profile.full_name).split(" ")[0].toLowerCase().replace(/^./, (x) => x.toUpperCase())) : ""}! I am EVA. Ask me about customers, money, orders, boxes, billing, e-bills, payroll, lots or projects — or write any name or number.`, chips: HELP.slice(0, 6) }; break;
      case "thanks": r = { html: "You're welcome! 😊" }; break;
      default: r = { html: helpHtml(), chips: HELP };
    }
    return done(r);
  }

  // ======================================================================
  // The chat (in the EVA panel and on the EVA AI page; one conversation)
  // ======================================================================
  const LOG = [];
  // 3.60: the chat is kept on this device for the login (the last 80 messages) until New Chat or sign-out
  let logOf = null;
  const logKey = () => `eoEva:${S.profile?.id || S.session?.user?.id || ""}`;
  function loadLog() {
    const k = logKey();
    if (logOf === k) return;
    logOf = k; LOG.length = 0;
    try { const a = JSON.parse(localStorage.getItem(k) || "[]"); if (Array.isArray(a)) LOG.push(...a.filter((m) => m && (m.who === "me" || m.who === "ai") && !m.busy).slice(-80)); } catch (_) {}
  }
  function saveLog() { try { localStorage.setItem(logKey(), JSON.stringify(LOG.filter((m) => !m.busy).slice(-80))); } catch (_) {} }
  function clearChat() {
    LOG.length = 0; ctx.last = null; ctx.waiting = null; ctx.pickText = ""; ctx.lastOf = {};
    try { localStorage.removeItem(logKey()); } catch (_) {}
    paint();
  }
  sb.auth.onAuthStateChange((ev) => {
    if (ev !== "SIGNED_OUT") return;
    try { Object.keys(localStorage).filter((k) => k.startsWith("eoEva:")).forEach((k) => localStorage.removeItem(k)); } catch (_) {}
    LOG.length = 0; logOf = null; ENTS = null; CUST = null; ctx.last = null; ctx.waiting = null; ctx.lastOf = {};
  });
  const evaIc = () => `<span class="eva-av">${ic("ai")}</span>`;
  const timeOf = (t) => {
    const d = new Date(t), hm = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return d.toDateString() === new Date().toDateString() ? hm : `${d.toLocaleDateString("en-US", { month: "short", day: "2-digit" }).toUpperCase()} · ${hm}`;
  };
  function msgHtml(m, seen = null) {
    const nw = !seen || seen.has(m) ? "" : " new";
    seen?.add(m);
    const at = m.at ? `<small class="eva-time">${esc(timeOf(m.at))}</small>` : "";
    if (m.who === "me") return `<div class="eva-msg me${nw}"><div class="eva-col"><div class="eva-b">${esc(m.text)}</div>${at}</div></div>`;
    return `<div class="eva-msg ai${nw}">${evaIc()}<div class="eva-col"><div class="eva-b">${m.html}${m.pick ? `<div class="eva-chips">${m.pick.map((c) => `<button type="button" class="eva-chip" ${c.kind === "customer" ? `data-cust="${esc(c.id)}"` : `data-ent="${esc(c.kind)}:${esc(c.id)}"`}>${esc(c.label)}</button>`).join("")}</div>` : ""}
      ${m.chips?.length ? `<div class="eva-chips">${m.chips.map(([l, a]) => `<button type="button" class="eva-chip" data-ask="${esc(a)}">${esc(l)}</button>`).join("")}</div>` : ""}</div>${at}</div></div>`;
  }
  const views = new Set(); // the chat boxes open (panel, page)
  const WELCOME = { who: "ai", html: `Hello! I am <b>EVA</b>. Ask me anything about your customers, money, orders, boxes, billing, e-bills, payroll, lots and projects — or write any name or number and I will find it.`, chips: HELP };
  // the questions always at hand, above the box to write in
  const QUICK = [["Summary", "business summary"], ["Waiting for me", "what is waiting for me"], ["Total due", "total due"], ["Sales", "sales this month"], ["Collection", "collection today"],
    ["Billing", "billing this month"], ["E-Bills", "ebill balance"], ["Payroll", "unpaid salary"], ["Lots", "lots waiting approval"], ["Stock", "stock"], ["Help", "help"]];
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
  async function ask(text, picked = null, shown = text) {
    text = String(text || "").trim();
    if (!text || busyAsk) return;
    busyAsk = true;
    loadLog();
    LOG.push({ who: "me", text: shown, at: Date.now() });
    LOG.push({ who: "ai", busy: true, html: `<span class="eva-dots"><i></i><i></i><i></i></span>` });
    paint();
    try { const r = await answer(text, picked); LOG[LOG.length - 1] = { who: "ai", at: Date.now(), html: r.html, chips: r.chips, pick: r.pick }; }
    catch (e) { LOG[LOG.length - 1] = { who: "ai", at: Date.now(), html: /box_stock|ai_settings|schema cache|PGRST20/.test(e?.message || "") ? "This needs the database update <b>RUN_048_TO_051.sql</b>. Run it in the Supabase SQL Editor." : `Sorry, I could not read that: ${esc(e?.message || e)}` }; }
    busyAsk = false;
    if (LOG.length > 120) LOG.splice(0, LOG.length - 120);
    saveLog();
    paint();
  }
  // a chat box in el (the panel's body or a part of the EVA AI page)
  function mount(el) {
    loadLog();
    el.innerHTML = `<div class="eva-chat"><div class="eva-log" aria-live="polite"></div>
      <div class="eva-foot"><div class="eva-quick" role="toolbar" aria-label="Quick questions">${QUICK.map(([l, a]) => `<button type="button" class="eva-chip" data-ask="${esc(a)}">${esc(l)}</button>`).join("")}</div>
        <form class="eva-ask" autocomplete="off"><button type="button" class="eva-new" title="New chat (clear this chat)" aria-label="New chat">${ic("trash")}</button>
          <input type="text" class="eva-q" maxlength="300" data-case="keep" placeholder="Ask EVA… a question, a name or a number" aria-label="Ask EVA">
          <button type="submit" class="btn primary" aria-label="Send">${ic("send")}<span>Send</span></button></form></div></div>`;
    views.add(el);
    if (!NET) setTimeout(getNet, 400); // the network learns (or reads what it learned) while the chat opens
    const input = $(".eva-q", el);
    $(".eva-ask", el).onsubmit = (e) => { e.preventDefault(); const t = input.value; input.value = ""; ask(t); };
    // ↑ in the empty box brings back the last question
    input.addEventListener("keydown", (e) => { if (e.key !== "ArrowUp" || input.value) return; const m = LOG.slice().reverse().find((x) => x.who === "me"); if (m) { e.preventDefault(); input.value = m.text; } });
    $(".eva-new", el).onclick = async () => {
      if (LOG.length && !(await E.confirmBox("Start a new chat? The questions and answers of this chat are removed from this device.", { title: "New Chat", ok: "New Chat" }))) return;
      clearChat(); input.focus();
    };
    el.addEventListener("click", (e) => {
      const b = e.target.closest(".eva-chip");
      if (b?.dataset.ask) ask(b.dataset.ask);
      else if (b?.dataset.cust) { const w = ctx.waiting; ask(w ? w.text : ctx.pickText || "about this customer", b.dataset.cust, b.textContent.trim()); }
      else if (b?.dataset.ent) { const [kind, id] = b.dataset.ent.split(":"); ask(ctx.pickText || "about this", { kind, id }, b.textContent.trim()); }
      else if (e.target.closest(".eva-b a[href^='#']") && el.closest(".eva-panel") && matchMedia("(max-width: 760px)").matches) closePanel();
    });
    paint();
    return input;
  }
  // the EVA panel (top bar button: the Director and the staff given EVA AI): "this customer" is the customer of the page open
  function openPanel() {
    if (!E.canAI()) return;
    let p = $(".eva-panel");
    if (!p) {
      p = document.createElement("aside");
      p.className = "eva-panel"; p.setAttribute("aria-label", "EVA AI chat");
      p.innerHTML = `<div class="ep-head"><span class="ep-title">${ic("ai")} EVA AI <small>ask me</small></span>${isAdmin() ? `<a href="#gateai" class="ep-page" title="EVA AI page">${ic("doc")}</a>` : ""}
        <button type="button" class="ep-x" aria-label="Close">${ic("x")}</button></div><div class="ep-ctx" hidden></div><div class="ep-body"></div>`;
      document.body.appendChild(p);
      $(".ep-x", p).onclick = closePanel;
      if ($(".ep-page", p)) $(".ep-page", p).onclick = () => closePanel();
      mount($(".ep-body", p));
      document.addEventListener("keydown", panelKey);
    }
    requestAnimationFrame(() => p.classList.add("open"));
    showContext();
    setTimeout(() => $(".eva-q", p)?.focus(), 250);
  }
  function closePanel() { const p = $(".eva-panel"); if (p) p.classList.remove("open"); }
  function panelKey(e) { if (e.key === "Escape" && !$(".modal") && $(".eva-panel.open")) closePanel(); }
  // the account of the page open, shown under the panel's title ("this …" in a question is that account)
  async function showContext() {
    const p = $(".eva-panel"), el = p && $(".ep-ctx", p);
    if (!el) return;
    const pc = await entities().then(pageContext).catch(() => null);
    el.hidden = !pc;
    if (pc) el.innerHTML = `${ic(["customer", "employee"].includes(pc.kind) ? "user" : pc.kind === "ebill" ? "box" : pc.kind === "lot" ? "order" : "building")} This ${esc(KINDS[pc.kind].label)}: <b>${esc(labelOf(pc.kind, pc.item))}</b>${pc.kind === "customer" && pc.item.account_no ? ` <small class="mono">${esc(pc.item.account_no)}</small>` : ""}`;
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

  E.eva = { open: openPanel, close: closePanel, mount, ask, answer, readQuestion, classify, entities, boxSection, boxesOf, readCsv, sheetIdOf, clear: clearChat,
    reset: () => { CUST = null; BOX = null; ENTS = null; clearChat(); } };
})();
