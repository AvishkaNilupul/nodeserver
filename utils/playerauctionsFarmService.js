// PlayerAuctions rent-farm fulfilment: the "<Game> Twitch Drops Automatic
// Farming <term>" listings.
//
// A DIFFERENT product from the drops-bundle listings. A bundle hands over a
// finished account whose drops are already sitting unclaimed. A rent-farm order
// sells a WINDOW: the buyer gets a pristine Twitch account that our farm keeps
// running for them for 120 / 180 / 365 days, claiming every drop as events go
// live. Fulfilling one provisions a pool account with a deadline attached; it
// is not "pick stock off a shelf".
//
// The heavy lifting is utils/operatorFarm.farmFreshAccounts(), which claims a
// pristine pool account, pins it to one game, stamps RenterAccount.farmUntil and
// lets utils/renterExpiry tear it down on the last day. Nothing here
// re-implements any of that, and the term always comes from the OFFER TITLE —
// the title is the contract the buyer agreed to, so a title we cannot parse is
// refused rather than guessed at.
//
// Every order gets a FarmServiceOrder row claimed on a unique id BEFORE
// anything is provisioned, because each order burns pristine pool accounts and
// the pool is small (~100). A retry that re-provisioned would spend it twice.
const FarmServiceOrder = require("../models/FarmServiceOrder");
const AvailableAccount = require("../models/AvailableAccount");
const { decrypt } = require("./secretBox");
const operatorFarm = require("./operatorFarm");
const mp = require("./marketplaces");
const copy = require("./playerauctionsCopy");
const proof = require("./playerauctionsProof");

// Our own naming convention, so this parse is a contract with ourselves:
//   "<Game> Twitch Drops Automatic Farming 120 Days"
//   "<Game> Twitch Drops Automatic farming 180 days"   (legacy casing, live on
//                                                       the account right now)
//   "<Game> Twitch Drops Automatic Farming 1 Year"
const FARM_TITLE = /\bAutomatic\s+Farming\b/i;

// PlayerAuctions order ids are plain integers while Eldorado's are UUIDs, and
// both share the FarmServiceOrder collection. Namespacing keeps them apart for
// good rather than relying on the two id spaces never meeting.
function farmOrderKey(orderId) {
  return "pa:" + String(orderId);
}

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

// Storefront spellings the farm would not recognise as a game. PlayerAuctions'
// own catalogue names are long ("Call of Duty - Warzone / BO7 & All Legacy
// Versions"), so these matter more here than on other marketplaces.
const GAME_ALIASES = {
  "tom clancys rainbow six siege": "Rainbow Six Siege",
  "tom clancy's rainbow six siege": "Rainbow Six Siege",
  "tom clancy's rainbow six siege x": "Rainbow Six Siege",
  "rainbow six siege x": "Rainbow Six Siege",
  "overwatch 2": "Overwatch",
  "call of duty - warzone / bo7 & all legacy versions": "Call of Duty",
  "escape from tarkov": "Escape from Tarkov",
  fortnight: "Fortnite",
};

function normBase(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Diacritics, not casing, are the hazard here. PlayerAuctions rejects titles
// that are not plain ASCII, so the catalogue's "Pok\u00e9mon GO" cannot go up
// verbatim -- and stripping the accent naively turned it into a name the farm
// could no longer recognise. Two normalisations cover every spelling that can
// reach us:
//   normGame          folds \u00e9 -> e   ("pokemon go") -- correct ASCII titles
//   normGameStripped  drops \u00e9 entirely ("pokmon go") -- titles published by
//                                            the older sanitiser, still live
// A name matches if EITHER normalisation agrees, so old and new offers both
// resolve without having to republish anything.
function normGame(s) {
  return normBase(
    String(s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, ""),
  );
}

function normGameStripped(s) {
  return normBase(String(s || "").replace(/[^\x00-\x7F]/g, ""));
}

async function canonicalGame(raw, knownGames) {
  const key = String(raw || "").toLowerCase().trim();
  const alias = GAME_ALIASES[key] || GAME_ALIASES[normGame(raw)] || raw;
  const want = normGame(alias);
  const wantStripped = normGameStripped(alias);
  if (!want) return "";
  const games = knownGames || [];
  const hit = games.find(
    (g) => normGame(g) === want || normGameStripped(g) === wantStripped,
  );
  if (hit) return hit;
  // "Call of Duty: Modern Warfare 4" should still reach the farm's "Call of
  // Duty"; a short fragment must not match half the catalogue.
  if (want.length >= 6) {
    return (
      games.find((g) => want.startsWith(normGame(g))) ||
      games.find((g) => normGame(g).startsWith(want)) ||
      games.find((g) => wantStripped.startsWith(normGameStripped(g))) ||
      games.find((g) => normGameStripped(g).startsWith(wantStripped)) ||
      ""
    );
  }
  return "";
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
  const title = String((order && order.orderTitle) || "");
  if (!FARM_TITLE.test(title)) return null;
  const days = termToDays(title);
  const rawGame = title.split(/\s+Twitch\s+Drops\b/i)[0].trim();
  const game = await canonicalGame(rawGame, await knownFarmGames());
  return { title, rawGame, game, days };
}

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

  const rawOrderId = String((order && (order.orderId || order.id)) || "");
  const orderId = rawOrderId;
  const key = farmOrderKey(rawOrderId);
  const qty = Math.max(1, parseInt(order && order.purchaseQuantity, 10) || 1);

  if (!parsed.days) {
    return {
      orderId,
      farm: true,
      error: 'could not read a farming term from "' + parsed.title + '"',
    };
  }
  if (!parsed.game) {
    return {
      orderId,
      farm: true,
      error:
        'the farm does not know a game called "' + parsed.rawGame + '" — ' +
        "add an alias in utils/playerauctionsFarmService before this can " +
        "auto-deliver",
    };
  }

  if (dryRun) {
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
        market: "playerauctions",
        offerId: String((order && order.offerId) || ""),
        offerTitle: parsed.title,
        buyerUsername: (order && order.name) || "",
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

  try {
    // 1. Provision, unless a previous attempt already did.
    if (!row.provisionedAt) {
      const res = await operatorFarm.farmFreshAccounts({
        game: parsed.game,
        days: parsed.days,
        count: qty,
        actor: "playerauctions-order:" + orderId,
      });
      const added = res && res.added ? res.added : [];
      if (added.length < qty) {
        // Whatever was taken stays attached to the order rather than being
        // stranded; the next tick tops it up.
        row.accounts = added.map((a) => ({
          login: a.login,
          poolId: a.poolId,
          farmUntil: null,
        }));
        row.state = "failed";
        row.lastError =
          "only " + added.length + " of " + qty +
          " pristine pool accounts could be provisioned";
        await row.save();
        return { orderId, farm: true, error: row.lastError };
      }
      row.accounts = added.map((a) => ({
        login: a.login,
        poolId: a.poolId,
        farmUntil: new Date(Date.now() + parsed.days * 86400000),
      }));
      row.provisionedAt = new Date();
      row.state = "provisioned";
      await row.save();
    }

    // 2. Hand over, unless a previous attempt already did. A large order can
    //    need several messages; all of them must land before step 3.
    if (!row.messageSentAt) {
      const creds = await credentialsFor(row.accounts);
      if (creds.some((c) => !c.login || !c.password)) {
        row.state = "failed";
        row.lastError = "a provisioned account has no readable password";
        await row.save();
        return { orderId, farm: true, error: row.lastError };
      }
      const messages = copy.deliveryMessages(creds, {
        kind: "farm",
        days: parsed.days,
        game: parsed.game,
      });
      for (const m of messages) {
        await mp.playerauctionsSendOrderMessage(orderId, m);
      }
      row.messageSentAt = new Date();
      row.state = "sent";
      await row.save();
    }

    // 3. Only now is the order delivered. Confirming needs proof images while
    //    the account sits at seller level 0.
    let img = null;
    try {
      img = await proof.buildDeliveryProof({
        orderId,
        offerTitle: parsed.title,
        accountCount: row.accounts.length,
      });
      await mp.playerauctionsMarkDelivered(orderId, [img]);
    } finally {
      await proof.cleanupProof(img);
    }
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
    row.state = "failed";
    row.lastError = String(e.message || e).slice(0, 400);
    await row.save().catch(() => {});
    return { orderId, farm: true, error: row.lastError };
  }
}

module.exports = {
  FARM_TITLE,
  farmOrderKey,
  termToDays,
  canonicalGame,
  knownFarmGames,
  parseFarmOrder,
  credentialsFor,
  deliverFarmOrder,
};
