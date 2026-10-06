/* SOOP farm — Bots tab: one card per bot (what it farms, state, progress, its
   accounts) and the bot actions. The create wizard is bots-wizard.js, loaded
   from here; it answers on Soop._botsWizard.open(prefill). */
(function () {
  "use strict";
  const { el, ui, fmt } = Soop;
  const cards = new Map();            // bot id -> card; kept across polls so focus, scroll and expansion survive
  let summary, emptyBox, idleNote, activeBox, pastWrap, pastBtn, pastCount, pastBox, pastOpen = false, wizardLoad = null;

  const fill = (node, ...kids) => { node.textContent = ""; kids.flat(Infinity).forEach((k) => { if (k != null && k !== false) node.append(k); }); return node; };
  const count = (n, one, many) => fmt.num(n) + " " + (n === 1 ? one : many || one + "s");
  const turn = (btn, open) => { const i = btn.querySelector(".s-icon"); if (i) i.style.transform = open ? "rotate(90deg)" : ""; btn.setAttribute("aria-expanded", String(open)); };
  const post = (path, body, done) => Soop.api.post(path, body).then((j) => { if (done) Soop.toast(done, "ok"); return Soop.refresh().then(() => j); });

  // ---------- Words ----------------------------------------------------------
  const BOT = { running: ["Running", "ok"], waiting: ["Waiting", "info"], stopped: ["Stopped", null], finished: ["Finished", "ok"] };
  const SESSION = { starting: ["Joining", "info"], waiting: ["Waiting", null], backoff: ["Not earning", "warn"], stopping: ["Stopping", null], error: ["Error", "error"] };
  const targetWords = (t) => (t === "first" ? "first step only" : "all steps");
  function farms(bot) {
    if (bot.mode === "campaign") return "Campaign: " + (bot.title || "#" + bot.dropsIdx);
    if (bot.mode === "game") return "Game: " + (bot.gameName || Soop.gameName(bot.gameNo)) + " — every guaranteed campaign";
    return "Everything — every guaranteed campaign of every game";
  }
  // What one account is doing for this bot: { label, tone, detail, minutes, channel }.
  function accountLine(bot, id) {
    const a = Soop.accountById(id), s = a && a.botId === bot.id ? a.session : null;
    if (bot.doneIds.includes(id)) return { label: "Done", tone: "ok", detail: "Nothing left to earn for this bot" };
    if (!a) return { label: "Missing", tone: "error", detail: "This account was deleted — remove it from the bot" };
    if (a.sold) return { label: "Sold", tone: "error", detail: "Marked sold, so it no longer farms" };
    if (a.status === "not_logged_in") return { label: "Logged out", tone: "error", detail: "Logged out — re-import the cookie" };
    if (s) {
      const w = s.state !== "farming" ? SESSION[s.state] || [s.state, null] : s.credited === true ? ["Earning", "ok"] : s.credited === false ? ["Not earning", "warn"] : ["Watching", "info"];
      return { label: w[0], tone: w[1], detail: (s.detail || "") + (s.title && bot.mode !== "campaign" ? " · " + s.title : ""),
        minutes: s.goal != null ? fmt.mins(s.minutes) + " of " + fmt.mins(s.goal) : "", channel: s.channel ? "on " + s.channel : "" };
    }
    if (!bot.active) return { label: "Stopped", tone: null, detail: "Not farming while the bot is stopped" };
    return { label: "Waiting", tone: null, detail: "Starting shortly" };
  }
  function sentence(bot) {
    const c = bot.counts, ended = bot.endedAt ? " " + fmt.ago(bot.endedAt) : "";
    if (!c.total) return "No accounts — add some to start farming";
    if (bot.state === "running") return count(c.farming, "account") + " of " + fmt.num(c.total) + " earning watch time";
    if (bot.state === "finished") return "Every account reached its goal" + (ended ? " · finished" + ended : "");
    if (bot.state === "stopped") return "Not farming" + (ended ? " · stopped" + ended : "") + " — resume to carry on";
    const said = {};                  // waiting: the reason most of its accounts give
    let top = "";
    bot.accountIds.forEach((id) => {
      const a = Soop.accountById(id), d = a && a.botId === bot.id && a.session && a.session.detail;
      if (d) { said[d] = (said[d] || 0) + 1; if (!top || said[d] > said[top]) top = d; }
    });
    return top || "Waiting for its accounts to start";
  }

  // ---------- Actions --------------------------------------------------------
  const stopBot = (b) => post("/bots/stop", { id: b.id }, 'Stopped "' + b.name + '" — resume it any time');
  const resumeBot = (b) => post("/bots/resume", { id: b.id }, 'Resumed "' + b.name + '"');
  function renameBot(bot) {
    const save = () => {
      const name = input.value.trim();
      if (!name) { Soop.toast("Give the bot a name", "warn"); return false; }
      return name === bot.name ? null : post("/bots/update", { id: bot.id, name }, "Bot renamed");
    };
    const input = el("input", { class: "s-input", value: bot.name, maxlength: "120", "data-autofocus": true,
      onKeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); m.el.querySelector(".s-ov-ft .is-primary").click(); } } });
    const m = Soop.modal({ title: "Rename bot", size: "sm", sticky: true, body: el("label", { class: "s-field" }, "Bot name", input),
      actions: [{ label: "Cancel" }, { label: "Save name", tone: "primary", onClick: save }] });
  }
  function retargetBot(bot) {
    let target = bot.target === "first" ? "first" : "all";
    const box = el("div", { class: "s-stack is-tight" });
    [["all", "All steps", "Keep watching until the last reward of each campaign is earned."],
      ["first", "First step only", "Stop each account as soon as it earns the first reward."]].forEach((o) => {
      box.append(el("button", { type: "button", class: "s-pick" + (o[0] === target ? " is-on" : ""), "aria-pressed": String(o[0] === target), onClick: (e) => {
        target = o[0];
        Array.from(box.children).forEach((b) => { b.classList.toggle("is-on", b === e.currentTarget); b.setAttribute("aria-pressed", String(b === e.currentTarget)); });
      } }, el("span", { class: "s-stack is-tight" }, el("b", o[1]), el("span", { class: "s-muted s-small" }, o[2]))));
    });
    Soop.modal({ title: 'Change target of "' + bot.name + '"', sticky: true,
      body: el("div", { class: "s-stack" }, box, el("div", { class: "s-note" }, ui.icon("info"), el("span", "Changing the target restarts this bot's accounts. Watch time already earned is kept."))),
      actions: [{ label: "Cancel" }, { label: "Save target", tone: "primary", onClick: () => (target === bot.target ? null : post("/bots/update", { id: bot.id, target }, "Target is now " + targetWords(target))) }] });
  }
  function addAccounts(bot) {
    const free = Soop.state.accounts.filter((a) => !a.sold && a.status !== "not_logged_in" && !a.botId && !bot.accountIds.includes(a.id));
    const busy = Soop.state.accounts.length - free.length - bot.accountIds.length, boxes = [];
    const all = el("input", { type: "checkbox", onChange: () => boxes.forEach((b) => { b.checked = all.checked; }) });
    const list = el("ul", { class: "s-list s-scroll" }, free.map((a) => {
      const box = el("input", { type: "checkbox", value: a.id, onChange: () => { all.checked = boxes.every((b) => b.checked); } });
      boxes.push(box);
      return el("li", { class: "s-list-item" }, el("label", { class: "s-check s-grow" }, box, el("span", { class: "s-mono" }, a.id), a.nick && a.nick !== a.id ? el("span", { class: "s-muted s-small" }, a.nick) : null));
    }));
    const save = () => {
      const addIds = boxes.filter((b) => b.checked).map((b) => b.value);
      if (!addIds.length) { Soop.toast("Tick at least one account", "warn"); return false; }
      return post("/bots/update", { id: bot.id, addIds }, "Added " + count(addIds.length, "account") + ' to "' + bot.name + '"');
    };
    Soop.modal({ title: 'Add accounts to "' + bot.name + '"', sticky: true,
      body: free.length ? el("div", { class: "s-stack" }, el("label", { class: "s-check" }, all, el("b", "All " + count(free.length, "free account"))), list,
        busy > 0 ? el("span", { class: "s-help" }, count(busy, "other account") + " cannot join: sold, logged out or already in a running bot.") : null)
        : ui.empty("No free accounts", "Every account is sold, logged out or already in a running bot. Import more on the Accounts tab."),
      actions: [{ label: "Cancel" }, free.length ? { label: "Add accounts", tone: "primary", icon: "plus", onClick: save } : null] });
  }
  async function removeAccount(botId, id) {
    const bot = Soop.botById(botId);
    if (!bot || !(await Soop.confirm({ title: "Remove " + id + " from this bot?", danger: true, okLabel: "Remove account",
      body: 'It stops farming for "' + bot.name + '" right away and becomes free for another bot. Watch time already earned is kept.' }))) return null;
    return post("/bots/update", { id: botId, removeIds: [id] }, "Removed " + id);
  }
  async function deleteBot(bot) {
    if (!(await Soop.confirm({ title: 'Delete "' + bot.name + '"?', danger: true, okLabel: "Delete bot",
      body: (bot.active ? "It stops right away and its " : "Its ") + count(bot.counts.total, "account") + " become free. Watch time already earned is kept. This cannot be undone." }))) return null;
    return post("/bots/delete", { id: bot.id }, 'Deleted "' + bot.name + '"');
  }
  async function stopAll() {
    const n = Soop.state.totals.botsActive || 0;
    if (!(await Soop.confirm({ title: "Stop all bots?", danger: true, okLabel: "Stop all bots",
      body: "This stops " + count(n, "running bot") + " right away. Watch time already earned is kept, and each bot can be resumed later." }))) return null;
    return post("/bots/stop", { all: true }).then((j) => Soop.toast(j.stopped ? "Stopped " + count(j.stopped, "bot") : "No bots were running", "ok"));
  }
  function botMenu(id) {
    const b = Soop.botById(id);
    if (!b) return [];
    return [{ label: "Rename", icon: "edit", onClick: () => renameBot(b) },
      { label: "Change target (now " + targetWords(b.target) + ")", icon: "clock", onClick: () => retargetBot(b) },
      { label: "Add accounts", icon: "plus", onClick: () => addAccounts(b) },
      { label: "Show its activity", icon: "external", onClick: () => Soop.go("activity", { botId: id }) }, "-",
      { label: "Delete bot", icon: "trash", danger: true, onClick: () => deleteBot(b) }];
  }

  // ---------- Wizard -----------------------------------------------------------
  function loadWizard() {
    if (Soop._botsWizard) return Promise.resolve(Soop._botsWizard);
    return wizardLoad || (wizardLoad = new Promise((resolve, reject) => {
      const lost = () => { wizardLoad = null; reject(new Error("The new-bot wizard could not be loaded — reload the page")); };
      document.head.appendChild(el("script", { src: "/soop/bots-wizard.js", onLoad: () => (Soop._botsWizard ? resolve(Soop._botsWizard) : lost()), onError: lost }));
    }));
  }
  const openWizard = (prefill) => loadWizard().then((w) => { w.open(prefill || {}); });

  // ---------- Cards ------------------------------------------------------------
  function makeRow(card, id) {
    const r = { dot: el("span"), nick: el("span", { class: "s-muted s-small" }), label: el("b"), detail: el("div", { class: "s-muted s-small" }),
      mins: el("div", { class: "s-num s-nowrap" }), chan: el("div", { class: "s-muted s-small s-trunc" }), key: null };
    r.node = el("li", { class: "s-list-item" }, r.dot,
      el("div", { class: "s-grow" }, el("div", { class: "s-row" }, el("a", { class: "s-link s-mono", href: "#accounts?id=" + encodeURIComponent(id), title: "Open this account" }, id), r.nick, r.label), r.detail),
      el("div", { style: { textAlign: "right", maxWidth: "42%" } }, r.mins, r.chan),
      ui.button("", { icon: "x", size: "sm", tone: "ghost", title: "Remove " + id + " from this bot", onClick: () => removeAccount(card.id, id) }));
    return r;
  }
  function paintRows(card, bot) {
    const keep = new Set(bot.accountIds);
    card.rows.forEach((r, id) => { if (!keep.has(id)) { r.node.remove(); card.rows.delete(id); } });
    bot.accountIds.forEach((id, i) => {
      let r = card.rows.get(id);
      if (!r) card.rows.set(id, (r = makeRow(card, id)));
      if (card.list.children[i] !== r.node) card.list.insertBefore(r.node, card.list.children[i] || null);
      const a = Soop.accountById(id), v = accountLine(bot, id);
      if (r.key !== v.tone + v.label) { fill(r.dot, ui.dot(v.tone, v.label)); r.key = v.tone + v.label; }
      r.label.textContent = v.label; r.nick.textContent = a && a.nick && a.nick !== id ? a.nick : "";
      r.detail.textContent = v.detail; r.mins.textContent = v.minutes || ""; r.chan.textContent = v.channel || "";
    });
  }
  function makeCard(id) {
    const live = () => Soop.botById(id);
    const c = { id, open: false, rows: new Map(), state: null, n: {} };
    const tally = (key, tone) => el("span", { class: "s-row" }, ui.dot(tone), (c.n[key] = el("span")));
    c.title = el("h2", { class: "s-card-title s-grow s-trunc" });
    c.badge = el("span");
    c.stop = ui.button("Stop", { size: "sm", icon: "stop", onClick: () => live() && stopBot(live()) });
    c.resume = ui.button("Resume", { size: "sm", icon: "play", tone: "primary", onClick: () => live() && resumeBot(live()) });
    c.what = el("span", { class: "s-grow" }); c.say = el("span", { class: "s-muted" });
    c.bar = ui.progress(0, 0); c.barText = el("span", { class: "s-small s-muted s-num s-nowrap" });
    c.listNote = el("span", { class: "s-muted s-small" });
    c.listBtn = ui.button("Accounts", { size: "sm", tone: "ghost", icon: "chevron", onClick: () => { c.open = !c.open; if (live()) paintCard(c, live()); } });
    c.list = el("ul", { class: "s-list s-scroll", hidden: true });
    c.node = el("section", { class: "s-card", dataset: { bot: id } },
      el("div", { class: "s-card-hd" }, c.title, c.badge, c.stop, c.resume, ui.menu(ui.button("", { icon: "more", size: "sm", title: "More actions for this bot" }), () => botMenu(id))),
      el("div", { class: "s-card-bd s-stack is-tight" }, el("div", { class: "s-row" }, ui.icon("gift"), c.what), c.say,
        el("div", { class: "s-row" }, el("span", { class: "s-grow" }, c.bar), c.barText),
        el("div", { class: "s-row s-small" }, tally("farming", "ok"), tally("waiting", null), tally("done", "info"), tally("error", "error"))),
      el("div", { class: "s-card-ft" }, c.listBtn, c.listNote), c.list);
    return c;
  }
  function paintCard(c, bot) {
    const k = bot.counts, m = bot.minutes, words = BOT[bot.state] || [bot.state, null];
    c.node.className = "s-card" + (k.error ? " is-error" : bot.state === "running" ? " is-ok" : "");
    c.title.textContent = bot.name; c.title.title = bot.name;
    if (c.state !== bot.state) { fill(c.badge, ui.badge(words[0], words[1])); c.state = bot.state; }
    c.stop.hidden = !bot.active; c.resume.hidden = bot.active;
    c.what.textContent = farms(bot) + " · " + targetWords(bot.target) + (bot.codesOnly ? " · codes only" : "");
    c.say.textContent = sentence(bot);
    c.bar.set(m.sum, m.goalSum);
    c.barText.textContent = m.goalSum ? fmt.mins(m.sum) + " of " + fmt.mins(m.goalSum) + " · " + fmt.pct(m.sum, m.goalSum) : "No watch time to count yet";
    c.n.farming.textContent = fmt.num(k.farming) + " earning"; c.n.waiting.textContent = fmt.num(k.waiting) + " waiting";
    c.n.done.textContent = fmt.num(k.done) + " done"; c.n.error.textContent = count(k.error, "problem");
    c.n.error.className = k.error ? "s-error s-strong" : "";
    c.listNote.textContent = count(k.total, "account") + (c.open ? "" : " — show what each is doing");
    turn(c.listBtn, c.open);
    c.list.hidden = !c.open || !k.total;
    if (c.open) paintRows(c, bot);
  }
  function place(box, list) {
    list.forEach((bot, i) => {
      let c = cards.get(bot.id);
      if (!c) cards.set(bot.id, (c = makeCard(bot.id)));
      if (box.children[i] !== c.node) box.insertBefore(c.node, box.children[i] || null);
      paintCard(c, bot);
    });
  }
  function showBot(id) {
    const bot = Soop.botById(id), c = cards.get(String(id));
    if (!bot || !c) { Soop.toast("That bot no longer exists", "warn"); return; }
    if (!bot.active && !pastOpen) { pastOpen = true; update(); }
    c.node.scrollIntoView({ block: "center" });
    c.node.style.outline = "2px solid var(--accent)"; c.node.style.outlineOffset = "2px";
    setTimeout(() => { c.node.style.outline = ""; c.node.style.outlineOffset = ""; }, 2500);
  }

  // ---------- Tab --------------------------------------------------------------
  function render(root) {
    const newBot = () => ui.button("New bot", { tone: "primary", icon: "plus", onClick: () => openWizard() });
    summary = el("span", { class: "s-muted" });
    emptyBox = ui.empty("No bots yet", "A bot is a group of accounts that watches drop campaigns for you until every reward is earned.", newBot());
    idleNote = el("div", { class: "s-note" }, ui.icon("info"), el("span", "No bot is running. Resume one below or create a new bot."));
    activeBox = el("div", { class: "s-stack" });
    pastBox = el("div", { class: "s-stack" });
    pastBtn = ui.button("Past bots", { tone: "ghost", icon: "chevron", onClick: () => { pastOpen = !pastOpen; update(); } });
    pastCount = el("span", { class: "s-muted s-small" });
    pastWrap = el("div", { class: "s-stack" }, el("div", { class: "s-row", role: "heading", "aria-level": "2" }, pastBtn, pastCount), pastBox);
    root.append(el("div", { class: "s-stack" },
      el("div", { class: "s-spread" }, summary, el("div", { class: "s-row" }, newBot(),
        ui.menu(ui.button("", { icon: "more", title: "More bot actions" }), () => [{ label: Soop.state.totals.botsActive ? "Stop all bots" : "Stop all bots (none running)",
          icon: "stop", danger: true, disabled: !Soop.state.totals.botsActive, onClick: stopAll }]))),
      emptyBox, idleNote, activeBox, pastWrap));
  }
  function update() {
    const bots = Soop.state.bots || [], active = bots.filter((b) => b.active), past = bots.filter((b) => !b.active);
    const known = new Set(bots.map((b) => b.id));
    cards.forEach((c, id) => { if (!known.has(id)) { c.node.remove(); cards.delete(id); } });
    place(activeBox, active); place(pastBox, past);
    const earning = active.reduce((n, b) => n + b.counts.farming, 0);
    summary.textContent = bots.length ? count(active.length, "bot") + " running · " + count(earning, "account") + " earning watch time" : "";
    emptyBox.hidden = bots.length > 0; idleNote.hidden = !bots.length || active.length > 0;
    pastWrap.hidden = !past.length; pastBox.hidden = !pastOpen;
    pastCount.textContent = count(past.length, "bot") + " stopped or finished" + (pastOpen ? "" : " — show");
    turn(pastBtn, pastOpen);
  }

  Soop.on("tab", ({ id, params }) => {
    if (id !== "bots" || !(params.create || params.id)) return;
    history.replaceState(null, "", "#bots");        // so a reload does not reopen the wizard
    if (params.create) openWizard(params).catch(Soop.toast); else showBot(params.id);
  });
  Soop.registerTab({ id: "bots", label: "Bots", render, update, badge: () => Soop.state.totals.botsActive || null });
  loadWizard().catch(() => {});       // fetched up front; a failure is retried on the first click
})();
