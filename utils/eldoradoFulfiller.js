// Eldorado.gg auto-delivery.
//
// Eldorado has NO credential vault for the Twitch Drops category — its native
// "automatic delivery" is a Roblox in-game trading bot and can never hand over
// a Twitch login (verified 2026-09-06; see docs/ELDORADO-INTEGRATION-PLAN.md).
// So delivery is what the top seller in the category does: the moment an order
// is paid, post the credential into the order's chat and mark it delivered.
// That seller's median delivery time is 35 seconds, which is the bar.
//
// An Eldorado offer is ONE listing whose quantity is the number of accounts
// behind it, so a single order can buy several units at once. The reserved
// accounts are tracked as `units` on the MarketplaceListing row, and each unit
// is stamped with the order that consumed it — which is what makes delivering
// the same order twice impossible.
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
const farmService = require("./eldoradoFarmService");

// Distinct from the Shop / Gameflip / GGSel / Digiseller tags so the same
// account can never be handed out twice across platforms.
const ELD_CLAIM_TAG = "eldorado";

function eldoradoDeliveryCode(login, password) {
  return (
    "TWITCH DROP ACCOUNT\n\n" +
    "Username: " + login + "\n" +
    "Password: " + password + "\n\n" +
    "HOW TO CLAIM\n" +
    "1. Log in to this Twitch account and open " +
    "https://www.twitch.tv/drops/inventory\n" +
    '2. Scroll to the "Received" section at the bottom of the page.\n' +
    '3. Click the purple "Connect" button under each item and follow the steps ' +
    "to link it to YOUR OWN game account.\n\n" +
    "KEEP IT LINKED\n" +
    "If this event is still running, more items can still land on this " +
    "account — our farm keeps collecting them automatically. Just leave it " +
    "linked and check the drops inventory page again in a day or two, and " +
    "claim anything new that has appeared.\n\n" +
    "Please do not change the account's password or email, and claim your " +
    "items reasonably soon — drops stay claimable only for a limited time " +
    "after an event ends.\n\n" +
    "Any problem at all, message me here first and I will make it right. And " +
    "if you are happy with the order, leaving a feedback would genuinely mean " +
    "a lot — it helps a small seller more than you would think. Thank you!"
  );
}

// Atomically reserve up to `max` unsold accounts that each hold the whole
// bundle. Mirrors the Digiseller claimer, including the cross-marketplace
// exclusion: the buyer receives the whole account, so an account already
// attached to any other live listing would ship that listing's drops too.
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
      soldToUsername: ELD_CLAIM_TAG,
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
    // stand behind the offer's quantity.
    if (!login || !password) {
      await releaseAccounts([c.accountId]);
      continue;
    }
    claimed.push({ accountId: String(c.accountId), login, password });
  }
  return claimed;
}

async function releaseAccounts(accountIds) {
  await releaseAccountsForTag(accountIds, ELD_CLAIM_TAG);
}


// --- Stock source 2: the unclaimed / no-claim farm ------------------------
// Some Eldorado offers are not backed by the auto-farm pool at all — their
// stock is the no-claim farm's own accounts (models/UnclaimedAccount, fed by
// the noclaim-bot-* containers). Those rows carry the unclaimed drops and a
// pointer to the credential owner, so they can be handed to a buyer directly.
// A listing opts into this by setting `unclaimedGame`.
//
// Only "released" and "skipped" rows are sellable: "listed" means the account is
// already a stock unit on ANOTHER marketplace and selling it here would ship
// that listing's drops too; "sold"/"expired"/"removed" are spent or gone.
const ELD_SELLABLE_STATUSES = ["released", "skipped"];

function unclaimedGameFilter(game) {
  // The ledger holds both "Overwatch" and "overwatch" (and callers may pass
  // "Overwatch 2"), so match on a loose, anchored prefix rather than equality.
  const base = String(game || "").trim().replace(/\s*2$/, "");
  return new RegExp("^" + base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

// Pick (and optionally claim) sellable no-claim accounts for a game.
// `dryRun` selects without mutating anything.
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
    status: { $in: ELD_SELLABLE_STATUSES },
    soldAt: null,
  })
    .sort({ lastCheckedAt: -1 })
    .limit(n * 6)
    .lean();

  // An owner the operator has already hand-sold is off limits even though the
  // ledger row still looks free.
  const usable = filterManualSoldLedgers(
    candidates,
    await manualSoldOwnerKeys(candidates),
  );

  const out = [];
  for (const row of usable) {
    if (out.length >= n) break;
    // Never ship an account that is live on another marketplace's listing.
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
      { _id: row._id, status: { $in: ELD_SELLABLE_STATUSES }, soldAt: null },
      {
        $set: {
          status: "sold",
          soldAt: now,
          market: "eldorado",
          note: "eldorado order " + (orderId || ""),
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

function undeliveredUnits(listing) {
  return (listing.units || []).filter((u) => !u.deliveredAt && u.accountId);
}

// Reserve more accounts behind an existing Eldorado offer and push the new
// stock count to Eldorado. Returns how many units were added.
async function restockListing(listing, set, want) {
  const claimed = await claimAccountsForSet(set, want);
  if (!claimed.length) return 0;
  listing.units = (listing.units || []).concat(
    claimed.map((c) => ({
      contentId: "",
      accountId: c.accountId,
      login: c.login,
      addedAt: new Date(),
      deliveredAt: null,
      orderId: "",
    })),
  );
  await listing.save();
  await mp
    .eldoradoSetQuantity(listing.externalId, undeliveredUnits(listing).length)
    .catch((e) => console.error("eldorado restock quantity:", e.message));
  return claimed.length;
}

// Deliver one paid order. Returns a short result describing what happened so
// the tick can log it without re-deriving anything.
async function deliverOrder(order, { dryRun }) {
  const orderId = String(order.id || "");
  const offerId = String(order.offerId || "");
  const qty = Math.max(1, parseInt(order.purchaseQuantity, 10) || 1);

  const listing = await MarketplaceListing.findOne({
    marketplace: "eldorado",
    externalId: offerId,
  });
  if (!listing)
    return { orderId, skipped: "no listing row for offer " + offerId };

  // Already handled: some unit carries this order id.
  if ((listing.units || []).some((u) => u.orderId === orderId)) {
    return { orderId, skipped: "already delivered" };
  }

  // Unclaimed-farm-backed offers resolve their stock at delivery time out of the
  // no-claim ledger rather than from pre-reserved units.
  if (listing.unclaimedGame) {
    const picked = await claimUnclaimedForGame(listing.unclaimedGame, qty, {
      orderId,
      offerId,
      dryRun,
    });
    if (picked.length < qty) {
      return {
        orderId,
        error:
          "only " + picked.length + " of " + qty + " sellable " +
          listing.unclaimedGame + " account(s) free in the no-claim farm",
      };
    }
    const blocks = picked.map((p) => eldoradoDeliveryCode(p.login, p.password));
    const message =
      qty > 1
        ? blocks
            .map((b, i) => "=== ACCOUNT " + (i + 1) + " of " + qty + " ===\n\n" + b)
            .join("\n\n")
        : blocks[0];
    if (dryRun) {
      return {
        orderId,
        dryRun: true,
        source: "unclaimed:" + listing.unclaimedGame,
        wouldSend:
          qty + " account(s) [" + picked.map((p) => p.login).join(", ") + "], " +
          message.length + " chars",
        preview: message,
      };
    }
    await mp.eldoradoSendOrderMessage(order, message);
    await mp.eldoradoMarkDelivered(orderId);
    listing.units = (listing.units || []).concat(
      picked.map((p) => ({
        contentId: p.ledgerId,
        accountId: "",
        login: p.login,
        addedAt: new Date(),
        deliveredAt: new Date(),
        orderId,
      })),
    );
    listing.markModified("units");
    await listing.save();
    return { orderId, delivered: qty, source: "unclaimed:" + listing.unclaimedGame };
  }

  // A row with neither a stock source nor any reserved unit is not an
  // auto-delivery listing at all — it is a service (e.g. "Automatic farming,
  // 120 days") or an offer the operator fulfils by hand. Skip it quietly rather
  // than erroring every tick for an order the bot was never meant to deliver.
  if (!listing.autoClaimSet && !(listing.units || []).length) {
    return {
      orderId,
      skipped: "manual-delivery listing (no unclaimedGame and no reserved units)",
    };
  }

  // Bundle listings whose stock is the Drop Archive (NOT the no-claim farm):
  // claim accounts that hold this listing's exact set at delivery time.
  if (listing.autoClaimSet && listing.set) {
    const DropSet = require("../models/DropSet");
    const set = await DropSet.findById(listing.set).lean();
    if (!set) return { orderId, error: "listing's DropSet is missing" };
    if (dryRun) {
      const { availableAccountsForSet } = require("../routes/shopRoutes");
      const avail = await availableAccountsForSet(set).catch(() => []);
      return {
        orderId,
        dryRun: true,
        source: "dropset:" + set.name,
        wouldSend: qty + " of " + avail.length + " available account(s)",
      };
    }
    const claimed = await claimAccountsForSet(set, qty);
    if (claimed.length < qty) {
      await releaseAccounts(claimed.map((c) => c.accountId)).catch(() => {});
      return {
        orderId,
        error:
          "only " + claimed.length + " of " + qty +
          " accounts still held the full set at delivery time",
      };
    }
    const blocks = claimed.map((c) => eldoradoDeliveryCode(c.login, c.password));
    const message =
      qty > 1
        ? blocks
            .map((b, i) => "=== ACCOUNT " + (i + 1) + " of " + qty + " ===\n\n" + b)
            .join("\n\n")
        : blocks[0];
    await mp.eldoradoSendOrderMessage(order, message);
    await mp.eldoradoMarkDelivered(orderId);
    listing.units = (listing.units || []).concat(
      claimed.map((c) => ({
        contentId: "",
        accountId: c.accountId,
        login: c.login,
        addedAt: new Date(),
        deliveredAt: new Date(),
        orderId,
      })),
    );
    listing.markModified("units");
    await listing.save();
    return { orderId, delivered: qty, source: "dropset:" + set.name };
  }

  const free = undeliveredUnits(listing);
  if (free.length < qty) {
    return {
      orderId,
      error:
        "not enough reserved stock (" +
        free.length +
        " of " +
        qty +
        ") — " +
        "restock the offer, then this order will deliver on the next tick",
    };
  }
  const use = free.slice(0, qty);

  // Re-read each account's password at delivery time rather than trusting a
  // cached copy, so a rotated credential is never shipped stale.
  const blocks = [];
  for (const u of use) {
    const acct = await BotAccount.findById(u.accountId, {
      login: 1,
      credUsername: 1,
      credPassword: 1,
    }).lean();
    const login = acct ? acct.login || acct.credUsername || "" : "";
    const password = acct ? decrypt(acct.credPassword) : "";
    if (!login || !password) {
      return {
        orderId,
        error: "unit " + u.accountId + " has no readable credential",
      };
    }
    blocks.push(eldoradoDeliveryCode(login, password));
  }
  const message =
    qty > 1
      ? blocks
          .map(
            (b, i) => "=== ACCOUNT " + (i + 1) + " of " + qty + " ===\n\n" + b,
          )
          .join("\n\n")
      : blocks[0];

  if (dryRun) {
    return {
      orderId,
      dryRun: true,
      wouldSend: qty + " account(s), " + message.length + " chars",
    };
  }

  // Order matters: the credential must actually reach the buyer before the
  // order is marked delivered, and the units are only burned once both have
  // succeeded. A send that throws leaves the order untouched for a retry.
  await mp.eldoradoSendOrderMessage(order, message);
  await mp.eldoradoMarkDelivered(orderId);

  const now = new Date();
  for (const u of use) {
    const target = listing.units.find(
      (x) => x.accountId === u.accountId && !x.deliveredAt,
    );
    if (target) {
      target.deliveredAt = now;
      target.orderId = orderId;
    }
  }
  listing.markModified("units");
  await listing.save();

  await mp
    .eldoradoSetQuantity(offerId, undeliveredUnits(listing).length)
    .catch((e) => console.error("eldorado post-delivery quantity:", e.message));

  return { orderId, delivered: qty };
}

// One pass over every paid-but-undelivered Eldorado order.
async function deliverPaidOrders() {
  const af = getAutoFarm() || {};
  if (!af.eldoradoAutoDeliver) return { skipped: "eldoradoAutoDeliver off" };
  if (!(mp.keyStatus().eldorado || {}).configured) {
    return { skipped: "eldorado not configured" };
  }
  const dryRun = af.eldoradoDeliverDryRun !== false;

  let orders;
  try {
    await mp.eldoradoEnsureFreshSession();
    orders = await mp.eldoradoPaidOrders();
  } catch (e) {
    console.error("eldorado fulfiller: could not read orders:", e.message);
    return { error: e.message };
  }
  if (!orders.length) return { orders: 0 };

  // The pool is the hard limit on rent-farm sales, and it is small. Surface it
  // once per tick rather than discovering it order by order.
  let poolLeft = null;
  try {
    poolLeft = (await require("./operatorFarm").previewFreshAccounts({ count: 1 }))
      .eligibleTotal;
    if (poolLeft <= POOL_LOW_WATERMARK) {
      console.error(
        "eldorado fulfiller: only " + poolLeft + " pristine pool accounts left — " +
          "rent-farm orders will start failing. Top the pool up or pause the " +
          "farming listings.",
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
      // account. deliverFarmOrder returns null when the order is not a rent-farm
      // one, which is what routes it to the bundle path.
      const r =
        (await farmService.deliverFarmOrder(order, { dryRun })) ||
        (await deliverOrder(order, { dryRun }));
      results.push(r);
      if (r.error)
        console.error("eldorado deliver " + r.orderId + ":", r.error);
      else if (r.dryRun)
        console.log(
          "eldorado deliver (DRY RUN) " + r.orderId + ":",
          r.wouldSend,
        );
      else if (r.delivered)
        console.log(
          "eldorado delivered " + r.orderId + ":",
          r.delivered + " account(s)",
        );
    } catch (e) {
      console.error("eldorado deliver failed:", e.message);
      results.push({ orderId: String(order.id || ""), error: e.message });
    }
  }
  return { orders: orders.length, results };
}

// Delivery is only worth polling often — a buyer waiting on credentials is the
// whole product. 60s keeps us well inside the "20 min" promise on the offers
// while staying nowhere near Eldorado's rate limits.
// Below this many pristine pool accounts, rent-farm orders are at risk.
const POOL_LOW_WATERMARK = 15;

const TICK_MS = 60 * 1000;
let started = false;

function start() {
  if (started) return;
  started = true;
  const tick = async () => {
    try {
      await deliverPaidOrders();
    } catch (e) {
      console.error("eldorado fulfiller error:", e.message);
    }
    const t = setTimeout(tick, TICK_MS);
    if (t.unref) t.unref();
  };
  // Self-guards on autoFarm.eldoradoAutoDeliver, so starting it unconditionally
  // is a no-op until the flag is flipped on.
  const t = setTimeout(tick, 45 * 1000);
  if (t.unref) t.unref();
}

module.exports = {
  ELD_CLAIM_TAG,
  start,
  eldoradoDeliveryCode,
  claimAccountsForSet,
  claimUnclaimedForGame,
  unclaimedGameFilter,
  releaseAccounts,
  restockListing,
  undeliveredUnits,
  deliverOrder,
  deliverPaidOrders,
};
