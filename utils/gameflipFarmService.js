// Gameflip rent-farm: the PRE-PROVISIONED BUFFER.
//
// Eldorado, PlayerAuctions and G2G expose an order API, so their farm services
// wait for a paid order and provision an account into it at that moment
// (utils/eldoradoFarmService.js and its two siblings). Gameflip has no
// post-sale hook at all: the account is baked into the listing as an
// auto-delivered digital code and handed to the buyer the instant they pay.
// There is nothing to provision INTO. That is why the five original Gameflip
// "Automatic Farming" offers had to be taken down — on sale they fell through
// to the ordinary stock fulfiller and failed "Out of stock — no unsold account
// holds this whole bundle" (docs/SYSTEM-HEALTH-CONTRACT.md PART A).
//
// So the account is claimed BEFORE the sale and parked behind a live offer:
//   topUpBuffer()    fill the buffer to target, never below the slot reserve
//   onBufferedSale() a buffered offer sold: start the buyer's window, record it
//   releaseBuffered()an unsold offer came down: hand that ONE account back
//   bufferState()    what the tracker renders, including what is MISSING and WHY
//
// THE TWO RULES THAT DECIDE WHETHER THIS FILE IS CORRECT
//
// 1. `farmUntil` is stamped ON SALE, never at publish. A buffered offer is
//    provisioned with BUFFER_WINDOW_DAYS (365) purely because
//    operatorFarm.farmFreshAccounts refuses a non-positive window ("A positive
//    farming window in days is required." — utils/operatorFarm.js:263), and it
//    is right to refuse: every other caller of it is filling a real order. On
//    sale the window is RE-STAMPED to now + rentFarmDays, which for 120 and 180
//    day terms moves it DOWN. Moving it down is the whole point — see the
//    comment on restampWindow().
//
// 2. The reserve floor beats the target. Every LIVE buffered offer holds one
//    rental slot continuously, not one per sale, and the same slots are what
//    fills a PAID on-demand order on the other three marketplaces. Losing that
//    race is not theoretical: order 4b20765f was shipped by hand and the buyer
//    on e69b19d3 cancelled after 25 failed attempts, both because the stacks
//    were full. So free slots are re-read before EVERY publish, not once per
//    pass, and below the floor this stops, says why, and alerts.
//
// Contract: docs/GAMEFLIP-RENT-FARM-CONTRACT.md (frozen 2026-09-09).
const AvailableAccount = require("../models/AvailableAccount");
const FarmServiceOrder = require("../models/FarmServiceOrder");
const MarketplaceListing = require("../models/MarketplaceListing");
const Renter = require("../models/Renter");
const RenterAccount = require("../models/RenterAccount");

const hosts = require("./botHosts");
const mp = require("./marketplaces");
const operatorFarm = require("./operatorFarm");
const rentFarmCapacity = require("./rentFarmCapacity");
const settings = require("./settings");
const farmAlert = require("./farmServiceAlert");
const { decrypt } = require("./secretBox");
const { recordPoolUsage } = require("./poolUsageLog");
const { logEvent } = require("./systemLog");
const { buildPromoCoverImage } = require("./setImage");
const fsp = require("fs/promises");

// Which marketplace this service speaks for, used in failure alerts and as the
// FarmServiceOrder.market value.
const MARKET = "gameflip";

// How long one pass holds a buffered sale before another may retry it. Long
// enough to outlast the two DB round trips the sale makes, short enough that a
// process killed mid-sale is retried within the hour rather than never.
const SALE_LEASE_MS = 10 * 60 * 1000;

// The placeholder window a BUFFERED account farms on while its offer sits
// unsold. Long on purpose: while nobody has bought anything, `farmUntil` means
// "how long WE keep farming this", not a buyer's entitlement, and the failure
// that would actually matter is renterExpiry tearing the account out of the
// config while its offer is still live and purchasable — a live offer that
// sells a dead account.
const BUFFER_WINDOW_DAYS = 365;

// Ceiling and floor. The target is how many offers we WANT live; the reserve is
// how many free rental slots must remain for paid on-demand orders elsewhere.
// The floor wins. Both are overridable from settings (`autoFarm`) so they move
// without a deploy — measured 2026-09-09: 200 slots, 137 free.
const GF_BUFFER_TARGET = 100;
const RENT_SLOT_RESERVE = 40;

// How many offers one pass may publish. Gameflip's rate limiter is silent — it
// answers 200 to a status patch and leaves the listing "ready", public but NOT
// purchasable (see gameflipPublish) — so a hundred publishes in one tick is
// exactly how a pass produces a pile of unbuyable listings.
const GF_BUFFER_PER_PASS = 5;

// The ladder, frozen by the contract. Gameflip is priced ABOVE Eldorado
// ($3/$4/$7) deliberately: the only hard evidence of Gameflip rent-farm demand
// is a Rocket League 180-day offer that SOLD at $5.00 while Eldorado's
// equivalent asked $4.00, and this codebase's standing rule is that our own
// realised price is proof while a rival's asking price is not
// ([[project_market_intelligence]]).
const TERMS = [
  { days: 120, label: "120 Days", priceUsd: 4 },
  { days: 180, label: "180 Days", priceUsd: 5 },
  { days: 365, label: "1 Year", priceUsd: 8 },
];

// Twitch-native stream gimmicks and non-games: farmable, but nobody buys a
// farming service for them and they pad the shop. Copied verbatim from
// scripts/eldorado-farm-listings.js so the two catalogues cannot disagree about
// what counts as a game.
const DENY_GAME =
  /marbles on stream|hunt club on stream|special events|coin pusher|coin cascade|marble racing|zevent|^test|drops? test/i;

// How far back a game must have been farmed to earn a place in the catalogue.
// Same window the Eldorado publisher uses, for the same reason: an offer for a
// game the farm has not touched in three months is an offer we cannot honour
// well.
const CATALOGUE_DAYS_BACK = 90;

// Ceiling on the buffered rows one pass will read back. Bounded because this
// runs on a bytes-bound Atlas shared tier; sorted because an unsorted `.limit()`
// is the bug that hid 35 Gameflip listings from the watcher for months (see
// utils/gameflipFulfiller.syncOnce) — with a sort, a truncation drops the
// NEWEST rows and `truncated` says so out loud.
const MAX_BUFFER_ROWS = 400;

// Lazy requires: these live on the renter-admin / bot-config routers, exactly as
// utils/operatorFarm.js takes them, so module load order stays irrelevant and no
// circular require can bite at boot.
function botConfig() {
  return require("../routes/botConfigRoutes");
}

const slotKey = (game, days) =>
  String(game || "").trim().toLowerCase() + "|" + (Number(days) || 0);

// ------------------------------------------------------------------
// Settings. Every knob is read through settings.getAutoFarm(), like every
// other service reads its flags, so one settings.json edit changes behaviour on
// a live host without a deploy.
// ------------------------------------------------------------------
function config() {
  const af = settings.getAutoFarm() || {};
  const num = (v, dflt) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  return {
    af,
    // OFF by default. A new subsystem that publishes real listings against real
    // pool accounts does not turn itself on because it was deployed.
    enabled: !!af.gameflipRentFarm,
    target: num(af.gfBufferTarget, GF_BUFFER_TARGET),
    reserve: num(af.gfRentSlotReserve, RENT_SLOT_RESERVE),
    perPass: Math.max(1, num(af.gfBufferPerPass, GF_BUFFER_PER_PASS)),
    // An explicit game list pins the catalogue to exactly what is live on
    // Eldorado without waiting for the AutoFarmTask window to agree.
    games: Array.isArray(af.gfRentFarmGames)
      ? af.gfRentFarmGames.map((g) => String(g || "").trim()).filter(Boolean)
      : [],
  };
}

// ------------------------------------------------------------------
// The catalogue: 29 games x 3 terms, mirroring what is live on Eldorado.
// ------------------------------------------------------------------

// `distinct` and not an aggregation on purpose: it returns one short string per
// game instead of a document per task, and on this Atlas shared tier the bound
// that actually bites is BYTES RETURNED ([[project_drop_archive_performance]]).
async function catalogueGames() {
  const cfg = config();
  if (cfg.games.length) return cfg.games.slice();
  const AutoFarmTask = require("../models/AutoFarmTask");
  const since = new Date(Date.now() - CATALOGUE_DAYS_BACK * 86400000);
  const raw = await AutoFarmTask.distinct("game", {
    updatedAt: { $gte: since },
  }).catch(() => []);
  const seen = new Set();
  const out = [];
  for (const g of raw || []) {
    const name = String(g || "").trim();
    if (!name || DENY_GAME.test(name)) continue;
    const k = name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(name);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

// Every (game, term) we want live, capped by the target. Game-major, so a
// catalogue larger than the target yields COMPLETE games rather than a shop
// where two thirds of the games are missing their 1-year offer. `truncated`
// travels with it so the tracker can say the cap was reached instead of
// implying the catalogue is simply that size.
async function desiredCatalogue() {
  const cfg = config();
  const games = await catalogueGames();
  const all = [];
  for (const game of games) {
    for (const t of TERMS) {
      all.push({
        game,
        days: t.days,
        label: t.label,
        priceUsd: t.priceUsd,
        key: slotKey(game, t.days),
      });
    }
  }
  return {
    games,
    terms: TERMS,
    target: cfg.target,
    total: all.length,
    truncated: all.length > cfg.target,
    wanted: all.slice(0, cfg.target),
  };
}

// ------------------------------------------------------------------
// Listing copy. The game name and the term are substituted from ONE tier
// object, in the title AND in the description, because they drifting apart is
// not cosmetic: a live R6 offer once sold a 180-day term while its description
// promised 120 days, which is a dispute with a paying buyer waiting to happen
// (scripts/eldorado-farm-listings.js says the same thing for the same reason).
// ------------------------------------------------------------------
function offerTitle(game, term) {
  return (game + " Twitch Drops Automatic Farming " + term.label).slice(0, 120);
}

function offerDescription(game, term) {
  return (
    "Automatic Farm on our Twitch for the game " + game + "\n\n" +
    "Activation & Timing: After purchasing, link the received account to your " +
    "own and start receiving new Drops every day. Farming begins the moment " +
    "you purchase — the " + term.days + " days are counted from your purchase, " +
    "not from when this offer was listed.\n\n" +
    "Manual Pickup: If our program does not activate any of the items, you can " +
    "pick up the items manually at https://www.twitch.tv/drops/inventory\n\n" +
    "Bot Guarantee: We guarantee that you will receive an automatic farm " +
    "account, and all events during this period will be automatically " +
    "collected by our bot within the specified period [" + term.days +
    " days].\n\n" +
    "Account Status: The account provided to you may already include some " +
    "items on the Twitch account.\n\n" +
    "Exclusivity: Each Twitch account is transferred strictly to one buyer.\n\n" +
    "Important Warning: Do not change any data on the account you received, " +
    "otherwise the automatic farm will stop working, and in this case you will " +
    "not receive a refund.\n\n" +
    "Event Restrictions: Items are guaranteed for events that last at least 24 " +
    "hours. If the event lasts less than that, we don't guarantee receipt. " +
    "Farming also only occurs if there are active events."
  );
}

// What Gameflip hands the buyer the instant they pay.
//
// This can honestly say "starts now" — unlike every other marketplace's
// hand-over copy, which is written some minutes after the sale — because
// Gameflip releases the code at the moment of payment, which is the same moment
// onBufferedSale re-stamps farmUntil. The two statements are the same event.
function bufferedDeliveryCode(login, password, days, game) {
  const term = days === 365 ? "1 year" : days + " days";
  return (
    "TWITCH DROPS AUTOMATIC FARMING — " + game + "\n\n" +
    "Username: " + login + "\nPassword: " + password + "\n\n" +
    "Your " + term + " of automatic farming starts now.\n\n" +
    "KEEP THIS ACCOUNT LINKED to your game account. Our farm watches every " +
    "drop event for " + game + " and claims the items automatically the moment " +
    "they unlock — you do not have to watch any streams. New items will keep " +
    "appearing on the account for the whole " + term + ", so check back and " +
    "claim them whenever you like at https://www.twitch.tv/drops/inventory\n\n" +
    "Please do not change the account's password or email — the automatic " +
    "farming stops if you do, and that is not covered by a refund.\n\n" +
    "Any problem at all, message me here on Gameflip first and I will sort it " +
    "out."
  );
}

// ------------------------------------------------------------------
// Capacity. Read-only.
// ------------------------------------------------------------------

// rentFarmCapacity.snapshot() reads the real bot configs off the hosts, which is
// the only number that has ever been right: the pool showed 554 eligible
// accounts and previewFreshAccounts answered willAdd:1 while the holder's stack
// sat at 10/10 and every order was failing.
//
// A read that FAILS returns ok:false and never a number. A rate-limited or
// unreadable answer is not evidence of a state — treating one as evidence is
// one of the four mistakes this codebase has already paid for — and the caller
// must refuse to publish rather than guess there is room.
async function freeSlots() {
  try {
    const snap = await rentFarmCapacity.snapshot();
    return {
      ok: true,
      totalFree: Number(snap.totalFree) || 0,
      totalCapacity: Number(snap.totalCapacity) || 0,
      readable: Number(snap.readable) || 0,
      // An offline host's stacks are not counted, so totalFree UNDERSTATES the
      // real room. Understating is the safe direction here (we publish less),
      // but the tracker must say it rather than show a shortfall as fact.
      offlineHosts: snap.offlineHosts || [],
    };
  } catch (e) {
    return {
      ok: false,
      totalFree: null,
      offlineHosts: [],
      error: String((e && e.message) || e).slice(0, 200),
    };
  }
}

// Would taking ONE more slot still leave the reserve intact?
function roomForOneMore(cap, reserve) {
  if (!cap || !cap.ok) return false;
  return cap.totalFree - 1 >= reserve;
}

// ------------------------------------------------------------------
// Why the last pass did not publish something.
//
// Deliberately in memory. A publish that failed leaves NO listing row to hang a
// reason on, and inventing a row for a listing that does not exist is precisely
// the leak the contract forbids (rule 4). Losing it on restart is acceptable
// because bufferState() recomputes the structural reasons — reserve floor, empty
// pool, service off — live, and says "no pass has run since restart" instead of
// showing an empty list that reads as "everything is fine".
// ------------------------------------------------------------------
let lastPass = { at: null, reasons: new Map(), stopped: "" };

function noteReason(key, reason) {
  lastPass.reasons.set(key, String(reason || "").slice(0, 300));
}

// Latch for the reserve-floor alert, mirroring rentFarmCapacity's lastLevel: a
// floor that holds for a day must not re-page every pass. It re-arms as soon as
// a pass publishes again, and on restart — a fresh reminder after a deploy is
// wanted, not noise.
let reserveAlerted = false;

// ------------------------------------------------------------------
// Pool credentials + handing an account back.
// ------------------------------------------------------------------

// Server-side only, same two fields utils/eldoradoFarmService.credentialsFor
// reads (a pool row's password moved to `credPasswordEnc` at some point and
// both spellings are live).
async function poolCredentials(poolId) {
  const pool = await AvailableAccount.findById(poolId, {
    username: 1,
    password: 1,
    credPasswordEnc: 1,
    clientSecret: 1,
  }).lean();
  if (!pool) return null;
  let password = "";
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
  return {
    poolId: String(pool._id),
    login: pool.username || "",
    clientSecret: pool.clientSecret || "",
    password,
  };
}

// Take ONE named account off the farm and return it to the pool.
//
// Ordered so a half-finished hand-back never leaves a ghost: the config entry
// goes first, and only an account that is genuinely off a bot is marked
// available again. The DELETE /renter-accounts/:id route refuses outright when
// the host is unreachable for this reason — "a ghost entry farming in the config
// with no matching inventory row" — and so does this.
// handBackToPool reports its most likely failures by RETURNING {ok:false}, not by
// throwing: the pool row is gone, the renter was re-homed, the host is unknown,
// or the bot host is mid-link-timeout (the Pi's link is seconds of RTT, so
// ETIMEDOUT here is routine). Every call site used to write
// `await handBackToPool(...).catch(() => {})`, which catches only a throw and
// silently discards exactly those returns.
//
// What that cost: the account stays AvailableAccount.status "claimed", stays in
// the bot config farming on its 365-day placeholder, keeps holding one of the
// rental slots the reserve exists to protect — and has NO MarketplaceListing row
// at all, because the publish it was claimed for failed. Nothing can find it
// again: `live`, `sold` and `stranded` in bufferState are all derived from
// listing rows. At day 365 renterExpiry pulls it off the bot without ever
// returning the pool row to "available", so the loss is permanent and silent.
//
// This wrapper makes a returned failure as loud as a thrown one: one pristine
// account and one rental slot are worth an alert.
async function handBackOrAlert(poolId, note, ctx = {}) {
  let out;
  try {
    out = await handBackToPool(poolId, note);
  } catch (e) {
    out = { ok: false, reason: String((e && e.message) || e).slice(0, 200) };
  }
  if (out && out.ok) return out;
  const reason = (out && out.reason) || "unknown";
  const detail =
    "pool account " + poolId + " could NOT be returned after " + note +
    " — it is still claimed, still on a bot and still holding a rental slot, " +
    "with no listing naming it: " + reason;
  console.error("gameflip rent-farm: " + detail);
  await farmAlert
    .alertFarmFailure({
      market: MARKET,
      orderId: ctx.orderId || "buffer:" + poolId,
      offerTitle: ctx.offerTitle || "",
      game: ctx.game || "",
      days: ctx.days || 0,
      qty: 1,
      reason: detail,
    })
    .catch(() => {});
  return out || { ok: false, reason };
}

async function handBackToPool(poolId, note) {
  const pool = await AvailableAccount.findById(poolId, {
    username: 1,
    clientSecret: 1,
    status: 1,
  }).lean();
  if (!pool) {
    return { ok: false, reason: "pool row " + poolId + " no longer exists" };
  }

  // Find the farming row by token — RenterAccount.clientSecret is globally
  // unique, so this is the account and not a namesake.
  const acct = pool.clientSecret
    ? await RenterAccount.findOne({ clientSecret: pool.clientSecret })
    : null;

  if (acct) {
    // NEVER pull an account out of a PAYING renter's bot because one of our
    // listings believes it owns it. The buffer only ever parks accounts on the
    // operator holder (operatorFarm's `operator-selffarm`); anything else means
    // the token was re-homed and a human has to look. Read-only lookup on
    // purpose — ensureOperatorRenter CREATES the holder, and a release path must
    // not create anything.
    const holder = await Renter.findOne(
      { usernameLower: operatorFarm.OPERATOR_USERNAME },
      { _id: 1 },
    ).lean();
    if (!holder || String(acct.renter) !== String(holder._id)) {
      return {
        ok: false,
        reason:
          "account " + (pool.username || poolId) + " is on renter " +
          String(acct.renter) + ", not the operator holder — refusing to " +
          "pull it off someone else's bot",
      };
    }
    if (acct.configFile) {
      const host = hosts.resolveHost(acct.host);
      if (!host) {
        return {
          ok: false,
          reason: "unknown host '" + acct.host + "' for " + acct.configFile,
        };
      }
      const { removeAccountFromConfig, restartConfigContainer, containerForFile } =
        botConfig();
      let removed = 0;
      try {
        removed = await removeAccountFromConfig(host, acct.configFile, {
          clientSecret: acct.clientSecret,
          login: acct.login,
        });
      } catch (e) {
        // Host offline. Leave EVERYTHING as it is and let the caller retry:
        // marking the pool row available now would advertise an account that is
        // still farming in a config as free stock.
        return {
          ok: false,
          reason:
            "could not pull " + (acct.login || pool.username) + " off " +
            acct.configFile + ": " + String((e && e.message) || e).slice(0, 160),
        };
      }
      if (removed) {
        try {
          const states = await hosts.dockerPs(host);
          const st = states[containerForFile(acct.configFile)];
          if (st && /^running/i.test(st.state || "")) {
            await restartConfigContainer(host, acct.configFile);
          }
        } catch {
          /* best effort: a bot that is not restarted picks the change up on its
             next restart, and the account is already out of the file */
        }
      }
    }
    await RenterAccount.deleteOne({ _id: acct._id }).catch(() => {});
  }

  // Scoped to a row we still hold. Releasing anything broader could clobber a
  // claim a concurrent move just took — movePoolAccountToRenter guards its own
  // rollback the same way.
  const back = await AvailableAccount.updateOne(
    { _id: poolId, status: "claimed" },
    { $set: { status: "available" }, $unset: { claimedAt: "", claimedNote: "" } },
  ).catch(() => null);
  const returned = !!(back && (back.modifiedCount || back.nModified));
  if (returned) {
    await recordPoolUsage(poolId, {
      event: "returned",
      actor: "gameflip-buffer",
      note: String(note || "").slice(0, 200),
    }).catch(() => {});
  }
  return { ok: true, returned, login: pool.username || "" };
}

// ------------------------------------------------------------------
// Creating the listing row.
// ------------------------------------------------------------------

// A rent-farm row has NO DropSet — it sells a window, not stock — but
// MarketplaceListing still marks `set` required for any row without an
// `unclaimedGame`, so `.create()` throws a ValidationError on a row that is
// entirely correct. Saving with validation off is the narrow way through: every
// value below is a literal written here, not user input, so there is nothing for
// the validator to catch, and the pre/post save hooks (the listing audit log)
// still run exactly as they do for .create().
//
// The alternative was setting `unclaimedGame` to satisfy the validator, and that
// would be actively wrong: `unclaimedGame` tells the Eldorado fulfiller and the
// stock sync to claim this row's stock out of the no-claim ledger, so a Gameflip
// rent-farm offer would start advertising and consuming unclaimed-farm accounts.
// Once models/MarketplaceListing relaxes `set` for `rentFarm` rows this should
// go back to a plain .create().
async function createBufferedRow(doc) {
  const row = new MarketplaceListing(doc);
  await row.save({ validateBeforeSave: false });
  return row;
}

// ------------------------------------------------------------------
// topUpBuffer
// ------------------------------------------------------------------

// Every live buffered row, keyed by (game, term).
async function liveBufferRows() {
  const rows = await MarketplaceListing.find(
    { marketplace: MARKET, rentFarm: true, status: "active" },
    {
      externalId: 1,
      url: 1,
      title: 1,
      price: 1,
      status: 1,
      accountLogin: 1,
      rentFarmGame: 1,
      rentFarmDays: 1,
      rentFarmPoolId: 1,
      createdAt: 1,
      lastError: 1,
    },
  )
    .sort({ createdAt: 1 })
    .limit(MAX_BUFFER_ROWS)
    .lean();
  return rows;
}

// Rows that are terminally dead on Gameflip and are STILL holding a pristine
// pool account. Nothing else will ever revisit them: the watcher only looks at
// `status: "active"`. A pristine account held by a listing that does not exist
// is the leak this codebase has hit repeatedly, and it is also a rental slot a
// paid order cannot have.
//
// ONLY these two states, and both are load-bearing:
//   "removed"  — the watcher retired it on a 404 / expired / cancelled, i.e.
//                Gameflip itself said the listing is gone;
//   "delisted" — written for a Gameflip row ONLY after gameflipDelist actually
//                succeeded. utils/listingDetach.js used to write it
//                unconditionally after a swallowed failure, which left offers
//                LIVE and selling credentials while our side recorded them as
//                down; that is fixed there, and this lane depends on the fix.
// Anything else — "active" above all — may still be purchasable, and handing an
// account back while a live offer still sells it is how the same credentials
// reach two people.
//
// `status` can never be "sold" here. That is the whole point of the guard: an
// account behind a SOLD offer belongs to a buyer.
async function strandedRows(limit) {
  return MarketplaceListing.find(
    {
      marketplace: MARKET,
      rentFarm: true,
      status: { $in: ["removed", "delisted"] },
      rentFarmPoolId: { $nin: ["", null] },
    },
    {
      externalId: 1,
      title: 1,
      status: 1,
      accountLogin: 1,
      // Projected because releaseBuffered REFUSES a row without it. A projection
      // that drops a field the consumer guards on turns a safety check into a
      // silent no-op — the reclaim would simply never fire.
      rentFarm: 1,
      rentFarmGame: 1,
      rentFarmDays: 1,
      rentFarmPoolId: 1,
      updatedAt: 1,
    },
  )
    .sort({ updatedAt: 1 })
    .limit(Math.max(1, limit))
    .lean();
}

// Tell the owner the buffer stopped filling. Uses the SHARED alert path rather
// than a private one: four copies of the same marketplace list had silently
// drifted apart once ([[reference_market_claim_tags]]) and one alerting habit is
// worth more than a perfectly worded second one. Its header says "order NOT
// delivered", so the ids below are written to make it unmistakable that no
// order is involved and nobody is waiting on a delivery.
async function alertBufferStopped(reason, detail) {
  await farmAlert
    .alertFarmFailure({
      market: MARKET,
      orderId: "buffer:" + reason,
      offerTitle: "Gameflip rent-farm BUFFER (no buyer order involved)",
      game: "",
      days: 0,
      qty: 0,
      reason: detail,
    })
    .catch(() => {});
}

// Fill the buffer, bounded, re-checking the floor before every publish.
async function topUpBuffer(opts = {}) {
  const cfg = config();
  // Dry unless explicitly told otherwise, the same way the Eldorado fulfiller
  // defaults (`eldoradoDeliverDryRun !== false`). A pass that publishes real
  // listings against real pool accounts should be an opt-in, not a default.
  const dryRun =
    opts.dryRun !== undefined
      ? !!opts.dryRun
      : cfg.af.gfBufferDryRun !== false;

  const out = {
    market: MARKET,
    dryRun,
    at: new Date(),
    live: 0,
    wanted: 0,
    published: 0,
    reclaimed: 0,
    stopped: "",
    shortfall: [],
    capacity: null,
  };

  if (!cfg.enabled) {
    out.stopped = "gameflipRentFarm off";
    return out;
  }
  if (!(mp.keyStatus().gameflip || {}).configured) {
    out.stopped = "gameflip not configured";
    return out;
  }

  lastPass = { at: new Date(), reasons: new Map(), stopped: "" };

  const [cat, live] = await Promise.all([desiredCatalogue(), liveBufferRows()]);
  out.live = live.length;
  out.wanted = cat.wanted.length;

  const haveKey = new Set(
    live.map((r) => slotKey(r.rentFarmGame, r.rentFarmDays)),
  );
  const missing = cat.wanted.filter((w) => !haveKey.has(w.key));
  if (!missing.length) {
    out.stopped = "buffer is full";
    reserveAlerted = false;
    return out;
  }

  // Reclaim first, and only then publish. A dead row holding an account is a
  // slot we already own; taking it back before asking the pool for a new one is
  // both cheaper and strictly safer than publishing into a tighter floor.
  if (!dryRun) {
    for (const row of await strandedRows(cfg.perPass)) {
      const r = await releaseBuffered(row, {
        reason: "offer is " + row.status + " — reclaiming the buffered account",
      }).catch((e) => ({ released: false, error: String(e.message || e) }));
      if (r && r.released) out.reclaimed++;
    }
  }

  const budget = Math.min(cfg.perPass, missing.length);
  for (let i = 0; i < budget; i++) {
    const want = missing[i];

    // THE FLOOR, RE-READ BEFORE EVERY SINGLE PUBLISH.
    //
    // Not once per pass: a publish spends tens of seconds inside gameflipPublish
    // (its rate-limit backoff waits 20s then 60s), and an Eldorado or
    // PlayerAuctions sale landing in that gap consumes slots we already counted.
    // Checking once and then publishing five times is how the buffer would win a
    // race against a paid order, which is the one thing it must never do.
    const cap = await freeSlots();
    out.capacity = cap;
    if (!cap.ok) {
      // An unreadable capacity answer is NOT evidence that there is room.
      out.stopped = "capacity unreadable: " + cap.error;
      lastPass.stopped = out.stopped;
      for (let j = i; j < missing.length; j++) {
        noteReason(missing[j].key, out.stopped);
        out.shortfall.push({ ...missing[j], reason: out.stopped });
      }
      await alertBufferStopped(
        "capacity-unreadable",
        "could not read rental stack capacity, so the buffer stopped rather " +
          "than guess there was room: " + cap.error,
      );
      break;
    }
    if (!roomForOneMore(cap, cfg.reserve)) {
      out.stopped =
        "reserve floor reached — " + cap.totalFree + " free slot(s), " +
        cfg.reserve + " reserved for paid on-demand orders" +
        (cap.offlineHosts.length
          ? " (host(s) offline and NOT counted: " +
            cap.offlineHosts.join(", ") + ")"
          : "");
      lastPass.stopped = out.stopped;
      for (let j = i; j < missing.length; j++) {
        noteReason(missing[j].key, out.stopped);
        out.shortfall.push({ ...missing[j], reason: out.stopped });
      }
      if (!reserveAlerted) {
        reserveAlerted = true;
        await alertBufferStopped(
          "reserve-floor",
          out.stopped + ". " + out.live + " buffered offer(s) live of " +
            cfg.target + " wanted; the buffer will shrink until slots free up.",
        );
      }
      break;
    }
    reserveAlerted = false;

    if (dryRun) {
      out.shortfall.push({
        ...want,
        reason:
          "dry run — would claim 1 pristine account and publish at $" +
          want.priceUsd + " (" + cap.totalFree + " free slot(s))",
      });
      continue;
    }

    const published = await publishOne(want, out);
    if (published === "stop") break;
  }

  return out;
}

// Publish ONE buffered offer. Returns "stop" when the failure means every
// remaining slot in this pass would fail the same way.
async function publishOne(want, out) {
  const term =
    TERMS.find((t) => t.days === want.days) || {
      days: want.days,
      label: want.days + " Days",
      priceUsd: want.priceUsd,
    };

  // 1. Claim ONE pristine pool account, with the PLACEHOLDER window.
  //
  // days: 0 is not on offer — farmFreshAccounts rejects any non-positive window
  // ("A positive farming window in days is required.") and is right to, because
  // every other caller of it is filling a real order. So the buffered account
  // gets BUFFER_WINDOW_DAYS and the buyer's real window is stamped on sale.
  let res;
  try {
    res = await operatorFarm.farmFreshAccounts({
      game: want.game,
      days: BUFFER_WINDOW_DAYS,
      count: 1,
      actor: "gameflip-buffer",
    });
  } catch (e) {
    const reason = String((e && e.message) || e).slice(0, 300);
    noteReason(want.key, reason);
    out.shortfall.push({ ...want, reason });
    // "No eligible pristine pool accounts" and "at its account limit" are facts
    // about the pool, not about this game: the next four slots in this pass
    // would fail identically and each attempt costs a full eligibility sweep.
    if (e && (e.status === 409 || /no eligible|account limit|stack/i.test(reason))) {
      out.stopped = reason;
      lastPass.stopped = reason;
      return "stop";
    }
    return "next";
  }

  const added = (res && res.added) || [];
  if (!added.length) {
    // Keep WHY: farmFreshAccounts hands back skipped:[{username, reason}] with
    // the real error behind each rejected account, and recording only the count
    // is what made order 4b20765f undiagnosable.
    const reason = farmAlert.shortfallMessage(res, 1);
    noteReason(want.key, reason);
    out.shortfall.push({ ...want, reason });
    return "next";
  }

  const poolId = String(added[0].poolId || "");
  const creds = await poolCredentials(poolId);
  if (!creds || !creds.login || !creds.password) {
    const reason =
      "claimed " + (added[0].login || poolId) +
      " but it has no readable password — cannot auto-deliver";
    await handBackOrAlert(poolId, "no readable password", {
      game: want && want.game,
      days: want && want.days,
    });
    noteReason(want.key, reason);
    out.shortfall.push({ ...want, reason });
    return "next";
  }

  // 2. Publish. gameflipPublish already verifies the onsale patch by reading the
  // status back and discards the draft when it settled on "ready" — the silent
  // rate-limiter trap — so there is nothing to re-verify here.
  const title = offerTitle(want.game, term);
  let cover = "";
  let r;
  try {
    try {
      cover = await buildPromoCoverImage({
        title: want.game + " Twitch Drops Automatic Farming",
        serviceText: term.label + " Service",
        bullets: [
          "Fully Automated Farming",
          "Account-Safe and Undetectable",
          "Reliable Daily Rewards",
        ],
        twitchTiles: true,
      });
    } catch {
      cover = "";
    }
    r = await mp.gameflipPublish({
      title,
      description: offerDescription(want.game, term),
      priceUsd: term.priceUsd,
      imagePath: cover,
      autoDeliverCode: bufferedDeliveryCode(
        creds.login,
        creds.password,
        term.days,
        want.game,
      ),
    });
  } catch (e) {
    // A failed publish hands the account straight back, in the same breath. A
    // pristine account held by a listing that does not exist is invisible: it is
    // out of the pool, holding a rental slot, farming for nobody.
    const reason = String((e && e.message) || e).slice(0, 300);
    await handBackOrAlert(poolId, "publish failed: " + reason, {
      game: want && want.game,
      days: want && want.days,
    });
    noteReason(want.key, reason);
    out.shortfall.push({ ...want, reason });
    return "next";
  } finally {
    if (cover) await fsp.unlink(cover).catch(() => {});
  }

  // 3. Record the row. It carries the pool id so a delist, expiry or 404 hands
  // back exactly THAT account and nothing broader.
  try {
    await createBufferedRow({
      marketplace: MARKET,
      externalId: r.externalId,
      url: r.url || "",
      title,
      description: offerDescription(want.game, term),
      price: term.priceUsd,
      status: "active",
      // "manual", not "auto". `origin` is what scopes the post-event scarcity
      // markup, and a rent-farm price is a fixed ladder from the contract, not a
      // number derived from drop scarcity — repricing one would misprice a
      // service ([[feedback_manual_listings_never_repriced]]). `rentFarm` is how
      // the tracker tells these from the owner's own listings.
      origin: "manual",
      note: "rent-farm buffer: " + creds.login,
      autoDeliver: true,
      // No relist chain. The buffer refills through the next topUpBuffer pass,
      // deliberately: a replacement published inside the sale handler would run
      // inside the watcher's tick and share its failure. Zero here also means
      // that if the fulfiller's rentFarm routing is ever lost, the sold row
      // falls out at `qtyRemaining <= 0` instead of trying to republish a
      // DropSet it does not have.
      qtyRemaining: 0,
      accountLogin: creds.login,
      rentFarm: true,
      rentFarmGame: want.game,
      rentFarmDays: term.days,
      rentFarmPoolId: poolId,
    });
  } catch (e) {
    // The listing is LIVE and purchasable with credentials attached, and we have
    // no row for it. Take it down first; only an offer that is actually gone
    // makes it safe to return the account, because handing it back while the
    // offer still sells it is how the same credentials reach two people.
    const reason = String((e && e.message) || e).slice(0, 200);
    let delisted = false;
    // Two INDEPENDENT facts, and the message used to conflate them: whether the
    // listing came down, and whether the account got back to the pool. It
    // asserted "the account returned" on the strength of `delisted` alone.
    let handedBack = null;
    try {
      await mp.gameflipDelist(r.externalId);
      delisted = true;
    } catch (de) {
      console.error(
        "gameflip buffer: could not delist orphan listing " + r.externalId +
          " after a failed row write:",
        de.message,
      );
    }
    if (delisted) {
      handedBack = await handBackOrAlert(poolId, "orphan listing delisted", {
        game: want && want.game,
        days: want && want.days,
      });
    }
    const accountBack = !!(handedBack && handedBack.ok);
    const detail =
      "published " + r.externalId + " but could not record it (" + reason +
      "). " +
      (delisted
        ? "The listing was delisted."
        : "THE LISTING IS STILL LIVE AND SELLABLE with " + creds.login +
          " attached — take it down by hand.") +
      " " +
      (accountBack
        ? "The account is back in the pool."
        : "The account is NOT back in the pool" +
          (handedBack && handedBack.reason ? " (" + handedBack.reason + ")" : "") +
          " — it is still claimed and still holding a rental slot.");
    noteReason(want.key, detail);
    out.shortfall.push({ ...want, reason: detail });
    // Alert on EITHER failure. Gating this on `!delisted` alone meant a
    // successfully delisted offer whose account was stranded went unreported —
    // the quieter half of the same incident, and the half nothing else can find.
    if (!delisted || !accountBack) {
      await alertBufferStopped("orphan-listing", detail);
    }
    return "next";
  }

  out.published++;
  logEvent({
    category: "marketplace",
    action: "gameflip_buffer_published",
    actor: "gameflip-buffer",
    subject: want.game,
    count: 1,
    detail:
      title + " $" + term.priceUsd + " (" + creds.login + ", placeholder " +
      BUFFER_WINDOW_DAYS + "d window)",
  }).catch(() => {});
  return "next";
}

// ------------------------------------------------------------------
// onBufferedSale
// ------------------------------------------------------------------

// Start the buyer's window.
//
// The account has been farming on the 365-day PLACEHOLDER since it was
// published, and this moves farmUntil DOWN for every term shorter than that.
// Moving it down is correct and is the entire point of the design: the buyer
// paid for N days FROM THEIR PURCHASE, not for whatever was left of a
// placeholder we picked so renterExpiry would not tear the account out of the
// config while the offer sat unsold. Farming we did before the sale is a bonus
// to us and to them; it is never part of what they bought, and it must never
// shorten what they get either — which is why the stamp is `now + days` and not
// an adjustment of the existing value.
async function restampWindow(clientSecret, days) {
  const farmUntil = new Date(Date.now() + days * 86400000);
  const r = await RenterAccount.updateOne(
    { clientSecret },
    { $set: { farmUntil, farmEndedAt: null } },
  );
  return {
    ok: !!(r && (r.matchedCount || r.n)),
    farmUntil,
  };
}

// A buffered offer sold. Called by utils/gameflipFulfiller when a rentFarm row
// goes sold, BEFORE the DropSet-scoped auto-delivery lane it must never reach.
async function onBufferedSale(rowIn) {
  const id = rowIn && rowIn._id;
  if (!id) return { skipped: "no row" };

  // CLAIM IT FIRST, atomically, before doing anything at all.
  //
  // The claim is the pool id, not the status. The fulfiller's sold-row lane has
  // ALREADY flipped status to "sold" by the time it routes here (the contract
  // puts the call above `if (!row.autoDeliver) continue;`), so a claim on
  // `status: "active"` would never match from that caller and would match twice
  // from any other. Clearing rentFarmPoolId is a one-way transition on a field
  // only this lane writes, so two overlapping passes cannot both start a window,
  // both write an order row, or both stamp a Telegram.
  //
  // It is also protective: releaseBuffered refuses a row with no pool id, so the
  // instant a sale is claimed the account behind it can no longer be handed back
  // to the pool by anything. Releasing drops a buyer had already paid for is a
  // mistake this codebase has made once already.
  //
  // `returnDocument: "before"` is the default and is spelled out anyway: the
  // pre-update document is the ONLY place the pool id and the term still exist
  // after this write, so the whole sale depends on which side of the update
  // comes back. That is not a default worth inheriting silently across a
  // Mongoose major (this codebase is already on 9, where kareem 3 quietly broke
  // every pre("save") hook that took a `next`).
  // THE CLAIM IS A LEASE, AND IT KEEPS THE RECOVERY KEY.
  //
  // It used to be taken by clearing rentFarmPoolId — destroying the only pointer
  // to the account BEFORE any of the work had run. Two awaits sit between the
  // claim and the stamp (poolCredentials, restampWindow), and on a bytes-bound
  // Atlas shared tier a transient rejection is the ordinary failure, not an
  // exotic one. When either rejected:
  //
  //   * farmUntil stayed at publish + 365. On the 1 Year term that is a straight
  //     shortfall — an offer that sat in the buffer 30 days delivers 335 days for
  //     a 365-day purchase. That is the exact overcharge this whole feature's
  //     "one correctness rule" forbids.
  //   * Nothing retried: a second pass finds rentFarmPoolId already "", the
  //     $nin filter misses, and it reports "already processed".
  //   * Nothing could even be fixed by hand, because the pool id was gone.
  //
  // Clearing the pool id was ALSO redundant as protection: releaseBuffered
  // already refuses any row whose status is "sold" (see its guard), which is the
  // direct statement of the rule rather than a side effect of this write.
  //
  // So: lease it, keep the pointer, and clear the pointer only once the window
  // is actually stamped. A tick that dies half-way is then resumable, which is
  // the property utils/eldoradoFarmService gets from its stage stamps.
  const leaseCutoff = new Date(Date.now() - SALE_LEASE_MS);
  const row = await MarketplaceListing.findOneAndUpdate(
    {
      _id: id,
      rentFarm: true,
      rentFarmPoolId: { $nin: ["", null] },
      $or: [
        { rentFarmSaleClaimedAt: null },
        { rentFarmSaleClaimedAt: { $exists: false } },
        { rentFarmSaleClaimedAt: { $lte: leaseCutoff } },
      ],
    },
    { $set: { status: "sold", rentFarmSaleClaimedAt: new Date() } },
    { returnDocument: "before" },
  );
  if (!row) {
    return { skipped: "already processed by another pass", listingId: String(id) };
  }

  const poolId = String(row.rentFarmPoolId || "");
  const days = Math.floor(Number(row.rentFarmDays) || 0);
  const game = row.rentFarmGame || "";
  const orderId = "gf:" + String(row.externalId || row._id);

  // This is the one lane where a human may have to finish the job by hand for a
  // buyer who has already paid, so every refusal names the account. The row still
  // carries rentFarmPoolId (the claim no longer erases it), but the message
  // repeats it anyway: an alert that says "the window could not be started"
  // without saying whose is an alert nobody can act on.
  const fail = async (reason) => {
    const detail = "pool " + (poolId || "?") + ": " + reason;
    await MarketplaceListing.updateOne(
      { _id: id },
      { $set: { lastError: ("rent-farm sale: " + detail).slice(0, 400) } },
    ).catch(() => {});
    // This one IS a paid order, so the shared alert's wording is exactly right.
    await farmAlert
      .alertFarmFailure({
        market: MARKET,
        orderId,
        offerTitle: row.title || "",
        game,
        days,
        qty: 1,
        reason: detail,
      })
      .catch(() => {});
    return { listingId: String(id), orderId, poolId, error: detail };
  };

  if (!days) {
    // Gameflip has already handed over the credentials — there is no refusing
    // this sale, only reporting it. Without a term we cannot know when the
    // window should end, and guessing one would either short the buyer or give
    // away a year.
    return fail(
      "the sold row carries no rentFarmDays, so the buyer's window cannot be " +
        "started — set it by hand from the offer title",
    );
  }

  // BOTH OF THE NEXT TWO AWAITS MUST BE CAUGHT.
  //
  // They are ordinary Mongo reads/writes on a bytes-bound Atlas shared tier,
  // where a transient rejection is the normal failure and not an exotic one. An
  // escape here propagates out of onBufferedSale into the fulfiller's sold lane,
  // which catches it into a bare console.error — leaving farmUntil at
  // publish + 365 for a buyer who paid for a shorter, later window, with no
  // Telegram, no lastError and nothing on the row to act on.
  //
  // Caught, each becomes a recorded, alerted failure AND a retryable one: the
  // pool id is still on the row and the lease lapses on its own.
  let creds;
  try {
    creds = await poolCredentials(poolId);
  } catch (e) {
    return fail(
      "could not read pool account " + poolId + " (" +
        String((e && e.message) || e).slice(0, 120) +
        ") — the buyer's window has NOT started; this retries once the claim " +
        "lease lapses",
    );
  }
  if (!creds || !creds.clientSecret) {
    return fail(
      "pool account " + poolId + " behind this offer is gone or has no token, " +
        "so its farming window cannot be started",
    );
  }

  // 1. The window the buyer actually bought.
  let stamped;
  try {
    stamped = await restampWindow(creds.clientSecret, days);
  } catch (e) {
    return fail(
      "could not stamp the farming window for " + (creds.login || poolId) +
        " (" + String((e && e.message) || e).slice(0, 120) +
        ") — the buyer's window has NOT started; this retries once the claim " +
        "lease lapses",
    );
  }
  if (!stamped.ok) {
    return fail(
      "no RenterAccount holds token for " + (creds.login || poolId) +
        " — the account is not farming, so the buyer is getting nothing",
    );
  }

  // 2. The record. `delivered` on creation, not queued: Gameflip released the
  // credentials to the buyer at the moment of payment, so there is no hand-over
  // left to do and a row in any other state would sit in `orders.undelivered`
  // forever describing work nobody can perform. The id is namespaced the way
  // PlayerAuctions namespaces its integers ("pa:16458589"): Gameflip ids share
  // this collection with Eldorado UUIDs.
  const now = new Date();
  let recorded = true;
  try {
    await FarmServiceOrder.create({
      orderId,
      market: MARKET,
      offerId: String(row.externalId || ""),
      offerTitle: row.title || "",
      // Gameflip's sold sweep answers with listing ids only; the buyer's name is
      // on the order page and never reaches this path. Blank, not a placeholder
      // that would read as a real username.
      buyerUsername: "",
      game,
      days,
      quantity: 1,
      accounts: [
        { login: creds.login, poolId, farmUntil: stamped.farmUntil },
      ],
      // The account was provisioned when the offer was published, which is what
      // this stamp means; the delivery happened just now.
      provisionedAt: row.createdAt || now,
      messageSentAt: now,
      deliveredAt: now,
      state: "delivered",
    });
  } catch (e) {
    // A duplicate key means a previous attempt already recorded this sale — the
    // window stamp above is idempotent, so that is a complete no-op, not a
    // failure. Anything else loses the record but not the delivery: the buyer
    // has their account and their window, so this must not read as a lost order.
    recorded = false;
    if (!(e && e.code === 11000)) {
      console.error(
        "gameflip buffered sale " + orderId + ": window started but the " +
          "FarmServiceOrder row could not be written:",
        e.message,
      );
    }
  }

  // THE SALE IS COMPLETE — release the pointer now, and only now.
  //
  // Everything above this line is re-runnable: restampWindow writes an absolute
  // `now + days` rather than an adjustment, and a duplicate FarmServiceOrder is
  // caught as a no-op. So the pointer survives right up to the moment the work
  // is genuinely done. If this process had died anywhere above, the lease would
  // lapse and the next pass would find the row still naming its account and
  // finish the job.
  //
  // The note still carries the pool id: the FarmServiceOrder row is the record
  // of record, but a human reading this listing should not have to go and find
  // it.
  await MarketplaceListing.updateOne(
    { _id: id },
    {
      $set: {
        lastError: "",
        rentFarmPoolId: "",
        rentFarmSaleClaimedAt: null,
        note:
          "rent-farm SOLD " + now.toISOString().slice(0, 10) + " — " +
          creds.login + " (pool " + poolId + ") farms " + game + " until " +
          stamped.farmUntil.toISOString().slice(0, 10),
      },
    },
  ).catch(() => {});

  logEvent({
    category: "marketplace",
    action: "gameflip_buffer_sold",
    actor: "gameflip-buffer",
    subject: game,
    count: 1,
    detail:
      (row.title || "") + " — " + creds.login + " now farms " + days +
      "d until " + stamped.farmUntil.toISOString().slice(0, 10),
  }).catch(() => {});

  // The replacement is deliberately NOT published here: it would run inside the
  // watcher's tick and share its failure. The next topUpBuffer pass fills the
  // slot.
  return {
    listingId: String(id),
    orderId,
    game,
    days,
    login: creds.login,
    farmUntil: stamped.farmUntil,
    recorded,
  };
}

// ------------------------------------------------------------------
// releaseBuffered
// ------------------------------------------------------------------

// An UNSOLD buffered offer came down (delisted, expired, cancelled, 404) — hand
// its ONE account back.
//
// PRECONDITION: the offer is already off sale and the row already carries a
// terminal status ("removed" / "delisted"). This releases the account, it does
// not take the listing down, and it refuses to act while the row still says
// "active" — see the claim below. Never called for a sold offer: that account
// belongs to a buyer for the length of their window.
async function releaseBuffered(rowIn, opts = {}) {
  const id = rowIn && rowIn._id;
  if (!id) return { released: false, skipped: "no row" };
  if (!rowIn.rentFarm) {
    return { released: false, skipped: "not a rent-farm row" };
  }
  const poolId = String(rowIn.rentFarmPoolId || "");
  if (!poolId) {
    // Nothing to scope the release to. Exactly the refusal
    // gameflipFulfiller.releaseAccount makes with no set id, for the same
    // reason: a release that cannot name its account can free something a buyer
    // has paid for, and a leaked account costs a slot while a double-sold one
    // costs a customer.
    return { released: false, skipped: "no rentFarmPoolId to release" };
  }
  if (rowIn.status === "sold") {
    console.error(
      "gameflip releaseBuffered: refusing to release " + poolId +
        " from SOLD listing " + (rowIn.externalId || id) +
        " — that account belongs to a buyer for the rest of their window.",
    );
    return { released: false, skipped: "row is sold" };
  }

  // Take the pool id off the row FIRST and conditionally, so two overlapping
  // passes cannot both hand back the same account.
  //
  // THE OFFER MUST ALREADY BE DOWN. The predicate names the terminal states, not
  // `$ne: "sold"`, because an ACTIVE row may still be live and purchasable on
  // Gameflip with these credentials baked into its delivery code — handing the
  // account back to the pool while that offer can still be bought is how the
  // same credentials reach two people. Retire (or delist) first, then release:
  // that is the order utils/gameflipFulfiller already uses for its 404 / expired
  // paths, which set `status: "removed"` in a conditional update and only then
  // hand the account back. `status` is read from the DB here, not from the
  // caller's in-memory row, so a stale read of a row that has since sold loses
  // this race rather than winning it.
  const claimed = await MarketplaceListing.findOneAndUpdate(
    {
      _id: id,
      rentFarmPoolId: poolId,
      status: { $in: ["removed", "delisted", "error"] },
    },
    { $set: { rentFarmPoolId: "" } },
  );
  if (!claimed) {
    // Say which of the two it was. "Nothing happened" with no reason is what
    // makes a leaked account invisible for weeks.
    const fresh = await MarketplaceListing.findById(id, { status: 1 })
      .lean()
      .catch(() => null);
    const st = (fresh && fresh.status) || "gone";
    return {
      released: false,
      poolId,
      skipped:
        st === "active"
          ? "the offer is still ACTIVE on Gameflip — take it down first, a " +
            "live offer still sells these credentials"
          : "already released, or the row changed to '" + st + "' meanwhile",
    };
  }

  const reason = String(opts.reason || "unsold buffered offer came down");
  const back = await handBackToPool(poolId, reason).catch((e) => ({
    ok: false,
    reason: String((e && e.message) || e).slice(0, 200),
  }));

  if (!back.ok) {
    // Put the pool id BACK. It is the only link between this row and the
    // account, and the row is usually terminal by now (the watcher retires it to
    // "removed"), so dropping the link would strand a pristine account with
    // nothing left that could ever find it. Restoring makes the next pass — and
    // bufferState's `stranded` list — see it again.
    await MarketplaceListing.updateOne(
      { _id: id, rentFarmPoolId: "" },
      {
        $set: {
          rentFarmPoolId: poolId,
          lastError: ("rent-farm release failed: " + back.reason).slice(0, 400),
        },
      },
    ).catch(() => {});
    console.error(
      "gameflip releaseBuffered: could not return " + poolId + ":",
      back.reason,
    );
    return { released: false, error: back.reason, poolId };
  }

  logEvent({
    category: "marketplace",
    action: "gameflip_buffer_released",
    actor: "gameflip-buffer",
    subject: rowIn.rentFarmGame || "",
    count: 1,
    detail:
      (back.login || poolId) + " returned to the pool — " + reason.slice(0, 160),
  }).catch(() => {});

  return { released: true, poolId, login: back.login, reason };
}

// ------------------------------------------------------------------
// bufferState
// ------------------------------------------------------------------

// Everything the tracker renders, and everything it needs to say WHY a slot is
// empty. "Nothing here" must never be indistinguishable from "everything is
// fine": an empty `rows` list with no `missing` and no `notes` would read as a
// healthy, complete buffer when it usually means the service is off, the pool is
// dry, or no pass has run yet.
async function bufferState() {
  const cfg = config();
  const now = new Date();
  const state = {
    at: now,
    market: MARKET,
    enabled: cfg.enabled,
    // EXPOSED DELIBERATELY. Without it the tracker painted a green "buffer on"
    // pill while topUpBuffer was in dry run and publishing nothing — two dials
    // on one subsystem giving opposite answers, which is the failure the 10/10
    // rental stack already taught this codebase once.
    dryRun:
      cfg.af && cfg.af.gfBufferDryRun !== undefined
        ? cfg.af.gfBufferDryRun !== false
        : true,
    configured: !!(mp.keyStatus().gameflip || {}).configured,
    target: cfg.target,
    reserve: cfg.reserve,
    perPass: cfg.perPass,
    windowDays: BUFFER_WINDOW_DAYS,
    terms: TERMS,
    games: [],
    catalogue: { total: 0, truncated: false },
    live: [],
    sold: [],
    missing: [],
    stranded: [],
    problems: [],
    // Which JOINS could not be read this pass. Empty means every one of them
    // loaded — it does NOT mean nothing is wrong. A verdict drawn from a join
    // that never returned is a confident lie, so anything reading this state
    // must go `unknown` rather than `fail`/`ok` when this is non-empty.
    unreadable: [],
    capacity: null,
    pool: null,
    lastPass: {
      at: lastPass.at,
      stopped: lastPass.stopped,
      // An empty reason map is not "no problems" — it is "nothing has run".
      ran: !!lastPass.at,
    },
    notes: [],
  };

  if (!state.enabled) {
    state.notes.push(
      "The buffer is OFF (autoFarm.gameflipRentFarm). Nothing is being " +
        "published or refilled; anything live below is left over.",
    );
  }
  if (!state.configured) {
    state.notes.push(
      "Gameflip API keys are not configured — no publish or status read can " +
        "succeed, so live counts here are DB state, not Gameflip's.",
    );
  }
  if (!lastPass.at) {
    state.notes.push(
      "No top-up pass has run since the last restart, so per-slot failure " +
        "reasons below are the structural ones only.",
    );
  }

  const [cat, liveRows] = await Promise.all([
    desiredCatalogue().catch(() => ({
      games: [],
      wanted: [],
      total: 0,
      truncated: false,
    })),
    liveBufferRows().catch(() => []),
  ]);
  state.games = cat.games;
  state.catalogue = { total: cat.total, truncated: !!cat.truncated };
  if (cat.truncated) {
    state.notes.push(
      cat.total + " (game, term) offers are wanted but the target caps the " +
        "buffer at " + cfg.target + " — the tail of the catalogue is " +
        "deliberately not published.",
    );
  }
  if (liveRows.length >= MAX_BUFFER_ROWS) {
    state.notes.push(
      "Read capped at " + MAX_BUFFER_ROWS + " buffered rows; newer rows are " +
        "not shown.",
    );
  }

  // Do the buffered accounts still exist, and are they still farming? A live
  // offer whose backing account is gone takes money and delivers nothing, which
  // is the one condition here that is worth waking someone for.
  // Two hops, deliberately sequential: listing -> pool row -> RenterAccount BY
  // TOKEN. A login is not an identity in this pool — duplicate logins are a
  // known population ([[project_duplicate_login_accounts]]) and the clientSecret
  // is what every other join in the codebase keys on. Joining these by login
  // would silently attach one account's farming state to a namesake's offer,
  // which here reads as "healthy" for an offer whose real account is gone.
  const poolIds = liveRows.map((r) => r.rentFarmPoolId).filter(Boolean);
  const poolRows = poolIds.length
    ? await AvailableAccount.find(
        { _id: { $in: poolIds } },
        { username: 1, status: 1, clientSecret: 1, manualSold: 1 },
      )
        .limit(MAX_BUFFER_ROWS)
        .lean()
        .catch((e) => {
          // A read that FAILED is not a read that returned nothing. Swallowing
          // it into [] made every live offer look like "the pool account row is
          // gone", which the health check then reported as a critical failure
          // over data it had never seen. Record the failure so the verdict can
          // be `unknown` instead of a confident lie.
          state.unreadable.push(
            "pool accounts: " + String((e && e.message) || e).slice(0, 120),
          );
          return [];
        })
    : [];
  const secrets = poolRows.map((p) => p.clientSecret).filter(Boolean);
  const renterRows = secrets.length
    ? await RenterAccount.find(
        { clientSecret: { $in: secrets } },
        {
          login: 1,
          clientSecret: 1,
          configFile: 1,
          farmUntil: 1,
          farmEndedAt: 1,
          enabled: 1,
          lastScanStatus: 1,
        },
      )
        .limit(MAX_BUFFER_ROWS)
        .lean()
        .catch((e) => {
          state.unreadable.push(
            "renter accounts: " + String((e && e.message) || e).slice(0, 120),
          );
          return [];
        })
    : [];
  const poolById = new Map(poolRows.map((p) => [String(p._id), p]));
  const renterBySecret = new Map(
    renterRows.map((a) => [String(a.clientSecret || ""), a]),
  );

  for (const r of liveRows) {
    const pool = poolById.get(String(r.rentFarmPoolId || ""));
    const acct = pool ? renterBySecret.get(String(pool.clientSecret || "")) : null;
    let problem = "";
    if (!r.rentFarmPoolId) problem = "no pool account recorded on the row";
    else if (!pool) problem = "the pool account row is gone";
    else if (pool.manualSold) problem = "the pool account was sold by hand";
    else if (pool.status !== "claimed")
      problem = "the pool account is back in the pool (status " + pool.status + ")";
    else if (!acct) problem = "no RenterAccount — the account is not farming";
    else if (!acct.configFile) problem = "the account is on no bot config";
    else if (acct.farmEndedAt) problem = "its farming window has already ended";
    else if (acct.enabled === false) problem = "the account is disabled on the bot";
    else if (acct.lastScanStatus === "token_invalid")
      problem = "its Twitch token no longer scans";
    const entry = {
      listingId: String(r._id),
      externalId: r.externalId,
      url: r.url || "",
      title: r.title || "",
      price: Number(r.price) || 0,
      game: r.rentFarmGame || "",
      days: Number(r.rentFarmDays) || 0,
      login: r.accountLogin || "",
      poolId: String(r.rentFarmPoolId || ""),
      placeholderUntil: (acct && acct.farmUntil) || null,
      publishedAt: r.createdAt || null,
      lastError: r.lastError || "",
      healthy: !problem,
      problem,
    };
    state.live.push(entry);
    if (problem) state.problems.push(entry);
  }

  // Sold-and-served, with the window end date — and, loudly, any sold offer
  // whose window never started, because that buyer is not getting what they
  // paid for.
  const soldRows = await MarketplaceListing.find(
    { marketplace: MARKET, rentFarm: true, status: "sold" },
    {
      externalId: 1,
      title: 1,
      price: 1,
      accountLogin: 1,
      rentFarmGame: 1,
      rentFarmDays: 1,
      updatedAt: 1,
      lastError: 1,
    },
  )
    .sort({ updatedAt: -1 })
    .limit(MAX_BUFFER_ROWS)
    .lean()
    .catch(() => []);
  if (soldRows.length >= MAX_BUFFER_ROWS) {
    state.notes.push(
      "Sold history capped at " + MAX_BUFFER_ROWS + " rows (newest first) — " +
        "older sales are not counted here.",
    );
  }
  // The sold side is joined to its FarmServiceOrder, not back to the account.
  //
  // A sold row no longer names its pool account — onBufferedSale clears
  // rentFarmPoolId as its atomic claim, precisely so nothing can hand that
  // account back while a buyer owns it — and the login alone is not an identity.
  // The order row is where the sale was recorded: it carries the account, the
  // pool id and the window that was actually stamped. Its ABSENCE is the signal
  // that matters: a sold buffered offer with no order row is a sale whose window
  // may never have started, which is the buyer not getting what they paid for.
  const soldKeys = soldRows.map((r) => "gf:" + String(r.externalId || ""));
  const soldOrders = soldKeys.length
    ? await FarmServiceOrder.find(
        { market: MARKET, orderId: { $in: soldKeys } },
        { orderId: 1, accounts: 1, days: 1, deliveredAt: 1, state: 1 },
      )
        .limit(MAX_BUFFER_ROWS)
        .lean()
        .catch((e) => {
          state.unreadable.push(
            "sale records: " + String((e && e.message) || e).slice(0, 120),
          );
          return [];
        })
    : [];
  const orderByKey = new Map(soldOrders.map((o) => [String(o.orderId), o]));
  for (const r of soldRows) {
    const order = orderByKey.get("gf:" + String(r.externalId || ""));
    const acct = (order && order.accounts && order.accounts[0]) || null;
    state.sold.push({
      externalId: r.externalId,
      title: r.title || "",
      price: Number(r.price) || 0,
      game: r.rentFarmGame || "",
      days: Number(r.rentFarmDays) || 0,
      login: (acct && acct.login) || r.accountLogin || "",
      poolId: (acct && acct.poolId) || "",
      soldAt: r.updatedAt || null,
      farmUntil: (acct && acct.farmUntil) || null,
      // Not "unknown". No recorded window on a SOLD rent-farm offer means the
      // window never started, and `lastError` says why.
      windowStarted: !!(acct && acct.farmUntil),
      recorded: !!order,
      lastError: r.lastError || "",
    });
  }
  const unstarted = state.sold.filter((s) => !s.windowStarted);
  if (unstarted.length) {
    state.notes.push(
      unstarted.length + " sold buffered offer(s) have NO recorded farming " +
        "window — those buyers paid for a term that never started: " +
        unstarted.slice(0, 5).map((s) => s.externalId).join(", "),
    );
  }

  // Accounts still held by offers that are dead on Gameflip.
  state.stranded = (await strandedRows(MAX_BUFFER_ROWS).catch(() => [])).map(
    (r) => ({
      externalId: r.externalId,
      title: r.title || "",
      status: r.status,
      game: r.rentFarmGame || "",
      days: Number(r.rentFarmDays) || 0,
      login: r.accountLogin || "",
      poolId: String(r.rentFarmPoolId || ""),
      since: r.updatedAt || null,
    }),
  );

  // Capacity and pool, read live — these are the two structural reasons a slot
  // is empty and they are true whether or not a pass has run.
  const cap = await freeSlots();
  state.capacity = {
    ...cap,
    reserve: cfg.reserve,
    spendable: cap.ok ? Math.max(0, cap.totalFree - cfg.reserve) : null,
    belowReserve: cap.ok ? !roomForOneMore(cap, cfg.reserve) : null,
  };
  if (!cap.ok) {
    state.notes.push(
      "Rental stack capacity could not be read (" + cap.error + "), so free " +
        "slots are UNKNOWN — the buffer refuses to publish rather than guess.",
    );
  } else if (cap.offlineHosts.length) {
    state.notes.push(
      "Host(s) offline and NOT counted in free slots: " +
        cap.offlineHosts.join(", ") + " — the real figure is higher.",
    );
  }

  try {
    const pre = await operatorFarm.previewFreshAccounts({ count: 1 });
    state.pool = {
      eligibleTotal: pre.eligibleTotal,
      quotaRemaining: pre.quotaRemaining,
      stackRoom: pre.stackRoom,
      willAdd: pre.willAdd,
      blockedBy: pre.blockedBy,
    };
  } catch (e) {
    state.pool = { error: String((e && e.message) || e).slice(0, 200) };
  }

  // What is wanted but not published, and WHY. Structural reasons first (they
  // are measured right now), then whatever the last pass actually hit.
  const haveKey = new Set(
    liveRows.map((r) => slotKey(r.rentFarmGame, r.rentFarmDays)),
  );
  const structural = !state.enabled
    ? "the buffer is off (autoFarm.gameflipRentFarm)"
    : !state.configured
      ? "gameflip API keys are not configured"
      : !cap.ok
        ? "rental stack capacity could not be read"
        : state.capacity.belowReserve
          ? "reserve floor: " + cap.totalFree + " free slot(s), " + cfg.reserve +
            " reserved for paid on-demand orders"
          : state.pool && state.pool.error
            ? "pool availability could not be read (" + state.pool.error + ")"
            : state.pool && state.pool.willAdd === 0
              ? "no pristine pool account is available (" +
                (state.pool.blockedBy || "blocked") + ")"
              : "";
  for (const w of cat.wanted) {
    if (haveKey.has(w.key)) continue;
    state.missing.push({
      game: w.game,
      days: w.days,
      label: w.label,
      priceUsd: w.priceUsd,
      reason:
        lastPass.reasons.get(w.key) ||
        structural ||
        (lastPass.at
          ? "not reached in the last pass (bounded to " + cfg.perPass + " " +
            "publishes) — it is queued, not blocked"
          : "no top-up pass has run since the last restart"),
    });
  }

  state.summary =
    state.live.length + " live of " + cat.wanted.length + " wanted (target " +
    cfg.target + "), " + state.missing.length + " missing, " +
    state.problems.length + " unhealthy, " + state.stranded.length +
    " stranded account(s), free slots " +
    (cap.ok ? cap.totalFree : "UNKNOWN") + " with " + cfg.reserve + " reserved";
  return state;
}

module.exports = {
  MARKET,
  BUFFER_WINDOW_DAYS,
  GF_BUFFER_TARGET,
  RENT_SLOT_RESERVE,
  GF_BUFFER_PER_PASS,
  CATALOGUE_DAYS_BACK,
  MAX_BUFFER_ROWS,
  TERMS,
  DENY_GAME,
  // the catalogue
  catalogueGames,
  desiredCatalogue,
  offerTitle,
  offerDescription,
  bufferedDeliveryCode,
  // the four
  topUpBuffer,
  onBufferedSale,
  releaseBuffered,
  bufferState,
  // exported for tests and for the tracker's own capacity line
  config,
  freeSlots,
  roomForOneMore,
  slotKey,
  handBackToPool,
  // testing seam: the in-memory pass log and the alert latch
  _reset: () => {
    lastPass = { at: null, reasons: new Map(), stopped: "" };
    reserveAlerted = false;
  },
};
