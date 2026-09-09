// Rent-farm orders on G2G.
//
// Two different products share the G2G order queue and they are fulfilled in
// completely different ways:
//
//   * a BUNDLE order hands over an already-farmed account from the Drop
//     Archive — that is utils/g2gFulfiller;
//   * a RENT-FARM order ("<Game> Twitch Drops Automatic Farming 180 Days")
//     sells a WINDOW of farming, and is fulfilled by provisioning a pristine
//     pool account into the farm for that many days.
//
// A rent-farm listing therefore has no stock source and no reserved units, so
// g2gFulfiller.pickStock returns null for it and the order would be parked as
// "manual-delivery listing" forever. This module is what makes those orders
// ship, and it is tried FIRST in the tick: it returns null for anything that is
// not a rent-farm order, which is what routes an order to the bundle path.
//
// Mirrors utils/playerauctionsFarmService and utils/eldoradoFarmService. The
// order state machine (FarmServiceOrder, claimed -> provisioned -> sent ->
// delivered) is shared with both so a half-finished hand-over resumes instead
// of provisioning a second set of accounts.
const FarmServiceOrder = require("../models/FarmServiceOrder");
const AvailableAccount = require("../models/AvailableAccount");
const { decrypt } = require("./secretBox");
const mp = require("./marketplaces");
const operatorFarm = require("./operatorFarm");
const farmAlert = require("./farmServiceAlert");
const provisioning = require("./farmProvisioning");

// Which marketplace this service speaks for, used in failure alerts.
const MARKET = "g2g";
const chat = require("./g2gChat");

// Our own naming convention, so this parse is a contract with ourselves:
//   "<Game> Twitch Drops Automatic Farming 120 Days"
//   "<Game> Twitch Drops Automatic farming 180 days"   (legacy casing)
//   "<Game> Twitch Drops Automatic Farming 1 Year"
const FARM_TITLE = /\bAutomatic\s+Farming\b/i;

// The game/term parse and the game-name resolver are REUSED from the
// PlayerAuctions service rather than copied. They are pure functions, and the
// one time this logic was duplicated the copies drifted: an accent-folding bug
// left six live offers unable to resolve their game at all. One implementation
// means one place to fix.
const pa = require("./playerauctionsFarmService");
const { termToDays, canonicalGame, knownFarmGames } = pa;

// G2G order ids are timestamp strings while Eldorado's are UUIDs and
// PlayerAuctions' are plain integers; all three share the FarmServiceOrder
// collection, whose orderId is globally unique. Namespacing keeps them apart
// for good rather than relying on the id spaces never meeting.
function farmOrderKey(orderId) {
  return "g2g:" + String(orderId);
}

// Is this order one of ours, and what did the buyer actually buy?
// Returns null for anything that is not a rent-farm offer.
async function parseFarmOrder(order) {
  const title = String((order && (order.title || order.offerTitle)) || "");
  if (!FARM_TITLE.test(title)) return null;
  const days = termToDays(title);
  const rawGame = title.split(/\s+Twitch\s+Drops\b/i)[0].trim();
  const game = await canonicalGame(rawGame, await knownFarmGames());
  return { title, rawGame, game, days };
}

// Passwords are read at hand-over time, never cached on the order row — a pool
// password can be rotated between provisioning and delivery.
async function credentialsFor(added) {
  const out = [];
  for (const a of added || []) {
    const pool = a.poolId ? await AvailableAccount.findById(a.poolId).lean() : null;
    let password = "";
    if (pool) {
      try {
        password = decrypt(pool.password || "") || "";
      } catch {
        password = "";
      }
      if (!password && pool.credPasswordEnc) {
        try {
          password = decrypt(pool.credPasswordEnc) || "";
        } catch {
          password = "";
        }
      }
    }
    out.push({
      login: a.login || (pool && pool.username) || "",
      password,
      poolId: a.poolId,
    });
  }
  return out;
}

function farmMessage(creds, { game, days }) {
  // Lazy require: g2gFulfiller requires this module, so pulling it in at load
  // time would be a cycle and the export would be undefined here.
  const { g2gDeliveryCode } = require("./g2gFulfiller");
  const lines = creds.map((c) => g2gDeliveryCode(c.login, c.password));
  return (
    "Your " + game + " Twitch Drops automatic farming is now running for " +
    days + " days.\n\n" +
    lines.join("\n") +
    "\n\nThe account above is already connected and farming for you. Sign in " +
    "to Twitch with it any time to see the drops as they arrive, and keep it " +
    "linked to your game account so the rewards land where you want them.\n\n" +
    "Please do not change the password — it would disconnect the farm."
  );
}

// Fulfil one rent-farm order. Returns null when the order is not a rent-farm
// order at all, so the caller falls through to the bundle path.
async function deliverFarmOrder(order, { dryRun } = {}) {
  const parsed = await parseFarmOrder(order);
  if (!parsed) return null;

  const orderId = String((order && (order.orderItemId || order.orderId)) || "");
  const key = farmOrderKey(orderId);
  const qty = Math.max(1, parseInt(order && order.purchasedQty, 10) || 1);

  // A title we cannot read is still a PAID order.
  //
  // These two checks used to return here, ABOVE the FarmServiceOrder claim — so
  // an unreadable order created no row, and with no row there was no
  // farmServiceAlert, nothing for the `orders.undelivered` health check to
  // count, and nothing in the audit log: one console.error per tick in pm2
  // stdout while the buyer waited.
  //
  // (The alias hint also named playerauctionsFarmService — a copy-paste that
  // would have sent whoever hit this to the wrong file.)
  const unreadable = !parsed.days
    ? 'could not read a farming term from "' + parsed.title + '"'
    : !parsed.game
      ? 'the farm does not know a game called "' + parsed.rawGame + '" — ' +
        "add an alias in utils/g2gFarmService before this can auto-deliver"
      : "";

  if (dryRun) {
    if (unreadable) return { orderId, farm: true, dryRun: true, error: unreadable };
    const avail = await operatorFarm.previewFreshAccounts({ count: qty });
    return {
      orderId,
      farm: true,
      dryRun: true,
      wouldSend:
        qty + "x " + parsed.game + " for " + parsed.days + " days " +
        "(pool eligible: " + avail.eligibleTotal + ", would add: " + avail.willAdd + ")",
    };
  }

  // Claim the order. The unique index is what stops two ticks provisioning the
  // same order twice.
  let row = await FarmServiceOrder.findOne({ orderId: key });
  if (row && row.state === "delivered") {
    return { orderId, farm: true, skipped: "already delivered" };
  }
  if (!row) {
    try {
      row = await FarmServiceOrder.create({
        orderId: key,
        market: "g2g",
        offerId: String((order && order.offerId) || ""),
        offerTitle: parsed.title,
        buyerUsername: String((order && order.buyerId) || ""),
        game: parsed.game,
        days: parsed.days,
        quantity: qty,
      });
    } catch (e) {
      if (e && e.code === 11000)
        return { orderId, farm: true, skipped: "claimed by another tick" };
      throw e;
    }
  }
  row.attempts += 1;

  // The unreadable-title refusal, now that there is a row to hang it on.
  if (unreadable) {
    const alert = farmAlert.shouldAlert(row);
    row.state = "failed";
    row.lastError = unreadable;
    await row.save();
    if (alert) {
      await farmAlert
        .alertFarmFailure({
          market: MARKET,
          orderId,
          offerTitle: row.offerTitle || parsed.title || "",
          game: parsed.game || parsed.rawGame || "",
          days: parsed.days || 0,
          qty,
          buyerUsername: row.buyerUsername || "",
          reason: unreadable,
        })
        .catch(() => {});
    }
    return { orderId, farm: true, error: unreadable };
  }

  try {
    // 1. Provision, unless a previous attempt already did.
    if (!row.provisionedAt) {
      // Ask ONLY for what this order is still missing, and APPEND the result.
      // Asking for `qty` again and overwriting row.accounts is what stranded the
      // accounts a previous attempt had already pinned to a bot — see
      // utils/farmProvisioning for the whole failure.
      const need = provisioning.stillNeeded(row, qty);
      const res = need
        ? await operatorFarm.farmFreshAccounts({
            game: parsed.game,
            days: parsed.days,
            count: need,
            actor: "g2g-order:" + orderId,
          })
        : { added: [] };
      const added = (res && res.added) || [];
      row.accounts = provisioning.mergeProvisioned(
        row.accounts,
        added,
        res && res.farmUntil,
      );
      if (row.accounts.length < qty) {
        // Keep WHY. farmFreshAccounts hands back skipped:[{username, reason}]
        // with the real error behind each rejected account; recording only the
        // count is what made order 4b20765f undiagnosable.
        const alert = farmAlert.shouldAlert(row);
        row.state = "failed";
        row.lastError = farmAlert.shortfallMessage(
          { added: row.accounts, skipped: (res && res.skipped) || [] },
          qty,
        );
        await row.save();
        if (alert) {
          await farmAlert.alertFarmFailure({
            market: MARKET,
            orderId,
            offerTitle: row.offerTitle || parsed.title || "",
            game: parsed.game,
            days: parsed.days,
            qty,
            buyerUsername: row.buyerUsername || "",
            reason: row.lastError,
          });
        }
        return { orderId, farm: true, error: row.lastError };
      }
      // row.accounts was already merged above — deliberately NOT rebuilt here.
      // Rebuilding it from `added` is exactly the overwrite that stranded a
      // previous attempt's accounts.
      row.provisionedAt = new Date();
      row.state = "provisioned";
      await row.save();
    }

    // 2. Hand over, unless a previous attempt already did.
    if (!row.messageSentAt) {
      const creds = await credentialsFor(row.accounts);
      if (creds.some((c) => !c.login || !c.password)) {
        const alertPw = farmAlert.shouldAlert(row);
        row.state = "failed";
        row.lastError = "a provisioned account has no readable password";
        await row.save();
        if (alertPw) {
          await farmAlert.alertFarmFailure({
            market: MARKET,
            orderId,
            offerTitle: row.offerTitle || parsed.title || "",
            game: parsed.game,
            days: parsed.days,
            qty,
            buyerUsername: row.buyerUsername || "",
            reason: row.lastError,
          });
        }
        return { orderId, farm: true, error: row.lastError };
      }
      // G2G wants the seller to open the delivery details first; both
      // transitions are idempotent enough to re-run.
      await mp.g2gStartDeliver(orderId).catch(() => {});
      await mp.g2gMarkDelivering(orderId).catch(() => {});
      const message = farmMessage(creds, parsed);
      try {
        await chat.sendToBuyer(order.buyerId, message);
      } catch (e) {
        // TWO failures need the same remedy, and only one used to be caught.
        //
        // `__g2gChatUnavailable` is "no SDK / no WebSocket". `__g2gChatDropped`
        // is G2G accepting a credential-shaped message and silently binning it —
        // its own moderation, which its on-screen banner warns buyers about.
        // Rethrowing the second one sent it to the generic handler, which marked
        // the order FAILED and paged the operator with a reason string but never
        // with the text to paste. Both mean exactly one thing: a human has to
        // hand this over.
        if (!e.__g2gChatUnavailable && !e.__g2gChatDropped) throw e;
        // The accounts ARE provisioned and farming, so the sale is half-honoured;
        // what is missing is a human paste. Say exactly that and do NOT mark the
        // order delivered — messageSentAt stays null so the next tick re-offers
        // it rather than claiming it shipped.
        //
        // BUT that same null is why this used to re-page every 60 seconds
        // forever, and the page carries the buyer's PASSWORD. An alert nobody
        // can silence is an alert everybody learns to ignore, and repeating a
        // credential into a chat history hundreds of times a day is its own
        // small leak. So: first time, then every REALERT_EVERY-th attempt —
        // the same cadence utils/farmServiceAlert already uses for a stuck
        // order. `lastError` is the durable marker of "already asked".
        const WAITING = "waiting for the operator to paste the credential";
        const attempts = Number(row.attempts) || 0;
        const firstAsk = row.lastError !== WAITING;
        if (firstAsk || (attempts > 0 && attempts % farmAlert.REALERT_EVERY === 0)) {
          await require("./telegram").sendTelegram(
            "G2G rent-farm order " + orderId + " is provisioned and FARMING, " +
              "but the credential still needs pasting into the buyer chat.\n\n" +
              (e.__g2gChatDropped
                ? "G2G MODERATED the automatic message away — it must go through " +
                  "the order page.\n\n"
                : "") +
              parsed.game + " / " + parsed.days + " days\n" +
              "Buyer id: " + (order.buyerId || "?") + "\n\n" + message,
          ).catch(() => {});
        }
        row.state = "provisioned";
        row.lastError = WAITING;
        await row.save();
        return {
          orderId,
          farm: true,
          handedTo: "operator",
          detail: parsed.game + " / " + parsed.days + "d provisioned, awaiting paste",
        };
      }
      row.messageSentAt = new Date();
      row.state = "sent";
      await row.save();
    }

    // 3. Only now is the order delivered.
    await mp.g2gSetDeliveredQty(orderId, qty);
    row.deliveredAt = new Date();
    row.state = "delivered";
    row.lastError = "";
    await row.save();
    return {
      orderId,
      farm: true,
      delivered: qty,
      detail:
        parsed.game + " / " + parsed.days + "d / " +
        row.accounts.map((a) => a.login).join(", "),
    };
  } catch (e) {
    const alertErr = farmAlert.shouldAlert(row);
    row.state = "failed";
    row.lastError = String(e.message || e).slice(0, 400);
    await row.save().catch(() => {});
    if (alertErr) {
      await farmAlert.alertFarmFailure({
        market: MARKET,
        orderId,
        offerTitle: row.offerTitle || (parsed && parsed.title) || "",
        game: (parsed && parsed.game) || row.game || "",
        days: (parsed && parsed.days) || row.days || 0,
        qty,
        buyerUsername: row.buyerUsername || "",
        reason: row.lastError,
      });
    }
    return { orderId, farm: true, error: row.lastError };
  }
}

module.exports = {
  FARM_TITLE,
  farmOrderKey,
  parseFarmOrder,
  credentialsFor,
  farmMessage,
  deliverFarmOrder,
};
