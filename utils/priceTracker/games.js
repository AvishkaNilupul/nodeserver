// The per-game board: for each game, what do we sell, at what price on which
// market, how do other sellers price it, and how many accounts is it worth
// farming?
//
// This does NOT replace the farm engine's sizing (utils/farmSizing.js,
// utils/autoFarmer.js `demandAllocation`) or the research scanner
// (utils/marketResearch.js). It reads both and puts them beside the one thing
// neither has: a CLEAN, de-duplicated account of what we actually sold. Where its
// advice differs from the engine's current stance it says so, with the numbers.
//
// THE FARM ADVICE USES THE ENGINE'S OWN ARITHMETIC. `coverageTarget`, `stockGap`,
// `daysOfCover` and `revenueWeight` are imported from utils/farmSizing.js (the
// same functions `coverageSizing` and the no-claim allocator use), so a target
// shown here is the number the engine would compute from the same demand. The only
// difference is the demand it is fed.
//
// WHAT "DEMAND" IS HERE (each rule is a mistake the engine's own count makes):
//   * one sold account counts ONCE, whoever noticed it (a buyer connection flip, a
//     marketplace signal, a delivered unit, a hand sale). That is the rule
//     utils/farmDemand.js already uses for the no-claim games ("an account sells
//     exactly once"); here it applies to every game.
//   * mass-delist and bulk mark-sold signals are NOT sales (see ledger.js). The
//     engine's `internalSalesForGame` counts every `listing_sold` row, so for ~45
//     days after the 2026-09-28 wipe it reads GGSel's delisted stock as demand.
//     `engine` below replays that function exactly so the difference is visible.
//   * delivered units on Eldorado / G2G / PlayerAuctions write no signal at all,
//     so the engine cannot see them unless the buyer later connects the account.
//
// Pure: no DB, no network, no clock but the injected `now`.
const farmSizing = require("../farmSizing");
const A = require("./analyze");
const { normGame } = require("./setIdentity");
const { MARKETS, VENUES, netOf, floorFor } = require("./venues");
const { median, quantile, band, DAY, round2 } = require("./stats");

const ENGINE_WINDOW_DAYS = farmSizing.DEFAULT_SALES_WINDOW_DAYS; // 45, same as autoFarmer
const PRICE_WINDOW_DAYS = 180;

// MarketResearch names the Digiseller/Plati page "plati".
const RESEARCH_KEY = { gameflip: "gameflip", ggsel: "ggsel", digiseller: "plati" };
// EVERY research number describes a search page that includes OUR own rows, with
// one exception: Gameflip's `lowestOther`, which excludes our owner id
// (utils/marketResearch.js scanGame). Gameflip's median / sellers / offers / active
// still count us (Brawlhalla: 6 rows on the page, 4 of them ours), which is the
// self-undercut trap marketPricing.js documents. So only `lowestOther` may ever act
// as a competitor, and a page that is mostly OUR rows is not evidence about rivals.
const SELF_HEAVY_SHARE = 0.5;

const idStr = (x) => (x == null ? "" : String(x).toLowerCase());
const ts = (d) => {
  const t = d ? new Date(d).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
};
const gk = (g) => normGame(g);

/* ------------------------------ engine replay ------------------------------ */

// utils/autoFarmer.js `internalSalesForGame`, run for every game at once:
//   rows with source in {connected, listing_sold}, `at` in the last 45 days,
//   grouped by `account` (or the dedupeKey when a unit has no account) so one sold
//   account is one sale, price = the best any row of that sale carries.
// `dropKeys` removes the rows of sales the ledger set aside; passing it gives the
// count the engine WOULD see if it ignored mass-close and burst signals.
function engineCounts({ signals = [], connected = [], now, dropSaleKeys = null }) {
  const cutoff = now - ENGINE_WINDOW_DAYS * DAY;
  const per = new Map(); // rawGameKey -> Map(group -> maxPrice)
  const add = (row, isSold) => {
    const at = ts(row.at);
    if (at == null || at < cutoff) return;
    const g = String(row.gameKey || "").toLowerCase();
    if (!g) return;
    if (isSold && dropSaleKeys) {
      const m = /^sold:([0-9a-f]{24}):.*:(\d+)$/i.exec(String(row.dedupeKey || ""));
      if (m && dropSaleKeys.has(m[1].toLowerCase() + ":" + m[2])) return;
    }
    const group = row.account ? "a:" + idStr(row.account) : "d:" + String(row.dedupeKey || "");
    if (!per.has(g)) per.set(g, new Map());
    const m = per.get(g);
    const price = Number(row.priceUsd) || 0;
    m.set(group, Math.max(m.get(group) || 0, price));
  };
  for (const s of signals) if (!s.source || s.source === "listing_sold") add(s, true);
  for (const s of connected) add(s, false);
  const out = new Map();
  for (const [raw, groups] of per) {
    let count = 0;
    let revenue = 0;
    let priced = 0;
    for (const p of groups.values()) {
      count += 1;
      revenue += p;
      if (p > 0) priced += 1;
    }
    const key = gk(raw);
    const prev = out.get(key) || { count: 0, revenue: 0, priced: 0 };
    out.set(key, { count: prev.count + count, revenue: prev.revenue + revenue, priced: prev.priced + priced });
  }
  for (const v of out.values()) {
    v.revenue = round2(v.revenue);
    v.avgPrice = v.priced ? round2(v.revenue / v.priced) : 0;
    v.perWeek = round2(farmSizing.salesPerWeek(v.count, ENGINE_WINDOW_DAYS));
  }
  return out;
}

/* ---------------------------- the demand union ----------------------------- */

// Every proven-sold account per game, once.
//
// Identity is the Twitch LOGIN, never the account record id: a login imported
// twice (a re-minted token) is two BotAccount records with two ids, and the
// engine's `account`-keyed count sees two sales where one account sold. Measured
// 2026-10-01: Brawlhalla's 45-day connection flips come from 82 account ids but
// only 45 distinct logins. (utils/farmDemand.js dedupes by login for the no-claim
// games for the same reason.)
//
//   1. a sale or flip that names a single login          -> that login
//   2. one that names only an account id                 -> that account's login,
//      learned wherever both appear, else the account id
//   3. an ANONYMOUS quantity unit (GGSel/Digiseller hand out "whichever unit the
//      platform picks"; its `login` field is the listing's whole delivery pool) ->
//      the first account from that pool whose buyer connection we see afterwards
//      and that no named sale already claimed; else its own record
// so one sale seen by the marketplace AND by the drop scanner is counted once.
function soldUnion({ sales = [], connected = [], now, days = ENGINE_WINDOW_DAYS }) {
  const cutoff = now - days * DAY;
  const acctLogin = new Map();
  for (const c of connected) if (c.account && c.login) acctLogin.set(idStr(c.account), idStr(c.login));
  for (const s of sales) if (s.account && s.login) acctLogin.set(s.account, s.login);

  // game -> login -> earliest connection time (inside the window)
  const connAt = new Map();
  const connected2 = [];
  for (const c of connected) {
    const at = ts(c.at);
    if (at == null || at < cutoff) continue;
    const game = gk(c.game || c.gameKey);
    if (!game) continue;
    const login = idStr(c.login) || acctLogin.get(idStr(c.account)) || "";
    connected2.push({ game, login, account: idStr(c.account), at, key: String(c.dedupeKey || at) });
    if (!login) continue;
    if (!connAt.has(game)) connAt.set(game, new Map());
    const m = connAt.get(game);
    if (!m.has(login) || at < m.get(login)) m.set(login, at);
  }

  const per = new Map(); // game -> Map(identity -> entry)
  const put = (game, identity, entry) => {
    if (!per.has(game)) per.set(game, new Map());
    const m = per.get(game);
    const cur = m.get(identity);
    if (!cur) {
      m.set(identity, { ...entry, sources: new Set([entry.source]) });
      return;
    }
    cur.sources.add(entry.source);
    if (entry.at < cur.at) cur.at = entry.at;
    if (entry.price > cur.price) cur.price = entry.price;
    if ((!cur.market || cur.market === "unknown") && entry.market) cur.market = entry.market;
  };

  const inWin = sales
    .filter((x) => x.gameKey && x.at.getTime() >= cutoff)
    .sort((a, b) => a.at - b.at);
  const taken = new Map(); // game -> Set(login) claimed by a named sale
  const claim = (game, login) => {
    if (!taken.has(game)) taken.set(game, new Set());
    taken.get(game).add(login);
  };
  const anonymous = [];
  for (const x of inWin) {
    // A unit carrying a login POOL ("a, b, c") is one sale out of that pool even when
    // `account` is set (a quantity listing's `accountId` is one of its accounts, copied
    // onto every unit it sells): keying it by that account would collapse every unit of
    // the listing into one identity (22 records -> 12 on the 2026-10-01 snapshot).
    const pooled = Array.isArray(x.logins) && x.logins.length > 1;
    const login = pooled ? "" : x.login || (x.account ? acctLogin.get(x.account) || "" : "");
    if (login) {
      claim(x.gameKey, login);
      put(x.gameKey, "l:" + login, { at: x.at.getTime(), price: x.priced ? x.priceUsd : 0, market: x.market, source: x.source });
    } else if (x.account && !pooled) {
      put(x.gameKey, "a:" + x.account, { at: x.at.getTime(), price: x.priced ? x.priceUsd : 0, market: x.market, source: x.source });
    } else anonymous.push(x);
  }
  for (const x of anonymous) {
    const t = x.at.getTime();
    let identity = "k:" + x.key;
    const conns = connAt.get(x.gameKey);
    if (conns && Array.isArray(x.logins) && x.logins.length) {
      let best = null;
      for (const l of x.logins) {
        const ct = conns.get(l);
        const used = taken.get(x.gameKey);
        if (ct == null || ct < t - DAY || (used && used.has(l))) continue;
        if (!best || ct < best.at) best = { login: l, at: ct };
      }
      if (best) {
        identity = "l:" + best.login;
        claim(x.gameKey, best.login);
      }
    }
    put(x.gameKey, identity, { at: t, price: x.priced ? x.priceUsd : 0, market: x.market, source: x.source });
  }
  for (const c of connected2) {
    const identity = c.login ? "l:" + c.login : c.account ? "a:" + c.account : "k:c:" + c.key;
    put(c.game, identity, { at: c.at, price: 0, market: "unknown", source: "connected" });
  }
  return per;
}

function windowCounts(entries, now) {
  const arr = [...entries.values()];
  const within = (d) => arr.filter((e) => e.at >= now - d * DAY).length;
  const bySource = {};
  const byMarket = {};
  for (const e of arr) {
    for (const s of e.sources) bySource[s] = (bySource[s] || 0) + 1;
    byMarket[e.market || "unknown"] = (byMarket[e.market || "unknown"] || 0) + 1;
  }
  return { units: arr.length, d7: within(7), d14: within(14), d30: within(30), bySource, byMarket };
}

/* --------------------------------- stock ----------------------------------- */

// Units a live listing holds for sale. An estimate, labelled as one: Gameflip and
// ZeusX rows are one account each; GGSel/Digiseller report remaining stock at the
// last guardian pass; Eldorado/G2G/PlayerAuctions hold undelivered unit rows.
function listedUnits(l) {
  const m = String(l.marketplace || "").toLowerCase();
  const units = Array.isArray(l.units) ? l.units : [];
  if (m === "eldorado" || m === "playerauctions" || m === "g2g") {
    const free = units.filter((u) => u && !u.deliveredAt).length;
    return free || (units.length ? 0 : 1);
  }
  if (m === "ggsel" || m === "digiseller") {
    if (Number.isFinite(Number(l.lastStock)) && l.lastStock !== null) return Math.max(0, Number(l.lastStock));
    return units.length || Number(l.qtyTarget) || 1;
  }
  return 1;
}

/* ------------------------------ other sellers ------------------------------- */

function rivalOf(research, market) {
  const key = RESEARCH_KEY[market];
  const m = research && research.markets && key ? research.markets[key] : null;
  if (!m) return null;
  const sold = Number(m.totalSold) || 0;
  return {
    market,
    pageWide: true,
    active: Number(m.active) || 0,
    lowest: Number(m.lowest) || 0,
    // Only Gameflip excludes our rows; elsewhere this stays 0 on purpose.
    lowestOther: market === "gameflip" ? Number(m.lowestOther) || 0 : 0,
    median: Number(m.median) || 0,
    sellers: Number(m.sellers) || 0,
    offers: Number(m.offers) || 0,
    // Gameflip dates its sales; GGSel/Plati only expose a lifetime counter.
    soldRecent: Number(m.soldRecent) || 0,
    avgSoldPrice: Number(m.avgSoldPrice) || 0,
    lifetimeSold: sold,
    scannedAt: research.scannedAt || null,
  };
}

/* ------------------------------ price per market --------------------------- */

const snap = A.snap;
// Round DOWN to the nearest $0.05: a cap that is rounded to the nearest nickel can
// land above itself.
const snapDown = (p) => Math.floor(p * 20 + 1e-9) / 20;

/**
 * What should this game's typical bundle cost on one market?
 *
 * Own sales anchor it (a price someone paid is the only proof a price sells);
 * other markets' sales are translated, never copied; the shared engine is the last
 * resort. Other sellers are a SANITY CEILING and a reason to test, never the
 * target: our realised prices run above the rival page median on every market we
 * can see and still sell (project_market_intelligence), and a rival's asking
 * price is not proof anyone bought it.
 */
function gamePrice(ctx, { gameKey, market, orders, ordersByMarket, research, liveAsks }) {
  const { sales, now, tr } = ctx;
  const floor = floorFor(market);
  const reasons = [];
  let anchor = 0;
  let basis = "none";
  let confidence = "none";
  let n = 0;
  let approx = false;

  const recent = orders.filter((s) => s.at.getTime() >= now - 60 * DAY);
  const use = recent.length >= 3 ? recent : orders;
  if (use.length) {
    anchor = median(use.map((s) => s.priceUsd));
    n = use.length;
    basis = "this game sold on this market";
    confidence = n >= 8 ? "high" : n >= 3 ? "medium" : "low";
    reasons.push(n + " sale" + (n === 1 ? "" : "s") + " of this game here" + (use === recent ? " in the last 60 days" : "") + " (median $" + anchor.toFixed(2) + ").");
    // Eldorado / G2G / PlayerAuctions store no price at delivery: the "sale price" is the
    // listing's price NOW. If a listing was repriced since, that is wrong, so such
    // evidence can reach medium confidence but never high, and never waives the caps.
    approx = use.filter((x) => x.priceBasis === "listing-now").length / use.length >= 0.5;
    if (approx) {
      if (confidence === "high") confidence = "medium";
      reasons.push("Prices on " + market + " are the listing's price now, not the price at sale.");
    }
  } else {
    const translated = [];
    const used = [];
    for (const m of MARKETS) {
      if (m === market || A.isBlocked(m)) continue;
      const os = ordersByMarket.get(m) || [];
      if (os.length < 2) continue;
      const t = tr.translate(median(os.map((s) => s.priceUsd)), m, market);
      if (t.price > 0) {
        translated.push(t.price);
        used.push(m + " (" + os.length + ")");
      }
    }
    if (translated.length) {
      anchor = median(translated);
      n = translated.length;
      basis = "this game sold on other markets, translated";
      confidence = translated.length >= 2 ? "medium" : "low";
      reasons.push("Sold on " + used.join(", ") + "; scaled to " + market + "'s own price level.");
    }
  }
  if (!anchor) {
    try {
      const ev = A.evidenceFromLedger(sales, now, { market, gameKey }, A.pricedOf(ctx));
      const r = require("../pricing").priceListing({ evidence: ev, itemCount: 1, marketplace: market });
      if (r && r.price > 0) {
        anchor = r.price;
        basis = "engine (" + r.basis + ")";
        confidence = "low";
        reasons.push("No sale of this game to learn from; the shared pricing engine says $" + r.price.toFixed(2) + ".");
      }
    } catch {
      /* no answer is a legitimate answer */
    }
  }

  const vs = A.venueP75Of(ctx, market);
  const ref = vs.n >= 10 && vs.p75 > 0 ? vs.p75 : A.globalP75Of(ctx) || 25;
  const cap = Math.max(floor, Math.min(25, ref * 1.5));
  const ownProven = basis === "this game sold on this market" && n >= 3 && !approx;

  let price = anchor > 0 ? (ownProven ? round2(anchor) : snap(anchor)) : 0;
  let clamped = "";
  if (price > cap && !ownProven) {
    price = snapDown(cap);
    clamped = "ceiling";
  }

  // Other sellers: a ceiling when several sellers agree on a much lower page median,
  // and a position either way. A page that is mostly OUR rows says nothing about
  // rivals, so it is neither a ceiling nor a reason to test.
  const rival = rivalOf(research, market);
  const ownShare = rival && rival.active > 0 ? Math.min(1, liveAsks.length / rival.active) : 0;
  const selfHeavy = ownShare >= SELF_HEAVY_SHARE;
  let rivalCeiling = 0;
  if (rival && !selfHeavy && rival.median > 0 && rival.offers >= 3 && rival.sellers >= 2) {
    rivalCeiling = round2(rival.median * 1.5);
    if (price > rivalCeiling && !ownProven) {
      price = snapDown(rivalCeiling);
      clamped = clamped || "rivals";
      reasons.push("Capped at 1.5× the other sellers' page median ($" + rival.median.toFixed(2) + ", includes our own rows).");
    }
  }
  // The platform's floor is applied LAST: a ceiling must never push a price below it
  // (HITMAN on GGSel came out at $0.35 against a $0.75 floor).
  if (price > 0 && price < floor) {
    price = round2(floor);
    clamped = "floor";
  }
  const askMed = median(liveAsks);
  const baseForPosition = askMed || price;
  let position = "no rivals";
  if (rival && baseForPosition > 0) {
    if (selfHeavy) position = "page is mostly our own rows";
    else if (rival.lowestOther > 0 && baseForPosition <= rival.lowestOther + 0.005) position = "cheapest";
    else if (rival.median > 0) {
      const r = baseForPosition / rival.median;
      position = r < 0.8 ? "below the page" : r <= 1.25 ? "at the page" : "above the page";
    }
  }

  // The money-making nudge, only when buyers demonstrably pay our price and other
  // sellers ask much more: one rung up, on a couple of listings, not all of them.
  let test = null;
  if (ownProven && n >= 5 && rival && !selfHeavy && rival.median > 0 && price > 0 && price <= rival.median * 0.7) {
    const up = Math.min(snap(price * 1.35), snapDown(rival.median * 0.9), snapDown(cap));
    if (up > price + 0.04) {
      test = {
        price: up,
        why:
          "Buyers paid about $" + price.toFixed(2) + " here " + n + " times and the page median is $" + rival.median.toFixed(2) +
          " (that page includes our own rows). One rung up on two listings will show whether it still sells.",
      };
    }
  }

  return {
    price: price > 0 ? price : 0,
    anchor: round2(anchor),
    basis,
    confidence,
    evidenceN: n,
    reasons,
    floor,
    cap: round2(cap),
    rivalCeiling,
    clamped,
    position,
    test,
  };
}

/* -------------------------------- farm advice ------------------------------- */

// Below this many accounts a week a game is too small for "farm more" to mean
// anything: the target is then mostly the flat safety stock, and the engine itself
// only lets the coverage model beat its flat per-game cap above ~13 a week
// (project_fleet_sizing). Measured 2026-10-01: 18 of the 21 games first marked "farm
// more" sold under 1.3 a week.
const MIN_FARM_RATE = 2;
// A shortfall must also be a meaningful share of the target: 3 short of 44 is on target.
const MIN_SHORT_SHARE = 0.15;

// How many accounts is this game worth, and what does the engine currently do about
// it? `perWeek` is the CLEAN weekly demand; the target is the engine's own stock-cover
// arithmetic fed with it. The advice also asks whether farming is POSSIBLE: a game
// with no campaign running has no drops to farm, so a shortfall there is "wait", not
// "farm more".
function farmAdvice({
  perWeek, listed, archiveHolders = 0, assignedActive = 0, sizing, valuePerAccount, engineEntry,
  engineCleanPerWeek, gameCap = 0, managed = false, managedBy = "", shelfCap = 0, farmable = false,
  campaign = null, now = Date.now(),
}) {
  // On hand = what we can sell now: the larger of what is listed and what sits unsold
  // in the pool holding this game's drops (the engine's `archiveHolders`, only trusted
  // while fresh). In flight = accounts the engine is farming for a live campaign that
  // do NOT already hold the drops (the assigned roster is the same pool that is later
  // listed, so counting it whole double-counts it).
  const onHand = Math.max(listed, archiveHolders);
  const inFlight = Math.max(0, assignedActive - archiveHolders);
  let target = perWeek > 0
    ? farmSizing.coverageTarget({
        salesPerWeek: perWeek,
        coverageDays: sizing.coverageDays,
        safetyStock: sizing.safetyStock,
        max: sizing.maxAccounts,
      })
    : 0;
  // The operator's own per-game cap (settings gameAccountCaps) beats the model,
  // exactly as it does in the engine (settings.gameAccountCapFor).
  const uncapped = target;
  if (gameCap > 0 && target > gameCap) target = gameCap;
  const gap = farmSizing.stockGap({ target, onHand, inFlight });
  const cover = farmSizing.daysOfCover({ onHand, salesPerWeek: perWeek });
  const latest = engineEntry && engineEntry.latest ? engineEntry.latest : null;
  const decidedAgo = latest && ts(latest.decidedAt) ? now - ts(latest.decidedAt) : Infinity;
  const endsSoon = !!latest && latest.decision === "skip_ends_soon" && decidedAgo < 3 * DAY;

  let direction = "none";
  if (managed) direction = "managed";
  else if (perWeek > 0) {
    if (gap.need >= Math.max(3, Math.ceil(target * MIN_SHORT_SHARE)) && perWeek >= MIN_FARM_RATE) direction = farmable && !endsSoon ? "more" : "wait";
    else if (gap.spare >= Math.max(5, Math.round(target * 0.5))) direction = "less";
    else direction = "hold";
  }

  const reasons = [];
  if (managed) {
    reasons.push(
      managedBy === "reuse-only rule"
        ? "The engine never spends fresh accounts on this game (reuse-only rule): it recycles accounts that already farmed it. Shown for information; this board gives no farm instruction for it."
        : "Farmed by the no-claim allocator (Fleet sizing page), which sizes the bot fleet and the shelf cap as two separate levers. Shown for information; this board gives no farm instruction for it.",
    );
    if (shelfCap > 0) reasons.push("Shelf cap " + shelfCap + " accounts on auto-listings; " + listed + " listed now.");
  }
  if (perWeek <= 0) reasons.push("No proven sale in the last " + ENGINE_WINDOW_DAYS + " days, so nothing justifies farming it for sale.");
  else {
    if (gameCap > 0 && uncapped > gameCap) reasons.push("Your cap for this game is " + gameCap + " accounts (the demand alone would justify " + uncapped + ").");
    reasons.push("Sells about " + round2(perWeek) + " a week; " + sizing.coverageDays + " days of cover plus " + sizing.safetyStock + " safety = " + target + " accounts.");
    reasons.push(
      "Stock on hand " + onHand + " (the larger of " + listed + " listed and " + archiveHolders + " held unsold)" + (inFlight ? " + " + inFlight + " being farmed" : "") + " → " +
        (gap.need ? "short by " + gap.need : gap.spare ? "over by " + gap.spare : "on target") + ".",
    );
    if (Number.isFinite(cover)) reasons.push("Stock on hand lasts about " + round2(cover) + " days at this rate.");
    if (direction === "more") reasons.push("A campaign for this game is running" + (campaign && campaign.endAt ? " until " + String(campaign.endAt).slice(0, 10) : "") + ", so farming can start now.");
    if (direction === "wait") {
      reasons.push(
        endsSoon
          ? "The engine skipped it recently because the campaign ends soon: too late to farm for it."
          : "No campaign is running for this game, so there is nothing to farm until the next one. The target is what to aim for when it returns.",
      );
    }
    if (!managed && gap.need >= Math.max(3, Math.ceil(target * MIN_SHORT_SHARE)) && perWeek < MIN_FARM_RATE) reasons.push("A small game (under " + MIN_FARM_RATE + " a week): the safety stock alone makes the target look short. Not worth a farming decision.");
  }
  const weight = farmSizing.revenueWeight({ salesPerWeek: perWeek, avgPrice: valuePerAccount });
  const stance = latest
    ? {
        decision: latest.decision,
        reason: latest.reason,
        decidedAt: latest.decidedAt,
        campaign: latest.campaignName,
        endsAt: latest.campaignEndAt,
        target: latest.targetAccounts,
        planned: latest.plannedAccounts,
        assigned: latest.assignedN,
        archiveHolders: latest.archiveHolders,
        counts14d: engineEntry.counts14d,
      }
    : null;
  // Where the engine's stance and the clean numbers disagree, say so.
  const notes = [];
  if (engineEntry) {
    const c = engineEntry.counts14d;
    const skips = (c.skip_low_demand || 0) + (c.skip_already_covered || 0);
    const farms = (c.farm || 0) + (c.probe || 0) + (c.reuse_existing || 0);
    if (direction === "more" && skips > 0 && farms === 0) notes.push("The engine skipped this game " + skips + "× in 14 days (low demand / covered) while clean sales justify a higher target.");
    if (!managed && direction === "none" && farms > 0) notes.push("The engine farmed or reused accounts for this game " + farms + "× in 14 days, but the clean evidence shows no sale in " + ENGINE_WINDOW_DAYS + " days.");
  }
  return {
    perWeek: round2(perWeek),
    target,
    listed,
    archiveHolders,
    onHand,
    inFlight,
    need: gap.need,
    spare: gap.spare,
    daysCover: Number.isFinite(cover) ? round2(cover) : null,
    direction,
    farmable: !!farmable,
    campaign: campaign || null,
    weight: round2(weight),
    valuePerAccount: round2(valuePerAccount),
    weeklyRevenueUsd: round2(perWeek * valuePerAccount),
    gameCap: gameCap || 0,
    managed,
    managedBy: managed ? managedBy : "",
    shelfCap: shelfCap || 0,
    cleanVsEnginePerWeek: engineCleanPerWeek != null ? round2(engineCleanPerWeek) : null,
    reasons,
    notes,
    engine: stance,
    sizing,
  };
}

/* ------------------------------ the engine's stance -------------------------- */

// Latest AutoFarmTask per game plus how it has decided over 14 days. Only counts
// and short strings leave this function — never the assigned logins.
function engineStance(tasks, now) {
  const out = new Map();
  const cutoff = now - 14 * DAY;
  for (const t of tasks || []) {
    const key = gk(t.game);
    if (!key) continue;
    const at = ts(t.createdAt) || ts(t.decidedAt) || 0;
    if (!out.has(key)) out.set(key, { latest: null, latestAt: -1, counts14d: {}, active: [] });
    const e = out.get(key);
    const view = {
      decision: t.decision || "",
      reason: String(t.reason || "").slice(0, 200),
      decidedAt: t.decidedAt || t.createdAt || null,
      campaignName: String(t.campaignName || "").slice(0, 100),
      campaignEndAt: t.campaignEndAt || null,
      targetAccounts: Number(t.targetAccounts) || 0,
      plannedAccounts: Number(t.plannedAccounts) || 0,
      assignedN: Number.isFinite(Number(t.assignedN)) ? Number(t.assignedN) : Array.isArray(t.assignedAccounts) ? t.assignedAccounts.length : 0,
      archiveHolders: t.coverage ? Number(t.coverage.archiveHolders) || 0 : 0,
      internalSales: Number(t.internalSales) || 0,
      completed: !!t.completedAt,
    };
    if (at > e.latestAt) {
      e.latest = view;
      e.latestAt = at;
    }
    if (at >= cutoff) e.counts14d[view.decision] = (e.counts14d[view.decision] || 0) + 1;
    const live = (ts(view.campaignEndAt) || 0) > now && !view.completed;
    if (live && ["farm", "probe", "reuse_existing"].includes(view.decision)) e.active.push(view);
  }
  return out;
}

/* ---------------------------------- the board ------------------------------- */

const DEFAULT_SIZING = {
  coverageDays: farmSizing.DEFAULT_COVERAGE_DAYS,
  safetyStock: farmSizing.DEFAULT_SAFETY_STOCK,
  maxAccounts: farmSizing.HARD_MAX_ACCOUNTS,
};

function gameBoard({ ledger, prepared, research = [], tasks = [], signals = [], connected = [], now, fees = {}, ctx, sizing = {}, gameCaps = {}, noClaimGames = [], shelfCaps = {}, reuseOnlyGames = [] }) {
  const sz = { ...DEFAULT_SIZING, ...sizing };
  // utils/settings.isReuseOnlyGame matches the EXACT normalised label.
  const reuseKeys = new Set((reuseOnlyGames || []).map(gk).filter(Boolean));
  // A no-claim game is a KEYWORD bucket ("overwatch" catches "Overwatch 2"), and
  // matching is utils/farmDemand.bucketFor's rule: substring of the normalised name.
  const ncKeys = (noClaimGames || []).map(gk).filter(Boolean);
  const isManaged = (key, rs) => !!(rs && rs.noClaim) || ncKeys.some((k) => key.includes(k));
  const shelfCapFor = (key) => {
    let best = 0;
    for (const [name, v] of Object.entries(shelfCaps || {})) {
      const k = gk(name);
      if (k && key.includes(k)) best = Math.max(best, Math.floor(Number(v)) || 0);
    }
    return best;
  };
  // settings.gameAccountCapFor matches by SUBSTRING of the normalised name (gameMapLookup).
  const capEntries = Object.entries(gameCaps || {}).map(([g, v]) => [gk(g), Math.floor(Number(v)) || 0]).filter(([k]) => k);
  const capFor = (key) => {
    for (const [k, v] of capEntries) if (key.includes(k)) return v;
    return 0;
  };
  const sales = ledger.sales;
  const researchByKey = new Map();
  for (const r of research) {
    const k = gk(r.game);
    // Two spellings of one game ("Stalzone"/"STALZONE"): keep the freshest scan.
    const cur = researchByKey.get(k);
    if (!cur || (ts(r.scannedAt) || 0) > (ts(cur.scannedAt) || 0)) researchByKey.set(k, r);
  }
  const stance = engineStance(tasks, now);
  const engineAll = engineCounts({ signals, connected, now });
  const engineClean = engineCounts({ signals, connected, now, dropSaleKeys: ledger.suspectSaleKeys });
  // Bulk-pack deliveries are demand (accounts consumed) but never price evidence.
  const union = soldUnion({ sales: sales.concat(ledger.demandOnly || []), connected, now });

  // Priced, order-level sales by game and market (180d).
  const priced = A.perOrder(A.windowed(sales, now, PRICE_WINDOW_DAYS)).filter((s) => s.gameKey);
  const ordersBy = new Map(); // game -> market -> [sale]
  for (const s of priced) {
    if (!ordersBy.has(s.gameKey)) ordersBy.set(s.gameKey, new Map());
    const m = ordersBy.get(s.gameKey);
    if (!m.has(s.market)) m.set(s.market, []);
    m.get(s.market).push(s);
  }
  // Live drops listings by game and market.
  const liveBy = new Map(); // game -> market -> [row]
  const gameName = new Map(); // key -> display
  const bump = (key, name) => {
    if (!key) return;
    const m = gameName.get(key) || new Map();
    m.set(name, (m.get(name) || 0) + 1);
    gameName.set(key, m);
  };
  for (const r of prepared.rows) {
    if (r.id.gameKey) bump(r.id.gameKey, r.id.game);
    if (r.l.status !== "active" || !r.id.gameKey) continue;
    if (!liveBy.has(r.id.gameKey)) liveBy.set(r.id.gameKey, new Map());
    const m = liveBy.get(r.id.gameKey);
    if (!m.has(r.market)) m.set(r.market, []);
    m.get(r.market).push(r);
  }
  for (const s of sales) if (s.gameKey && s.game) bump(s.gameKey, s.game);
  for (const r of research) bump(gk(r.game), r.game);
  for (const t of tasks) bump(gk(t.game), t.game);

  // Sell speed per game on single-unit markets: listing created -> first sale.
  const speedBy = new Map();
  for (const r of prepared.rows) {
    if (!VENUES[r.market] || VENUES[r.market].saleModel !== "single-unit") continue;
    const mine = (prepared.salesByListing.get(r.listingId) || []).filter((s) => s.priced);
    if (!mine.length || !r.l.createdAt) continue;
    const first = Math.min(...mine.map((s) => s.at.getTime()));
    const days = Math.max(0, (first - new Date(r.l.createdAt).getTime()) / DAY);
    if (!speedBy.has(r.id.gameKey)) speedBy.set(r.id.gameKey, []);
    speedBy.get(r.id.gameKey).push(days + 0.001);
  }

  const keys = new Set([
    ...ordersBy.keys(),
    ...liveBy.keys(),
    ...union.keys(),
    ...stance.keys(),
    ...researchByKey.keys(),
    ...engineAll.keys(),
  ]);

  const rows = [];
  for (const key of keys) {
    if (!key) continue;
    const names = gameName.get(key);
    const game = names ? [...names.entries()].sort((a, b) => b[1] - a[1])[0][0] : key;
    const rs = researchByKey.get(key) || null;
    const orders = ordersBy.get(key) || new Map();
    const live = liveBy.get(key) || new Map();
    const u = windowCounts(union.get(key) || new Map(), now);
    const eAll = engineAll.get(key) || { count: 0, revenue: 0, avgPrice: 0, perWeek: 0 };
    const eClean = engineClean.get(key) || { count: 0, revenue: 0, avgPrice: 0, perWeek: 0 };
    const st = stance.get(key) || null;

    // Per market.
    const marketsOut = {};
    let allOrders = [];
    for (const m of MARKETS) {
      const os = orders.get(m) || [];
      allOrders = allOrders.concat(os);
      const rowsLive = live.get(m) || [];
      const asks = rowsLive.map((r) => Number(r.l.price)).filter((p) => p > 0);
      const prices = os.map((s) => s.priceUsd);
      const realised = band(prices);
      const last = os.length ? new Date(Math.max(...os.map((s) => s.at.getTime()))) : null;
      const rival = rivalOf(rs, m);
      const suggestion =
        A.isBlocked(m)
          ? { price: 0, basis: "blocked", confidence: "none", reasons: ["Market blocked by the owner."], position: "no rivals", test: null }
          : gamePrice(ctx, { gameKey: key, market: m, orders: os, ordersByMarket: orders, research: rs, liveAsks: asks });
      const askMedian = median(asks);
      marketsOut[m] = {
        market: m,
        blocked: A.isBlocked(m),
        sold: { orders: os.length, median: realised.median, p25: realised.p25, p75: realised.p75, last: last ? last.toISOString() : null },
        live: {
          listings: rowsLive.length,
          units: rowsLive.reduce((a, r) => a + listedUnits(r.l), 0),
          askMin: asks.length ? Math.min(...asks) : 0,
          askMedian,
          askMax: asks.length ? Math.max(...asks) : 0,
          // The auto-farm only prices origin "auto" rows; manual and no-claim rows
          // are the owner's own prices and are shown, never second-guessed.
          autoRows: rowsLive.filter((r) => r.l.origin === "auto").length,
          autoAskMedian: median(rowsLive.filter((r) => r.l.origin === "auto").map((r) => Number(r.l.price)).filter((p) => p > 0)),
        },
        askVsSoldPct: realised.median > 0 && askMedian > 0 ? Math.round(((askMedian - realised.median) / realised.median) * 100) : null,
        rival,
        suggested: suggestion,
        net: suggestion.price > 0 ? netOf(suggestion.price, m, fees) : 0,
      };
    }

    const allPrices = allOrders.map((s) => s.priceUsd);
    const allBand = band(allPrices);
    const meanNet = allOrders.length ? allOrders.reduce((a, s) => a + netOf(s.priceUsd, s.market, fees), 0) / allOrders.length : 0;
    // The value of one account of this game: what we keep per sale, from our own
    // order-level prices; the engine's price tilt as a fallback when none exist.
    const valuePerAccount = meanNet || (eClean.avgPrice ? eClean.avgPrice : 0);

    // Stock.
    const listed = [...live.values()].flat().reduce((a, r) => a + listedUnits(r.l), 0);
    const liveListings = [...live.values()].flat().length;
    const activeTasks = st ? st.active : [];
    const assignedActive = activeTasks.length ? Math.max(...activeTasks.map((t) => t.assignedN)) : 0;
    // The engine's count of unsold accounts holding this game's drops is only trusted
    // while its decision is fresh (a week).
    const latestAt = st && st.latest ? ts(st.latest.decidedAt) : null;
    const holders = latestAt && now - latestAt <= 7 * DAY ? st.latest.archiveHolders : 0;
    // Can this game be farmed right now? A campaign must be live (research can lag a
    // day or two, so its end date is checked) or upcoming, or the engine already has
    // accounts on one.
    const camp = rs && rs.campaign ? { active: !!rs.campaign.active, upcoming: !!rs.campaign.upcoming, endAt: rs.campaign.endAt || null } : null;
    const campLive = !!camp && ((camp.active && (!camp.endAt || ts(camp.endAt) > now)) || camp.upcoming);
    const farmable = campLive || activeTasks.length > 0;
    const managedBy = isManaged(key, rs) ? "no-claim allocator" : reuseKeys.has(key) ? "reuse-only rule" : "";

    // Demand: the clean union over the engine's own window.
    const perWeek = farmSizing.salesPerWeek(u.units, ENGINE_WINDOW_DAYS);
    const farm = farmAdvice({
      perWeek,
      listed,
      archiveHolders: holders,
      assignedActive,
      sizing: sz,
      valuePerAccount,
      engineEntry: st && st.latest ? st : null,
      engineCleanPerWeek: eClean.perWeek,
      gameCap: capFor(key),
      managed: !!managedBy,
      managedBy,
      shelfCap: shelfCapFor(key),
      farmable,
      campaign: camp,
      now,
    });

    // Market-wide demand and competition (research).
    const market = rs
      ? {
          perWeek: rs.salesPerWeek == null ? null : Number(rs.salesPerWeek),
          demandScore: Number(rs.demandScore) || 0,
          competitionScore: Number(rs.competitionScore) || 0,
          opportunityScore: Number(rs.opportunityScore) || 0,
          sellers: Number(rs.sellers) || 0,
          offers: Number(rs.offers) || 0,
          trend: rs.demandTrend == null ? null : Number(rs.demandTrend),
          recommendation: rs.recommendation || "",
          scannedAt: rs.scannedAt || null,
          campaign: rs.campaign ? { active: !!rs.campaign.active, upcoming: !!rs.campaign.upcoming, endAt: rs.campaign.endAt || null } : null,
          noClaim: !!rs.noClaim,
          staleDays: rs.scannedAt ? Math.round((now - ts(rs.scannedAt)) / DAY) : null,
        }
      : null;
    // Our share of what the market moves where it can be measured.
    const ourWeek30 = farmSizing.salesPerWeek(u.d30, 30);
    const share = market && market.perWeek > 0 ? round2(Math.min(1, ourWeek30 / market.perWeek)) : null;

    // Flags: things worth a human's eye, each with its numbers.
    const flags = [];
    const diff = eAll.count - eClean.count;
    if (diff >= 3 && diff >= eAll.count * 0.3) flags.push({ id: "inflated-demand", level: "warn", text: "The farm engine counts " + eAll.count + " sales in 45 days; " + diff + " of them are mass-delist or bulk mark-sold signals. Clean evidence: " + eClean.count + "." });
    if (u.units >= eAll.count + 3 && u.units >= eAll.count * 1.3) flags.push({ id: "understated-demand", level: "info", text: "Clean evidence shows " + u.units + " sold accounts in 45 days; the engine sees " + eAll.count + " (delivered Eldorado/G2G/PlayerAuctions units write no signal)." });
    if (farm.perWeek >= 2 && farm.daysCover != null && farm.daysCover < 7) flags.push({ id: "stockout-risk", level: "warn", text: "Stock on hand covers only " + farm.daysCover + " days at this sell rate." + (farm.managed && farm.shelfCap ? " The shelf cap is " + farm.shelfCap + " (listed " + farm.listed + ")." : "") });
    if ((farm.direction === "less" || farm.direction === "hold") && farm.daysCover != null && farm.daysCover > 56) flags.push({ id: "overstocked", level: "info", text: "Listed stock is " + farm.daysCover + " days of sales: more than enough." });
    if (market && market.staleDays != null && market.staleDays > 14) flags.push({ id: "stale-research", level: "info", text: "Other sellers' prices were last scanned " + market.staleDays + " days ago." });
    if (!rs) flags.push({ id: "no-research", level: "info", text: "No market research scan for this game, so other sellers' prices are unknown." });
    if (market && market.perWeek >= 20 && share != null && share < 0.1 && u.d30 > 0) flags.push({ id: "low-share", level: "opportunity", text: "The market moves about " + Math.round(market.perWeek) + " a week on GGSel + Plati; we sell about " + round2(ourWeek30) + "." });

    const own = u.units > 0 || allOrders.length > 0 || liveListings > 0 || (st && st.active.length > 0);
    rows.push({
      key,
      game,
      own,
      demand: {
        units45: u.units,
        perWeek: round2(perWeek),
        d7: u.d7,
        d14: u.d14,
        d30: u.d30,
        bySource: u.bySource,
        byMarket: u.byMarket,
        engine: { count45: eAll.count, perWeek: eAll.perWeek, avgPrice: eAll.avgPrice },
        engineClean: { count45: eClean.count, perWeek: eClean.perWeek },
        market,
        share,
      },
      price: {
        realised: allBand,
        net: round2(meanNet),
        valuePerAccount: round2(valuePerAccount),
        sellSpeedDays: speedBy.has(key) && speedBy.get(key).length >= 3 ? round2(quantile(speedBy.get(key), 0.5)) : null,
        markets: marketsOut,
      },
      stock: { listedUnits: listed, liveListings, inFlight: farm.inFlight, onHand: farm.onHand },
      farm,
      flags,
    });
  }

  // Money first: what a game earns us a week, then what the market would pay.
  rows.sort(
    (a, b) =>
      b.farm.weeklyRevenueUsd - a.farm.weeklyRevenueUsd ||
      b.demand.units45 - a.demand.units45 ||
      ((b.demand.market && b.demand.market.opportunityScore) || 0) - ((a.demand.market && a.demand.market.opportunityScore) || 0),
  );
  return rows;
}

// The last few decisions per game, for the detail sheet. Short strings and
// counts only.
function taskHistory(tasks, perGame = 8) {
  const out = new Map();
  const sorted = [...(tasks || [])].sort((a, b) => (ts(b.createdAt) || 0) - (ts(a.createdAt) || 0));
  for (const t of sorted) {
    const key = gk(t.game);
    if (!key) continue;
    if (!out.has(key)) out.set(key, []);
    const arr = out.get(key);
    if (arr.length >= perGame) continue;
    arr.push({
      decision: t.decision || "",
      reason: String(t.reason || "").slice(0, 220),
      campaign: String(t.campaignName || "").slice(0, 100),
      decidedAt: t.decidedAt || t.createdAt || null,
      endsAt: t.campaignEndAt || null,
      target: Number(t.targetAccounts) || 0,
      planned: Number(t.plannedAccounts) || 0,
      assigned: Number.isFinite(Number(t.assignedN)) ? Number(t.assignedN) : 0,
      archiveHolders: t.coverage ? Number(t.coverage.archiveHolders) || 0 : 0,
      engineSales45: Number(t.internalSales) || 0,
    });
  }
  return out;
}

/** Lighter shape for the list endpoint: no per-market detail. */
function lightRow(g) {
  const pm = g.price.markets;
  return {
    key: g.key,
    game: g.game,
    own: g.own,
    units45: g.demand.units45,
    perWeek: g.demand.perWeek,
    d7: g.demand.d7,
    d30: g.demand.d30,
    engineCount45: g.demand.engine.count45,
    engineCleanCount45: g.demand.engineClean.count45,
    marketPerWeek: g.demand.market ? g.demand.market.perWeek : null,
    opportunity: g.demand.market ? g.demand.market.opportunityScore : null,
    competition: g.demand.market ? g.demand.market.competitionScore : null,
    sellers: g.demand.market ? g.demand.market.sellers : null,
    share: g.demand.share,
    medianPrice: g.price.realised.median,
    valuePerAccount: g.price.valuePerAccount,
    weeklyRevenueUsd: g.farm.weeklyRevenueUsd,
    listedUnits: g.stock.listedUnits,
    onHand: g.stock.onHand,
    inFlight: g.stock.inFlight,
    farmable: g.farm.farmable,
    managedBy: g.farm.managedBy,
    daysCover: g.farm.daysCover,
    target: g.farm.target,
    need: g.farm.need,
    spare: g.farm.spare,
    direction: g.farm.direction,
    engineDecision: g.farm.engine ? g.farm.engine.decision : null,
    engineCounts14d: g.farm.engine ? g.farm.engine.counts14d : null,
    flags: g.flags.map((f) => ({ id: f.id, level: f.level })),
    prices: Object.fromEntries(
      Object.entries(pm)
        .filter(([, v]) => v.suggested.price > 0 || v.sold.orders > 0 || v.live.listings > 0)
        .map(([m, v]) => [m, {
          suggested: v.suggested.price,
          confidence: v.suggested.confidence,
          sold: v.sold.orders,
          soldMedian: v.sold.median,
          ask: v.live.askMedian,
          askAuto: v.live.autoAskMedian,
          autoRows: v.live.autoRows,
          listings: v.live.listings,
          blocked: v.blocked,
          position: v.suggested.position,
          rivalMedian: v.rival ? v.rival.median : 0,
        }]),
    ),
  };
}

module.exports = {
  ENGINE_WINDOW_DAYS,
  DEFAULT_SIZING,
  engineCounts,
  soldUnion,
  windowCounts,
  listedUnits,
  rivalOf,
  gamePrice,
  farmAdvice,
  engineStance,
  taskHistory,
  gameBoard,
  lightRow,
};
