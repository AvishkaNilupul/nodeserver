// Does the account we are about to hand over actually hold what the offer
// advertised?
//
// A no-claim-farm-backed listing (`MarketplaceListing.unclaimedGame`) picks its
// stock at delivery time by GAME — the fulfillers ask the ledger for "an
// Overwatch account" and ship the first sellable one. Nothing ever compared
// that account's drops against the item list the buyer paid for.
//
// That cost a real order: Eldorado 99d443eb (2026-09-07) advertised the CAH 2026
// bundle as 10 items across two waves — including TWO Esports Loot Boxes — and
// was filled with an account holding 7 of them and ONE loot box. The buyer
// noticed before we did. All six accounts that offer delivered were the same
// 7-item shape, because only 28 of 247 Overwatch ledger rows ever farmed the
// second wave: the stock could never honour the listing, and nothing said so.
//
// So a listing may declare `requiredDrops` — the item list it advertises, with
// counts — and this module is the gate: an account is only deliverable when it
// holds every one of them, unclaimed. Counts matter as much as names ("Esports
// Loot Box" twice is a different product from once), which is exactly the part
// a set-membership check would have missed.
//
// The gate is opt-in per listing: a row with no `requiredDrops` behaves as it
// always did. That is deliberate — it can be turned on listing by listing as
// each one's advertised item list is confirmed, rather than silently changing
// what every live offer does.
const DropLog = require("../models/DropLog");

// Item names arrive from three places that disagree about spacing and case: the
// no-claim scan (ledger `drops[].name`), a DropSet's `items[].name`, and the
// operator typing the advertised list. Compare them all the same way.
function normName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

// Accepts what a listing or a caller might hold: ["Name"], [{name, qty}],
// [{name, count}] or a DropSet's items ([{name, qty}]). Returns a Map of
// normalised name -> how many copies the buyer was promised.
function requiredCounts(requiredDrops) {
  const out = new Map();
  for (const raw of requiredDrops || []) {
    const name = typeof raw === "string" ? raw : raw && raw.name;
    const key = normName(name);
    if (!key) continue;
    const qty =
      typeof raw === "string"
        ? 1
        : Math.max(1, parseInt((raw && (raw.qty ?? raw.count)) ?? 1, 10) || 1);
    // The same name listed twice as separate entries (one per wave, which is how
    // a two-week event reads) means two copies, so accumulate rather than assign.
    out.set(key, (out.get(key) || 0) + qty);
  }
  return out;
}

// What a ledger row is recorded as holding. The no-claim scan writes one entry
// per drop, so a repeated item appears twice — counting entries is what makes
// "two loot boxes" checkable.
function heldCounts(row) {
  const out = new Map();
  for (const d of (row && row.drops) || []) {
    const key = normName(d && d.name);
    if (!key) continue;
    out.set(key, (out.get(key) || 0) + 1);
  }
  return out;
}

// Everything the advertised list asks for that this row cannot supply, with the
// numbers, so a short delivery can say WHY instead of just refusing.
function missingItems(row, required) {
  const req = required instanceof Map ? required : requiredCounts(required);
  const held = heldCounts(row);
  const out = [];
  for (const [name, need] of req) {
    const have = held.get(name) || 0;
    if (have < need) out.push({ name, need, have });
  }
  return out;
}

function coversRequired(row, required) {
  return missingItems(row, required).length === 0;
}

// The listing's own advertised item list, normalised. Empty means "this row
// never declared one" — the caller then keeps its pre-gate behaviour.
function listingRequirements(listing) {
  return requiredCounts((listing && listing.requiredDrops) || []);
}

// The ledger row's `drops[]` is NOT the account's inventory — it is whatever the
// last no-claim scan wrote, which in practice is the current event's wave. Every
// one of the 15 sellable Overwatch rows (2026-09-07) listed 3-6 drops while
// DropLog held 7-39 for the same login. Gating on the ledger alone would
// therefore refuse almost every good account, so what an account HOLDS is the
// union of the two, taking the larger count per name rather than the sum — the
// same drop is usually recorded in both, and adding them would invent copies.
//
// Two DropLog rows with one name really are two copies: the collection is unique
// on (account, benefitId), so a repeated name means a second grant — which is
// exactly how "two Esports Loot Boxes" becomes checkable.
async function dropLogFor(login) {
  if (!login) return [];
  return DropLog.find({ login: String(login) }, { name: 1, claimed: 1 }).lean();
}

function countLogNames(logs) {
  const out = new Map();
  for (const l of logs || []) {
    const key = normName(l && l.name);
    if (!key) continue;
    out.set(key, (out.get(key) || 0) + 1);
  }
  return out;
}

function mergeMax(a, b) {
  const out = new Map(a);
  for (const [k, v] of b) out.set(k, Math.max(out.get(k) || 0, v));
  return out;
}

function shortOf(held, req) {
  const out = [];
  for (const [name, need] of req) {
    const have = held.get(name) || 0;
    if (have < need) out.push({ name, need, have });
  }
  return out;
}

// The real per-account verdict the fulfillers use: does this account hold every
// advertised item, and is any of them already claimed?
//
// The DropLog read is skipped entirely when the ledger alone already covers the
// requirement AND we are not asked to prove they are unclaimed — but the claimed
// check is the whole promise ("drops sitting unclaimed"), so in practice this
// costs one indexed query per candidate. Candidates are few: the walk stops as
// soon as it has enough.
async function accountCoverage(row, required) {
  const req = required instanceof Map ? required : requiredCounts(required);
  if (!req.size) return { ok: true, missing: [], claimed: [] };
  const ledger = heldCounts(row);
  let logs = [];
  try {
    logs = await dropLogFor(row && row.login);
  } catch {
    // A DropLog outage must not silently downgrade the gate to ledger-only and
    // start rejecting good accounts — but it must not wave through a claimed
    // one either. Fall back to the ledger and say so.
    const missing = shortOf(ledger, req);
    return { ok: missing.length === 0, missing, claimed: [], degraded: true };
  }
  const held = mergeMax(ledger, countLogNames(logs));
  const missing = shortOf(held, req);
  // A claimed drop has already been connected to whoever the farm account was
  // linked to; handing it over sells nothing. The no-claim farm exists so this
  // cannot happen, but DropLog is the per-item record, so ask rather than trust.
  const claimed = [
    ...new Set(
      (logs || [])
        .filter((l) => l.claimed && req.has(normName(l.name)))
        .map((l) => normName(l.name)),
    ),
  ];
  return { ok: missing.length === 0 && claimed.length === 0, missing, claimed };
}

// --- the only source that is never stale -----------------------------------
// Both DB sources are snapshots and BOTH proved wrong on the CAH bundle: the
// ledger listed 3-7 drops per account, DropLog held items the ledger did not,
// and a live read of all 15 sellable Overwatch accounts (2026-09-08) showed the
// truth neither had — Week 1's items were GONE from every one of them. The wave
// had expired, so its drops stopped being claimable and dropped out of the
// inventory. That is what the buyer on order 99d443eb actually hit: he was sold
// a two-loot-box bundle whose first loot box no longer existed.
//
// An expired wave is not an edge case, it is the normal life cycle of every
// event we farm, so the gate reads Twitch itself: `inProgress` entries at 100%
// and not yet claimed — which is exactly "farmed, still claimable, still ours to
// sell". One GQL call per account, at delivery time, is cheap next to a dispute.
async function liveHeld(ledgerRow) {
  const ual = require("./unclaimedAutoList");
  const cand = await ual.candForLedger(ledgerRow);
  if (!cand || !cand.clientSecret) return null;
  const inv = await ual.inventoryForCandidate(cand);
  return inv && Array.isArray(inv.sellable) ? inv.sellable : null;
}

// The verdict the fulfillers use at hand-over. Live inventory decides; the DB
// union is only the fallback for a Pi/Twitch read that failed, and a fallback
// verdict is marked `degraded` so the caller can say the check was not definitive.
async function liveCoverage(ledgerRow, required) {
  const req = required instanceof Map ? required : requiredCounts(required);
  if (!req.size) return { ok: true, missing: [], claimed: [], source: "none" };
  let sellable = null;
  try {
    sellable = await liveHeld(ledgerRow);
  } catch {
    sellable = null;
  }
  if (sellable) {
    // `sellable` is ALREADY filtered to unclaimed-and-complete, so anything it
    // does not contain is either unfarmed, already claimed, or expired — all
    // three mean the same thing to the buyer: not deliverable.
    const missing = shortOf(countLogNames(sellable), req);
    return { ok: missing.length === 0, missing, claimed: [], source: "live" };
  }
  const fallback = await accountCoverage(ledgerRow, req);
  return { ...fallback, source: "db", degraded: true };
}

// Kept for callers that only want the claimed half.
async function heldUnclaimed(login, required) {
  const req = required instanceof Map ? required : requiredCounts(required);
  if (!req.size || !login) return true;
  const rows = await dropLogFor(login);
  return !rows.some((r) => r.claimed && req.has(normName(r.name)));
}

// A cheap, in-memory FIRST pass on the ledger alone. It is an ordering hint, not
// a verdict: a row it puts in `short` may still cover once DropLog is consulted
// (accountCoverage does that), so callers try `covering` first and fall back to
// `short` rather than discarding it.
function partitionByCoverage(rows, required) {
  const req = required instanceof Map ? required : requiredCounts(required);
  if (!req.size) return { covering: rows || [], short: [] };
  const covering = [];
  const short = [];
  for (const row of rows || []) {
    (coversRequired(row, req) ? covering : short).push(row);
  }
  return { covering, short };
}

// "Why nothing was deliverable", built from the verdicts of the accounts we
// actually rejected: the advertised items the stock is short of, worst first.
function summarizeMissing(missingLists) {
  const tally = new Map();
  for (const list of missingLists || []) {
    for (const m of list || []) tally.set(m.name, (tally.get(m.name) || 0) + 1);
  }
  if (!tally.size) return "";
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, n]) => name + " (missing on " + n + ")")
    .join(", ");
}

// The same thing from raw ledger rows, for the audit script and the tests.
function shortfallSummary(rows, required) {
  const req = required instanceof Map ? required : requiredCounts(required);
  if (!req.size) return "";
  return summarizeMissing((rows || []).map((row) => missingItems(row, req)));
}

module.exports = {
  normName,
  accountCoverage,
  liveCoverage,
  liveHeld,
  dropLogFor,
  countLogNames,
  mergeMax,
  shortOf,
  summarizeMissing,
  requiredCounts,
  heldCounts,
  missingItems,
  coversRequired,
  listingRequirements,
  heldUnclaimed,
  partitionByCoverage,
  shortfallSummary,
};
