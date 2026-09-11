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
const { getAutoFarm, getAccountListingSettings } = require("./settings");
const mp = require("./marketplaces");
const UnclaimedAccount = require("../models/UnclaimedAccount");
const farmService = require("./eldoradoFarmService");
const coverage = require("./unclaimedCoverage");

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
// `claimTag` is which shop the reservation belongs to. It is a parameter and
// not a constant because the Z2U fulfiller reuses this exact claim path: a
// second copy would drift, and a drifted copy of THIS function oversells an
// account. The tag must be one of utils/marketClaimTags, or the drop archive
// reads a merely-reserved account as really sold.
async function claimAccountsForSet(set, max, { claimTag = ELD_CLAIM_TAG } = {}) {
  const want = Math.max(1, parseInt(max, 10) || 1);
  const candidates = notListed(
    await availableAccountsForSet(set),
    await loginsOnActiveListings(),
  );
  const claimed = [];
  for (const c of candidates) {
    if (claimed.length >= want) break;
    const ok = await reserveSetOnAccount(c.accountId, set, {
      soldToUsername: claimTag,
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
      await releaseAccounts([c.accountId], claimTag);
      continue;
    }
    claimed.push({ accountId: String(c.accountId), login, password });
  }
  return claimed;
}

async function releaseAccounts(accountIds, claimTag = ELD_CLAIM_TAG) {
  await releaseAccountsForTag(accountIds, claimTag);
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

// Ceiling on the stock an unclaimed-backed offer may advertise. The count comes
// from a dry-run claim, which resolves a credential per candidate, so it is
// bounded rather than "however many the farm holds".
const UNCLAIMED_STOCK_MAX = 25;

// Most live inventory reads one call to claimUnclaimedForGame may make. Bounds
// the Twitch fan-out of both delivery and the periodic stock sync.
const LIVE_CHECK_MAX = 40;

function unclaimedGameFilter(game) {
  // The ledger holds both "Overwatch" and "overwatch" (and callers may pass
  // "Overwatch 2"), so match on a loose, anchored prefix rather than equality.
  const base = String(game || "").trim().replace(/\s*2$/, "");
  return new RegExp("^" + base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

// Pick (and optionally claim) sellable no-claim accounts for a game.
// `dryRun` selects without mutating anything.
//
// `requiredDrops` is the listing's advertised item list. When it is set, an
// account only qualifies if it holds EVERY entry (counts included) and none of
// them is already claimed — picking by game alone is what shipped a 7-item
// account against a 10-item CAH listing on order 99d443eb. `shortfall` is filled
// in with why the stock fell short, so the caller can say it out loud.
async function claimUnclaimedForGame(
  game,
  want,
  { orderId, offerId, dryRun, requiredDrops, shortfall, market = "eldorado" },
) {
  const {
    credentialForLedger,
    manualSoldOwnerKeys,
    filterManualSoldLedgers,
    activeListingsForLogin,
  } = require("./unclaimedAutoList");

  const n = Math.max(1, parseInt(want, 10) || 1);

  // RESUME WHATEVER A PREVIOUS ATTEMPT ALREADY TOOK FOR THIS ORDER.
  //
  // The claim further down is atomic and PERMANENT: it flips the ledger row to
  // status "sold" and stamps this order's id into `note`. But the record that
  // links those accounts back to the order lives in MarketplaceListing.units,
  // and that is written only AFTER the credential has been sent. So a send that
  // throws — a TalkJS 5xx, a timeout, an order row with no conversation id —
  // left the accounts sold, no unit row, and nothing at all tying the two
  // together. The caller's "already handled" guard asks
  // `listing.units.some(u => u.orderId === orderId)`, finds nothing, and the
  // next 60-second tick claims a BRAND NEW set. Eldorado order e69b19d3 retried
  // 25 times; every failing attempt spent more of the no-claim ledger and
  // orphaned what it spent, because nothing can find a sold row whose order was
  // never recorded anywhere else.
  //
  // The note was always the anchor — it simply was never read back. Reading it
  // makes the claim idempotent per order, so a retry re-sends to the same buyer
  // with the SAME accounts instead of burning the ledger again.
  const resumed = [];
  if (orderId && !dryRun) {
    const prior = await UnclaimedAccount.find({
      status: "sold",
      market,
      note: market + " order " + String(orderId),
    })
      .limit(n)
      .lean();
    for (const row of prior) {
      const cred = await credentialForLedger(row);
      // An account we cannot read a password for is no use to the buyer, but it
      // is still spent — leaving it out here would make the top-up below claim a
      // replacement, which is the very double-spend this block exists to stop.
      // Report the shortfall instead.
      if (!cred.login || !cred.password) continue;
      resumed.push({
        ledgerId: String(row._id),
        login: cred.login,
        password: cred.password,
      });
    }
    if (resumed.length >= n) return resumed.slice(0, n);
  }

  const required = coverage.requiredCounts(requiredDrops);
  // With a coverage gate most candidates are rejected on their drops alone, so
  // read a deeper slice of the ledger — otherwise a listing whose stock is rare
  // reads as out of stock while covering accounts sit just past the cut.
  const scan = required.size ? Math.max(n * 6, 200) : n * 6;
  const candidates = await UnclaimedAccount.find({
    source: "noclaim",
    game: unclaimedGameFilter(game),
    status: { $in: ELD_SELLABLE_STATUSES },
    soldAt: null,
  })
    .sort({ lastCheckedAt: -1 })
    .limit(scan)
    .lean();

  // Try the accounts the ledger already vouches for first; the rest stay in the
  // queue because the ledger is only a partial snapshot and DropLog may still
  // prove them out. This is ordering, not filtering.
  const { covering, short } = coverage.partitionByCoverage(candidates, required);
  const ordered = covering.concat(short);

  // An owner the operator has already hand-sold is off limits even though the
  // ledger row still looks free.
  const usable = filterManualSoldLedgers(
    ordered,
    await manualSoldOwnerKeys(ordered),
  );
  const rejected = [];
  // Live verification is one Twitch call per candidate, and this same function
  // is what the 15-minute stock sync uses to count stock — so on a big ledger an
  // unbounded walk would fan out hundreds of GQL reads per sync. Cap the live
  // checks; the ledger-covering candidates are walked first, so the cap costs
  // nothing until stock is genuinely scarce, and under-counting stock is the
  // safe direction to be wrong.
  let liveChecks = 0;

  // Seeded with anything a previous attempt already claimed for this order, so
  // the walk below only ever tops up the difference.
  const out = resumed.slice();
  for (const row of usable) {
    if (out.length >= n) break;
    // Never ship an account that is live on another marketplace's listing.
    const live = await activeListingsForLogin(row.login).catch(() => []);
    if (live && live.length) continue;

    // The gate: hold every advertised item, and hold them UNCLAIMED. A claimed
    // drop has already been connected to whoever the farm account was linked
    // to, so shipping it sells the buyer nothing.
    if (required.size) {
      if (liveChecks >= LIVE_CHECK_MAX) break;
      liveChecks += 1;
      // Live Twitch inventory, not the ledger: an expired wave silently drops
      // out of what the buyer can claim, and only Twitch knows that.
      const verdict = await coverage.liveCoverage(row, required);
      if (!verdict.ok) {
        rejected.push({ row, verdict });
        continue;
      }
    }

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
          // Which shop actually took this unit. Defaulted rather than hardcoded
          // so the Z2U fulfiller can reuse this claim path verbatim — a copy of
          // it would drift, and the drift would be an oversold account.
          market,
          note: market + " order " + (orderId || ""),
          lastCheckedAt: now,
        },
        $addToSet: { listingExternalIds: String(offerId || "") },
      },
      { new: true },
    );
    if (!taken) continue;
    out.push({ ledgerId: String(row._id), login: cred.login, password: cred.password });
  }
  // Say WHY the stock fell short, in terms of the advertised items — "no
  // Overwatch accounts" would be wrong and unactionable when what is actually
  // missing is the second wave's loot box.
  if (shortfall && out.length < n && rejected.length) {
    shortfall.detail = coverage.summarizeMissing(
      rejected.map((r) => r.verdict.missing),
    );
    const claimed = rejected.filter((r) => r.verdict.claimed.length);
    if (claimed.length) {
      shortfall.claimed =
        claimed.length + " account(s) already had an advertised drop CLAIMED";
    }
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

  // ACCOUNT LISTINGS (docs/ACCOUNT-LISTINGS-CONTRACT.md B5). The stock is the
  // exact list of accounts the owner pasted onto the offer, claimed one ledger
  // row per unit — no DropSet, no DropLog row, no reservation. The whole branch
  // is guarded on `accountOffer` and requires the module inside itself, so a row
  // without the field takes byte-for-byte the paths it took before this existed.
  //
  // It sits ABOVE the unclaimedGame branch on purpose: a row that somehow
  // carried both must hand over the owner's OWN accounts and never a farmed one
  // off the no-claim ledger. It must also never reach the reserved-units tail
  // further down, which filters on `u.accountId` — a supplied unit deliberately
  // has none, so that tail would read this row as having zero stock.
  if (listing.accountOffer) {
    const supplied = require("./suppliedStock");
    const gate = getAccountListingSettings();
    if (!gate.enabled || !gate.autoDeliver) {
      return { orderId, skipped: "account-listing auto-delivery is off" };
    }
    const AccountOffer = require("../models/AccountOffer");
    const offer = await AccountOffer.findById(listing.accountOffer).lean();
    if (!offer) return { orderId, error: "listing's AccountOffer is missing" };
    if (offer.autoDeliver === false) {
      return {
        orderId,
        skipped: 'auto-delivery is off for offer "' + offer.title + '"',
      };
    }

    const picked = await supplied.claimForListing(listing, qty, {
      orderId,
      market: "eldorado",
      dryRun,
    });
    if (picked.length < qty) {
      // Deliberately NOT released. claimForListing resumes by orderId, so what
      // this attempt took stays held for THIS buyer and the retry re-sends the
      // same accounts; putting them back would offer them to a second buyer
      // while a paid order is still short. "out of stock" matches ALERT_REASONS,
      // so a human hears about it.
      return {
        orderId,
        error:
          "out of stock: only " + picked.length + " of " + qty +
          ' account(s) left on offer "' + offer.title + '"',
      };
    }

    const blocks = [];
    for (const p of picked) {
      blocks.push(await supplied.deliveryText(p, offer));
    }
    const message =
      qty > 1
        ? blocks
            .map((b, i) => "=== ACCOUNT " + (i + 1) + " of " + qty + " ===\n\n" + b)
            .join("\n\n")
        : blocks[0];
    if (!String(message || "").trim()) {
      // Never send an empty message and then mark the order delivered. This
      // file already shipped "Username: undefined" to a paying buyer once; an
      // empty render is the same failure with nothing at all in it.
      return { orderId, error: "delivery text rendered empty for this offer" };
    }
    if (dryRun) {
      return {
        orderId,
        dryRun: true,
        source: "offer:" + offer.title,
        wouldSend:
          qty + " account(s) [" + picked.map((p) => p.login).join(", ") + "], " +
          message.length + " chars",
        preview: message,
      };
    }

    // Send, mark the order, then burn the ledger. A send that throws leaves the
    // rows claimed under this order id and the resume inside claimForListing
    // hands the SAME accounts back next tick instead of spending more stock —
    // the e69b19d3 lesson, designed in from the start here.
    await mp.eldoradoSendOrderMessage(order, message);
    await mp.eldoradoMarkDelivered(orderId);
    await supplied.markDelivered(
      picked.map((p) => p.ledgerId),
      { orderId, market: "eldorado" },
    );
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

    // Push the new count now instead of waiting up to 15 minutes for the stock
    // sync: an offer still advertising a unit the ledger no longer holds is a
    // paid order the bot cannot ship. A count we could not READ is left alone —
    // zero takes the offer off sale, and a failed read is not an empty shelf.
    let left = null;
    try {
      left = await supplied.stockFor(listing);
    } catch (e) {
      console.error("eldorado supplied stock recount:", e.message);
    }
    if (typeof left === "number" && left > 0) {
      await mp
        .eldoradoSetQuantity(offerId, left)
        .catch((e) => console.error("eldorado post-delivery quantity:", e.message));
    } else if (left === 0) {
      await mp
        .eldoradoDelist(offerId)
        .catch((e) => console.error("eldorado pause (list empty):", e.message));
      listing.autoPaused = true;
      listing.lastError = "paused: the account list is empty";
      await listing.save();
    }
    return { orderId, delivered: qty, source: "offer:" + offer.title };
  }

  // NO-CLAIM SHOP LISTINGS (docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md §8b). The
  // owner's hand-made listing over a no-claim DropSet: the accounts are claimed
  // out of the no-claim farm when the order lands, through utils/noclaimStock —
  // the ONE claim layer, which also refuses any account on another listing.
  // Everything after the claim is the unclaimedGame branch below, send for send.
  //
  // It sits ABOVE the unclaimedGame branch and far above the autoClaimSet one on
  // purpose: the row carries `set` (the no-claim set), and the set path ships
  // CLAIMED Drop Archive accounts, which are worthless to a no-claim buyer.
  // Required lazily so a row without the flag never loads the no-claim layer.
  if (listing.noclaimStock) {
    const ncs = require("./noclaimStock");
    if (!ncs.deliveryEnabled()) {
      return { orderId, skipped: "no-claim listing auto-delivery is off" };
    }
    const DropSet = require("../models/DropSet");
    const set = await DropSet.findById(listing.set).lean();
    // mode "sold" + this order's id is the resume anchor: a retry after a send
    // that threw gets back the SAME accounts this order already took, never a
    // fresh set (the e69b19d3 lesson). `dryRun` must reach the claim, or a dry
    // run would sell the ledger for an order it never sends.
    const picked = set
      ? await ncs.claimForSet(set, qty, {
          market: "eldorado",
          listingId: String(listing._id),
          orderId,
          mode: "sold",
          dryRun,
        })
      : [];
    if (picked.length < qty) {
      // Hold the order rather than ship a short account, and release nothing:
      // what was taken stays sold to THIS order and the next tick resumes it.
      const advertised =
        (listing.requiredDrops || []).length || ((set && set.items) || []).length;
      return {
        orderId,
        error:
          "only " + picked.length + " of " + qty + " account(s) could be claimed" +
          " — no free no-claim account holds all " + advertised +
          " advertised item(s)" +
          (set ? "" : " (the listing's no-claim set is missing)"),
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
        source: "noclaim-set:" + String(listing.set),
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
    // The sale stamp, only once the buyer has the account. The ledger has been
    // "sold" to this order since the claim; this records the price. It is
    // bookkeeping, not delivery, so a failure is logged and never turns an
    // order the buyer already has into a failed one.
    try {
      await ncs.markSold(
        picked.map((p) => p.ledgerId),
        {
          market: "eldorado",
          priceUsd: eldoradoUnitPriceUsd(order, qty, listing.price),
          orderId,
          reason: "eldorado order " + orderId,
        },
      );
    } catch (e) {
      console.error("eldorado no-claim markSold " + orderId + ":", e.message);
    }
    return { orderId, delivered: qty, source: "noclaim-set:" + String(listing.set) };
  }

  // Unclaimed-farm-backed offers resolve their stock at delivery time out of the
  // no-claim ledger rather than from pre-reserved units.
  if (listing.unclaimedGame) {
    const shortfall = {};
    const picked = await claimUnclaimedForGame(listing.unclaimedGame, qty, {
      orderId,
      offerId,
      dryRun,
      requiredDrops: listing.requiredDrops,
      shortfall,
    });
    if (picked.length < qty) {
      // Hold the order rather than ship a short account: the buyer waiting is
      // recoverable, an account missing half the advertised items is a dispute.
      return {
        orderId,
        error:
          "only " + picked.length + " of " + qty + " sellable " +
          listing.unclaimedGame + " account(s) free in the no-claim farm" +
          ((listing.requiredDrops || []).length
            ? " holding all " + (listing.requiredDrops || []).length +
              " advertised item(s)" +
              (shortfall.detail ? " — short of: " + shortfall.detail : "")
            : ""),
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
    // A claimed drop cannot be connected to the buyer's game account — it has
    // already gone to whoever the farm account was linked to. Shipping one is
    // selling nothing. This is the reason Overwatch / Rainbow Six / Call of Duty
    // have their own no-claim farm, but the invariant holds for every game, so
    // it is enforced here rather than by game name.
    const unclaimedOnly = async (cands) => {
      const DropLog = require("../models/DropLog");
      const names = (set.items || []).map((i) => i.name).filter(Boolean);
      const out = [];
      for (const c of cands) {
        const logs = await DropLog.find(
          { login: c.login, name: { $in: names } },
          { claimed: 1 },
        ).lean();
        if (logs.some((l) => l.claimed)) continue;
        out.push(c);
      }
      return out;
    };

    const claimed = await unclaimedOnly(await claimAccountsForSet(set, qty));
    if (claimed.length < qty) {
      await releaseAccounts(claimed.map((c) => c.accountId)).catch(() => {});
      return {
        orderId,
        error:
          "only " + claimed.length + " of " + qty +
          " accounts still held the full set UNCLAIMED at delivery time",
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

// What ONE unit of an order sold for, for the no-claim sale ledger
// (docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md §8b): the order's own total over the
// units it bought, else the listing's price. Nothing here read `totalPrice`
// before (docs/ELDORADO-INTEGRATION-PLAN.md lists it on the order row), so its
// shape is not pinned: a bare number and an {amount, currency} object are both
// accepted, and anything else — or a currency that is not USD — falls back to
// the listing price rather than record a guess.
function eldoradoUnitPriceUsd(order, qty, listingPrice) {
  const tp = order && order.totalPrice;
  let paid = NaN;
  if (typeof tp === "number" || typeof tp === "string") paid = Number(tp);
  else if (tp && typeof tp === "object" && (!tp.currency || /^usd$/i.test(tp.currency))) {
    paid = Number(tp.amount);
  }
  const n = Math.max(1, parseInt(qty, 10) || 1);
  if (Number.isFinite(paid) && paid > 0) return Math.round((paid / n) * 100) / 100;
  const own = Number(listingPrice);
  return Number.isFinite(own) && own > 0 ? own : 0;
}


// Keep every claim-from-archive listing's advertised stock equal to what can
// ACTUALLY be claimed, and take a listing off sale the moment that reaches zero.
//
// Advertised stock drifts on its own: accounts get sold on other marketplaces,
// attached to other listings, or lose their drops. A listing that keeps selling
// past that point takes money for something the fulfiller then cannot hand over
// — which is exactly how one Overwatch order sat undelivered, retrying every
// tick, while the buyer waited.
async function syncBundleStock({ dryRun = false } = {}) {
  const MarketplaceListing = require("../models/MarketplaceListing");
  const DropSet = require("../models/DropSet");
  const { availableAccountsForSet } = require("../routes/shopRoutes");
  const listedElsewhere = await loginsOnActiveListings();
  // Two stock sources, one rule. `autoClaimSet` rows are backed by the Drop
  // Archive; `unclaimedGame` rows are backed by the no-claim ledger and were
  // not covered here at all, so their advertised quantity was whatever they
  // were published with, for as long as they stayed up.
  const rows = await MarketplaceListing.find({
    marketplace: "eldorado",
    $or: [
      { autoClaimSet: true },
      { unclaimedGame: { $nin: ["", null] }, status: "active" },
      // Account listings. Without this clause an offer-backed row is invisible
      // here, so its advertised quantity would stay at whatever it was
      // published with while the owner's list drained underneath it — and the
      // "pause when dry" half of the feature would simply never happen.
      { accountOffer: { $ne: null }, status: "active" },
      // No-claim Shop listings (contract §8b): claimed at sale out of the
      // no-claim farm, whose stock moves with no order placed here.
      { noclaimStock: true, status: "active" },
    ],
  });
  const changes = [];
  for (const row of rows) {
    let real;
    if (row.noclaimStock) {
      // Asked FIRST: a no-claim row carries `set` too, and the set branch below
      // would count CLAIMED Drop Archive stock for it. noclaimStock already
      // splits the shelf across every claim-at-sale row of the set, and THROWS
      // on a failed read — which is not an empty shelf, so skip the row this
      // pass rather than pause a live offer on a Mongo hiccup.
      let n = null;
      try {
        n = await require("./noclaimStock").stockForListing(row);
      } catch (e) {
        console.error("eldorado no-claim stock count:", e.message);
        continue;
      }
      if (typeof n !== "number" || !Number.isFinite(n)) continue;
      real = n;
    } else if (row.accountOffer) {
      // Ask the ledger exactly what the delivery path will ask it. A read that
      // FAILS must not answer 0: zero is what pauses a live offer, and a Mongo
      // hiccup is not an empty shelf. Skip the row and re-count next pass.
      let n = null;
      try {
        n = await require("./suppliedStock").stockFor(row);
      } catch (e) {
        console.error("eldorado supplied stock count:", e.message);
        continue;
      }
      if (typeof n !== "number" || !Number.isFinite(n)) continue;
      real = n;
    } else if (row.unclaimedGame) {
      // Ask the ledger exactly what the delivery path would ask it.
      real = (
        await claimUnclaimedForGame(row.unclaimedGame, UNCLAIMED_STOCK_MAX, {
          dryRun: true,
          offerId: row.externalId,
          requiredDrops: row.requiredDrops,
        }).catch(() => [])
      ).length;
    } else {
      const set = await DropSet.findById(row.set).lean();
      if (!set) continue;
      real = notListed(
        await availableAccountsForSet(set).catch(() => []),
        listedElsewhere,
      ).length;
    }
    let offer = null;
    try {
      offer = await mp.eldoradoOffer(row.externalId);
    } catch {
      continue;
    }
    if (!offer) continue;

    if (real <= 0 && offer.offerState === "Active") {
      changes.push({ title: row.title, action: "pause (no claimable stock)" });
      if (!dryRun) {
        await mp.eldoradoDelist(row.externalId).catch(() => {});
        row.autoPaused = true;
        row.lastError = "paused: no claimable stock";
        await row.save();
      }
      continue;
    }
    // Only resume what WE paused — never override a deliberate pause.
    if (real > 0 && offer.offerState === "Paused" && row.autoPaused) {
      changes.push({ title: row.title, action: "resume (" + real + " back in stock)" });
      if (!dryRun) {
        await mp.eldoradoRelist(row.externalId).catch(() => {});
        row.autoPaused = false;
        row.lastError = "";
        await row.save();
      }
    }
    if (real > 0 && offer.quantity !== real) {
      changes.push({ title: row.title, action: offer.quantity + " -> " + real });
      if (!dryRun) await mp.eldoradoSetQuantity(row.externalId, real).catch(() => {});
    }
  }
  return changes;
}

// One pass over every paid-but-undelivered Eldorado order.
// A paid order the bot cannot ship is the WORST silent state: money is taken,
// the buyer is waiting, and the log line reads like a routine skip.
//
// PlayerAuctions and G2G both page the operator here. Eldorado did not — a
// `grep -c sendTelegram` over this file returned 0 — so an Eldorado BUNDLE order
// that could not ship produced one console.error per 60-second tick and nothing
// else. It is invisible to the health page too: `orders.undelivered` counts
// FarmServiceOrder rows, and a bundle sale never creates one. Eldorado is the
// marketplace where a rent-farm order was already lost exactly this way
// (4b20765f); the bundle half had the same hole.
//
// One page per order per process, like the PlayerAuctions version: a stuck order
// re-reads every tick and an unthrottled alert would be a message a minute.
// The two account-listing phrases are spelled out rather than matched loosely
// on "account listing".
//
// S3: the account-listing kill switches (contract B8) were originally left OUT
// of this list on the reasoning that a switch the owner flipped on purpose
// should not page every minute — but `alertedOrders` below already makes it
// once per ORDER, so the cost of that reasoning was pure silence. The Eldorado
// offer stays Active at its full quantity while delivery is off, so more buyers
// keep paying, and the refusal reached nothing at all: no Telegram, no console
// line, no SystemEvent, no lastError on the row. A PAID order parked by a
// switch is not a routine skip. Matched on the wording the two reasons share
// (deliverOrder:364 and :372) rather than listed one by one.
//
// "no free no-claim account" is the no-claim Shop listing's shortfall (contract
// §8b) — the same paid-and-stuck state as "free in the no-claim farm", and the
// same page. The no-claim kill switch ("no-claim listing auto-delivery is off")
// is already covered by SWITCHED_OFF_SKIPS.
const SWITCHED_OFF_SKIPS = /auto-delivery is off/i;
const ALERT_REASONS = new RegExp(
  "out of stock|no listing row|no unsold account|ambiguous|cannot be " +
    "identified|no sellable|free in the no-claim farm|AccountOffer is " +
    "missing|rendered empty|no free no-claim account|" +
    SWITCHED_OFF_SKIPS.source,
  "i",
);
const alertedOrders = new Set();

function alertsOperator(reason) {
  return ALERT_REASONS.test(String(reason || ""));
}

// Returns true only on the tick that actually paged, so the tick's new log line
// (S3) rides this same once-per-order gate instead of inventing a second one.
async function alertUnfulfillable(order, why) {
  const id = String((order && (order.id || order.orderId)) || "");
  if (!id || alertedOrders.has(id)) return false;
  alertedOrders.add(id);
  await require("./telegram")
    .sendTelegram(
      "⚠️ Eldorado order " + id + " is PAID and the bot cannot ship it.\n\n" +
        // An Eldorado order carries its title at orderOfferDetails.offerTitle —
        // the same place eldoradoFarmService.parseFarmOrder reads it. Reading a
        // bare `offerTitle` produced an alert with no title on it at all.
        String(
          (order &&
            ((order.orderOfferDetails && order.orderOfferDetails.offerTitle) ||
              order.offerTitle ||
              order.title)) ||
            "(title unknown)",
        ).slice(0, 120) + "\n" +
        "Buyer: " + ((order && (order.buyerName || order.buyer)) || "?") + "\n\n" +
        "Reason: " + String(why || "").slice(0, 300) + "\n\n" +
        // S3: a kill-switch refusal has a different remedy from a missing row.
        // The accounts are on the shelf and one toggle ships them, so the
        // standing postscript would send the owner hunting for stock that is
        // not missing. The guarantee is running either way.
        // A no-claim listing's switch is a different toggle from the account
        // listings' one; naming the wrong one sends the owner to the wrong page.
        (/no-claim/i.test(String(why || "")) && SWITCHED_OFF_SKIPS.test(String(why || ""))
          ? "The no-claim stock is there. Turn no-claim listing delivery back on " +
            "(settings: noclaimShop.autoDeliver) and the next tick ships it — the " +
            "delivery guarantee is running."
          : SWITCHED_OFF_SKIPS.test(String(why || ""))
          ? "The accounts are on the shelf. Turn account-listing delivery back " +
            "on (Settings, or this offer's own toggle) and the next tick ships " +
            "it — the delivery guarantee is running."
          : "This one needs delivering by hand, and the delivery guarantee is running."),
    )
    .catch(() => {});
  return true;
}

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
      // Money is already taken on any of these; a human has to hear about it.
      if ((r.error && alertsOperator(r.error)) || (r.skipped && alertsOperator(r.skipped))) {
        const alerted = await alertUnfulfillable(order, r.error || r.skipped);
        // S3: the chain below prints only errors, dry runs and deliveries, so a
        // paid order parked by one of the account-listing kill switches left
        // NOTHING behind — the only way to learn why the buyer never got their
        // account was to read this file. Log it beside the page, and only on
        // the tick that actually paged: a switch can stay off for days, and one
        // line per order beats one line every 60s tick.
        if (alerted && r.skipped) {
          console.error(
            "eldorado deliver " + r.orderId + " NOT delivered: " + r.skipped,
          );
        }
      }
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
// Stock drifts slowly; re-syncing every delivery tick would be a lot of API
// calls for nothing, so it runs on its own slower clock.
const STOCK_SYNC_MS = 15 * 60 * 1000;
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

  const stockTick = async () => {
    try {
      const af = getAutoFarm() || {};
      if (af.eldoradoAutoDeliver && (mp.keyStatus().eldorado || {}).configured) {
        const changes = await syncBundleStock();
        for (const c of changes) {
          console.log("eldorado stock sync: " + c.action + " — " + c.title);
        }
      }
    } catch (e) {
      console.error("eldorado stock sync error:", e.message);
    }
    const t2 = setTimeout(stockTick, STOCK_SYNC_MS);
    if (t2.unref) t2.unref();
  };
  const t2 = setTimeout(stockTick, 90 * 1000);
  if (t2.unref) t2.unref();
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
  syncBundleStock,
  // Exported for the S3 regression: the predicate is what decides whether a
  // PAID order parked by a kill switch is ever heard about, and a reworded
  // reason falling out of it would be indistinguishable from no problem.
  alertsOperator,
  alertUnfulfillable,
  alertedOrders,
};
