/* CHZZK farm — Accounts tab: the login table (search, chips, bulk bar, row menu) and the
   per-login drawer (status, cookie lifetime, now, progress, codes, activity). The drawer
   follows the 5 s state poll; its codes and activity are fetched on open and on Refresh.
   A code is only ever shown through Chzzk.reveal, one row at a time. */
(function () {
  "use strict";
  const { el, ui, fmt } = Chzzk;

  const DEAD = "not_logged_in";
  const STATUS = { ok: ["Ready", "ok"], untested: ["Not checked", null], not_logged_in: ["Logged out", "error"] };
  const STEP = { claimed: ["Claimed", "ok"], reached: ["Reached", "ok"], passed: ["Passed", null], working: ["Working on it", "info"], not_started: ["Not started", null] };
  const CODE_STATE = { stored: ["Stored", "ok"], earned: ["Waiting for the code", "warn"], in_app: ["In-game", null] };
  const LEVEL = { error: ["error", "Error"], warn: ["warn", "Warning"] };
  const FLAT = { paddingLeft: "0", paddingRight: "0" };
  const plural = (n, w) => fmt.num(n) + " " + w + (n === 1 ? "" : "s");
  // ids and campaign numbers come back as strings from the table and from object keys
  const acct = (id) => (id == null ? null : Chzzk.accountById(id) || (Chzzk.state.accounts || []).find((a) => String(a.id) === String(id)) || null);
  const campOf = (no) => (no == null ? null : Chzzk.campaignByNo(no) || (Chzzk.campaigns || []).find((c) => String(c.campaignNo) === String(no)) || null);
  const gameOf = (no) => { const c = campOf(no); return c ? Chzzk.gameName(c.categoryId, c.categoryValue) : null; };
  const nameOf = (a) => (a && (a.nickname || a.userIdHash)) || "this login";
  const nowMs = () => Date.parse(Chzzk.state.now) || Date.now();
  const iso = (v) => (typeof v === "number" ? new Date(v).toISOString() : v);     // current.since is epoch ms
  const time = (v) => (v ? fmt.when(iso(v)) + " · " + fmt.ago(iso(v)) : "–");
  const put = (node, ...kids) => { node.textContent = ""; node.append(...kids.flat(Infinity).filter((k) => k != null && k !== false)); return node; };
  const muted = (t) => el("p", { class: "s-muted", style: { margin: "0" } }, t);
  const errNote = (t) => el("div", { class: "s-note is-error" }, ui.icon("alert"), el("span", t));
  const kv = (dt, dd) => [el("dt", dt), el("dd", dd)];
  function life(a) {                                   // [text, tone] for the cookie's lifetime
    const l = a.login || {};
    if (l.kind === "persistent") {
      if (!l.expiresAt) return ["stays signed in", null];
      return Date.parse(l.expiresAt) < nowMs() ? ["expired " + fmt.when(l.expiresAt), "error"] : ["until " + fmt.when(l.expiresAt), null];
    }
    return l.kind === "session" ? ["session only", "warn"] : ["–", null];
  }
  function openImport() {
    if (window.ChzzkImport) window.ChzzkImport.open();
    else Chzzk.toast("The import dialog did not load — reload the page", "error");
  }

  // ---- actions (shared by the row menu, the bulk bar and the drawer) ----------------
  function check(ids) {
    if (!ids.length) return null;                      // an empty list would mean "every login"
    return Chzzk.api.post("/accounts/check", { ids }).then((j) => {
      Chzzk.toast("Checking " + plural(j.total != null ? j.total : ids.length, "login") + " — status updates as each check finishes", "ok");
      return Chzzk.refresh();
    });
  }
  const checkAll = () => Chzzk.api.post("/accounts/check", {}).then((j) => {
    Chzzk.toast("Checking " + plural(j.total || 0, "login") + " (all not sold) — status updates as each check finishes", "ok");
    return Chzzk.refresh();
  });
  // There is no bulk update: one call per login, in turn, never a burst.
  async function updateEach(ids, patch, said) {
    let done = 0, why = "";
    for (const id of ids) {
      try { await Chzzk.api.post("/accounts/update", Object.assign({ id }, patch)); done++; } catch (e) { why = e.message; }
    }
    await Chzzk.refresh();
    if (done) Chzzk.toast(said(done), "ok");
    if (done < ids.length) throw new Error(plural(ids.length - done, "login") + " could not be changed: " + why);
  }
  function setPaused(ids, paused) {
    ids = ids.filter((id) => { const a = acct(id); return a && !!a.paused !== paused; });
    if (!ids.length) return null;
    return updateEach(ids, { paused }, (n) => (paused ? "Paused " + plural(n, "login") + " — watching stops, progress is kept" : "Resumed " + plural(n, "login")));
  }
  async function setSold(id, sold) {
    const a = acct(id);
    if (!a) return;
    if (sold && !(await Chzzk.confirm({ title: "Mark " + nameOf(a) + " as sold?", okLabel: "Mark sold",
      body: "A sold login stops watching and is no longer farmed. Its progress and codes are kept, and you can mark it not sold again." }))) return;
    await updateEach([a.id], { sold }, () => nameOf(a) + (sold ? " is marked sold — it is no longer farmed" : " is not sold any more — it farms again"));
  }
  function editNote(id) {
    const a = acct(id);
    if (!a) return;
    const area = el("textarea", { class: "s-textarea", rows: "4", maxlength: "500", "data-autofocus": true });
    area.value = a.note || "";
    Chzzk.modal({ title: "Note for " + nameOf(a), size: "sm", sticky: true,
      body: el("label", { class: "s-field" }, "Note", area, el("span", { class: "s-help" }, "Shown in the table and in this login's panel. Up to 500 characters; leave it empty to remove the note.")),
      actions: [{ label: "Cancel" }, { label: "Save note", tone: "primary",
        onClick: () => Chzzk.api.post("/accounts/update", { id: a.id, note: area.value.trim().slice(0, 500) }).then(Chzzk.refresh).then(() => { Chzzk.toast("Note saved", "ok"); }) }] });
  }
  async function remove(ids) {                         // resolves true when something was deleted
    const list = ids.map((id) => acct(id)).filter(Boolean);
    if (!list.length) return false;
    const one = list.length === 1, names = list.slice(0, 5).map(nameOf).join(", ") + (list.length > 5 ? " and " + (list.length - 5) + " more" : "");
    const yes = await Chzzk.confirm({ title: "Delete " + (one ? nameOf(list[0]) : plural(list.length, "login")) + "?", danger: true,
      okLabel: one ? "Delete login" : "Delete " + plural(list.length, "login"),
      body: "This removes " + names + " from the farm: " + (one ? "it stops watching and its" : "they stop watching and their") + " cookie and progress are forgotten. "
        + "Codes already earned are kept on the Codes tab. Nothing changes on CHZZK; to bring one back, import its cookie again." });
    if (!yes) return false;
    const j = await Chzzk.api.post("/accounts/delete", { ids: list.map((a) => a.id) });
    if (table) table.clearSelection();
    const n = j.deleted || 0, kept = typeof j.keptCodes === "number" && j.keptCodes > 0 ? " — " + plural(j.keptCodes, "code") + " kept" : "";
    Chzzk.toast("Deleted " + (n === list.length ? plural(n, "login") : fmt.num(n) + " of " + plural(list.length, "login")) + kept, "ok");
    // A sold login is kept on purpose: its buyer can read its codes, so the code shop must keep them off sale.
    if (j.keptSold) Chzzk.toast("Kept " + plural(j.keptSold, "sold login") + " — a sold login is never deleted, so its codes are never sold again", "info");
    await Chzzk.refresh();
    return true;
  }
  function menuItems(id) {
    const a = acct(id);
    if (!a) return [{ label: "This login was deleted", disabled: true }];
    return [
      { label: "Check now", icon: "refresh", onClick: () => check([a.id]) },
      a.paused ? { label: "Resume", icon: "play", onClick: () => setPaused([a.id], false) } : { label: "Pause", icon: "pause", onClick: () => setPaused([a.id], true) },
      a.sold ? { label: "Mark not sold", icon: "x", onClick: () => setSold(a.id, false) } : { label: "Mark sold", icon: "check", onClick: () => setSold(a.id, true) },
      { label: "Edit note", icon: "edit", onClick: () => editNote(a.id) },
      "-",
      { label: "Delete", icon: "trash", danger: true, onClick: () => remove([a.id]) },
    ];
  }

  // ---- table --------------------------------------------------------------------------
  function doing(a) {
    const c = a.current;
    if (!a.running) return el("span", { class: "s-muted" }, a.why || "Not running");
    if (!c) return el("span", { class: "s-muted" }, "Starting…");
    if (c.state !== "watching") return el("span", { class: "s-muted" }, (c.state === "waiting" ? "Waiting" : "Idle") + (c.note ? " — " + c.note : ""));
    const stuck = c.watched >= 6 && c.credited === 0;
    return el("span", { class: "s-stack is-tight" },
      el("span", { class: "s-row" }, ui.dot("ok", "Watching"), el("b", gameOf(c.campaignNo) || c.title || "Campaign #" + c.campaignNo), c.channelName ? el("span", { class: "s-muted" }, c.channelName) : null),
      el("span", { class: "s-small s-num" + (stuck ? " s-warn" : " s-muted"), title: "CHZZK credited " + (c.credited || 0) + " of the " + (c.watched || 0) + " minutes watched on this stream" },
        fmt.num(c.minutes || 0) + (c.needed ? "/" + fmt.num(c.needed) : "") + " min · credited " + fmt.num(c.credited || 0) + " of " + fmt.num(c.watched || 0)));
  }
  const columns = [
    { label: "Login", render: (a) => el("span", { class: "s-stack is-tight", title: a.note ? "Note: " + a.note : null },
      el("span", null, el("b", a.nickname || "No nickname"), " ", el("span", { class: "s-mono s-muted s-small" }, a.userIdHash || "")),
      a.note ? el("span", { class: "s-muted s-small s-trunc", style: { maxWidth: "220px" } }, a.note) : null) },
    { label: "Status", render: (a) => {
      const s = STATUS[a.status] || STATUS.untested;
      return el("span", { class: "s-row", title: (a.status !== "ok" && a.lastError) || null }, ui.badge(s[0], s[1]), a.paused && ui.badge("Paused", "warn"), a.sold && ui.badge("Sold"));
    } },
    { label: "Doing now", wrap: true, render: doing },
    { label: "Codes", align: "right", render: (a) => el("span", { class: "s-num" }, fmt.num(a.codes || 0)) },
    { label: "Cookie", hide: "sm", render: (a) => {
      const k = life(a);
      return el("span", { class: "s-stack is-tight" },
        el("span", { class: k[1] ? "s-" + k[1] : null, title: k[1] === "warn" ? "Ends when CHZZK ends the session. Sign in with 'Stay signed in' ticked and re-import for a longer-lasting login." : null }, k[0]),
        a.cookieAt ? el("span", { class: "s-muted s-small", title: fmt.when(a.cookieAt) }, "imported " + fmt.ago(a.cookieAt)) : null);
    } },
    { label: "", align: "right", render: (a) => ui.menu(ui.button("", { icon: "more", size: "sm", tone: "ghost", title: "Actions for " + nameOf(a) }), () => menuItems(a.id)) },
  ];
  const FILTERS = { all: () => true, watching: (a) => !!(a.running && a.current && a.current.state === "watching"),
    dead: (a) => a.status === DEAD && !a.sold, paused: (a) => !!a.paused, sold: (a) => !!a.sold };
  const CHIPS = [["all", "All"], ["watching", "Watching"], ["dead", "Logged out"], ["paused", "Paused"], ["sold", "Sold"]];

  let filter = "all", query = "", chips, search, table, bulk, emptyBox, emptyMode = "", chipSig = "";
  function rows() {
    const q = query.toLowerCase(), test = FILTERS[filter] || FILTERS.all;
    return Chzzk.state.accounts.filter((a) => test(a) && (!q || [a.nickname, a.userIdHash, a.note, a.id].join(" ").toLowerCase().includes(q)));
  }
  const picked = () => table.selected().map((k) => acct(k)).filter(Boolean).map((a) => a.id);
  function buildBulk() {
    const count = el("b");
    const pause = ui.button("Pause", { size: "sm", icon: "pause", onClick: () => setPaused(picked(), true) });
    const resume = ui.button("Resume", { size: "sm", icon: "play", onClick: () => setPaused(picked(), false) });
    const bar = el("div", { class: "s-note s-row", hidden: true, role: "region", "aria-label": "Actions for the selected logins" }, count,
      ui.button("Check", { size: "sm", icon: "refresh", onClick: () => check(picked()) }), pause, resume,
      ui.button("Delete", { size: "sm", tone: "danger", icon: "trash", onClick: () => remove(picked()) }),
      ui.button("Clear selection", { size: "sm", tone: "ghost", onClick: () => table.clearSelection() }));
    bar.sync = () => {
      const list = picked().map((id) => acct(id));
      bar.hidden = !list.length;
      count.textContent = plural(list.length, "login") + " selected";
      pause.hidden = !list.some((a) => !a.paused);
      resume.hidden = !list.some((a) => a.paused);
    };
    return bar;
  }
  function redraw() {
    const mode = Chzzk.state.accounts.length ? "match" : "none";
    if (mode !== emptyMode) {
      emptyMode = mode;
      put(emptyBox, mode === "none" ? ui.empty("No logins yet", "Import a Cookie-Editor export of chzzk.naver.com to add your first login.", { label: "Import logins", tone: "primary", icon: "upload", onClick: openImport })
        : ui.empty("No logins match", "Clear the search or pick another filter.", { label: "Show all logins", onClick: () => { query = ""; search.set(""); setFilter("all"); } }));
    }
    table.update(rows());
    bulk.sync();
  }
  function drawChips() {
    const n = {};
    CHIPS.forEach(([k]) => { n[k] = Chzzk.state.accounts.filter(FILTERS[k]).length; });
    const sig = filter + JSON.stringify(n);
    if (sig === chipSig) return;
    chipSig = sig;
    chips.setOptions(CHIPS.map(([value, label]) => ({ value, label, count: n[value] })));
  }
  function setFilter(v) { filter = FILTERS[v] ? v : "all"; chips.set(filter); drawChips(); redraw(); }

  // ---- drawer -------------------------------------------------------------------------
  let current = null;                                  // the one open drawer: { id, close }
  function rewardSteps(p, c) {
    const rewards = (c && c.rewards) || [], states = p.rewards || {};
    const nos = rewards.length ? rewards.map((r) => String(r.rewardNo)) : Object.keys(states);
    return el("ol", { class: "s-steps" }, nos.map((no) => {
      const r = rewards.find((x) => String(x.rewardNo) === no), st = STEP[states[no]] || STEP.not_started;
      return el("li", { class: "s-step" + (st[1] === "ok" ? " is-done" : st === STEP.working ? " is-now" : "") },
        el("b", r ? fmt.mins(r.minutes) : "#" + no), " " + ((r && r.title) || "Reward") + " — " + st[0]);
    }));
  }
  function codeRow(r) {
    const st = CODE_STATE[r.state] || [r.state || "–", null], cell = el("span");
    if (r.hasCode) cell.append(ui.button("Reveal", { size: "sm", icon: "eye", onClick: () => Chzzk.reveal(r.id, cell, { shop: r.shop }) }));
    const retry = r.state === "earned" ? [r.lastError, r.nextTryAt ? "next try " + fmt.until(r.nextTryAt) : null].filter(Boolean).join(" · ") : "";
    return el("li", { class: "s-list-item", style: FLAT },
      el("div", { class: "s-grow s-stack is-tight" },
        el("b", r.title || "Reward #" + r.rewardNo),
        el("span", { class: "s-muted s-small" }, [r.gameName || gameOf(r.campaignNo), r.campaignTitle, Chzzk.rewardType(r.rewardType)].filter(Boolean).join(" · ")),
        el("span", { class: "s-muted s-small" }, "Earned " + time(r.earnedAt) + (r.codeEndAt ? " · use by " + fmt.when(r.codeEndAt) : "")),
        retry && el("span", { class: "s-warn s-small" }, retry),
        r.revealedAt && el("span", { class: "s-muted s-small" }, "Revealed " + fmt.ago(r.revealedAt) + (r.revealedBy ? " by " + r.revealedBy : "")),
        r.shopWord && el("span", { class: r.shop === "in_unit" || r.shop === "sold" ? "s-strong s-small" : "s-muted s-small" }, "Code shop: " + r.shopWord)),
      ui.badge(st[0], st[1]), cell);
  }

  function openDrawer(rawId) {
    const a0 = acct(rawId);
    if (!a0) { Chzzk.toast("That login is no longer in the farm", "warn"); return; }
    const id = String(a0.id), realId = a0.id, get = () => acct(id);
    if (current) { if (current.id === id) return; current.close(); }
    let alive = true, handle = null, headSig = "", nowSig = "", codeSig = null, progOrder = "";
    const minute = () => Math.floor(Date.now() / 60000);

    // header: status, last error, cookie lifetime
    const pauseBtn = ui.button("Pause", { size: "sm", icon: "pause", onClick: () => setPaused([realId], true) });
    const resumeBtn = ui.button("Resume", { size: "sm", icon: "play", onClick: () => setPaused([realId], false) });
    const soldBtn = ui.button("Mark sold", { size: "sm", icon: "check", onClick: () => setSold(realId, true) });
    const unsoldBtn = ui.button("Mark not sold", { size: "sm", icon: "x", onClick: () => setSold(realId, false) });
    const actions = el("div", { class: "s-row" }, ui.button("Check now", { size: "sm", icon: "refresh", onClick: () => check([realId]) }), pauseBtn, resumeBtn, soldBtn, unsoldBtn,
      ui.button("Edit note", { size: "sm", icon: "edit", onClick: () => editNote(realId) }),
      ui.button("Delete", { size: "sm", tone: "danger", icon: "trash", onClick: () => remove([realId]).then((gone) => { if (gone) handle.close(); }) }),
      ui.button("Refresh", { size: "sm", tone: "ghost", icon: "refresh", title: "Reload this panel's codes and activity", onClick: () => Promise.all([loadCodes(), loadActivity(), Chzzk.refresh()]) }));
    const gone = el("div", { class: "s-note is-warn", hidden: true }, ui.icon("alert"), el("span", "This login is no longer in the farm — it was deleted."));
    const head = el("div", { class: "s-stack" });
    function paintHead(a) {
      const sig = JSON.stringify([a.nickname, a.status, a.lastError, a.paused, a.sold, a.note, a.cookieAt, a.lastCheckedAt, a.login, minute()]);
      if (sig === headSig) return;
      headSig = sig;
      handle.setTitle(nameOf(a));
      pauseBtn.hidden = !!a.paused; resumeBtn.hidden = !a.paused; soldBtn.hidden = !!a.sold; unsoldBtn.hidden = !a.sold;
      const s = STATUS[a.status] || STATUS.untested, l = a.login || {}, k = life(a), dead = a.status === DEAD;
      put(head,
        el("div", { class: "s-row" }, ui.badge(s[0], s[1]), a.paused && ui.badge("Paused", "warn"), a.sold && ui.badge("Sold"), el("span", { class: "s-mono s-muted s-small" }, a.userIdHash || "")),
        dead && el("div", { class: "s-note is-error" }, ui.icon("alert"),
          el("span", { class: "s-grow" }, "Logged out — re-import its cookie. It keeps its progress and codes." + (a.lastError ? " Last error: " + a.lastError : "")),
          ui.button("Import", { size: "sm", icon: "upload", onClick: openImport })),
        el("dl", { class: "s-kv" },
          kv("Cookie", el("span", { class: k[1] ? "s-" + k[1] : null }, l.kind === "persistent" ? "Stays signed in" : l.kind === "session" ? "Session only — ends when CHZZK ends the session" : "Unknown kind")),
          l.expiresAt && kv(Date.parse(l.expiresAt) < nowMs() ? "Expired" : "Expires", time(l.expiresAt)),
          kv("Imported", time(a.cookieAt)),
          kv("Cookie renewed", l.renewedAt ? time(l.renewedAt) + " — " + plural(l.renewals || 0, "time") + " since import" : "Not yet"),
          kv(a.status === "ok" ? "Last OK check" : "Last check", a.lastCheckedAt ? time(a.lastCheckedAt) : "Never"),
          dead && l.deadSince && kv("Logged out", time(l.deadSince) + (l.livedDays != null ? " — lived " + (l.livedDays >= 1 ? plural(Math.round(l.livedDays), "day") : "under a day") : "")),
          !dead && a.lastError && kv("Last error", el("span", { class: "s-warn" }, a.lastError)),
          kv("Note", a.note || el("span", { class: "s-muted" }, "No note"))),
        l.kind === "session" && el("p", { class: "s-help", style: { margin: "0" } }, "Tick 'Stay signed in' (로그인 상태 유지) when you sign in, then re-import — those cookies last much longer."));
    }

    // now: what its watch worker is doing
    const nowBox = el("div", { class: "s-stack is-tight" });
    function paintNow(a) {
      const c = a.current, sig = JSON.stringify([a.running, a.why, c, minute()]);
      if (sig === nowSig) return;
      nowSig = sig;
      if (!a.running || !c) { put(nowBox, muted(a.running ? "Starting…" : a.why || "Not running")); return; }
      const camp = campOf(c.campaignNo), watching = c.state === "watching", stuck = watching && c.watched >= 6 && c.credited === 0;
      const label = watching ? "Watching" : c.state === "waiting" ? "Waiting" : "Idle";
      put(nowBox,
        el("div", { class: "s-row" }, ui.dot(watching ? "ok" : null, label), el("b", label), c.note && el("span", { class: "s-muted" }, c.note)),
        c.campaignNo != null && el("dl", { class: "s-kv" },
          kv("Campaign", [gameOf(c.campaignNo) ? el("b", gameOf(c.campaignNo)) : null, " ", c.title || (camp && camp.title) || "#" + c.campaignNo]),
          kv("Channel", c.channelName || c.channelId || el("span", { class: "s-muted" }, "None yet")),
          kv("Since", time(c.since))),
        c.needed ? el("div", { class: "s-stack is-tight" }, el("span", { class: "s-small s-num" }, fmt.num(c.minutes || 0) + " of " + fmt.num(c.needed) + " min to the next reward"), ui.progress(Math.min(c.minutes || 0, c.needed), c.needed)) : null,
        watching && el("span", { class: "s-small " + (stuck ? "s-warn" : "s-muted") }, "credited " + fmt.num(c.credited || 0) + " of " + fmt.num(c.watched || 0) + " min on this stream" + (stuck ? " — CHZZK is not crediting this watch" : "")));
    }

    // progress: one keyed line per campaign, so a "Farm again" button survives the polls
    const progList = el("ul", { class: "s-list" }), progEmpty = muted("No campaign progress yet."), lines = new Map();
    async function farmAgain(no) {
      const c = campOf(no), what = c ? c.title : "campaign #" + no;
      if (!(await Chzzk.confirm({ title: "Farm " + what + " again?", okLabel: "Farm again",
        body: "This forgets that " + nameOf(get()) + " finished this campaign. The farm checks CHZZK again within 30 seconds and watches again if a reward is still left to earn." }))) return;
      await Chzzk.api.post("/accounts/reset-progress", { id: realId, campaignNo: c ? c.campaignNo : isFinite(no) ? Number(no) : no });
      Chzzk.toast(nameOf(get()) + " will farm " + what + " again — checked within 30 s", "ok");
      await Chzzk.refresh();
    }
    function progLine(no) {
      const game = el("span", { class: "s-muted s-small" }), title = el("b"), bar = ui.progress(0, 1), note = el("span", { class: "s-small s-num s-muted" }), steps = el("div");
      const again = ui.button("Farm again", { size: "sm", icon: "refresh", onClick: () => farmAgain(no) });
      const node = el("li", { class: "s-list-item", style: FLAT }, el("div", { class: "s-grow s-stack is-tight" }, el("span", null, game, " ", title), bar, note, steps), again);
      let sig = "";
      return { node, set(p, c) {
        const s = JSON.stringify([p, c && [c.title, c.maxMinutes, c.categoryId, c.rewards]]);
        if (s === sig) return;
        sig = s;
        const max = (c && c.maxMinutes) || p.next || p.minutes || 1;
        game.textContent = (c ? Chzzk.gameName(c.categoryId, c.categoryValue) : "Campaign") + " ·";
        title.textContent = c ? c.title : "#" + no;
        bar.set(Math.min(p.minutes || 0, max), max);
        note.textContent = fmt.num(p.minutes || 0) + " of " + fmt.num(max) + " min";
        put(steps, p.done ? ui.badge("Finished", "ok") : rewardSteps(p, c));
        again.hidden = !p.done;
      } };
    }
    function paintProgress(a) {
      const prog = a.progress || {}, nos = Object.keys(prog);
      nos.forEach((no) => { if (!lines.has(no)) lines.set(no, progLine(no)); lines.get(no).set(prog[no] || {}, campOf(no)); });
      lines.forEach((line, no) => { if (!(no in prog)) { line.node.remove(); lines.delete(no); } });
      nos.sort((x, y) => (prog[x].done ? 1 : 0) - (prog[y].done ? 1 : 0) || String(x).localeCompare(String(y), undefined, { numeric: true }));
      const order = nos.join(",");
      if (order !== progOrder) { progOrder = order; nos.forEach((no) => progList.append(lines.get(no).node)); }   // moved only when the order changes
      progEmpty.hidden = nos.length > 0; progList.hidden = !nos.length;
    }

    // codes: keyed rows so a revealed code is not wiped by a reload
    const codeList = el("ul", { class: "s-list" }), codeBox = el("div", { class: "s-stack is-tight" }, muted("Loading codes…")), codeNote = el("span", { class: "s-muted s-small" });
    let codeRows = new Map();
    let codesSeq = 0;
    function loadCodes() {
      const seq = ++codesSeq; // an older answer must not land on top of a newer list
      return Chzzk.api.get("/rewards?accountId=" + encodeURIComponent(realId)).then((j) => {
        if (!alive || seq !== codesSeq) return;
        const list = j.rewards || [], next = new Map();
        list.forEach((r) => { const k = [r.id, r.state, r.hasCode].join("|"); next.set(k, codeRows.get(k) || codeRow(r)); });
        codeRows = next;
        const stored = list.filter((r) => r.hasCode).length, waiting = list.filter((r) => r.state === "earned").length;
        codeNote.textContent = list.length ? plural(stored, "code") + " stored" + (waiting ? " · " + fmt.num(waiting) + " waiting" : "") : "";
        if (!list.length) { put(codeBox, muted("No rewards earned by this login yet.")); return; }
        const nodes = Array.from(next.values()), kids = codeList.children;
        if (nodes.length !== kids.length || nodes.some((n, i) => kids[i] !== n)) put(codeList, nodes);
        if (codeList.parentNode !== codeBox) put(codeBox, codeList);
      }, (e) => { if (alive && seq === codesSeq) put(codeBox, errNote("The codes could not be loaded: " + e.message)); });
    }
    const collectBtn = ui.button("Collect codes now", { size: "sm", icon: "download", onClick: () => Chzzk.api.post("/rewards/collect", { ids: [realId] }).then((j) => {
      Chzzk.toast(j.queued ? "Reading this login's codes from CHZZK — they show here once read" : "This login has nothing to collect right now", j.queued ? "ok" : "info");
      return Promise.all([Chzzk.refresh(), loadCodes()]);
    }) });
    function watchCodes(a) {                           // reload the list when a code is stored or a reward claimed
      const sig = JSON.stringify([a.codes, Object.values(a.progress || {}).map((p) => Object.values(p.rewards || {}).filter((s) => s === "claimed").length)]);
      if (codeSig !== null && sig !== codeSig) loadCodes();
      codeSig = sig;
    }

    // recent activity
    const actBox = el("div", null, muted("Loading activity…"));
    function loadActivity() {
      return Chzzk.api.get("/activity?accountId=" + encodeURIComponent(realId) + "&limit=20").then((j) => {
        if (!alive) return;
        const list = j.entries || [];
        put(actBox, list.length ? el("ul", { class: "s-list" }, list.map((e) => {
          const lv = LEVEL[e.level] || [null, "Info"], game = e.campaignNo != null ? gameOf(e.campaignNo) : null;
          return el("li", { class: "s-list-item", style: FLAT }, ui.dot(lv[0], lv[1]), e.kind && ui.badge(e.kind), game && el("span", { class: "s-muted s-small" }, game),
            el("span", { class: "s-grow" + (e.level === "error" ? " s-error" : "") }, e.msg || ""),
            el("span", { class: "s-muted s-small s-nowrap", title: fmt.when(e.at) }, fmt.ago(e.at)));
        })) : muted("Nothing has been recorded for this login yet."));
      }, (e) => { if (alive) put(actBox, errNote("The activity could not be loaded: " + e.message)); });
    }

    function paint() {
      if (!alive) return;
      const a = get();
      if (!a) { gone.hidden = false; actions.hidden = true; return; }
      paintHead(a); paintNow(a); paintProgress(a); watchCodes(a);
    }
    const section = (title, extras, content) => el("section", { class: "s-stack is-tight" }, el("div", { class: "s-spread" }, el("p", { class: "s-eyebrow" }, title), el("span", { class: "s-row" }, extras)), content);
    const hr = () => el("hr", { class: "s-divider" });
    const body = el("div", { class: "s-stack" }, gone, actions, head, hr(),
      section("Now", null, nowBox), hr(),
      section("Progress", null, el("div", null, progEmpty, progList)), hr(),
      section("Codes", [codeNote, collectBtn], codeBox), hr(),
      section("Recent activity", ui.button("All activity", { size: "sm", tone: "ghost", icon: "external", onClick: () => { handle.close(); Chzzk.go("activity", { accountId: id }); } }), actBox));
    const off = Chzzk.on("state", paint);
    const mine = { id, close: () => handle.close() };
    handle = Chzzk.drawer({ title: nameOf(a0), body, onClose: () => { alive = false; off(); if (current === mine) current = null; } });
    current = mine;
    paint();
    loadCodes(); loadActivity();
  }

  // ---- the tab --------------------------------------------------------------------------
  Chzzk.registerTab({
    id: "accounts", label: "Accounts",
    render(root) {
      search = ui.search({ placeholder: "Search nickname, hash or note", onInput: (q) => { query = q; redraw(); } });
      chips = ui.chips({ options: [], value: filter, onChange: (v) => { filter = v; drawChips(); redraw(); } });
      bulk = buildBulk();
      emptyBox = el("div");
      table = ui.table({ key: "id", select: true, columns, rows: [], empty: emptyBox, onRow: (a) => openDrawer(a.id), onSelect: () => bulk.sync() });
      root.append(el("div", { class: "s-toolbar" }, search, chips, el("span", { class: "s-grow" }),
        ui.button("Check all", { icon: "refresh", title: "Check every login that is not sold", onClick: checkAll }),
        ui.button("Import logins", { tone: "primary", icon: "upload", onClick: openImport })),
      el("div", { class: "s-stack" }, bulk, table));
    },
    update() { drawChips(); redraw(); },
    badge() { const n = (Chzzk.state.totals || {}).loggedOut; return n ? { text: n, tone: "error" } : null; },
  });

  Chzzk.on("tab", ({ id, params }) => {
    if (id !== "accounts" || !params) return;
    if (params.filter) setFilter(params.filter);
    if (params.id) openDrawer(params.id);
  });
})();
