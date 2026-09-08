// G2G auto-delivery.
//
// Every Twitch-Drops offer we sell on G2G lives in `Game Items`, which is a
// MANUAL-delivery category: there is no code vault (the inventory API answers
// 404 for a Game Items offer and the stock/manage route redirects away), so
// G2G's own flow is view-details -> delivering -> "I delivered N", with the
// goods handed over in chat.
//
// This fulfiller drives that whole state machine. What it cannot yet do by
// itself is put the credential in front of the buyer: G2G chat is SendBird, and
// sending needs the optional @sendbird/chat SDK (see utils/g2gChat.js). So the
// hand-over is two-phase, exactly like PlayerAuctions':
//
//   phase 1  claim stock -> start_deliver -> mark_as_delivering -> send the
//            credential (SendBird if available, otherwise push it to the
//            operator on Telegram) -> stamp `messagedAt`
//   phase 2  once the credential is out, tell G2G how many units shipped
//            -> stamp `deliveredAt`
//
// The split is not decoration. A confirm that fails must re-confirm, never
// re-send credentials — otherwise a retry gives a second account away free.
//
// The delivery-proof screenshot is deliberately NOT uploaded here. A
// buyer-confirmed order completes with no proof at all (verified on a real
// completed order, whose delivery_proofs is a 404); G2G only holds payment when
// a buyer goes quiet or opens a case. So proof is a dispute fallback the
// operator handles, and this file only NOTIFIES when an order looks like it
// needs one.
const MarketplaceListing = require("../models/MarketplaceListing");
const { getAutoFarm } = require("./settings");
const mp = require("./marketplaces");
const chat = require("./g2gChat");
const eld = require("./eldoradoFulfiller");

// Distinct from every other platform's tag so one account can never be handed
// out twice across marketplaces. Must be listed in utils/marketClaimTags.js.
const G2G_CLAIM_TAG = "g2g";

const DELIVER_TICK_MS = 60 * 1000;
const STOCK_TICK_MS = 15 * 60 * 1000;

// Ceiling on a dry-run stock count, so a huge ledger never walks the whole
// collection just to size one offer.
const STOCK_MAX = 500;

// Orders we have already shouted about, so a stuck order does not re-ping the
// operator every minute. Process-local on purpose: a restart re-alerting once
// is the right behaviour.
const alerted = new Set();

function notify(text) {
  return require("./telegram")
    .sendTelegram(text)
    .catch(() => {});
}

// Units on a listing that have been reserved but not yet confirmed to G2G.
function undeliveredUnits(listing) {
  return (listing.units || []).filter((u) => !u.deliveredAt);
}

function unitsForOrder(listing, orderId) {
  return (listing.units || []).filter((u) => u.orderId === orderId);
}

// The credential text. Reuses Eldorado's copy verbatim rather than forking it —
// a second version of this text drifts and starts making promises the other
// platforms do not (the "if this event is still running" hedge in particular is
// load-bearing: a sold no-claim account keeps farming only until the operator
// runs the spent scan).
function g2gDeliveryCode(login, password) {
  return eld.eldoradoDeliveryCode(login, password);
}

function releaseAccounts(ids) {
  return eld.releaseAccounts(ids, G2G_CLAIM_TAG);
}

// Compose the message for an order. A SendBird channel is shared across all of
// a repeat buyer's orders, so the order number has to be in the text.
function buildMessage(order, blocks) {
  const qty = blocks.length;
  const body =
    qty > 1
      ? blocks
          .map((b, i) => "=== ACCOUNT " + (i + 1) + " of " + qty + " ===\n\n" + b)
          .join("\n\n")
      : blocks[0];
  return "Order " + order.orderItemId + "\n\n" + body;
}

// Resolve the accounts backing one order, from whichever of the three stock
// sources this listing uses. Returns {picked:[{login,password,accountId,ledgerId}]}
// or {error} — never a short shipment: a buyer waiting is recoverable, an
// account missing half the advertised items is a dispute.
async function pickStock(listing, order, { dryRun }) {
  const qty = Math.max(1, order.purchasedQty || 1);

  if (listing.unclaimedGame) {
    const shortfall = {};
    const picked = await eld.claimUnclaimedForGame(listing.unclaimedGame, qty, {
      orderId: order.orderItemId,
      offerId: order.offerId,
      dryRun,
      requiredDrops: listing.requiredDrops,
      shortfall,
      market: G2G_CLAIM_TAG,
    });
    if (picked.length < qty) {
      return {
        error:
          "only " + picked.length + " of " + qty + " sellable " +
          listing.unclaimedGame + " account(s) free in the no-claim farm" +
          (shortfall.detail ? " — short of: " + shortfall.detail : ""),
      };
    }
    return { picked, source: "unclaimed:" + listing.unclaimedGame };
  }

  if (listing.autoClaimSet && listing.set) {
    const DropSet = require("../models/DropSet");
    const set = await DropSet.findById(listing.set).lean();
    if (!set) return { error: "listing's DropSet is missing" };
    if (dryRun) {
      const { availableAccountsForSet } = require("../routes/shopRoutes");
      const avail = await availableAccountsForSet(set).catch(() => []);
      return {
        picked: [],
        source: "dropset:" + set.name,
        note: qty + " of " + avail.length + " available account(s)",
      };
    }
    const claimed = await eld.claimAccountsForSet(set, qty, {
      claimTag: G2G_CLAIM_TAG,
    });
    if (claimed.length < qty) {
      await releaseAccounts(claimed.map((c) => c.accountId)).catch(() => {});
      return {
        error:
          "only " + claimed.length + " of " + qty +
          " accounts still held the full set at delivery time",
      };
    }
    return { picked: claimed, source: "dropset:" + set.name };
  }

  // Pre-reserved units (the shape publishG2gShare creates).
  const free = undeliveredUnits(listing).filter((u) => !u.orderId);
  if (free.length >= qty) {
    return { picked: free.slice(0, qty), source: "units", fromUnits: true };
  }
  return null; // no stock source at all -> caller decides (manual listing)
}

// Deliver one paid order. Returns a short result the tick can log directly.
async function deliverOrder(order, { dryRun }) {
  const orderId = String(order.orderItemId || "");
  const offerId = String(order.offerId || "");
  const qty = Math.max(1, order.purchasedQty || 1);

  const listing = await MarketplaceListing.findOne({
    marketplace: "g2g",
    externalId: offerId,
  });
  if (!listing) {
    return { orderId, skipped: "no listing row for offer " + offerId };
  }

  // Idempotence. Units already carrying this order mean stock is spent on it,
  // so the credential must never be re-picked — only the tail of the hand-over
  // can still be outstanding.
  const mine = unitsForOrder(listing, orderId);
  if (mine.length) {
    if (mine.every((u) => u.deliveredAt)) {
      return { orderId, skipped: "already delivered" };
    }
    // G2G is the source of truth for whether the buyer has been served. If the
    // operator completed the hand-over by hand, catch our records up rather
    // than leaving the units dangling forever.
    if (order.deliveredQty >= order.purchasedQty) {
      const now = new Date();
      for (const u of mine) {
        if (!u.messagedAt) u.messagedAt = now;
        if (!u.deliveredAt) u.deliveredAt = now;
      }
      listing.markModified("units");
      await listing.save();
      return { orderId, delivered: mine.length, source: "confirmed-on-g2g" };
    }
    if (mine.every((u) => u.messagedAt)) {
      // The credential really reached the buyer (only the chat send stamps
      // messagedAt), so all that is left is telling G2G the count. A confirm
      // that failed last tick re-confirms here instead of re-sending.
      if (dryRun) {
        return { orderId, dryRun: true, wouldSend: "confirm only (already sent)" };
      }
      await mp.g2gSetDeliveredQty(orderId, mine.length);
      const now = new Date();
      for (const u of mine) u.deliveredAt = now;
      listing.markModified("units");
      await listing.save();
      return { orderId, delivered: mine.length, source: "confirm-only" };
    }
    // Reserved, but nothing has reached the buyer: this order is parked waiting
    // for the operator to paste the credential into G2G chat. Do NOT confirm —
    // saying "delivered" when the buyer has received nothing is how a dispute
    // starts — and do NOT pick fresh stock, which would give a second account
    // away for free.
    return {
      orderId,
      pending: mine.length,
      detail: "waiting for the operator to hand the credential over in G2G chat",
    };
  }

  const stock = await pickStock(listing, order, { dryRun });
  if (stock === null) {
    // Neither a stock source nor a reserved unit: this is a service listing
    // ("Automatic farming 180 days") or one the operator fills by hand. Skip
    // quietly rather than erroring every minute for an order we were never
    // meant to deliver.
    return {
      orderId,
      skipped: "manual-delivery listing (no stock source and no reserved units)",
    };
  }
  if (stock.error) return { orderId, error: stock.error };

  const picked = stock.picked || [];
  if (dryRun) {
    return {
      orderId,
      dryRun: true,
      source: stock.source,
      wouldSend:
        stock.note ||
        qty + " account(s) [" + picked.map((p) => p.login).join(", ") + "]",
    };
  }

  // Credentials are re-read at delivery time, never trusted from the cached
  // unit copy — a password can have been rotated since the unit was reserved.
  const creds = await credentialsFor(picked);
  const unreadable = creds.filter((c) => !c.password);
  if (unreadable.length) {
    await releaseAccounts(
      unreadable.map((c) => c.accountId).filter(Boolean),
    ).catch(() => {});
    return {
      orderId,
      error:
        unreadable.length + " of " + qty +
        " account(s) had no readable password — released, not shipped",
    };
  }

  const message = buildMessage(
    order,
    creds.map((c) => g2gDeliveryCode(c.login, c.password)),
  );

  // G2G wants the seller to open the delivery details before delivering; both
  // transitions are idempotent enough to re-run, and both must happen before we
  // claim anything was delivered.
  await mp.g2gStartDeliver(orderId).catch(() => {});
  await mp.g2gMarkDelivering(orderId).catch(() => {});

  // Reserve onto the row BEFORE the send, so a crash mid-hand-over cannot hand
  // the same account to the next order.
  const now = new Date();
  const newUnits = creds.map((c) => ({
    contentId: c.ledgerId || "",
    accountId: c.accountId ? String(c.accountId) : "",
    login: c.login,
    addedAt: now,
    messagedAt: null,
    deliveredAt: null,
    orderId,
  }));
  if (stock.fromUnits) {
    for (const u of picked) u.orderId = orderId;
  } else {
    listing.units = (listing.units || []).concat(newUnits);
  }
  listing.markModified("units");
  await listing.save();

  let handedOver = "sendbird";
  try {
    await chat.sendToBuyer(order.buyerId, message);
  } catch (e) {
    if (!e.__g2gChatUnavailable) {
      // A real send failure. The units stay reserved to this order so a retry
      // re-sends to the same buyer rather than spending fresh stock.
      return {
        orderId,
        error: "chat send failed: " + e.message,
      };
    }
    // No SendBird SDK: hand the rendered credential to the operator instead.
    // This is a real hand-over, just a human-assisted one — so we say so, and
    // we do NOT tell G2G the order is delivered until the operator has pasted.
    handedOver = "operator";
    await notify(
      "G2G order " + orderId + " is paid and ready to hand over.\n\n" +
        String(order.title || "").slice(0, 120) + "\n" +
        "Buyer id: " + order.buyerId + "   " +
        order.currency + " " + order.amount + "\n\n" +
        "Paste this into the G2G chat with the buyer, then the bot will confirm " +
        "the delivery on the next tick:\n\n" +
        message,
    );
  }

  if (handedOver === "operator") {
    // Phase 2 waits for a human. messagedAt stays NULL on purpose: it means
    // "the buyer has the credential", and here they do not yet. Nothing is
    // confirmed to G2G either. The units stay reserved to this order, so the
    // next tick parks the order instead of spending more stock, and stamps it
    // complete once G2G itself reports the delivered quantity.
    return {
      orderId,
      pending: qty,
      source: stock.source,
      detail: "credential pushed to the operator for a manual paste",
    };
  }

  const stamp = new Date();
  for (const u of listing.units || []) {
    if (u.orderId === orderId && !u.messagedAt) u.messagedAt = stamp;
  }
  listing.markModified("units");
  await listing.save();

  await mp.g2gSetDeliveredQty(orderId, qty);
  for (const u of listing.units || []) {
    if (u.orderId === orderId && !u.deliveredAt) u.deliveredAt = stamp;
  }
  listing.markModified("units");
  await listing.save();
  return { orderId, delivered: qty, source: stock.source };
}

// Re-read each account's password at delivery time.
async function credentialsFor(picked) {
  const BotAccount = require("../models/BotAccount");
  const { decrypt } = require("./secretBox");
  const out = [];
  for (const p of picked) {
    if (p.password) {
      out.push(p);
      continue;
    }
    let password = "";
    if (p.accountId) {
      const acc = await BotAccount.findById(p.accountId, {
        login: 1,
        password: 1,
      }).lean();
      if (acc && acc.password) {
        try {
          password = decrypt(acc.password);
        } catch {
          password = "";
        }
      }
    }
    out.push({ ...p, password });
  }
  return out;
}

// One pass over everything G2G says is waiting. Reads its own flags so it is
// safe to call unconditionally.
async function deliverPendingOrders() {
  const af = getAutoFarm() || {};
  if (!af.g2gAutoDeliver) return { skipped: "g2gAutoDeliver is off" };
  const dryRun = af.g2gDeliverDryRun !== false;

  // The cheap poll first: one small call that says whether anything needs
  // doing at all, so a quiet account costs ~nothing per minute.
  let counts;
  try {
    counts = await mp.g2gOrderCounts();
  } catch (e) {
    return { error: e.message };
  }
  const waiting = Number(counts && counts.preparing) || 0;
  const delivering = Number(counts && counts.delivering) || 0;
  if (!waiting && !delivering) return { checked: 0 };

  const orders = await mp.g2gPendingOrders({});
  const results = [];
  for (const order of orders) {
    let r;
    try {
      r = await deliverOrder(order, { dryRun });
    } catch (e) {
      r = { orderId: order.orderItemId, error: e.message };
    }
    results.push(r);
    if ((r.error || alertsOperator(r.skipped)) && !dryRun) {
      await alertUnshippable(order, r.error || r.skipped);
    }
  }
  return { checked: orders.length, results };
}

// Skips that mean "a human must look at this", as opposed to skips that are
// simply not our job. An offer created by hand on g2g.com has no listing row
// here, so the bot cannot know what stock backs it — that one needs a person.
const ALERT_SKIPS = /no listing row/;

function alertsOperator(skipReason) {
  return ALERT_SKIPS.test(String(skipReason || ""));
}

async function alertUnshippable(order, why) {
  const id = String(order.orderItemId || "");
  if (!id || alerted.has(id)) return;
  alerted.add(id);
  await notify(
    "G2G order " + id + " is PAID and the bot cannot ship it.\n\n" +
      String(order.title || "").slice(0, 120) + "\n" +
      "Buyer id: " + order.buyerId + "   " +
      order.currency + " " + order.amount + "\n\n" +
      "Reason: " + why + "\n\n" +
      "This one needs delivering by hand. Most of the 78 offers on the account " +
      "were created directly on g2g.com and have no listing row here, so the " +
      "bot does not know what stock backs them.",
  );
}

// How many units this row could ACTUALLY ship right now. Returns null for
// "cannot tell", which callers must treat as "change nothing".
//
// This mirrors utils/z2uFulfiller.realStockFor rather than importing it, and
// that is a deliberate exception to the no-second-copy rule: the rule exists
// because a drifted copy of a CLAIM function oversells an account. This one
// only counts — every path through it is read-only or a dry run — so a local
// version cannot hand anything out twice, and importing Z2U's would make G2G's
// stock depend on Z2U's claim tag.
async function realStockFor(row, listedElsewhere) {
  if (!row) return null;
  if (row.unclaimedGame) {
    const picked = await eld
      .claimUnclaimedForGame(row.unclaimedGame, STOCK_MAX, {
        dryRun: true,
        offerId: row.externalId,
        requiredDrops: row.requiredDrops,
        market: G2G_CLAIM_TAG,
      })
      .catch(() => []);
    return picked.length;
  }
  if (row.set) {
    const DropSet = require("../models/DropSet");
    const { availableAccountsForSet } = require("../routes/shopRoutes");
    const { notListed } = require("./listedLogins");
    const set = await DropSet.findById(row.set).lean();
    if (!set) return null;
    const avail = await availableAccountsForSet(set).catch(() => []);
    return notListed(avail, listedElsewhere || new Set()).length;
  }
  // A row whose stock is pre-reserved units: what is left is what nobody has
  // bought yet.
  if ((row.units || []).length) {
    return (row.units || []).filter((u) => !u.orderId && !u.deliveredAt).length;
  }
  return null;
}

// Advertise only what a delivery could really claim. Stock moves without any
// order being placed — the no-claim ledger and the drop archive both drain from
// other platforms — so a listing left at its published quantity oversells.
// Counting must match how the CLAIMER counts, not the raw availability: an
// account already attached to a live listing elsewhere is not sellable here.
async function syncStock() {
  const af = getAutoFarm() || {};
  if (!af.g2gAuto && !af.g2gAutoDeliver) return { skipped: "g2g is off" };
  if (af.g2gSyncStock === false) return { skipped: "g2gSyncStock is off" };
  const dryRun = af.g2gDeliverDryRun !== false;

  const rows = await MarketplaceListing.find({
    marketplace: "g2g",
    status: "active",
    origin: { $ne: "manual" },
  }).limit(200);

  const { loginsOnActiveListings } = require("./listedLogins");
  const listedElsewhere = await loginsOnActiveListings();
  const changes = [];
  for (const row of rows) {
    let real = null;
    try {
      real = await realStockFor(row, listedElsewhere);
    } catch {
      real = null;
    }
    // null means "could not tell". Never write a guess into a live offer —
    // advertising 0 by accident takes a working listing off sale.
    if (real == null) continue;
    if (dryRun) {
      changes.push({ offer: row.externalId, wouldSet: real });
      continue;
    }
    try {
      if (real <= 0) {
        await mp.g2gDelist(row.externalId);
        row.autoPaused = true;
        await row.save();
        changes.push({ offer: row.externalId, delisted: true });
      } else {
        await mp.g2gSetQuantity(row.externalId, real);
        if (row.autoPaused) {
          await mp.g2gRelist(row.externalId);
          row.autoPaused = false;
          await row.save();
        }
        changes.push({ offer: row.externalId, set: real });
      }
    } catch (e) {
      changes.push({ offer: row.externalId, error: e.message });
    }
  }
  return { checked: rows.length, changes, dryRun };
}

let started = false;

function start() {
  if (started) return;
  started = true;
  const loop = (fn, ms, firstDelay, label) => {
    const run = async () => {
      try {
        await fn();
      } catch (e) {
        console.error("g2g " + label + " error:", e.message);
      }
      const t = setTimeout(run, ms);
      if (t.unref) t.unref();
    };
    const t = setTimeout(run, firstDelay);
    if (t.unref) t.unref();
  };
  // Both loops self-guard on the autoFarm flags, so starting them
  // unconditionally is a no-op until the operator flips them on.
  loop(deliverPendingOrders, DELIVER_TICK_MS, 75 * 1000, "fulfiller");
  loop(syncStock, STOCK_TICK_MS, 6 * 60 * 1000, "stock sync");
}

module.exports = {
  G2G_CLAIM_TAG,
  start,
  g2gDeliveryCode,
  buildMessage,
  undeliveredUnits,
  unitsForOrder,
  pickStock,
  credentialsFor,
  deliverOrder,
  deliverPendingOrders,
  alertsOperator,
  realStockFor,
  syncStock,
};
