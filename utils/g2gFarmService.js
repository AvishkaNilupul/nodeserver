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
const farmHandover = require("./farmHandover");
const provisioning = require("./farmProvisioning");
const { accountsForUnits, titlePackSize } = require("./bulkPacks/packMath");

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

// `until` is the window's end, counted from this hand-over (utils/farmHandover).
function farmMessage(creds, { game, days }, { until = null } = {}) {
  // The login only — NOT the bundle card (g2gDeliveryCode). That card's guide
  // sends the buyer to "Received → Connect", which is the bundle product's
  // step and, for a farm window, the wrong order: since 2026-10-05 Twitch
  // refuses a claim from an account that is not linked to the game, so the
  // buyer has to connect FIRST or nothing is ever claimed for them
  // (utils/farmHandover.connectFirstText). "TWITCH DROP ACCOUNT" and
  // "automatic farming is now running" stay: utils/g2gInbox recognises our own
  // hand-over in a thread by them.
  const list = Array.isArray(creds) ? creds : [];
  const blocks = list.map(
    (c, i) =>
      (list.length > 1 ? "=== ACCOUNT " + (i + 1) + " of " + list.length + " ===\n" : "") +
      "Username: " + c.login + "\nPassword: " + c.password,
  );
  return (
    "Your " + game + " Twitch Drops automatic farming is now running for " +
    farmHandover.termWords(days) +
    (until ? ", until " + farmHandover.dayText(until) + " (UTC)" : "") + ".\n\n" +
    "TWITCH DROP ACCOUNT\n\n" +
    blocks.join("\n\n") +
    "\n\n" + farmHandover.connectFirstText(game) +
    "\n\nThen keep it linked to your game account: our farm claims every drop " +
    "automatically the moment it unlocks, and the rewards land on the game " +
    "account you connected. Sign in to Twitch with it any time to see them " +
    "arrive.\n\n" +
    "Please do not change the password or email — it would disconnect the " +
    "farm, and that is not covered by a refund.\n\n" +
    "Any problem at all, message me here first and I will sort it out."
  );
}

// Tell G2G the order shipped. Runs only once messageSentAt is stamped, i.e. the
// credential is verifiably in the buyer's chat.
//
// delivered_qty still answers HTTP 500 to this client, and the owner confirms
// G2G orders by hand on the order page. So a refused count leaves the row
// "sent", not "failed": thrown into the catch below, it paged "rent-farm order
// FAILED" about a buyer who already had the account.
async function confirmFarmOnG2g(row, orderId, qty) {
  try {
    await mp.g2gSetDeliveredQty(orderId, qty);
  } catch (e) {
    row.state = "sent";
    row.lastError = (
      "in the buyer's chat; G2G refused the delivered count (" + e.message +
      ") — confirm it on the G2G order page"
    ).slice(0, 400);
    await row.save();
    return { confirmed: false, reason: e.message };
  }
  row.deliveredAt = new Date();
  row.state = "delivered";
  row.lastError = "";
  await row.save();
  return { confirmed: true };
}

// Close rows the owner confirmed by hand on G2G.
//
// A confirmed order leaves g2gPendingOrders, so deliverFarmOrder never sees it
// again and nothing else would stamp it. The row would sit undelivered forever
// and keep the `orders.undelivered` health check red over a buyer who was
// served. Only rows whose credential was already sent qualify ("failed" too,
// for any that failed on the count before it was handled above), and only
// when G2G itself reports the full quantity delivered.
async function closeConfirmedFarmOrders({ limit = 20 } = {}) {
  const rows = await FarmServiceOrder.find(
    {
      market: MARKET,
      state: { $in: ["sent", "failed"] },
      messageSentAt: { $ne: null },
      deliveredAt: null,
    },
    null,
    { sort: { updatedAt: 1 }, limit },
  );
  let closed = 0;
  for (const row of rows || []) {
    const id = String(row.orderId || "").replace(/^g2g:/, "");
    if (!id) continue;
    let o;
    try {
      o = await mp.g2gOrder(id);
    } catch {
      continue; // unreadable this pass; the next one retries
    }
    const purchased = Number(o && o.purchased_qty) || 0;
    const delivered = Number(o && o.delivered_qty) || 0;
    if (purchased > 0 && delivered >= purchased) {
      row.deliveredAt = new Date();
      row.state = "delivered";
      row.lastError = "";
      await row.save();
      closed += 1;
    }
  }
  return { checked: (rows || []).length, closed };
}

// Fulfil one rent-farm order. Returns null when the order is not a rent-farm
// order at all, so the caller falls through to the bundle path.
async function deliverFarmOrder(order, { dryRun } = {}) {
  const parsed = await parseFarmOrder(order);
  if (!parsed) return null;

  const orderId = String((order && (order.orderItemId || order.orderId)) || "");
  const key = farmOrderKey(orderId);
  const qty = Math.max(1, parseInt(order && order.purchasedQty, 10) || 1);

  // Bulk packs v2 (docs/bulk-packs/PACKS-2.md §2): on a bulk pack farming
  // offer each unit bought is a pack of N accounts. `qty` stays in G2G's units
  // — it is what G2G is told (delivered_qty), a pack being ONE — and `accounts`
  // is what is provisioned, recorded as the row's quantity, alerted on and
  // handed over. Every other farming offer: accounts === qty, as before. The
  // lookup is shared with the Eldorado service (one copy), asked before
  // anything else, dry run included; an unreadable answer waits for the next
  // tick with nothing provisioned, never a guess.
  let bulk = null;
  try {
    bulk = await require("./eldoradoFarmService").bulkFarmPack(order && order.offerId, MARKET);
  } catch (e) {
    return {
      orderId,
      farm: true,
      error:
        "could not read the bulk offer behind farming offer " +
        String((order && order.offerId) || "") + " (" + (e && e.message) + ") — " +
        "nothing provisioned, the next tick retries",
    };
  }
  let accounts = bulk ? accountsForUnits(bulk.pack, qty) : qty;

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
  // A pack title with no matching bulk offer must never provision x1 (see
  // utils/eldoradoFarmService): refused on the row like any unreadable order.
  const titleN = titlePackSize(parsed.title);
  const packMismatch =
    titleN && (!bulk || bulk.size !== titleN)
      ? "the title promises PACK OF " + titleN + " ACCOUNTS but " +
        (bulk
          ? "its bulk offer is a pack of " + bulk.size
          : "no bulk offer matches offer " + String((order && order.offerId) || "")) +
        " — nothing provisioned; deliver it by hand"
      : "";
  const unreadable = packMismatch || (!parsed.days
    ? 'could not read a farming term from "' + parsed.title + '"'
    : !parsed.game
      ? 'the farm does not know a game called "' + parsed.rawGame + '" — ' +
        "add an alias in utils/g2gFarmService before this can auto-deliver"
      : "");

  if (dryRun) {
    if (unreadable) return { orderId, farm: true, dryRun: true, error: unreadable };
    const avail = await operatorFarm.previewFreshAccounts({ count: accounts });
    return {
      orderId,
      farm: true,
      dryRun: true,
      wouldSend:
        accounts + "x " + parsed.game + " for " + parsed.days + " days " +
        "(pool eligible: " + avail.eligibleTotal + ", would add: " + avail.willAdd + ")",
    };
  }

  // Claim the order. The unique index is what stops two ticks provisioning the
  // same order twice.
  let row = await FarmServiceOrder.findOne({ orderId: key });
  // A CANCELLED row is closed (the buyer walked away / was refunded) — it must
  // never provision, even while the platform still lists the order as paid.
  if (row && (row.state === "delivered" || row.state === "cancelled")) {
    return { orderId, farm: true, skipped: "already " + row.state };
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
        quantity: accounts,
      });
    } catch (e) {
      if (e && e.code === 11000)
        return { orderId, farm: true, skipped: "claimed by another tick" };
      throw e;
    }
    // A pack order's units and pack size (PACKS-2 §2). FarmServiceOrder
    // declares no `note` path, so it is written schema-less; the next save
    // below persists it.
    if (bulk) {
      row.set(
        "note",
        require("./eldoradoFarmService").packNote(bulk, qty, accounts),
        { strict: false },
      );
    }
  }
  row.attempts += 1;

  // Once anything is provisioned, the account count / game / term it was
  // provisioned for stand (utils/farmProvisioning.freezeOrder). `qty` — G2G's
  // own unit count, what delivered_qty is told — is the order's and unchanged.
  const fz = provisioning.freezeOrder(row, { qty: accounts, game: parsed.game, days: parsed.days });
  accounts = fz.qty;
  if (fz.frozen) {
    parsed.game = fz.game;
    parsed.days = fz.days;
  }

  // The unreadable-title refusal, now that there is a row to hang it on.
  if (unreadable && !fz.frozen) {
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
          qty: accounts,
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
      const need = provisioning.stillNeeded(row, accounts);
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
      if (row.accounts.length < accounts) {
        // Keep WHY. farmFreshAccounts hands back skipped:[{username, reason}]
        // with the real error behind each rejected account; recording only the
        // count is what made order 4b20765f undiagnosable.
        const alert = farmAlert.shouldAlert(row);
        row.state = "failed";
        row.lastError = farmAlert.shortfallMessage(
          { added: row.accounts, skipped: (res && res.skipped) || [] },
          accounts,
        );
        await row.save();
        if (alert) {
          await farmAlert.alertFarmFailure({
            market: MARKET,
            orderId,
            offerTitle: row.offerTitle || parsed.title || "",
            game: parsed.game,
            days: parsed.days,
            qty: accounts,
            buyerUsername: row.buyerUsername || "",
            reason: row.lastError,
            logins: farmHandover.loginsOf(row),
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
            qty: accounts,
            buyerUsername: row.buyerUsername || "",
            reason: row.lastError,
            logins: farmHandover.loginsOf(row),
          });
        }
        return { orderId, farm: true, error: row.lastError };
      }
      // G2G wants the seller to open the delivery details first; both
      // transitions are idempotent enough to re-run.
      await mp.g2gStartDeliver(orderId).catch(() => {});
      await mp.g2gMarkDelivering(orderId).catch(() => {});
      // The window counts from this hand-over; the date in the text is pinned
      // at the first attempt so a retry sends the same body (utils/farmHandover).
      const until = await farmHandover.pinUntil(row, parsed.days);
      const message = farmMessage(creds, parsed, { until });
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
        // The text the operator pastes names `until`: the ledger must end no
        // earlier than that, whenever the paste happens (never moved earlier).
        await farmHandover
          .stampFromHandover(row, until)
          .catch((err) => console.error("g2g farm " + orderId + ": window re-stamp failed:", err.message));
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
      await farmHandover
        .stampFromHandover(row, farmHandover.handoverStamp(until, parsed.days))
        .catch((e) => console.error("g2g farm " + orderId + ": window re-stamp failed:", e.message));
      await row.save();
    }

    // 3. Only now is the order delivered — if G2G will take the count. The
    // count is `qty`, in G2G's units: a pack delivered is ONE (PACKS-2 §2).
    const confirm = await confirmFarmOnG2g(row, orderId, qty);
    if (!confirm.confirmed) {
      return {
        orderId,
        farm: true,
        sent: qty,
        awaitingConfirm: true,
        detail:
          parsed.game + " / " + parsed.days + "d — the account IS in the " +
          "buyer's chat, but G2G refused the delivered count (" +
          confirm.reason + ")",
      };
    }
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
    // After the login reached the buyer only the confirmation can have failed:
    // the row stays "sent" and the page says so (utils/farmHandover).
    const sent = !!row.messageSentAt;
    if (sent) {
      farmHandover.sentButUnconfirmed(row, MARKET, e);
    } else {
      row.state = "failed";
      row.lastError = String(e.message || e).slice(0, 400);
    }
    await row.save().catch(() => {});
    if (alertErr) {
      await farmAlert.alertFarmFailure({
        market: MARKET,
        orderId,
        offerTitle: row.offerTitle || (parsed && parsed.title) || "",
        game: (parsed && parsed.game) || row.game || "",
        days: (parsed && parsed.days) || row.days || 0,
        qty: accounts,
        buyerUsername: row.buyerUsername || "",
        reason: row.lastError,
        logins: farmHandover.loginsOf(row),
        sent,
      });
    }
    return { orderId, farm: true, error: row.lastError, ...(sent ? { sent: true } : {}) };
  }
}

module.exports = {
  FARM_TITLE,
  farmOrderKey,
  parseFarmOrder,
  credentialsFor,
  farmMessage,
  confirmFarmOnG2g,
  closeConfirmedFarmOrders,
  deliverFarmOrder,
};
