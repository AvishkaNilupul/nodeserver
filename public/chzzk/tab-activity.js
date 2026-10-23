/* CHZZK farm — Activity tab: the farm's log, newest first, with level / kind / login
   filters and a search. Contract docs/CHZZK-PANEL-V2.md §4.6; kit: public/soop/UI-KIT.md. */
(function () {
  "use strict";
  const { el, ui, fmt } = Chzzk;

  const LOG_MS = 15000;           // the log is re-read at most every 15 s, not on each 5 s state poll
  const FIRST = 200, MORE = 500;  // newest N entries; "Load 500" raises it for the rest of the visit
  const LEVELS = { error: ["error", "Error"], warn: ["warn", "Warning"], info: [null, "Info"] };
  const KINDS = { watch: "Watch", farm: "Farm", progress: "Progress", code: "Code", collect: "Collect", import: "Import",
    egress: "Connection", alert: "Alert", discovery: "Campaign scan", switch: "Farm switch", worker: "Worker", reveal: "Reveal" };
  const ORDER = Object.keys(KINDS);

  const f = { level: "all", kind: "*", accountId: "", q: "" };
  let limit = FIRST, entries = [], loadedAt = 0, loading = false, seq = 0, loadError = "";
  const v = {};                   // nodes built once in render()

  // ---------- small helpers --------------------------------------------------
  const plural = (n, one, many) => fmt.num(n || 0) + " " + (n === 1 ? one : many || one + "s");
  const muted = (text, title) => el("span", { class: "s-muted", title: title || null }, text);
  const levelOf = (e) => (e.level === "error" || e.level === "warn" ? e.level : "info");
  const kindOf = (e) => (e.kind ? String(e.kind) : "other");
  const kindLabel = (k) => KINDS[k] || k.charAt(0).toUpperCase() + k.slice(1);
  const rank = (k) => { const i = ORDER.indexOf(k); return i < 0 ? ORDER.length : i; };
  const hasNo = (no) => no != null && no !== "";
  const accountOf = (e) => (e.accountId ? Chzzk.accountById(e.accountId) : null);
  const campaignOf = (e) => (hasNo(e.campaignNo) ? Chzzk.campaignByNo(e.campaignNo) : null);
  const gameOf = (c) => Chzzk.gameName(c.categoryId, c.categoryValue);
  // Rebuilds a node only when what it shows has changed, so the poll never disturbs a hover.
  function put(node, sig, build) {
    if (node._sig === sig) return;
    node._sig = sig;
    node.replaceChildren(build());
  }
  // Entries carry no id: key them by time + login + message, numbering exact repeats,
  // so the table keeps its row elements (and the reader's place) across refreshes.
  function keyed(list) {
    const seen = new Map();
    return list.filter((e) => e && typeof e === "object").map((e) => {
      const base = String(e.at) + "\u0001" + (e.accountId || "") + "\u0001" + (e.msg || "");
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      e._key = n > 1 ? base + "\u0001" + n : base;
      return e;
    });
  }

  // ---------- loading --------------------------------------------------------
  function load() {
    const my = ++seq;             // a reply to an older login filter or limit is dropped
    loading = true;
    const path = "/activity?limit=" + limit + (f.accountId ? "&accountId=" + encodeURIComponent(f.accountId) : "");
    return Chzzk.api.get(path).then((j) => {
      if (my !== seq) return;
      entries = keyed(Array.isArray(j && j.entries) ? j.entries : []);
      loadError = "";
    }, (e) => { if (my === seq) loadError = (e && e.message) || "No answer from the server"; })
      .then(() => { if (my !== seq) return; loading = false; loadedAt = Date.now(); draw(); });
  }
  // The login filter is the only one the server applies, so changing it re-reads the log.
  function setLogin(id) {
    if (id === f.accountId) return;
    f.accountId = id;
    entries = []; loadError = ""; loadedAt = 0;   // never show another login's rows while loading
    syncLogins();
    load();
    draw();
  }
  function clearFilters() {
    f.level = "all"; f.kind = "*"; f.q = "";
    v.search.set("");
    if (f.accountId) setLogin(""); else draw();
  }

  // ---------- filters --------------------------------------------------------
  // "Warnings" means at least a warning, so errors stay in it.
  const passLevel = (e) => f.level === "all" || (f.level === "error" ? levelOf(e) === "error" : levelOf(e) !== "info");
  const passKind = (e) => f.kind === "*" || kindOf(e) === f.kind;
  function passText(e) {
    const a = accountOf(e), c = campaignOf(e);
    return [e.msg, kindLabel(kindOf(e)), a && a.nickname, a && a.userIdHash, c && gameOf(c), c && c.title, e.campaignNo]
      .filter((x) => x != null && x !== "").join(" ").toLowerCase().includes(f.q.toLowerCase());
  }
  function setOpts(chips, list, value) {
    const sig = list.map((o) => o.value + ":" + o.count).join(",");
    if (chips._sig !== sig) { chips._sig = sig; chips.setOptions(list); }
    if (chips.value() !== value) chips.set(value);
  }
  // Facet counts: each chip row counts what the other chip row and the search leave.
  function syncChips(pool) {
    const lv = { all: 0, warn: 0, error: 0 }, kinds = new Map();
    let kindAll = 0;
    pool.forEach((e) => {
      const l = levelOf(e), k = kindOf(e);
      if (passKind(e)) { lv.all++; if (l !== "info") lv.warn++; if (l === "error") lv.error++; }
      if (passLevel(e)) { kindAll++; kinds.set(k, (kinds.get(k) || 0) + 1); }
    });
    if (f.kind !== "*" && !kinds.has(f.kind)) kinds.set(f.kind, 0);   // a chosen kind never vanishes under the operator
    const ks = Array.from(kinds.keys()).sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
    setOpts(v.level, [{ value: "all", label: "All", count: lv.all }, { value: "warn", label: "Warnings", count: lv.warn },
      { value: "error", label: "Errors", count: lv.error }], f.level);
    setOpts(v.kind, [{ value: "*", label: "All kinds", count: kindAll }]
      .concat(ks.map((k) => ({ value: k, label: kindLabel(k), count: kinds.get(k) }))), f.kind);
  }
  // Keeps the login dropdown in step with Chzzk.state without rebuilding it on every poll.
  function syncLogins() {
    const list = (Chzzk.state.accounts || []).map((a) => ({ id: String(a.id),
      label: (a.nickname || "Unnamed login") + (a.userIdHash ? " (" + a.userIdHash + ")" : "") }))
      .sort((a, b) => a.label.localeCompare(b.label));
    if (f.accountId && !list.some((o) => o.id === f.accountId)) list.push({ id: f.accountId, label: "Removed login" });
    const sig = list.map((o) => o.id + "\u0001" + o.label).join("\u0002");
    if (v.login._sig !== sig) {
      v.login._sig = sig;
      v.login.replaceChildren(el("option", { value: "" }, "All logins"), ...list.map((o) => el("option", { value: o.id }, o.label)));
    }
    if (v.login.value !== f.accountId) v.login.value = f.accountId;
  }

  // ---------- drawing --------------------------------------------------------
  // New entries arrive at the top. When the reader has scrolled down the list, hold the
  // row they are reading exactly where it is instead of letting it slide away.
  function keepPlace(box, change) {
    let anchor = null, was = 0;
    if (box.scrollTop > 0) {
      const edge = box.getBoundingClientRect().top;
      anchor = Array.prototype.find.call(box.querySelectorAll("tbody tr"), (tr) => tr.getBoundingClientRect().bottom > edge) || null;
      if (anchor) was = anchor.getBoundingClientRect().top;
    }
    change();
    if (anchor && anchor.isConnected) box.scrollTop += anchor.getBoundingClientRect().top - was;
  }
  function draw() {
    if (!v.table) return;
    const pool = f.q ? entries.filter(passText) : entries;
    syncChips(pool);
    const rows = pool.filter((e) => passLevel(e) && passKind(e));
    const filtered = f.level !== "all" || f.kind !== "*" || !!f.accountId || !!f.q;
    const waiting = loading && !entries.length;
    put(v.empty, waiting ? "wait" : loadError && !entries.length ? "fail" : filtered ? "filtered" : "none", () => (waiting
      ? ui.empty("Loading the log…")
      : loadError && !entries.length ? ui.empty("Nothing to show", "The log appears once the server answers.")
      : filtered ? ui.empty("No entries match these filters", "Widen the filters to see more of the log.", { label: "Clear filters", onClick: clearFilters })
      : ui.empty("Nothing logged yet", "The log fills as the farm runs.")));
    keepPlace(v.table, () => v.table.update(rows));

    v.error.hidden = !loadError;
    v.errorMsg.textContent = loadError ? "The log could not be loaded: " + loadError + " Trying again in a few seconds." : "";
    v.count.textContent = waiting ? "Loading…"
      : rows.length !== entries.length ? fmt.num(rows.length) + " of " + plural(entries.length, "entry", "entries")
      : entries.length >= limit ? "Newest " + fmt.num(limit) + " entries" : plural(entries.length, "entry", "entries");
    // Nothing more to fetch once 500 are asked for, or when the server sent fewer than asked.
    v.more.hidden = limit >= MORE || (loadedAt > 0 && !loadError && entries.length < limit);
  }

  // ---------- cells ----------------------------------------------------------
  function loginCell(e) {
    if (!e.accountId) return muted("–");
    const a = accountOf(e);
    if (!a) return muted("Removed login", "No longer in the farm");
    return el("span", { class: "s-trunc", title: a.userIdHash || null }, a.nickname || "Unnamed login");
  }
  function gameCell(e) {
    if (!hasNo(e.campaignNo)) return muted("–");
    const c = campaignOf(e);
    if (!c) return muted("Campaign #" + e.campaignNo, "Not in the campaign list any more");
    return el("span", { class: "s-trunc", title: c.title || null }, gameOf(c));
  }

  // ---------- build, routing, registration -------------------------------------
  function build() {
    v.level = ui.chips({ value: f.level, options: [], onChange: (x) => { f.level = x; draw(); } });
    v.level.setAttribute("aria-label", "Filter by level");
    v.kind = ui.chips({ value: f.kind, options: [], onChange: (x) => { f.kind = x; draw(); } });
    v.kind.setAttribute("aria-label", "Filter by kind");
    v.login = el("select", { class: "s-select", "aria-label": "Filter by login", style: { width: "auto", flex: "1 1 150px", maxWidth: "240px" },
      onChange: (e) => setLogin(e.target.value) });
    v.search = ui.search({ placeholder: "Search the log", onInput: (q) => { f.q = q; draw(); } });
    v.count = el("span", { class: "s-muted s-small s-nowrap", "aria-live": "polite" });
    v.more = ui.button("Load 500", { size: "sm", title: "Show the newest 500 entries instead of 200",
      onClick: () => { limit = MORE; return load(); } });
    v.errorMsg = el("span");
    v.error = el("div", { class: "s-note is-error", role: "alert", hidden: true }, ui.icon("alert"), v.errorMsg);
    v.empty = el("div");
    v.table = ui.table({ key: (e) => e._key, empty: v.empty, rows: [], columns: [
      { label: "Time", render: (e) => el("span", { class: "s-nowrap", title: fmt.when(e.at) }, fmt.ago(e.at)) },
      { label: "Level", render: (e) => { const l = LEVELS[levelOf(e)]; return el("span", { class: "s-nowrap" }, ui.dot(l[0], l[1]), " ", l[1]); } },
      { label: "Kind", render: (e) => ui.badge(kindLabel(kindOf(e))) },
      { label: "Login", render: loginCell },
      { label: "Game", hide: "sm", render: gameCell },
      { label: "Message", wrap: true, render: (e) => e.msg || "" }] });
    return el("div", { class: "s-stack" },
      el("div", { class: "s-toolbar", style: { marginBottom: "0" } }, v.level, v.kind, v.login, v.search, el("span", { class: "s-grow" }), v.count, v.more),
      v.error, v.table);
  }

  // Not in §4.6, but harmless: Chzzk.go("activity", { accountId }) opens one login's log.
  Chzzk.on("tab", ({ id, params }) => {
    const a = id === "activity" && v.table && params && params.accountId ? String(params.accountId) : "";
    if (!a || a === f.accountId) return;
    f.level = "all"; f.kind = "*"; f.q = "";
    v.search.set("");
    setLogin(a);
  });

  Chzzk.registerTab({
    id: "activity", label: "Activity",
    render(root) {
      root.append(build());
      syncLogins();
      load();
    },
    // Runs on every 5 s state poll while visible: repaint names and times, re-read the log every 15 s.
    update() {
      syncLogins();
      draw();
      if (!loading && Date.now() - loadedAt >= LOG_MS) load();
    },
    badge() { return null; },     // the Overview carries the alerts
  });
})();
