// Bulk packs — the maintenance loop (docs/bulk-packs/CONTRACT.md I1–I13,
// MODULES.md §loop.js).
//
// It LOOKS AFTER live bulk offers and never publishes one: Send is always an
// owner click (§2). Each pass visits every open offer, plus every closed one
// that still has units on their way back to stock:
//
//   dropset eldorado/g2g  reconcile reserved[] with the row, count sales,
//                         retire unhealthy units, pause + retire a sold-out
//                         offer (fewer free than one pack), keep the advertised
//                         quantity equal to the whole packs the free units
//                         make, notice an expired offer (every 30 min)
//   dropset gameflip      finalise a sold pack, retire a removed/delisted one,
//                         withdraw a pack holding an unhealthy account (I9)
//   noclaim               notice a dead row, count sales, flag low stock
//                         (display only — the no-claim syncs own the quantity)
//   farm                  pause when its share of the rent-farm capacity
//                         cannot fill one pack, resume an offer IT paused once
//                         it can (never while bulk packs are switched off, I8),
//                         keep the quantity equal to the packs its share makes,
//                         count sales from FarmServiceOrder, notice expiry
//
// WHY THE ROW IS NEVER WHOLE-ARRAY SAVED (I3)
// The fulfillers load a MarketplaceListing, spend seconds on the marketplace,
// then save the WHOLE units array back. Anything written to that array in
// between is lost — or, for a unit we just took off, silently put back. So the
// row is only ever touched with an atomic $push or a conditional $pull, and
// BulkOffer.reserved[] is the authority: every pass compares the two and heals
// the row (a lost unit is pushed back, a unit that came back is pulled again),
// never the other way round.
//
// WHY A RETIRED UNIT WAITS FIFTEEN MINUTES (I10, FIXES-1 L2)
// A unit we pull may be exactly the one a fulfiller is delivering from its
// in-memory copy; its save then puts the unit back carrying deliveredAt /
// orderId. So release is two-phase: phase 1 takes the unit off the row and
// marks it "retiring"; phase 2, on a later pass at least RETIRE_GRACE_MS after
// the last change, re-reads the row — back and FREE: pull again and restart the
// clock; back and not FREE: it SOLD ("delivered", never released); still absent:
// release the reservation (I1) and mark it "released". Two minutes proved too
// short (review repro F-D: a slow chat send outlived it), and a closed offer is
// still watched for WATCH_WINDOW_MS afterwards: a released account that comes
// back SOLD is recorded, re-reserved and always reported.
//
// ONE WRITER AT A TIME (FIXES-1 L3, FIXES-2 V2)
// Every pass over an offer, and the owner's take-out, runs inside the offer's
// lock and re-reads the offer there; send.js does the same. The few decisions
// that would undo an owner action (the clobber heal, a release) re-read their
// entry once more right before they write. The pass never WAITS for a lock
// (lock.tryWithOfferLock): an offer a send or an owner action holds is skipped
// and counted "busy" — one slow publish used to stall every other offer's
// sold-out, expiry and integrity work. Each offer gets its own clock (the
// pass's `now` plus the real time the pass has run) and a fresh settings read.
//
// FARM CAPACITY IS ONE SHARED POOL (FIXES-1 S1, FIXES-2 V1)
// Every open farm offer (sending, live or paused — the list send.js counts)
// advertises only its share. When a farm send or resume finishes, send.js
// calls resplitFarm(), which syncs every farm offer at once — shrinking ones
// first — instead of leaving the others on their old, larger share until their
// next farmSyncMinutes sync.
//
// ONE LISTING = ONE PACK (docs/bulk-packs/PACKS-2.md §1, §4)
// A bulk listing is one item priced as a whole pack of N accounts, so what the
// MARKET counts (quantity, units bought) is packs, while everything the loop
// reserves, retires or releases is an account. The advertised quantity is
// packsFor(free accounts, N) — utils/bulkPacks/packMath.js, the one place a pack
// is converted; nothing here multiplies. Fewer than N free accounts is sold
// out: a partial pack can never sell, so the leftovers go back (two-phase). A
// farm offer's capacity share (accounts) is advertised as packs too, and a
// no-claim offer is low on stock when its share cannot fill one pack.
//
// Nothing FREE (I2: no deliveredAt, messagedAt or orderId) is ever assumed sold,
// and nothing that is not FREE is ever released or pulled.

const { OPEN_STATES } = require("./config");
// Pure (no I/O): the pack maths every bulk-pack module shares (PACKS-2 §1).
const { packsFor, packSizeOf } = require("./packMath");

const ACTOR = "bulkPacks";
const FIRST_DELAY_MS = 120 * 1000;
// Phase 2 of I10: how long a retired unit must stay off the row before its
// reservation is handed back (FIXES-1 L2).
const RETIRE_GRACE_MS = 15 * 60 * 1000;
// A closed dropset offer is still visited this long after it closed (and after
// its latest release), so an account delivered after we released it is caught
// (FIXES-1 L2).
const WATCH_WINDOW_MS = 24 * 60 * 60 * 1000;
const READ_OFFER_EVERY_MS = 30 * 60 * 1000;
// A send that has not finished in this long has died (the server restarted
// mid-send). Its reservations are left alone — the market may hold a live offer
// with no row — and the owner is told once.
const STUCK_SENDING_MS = 15 * 60 * 1000;
const OFFER_LIMIT = 500;
const FARM_ORDER_LIMIT = 500;

// Two separate fields (FIXES-1 L8). `lastError` carries a "Loop:" error, which
// clears itself on the next clean pass (and never overwrites another writer's
// message). `attention` carries a "Needs attention (key):" flag, raised once
// (one Telegram) and cleared only by the check that raised it, so a standing
// problem never re-pages every pass — and a loop error in between can no
// longer wipe it or make it page again.
const LOOP_ERROR_PREFIX = "Loop: ";
const FLAG_RE = /^Needs attention \(([a-z]+)\): /;
// Why an entry the owner took out is leaving the pack (FIXES-1 L1).
const TAKEN_OUT = "taken out by the owner";

const MARKET_LABELS = {
  eldorado: "Eldorado",
  g2g: "G2G",
  gameflip: "Gameflip",
};
// The row fields the loop reads — never the whole document.
const ROW_FIELDS = {
  set: 1,
  marketplace: 1,
  externalId: 1,
  status: 1,
  units: 1,
  bulkOfferId: 1,
  bulkPackSize: 1,
  noclaimStock: 1,
  title: 1,
};
const HOLDING_STATES = ["on_offer", "retiring", "delivered"];
// The farm offers that share the rent-farm capacity: every OPEN one (sending,
// live, paused) — the same query send.js's farmShareFor uses (FIXES-2 V1).
const farmSharers = () => ({ source: "farm", open: true });
// States in which WE took an offer off sale (paused, or closed with its stock
// going back). A market read that says "active" for one of them is paused
// again at that read (FIXES-2 V3). Not "error": a held offer whose publish
// outcome is unknown is the owner's to settle, and not "sold".
const QUIET_STATES = ["paused", "sold_out", "withdrawn", "expired"];

// A settings read that fails must not stop the SAFETY maintenance, and must not
// open anything either: switched off, so nothing is resumed or grown.
const SAFE_BP = Object.freeze({
  enabled: false,
  markets: [],
  tiers: [],
  reserveSingles: 5,
  unitsPerOffer: 20,
  farmPrices: {},
  farmDurations: [],
  farmReserveSlots: 20,
  farmReservePristine: 20,
  farmMaxQty: 20,
  loopMinutes: 5,
  farmSyncMinutes: 15,
});

// ---------------------------------------------------------------------------
// Lazy dependencies (CONTRACT §9)
// ---------------------------------------------------------------------------
let over = {};
const deps = {
  get BulkOffer() {
    return over.BulkOffer || require("../../models/BulkOffer");
  },
  get MarketplaceListing() {
    return (
      over.MarketplaceListing || require("../../models/MarketplaceListing")
    );
  },
  get FarmServiceOrder() {
    return over.FarmServiceOrder || require("../../models/FarmServiceOrder");
  },
  get DropSet() {
    return over.DropSet || require("../../models/DropSet");
  },
  get settings() {
    return over.settings || require("../settings");
  },
  get config() {
    return over.config || require("./config");
  },
  get stock() {
    return over.stock || require("./stock");
  },
  get farmCapacity() {
    return over.farmCapacity || require("./farmCapacity");
  },
  get markets() {
    return over.markets || require("./markets");
  },
  get noclaimStock() {
    return over.noclaimStock || require("../noclaimStock");
  },
  get telegram() {
    return over.telegram || require("../telegram");
  },
  get systemLog() {
    return over.systemLog || require("../systemLog");
  },
  get proposals() {
    return over.proposals || require("./proposals");
  },
  get lock() {
    return over.lock || require("./lock");
  },
  get dropReservation() {
    return over.dropReservation || require("../dropReservation");
  },
  get suppliedStock() {
    return over.suppliedStock || require("../suppliedStock");
  },
};
function __setDeps(partial) {
  over = {
    ...over,
    ...(partial && typeof partial === "object" ? partial : {}),
  };
}
function __resetDeps() {
  over = {};
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const str = (v) => (v == null ? "" : String(v));
const errText = (e) => str((e && e.message) || e) || "unknown error";
const label = (m) => MARKET_LABELS[m] || str(m) || "?";
const round2 = (n) => {
  const x = Math.round((Number(n) || 0) * 100) / 100;
  return Number.isFinite(x) ? x : 0;
};
const money = (n) => "$" + round2(n).toFixed(2);
function ms(d) {
  if (!d) return null;
  const t = new Date(d).getTime();
  return Number.isFinite(t) ? t : null;
}
function asDate(d) {
  const t = ms(d);
  return t == null ? new Date() : new Date(t);
}
function due(last, everyMs, now) {
  const t = ms(last);
  return t == null || now.getTime() - t >= everyMs;
}
function describe(offer) {
  const t = str(offer && offer.title);
  return (
    '"' +
    (t.length > 100 ? t.slice(0, 99) + "…" : t) +
    '" on ' +
    label(offer && offer.market)
  );
}
// PACKS-2 §1: N, the accounts ONE unit bought on the market hands over. A
// row-backed offer (dropset, no-claim) is sized by its tier (minQty, the pack
// it was sent as) AND by its row (packMath.packSizeOf — what the fulfiller
// multiplies by). The two are written equal at send; should they ever
// disagree, the LARGER is used, so the packs advertised can never ask the
// fulfiller for more accounts than the offer holds under either reading. A
// farm offer has no row: its N is minQty.
function packSize(offer, row) {
  const m = Math.floor(Number(offer && offer.minQty));
  const tier = Number.isFinite(m) && m >= 1 ? m : 1;
  return row ? Math.max(tier, packSizeOf(row)) : tier;
}

// Every market sells a whole pack at the pack price (PACKS-2 §3); the
// per-account figure rides along. An offer with no pack price recorded shows
// its per-account price.
function priceText(offer) {
  const n = packSize(offer, null);
  const pack = Number(offer.packPrice) || 0;
  const unit = Number(offer.unitPrice) || 0;
  if (offer.market === "gameflip" || (pack > 0 && !(unit > 0)))
    return money(pack) + " per pack of " + n;
  if (pack > 0)
    return money(pack) + " per pack of " + n + " (≈ " + money(unit) + " each)";
  return money(unit) + " each, in packs of " + n;
}

// What the sales so far brought in: packs × the pack price (PACKS-2 §3). An
// offer with no pack price recorded falls back to accounts × its per-account
// price. Money only — the pack→account conversion is packMath's.
function revenueOf(offer, packs, accounts) {
  const pack = Number(offer.packPrice) || 0;
  return pack > 0
    ? round2(packs * pack)
    : round2(accounts * (Number(offer.unitPrice) || 0));
}

// CONTRACT I2.
function isFree(u) {
  return !!u && !u.deliveredAt && !u.messagedAt && !u.orderId;
}

function unitsById(row) {
  const map = new Map();
  for (const u of (row && row.units) || []) {
    const id = u && str(u.accountId);
    if (!id) continue;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(u);
  }
  return map;
}

// On_offer entries whose unit is on the row and FREE — what the offer can
// still sell. reserved[] is the authority: a free unit on the row that no
// on_offer entry claims is never counted, so the advertised quantity can only
// ever be smaller than what the fulfiller can hand over.
function freeOnOffer(offer, row) {
  const byId = unitsById(row);
  const out = [];
  const seen = new Set();
  for (const e of (offer && offer.reserved) || []) {
    if (!e || e.state !== "on_offer") continue;
    const id = str(e.accountId);
    if (!id || seen.has(id)) continue;
    const copies = byId.get(id) || [];
    if (!copies.length || copies.some((u) => !isFree(u))) continue;
    seen.add(id);
    out.push({ accountId: id, login: str(e.login) || str(copies[0].login) });
  }
  return out;
}

function hist(action, detail, at) {
  return { at, action, detail: str(detail).slice(0, 300), actor: ACTOR };
}

// Telegram, fire-and-forget: never awaited without a catch (I13), never able to
// slow or break a pass.
function notify(text) {
  try {
    const p = deps.telegram.sendTelegram(text);
    if (p && typeof p.catch === "function") {
      p.catch((e) => console.error("bulkPacks telegram failed:", errText(e)));
    }
  } catch (e) {
    console.error("bulkPacks telegram failed:", errText(e));
  }
}

// Audit (I13). SystemEvent keeps human text in `detail`; `message` is passed
// too, as the contract names it (the schema simply ignores the extra key).
function audit(offer, action, severity, message, extra = {}) {
  try {
    const p = deps.systemLog.logEvent({
      category: "bulk",
      action,
      severity,
      actor: ACTOR,
      message,
      detail: message,
      subject: str(offer && offer.title).slice(0, 200),
      subjectId: offer && offer._id ? offer._id : undefined,
      game: str(offer && offer.game),
      count: Number(extra.count) || 0,
      meta: {
        offerId: offer && offer._id ? String(offer._id) : "",
        market: offer ? offer.market : "",
        source: offer ? offer.source : "",
        state: offer ? offer.state : "",
        ...(extra.meta || {}),
      },
    });
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {
    /* audit is best-effort */
  }
}

function invalidateProposals() {
  try {
    const p = deps.proposals;
    if (p && typeof p.invalidate === "function") p.invalidate();
  } catch {
    /* no proposals module loaded: its own 5-minute cache runs out instead */
  }
}

function readBp() {
  try {
    const bp = deps.settings.getBulkPacks();
    if (bp && typeof bp === "object") return bp;
  } catch (e) {
    console.error(
      "bulkPacks: settings unreadable, running switched off:",
      errText(e),
    );
  }
  return { ...SAFE_BP };
}

function safeGate(market, source) {
  try {
    const g = deps.config.currentGate(market, source);
    return g && g.ok === true
      ? g
      : { ok: false, reason: str(g && g.reason) || "gate closed" };
  } catch (e) {
    return { ok: false, reason: errText(e) };
  }
}

async function readOfferSafe(offer) {
  if (!str(offer.externalId)) return { state: "unknown" };
  try {
    const r = await deps.markets.readOffer(offer.market, offer.externalId);
    return {
      state: str(r && r.state) || "unknown",
      quantity: r ? r.quantity : null,
    };
  } catch {
    // A failed read is "unknown", never "gone" or "expired".
    return { state: "unknown" };
  }
}

// ---------------------------------------------------------------------------
// BulkOffer writes (our own document — still atomic: send.js writes it too)
// ---------------------------------------------------------------------------

// One reserved entry, matched by account AND its current state so a
// concurrent writer's change is never overwritten.
async function setEntryWhere(offer, match, patch) {
  const $set = {};
  for (const [k, v] of Object.entries(patch)) $set["reserved.$." + k] = v;
  const r = await deps.BulkOffer.updateOne(
    { _id: offer._id, reserved: { $elemMatch: match } },
    { $set },
  );
  return !!(r && r.modifiedCount);
}

async function setEntry(offer, entry, fromState, patch) {
  const ok = await setEntryWhere(
    offer,
    { accountId: str(entry.accountId), state: fromState },
    patch,
  );
  if (ok) Object.assign(entry, patch);
  return ok;
}

// A state change, conditional on the state we read, with `open` / `closedAt`
// written alongside (§5) and a history line.
async function transition(
  offer,
  to,
  { from, set = {}, now, detail = "", action } = {},
) {
  const at = asDate(now);
  const open = OPEN_STATES.includes(to);
  const $set = { ...set, state: to, open };
  if (!open) $set.closedAt = offer.open ? at : offer.closedAt || at;
  const r = await deps.BulkOffer.updateOne(
    { _id: offer._id, state: { $in: from || [offer.state] } },
    { $set, $push: { history: hist(action || to, detail, at) } },
  );
  if (!r || !r.modifiedCount) return false;
  Object.assign(offer, $set);
  return true;
}

// The API calls below are not conditional, so re-check the offer is still in
// the state the pass read before growing or resuming anything: the owner may
// have paused or withdrawn it a moment ago.
async function stillIn(offer, states, extra = {}) {
  const hit = await deps.BulkOffer.exists({
    _id: offer._id,
    state: { $in: states },
    ...extra,
  });
  return !!hit;
}

// FIXES-1 L8: a flag lives in `attention` and is deduped on it, so a loop
// error written to `lastError` in between neither wipes it nor re-pages it.
async function raiseFlag(offer, key, text, { telegram = true } = {}) {
  const msg = ("Needs attention (" + key + "): " + text).slice(0, 500);
  if (str(offer.attention) === msg) return false;
  await deps.BulkOffer.updateOne(
    { _id: offer._id },
    { $set: { attention: msg } },
  );
  offer.attention = msg;
  audit(offer, "attention_" + key, "warn", text);
  if (telegram)
    notify("Bulk packs — needs attention: " + describe(offer) + "\n\n" + text);
  return true;
}

async function clearFlag(offer, key) {
  const m = FLAG_RE.exec(str(offer.attention));
  if (!m || m[1] !== key) return;
  await deps.BulkOffer.updateOne(
    { _id: offer._id, attention: offer.attention },
    { $set: { attention: "" } },
  );
  offer.attention = "";
}

// `lastError` only (L8). Never over another writer's message: send.js leaves
// the reason an offer closed there (e.g. "publish outcome unknown — may be
// live …"), and a loop error must not hide it; the heartbeat, the audit log and
// status().lastError still carry the loop's error.
// offerId -> the loop error last logged for it, so a standing error on an
// offer whose lastError belongs to another writer is not re-logged every pass.
const noted = new Map();
async function noteLoopError(offer, text) {
  const msg = (LOOP_ERROR_PREFIX + text).slice(0, 500);
  const id = String(offer._id);
  // Logged and audited when it CHANGES; a standing error shows in the
  // heartbeat's error count and in status().lastError instead.
  if (str(offer.lastError) === msg || noted.get(id) === msg) return;
  noted.set(id, msg);
  console.error("bulkPacks: offer " + id + ": " + text);
  try {
    const r = await deps.BulkOffer.updateOne(
      {
        _id: offer._id,
        $or: [
          { lastError: { $in: ["", null] } },
          { lastError: { $regex: /^Loop: / } },
        ],
      },
      { $set: { lastError: msg } },
    );
    if (r && r.modifiedCount) offer.lastError = msg;
  } catch {
    /* the heartbeat still counts it */
  }
  audit(offer, "loop_error", "warn", text);
}

// One reserved entry as it is in the database NOW (FIXES-1 L3): the pass's own
// copy was read when the pass took the lock, and a decision that would undo an
// owner action must not rest on it. `null` when no entry of this account is in
// that state any more.
async function freshEntry(offer, accountId, state) {
  const doc = await deps.BulkOffer.findOne(
    {
      _id: offer._id,
      reserved: { $elemMatch: { accountId: str(accountId), state } },
    },
    { "reserved.$": 1 },
  ).lean();
  return doc && Array.isArray(doc.reserved) && doc.reserved[0]
    ? doc.reserved[0]
    : null;
}

// Counters only ever grow ($max): a unit lost from the row by a concurrent save
// must not un-count a sale, and a repeated pass must not re-announce one.
// `s.units` is ACCOUNTS handed over; `s.packs` (with `s.packSize`) the whole
// packs they make, which the revenue is counted from (PACKS-2 §3).
async function countSales(offer, s, ctx, { revenue, quiet = false } = {}) {
  const orders = Math.max(0, Math.floor(Number(s.orders) || 0));
  const units = Math.max(0, Math.floor(Number(s.units) || 0));
  const size = Math.floor(Number(s.packSize));
  const n = Number.isFinite(size) && size >= 2 ? size : 0;
  const packs =
    s.packs == null ? null : Math.max(0, Math.floor(Number(s.packs) || 0));
  const rev = round2(
    revenue != null
      ? revenue
      : packs != null
        ? revenueOf(offer, packs, units)
        : units * (Number(offer.unitPrice) || 0),
  );
  const before = {
    orders: Number(offer.ordersCount) || 0,
    units: Number(offer.unitsDelivered) || 0,
    revenue: Number(offer.revenueUsd) || 0,
  };
  if (orders <= before.orders && units <= before.units && rev <= before.revenue)
    return;
  const dOrders = Math.max(0, orders - before.orders);
  const dUnits = Math.max(0, units - before.units);
  // "(P pack(s) of N)" beside the accounts, for an offer sold in packs.
  const packNote = (p) => (n ? " (" + p + " pack(s) of " + n + ")" : "");
  const newPacks = n
    ? "+" + Math.max(0, packsFor(units, n) - packsFor(before.units, n))
    : "";
  const update = {
    $max: {
      ordersCount: orders,
      unitsDelivered: units,
      revenueUsd: rev,
      lastOrderAt: s.lastOrderAt || ctx.now,
    },
  };
  if (dOrders > 0) {
    update.$push = {
      history: hist(
        "sale",
        "+" +
          dOrders +
          " order(s), +" +
          dUnits +
          " account(s)" +
          packNote(newPacks),
        ctx.now,
      ),
    };
  }
  await deps.BulkOffer.updateOne({ _id: offer._id }, update);
  offer.ordersCount = Math.max(before.orders, orders);
  offer.unitsDelivered = Math.max(before.units, units);
  offer.revenueUsd = Math.max(before.revenue, rev);
  if (dOrders > 0) {
    ctx.summary.sold += dOrders;
    const text =
      "+" +
      dOrders +
      " order(s), +" +
      dUnits +
      " account(s)" +
      packNote(newPacks) +
      " — total " +
      offer.ordersCount +
      " order(s), " +
      offer.unitsDelivered +
      " account(s)" +
      packNote(n ? packsFor(offer.unitsDelivered, n) : 0) +
      ", " +
      money(offer.revenueUsd);
    audit(offer, "sale", "info", "bulk sale: " + text, { count: dUnits });
    if (!quiet)
      notify(
        "Bulk sale: " +
          describe(offer) +
          " (" +
          priceText(offer) +
          ")\n" +
          text,
      );
  } else if (dUnits > 0) {
    audit(offer, "delivered", "info", dUnits + " more account(s) delivered", {
      count: dUnits,
    });
  }
}

// ---------------------------------------------------------------------------
// Row writes (I3: atomic $push / conditional $pull only, and only on OUR row)
// ---------------------------------------------------------------------------

// I2 as a $pull condition. `orderId` matches "" or null/missing, the same
// "no order" the FREE test reads, so a unit written without the field can
// still be taken off.
function freeUnitMatch(accountId) {
  return {
    accountId: str(accountId),
    deliveredAt: null,
    messagedAt: null,
    orderId: { $in: ["", null] },
  };
}

async function pullFree(offer, rowId, accountId) {
  const r = await deps.MarketplaceListing.updateOne(
    { _id: rowId, bulkOfferId: offer._id },
    { $pull: { units: freeUnitMatch(accountId) } },
  );
  return !!(r && r.modifiedCount);
}

// Put a unit a concurrent save dropped back on the row — only on an active row,
// and only if it is not already there (a fulfiller's save may have restored it
// in the meantime).
async function pushUnit(offer, rowId, entry, at) {
  const id = str(entry.accountId);
  const r = await deps.MarketplaceListing.updateOne(
    {
      _id: rowId,
      bulkOfferId: offer._id,
      status: "active",
      "units.accountId": { $ne: id },
    },
    {
      $push: {
        units: {
          contentId: "",
          accountId: id,
          login: str(entry.login),
          addedAt: at,
          deliveredAt: null,
          orderId: "",
          messagedAt: null,
        },
      },
    },
  );
  return !!(r && r.modifiedCount);
}

async function loadRow(offer, at) {
  const ML = deps.MarketplaceListing;
  let pointed = null;
  if (offer.listing) {
    pointed = await ML.findById(offer.listing, ROW_FIELDS).lean();
    if (pointed && str(pointed.bulkOfferId) === str(offer._id))
      return { row: pointed };
  }
  // The pointer is missing or wrong: a crash between the row create and the
  // offer update leaves the row carrying our bulkOfferId with nothing pointing
  // at it. Treating that as "row missing" would release units that are on sale.
  const mine = await ML.find({ bulkOfferId: offer._id }, ROW_FIELDS)
    .limit(2)
    .lean();
  if (mine.length > 1) {
    return {
      row: null,
      problem:
        "two listing rows point at this offer (" +
        mine.map((r) => String(r._id)).join(", ") +
        ") — nothing was changed; settle them by hand",
    };
  }
  if (mine.length === 1) {
    await deps.BulkOffer.updateOne(
      { _id: offer._id },
      {
        $set: { listing: mine[0]._id },
        $push: {
          history: hist(
            "relinked",
            "listing row " + mine[0]._id + " found by its bulkOfferId",
            at,
          ),
        },
      },
    );
    offer.listing = mine[0]._id;
    return { row: mine[0] };
  }
  if (pointed) {
    return {
      row: null,
      problem:
        "its listing row " +
        pointed._id +
        " does not point back at it (bulkOfferId) — " +
        "nothing was changed; fix the row by hand",
    };
  }
  return { row: null };
}

async function rereadRow(offer, row) {
  const fresh = await deps.MarketplaceListing.findById(
    row._id,
    ROW_FIELDS,
  ).lean();
  return fresh && str(fresh.bulkOfferId) === str(offer._id) ? fresh : row;
}

async function setFor(offer, opts) {
  const id = str(offer.set);
  if (!id) return null;
  const cache = opts && opts.sets instanceof Map ? opts.sets : null;
  if (cache && cache.has(id)) return cache.get(id);
  const set = (await deps.DropSet.findById(offer.set).lean()) || null;
  if (cache) cache.set(id, set);
  return set;
}

// ---------------------------------------------------------------------------
// Phase 1 and phase 2 of CONTRACT I10
// ---------------------------------------------------------------------------

// Phase 1: take FREE on_offer units off the row and mark them "retiring". The
// caller has already paused or re-quantified the offer. Write-ahead order: the
// entry is marked first, then the unit pulled, so a crash in between leaves a
// retiring entry whose unit is still on the row — the next reconcile pulls it
// again — never a unit gone from the row that reserved[] still calls on sale.
// A unit that is not FREE (per the caller's row, or the conditional $pull) is
// never pulled; if it sold, the next reconcile records it as delivered.
// Returns how many entries it moved (the contract's `void` callers ignore it).
// Flag entries whose account the owner spent elsewhere, so their release
// (phase 2) keeps the reservation instead of handing it back.
async function markKeep(offer, accountIds) {
  let n = 0;
  for (const id of [...new Set((accountIds || []).map(str).filter(Boolean))]) {
    const e = (offer.reserved || []).find(
      (x) =>
        x &&
        str(x.accountId) === id &&
        (x.state === "on_offer" || x.state === "retiring"),
    );
    if (!e || e.keepReserved) continue;
    if (
      await setEntryWhere(
        offer,
        { accountId: id, state: e.state },
        { keepReserved: true },
      )
    ) {
      e.keepReserved = true;
      n++;
    }
  }
  return n;
}

async function retireUnits(offer, row, accountIds, reason, { now } = {}) {
  const at = asDate(now);
  const ids = [...new Set((accountIds || []).map(str).filter(Boolean))];
  if (!ids.length || !offer) return 0;
  const byId = unitsById(row);
  const moved = [];
  for (const id of ids) {
    const e = (offer.reserved || []).find(
      (x) => x && str(x.accountId) === id && x.state === "on_offer",
    );
    if (!e) continue; // not ours to retire
    if ((byId.get(id) || []).some((u) => !isFree(u))) continue; // already sold
    if (
      !(await setEntry(offer, e, "on_offer", {
        state: "retiring",
        changedAt: at,
        reason: str(reason),
      }))
    ) {
      continue;
    }
    if (row && row._id) await pullFree(offer, row._id, id);
    moved.push(str(e.login) || id);
  }
  if (moved.length) {
    await deps.BulkOffer.updateOne(
      { _id: offer._id },
      {
        $push: {
          history: hist(
            "units_retiring",
            moved.length +
              " unit(s) (" +
              reason +
              "): " +
              moved.slice(0, 10).join(", ") +
              (moved.length > 10 ? " …" : ""),
            at,
          ),
        },
      },
    );
    audit(
      offer,
      "units_retiring",
      "info",
      moved.length + " unit(s) retiring: " + reason,
      {
        count: moved.length,
        meta: { logins: moved.slice(0, 50) },
      },
    );
  }
  return moved.length;
}

// Phase 2 release of one entry (I1). Write-ahead again: the entry is marked
// "released" BEFORE the reservation is handed back, so a crash between the two
// leaks one reservation (safe) rather than letting a later pass release an
// account somebody else has reserved since (a double sale). Returns true when
// the entry left our hands.
async function releaseEntry(offer, e, why, at, opts, out) {
  const id = str(e.accountId);
  const from = e.state;
  // FIXES-1 L3: keepReserved is read from the database here, never taken from
  // the pass's copy — an owner take-out may have set it since.
  const now = await freshEntry(offer, id, from);
  if (!now) return false; // it moved on under us: the next pass reads it
  if (now.keepReserved === true) e.keepReserved = true;
  // The owner spent this account elsewhere (hand sale, renter): it has left
  // the pack, but its reservation is kept — never handed back (keepReserved).
  const keep = async () => {
    const kept = await setEntry(offer, e, from, {
      state: "released",
      changedAt: at,
      reason: ("kept reserved (not handed back): " + why).slice(0, 300),
    });
    if (kept) {
      audit(
        offer,
        "release_kept",
        "info",
        (e.login || id) +
          " left the pack; its reservation is kept (" +
          why +
          ")",
      );
    }
    return kept;
  };
  if (e.keepReserved) return keep();
  // Only possible if the reservation was already handed back and re-taken by
  // another bulk offer — releasing now would free THAT offer's account.
  const held = await deps.BulkOffer.exists({
    _id: { $ne: offer._id },
    reserved: { $elemMatch: { accountId: id, state: { $in: HOLDING_STATES } } },
  });
  if (held) {
    const ok = await setEntry(offer, e, from, {
      state: "released",
      changedAt: at,
      reason: "not released: bulk offer " + held._id + " holds this account",
    });
    if (ok) {
      audit(
        offer,
        "release_skipped",
        "warn",
        (e.login || id) + " is held by bulk offer " + held._id,
        {
          meta: { other: String(held._id) },
        },
      );
    }
    return ok;
  }
  const set = await setFor(offer, opts);
  if (!set) {
    out.errors.push(
      "DropSet " +
        str(offer.set) +
        " is missing — " +
        (e.login || id) +
        " cannot be released",
    );
    return false;
  }
  const pending = "releasing: " + why;
  // Conditional on keepReserved still being unset, so a take-out that lands
  // between the read above and this write can never be released over.
  const marked = {
    state: "released",
    changedAt: at,
    reason: pending,
  };
  if (
    !(await setEntryWhere(
      offer,
      { accountId: id, state: from, keepReserved: { $ne: true } },
      marked,
    ))
  ) {
    const again = await freshEntry(offer, id, from);
    if (again && again.keepReserved === true) {
      e.keepReserved = true;
      return keep();
    }
    return false;
  }
  Object.assign(e, marked);
  let res;
  try {
    res = await deps.stock.releaseUnits({
      set,
      market: offer.market,
      accountIds: [id],
    });
  } catch (err) {
    const back = {
      state: "retiring",
      changedAt: at,
      reason: ("release failed (" + errText(err) + "): " + why).slice(0, 300),
    };
    await setEntryWhere(
      offer,
      { accountId: id, state: "released", reason: pending },
      back,
    );
    Object.assign(e, back);
    out.errors.push(
      "release of " + (e.login || id) + " failed: " + errText(err),
    );
    return false;
  }
  // stock.releaseUnits parks read errors in `failed` (safe to retry): nothing
  // was released, so the unit goes back to retiring and the next pass tries
  // again instead of reading it as done and stranding the reservation.
  const failed = ((res && res.failed) || []).find(
    (f) => f && str(f.accountId != null ? f.accountId : f) === id,
  );
  if (failed) {
    const why2 =
      (failed && failed.reason) || (failed && failed.error) || "read failed";
    const back = {
      state: "retiring",
      changedAt: at,
      reason: ("release will retry (" + errText(why2) + "): " + why).slice(
        0,
        300,
      ),
    };
    await setEntryWhere(
      offer,
      { accountId: id, state: "released", reason: pending },
      back,
    );
    Object.assign(e, back);
    out.errors.push(
      "release of " + (e.login || id) + " will retry: " + errText(why2),
    );
    return false;
  }
  const skipped = ((res && res.skipped) || []).find(
    (s) => s && str(s.accountId) === id,
  );
  const done = ((res && res.released) || []).some((x) => str(x) === id);
  const reason = skipped
    ? "not ours" +
      (skipped.reason && skipped.reason !== "not ours"
        ? ": " + skipped.reason
        : "")
    : done
      ? why
      : "released (unconfirmed): " + why;
  await setEntryWhere(
    offer,
    { accountId: id, state: "released", reason: pending },
    { reason },
  );
  e.reason = reason;
  return true;
}

async function writeNotes(offer, notes, at) {
  const lines = [
    ["units_delivered", notes.delivered, "sold", "info"],
    [
      "units_readded",
      notes.readded,
      "put back on the row (a concurrent save dropped them)",
      "warn",
    ],
    [
      "units_repulled",
      notes.repulled,
      "came back FREE and were taken off again",
      "warn",
    ],
    [
      "units_retiring",
      notes.retired,
      "left the row — on their way back to stock",
      "info",
    ],
    ["units_released", notes.released, "released back to stock", "info"],
    [
      "units_duplicate",
      notes.duplicates,
      "had a FREE copy of a SOLD unit — copy pulled",
      "warn",
    ],
    [
      "units_zombie",
      notes.zombies || [],
      "were back on the row after their release — copy pulled",
      "warn",
    ],
  ].filter(([, list]) => list.length);
  if (!lines.length) return;
  const text = (list, verb) =>
    list.length +
    " unit(s) " +
    verb +
    ": " +
    list.slice(0, 10).join(", ") +
    (list.length > 10 ? " …" : "");
  await deps.BulkOffer.updateOne(
    { _id: offer._id },
    {
      $push: {
        history: {
          $each: lines.map(([action, list, verb]) =>
            hist(action, text(list, verb), at),
          ),
        },
      },
    },
  );
  for (const [action, list, verb, severity] of lines) {
    audit(offer, action, severity, text(list, verb), {
      count: list.length,
      meta: { logins: list.slice(0, 50) },
    });
  }
}

// A sale of an account the owner had taken out of the pack (keepReserved): it
// did not leave in time, so the buyer got an account the owner also spent
// elsewhere. Always reported.
async function ownerTakenDelivered(offer, e, orderId, at) {
  const name = str(e.login) || str(e.accountId);
  const text =
    name +
    " was " +
    TAKEN_OUT +
    " but a pack buyer received it (order " +
    (str(orderId) || "no order id") +
    ") — check it is not sold twice";
  await deps.BulkOffer.updateOne(
    { _id: offer._id },
    { $push: { history: hist("owner_taken_delivered", text, at) } },
  );
  audit(offer, "owner_taken_delivered", "error", text, {
    meta: { accountId: str(e.accountId), login: str(e.login), orderId },
  });
  notify("Bulk packs — " + text + "\n" + describe(offer));
}

// FIXES-1 L2: an account we RELEASED shows up SOLD on our row — a fulfiller
// delivered it from a copy of the row it read before the unit was pulled. It
// is recorded delivered, re-reserved for the set so nobody else sells it, and
// ALWAYS reported: it may already have been sold a second time.
async function deliveredAfterRelease(offer, e, orderId, at, opts, out) {
  const id = str(e.accountId);
  const name = str(e.login) || id;
  let result;
  let rereserved = false;
  if (e.keepReserved) {
    result = "its reservation was never handed back (the owner took it out)";
  } else {
    const set = await setFor(offer, opts);
    if (!set) {
      result = "NOT re-reserved: its DropSet is missing";
    } else {
      try {
        rereserved = !!(await deps.dropReservation.reserveSetOnAccount(
          id,
          set,
          { soldToUsername: offer.market, soldSetId: String(set._id) },
        ));
        result = rereserved
          ? "re-reserved for this set"
          : "NOT re-reserved: its drops are no longer free (reserved or redeemed elsewhere)";
      } catch (err) {
        result = "NOT re-reserved: " + errText(err);
        out.errors.push("re-reserve of " + name + " failed: " + errText(err));
      }
    }
  }
  const order = str(orderId) || "no order id";
  const moved = await setEntry(offer, e, "released", {
    state: "delivered",
    orderId: str(orderId),
    changedAt: at,
    reason: ("delivered after release (order " + order + "); " + result).slice(
      0,
      300,
    ),
  });
  const text =
    "released account " +
    name +
    " was delivered after release — check it is not sold twice (order " +
    order +
    "; " +
    result +
    ")";
  await deps.BulkOffer.updateOne(
    { _id: offer._id },
    { $push: { history: hist("delivered_after_release", text, at) } },
  );
  audit(offer, "delivered_after_release", "error", text, {
    meta: { accountId: id, login: str(e.login), orderId, rereserved },
  });
  notify("Bulk packs — " + text + "\n" + describe(offer));
  return moved;
}

// Reconcile reserved[] (the authority) with the row, per MODULES §loop and
// FIXES-1 L1–L3:
//   on_offer  on the row, not FREE           -> delivered
//             on the row, FREE               -> on sale, nothing to do
//             absent, row active, offer open -> put back (only while the
//                                               reservation is still ours and
//                                               the owner has not taken it out:
//                                               read fresh, L3)
//             absent otherwise               -> retiring
//   retiring  on the row, not FREE           -> delivered (it sold)
//             on the row, FREE               -> pulled again, clock restarts
//             absent >= RETIRE_GRACE_MS      -> released (I1)
//   released  on the row, not FREE           -> delivered AFTER release:
//                                               re-reserved, always reported (L2)
//             on the row, FREE               -> pulled again (a zombie), never
//                                               released a second time
//             (only an account's LATEST entry: an older released entry of an
//             account the offer took back since is history)
//   no row at all -> OPEN offer: nothing can sell these units, released now
//             (I1). CLOSED offer: never a direct release — retiring entries
//             wait out RETIRE_GRACE_MS as usual.
//   CLOSED offer: an on_offer entry is HELD (a publish whose outcome is
//             unknown may be live, FIXES-1 S2/S5 + addendum). The loop only
//             records its sale; it is never retired, released, pulled or put
//             back — the owner's release-held marks it retiring.
// A sold Gameflip pack counts every unit delivered: the code on the listing
// held them all. Returns {delivered, released, readded, repulled}; `errors`
// and `rowChanged` ride along non-enumerably.
async function reconcileUnits(offer, row, now = new Date(), opts = {}) {
  const at = asDate(now);
  const out = { delivered: 0, released: 0, readded: 0, repulled: 0 };
  Object.defineProperty(out, "errors", { value: [], enumerable: false });
  Object.defineProperty(out, "rowChanged", {
    value: false,
    enumerable: false,
    writable: true,
  });
  const all = ((offer && offer.reserved) || []).filter(
    (e) => e && str(e.accountId),
  );
  const live = all.filter(
    (e) => e.state === "on_offer" || e.state === "retiring",
  );
  const latest = new Map();
  for (const e of all) latest.set(str(e.accountId), e);
  const watched = row
    ? all.filter(
        (e) => e.state === "released" && latest.get(str(e.accountId)) === e,
      )
    : [];
  if (!live.length && !watched.length) return out;
  const notes = {
    delivered: [],
    readded: [],
    repulled: [],
    retired: [],
    released: [],
    duplicates: [],
    zombies: [],
  };
  const who = (e) => str(e.login) || str(e.accountId);

  if (!row && offer.open) {
    // An OPEN offer with no row: no fulfiller can deliver these units, so
    // they go back at once (the caller takes the market offer down).
    for (const e of live) {
      if (
        await releaseEntry(offer, e, "the listing row is gone", at, opts, out)
      ) {
        out.released++;
        notes.released.push(who(e));
      }
    }
    await writeNotes(offer, notes, at);
    return out;
  }
  if (!row) {
    // A CLOSED offer with no row: never a direct release (FIXES-1 addendum).
    // Its on_offer entries are HELD; a retiring one follows the normal two
    // phases — absent, so released once RETIRE_GRACE_MS has passed.
    for (const e of live) {
      if (e.state !== "retiring") continue;
      const since = ms(e.changedAt);
      if (since == null) {
        await setEntry(offer, e, "retiring", { changedAt: at });
        continue;
      }
      if (at.getTime() - since < RETIRE_GRACE_MS) continue;
      if (
        await releaseEntry(offer, e, str(e.reason) || "retired", at, opts, out)
      ) {
        out.released++;
        notes.released.push(who(e));
      }
    }
    await writeNotes(offer, notes, at);
    return out;
  }

  const byId = unitsById(row);
  const packSold = offer.market === "gameflip" && row.status === "sold";
  const rowActive = row.status === "active";
  for (const e of live) {
    const id = str(e.accountId);
    const copies = byId.get(id) || [];
    const taken = copies.find((u) => !isFree(u));
    const freeCopies = copies.filter(isFree);

    if (taken || packSold) {
      const patch = {
        state: "delivered",
        orderId: taken ? str(taken.orderId) : "gf:" + str(offer.externalId),
        changedAt: at,
        reason: taken ? "sold on the listing" : "Gameflip pack sold",
      };
      if (await setEntry(offer, e, e.state, patch)) {
        out.delivered++;
        notes.delivered.push(who(e));
        if (e.keepReserved)
          await ownerTakenDelivered(offer, e, patch.orderId, at);
      }
      // A FREE copy of an account that has already sold must never stay on sale.
      if (taken && freeCopies.length && (await pullFree(offer, row._id, id))) {
        out.rowChanged = true;
        notes.duplicates.push(who(e));
      }
      continue;
    }

    if (e.state === "on_offer") {
      // HELD (FIXES-1 addendum): an on_offer entry of a CLOSED offer is never
      // retired, released, pulled or put back by the loop — its publish may
      // be live with no way for us to know. Only a sale (above) is recorded;
      // the owner's release-held marks it retiring.
      if (!offer.open) continue;
      if (freeCopies.length) continue; // on sale, as it should be
      if (rowActive && offer.open) {
        // L3: putting it back would undo an owner take-out that landed after
        // this pass read the offer, so the entry is read again first.
        const cur = await freshEntry(offer, id, "on_offer");
        if (!cur) continue; // it moved on under us: the next pass reads it
        if (cur.keepReserved === true) {
          e.keepReserved = true;
          // L1: the owner took it out and it is off the row already. A
          // Gameflip member stays on_offer: its account is in the pack's code,
          // so maintainGameflip takes the whole pack down instead.
          if (offer.market === "gameflip") continue;
          if (
            await setEntry(offer, e, "on_offer", {
              state: "retiring",
              changedAt: at,
              reason: TAKEN_OUT,
            })
          ) {
            notes.retired.push(who(e));
          }
          continue;
        }
        const set = await setFor(offer, opts);
        const ours = set
          ? await deps.stock.isStillOurs({
              accountId: id,
              set,
              market: offer.market,
            })
          : false;
        if (ours) {
          if (await pushUnit(offer, row._id, e, at)) {
            out.readded++;
            out.rowChanged = true;
            notes.readded.push(who(e));
          }
          continue;
        }
        const why = set
          ? "missing from the row and no longer reserved to this offer"
          : "missing from the row (its DropSet is gone)";
        if (
          await setEntry(offer, e, "on_offer", {
            state: "retiring",
            changedAt: at,
            reason: why,
          })
        ) {
          notes.retired.push(who(e));
        }
        continue;
      }
      if (
        await setEntry(offer, e, "on_offer", {
          state: "retiring",
          changedAt: at,
          reason: "not on the listing row",
        })
      ) {
        notes.retired.push(who(e));
      }
      continue;
    }

    // retiring
    if (freeCopies.length) {
      // A stale whole-array save put it back. Take it off again and restart the
      // clock whether or not this pull landed: something is still moving.
      if (await pullFree(offer, row._id, id)) out.rowChanged = true;
      if (await setEntry(offer, e, "retiring", { changedAt: at })) {
        out.repulled++;
        notes.repulled.push(who(e));
      }
      continue;
    }
    const since = ms(e.changedAt);
    if (since == null) {
      // No clock yet (a writer forgot changedAt): start it, never release blind.
      await setEntry(offer, e, "retiring", { changedAt: at });
      continue;
    }
    if (at.getTime() - since < RETIRE_GRACE_MS) continue;
    if (
      await releaseEntry(offer, e, str(e.reason) || "retired", at, opts, out)
    ) {
      out.released++;
      notes.released.push(who(e));
    }
  }

  // L2: the watch on accounts already handed back.
  for (const e of watched) {
    const id = str(e.accountId);
    const copies = byId.get(id) || [];
    // An order an earlier "delivered" entry of the same account already
    // accounts for is not a delivery after this release.
    const accounted = new Set(
      all
        .filter(
          (x) => x !== e && x.state === "delivered" && str(x.accountId) === id,
        )
        .map((x) => str(x.orderId)),
    );
    const taken = copies.find(
      (u) => !isFree(u) && !accounted.has(str(u.orderId)),
    );
    if (taken || packSold) {
      const orderId = taken
        ? str(taken.orderId)
        : "gf:" + str(offer.externalId);
      if (await deliveredAfterRelease(offer, e, orderId, at, opts, out)) {
        out.delivered++;
        notes.delivered.push(who(e));
      }
      continue;
    }
    // Back FREE: a stale whole-array save put a released account on sale
    // again. Off the row, and never released a second time.
    if (copies.some(isFree) && (await pullFree(offer, row._id, id))) {
      out.rowChanged = true;
      notes.zombies.push(who(e));
    }
  }
  await writeNotes(offer, notes, at);
  return out;
}

// ---------------------------------------------------------------------------
// Per-kind maintenance
// ---------------------------------------------------------------------------

function salesFromUnits(row, mode) {
  let units = 0;
  let last = null;
  const orders = new Set();
  for (const u of (row && row.units) || []) {
    if (!u) continue;
    // dropset: not FREE (I2) — the same test that makes reserved[] say
    // "delivered", so the last G2G order of a sold-out offer (orderId stamped,
    // chat send pending) is counted before the offer closes and stops being
    // visited. noclaim: deliveredAt or orderId (MODULES §loop).
    const sold =
      mode === "noclaim" ? !!(u.deliveredAt || u.orderId) : !isFree(u);
    if (!sold) continue;
    units++;
    orders.add(
      u.orderId
        ? "o:" + u.orderId
        : "u:" +
            (str(u.accountId) || str(u.contentId) || str(u.login) || units),
    );
    for (const t of [u.deliveredAt, u.messagedAt]) {
      const x = ms(t);
      if (x != null && (last == null || x > last)) last = x;
    }
  }
  return {
    units,
    orders: orders.size,
    lastOrderAt: last == null ? null : new Date(last),
  };
}

// The whole packs of N that the accounts counted in `s` make (PACKS-2 §3:
// revenue is per pack).
function withPacks(s, n) {
  return { ...s, packs: packsFor(s.units, n), packSize: n };
}

async function missingRow(offer, ctx, job) {
  const now = ctx.now;
  if (!offer.open) {
    // Closed. Only what somebody RETIRED goes back, after the usual grace —
    // every path that retires a unit takes its listing down first (send's
    // withdraw and release-held included). An on_offer entry of a closed
    // offer is HELD: a publish whose outcome is unknown may be live with no
    // row (FIXES-1 S2/S5 + addendum), and the owner releases it after
    // checking the marketplace. Never a direct release here.
    const entries = (offer.reserved || []).filter((e) => e && str(e.accountId));
    if (
      offer.source === "dropset" &&
      entries.some((e) => e.state === "retiring")
    ) {
      const rec = await reconcileUnits(offer, null, now, { sets: ctx.sets });
      ctx.summary.released += rec.released;
      job.errors.push(...rec.errors);
    }
    if (
      offer.market === "gameflip" &&
      entries.some((e) => e.state === "on_offer") &&
      !["withdrawn", "expired"].includes(offer.state)
    ) {
      // Only a pack we know was taken down (withdrawn / expired) may give its
      // accounts back without a row to read.
      await raiseFlag(
        offer,
        "row",
        "the listing row is missing and the pack was never withdrawn (" +
          offer.state +
          ") — nothing was released; check the Gameflip listing by hand",
      );
    }
    return;
  }
  if (offer.market === "gameflip") {
    // The pack's code rides on the Gameflip listing itself: withdraw it FIRST
    // (I9) and hand the accounts back only once that has worked.
    try {
      await deps.markets.withdraw("gameflip", offer.externalId);
    } catch (e) {
      await raiseFlag(
        offer,
        "row",
        "the listing row is missing and the Gameflip withdraw failed (" +
          errText(e) +
          ") — it may have sold; nothing was released",
      );
      return;
    }
  }
  // Eldorado/G2G: with no row, no fulfiller can deliver these units, so they
  // are safe to hand back whether or not the pause below lands.
  if (offer.source === "dropset") {
    const rec = await reconcileUnits(offer, null, now, { sets: ctx.sets });
    ctx.summary.released += rec.released;
    job.errors.push(...rec.errors);
  }
  if (!offer.open) return;
  if (offer.market !== "gameflip") {
    try {
      await deps.markets.pause(offer.market, offer.externalId);
    } catch (e) {
      await raiseFlag(
        offer,
        "row",
        "the listing row is missing and the offer could not be paused on " +
          label(offer.market) +
          " (" +
          errText(e) +
          ") — a sale there cannot be delivered; take it down by hand",
      );
      return;
    }
  }
  const closedWith = "listing row missing — offer taken down";
  if (
    await transition(offer, "error", {
      from: ["live", "paused"],
      set: { lastError: closedWith, autoPaused: false },
      now,
      action: "orphan",
      detail: closedWith,
    })
  ) {
    ctx.changed = true;
    audit(offer, "orphan", "error", closedWith);
    notify(
      "Bulk offer orphaned: " +
        describe(offer) +
        "\nIts listing row is missing, so no sale could be " +
        "delivered. The offer was taken down" +
        (offer.source === "dropset"
          ? " and its accounts are going back to stock."
          : "."),
    );
  }
}

// Sold out (PACKS-2 §4): fewer than N good accounts left — a partial pack can
// never sell. The offer is paused FIRST, then the leftovers go back through
// phase 1 of I10.
async function soldOut(offer, row, free, bad, ctx, n) {
  const good = free.length - bad.length;
  if (offer.state === "live") {
    // Throws on failure: nothing is retired while the offer may still sell.
    await deps.markets.pause(offer.market, offer.externalId);
  }
  const badIds = new Set(bad.map((b) => b.accountId));
  await retireBad(offer, row, bad, ctx);
  await retireUnits(
    offer,
    row,
    free.filter((u) => !badIds.has(u.accountId)).map((u) => u.accountId),
    "sold out: " + good + " free < one pack of " + n,
    { now: ctx.now },
  );
  const detail =
    good +
    " free < one pack of " +
    n +
    "; " +
    free.length +
    " unit(s) retiring";
  if (
    await transition(offer, "sold_out", {
      from: ["live", "paused"],
      set: { advertisedQty: 0, autoPaused: false },
      now: ctx.now,
      detail,
    })
  ) {
    ctx.changed = true;
    audit(offer, "sold_out", "info", "sold out: " + detail, {
      count: free.length,
    });
    notify(
      "Bulk offer sold out: " +
        describe(offer) +
        "\n" +
        good +
        " account(s) left — less than one pack of " +
        n +
        ". The offer is paused; " +
        free.length +
        " account(s) go back to stock" +
        (bad.length ? " (" + bad.length + " failed their health check)" : "") +
        ".\nSold: " +
        (Number(offer.ordersCount) || 0) +
        " order(s), " +
        (Number(offer.unitsDelivered) || 0) +
        " account(s).",
    );
  }
  // A closed offer's row is not a live listing any more.
  await deps.MarketplaceListing.updateOne(
    { _id: row._id, bulkOfferId: offer._id, status: "active" },
    { $set: { status: "delisted" } },
  );
}

async function retireBad(offer, row, bad, ctx) {
  await markKeep(
    offer,
    bad.filter((b) => b && b.keepReserved).map((b) => b.accountId),
  );
  const byReason = new Map();
  for (const b of bad) {
    const r = str(b.reason) || "failed its health check";
    if (!byReason.has(r)) byReason.set(r, []);
    byReason.get(r).push(b.accountId);
  }
  let n = 0;
  for (const [reason, ids] of byReason) {
    n += await retireUnits(
      offer,
      row,
      ids,
      reason === TAKEN_OUT ? TAKEN_OUT : "health: " + reason,
      { now: ctx.now },
    );
  }
  return n;
}

// Unhealthy units among `ids`. A failed health read is a soft error for the
// pass, never a reason to skip the sold-out and quantity checks behind it.
async function healthOf(ids, job) {
  if (!ids.length) return [];
  let health;
  try {
    health = await deps.stock.unitHealth(ids);
  } catch (e) {
    job.errors.push("health check failed: " + errText(e));
    return [];
  }
  const out = [];
  for (const id of ids) {
    const h =
      health && typeof health.get === "function" ? health.get(id) : null;
    // Unknown is not bad: only an explicit ok:false retires a unit.
    if (h && h.ok === false) {
      out.push({
        accountId: id,
        reason: str(h.reason),
        keepReserved: !!h.keepReserved,
      });
    }
  }
  return out;
}

// Keep the advertised quantity — whole PACKS (PACKS-2 §4) — equal to what can
// be delivered. Shrinking is safety and always runs; growing is selling more,
// so it needs bulk packs on (I8) and the delivery gate open (I4).
async function syncQuantity(offer, q, ctx) {
  const cur = Number(offer.advertisedQty) || 0;
  if (q === cur) return;
  if (q > cur) {
    if (ctx.bp.enabled !== true) return;
    if (!safeGate(offer.market, offer.source).ok) return;
  }
  if (!(await stillIn(offer, ["live"]))) return;
  await deps.markets.setQuantity(offer.market, offer.externalId, q);
  await deps.BulkOffer.updateOne(
    { _id: offer._id },
    { $set: { advertisedQty: q } },
  );
  offer.advertisedQty = q;
  audit(
    offer,
    "quantity",
    "info",
    "advertised quantity " + cur + " -> " + q + " pack(s)",
    { count: q },
  );
}

async function expireAccountsOffer(offer, row, ctx) {
  const r = await deps.MarketplaceListing.updateOne(
    { _id: row._id, bulkOfferId: offer._id, status: "active" },
    {
      $set: {
        status: "removed",
        lastError: "bulk packs: offer expired on " + label(offer.market),
      },
    },
  );
  if (!r || !r.modifiedCount) return; // the row moved on its own; the next pass reads it
  const gone = { ...row, status: "removed" };
  const n = await retireUnits(
    offer,
    gone,
    freeOnOffer(offer, gone).map((u) => u.accountId),
    "offer expired",
    {
      now: ctx.now,
    },
  );
  if (
    await transition(offer, "expired", {
      now: ctx.now,
      detail: "expired on " + label(offer.market),
    })
  ) {
    ctx.changed = true;
    audit(offer, "expired", "info", "offer expired on " + label(offer.market), {
      count: n,
    });
    notify(
      "Bulk offer expired: " +
        describe(offer) +
        "\n" +
        n +
        " account(s) go back to stock.",
    );
  }
}

// The row went inactive under an open offer: close the offer, and take its
// FREE units back through phase 1. Eldorado/G2G fulfillers find a row by the
// offer id whatever its status, so unless the row says the offer is gone
// ("removed") the market offer is paused FIRST (I10 phase 1) — a pause that
// fails throws, and nothing is retired while it may still sell.
async function closeForRow(offer, row, ctx) {
  const to = row.status === "removed" ? "expired" : "withdrawn";
  const why = "the listing row is " + row.status;
  const hasUnits = (offer.reserved || []).some(
    (e) => e && e.state === "on_offer",
  );
  if (
    offer.source === "dropset" &&
    offer.market !== "gameflip" &&
    row.status !== "removed" &&
    hasUnits
  ) {
    await deps.markets.pause(offer.market, offer.externalId);
  }
  const n = await retireUnits(
    offer,
    row,
    freeOnOffer(offer, row).map((u) => u.accountId),
    why,
    {
      now: ctx.now,
    },
  );
  if (await transition(offer, to, { now: ctx.now, detail: why })) {
    ctx.changed = true;
    audit(offer, to, "info", "offer " + to + ": " + why, { count: n });
    notify(
      "Bulk offer " +
        to +
        ": " +
        describe(offer) +
        "\n" +
        why +
        (n ? "; " + n + " account(s) go back to stock." : "."),
    );
  }
}

async function readExpiry(offer, ctx, job) {
  if (!due(offer.lastCheckAt, READ_OFFER_EVERY_MS, ctx.now)) return "";
  job.patch.lastCheckAt = ctx.now;
  const seen = await readOfferSafe(offer);
  if (seen.state === "gone") {
    // Not acted on: releasing stock on a wrong "gone" would put the same
    // accounts on sale twice. The owner decides.
    await raiseFlag(
      offer,
      "gone",
      label(offer.market) +
        " no longer knows this offer — check it and withdraw it by hand",
    );
  } else if (seen.state === "active" || seen.state === "paused") {
    await clearFlag(offer, "gone");
  }
  if (seen.state === "active") await repauseIfActive(offer, ctx, job);
  return seen.state;
}

// FIXES-2 V3: the market says "active" for an offer WE took off sale (paused,
// sold out, withdrawn, expired) — something put it back on sale behind our back
// (the Eldorado keep-alive's pause+resume racing our pause, a hand relist). A
// buyer there would be sold stock that is on its way back to the shelf, so it
// is paused again at that read, with a history line, an audit event and a
// Telegram. Eldorado/G2G only (a Gameflip pack has no pause and reads
// "unknown"). A pause that fails is a loop error and the market is read again
// on the next pass instead of in half an hour. Returns true when it paused.
async function repauseIfActive(offer, ctx, job) {
  if (!QUIET_STATES.includes(offer.state)) return false;
  if (offer.market !== "eldorado" && offer.market !== "g2g") return false;
  // This very pass paused it: the read right behind that pause is lag.
  if (job.pausedNow) return false;
  const where = label(offer.market);
  try {
    await deps.markets.pause(offer.market, offer.externalId);
  } catch (e) {
    delete job.patch.lastCheckAt;
    job.errors.push(
      where +
        " shows this " +
        offer.state +
        " offer ACTIVE and pausing it again failed: " +
        errText(e),
    );
    return false;
  }
  const text =
    where +
    " showed the offer active while it is " +
    offer.state +
    " here — paused it again";
  await deps.BulkOffer.updateOne(
    { _id: offer._id },
    { $push: { history: hist("repaused", text, ctx.now) } },
  );
  audit(offer, "repaused", "warn", text);
  notify(
    "Bulk offer paused again: " +
      describe(offer) +
      "\n" +
      text +
      ". Check " +
      where +
      " for an order placed while it was on sale.",
  );
  return true;
}

// FIXES-2 V3: a CLOSED dropset offer is still watched for WATCH_WINDOW_MS after
// it closed (FIXES-1 L2); the market read (every READ_OFFER_EVERY_MS) is part of
// that watch, so an offer we closed that comes back on sale is paused again.
// Only the "gone"/"expired" handling of an open offer is not repeated here — a
// closed offer has nothing left to take down.
async function watchClosedMarket(offer, ctx, job) {
  if (offer.open || !QUIET_STATES.includes(offer.state)) return;
  if (offer.market !== "eldorado" && offer.market !== "g2g") return;
  const closed = ms(offer.closedAt);
  if (closed == null || ctx.now.getTime() - closed > WATCH_WINDOW_MS) return;
  if (!due(offer.lastCheckAt, READ_OFFER_EVERY_MS, ctx.now)) return;
  job.patch.lastCheckAt = ctx.now;
  const seen = await readOfferSafe(offer);
  if (seen.state === "active") await repauseIfActive(offer, ctx, job);
}

async function maintainDropset(offer, ctx, job) {
  const closed = !offer.open;
  await maintainDropsetRow(offer, ctx, job);
  // FIXES-2 V3: inside its watch window a closed offer's market is read too.
  if (closed) await watchClosedMarket(offer, ctx, job);
}

async function maintainDropsetRow(offer, ctx, job) {
  const { row, problem } = await loadRow(offer, ctx.now);
  if (problem) {
    await raiseFlag(offer, "row", problem);
    return;
  }
  if (!row) return missingRow(offer, ctx, job);
  await clearFlag(offer, "row");
  job.patch.lastSyncAt = ctx.now;

  const rec = await reconcileUnits(offer, row, ctx.now, { sets: ctx.sets });
  ctx.summary.released += rec.released;
  job.errors.push(...rec.errors);
  const cur = rec.rowChanged ? await rereadRow(offer, row) : row;

  if (offer.market === "gameflip")
    return maintainGameflip(offer, cur, ctx, job);

  // PACKS-2 §4: the market sells whole packs of n accounts.
  const n = packSize(offer, cur);
  await countSales(offer, withPacks(salesFromUnits(cur, "dropset"), n), ctx);
  // Closed: the reconcile above finished its retiring units and watched its
  // released ones; an on_offer entry left on a closed offer is HELD and only
  // the owner's release-held lets it go (FIXES-1 addendum).
  if (!offer.open) return;
  if (cur.status !== "active") return closeForRow(offer, cur, ctx);
  if ((await readExpiry(offer, ctx, job)) === "expired")
    return expireAccountsOffer(offer, cur, ctx);

  const free = freeOnOffer(offer, cur);
  // L1: an account the owner took out (keepReserved) that is still FREE on the
  // row must leave the pack — every pass, like an unhealthy one: the quantity
  // drops first, then it is retired (a no-op while it is not FREE).
  const keepIds = new Set(
    (offer.reserved || [])
      .filter((e) => e && e.state === "on_offer" && e.keepReserved === true)
      .map((e) => str(e.accountId)),
  );
  const bad = [
    ...free
      .filter((u) => keepIds.has(u.accountId))
      .map((u) => ({
        accountId: u.accountId,
        reason: TAKEN_OUT,
        keepReserved: true,
      })),
    ...(await healthOf(
      free.filter((u) => !keepIds.has(u.accountId)).map((u) => u.accountId),
      job,
    )),
  ];
  const good = free.length - bad.length;
  // A partial pack can never sell: fewer than n good accounts is sold out, and
  // the leftovers go back (PACKS-2 §4). Otherwise the market is offered the
  // whole packs they make; any extra accounts stay on the row for the next
  // pack (a refill completes it, or they go back once the offer sells out).
  if (good < n) return soldOut(offer, cur, free, bad, ctx, n);
  const packs = packsFor(good, n);
  if (bad.length) {
    // Shrink what is advertised BEFORE the units leave the row (I10 phase 1).
    if (offer.state === "live" && Number(offer.advertisedQty) > packs) {
      await deps.markets.setQuantity(offer.market, offer.externalId, packs);
      await deps.BulkOffer.updateOne(
        { _id: offer._id },
        { $set: { advertisedQty: packs } },
      );
      offer.advertisedQty = packs;
    }
    const retired = await retireBad(offer, cur, bad, ctx);
    if (retired) {
      const list = bad.map(
        (b) =>
          (free.find((u) => u.accountId === b.accountId) || {}).login +
          " (" +
          b.reason +
          ")",
      );
      audit(
        offer,
        "integrity_retired",
        "warn",
        retired + " unhealthy unit(s) retired: " + list.join(", "),
        { count: retired },
      );
      notify(
        "Bulk offer integrity: " +
          describe(offer) +
          "\n" +
          retired +
          " account(s) taken off the offer: " +
          list.slice(0, 10).join(", ") +
          ". " +
          good +
          " still on sale (" +
          packs +
          " pack(s) of " +
          n +
          ").",
      );
    }
    return;
  }
  if (offer.state === "live") await syncQuantity(offer, packs, ctx);
}

async function maintainGameflip(offer, row, ctx, job) {
  if (row.status === "sold") {
    // reconcileUnits has already marked every unit delivered.
    const n =
      (offer.reserved || []).filter((e) => e && e.state === "delivered")
        .length ||
      Number(offer.minQty) ||
      0;
    await countSales(
      offer,
      { orders: 1, units: n, lastOrderAt: ctx.now },
      ctx,
      {
        revenue: Number(offer.packPrice) || 0,
        quiet: true,
      },
    );
    if (offer.state !== "sold") {
      const was = offer.state;
      const from = [
        "live",
        "paused",
        "sold_out",
        "withdrawn",
        "expired",
        "error",
      ];
      if (
        await transition(offer, "sold", {
          from,
          now: ctx.now,
          detail: "Gameflip pack sold",
        })
      ) {
        ctx.changed = true;
        audit(
          offer,
          "sold",
          "info",
          "Gameflip pack sold (" + n + " accounts)",
          { count: n },
        );
        notify(
          "Bulk pack sold: " +
            describe(offer) +
            "\n" +
            n +
            " accounts for " +
            money(offer.packPrice) +
            "." +
            (OPEN_STATES.includes(was)
              ? ""
              : "\nNote: it sold after the offer was marked " + was + "."),
        );
      }
    }
    return;
  }
  const members = (offer.reserved || []).filter(
    (e) => e && e.state === "on_offer" && str(e.accountId),
  );
  // L1: a member the owner took out (keepReserved) must leave the pack, and a
  // Gameflip pack only leaves whole — so it is a bad member, every pass, until
  // the withdraw has worked.
  const takenOut = members
    .filter((e) => e.keepReserved === true)
    .map((e) => ({
      accountId: str(e.accountId),
      reason: TAKEN_OUT,
      keepReserved: true,
    }));
  // Closed: every close path retires the pack's members itself, so an on_offer
  // entry left on a closed pack is HELD — only the owner's release-held lets
  // it go (FIXES-1 addendum; I9).
  if (!offer.open) return;
  if (row.status === "removed" || row.status === "delisted")
    return closeForRow(offer, row, ctx);
  if (row.status !== "active") {
    // "error" or anything else: the listing may still be purchasable, and its
    // code names every account. Nothing is released on a guess (I9).
    await raiseFlag(
      offer,
      "row",
      'the listing row is "' +
        row.status +
        '" — check the Gameflip listing by hand; nothing was released',
    );
    return;
  }

  const bad = [
    ...takenOut,
    ...(await healthOf(
      members
        .filter((e) => e.keepReserved !== true)
        .map((e) => str(e.accountId)),
      job,
    )),
  ];
  if (!bad.length) {
    await clearFlag(offer, "withdraw");
    return;
  }
  await withdrawPack(offer, row, bad, ctx);
}

// Take a Gameflip pack down because of `bad` members (I9): the withdraw FIRST;
// only once it has worked is the row marked delisted and every member retired
// (the ones the owner took out keep their reservation). A failed withdraw
// leaves everything as it is — the pack may have sold — and raises the
// "withdraw" flag once; the next pass tries again (FIXES-1 L1). The flag is
// cleared once the pack is down and no taken-out member is left on offer.
// Returns true when the pack was taken down.
async function withdrawPack(offer, row, bad, ctx) {
  const reasons = [...new Set(bad.map((b) => str(b.reason) || "unhealthy"))];
  const why = reasons.join("; ");
  const ownerOnly = reasons.every((r) => r === TAKEN_OUT);
  const lead = ownerOnly
    ? "an account the owner took out is still in the pack"
    : "a pack account failed its health check (" + why + ")";
  if (!str(offer.externalId)) {
    await raiseFlag(
      offer,
      "withdraw",
      lead + " but the pack has no Gameflip listing id — take it down by hand",
    );
    return false;
  }
  try {
    await deps.markets.withdraw("gameflip", offer.externalId);
  } catch (e) {
    // It may have sold in the meantime: leave it, the Gameflip sync decides.
    await raiseFlag(
      offer,
      "withdraw",
      lead +
        " but the Gameflip withdraw failed (" +
        errText(e) +
        ") — it may have sold; check it by hand",
    );
    return false;
  }
  const r = await deps.MarketplaceListing.updateOne(
    { _id: row._id, bulkOfferId: offer._id, status: "active" },
    { $set: { status: "delisted" } },
  );
  if (!r || !r.modifiedCount) return false; // the row moved (sold?) — the next pass reads it
  const gone = { ...row, status: "delisted" };
  const keptIds = bad
    .filter((b) => b && b.keepReserved)
    .map((b) => str(b.accountId));
  await markKeep(offer, keptIds);
  const members = (offer.reserved || [])
    .filter((e) => e && e.state === "on_offer" && str(e.accountId))
    .map((e) => str(e.accountId));
  const n = await retireUnits(offer, gone, members, "pack withdrawn: " + why, {
    now: ctx.now,
  });
  if (
    !(offer.reserved || []).some(
      (e) => e && e.state === "on_offer" && e.keepReserved === true,
    )
  ) {
    await clearFlag(offer, "withdraw");
  }
  const kept = new Set(keptIds).size;
  if (
    offer.open &&
    (await transition(offer, "withdrawn", {
      now: ctx.now,
      detail: (ownerOnly ? "" : "unhealthy account: ") + why,
    }))
  ) {
    ctx.changed = true;
    audit(
      offer,
      ownerOnly ? "owner_withdrawn" : "integrity_withdrawn",
      "warn",
      "pack withdrawn: " + why,
      { count: n },
    );
    notify(
      (ownerOnly
        ? "Bulk pack withdrawn: "
        : "Bulk pack withdrawn (integrity): ") +
        describe(offer) +
        "\n" +
        why +
        ". " +
        Math.max(0, n - kept) +
        " account(s) go back to stock" +
        (kept ? "; " + kept + " spent elsewhere stay reserved." : "."),
    );
  }
  return true;
}

async function maintainNoclaim(offer, ctx, job) {
  const { row, problem } = await loadRow(offer, ctx.now);
  if (problem) {
    await raiseFlag(offer, "row", problem);
    return;
  }
  if (!row) return missingRow(offer, ctx, job);
  await clearFlag(offer, "row");
  job.patch.lastSyncAt = ctx.now;
  const n = packSize(offer, row);
  await countSales(offer, withPacks(salesFromUnits(row, "noclaim"), n), ctx);
  if (!offer.open) return;
  if (row.status !== "active") return closeForRow(offer, row, ctx);
  // Display only (MODULES §loop): the existing no-claim syncs own the quantity
  // (they advertise packsFor(share, N) themselves, PACKS-2 §2). Low stock =
  // the shelf share (accounts) cannot fill one whole pack (PACKS-2 §4).
  try {
    const share = Number(await deps.noclaimStock.stockForListing(row));
    if (Number.isFinite(share)) {
      const low = packsFor(share, n) < 1;
      if (low !== !!offer.lowStock) job.patch.lowStock = low;
    }
  } catch {
    /* an unreadable share is not low stock */
  }
}

// One capacity read per pass (farmCapacity caches it anyway).
async function capacityFor(ctx) {
  if (!ctx.cap) {
    const unreadable = (error) => ({
      bestStackRoom: 0,
      totalFree: 0,
      pristine: 0,
      at: null,
      error,
    });
    ctx.cap = Promise.resolve()
      .then(() => deps.farmCapacity.read())
      .then((c) =>
        c && typeof c === "object"
          ? c
          : unreadable("the capacity read returned nothing"),
      )
      .catch((e) => unreadable(errText(e)));
  }
  return ctx.cap;
}

// FIXES-1 S1: the rent-farm capacity is SHARED by every open farm offer. The
// whole `available` is split between them, deterministically by id, and an
// offer only ever acts on its own share. The sharers are EXACTLY the list
// send.js counts (FIXES-2 V1): every open farm offer — sending (its send takes
// its share as it publishes), live, or paused (it comes back and needs its
// part). Counting fewer than send.js did let the two disagree, so the shares
// could add up to more than `available`. Read fresh (under this offer's lock)
// so a farm offer sent or closed a moment ago is counted as it is now. Returns
// {share, available, sharers}, or null (with a loop error) when the share
// cannot be worked out — then nothing is paused, resumed or requantified.
async function farmShare(offer, cap, ctx, job) {
  let available = Math.floor(
    Number(deps.farmCapacity.advertisable(cap, ctx.bp)),
  );
  if (!Number.isFinite(available) || available < 0) available = 0;
  const self = String(offer._id);
  const rows = await deps.BulkOffer.find(farmSharers(), { _id: 1 })
    .sort({ _id: 1 })
    .limit(OFFER_LIMIT)
    .lean();
  const ids = [
    ...new Set([...(rows || []).map((r) => String(r._id)), self]),
  ].sort();
  const fc = deps.farmCapacity;
  let share;
  try {
    share =
      typeof fc.shareFor === "function"
        ? fc.shareFor(self, ids, available)
        : // The same equal split farmCapacity.shareFor wraps (FIXES-1 S1).
          deps.suppliedStock.shareOfShelf(available, self, ids);
  } catch (e) {
    job.errors.push(
      "farm capacity share failed (" + errText(e) + ") — sync skipped",
    );
    return null;
  }
  share = Math.floor(Number(share));
  if (!Number.isFinite(share) || share < 0) {
    job.errors.push(
      "farm capacity share unreadable (" + str(share) + ") — sync skipped",
    );
    return null;
  }
  return { share: Math.min(share, available), available, sharers: ids.length };
}

// `sh.share` is ACCOUNTS (bot slots + pristine pool); the market is offered
// the whole packs of n they make (PACKS-2 §4).
function capacityText(cap, sh, n) {
  const accounts = sh ? sh.share : 0;
  const packs = " account(s) = " + packsFor(accounts, n) + " pack(s) of " + n;
  if (!cap) return "capacity for " + accounts + packs;
  if (cap.error) return "capacity unreadable (" + cap.error + ")";
  const shared =
    sh && sh.sharers > 1
      ? ", its share of " +
        sh.available +
        " across " +
        sh.sharers +
        " farm offers"
      : "";
  return (
    "capacity for " +
    accounts +
    packs +
    shared +
    " (best stack room " +
    (Number(cap.bestStackRoom) || 0) +
    ", free slots " +
    (Number(cap.totalFree) || 0) +
    ", pristine accounts " +
    (Number(cap.pristine) || 0) +
    ")"
  );
}

async function countFarmSales(offer, ctx) {
  const or = [];
  const ext = str(offer.externalId);
  // The farm services store the marketplace offer id the order was placed on
  // (utils/eldoradoFarmService.js / utils/g2gFarmService.js `offerId`), the same
  // id the fulfillers match against a listing's externalId.
  if (ext) or.push({ offerId: ext });
  // Fallback for an order whose offer id was not recorded: the title, only for
  // orders placed after this offer existed (an earlier offer on the same slot
  // carried the same title).
  if (str(offer.title)) {
    or.push({
      offerId: { $in: ["", null] },
      offerTitle: offer.title,
      createdAt: { $gte: offer.createdAt || new Date(0) },
    });
  }
  if (!or.length) return;
  const rows = await deps.FarmServiceOrder.find(
    { market: offer.market, state: { $ne: "cancelled" }, $or: or },
    { orderId: 1, quantity: 1, accounts: 1, createdAt: 1 },
  )
    .sort({ createdAt: -1 })
    .limit(FARM_ORDER_LIMIT)
    .lean();
  const n = packSize(offer, null);
  let units = 0;
  let packs = 0;
  let last = null;
  for (const r of rows) {
    // The ACCOUNTS this order takes. On a bulk offer the farm services
    // provision purchaseQuantity × minQty (PACKS-2 §2) and list each account
    // handed over in `accounts`; the larger of `quantity` and that list is the
    // order's size whichever of the two the row carries yet, so a row that
    // records the units bought is still counted in full once provisioned.
    const q = Math.floor(Number(r.quantity));
    const listed = ((r && r.accounts) || []).length;
    const accounts = Math.max(q >= 1 ? q : 0, listed, 1);
    units += accounts;
    packs += packsFor(accounts, n);
    const t = ms(r.createdAt);
    if (t != null && (last == null || t > last)) last = t;
  }
  await countSales(
    offer,
    {
      orders: rows.length,
      units,
      packs,
      packSize: n,
      lastOrderAt: last == null ? null : new Date(last),
    },
    ctx,
  );
}

async function maintainFarm(offer, ctx, job) {
  await countFarmSales(offer, ctx);
  if (!offer.open) return;
  const every =
    Math.max(1, Number(ctx.bp.farmSyncMinutes) || SAFE_BP.farmSyncMinutes) *
    60000;
  if (due(offer.lastSyncAt, every, ctx.now)) await syncFarm(offer, ctx, job);
  if ((await readExpiry(offer, ctx, job)) === "expired") {
    if (
      await transition(offer, "expired", {
        now: ctx.now,
        detail: "expired on " + label(offer.market),
      })
    ) {
      ctx.changed = true;
      audit(
        offer,
        "expired",
        "info",
        "offer expired on " + label(offer.market),
      );
      notify("Bulk farming offer expired: " + describe(offer));
    }
  }
}

// The farm capacity sync of one offer (every bp.farmSyncMinutes, or at once
// from resplitFarm). `shrinkOnly` (resplitFarm's first round, FIXES-2 V1):
// act only if this offer must come DOWN (pause, or a lower quantity); an offer
// that would grow or resume is left for the second round, so the offers never
// advertise more than the pool together while the shares move.
async function syncFarm(offer, ctx, job, { shrinkOnly = false } = {}) {
  const cap = await capacityFor(ctx);
  if (cap.error) {
    // FIXES-1 L6: an unreadable capacity is not "no capacity". Nothing is
    // paused, resumed or requantified on it, nobody is paged — a loop error
    // only, and the sync is tried again next pass (lastSyncAt stays).
    job.errors.push(
      "farm capacity unreadable (" + cap.error + ") — capacity sync skipped",
    );
    return;
  }
  const sh = await farmShare(offer, cap, ctx, job);
  if (!sh) return;
  // S1: this offer's share, never the whole of `available` — ACCOUNTS. The
  // market sells whole packs of n (PACKS-2 §4): q packs, and a share that
  // cannot fill one pack pauses the offer.
  const n = packSize(offer, null);
  const q = packsFor(sh.share, n);
  if (
    shrinkOnly &&
    !(
      offer.state === "live" &&
      (q < 1 || q < (Number(offer.advertisedQty) || 0))
    )
  ) {
    return;
  }
  job.patch.lastSyncAt = ctx.now;
  const short = " — less than one pack of " + n;
  if (offer.state === "live" && q < 1) {
    await deps.markets.pause(offer.market, offer.externalId);
    // This pass took it off sale itself: a market read right behind the pause
    // that still says "active" is lag, not a relist (FIXES-2 V3).
    job.pausedNow = true;
    if (
      await transition(offer, "paused", {
        from: ["live"],
        set: { autoPaused: true },
        now: ctx.now,
        detail: capacityText(cap, sh, n) + short,
      })
    ) {
      ctx.changed = true;
      audit(
        offer,
        "paused",
        "warn",
        "auto-paused: " + capacityText(cap, sh, n) + short,
        { count: sh.share },
      );
      notify(
        "Bulk farming offer paused: " +
          describe(offer) +
          "\n" +
          capacityText(cap, sh, n) +
          short +
          ". It resumes by itself once capacity returns" +
          (ctx.bp.enabled === true ? "." : " and bulk packs are switched on."),
      );
    }
  } else if (offer.state === "paused" && offer.autoPaused === true && q >= 1) {
    // Only an offer the loop paused itself, never while switched off (I8),
    // never with the delivery gate shut (I4).
    if (
      ctx.bp.enabled === true &&
      safeGate(offer.market, "farm").ok &&
      (await stillIn(offer, ["paused"], { autoPaused: true }))
    ) {
      // Quantity first, so the offer never comes back advertising more than
      // the farm can take.
      if (q !== Number(offer.advertisedQty)) {
        await deps.markets.setQuantity(offer.market, offer.externalId, q);
        await deps.BulkOffer.updateOne(
          { _id: offer._id },
          { $set: { advertisedQty: q } },
        );
        offer.advertisedQty = q;
      }
      await deps.markets.resume(offer.market, offer.externalId);
      if (
        await transition(offer, "live", {
          from: ["paused"],
          set: { autoPaused: false },
          now: ctx.now,
          detail: capacityText(cap, sh, n),
        })
      ) {
        ctx.changed = true;
        audit(
          offer,
          "resumed",
          "info",
          "auto-resumed: " + capacityText(cap, sh, n),
          { count: sh.share },
        );
        notify(
          "Bulk farming offer resumed: " +
            describe(offer) +
            "\n" +
            capacityText(cap, sh, n) +
            ".",
        );
      }
    }
  } else if (offer.state === "live" && q !== Number(offer.advertisedQty)) {
    await syncQuantity(offer, q, ctx);
  }
}

async function watchSending(offer, ctx) {
  const born = ms(offer.createdAt);
  if (born == null || ctx.now.getTime() - born < STUCK_SENDING_MS) return;
  await raiseFlag(
    offer,
    "sending",
    'stuck in "sending" since ' +
      new Date(born).toISOString() +
      " — the send never finished. Check " +
      label(offer.market) +
      " for a live offer and settle it by hand; its reserved accounts were left alone",
  );
}

async function handleOffer(offer, ctx) {
  // A send in flight owns its offer: reserved units with no row yet are
  // normal here, and releasing them would put the same accounts on sale twice.
  if (offer.state === "sending") return watchSending(offer, ctx);
  await clearFlag(offer, "sending");
  const job = { patch: {}, errors: [] };
  if (offer.source === "dropset") await maintainDropset(offer, ctx, job);
  else if (offer.source === "noclaim") await maintainNoclaim(offer, ctx, job);
  else if (offer.source === "farm") await maintainFarm(offer, ctx, job);
  else throw new Error('unknown bulk-pack source "' + str(offer.source) + '"');
  if (Object.keys(job.patch).length) {
    await deps.BulkOffer.updateOne({ _id: offer._id }, { $set: job.patch });
    Object.assign(offer, job.patch);
  }
  // A clean pass clears the loop's OWN previous error — conditionally, so an
  // error another writer (send.js) left since is never wiped.
  if (!job.errors.length) noted.delete(String(offer._id));
  if (
    !job.errors.length &&
    str(offer.lastError).startsWith(LOOP_ERROR_PREFIX)
  ) {
    await deps.BulkOffer.updateOne(
      { _id: offer._id, lastError: offer.lastError },
      { $set: { lastError: "" } },
    );
    offer.lastError = "";
  }
  if (job.errors.length) {
    const e = new Error(job.errors.join("; "));
    e.soft = true;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

const state = {
  timer: null,
  stopped: true,
  running: false,
  lastRunAt: null,
  lastSummary: null,
  lastError: "",
  passes: 0,
};

// `busy`: offers skipped this pass because a send or an owner action held
// their lock (FIXES-2 V2) — visited again next pass.
function emptySummary() {
  return {
    open: 0,
    accounts: 0,
    farming: 0,
    sold: 0,
    paused: 0,
    retiring: 0,
    released: 0,
    busy: 0,
    errors: 0,
  };
}

function heartbeatLine(s) {
  return (
    "bulkPacks: pass — open " +
    s.open +
    " (acct " +
    s.accounts +
    ", farm " +
    s.farming +
    ") | sold +" +
    s.sold +
    " | paused " +
    s.paused +
    " | retiring " +
    s.retiring +
    " | released " +
    s.released +
    " | busy " +
    (Number(s.busy) || 0) +
    " | errors " +
    s.errors
  );
}

function finalCounts(offers, summary) {
  for (const o of offers) {
    if (o.open) {
      summary.open++;
      if (o.kind === "farming") summary.farming++;
      else summary.accounts++;
      if (o.state === "paused") summary.paused++;
    }
    for (const e of o.reserved || [])
      if (e && e.state === "retiring") summary.retiring++;
  }
}

// What one pass (or one maintainOffer call) shares: the clock, the settings,
// the counters, a DropSet cache and the one capacity read.
function passContext(now) {
  return {
    now: asDate(now),
    bp: readBp(),
    summary: emptySummary(),
    sets: new Map(),
    changed: false,
    cap: null,
  };
}

// The pass over ONE offer, run while holding its lock (FIXES-1 L3). The offer
// is read here, never taken from a list read before the lock: a take-out or a
// send action that ran while this pass waited is seen. A failure is recorded
// on the offer (still inside the lock) and returned, never thrown.
async function maintainOfferLocked(offerId, ctx) {
  const offer = await deps.BulkOffer.findById(offerId, { history: 0 }).lean();
  if (!offer) return { offer: null, error: "" };
  try {
    await handleOffer(offer, ctx);
    return { offer, error: "" };
  } catch (e) {
    const error = errText(e);
    await noteLoopError(offer, error);
    return { offer, error };
  }
}

// Maintain one offer now, under its lock — what runOnce does for every offer
// it visits. Standalone (no pass context), it builds its own and tells the
// proposals cache when something changed. By default it waits for the lock;
// `ifFree` (the pass, FIXES-2 V2) runs only if nobody holds or waits for it
// and otherwise returns at once with busy:true. Resolves
// {offer, error, busy, summary}: `offer` as the pass left it (null when it does
// not exist or was busy), `error` the pass's error text ("" when clean). Never
// call it while holding this offer's lock (the lock is not re-entrant).
async function maintainOffer(offerId, { now, ctx, ifFree = false } = {}) {
  const own = !ctx;
  const c = ctx || passContext(now);
  const run = () => maintainOfferLocked(offerId, c);
  let res;
  if (ifFree) {
    const t = await deps.lock.tryWithOfferLock(offerId, run);
    if (!t || t.ran !== true) {
      if (own) c.summary.busy++;
      return { offer: null, error: "", busy: true, summary: c.summary };
    }
    res = t.value;
  } else {
    res = await deps.lock.withOfferLock(offerId, run);
  }
  if (own) {
    if (res.error) c.summary.errors++;
    if (res.offer) finalCounts([res.offer], c.summary);
    if (c.changed) invalidateProposals();
  }
  return {
    offer: res.offer,
    error: res.error,
    busy: false,
    summary: c.summary,
  };
}

// FIXES-2 V2: each offer's own clock and settings, set just before its turn.
// `now` is the pass's base time plus the real time the pass has run so far —
// a unit retired late in a long pass (slow market calls) carries the time it
// really left, so its retire grace is not cut short by the stall, while tests
// keep control of the base — and the settings are read again, so switching
// bulk packs off mid-pass holds for every offer after the switch. Under
// CLOCK_SLACK_MS of running the base is kept exactly: the grace, the read
// cadence and the farm sync are minutes, and millisecond drift would only make
// their boundaries jitter from pass to pass.
const CLOCK_SLACK_MS = 1000;
function passClock(ctx) {
  return { base: ctx.now.getTime(), started: Date.now() };
}
function forOffer(ctx, clock) {
  const ran = Date.now() - clock.started;
  ctx.now = new Date(clock.base + (ran >= CLOCK_SLACK_MS ? ran : 0));
  ctx.bp = readBp();
}

// What finalCounts reads of an offer the pass could not visit (busy).
const COUNT_FIELDS = { open: 1, kind: 1, state: 1, "reserved.state": 1 };

// Which offers a pass visits: every open one, every one with units on their
// way back to stock, and — for WATCH_WINDOW_MS — every closed dropset offer
// and every dropset offer that released an account (FIXES-1 L2).
function passQuery(now) {
  const since = new Date(now.getTime() - WATCH_WINDOW_MS);
  return {
    $or: [
      { open: true },
      { "reserved.state": "retiring" },
      { source: "dropset", open: false, closedAt: { $gte: since } },
      {
        source: "dropset",
        reserved: {
          $elemMatch: { state: "released", changedAt: { $gte: since } },
        },
      },
    ],
  };
}

// One pass. Safety maintenance runs whatever bulkPacksEnabled says (I8); only
// resuming and growing an offer need it on. An offer whose lock is held (a
// send in flight, an owner action) is skipped and counted busy — the pass
// never waits for one (FIXES-2 V2).
async function runOnce({ now = new Date() } = {}) {
  if (state.running)
    return { ...emptySummary(), skipped: "a pass is already running" };
  state.running = true;
  let ctx;
  let summary = emptySummary();
  const offers = [];
  let lastError = "";
  try {
    ctx = passContext(now);
    summary = ctx.summary;
    const clock = passClock(ctx);
    const ids = await deps.BulkOffer.find(passQuery(ctx.now), { _id: 1 })
      .sort({ lastSyncAt: 1, _id: 1 })
      .limit(OFFER_LIMIT)
      .lean();
    for (const { _id } of ids) {
      try {
        forOffer(ctx, clock);
        const r = await maintainOffer(_id, { ctx, ifFree: true });
        if (r.busy) {
          summary.busy++;
          // Still counted as it stands: a read only, nothing is written
          // without the lock.
          const seen = await deps.BulkOffer.findById(_id, COUNT_FIELDS).lean();
          if (seen) offers.push(seen);
          continue;
        }
        if (r.offer) offers.push(r.offer);
        if (r.error) {
          summary.errors++;
          lastError = r.error;
        }
      } catch (e) {
        // The offer could not even be read (or its lock refused).
        summary.errors++;
        lastError = errText(e);
        console.error("bulkPacks: offer " + String(_id) + ": " + lastError);
      }
    }
    if (ctx.changed) invalidateProposals();
  } catch (e) {
    summary.errors++;
    lastError = errText(e);
    console.error("bulkPacks: pass failed:", lastError);
  } finally {
    finalCounts(offers, summary);
    state.lastRunAt = new Date();
    state.lastSummary = summary;
    state.lastError = lastError;
    state.passes++;
    state.running = false;
    // HEARTBEAT: one line per pass, idle ones included, so "running and finding
    // nothing to do" never looks like "never started" (utils/unclaimedAllocator).
    console.log(heartbeatLine(summary));
  }
  return summary;
}

// FIXES-2 V1: re-split the rent-farm capacity NOW. send.js calls it once a
// farm send or resume has finished (after it released that offer's lock): the
// new sharer has taken its share, so every other farm offer must come down to
// its new, smaller one at once — not at its next farmSyncMinutes sync, while
// the offers together advertise more than the farm can take. Every open live
// or paused farm offer is synced under its own lock (WAITED for: skipping a
// busy one would leave it on its old share), ignoring the throttle, in two
// rounds — first only the offers that must shrink (pause, lower), then all of
// them (grow, resume, behind the usual I4/I8 guards) — so the total advertised
// only ever goes down while the shares move. An offer still being sent is left
// to its own send, which calls this again when it is done. One capacity read
// for the whole re-split.
//
// It holds one lock at a time and REFUSES to start (rejects) while its caller
// holds any offer's lock: waiting for offer B while holding A deadlocks
// against B's holder waiting for A. Everything else is noted on its offer
// (lastError) and counted, never thrown. Resolves
// {offers, changed, errors, lastError}.
async function resplitFarm({ now } = {}) {
  const l = deps.lock;
  if (typeof l.holdsAny === "function" && l.holdsAny()) {
    throw new Error(
      "resplitFarm must not run inside a bulk offer's lock — call it after the lock is released",
    );
  }
  const ctx = passContext(now);
  const clock = passClock(ctx);
  const out = { offers: 0, changed: false, errors: 0, lastError: "" };
  let ids;
  try {
    ids = await deps.BulkOffer.find(
      { ...farmSharers(), state: { $in: ["live", "paused"] } },
      { _id: 1 },
    )
      .sort({ _id: 1 })
      .limit(OFFER_LIMIT)
      .lean();
  } catch (e) {
    out.errors++;
    out.lastError = errText(e);
    console.error("bulkPacks: farm re-split failed:", out.lastError);
    return out;
  }
  out.offers = ids.length;
  for (const shrinkOnly of [true, false]) {
    for (const { _id } of ids) {
      try {
        const r = await l.withOfferLock(_id, () => {
          // The clock once the lock is held: waiting for it takes time.
          forOffer(ctx, clock);
          return resyncFarmLocked(_id, ctx, { shrinkOnly });
        });
        if (r && r.error) {
          out.errors++;
          out.lastError = r.error;
        }
      } catch (e) {
        out.errors++;
        out.lastError = errText(e);
        console.error(
          "bulkPacks: farm re-split of offer " +
            String(_id) +
            ": " +
            out.lastError,
        );
      }
    }
  }
  out.changed = ctx.changed;
  if (ctx.changed) invalidateProposals();
  return out;
}

// One farm offer's share sync for resplitFarm, run under its lock and read
// fresh there: only an open live/paused farm offer is synced. A failure is
// noted on the offer (a "Loop:" error the next clean pass clears).
async function resyncFarmLocked(offerId, ctx, opts) {
  const offer = await deps.BulkOffer.findById(offerId, { history: 0 }).lean();
  if (
    !offer ||
    offer.source !== "farm" ||
    !offer.open ||
    !["live", "paused"].includes(offer.state)
  ) {
    return { offer, error: "" };
  }
  const job = { patch: {}, errors: [] };
  try {
    await syncFarm(offer, ctx, job, opts);
    if (Object.keys(job.patch).length) {
      await deps.BulkOffer.updateOne({ _id: offer._id }, { $set: job.patch });
      Object.assign(offer, job.patch);
    }
  } catch (e) {
    job.errors.push(errText(e));
  }
  if (!job.errors.length) return { offer, error: "" };
  const error = "farm re-split: " + job.errors.join("; ");
  await noteLoopError(offer, error);
  return { offer, error };
}

function schedule(delayMs) {
  state.timer = setTimeout(tick, delayMs);
  if (state.timer && typeof state.timer.unref === "function")
    state.timer.unref();
}

async function tick() {
  state.timer = null;
  try {
    await runOnce();
  } catch {
    /* runOnce records its own errors; a pass must never kill the loop */
  }
  if (state.stopped) return;
  // Re-read every pass, so a changed bulkPacksLoopMinutes applies next tick.
  let minutes = SAFE_BP.loopMinutes;
  try {
    const m = Number(deps.settings.getBulkPacks().loopMinutes);
    if (Number.isFinite(m) && m > 0) minutes = m;
  } catch {
    /* keep the default */
  }
  schedule(Math.max(2, minutes) * 60000);
}

function start() {
  if (state.timer || state.stopped === false) return;
  state.stopped = false;
  schedule(FIRST_DELAY_MS);
}

function stop() {
  state.stopped = true;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
}

function status() {
  return {
    running: state.running,
    lastRunAt: state.lastRunAt,
    lastSummary: state.lastSummary,
    lastError: state.lastError,
    passes: state.passes,
    started: state.stopped === false,
  };
}

// Owner actions that spend an account elsewhere (drop-archive mark-sold,
// renter reclaim) reach a bulk row through utils/listingDetach. A pack is sold
// whole, so the account leaves the pack HERE — with its reservation kept
// (keepReserved) — instead of the generic detach, which would republish a
// different product. Runs under the offer's lock and reads the offer and its
// row inside it (FIXES-1 L3/L4). Returns listingDetach's shape:
// {detached, warnings}.
async function takeAccountOut({ row, accountId, login, reason } = {}) {
  const offerId = row && row.bulkOfferId;
  if (!offerId) return { detached: [], warnings: ["not a bulk pack row"] };
  return deps.lock.withOfferLock(offerId, () =>
    takeAccountOutLocked({ row, accountId, login, reason }),
  );
}

// FIXES-1 L4: the account's LIVE entry (on_offer first, then retiring) — never
// an older released/delivered one while a live one exists (an account the
// offer released and took back later has both). With no live entry, its
// latest entry says what became of it.
function entryForTakeOut(offer, accountId, login) {
  const want = str(accountId);
  const wantLogin = str(login).toLowerCase();
  const all = ((offer && offer.reserved) || []).filter(Boolean);
  // By account id when there is one (two accounts can share a login); by
  // login only when the id finds nothing.
  let mine = want ? all.filter((x) => str(x.accountId) === want) : [];
  if (!mine.length && wantLogin) {
    mine = all.filter((x) => str(x.login).toLowerCase() === wantLogin);
  }
  return (
    mine.find((x) => x.state === "on_offer") ||
    mine.find((x) => x.state === "retiring") ||
    mine[mine.length - 1] ||
    null
  );
}

async function takeAccountOutLocked({ row, accountId, login, reason }) {
  const detached = [];
  const warnings = [];
  const label =
    "bulk pack " +
    str(row && row.marketplace) +
    " " +
    str(row && (row.externalId || row._id));
  const offer = await deps.BulkOffer.findById(row.bulkOfferId, {
    history: 0,
  }).lean();
  if (!offer) {
    return {
      detached,
      warnings: [label + ": its bulk offer is missing — check Bulk packs"],
    };
  }
  const e = entryForTakeOut(offer, accountId, login);
  if (!e) {
    return {
      detached,
      warnings: [label + ": the account is not in this pack"],
    };
  }
  const name = str(e.login) || str(e.accountId);
  if (e.state === "delivered") {
    return {
      detached,
      warnings: [
        label + ": " + name + " was already delivered to a pack buyer",
      ],
    };
  }
  if (e.state === "released") return { detached, warnings }; // left the pack already
  if (offer.source !== "dropset") {
    return {
      detached,
      warnings: [label + ": not an account pack — nothing to take out"],
    };
  }
  const id = str(e.accountId);
  const why = "owner: " + (str(reason) || "taken out");
  const ctx = passContext(new Date());
  // First, whatever happens next: this account's reservation is never handed
  // back by this pack (the owner spent it), and every later pass keeps taking
  // it out until it has left (FIXES-1 L1).
  await markKeep(offer, [id]);
  if (e.state === "retiring") {
    // Already off the shelf and on its way back: now it stays reserved.
    audit(
      offer,
      "owner_took_account",
      "info",
      name + " " + why + " (already leaving the pack)",
    );
    detached.push(label + " (already leaving the pack)");
    return { detached, warnings };
  }
  const { row: cur, problem } = await loadRow(offer, ctx.now);
  if (problem || !cur) {
    return {
      detached,
      warnings: [
        label +
          ": " +
          (problem || "its listing row is missing") +
          " — the account is marked to leave the pack; the maintenance loop finishes it",
      ],
    };
  }

  if (offer.market === "gameflip") {
    // One listing is the whole pack: it comes down, the other accounts go back
    // to stock, this one stays reserved.
    if (cur.status === "sold") {
      // Too late: the pack buyer has its code. The next pass records the
      // sale and reports this account (it was also spent elsewhere).
      return {
        detached,
        warnings: [
          label +
            ": the pack already sold — " +
            name +
            " went to the pack buyer; check it is not sold twice",
        ],
      };
    }
    if (cur.status !== "active") {
      audit(
        offer,
        "owner_took_account",
        "info",
        name + " " + why + " (pack already down)",
      );
      detached.push(label + " (pack already taken down)");
      return { detached, warnings };
    }
    const down = await withdrawPack(
      offer,
      cur,
      [{ accountId: id, reason: TAKEN_OUT, keepReserved: true }],
      ctx,
    );
    if (ctx.changed) invalidateProposals();
    if (!down) {
      return {
        detached,
        warnings: [
          label +
            ": could not take the Gameflip pack down yet (" +
            (FLAG_RE.test(str(offer.attention))
              ? str(offer.attention).replace(FLAG_RE, "")
              : "the listing row changed") +
            ") — the maintenance loop keeps trying; check Bulk packs",
        ],
      };
    }
    audit(
      offer,
      "owner_took_account",
      "warn",
      name + " " + why + " — pack withdrawn",
    );
    detached.push(label + " (whole pack withdrawn)");
    return { detached, warnings };
  }

  // Eldorado / G2G (FIXES-2 V4): the market comes down FIRST — to what the
  // offer can still sell without this account — and only THEN does the unit
  // leave the row (phase 1 of I10; phase 2 keeps the reservation). The other
  // way round, the offer advertised a unit the row no longer held, and a buyer
  // of the full quantity paid for an order the fulfiller could not fill.
  const marketError = await lowerForTakeOut(offer, cur, id, name, ctx);
  // The account was spent elsewhere, so it leaves whether or not the market
  // call worked; a failed one is noted and the next pass lowers the market
  // (syncQuantity, or sold out below the minimum).
  const n = await retireUnits(offer, cur, [id], why, { now: ctx.now });
  if (marketError) {
    warnings.push(
      label +
        ": quantity not updated yet (" +
        marketError +
        ") — the next check fixes it",
    );
    await noteLoopError(
      offer,
      "take-out of " +
        name +
        ": the market was not lowered (" +
        marketError +
        ") — the next pass corrects it",
    );
  }
  if (!n) {
    warnings.unshift(
      label +
        ": " +
        name +
        " is mid-delivery to a pack buyer — the maintenance loop takes it out if that delivery does not complete; check Bulk packs",
    );
    return { detached, warnings };
  }
  detached.push(label);
  audit(offer, "owner_took_account", "info", name + " " + why);
  return { detached, warnings };
}

// FIXES-2 V4 + FIXES-1 L7, before a take-out's unit leaves the row: what the
// offer can still sell afterwards is its on_offer entries' FREE units, less
// the leaving account and any other the owner took out (keepReserved — they
// leave on the next pass; a retiring unit back on the row is not stock
// either). The market counts whole PACKS of n (PACKS-2 §4): while they still
// fill one, a live offer's quantity comes down to packsFor(freeAfter, n)
// (never up: growing is the pass's, behind I4/I8); with not even one pack left
// the offer is paused (live -> paused, autoPaused false) and the next pass
// closes it sold out. Returns "" or the market call's error text — never
// throws.
async function lowerForTakeOut(offer, row, accountId, name, ctx) {
  if (offer.state !== "live") return "";
  const leaving = new Set(
    (offer.reserved || [])
      .filter((e) => e && e.state === "on_offer" && e.keepReserved === true)
      .map((e) => str(e.accountId)),
  );
  leaving.add(str(accountId));
  const free = freeOnOffer(offer, row).filter(
    (u) => !leaving.has(u.accountId),
  ).length;
  const n = packSize(offer, row);
  const packs = packsFor(free, n);
  try {
    if (packs >= 1) {
      const advertised = Number(offer.advertisedQty) || 0;
      if (advertised > 0 && packs >= advertised) return "";
      await deps.markets.setQuantity(offer.market, offer.externalId, packs);
      await deps.BulkOffer.updateOne(
        { _id: offer._id },
        { $set: { advertisedQty: packs } },
      );
      offer.advertisedQty = packs;
      return "";
    }
    const detail = "below the minimum after an owner take-out";
    await deps.markets.pause(offer.market, offer.externalId);
    if (
      await transition(offer, "paused", {
        from: ["live"],
        set: { autoPaused: false },
        now: ctx.now,
        detail: free + " free < one pack of " + n + " — " + detail,
      })
    ) {
      audit(offer, "paused", "warn", "paused: " + detail, { count: free });
      notify(
        "Bulk offer paused: " +
          describe(offer) +
          "\n" +
          name +
          " was taken out by the owner; " +
          free +
          " account(s) left — less than one pack of " +
          n +
          ". The next check closes it as sold out.",
      );
    }
    return "";
  } catch (err) {
    return errText(err);
  }
}

module.exports = {
  RETIRE_GRACE_MS,
  WATCH_WINDOW_MS,
  READ_OFFER_EVERY_MS,
  start,
  stop,
  status,
  runOnce,
  maintainOffer,
  resplitFarm,
  retireUnits,
  reconcileUnits,
  takeAccountOut,
  markKeep,
  heartbeatLine,
  __setDeps,
  __resetDeps,
};
