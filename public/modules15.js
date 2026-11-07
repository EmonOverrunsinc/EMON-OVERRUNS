/* EMON OVERRUNS E-PORTAL - 3.75: KYC VERIFICATION WITH A LIVE FACE CHECK (OPTIONAL)
   Every login can verify who they are from My Profile: the ID (type, number, expiry, date of birth, front and back photo)
   and a LIVE FACE check by the camera (the person follows moves shown on the screen; a photo is taken at each move and the
   movement between them is measured, so a printed photo or a screen does not pass). EMON HASAN compares the face with the
   ID and approves it (KYC VERIFIED) or rejects it with the reason. The photos are seen only by the person and EMON HASAN. */
(() => {
  const E = window.EO;
  const V = (window.EO_VIEWS = window.EO_VIEWS || {});
  const { sb, S, esc, $, $$, isAdmin, toast, fail, ic, busy } = E;

  const ID_TYPES = ["PHILSYS NATIONAL ID", "PASSPORT", "DRIVER'S LICENSE", "UMID", "SSS ID", "PRC ID", "POSTAL ID", "VOTER'S ID", "TIN ID", "PHILHEALTH ID",
    "SENIOR CITIZEN ID", "BANGLADESH NATIONAL ID (NID)", "COMPANY ID", "OTHER GOVERNMENT ID"];
  const ST = { approved: ["approved", "KYC VERIFIED"], pending: ["pending", "WAITING FOR REVIEW"], rejected: ["rejected", "NOT APPROVED"], replaced: ["closed", "REPLACED"], none: ["closed", "NOT VERIFIED"] };
  const pill = (s) => E.pill(...(ST[s] || ST.none));
  // the moves of the live check: LOOK STRAIGHT first, then three of the others in a new order each time
  const MOVES = [["left", "TURN YOUR HEAD SLOWLY TO THE LEFT"], ["right", "TURN YOUR HEAD SLOWLY TO THE RIGHT"], ["up", "LOOK UP"], ["smile", "SMILE"], ["close", "MOVE CLOSER TO THE CAMERA"]];
  const pickMoves = () => [["straight", "LOOK STRAIGHT AT THE CAMERA"], ...MOVES.map((m) => [Math.random(), m]).sort((a, b) => a[0] - b[0]).slice(0, 3).map((x) => x[1])];

  // the logins that are KYC VERIFIED (for the badge on the employee list and pages); kept for a minute
  let idsMemo = null, idsAt = 0;
  const kycIds = async () => {
    if (idsMemo && Date.now() - idsAt < 60000) return idsMemo;
    const { data, error } = await sb.rpc("kyc_verified_ids");
    idsMemo = new Set(error ? [] : data || []); idsAt = Date.now();
    return idsMemo;
  };
  const kycBadgeHtml = `<span class="kyc-badge" title="KYC verified: ID + live face check">${ic("shield")} KYC VERIFIED</span>`;

  // ---------- the KYC card on My Profile ----------
  async function kycCard(el) {
    if (!el || !S.profile) return;
    const { data, error } = await sb.from("kyc_verifications").select("*").eq("user_id", S.profile.id).order("submitted_at", { ascending: false }).limit(5);
    if (!el.isConnected) return;
    if (error) { el.hidden = true; return; } // the server has not 082 yet
    const ok = (data || []).find((r) => r.status === "approved"), last = (data || []).find((r) => r.status !== "replaced");
    const state = ok ? "approved" : last?.status || "none";
    el.hidden = false;
    el.innerHTML = `<legend>KYC Verification <small class="muted">(optional)</small></legend>
      <div class="kyc-state ${state}">${ic(state === "approved" ? "shield" : state === "pending" ? "clock" : "idcard")}<div><b>${esc((ST[state] || ST.none)[1])}</b>
        <small>${state === "approved" ? `${esc(ok.id_type)} · ${esc(ok.reviewed_by_name || "EVA AI")} · ${esc(E.dateTime(ok.reviewed_at))}`
          : state === "pending" ? `Sent ${esc(E.dateTime(last.submitted_at))} · ${esc(last.ref_no || "")}.`
          : state === "rejected" ? `Reason: ${esc(last.review_note || "")}. You can do it again.`
          : "Verify your identity with your ID and a live face check by the camera. It takes about 2 minutes."}</small></div></div>
      ${state === "pending" ? "" : `<div class="btnrow"><button type="button" class="btn ${state === "approved" ? "" : "primary"}" id="kycGo">${ic("camera")} ${state === "approved" ? "Update My KYC" : state === "rejected" ? "Do KYC Again" : "Start KYC Verification"}</button></div>`}`;
    if ($("#kycGo", el)) $("#kycGo", el).onclick = () => startKyc(() => kycCard(el));
    const h = $(".me-main h2"); if (h && state === "approved" && !$(".kyc-badge", h)) h.insertAdjacentHTML("beforeend", kycBadgeHtml);
  }

  // ---------- the live face check ----------
  const tiny = (video, n = 48) => { // a small grey picture of the camera, to measure movement and light
    const c = document.createElement("canvas"); c.width = n; c.height = n;
    const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(video, 0, 0, n, n);
    const d = g.getImageData(0, 0, n, n).data, out = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) out[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
    return out;
  };
  const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
  const light = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const shot = (video) => new Promise((res) => {
    const w = Math.min(720, video.videoWidth || 640), h = Math.round(w * ((video.videoHeight || 480) / (video.videoWidth || 640)));
    const c = document.createElement("canvas"); c.width = w; c.height = h; c.getContext("2d").drawImage(video, 0, 0, w, h);
    c.toBlob((b) => res(b), "image/jpeg", 0.85);
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function liveCheck(box) {
    const video = $("video", box), say = $(".kyc-say", box), bar = $(".kyc-bar i", box);
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }); }
    catch (e) { throw new Error(/NotAllowed|Security/.test(e.name) ? "The camera is blocked. Allow the camera for this website, then try again." : "The camera could not start. Close other apps that use the camera, then try again."); }
    video.srcObject = stream; await video.play().catch(() => {});
    await wait(900);
    const fd = "FaceDetector" in window ? new window.FaceDetector({ fastMode: true, maxDetectedFaces: 2 }) : null;
    const moves = pickMoves(), photos = [], frames = [], steps = [];
    const t0 = Date.now();
    try {
      for (let k = 0; k < moves.length; k++) {
        const [code, text] = moves[k];
        say.textContent = text; box.dataset.move = code;
        let micro = 0, n = 0, prev = tiny(video);
        for (let s = 3; s > 0; s--) { // a short countdown; the small movements are measured meanwhile
          $(".kyc-count", box).textContent = s;
          for (let j = 0; j < 4; j++) { await wait(220); const t = tiny(video); micro += diff(prev, t); n++; prev = t; }
        }
        $(".kyc-count", box).textContent = "📸";
        const f = tiny(video), blob = await shot(video);
        let faces = null;
        if (fd) { try { faces = (await fd.detect(video)).length; } catch { faces = null; } }
        photos.push(blob); frames.push(f);
        steps.push({ move: code, light: Math.round(light(f)), micro: +(micro / n).toFixed(2), faces, change: k ? +diff(frames[k - 1], f).toFixed(2) : 0 });
        bar.style.width = `${Math.round(((k + 1) / moves.length) * 100)}%`;
        await wait(350);
      }
    } finally { stream.getTracks().forEach((t) => t.stop()); }
    // passed: good light; the face moved between the moves (a still photo or a screen barely changes); a face when it can be seen
    const moved = steps.slice(1).filter((s) => s.change >= 3).length, alive = steps.reduce((s, x) => s + x.micro, 0) / steps.length;
    const lightOk = steps.every((s) => s.light >= 35 && s.light <= 235), faceOk = !fd || steps[0].faces >= 1;
    const passed = lightOk && moved >= 2 && alive >= 0.6 && faceOk;
    return { photos, liveness: { passed, moves: steps, moved, alive: +alive.toFixed(2), light_ok: lightOk, face_detector: !!fd, face_ok: faceOk, duration_ms: Date.now() - t0,
      when: new Date().toISOString(), screen: `${screen.width}x${screen.height}`, why: passed ? "" : !lightOk ? "light" : !faceOk ? "face" : "movement" } };
  }


  // ---------- 3.79: the ID photo: scanned in a card-shaped frame or chosen from the phone, CROPPED TO THE CARD
  // automatically, and adjustable by hand (drag the corners, rotate) before it is used ----------
  const CARD = 85.6 / 53.98; // an ID card (ID-1 size)
  const loadImg = (src) => new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error("This picture could not be read. Use a JPG or PNG photo.")); i.src = src; });
  // where the card is in a photo: the part that differs from the background around the edges of the photo
  function autoBox(img) {
    const iw = img.naturalWidth, ih = img.naturalHeight, k = 360 / Math.max(iw, ih);
    const W = Math.max(8, Math.round(iw * k)), H = Math.max(8, Math.round(ih * k));
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    const band = Math.max(2, Math.round(Math.min(W, H) * 0.04)), rs = [], gs = [], bs = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (x >= band && x < W - band && y >= band && y < H - band) continue;
      const i = (y * W + x) * 4; rs.push(d[i]); gs.push(d[i + 1]); bs.push(d[i + 2]);
    }
    const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
    const br = med(rs), bg = med(gs), bb = med(bs);
    const dist = new Float32Array(W * H), hist = new Array(256).fill(0);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) { const v = Math.abs(d[i] - br) + Math.abs(d[i + 1] - bg) + Math.abs(d[i + 2] - bb); dist[j] = v; hist[Math.min(255, Math.round(v / 3))]++; }
    // Otsu: the best cut between background and card
    let sum = 0, sumB = 0, wB = 0, best = 0, cut = 20; const total = W * H;
    for (let t = 0; t < 256; t++) sum += t * hist[t];
    for (let t = 0; t < 256; t++) { wB += hist[t]; if (!wB) continue; const wF = total - wB; if (!wF) break; sumB += t * hist[t]; const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) ** 2; if (v > best) { best = v; cut = t; } }
    const T = Math.max(12, Math.round(cut * 0.5)) * 3; // half the cut: dark parts of a card (a coloured band) count too
    const on = (x, y) => dist[y * W + x] > T;
    const run = (frac, n, thr) => { let bs0 = -1, be = -1, s0 = -1; for (let i = 0; i <= n; i++) { const yes = i < n && frac(i) > thr; if (yes && s0 < 0) s0 = i; if (!yes && s0 >= 0) { if (i - s0 > be - bs0) { bs0 = s0; be = i; } s0 = -1; } } return bs0 < 0 ? null : [bs0, be]; };
    const colF = (y0, y1) => (x) => { let n = 0; for (let y = y0; y < y1; y++) n += on(x, y); return n / (y1 - y0); };
    const rowF = (x0, x1) => (y) => { let n = 0; for (let x = x0; x < x1; x++) n += on(x, y); return n / (x1 - x0); };
    let cx = run(colF(0, H), W, 0.12), ry = cx && run(rowF(cx[0], cx[1]), H, 0.3);
    if (ry) cx = run(colF(ry[0], ry[1]), W, 0.3) || cx;
    if (cx && ry) ry = run(rowF(cx[0], cx[1]), H, 0.3) || ry;
    const fall = () => { const w = Math.min(iw * 0.9, ih * 0.9 * CARD), h = w / CARD; return { x: (iw - w) / 2, y: (ih - h) / 2, w, h, auto: false }; };
    if (!cx || !ry) return fall();
    const pad = 0.006 * Math.max(W, H);
    const x0 = Math.max(0, cx[0] - pad), x1 = Math.min(W, cx[1] + pad), y0 = Math.max(0, ry[0] - pad), y1 = Math.min(H, ry[1] + pad);
    const area = ((x1 - x0) * (y1 - y0)) / (W * H), asp = (x1 - x0) / (y1 - y0);
    if (area < 0.1 || area > 0.985 || !((asp > 1.15 && asp < 2.2) || (asp > 0.45 && asp < 0.87))) return fall();
    return { x: x0 / k, y: y0 / k, w: (x1 - x0) / k, h: (y1 - y0) / k, auto: true };
  }
  const rotate90 = async (img) => {
    const c = document.createElement("canvas"); c.width = img.naturalHeight; c.height = img.naturalWidth;
    const g = c.getContext("2d"); g.translate(c.width / 2, c.height / 2); g.rotate(Math.PI / 2); g.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
    return loadImg(c.toDataURL("image/jpeg", 0.92));
  };
  const cropBlob = (img, b) => new Promise((ok) => {
    const k = Math.min(1, 1600 / Math.max(b.w, b.h)), c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(b.w * k)); c.height = Math.max(1, Math.round(b.h * k));
    c.getContext("2d").drawImage(img, b.x, b.y, b.w, b.h, 0, 0, c.width, c.height);
    c.toBlob((x) => ok(x), "image/jpeg", 0.9);
  });
  // the crop screen: the box starts on the card found; drag its corners or move it; Rotate; Auto Crop; Use This
  function cropEditor(img0, box0, title = "Crop the ID") {
    return new Promise((resolve) => {
      let img = img0, box = box0 || autoBox(img0), settled = false;
      const m = E.modal(title, `<div class="kc-stage"><img alt="ID photo"><div class="kc-box"><i data-h="nw"></i><i data-h="ne"></i><i data-h="sw"></i><i data-h="se"></i></div></div>
        <p class="hint small kc-note"></p>`,
        `<button type="button" class="btn" id="kcRot">↻ Rotate</button><button type="button" class="btn" id="kcAuto">${ic("scan")} Auto Crop</button><button type="button" class="btn" data-x>Cancel</button><button type="button" class="btn primary" id="kcUse">${ic("check")} Use This</button>`,
        { wide: true, cls: "kc-modal", onClose: () => { if (!settled) { settled = true; resolve(null); } } });
      const el = m.el, stage = $(".kc-stage", el), pic = $("img", stage), bx = $(".kc-box", el);
      let sc = 1; // shown pixels per photo pixel
      const draw = () => { bx.style.cssText = `left:${box.x * sc}px;top:${box.y * sc}px;width:${box.w * sc}px;height:${box.h * sc}px`; };
      const note = () => { $(".kc-note", el).textContent = box.auto ? "The card was found and cropped. Drag the corners if it needs a change." : "Drag the corners of the box to the corners of the card."; };
      const fit = () => { sc = pic.clientWidth / img.naturalWidth || 1; draw(); };
      const set = (i, b) => { img = i; box = b; pic.onload = fit; pic.src = i.src; note(); };
      set(img, box);
      addEventListener("resize", fit);
      let drag = null;
      stage.addEventListener("pointerdown", (e) => {
        const h = e.target.dataset?.h || (e.target === bx ? "move" : null); if (!h) return;
        e.preventDefault(); stage.setPointerCapture?.(e.pointerId); drag = { h, x: e.clientX, y: e.clientY, b: { ...box } };
      });
      stage.addEventListener("pointermove", (e) => {
        if (!drag) return;
        const dx = (e.clientX - drag.x) / sc, dy = (e.clientY - drag.y) / sc, b = { ...drag.b }, min = 40, W = img.naturalWidth, H = img.naturalHeight;
        if (drag.h === "move") { b.x = Math.min(Math.max(0, b.x + dx), W - b.w); b.y = Math.min(Math.max(0, b.y + dy), H - b.h); }
        else {
          if (drag.h.includes("w")) { const nx = Math.min(Math.max(0, b.x + dx), b.x + b.w - min); b.w += b.x - nx; b.x = nx; }
          if (drag.h.includes("e")) b.w = Math.min(Math.max(min, b.w + dx), W - b.x);
          if (drag.h.includes("n")) { const ny = Math.min(Math.max(0, b.y + dy), b.y + b.h - min); b.h += b.y - ny; b.y = ny; }
          if (drag.h.includes("s")) b.h = Math.min(Math.max(min, b.h + dy), H - b.y);
        }
        box = { ...b, auto: false }; draw(); note();
      });
      const up = () => { drag = null; }; stage.addEventListener("pointerup", up); stage.addEventListener("pointercancel", up);
      $("#kcRot", el).onclick = async () => { const r = await rotate90(img); set(r, autoBox(r)); };
      $("#kcAuto", el).onclick = () => { box = autoBox(img); draw(); note(); };
      $("[data-x]", el).onclick = () => m.close();
      $("#kcUse", el).onclick = async () => { const blob = await cropBlob(img, box); settled = true; removeEventListener("resize", fit); m.close(); resolve(blob); };
    });
  }
  // the camera with a card-shaped frame: the photo is cut to the frame, then the crop screen opens (to adjust)
  function idCamera(title) {
    return new Promise(async (resolve) => {
      let stream = null, settled = false;
      const stop = () => stream?.getTracks().forEach((t) => t.stop());
      const m = E.modal(title, `<div class="kc-cam"><video playsinline muted autoplay></video><div class="kc-frame"><b></b></div></div>
        <div class="kyc-say">Put the whole ID inside the frame, flat and in good light, then press Take Photo.</div>`,
        `<button type="button" class="btn" data-x>Cancel</button><button type="button" class="btn primary" id="kcShot">${ic("camera")} Take Photo</button>`,
        { wide: true, cls: "kc-modal", onClose: () => { stop(); if (!settled) { settled = true; resolve(null); } } });
      const el = m.el, video = $("video", el);
      $("[data-x]", el).onclick = () => m.close();
      try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false }); }
      catch (e) { $(".kyc-say", el).textContent = /NotAllowed|Security/.test(e.name) ? "The camera is blocked. Allow the camera for this website, or use Upload Photo." : "The camera could not start. Use Upload Photo."; return; }
      video.srcObject = stream; video.play().catch(() => {});
      $("#kcShot", el).onclick = async () => {
        const vw = video.videoWidth, vh = video.videoHeight; if (!vw) return;
        const c = document.createElement("canvas"); c.width = vw; c.height = vh; c.getContext("2d").drawImage(video, 0, 0);
        const img = await loadImg(c.toDataURL("image/jpeg", 0.92));
        // the frame on the screen -> the same place in the photo (the video fills its box: object-fit cover)
        const cam = $(".kc-cam", el).getBoundingClientRect(), fr = $(".kc-frame", el).getBoundingClientRect();
        const s = Math.max(cam.width / vw, cam.height / vh), ox = (cam.width - vw * s) / 2, oy = (cam.height - vh * s) / 2;
        let x = (fr.left - cam.left - ox) / s, y = (fr.top - cam.top - oy) / s, w = fr.width / s, h = fr.height / s;
        const mg = 0.03 * w; x = Math.max(0, x - mg); y = Math.max(0, y - mg); w = Math.min(vw - x, w + 2 * mg); h = Math.min(vh - y, h + 2 * mg);
        settled = true; stop(); m.close();
        resolve(await cropEditor(img, { x, y, w, h, auto: true }, title));
      };
    });
  }
  // a chosen photo: cropped to the card automatically, then the crop screen opens
  async function idFromFile(file, title) {
    const url = URL.createObjectURL(file);
    try { const img = await loadImg(url); return await cropEditor(img, autoBox(img), title); }
    finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
  }

  // ---------- the KYC steps (a window): 1 the ID, 2 the live face check, 3 confirm and send ----------
  function startKyc(done) {
    if (!navigator.mediaDevices?.getUserMedia) return toast("The camera does not work in this browser. Use Chrome on your phone or computer.", true);
    const st = { front: null, back: null, live: null };
    const m = E.modal("KYC Verification", `<div class="kyc-win">
      <ol class="kyc-steps"><li class="on" data-s="1">ID</li><li data-s="2">LIVE FACE</li><li data-s="3">SEND</li></ol>
      <section data-p="1">
        <div class="fields wide">
          <label for="kyType">Type of ID</label><select id="kyType"><option value="">— Choose —</option>${ID_TYPES.map((t) => `<option>${esc(t)}</option>`).join("")}</select>
          <label for="kyNo">ID Number</label><input type="text" id="kyNo" maxlength="40" autocomplete="off" style="text-transform:uppercase">
          <label for="kyExp">Expiry Date <small class="muted">(if any)</small></label><input type="date" id="kyExp">
          <label for="kyBirth">Date of Birth</label><input type="date" id="kyBirth">
        </div>
        <div class="kyc-ids">
          ${["front", "back"].map((k) => `<div class="kyc-pic" data-side="${k}"><span>${ic("idcard")} ${k === "front" ? "FRONT OF THE ID" : "BACK OF THE ID <small>(optional)</small>"}</span><img alt="" hidden>
            <div class="btnrow"><button type="button" class="btn primary small" data-scan="${k}">${ic("camera")} Scan ID</button><label class="btn small" for="ky_${k}">${ic("image")} Upload Photo</label>
            <button type="button" class="btn small" data-adj="${k}" hidden>✂ Adjust Crop</button></div><input type="file" id="ky_${k}" accept="image/*" hidden></div>`).join("")}
        </div>
        <p class="hint small">Scan ID: put the card in the frame. The photo is cropped to the card automatically; press Adjust Crop to change it. No glare, the words readable.</p>
      </section>
      <section data-p="2" hidden>
        <div class="kyc-cam"><video playsinline muted></video><div class="kyc-oval"></div><div class="kyc-count"></div></div>
        <div class="kyc-say">Put your face inside the oval, in good light. Then press Start and follow the moves on the screen.</div>
        <div class="kyc-bar"><i></i></div>
        <div id="kyLiveRes"></div>
      </section>
      <section data-p="3" hidden><div id="kySum"></div>
        <label class="lg-agree"><input type="checkbox" id="kyAgree"> <span>I confirm that this is <b>me</b> and my <b>real ID</b>. I agree that ${esc(E.C?.company?.name || "EMON OVERRUNS")} keeps this KYC data (ID, photos, live face check) to verify my identity, under the Data Privacy Act of 2012 (RA 10173).</span></label>
      </section></div>`,
      `<button type="button" class="btn" data-x>Cancel</button><button type="button" class="btn" id="kyBackBtn" hidden>Back</button><button type="button" class="btn primary" id="kyNext">Next</button>`, { wide: true });
    const el = m.el;
    let page = 1;
    const show = (p) => {
      page = p;
      $$("[data-p]", el).forEach((s) => (s.hidden = s.dataset.p !== String(p)));
      $$(".kyc-steps li", el).forEach((li) => li.classList.toggle("on", Number(li.dataset.s) <= p));
      $("#kyBackBtn", el).hidden = p === 1;
      $("#kyNext", el).innerHTML = p === 2 ? (st.live?.liveness.passed ? "Next" : `${ic("camera")} Start Live Check`) : p === 3 ? `${ic("check")} Submit & Verify` : "Next";
    };
    const raw = {}; // the full photo of each side (to adjust the crop again)
    const put = (k, blob) => {
      if (!blob) return;
      st[k] = new File([blob], `id-${k}.jpg`, { type: "image/jpeg" });
      const box = $(`[data-side="${k}"]`, el), img = $("img", box);
      img.src = URL.createObjectURL(st[k]); img.hidden = false; box.classList.add("done"); $(`[data-adj="${k}"]`, el).hidden = false;
    };
    const titleOf = (k) => (k === "front" ? "Front of the ID" : "Back of the ID");
    ["front", "back"].forEach((k) => {
      $(`[data-scan="${k}"]`, el).onclick = async () => put(k, await idCamera(titleOf(k)));
      $(`#ky_${k}`, el).onchange = async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (!f) return; raw[k] = f; try { put(k, await idFromFile(f, titleOf(k))); } catch (err) { toast(err.message, true); } };
      $(`[data-adj="${k}"]`, el).onclick = async () => { const src = raw[k] || st[k]; if (src) put(k, await idFromFile(src, titleOf(k))); };
    });
    $("[data-x]", el).onclick = () => { $$("video", el).forEach((v) => v.srcObject?.getTracks?.().forEach((t) => t.stop())); m.close(); };
    $("#kyBackBtn", el).onclick = () => show(page - 1);
    $("#kyNext", el).onclick = async (e) => {
      const btn = e.currentTarget;
      if (page === 1) {
        if (!$("#kyType", el).value) return toast("Choose the type of ID.", true);
        if ($("#kyNo", el).value.trim().length < 3) return toast("Type the ID number.", true);
        if (!st.front) return toast("Scan or upload the front of the ID.", true);
        return show(2);
      }
      if (page === 2) {
        if (st.live?.liveness.passed) return summary();
        btn.disabled = true; $("#kyLiveRes", el).innerHTML = "";
        try { st.live = await liveCheck($("[data-p='2']", el)); }
        catch (err) { btn.disabled = false; $(".kyc-say", el).textContent = err.message; return toast(err.message, true); }
        btn.disabled = false;
        const L = st.live.liveness;
        $("#kyLiveRes", el).innerHTML = L.passed ? `<div class="banner ok">✅ LIVE FACE CHECK PASSED — ${st.live.photos.length} photos taken.</div>`
          : `<div class="banner warn">❌ The live face check did not pass: ${L.why === "light" ? "the light is too dark or too bright" : L.why === "face" ? "no face was seen" : "your face did not move with the moves (a photo or a screen does not pass)"}. Try again in good light and follow each move.</div>`;
        $(".kyc-say", el).textContent = L.passed ? "Done. Press Next." : "Press Start Live Check to try again.";
        if (!L.passed) st.live = null;
        return show(2);
      }
      if (!$("#kyAgree", el).checked) return toast("Tick the box to confirm.", true);
      btn.disabled = true; btn.innerHTML = `<span class="spin sm"></span> Sending…`;
      try {
        const base = `kyc/${S.profile.id}/${Date.now()}`;
        const up = async (blob, name) => {
          const path = `${base}-${name}.jpg`;
          const r = await sb.storage.from("records").upload(path, blob, { contentType: "image/jpeg" });
          if (r.error) throw r.error;
          return path;
        };
        const front = await up(st.front, "id-front"), back = st.back ? await up(st.back, "id-back") : "";
        const selfies = [];
        for (let i = 0; i < st.live.photos.length; i++) selfies.push(await up(st.live.photos[i], `face-${i + 1}-${st.live.liveness.moves[i].move}`));
        const { error } = await sb.rpc("submit_kyc", { p: { id_type: $("#kyType", el).value, id_number: $("#kyNo", el).value.trim(), id_expiry: $("#kyExp", el).value || null,
          birth_date: $("#kyBirth", el).value || null, id_front: front, id_back: back, selfies, liveness: st.live.liveness,
          device: `${navigator.userAgent}`.slice(0, 400) } });
        if (error) throw error;
        m.close(); idsMemo = null; toast("✅ KYC VERIFIED — your ID and live face check are done."); done?.();
      } catch (err) { btn.disabled = false; show(3); fail(err, /submit_kyc|schema cache|PGRST202/.test(err.message || "") ? "Run the database update 082_kyc.sql first" : "Could not send the KYC"); }
    };
    const summary = () => {
      const ids = [st.front, st.back].filter(Boolean).map((b) => URL.createObjectURL(b)), faces = st.live.photos.map((b) => URL.createObjectURL(b));
      $("#kySum", el).innerHTML = `<table class="grid kyc-tbl"><tbody><tr><th>Type of ID</th><td>${esc($("#kyType", el).value)}</td></tr><tr><th>ID Number</th><td>${esc($("#kyNo", el).value.trim().toUpperCase())}</td></tr>
        ${$("#kyExp", el).value ? `<tr><th>Expiry</th><td>${esc(E.mdy($("#kyExp", el).value))}</td></tr>` : ""}${$("#kyBirth", el).value ? `<tr><th>Date of Birth</th><td>${esc(E.mdy($("#kyBirth", el).value))}</td></tr>` : ""}
        <tr><th>Live Face Check</th><td>✅ PASSED · ${st.live.photos.length} photos</td></tr></tbody></table>
        <div class="kyc-thumbs ids">${ids.map((u) => `<img class="id" src="${u}" alt="ID">`).join("")}</div><div class="kyc-thumbs">${faces.map((u) => `<img src="${u}" alt="Face">`).join("")}</div>`;
      show(3);
    };
    show(1);
  }

  // ---------- EMON HASAN: the KYC Verification page ----------
  V.kyc = async (filter = "approved") => {
    if (!isAdmin()) { location.hash = "dashboard"; return; }
    E.shell("kyc", "KYC Verification", `<div class="tabs" id="kyF">${[["approved", "KYC Verified"], ["rejected", "Revoked / Not Approved"], ["pending", "Waiting"], ["", "All"]].map(([k, l]) => `<button type="button" data-f="${k}" class="${k === filter ? "on" : ""}">${l}</button>`).join("")}</div><div id="kyRes">${busy()}</div>`,
      "Every login can verify who they are (optional): the ID and a live face check by the camera. When the live check passes, the KYC is VERIFIED at once (EVA AI) and the badge shows on the employee. Open one to see the ID and face photos; <b>Revoke</b> it with the reason if anything is wrong.");
    const here = E.stillHere();
    let q = sb.from("kyc_verifications").select("*").order("submitted_at", { ascending: false }).limit(500);
    q = filter ? q.eq("status", filter) : q.neq("status", "replaced");
    const { data, error } = await q;
    if (!here()) return;
    $$("#kyF [data-f]").forEach((b) => (b.onclick = () => V.kyc(b.dataset.f)));
    if (error) { $("#kyRes").innerHTML = `<div class="empty">Run the database update <b>082_kyc.sql</b> first.</div>`; return; }
    const rows = data || [];
    $("#kyRes").innerHTML = E.grid({ cols: [{ label: "Sent", get: (r) => E.dateTime(r.submitted_at) }, { label: "Ref No", get: (r) => r.ref_no || "" }, { label: "Name", get: (r) => r.full_name || r.email || "" },
      { label: "ID", get: (r) => `${r.id_type} · ${r.id_number}` }, { label: "Live Face", get: (r) => (r.liveness?.passed ? "✅ PASSED" : "❌") }, { label: "Status", html: (r) => pill(r.status) }],
      rows, onRow: true, empty: "No KYC here." });
    E.bindGrid($("#kyRes"), rows, (r) => review(r));
    E.setRecords?.(`KYC: ${rows.length}`);
  };
  async function review(r) {
    const paths = [r.id_front_path, r.id_back_path, ...(r.selfie_paths || [])].filter(Boolean);
    const urls = await Promise.all(paths.map((p) => E.signedUrl(p, 1800).catch(() => "")));
    const label = (p) => (p === r.id_front_path ? "ID FRONT" : p === r.id_back_path ? "ID BACK" : `FACE · ${String(p.match(/face-\d+-(\w+)/)?.[1] || "").toUpperCase()}`);
    const L = r.liveness || {};
    const m = E.modal(`KYC ${r.ref_no || ""} — ${r.full_name || ""}`, `<div class="kyc-rev">
      <div class="kyc-gal">${paths.map((p, i) => `<figure class="${/^ID/.test(label(p)) ? "id" : ""}"><img src="${esc(urls[i] || "")}" alt="${esc(label(p))}" data-big="${esc(urls[i] || "")}"><figcaption>${esc(label(p))}</figcaption></figure>`).join("")}</div>
      <table class="grid kyc-tbl"><tbody>
        <tr><th>Name</th><td>${esc(r.full_name || "")} · ${esc(r.email || "")} · ${esc((r.role || "").toUpperCase())}</td></tr>
        <tr><th>Type of ID</th><td>${esc(r.id_type)}</td></tr><tr><th>ID Number</th><td><b>${esc(r.id_number)}</b></td></tr>
        ${r.id_expiry ? `<tr><th>Expiry</th><td>${esc(E.mdy(r.id_expiry))}</td></tr>` : ""}${r.birth_date ? `<tr><th>Date of Birth</th><td>${esc(E.mdy(r.birth_date))}</td></tr>` : ""}
        <tr><th>Live Face Check</th><td>${L.passed ? "✅ PASSED" : "❌ NOT PASSED"} · moves: ${esc((L.moves || []).map((x) => `${x.move.toUpperCase()} (change ${x.change})`).join(", "))} · movement ${esc(String(L.alive ?? ""))}${L.face_detector ? ` · face seen: ${L.face_ok ? "YES" : "NO"}` : ""}</td></tr>
        <tr><th>Sent</th><td>${esc(E.dateTime(r.submitted_at))} · IP ${esc(r.ip_address || "")}</td></tr>
        <tr><th>Status</th><td>${pill(r.status)}${r.reviewed_at ? ` · ${esc(r.reviewed_by_name || "")} · ${esc(E.dateTime(r.reviewed_at))}` : ""}${r.review_note ? ` · ${esc(r.review_note)}` : ""}</td></tr></tbody></table>
      ${["pending", "approved"].includes(r.status) ? `<div class="fields wide"><label for="kyNote">Reason (needed to ${r.status === "approved" ? "revoke" : "reject"})</label><input type="text" id="kyNote" maxlength="300" placeholder="e.g. The face does not match the ID / the ID photo is not clear"></div>` : ""}</div>`,
      `<button type="button" class="btn" data-x>Close</button>${r.status === "pending" ? `<button type="button" class="btn danger" id="kyNo">Reject</button><button type="button" class="btn ok" id="kyOk">${ic("check")} Approve · KYC VERIFIED</button>` : r.status === "approved" ? `<button type="button" class="btn danger" id="kyNo">Revoke KYC</button>` : ""}`, { wide: true });
    $("[data-x]", m.el).onclick = m.close;
    $$("[data-big]", m.el).forEach((img) => (img.onclick = () => img.dataset.big && E.lightbox?.(img.dataset.big, img.alt)));
    const decide = async (ok) => {
      const note = $("#kyNote", m.el)?.value.trim() || "";
      if (!ok && !note) { toast("Type the reason.", true); return $("#kyNote", m.el).focus(); }
      const { error } = await sb.rpc("decide_kyc", { p_id: r.id, p_ok: ok, p_note: note });
      if (error) return fail(error, "Could not decide");
      m.close(); idsMemo = null; toast(ok ? `${r.full_name || "The login"} is KYC VERIFIED.` : `${r.status === "approved" ? "Revoked" : "Rejected"}. The person is told the reason.`); V.kyc(ok ? "approved" : "rejected");
    };
    if ($("#kyOk", m.el)) $("#kyOk", m.el).onclick = () => decide(true);
    if ($("#kyNo", m.el)) $("#kyNo", m.el).onclick = () => decide(false);
  }

  Object.assign(E, { kycCard, startKyc, kycIds, kycBadgeHtml });
})();
