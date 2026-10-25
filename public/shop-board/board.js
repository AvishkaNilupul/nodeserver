/* Listings board — where every farm code is listed and where it sold
   (docs/code-shop/08-LISTINGS-BOARD.md).

   One file for both farm panels. Each panel calls
       ShopBoard.mountTab(Soop,  { farm: "soop" })     public/soop/tab-listings.js
       ShopBoard.mountTab(Chzzk, { farm: "chzzk" })    public/chzzk/tab-listings.js
   with its own kit; both kits give the same el / ui / fmt / drawer / toast /
   registerTab / on (public/soop/UI-KIT.md), so nothing here knows which page
   it is on except the farm it opens on.

   Data: GET /api/code-shop/board — once at page load (for the tab badge),
   then every 30 s while this tab and the browser tab are both on screen (a
   timeout chain, never an interval; a request that hangs is cut at 20 s).
   Everything is drawn with the kit's el(): text stays text, links and
   pictures pass its URL scrub. What the owner is using is never rebuilt
   under them: redraws happen only when the data changed, and keep focus.
   Read-only: nothing here changes the shop, and no code is ever on this page. */
(function () {
  "use strict";
  const API = "/api/code-shop/board";
  const POLL_MS = 30000;
  const TIMEOUT_MS = 20000;
  const STALE_MS = 75000;
  const DAYS = 14;
  const SALES = 150;
  const SOON_MS = 48 * 3600 * 1000;
  const MARKET_NAMES = { eldorado: "Eldorado", playerauctions: "PlayerAuctions", ggsel: "GGSel" };
  const MARKET_ORDER = ["eldorado", "playerauctions"];
  const FARM_NAMES = { soop: "SOOP", chzzk: "CHZZK" };
  const LISTING_WORD = { live: ["Live", "ok"], paused: ["Paused", "warn"], error: ["Error", "error"], down: ["Taken down", null] };
  const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
  const WEEKDAYS = "Sun Mon Tue Wed Thu Fri Sat".split(" ");
  const ZERO = Object.freeze({ units: 0, usd: 0 });

  // ---------- pure helpers --------------------------------------------------------
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : Number(v) || 0);
  const plural = (n, one, many) => Number(n).toLocaleString("en-US") + " " + (Number(n) === 1 ? one : many || one + "s");
  const marketClass = (m) => (m === "eldorado" || m === "playerauctions" ? m : "other");
  const marketName = (m) => MARKET_NAMES[m] || (m ? m.charAt(0).toUpperCase() + m.slice(1) : "Unknown market");
  const pad = (n) => (n < 10 ? "0" : "") + n;
  const unique = (list) => Array.from(new Set(list));
  function usd(n) {
    if (n == null || n === "" || !isFinite(Number(n))) return "–";
    const v = Number(n);
    return (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function ms(v) {
    if (v == null || v === "") return null;
    const t = typeof v === "number" ? v : Date.parse(v);
    return isFinite(t) ? t : null;
  }
  function hueOf(s) {
    let h = 0;
    for (const ch of String(s || "")) h = (h * 31 + ch.codePointAt(0)) % 360;
    return h;
  }
  function initials(name) {
    const words = String(name || "?").replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
    if (!words.length) return "?";
    const a = Array.from(words[0]);
    const b = words[1] ? Array.from(words[1]) : a.slice(1);
    return ((a[0] || "") + (b[0] || "")).toUpperCase();
  }
  function sumCounts(list, pick) {
    const out = { inStock: 0, onSale: 0, inVault: 0, sold: 0, expiring: 0, expired: 0, held: 0, dead: 0 };
    list.forEach((x) => { const c = pick(x) || {}; Object.keys(out).forEach((k) => { out[k] += num(c[k]); }); });
    return out;
  }
  function sumMoney(list, pick) {
    const out = { d1: 0, d7: 0, d30: 0, all: 0 };
    list.forEach((x) => { const m = pick(x) || {}; Object.keys(out).forEach((k) => { out[k] += num(m[k]); }); });
    return out;
  }
  function localDayKey(t) {
    const d = new Date(t);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  // "2026-10-25" -> a Date at local midnight of that calendar day (for names only).
  function dayDate(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  }
  function shiftKey(key, days) {
    const d = dayDate(key);
    if (!d) return "";
    d.setDate(d.getDate() + days);
    return localDayKey(d.getTime());
  }
  function dayLabel(key, todayKey) {
    if (!key) return "Unknown day";
    if (key === todayKey) return "Today";
    if (key === shiftKey(todayKey, -1)) return "Yesterday";
    const d = dayDate(key);
    return d ? WEEKDAYS[d.getDay()] + ", " + MONTHS[d.getMonth()] + " " + d.getDate() : key;
  }
  // Day keys and clock times in one time zone: the one the server counted
  // days in (its answer names it), so the feed, "Today" and the chart agree.
  function zoned(tz) {
    let day = null;
    let time = null;
    try {
      day = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
      time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    } catch {
      day = null;
      time = null;
    }
    const parts = (f, t) => {
      const p = {};
      f.formatToParts(new Date(t)).forEach((x) => { p[x.type] = x.value; });
      return p;
    };
    return {
      dayKey(t) {
        if (day) { const p = parts(day, t); if (p.year && p.month && p.day) return p.year + "-" + p.month + "-" + p.day; }
        return localDayKey(t);
      },
      clock(t) {
        if (time) { const p = parts(time, t); if (p.hour && p.minute) return p.hour + ":" + p.minute; }
        const d = new Date(t);
        return pad(d.getHours()) + ":" + pad(d.getMinutes());
      },
    };
  }
  function timeZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
  }
  const cssEscape = (s) => (window.CSS && typeof window.CSS.escape === "function" ? window.CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"));

  // ---------- the tab -------------------------------------------------------------------
  function mountTab(kit, opts) {
    const K = kit;
    const { el, ui, fmt } = K;
    const own = opts && opts.farm === "chzzk" ? "chzzk" : "soop";
    const STORE = "shopBoard." + own + ".";

    function stored(key, dflt, allowed) {
      try { const x = window.localStorage.getItem(STORE + key); return allowed.indexOf(x) !== -1 ? x : dflt; } catch { return dflt; }
    }
    function store(key, x) {
      try { window.localStorage.setItem(STORE + key, x); } catch { /* private window: not remembered */ }
    }

    const st = {
      data: null, loadedAt: 0, error: "", busy: null, again: null, timer: 0, triedAt: 0, gone: false,
      farm: stored("farm", own, ["soop", "chzzk", "all"]),
      view: stored("view", "games", ["games", "markets", "sales"]),
      sort: stored("sort", "onsale", ["onsale", "revenue", "recent", "name"]),
      metric: stored("metric", "units", ["units", "usd"]),
      q: "",
    };
    let root = null;
    const v = { farmCards: {} };
    let drawer = null; // { key, handle, sig }
    const cards = new Map(); // game key -> { node, sig }

    // ---------- small builders ------------------------------------------------------
    function fill(node, ...kids) {
      node.textContent = "";
      kids.flat(4).forEach((k) => { if (k != null && k !== false && k !== true) node.append(k instanceof Node ? k : String(k)); });
      return node;
    }
    // The kit joins a class array with spaces; keep it one flat list.
    const cls = (...list) => list.flat(3).filter(Boolean).join(" ");
    function mono(name, size) {
      const h = hueOf(name);
      return el("span", {
        class: cls("sb-cover", "is-mono", size ? "is-" + size : ""),
        style: { background: "linear-gradient(135deg,hsl(" + h + ",62%,40%),hsl(" + ((h + 48) % 360) + ",62%,24%))" },
        "aria-hidden": "true",
      }, initials(name));
    }
    function cover(game, size) {
      const name = game ? game.name : "?";
      if (!game || !game.cover) return mono(name, size);
      const img = el("img", {
        class: cls("sb-cover", size ? "is-" + size : ""), src: game.cover, alt: "", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer",
        onError: () => img.replaceWith(mono(name, size)),
      });
      return img;
    }
    function banner(src) {
      if (!src) return null;
      const img = el("img", { class: "sb-banner", src, alt: "", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer", onError: () => img.remove() });
      return img;
    }
    function artBackground(name) {
      const h = hueOf(name);
      return { background: "linear-gradient(135deg,hsl(" + h + ",55%,32%),hsl(" + ((h + 60) % 360) + ",55%,16%))" };
    }
    function rewardPic(r, title) {
      const text = () => el("span", { class: "sb-rw-txt", title: title || null }, initials(r && r.label));
      if (r && r.image) {
        const img = el("img", { src: r.image, alt: title || "", title: title || null, loading: "lazy", decoding: "async", referrerpolicy: "no-referrer",
          onError: () => img.replaceWith(text()) });
        return img;
      }
      return text();
    }
    // Relative times are elements the 3-5 s page tick rewrites (paintTimes).
    function ago(t, prefix) {
      const at = ms(t);
      if (at == null) return "–";
      const iso = new Date(at).toISOString();
      return el("time", { class: "sb-ago", datetime: iso, title: fmt.when(iso), dataset: { at: iso, prefix: prefix || "" } }, (prefix || "") + fmt.ago(iso));
    }
    function until(t, prefix) {
      const at = ms(t);
      if (at == null) return "–";
      const iso = new Date(at).toISOString();
      return el("time", { class: "sb-until", datetime: iso, title: fmt.when(iso), dataset: { at: iso, prefix: prefix || "" } }, (prefix || "") + fmt.until(iso));
    }
    function pill(classes, ...kids) { return el("span", { class: cls("sb-pill", classes) }, kids); }
    function farmPill(src, glass) { return pill(["is-" + src, glass ? "is-glass" : ""], FARM_NAMES[src] || src); }
    function marketPill(m, ...kids) { return pill("is-" + marketClass(m), marketName(m), kids.length ? " " : null, kids); }
    function openLink(url, fid) {
      if (!url) return null;
      return el("a", { class: "sb-open", href: url, target: "_blank", rel: "noopener noreferrer", "data-stop": "", "data-fid": fid || null,
        title: "Open the listing on the market", onClick: (e) => e.stopPropagation() }, "Open", ui.icon("external", 12));
    }
    // Run a redraw of `scope`; if focus was inside it, put it back on the same
    // control (matched by data-fid), else on `fallback`, without scrolling.
    function keepFocus(scope, fallback, redraw) {
      const a = document.activeElement;
      const inside = !!a && a !== document.body && scope.contains(a);
      const fid = inside && a.getAttribute ? a.getAttribute("data-fid") : null;
      redraw();
      if (!inside || document.activeElement === a) return;
      const back = scope.contains(a) ? a : fid ? scope.querySelector('[data-fid="' + cssEscape(fid) + '"]') : null;
      const target = back || fallback;
      if (target && typeof target.focus === "function") target.focus({ preventScroll: true });
    }

    // ---------- loading -------------------------------------------------------------------
    function fetchBoard() {
      const url = API + "?days=" + DAYS + "&sales=" + SALES + "&tz=" + encodeURIComponent(timeZone());
      const ctl = typeof AbortController === "function" ? new AbortController() : null;
      const cut = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : 0;
      return fetch(url, { credentials: "same-origin", headers: { accept: "application/json" }, signal: ctl ? ctl.signal : undefined }).then((r) => {
        if (r.status === 401 || r.status === 403) {
          if (!st.gone) { st.gone = true; clearTimeout(st.timer); window.location.href = "/admin-login.html"; }
          throw new Error("You are signed out — taking you to the login page");
        }
        return r.json().catch(() => null).then((j) => {
          if (!r.ok || !j || j.success === false) throw new Error((j && (j.message || j.error)) || "The server answered with an error (HTTP " + r.status + ")");
          return j;
        });
      }).catch((e) => {
        if (e && e.name === "AbortError") throw new Error("The server took too long to answer");
        if (e instanceof TypeError) throw new Error("Could not reach the server — check the connection");
        throw e;
      }).finally(() => clearTimeout(cut));
    }
    function visible() { return !!root && !root.hidden && !document.hidden; }
    function schedule() {
      clearTimeout(st.timer); st.timer = 0;
      if (st.gone || st.busy || !visible()) return;
      st.timer = setTimeout(() => { st.timer = 0; if (visible()) refresh(); }, Math.max(0, POLL_MS - (Date.now() - st.triedAt)));
    }
    function refresh() {
      if (st.busy) {
        if (!st.again) st.again = st.busy.then(() => { st.again = null; return refresh(); });
        return st.again;
      }
      clearTimeout(st.timer); st.timer = 0; st.triedAt = Date.now();
      st.busy = fetchBoard().then(
        (j) => { st.data = j; st.loadedAt = Date.now(); st.error = ""; return j; },
        (e) => { st.error = (e && e.message) || "No answer from the server"; return null; },
      ).then((j) => { st.busy = null; paint(); schedule(); return j; });
      return st.busy;
    }

    // ---------- the model (what the farm chip and search let through) ----------------------
    // Per farm: a bundle counts for every farm it has codes from; money is that
    // farm's share. "Both farms" counts every bundle once at its full price.
    const farmOk = (src) => st.farm === "all" || src === st.farm;
    const farmsOk = (list) => st.farm === "all" || (list || []).indexOf(st.farm) !== -1;
    const isLiveProduct = (p) => p.status === "active" && p.listings.some((l) => l.state === "live");
    const soldOf = (p) => (st.farm === "all" ? p.sold : (p.sold.bySource && p.sold.bySource[st.farm]) || ZERO);
    function soldHere(p, market) {
      const bm = p.sold.byMarket && p.sold.byMarket[market];
      if (!bm) return { units: 0, usd: 0, lastAt: null };
      if (st.farm === "all") return bm;
      const f = (bm.bySource && bm.bySource[st.farm]) || ZERO;
      return { units: f.units, usd: f.usd, lastAt: f.units ? bm.lastAt : null };
    }
    const saleUsd = (s) => (st.farm === "all" || !s.bySource || !s.bySource[st.farm] ? s.usd : s.bySource[st.farm].usd);
    const dayRow = (r) => (st.farm === "all" ? { units: num(r.units), usd: num(r.usd) } : { units: num(r[st.farm] && r[st.farm].units), usd: num(r[st.farm] && r[st.farm].usd) });

    function productState(p) {
      if (p.status === "retired") return { word: "Ended", tone: null };
      if (p.status === "draft") return { word: "Draft", tone: "info" };
      if (p.status === "paused") return { word: "Paused", tone: "warn" };
      if (!num(p.units.available)) return { word: "Sold out", tone: null };
      if (!p.listings.some((l) => l.state === "live")) return { word: p.listings.length ? "Not live" : "Not listed", tone: "warn" };
      return { word: "On sale", tone: "ok" };
    }

    function model() {
      const d = st.data;
      const q = st.q.toLowerCase();
      const zone = zoned(d.tz || "UTC");
      const gameByNo = new Map();
      d.games.forEach((g) => (g.gameNos || [g.gameNo]).forEach((n) => gameByNo.set(String(n), g)));
      const products = d.products.filter((p) => farmsOk(p.sources));
      const sales = d.sales.filter((s) => farmsOk(s.sources));
      const byKey = (list, keyOf) => {
        const out = new Map();
        list.forEach((x) => { const k = keyOf(x); if (!out.has(k)) out.set(k, []); out.get(k).push(x); });
        return out;
      };
      const gameKeyOfNo = (n) => { const g = gameByNo.get(String(n)); return g ? g.key : "game:" + n; };
      const prodBy = byKey(products, (p) => gameKeyOfNo(p.gameNo));
      const salesBy = byKey(sales, (s) => gameKeyOfNo(s.gameNo));
      const nowMs = ms(d.now) || Date.now();

      const games = [];
      d.games.forEach((g) => {
        const camps = g.campaigns.filter((c) => farmOk(c.source));
        const prods = prodBy.get(g.key) || [];
        if (!camps.length && !prods.length) return;
        const codes = sumCounts(camps, (c) => c.codes);
        const revenue = sumMoney(camps, (c) => c.revenue);
        const onSaleBundles = prods.filter(isLiveProduct).reduce((n, p) => n + num(p.units.available), 0);
        const soldBundles = prods.reduce((n, p) => n + num(soldOf(p).units), 0);
        const listingsLive = {};
        let errors = 0;
        prods.forEach((p) => p.listings.forEach((l) => {
          if (l.state === "live") listingsLive[l.market] = (listingsLive[l.market] || 0) + 1;
          if (l.state === "error") errors += 1;
        }));
        let lastSoldAt = null;
        let nextUseBy = null;
        let newestEnd = null;
        camps.forEach((c) => {
          const s = ms(c.lastSoldAt); if (s != null && (lastSoldAt == null || s > lastSoldAt)) lastSoldAt = s;
          const u = ms(c.nextUseBy); if (u != null && (nextUseBy == null || u < nextUseBy)) nextUseBy = u;
          const e = ms(c.endAt); if (e != null && (newestEnd == null || e > newestEnd)) newestEnd = e;
        });
        // Rewards across its campaigns, one per picture+name, the ones on sale first.
        const rw = new Map();
        camps.forEach((c) => c.rewards.forEach((r) => {
          const k = (r.image || "") + "|" + (r.label || r.nameRaw || "");
          if (!rw.has(k)) rw.set(k, { label: r.label || r.nameRaw || "Reward", image: r.image, onSale: 0, sold: 0, inStock: 0 });
          const x = rw.get(k);
          x.onSale += num(r.codes.onSale); x.sold += num(r.codes.sold) + num(r.codes.dead); x.inStock += num(r.codes.inStock);
        }));
        const rewards = Array.from(rw.values()).sort((a, b) => b.onSale - a.onSale || b.sold - a.sold || (a.label < b.label ? -1 : 1));
        const gameSales = salesBy.get(g.key) || [];
        const drafts = prods.filter((p) => p.status === "draft").length;
        const warn = [];
        if (errors) warn.push({ tone: "error", text: plural(errors, "listing error") });
        if (nextUseBy != null && nextUseBy - nowMs < SOON_MS && codes.onSale + codes.inStock > 0) warn.push({ tone: "warn", until: nextUseBy, text: "Codes stop working " });
        if ((g.sellOff || []).length && codes.inStock > 0) warn.push({ tone: "warn", text: "Selling is off in Sales settings" });
        if (drafts) warn.push({ tone: "info", text: plural(drafts, "draft") + " waiting" });
        const hay = [g.name, ...camps.map((c) => c.title), ...rewards.map((r) => r.label), ...prods.map((p) => p.name + " " + p.title)].join(" ").toLowerCase();
        // The picture follows the farm chip: the newest of the shown campaigns that has one.
        const shownBanner = (camps.find((c) => c.banner) || {}).banner || g.banner;
        games.push({
          g, camps, prods, codes, revenue, banner: shownBanner, onSaleBundles, soldBundles, listingsLive, errors, lastSoldAt, nextUseBy, newestEnd,
          rewards, sales: gameSales, lastSale: gameSales[0] || null, warn, hay, drafts,
          active: onSaleBundles > 0 || codes.inStock > 0 || codes.onSale > 0 || drafts > 0,
        });
      });

      const sorters = {
        onsale: (a, b) => (b.active - a.active) || b.onSaleBundles - a.onSaleBundles || b.codes.onSale - a.codes.onSale || b.revenue.all - a.revenue.all,
        revenue: (a, b) => b.revenue.all - a.revenue.all || b.soldBundles - a.soldBundles,
        recent: (a, b) => Math.max(b.lastSoldAt || 0, b.newestEnd || 0) - Math.max(a.lastSoldAt || 0, a.newestEnd || 0),
        name: () => 0,
      };
      const lower = (x) => x.g.name.toLowerCase();
      const byName = (a, b) => (lower(a) < lower(b) ? -1 : lower(a) > lower(b) ? 1 : 0);
      games.sort((a, b) => sorters[st.sort](a, b) || byName(a, b));

      // Per day for this farm chip: each market's bundles and money.
      const daily = d.daily.map((day) => ({ day: day.day, rows: day.rows.map((r) => ({ market: r.market, ...dayRow(r) })).filter((r) => r.units > 0 || r.usd > 0) }));
      const todayKey = daily.length ? daily[daily.length - 1].day : zone.dayKey(nowMs);
      const dayTotals = (list) => list.reduce((o, day) => { day.rows.forEach((r) => { o.units += r.units; o.usd += r.usd; }); return o; }, { units: 0, usd: 0 });
      const allCodes = sumCounts(games, (x) => x.codes);
      const allRevenue = sumMoney(games, (x) => x.revenue);
      const liveByMarket = {};
      let liveCount = 0;
      let errorCount = 0;
      let onSaleBundles = 0;
      products.forEach((p) => {
        if (isLiveProduct(p)) onSaleBundles += num(p.units.available);
        p.listings.forEach((l) => {
          if (l.state === "live") { liveCount += 1; liveByMarket[l.market] = (liveByMarket[l.market] || 0) + 1; }
          if (l.state === "error") errorCount += 1;
        });
      });
      const soldBundles = products.reduce((n, p) => n + num(soldOf(p).units), 0);
      const nextUseBy = games.reduce((t, x) => (x.nextUseBy != null && (t == null || x.nextUseBy < t) ? x.nextUseBy : t), null);

      return {
        d, zone, nowMs, todayKey, gameByNo, products, sales, daily,
        games: q ? games.filter((x) => x.hay.indexOf(q) !== -1) : games,
        allGames: games,
        tiles: { today: dayTotals(daily.slice(-1)), week: dayTotals(daily.slice(-7)), allCodes, allRevenue, liveCount, errorCount, liveByMarket, onSaleBundles, soldBundles, nextUseBy },
      };
    }

    // ---------- skeleton --------------------------------------------------------------------
    function render(r) {
      root = r;
      v.farmChips = ui.chips({ options: [{ value: "soop", label: "SOOP" }, { value: "chzzk", label: "CHZZK" }, { value: "all", label: "Both farms" }],
        value: st.farm, onChange: (x) => { st.farm = x; store("farm", x); paint(); } });
      v.farmChips.setAttribute("aria-label", "Which farm");
      v.viewChips = ui.chips({
        options: [{ value: "games", label: "Games" }, { value: "markets", label: "Marketplaces" }, { value: "sales", label: "Sales" }],
        value: st.view, onChange: (x) => { st.view = x; store("view", x); paint(); },
      });
      v.viewChips.setAttribute("aria-label", "View");
      v.search = ui.search({ placeholder: "Search games, rewards, listings", onInput: (q) => { st.q = q; paint(); } });
      v.pulse = el("span", { class: "sb-pulse is-off", "aria-hidden": "true" });
      v.statusText = el("span", null, "Loading…");
      v.reload = ui.button("", { icon: "refresh", tone: "ghost", size: "sm", title: "Reload the board now",
        onClick: () => refresh().then((j) => { if (!j) K.toast("The board could not be reloaded: " + st.error, "error"); }) });

      v.tiles = {
        onSale: ui.stat("On sale now", "–"), live: ui.stat("Live listings", "–"), today: ui.stat("Sold today", "–"),
        week: ui.stat("Last 7 days", "–"), all: ui.stat("All time", "–"), stock: ui.stat("In stock", "–"), expiring: ui.stat("Expiring", "–"),
      };
      v.farms = el("div", { class: "sb-farms" });
      v.note = el("div", { class: "s-note is-warn", hidden: true });
      v.views = {
        games: el("div", { class: "s-stack" }),
        markets: el("div", { class: "s-stack", tabindex: "-1" }),
        sales: el("div", { class: "s-stack" }),
      };
      v.sortChips = ui.chips({
        options: [{ value: "onsale", label: "On sale" }, { value: "revenue", label: "Best selling" }, { value: "recent", label: "Recent" }, { value: "name", label: "A–Z" }],
        value: st.sort, onChange: (x) => { st.sort = x; store("sort", x); paint(); },
      });
      v.sortChips.setAttribute("aria-label", "Sort games");
      v.gameCount = el("h2");
      v.grid = el("div", { class: "sb-grid" });
      v.gameEmpty = el("div", { hidden: true });
      v.views.games.append(el("div", { class: "sb-head" }, v.gameCount, v.sortChips), v.grid, v.gameEmpty);

      root.append(el("div", { class: "sb" },
        el("div", { class: "sb-bar" }, v.farmChips, el("span", { class: "sb-sep", "aria-hidden": "true" }), v.viewChips, v.search,
          el("div", { class: "sb-status" }, v.pulse, v.statusText, v.reload)),
        v.note,
        el("div", { class: "sb-tiles" }, v.tiles.onSale, v.tiles.live, v.tiles.today, v.tiles.week, v.tiles.all, v.tiles.stock, v.tiles.expiring),
        v.farms,
        v.views.games, v.views.markets, v.views.sales));
      paint();
      if (!st.data && !st.busy) refresh();
    }

    // ---------- painting ----------------------------------------------------------------------
    function since(t) {
      const s = Math.max(0, Math.round((Date.now() - t) / 1000));
      if (s < 10) return "just now";
      if (s < 60) return s + " s ago";
      const m = Math.floor(s / 60);
      return m < 60 ? m + " min ago" : Math.floor(m / 60) + " h " + (m % 60) + " min ago";
    }
    function paintStatus() {
      if (!v.statusText) return;
      const age = st.loadedAt ? Date.now() - st.loadedAt : Infinity;
      const stale = !!st.data && (!!st.error || age > STALE_MS);
      v.pulse.className = "sb-pulse" + (stale ? " is-stale" : st.data ? "" : " is-off");
      v.statusText.textContent = !st.data ? (st.error ? "Not loaded" : "Loading…")
        : st.error ? "Could not refresh — showing data from " + since(st.loadedAt)
          : age > STALE_MS ? "Refreshing… last update " + since(st.loadedAt)
            : "Live · updated " + since(st.loadedAt);
    }
    // Relative times, in the tab and in an open game drawer (which lives outside the tab).
    function paintTimes() {
      const scopes = [root, drawer && drawer.handle && drawer.handle.body].filter(Boolean);
      scopes.forEach((scope) => {
        scope.querySelectorAll(".sb-ago").forEach((t) => { t.textContent = (t.dataset.prefix || "") + fmt.ago(t.dataset.at); });
        scope.querySelectorAll(".sb-until").forEach((t) => { t.textContent = (t.dataset.prefix || "") + fmt.until(t.dataset.at); });
      });
    }

    function paint() {
      if (!root) return;
      paintStatus();
      Object.keys(v.views).forEach((k) => { v.views[k].hidden = k !== st.view; });
      if (v.viewChips.value() !== st.view) v.viewChips.set(st.view);
      if (v.farmChips.value() !== st.farm) v.farmChips.set(st.farm);
      if (!st.data) {
        v.note.hidden = !st.error;
        if (st.error) {
          fill(v.note, ui.icon("alert"), el("div", { class: "s-stack is-tight s-grow" }, el("b", "The board could not be loaded"),
            el("span", { class: "s-small" }, st.error)),
          ui.button("Try again", { size: "sm", icon: "refresh", onClick: () => refresh().then(() => { if (v.reload) v.reload.focus({ preventScroll: true }); }) }));
        }
        return;
      }
      v.note.hidden = !st.error;
      if (st.error) fill(v.note, ui.icon("alert"), el("span", null, "The last refresh failed (" + st.error + "). The numbers below are from " + since(st.loadedAt) + "."));
      const m = model();
      paintFarms(m);
      paintTiles(m);
      if (st.view === "games") paintGames(m);
      else if (st.view === "markets") paintMarkets(m);
      else paintSales(m);
      if (drawer) refreshDrawer(m);
    }

    // The farm cards are built once and only updated, so one keeps focus when clicked.
    function paintFarms(m) {
      const d = m.d;
      const onSaleOf = (src) => d.products.filter((p) => (p.sources || []).indexOf(src) !== -1 && isLiveProduct(p)).reduce((n, p) => n + num(p.units.available), 0);
      v.farmChips.setOptions([
        { value: "soop", label: "SOOP", count: onSaleOf("soop") },
        { value: "chzzk", label: "CHZZK", count: onSaleOf("chzzk") },
        { value: "all", label: "Both farms" },
      ]);
      (d.sources || []).forEach((s) => {
        let c = v.farmCards[s.id];
        if (!c) {
          c = { name: el("b", s.name + " farm"), line: el("span") };
          c.btn = el("button", { type: "button", onClick: () => { st.farm = st.farm === s.id ? "all" : s.id; store("farm", st.farm); paint(); } },
            el("span", { class: "sb-farm-mark", "aria-hidden": "true" }, s.id === "chzzk" ? "CHZ" : "SOOP"),
            el("span", { class: "sb-farm-text" }, c.name, c.line));
          v.farmCards[s.id] = c;
          v.farms.append(c.btn);
        }
        const on = st.farm === s.id;
        c.btn.className = cls("sb-farm-card", "is-" + s.id, on ? "is-on" : "");
        c.btn.setAttribute("aria-pressed", String(on));
        c.btn.title = on ? "Showing " + s.name + " only — click to show both farms" : "Show " + s.name + " only";
        const sig = JSON.stringify([s.logins, s.codes.onSale, s.revenue.all, s.lastEarnedAt]);
        if (c.sig !== sig) {
          c.sig = sig;
          fill(c.line, plural(s.logins, "login") + " with codes · " + plural(s.codes.onSale, "code") + " on sale · " + usd(s.revenue.all) + " sold",
            s.lastEarnedAt ? [" · ", ago(s.lastEarnedAt, "last code ")] : null);
        }
      });
    }

    function paintTiles(m) {
      const t = m.tiles;
      const mk = Object.keys(t.liveByMarket).sort((a, b) => MARKET_ORDER.indexOf(a) - MARKET_ORDER.indexOf(b));
      v.tiles.onSale.set(plural(t.onSaleBundles, "bundle"), plural(t.allCodes.onSale, "code") + " in them", t.onSaleBundles ? "ok" : null);
      v.tiles.live.set(String(t.liveCount), t.errorCount ? plural(t.errorCount, "listing") + " with an error" : mk.map((k) => marketName(k) + " " + t.liveByMarket[k]).join(" · ") || "nothing live", t.errorCount ? "error" : null);
      v.tiles.today.set(usd(t.today.usd), plural(t.today.units, "bundle"), t.today.units ? "ok" : null);
      v.tiles.week.set(usd(t.week.usd), plural(t.week.units, "bundle"));
      v.tiles.all.set(usd(t.allRevenue.all), plural(t.soldBundles, "bundle") + " sold");
      v.tiles.stock.set(plural(t.allCodes.inStock, "code"), "earned, not in a bundle yet");
      const soon = t.nextUseBy != null && t.nextUseBy - m.nowMs < SOON_MS;
      v.tiles.expiring.set(plural(t.allCodes.expiring, "code"), soon ? el("span", null, "next use-by ", until(t.nextUseBy)) : "pulled near their use-by", soon ? "warn" : null);
    }

    // ---------- Games view ----------------------------------------------------------------------
    // Everything a card shows, so its signature can never miss a field.
    function cardModel(x) {
      return {
        key: x.g.key,
        name: x.g.name,
        cover: x.g.cover,
        banner: x.banner,
        sources: unique(x.camps.map((c) => c.source).concat(...x.prods.map((p) => p.sources || []))),
        campaigns: x.camps.length,
        listings: x.prods.filter((p) => p.status !== "retired").length,
        onSaleBundles: x.onSaleBundles,
        revenueAll: x.revenue.all,
        soldBundles: x.soldBundles,
        inStock: x.codes.inStock,
        markets: MARKET_ORDER.filter((mk) => x.prods.some((p) => p.listings.some((l) => l.market === mk))).map((mk) => [mk, x.listingsLive[mk] || 0]),
        drafts: x.drafts,
        rewards: x.rewards.slice(0, 6),
        moreRewards: Math.max(0, x.rewards.length - 6),
        lastSale: x.lastSale ? { soldAt: x.lastSale.soldAt, market: x.lastSale.market, usd: saleUsd(x.lastSale) } : null,
        lastSoldAt: x.lastSoldAt,
        warn: x.warn,
        active: x.active,
      };
    }
    function paintGames(m) {
      v.gameCount.textContent = plural(m.games.length, "game") + (st.q ? " match “" + st.q + "”" : "");
      if (v.sortChips.value() !== st.sort) v.sortChips.set(st.sort);
      keepFocus(v.grid, null, () => {
        const keep = new Set();
        const nodes = m.games.map((x) => {
          const vm = cardModel(x);
          keep.add(vm.key);
          const sig = JSON.stringify(vm);
          let c = cards.get(vm.key);
          if (!c || c.sig !== sig) {
            const node = gameCard(vm);
            if (c && c.node.parentNode) c.node.replaceWith(node);
            c = { node, sig };
            cards.set(vm.key, c);
          }
          return c.node;
        });
        cards.forEach((c, k) => { if (!keep.has(k)) { c.node.remove(); cards.delete(k); } });
        nodes.forEach((n, i) => { if (v.grid.children[i] !== n) v.grid.insertBefore(n, v.grid.children[i] || null); });
        v.gameEmpty.hidden = nodes.length > 0;
      });
      if (!m.games.length) {
        fill(v.gameEmpty, el("section", { class: "sb-empty-card" }, st.q
          ? ui.empty("No game matches “" + st.q + "”", "Try a game, reward or listing name.",
            { label: "Clear search", onClick: () => { v.search.set(""); st.q = ""; paint(); v.search.input.focus({ preventScroll: true }); } })
          : ui.empty("Nothing here yet", st.farm === "all" ? "No farm has earned a code yet." : "The " + FARM_NAMES[st.farm] + " farm has not earned a code yet.",
            st.farm === "all" ? null : { label: "Show both farms", onClick: () => {
              st.farm = "all"; store("farm", "all"); paint();
              const on = v.farmChips.querySelector('button[aria-pressed="true"]');
              if (on) on.focus({ preventScroll: true });
            } })));
      }
    }

    function gameCard(vm) {
      const open = () => openGame(vm.key);
      const game = { name: vm.name, cover: vm.cover };
      return el("article", {
        class: cls("sb-game", vm.active ? "" : "is-done"), tabindex: "0", role: "button", "data-fid": "game:" + vm.key,
        "aria-label": vm.name + ": " + plural(vm.onSaleBundles, "bundle") + " on sale, " + usd(vm.revenueAll) + " sold. Open details.",
        onClick: open, onKeydown: (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); open(); } },
      },
      el("div", { class: "sb-art", style: artBackground(vm.name) },
        banner(vm.banner),
        el("div", { class: "sb-art-top" }, vm.sources.map((s) => farmPill(s, true))),
        el("div", { class: "sb-art-bottom" }, cover(game),
          el("div", { class: "sb-title" },
            el("h3", { title: vm.name }, vm.name),
            el("span", null, plural(vm.campaigns, "campaign") + " · " + plural(vm.listings, "listing"))))),
      el("div", { class: "sb-game-bd" },
        el("div", { class: "sb-nums" },
          el("div", { class: cls("sb-num", vm.onSaleBundles ? "is-ok" : "is-quiet") }, el("b", fmt.num(vm.onSaleBundles)), el("span", "bundles on sale")),
          el("div", { class: cls("sb-num", vm.revenueAll ? "" : "is-quiet") }, el("b", usd(vm.revenueAll)), el("span", plural(vm.soldBundles, "bundle") + " sold")),
          el("div", { class: cls("sb-num", vm.inStock ? "" : "is-quiet") }, el("b", fmt.num(vm.inStock)), el("span", "codes in stock"))),
        vm.markets.length
          ? el("div", { class: "sb-mks" }, vm.markets.map((x) => marketPill(x[0], el("b", x[1] ? x[1] + " live" : "not live"))))
          : el("div", { class: "sb-mks" }, pill("is-muted", vm.drafts ? "Draft, not listed yet" : "Not listed on any market")),
        el("div", { class: "sb-rw", "aria-label": "Rewards" },
          vm.rewards.map((r) => el("span", { class: cls("sb-rw-item", r.onSale ? "" : "is-out"),
            title: r.label + " — " + fmt.num(r.onSale) + " on sale, " + fmt.num(r.sold) + " sold" + (r.inStock ? ", " + fmt.num(r.inStock) + " in stock" : "") },
          rewardPic(r), el("b", fmt.num(r.onSale)))),
          vm.moreRewards ? el("span", { class: "sb-rw-item sb-rw-more", title: vm.moreRewards + " more rewards" }, "+" + vm.moreRewards) : null),
        vm.warn.length ? el("div", { class: "sb-warns" }, vm.warn.map((w) => ui.badge(w.until != null ? el("span", null, w.text, until(w.until)) : w.text, w.tone))) : null),
      el("div", { class: "sb-game-ft" },
        vm.lastSale
          ? el("span", { class: "sb-grow" }, ago(vm.lastSale.soldAt, "Last sale "), " on " + marketName(vm.lastSale.market) + " · " + usd(vm.lastSale.usd))
          : vm.lastSoldAt ? el("span", { class: "sb-grow" }, ago(vm.lastSoldAt, "Last sale ")) : el("span", { class: "sb-grow" }, "No sales yet")));
    }

    // ---------- Game drawer -----------------------------------------------------------------------
    function openGame(key) {
      if (drawer && drawer.handle) drawer.handle.close();
      const m = model();
      const x = m.allGames.find((g) => g.g.key === key);
      if (!x) return;
      const state = { key, sig: "" };
      state.handle = K.drawer({ title: x.g.name, size: "lg", body: el("div"), onClose: () => { if (drawer === state) drawer = null; } });
      drawer = state;
      refreshDrawer(m);
    }
    function refreshDrawer(m) {
      const x = m.allGames.find((g) => g.g.key === drawer.key);
      const body = drawer.handle && drawer.handle.body;
      if (!x || !body) return;
      const sig = JSON.stringify([st.farm, cardModel(x), x.prods.map((p) => [p.id, p.status, p.units, p.listings, p.sold, p.useBy]),
        x.sales.map((s) => [s.id, s.dead]), x.camps.map((c) => [c.groupKey, c.codes, c.nextUseBy, c.rewards.map((r) => [r.slotKey, r.codes])])]);
      if (sig === drawer.sig) return;
      drawer.sig = sig;
      keepFocus(body, drawer.handle.el, () => fill(body, gameDetail(x, m)));
    }

    function gameDetail(x, m) {
      const g = x.g;
      const prods = x.prods.slice().sort((a, b) => {
        const rank = (p) => (isLiveProduct(p) ? 0 : p.status === "draft" ? 1 : p.status === "retired" ? 3 : 2);
        return rank(a) - rank(b) || num(b.units.available) - num(a.units.available) || num(soldOf(b).usd) - num(soldOf(a).usd);
      });
      const sources = unique(x.camps.map((c) => c.source));
      const soon = x.nextUseBy != null && x.nextUseBy - m.nowMs < SOON_MS;
      return el("div", null,
        el("div", { class: "sb-hero", style: artBackground(g.name) }, banner(x.banner),
          el("div", { class: "sb-art-bottom" }, cover(g, "lg"),
            el("div", { class: "sb-title" }, el("h3", null, g.name),
              el("span", null, sources.map((s) => FARM_NAMES[s]).join(" + ") + " · " + plural(x.camps.length, "campaign"))))),
        el("div", { class: "s-stats" },
          ui.stat("Bundles on sale", fmt.num(x.onSaleBundles), plural(x.codes.onSale, "code"), x.onSaleBundles ? "ok" : null),
          ui.stat("Sold", usd(x.revenue.all), plural(x.soldBundles, "bundle") + " · " + usd(x.revenue.d7) + " in 7 days"),
          ui.stat("In stock", fmt.num(x.codes.inStock), "codes not in a bundle yet"),
          ui.stat("Expiring / expired", fmt.num(x.codes.expiring) + " / " + fmt.num(x.codes.expired),
            x.nextUseBy != null ? el("span", null, "next use-by ", until(x.nextUseBy)) : "nothing left to expire", soon ? "warn" : null)),
        (g.sellOff || []).length
          ? el("div", { class: "s-note is-warn", style: { marginTop: "12px" } }, ui.icon("alert"),
            el("span", null, "Selling is switched off for " + (g.gameNos.length > 1 ? "part of this game (game no. " + g.sellOff.join(", ") + ")" : "this game") + " in Sales → Settings, so its new codes are not bundled."))
          : null,
        el("section", { class: "sb-sec" }, el("h4", null, "Where it's listed ", ui.badge(String(prods.length))),
          prods.length ? prods.map((p) => productCard(p, g)) : el("div", { class: "sb-empty-card" }, ui.empty("No listing yet", "The shop bundles new codes on its next run (every 5 minutes)."))),
        el("section", { class: "sb-sec" }, el("h4", null, "Campaigns and rewards ", ui.badge(String(x.camps.length))),
          el("div", { class: "sb-key" },
            el("span", null, el("i", { class: "is-sale" }), "on sale"), el("span", null, el("i", { class: "is-sold" }), "sold"),
            el("span", null, el("i", { class: "is-stock" }), "in stock"), el("span", null, el("i", { class: "is-exp" }), "expiring"),
            el("span", null, el("i", { class: "is-gone" }), "expired / held")),
          x.camps.map((c) => campaignBlock(c))),
        el("section", { class: "sb-sec" }, el("h4", null, "Sales ", ui.badge(String(x.sales.length))),
          x.sales.length ? el("div", { class: "s-card" }, x.sales.slice(0, 40).map((s) => saleRow(s, m, { inDrawer: true })))
            : el("div", { class: "sb-empty-card" }, ui.empty("No sales yet", "Sales show up here the minute a market reports them."))));
    }

    function productCard(p, g) {
      const ps = productState(p);
      const sold = soldOf(p);
      return el("div", { class: cls("sb-lc", p.status === "retired" ? "is-dim" : "") },
        cover(g, "sm"),
        el("div", { class: "sb-lc-main" },
          el("div", { class: "s-row" }, ui.badge(ps.word, ps.tone), (p.sources || []).map((s) => farmPill(s))),
          el("div", { class: "sb-lc-title", title: p.name }, p.name),
          p.title ? el("div", { class: "sb-lc-sub", title: p.title }, p.title) : null,
          el("div", { class: "sb-mini-rw" }, p.rewards.slice(0, 12).map((r) => rewardPic(r, r.label))),
          el("div", { class: "sb-lc-meta" },
            el("span", null, el("b", fmt.num(p.units.available)), " on sale"),
            el("span", null, el("b", fmt.num(sold.units)), " sold" + (sold.usd ? " · " + usd(sold.usd) : "")),
            p.sold.lastAt ? el("span", null, ago(p.sold.lastAt, "last ")) : null,
            p.useBy ? el("span", null, until(p.useBy, "codes valid ")) : null),
          p.listings.length
            ? el("div", { class: "s-stack is-tight" }, p.listings.map((l) => {
              const w = LISTING_WORD[l.state] || [l.state, null];
              const here = soldHere(p, l.market);
              return el("div", { class: "s-row" },
                marketPill(l.market), ui.badge(w[0], w[1]),
                el("span", { class: "s-small s-muted" }, usd(l.price) + (here.units ? " · " + plural(here.units, "sale") + " here" : "")),
                openLink(l.url, "open:" + p.id + ":" + l.market + ":" + l.externalId),
                l.lastError ? el("span", { class: "sb-err" }, l.lastError) : null);
            }))
            : el("span", { class: "s-small s-muted" }, p.status === "draft" ? "Not published yet." : "Not on any market.")),
        el("div", { class: "sb-lc-side" }, el("span", { class: "sb-price" }, p.priceUsd != null ? usd(p.priceUsd) : "–")));
    }

    function campaignBlock(c) {
      const k = c.codes;
      const total = k.onSale + k.inVault + k.sold + k.dead + k.inStock + k.expiring + k.expired + k.held;
      const seg = (n, klass) => (n > 0 && total > 0 ? el("i", { class: klass, style: { width: (n / total) * 100 + "%" } }) : null);
      const end = ms(c.endAt);
      const start = ms(c.startAt);
      const nowT = Date.now();
      return el("div", { class: "sb-camp" },
        el("div", { class: "sb-camp-hd" },
          c.banner ? el("img", { src: c.banner, alt: "", loading: "lazy", referrerpolicy: "no-referrer", onError: (e) => e.currentTarget.replaceWith(el("span", { class: "sb-camp-noimg" })) }) : el("span", { class: "sb-camp-noimg" }),
          el("div", { class: "sb-camp-title" },
            el("b", { title: c.title }, c.title || "Campaign " + c.groupKey),
            el("span", null, (start != null ? fmt.when(new Date(start).toISOString()) + " → " : "") + (end != null ? fmt.when(new Date(end).toISOString()) : "no end date"),
              end != null ? " · " : null, end != null ? (end > nowT ? until(end, "ends ") : ago(end, "ended ")) : null)),
          farmPill(c.source)),
        el("div", { class: "sb-stackbar", title: fmt.num(k.onSale + k.inVault) + " on sale · " + fmt.num(k.sold + k.dead) + " sold · " + fmt.num(k.inStock) + " in stock · " + fmt.num(k.expiring) + " expiring · " + fmt.num(k.expired + k.held) + " expired or held" },
          seg(k.onSale + k.inVault, "is-sale"), seg(k.sold + k.dead, "is-sold"), seg(k.inStock, "is-stock"), seg(k.expiring, "is-exp"), seg(k.expired + k.held, "is-gone")),
        el("div", { class: "sb-rewards" }, c.rewards.map((r) => el("div", { class: "sb-reward", title: r.nameRaw && r.nameRaw !== r.label ? r.nameRaw : r.label },
          rewardPic(r),
          el("div", null, el("b", r.label || r.nameRaw || "Reward"),
            el("span", null, [r.codes.onSale ? fmt.num(r.codes.onSale) + " on sale" : "", (r.codes.sold + r.codes.dead) ? fmt.num(r.codes.sold + r.codes.dead) + " sold" : "",
              r.codes.inStock ? fmt.num(r.codes.inStock) + " in stock" : "", r.codes.expiring ? fmt.num(r.codes.expiring) + " expiring" : "",
              r.codes.expired ? fmt.num(r.codes.expired) + " expired" : ""].filter(Boolean).join(" · ") || "nothing left"))))));
    }

    // ---------- Marketplaces view -----------------------------------------------------------------
    function paintMarkets(m) {
      const q = st.q.toLowerCase();
      const products = q ? m.products.filter((p) => (p.name + " " + p.title + " " + p.rewards.map((r) => r.label).join(" ")).toLowerCase().indexOf(q) !== -1) : m.products;
      const d = m.d;
      const markets = MARKET_ORDER.map((id) => d.markets.find((x) => x.id === id) || { id, name: marketName(id), on: false });
      const notListed = notListedItems(m, products);
      const sig = JSON.stringify([st.farm, q, products.map((p) => [p.id, p.status, p.units, p.listings, p.sold]), markets.map((x) => x.on), m.daily,
        m.sales.slice(0, 1).map((s) => s.id), notListed.map((n) => n.key + n.text)]);
      if (sig === v.marketsSig) return;
      v.marketsSig = sig;
      const gameOf = (p) => m.gameByNo.get(String(p.gameNo)) || { name: p.name, cover: "" };

      const cols = markets.map((mk) => {
        const rows = products.filter((p) => p.listings.some((l) => l.market === mk.id));
        const listingOf = (p) => p.listings.find((l) => l.market === mk.id && l.state === "live") || p.listings.find((l) => l.market === mk.id);
        const rank = { live: 0, paused: 1, error: 2, down: 3 };
        rows.sort((a, b) => rank[listingOf(a).state] - rank[listingOf(b).state] || num(b.units.available) - num(a.units.available) || num(soldHere(b, mk.id).usd) - num(soldHere(a, mk.id).usd));
        const live = rows.filter((p) => listingOf(p).state === "live");
        const onSale = live.filter((p) => p.status === "active").reduce((n, p) => n + num(p.units.available), 0);
        const soldUnits = products.reduce((n, p) => n + num(soldHere(p, mk.id).units), 0);
        const soldUsd = products.reduce((n, p) => n + num(soldHere(p, mk.id).usd), 0);
        const week = m.daily.slice(-7).reduce((o, day) => { day.rows.forEach((r) => { if (r.market === mk.id) { o.units += r.units; o.usd += r.usd; } }); return o; }, { units: 0, usd: 0 });
        const last = m.sales.find((s) => s.market === mk.id);
        const problems = rows.filter((p) => listingOf(p).state === "error").length;
        return el("div", { class: "sb-col" },
          el("div", { class: cls("sb-col-hd", "is-" + marketClass(mk.id)) },
            el("h3", null, mk.name || marketName(mk.id), ui.badge(mk.on ? "Selling" : "Switched off")),
            el("p", null, last ? el("span", null, ago(last.soldAt, "Last sale "), " · " + usd(saleUsd(last))) : "No sales yet"),
            el("div", { class: "sb-col-stats" },
              el("div", null, el("b", fmt.num(live.length)), el("span", "live listings" + (problems ? " · " + problems + " with errors" : ""))),
              el("div", null, el("b", fmt.num(onSale)), el("span", "bundles on sale")),
              el("div", null, el("b", usd(soldUsd)), el("span", plural(soldUnits, "bundle") + " sold · " + usd(week.usd) + " in 7 d")))),
          rows.length ? rows.map((p) => listingCard(p, listingOf(p), gameOf(p), mk.id))
            : el("div", { class: "sb-empty-card" }, ui.empty("Nothing listed here", q ? "No listing matches the search." : mk.on ? "No bundle is listed on " + (mk.name || mk.id) + " for this farm." : "This market is switched off in Sales → Settings.")));
      });
      const notCol = el("div", { class: "sb-col" },
        el("div", { class: "sb-col-hd is-none" },
          el("h3", null, "Not listed", ui.badge(String(notListed.length))),
          el("p", null, "Drafts, bundles missing from a market, and codes that are not in a bundle yet.")),
        notListed.length ? notListed.map((n) => n.node)
          : el("div", { class: "sb-empty-card" }, ui.empty("Everything is listed", "Every bundle is live where it should be.")));
      keepFocus(v.views.markets, v.views.markets, () => fill(v.views.markets, el("div", { class: "sb-cols" }, cols, notCol)));
    }

    function listingCard(p, l, g, marketId) {
      const w = LISTING_WORD[l.state] || [l.state, null];
      const here = soldHere(p, marketId);
      return el("div", { class: cls("sb-lc", l.state === "down" ? "is-dim" : "") },
        cover(g, "sm"),
        el("div", { class: "sb-lc-main" },
          el("div", { class: "s-row" }, ui.badge(w[0], w[1]), (p.sources || []).map((s) => farmPill(s)), p.status !== "active" ? ui.badge(productState(p).word) : null),
          el("div", { class: "sb-lc-title", title: p.title || p.name }, p.name),
          el("div", { class: "sb-mini-rw" }, p.rewards.slice(0, 10).map((r) => rewardPic(r, r.label))),
          el("div", { class: "sb-lc-meta" },
            el("span", null, el("b", fmt.num(p.units.available)), " on sale"),
            el("span", null, el("b", fmt.num(here.units)), " sold here" + (here.usd ? " · " + usd(here.usd) : "")),
            here.lastAt ? el("span", null, ago(here.lastAt, "last ")) : null),
          l.lastError ? el("div", { class: "sb-err" }, l.lastError) : null),
        el("div", { class: "sb-lc-side" }, el("span", { class: "sb-price" }, usd(l.price)), openLink(l.url, "mk:" + p.id + ":" + marketId + ":" + l.externalId)));
    }

    function notListedItems(m, products) {
      const out = [];
      const cfg = m.d.config || {};
      const gameOf = (p) => m.gameByNo.get(String(p.gameNo)) || { name: p.name, cover: "" };
      const item = (key, g, title, text, tone) => ({ key, text, node: el("div", { class: "sb-lc" }, cover(g, "sm"),
        el("div", { class: "sb-lc-main" }, el("div", { class: "s-row" }, ui.badge(tone[0], tone[1])), el("div", { class: "sb-lc-title" }, title), el("div", { class: "sb-lc-sub", title: text }, text))) });
      products.forEach((p) => {
        if (p.status === "draft") {
          out.push(item("draft:" + p.id, gameOf(p), p.name, cfg.autoPublish ? "Publishes by itself on the next shop run if its texts pass the checks." : "Waiting for your approval in Sales → Products.", ["Draft", "info"]));
          return;
        }
        if (p.status === "paused") { out.push(item("paused:" + p.id, gameOf(p), p.name, "Paused: " + plural(p.units.available, "bundle") + " held back from every market.", ["Paused", "warn"])); return; }
        if (p.status !== "active" || !num(p.units.available)) return;
        (p.markets || []).forEach((mk) => {
          if (!(cfg.markets || {})[mk]) return;
          if (p.listings.some((l) => l.market === mk && l.state === "live")) return;
          const l = p.listings.find((x) => x.market === mk);
          out.push(item("missing:" + p.id + ":" + mk, gameOf(p), p.name,
            l ? marketName(mk) + " listing is " + (LISTING_WORD[l.state] || [l.state])[0].toLowerCase() + (l.lastError ? ": " + l.lastError : "") + "."
              : "Meant for " + marketName(mk) + " but not listed there yet.", ["Missing on " + marketName(mk), "warn"]));
        });
      });
      const q = st.q.toLowerCase();
      m.allGames.forEach((x) => {
        if (!x.codes.inStock) return;
        if (q && x.hay.indexOf(q) === -1) return;
        const off = (x.g.sellOff || []).length > 0;
        out.push(item("stock:" + x.g.key, x.g, x.g.name, plural(x.codes.inStock, "code") + " earned, not in a bundle yet. "
          + (off ? "Selling is switched off for this game in Sales → Settings." : "The shop bundles them on its next run once there are enough."), ["In stock", off ? "warn" : null]));
      });
      return out;
    }

    // ---------- Sales view ----------------------------------------------------------------------------
    // The view's frame (cards, headers, the Bundles/Dollars chips) is built once;
    // only the chart, the best sellers and the feed are redrawn, when they change.
    function salesFrame() {
      if (v.sales) return v.sales;
      const s = {};
      s.metric = ui.chips({ options: [{ value: "units", label: "Bundles" }, { value: "usd", label: "Dollars" }], value: st.metric,
        onChange: (x) => { st.metric = x; store("metric", x); v.salesSig = ""; paint(); } });
      s.metric.setAttribute("aria-label", "Chart shows");
      s.title = el("h2", { class: "s-card-title s-grow" });
      s.meta = el("span", { class: "s-small s-muted" });
      s.bars = el("div");
      s.best = el("div");
      s.feedCount = el("span", { class: "s-small s-muted" });
      s.feed = el("div", { tabindex: "-1" });
      fill(v.views.sales,
        el("div", { class: "sb-split" },
          el("section", { class: "s-card" },
            el("div", { class: "s-card-hd" }, s.title, s.metric),
            el("div", { class: "s-card-bd s-stack" },
              el("div", { class: "s-spread" }, s.meta, el("div", { class: "sb-legend" }, MARKET_ORDER.map((mk) => el("span", { class: "is-" + mk }, el("i"), marketName(mk))))),
              s.bars)),
          el("section", { class: "s-card" }, el("div", { class: "s-card-hd" }, el("h2", { class: "s-card-title s-grow" }, "Best sellers")), s.best)),
        el("section", { class: "s-card" }, el("div", { class: "s-card-hd" }, el("h2", { class: "s-card-title s-grow" }, "Sales"), s.feedCount), s.feed));
      v.sales = s;
      return s;
    }

    function paintSales(m) {
      const s = salesFrame();
      if (s.metric.value() !== st.metric) s.metric.set(st.metric);
      const q = st.q.toLowerCase();
      const sales = q ? m.sales.filter((x) => {
        const g = m.gameByNo.get(String(x.gameNo));
        return ((x.productName || "") + " " + (g ? g.name : "") + " " + marketName(x.market)).toLowerCase().indexOf(q) !== -1;
      }) : m.sales;
      const sig = JSON.stringify([st.farm, q, st.metric, m.daily, sales.map((x) => [x.id, x.dead]), m.todayKey, m.products.map((p) => [p.id, p.sold])]);
      if (sig === v.salesSig) return;
      v.salesSig = sig;
      const total = m.daily.reduce((o, day) => { day.rows.forEach((r) => { o.units += r.units; o.usd += r.usd; }); return o; }, { units: 0, usd: 0 });
      s.title.textContent = "Sold per day — last " + m.daily.length + " days";
      s.meta.textContent = plural(total.units, "bundle") + " · " + usd(total.usd) + " in " + m.daily.length + " days";
      fill(s.bars, bars(m));
      fill(s.best, bestSellers(m));
      s.feedCount.textContent = sales.length >= SALES ? "the latest " + SALES : plural(sales.length, "sale");
      keepFocus(s.feed, s.feed, () => fill(s.feed, sales.length ? feedRows(sales, m)
        : ui.empty(q ? "No sale matches “" + st.q + "”" : "No sales yet", q ? "" : "Sales show up here the minute a market reports them.")));
    }

    function bars(m) {
      const metric = st.metric;
      const days = m.daily.map((day) => {
        const by = {};
        day.rows.forEach((r) => { const k = marketClass(r.market); by[k] = (by[k] || 0) + (metric === "usd" ? r.usd : r.units); });
        const units = day.rows.reduce((n, r) => n + r.units, 0);
        const money = day.rows.reduce((n, r) => n + r.usd, 0);
        return { day: day.day, by, value: metric === "usd" ? money : units, units, money, rows: day.rows };
      });
      const max = Math.max(1, ...days.map((x) => x.value));
      return el("div", { class: "sb-bars", role: "img", "aria-label": "Sales per day: " + days.map((x) => x.day + " " + (metric === "usd" ? usd(x.money) : x.units)).join(", ") },
        days.map((x) => {
          const dd = dayDate(x.day);
          const parts = MARKET_ORDER.concat(["other"]).filter((k) => x.rows.some((r) => marketClass(r.market) === k)).map((k) => {
            const rs = x.rows.filter((r) => marketClass(r.market) === k);
            return marketName(k === "other" ? rs[0].market : k) + " " + rs.reduce((n, r) => n + r.units, 0) + " (" + usd(rs.reduce((n, r) => n + r.usd, 0)) + ")";
          });
          const tip = dayLabel(x.day, m.todayKey) + ": " + plural(x.units, "bundle") + ", " + usd(x.money) + (parts.length ? " — " + parts.join(", ") : "");
          const pct = Math.max(3, (x.value / max) * 100);
          return el("div", { class: cls("sb-bars-col", x.day === m.todayKey ? "is-today" : ""), title: tip },
            el("div", { class: "sb-bars-plot" },
              x.value > 0
                ? el("div", { class: "sb-bars-stack", style: { height: pct + "%" } },
                  MARKET_ORDER.concat(["other"]).filter((k) => x.by[k] > 0).map((k) => el("i", { class: "is-" + k, style: { flexGrow: String(x.by[k]) } })))
                : el("div", { class: "sb-bars-zero" }),
              x.value > 0 ? el("span", { class: "sb-bars-val", style: { bottom: "calc(" + pct + "% + 2px)" } }, metric === "usd" ? "$" + (x.value >= 10 ? Math.round(x.value) : x.value.toFixed(2).replace(/\.00$/, "")) : String(x.value)) : null),
            el("div", { class: "sb-bars-x" }, el("b", dd ? String(dd.getDate()) : x.day.slice(-2)), dd ? WEEKDAYS[dd.getDay()].slice(0, 2) : ""));
        }));
    }

    function bestSellers(m) {
      const rows = m.products.filter((p) => num(soldOf(p).units) > 0).sort((a, b) => num(soldOf(b).usd) - num(soldOf(a).usd) || num(soldOf(b).units) - num(soldOf(a).units)).slice(0, 6);
      const top = rows.length ? num(soldOf(rows[0]).usd) || 1 : 1;
      if (!rows.length) return ui.empty("Nothing sold yet", "The listings that earn the most show up here.");
      return el("div", null, rows.map((p, i) => {
        const g = m.gameByNo.get(String(p.gameNo)) || { name: p.name, cover: "" };
        const markets = Object.keys(p.sold.byMarket || {});
        const sold = soldOf(p);
        return el("div", { class: "sb-rank" }, el("span", { class: "sb-rank-n" }, String(i + 1)), cover(g, "xs"),
          el("div", { class: "s-grow", style: { minWidth: "0" } },
            el("div", { class: "s-spread" }, el("b", { class: "s-trunc", title: p.name, style: { fontSize: "12.5px" } }, p.name), el("b", { class: "s-num" }, usd(sold.usd))),
            el("div", { class: "sb-meter", title: markets.map((k) => marketName(k) + ": " + plural(soldHere(p, k).units, "bundle") + ", " + usd(soldHere(p, k).usd)).join(" · ") },
              markets.map((k) => el("i", { class: "is-" + marketClass(k), style: { width: (num(soldHere(p, k).usd) / top) * 100 + "%" } }))),
            el("span", { class: "s-small s-muted" }, plural(sold.units, "bundle"))));
      }));
    }

    // The feed groups by day in the zone the server counted days in.
    function feedRows(sales, m) {
      const keyOf = (s) => { const t = ms(s.soldAt); return t != null ? m.zone.dayKey(t) : ""; };
      const totals = new Map();
      sales.forEach((s) => {
        const k = keyOf(s);
        const x = totals.get(k) || { n: 0, usd: 0 };
        x.n += 1; x.usd += num(saleUsd(s));
        totals.set(k, x);
      });
      const out = [];
      let day = null;
      sales.forEach((s) => {
        const key = keyOf(s);
        if (key !== day) {
          day = key;
          const x = totals.get(key);
          out.push(el("div", { class: "sb-day-hd" }, el("span", null, dayLabel(key, m.todayKey)), el("span", null, plural(x.n, "sale") + " · " + usd(x.usd))));
        }
        out.push(saleRow(s, m));
      });
      return el("div", null, out);
    }

    function saleRow(s, m, o) {
      const inDrawer = !!(o && o.inDrawer);
      const g = m.gameByNo.get(String(s.gameNo));
      const t = ms(s.soldAt);
      const share = saleUsd(s);
      const partial = st.farm !== "all" && Math.abs(num(share) - num(s.usd)) > 0.004;
      const onDay = t != null ? dayDate(m.zone.dayKey(t)) : null;
      return el("div", { class: "sb-sale" },
        el("span", { class: "sb-sale-time", title: t != null ? fmt.when(new Date(t).toISOString()) : "" },
          t == null ? "–" : inDrawer ? (onDay ? MONTHS[onDay.getMonth()] + " " + onDay.getDate() : "") : m.zone.clock(t)),
        inDrawer ? null : cover(g || { name: s.productName, cover: "" }, "xs"),
        el("div", { class: "sb-sale-main" },
          el("b", { title: s.productName }, s.productName || "A listing that no longer exists"),
          el("div", { class: "sb-sale-tags" },
            marketPill(s.market),
            (s.sources || []).map((x) => farmPill(x)),
            el("span", null, plural(s.codes, "code")),
            s.dead ? ui.badge(plural(s.dead, "code") + " reported dead", "error") : null,
            inDrawer ? null : g ? el("span", null, g.name) : null,
            s.orderId ? el("span", { class: "s-mono", title: "Order id" }, "#" + String(s.orderId).slice(0, 12)) : null)),
        el("span", { class: "sb-price", title: partial ? FARM_NAMES[st.farm] + " codes' share of a " + usd(s.usd) + " bundle" : null },
          usd(share), partial ? el("span", { class: "s-small s-muted" }, " of " + usd(s.usd)) : null));
    }

    // ---------- registration ------------------------------------------------------------------------
    K.on("tab", (e) => { if (!e || e.id !== "listings") { clearTimeout(st.timer); st.timer = 0; } });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(); });

    K.registerTab({
      id: "listings",
      label: "Listings",
      render,
      // Every poll of the page while this tab is on screen: the status line and
      // the clock texts, and restarting the 30 s chain if it stopped.
      update() {
        paintStatus();
        paintTimes();
        if (!st.timer && !st.busy) schedule();
      },
      // Listing errors on this panel's own farm's bundles.
      badge() {
        if (!st.data) return null;
        const errors = st.data.products.filter((p) => (p.sources || []).indexOf(own) !== -1)
          .reduce((n, p) => n + p.listings.filter((l) => l.state === "error").length, 0);
        return errors ? { text: errors, tone: "error" } : null;
      },
    });
    // Once at page load, so the tab badge can show; after that only while on screen.
    if (!st.data && !st.busy) refresh();
  }

  window.ShopBoard = { mountTab };
})();
