/* SOOP farm — the create-bot wizard (4 steps, then POST /bots/create).
   Loaded by tab-bots.js; its only door is Soop._botsWizard.open(prefill), where
   prefill is the "bots" tab params: { create: "1" | "game" | "campaign", gameNo, dropsIdx }. */
(function () {
  "use strict";
  const { el, ui, fmt } = Soop;
  const STEPS = ["What to farm", "Which one", "Accounts", "Options"];
  const MODES = [
    { value: "game", icon: "gift", title: "A game", tag: "Recommended", text: "Keeps farming every guaranteed campaign of one game, including the ones that start later. It never finishes on its own." },
    { value: "campaign", icon: "clock", title: "One campaign", text: "Farms a single campaign and finishes when every account has earned it." },
    { value: "auto", icon: "bot", title: "Everything guaranteed", text: "Farms every guaranteed campaign of every game as each one goes live." },
  ];
  const TARGETS = [
    { value: "all", title: "All steps", text: "Keep watching until the last reward of each campaign is earned." },
    { value: "first", title: "First step only", text: "Stop each account as soon as it earns the first reward." },
  ];
  let openNow = false;

  const fill = (node, ...kids) => { node.textContent = ""; kids.flat(Infinity).forEach((k) => { if (k != null && k !== false) node.append(k); }); return node; };
  const count = (n, one) => fmt.num(n) + " " + one + (n === 1 ? "" : "s");
  // Why an account cannot join a new bot ("" = it can). The server enforces the same three rules.
  const blocked = (a) => (a.sold ? "Sold" : a.status === "not_logged_in" ? "Logged out — re-import the cookie"
    : a.botId ? 'Already in the bot "' + ((Soop.botById(a.botId) || {}).name || "another bot") + '"' : "");
  const freeAccounts = () => (Soop.state.accounts || []).filter((a) => !blocked(a));
  const rewards = (c) => ((c.items || []).length ? c.items.map((i) => fmt.mins(i.minutes) + " " + i.name) : (c.steps || []).map(fmt.mins)).join(" · ");
  const liveFirst = (a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0) || new Date(a.startAt || 0) - new Date(b.startAt || 0);
  const listed = (c) => c.live || c.filter === "progress" || c.filter === "scheduled";
  // A group of selectable cards; the choice is marked in place so focus and scroll stay put.
  function picks(list, value, onChange, cls) {
    const box = el("div", { class: cls || "s-stack is-tight", style: { padding: "2px" } });   // room for the focus ring inside a scroll box
    list.forEach((o) => box.append(el("button", { type: "button", class: "s-pick" + (o.value === value ? " is-on" : ""), "aria-pressed": String(o.value === value), onClick: (e) => {
      Array.from(box.children).forEach((b) => { b.classList.toggle("is-on", b === e.currentTarget); b.setAttribute("aria-pressed", String(b === e.currentTarget)); });
      onChange(o.value);
    } }, o.node)));
    return box;
  }
  const words = (title, text, tag) => el("span", { class: "s-stack is-tight s-grow" }, el("span", { class: "s-row" }, el("b", title), tag), el("span", { class: "s-muted s-small" }, text));
  function campaignLine(c) {
    const state = c.live ? ui.badge("Live", "ok") : c.filter === "scheduled" ? ui.badge(c.startAt ? "Starts " + fmt.until(c.startAt) : "Upcoming", "info") : ui.badge("Not live");
    return [c.image ? el("img", { class: "s-thumb", src: c.image, alt: "", loading: "lazy" }) : null,
      words(c.title, (c.gameName || Soop.gameName(c.gameNo)) + " · " + (rewards(c) || "no watch-time rewards"),
        [state, c.guaranteed ? null : ui.badge("Not guaranteed", "warn"), c.needsLink ? ui.badge("Needs a linked game account") : null])];
  }

  function open(prefill) {
    if (openNow) return;
    prefill = prefill || {};
    const w = { step: 1, mode: "game", gameNo: null, dropsIdx: null, how: "all", firstN: 5, picked: new Set(), target: "all", codesOnly: false, name: "", q: "", sync: null, ids: [] };
    if (prefill.create === "campaign" && prefill.dropsIdx) { w.mode = "campaign"; w.dropsIdx = String(prefill.dropsIdx); w.step = Soop.campaignById(w.dropsIdx) ? 3 : 2; }
    else if (prefill.create === "game" && prefill.gameNo) { w.mode = "game"; w.gameNo = String(prefill.gameNo); w.step = 3; }

    const body = el("div", { class: "s-stack" }), error = el("div", { class: "s-note is-error", role: "alert", hidden: true });
    const off = Soop.on("state", () => { if (w.step === 3 && w.sync) w.sync(); });
    const m = Soop.modal({ title: "New bot", size: "lg", sticky: true, body, onClose: () => { openNow = false; off(); } });
    openNow = true;

    const say = (msg) => { fill(error, ui.icon("alert"), el("span", msg || "")); error.hidden = !msg; if (msg) error.scrollIntoView({ block: "nearest" }); };
    const campaign = () => Soop.campaignById(w.dropsIdx);
    const autoName = () => (w.mode === "campaign" ? (campaign() || {}).title || "Campaign " + w.dropsIdx : w.mode === "game" ? Soop.gameName(w.gameNo) : "Everything guaranteed");
    const farms = () => (w.mode === "campaign" ? "One campaign: " + autoName() : w.mode === "game" ? autoName() + " — every guaranteed campaign, now and later" : "Every guaranteed campaign of every game");
    function chosen() {               // step 3 is live: resolved against the latest state every time it is asked
      const free = freeAccounts().map((a) => a.id);
      return w.how === "all" ? free : w.how === "first" ? free.slice(0, Math.max(0, w.firstN)) : free.filter((id) => w.picked.has(id));
    }

    // ----- step 1: what to farm
    const stepMode = () => picks(MODES.map((o) => ({ value: o.value, node: [ui.icon(o.icon, 20), words(o.title, o.text, o.tag ? ui.badge(o.tag, "ok") : null)] })), w.mode, (v) => { w.mode = v; });

    // ----- step 2: which game or campaign (live first)
    function stepWhich() {
      const list = el("div"), detail = el("div"), q = () => w.q.toLowerCase();
      const hit = (...texts) => texts.join(" ").toLowerCase().includes(q());
      const none = (what) => ui.empty(Soop.campaigns.length ? "No " + what + " matches" : "No campaigns known yet",
        Soop.campaigns.length ? "Try another search." : (Soop.scan && Soop.scan.error) || "Import an account first, then refresh the campaign list.",
        Soop.campaigns.length ? null : { label: "Refresh campaigns", icon: "refresh", onClick: () => Soop.refreshCampaigns(true).then(draw) });
      const readOnly = (rows) => el("ul", { class: "s-list s-scroll" }, rows.map((c) => el("li", { class: "s-list-item" }, campaignLine(c))));
      function drawDetail() {
        const c = campaign();
        if (w.mode === "campaign" && c) {
          fill(detail, el("div", { class: "s-stack is-tight" }, el("p", { class: "s-eyebrow" }, "Reward steps of " + c.title),
            el("ol", { class: "s-steps" }, (c.items || []).map((i) => el("li", { class: "s-step" }, el("b", fmt.mins(i.minutes)), i.name))),
            c.endAt ? el("span", { class: "s-help" }, "Ends " + fmt.when(c.endAt) + " (" + fmt.until(c.endAt) + ")") : null));
        } else if (w.mode === "game" && w.gameNo) {
          const rows = Soop.campaigns.filter((c2) => String(c2.gameNo) === w.gameNo && c2.guaranteed && listed(c2)).sort(liveFirst);
          fill(detail, el("div", { class: "s-stack is-tight" }, el("p", { class: "s-eyebrow" }, "Guaranteed campaigns of " + Soop.gameName(w.gameNo)),
            rows.length ? readOnly(rows) : el("span", { class: "s-help" }, "None listed right now — the bot waits and starts as soon as one goes live.")));
        } else fill(detail);
      }
      function draw() {
        let rows;
        if (w.mode === "game") {
          rows = Soop.games.filter((g) => hit(g.name)).sort((a, b) => b.live - a.live || b.guaranteed - a.guaranteed || String(a.name).localeCompare(String(b.name)));
          fill(list, rows.length ? picks(rows.map((g) => ({ value: String(g.gameNo), node: [ui.icon("gift", 20), words(g.name, count(g.guaranteed, "guaranteed campaign") + " · " + count(g.campaigns, "campaign") + " in all",
            g.live ? ui.badge(g.live + " live now", "ok") : ui.badge("Nothing live"))] })), w.gameNo, (v) => { w.gameNo = v; say(""); drawDetail(); }, "s-stack is-tight s-scroll") : none("game"));
        } else {
          const want = w.mode === "auto" ? (c) => c.guaranteed && listed(c) : (c) => (listed(c) || String(c.dropsIdx) === w.dropsIdx);
          rows = Soop.campaigns.filter((c) => (c.steps || []).length && want(c) && hit(c.title, c.titleRaw, c.gameName)).sort(liveFirst);
          if (!rows.length) fill(list, none("campaign"));
          else if (w.mode === "auto") fill(list, readOnly(rows));
          else fill(list, picks(rows.map((c) => ({ value: String(c.dropsIdx), node: campaignLine(c) })), w.dropsIdx, (v) => { w.dropsIdx = v; say(""); drawDetail(); }, "s-stack is-tight s-scroll"));
        }
        drawDetail();
      }
      const search = ui.search({ placeholder: w.mode === "game" ? "Search games" : "Search campaigns", value: w.q, onInput: (v) => { w.q = v; draw(); } });
      search.input.setAttribute("data-autofocus", "");
      search.style.flex = "1 1 240px";               // full width, inside a row: a bare s-search in a column grows tall on phones
      draw();
      return el("div", { class: "s-stack" }, w.mode === "auto" ? el("div", { class: "s-note" }, ui.icon("info"),
        el("span", "Nothing to pick: this bot farms every guaranteed campaign below, and any that appear later.")) : null, el("div", { class: "s-row" }, search), list, detail);
    }

    // ----- step 3: accounts (free ones are selectable; the rest are shown greyed with the reason)
    function stepAccounts() {
      const list = el("ul", { class: "s-list s-scroll" }), total = el("b"), boxes = new Map(), note = el("div");
      const howMany = el("input", { class: "s-input", type: "number", min: "1", value: w.firstN, style: { width: "92px" }, "aria-label": "How many accounts",
        onInput: () => { w.firstN = parseInt(howMany.value, 10) || 0; w.sync(); } });
      const chips = ui.chips({ value: w.how, options: [], onChange: (v) => { if (v === "pick") w.picked = new Set(chosen()); w.how = v; w.sync(); } });
      const tick = (id, on) => {
        if (w.how !== "pick") { w.picked = new Set(chosen()); w.how = "pick"; chips.set("pick"); }
        if (on) w.picked.add(id); else w.picked.delete(id);
        w.sync();
      };
      let shape = null, freeCount = -1;
      w.sync = () => {
        const all = (Soop.state.accounts || []).slice().sort((a, b) => (blocked(a) ? 1 : 0) - (blocked(b) ? 1 : 0)), free = all.filter((a) => !blocked(a)), on = new Set(chosen());
        if (free.length !== freeCount) {
          freeCount = free.length;
          chips.setOptions([{ value: "all", label: "All free accounts", count: free.length }, { value: "first", label: "First N free" }, { value: "pick", label: "Tick from the list" }]);
          fill(note, free.length ? null : el("div", { class: "s-note is-warn" }, ui.icon("alert"), el("span", { class: "s-grow" }, all.length ? "No account is free: each one is sold, logged out or already in a running bot." : "There are no accounts yet."),
            ui.button("Import accounts", { size: "sm", icon: "upload", onClick: () => { m.close(); Soop.go("accounts", { import: "1" }); } })));
        }
        const next = all.map((a) => a.id + "\n" + blocked(a)).join("\n");
        if (next !== shape) {           // rebuilt only when an account appears, leaves or changes availability
          const top = list.scrollTop;
          shape = next; boxes.clear();
          fill(list, all.map((a) => {
            const why = blocked(a), box = el("input", { type: "checkbox", disabled: !!why, onChange: () => tick(a.id, box.checked) });
            if (!why) boxes.set(a.id, box);
            return el("li", { class: "s-list-item" }, el("label", { class: "s-check s-grow" + (why ? " s-muted" : "") }, box, el("span", { class: "s-mono" }, a.id),
              a.nick && a.nick !== a.id ? el("span", { class: "s-muted s-small" }, a.nick) : null), why ? el("span", { class: "s-muted s-small", style: { textAlign: "right" } }, why) : null);
          }));
          list.scrollTop = top;
        }
        boxes.forEach((box, id) => { box.checked = on.has(id); });
        howMany.hidden = w.how !== "first";
        total.textContent = count(on.size, "account") + " will join this bot";
        if (on.size) say("");
      };
      w.sync();
      return el("div", { class: "s-stack" }, note, el("div", { class: "s-row" }, chips, howMany), el("div", { class: "s-row" }, total,
        el("span", { class: "s-muted s-small" }, "Sold, logged-out and busy accounts are greyed out.")), list);
    }

    // ----- step 4: options and the summary
    function stepOptions() {
      const sum = el("dl", { class: "s-kv" }), c = campaign();
      const drawSum = () => {
        const ids = w.ids;
        fill(sum, [["Farms", farms()], ["Accounts", count(ids.length, "account") + ": " + ids.slice(0, 6).join(", ") + (ids.length > 6 ? " and " + (ids.length - 6) + " more" : "")],
          ["Target", w.target === "first" ? "First step only" : "All steps"],
          ["Rewards", w.mode === "campaign" ? (c && c.needsLink ? "Need a linked game account" : "Arrive as codes") : w.codesOnly ? "Codes only — skips campaigns that need a linked game account" : "All guaranteed campaigns, linked-account ones too"],
          ["Name", w.name.trim() || autoName()]].map((r) => [el("dt", r[0]), el("dd", r[1])]));
      };
      const name = el("input", { class: "s-input", value: w.name, maxlength: "120", placeholder: autoName(), onInput: () => { w.name = name.value; drawSum(); } });
      drawSum();
      return el("div", { class: "s-stack" },
        el("div", { class: "s-stack is-tight" }, el("p", { class: "s-eyebrow" }, "Target"),
          picks(TARGETS.map((o) => ({ value: o.value, node: words(o.title, o.text) })), w.target, (v) => { w.target = v; drawSum(); })),
        w.mode === "campaign" ? (c && c.needsLink ? el("div", { class: "s-note is-warn" }, ui.icon("alert"), el("span", "This campaign's rewards go to a linked game account, not to a code.")) : null)
          : el("div", { class: "s-stack is-tight" }, el("label", { class: "s-check" }, el("input", { type: "checkbox", checked: w.codesOnly, onChange: (e) => { w.codesOnly = e.target.checked; drawSum(); } }), el("b", "Codes only")),
            el("span", { class: "s-help" }, "Skips campaigns whose rewards need a linked game account, so every drop this bot earns is a code.")),
        el("label", { class: "s-field" }, "Bot name (optional)", name, el("span", { class: "s-help" }, "Left empty, the bot is named after what it farms.")),
        el("div", { class: "s-card" }, el("div", { class: "s-card-bd s-stack is-tight" }, el("p", { class: "s-eyebrow" }, "Summary — check before you create"), sum)));
    }

    function next() {
      const missing = w.step === 2 && w.mode === "game" && !w.gameNo ? "Pick a game to carry on"
        : w.step === 2 && w.mode === "campaign" && !campaign() ? "Pick a campaign to carry on"
        : w.step === 3 && !chosen().length ? "Pick at least one free account" : "";
      if (missing) { say(missing); return false; }
      if (w.step === 3) w.ids = chosen();          // frozen here, so the summary lists exactly the accounts that are sent
      w.step++; show();
      return false;
    }
    function create() {
      const ids = w.ids;
      const payload = { name: w.name.trim(), mode: w.mode, accountIds: ids, target: w.target, codesOnly: w.mode !== "campaign" && w.codesOnly };
      if (w.mode === "campaign") payload.dropsIdx = w.dropsIdx;
      if (w.mode === "game") payload.gameNo = w.gameNo;
      return Soop.api.post("/bots/create", payload).then((j) => {
        Soop.toast('Bot "' + j.bot.name + '" started with ' + count(ids.length, "account"), "ok");
        return Soop.refresh().then(() => { m.close(); Soop.go("bots", { id: j.bot.id }); });
      }, (e) => { say(e.message); return false; });      // the server's own sentence, shown in place; the wizard stays open
    }
    function show() {
      w.sync = null;
      m.setTitle("New bot — step " + w.step + " of 4");
      fill(body, el("ol", { class: "s-steps" }, STEPS.map((label, i) => el("li", { class: "s-step" + (i + 1 < w.step ? " is-done" : i + 1 === w.step ? " is-now" : ""), "aria-current": i + 1 === w.step ? "step" : null }, el("b", String(i + 1)), label))),
        [stepMode, stepWhich, stepAccounts, stepOptions][w.step - 1](), error);
      say("");
      m.setActions([w.step > 1 ? { label: "Back", onClick: () => { w.step--; show(); return false; } } : { label: "Cancel" },
        w.step < 4 ? { label: "Next", tone: "primary", onClick: next } : { label: "Create bot", tone: "primary", icon: "play", onClick: create }]);
      m.body.scrollTop = 0;
      (body.querySelector("[data-autofocus]") || body.querySelector(".s-pick.is-on") || m.el).focus({ preventScroll: true });
    }
    show();
  }

  Soop._botsWizard = { open };
})();
