// ---------------------------------------------------------------------------
// NO-CLAIM HOLDINGS — what each no-claim farm account could hand a buyer RIGHT
// NOW (docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md §2).
//
// One NoclaimHolding row per account in a no-claim bot config: its sellable
// drops (in-progress at 100%, not claimed) folded per item, from the last
// SUCCESSFUL live Twitch read. A background sweep keeps the snapshot warm a few
// reads at a time; the Listings page's "No-claim farm" picker and the claim
// layer (utils/noclaimStock.js) read it through snapshotBase().
//
// The snapshot is a shortlist, never a licence to sell: it can say an account
// is NOT free (on a listing, sold, manual-sold, ...), but every claim re-reads
// the live inventory and commits the ledger with a compare-and-set first.
// Credentials never land in a holding row or in the cached base — the pool join
// keeps only `hasPassword`.
// ---------------------------------------------------------------------------
const NoclaimHolding = require("../models/NoclaimHolding");
const AvailableAccount = require("../models/AvailableAccount");
const UnclaimedAccount = require("../models/UnclaimedAccount");
const listedLogins = require("./listedLogins");
const settings = require("./settings");

// The auto-list engine reaches back into this file (through the no-claim
// stock/listing layers), so it is required lazily, inside functions only.
function ual() {
  return require("./unclaimedAutoList");
}
// Lazy too: only the expiry rules read campaigns, and only when a holding
// names one.
function campaignModel() {
  return require("../models/TwitchCampaign");
}

// Contract §1e defaults. Used only when settings.getNoclaimShopSettings is
// missing (the accessor ships in the same change): a settings.js without it
// must degrade to the documented defaults, never take the sweep down.
const NOCLAIM_FALLBACK = {
  enabled: true,
  autoDeliver: true,
  sweep: true,
  sweepPerTick: 30,
  sweepEveryMin: 10,
  maxAgeHours: 8,
  refreshBudget: 120,
  topUp: true,
  healthPerPass: 20,
  passEveryMin: 10,
};

function shopSettings() {
  let cur = null;
  try {
    if (typeof settings.getNoclaimShopSettings === "function") {
      cur = settings.getNoclaimShopSettings();
    }
  } catch (e) {
    console.error("noclaimHoldings: no-claim shop settings unreadable:", e.message);
  }
  return { ...NOCLAIM_FALLBACK, ...(cur && typeof cur === "object" ? cur : {}) };
}

function posNum(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

function maxAgeMsOf(cfg) {
  return posNum(cfg && cfg.maxAgeHours, NOCLAIM_FALLBACK.maxAgeHours) * 3600 * 1000;
}

// ---------------------------------------------------------------------------
// EXPIRY (docs/NOCLAIM-OFFER-ROTATION-CONTRACT.md, "Expiry").
//
// An earned, unclaimed drop leaves the inventory a fixed time after its
// CAMPAIGN ends, on every account at once. Measured on five Rainbow Six waves
// in a row (expiries of 2026-09-30, 10-03, 10-05, 10-07 and 10-10): the copies
// were gone within minutes of endAt + 7 days.
//
// The snapshot used to learn that one account at a time, hours later: a row is
// trusted for maxAgeHours and not re-read for half of that. On 2026-10-10 the
// Eldorado offer "OL' CLANKER + 14× Esports Pack" stayed on sale for 3 h 55 min
// after the oldest wave's packs had gone; a buyer paid, no account held the
// bundle, and the order was disputed.
//
// So each holding keeps its copies per campaign (`items[].waves`), and stock is
// counted on the copies that will still be there at a given moment:
//   - now          — a claim's shortlist, and every market's count
//   - now + lead   — what an offer may ADVERTISE, so it comes off sale a day
//                    before a wave goes instead of hours after, and a buyer
//                    always has that long to claim everything they were sold
// Read fresh on every snapshot build (autoFarm, so one settings edit retunes
// it without a restart):
//   noclaimExpiryAware      false = off: every copy counts until a read shows
//                           it gone (the behaviour before 2026-10-10)
//   noclaimClaimWindowHours how long a drop outlives its campaign (168)
//   noclaimSellLeadHours    how long before that an offer stops promising it (24)
// ---------------------------------------------------------------------------
const HOUR_MS = 60 * 60 * 1000;
const EXPIRY_DEFAULTS = {
  claimWindowHours: 168,
  sellLeadHours: 24,
  // A bundle is BUILT (rotation, grow) only from copies that stay advertisable
  // this much longer, so a rewrite is not undone by the next stock sync.
  bundleMarginHours: 12,
};
// Offers of the claim-at-sale markets that have no rotation behind them keep
// selling to the last hour; they only need to be off sale before the copies go.
const TECH_LEAD_MS = HOUR_MS;
// A copy read alive this long after its campaign should have taken it was not
// that campaign's (a re-used name) or follows a rule this file does not know:
// its expiry is unknown and it counts until a read shows it gone. Inside the
// grace, a late sighting is Twitch clearing up slowly and is not believed.
const REFUTE_GRACE_MS = 6 * HOUR_MS;
// Copies lost that no campaign end explains, on this many different free
// accounts within the window, are an expiry nobody predicted: every holder of
// the item is re-read before it counts as stock again.
const LOSS_CONFIRM = 3;
const LOSS_WINDOW_MS = 30 * 60 * 1000;
// Re-reading flagged rows: passes of `refreshBudget` reads until none is left.
const DRAIN_MAX_PASSES = 12;
// Twitch answers an EMPTY inventory now and then for an account that holds
// plenty. One row emptied by that costs one row; a forced re-read of every
// holder of an item, answered that way, would take a whole game off sale for
// hours. So a forced re-read never empties a row: an empty answer for an
// account that held something is recorded as this "error" (the row keeps its
// items and stays flagged — no stock) and the regular sweep, minutes later,
// reads it again and is believed.
const FORCED_EMPTY = "empty inventory on a forced re-read";
const FORCED_EMPTY_RE = /^empty inventory on a forced re-read/;

const BASE_TTL_MS = 30 * 1000;
const FIRST_SWEEP_MS = 60 * 1000;
// The largest read budget the contract allows anywhere (refreshBudget 1..400).
// A caller asking for more still gets a bounded sweep — one Pi, one farm.
const MAX_BUDGET = 400;
const MAX_CONCURRENCY = 5;
// The archive's label for drops without a game; the page renders "" the same.
const OTHER_REWARDS = "Other rewards";
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

// Ledger statuses that leave an account free (contract §0 rule 3).
const FREE_STATUSES = ["skipped", "released", "expired"];
// Two ledgers for one login (a claim race mid-rollback, or a rename): the more
// committed one decides, so an account with ANY committed ledger is never free.
const LEDGER_RANK = { manual: 5, listed: 4, sold: 3, removed: 2 };
const SPENT_NOTE_RE = /^(sold|spent)/i;

let sweeping = false;
let lastSweep = null;
let baseCache = null; // { at: ms, promise }
let timer = null;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

function normGame(g) {
  return settings.normGameName(g);
}

// Grouping key for a game label. normGameName keeps only [a-z0-9], so a label
// in another script normalises to "" — fall back to the raw label so it does
// not merge into "Other rewards".
function gameKey(label) {
  const raw = String(label || "").trim();
  return normGame(raw) || raw.toLowerCase();
}

function copies(qty) {
  const q = Math.floor(Number(qty));
  return Number.isFinite(q) && q >= 1 ? q : 1;
}

function addWave(waves, campaign, qty) {
  if (!(qty > 0)) return;
  const name = String(campaign || "").trim();
  const cur = waves.find((w) => w.campaign === name);
  if (cur) cur.qty += qty;
  else waves.push({ campaign: name, qty });
}

// sellableDropsFromNoClaimInv output (one entry per copy) -> one entry per
// item with qty = copies, in first-seen order. An entry that already carries a
// qty counts as that many copies, so folding a folded list changes nothing.
//
// `waves` keeps the same copies split by the campaign each came from (it sums
// to qty): a raw inventory entry is one copy of its own campaign, and a folded
// entry brings its waves along. A folded entry WITHOUT waves (a row written
// before they were kept) is n copies of unknown origin — campaign "" — never n
// copies of its first campaign, which would expire all of them with it.
function foldSellable(sellable) {
  const byKey = new Map();
  for (const s of Array.isArray(sellable) ? sellable : []) {
    if (!s || typeof s !== "object") continue;
    const key =
      String(s.itemKey || "").trim().toLowerCase() ||
      String(s.name || "").trim().toLowerCase() +
        "|" +
        String(s.game || "").trim().toLowerCase();
    const n = copies(s.qty);
    let cur = byKey.get(key);
    if (!cur) {
      cur = {
        itemKey: key,
        name: String(s.name || ""),
        game: String(s.game || ""),
        campaign: String(s.campaign || ""),
        image: String(s.imageURL || s.image || ""),
        qty: 0,
        waves: [],
      };
      byKey.set(key, cur);
    } else {
      // First-seen wins; a later copy only fills a blank.
      if (!cur.name && s.name) cur.name = String(s.name);
      if (!cur.game && s.game) cur.game = String(s.game);
      if (!cur.campaign && s.campaign) cur.campaign = String(s.campaign);
      if (!cur.image && (s.imageURL || s.image)) cur.image = String(s.imageURL || s.image);
    }
    cur.qty += n;
    let left = n;
    if (Array.isArray(s.waves)) {
      for (const w of s.waves) {
        const q = Math.min(left, copies(w && w.qty));
        addWave(cur.waves, w && w.campaign, q);
        left -= q;
      }
      addWave(cur.waves, "", left);
    } else {
      addWave(cur.waves, s.qty == null ? s.campaign : "", left);
    }
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Expiry rules (pure; see the EXPIRY note at the top)
// ---------------------------------------------------------------------------

function hoursSetting(v, d, lo, hi) {
  if (v == null || (typeof v === "string" && !v.trim())) return d;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
}

// { on, claimWindowMs, sellLeadMs, bundleLeadMs }. A settings.js without
// getAutoFarm (or a throw in it) degrades to the documented defaults.
function expirySettings() {
  let af = null;
  try {
    if (typeof settings.getAutoFarm === "function") af = settings.getAutoFarm();
  } catch (e) {
    console.error("noclaimHoldings: auto-farm settings unreadable:", e.message);
  }
  af = af && typeof af === "object" ? af : {};
  const D = EXPIRY_DEFAULTS;
  // Never under an hour: the lead has to outlast a stock sync (15 min on
  // Eldorado, 30 on PlayerAuctions), or an offer could still be on sale when
  // the copies go.
  const sellH = hoursSetting(af.noclaimSellLeadHours, D.sellLeadHours, 1, 120);
  return {
    on: af.noclaimExpiryAware !== false,
    claimWindowMs: hoursSetting(af.noclaimClaimWindowHours, D.claimWindowHours, 1, 24 * 60) * HOUR_MS,
    sellLeadMs: sellH * HOUR_MS,
    bundleLeadMs: (sellH + D.bundleMarginHours) * HOUR_MS,
  };
}

// How far ahead a market's offers must already be covered. 0 with the switch
// off. Eldorado has the rotation to move an offer on to the next bundle, so it
// can afford to stop a day early; the others only get the safety hour.
function advertiseLeadMs(market, exp = expirySettings()) {
  if (!exp || !exp.on) return 0;
  const m = String(market || "").trim().toLowerCase();
  return m === "eldorado" ? exp.sellLeadMs : Math.min(exp.sellLeadMs, TECH_LEAD_MS);
}

function sameGameNorm(a, b) {
  const x = normGame(a);
  const y = normGame(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

function msOf(v) {
  if (!v) return NaN;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : NaN;
}

// Map<lowercased campaign name, [{ game, endMs }]> from TwitchCampaign rows. A
// row without an end date says nothing and is left out.
function campaignEndIndex(rows) {
  const out = new Map();
  for (const c of rows || []) {
    const name = String((c && c.name) || "").trim().toLowerCase();
    const endMs = msOf(c && c.endAt);
    if (!name || !Number.isFinite(endMs)) continue;
    const entry = { game: String(c.game || ""), endMs };
    const list = out.get(name);
    if (list) list.push(entry);
    else out.set(name, [entry]);
  }
  return out;
}

// When the copies a holding got from `campaign` leave the account: the
// campaign's end + the claim window. Infinity = not known (no campaign of that
// name for the game, no end date, or expiry awareness off) — such a copy
// counts until a live read shows it gone.
//
// `readMs` is when the copy was last SEEN. A campaign that should have taken it
// more than REFUTE_GRACE before that was not its source — Twitch re-uses names
// — so it is skipped; the earliest of the rest decides (the cautious pick).
function waveGoneAt(base, game, campaign, readMs) {
  const exp = base && base.expiry;
  if (!exp || !exp.on) return Infinity;
  const name = String(campaign || "").trim().toLowerCase();
  const list = name && base.campaignEnds ? base.campaignEnds.get(name) : null;
  if (!list) return Infinity;
  let best = Infinity;
  for (const c of list) {
    if (c.game && game && !sameGameNorm(c.game, game)) continue;
    const gone = c.endMs + exp.claimWindowMs;
    if (Number.isFinite(readMs) && readMs > gone + REFUTE_GRACE_MS) continue;
    if (gone < best) best = gone;
  }
  return best;
}

// The holding's items as they will stand at `atMs`: each item's qty is the
// copies still on the account then, and an item with none left is dropped. A
// kept item carries the campaign of its longest-lived copies, so "is this item
// part of a current event?" is asked of what will actually be sold.
// Never mutates the holding; an item the rules leave whole is returned as is.
function durableItems(holding, base, atMs = Date.now()) {
  const items = Array.isArray(holding && holding.items) ? holding.items : [];
  const exp = base && base.expiry;
  if (!exp || !exp.on || !items.length) return items;
  const readMs = msOf(holding.readAt);
  const out = [];
  for (const it of items) {
    const waves = it && Array.isArray(it.waves) && it.waves.length ? it.waves : null;
    if (!waves) {
      if (it) out.push(it); // written before waves were kept: nothing known
      continue;
    }
    const total = copies(it.qty);
    let left = total;
    let qty = 0;
    let label = "";
    let labelGone = -Infinity;
    for (const w of waves) {
      const n = Math.min(left, copies(w && w.qty));
      if (n <= 0) continue;
      left -= n;
      const gone = waveGoneAt(base, it.game, w && w.campaign, readMs);
      if (!(gone > atMs)) continue;
      qty += n;
      const name = String((w && w.campaign) || "").trim();
      if (name && gone >= labelGone) {
        labelGone = gone;
        label = name;
      }
    }
    qty += left; // copies the waves do not account for: unknown, so they count
    if (qty <= 0) continue;
    const campaign = label || String(it.campaign || "");
    if (qty === total && campaign === String(it.campaign || "")) out.push(it);
    else out.push({ ...it, qty, campaign });
  }
  return out;
}

// Every in-config holding with its items as of `atMs` (durableItems). The
// shape the offer pickers read, so they build bundles out of what will last.
function durableHoldings(base, atMs = Date.now()) {
  const list = (base && base.holdings) || [];
  const exp = base && base.expiry;
  if (!exp || !exp.on) return list;
  return list.map((h) => {
    if (!h) return h;
    const items = durableItems(h, base, atMs);
    return items === h.items ? h : { ...h, items };
  });
}

// [{ itemKey, name, game, had, has }] for every item of which the fresh read
// holds FEWER copies than the old row was expected to hold by now — a loss no
// campaign end explains. `before` is the stored row, `items` the new fold.
function unpredictedLosses(before, items, base, now = Date.now()) {
  if (!before || !Array.isArray(before.items) || !before.items.length) return [];
  const have = new Map();
  for (const it of items || []) have.set(String(it.itemKey || ""), copies(it.qty));
  const out = [];
  for (const it of durableItems(before, base, now)) {
    const key = String((it && it.itemKey) || "");
    if (!key) continue;
    const had = copies(it.qty);
    const has = have.get(key) || 0;
    if (has < had) out.push({ itemKey: key, name: String(it.name || ""), game: String(it.game || ""), had, has });
  }
  return out;
}

// Both names a holding can be known by: its row key (the config's login) and
// its current login from the last live read. They differ after a Twitch
// rename — and the engine keys its ledger and listing units by the LIVE
// login, so checking only the row key would call a listed account free.
function loginKeys(h) {
  const keys = [];
  const a = String((h && h.loginLower) || "").toLowerCase();
  const b = String((h && h.login) || "").toLowerCase();
  if (a) keys.push(a);
  if (b && b !== a) keys.push(b);
  return keys;
}

function ledgerRank(l) {
  const s = l && l.status;
  if (FREE_STATUSES.includes(s)) return 0;
  return LEDGER_RANK[s] || 1; // an unknown status is committed, not free
}

function strongestLedger(list) {
  let best = null;
  for (const l of list || []) {
    if (l && (!best || ledgerRank(l) > ledgerRank(best))) best = l;
  }
  return best;
}

function ledgerFor(h, base) {
  const map = base && base.ledgerByLogin;
  if (!map) return null;
  return strongestLedger(loginKeys(h).map((k) => map.get(k)));
}

// soldGames holds normalised game names (the engine stamps normGameName).
// Matched as substrings both ways — the no-claim fleet's own rule
// (noclaimFleet.soldGameExclusion) — so an account spent on "Overwatch 2" is
// not sold again for "Overwatch". Over-matching only hides stock;
// under-matching would sell one game's drops on one login twice.
function soldForGame(soldGames, gameNorm) {
  const wants = (Array.isArray(gameNorm) ? gameNorm : [gameNorm])
    .map(normGame)
    .filter(Boolean);
  if (!wants.length) return false;
  return (Array.isArray(soldGames) ? soldGames : []).some((g) => {
    const s = normGame(g);
    return !!s && wants.some((w) => s === w || s.includes(w) || w.includes(s));
  });
}

// "" when the account is free for a set of `gameNorm` (contract §0 rules 1-4;
// item coverage is the caller's check), else the first reason it is not.
// `gameNorm` may be "" (no per-game check) or a list of games.
function freeReason(holding, base, gameNorm) {
  const h = holding || {};
  const b = base || {};
  if (h.inConfig !== true) return "not in a bot";
  const pool =
    h.poolAccountId && b.poolById ? b.poolById.get(String(h.poolAccountId)) : null;
  if (!pool) return "no pool row";
  if (!pool.hasPassword) return "no password";
  if (pool.manualSold === true) return "manual sold";
  // The no-claim console's "Listed" tick: the owner hand-listed it somewhere,
  // or an engine/manual listing holds it.
  if (pool.listed === true) return "ticked listed";
  if (soldForGame(pool.soldGames, gameNorm)) return "sold for this game";
  if (SPENT_NOTE_RE.test(String(pool.claimedNote || "").trim())) return "spent";
  if (pool.status !== "claimed") return "pool not claimed";
  const ledger = ledgerFor(h, b);
  if (ledger && !FREE_STATUSES.includes(ledger.status)) {
    if (ledger.status === "listed") return "on auto listing";
    if (ledger.status === "manual") return "on manual listing";
    if (ledger.status === "sold") return "sold";
    if (ledger.status === "removed") return "removed";
    return String(ledger.status || "ledgered");
  }
  const active = b.activeLogins;
  if (active && loginKeys(h).some((k) => active.has(k))) return "on a listing";
  return "";
}

// True while the row is flagged for a re-read (recheckAt) and no live read has
// landed since. A flag only ever marks rows read BEFORE its moment
// (flagRecheck), so a read stamped at that very moment already answers it.
function needsRecheck(holding) {
  const rc = msOf(holding && holding.recheckAt);
  if (!Number.isFinite(rc)) return false;
  const ms = msOf(holding.readAt);
  return !Number.isFinite(ms) || ms < rc;
}

// `now` is optional so tests (and a caller holding one clock) can pin it.
function isFresh(holding, base, now = Date.now()) {
  const readAt = holding && holding.readAt;
  if (!readAt) return false;
  const ms = new Date(readAt).getTime();
  const maxAgeMs = Number(base && base.maxAgeMs);
  if (!Number.isFinite(ms) || !Number.isFinite(maxAgeMs)) return false;
  // Something proved the snapshot wrong about this account's items: it is not
  // stock again until it has been read after that.
  if (needsRecheck(holding)) return false;
  return now - ms <= maxAgeMs;
}

// Display label for spellings that fold to one game — the archive's
// pickGameLabel rule: most common wins, ties go to Title-case, then A-Z.
function nicestLabel(counts) {
  let best = "";
  let bestScore = -Infinity;
  for (const [label, count] of counts || []) {
    const hasUpper = /[A-Z]/.test(label);
    const hasLower = /[a-z]/.test(label);
    const score = count * 4 + (hasUpper && hasLower ? 2 : 0) + (hasUpper ? 1 : 0);
    if (score > bestScore || (score === bestScore && label.localeCompare(best) < 0)) {
      best = label;
      bestScore = score;
    }
  }
  return best;
}

// Bounded parallel map (the engine's mapLimit is internal to it).
async function mapLimit(items, n, fn) {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

// ---------------------------------------------------------------------------
// Snapshot writes
// ---------------------------------------------------------------------------

// Step 5 of the sweep, shared with recordRead. A success replaces the items and
// stamps readAt; a failure only records why (the old items and readAt stay, so
// freshness keeps ageing honestly). Never an upsert: a row that exists only
// because a claim read it would claim to be in a bot config. Never throws — it
// is bookkeeping, and a claim must not fail on it.
async function writeRead(loginLower, { sellable, login, error } = {}) {
  let update;
  let items = null;
  if (error) {
    const msg = String((error && error.message) || error || "read failed");
    update = { $set: { readError: msg.slice(0, 300) } };
  } else {
    if (!Array.isArray(sellable)) return false; // nothing read — never wipe items
    items = foldSellable(sellable);
    update = {
      $set: {
        items,
        sellableCount: items.reduce((n, it) => n + it.qty, 0),
        readAt: new Date(),
        readError: "",
      },
    };
    // The live login wins over the config's (a Twitch rename).
    const live = String(login || "").trim();
    if (live) update.$set.login = live;
  }
  // What the row held before this read, to notice copies that went without any
  // campaign end explaining it (noteLosses). Best effort: bookkeeping only.
  let before = null;
  if (items) {
    try {
      before = await NoclaimHolding.findOne({ loginLower }).lean();
    } catch {
      before = null;
    }
  }
  try {
    const r = await NoclaimHolding.updateOne({ loginLower }, update);
    const ok = !!(r && (r.matchedCount || r.n));
    if (ok && before) await noteLosses(before, items, update.$set.readAt);
    return ok;
  } catch (e) {
    console.error(
      "noclaimHoldings: holding write failed for " + loginLower + ":",
      e.message,
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Losses nobody predicted, and the re-read they force
// ---------------------------------------------------------------------------
// The expiry rules know when a wave goes — when its campaign is on record with
// an end date and Twitch keeps to seven days. When copies leave FREE accounts
// some other way, the snapshot is wrong about every account still holding that
// item, and stays wrong until each is read again (hours, at the sweep's pace).
// So: LOSS_CONFIRM different accounts short of the same item inside
// LOSS_WINDOW_MS flag every holder read BEFORE the first of them (the ones that
// showed it, and anything read since, already tell the truth). A flagged row is
// not fresh (isFresh) — it counts as no stock — and is read first.

const lossWindow = new Map(); // itemKey -> Map<loginLower, { at: its read, name }>
const lossFlagged = new Map(); // itemKey -> ms of the last flag it raised
let draining = false;
let drainBackoffUntil = 0;

function sleep(ms) {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    if (t.unref) t.unref();
  });
}

// `readAt` is the read that produced `items`. Never throws: called from
// writeRead, which a claim must not fail on.
async function noteLosses(before, items, readAt) {
  try {
    if (!expirySettings().on) return;
    // An account read as holding NOTHING is more often Twitch answering an
    // empty inventory than an expiry (see FORCED_EMPTY): it is not evidence.
    if (!items || !items.length) return;
    const have = new Map();
    for (const it of items || []) have.set(String(it.itemKey || ""), copies(it.qty));
    // The usual read lost nothing: answer before building anything.
    const shrank = (before.items || []).some(
      (it) => it && (have.get(String(it.itemKey || "")) || 0) < copies(it.qty),
    );
    if (!shrank) return;
    const base = await snapshotBase();
    // A committed account loses copies when its buyer claims them — not news.
    if (before.inConfig !== true || freeReason(before, base, "") !== "") return;
    const now = Date.now();
    const readMs = Number.isFinite(msOf(readAt)) ? msOf(readAt) : now;
    const key = String(before.loginLower || "").toLowerCase();
    for (const l of unpredictedLosses(before, items, base, now)) {
      let seen = lossWindow.get(l.itemKey);
      if (!seen) {
        seen = new Map();
        lossWindow.set(l.itemKey, seen);
      }
      for (const [login, o] of seen) if (now - o.at > LOSS_WINDOW_MS) seen.delete(login);
      seen.set(key, { at: readMs, name: l.name || l.itemKey });
      if (seen.size < LOSS_CONFIRM) continue;
      if (now - (lossFlagged.get(l.itemKey) || 0) < LOSS_WINDOW_MS) continue;
      lossFlagged.set(l.itemKey, now);
      let first = now;
      for (const o of seen.values()) if (o.at < first) first = o.at;
      await flagRecheck({
        itemKeys: [l.itemKey],
        before: first,
        reason:
          seen.size + " free accounts lost copies of " + (l.name || l.itemKey) +
          " that no campaign end explains",
      });
    }
  } catch (e) {
    console.error("noclaimHoldings: loss check failed:", e && e.message);
  }
}

// Every in-config holding of these items last read BEFORE `before` (default:
// now) must be read again before it counts as stock. A row read at that very
// moment or later is left alone: it is the evidence. Returns { flagged }.
// Never throws.
async function flagRecheck({ itemKeys, before, reason = "" } = {}) {
  const keys = [
    ...new Set(
      (Array.isArray(itemKeys) ? itemKeys : [])
        .map((k) => String(k || "").trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (!keys.length) return { flagged: 0 };
  const beforeMs = msOf(before);
  const at = new Date(Number.isFinite(beforeMs) ? beforeMs : Date.now());
  let flagged = 0;
  try {
    const r = await NoclaimHolding.updateMany(
      {
        inConfig: true,
        "items.itemKey": { $in: keys },
        $or: [{ readAt: null }, { readAt: { $lt: at } }],
      },
      { $set: { recheckAt: at } },
    );
    flagged = Number(r && (r.modifiedCount != null ? r.modifiedCount : r.nModified)) || 0;
  } catch (e) {
    console.error("noclaimHoldings: recheck flag failed:", e.message);
    return { flagged: 0, error: e.message };
  }
  invalidate();
  if (!flagged) return { flagged: 0 };
  console.log(
    "noclaimHoldings: " + flagged + " holding(s) of " + keys.join(", ") +
      " are re-read before they count as stock again — " + (reason || "snapshot proved wrong"),
  );
  try {
    require("./systemLog").logEvent({
      category: "noclaim_shop",
      action: "recheck_flagged",
      actor: "noclaimHoldings",
      severity: "warn",
      subject: keys.slice(0, 3).join(", "),
      count: flagged,
      detail:
        flagged + " no-claim holding(s) taken out of stock until re-read: " +
        (reason || "the snapshot proved wrong"),
    });
  } catch {
    /* the audit row is not worth failing a flag */
  }
  kickDrain();
  return { flagged };
}

// In-config rows flagged and not read since (needsRecheck, as a query — it
// compares two fields, so $expr; a never-read row's null sorts before any date).
// Rows a forced re-read already left to the regular sweep (FORCED_EMPTY) are
// not pending: the drain has done what it may with them.
async function pendingRecheck() {
  return NoclaimHolding.countDocuments({
    inConfig: true,
    recheckAt: { $ne: null },
    readError: { $not: FORCED_EMPTY_RE },
    $expr: { $lt: ["$readAt", "$recheckAt"] },
  });
}

// Read the flagged rows now instead of at the sweep's pace: `refreshBudget`
// reads a pass until none is left. A pass in which every read failed (the scan
// host is down) ends the drain and holds the next one off for a few minutes —
// the regular tick comes back to it.
async function drainRecheck() {
  for (let pass = 0; pass < DRAIN_MAX_PASSES; pass++) {
    const cfg = shopSettings();
    if (!cfg.enabled || !cfg.sweep) return;
    const r = await sweepOnce({
      budget: cfg.refreshBudget,
      concurrency: 3,
      reason: "recheck",
      recheckOnly: true,
    });
    if (r && r.skipped === "running") {
      await sleep(15 * 1000);
      continue;
    }
    if (!r || r.skipped || !r.picked) return;
    if (!r.read) {
      drainBackoffUntil = Date.now() + 5 * 60 * 1000;
      return;
    }
  }
}

function kickDrain() {
  if (draining || Date.now() < drainBackoffUntil) return;
  draining = true;
  const t = setTimeout(async () => {
    try {
      await drainRecheck();
    } catch (e) {
      console.error("noclaimHoldings: recheck drain failed:", e && e.message);
    } finally {
      draining = false;
    }
  }, 1000);
  if (t.unref) t.unref();
}

// A claim's own live read, recorded so the picker and the next claim see it.
async function recordRead(loginLower, { sellable, login, error } = {}) {
  const key = String(loginLower || "").toLowerCase();
  if (!key) return false;
  const ok = await writeRead(key, { sellable, login, error });
  invalidate();
  return ok;
}

// A refresh aimed at one game re-reads the accounts of bots farming it AND the
// accounts already known to hold its items (a no-claim bot watches every
// FavouriteGame, so drops of a game often sit on another game's bot).
function sweepGameMatches(cand, state, wantNorm) {
  if (normGame(cand.game).includes(wantNorm)) return true;
  return ((state && state.items) || []).some((it) =>
    normGame(it && it.game).includes(wantNorm),
  );
}

// A row whose items were stored before copies were split per campaign: its
// expiry cannot be predicted until it is read once more.
function lacksWaves(row) {
  return ((row && row.items) || []).some(
    (it) => it && !(Array.isArray(it.waves) && it.waves.length),
  );
}

async function sweepInner({ budget, concurrency, game, reason, t0, recheckOnly }) {
  const cfg = shopSettings();
  const maxAgeMs = maxAgeMsOf(cfg);
  const wantBudget =
    budget == null || !Number.isFinite(Number(budget))
      ? posNum(cfg.sweepPerTick, NOCLAIM_FALLBACK.sweepPerTick)
      : Number(budget);
  const limit = Math.min(MAX_BUDGET, Math.max(0, Math.floor(wantBudget)));
  const workers = Math.min(
    MAX_CONCURRENCY,
    Math.max(1, Math.floor(Number(concurrency)) || 2),
  );
  const engine = ual();

  // 1. Every account in every no-claim bot config (one batched Pi round trip).
  let raw;
  try {
    raw = await engine.collectNoClaimCandidates();
  } catch (e) {
    console.error(
      "noclaimHoldings sweep (" + reason + "): Pi unreachable —",
      e.message,
    );
    return {
      configs: 0,
      accounts: 0,
      picked: 0,
      read: 0,
      failed: 0,
      tookMs: Date.now() - t0,
      skipped: "pi unreachable",
      error: e.message,
    };
  }
  const cands = [];
  const seen = new Set();
  const bots = new Set();
  for (const c of Array.isArray(raw) ? raw : []) {
    if (!c) continue;
    if (c.botId) bots.add(String(c.botId));
    const loginLower = String(c.login || "").toLowerCase();
    // A config entry without a login cannot be keyed (the engine skips those
    // too); one login in two configs is one account — the first one wins.
    if (!loginLower || seen.has(loginLower)) continue;
    seen.add(loginLower);
    cands.push({ ...c, loginLower });
  }

  // 2. Pool row per account, joined by clientSecret. Same join (and the same
  // last-row-wins on a duplicated secret) as the engine's scan, so a holding
  // and the engine's ledger name the same pool row.
  const secrets = [...new Set(cands.map((c) => c.clientSecret).filter(Boolean))];
  const poolBySecret = new Map();
  if (secrets.length) {
    const rows = await AvailableAccount.find(
      { clientSecret: { $in: secrets } },
      { clientSecret: 1 },
    ).lean();
    for (const p of rows) poolBySecret.set(p.clientSecret, String(p._id));
  }

  // 3. Base fields for every account; anything not seen left its bot.
  const now = new Date();
  if (cands.length) {
    await NoclaimHolding.bulkWrite(
      cands.map((c) => ({
        updateOne: {
          filter: { loginLower: c.loginLower },
          update: {
            $set: {
              twitchId: String(c.twitchId || ""),
              poolAccountId: poolBySecret.get(c.clientSecret) || "",
              botId: String(c.botId || ""),
              container: String(c.container || ""),
              game: String(c.game || ""),
              seenAt: now,
              inConfig: true,
            },
            // Insert-only: a live read stores the account's CURRENT login (a
            // Twitch rename), and the next sweep must not put the config's
            // stale name back.
            $setOnInsert: { login: String(c.login || "") },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }
  await NoclaimHolding.updateMany(
    { loginLower: { $nin: [...seen] }, inConfig: true },
    { $set: { inConfig: false } },
  );

  // 4. What to read: never-read first, then the oldest read. Rows whose last
  // read FAILED go after every healthy one — a dead token fails forever, and
  // "never-read first" alone would spend the whole budget on those every tick
  // while the rest of the snapshot went stale.
  const state = new Map();
  if (cands.length) {
    const rows = await NoclaimHolding.find(
      { loginLower: { $in: [...seen] } },
      { loginLower: 1, readAt: 1, readError: 1, recheckAt: 1, "items.game": 1, "items.waves": 1 },
    ).lean();
    for (const r of rows) state.set(r.loginLower, r);
  }
  const wantGame =
    String(game || "").trim() === OTHER_REWARDS ? "" : normGame(game);
  // A refresh never re-reads something fresh: anything read within half the
  // freshness window is left alone. Two kinds of row are read regardless: one
  // flagged for a re-read (it is not stock until then — these go first), and
  // one stored without per-campaign copies (its expiry cannot be predicted).
  const rereadBefore = Date.now() - maxAgeMs / 2;
  const wavesWanted = expirySettings().on;
  const eligible = [];
  for (const c of cands) {
    const st = state.get(c.loginLower) || {};
    if (wantGame && !sweepGameMatches(c, st, wantGame)) continue;
    const flagged = needsRecheck(st);
    // A forced re-read already asked this row once and got an empty answer:
    // it waits for the regular sweep, and there it is not a failing token.
    const deferred = FORCED_EMPTY_RE.test(String(st.readError || ""));
    if (recheckOnly && (!flagged || deferred)) continue;
    const readMs = st.readAt ? new Date(st.readAt).getTime() : NaN;
    if (
      !flagged &&
      !(wavesWanted && lacksWaves(st)) &&
      Number.isFinite(readMs) &&
      readMs > rereadBefore
    ) {
      continue;
    }
    eligible.push({
      cand: c,
      readMs: Number.isFinite(readMs) ? readMs : 0,
      failing: st.readError && !deferred ? 1 : 0,
      later: flagged ? 0 : 1,
      held: ((st && st.items) || []).length > 0,
    });
  }
  eligible.sort(
    (a, b) =>
      a.failing - b.failing ||
      a.later - b.later ||
      a.readMs - b.readMs ||
      a.cand.loginLower.localeCompare(b.cand.loginLower),
  );
  const picked = eligible.slice(0, limit);

  // 5. Live reads, a few at a time.
  let read = 0;
  let failed = 0;
  await mapLimit(picked, workers, async ({ cand, held }) => {
    let res;
    try {
      res = await engine.inventoryForCandidate(cand);
      if (!res || !Array.isArray(res.sellable)) {
        throw new Error("empty inventory response");
      }
      if (recheckOnly && held && !res.sellable.length) {
        throw new Error(FORCED_EMPTY + " — left for the regular sweep to confirm");
      }
    } catch (e) {
      failed++;
      await writeRead(cand.loginLower, { error: e });
      return;
    }
    read++;
    await writeRead(cand.loginLower, { sellable: res.sellable, login: res.login });
  });

  // 6.
  invalidate();
  const tookMs = Date.now() - t0;
  console.log(
    "noclaimHoldings sweep (" + reason + "): read " + read + "/" + picked.length +
      ", failed " + failed + " in " + tookMs + "ms",
  );
  return {
    configs: bots.size,
    accounts: cands.length,
    picked: picked.length,
    read,
    failed,
    tookMs,
  };
}

// `recheckOnly` reads nothing but rows flagged for a re-read (drainRecheck).
async function sweepOnce({
  budget,
  concurrency = 2,
  game = "",
  reason = "tick",
  recheckOnly = false,
} = {}) {
  if (sweeping) return { skipped: "running" };
  sweeping = true;
  const t0 = Date.now();
  let out;
  try {
    out = await sweepInner({ budget, concurrency, game, reason, t0, recheckOnly });
  } catch (e) {
    // A DB error mid-sweep. Never reject: the refresh route starts a sweep
    // without awaiting it, and an unhandled rejection would take the server
    // down.
    console.error("noclaimHoldings sweep (" + reason + ") failed:", e.message);
    out = {
      configs: 0,
      accounts: 0,
      picked: 0,
      read: 0,
      failed: 0,
      tookMs: Date.now() - t0,
      skipped: "error",
      error: e.message,
    };
  } finally {
    sweeping = false;
  }
  lastSweep = { at: new Date(), reason, ...out };
  return out;
}

// ---------------------------------------------------------------------------
// Snapshot reads
// ---------------------------------------------------------------------------

function invalidate() {
  baseCache = null;
}

function isSweeping() {
  return sweeping;
}

function hasPoolPassword(engine, row) {
  if (engine && typeof engine.poolPassword === "function") {
    try {
      return !!engine.poolPassword(row);
    } catch {
      return false;
    }
  }
  // An engine without the poolPassword export (it ships in the same change):
  // any stored secret counts. A claim still resolves the real credential and
  // rolls back when there is none, so this can only widen the shortlist.
  return !!(row && (row.password || row.credPasswordEnc));
}

async function buildBase() {
  const cfg = shopSettings();
  const at = new Date();
  const holdings = await NoclaimHolding.find({ inConfig: true }).lean();
  const logins = new Set();
  const poolIds = new Set();
  for (const h of holdings) {
    for (const k of loginKeys(h)) logins.add(k);
    const pid = String(h.poolAccountId || "");
    if (OBJECT_ID_RE.test(pid)) poolIds.add(pid);
  }
  const [ledgers, listed, poolRows] = await Promise.all([
    logins.size
      ? UnclaimedAccount.find(
          { source: "noclaim", loginLower: { $in: [...logins] } },
          { loginLower: 1, status: 1, manualListing: 1, set: 1, market: 1 },
        ).lean()
      : [],
    listedLogins.loginsOnActiveListings(),
    poolIds.size
      ? AvailableAccount.find(
          { _id: { $in: [...poolIds] } },
          {
            status: 1,
            manualSold: 1,
            listed: 1,
            soldGames: 1,
            claimedNote: 1,
            password: 1,
            credPasswordEnc: 1,
          },
        ).lean()
      : [],
  ]);

  const ledgerByLogin = new Map();
  for (const l of ledgers || []) {
    const key = String(l.loginLower || "").toLowerCase();
    if (!key) continue;
    const entry = {
      _id: l._id,
      status: l.status,
      manualListing: l.manualListing || "",
      set: l.set || null,
      market: l.market || "",
    };
    const cur = ledgerByLogin.get(key);
    if (!cur || ledgerRank(entry) > ledgerRank(cur)) ledgerByLogin.set(key, entry);
  }
  const activeLogins = new Set(listed || []);
  // Rename aliases: a holding's row key and its live login name ONE account,
  // so both keys answer with its strongest ledger and its listing state. A
  // consumer looking up either name sees what the other name carries.
  for (const h of holdings) {
    const keys = loginKeys(h);
    if (keys.length < 2) continue;
    const best = strongestLedger(keys.map((k) => ledgerByLogin.get(k)));
    if (best) for (const k of keys) ledgerByLogin.set(k, best);
    if (keys.some((k) => activeLogins.has(k))) for (const k of keys) activeLogins.add(k);
  }

  const engine = ual();
  const poolById = new Map();
  for (const p of poolRows || []) {
    // Only what the free rules need — never the password itself.
    poolById.set(String(p._id), {
      status: p.status || "",
      manualSold: p.manualSold === true,
      listed: p.listed === true,
      soldGames: Array.isArray(p.soldGames) ? p.soldGames.slice() : [],
      claimedNote: String(p.claimedNote || ""),
      hasPassword: hasPoolPassword(engine, p),
    });
  }
  const expiry = expirySettings();
  return {
    at,
    maxAgeMs: maxAgeMsOf(cfg),
    holdings,
    ledgerByLogin,
    activeLogins,
    poolById,
    expiry,
    campaignEnds: expiry.on ? await campaignEndsFor(holdings) : new Map(),
  };
}

// End dates of every campaign a holding's copies came from. A failed read
// keeps the last good answer: without end dates nothing is predicted and every
// copy counts until a read shows it gone — the hole these rules close.
//
// Matched ignoring case and surrounding blanks: Twitch's own names carry them
// ("Ironmouse Drops Rerun! " ends in a space), and a wave's label is stored
// trimmed. The answer is kept for a few minutes — the snapshot is rebuilt after
// every claim read, and an end date does not move that fast.
const CAMPAIGN_ENDS_TTL_MS = 5 * 60 * 1000;
let lastCampaignEnds = new Map();
let lastCampaignKey = "";
let lastCampaignAt = 0;

function nameRegex(name) {
  return new RegExp("^\\s*" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*$", "i");
}

async function campaignEndsFor(holdings) {
  const names = new Set();
  for (const h of holdings || []) {
    for (const it of (h && h.items) || []) {
      for (const w of (it && it.waves) || []) {
        const n = String((w && w.campaign) || "").trim();
        if (n) names.add(n);
      }
    }
  }
  if (!names.size) return new Map();
  const key = [...names].sort().join("\n");
  if (key === lastCampaignKey && Date.now() - lastCampaignAt < CAMPAIGN_ENDS_TTL_MS) {
    return lastCampaignEnds;
  }
  try {
    const rows = await campaignModel()
      .find({ name: { $in: [...names].map(nameRegex) } }, { name: 1, game: 1, endAt: 1 })
      .lean();
    lastCampaignEnds = campaignEndIndex(rows);
    lastCampaignKey = key;
    lastCampaignAt = Date.now();
  } catch (e) {
    console.error("noclaimHoldings: campaign end dates unreadable:", e.message);
  }
  return lastCampaignEnds;
}

// Cached for 30 s; concurrent callers share one in-flight build, and a failed
// build is never cached.
async function snapshotBase({ force = false } = {}) {
  const now = Date.now();
  if (!force && baseCache && now - baseCache.at < BASE_TTL_MS) return baseCache.promise;
  const entry = { at: now, promise: null };
  entry.promise = buildBase().catch((e) => {
    if (baseCache === entry) baseCache = null;
    throw e;
  });
  baseCache = entry;
  return entry.promise;
}

// Games in the snapshot, by the drops' own game label (a holder counts once per
// game): accounts holding any of its items, how many are free, and how many of
// those were read recently enough to advertise.
async function pickerGames() {
  const base = await snapshotBase();
  const now = Date.now();
  const games = new Map();
  for (const h of base.holdings || []) {
    const fresh = isFresh(h, base, now);
    const counted = new Set();
    for (const it of h.items || []) {
      const label = String((it && it.game) || "").trim();
      const key = gameKey(label);
      let g = games.get(key);
      if (!g) {
        g = { labels: new Map(), accounts: new Set(), free: new Set(), fresh: new Set() };
        games.set(key, g);
      }
      if (label) g.labels.set(label, (g.labels.get(label) || 0) + 1);
      if (counted.has(key)) continue;
      counted.add(key);
      g.accounts.add(h.loginLower);
      if (freeReason(h, base, normGame(label)) === "") {
        g.free.add(h.loginLower);
        if (fresh) g.fresh.add(h.loginLower);
      }
    }
  }
  return [...games.entries()]
    .map(([key, g]) => ({
      game: key ? nicestLabel(g.labels) || key : OTHER_REWARDS,
      accounts: g.accounts.size,
      free: g.free.size,
      fresh: g.fresh.size,
    }))
    .sort(
      (a, b) =>
        b.free - a.free ||
        b.fresh - a.fresh ||
        b.accounts - a.accounts ||
        String(a.game).localeCompare(String(b.game)),
    );
}

// One row per item, shaped like /drops-archive/by-item so the Listings picker
// renders it unchanged. `accounts` counts only FREE + FRESH holders (what a
// listing can promise now); `stale` = free holders whose read is too old;
// onAuto / onManual = holders whose ledger commits them to an auto-lister /
// owner-made listing (the whole account is committed, so all of its items).
async function pickerItems({ game = "", search = "" } = {}) {
  const base = await snapshotBase();
  const now = Date.now();
  const wantGame = String(game || "").trim();
  const wantKey = wantGame === OTHER_REWARDS ? "" : gameKey(wantGame);
  const needle = String(search || "").trim().toLowerCase();
  const rows = new Map();
  for (const h of base.holdings || []) {
    const fresh = isFresh(h, base, now);
    const ledger = ledgerFor(h, base);
    const status = ledger ? ledger.status : "";
    // Re-fold defensively: one entry per item per holder, copies summed.
    for (const it of foldSellable(h.items)) {
      const label = String(it.game || "").trim();
      if (wantGame && gameKey(label) !== wantKey) continue;
      if (needle && !String(it.name || "").toLowerCase().includes(needle)) continue;
      let row = rows.get(it.itemKey);
      if (!row) {
        row = {
          itemKey: it.itemKey,
          name: it.name,
          labels: new Map(),
          image: it.image,
          accounts: 0,
          minPerAcct: 0,
          maxPerAcct: 0,
          totalCount: 0,
          onAuto: 0,
          onManual: 0,
          stale: 0,
        };
        rows.set(it.itemKey, row);
      }
      if (!row.name && it.name) row.name = it.name;
      if (!row.image && it.image) row.image = it.image;
      if (label) row.labels.set(label, (row.labels.get(label) || 0) + 1);
      if (status === "listed") row.onAuto++;
      else if (status === "manual") row.onManual++;
      if (freeReason(h, base, normGame(label)) !== "") continue;
      if (!fresh) {
        row.stale++;
        continue;
      }
      row.accounts++;
      row.totalCount += it.qty;
      row.minPerAcct = row.accounts === 1 ? it.qty : Math.min(row.minPerAcct, it.qty);
      row.maxPerAcct = Math.max(row.maxPerAcct, it.qty);
    }
  }
  return [...rows.values()]
    .filter((r) => r.accounts + r.stale + r.onAuto + r.onManual > 0)
    .map((r) => ({
      itemKey: r.itemKey,
      name: r.name,
      game: nicestLabel(r.labels),
      image: r.image,
      accounts: r.accounts,
      minPerAcct: r.minPerAcct,
      maxPerAcct: r.maxPerAcct,
      totalCount: r.totalCount,
      onAuto: r.onAuto,
      onManual: r.onManual,
      stale: r.stale,
    }))
    .sort(
      (a, b) =>
        b.accounts - a.accounts ||
        String(a.name).localeCompare(String(b.name)) ||
        String(a.itemKey).localeCompare(String(b.itemKey)),
    )
    .slice(0, 2000);
}

// Snapshot health for the status strip. A light projection, not the base: the
// page polls this every few seconds while a refresh runs.
async function summary() {
  const cfg = shopSettings();
  const maxAgeMs = maxAgeMsOf(cfg);
  const rows = await NoclaimHolding.find(
    { inConfig: true },
    { readAt: 1, readError: 1 },
  ).lean();
  const now = Date.now();
  let read = 0;
  let fresh = 0;
  let stale = 0;
  let neverRead = 0;
  let failed = 0;
  let oldest = null;
  let newest = null;
  for (const r of rows) {
    if (r.readError) failed++;
    const ms = r.readAt ? new Date(r.readAt).getTime() : NaN;
    if (!Number.isFinite(ms)) {
      neverRead++;
      continue;
    }
    read++;
    if (now - ms <= maxAgeMs) fresh++;
    else stale++;
    if (oldest == null || ms < oldest) oldest = ms;
    if (newest == null || ms > newest) newest = ms;
  }
  return {
    accounts: rows.length,
    read,
    fresh,
    stale,
    neverRead,
    failed,
    oldestReadAt: oldest == null ? null : new Date(oldest),
    newestReadAt: newest == null ? null : new Date(newest),
    sweeping,
    lastSweep,
    settings: cfg,
  };
}

// Background sweep. The switches and the interval are read fresh every tick,
// so the owner can turn the sweep on/off or retime it without a restart. A tick
// that found the Pi unreachable waits 3× the interval before the next one.
// DEMAND-DRIVEN background sweep. Every read goes through the Pi's SSH link and
// Twitch's GQL, which the auto-lister and the pool checker already share, so
// the timer only reads while the snapshot is actually wanted: someone used the
// no-claim picker in the last INTEREST_WINDOW_MS (noteInterest, called by the
// routes), or a no-claim listing is live (its stock counts and claims lean on
// a fresh snapshot). After a restart nothing is wanted until the page is
// opened again — deploying this adds no Pi traffic of its own.
const INTEREST_WINDOW_MS = 12 * 60 * 60 * 1000;
let lastInterestAt = 0;

function noteInterest() {
  lastInterestAt = Date.now();
}

async function sweepWanted() {
  if (Date.now() - lastInterestAt < INTEREST_WINDOW_MS) return true;
  try {
    const MarketplaceListing = require("../models/MarketplaceListing");
    return !!(await MarketplaceListing.exists({ noclaimStock: true, status: "active" }));
  } catch {
    return false;
  }
}

function start() {
  if (timer) return;
  timer = true;
  const schedule = (ms) => {
    const t = setTimeout(tick, ms);
    if (t.unref) t.unref();
  };
  const tick = async () => {
    let backoff = false;
    try {
      const cfg = shopSettings();
      if (cfg.enabled && cfg.sweep && (await sweepWanted())) {
        const r = await sweepOnce({ budget: cfg.sweepPerTick, reason: "tick" });
        backoff = !!(r && r.skipped === "pi unreachable");
        // Rows flagged for a re-read are no stock until read: finish them now
        // (a drain a failed host cut short, or one a restart interrupted).
        if (!backoff && (await pendingRecheck()) > 0) kickDrain();
      }
    } catch (e) {
      console.error("noclaimHoldings tick error:", e.message);
    } finally {
      const everyMin = posNum(
        shopSettings().sweepEveryMin,
        NOCLAIM_FALLBACK.sweepEveryMin,
      );
      schedule(everyMin * 60 * 1000 * (backoff ? 3 : 1));
    }
  };
  schedule(FIRST_SWEEP_MS);
}

module.exports = {
  // constants
  EXPIRY_DEFAULTS,
  REFUTE_GRACE_MS,
  LOSS_CONFIRM,
  FORCED_EMPTY,
  // pure, tested
  foldSellable,
  normGame,
  freeReason,
  isFresh,
  needsRecheck,
  expirySettings,
  advertiseLeadMs,
  campaignEndIndex,
  waveGoneAt,
  durableItems,
  durableHoldings,
  unpredictedLosses,
  // re-read forcing
  flagRecheck,
  pendingRecheck,
  // snapshot
  sweepOnce,
  recordRead,
  snapshotBase,
  pickerGames,
  pickerItems,
  summary,
  start,
  noteInterest,
  sweepWanted,
  invalidate,
  isSweeping,
};
