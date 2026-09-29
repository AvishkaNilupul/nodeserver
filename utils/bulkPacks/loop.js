// Bulk packs — the maintenance loop (docs/bulk-packs/CONTRACT.md I1–I13,
// MODULES.md §loop.js).
//
// It LOOKS AFTER live bulk offers and never publishes one: Send is always an
// owner click (§2). Each pass visits every open offer, plus every closed one
// that still has units on their way back to stock:
//
//   dropset eldorado/g2g  reconcile reserved[] with the row, count sales,
//                         retire unhealthy units, pause + retire a sold-out
//                         offer, keep the advertised quantity equal to the free
//                         units, notice an expired offer (every 30 min)
//   dropset gameflip      finalise a sold pack, retire a removed/delisted one,
//                         withdraw a pack holding an unhealthy account (I9)
//   noclaim               notice a dead row, count sales, flag low stock
//                         (display only — the no-claim syncs own the quantity)
//   farm                  pause when rent-farm capacity cannot cover the
//                         minimum order, resume an offer IT paused once it can
//                         (never while bulk packs are switched off, I8), keep
//                         the quantity equal to capacity, count sales from
//                         FarmServiceOrder, notice expiry
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
// WHY A RETIRED UNIT WAITS TWO MINUTES (I10)
// A unit we pull may be exactly the one a fulfiller is delivering from its
// in-memory copy; its save then puts the unit back carrying deliveredAt /
// orderId. So release is two-phase: phase 1 takes the unit off the row and
// marks it "retiring"; phase 2, on a later pass at least RETIRE_GRACE_MS after
// the last change, re-reads the row — back and FREE: pull again and restart the
// clock; back and not FREE: it SOLD ("delivered", never released); still absent:
// release the reservation (I1) and mark it "released".
//
// Nothing FREE (I2: no deliveredAt, messagedAt or orderId) is ever assumed sold,
// and nothing that is not FREE is ever released or pulled.

const { OPEN_STATES } = require("./config");

const ACTOR = "bulkPacks";
const FIRST_DELAY_MS = 120 * 1000;
// Phase 2 of I10: how long a retired unit must stay off the row before its
// reservation is handed back.
const RETIRE_GRACE_MS = 2 * 60 * 1000;
const READ_OFFER_EVERY_MS = 30 * 60 * 1000;
// A send that has not finished in this long has died (the server restarted
// mid-send). Its reservations are left alone — the market may hold a live offer
// with no row — and the owner is told once.
const STUCK_SENDING_MS = 15 * 60 * 1000;
const OFFER_LIMIT = 500;
const FARM_ORDER_LIMIT = 500;

// lastError prefixes. A "Loop:" error clears itself on the next clean pass; a
// "Needs attention (key):" flag is raised once (one Telegram) and cleared only
// by the check that raised it, so a standing problem never re-pages every pass.
const LOOP_ERROR_PREFIX = "Loop: ";
const FLAG_RE = /^Needs attention \(([a-z]+)\): /;

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
  noclaimStock: 1,
  title: 1,
};
const HOLDING_STATES = ["on_offer", "retiring", "delivered"];

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
function priceText(offer) {
  return offer.market === "gameflip"
    ? money(offer.packPrice) + " per pack of " + offer.minQty
    : money(offer.unitPrice) + " each, min " + offer.minQty;
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

async function raiseFlag(offer, key, text, { telegram = true } = {}) {
  const msg = ("Needs attention (" + key + "): " + text).slice(0, 500);
  if (str(offer.lastError) === msg) return false;
  await deps.BulkOffer.updateOne(
    { _id: offer._id },
    { $set: { lastError: msg } },
  );
  offer.lastError = msg;
  audit(offer, "attention_" + key, "warn", text);
  if (telegram)
    notify("Bulk packs — needs attention: " + describe(offer) + "\n\n" + text);
  return true;
}

async function clearFlag(offer, key) {
  const m = FLAG_RE.exec(str(offer.lastError));
  if (!m || m[1] !== key) return;
  await deps.BulkOffer.updateOne(
    { _id: offer._id, lastError: offer.lastError },
    { $set: { lastError: "" } },
  );
  offer.lastError = "";
}

async function noteLoopError(offer, text) {
  const msg = (LOOP_ERROR_PREFIX + text).slice(0, 500);
  // Logged and audited when it CHANGES; a standing error shows in the
  // heartbeat's error count and in status().lastError instead.
  if (str(offer.lastError) === msg) return;
  console.error("bulkPacks: offer " + String(offer._id) + ": " + text);
  try {
    await deps.BulkOffer.updateOne(
      { _id: offer._id },
      { $set: { lastError: msg } },
    );
    offer.lastError = msg;
  } catch {
    /* the heartbeat still counts it */
  }
  audit(offer, "loop_error", "warn", text);
}

// Counters only ever grow ($max): a unit lost from the row by a concurrent save
// must not un-count a sale, and a repeated pass must not re-announce one.
async function countSales(offer, s, ctx, { revenue, quiet = false } = {}) {
  const orders = Math.max(0, Math.floor(Number(s.orders) || 0));
  const units = Math.max(0, Math.floor(Number(s.units) || 0));
  const rev = round2(
    revenue != null ? revenue : units * (Number(offer.unitPrice) || 0),
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
        "+" + dOrders + " order(s), +" + dUnits + " account(s)",
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
      " account(s) — total " +
      offer.ordersCount +
      " order(s), " +
      offer.unitsDelivered +
      " account(s), " +
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
  if (
    !(await setEntry(offer, e, from, {
      state: "released",
      changedAt: at,
      reason: pending,
    }))
  )
    return false;
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
      reason: ("release will retry (" + errText(why2) + "): " + why).slice(0, 300),
    };
    await setEntryWhere(
      offer,
      { accountId: id, state: "released", reason: pending },
      back,
    );
    Object.assign(e, back);
    out.errors.push("release of " + (e.login || id) + " will retry: " + errText(why2));
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

// Reconcile reserved[] (the authority) with the row, per MODULES §loop:
//   on_offer  on the row, not FREE           -> delivered
//             on the row, FREE               -> on sale, nothing to do
//             absent, row active, offer open -> put back (only while the
//                                               reservation is still ours)
//             absent otherwise               -> retiring
//   retiring  on the row, not FREE           -> delivered (it sold)
//             on the row, FREE               -> pulled again, clock restarts
//             absent >= RETIRE_GRACE_MS      -> released (I1)
//   no row at all -> nothing can sell these units: released now (I1)
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
  const live = ((offer && offer.reserved) || []).filter(
    (e) =>
      e &&
      str(e.accountId) &&
      (e.state === "on_offer" || e.state === "retiring"),
  );
  if (!live.length) return out;
  const notes = {
    delivered: [],
    readded: [],
    repulled: [],
    retired: [],
    released: [],
    duplicates: [],
  };
  const who = (e) => str(e.login) || str(e.accountId);

  if (!row) {
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
      }
      // A FREE copy of an account that has already sold must never stay on sale.
      if (taken && freeCopies.length && (await pullFree(offer, row._id, id))) {
        out.rowChanged = true;
        notes.duplicates.push(who(e));
      }
      continue;
    }

    if (e.state === "on_offer") {
      if (freeCopies.length) continue; // on sale, as it should be
      if (rowActive && offer.open) {
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

async function missingRow(offer, ctx, job) {
  const now = ctx.now;
  if (
    offer.market === "gameflip" &&
    !offer.open &&
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
    return;
  }
  if (offer.market === "gameflip" && offer.open) {
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

async function soldOut(offer, row, free, bad, ctx) {
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
    "sold out: " + good + " free < minimum " + offer.minQty,
    { now: ctx.now },
  );
  const detail =
    good +
    " free < minimum " +
    offer.minQty +
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
        " account(s) left, below the minimum order of " +
        offer.minQty +
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
  const byReason = new Map();
  for (const b of bad) {
    const r = str(b.reason) || "failed its health check";
    if (!byReason.has(r)) byReason.set(r, []);
    byReason.get(r).push(b.accountId);
  }
  let n = 0;
  for (const [reason, ids] of byReason) {
    n += await retireUnits(offer, row, ids, "health: " + reason, {
      now: ctx.now,
    });
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
    if (h && h.ok === false) out.push({ accountId: id, reason: str(h.reason) });
  }
  return out;
}

// Keep the advertised quantity equal to what can be delivered. Shrinking is
// safety and always runs; growing is selling more, so it needs bulk packs on
// (I8) and the delivery gate open (I4).
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
  audit(offer, "quantity", "info", "advertised quantity " + cur + " -> " + q, {
    count: q,
  });
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
  return seen.state;
}

async function maintainDropset(offer, ctx, job) {
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

  await countSales(offer, salesFromUnits(cur, "dropset"), ctx);
  if (!offer.open) {
    // Closed with units still coming back: anything FREE left on sale goes too.
    await retireUnits(
      offer,
      cur,
      freeOnOffer(offer, cur).map((u) => u.accountId),
      "offer is " + offer.state,
      {
        now: ctx.now,
      },
    );
    return;
  }
  if (cur.status !== "active") return closeForRow(offer, cur, ctx);
  if ((await readExpiry(offer, ctx, job)) === "expired")
    return expireAccountsOffer(offer, cur, ctx);

  const free = freeOnOffer(offer, cur);
  const bad = await healthOf(
    free.map((u) => u.accountId),
    job,
  );
  const good = free.length - bad.length;
  if (good < Number(offer.minQty)) return soldOut(offer, cur, free, bad, ctx);
  if (bad.length) {
    // Shrink what is advertised BEFORE the units leave the row (I10 phase 1).
    if (offer.state === "live" && Number(offer.advertisedQty) > good) {
      await deps.markets.setQuantity(offer.market, offer.externalId, good);
      await deps.BulkOffer.updateOne(
        { _id: offer._id },
        { $set: { advertisedQty: good } },
      );
      offer.advertisedQty = good;
    }
    const n = await retireBad(offer, cur, bad, ctx);
    if (n) {
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
        n + " unhealthy unit(s) retired: " + list.join(", "),
        { count: n },
      );
      notify(
        "Bulk offer integrity: " +
          describe(offer) +
          "\n" +
          n +
          " account(s) taken off the offer: " +
          list.slice(0, 10).join(", ") +
          ". " +
          good +
          " still on sale.",
      );
    }
    return;
  }
  if (offer.state === "live") await syncQuantity(offer, good, ctx);
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
  if (!offer.open) {
    // Only a pack whose listing is known dead may give its accounts back (I9).
    if (row.status === "delisted" || row.status === "removed") {
      await retireUnits(
        offer,
        row,
        freeOnOffer(offer, row).map((u) => u.accountId),
        "pack " + row.status,
        {
          now: ctx.now,
        },
      );
    }
    return;
  }
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

  const members = (offer.reserved || [])
    .filter((e) => e && e.state === "on_offer" && str(e.accountId))
    .map((e) => str(e.accountId));
  const bad = await healthOf(members, job);
  if (!bad.length) {
    await clearFlag(offer, "withdraw");
    return;
  }
  const why = bad.map((b) => b.reason || "unhealthy").join("; ");
  try {
    await deps.markets.withdraw("gameflip", offer.externalId);
  } catch (e) {
    // It may have sold in the meantime: leave it, the Gameflip sync decides.
    await raiseFlag(
      offer,
      "withdraw",
      "a pack account failed its health check (" +
        why +
        ") but the Gameflip withdraw failed (" +
        errText(e) +
        ") — it may have sold; check it by hand",
    );
    return;
  }
  const r = await deps.MarketplaceListing.updateOne(
    { _id: row._id, bulkOfferId: offer._id, status: "active" },
    { $set: { status: "delisted" } },
  );
  if (!r || !r.modifiedCount) return; // the row moved (sold?) — the next pass reads it
  const gone = { ...row, status: "delisted" };
  const n = await retireUnits(offer, gone, members, "pack withdrawn: " + why, {
    now: ctx.now,
  });
  if (
    await transition(offer, "withdrawn", {
      now: ctx.now,
      detail: "unhealthy account: " + why,
    })
  ) {
    ctx.changed = true;
    audit(offer, "integrity_withdrawn", "warn", "pack withdrawn: " + why, {
      count: n,
    });
    notify(
      "Bulk pack withdrawn (integrity): " +
        describe(offer) +
        "\n" +
        why +
        ". The " +
        n +
        " account(s) go back to stock.",
    );
  }
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
  await countSales(offer, salesFromUnits(row, "noclaim"), ctx);
  if (!offer.open) return;
  if (row.status !== "active") return closeForRow(offer, row, ctx);
  // Display only (MODULES §loop): the existing no-claim syncs own the quantity.
  try {
    const share = Number(await deps.noclaimStock.stockForListing(row));
    if (Number.isFinite(share)) {
      const low = share < Number(offer.minQty);
      if (low !== !!offer.lowStock) job.patch.lowStock = low;
    }
  } catch {
    /* an unreadable share is not low stock */
  }
}

async function capacityFor(ctx) {
  if (!ctx.cap) {
    ctx.cap = Promise.resolve()
      .then(() => deps.farmCapacity.read())
      .catch((e) => ({
        bestStackRoom: 0,
        totalFree: 0,
        pristine: 0,
        at: null,
        error: errText(e),
      }));
  }
  return ctx.cap;
}

function capacityText(cap, q) {
  if (!cap) return "capacity for " + q;
  if (cap.error) return "capacity unreadable (" + cap.error + ")";
  return (
    "capacity for " +
    q +
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
  let units = 0;
  let last = null;
  for (const r of rows) {
    const q = Math.floor(Number(r.quantity));
    units += q >= 1 ? q : Math.max(1, ((r && r.accounts) || []).length);
    const t = ms(r.createdAt);
    if (t != null && (last == null || t > last)) last = t;
  }
  await countSales(
    offer,
    {
      orders: rows.length,
      units,
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
  if (due(offer.lastSyncAt, every, ctx.now)) {
    job.patch.lastSyncAt = ctx.now;
    const cap = await capacityFor(ctx);
    let q = Math.floor(Number(deps.farmCapacity.advertisable(cap, ctx.bp)));
    if (!Number.isFinite(q) || q < 0) q = 0;
    const minQty = Number(offer.minQty);
    if (offer.state === "live" && q < minQty) {
      await deps.markets.pause(offer.market, offer.externalId);
      if (
        await transition(offer, "paused", {
          from: ["live"],
          set: { autoPaused: true },
          now: ctx.now,
          detail: capacityText(cap, q) + " < minimum " + minQty,
        })
      ) {
        ctx.changed = true;
        audit(
          offer,
          "paused",
          "warn",
          "auto-paused: " + capacityText(cap, q) + " < minimum " + minQty,
          { count: q },
        );
        notify(
          "Bulk farming offer paused: " +
            describe(offer) +
            "\n" +
            capacityText(cap, q) +
            ", below the minimum order of " +
            minQty +
            ". It resumes by itself once capacity returns" +
            (ctx.bp.enabled === true
              ? "."
              : " and bulk packs are switched on."),
        );
      }
    } else if (
      offer.state === "paused" &&
      offer.autoPaused === true &&
      q >= minQty
    ) {
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
            detail: capacityText(cap, q),
          })
        ) {
          ctx.changed = true;
          audit(
            offer,
            "resumed",
            "info",
            "auto-resumed: " + capacityText(cap, q),
            { count: q },
          );
          notify(
            "Bulk farming offer resumed: " +
              describe(offer) +
              "\n" +
              capacityText(cap, q) +
              ".",
          );
        }
      }
    } else if (offer.state === "live" && q !== Number(offer.advertisedQty)) {
      await syncQuantity(offer, q, ctx);
    }
  }
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

function emptySummary() {
  return {
    open: 0,
    accounts: 0,
    farming: 0,
    sold: 0,
    paused: 0,
    retiring: 0,
    released: 0,
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

// One pass. Safety maintenance runs whatever bulkPacksEnabled says (I8); only
// resuming and growing an offer need it on.
async function runOnce({ now = new Date() } = {}) {
  if (state.running)
    return { ...emptySummary(), skipped: "a pass is already running" };
  state.running = true;
  const summary = emptySummary();
  let offers = [];
  let lastError = "";
  try {
    const ctx = {
      now: asDate(now),
      bp: readBp(),
      summary,
      sets: new Map(),
      changed: false,
      cap: null,
    };
    offers = await deps.BulkOffer.find(
      { $or: [{ open: true }, { "reserved.state": "retiring" }] },
      { history: 0 },
    )
      .sort({ lastSyncAt: 1, _id: 1 })
      .limit(OFFER_LIMIT)
      .lean();
    for (const offer of offers) {
      try {
        await handleOffer(offer, ctx);
      } catch (e) {
        summary.errors++;
        lastError = errText(e);
        await noteLoopError(offer, lastError);
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

module.exports = {
  RETIRE_GRACE_MS,
  READ_OFFER_EVERY_MS,
  start,
  stop,
  status,
  runOnce,
  retireUnits,
  reconcileUnits,
  heartbeatLine,
  __setDeps,
  __resetDeps,
};
