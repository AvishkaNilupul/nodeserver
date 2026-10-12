/* SOOP farm — Activity tab: the farm's log, plus a System panel that answers
   "why is nothing earning?". Contract §4, §11, §13, §14; kit: UI-KIT.md. */
(function () {
  "use strict";
  const { el, ui, fmt } = Soop;

  const LOG_MS = 15000;          // the log is re-read every 15 s, not on the 3 s state poll
  const LIMIT = 300;
  const LEVELS = { error: ["error", "Error"], warn: ["warn", "Warning"], info: ["info", "Info"] };
  const CREDIT_RULE = "SOOP only counts watch time when the country an account claims matches the country of the connection, "
    + "and that country is one SOOP pays drops in.";

  let panel = "activity";        // "activity" | "system" — kept in memory and mirrored in the hash
  let routed = false;            // true once the first "tab" event has delivered the hash params
  const f = { level: "all", accountId: "", botId: "", q: "" };
  let entries = [], loadedAt = 0, loading = false, seq = 0, loadError = "";
  const v = {};                  // nodes built once in render()

  // ---------- small helpers --------------------------------------------------
  const plural = (n, one, many) => fmt.num(n || 0) + " " + (n === 1 ? one : many || one + "s");
  const stamp = (iso) => fmt.when(iso) + " (" + fmt.ago(iso) + ")";
  const muted = (text) => el("span", { class: "s-muted" }, text);
  // Rebuilds a node only when what it shows has changed, so the 3 s poll never
  // disturbs a text selection or a hover.
  function put(node, sig, build) {
    sig = String(sig);
    if (node._sig === sig) return;
    node._sig = sig;
    node.replaceChildren(el("span", null, build()));
  }
  function accountLabel(id) { return String(id); } // the login id, as every other tab names an account
  function botLabel(id) { const b = Soop.botById(id); return b ? b.name || "Unnamed bot" : "Removed bot"; }
  // A name that follows the §14 cross-tab link; plain text when the thing is gone.
  function link(tab, id, known, label) {
    if (!id) return muted("–");
    if (!known) return el("span", { class: "s-muted", title: "No longer in the farm" }, label);
    return el("a", { class: "s-link", href: "#" + tab + "?id=" + encodeURIComponent(id), title: "Open " + label,
      onClick: (e) => { e.preventDefault(); Soop.go(tab, { id }); } }, label);
  }

  // ---------- Activity panel -------------------------------------------------
  function path(level) {
    return "/activity?limit=" + LIMIT + "&level=" + level + "&accountId=" + encodeURIComponent(f.accountId) + "&botId=" + encodeURIComponent(f.botId);
  }
  function load() {
    const my = ++seq;            // a reply to an older filter is dropped
    loading = true;
    // The API filters on one level at a time, so "Warnings and errors" is two reads merged.
    const levels = f.level === "problems" ? ["warn", "error"] : [f.level === "error" ? "error" : ""];
    return Promise.all(levels.map((l) => Soop.api.get(path(l)).then((j) => j.entries || [])))
      .then((lists) => {
        if (my !== seq) return;
        entries = [].concat(...lists).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, LIMIT);
        loadError = "";
      }, (e) => { if (my === seq) loadError = (e && e.message) || "No answer from the server"; })
      .then(() => { if (my !== seq) return; loading = false; loadedAt = Date.now(); draw(); });
  }
  function reload() { loadedAt = 0; if (routed) load(); }
  function matches() {
    const q = f.q.toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => ((e.msg || "") + " " + (e.accountId ? accountLabel(e.accountId) + " " + e.accountId : "") + " " + (e.botId ? botLabel(e.botId) : "")).toLowerCase().includes(q));
  }
  function draw() {
    if (!v.table) return;
    const rows = matches(), filtered = !!(f.level !== "all" || f.accountId || f.botId || f.q);
    put(v.empty, filtered, () => (filtered
      ? ui.empty("No entries match these filters", "Widen the filters to see more of the log.", { label: "Clear filters", onClick: clearFilters })
      : ui.empty("Nothing logged yet", "The log fills as bots run.")));
    // New rows arrive at the top. When the reader has scrolled down, hold the
    // row they are looking at exactly where it is.
    const box = v.table;
    let anchor = null, was = 0;
    if (box.scrollTop > 0) {
      const edge = box.getBoundingClientRect().top;
      anchor = Array.prototype.find.call(box.querySelectorAll("tbody tr[data-key]"), (tr) => tr.getBoundingClientRect().bottom > edge) || null;
      if (anchor) was = anchor.getBoundingClientRect().top;
    }
    box.update(rows);
    if (anchor && anchor.isConnected) box.scrollTop += anchor.getBoundingClientRect().top - was;

    v.error.hidden = !loadError;
    v.errorMsg.textContent = loadError ? "The log could not be loaded: " + loadError + " Trying again in a few seconds." : "";
    v.count.textContent = rows.length !== entries.length ? fmt.num(rows.length) + " of " + plural(entries.length, "entry", "entries") + " match the search"
      : entries.length >= LIMIT ? "Newest " + LIMIT + " entries" : plural(entries.length, "entry", "entries");
  }
  function clearFilters() {
    f.level = "all"; f.accountId = ""; f.botId = ""; f.q = "";
    v.level.set("all"); v.search.set("");
    syncFilters(); mirror(); reload(); draw();
  }
  // Keeps the two dropdowns in step with Soop.state without rebuilding them on every poll.
  function fillSelect(sel, allLabel, list, current) {
    if (current && !list.some((o) => o.id === current)) list = list.concat([{ id: current, label: current + " (removed)" }]);
    const sig = list.map((o) => o.id + "\u0001" + o.label).join("\u0002");
    if (sel._sig !== sig) {
      sel._sig = sig;
      sel.replaceChildren(el("option", { value: "" }, allLabel), ...list.map((o) => el("option", { value: o.id }, o.label)));
    }
    if (sel.value !== current) sel.value = current;
  }
  function syncFilters() {
    const s = Soop.state;
    fillSelect(v.account, "All accounts", (s.accounts || []).map((a) => ({ id: String(a.id), label: a.nick && a.nick !== a.id ? a.nick + " (" + a.id + ")" : String(a.id) })), f.accountId);
    fillSelect(v.bot, "All bots", (s.bots || []).map((b) => ({ id: String(b.id), label: b.name || "Unnamed bot" })), f.botId);
  }
  function buildActivity() {
    const pick = (label, key) => el("select", { class: "s-select", "aria-label": label, style: { width: "auto", flex: "1 1 150px", maxWidth: "240px" },
      onChange: (e) => { f[key] = e.target.value; mirror(); reload(); } });
    v.level = ui.chips({ value: f.level, onChange: (x) => { f.level = x; reload(); },
      options: [{ value: "all", label: "All" }, { value: "problems", label: "Warnings and errors" }, { value: "error", label: "Errors" }] });
    v.account = pick("Filter by account", "accountId");
    v.bot = pick("Filter by bot", "botId");
    v.search = ui.search({ placeholder: "Search messages", onInput: (q) => { f.q = q; draw(); } });
    v.count = el("span", { class: "s-muted s-small s-nowrap", "aria-live": "polite" });
    v.errorMsg = el("span");
    v.error = el("div", { class: "s-note is-error", role: "alert", hidden: true }, ui.icon("alert"), v.errorMsg);
    v.empty = el("div");
    v.table = ui.table({ key: "id", empty: v.empty, rows: [], columns: [
      { label: "Time", render: (e) => el("span", { class: "s-nowrap", title: fmt.when(e.at) + " · " + fmt.ago(e.at) }, fmt.when(e.at), el("span", { class: "s-muted s-small s-hide-sm" }, " · " + fmt.ago(e.at))) },
      { label: "Level", render: (e) => { const l = LEVELS[e.level] || LEVELS.info; return el("span", { class: "s-nowrap" }, ui.dot(l[0], l[1]), " ", l[1]); } },
      { label: "Account", render: (e) => link("accounts", e.accountId, !!Soop.accountById(e.accountId), e.accountId ? accountLabel(e.accountId) : "") },
      { label: "Bot", hide: "sm", render: (e) => link("bots", e.botId, !!Soop.botById(e.botId), e.botId ? botLabel(e.botId) : "") },
      { label: "Message", wrap: true, key: "msg" }] });
    return el("div", { class: "s-stack" },
      el("div", { class: "s-toolbar", style: { marginBottom: "0" } }, v.level, v.account, v.bot, v.search, el("span", { class: "s-grow" }), v.count),
      v.error, v.table);
  }

  // ---------- System panel ---------------------------------------------------
  function card(title, action, ...body) {
    return el("section", { class: "s-card" }, el("div", { class: "s-card-hd" }, el("h2", { class: "s-card-title s-grow" }, title), action),
      el("div", { class: "s-card-bd s-stack" }, body));
  }
  // A definition list whose values are filled in by paintSystem(); returns the <dd> nodes by name.
  function facts(spec) {
    const out = {}, dl = el("dl", { class: "s-kv" }, Object.keys(spec).map((k) => [el("dt", spec[k]), (out[k] = el("dd"))]));
    out.el = dl;
    return out;
  }
  function spark(label) {
    const line = el("polyline", { points: "" }), cap = el("span", { class: "s-muted s-small" });
    const box = el("div", { class: "s-stack is-tight" }, el("div", { class: "s-spread" }, el("p", { class: "s-eyebrow" }, label), cap),
      el("svg", { class: "s-spark", viewBox: "0 0 100 30", preserveAspectRatio: "none", role: "img", "aria-label": label + " over time" }, line));
    // fromZero pins the bottom of the chart to 0; otherwise the line is centred on its own range.
    box.set = (vals, minSpan, fromZero, caption) => {
      cap.textContent = vals.length > 1 ? caption : "Collecting samples…";
      if (vals.length < 2) { line.setAttribute("points", ""); return; }
      const lo = fromZero ? 0 : Math.min(...vals), hi = Math.max(...vals), span = Math.max(hi - lo, minSpan), base = fromZero ? 0 : (lo + hi) / 2 - span / 2;
      line.setAttribute("points", vals.map((n, i) => ((i / (vals.length - 1)) * 100).toFixed(1) + "," + (28 - ((n - base) / span) * 26).toFixed(1)).join(" "));
    };
    return box;
  }
  function buildSystem() {
    v.eg = facts({ route: "Connection", country: "Country SOOP sees", credited: "Watch time counted here", ok: "Last successful call", err: "Last error" });
    v.conn = card("Connection", null, v.eg.el, el("div", { class: "s-note" }, ui.icon("info"), el("span", CREDIT_RULE)));

    v.sc = facts({ at: "Last refresh", count: "Campaigns", result: "Result" });
    v.scan = card("Campaign list", ui.button("Refresh now", { size: "sm", icon: "refresh", onClick: () => Soop.refreshCampaigns(true).then((j) => {
      const failed = !j || (j.scan && j.scan.ok === false);
      Soop.toast(failed ? (j && j.scan && j.scan.error) || "The campaign list could not be refreshed" : "Campaign list refreshed", failed ? "error" : "ok");
      return Soop.refresh();
    }) }), v.sc.el);

    v.accOk = ui.stat("Logged in", "–"); v.accDead = ui.stat("Logged out", "–"); v.accSold = ui.stat("Sold", "–");
    v.recheck = ui.button("Re-check all logins", { size: "sm", icon: "refresh", onClick: () => Soop.api.post("/accounts/check", { ids: [] }).then((j) => {
      Soop.toast("Checking " + plural(j.total, "account") + " — allow a few seconds for each", "ok");
      return Soop.refresh();
    }) });
    v.deadLink = el("a", { class: "s-link s-small", href: "#accounts?status=dead", hidden: true, onClick: (e) => { e.preventDefault(); Soop.go("accounts", { status: "dead" }); } }, "Show the logged-out accounts");
    v.accounts = card("Accounts", v.recheck, el("div", { class: "s-stats" }, v.accOk, v.accDead, v.accSold), v.deadLink,
      el("p", { class: "s-muted s-small", style: { margin: "0" } }, "A re-check is paced so SOOP is not flooded: it takes a few seconds per account, and each status updates here as it lands."));

    v.ram = ui.stat("RAM", "–"); v.cpu = ui.stat("CPU", "–"); v.sockets = ui.stat("Viewer sockets", "–"); v.free = ui.stat("Free system memory", "–");
    v.ramSpark = spark("RAM"); v.cpuSpark = spark("CPU");
    v.resources = card("Resources", null, el("div", { class: "s-stats" }, v.ram, v.cpu, v.sockets, v.free), v.ramSpark, v.cpuSpark);

    return el("div", { class: "s-grid" }, v.conn, v.scan, v.accounts, v.resources);
  }
  const mem = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(1) + " GB" : fmt.num(Math.round(mb)) + " MB");
  function paintSystem() {
    const s = Soop.state, eg = s.egress || {}, t = s.totals || {}, sc = s.scan || {}, m = s.metrics || {};

    // Connection
    const down = !!eg.proxied && !eg.ready;
    v.conn.className = "s-card" + (down || eg.credited === "no" ? " is-error" : eg.credited === "yes" ? " is-ok" : " is-warn");
    put(v.eg.route, [eg.proxied, eg.ready, eg.via], () => (eg.proxied
      ? ["Through a proxy: ", el("span", { class: "s-mono" }, eg.via || "address unknown"), down ? [" ", ui.badge("Proxy is down", "error")] : null]
      : "Direct from this server, no proxy"));
    put(v.eg.country, eg.country || "", () => (eg.country ? el("b", eg.country) : muted("Not known yet — it is looked up on the first call to SOOP")));
    put(v.eg.credited, [eg.credited, eg.country], () => (eg.credited === "yes" ? [ui.badge("Yes", "ok"), " accounts earn from here"]
      : eg.credited === "no" ? [ui.badge("No", "error"), " SOOP does not pay drops in this country, so nothing is earned"]
      : [ui.badge("Not measured yet", "warn"), eg.country ? " nobody has tested this country; watch whether minutes go up" : " the country is not known yet"]));
    put(v.eg.ok, eg.lastOkAt ? stamp(eg.lastOkAt) : "", () => (eg.lastOkAt ? stamp(eg.lastOkAt) : muted("No call has succeeded yet")));
    const stale = eg.lastErrorAt && eg.lastOkAt && eg.lastOkAt > eg.lastErrorAt;
    put(v.eg.err, eg.lastErrorAt ? [eg.lastError, stamp(eg.lastErrorAt), stale] : "", () => (!eg.lastErrorAt ? muted("None")
      : [el("span", { class: stale ? null : "s-error" }, eg.lastError || "A call to SOOP failed"), el("span", { class: "s-muted" }, " — " + stamp(eg.lastErrorAt) + (stale ? ", working again since" : ""))]));

    // Campaign list
    const live = (Soop.campaigns || []).filter((c) => c.live).length, failed = sc.ok === false || !!sc.error;
    v.scan.className = "s-card" + (failed ? " is-error" : "");
    put(v.sc.at, sc.at ? stamp(sc.at) : "", () => (sc.at ? stamp(sc.at) : muted("Not refreshed yet")));
    put(v.sc.count, [sc.count, live], () => [el("b", { class: "s-num" }, fmt.num(sc.count || 0)), muted(" · " + fmt.num(live) + " live now")]);
    put(v.sc.result, [sc.at, sc.ok, sc.error], () => (failed ? el("span", { class: "s-row" }, ui.dot("error", "Failed"), el("span", { class: "s-error" }, sc.error || "The last refresh failed"))
      : sc.at ? el("span", { class: "s-row" }, ui.dot("ok", "Working"), "Loaded without errors") : muted("Waiting for the first refresh")));

    // Accounts
    v.accOk.set(fmt.num(t.ok || 0), "of " + plural(t.accounts, "account"), t.ok ? "ok" : null);
    v.accDead.set(fmt.num(t.dead || 0), t.dead ? "Re-import the cookie" : "None need attention", t.dead ? "error" : null);
    v.accSold.set(fmt.num(t.sold || 0), "Never farmed");
    v.deadLink.hidden = !t.dead;
    v.recheck.disabled = !t.accounts;

    // Resources
    v.ram.set(m.rssMB == null ? "–" : mem(m.rssMB), m.heapMB == null ? null : "JS heap " + mem(m.heapMB));
    v.cpu.set(m.cpuPct == null ? "–" : m.cpuPct + "%", "of one core");
    v.sockets.set(fmt.num(m.sockets || 0), "one per account earning");
    v.free.set(m.freeMemMB == null ? "–" : mem(m.freeMemMB), m.totalMemMB ? "of " + mem(m.totalMemMB) : null);   // no tone: the OS keeps "free" low on purpose
    const smp = m.samples || [], last = smp[smp.length - 1], sig = smp.length + ":" + (last ? last.t : 0);
    if (v.resources._sig !== sig) {
      v.resources._sig = sig;
      const span = smp.length > 1 ? "last " + Math.max(1, Math.round((last.t - smp[0].t) / 60000)) + " min" : "";
      const ram = smp.map((x) => Number(x.rssMB) || 0), cpu = smp.map((x) => Number(x.cpu) || 0);
      v.ramSpark.set(ram, 20, false, mem(Math.min(...ram)) + " to " + mem(Math.max(...ram)) + " · " + span);
      v.cpuSpark.set(cpu, 10, true, "peak " + Math.max(...cpu) + "% · " + span);
    }
  }

  // ---------- Panel switch, routing, registration ------------------------------
  function mirror() { Soop.go("activity", { panel: panel === "system" ? "system" : "", accountId: f.accountId, botId: f.botId }); }
  function tick() {
    if (!v.seg) return;
    if (v.seg.value() !== panel) v.seg.set(panel);
    v.activityBox.hidden = panel !== "activity";
    v.systemBox.hidden = panel !== "system";
    syncFilters();
    if (panel === "system") paintSystem();
    else if (routed && !loading && Date.now() - loadedAt >= LOG_MS) load();
  }
  // Fires after render + update, with the hash params as strings (§14).
  Soop.on("tab", ({ id, params }) => {
    if (id !== "activity" || !v.seg) return;
    routed = true;
    const a = params.accountId || "", b = params.botId || "";
    if (params.panel) panel = params.panel === "system" ? "system" : "activity";
    if ((a || b) && (a !== f.accountId || b !== f.botId)) {      // a link from another tab: show that account's or bot's whole log
      f.accountId = a; f.botId = b; f.level = "all"; f.q = "";
      v.level.set("all"); v.search.set("");
      if (!params.panel) panel = "activity";
      loadedAt = 0; seq++; loading = false;
    }
    tick();
  });

  Soop.registerTab({
    id: "activity", label: "Activity",
    render(root) {
      v.activityBox = buildActivity();
      v.systemBox = buildSystem();
      v.seg = ui.chips({ value: panel, options: [{ value: "activity", label: "Activity" }, { value: "system", label: "System" }],
        onChange: (x) => { panel = x; tick(); mirror(); } });
      v.seg.setAttribute("aria-label", "Activity or System");
      root.append(el("div", { class: "s-stack" }, v.seg, v.activityBox, v.systemBox));
    },
    update: tick,
    badge() { return null; },    // the Overview carries the alerts
  });
})();
