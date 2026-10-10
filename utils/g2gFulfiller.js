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
const { getAutoFarm, getAccountListingSettings } = require("./settings");
const mp = require("./marketplaces");
const chat = require("./g2gChat");
const eld = require("./eldoradoFulfiller");
const farmService = require("./g2gFarmService");
const { packSizeOf, accountsForUnits, packsFor, packMismatch } = require("./bulkPacks/packMath");

// Distinct from every other platform's tag so one account can never be handed
// out twice across marketplaces. Must be listed in utils/marketClaimTags.js.
const G2G_CLAIM_TAG = "g2g";

// Bulk packs v2 (docs/bulk-packs/PACKS-2.md §1-§2). A bulk pack row is ONE
// item priced as a whole pack: G2G counts PACKS (purchased_qty, delivered_qty,
// the offer's quantity) and we hand over and reserve ACCOUNTS — a pack of 5
// delivered is delivered_qty 1. The conversion goes through
// utils/bulkPacks/packMath and nowhere else. Every other row is not a pack, and
// both helpers hand its own count back untouched, so an ordinary listing takes
// exactly the path it took before packs existed.
//
// Accounts one order of `qty` units takes off this row.
function accountsForOrder(listing, qty) {
  return packSizeOf(listing) > 1 ? accountsForUnits(listing, qty) : qty;
}

// The count G2G is told for `accounts` accounts: whole packs on a bulk pack
// row, the count itself on every other row. Also what a bulk row may
// advertise — a partial pack can never sell.
function unitsFor(listing, accounts) {
  const n = packSizeOf(listing);
  return n > 1 ? packsFor(accounts, n) : accounts;
}

const DELIVER_TICK_MS = 60 * 1000;
const STOCK_TICK_MS = 15 * 60 * 1000;
const CONFIRM_SWEEP_MS = 5 * 60 * 1000;
// Delivery proofs (see sweepDeliveryProofs).
const PROOF_SWEEP_MS = 10 * 60 * 1000;
const PROOF_RETRY_BASE_MS = 30 * 60 * 1000;
const PROOF_RETRY_MAX_MS = 6 * 60 * 60 * 1000;
const PROOF_PAGE_AFTER = 3;
const G2G_SELLER_NAME = "Avishka_ReX";

// The refusal for a no-claim row whose delivery switch is off
// (docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md §0). One spelling for both places
// that refuse — the first claim and a retry's re-read.
const NOCLAIM_DELIVERY_OFF = "no-claim listing auto-delivery is off";

// Orders we have already shouted about, so a stuck order does not re-ping the
// operator every minute. Process-local on purpose: a restart re-alerting once
// is the right behaviour.
const alerted = new Set();

// Orders whose refusal we have already PRINTED (finding S3). A second set on
// purpose: a dry run must still leave a line in the log, and it must never
// claim the paging slot above — an order refused during a rehearsal has to page
// for real the moment dry run goes off.
const shouted = new Set();

// Orders we have already asked the owner to confirm on G2G after a verified
// chat send (see alertSentAwaitingConfirm).
const confirmAsked = new Set();

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
function g2gDeliveryCode(login, password, opts = {}) {
  return eld.eldoradoDeliveryCode(login, password, opts);
}

// The AccountOffer behind an account listing (contract B5), or null for every
// other stock source — so calling it on an archive-backed row costs a property
// read and nothing else.
//
// It is loaded ONLY to render the hand-over. The per-offer auto-deliver switch
// stays where pickStock's comment says it is — inside claimForListing, the one
// claim layer — so this cannot double-report the same refusal (finding F2b).
async function offerForListing(listing) {
  if (!listing || !listing.accountOffer) return null;
  return require("./suppliedStock").offerFor(listing);
}

// One account's hand-over text.
//
// An account listing sells on the OWNER's words: AccountOffer.deliveryTemplate
// is the description the buyer paid against, and it is the only thing that can
// name the account's token, e-mail or extra column. G2G was the one fulfiller
// that never asked for it — every block was built from login + password alone,
// so a buyer who paid for an offer promising {token}/{email} got the Twitch-
// drops boilerplate instead, while the order was still confirmed delivered and
// the ledger row stamped sold: an unrecoverable shortfall (finding F2a).
// Eldorado (:397), PlayerAuctions (:325) and Gameflip (:419) all
// render through suppliedStock.deliveryText; this now does the same, and every
// other stock source keeps g2gDeliveryCode byte for byte.
//
// `c` is always the plain object unit() builds, never a Mongoose sub-document —
// which is the whole reason unit() exists; see the note above it.
// `unclaimed` (a no-claim row) picks the guide for drops that are still
// unclaimed — connect first, then claim (eldoradoUnclaimedGuide).
function deliveryBlock(c, offer, opts = {}) {
  if (!offer) return g2gDeliveryCode(c.login, c.password, opts);
  return require("./suppliedStock").deliveryText(c, offer);
}

// Put stock back. Archive and no-claim stock is released by BotAccount id
// through Eldorado's claim-tag store; an account listing's stock is a
// SuppliedAccount ledger row instead (docs/ACCOUNT-LISTINGS-CONTRACT.md B5),
// which that store has never heard of — releasing one by the wrong id fails
// silently and strands the row on a dead order forever. `opts` is absent at
// every pre-existing call site, so those keep the behaviour they had.
async function releaseAccounts(ids, opts = {}) {
  const listing = opts.listing || null;
  if (listing && listing.accountOffer) {
    return require("./suppliedStock").releaseClaim(ids, {
      orderId: opts.orderId || "",
    });
  }
  return eld.releaseAccounts(ids, G2G_CLAIM_TAG);
}

// Stamp the ledger rows behind an offer-backed order as delivered. Best-effort
// on purpose: by the time this runs the buyer already holds the credential, and
// a ledger write that throws must never turn a completed hand-over into an
// error the next tick retries. A no-op on every other kind of row.
async function markSuppliedDelivered(listing, orderId) {
  if (!listing || !listing.accountOffer) return;
  try {
    const ids = unitsForOrder(listing, orderId)
      .map((u) => u.contentId)
      .filter(Boolean);
    if (!ids.length) return;
    await require("./suppliedStock").markDelivered(ids, {
      orderId,
      market: G2G_CLAIM_TAG,
    });
  } catch {
    // The hand-over stands; the ledger row is already claimed to this order, so
    // nothing can re-sell it in the meantime.
  }
}

// Record a no-claim row's sale once its credential has reached the buyer
// (docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md §8c). The claim already committed
// these ledgers to "sold" for this order; this adds what the buyer paid. The
// reason repeats the claim's own note on purpose: that note is the key a resume
// of this order finds the ledgers by.
//
// Best-effort for the same reason as markSuppliedDelivered, and called once per
// hand-over — never from the confirm, which G2G still refuses. A no-op on every
// other kind of row.
async function markNoclaimSold(listing, order, units) {
  if (!listing || !listing.noclaimStock) return;
  try {
    const ids = (units || []).map((u) => u.contentId).filter(Boolean);
    if (!ids.length) return;
    const orderId = String(order.orderItemId || "");
    const qty = Math.max(1, order.purchasedQty || 1);
    // The order's own total when G2G states it in dollars, else the row's price.
    const usd = String(order.currency || "USD").toUpperCase() === "USD";
    // Each ledger row is ONE account. On a bulk pack row one unit is a pack of
    // N accounts (docs/bulk-packs/PACKS-2.md): the total is spread over every
    // account, and the row's price — one PACK's price — over the pack's N, so
    // a pack sale never books N times its money. Ordinary rows: as before.
    const n = packSizeOf(listing);
    const priceUsd =
      usd && Number(order.amount) > 0
        ? Math.round((Number(order.amount) / accountsForOrder(listing, qty)) * 100) / 100
        : n > 1
          ? Math.round(((Number(listing.price) || 0) / n) * 100) / 100
          : Number(listing.price) || 0;
    await require("./noclaimStock").markSold(ids, {
      market: G2G_CLAIM_TAG,
      priceUsd,
      orderId,
      reason: G2G_CLAIM_TAG + " order " + orderId,
    });
  } catch {
    // The hand-over stands, and the claim already holds these ledgers as sold
    // to this order, so nothing can re-sell them in the meantime.
  }
}

// Tell G2G how many units shipped, once the credential is verifiably in the
// buyer's chat (every caller runs this only after messagedAt is stamped).
//
// delivered_qty still answers HTTP 500 to this client, and the owner confirms
// those orders by hand on the G2G order page. So a refused count is NOT a
// failed delivery and must never read as one: thrown as an error, it paged "the
// bot cannot ship it — needs delivering by hand" about a buyer who already had
// the account, which invites a second account going out.
//
// `n` is the ACCOUNTS this order was handed. What G2G is told — and what the
// result reports — is in G2G's own units: the same number on an ordinary row,
// whole packs on a bulk pack row (docs/bulk-packs/PACKS-2.md §2), so every
// caller, the first send and the resume paths alike, reports packs and never
// accounts.
async function confirmOnG2g(listing, orderId, accounts, source) {
  const n = unitsFor(listing, accounts);
  try {
    await mp.g2gSetDeliveredQty(orderId, n);
  } catch (e) {
    return {
      orderId,
      sent: n,
      awaitingConfirm: true,
      source,
      detail:
        "the account IS in the buyer's chat, but G2G refused the delivered " +
        "count (" + e.message + ")",
    };
  }
  const now = new Date();
  for (const u of unitsForOrder(listing, orderId)) {
    if (!u.deliveredAt) u.deliveredAt = now;
  }
  listing.markModified("units");
  await listing.save();
  await markSuppliedDelivered(listing, orderId);
  return { orderId, delivered: n, source };
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
  // A bulk pack row hands over whole packs: `qty` packs are qty × N accounts
  // (docs/bulk-packs/PACKS-2.md §2). Every other row: `qty` itself. A pack
  // order whose quantity cannot be read is refused — it can never come out as
  // "no accounts at all" and ship an empty hand-over.
  const want = accountsForOrder(listing, qty);
  if (packSizeOf(listing) > 1 && !(want >= 1)) {
    return {
      error:
        "bulk pack: could not read how many packs this order bought (" +
        String(order.purchasedQty) + ")",
    };
  }

  // No-claim Shop listings (docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md §8c) come
  // FIRST. Such a row keeps its `set`, so further down it would fall into the
  // DropSet branch and ship an account out of the Drop Archive — which holds
  // only CLAIMED drops, worthless to a no-claim buyer. The claim goes through
  // the one no-claim claim layer and commits straight to "sold" for this order,
  // keyed on the order id, so a retry resumes the same ledgers instead of
  // burning new accounts. It hands back the credentials themselves, and those
  // are exactly what ships: deliverOrder never sends a no-claim pick through
  // credentialsFor.
  if (listing.noclaimStock) {
    const ncs = require("./noclaimStock");
    // Say WHY, as the account-listing branch does: an empty claim would
    // otherwise read as an empty shelf.
    if (!ncs.deliveryEnabled()) return { error: NOCLAIM_DELIVERY_OFF };
    const DropSet = require("../models/DropSet");
    const set = listing.set ? await DropSet.findById(listing.set).lean() : null;
    if (!set) return { error: "listing's DropSet is missing" };
    const picked = await ncs.claimForSet(set, want, {
      market: G2G_CLAIM_TAG,
      listingId: String(listing._id),
      orderId: String(order.orderItemId || ""),
      mode: "sold",
      dryRun,
    });
    const source = "noclaim-set:" + String(listing.set);
    if (dryRun) {
      // No note on a full pick, so the rehearsal names the accounts it would send.
      const note =
        picked.length < want
          ? "only " + picked.length + " of " + want +
            " free no-claim account(s) hold this bundle"
          : "";
      return { picked, source, note };
    }
    if (picked.length < want) {
      // Never a short shipment. A "sold" claim cannot be handed back, so what
      // was taken stays sold to THIS order: the next tick's resume returns it
      // and only tops up the difference. A bulk pack short of whole packs is
      // named as one (FIXES-1 L5); any error pages on G2G.
      return {
        error:
          (listing.bulkOfferId ? "bulk pack short: " : "") +
          "only " + picked.length + " of " + want + " no-claim account(s) " +
          "claimed — no free no-claim account holds all " +
          ((listing.requiredDrops || []).length || (set.items || []).length) +
          " advertised item(s)",
      };
    }
    return { picked, source };
  }

  // A by-game offer (retired — see eldoradoFulfiller.claimUnclaimedForGame):
  // only an order a previous attempt already took accounts for is finished;
  // anything else is held for a hand-over.
  if (listing.unclaimedGame) {
    const shortfall = {};
    const picked = await eld.claimUnclaimedForGame(listing.unclaimedGame, qty, {
      orderId: order.orderItemId,
      dryRun,
      shortfall,
      market: G2G_CLAIM_TAG,
    });
    if (picked.length < qty) {
      return {
        error:
          "no sellable stock on this by-game " + listing.unclaimedGame + " offer" +
          (picked.length ? " (" + picked.length + " of " + qty + " account(s) already taken for this order)" : "") +
          " — " + (shortfall.detail || "by-game offers are retired"),
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

  // Account listings (docs/ACCOUNT-LISTINGS-CONTRACT.md B5): the stock is an
  // explicit list of accounts the owner pasted in, held in
  // models/SuppliedAccount and claimed one row per unit sold. It sits ABOVE the
  // pre-reserved-units fallback because an offer-backed row grows a units[]
  // entry per hand-over as well, and those are a receipt, not free stock.
  if (listing.accountOffer) {
    const gate = getAccountListingSettings();
    if (!gate.enabled || !gate.autoDeliver) {
      // Say WHY. Without this the claim below simply returns nothing and the
      // operator is told the listing is out of stock, which sends them hunting
      // for accounts they have already added.
      return { error: "account-listing delivery is switched off in settings" };
    }
    const supplied = require("./suppliedStock");
    const picked = await supplied.claimForListing(listing, qty, {
      // The same String() the units carry, so a retry's resume matches on the
      // order id instead of claiming a second account.
      orderId: String(order.orderItemId || ""),
      market: G2G_CLAIM_TAG,
      dryRun,
    });
    if (dryRun) {
      return {
        picked,
        source: "supplied",
        note: qty + " of " + picked.length + " supplied account(s) available",
      };
    }
    if (picked.length < qty) {
      // A short claim is never a partial shipment. Hand back what we did take,
      // so topping the list up can still sell it.
      await releaseAccounts(
        picked.map((p) => p.ledgerId),
        { listing, orderId: String(order.orderItemId || "") },
      ).catch(() => {});
      return {
        error:
          "only " + picked.length + " of " + qty +
          " supplied account(s) left in this account listing" +
          // A claim of zero can also be the offer's OWN auto-deliver switch,
          // which claimForListing enforces through suppliedStock.deliveryEnabled
          // and this file cannot see. It is deliberately NOT re-checked here
          // even though deliverOrder loads the offer a few lines down — one
          // enforcement point, one refusal (finding F2b).
          (picked.length ? "" : " (check the offer's own auto-deliver switch)"),
      };
    }
    return { picked, source: "supplied" };
  }

  // Pre-reserved units (the shape publishG2gShare creates). A bulk pack row
  // takes exactly its packs' accounts, never one more.
  const free = undeliveredUnits(listing).filter((u) => !u.orderId);
  if (free.length >= want) {
    return { picked: free.slice(0, want), source: "units", fromUnits: true };
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

  // A bulk pack row must know its pack size (docs/bulk-packs/PACKS-2.md §1):
  // without it this order would be read as single accounts and a pack buyer
  // short-changed. Refuse (G2G errors page) — deliver it by hand.
  const packProblem = packMismatch(listing);
  if (packProblem) {
    return {
      orderId,
      error:
        "bulk pack short: " + packProblem + " — nothing was sent; deliver it by hand",
    };
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
      // A unit the bot never messaged was handed over by a human, so its sale
      // has not been recorded yet (a bot send records it straight away).
      const byHand = mine.filter((u) => !u.messagedAt);
      const now = new Date();
      for (const u of mine) {
        if (!u.messagedAt) u.messagedAt = now;
        if (!u.deliveredAt) u.deliveredAt = now;
      }
      listing.markModified("units");
      await listing.save();
      await markSuppliedDelivered(listing, orderId);
      await markNoclaimSold(listing, order, byHand);
      // In G2G's units: whole packs on a bulk pack row (PACKS-2 §2).
      return { orderId, delivered: unitsFor(listing, mine.length), source: "confirmed-on-g2g" };
    }
    // A bulk pack row reserves an order's whole packs at once (PACKS-2 §2), so
    // fewer accounts than that under this order id is a short pack: it is never
    // re-sent or confirmed as if it were whole — it pages, and a human checks
    // the order. Unreachable through the paths that reserve (they take every
    // account the order needs, or none); a guard, not a flow.
    if (packSizeOf(listing) > 1 && mine.length < accountsForOrder(listing, qty)) {
      return {
        orderId,
        error:
          "bulk pack short: only " + mine.length + " of " +
          accountsForOrder(listing, qty) + " account(s) are reserved for this " +
          "order — nothing re-sent or confirmed; check the order by hand",
      };
    }
    if (mine.every((u) => u.messagedAt)) {
      // The credential really reached the buyer (only the chat send stamps
      // messagedAt), so all that is left is telling G2G the count. A confirm
      // that failed last tick re-confirms here instead of re-sending.
      if (dryRun) {
        return { orderId, dryRun: true, wouldSend: "confirm only (already sent)" };
      }
      return confirmOnG2g(listing, orderId, mine.length, "confirm-only");
    }
    // Reserved, but nothing has reached the buyer. The send lives further down,
    // in the stock-picking path — which this early return skips — so an order
    // whose FIRST send failed could never try again. It parked here forever.
    //
    // That is what happened to order 1788892037419NTQU: the SendBird SDK threw
    // "WebSocket is not defined" (Node 20 has no global WebSocket; see
    // utils/g2gChat.ensureWebSocket), the units were already reserved, and every
    // later tick took this branch and re-parked it. Automatic G2G delivery had
    // never once completed on this host.
    //
    // So: if chat can actually send now, RETRY with the already-reserved units.
    // Re-reading credentials rather than trusting the cached copy is the same
    // rule the first attempt follows — a password can have been rotated since.
    if (!dryRun && chat.canSend && chat.canSend()) {
      // A no-claim row's units are re-read off the no-claim ledger, never
      // BotAccount (§8c) — see noclaimCredentialsFor.
      const retryCreds = listing.noclaimStock
        ? await noclaimCredentialsFor(listing, mine, orderId)
        : await credentialsFor(
            mine.map((u) => ({ login: u.login, accountId: u.accountId, ledgerId: u.contentId })),
            { listing, orderId },
          );
      const unreadableRetry = retryCreds.filter((c) => !c.password);
      if (unreadableRetry.length) {
        return {
          orderId,
          error:
            unreadableRetry.length + " reserved account(s) have no readable " +
            "password — cannot re-send, needs a human",
        };
      }
      // Same template rule as the first send (finding F2a). A failure here
      // leaves the units reserved to THIS order, which is the standing rule for
      // every failure on the retry path, so restoring the offer is all it takes
      // to resume — nothing is sent and nothing is confirmed.
      const retryOffer = await offerForListing(listing).catch(() => null);
      if (listing.accountOffer && !retryOffer) {
        return {
          orderId,
          error: "the listing's AccountOffer is gone — cannot render the hand-over",
        };
      }
      const retryBlocks = retryCreds.map((c) =>
        deliveryBlock(c, retryOffer, { unclaimed: !!listing.noclaimStock }),
      );
      if (retryOffer && retryBlocks.some((b) => !String(b || "").trim())) {
        return { orderId, error: "delivery text rendered empty for this offer" };
      }
      const retryMessage = buildMessage(order, retryBlocks);
      try {
        await mp.g2gStartDeliver(orderId).catch(() => {});
        await mp.g2gMarkDelivering(orderId).catch(() => {});
        // Throws unless the message is verifiably IN the channel, so the stamp
        // below can only ever follow a delivery that really happened.
        await chat.sendToBuyer(order.buyerId, retryMessage);
        const sentAt = new Date();
        for (const u of mine) u.messagedAt = sentAt;
        listing.markModified("units");
        await listing.save();
        await markNoclaimSold(listing, order, mine);
        return await confirmOnG2g(listing, orderId, mine.length, "retry-send");
      } catch (e) {
        // Units stay reserved to THIS order, so the next retry goes to the same
        // buyer rather than spending fresh stock. A moderated-away message is
        // reported as `pending` rather than an error: retrying it will fail
        // identically forever, and what it actually needs is a human on the
        // G2G order page.
        if (e.__g2gChatDropped || e.__g2gChatUnavailable) {
          return {
            orderId,
            pending: mine.length,
            detail: e.message,
          };
        }
        return { orderId, error: "chat re-send failed: " + e.message };
      }
    }
    // Chat genuinely cannot send: park for the operator. Do NOT confirm —
    // saying "delivered" when the buyer has received nothing is how a dispute
    // starts — and do NOT pick fresh stock, which would give a second account
    // away for free.
    return {
      orderId,
      pending: mine.length,
      detail: "waiting for the operator to hand the credential over in G2G chat",
    };
  }

  // The accounts this order takes: `qty` on an ordinary row, qty × N on a bulk
  // pack row (PACKS-2 §2). G2G itself is only ever told units (confirmOnG2g).
  const want = accountsForOrder(listing, qty);
  const stock = await pickStock(listing, order, { dryRun });
  if (stock === null) {
    // A bulk pack row (docs/bulk-packs/FIXES-1.md L5) is never a hand-filled
    // listing: no pick there means a PAID order short of free units, and any
    // error pages the operator.
    if (listing.bulkOfferId) {
      return {
        orderId,
        error:
          "bulk pack short: not enough reserved stock (" +
          undeliveredUnits(listing).filter((u) => !u.orderId).length +
          " of " + want + ") — restock the offer, then this order will " +
          "deliver on the next tick",
      };
    }
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
        want + " account(s) [" + picked.map((p) => p.login).join(", ") + "]",
    };
  }

  // Credentials are re-read at delivery time, never trusted from the cached
  // unit copy — a password can have been rotated since the unit was reserved.
  // A no-claim pick was read moments ago, off the no-claim ledger, by the claim
  // itself, and that exact credential is what ships: credentialsFor's BotAccount
  // lookups would resolve a pool login that also exists in the archive to
  // SOMEONE ELSE's password (§8c).
  const creds = listing.noclaimStock
    ? picked.map((p) => unit(p, p.password))
    : await credentialsFor(picked, { listing, orderId });
  const unreadable = creds.filter((c) => !c.password);
  if (unreadable.length && listing.bulkOfferId) {
    // A bulk pack row (docs/bulk-packs/FIXES-1.md R3-5) is never released
    // here: the release below is tag-wide and could free another set's SOLD
    // drops on the same account. The units stay on the row for the bulk loop's
    // health check, which retires "no password" units; the error pages.
    return {
      orderId,
      error:
        "bulk pack: " + unreadable.length + " of " + want +
        " account(s) had no readable password — not shipped, left for the " +
        "bulk check to retire",
    };
  }
  if (unreadable.length) {
    // An offer-backed row has no accountId at all — contract B5 leaves it empty
    // on purpose so marketplaceGuardian does not raise a duplicate finding on
    // every pass — so releasing by that field would put nothing back and strand
    // the ledger rows on an order that never shipped.
    await releaseAccounts(
      unreadable
        .map((c) => (listing.accountOffer ? c.ledgerId : c.accountId))
        .filter(Boolean),
      { listing, orderId },
    ).catch(() => {});
    return {
      orderId,
      error:
        unreadable.length + " of " + qty +
        " account(s) had no readable password — released, not shipped",
    };
  }

  // Render the hand-over with the offer's own template on an account listing,
  // and with the archive copy everywhere else (finding F2a). Loaded here —
  // after the credential read, before a single G2G call — so a row that cannot
  // be rendered refuses with its stock handed back rather than shipping
  // boilerplate against an offer that promised something else.
  const releaseSupplied = () =>
    releaseAccounts(
      creds.map((c) => c.ledgerId).filter(Boolean),
      { listing, orderId },
    ).catch(() => {});
  const offer = await offerForListing(listing).catch(() => null);
  if (listing.accountOffer && !offer) {
    await releaseSupplied();
    return {
      orderId,
      error: "the listing's AccountOffer is gone — released, not shipped",
    };
  }
  const blocks = creds.map((c) =>
    deliveryBlock(c, offer, { unclaimed: !!listing.noclaimStock }),
  );
  // An empty render followed by a delivered stamp is the "Username: undefined"
  // incident with nothing at all in it. eldoradoFulfiller refuses the same way
  // (:403); only offer-backed rows are checked, because g2gDeliveryCode cannot
  // render empty and an archive row must behave exactly as it did.
  if (offer && blocks.some((b) => !String(b || "").trim())) {
    await releaseSupplied();
    return {
      orderId,
      error: "delivery text rendered empty for this offer — released, not shipped",
    };
  }
  const message = buildMessage(order, blocks);

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
    // `__g2gChatDropped` means the SDK accepted the message and G2G silently
    // binned it — its moderation blocks credential-shaped text in chat, which is
    // what its own on-screen banner tells buyers. That is not a transport error
    // to retry forever; it is a hand-over that has to go through the order page.
    if (!e.__g2gChatUnavailable && !e.__g2gChatDropped) {
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
  await markNoclaimSold(listing, order, unitsForOrder(listing, orderId));

  // `want` accounts went out; confirmOnG2g tells G2G the units (packs).
  return confirmOnG2g(listing, orderId, want, stock.source);
}

// The shape every caller of credentialsFor consumes: the four fields pickStock
// documents at the top of this file plus the three columns only owner-supplied
// stock has, as a PLAIN object.
//
// Building this by hand rather than spreading `p` is the whole point. On the
// pre-reserved path `picked` holds Mongoose SUB-DOCUMENTS, and a sub-document's
// schema paths live on the PROTOTYPE — a spread copies only own enumerable
// properties, so `{ ...unit }` evaluates to
//   { __parentArray, __index, $__parent, $__, _doc }
// and login, accountId and contentId are all silently gone. Measured, not
// guessed: `{ ...listing.units[0] }.login === undefined`.
//
// What that did: `g2gDeliveryCode(c.login, c.password)` rendered
// "Username: undefined" beside the buyer's real password, the send SUCCEEDED, so
// g2gSetDeliveredQty ran and every unit was stamped delivered. A paid order
// recorded as fully delivered with an unusable credential and the stock burned.
//
// It hid for as long as G2G chat itself was broken: every real order failed its
// first send on the missing WebSocket and came back through the retry path,
// which hand-builds plain objects and is therefore correct. Fixing the chat is
// what armed this.
//
// `contentId` is what a unit row calls its ledger id, and the retry path already
// passes it as `ledgerId`, so accept either spelling rather than making callers
// agree.
function unit(p, password) {
  return {
    login: p.login || "",
    accountId: p.accountId ? String(p.accountId) : "",
    ledgerId: p.ledgerId || p.contentId || "",
    password: password || "",
    // Owner-supplied stock only (contract B5): these are what {token}, {email}
    // and {extra} render from, and this normaliser is where they used to be
    // dropped — the hand-over was built from login + password alone, so an
    // offer whose template promised a token shipped without one and the order
    // was confirmed delivered anyway (finding F2a). Empty on every archive and
    // no-claim pick, which never had them, so those blocks are unchanged.
    // Field by field for the same reason as everything above it.
    clientSecret: p.clientSecret || "",
    email: p.email || "",
    extra: p.extra || "",
  };
}

// Credentials for an account listing's stock. They are not in BotAccount at
// all, so the lookups in credentialsFor cannot resolve them — and worse, a
// supplied login that happens to collide with real archive stock would resolve
// SOMEONE ELSE'S password and ship it to a paying buyer.
//
// The claim path already arrives holding its password, so this only runs for a
// retry, which reaches us carrying nothing but the reserved units. It re-reads
// them through the resume half of claimForListing (contract B4): rows already
// carrying this order id come back before anything new is claimed.
async function suppliedCredentialsFor(listing, picked, orderId) {
  // No order id means resume cannot identify anything, and a bare claim would
  // spend a SECOND account on an order that already reserved one. Park instead.
  if (!orderId) return picked.map((p) => unit(p, ""));
  const supplied = require("./suppliedStock");
  const reserved = new Set(
    picked.map((p) => String(p.ledgerId || p.contentId || "")).filter(Boolean),
  );
  const rows = await supplied.claimForListing(listing, picked.length, {
    orderId,
    market: G2G_CLAIM_TAG,
  });
  // Resume is meant to hand back exactly the rows this order already holds.
  // Anything else means the reserved row has gone, and quietly shipping a FRESH
  // account against an order that already reserved one gives the buyer two for
  // the price of one — put the stranger straight back.
  const byId = new Map();
  const strays = [];
  for (const r of rows) {
    const id = String(r.ledgerId || "");
    if (reserved.has(id)) byId.set(id, r);
    else strays.push(r.ledgerId);
  }
  if (strays.length) {
    await supplied.releaseClaim(strays, { orderId }).catch(() => {});
  }
  // A pick with no match keeps an empty password on purpose: that is what makes
  // the caller's "no readable password" gate park the order for a human rather
  // than render half a credential.
  return picked.map((p) => {
    const row = byId.get(String(p.ledgerId || p.contentId || ""));
    if (!row) return unit(p, "");
    // A reserved unit carries login/accountId/contentId and nothing else; the
    // sellable columns live on the ledger row the resume just handed back, and
    // the template needs them (finding F2a). Merged one field at a time — `p`
    // can be a Mongoose sub-document, and a spread of one is what shipped
    // "Username: undefined" to a paying buyer.
    return unit(
      {
        login: p.login,
        accountId: p.accountId,
        ledgerId: p.ledgerId || p.contentId,
        clientSecret: row.clientSecret,
        email: row.email,
        extra: row.extra,
      },
      row.password,
    );
  });
}

// Credentials for a no-claim row's reserved units on a RETRY
// (docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md §8c). They live on the no-claim
// ledger and nowhere else, so — like an account listing's — they are re-read
// through the resume half of the claim: the ledgers already sold to this order
// come back, and nothing new is claimed while they do.
//
// Only a returned ledger that matches a reserved unit is used. A unit the
// resume does not hand back keeps an empty password, which is what makes the
// caller's "no readable password" gate park the order for a human: shipping a
// different account to an order whose credential the operator may already have
// pasted by hand gives the buyer two for the price of one.
async function noclaimCredentialsFor(listing, units, orderId) {
  const ncs = require("./noclaimStock");
  // Thrown rather than returned: the tick records it as this order's error, in
  // the words pickStock uses for a switched-off first claim.
  if (!ncs.deliveryEnabled()) throw new Error(NOCLAIM_DELIVERY_OFF);
  const DropSet = require("../models/DropSet");
  const set = listing.set ? await DropSet.findById(listing.set).lean() : null;
  // No order id means the resume cannot identify anything, and a bare claim
  // would sell a SECOND account to an order that already reserved one.
  const rows =
    set && orderId
      ? await ncs.claimForSet(set, units.length, {
          market: G2G_CLAIM_TAG,
          listingId: String(listing._id),
          orderId,
          mode: "sold",
        })
      : [];
  const byId = new Map(rows.map((r) => [String(r.ledgerId || ""), r]));
  // Field by field: `units` are Mongoose sub-documents (see unit()).
  return units.map((u) => {
    const r = byId.get(String(u.contentId || ""));
    return unit(
      { login: (r && r.login) || u.login, ledgerId: u.contentId },
      r ? r.password : "",
    );
  });
}

// Re-read each account's password at delivery time.
async function credentialsFor(picked, opts = {}) {
  // Account listings (contract B5) resolve somewhere else entirely; see
  // suppliedCredentialsFor. Anything already carrying a password — which is
  // every pick off the claim path — still falls through to the branch below
  // untouched, so this costs an offer-backed happy path nothing.
  const listing = opts.listing || null;
  if (listing && listing.accountOffer && picked.some((p) => !p.password)) {
    return suppliedCredentialsFor(listing, picked, String(opts.orderId || ""));
  }
  const BotAccount = require("../models/BotAccount");
  const { decrypt } = require("./secretBox");
  const out = [];
  for (const p of picked) {
    if (p.password) {
      out.push(unit(p, p.password));
      continue;
    }
    let password = "";
    // The sellable password is `credPassword` — the credential the operator
    // supplied and matched to the account by login. `password` is a different,
    // usually-empty field, and reading it is why a re-send reported "no readable
    // password" for an account that had one: BotAccount marolkapong carried
    // credPassword and nothing else. Every other fulfiller here already reads
    // credPassword (gameflip:195, eldorado:88 and :470, digiseller:75); this was
    // the odd one out, and the bug only surfaced once anything actually used
    // this fallback, because the happy path arrives with a password already
    // resolved by claimAccountsForSet.
    if (p.accountId) {
      const acc = await BotAccount.findById(p.accountId, {
        login: 1,
        password: 1,
        credPassword: 1,
      }).lean();
      const stored = (acc && (acc.credPassword || acc.password)) || "";
      if (stored) {
        try {
          password = decrypt(stored);
        } catch {
          password = "";
        }
      }
    }
    // A unit's accountId is NOT one thing: a BotAccount id on archive stock, but
    // the POOL account id on a no-claim one. Falling back to the login covers
    // both without the caller having to know which kind it holds.
    if (!password && p.login) {
      const acc = await BotAccount.findOne(
        { login: p.login },
        { credPassword: 1, password: 1 },
      ).lean();
      const stored = (acc && (acc.credPassword || acc.password)) || "";
      if (stored) {
        try {
          password = decrypt(stored);
        } catch {
          password = "";
        }
      }
    }
    out.push(unit(p, password));
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
    console.error("g2g fulfiller: could not read order counts:", e.message);
    await intakeWatch("failed", "G2G", e);
    return { error: e.message };
  }
  const waiting = Number(counts && counts.preparing) || 0;
  const delivering = Number(counts && counts.delivering) || 0;
  if (!waiting && !delivering) {
    await intakeWatch("ok", "G2G");
    return { checked: 0 };
  }

  let orders;
  try {
    orders = await mp.g2gPendingOrders({});
  } catch (e) {
    console.error("g2g fulfiller: could not read pending orders:", e.message);
    await intakeWatch("failed", "G2G", e);
    return { error: e.message };
  }
  await intakeWatch("ok", "G2G");
  const results = [];
  for (const order of orders) {
    let r;
    try {
      // Two products share this queue. A rent-farm order sells a WINDOW of
      // farming and is fulfilled by provisioning a pool account, not by
      // handing over archive stock — it has no stock source at all, so the
      // bundle path would park it as "manual-delivery listing" forever.
      // deliverFarmOrder returns null for anything that is not a rent-farm
      // order, which is what routes the rest to the bundle path.
      r =
        (await farmService.deliverFarmOrder(order, { dryRun })) ||
        (await deliverOrder(order, { dryRun }));
    } catch (e) {
      r = { orderId: order.orderItemId, error: e.message };
    }
    results.push(r);
    // `pending` is a PAID order parked for the operator to hand over in G2G
    // chat. It is a deliberate outcome, not a failure — but it was also silent,
    // and a paid order nobody is told about is indistinguishable from a lost
    // one. Order 1788892037419NTQU (Rocket League, $2.18) sat reserved-but-
    // unsent with no error, no log line and no alert; the fulfiller re-parked
    // it every 60 seconds, perfectly happily, while the buyer waited.
    const needsAHuman =
      r.error || alertsOperator(r.skipped) || r.pending || r.awaitingConfirm;
    const why =
      r.error ||
      r.skipped ||
      (r.detail || "reserved, but the credential has not reached the buyer");
    // S3: the Telegram page was the ONLY thing this tick ever said about a paid
    // order it could not ship, and it is skipped entirely in dry run — so an
    // account listing whose delivery switch is off (contract B8) parked in
    // total silence while the G2G offer stayed live at full quantity and more
    // buyers kept paying. Print it beside the page, once per order: this tick
    // re-reads the same order every 60s, and one line a minute is how a real
    // problem gets scrolled past.
    if (needsAHuman) {
      const shoutId = String(order.orderItemId || "");
      if (shoutId && !shouted.has(shoutId)) {
        shouted.add(shoutId);
        console.error(
          "g2g deliver " + shoutId +
            (r.awaitingConfirm || r.sent ? " SENT in chat, confirm it on G2G: " : " NOT delivered: ") +
            why,
        );
      }
    }
    if (needsAHuman && !dryRun) {
      // `sent` with an error: the login reached the buyer and only a later
      // step failed (utils/farmHandover.sentButUnconfirmed) — the buyer is
      // served, so this must never read "cannot ship it".
      if ((r.awaitingConfirm && !r.error) || (r.error && r.sent)) {
        await alertSentAwaitingConfirm(order, why);
      } else {
        await alertUnshippable(order, why, {
          pending: !r.error && !r.skipped && !!r.pending,
        });
      }
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

async function alertUnshippable(order, why, { pending = false } = {}) {
  const id = String(order.orderItemId || "");
  if (!id || alerted.has(id)) return;
  alerted.add(id);
  // The two cases need different words, because they need different actions.
  // "Parked" means the stock is already picked and set aside — the operator
  // only has to paste the credential into chat. "Cannot ship" means the bot has
  // no idea what backs the offer and someone must work that out first.
  const head = pending
    ? "G2G order " + id + " is PAID and waiting for YOU to hand it over in chat.\n\n"
    : "G2G order " + id + " is PAID and the bot cannot ship it.\n\n";
  let tail = pending
    ? "The account is already reserved against this order — nothing else will " +
      "pick it. Paste its credential into the G2G chat for this order, and the " +
      "next sweep will confirm the delivery automatically."
    : "This one needs delivering by hand. Most of the offers on the account were " +
      "created directly on g2g.com and have no listing row here, so the bot does " +
      "not know what stock backs them.";
  // S3: a kill-switch refusal needs different words again. The accounts ARE on
  // the shelf and one toggle ships them, so the standing tail would send the
  // owner hunting for stock that is not missing. Only the settings-level
  // refusal is matched: the offer's own switch surfaces through
  // suppliedStock.claimForListing as an empty claim (finding F2b, one
  // enforcement point), which reads identically to a genuinely empty shelf —
  // and promising "it is on the shelf" for an empty one is the worse mistake.
  if (!pending && /switched off in settings/.test(String(why || ""))) {
    tail =
      "The accounts are on the shelf. Turn account-listing delivery back on " +
      "(Settings, or this offer's own toggle) and the next tick ships it.";
  }
  await notify(
    head +
      String(order.title || "").slice(0, 120) + "\n" +
      "Buyer id: " + order.buyerId + "   " +
      order.currency + " " + order.amount + "\n\n" +
      "Reason: " + why + "\n\n" +
      tail,
  );
}

// The account reached the buyer's chat and only G2G's delivered count is
// missing — the owner marks those delivered by hand. Deduped on its own set, not
// `alerted`: an order that failed first and was sent later must still get THIS
// page, because it is the one saying the buyer is served and nothing more
// should go out. Under `alerted` the earlier "cannot ship" page was the last
// word, which invites hand-delivering a second account.
async function alertSentAwaitingConfirm(order, why) {
  const id = String(order.orderItemId || "");
  if (!id || confirmAsked.has(id)) return;
  confirmAsked.add(id);
  await notify(
    "G2G order " + id + ": the account was SENT to the buyer in chat " +
      "(verified in the channel).\n\n" +
      String(order.title || "").slice(0, 120) + "\n" +
      "Buyer id: " + order.buyerId + "   " +
      order.currency + " " + order.amount + "\n\n" +
      "Mark it Delivered on the G2G order page — G2G would not take the " +
      "automatic count. Do NOT send another account; this buyer has theirs.\n\n" +
      "Detail: " + why,
  );
}

// How many units this row could ACTUALLY ship right now. Returns null for
// "cannot tell", which callers must treat as "change nothing".
//
// This keeps its own realStockFor rather than sharing one, and
// that is a deliberate exception to the no-second-copy rule: the rule exists
// because a drifted copy of a CLAIM function oversells an account. This one
// only counts — every path through it is read-only or a dry run — so a local
// version cannot hand anything out twice, and sharing one would make G2G's
// stock depend on another market's claim tag.
async function realStockFor(row, listedElsewhere) {
  if (!row) return null;
  // Account listings (contract B5) come first: an offer-backed row also carries
  // a units[] receipt per hand-over, and the units branch at the bottom would
  // read those as "nothing free" and delist a listing that still has stock.
  if (row.accountOffer) {
    return require("./suppliedStock").stockFor(row);
  }
  // No-claim Shop listings (§8c) sit above the generic `set` branch, which
  // counts the Drop Archive — CLAIMED drops a no-claim buyer can never be sold.
  // A failed read throws, and syncStock already treats a throw as "cannot
  // tell", so a DB hiccup never advertises 0 and delists a live offer. Above
  // the by-game test too, as in pickStock: a set row that still carries an old
  // `unclaimedGame` sells from its set.
  if (row.noclaimStock) {
    return require("./noclaimStock").stockForListing(row);
  }
  // A by-game offer has nothing it may sell (retired — see
  // eldoradoFulfiller.claimUnclaimedForGame): 0 takes it off sale.
  if (row.unclaimedGame) return 0;
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

  // Offer-backed rows carry origin:"manual" on purpose (contract B5, so that no
  // future repricer can touch owner-supplied stock), but pausing themselves when
  // the pasted list runs dry is the whole point of the mode — and the $ne filter
  // alone hides them from the only pass that can do it. The $or only ADDS those
  // rows; which other rows are selected is unchanged.
  const rows = await MarketplaceListing.find({
    marketplace: "g2g",
    status: "active",
    $or: [{ origin: { $ne: "manual" } }, { accountOffer: { $ne: null } }],
  }).limit(200);
  // No-claim Shop rows (docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md §8c) are origin
  // "manual" for the same reason. They come from their OWN query rather than a
  // third $or branch: under the shared .limit(200) an extra branch could push
  // existing rows out of the pass once the total grew past the cap.
  const noclaimRows = await MarketplaceListing.find({
    marketplace: "g2g",
    status: "active",
    noclaimStock: true,
  }).limit(200);
  const seen = new Set(rows.map((r) => String(r._id)));
  for (const r of noclaimRows) {
    if (!seen.has(String(r._id))) rows.push(r);
  }

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
    // A bulk pack row (docs/bulk-packs/FIXES-1.md R3-3): below its offer's
    // minimum order nothing can be bought, so it counts as empty and is
    // delisted like one; and a bulk offer that is not "live" (owner pause,
    // closed, held) is never relisted from here. A failed read skips the row.
    //
    // A v2 pack row (bulkPackSize >= 2, docs/bulk-packs/PACKS-2.md §2) is sold
    // one PACK per unit: it advertises the whole packs its accounts fill, and
    // 0 packs delists it exactly like an empty shelf. That replaces the minimum
    // rule above for such a row.
    let bulkLive = true;
    if (row.bulkOfferId) {
      let bulk = null;
      try {
        bulk = await require("../models/BulkOffer")
          .findById(row.bulkOfferId, { minQty: 1, state: 1 })
          .lean();
      } catch {
        continue;
      }
      // A pack title the row cannot honour — or a bulk row with no pack size —
      // is never on sale (packMath.packMismatch; delivery refuses it too).
      if (packMismatch(row)) real = 0;
      else if (packSizeOf(row) > 1) real = unitsFor(row, real);
      else if (bulk && real < (Number(bulk.minQty) || 0)) real = 0;
      if (bulk && bulk.state !== "live") bulkLive = false;
    }
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
        if (row.autoPaused && bulkLive) {
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
  loop(sweepConfirmedFarmOrders, CONFIRM_SWEEP_MS, 4 * 60 * 1000, "farm confirm sweep");
  loop(sweepDeliveryProofs, PROOF_SWEEP_MS, 3 * 60 * 1000, "proof sweep");
}

// Rent-farm orders the owner confirmed by hand on G2G leave the pending queue,
// so this is the only thing that closes their rows (see
// g2gFarmService.closeConfirmedFarmOrders).
async function sweepConfirmedFarmOrders() {
  const af = getAutoFarm() || {};
  if (!af.g2gAutoDeliver) return { skipped: "g2gAutoDeliver is off" };
  return farmService.closeConfirmedFarmOrders();
}

// DELIVERY PROOFS (2026-10-01). G2G holds a delivered order's income until a
// proof image is uploaded — its order item says
// require_delivery_proof_to_credit_income — so a buyer who never presses
// "received" left the money parked until someone uploaded a screenshot by hand.
//
// Every PROOF_SWEEP_MS: each order G2G shows as fully delivered (delivered_qty
// >= purchased_qty, awaiting the buyer) whose credential OUR chat send handed
// over (a unit stamped `messagedAt`, or a rent-farm row with messageSentAt) and
// that has no proof yet (G2G's own total_uploaded_proofs) gets one: the
// delivery card utils/playerauctionsProof draws — order, offer, how many
// accounts, when the credential was sent, and that it went through the G2G
// chat; never the login or password. Orders we did not send are left alone (the
// card would attest to something this system did not do). Units the owner
// confirmed by hand also get their missing `deliveredAt` stamp here, so the
// bookkeeping matches G2G.
//
// Exactly once per order: G2G's proof count is read before every upload. A
// failure backs off (30 min doubling to 6 h) and pages once after
// PROOF_PAGE_AFTER failures. In-memory state only; after a restart the proof
// count on G2G is the record.
const proofState = new Map(); // orderItemId -> { tries, nextAt, done, paged }

async function sentByUs(orderItemId) {
  const listing = await MarketplaceListing.findOne({ marketplace: "g2g", "units.orderId": orderItemId });
  const units = listing ? unitsForOrder(listing, orderItemId).filter((u) => u.messagedAt) : [];
  if (units.length) {
    const sentAt = new Date(Math.min(...units.map((u) => new Date(u.messagedAt).getTime())));
    return { listing, units, accounts: units.length, sentAt };
  }
  const FarmServiceOrder = require("../models/FarmServiceOrder");
  const row = await FarmServiceOrder.findOne(
    { orderId: "g2g:" + orderItemId, messageSentAt: { $ne: null } },
    { messageSentAt: 1, accounts: 1 },
  ).lean();
  if (row) return { listing: null, units: [], accounts: (row.accounts || []).length || 1, sentAt: row.messageSentAt };
  return null;
}

// Completed orders count too: G2G marks them require_delivery_proof_to_credit_
// income as well (measured 2026-10-01: every completed order carried it with
// 0 proofs), so a buyer's "received" alone did not credit the income either.
const PROOF_STATUSES = ["delivering", "completed"];
const PROOF_PAGES = 3;
const PROOF_PAGE_SIZE = 30;
const PROOF_MAX_UPLOADS = 8; // per pass: a backlog drains over a few passes

async function sweepDeliveryProofs({ now = Date.now() } = {}) {
  const af = getAutoFarm() || {};
  if (!af.g2gAutoDeliver) return { skipped: "g2gAutoDeliver is off" };
  const dryRun = af.g2gDeliverDryRun !== false;
  const out = { checked: 0, uploaded: 0, stamped: 0, failed: 0, notOurs: 0, already: 0, wouldUpload: 0 };
  const rows = [];
  for (const status of PROOF_STATUSES) {
    for (let page = 1; page <= PROOF_PAGES; page++) {
      const got = await mp.g2gOrders({ page, pageSize: PROOF_PAGE_SIZE, status });
      rows.push(...got);
      if (got.length < PROOF_PAGE_SIZE) break;
    }
  }
  for (const o of rows) {
    if (out.uploaded + out.failed >= PROOF_MAX_UPLOADS) break;
    const id = String(o.orderItemId || "");
    // Fully delivered: awaiting the buyer, or completed.
    if (!id || !(o.purchasedQty > 0 && o.deliveredQty >= o.purchasedQty)) continue;
    const st = proofState.get(id);
    if (st && (st.done || now < st.nextAt)) continue;
    out.checked++;
    const ours = await sentByUs(id);
    if (!ours) {
      out.notOurs++;
      proofState.set(id, { done: true });
      continue;
    }
    const item = (await mp.g2gOrder(id)) || {};
    // Units the owner confirmed by hand: stamp what G2G already says. A
    // targeted update of just this order's unstamped units — never a whole-
    // document save, which could overwrite a unit the delivery tick is
    // reserving on the same listing right now.
    if (ours.listing && !dryRun && ours.units.some((u) => !u.deliveredAt)) {
      const stamp = item.order_delivered_at ? new Date(Number(item.order_delivered_at)) : new Date(now);
      const res = await MarketplaceListing.updateOne(
        { _id: ours.listing._id },
        { $set: { "units.$[u].deliveredAt": stamp } },
        { arrayFilters: [{ "u.orderId": id, "u.messagedAt": { $ne: null }, "u.deliveredAt": null }] },
      ).catch((e) => {
        console.error("g2g proof sweep: stamping " + id + " delivered failed:", e.message);
        return null;
      });
      const n = (res && (res.modifiedCount || res.nModified)) || 0;
      if (n) {
        await markSuppliedDelivered(ours.listing, id);
        out.stamped += n;
      }
    }
    const needed = item.require_delivery_proof_to_credit_income || item.require_delivery_proof;
    if (!needed || Number(item.total_uploaded_proofs) > 0) {
      out.already++;
      proofState.set(id, { done: true });
      continue;
    }
    if (dryRun) {
      out.wouldUpload++;
      continue;
    }
    try {
      const png = await require("./playerauctionsProof").renderProofPng({
        orderId: id,
        offerTitle: item.offer_title || o.title || "",
        accountCount: ours.accounts,
        when: ours.sentAt ? new Date(ours.sentAt) : new Date(now),
        sellerName: G2G_SELLER_NAME,
        market: "G2G",
        method: "Sent to the buyer in the G2G chat",
        banner: "The account credentials were sent to the buyer in the G2G chat for this order.",
      });
      await mp.g2gUploadDeliveryProof(id, png);
      out.uploaded++;
      proofState.set(id, { done: true });
      try {
        require("./systemLog")
          .logEvent({
            category: "marketplace",
            action: "g2g_delivery_proof_uploaded",
            actor: "g2g-fulfiller",
            subject: id,
            detail: "delivery proof uploaded for " + (item.offer_title || o.title || "order") + " (" + ours.accounts + " account(s))",
          })
          .catch(() => {});
      } catch {
        /* diagnostics only */
      }
    } catch (e) {
      out.failed++;
      const tries = ((st && st.tries) || 0) + 1;
      const wait = Math.min(PROOF_RETRY_MAX_MS, PROOF_RETRY_BASE_MS * 2 ** (tries - 1));
      const paged = !!(st && st.paged);
      proofState.set(id, { tries, nextAt: now + wait, paged: paged || tries >= PROOF_PAGE_AFTER });
      console.error("g2g delivery proof " + id + " failed (try " + tries + "):", e.message);
      if (tries >= PROOF_PAGE_AFTER && !paged) {
        await notify(
          "G2G order " + id + ": the delivery proof could not be uploaded after " + tries +
            " tries (" + String(e.message).slice(0, 200) + "). G2G holds the income until a proof " +
            "is uploaded — upload a screenshot on the order page.",
        ).catch(() => {});
      }
    }
  }
  return out;
}

// The intake-failure watch (utils/intakeWatch) must never break a delivery
// tick: not by rejecting, and not by failing to load (a require that throws
// happens before any .catch could apply).
function intakeWatch(fn, ...args) {
  try {
    return Promise.resolve(require("./intakeWatch")[fn](...args)).catch(() => {});
  } catch {
    return Promise.resolve();
  }
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
  confirmOnG2g,
  realStockFor,
  syncStock,
  sweepDeliveryProofs,
  _resetProofState: () => proofState.clear(),
};
