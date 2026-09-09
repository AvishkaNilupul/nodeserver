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
const farmAlert = require("./farmServiceAlert");
const provisioning = require("./farmProvisioning");

// Which marketplace this service speaks for, used in failure alerts.
const MARKET = "playerauctions";
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

// --- How many ACCOUNTS does this order actually owe? ----------------------
//
// PlayerAuctions does NOT send a unit count. Measured against the live API on
// 2026-09-09: `purchaseQuantity` is absent from every order, in the list AND in
// the detail, so `parseInt(undefined, 10) || 1` made this ALWAYS 1.
//
// Always-1 is safe against over-provisioning and wrong the other way. Order
// 16418573 — "Overwatch Twitch Drops Automatic farming", $16.00 paid, quantity
// "200 Other Skins" — is TWO units of an $8 offer. It was hand-delivered before
// this path existed; under auto-delivery that buyer would have paid for two
// farming accounts and been handed one.
//
// The unit count lives on the OFFER, which the order links to:
//   order.detail.orderInfo.offerInfo.link  ".../<offerId>i!<slug>/"
//   offer.totalPrice       "$ 8.00"   price of ONE unit
//   offer.currencyPerUnit   100       ITEMS in one unit
// and the order carries both halves of the comparison:
//   orderInfo.price             "16.00"  total paid
//   orderInfo.purchased.amount   200     total items
//
// TWO INDEPENDENT DERIVATIONS THAT MUST AGREE before we provision more than one
// pristine account. Money alone can be fooled by a coupon or a fee; items alone
// by an offer whose currencyPerUnit was edited after the sale. Requiring both to
// land on the same integer means a wrong answer needs two independent failures.
// Anything else is one account plus an alert — never a guess, because each extra
// account is a pristine pool account spent for nothing.
function money(v) {
  const n = parseFloat(String(v == null ? "" : v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

// ".../overwatch-items/294684983i!overwatch-twitch-drops-26-items/" -> "294684983"
function offerIdFromLink(link) {
  const m = String(link || "").match(/\/(\d+)i!/);
  return m ? m[1] : "";
}

// Our own live offers by id. A rent-farm order arrives a few times a day at
// most, and this is one page-walk for all of them, so a short cache keeps the
// hot path free of API calls without ever serving a stale price for long.
let offerCache = { at: 0, byId: new Map() };
const OFFER_CACHE_MS = 5 * 60e3;
const OFFER_PAGE = 50;
const OFFER_MAX_PAGES = 6;
async function liveOffersById() {
  if (offerCache.byId.size && Date.now() - offerCache.at < OFFER_CACHE_MS) {
    return offerCache.byId;
  }
  const byId = new Map();
  for (let page = 1; page <= OFFER_MAX_PAGES; page += 1) {
    const r = await mp.playerauctionsMyListings(page, OFFER_PAGE).catch(() => null);
    const items = (r && r.items) || [];
    for (const o of items) byId.set(String(o.offerId), o);
    if (items.length < OFFER_PAGE) break;
  }
  // Only cache a result that read something; caching an empty page-walk after a
  // transient API failure would pin every later order to qty 1 for five minutes.
  if (byId.size) offerCache = { at: Date.now(), byId };
  return byId;
}

// Returns { qty, why, suspect }. `suspect` means the evidence points ABOVE one
// but could not be proved — the operator is told rather than the pool spent.
async function farmQuantity(order) {
  const explicit = parseInt(order && order.purchaseQuantity, 10);
  if (Number.isFinite(explicit) && explicit > 0) {
    return { qty: explicit, why: "the order stated purchaseQuantity=" + explicit };
  }

  const oi = (order && order.detail && order.detail.orderInfo) || {};
  const paid = money(oi.price);
  const items = Number((oi.purchased || {}).amount) || 0;
  const offerId = offerIdFromLink(oi.offerInfo && oi.offerInfo.link);
  if (!offerId) {
    return { qty: 1, why: "the order carries no offer link, so no unit price to divide by" };
  }

  const offer = (await liveOffersById()).get(String(offerId));
  if (!offer) {
    // PlayerAuctions implements an update as cancel + create, so the offer a
    // paid order points at can genuinely be gone. Not a reason to guess.
    return {
      qty: 1,
      suspect: items > 1,
      why: "offer " + offerId + " is no longer among our live offers, so its unit price could not be read",
    };
  }

  const unit = money(offer.totalPrice);
  const perUnit = Number(offer.currencyPerUnit) || 0;
  const byMoney = unit > 0 && paid > 0 ? paid / unit : 0;
  const byItems = perUnit > 0 && items > 0 ? items / perUnit : 0;
  const nMoney = Math.round(byMoney);
  // Within a cent per unit of a whole multiple; item counts are integers so they
  // must divide exactly.
  const moneyOk = byMoney > 0 && Math.abs(byMoney - nMoney) * unit < 0.01;
  const itemsOk = byItems > 0 && Number.isInteger(byItems);
  const evidence =
    "$" + paid.toFixed(2) + " / $" + unit.toFixed(2) + " = " +
    (byMoney ? byMoney.toFixed(3) : "?") + ", " + items + " items / " + perUnit +
    " per unit = " + (byItems ? byItems.toFixed(3) : "?");

  if (moneyOk && itemsOk && nMoney === byItems) {
    if (nMoney >= 2) return { qty: nMoney, why: "both agree on " + nMoney + " units (" + evidence + ")" };
    return { qty: 1, why: "both agree on a single unit (" + evidence + ")" };
  }
  if (nMoney >= 2 || byItems >= 2) {
    return {
      qty: 1,
      suspect: true,
      why: "this looks like more than one unit but the two measures disagree (" + evidence + ")",
    };
  }
  return { qty: 1, why: "single unit (" + evidence + ")" };
}

// Fulfil one rent-farm order. Returns null when the order is not a rent-farm
// order at all, so the caller can fall through to the bundle path.
async function deliverFarmOrder(order, { dryRun } = {}) {
  const parsed = await parseFarmOrder(order);
  if (!parsed) return null;

  const rawOrderId = String((order && (order.orderId || order.id)) || "");
  const orderId = rawOrderId;
  const key = farmOrderKey(rawOrderId);
  const units = await farmQuantity(order);
  const qty = units.qty;

  // A title we cannot read is still a PAID order.
  //
  // These two checks used to return here, ABOVE the FarmServiceOrder claim — so
  // an unreadable order created no row, and with no row there was no
  // farmServiceAlert, nothing for the `orders.undelivered` health check to
  // count, and nothing in the audit log. The whole event was one console.error
  // per tick in pm2 stdout while the buyer waited out the delivery guarantee.
  // The fulfiller only pages on `skipped`, and this returns `error`.
  //
  // The order is claimed FIRST now and the refusal is recorded ON the row, which
  // makes it visible, alertable and de-duplicated by the same `attempts` counter
  // every other failure uses. The refusal itself is unchanged: guessing a game
  // or a term would provision the wrong thing.
  const unreadable = !parsed.days
    ? 'could not read a farming term from "' + parsed.title + '"'
    : !parsed.game
      ? 'the farm does not know a game called "' + parsed.rawGame + '" — ' +
        "add an alias in utils/playerauctionsFarmService before this can " +
        "auto-deliver"
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

  // A multi-unit order we could not PROVE is delivered as one account, because
  // spending a pristine account on a guess is the expensive mistake. But it must
  // never be silent: the buyer paid for something we are not shipping, and only a
  // human can settle it. Fired once, on the first attempt, not on every retry.
  if (units.suspect && row.attempts === 1) {
    await farmAlert
      .alertFarmFailure({
        market: MARKET,
        orderId,
        offerTitle: parsed.title,
        game: parsed.game,
        days: parsed.days,
        qty: 1,
        buyerUsername: (order && order.name) || "",
        reason:
          "CHECK THE UNIT COUNT BY HAND — delivering 1 account. " + units.why,
      })
      .catch(() => {});
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
            actor: "playerauctions-order:" + orderId,
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

    // 2. Hand over, unless a previous attempt already did. A large order can
    //    need several messages; all of them must land before step 3.
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
  termToDays,
  canonicalGame,
  knownFarmGames,
  parseFarmOrder,
  credentialsFor,
  deliverFarmOrder,
  // Exported for tests: the unit-count derivation is the part that decides how
  // many pristine pool accounts an order spends.
  farmQuantity,
  offerIdFromLink,
  money,
};
