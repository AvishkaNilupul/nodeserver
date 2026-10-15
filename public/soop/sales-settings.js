/* SOOP farm — Sales tab: the Settings and Activity sections (docs/code-shop/04-OPS.md;
   the settings are 01-DATA.md's DEFAULTS). Settings edits the shop's config and
   saves ONLY what changed (POST /config { patch }; a list is sent whole, because
   the server replaces lists), adopts a hand-made code listing, and runs one engine
   step now. Activity is the shop's event log (kept 30 days).
   Nothing here shows a code: config, events and step results carry counts and
   labels only, and every JSON shown is scrubbed of code-like fields anyway. */
(function () {
  "use strict";
  const S = window.SoopSales;
  if (!S) return;                     // tab-sales.js did not load: nothing to plug into
  const { el, ui, fmt } = Soop;

  // ---------- small helpers --------------------------------------------------------
  function fill(node, ...kids) {
    node.textContent = "";
    kids.flat(3).forEach((k) => { if (k != null && k !== false && k !== true) node.append(k instanceof Node ? k : String(k)); });
    return node;
  }
  // Rebuilds a node only when what it says changed, so a refresh never steals focus or hover.
  function put(node, sig, build) {
    sig = String(sig);
    if (node._sig === sig) return;
    node._sig = sig;
    fill(node, build());
  }
  const plural = (n, one, many) => fmt.num(n || 0) + " " + (Number(n) === 1 ? one : many || one + "s");
  const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  // Key-order independent JSON, for "did this change?" checks.
  function stable(x) {
    if (Array.isArray(x)) return "[" + x.map(stable).join(",") + "]";
    if (isObj(x)) return "{" + Object.keys(x).sort().map((k) => JSON.stringify(k) + ":" + stable(x[k])).join(",") + "}";
    return JSON.stringify(x === undefined ? null : x);
  }
  // The smallest patch that turns `a` into `b`: objects recurse, anything else (lists too) goes whole.
  function diff(a, b) {
    if (isObj(a) && isObj(b)) {
      const out = {};
      let any = false;
      Object.keys(b).forEach((k) => { const d = diff(a[k], b[k]); if (d !== undefined) { out[k] = d; any = true; } });
      return any ? out : undefined;
    }
    return stable(a) === stable(b) ? undefined : clone(b);
  }
  function countLeaves(p) { return isObj(p) ? Object.keys(p).reduce((n, k) => n + countLeaves(p[k]), 0) : 1; }
  function getPath(o, path) { return path.reduce((x, k) => (x == null ? undefined : x[k]), o); }
  function setPath(o, path, val) {
    let x = o;
    for (let i = 0; i < path.length - 1; i++) { if (!isObj(x[path[i]])) x[path[i]] = {}; x = x[path[i]]; }
    x[path[path.length - 1]] = val;
  }
  // Defence in depth: the server never sends a code here, and if a field that
  // could hold one ever turns up, or a code-shaped token sits in a message, it is hidden.
  const SECRET = /^(code|codes|password|passwd|secret|token|cookie|codeenc|plaintext)$/i;
  function scrub(x, depth) {
    if (depth > 8) return "…";
    if (Array.isArray(x)) return x.map((y) => scrub(y, depth + 1));
    if (isObj(x)) {
      const o = {};
      Object.keys(x).forEach((k) => {
        const y = x[k];
        o[k] = SECRET.test(k) && y != null && typeof y !== "number" && typeof y !== "boolean" ? "[hidden]" : scrub(y, depth + 1);
      });
      return o;
    }
    return x;
  }
  const CODE_LIKE = /\b[A-Z0-9]{4,6}(?:-[A-Z0-9]{4,6}){2,}\b/g;
  const mask = (s) => String(s == null ? "" : s).replace(CODE_LIKE, "[code hidden]");
  const json = (x, indent) => mask(JSON.stringify(scrub(x === undefined ? null : x, 0), null, indent || 0));
  function regexError(src) { try { new RegExp(src, "i"); return ""; } catch (e) { return "Not a valid pattern"; } }

  // ================================ Settings ================================
  // Bookkeeping the server writes itself; never part of a patch, never a reason to say "changed elsewhere".
  function strip(c) {
    const x = clone(isObj(c) ? c : {});
    if (isObj(x.digest)) delete x.digest.lastSentDay;
    if (isObj(x.farmPriority)) delete x.farmPriority.lastChangeAt;
    return x;
  }
  let baseline = {}, draft = {}, invalid = new Set();
  const v = {};                       // nodes built once in render()
  const patchOf = () => diff(strip(baseline), strip(draft));

  function changed() {
    if (!v.saveBar) return;
    const patch = patchOf(), n = patch === undefined ? 0 : countLeaves(patch), bad = invalid.size;
    v.saveBar.hidden = !n && !bad;
    v.saveInfo.textContent = (n ? plural(n, "unsaved change") : "No changes yet") + (bad ? " · " + plural(bad, "field") + " to fix first" : "");
    v.saveBtn.disabled = !n || !!bad;
  }

  // ---------- controls (each writes into `draft`; Save sends the difference) ----------
  function toggle(path, label, help) {
    const box = el("input", { type: "checkbox", checked: !!getPath(draft, path), onChange: () => { setPath(draft, path, box.checked); changed(); } });
    return el("div", { class: "s-stack is-tight" },
      el("label", { class: "s-check" }, box, el("span", { class: "s-strong" }, label)),
      help ? el("span", { class: "s-help s-sales-indent" }, help) : null);
  }
  function numError(raw, o) {
    const s = String(raw).trim(), n = Number(s), min = o.min == null ? 0 : o.min;
    if (s === "") return "Enter a number";
    if (!isFinite(n)) return "Not a number";
    if (n < min) return "At least " + min;
    if (o.max != null && n > o.max) return "At most " + o.max;
    if (o.int && !Number.isInteger(n)) return "Whole numbers only";
    return "";
  }
  // Writes to the draft only while the value is valid; an invalid field blocks Save.
  function numInput(key, value, o, write) {
    const msg = el("span", { class: "s-help s-error", hidden: true });
    const input = el("input", {
      class: "s-input" + (o.narrow ? " s-sales-num" : ""), type: "number", inputmode: o.int ? "numeric" : "decimal",
      min: String(o.min == null ? 0 : o.min), max: o.max == null ? null : String(o.max), step: String(o.step || (o.int ? 1 : "any")),
      value: value == null ? "" : String(value), "aria-label": o.aria || null,
      onInput: () => {
        const err = numError(input.value, o);
        input.setAttribute("aria-invalid", err ? "true" : "false");
        msg.textContent = err; msg.hidden = !err;
        if (err) invalid.add(key); else { invalid.delete(key); write(Number(input.value)); }
        changed();
      },
    });
    return { input, msg };
  }
  function number(path, label, help, o) {
    o = o || {};
    const n = numInput(path.join("."), getPath(draft, path), o, (x) => setPath(draft, path, x));
    return el("label", { class: "s-field" }, label, n.input, help ? el("span", { class: "s-help" }, help) : null, n.msg);
  }
  // A list edited as one entry per line.
  function lines(path, label, help, check) {
    const key = path.join("."), msg = el("span", { class: "s-help s-error", hidden: true });
    const ta = el("textarea", {
      class: "s-textarea s-sales-lines", rows: "4", spellcheck: "false", autocapitalize: "off", autocomplete: "off",
      value: (getPath(draft, path) || []).join("\n"),
      onInput: () => {
        const list = ta.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        const bad = check ? list.filter((s) => check(s)) : [];
        ta.setAttribute("aria-invalid", bad.length ? "true" : "false");
        msg.textContent = bad.length ? check(bad[0]) + ": " + bad[0] + (bad.length > 1 ? " (and " + (bad.length - 1) + " more)" : "") : "";
        msg.hidden = !bad.length;
        if (bad.length) invalid.add(key); else { invalid.delete(key); setPath(draft, path, list); }
        changed();
      },
    });
    return el("label", { class: "s-field" }, label, ta, help ? el("span", { class: "s-help" }, help) : null, msg);
  }
  function card(title, intro, ...body) {
    return el("section", { class: "s-card" },
      el("div", { class: "s-card-hd" }, el("h2", { class: "s-card-title s-grow" }, title)),
      el("div", { class: "s-card-bd s-stack" }, intro ? el("span", { class: "s-small s-muted" }, intro) : null, body));
  }

  // ---------- games: gameNo -> { sell, marketGame, displayName } ----------
  function farmLabel(no) { const n = Soop.gameName(no); return /^Game #|^Other$/.test(n) ? "" : n; }
  function gamesCard() {
    const list = el("ul", { class: "s-list" });
    const games = () => (isObj(draft.games) ? draft.games : (draft.games = {}));
    function check(no) {
      const g = games()[no] || {}, key = "games." + no;
      const err = g.sell && !String(g.marketGame || "").trim() ? "A game on sale needs its marketplace game" : "";
      if (err) invalid.add(key); else invalid.delete(key);
      return err;
    }
    function row(no) {
      const g = games()[no], farm = farmLabel(no), msg = el("span", { class: "s-help s-error", hidden: true });
      const recheck = () => { const err = check(no); msg.textContent = err; msg.hidden = !err; changed(); };
      const text = (field, label, help) => {
        const input = el("input", { class: "s-input", value: g[field] || "", maxlength: "80", spellcheck: "false",
          onInput: () => { games()[no][field] = input.value.trim(); recheck(); } });
        return el("label", { class: "s-field" }, label, input, el("span", { class: "s-help" }, help));
      };
      const sell = el("input", { type: "checkbox", checked: !!g.sell, onChange: () => { games()[no].sell = sell.checked; recheck(); } });
      const unsaved = !isObj(baseline.games) || !baseline.games[no];
      const li = el("li", { class: "s-list-item s-sales-game" },
        el("div", { class: "s-stack is-tight s-sales-game-id" }, el("b", "Game #" + no),
          el("span", { class: "s-small s-muted s-trunc", title: farm }, farm ? "Farm: " + farm : "Not seen on the farm yet")),
        text("displayName", "Name buyers see", "in titles and texts"),
        text("marketGame", "Marketplace game", "what the listing is filed under"),
        el("label", { class: "s-check" }, sell, "Sell its codes"),
        unsaved ? ui.button("", { icon: "trash", tone: "ghost", size: "sm", title: "Remove (not saved yet)",
          onClick: () => { delete games()[no]; invalid.delete("games." + no); draw(); changed(); } }) : null,
        msg);
      const err = check(no); msg.textContent = err; msg.hidden = !err;
      return li;
    }
    function draw() {
      Array.from(invalid).forEach((k) => { if (k.indexOf("games.") === 0) invalid.delete(k); });
      const nos = Object.keys(games()).sort((a, b) => Number(a) - Number(b));
      fill(list, nos.length ? nos.map(row) : el("li", { class: "s-list-item s-muted" }, "No games — the codes of a game that is not listed here are never sold."));
    }
    const dl = "s-sales-known-games";
    const hint = el("span", { class: "s-help" }, "Pick a game the farm knows, or type its game number.");
    const input = el("input", { class: "s-input s-sales-num", inputmode: "numeric", placeholder: "No.", list: dl, "aria-label": "Game number",
      onInput: () => {
        const no = input.value.trim();
        hint.textContent = !/^\d+$/.test(no) ? "Pick a game the farm knows, or type its game number."
          : games()[no] ? "Already in the list" : farmLabel(no) || "Not seen on the farm yet";
      },
      onKeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } } });
    function add() {
      const no = input.value.trim();
      if (!/^\d+$/.test(no)) { Soop.toast("A game number is digits only", "warn"); input.focus(); return; }
      if (games()[no]) { Soop.toast("Game #" + no + " is already in the list", "warn"); return; }
      const name = farmLabel(no);
      games()[no] = { sell: true, marketGame: name, displayName: name };
      input.value = ""; hint.textContent = "Added — check its names, then save.";
      draw(); changed();
    }
    draw();
    return el("section", { class: "s-card s-sales-wide" },
      el("div", { class: "s-card-hd" }, el("h2", { class: "s-card-title s-grow" }, "Games")),
      el("div", { class: "s-card-bd" }, el("span", { class: "s-small s-muted" },
        "Only the codes of games ticked here are drafted and sold. To stop selling a game, untick it — a saved game stays in the list.")),
      list,
      el("div", { class: "s-card-ft" },
        el("div", { class: "s-field" }, el("span", null, "Add a game"), el("div", { class: "s-row" }, input, ui.button("Add", { size: "sm", icon: "plus", onClick: add })), hint),
        el("datalist", { id: dl }, (Soop.games || []).filter((g) => g && g.gameNo).map((g) => el("option", { value: String(g.gameNo) }, g.name || "")))));
  }

  // ---------- pricing.clearanceSteps: [{ days, cutPct }] ----------
  function stepsEditor() {
    const path = ["pricing", "clearanceSteps"], box = el("div", { class: "s-stack is-tight" });
    const steps = () => (Array.isArray(getPath(draft, path)) ? getPath(draft, path) : []);
    function draw() {
      Array.from(invalid).forEach((k) => { if (k.indexOf("steps.") === 0) invalid.delete(k); });
      fill(box, steps().length ? steps().map(row) : el("span", { class: "s-small s-muted" }, "No steps — clearance never lowers a price."),
        el("div", null, ui.button("Add a step", { size: "sm", icon: "plus",
          onClick: () => { setPath(draft, path, clone(steps()).concat([{ days: 1, cutPct: 0 }])); draw(); changed(); } })));
    }
    function row(step, i) {
      const write = (field) => (x) => { const list = clone(steps()); list[i] = Object.assign({}, list[i], { [field]: x }); setPath(draft, path, list); };
      const days = numInput("steps." + i + ".days", step && step.days, { narrow: true, aria: "Days left" }, write("days"));
      const cut = numInput("steps." + i + ".cutPct", step && step.cutPct, { narrow: true, max: 90, aria: "Price cut, percent" }, write("cutPct"));
      return el("div", { class: "s-stack is-tight" },
        el("div", { class: "s-row" }, el("span", { class: "s-small" }, "With"), days.input, el("span", { class: "s-small" }, "days or less left, cut the price by"), cut.input, el("span", { class: "s-small" }, "%"),
          ui.button("", { icon: "trash", tone: "ghost", size: "sm", title: "Remove this step",
            onClick: () => { const list = clone(steps()); list.splice(i, 1); setPath(draft, path, list); draw(); changed(); } })),
        days.msg, cut.msg);
    }
    draw();
    return el("div", { class: "s-field" }, el("span", null, "Clearance steps"), box,
      el("span", { class: "s-help" }, "For products with clearance on: the step with the fewest days that still fits wins. 0 % keeps the price."));
  }

  // ---------- farmPriority.botIds, picked from the farm's bots ----------
  const MODE = { auto: "Auto", game: "One game", campaign: "One campaign" };
  function botPicker() {
    const path = ["farmPriority", "botIds"];
    const chosen = () => (Array.isArray(getPath(draft, path)) ? getPath(draft, path) : []).map(String);
    const bots = (Soop.state && Soop.state.bots) || [], known = bots.map((b) => String(b.id));
    const missing = chosen().filter((id) => known.indexOf(id) === -1);
    function pick(id, on) {
      let list = chosen().filter((x) => x !== id);
      if (on) list.push(id);
      const base = (getPath(baseline, path) || []).map(String);      // the same set as saved keeps the saved order (no false "change")
      if (list.length === base.length && list.every((x) => base.indexOf(x) !== -1)) list = base.slice();
      setPath(draft, path, list);
      changed();
    }
    const row = (id, label, bits, warn) => {
      const box = el("input", { type: "checkbox", checked: chosen().indexOf(id) !== -1, onChange: () => pick(id, box.checked) });
      return el("label", { class: "s-check" }, box, el("span", { class: "s-stack is-tight" },
        el("span", null, el("b", label), bits ? el("span", { class: "s-muted" }, " · " + bits) : null),
        warn ? el("span", { class: "s-small s-warn" }, warn) : null));
    };
    const rows = bots.map((b) => row(String(b.id), b.name || "Unnamed bot",
      [MODE[b.mode] || b.mode || "", b.active ? "running" : "stopped", b.priorityGameNo ? "priority now: " + Soop.gameName(b.priorityGameNo) : ""].filter(Boolean).join(" · "),
      !b.active ? "Stopped — skipped until it runs again" : b.mode !== "auto" ? "Not in Auto mode — skipped" : ""))
      .concat(missing.map((id) => row(id, "Bot no longer exists", id, "Untick it — a removed bot is skipped")));
    return el("div", { class: "s-field" }, el("span", null, "Bots it may re-point"),
      rows.length ? el("div", { class: "s-stack is-tight s-scroll" }, rows) : el("span", { class: "s-help" }, "No bots yet — create one on the Bots tab."));
  }

  function hourSelect(path) {
    const pad = (n) => (n < 10 ? "0" : "") + n;
    const local = (h) => { const d = new Date(); d.setUTCHours(h, 0, 0, 0); return pad(d.getHours()) + ":" + pad(d.getMinutes()); };
    const cur = Number(getPath(draft, path));
    const sel = el("select", { class: "s-select", onChange: () => { setPath(draft, path, Number(sel.value)); changed(); } },
      Array.from({ length: 24 }, (_, h) => el("option", { value: String(h), selected: cur === h }, pad(h) + ":00 UTC (" + local(h) + " your time)")));
    return el("label", { class: "s-field" }, "Send it after", sel, el("span", { class: "s-help" }, "At the first engine run after this hour, once a day."));
  }

  function buildForm() {
    invalid = new Set();
    fill(v.form, el("div", { class: "s-grid" },
      card("Automation", "What the shop does by itself. With every switch here off, nothing changes on a market without you.",
        toggle(["autoDraft"], "Write draft products from new codes", "Groups free codes into draft bundles for you to check."),
        toggle(["autoBuildUnits"], "Grow the stock of approved products", "New codes are packed into bundles of the products you approved or adopted."),
        toggle(["autoPublish"], "Publish ready drafts without asking me", "A draft with no problems and enough stock goes on sale by itself. Off: each draft waits for you."),
        toggle(["expiryGuard"], "Take stock off sale before its codes stop working", null),
        number(["expiryLeadHours"], "Hours before the use-by date", "Bundles leave the shelf this long before their earliest code stops working (0–720).", { max: 720 })),
      // GGSel has no switch here (docs/code-shop/05-REVIEW-FIXES.md, R1): the server refuses it.
      card("Markets", "Where approved products are published. The shop sells codes only on Eldorado; every other market is refused.",
        toggle(["markets", "eldorado"], "Eldorado", null),
        el("span", { class: "s-help" }, "GGSel is not used for codes yet: it never reports which code it sold.")),
      gamesCard(),
      card("When a campaign is ready to list", "A campaign's codes are drafted once any one of these is true.",
        el("div", { class: "s-sales-fields" },
          number(["ready", "graceHours"], "Hours after it ends", "so late codes still join"),
          number(["ready", "stallHours"], "Hours with no new code", "the farm stopped earning it"),
          number(["ready", "earlyListDays"], "Days before codes run out", "the earliest free code is this close to its use-by"))),
      card("Drafts", null,
        el("div", { class: "s-sales-fields" },
          number(["drafts", "minUnits"], "Smallest draft", "bundles that can be built now", { int: true }),
          number(["drafts", "maxPerGroup"], "Drafts per campaign", "different bundle sets", { int: true })),
        toggle(["drafts", "leftovers"], "Also draft leftover sets", "Codes that do not make a full set become a smaller bundle.")),
      card("Pricing", "Used only by products on automatic pricing. A fixed price is never changed.",
        stepsEditor(),
        el("div", { class: "s-sales-fields" },
          number(["pricing", "cooldownHours"], "Hours between changes", "per product"),
          number(["pricing", "undercutUsd"], "Undercut by (USD)", "below the cheapest same-set code seller", { step: 0.01 }))),
      card("Competitor scan", "Reads Eldorado's public offers for the same set of items.",
        toggle(["competitorScan", "enabled"], "Scan competitors", null),
        number(["competitorScan", "everyHours"], "Scan each product every (hours)", null),
        lines(["ownEldoradoUserIds"], "Our Eldorado seller ids", "One per line. Offers from these sellers never count as competitors.")),
      card("Buyer text guard", "A title, description, delivery text or label that matches any of these is refused before it is published.",
        lines(["sourceWords"], "Words buyers must never see", "One per line. Each line is a regular expression, matched ignoring case.", regexError)),
      card("Telegram", null,
        toggle(["claimAlert", "enabled"], "Warn me about farm rewards that will expire unclaimed", null),
        number(["claimAlert", "leadHours"], "Warn this many hours ahead", null),
        el("hr", { class: "s-divider" }),
        toggle(["digest", "enabled"], "Send a daily summary", null),
        hourSelect(["digest", "hourUtc"]),
        (v.lastSent = el("span", { class: "s-small s-muted" }))),
      card("Farm priority", "Every hour, the chosen bots' priority game becomes the code game that sold the most in the last 14 days. Only running bots in Auto mode are changed.",
        toggle(["farmPriority", "enabled"], "Point bots at the game that sells best", null),
        botPicker(),
        number(["farmPriority", "minHoursBetween"], "At least this many hours between changes", null),
        (v.lastChange = el("span", { class: "s-small s-muted" })))));
    paintInfo(S.state);
    changed();
  }
  function paintInfo(st) {
    const c = (st && st.config) || {};
    if (v.lastSent) v.lastSent.textContent = c.digest && c.digest.lastSentDay ? "Last sent for " + c.digest.lastSentDay + " (UTC)." : "Not sent yet.";
    if (v.lastChange) {
      const at = c.farmPriority && c.farmPriority.lastChangeAt;
      v.lastChange.textContent = at ? "Last changed a bot " + S.when(at) + " (" + fmt.ago(at) + ")." : "It has not changed a bot yet.";
    }
  }

  function discard() {
    baseline = clone((S.state && S.state.config) || baseline);
    draft = clone(baseline);
    v.err.hidden = true; v.drift.hidden = true;
    buildForm();
  }
  function save() {
    const patch = patchOf();
    if (patch === undefined) return null;
    if (invalid.size) { Soop.toast("Fix the marked fields first", "warn"); return null; }
    const risky = [];
    if (patch.autoPublish === true) risky.push("Auto-publish goes ON: a ready draft goes on sale by itself, without you.");
    if (patch.expiryGuard === false) risky.push("The expiry guard goes OFF: stock stays on sale until its codes stop working.");
    if (patch.farmPriority && patch.farmPriority.enabled === true) risky.push("Farm priority goes ON: the chosen bots' priority game changes by itself.");
    const ask = risky.length
      ? S.confirmAction(el("div", { class: "s-stack is-tight" }, risky.map((r) => el("span", null, r))), { title: "Save these settings?", okLabel: "Save settings" })
      : Promise.resolve(true);
    return ask.then((yes) => {
      if (!yes) return null;
      v.err.hidden = true;
      return S.api.post("/config", { patch }).then((j) => {
        const cfg = j && isObj(j.config) ? j.config : null;
        if (cfg && stable(strip(cfg)) !== stable(strip(draft))) { baseline = clone(cfg); draft = clone(cfg); buildForm(); }      // the server normalised something: show what it kept
        else baseline = clone(cfg || draft);
        v.drift.hidden = true;
        changed();
        Soop.toast("Settings saved", "ok");
        return S.refresh();
      }, (e) => {
        fill(v.err, ui.icon("alert"), el("div", { class: "s-stack is-tight s-grow" },
          el("b", e.status === 400 ? "Not saved — the server refused these settings" : "Not saved"),
          el("span", { class: "s-small" }, e.message)));
        v.err.hidden = false;
        Soop.toast("The settings were not saved: " + e.message, "error");
      });
    });
  }

  // ---------- adopt an existing hand-made code listing ----------
  let candSeq = 0;
  function unitsText(u) {
    u = u || {};
    return [u.available ? fmt.num(u.available) + " on the shelf" : "", u.fed ? fmt.num(u.fed) + " in a GGSel vault" : "", u.sold ? fmt.num(u.sold) + " sold" : ""].filter(Boolean).join(", ");
  }
  function reportView(j, applied, fallback) {
    j = j || {};
    const problems = (Array.isArray(j.problems) ? j.problems : []).map(String);
    if (!problems.length && j.ok === false) problems.push(String(j.message || fallback || "The server did not say why"));
    const ok = j.ok !== false && !problems.length, r = isObj(j.report) ? j.report : {};
    const count = (x) => (Array.isArray(x) ? x.length : Number(x) || 0);
    const slots = Array.isArray(r.slots) ? r.slots : [];
    const by = isObj(r.byStatus) ? Object.keys(r.byStatus).filter((k) => isFinite(Number(r.byStatus[k]))) : [];
    return el("div", { class: "s-note " + (ok ? "is-ok" : "is-error") }, ui.icon(ok ? "check" : "alert"),
      el("div", { class: "s-stack is-tight s-grow" },
        el("b", ok ? (applied ? "Adopted — it is a product now" : "It can be adopted") : applied ? "Not adopted — nothing was written" : "It cannot be adopted yet"),
        r.units != null || r.codes != null ? el("span", { class: "s-small" }, plural(count(r.units), "bundle") + " · " + plural(count(r.codes), "code")) : null,
        slots.length ? el("span", { class: "s-small" }, "Slots: " + slots.map((s, i) => (i + 1) + ") " + mask((s && s.label) || "?")).join("  ·  ")) : null,
        by.length ? el("div", { class: "s-row" }, by.map((k) => ui.badge(fmt.num(r.byStatus[k]) + " " + k))) : null,
        problems.length ? el("ul", { class: "s-sales-problems s-small" }, problems.slice(0, 20).map((p) => el("li", null, mask(p))),
          problems.length > 20 ? el("li", null, "+ " + (problems.length - 20) + " more") : null) : null));
  }
  function candidateRow(c) {
    const out = el("div", { class: "s-stack is-tight" }), title = c.title || "Untitled listing";
    const failed = (applied) => (e) => fill(out, reportView(e.body || { ok: false, problems: [e.message] }, applied, e.message));
    const check = () => S.api.post("/adopt", { offerId: c.offerId, apply: false }).then((j) => fill(out, reportView(j, false)), failed(false));
    const adopt = () => S.confirmAction("From now on the shop adds new codes to this listing as bundles (when growing stock is on), takes bundles off sale before their codes stop working and tracks its sales. Its price and texts stay as they are.",
      { title: "Adopt “" + title + "”?", okLabel: "Adopt listing" }).then((yes) => {
      if (!yes) return null;
      return S.api.post("/adopt", { offerId: c.offerId, apply: true }).then((j) => {
        fill(out, reportView(j, true));
        if (j.ok === false) return null;
        Soop.toast("Adopted “" + title + "” — it is a product now", "ok");
        return S.refresh().then(loadCandidates);
      }, failed(true));
    });
    return el("div", { class: "s-stack is-tight s-sales-adopt" },
      el("div", { class: "s-spread" },
        el("div", { class: "s-grow s-stack is-tight" }, el("b", { class: "s-trunc", title }, title),
          el("span", { class: "s-small s-muted" }, [c.game || "", c.priceUsd != null ? S.usd(c.priceUsd) : "", unitsText(c.units)].filter(Boolean).join(" · "))),
        el("div", { class: "s-row" },
          ui.button("Check", { size: "sm", icon: "search", title: "See what adopting would do — writes nothing", onClick: check }),
          ui.button("Adopt", { size: "sm", tone: "primary", onClick: adopt }))),
      out);
  }
  function loadCandidates() {
    const my = ++candSeq;
    if (!v.adoptList.firstChild) fill(v.adoptList, el("p", { class: "s-muted s-small" }, "Looking for hand-made code listings…"));
    return S.api.get("/adopt/candidates").then((j) => {
      if (my !== candSeq) return;
      const list = Array.isArray(j.candidates) ? j.candidates : Array.isArray(j.items) ? j.items : [];
      fill(v.adoptList, list.length ? list.map(candidateRow) : el("p", { class: "s-muted s-small" }, "No hand-made code listing is waiting to be adopted."));
    }, (e) => {
      if (my !== candSeq) return;
      fill(v.adoptList, ui.empty("Could not look for listings", e.message, { label: "Try again", icon: "refresh", onClick: loadCandidates }));
    });
  }
  function adoptCard() {
    v.adoptList = el("div", { class: "s-stack" });
    v.adoptHint = el("span", { class: "s-small s-muted" });
    return el("section", { class: "s-card" },
      el("div", { class: "s-card-hd" }, el("h2", { class: "s-card-title s-grow" }, "Adopt an existing listing"), v.adoptHint,
        ui.button("", { icon: "refresh", tone: "ghost", size: "sm", title: "Look for listings again", onClick: loadCandidates })),
      el("div", { class: "s-card-bd s-stack" },
        el("span", { class: "s-small s-muted" }, "A code listing made by hand can be handed to the shop: each of its codes is matched to the farm's stored codes, so stock, use-by dates and sales are tracked from then on. "
          + "The shop then adds new codes to it as bundles (when growing stock is on) and takes bundles off sale before their codes stop working; its price and texts stay as they are. "
          + "A listing that is also up on another market than Eldorado cannot be adopted. Check first — nothing is written until you adopt."),
        v.adoptList));
  }

  // ---------- run one engine step now ----------
  const STEPS = [
    { id: "ingest", label: "Read new codes", text: "Copies the codes the farm stored since the last run into the ledger." },
    { id: "reconcile", label: "Check bundle states", text: "Matches every code to its bundle's state: on sale, in a vault, sold, removed." },
    { id: "expiry", label: "Pull stock near its use-by", text: "Takes bundles off sale whose codes stop working soon.", warn: "It can take bundles off live listings right now." },
    { id: "fill", label: "Build bundles", text: "Packs free codes into bundles of approved products.", warn: "It adds stock to live listings right now." },
    { id: "plan", label: "Write drafts", text: "Writes or updates draft products from free codes." },
    { id: "publishPending", label: "Publish waiting products", text: "Publishes approved products that have stock but no live listing.", warn: "It can create live listings right now." },
    { id: "pricing", label: "Reprice", text: "Applies clearance and competitor prices to auto-priced products.", warn: "It can change live prices right now." },
    { id: "scan", label: "Competitor scan", text: "Reads Eldorado's public offers for the product scanned longest ago." },
    { id: "digest", label: "Daily summary", text: "Sends the daily Telegram summary when it is due." },
    { id: "claimAlert", label: "Unclaimed-reward alert", text: "Telegram message about farm rewards that will expire unclaimed." },
    { id: "farmPriority", label: "Farm priority", text: "Points the chosen bots at the code game that sells best.", warn: "It can change a bot's priority game right now." },
    { id: "all", label: "Everything", text: "Every step in order, like the 5-minute timer.", warn: "It runs every step, the ones that change live listings too." },
  ];
  function showResult(s, j, failed, ms) {
    const body = Object.assign({}, j);
    delete body.success;
    const keys = Object.keys(body), shown = keys.length === 1 && keys[0] === "result" ? body.result : body;
    fill(v.runOut, el("div", { class: "s-stack is-tight" },
      el("div", { class: "s-row" }, ui.dot(failed ? "error" : "ok"), el("b", s.label),
        el("span", { class: "s-small s-muted s-grow" }, (failed ? "failed " : "finished ") + S.when(new Date()) + " · took " + (ms / 1000).toFixed(1) + " s"),
        ui.button("", { icon: "x", tone: "ghost", size: "sm", title: "Hide this result", onClick: () => { v.runOut.hidden = true; } })),
      el("pre", { class: "s-sales-json" }, json(shown))));
    v.runOut.hidden = false;
  }
  function runStep(s) {
    const ask = s.warn ? S.confirmAction(s.text + " " + s.warn, { title: "Run “" + s.label + "” now?", okLabel: "Run now" }) : Promise.resolve(true);
    return ask.then((yes) => {
      if (!yes) return null;
      const started = Date.now();
      return S.api.post("/run", { step: s.id }).then((j) => {
        showResult(s, j, false, Date.now() - started);
        Soop.toast("“" + s.label + "” finished", "ok");
        return S.refresh();
      }, (e) => { showResult(s, e.body || { message: e.message }, true, Date.now() - started); throw e; });
    });
  }
  function runCard() {
    v.runStatus = Object.create(null);
    v.runOut = el("div", { class: "s-card-ft s-sales-runout", hidden: true });
    return el("section", { class: "s-card" },
      el("div", { class: "s-card-hd" }, el("h2", { class: "s-card-title s-grow" }, "Run now")),
      el("div", { class: "s-card-bd" }, el("span", { class: "s-small s-muted" },
        "The engine runs these by itself every 5 minutes (pricing and farm priority hourly). Running one now does the same work at once; a step whose switch is off still does nothing.")),
      el("ul", { class: "s-list" }, STEPS.map((s) => {
        const status = (v.runStatus[s.id] = el("span", { class: "s-small s-muted s-trunc" }));
        return el("li", { class: "s-list-item" },
          el("div", { class: "s-grow s-stack is-tight" },
            el("div", { class: "s-row" }, el("b", null, s.label), el("span", { class: "s-mono s-muted" }, s.id),
              s.warn ? ui.badge(s.id === "farmPriority" ? "changes bots" : "changes live listings", "warn") : null),
            el("span", { class: "s-small s-muted" }, s.text), status),
          ui.button("Run", { size: "sm", icon: "play", onClick: () => runStep(s) }));
      })),
      v.runOut);
  }
  function paintRun(st) {
    if (!v.runStatus) return;
    const t = st && st.lastTick, steps = (t && t.steps) || {};
    STEPS.forEach((s) => {
      const node = v.runStatus[s.id];
      let text = "", tone = "s-muted";
      if (s.id === "all") text = t && t.at ? "Last timer run " + fmt.ago(t.at) + (t.ms != null ? ", took " + (Number(t.ms) / 1000).toFixed(1) + " s" : "") : "No timer run since the server started";
      else if (steps[s.id] && steps[s.id].error) { text = "Failed on the last timer run: " + mask(steps[s.id].error); tone = "s-error"; }
      else if (steps[s.id] !== undefined) text = "Last timer run: " + json(steps[s.id]);
      node.className = "s-small s-trunc " + tone;
      node.textContent = text; node.title = text; node.hidden = !text;
    });
  }

  S.registerSection({
    id: "settings", label: "Settings",
    render(root, st) {
      baseline = clone((st && st.config) || {}); draft = clone(baseline); invalid = new Set();
      v.form = el("div");
      v.drift = el("div", { class: "s-note is-warn", hidden: true }, ui.icon("alert"),
        el("span", null, "These settings were changed somewhere else while you were editing. Saving sends only the fields you changed; Discard shows the new values."));
      v.err = el("div", { class: "s-note is-error", role: "alert", hidden: true });
      v.saveInfo = el("span", { class: "s-grow s-small s-strong", role: "status" });
      v.saveBtn = ui.button("Save changes", { tone: "primary", icon: "check", onClick: save });
      v.saveBar = el("div", { class: "s-stack is-tight s-sales-savebar", hidden: true }, v.err,
        el("div", { class: "s-card" }, el("div", { class: "s-card-bd s-row" }, ui.icon("edit"), v.saveInfo,
          ui.button("Discard", { tone: "ghost", onClick: discard }), v.saveBtn)));
      root.append(el("div", { class: "s-stack" },
        el("div", { class: "s-stack" }, v.drift, v.form, v.saveBar),      // the save bar sticks to the bottom while the form is on screen
        el("p", { class: "s-eyebrow" }, "Tools"),
        el("div", { class: "s-grid-2" }, runCard(), adoptCard())));
      buildForm();
      loadCandidates();
    },
    update(root, st) {
      const cfg = (st && st.config) || {}, moved = stable(strip(cfg)) !== stable(strip(baseline)), editing = patchOf() !== undefined || invalid.size > 0;
      if (moved && !editing) { baseline = clone(cfg); draft = clone(cfg); buildForm(); }
      else if (!moved) baseline = clone(cfg);       // at most the server's own bookkeeping moved; patches never carry it
      v.drift.hidden = !(moved && editing);
      paintInfo(st);
      paintRun(st);
      const n = Number(st && st.adoptable) || 0;
      v.adoptHint.textContent = n ? plural(n, "listing") + " found" : "";
    },
  });

  // ================================ Activity ================================
  const LEVEL = { error: ["error", "Error"], warn: ["warn", "Warning"], info: ["info", "Info"] };
  const A = { level: "all", kind: "", product: "", q: "", list: [], kinds: new Set(), loadedAt: 0, loading: false, seq: 0, error: "" };
  const w = {};                       // Activity nodes

  function productName(id) {
    if (!id) return "";
    const p = ((S.state && S.state.products) || []).filter((x) => String(x.id) === String(id))[0];
    return p ? p.name || "Unnamed product" : "Retired product …" + String(id).slice(-6);
  }
  function eventsPath() {
    return "/events?limit=200" + (A.kind ? "&kind=" + encodeURIComponent(A.kind) : "") + (A.level !== "all" ? "&level=" + encodeURIComponent(A.level) : "")
      + (A.product ? "&product=" + encodeURIComponent(A.product) : "");
  }
  function loadEvents() {
    const my = ++A.seq;          // a reply to an older filter is dropped
    A.loading = true;
    return S.api.get(eventsPath()).then((j) => {
      if (my !== A.seq) return;
      A.list = Array.isArray(j.events) ? j.events : Array.isArray(j.items) ? j.items : [];
      A.error = "";
      A.list.forEach((e) => { if (e && e.kind) A.kinds.add(String(e.kind)); });
    }, (e) => { if (my === A.seq) A.error = (e && e.message) || "No answer from the server"; })
      .then(() => { if (my !== A.seq) return; A.loading = false; A.loadedAt = Date.now(); drawEvents(); });
  }
  // The server filters too; this keeps the view right while a new read is on its way.
  function shownEvents() {
    const q = A.q.toLowerCase();
    return A.list.filter((e) => e
      && (A.level === "all" || e.level === A.level)
      && (A.kind ? e.kind === A.kind : e.kind !== "stamp")
      && (!A.product || String(e.product || "") === A.product)
      && (!q || (mask(e.msg) + " " + (e.kind || "") + " " + productName(e.product)).toLowerCase().includes(q)));
  }
  function clearFilters() {
    A.level = "all"; A.kind = ""; A.product = ""; A.q = "";
    w.level.set("all"); w.kind.value = ""; w.product.value = ""; w.search.set("");
    drawEvents();
    return loadEvents();
  }
  function refilter() { drawEvents(); return loadEvents(); }
  function drawEvents() {
    if (!w.table) return;
    const kinds = Array.from(A.kinds).sort(), ksig = kinds.join("|");
    if (ksig !== w.kindSig) {
      w.kindSig = ksig;
      fill(w.kind, el("option", { value: "" }, "All kinds"),
        kinds.map((k) => el("option", { value: k }, k === "stamp" ? "stamp (alert bookkeeping)" : k)));
      w.kind.value = A.kind;
    }
    const rows = shownEvents(), filtered = !!(A.level !== "all" || A.kind || A.product || A.q);
    w.count.textContent = A.loadedAt ? "Showing " + fmt.num(rows.length) + " of the latest " + plural(A.list.length, "entry", "entries") : "";
    w.err.hidden = !(A.error && A.list.length);
    if (!w.err.hidden) fill(w.err, ui.icon("alert"), el("span", null, "The log could not be refreshed: " + A.error));
    put(w.empty, [!!A.error, !!A.loadedAt, filtered].join("|"), () => (A.error && !A.list.length
      ? ui.empty("The log could not be loaded", A.error, { label: "Try again", icon: "refresh", onClick: loadEvents })
      : !A.loadedAt ? ui.empty("Loading the log…")
        : filtered ? ui.empty("No entries match", "Widen the filters to see more of the log.", { label: "Clear filters", onClick: clearFilters })
          : ui.empty("Nothing logged yet", "The shop writes down what it does here. Entries are kept for 30 days.")));
    w.table.update(rows);
  }
  function paintProducts(st) {
    const list = ((st && st.products) || []).slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    const sig = list.map((p) => p.id + ":" + p.name).join("|") + "|" + A.product;
    if (sig === w.prodSig) return;
    w.prodSig = sig;
    fill(w.product, el("option", { value: "" }, "All products"), list.map((p) => el("option", { value: String(p.id) }, p.name || "Unnamed product")),
      A.product && !list.some((p) => String(p.id) === A.product) ? el("option", { value: A.product }, productName(A.product)) : null);
    w.product.value = A.product;
  }
  function openEvent(e) {
    const l = LEVEL[e.level] || LEVEL.info;
    Soop.modal({
      title: l[1] + " · " + (e.kind || "event"), size: "lg",
      body: el("div", { class: "s-stack" },
        el("dl", { class: "s-kv" },
          el("dt", null, "When"), el("dd", null, S.when(e.at) + " (" + fmt.ago(e.at) + ")"),
          el("dt", null, "Level"), el("dd", null, el("span", { class: "s-row" }, ui.dot(l[0]), l[1])),
          el("dt", null, "Kind"), el("dd", { class: "s-mono" }, e.kind || "–"),
          e.product ? [el("dt", null, "Product"), el("dd", null, productName(e.product))] : null,
          el("dt", null, "Message"), el("dd", null, mask(e.msg) || "–")),
        e.data != null ? el("div", { class: "s-stack is-tight" }, el("p", { class: "s-eyebrow" }, "Details"), el("pre", { class: "s-sales-json" }, json(e.data, 2))) : null),
      actions: [{ label: "Close" }],
    });
  }

  S.registerSection({
    id: "activity", label: "Activity",
    render(root, st) {
      w.level = ui.chips({ value: A.level, onChange: (x) => { A.level = x; return refilter(); },
        options: [{ value: "all", label: "All" }, { value: "error", label: "Errors" }, { value: "warn", label: "Warnings" }, { value: "info", label: "Info" }] });
      w.kind = el("select", { class: "s-select s-sales-select", "aria-label": "Kind", onChange: () => { A.kind = w.kind.value; refilter(); } });
      w.product = el("select", { class: "s-select s-sales-select", "aria-label": "Product", onChange: () => { A.product = w.product.value; refilter(); } });
      w.search = ui.search({ placeholder: "Search messages", onInput: (q) => { A.q = q; drawEvents(); } });
      w.count = el("span", { class: "s-small s-muted" });
      w.err = el("div", { class: "s-note is-warn", hidden: true });
      w.empty = el("div");
      w.table = ui.table({
        key: (e) => String(e._id || e.id || [e.at, e.kind, e.msg].join("|")), empty: w.empty, maxHeight: "65vh", onRow: openEvent,
        columns: [
          { label: "When", render: (e) => el("span", { title: fmt.ago(e.at) }, S.when(e.at)) },
          { label: "Level", render: (e) => { const l = LEVEL[e.level] || LEVEL.info; return el("span", { class: "s-row" }, ui.dot(l[0]), l[1]); } },
          { label: "Kind", render: (e) => el("span", { class: "s-mono" }, e.kind || "–") },
          { label: "Product", hide: "sm", render: (e) => (e.product ? productName(e.product) : el("span", { class: "s-muted" }, "–")) },
          { label: "Message", grow: true, render: (e) => el("span", { title: mask(e.msg) }, mask(e.msg) || "–") },
        ],
        rows: [],
      });
      root.append(el("div", { class: "s-stack" },
        el("div", { class: "s-stack is-tight" },
          el("div", { class: "s-toolbar" }, w.search, w.level, w.kind, w.product,
            ui.button("", { icon: "refresh", tone: "ghost", title: "Read the log again", onClick: loadEvents })),
          el("div", { class: "s-spread" }, w.count, el("span", { class: "s-small s-muted" }, "Click an entry for its details."))),
        w.err, w.table));
      paintProducts(st);
      drawEvents();
    },
    // Runs right after render and on every 20 s refresh while this section is shown.
    update(root, st) {
      paintProducts(st);
      if (!A.loading && Date.now() - A.loadedAt >= 15000) loadEvents();
      else drawEvents();
    },
  });
})();
