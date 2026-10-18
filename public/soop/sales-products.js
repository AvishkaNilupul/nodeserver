/* SOOP farm — Sales tab, "Products" section (docs/code-shop/04-OPS.md, panel).
   One card per code-shop product, grouped Drafts / Active / Paused (Retired
   behind a toggle), the editor drawer, and the product actions: approve,
   publish, pause, resume, retire, delete, merge drafts, competitor scan.
   Codes never reach this page: product views carry labels, counts and prices
   only. Talks to /api/code-shop through window.SoopSales (tab-sales.js). */
(function () {
  "use strict";
  if (!window.Soop) return;
  const { el, ui, fmt } = Soop;

  // The markets a product can be put on. GGSel is not used for codes yet
  // (docs/code-shop/05-REVIEW-FIXES.md, R1); its name stays for old listings.
  const MARKETS = ["eldorado", "playerauctions"];
  const MARKET_NAME = { eldorado: "Eldorado", playerauctions: "PlayerAuctions", ggsel: "GGSel" };
  const GGSEL_NOTE = "GGSel is not used for codes yet: it never reports which code it sold";
  const TEXT_KEYS = ["title", "description", "deliveryTemplate", "coverTitle", "coverServiceText", "coverBullets"];
  const GROUPS = [
    { id: "draft", label: "Drafts", hint: "Not on sale yet: check the texts and price, then approve." },
    { id: "active", label: "Active", hint: "On sale; new codes become bundles by themselves." },
    { id: "paused", label: "Paused", hint: "Off sale; Resume lists them again." },
    { id: "retired", label: "Retired", hint: "Closed; their unsold codes went back to free stock." },
  ];
  const STATUS = { draft: ["Draft", "info"], active: ["Active", "ok"], paused: ["Paused", "warn"], retired: ["Retired", null] };
  const ORIGIN = { auto: "Planner", adopted: "Adopted offer", manual: "Made by hand" };
  const KIND = { full: "Full set", leftover: "Leftovers", custom: "Custom set" };
  const TITLE_MAX = 160, DESC_MAX = 2000, BULLETS_MAX = 4, ELDORADO_MIN = 0.5;
  const DAY = 86400000;

  const R = { root: null, groups: null };          // skeleton built once in render()
  const cards = new Map();                         // product id -> { node, sig }
  const selected = new Set();                      // draft ids ticked for merging
  const inflight = new Set();                      // product ids with an action running
  let byId = new Map(), lastState = null, showRetired = false;

  // ---------- small helpers ---------------------------------------------------
  function S() { return window.SoopSales; }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function pid(p) { return String((p && (p.id || p._id)) || ""); }
  function path(p, tail) { return "/products/" + encodeURIComponent(pid(p)) + (tail || ""); }
  function isNum(n) { return n != null && n !== "" && isFinite(Number(n)); }
  function usd(n) {
    if (!isNum(n)) return "–";
    const f = S() && S().usd;
    return f ? f(Number(n)) : "$" + Number(n).toFixed(2);
  }
  function when(d) { const f = S() && S().when; return f ? f(d) : fmt.when(d); }
  function dateOnly(d) {
    const f = S() && S().dateOnly;
    if (f) return f(d);
    const t = d ? new Date(d) : null;
    return t && !isNaN(t.getTime()) ? t.toDateString() : "–";
  }
  function plural(n, one, many) { n = Number(n) || 0; return fmt.num(n) + " " + (n === 1 ? one : many || one + "s"); }
  function say(j, fallback) { return j && typeof j.message === "string" && j.message ? j.message : fallback; }
  function cfgMarkets() { const c = lastState && lastState.config; return (c && c.markets) || null; }
  function gameOf(p) { return p.gameName || Soop.gameName(p.gameNo); }
  function lines(v) { return String(v || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean); }
  function liveOn(p, market) { return arr(p.listings).some((l) => l.market === market && l.status === "active"); }
  function refresh() {
    const r = S() && S().refresh ? S().refresh() : null;
    if (r && typeof r.catch === "function") r.catch(() => null);
    return r;
  }

  // Buyer text may hold tab, newline, carriage return and printable ASCII only
  // (the server's text guard says the same); show the first offenders.
  function nonAscii(s) {
    const bad = [];
    for (const ch of String(s || "")) {
      if (/[^\t\n\r\x20-\x7E]/.test(ch) && bad.indexOf(ch) === -1) bad.push(ch);
      if (bad.length >= 4) break;
    }
    return bad;
  }
  function showChar(ch) {
    const cp = ch.codePointAt(0);
    return cp < 32 || cp === 127 || /\s/.test(ch) ? "U+" + cp.toString(16).toUpperCase().padStart(4, "0") : "“" + ch + "”";
  }

  // One action per product at a time: a second Approve while the first is
  // still building would create a second offer. The state reloads either way.
  function guard(p, fn) {
    const id = pid(p);
    if (inflight.has(id)) {
      Soop.toast("Still working on " + (p.name || "this product") + " — wait for it to finish", "warn");
      return Promise.resolve(false);
    }
    inflight.add(id);
    let r;
    try { r = Promise.resolve(fn()); } catch (e) { r = Promise.reject(e); }
    return r.then((v) => { inflight.delete(id); refresh(); return v; },
      (e) => { inflight.delete(id); refresh(); throw e; });
  }

  // A publish answer -> one toast line naming each market's outcome.
  function publishSummary(res) {
    const results = Array.isArray(res) ? res : arr(res && res.results);
    if (!results.length) return { text: "Nothing to publish: no market is both picked for this product and switched on in settings", tone: "warn" };
    let err = false, ok = false;
    const parts = results.map((r) => {
      const n = MARKET_NAME[r.market] || r.market || "?";
      if (r.error) { err = true; return n + ": " + r.error; }
      if (r.skipped) return n + ": skipped (" + (typeof r.skipped === "string" ? r.skipped : r.reason || "nothing to do") + ")";
      if (r.ok === false) { err = true; return n + ": failed"; }
      ok = true;
      return n + ": listed";
    });
    return { text: parts.join(" · "), tone: err ? "error" : ok ? "ok" : "warn" };
  }
  function builtCount(built, id) {
    if (isNum(built)) return Number(built);
    if (built && built.byProduct && isNum(built.byProduct[id])) return Number(built.byProduct[id]);
    if (built && isNum(built.built)) return Number(built.built);
    return null;
  }

  function check(on, label) {
    const input = el("input", { type: "checkbox", checked: !!on });
    return { input, node: el("label", { class: "s-check" }, input, label) };
  }
  function note(tone, ...kids) { return el("div", { class: "s-note is-" + tone }, ui.icon("alert"), el("div", { class: "s-grow" }, kids)); }
  function showIn(box, node) {
    while (box.firstChild) box.removeChild(box.firstChild);
    box.appendChild(node);
    box.hidden = false;
  }
  function bulletList(items) { return el("ul", { style: { margin: "4px 0 0", paddingLeft: "18px" } }, items.map((x) => el("li", x))); }

  // A labelled text input / textarea with a live counter and the ASCII check.
  function textField(label, value, opts) {
    opts = opts || {};
    const input = opts.multi
      ? el("textarea", { class: "s-textarea", rows: String(opts.rows || 4), value: value == null ? "" : String(value) })
      : el("input", { class: "s-input", type: "text", value: value == null ? "" : String(value) });
    const count = el("span", { class: "s-small s-num s-muted" });
    const warn = el("span", { class: "s-help s-error", hidden: true });
    function run() {
      const v = input.value, n = v.length, out = [];
      count.textContent = opts.max ? fmt.num(n) + " / " + fmt.num(opts.max) : fmt.num(n) + (n === 1 ? " char" : " chars");
      count.className = "s-small s-num " + (opts.max && n > opts.max ? "s-error" : "s-muted");
      if (opts.max && n > opts.max) out.push("Too long by " + plural(n - opts.max, "character") + ".");
      if (opts.ascii !== false) {
        const bad = nonAscii(v);
        if (bad.length) out.push("Not plain ASCII: " + bad.map(showChar).join(" ") + " — buyer text must use plain English characters.");
      }
      if (opts.check) { const extra = opts.check(v); if (extra) out.push(extra); }
      warn.textContent = out.join(" ");
      warn.hidden = !out.length;
    }
    input.addEventListener("input", run);
    run();
    const node = el("label", { class: "s-field" }, el("span", { class: "s-spread" }, el("span", null, label), count), input,
      opts.help ? el("span", { class: "s-help" }, opts.help) : null, warn);
    return { node, input, value: () => input.value, set: (v) => { input.value = v == null ? "" : String(v); run(); } };
  }
  function moneyField(label, value, help) {
    const input = el("input", { type: "number", class: "s-input", step: "0.01", min: "0", inputmode: "decimal", value: isNum(value) ? String(value) : "" });
    return { input, node: el("label", { class: "s-field" }, label, input, help ? el("span", { class: "s-help" }, help) : null) };
  }
  function money(v, what) {
    const s = String(v == null ? "" : v).trim(), n = Number(s);
    if (!s || !isFinite(n) || n < 0) throw new Error(what + " must be an amount in dollars, like 1.50");
    return Math.round(n * 100) / 100;
  }
  function section(title, ...kids) { return el("section", { class: "s-stack is-tight" }, el("p", { class: "s-eyebrow" }, title), kids); }

  // ---------- card ------------------------------------------------------------
  function listingRow(name, l) {
    const live = l.status === "active";
    const state = l.autoPaused ? ui.badge("Paused: no stock", "warn")
      : live ? el("span", { class: "s-row" }, ui.dot("ok", "Live"), "Live")
      : el("span", { class: "s-muted s-small" }, l.status === "delisted" ? "Taken down" : String(l.status || "unknown"));
    return el("li", { class: "s-list-item" },
      el("div", { class: "s-grow s-stack is-tight" },
        el("div", { class: "s-row" },
          l.url ? el("a", { class: "s-link", href: l.url, target: "_blank", rel: "noopener noreferrer", title: "Open the listing" }, name, " ", ui.icon("external", 12)) : el("b", null, name),
          el("span", { class: "s-num" }, usd(l.price)), state),
        l.lastError ? el("span", { class: "s-small s-error" }, l.lastError) : null));
  }
  function marketsBlock(p) {
    const cm = cfgMarkets(), listings = arr(p.listings);
    // A market the shop no longer sells on shows only while a listing of it exists.
    const names = arr(p.markets).filter((m) => MARKETS.indexOf(m) !== -1);
    listings.forEach((l) => { if (l.market && names.indexOf(l.market) === -1) names.push(l.market); });
    if (!names.length) return section("Markets", el("span", { class: "s-error s-small" }, "No market picked"));
    const rows = [];
    names.forEach((m) => {
      const name = MARKET_NAME[m] || m, ls = listings.filter((l) => l.market === m);
      if (ls.length) { ls.forEach((l) => rows.push(listingRow(name, l))); return; }
      const why = cm && cm[m] === false ? "switched off in settings"
        : p.status === "draft" ? "listed after approval"
        : p.status === "active" ? "not listed yet" : "not listed";
      rows.push(el("li", { class: "s-list-item" }, ui.dot("muted", "Not listed"), el("span", { class: "s-grow" }, name), el("span", { class: "s-muted s-small" }, why)));
    });
    return section("Markets", el("ul", { class: "s-list" }, rows));
  }
  function slotsBlock(p) {
    const slots = arr(p.slots);
    const list = el("ul", { class: "s-list" }, slots.map((s, i) => el("li", { class: "s-list-item" },
      s.image ? el("img", { class: "s-thumb", src: s.image, alt: "", loading: "lazy" }) : null,
      el("span", { class: "s-muted s-num" }, i + 1 + ")"),
      s.label ? el("span", { class: "s-grow s-trunc", title: s.label }, s.label) : el("span", { class: "s-grow s-error" }, "No label yet"))));
    return section(plural(slots.length, "reward") + " per bundle", slots.length > 6 ? el("div", { class: "s-scroll" }, list) : list);
  }
  function kv(rows) {
    return el("dl", { class: "s-kv" }, rows.filter(Boolean).map((r) => [el("dt", null, r[0]), el("dd", null, r[1])]));
  }
  function detailsBlock(p) {
    const u = p.units || {}, pr = p.pricing || {}, c = p.competitors || {}, rows = [];
    const bit = (n, label, strong) => el("span", null, el(strong ? "b" : "span", { class: "s-num" }, fmt.num(n || 0)), " " + label);
    if (p.status !== "draft" || u.available || u.sold) {
      rows.push(["Bundles", el("span", { class: "s-row" }, bit(u.available, "available", true), u.fed ? bit(u.fed, "in a GGSel vault") : null, bit(u.sold, "sold"), bit(u.removed, "removed"))]);
    }
    if (isNum(p.freeUnits)) rows.push([p.status === "draft" ? "Could build" : "Can add now", plural(p.freeUnits, "bundle") + " from free codes"]);
    const pro = p.proposed || {};
    if (pro.units) rows.push(["Planner proposed", el("span", null, plural(pro.units, "bundle"), pro.at ? el("span", { class: "s-muted" }, " · " + fmt.ago(pro.at)) : null)]);
    const auto = pr.mode === "auto";
    rows.push(["Price", el("div", { class: "s-stack is-tight" },
      el("span", { class: "s-row" }, el("b", { class: "s-num" }, usd(pr.priceUsd)), el("span", { class: "s-muted s-small" }, "floor " + usd(pr.floorUsd)),
        ui.badge(auto ? "Auto price" : "Fixed price", auto ? "info" : null),
        auto && pr.clearance ? ui.badge("Clearance") : null, auto && pr.followCompetitors ? ui.badge("Follows competitors") : null),
      pr.lastReason ? el("span", { class: "s-muted s-small" }, "Last change: " + pr.lastReason + (pr.lastChangeAt ? " (" + fmt.ago(pr.lastChangeAt) + ")" : "")) : null)]);
    if (p.useBy) {
      const left = new Date(p.useBy).getTime() - Date.now();
      rows.push(["Use by", el("span", { class: left < 0 ? "s-error" : left < 3 * DAY ? "s-warn" : null },
        (left < 0 ? "Codes stopped working " : "Codes stop working ") + dateOnly(p.useBy), el("span", { class: "s-muted s-small" }, " (" + fmt.until(p.useBy) + ")"))]);
    }
    let comp;
    if (!c.scannedAt) comp = el("span", { class: "s-muted" }, "Not scanned yet");
    else {
      const low = c.lowestSameSetUsd, ours = Number(pr.priceUsd);
      comp = el("div", { class: "s-stack is-tight" },
        el("span", { class: "s-row" }, isNum(low) ? el("span", null, "Lowest same-set code seller ", el("b", { class: "s-num" }, usd(low))) : el("span", null, "No same-set code seller found"),
          el("span", { class: "s-muted s-small" }, plural(c.count || 0, "offer") + " · scanned " + fmt.ago(c.scannedAt)),
          c.count ? btn("View", "competitors", { tone: "ghost", icon: "eye", onClick: () => viewCompetitors(p) }) : null),
        isNum(low) && isFinite(ours) && ours > Number(low) ? el("span", { class: "s-small s-warn" }, "Ours is " + usd(ours - Number(low)) + " above the lowest same-set code seller") : null);
    }
    rows.push(["Competitors", comp]);
    return kv(rows);
  }
  function btn(label, act, opts) {
    const b = ui.button(label, Object.assign({ size: "sm" }, opts));
    b.dataset.act = act;
    return b;
  }
  function missingMarkets(p) {
    const cm = cfgMarkets();
    return arr(p.markets).filter((m) => MARKETS.indexOf(m) !== -1 && !(cm && cm[m] === false) && !liveOn(p, m));
  }
  function actionsFor(p) {
    const problems = arr(p.problems);
    if (p.status === "draft") {
      return [
        btn("Edit", "edit", { icon: "edit", onClick: () => openEditor(p) }),
        btn("Approve", "approve", { icon: "check", tone: "primary", disabled: problems.length > 0,
          title: problems.length ? "Fix the problems listed above first" : "Create the offer and build bundles", onClick: () => approve(p) }),
        btn("Delete", "delete", { icon: "trash", tone: "ghost", onClick: () => removeDraft(p) }),
      ];
    }
    if (p.status === "active") {
      const missing = missingMarkets(p);
      return [
        btn("Edit texts / price", "edit", { icon: "edit", onClick: () => openEditor(p) }),
        btn("Publish missing markets", "publish", { icon: "upload", disabled: !missing.length,
          title: missing.length ? "List it on " + missing.map((m) => MARKET_NAME[m] || m).join(" and ")
            : "Every picked market that is switched on in settings already has a live listing", onClick: () => publish(p) }),
        btn("Scan competitors", "scan", { icon: "search", onClick: () => scan(p) }),
        ui.menu(btn("", "more", { icon: "more", title: "More actions" }), [
          { label: "Pause", icon: "pause", onClick: () => pause(p) },
          "-",
          { label: "Retire", icon: "trash", danger: true, onClick: () => retire(p) },
        ]),
      ];
    }
    if (p.status === "paused") {
      return [
        btn("Resume", "resume", { icon: "play", tone: "primary", onClick: () => resume(p) }),
        btn("Retire", "retire", { icon: "trash", tone: "danger", onClick: () => retire(p) }),
      ];
    }
    return [];
  }
  function buildCard(p) {
    const id = pid(p), problems = arr(p.problems), pub = p.publish || {};
    const listErr = arr(p.listings).some((l) => l.lastError);
    const st = STATUS[p.status] || [String(p.status || "Unknown"), null];
    const tone = pub.lastError || listErr ? "is-error" : (p.status === "draft" && problems.length) || p.stale ? "is-warn" : p.status === "active" && arr(p.listings).some((l) => l.status === "active") ? "is-ok" : null;
    const select = p.status === "draft" ? el("input", { type: "checkbox", "aria-label": "Select " + (p.name || "this draft") + " for merging", title: "Select for merging",
      checked: selected.has(id), dataset: { act: "select", game: String(p.gameNo == null ? "" : p.gameNo) },
      onChange: (e) => { if (e.target.checked) selected.add(id); else selected.delete(id); syncMerge(); } }) : null;
    const actions = actionsFor(p);
    return el("section", { class: ["s-card", tone], dataset: { product: id } },
      el("div", { class: "s-card-hd" }, select,
        el("h2", { class: "s-card-title s-grow s-trunc", title: p.name || "" }, p.name || "(no name)"), ui.badge(st[0], st[1])),
      el("div", { class: "s-card-bd s-stack is-tight" },
        el("div", { class: "s-row" }, el("span", { class: "s-small s-strong" }, gameOf(p)),
          ui.badge(ORIGIN[p.origin] || p.origin || "–"), ui.badge(KIND[p.kind] || p.kind || "–"),
          p.stale ? ui.badge("No longer proposed", "warn") : null, p.status === "draft" && p.edited ? ui.badge("Edited") : null),
        slotsBlock(p), detailsBlock(p), marketsBlock(p),
        pub.lastError ? note("error", el("b", null, "Last publish failed: "), pub.lastError, pub.lastAttemptAt ? el("span", { class: "s-muted" }, " (" + fmt.ago(pub.lastAttemptAt) + ")") : null) : null,
        problems.length ? note("warn", el("b", null, p.status === "draft" ? "Fix before approving:" : "Problems:"), bulletList(problems)) : null),
      actions.length ? el("div", { class: "s-card-ft s-row" }, actions) : null);
  }
  // Rebuild a card only when its data changed (or every 10 min for the
  // relative times), and never under an open menu or a running action.
  function cardNode(p) {
    const id = pid(p), old = cards.get(id);
    const sig = JSON.stringify(p) + "|" + JSON.stringify(cfgMarkets()) + "|" + Math.floor(Date.now() / 600000);
    if (old && (old.sig === sig || inflight.has(id) || old.node.querySelector('[aria-busy="true"],[aria-expanded="true"]'))) return old.node;
    const node = buildCard(p);
    cards.set(id, { node, sig });
    return node;
  }
  function syncList(box, nodes) {
    const want = new Set(nodes);
    Array.from(box.children).forEach((n) => { if (!want.has(n)) box.removeChild(n); });
    nodes.forEach((n, i) => { if (box.children[i] !== n) box.insertBefore(n, box.children[i] || null); });
  }
  function syncMerge() {
    if (!R.groups) return;
    const drafts = Array.from(selected).map((id) => byId.get(id)).filter(Boolean);
    const games = new Set(drafts.map((p) => String(p.gameNo)));
    R.mergeBtn.disabled = !(drafts.length >= 2 && games.size === 1);
    R.mergeHint.textContent = !drafts.length ? "Tick drafts of one game to merge them"
      : games.size > 1 ? "Pick drafts of one game only"
      : drafts.length < 2 ? "Tick one more draft of " + gameOf(drafts[0])
      : plural(drafts.length, "draft") + " of " + gameOf(drafts[0]) + " selected";
    const g = drafts.length ? String(drafts[0].gameNo) : null;
    Array.prototype.forEach.call(R.root.querySelectorAll('input[data-act="select"]'), (box) => {
      box.disabled = g != null && box.dataset.game !== g && !box.checked;
    });
  }

  // ---------- actions -----------------------------------------------------------
  function approve(p) {
    const rebalance = check(false, "Also move matching stock from smaller bundles (rebalance)");
    const pub = check(true, "Publish now");
    const out = el("div", { hidden: true });
    const cm = cfgMarkets() || {};
    const picked = arr(p.markets).filter((m) => MARKETS.indexOf(m) !== -1);
    const on = picked.filter((m) => cm[m] !== false), off = picked.filter((m) => cm[m] === false);
    const names = (list) => list.map((m) => MARKET_NAME[m] || m).join(" and ");
    const markets = on.length ? names(on) : "no market (every picked market is switched off in settings)";
    const body = el("div", { class: "s-stack" },
      el("p", { style: { margin: "0" } }, "This creates the offer for ", el("b", null, p.name || "this draft"), " and fills it with bundles built from free codes",
        isNum(p.freeUnits) ? " (" + plural(p.freeUnits, "bundle") + " can be built now)" : "", "."),
      p.stale ? note("warn", "The planner no longer proposes this set of rewards. Approve it only if you still want it.") : null,
      el("div", { class: "s-stack is-tight" }, rebalance.node,
        el("span", { class: "s-help" }, "Takes the unsold bundles of other active " + gameOf(p) + " products that share a reward with this one apart, so their codes can go into this bundle instead.")),
      el("div", { class: "s-stack is-tight" }, pub.node,
        el("span", { class: "s-help" }, "Lists it on " + markets + " as soon as there is stock. Untick to approve now and publish later." +
          (on.length && off.length ? " " + names(off) + " is switched off in settings, so nothing is listed there." : ""))),
      out);
    Soop.modal({ title: "Approve " + (p.name || "draft") + "?", body, actions: [{ label: "Cancel" }, {
      label: "Approve", tone: "primary", icon: "check",
      onClick: () => guard(p, () => S().api.post(path(p, "/approve"), { rebalance: rebalance.input.checked, publish: pub.input.checked })).then((j) => {
        if (j === false) return false;
        const r = (j && j.result) || j || {};
        if (r.ok === false) {
          const list = arr(r.problems);
          showIn(out, note("warn", el("b", null, say(r, "Not approved. Fix these first:")), list.length ? bulletList(list) : null));
          Soop.toast(say(r, "Not approved: " + (list[0] || "the server refused it")), "warn");
          return false;
        }
        const n = builtCount(r.built, pid(p));
        Soop.toast("Approved " + (p.name || "the draft") + (n != null ? " — built " + plural(n, "bundle") : ""), "ok");
        if (r.publish) { const s = publishSummary(r.publish); Soop.toast("Publish: " + s.text, s.tone); }
        return undefined;
      }, (e) => { showIn(out, note("error", String((e && e.message) || e))); throw e; }),
    }] });
  }
  function removeDraft(p) {
    return Soop.confirm({ title: "Delete " + (p.name || "this draft") + "?", danger: true, okLabel: "Delete draft",
      body: "The draft goes away; its codes stay in free stock. The planner may propose the same set again later." })
      .then((yes) => (yes ? guard(p, () => S().api.del(path(p))).then((j) => { if (j !== false) Soop.toast(say(j, "Deleted " + (p.name || "the draft")), "ok"); }) : null));
  }
  function publish(p) {
    return guard(p, () => S().api.post(path(p, "/publish"), {})).then((j) => {
      if (j === false) return;
      const r = (j && j.result) || j || {};
      const s = publishSummary(r.results ? r : r.publish || r);
      Soop.toast((p.name || "Product") + " — " + s.text, s.tone);
    });
  }
  function pause(p) {
    const gg = liveOn(p, "ggsel");
    return Soop.confirm({ title: "Pause " + (p.name || "this product") + "?", okLabel: "Pause product",
      body: "Its Eldorado and PlayerAuctions listings are taken down now and no new bundles are added. " +
        (gg ? "Its GGSel listing stays up: empty that vault from the Listings page if it should stop selling too. " : "") + "Resume lists it again." })
      .then((yes) => (yes ? guard(p, () => S().api.post(path(p, "/pause"), {})).then((j) => {
        if (j !== false) Soop.toast(say(j, "Paused " + (p.name || "the product") + (gg ? " — its GGSel listing is still up" : "")), gg ? "warn" : "ok");
      }) : null));
  }
  function resume(p) {
    return guard(p, () => S().api.post(path(p, "/resume"), {})).then((j) => {
      if (j === false) return;
      const r = (j && j.result) || j || {};
      const res = r.results ? r : r.publish;
      if (res) { const s = publishSummary(res); Soop.toast("Resumed " + (p.name || "the product") + " — " + s.text, s.tone); }
      else Soop.toast(say(r, "Resumed " + (p.name || "the product")), "ok");
    });
  }
  function retire(p) {
    const gg = liveOn(p, "ggsel");
    return Soop.confirm({ title: "Retire " + (p.name || "this product") + "?", danger: true, okLabel: "Retire product",
      body: el("div", { class: "s-stack is-tight" },
        el("p", { style: { margin: "0" } }, "Its Eldorado and PlayerAuctions listings are taken down and its unsold bundles are taken apart; their codes go back to free stock. A retired product cannot be resumed."),
        gg ? note("warn", "It still has a live GGSel listing. Empty that vault from the Listings page first — the shop refuses to retire it until then.") : null) })
      .then((yes) => (yes ? guard(p, () => S().api.post(path(p, "/retire"), {})).then((j) => {
        if (j !== false) Soop.toast(say(j, "Retired " + (p.name || "the product")), "ok");
      }) : null));
  }
  function scan(p) {
    return guard(p, () => S().api.post(path(p, "/scan"), {}).then((j) => {
      const r = (j && j.result) || j || {};
      if (r.ok === false || r.error) Soop.toast(r.error || say(r, "The scan did not finish; showing the last good scan"), "warn");
      else Soop.toast("Scanned Eldorado for " + (p.name || "the product"), "ok");
      return S().api.get(path(p));
    }).then((j) => showCompetitors(Object.assign({}, p, (j && j.product) || j))));
  }
  function viewCompetitors(p) {
    return S().api.get(path(p)).then((j) => showCompetitors(Object.assign({}, p, (j && j.product) || j)));
  }
  function showCompetitors(d) {
    const c = d.competitors || {}, ours = d.pricing && d.pricing.priceUsd;
    const rows = arr(c.offers).map((o, i) => Object.assign({ _k: i + "|" + (o.id || "") }, o));
    const table = ui.table({ key: "_k", maxHeight: "50vh", empty: c.scannedAt ? "No matching offers found" : "Not scanned yet",
      columns: [
        { label: "Offer", wrap: true, render: (o) => o.title || "–" },
        { label: "Price", align: "right", render: (o) => el("span", { class: o.sameSet && isNum(ours) && Number(o.priceUsd) < Number(ours) ? "s-num s-warn" : "s-num" }, usd(o.priceUsd)) },
        { label: "Qty", align: "right", render: (o) => fmt.num(o.qty) },
        { label: "Match", align: "right", render: (o) => (isNum(o.score) ? fmt.pct(o.score, 1) : "–") },
        { label: "Named in", render: (o) => (o.matchedIn === "description" ? el("span", { class: "s-muted" }, "Description") : o.matchedIn === "title" ? "Title" : "–") },
        { label: "Sells", render: (o) => (o.form === "codes" ? ui.badge("Codes", "ok") : o.form === "account" ? el("span", { class: "s-muted" }, "Twitch account") : o.form === "unknown" ? el("span", { class: "s-muted" }, "Unclear") : "–") },
        { label: "Same set", align: "center", render: (o) => (o.sameSet ? ui.badge("Same set", "ok") : el("span", { class: "s-muted" }, "No")) },
      ], rows });
    Soop.modal({ title: "Competitors — " + (d.name || "product"), size: "lg", actions: [{ label: "Close" }],
      body: el("div", { class: "s-stack" },
        kv([
          ["Our price", usd(ours)],
          ["Lowest same-set code seller", isNum(c.lowestSameSetUsd) ? usd(c.lowestSameSetUsd) : "None found"],
          ["Scanned", c.scannedAt ? when(c.scannedAt) + " (" + fmt.ago(c.scannedAt) + ")" : "Never"],
          arr(c.queries).length ? ["Searched for", el("span", { class: "s-row" }, arr(c.queries).map((q) => ui.badge(q)))] : null,
        ]),
        el("p", { class: "s-help", style: { margin: "0" } }, "Other sellers' Eldorado offers (ours are left out). Match = share of this bundle's rewards named in their title or description; 80% or more counts as the same set. Most sellers offer these rewards as a Twitch-drop account (log in, link, claim within about two weeks): a different product from a code, so only code sellers set the lowest price."),
        table) });
  }
  function merge() {
    const list = Array.from(selected).map((id) => byId.get(id)).filter(Boolean);
    const ids = list.map(pid);
    const autos = list.filter((p) => p.origin === "auto").length;
    return Soop.confirm({ title: "Merge " + plural(list.length, "draft") + " into one bundle?", okLabel: "Merge drafts",
      body: el("div", { class: "s-stack is-tight" },
        el("p", { style: { margin: "0" } }, "A new custom draft gets every reward of:"), bulletList(list.map((p) => p.name || pid(p))),
        autos ? el("p", { class: "s-help", style: { margin: "0" } }, plural(autos, "planner draft") + " among them " + (autos === 1 ? "is" : "are") + " deleted after the merge; drafts made by hand stay.") : null) })
      .then((yes) => {
        if (!yes) return null;
        return S().api.post("/products/merge", { ids }).then((j) => {
          selected.clear();
          const np = (j && j.product) || {};
          Soop.toast(say(j, "Merged into " + (np.name || "a new draft") + " — check its texts and price before approving"), "ok");
          refresh();
        }, (e) => { refresh(); throw e; });
      });
  }

  // ---------- editor drawer -------------------------------------------------------
  function slotEditor(slots, editable) {
    const model = slots.map((s, i) => ({ key: String(s.slotKey || s.key || ""), orig: i, label: s.label || "", image: s.image || "", nameRaw: s.nameRaw || "", removed: false }));
    const keyed = model.length > 0 && model.every((m) => m.key);
    const list = el("ul", { class: "s-list" });
    const head = el("span", { class: "s-small s-muted" });
    function rowFor(m) {
      m.num = el("span", { class: "s-muted s-num" });
      const thumb = m.image ? el("img", { class: "s-thumb", src: m.image, alt: "", loading: "lazy" }) : null;
      if (!editable) {
        m.check = () => {};
        return el("li", { class: "s-list-item" }, thumb, m.num, m.label ? el("span", { class: "s-grow" }, m.label) : el("span", { class: "s-grow s-error" }, "No label"));
      }
      m.input = el("input", { class: "s-input", type: "text", value: m.label, "aria-label": "Label of reward " + (m.orig + 1) });
      m.warn = el("span", { class: "s-help s-error", hidden: true });
      m.check = () => {
        const v = m.input.value.trim(), bad = nonAscii(v);
        const msg = m.removed ? "" : !v ? "A label is required." : bad.length ? "Not plain ASCII: " + bad.map(showChar).join(" ") : "";
        m.warn.textContent = msg; m.warn.hidden = !msg;
      };
      m.input.addEventListener("input", m.check);
      const up = (m.up = btn("", "up", { icon: "chevron", title: "Move up", tone: "ghost", disabled: !keyed, onClick: () => move(m, -1) }));
      const down = (m.down = btn("", "down", { icon: "chevron", title: "Move down", tone: "ghost", disabled: !keyed, onClick: () => move(m, 1) }));
      up.querySelector("svg").style.transform = "rotate(-90deg)";
      down.querySelector("svg").style.transform = "rotate(90deg)";
      m.rm = btn("", "remove", { icon: "x", title: "Remove from the bundle", tone: "ghost", disabled: !keyed, onClick: () => setRemoved(m, true) });
      m.back = btn("", "keep", { icon: "plus", title: "Put back in the bundle", tone: "ghost", onClick: () => setRemoved(m, false) });
      return el("li", { class: "s-list-item" }, thumb, m.num,
        el("div", { class: "s-grow s-stack is-tight" }, m.input,
          m.nameRaw && m.nameRaw !== m.label ? el("span", { class: "s-help" }, "Earned as: " + m.nameRaw) : null, m.warn),
        up, down, m.rm, m.back);
    }
    model.forEach((m) => { m.node = rowFor(m); });
    function draw() {
      let n = 0;
      model.forEach((m, i) => {
        list.appendChild(m.node);
        m.num.textContent = m.removed ? "–" : ++n + ")";
        if (editable) {
          m.up.disabled = !keyed || i === 0;
          m.down.disabled = !keyed || i === model.length - 1;
          m.node.style.opacity = m.removed ? "0.55" : "";
          m.input.disabled = m.removed;
          m.rm.hidden = m.removed;
          m.back.hidden = !m.removed;
        }
        m.check();
      });
      head.textContent = plural(n, "reward") + " per bundle" + (n !== model.length ? " (" + (model.length - n) + " removed)" : "");
    }
    function move(m, dir) {
      const i = model.indexOf(m), j = i + dir;
      if (j < 0 || j >= model.length) return;
      model.splice(i, 1);
      model.splice(j, 0, m);
      draw();
      const to = dir < 0 ? (m.up.disabled ? m.down : m.up) : m.down.disabled ? m.up : m.down;
      to.focus();
    }
    function setRemoved(m, on) {
      if (on && model.filter((x) => !x.removed).length <= 1) { Soop.toast("A bundle needs at least one reward", "warn"); return; }
      m.removed = on;
      draw();
      (on ? m.back : m.rm).focus();
    }
    draw();
    const node = el("div", { class: "s-stack is-tight" }, head,
      editable ? el("p", { class: "s-help", style: { margin: "0" } },
        "Each label is one line of the buyer's delivery (“1) Label = <code>”) and goes into the title and description. Use plain English letters, digits and punctuation only (ASCII), and never name where the codes come from.") : null,
      editable && !keyed ? note("warn", "This product view has no slot keys, so only the labels can be changed here.") : null,
      model.length > 6 ? el("div", { class: "s-scroll" }, list) : list);
    return {
      node,
      // labels[] follow the product's stored slot order (index i = slots[i]),
      // all of them, sent only when one changed; slotOrder[] = the kept slot
      // keys in their new order (sent only when it changed); removeSlots[] =
      // slot keys to drop.
      collect() {
        if (!editable) return {};
        const byOrig = model.slice().sort((a, b) => a.orig - b.orig);
        const kept = model.filter((m) => !m.removed);
        if (!kept.length) throw new Error("A bundle needs at least one reward.");
        const out = {};
        const labels = byOrig.map((m) => m.input.value.trim());
        if (byOrig.some((m, i) => labels[i] !== String(m.label).trim())) out.labels = labels;
        if (keyed) {
          const order = kept.map((m) => m.key), before = byOrig.filter((m) => !m.removed).map((m) => m.key);
          if (order.join("\n") !== before.join("\n")) out.slotOrder = order;
          const removed = model.filter((m) => m.removed).map((m) => m.key);
          if (removed.length) out.removeSlots = removed;
        }
        return out;
      },
    };
  }

  function openEditor(p) {
    return S().api.get(path(p)).then((j) => editor(Object.assign({}, p, (j && j.product) || j)));
  }
  function editor(d) {
    const draft = d.status === "draft";
    const err = el("div", { hidden: true });
    const name = textField("Name (only you see it)", d.name, { ascii: false });
    const slots = slotEditor(arr(d.slots), draft);
    const t = d.texts || {};
    const title = textField("Title", t.title, { max: TITLE_MAX, help: "The listing's title.", check: (v) => (v.trim() ? "" : "A title is required.") });
    const desc = textField("Description", t.description, { max: DESC_MAX, multi: true, rows: 10 });
    const delivery = textField("Delivery message", t.deliveryTemplate, { multi: true, rows: 5,
      help: "Sent to the buyer after payment; {password} is replaced by the bundle's codes.",
      check: (v) => (v.indexOf("{password}") === -1 ? "Must contain {password} — that is where the codes go." : "") });
    const coverTitle = textField("Cover title", t.coverTitle, {});
    const coverService = textField("Cover service line", t.coverServiceText, {});
    const bullets = textField("Cover bullets", arr(t.coverBullets).join("\n"), { multi: true, rows: 4, help: "One per line, up to " + BULLETS_MAX + ".",
      check: (v) => (lines(v).length > BULLETS_MAX ? "At most " + BULLETS_MAX + " bullets." : "") });
    function fillTexts(nt) {
      nt = nt || {};
      title.set(nt.title); desc.set(nt.description); delivery.set(nt.deliveryTemplate);
      coverTitle.set(nt.coverTitle); coverService.set(nt.coverServiceText); bullets.set(arr(nt.coverBullets).join("\n"));
    }
    const reset = draft ? btn("Reset texts", "reset", { icon: "refresh", tone: "ghost", onClick: () => Soop.confirm({
      title: "Reset the texts?", danger: true, okLabel: "Reset texts",
      body: "Replaces the saved title, description, delivery message and cover texts with fresh defaults built from the SAVED labels. Save label changes first; text edits in this form are lost." })
      .then((yes) => (yes ? guard(d, () => S().api.post(path(d, "/texts/reset"), {}).then(() => S().api.get(path(d)))).then((j) => {
        if (j === false) return;
        fillTexts(((j && j.product) || j || {}).texts);
        init.texts = snapshot().texts;          // the reset texts are saved already: not a change to send
        Soop.toast("Texts reset to the defaults", "ok");
      }) : null)) }) : null;

    const pr = d.pricing || {};
    const adopted = d.origin === "adopted";
    const price = moneyField("Price per bundle (USD)", pr.priceUsd, "Eldorado's minimum is $0.50.");
    const floor = moneyField("Floor (USD)", pr.floorUsd, "Auto pricing never goes below this.");
    const autoOpt = el("option", { value: "auto" }, "Auto — clearance and competitor rules may lower it");
    const mode = el("select", { class: "s-select", "aria-label": "Pricing mode" },
      el("option", { value: "fixed" }, "Fixed — the shop never changes it"), autoOpt);
    mode.value = pr.mode === "auto" ? "auto" : "fixed";
    // An adopted listing keeps the price its owner set (the server refuses Auto).
    if (adopted && mode.value !== "auto") { autoOpt.disabled = true; autoOpt.textContent = "Auto — not for an adopted listing"; }
    const clearance = check(pr.clearance, "Clearance: cut the price as the codes' last day comes closer");
    const follow = check(pr.followCompetitors, "Follow competitors: stay just under the lowest same-set code seller");
    const priceWarn = el("span", { class: "s-help s-warn", hidden: true });
    function syncPrice() {
      const auto = mode.value === "auto";
      clearance.input.disabled = !auto; follow.input.disabled = !auto;
      const pu = Number(price.input.value), fl = Number(floor.input.value), out = [];
      if (price.input.value !== "" && isFinite(pu) && pu < ELDORADO_MIN) out.push("The price is below Eldorado's $0.50 minimum.");
      if (price.input.value !== "" && floor.input.value !== "" && isFinite(pu) && isFinite(fl) && pu < fl) out.push("The price is below the floor.");
      priceWarn.textContent = out.join(" "); priceWarn.hidden = !out.length;
    }
    [mode, price.input, floor.input].forEach((n) => { n.addEventListener("change", syncPrice); n.addEventListener("input", syncPrice); });
    syncPrice();

    const cm = cfgMarkets() || {};
    const mk = draft ? MARKETS.map((m) => ({ m, c: check(arr(d.markets).indexOf(m) !== -1, MARKET_NAME[m] + (cm[m] === false ? " (switched off in settings: nothing is listed there until it is on)" : "")) })) : [];
    const eldoLive = liveOn(d, "eldorado");
    const pushLive = draft ? null : check(false, "Also update the live Eldorado offer");
    if (pushLive && !eldoLive) pushLive.input.disabled = true;

    // Only the fields the owner changed in this form are sent (R5): a value the
    // form merely read back — a price the auto pricer has moved since, a text
    // saved elsewhere — never goes to the server or to Eldorado.
    function snapshot() {
      return {
        name: name.value().trim(),
        texts: { title: title.value().trim(), description: desc.value(), deliveryTemplate: delivery.value(),
          coverTitle: coverTitle.value().trim(), coverServiceText: coverService.value().trim(), coverBullets: lines(bullets.value()).join("\n") },
        price: price.input.value.trim(), floor: floor.input.value.trim(), mode: mode.value,
        clearance: clearance.input.checked, follow: follow.input.checked,
        markets: mk.filter((x) => x.c.input.checked).map((x) => x.m).join(","),
      };
    }
    const init = snapshot();
    function collect() {
      const now = snapshot(), out = {}, texts = {}, pricing = {};
      if (now.name !== init.name) {
        if (!now.name) throw new Error("The name cannot be empty.");
        out.name = now.name;
      }
      TEXT_KEYS.forEach((k) => { if (now.texts[k] !== init.texts[k]) texts[k] = k === "coverBullets" ? lines(bullets.value()) : now.texts[k]; });
      if (Object.keys(texts).length) out.texts = texts;
      if (now.price !== init.price) pricing.priceUsd = money(price.input.value, "The price");
      if (now.floor !== init.floor) pricing.floorUsd = money(floor.input.value, "The floor");
      if (now.mode !== init.mode) pricing.mode = now.mode;
      if (now.clearance !== init.clearance) pricing.clearance = now.clearance;
      if (now.follow !== init.follow) pricing.followCompetitors = now.follow;
      if (Object.keys(pricing).length) out.pricing = pricing;
      if (draft) {
        Object.assign(out, slots.collect());
        if (now.markets !== init.markets) {
          out.markets = mk.filter((x) => x.c.input.checked).map((x) => x.m);
          if (!out.markets.length) throw new Error("Pick at least one market.");
        }
      } else if (pushLive.input.checked && Object.keys(out).length) out.pushLive = true;
      return out;
    }
    function fail(e) { showIn(err, note("error", String((e && e.message) || e))); throw e; }
    function save() {
      err.hidden = true;
      let body;
      try { body = collect(); } catch (e) { fail(e); }
      if (!Object.keys(body).length) {
        Soop.toast(pushLive && pushLive.input.checked
          ? "Nothing changed, so nothing was sent to Eldorado: change the title, description or price to update the live offer"
          : "Nothing to save: no field changed", "info");
        return undefined;
      }
      return guard(d, () => S().api.post(path(d), body)).then((j) => {
        if (j === false) return false;
        const np = (j && j.product) || null, left = np ? arr(np.problems).length : 0;
        Soop.toast(say(j, "Saved " + (body.name || d.name || "the product") + (left && draft ? " — " + plural(left, "problem") + (left === 1 ? " still blocks" : " still block") + " approval" : "")), left && draft ? "warn" : "ok");
        return undefined;
      }, fail);
    }

    const body = el("div", { class: "s-stack" }, err,
      section("Name", name.node),
      section(draft ? "Rewards in the bundle" : "Rewards in the bundle (fixed once approved)", slots.node),
      el("section", { class: "s-stack is-tight" }, el("div", { class: "s-spread" }, el("p", { class: "s-eyebrow" }, "Buyer texts"), reset),
        draft ? el("span", { class: "s-help" }, "Reset builds fresh texts from the saved labels.") : null,
        title.node, desc.node, delivery.node, coverTitle.node, coverService.node, bullets.node),
      section("Price", price.node, floor.node, el("label", { class: "s-field" }, "Pricing mode", mode), clearance.node, follow.node,
        el("span", { class: "s-help" }, "Clearance and competitor rules act only in Auto mode, and only on the Eldorado price."),
        adopted ? el("span", { class: "s-help" }, "This product is an adopted listing: its price stays fixed, the shop never reprices it.") : null, priceWarn),
      draft ? section("Markets", mk.map((x) => x.c.node), el("span", { class: "s-help" }, "The shop sells codes only on Eldorado. " + GGSEL_NOTE + ".")) : null,
      draft ? null : section("Live listing", pushLive.node,
        el("span", { class: "s-help" }, eldoLive
          ? "Sends what you changed here — the title, the description, the price — to the live Eldorado offer; what you did not change keeps its live value, and the price is sent only when you change it. Without this, the change is saved to the product and its offer here, and the live listing keeps its current text and price."
          : "There is no live Eldorado listing right now; the change is used the next time it is listed.")));
    Soop.drawer({ title: (draft ? "Edit draft — " : "Edit texts and price — ") + (d.name || "product"), size: "lg", sticky: true, body,
      actions: [{ label: "Cancel" }, { label: "Save", tone: "primary", icon: "check", onClick: save }] });
  }

  // ---------- section ---------------------------------------------------------------
  function render(root, state) {
    R.root = root;
    R.groups = {};
    R.mergeBtn = btn("Merge into one bundle", "merge", { icon: "plus", disabled: true, onClick: merge });
    R.mergeHint = el("span", { class: "s-muted s-small" });
    R.merge = el("div", { class: "s-row" }, R.mergeHint, R.mergeBtn);
    R.empty = ui.empty("No products yet", "Drafts appear here once the planner finds enough free codes of one campaign; you can also make one from selected rewards in Stock.");
    const boxes = GROUPS.map((g) => {
      const count = ui.badge("0");
      const grid = el("div", { class: "s-grid" });
      const box = el("section", { class: "s-stack is-tight", hidden: true },
        el("div", { class: "s-spread" },
          el("div", { class: "s-row" }, el("h3", { class: "s-card-title" }, g.label), count, el("span", { class: "s-muted s-small s-hide-sm" }, g.hint)),
          g.id === "draft" ? R.merge : null),
        grid);
      R.groups[g.id] = { box, grid, count };
      return box;
    });
    R.retiredInput = el("input", { type: "checkbox", onChange: () => { showRetired = R.retiredInput.checked; update(R.root, lastState); } });
    R.retiredLabel = el("span", null, "Show retired products");
    root.appendChild(el("div", { class: "s-stack" }, R.empty, boxes, el("label", { class: "s-check" }, R.retiredInput, R.retiredLabel)));
    update(root, state);
  }
  function update(root, state) {
    if (!R.groups) return;
    const st = state || (S() && S().state) || lastState || {};
    lastState = st;
    const products = arr(st.products);
    byId = new Map(products.map((p) => [pid(p), p]));
    const by = { draft: [], active: [], paused: [], retired: [] };
    products.forEach((p) => (by[p.status] || by.active).push(p));
    Array.from(selected).forEach((id) => { const p = byId.get(id); if (!p || p.status !== "draft") selected.delete(id); });
    Array.from(cards.keys()).forEach((id) => { if (!byId.has(id)) cards.delete(id); });

    // A rebuilt card gets keyboard focus back on the same action.
    const a = document.activeElement;
    const fCard = a && a.closest ? a.closest("[data-product]") : null;
    const fId = fCard && R.root.contains(fCard) ? fCard.dataset.product : null, fAct = a && a.dataset ? a.dataset.act : null;

    const byName = (x, y) => String(x.name || "").localeCompare(String(y.name || ""));
    by.draft.sort((x, y) => String(gameOf(x)).localeCompare(String(gameOf(y))) || byName(x, y));
    ["active", "paused", "retired"].forEach((k) => by[k].sort(byName));
    GROUPS.forEach((g) => {
      const grp = R.groups[g.id], list = by[g.id], show = list.length > 0 && (g.id !== "retired" || showRetired);
      grp.count.textContent = fmt.num(list.length);
      grp.box.hidden = !show;
      syncList(grp.grid, show ? list.map(cardNode) : []);
    });
    const open = products.length - by.retired.length;
    R.empty.hidden = open > 0 || (showRetired && by.retired.length > 0);
    R.retiredLabel.textContent = "Show retired products (" + fmt.num(by.retired.length) + ")";
    R.merge.hidden = by.draft.length < 2;
    syncMerge();

    if (fId && fAct) {
      const c = cards.get(fId);
      if (c && c.node !== fCard && document.activeElement !== a) {
        const t = c.node.querySelector('[data-act="' + fAct + '"]');
        if (t && !t.disabled) t.focus({ preventScroll: true });
      }
    }
  }

  let started = false;
  function start() {
    if (started || !window.SoopSales || typeof window.SoopSales.registerSection !== "function") return;
    started = true;
    window.SoopSales.registerSection({ id: "products", label: "Products", render, update });
  }
  start();
  if (!started) {
    document.addEventListener("DOMContentLoaded", start);
    window.addEventListener("load", start);
  }
})();
