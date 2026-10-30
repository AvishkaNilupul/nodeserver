/* "Listings & sales" tab on /epic-accounts.html.
   Epic accounts listed on Eldorado with Eldorado's own instant delivery: the
   buyer gets the Epic login + a login for our mail page the moment they pay.
   Server side: routes/epicSalesRoutes.js → utils/epicSales.js. */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  let panel = null;
  let tabBtn = null;
  let data = null;
  let refreshTimer = null;
  let loading = false;

  async function api(url, opts) {
    const r = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      ...(opts || {}),
      headers: { "Content-Type": "application/json", ...((opts && opts.headers) || {}) },
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) throw new Error(j.message || "HTTP " + r.status);
    return j;
  }
  const post = (url, body) => api(url, { method: "POST", body: JSON.stringify(body || {}) });

  function say(msg, err) {
    if (typeof window.toast === "function") window.toast(msg, err);
    else alert(msg);
  }

  function ago(d) {
    if (!d) return "never";
    const ms = Date.now() - new Date(d).getTime();
    if (!Number.isFinite(ms)) return "?";
    const m = Math.round(ms / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    const h = Math.round(m / 60);
    if (h < 48) return h + " h ago";
    return Math.round(h / 24) + " days ago";
  }
  function until(d) {
    if (!d) return "";
    const ms = new Date(d).getTime() - Date.now();
    if (!Number.isFinite(ms)) return "";
    if (ms <= 0) return "passed";
    const h = Math.round(ms / 3600000);
    return h < 48 ? "in " + h + " h" : "in " + Math.round(h / 24) + " days";
  }
  function when(d) {
    if (!d) return "—";
    const t = new Date(d);
    return Number.isFinite(t.getTime()) ? t.toLocaleString() : "—";
  }
  function money(n) {
    return n == null || !Number.isFinite(Number(n)) ? "—" : "$" + Number(n).toFixed(2);
  }
  function pill(text, tone) {
    return '<span class="es-pill' + (tone ? " " + tone : "") + '">' + esc(text) + "</span>";
  }

  // ---- tab wiring ---------------------------------------------------------
  function init() {
    const main = document.querySelector("main");
    if (!main || $("epic-sales-panel")) return;
    let tabs = document.querySelector(".epic-tabs");
    if (!tabs) {
      tabs = document.createElement("div");
      tabs.className = "epic-tabs";
      tabs.setAttribute("role", "tablist");
      main.insertBefore(tabs, main.querySelector(".card"));
    }
    tabBtn = document.createElement("button");
    tabBtn.className = "btn";
    tabBtn.id = "epic-sales-tab";
    tabBtn.type = "button";
    tabBtn.setAttribute("role", "tab");
    tabBtn.setAttribute("aria-controls", "epic-sales-panel");
    tabBtn.setAttribute("aria-selected", "false");
    tabBtn.tabIndex = -1;
    tabBtn.textContent = "Listings & sales";
    tabs.append(tabBtn);

    panel = document.createElement("section");
    panel.id = "epic-sales-panel";
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", "epic-sales-tab");
    panel.hidden = true;
    panel.innerHTML = `
      <div class="card">
        <h2>Listings &amp; sales</h2>
        <p class="hint">Epic accounts on Eldorado, G2G and PlayerAuctions with instant delivery. When a buyer pays, the marketplace shows them the Epic login and a login for our mail page. The mail page shows only the emails Epic sends to that account, from the purchase on, for the number of days set below. It closes early when the buyer changes the account's email.</p>
        <div class="es-grid" id="es-health"><div class="muted">Loading…</div></div>
        <div class="es-settings" id="es-settings"></div>
        <div class="row" style="margin-top:12px">
          <button class="btn" type="button" id="es-refresh">Refresh</button>
          <button class="btn" type="button" id="es-sync">Check Eldorado now</button>
        </div>
      </div>
      <div class="card" id="es-dist-card"><h2>Auto-distribute new accounts</h2><p class="hint">Every 10 minutes this decides where each new sellable account goes: PlayerAuctions first (highest price), then an existing Eldorado listing for the same games, then G2G, each up to the limit you set. The rest waits in reserve and fills the next free slot. Accounts you added by hand are never listed automatically, and accounts with no games yet (or a game that is still free on Epic) wait.</p><div id="es-dist"><div class="muted">Loading…</div></div></div>
      <div class="card"><h2>Ready to list</h2><p class="hint">Accounts that can go on sale now, grouped by the games they own. An account sits on one listing at a time, so it can never be sold twice.</p><div id="es-groups"></div></div>
      <div class="card"><h2>G2G (automatic delivery)</h2><p class="hint">G2G offers you made on g2g.com and linked here. When a buyer pays, the server picks a ready account that owns the offer's games, opens its mail page, and fills G2G's account form on the order page (the way G2G wants accounts delivered, never the chat). If it can't, Telegram tells you what to do.</p><div id="es-g2g"></div></div>
      <div class="card"><h2>PlayerAuctions (instant delivery)</h2><p class="hint">One Epic account per native Account offer. Minimum $5, with 14-day buyer mail access and after-sale protection. Uses newly stocked accounts; accounts already in G2G stock stay there. Original-owner contact details are required by PlayerAuctions.</p><div id="es-pa"></div></div>
      <div class="card"><h2>Listings</h2><div id="es-listings"></div></div>
      <div class="card"><h2>Sales</h2><div id="es-sales"></div></div>
      <div class="card"><h2>All accounts</h2><p class="hint">Why each account can or can't be sold right now.</p><div id="es-stock"></div></div>
      <div class="card" id="es-others-card" hidden><h2>Other Epic offers on your Eldorado account</h2><p class="hint">Epic account offers this page didn't create. They are not tracked here.</p><div id="es-others"></div></div>`;
    main.append(panel);
    buildModals();

    tabBtn.addEventListener("click", () => show(true));
    $("es-refresh").addEventListener("click", () => load(true));
    $("es-sync").addEventListener("click", syncNow);

    // The other two tabs belong to epic-account-details.js. Whenever one of
    // their panels shows, this one hides.
    const others = ["epic-claims-panel", "epic-details-panel"].map($).filter(Boolean);
    const mo = new MutationObserver(() => {
      if (!panel.hidden && others.some((p) => !p.hidden)) show(false);
    });
    others.forEach((p) => mo.observe(p, { attributes: true, attributeFilter: ["hidden"] }));
    ["epic-claims-tab", "epic-details-tab"].forEach((id) => {
      const b = $(id);
      if (b) b.addEventListener("click", () => panel.hidden || show(false));
    });
    if (new URLSearchParams(location.search).get("tab") === "sales") show(true);
  }

  function show(on) {
    if (!panel) return;
    if (on) {
      ["epic-claims-panel", "epic-details-panel"].forEach((id) => {
        const p = $(id);
        if (p) p.hidden = true;
      });
      ["epic-claims-tab", "epic-details-tab"].forEach((id) => {
        const b = $(id);
        if (!b) return;
        b.setAttribute("aria-selected", "false");
        b.classList.remove("btn-primary");
        b.tabIndex = -1;
      });
      panel.hidden = false;
      tabBtn.setAttribute("aria-selected", "true");
      tabBtn.classList.add("btn-primary");
      tabBtn.tabIndex = 0;
      history.replaceState(null, "", location.pathname + "?tab=sales");
      load();
      clearInterval(refreshTimer);
      refreshTimer = setInterval(() => {
        if (!document.hidden && !document.querySelector(".es-modal.show")) load();
      }, 60000);
    } else {
      panel.hidden = true;
      tabBtn.setAttribute("aria-selected", "false");
      tabBtn.classList.remove("btn-primary");
      tabBtn.tabIndex = -1;
      clearInterval(refreshTimer);
      if (location.search) history.replaceState(null, "", location.pathname + location.hash);
    }
  }

  // ---- data ---------------------------------------------------------------
  async function load(loud) {
    if (loading) return;
    loading = true;
    try {
      const [j, d] = await Promise.all([
        api("/api/epic/sales/overview"),
        api("/api/epic/sales/distributor").catch((e) => ({ distributor: { error: e.message } })),
      ]);
      data = j;
      data.distributor = d.distributor;
      render();
      if (loud) say("Updated.");
    } catch (e) {
      $("es-health").innerHTML = '<div class="es-err">Failed to load: ' + esc(e.message) + "</div>";
    } finally {
      loading = false;
    }
  }

  async function syncNow() {
    const b = $("es-sync");
    b.disabled = true;
    b.innerHTML = '<span class="spin"></span>Checking…';
    try {
      const j = await post("/api/epic/sales/sync");
      const r = j.result || {};
      say(r.skipped ? r.skipped : (r.ok ? "Checked " : "Checked with problems: ") + (r.listings || 0) + " listing(s)." + (r.notes && r.notes.length ? " " + r.notes.join(" | ") : ""), r.ok === false);
      await load();
    } catch (e) {
      say(e.message, true);
    }
    b.disabled = false;
    b.textContent = "Check Eldorado now";
  }

  function render() {
    if (!data) return;
    renderHealth();
    renderSettings();
    renderDist();
    renderGroups();
    renderG2g();
    renderPa();
    renderListings();
    renderSales();
    renderStock();
    renderOthers();
  }

  // ---- Auto-distribute card (utils/epicDistributor) ------------------------
  const DIST_LABEL = { pa: "PlayerAuctions", eldorado: "Eldorado", g2g: "G2G", reserve: "Reserve", hold: "Waiting", skip: "Never auto" };
  const DIST_TONE = { pa: "green", eldorado: "green", g2g: "green", reserve: "amber", hold: "", skip: "" };

  // force=false (the 60 s refresh) leaves the card alone while you type in it.
  function renderDist(force) {
    const root = $("es-dist");
    if (!root) return;
    const a = document.activeElement;
    if (!force && a && root.contains(a) && a.matches("input, select, textarea")) return;
    const d = data.distributor;
    if (!d || d.error) {
      root.innerHTML = '<div class="es-err">Could not load: ' + esc((d && d.error) || "no data") + "</div>";
      return;
    }
    const c = d.config || {};
    const modes = [
      ["off", "Off", "Does nothing."],
      ["plan", "Plan only", "Shows where each account would go. Lists nothing."],
      ["on", "On", "Lists new accounts automatically."],
    ];
    const lr = d.lastRun || {};
    const plan = d.plan || [];
    const count = (k) => plan.filter((r) => r.decision === k).length;
    const outcome = (r) =>
      r.outcome === "placed" ? " " + pill("listed", "green") : r.outcome === "failed" ? " " + pill("failed", "red") : r.outcome === "queued" ? " " + pill("next run", "amber") : "";
    root.innerHTML =
      '<div class="es-seg" role="radiogroup" aria-label="Automatic listing">' +
      modes
        .map(
          ([k, t, h]) =>
            '<button type="button" class="btn btn-sm' + (c.mode === k ? " btn-primary" : "") + '" role="radio" aria-checked="' + (c.mode === k) + '" data-dist-mode="' + k + '" title="' + esc(h) + '">' + esc(t) + "</button>",
        )
        .join("") +
      '</div><p class="hint es-dist-mode">' + esc((modes.find((m) => m[0] === c.mode) || modes[1])[2]) + "</p>" +
      '<div class="es-meta">Last run: ' + esc(ago(lr.at)) + (lr.mode === "on" ? " (listing on)" : "") +
      (lr.note ? ' <span class="' + (lr.ok === false ? "bad" : "muted") + '">' + esc(lr.note) + "</span>" : "") +
      (lr.placedAt ? ' <span class="muted">Last listed: ' + esc(ago(lr.placedAt)) + "</span>" : "") +
      ' <span class="muted">Runs every ' + esc(d.runEveryMin || 10) + " min.</span></div>" +
      '<div class="row es-actions" style="margin:10px 0"><button class="btn" id="es-dist-preview" type="button">Preview now</button>' +
      (c.mode === "on" ? '<button class="btn btn-primary" id="es-dist-run" type="button">Run now</button>' : "") + "</div>" +
      distMarkets(d.markets) +
      '<h3>Limits</h3><form id="es-dist-cfg" class="es-dist-form">' +
      '<fieldset><legend>PlayerAuctions</legend><label class="es-switch"><input type="checkbox" name="paOn"' + (c.pa && c.pa.enabled ? " checked" : "") + "> Use</label>" +
      '<label>Offers live at once <input name="paMax" type="number" min="0" max="50" step="1" value="' + esc(c.pa && c.pa.maxLive) + '"></label>' +
      '<label>Price (USD, min 5) <input name="paPrice" type="number" min="5" max="500" step="0.01" value="' + esc(c.pa && c.pa.priceUsd) + '"></label></fieldset>' +
      '<fieldset><legend>Eldorado</legend><label class="es-switch"><input type="checkbox" name="eldOn"' + (c.eldorado && c.eldorado.enabled ? " checked" : "") + "> Use</label>" +
      '<label>Accounts per listing <input name="eldMax" type="number" min="0" max="100" step="1" value="' + esc(c.eldorado && c.eldorado.maxPerListing) + '"></label></fieldset>' +
      '<fieldset><legend>G2G</legend><label class="es-switch"><input type="checkbox" name="g2gOn"' + (c.g2g && c.g2g.enabled ? " checked" : "") + "> Use</label>" +
      '<label>Stock per offer <input name="g2gMax" type="number" min="0" max="200" step="1" value="' + esc(c.g2g && c.g2g.maxStock) + '"></label></fieldset>' +
      '<label class="es-switch"><input type="checkbox" name="holdFree"' + (c.holdWhileFree ? " checked" : "") + "> Wait while a game is still free on Epic</label>" +
      '<div><button class="btn" type="submit">Save limits</button></div></form>' +
      distOwner(d.owner) +
      "<h3>Plan</h3>" +
      (plan.length
        ? '<p class="hint">' +
          [["pa", "PlayerAuctions"], ["eldorado", "Eldorado"], ["g2g", "G2G"], ["reserve", "reserve"], ["hold", "waiting"], ["skip", "never auto"]]
            .map(([k, t]) => count(k) + " " + t)
            .join(" · ") +
          "</p>" +
          '<div class="es-table-wrap"><table class="es-table"><thead><tr><th>Account</th><th>Games</th><th>Goes to</th><th>Why</th></tr></thead><tbody>' +
          plan
            .map(
              (r) =>
                '<tr><td data-label="Account"><b>' + esc(r.label) + "</b></td>" +
                '<td data-label="Games">' + (r.games && r.games.length ? esc(r.games.slice(0, 3).join(", ") + (r.games.length > 3 ? ", …" : "")) : '<span class="muted">none yet</span>') + "</td>" +
                '<td data-label="Goes to">' + pill(DIST_LABEL[r.decision] || r.decision, DIST_TONE[r.decision]) + outcome(r) + "</td>" +
                '<td data-label="Why" class="muted">' + esc(r.reason) + "</td></tr>",
            )
            .join("") +
          "</tbody></table></div>"
        : '<p class="muted">No plan yet. Press Preview now.</p>');

    root.querySelectorAll("[data-dist-mode]").forEach((b) => {
      b.onclick = async () => {
        const mode = b.dataset.distMode;
        if (mode === c.mode) return;
        if (
          mode === "on" &&
          !confirm(
            "Turn automatic listing on?\n\nEvery 10 minutes new sellable accounts are listed on PlayerAuctions (one new offer per run), added to a live Eldorado listing for the same games, or loaded into G2G stock, up to your limits. While it is on, G2G no longer loads every ready account by itself.",
          )
        )
          return;
        await distPost("/api/epic/sales/distributor/config", { mode, confirm: mode === "on" }, mode === "on" ? "Automatic listing is on." : "Saved.");
      };
    });
    $("es-dist-preview").onclick = (e) => distAction(e.currentTarget, "/api/epic/sales/distributor/preview", "Plan updated. Nothing was listed.");
    if ($("es-dist-run")) $("es-dist-run").onclick = (e) => distAction(e.currentTarget, "/api/epic/sales/distributor/run", null);
    $("es-dist-cfg").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.currentTarget.elements;
      await distPost("/api/epic/sales/distributor/config", {
        holdWhileFree: f.holdFree.checked,
        pa: { enabled: f.paOn.checked, maxLive: Number(f.paMax.value), priceUsd: Number(f.paPrice.value) },
        eldorado: { enabled: f.eldOn.checked, maxPerListing: Number(f.eldMax.value) },
        g2g: { enabled: f.g2gOn.checked, maxStock: Number(f.g2gMax.value) },
      }, "Limits saved.");
    };
    const of = $("es-dist-owner");
    if (of) {
      of.onsubmit = async (e) => {
        e.preventDefault();
        const f = e.currentTarget.elements;
        await distPost("/api/epic/sales/distributor/owner", { phone: f.phone.value, city: f.city.value }, "Saved for PlayerAuctions.");
      };
    }
    const change = $("es-dist-owner-change");
    if (change) change.onclick = () => { data.distributor.owner = { saved: false, editing: true }; renderDist(true); };
    const clear = $("es-dist-owner-clear");
    if (clear) {
      clear.onclick = async () => {
        if (!confirm("Remove your saved phone and city? PlayerAuctions accounts will stop being listed automatically.")) return;
        await distPost("/api/epic/sales/distributor/owner", { clear: true }, "Removed.");
      };
    }
  }

  function distMarkets(m) {
    if (!m) return '<p class="muted">Markets are checked on the first run. Press Preview now.</p>';
    const tone = (x) => (x && x.ok ? "green" : "amber");
    const rows = [];
    if (m.pa) {
      rows.push(["PlayerAuctions", money(m.pa.priceUsd) + " each", m.pa.used + " / " + m.pa.cap + " offers", pill(m.pa.status || "?", tone(m.pa))]);
    }
    if (m.eldorado) {
      const ls = m.eldorado.listings || [];
      rows.push([
        "Eldorado",
        ls.length ? ls.map((l) => money(l.priceUsd)).join(", ") : "—",
        ls.length ? ls.map((l) => esc(l.title) + ": " + l.used + " / " + l.cap).join("<br>") : "—",
        pill(m.eldorado.status || "?", tone(m.eldorado)),
      ]);
    }
    if (m.g2g) {
      const os = m.g2g.offers || [];
      rows.push([
        "G2G",
        "set on g2g.com",
        os.length ? os.map((o) => esc(o.offerId) + ": " + o.used + " / " + o.cap).join("<br>") : "—",
        pill(m.g2g.status || "?", tone(m.g2g)),
      ]);
    }
    return (
      '<div class="es-table-wrap"><table class="es-table"><thead><tr><th>Market</th><th>Price</th><th>In use</th><th>Status</th></tr></thead><tbody>' +
      rows
        .map((r) => '<tr><td data-label="Market"><b>' + r[0] + '</b></td><td data-label="Price">' + esc(r[1]) + '</td><td data-label="In use">' + r[2] + '</td><td data-label="Status">' + r[3] + "</td></tr>")
        .join("") +
      "</tbody></table></div>" +
      '<p class="hint">A market above its limit keeps what it has; new accounts go elsewhere until it drops below.</p>'
    );
  }

  function distOwner(o) {
    const head =
      '<h3>Your details for PlayerAuctions</h3><p class="hint">PlayerAuctions asks for the original owner’s contact on every account offer. Name, email and country come from each account’s own Epic registration. Phone and city are yours: they are used only on PlayerAuctions offers, stored encrypted, and never made up. Without them PlayerAuctions is skipped.</p>';
    if (o && o.saved) {
      return (
        head +
        '<div class="es-meta">Saved: phone ' + esc(o.phone) + ", " + esc(o.city) + (o.updatedAt ? ' <span class="muted">(' + esc(ago(o.updatedAt)) + ")</span>" : "") +
        ' <button class="btn btn-sm" type="button" id="es-dist-owner-change">Change</button> <button class="btn btn-sm" type="button" id="es-dist-owner-clear">Remove</button></div>'
      );
    }
    return (
      head +
      '<form id="es-dist-owner" class="es-dist-form"><label>Phone <input name="phone" type="tel" inputmode="tel" autocomplete="tel" required placeholder="digits, no +" maxlength="17"></label>' +
      '<label>City <input name="city" autocomplete="address-level2" required maxlength="60"></label>' +
      '<div><button class="btn" type="submit">Save</button></div></form>'
    );
  }

  async function distPost(url, body, okText) {
    try {
      const j = await post(url, body);
      if (j.distributor) data.distributor = j.distributor;
      renderDist(true);
      if (okText) say(okText);
    } catch (e) {
      say(e.message, true);
      renderDist(true);
    }
  }

  async function distAction(b, url, okText) {
    b.disabled = true;
    const label = b.textContent;
    b.innerHTML = '<span class="spin"></span>Working…';
    try {
      const j = await post(url, {});
      if (j.distributor) data.distributor = j.distributor;
      const r = j.result || {};
      if (r.skipped) say(r.skipped, true);
      else if (okText) say(okText);
      else {
        const p = r.placed || {};
        const n = (p.pa || 0) + (p.eldorado || 0) + (p.g2g || 0);
        say(n ? "Listed " + n + " account(s)." + ((r.failed || []).length ? " Some failed: see the plan." : "") : (r.failed || []).length ? "Nothing listed: " + r.failed.join("; ") : "Nothing new to list.", !!(r.failed || []).length);
      }
      await load();
    } catch (e) {
      say(e.message, true);
      b.disabled = false;
      b.textContent = label;
    }
  }

  function renderPa() {
    const root = $("es-pa");
    if (!root) return;
    const ready = (data.stock || []).filter(a => a.state === "ready" && a.games?.length);
    const units = data.playerauctions?.units || [];
    root.innerHTML = '<div class="row"><button class="btn" id="es-pa-check">Check PlayerAuctions sales</button></div>' +
      (ready.length ? '<h3>Ready accounts</h3>' + ready.map(a => '<div class="es-meta">' + esc(a.label) + ' - ' + esc(a.games.join(", ")) +
        ' <button class="btn btn-sm" data-pa-list="' + esc(a._id) + '">Sell on PlayerAuctions</button></div>').join("") :
        '<p class="muted">No unlisted accounts with games are ready. Empty accounts appear here after games are claimed and their libraries are synced.</p>') +
      (units.length ? '<h3>PlayerAuctions offers</h3>' + units.map(u => '<div class="es-meta">' + pill(u.state, u.state === "error" ? "red" : "") + ' ' +
        (u.url ? '<a href="' + esc(u.url) + '" target="_blank" rel="noopener">' + esc(u.title) + '</a>' : esc(u.title)) + ' - ' + money(u.priceUsd) +
        (u.note ? '<div class="es-err">' + esc(u.note) + '</div>' : '') +
        (["listed", "paused"].includes(u.state) ? ' <button class="btn btn-sm" data-pa-pause="' + esc(u.id) + '" data-pa-paused="' + (u.state !== "paused") + '">' + (u.state === "paused" ? "Resume" : "Pause") + '</button>' : '') +
        (u.state === "error" || u.state === "loading" ? '<form class="row" data-pa-reconcile="' + esc(u.id) + '"><label>Existing PA offer ID <input name="offerId" inputmode="numeric" pattern="[0-9]+" required></label><button class="btn" type="submit">Verify and link</button></form>' : '') + '</div>').join("") : '<p class="muted">No Epic accounts published on PlayerAuctions yet.</p>');
    $("es-pa-check").onclick = async event => {
      const b = event.currentTarget; b.disabled = true;
      try { const j = await post("/api/epic/sales/playerauctions/sync"); say("Checked " + (j.result.checked || 0) + " account order(s)."); await load(); }
      catch (e) { say(e.message, true); } finally { b.disabled = false; }
    };
    root.querySelectorAll("[data-pa-list]").forEach(b => b.onclick = () => paForm(b.dataset.paList));
    root.querySelectorAll("[data-pa-pause]").forEach(b => b.onclick = async () => {
      b.disabled = true;
      try { await post("/api/epic/sales/playerauctions/" + b.dataset.paPause + "/pause", { paused: b.dataset.paPaused === "true" }); await load(); }
      catch (e) { say(e.message, true); } finally { b.disabled = false; }
    });
    root.querySelectorAll("[data-pa-reconcile]").forEach(form => form.onsubmit = async event => {
      event.preventDefault(); const b = form.querySelector("button"); b.disabled = true;
      try { await post("/api/epic/sales/playerauctions/" + form.dataset.paReconcile + "/reconcile", { offerId: form.elements.offerId.value }); await load(); }
      catch (e) { say(e.message, true); } finally { b.disabled = false; }
    });
  }

  async function paForm(accountId) {
    try {
      const { preview: p } = await post("/api/epic/sales/playerauctions/preview", { accountId });
      $("es-pa-modal")?.remove();
      const modal = document.createElement("div"); modal.id = "es-pa-modal"; modal.className = "modal-wrap es-modal show";
      const fields = ["firstName", "lastName", "phone", "email", "city", "country"];
      const labels = { firstName: "Original owner's first name", lastName: "Original owner's last name", phone: "Owner phone", email: "Owner email", city: "Owner city", country: "Owner country" };
      modal.innerHTML = '<form class="modal"><h3>Sell on PlayerAuctions</h3><p>' + esc(p.games.join(" + ")) + '</p>' +
        '<p class="hint">Instant delivery of this account and a 14-day mail-page login. Email change supported; the Outlook inbox password is never delivered. Enter the original owner information PlayerAuctions asks for. Name, email and country are the account\'s Epic registration; phone and city are your saved details from the Auto-distribute card (never the account\'s made-up sample phone).</p>' +
        '<label>Title<input name="title" maxlength="150" required value="' + esc(p.title) + '"></label>' +
        '<label>Price (USD)<input name="priceUsd" type="number" min="5" step="0.01" required value="5"></label>' +
        fields.map(k => '<label>' + labels[k] + '<input name="' + k + '" required ' + (k === "email" ? 'type="email"' : k === "phone" ? 'type="tel"' : '') + ' value="' + esc(p.original[k]) + '"></label>').join("") +
        '<p class="hint">The current owner is the original owner. After-sale protection: 14 days. PlayerAuctions receives these details with the account.</p>' +
        '<div class="es-err" role="alert" id="es-pa-error"></div><div class="modal-actions"><button class="btn" type="button" data-cancel>Cancel</button><button class="btn btn-primary" type="submit">Publish with instant delivery</button></div></form>';
      document.body.append(modal); modal.querySelector("[data-cancel]").onclick = () => modal.remove();
      const form = modal.querySelector("form");
      form.onsubmit = async event => {
        event.preventDefault(); const b = form.querySelector('[type="submit"]'); b.disabled = true;
        const original = Object.fromEntries(fields.map(k => [k, form.elements[k].value]));
        try {
          await post("/api/epic/sales/playerauctions/publish", { accountId, title: form.elements.title.value, priceUsd: Number(form.elements.priceUsd.value), original, confirm: true });
          modal.remove(); say("PlayerAuctions instant-delivery offer is live."); await load();
        } catch (e) { $("es-pa-error").textContent = e.message; b.disabled = false; }
      };
      form.elements.title.focus();
    } catch (e) { say(e.message, true); }
  }

  function renderHealth() {
    const h = data.health || {};
    const cards = [];
    cards.push(
      '<div class="es-stat"><b>Mail page</b><div class="v">' +
        (h.providerUrl ? '<a href="' + esc(h.providerUrl) + '" target="_blank" rel="noopener">' + esc(h.providerUrl) + "</a>" : '<span class="bad">Not set (PUBLIC_BASE_URL)</span>') +
        '</div><div class="s">Where buyers read Epic\'s codes.</div></div>',
    );
    const px = h.proxy || {};
    cards.push(
      '<div class="es-stat"><b>Mac mail proxy</b><div class="v ' + (px.ok ? "ok" : "bad") + '">' +
        (px.ok ? "Online · " + esc(px.inboxes) + " inboxes" : "Offline") +
        '</div><div class="s">' + (px.ok ? "Buyers can read their codes." : "Buyers can't read codes until the Mac is back online.") + "</div></div>",
    );
    const el = h.eldorado || {};
    const left = el.expiresAt ? new Date(el.expiresAt).getTime() - Date.now() : NaN;
    cards.push(
      '<div class="es-stat"><b>Eldorado login</b><div class="v ' + (!el.configured || left < 3 * 864e5 ? "bad" : "ok") + '">' +
        (el.configured ? (el.expiresAt ? "Until " + esc(new Date(el.expiresAt).toLocaleString()) : "Signed in") : "Not configured") +
        '</div><div class="s">' + (el.expiresAt ? "Expires " + esc(until(el.expiresAt)) + ". Paste a fresh cookie before then." : "") + "</div></div>",
    );
    const perm = el.permission || {};
    cards.push(
      '<div class="es-stat"><b>Eldorado permission</b><div class="v ' + (perm.canSell === true ? "ok" : perm.canSell === false ? "bad" : "") + '">' +
        (perm.canSell === true ? "Can list Epic accounts" : perm.canSell === false ? "Epic accounts not allowed yet" : "Unknown") +
        '</div><div class="s">' +
        (perm.canSell === false
          ? "Epic Games accounts is one of Eldorado's high-risk categories. Ask Eldorado support to enable “high-risk offers” for our seller account."
          : perm.canSell === true
            ? "Eldorado accepts our Epic account offers."
            : esc(perm.error || "Not checked yet.")) +
        "</div></div>",
    );
    const sy = h.sync || {};
    cards.push(
      '<div class="es-stat"><b>Sale tracking</b><div class="v ' + (sy.enabled ? (sy.lastTickOk === false ? "bad" : "ok") : "bad") + '">' +
        (sy.enabled ? "On · every " + esc(sy.everyMinutes) + " min" : "Off") +
        '</div><div class="s">Last check ' + esc(ago(sy.lastTickAt)) + (sy.lastTickNote ? " · " + esc(sy.lastTickNote) : "") + "</div></div>",
    );
    $("es-health").innerHTML = cards.join("");
  }

  function renderSettings() {
    const c = data.config || {};
    const days = [1, 2, 3, 5, 7, 10, 14];
    $("es-settings").innerHTML =
      '<label class="es-switch"><input type="checkbox" id="es-cfg-sync"' + (c.syncEnabled ? " checked" : "") + "> Track Eldorado sales automatically</label>" +
      '<label class="es-switch">Mail page open for <select id="es-cfg-days">' +
      days.map((d) => '<option value="' + d + '"' + (d === c.sessionDays ? " selected" : "") + ">" + d + " day" + (d > 1 ? "s" : "") + "</option>").join("") +
      "</select> after an Eldorado sale (G2G offers have their own, below)</label>" +
      '<label class="es-switch" title="Buyers only ever see Epic\'s emails on the mail page, never the inbox itself."><input type="checkbox" id="es-cfg-shared"' +
      (c.allowSharedInbox ? " checked" : "") + "> Sell accounts whose inbox is shared with SOOP</label>";
    const save = async (patch) => {
      try {
        await post("/api/epic/sales/config", patch);
        say("Saved.");
        load();
      } catch (e) {
        say(e.message, true);
        load();
      }
    };
    $("es-cfg-sync").addEventListener("change", (e) => save({ syncEnabled: e.target.checked }));
    $("es-cfg-days").addEventListener("change", (e) => save({ sessionDays: Number(e.target.value) }));
    $("es-cfg-shared").addEventListener("change", (e) => {
      if (!e.target.checked || confirm("Allow selling accounts whose Outlook inbox is also one of our SOOP accounts' email?\n\nThe buyer never gets the inbox: the mail page shows only Epic's emails, from the purchase on, and closes after the email change or the set days. The buyer does learn the address.")) {
        save({ allowSharedInbox: e.target.checked });
      } else {
        e.target.checked = false;
      }
    });
  }

  function renderGroups() {
    const groups = data.groups || [];
    const counts = { ready: 0, listed: 0, sold: 0, blocked: 0 };
    for (const s of data.stock || []) counts[s.state] = (counts[s.state] || 0) + 1;
    const perm = ((data.health || {}).eldorado || {}).permission || {};
    const head =
      (perm.canSell === false ? '<div class="warn">' + esc(data.health.eldorado.noPermissionText || "Eldorado doesn't allow Epic account offers on this seller account yet.") + "</div>" : "") +
      '<div class="es-meta" style="margin:0 0 10px">' +
      [pill(counts.ready + " ready", "green"), pill(counts.listed + " on sale"), pill(counts.sold + " sold"), pill(counts.blocked + " can't sell", counts.blocked ? "amber" : "")].join(" ") +
      "</div>";
    if (!groups.length) {
      $("es-groups").innerHTML = head + '<div class="muted">Nothing ready to list. See “All accounts” below for the reasons.</div>';
      return;
    }
    $("es-groups").innerHTML =
      head +
      '<div class="es-list">' +
      groups
        .map((g, i) => {
          const warn = [...new Set(g.accounts.flatMap((a) => a.warnings || []))];
          return (
            '<div class="es-item"><div class="es-item-head"><div class="es-item-title">' +
            (g.games.length ? esc(g.games.join(" + ")) : "No games (fresh accounts)") +
            '</div><div>' + pill(g.count + " account" + (g.count > 1 ? "s" : ""), "green") + "</div></div>" +
            '<div class="es-meta">' + esc(g.accounts.map((a) => a.label).join(", ")) + "</div>" +
            (warn.length ? '<ul class="es-reasons">' + warn.map((w) => "<li>" + esc(w) + "</li>").join("") + "</ul>" : "") +
            (g.rocketLeague
              ? '<div class="hint">Fresh accounts can go in Eldorado\'s Rocket League section (PC). That section needs no special permission.</div>'
              : "") +
            '<div class="es-actions"><button class="btn btn-sm btn-primary" type="button" data-group="' + i + '">List on Eldorado</button>' +
            '<button class="btn btn-sm" type="button" data-g2g-group="' + i + '">Sell on G2G</button></div></div>'
          );
        })
        .join("") +
      "</div>";
    $("es-groups").querySelectorAll("[data-group]").forEach((b) =>
      b.addEventListener("click", () => openCreate(groups[Number(b.dataset.group)])),
    );
    $("es-groups").querySelectorAll("[data-g2g-group]").forEach((b) =>
      b.addEventListener("click", () => linkG2g(groups[Number(b.dataset.g2gGroup)])),
    );
  }

  // ---- G2G ------------------------------------------------------------------
  let g2gGroup = null;
  function linkG2g(group) {
    g2gGroup = group;
    $("es-g-sub").textContent =
      "Make the offer on g2g.com first (Game Accounts → the game, Manual delivery), then paste its offer number. " +
      "Every buyer of that offer gets one account that owns: " + group.games.join(" + ") + ".";
    $("es-g-offer").value = "";
    $("es-g-days").value = "14";
    openModal("es-g2g-modal");
    setTimeout(() => $("es-g-offer").focus(), 50);
  }

  async function saveG2gLink() {
    const offerId = $("es-g-offer").value.trim();
    if (!offerId) return say("Paste the G2G offer number first.", true);
    return busy($("es-g-save"), async () => {
      await post("/api/epic/sales/g2g/link", { offerId, gameKey: g2gGroup && g2gGroup.gameKey, sessionDays: Number($("es-g-days").value) });
      closeModal("es-g2g-modal");
      say("Linked. Orders on it are delivered automatically.");
      await load();
    });
  }

  function renderG2g() {
    const g = data.g2g || {};
    const offers = g.offers || [];
    if (g.error) {
      $("es-g2g").innerHTML = '<div class="es-err">' + esc(g.error) + "</div>";
      return;
    }
    if (!offers.length) {
      $("es-g2g").innerHTML = '<div class="muted">No G2G offer linked. Use “Sell on G2G” on a group above.</div>';
      return;
    }
    $("es-g2g").innerHTML =
      '<div class="es-list">' +
      offers
        .map((o) => {
          const instant = o.mode === "instant";
          const u = o.units || {};
          const pills = instant
            ? [
                pill("Instant (G2G Auto delivery)", "green"),
                pill((u.listed || 0) + " in G2G stock", u.listed ? "green" : "red"),
                u.loading ? pill(u.loading + " loading", "amber") : "",
                pill((u.sold || 0) + " sold"),
                pill((o.ready == null ? "?" : o.ready) + " more ready"),
                pill("mail page " + o.sessionDays + " days"),
                o.enabled ? "" : pill("loading new stock is off", "amber"),
              ]
            : [
                pill("Manual delivery, filled in by the server", o.enabled ? "green" : ""),
                o.enabled ? "" : pill("automatic delivery off", "amber"),
                pill((o.ready == null ? "?" : o.ready) + " ready", o.ready ? "green" : "red"),
                pill("mail page " + o.sessionDays + " days"),
                o.syncStock ? pill("stock synced" + (o.lastStock != null ? " (" + o.lastStock + ")" : "")) : pill("stock by hand"),
              ];
          const meta = instant
            ? (o.lastSaleScanAt ? " · sales checked " + esc(ago(o.lastSaleScanAt)) : "") +
              (o.lastStockLoadAt ? " · stock last loaded " + esc(ago(o.lastStockLoadAt)) : "")
            : o.lastStockSyncAt
              ? " · stock last set " + esc(ago(o.lastStockSyncAt))
              : "";
          const actions = instant
            ? '<button class="btn btn-sm" type="button" data-g2g-act="load" data-id="' + esc(o.offerId) + '">Load ready accounts now</button>' +
              '<button class="btn btn-sm" type="button" data-g2g-act="scan" data-id="' + esc(o.offerId) + '">Check sales now</button>' +
              '<button class="btn btn-sm" type="button" data-g2g-act="' + (o.enabled ? "off" : "on") + '" data-id="' + esc(o.offerId) + '">' + (o.enabled ? "Stop loading new stock" : "Load new stock again") + "</button>"
            : '<button class="btn btn-sm" type="button" data-g2g-act="' + (o.enabled ? "off" : "on") + '" data-id="' + esc(o.offerId) + '">' + (o.enabled ? "Turn automatic delivery off" : "Turn automatic delivery on") + "</button>" +
              '<button class="btn btn-sm" type="button" data-g2g-act="' + (o.syncStock ? "stock-off" : "stock-on") + '" data-id="' + esc(o.offerId) + '">' + (o.syncStock ? "Stop syncing stock" : "Sync stock") + "</button>";
          return (
            '<div class="es-item"><div class="es-item-head"><div class="es-item-title">' + esc(o.title || o.offerId) + "</div><div>" + pills.filter(Boolean).join(" ") + "</div></div>" +
            '<div class="es-meta">Offer ' + esc(o.offerId) + " · games: " + esc((o.games || []).join(" + ")) + meta + "</div>" +
            (instant
              ? '<div class="es-meta">G2G hands a stored account to each buyer the moment they pay; the server records which one and starts its mail page. To pull an account out of G2G\'s stock, use Manage stock on g2g.com (it asks for your 6-digit code).</div>'
              : "") +
            (g.siteUrl ? "" : '<div class="es-err">PUBLIC_BASE_URL is not set, so the delivery note can\'t name the mail page.</div>') +
            '<div class="es-actions">' + actions +
            '<button class="btn btn-sm" type="button" data-g2g-act="unlink" data-id="' + esc(o.offerId) + '">Unlink</button>' +
            "</div></div>"
          );
        })
        .join("") +
      "</div>";
    $("es-g2g").querySelectorAll("[data-g2g-act]").forEach((b) => b.addEventListener("click", () => g2gAction(b.dataset.g2gAct, b.dataset.id, b)));
  }

  async function g2gAction(act, id, b) {
    const url = "/api/epic/sales/g2g/" + encodeURIComponent(id);
    if (act === "unlink") {
      if (!confirm("Unlink this G2G offer? Its orders will page you to deliver by hand instead. The offer stays on G2G.")) return;
      return busy(b, async () => { await post(url + "/unlink"); say("Unlinked."); await load(); });
    }
    if (act === "load") {
      return busy(b, async () => {
        const j = await post(url + "/load");
        const r = j.result || {};
        say(r.skipped ? r.skipped : r.loaded ? r.loaded + " account(s) sent to G2G" + (r.confirmed ? " and in stock now." : ", waiting for G2G to show them.") : "Nothing new to load.");
        await load();
      });
    }
    if (act === "scan") {
      return busy(b, async () => {
        const j = await post(url + "/scan");
        const r = j.result || {};
        say(r.skipped ? r.skipped : r.recorded ? r.recorded + " new sale(s) recorded." : "No new sales.");
        await load();
      });
    }
    const patch = { on: { enabled: true }, off: { enabled: false }, "stock-on": { syncStock: true }, "stock-off": { syncStock: false } }[act];
    if (!patch) return;
    return busy(b, async () => { await post(url + "/settings", patch); say("Saved."); await load(); });
  }

  async function g2gDetails(orderId, b) {
    if (!confirm("Show this order's delivery details (Epic password included)? Paste them only into the account form on the G2G order page, never the chat.")) return;
    return busy(b, async () => {
      const j = await post("/api/epic/sales/g2g/sales/" + encodeURIComponent(orderId) + "/details", {});
      const d = j.details || {};
      $("es-access-text").value = (d.accounts || [])
        .map((a) => a.fields.map((f) => f[0] + ": " + f[1]).join("\n"))
        .join("\n\n-----\n\n");
      $("es-access-title").textContent = "Delivery details for G2G order " + d.orderId;
      $("es-access-warn").textContent = d.delivered
        ? "G2G already shows this order delivered. A new mail page password was made because the old one is never stored; give it to the buyer only if they ask, in the account form."
        : "Fill these into the account form on the G2G order page (Account ID, Password, …). Never paste them into the chat.";
      openModal("es-access-modal");
      await load();
    });
  }

  function statusPill(s) {
    const tone = { active: "green", paused: "amber", sold_out: "", removed: "", error: "red", draft: "amber" }[s] || "";
    const text = { active: "on sale", paused: "paused", sold_out: "sold out", removed: "removed", error: "needs attention", draft: "creating…" }[s] || s;
    return pill(text, tone);
  }

  function renderListings() {
    const all = data.listings || [];
    const live = all.filter((l) => l.status !== "removed");
    const old = all.filter((l) => l.status === "removed");
    if (!all.length) {
      $("es-listings").innerHTML = '<div class="muted">No Epic listings yet. Use “List on Eldorado” above.</div>';
      return;
    }
    const block = (l) => {
      const r = l.remote || {};
      const units = (l.units || []).filter((u) => u.state !== "removed" || l.status === "removed");
      const unitHtml = units.length
        ? '<ul class="es-units">' +
          units
            .map(
              (u) =>
                "<li><span><b>" + esc(u.label) + "</b> " +
                (u.state === "sold"
                  ? pill("sold " + ago(u.soldAt), "green")
                  : u.state === "listed"
                    ? u.missingSince
                      ? pill("left stock " + ago(u.missingSince) + ", order not matched yet", "amber")
                      : pill("on sale")
                    : pill("removed")) +
                (u.orderId ? ' <span class="muted">order ' + esc(u.orderId.slice(0, 8)) + "</span>" : "") +
                "</span>" +
                (u.state === "listed" && !u.missingSince && l.status !== "removed" && l.status !== "error"
                  ? '<button class="btn btn-sm" type="button" data-remove="' + esc(l._id) + "|" + esc(u.epicAccountId) + '">Remove</button>'
                  : "") +
                "</li>",
            )
            .join("") +
          "</ul>"
        : "";
      const isLive = ["active", "paused", "sold_out"].includes(l.status);
      const acts = [];
      if (isLive) {
        if (l.status === "paused" || /^paused$/i.test(r.offerState || "")) acts.push(btn("Resume", "resume", l._id, "btn-primary"));
        else acts.push(btn("Pause", "pause", l._id));
        acts.push(btn("Change price", "price", l._id));
        acts.push(btn("Edit text", "text", l._id));
        acts.push(btn("Add accounts", "add", l._id));
      }
      if (l.status === "error") acts.push(btn("Link offer id", "link", l._id));
      if (l.status !== "removed") acts.push(btn("Delete", "delete", l._id, "btn-danger"));
      return (
        '<div class="es-item"><div class="es-item-head"><div class="es-item-title">' +
        (l.url ? '<a href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.title) + "</a>" : esc(l.title)) +
        "</div><div>" + statusPill(l.status) + "</div></div>" +
        '<div class="es-meta">' +
        [
          l.section && l.section !== "epic" ? "Section: " + l.sectionName : "",
          money(l.priceUsd) + " each",
          l.counts.listed + " on sale · " + l.counts.sold + " sold",
          r.offerState ? "Eldorado: " + r.offerState + (r.quantity != null ? " · qty " + r.quantity : "") : "",
          r.expireDate ? "offer expires " + new Date(r.expireDate).toLocaleDateString() + " (renewed automatically)" : "",
          "checked " + ago(l.lastSyncAt),
        ]
          .filter(Boolean)
          .map(esc)
          .join(" · ") +
        "</div>" +
        (l.lastError ? '<div class="es-err">' + esc(l.lastError) + (l.lastErrorAt ? " (" + esc(ago(l.lastErrorAt)) + ")" : "") + "</div>" : "") +
        unitHtml +
        (acts.length ? '<div class="es-actions">' + acts.join("") + "</div>" : "") +
        "</div>"
      );
    };
    $("es-listings").innerHTML =
      '<div class="es-list">' + live.map(block).join("") + "</div>" +
      (old.length
        ? '<details style="margin-top:12px"><summary class="muted" style="cursor:pointer">' + old.length + " removed listing(s)</summary>" +
          '<div class="es-list" style="margin-top:10px">' + old.map(block).join("") + "</div></details>"
        : "");
    $("es-listings").querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => listingAction(b.dataset.act, b.dataset.id, b)));
    $("es-listings").querySelectorAll("[data-remove]").forEach((b) =>
      b.addEventListener("click", () => {
        const [lid, aid] = b.dataset.remove.split("|");
        removeUnit(lid, aid, b);
      }),
    );
  }

  function btn(text, act, id, cls) {
    return '<button class="btn btn-sm' + (cls ? " " + cls : "") + '" type="button" data-act="' + act + '" data-id="' + esc(id) + '">' + esc(text) + "</button>";
  }

  function listingById(id) {
    return (data.listings || []).find((l) => l._id === id);
  }

  async function busy(b, fn) {
    const old = b ? b.innerHTML : "";
    if (b) {
      b.disabled = true;
      b.innerHTML = '<span class="spin"></span>' + esc(b.textContent);
    }
    try {
      await fn();
    } catch (e) {
      say(e.message, true);
    }
    if (b) {
      b.disabled = false;
      b.innerHTML = old;
    }
  }

  async function listingAction(act, id, b) {
    const l = listingById(id);
    if (!l) return;
    if (act === "pause") return busy(b, async () => { await post("/api/epic/sales/listings/" + id + "/pause"); say("Paused on Eldorado."); await load(); });
    if (act === "resume") return busy(b, async () => { await post("/api/epic/sales/listings/" + id + "/resume"); say("Back on sale."); await load(); });
    if (act === "price") {
      const v = prompt("New price per account (USD). Eldorado's minimum is $0.05.", l.priceUsd);
      if (v == null || v === "") return;
      return busy(b, async () => { await post("/api/epic/sales/listings/" + id + "/price", { priceUsd: Number(v) }); say("Price changed."); await load(); });
    }
    if (act === "text") return openText(l);
    if (act === "add") return openAdd(l);
    if (act === "link") {
      const v = prompt("Eldorado offer id to attach to this listing:");
      if (!v) return;
      return busy(b, async () => { await post("/api/epic/sales/listings/" + id + "/link", { offerId: v.trim() }); say("Linked."); await load(); });
    }
    if (act === "delete") {
      if (!confirm("Delete “" + l.title + "” from Eldorado?\n\nAccounts still on it go back to “ready”, and their mail page logins are switched off. Accounts already sold are not affected.")) return;
      return busy(b, async () => { await post("/api/epic/sales/listings/" + id + "/delete"); say("Listing deleted."); await load(); });
    }
  }

  async function removeUnit(listingId, accountId, b) {
    if (!confirm("Take this account off the listing? It goes back to “ready” and its mail page login is switched off.")) return;
    return busy(b, async () => {
      await api("/api/epic/sales/listings/" + listingId + "/accounts/" + accountId, { method: "DELETE" });
      say("Account removed from the listing.");
      await load();
    });
  }

  function renderSales() {
    const rows = data.sales || [];
    if (!rows.length) {
      $("es-sales").innerHTML = '<div class="muted">No sales yet. They appear here within a few minutes of a marketplace order.</div>';
      return;
    }
    $("es-sales").innerHTML =
      '<div class="es-table-wrap"><table class="es-table"><thead><tr><th>When</th><th>Listing</th><th>Account</th><th>Order</th><th>Mail page</th><th></th></tr></thead><tbody>' +
      rows
        .map((s) => {
          const mail = s.accounts
            .map((a) => {
              const m = a.mail;
              if (!m) return '<span class="muted">—</span>';
              const st = m.live
                ? pill("open, closes " + until(m.expiresAt), "green")
                : m.revokedReason === "email_changed"
                  ? pill("closed: buyer changed the email", "green")
                  : pill(m.revokedReason ? "closed: " + m.revokedReason : "closed", "");
              return st + ' <span class="muted">' + (m.viewCount ? "opened " + m.viewCount + "×, last " + esc(ago(m.lastViewAt)) : "not opened yet") + "</span>";
            })
            .join("<br>");
          const stTone = /disputed|cancel/i.test(s.orderState) ? "red" : /completed|delivered/i.test(s.orderState) ? "green" : "";
          const isG2g = s.market === "g2g";
          const action = isG2g
            ? s.accounts.length
              ? '<button class="btn btn-sm" type="button" data-g2g-details="' + esc(s.orderId) + '">Show delivery details</button>'
              : ""
            : s.accounts.length
              ? '<button class="btn btn-sm" type="button" data-resend="' + esc(s.orderId) + '">New mail password</button>'
              : "";
          return (
            "<tr" + (s.needsAttention ? ' style="background:rgba(220,38,38,.06)"' : "") + '><td data-label="When">' + esc(when(s.orderCreatedAt)) + "</td>" +
            '<td data-label="Listing">' + pill(isG2g ? "G2G" : s.market === "playerauctions" ? "PlayerAuctions" : "Eldorado") + " " + esc(s.title) +
            (isG2g
              ? '<div class="muted">' +
                (s.matchedBy === "g2g-stock"
                  ? "sold instantly from G2G stock " + esc(ago(s.deliveredAt))
                  : s.deliveredAt
                    ? "delivered " + esc(ago(s.deliveredAt))
                    : s.releasedAt
                      ? "cancelled, account back on the shelf"
                      : s.submittedAt
                        ? "sent to G2G, waiting for it to confirm"
                        : "being delivered") +
                "</div>"
              : "") +
            "</td>" +
            '<td data-label="Account">' + (s.accounts.length ? esc(s.accounts.map((a) => a.label).join(", ")) : '<span class="bad">not matched</span>') + "</td>" +
            '<td data-label="Order">' + pill(s.orderState || "?", stTone) + " " + esc(money(s.priceUsd)) +
            '<div class="muted">' + esc(s.orderId) + (s.buyerUsername ? " · " + esc(s.buyerUsername) : "") + "</div>" +
            (s.note ? '<div class="es-err">' + esc(s.note) + "</div>" : "") + "</td>" +
            '<td data-label="Mail page">' + mail + "</td>" +
            '<td data-label="">' + action + "</td></tr>"
          );
        })
        .join("") +
      "</tbody></table></div>";
    $("es-sales").querySelectorAll("[data-resend]").forEach((b) => b.addEventListener("click", () => resend(b.dataset.resend, b)));
    $("es-sales").querySelectorAll("[data-g2g-details]").forEach((b) => b.addEventListener("click", () => g2gDetails(b.dataset.g2gDetails, b)));
  }

  async function resend(orderId, b) {
    if (!confirm("Make a new mail page password for this buyer? The old one stops working. Send the new one to the buyer in the Eldorado order chat.")) return;
    return busy(b, async () => {
      const j = await post("/api/epic/sales/sales/" + encodeURIComponent(orderId) + "/resend", {});
      $("es-access-text").value = j.access.message;
      $("es-access-title").textContent = "New mail page password";
      $("es-access-warn").textContent = "Copy this now. The password is shown only once. Send it to the buyer in the Eldorado order chat.";
      openModal("es-access-modal");
      await load();
    });
  }

  function renderStock() {
    const rows = data.stock || [];
    if (!rows.length) {
      $("es-stock").innerHTML = '<div class="muted">No Epic accounts.</div>';
      return;
    }
    const tone = { ready: "green", listed: "", sold: "", blocked: "red" };
    const text = { ready: "ready", listed: "on sale", sold: "sold", blocked: "can't sell" };
    $("es-stock").innerHTML =
      '<div class="es-table-wrap"><table class="es-table"><thead><tr><th>Account</th><th>Games</th><th>Status</th></tr></thead><tbody>' +
      rows
        .map((s) => {
          const reasons = (s.blockers || []).map((x) => '<li class="block">' + esc(x) + "</li>").concat((s.warnings || []).map((x) => "<li>" + esc(x) + "</li>"));
          return (
            '<tr><td data-label="Account"><b>' + esc(s.label) + '</b><div class="muted">' + esc(s.email || "no email saved") + "</div></td>" +
            '<td data-label="Games">' + esc(s.libraryCount) + (s.games.length ? ' <span class="muted">' + esc(s.games.slice(0, 3).join(", ") + (s.games.length > 3 ? ", …" : "")) + "</span>" : "") + "</td>" +
            '<td data-label="Status">' + pill(text[s.state] || s.state, tone[s.state]) +
            (s.listing ? ' <span class="muted">' + esc(s.listing.title) + "</span>" : "") +
            (reasons.length ? '<ul class="es-reasons">' + reasons.join("") + "</ul>" : "") + "</td></tr>"
          );
        })
        .join("") +
      "</tbody></table></div>";
  }

  function renderOthers() {
    const o = data.others || {};
    const card = $("es-others-card");
    if (o.error) {
      card.hidden = false;
      $("es-others").innerHTML = '<div class="es-err">Could not read your Eldorado offers: ' + esc(o.error) + "</div>";
      return;
    }
    const list = o.offers || [];
    card.hidden = !list.length;
    $("es-others").innerHTML = list
      .map(
        (x) =>
          '<div class="es-meta"><a href="' + esc(x.url) + '" target="_blank" rel="noopener">' + esc(x.title || x.id) + "</a> · " +
          esc(x.state) + " · qty " + esc(x.quantity) + " · " + esc(money(x.priceUsd)) + ' · <span class="muted">' + esc(x.id) + "</span></div>",
      )
      .join("");
  }

  // ---- modals -------------------------------------------------------------
  function buildModals() {
    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <div class="modal-wrap es-modal" id="es-create-modal">
        <div class="modal">
          <h3>List on Eldorado</h3>
          <div class="modal-sub">Instant delivery: every account below becomes one unit of stock. Eldorado gives each buyer one account's Epic login plus its mail page login.</div>
          <label for="es-c-section">Where on Eldorado</label>
          <select id="es-c-section">
            <option value="epic">Epic Games accounts</option>
            <option value="rocket-league">Rocket League accounts (PC): fresh accounts only</option>
          </select>
          <div class="hint" id="es-c-section-hint"></div>
          <label>Accounts</label><div class="es-acc-list" id="es-c-accounts"></div>
          <label for="es-c-title">Title</label><input id="es-c-title" maxlength="160">
          <label for="es-c-price">Price per account (USD)</label><input id="es-c-price" type="number" min="0.05" step="0.01" placeholder="e.g. 0.49">
          <div class="es-market" id="es-c-market"><span class="muted">Loading cheapest similar offers…</span></div>
          <label for="es-c-desc">Description</label><textarea id="es-c-desc" maxlength="2000"></textarea>
          <label for="es-c-cover">Cover image link</label><input id="es-c-cover" placeholder="https://…">
          <img class="es-cover" id="es-c-cover-img" alt="" hidden>
          <label class="es-check"><input type="checkbox" id="es-c-orig"> <span>Mark as “Original email included”. Leave this off: Eldorado describes it as the buyer owning the first-ever email, and here the buyer only gets Epic's emails through the mail page.</span></label>
          <div class="es-preview" id="es-c-preview"></div>
          <div class="modal-actions">
            <button class="btn" type="button" data-close="es-create-modal">Cancel</button>
            <button class="btn" type="button" id="es-c-check">Check</button>
            <button class="btn btn-primary" type="button" id="es-c-publish" disabled>Publish on Eldorado</button>
          </div>
        </div>
      </div>
      <div class="modal-wrap es-modal" id="es-add-modal">
        <div class="modal">
          <h3>Add accounts</h3>
          <div class="modal-sub" id="es-a-sub"></div>
          <div class="es-acc-list" id="es-a-accounts"></div>
          <div class="modal-actions">
            <button class="btn" type="button" data-close="es-add-modal">Cancel</button>
            <button class="btn btn-primary" type="button" id="es-a-save">Add to listing</button>
          </div>
        </div>
      </div>
      <div class="modal-wrap es-modal" id="es-text-modal">
        <div class="modal">
          <h3>Edit listing text</h3>
          <label for="es-t-title">Title</label><input id="es-t-title" maxlength="160">
          <label for="es-t-desc">Description</label><textarea id="es-t-desc" maxlength="2000"></textarea>
          <div class="modal-actions">
            <button class="btn" type="button" data-close="es-text-modal">Cancel</button>
            <button class="btn btn-primary" type="button" id="es-t-save">Save on Eldorado</button>
          </div>
        </div>
      </div>
      <div class="modal-wrap es-modal" id="es-g2g-modal">
        <div class="modal">
          <h3>Sell on G2G</h3>
          <div class="modal-sub" id="es-g-sub"></div>
          <label for="es-g-offer">G2G offer number</label>
          <input id="es-g-offer" placeholder="G1793242175124IO" autocomplete="off" spellcheck="false">
          <label for="es-g-days">Mail page open for</label>
          <select id="es-g-days">${[1, 2, 3, 5, 7, 10, 14].map((d) => '<option value="' + d + '">' + d + " day" + (d > 1 ? "s" : "") + "</option>").join("")}</select>
          <div class="hint">G2G asks account sellers to cover the account for at least 14 days.</div>
          <div class="modal-actions">
            <button class="btn" type="button" data-close="es-g2g-modal">Cancel</button>
            <button class="btn btn-primary" type="button" id="es-g-save">Link and deliver automatically</button>
          </div>
        </div>
      </div>
      <div class="modal-wrap es-modal" id="es-access-modal">
        <div class="modal">
          <h3 id="es-access-title">New mail page password</h3>
          <div class="warn" id="es-access-warn">Copy this now. The password is shown only once. Send it to the buyer in the Eldorado order chat.</div>
          <textarea id="es-access-text" readonly></textarea>
          <div class="modal-actions">
            <button class="btn" type="button" data-close="es-access-modal">Close</button>
            <button class="btn btn-primary" type="button" id="es-access-copy">Copy</button>
          </div>
        </div>
      </div>`;
    while (wrap.firstElementChild) document.body.append(wrap.firstElementChild);
    document.querySelectorAll(".es-modal").forEach((m) =>
      m.addEventListener("click", (e) => {
        if (e.target === m) closeModal(m.id);
      }),
    );
    document.querySelectorAll(".es-modal [data-close]").forEach((b) => b.addEventListener("click", () => closeModal(b.dataset.close)));
    $("es-c-check").addEventListener("click", checkCreate);
    $("es-c-publish").addEventListener("click", publish);
    ["es-c-title", "es-c-price", "es-c-desc", "es-c-cover", "es-c-orig"].forEach((id) =>
      $(id).addEventListener("input", () => ($("es-c-publish").disabled = true)),
    );
    $("es-c-cover").addEventListener("change", showCover);
    $("es-c-section").addEventListener("change", applySection);
    $("es-a-save").addEventListener("click", saveAdd);
    $("es-t-save").addEventListener("click", saveText);
    $("es-g-save").addEventListener("click", saveG2gLink);
    $("es-g-offer").addEventListener("keydown", (e) => {
      if (e.key === "Enter") saveG2gLink();
    });
    $("es-access-copy").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText($("es-access-text").value);
      } catch {
        $("es-access-text").select();
        document.execCommand("copy");
      }
      say("Copied.");
    });
  }

  function openModal(id) {
    $(id).classList.add("show");
  }
  function closeModal(id) {
    $(id).classList.remove("show");
  }

  function readyAccounts() {
    return (data.stock || []).filter((s) => s.state === "ready");
  }

  function accountChecks(el, rows, checkedIds) {
    el.innerHTML = rows.length
      ? rows
          .map(
            (s) =>
              '<label class="es-check"><input type="checkbox" value="' + esc(s._id) + '"' + (checkedIds.has(s._id) ? " checked" : "") + "> <span><b>" + esc(s.label) + "</b> " +
              '<span class="muted">' + esc(s.libraryCount) + " game(s)" + (s.games.length ? ": " + esc(s.games.slice(0, 4).join(", ")) : "") + "</span></span></label>",
          )
          .join("")
      : '<div class="muted">No ready accounts.</div>';
  }

  function checkedIn(el) {
    return [...el.querySelectorAll("input[type=checkbox]:checked")].map((i) => i.value);
  }

  let createGroup = null;
  function openCreate(group) {
    createGroup = group;
    const ready = readyAccounts();
    const ids = new Set(group.accounts.map((a) => a._id));
    // Same game set first, then the rest.
    accountChecks($("es-c-accounts"), ready.filter((s) => ids.has(s._id)).concat(ready.filter((s) => !ids.has(s._id))), ids);
    $("es-c-accounts").querySelectorAll("input").forEach((i) => i.addEventListener("change", () => ($("es-c-publish").disabled = true)));
    // Fresh accounts default to the Rocket League section while Eldorado
    // refuses the Epic Games one; accounts with games never go there.
    const perm = ((data.health || {}).eldorado || {}).permission || {};
    const sel = $("es-c-section");
    sel.querySelector('option[value="rocket-league"]').disabled = !group.rocketLeague;
    sel.value = group.rocketLeague && perm.canSell !== true ? "rocket-league" : "epic";
    $("es-c-price").value = "";
    $("es-c-orig").checked = false;
    openModal("es-create-modal");
    applySection();
  }

  // Fill the window for the chosen section: its suggested text, cover and
  // market check.
  function applySection() {
    const group = createGroup;
    const rl = $("es-c-section").value === "rocket-league";
    const perm = ((data.health || {}).eldorado || {}).permission || {};
    $("es-c-section-hint").textContent = rl
      ? "Fresh accounts only (no games). Filed under Rocket League › Accounts, Device PC, unranked, level 0–9. Buyers get the same delivery as the Epic shelf."
      : perm.canSell === false
        ? "Eldorado doesn't allow this seller to list Epic Games accounts yet."
        : "";
    $("es-c-title").value = rl ? group.rocketLeague.title : group.suggestedTitle;
    $("es-c-desc").value = rl ? group.rocketLeague.description : group.suggestedDescription;
    $("es-c-cover").value = "";
    $("es-c-preview").innerHTML = "";
    $("es-c-publish").disabled = true;
    showCover();
    if (rl) market(["fresh"], "rocket-league");
    else market(group.games.slice(0, 2));
    // The cover the server would pick (freebie art) comes with the preview.
    if (!rl) {
      post("/api/epic/sales/preview", createBody())
        .then((j) => {
          if (!$("es-c-cover").value && j.preview.coverUrl) {
            $("es-c-cover").value = j.preview.coverUrl;
            showCover();
          }
        })
        .catch(() => {});
    }
  }

  // Cheapest live offers for each of the listing's first games (or for any
  // Epic account when it has none) — the "lowest price for the same set" check.
  async function market(games, section = "epic") {
    const box = $("es-c-market");
    const queries = games && games.length ? games : [""];
    box.innerHTML = '<span class="muted">Loading cheapest similar offers…</span>';
    const parts = [];
    for (const q of queries) {
      try {
        const j = await api("/api/epic/sales/market?q=" + encodeURIComponent(q) + "&section=" + encodeURIComponent(section));
        const m = j.market;
        parts.push(
          '<div><b>Cheapest on Eldorado for “' + esc(m.query || "any Epic account") + "”" +
            (section !== "epic" ? " in " + esc(m.sectionName || section) : "") + " (" + esc(m.total) + " offers)</b></div>" +
            (m.offers.length
              ? m.offers
                  .slice(0, 6)
                  .map(
                    (o) =>
                      '<div><span title="' + esc(o.title) + '">' + esc(o.title) + '</span><span><b>' + esc(money(o.priceUsd)) + "</b> " +
                      '<span class="muted">' + esc(o.seller) + (o.instant ? " · instant" : "") + "</span></span></div>",
                  )
                  .join("")
              : '<div class="muted">No offers match.</div>'),
        );
      } catch (e) {
        parts.push('<div class="muted">Market check for “' + esc(q) + "” failed: " + esc(e.message) + "</div>");
      }
    }
    box.innerHTML = parts.join("");
  }

  function showCover() {
    const url = $("es-c-cover").value.trim();
    const img = $("es-c-cover-img");
    const builtIn = !url && $("es-c-section").value === "rocket-league" && createGroup && createGroup.rocketLeague;
    if (/^https:\/\//i.test(url)) {
      img.src = url;
      img.hidden = false;
    } else if (builtIn) {
      img.src = createGroup.rocketLeague.cover;
      img.hidden = false;
    } else img.hidden = true;
  }

  function createBody() {
    return {
      accountIds: checkedIn($("es-c-accounts")),
      title: $("es-c-title").value.trim(),
      priceUsd: $("es-c-price").value === "" ? undefined : Number($("es-c-price").value),
      description: $("es-c-desc").value,
      coverUrl: $("es-c-cover").value.trim(),
      hasOriginalEmail: $("es-c-orig").checked,
      section: $("es-c-section").value,
    };
  }

  async function checkCreate() {
    const b = $("es-c-check");
    const box = $("es-c-preview");
    $("es-c-publish").disabled = true;
    await busy(b, async () => {
      const body = createBody();
      if (body.priceUsd == null) throw new Error("Set a price first.");
      const j = await post("/api/epic/sales/preview", body);
      const p = j.preview;
      const blocking = (p.problems || []).filter((x) => !/don't all own/.test(x));
      box.innerHTML =
        "<b>" + esc(p.quantity) + " account(s) × " + esc(money(p.priceUsd)) + "</b> in " + esc(p.sectionName || "Epic Games accounts") + " — " + esc(p.title) +
        (p.problems && p.problems.length ? '<ul class="es-reasons">' + p.problems.map((x) => '<li class="block">' + esc(x) + "</li>").join("") + "</ul>" : "") +
        '<div class="muted" style="margin-top:8px">Each buyer gets: Epic login + password · Email details: ' + esc(p.providerUrl) +
        " with its own password · this note:</div><pre>" + esc(p.note) + "</pre>" +
        '<div class="muted">Accounts: ' + esc(p.units.map((u) => u.label).join(", ")) + "</div>";
      $("es-c-publish").disabled = blocking.length > 0;
    });
  }

  async function publish() {
    const body = createBody();
    const where = $("es-c-section").selectedOptions[0].textContent;
    if (!confirm("Publish this listing on Eldorado now?\n\n" + where + "\n" + body.title + "\n" + body.accountIds.length + " account(s) × $" + Number(body.priceUsd).toFixed(2) + "\n\nIt goes on sale immediately.")) return;
    const b = $("es-c-publish");
    await busy(b, async () => {
      const j = await post("/api/epic/sales/listings", { ...body, confirm: true, allowMixed: true });
      closeModal("es-create-modal");
      say("Listed: " + j.listing.title);
      await load();
    });
  }

  let addListing = null;
  function openAdd(l) {
    addListing = l;
    $("es-a-sub").textContent =
      "Adds stock to “" + l.title + "”. " +
      (l.section === "rocket-league" ? "Only fresh accounts (no games) belong here." : "Only accounts that own the same games belong here.");
    const same = new Set((l.games || []).map((g) => g.toLowerCase()).sort());
    const key = [...same].join("|");
    const ready = readyAccounts();
    const sameRows = ready.filter((s) => s.games.map((g) => g.toLowerCase()).sort().join("|") === key);
    accountChecks($("es-a-accounts"), sameRows, new Set(sameRows.map((s) => s._id)));
    openModal("es-add-modal");
  }

  async function saveAdd() {
    const ids = checkedIn($("es-a-accounts"));
    if (!ids.length) return say("Choose at least one account.", true);
    await busy($("es-a-save"), async () => {
      await post("/api/epic/sales/listings/" + addListing._id + "/accounts", { accountIds: ids });
      closeModal("es-add-modal");
      say("Added " + ids.length + " account(s).");
      await load();
    });
  }

  let textListing = null;
  function openText(l) {
    textListing = l;
    $("es-t-title").value = l.title;
    $("es-t-desc").value = l.description || "";
    openModal("es-text-modal");
  }

  async function saveText() {
    await busy($("es-t-save"), async () => {
      await post("/api/epic/sales/listings/" + textListing._id + "/text", { title: $("es-t-title").value, description: $("es-t-desc").value });
      closeModal("es-text-modal");
      say("Saved on Eldorado.");
      await load();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
