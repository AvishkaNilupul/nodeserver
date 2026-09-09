// Eldorado rent-farm fulfilment: the "<Game> Twitch Drops Automatic Farming
// <term>" listings.
//
// This is a DIFFERENT product from the drops-bundle listings. A bundle hands
// over a finished account whose drops are already sitting unclaimed. A rent-farm
// order sells a WINDOW: the buyer gets a pristine Twitch account that our farm
// keeps running for them for 120 / 180 / 365 days, claiming every drop as events
// go live. So fulfilling one is not "pick stock off a shelf" — it provisions a
// pool account into the farm with a deadline attached.
//
// The heavy lifting is utils/operatorFarm.farmFreshAccounts(), which already
// claims a pristine pool account, pins it to one game, stamps RenterAccount
// .farmUntil and lets utils/renterExpiry tear it down on the last day. Nothing
// here re-implements any of that.
//
// WHY EVERY ORDER GETS A ROW FIRST
// Each order burns pristine pool accounts, and the pool is small (~100). A retry
// that re-provisioned would silently spend it twice, so a FarmServiceOrder row
// is claimed on a unique orderId BEFORE anything is provisioned and each stage
// is stamped as it lands. A tick that dies half-way resumes; it never restarts.
const FarmServiceOrder = require("../models/FarmServiceOrder");
const AvailableAccount = require("../models/AvailableAccount");
const { decrypt } = require("./secretBox");
const operatorFarm = require("./operatorFarm");
const mp = require("./marketplaces");
const farmAlert = require("./farmServiceAlert");
const provisioning = require("./farmProvisioning");

// Which marketplace this service speaks for, used in failure alerts.
const MARKET = "eldorado";

// Our own naming convention, so this parse is a contract with ourselves:
//   "<Game> Twitch Drops Automatic Farming 120 Days"
//   "<Game> Twitch Drops Automatic farming 180 days"   (legacy casing)
//   "<Game> Twitch Drops Automatic Farming 1 Year"
const FARM_TITLE = /\bAutomatic\s+Farming\b/i;

function termToDays(title) {
  const t = String(title || "");
  const d = t.match(/(\d+)\s*days?\b/i);
  if (d) return parseInt(d[1], 10);
  if (/\b1\s*year\b/i.test(t)) return 365;
  const y = t.match(/(\d+)\s*years?\b/i);
  if (y) return parseInt(y[1], 10) * 365;
  const m = t.match(/(\d+)\s*months?\b/i);
  if (m) return parseInt(m[1], 10) * 30;
  return 0;
}

// Legacy titles predate the generated ones and carry storefront spellings the
// farm would not recognise as a game.
const GAME_ALIASES = {
  "tom clancy's rainbow six siege x": "Rainbow Six Siege",
  "tom clancy's rainbow six siege": "Rainbow Six Siege",
  "rainbow six siege x": "Rainbow Six Siege",
  "overwatch 2": "Overwatch",
};

function normGame(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}

// Resolve the title's game onto a name the farm actually knows. Returns "" when
// it cannot be resolved — the caller must refuse rather than deploy a bot
// pinned to a game string that matches no campaign.
async function canonicalGame(raw, knownGames) {
  const want = normGame(GAME_ALIASES[normGame(raw)] || raw);
  if (!want) return "";
  const hit = (knownGames || []).find((g) => normGame(g) === want);
  return hit || "";
}

// Games the farm has actually seen campaigns for, which is what a bot config's
// game pin has to match.
let gamesCache = { at: 0, list: [] };
async function knownFarmGames() {
  if (gamesCache.list.length && Date.now() - gamesCache.at < 30 * 60e3) {
    return gamesCache.list;
  }
  const AutoFarmTask = require("../models/AutoFarmTask");
  const CampaignDrops = require("../models/CampaignDrops");
  const a = await AutoFarmTask.distinct("game").catch(() => []);
  const b = await CampaignDrops.distinct("game").catch(() => []);
  const list = [...new Set([...(a || []), ...(b || [])].filter(Boolean))];
  if (list.length) gamesCache = { at: Date.now(), list };
  return list;
}

// Is this order one of ours, and what did the buyer actually buy?
// Returns null for anything that is not a rent-farm offer.
async function parseFarmOrder(order) {
  const title =
    (order && order.orderOfferDetails && order.orderOfferDetails.offerTitle) ||
    "";
  if (!FARM_TITLE.test(title)) return null;
  const days = termToDays(title);
  const rawGame = title.split(/\s+Twitch\s+Drops\b/i)[0].trim();
  const game = await canonicalGame(rawGame, await knownFarmGames());
  return { title, rawGame, game, days };
}

// The buyer-facing hand-over. Mirrors the copy the operator sends by hand: the
// credential, then the two things that actually matter (keep it linked, don't
// change it), then the feedback ask.
function farmDeliveryMessage(accounts, days, game) {
  const term = days === 365 ? "1 year" : days + " days";
  const forGame = game ? " for " + game : "";
  const blocks = accounts.map(
    (a, i) =>
      (accounts.length > 1
        ? "=== ACCOUNT " + (i + 1) + " of " + accounts.length + " ===\n"
        : "") +
      "Username: " + a.login + "\nPassword: " + a.password,
  );
  return (
    blocks.join("\n\n") +
    "\n\nYour " + term + " of automatic farming starts now.\n\n" +
    "KEEP THIS ACCOUNT LINKED to your game account. Our farm watches every " +
    "drop event" + forGame + " and claims the items automatically the moment " +
    "they unlock — you do not have to watch any streams or do anything at " +
    "all. New items will keep appearing on the account for the whole " + term +
    ", so just check back and claim them whenever you like.\n\n" +
    "Please do not change the account's password or email — the automatic " +
    "farming stops if you do, and that is not covered by a refund.\n\n" +
    "If our bot ever misses an item you can also claim it by hand at " +
    "https://www.twitch.tv/drops/inventory\n\n" +
    "Any problem at all, message me here first and I will sort it out. And if " +
    "you are happy with the order, leaving a feedback would genuinely mean a " +
    "lot — it helps a small seller more than you would think. Thank you!"
  );
}

// Read the pool passwords for accounts we just provisioned. Server-side only.
async function credentialsFor(added) {
  const out = [];
  for (const a of added || []) {
    const pool = await AvailableAccount.findById(a.poolId).lean();
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

// Fulfil one rent-farm order. Returns null when the order is not a rent-farm
// order at all, so the caller can fall through to the bundle path.
async function deliverFarmOrder(order, { dryRun } = {}) {
  const parsed = await parseFarmOrder(order);
  if (!parsed) return null;

  const orderId = String(order.id || "");
  const qty = Math.max(1, parseInt(order.purchaseQuantity, 10) || 1);

  // A title we cannot read is still a PAID order.
  //
  // These two checks used to return here, ABOVE the FarmServiceOrder claim — so
  // an unreadable order created no row, and with no row there was no
  // farmServiceAlert, nothing for the `orders.undelivered` health check to
  // count, and nothing in the audit log. The whole event was one console.error
  // per tick in pm2 stdout while the buyer waited out the delivery guarantee.
  //
  // The order is claimed FIRST now and the refusal is recorded ON the row, which
  // makes it visible, alertable and de-duplicated by the same `attempts` counter
  // every other failure uses. The refusal itself is unchanged: guessing a game
  // or a term would provision the wrong thing.
  const unreadable = !parsed.days
    ? 'could not read a farming term from "' + parsed.title + '"'
    : !parsed.game
      ? 'the farm does not know a game called "' + parsed.rawGame + '" — ' +
        "add an alias in utils/eldoradoFarmService before this can auto-deliver"
      : "";

  if (dryRun) {
    if (unreadable) return { orderId, farm: true, dryRun: true, error: unreadable };
    const avail = await operatorFarm.previewFreshAccounts({ count: qty });
    return {
      orderId,
      farm: true,
      dryRun: true,
      wouldProvision:
        qty +
        "x " +
        parsed.game +
        " for " +
        parsed.days +
        " days " +
        "(pool eligible: " +
        avail.eligibleTotal +
        ", would add: " +
        avail.willAdd +
        ")",
    };
  }

  // Claim the order. The unique index is what stops two ticks provisioning the
  // same order twice.
  let row = await FarmServiceOrder.findOne({ orderId });
  if (row && row.state === "delivered") {
    return { orderId, farm: true, skipped: "already delivered" };
  }
  if (!row) {
    try {
      row = await FarmServiceOrder.create({
        orderId,
        // Written explicitly, as g2gFarmService, gameflipFarmService and
        // playerauctionsFarmService all do. This was the one service relying on
        // the schema default, and a row created before that default existed
        // carries no `market` at all — invisible in every per-market view,
        // because a Mongoose default applies at creation from the schema of the
        // day, never retroactively. One live row (Escape from Tarkov, delivered
        // 2026-09-06) was in exactly that state.
        market: MARKET,
        offerId: String(order.offerId || ""),
        offerTitle: parsed.title,
        buyerUsername: order.buyerUsername || "",
        game: parsed.game,
        days: parsed.days,
        quantity: qty,
      });
    } catch (e) {
      // Lost the race to another tick — let that one finish.
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
            actor: "eldorado-order:" + orderId,
          })
        : { added: [] };
      const added = res && res.added ? res.added : [];
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
      const missing = creds.filter((c) => !c.login || !c.password);
      if (missing.length) {
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
      await mp.eldoradoSendOrderMessage(
        order,
        farmDeliveryMessage(creds, parsed.days, parsed.game),
      );
      row.messageSentAt = new Date();
      row.state = "sent";
      await row.save();
    }

    // 3. Only now is the order delivered.
    await mp.eldoradoMarkDelivered(orderId);
    row.deliveredAt = new Date();
    row.state = "delivered";
    row.lastError = "";
    await row.save();
    return {
      orderId,
      farm: true,
      delivered: qty,
      detail:
        parsed.game +
        " / " +
        parsed.days +
        "d / " +
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
  termToDays,
  canonicalGame,
  knownFarmGames,
  parseFarmOrder,
  farmDeliveryMessage,
  deliverFarmOrder,
};
