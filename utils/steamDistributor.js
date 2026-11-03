// Steam account allocation, Eldorado-only rollout (owner, 2026-11-03).
// Ready empty accounts go to Eldorado region offers or the reserved hour-boost
// pool. Only Eldorado stock counts toward keepPerRegion. If Eldorado fails,
// accounts wait in stock; there is no fallback to another marketplace.
// Existing G2G sale tracking remains in steamG2g, outside this distributor.
// Contract: docs/STEAM-SALES.md; docs/STEAM-BOOST.md.

const SteamListing = require("../models/SteamListing");
const SteamSalesState = require("../models/SteamSalesState");
const sales = require("./steamSales");
const boost = require("./steamBoost");
const SteamBoost = require("../models/SteamBoost");

const S = sales._shared;
const MAX_PER_PASS = 20;
const SKIP_MS = 6 * 60 * 60 * 1000;
const TICK_MS = Number(process.env.STEAM_DISTRIBUTOR_MS) || 5 * 60 * 1000;
const FIRST_TICK_MS = 6 * 60 * 1000;
const KEEP_DECISIONS = 30;

const deps = {
  sales,
  boost,
  notify: async (text) => {
    try {
      await require("./telegram").sendTelegram(text);
    } catch (e) {
      console.error("[steamDistributor] telegram:", (e && e.message) || e);
    }
  },
};

async function eldoradoStockByRegion() {
  const live = await SteamListing.find({ kind: "region", status: { $in: S.LIVE_LISTING } }).select("region accounts.state").lean();
  const m = new Map();
  for (const l of live) m.set(l.region, (m.get(l.region) || 0) + (l.accounts || []).filter((u) => u.state === "listed").length);
  return m;
}

// Keep the existing choice-call shape for consumers; stock/sales on other
// marketplaces cannot change the Eldorado-only destination.
function choose(region, _stock, _sold, skipped) {
  if (skipped("eldorado", region)) return null;
  return { market: "eldorado", why: "Eldorado-only rollout for " + region };
}

// Boost or not, for one account. `onSale` = unsold accounts of that country
// on the Eldorado region offers, `active` = accounts in the pool now.
function chooseBoost(region, onSale, active, cfg) {
  if (!cfg || !cfg.enabled) return null;
  if (active >= cfg.maxAccounts) return null;
  if (onSale < cfg.keepPerRegion) return null;
  return {
    market: "boost",
    why: region + " already has " + onSale + " on sale (keep " + cfg.keepPerRegion + "); boost pool " + active + "/" + cfg.maxAccounts,
  };
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
    const prepared = cfg.mode !== "plan" || force ? await require("./steamShelf").run() : { placed: 0 };
    const ready = await S.stockView({ checkInboxes: true });
    const accounts = [];
    for (const g of ready.groups) for (const a of g.accounts) accounts.push({ ...a, region: g.region });
    accounts.sort((a, b) => new Date(a.signedUpAt || 0) - new Date(b.signedUpAt || 0));
    const pick = accounts.slice(0, MAX_PER_PASS);
    if (!pick.length) {
      await save(now, "nothing to place", []);
      return { placed: prepared.placed, decisions: [] };
    }
    const stock = { eldorado: await eldoradoStockByRegion() };
    const boostCfg = await deps.boost.settings();
    let boosting = await deps.boost.activeCount();
    const decisions = [];
    let preparedCount = await SteamBoost.countDocuments({});
    for (const a of pick) {
      const onSale = stock.eldorado.get(a.region) || 0;
      const b = chooseBoost(a.region, onSale, boosting, boostCfg);
      if (b) {
        boosting++;
        const purpose = boostCfg.prepareGames && preparedCount % 2 === 0 ? "game" : "boost";
        const saleAppId = boostCfg.games[Math.floor(preparedCount / 2) % boostCfg.games.length];
        preparedCount++;
        decisions.push({ at: new Date(now), accountId: a._id, accountName: a.accountName, region: a.region, market: "boost", purpose, saleAppId, why: b.why + "; " + purpose, done: false });
        continue;
      }
      const c = choose(a.region, stock, null, skipped);
      if (!c) {
        decisions.push({ at: new Date(now), accountId: a._id, accountName: a.accountName, region: a.region, market: "", why: "Eldorado paused for " + a.region, done: false });
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
      if (market === "boost") {
        // Already vetted (stockView checked the inboxes); add() re-checks the stage.
        try {
          const r = { refused: [] };
          for (const d of ds) {
            const one = await deps.boost.add([d.accountId], "distributor", { checkInboxes: false, purpose: d.purpose, saleAppId: d.saleAppId });
            r.refused.push(...one.refused);
          }
          const why = new Map((r.refused || []).map((x) => [String(x.id), x.why]));
          for (const d of ds) {
            if (why.has(String(d.accountId))) d.error = String(why.get(String(d.accountId))).slice(0, 300);
            else d.done = true;
          }
        } catch (e) {
          for (const d of ds) d.error = String((e && e.message) || e).slice(0, 300);
        }
        continue;
      }
      try {
        await placeEldorado(region, ids, cfg);
        for (const d of ds) d.done = true;
      } catch (e) {
        const msg = String((e && e.message) || e).slice(0, 300);
        for (const d of ds) d.error = msg;
        newSkips[k] = now + SKIP_MS;
        await deps.notify(
          "⚠️ Steam distributor: couldn't put " + ds.length + " " + S.regionName(region) + " account(s) on " +
            "Eldorado" + ": " + msg + "\nThat market is skipped for " + region +
            " for 6 h; accounts wait in stock until it can be retried.",
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
  const live = await SteamListing.findOne({ region, kind: "region", status: { $in: S.LIVE_LISTING } }).select("_id").lean();
  if (live) return deps.sales.addAccounts(String(live._id), ids, "distributor");
  return deps.sales.createListing({ region, priceUsd: cfg.priceUsd, accountIds: ids }, "distributor");
}

function summary(ds) {
  const by = {};
  for (const d of ds) if (d.market) by[d.market] = (by[d.market] || 0) + 1;
  const label = { eldorado: "Eldorado", boost: "Hour boost" };
  return Object.entries(by).map(([m, n]) => (label[m] || m) + " " + n).join(", ") || "none";
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
    .filter(([k, v]) => k.startsWith("eldorado|") && Number(v) > now)
    .map(([k, v]) => ({ market: k.split("|")[0], region: k.split("|")[1], until: new Date(Number(v)) }));
  return {
    markets: ["eldorado"],
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
  chooseBoost,
  _setDeps(over) {
    Object.assign(deps, over || {});
  },
};
