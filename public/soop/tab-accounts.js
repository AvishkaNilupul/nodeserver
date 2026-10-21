/* SOOP farm — Accounts tab: the account table, its filters and bulk actions. The
   per-account drawer (account-drawer.js) and the import dialog (account-import.js)
   are separate files, loaded by this one at start-up and reached through
   Soop._accountDrawer.open(id) and Soop._accountImport.open(). */
(function () {
  "use strict";
  const { el, ui, fmt } = Soop;

  const DEAD = "not_logged_in", REJECTED = "drops_rejected", STALE_MS = 3 * 864e5;
  const STATUS = { ok: ["ok", "Ready"], not_logged_in: ["error", "Logged out — re-import its cookie"],
    drops_rejected: ["error", "Refused by the drops site — re-import its cookie"], untested: [null, "Not checked yet"] };
  const lost = (a) => a.status === DEAD || a.status === REJECTED;      // cannot farm until its cookie is re-imported
  const SESSION = { starting: ["info", "Joining"], waiting: [null, "Waiting"], sleeping: [null, "Sleeping"], backoff: ["warn", "Not earning"], stopping: [null, "Stopping"], error: ["error", "Error"] };
  const FROM_LINK = { ok: "ok", dead: "dead", sold: "sold", idle: "idle" };      // Soop.go("accounts", { status })
  const plural = (n, word) => fmt.num(n) + " " + word + (n === 1 ? "" : "s");
  const statusOf = (a) => (a.sold ? [null, "Handed over"] : STATUS[a.status] || [null, "Not checked yet"]);
  const sessionOf = (s) => (s.state === "farming" ? (s.credited === true ? ["ok", "Earning"] : ["info", "Watching"]) : SESSION[s.state] || [null, "Working"]);
  function bucket(a) {                           // which activity chip an account belongs to
    if (a.sold) return "sold";
    if (a.session) return a.session.state === "farming" ? "earning" : "waiting";
    return lost(a) ? "dead" : "idle";
  }
  function idleSentence(a) {
    if (a.sold) return "Handed over — it is not farmed";
    if (lost(a)) return "Cannot farm until its cookie is re-imported";
    const bot = a.botId ? Soop.botById(a.botId) : null;
    if (!bot) return "Idle — not in a bot";
    if (bot.state === "stopped") return "Idle — its bot is stopped";
    if (bot.state === "finished") return "Idle — its bot has finished";
    return "Idle — its bot has nothing for it to farm right now";
  }

  let filter = "all", query = "", chips, search, table, bulk, emptyBox, emptyMode = "", chipSig = "";

  // ---- the drawer and the import dialog (separate files, each loaded once) -----
  const PARTS = { _accountDrawer: ["/soop/account-drawer.js", "The account panel"], _accountImport: ["/soop/account-import.js", "The import dialog"], _twitchLogins: ["/soop/twitch-logins.js", "The Twitch-logins dialog"] };
  const loading = {};
  function part(key) {                           // resolves with Soop[key] once its file has run
    if (!loading[key]) loading[key] = new Promise((resolve, reject) => {
      if (Soop[key]) { resolve(Soop[key]); return; }
      document.head.appendChild(el("script", { src: PARTS[key][0], onLoad: () => resolve(Soop[key]),
        onError: () => { loading[key] = null; reject(new Error(PARTS[key][1] + " could not be loaded — check the connection and try again")); } }));
    });
    return loading[key];
  }
  function openDrawer(id) {
    return part("_accountDrawer").then((drawer) => {
      if (!Soop.accountById(id)) throw new Error("There is no account called " + id + " — it may have been deleted");
      drawer.open(id);
    }).catch(Soop.toast);
  }
  const openImport = () => part("_accountImport").then((dialog) => dialog.open()).catch(Soop.toast);
  const openTwitchLogins = () => part("_twitchLogins").then((dialog) => dialog.open()).catch(Soop.toast);
  // Loaded up front: the drawer so a row opens at once, the dialog because it also takes files dropped on the page.
  Object.keys(PARTS).forEach((key) => part(key).catch(() => {}));

  // ---- rows and columns -------------------------------------------------------
  function rows() {
    const q = query.toLowerCase();
    return Soop.state.accounts.filter((a) => {
      if (filter === "ok" ? a.sold || lost(a) : filter !== "all" && bucket(a) !== filter) return false;
      if (!q) return true;
      const bot = a.botId ? Soop.botById(a.botId) : null;
      return [a.id, a.nick, a.country, a.note, bot && bot.name].join(" ").toLowerCase().includes(q);
    });
  }
  const columns = [
    { label: "Account", render: (a) => [el("b", a.id), el("span", { class: "s-muted s-small s-trunc", style: { display: "block", maxWidth: "160px" }, title: a.note ? "Note: " + a.note : null }, (a.nick || "No nickname") + (a.note ? " · " + a.note : ""))] },
    { label: "Status", render: (a) => {          // "Logged out — re-import its cookie" goes on two lines so one bad row does not widen the column
      const s = statusOf(a), parts = s[1].split(" — ");
      return el("span", { class: s[0] === "error" ? "s-error" : null, title: (!a.sold && a.lastError) || null }, ui.dot(s[0], s[1]), " " + parts[0], parts[1] ? [el("br"), el("span", { class: "s-small" }, "Re-import its cookie")] : null);
    } },
    { label: "Country", hide: "sm", render: (a) => a.country || el("span", { class: "s-muted" }, "Unknown") },
    { label: "Bot", hide: "sm", render: (a) => {
      const bot = a.botId ? Soop.botById(a.botId) : null;
      return bot ? el("a", { class: "s-link", href: "#bots?id=" + encodeURIComponent(bot.id), title: "Show this bot" }, bot.name || "Bot") : el("span", { class: "s-muted" }, "None");
    } },
    { label: "Doing now", wrap: true, render: (a) => {
      if (!a.session) return el("span", { class: "s-muted" }, idleSentence(a));
      const s = sessionOf(a.session), detail = a.session.detail || a.session.title || "";
      return el("span", { title: s[1] + (detail ? " — " + detail : "") }, ui.dot(s[0], s[1]), " ", el("b", s[1]), detail ? " — " + detail : "");
    } },
    { label: "Minutes of goal", width: "150px", render: (a) => {
      const s = a.session;
      if (!s || !(s.goal > 0)) return el("span", { class: "s-muted" }, "–");
      return el("div", { class: "s-stack is-tight" }, el("span", { class: "s-num s-small" }, fmt.mins(s.minutes) + " of " + fmt.mins(s.goal)), ui.progress(s.minutes, s.goal));
    } },
    { label: "Cookie age", render: (a) => {
      const old = !a.sold && a.cookieAt && Date.parse(Soop.state.now) - Date.parse(a.cookieAt) > STALE_MS;
      if (!old) return el("span", { title: fmt.when(a.cookieAt) }, fmt.ago(a.cookieAt).replace(" ago", ""));
      return el("span", { class: "s-warn", title: "Imported " + fmt.when(a.cookieAt) + ". SOOP logins have died within about 2 days — re-import this cookie soon." },
        ui.icon("alert", 14), " " + fmt.ago(a.cookieAt).replace(" ago", "") + " — old");
    } },
    { label: "Last check", hide: "sm", render: (a) => el("span", { class: "s-muted", title: fmt.when(a.lastCheckedAt) }, a.lastCheckedAt ? fmt.ago(a.lastCheckedAt) : "Never") },
  ];

  // ---- bulk actions -----------------------------------------------------------
  const picked = () => table.selected();
  function bulkCheck() {
    const ids = picked();
    if (!ids.length) return null;                // an empty list would mean "every account"
    return Soop.api.post("/accounts/check", { ids }).then((j) => {
      Soop.toast("Re-checking " + plural(j.total, "account") + " — each status updates as its check finishes", "ok");
      return Soop.refresh();
    });
  }
  // "Sold" here means the SOOP account itself left us; selling its codes never needs it.
  async function bulkSold(sold) {
    const ids = picked().filter((id) => { const a = Soop.accountById(id); return a && a.sold !== sold; });
    if (sold && ids.length && !(await Soop.confirm({ title: "Mark " + plural(ids.length, "account") + " as handed over?", danger: true, okLabel: "Mark handed over",
      body: "Only for when someone else now owns this SOOP account. Selling its codes never needs this: a login whose codes were sold keeps farming, and its new codes go into new bundles. Handed over, it stops farming and its codes stay out of bundles." }))) return;
    let failed = 0, why = "";
    for (const id of ids) {
      try { await Soop.api.post("/accounts/update", { id, sold }); } catch (e) { failed++; why = e.message; }
    }
    await Soop.refresh();
    const done = ids.length - failed;
    if (done) Soop.toast("Marked " + plural(done, "account") + (sold ? " as handed over — they are no longer farmed" : " as ours again — they farm again"), "ok");
    if (failed) throw new Error(plural(failed, "account") + " could not be changed: " + why);
  }
  async function bulkDelete() {
    const ids = picked();
    if (!ids.length) return;
    const names = ids.slice(0, 5).join(", ") + (ids.length > 5 ? " and " + (ids.length - 5) + " more" : "");
    const yes = await Soop.confirm({ title: "Delete " + plural(ids.length, "account") + "?", danger: true, okLabel: "Delete " + plural(ids.length, "account"),
      body: "This removes " + names + " from the farm: " + (ids.length === 1 ? "it stops farming, leaves its bot, and its" : "they stop farming, leave their bots, and their")
        + " stored cookie and inventory records are forgotten. Nothing changes on SOOP itself. To bring one back, import its cookie again." });
    if (!yes) return;
    const j = await Soop.api.post("/accounts/delete", { ids });
    table.clearSelection();
    Soop.toast("Deleted " + plural(j.deleted, "account"), "ok");
    await Soop.refresh();
  }
  function buildBulk() {
    const count = el("b"), sell = ui.button("Mark handed over", { size: "sm", icon: "check", onClick: () => bulkSold(true) }), unsell = ui.button("Mark ours again", { size: "sm", onClick: () => bulkSold(false) });
    const bar = el("div", { class: "s-note s-row", style: { alignItems: "center" }, hidden: true, role: "region", "aria-label": "Actions for the selected accounts" }, count,
      ui.button("Re-check", { size: "sm", icon: "refresh", onClick: bulkCheck }), sell, unsell,
      ui.button("Delete", { size: "sm", tone: "danger", icon: "trash", onClick: bulkDelete }),
      ui.button("Clear selection", { size: "sm", tone: "ghost", onClick: () => table.clearSelection() }));
    bar.sync = () => {
      const list = picked().map(Soop.accountById).filter(Boolean);
      bar.hidden = !list.length;
      count.textContent = plural(list.length, "account") + " selected";
      sell.hidden = !list.some((a) => !a.sold);
      unsell.hidden = !list.some((a) => a.sold);
    };
    return bar;
  }

  // ---- the tab ----------------------------------------------------------------
  function redraw() {
    const all = Soop.state.accounts, mode = all.length ? "match" : "none";
    if (mode !== emptyMode) {
      emptyMode = mode; emptyBox.textContent = "";
      emptyBox.append(mode === "none" ? ui.empty("No accounts yet", "Import a Cookie-Editor export to add your first account.", { label: "Import accounts", tone: "primary", icon: "upload", onClick: openImport })
        : ui.empty("No accounts match", "Clear the search or pick another filter.", { label: "Show all accounts", onClick: () => { query = ""; search.set(""); setFilter("all"); } }));
    }
    table.update(rows());
    bulk.sync();
  }
  function drawChips() {
    const n = { all: 0, earning: 0, waiting: 0, idle: 0, dead: 0, sold: 0, ok: 0 };
    Soop.state.accounts.forEach((a) => { n.all++; n[bucket(a)]++; if (!a.sold && !lost(a)) n.ok++; });
    const sig = filter + JSON.stringify(n);
    if (sig === chipSig) return;
    chipSig = sig;
    chips.setOptions([{ value: "all", label: "All", count: n.all }, { value: "earning", label: "Earning", count: n.earning }, { value: "waiting", label: "Waiting", count: n.waiting },
      { value: "idle", label: "Idle", count: n.idle }, { value: "dead", label: "Logged out", count: n.dead }, { value: "sold", label: "Handed over", count: n.sold },
      filter === "ok" ? { value: "ok", label: "Logged in", count: n.ok } : null].filter(Boolean));   // "Logged in" only arrives through a link from another tab
  }
  function setFilter(v) { filter = v; chips.set(v); drawChips(); redraw(); }

  Soop.registerTab({
    id: "accounts", label: "Accounts",
    render(root) {
      search = ui.search({ placeholder: "Search accounts", onInput: (q) => { query = q; redraw(); } });
      chips = ui.chips({ options: [], value: filter, onChange: (v) => { filter = v; drawChips(); redraw(); } });
      bulk = buildBulk();
      emptyBox = el("div");
      table = ui.table({ key: "id", select: true, columns, rows: [], empty: emptyBox, onRow: (a) => openDrawer(a.id), onSelect: () => bulk.sync() });
      root.append(el("div", { class: "s-toolbar" }, search, chips, el("span", { class: "s-grow" }),
        ui.button("Twitch logins", { icon: "refresh", title: "Import the Twitch cookies that renew SOOP logins automatically", onClick: openTwitchLogins }),
        ui.button("Import accounts", { tone: "primary", icon: "upload", onClick: openImport })),
        el("div", { class: "s-stack" }, bulk, table));
    },
    update() { drawChips(); redraw(); },
    badge() { const t = Soop.state.totals, n = (t.dead || 0) + (t.rejected || 0); return n ? { text: n, tone: "error" } : null; },
  });

  Soop.on("tab", ({ id, params }) => {
    if (id !== "accounts") return;
    if (params.status) setFilter(FROM_LINK[params.status] || "all");
    if (params.import) openImport();
    if (params.twitch) openTwitchLogins();
    if (params.id) openDrawer(params.id);
  });
})();
