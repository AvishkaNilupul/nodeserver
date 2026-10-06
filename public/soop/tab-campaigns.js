/* SOOP farm — Campaigns tab: choose what to farm. Game chips, filters, campaign cards. */
(function () {
  "use strict";
  const { el, ui, fmt } = Soop;

  const STATUS = [["live", "Live"], ["upcoming", "Upcoming"], ["ended", "Ended or unlisted"]];
  const KIND = { code: "Code", link: "Link", ingame: "In-game", other: "Other" };      // reward kind, short enough for a step
  const F = { game: "", status: "live", guaranteed: true, q: "", ko: false };       // the filters
  const cards = new Map();            // dropsIdx -> { node, c, sig, when, cover, coverSig }
  let R = null, seen = null, dirty = true;

  // ---------- Reading a campaign -----------------------------------------------
  const ms = (iso) => Date.parse(iso) || 0;
  const gameKey = (c) => (c.gameNo ? String(c.gameNo) : "~" + (c.gameName || "Other"));
  const gameLabel = (c) => (c.gameNo ? Soop.gameName(c.gameNo) : c.gameName || "Other");
  function statusOf(c) {
    if (c.live) return "live";
    if (c.filter === "completed" || c.filter === "unlisted" || (ms(c.endAt) && ms(c.endAt) < Date.now())) return "ended";
    return "upcoming";                // scheduled, or inside its dates but not broadcasting right now
  }
  // Same rule as the server's `botIds`, but from /state so it is 3 s fresh, not 60 s.
  function botsFor(c) {
    return ((Soop.state && Soop.state.bots) || []).filter((b) => b.active && (b.mode === "campaign"
      ? String(b.dropsIdx) === String(c.dropsIdx)
      : c.guaranteed && (b.mode === "auto" || (b.gameNo != null && String(b.gameNo) === String(c.gameNo)))));
  }
  function pass(c, useGame, useStatus) {
    if (F.guaranteed && !c.guaranteed) return false;
    if (useGame && F.game && gameKey(c) !== F.game) return false;
    if (useStatus && statusOf(c) !== F.status) return false;
    if (!F.q) return true;
    const hay = [c.title, c.titleRaw, c.gameName, gameLabel(c), c.cateName].concat((c.channels || []).map((ch) => ch.nick + " " + ch.id));
    return hay.join(" ").toLowerCase().includes(F.q.toLowerCase());
  }
  const ORDER = {
    live: (a, b) => (ms(a.endAt) || Infinity) - (ms(b.endAt) || Infinity),          // ending soonest first
    upcoming: (a, b) => (ms(a.startAt) || Infinity) - (ms(b.startAt) || Infinity),  // starting soonest first
    ended: (a, b) => ms(b.endAt) - ms(a.endAt),                                     // most recent first
  };
  function whenText(c) {
    const now = Date.now(), s = ms(c.startAt), e = ms(c.endAt);
    const dates = s || e ? fmt.when(c.startAt) + " to " + fmt.when(c.endAt) : "SOOP gave no dates";
    if (c.filter === "unlisted") return dates + " · no longer listed by SOOP";
    if (s > now) return dates + " · starts " + fmt.until(c.startAt);
    if (!e) return dates;
    return dates + (e > now ? " · ends " + fmt.until(c.endAt) : " · ended " + fmt.ago(c.endAt));
  }
  function statusBadge(c, st) {
    if (st === "live") return ui.badge("Live", "ok");
    if (st === "ended") return ui.badge(c.filter === "unlisted" ? "Unlisted" : "Ended");
    return ms(c.startAt) > Date.now() || c.filter === "scheduled" ? ui.badge("Upcoming", "info") : ui.badge("Not live right now", "warn");
  }
  function delivery(c) {
    if (c.needsLink || c.rewardKind === "ingame") return "Sent straight into the game — the SOOP account needs a linked game account" + (c.provider ? " (" + c.provider + ")" : "") + " first.";
    if (c.rewardKind === "code") return "Arrives as a code in the account's SOOP inventory.";
    if (c.rewardKind === "link") return "Arrives as a link to open, in the account's SOOP inventory.";
    return "Arrives in the account's SOOP inventory.";
  }
  function channelsLine(c) {
    const names = (list) => list.slice(0, 3).map((ch) => ch.nick || ch.id).join(", ") + (list.length > 3 ? " and " + (list.length - 3) + " more" : "");
    const all = c.channels || [], on = all.filter((ch) => ch.onAir);
    if (c.categoryWide) return [ui.dot("info", "Any stream"), "Any stream in " + (c.cateName || gameLabel(c)) + " counts"];
    if (on.length) return [ui.dot("ok", "On air"), "On air now: " + names(on)];
    return [ui.dot(null, "Off air"), all.length ? "Nobody on air right now (" + names(all) + ")" : "No channels listed"];
  }

  // ---------- Actions -----------------------------------------------------------
  const startCampaign = (c) => Soop.go("bots", { create: "campaign", dropsIdx: c.dropsIdx });
  const startGame = (gameNo) => Soop.go("bots", { create: "game", gameNo });
  const rescan = () => Soop.refreshCampaigns(true).then((j) => {
    const s = j && j.scan;
    if (!j) Soop.toast("Could not reach the server — the list was not refreshed", "error");
    else if (s && s.ok === false) Soop.toast(s.error || "SOOP could not be read — showing the remembered list", "warn");
    else Soop.toast("Campaign list refreshed from SOOP", "ok");
  });
  // A small form dialog: an intro, one text field, Save (Enter saves too). Stays open if saving fails.
  function ask(o) {
    const input = el("input", { class: "s-input", value: o.value || "", maxlength: String(o.max), "data-autofocus": true,
      onKeydown: (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); save.click(); } } });
    const save = ui.button("Save", { tone: "primary",
      onClick: () => o.save(input.value.trim()).then(() => Soop.refreshCampaigns()).then(() => { m.close(); Soop.toast(o.done, "ok"); }) });
    const m = Soop.modal({ title: o.title, size: "sm", sticky: true, actions: [{ label: "Cancel" }, save],
      body: el("div", { class: "s-stack" }, o.intro, el("label", { class: "s-field" }, o.label, input, el("span", { class: "s-help" }, o.help))) });
    input.select();
  }
  const fixTranslation = (c) => ask({ title: "Fix translation", label: "English title", value: c.title, max: 500, done: "Translation saved",
    intro: el("div", { class: "s-stack is-tight" }, el("p", { class: "s-eyebrow" }, "Original text from SOOP"), el("div", { class: "s-note" }, c.titleRaw)),
    help: "Used wherever this exact text appears. Leave it empty to go back to the automatic translation.",
    save: (english) => Soop.api.post("/translate", { source: c.titleRaw, english }) });
  const renameGame = (gameNo) => ask({ title: "Rename game", label: "Game name", value: Soop.gameName(gameNo), max: 80, done: "Game renamed",
    intro: el("p", { class: "s-muted", style: { margin: "0" } }, "This name is shown for the game everywhere in the SOOP farm."),
    help: "Leave it empty to go back to SOOP's own name.",
    save: (name) => Soop.api.post("/games/rename", { gameNo: String(gameNo), name }) });
  const menuItems = (c) => [
    { label: "Farm this whole game", icon: "bot", disabled: !c.gameNo, onClick: () => startGame(c.gameNo) }, "-",
    { label: "Fix translation", icon: "edit", disabled: !c.titleRaw, onClick: () => fixTranslation(c) },
    { label: "Rename game", icon: "edit", disabled: !c.gameNo, onClick: () => renameGame(c.gameNo) },
  ];

  // ---------- One card ----------------------------------------------------------
  // Rebuilt only when this campaign's own data (or the KO toggle) changed.
  function paintCard(rec) {
    const c = rec.c, st = statusOf(c), raw = F.ko;
    const title = (raw ? c.titleRaw : c.title) || c.title || c.titleRaw || "Untitled campaign";
    const other = raw ? c.title : c.titleRaw;
    const steps = new Map();          // minutes -> the rewards handed out at that point
    (c.items || []).forEach((i) => steps.set(i.minutes, (steps.get(i.minutes) || []).concat(i)));
    const canFarm = (c.steps || []).length > 0;
    rec.when = el("span", { class: "s-grow" });
    rec.cover = el("span", { class: "s-grow s-small" });
    rec.coverSig = null;
    rec.node.className = "s-card" + (st === "live" ? " is-ok" : "");
    rec.node.textContent = "";
    rec.node.append(
      el("div", { class: "s-card-hd" },
        c.image ? el("img", { class: "s-thumb", src: c.image, alt: "", loading: "lazy" }) : null,
        el("div", { class: "s-grow" },
          el("h3", { class: "s-card-title", title: other && other !== title ? (raw ? "English: " : "Korean original: ") + other : null }, title),
          el("div", { class: "s-muted s-small" }, gameLabel(c))),
        statusBadge(c, st),
        ui.menu(ui.button("", { icon: "more", size: "sm", title: "More actions" }), () => menuItems(rec.c))),
      el("div", { class: "s-card-bd s-stack is-tight" },
        el("div", { class: "s-row s-small s-muted" }, ui.icon("clock", 14), rec.when),
        steps.size ? el("ol", { class: "s-steps", "aria-label": "Reward steps" }, Array.from(steps, ([mins, items]) =>
          el("li", { class: "s-step", title: items.map((i) => i.nameRaw).filter(Boolean).join(", ") || null },
            el("b", mins ? fmt.mins(mins) : "No watch time"),
            items.map((i) => (raw ? i.nameRaw : i.name) || i.name || i.nameRaw).join(", "),
            el("div", null, ui.badge(KIND[items[0].kind] || KIND.other))))) : null,
        c.guaranteed ? null : el("div", { class: "s-small s-warn" }, "Not guaranteed — a raffle or random drop, so watch time may pay nothing."),
        el("div", { class: "s-row s-small" }, ui.icon(c.needsLink ? "link" : "gift", 14), el("span", { class: "s-grow" }, delivery(c))),
        el("div", { class: "s-row s-small" }, channelsLine(c).map((x, i) => (i ? el("span", { class: "s-grow" }, x) : x)))),
      el("div", { class: "s-card-ft" },
        canFarm ? ui.button("Start bot", { tone: "primary", size: "sm", icon: "play", onClick: () => startCampaign(rec.c) }) : null,
        rec.cover));
  }
  // Runs on every poll: only text that ages (the relative hint) and who is farming it.
  function tick() {
    cards.forEach((rec) => {
      if (!rec.node.parentNode) return;
      const w = whenText(rec.c);
      if (rec.when.textContent !== w) rec.when.textContent = w;
      const bots = botsFor(rec.c), sig = bots.map((b) => b.id + ":" + b.name).join("|");
      if (sig === rec.coverSig) return;
      rec.coverSig = sig;
      rec.cover.textContent = "";
      rec.cover.className = "s-grow s-small" + (bots.length ? "" : " s-muted");
      if (!bots.length) rec.cover.append((rec.c.steps || []).length ? "No bot is farming this yet" : "No watch-time reward, so there is nothing for a bot to farm");
      else rec.cover.append("Farming with ", ...bots.map((b, i) => [i ? ", " : "", el("a", { class: "s-link", href: "#bots?id=" + encodeURIComponent(b.id) }, b.name || "Unnamed bot")]).reduce((a, x) => a.concat(x), []));
    });
  }

  // ---------- The list ----------------------------------------------------------
  function setEmpty(key, build) {
    R.empty.hidden = !key;
    if (key === R.emptyKey) return;   // never rebuild a button the owner may be about to press
    R.emptyKey = key;
    R.empty.textContent = "";
    if (key) R.empty.append(build());
  }
  function clearFilters() {
    const all = Soop.campaigns || [];
    Object.assign(F, { game: "", guaranteed: false, q: "" });
    F.status = (STATUS.find(([v]) => all.some((c) => statusOf(c) === v)) || STATUS[0])[0];
    R.search.set(""); R.check.checked = false;
    redraw();
  }
  function draw() {
    const all = Soop.campaigns || [];
    seen = all; dirty = false;
    R.filters.hidden = R.toolbar.hidden = !all.length;

    const games = new Map();
    all.forEach((c) => {
      const k = gameKey(c), g = games.get(k) || { key: k, gameNo: c.gameNo || null, name: gameLabel(c), live: 0 };
      if (c.live && pass(c, false, false)) g.live += 1;
      games.set(k, g);
    });
    if (F.game && !games.has(F.game)) F.game = "";
    const sorted = Array.from(games.values()).sort((a, b) => b.live - a.live || a.name.localeCompare(b.name));
    const gameOpts = [{ value: "", label: "All", count: sorted.reduce((n, g) => n + g.live, 0) }].concat(sorted.map((g) => ({ value: g.key, label: g.name, count: g.live })));
    const inGame = all.filter((c) => pass(c, true, false));
    const count = (v) => inGame.filter((c) => statusOf(c) === v).length;
    const statusOpts = STATUS.map(([value, label]) => ({ value, label, count: count(value) }));
    // setOptions rebuilds the chip buttons, so only when a label, count or the selection moved.
    const chipSig = JSON.stringify([gameOpts, statusOpts, F.game, F.status]);
    if (chipSig !== R.chipSig) { R.chipSig = chipSig; R.gameChips.set(F.game).setOptions(gameOpts); R.statusChips.set(F.status).setOptions(statusOpts); }

    const g = F.game ? games.get(F.game) : null;
    const headSig = g ? JSON.stringify([g, statusOpts]) : "";
    R.head.hidden = !g;
    if (headSig !== R.headSig) {
      R.headSig = headSig;
      R.head.textContent = "";
      if (g) R.head.append(el("div", { class: "s-card-bd s-spread" },
        el("div", { class: "s-row" }, el("b", g.name), el("span", { class: "s-muted s-small" }, count("live") + " live · " + count("upcoming") + " upcoming · " + count("ended") + " ended or unlisted")),
        g.gameNo ? el("div", { class: "s-row" },
          ui.button("Start a bot for this game", { size: "sm", icon: "bot", title: "Farms every guaranteed campaign of this game as it goes live", onClick: () => startGame(g.gameNo) }),
          ui.button("", { size: "sm", icon: "edit", title: "Rename game", onClick: () => renameGame(g.gameNo) })) : null));
    }

    const list = inGame.filter((c) => statusOf(c) === F.status).sort(ORDER[F.status]);
    const alive = new Set(all.map((c) => c.dropsIdx)), shown = new Set();
    list.forEach((c, i) => {
      let rec = cards.get(c.dropsIdx);
      if (!rec) cards.set(c.dropsIdx, (rec = { node: el("article", { class: "s-card" }), sig: "" }));
      const sig = (F.ko ? "ko" : "en") + JSON.stringify(Object.assign({}, c, { botIds: null }));
      rec.c = c;
      if (sig !== rec.sig) { rec.sig = sig; paintCard(rec); }
      if (R.grid.children[i] !== rec.node) R.grid.insertBefore(rec.node, R.grid.children[i] || null);
      shown.add(c.dropsIdx);
    });
    cards.forEach((rec, id) => {
      if (!shown.has(id) && rec.node.parentNode) rec.node.remove();
      if (!alive.has(id)) cards.delete(id);
    });
    R.grid.hidden = !list.length;

    const t = (Soop.state && Soop.state.totals) || {};
    if (list.length) setEmpty("");
    else if (!all.length && !t.accounts) setEmpty("accounts", () => ui.empty("No accounts yet", "Campaigns are read from SOOP with one of your accounts. Import one and the list fills in by itself.",
      { label: "Import an account", tone: "primary", icon: "upload", onClick: () => Soop.go("accounts", { import: "1" }) }));
    else if (!all.length) {
      const m = scanMsg();
      setEmpty("none:" + (m.bad ? m.text : ""), () => ui.empty("No campaigns found yet", m.bad ? m.text : "SOOP has not listed any drops campaigns. Refresh to look again.",
        { label: "Refresh from SOOP", icon: "refresh", onClick: rescan }));
    }
    else {
      // What the other filters would show if "Guaranteed only" were off.
      const raffles = F.guaranteed ? all.filter((c) => !c.guaranteed && pass(Object.assign({}, c, { guaranteed: true }), true, true)).length : 0;
      setEmpty("filters:" + raffles, () => ui.empty("Nothing matches these filters",
        raffles ? raffles + (raffles === 1 ? " campaign here is a raffle or random drop" : " campaigns here are raffles or random drops") + " — untick \"Guaranteed only\" to see " + (raffles === 1 ? "it." : "them.") : "Try another game or status, or clear the filters to see everything.",
        { label: "Clear filters", icon: "x", onClick: clearFilters }));
    }
  }
  function scanMsg() {
    const s = Soop.scan, n = (Soop.campaigns || []).length;
    if (!s) return { bad: true, text: "The campaign list could not be loaded. Check the connection, then refresh." };
    if (s.ok === false && s.error) return { bad: true, text: "Could not refresh from SOOP — " + String(s.error).replace(/[.\s]+$/, "") + "." + (n && s.at ? " Showing the list as it was " + fmt.ago(s.at) + "." : "") };
    return { bad: false, text: s.at ? "List read from SOOP " + fmt.ago(s.at) + " · " + fmt.num(n) + (n === 1 ? " campaign" : " campaigns") + " remembered" : "" };
  }
  function drawScan() {
    const m = scanMsg(), show = (Soop.campaigns || []).length > 0;      // with nothing listed the empty state says it
    R.scanBad.hidden = !show || !m.bad; R.scanOk.hidden = !show || m.bad || !m.text;
    const out = m.bad ? R.scanBadText : R.scanOk;
    if (out.textContent !== m.text) out.textContent = m.text;
  }
  function redraw() { dirty = true; if (R) { draw(); tick(); } }

  Soop.on("tab", ({ id, params }) => {
    if (id !== "campaigns" || !params.game || !R) return;
    F.game = String(params.game);
    redraw();
  });

  Soop.registerTab({
    id: "campaigns", label: "Campaigns",
    render(root) {
      R = { chipSig: "", headSig: "", emptyKey: "" };
      R.gameChips = ui.chips({ options: [], value: F.game, onChange: (v) => { F.game = v; redraw(); } });
      R.statusChips = ui.chips({ options: [], value: F.status, onChange: (v) => { F.status = v; redraw(); } });
      R.search = ui.search({ placeholder: "Search title, game or channel", onInput: (q) => { F.q = q; redraw(); } });
      R.check = el("input", { type: "checkbox", checked: F.guaranteed, onChange: () => { F.guaranteed = R.check.checked; redraw(); } });
      const ko = ui.chips({ multi: true, options: [{ value: "ko", label: "KO" }], value: [], onChange: (v) => { F.ko = v.length > 0; redraw(); } });
      R.filters = el("div", { class: "s-stack is-tight" },
        el("p", { class: "s-eyebrow" }, "Game"), R.gameChips,
        el("div", { class: "s-row" }, el("label", { class: "s-check" }, R.check, "Guaranteed only"),
          el("span", { class: "s-help s-grow" }, "Guaranteed means watch time always pays the reward. Raffles and random drops do not.")));
      R.scanOk = el("p", { class: "s-muted s-small", style: { margin: "0" } });
      R.scanBadText = el("span");
      R.scanBad = el("div", { class: "s-note is-warn", hidden: true }, ui.icon("alert"), R.scanBadText);
      R.head = el("section", { class: "s-card", hidden: true });
      R.empty = el("div", { class: "s-card", hidden: true });
      R.grid = el("div", { class: "s-grid" });
      R.toolbar = el("div", { class: "s-toolbar", style: { marginBottom: "0" } }, R.statusChips, R.search,
        el("span", { title: "Show SOOP's original Korean text on every card" }, ko),
        ui.button("Refresh from SOOP", { icon: "refresh", onClick: rescan }));
      root.append(el("div", { class: "s-stack" }, R.filters, R.toolbar, R.scanOk, R.scanBad, R.head, R.empty, R.grid));
    },
    update() {
      if (dirty || Soop.campaigns !== seen || !seen.length) draw();    // campaigns only change every 60 s
      drawScan();
      tick();
    },
    badge() {
      const n = (Soop.campaigns || []).filter((c) => c.live && c.guaranteed && !botsFor(c).length).length;
      return n ? { text: n, tone: "accent" } : null;
    },
  });
})();
