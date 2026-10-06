/* SOOP farm v2 — Inventory tab (contract §13, §14): the stock room. What every
   account has earned, what is about to expire and which accounts hold it.
   The summary is not part of /state: it is loaded on first render, when a sync
   finishes, on a manual refresh and when the tab is re-shown after a minute —
   never on the 3 s poll. A revealed code exists only as text inside its drawer
   and is wiped when the drawer closes; it is never stored and never logged. */
(function () {
  "use strict";
  const { el, ui, fmt } = Soop;
  const SOON_MS = 72 * 3600 * 1000, STALE_MS = 60 * 1000;
  const DIV = {
    available: { label: "Available", tone: "ok" },
    acquired: { label: "Claimed", tone: "info" },
    expired: { label: "Expired", tone: null },
  };
  const KINDS = { code: "Code", link: "Link or form", ingame: "In-game item", other: "Other reward" };

  let summary = null, loadError = "", loading = null, loadedAt = 0, seenLastAt = null, wasRunning = false;
  let query = "", division = "all", kind = "all", drawer = null;
  const open = new Set();             // item rows whose account list is expanded
  let stats, syncLine, syncBar, syncBtn, failBox, search, divChips, kindChips, listBox;

  // ---------- small helpers --------------------------------------------------
  function fill(node, ...kids) {
    node.textContent = "";
    kids.flat(3).forEach((k) => { if (k != null && k !== false) node.append(k); });
    return node;
  }
  const plural = (n, one) => fmt.num(n) + " " + one + (Number(n) === 1 ? "" : "s");
  const nowMs = () => Date.parse(Soop.state.now) || Date.now();
  function who(id) {
    const a = Soop.accountById(id);
    return a && a.nick && a.nick !== String(id) ? a.nick + " (" + id + ")" : String(id);
  }
  // A renamed game shows its new name at once; otherwise the name stored at sync time.
  function gameLabel(g) {
    const n = Soop.gameName(g.gameNo);
    return g.gameName && (n === "Other" || /^Game #/.test(n)) ? g.gameName : n;
  }
  function thumb(it) {
    if (it.image) return el("img", { class: "s-thumb", src: it.image, alt: "", loading: "lazy" });
    return el("span", { class: "s-thumb s-row s-muted", style: { justifyContent: "center" }, "aria-hidden": "true" }, ui.icon("gift"));
  }
  // Local time plus a relative hint; inside 72 hours it is called out in words and colour.
  function expiry(iso, lead) {
    const t = Date.parse(iso);
    if (!iso || !isFinite(t)) return null;
    if (t < nowMs()) return el("span", { class: "s-small s-muted" }, "Expired " + fmt.when(iso) + " · " + fmt.ago(iso));
    const soon = t - nowMs() <= SOON_MS;
    return el("span", { class: "s-row s-small " + (soon ? "s-warn" : "s-muted") }, soon ? ui.icon("alert", 13) : null,
      (soon ? "Expires soon: " : lead + " ") + fmt.when(iso) + " · " + fmt.until(iso));
  }

  // ---------- loading ----------------------------------------------------------
  function load() {
    if (loading) return loading;
    loading = Soop.api.get("/inventory/summary").then(
      (j) => { summary = j; loadError = ""; },
      (e) => { loadError = (e && e.message) || "Unknown error"; if (summary) Soop.toast("The inventory could not be refreshed: " + loadError, "error"); },
    ).then(() => { loading = null; loadedAt = Date.now(); paint(); });
    return loading;
  }
  function syncAll() {
    return Soop.api.post("/inventory/sync", { ids: [] }).then((j) => {
      if (j.total) Soop.toast("Syncing " + plural(j.total, "account") + ", one at a time", "ok");
      else Soop.toast("There are no accounts to sync — sold accounts are skipped", "warn");
      return Soop.refresh();
    });
  }

  // ---------- painting -----------------------------------------------------------
  function isEmpty() { return !!summary && !(summary.games || []).length; }
  function paint() {
    const t = (summary && summary.totals) || {}, n = (k) => (summary ? fmt.num(t[k] || 0) : "–");
    stats.available.set(n("available"), "waiting in each account's SOOP inventory");
    stats.acquired.set(n("acquired"), "claimed by hand on SOOP");
    stats.expired.set(n("expired"), "ran out before anyone claimed them");
    stats.soon.set(n("expiringSoon"), t.expiringSoon ? "claim these first" : "nothing is about to run out", t.expiringSoon ? "warn" : null);

    const items = [].concat(...((summary && summary.games) || []).map((g) => g.items || []));
    divChips.setOptions([{ value: "all", label: "All", count: (t.available || 0) + (t.acquired || 0) + (t.expired || 0) }]
      .concat(Object.keys(DIV).map((d) => ({ value: d, label: DIV[d].label, count: t[d] || 0 }))));
    const present = Object.keys(KINDS).filter((k) => k === kind || items.some((it) => it.kind === k));
    kindChips.setOptions([{ value: "all", label: "All kinds" }].concat(present.map((k) => ({ value: k, label: KINDS[k], count: items.filter((it) => it.kind === k).length }))));
    kindChips.hidden = present.length < 2;

    const errs = (summary && summary.sync && summary.sync.errors) || [];
    failBox.hidden = !errs.length;
    if (errs.length) fill(failBox, ui.icon("alert"), el("div", { class: "s-stack is-tight s-grow" },
      el("b", plural(errs.length, "account") + " could not be synced last time"),
      el("div", { class: "s-stack is-tight s-scroll" }, errs.map((e) => el("div", { class: "s-small" },
        el("a", { class: "s-link", href: "#accounts?id=" + encodeURIComponent(e.id) }, who(e.id)), " — " + (e.error || "no reason given") + " · " + fmt.ago(e.at)))),
      el("span", { class: "s-small s-muted" }, "Every other account synced normally. Open an account to fix it, then sync again.")));
    drawList();
    paintSync();
  }

  // Runs on every poll: text and a progress bar only, plus the "a sync just finished" check.
  function paintSync() {
    const inv = Soop.state.inventory || {}, running = !!inv.running, at = inv.lastAt || (summary && summary.lastSyncAt);
    syncBtn.disabled = running;
    syncBar.hidden = !running;
    if (running) syncBar.set(inv.done, inv.total);
    syncLine.textContent = running ? "Syncing with SOOP — " + fmt.num(inv.done) + " of " + plural(inv.total, "account") + " done"
      : at ? "Last synced " + fmt.when(at) + " · " + fmt.ago(at) : "Never synced";
    if (running) {
      if (!wasRunning) { wasRunning = true; if (isEmpty()) drawList(); }
    } else if (wasRunning || (inv.lastAt || null) !== seenLastAt) {      // finished here, or while this tab was not on screen
      wasRunning = false; seenLastAt = inv.lastAt || null;
      load();
    }
  }

  function matches(g, it) {
    if (division !== "all" && !it[division]) return false;
    if (kind !== "all" && it.kind !== kind) return false;
    if (!query) return true;
    return (it.name + " " + gameLabel(g) + " " + (it.accountIds || []).map(who).join(" ")).toLowerCase().includes(query.toLowerCase());
  }
  function clearFilters() {
    query = ""; division = "all"; kind = "all";
    search.set(""); divChips.set("all"); kindChips.set("all");
    drawList();
  }
  function drawList() {
    if (!summary) {
      return fill(listBox, loadError
        ? el("section", { class: "s-card" }, ui.empty("The inventory could not be loaded", loadError, { label: "Try again", icon: "refresh", onClick: load }))
        : el("p", { class: "s-muted" }, "Loading the inventory…"));
    }
    if (isEmpty()) {
      const none = !Soop.state.totals.accounts, running = !!(Soop.state.inventory || {}).running;
      return fill(listBox, el("section", { class: "s-card" }, running
        ? ui.empty("Syncing now", "Each account's SOOP inventory is being read, one at a time. What they hold shows up here when it finishes.")
        : none ? ui.empty("Nothing synced yet", "There are no accounts yet. Import one, let it farm, then sync to see what it earned.",
          { label: "Import accounts", tone: "primary", icon: "upload", onClick: () => Soop.go("accounts", { import: "1" }) })
          : ui.empty("Nothing synced yet", "This page is a copy of what each account holds on SOOP. Sync reads every account that is not sold, one at a time, and lists what it earned.",
            { label: "Sync all", tone: "primary", icon: "refresh", onClick: syncAll })));
    }
    const shown = summary.games.map((g) => ({ g, items: (g.items || []).filter((it) => matches(g, it)) })).filter((x) => x.items.length);
    if (!shown.length) {
      return fill(listBox, el("section", { class: "s-card" },
        ui.empty("No items match", "Nothing fits this search and these filters.", { label: "Clear filters", onClick: clearFilters })));
    }
    return fill(listBox, shown.map((x) => el("section", { class: "s-card" },
      el("div", { class: "s-card-hd" }, el("h2", { class: "s-card-title s-grow" }, gameLabel(x.g)),
        el("span", { class: "s-muted s-small" }, plural(x.items.length, "item") + " · " +
          plural(x.items.reduce((n, it) => n + it.available + it.acquired + it.expired, 0), "reward"))),
      el("ul", { class: "s-list" }, x.items.map((it) => itemRows(x.g, it))))));
  }
  // One reward: its row, then a second (hidden) row listing the accounts that hold it.
  function itemRows(g, it) {
    const key = (g.gameNo || "") + "|" + it.name + "|" + it.kind, ids = it.accountIds || [];
    const holders = el("li", { class: "s-list-item", hidden: true });
    const toggle = ui.button(plural(ids.length, "account"), { size: "sm", icon: "chevron", title: "Show the accounts that hold this reward",
      onClick: () => { if (open.has(key)) open.delete(key); else open.add(key); show(); } });
    function show() {
      const on = open.has(key);
      toggle.setAttribute("aria-expanded", String(on));
      holders.hidden = !on;
      if (on && !holders.firstChild) {
        holders.append(el("div", { class: "s-row s-grow s-scroll" }, el("span", { class: "s-muted s-small" }, "Held by"),
          ids.map((id) => ui.button(who(id), { size: "sm", icon: "user", title: "Show this account's inventory", onClick: () => openAccount(id) }))));
      }
    }
    show();
    return [el("li", { class: "s-list-item" }, thumb(it),
      el("div", { class: "s-grow s-stack is-tight" },
        el("b", { class: "s-trunc", title: it.name }, it.name || "Unnamed reward"),
        el("div", { class: "s-row" }, el("span", { class: "s-muted s-small" }, KINDS[it.kind] || KINDS.other),
          Object.keys(DIV).map((d) => (it[d] ? ui.badge(fmt.num(it[d]) + " " + DIV[d].label.toLowerCase(), DIV[d].tone) : null))),
        expiry(it.soonestExpiry, "Soonest expiry") || (it.available ? el("span", { class: "s-small s-muted" }, "No expiry date") : null)),
      toggle), holders];
  }

  // ---------- one account's inventory (drawer) ---------------------------------
  function openAccount(id) {
    id = String(id);
    if (drawer) drawer.close();
    const ctx = { closed: false, codes: [] };       // codes: the nodes showing a revealed code, wiped on close
    const body = el("div", { class: "s-stack" });
    const h = (drawer = Soop.drawer({
      title: who(id), body,
      actions: Soop.accountById(id) ? [{ label: "Open account", icon: "user", onClick: () => Soop.go("accounts", { id }) }] : null,
      onClose: () => {
        ctx.closed = true;
        ctx.codes.forEach((n) => { n.textContent = ""; });
        ctx.codes.length = 0;
        if (drawer === h) drawer = null;
      },
    }));
    (function fetchItems() {
      fill(body, el("p", { class: "s-muted" }, "Loading this account's inventory…"));
      Soop.api.get("/inventory/account?id=" + encodeURIComponent(id)).then(
        (j) => { if (!ctx.closed) fill(body, accountBody(id, j.items || [], ctx)); },
        (e) => { if (!ctx.closed) fill(body, ui.empty("This account's inventory could not be loaded", e.message, { label: "Try again", icon: "refresh", onClick: fetchItems })); });
    })();
  }
  function accountBody(id, items, ctx) {
    const acc = Soop.accountById(id), count = (d) => items.filter((it) => it.division === d).length;
    const synced = items.map((it) => it.syncedAt).filter(Boolean).sort().pop();
    const out = [];
    if (!acc) out.push(el("div", { class: "s-note is-warn" }, ui.icon("alert"), el("span", "This account is no longer on the Accounts tab. What you see is its last synced inventory.")));
    else if (acc.status === "not_logged_in") out.push(el("div", { class: "s-note is-error" }, ui.icon("alert"), el("span", "Logged out — re-import the cookie before this inventory can be synced again.")));
    if (!items.length) {
      out.push(ui.empty("Nothing in this account's inventory", "It has not earned a drop yet, or it has not been synced since it did."));
      return out;
    }
    out.push(el("div", { class: "s-row" }, Object.keys(DIV).map((d) => ui.badge(fmt.num(count(d)) + " " + DIV[d].label.toLowerCase(), count(d) ? DIV[d].tone : null)),
      acc && acc.sold ? ui.badge("Account sold", "warn") : null,
      el("span", { class: "s-muted s-small" }, synced ? "Synced " + fmt.ago(synced) : "")));
    out.push(el("div", { class: "s-note" }, ui.icon("info"), el("span", "Nothing is claimed automatically. Claim is one click per reward, uses this account's stored login, and cannot be undone.")));
    out.push(el("ul", { class: "s-list" }, items.map((it) => accountItem(it, ctx))));
    return out;
  }
  function accountItem(it, ctx) {
    const d = DIV[it.division] || DIV.expired;
    const time = it.division === "acquired"
      ? (it.receivedAt ? el("span", { class: "s-small s-muted" }, "Claimed " + fmt.when(it.receivedAt) + " · " + fmt.ago(it.receivedAt)) : null)
      : expiry(it.expiresAt, "Expires") || el("span", { class: "s-small s-muted" }, "No expiry date");
    const link = it.needsLink
      ? el("span", { class: "s-row s-small s-warn" }, ui.icon("link", 13), "Needs a linked game account before it can be claimed.",
        it.linkPath ? el("a", { class: "s-link", href: it.linkPath, target: "_blank", rel: "noopener noreferrer" }, "Open the link page") : null)
      : el("span", { class: "s-small s-muted" }, it.kind === "ingame" ? "Game account is already linked" : "No linked game account needed");
    return el("li", { class: "s-list-item" }, thumb(it),
      el("div", { class: "s-grow s-stack is-tight" },
        el("b", { title: it.nameRaw && it.nameRaw !== it.name ? "Original: " + it.nameRaw : null }, it.name || "Unnamed reward"),
        el("div", { class: "s-row" }, ui.badge(d.label, d.tone), it.used ? ui.badge("Used") : null,
          el("span", { class: "s-muted s-small" }, (KINDS[it.kind] || KINDS.other) + " · " + gameLabel(it))),
        time, link,
        it.sentAt ? el("span", { class: "s-small s-muted" }, "Earned " + fmt.when(it.sentAt)) : null,
        claimNote(it),
        canClaim(it) ? claimSlot(it, ctx) : it.division === "acquired" && it.kind !== "ingame" ? codeSlot(it, ctx) : null));
  }
  function canClaim(it) {
    return it.division === "available" && !it.needsLink && !(it.expiresAt && new Date(it.expiresAt).getTime() < Date.now());
  }
  // What SOOP said when the reward was claimed (never the code itself).
  function claimNote(it) {
    const c = it.claim;
    if (!c || !c.message) return null;
    return el("div", { class: "s-stack is-tight" },
      el("span", { class: "s-small" + (c.kind === "pending" || c.kind === "renewed" ? " s-warn" : " s-muted") }, c.message),
      c.description ? el("span", { class: "s-small s-muted", style: { whiteSpace: "pre-line" } }, c.description) : null);
  }
  // "Claim": one reward, on SOOP, with the account's stored login. Irreversible, so it always confirms.
  function claimSlot(it, ctx) {
    const slot = el("div", { class: "s-stack is-tight" });
    const btn = ui.button("Claim on SOOP", { size: "sm", tone: "primary", icon: "gift", onClick: () =>
      Soop.confirm({
        title: "Claim this reward?",
        body: "This claims \u201c" + (it.name || "this reward") + "\u201d on SOOP for " + who(it.loginId) + ". It cannot be undone, and it is logged.",
        danger: true, okLabel: "Claim reward",
      }).then((yes) => {
        if (!yes) return null;
        btn.disabled = true;
        return Soop.api.post("/inventory/claim", { itemId: it.id }).then((j) => {
          const r = j.result || {};
          Soop.toast(r.message || "Claimed", r.kind === "pending" || r.kind === "renewed" ? "warn" : "ok");
          load();
          if (ctx.closed) return;
          const row = el("div", { class: "s-row" });
          fill(slot,
            el("span", { class: "s-small" + (r.kind === "pending" || r.kind === "renewed" ? " s-warn" : "") }, r.message || "Claimed"),
            r.description ? el("span", { class: "s-small s-muted", style: { whiteSpace: "pre-line" } }, r.description) : null,
            row);
          if (r.code) showCode(row, codeSlot(it, ctx).firstChild, it, ctx, r.code);
        }, (e) => { btn.disabled = false; Soop.toast(e.message, "error"); });
      }) });
    slot.append(btn);
    return slot;
  }
  // "Reveal code": confirm, ask the server (which logs who asked), show it until hidden or the drawer closes.
  function codeSlot(it, ctx) {
    const slot = el("div", { class: "s-row" });
    const reveal = ui.button("Show code", { size: "sm", icon: "eye", onClick: () =>
      Soop.confirm({ title: "Reveal this code?", body: "This shows the code on screen and is logged.", okLabel: "Reveal code" }).then((yes) => {
        if (!yes) return null;
        return Soop.api.post("/inventory/reveal", { itemId: it.id }).then((j) => {
          if (ctx.closed) return;
          if (j.code) showCode(slot, reveal, it, ctx, j.code);
          else Soop.toast((j.claim && j.claim.message) || "SOOP returned no code for this reward", "warn");
        }, (e) => Soop.toast(e.message, "error"));
      }) });
    slot.append(reveal);
    return slot;
  }
  function showCode(slot, reveal, it, ctx, code) {
    const field = el("span", { class: "s-code", role: "textbox", "aria-readonly": "true", "aria-label": "Code for " + it.name, tabindex: "0" }, code);
    const copy = ui.button("Copy", { size: "sm", icon: "copy", onClick: () => copyFrom(field) });
    const hide = ui.button("Hide", { size: "sm", tone: "ghost", onClick: () => {
      field.textContent = "";
      ctx.codes.splice(ctx.codes.indexOf(field), 1);
      fill(slot, reveal);
      reveal.focus();
    } });
    ctx.codes.push(field);
    fill(slot, field, copy, hide);
    copy.focus();
  }
  function copyFrom(field) {
    const byHand = () => Soop.toast("Could not copy — click the code to select it, then copy it by hand", "warn");
    if (!navigator.clipboard || !navigator.clipboard.writeText) return byHand();
    return navigator.clipboard.writeText(field.textContent).then(() => Soop.toast("Code copied", "ok"), byHand);
  }

  // ---------- registration ---------------------------------------------------------
  Soop.on("tab", ({ id, params }) => {
    if (id !== "inventory") return;
    if (!loading && loadedAt && Date.now() - loadedAt > STALE_MS) load();      // rewards land while the tab is away
    if (params.account) openAccount(params.account);
  });

  Soop.registerTab({
    id: "inventory", label: "Inventory",
    render(root) {
      const inv = Soop.state.inventory || {};
      seenLastAt = inv.lastAt || null; wasRunning = !!inv.running;
      stats = { available: ui.stat("Unclaimed and available", "–"), acquired: ui.stat("Claimed", "–"), expired: ui.stat("Expired", "–"), soon: ui.stat("Expiring within 72 h", "–") };
      syncLine = el("span", { class: "s-small s-muted", role: "status" });
      syncBar = ui.progress(0, 0);
      syncBtn = ui.button("Sync all", { tone: "primary", icon: "refresh", title: "Read every account's SOOP inventory again", onClick: syncAll });
      failBox = el("div", { class: "s-note is-warn", hidden: true });
      search = ui.search({ placeholder: "Search items, games or accounts", onInput: (q) => { query = q; drawList(); } });
      divChips = ui.chips({ options: [], value: division, onChange: (v) => { division = v; drawList(); } });
      kindChips = ui.chips({ options: [], value: kind, onChange: (v) => { kind = v; drawList(); } });
      listBox = el("div", { class: "s-stack" });
      root.append(el("div", { class: "s-stack" },
        el("div", { class: "s-stats" }, stats.available, stats.acquired, stats.expired, stats.soon),
        el("div", { class: "s-small s-muted" },
          "The system never claims drops. They stay unclaimed in each account's SOOP inventory until someone claims them by hand."),
        el("section", { class: "s-card" }, el("div", { class: "s-card-bd s-stack" },
          el("div", { class: "s-spread" },
            el("div", { class: "s-grow s-stack is-tight" }, syncLine, syncBar),
            el("div", { class: "s-row" }, syncBtn,
              ui.button("", { icon: "refresh", tone: "ghost", title: "Reload this list (does not contact SOOP)", onClick: load }),
              el("a", { class: "s-btn", href: "/api/soop/inventory/export.csv", download: "" }, ui.icon("download"), "Export CSV"))),
          failBox)),
        el("div", { class: "s-stack is-tight" }, el("div", { class: "s-toolbar" }, search, divChips, kindChips), listBox)));
      paint();
      load();
    },
    update() { paintSync(); },
    badge() {
      const a = (Soop.state.alerts || []).filter((x) => x.kind === "expiring")[0];
      if (!a) return null;
      const n = /\d+/.exec(a.msg || "");
      return { text: n ? n[0] : "!", tone: "warn" };
    },
  });
})();
