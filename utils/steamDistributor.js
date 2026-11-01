// Which market gets each new Steam account (owner, 2026-11-01: "I will add more
// accounts … the system decides Eldorado or G2G"). Contract: docs/STEAM-SALES.md (v2).
//
// Every 5 min (mode "on"), ready stock accounts (same vet as listing: empty,
// signup country, login saved, inbox used for Steam only) are placed one by
// one, oldest first, at most MAX_PER_PASS:
//   1. the market whose offer for that country holds FEWER unsold accounts;
//   2. tie → the market with more Steam sales in the last 14 days;
//   3. tie → G2G (empty accounts sell there with volume; Eldorado's floor is $0.05).
// A market that could not take a country's accounts (offer couldn't be made or
// loaded) is skipped for that country for SKIP_MS, so they go to the other one.
// Missing offers are created on the fly: an Eldorado region listing, or a G2G
// region offer. "plan" only records what it would do.

const SteamSale = require("../models/SteamSale");
const SteamListing = require("../models/SteamListing");
const SteamSalesState = require("../models/SteamSalesState");
const sales = require("./steamSales");
const g2g = require("./steamG2g");

const S = sales._shared;
const MARKETS = ["eldorado", "g2g"];
const MAX_PER_PASS = 20;
const SKIP_MS = 6 * 60 * 60 * 1000;
const SALES_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const TICK_MS = Number(process.env.STEAM_DISTRIBUTOR_MS) || 5 * 60 * 1000;
const FIRST_TICK_MS = 6 * 60 * 1000;
const KEEP_DECISIONS = 30;

const deps = {
  sales,
  g2g,
  notify: async (text) => {
    try {
      await require("./telegram").sendTelegram(text);
    } catch (e) {
      console.error("[steamDistributor] telegram:", (e && e.message) || e);
    }
  },
};

async function eldoradoStockByRegion() {
  const live = await SteamListing.find({ status: { $in: S.LIVE_LISTING } }).select("region accounts.state").lean();
  const m = new Map();
  for (const l of live) m.set(l.region, (m.get(l.region) || 0) + (l.accounts || []).filter((u) => u.state === "listed").length);
  return m;
}

async function recentSales(now) {
  const rows = await SteamSale.aggregate([
    { $match: { orderCreatedAt: { $gte: new Date(now - SALES_WINDOW_MS) } } },
    { $group: { _id: "$market", n: { $sum: 1 } } },
  ]);
  const out = { eldorado: 0, g2g: 0 };
  for (const r of rows) if (r._id in out) out[r._id] = r.n;
  return out;
}

// The pure choice for one account. `stock` = {eldorado: Map, g2g: Map},
// `sold` = {eldorado: n, g2g: n}, `skipped(market, region)` → bool.
function choose(region, stock, sold, skipped) {
  const open = MARKETS.filter((m) => !skipped(m, region));
  if (!open.length) return null;
  if (open.length === 1) return { market: open[0], why: "the other market is paused for " + region };
  const e = stock.eldorado.get(region) || 0;
  const g = stock.g2g.get(region) || 0;
  if (e !== g) {
    const m = e < g ? "eldorado" : "g2g";
    return { market: m, why: "fewer unsold " + region + " accounts there (Eldorado " + e + ", G2G " + g + ")" };
  }
  if (sold.eldorado !== sold.g2g) {
    const m = sold.eldorado > sold.g2g ? "eldorado" : "g2g";
    return { market: m, why: "same stock (" + e + "); more sales there in 14 days (Eldorado " + sold.eldorado + ", G2G " + sold.g2g + ")" };
  }
  return { market: "g2g", why: "same stock and sales; G2G sells empty accounts better" };
}

async function config() {
  const doc = await SteamSalesState.findById("main").select("distributor distributorSkip priceUsd").lean();
  return {
    mode: (doc && doc.distributor) || "on",
    skip: (doc && doc.distributorSkip) || {},
    priceUsd: (doc && doc.priceUsd) || 1,
  };
}

async function setMode(mode, actor) {
  if (!["on", "plan", "off"].includes(mode)) throw S.userError("Mode is on, plan or off");
  await SteamSalesState.updateOne({ _id: "main" }, { $set: { distributor: mode, updatedBy: String(actor || "") } }, { upsert: true });
  return config();
}

let running = false;
async function run({ force = false, now = Date.now() } = {}) {
  if (running) return { skipped: "busy" };
  running = true;
  try {
    const cfg = await config();
    if (cfg.mode === "off" && !force) return { skipped: "distributor is off" };
    const skipped = (market, region) => {
      const until = Number(cfg.skip[market + "|" + region]) || 0;
      return until > now;
    };
    const ready = await S.stockView({ checkInboxes: true });
    const accounts = [];
    for (const g of ready.groups) for (const a of g.accounts) accounts.push({ ...a, region: g.region });
    accounts.sort((a, b) => new Date(a.signedUpAt || 0) - new Date(b.signedUpAt || 0));
    const pick = accounts.slice(0, MAX_PER_PASS);
    if (!pick.length) {
      await save(now, "nothing to place", []);
      return { placed: 0, decisions: [] };
    }
    const stock = { eldorado: await eldoradoStockByRegion(), g2g: await deps.g2g.stockByRegion() };
    const sold = await recentSales(now);
    const decisions = [];
    for (const a of pick) {
      const c = choose(a.region, stock, sold, skipped);
      if (!c) {
        decisions.push({ at: new Date(now), accountId: a._id, accountName: a.accountName, region: a.region, market: "", why: "both markets paused for " + a.region, done: false });
        continue;
      }
      stock[c.market].set(a.region, (stock[c.market].get(a.region) || 0) + 1);
      decisions.push({ at: new Date(now), accountId: a._id, accountName: a.accountName, region: a.region, market: c.market, why: c.why, done: false });
    }
    if (cfg.mode === "plan" && !force) {
      await save(now, "plan: " + summary(decisions), decisions);
      return { plan: true, decisions };
    }
    // Do it: one call per market + country.
    const groups = new Map();
    for (const d of decisions) {
      if (!d.market) continue;
      const k = d.market + "|" + d.region;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(d);
    }
    const newSkips = {};
    for (const [k, ds] of groups) {
      const [market, region] = k.split("|");
      const ids = ds.map((d) => d.accountId);
      try {
        if (market === "eldorado") await placeEldorado(region, ids, cfg);
        else await placeG2g(region, ids);
        for (const d of ds) d.done = true;
      } catch (e) {
        const msg = String((e && e.message) || e).slice(0, 300);
        for (const d of ds) d.error = msg;
        newSkips[k] = now + SKIP_MS;
        await deps.notify(
          "⚠️ Steam distributor: couldn't put " + ds.length + " " + S.regionName(region) + " account(s) on " +
            (market === "g2g" ? "G2G" : "Eldorado") + ": " + msg + "\nThat market is skipped for " + region +
            " for 6 h; the next pass sends them to the other market.",
        );
      }
    }
    if (Object.keys(newSkips).length) {
      const set = {};
      for (const [k, v] of Object.entries(newSkips)) set["distributorSkip." + k] = v;
      await SteamSalesState.updateOne({ _id: "main" }, { $set: set }, { upsert: true });
    }
    const placed = decisions.filter((d) => d.done).length;
    await save(now, placed + " placed: " + summary(decisions.filter((d) => d.done)), decisions);
    return { placed, decisions };
  } finally {
    running = false;
  }
}

async function placeEldorado(region, ids, cfg) {
  const live = await SteamListing.findOne({ region, status: { $in: S.LIVE_LISTING } }).select("_id").lean();
  if (live) return deps.sales.addAccounts(String(live._id), ids, "distributor");
  return deps.sales.createListing({ region, priceUsd: cfg.priceUsd, accountIds: ids }, "distributor");
}

async function placeG2g(region, ids) {
  let link = await deps.g2g.linkForRegion(region);
  if (!link) link = await deps.g2g.createRegionOffer(region, "distributor");
  return deps.g2g.loadAccounts(link, ids, "distributor");
}

function summary(ds) {
  const by = {};
  for (const d of ds) if (d.market) by[d.market] = (by[d.market] || 0) + 1;
  return Object.entries(by).map(([m, n]) => (m === "g2g" ? "G2G" : "Eldorado") + " " + n).join(", ") || "none";
}

async function save(now, note, decisions) {
  const last = decisions.map((d) => ({
    at: d.at,
    accountName: d.accountName,
    region: d.region,
    market: d.market,
    why: d.why,
    done: !!d.done,
    error: d.error || "",
  }));
  const update = { $set: { distributorLastRunAt: new Date(now), distributorLastNote: String(note).slice(0, 500) } };
  if (last.length) update.$push = { distributorLast: { $each: last, $slice: -KEEP_DECISIONS } };
  await SteamSalesState.updateOne({ _id: "main" }, update, { upsert: true });
}

async function view() {
  const doc = await SteamSalesState.findById("main").select("distributor distributorLastRunAt distributorLastNote distributorLast distributorSkip").lean();
  const now = Date.now();
  const skip = Object.entries((doc && doc.distributorSkip) || {})
    .filter(([, v]) => Number(v) > now)
    .map(([k, v]) => ({ market: k.split("|")[0], region: k.split("|")[1], until: new Date(Number(v)) }));
  return {
    mode: (doc && doc.distributor) || "on",
    lastRunAt: (doc && doc.distributorLastRunAt) || null,
    lastNote: (doc && doc.distributorLastNote) || "",
    last: ((doc && doc.distributorLast) || []).slice().reverse(),
    skipped: skip,
  };
}

let timer = null;
function start() {
  if (timer) return;
  const loop = async () => {
    try {
      const r = await run();
      if (r && r.placed) console.log("[steamDistributor] placed", r.placed);
    } catch (e) {
      console.error("[steamDistributor] run failed:", (e && e.message) || e);
    }
    timer = setTimeout(loop, TICK_MS);
    if (timer.unref) timer.unref();
  };
  timer = setTimeout(loop, FIRST_TICK_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = {
  run,
  start,
  stop,
  view,
  setMode,
  choose,
  _setDeps(over) {
    Object.assign(deps, over || {});
  },
};
