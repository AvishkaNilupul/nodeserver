// Bulk packs — pure buyer copy: the titles and descriptions a bulk offer is
// published with (docs/bulk-packs/PACKS-2.md §3, CONTRACT.md I5, MODULES.md
// §copy.js).
//
// PACKS-2 (owner decision 2026-09-30): a bulk listing is ONE item priced as the
// whole pack, on every market. Every title says "PACK OF N ACCOUNTS" and every
// description says that each purchase is a pack of N separate accounts — a
// buyer must never read the pack price as the price of one account, nor set a
// quantity of 5 believing it means 5 accounts (it means 5 packs).
//
// PURE: no DB, no network. Every function returns text that is safe to publish
// on the named market as-is, or THROWS. The publishers cut an over-long title
// silently (utils/marketplaces.js: eldoradoPublish at 160, g2gPublish at 128,
// gameflipPublish at 120), and that cut would drop the "PACK OF N" part or the
// farming term, so a title is fitted here or refused here, never cut there.
//
// Two parsers read these titles back after a sale, and both are contracts:
//   * An ACCOUNT title must never match FARM_TITLE_RE (the farm services' own
//     /\bAutomatic\s+Farming\b/i). If it did, the rent-farm lane would take the
//     order and provision fresh farming accounts instead of handing over the
//     reserved ones.
//   * A FARM title is parsed by utils/eldoradoFarmService.js parseFarmOrder
//     (Eldorado) and utils/g2gFarmService.js parseFarmOrder (G2G, which uses
//     playerauctionsFarmService's termToDays/canonicalGame). Both read the term
//     with termToDays(title) and the game with
//     title.split(/\s+Twitch\s+Drops\b/i)[0].trim(). So the game leads the
//     title word for word (trimmed, never shortened), and nothing in it may
//     look like an earlier "N days" or a second "Twitch Drops". Whether the
//     game is one the farm KNOWS (canonicalGame against knownFarmGames, a DB
//     read) is send.js's round-trip, CONTRACT I5.
//
// Descriptions never carry a login or a password. The inputs hold none, and
// the credentials only reach a buyer through delivery, after the sale.
const {
  TITLE_MAX,
  DESC_MAX,
  FARM_TITLE_RE,
  SOURCE_MARKETS,
} = require("./config");
const { effectiveDiscount, round2 } = require("./pricing");
const { connectFirstOffer, GUARANTEE_ONCE_CONNECTED } = require("../farmHandover");

const DEFAULT_BASE = "Twitch Drops bundle";
const MARKET_NAMES = { eldorado: "Eldorado", g2g: "G2G", gameflip: "Gameflip" };

// Markets that carry account packs (dropset ∪ noclaim) and farming packs.
const ACCOUNT_MARKETS = [
  ...new Set([...SOURCE_MARKETS.dropset, ...SOURCE_MARKETS.noclaim]),
];
const FARM_MARKETS = SOURCE_MARKETS.farm;

// The settings allow farm durations of 1..730 days (CONTRACT §6).
const FARM_DAYS_MAX = 730;
// A truncated base shorter than this is not a title any more.
const MIN_BASE_ROOM = 12;
// Caps on free text inside a description, so its fixed sections always fit.
const DESC_GAME_MAX = 100;
const DESC_SET_MAX = 160;
const DESC_ITEM_MAX = 150;
const DESC_ITEMS_MAX = 300;

// termToDays takes the FIRST match of this pattern anywhere in the title
// (utils/eldoradoFarmService.js:40, utils/playerauctionsFarmService.js:50),
// and the game comes first, so a game such as "7 Days to Die" would be read as
// a 7-day term. Such a game cannot be sold with this title format at all.
const TERM_HAZARD_RE = /(\d+)\s*days?\b/i;
// The farm services cut the game at the first match of this
// (utils/eldoradoFarmService.js:99, utils/g2gFarmService.js:62).
const GAME_SPLIT_RE = /\s+Twitch\s+Drops\b/i;

// Every suffix this module appends, in any letter case, after an em dash, en
// dash or hyphen (in case a sanitiser flattened the dash):
//   " — PACK OF 5 ACCOUNTS (-5%)"   " — PACK OF 5 ACCOUNTS"   accountsTitle (v2)
//   " — PACK OF 5 ACCOUNTS"         " — PACK OF 5"            farmTitle (v2)
// and the v1 ones, still stripped so an old title never stacks a suffix:
//   " — BULK 5+ accounts (5% off)"  " — BULK 5+ accounts"
//   " — Bulk 5+ Accounts"           " — Bulk 5+"
const BULK_SUFFIX_RE =
  /\s*[—–-]\s*(?:bulk\s+\d+\s*\+(?:\s*accounts?)?(?:\s*\(\s*\d+(?:\.\d+)?\s*%\s*off\s*\))?|pack\s+of\s+\d+(?:\s+accounts?)?(?:\s*\(\s*[-−]\s*\d+(?:\.\d+)?\s*%\s*\))?)\s*$/i;

// Control characters and line/paragraph separators; a title is one line.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const CONTROL_RUN_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function str(v) {
  return v == null ? "" : String(v);
}

// One line, single spaces, trimmed.
function oneLine(v) {
  return str(v).replace(CONTROL_RUN_RE, " ").replace(/\s+/g, " ").trim();
}

function positiveInt(v, what) {
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string" && v.trim()
        ? Number(v)
        : NaN;
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      what + " must be a whole number of 1 or more (got " + str(v) + ")",
    );
  }
  return n;
}

// A pack holds at least two accounts: a "pack" of one is a single listing,
// which packMath.packSizeOf reads as one (the settings clamp tiers to 2..100).
function packSize(v) {
  const n = positiveInt(v, "minQty (the pack size)");
  if (n < 2) {
    throw new Error(
      "minQty (the pack size) must be 2 or more — a pack of one is a single listing",
    );
  }
  return n;
}

function requireMarket(market, allowed, what) {
  if (typeof market !== "string" || !allowed.includes(market)) {
    throw new Error(what + ' are not offered on "' + str(market) + '"');
  }
  return market;
}

// Never leave half of a UTF-16 surrogate pair at the end of a cut.
function dropLoneHighSurrogate(s) {
  return /[\uD800-\uDBFF]$/.test(s) ? s.slice(0, -1) : s;
}

// Shorten `base` with "…" so that it is at most `room` characters, preferring
// a word boundary and never ending on a dangling separator.
function fitBase(base, room) {
  if (room < MIN_BASE_ROOM) {
    throw new Error("the bulk suffix leaves no room for the title");
  }
  if (base.length <= room) return base;
  const hard = dropLoneHighSurrogate(base.slice(0, room - 1)); // 1 char for "…"
  let cut = hard;
  const space = cut.lastIndexOf(" ");
  if (space >= Math.floor(cut.length * 0.6)) cut = cut.slice(0, space);
  cut = cut.replace(/[\s,.;:|/+&(\[—–-]+$/, "");
  if (!cut) cut = hard.trimEnd();
  return cut + "…";
}

// ---------------------------------------------------------------------------
// titles — accounts
// ---------------------------------------------------------------------------

// Removes every suffix this module adds (repeatedly, in case one was stacked
// on another); anything else is left alone apart from outer whitespace.
function stripBulkSuffix(title) {
  let s = str(title).trim();
  for (let i = 0; i < 4; i += 1) {
    const next = s.replace(BULK_SUFFIX_RE, "").trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

// Every market (PACKS-2 §3): `${base} — PACK OF ${minQty} ACCOUNTS`, then
// " (-D%)" appended ONLY if it fits with the base whole — the discount tag is
// the optional part, and the base (what is in the bundle) is never cut to make
// room for it. A base too long for the pack suffix alone is shortened with "…"
// so the whole title fits TITLE_MAX[market]; the pack suffix is the part a
// buyer must see, so it is never the part cut. D is the discount the price is
// built with (pricing.js effectiveDiscount; for a custom price, the discount it
// really gives); "(-0%)" is never shown. THROWS if the title would read as a
// rent-farm title.
function accountsTitle({ baseTitle, market, minQty, discountPct } = {}) {
  requireMarket(market, ACCOUNT_MARKETS, "account packs");
  const n = packSize(minQty);
  const suffix = " — PACK OF " + n + " ACCOUNTS";
  const shown = round2(effectiveDiscount(discountPct));
  const tag = shown > 0 ? " (-" + shown + "%)" : "";
  const max = TITLE_MAX[market];
  const base = stripBulkSuffix(oneLine(baseTitle)) || DEFAULT_BASE;
  const title =
    tag && (base + suffix + tag).length <= max
      ? base + suffix + tag
      : fitBase(base, max - suffix.length) + suffix;
  if (title.length > max) {
    // Unreachable by construction; refuse rather than let the publisher cut.
    throw new Error(
      "bulk title is " + title.length + " characters, over " + market + "'s " + max,
    );
  }
  if (FARM_TITLE_RE.test(title)) {
    throw new Error(
      'an account-pack title must not read as a rent-farm title ("Automatic ' +
        'Farming"), or the farm service would take its orders: ' + title,
    );
  }
  return title;
}

// The title a set's bulk offer starts from: our own anchor listing's title
// (minus any bulk suffix), else the set's name, else "Twitch Drops bundle".
function baseTitleForSet({ set, anchorRow } = {}) {
  const fromRow = anchorRow ? stripBulkSuffix(oneLine(anchorRow.title)) : "";
  if (fromRow) return fromRow;
  const fromSet = set ? stripBulkSuffix(oneLine(set.name)) : "";
  return fromSet || DEFAULT_BASE;
}

// ---------------------------------------------------------------------------
// descriptions — accounts
// ---------------------------------------------------------------------------

function itemLines(items) {
  const out = [];
  for (const i of Array.isArray(items) ? items : []) {
    if (!i || typeof i !== "object") continue;
    const name = oneLine(i.name).slice(0, DESC_ITEM_MAX).trim();
    if (!name) continue;
    const q = Number(i.qty);
    out.push("- " + (Number.isInteger(q) && q > 1 ? q + "× " : "") + name);
  }
  return out;
}

function headingFor(game, setName) {
  if (setName) {
    if (game && !setName.toLowerCase().includes(game.toLowerCase())) {
      return game + " Twitch Drops — " + setName;
    }
    return setName;
  }
  return (game ? game + " " : "") + DEFAULT_BASE;
}

// PACKS-2 §3: every market says what ONE purchase is (a pack of N separate
// accounts); on the quantity markets it also says what a quantity is (packs).
function packLines(market, n) {
  const lines = [
    "PACK OF " + n + " ACCOUNTS — each purchase is a pack of " + n +
      " separate accounts.",
  ];
  if (market !== "gameflip") {
    lines.push(
      "Buying 2 = 2 packs (" + 2 * n + " accounts), 3 = 3 packs (" + 3 * n +
        " accounts), and so on.",
    );
  }
  return lines;
}

function composeAccounts({ market, source, n, heading, shown, hidden }) {
  const lines = packLines(market, n);
  lines.push("", heading, "", "Each account holds the whole bundle:");
  if (shown.length) {
    lines.push(...shown);
    if (hidden > 0) lines.push("- …and " + hidden + " more");
  } else if (hidden > 0) {
    lines.push("- " + hidden + " items (see the pictures)");
  } else {
    lines.push("- every item shown in the title and the pictures");
  }
  lines.push("");
  if (source === "noclaim") {
    lines.push(
      "Every drop is already earned (100%) and left unclaimed. On each " +
        "account you log in, link your own game account, then claim the " +
        "rewards yourself.",
    );
  } else {
    lines.push(
      "Every account is a separate Twitch account with ALL of the above " +
        "drops sitting unclaimed in its inventory. Log in, press Connect, and " +
        "claim everything to YOUR OWN game account.",
    );
  }
  lines.push("");
  if (market === "gameflip") {
    lines.push(
      "You receive " + n + " separate accounts: the delivery code lists them " +
        "one after another, and it is released the moment you pay.",
    );
  } else {
    lines.push(
      "Quantity = packs: a quantity of 1 is one pack of " + n + " accounts, " +
        "and every extra unit is one more pack of " + n + " accounts, each " +
        "with the whole bundle.",
      "",
      "Automatic delivery: the login details for every account in your order " +
        "arrive in the order chat.",
    );
  }
  lines.push(
    "",
    "💡 Every account is different, and each bundle can be claimed " +
      "once per game account — so " + n + " accounts are " + n +
      " full bundles for " + n + " different game accounts.",
    "",
    "⚜️ Please claim the drops within the first hour after delivery. " +
      "The accounts are guaranteed at the moment of delivery.",
    "",
    "💬 Any issue or question — message me here on " +
      MARKET_NAMES[market] +
      " before opening a dispute. I reply fast and always make it right.",
  );
  return lines.join("\n");
}

// Plain buyer copy for an account pack (source "dropset" or "noclaim"), at
// most DESC_MAX[market] characters: as many item lines as fit, then
// "…and N more". Says that each purchase is a pack of N separate accounts
// (every market), that a quantity counts packs — buying 2 = 2 packs
// (eldorado/g2g) — or that the code lists the N accounts (gameflip), that
// each account holds the whole bundle, and for no-claim stock that the buyer
// logs in, links their own game account and claims the rewards. Reads only
// the named fields, so credentials that ride along on the argument object can
// never reach the text.
function accountsDescription({
  setName,
  items,
  game,
  market,
  minQty,
  source,
} = {}) {
  if (source !== "dropset" && source !== "noclaim") {
    throw new Error(
      'accountsDescription covers account packs only (source "dropset" or ' +
        '"noclaim"), not "' + str(source) + '"',
    );
  }
  requireMarket(
    market,
    SOURCE_MARKETS[source],
    source === "noclaim" ? "no-claim packs" : "account packs",
  );
  const n = packSize(minQty);
  const heading = headingFor(
    oneLine(game).slice(0, DESC_GAME_MAX).trim(),
    oneLine(setName).slice(0, DESC_SET_MAX).trim(),
  );
  const all = itemLines(items);
  const lines = all.slice(0, DESC_ITEMS_MAX);
  const max = DESC_MAX[market];
  for (let k = lines.length; k >= 0; k -= 1) {
    const text = composeAccounts({
      market,
      source,
      n,
      heading,
      shown: lines.slice(0, k),
      hidden: all.length - k,
    });
    if (text.length <= max) return text;
  }
  // Unreachable with the caps above (the fixed copy is ~1,300 characters);
  // never hand the publisher more than the market takes.
  return composeAccounts({
    market,
    source,
    n,
    heading,
    shown: [],
    hidden: all.length,
  }).slice(0, max);
}

// ---------------------------------------------------------------------------
// farming packs
// ---------------------------------------------------------------------------

function farmDays(days) {
  const d =
    typeof days === "number"
      ? days
      : typeof days === "string" && days.trim()
        ? Number(days)
        : NaN;
  if (!Number.isInteger(d) || d < 1 || d > FARM_DAYS_MAX) {
    throw new Error(
      "days must be a whole number from 1 to " + FARM_DAYS_MAX +
        " (got " + str(days) + ")",
    );
  }
  return d;
}

// The term exactly as the farm listings spell it: "1 Year" for 365, else
// "N Days" (scripts/eldorado-farm-listings.js TIERS). termToDays reads both.
function farmTerm(days) {
  const d = farmDays(days);
  return d === 365 ? "1 Year" : d + " Days";
}

// The game, exactly as it must come back out of the farm services' parse.
function farmGame(game) {
  const raw = str(game);
  if (CONTROL_RE.test(raw)) {
    throw new Error("the game name must be a single line of text");
  }
  const g = raw.trim();
  if (!g) throw new Error("a farming pack needs a game");
  const term = g.match(TERM_HAZARD_RE);
  if (term) {
    throw new Error(
      'the game "' + g + '" contains "' + term[0] + '", which the farm ' +
        "services would read as the farming term — a farm title cannot " +
        "carry this game",
    );
  }
  if (GAME_SPLIT_RE.test(g)) {
    throw new Error(
      'the game "' + g + '" contains "Twitch Drops", where the farm services ' +
        "cut the game name off",
    );
  }
  return g;
}

// `${game} Twitch Drops Automatic Farming ${farmTerm(days)} — PACK OF ${minQty} ACCOUNTS`
// (PACKS-2 §3). If that is over TITLE_MAX[market], " ACCOUNTS" is dropped; if
// it is still over, THROWS — the game cannot be shortened, or the farm could
// not resolve it. The pack words carry no "N days" and no "Twitch Drops", so
// the farm services still read the game and the term exactly (CONTRACT I5).
// Only markets that carry farming packs (eldorado, g2g).
function farmTitle({ game, days, minQty, market } = {}) {
  requireMarket(market, FARM_MARKETS, "farming packs");
  const g = farmGame(game);
  const term = farmTerm(days);
  const n = packSize(minQty);
  const max = TITLE_MAX[market];
  const short = g + " Twitch Drops Automatic Farming " + term + " — PACK OF " + n;
  const full = short + " ACCOUNTS";
  if (full.length <= max) return full;
  if (short.length <= max) return short;
  throw new Error(
    "the farm title for " + g + " is " + short.length + " characters even " +
      "without \" ACCOUNTS\", over " + market + "'s " + max + "; the game " +
      "name cannot be shortened or the farm services could not read it back",
  );
}

// The pack version of the house farm copy (scripts/eldorado-farm-listings.js
// description()): same sections and voice, plus what one purchase is (a pack
// of N accounts — buying 2 = 2 packs), the one-window-per-account promise and
// where the login details arrive. Game and term come from the same arguments
// as the title, so they cannot drift apart (the R6 listing that sold 180 days
// while promising 120). At most the smallest DESC_MAX of the farm markets
// (Eldorado's 2,000).
function farmDescription({ game, days, minQty } = {}) {
  const raw = str(game);
  if (CONTROL_RE.test(raw)) {
    throw new Error("the game name must be a single line of text");
  }
  const g = raw.trim();
  if (!g) throw new Error("a farming pack needs a game");
  const d = farmDays(days);
  const n = packSize(minQty);
  const text = [
    "Automatic Farm on our Twitch for the game " + g + " — PACK OF " + n +
      " ACCOUNTS",
    "",
    "Pack of " + n + " accounts: Each purchase is a pack of " + n +
      " separate Twitch accounts, and each one is farmed for " + g +
      " for the whole period [" + d + " days]. Buying 2 = 2 packs (" + 2 * n +
      " accounts), 3 = 3 packs (" + 3 * n + " accounts), and so on.",
    "",
    "Delivery: The login details for every account in your pack arrive in " +
      "the order chat.",
    "",
    "Activation & Timing: " + connectFirstOffer(g, { each: true }) +
      " Farming begins the moment you purchase, and our bot then collects " +
      "every Twitch Drops campaign " + g + " runs. Time counting starts from " +
      "the moment the accounts are transferred.",
    "",
    "Manual Pickup: If our program does not activate any of the items, you " +
      "can pick up the items manually on the inventory page.",
    "",
    "Bot Guarantee: We guarantee that you will receive every automatic farm " +
      "account you order, and " + GUARANTEE_ONCE_CONNECTED + " to it, all " +
      "events during this period will be automatically collected by our bot " +
      "on each account within the specified period [" + d + " days].",
    "",
    "Account Status: The accounts provided to you may already include some " +
      "items on the Twitch account.",
    "",
    "Exclusivity: Each Twitch account is transferred strictly to one buyer.",
    "",
    "Important Warning: Keep every account linked, and do not change the " +
      "password or any other data on the accounts you received, otherwise " +
      "the automatic farm will stop working, and in this case you will not " +
      "receive a refund.",
    "",
    "Event Restrictions: Items are guaranteed for events that last at least " +
      "24 hours. If the event lasts less than that, we don't guarantee " +
      "receipt. Farming also only occurs if there are active events.",
  ].join("\n");
  const max = Math.min(...FARM_MARKETS.map((m) => DESC_MAX[m]));
  if (text.length > max) {
    // A cut would drop the refund warning; refuse instead.
    throw new Error(
      "the farm description is " + text.length + " characters, over the " +
        max + " a farm market takes",
    );
  }
  return text;
}

// CONTRACT §9 asks every utils/bulkPacks module for this pair. This one is
// pure — there is nothing to inject — so both are deliberate no-ops.
function __setDeps() {}
function __resetDeps() {}

module.exports = {
  stripBulkSuffix,
  accountsTitle,
  accountsDescription,
  farmTerm,
  farmTitle,
  farmDescription,
  baseTitleForSet,
  __setDeps,
  __resetDeps,
};
