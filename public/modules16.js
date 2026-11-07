/* EMON OVERRUNS E-PORTAL - 3.80: DEVICE LOGIN (A NEW DEVICE WAITS FOR APPROVAL)
   The device a login uses is registered automatically (the first device, and every device already in use for the first
   days after the update). A sign in on a NEW device waits on "NEW DEVICE - WAITING FOR APPROVAL" until EMON HASAN approves
   it on OTHER > Devices (EMON HASAN's own new device: from his other device). The server gives a login's data only to its
   approved devices (085_devices.sql). Every login sees its own devices on My Profile and can remove the old ones. */
(() => {
  const E = window.EO;
  const V = (window.EO_VIEWS = window.EO_VIEWS || {});
  const { sb, S, esc, $, $$, isAdmin, toast, fail, ic, busy } = E;

  const ST = { approved: ["approved", "APPROVED"], pending: ["pending", "WAITING FOR APPROVAL"], blocked: ["rejected", "BLOCKED"], removed: ["closed", "REMOVED"] };
  const pill = (s) => E.pill(...(ST[s] || ST.removed));
  const missing = (e) => /device_check|device_decide|user_devices|does not exist|schema cache|PGRST202|PGRST205|42883|42P01/.test(`${e?.message || ""} ${e?.code || ""}`);

  // the device's name, from the browser: e.g. IPAD · SAFARI (HOME SCREEN APP)
  function deviceName() {
    const ua = navigator.userAgent || "";
    const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const os = ipad ? "iPad" : /iPhone/.test(ua) ? "iPhone" : /Android/.test(ua) ? (/Mobile/.test(ua) ? "Android Phone" : "Android Tablet")
      : /Windows/.test(ua) ? "Windows PC" : /CrOS/.test(ua) ? "Chromebook" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux PC" : "Device";
    const br = window.EOApp ? "E-Portal App" : /EdgA?\/|EdgiOS/.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "Samsung Internet" : /CriOS|Chrome\//.test(ua) ? "Chrome"
      : /FxiOS|Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
    let app = false;
    try { app = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true; } catch { /* old browser */ }
    return `${os} · ${br}${app && !window.EOApp ? " (Home Screen App)" : ""}`.toUpperCase();
  }

  // ---------- the gate after signing in (before the agreements) ----------
  let checking = null, poll = null;
  async function deviceGate() {
    if (!S.session || !S.profile) return false;
    if (S.profile.status !== "active") return true; // applicants: no company data
    // checked again every 5 minutes while in use (a device removed or blocked meanwhile shows the gate)
    if (S.deviceOk === S.profile.id && Date.now() - (S.deviceAt || 0) < 300000) return true;
    if ($(".dev-ov")) return false;
    if (checking) return checking;
    checking = (async () => {
      const { data, error } = await sb.rpc("device_check", { p_device: E.deviceId, p_name: deviceName() });
      if (error) {
        if (missing(error)) { S.deviceOk = S.profile.id; S.deviceAt = Date.now() + 864e5; return true; } // the server has not 085 yet
        if (S.deviceOk === S.profile.id) return true; // a re-check that failed (e.g. no internet): the page stays
        show({ error: error.message });
        return false;
      }
      if (data?.status === "approved") { S.deviceOk = S.profile.id; S.deviceAt = Date.now(); S.deviceInfo = data; return true; }
      S.deviceOk = null;
      show(data || {});
      return false;
    })().finally(() => { checking = null; });
    return checking;
  }
  function show(d) {
    clearInterval(poll);
    const blocked = d.status === "blocked", admin = !!d.admin;
    const ov = document.createElement("div");
    ov.className = "dev-ov";
    ov.innerHTML = `<div class="legal-win dev-win" role="dialog" aria-modal="true" aria-labelledby="dvTitle">
      <div class="legal-head">${E.logoHtml("lg-logo")}<div><b id="dvTitle">${d.error ? "THIS DEVICE COULD NOT BE CHECKED" : blocked ? "THIS DEVICE IS BLOCKED" : "NEW DEVICE — WAITING FOR APPROVAL"}</b><small>${esc(E.APP)} · Device Login</small></div></div>
      <div class="dev-body">
        <div class="dev-ic ${blocked || d.error ? "bad" : ""}">${ic(blocked ? "x" : d.error ? "globe" : "device")}</div>
        <div class="dev-name"><small>THIS DEVICE</small><b>${esc(d.name || deviceName())}</b></div>
        ${d.error ? `<p>${esc(d.error)}</p><p>Check the internet connection and press <b>Check Again</b>.</p>`
          : blocked ? `<p>EMON HASAN blocked this device. It cannot open the E-Portal. Use your approved device, or ask EMON HASAN.</p>`
          : `<p>You signed in on a <b>new device</b>. For your safety, a new device must be approved before the E-Portal opens.</p>
             <p>${admin ? "Approve it from your <b>other device</b>: <b>OTHER &gt; Devices</b>. It opens here by itself." : "<b>EMON HASAN</b> is told now. When he approves it, the E-Portal opens here by itself."}</p>`}
        <small class="muted">Signed in as ${esc(S.profile?.full_name || S.profile?.email || "")}.</small>
      </div>
      <div class="legal-foot"><div class="btnrow"><button type="button" class="btn" id="dvOut">${ic("out")} Sign Out</button>
        ${blocked ? "" : `<button type="button" class="btn primary" id="dvAgain">${ic("check")} Check Again</button>`}</div></div></div>`;
    document.body.appendChild(ov);
    const close = () => { clearInterval(poll); ov.remove(); };
    const again = async (quiet) => {
      const btn = $("#dvAgain", ov);
      if (btn) btn.disabled = true;
      const { data, error } = await sb.rpc("device_check", { p_device: E.deviceId, p_name: deviceName() });
      if (btn) btn.disabled = false;
      if (!ov.isConnected) return;
      if (!error && data?.status === "approved") { close(); S.deviceOk = S.profile?.id; S.deviceAt = Date.now(); S.deviceInfo = data; toast("This device is approved."); E.route(); return; }
      if (!error && data?.status === "blocked" && !blocked) { close(); show(data); return; }
      if (!quiet) toast(error ? error.message : "Not approved yet. Please wait.", !!error);
    };
    $("#dvOut", ov).onclick = async () => { close(); S.deviceOk = null; await sb.auth.signOut({ scope: "local" }); };
    if ($("#dvAgain", ov)) $("#dvAgain", ov).onclick = () => again(false);
    if (!blocked) poll = setInterval(() => (ov.isConnected && !document.hidden ? again(true) : null), 15000);
  }

  // ---------- OTHER > Devices (EMON HASAN) ----------
  const fmt = (t) => (t ? E.dateTime(t) : "");
  V.devices = async (filter = "pending") => {
    if (!isAdmin()) { location.hash = "dashboard"; return; }
    E.shell("devices", "Devices", `<div id="dvSet"></div><div class="tabs" id="dvF">${[["pending", "Waiting for Approval"], ["approved", "Approved"], ["blocked", "Blocked"], ["removed", "Removed"], ["", "All"]].map(([k, l]) => `<button type="button" data-f="${k}" class="${k === filter ? "on" : ""}">${l}</button>`).join("")}</div><div id="dvRes">${busy()}</div>`,
      "The device every login uses. The devices in use were registered automatically; a sign in on a <b>new device</b> waits here until you approve it. <b>Block</b> a device that is not theirs; <b>Remove</b> signs a device out (it then needs approval again).");
    const here = E.stillHere();
    let q = sb.from("user_devices_list").select("*").order("last_seen", { ascending: false }).limit(500);
    if (filter) q = q.eq("status", filter);
    const [{ data, error }, set] = await Promise.all([q, sb.from("company_settings").select("device_approval, device_grace_until").eq("id", 1).maybeSingle()]);
    if (!here()) return;
    $$("#dvF [data-f]").forEach((b) => (b.onclick = () => V.devices(b.dataset.f)));
    if (error) { $("#dvRes").innerHTML = `<div class="empty">Run the database update <b>085_devices.sql</b> first.</div>`; return; }
    const st = set.data || {}, on = st.device_approval !== false, grace = st.device_grace_until && new Date(st.device_grace_until) > new Date() ? st.device_grace_until : null;
    $("#dvSet").innerHTML = `<div class="dev-set ${on ? "on" : "off"}">${ic(on ? "shield" : "x")}<div><b>NEW DEVICE APPROVAL: ${on ? "ON" : "OFF"}</b>
        <small>${on ? (grace ? `Devices in use are registered automatically until ${esc(fmt(grace))}; after that a new device waits for your approval.` : "A sign in on a new device waits for your approval.") : "Every device is registered automatically (no approval)."}</small></div>
      <span class="grow"></span>${on && grace ? `<button type="button" class="btn" id="dvEnd">${ic("clock")} Start Approval Now</button>` : ""}
      <button type="button" class="btn ${on ? "danger" : "ok"}" id="dvTog">${on ? "Turn Off" : `${ic("check")} Turn On`}</button></div>`;
    const setIt = async (p) => {
      const { error: e } = await sb.rpc("device_settings", p);
      if (e) return fail(e, "Could not change the device approval");
      toast("Saved."); V.devices(filter);
    };
    if ($("#dvEnd")) $("#dvEnd").onclick = async () => { if (await E.confirmBox("Start the approval now? From now on, every <b>new device</b> waits for your approval.", { ok: "Start Now" })) setIt({ p_on: null, p_end_grace: true }); };
    $("#dvTog").onclick = async () => {
      if (on && !(await E.confirmBox("<b>Turn off the new device approval?</b><br><br>Any device can then sign in with the password only.", { ok: "Turn Off", danger: true }))) return;
      setIt({ p_on: !on, p_end_grace: false });
    };
    const rows = data || [];
    $("#dvRes").innerHTML = E.grid({ cols: [{ label: "Login", get: (r) => r.full_name || r.email || "" }, { label: "Access", get: (r) => E.roleName(r.role).toUpperCase() },
      { label: "Device", html: (r) => `${esc(r.name || "UNKNOWN DEVICE")}${r.device_id === E.deviceId ? ` <span class="pill approved">THIS DEVICE</span>` : ""}` },
      { label: "Status", html: (r) => pill(r.status) }, { label: "How", get: (r) => r.how || "" }, { label: "IP Address", get: (r) => r.ip_address || "" },
      { label: "First Seen", get: (r) => fmt(r.first_seen) }, { label: "Last Seen", get: (r) => fmt(r.last_seen) }],
      rows, onRow: true, empty: filter === "pending" ? "No device is waiting for approval." : "No devices here." });
    E.bindGrid($("#dvRes"), rows, (r) => open(r, () => V.devices(filter)));
    E.setRecords?.(`Devices: ${rows.length}`);
  };
  function open(r, after) {
    const self = r.device_id === E.deviceId;
    const m = E.modal(`Device — ${r.full_name || r.email || ""}`, `<table class="grid kyc-tbl"><tbody>
        <tr><th>Login</th><td>${esc(r.full_name || "")} · ${esc(r.email || "")} · ${esc(E.roleName(r.role).toUpperCase())}</td></tr>
        <tr><th>Device</th><td><b>${esc(r.name || "UNKNOWN DEVICE")}</b>${self ? " · THIS DEVICE" : ""}</td></tr>
        <tr><th>Status</th><td>${pill(r.status)}${r.how ? ` · ${esc(r.how)}` : ""}${r.decided_at ? ` · ${esc(fmt(r.decided_at))}` : ""}</td></tr>
        <tr><th>IP Address</th><td>${esc(r.ip_address || "—")}</td></tr>
        <tr><th>First Seen</th><td>${esc(fmt(r.first_seen))}</td></tr><tr><th>Last Seen</th><td>${esc(fmt(r.last_seen))}</td></tr></tbody></table>`,
      `<button type="button" class="btn" data-x>Close</button>
       ${r.status !== "blocked" && !self ? `<button type="button" class="btn danger" data-a="block">${ic("x")} Block</button>` : ""}
       ${r.status !== "removed" && !self ? `<button type="button" class="btn" data-a="remove">${ic("trash")} Remove</button>` : ""}
       ${r.status !== "approved" ? `<button type="button" class="btn ok" data-a="approve">${ic("check")} Approve Device</button>` : ""}`);
    $("[data-x]", m.el).onclick = m.close;
    $$("[data-a]", m.el).forEach((b) => (b.onclick = async () => {
      const a = b.dataset.a;
      if (a !== "approve" && !(await E.confirmBox(`${a === "block" ? "Block" : "Remove"} <b>${esc(r.name || "this device")}</b> of ${esc(r.full_name || r.email || "")}? ${a === "block" ? "It cannot open the E-Portal until you approve it again." : "It is signed out and needs approval again."}`, { ok: a === "block" ? "Block" : "Remove", danger: true }))) return;
      b.disabled = true;
      const { error } = await sb.rpc("device_decide", { p_id: r.id, p_action: a });
      b.disabled = false;
      if (error) return fail(error, "Could not change the device");
      m.close(); toast(a === "approve" ? "Device approved. It opens by itself." : a === "block" ? "Device blocked." : "Device removed."); after?.();
    }));
  }

  // ---------- My Profile: my devices ----------
  async function myDevices(el) {
    if (!el || !S.profile) return;
    const { data, error } = await sb.from("user_devices").select("*").eq("user_id", S.profile.id).neq("status", "removed").order("last_seen", { ascending: false });
    if (!el.isConnected) return;
    if (error) { el.hidden = true; return; }
    el.hidden = false;
    const rows = data || [];
    el.innerHTML = `<legend>My Devices</legend><p class="muted">The devices you sign in on. A new device waits for approval by EMON HASAN. Remove a device you no longer use.</p>
      <div class="dev-list">${rows.map((r) => `<div class="dev-row">${ic("device")}<div><b>${esc(r.name || "UNKNOWN DEVICE")}${r.device_id === E.deviceId ? ` <span class="pill approved">THIS DEVICE</span>` : ""}</b>
        <small>${pill(r.status)} · last used ${esc(fmt(r.last_seen))}</small></div>${r.device_id !== E.deviceId ? `<button type="button" class="btn small" data-rm="${esc(r.id)}">${ic("trash")} Remove</button>` : ""}</div>`).join("") || `<div class="muted">No devices yet.</div>`}</div>`;
    $$("[data-rm]", el).forEach((b) => (b.onclick = async () => {
      const r = rows.find((x) => x.id === b.dataset.rm);
      if (!(await E.confirmBox(`Remove <b>${esc(r?.name || "this device")}</b>? It is signed out and needs approval again.`, { ok: "Remove", danger: true }))) return;
      const { error: e } = await sb.rpc("device_decide", { p_id: b.dataset.rm, p_action: "remove" });
      if (e) return fail(e, "Could not remove the device");
      toast("Device removed."); myDevices(el);
    }));
  }

  Object.assign(E, { deviceGate, deviceName, myDevices });
})();
