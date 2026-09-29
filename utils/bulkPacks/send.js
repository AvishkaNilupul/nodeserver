// ---------------------------------------------------------------------------
// Bulk packs — the owner's buttons (docs/bulk-packs/MODULES.md §send.js).
//
// Send, refill, pause, resume and withdraw ONE bulk offer. Everything here is
// an owner click routed through routes/bulkPackRoutes.js; the maintenance loop
// (utils/bulkPacks/loop.js) never publishes (CONTRACT §2, I8).
//
// Every export answers { success, status, message?, offer? } and NEVER throws:
// `status` is the HTTP code the router uses (200/400/404/409/500/502).
//
// The rules this file keeps, because each one has cost real money before
// (docs/bulk-packs/CONTRACT.md §4):
//   * Accounts are reserved only through stock.reserve (claimAccountsForSet)
//     and handed back only through stock.releaseUnits, which releases an
//     account only while stock.isStillOurs says the reservation is still this
//     set's under this market's tag (I1). Never a tag-wide release.
//   * A unit is FREE only with no deliveredAt, no messagedAt and no orderId
//     (I2). Anything else is in flight or sold: it is never pulled, never
//     released, never "retired".
//   * The row's units[] is written only with an atomic $push / conditional
//     $pull — the fulfillers save the whole array concurrently (I3).
//   * Nothing is published unless a sale of it would be delivered: the
//     delivery gate is read before every publish, refill and resume (I4).
//   * A credential that may be sitting in a live Gameflip delivery code is
//     never handed back to stock until a delist has SUCCEEDED (I9). When that
//     cannot be proven the accounts stay reserved — one pack of stock lost at
//     worst, never one account sold to two buyers.
//   * Only rows whose bulkOfferId is this offer's are ever written (I11).
//
// Dependencies are lazy and injectable (CONTRACT §9): tests replace any of
// them with __setDeps and never touch the network or utils/settings.json.
// ---------------------------------------------------------------------------
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

// ---------------------------------------------------------------------------
// Lazy dependencies
// ---------------------------------------------------------------------------
let overrides = {};
const deps = {
  get settings() {
    return overrides.settings || require("../settings");
  },
  get config() {
    return overrides.config || require("./config");
  },
  get BulkOffer() {
    return overrides.BulkOffer || require("../../models/BulkOffer");
  },
  get MarketplaceListing() {
    return (
      overrides.MarketplaceListing || require("../../models/MarketplaceListing")
    );
  },
  get DropSet() {
    return overrides.DropSet || require("../../models/DropSet");
  },
  get pricing() {
    return overrides.pricing || require("./pricing");
  },
  get copy() {
    return overrides.copy || require("./copy");
  },
  get stock() {
    return overrides.stock || require("./stock");
  },
  get farmCapacity() {
    return overrides.farmCapacity || require("./farmCapacity");
  },
  // The ONLY module that talks to a marketplace (MODULES §markets.js).
  get markets() {
    return overrides.markets || require("./markets");
  },
  // Phase 1 of CONTRACT I10 (retireUnits) is the loop's; withdraw reuses it.
  get loop() {
    return overrides.loop || require("./loop");
  },
  get proposals() {
    return overrides.proposals || require("./proposals");
  },
  // The Listings page's own no-claim delist hooks (routes/marketplaceRoutes.js).
  get noclaimListings() {
    return overrides.noclaimListings || require("../noclaimListings");
  },
  get noclaimStock() {
    return overrides.noclaimStock || require("../noclaimStock");
  },
  // The REAL farm-order parsers (CONTRACT I5): Eldorado's, and G2G's, which
  // resolves games through the PlayerAuctions resolver instead.
  get eldoradoFarmService() {
    return overrides.eldoradoFarmService || require("../eldoradoFarmService");
  },
  get g2gFarmService() {
    return overrides.g2gFarmService || require("../g2gFarmService");
  },
  // Pure classifier of a delist error ("sold" / "gone" / ""), the one the
  // Listings page's delist route uses. It makes no marketplace call.
  get delistOutcome() {
    return overrides.delistOutcome || require("../marketplaces").delistOutcome;
  },
  get logEvent() {
    return overrides.logEvent || require("../systemLog").logEvent;
  },
  get sendTelegram() {
    return overrides.sendTelegram || require("../telegram").sendTelegram;
  },
};

function __setDeps(partial) {
  overrides = {
    ...overrides,
    ...(partial && typeof partial === "object" ? partial : {}),
  };
}
function __resetDeps() {
  overrides = {};
}

// ---------------------------------------------------------------------------
// Constants and small helpers
// ---------------------------------------------------------------------------

// Markets where one unit is one account and the tier is the offer's minimum
// order (CONTRACT §2). Gameflip sells one fixed pack per listing instead.
const QTY_MARKETS = ["eldorado", "g2g"];

// A "sending" offer older than this is an interrupted send (a crash between
// reserve, publish and record), not one still in progress: gameflipPublish
// alone can back off for a couple of minutes inside Gameflip's rate limiter.
const SENDING_STALE_MS = 15 * 60 * 1000;

// The most accounts one click may put on (or add to) an offer. A typo guard:
// the page defaults to bp.unitsPerOffer (at most 80).
const MAX_UNITS = 500;

const LABELS = {
  eldorado: "Eldorado",
  g2g: "G2G",
  gameflip: "Gameflip",
  digiseller: "Plati (Digiseller)",
  plati: "Plati",
  ggsel: "GGSel",
};
const SOURCE_LABELS = {
  dropset: "farmed-account",
  noclaim: "no-claim",
  farm: "farming",
};

function label(market) {
  return LABELS[market] || String(market || "?");
}

function errMsg(e) {
  return String((e && e.message) || e || "unknown error");
}

function money(n) {
  return "$" + (Number(n) || 0).toFixed(2);
}

function has(obj, key) {
  return (
    typeof key === "string" && Object.prototype.hasOwnProperty.call(obj, key)
  );
}

function isIdLike(id) {
  return /^[a-f0-9]{24}$/i.test(String(id || ""));
}

// CONTRACT I2.
function isFree(u) {
  return !!u && !u.deliveredAt && !u.messagedAt && !u.orderId;
}

// What the offer can honestly advertise: FREE units on its row that it still
// holds on_offer. A retiring unit a fulfiller's whole-array save put back is
// on the row and free, but it is on its way out and must not be sold.
function sellableCount(row, offer) {
  const onOffer = new Set(
    ((offer && offer.reserved) || [])
      .filter((r) => r && r.state === "on_offer")
      .map((r) => String(r.accountId)),
  );
  return ((row && row.units) || []).filter(
    (u) => isFree(u) && onOffer.has(String(u.accountId)),
  ).length;
}

// A whole number from a number or a digit string; anything else is NaN.
function toInt(v) {
  if (typeof v === "number") return Number.isInteger(v) ? v : NaN;
  if (typeof v === "string" && /^\s*\d+\s*$/.test(v)) return Number(v.trim());
  return NaN;
}

function isDupKey(e) {
  return !!e && (e.code === 11000 || /E11000/.test(String(e.message || "")));
}

function result(status, message, extra) {
  return {
    success: status === 200,
    status,
    ...(message ? { message } : {}),
    ...(extra || {}),
  };
}

function hist(action, detail, actor) {
  return {
    at: new Date(),
    action,
    detail: String(detail || "").slice(0, 500),
    actor: String(actor || ""),
  };
}

function priceText(offer) {
  return offer.market === "gameflip"
    ? "pack of " + offer.minQty + " for " + money(offer.packPrice)
    : money(offer.unitPrice) + " each";
}

// Telegram is never awaited and can never break an action (CONTRACT I13).
function alert(text) {
  try {
    const p = deps.sendTelegram(String(text));
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {
    /* an alert must never break the action it reports */
  }
}

// Audit trail (CONTRACT I13). logEvent is best-effort already; the try is for
// an injected one that is not.
async function audit({
  action,
  severity = "info",
  message = "",
  offer,
  actor,
  meta,
}) {
  try {
    await deps.logEvent({
      category: "bulk",
      action,
      severity,
      actor: String(actor || "") || "system",
      subject: offer
        ? (label(offer.market) + " " + String(offer.title || "")).slice(0, 200)
        : "",
      ...(offer && offer._id ? { subjectId: offer._id } : {}),
      // SystemEvent stores the text as `detail`; `message` is the contract's
      // name for the same thing.
      detail: message,
      message,
      meta: {
        ...(offer
          ? {
              offerId: String(offer._id || ""),
              market: offer.market,
              source: offer.source,
              minQty: offer.minQty,
            }
          : {}),
        ...(meta || {}),
      },
    });
  } catch {
    /* audit is best-effort */
  }
}

function invalidateProposals() {
  try {
    const p = deps.proposals;
    if (p && typeof p.invalidate === "function") p.invalidate();
  } catch {
    /* a stale proposal list is cosmetic */
  }
}

// One action per offer at a time, in-process (CONTRACT I7: the router and the
// loop are the only callers, both in the server process). A double-clicked
// Withdraw must not run two delists and two retirements side by side.
const locks = new Map();
async function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const mine = prev.then(() => new Promise((r) => (release = r)));
  locks.set(key, mine);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === mine) locks.delete(key);
  }
}

async function guarded(what, fn) {
  try {
    return await fn();
  } catch (e) {
    console.error("bulkPacks " + what + " failed:", errMsg(e));
    return result(500, "Server error: " + errMsg(e));
  }
}

// The bulk-pack settings, failing CLOSED: an unreadable settings store reads as
// "switched off" rather than as permission to publish.
function readBulkPacks() {
  try {
    const bp = deps.settings.getBulkPacks();
    return bp && typeof bp === "object" ? bp : null;
  } catch (e) {
    console.error("bulkPacks: settings unreadable:", errMsg(e));
    return null;
  }
}

// The set's grid cover is a temp file (utils/setImage writes into
// os.tmpdir()); the auto-lister deletes it after publishing and so do we. A
// path outside the temp dir is never touched.
async function coverFor(set) {
  try {
    const p = await deps.markets.coverForSet(set);
    return typeof p === "string" ? p : "";
  } catch (e) {
    console.error(
      "bulkPacks cover for set " + String(set && set._id) + ":",
      errMsg(e),
    );
    return "";
  }
}
function dropCover(p) {
  if (!p || typeof p !== "string") return;
  const tmp = path.resolve(os.tmpdir()) + path.sep;
  if (!path.resolve(p).startsWith(tmp)) return;
  fsp.unlink(p).catch(() => {});
}

async function loadOffer(offerId) {
  if (!isIdLike(offerId)) return null;
  return deps.BulkOffer.findById(String(offerId)).lean();
}

async function freshOffer(id) {
  return deps.BulkOffer.findById(id).lean();
}

// The offer's own row, and only it (I11).
async function ownRow(offer) {
  if (!offer || !offer.listing) return null;
  return deps.MarketplaceListing.findOne({
    _id: offer.listing,
    bulkOfferId: offer._id,
  }).lean();
}

// The row shape every unit takes (mirrors autoLister.publishEldoradoShare /
// publishG2gShare, plus messagedAt, which G2G's hand-over stamps).
function unitDoc(a, at) {
  return {
    contentId: "",
    accountId: String(a.accountId),
    login: String(a.login || ""),
    addedAt: at,
    deliveredAt: null,
    orderId: "",
    messagedAt: null,
  };
}

function reservedEntry(a, at) {
  return {
    accountId: String(a.accountId),
    login: String(a.login || ""),
    state: "on_offer",
    orderId: "",
    at,
    changedAt: null,
    reason: "",
  };
}

function uniqIds(list) {
  return [...new Set((list || []).map((x) => String(x || "")).filter(Boolean))];
}

// Move reserved[] entries of these accounts (still on_offer or retiring) to
// `state`. $elemMatch on the state as well as the id: an account released
// earlier and reserved again on a refill has two entries, and only the live
// one may move.
async function markEntries(offerId, accountIds, state, reason, extra = {}) {
  const now = new Date();
  for (const id of uniqIds(accountIds)) {
    const set = {
      "reserved.$.state": state,
      "reserved.$.changedAt": now,
      "reserved.$.reason": String(reason || ""),
    };
    if (extra.orderIds && extra.orderIds[id] != null) {
      set["reserved.$.orderId"] = String(extra.orderIds[id]);
    }
    try {
      await deps.BulkOffer.updateOne(
        {
          _id: offerId,
          reserved: {
            $elemMatch: {
              accountId: id,
              state: { $in: ["on_offer", "retiring"] },
            },
          },
        },
        { $set: set },
      );
    } catch (e) {
      console.error(
        "bulkPacks: could not mark " + id + " " + state + ":",
        errMsg(e),
      );
    }
  }
}

// Hand accounts back to stock NOW (CONTRACT I1): stock.releaseUnits releases
// each one only while its reservation is still this set's under this market's
// tag. Only for accounts no listing of ours can deliver any more — never for a
// credential that may still be in a live Gameflip code.
//   released          -> "released"
//   skipped not ours  -> "released" with reason "not ours" (nothing of ours
//                        left to hand back — the loop's convention)
//   anything else, or a release that threw -> "retiring", so the loop's phase
//                        2 re-reads the row and releases it (after isStillOurs)
async function releaseAndRecord(offerId, set, market, accountIds, reason) {
  const ids = uniqIds(accountIds);
  const out = { released: [], notOurs: [], pending: [] };
  if (!ids.length) return out;
  let r = null;
  let failure = "";
  try {
    r = await deps.stock.releaseUnits({ set, market, accountIds: ids });
  } catch (e) {
    failure = errMsg(e);
  }
  if (!r) {
    out.pending = ids;
    await markEntries(
      offerId,
      ids,
      "retiring",
      reason +
        " — release failed (" +
        (failure || "no answer") +
        "), the maintenance loop retries",
    );
    return out;
  }
  const released = uniqIds(r.released).filter((id) => ids.includes(id));
  const notOurs = (Array.isArray(r.skipped) ? r.skipped : [])
    .filter((s) => s && /not ours/i.test(String(s.reason || "")))
    .map((s) => String(s.accountId || ""))
    .filter((id) => ids.includes(id) && !released.includes(id));
  const done = new Set([...released, ...notOurs]);
  const pending = ids.filter((id) => !done.has(id));
  await markEntries(offerId, released, "released", reason);
  await markEntries(offerId, notOurs, "released", "not ours");
  if (pending.length) {
    await markEntries(
      offerId,
      pending,
      "retiring",
      reason + " — not released yet, the maintenance loop retries",
    );
  }
  out.released = released;
  out.notOurs = notOurs;
  out.pending = pending;
  return out;
}

// Close an open offer. Every state write carries `open` and `closedAt`
// (CONTRACT §5); the model's update hook would fill them in, but the writer
// says so itself.
async function closeOffer(
  offerId,
  state,
  { lastError = "", action, detail, actor, extra = {} } = {},
) {
  await deps.BulkOffer.updateOne(
    { _id: offerId, open: true },
    {
      $set: {
        state,
        open: false,
        closedAt: new Date(),
        lastError: String(lastError || "").slice(0, 400),
        advertisedQty: 0,
        ...extra,
      },
      $push: { history: hist(action || state, detail || lastError, actor) },
    },
  );
}

async function noteError(offerId, message, actor, action = "error") {
  try {
    await deps.BulkOffer.updateOne(
      { _id: offerId },
      {
        $set: { lastError: String(message || "").slice(0, 400) },
        $push: { history: hist(action, message, actor) },
      },
    );
  } catch {
    /* the caller answers with the message anyway */
  }
}

// ---------------------------------------------------------------------------
// sendOffer
// ---------------------------------------------------------------------------

// A refusal BEFORE any offer exists: nothing to close, nothing to release.
async function refuse(status, message, input, actor) {
  await audit({
    action: "send_refused",
    severity: status >= 500 ? "error" : "warn",
    message,
    actor,
    meta: {
      source: String((input && input.source) || ""),
      market: String((input && input.market) || ""),
      minQty: input && input.minQty,
      setId: String((input && input.setId) || ""),
      game: String((input && input.game) || ""),
    },
  });
  return result(status, message);
}

// A failure AFTER the offer was created: it closes the offer "error" with the
// reason (MODULES §send.js step 6). 5xx failures also page the owner.
async function failSend(
  ctx,
  status,
  message,
  { telegram = status >= 500 } = {},
) {
  const { offer, actor } = ctx;
  try {
    await closeOffer(offer._id, "error", {
      lastError: message,
      action: "send_failed",
      detail: message,
      actor,
    });
  } catch (e) {
    console.error(
      "bulkPacks: could not close failed offer " + String(offer._id) + ":",
      errMsg(e),
    );
  }
  await audit({
    action: "send_failed",
    severity: status >= 500 ? "error" : "warn",
    message,
    offer,
    actor,
    meta: { status },
  });
  if (telegram) {
    alert(
      "⚠️ Bulk pack send FAILED\n\n" +
        String(offer.title || "") +
        "\n" +
        label(offer.market) +
        " — " +
        message,
    );
  }
  let fresh = null;
  try {
    fresh = await freshOffer(offer._id);
  } catch {
    fresh = null;
  }
  return result(status, message, fresh ? { offer: fresh } : {});
}

function parseUnits(v) {
  if (v === undefined || v === null || v === "") return { value: null };
  const n = toInt(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_UNITS) {
    return {
      error:
        "Accounts on this offer must be a whole number from 1 to " + MAX_UNITS,
    };
  }
  return { value: n };
}

// CONTRACT I5: a farming title must come back through the REAL order parsers
// as exactly this game and term, or the farm service would provision the
// wrong thing (or nothing) for a paid order. Returns "" when it does.
async function farmTitleProblem({ title, game, days, market }) {
  const efs = deps.eldoradoFarmService;
  const farmRe = efs.FARM_TITLE || deps.config.FARM_TITLE_RE;
  if (!farmRe.test(title)) {
    return "the farm services would not read it as an Automatic Farming offer";
  }
  const term = efs.termToDays(title);
  if (term !== days) {
    return "the term reads back as " + term + " day(s), not " + days;
  }
  const raw = title.split(/\s+Twitch\s+Drops\b/i)[0].trim();
  const readGame = await efs.canonicalGame(raw, await efs.knownFarmGames());
  if (readGame !== game) {
    return (
      'the game reads back as "' +
      (readGame || "(unknown)") +
      '", not "' +
      game +
      '"'
    );
  }
  // The market's own parser as well: G2G resolves games with a different
  // (looser) resolver than Eldorado, and it is G2G's that reads a G2G order.
  let parsed = null;
  if (market === "g2g") {
    parsed = await deps.g2gFarmService.parseFarmOrder({ title });
  } else {
    parsed = await efs.parseFarmOrder({
      orderOfferDetails: { offerTitle: title },
    });
  }
  if (!parsed || parsed.game !== game || parsed.days !== days) {
    return (
      label(market) +
      "'s order parser reads it as " +
      (parsed
        ? '"' +
          (parsed.game || "(unknown)") +
          '" for ' +
          parsed.days +
          " day(s)"
        : "not a farming order")
    );
  }
  return "";
}

async function sendOffer(input = {}) {
  const actor = String((input && input.actor) || "");
  return guarded("send", () => sendOfferInner(input || {}, actor));
}

async function sendOfferInner(input, actor) {
  const config = deps.config;
  const settings = deps.settings;

  // Step 1 — switched on, a real source/market/tier, and a gate that is open.
  const bp = readBulkPacks();
  if (!bp || bp.enabled !== true) {
    return refuse(409, "Bulk packs are switched off", input, actor);
  }
  const source = String(input.source || "")
    .trim()
    .toLowerCase();
  const market = String(input.market || "")
    .trim()
    .toLowerCase();
  if (!has(config.SOURCE_MARKETS, source)) {
    return refuse(400, 'Unknown pack source "' + source + '"', input, actor);
  }
  if (config.BLOCKED_MARKETS.includes(market)) {
    return refuse(
      400,
      label(market) + " is blocked (owner block since 2026-09-28)",
      input,
      actor,
    );
  }
  if (!config.SOURCE_MARKETS[source].includes(market)) {
    return refuse(
      400,
      (market ? label(market) : "That market") +
        " does not carry " +
        SOURCE_LABELS[source] +
        " packs",
      input,
      actor,
    );
  }
  if (!config.isMarketAllowed(market, bp)) {
    return refuse(
      400,
      label(market) + " is switched off for bulk packs",
      input,
      actor,
    );
  }
  const tier = config.tierFor(bp, input.minQty);
  if (!tier) {
    return refuse(
      400,
      "No bulk tier has a minimum of " +
        String(input.minQty) +
        " — the tiers are " +
        ((bp.tiers || []).map((t) => t.minQty + "+").join(", ") || "none"),
      input,
      actor,
    );
  }
  const minQty = tier.minQty;
  const discountPct = tier.discountPct;
  const unitsIn = parseUnits(input.units);
  if (unitsIn.error) return refuse(400, unitsIn.error, input, actor);
  const units = unitsIn.value;
  const isPack = source === "dropset" && market === "gameflip";
  if (units != null && !isPack && units < minQty) {
    return refuse(
      400,
      "An offer with a minimum order of " +
        minQty +
        " must carry at least " +
        minQty +
        " accounts",
      input,
      actor,
    );
  }
  const gate = config.currentGate(market, source);
  if (!gate || !gate.ok) {
    return refuse(
      409,
      (gate && gate.reason) ||
        "Delivery is not switched on for " + label(market),
      input,
      actor,
    );
  }

  // Step 2 — the product.
  let set = null;
  let game = "";
  let days = 0;
  if (source === "farm") {
    days = toInt(input.days);
    if (!Number.isInteger(days) || !(bp.farmDurations || []).includes(days)) {
      return refuse(
        400,
        "The farming term must be one of " +
          ((bp.farmDurations || []).join(", ") || "(none configured)") +
          " days",
        input,
        actor,
      );
    }
    const wanted = String(input.game || "").trim();
    if (!wanted) return refuse(400, "Pick the game to farm", input, actor);
    // Resolve to the name the farm itself knows. The title is built from this
    // and must read back as it (I5), and the slot is keyed by it.
    const efs = deps.eldoradoFarmService;
    game = await efs.canonicalGame(wanted, await efs.knownFarmGames());
    if (!game) {
      return refuse(
        409,
        'The farm has no campaigns on record for "' +
          wanted +
          '" — it cannot farm it',
        input,
        actor,
      );
    }
  } else {
    const setId = String(input.setId || "").trim();
    if (!setId) return refuse(400, "Pick the set to sell", input, actor);
    if (!isIdLike(setId)) return refuse(404, "Set not found", input, actor);
    set = await deps.DropSet.findById(setId).lean();
    if (!set) return refuse(404, "Set not found", input, actor);
    if (set.custom === true) {
      return refuse(
        409,
        "A custom set cannot be sold as a bulk pack",
        input,
        actor,
      );
    }
    if ((set.stockSource === "noclaim") !== (source === "noclaim")) {
      return refuse(
        409,
        set.stockSource === "noclaim"
          ? "This is a no-claim set — send it as a no-claim pack"
          : "This set is not a no-claim set — send it as a farmed-account pack",
        input,
        actor,
      );
    }
    if (!Array.isArray(set.items) || !set.items.length) {
      return refuse(409, "This set has no items to sell", input, actor);
    }
    try {
      game = String((await deps.markets.gameOfSet(set)) || "").trim();
    } catch {
      game = "";
    }
    if (!game)
      return refuse(
        409,
        "Could not tell which game this set belongs to",
        input,
        actor,
      );
    if (source === "dropset" && settings.isNoClaimGame(game)) {
      return refuse(
        409,
        game +
          " is a no-claim game — its claimed drops are worthless to a buyer; sell it as a no-claim pack",
        input,
        actor,
      );
    }
  }

  // Step 3 — the price, fixed now and never changed while the offer is live.
  const pricing = deps.pricing;
  let anchor = 0;
  let anchorBasis = "";
  let anchorRow = null;
  let unitPrice = 0;
  let packPrice = 0;
  if (source === "farm") {
    const table = (bp.farmPrices && bp.farmPrices[market]) || {};
    anchor = Number(table[String(days)]) || 0;
    anchorBasis = "farm-table";
    unitPrice =
      Number(
        await pricing.farmUnitPrice({
          farmPrices: bp.farmPrices,
          market,
          days,
          discountPct,
        }),
      ) || 0;
    if (!(unitPrice > 0)) {
      return refuse(
        409,
        "No farming price is set for " + label(market) + " " + days + " days",
        input,
        actor,
      );
    }
  } else {
    // Our own single listings of this set on this market, lowest first. Bulk
    // rows never anchor a bulk price (their prices are already discounted).
    // price > 0 and the cap are pickAnchor's own candidate rule, applied in
    // the query so the read stays bounded (I12).
    const rows = await deps.MarketplaceListing.find(
      {
        set: set._id,
        marketplace: market,
        status: "active",
        bulkOfferId: null,
        price: { $gt: 0 },
      },
      { price: 1, set: 1, marketplace: 1, status: 1, bulkOfferId: 1, title: 1 },
    )
      .sort({ price: 1 })
      .limit(50)
      .lean();
    const a = (await pricing.pickAnchor({ rows, set, market })) || {};
    anchor = Number(a.anchor) || 0;
    anchorBasis = String(a.basis || "");
    if (!(anchor > 0)) {
      return refuse(
        409,
        "No price reference for this set on " +
          label(market) +
          " — give the set a price or list it singly first",
        input,
        actor,
      );
    }
    anchorRow = a.listingId
      ? rows.find((r) => String(r._id) === String(a.listingId)) || null
      : null;
    unitPrice =
      Number(await pricing.unitPrice({ anchor, discountPct, market })) || 0;
    if (isPack)
      packPrice =
        Number(
          await pricing.packPrice({ anchor, discountPct, size: minQty }),
        ) || 0;
    if (!(unitPrice > 0) || (isPack && !(packPrice > 0))) {
      return refuse(
        409,
        "Could not work out a price for this pack",
        input,
        actor,
      );
    }
  }

  // Step 4 — the copy.
  const copy = deps.copy;
  let title = "";
  let description = "";
  try {
    if (source === "farm") {
      title = await copy.farmTitle({ game, days, minQty, market });
      description = await copy.farmDescription({ game, days, minQty });
    } else {
      const baseTitle = await copy.baseTitleForSet({ set, anchorRow });
      title = await copy.accountsTitle({
        baseTitle,
        market,
        minQty,
        discountPct,
      });
      description = await copy.accountsDescription({
        setName: set.name,
        items: (set.items || []).map((i) => ({
          name: i.name,
          qty: Number(i.qty) || 1,
        })),
        game,
        market,
        minQty,
        source,
      });
    }
  } catch (e) {
    return refuse(
      409,
      "Could not write the offer's title: " + errMsg(e),
      input,
      actor,
    );
  }
  title = String(title || "").trim();
  description = String(description || "");
  if (!title)
    return refuse(409, "Could not write the offer's title", input, actor);
  if (source === "farm") {
    const why = await farmTitleProblem({ title, game, days, market });
    if (why) {
      return refuse(
        409,
        "The farming title would not be read back correctly: " + why,
        input,
        actor,
      );
    }
  } else if (config.FARM_TITLE_RE.test(title)) {
    // An account title the farm services would grab as a rent-farm order.
    return refuse(
      409,
      'The title reads as an "Automatic Farming" offer — refusing to publish it',
      input,
      actor,
    );
  }

  // Step 5 — the offer record. The partial unique index on slotKey is what
  // turns a second click on the same slot into a 409 (CONTRACT I6).
  const kind = config.KIND_OF_SOURCE[source];
  const slotKey = config.slotKey({
    kind,
    source,
    setId: set ? String(set._id) : "",
    game,
    days,
    market,
    minQty,
  });
  const alreadyLive = () =>
    refuse(
      409,
      "This pack is already live on " +
        label(market) +
        " — one open offer per slot; withdraw it first",
      input,
      actor,
    );
  // The index is the guarantee. The in-process slot lock plus the look-up is a
  // backstop for the window after a deploy before Mongo has built the index.
  const created = await withLock("slot:" + slotKey, async () => {
    if (await deps.BulkOffer.exists({ slotKey, open: true })) return null;
    try {
      return await deps.BulkOffer.create({
        kind,
        source,
        market,
        set: set ? set._id : null,
        setName: set ? String(set.name || "") : "",
        game,
        days: source === "farm" ? days : 0,
        minQty,
        discountPct,
        anchorPrice: anchor,
        anchorBasis,
        unitPrice,
        packPrice,
        title,
        description,
        state: "sending",
        open: true,
        slotKey,
        createdBy: actor,
        history: [
          hist(
            "sending",
            label(market) +
              " · " +
              SOURCE_LABELS[source] +
              " · min " +
              minQty +
              " (" +
              discountPct +
              "% off)",
            actor,
          ),
        ],
      });
    } catch (e) {
      if (isDupKey(e)) return null;
      throw e;
    }
  });
  if (!created) return alreadyLive();
  const offer = created.toObject();

  // Step 6 — reserve, publish, record. Any failure closes the offer.
  const ctx = {
    bp,
    offer,
    actor,
    source,
    market,
    set,
    game,
    days,
    minQty,
    discountPct,
    units,
    title,
    description,
    unitPrice,
    packPrice,
    got: [],
    published: false,
    externalId: "",
    url: "",
    rowId: null,
  };
  try {
    if (source === "farm") return await sendFarm(ctx);
    if (source === "noclaim") return await sendNoclaim(ctx);
    if (isPack) return await sendGameflipPack(ctx);
    return await sendDropsetQty(ctx);
  } catch (e) {
    return abortSend(ctx, e);
  }
}

// An unexpected throw inside step 6. What may be handed back depends on how
// far the send got.
async function abortSend(ctx, e) {
  const msg = errMsg(e);
  console.error("bulkPacks send " + String(ctx.offer._id) + " aborted:", msg);
  if (ctx.rowId) {
    // The row exists and sells; only the offer's own record failed to update.
    await noteError(
      ctx.offer._id,
      "send finished but could not be recorded: " + msg,
      ctx.actor,
    );
    alert(
      "⚠️ Bulk offer is LIVE but its record could not be updated\n\n" +
        ctx.title +
        "\n" +
        label(ctx.market) +
        " " +
        ctx.externalId +
        "\n" +
        msg,
    );
    return result(
      500,
      "The offer is live on " +
        label(ctx.market) +
        " but its record could not be updated: " +
        msg,
    );
  }
  if (ctx.published) return orphanAfterPublish(ctx, msg);
  if (ctx.got.length) {
    await releaseAndRecord(
      ctx.offer._id,
      ctx.set,
      ctx.market,
      ctx.got.map((a) => a.accountId),
      "send failed",
    );
  }
  return failSend(ctx, 500, "Send failed: " + msg);
}

// Reserve n accounts (CONTRACT I1) and record them on the offer at once, so a
// crash after this point still knows what the offer holds.
async function reserveInto(ctx, n) {
  const raw = await deps.stock.reserve({ set: ctx.set, n, market: ctx.market });
  const seen = new Set();
  const got = [];
  for (const a of Array.isArray(raw) ? raw : []) {
    const id = String((a && a.accountId) || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    got.push({ accountId: id, login: String((a && a.login) || "") });
  }
  if (!got.length) return got;
  const at = new Date();
  try {
    await deps.BulkOffer.updateOne(
      { _id: ctx.offer._id },
      { $push: { reserved: { $each: got.map((a) => reservedEntry(a, at)) } } },
    );
  } catch (e) {
    // Untracked reservations would be stranded: hand them straight back.
    try {
      await deps.stock.releaseUnits({
        set: ctx.set,
        market: ctx.market,
        accountIds: got.map((a) => a.accountId),
      });
    } catch (e2) {
      console.error(
        "bulkPacks: release after a failed record also failed:",
        errMsg(e2),
      );
    }
    throw new Error("could not record the reserved accounts: " + errMsg(e));
  }
  ctx.got = got;
  return got;
}

// The publish landed; record where, before anything else can fail.
async function recordPublished(ctx, pub) {
  ctx.published = true;
  ctx.externalId = String((pub && pub.externalId) || "").trim();
  ctx.url = String((pub && pub.url) || "");
  try {
    await deps.BulkOffer.updateOne(
      { _id: ctx.offer._id },
      {
        $set: {
          externalId: ctx.externalId,
          url: ctx.url,
          ...(ctx.rowId ? { listing: ctx.rowId } : {}),
        },
      },
    );
  } catch (e) {
    console.error(
      "bulkPacks: could not record published offer " + ctx.externalId + ":",
      errMsg(e),
    );
  }
}

async function finalizeLive(ctx, fields, detail) {
  const set = {
    state: "live",
    open: true,
    lastError: "",
    externalId: ctx.externalId,
    url: ctx.url,
    ...fields,
  };
  await deps.BulkOffer.updateOne(
    { _id: ctx.offer._id },
    { $set: set, $push: { history: hist("sent", detail, ctx.actor) } },
  );
  const offer = await freshOffer(ctx.offer._id);
  const message = "Live on " + label(ctx.market) + " — " + detail;
  await audit({
    action: "sent",
    message,
    offer,
    actor: ctx.actor,
    meta: { externalId: ctx.externalId },
  });
  alert(
    "📦 Bulk offer live: " +
      offer.title +
      " — " +
      label(offer.market) +
      ", " +
      priceText(offer) +
      (offer.url ? "\n\n" + offer.url : ""),
  );
  invalidateProposals();
  return result(200, message, { offer });
}

// A publish that went up while its row did not (or answered without an id).
// eldorado/g2g: pause best effort, then release — with no row, no fulfiller
// can deliver those accounts, whatever state the orphan offer is in.
// gameflip: the credentials ride in the listing's code, so they are released
// only once the delist SUCCEEDED (CONTRACT I9); otherwise they stay reserved.
async function orphanAfterPublish(ctx, why) {
  const { market, externalId } = ctx;
  // Did the row land after all (a write acknowledged but its answer lost)?
  // Then it is a normal live offer, and releasing would sell its units twice.
  if (ctx.source === "dropset") {
    let existing;
    try {
      existing = await deps.MarketplaceListing.findOne(
        { bulkOfferId: ctx.offer._id },
        { _id: 1, status: 1 },
      ).lean();
    } catch {
      existing = undefined; // cannot tell
    }
    if (existing) {
      ctx.rowId = existing._id;
      return finalizeLive(
        ctx,
        {
          listing: existing._id,
          advertisedQty: ctx.got.length,
          ...(market === "gameflip"
            ? { packPrice: ctx.packPrice }
            : { unitPrice: ctx.unitPrice }),
        },
        ctx.got.length + " account(s) (row recovered after a failed write)",
      );
    }
    if (existing === undefined) {
      // Cannot prove the row is absent: take the offer down, hand nothing back.
      let down = false;
      if (externalId) {
        try {
          if (market === "gameflip")
            await deps.markets.withdraw(market, externalId);
          else await deps.markets.pause(market, externalId);
          down = true;
        } catch {
          down = false;
        }
      }
      alert(
        "⚠️ Bulk offer orphan " +
          (down ? "taken off sale" : "STILL LIVE") +
          " — " +
          label(market) +
          " " +
          (externalId || "(no id)") +
          "\n\n" +
          ctx.title +
          "\n\n" +
          ctx.got.length +
          " reserved account(s) are KEPT reserved: the database could not be read to prove " +
          "no listing row holds them. " +
          (down ? "" : "Take the offer down by hand. ") +
          "Reason: " +
          why,
      );
      return failSend(
        ctx,
        500,
        "Published, but the listing row could not be written (" +
          why +
          ") — reservations kept",
        {
          telegram: false,
        },
      );
    }
  }

  let takenDown = false;
  let downErr = "";
  if (externalId) {
    try {
      if (market === "gameflip")
        await deps.markets.withdraw(market, externalId);
      else await deps.markets.pause(market, externalId);
      takenDown = true;
    } catch (e) {
      downErr = errMsg(e);
      // Already paused / gone counts as off sale on a quantity market. On
      // Gameflip only a successful delist proves nobody bought the code.
      if (market !== "gameflip" && deps.delistOutcome(downErr))
        takenDown = true;
    }
  } else {
    downErr = "the market answered without an offer id";
  }

  let rel = { released: [], notOurs: [], pending: [] };
  const ids = ctx.got.map((a) => a.accountId);
  const mayRelease = market !== "gameflip" || takenDown;
  if (ids.length && mayRelease) {
    rel = await releaseAndRecord(
      ctx.offer._id,
      ctx.set,
      market,
      ids,
      "orphan offer",
    );
  }
  const kept = ids.length && !mayRelease;
  alert(
    "⚠️ Bulk offer orphan " +
      (takenDown ? "paused" : "STILL LIVE") +
      " — " +
      label(market) +
      " " +
      (externalId || "(no id)") +
      "\n\n" +
      ctx.title +
      "\n\n" +
      "Published, but the listing row could not be written: " +
      why +
      "\n" +
      (takenDown
        ? ""
        : "Take it down by hand NOW — no row means no order on it can be delivered. " +
          (downErr ? "(" + downErr + ")\n" : "")) +
      (ids.length
        ? kept
          ? ids.length +
            " reserved account(s) are KEPT reserved until the Gameflip listing is confirmed gone."
          : rel.released.length +
            " of " +
            ids.length +
            " reserved account(s) released."
        : ""),
  );
  await audit({
    action: "orphan",
    severity: "error",
    message:
      "orphan offer " + (takenDown ? "paused" : "still live") + ": " + why,
    offer: ctx.offer,
    actor: ctx.actor,
    meta: {
      externalId,
      takenDown,
      released: rel.released.length,
      kept: kept ? ids.length : 0,
    },
  });
  return failSend(
    ctx,
    500,
    "Published on " +
      label(market) +
      " but the listing row could not be written (" +
      why +
      ") — the offer was " +
      (takenDown ? "taken off sale" : "NOT taken off sale (do it by hand)") +
      (ids.length
        ? kept
          ? "; its accounts stay reserved"
          : "; its accounts were released"
        : ""),
    { telegram: false },
  );
}

// While a send publishes, its offer is "sending" with reserved[] recorded but
// no row yet (Gameflip's publish alone can back off for over a minute). A
// maintenance pass that ran in that window and read "row missing" may have
// moved some of those reservations. Before the offer goes live, every unit
// the new row carries must still be on_offer here. Returns the ones that are
// not.
async function unitsLostDuringSend(ctx) {
  const cur = await freshOffer(ctx.offer._id);
  const onOffer = new Set(
    ((cur && cur.reserved) || [])
      .filter((r) => r && r.state === "on_offer")
      .map((r) => String(r.accountId)),
  );
  return ctx.got.map((a) => a.accountId).filter((id) => !onOffer.has(id));
}

// Take units that lost their reservation off a quantity row (conditional $pull
// of the FREE unit only, CONTRACT I3) and advertise what is left.
async function dropLostUnits(ctx, rowId, lost) {
  for (const id of lost) {
    await deps.MarketplaceListing.updateOne(
      {
        _id: rowId,
        bulkOfferId: ctx.offer._id,
        units: {
          $elemMatch: {
            accountId: id,
            deliveredAt: null,
            messagedAt: null,
            orderId: "",
          },
        },
      },
      {
        $pull: {
          units: {
            accountId: id,
            deliveredAt: null,
            messagedAt: null,
            orderId: "",
          },
        },
        $inc: { qtyTarget: -1 },
      },
    ).catch((e) =>
      console.error(
        "bulkPacks: could not pull lost unit " + id + ":",
        errMsg(e),
      ),
    );
  }
  const row = await deps.MarketplaceListing.findOne({
    _id: rowId,
    bulkOfferId: ctx.offer._id,
  }).lean();
  const n = sellableCount(row, await freshOffer(ctx.offer._id));
  let note = "";
  try {
    await deps.markets.setQuantity(ctx.market, ctx.externalId, n);
  } catch (e) {
    note =
      " (quantity update failed: " +
      errMsg(e) +
      " — the maintenance loop retries)";
  }
  const message =
    lost.length +
    " account(s) lost their reservation while the offer was being sent and were taken off it; " +
    n +
    " left on offer" +
    note;
  alert(
    "⚠️ Bulk offer integrity: " +
      ctx.title +
      " — " +
      label(ctx.market) +
      "\n\n" +
      message,
  );
  await audit({
    action: "integrity_retired",
    severity: "warn",
    message,
    offer: ctx.offer,
    actor: ctx.actor,
    meta: { lost },
  });
  return { n, note };
}

// dropset on Eldorado / G2G: one offer, quantity = reserved accounts, minimum
// order = the tier. The accounts ride on the row as units[] for the existing
// fulfillers' reserved-units branch.
async function sendDropsetQty(ctx) {
  const { bp, set, market, minQty, units, offer } = ctx;
  const free = (await deps.stock.freeDropsetAccounts(set)).length;
  const surplus = free - bp.reserveSingles;
  const n = Math.min(units || bp.unitsPerOffer, surplus);
  if (!(n >= minQty)) {
    return failSend(
      ctx,
      409,
      "Only " +
        free +
        " free account(s) hold this bundle (keeping " +
        bp.reserveSingles +
        " for single listings) — a " +
        minQty +
        "+ offer needs " +
        (minQty + bp.reserveSingles),
    );
  }
  const got = await reserveInto(ctx, n);
  if (got.length < minQty) {
    await releaseAndRecord(
      offer._id,
      set,
      market,
      got.map((a) => a.accountId),
      "short reservation",
    );
    return failSend(
      ctx,
      409,
      "Only " +
        got.length +
        " of " +
        n +
        " account(s) could be reserved (a " +
        minQty +
        "+ offer needs " +
        minQty +
        ") — nothing was listed",
    );
  }

  const cover = await coverFor(set);
  let pub;
  try {
    pub = await deps.markets.publishAccounts({
      market,
      set,
      game: ctx.game,
      title: ctx.title,
      description: ctx.description,
      unitPrice: ctx.unitPrice,
      packPrice: 0,
      minQty,
      units: got.map((a) => ({ accountId: a.accountId, login: a.login })),
      coverPath: cover,
    });
  } catch (e) {
    const rel = await releaseAndRecord(
      offer._id,
      set,
      market,
      got.map((a) => a.accountId),
      "publish failed",
    );
    return failSend(
      ctx,
      502,
      label(market) +
        " refused the offer: " +
        errMsg(e) +
        " — " +
        rel.released.length +
        " of " +
        got.length +
        " reserved account(s) released",
    );
  } finally {
    dropCover(cover);
  }
  await recordPublished(ctx, pub);
  if (!ctx.externalId)
    return orphanAfterPublish(ctx, "the market answered without an offer id");

  const price =
    Number(pub && pub.price) > 0 ? Number(pub.price) : ctx.unitPrice;
  const now = new Date();
  let row;
  try {
    row = await deps.MarketplaceListing.create({
      set: set._id,
      marketplace: market,
      externalId: ctx.externalId,
      url: ctx.url,
      title: ctx.title,
      description: ctx.description,
      price,
      status: "active",
      origin: "manual",
      bulkOfferId: offer._id,
      note:
        "bulk pack: min " +
        minQty +
        " (" +
        ctx.discountPct +
        "% off), " +
        got.length +
        " reserved",
      autoDeliver: false,
      qtyTarget: got.length,
      units: got.map((a) => unitDoc(a, now)),
    });
  } catch (e) {
    return orphanAfterPublish(ctx, errMsg(e));
  }
  ctx.rowId = row._id;
  let advertised = got.length;
  let lostNote = "";
  const lost = await unitsLostDuringSend(ctx);
  if (lost.length) {
    const d = await dropLostUnits(ctx, row._id, lost);
    advertised = d.n;
    lostNote =
      "; " +
      lost.length +
      " account(s) lost their reservation mid-send and were taken off" +
      d.note;
  }
  return finalizeLive(
    ctx,
    { listing: row._id, advertisedQty: advertised, unitPrice: price },
    advertised +
      " account(s) at " +
      money(price) +
      " each, minimum order " +
      minQty +
      lostNote,
  );
}

// dropset on Gameflip: ONE listing = one pack of exactly minQty accounts,
// all of them inside its auto-delivery code (CONTRACT §2). Never relisted.
async function sendGameflipPack(ctx) {
  const { bp, set, market, minQty, offer } = ctx;
  const free = (await deps.stock.freeDropsetAccounts(set)).length;
  const surplus = free - bp.reserveSingles;
  if (!(surplus >= minQty)) {
    return failSend(
      ctx,
      409,
      "Only " +
        free +
        " free account(s) hold this bundle (keeping " +
        bp.reserveSingles +
        " for single listings) — a pack of " +
        minQty +
        " needs " +
        (minQty + bp.reserveSingles),
    );
  }
  const got = await reserveInto(ctx, minQty);
  if (got.length < minQty) {
    await releaseAndRecord(
      offer._id,
      set,
      market,
      got.map((a) => a.accountId),
      "short reservation",
    );
    return failSend(
      ctx,
      409,
      "Only " +
        got.length +
        " of " +
        minQty +
        " account(s) could be reserved — nothing was listed",
    );
  }

  const cover = await coverFor(set);
  let pub;
  try {
    pub = await deps.markets.publishAccounts({
      market,
      set,
      game: ctx.game,
      title: ctx.title,
      description: ctx.description,
      unitPrice: ctx.unitPrice,
      packPrice: ctx.packPrice,
      minQty,
      units: got.map((a) => ({ accountId: a.accountId, login: a.login })),
      coverPath: cover,
    });
  } catch (e) {
    // gameflipPublish discards its draft (credentials and all) before it
    // throws, so a refused publish leaves no code on Gameflip to protect.
    const rel = await releaseAndRecord(
      offer._id,
      set,
      market,
      got.map((a) => a.accountId),
      "publish failed",
    );
    return failSend(
      ctx,
      502,
      "Gameflip refused the pack: " +
        errMsg(e) +
        " — " +
        rel.released.length +
        " of " +
        got.length +
        " reserved account(s) released",
    );
  } finally {
    dropCover(cover);
  }
  await recordPublished(ctx, pub);
  if (!ctx.externalId)
    return orphanAfterPublish(ctx, "Gameflip answered without a listing id");

  const price =
    Number(pub && pub.price) > 0 ? Number(pub.price) : ctx.packPrice;
  const now = new Date();
  const logins = got.map((a) => a.login);
  let row;
  try {
    // unclaimedLots' lot row, minus the lot fields: accountLogin carries every
    // member so each "which rows hold this login" sweep sees them, and
    // qtyRemaining 0 means the fulfiller never relists it (H9).
    row = await deps.MarketplaceListing.create({
      set: set._id,
      marketplace: market,
      externalId: ctx.externalId,
      url: ctx.url,
      title: ctx.title,
      description: ctx.description,
      price,
      status: "active",
      origin: "manual",
      bulkOfferId: offer._id,
      note:
        "bulk pack: min " +
        minQty +
        " (" +
        ctx.discountPct +
        "% off), " +
        got.length +
        " reserved",
      autoDeliver: true,
      qtyRemaining: 0,
      qtyTarget: 0,
      accountId: "",
      accountLogin: logins.join(", "),
      units: got.map((a) => unitDoc(a, now)),
    });
  } catch (e) {
    return orphanAfterPublish(ctx, errMsg(e));
  }
  ctx.rowId = row._id;

  // A pack member whose reservation moved during the send still has its
  // credential inside the live code, and one account cannot be taken out of a
  // pack: the whole pack comes down (CONTRACT I9 order), or the owner is told.
  const lost = await unitsLostDuringSend(ctx);
  if (lost.length) {
    let delisted = false;
    let err = "";
    try {
      await deps.markets.withdraw("gameflip", ctx.externalId);
      delisted = true;
    } catch (e) {
      err = errMsg(e);
    }
    if (delisted) {
      await deps.MarketplaceListing.updateOne(
        { _id: row._id, bulkOfferId: offer._id, status: "active" },
        { $set: { status: "delisted" } },
      );
      const keep = got
        .map((a) => a.accountId)
        .filter((id) => !lost.includes(id));
      const rel = await releaseAndRecord(
        offer._id,
        set,
        market,
        keep,
        "pack withdrawn during the send",
      );
      const message =
        lost.length +
        " pack account(s) lost their reservation while the pack was being sent — the pack was " +
        "delisted and " +
        rel.released.length +
        " of " +
        keep.length +
        " other account(s) released";
      alert(
        "⚠️ Bulk pack integrity: " + ctx.title + " — Gameflip\n\n" + message,
      );
      return failSend(ctx, 500, message, { telegram: false });
    }
    const message =
      lost.length +
      " pack account(s) lost their reservation while the pack was being sent and Gameflip would " +
      "not delist it (" +
      err +
      ") — withdraw it by hand";
    alert(
      "⚠️ Bulk pack integrity: " +
        ctx.title +
        " — Gameflip " +
        ctx.externalId +
        " is STILL LIVE\n\n" +
        message,
    );
    return finalizeLive(
      ctx,
      {
        listing: row._id,
        advertisedQty: got.length,
        packPrice: price,
        lastError: message.slice(0, 400),
      },
      "pack of " +
        got.length +
        " account(s) for " +
        money(price) +
        " — " +
        message,
    );
  }
  return finalizeLive(
    ctx,
    { listing: row._id, advertisedQty: got.length, packPrice: price },
    "pack of " + got.length + " account(s) for " + money(price),
  );
}

// noclaim on Eldorado / G2G: a claim-at-sale offer through the no-claim layer,
// published exactly as the Shop-listings route publishes one, then linked.
async function sendNoclaim(ctx) {
  const { bp, set, market, minQty, units, offer } = ctx;
  const c = await deps.stock.noclaimCounts(set);
  const share = Math.max(
    0,
    Math.floor(Number(c && c.share && c.share[market]) || 0),
  );
  const free = Math.max(0, Math.floor(Number(c && c.free) || 0));
  if (share < minQty) {
    return failSend(
      ctx,
      409,
      "Only " +
        share +
        " of " +
        free +
        " free no-claim account(s) are not already advertised on " +
        label(market) +
        " — a " +
        minQty +
        "+ offer needs " +
        minQty,
    );
  }
  const quantity = Math.min(units || bp.unitsPerOffer, share);

  const cover = await coverFor(set);
  let pub;
  try {
    pub = await deps.markets.publishNoclaim({
      market,
      set,
      game: ctx.game,
      title: ctx.title,
      description: ctx.description,
      unitPrice: ctx.unitPrice,
      quantity,
      minQty,
      coverPath: cover,
    });
  } catch (e) {
    return failSend(
      ctx,
      502,
      label(market) + " refused the offer: " + errMsg(e),
    );
  } finally {
    dropCover(cover);
  }
  ctx.rowId = null;
  const rowId = pub && isIdLike(pub.rowId) ? String(pub.rowId) : "";
  await recordPublished(ctx, pub);
  if (rowId) {
    try {
      await deps.BulkOffer.updateOne(
        { _id: offer._id },
        { $set: { listing: rowId } },
      );
    } catch {
      /* finalizeLive writes it again */
    }
  }

  // The link: from here on the row is the offer's (and hooks H5–H12 skip it).
  let linked = false;
  let linkErr = "";
  if (rowId) {
    try {
      const r = await deps.MarketplaceListing.updateOne(
        { _id: rowId, bulkOfferId: null },
        { $set: { bulkOfferId: offer._id } },
      );
      linked = Number(r && r.matchedCount) === 1;
      if (!linked) linkErr = "the new no-claim row was not found";
    } catch (e) {
      linkErr = errMsg(e);
    }
  } else {
    linkErr = "the no-claim publish answered without a row id";
  }
  if (!linked) {
    // Not ours to write (I11): take the market offer off sale and tell the
    // owner to delist the row from Listings, which settles it properly.
    let down = false;
    if (ctx.externalId) {
      try {
        await deps.markets.pause(market, ctx.externalId);
        down = true;
      } catch (e) {
        down = !!deps.delistOutcome(errMsg(e));
      }
    }
    alert(
      "⚠️ Bulk no-claim offer orphan " +
        (down ? "paused" : "STILL LIVE") +
        " — " +
        label(market) +
        " " +
        (ctx.externalId || "(no id)") +
        "\n\n" +
        ctx.title +
        "\n\n" +
        "It is published but could not be linked to its bulk offer (" +
        linkErr +
        "). " +
        "Delist it from Listings → Shop listings.",
    );
    await audit({
      action: "orphan",
      severity: "error",
      message: "no-claim offer published but not linked: " + linkErr,
      offer,
      actor: ctx.actor,
      meta: { externalId: ctx.externalId, rowId, paused: down },
    });
    return failSend(
      ctx,
      500,
      "Published on " +
        label(market) +
        " but the listing could not be linked (" +
        linkErr +
        ") — the offer was " +
        (down ? "paused" : "NOT paused (do it by hand)") +
        "; delist it from Listings",
      { telegram: false },
    );
  }
  ctx.rowId = rowId;
  if (!ctx.externalId || !ctx.url) {
    // The row carries what the platform answered; it is ours now.
    const linkedRow = await deps.MarketplaceListing.findOne(
      { _id: rowId, bulkOfferId: offer._id },
      { externalId: 1, url: 1 },
    ).lean();
    if (linkedRow) {
      ctx.externalId = ctx.externalId || String(linkedRow.externalId || "");
      ctx.url = ctx.url || String(linkedRow.url || "");
    }
  }
  const price =
    Number(pub && pub.price) > 0 ? Number(pub.price) : ctx.unitPrice;
  // publishNoclaim caps the advertised quantity to this offer's share of the
  // shelf and lowers minQuantity with it when the shelf shrank mid-publish
  // (markets.publishNoclaim logs that and answers the real quantity). A tier
  // price live at a smaller minimum order is not what the owner sent, so it
  // goes straight back down through the normal withdraw path.
  const landed = Number(pub && pub.quantity);
  if (Number.isFinite(landed) && landed < minQty) {
    await finalizeLive(
      ctx,
      { listing: rowId, advertisedQty: landed, unitPrice: price },
      landed + " no-claim account(s) landed — below the " + minQty + "+ minimum",
    );
    const w = await withdrawOffer({ offerId: String(offer._id), actor: ctx.actor });
    return {
      success: false,
      status: 409,
      message:
        "The no-claim shelf shrank while publishing (only " +
        landed +
        " left for this offer, below the " +
        minQty +
        "+ minimum), so the offer was taken back down" +
        (w && w.success ? "" : " — check it on " + label(market) + ": " + ((w && w.message) || "")),
      offer: (w && w.offer) || undefined,
    };
  }
  const advertised = Number.isFinite(landed) && landed > 0 ? landed : quantity;
  return finalizeLive(
    ctx,
    { listing: rowId, advertisedQty: advertised, unitPrice: price },
    advertised +
      " no-claim account(s) advertised at " +
      money(price) +
      " each, minimum order " +
      minQty,
  );
}

// farm on Eldorado / G2G: no row — the farm services read the title and
// provision purchaseQuantity accounts when an order lands.
async function sendFarm(ctx) {
  const { bp, market, minQty, units } = ctx;
  const cap = (await deps.farmCapacity.read({ force: true })) || {};
  const adv = Math.max(
    0,
    Math.floor(Number(deps.farmCapacity.advertisable(cap, bp)) || 0),
  );
  const q = Math.min(adv, units || Infinity);
  if (!(q >= minQty)) {
    return failSend(
      ctx,
      409,
      "Only " +
        adv +
        " account(s) can be farmed right now — best stack room " +
        (Number(cap.bestStackRoom) || 0) +
        ", " +
        (Number(cap.totalFree) || 0) +
        " free slot(s) (keeping " +
        bp.farmReserveSlots +
        "), " +
        (Number(cap.pristine) || 0) +
        " pristine account(s) (keeping " +
        bp.farmReservePristine +
        ")" +
        (cap.error ? " — capacity read failed: " + cap.error : ""),
    );
  }
  let pub;
  try {
    pub = await deps.markets.publishFarm({
      market,
      game: ctx.game,
      days: ctx.days,
      title: ctx.title,
      description: ctx.description,
      unitPrice: ctx.unitPrice,
      quantity: q,
      minQty,
    });
  } catch (e) {
    return failSend(
      ctx,
      502,
      label(market) + " refused the offer: " + errMsg(e),
    );
  }
  await recordPublished(ctx, pub);
  if (!ctx.externalId) {
    alert(
      "⚠️ Bulk farming offer published without an id — " +
        label(market) +
        "\n\n" +
        ctx.title +
        "\n\nFind it on " +
        label(market) +
        " and take it down by hand.",
    );
    return failSend(
      ctx,
      500,
      label(market) +
        " answered without an offer id — find the offer and take it down by hand",
      {
        telegram: false,
      },
    );
  }
  const price =
    Number(pub && pub.price) > 0 ? Number(pub.price) : ctx.unitPrice;
  return finalizeLive(
    ctx,
    { advertisedQty: q, unitPrice: price },
    q +
      " account(s) farming " +
      ctx.game +
      " for " +
      ctx.days +
      " days at " +
      money(price) +
      " each, minimum order " +
      minQty,
  );
}

// ---------------------------------------------------------------------------
// refillOffer — dropset Eldorado / G2G only
// ---------------------------------------------------------------------------
async function refillOffer({ offerId, add, actor } = {}) {
  return withLock("offer:" + String(offerId), () =>
    guarded("refill", async () => {
      const bp = readBulkPacks();
      if (!bp || bp.enabled !== true)
        return result(409, "Bulk packs are switched off");
      const addN = toInt(add);
      if (!Number.isInteger(addN) || addN < 1 || addN > MAX_UNITS) {
        return result(
          400,
          "Add a whole number of accounts from 1 to " + MAX_UNITS,
        );
      }
      const offer = await loadOffer(offerId);
      if (!offer) return result(404, "Offer not found");
      if (!offer.open || !["live", "paused"].includes(offer.state)) {
        return result(
          409,
          "Only a live or paused offer can be refilled (this one is " +
            offer.state +
            ")",
          { offer },
        );
      }
      if (offer.source !== "dropset" || !QTY_MARKETS.includes(offer.market)) {
        return result(
          409,
          "Only farmed-account offers on Eldorado or G2G can be refilled",
          { offer },
        );
      }
      const gate = deps.config.currentGate(offer.market, offer.source);
      if (!gate || !gate.ok)
        return result(
          409,
          (gate && gate.reason) || "Delivery is switched off",
          { offer },
        );
      const set = offer.set
        ? await deps.DropSet.findById(offer.set).lean()
        : null;
      if (!set)
        return result(404, "This offer's set no longer exists", { offer });
      const row = await ownRow(offer);
      if (!row || row.status !== "active") {
        return result(
          409,
          "This offer's listing is no longer active — it cannot take more accounts",
          { offer },
        );
      }

      const free = (await deps.stock.freeDropsetAccounts(set)).length;
      const surplus = free - bp.reserveSingles;
      const n = Math.min(addN, surplus);
      if (!(n >= 1)) {
        return result(
          409,
          "Only " +
            free +
            " free account(s) hold this bundle (keeping " +
            bp.reserveSingles +
            " for single listings)",
          { offer },
        );
      }
      const raw = await deps.stock.reserve({ set, n, market: offer.market });
      const seen = new Set();
      const got = [];
      for (const a of Array.isArray(raw) ? raw : []) {
        const id = String((a && a.accountId) || "");
        if (!id || seen.has(id)) continue;
        seen.add(id);
        got.push({ accountId: id, login: String((a && a.login) || "") });
      }
      if (!got.length)
        return result(409, "No account could be reserved right now", { offer });

      // Our record first (the authority, CONTRACT I3), then the row. A crash in
      // between leaves an on_offer entry missing from an active row, which the
      // loop's reconcile re-$pushes.
      const at = new Date();
      try {
        await deps.BulkOffer.updateOne(
          { _id: offer._id },
          {
            $push: {
              reserved: { $each: got.map((a) => reservedEntry(a, at)) },
            },
          },
        );
      } catch (e) {
        try {
          await deps.stock.releaseUnits({
            set,
            market: offer.market,
            accountIds: got.map((a) => a.accountId),
          });
        } catch (e2) {
          console.error(
            "bulkPacks refill: release after a failed record also failed:",
            errMsg(e2),
          );
        }
        return result(
          500,
          "Could not record the reserved accounts: " + errMsg(e),
          { offer },
        );
      }

      // One atomic $push per unit — never a whole-array save (CONTRACT I3).
      const added = [];
      const notAdded = [];
      for (const a of got) {
        try {
          const r = await deps.MarketplaceListing.updateOne(
            {
              _id: row._id,
              bulkOfferId: offer._id,
              status: "active",
              "units.accountId": { $ne: a.accountId },
            },
            { $push: { units: unitDoc(a, at) }, $inc: { qtyTarget: 1 } },
          );
          (Number(r && r.modifiedCount) === 1 ? added : notAdded).push(a);
        } catch (e) {
          console.error(
            "bulkPacks refill: $push of " + a.accountId + " failed:",
            errMsg(e),
          );
          notAdded.push(a);
        }
      }
      // Never reached the row (it went inactive under us), so nothing can sell
      // them through it: hand them back.
      let releasedBack = 0;
      if (notAdded.length) {
        const rel = await releaseAndRecord(
          offer._id,
          set,
          offer.market,
          notAdded.map((a) => a.accountId),
          "refill: the listing stopped taking accounts",
        );
        releasedBack = rel.released.length;
      }

      // Re-read, then advertise exactly the free units the row now holds.
      const fresh = await ownRow(offer);
      const freeCount = sellableCount(fresh, await freshOffer(offer._id));
      let qtyNote = "";
      const set$ = { lastError: "" };
      try {
        await deps.markets.setQuantity(
          offer.market,
          offer.externalId,
          freeCount,
        );
        set$.advertisedQty = freeCount;
      } catch (e) {
        qtyNote =
          " — the quantity update failed (" +
          errMsg(e) +
          "); the maintenance loop retries";
        set$.lastError = ("refill quantity: " + errMsg(e)).slice(0, 400);
      }
      const detail =
        "+" +
        added.length +
        " account(s)" +
        (notAdded.length
          ? ", " +
            notAdded.length +
            " not added (" +
            releasedBack +
            " released)"
          : "") +
        "; " +
        freeCount +
        " on offer" +
        qtyNote;
      await deps.BulkOffer.updateOne(
        { _id: offer._id },
        { $set: set$, $push: { history: hist("refilled", detail, actor) } },
      );
      const out = await freshOffer(offer._id);
      await audit({
        action: "refilled",
        message: detail,
        offer: out,
        actor,
        meta: { added: added.length },
      });
      invalidateProposals();
      if (!added.length)
        return result(409, "No account could be added: " + detail, {
          offer: out,
        });
      return result(200, "Refilled: " + detail, { offer: out });
    }),
  );
}

// ---------------------------------------------------------------------------
// pauseOffer / resumeOffer
// ---------------------------------------------------------------------------

// Manual pause: the owner's, so autoPaused is false and nothing resumes it by
// itself. Allowed while bulk packs are switched off (it is a safety action).
async function pauseOffer({ offerId, actor } = {}) {
  return withLock("offer:" + String(offerId), () =>
    guarded("pause", async () => {
      const offer = await loadOffer(offerId);
      if (!offer) return result(404, "Offer not found");
      if (!offer.open || offer.state === "sending") {
        return result(
          409,
          "Only a live offer can be paused (this one is " + offer.state + ")",
          { offer },
        );
      }
      if (offer.market === "gameflip") {
        return result(
          409,
          "A Gameflip pack cannot be paused — withdraw it instead",
          { offer },
        );
      }
      if (offer.state === "paused") {
        if (!offer.autoPaused) return result(200, "Already paused", { offer });
        // Paused by the loop; the owner now keeps it paused.
        await deps.BulkOffer.updateOne(
          { _id: offer._id, state: "paused" },
          {
            $set: { autoPaused: false },
            $push: {
              history: hist(
                "paused",
                "kept paused by the owner — it will not resume by itself",
                actor,
              ),
            },
          },
        );
        const out = await freshOffer(offer._id);
        await audit({
          action: "paused",
          message: "kept paused by the owner",
          offer: out,
          actor,
        });
        return result(200, "Kept paused — it will not resume by itself", {
          offer: out,
        });
      }
      try {
        await deps.markets.pause(offer.market, offer.externalId);
      } catch (e) {
        // "must be active" / 404: already off sale, which is what was asked.
        if (!deps.delistOutcome(errMsg(e))) {
          await noteError(offer._id, "pause failed: " + errMsg(e), actor);
          return result(
            502,
            "Could not pause the offer on " +
              label(offer.market) +
              ": " +
              errMsg(e),
            { offer },
          );
        }
      }
      if (offer.listing) {
        // The row's own flag belongs to the existing stock syncs, which resume
        // only what they paused themselves: clear it so they never undo this.
        await deps.MarketplaceListing.updateOne(
          { _id: offer.listing, bulkOfferId: offer._id },
          { $set: { autoPaused: false } },
        ).catch(() => {});
      }
      await deps.BulkOffer.updateOne(
        { _id: offer._id, open: true },
        {
          $set: {
            state: "paused",
            open: true,
            autoPaused: false,
            lastError: "",
          },
          $push: { history: hist("paused", "paused by the owner", actor) },
        },
      );
      const out = await freshOffer(offer._id);
      await audit({
        action: "paused",
        message: "paused by the owner",
        offer: out,
        actor,
      });
      alert(
        "⏸ Bulk offer paused: " + offer.title + " — " + label(offer.market),
      );
      return result(200, "Paused", { offer: out });
    }),
  );
}

async function resumeOffer({ offerId, actor } = {}) {
  return withLock("offer:" + String(offerId), () =>
    guarded("resume", async () => {
      const bp = readBulkPacks();
      if (!bp || bp.enabled !== true)
        return result(409, "Bulk packs are switched off");
      const offer = await loadOffer(offerId);
      if (!offer) return result(404, "Offer not found");
      if (!offer.open || offer.state !== "paused") {
        return result(
          409,
          "Only a paused offer can be resumed (this one is " +
            offer.state +
            ")",
          { offer },
        );
      }
      if (offer.market === "gameflip") {
        return result(409, "A Gameflip pack cannot be paused or resumed", {
          offer,
        });
      }
      const gate = deps.config.currentGate(offer.market, offer.source);
      if (!gate || !gate.ok)
        return result(
          409,
          (gate && gate.reason) || "Delivery is switched off",
          { offer },
        );

      // Enough behind it to honour a minimum order.
      let qty = null;
      if (offer.source === "farm") {
        const cap = (await deps.farmCapacity.read({ force: true })) || {};
        const q = Math.max(
          0,
          Math.floor(Number(deps.farmCapacity.advertisable(cap, bp)) || 0),
        );
        if (q < offer.minQty) {
          return result(
            409,
            "Only " +
              q +
              " account(s) can be farmed right now (minimum order " +
              offer.minQty +
              ") — best stack room " +
              (Number(cap.bestStackRoom) || 0) +
              ", " +
              (Number(cap.totalFree) || 0) +
              " free slot(s), " +
              (Number(cap.pristine) || 0) +
              " pristine account(s)" +
              (cap.error ? " — " + cap.error : ""),
            { offer },
          );
        }
        qty = q;
      } else {
        const row = await ownRow(offer);
        if (!row || row.status !== "active") {
          return result(409, "This offer's listing is no longer active", {
            offer,
          });
        }
        if (offer.source === "noclaim") {
          let share;
          try {
            share = Math.floor(
              Number(await deps.noclaimStock.stockForListing(row)) || 0,
            );
          } catch (e) {
            return result(
              502,
              "Could not count the no-claim stock right now: " + errMsg(e),
              { offer },
            );
          }
          if (share < offer.minQty) {
            return result(
              409,
              "Only " +
                share +
                " no-claim account(s) are free for this offer (minimum order " +
                offer.minQty +
                ")",
              { offer },
            );
          }
        } else {
          const free = sellableCount(row, offer);
          if (free < offer.minQty) {
            return result(
              409,
              "Only " +
                free +
                " account(s) left on this offer (minimum order " +
                offer.minQty +
                ") — refill it first",
              { offer },
            );
          }
          qty = free;
        }
      }

      try {
        await deps.markets.resume(offer.market, offer.externalId);
      } catch (e) {
        await noteError(offer._id, "resume failed: " + errMsg(e), actor);
        return result(
          502,
          "Could not resume the offer on " +
            label(offer.market) +
            ": " +
            errMsg(e),
          { offer },
        );
      }
      const set$ = {
        state: "live",
        open: true,
        autoPaused: false,
        lastError: "",
      };
      let qtyNote = "";
      if (qty != null && qty !== offer.advertisedQty) {
        try {
          await deps.markets.setQuantity(offer.market, offer.externalId, qty);
          set$.advertisedQty = qty;
        } catch (e) {
          qtyNote =
            " (quantity update failed: " +
            errMsg(e) +
            " — the maintenance loop retries)";
        }
      }
      await deps.BulkOffer.updateOne(
        { _id: offer._id, open: true },
        {
          $set: set$,
          $push: {
            history: hist("resumed", "resumed by the owner" + qtyNote, actor),
          },
        },
      );
      const out = await freshOffer(offer._id);
      await audit({
        action: "resumed",
        message: "resumed by the owner" + qtyNote,
        offer: out,
        actor,
      });
      alert(
        "▶️ Bulk offer resumed: " + offer.title + " — " + label(offer.market),
      );
      return result(200, "Resumed" + qtyNote, { offer: out });
    }),
  );
}

// ---------------------------------------------------------------------------
// withdrawOffer / withdrawAll
// ---------------------------------------------------------------------------

async function withdrawOffer({ offerId, actor } = {}) {
  return withLock("offer:" + String(offerId), () =>
    guarded("withdraw", async () => {
      const offer = await loadOffer(offerId);
      if (!offer) return result(404, "Offer not found");
      if (!offer.open)
        return result(
          409,
          "This offer is already closed (" + offer.state + ")",
          { offer },
        );
      if (offer.state === "sending") {
        const since = new Date(
          offer.updatedAt || offer.createdAt || 0,
        ).getTime();
        if (!(Date.now() - since >= SENDING_STALE_MS)) {
          return result(
            409,
            "This offer is still being sent — try again in a few minutes",
            { offer },
          );
        }
        if (!offer.externalId) return abandonInterruptedSend(offer, actor);
        // The publish landed and was recorded: take it down like a live one.
      }
      if (offer.source === "farm") return withdrawFarm(offer, actor);
      if (offer.source === "noclaim") return withdrawNoclaim(offer, actor);
      if (offer.market === "gameflip")
        return withdrawGameflipPack(offer, actor);
      return withdrawDropsetQty(offer, actor);
    }),
  );
}

async function closeWithdrawn(offer, actor, detail, extra = {}) {
  await closeOffer(offer._id, "withdrawn", {
    action: "withdrawn",
    detail,
    actor,
    extra: { autoPaused: false, ...extra },
  });
  const out = (await freshOffer(offer._id)) || offer;
  await audit({ action: "withdrawn", message: detail, offer: out, actor });
  invalidateProposals();
  if (out.state !== "withdrawn") {
    // The loop closed it first (sold out, expired…): off sale either way.
    return result(200, "Already closed (" + out.state + ") — " + detail, {
      offer: out,
    });
  }
  return result(200, "Withdrawn — " + detail, { offer: out });
}

// A send that died before its publish was recorded: we cannot know whether an
// offer went up, so the owner is told to look, and only what provably cannot
// be delivered is handed back.
async function abandonInterruptedSend(offer, actor) {
  const onOffer = (offer.reserved || [])
    .filter((r) => r.state === "on_offer")
    .map((r) => r.accountId);
  let released = 0;
  let kept = 0;
  if (onOffer.length) {
    if (offer.source === "dropset" && QTY_MARKETS.includes(offer.market)) {
      // No row of ours lists them, so no fulfiller can deliver them.
      const set = offer.set
        ? await deps.DropSet.findById(offer.set).lean()
        : null;
      if (set) {
        const rel = await releaseAndRecord(
          offer._id,
          set,
          offer.market,
          onOffer,
          "interrupted send",
        );
        released = rel.released.length;
      } else {
        kept = onOffer.length;
      }
    } else {
      // Gameflip: the credentials may be inside a listing's delivery code.
      kept = onOffer.length;
    }
  }
  const detail =
    "the send was interrupted before its offer was recorded — check " +
    label(offer.market) +
    ' for "' +
    offer.title +
    '" and remove it by hand' +
    (released ? "; " + released + " reserved account(s) released" : "") +
    (kept ? "; " + kept + " reserved account(s) KEPT reserved" : "");
  await closeOffer(offer._id, "error", {
    lastError: detail,
    action: "abandoned",
    detail,
    actor,
  });
  alert(
    "⚠️ Bulk send interrupted — " +
      label(offer.market) +
      "\n\n" +
      offer.title +
      "\n\n" +
      detail,
  );
  const out = await freshOffer(offer._id);
  await audit({
    action: "abandoned",
    severity: "warn",
    message: detail,
    offer: out || offer,
    actor,
  });
  invalidateProposals();
  return result(200, "Closed: " + detail, { offer: out || offer });
}

// Take an offer off a market. Returns { ok, outcome, error }: ok when the
// market confirmed it, or answered that it is already sold / gone.
async function takeOffMarket(offer) {
  if (!offer.externalId) return { ok: true, outcome: "gone", error: "" };
  try {
    await deps.markets.withdraw(offer.market, offer.externalId);
    return { ok: true, outcome: "", error: "" };
  } catch (e) {
    const error = errMsg(e);
    const outcome = deps.delistOutcome(error) || "";
    return { ok: !!outcome, outcome, error };
  }
}

// dropset Eldorado / G2G: pause the offer, delist the row, then phase 1 of
// CONTRACT I10 on every FREE unit — the loop's retireUnits, so the loop's
// phase 2 (≥ 2 min, re-read, isStillOurs) is what finally releases them.
async function withdrawDropsetQty(offer, actor) {
  const off = await takeOffMarket(offer);
  if (!off.ok) {
    await noteError(offer._id, "withdraw failed: " + off.error, actor);
    return result(
      502,
      "Could not take the offer off " +
        label(offer.market) +
        ": " +
        off.error +
        " — nothing changed",
      {
        offer,
      },
    );
  }
  const row = await ownRow(offer);
  if (row && row.status === "active") {
    await deps.MarketplaceListing.updateOne(
      { _id: row._id, bulkOfferId: offer._id, status: "active" },
      { $set: { status: "delisted", lastError: "" } },
    );
  }
  const cur = (await freshOffer(offer._id)) || offer;
  const fresh = row ? await ownRow(offer) : null;
  const onOffer = (cur.reserved || []).filter((r) => r.state === "on_offer");

  if (!fresh) {
    // No row of ours holds these accounts, so nothing can sell them: they go
    // straight back (each after isStillOurs).
    let released = 0;
    if (onOffer.length) {
      const set = cur.set ? await deps.DropSet.findById(cur.set).lean() : null;
      if (!set) {
        await noteError(
          offer._id,
          "withdraw: the offer's set is gone — its reservations could not be released",
          actor,
        );
        return result(
          500,
          "Taken off " +
            label(offer.market) +
            ", but the offer's set is gone so its accounts could not be released",
          {
            offer: await freshOffer(offer._id),
          },
        );
      }
      const rel = await releaseAndRecord(
        cur._id,
        set,
        cur.market,
        onOffer.map((r) => r.accountId),
        "withdrawn (no listing row)",
      );
      released = rel.released.length;
    }
    return closeWithdrawn(
      offer,
      actor,
      "taken off " +
        label(offer.market) +
        "; " +
        released +
        " account(s) released",
    );
  }

  // Classify every on_offer account against the row as it is NOW.
  const toRetire = [];
  const sold = {};
  for (const r of onOffer) {
    const mine = (fresh.units || []).filter(
      (u) => String(u.accountId) === String(r.accountId),
    );
    const taken = mine.find((u) => !isFree(u));
    if (taken) sold[r.accountId] = String(taken.orderId || "");
    else toRetire.push(String(r.accountId)); // free on the row, or not on it at all
  }
  if (toRetire.length) {
    try {
      await deps.loop.retireUnits(cur, fresh, toRetire, "withdrawn");
    } catch (e) {
      // The offer stays open: its row is delisted now, and the loop's next
      // pass retires what is left and closes it "withdrawn" itself.
      await noteError(
        offer._id,
        "withdraw: retiring units failed (" +
          errMsg(e) +
          ") — the maintenance loop finishes it",
        actor,
      );
      return result(
        500,
        "Taken off " +
          label(offer.market) +
          ", but its accounts could not be retired yet (" +
          errMsg(e) +
          ") — the maintenance loop finishes the withdrawal",
        { offer: await freshOffer(offer._id) },
      );
    }
    // The loop reloads a CLOSED offer only while it has retiring units, so an
    // account left on_offer here would be stranded. Whatever retireUnits left
    // (a unit already off the row, or one that sold under the $pull) becomes
    // retiring: phase 2 re-reads the row and releases it only if it is still
    // absent after the wait, or records it delivered if it sold.
    const after = (await freshOffer(offer._id)) || cur;
    const leftOver = toRetire.filter((id) =>
      (after.reserved || []).some(
        (r) => String(r.accountId) === id && r.state === "on_offer",
      ),
    );
    if (leftOver.length) {
      await markEntries(
        offer._id,
        leftOver,
        "retiring",
        "withdrawn (not on the listing row)",
      );
    }
  }
  // A unit that is not FREE sold (or is being delivered): it is the buyer's.
  const soldIds = Object.keys(sold);
  if (soldIds.length) {
    await markEntries(
      offer._id,
      soldIds,
      "delivered",
      "sold before the withdraw",
      { orderIds: sold },
    );
  }
  return closeWithdrawn(
    offer,
    actor,
    "taken off " +
      label(offer.market) +
      "; " +
      toRetire.length +
      " account(s) retiring (released after the safety re-check)" +
      (soldIds.length ? ", " + soldIds.length + " already sold" : "") +
      (off.outcome ? " (the market said: " + off.outcome + ")" : ""),
  );
}

// dropset Gameflip (CONTRACT I9): delist first; only a delist that SUCCEEDED
// lets the pack's accounts go, because until then a buyer can still pay for
// the code that holds their credentials.
async function withdrawGameflipPack(offer, actor) {
  const row = await ownRow(offer);
  if (row && row.status === "sold") {
    return result(
      409,
      "This pack already sold — the maintenance loop records the sale",
      { offer },
    );
  }
  if (row && row.status !== "active") {
    // Already off Gameflip (the Gameflip sync retired it, or it was delisted
    // from Listings). Only the loop's retire path may hand its accounts back.
    return result(
      409,
      "This pack is already off Gameflip (" +
        row.status +
        ") — the maintenance loop releases its accounts",
      { offer },
    );
  }
  if (!offer.externalId) {
    return result(
      409,
      "This pack has no Gameflip listing id — it cannot be delisted from here",
      { offer },
    );
  }
  try {
    await deps.markets.withdraw("gameflip", offer.externalId);
  } catch (e) {
    const msg = errMsg(e);
    if (deps.delistOutcome(msg) === "sold") {
      // Do nothing: the Gameflip sync marks the row sold and the loop
      // finalises the offer.
      await noteError(
        offer._id,
        "withdraw: Gameflip says the pack already sold",
        actor,
      );
      return result(
        409,
        "Gameflip says this pack already sold — the Gameflip sync will mark it sold",
        {
          offer: await freshOffer(offer._id),
        },
      );
    }
    await noteError(
      offer._id,
      "withdraw failed: " + msg + " — nothing released",
      actor,
    );
    return result(
      502,
      "Could not delist the pack on Gameflip: " +
        msg +
        " — nothing was released",
      { offer },
    );
  }
  if (row) {
    await deps.MarketplaceListing.updateOne(
      { _id: row._id, bulkOfferId: offer._id, status: "active" },
      { $set: { status: "delisted" } },
    );
  }
  const fresh = row ? await ownRow(offer) : null;
  if (fresh && fresh.status === "sold") {
    // The sync saw a sale in between: the buyer holds every account.
    return result(
      409,
      "This pack sold before the delist — the maintenance loop records the sale",
      {
        offer: await freshOffer(offer._id),
      },
    );
  }
  const cur = (await freshOffer(offer._id)) || offer;
  const ids = (cur.reserved || [])
    .filter((r) => r.state === "on_offer")
    .map((r) => r.accountId);
  let rel = { released: [], notOurs: [], pending: [] };
  if (ids.length) {
    const set = cur.set ? await deps.DropSet.findById(cur.set).lean() : null;
    if (!set) {
      await noteError(
        offer._id,
        "withdraw: the offer's set is gone — its reservations could not be released",
        actor,
      );
      return result(
        500,
        "Delisted, but the offer's set is gone so its accounts could not be released",
        {
          offer: await freshOffer(offer._id),
        },
      );
    }
    rel = await releaseAndRecord(cur._id, set, "gameflip", ids, "withdrawn");
  }
  return closeWithdrawn(
    offer,
    actor,
    "delisted on Gameflip; " +
      rel.released.length +
      " of " +
      ids.length +
      " account(s) released" +
      (rel.pending.length
        ? ", " + rel.pending.length + " pending the maintenance loop"
        : ""),
  );
}

// noclaim: the SAME delist path the Listings page uses for a no-claim row
// (routes/marketplaceRoutes.js DELETE /marketplaces/listings/:id):
// beforeDelist -> platform delist -> row delisted (or sold) -> afterDelist.
async function withdrawNoclaim(offer, actor) {
  let row = await ownRow(offer);
  if (!row && offer.listing && offer.externalId) {
    // An interrupted send can leave the row it published unlinked. That row is
    // this offer's by construction (same id, same external id): finish the
    // link the send would have made, then take it down properly.
    await deps.MarketplaceListing.updateOne(
      {
        _id: offer.listing,
        bulkOfferId: null,
        noclaimStock: true,
        marketplace: offer.market,
        externalId: offer.externalId,
      },
      { $set: { bulkOfferId: offer._id } },
    ).catch(() => {});
    row = await ownRow(offer);
  }
  if (!row) {
    const off = await takeOffMarket(offer);
    if (!off.ok) {
      await noteError(offer._id, "withdraw failed: " + off.error, actor);
      return result(
        502,
        "Could not take the offer off " +
          label(offer.market) +
          ": " +
          off.error,
        { offer },
      );
    }
    return closeWithdrawn(
      offer,
      actor,
      "taken off " + label(offer.market) + " (no listing row)",
    );
  }

  const ncl = deps.noclaimListings;
  // Settle first: a sale not yet seen must not go back on the shelf. A failed
  // settle refuses the withdraw while nothing has moved yet.
  try {
    await ncl.beforeDelist(row);
  } catch (e) {
    return result(
      502,
      "Not withdrawn — this no-claim listing's sales could not be settled first: " +
        errMsg(e),
      { offer },
    );
  }
  let outcome = "delisted";
  let off = { ok: true, outcome: "", error: "" };
  if (offer.externalId) {
    try {
      await deps.markets.withdraw(offer.market, offer.externalId);
    } catch (e) {
      off = {
        ok: false,
        outcome: deps.delistOutcome(errMsg(e)) || "",
        error: errMsg(e),
      };
    }
  }
  if (!off.ok && !off.outcome) {
    await deps.MarketplaceListing.updateOne(
      { _id: row._id, bulkOfferId: offer._id },
      { $set: { lastError: off.error.slice(0, 400) } },
    ).catch(() => {});
    await noteError(offer._id, "withdraw failed: " + off.error, actor);
    return result(
      502,
      "Could not take the offer off " + label(offer.market) + ": " + off.error,
      { offer },
    );
  }
  if (off.outcome === "sold") {
    // Already sold: the buyer holds it, so it is marked sold, never released.
    await deps.MarketplaceListing.updateOne(
      { _id: row._id, bulkOfferId: offer._id, status: "active" },
      { $set: { status: "sold", qtyRemaining: 0, lastError: "" } },
    );
    outcome = "sold";
  } else {
    if (off.outcome) outcome = off.outcome;
    const $set = { status: "delisted", lastError: "" };
    if (off.outcome) {
      $set.note =
        (row.note ? row.note + " " : "") + "gone from the marketplace";
    }
    await deps.MarketplaceListing.updateOne(
      { _id: row._id, bulkOfferId: offer._id, status: "active" },
      { $set },
    );
  }
  let settled = { released: 0, sold: 0 };
  try {
    const r = (await ncl.afterDelist(row, { outcome })) || {};
    settled = { released: Number(r.released) || 0, sold: Number(r.sold) || 0 };
  } catch (e) {
    // The offer is off the market; as on the Listings page, a failed
    // settlement is logged, not turned into an error the owner retries.
    console.error("bulkPacks noclaim afterDelist:", errMsg(e));
    await audit({
      action: "delist_settle_failed",
      severity: "warn",
      message:
        "no-claim offer is off sale (" +
        outcome +
        ") but its units could not be settled: " +
        errMsg(e),
      offer,
      actor,
    });
  }
  return closeWithdrawn(
    offer,
    actor,
    "taken off " +
      label(offer.market) +
      (outcome !== "delisted" ? " (the market said: " + outcome + ")" : "") +
      "; " +
      settled.released +
      " no-claim account(s) released, " +
      settled.sold +
      " sold",
  );
}

async function withdrawFarm(offer, actor) {
  const off = await takeOffMarket(offer);
  if (!off.ok) {
    await noteError(offer._id, "withdraw failed: " + off.error, actor);
    return result(
      502,
      "Could not take the offer off " +
        label(offer.market) +
        ": " +
        off.error +
        " — nothing changed",
      {
        offer,
      },
    );
  }
  return closeWithdrawn(
    offer,
    actor,
    "taken off " +
      label(offer.market) +
      (off.outcome ? " (the market said: " + off.outcome + ")" : ""),
  );
}

// Every open offer, one at a time — never a parallel fan-out against live
// markets.
async function withdrawAll({ actor } = {}) {
  try {
    const offers = await deps.BulkOffer.find(
      { open: true },
      { _id: 1, title: 1, market: 1, state: 1 },
    )
      .sort({ createdAt: 1 })
      .limit(500)
      .lean();
    const results = [];
    for (const o of offers) {
      const r = await withdrawOffer({ offerId: String(o._id), actor });
      results.push({
        offerId: String(o._id),
        title: o.title || "",
        market: o.market,
        success: !!r.success,
        status: r.status,
        message: r.message || "",
      });
    }
    const failed = results.filter((r) => !r.success);
    const message =
      results.length -
      failed.length +
      " of " +
      results.length +
      " open offer(s) withdrawn" +
      (failed.length ? " — " + failed.length + " could not be" : "");
    await audit({
      action: "withdraw_all",
      severity: failed.length ? "warn" : "info",
      message,
      actor,
      meta: { total: results.length, failed: failed.length },
    });
    if (!failed.length) return { success: true, status: 200, message, results };
    return {
      success: false,
      status: Math.max(...failed.map((f) => Number(f.status) || 500)),
      message,
      results,
    };
  } catch (e) {
    console.error("bulkPacks withdrawAll failed:", errMsg(e));
    return {
      success: false,
      status: 500,
      message: "Server error: " + errMsg(e),
      results: [],
    };
  }
}

module.exports = {
  sendOffer,
  refillOffer,
  pauseOffer,
  resumeOffer,
  withdrawOffer,
  withdrawAll,
  isFree,
  SENDING_STALE_MS,
  __setDeps,
  __resetDeps,
};
