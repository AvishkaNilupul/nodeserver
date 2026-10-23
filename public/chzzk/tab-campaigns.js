/* CHZZK farm — Campaigns tab: what CHZZK runs and what we farm. Toolbar, campaign cards, campaign drawer. */
(function () {
  "use strict";
  const { el, ui, fmt } = Chzzk;

  const CHZZK_URL = "https://chzzk.naver.com/";
  const SHOW = [["farmable", "Farmable", (c) => !!c.farmable], ["all", "All", () => true], ["not", "Not farmable", (c) => !c.farmable]];
  const F = { show: "farmable", q: "" };       // the filters
  const cards = new Map();                      // String(campaignNo) -> { node, c, sig, when, logins }
  let R = null, D = null;                       // the tab's nodes; the open campaign drawer

  // ---------- Reading a campaign -----------------------------------------------
  const keyOf = (c) => String(c.campaignNo);
  const ms = (iso) => Date.parse(iso) || 0;
  const all = () => Chzzk.campaigns || [];
  const find = (no) => Chzzk.campaignByNo(no) || all().find((c) => keyOf(c) === String(no)) || null;
  const game = (c) => Chzzk.gameName(c.categoryId, c.categoryValue);
  const titleOf = (c) => c.title || "Campaign #" + c.campaignNo;
  const rewardsOf = (c) => c.rewards || [];
  const loginsOf = (c) => c.logins || { eligible: 0, done: 0, watching: 0, list: [] };
  const setText = (node, text) => { if (node && node.textContent !== text) node.textContent = text; };
  const thumb = (src, lg) => el("img", { class: "s-thumb" + (lg ? " is-lg" : ""), src, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });

  // Who watches it right now, read from /state (5 s fresh) instead of the 60 s campaigns list.
  function watchers(no) {
    const s = Chzzk.state;
    return ((s && s.accounts) || []).filter((a) => a.current && a.current.state === "watching" && String(a.current.campaignNo) === no);
  }
  function watchingCount(c) {
    const s = Chzzk.state;
    return s && s.accounts ? watchers(keyOf(c)).length : loginsOf(c).watching || 0;
  }
  function whenText(c) {
    const now = Date.now(), s = ms(c.startAt), e = ms(c.endAt);
    if (!s && !e) return "CHZZK gave no dates";
    const dates = fmt.when(c.startAt) + " – " + fmt.when(c.endAt);
    if (s > now) return dates + " · starts " + fmt.until(c.startAt);
    if (!e) return dates;
    return dates + (e > now ? " · ends " + fmt.until(c.endAt) : " · ended " + fmt.ago(c.endAt));
  }
  function loginsText(c) {
    const l = loginsOf(c), w = watchingCount(c);
    if (!l.eligible && !w) return "No login can farm this";
    return fmt.num(l.done || 0) + " of " + fmt.num(l.eligible || 0) + " logins finished · " + fmt.num(w) + " watching";
  }
  const statusBadge = (c) => (c.farmable ? ui.badge("Farmable", "ok") : ui.badge(c.why || "Not farmable"));
  const gameLine = (c) => el("div", { class: "s-small" }, el("b", game(c)),
    c.categoryValue && c.categoryValue !== game(c) ? [" ", el("span", { class: "s-muted" }, c.categoryValue)] : null);
  function rewardFacts(r) {
    const left = r.remaining == null ? null
      : r.remaining > 0 ? el("span", { class: "s-muted" }, fmt.num(r.remaining) + " left") : el("span", { class: "s-warn" }, "none left");
    return el("div", { class: "s-row s-small" }, ui.badge(Chzzk.rewardType(r.rewardType)), left,
      el("span", { class: r.earned ? "s-ok" : "s-muted" }, "ours: " + fmt.num(r.earned || 0)),
      r.farmable === false ? el("span", { class: "s-muted" }, "not farmed") : null);
  }

  // ---------- Actions -----------------------------------------------------------
  // refreshCampaigns makes core run update(); the explicit redraw covers a list that came back unchanged.
  const reload = () => Chzzk.refreshCampaigns().then(() => { redraw(); if (D) D.refresh(true); });
  const rescan = () => Chzzk.api.post("/campaigns/refresh", {}).then((j) => {
    Chzzk.toast("CHZZK rescanned — " + fmt.num(j && j.found) + " found, " + fmt.num(j && j.updated) + " updated", "ok");
    return reload();
  });
  // Accepts "12345", "#12345" or a pasted CHZZK link that ends in the number.
  function parseNo(raw) {
    let s = String(raw || "").trim().replace(/^#\s*/, "");
    s = s.split(/[?#]/)[0].replace(/\/+$/, "");
    s = s.slice(s.lastIndexOf("/") + 1);
    return /^\d{1,20}$/.test(s) ? s : "";
  }
  function addCampaign() {
    const no = parseNo(R.addInput.value);
    if (!no) { Chzzk.toast("Type the campaign's number — the digits at the end of its CHZZK link", "warn"); R.addInput.focus(); return null; }
    return Chzzk.api.post("/campaigns/add", { campaignNo: no }).then((j) => {
      const c = j && j.campaign;
      R.addInput.value = "";
      Chzzk.toast("Added " + (c && c.title ? c.title : "campaign #" + no), "ok");
      return reload().then(() => openDrawer(c && c.campaignNo != null ? c.campaignNo : no, c));
    });
  }
  function setEnabled(c, on) {
    const send = () => Chzzk.api.post("/campaigns/enable", { campaignNo: c.campaignNo, enabled: on })
      .then(() => { Chzzk.toast(on ? "Campaign turned on" : "Campaign turned off here", "ok"); return reload(); });
    const n = watchers(keyOf(c)).length;
    if (on || !n) return send();
    return Chzzk.confirm({ title: "Stop farming this campaign?", danger: true, okLabel: "Disable",
      body: (n === 1 ? "1 login is" : n + " logins are") + " watching it and will stop. Progress and codes are kept." })
      .then((yes) => (yes ? send() : null));
  }
  function toggleButton(c, size) {
    const on = c.enabled !== false;
    return ui.button(on ? "Disable" : "Enable", { size, icon: on ? "pause" : "play", tone: on ? undefined : "primary",
      title: on ? "Stop farming this campaign here" : "Farm this campaign again", onClick: () => setEnabled(c, !on) });
  }

  // ---------- One card ----------------------------------------------------------
  // Only what the card shows: logins.list and scan times change every minute and would repaint it for nothing.
  const cardSig = (c) => JSON.stringify([c.title, c.categoryId, c.categoryValue, c.startAt, c.endAt, c.imageUrl, c.enabled,
    c.farmable, c.why, c.source, rewardsOf(c), loginsOf(c).eligible, loginsOf(c).done]);
  function step(c, r) {
    const e = loginsOf(c).eligible;
    return el("li", { class: "s-step" + (e > 0 && (r.earned || 0) >= e ? " is-done" : ""), title: r.title || null },
      el("b", r.minutes ? fmt.mins(r.minutes) : "No watch time"), r.title || "Reward", rewardFacts(r));
  }
  function paintCard(rec) {
    const c = rec.c, rs = rewardsOf(c);
    rec.when = el("span", { class: "s-grow" });
    rec.logins = el("span", { class: "s-grow" });
    rec.node.className = "s-card" + (c.farmable ? " is-ok" : "");
    rec.node.textContent = "";
    rec.node.append(
      el("div", { class: "s-card-hd" },
        c.imageUrl ? thumb(c.imageUrl) : null,
        el("div", { class: "s-grow" }, gameLine(c), el("h3", { class: "s-card-title", title: titleOf(c) }, titleOf(c))),
        statusBadge(c)),
      el("div", { class: "s-card-bd s-stack is-tight" },
        el("div", { class: "s-row s-small s-muted" }, ui.icon("clock", 14), rec.when),
        rs.length ? el("ol", { class: "s-steps", "aria-label": "Rewards" }, rs.map((r) => step(c, r)))
          : el("div", { class: "s-small s-muted" }, "CHZZK lists no rewards"),
        el("div", { class: "s-row s-small" }, ui.icon("user", 14), rec.logins)),
      el("div", { class: "s-card-ft" }, toggleButton(c, "sm"),
        el("span", { class: "s-grow s-small s-muted" }, c.source === "manual" ? "Added by hand" : ""),
        ui.button("Details", { size: "sm", tone: "ghost", icon: "chevron", onClick: () => openDrawer(c.campaignNo) })));
  }
  function newCard(k) {
    const rec = { sig: "" };
    rec.node = el("article", { class: "s-card", style: { cursor: "pointer" }, onClick: (e) => {
      if (e.target.closest("button, a, input, select, textarea, [data-stop]")) return;
      if (window.getSelection && String(window.getSelection())) return;      // selecting text, not opening
      openDrawer(rec.c.campaignNo);
    } });
    cards.set(k, rec);
    return rec;
  }

  // ---------- The list ----------------------------------------------------------
  function pass(c) {
    if (!F.q) return true;
    return [c.title, c.categoryValue, c.categoryId, game(c), "#" + c.campaignNo].join(" ").toLowerCase().includes(F.q.toLowerCase());
  }
  function setEmpty(key, build) {
    R.empty.hidden = !key;
    if (key === R.emptyKey) return;   // never rebuild a button the operator may be about to press
    R.emptyKey = key;
    R.empty.textContent = "";
    if (key) R.empty.append(build());
  }
  const showAll = () => { F.show = "all"; redraw(); };
  const clearSearch = () => { F.q = ""; R.search.set(""); redraw(); };
  function draw() {
    const list = all(), found = list.filter(pass);
    const opts = SHOW.map(([value, label, test]) => ({ value, label, count: found.filter(test).length }));
    // setOptions rebuilds the chip buttons, so only when a count or the selection moved.
    const chipSig = JSON.stringify([opts, F.show]);
    if (chipSig !== R.chipSig) { R.chipSig = chipSig; R.chips.set(F.show); R.chips.setOptions(opts); }

    const fits = (SHOW.find(([v]) => v === F.show) || SHOW[1])[2];
    const shown = found.filter(fits), keep = new Set();
    shown.forEach((c, i) => {     // server order: farmable first, then soonest end
      const k = keyOf(c), rec = cards.get(k) || newCard(k);
      rec.c = c;
      const sig = cardSig(c);
      if (sig !== rec.sig) { rec.sig = sig; paintCard(rec); }
      if (R.grid.children[i] !== rec.node) R.grid.insertBefore(rec.node, R.grid.children[i] || null);
      keep.add(k);
    });
    const alive = new Set(list.map(keyOf));
    cards.forEach((rec, k) => {
      if (!keep.has(k) && rec.node.parentNode) rec.node.remove();
      if (!alive.has(k)) cards.delete(k);
    });
    R.grid.hidden = !shown.length;

    if (shown.length) setEmpty("");
    else if (!list.length) setEmpty("none", () => ui.empty("No campaigns yet",
      "CHZZK is scanned for drops campaigns on its own. Rescan now, or add one by its number above.",
      { label: "Rescan CHZZK", icon: "refresh", onClick: rescan }));
    else if (!found.length) setEmpty("q", () => ui.empty("No campaign matches this search",
      "Search looks at campaign titles, game names and numbers.", { label: "Clear search", icon: "x", onClick: clearSearch }));
    else if (F.show === "farmable") setEmpty("farmable", () => ui.empty("Nothing to farm right now",
      "Campaigns are listed, but none can be farmed. Each card under All says why.", { label: "Show all", onClick: showAll }));
    else setEmpty("not", () => ui.empty("Every campaign here can be farmed", "", { label: "Show all", onClick: showAll }));
  }
  // Runs on every poll: text that ages, and who watches (from /state).
  function tick() {
    cards.forEach((rec) => {
      if (!rec.node.parentNode) return;
      setText(rec.when, whenText(rec.c));
      setText(rec.logins, loginsText(rec.c));
    });
  }
  function redraw() { if (R) { draw(); tick(); } }

  // ---------- Campaign drawer ---------------------------------------------------
  const section = (label, body) => el("div", { class: "s-stack is-tight" }, el("p", { class: "s-eyebrow" }, label), body);
  function rewardItem(r) {
    return el("li", { class: "s-list-item" }, r.imageUrl ? thumb(r.imageUrl) : ui.icon("gift"),
      el("div", { class: "s-grow s-stack is-tight" }, el("b", r.title || "Reward"),
        el("div", { class: "s-small s-muted" }, r.minutes ? "After " + fmt.mins(r.minutes) + " watched" : "No watch time needed"),
        rewardFacts(r)));
  }
  function paintDrawer(d) {
    const c = d.c, rs = rewardsOf(c);
    d.when = el("span", { class: "s-grow" });
    d.seen = el("dd");
    d.read = el("dd");
    d.top.textContent = "";
    d.top.append(
      el("div", { class: "s-row" }, c.imageUrl ? thumb(c.imageUrl, true) : null,
        el("div", { class: "s-grow s-stack is-tight" }, gameLine(c), el("div", { class: "s-row" }, statusBadge(c)))),
      el("div", { class: "s-row s-small s-muted" }, ui.icon("clock", 14), d.when),
      el("div", { class: "s-row" }, toggleButton(c),
        el("a", { class: "s-link", href: CHZZK_URL, target: "_blank", rel: "noopener noreferrer" }, ui.icon("external", 14), " Open CHZZK")),
      section("How to earn it", c.guide
        ? el("div", { class: "s-scroll s-small", style: { whiteSpace: "pre-wrap" } }, c.guide)
        : el("div", { class: "s-small s-muted" }, "CHZZK gave no guide text.")),
      section("Rewards", rs.length ? el("ul", { class: "s-list" }, rs.map(rewardItem)) : el("div", { class: "s-small s-muted" }, "CHZZK lists no rewards.")),
      section("Details", el("dl", { class: "s-kv" },
        el("dt", "Campaign"), el("dd", { class: "s-mono" }, "#" + c.campaignNo),
        el("dt", "Longest reward"), el("dd", fmt.mins(c.maxMinutes)),
        el("dt", "Linked game account"), el("dd", c.needsLink ? "Needed" : "Not needed"),
        el("dt", "Found by"), el("dd", c.source === "manual" ? "Added by hand" : "CHZZK scan"),
        el("dt", "Last seen on CHZZK"), d.seen,
        el("dt", "Details read"), d.read)));
  }
  // One login's line, with /state's numbers (5 s) laid over the campaigns list's (60 s).
  function merged(l, k) {
    const a = Chzzk.accountById(l.id), p = a && a.progress && a.progress[k];
    return {
      name: (a && a.nickname) || l.nickname || "Login",
      minutes: p && p.minutes != null ? p.minutes : l.minutes || 0,
      done: p ? !!p.done : !!l.done,
      watching: a ? !!(a.current && a.current.state === "watching" && String(a.current.campaignNo) === k) : !!l.watching,
    };
  }
  function loginRow() {
    const row = { name: el("b", { class: "s-trunc" }), prog: ui.progress(0, 1), tags: el("span", { class: "s-row" }), tagSig: null,
      mins: el("span", { class: "s-small s-muted s-num s-nowrap" }) };
    row.node = el("li", { class: "s-list-item" },
      el("div", { class: "s-grow s-stack is-tight" }, el("div", { class: "s-spread" }, row.name, row.mins), row.prog), row.tags);
    return row;
  }
  function setRow(row, m, max) {
    setText(row.name, m.name);
    if (max) row.prog.set(Math.min(m.minutes, max), max); else row.prog.set(m.done ? 1 : 0, 1);
    setText(row.mins, max ? fmt.num(m.minutes) + " of " + fmt.num(max) + " min" : fmt.num(m.minutes) + " min");
    const sig = (m.done ? "d" : "") + (m.watching ? "w" : "");
    if (sig === row.tagSig) return;
    row.tagSig = sig;
    row.tags.textContent = "";
    row.tags.append(m.done ? ui.badge("Finished", "ok") : null, m.watching ? ui.badge("Watching", "info") : null,
      sig ? null : ui.badge("Not watching"));
  }
  function tickDrawer(d) {
    const c = d.c, l = loginsOf(c), base = l.list || [], max = c.maxMinutes || 0, ids = new Set();
    setText(d.when, whenText(c));
    setText(d.seen, fmt.ago(c.lastSeenAt));
    setText(d.read, fmt.ago(c.refreshedAt));
    setText(d.sum, base.length ? loginsText(c) : "");
    base.forEach((one, i) => {
      const id = String(one.id);
      let row = d.rows.get(id);
      if (!row) d.rows.set(id, (row = loginRow()));
      setRow(row, merged(one, d.key), max);
      if (d.list.children[i] !== row.node) d.list.insertBefore(row.node, d.list.children[i] || null);
      ids.add(id);
    });
    d.rows.forEach((row, id) => { if (!ids.has(id)) { row.node.remove(); d.rows.delete(id); } });
    d.list.hidden = !base.length;
    d.none.hidden = !!base.length;
    setText(d.none, c.farmable ? "No login can farm this campaign." : "No login farms this — " + (c.why || "it can't be farmed") + ".");
  }
  function openDrawer(no, fallback) {
    const k = String(no);
    if (D && D.key === k) return;
    const c = find(k) || fallback || null;     // fallback: the /campaigns/add answer, before the list has it
    if (!c) { Chzzk.toast("Campaign #" + k + " is not in the list — rescan CHZZK or add it by number", "warn"); return; }
    if (D) D.handle.close();
    const d = { key: k, c, sig: "", rows: new Map(), top: el("div", { class: "s-stack" }),
      gone: el("div", { class: "s-note is-warn", hidden: true }, ui.icon("alert"), el("span", "Not in the latest campaign list — showing what was last read.")),
      sum: el("div", { class: "s-small s-muted" }), list: el("ul", { class: "s-list" }), none: el("div", { class: "s-small s-muted", hidden: true }) };
    d.refresh = (reread) => {
      if (reread) {
        const fresh = find(k);
        d.gone.hidden = !!fresh;
        if (fresh) d.c = fresh;
        // Scan times change every scan; tickDrawer shows them, so they must not rebuild the drawer.
        const sig = JSON.stringify(Object.assign({}, d.c, { logins: null, lastSeenAt: null, refreshedAt: null }));
        if (sig !== d.sig) { d.sig = sig; paintDrawer(d); if (d.handle) d.handle.setTitle(titleOf(d.c)); }
      }
      tickDrawer(d);
    };
    const offs = [Chzzk.on("state", () => d.refresh(false)), Chzzk.on("campaigns", () => d.refresh(true))];
    D = d;
    d.handle = Chzzk.drawer({ title: titleOf(c),
      body: el("div", { class: "s-stack" }, d.gone, d.top, section("Logins", el("div", { class: "s-stack is-tight" }, d.sum, d.list, d.none))),
      onClose: () => { offs.forEach((off) => off()); if (D === d) D = null; } });
    d.refresh(true);
  }

  Chzzk.on("tab", ({ id, params }) => {
    if (id !== "campaigns" || !params || !params.no) return;
    const no = String(params.no);
    if (find(no)) openDrawer(no);
    else Chzzk.refreshCampaigns().then(() => openDrawer(no));      // maybe newer than our last list
  });

  Chzzk.registerTab({
    id: "campaigns", label: "Campaigns",
    render(root) {
      R = { chipSig: "", emptyKey: null };
      R.chips = ui.chips({ options: [], value: F.show, onChange: (v) => { F.show = v; redraw(); } });
      R.search = ui.search({ placeholder: "Search title or game", onInput: (q) => { F.q = q; redraw(); } });
      R.addInput = el("input", { class: "s-input", type: "text", inputmode: "numeric", placeholder: "Campaign #", maxlength: "300",
        "aria-label": "Campaign number", style: { width: "9em" },
        onKeydown: (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); R.addBtn.click(); } } });
      R.addBtn = ui.button("Add campaign", { icon: "plus", title: "Add a campaign the scan missed, by its CHZZK number", onClick: addCampaign });
      R.empty = el("div", { class: "s-card", hidden: true });
      R.grid = el("div", { class: "s-grid" });
      root.append(el("div", { class: "s-stack" },
        el("div", { class: "s-toolbar" }, R.chips, R.search, el("div", { class: "s-row" }, R.addInput, R.addBtn),
          ui.button("Rescan CHZZK", { icon: "refresh", title: "Read CHZZK's campaign list again now", onClick: rescan })),
        R.empty, R.grid));
    },
    update() {
      draw();       // cheap when nothing changed: every card is compared by signature first
      tick();
    },
    badge() { return null; },
  });
})();
