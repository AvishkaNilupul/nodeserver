// How many accounts a game deserves — the one piece of arithmetic both farming
// systems size themselves with.
//
// WHY THIS EXISTS
//
// The auto-farmer sized a game with `capForGame`: `min(maxPerGame + 2*sales,
// maxPerGame*2)`. That is a FLAT CEILING. With maxPerGame at 30 the best seller
// on the fleet and a game that sold twice both top out at 60 accounts, so once a
// game crosses ~15 sales in the window its own success stops buying it anything.
// Measured on prod 2026-09-08: Overwatch sold 202 units in 30 days, Rocket
// League 83, Brawlhalla 69 — all of which the old formula treats identically to
// a game that sold 15.
//
// The no-claim / unclaimed farm had no sizing at all: the operator typed a
// number into a form. Nothing read a sale, a stock level or a demand score.
//
// Both systems want the same question answered — "this game sells N a week and
// we hold S sellable accounts; how many should we be farming?" — so it is
// answered once, here, as pure functions with no database and no settings
// lookups. The callers supply the measurements; this file supplies the policy.
//
// THE MODEL
//
// Stock cover. A sold account is CONSUMED — the buyer keeps it — so a game that
// sells N a week burns N accounts a week. To have stock on the shelf for D days
// you need `N * D/7` accounts, plus a safety buffer for the lumpiness of drop
// events (a Twitch drop campaign lands all at once and sells out in days: on
// prod Rainbow Six moved 30 units at a 45-hour median time-to-sale, then sat at
// zero stock for three days).
//
// The result is a TARGET, never a claim. Every caller still has to pass its own
// pool reserve, container capacity and per-game overrides — this file only says
// what would be justified if supply were free.

// Days of history the sales measurement covers by default. Matches
// autoFarmer.SALES_WINDOW_MS so a count from `internalSalesForGame` can be
// handed straight to `salesPerWeek` without rescaling.
const DEFAULT_SALES_WINDOW_DAYS = 45;

// How much stock to keep on the shelf, in days of demand. 28 = four weeks
// (operator's choice 2026-09-08). Drop inventory is time-sensitive — unclaimed
// drops expire and campaigns end — so a long cover buys availability at the risk
// of holding stock that goes stale. Overridable globally and per game.
const DEFAULT_COVERAGE_DAYS = 28;

// Flat buffer added on top of the computed cover, so a game that sells rarely
// but reliably still keeps a few units on the shelf instead of rounding to zero.
const DEFAULT_SAFETY_STOCK = 6;

// The absolute most this arithmetic will ever ask for, whatever the sales say.
// Not a business limit — a blast radius. A corrupted sales count (or a game
// whose label collides with another's) can produce an enormous number, and the
// consequence would be draining the pool into one game. Callers clamp again
// with their own real limits.
const HARD_MAX_ACCOUNTS = 600;

const num = (v, dflt = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

// Sales per week from a raw count over a window. Guards the window so a caller
// passing 0 days cannot produce Infinity and blow past every cap downstream.
function salesPerWeek(count, windowDays = DEFAULT_SALES_WINDOW_DAYS) {
  const n = Math.max(0, num(count));
  const days = Math.max(1, num(windowDays, DEFAULT_SALES_WINDOW_DAYS));
  return (n * 7) / days;
}

// How many accounts `perWeek` sales justify holding.
//
//   target = ceil(perWeek * coverageDays / 7) + safetyStock
//
// A game with no sales at all gets NOTHING from this function — not even the
// safety stock. Safety stock exists to stop a proven seller rounding down to a
// useless number, not to hand accounts to games that have never sold one. The
// caller decides what an unproven game gets (the auto-farmer probes it; the
// no-claim allocator leaves it at its floor).
function coverageTarget({
  salesPerWeek: perWeek = 0,
  coverageDays = DEFAULT_COVERAGE_DAYS,
  safetyStock = DEFAULT_SAFETY_STOCK,
  min = 0,
  max = HARD_MAX_ACCOUNTS,
} = {}) {
  const rate = Math.max(0, num(perWeek));
  const days = Math.max(0, num(coverageDays, DEFAULT_COVERAGE_DAYS));
  const safety = Math.max(0, num(safetyStock, DEFAULT_SAFETY_STOCK));
  const lo = Math.max(0, num(min));
  const hi = Math.min(Math.max(lo, num(max, HARD_MAX_ACCOUNTS)), HARD_MAX_ACCOUNTS);
  if (rate <= 0) return clamp(0, lo, hi);
  const cover = Math.ceil((rate * days) / 7);
  return clamp(cover + safety, lo, hi);
}

// The gap between what a game should hold and what it holds now, split into the
// two numbers a caller acts on:
//
//   need   — how many more sellable accounts the target asks for
//   spare  — how many it is over target by (never farm more; may be reclaimed)
//
// `inFlight` is stock already on the way — accounts claimed for this game that
// have not become sellable yet. Counting it prevents the classic restock
// oscillation where every cycle orders the whole gap again because the previous
// cycle's accounts have not finished farming.
function stockGap({ target = 0, onHand = 0, inFlight = 0 } = {}) {
  const t = Math.max(0, num(target));
  const have = Math.max(0, num(onHand)) + Math.max(0, num(inFlight));
  const diff = t - have;
  return {
    target: t,
    onHand: Math.max(0, num(onHand)),
    inFlight: Math.max(0, num(inFlight)),
    need: diff > 0 ? Math.round(diff) : 0,
    spare: diff < 0 ? Math.round(-diff) : 0,
  };
}

// Days of stock left at the current sell rate. Infinity when a game holds stock
// but sells nothing (it is not running out — it is not moving), 0 when it holds
// nothing. This is the number that tells an operator "Rainbow Six empties in 1.4
// days" without them having to divide anything themselves.
function daysOfCover({ onHand = 0, salesPerWeek: perWeek = 0 } = {}) {
  const have = Math.max(0, num(onHand));
  const rate = Math.max(0, num(perWeek));
  if (have <= 0) return 0;
  if (rate <= 0) return Infinity;
  return (have * 7) / rate;
}

// Share a scarce budget between games that all want more, weighted by how much
// money each one's shortfall represents rather than by how many accounts it
// asked for. A game selling at $4 that needs 20 outranks one selling at $0.75
// that needs 40, which raw account counts get backwards.
//
// Returns a Map of key -> granted, never granting more than `need`, and never
// granting more than `budget` in total. Deliberately mirrors autoFarmer's
// `fairShare` contract (same shape in, same shape out) so a caller can swap
// between them; the difference is only the weighting.
function weightedSplit(requests, budget) {
  const out = new Map((requests || []).map((r) => [r.key, 0]));
  let remaining = Math.max(0, Math.floor(num(budget)));
  let pending = (requests || []).filter((r) => Math.max(0, num(r.need)) > 0);
  while (remaining > 0 && pending.length) {
    const totalW = pending.reduce((s, r) => s + Math.max(0.01, num(r.weight, 1)), 0);
    let gaveAny = false;
    for (const r of pending) {
      const share = Math.max(
        1,
        Math.floor((remaining * Math.max(0.01, num(r.weight, 1))) / totalW),
      );
      const give = Math.min(share, Math.max(0, num(r.need)) - out.get(r.key), remaining);
      if (give > 0) {
        out.set(r.key, out.get(r.key) + give);
        remaining -= give;
        gaveAny = true;
      }
    }
    pending = pending.filter((r) => out.get(r.key) < Math.max(0, num(r.need)));
    // No one could take a whole account this round — the budget is smaller than
    // the number of claimants. Stop rather than spin.
    if (!gaveAny) break;
  }
  return out;
}

// The money a shortfall represents per week — the natural weight for the split
// above. Falls back to 1 (not 0) for a game with no recorded price, so a game
// whose sales are proven but whose prices were never captured still competes
// instead of being silently starved. Price capture is incomplete by design in
// several paths (a connection flip proves a sale but names no price).
function revenueWeight({ salesPerWeek: perWeek = 0, avgPrice = 0 } = {}) {
  const rate = Math.max(0, num(perWeek));
  const price = Math.max(0, num(avgPrice));
  if (rate <= 0) return 0.01;
  return Math.max(0.01, rate * (price > 0 ? price : 1));
}

module.exports = {
  DEFAULT_SALES_WINDOW_DAYS,
  DEFAULT_COVERAGE_DAYS,
  DEFAULT_SAFETY_STOCK,
  HARD_MAX_ACCOUNTS,
  salesPerWeek,
  coverageTarget,
  stockGap,
  daysOfCover,
  weightedSplit,
  revenueWeight,
};
