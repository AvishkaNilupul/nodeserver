// ---------------------------------------------------------------------------
// No-claim Shop listings — the ONE claim layer
// (docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md §3).
//
// An owner-made listing (Listings → Shop listings) can take its stock from the
// no-claim farm: accounts sitting in noclaim-bot-* configs whose drops are
// watched to 100% and still UNCLAIMED. The buyer receives the whole account
// and claims the drops onto their own game account, so one account sells
// exactly once — and the no-claim auto-lister (utils/unclaimedAutoList.js)
// sells the very same farm on its own.
//
// The lock both systems share is the account's UnclaimedAccount ledger row
// (source "noclaim", one per login). Taking an account means moving that row,
// with a compare-and-set on the status it had, into a committed status:
//   "manual" — a unit on an owner's vault listing (Gameflip / GGSel / Plati),
//              or mid-publish. The auto-lister skips it and never touches it.
//   "sold"   — handed to a claim-at-sale buyer (Eldorado / PlayerAuctions /
//              G2G); stamped with the order so a retry re-sends the SAME
//              accounts instead of burning new ones.
// Only FREE_STATUSES may be taken. There is no DropLog behind this stock and no
// reservation to catch a second winner, so nothing else may write these
// transitions — a second copy would drift, and the drift is a double-sold
// account with the buyer's money already taken.
//
// The holdings snapshot (utils/noclaimHoldings.js) is only a shortlist: every
// claim re-reads the pool row, the live Twitch inventory and every active
// listing before it commits.
// ---------------------------------------------------------------------------
const UnclaimedAccount = require("../models/UnclaimedAccount");
const AvailableAccount = require("../models/AvailableAccount");
const MarketplaceListing = require("../models/MarketplaceListing");
const DropSet = require("../models/DropSet");
const settings = require("./settings");
const { logEvent } = require("./systemLog");
const { shareOfShelf } = require("./suppliedStock");

// Lazy on purpose. unclaimedAutoList reaches this file back through
// noclaimListings (a require cycle), and loading the holdings module on first
// use keeps `require("./noclaimStock")` safe at boot for the routes that pull
// in the constants and pure helpers only.
function holdings() {
  return require("./noclaimHoldings");
}
function ual() {
  return require("./unclaimedAutoList");
}

// Ledger statuses an account may be taken from, and the ones that mean it is
// already spoken for.
const FREE_STATUSES = ["skipped", "released", "expired"];
const COMMITTED_STATUSES = ["listed", "sold", "removed", "manual"];

// VAULT: the accounts are attached at publish (the credentials live in the
// platform's own delivery vault). CLAIM-AT-SALE: an account is claimed when a
// paid order lands.
const VAULT_MARKETS = ["gameflip", "ggsel", "digiseller"];
const CLAIM_AT_SALE_MARKETS = ["eldorado", "playerauctions", "g2g"];
const SUPPORTED_MARKETS = VAULT_MARKETS.concat(CLAIM_AT_SALE_MARKETS);

// Most accounts a claim-at-sale offer may advertise (before it is shared out
// among the set's other claim-at-sale offers).
const ADVERTISE_MAX = 25;

// Ceiling on one claim. A marketplace "quantity" is not always a number of
// accounts (PlayerAuctions counts ITEMS), so a caller passing one straight
// through could otherwise drain the farm. A short claim is recoverable;
// accounts handed out by mistake are not.
const MAX_CLAIM = 50;

const MARKET_LABELS = {
  gameflip: "Gameflip",
  digiseller: "Plati",
  ggsel: "GGSel",
  eldorado: "Eldorado",
  playerauctions: "PlayerAuctions",
  g2g: "G2G",
  funpay: "FunPay",
  zeusx: "ZeusX",
  epicnpc: "EpicNPC",
  z2u: "Z2U",
};

const MODES = ["fed", "sold"];

// What a ledger field reads as when the row never carried it (the model's
// defaults). A rolled-back claim writes back exactly what the row held before,
// so the auto-lister finds its row as it left it.
const LEDGER_DEFAULTS = {
  login: "",
  twitchId: "",
  game: "",
  poolAccountId: "",
  botId: "",
  container: "",
  drops: [],
  set: null,
  market: "",
  status: "skipped",
  note: "",
  listedAt: null,
  soldAt: null,
  soldPriceUsd: 0,
  soldMarket: "",
  lastCheckedAt: null,
  emptyReads: 0,
  firstEmptyAt: null,
  manualListing: "",
  manualPriorStatus: "",
  manualAt: null,
  manualDeliveredAt: null,
  manualSpentAt: null,
};

// ---------------------------------------------------------------------------
// Pure helpers (no I/O — unit-tested as-is)
// ---------------------------------------------------------------------------

function str(v) {
  return v == null ? "" : String(v);
}

function isNoclaimSet(set) {
  return !!set && set.stockSource === "noclaim";
}

function isNoclaimRow(row) {
  return !!row && row.noclaimStock === true;
}

// Exactly unclaimedAutoList.sellableDropsFromNoClaimInv's key.
function itemKeyOf(name, game) {
  return str(name).trim().toLowerCase() + "|" + str(game).trim().toLowerCase();
}

// The key of one item/drop entry. A stored itemKey wins: the inventory's key is
// built from the RAW drop name, while `name` is defaulted to "Reward" when the
// drop has none, so recomputing it from name/game would not match.
function keyOfEntry(e) {
  if (!e) return "";
  const stored = str(e.itemKey).trim().toLowerCase();
  if (stored) return stored;
  const k = itemKeyOf(e.name, e.game);
  return k === "|" ? "" : k;
}

// Map<itemKey, copies promised> for a no-claim set. A duplicated item adds up.
function requiredFromSet(set) {
  const out = new Map();
  for (const it of set && Array.isArray(set.items) ? set.items : []) {
    const k = keyOfEntry(it);
    if (!k) continue;
    const q = Math.max(1, Math.floor(Number(it.qty)) || 1);
    out.set(k, (out.get(k) || 0) + q);
  }
  return out;
}

// Map<itemKey, copies held>. Accepts the snapshot's folded items ({itemKey,
// qty}) or the raw inventory's sellable entries (one entry per copy, no qty).
function heldCounts(items) {
  const out = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    const k = keyOfEntry(it);
    if (!k) continue;
    const q = it.qty == null ? 1 : Math.max(0, Math.floor(Number(it.qty)) || 0);
    if (!q) continue;
    out.set(k, (out.get(k) || 0) + q);
  }
  return out;
}

// Accept a count Map, an item list, or a plain {key: count} object.
function toCounts(x) {
  if (x instanceof Map) return x;
  if (Array.isArray(x)) return heldCounts(x);
  if (x && typeof x === "object") {
    return new Map(Object.entries(x).map(([k, v]) => [k, Number(v) || 0]));
  }
  return new Map();
}

// Every required item held at least as many times as promised. An empty
// requirement covers nothing: a set with no items must never match every
// account in the farm.
function covers(held, required) {
  const h = toCounts(held);
  const r = toCounts(required);
  if (!r.size) return false;
  for (const [k, q] of r) {
    if ((h.get(k) || 0) < q) return false;
  }
  return true;
}

// Copies the account holds beyond what the set promises.
function extraLoad(held, required) {
  let total = 0;
  for (const q of toCounts(held).values()) total += Number(q) || 0;
  let need = 0;
  for (const q of toCounts(required).values()) need += Number(q) || 0;
  return Math.max(0, total - need);
}

function timeOf(v) {
  if (!v) return 0;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

// The order a claim walks candidates in. LEANEST first: the buyer gets the
// whole account and can claim anything else on it too, so every spare drop a
// sale gives away is stock another listing loses. Then the freshest read (the
// likeliest to still hold the set), then login for a stable order. Never
// mutates the input.
function orderCandidates(cands, required) {
  const req = toCounts(required);
  return (Array.isArray(cands) ? cands : [])
    .map((c, i) => ({
      c,
      i,
      extra: extraLoad(heldCounts(c && c.items), req),
      t: timeOf(c && c.readAt),
      l: str(c && c.loginLower),
    }))
    .sort(
      (a, b) =>
        a.extra - b.extra ||
        b.t - a.t ||
        (a.l < b.l ? -1 : a.l > b.l ? 1 : 0) ||
        a.i - b.i,
    )
    .map((x) => x.c);
}

// The row's advertised item list ([{name, qty}]), one entry per distinct item.
function requiredDropsForSet(set) {
  const byKey = new Map();
  for (const it of set && Array.isArray(set.items) ? set.items : []) {
    const k = keyOfEntry(it);
    if (!k) continue;
    const q = Math.max(1, Math.floor(Number(it.qty)) || 1);
    const cur = byKey.get(k);
    if (cur) {
      cur.qty += q;
      continue;
    }
    byKey.set(k, { name: str(it.name).trim() || k.split("|")[0], qty: q });
  }
  return [...byKey.values()];
}

// The fields every no-claim MarketplaceListing row carries. `accounts` are the
// vault units ([{login, contentId?}]); a claim-at-sale row passes [] and gets
// its units as orders are delivered.
function rowFields(set, market, accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  return {
    set: (set && set._id) || null,
    noclaimStock: true,
    origin: "manual",
    accountId: "",
    accountLogin:
      market === "gameflip" && list.length === 1 ? str(list[0] && list[0].login) : "",
    requiredDrops: requiredDropsForSet(set),
    units: list.map((a) => ({
      contentId: String((a && a.contentId) || ""),
      accountId: "",
      login: str(a && a.login),
      addedAt: new Date(),
      deliveredAt: null,
      orderId: "",
    })),
  };
}

function unsupportedMessage(market) {
  const label = MARKET_LABELS[str(market).trim().toLowerCase()] || str(market).trim() || "This marketplace";
  return (
    label +
    " is not supported for no-claim listings yet — use Gameflip, GGSel, Plati, Eldorado, PlayerAuctions or G2G"
  );
}

// The noclaimShop settings block. A missing accessor (a partial deploy) or a
// failed read reads as everything OFF: an idle switch holds a paid order, a
// wrong one ships a double-sold account.
function shopSettings() {
  try {
    if (typeof settings.getNoclaimShopSettings === "function") {
      return settings.getNoclaimShopSettings() || {};
    }
  } catch (e) {
    console.error("noclaimStock: settings read failed:", e && e.message);
  }
  return {};
}

function deliveryEnabled() {
  const s = shopSettings();
  return !!(s.enabled && s.autoDeliver);
}

// Every normalised game a set is about (its cover game plus each item's game).
// An account already sold for ANY of them is not stock for this set.
function setGameNorms(set) {
  const out = new Set();
  const add = (g) => {
    const n = settings.normGameName(g);
    if (n) out.add(n);
  };
  add(set && set.coverGame);
  for (const it of set && Array.isArray(set.items) ? set.items : []) add(it && it.game);
  return [...out];
}

// The game a ledger for this set is recorded under: the game of the drops
// being sold, not the bot's. spendAccount stamps pool soldGames from it, and a
// wrong game there is what lets a sold account be farmed or sold again.
function setGameLabel(set) {
  const items = set && Array.isArray(set.items) ? set.items : [];
  const first = items.find((it) => it && str(it.game).trim());
  return str((set && set.coverGame) || (first && first.game)).trim();
}

// soldGames against the set's games, matched as substrings both ways — the
// same rule noclaimHoldings.freeReason (and the fleet's soldGameExclusion)
// uses, so "Overwatch 2" blocks "Overwatch". Over-matching only hides stock.
function soldForGames(soldGames, gameNorms) {
  const wants = (Array.isArray(gameNorms) ? gameNorms : [gameNorms])
    .map((g) => settings.normGameName(g))
    .filter(Boolean);
  if (!wants.length) return false;
  return (Array.isArray(soldGames) ? soldGames : []).some((g) => {
    const s = settings.normGameName(g);
    return !!s && wants.some((w) => s === w || s.includes(w) || w.includes(s));
  });
}

// §0 rule 2 (plus the console's "Listed" tick, as freeReason has it),
// re-checked on the pool row at claim time. The snapshot is cached, and a
// manual-sold tick in that window means the operator has already handed this
// account to somebody. Returns "" when the pool row allows a sale.
function poolBlockReason(pool, gameNorms) {
  if (!pool) return "no pool row";
  if (pool.status !== "claimed") return "pool not claimed";
  if (pool.manualSold === true) return "manual sold";
  if (pool.listed === true) return "ticked listed";
  if (soldForGames(pool.soldGames, gameNorms)) return "sold for this game";
  if (/^(sold|spent)/i.test(str(pool.claimedNote).trim())) return "spent";
  if (!pool.password && !pool.credPasswordEnc) return "no password";
  if (!pool.clientSecret) return "no client secret";
  return "";
}

// The resume anchor of a claim-at-sale ledger (the same shape the unclaimed
// Eldorado path stamps).
function orderNote(market, orderId) {
  return market + " order " + str(orderId);
}

function idList(ids) {
  const out = [];
  for (const id of Array.isArray(ids) ? ids : [ids]) {
    if (id == null) continue;
    const v = typeof id === "object" && id._id ? id._id : id;
    // Ledger ids are ObjectIds. Anything else would make Mongoose throw a
    // CastError and fail the whole batch over one bad entry.
    if (typeof v === "object" && typeof v.toHexString === "function") out.push(v);
    else if (/^[0-9a-f]{24}$/i.test(str(v).trim())) out.push(str(v).trim());
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internal plumbing
// ---------------------------------------------------------------------------

function logSafely(fields) {
  try {
    // Fire-and-forget like the rest of the codebase: an audit write must never
    // fail a claim. Logins only — never a password or an email.
    Promise.resolve(logEvent(fields)).catch(() => {});
  } catch {
    /* logging is best-effort */
  }
}

async function safely(what, fn) {
  try {
    return await fn();
  } catch (e) {
    console.error("noclaimStock " + what + " failed:", e && e.message);
    return undefined;
  }
}

function invalidateSnapshot() {
  try {
    holdings().invalidate();
  } catch (e) {
    console.error("noclaimStock snapshot invalidate failed:", e && e.message);
  }
}

function ledgerOf(base, loginLower) {
  const m = base && base.ledgerByLogin;
  if (!m || typeof m.get !== "function") return null;
  return m.get(loginLower) || null;
}

// freeReason takes the whole list of the set's games ("" = no per-game check).
function freeForSet(h, base, norms) {
  return holdings().freeReason(h, base, norms.length ? norms : "") === "";
}

function candidateOf(h, led, required) {
  const items = Array.isArray(h.items) ? h.items : [];
  return {
    loginLower: str(h.loginLower || str(h.login).toLowerCase()),
    login: str(h.login || h.loginLower),
    poolAccountId: str(h.poolAccountId),
    botId: str(h.botId),
    container: str(h.container),
    game: str(h.game),
    twitchId: str(h.twitchId),
    items,
    readAt: h.readAt || null,
    ledgerStatus: str(led && led.status),
    // Spare copies beyond the set (what orderCandidates sorts on), so pickers
    // can show it without re-deriving the requirement.
    extra: extraLoad(heldCounts(items), required),
  };
}

// One pass over the snapshot for one set: every in-config holding that covers
// the set, split into free+fresh, free-but-stale and committed.
async function scanSet(set) {
  const out = {
    base: null,
    required: new Map(),
    fresh: [],
    stale: [],
    covering: 0,
    onAuto: 0,
    onManual: 0,
  };
  if (!isNoclaimSet(set)) return out;
  out.required = requiredFromSet(set);
  if (!out.required.size) return out;
  const nh = holdings();
  const base = await nh.snapshotBase();
  out.base = base || null;
  const norms = setGameNorms(set);
  for (const h of (base && base.holdings) || []) {
    if (!h || h.inConfig === false) continue;
    if (!covers(heldCounts(h.items), out.required)) continue;
    out.covering++;
    const led = ledgerOf(base, h.loginLower);
    if (freeForSet(h, base, norms)) {
      const c = candidateOf(h, led, out.required);
      if (nh.isFresh(h, base)) out.fresh.push(c);
      else out.stale.push(c);
      continue;
    }
    if (led && led.status === "listed") out.onAuto++;
    else if (led && led.status === "manual") out.onManual++;
  }
  out.fresh = orderCandidates(out.fresh, out.required);
  out.stale = orderCandidates(out.stale, out.required);
  return out;
}

function claimedAccount(ledgerId, cred, poolAccountId) {
  return {
    ledgerId: ledgerId ? String(ledgerId) : "",
    login: str(cred && cred.login),
    password: str(cred && cred.password),
    email: str(cred && cred.email),
    poolAccountId: str(poolAccountId),
  };
}

// One live Twitch read of a candidate; the snapshot row is refreshed from it
// either way. Passes only when the account still answers to the same login and
// holds every promised copy UNCLAIMED right now.
async function liveCheck(c, pool, required) {
  const nh = holdings();
  const cand = {
    source: "noclaim",
    login: c.login,
    clientSecret: pool.clientSecret,
    twitchId: c.twitchId,
    game: c.game,
    botId: c.botId,
    container: c.container,
    poolAccountId: c.poolAccountId,
  };
  let inv;
  try {
    inv = await ual().inventoryForCandidate(cand);
  } catch (e) {
    const error = (e && e.message) || "live read failed";
    await safely("recordRead", () => nh.recordRead(c.loginLower, { error }));
    return { ok: false, why: "live read failed" };
  }
  const sellable = (inv && inv.sellable) || [];
  await safely("recordRead", () =>
    nh.recordRead(c.loginLower, { sellable, login: inv && inv.login }),
  );
  // A renamed account is a different login to every listing guard; let the
  // refreshed snapshot bring it back under its new name instead.
  const liveLogin = str(inv && inv.login).trim().toLowerCase();
  if (liveLogin && liveLogin !== c.loginLower) return { ok: false, why: "login changed" };
  if (!covers(heldCounts(sellable), required)) return { ok: false, why: "short of the set" };
  return { ok: true, sellable };
}

// Write the claim onto the account's ledger row. Returns the commit record, or
// null when the account is not ours to take (the caller moves on).
async function commitLedger(c, ctx) {
  // 1. One account, one buyer: already on any active listing → not stock.
  const live = await ual().activeListingsForLogin(c.login);
  if (live && live.length) return null;

  const fields = {
    status: ctx.status,
    set: ctx.setId,
    market: ctx.market,
    manualListing: ctx.listingId,
    manualAt: ctx.now,
    listedAt: ctx.now,
    lastCheckedAt: ctx.now,
    drops: ctx.drops,
    emptyReads: 0,
    firstEmptyAt: null,
    note: ctx.note,
    // A claim starts a new manual life. Only markSold (a real hand-over)
    // stamps manualDeliveredAt, and spendPending only runs on rows that have
    // it — a leftover stamp on a reused row would pull a claim-at-sale
    // account out of its bot before the buyer ever got it, or never run the
    // bookkeeping at all.
    manualDeliveredAt: null,
    manualSpentAt: null,
  };
  if (ctx.status === "sold") {
    Object.assign(fields, {
      soldAt: ctx.now,
      soldMarket: ctx.market,
      // 0 = "sold, price unknown" until markSold records the real price; a
      // reused row must not carry a previous sale's price into this one.
      soldPriceUsd: 0,
    });
  }
  // Where the account lives NOW (from the snapshot the claim just verified).
  // spendAccount pulls a sold account out of `botId`'s config and stamps
  // `poolAccountId`, and every later credential read goes through that pool
  // row — a stale value on a reused row would leave the sold account farming,
  // or hand the next reader the wrong password.
  const identity = {
    login: c.login,
    twitchId: c.twitchId,
    game: ctx.game || c.game,
    poolAccountId: c.poolAccountId,
    botId: c.botId,
    container: c.container,
  };
  for (const [k, v] of Object.entries(identity)) {
    if (str(v)) fields[k] = v;
  }

  // 2. The existing ledger row, compare-and-set on the status it has. Two rows
  // for one login is ambiguous — the other row may be selling this account
  // through a path that never looks at ours — so never guess which one is real.
  const rows = await UnclaimedAccount.find({
    source: "noclaim",
    loginLower: c.loginLower,
  }).lean();
  if (rows.length > 1) return null;
  const existing = rows[0];
  if (existing) {
    if (!FREE_STATUSES.includes(existing.status)) return null;
    const $set = { ...fields, manualPriorStatus: existing.status };
    const r = await UnclaimedAccount.updateOne(
      { _id: existing._id, status: existing.status },
      { $set },
    );
    if (!r || !r.modifiedCount) return null; // someone else took it
    return { ledgerId: existing._id, status: ctx.status, created: false, prior: existing, fields: $set };
  }

  // 3. No ledger yet: create ours, then make sure nobody created one beside it
  // (a racing claimer, or the auto-lister's upsert). Losing is fine — both
  // back off and the account stays free for the next attempt.
  const doc = await UnclaimedAccount.create({
    source: "noclaim",
    loginLower: c.loginLower,
    ...fields,
    manualPriorStatus: "",
  });
  const n = await UnclaimedAccount.countDocuments({
    source: "noclaim",
    loginLower: c.loginLower,
  });
  if (n > 1) {
    await UnclaimedAccount.deleteOne({ _id: doc._id, status: ctx.status });
    return null;
  }
  return { ledgerId: doc._id, status: ctx.status, created: true, prior: null, fields };
}

// Undo a commit this call made (never anyone else's): delete the row we
// created, or write back every field we overwrote. Guarded on the status we
// wrote, so a row somebody moved on since is left alone.
async function undoCommit(commit, why) {
  if (!commit) return false;
  if (commit.created) {
    const r = await UnclaimedAccount.deleteOne({ _id: commit.ledgerId, status: commit.status });
    return !!(r && r.deletedCount);
  }
  const prior = commit.prior || {};
  const $set = {};
  for (const k of Object.keys(commit.fields || {})) {
    $set[k] = prior[k] !== undefined ? prior[k] : LEDGER_DEFAULTS[k];
  }
  $set.status = FREE_STATUSES.includes(prior.status) ? prior.status : "skipped";
  const r = await UnclaimedAccount.updateOne(
    { _id: commit.ledgerId, status: commit.status },
    { $set },
  );
  const ok = !!(r && r.modifiedCount);
  if (!ok) {
    logSafely({
      category: "noclaim_shop",
      action: "rollback_failed",
      actor: "noclaimStock",
      severity: "error",
      subject: str(prior.login),
      detail: "could not roll back a " + commit.status + " claim (" + why + ") — check the ledger by hand",
    });
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

// Free holdings that cover the set per the snapshot, ordered by
// orderCandidates. `fresh:false` adds the free-but-stale ones.
async function freeCandidates(set, { fresh = true } = {}) {
  const scan = await scanSet(set);
  if (fresh) return scan.fresh;
  return orderCandidates(scan.fresh.concat(scan.stale), scan.required);
}

// The panel's numbers for one set. Counts only; a DB error propagates rather
// than reading as an empty farm.
async function stockForSet(set) {
  const scan = await scanSet(set);
  return {
    free: scan.fresh.length,
    stale: scan.stale.length,
    onAuto: scan.onAuto,
    onManual: scan.onManual,
    covering: scan.covering,
    snapshotAt: (scan.base && scan.base.at) || null,
  };
}

// What one row may ADVERTISE. A vault row holds exactly its undelivered units.
// A claim-at-sale row gets its share of the set's free accounts (capped), split
// with the set's other live claim-at-sale rows so two markets can never both
// sell the last account.
//
// THROWS on any DB error and on a row this layer does not own: every stock
// sync treats a throw as "leave the offer alone", while a 0 takes a live offer
// off sale.
async function stockForListing(row) {
  if (!isNoclaimRow(row)) {
    throw new Error("noclaimStock.stockForListing: not a no-claim listing");
  }
  const market = str(row.marketplace).trim().toLowerCase();
  if (VAULT_MARKETS.includes(market)) {
    return (row.units || []).filter((u) => u && !u.deliveredAt).length;
  }
  if (!CLAIM_AT_SALE_MARKETS.includes(market)) {
    throw new Error("noclaimStock.stockForListing: " + (market || "?") + " is not a no-claim market");
  }
  // No set (or no longer a no-claim set) = nothing claimForSet could deliver.
  if (!row.set) return 0;
  const set = await DropSet.findById(row.set).lean();
  if (!isNoclaimSet(set)) return 0;
  const { free } = await stockForSet(set);
  const capped = Math.min(free, ADVERTISE_MAX);
  if (!capped) return 0;
  const sharers = await MarketplaceListing.find(
    {
      noclaimStock: true,
      set: row.set,
      status: "active",
      marketplace: { $in: CLAIM_AT_SALE_MARKETS.slice() },
    },
    { _id: 1 },
  )
    .sort({ _id: 1 })
    .lean();
  const ids = (sharers || []).map((r) => String(r._id)).sort();
  return shareOfShelf(capped, row._id ? String(row._id) : "", ids);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

// Claim up to `want` accounts that hold the whole set. Returns
// [{ ledgerId, login, password, email, poolAccountId }] — FEWER than asked
// when stock is short, and callers must refuse rather than part-deliver.
//   mode "fed"  — vault publish / top-up: ledger → "manual", pool row ticked
//                 "listed" so a hand bulk-copy never grabs it.
//   mode "sold" — a claim-at-sale order: ledger → "sold" at once, anchored to
//                 the order so a retry resumes instead of re-claiming. Its
//                 bookkeeping waits for markSold (the real hand-over).
//   dryRun      — the same walk and live checks, nothing committed.
async function claimForSet(set, want, opts = {}) {
  const {
    market = "",
    listingId = "",
    orderId = "",
    mode = "fed",
    dryRun = false,
  } = opts || {};
  if (!isNoclaimSet(set)) return [];
  // The kill switch. dryRun is only a read, so it still answers.
  if (!dryRun && !deliveryEnabled()) return [];
  const m = str(market).trim().toLowerCase();
  // The ledger's market enum is only enforced on create — an unknown value
  // written by updateOne would break every later save of that row.
  if (!SUPPORTED_MARKETS.includes(m)) return [];
  if (!MODES.includes(mode)) return [];
  const n = Math.min(MAX_CLAIM, Math.floor(Number(want)) || 0);
  if (n < 1) return [];
  const required = requiredFromSet(set);
  if (!required.size) return [];

  const lid = str(listingId);
  const oid = str(orderId);
  const status = mode === "sold" ? "sold" : "manual";
  const note = mode === "sold" ? orderNote(m, oid) : "manual no-claim listing — " + m;
  const setId = (set && set._id) || null;
  const out = [];

  // RESUME WHATEVER A PREVIOUS ATTEMPT ALREADY TOOK FOR THIS ORDER. The commit
  // is permanent, but the fulfiller records the order on its listing only
  // after the hand-over; a send that throws leaves the accounts sold with
  // nothing else pointing at them. Re-reading them by the order anchor makes a
  // retry re-send the SAME accounts. A committed row whose password cannot be
  // read still counts as taken: the return comes back short and the order is
  // held, rather than silently burning a replacement.
  let found = 0;
  const skipLogins = new Set();
  if (mode === "sold" && oid && !dryRun) {
    const prior = await UnclaimedAccount.find({
      source: "noclaim",
      status: "sold",
      manualListing: lid,
      note,
    })
      .sort({ soldAt: 1, _id: 1 })
      .limit(n)
      .lean();
    for (const row of prior) {
      found++;
      skipLogins.add(str(row.loginLower));
      const cred = await ual().credentialForLedger(row);
      if (!cred || !cred.login || !cred.password) {
        console.error(
          "noclaimStock: resumed ledger " + String(row._id) + " (" + m + " order " + oid + ") has no readable password",
        );
        continue;
      }
      out.push(claimedAccount(row._id, cred, row.poolAccountId));
    }
    if (found >= n) return out;
  }

  const scan = await scanSet(set);
  // Fresh reads first; stale ones still qualify because the live read below is
  // what decides, and a paid order should not wait on a snapshot's age.
  const walk = scan.fresh.concat(scan.stale);
  const norms = setGameNorms(set);
  const game = setGameLabel(set);
  const need = n - found;
  const budget = Math.max(10, n * 4);
  let reads = 0;
  let took = 0;
  const taken = [];

  for (const c of walk) {
    if (took >= need || reads >= budget) break;
    if (!c || !c.loginLower || skipLogins.has(c.loginLower)) continue;
    // A Twitch rename the snapshot already saw (row key = the config's login,
    // `login` = the live one). The engine keys its ledger and units by the live
    // name, the bot config (and so spendAccount's removal) by the old one, and
    // the buyer needs the current name — one account under two names is how a
    // login slips past every "already listed?" check. Left alone until the
    // config catches up and the sweep files it under one name.
    if (str(c.login).trim().toLowerCase() !== c.loginLower) continue;
    let commit = null;
    try {
      const pool = c.poolAccountId
        ? await AvailableAccount.findById(c.poolAccountId).lean()
        : null;
      if (poolBlockReason(pool, norms)) continue;
      const cred = await ual().credentialForLedger({
        source: "noclaim",
        login: c.login,
        poolAccountId: c.poolAccountId,
      });
      if (!cred || !cred.password) continue;

      reads++;
      const live = await liveCheck(c, pool, required);
      if (!live.ok) continue;
      if (dryRun) {
        // Reads only: what a real claim would take, never what it would skip.
        const busy = await ual().activeListingsForLogin(c.login);
        if (busy && busy.length) continue;
        const led = ledgerOf(scan.base, c.loginLower);
        out.push(claimedAccount(led && led._id, { ...cred, login: cred.login || c.login }, c.poolAccountId));
        took++;
        continue;
      }

      // The live copies of the set's items, one entry per copy.
      const drops = live.sellable
        .filter((d) => required.has(keyOfEntry(d)))
        .map((d) => ({
          name: str(d.name),
          game: str(d.game),
          campaign: str(d.campaign),
          itemKey: keyOfEntry(d),
        }));
      commit = await commitLedger(c, {
        status,
        setId,
        market: m,
        listingId: lid,
        note,
        drops,
        game,
        now: new Date(),
      });
      if (!commit) continue;

      // 4. Re-check after the commit: a listing that went live with this login
      // while we were writing (a racing auto-lister publish) wins, and ours
      // backs off.
      const again = (await ual().activeListingsForLogin(c.login)).filter(
        (r) => !lid || String(r && r._id) !== lid,
      );
      if (again.length) {
        const undo = commit;
        commit = null;
        await safely("rollback", () => undoCommit(undo, "login went on another listing"));
        continue;
      }

      const ledgerId = commit.ledgerId;
      commit = null; // handed out — never undone past this point
      out.push(claimedAccount(ledgerId, { ...cred, login: cred.login || c.login }, c.poolAccountId));
      taken.push(c.login);
      took++;
      if (mode === "fed") {
        // The no-claim console's "Listed" tick, so a hand bulk-copy never
        // grabs an account that is sitting in a vault. Cosmetic to the claim
        // itself — a failed write must not un-hand the account.
        await AvailableAccount.updateOne(
          { _id: c.poolAccountId },
          { $set: { listed: true } },
        ).catch((e) => console.error("noclaimStock pool listed flag failed:", e && e.message));
      }
    } catch (e) {
      console.error("noclaimStock claim of " + c.login + " failed:", e && e.message);
      if (commit) {
        await safely("rollback", () => undoCommit(commit, "claim error: " + ((e && e.message) || "?")));
      }
    }
  }

  if (reads) invalidateSnapshot();
  if (!dryRun && (took || found)) {
    logSafely({
      category: "noclaim_shop",
      action: "claimed",
      actor: "noclaimStock",
      severity: out.length < n ? "warn" : "info",
      subject: setId ? String(setId) : "",
      game,
      count: took,
      detail:
        mode + " claim for " + m + (oid ? " order " + oid : "") + ": " + took + " new" +
        (found ? " + " + found + " resumed" : "") + " of " + n + " wanted" +
        (taken.length ? " (" + taken.join(", ") + ")" : ""),
    });
  }
  return out;
}

// Point "manual" ledgers at the row they are units of (after the publish
// saved it, or after a rebuild moved them to a replacement row). Returns the
// number of ledgers changed.
async function attachListing(ledgerIds, listingId) {
  const ids = idList(ledgerIds);
  const lid = str(listingId);
  if (!ids.length || !lid) return 0;
  const r = await UnclaimedAccount.updateMany(
    { _id: { $in: ids }, status: "manual" },
    { $set: { manualListing: lid } },
  );
  return (r && r.modifiedCount) || 0;
}

// Hand "manual" ledgers back: to the status they had before the claim, or
// deleted when the claim created them. Only "manual" — a "sold" ledger went to
// a buyer and is never released. The caller takes the unit off the platform
// first; this only returns the account. Returns the number released.
async function releaseClaim(ledgerIds, { reason = "" } = {}) {
  const ids = idList(ledgerIds);
  if (!ids.length) return 0;
  const rows = await UnclaimedAccount.find({ _id: { $in: ids }, status: "manual" }).lean();
  const why = str(reason).trim();
  const logins = [];
  for (const l of rows) {
    let ok = false;
    try {
      if (!l.manualPriorStatus) {
        const r = await UnclaimedAccount.deleteOne({ _id: l._id, status: "manual" });
        ok = !!(r && r.deletedCount);
      } else {
        // Only a FREE status can have been the prior one (claims take nothing
        // else); anything odd falls back to "skipped", which re-lists
        // normally, rather than to "listed", which would fake an auto unit.
        const back = FREE_STATUSES.includes(l.manualPriorStatus) ? l.manualPriorStatus : "skipped";
        const r = await UnclaimedAccount.updateOne(
          { _id: l._id, status: "manual" },
          {
            $set: {
              status: back,
              manualListing: "",
              manualPriorStatus: "",
              manualAt: null,
              note: "manual listing released" + (why ? " — " + why : ""),
            },
          },
        );
        ok = !!(r && r.modifiedCount);
      }
    } catch (e) {
      console.error("noclaimStock release of " + String(l._id) + " failed:", e && e.message);
      continue;
    }
    if (!ok) continue;
    logins.push(l.login || String(l._id));
    // Clears the console's "Listed" tick unless another listed/manual ledger
    // of the same pool account still holds it.
    await safely("markOwnerUnlisted", () => ual().markOwnerUnlisted(l));
  }
  if (logins.length) {
    invalidateSnapshot();
    logSafely({
      category: "noclaim_shop",
      action: "released",
      actor: "noclaimStock",
      count: logins.length,
      detail: "released " + logins.join(", ") + (why ? " — " + why : ""),
    });
  }
  return logins.length;
}

// Record a REAL hand-over: "manual" → "sold" (a vault unit the platform sold),
// or a claim-at-sale ledger — "sold" since its claim — whose buyer now has the
// credentials. Stamps manualDeliveredAt (kept when already set), which is what
// releases the post-sale bookkeeping to spendPending: a claim-at-sale ledger is
// "sold" before the hand-over, and an order that is still being retried must
// not have its account pulled out of its bot.
//
// NEVER touches manualSpentAt. A repeat call must not re-queue a ledger whose
// bookkeeping already ran: spendAccount twice restarts the bot container for
// nothing and sends the owner a second SOLD message. For the same reason a
// repeat never wipes a recorded price, market or order anchor with blanks.
// Returns how many of the ledgers are recorded as sold by this call.
async function markSold(ledgerIds, { market = "", priceUsd = 0, reason = "", orderId = "" } = {}) {
  const ids = idList(ledgerIds);
  if (!ids.length) return 0;
  const rows = await UnclaimedAccount.find({
    _id: { $in: ids },
    status: { $in: ["manual", "sold"] },
    // This layer's rows only: a stray id must never re-price an auto-lister sale.
    manualAt: { $ne: null },
  }).lean();
  const m = str(market).trim().toLowerCase();
  const price = Math.max(0, Number(priceUsd) || 0);
  const why = str(reason).trim();
  const oid = str(orderId).trim();
  const now = new Date();
  let n = 0;
  for (const l of rows) {
    const fresh = l.status === "manual";
    const mk = m || str(l.soldMarket) || str(l.market);
    const $set = { status: "sold" };
    if (!l.soldAt) $set.soldAt = now;
    if (!l.manualDeliveredAt) $set.manualDeliveredAt = now;
    if (fresh || m) $set.soldMarket = mk;
    if (fresh || price > 0) $set.soldPriceUsd = price;
    // An orderId with no reason keeps the order's resume anchor, so a later
    // retry of that order still finds these accounts.
    const note = why || (oid ? orderNote(mk, oid) : fresh ? mk + " sale" : "");
    if (note) $set.note = note;
    try {
      const r = await UnclaimedAccount.updateOne({ _id: l._id, status: l.status }, { $set });
      if (r && (r.matchedCount || r.modifiedCount)) n++;
    } catch (e) {
      console.error("noclaimStock markSold of " + String(l._id) + " failed:", e && e.message);
    }
  }
  if (n) {
    logSafely({
      category: "noclaim_shop",
      action: "sold",
      actor: "noclaimStock",
      count: n,
      detail:
        n + " no-claim account(s) sold" + (m ? " on " + m : "") + (oid ? " (order " + oid + ")" : "") +
        (price ? " at $" + price.toFixed(2) : ""),
    });
  }
  return n;
}

// Run the post-sale bookkeeping of DELIVERED manual sales: take the account
// out of its bot, stamp the pool row, log it to the spent view
// (unclaimedAutoList.spendAccount). Oldest sale first; one failure never
// blocks the rest. Returns how many were spent.
async function spendPending({ limit = 10 } = {}) {
  const max = Math.max(1, Math.min(100, Math.floor(Number(limit)) || 10));
  // THIS layer's delivered rows only. manualDeliveredAt is stamped by markSold
  // alone, so a claim-at-sale ledger whose hand-over has not happened yet is
  // left in its bot. It also keeps out every sold ledger written before these
  // fields existed: a missing field satisfies `manualListing: {$ne: ""}` and
  // `manualSpentAt: null`, which on their own would re-spend the auto-lister's
  // whole sales history. `$gt: ""` insists on a real, non-empty listing id.
  const rows = await UnclaimedAccount.find({
    source: "noclaim",
    status: "sold",
    manualListing: { $gt: "" },
    manualDeliveredAt: { $ne: null },
    manualSpentAt: null,
  })
    .sort({ soldAt: 1, _id: 1 })
    .limit(max)
    .lean();
  let spent = 0;
  for (const l of rows) {
    // The stamp goes on FIRST, as a lease: a timer pass and a manual "run"
    // must never spend the same account twice. A spend that throws hands the
    // lease back so the next pass retries it.
    const stamp = new Date();
    let leased;
    try {
      leased = await UnclaimedAccount.updateOne(
        { _id: l._id, status: "sold", manualSpentAt: null },
        { $set: { manualSpentAt: stamp } },
      );
    } catch (e) {
      console.error("noclaimStock spend lease of " + String(l._id) + " failed:", e && e.message);
      continue;
    }
    if (!leased || !leased.modifiedCount) continue;
    try {
      await ual().spendAccount(l, l.note || "manual listing sale", {
        priceUsd: l.soldPriceUsd,
        market: l.soldMarket,
        removeFromProduct: false,
        label: "manual no-claim listing",
      });
      spent++;
    } catch (e) {
      console.error("noclaimStock spend of " + (l.login || String(l._id)) + " failed:", e && e.message);
      await safely("spend lease return", () =>
        UnclaimedAccount.updateOne(
          { _id: l._id, manualSpentAt: stamp },
          { $set: { manualSpentAt: null } },
        ),
      );
    }
  }
  return spent;
}

// The account's no-claim ledger row (lean), or null.
async function ledgerForLogin(login) {
  const l = str(login).trim().toLowerCase();
  if (!l) return null;
  return (await UnclaimedAccount.findOne({ source: "noclaim", loginLower: l }).lean()) || null;
}

module.exports = {
  // constants
  FREE_STATUSES,
  COMMITTED_STATUSES,
  VAULT_MARKETS,
  CLAIM_AT_SALE_MARKETS,
  SUPPORTED_MARKETS,
  ADVERTISE_MAX,
  MAX_CLAIM,
  MARKET_LABELS,
  // pure, tested
  isNoclaimSet,
  isNoclaimRow,
  itemKeyOf,
  requiredFromSet,
  heldCounts,
  covers,
  extraLoad,
  orderCandidates,
  requiredDropsForSet,
  rowFields,
  unsupportedMessage,
  deliveryEnabled,
  poolBlockReason,
  orderNote,
  // reads
  freeCandidates,
  stockForSet,
  stockForListing,
  // writes
  claimForSet,
  attachListing,
  releaseClaim,
  markSold,
  spendPending,
  ledgerForLogin,
};
