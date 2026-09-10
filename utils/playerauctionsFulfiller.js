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
const { getAutoFarm, getAccountListingSettings } = require("./settings");
const mp = require("./marketplaces");
const UnclaimedAccount = require("../models/UnclaimedAccount");
const coverage = require("./unclaimedCoverage");
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

// Stock drift is slow next to order arrival, and every correction replaces the
// offer, so this runs far less often than the delivery tick.
const STOCK_SYNC_MS = 30 * 60 * 1000;

const PA_SELLABLE_STATUSES = ["released", "skipped"];

// Ceiling on the stock an unclaimed-backed offer may advertise. The count comes
// from a dry-run claim, which resolves a credential per candidate, so it is
// bounded rather than "however many the farm holds".
const UNCLAIMED_STOCK_MAX = 25;

// Most live inventory reads one call to claimUnclaimedForGame may make. Bounds
// the Twitch fan-out of both delivery and the periodic stock sync.
const LIVE_CHECK_MAX = 40;
// Ceiling for a Drop-Archive stock COUNT. Deliberately NOT UNCLAIMED_STOCK_MAX:
// that is a claim batch size, and reusing it here would quietly cut every
// bundle mirror from ~130 advertised units to 25. Matches the publishers' cap.
const ARCHIVE_STOCK_MAX = 200;

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
//
// ONE query for the whole candidate list, not one per account. The per-account
// loop this replaces was fine at delivery time (a handful of accounts) but the
// stock reconciler runs it over every candidate for every listing on a timer —
// ~1000 round trips a tick, which on Atlas is the exact shape that has bitten
// this codebase before. Asking only for rows that ARE claimed also keeps the
// bytes returned tiny, which is the real Atlas bound.
async function unclaimedOnly(set, candidates) {
  const DropLog = require("../models/DropLog");
  const names = ((set && set.items) || []).map((i) => i.name).filter(Boolean);
  if (!names.length) return candidates;
  const logins = [...new Set(candidates.map((c) => c.login).filter(Boolean))];
  if (!logins.length) return candidates;
  const spentRows = await DropLog.find(
    { login: { $in: logins }, name: { $in: names }, claimed: true },
    { login: 1 },
  ).lean();
  const spent = new Set(spentRows.map((r) => r.login));
  return candidates.filter((c) => !spent.has(c.login));
}

// --- Stock source 2: the no-claim farm ----------------------------------
// Only "released" and "skipped" rows are sellable: "listed" means the account is
// already a stock unit on ANOTHER marketplace and selling it here would ship
// that listing's drops too; "sold"/"expired"/"removed" are spent or gone.
function unclaimedGameFilter(game) {
  const base = String(game || "").trim().replace(/\s*2$/, "");
  return new RegExp("^" + base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

// `requiredDrops` is the listing's advertised item list. With it set, an account
// qualifies only when it holds every entry (counts included) and none of them is
// already claimed. Picking by game alone is what filled a 10-item Overwatch CAH
// order with a 7-item account on Eldorado (order 99d443eb, 2026-09-07); the two
// PlayerAuctions rows backed by that same ledger advertise the same bundles.
async function claimUnclaimedForGame(
  game,
  want,
  { orderId, offerId, dryRun, requiredDrops, shortfall },
) {
  const {
    credentialForLedger,
    manualSoldOwnerKeys,
    filterManualSoldLedgers,
    activeListingsForLogin,
  } = require("./unclaimedAutoList");

  const n = Math.max(1, parseInt(want, 10) || 1);
  const required = coverage.requiredCounts(requiredDrops);
  // A coverage gate rejects most candidates on their drops alone, so read a
  // deeper slice — otherwise rare stock reads as no stock.
  const scan = required.size ? Math.max(n * 6, 200) : n * 6;
  const candidates = await UnclaimedAccount.find({
    source: "noclaim",
    game: unclaimedGameFilter(game),
    status: { $in: PA_SELLABLE_STATUSES },
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

  const out = [];
  for (const row of usable) {
    if (out.length >= n) break;
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

// --- Stock source 3: an owner-supplied account list ----------------------
// docs/ACCOUNT-LISTINGS-CONTRACT.md B5. The stock behind an account listing is
// a list of accounts the owner pasted in (models/SuppliedAccount): no DropSet,
// no DropLog rows, no reservation — so neither claimer above can see it, and
// every read and write goes through utils/suppliedStock.
//
// The predicate is a bare field test on purpose, and utils/suppliedStock is
// required lazily inside the branches (the way ./unclaimedAutoList is): a row
// with no accountOffer must never load the account-listing layer at all, so a
// fault in code that is brand new cannot stop an ordinary delivery.
function isSuppliedRow(row) {
  return !!(row && row.accountOffer);
}

// Injectable — the trailing-callable idiom stockFor already uses for its
// claimer — so the supplied branches can be tested without Mongo.
function suppliedDeps() {
  return {
    stock: require("./suppliedStock"),
    AccountOffer: require("../models/AccountOffer"),
  };
}

// Why this hand-over must NOT happen, or "" when it may. Three switches, all of
// which must be on (contract B8): the feature, the global kill switch, and the
// offer's own toggle. The owner can stop every account-listing delivery with
// one settings edit without touching any other market, so the reason has to say
// which switch did it — a bare "skipped" reads like a bug at 3am.
function suppliedDeliveryBlockedBy(offer) {
  const s = getAccountListingSettings();
  if (!s.enabled) return "account listings are disabled in settings";
  if (!s.autoDeliver) return "account-listing auto-delivery is off in settings";
  if (offer && offer.autoDeliver === false) {
    return "auto-delivery is off on this account listing";
  }
  return "";
}

// The buyer-facing messages for a supplied hand-over.
//
// The offer's own deliveryTemplate is used only when EVERY rendered message
// fits PlayerAuctions' hard 300-character cap. PlayerAuctions is the one market
// with a budget that tight (utils/playerauctionsCopy), and a template that
// cannot be sent would strand a paid buyer, so anything that does not fit falls
// back to the house copy, which chunks credentials by construction.
function suppliedMessages(stock, accounts, offer) {
  try {
    const parts = accounts.map((a) => stock.deliveryText(a, offer));
    if (parts.length && parts.every((t) => t && t.length <= copy.LIMIT)) {
      return parts;
    }
  } catch (e) {
    console.error("playerauctions supplied delivery text:", e.message);
  }
  return copy.deliveryMessages(accounts, { kind: "bundle" });
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
  alreadyMessaged = false, onMessaged, messages: preset,
}) {
  // `preset` is the account-listing path handing in the offer's own rendered
  // template. Absent — which is every existing caller — the house copy is built
  // exactly as before.
  const messages =
    preset && preset.length
      ? preset
      : copy.deliveryMessages(accounts, { kind, days, game });
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
// What an offer may honestly advertise right now.
//
// For a pre-reserved offer that is the units nobody has been given yet. For an
// unclaimed-backed offer it is NOT: those rows resolve their stock out of the
// no-claim ledger at delivery time and every unit on the row is a record of a
// hand-over that already happened, so `undeliveredUnits` is 0 the instant the
// first order lands — which advertised nothing while the farm still held a
// shelf full of sellable accounts. Ask the ledger the same question the
// delivery path asks it.
// `claim` is injectable so the rule can be tested without Mongo, the same way
// paRefreshOnce takes its refresher.
// How many ACTIVE listings draw on the same no-claim game pool. Two offers
// backed by "Overwatch" both see the same 11 sellable accounts, so reporting 11
// on each advertises 22 — and the second buyer to arrive cannot be served.
// Splitting the pool is the honest number.
async function sharersOfUnclaimedGame(listing) {
  if (!listing.unclaimedGame) return 1;
  try {
    const n = await MarketplaceListing.countDocuments({
      marketplace: "playerauctions",
      status: "active",
      unclaimedGame: listing.unclaimedGame,
    });
    return Math.max(1, n);
  } catch {
    // Never let a bookkeeping lookup change what stockFor reports. Falling back
    // to "one listing" reproduces the behaviour from before the split existed,
    // which is the conservative direction: it cannot hide stock we do have.
    return 1;
  }
}

// The account-listing split used to live here too, as sharersOfAccountOffer:
// it counted the ACTIVE PlayerAuctions rows on the offer and divided. S4 moved
// that job into utils/suppliedStock.stockFor, which counts the active rows on
// EVERY market — the shelf does not care which marketplace empties it, and a
// per-market count was the hole itself (one 50-account offer published to four
// markets advertised 200). Dividing here as well would divide the shelf twice
// and take a healthy offer off sale. Deleted rather than left unused: an
// unwired copy of a stock rule is the next thing to drift back in.
async function stockFor(listing, claim, supplied = suppliedDeps) {
  // An account listing's stock is the offer's ledger. NOT its units: on a
  // supplied row every unit records a hand-over that already happened, so
  // counting them would report 0 the instant the first order lands and
  // syncUnclaimedStock would hide an offer with a full shelf behind it — the
  // same trap the unclaimed branch below exists to avoid.
  if (isSuppliedRow(listing)) {
    // Already this listing's SHARE of the shelf (S4), not the whole shelf.
    return supplied().stock.stockFor(listing);
  }
  // Drop-Archive-backed bundles hold NO units — they claim at delivery time —
  // so counting units would report 0 and the reconciler would hide a listing
  // that is actually in stock. Count what a delivery would really find: the
  // accounts still holding the whole set, not on another live listing, and
  // still UNCLAIMED (a claimed drop is worthless to the buyer).
  if (listing.autoClaimSet && listing.set) {
    const DropSet = require("../models/DropSet");
    const set = await DropSet.findById(listing.set).lean();
    if (!set) return 0;
    const cands = notListed(
      await availableAccountsForSet(set).catch(() => []),
      await loginsOnActiveListings(),
    ).slice(0, ARCHIVE_STOCK_MAX);
    return (await unclaimedOnly(set, cands)).length;
  }
  if (!listing.unclaimedGame) return undeliveredUnits(listing).length;
  const free = await (claim || claimUnclaimedForGame)(
    listing.unclaimedGame,
    UNCLAIMED_STOCK_MAX,
    {
      dryRun: true,
      offerId: listing.externalId,
      requiredDrops: listing.requiredDrops,
    },
  );
  const share = await sharersOfUnclaimedGame(listing);
  return share > 1 ? Math.floor(free.length / share) : free.length;
}

// `supplied` is threaded through to stockFor only so an account-listing test
// can drive a whole delivery — including this post-delivery resync — without a
// live Mongo. Every existing caller passes nothing and gets the real layer.
async function syncStock(listing, supplied = suppliedDeps) {
  const af = getAutoFarm() || {};
  if (af.playerauctionsSyncStock === false) return null;
  const left = await stockFor(listing, undefined, supplied);
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

// Keep every unclaimed-backed offer's advertised stock equal to what the
// no-claim farm can actually hand over, and take it off sale the moment that
// reaches zero.
//
// Delivery-time sync alone is not enough: the stock behind these offers moves
// on its own — accounts get sold on Gameflip, attached to another listing,
// hand-sold, or lose their drops — so between orders the number drifts with
// nothing watching. An offer that keeps selling past that point takes money for
// something the fulfiller then cannot hand over.
//
// An update REPLACES the offer and issues a new offerId, so this only writes
// when the live number actually differs from what we can deliver.
async function syncUnclaimedStock({ dryRun = false } = {}) {
  const af = getAutoFarm() || {};
  if (af.playerauctionsSyncStock === false) return [];
  // Both stock sources drift without an order being placed here: the no-claim
  // ledger moves on its own, and the Drop Archive drains as accounts sell on
  // OTHER marketplaces. A bundle mirror's quantity is frozen at publish time
  // otherwise, so it keeps advertising stock that has already gone.
  const rows = await MarketplaceListing.find({
    marketplace: "playerauctions",
    status: "active",
    $or: [
      { unclaimedGame: { $nin: ["", null] } },
      { autoClaimSet: true },
      // Account listings drift too: the owner removes rows by hand, and an
      // offer also published on another market has its ledger drained from
      // there. `$ne: null` rather than the `$nin: ["", null]` above because
      // accountOffer is an ObjectId — casting "" throws a CastError that would
      // take the whole sweep down.
      { accountOffer: { $ne: null } },
    ],
  });
  const changes = [];
  for (const row of rows) {
    let real;
    try {
      real = await stockFor(row);
    } catch (e) {
      console.error("playerauctions stock sync (" + row.externalId + "):", e.message);
      continue;
    }
    let offer = null;
    try {
      offer = await mp.playerauctionsOffer(row.externalId);
    } catch {
      continue;
    }
    if (!offer) continue;
    const advertised = Number(offer.totalUnit);

    if (real <= 0) {
      // Nothing to sell. Hide rather than set quantity 0 — a zero-stock offer
      // is still an offer, and hiding is the reversible half of the pair.
      if (!row.autoPaused) {
        changes.push({ offerId: row.externalId, title: row.title, action: "hide (no sellable stock)" });
        if (!dryRun) {
          await mp.playerauctionsHide(row.externalId).catch((e) =>
            console.error("playerauctions hide:", e.message),
          );
          row.autoPaused = true;
          row.lastError = row.unclaimedGame
            ? "hidden: no sellable " + row.unclaimedGame + " stock in the no-claim farm"
            : isSuppliedRow(row)
              ? "hidden: this account listing has no accounts left — add more"
              : "hidden: no account still holds this set unclaimed in the Drop Archive";
          await row.save();
        }
      }
      continue;
    }
    // Only bring back what WE hid — never override a deliberate pause.
    if (row.autoPaused) {
      changes.push({ offerId: row.externalId, title: row.title, action: "display (" + real + " back in stock)" });
      if (!dryRun) {
        await mp.playerauctionsDisplay(row.externalId).catch((e) =>
          console.error("playerauctions display:", e.message),
        );
        row.autoPaused = false;
        row.lastError = "";
        await row.save();
      }
    }
    if (Number.isFinite(advertised) && advertised !== real) {
      changes.push({ offerId: row.externalId, title: row.title, action: advertised + " -> " + real });
      if (!dryRun) await syncStock(row);
    }
  }
  return changes;
}

// Deliver one paid order. Returns a short result the tick can log directly.
async function deliverOrder(order, { dryRun, supplied = suppliedDeps }) {
  const orderId = String(order.orderId || order.id || "");
  const offerTitle = String(order.orderTitle || "");
  // `qty` is deliberately NOT computed here. Deriving units honestly needs the
  // price of ONE unit, which lives on the listing row resolved below — and the
  // only other source, the order's own "11 Ship Skins", is an item count that
  // once shipped eleven accounts for a five dollar sale.

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
  let row =
    offerId &&
    (await MarketplaceListing.findOne({
      marketplace: "playerauctions",
      externalId: offerId,
    }));

  // The title fallback is genuinely ambiguous. A bundle title is built from the
  // game, the item count and the first couple of item names, then truncated --
  // so two DIFFERENT events routinely render the SAME title. Six pairs are live
  // on the account right now (distinct DropSets, identical titles), and picking
  // whichever row the database returned first would hand the buyer an account
  // that does not hold what they paid for. A wrong delivery is worse than a
  // late one: it is a dispute AND the stock is spent. So match on the title
  // only when it is unambiguous, and otherwise refuse loudly.
  if (!row) {
    // Compare the FOLDED titles. The stored title is our own copy, em dashes
    // and all; the order's title comes back from PlayerAuctions, which only
    // ever accepted the ASCII-folded version -- so an exact string match can
    // never fire for a folded listing, i.e. this rescue path would be dead
    // code at the exact moment it is needed. Folding both sides also lines up
    // the 150-character truncation the API applies.
    const fold = (t) => mp.paSanitizeTitle(String(t || "")).toLowerCase().trim();
    const want = fold(offerTitle);
    const hits = want
      ? (
          await MarketplaceListing.find({
            marketplace: "playerauctions",
            status: { $ne: "delisted" },
          })
        ).filter((r) => fold(r.title) === want)
      : [];
    if (hits.length > 1) {
      return {
        orderId,
        skipped:
          "ambiguous listing title -- " +
          hits.length +
          " listings share " +
          JSON.stringify(offerTitle) +
          " and the order carried no offer id, so the right stock cannot be identified",
      };
    }
    row = hits[0];
  }
  if (!row) return { orderId, skipped: "no listing row for " + JSON.stringify(offerTitle) };

  // Now that the listing is known, its unit price can turn what the buyer paid
  // into a unit count. Anything that does not divide cleanly is one unit.
  const units = paUnits(order, row.price);
  const qty = units.qty;

  // Already fully delivered.
  const mine = unitsForOrder(row, orderId);
  if (mine.length && mine.every((u) => u.deliveredAt)) {
    return { orderId, skipped: "already delivered" };
  }

  // A unit count we could not PROVE, on an order we are about to fill for the
  // first time.
  //
  // Falling back to one account is the safe half and stays. The unsafe half was
  // the silence: the hand-over then calls playerauctionsMarkDelivered for the
  // WHOLE order, so a buyer who paid $12.50 against a $5 unit received one
  // account and an order stamped complete, with nothing anywhere recording that
  // we had guessed. Deliver the one, mark it, and page a human who can top the
  // order up while the buyer is still waiting rather than disputing.
  //
  // Gated on `!mine.length` so it fires once, when the order is first handled,
  // not on every 60-second retry of a half-finished hand-over.
  if (units.suspect && !mine.length && !dryRun) {
    await require("./farmServiceAlert")
      .alertFarmFailure({
        market: "playerauctions",
        orderId,
        offerTitle,
        game: row.unclaimedGame || "",
        days: 0,
        qty: 1,
        buyerUsername: (order && order.name) || "",
        reason: "CHECK THE UNIT COUNT BY HAND — " + units.why,
      })
      .catch(() => {});
  }

  // --- Account listings: the owner's own pasted stock ----------------------
  // Deliberately ABOVE the shared RESUME block, not down beside the
  // manual-delivery skip. credentialsForUnits resolves a unit's contentId
  // against UnclaimedAccount, and on a supplied row contentId is a
  // SuppliedAccount id — so the generic resume would throw "has no readable
  // credential" on every retry of a half-finished hand-over, which is the one
  // moment this file's reserve-then-resume design exists for. Resuming is
  // suppliedStock's own job: rows already stamped with this orderId come back
  // before any new row is claimed, so a failed send never burns a second
  // account.
  if (isSuppliedRow(row)) {
    const deps = supplied();
    const offer = await deps.AccountOffer.findById(row.accountOffer);
    if (!offer) return { orderId, error: "listing's AccountOffer is missing" };
    const blocked = suppliedDeliveryBlockedBy(offer);
    if (blocked) return { orderId, skipped: blocked };

    const picked = await deps.stock.claimForListing(row, qty, {
      orderId,
      market: "playerauctions",
      dryRun,
    });
    if (picked.length < qty) {
      // A short claim is not a success. Put back only what this call took: the
      // buyer waiting is recoverable, a half-filled order is a dispute AND the
      // stock is spent. This is the ONLY release path — once the hand-over has
      // started, a failure must resume onto the same rows, never release them,
      // or one order ships two different accounts.
      if (!dryRun && picked.length) {
        await deps.stock
          .releaseClaim(picked.map((p) => p.ledgerId), { orderId })
          .catch(() => {});
      }
      return {
        orderId,
        error:
          "only " + picked.length + " of " + qty + " account(s) left in " +
          JSON.stringify(String(offer.title || "")) +
          " — add more accounts to the listing",
      };
    }

    const msgs = suppliedMessages(deps.stock, picked, offer);
    if (dryRun) {
      return {
        orderId,
        dryRun: true,
        source: "supplied:" + String(offer.title || ""),
        wouldSend:
          qty + " account(s) [" + picked.map((p) => p.login).join(", ") +
          "] in " + msgs.length + " message(s)",
        preview: msgs.join("\n---\n"),
      };
    }

    // Rows the resume handed back are already on the listing; re-adding them
    // would double the units, and every count read off units[] with them.
    const seen = new Set(mine.map((u) => String(u.contentId || "")));
    const fresh = picked.filter((p) => !seen.has(String(p.ledgerId)));
    if (fresh.length) await reserveOnListing(row, orderId, fresh);

    const sent = await handOver({
      orderId,
      accounts: picked,
      kind: "bundle",
      offerTitle,
      itemCount: paItemCount(row),
      messages: msgs,
      // Skip the send only when nothing new was claimed AND every unit already
      // went out — otherwise a freshly claimed account would never reach the
      // buyer while the order was marked delivered.
      alreadyMessaged:
        !fresh.length && mine.length > 0 && mine.every((u) => u.messagedAt),
      onMessaged: () => markUnitsMessaged(row, orderId),
    });
    await markUnitsDelivered(row, orderId);
    await deps.stock.markDelivered(picked.map((p) => p.ledgerId), {
      orderId,
      market: "playerauctions",
    });
    await syncStock(row, supplied);
    return {
      orderId,
      delivered: picked.length,
      messages: sent,
      source: "supplied:" + String(offer.title || ""),
      resumed: mine.length > 0,
    };
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
    const shortfall = {};
    const picked = await claimUnclaimedForGame(row.unclaimedGame, qty, {
      orderId,
      offerId: row.externalId,
      dryRun,
      requiredDrops: row.requiredDrops,
      shortfall,
    });
    if (picked.length < qty) {
      // Hold the order rather than ship short: a waiting buyer is recoverable,
      // an account missing advertised items is a dispute.
      return {
        orderId,
        error:
          "only " + picked.length + " of " + qty + " sellable " +
          row.unclaimedGame + " account(s) free in the no-claim farm" +
          ((row.requiredDrops || []).length
            ? " holding all " + (row.requiredDrops || []).length +
              " advertised item(s)" +
              (shortfall.detail ? " — short of: " + shortfall.detail : "")
            : ""),
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
function paUnits(order, listingPriceUsd) {
  const n = parseInt(order && order.purchaseQuantity, 10);
  if (Number.isFinite(n) && n > 0) return { qty: n, why: "the order stated purchaseQuantity=" + n };

  // `orderInfo.purchased.amount` is the SAME ITEM COUNT the comment above warns
  // about, in structured form — and reading it as a unit count is exactly the
  // mistake that comment exists to prevent. Order 16474028 was "Sea of Thieves
  // Twitch Drops (11 Items)" at $5.00 total, and PlayerAuctions reported
  // `purchased: {amount: 11, suffix: "Ship Skins"}`. Eleven SHIP SKINS — one
  // account holding eleven drops. It shipped ELEVEN ACCOUNTS for $5, giving away
  // ten of them. The suffix is the giveaway: it names the offer's unit, and that
  // unit is never "accounts".
  //
  // The only honest way to a unit count is money: what the buyer paid against
  // what one unit costs. Anything that does not divide cleanly is not evidence
  // of a bulk purchase, so it falls back to one.
  const paid = money(
    order && order.detail && order.detail.orderInfo && order.detail.orderInfo.price,
  );
  const unit = money(listingPriceUsd);
  if (paid > 0 && unit > 0) {
    const units = paid / unit;
    const rounded = Math.round(units);
    const evidence = "$" + paid.toFixed(2) + " paid / $" + unit.toFixed(2) + " a unit";
    // Within a cent per unit of a whole multiple, and at least two of them.
    if (rounded >= 2 && Math.abs(units - rounded) * unit < 0.01) {
      return { qty: rounded, why: evidence + " = " + rounded + " units" };
    }
    // Falling back to one is the SAFE half — but it used to be the silent half
    // too, and the order was then marked delivered in full. A buyer who paid
    // $12.50 against a $5 unit got one account and an order stamped complete,
    // with nothing anywhere saying so. `suspect` is how the operator finds out
    // while there is still time to top the order up by hand.
    if (units >= 1.5) {
      return {
        qty: 1,
        suspect: true,
        why:
          evidence + " = " + units.toFixed(3) +
          " units, which does not divide cleanly — delivering ONE account",
      };
    }
  }
  return { qty: 1, why: "single unit" };
}

// The number on its own, for callers that only need the count.
function paQuantity(order, listingPriceUsd) {
  return paUnits(order, listingPriceUsd).qty;
}

// PlayerAuctions reports prices as strings ("5.00"). Anything unparseable is 0,
// which makes the caller fall back to a single unit rather than guess.
function money(v) {
  const n = Number(String(v == null ? "" : v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : 0;
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
      // A paid order the bot cannot ship is the WORST silent state: the buyer
      // is waiting, the delivery guarantee is running down, and the log line
      // reads like a routine skip. The four hand-made offers on this account
      // have no listing row at all, so this is exactly what a sale on one of
      // them looks like. Tell the operator once, while there is still time.
      if (r.skipped && alertsOperator(r.skipped)) {
        // F7: the reason was computed and then thrown away. The chain below
        // prints only errors, dry runs and deliveries, so a paid order parked
        // by one of the account-listing kill switches left NOTHING behind --
        // no log line, no alert -- and the only way to learn why the buyer
        // never got their account was to read this file. Log it beside the
        // alert, and only on the tick that actually alerts: a switch can stay
        // off for days, and one line per order beats one line every 60s tick.
        const alerted = await alertUnfulfillable(order, r.skipped);
        if (alerted) {
          console.error(
            "playerauctions deliver " + id + " NOT delivered: " + r.skipped,
          );
        }
      }
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

// One alert per order, not one per 60s tick. Resets on restart, which at worst
// costs a single duplicate for an order that is still stuck.
const alertedOrders = new Set();

// Which "skipped" reasons mean a PAID order will never ship without a human?
// Those are the ones worth waking the operator for; the routine skips (already
// delivered, nothing in stock yet) are not. Kept as a named predicate so the
// list is one thing to read and one thing to test -- an alert that silently
// stopped matching would be indistinguishable from no problem at all.
//
// F7 added the account-listing kill switches (suppliedDeliveryBlockedBy,
// contract B8). A switch the owner flipped is not a routine skip: the order is
// PAID and it will sit there until a human flips it back or ships by hand, and
// that refusal was the one nobody could see. Matched on the wording the three
// reasons share rather than listed one by one, and tests/suppliedFulfilment
// asserts every real return of suppliedDeliveryBlockedBy against this
// predicate, so a reworded reason cannot fall out of the alert quietly.
const SWITCHED_OFF_SKIPS = /disabled in settings|auto-delivery is off/;
const ALERT_SKIPS = new RegExp(
  "no listing row|manual-delivery listing|ambiguous listing title|" +
    SWITCHED_OFF_SKIPS.source,
);

function alertsOperator(skipReason) {
  return ALERT_SKIPS.test(String(skipReason || ""));
}

// Returns true only on the tick that actually alerted, so the tick's log line
// (F7) rides the same once-per-order gate instead of inventing a second one.
async function alertUnfulfillable(order, why) {
  const id = String(order.orderId || order.id || "");
  if (!id || alertedOrders.has(id)) return false;
  alertedOrders.add(id);
  const notify = (t) => require("./telegram").sendTelegram(t);
  await notify(
    "⚠️ PlayerAuctions order " + id + " is PAID and the bot cannot ship it.\n\n" +
      String(order.orderTitle || "").slice(0, 120) + "\n" +
      "Buyer: " + (order.name || "?") + "   " + (order.price || "") + "\n\n" +
      "Reason: " + why + "\n\n" +
      // A kill-switch refusal (F7) has a different remedy from a missing row:
      // the accounts are on the shelf and one toggle ships them, so the
      // standing postscript would send the owner hunting for stock that is not
      // missing. The guarantee is running either way.
      (SWITCHED_OFF_SKIPS.test(String(why || ""))
        ? "The accounts are on the shelf. Turn account-listing delivery back " +
          "on (Settings, or this listing's own toggle) and the next tick ships " +
          "it — the delivery guarantee is running."
        : "This one needs delivering by hand, and the delivery guarantee is " +
          "running. Offers made directly on PlayerAuctions have no listing row " +
          "here, so the bot does not know what stock backs them."),
  ).catch(() => {});
  return true;
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

  // The unclaimed-backed offers advertise stock that lives in the no-claim
  // ledger, which moves without any order being placed here.
  const stockTick = async () => {
    try {
      const af = getAutoFarm() || {};
      if (af.playerauctionsAutoDeliver && (mp.keyStatus().playerauctions || {}).configured) {
        for (const c of await syncUnclaimedStock()) {
          console.log("playerauctions stock sync: " + c.action + " — " + c.title);
        }
      }
    } catch (e) {
      console.error("playerauctions stock sync error:", e.message);
    }
    const t2 = setTimeout(stockTick, STOCK_SYNC_MS);
    if (t2.unref) t2.unref();
  };
  const t2 = setTimeout(stockTick, 100 * 1000);
  if (t2.unref) t2.unref();
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
  sharersOfUnclaimedGame,
  // Account listings (docs/ACCOUNT-LISTINGS-CONTRACT.md B5).
  isSuppliedRow,
  suppliedDeps,
  suppliedDeliveryBlockedBy,
  suppliedMessages,
  alertUnfulfillable,
  alertsOperator,
  alertedOrders,
  unitsForOrder,
  credentialsForUnits,
  reserveOnListing,
  markUnitsMessaged,
  markUnitsDelivered,
  stockFor,
  syncStock,
  syncUnclaimedStock,
  handOver,
  // Exported so the unit-count derivation is tested against the REAL function
  // rather than a regex-extracted copy of its source — the G2G credential bug
  // slipped past source-shape tests in exactly that way.
  paUnits,
  paQuantity,
  deliverOrder,
  deliverPendingOrders,
};
