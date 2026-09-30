// ---------------------------------------------------------------------------
// Bulk packs — the marketplace adapter (docs/bulk-packs/MODULES.md, markets.js).
//
// The ONLY bulk-packs module that calls utils/marketplaces.js (`mp`) or
// publishes anything. send.js, loop.js and the router go through here, so the
// rules that have cost real money when they broke live in one place:
//
//   * Unit semantics (docs/bulk-packs/PACKS-2.md §1, replacing CONTRACT §2).
//     A bulk listing is ONE item priced as the WHOLE pack of N (= the tier's
//     `minQty`) accounts, on every market. Eldorado / G2G: quantity = the
//     number of PACKS on offer, minQuantity / minQty = 1, price = the pack
//     price; one unit bought is N accounts (utils/bulkPacks/packMath.js is the
//     one place that multiplies). Gameflip: one listing is ONE pack of exactly
//     N accounts, every credential inside its auto-delivery code. Every title
//     must say "PACK OF N", and a pack price that reads like one account's
//     price is refused — PlayerAuctions order 16474028 shipped 11 accounts for
//     $5 because a quantity meant something else.
//   * Nothing is published on a closed delivery gate (CONTRACT I4), on a
//     blocked market (Plati / GGSel, owner block since 2026-09-28), or under a
//     title the farm services would misread (CONTRACT I5) — an account title
//     that says "Automatic Farming" has its orders taken by the farm service,
//     and a farm title the parser cannot read is money taken with nothing
//     delivered.
//   * A title or description longer than the connector keeps is refused, not
//     published cut: the end that would be cut is the bulk terms.
//   * A failed or empty READ is "unknown" — never "gone" / "expired".
//   * An error from a take-off-sale call is never swallowed. It is re-thrown
//     with `outcome` ("gone" / "sold" / "", mp.delistOutcome) attached for the
//     caller to judge, the way the Listings delist route does
//     (routes/marketplaceRoutes.js:1750-1808). A release must only ever follow
//     a removal the platform confirmed (utils/noclaimListings.js:19-23).
//
// Each publish path mirrors a live publisher:
//   eldorado accounts  utils/autoLister.js:973-1030   publishEldoradoShare
//   g2g accounts       utils/autoLister.js:1043-1115  publishG2gShare
//   gameflip pack      utils/unclaimedLots.js:118-123, :303-309 (the lot code)
//                      + utils/gameflipFulfiller.js:166-183, :311-317
//                        (gameflipDeliveryCode, the password read)
//   no-claim           routes/marketplaceRoutes.js:1019-1124 -> the ctx handed
//                      to utils/noclaimListings.js:435 publishNoclaim
//   farm eldorado      scripts/eldorado-farm-listings.js:80-93, :164-193
//   farm g2g           scripts/g2g-farm-listings.js:111-131, :177-188
//
// Refusals made BEFORE any marketplace write throw an Error whose `code` is
// "BULK_PACK_REFUSED": nothing was published, nothing needs undoing. EVERY
// error a publish function throws also carries `outcome` — "not_created" or
// "may_be_live" — and `externalId` when the market's id is known
// (docs/bulk-packs/FIXES-1.md S2/S5; see "Publish outcomes" below).
//
// Dependencies are lazy and injectable (CONTRACT §9): __setDeps(partial) /
// __resetDeps(). Only node built-ins load with this file, so requiring it
// never pulls in a marketplace connector, a model or the settings file.
// ---------------------------------------------------------------------------
const path = require("path");
// Pure (no I/O): the one place packs and accounts are converted.
const { packsFor } = require("./packMath");

// Between two accounts in a Gameflip pack's delivery code — the divider
// utils/unclaimedLots.js:54 (LOT_SEPARATOR) already uses for its lots.
const PACK_SEPARATOR = "\n\n=====\n\n";

// Gameflip's limit on an auto-delivery code is not documented anywhere we have:
// gameflipPublish (utils/marketplaces.js:333-339) PUTs {code} to
// /listing/{id}/digital_goods with no length check, and the only other
// multi-account code (utils/unclaimedLots.js buildLotCode) has never been
// published live — lots ship dark. So the contract's cap stands: 10000
// characters, refused above it, never truncated. One real block (the
// "ACCOUNT i of n" header + gameflipDeliveryCode, ~493 chars for a 15-char
// login and 14-char password) plus the divider is ~517 characters, so about 19
// accounts fit; the default tiers (5 and 10) use ~2.6k and ~5.2k.
const GAMEFLIP_CODE_MAX = 10000;

// marketplaces.gameflipPublish refuses anything under 75 cents (:288-291).
const GAMEFLIP_MIN_PRICE = 0.75;

const ACCOUNT_MARKETS = ["eldorado", "g2g", "gameflip"];
// No-claim and farming packs in v1 (CONTRACT §1): never Gameflip.
const QTY_MARKETS = ["eldorado", "g2g"];
// Owner block since 2026-09-28 (both seller accounts are blocked by the
// platforms). Refused whatever the settings say.
const BLOCKED_MARKETS = ["digiseller", "plati", "ggsel"];

// What each connector silently cuts a title / description to.
//   title:       eldoradoPublish :4609 (160), g2gPublish :3158 (128),
//                gameflipPublish :300 (120)
//   description: eldoradoPublish :4610 (2000), g2gPublish :3159 (5000),
//                gameflipPublish :301 (5000)
const TITLE_LIMIT = { eldorado: 160, g2g: 128, gameflip: 120 };
const DESC_LIMIT = { eldorado: 2000, g2g: 5000, gameflip: 5000 };

// The farm services' own order test — the same literal as
// utils/eldoradoFarmService.js:36 and utils/g2gFarmService.js:38.
const FARM_TITLE_RE = /\bAutomatic\s+Farming\b/i;
// How the farm services split the game out of a title
// (utils/eldoradoFarmService.js:99, utils/g2gFarmService.js:62).
const TWITCH_DROPS_SPLIT = /\s+Twitch\s+Drops\b/i;

// scripts/eldorado-farm-listings.js:51-55 — the farm cover's footer lines.
const FARM_BULLETS = [
  "Fully Automated Farming",
  "Account-Safe and Undetectable",
  "Reliable Daily Rewards",
];

const LABELS = {
  eldorado: "Eldorado",
  g2g: "G2G",
  gameflip: "Gameflip",
  digiseller: "Plati",
  plati: "Plati",
  ggsel: "GGSel",
};

// Eldorado's own words for an offer's state, as this codebase has seen them:
//   Active   buyable — marketplaces.js:4785, eldoradoFulfiller.js:775/1075,
//            docs/ELDORADO-INTEGRATION-PLAN.md:49 ("Server fills in on create")
//   Paused   our pause — marketplaces.js:4772, eldoradoFulfiller.js:786,
//            docs/ELDORADO-INTEGRATION-PLAN.md:71
//   Expired / Deleted   off sale — scripts/reconcile-listing-status.js:74-76.
//            Offers die ~21 days after they were last activated
//            (eldoradoFulfiller.js:1034-1043); a DELETED offer's read 404s
//            (docs/ELDORADO-INTEGRATION-PLAN.md:73), which is a failed read.
// Anything else is "unknown": a guessed "expired" retires (and later releases)
// the accounts behind an offer that may still be on sale.
const ELDORADO_STATES = {
  active: "active",
  paused: "paused",
  expired: "expired",
  deleted: "gone",
};

// G2G_STATUS (marketplaces.js:2633-2634): "live" and "delisted" are the only
// statuses we set or have seen, so nothing else is mapped.
const G2G_STATES = { live: "active", delisted: "paused" };

// ---------------------------------------------------------------------------
// Dependencies (CONTRACT §9)
// ---------------------------------------------------------------------------

const REAL_DEPS = {
  mp: () => require("../marketplaces"),
  config: () => require("./config"),
  settings: () => require("../settings"),
  g2gGames: () => require("../g2gGames"),
  setImage: () => require("../setImage"),
  listingGame: () => require("../listingGame"),
  listingCategory: () => require("../listingCategory"),
  noclaimListings: () => require("../noclaimListings"),
  // The real farm-title parser (CONTRACT I5). Its termToDays is the one the
  // Eldorado farm service reads orders with; the G2G service's copy (via
  // utils/playerauctionsFarmService.js:48) is identical.
  farmParser: () => require("../eldoradoFarmService"),
  gameflipDeliveryCode: () => require("../gameflipFulfiller").gameflipDeliveryCode,
  decrypt: () => require("../secretBox").decrypt,
  BotAccount: () => require("../../models/BotAccount"),
  DropLog: () => require("../../models/DropLog"),
  MarketplaceListing: () => require("../../models/MarketplaceListing"),
  fs: () => require("fs"),
  fsp: () => require("fs/promises"),
};

let injected = {};
let loaded = {};

function d(name) {
  if (Object.prototype.hasOwnProperty.call(injected, name)) return injected[name];
  if (!Object.prototype.hasOwnProperty.call(loaded, name)) {
    const make = REAL_DEPS[name];
    if (!make) throw new Error("bulkPacks/markets: unknown dependency " + name);
    loaded[name] = make();
  }
  return loaded[name];
}

function __setDeps(partial) {
  if (!partial || typeof partial !== "object") return;
  injected = { ...injected, ...partial };
}

function __resetDeps() {
  injected = {};
  loaded = {};
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function refuse(message) {
  const err = new Error(message);
  err.code = "BULK_PACK_REFUSED";
  return err;
}

function msgOf(e) {
  return String((e && e.message) || e || "unknown error");
}

function normMarket(m) {
  return String(m == null ? "" : m)
    .trim()
    .toLowerCase();
}

function label(m) {
  return LABELS[m] || m || "this marketplace";
}

// The market, normalised, or a refusal. Blocked markets get their own answer.
function marketFor(market, allowed, what) {
  const m = normMarket(market);
  if (BLOCKED_MARKETS.includes(m)) {
    throw refuse(
      label(m) +
        " is blocked by the owner (its seller account is blocked) — nothing is " +
        "listed, fed or changed there",
    );
  }
  if (!allowed.includes(m)) {
    throw refuse((m ? label(m) : "No marketplace") + " is not supported for " + what);
  }
  return m;
}

// An offer id, or a refusal. Never act on a blank id: a pause of
// "/offers/undefined" answers 404, which reads as "already gone".
function offerIdOf(externalId) {
  const id = externalId == null ? "" : String(externalId).trim();
  if (!id) throw refuse("No marketplace offer id — refusing to act on an unknown offer");
  return id;
}

function round2(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function wholeAtLeast(v, min, what) {
  const n = typeof v === "string" && v.trim() === "" ? NaN : Number(v);
  if (!Number.isInteger(n) || n < min) {
    throw refuse(what + " must be a whole number of at least " + min + " (got " + v + ")");
  }
  return n;
}

function positivePrice(v, what) {
  const n = typeof v === "string" && v.trim() === "" ? NaN : Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw refuse(what + " must be a price above $0 (got " + v + ")");
  }
  return n;
}

// The price Eldorado will really charge for one unit (one pack): marketplaces.js
// eldPrice (:4572-4576) rounds to cents and lifts to ELD_MIN_PRICE ($0.50).
// Sending it pre-applied changes nothing on Eldorado and keeps the recorded
// price honest.
function eldoradoPrice(price) {
  const mp = d("mp");
  const floor = Number(mp.ELD_MIN_PRICE) > 0 ? Number(mp.ELD_MIN_PRICE) : 0.5;
  return Math.max(floor, round2(price));
}

// g2gPublish REJECTS a sub-floor price, so the floor is applied here and
// carried onto what we record — utils/autoLister.js:1069-1072.
function g2gPrice(price) {
  const mp = d("mp");
  const floor = Number(mp.G2G_MIN_PRICE) > 0 ? Number(mp.G2G_MIN_PRICE) : 1;
  return Math.max(floor, round2(price));
}

function normWords(s) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

// Title + description limits and the farm-title rule (CONTRACT I5).
function checkCopy(market, title, description, { farm }) {
  if (typeof title !== "string" || !title.trim()) throw refuse("A title is required");
  if (title.length > TITLE_LIMIT[market]) {
    throw refuse(
      label(market) + " cuts titles at " + TITLE_LIMIT[market] + " characters and this one has " +
        title.length + " — refusing to publish a cut title (the cut end is the bulk terms)",
    );
  }
  const desc = description == null ? "" : String(description);
  if (desc.length > DESC_LIMIT[market]) {
    throw refuse(
      label(market) + " cuts descriptions at " + DESC_LIMIT[market] + " characters and this one has " +
        desc.length + " — refusing to publish a cut description",
    );
  }
  const farmTitle = FARM_TITLE_RE.test(title);
  if (farm && !farmTitle) {
    throw refuse(
      'A farming offer\'s title must contain "Automatic Farming": the farm services find ' +
        "their orders by it, so without it a sale would never be delivered",
    );
  }
  if (!farm && farmTitle) {
    throw refuse(
      'An account offer\'s title must not contain "Automatic Farming": the farm services ' +
        "would take its orders (CONTRACT I5)",
    );
  }
}

// PACKS-2 §3: the listing IS the pack. A title that does not say "PACK OF N"
// sells N accounts at what reads like the price of one — every buyer would
// dispute it — so it is refused here, whoever built it.
function checkPackTitle(market, title, n) {
  if (!new RegExp("\\bPACK\\s+OF\\s+" + n + "\\b", "i").test(String(title || ""))) {
    throw refuse(
      label(market) + ' pack titles must say "PACK OF ' + n + '": the listing is ONE pack of ' +
        n + " accounts, and a buyer must see that before paying",
    );
  }
}

// PACKS-2 §3: `packPrice` is what ONE unit (one pack) costs — the only price
// sent to any market. `unitPrice`, when given, is its per-account equivalent;
// a pack under three quarters of N of those is a per-account price passed as
// the pack price (a whole pack sold for about one account's price) and is
// refused. Rounding and the floors never come near that line.
function checkPackPrice(market, packPrice, unitPrice, n) {
  const pack = positivePrice(packPrice, "packPrice (the price of one pack)");
  const each = Number(unitPrice);
  if (Number.isFinite(each) && each > 0 && pack < 0.75 * each * n) {
    throw refuse(
      "A pack of " + n + " priced $" + round2(pack).toFixed(2) + " with $" + round2(each).toFixed(2) +
        " per account does not add up — refusing a pack price that reads like one account's " +
        "(one unit on " + label(market) + " is the whole pack of " + n + ")",
    );
  }
  return pack;
}

// The same read-back the farm services do on every order (CONTRACT I5), minus
// the database-bound canonical-game lookup send.js runs before this.
function checkFarmRoundTrip(title, game, days) {
  let parsed;
  try {
    parsed = Number(d("farmParser").termToDays(title));
  } catch (e) {
    throw refuse("The farm-title parser is unavailable (" + msgOf(e) + ") — nothing was published");
  }
  if (parsed !== days) {
    throw refuse(
      "The farm services would read this title as " + parsed + " days, not " + days +
        " — refusing (CONTRACT I5)",
    );
  }
  const raw = String(title).split(TWITCH_DROPS_SPLIT)[0].trim();
  if (normWords(raw) !== normWords(game)) {
    throw refuse(
      'The farm services would read this title\'s game as "' + raw + '", not "' + game +
        '" — refusing (CONTRACT I5)',
    );
  }
}

// CONTRACT I4, checked at the one place anything is published. send.js checks
// it first; this is the boundary a mistaken caller cannot get past. An
// unreadable gate is a closed gate.
async function assertGate(market, source) {
  let gate = null;
  try {
    gate = await d("config").currentGate(market, source);
  } catch (e) {
    throw refuse(
      "The " + label(market) + " delivery gate could not be read (" + msgOf(e) +
        ") — nothing was published",
    );
  }
  if (!gate || gate.ok !== true) {
    throw refuse(
      label(market) + " delivery is not switched on for " + source + " offers" +
        (gate && gate.reason ? " — " + gate.reason : ""),
    );
  }
}

// utils/autoLister.js:984-989 / :1055-1060: a claimed drop is worthless to the
// buyer of a no-claim game, so the claimed archive never backs its listing.
function isNoClaimGame(game) {
  if (!game) return false;
  const s = d("settings");
  return typeof s.isNoClaimGame === "function" ? !!s.isNoClaimGame(game) : false;
}

// Attach the platform's verdict to a take-off-sale failure without deciding
// anything on it (routes/marketplaceRoutes.js:1750-1808 does the deciding).
function withOutcome(e) {
  const err = e instanceof Error ? e : new Error(msgOf(e));
  let outcome = "";
  try {
    const mp = d("mp");
    outcome = typeof mp.delistOutcome === "function" ? mp.delistOutcome(err.message) || "" : "";
  } catch {
    outcome = "";
  }
  err.outcome = outcome;
  return err;
}

// The row-less fallback cover the Listings publish route uses when no grid was
// built: routes/marketplaceRoutes.js:366-383 coverImagePath, replicated because
// it is private to the router. Returns a file INSIDE public/ — never delete it.
const PUBLIC_DIR = path.join(__dirname, "..", "..", "public");

function fallbackCover(set) {
  try {
    const fs = d("fs");
    const withImg = ((set && set.items) || []).find(
      (i) => i && typeof i.image === "string" && i.image.startsWith("/"),
    );
    const img = withImg ? withImg.image : "";
    if (img) {
      const p = path.normalize(path.join(PUBLIC_DIR, img));
      if (p.startsWith(PUBLIC_DIR) && fs.existsSync(p)) return p;
    }
    const def = path.join(PUBLIC_DIR, "listing-default-cover.png");
    return fs.existsSync(def) ? def : "";
  } catch {
    return "";
  }
}

// A publish the platform accepted must come back with an id. Without one the
// offer may be live with nothing on our side able to address it — say so
// loudly rather than record an empty externalId.
function published(market, r, price, title) {
  const externalId = r && (r.externalId || r.id) ? String(r.externalId || r.id) : "";
  if (!externalId) {
    const msg =
      label(market) + " accepted the publish but returned no offer id — check the seller " +
      'panel by hand for an orphan offer titled "' + String(title || "") + '"';
    console.error("bulkPacks/markets: " + msg);
    throw new Error(msg);
  }
  return { externalId, url: (r && r.url) || "", price };
}

function checkUnits(units) {
  if (!Array.isArray(units) || !units.length) throw refuse("No accounts to put on the offer");
  const ids = new Set();
  const logins = new Set();
  const out = [];
  for (const u of units) {
    const accountId = u && u.accountId != null ? String(u.accountId).trim() : "";
    const login = u && u.login != null ? String(u.login).trim() : "";
    if (!accountId || !login) throw refuse("Every account on an offer needs its id and login");
    const key = login.toLowerCase();
    if (ids.has(accountId) || logins.has(key)) {
      throw refuse("Account " + login + " is on this offer twice — one account is one unit");
    }
    ids.add(accountId);
    logins.add(key);
    out.push({ accountId, login });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Set / game / covers
// ---------------------------------------------------------------------------

// The game a set is about. utils/listingGame is the codebase's one canonical
// set -> game chain (set.game, set.coverGame — which the auto-lister stamps
// from task.game, utils/autoLister.js:1931 — then the first item's game); the
// Listings publish route uses it for the same question (marketplaceRoutes.js:1019).
function gameOfSet(set) {
  if (!set || typeof set !== "object") return "";
  try {
    return String(d("listingGame").listingGame({ set }) || "").trim();
  } catch {
    return "";
  }
}

// {packSize, discountPct} for the pack cover builders, or null when the caller
// asked for no pack cover (no packSize >= 2).
function packCoverOpts(opts) {
  const n = Math.floor(Number(opts && opts.packSize));
  if (!Number.isFinite(n) || n < 2) return null;
  const dp = Number(opts.discountPct);
  return { packSize: n, discountPct: Number.isFinite(dp) && dp > 0 ? dp : 0 };
}

// setImage's pack cover builders (PACKS-2 §5) arrive with a later change:
// reached lazily, and "" (never a throw) when absent, failing or empty, so the
// caller falls back to today's cover.
async function packCover(fnName, args, what) {
  let si;
  try {
    si = d("setImage");
  } catch (e) {
    console.error("bulkPacks/markets: setImage unavailable for the " + what + ":", msgOf(e));
    return "";
  }
  if (!si || typeof si[fnName] !== "function") return "";
  try {
    const p = await si[fnName](...args);
    return typeof p === "string" && p ? p : "";
  } catch (e) {
    console.error("bulkPacks/markets: " + what + " failed (falling back to the plain cover):", msgOf(e));
    return "";
  }
}

// The set's cover: a TEMP file the caller may delete when done, or "" when
// none could be built — the same try/catch-to-"" every caller of the builders
// uses (e.g. utils/autoLister.js:1340-1345). Never returns a file under
// public/. With opts.packSize (PACKS-2 §3/§5), setImage.buildBulkCoverImage
// (set, {packSize, discountPct}) — the grid with a "PACK OF N ACCOUNTS" banner
// and a "-D%" tag — when that builder exists; otherwise, or when it fails, the
// plain grid cover (utils/setImage.js:138 buildSetGridImage).
async function coverForSet(set, opts) {
  if (!set || typeof set !== "object") return "";
  const pack = packCoverOpts(opts);
  if (pack) {
    const p = await packCover("buildBulkCoverImage", [set, pack], "pack cover");
    if (p) return p;
  }
  try {
    return (await d("setImage").buildSetGridImage(set)) || "";
  } catch (e) {
    console.error("bulkPacks/markets: set cover failed:", msgOf(e));
    return "";
  }
}

// "1 Year" for 365 days, else "N Days" — the farm scripts' tier labels
// (scripts/eldorado-farm-listings.js:40-44).
function farmTermLabel(days) {
  const n = Number(days);
  return n === 365 ? "1 Year" : n + " Days";
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// scripts/eldorado-farm-listings.js:80-93, verbatim in intent: the game's most
// common cached drop images. Bounded by maxTimeMS; no allowDiskUse (I12).
async function gameDropImages(game, limit) {
  const re = new RegExp("^" + escapeRe(game) + "$", "i");
  const rows = await d("DropLog").aggregate(
    [
      { $match: { game: re, imageLocal: { $ne: "" } } },
      { $group: { _id: "$imageLocal", accounts: { $sum: 1 } } },
      { $sort: { accounts: -1 } },
      { $limit: Math.max(1, Math.min(60, limit || 30)) },
    ],
    { maxTimeMS: 20000 },
  );
  return (rows || []).map((r) => r && r._id).filter(Boolean);
}

// The farming promo cover, exactly as scripts/eldorado-farm-listings.js:170-176
// builds it (utils/setImage.js:365 buildPromoCoverImage). `days` is optional:
// with it the subtitle is the term ("120 Days Service"), as in the script.
// With opts.packSize (PACKS-2 §3/§5), setImage.buildBulkFarmCoverImage(game,
// days, {packSize, discountPct}) — the promo cover with the pack banner and the
// term — when that builder exists (it is also handed the drop images this
// function found, as `itemImages`); otherwise, or when it fails, the plain
// promo cover. Returns a TEMP file (the caller may delete it), or "" on
// failure.
async function coverForFarm(game, days, opts) {
  const g = String(game || "").trim();
  if (!g) return "";
  let itemImages = [];
  try {
    itemImages = await gameDropImages(g, 30);
  } catch {
    itemImages = [];
  }
  const pack = packCoverOpts(opts);
  if (pack) {
    // No images found here: the builder looks them up itself.
    const packOpts = itemImages.length ? { ...pack, itemImages: itemImages.slice() } : pack;
    const p = await packCover(
      "buildBulkFarmCoverImage",
      [g, Number(days) > 0 ? Number(days) : 0, packOpts],
      "farm pack cover",
    );
    if (p) return p;
  }
  try {
    return (
      (await d("setImage").buildPromoCoverImage({
        title: g + " Twitch Drops Automatic Farming",
        serviceText: Number(days) > 0 ? farmTermLabel(days) + " Service" : "",
        bullets: FARM_BULLETS.slice(),
        itemImages,
        twitchTiles: true,
      })) || ""
    );
  } catch (e) {
    console.error("bulkPacks/markets: farm cover failed for " + g + ":", msgOf(e));
    return "";
  }
}

// ---------------------------------------------------------------------------
// Gameflip pack code
// ---------------------------------------------------------------------------

// One code, N blocks: "ACCOUNT i of n\n" + gameflipDeliveryCode(login,
// password), joined by PACK_SEPARATOR. Credentials are read from BotAccount
// exactly the way the reservation read them (utils/eldoradoFulfiller.js:115-121:
// login || credUsername, decrypt(credPassword)). All-or-nothing: an account
// that is missing, has no readable password or no longer carries the login we
// reserved refuses the whole pack — a short pack is never published.
async function packCode(units) {
  for (const u of units) {
    if (!/^[a-f0-9]{24}$/i.test(u.accountId)) {
      throw refuse("Account " + u.login + " has no valid account id — the pack cannot be built");
    }
  }
  const rows = await d("BotAccount")
    .find(
      { _id: { $in: units.map((u) => u.accountId) } },
      { login: 1, credUsername: 1, credPassword: 1 },
    )
    .lean();
  const byId = new Map((rows || []).map((a) => [String(a._id), a]));
  const decrypt = d("decrypt");
  const deliveryCode = d("gameflipDeliveryCode");
  const n = units.length;
  const blocks = [];
  for (let i = 0; i < n; i++) {
    const u = units[i];
    const acc = byId.get(u.accountId);
    if (!acc) {
      throw refuse("Account " + u.login + " no longer exists — the pack cannot be delivered");
    }
    const login = acc.login || acc.credUsername || "";
    if (!login || String(login).trim().toLowerCase() !== u.login.toLowerCase()) {
      throw refuse(
        "Account " + u.login + " no longer carries that login — refusing to deliver a " +
          "credential that does not match the offer's records",
      );
    }
    let password = "";
    try {
      password = decrypt(acc.credPassword) || "";
    } catch {
      password = "";
    }
    if (!password) {
      throw refuse("Account " + u.login + " has no readable password — cannot auto-deliver");
    }
    blocks.push("ACCOUNT " + (i + 1) + " of " + n + "\n" + deliveryCode(login, password));
  }
  const code = blocks.join(PACK_SEPARATOR);
  if (!code.trim()) throw refuse("The pack's delivery code came out empty");
  if (code.length > GAMEFLIP_CODE_MAX) {
    throw refuse(
      "A pack of " + n + " accounts needs a " + code.length + "-character delivery code, over " +
        "the " + GAMEFLIP_CODE_MAX + " this module will send to Gameflip — use a smaller tier",
    );
  }
  return code;
}

// ---------------------------------------------------------------------------
// Publish outcomes (docs/bulk-packs/FIXES-1.md S2/S5)
// ---------------------------------------------------------------------------
//
// What a failed publish left behind decides whether the caller may hand the
// accounts back ("not_created") or must HOLD them ("may_be_live"): releasing
// accounts a live offer still sells is how one account sells twice. The
// verdict follows the connector STEP the error came from — the same status
// means opposite things at different steps. Line numbers: utils/marketplaces.js.
//
//   Nothing sent yet (a refusal, a DB read, a cover) -> not_created.
//   Gameflip, gameflipPublish :280-431
//     keys :127-137, "Gameflip minimum price is $0.75" :289-291, the POST
//     "Gameflip create: …" :295-325 -> not_created: no listing id exists, and
//     anything the POST made is a codeless draft nobody can buy.
//     "could not attach the delivery content (draft ID discarded)" :340-357 and
//     "Gameflip created ID but could not put it on sale (draft discarded)"
//     :408-426 -> listing ID EXISTS, and its discard is .catch(() => {}): the
//     status patch may have landed with every credential attached. So
//     mp.gameflipDelist(ID) (draft, then delete, :940-961): resolves ->
//     not_created; HTTP 404 -> not_created (Gameflip has no such listing — the
//     discard took; gameflipFulfiller.js:1001-1006 releases on that same 404);
//     anything else (429, sold, …) -> may_be_live + ID.
//   G2G, g2gPublish :3077-3202
//     keys, brand, price, the shape/settings READS, the token refresh ->
//     not_created. "G2G create offer failed…" / "G2G create: no offer id…"
//     :3140-3150 -> not_created (the POST makes an empty shell: price 0, qty 0).
//     "G2G publish offer failed…" (the PUT that fills the shell and sets it
//     live, :3186-3189): an ANSWERED rejection — 4xx, or G2G's in-band error
//     code :2786-2794 — -> not_created; a 5xx, a timeout or a dropped
//     connection may have been applied (the codebase's own rule,
//     utils/noclaimListings.js:305-313 writeMaybeLanded) -> may_be_live, no id
//     (the message does not carry it).
//     "G2G publish: offer ID did not read back as a live offer" :3195-3200 (the
//     PUT answered 200) -> mp.g2gDelist(ID) (:2932-2934): resolves ->
//     not_created; any failure -> may_be_live + ID.
//   Eldorado, eldoradoPublish :4581-4645
//     keys, title, cover, the game-slot READ, image upload, price, a session
//     refresh (the request it renews was refused) -> not_created. The create
//     POST "Eldorado publish failed…" (eldError :4347-4370): HTTP 4xx incl. 429
//     -> not_created; 5xx / no status / timeout -> may_be_live, no id.
//   No-claim: the layer answers {success:false, message} and drops the
//     error's status, so its MESSAGE is read (eldError / g2gError write
//     "failed (HTTP nnn)" into it). Its own refusals (utils/noclaimListings.js
//     :437-447, :683-720) -> not_created; its orphan "published on … delist it
//     by hand: ID" (:650-675) -> may_be_live + ID; the rest by the market rules.
//   The mp call returned, then something failed (no id, no row) -> may_be_live.
//   Anything unrecognised -> may_be_live: the wrong "not_created" releases
//   accounts a live offer still sells; the wrong "may_be_live" only holds them
//   until the owner has looked.
const NOT_CREATED = "not_created";
const MAY_BE_LIVE = "may_be_live";

const GF_ONSALE_RE = /Gameflip created (\S+) but could not put it on sale/;
const GF_DRAFT_RE = /draft (\S+) discarded/;
const GF_BEFORE_ID = [/^gameflip is not configured/i, /^Gameflip minimum price is/i, /^Gameflip create: /];

const G2G_READBACK_RE = /offer (\S+) did not read back/;
const G2G_PUT_RE = /^G2G publish offer failed/;
const G2G_CREATE_RE = /^G2G create(?: offer failed|: no offer id)/;
const G2G_BEFORE_CREATE = [
  /^g2g is not configured/i,
  /^G2G brand_id is required/,
  /^G2G needs /, // "a price above 0" :3098, or the attributes it lacks :3051-3064
  /^G2G's minimum price is/,
  /^G2G refresh/, // g2gRefreshAccess :2678-2724 — a token call, never the offer
  /^G2G (?:list offers|get offer|relation|collections|product settings) failed/,
  /^G2G: no product \(relation_id\)/,
  /^G2G: no delivery method available/,
];

const ELD_CREATE_RE = /^Eldorado publish failed/;
const ELD_BEFORE_CREATE = [
  /^eldorado is not configured/i,
  /^Eldorado: a title is required/,
  /^Eldorado: a cover image is required/,
  /^Eldorado: could not resolve a Twitch Drops game slot/,
  /^Eldorado image upload (?:failed|returned no paths)/,
  /^Eldorado: invalid price/,
  /^Eldorado session refresh failed/,
];

const NOCLAIM_BEFORE = [
  /^No-claim listings are switched off/,
  /^No-claim auto-delivery is switched off/,
  /is not supported for no-claim listings yet/,
  /^Not a no-claim listing/,
  /^Out of stock — no free no-claim account/,
  /^Could not count the no-claim stock right now/,
  /free account\(s\) for this bundle are already advertised/,
];
const NOCLAIM_ORPHAN_RE = /^published on .+? but the row could not be saved — delist it by hand: (\S+)/;

// The same words noclaimListings.writeMaybeLanded treats as "may have landed".
const TRANSPORT_RE = /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNABORTED|socket hang up|network/i;

// One publish call's progress: nothing sent / the market call made / it returned.
function publishTrace(market, kind) {
  return { market: normMarket(market), kind, sent: false, returned: false, externalId: "" };
}

async function sendPublish(t, call) {
  t.sent = true;
  const r = await call();
  t.returned = true;
  t.externalId = cleanId(r && (r.externalId || r.id));
  return r;
}

// An id worth addressing: never "", "undefined" or "null" (String(undefined)
// lands in messages when a response carried no id).
function cleanId(v) {
  const s = v == null ? "" : String(v).trim();
  return !s || /^(?:undefined|null)$/i.test(s) ? "" : s;
}

function judged(err, outcome, externalId, step, cleanup) {
  err.outcome = outcome;
  err.externalId = cleanId(externalId);
  err.publishStep = step;
  if (cleanup) err.cleanup = cleanup;
  return err;
}

// The HTTP status of a connector error: err.status (apiError, eldError,
// g2gError and AxiosError all set it), the response's, or the
// "failed (HTTP nnn)" eldError / g2gError write into the message. 0 = none.
function statusOf(e) {
  for (const v of [e && e.status, e && e.response && e.response.status]) {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 100 && n <= 599) return n;
  }
  const m = /\bfailed \(HTTP (\d{3})\)/.exec(msgOf(e));
  return m ? Number(m[1]) : 0;
}

// utils/noclaimListings.js:305-313: an answered 4xx was not applied; a 5xx, a
// timeout or a dropped connection may have been.
function writeMayHaveLanded(e) {
  const st = statusOf(e);
  if (st >= 400 && st < 500) return false;
  if (st >= 500) return true;
  return TRANSPORT_RE.test(msgOf(e)) || TRANSPORT_RE.test(String((e && e.code) || ""));
}

function delistVerdict(message) {
  try {
    const mp = d("mp");
    return typeof mp.delistOutcome === "function" ? mp.delistOutcome(message) || "" : "";
  } catch {
    return "";
  }
}

// The half-made Gameflip listing `id` is taken down with the real delist
// (draft, then delete). Only a delist that worked, or Gameflip saying it has
// no such listing, proves nobody can buy the pack's credentials.
async function gameflipTakeDown(err, id) {
  try {
    await d("mp").gameflipDelist(id);
  } catch (e) {
    const why = msgOf(e);
    if (statusOf(e) === 404) {
      err.message += " — listing " + id + " no longer exists on Gameflip (404): nothing is on sale";
      return judged(err, NOT_CREATED, id, "gameflip-listing", { tried: true, ok: true, error: why });
    }
    const verdict = delistVerdict(why);
    err.message +=
      verdict === "sold"
        ? " — Gameflip says listing " + id + " already SOLD: its buyer holds the pack's credentials"
        : " — taking listing " + id + " down failed too (" + why + "): it may be ON SALE with the " +
          "pack's credentials";
    console.error("bulkPacks/markets: Gameflip listing " + id + " may be live: " + err.message);
    return judged(err, MAY_BE_LIVE, id, "gameflip-listing", { tried: true, ok: false, error: why, verdict });
  }
  err.message += " — listing " + id + " was taken down again (draft + delete): nothing is on sale";
  return judged(err, NOT_CREATED, id, "gameflip-listing", { tried: true, ok: true, error: "" });
}

async function judgeGameflip(err) {
  const msg = msgOf(err);
  const hit = GF_ONSALE_RE.exec(msg) || GF_DRAFT_RE.exec(msg);
  if (hit) {
    const id = cleanId(hit[1]);
    // "created undefined": the patch and the code went to /listing/undefined,
    // so whatever the POST made is a codeless draft nobody can buy.
    if (!id) return judged(err, NOT_CREATED, "", "gameflip-listing");
    return gameflipTakeDown(err, id);
  }
  if (GF_BEFORE_ID.some((re) => re.test(msg))) return judged(err, NOT_CREATED, "", "gameflip-create");
  return judged(err, MAY_BE_LIVE, "", "gameflip-unknown");
}

// The G2G offer `id` answered the PUT but not the read-back: take it off sale
// with the real delist before anything may be released.
async function g2gTakeDown(err, id) {
  try {
    await d("mp").g2gDelist(id);
  } catch (e) {
    const why = msgOf(e);
    err.message += " — delisting offer " + id + " failed too (" + why + "): it may be LIVE";
    console.error("bulkPacks/markets: G2G offer " + id + " may be live: " + err.message);
    return judged(err, MAY_BE_LIVE, id, "g2g-readback", { tried: true, ok: false, error: why });
  }
  err.message += " — offer " + id + " was delisted: nothing is on sale";
  return judged(err, NOT_CREATED, id, "g2g-readback", { tried: true, ok: true, error: "" });
}

async function judgeG2g(err) {
  const msg = msgOf(err);
  const back = G2G_READBACK_RE.exec(msg);
  if (back) {
    const id = cleanId(back[1]);
    if (!id) return judged(err, MAY_BE_LIVE, "", "g2g-readback");
    return g2gTakeDown(err, id);
  }
  if (G2G_PUT_RE.test(msg)) {
    return judged(err, writeMayHaveLanded(err) ? MAY_BE_LIVE : NOT_CREATED, "", "g2g-put");
  }
  if (G2G_CREATE_RE.test(msg)) return judged(err, NOT_CREATED, "", "g2g-create");
  if (G2G_BEFORE_CREATE.some((re) => re.test(msg))) {
    return judged(err, NOT_CREATED, "", "g2g-before-create");
  }
  return judged(err, MAY_BE_LIVE, "", "g2g-unknown");
}

// The one request eldoradoPublish does not wrap in eldError: the trade-
// environment library READ behind eldoradoResolveGame (:4495-4506).
function isEldoradoLibraryRead(e) {
  const url = e && e.config && e.config.url;
  return typeof url === "string" && /\/api\/library\//.test(url);
}

function judgeEldorado(err) {
  const msg = msgOf(err);
  const create = ELD_CREATE_RE.test(msg);
  if (!create && (ELD_BEFORE_CREATE.some((re) => re.test(msg)) || isEldoradoLibraryRead(err))) {
    return judged(err, NOT_CREATED, "", "eldorado-before-create");
  }
  const st = statusOf(err);
  const step = create ? "eldorado-create" : "eldorado-unknown";
  return judged(err, st >= 400 && st < 500 ? NOT_CREATED : MAY_BE_LIVE, "", step);
}

async function judgeMarketError(market, err) {
  if (market === "gameflip") return judgeGameflip(err);
  if (market === "g2g") return judgeG2g(err);
  if (market === "eldorado") return judgeEldorado(err);
  return judged(err, MAY_BE_LIVE, "", "unknown");
}

async function judgeNoclaim(market, err) {
  const msg = msgOf(err);
  const orphan = NOCLAIM_ORPHAN_RE.exec(msg);
  if (orphan) {
    // "(the platform returned no id)" is orphanedPublish's no-id placeholder.
    const id = orphan[1].startsWith("(") ? "" : orphan[1];
    return judged(err, MAY_BE_LIVE, id, "noclaim-orphan");
  }
  if (NOCLAIM_BEFORE.some((re) => re.test(msg))) return judged(err, NOT_CREATED, "", "noclaim-before");
  return judgeMarketError(market, err);
}

// The error, with its verdict attached. Never throws, and a verdict it cannot
// reach is the safe one.
async function classifyPublish(e, t) {
  const err = e instanceof Error ? e : new Error(msgOf(e));
  if (err.outcome === NOT_CREATED || err.outcome === MAY_BE_LIVE) return err;
  if (!t.sent) return judged(err, NOT_CREATED, "", "before-publish");
  if (t.returned) return judged(err, MAY_BE_LIVE, t.externalId, "after-publish");
  try {
    return await (t.kind === "noclaim" ? judgeNoclaim(t.market, err) : judgeMarketError(t.market, err));
  } catch {
    return judged(err, MAY_BE_LIVE, "", "unjudged");
  }
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

// Dropset account packs. `units` = the accounts already RESERVED for this
// offer ([{accountId, login}], CONTRACT I1) — whole packs of `minQty` (the
// pack size N). `packPrice` is the price of ONE pack, the only price sent;
// `unitPrice` (optional) is its per-account equivalent, used only to catch a
// per-account price passed as the pack price. Returns {externalId, url, price};
// `price` is what the market really charges for one unit = one pack.
// Eldorado / G2G publish quantity = packs (units / N), minimum order 1; a
// Gameflip pack is exactly N accounts in one listing. A throw carries
// `outcome` / `externalId` (above).
async function publishAccounts(args) {
  const a = args || {};
  const t = publishTrace(a.market, "accounts");
  try {
    return await publishAccountsNow(a, t);
  } catch (e) {
    throw await classifyPublish(e, t);
  }
}

async function publishAccountsNow(
  { market, set, game, title, description, unitPrice, packPrice, minQty, units, coverPath },
  t,
) {
  const m = marketFor(market, ACCOUNT_MARKETS, "account packs");
  if (!set || typeof set !== "object") throw refuse("No drop set to publish");
  // Mirrors gameflipFulfiller.publishAutoDelivery's routing rule (:286-303): a
  // no-claim set's stock is the no-claim farm, never reserved archive accounts.
  if (set.stockSource === "noclaim") {
    throw refuse("A no-claim set sells through publishNoclaim, never from reserved archive accounts");
  }
  const g = String(game || "").trim();
  if (isNoClaimGame(g)) {
    throw refuse(
      g + " is a no-claim game — sellable only from the unclaimed farm, not the " +
        "auto-farm's claimed archive",
    );
  }
  const min = wholeAtLeast(minQty, 2, "minQty (the pack size)");
  const list = checkUnits(units);
  if (m === "gameflip" && list.length !== min) {
    throw refuse(
      "A Gameflip pack is exactly " + min + " accounts (one listing, one buyer) — got " + list.length,
    );
  }
  if (m !== "gameflip" && list.length < min) {
    throw refuse(
      "Only " + list.length + " account(s) for a pack of " + min +
        " — the offer could never be bought",
    );
  }
  if (m !== "gameflip" && list.length % min !== 0) {
    throw refuse(
      list.length + " accounts do not make whole packs of " + min +
        " — a partial pack can never be sold, so it is never put on offer",
    );
  }
  // What the market counts: packs (a Gameflip listing is always one).
  const packs = m === "gameflip" ? 1 : packsFor(list.length, min);
  checkCopy(m, title, description, { farm: false });
  checkPackTitle(m, title, min);
  const pack = checkPackPrice(m, packPrice, unitPrice, min);
  const mp = d("mp");

  if (m === "eldorado") {
    const priceUsd = eldoradoPrice(pack);
    // Eldorado rejects an offer without a main image; the Listings route falls
    // back the same way (marketplaceRoutes.js:1496-1508, gridImage || cover).
    const cover = coverPath || fallbackCover(set);
    if (!cover) throw refuse("Eldorado needs a cover image and none could be built for this set");
    await assertGate(m, "dropset");
    // utils/autoLister.js:997-1004, but one unit is one PACK (PACKS-2 §1):
    // quantity = packs, minimum order 1, the pack's price. No other extras:
    // autoLister sends none (deliveryTime stays the connector default).
    const r = await sendPublish(t, () =>
      mp.eldoradoPublish({
        game: g,
        title,
        description,
        priceUsd,
        quantity: packs,
        minQuantity: 1,
        coverImagePath: cover,
      }),
    );
    return published(m, r, priceUsd, title);
  }

  if (m === "g2g") {
    // The brand IS the game on G2G, and a game without a hand-checked brand is
    // skipped, never approximated (utils/autoLister.js:1036-1042, :1061-1062).
    const brand = d("g2gGames").brandForGame(g);
    if (!brand || !brand.brandId) throw refuse("no G2G brand for " + (g || "this game"));
    const priceUsd = g2gPrice(pack);
    await assertGate(m, "dropset");
    // utils/autoLister.js:1074-1085, one unit = one PACK: qty = packs,
    // min_qty 1. Relation, attributes and delivery method are left to
    // g2gPublish, as autoLister does.
    const r = await sendPublish(t, () =>
      mp.g2gPublish({
        serviceId: mp.G2G_ITEMS_SERVICE,
        brandId: brand.brandId,
        title,
        description,
        priceUsd,
        qty: packs,
        minQty: 1,
      }),
    );
    return published(m, r, priceUsd, title);
  }

  // Gameflip: ONE listing, ONE pack of exactly `min` accounts.
  const price = round2(pack);
  if (price < GAMEFLIP_MIN_PRICE) {
    throw refuse("Gameflip's minimum price is $" + GAMEFLIP_MIN_PRICE.toFixed(2));
  }
  await assertGate(m, "dropset");
  const code = await packCode(list);
  const cover = coverPath || fallbackCover(set);
  // utils/unclaimedLots.js:303-309. gameflipPublish TRIES to discard its own
  // draft on a failure after create (marketplaces.js:340-356, :408-426), but
  // swallows that delete's failure — so a throw from here is judged, and the
  // listing taken down again, by classifyPublish (above).
  const r = await sendPublish(t, () =>
    mp.gameflipPublish({
      title,
      description,
      priceUsd: price,
      imagePath: cover || undefined,
      autoDeliverCode: code,
    }),
  );
  return published(m, r, price, title);
}

// No-claim packs: the existing no-claim layer publishes (claim-at-sale shelf,
// its own row), handed the ctx the Listings publish route builds for a no-claim
// set (routes/marketplaceRoutes.js:1019, :1028-1074, :1093-1124). PACKS-2 §3:
// `quantity` is the number of PACKS of `minQty` (N) accounts, the minimum
// order is 1 and `packPrice` (one pack) is the price. Returns
// {rowId, externalId, url, price, quantity}; `quantity` is the packs the row
// says it advertises. The layer caps it by the set's share of the shelf
// counted in ACCOUNTS (utils/noclaimListings.js publishClaimAtSale), so a
// value below the packs asked for means the shelf shrank mid-publish and the
// caller must re-count before trusting it. A throw carries `outcome` /
// `externalId` (see "Publish outcomes").
async function publishNoclaim(args) {
  const a = args || {};
  const t = publishTrace(a.market, "noclaim");
  try {
    return await publishNoclaimNow(a, t);
  } catch (e) {
    throw await classifyPublish(e, t);
  }
}

async function publishNoclaimNow(
  { market, set, game, title, description, unitPrice, packPrice, quantity, minQty, coverPath },
  t,
) {
  const m = marketFor(market, QTY_MARKETS, "no-claim packs");
  if (!set || typeof set !== "object" || !set._id) throw refuse("No drop set to publish");
  if (set.stockSource !== "noclaim") {
    throw refuse("Not a no-claim set — it has no no-claim stock to deliver");
  }
  const min = wholeAtLeast(minQty, 2, "minQty (the pack size)");
  const qty = wholeAtLeast(quantity, 1, "quantity (packs on the offer)");
  checkCopy(m, title, description, { farm: false });
  checkPackTitle(m, title, min);
  const pack = checkPackPrice(m, packPrice, unitPrice, min);
  const priceUsd = m === "eldorado" ? eldoradoPrice(pack) : g2gPrice(pack);
  // marketplaceRoutes.js:1019 — listingGame({set, offer, game: body.game}).
  const pubGame = String(d("listingGame").listingGame({ set, game }) || "").trim();
  await assertGate(m, "noclaim");

  // marketplaceRoutes.js:1093-1108: a market that needs a category and whose
  // body names none gets one resolved server-side, or the publish is refused.
  const lc = d("listingCategory");
  let cat = {};
  if ((lc.MARKETS_NEEDING_CATEGORY || []).includes(m)) {
    const auto = await lc.resolveCategory(m, pubGame, { deps: { g2gGames: d("g2gGames") } });
    if (!auto || !auto.ok) {
      throw refuse(
        (auto && auto.reason) || "No " + m + " category could be resolved for this listing",
      );
    }
    cat = auto.value || {};
  }

  // The request body the route would have received; publishNoclaim reads only
  // the market's own block (noclaimListings.js:689-694, :733-744, :765-781).
  // One unit is one pack: quantity = packs, minimum order 1.
  const body = {
    setId: String(set._id),
    marketplaces: [m],
    title,
    description,
    price: priceUsd,
  };
  if (m === "eldorado") {
    body.eldorado = { quantity: qty, minQuantity: 1, game: pubGame };
  } else {
    body.g2g = { qty, minQty: 1 };
  }
  const ctx = {
    set,
    body,
    title,
    description,
    priceUsd,
    gridImage: coverPath || "",
    coverPath: fallbackCover(set),
    cat,
    pubGame,
  };
  t.sent = true;
  const r = await d("noclaimListings").publishNoclaim(m, ctx);
  if (!r || r.success !== true) {
    // Not a refusal: the layer's failure can come after the platform took the
    // offer (its orphanedPublish tells the owner to delist it by hand). Its
    // message is judged by classifyPublish.
    throw new Error((r && r.message) || "The no-claim publish failed");
  }
  t.returned = true;
  const rowId = cleanId(r.id);
  const externalId = cleanId(r.externalId);
  t.externalId = externalId;
  if (!rowId || !externalId) {
    const msg =
      "The no-claim layer reported success without a row or offer id (" +
      (externalId || "no offer id") + ") — check Listings by hand";
    console.error("bulkPacks/markets: " + msg);
    // may_be_live (classifyPublish: the call returned). The row the layer
    // saved, if any, is named so the caller can find it.
    throw Object.assign(new Error(msg), { rowId });
  }
  let advertised = qty;
  try {
    const row = await d("MarketplaceListing").findById(rowId, { qtyTarget: 1 }).lean();
    const n = Number(row && row.qtyTarget);
    if (row && Number.isFinite(n) && n > 0) advertised = n;
  } catch {
    advertised = qty;
  }
  if (advertised < qty) {
    console.error(
      "bulkPacks/markets: no-claim " + label(m) + " offer " + externalId + " went live advertising " +
        advertised + " of the " + qty + " pack(s) of " + min + " asked for — the no-claim layer " +
        "capped it by the shelf (counted in accounts): the shelf shrank between the check and " +
        "the publish, so the pack count must be re-checked",
    );
  }
  return { rowId, externalId, url: r.url || "", price: priceUsd, quantity: advertised };
}

// Farming packs: fresh accounts farming `game` for `days`, provisioned at sale
// by the existing farm services, which find the order by its TITLE (and, after
// PACKS-2 §2, provision purchaseQuantity x the offer's pack size). No row.
// `quantity` = packs of `minQty` (N) accounts, minimum order 1, `packPrice` =
// one pack. `discountPct` (optional) is the "-D%" the pack cover shows. A
// throw carries `outcome` / `externalId` (see "Publish outcomes").
async function publishFarm(args) {
  const a = args || {};
  const t = publishTrace(a.market, "farm");
  try {
    return await publishFarmNow(a, t);
  } catch (e) {
    throw await classifyPublish(e, t);
  }
}

async function publishFarmNow(
  { market, game, days, title, description, unitPrice, packPrice, quantity, minQty, discountPct },
  t,
) {
  const m = marketFor(market, QTY_MARKETS, "farming packs");
  const g = String(game || "").trim();
  if (!g) throw refuse("A farming offer needs its game");
  const term = wholeAtLeast(days, 1, "days");
  if (term > 730) throw refuse("days must be 730 or fewer (got " + days + ")");
  const min = wholeAtLeast(minQty, 2, "minQty (the pack size)");
  const qty = wholeAtLeast(quantity, 1, "quantity (packs on the offer)");
  checkCopy(m, title, description, { farm: true });
  checkPackTitle(m, title, min);
  checkFarmRoundTrip(title, g, term);
  const pack = checkPackPrice(m, packPrice, unitPrice, min);
  const mp = d("mp");

  if (m === "eldorado") {
    const priceUsd = eldoradoPrice(pack);
    await assertGate(m, "farm");
    const cover = await coverForFarm(g, term, { packSize: min, discountPct });
    if (!cover) {
      throw refuse("The farming cover could not be built — Eldorado rejects an offer without one");
    }
    try {
      // scripts/eldorado-farm-listings.js:177-185, one unit = one PACK:
      // quantity = packs, minimum order 1, the pack's price.
      const r = await sendPublish(t, () =>
        mp.eldoradoPublish({
          game: g,
          title,
          description,
          priceUsd,
          quantity: qty,
          minQuantity: 1,
          coverImagePath: cover,
          deliveryTime: "Minute20",
        }),
      );
      return published(m, r, priceUsd, title);
    } finally {
      // scripts/eldorado-farm-listings.js:192 — the promo cover is a temp file.
      await Promise.resolve()
        .then(() => d("fsp").unlink(cover))
        .catch(() => {});
    }
  }

  // G2G: brand + the offer shape resolved from our own offers
  // (scripts/g2g-farm-listings.js:111-131), then the create (:177-188).
  const brand = d("g2gGames").brandForGame(g);
  if (!brand || !brand.brandId) {
    throw refuse("no hand-checked G2G brand for " + g + " — never approximated");
  }
  const priceUsd = g2gPrice(pack);
  await assertGate(m, "farm");
  let shape;
  try {
    shape = await mp.g2gResolveOfferShape({ brandId: brand.brandId });
  } catch (e) {
    // Read-only: nothing was created.
    throw refuse("G2G cannot take a farming offer for " + g + ": " + msgOf(e));
  }
  if (!shape || !shape.relationId) {
    throw refuse("G2G has no product (relation) for " + g + " — nothing was published");
  }
  const r = await sendPublish(t, () =>
    mp.g2gPublish({
      serviceId: mp.G2G_ITEMS_SERVICE,
      brandId: brand.brandId,
      relationId: shape.relationId,
      offerAttributes: shape.attributes,
      collectionTree: shape.collectionTree,
      title,
      description,
      priceUsd,
      qty,
      minQty: 1,
    }),
  );
  return published(m, r, priceUsd, title);
}

// ---------------------------------------------------------------------------
// Live-offer controls
// ---------------------------------------------------------------------------

// Take an offer off sale, reversibly. Eldorado: /pause (mp.eldoradoDelist —
// idempotent on an already-Paused offer). G2G: status "delisted". A failure is
// re-thrown with `outcome` attached, never swallowed.
async function pause(market, externalId) {
  const m = marketFor(market, ACCOUNT_MARKETS, "pausing an offer");
  if (m === "gameflip") {
    throw refuse("A Gameflip pack has no pause — it is withdrawn (delisted), never paused");
  }
  const id = offerIdOf(externalId);
  const mp = d("mp");
  try {
    if (m === "eldorado") await mp.eldoradoDelist(id);
    else await mp.g2gDelist(id);
  } catch (e) {
    throw withOutcome(e);
  }
  return { ok: true };
}

// Put a paused offer back on sale. Putting stock on sale is a publish as far as
// CONTRACT I4 is concerned, so the market's delivery gate must be open: every
// source on Eldorado / G2G needs at least the market's own auto-deliver flags,
// which is what the "dropset" gate checks when the caller does not say which
// source the offer is (opts.source narrows it).
async function resume(market, externalId, opts = {}) {
  const m = marketFor(market, ACCOUNT_MARKETS, "resuming an offer");
  if (m === "gameflip") {
    throw refuse("A Gameflip pack is never relisted (CONTRACT I9)");
  }
  const id = offerIdOf(externalId);
  await assertGate(m, (opts && opts.source) || "dropset");
  const mp = d("mp");
  if (m === "eldorado") await mp.eldoradoRelist(id);
  else await mp.g2gRelist(id);
  return { ok: true };
}

// Set the advertised stock. A non-integer or negative count is refused rather
// than coerced: eldoradoSetQuantity turns NaN into 0 (marketplaces.js:4741).
async function setQuantity(market, externalId, n) {
  const m = marketFor(market, ACCOUNT_MARKETS, "changing an offer's quantity");
  if (m === "gameflip") {
    throw refuse("A Gameflip pack has no quantity — it is one pack of exactly its tier");
  }
  const id = offerIdOf(externalId);
  const q = typeof n === "string" && n.trim() === "" ? NaN : Number(n);
  if (!Number.isInteger(q) || q < 0) {
    throw refuse("quantity must be a whole number of 0 or more (got " + n + ") — nothing was changed");
  }
  const mp = d("mp");
  if (m === "eldorado") await mp.eldoradoSetQuantity(id, q);
  else await mp.g2gSetQuantity(id, q);
  return q;
}

// Take an offer down for good. Gameflip: mp.gameflipDelist (draft + delete),
// the first step of CONTRACT I9 — its failure (it may have SOLD) is re-thrown
// with `outcome` and the caller must then leave the row alone. Eldorado / G2G:
// a pause (offers there are never deleted — sales history survives).
async function withdraw(market, externalId) {
  const m = marketFor(market, ACCOUNT_MARKETS, "withdrawing an offer");
  if (m !== "gameflip") return pause(m, externalId);
  const id = offerIdOf(externalId);
  try {
    await d("mp").gameflipDelist(id);
  } catch (e) {
    throw withOutcome(e);
  }
  return { ok: true };
}

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// What the market says about an offer: {state, quantity, raw}. state is
// "active" | "paused" | "expired" | "gone" | "unknown". A failed or empty read
// is ALWAYS "unknown" — never "gone"/"expired" (a 429, a 401 or a dead session
// reads exactly like a missing offer). Gameflip is always "unknown": the
// Gameflip sync owns that row's status.
async function readOffer(market, externalId) {
  const m = marketFor(market, ACCOUNT_MARKETS, "reading an offer");
  const unknown = (extra) => ({ state: "unknown", quantity: null, raw: "", ...(extra || {}) });
  if (m === "gameflip") return unknown();
  const id = externalId == null ? "" : String(externalId).trim();
  if (!id) return unknown({ error: "no offer id" });
  const mp = d("mp");
  let offer = null;
  try {
    offer = m === "eldorado" ? await mp.eldoradoOffer(id) : await mp.g2gGetOffer(id);
  } catch (e) {
    return unknown({ error: msgOf(e) });
  }
  if (!offer || typeof offer !== "object") return unknown({ error: "empty read" });
  if (m === "eldorado") {
    const raw = String(offer.offerState || "").trim();
    return {
      state: ELDORADO_STATES[raw.toLowerCase()] || "unknown",
      quantity: numOrNull(offer.quantity),
      raw,
    };
  }
  // G2G: actual_qty is the stock G2G stores (marketplaces.js:2855-2858).
  const raw = String(offer.status || "").trim();
  return {
    state: G2G_STATES[raw.toLowerCase()] || "unknown",
    quantity: numOrNull(offer.actual_qty),
    raw,
  };
}

module.exports = {
  PACK_SEPARATOR,
  GAMEFLIP_CODE_MAX,
  gameOfSet,
  coverForSet,
  coverForFarm,
  publishAccounts,
  publishNoclaim,
  publishFarm,
  pause,
  resume,
  setQuantity,
  withdraw,
  readOffer,
  __setDeps,
  __resetDeps,
};
