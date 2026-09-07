// PlayerAuctions auto-delivery.
//
// PlayerAuctions has no credential vault for Item offers — `deliveryInfo
// .deliveryMethod` on a live order reads "Face to Face" and `gameAccount` is
// null (verified 2026-09-07; see docs/PLAYERAUCTIONS-INTEGRATION-PLAN.md). So
// delivery is: the moment payment settles, post the credential into the order's
// message thread and confirm delivery.
//
// Two things make this different from the Eldorado fulfiller, and both are the
// reason this file is not a copy of it:
//
//  1. **Messages are capped at 300 characters**, so the hand-over may need to
//     be split across several messages (utils/playerauctionsCopy).
//  2. **Confirming delivery requires proof images** — PlayerAuctions' own
//     client refuses to submit without 1-2 screenshots while the seller is
//     level 0, which this account is. utils/playerauctionsProof renders one.
//
// Because a hand-over can now be several HTTP calls, a failure part-way through
// is a real state to design for. Accounts are therefore reserved onto the
// listing row (stamped with the order id, `deliveredAt` still null) BEFORE the
// first message is sent, and a retry reuses that reservation instead of
// claiming fresh stock. Without that, a message that failed on send #2 would
// spend a second set of accounts on the next tick.
const MarketplaceListing = require("../models/MarketplaceListing");
const BotAccount = require("../models/BotAccount");
const { availableAccountsForSet } = require("../routes/shopRoutes");
const { loginsOnActiveListings, notListed } = require("./listedLogins");
const { decrypt } = require("./secretBox");
const {
  reserveSetOnAccount,
  releaseAccountsForTag,
} = require("./dropReservation");
const { getAutoFarm } = require("./settings");
const mp = require("./marketplaces");
const UnclaimedAccount = require("../models/UnclaimedAccount");
const copy = require("./playerauctionsCopy");
const proof = require("./playerauctionsProof");
const farmService = require("./playerauctionsFarmService");

// Distinct from the Shop / Gameflip / GGSel / Digiseller / Eldorado tags so the
// same account can never be handed out twice across platforms.
const PA_CLAIM_TAG = "playerauctions";

// Below this many pristine pool accounts, rent-farm orders are at risk.
const POOL_LOW_WATERMARK = 15;

// PlayerAuctions penalises late delivery directly (a "delivery guarantee
// expired" notice, then fees and hidden offers), so polling is frequent.
const TICK_MS = 60 * 1000;

const PA_SELLABLE_STATUSES = ["released", "skipped"];

// How many drops the buyer was promised, for the delivery-proof receipt.
// MarketplaceListing has no items field of its own, so this reads the title,
// which the house template always writes as "... (N Items) ...".
function paItemCount(row) {
  const m = String((row && row.title) || "").match(/\((\d+)\s*items?\)/i);
  return m ? parseInt(m[1], 10) : 0;
}

function undeliveredUnits(listing) {
  return (listing.units || []).filter((u) => !u.deliveredAt);
}

// Units already reserved for this order by an earlier, partly-failed attempt.
function unitsForOrder(listing, orderId) {
  return (listing.units || []).filter(
    (u) => String(u.orderId || "") === String(orderId),
  );
}

// --- Stock source 1: the Drop Archive (auto-farm pool) --------------------
// Mirrors the Eldorado claimer, including the cross-marketplace exclusion: the
// buyer receives the whole account, so an account already attached to any other
// live listing would ship that listing's drops too.
async function claimAccountsForSet(set, max) {
  const want = Math.max(1, parseInt(max, 10) || 1);
  const candidates = notListed(
    await availableAccountsForSet(set),
    await loginsOnActiveListings(),
  );
  const claimed = [];
  for (const c of candidates) {
    if (claimed.length >= want) break;
    const ok = await reserveSetOnAccount(c.accountId, set, {
      soldToUsername: PA_CLAIM_TAG,
      soldSetId: String(set._id),
    });
    if (!ok) continue;
    const account = await BotAccount.findById(c.accountId, {
      login: 1,
      credUsername: 1,
      credPassword: 1,
    }).lean();
    const login = account ? account.login || account.credUsername || "" : "";
    const password = account ? decrypt(account.credPassword) : "";
    // A unit with no readable password is not deliverable, so never let it
    // stand behind the offer's stock.
    if (!login || !password) {
      await releaseAccounts([c.accountId]);
      continue;
    }
    claimed.push({ accountId: String(c.accountId), login, password });
  }
  return claimed;
}

async function releaseAccounts(accountIds) {
  await releaseAccountsForTag(accountIds, PA_CLAIM_TAG);
}

// Drop the candidates whose advertised drops have already been claimed.
async function unclaimedOnly(set, candidates) {
  const DropLog = require("../models/DropLog");
  const names = ((set && set.items) || []).map((i) => i.name).filter(Boolean);
  if (!names.length) return candidates;
  const out = [];
  for (const c of candidates) {
    const logs = await DropLog.find(
      { login: c.login, name: { $in: names } },
      { claimed: 1 },
    ).lean();
    if (logs.some((l) => l.claimed)) continue;
    out.push(c);
  }
  return out;
}

// --- Stock source 2: the no-claim farm ----------------------------------
// Only "released" and "skipped" rows are sellable: "listed" means the account is
// already a stock unit on ANOTHER marketplace and selling it here would ship
// that listing's drops too; "sold"/"expired"/"removed" are spent or gone.
function unclaimedGameFilter(game) {
  const base = String(game || "").trim().replace(/\s*2$/, "");
  return new RegExp("^" + base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

async function claimUnclaimedForGame(game, want, { orderId, offerId, dryRun }) {
  const {
    credentialForLedger,
    manualSoldOwnerKeys,
    filterManualSoldLedgers,
    activeListingsForLogin,
  } = require("./unclaimedAutoList");

  const n = Math.max(1, parseInt(want, 10) || 1);
  const candidates = await UnclaimedAccount.find({
    source: "noclaim",
    game: unclaimedGameFilter(game),
    status: { $in: PA_SELLABLE_STATUSES },
    soldAt: null,
  })
    .sort({ lastCheckedAt: -1 })
    .limit(n * 6)
    .lean();

  const usable = filterManualSoldLedgers(
    candidates,
    await manualSoldOwnerKeys(candidates),
  );

  const out = [];
  for (const row of usable) {
    if (out.length >= n) break;
    const live = await activeListingsForLogin(row.login).catch(() => []);
    if (live && live.length) continue;

    const cred = await credentialForLedger(row);
    if (!cred.login || !cred.password) continue;

    if (dryRun) {
      out.push({ ledgerId: String(row._id), login: cred.login, password: cred.password });
      continue;
    }
    // Atomic: the status guard is what stops two ticks (or two orders) taking
    // the same account.
    const now = new Date();
    const taken = await UnclaimedAccount.findOneAndUpdate(
      { _id: row._id, status: { $in: PA_SELLABLE_STATUSES }, soldAt: null },
      {
        $set: {
          status: "sold",
          soldAt: now,
          market: "playerauctions",
          note: "playerauctions order " + (orderId || ""),
          lastCheckedAt: now,
        },
        $addToSet: { listingExternalIds: String(offerId || "") },
      },
      { new: true },
    );
    if (!taken) continue;
    out.push({ ledgerId: String(row._id), login: cred.login, password: cred.password });
  }
  return out;
}

// --- The hand-over ------------------------------------------------------
// Send every message, then confirm delivery with a proof image. Order is
// load-bearing: the credential must actually reach the buyer before the order
// is marked delivered.
// `alreadyMessaged` short-circuits the send half. A hand-over is several HTTP
// calls, so a confirm-delivery that fails after the messages landed must not
// re-send them — the buyer would get their credentials again every 60s until
// the confirm started working.
async function handOver({
  orderId, accounts, kind, days, game, offerTitle, itemCount,
  alreadyMessaged = false, onMessaged,
}) {
  const messages = copy.deliveryMessages(accounts, { kind, days, game });
  if (!alreadyMessaged) {
    for (const m of messages) {
      await mp.playerauctionsSendOrderMessage(orderId, m);
    }
    if (onMessaged) await onMessaged();
  }
  let img = null;
  try {
    img = await proof.buildDeliveryProof({
      orderId,
      offerTitle,
      accountCount: accounts.length,
      itemCount,
    });
    await mp.playerauctionsMarkDelivered(orderId, [img]);
  } finally {
    await proof.cleanupProof(img);
  }
  return messages.length;
}

// Re-read each account's password at delivery time rather than trusting the
// cached copy on the unit, so a rotated credential is never shipped stale.
async function credentialsForUnits(units) {
  const out = [];
  for (const u of units) {
    if (u.accountId) {
      const acct = await BotAccount.findById(u.accountId, {
        login: 1,
        credUsername: 1,
        credPassword: 1,
      }).lean();
      const login = acct ? acct.login || acct.credUsername || "" : "";
      const password = acct ? decrypt(acct.credPassword) : "";
      if (!login || !password) {
        throw new Error("unit " + u.accountId + " has no readable credential");
      }
      out.push({ login, password });
      continue;
    }
    // No-claim ledger unit: the credential lives on the ledger row.
    const { credentialForLedger } = require("./unclaimedAutoList");
    const row = u.contentId
      ? await UnclaimedAccount.findById(u.contentId).lean()
      : null;
    const cred = row ? await credentialForLedger(row) : { login: u.login };
    if (!cred.login || !cred.password) {
      throw new Error("unit " + (u.login || u.contentId) + " has no readable credential");
    }
    out.push({ login: cred.login, password: cred.password });
  }
  return out;
}

// Attach freshly claimed accounts to the listing, stamped with the order but
// NOT yet delivered. This is the resume anchor: if a later send fails, the next
// tick finds these and reuses them rather than spending more stock.
async function reserveOnListing(listing, orderId, picked) {
  listing.units = (listing.units || []).concat(
    picked.map((p) => ({
      contentId: p.ledgerId || "",
      accountId: p.accountId || "",
      login: p.login,
      addedAt: new Date(),
      deliveredAt: null,
      orderId: String(orderId),
    })),
  );
  listing.markModified("units");
  await listing.save();
}

async function markUnitsMessaged(listing, orderId) {
  const now = new Date();
  for (const u of listing.units || []) {
    if (String(u.orderId || "") === String(orderId) && !u.messagedAt) u.messagedAt = now;
  }
  listing.markModified("units");
  await listing.save();
}

async function markUnitsDelivered(listing, orderId) {
  const now = new Date();
  for (const u of listing.units || []) {
    if (String(u.orderId || "") === String(orderId) && !u.deliveredAt) {
      u.deliveredAt = now;
    }
  }
  listing.markModified("units");
  await listing.save();
}

// Keep the advertised stock honest. PlayerAuctions charges for late or failed
// delivery, so an offer advertising more than we hold is a direct liability.
//
// An update REPLACES the offer and issues a NEW offerId, so the listing row's
// externalId must be re-pointed in the same breath or the next order will not
// resolve to any listing at all.
async function syncStock(listing) {
  const af = getAutoFarm() || {};
  if (af.playerauctionsSyncStock === false) return null;
  const left = undeliveredUnits(listing).length;
  try {
    const r = await mp.playerauctionsSetQuantity(listing.externalId, left);
    if (r && r.replaced && r.offerId) {
      listing.externalId = String(r.offerId);
      listing.url = mp.playerauctionsOfferUrl(r.offerId);
      await listing.save();
    }
    return left;
  } catch (e) {
    console.error("playerauctions stock sync:", e.message);
    return null;
  }
}

// Deliver one paid order. Returns a short result the tick can log directly.
async function deliverOrder(order, { dryRun }) {
  const orderId = String(order.orderId || order.id || "");
  const qty = paQuantity(order);
  const offerTitle = String(order.orderTitle || "");

  // The seller orders LIST carries no offerId, so the id has to be recovered
  // from the offer link on the order detail; the title is the last resort
  // (it is the offer title verbatim, but two events can share one).
  const offerId =
    String(order.offerId || "") ||
    mp.playerauctionsOfferIdFromUrl(
      order.detail &&
        order.detail.orderInfo &&
        order.detail.orderInfo.offerInfo &&
        order.detail.orderInfo.offerInfo.link,
    );
  const row =
    (offerId &&
      (await MarketplaceListing.findOne({
        marketplace: "playerauctions",
        externalId: offerId,
      }))) ||
    (await MarketplaceListing.findOne({
      marketplace: "playerauctions",
      title: offerTitle,
    }));
  if (!row) return { orderId, skipped: "no listing row for " + JSON.stringify(offerTitle) };

  // Already fully delivered.
  const mine = unitsForOrder(row, orderId);
  if (mine.length && mine.every((u) => u.deliveredAt)) {
    return { orderId, skipped: "already delivered" };
  }

  // RESUME: a previous attempt reserved stock but did not finish. Reuse it.
  if (mine.length) {
    if (dryRun) {
      return {
        orderId,
        dryRun: true,
        resume: true,
        wouldSend: mine.length + " previously reserved account(s)",
      };
    }
    const creds = await credentialsForUnits(mine);
    const messaged = mine.every((u) => u.messagedAt);
    const sent = await handOver({
      orderId,
      accounts: creds,
      kind: "bundle",
      offerTitle,
      itemCount: paItemCount(row),
      alreadyMessaged: messaged,
      onMessaged: () => markUnitsMessaged(row, orderId),
    });
    await markUnitsDelivered(row, orderId);
    await syncStock(row);
    return { orderId, delivered: creds.length, messages: sent, resumed: true };
  }

  // No-claim-farm-backed offers resolve stock at delivery time.
  if (row.unclaimedGame) {
    const picked = await claimUnclaimedForGame(row.unclaimedGame, qty, {
      orderId,
      offerId: row.externalId,
      dryRun,
    });
    if (picked.length < qty) {
      return {
        orderId,
        error:
          "only " + picked.length + " of " + qty + " sellable " +
          row.unclaimedGame + " account(s) free in the no-claim farm",
      };
    }
    if (dryRun) {
      const msgs = copy.deliveryMessages(picked, { kind: "bundle" });
      return {
        orderId,
        dryRun: true,
        source: "unclaimed:" + row.unclaimedGame,
        wouldSend:
          qty + " account(s) [" + picked.map((p) => p.login).join(", ") + "] in " +
          msgs.length + " message(s)",
        preview: msgs.join("\n---\n"),
      };
    }
    await reserveOnListing(row, orderId, picked);
    const sent = await handOver({
      orderId,
      accounts: picked,
      kind: "bundle",
      offerTitle,
      itemCount: paItemCount(row),
      onMessaged: () => markUnitsMessaged(row, orderId),
    });
    await markUnitsDelivered(row, orderId);
    await syncStock(row);
    return {
      orderId,
      delivered: qty,
      messages: sent,
      source: "unclaimed:" + row.unclaimedGame,
    };
  }

  // A row with neither a stock source nor any reserved unit is not an
  // auto-delivery listing at all — it is a service or an offer the operator
  // fulfils by hand. Skip it quietly rather than erroring every tick.
  if (!row.autoClaimSet && !(row.units || []).length) {
    return {
      orderId,
      skipped: "manual-delivery listing (no unclaimedGame and no reserved units)",
    };
  }

  // Drop Archive bundles: claim accounts holding this listing's exact set.
  if (row.autoClaimSet && row.set) {
    const DropSet = require("../models/DropSet");
    const set = await DropSet.findById(row.set).lean();
    if (!set) return { orderId, error: "listing's DropSet is missing" };
    if (dryRun) {
      const avail = await availableAccountsForSet(set).catch(() => []);
      return {
        orderId,
        dryRun: true,
        source: "dropset:" + set.name,
        wouldSend: qty + " of " + avail.length + " available account(s)",
      };
    }
    // A CLAIMED drop cannot be connected to the buyer's own game account — it
    // has already gone to whoever the farm account was linked to, so shipping
    // one sells nothing. This is the whole reason the no-claim farm exists for
    // Overwatch / Rainbow Six / Call of Duty. Enforced per-account rather than
    // by game name, because a claimed drop is worthless whatever the game.
    const claimed = await unclaimedOnly(set, await claimAccountsForSet(set, qty));
    if (claimed.length < qty) {
      await releaseAccounts(claimed.map((c) => c.accountId)).catch(() => {});
      return {
        orderId,
        error:
          "only " + claimed.length + " of " + qty +
          " accounts still held the full set UNCLAIMED at delivery time",
      };
    }
    await reserveOnListing(row, orderId, claimed);
    const sent = await handOver({
      orderId,
      accounts: claimed,
      kind: "bundle",
      offerTitle,
      itemCount: paItemCount(row),
      onMessaged: () => markUnitsMessaged(row, orderId),
    });
    await markUnitsDelivered(row, orderId);
    await syncStock(row);
    return { orderId, delivered: qty, messages: sent, source: "dropset:" + set.name };
  }

  // Pre-reserved units.
  const free = undeliveredUnits(row).filter((u) => !u.orderId);
  if (free.length < qty) {
    return {
      orderId,
      error:
        "not enough reserved stock (" + free.length + " of " + qty + ") — " +
        "restock the offer, then this order will deliver on the next tick",
    };
  }
  const use = free.slice(0, qty);
  const creds = await credentialsForUnits(use);
  if (dryRun) {
    const msgs = copy.deliveryMessages(creds, { kind: "bundle" });
    return {
      orderId,
      dryRun: true,
      wouldSend: qty + " account(s) in " + msgs.length + " message(s)",
    };
  }
  for (const u of use) u.orderId = String(orderId);
  row.markModified("units");
  await row.save();

  const sent = await handOver({
    orderId,
    accounts: creds,
    kind: "bundle",
    offerTitle,
    itemCount: row.itemsPerUnit,
  });
  await markUnitsDelivered(row, orderId);
  await syncStock(row);
  return { orderId, delivered: qty, messages: sent };
}

// The orders list reports quantity as a string like "26 Other Skins", which is
// the ITEM count, not the unit count. Units are what we ship, so derive them
// from the order's price against the offer where possible and fall back to 1 —
// over-delivering because a display string was parsed as a unit count would
// hand out free accounts.
function paQuantity(order) {
  const n = parseInt(order && order.purchaseQuantity, 10);
  if (Number.isFinite(n) && n > 0) return n;
  const d = order && order.detail && order.detail.orderInfo &&
    order.detail.orderInfo.purchased;
  if (d && Number.isFinite(d.amount) && d.amount > 0) return Math.round(d.amount);
  return 1;
}

// One pass over every settled-but-undelivered PlayerAuctions order.
async function deliverPendingOrders() {
  const af = getAutoFarm() || {};
  if (!af.playerauctionsAutoDeliver) return { skipped: "playerauctionsAutoDeliver off" };
  if (!(mp.keyStatus().playerauctions || {}).configured) {
    return { skipped: "playerauctions not configured" };
  }
  const dryRun = af.playerauctionsDeliverDryRun !== false;

  let orders;
  try {
    // No pre-flight probe. paRequest refreshes-and-retries on 401 under the
    // cross-process lock, so an extra liveness call here would only be a second
    // racing refresher — which is what it was, once per 60s tick.
    orders = await mp.playerauctionsPendingOrders();
  } catch (e) {
    console.error("playerauctions fulfiller: could not read orders:", e.message);
    return { error: e.message };
  }
  if (!orders.length) return { orders: 0 };

  // The pool is the hard limit on rent-farm sales, and it is small. Surface it
  // once per tick rather than discovering it order by order.
  try {
    const poolLeft = (
      await require("./operatorFarm").previewFreshAccounts({ count: 1 })
    ).eligibleTotal;
    if (poolLeft <= POOL_LOW_WATERMARK) {
      console.error(
        "playerauctions fulfiller: only " + poolLeft + " pristine pool accounts " +
          "left — rent-farm orders will start failing. Top the pool up or pause " +
          "the farming listings.",
      );
    }
  } catch {
    /* the guard must never stop a delivery */
  }

  const results = [];
  for (const order of orders) {
    try {
      // Two products share this queue. A rent-farm order provisions a pool
      // account into the farm for a window; a bundle order hands over a farmed
      // account. deliverFarmOrder returns null when the order is not a
      // rent-farm one, which is what routes it to the bundle path.
      const r =
        (await farmService.deliverFarmOrder(order, { dryRun })) ||
        (await deliverOrder(order, { dryRun }));
      results.push(r);
      const id = r.orderId;
      if (r.error) console.error("playerauctions deliver " + id + ":", r.error);
      else if (r.dryRun)
        console.log("playerauctions deliver (DRY RUN) " + id + ":", r.wouldSend);
      else if (r.delivered)
        console.log(
          "playerauctions delivered " + id + ":",
          r.delivered + " account(s) in " + (r.messages || 1) + " message(s)",
        );
    } catch (e) {
      console.error("playerauctions deliver failed:", e.message);
      results.push({
        orderId: String(order.orderId || order.id || ""),
        error: e.message,
      });
    }
  }
  return { orders: orders.length, results };
}

let started = false;

function start() {
  if (started) return;
  started = true;
  const tick = async () => {
    try {
      await deliverPendingOrders();
    } catch (e) {
      console.error("playerauctions fulfiller error:", e.message);
    }
    const t = setTimeout(tick, TICK_MS);
    if (t.unref) t.unref();
  };
  // Self-guards on autoFarm.playerauctionsAutoDeliver, so starting it
  // unconditionally is a no-op until the flag is flipped on.
  const t = setTimeout(tick, 50 * 1000);
  if (t.unref) t.unref();
}

module.exports = {
  PA_CLAIM_TAG,
  POOL_LOW_WATERMARK,
  start,
  claimAccountsForSet,
  unclaimedOnly,
  claimUnclaimedForGame,
  unclaimedGameFilter,
  releaseAccounts,
  undeliveredUnits,
  paItemCount,
  unitsForOrder,
  credentialsForUnits,
  reserveOnListing,
  markUnitsMessaged,
  markUnitsDelivered,
  syncStock,
  handOver,
  paQuantity,
  deliverOrder,
  deliverPendingOrders,
};
