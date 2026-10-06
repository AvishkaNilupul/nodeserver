/* SOOP farm — Accounts tab: the account table, its filters and bulk actions, and
   the import dialog. The per-account drawer lives in account-drawer.js, which
   this file loads at start-up and reaches through Soop._accountDrawer.open(id). */
(function () {
  "use strict";
  const { el, ui, fmt } = Soop;

  /* Paste splitter — pure: pasted text in, one string per account out, in paste
     order. The result is only ever POSTed; it is never shown and never logged.
     Mirrors splitCookieExports in utils/soopClient.js. Cases:
       1. one Cookie-Editor export             [ {..}, {..} ]              -> [that text]
       2. JSON arrays back to back             [..][..]  or  [..],[..]     -> one per array
       3. JSON arrays split by blank lines     [..]\n\n[..]                -> one per array
       4. one "AuthTicket=…" per line                                      -> one per line
          (other name=value lines join the ticket above them, or the first one)
       5. a mix of 2–4; a bracket inside a JSON string or in the middle of a
          cookie-header line never starts an export
       6. nothing recognisable -> [whole text] (the server says why); blank -> [] */
  function splitCookiePaste(text) {
    const t = String(text == null ? "" : text).trim();
    if (!t) return [];
    const TICKET = /(^|[;\s])AuthTicket\s*=/;
    const jsonEnd = (start) => {                 // index just past the JSON value opening at `start`
      let depth = 0, inStr = false;
      for (let i = start; i < t.length; i++) {
        const c = t[i];
        if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; }
        else if (c === '"') inStr = true;
        else if (c === "[" || c === "{") depth++;
        else if ((c === "]" || c === "}") && --depth === 0) return i + 1;
      }
      return t.length;
    };
    const loose = (chunk) => {                   // header lines between JSON exports
      const groups = [], lead = [];
      chunk.split(/\r?\n/).map((s) => s.trim()).forEach((line) => {
        if (TICKET.test(line)) groups.push(lead.splice(0).concat(line));
        else if (line.includes("=")) (groups[groups.length - 1] || lead).push(line);
      });
      return groups.map((g) => g.join("\n"));
    };
    const out = [];
    let from = 0, i = 0, lineStart = 0;
    while (i < t.length) {
      const c = t[i];
      if (c === "\n") lineStart = i + 1;
      if ((c === "[" || c === "{") && /^[\s,]*$/.test(t.slice(Math.max(from, lineStart), i))) {
        const end = jsonEnd(i);
        out.push(...loose(t.slice(from, i)), t.slice(i, end));
        from = i = end;
      } else i++;
    }
    out.push(...loose(t.slice(from)));
    return out.length ? out : [t];
  }

  const DEAD = "not_logged_in", STALE_MS = 3 * 864e5;
  const STATUS = { ok: ["ok", "Ready"], not_logged_in: ["error", "Logged out — re-import its cookie"],
    drops_rejected: ["warn", "Drops site rejected the session"], untested: [null, "Not checked yet"] };
  const SESSION = { starting: ["info", "Joining"], waiting: [null, "Waiting"], backoff: ["warn", "Not earning"], stopping: [null, "Stopping"], error: ["error", "Error"] };
  const FROM_LINK = { ok: "ok", dead: "dead", sold: "sold", idle: "idle" };      // Soop.go("accounts", { status })
  const plural = (n, word) => fmt.num(n) + " " + word + (n === 1 ? "" : "s");
  const statusOf = (a) => (a.sold ? [null, "Sold"] : STATUS[a.status] || [null, "Not checked yet"]);
  const sessionOf = (s) => (s.state === "farming" ? (s.credited === true ? ["ok", "Earning"] : ["info", "Watching"]) : SESSION[s.state] || [null, "Working"]);
  function bucket(a) {                           // which activity chip an account belongs to
    if (a.sold) return "sold";
    if (a.session) return a.session.state === "farming" ? "earning" : "waiting";
    return a.status === DEAD ? "dead" : "idle";
  }
  function idleSentence(a) {
    if (a.sold) return "Sold — it is not farmed";
    if (a.status === DEAD) return "Cannot farm until its cookie is re-imported";
    const bot = a.botId ? Soop.botById(a.botId) : null;
    if (!bot) return "Idle — not in a bot";
    if (bot.state === "stopped") return "Idle — its bot is stopped";
    if (bot.state === "finished") return "Idle — its bot has finished";
    return "Idle — its bot has nothing for it to farm right now";
  }

  let filter = "all", query = "", chips, search, table, bulk, emptyBox, emptyMode = "", chipSig = "";

  // ---- the drawer (separate file, loaded once) --------------------------------
  let drawerReady = null;
  function loadDrawer() {
    if (!drawerReady) drawerReady = new Promise((resolve, reject) => {
      if (Soop._accountDrawer) { resolve(); return; }
      document.head.appendChild(el("script", { src: "/soop/account-drawer.js", onLoad: resolve,
        onError: () => { drawerReady = null; reject(new Error("The account panel could not be loaded — check the connection and try again")); } }));
    });
    return drawerReady;
  }
  function openDrawer(id) {
    return loadDrawer().then(() => {
      if (!Soop.accountById(id)) throw new Error("There is no account called " + id + " — it may have been deleted");
      Soop._accountDrawer.open(id);
    }).catch(Soop.toast);
  }
  loadDrawer().catch(() => {});

  // ---- rows and columns -------------------------------------------------------
  function rows() {
    const q = query.toLowerCase();
    return Soop.state.accounts.filter((a) => {
      if (filter === "ok" ? a.sold || a.status === DEAD : filter !== "all" && bucket(a) !== filter) return false;
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
  async function bulkSold(sold) {
    const ids = picked().filter((id) => { const a = Soop.accountById(id); return a && a.sold !== sold; });
    let failed = 0, why = "";
    for (const id of ids) {
      try { await Soop.api.post("/accounts/update", { id, sold }); } catch (e) { failed++; why = e.message; }
    }
    await Soop.refresh();
    const done = ids.length - failed;
    if (done) Soop.toast("Marked " + plural(done, "account") + (sold ? " as sold — they are no longer farmed" : " as not sold"), "ok");
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
    const count = el("b"), sell = ui.button("Mark sold", { size: "sm", icon: "check", onClick: () => bulkSold(true) }), unsell = ui.button("Mark not sold", { size: "sm", onClick: () => bulkSold(false) });
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

  // ---- import dialog ----------------------------------------------------------
  let importOpen = false;
  function openImport() {
    if (importOpen) return;
    importOpen = true;
    let parts = [], stopped = false, running = false;
    const area = el("textarea", { class: "s-textarea", style: { minHeight: "200px" }, spellcheck: "false", autocomplete: "off", autocapitalize: "off", "data-autofocus": true,
      placeholder: "Paste here", onInput: recount });
    const found = el("span", { class: "s-help", "aria-live": "polite" });
    const go = ui.button("Import", { tone: "primary", icon: "upload", disabled: true, onClick: start });
    const form = el("div", { class: "s-stack" },
      el("div", { class: "s-note" }, ui.icon("info"), el("span", null, "Sign in to sooplive.com, open the Cookie-Editor extension there and press Export, then paste the result below. Repeat for each account — the exports can simply follow one another. Every export must contain the ", el("b", "AuthTicket"), " cookie; one made while signed out is rejected.")),
      el("label", { class: "s-field" }, "Paste one or many Cookie-Editor exports", area, found),
      el("p", { class: "s-muted s-small", style: { margin: "0" } }, "Cookies are stored encrypted and are never shown again. SOOP logins have died within about 2 days, so expect to re-import now and then."));
    const bar = ui.progress(0, 1), status = el("span", { class: "s-small", role: "status" }), list = el("ul", { class: "s-list" }), summary = el("div", { hidden: true });
    const runView = el("div", { class: "s-stack", hidden: true }, el("div", { class: "s-stack is-tight" }, status, bar), summary, el("div", { class: "s-scroll" }, list));
    const m = Soop.modal({ title: "Import accounts", size: "lg", sticky: true, body: el("div", null, form, runView),
      onClose: () => { importOpen = false; stopped = true; area.value = ""; parts = []; } });
    const formActions = () => m.setActions([ui.button("Cancel", { onClick: () => m.close() }), go]);
    function recount() {
      const p = splitCookiePaste(area.value), good = p.filter((x) => x.includes("AuthTicket")).length, bad = p.length - good;
      go.disabled = !good;
      go.lastChild.nodeValue = good ? "Import " + plural(p.length, "account") : "Import";
      found.className = "s-help" + (p.length && bad ? " s-warn" : "");
      found.textContent = !p.length ? "Nothing pasted yet." : !good ? "No account found in this paste yet — an export must contain AuthTicket."
        : plural(p.length, "account") + " detected" + (bad ? " — " + bad + (bad === 1 ? " has" : " have") + " no AuthTicket and will be rejected." : ".");
    }
    function line(n) {
      const li = el("li", { class: "s-list-item" });
      li.set = (tone, label, text, cls) => { li.textContent = ""; li.append(ui.dot(tone, label), el("span", { class: "s-grow" }, el("b", "Export " + n), el("span", { class: cls || "s-muted" }, " — " + text))); };
      li.set(null, "Waiting", "waiting its turn");
      return li;
    }
    function start() {
      if (running) return;
      parts = splitCookiePaste(area.value);
      area.value = "";                           // from here the paste exists only in `parts`, and each part is dropped once sent
      if (!parts.length) { recount(); return; }
      running = true; stopped = false;
      list.textContent = ""; summary.hidden = true;
      form.hidden = true; runView.hidden = false;
      m.setTitle("Importing accounts");
      m.setActions([ui.button("Stop", { icon: "stop", onClick: () => { stopped = true; } })]);
      run();
    }
    async function run() {
      const total = parts.length, lines = parts.map((_, i) => list.appendChild(line(i + 1)));
      let ok = 0, failed = 0, sent = 0;
      for (let i = 0; i < total && !stopped; i++) {
        lines[i].set("info", "Importing", "importing…");
        status.textContent = "Importing " + (i + 1) + " of " + total + "…";
        let res;
        try { res = (await Soop.api.post("/accounts/import", { cookies: parts[i] })).results || []; }
        catch (e) { res = [{ ok: false, error: e.message }]; if (e.status === 401 || e.status === 403) stopped = true; }
        if (parts.length) parts[i] = "";
        if (!res.length) res = [{ ok: false, error: "The server found no account in this export" }];
        res.forEach((r, n) => {
          const li = n ? lines[i].parentNode.insertBefore(line(i + 1), lines[i].nextSibling) : lines[i];
          if (r.ok) { ok++; li.set("ok", "Imported", ["Imported " + r.id, r.nick, r.country ? "seen from " + r.country : null].filter(Boolean).join(" · "), "s-ok"); }
          else { failed++; li.set("error", "Failed", "Failed: " + (r.error || "The server gave no reason"), "s-error"); }
        });
        sent++; bar.set(sent, total);
      }
      parts = []; running = false;
      const left = total - sent, text = (ok ? plural(ok, "account") + " imported" : "No account was imported") + (failed ? ", " + failed + " failed" : "") + (left ? ", " + left + " not sent" : "") + ".";
      Soop.refresh();
      if (!importOpen) { Soop.toast("Import closed early: " + text, ok && !failed ? "ok" : "warn"); return; }
      for (let i = sent; i < total; i++) lines[i].set(null, "Not sent", "not sent — the import was stopped");
      status.textContent = left ? "Stopped." : "Finished.";
      summary.hidden = false; summary.className = "s-note " + (failed || left ? (ok ? "is-warn" : "is-error") : "is-ok");
      summary.textContent = "";
      summary.append(ui.icon(failed || left ? "alert" : "check"), el("span", null, el("b", text), failed ? " Export the failed ones again while signed in to sooplive.com, then paste them here." : ""));
      m.setTitle(left ? "Import stopped" : "Import finished");
      m.setActions([ui.button("Import more", { icon: "plus", onClick: () => { runView.hidden = true; form.hidden = false; m.setTitle("Import accounts"); recount(); formActions(); area.focus(); } }),
        ui.button("Done", { tone: "primary", onClick: () => m.close() })]);
    }
    recount(); formActions();
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
    Soop.state.accounts.forEach((a) => { n.all++; n[bucket(a)]++; if (!a.sold && a.status !== DEAD) n.ok++; });
    const sig = filter + JSON.stringify(n);
    if (sig === chipSig) return;
    chipSig = sig;
    chips.setOptions([{ value: "all", label: "All", count: n.all }, { value: "earning", label: "Earning", count: n.earning }, { value: "waiting", label: "Waiting", count: n.waiting },
      { value: "idle", label: "Idle", count: n.idle }, { value: "dead", label: "Logged out", count: n.dead }, { value: "sold", label: "Sold", count: n.sold },
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
      root.append(el("div", { class: "s-toolbar" }, search, chips, el("span", { class: "s-grow" }), ui.button("Import accounts", { tone: "primary", icon: "upload", onClick: openImport })),
        el("div", { class: "s-stack" }, bulk, table));
    },
    update() { drawChips(); redraw(); },
    badge() { const n = Soop.state.totals.dead; return n ? { text: n, tone: "error" } : null; },
  });

  Soop.on("tab", ({ id, params }) => {
    if (id !== "accounts") return;
    if (params.status) setFilter(FROM_LINK[params.status] || "all");
    if (params.import) openImport();
    if (params.id) openDrawer(params.id);
  });
})();
