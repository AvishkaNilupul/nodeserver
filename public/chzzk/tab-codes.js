/* CHZZK farm v2 — Codes tab (contract §4.5): what the farm holds. A stock summary per reward
   (with a CSV of counts and dates — never a code) and every earned reward, newest first.
   /stock and /rewards are not part of /state: they load on first render, then at most every
   30 s while this tab is on screen, and after "Collect codes now". A code reaches the page only
   through Chzzk.reveal(), one row at a time; this file never sees one. */
(function () {
  "use strict";
  const { el, ui, fmt } = Chzzk;
  const EVERY_MS = 30 * 1000, WEEK_MS = 7 * 86400 * 1000;
  const STATES = {
    stored: { label: "Stored", tone: "ok" },
    earned: { label: "Waiting", tone: "warn" },
    in_app: { label: "In-game", tone: null },
  };

  let stock = null, totals = null, stockError = "";
  let rewards = null, rewardsError = "";
  let loading = null, loadAgain = false, lastLoadAt = 0, afterCollect = null;
  let stateFilter = "all", gameFilter = "all", query = "";
  const cells = new Map();            // reward id -> its code cell, reused so a revealed code survives redraws
  let host, stats, stockStatus, stockTable, csvBtn, codesStatus, codesLine, search, stateChips, gameChips, codesTable;

  // ---------- small helpers --------------------------------------------------
  const plural = (n, one) => fmt.num(n) + " " + one + (Number(n) === 1 ? "" : "s");
  const errText = (e) => (e && e.message) || "Unknown error";
  const dash = () => el("span", { class: "s-muted" }, "–");

  function gameInfo(categoryId, raw) {
    const name = Chzzk.gameName(categoryId, raw);
    return { name, raw: raw && raw !== name ? String(raw) : "" };
  }
  function stockGame(s) {
    const c = Chzzk.campaignByNo(s.campaignNo);
    return gameInfo(c ? c.categoryId : null, (c && c.categoryValue) || s.game);
  }
  const rewardGame = (r) => gameInfo(r.categoryId, r.gameName);
  // English name first; CHZZK's own (often Korean) name next to it, as it came.
  function gameCell(g) {
    return el("span", { title: g.raw || g.name }, g.name, g.raw ? el("span", { class: "s-muted s-small" }, " " + g.raw) : null);
  }
  function rewardCell(title, type, campaignTitle) {
    const name = title || "Unnamed reward";
    return el("span", { title: campaignTitle ? name + " — " + campaignTitle : name }, name,
      el("span", { class: "s-muted s-small" }, " · " + Chzzk.rewardType(type)));
  }
  function campaignLink(no, title) {
    const label = title || "Campaign #" + no;
    return el("a", { class: "s-link", href: "#campaigns", title: label,
      onClick: (e) => { e.preventDefault(); Chzzk.go("campaigns", { no: String(no) }); } }, label);
  }
  const at = (iso) => (iso ? el("span", { class: "s-nowrap", title: fmt.ago(iso) }, fmt.when(iso)) : dash());
  const ago = (iso) => (iso ? el("span", { class: "s-nowrap", title: fmt.when(iso) }, fmt.ago(iso)) : dash());
  // Local time plus how long is left; inside a week it is called out with an icon and colour.
  function useBy(iso) {
    const t = Date.parse(iso);
    if (!iso || !isFinite(t)) return dash();
    if (t <= Date.now()) return el("span", { class: "s-muted s-nowrap", title: fmt.when(iso) }, "Expired " + fmt.ago(iso));
    const soon = t - Date.now() < WEEK_MS;
    return el("span", { class: soon ? "s-warn s-nowrap" : "s-nowrap", title: soon ? "Less than a week left — use these first" : fmt.when(iso) },
      soon ? ui.icon("alert", 13) : null, fmt.when(iso) + " · " + fmt.until(iso));
  }
  // Table-row form: "in 38 days", the date on hover; red-ish under a week, like useBy.
  function useByShort(iso) {
    const t = Date.parse(iso);
    if (!iso || !isFinite(t)) return dash();
    if (t <= Date.now()) return el("span", { class: "s-muted s-nowrap", title: fmt.when(iso) }, "expired");
    const soon = t - Date.now() < WEEK_MS;
    return el("span", { class: soon ? "s-warn s-nowrap" : "s-nowrap", title: fmt.when(iso) }, soon ? ui.icon("alert", 13) : null, fmt.until(iso));
  }
  const count = (n, tone) => el("span", { class: "s-num" + (n ? (tone ? " " + tone : "") : " s-muted") }, fmt.num(n || 0));

  function loginCell(r) {
    const a = Chzzk.accountById(r.accountId);
    const nick = r.nickname || (a && a.nickname) || "Unknown login";
    return el("b", { title: r.userIdHash ? nick + " · " + r.userIdHash : nick }, nick);
  }
  function stateCell(r) {
    const st = STATES[r.state] || { label: r.state || "Unknown", tone: null };
    // Who revealed it sits under the badge (one column less, so Reveal stays on screen).
    if (r.state !== "earned") {
      if (!r.hasCode || !r.revealedAt) return ui.badge(st.label, st.tone);
      return el("div", { class: "s-stack is-tight", style: { alignItems: "flex-start" } }, ui.badge(st.label, st.tone),
        el("span", { class: "s-small s-muted s-nowrap", title: fmt.when(r.revealedAt) }, "revealed " + fmt.ago(r.revealedAt) + (r.revealedBy ? " by " + r.revealedBy : "")));
    }
    const bits = [], next = Date.parse(r.nextTryAt);
    if (r.tries) bits.push("tried " + plural(r.tries, "time"));
    if (isFinite(next)) bits.push(next > Date.now() ? "next try " + fmt.until(r.nextTryAt) : "next try soon");
    return el("div", { class: "s-stack is-tight", style: { alignItems: "flex-start" } }, ui.badge(st.label, st.tone),
      r.lastError ? el("span", { class: "s-small s-warn" }, r.lastError) : null,
      el("span", { class: "s-small s-muted" }, bits.length ? bits.join(" · ") : "code not read yet"));
  }
  // The cell is ours; Chzzk.reveal fills it and puts a Reveal button back after 60 s.
  function codeCell(r) {
    if (!r.hasCode) return el("span", { class: "s-muted s-small" }, r.state === "in_app" ? "In-game reward" : "Not read yet");
    const id = String(r.id);
    if (cells.has(id)) return cells.get(id);
    const cell = el("span", { class: "s-row", dataset: { stop: "1" } });
    cell.append(ui.button("Reveal", { size: "sm", icon: "eye", title: "Show this code for 60 seconds — the reveal is recorded",
      onClick: () => Chzzk.reveal(r.id, cell) }));
    cells.set(id, cell);
    return cell;
  }

  // ---------- loading ----------------------------------------------------------
  function load(force) {
    if (loading) { if (force) loadAgain = true; return loading; }
    lastLoadAt = Date.now();
    const a = Chzzk.api.get("/stock").then(
      (j) => { stock = j.stock || []; totals = j.totals || {}; stockError = ""; },
      (e) => { stockError = errText(e); });
    const b = Chzzk.api.get("/rewards").then(
      (j) => { rewards = j.rewards || []; rewardsError = ""; prune(); },
      (e) => { rewardsError = errText(e); });
    loading = Promise.all([a, b]).then(() => {
      loading = null;
      paint();
      if (loadAgain) { loadAgain = false; load(); }
    });
    return loading;
  }
  function prune() {
    const ids = new Set(rewards.map((r) => String(r.id)));
    cells.forEach((_, id) => { if (!ids.has(id)) cells.delete(id); });
  }
  // The collector reads codes in the background; reload once it has gone quiet again.
  function collect() {
    return Chzzk.api.post("/rewards/collect", {}).then((j) => {
      const n = (j && j.queued) || 0;
      if (n) Chzzk.toast("Collecting codes for " + plural(n, "login") + " — this list refreshes when it is done", "ok");
      else Chzzk.toast("Nothing was queued — no login has a code waiting to be read", "info");
      afterCollect = n ? { at: Date.now(), saw: false } : null;
      Chzzk.refresh();
      return load(true);
    });
  }
  function watchCollector() {
    if (!afterCollect) return;
    const pending = (Chzzk.state.collector || {}).pending || 0, age = Date.now() - afterCollect.at;
    if (pending > 0) afterCollect.saw = true;
    else if (afterCollect.saw || age > 15 * 1000) { afterCollect = null; load(true); return; }
    if (age > 5 * 60 * 1000) afterCollect = null;
  }

  // ---------- CSV ----------------------------------------------------------------
  function csvCell(v) {
    let s = v == null ? "" : String(v);
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;   // a CHZZK title must never run as a spreadsheet formula
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function downloadCsv() {
    const rows = sortedStock();
    if (!rows.length) return;
    const head = ["Game", "Game on CHZZK", "Reward", "Type", "Campaign", "Campaign no", "Reward no",
      "Fresh", "Revealed", "Waiting", "Use-by", "Last earned"];
    const lines = [head].concat(rows.map((s) => {
      const g = stockGame(s);
      return [g.name, g.raw, s.title || "", Chzzk.rewardType(s.rewardType), s.campaignTitle || "", s.campaignNo, s.rewardNo,
        s.fresh || 0, s.revealed || 0, s.waiting || 0, s.useBy || "", s.lastEarnedAt || ""];
    }));
    // BOM so a spreadsheet reads the Korean titles as UTF-8.
    const text = "﻿" + lines.map((l) => l.map(csvCell).join(",")).join("\r\n") + "\r\n";
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    const a = el("a", { download: "chzzk-stock-" + new Date().toISOString().slice(0, 10) + ".csv", hidden: true });
    a.href = url;                     // set directly: el() scrubs blob: URLs, and this one is our own
    host.append(a);
    try { a.click(); } finally {
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }

  // ---------- painting -------------------------------------------------------------
  function sortedStock() {
    return (stock || []).slice().sort((x, y) => (y.fresh || 0) - (x.fresh || 0) || (y.waiting || 0) - (x.waiting || 0)
      || stockGame(x).name.localeCompare(stockGame(y).name));
  }
  function shownCodes() {
    const q = query.toLowerCase();
    return (rewards || []).filter((r) => (stateFilter === "all" || r.state === stateFilter)
      && (gameFilter === "all" || rewardGame(r).name === gameFilter)
      && (!q || [r.title, r.campaignTitle, r.nickname, r.userIdHash, (Chzzk.accountById(r.accountId) || {}).nickname]
        .filter(Boolean).join(" ").toLowerCase().includes(q)));
  }
  function statusBox() {
    const line = el("p", { class: "s-muted", role: "status" });
    return { box: el("div", { class: "s-card-bd" }, line), line };
  }
  function setStatus(s, have, err, what) {
    s.box.hidden = have && !err;
    s.line.className = err ? "s-error" : "s-muted";
    s.line.textContent = !err ? "Loading " + what + "…"
      : have ? "Could not refresh " + what + " (" + err + ") — showing the last list. Trying again in 30 s."
        : what.charAt(0).toUpperCase() + what.slice(1) + " could not be loaded (" + err + "). Trying again in 30 s.";
  }
  function paint() {
    const t = totals || {}, n = (k) => (totals ? fmt.num(t[k] || 0) : "–");
    stats.fresh.set(n("fresh"), totals ? "never revealed, still usable · " + fmt.num(t.stored || 0) + " stored" : "never revealed, still usable", t.fresh ? "ok" : null);
    stats.revealed.set(n("revealed"), "shown at least once");
    stats.waiting.set(n("waiting"), "earned — code not read yet");
    stats.expired.set(n("expired"), "past their use-by date");
    setStatus(stockStatus, !!stock, stockError, "the stock");
    stockTable.hidden = !stock;
    csvBtn.disabled = !stock || !stock.length;

    const list = rewards || [];
    stateChips.setOptions([{ value: "all", label: "All", count: list.length }].concat(Object.keys(STATES).map((k) =>
      ({ value: k, label: STATES[k].label, count: list.filter((r) => r.state === k).length }))));
    const games = new Map();
    list.forEach((r) => { const g = rewardGame(r).name; games.set(g, (games.get(g) || 0) + 1); });
    if (gameFilter !== "all" && !games.has(gameFilter)) games.set(gameFilter, 0);   // keep the active filter undoable
    gameChips.setOptions([{ value: "all", label: "All games" }].concat(Array.from(games.keys()).sort()
      .map((g) => ({ value: g, label: g, count: games.get(g) }))));
    gameChips.hidden = games.size < 2 && gameFilter === "all";
    setStatus(codesStatus, !!rewards, rewardsError, "the codes");
    codesTable.hidden = !rewards;
    redraw();
  }
  // Runs on every poll too: relative times and login names stay current without a fetch.
  function redraw() {
    if (stock) stockTable.update(sortedStock());
    if (!rewards) { codesLine.textContent = ""; return; }
    const shown = shownCodes();
    codesLine.textContent = (shown.length === rewards.length ? plural(rewards.length, "reward")
      : fmt.num(shown.length) + " of " + plural(rewards.length, "reward")) + (rewards.length >= 500 ? " · newest 500 only" : "");
    codesTable.update(shown);
  }

  // ---------- registration ---------------------------------------------------------
  Chzzk.registerTab({
    id: "codes", label: "Codes",
    render(root) {
      host = root;
      stats = { fresh: ui.stat("Fresh", "–"), revealed: ui.stat("Revealed", "–"), waiting: ui.stat("Waiting", "–"), expired: ui.stat("Expired", "–") };
      stockStatus = statusBox();
      codesStatus = statusBox();
      csvBtn = ui.button("Download CSV", { size: "sm", icon: "download", disabled: true,
        title: "Counts and dates from this table — no codes", onClick: downloadCsv });
      stockTable = ui.table({ key: (s) => s.campaignNo + ":" + s.rewardNo, flush: true, rows: [],
        empty: "No codes yet — they show up here once a login earns a code reward",
        columns: [
          { label: "Game", render: (s) => gameCell(stockGame(s)) },
          { label: "Reward", grow: true, render: (s) => rewardCell(s.title, s.rewardType) },
          { label: "Campaign", hide: "sm", render: (s) => campaignLink(s.campaignNo, s.campaignTitle) },
          { label: "Fresh", align: "right", render: (s) => count(s.fresh, "s-ok s-strong") },
          { label: "Revealed", align: "right", render: (s) => count(s.revealed) },
          { label: "Waiting", align: "right", render: (s) => count(s.waiting) },
          { label: "Use-by", render: (s) => useBy(s.useBy) },
          { label: "Last earned", hide: "sm", render: (s) => ago(s.lastEarnedAt) },
        ] });
      search = ui.search({ placeholder: "Search reward or login", onInput: (q) => { query = q; redraw(); } });
      stateChips = ui.chips({ options: [], value: stateFilter, onChange: (v) => { stateFilter = v; redraw(); } });
      gameChips = ui.chips({ options: [], value: gameFilter, onChange: (v) => { gameFilter = v; redraw(); } });
      codesLine = el("span", { class: "s-muted s-small" });
      codesTable = ui.table({ key: "id", flush: true, rows: [],
        empty: "Nothing here — no reward has been earned yet, or none fits these filters",
        columns: [
          { label: "Earned", render: (r) => at(r.earnedAt) },
          { label: "Login", render: loginCell },
          { label: "Game", hide: "sm", render: (r) => gameCell(rewardGame(r)) },
          { label: "Reward", grow: true, render: (r) => rewardCell(r.title, r.rewardType, r.campaignTitle) },
          { label: "Use-by", render: (r) => (r.hasCode ? useByShort(r.codeEndAt) : dash()) },
          { label: "State", wrap: true, render: stateCell },
          { label: "Code", render: codeCell },
        ] });
      root.append(el("div", { class: "s-stack" },
        el("div", { class: "s-stats" }, stats.fresh, stats.revealed, stats.waiting, stats.expired),
        el("section", { class: "s-card" },
          el("div", { class: "s-card-hd" }, el("h2", { class: "s-card-title s-grow" }, "Stock by reward"), csvBtn),
          stockStatus.box, stockTable),
        el("section", { class: "s-card" },
          el("div", { class: "s-card-hd" }, el("h2", { class: "s-card-title s-grow" }, "All codes"), codesLine,
            ui.button("Collect codes now", { size: "sm", icon: "gift", title: "Ask every login with a waiting code to read it now", onClick: collect })),
          el("div", { class: "s-card-bd" }, el("div", { class: "s-toolbar" }, search, stateChips, gameChips)),
          codesStatus.box, codesTable)));
      paint();
      load();
    },
    update() {
      if (Date.now() - lastLoadAt >= EVERY_MS) load();
      watchCollector();
      redraw();
    },
    badge() {
      const n = ((Chzzk.state || {}).totals || {}).codesFresh || 0;
      return n > 0 ? { text: fmt.num(n), tone: "ok" } : null;
    },
  });
})();
