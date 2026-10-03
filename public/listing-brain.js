// Price tracker → "Listing brain (test)" (docs/LISTING-BRAIN-PLAN.md §9). TEST MODE: where each game's
// stock would go, what each offer would cost and when a live price would move — beside what today's
// code does at the same moment — and how well the brain's forecasts hold up. It changes nothing: no
// price, listing, shelf or setting moves.
//
// Loaded by a plain <script src> ABOVE the page's inline script, so window.ListingBrainTab exists
// before the page's first render() (a deep link to #listing renders at once). The page's helpers are
// private to its IIFE; its dispatch line hands them in as `c`:
//   { api, shell, stale, esc, money, pct, ago, day, hrs, openSheet, page, state }
// Every render takes a fresh `c`; filters re-render through render(c) with the same one.
//
// This file is public (express.static serves it to anyone): CODE ONLY, never data. Everything it
// shows comes from /api/price-tracker/listing-brain/* (superadmin + 2FA) and every value goes
// through esc() before it touches HTML — tests/listingBrainRoutes.test.js fails on a raw field
// concatenated into markup. State lives under state.lb; element ids start with "lb".
(function () {
  "use strict";
  var C = null; // the page's helpers, set on every render

  function esc(v) { return C.esc(v); }
  function money(n) { return C.money(n); }
  function own(map, k) { return Object.prototype.hasOwnProperty.call(map, k); }
  function label(map, k) { return own(map, k) ? map[k] : k; }
  function cls(map, k) { return own(map, k) ? map[k] : "s-unknown"; }
  function isNum(x) { return x !== null && x !== "" && x !== undefined && isFinite(Number(x)); }
  function usd(n) { return isNum(n) ? esc(money(n)) : "—"; }
  function chance(p) { return isNum(p) ? esc(C.pct(p)) : "—"; }
  function fix(x, d) { return isNum(x) ? esc(Number(x).toFixed(d)) : "—"; }
  function count(x) { return isNum(x) ? esc(x) : "—"; }
  function signed(x, d) { return isNum(x) ? (Number(x) > 0 ? "+" : "") + esc(Number(x).toFixed(d)) : "—"; }
  function pill(c, text, title) { return '<span class="pill ' + c + '"' + (title ? ' title="' + esc(title) + '"' : "") + ">" + esc(text) + "</span>"; }
  function chip(text) { return '<span class="chip">' + esc(text) + "</span>"; }
  function sec(text) { return '<h4 class="sec">' + esc(text) + "</h4>"; }
  function bar(share) { var w = isNum(share) ? Math.round(Math.max(0, Math.min(1, Number(share))) * 80) : 0; return '<span class="bar" style="width:' + esc(w) + 'px"></span>'; }
  // A value of unknown shape (a count, a word, a flag): shown as itself, never as markup.
  function val(x) {
    if (x === null || x === undefined || x === "") return "—";
    if (x === true) return "yes";
    if (x === false) return "no";
    if (typeof x === "object") return esc(JSON.stringify(x));
    return esc(x);
  }
  // A shelf is a number of units, or (a game's placement row) units per market.
  function shelfTxt(x) {
    if (x === null || x === undefined) return "—";
    if (typeof x !== "object") return count(x);
    var total = 0, parts = [];
    Object.keys(x).forEach(function (m) { if (isNum(x[m])) { total += Number(x[m]); if (Number(x[m])) parts.push(label(MARKET_LABEL, m) + " " + String(x[m])); } });
    return esc(total) + (parts.length ? " <small>(" + esc(parts.join(", ")) + ")</small>" : "");
  }

  /* --------------------------------- words --------------------------------- */
  var LB_VIEWS = [["overview", "Overview"], ["cells", "Cells"], ["accuracy", "Accuracy"]];
  var FARMS = ["claim", "noclaim"];
  var FARM_LABEL = { claim: "Auto-farm (claim farm)", noclaim: "No-claim farm" };
  var LB_MARKETS = ["gameflip", "digiseller", "ggsel", "zeusx", "eldorado", "playerauctions", "g2g"];
  var MARKET_LABEL = { gameflip: "Gameflip", digiseller: "Plati (Digiseller)", ggsel: "GGSel", zeusx: "ZeusX", eldorado: "Eldorado", playerauctions: "PlayerAuctions", g2g: "G2G", all: "all markets (placement)" };
  var PRICE_CLASSES = ["agree", "brain-lower", "brain-higher", "no-evidence", "managed", "ladder"];
  var PC_LABEL = { agree: "same price", "brain-lower": "brain: lower", "brain-higher": "brain: higher", "no-evidence": "brain: no evidence", managed: "owner-managed (shown, never advised)", ladder: "price ladder (left alone)" };
  var PC_CLS = { agree: "s-ok", "brain-lower": "s-less", "brain-higher": "s-more", "no-evidence": "s-unknown", managed: "s-info", ladder: "s-info" };
  var SHELF_CLASSES = ["agree", "brain-more", "brain-fewer", "brain-add", "brain-drop", "closed", "unknown", "unmeasured", "managed"];
  var SC_LABEL = { agree: "same shelf", "brain-more": "brain: more units", "brain-fewer": "brain: fewer units", "brain-add": "brain: list here (today none)", "brain-drop": "brain: none here (today lists)", closed: "market closed", unknown: "mapping not proven", unmeasured: "cannot be measured", managed: "owner-managed" };
  var SC_CLS = { agree: "s-ok", "brain-more": "s-more", "brain-fewer": "s-less", "brain-add": "s-more", "brain-drop": "s-warn", closed: "s-unknown", unknown: "s-unknown", unmeasured: "s-unknown", managed: "s-info" };
  var ACTIONS = ["hold", "lower", "raise", "test", "ladder"];
  var ACT_LABEL = { hold: "hold", lower: "lower one step", raise: "raise", test: "test one unit higher", ladder: "ladder (left alone)", "new": "new listing", none: "no evidence" };
  var ACT_CLS = { hold: "s-ok", lower: "s-less", raise: "s-more", test: "s-info", ladder: "s-info", "new": "s-info", none: "s-unknown" };
  var REGIMES = ["scarce", "balanced", "overstock", "unknown"];
  var REGIME_LABEL = { scarce: "scarce — the price can go up", balanced: "balanced", overstock: "overstock — sell faster", unknown: "unknown — no fresh farm-brain row" };
  var BASIS_LABEL = { "exact-here": "these exact items sold here", "band-here": "same game and size sold here", translated: "translated from other markets", rivals: "rivals' sold prices", venue: "this market's typical order", none: "no evidence" };
  var GATE_LABEL = { confidence: "confidence below medium: hold", "raise-rule": "raise cut back: too few sales at that price", step: "step limit (one move at most)", "ggsel-raise-only": "GGSel: never lowered", floor: "market floor", "cool-down": "cool-down after a recent move", stale: "stale: older than its expected sale", thin: "thin evidence: never picked" };
  var FLAG_LABEL = { "fee-assumed": "fee assumed, not verified", anchor: "Gameflip shelf of 0 (today's path keeps one)", noRemove: "GGSel cannot remove a unit", setmin: "set minimum blocks a lower relist", script: "operator-script rows (claim-at-sale)", blind: "radar does not watch this market", endApprox: "end of exposure approximate", stockout: "repeated stock-outs" };
  var ELIG_LABEL = { open: "open", closed: "closed", unknown: "mapping not proven", unmeasured: "cannot be measured (no sale records)", managed: "owner-managed" };
  var PRICE_POLICIES = ["old", "tracker", "curve", "clear"];
  var PRICE_POL_LABEL = { old: "today's rule", tracker: "price tracker's suggestion", curve: "brain: sell-through curve", clear: "rivals' sold median" };
  var PLACE_POLICIES = ["flat", "share30", "instock", "newsvendor"];
  var PLACE_POL_LABEL = { flat: "today's split (flat)", share30: "last 30 days' sales share", instock: "in-stock sell rate", newsvendor: "brain (newsvendor)" };
  var SORTS = [["gap", "Sort: biggest disagreement"], ["value", "Sort: weekly value"], ["price", "Sort: price gap"], ["shelf", "Sort: shelf gap"], ["market", "Sort: market"]];
  var PAGE_SIZE = 50;
  var searchTimer = null;

  function pcPill(pc) { return pc ? pill(cls(PC_CLS, pc), label(PC_LABEL, pc)) : ""; }
  function scPill(sc) { return sc ? pill(cls(SC_CLS, sc), label(SC_LABEL, sc)) : ""; }
  function actPill(a) { return a ? pill(cls(ACT_CLS, a), label(ACT_LABEL, a)) : ""; }
  function flagChips(fl) { return (fl || []).map(function (f) { return chip(label(FLAG_LABEL, f)); }).join(" "); }
  function disagrees(r) { return r.pc === "brain-lower" || r.pc === "brain-higher" || r.sc === "brain-more" || r.sc === "brain-fewer" || r.sc === "brain-add" || r.sc === "brain-drop"; }
  function horizon(f) {
    var cfg = (C.state.lb && C.state.lb.cfg) || {};
    var h = f === "noclaim" ? cfg.horizonDaysNoclaim : cfg.horizonDaysClaim;
    return isNum(h) ? "within " + h + " d" : "within the horizon";
  }
  function cellKey(r) { return String(r.k) + "|" + String(r.f) + "|" + String(r.m); }
  function livePill(r) { return r.live ? pill("s-ok", "campaign live" + (isNum(r.hl) ? " · " + C.hrs(r.hl) + " left" : "")) : ""; }
  function farmPill(f) { return f === "noclaim" ? pill("s-info", "no-claim farm") : ""; }
  function todayPrice(o) { return isNum(o.a) ? usd(o.a) : isNum(o.np) ? usd(o.np) + " <small>(new)</small>" : "—"; }

  function statusLine(st) {
    if (!st) return "";
    var cfg = st.config || {};
    var head = cfg.enabled ? pill("s-ok", "test log ON") : pill("s-unknown", "test log OFF");
    var notLogged = st.persisted === false || st.lastPersisted === false || !!st.notLogged || !!st.lastPersistError;
    var hb = typeof st.heartbeat === "string" ? st.heartbeat : typeof st.lastHeartbeat === "string" ? st.lastHeartbeat : "";
    return '<div class="basisbar">' + head + " Runs since the last restart: " + count(st.runs || 0) +
      (st.lastRunAt ? " · last " + esc(C.ago(st.lastRunAt)) + (isNum(st.lastMs) ? " (" + fix(Number(st.lastMs) / 1000, 1) + " s)" : "") : "") +
      (st.running ? " · running now" : "") +
      (st.nextRunAt ? " · next in " + esc(Math.max(0, Math.round((new Date(st.nextRunAt).getTime() - Date.now()) / 60000))) + " min" : "") +
      (notLogged ? ' · <span class="bad">last run NOT LOGGED' + (st.lastPersistError ? ": " + esc(st.lastPersistError) : "") + "</span>" : "") +
      (st.lastError ? ' · last error: <span class="bad">' + esc(st.lastError) + "</span>" : "") +
      (cfg.enabled ? " · every " + esc(cfg.intervalMin) + " min" : '. Switch on with settings <span class="mono">autoFarm.listingBrain.enabled = true</span> (no restart).') +
      " Test mode: it writes down what it would decide and changes nothing." +
      (hb ? '<div class="mono" style="margin-top:6px">' + esc(hb) + "</div>" : "") + "</div>";
  }

  function card(title, sub, cells) {
    return '<div class="vcard"><div class="top"><span class="nm">' + esc(title) + "</span></div>" + (sub ? '<div class="note">' + sub + "</div>" : "") +
      '<div class="mini">' + cells.map(function (c) { return "<div><b>" + esc(c[0]) + "</b><span>" + esc(c[1]) + "</span></div>"; }).join("") + "</div></div>";
  }
  function n0(x) { return isNum(x) ? Number(x) : 0; }

  // One cell as a list row (the overview's disagreements).
  function cellRow(r) {
    var o = r.old || {}, b = r.br || {};
    var all = r.m === "all";
    var amt = all
      ? "shelf today " + shelfTxt(o.sh) + ' <span class="arrow">→</span> brain <b>' + shelfTxt(b.sh) + "</b>"
      : "today " + todayPrice(o) + ' <span class="arrow">→</span> brain <b>' + usd(b.p) + "</b>";
    var r2 = all
      ? "<span>reserve " + count(b.rsv) + "</span><span>bulk " + count(b.bt) + "</span>" + (b.ex ? "<span>exploring " + esc(label(MARKET_LABEL, b.ex)) + "</span>" : "") + (isNum(b.w) ? "<span>sells " + esc(b.w) + "/wk</span>" : "")
      : pcPill(r.pc) + scPill(r.sc) + "<span>sells " + esc(horizon(r.f)) + ": " + chance(b.p7a) + ' <span class="arrow">→</span> ' + chance(b.p7) + "</span>" +
        (isNum(b.wv) ? "<span>≈ " + usd(b.wv) + "/wk</span>" : "") + "<span>shelf " + shelfTxt(o.sh) + ' <span class="arrow">→</span> ' + shelfTxt(b.sh) + "</span>" +
        (b.cf ? "<span>confidence " + esc(b.cf) + "</span>" : "");
    return '<div class="row clickable" data-lbkey="' + esc(cellKey(r)) + '"><div class="r1"><span class="t">' + esc(r.g) + " " + pill("s-info", label(MARKET_LABEL, r.m)) + " " + farmPill(r.f) + " " + livePill(r) +
      '</span><span class="amt">' + amt + "</span></div>" +
      '<div class="r2">' + r2 + (b.rg ? "<span>" + esc(label(REGIME_LABEL, b.rg)) + "</span>" : "") + "</div>" +
      (r.why && r.why.length ? '<div class="why">' + r.why.map(esc).join(" ") + "</div>" : "") + "</div>";
  }

  // One cell as a table row (the Cells view).
  function cellTr(r) {
    var o = r.old || {}, b = r.br || {};
    var all = r.m === "all";
    return '<tr class="lbrow" data-lbkey="' + esc(cellKey(r)) + '" style="cursor:pointer"><td>' + esc(r.g) + " " + livePill(r) + "</td><td>" + esc(r.f === "noclaim" ? "no-claim" : "claim") + "</td><td>" + esc(label(MARKET_LABEL, r.m)) + "</td>" +
      (all ? '<td colspan="3"><small>placement row</small></td>' : "<td>" + todayPrice(o) + "</td><td><b>" + usd(b.p) + "</b>" + (b.cf ? "<small>" + esc(b.cf) + "</small>" : "") + "</td><td>" + pcPill(r.pc) + "</td>") +
      "<td>" + shelfTxt(o.sh) + "</td><td><b>" + shelfTxt(b.sh) + "</b>" + (all && isNum(b.rsv) ? "<small>reserve " + esc(b.rsv) + "</small>" : "") + "</td><td>" + scPill(r.sc) + "</td>" +
      (all ? "<td>—</td><td>—</td>" : "<td>" + chance(b.p7a) + ' <span class="arrow">→</span> ' + chance(b.p7) + "</td><td>" + usd(b.wva) + ' <span class="arrow">→</span> ' + usd(b.wv) + "</td>") + "</tr>";
  }

  function wireCells() {
    Array.prototype.forEach.call(C.page.querySelectorAll("[data-lbkey]"), function (el) {
      el.onclick = function () { openCell(el.getAttribute("data-lbkey")); };
    });
  }

  /* -------------------------------- render -------------------------------- */
  async function render(c) {
    C = c;
    var f = c.state.lb || (c.state.lb = { view: "overview", farm: "", m: "", pc: "", sc: "", live: "", q: "", sort: "gap", offset: 0, cfg: null });
    var views = '<select id="lbv">' + LB_VIEWS.map(function (v) { return '<option value="' + esc(v[0]) + '"' + (v[0] === f.view ? " selected" : "") + ">" + esc(v[1]) + "</option>"; }).join("") + "</select>";
    var extra = "";
    if (f.view === "cells") {
      extra = '<select id="lbf"><option value="">Both farms</option><option value="claim">Auto-farm (claim)</option><option value="noclaim">No-claim farm</option></select>' +
        '<select id="lbm"><option value="">All markets</option>' + LB_MARKETS.concat(["all"]).map(function (m) { return '<option value="' + esc(m) + '">' + esc(MARKET_LABEL[m]) + "</option>"; }).join("") + "</select>" +
        '<select id="lbp"><option value="">Any price comparison</option>' + PRICE_CLASSES.map(function (k) { return '<option value="' + esc(k) + '">' + esc(PC_LABEL[k]) + "</option>"; }).join("") + "</select>" +
        '<select id="lbs"><option value="">Any shelf comparison</option>' + SHELF_CLASSES.map(function (k) { return '<option value="' + esc(k) + '">' + esc(SC_LABEL[k]) + "</option>"; }).join("") + "</select>" +
        '<select id="lbl"><option value="">Live campaign or not</option><option value="1">Campaign live now</option></select>' +
        '<select id="lbo">' + SORTS.map(function (s) { return '<option value="' + esc(s[0]) + '">' + esc(s[1]) + "</option>"; }).join("") + "</select>" +
        '<input id="lbq" type="search" placeholder="Search a game" value="' + esc(f.q) + '">';
    }
    var g = c.shell('<div class="ctl">' + views + extra + '</div><div id="lbx"><div class="empty">Loading…</div></div>');
    var bind = function (id, key) {
      var el = c.page.querySelector("#" + id);
      if (!el) return;
      el.value = f[key];
      el.onchange = function () { f[key] = el.value; f.offset = 0; render(c); };
    };
    bind("lbv", "view"); bind("lbf", "farm"); bind("lbm", "m"); bind("lbp", "pc"); bind("lbs", "sc"); bind("lbl", "live"); bind("lbo", "sort");
    var lbq = c.page.querySelector("#lbq");
    if (lbq) lbq.oninput = function () { clearTimeout(searchTimer); searchTimer = setTimeout(function () { if (c.stale(g)) return; f.q = lbq.value; f.offset = 0; render(c); }, 350); };
    if (f.view === "cells") return renderCells(c, f, g);
    if (f.view === "accuracy") return renderAccuracy(c, f, g);
    return renderOverview(c, f, g);
  }

  function box() { return C.page.querySelector("#lbx"); }

  /* ------------------------------- overview ------------------------------- */
  async function renderOverview(c, f, g) {
    var j = await c.api("/api/price-tracker/listing-brain/latest?live=1&sort=gap&limit=8");
    if (c.stale(g)) return;
    if (j.empty) {
      var cf0 = (j.status && j.status.config) || {};
      box().innerHTML = statusLine(j.status) + '<div class="empty">No run logged yet. When the test log is on, the first run comes about 9 minutes after a restart (after the farm brain\'s first run), then every ' + esc(isNum(cf0.intervalMin) ? cf0.intervalMin : 180) + " minutes.</div>";
      return;
    }
    f.cfg = j.cfg || null;
    var top = (j.rows || []).filter(disagrees), topLive = true;
    if (!top.length) {
      var ja = await c.api("/api/price-tracker/listing-brain/latest?sort=gap&limit=8");
      if (c.stale(g)) return;
      top = (ja.rows || []).filter(disagrees);
      topLive = false;
    }
    var s = j.summary || {}, cfg = j.cfg || {};
    var get = function (k, farm) { return (s[k] && s[k][farm]) || {}; };
    var farmBlock = function (farm) {
      var bp = get("byPrice", farm), bs = get("byShelf", farm), sh = get("shelf", farm), v = get("value", farm), ac = get("actions", farm), rg = get("regimes", farm);
      var shelfSub = "like for like on the " + esc(n0(sh.compared)) + " cells both sides can place" +
        (n0(sh.unknownCells) ? "; on the other " + esc(sh.unknownCells) + " the brain has no evidence and today's code lists " + esc(n0(sh.oldUnknown)) + " (counted apart, never as zero)" : "");
      return sec(FARM_LABEL[farm]) + '<div class="vgrid">' +
        card("Prices", "every cell with a live or new listing, by how the brain's price compares with today's", PRICE_CLASSES.map(function (k) { return [n0(bp[k]), PC_LABEL[k]]; })) +
        card("Shelf", "units each market would hold, brain versus today", SHELF_CLASSES.filter(function (k) { return n0(bs[k]) || k === "agree" || k.indexOf("brain-") === 0; }).map(function (k) { return [n0(bs[k]), SC_LABEL[k]]; })) +
        card("Units on the shelf", shelfSub, [[n0(sh.old), "today"], [n0(sh.brain), "brain"], [n0(sh.reserve), "brain holds back (released as shelves empty)"], [n0(sh.bulkTake), "set aside for bulk"]]) +
        card("Weekly value", "expected net a week after fees, on the " + esc(n0(v.compared)) + " cells both sides price", [[isNum(v.old) ? money(v.old) : "—", "today"], [isNum(v.brain) ? money(v.brain) : "—", "brain"], [isNum(v.old) && isNum(v.brain) ? (Number(v.brain) >= Number(v.old) ? "+" : "") + money(Number(v.brain) - Number(v.old)).replace("$-", "-$") : "—", "difference"]]) +
        card("Live listings — what the brain would do", "system-made listings only; hand-made and claim-at-sale rows are never advised", ACTIONS.map(function (k) { return [n0(ac[k]), ACT_LABEL[k]]; })) +
        card("Games by regime", "from the farm brain's forecast and the stock on hand", REGIMES.map(function (k) { return [n0(rg[k]), REGIME_LABEL[k]]; })) +
        "</div>";
    };
    var flags = s.flags || {};
    var flagList = Object.keys(flags).filter(function (k) { return n0(flags[k]); }).map(function (k) { return chip(label(FLAG_LABEL, k) + " · " + String(flags[k])); }).join(" ");
    box().innerHTML = statusLine(j.status) +
      '<div class="basisbar">Run ' + esc(C.ago(j.at)) + (isNum(j.ms) ? " (" + fix(Number(j.ms) / 1000, 1) + " s)" : "") + (j.logged === false ? " · not written to the log (log off for this run)" : j.persisted ? "" : ' · <span class="bad">this run could not be written to the log (NOT LOGGED)</span>') +
      (isNum(s.cells) ? " · " + esc(s.cells) + " cells" : "") + (isNum(s.games) ? " in " + esc(s.games) + " games" : "") +
      ". Both sides are worked out at the same moment: <b>today</b> = what today's code does (the median ask of our system-made listings, the price a new listing would get now, today's split of the stock); " +
      "<b>brain</b> = the price with the best expected net from the sell-through curve, and a shelf that puts each unit where it most likely sells. A cell is one game × farm × market. The two farms are modelled apart.</div>" +
      FARMS.map(farmBlock).join("") +
      (flagList ? sec("Flags") + '<div class="chips">' + flagList + "</div>" : "") +
      (top.length ? sec(topLive ? "Biggest disagreements on live campaigns" : "Biggest disagreements (none on a live campaign)") + '<div class="rows">' + top.map(cellRow).join("") + "</div>" : "") +
      sec("Settings in use") + '<div class="basisbar">Sell chance within <b>' + esc(cfg.horizonDaysClaim) + " days</b> (auto-farm) and <b>" + esc(cfg.horizonDaysNoclaim) + " days</b> (no-claim). Sell-through fitted on the last " + esc(cfg.fitDaysClaim) + " / " + esc(cfg.fitDaysNoclaim) + " days; reference prices from the last " + esc(cfg.refDays) +
      " days. A price needs " + esc(cfg.minSales) + " sales to count; moves at most " + esc(cfg.maxStepPct) + "% at a time, " + esc(cfg.cooldownH) + " h apart. Asked by the next round's publishers, it would answer with <b>" + esc(label(PRICE_POL_LABEL, cfg.policyPrice)) + "</b> for prices and <b>" + esc(label(PLACE_POL_LABEL, cfg.policyPlace)) +
      "</b> for shelves. All adjustable live under <span class=\"mono\">autoFarm.listingBrain</span>.</div>" +
      ((j.notes || []).length ? sec("Notes from this run") + j.notes.map(function (n) { return '<div class="flagbox info">' + esc(n) + "</div>"; }).join("") : "") +
      '<div class="basisbar">What test mode cannot show: whether a <b>different</b> price would have sold. Every comparison here is between what the brain would have said and what happened at the price that was actually asked.</div>';
    wireCells();
  }

  /* --------------------------------- cells --------------------------------- */
  async function renderCells(c, f, g) {
    var qs = "farm=" + encodeURIComponent(f.farm) + "&m=" + encodeURIComponent(f.m) + "&pc=" + encodeURIComponent(f.pc) + "&sc=" + encodeURIComponent(f.sc) + "&live=" + encodeURIComponent(f.live) +
      "&sort=" + encodeURIComponent(f.sort) + "&q=" + encodeURIComponent(f.q) + "&limit=" + PAGE_SIZE + "&offset=" + encodeURIComponent(f.offset);
    var j = await c.api("/api/price-tracker/listing-brain/latest?" + qs);
    if (c.stale(g)) return;
    if (j.empty) { box().innerHTML = statusLine(j.status) + '<div class="empty">No run logged yet.</div>'; return; }
    f.cfg = j.cfg || f.cfg;
    var rows = j.rows || [];
    var th = function (text, sort) {
      return sort ? '<th data-lbsort="' + esc(sort) + '" style="cursor:pointer">' + esc(text) + (f.sort === sort ? " ▾" : "") + "</th>" : "<th>" + esc(text) + "</th>";
    };
    var total = Number(j.total) || 0;
    box().innerHTML = statusLine(j.status) +
      '<div class="basisbar">Run ' + esc(C.ago(j.at)) + ". Live campaigns first. <b>Sell chance</b> = the chance a unit sells " + esc(horizon("claim")) + " (auto-farm) or " + esc(horizon("noclaim")) + " (no-claim), at today's ask → at the brain's price. <b>Weekly value</b> = expected net a week after fees. A market “all” row is the game's placement. Open a cell for its reasons, offers and history.</div>" +
      (rows.length
        ? '<div class="scroll"><table class="pm"><tr>' + th("game") + th("farm") + th("market", "market") + th("today's price") + th("brain's price") + th("price", "price") + th("today's shelf") + th("brain's shelf") + th("shelf", "shelf") + th("sell chance") + th("weekly value", "value") + "</tr>" + rows.map(cellTr).join("") + "</table></div>"
        : '<div class="empty">Nothing matches.</div>') +
      '<div class="ctl" style="margin-top:12px">' + (f.offset > 0 ? '<button id="lbpv">← Previous</button>' : "") + (f.offset + PAGE_SIZE < total ? '<button id="lbnx">Next →</button>' : "") + '<span class="sub">' + esc(total) + " cells</span></div>";
    var nx = c.page.querySelector("#lbnx"), pv = c.page.querySelector("#lbpv");
    if (nx) nx.onclick = function () { f.offset += PAGE_SIZE; render(c); };
    if (pv) pv.onclick = function () { f.offset = Math.max(0, f.offset - PAGE_SIZE); render(c); };
    Array.prototype.forEach.call(c.page.querySelectorAll("[data-lbsort]"), function (el) {
      el.onclick = function () { f.sort = el.getAttribute("data-lbsort"); f.offset = 0; render(c); };
    });
    wireCells();
  }

  /* ------------------------------- cell sheet ------------------------------- */
  // cells: [already-escaped HTML for the value, plain-text label]
  function kv(cells) { return '<div class="kv">' + cells.map(function (x) { var valueHtml = x[0]; return "<div><b>" + valueHtml + "</b><span>" + esc(x[1]) + "</span></div>"; }).join("") + "</div>"; }

  function offerBlock(o, f) {
    var live = (o.live || []).map(function (x) {
      return "<tr><td>" + usd(x.ask) + "</td><td>" + fix(x.ageDays, 1) + " d</td><td>" + actPill(x.a) + "</td><td>" + chance(x.p7a) + "</td></tr>";
    }).join("");
    return '<div class="row"><div class="r1"><span class="t">' + esc(isNum(o.n) ? String(o.n) + " item" + (Number(o.n) === 1 ? "" : "s") : "offer") + " " + actPill(o.action) +
      (o.thin ? " " + pill("s-unknown", "thin evidence") : "") + (o.stale ? " " + pill("s-warn", "stale") : "") +
      '</span><span class="amt">' + (isNum(o.raw) && o.raw !== o.p ? usd(o.raw) + ' <span class="arrow">→</span> ' : "") + "<b>" + usd(o.p) + "</b></span></div>" +
      '<div class="r2"><span>reference ' + usd(o.ref) + "</span><span>confidence " + esc(o.conf || "none") + "</span><span>" + esc(label(BASIS_LABEL, o.basis)) + "</span>" +
      (o.regime ? "<span>" + esc(label(REGIME_LABEL, o.regime)) + "</span>" : "") +
      "<span>sells " + esc(horizon(f)) + ": " + chance(o.pHask) + " at the ask → " + chance(o.pH) + " at the brain's price</span>" + (isNum(o.value) ? "<span>value " + usd(o.value) + "</span>" : "") + "</div>" +
      ((o.gates || []).length ? '<div class="chips">' + o.gates.map(function (x) { return chip(label(GATE_LABEL, x)); }).join("") + "</div>" : "") +
      ((o.why || []).length ? '<div class="why">' + o.why.map(esc).join(" ") + "</div>" : "") +
      (live ? '<div class="scroll" style="margin-top:7px"><table class="pm"><tr><th>live ask</th><th>age</th><th>brain would</th><th>sell chance at the ask</th></tr>' + live + "</table></div>" : "") + "</div>";
  }

  async function openCell(key) {
    var st = C.state;
    var tok = (st.sheetTok = (st.sheetTok || 0) + 1);
    C.openSheet("Loading…", '<div class="empty">Loading…</div>');
    try {
      var j = await C.api("/api/price-tracker/listing-brain/cell/" + encodeURIComponent(key));
      if (tok !== st.sheetTok) return;
      var r = j.row || (j.history && j.history[0]) || {};
      var o = r.old || {}, b = r.br || {}, e = r.ev || {}, all = j.m === "all";
      var title = String(r.g || j.g || key) + " · " + label(MARKET_LABEL, j.m) + (j.f === "noclaim" ? " — no-claim farm" : "");
      var head = all
        ? kv([[shelfTxt(o.sh), "today's shelf"], [shelfTxt(o.cur), "on the shelf now"], ["<b>" + shelfTxt(b.sh) + "</b>", "brain's shelf"], [count(b.rsv), "brain holds back"], [count(b.bt), "set aside for bulk"],
          [b.ex ? esc(label(MARKET_LABEL, b.ex)) : "—", "one exploration unit on"], [isNum(b.w) ? esc(b.w) + "/wk" : "—", "farm brain's weekly forecast"], [count(b.on), "stock on hand"], [isNum(b.cov) ? fix(b.cov, 1) + " wk" : "—", "cover"]])
        : kv([[todayPrice(o), "today's ask (median, system-made)"], [count(o.n), "units listed by system-made rows"], [usd(o.np), "a new listing today"], ["<b>" + usd(b.p) + "</b>", "brain's price"],
          [usd(b.ref), "reference price"], [chance(b.p7a), "sells " + horizon(j.f) + " at today's ask"], [chance(b.p7), "at the brain's price"], [usd(b.wva), "weekly value at today's ask"], [usd(b.wv), "at the brain's price"],
          [shelfTxt(o.sh) + ' <span class="arrow">→</span> ' + shelfTxt(b.sh), "shelf: today → brain"], [shelfTxt(o.cur), "on the shelf now"]]);
      var pills = '<div class="chips" style="margin:8px 0">' + livePill(r) + " " + pcPill(r.pc) + " " + scPill(r.sc) +
        (b.rg ? " " + pill("s-unknown", label(REGIME_LABEL, b.rg)) : "") + (b.cf ? " " + chip("confidence " + String(b.cf)) : "") + (b.b ? " " + chip(label(BASIS_LABEL, b.b)) : "") + " " + flagChips(r.fl) + "</div>";
      var acts = b.a && typeof b.a === "object" ? ACTIONS.filter(function (k) { return n0(b.a[k]); }).map(function (k) { return chip(label(ACT_LABEL, k) + " · " + String(b.a[k])); }).join(" ") : "";
      var evid = Object.keys(e).length ? kv([[count(e.o), "orders behind the reference price"], [count(e.s), "sales in the fit window"], [fix(e.d, 1), "listing-days on sale"], [val(e.thin), "thin evidence"],
        [e.el ? esc(label(ELIG_LABEL, e.el)) : "—", "market for this game"], [val(e.fee), "fee"], [val(e.blind), "radar blind here"]]) : "";
      var pol = r.pol && typeof r.pol === "object" && Object.keys(r.pol).length
        ? '<div class="scroll"><table class="pm"><tr><th>way of pricing</th><th>price</th></tr>' + PRICE_POLICIES.map(function (k) { return "<tr><td>" + esc(PRICE_POL_LABEL[k]) + ' <small class="mono">' + esc(k) + "</small></td><td>" + usd(r.pol[k]) + "</td></tr>"; }).join("") + "</table></div>" : "";
      var pf = r.pf && typeof r.pf === "object" && Object.keys(r.pf).length
        ? '<div class="scroll"><table class="pm"><tr><th>way of placing</th><th>units sold in 7 days (forecast)</th></tr>' + PLACE_POLICIES.map(function (k) { return "<tr><td>" + esc(PLACE_POL_LABEL[k]) + ' <small class="mono">' + esc(k) + "</small></td><td>" + fix(r.pf[k], 2) + "</td></tr>"; }).join("") + "</table></div>" : "";
      var offers = (j.offers || []).map(function (x) { return offerBlock(x, j.f); }).join("");
      var hist = (j.history || []).map(function (h) {
        var ho = h.old || {}, hb = h.br || {};
        var at = h.at ? new Date(h.at) : null;
        var when = at && !isNaN(at.getTime()) ? at.toISOString().slice(5, 16).replace("T", " ") : "—";
        return "<tr><td>" + esc(when) + "</td><td>" + (h.live ? "live" : "") + "</td>" +
          (all ? "<td>" + shelfTxt(ho.sh) + "</td><td>" + shelfTxt(hb.sh) + "</td><td>" + count(hb.rsv) + "</td>" : "<td>" + todayPrice(ho) + "</td><td>" + usd(hb.p) + "</td><td>" + pcPill(h.pc) + "</td><td>" + shelfTxt(ho.sh) + " → " + shelfTxt(hb.sh) + "</td><td>" + scPill(h.sc) + "</td>") + "</tr>";
      }).join("");
      var histHead = all ? "<th>time (UTC)</th><th></th><th>today's shelf</th><th>brain's shelf</th><th>held back</th>" : "<th>time (UTC)</th><th></th><th>today</th><th>brain</th><th>price</th><th>shelf</th><th></th>";
      C.openSheet(title,
        head + pills +
        (acts ? '<div class="note">Live system-made listings here — the brain would: ' + acts + "</div>" : "") +
        (r.why && r.why.length ? r.why.map(function (w) { return '<div class="flagbox info">' + esc(w) + "</div>"; }).join("") : '<div class="note">Reasons are kept for the newest run only.</div>') +
        (evid ? sec("Evidence") + evid : "") +
        (pol ? sec("Every way of pricing this cell, now") + pol : "") +
        (pf ? sec("Every way of placing stock here, now") + pf : "") +
        (all ? "" : sec("Offers (exact items) on this market") + (offers ? '<div class="rows">' + offers + "</div>" : '<div class="empty">Offer detail is kept for the newest run in memory only (gone after a restart until the next run).</div>')) +
        sec("History (newest first)") + '<div class="scroll"><table class="pm"><tr>' + histHead + "</tr>" + (hist || '<tr><td colspan="7">Not logged yet.</td></tr>') + "</table></div>");
    } catch (err) {
      if (tok === st.sheetTok) C.openSheet("Error", '<div class="empty">' + esc(err.message) + "</div>");
    }
  }

  /* -------------------------------- accuracy -------------------------------- */
  function calibrationBlock(cal) {
    cal = cal || {};
    var farms = FARMS.filter(function (f) { return cal[f]; });
    if (!farms.length) return '<div class="empty">Not enough history yet.</div>';
    var head = '<div class="scroll"><table class="pm"><tr><th>farm</th><th>listings scored</th><th>Brier (brain)</th><th>Brier (baseline)</th><th>skill</th><th></th></tr>' + farms.map(function (f) {
      var x = cal[f];
      var verdict = !n0(x.n) ? pill("s-unknown", "not enough history yet") : isNum(x.skill) && Number(x.skill) > 0 ? pill("s-ok", "beats the baseline") : pill("s-warn", "does not beat the baseline yet — do not trust its prices");
      return "<tr><td>" + esc(FARM_LABEL[f]) + "</td><td>" + count(x.n) + "</td><td>" + fix(x.brier, 3) + "</td><td>" + fix(x.brierBase, 3) + "</td><td>" + (isNum(x.skill) ? signed(Number(x.skill) * 100, 1) + "%" : "—") + "</td><td>" + verdict + "</td></tr>";
    }).join("") + "</table></div>";
    var rel = farms.map(function (f) {
      var bins = (cal[f].reliability || []).filter(function (r) { return n0(r.n); });
      if (!bins.length) return "";
      return '<div class="scroll" style="margin-top:8px"><table class="pm"><tr><th>' + esc(FARM_LABEL[f]) + ": forecast chance</th><th>listings</th><th>average forecast</th><th>really sold</th><th></th></tr>" + bins.map(function (r) {
        return "<tr><td>" + chance(r.lo) + "–" + chance(r.hi) + "</td><td>" + count(r.n) + "</td><td>" + chance(r.meanP) + "</td><td>" + chance(r.rate) + "</td><td>" + bar(r.rate) + "</td></tr>";
      }).join("") + "</table></div>";
    }).join("");
    return head + rel;
  }

  function discriminationBlock(dis) {
    dis = dis || {};
    var farms = FARMS.filter(function (f) { return dis[f]; });
    if (!farms.length) return '<div class="empty">Not enough history yet.</div>';
    return farms.map(function (f) {
      var d = dis[f];
      var acts = ["hold", "lower", "raise", "test"].filter(function (a) { return d[a]; });
      if (!acts.length) return "";
      return '<div class="scroll" style="margin-top:8px"><table class="pm"><tr><th>' + esc(FARM_LABEL[f]) + ": the brain said</th><th>listings</th><th>sold within the horizon</th><th>sell rate</th></tr>" + acts.map(function (a) {
        var x = d[a];
        return "<tr><td>" + actPill(a) + "</td><td>" + count(x.n) + "</td><td>" + count(x.sold) + "</td><td>" + (n0(x.n) ? chance(x.rate) : "not enough history yet") + "</td></tr>";
      }).join("") + "</table></div>";
    }).join("");
  }

  function placementBlock(pl) {
    pl = pl || {};
    var farms = FARMS.filter(function (f) { return pl[f]; });
    if (!farms.length) return '<div class="empty">Not enough history yet.</div>';
    return farms.map(function (f) {
      var m = pl[f];
      var best = typeof m.best === "string" ? m.best : null;
      var isPartial = function (k) { return (Array.isArray(m.partial) && m.partial.indexOf(k) >= 0) || !!(m[k] && m[k].partial); };
      var ids = PLACE_POLICIES.filter(function (k) { return m[k]; }).sort(function (a, b) { return (isNum(m[a].rmse) ? Number(m[a].rmse) : 1e9) - (isNum(m[b].rmse) ? Number(m[b].rmse) : 1e9); });
      if (!ids.length) return sec(FARM_LABEL[f]) + '<div class="empty">Not enough history yet.</div>';
      return sec(FARM_LABEL[f]) + '<div class="scroll"><table class="pm"><tr><th>way of placing stock</th><th>typical miss (RMSE)</th><th>average miss</th><th>bias</th><th>cell-weeks</th></tr>' + ids.map(function (k) {
        var s = m[k], partial = isPartial(k), isBest = !partial && best === k;
        return "<tr><td>" + (isBest ? "<b>" : "") + esc(PLACE_POL_LABEL[k]) + (isBest ? " ✓ best</b>" : "") + (partial ? " — not enough history yet" : "") + ' <small class="mono">' + esc(k) + "</small></td><td>" + fix(s.rmse, 2) + "</td><td>" + fix(s.mae, 2) + "</td><td>" + signed(s.bias, 2) + "</td><td>" + count(s.n) + "</td></tr>";
      }).join("") + "</table></div>";
    }).join("");
  }

  function agreementBlock(ag) {
    ag = ag || {};
    var markets = Object.keys(ag).filter(function (m) { return ag[m] && typeof ag[m] === "object"; });
    if (!markets.length) return '<div class="empty">Not enough history yet.</div>';
    var rows = [];
    markets.forEach(function (m) {
      PRICE_POLICIES.forEach(function (p) {
        var x = ag[m][p];
        if (!x) return;
        var near = x.near || {}, far = x.far || {};
        rows.push("<tr><td>" + esc(label(MARKET_LABEL, m)) + "</td><td>" + esc(PRICE_POL_LABEL[p]) + "</td><td>" + count(near.n) + "</td><td>" + usd(near.netPerDay) + "</td><td>" + count(far.n) + "</td><td>" + usd(far.netPerDay) + "</td></tr>");
      });
    });
    return '<div class="scroll"><table class="pm"><tr><th>market</th><th>way of pricing</th><th>listings priced within 10 %</th><th>net per listing-day</th><th>further away</th><th>net per listing-day</th></tr>' + rows.join("") + "</table></div>";
  }

  function soldOrExpiredBlock(se) {
    if (!se || !n0(se.n)) return '<div class="empty">Not enough history yet.</div>';
    var share = function (x) { return isNum(x) && Number(x) <= 1 ? chance(x) : count(x); };
    return kv([[count(se.n), "no-claim units live at the forecast"], [share(se.expected), "the brain expected to sell before expiry"], [share(se.actual), "really sold before expiry"], [fix(se.brier, 3), "Brier per unit (lower is better)"]]);
  }

  function hasScores(x) {
    if (!x) return false;
    var any = false;
    FARMS.forEach(function (f) {
      if (x.calibration && x.calibration[f] && n0(x.calibration[f].n)) any = true;
      var p = x.placement && x.placement[f];
      if (p) PLACE_POLICIES.forEach(function (k) { if (p[k] && n0(p[k].n)) any = true; });
    });
    return any;
  }

  function scoreSections(x) {
    return sec("Sell-through calibration") +
      '<div class="basisbar">Every live system-made listing gets a chance to sell within its horizon at its own ask. <b>Brier</b> = the average squared miss of that chance (0 is perfect; lower is better). <b>Baseline</b> = every listing on a market sells at that market\'s usual rate. <b>Skill</b> above 0 = the brain beats the baseline; until it does, nothing it says should be trusted.</div>' +
      calibrationBlock(x.calibration) +
      sec("Discrimination") + '<div class="basisbar">How often listings really sold, grouped by what the brain said about them. If it is right, listings it would lower sell less often at today\'s price than the ones it would hold.</div>' + discriminationBlock(x.discrimination) +
      sec("Placement forecast — units sold per game and market the next week") + '<div class="basisbar"><b>Typical miss</b> (RMSE) and <b>average miss</b> in units per cell-week (lower is better); <b>bias</b> above 0 = it expects more than sells. Ranked only on the same cell-weeks; a way with no number on some of them is not ranked.</div>' + placementBlock(x.placement) +
      sec("Agreement analysis — correlation, not cause") + '<div class="basisbar">Realised net per listing-day of listings priced within 10 % of each way of pricing, against listings further away. This is <b>correlation</b>: a listing that happened to sit near a price is not proof that price caused the sale.</div>' + agreementBlock(x.agreement) +
      (x.soldOrExpired ? sec("Sold or expired (no-claim)") + soldOrExpiredBlock(x.soldOrExpired) : "") +
      (x.note ? '<div class="note">' + esc(x.note) + "</div>" : "");
  }

  async function renderAccuracy(c, f, g) {
    var a = await c.api("/api/price-tracker/listing-brain/accuracy");
    if (c.stale(g)) return;
    if (a.empty) { box().innerHTML = '<div class="empty">Not enough history yet: no evidence has been read.</div>'; return; }
    var bt = a.backtest || {}, fw = a.forward || {};
    var weeks = Array.isArray(bt.weeks) ? bt.weeks.length : n0(bt.weeks);
    var review = (a.review || []).map(function (x) {
      var o = x.old || {}, b = x.br || {}, nx = x.next || {};
      return '<div class="row clickable" data-lbkey="' + esc(cellKey(x)) + '"><div class="r1"><span class="t">' + esc(x.g || x.k) + " " + pill("s-info", label(MARKET_LABEL, x.m)) + " " + farmPill(x.f) +
        '</span><span class="amt">price ' + usd(o.a) + ' <span class="arrow">→</span> ' + usd(b.p) + " · shelf " + shelfTxt(o.sh) + ' <span class="arrow">→</span> ' + shelfTxt(b.sh) + "</span></div>" +
        '<div class="r2">' + pcPill(x.pc) + scPill(x.sc) + "<span>" + esc(C.day(x.at)) + "</span><span>the 7 days after: " + count(nx.units) + " sold, " + usd(nx.net) + " net</span></div></div>";
    }).join("");
    box().innerHTML = '<div class="basisbar">How good is the brain? Scored on what really sold. ' + (a.at ? "Worked out " + esc(C.ago(a.at)) + (a.evidenceAt ? " from evidence read " + esc(C.ago(a.evidenceAt)) : "") + ". " : "") +
      "What test mode cannot show: whether a <b>different</b> price would have sold — every score compares the brain with what happened at the price that was actually asked.</div>" +
      sec("Backtest — the last " + (weeks || 0) + " weeks, replayed from our own sales (works from day one)") +
      (hasScores(bt) ? scoreSections(bt) : '<div class="empty">Not enough history yet to replay a week.</div>') +
      sec("Live test — logged forecasts scored once their horizon has passed") +
      '<div class="basisbar">The first run of each day logs a forecast for every live listing; each is scored once its horizon is over (2 days no-claim, 7 days auto-farm).' +
      (isNum(fw.runsScored) ? " " + esc(fw.runsScored) + " day(s) scored" + (isNum(fw.runsWaiting) ? ", " + esc(fw.runsWaiting) + " still waiting" : "") + "." : "") +
      (n0(fw.missing) ? " " + esc(fw.missing) + " forecasts skipped (the listing is no longer in the evidence)." : "") + "</div>" +
      (hasScores(fw) ? scoreSections(fw) : '<div class="empty">Not enough history yet: the first live scores appear once a logged forecast\'s horizon has passed.</div>') +
      sec("Where they disagreed, and what sold next") + (review ? '<div class="rows">' + review + "</div>" : '<div class="empty">Not enough history yet: appears once a logged run with a disagreement is a week old.</div>');
    wireCells();
  }

  window.ListingBrainTab = { render: render };
})();
