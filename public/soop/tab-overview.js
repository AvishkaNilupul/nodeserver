/* SOOP farm — Overview tab (contract §13, U2). The first screen: is it earning,
   and is anything wrong? Built once in render(); update() only mutates, because
   it runs every 3 s and must never drop hover, focus or scroll. */
(function () {
  "use strict";
  const { el, ui, fmt } = Soop;
  const UPCOMING = 4;
  const LEVELS = { error: { tone: "error", word: "Problem" }, warn: { tone: "warn", word: "Warning" }, info: { tone: "info", word: "Note" } };

  // ---------- small mutation helpers ---------------------------------------
  const memo = new WeakMap();
  /** Run `fn` only when `sig` differs from the last one seen for `node`. */
  function once(node, sig, fn) { if (memo.get(node) !== sig) { memo.set(node, sig); fn(); } }
  function text(node, value) { value = value == null ? "" : String(value); if (node.textContent !== value) node.textContent = value; }
  function show(node, yes) { if (node.hidden === !!yes) node.hidden = !yes; }
  function stat(node, value, hint, tone) { once(node, [value, hint, tone].join("|"), () => node.set(value, hint, tone)); }
  function plural(n, one, many) { return fmt.num(n) + " " + (n === 1 ? one : many || one + "s"); }
  /** A slot holding one status dot, swapped only when its tone or label changes. */
  function dotSlot() {
    const box = el("span");
    box.set = (tone, label) => once(box, tone + "|" + label, () => { while (box.firstChild) box.removeChild(box.firstChild); box.append(ui.dot(tone, label)); });
    return box;
  }
  /** Keyed list: reuse one view per key, create the new ones, forget the gone. */
  function keyed(map, items, keyOf, make) {
    const seen = new Set(), nodes = [];
    items.forEach((item) => {
      const k = String(keyOf(item));
      if (seen.has(k)) return;
      seen.add(k);
      let view = map.get(k);
      if (!view) map.set(k, (view = make(item)));
      view.patch(item);
      nodes.push(view.node);
    });
    map.forEach((v, k) => { if (!seen.has(k)) map.delete(k); });
    return nodes;
  }
  /** Make `parent`'s children exactly `nodes`, moving only what is out of place. */
  function sync(parent, nodes) {
    nodes.forEach((n, i) => { if (parent.children[i] !== n) parent.insertBefore(n, parent.children[i] || null); });
    while (parent.children.length > nodes.length) parent.removeChild(parent.lastElementChild);
  }
  function thumb() {
    const img = el("img", { class: "s-thumb", alt: "", loading: "lazy", hidden: true, onError: () => { img.hidden = true; } });
    img.set = (src) => once(img, src || "", () => { img.hidden = !src; if (src) img.setAttribute("src", /^(https?:|\/)/i.test(src) ? src : "#"); });
    return img;
  }

  // ---------- alerts -------------------------------------------------------
  function rescan() {
    return Soop.refreshCampaigns(true).then(() => Soop.refresh()).then(() => {
      const sc = (Soop.state && Soop.state.scan) || {};
      if (sc.ok === false) Soop.toast(sc.error || "The campaign list could not be refreshed", "error");
      else Soop.toast("Campaign list refreshed", "ok");
    });
  }
  const toSystem = { label: "System details", icon: "info", run: () => Soop.go("activity") };
  const toAccount = { label: "Open account", icon: "user", run: (a) => Soop.go("accounts", a.accountId ? { id: a.accountId } : {}) };
  const FIX = {
    auth: { label: "Re-import cookie", icon: "upload", run: () => Soop.go("accounts", { import: "1" }) },
    "not-crediting": toAccount,
    egress: toSystem, country: toSystem, geo: toSystem,
    scan: { label: "Retry scan", icon: "refresh", run: rescan },
    expiring: { label: "Open inventory", icon: "gift", run: () => Soop.go("inventory") },
  };
  function alertView(first) {
    let cur = first;
    const fix = FIX[first.kind] || (first.accountId ? toAccount : toSystem);
    const dot = dotSlot(), msg = el("span"), at = el("span", { class: "s-muted s-small" });
    // s-spread wraps: on a phone the message keeps the full width and the button drops below it.
    const node = el("li", { class: "s-list-item" }, dot, el("div", { class: "s-grow s-spread" },
      el("div", { class: "s-stack is-tight" }, msg, at),
      ui.button(fix.label, { size: "sm", icon: fix.icon, onClick: () => fix.run(cur) })));
    return { node, patch(a) {
      cur = a;
      const lv = LEVELS[a.level] || LEVELS.info, ago = fmt.ago(a.at);
      dot.set(lv.tone, lv.word);
      text(msg, a.msg);
      text(at, ago === "just now" || ago === "–" ? "" : "Since " + ago);
      show(at, at.textContent);
    } };
  }

  // ---------- live and upcoming campaigns ----------------------------------
  /** Active bots that would farm this campaign (same rule as the server's `botIds`, but never 60 s stale). */
  function botsFor(c, bots) {
    return bots.filter((b) => b.active && (b.mode === "campaign" ? String(b.dropsIdx) === String(c.dropsIdx)
      : c.guaranteed && (b.mode === "auto" || String(b.gameNo) === String(c.gameNo))));
  }
  function stepNodes(c) {
    const by = new Map();
    (c.items || []).forEach((i) => { if (i.minutes > 0) by.set(i.minutes, (by.get(i.minutes) || []).concat(i.name || "Reward")); });
    if (!by.size) (c.steps || []).forEach((m) => by.set(m, []));
    const mins = Array.from(by.keys()).sort((a, b) => a - b), named = mins.length <= 4;
    return mins.map((m) => {
      const names = by.get(m), label = names.length ? names[0] + (names.length > 1 ? " +" + (names.length - 1) : "") : "";
      return el("li", { class: "s-step", title: names.join(", ") || null }, el("b", fmt.mins(m)), named ? label : null);
    });
  }
  function liveView(first) {
    let cur = first;
    const img = thumb(), title = el("b"), sub = el("span", { class: "s-muted s-small" }), steps = el("ol", { class: "s-steps" });
    const bar = ui.progress(0, 0), barText = el("span", { class: "s-muted s-small s-num s-nowrap" });
    const barRow = el("div", { class: "s-row" }, el("span", { class: "s-grow" }, bar), barText);
    const dot = dotSlot(), status = el("span", { class: "s-grow s-small" });
    const start = ui.button("Start bot", { tone: "primary", size: "sm", icon: "play", title: "Create a bot for this campaign",
      onClick: () => Soop.go("bots", { create: "campaign", dropsIdx: cur.dropsIdx }) });
    const view = ui.button("View bot", { size: "sm", icon: "bot", onClick: () => {
      const b = botsFor(cur, Soop.state.bots || [])[0];
      Soop.go("bots", b ? { id: b.id } : {});
    } });
    const node = el("section", { class: "s-card" },
      el("div", { class: "s-card-hd" }, img, el("div", { class: "s-grow s-stack is-tight" }, title, sub)),
      el("div", { class: "s-card-bd s-stack" }, steps, barRow),
      el("div", { class: "s-card-ft" }, dot, status, start, view));
    return { node, patch(c) {
      cur = c;
      const s = Soop.state, bots = botsFor(c, s.bots || []);
      const mine = (s.accounts || []).filter((a) => a.session && String(a.session.dropsIdx) === String(c.dropsIdx));
      const earning = mine.filter((a) => a.session.state === "farming" && a.session.credited === true).length;
      let sum = 0, goal = 0;
      mine.forEach((a) => { const g = Number(a.session.goal) || 0; goal += g; sum += Math.min(Number(a.session.minutes) || 0, g); });
      img.set(c.image);
      text(title, c.title || "Campaign " + c.dropsIdx);
      once(title, "t" + (c.titleRaw || ""), () => { if (c.titleRaw && c.titleRaw !== c.title) title.title = c.titleRaw; });
      text(sub, (c.gameName || Soop.gameName(c.gameNo)) + (c.endAt ? " · ends " + fmt.until(c.endAt) : ""));
      once(steps, (c.items || []).map((i) => i.minutes + ":" + i.name).join("|") + "#" + (c.steps || []).join(","), () => sync(steps, stepNodes(c)));
      show(steps, steps.children.length);
      show(barRow, goal > 0);
      if (goal > 0) { once(bar, sum + "/" + goal, () => bar.set(sum, goal)); text(barText, fmt.mins(sum) + " of " + fmt.mins(goal)); }
      if (earning) dot.set("ok", "Earning"); else if (mine.length) dot.set("warn", "Not earning yet"); else dot.set(null, "Nobody on it");
      text(status, mine.length ? plural(mine.length, "account") + " on it, " + (earning === mine.length ? (earning === 1 ? "earning" : "all earning") : fmt.num(earning) + " earning")
        : bots.length ? "A bot covers it, but no account has joined yet" : "None of our accounts is on it");
      once(node, bots.length ? "is-ok" : "is-warn", () => { node.className = "s-card " + (bots.length ? "is-ok" : "is-warn"); });
      show(start, !bots.length);
      show(view, bots.length);
      once(view, bots.map((b) => b.name).join(", "), () => { view.title = bots.length ? "Covered by " + bots.map((b) => b.name).join(", ") : ""; });
    } };
  }
  function upcomingView() {
    const img = thumb(), title = el("b"), sub = el("span", { class: "s-muted s-small" });
    const node = el("li", { class: "s-list-item" }, img, el("div", { class: "s-grow s-stack is-tight" }, title, sub));
    return { node, patch(c) {
      img.set(c.image);
      text(title, c.title || "Campaign " + c.dropsIdx);
      text(sub, (c.gameName || Soop.gameName(c.gameNo)) + " · starts " + fmt.when(c.startAt) + " (" + fmt.until(c.startAt) + ")");
    } };
  }

  // ---------- the tab ------------------------------------------------------
  const alertViews = new Map(), liveViews = new Map(), upViews = new Map();
  let first, strip, main, st, alertCard, alertCount, alertList, allClear, liveCount, liveGrid, liveEmpty, liveHint, upCard, upList, res;

  function meter(label) {
    const value = el("span", { class: "s-num s-small" }), bar = ui.progress(0, 0, "info");
    return { node: el("div", { class: "s-stack is-tight" }, el("div", { class: "s-spread s-small" }, el("span", { class: "s-muted" }, label), value), bar), value, bar };
  }

  function render(root) {
    first = ui.empty("No accounts yet", "Import your SOOP account cookies and the farm can start earning drops.",
      { label: "Import accounts", tone: "primary", icon: "upload", onClick: () => Soop.go("accounts", { import: "1" }) });
    st = { earning: ui.stat("Earning now", "–"), waiting: ui.stat("Sleeping", "–"), dead: ui.stat("Logged out", "–"),
      bots: ui.stat("Active bots", "–"), egress: ui.stat("SOOP sees us in", "–"), scan: ui.stat("Campaign list", "–") };

    alertCount = ui.badge("0");
    alertList = el("ul", { class: "s-list" });
    alertCard = el("section", { class: "s-card" },
      el("div", { class: "s-card-hd" }, el("h2", { class: "s-card-title s-grow" }, "Needs attention"), alertCount), alertList);
    allClear = el("div", { class: "s-note is-ok" }, ui.icon("check"), el("span", "No alerts. Nothing needs your attention right now."));

    liveCount = el("span", { class: "s-muted s-small" });
    liveGrid = el("div", { class: "s-grid" });
    liveHint = el("span");
    liveEmpty = el("div", { class: "s-note" }, ui.icon("clock"), liveHint);
    upList = el("ul", { class: "s-list" });
    upCard = el("section", { class: "s-card" },
      el("div", { class: "s-card-hd" }, el("h2", { class: "s-card-title s-grow" }, "Coming up"),
        ui.button("All campaigns", { tone: "ghost", size: "sm", onClick: () => Soop.go("campaigns") })), upList);

    res = { mem: meter("Server process memory"), cpu: meter("Server process CPU"), line: el("span", { class: "s-muted s-small" }) };
    const resCard = el("section", { class: "s-card" },
      el("div", { class: "s-card-hd" }, el("h2", { class: "s-card-title s-grow" }, "Resources"),
        ui.button("Details", { tone: "ghost", size: "sm", onClick: () => Soop.go("activity") })),
      el("div", { class: "s-card-bd s-stack" }, res.mem.node, res.cpu.node, res.line));

    strip = el("div", { class: "s-stats" }, st.earning, st.waiting, st.dead, st.bots, st.egress, st.scan);
    main = el("div", { class: "s-grid-2" },
      el("div", { class: "s-stack" },
        el("div", { class: "s-spread" }, el("h2", { class: "s-card-title" }, "Live now"), liveCount), liveEmpty, liveGrid, upCard),
      resCard);
    root.append(el("div", { class: "s-stack" }, first, strip, allClear, alertCard, main));
  }

  function update() {
    const s = Soop.state, t = s.totals || {}, eg = s.egress || {}, sc = s.scan || {}, alerts = s.alerts || [], accounts = s.accounts || [];
    const none = !t.accounts;
    show(first, none);
    show(strip, !none);
    show(main, !none);

    // 1. status strip
    const farming = accounts.filter((a) => a.session && a.session.state === "farming");
    const unsure = farming.filter((a) => a.session.credited !== true).length, usable = t.ok || 0;
    stat(st.earning, fmt.num(farming.length - unsure), "of " + plural(usable, "usable account") + (unsure ? ", " + fmt.num(unsure) + " not confirmed yet" : ""), farming.length - unsure ? "ok" : null);
    stat(st.waiting, fmt.num((t.sleeping || 0) + (t.waiting || 0)), t.idle ? plural(t.idle, "account") + " not in any bot" : (t.sleeping ? "Asleep until there is something to farm" : "Every usable account is in a bot"), null);
    stat(st.dead, fmt.num(t.dead || 0), t.dead ? "Re-import the cookie" : "All signed in", t.dead ? "error" : null);
    stat(st.bots, fmt.num(t.botsActive || 0), "of " + plural(t.bots || 0, "bot"), null);
    if (eg.proxied && !eg.ready) stat(st.egress, "Proxy down", "Nothing reaches SOOP", "error");
    else if (!eg.country) stat(st.egress, "Unknown", "Country not checked yet", "warn");
    else stat(st.egress, eg.country, eg.credited === "yes" ? "Watch time is credited here" : eg.credited === "no" ? "Watch time is NOT credited here" : "Not confirmed to be credited",
      eg.credited === "yes" ? "ok" : eg.credited === "no" ? "error" : "warn");
    stat(st.scan, sc.at ? fmt.ago(sc.at) : "Never", sc.ok === false ? "Last refresh failed" : plural(sc.count != null ? sc.count : Soop.campaigns.length, "campaign"), sc.ok === false ? "warn" : null);

    // 2. alerts, worst first (the server already sorts them; keep it stable here)
    const rank = { error: 0, warn: 1, info: 2 };
    const sorted = alerts.slice().sort((a, b) => (rank[a.level] == null ? 3 : rank[a.level]) - (rank[b.level] == null ? 3 : rank[b.level]));
    sync(alertList, keyed(alertViews, sorted, (a) => a.id || a.kind + ":" + a.msg, alertView));
    const errs = alerts.filter((a) => a.level === "error").length, worst = errs ? "error" : alerts.some((a) => a.level === "warn") ? "warn" : "";
    show(alertCard, alerts.length);
    show(allClear, !alerts.length && !none);
    text(alertCount, alerts.length);
    once(alertCard, worst, () => { alertCard.className = "s-card" + (worst ? " is-" + worst : ""); alertCount.className = "s-badge" + (worst ? " is-" + worst : ""); });
    if (none) return;

    // 3. live now + coming up
    const now = new Date(s.now || Date.now()).getTime(), at = (v) => (v ? new Date(v).getTime() : NaN);
    const guaranteed = Soop.campaigns.filter((c) => c.guaranteed);
    const live = guaranteed.filter((c) => c.live).sort((a, b) => (at(a.endAt) || Infinity) - (at(b.endAt) || Infinity));
    const soon = guaranteed.filter((c) => !c.live && at(c.startAt) > now).sort((a, b) => at(a.startAt) - at(b.startAt));
    sync(liveGrid, keyed(liveViews, live, (c) => c.dropsIdx, liveView));
    sync(upList, keyed(upViews, soon.slice(0, UPCOMING), (c) => c.dropsIdx, upcomingView));
    const open = live.filter((c) => !botsFor(c, s.bots || []).length).length;
    text(liveCount, live.length ? plural(live.length, "guaranteed campaign") + (open ? ", " + fmt.num(open) + " without a bot" : ", all covered") : "");
    show(liveGrid, live.length);
    show(liveEmpty, !live.length);
    text(liveHint, !Soop.campaigns.length ? (sc.ok === false ? "The campaign list could not be loaded, so there is nothing to show yet." : "No campaigns have been found yet.")
      : "No guaranteed campaign is live right now." + (soon.length ? " The next one starts " + fmt.until(soon[0].startAt) + "." : ""));
    show(upCard, soon.length);

    // 4. resources
    // The bar is this process's share of the server's memory: "free" memory reads near zero on a healthy server (the OS uses it as cache).
    const m = s.metrics || {}, total = Number(m.totalMemMB) || 0, rss = Number(m.rssMB) || 0, cpu = Number(m.cpuPct) || 0;
    text(res.mem.value, m.rssMB == null ? "–" : fmt.num(Math.round(rss)) + " MB" + (total ? " of " + (total / 1024).toFixed(1) + " GB" : ""));
    const memTone = total && rss / total >= 0.5 ? "error" : total && rss / total >= 0.25 ? "warn" : "info", cpuTone = cpu >= 90 ? "error" : cpu >= 70 ? "warn" : "info";
    once(res.mem.bar, rss + "/" + total, () => res.mem.bar.set(rss, total, memTone));
    text(res.cpu.value, m.cpuPct == null ? "–" : Math.round(cpu) + "%");
    once(res.cpu.bar, String(cpu), () => res.cpu.bar.set(Math.min(cpu, 100), 100, cpuTone));
    text(res.line, plural(Number(m.sockets) || 0, "open connection") + " to SOOP");
  }

  function badge() {
    const alerts = (Soop.state && Soop.state.alerts) || [];
    const errs = alerts.filter((a) => a.level === "error").length, warns = alerts.filter((a) => a.level === "warn").length;
    return errs ? { text: errs, tone: "error" } : warns ? { text: warns, tone: "warn" } : null;
  }

  Soop.registerTab({ id: "overview", label: "Overview", render, update, badge });
})();
