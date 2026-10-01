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
// How far back the unfinished-sale sweep looks (see retryUnfinishedSales).
const SALE_SWEEP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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
// Pristine pool accounts the buffer never takes (autoFarm.gfPoolReserve).
const GF_POOL_RESERVE = 50;

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

// A game with no Twitch Drops campaign running at any point in this many days
// is "dark": the buffer publishes no NEW offer for it and does not renew its
// expired ones (their accounts go back to the pool the usual way). Offers
// already live stay up until they sell or expire — nothing is delisted. The
// offers sell 120-365 day windows, so a game merely between campaigns (Rocket
// League, Warframe: a dozen campaigns a month, none at this minute) must stay;
// a game silent for six weeks is selling farming with nothing to farm.
// Measured 2026-10-01: all 29 catalogue games had a campaign end within the
// last 33 days, so this removed nothing on the day it shipped.
const DARK_GAME_DAYS = 45;

// Ceiling on the buffered rows one pass will read back. Bounded because this
// runs on a bytes-bound Atlas shared tier; sorted because an unsorted `.limit()`
// is the bug that hid 35 Gameflip listings from the watcher for months (see
// utils/gameflipFulfiller.syncOnce) — with a sort, a truncation drops the
// NEWEST rows and `truncated` says so out loud.
const MAX_BUFFER_ROWS = 400;

// Renewal of offers that EXPIRED unsold (Gameflip lists everything for 30 days).
// A failed renewal is retried on later passes; after this many the account is
// returned to the pool the old way. A row waiting longer than RENEW_STUCK_MS is
// reported as stranded rather than "renewing".
const RENEW_MAX_FAILURES = 3;
const RENEW_STUCK_MS = 6 * 60 * 60 * 1000;
// A renewal holds a lease on its row while it publishes (gameflipPublish can
// back off 20s + 60s). Older than this, the renewal was cut off — never retried
// automatically, because its listing may already be live.
const RENEW_LEASE_MS = 20 * 60 * 1000;

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
    // Pristine pool accounts the buffer never takes (B5): shelf offers must not
    // eat the last accounts a PAID on-demand order needs. ~4-5 days of
    // on-demand sales at ~11/day.
    poolReserve: num(af.gfPoolReserve, GF_POOL_RESERVE),
    // An explicit game list pins the catalogue to exactly what is live on
    // Eldorado without waiting for the AutoFarmTask window to agree.
    games: Array.isArray(af.gfRentFarmGames)
      ? af.gfRentFarmGames.map((g) => String(g || "").trim()).filter(Boolean)
      : [],
  };
}

// Does an unsold offer that EXPIRES keep its account for a renewal (true), or
// go straight back to the pool (false)? Only while the buffer is really
// running: with the service off or in dry run nothing would ever renew it, and
// an account parked for a renewal that never comes is a leak.
function renewsOnExpiry() {
  const cfg = config();
  return cfg.enabled && cfg.af.gfBufferDryRun === false;
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
// What the campaign history says, lower-cased: `recent` = games with a campaign
// running at some point in the last DARK_GAME_DAYS, `ever` = games with any
// campaign on record. `distinct` for the same bytes reason as above.
// null = UNKNOWN, and the caller then treats no game as dark:
//   - a failed read;
//   - nothing at all came back;
//   - the campaign watcher has not refreshed anything for WATCHER_STALE_MS —
//     a stalled watcher leaves a stale but non-empty history, and games would
//     go dark one by one while their campaigns simply went unseen.
const WATCHER_STALE_MS = 48 * 60 * 60 * 1000;
async function campaignHistory() {
  const TwitchCampaign = require("../models/TwitchCampaign");
  const now = Date.now();
  const since = new Date(now - DARK_GAME_DAYS * 86400000);
  try {
    const fresh = await TwitchCampaign.exists({ lastSeenAt: { $gte: new Date(now - WATCHER_STALE_MS) } });
    if (!fresh) return null;
    const [recentNames, everNames] = await Promise.all([
      TwitchCampaign.distinct("game", {
        $or: [
          { endAt: { $gte: since } },
          { endAt: null, lastSeenAt: { $gte: since } },
        ],
      }),
      TwitchCampaign.distinct("game"),
    ]);
    const norm = (names) =>
      new Set((names || []).map((g) => String(g || "").trim().toLowerCase()).filter(Boolean));
    const recent = norm(recentNames);
    if (!recent.size) return null;
    return { recent, ever: norm(everNames) };
  } catch {
    return null;
  }
}

// Kept for callers that only want the recent set (null = unknown).
async function gamesWithRecentCampaigns() {
  const h = await campaignHistory();
  return h ? h.recent : null;
}

async function desiredCatalogue() {
  const cfg = config();
  const games = await catalogueGames();
  const history = await campaignHistory();
  // Dark = campaigns on record, none lately. A game with NO campaign on record
  // (announced and not yet run — "AION 2" — or a name the watcher spells
  // differently) is not evidence of anything, and stays.
  let dark = history
    ? games.filter((g) => {
        const k = String(g).trim().toLowerCase();
        return history.ever.has(k) && !history.recent.has(k);
      })
    : [];
  // Every game dark at once is a broken signal, not a dead shelf.
  let campaignsUnknown = !history;
  if (games.length && dark.length === games.length) {
    dark = [];
    campaignsUnknown = true;
  }
  const darkSet = new Set(dark);
  const all = [];
  for (const game of games) {
    if (darkSet.has(game)) continue;
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
    dark,
    campaignsUnknown,
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
    "own — our bot then farms every Twitch Drops campaign " + game + " runs " +
    "during your " + term.days + " days. Farming begins the moment " +
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
    "they unlock — you do not have to watch any streams. Items appear whenever " +
    game + " runs a Twitch Drops campaign during your " + term + ", so check " +
    "back and claim them whenever you like at " +
    "https://www.twitch.tv/drops/inventory\n\n" +
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
let poolReserveAlerted = false;
const keyCooldown = new Map(); // "(game)|(days)" -> { n: failures in a row, until: ms }
let capUnreadableAlertedAt = 0;
const CAP_UNREADABLE_REALERT_MS = 6 * 60 * 60 * 1000;

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
      // Shelf housekeeping, never a buyer's order: it must not read "order
      // NOT delivered" (B12).
      kind: "buffer",
    })
    .catch(() => {});
  return out || { ok: false, reason };
}

async function handBackToPool(poolId, note, { burned = false } = {}) {
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

  // BURNED: a buyer who was refunded has seen these credentials (a Gameflip
  // listing that ended "cancelled"). Off the bot, yes — but never back into the
  // pool as available, where it would be sold to someone else while the refunded
  // buyer still holds the password. It stays claimed, labelled.
  if (burned) {
    await AvailableAccount.updateOne(
      { _id: poolId, status: "claimed" },
      {
        $set: {
          claimedNote: (
            "burned — credentials seen by a Gameflip buyer whose purchase was cancelled; " +
            "never resell (" + String(note || "") + ")"
          ).slice(0, 300),
        },
      },
    ).catch(() => null);
    await recordPoolUsage(poolId, {
      event: "held",
      actor: "gameflip-buffer",
      note: ("burned: " + String(note || "")).slice(0, 200),
    }).catch(() => {});
    return { ok: true, returned: false, burned: true, login: pool.username || "" };
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
async function strandedRows(limit, { releaseLane = false } = {}) {
  const q = {
    marketplace: MARKET,
    rentFarm: true,
    status: { $in: ["removed", "delisted"] },
    rentFarmPoolId: { $nin: ["", null] },
  };
  if (releaseLane) {
    // What the release sweep may take: never a leased row (a renewal is, or
    // was, publishing its credentials), and never an expired row still parked
    // for renewal — filtered HERE, not after the limit, or five parked rows
    // would starve every delisted / 404 row forever. An expired row that was
    // later DELISTED by hand is released like any delisted row.
    q.rentFarmRenewingAt = null;
    q.$or = [{ rentFarmExpiredAt: null }, { status: "delisted" }];
  }
  return MarketplaceListing.find(
    q,
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
      rentFarmExpiredAt: 1,
      rentFarmRenewFailures: 1,
      rentFarmRenewingAt: 1,
      rentFarmRenewStaleAlertedAt: 1,
      lastError: 1,
      updatedAt: 1,
    },
  )
    .sort({ updatedAt: 1 })
    .limit(Math.max(1, limit))
    .lean();
}

// A renewal lease older than a renewal can take: the renewal was cut off
// (restart, crash) — possibly AFTER its listing went live or even sold.
function isStaleLease(row, now = Date.now()) {
  return !!(row && row.rentFarmRenewingAt) &&
    now - new Date(row.rentFarmRenewingAt).getTime() >= RENEW_LEASE_MS;
}

// An expired row waiting for (or retrying) its renewal, as opposed to an
// account genuinely stuck on a dead offer.
function isRenewing(row, now = Date.now()) {
  if (!row || row.status !== "removed" || !row.rentFarmExpiredAt) return false;
  if (row.rentFarmRenewingAt) {
    // In flight — or cut off, which needs a human (see settleStranded).
    return now - new Date(row.rentFarmRenewingAt).getTime() < RENEW_LEASE_MS;
  }
  if ((Number(row.rentFarmRenewFailures) || 0) >= RENEW_MAX_FAILURES) return false;
  return now - new Date(row.rentFarmExpiredAt).getTime() < RENEW_STUCK_MS;
}

// Every expired-unsold row still owning its account (renewal candidates),
// oldest expiry first — read in full, not through the 5-row stranded window,
// so delisted rows that keep failing to release can never starve renewals.
async function parkedRows() {
  return MarketplaceListing.find(
    {
      marketplace: MARKET,
      rentFarm: true,
      status: "removed",
      rentFarmExpiredAt: { $ne: null },
      rentFarmPoolId: { $nin: ["", null] },
    },
    {
      externalId: 1,
      title: 1,
      status: 1,
      accountLogin: 1,
      rentFarm: 1,
      rentFarmGame: 1,
      rentFarmDays: 1,
      rentFarmPoolId: 1,
      rentFarmExpiredAt: 1,
      rentFarmRenewFailures: 1,
      rentFarmRenewingAt: 1,
      rentFarmRenewStaleAlertedAt: 1,
      lastError: 1,
      updatedAt: 1,
    },
  )
    .sort({ rentFarmExpiredAt: 1 })
    .limit(MAX_BUFFER_ROWS)
    .lean();
}

// Tell the owner the buffer stopped filling. Uses the SHARED alert path rather
// than a private one: four copies of the same marketplace list had silently
// drifted apart once ([[reference_market_claim_tags]]) and one alerting habit is
// worth more than a perfectly worded second one. Its header says "order NOT
// delivered", so the ids below are written to make it unmistakable that no
// order is involved and nobody is waiting on a delivery.
async function alertBufferStopped(reason, detail) {
  // The shared alert, in its BUFFER form (B12): its own header and action —
  // "rent-farm order NOT delivered" was the paid-order header, and a buffer
  // housekeeping page worded like a lost order trains the owner to skim.
  await farmAlert
    .alertFarmFailure({
      market: MARKET,
      orderId: "buffer:" + reason,
      offerTitle: "Gameflip rent-farm BUFFER (no buyer order involved)",
      game: "",
      days: 0,
      qty: 0,
      reason: detail,
      kind: "buffer",
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
    renewed: 0,
    stopped: "",
    shortfall: [],
    capacity: null,
  };

  const configured = !!(mp.keyStatus().gameflip || {}).configured;
  // Renewal is a publish: only while the buffer really runs. In every other
  // state (off, dry run, keys missing) a parked account is simply returned —
  // nothing would ever renew it, and parked forever it holds a rental slot.
  const canRenew = cfg.enabled && configured && !dryRun;

  if (!cfg.enabled || !configured) {
    lastPass = { at: new Date(), reasons: new Map(), stopped: "" };
    const cat = await desiredCatalogue().catch(() => ({ games: [], wanted: [] }));
    const parked = await parkedRows().catch(() => null);
    await settleStranded(cat, new Set(), cfg, out, { canRenew: false, parked });
    out.stopped = !cfg.enabled ? "gameflipRentFarm off" : "gameflip not configured";
    return out;
  }

  lastPass = { at: new Date(), reasons: new Map(), stopped: "" };

  const [cat, live] = await Promise.all([desiredCatalogue(), liveBufferRows()]);
  // Parked renewals, read AFTER the live rows: a row the watcher retired in
  // between shows up in both, and must count as parked, not live. A failed read
  // stops the pass — guessing "none parked" would give their slots to fresh
  // pristine accounts.
  let parked;
  try {
    parked = await parkedRows();
  } catch (e) {
    out.stopped = "could not read parked renewals: " + String((e && e.message) || e).slice(0, 120);
    lastPass.stopped = out.stopped;
    return out;
  }
  const parkedIds = new Set(parked.map((p) => String(p._id)));
  out.live = live.filter((r) => !parkedIds.has(String(r._id))).length;
  out.wanted = cat.wanted.length;

  const haveKey = new Set(
    live
      .filter((r) => !parkedIds.has(String(r._id)))
      .map((r) => slotKey(r.rentFarmGame, r.rentFarmDays)),
  );

  // Accounts parked on dead offers FIRST — and before the "buffer is full"
  // return below, which used to skip this entirely whenever every wanted slot
  // was live, leaving such accounts on a bot and holding a rental slot until
  // renterExpiry pulled them a year later without ever returning them.
  // An offer that EXPIRED unsold is relisted with its own account when its slot
  // is still wanted; everything else goes back to the pool. A renewal is a
  // publish, so it spends this pass's publish budget, and a slot whose renewal
  // is pending counts as filled (a fresh account must not take it).
  let publishBudget = cfg.perPass;
  const settled = await settleStranded(cat, haveKey, cfg, out, { canRenew, parked });
  publishBudget -= settled.published;
  if (settled.stop) {
    out.stopped = settled.stop;
    lastPass.stopped = settled.stop;
    return out;
  }

  const missing = cat.wanted.filter((w) => !haveKey.has(w.key));
  if (!missing.length) {
    out.stopped = "buffer is full";
    reserveAlerted = false;
    return out;
  }
  // A (game, term) whose publish just failed waits before it is tried again
  // (B8): the keys are walked in the same order every pass, so one that keeps
  // failing was retried FIRST every pass — an account claimed and handed back,
  // two restarts, each time. Other keys go first meanwhile.
  const nowMs = Date.now();
  const ready = missing.filter((w) => {
    const c = keyCooldown.get(w.key);
    if (c && c.until > nowMs) {
      noteReason(w.key, "cooling down after " + c.n + " failed publish(es) — retried after " + new Date(c.until).toISOString().slice(11, 16) + "Z");
      return false;
    }
    return true;
  });

  const budget = Math.min(Math.max(0, publishBudget), ready.length);

  // THE POOL RESERVE (B5): the buffer never takes the last pristine accounts.
  // Read once per pass (the provisioner's own filter); every publish spends one.
  let poolLeft = null;
  if (budget > 0 && cfg.poolReserve > 0) {
    try {
      const { eligible } = await require("../routes/renterAdminRoutes").gatherPoolEligibility();
      poolLeft = (eligible || []).length;
    } catch (e) {
      out.stopped = "pool unreadable: " + String((e && e.message) || e).slice(0, 120);
      lastPass.stopped = out.stopped;
      return out;
    }
  }

  for (let i = 0; i < budget; i++) {
    const want = ready[i];

    if (poolLeft !== null && poolLeft <= cfg.poolReserve) {
      out.stopped =
        "pool reserve reached — " + poolLeft + " pristine account(s) left, " +
        cfg.poolReserve + " kept for paid on-demand orders";
      lastPass.stopped = out.stopped;
      for (let j = i; j < ready.length; j++) {
        noteReason(ready[j].key, out.stopped);
        out.shortfall.push({ ...ready[j], reason: out.stopped });
      }
      if (!poolReserveAlerted) {
        poolReserveAlerted = true;
        await alertBufferStopped(
          "pool-reserve",
          out.stopped + ". The buffer publishes nothing new until the pool is restocked.",
        );
      }
      break;
    }
    if (poolLeft !== null) poolReserveAlerted = false;

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
      for (let j = i; j < ready.length; j++) {
        noteReason(ready[j].key, out.stopped);
        out.shortfall.push({ ...ready[j], reason: out.stopped });
      }
      if (Date.now() - capUnreadableAlertedAt >= CAP_UNREADABLE_REALERT_MS) {
        capUnreadableAlertedAt = Date.now();
        await alertBufferStopped(
          "capacity-unreadable",
          "could not read rental stack capacity, so the buffer stopped rather " +
            "than guess there was room: " + cap.error,
        );
      }
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
      for (let j = i; j < ready.length; j++) {
        noteReason(ready[j].key, out.stopped);
        out.shortfall.push({ ...ready[j], reason: out.stopped });
      }
      if (!reserveAlerted) {
        reserveAlerted = true;
        await alertBufferStopped(
          "reserve-floor",
          out.stopped + ". " + out.live + " buffered offer(s) live of " +
            cfg.target + " wanted. The buffer stops GROWING — its live offers keep " +
            "their slots until they sell or expire. If paid orders need the room, " +
            "add a rental stack or lower the buffer target.",
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

    const before = out.published;
    const published = await publishOne(want, out);
    if (poolLeft !== null && published !== "stop") poolLeft -= 1; // it took one (or handed it back)
    if (out.published > before) {
      keyCooldown.delete(want.key);
    } else if (published !== "stop") {
      // This key failed (a "stop" is about the pool, not the key): 1 h, then
      // doubling, at most 6 h.
      const c = keyCooldown.get(want.key) || { n: 0, until: 0 };
      c.n += 1;
      c.until = Date.now() + Math.min(6, 2 ** (c.n - 1)) * 3600000;
      keyCooldown.set(want.key, c);
    }
    if (published === "stop") break;
  }

  return out;
}

// Settle the rows that are dead on Gameflip but still hold an account:
//   1. expired-unsold rows (parkedRows): renewed with their own account when
//      `canRenew`, the slot is wanted and not live, the account is healthy and
//      free slots are not under the reserve — otherwise returned to the pool;
//      a renewal that failed but may still succeed keeps its slot counted as
//      FILLED so the publish step does not give it a fresh account;
//   2. every other dead row (delisted, 404, cancelled): returned to the pool.
// A row with a renewal lease is never touched; a stale lease pages a human.
// Bounded: at most perPass publishes and perPass releases per pass.
// Returns { published, stop }.
async function settleStranded(cat, haveKey, cfg, out, { canRenew = true, parked = null } = {}) {
  const wanted = new Map((cat.wanted || []).map((w) => [w.key, w]));
  // An empty catalogue is a failed read (catalogueGames swallows errors), not
  // an order to return every parked account.
  const catalogueKnown = (cat.games || []).length > 0;
  let published = 0;
  let released = 0;
  let stop = "";
  let cap = null;
  const release = async (row, why) => {
    if (released >= cfg.perPass) return;
    released++;
    const r = await releaseBuffered(row, { reason: why }).catch((e) => ({
      released: false,
      error: String(e.message || e),
    }));
    if (r && r.released) out.reclaimed++;
  };

  for (const row of parked || []) {
    const key = slotKey(row.rentFarmGame, row.rentFarmDays);
    if (row.rentFarmRenewingAt) {
      haveKey.add(key); // in flight, or held: never a slot for a fresh account
      if (isStaleLease(row)) await settleStaleLease(row);
      continue;
    }
    const want = wanted.get(key);
    const failures = Number(row.rentFarmRenewFailures) || 0;
    let why;
    if (!canRenew) {
      why = "expired unsold and the buffer is not renewing (off, dry run or Gameflip not configured) — returning the account";
    } else if (!want) {
      if (!catalogueKnown) {
        haveKey.add(key); // cannot tell — keep it parked for now
        continue;
      }
      why = (cat.dark || []).some((g) => slotKey(g, row.rentFarmDays) === key)
        ? "expired unsold and " + row.rentFarmGame + " has had no Twitch Drops " +
          "campaign in " + DARK_GAME_DAYS + " days — returning the account"
        : "expired unsold and no longer in the catalogue — returning the account";
    } else if (haveKey.has(key)) {
      why = "expired unsold and its slot is live again — returning the account";
    } else if (failures >= RENEW_MAX_FAILURES) {
      why = "renewal failed " + failures + " time(s) — returning the account";
    } else {
      if (cap === null) cap = await freeSlots();
      if (cap.ok && cap.totalFree < cfg.reserve) {
        // The floor wins. Renewing keeps a slot a paid order may need; below
        // the reserve the unsold offer gives it back instead. An unreadable
        // capacity is no reason to release — renewal takes no NEW slot.
        why =
          "expired unsold while free slots (" + cap.totalFree + ") are under the " +
          cfg.reserve + " reserve — returning the account so a paid order can have its slot";
      } else {
        haveKey.add(key); // pending renewal: not a slot for a fresh account
        if (stop || published >= cfg.perPass) continue; // a later pass
        published++;
        const r = await renewExpired(row, want);
        if (r.renewed) {
          out.renewed++;
          out.live++;
          continue;
        }
        if (r.stop) stop = "renewal hit a Gameflip limit: " + r.reason;
        if (!r.release) {
          noteReason(key, "renewal " + (r.held ? "held" : "failed (retried next pass)") + ": " + r.reason);
          continue;
        }
        haveKey.delete(key);
        why = "expired offer cannot be renewed (" + r.reason + ") — returning the account";
      }
    }
    await release(row, why);
  }

  for (const row of await strandedRows(cfg.perPass, { releaseLane: true }).catch(() => [])) {
    await release(row, "offer is " + row.status + " — reclaiming the buffered account");
  }
  return { published, stop };
}

// A renewal cut off mid-publish (its lease went stale). If a RECORDED listing
// row — live or sold — or a rent-farm order already names the account, the
// renewal did finish and only the handover write was lost: finish it here.
// Otherwise the account stays HELD (claimed, on its bot, not on sale, not in
// the pool) and a human is paged once per lease: a listing may exist on
// Gameflip with no row, live or already sold, and only a look at Gameflip can
// say which. Nothing here ever releases or re-publishes a held account.
async function settleStaleLease(row) {
  const poolId = String(row.rentFarmPoolId || "");
  const since = new Date(row.rentFarmRenewingAt);
  let other = null;
  let order = null;
  try {
    other = await MarketplaceListing.findOne(
      {
        _id: { $ne: row._id },
        marketplace: MARKET,
        rentFarm: true,
        $or: [
          { rentFarmPoolId: poolId },
          ...(row.accountLogin ? [{ accountLogin: row.accountLogin, createdAt: { $gte: since } }] : []),
        ],
      },
      { externalId: 1, status: 1 },
    ).lean();
    if (!other && row.accountLogin) {
      order = await FarmServiceOrder.findOne(
        { market: MARKET, "accounts.login": row.accountLogin, createdAt: { $gte: since } },
        { orderId: 1 },
      ).lean();
    }
  } catch (e) {
    return { held: true, reason: "reconcile read failed: " + e.message };
  }
  if (other || order) {
    await MarketplaceListing.updateOne(
      { _id: row._id, rentFarmPoolId: poolId, rentFarmRenewingAt: row.rentFarmRenewingAt },
      {
        $set: {
          rentFarmPoolId: "",
          rentFarmRenewingAt: null,
          lastError:
            "expired unsold — renewed as " + (other ? other.externalId : "order " + order.orderId) +
            " (handover finished by reconcile)",
        },
      },
    ).catch(() => {});
    return { resolved: true };
  }
  if (!row.rentFarmRenewStaleAlertedAt) {
    await alertBufferStopped(
      "renewal-interrupted",
      "pool " + poolId + " / " + (row.accountLogin || "?") + ": renewal of " +
        (row.externalId || row._id) + " was cut off mid-publish; no recorded listing names " +
        "the account. It is HELD (claimed, on its bot, off sale, out of the pool). Do not " +
        "clear anything by hand: first check Gameflip for ANY listing, live or sold, " +
        "carrying this login.",
    );
    await MarketplaceListing.updateOne(
      { _id: row._id, rentFarmRenewStaleAlertedAt: null },
      { $set: { rentFarmRenewStaleAlertedAt: new Date() } },
    ).catch(() => {});
  }
  return { held: true };
}

// Can this parked account be sold again as it is? Everything a live offer
// needs: readable credentials, a pool row we still hold, and the account still
// farming on the holder's bot with a working token. Anything short of that goes
// back to the pool instead of back on sale.
async function renewalHealth(poolId) {
  const creds = await poolCredentials(poolId);
  if (!creds || !creds.login || !creds.password || !creds.clientSecret) {
    return { ok: false, reason: "no readable credentials" };
  }
  const pool = await AvailableAccount.findById(poolId, { status: 1, manualSold: 1 }).lean();
  if (!pool || pool.status !== "claimed") {
    return { ok: false, reason: "pool row is no longer claimed" };
  }
  if (pool.manualSold) return { ok: false, reason: "account was sold by hand" };
  const acct = await RenterAccount.findOne({ clientSecret: creds.clientSecret }).lean();
  const holder = await Renter.findOne(
    { usernameLower: operatorFarm.OPERATOR_USERNAME },
    { _id: 1 },
  ).lean();
  if (!acct || !holder || String(acct.renter) !== String(holder._id)) {
    return { ok: false, reason: "account is not on the holder's bot any more" };
  }
  if (acct.enabled === false || !acct.configFile || acct.farmEndedAt) {
    return { ok: false, reason: "account is not farming" };
  }
  if (acct.lastScanStatus === "token_invalid") {
    return { ok: false, reason: "account token is dead" };
  }
  return { ok: true, creds };
}

// A short, unique reference for a renewed listing's delivery code. Gameflip
// refuses a listing whose digital-goods code is identical to one already on
// another of our listings ("code for digital goods already exists") — and the
// expired listing still carries the old code.
// FIXED per expired row (not random): if an earlier attempt's listing went
// live without being recorded, a retry carries the very same code and Gameflip
// refuses it as a duplicate — a crash can never put the same credentials in
// two live listings. It differs from the expired listing's own code (which is
// the original, or an earlier renewal's) so the renewal itself is accepted.
function renewalRef(row) {
  return "R" + String((row && row._id) || "").slice(-8).toUpperCase();
}

// Relist an offer that EXPIRED unsold, with the SAME account. The row keeps
// owning the account the whole time (a LEASE, not a cleared pointer):
//   1. lease the row (one renewal at a time; nothing releases a leased row);
//   2. push the placeholder window out BEFORE the new listing can sell;
//   3. publish, with a unique ref line in the code;
//   4. record the new row (a lost acknowledgement is detected, not re-delisted);
//   5. only then hand the account to the new row and drop the lease.
// Any failure before 5 ends the lease and counts a failure (retried next pass);
// a live listing that could not be recorded keeps the lease and pages.
// Returns { renewed } | { release: true, reason } | { reason, stop? }.
async function renewExpired(row, want) {
  const poolId = String(row.rentFarmPoolId || "");
  const term =
    TERMS.find((t) => t.days === want.days) || {
      days: want.days,
      label: want.days + " Days",
      priceUsd: want.priceUsd,
    };
  let health;
  try {
    health = await renewalHealth(poolId);
  } catch (e) {
    // A failed READ is not evidence the account is bad — retry next pass.
    return { reason: "health read failed: " + String((e && e.message) || e).slice(0, 120) };
  }
  if (!health.ok) return { release: true, reason: health.reason };
  const creds = health.creds;

  // The lease stamp is ours (not read back from the update): whatever the
  // driver returns, every later write is keyed on exactly this value. A new
  // lease re-arms the stale-lease page.
  const leaseAt = new Date();
  let lease;
  try {
    lease = await MarketplaceListing.findOneAndUpdate(
      {
        _id: row._id,
        status: "removed",
        rentFarmPoolId: poolId,
        rentFarmExpiredAt: { $ne: null },
        rentFarmRenewingAt: null,
      },
      { $set: { rentFarmRenewingAt: leaseAt, rentFarmRenewStaleAlertedAt: null } },
    );
  } catch (e) {
    return { reason: "could not take the renewal lease: " + String((e && e.message) || e).slice(0, 120) };
  }
  if (!lease) return { reason: "the row changed meanwhile" };
  // Hold: keep the lease (nothing releases or re-publishes a leased row) and
  // say why. Used when a listing with these credentials may exist unrecorded.
  const hold = async (why) => {
    await MarketplaceListing.updateOne(
      { _id: row._id, rentFarmRenewingAt: leaseAt },
      { $set: { lastError: ("renewal HELD: " + why).slice(0, 400), rentFarmRenewStaleAlertedAt: new Date() } },
    ).catch(() => {});
    await alertBufferStopped(
      "renewal-held",
      "pool " + poolId + " / " + creds.login + ": " + why + " The account is HELD (claimed, " +
        "on its bot, off sale, out of the pool). Check Gameflip for ANY listing, live or sold, " +
        "carrying this login before clearing anything.",
    );
    return { held: true, reason: why };
  };

  // End the lease after a failure, counting it. The row never stopped owning
  // the account; if even this write fails the lease stays (a stale lease pages)
  // — say so now rather than let it be silent.
  const failed = async (reason) => {
    try {
      await MarketplaceListing.updateOne(
        { _id: row._id, rentFarmRenewingAt: leaseAt },
        {
          $set: { rentFarmRenewingAt: null, lastError: ("renewal failed: " + reason).slice(0, 400) },
          $inc: { rentFarmRenewFailures: 1 },
        },
      );
    } catch (e) {
      await alertBufferStopped(
        "renewal-bookkeeping",
        "pool " + poolId + " / " + creds.login + ": renewal failed (" + String(reason).slice(0, 120) +
          ") and its row could not be updated (" + String((e && e.message) || e).slice(0, 80) +
          "). The row still owns the account; its lease will page again when stale.",
      );
    }
  };

  let stamped;
  try {
    stamped = await restampWindow(creds.clientSecret, BUFFER_WINDOW_DAYS);
  } catch (e) {
    const reason = "placeholder restamp failed: " + String((e && e.message) || e).slice(0, 120);
    await failed(reason);
    return { reason };
  }
  if (!stamped || !stamped.ok) {
    // The account left the holder between the health read and now: never put
    // an account that is on no bot back on sale.
    const reason = "account is no longer on the holder's bot (restamp matched nothing)";
    await failed(reason);
    return { release: true, reason };
  }

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
      autoDeliverCode:
        bufferedDeliveryCode(creds.login, creds.password, term.days, want.game) +
        "\n\nOffer ref: " + renewalRef(row),
    });
  } catch (e) {
    const reason = String((e && e.message) || e).slice(0, 300);
    if (/already exists/i.test(reason)) {
      // This renewal's code (fixed per row) is already on one of our
      // listings: an earlier attempt most likely went live without being
      // recorded. Selling it again would be two live listings — hold.
      return await hold("Gameflip already has a listing with this renewal's code (an earlier attempt went live unrecorded?).");
    }
    await failed(reason);
    return { reason, stop: /429|too many|rate/i.test(reason) };
  } finally {
    if (cover) await fsp.unlink(cover).catch(() => {});
  }

  try {
    await createBufferedRow({
      marketplace: MARKET,
      externalId: r.externalId,
      url: r.url || "",
      title,
      description: offerDescription(want.game, term),
      price: term.priceUsd,
      status: "active",
      origin: "manual",
      note: "rent-farm buffer (renewed after expiry): " + creds.login,
      autoDeliver: true,
      qtyRemaining: 0,
      accountLogin: creds.login,
      rentFarm: true,
      rentFarmGame: want.game,
      rentFarmDays: term.days,
      rentFarmPoolId: poolId,
    });
  } catch (e) {
    const reason = String((e && e.message) || e).slice(0, 200);
    // A write can succeed while its acknowledgement is lost: look before
    // taking a recorded listing down.
    let exists;
    try {
      exists = await MarketplaceListing.findOne(
        { marketplace: MARKET, externalId: r.externalId },
        { _id: 1 },
      ).lean();
    } catch {
      // Cannot tell whether it was recorded: taking a recorded listing down, or
      // leaving an unrecorded one up, are both wrong. Hold and ask.
      return await hold("renewed listing " + r.externalId + " is live, and whether it was recorded could not be read.");
    }
    if (!exists) {
      let delisted = false;
      try {
        await mp.gameflipDelist(r.externalId);
        delisted = true;
      } catch (de) {
        console.error(
          "gameflip buffer: could not delist renewed listing " + r.externalId +
            " after a failed row write:",
          de.message,
        );
      }
      if (delisted) {
        await failed("renewed listing could not be recorded (" + reason + "); it was delisted");
        return { reason: "could not record the renewed listing: " + reason };
      }
      // Live, sellable, and no row names it. The lease STAYS, so nothing
      // releases the account while that listing sells it.
      return await hold("renewed listing " + r.externalId + " is LIVE AND SELLABLE with no row (" + reason.slice(0, 80) + "); take it down on Gameflip.");
    }
  }

  // The new row owns the account now; the old one lets go and ends its lease.
  try {
    await MarketplaceListing.updateOne(
      { _id: row._id, rentFarmPoolId: poolId },
      {
        $set: {
          rentFarmPoolId: "",
          rentFarmRenewingAt: null,
          lastError: "expired unsold — renewed as " + r.externalId,
        },
      },
    );
  } catch (e) {
    // The new row is recorded and owns the account; the old one could not let
    // go. It stays leased (nothing releases it), and once the lease goes stale
    // settleStaleLease finds the new row and finishes the handover itself.
    console.error(
      "gameflip buffer: renewal handover of " + (row.externalId || row._id) + " -> " +
        r.externalId + " failed (finished automatically later):",
      (e && e.message) || e,
    );
  }
  logEvent({
    category: "marketplace",
    action: "gameflip_buffer_renewed",
    actor: "gameflip-buffer",
    subject: want.game,
    count: 1,
    detail:
      title + " $" + term.priceUsd + " — " + creds.login + " relisted as " +
      r.externalId + " (was " + (row.externalId || row._id) + ", expired unsold)",
  }).catch(() => {});
  return { renewed: true, externalId: r.externalId };
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
    // A rate limit fails every remaining publish the same way — stop the pass.
    if (/429|too many|rate/i.test(reason)) {
      out.stopped = "Gameflip rate limit: " + reason.slice(0, 120);
      lastPass.stopped = out.stopped;
      return "stop";
    }
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
  // Only the rent-farm holder's row: a token that has since moved to another
  // renter must never have THAT renter's window rewritten by a Gameflip sale or
  // renewal (a 300-day lease cut to a 120-day term). No holder, no match.
  const holder = await Renter.findOne(
    { usernameLower: operatorFarm.OPERATOR_USERNAME },
    { _id: 1 },
  ).lean();
  if (!holder) return { ok: false, farmUntil };
  const r = await RenterAccount.updateOne(
    { clientSecret, renter: holder._id },
    { $set: { farmUntil, farmEndedAt: null } },
  );
  return {
    ok: !!(r && (r.matchedCount || r.n)),
    farmUntil,
  };
}

// A buffered offer sold. Called by utils/gameflipFulfiller when a rentFarm row
// goes sold, BEFORE the DropSet-scoped auto-delivery lane it must never reach.
async function onBufferedSale(rowIn, { alert = true } = {}) {
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
    // (The watcher pages the first failure; the retry sweep only its last.)
    if (alert) {
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
    }
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

  // 1. The window the buyer actually bought — unless an earlier attempt got as
  // far as recording the sale (it died on the very last write): that window
  // stands, a retry must not push it later each time.
  let stamped;
  const already = await FarmServiceOrder.findOne({ orderId }, { accounts: 1 }).lean().catch(() => null);
  const priorUntil = already && already.accounts && already.accounts[0] && already.accounts[0].farmUntil;
  if (priorUntil) {
    stamped = { ok: true, farmUntil: new Date(priorUntil) };
  } else {
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
  }
  if (!stamped.ok) {
    return fail(
      "no RenterAccount holds token for " + (creds.login || poolId) +
        " — the account is not farming, so the buyer is getting nothing",
    );
  }
  // Sold — but is the account really on a bot? (B6) The sale is recorded
  // either way (the buyer has the credentials); an account that is on no bot
  // or disabled is paged so it can be put back ("Farm days" re-places it).
  const onBot = await RenterAccount.findOne(
    { clientSecret: creds.clientSecret },
    { configFile: 1, enabled: 1 },
  )
    .lean()
    .catch(() => null);
  const offBot = onBot && (!onBot.configFile || onBot.enabled === false);

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
  if (offBot) {
    await farmAlert
      .alertFarmFailure({
        market: MARKET,
        orderId,
        offerTitle: row.title || "",
        game,
        days,
        qty: 1,
        logins: [creds.login],
        // Gameflip handed the buyer the login at payment: this is a delivered
        // order that is not farming, never "NOT delivered" (that wording invites
        // a second hand-over or a refund).
        kind: "not_farming",
        reason:
          "sold and recorded, but " + creds.login + " is " +
          (onBot.enabled === false ? "disabled on its bot" : "on NO bot config") +
          " — the buyer's window is running while nothing farms it. Put it back with " +
          "\"Farm days\" on /renters.html.",
      })
      .catch(() => {});
  }

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

// A sale that died half-way (pm2 restart, a Mongo hiccup between the claim and
// the stamp) is resumable — its claim is a lease that keeps the pool id — but
// only if something calls onBufferedSale again: the watcher sees each row go
// sold ONCE. This finds those rows (rent-farm, sold, pool id still set, lease
// lapsed) and finishes them: on the buffer's 15-minute clock, at most
// SALE_RETRY_MAX attempts per sale (~2 h), paging on the first and the last
// only — the health page keeps showing whatever is left.
const SALE_RETRY_MAX = 8;
async function retryUnfinishedSales({ limit = 10 } = {}) {
  const cutoff = new Date(Date.now() - SALE_LEASE_MS);
  const rows = await MarketplaceListing.find({
    rentFarm: true,
    status: "sold",
    rentFarmPoolId: { $nin: ["", null] },
    rentFarmSaleAttempts: { $not: { $gte: SALE_RETRY_MAX } },
    // Recent sales only. Every attempt bumps updatedAt, so a sale being retried
    // stays inside this window for all of its attempts; a row sold long ago that
    // still names an account is a human's to look at, never something to
    // "finish" — re-stamping it could re-open a window that was ended on purpose.
    updatedAt: { $gte: new Date(Date.now() - SALE_SWEEP_MAX_AGE_MS) },
    $or: [
      { rentFarmSaleClaimedAt: null },
      { rentFarmSaleClaimedAt: { $exists: false } },
      { rentFarmSaleClaimedAt: { $lte: cutoff } },
    ],
  })
    .sort({ updatedAt: 1 })
    .limit(limit);
  const out = { retried: 0, finished: 0, failed: 0 };
  for (const row of rows) {
    const attempt = (Number(row.rentFarmSaleAttempts) || 0) + 1;
    await MarketplaceListing.updateOne({ _id: row._id }, { $inc: { rentFarmSaleAttempts: 1 } }).catch(() => {});
    out.retried++;
    try {
      // The watcher already paged this sale's first failure; the sweep pages
      // once more, when it gives up.
      const r = await onBufferedSale(row, { alert: attempt >= SALE_RETRY_MAX });
      if (r && r.error) out.failed++;
      else if (r && !r.skipped) out.finished++;
    } catch (e) {
      out.failed++;
      console.error("gameflip rent-farm sale retry " + row.externalId + ":", e.message);
    }
  }
  return out;
}

// LIVE offers whose account cannot deliver (B6): hand-sold, back in the pool,
// gone, on no bot, disabled, or a dead token. They keep selling until someone
// acts, and the health page's red card is not a page. Latched per offer: one
// Telegram, a reminder daily while it stays live. Nothing is delisted here —
// taking an offer down stays a human decision (Listings page). A read that
// could not be completed alerts nothing (it would only be a guess).
const BAD_OFFER_REMIND_MS = 24 * 60 * 60 * 1000;
const badOfferAlerted = new Map(); // listingId -> ms
async function alertBadLiveOffers({ notify = true } = {}) {
  const state = await bufferState();
  if ((state.unreadable || []).length) return { skipped: "partial read", unreadable: state.unreadable };
  const now = Date.now();
  const live = new Set((state.problems || []).map((p) => p.listingId));
  for (const k of [...badOfferAlerted.keys()]) if (!live.has(k)) badOfferAlerted.delete(k);
  const toPage = (state.problems || []).filter((p) => {
    const last = badOfferAlerted.get(p.listingId);
    return !last || now - last >= BAD_OFFER_REMIND_MS;
  });
  if (notify && toPage.length) {
    for (const p of toPage) badOfferAlerted.set(p.listingId, now);
    let msg =
      "⚠️ " + toPage.length + " LIVE Gameflip rent-farm offer(s) sell an account that cannot deliver:\n" +
      toPage
        .slice(0, 15)
        .map((p) => "• " + (p.externalId || p.listingId) + " — " + (p.game || "?") + " " + (p.days || "?") + "d — " +
          (p.login || "?") + ": " + p.problem)
        .join("\n") +
      (toPage.length > 15 ? "\n… and " + (toPage.length - 15) + " more" : "") +
      "\n\nTake it down on the Listings page (the buffer republishes the slot with a healthy account" +
      ((state.dark || []).length
        ? " — except for games with no Twitch campaign lately: " + state.dark.slice(0, 10).join(", ")
        : "") +
      ").";
    if (msg.length > 3800) msg = msg.slice(0, 3799) + "…";
    await require("./telegram").sendTelegram(msg).catch(() => {});
  }
  return { paged: notify ? toPage.length : 0, problems: (state.problems || []).length };
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
      // Never while a renewal holds the row: its new listing may be live with
      // these credentials.
      rentFarmRenewingAt: null,
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
  const back = await handBackToPool(poolId, reason, { burned: !!opts.burned }).catch((e) => ({
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
    // Catalogue games with no Twitch campaign in DARK_GAME_DAYS: no new or
    // renewed offers for them (their live ones stay up).
    dark: [],
    catalogue: { total: 0, truncated: false },
    live: [],
    sold: [],
    missing: [],
    stranded: [],
    // Expired-unsold offers waiting for their same-account renewal.
    renewing: 0,
    // Renewals cut off mid-publish: the account is held until a human checks
    // Gameflip (never released or re-published automatically).
    held: [],
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
      // `ran` is corrected below from DURABLE evidence: this counter is
      // module-level memory, so any process that did not itself run a pass sees
      // null here — including a health run or a console request served by a
      // different process from the scheduler. Reading it raw made the check
      // announce "no top-up pass has run yet" while 55 offers were demonstrably
      // published, which is the same class of mistake as a verdict drawn from a
      // join that never loaded.
      ran: !!lastPass.at,
      // Whether the answer came from this process's own memory or from the rows
      // on disk, so a reader can tell how much the timestamp is worth.
      source: lastPass.at ? "this process" : "unknown",
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
  // DURABLE PROOF A PASS HAS RUN. A published buffered row could only have been
  // written by topUpBuffer, so the newest one dates the last successful pass
  // even in a process that has never run one itself.
  if (!lastPass.at) {
    const newest = await MarketplaceListing.findOne(
      { marketplace: MARKET, rentFarm: true },
      { createdAt: 1 },
    )
      .sort({ createdAt: -1 })
      .lean()
      .catch(() => null);
    if (newest && newest.createdAt) {
      state.lastPass.at = newest.createdAt;
      state.lastPass.ran = true;
      state.lastPass.source = "newest published offer";
    } else {
      state.notes.push(
        "No top-up pass has run and no buffered offer exists, so per-slot " +
          "failure reasons below are the structural ones only.",
      );
    }
  }

  // A read that FAILED is recorded as unreadable, never swallowed into an
  // empty list: an empty live list made the critical check say "ok" while it
  // had seen nothing (B11).
  const [cat, liveRows] = await Promise.all([
    desiredCatalogue().catch((e) => {
      state.unreadable.push("catalogue: " + String((e && e.message) || e).slice(0, 120));
      return { games: [], wanted: [], total: 0, truncated: false };
    }),
    liveBufferRows().catch((e) => {
      state.unreadable.push("live offers: " + String((e && e.message) || e).slice(0, 120));
      return [];
    }),
  ]);
  state.games = cat.games;
  state.dark = cat.dark || [];
  state.catalogue = { total: cat.total, truncated: !!cat.truncated };
  if (state.dark.length) {
    state.notes.push(
      state.dark.length + " catalogue game(s) have had no Twitch Drops campaign " +
        "in " + DARK_GAME_DAYS + " days, so they get no new or renewed offers " +
        "(live ones stay up until they sell or expire): " + state.dark.join(", ") + ".",
    );
  }
  if (cat.campaignsUnknown && (cat.games || []).length) {
    state.notes.push(
      "Twitch campaign history could not be read — no game is treated as dark " +
        "this pass.",
    );
  }
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
    .catch((e) => {
      state.unreadable.push("sold offers: " + String((e && e.message) || e).slice(0, 120));
      return [];
    });
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
  let deadRows = [];
  try {
    deadRows = await strandedRows(MAX_BUFFER_ROWS);
  } catch (e) {
    state.unreadable.push("dead rows: " + String((e && e.message) || e).slice(0, 120));
  }
  // Expired-unsold rows waiting for their renewal are not stuck — they are the
  // normal 30-day cycle. A renewal cut off mid-publish is HELD and needs a
  // human (the next pass will NOT return it — see settleStaleLease). The rest
  // are genuinely stranded, and the next pass returns them.
  state.renewing = deadRows.filter((r) => isRenewing(r)).length;
  state.held = deadRows
    .filter((r) => isStaleLease(r))
    .map((r) => ({
      externalId: r.externalId,
      login: r.accountLogin || "",
      poolId: String(r.rentFarmPoolId || ""),
      since: r.rentFarmRenewingAt || null,
    }));
  state.stranded = deadRows.filter((r) => !isRenewing(r) && !isStaleLease(r)).map(
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
  gamesWithRecentCampaigns,
  campaignHistory,
  DARK_GAME_DAYS,
  offerTitle,
  offerDescription,
  bufferedDeliveryCode,
  // the four
  topUpBuffer,
  onBufferedSale,
  retryUnfinishedSales,
  SALE_RETRY_MAX,
  alertBadLiveOffers,
  _resetBadOfferAlerts: () => badOfferAlerted.clear(),
  releaseBuffered,
  bufferState,
  // exported for tests and for the tracker's own capacity line
  config,
  renewsOnExpiry,
  renewExpired,
  isRenewing,
  isStaleLease,
  RENEW_MAX_FAILURES,
  RENEW_LEASE_MS,
  freeSlots,
  roomForOneMore,
  slotKey,
  handBackToPool,
  // testing seam: the in-memory pass log and the alert latch
  _reset: () => {
    lastPass = { at: null, reasons: new Map(), stopped: "" };
    reserveAlerted = false;
    poolReserveAlerted = false;
    capUnreadableAlertedAt = 0;
    keyCooldown.clear();
  },
};
