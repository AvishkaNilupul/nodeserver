/* CHZZK farm — Overview tab (docs/CHZZK-PANEL-V2.md §4.1). The first screen: is the farm
   earning, and is anything wrong? Built once in render(); update() only mutates, because it
   runs on every 5 s /state poll and must never drop hover, focus or scroll. */
(function () {
  "use strict";
  const { el, ui, fmt } = Chzzk;
  const DAY = 24 * 3600e3, WEEK = 7 * DAY, STOCK_EVERY = 30e3, TOP_CODES = 5, SCROLL_AFTER = 8;
  const LEVELS = { error: { tone: "error", word: "Problem" }, warn: { tone: "warn", word: "Warning" }, info: { tone: "info", word: "Note" } };
  // [dot tone, words, sort rank] per `current.state`.
  const STATES = { watching: ["ok", "Watching", 0], waiting: ["warn", "Waiting", 1], idle: [null, "Idle", 2] };
  // Most actionable reasons first in the "Not watching" lines.
  const WHY_ORDER = [/logged out/i, /egress/i, /switched off/i, /start/i, /paused/i, /sold/i];

  // ---------- small mutation helpers ----------------------------------------
  const memo = new WeakMap();
  /** Run `fn` only when `sig` differs from the last one seen for `node`. */
  function once(node, sig, fn) { if (memo.get(node) !== sig) { memo.set(node, sig); fn(); } }
  function text(node, value) { value = value == null ? "" : String(value); if (node.textContent !== value) node.textContent = value; }
  function show(node, yes) { if (node.hidden === !!yes) node.hidden = !yes; }
  function cls(node, value) { if (node.className !== value) node.className = value; }
  function tip(node, value) { value = value || ""; if (node.title !== value) node.title = value; }
  function stat(node, value, hint, tone) { once(node, [value, hint, tone].join("|"), () => node.set(value, hint, tone)); }
  function plural(n, one, many) { return fmt.num(n) + " " + (n === 1 ? one : many || one + "s"); }
  const count = (list, level) => list.filter((a) => a.level === level).length;
  /** A box whose one child is rebuilt by `make` only when `sig` changes (dots, badges, empty states). */
  function slot(tag, attrs) {
    const box = el(tag || "span", attrs || {});
    box.put = (sig, make) => once(box, sig, () => { while (box.firstChild) box.removeChild(box.firstChild); const n = make(); if (n) box.append(n); });
    return box;
  }
  /** Keyed list: reuse one view per key (repeats get "#2", "#3"), create the new ones, forget the gone. */
  function keyed(map, items, keyOf, make) {
    const seen = new Map(), used = new Set(), nodes = [];
    items.forEach((item) => {
      const base = String(keyOf(item)), n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      const k = n > 1 ? base + "#" + n : base;
      used.add(k);
      let view = map.get(k);
      if (!view) map.set(k, (view = make()));
      view.patch(item);
      nodes.push(view.node);
    });
    map.forEach((v, k) => { if (!used.has(k)) map.delete(k); });
    return nodes;
  }
  /** Make `parent`'s children exactly `nodes`, moving only what is out of place. */
  function sync(parent, nodes) {
    nodes.forEach((n, i) => { if (parent.children[i] !== n) parent.insertBefore(n, parent.children[i] || null); });
    while (parent.children.length > nodes.length) parent.removeChild(parent.lastElementChild);
  }
  function link(label, onGo, href) {
    return el("a", { class: "s-link", href: href || "#", onClick: (e) => { e.preventDefault(); onGo(); } }, label);
  }

  // ---------- data helpers ---------------------------------------------------
  const toMs = (v) => (typeof v === "number" ? v : v ? Date.parse(v) : NaN);
  const toIso = (v) => { const t = toMs(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
  function nowMs() { const t = toMs(Chzzk.state && Chzzk.state.now); return Number.isFinite(t) ? t : Date.now(); }
  const gameOfCampaign = (c) => Chzzk.gameName(c.categoryId, c.categoryValue);
  function gameOf(campaignNo, fallback) {
    const c = campaignNo == null || campaignNo === "" ? null : Chzzk.campaignByNo(campaignNo);
    return c ? gameOfCampaign(c) : fallback || "";
  }
  const who = (a) => a.nickname || (a.userIdHash ? "Login " + a.userIdHash : "Unnamed login");
  const byName = (a, b) => who(a).localeCompare(who(b));
  const stateRank = (a) => { const s = a.current && STATES[a.current.state]; return s ? s[2] : 3; };
  const whyRank = (a) => { const i = WHY_ORDER.findIndex((re) => re.test(a.why || "")); return i < 0 ? WHY_ORDER.length : i; };
  const showCampaign = (no) => Chzzk.go("campaigns", { no: String(no) });
  const openImport = () => (window.ChzzkImport ? window.ChzzkImport.open() : Chzzk.go("accounts"));

  // ---------- alerts -----------------------------------------------------------
  // Alerts carry no id: key by kind + campaign (an "ending" message changes every minute), else by text.
  const alertKey = (a) => (a.kind || "") + ":" + (a.campaignNo != null && a.campaignNo !== "" ? "#" + a.campaignNo : a.msg);
  function alertView() {
    let cur = {};
    const dot = slot(), msg = el("span", { class: "s-grow" });
    const more = link("Show campaign", () => showCampaign(cur.campaignNo), "#campaigns");
    const node = el("div", { class: "s-note" }, dot, msg, more);
    return { node, patch(a) {
      cur = a;
      const lv = LEVELS[a.level] || LEVELS.info;
      cls(node, lv.tone === "info" ? "s-note" : "s-note is-" + lv.tone);
      dot.put(lv.tone, () => ui.dot(lv.tone, lv.word));
      text(msg, a.msg);
      show(more, a.campaignNo != null && a.campaignNo !== "");
    } };
  }

  // ---------- right now --------------------------------------------------------
  function nowView() {
    const dot = slot(), name = el("b", { class: "s-trunc" }), took = el("span", { class: "s-muted s-small s-nowrap" });
    const what = el("span", { class: "s-small s-trunc" });
    const bar = ui.progress(0, 0), barBox = el("span", { class: "s-grow" }, bar);
    const barText = el("span", { class: "s-muted s-small s-num s-nowrap" });
    const credit = el("span", { class: "s-small s-muted" }), note = el("span", { class: "s-small s-muted" });
    const creditRow = el("div", { class: "s-row" }, credit, note);
    const node = el("li", { class: "s-list-item" }, dot, el("div", { class: "s-grow s-stack is-tight" },
      el("div", { class: "s-spread" }, name, took), what, el("div", { class: "s-row" }, barBox, barText), creditRow));
    return { node, patch(a) {
      const c = a.current || {}, look = STATES[c.state] || [null, a.current ? "Busy" : "Getting ready"];
      dot.put(look[0] + "|" + look[1], () => ui.dot(look[0], look[1]));
      text(name, who(a));

      const since = toMs(c.since), mins = Number.isFinite(since) ? Math.floor((nowMs() - since) / 60e3) : NaN;
      text(took, !Number.isFinite(mins) ? "" : mins < 1 ? "just now" : "for " + fmt.mins(mins));
      tip(took, Number.isFinite(since) ? "Since " + fmt.when(toIso(since)) : "");

      const chan = c.channelName || c.channelId;
      const parts = [gameOf(c.campaignNo), c.title, chan ? "on " + chan : ""].filter(Boolean);
      text(what, parts.length ? parts.join(" · ") : a.current ? "Looking for a stream to watch" : "Getting ready to watch");
      tip(what, parts.join(" · "));

      const need = Number(c.needed) || 0, got = Math.max(0, Number(c.minutes) || 0);
      show(barBox, need > 0);
      if (need > 0) once(bar, got + "/" + need, () => bar.set(Math.min(got, need), need));
      text(barText, c.minutes == null ? "" : need > 0 ? fmt.num(got) + " of " + fmt.num(need) + " min" : fmt.num(got) + " min so far");

      // Watch time CHZZK has not credited after a few minutes means the heartbeats are not counting.
      const w = Number(c.watched), hasW = c.watched != null && Number.isFinite(w);
      const cr = c.credited == null || !Number.isFinite(Number(c.credited)) ? null : Number(c.credited);
      const stuck = hasW && w >= 6 && cr === 0;
      text(credit, !hasW ? "" : cr == null ? "Watched " + fmt.num(w) + " min on this stream, credit not read yet"
        : "Credited " + fmt.num(cr) + " of " + fmt.num(w) + " min on this stream" + (stuck ? " — CHZZK has not counted any yet" : ""));
      cls(credit, "s-small " + (stuck ? "s-warn" : "s-muted"));
      text(note, c.note || "");
      show(credit, credit.textContent);
      show(note, note.textContent);
      show(creditRow, credit.textContent || note.textContent);
    } };
  }
  function restView() {
    const name = el("span", { class: "s-strong" }), why = el("span");
    const node = el("div", { class: "s-small s-muted s-trunc" }, name, " — ", why);
    return { node, patch(a) {
      text(name, who(a));
      text(why, a.why || "Not watching");
      tip(node, a.lastError || "");
    } };
  }
  /** Title, hint and whether to offer the import button, for a "Right now" card with nobody running. */
  function emptyFor(s, nAccounts, on) {
    if (!nAccounts) return ["No logins yet", "Import a CHZZK login cookie and the farm starts watching.", true];
    if (!on) return ["The farm is switched off", "Switch it on to start watching. Logins, progress and codes are kept.", false];
    if (!s.started) return ["Starting up", "Logins start watching in a moment.", false];
    if (s.egress && s.egress.ok === false) return ["Egress is down", "Nothing can reach CHZZK until it is back.", false];
    return ["Nobody is watching right now", "Each login below says why it is not watching.", false];
  }

  // ---------- ending soon ------------------------------------------------------
  function endView() {
    let cur = {};
    const title = el("a", { class: "s-link s-trunc", href: "#campaigns", onClick: (e) => { e.preventDefault(); showCampaign(cur.campaignNo); } });
    const left = el("span", { class: "s-small s-nowrap" }), sub = el("span", { class: "s-small s-muted" });
    const bar = ui.progress(0, 0), barText = el("span", { class: "s-muted s-small s-num s-nowrap" });
    const barRow = el("div", { class: "s-row" }, el("span", { class: "s-grow" }, bar), barText);
    const node = el("li", { class: "s-list-item" }, el("div", { class: "s-grow s-stack is-tight" },
      el("div", { class: "s-spread" }, title, left), sub, barRow));
    return { node, patch(c) {
      cur = c;
      text(title, c.title || "Campaign #" + c.campaignNo);
      tip(title, c.title || "");
      text(left, "ends " + fmt.until(c.endAt));
      tip(left, fmt.when(c.endAt));
      const L = c.logins || {}, list = L.list || [];
      text(sub, gameOfCampaign(c) + " · " + fmt.num(L.done || 0) + " of " + plural(L.eligible || 0, "login") + " done"
        + (L.watching ? " · " + fmt.num(L.watching) + " watching" : ""));
      const best = list.reduce((b, x) => (!b || (Number(x.minutes) || 0) > (Number(b.minutes) || 0) ? x : b), null);
      const max = Number(c.maxMinutes) || 0, got = best ? Math.max(0, Number(best.minutes) || 0) : 0;
      show(barRow, !!best && max > 0);
      if (best && max > 0) {
        once(bar, got + "/" + max, () => bar.set(Math.min(got, max), max));
        text(barText, "Furthest: " + (best.nickname || "a login") + ", " + fmt.mins(got) + " of " + fmt.mins(max));
      }
    } };
  }

  // ---------- codes (GET /stock) -----------------------------------------------
  let stock = null, stockAt = 0, stockBusy = false, stockFailed = false;
  const useByMs = (x) => { const t = toMs(x.useBy); return Number.isFinite(t) ? t : 9e15; };
  function codeView() {
    const title = el("b", { class: "s-trunc" }), fresh = el("span", { class: "s-num s-strong s-nowrap" });
    const sub = el("span", { class: "s-small s-muted" }), useBy = el("span", { class: "s-small" });
    const node = el("li", { class: "s-list-item" }, el("div", { class: "s-grow s-stack is-tight" },
      el("div", { class: "s-spread" }, title, fresh), el("div", { class: "s-row" }, sub, useBy)));
    return { node, patch(x) {
      // Prefer the kit's English name via the campaign; stock rows can outlive the campaign list.
      text(title, gameOf(x.campaignNo, x.game || "Other") + " · " + (x.title || "Reward"));
      tip(title, x.campaignTitle || "");
      text(fresh, fmt.num(Number(x.fresh) || 0) + " new");
      text(sub, Chzzk.rewardType(x.rewardType) + (x.waiting ? " · " + fmt.num(x.waiting) + " waiting to be read" : ""));
      const end = toMs(x.useBy), soon = Number.isFinite(end) && end - nowMs() < WEEK;
      text(useBy, Number.isFinite(end) ? "· use by " + fmt.when(x.useBy) + " (" + fmt.until(x.useBy) + ")" : "");
      cls(useBy, "s-small " + (soon ? "s-warn" : "s-muted"));
    } };
  }
  function loadStock() {
    if (stockBusy) return;
    stockBusy = true;
    stockAt = Date.now();     // set before the call, so a failing /stock is also retried only every 30 s
    Chzzk.api.get("/stock")
      .then((j) => { stock = j || {}; stockFailed = false; }, () => { stockFailed = true; })
      .then(() => { stockBusy = false; drawCodes(); });
  }

  // ---------- the tab ------------------------------------------------------------
  const alertViews = new Map(), nowViews = new Map(), restViews = new Map(), endViews = new Map(), codeViews = new Map();
  let st, allGood, alertCard, alertBadge, alertBox, nowCount, nowList, nowEmpty, restBd, restHead, restBox,
    endList, endNone, codeList, codeNote, codeSum, swCard, swStat, swOff, swOn;

  function card(title, side, ...body) {
    return el("section", { class: "s-card" },
      el("div", { class: "s-card-hd" }, el("h2", { class: "s-card-title s-grow" }, title), side), ...body);
  }

  function render(root) {
    st = { watching: ui.stat("Logins watching", "–"), out: ui.stat("Logged out", "–"), codes: ui.stat("Codes stored", "–"),
      camps: ui.stat("Campaigns farmable", "–"), egress: ui.stat("Egress", "–") };

    allGood = el("div", { class: "s-note is-ok" }, ui.icon("check"), el("span", "All good — nothing needs your attention."));
    alertBadge = slot();
    alertBox = el("div", { class: "s-card-bd s-stack is-tight" });
    alertCard = card("Needs attention", alertBadge, alertBox);

    nowCount = el("span", { class: "s-muted s-small" });
    nowList = el("ul", { class: "s-list" });
    nowEmpty = slot("div", { class: "s-card-bd" });
    restHead = el("p", { class: "s-eyebrow" });
    restBox = el("div", { class: "s-stack is-tight" });
    restBd = el("div", { class: "s-card-bd s-stack is-tight" }, restHead, restBox);
    const nowCard = card("Right now", nowCount, nowList, nowEmpty, restBd);

    endList = el("ul", { class: "s-list" });
    endNone = el("div", { class: "s-card-bd s-muted s-small" }, "No farmable campaign ends in the next 24 hours.");
    const endCard = card("Ending soon", ui.button("All campaigns", { tone: "ghost", size: "sm", onClick: () => Chzzk.go("campaigns") }), endList, endNone);

    codeList = el("ul", { class: "s-list" });
    codeNote = el("span", { class: "s-small s-muted" });
    codeSum = el("span", { class: "s-small s-muted" });
    const codeCard = card("Codes", link("All codes", () => Chzzk.go("codes"), "#codes"),
      codeList, el("div", { class: "s-card-bd s-stack is-tight" }, codeNote, codeSum));

    swStat = ui.stat("Farm", "–");
    swOff = ui.button("Switch farm off", { tone: "danger", icon: "stop", onClick: () => Chzzk.switchFarm(false) });
    swOn = ui.button("Switch farm on", { tone: "primary", icon: "play", onClick: () => Chzzk.switchFarm(true) });
    swCard = card("Farm switch", null, el("div", { class: "s-card-bd s-stack" }, swStat, el("div", { class: "s-row" }, swOff, swOn)));

    root.append(el("div", { class: "s-stack" }, allGood, alertCard,
      el("div", { class: "s-stats" }, st.watching, st.out, st.codes, st.camps, st.egress),
      el("div", { class: "s-grid-2" }, el("div", { class: "s-stack" }, nowCard, endCard), el("div", { class: "s-stack" }, swCard, codeCard))));
    loadStock();
  }

  function drawCodes() {
    if (!codeList) return;
    const rows = stock && Array.isArray(stock.stock) ? stock.stock : [];
    const withNew = rows.filter((x) => Number(x.fresh) > 0);
    const top = withNew.slice().sort((a, b) => Number(b.fresh) - Number(a.fresh) || useByMs(a) - useByMs(b)).slice(0, TOP_CODES);
    sync(codeList, keyed(codeViews, top, (x) => x.campaignNo + ":" + x.rewardNo, codeView));
    show(codeList, top.length);
    text(codeNote, !stock ? (stockFailed ? "The code stock could not be loaded — trying again shortly." : "Loading the code stock…")
      : stockFailed ? "Could not refresh — showing the last list."
      : !top.length ? "No new codes in stock."
      : withNew.length > top.length ? "Top " + top.length + " of " + plural(withNew.length, "reward") + " with new codes." : "");
    cls(codeNote, "s-small " + (stockFailed ? "s-warn" : "s-muted"));
    show(codeNote, codeNote.textContent);
    const tt = (stock && stock.totals) || {}, parts = [fmt.num(tt.fresh || 0) + " new"];
    if (tt.revealed) parts.push(fmt.num(tt.revealed) + " revealed");
    if (tt.waiting) parts.push(fmt.num(tt.waiting) + " earned, waiting to be read");
    if (tt.expired) parts.push(fmt.num(tt.expired) + " expired");
    text(codeSum, stock ? parts.join(" · ") : "");
    show(codeSum, codeSum.textContent);
  }

  function update() {
    const s = Chzzk.state || {}, t = s.totals || {}, eg = s.egress || {}, alerts = s.alerts || [], accounts = s.accounts || [];
    const on = !!(s.switch && s.switch.on), now = nowMs();

    // 1. alerts (the server sends them worst first)
    sync(alertBox, keyed(alertViews, alerts, alertKey, alertView));
    const worst = count(alerts, "error") ? "error" : count(alerts, "warn") ? "warn" : "";
    show(alertCard, alerts.length);
    show(allGood, !alerts.length);
    cls(alertCard, "s-card" + (worst ? " is-" + worst : ""));
    alertBadge.put(alerts.length + "|" + worst, () => ui.badge(fmt.num(alerts.length), worst || null));

    // 2. stats
    stat(st.watching, fmt.num(t.watching || 0), "of " + fmt.num(t.running || 0) + " running", t.watching ? "ok" : null);
    const out = t.loggedOut || 0;
    stat(st.out, fmt.num(out), !out ? "All signed in" : out === 1 ? "Re-import its cookie" : "Re-import their cookies", out ? "error" : null);
    stat(st.codes, fmt.num(t.codes || 0), fmt.num(t.codesFresh || 0) + " new, " + fmt.num(t.codesToday || 0) + " today", null);
    stat(st.camps, fmt.num(t.farmable || 0), "of " + fmt.num(t.campaigns || 0), null);
    const via = eg.via ? "via " + eg.via : "";
    if (eg.ok === false) stat(st.egress, eg.country || "Down", "Down — nothing reaches CHZZK" + (via ? " (" + via + ")" : ""), "error");
    else if (!eg.country) stat(st.egress, "–", "Not checked yet" + (via ? " · " + via : ""), "warn");
    else stat(st.egress, eg.country, [via, eg.at ? "checked " + fmt.ago(eg.at) : ""].filter(Boolean).join(", "), null);
    tip(st.egress, eg.ok === false ? eg.error || "" : "");

    // 3. right now: running logins first (watching, waiting, idle), then one line per idle login
    const running = accounts.filter((a) => a.running).sort((a, b) => stateRank(a) - stateRank(b) || byName(a, b));
    const resting = accounts.filter((a) => !a.running).sort((a, b) => whyRank(a) - whyRank(b) || byName(a, b));
    sync(nowList, keyed(nowViews, running, (a) => a.id, nowView));
    show(nowList, running.length);
    const watching = running.filter((a) => a.current && a.current.state === "watching").length;
    text(nowCount, running.length ? fmt.num(watching) + " of " + plural(running.length, "running login") + " watching" : "");
    show(nowEmpty, !running.length);
    if (!running.length) {
      const e = emptyFor(s, accounts.length, on);
      nowEmpty.put(e.join("|"), () => ui.empty(e[0], e[1], e[2] ? { label: "Import logins", tone: "primary", icon: "upload", onClick: openImport } : undefined));
    }
    sync(restBox, keyed(restViews, resting, (a) => a.id, restView));
    show(restBd, resting.length);
    text(restHead, "Not watching · " + fmt.num(resting.length));
    cls(restBox, "s-stack is-tight" + (resting.length > SCROLL_AFTER ? " s-scroll" : ""));

    // 4. ending soon: farmable campaigns ending within 24 h, soonest first
    const soon = (Chzzk.campaigns || []).filter((c) => { const end = toMs(c.endAt); return c.farmable && end > now && end - now <= DAY; })
      .sort((a, b) => toMs(a.endAt) - toMs(b.endAt));
    sync(endList, keyed(endViews, soon, (c) => c.campaignNo, endView));
    show(endList, soon.length);
    show(endNone, !soon.length);

    // 5. codes: redraw (use-by countdowns), refetch at most every 30 s — update() only runs while visible
    drawCodes();
    if (Date.now() - stockAt >= STOCK_EVERY) loadStock();

    // 6. farm switch
    const ready = s.started && eg.ok !== false;
    stat(swStat, on ? "ON" : "OFF",
      !on ? "All watching is stopped. Logins, progress and codes are kept."
        : !s.started ? "Starting up" : eg.ok === false ? "On, but egress is down — nothing reaches CHZZK" : "Logins watch whenever there is something to farm",
      on && ready ? "ok" : "warn");
    cls(swCard, "s-card " + (on ? "is-ok" : "is-warn"));
    show(swOff, on);
    show(swOn, !on);
  }

  function badge() {
    const alerts = (Chzzk.state && Chzzk.state.alerts) || [];
    const errs = count(alerts, "error"), warns = count(alerts, "warn");
    return errs ? { text: errs, tone: "error" } : warns ? { text: warns, tone: "warn" } : null;
  }

  Chzzk.registerTab({ id: "overview", label: "Overview", render, update, badge });
})();
