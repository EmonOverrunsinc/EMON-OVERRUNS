/* EMON OVERRUNS E-PORTAL — step-by-step forms (3.5).
   Every long form (customer application, job application, employee, order, invoice, payment, credit memo, project, voucher,
   purchase order, e-bill ...) is shown one section at a time: a progress bar, Back / Continue, and at the end a Review page
   that lists everything that was written, with an Edit button for each section. Submit is on the Review page; the usual
   approval by the Director follows as before.
   The forms themselves are not changed: their sections (fieldsets) become the steps, and their own Submit button, checks and
   saving run as before. Browsers driven by test robots keep the forms flat unless localStorage "eoSteps" is "1". */
(() => {
  "use strict";
  const E = window.EO;
  const { esc, $, $$, toast, ic } = E;
  const FORMS = new Set(["ncForm", "niForm", "npForm", "cmForm", "neForm", "pjForm", "pcForm", "nvForm", "jaForm", "noForm", "sbForm", "poForm", "cvoForm"]);
  const flat = () => { try { return navigator.webdriver && localStorage.getItem("eoSteps") !== "1"; } catch (_) { return false; } };
  // a section that the form itself hides (for the kind of order, and so on) is not a step
  const naturallyHidden = (el, root) => { for (let n = el; n && n !== root; n = n.parentElement) { if (n.hidden || n.style.display === "none") return true; } return false; };
  const clean = (t) => String(t || "").replace(/\s+/g, " ").replace(/\s*\*\s*$/, "").replace(/\s*:\s*$/, "").trim();

  function stepify(form) {
    if (form.dataset.wz || flat()) return;
    const body = form.querySelector(":scope > .wbody");
    const foot = form.querySelector(":scope > .wfoot");
    if (!body || !foot) return;
    const fsets = $$(":scope > fieldset", body);
    if (fsets.length < 2) return;
    form.dataset.wz = "1";
    // every piece of the body belongs to the section after it (a closing note belongs to the last one)
    const parts = []; let lead = [];
    for (const el of Array.from(body.children)) {
      if (el.tagName === "FIELDSET") { parts.push({ fs: el, lead }); lead = []; } else lead.push(el);
    }
    if (lead.length && parts.length) parts[parts.length - 1].tail = lead; // a closing note belongs to the last section
    const head = document.createElement("div"); head.className = "wz-head"; body.prepend(head);
    const review = document.createElement("div"); review.className = "wz-review"; review.hidden = true; body.append(review);
    const submits = $$("button[type=submit]", foot), others = $$(":scope > :not(button[type=submit])", foot);
    const back = document.createElement("button"); back.type = "button"; back.className = "btn wz-back"; back.innerHTML = `${ic("back")} Back`;
    const next = document.createElement("button"); next.type = "button"; next.className = "btn primary wz-next"; next.textContent = "Continue";
    foot.prepend(back); foot.append(next);
    let cur = 0, onReview = false;
    const steps = () => parts.filter((p) => !naturallyHidden(p.fs, form));
    const titleOf = (p) => clean($("legend", p.fs)?.textContent) || "Details";

    // what was written in a section, for the Review page
    const labelOf = (c) => {
      const id = c.id && form.querySelector(`label[for="${CSS.escape(c.id)}"]`);
      return clean(id?.textContent || c.closest("label")?.textContent || c.getAttribute("aria-label") || c.closest("[data-l]")?.dataset.l || c.placeholder || c.name || "");
    };
    const valueOf = (c) => {
      if (c.type === "checkbox" || c.type === "radio") return c.checked ? "Yes" : "";
      if (c.type === "file") return c.files?.length ? `${c.files.length} file${c.files.length > 1 ? "s" : ""}` : "";
      if (c.tagName === "SELECT") return c.value ? clean(c.selectedOptions[0]?.textContent) : "";
      return String(c.value || "").trim();
    };
    const summary = (p) => {
      const rows = [], chips = [];
      const ctrls = $$("input, select, textarea", p.fs).filter((c) => c.type !== "hidden" && c.type !== "button" && c.type !== "submit" && !naturallyHidden(c, p.fs));
      // table lines (items, budget lines) are listed as one line each
      const byRow = new Map();
      for (const c of ctrls) {
        const tr = c.closest("tr");
        if (tr) { const v = valueOf(c); if (v) { if (!byRow.has(tr)) byRow.set(tr, []); byRow.get(tr).push(v); } continue; }
        if (c.type === "checkbox" || c.type === "radio") { if (c.checked) chips.push(labelOf(c)); continue; } // the chosen options are listed together
        const v = valueOf(c); const l = labelOf(c);
        const required = /\*/.test(form.querySelector(`label[for="${CSS.escape(c.id || "-")}"]`)?.textContent || "") || c.required;
        if (v) rows.push([l, v]);
        else if (required && c.type !== "file") rows.push([l, null]);
      }
      if (chips.length) rows.push(["Chosen", chips.join(" · ")]);
      let n = 0; for (const [, vals] of byRow) rows.push([`Line ${++n}`, vals.join(" · ")]);
      // the customer, the paper copy and other read-only values
      $$(".fields > b, .summary-box b", p.fs).forEach((b) => { const sp = b.previousElementSibling; if (sp && sp.tagName === "SPAN" && b.textContent.trim()) rows.unshift([clean(sp.textContent), b.textContent.trim()]); });
      return rows;
    };
    const drawReview = () => {
      const list = steps();
      review.innerHTML = `<p class="muted" style="margin:0 0 8px">Check everything. Press <b>Edit</b> to change a section, then <b>Submit</b> at the bottom.</p>` + list.map((p, i) => {
        const rows = summary(p);
        return `<div class="wz-sec"><div class="wz-sec-h"><b>${esc(titleOf(p))}</b><button type="button" class="btn small" data-edit="${i}">Edit</button></div>
          ${rows.length ? `<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd${v == null ? ' class="wz-miss"' : ""}>${v == null ? "Missing" : esc(v)}</dd>`).join("")}</dl>` : `<div class="muted">Nothing written.</div>`}</div>`;
      }).join("");
      $$("[data-edit]", review).forEach((b) => (b.onclick = () => show(Number(b.dataset.edit))));
    };

    const show = (i, rev = false, quiet = false) => {
      const list = steps();
      onReview = rev; cur = Math.max(0, Math.min(i, list.length - 1));
      const last = list[list.length - 1];
      for (const p of parts) {
        const active = !rev && p === list[cur];
        p.fs.classList.toggle("wz-off", !active);
        p.lead.forEach((x) => x.classList.toggle("wz-off", !active));
        if (p.tail) p.tail.forEach((x) => x.classList.toggle("wz-off", !(active && p === last)));
      }
      if (review.hidden === rev) review.hidden = !rev; // (the observer below watches hidden: set it only when it changes)
      if (rev) drawReview();
      const total = list.length + 1, at = rev ? total : cur + 1;
      head.innerHTML = `<small>Step ${at} of ${total}</small><b>${rev ? "Review and Submit" : esc(titleOf(list[cur]))}</b><div class="wz-bar"><i style="width:${Math.round((at / total) * 100)}%"></i></div>`;
      // buttons are hidden with a class (the form's own hidden buttons stay as they are)
      back.classList.toggle("wz-off", !rev && cur === 0); next.classList.toggle("wz-off", rev);
      submits.forEach((b) => b.classList.toggle("wz-off", !rev));
      others.forEach((o) => o.classList.toggle("wz-off", rev || cur !== 0));
      if (!quiet) form.scrollIntoView({ block: "start", behavior: "smooth" });
    };
    // a field that must be filled (marked * or required) stops Continue
    const check = () => {
      const p = steps()[cur];
      for (const c of $$("input, select, textarea", p.fs)) {
        if (c.type === "hidden" || c.type === "checkbox" || c.type === "radio" || c.type === "file" || c.disabled || naturallyHidden(c, p.fs)) continue;
        const lab = form.querySelector(`label[for="${CSS.escape(c.id || "-")}"]`);
        if ((c.required || /\*/.test(lab?.textContent || "")) && !String(c.value || "").trim()) {
          c.classList.add("wz-bad"); setTimeout(() => c.classList.remove("wz-bad"), 2500); c.focus();
          toast(`Fill in: ${clean(lab?.textContent || c.placeholder || "this field")}`, true); return false;
        }
      }
      return true;
    };
    next.onclick = () => { if (!check()) return; const list = steps(); if (cur >= list.length - 1) show(0, true); else show(cur + 1); };
    back.onclick = () => { if (onReview) show(steps().length - 1); else show(cur - 1); };
    // Enter inside a field goes on to the next step; the form is sent only from the Review page
    form.addEventListener("keydown", (e) => { if (e.key === "Enter" && !onReview && e.target.tagName === "INPUT" && e.target.type !== "file") { e.preventDefault(); next.click(); } });
    form.addEventListener("submit", (e) => { if (!onReview) { e.preventDefault(); e.stopImmediatePropagation(); next.click(); } }, true);
    // a form that draws its sections again (another position, another type) keeps working: the steps are counted again
    new MutationObserver(() => { if (onReview) return; const list = steps(); show(Math.min(cur, list.length - 1), false, true); }).observe(body, { attributes: true, attributeFilter: ["hidden", "style"], subtree: true });
    show(0, false, true);
  }

  const scan = (root) => {
    if (flat() || !root?.querySelectorAll) return;
    (root.matches?.("form.window") ? [root] : $$("form.window", root)).forEach((f) => { if (FORMS.has(f.id)) stepify(f); });
  };
  new MutationObserver((list) => { for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) scan(n); }).observe(document.body, { childList: true, subtree: true });
  scan(document.body);
  Object.assign(E, { stepify });
})();
