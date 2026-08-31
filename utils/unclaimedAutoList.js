// ---------------------------------------------------------------------------
// UNCLAIMED-FARMS AUTO-LISTING engine (v2).
//
// Lists + sells accounts from the TWO unclaimed-drops farms on the same
// marketplaces the auto-farmer uses:
//   * no-claim farm  — accounts live in Pi configs (noclaim-bot-*) and farm
//     with Android tokens; ground truth = twitchInventory.fetchInventory.
//   * web-token farm — accounts live in the WebBotAccount registry and farm
//     with web tokens; ground truth = webbotTwitch.fetchInventory.
//
// A drop is sellable ONLY when live inventory shows 100% watched + unclaimed.
// The account (login+password, unclaimed drops intact) is the deliverable, so
// the buyer connects their own game account and claims — that is the whole
// no-claim model.
//
// LISTING MODEL (v2, after the owner's correction): an "item" is ONE game +
// ONE exact set of drops. All ready accounts for an item share ONE listing per
// marketplace — never one listing per account:
//   * Gameflip has no quantity, so it runs a relist chain: one live unit is on
//     sale; when it sells/expires the next waiting unit is published as the
//     successor ("list it again").
//   * Digiseller / GGSel are quantity products: every ready account is attached
//     as one delivery-code unit on the single product. A sale consumes a unit
//     (the platform fulfils it); the next ready account joins as new stock.
// Accounts are split round-robin across the enabled marketplaces, so one
// account is only ever attached to one market and can never be handed to two
// buyers on different platforms.
//
// Lifecycle per account (ledger: models/UnclaimedAccount.js):
//   listed (one unit of an item on one market) ->
//     sold   (its unit sold / buyer claimed) -> spent path (never pool-return)
//     expired (all drops gone) -> unit removed -> released back to pool
// Rules: never claim, never reprice, never touch origin "auto"/"manual" rows,
// and only return an account to the pool after ALL of its drops expired.
// ---------------------------------------------------------------------------
const fsp = require("fs/promises");
const mongoose = require("mongoose");
const hosts = require("./botHosts");
const settings = require("./settings");
const twitchInventory = require("./twitchInventory");
const webbotTwitch = require("./webbotTwitch");
const mp = require("./marketplaces");
const { decrypt } = require("./secretBox");
const { buildSetGridImage } = require("./setImage");
const { derivePrice, buildTitle } = require("./autoLister");
const { digisellerDeliveryCode } = require("./digisellerFulfiller");
const { ggselDeliveryCode } = require("./ggselFulfiller");
const { gameflipDeliveryCode } = require("./gameflipFulfiller");
const { recordListingSale } = require("./saleLearning");
const { sendTelegram } = require("./telegram");
const { logEvent } = require("./systemLog");
const { recordPoolUsage } = require("./poolUsageLog");
const AvailableAccount = require("../models/AvailableAccount");
const WebBotAccount = require("../models/WebBotAccount");
const BotAccount = require("../models/BotAccount");
const DropSet = require("../models/DropSet");
const MarketplaceListing = require("../models/MarketplaceListing");
const UnclaimedAccount = require("../models/UnclaimedAccount");
const MarketResearch = require("../models/MarketResearch");
const NoclaimSpentAccount = require("../models/NoclaimSpentAccount");

const ORIGIN = "unclaimed";
const SET_NOTE = "Unclaimed auto-list";
const HOST_ID = "pi";
const BASE = "/home/avishka/twitchbot-noclaim";
const BOTS_DIR = BASE + "/bots";
const CONTAINER_PREFIX = "noclaim-bot-";
const CONFIG_PATH = (id) => BOTS_DIR + "/" + id + "/Configuration/config.json";
const containerFor = (id) => CONTAINER_PREFIX + id;

const TICK_MS = 10 * 60 * 1000;
const SCAN_LIMIT = 60; // candidate inventory checks per scan pass
const CHECK_LIMIT = 40; // listed accounts re-verified per expiry/sale pass
const CONCURRENCY = 5;

// Per-game listing cap: only this many accounts per game may be attached to
// listings across ALL marketplaces at once. The rest stay unlisted so the
// operator can still sell them by hand; when one of the listed accounts sells,
// the freed slot is picked up by the next scan pass (restock-on-sale keeps
// working). Counted by normalised game label, so "Overwatch" and "overwatch"
// are the same game.
const GAME_CAP = 70;

function gameCapKey(game) {
  return settings.normGameName(game);
}

// Which listed accounts to release when a game is over GAME_CAP. Live Gameflip
// units (the accounts actually on sale right now) are always kept; the rest of
// the cap is filled with the OLDEST listed accounts (first in line to sell),
// and the newest are released for manual sale. Pure so the trim script and the
// tests share one rule.
// ledgers: [{ loginLower, listedAt, market }] — status "listed" only.
// liveLogins: Set of loginLower that are live Gameflip units (must stay).
// Returns a Set of loginLower to release.
function chooseCapReleases(ledgers, cap, liveLogins) {
  const n = Math.max(0, Number(cap) || 0);
  const keep = new Set();
  for (const l of ledgers || []) {
    if (liveLogins && liveLogins.has(l.loginLower)) keep.add(l.loginLower);
  }
  const sorted = [...(ledgers || [])].sort((a, b) => {
    const ta = a.listedAt ? new Date(a.listedAt).getTime() : 0;
    const tb = b.listedAt ? new Date(b.listedAt).getTime() : 0;
    return ta - tb || String(a.loginLower || "").localeCompare(String(b.loginLower || ""));
  });
  for (const l of sorted) {
    if (keep.size >= n) break;
    keep.add(l.loginLower);
  }
  return new Set(
    (ledgers || [])
      .filter((l) => !keep.has(l.loginLower))
      .map((l) => l.loginLower),
  );
}

// Fair-share version of the cap for the one-time trim: keep the live Gameflip
// units, then fill the remaining slots PROPORTIONALLY across the game's sets
// (oldest listed first inside each set) so no listing is drained dry while
// another hogs the whole cap. Pure + exported for the trim script and tests.
// ledgers: listed ledgers of ONE game, each with { set, loginLower, listedAt }.
// liveLogins: Set of loginLower that are live Gameflip units (always kept).
// Returns a Set of loginLower to KEEP.
function allocateCapKeep(ledgers, cap, liveLogins) {
  const n = Math.max(0, Number(cap) || 0);
  const all = ledgers || [];
  const kept = new Set(
    all.filter((l) => liveLogins && liveLogins.has(l.loginLower)).map((l) => l.loginLower),
  );
  const rest = all.filter((l) => !kept.has(l.loginLower));
  const slots = Math.max(0, n - kept.size);
  if (slots <= 0 || !rest.length) return kept;

  const bySet = new Map();
  for (const l of rest) {
    const k = String(l.set || "");
    if (!bySet.has(k)) bySet.set(k, []);
    bySet.get(k).push(l);
  }
  const counts = [...bySet.entries()].map(([k, arr]) => [k, arr.length]);
  const total = counts.reduce((m, [, c]) => m + c, 0);
  const share = new Map();
  let allocated = 0;
  for (const [k, c] of counts) {
    const s = Math.floor((c / total) * slots);
    share.set(k, s);
    allocated += s;
  }
  // Leftover slots go round-robin to the biggest sets (oldest first inside).
  let left = slots - allocated;
  const order = [...counts].sort((a, b) => b[1] - a[1]);
  let i = 0;
  while (left > 0 && order.length) {
    share.set(order[i % order.length][0], (share.get(order[i % order.length][0]) || 0) + 1);
    left--;
    i++;
  }
  for (const [k, arr] of bySet) {
    const want = Math.min(arr.length, share.get(k) || 0);
    const sorted = [...arr].sort((a, b) => {
      const ta = a.listedAt ? new Date(a.listedAt).getTime() : 0;
      const tb = b.listedAt ? new Date(b.listedAt).getTime() : 0;
      return ta - tb || String(a.loginLower || "").localeCompare(String(b.loginLower || ""));
    });
    for (const l of sorted.slice(0, want)) kept.add(l.loginLower);
  }
  return kept;
}

// Cross-process run lock. The 10-minute tick and a manual "scan now" click are
// separate processes, and two overlapping scans race the market split (the same
// account ends up attached to two marketplaces). A Mongo doc is the mutex:
// whoever sets `at` first owns the run, and a crashed holder is taken over
// after LOCK_TTL_MS. See acquireRunLock/releaseRunLock below.
const RUN_LOCK_COLLECTION = "unclaimedrunlock";
const RUN_LOCK_ID = "run";
const RUN_LOCK_TTL_MS = 15 * 60 * 1000;

let running = false;
let lastRun = null;
let lastCheck = null;
let timer = null;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

// No-claim inventory: in-progress time-based drops at 100% and unclaimed.
function sellableDropsFromNoClaimInv(inv) {
  const out = [];
  for (const d of (inv && inv.inProgress) || []) {
    if (d.percent >= 100 && !d.claimed) {
      out.push({
        name: d.name || "Reward",
        game: d.game || "",
        campaign: d.campaign || "",
        imageURL: d.imageURL || "",
        itemKey:
          String(d.name || "")
            .trim()
            .toLowerCase() +
          "|" +
          String(d.game || "")
            .trim()
            .toLowerCase(),
      });
    }
  }
  return out;
}

// Webbot inventory: farmed-unclaimed drops from webbotTwitch.fetchInventory.
function sellableDropsFromWebbotInv(inv) {
  const out = [];
  for (const d of (inv && inv.drops) || []) {
    if (d.farmedUnclaimed) {
      out.push({
        name: d.name || "Reward",
        game: d.game || "",
        campaign: d.campaign || "",
        imageURL: d.imageURL || "",
        itemKey:
          String(d.name || "")
            .trim()
            .toLowerCase() +
          "|" +
          String(d.game || "")
            .trim()
            .toLowerCase(),
      });
    }
  }
  return out;
}

// Stored credentials are secretBox-encrypted, except legacy webbot rows which
// carry a "plain:" prefix. Return the usable plaintext or "".
function plainPassword(enc) {
  const p = decrypt(enc);
  return String(p || "").replace(/^plain:/i, "");
}

// A pool row's sellable Twitch password. Historically the pool kept it in
// `password` (secretBox-encrypted); newer rows use `credPasswordEnc`. The
// no-claim console reads `password` the same way (routes/noclaimFarmRoutes.js
// per-bot accounts), so both are checked, password first.
function poolPassword(poolRow) {
  if (!poolRow) return "";
  let pw = "";
  try {
    pw = decrypt(poolRow.password || "");
  } catch {
    pw = "";
  }
  if (!pw) pw = plainPassword(poolRow.credPasswordEnc);
  return pw || "";
}

// Numeric-friendly bot sort key ("3" < "10" < webbot-bot-1 < idle "").
function padBot(id) {
  const n = parseInt(String(id || ""), 10);
  if (Number.isFinite(n)) return String(n).padStart(8, "0");
  return "zz" + String(id || "");
}

// "The same item" = one game + the exact same set of drop itemKeys.
function signatureFor(game, drops) {
  const g = String(game || "").trim().toLowerCase();
  const keys = [
    ...new Set(
      (drops || [])
        .map((d) => String(d.itemKey || d.name || "").trim().toLowerCase())
        .filter(Boolean),
    ),
  ].sort();
  return { game: g, keys, key: g + "|" + keys.join(",") };
}

// A set's items are ONE row per unique drop (an account can hold several
// copies of the same drop — e.g. "Alpha Pack" from different campaigns — and
// the signature dedupes them, so the items must too, or findUnclaimedSet's
// size check never matches and every account gets its own set/listing).
function dedupeSetItems(drops, game) {
  const seen = new Set();
  const items = [];
  for (const d of drops || []) {
    // Lowercased exactly like signatureFor: the signature is the set's
    // identity, and findUnclaimedSet matches items.itemKey with $all — a
    // case mismatch would silently create a duplicate set per account again.
    const key = String(d.itemKey || d.name || "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    items.push({
      itemKey: key,
      name: d.name || "Reward",
      game: d.game || game,
      image: d.imageURL || "",
      qty: 1,
    });
  }
  return items;
}

// The drops a listing TITLE/DESCRIPTION should show: one entry per unique
// itemKey (same dedupe rule as signatureFor / dedupeSetItems), preserving the
// first-seen drop so buildTitle sees exactly the set's items. Without this an
// account holding "Alpha Pack" from four campaigns lists as
// "Alpha Pack + Alpha Pack +2 more" — the set is one item, so is the title.
function uniqueDrops(drops) {
  const seen = new Set();
  const out = [];
  for (const d of drops || []) {
    if (!d || !String(d.name || "").trim()) continue;
    const key = String(d.itemKey || d.name || "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

// Ledger -> owner key used to match a manual-sold tick ("p:" = pool row for a
// no-claim account, "w:" = WebBotAccount row for a webbot account).
function manualSoldKey(ledger) {
  if (!ledger) return "";
  if (ledger.source === "noclaim" && ledger.poolAccountId) return "p:" + ledger.poolAccountId;
  if (ledger.source === "webbot" && ledger.webBotAccountId) return "w:" + ledger.webBotAccountId;
  return "";
}

// Drop ledgers whose owner row carries the manual-sold tick. Pure + exported
// so the successor chain and the check pass share one rule.
function filterManualSoldLedgers(ledgers, markedOwnerKeys) {
  if (!markedOwnerKeys || markedOwnerKeys.size === 0) return ledgers || [];
  return (ledgers || []).filter((l) => !markedOwnerKeys.has(manualSoldKey(l)));
}

// Batch-load which of these ledgers' owner rows carry the manual-sold tick.
// Returns a Set of manualSoldKey() values ("p:<poolId>" / "w:<webBotId>").
async function manualSoldOwnerKeys(ledgers) {
  const marked = new Set();
  const poolIds = [
    ...new Set(
      (ledgers || [])
        .filter((l) => l && l.source === "noclaim" && l.poolAccountId)
        .map((l) => l.poolAccountId),
    ),
  ];
  const webIds = [
    ...new Set(
      (ledgers || [])
        .filter((l) => l && l.source === "webbot" && l.webBotAccountId)
        .map((l) => l.webBotAccountId),
    ),
  ];
  if (poolIds.length) {
    const rows = await AvailableAccount.find(
      { _id: { $in: poolIds }, manualSold: true },
      { _id: 1 },
    ).lean();
    for (const r of rows) marked.add("p:" + String(r._id));
  }
  if (webIds.length) {
    const rows = await WebBotAccount.find(
      { _id: { $in: webIds }, manualSold: true },
      { _id: 1 },
    ).lean();
    for (const r of rows) marked.add("w:" + String(r._id));
  }
  return marked;
}

// Listing copy — the account and its unclaimed drops, with the connect-and-
// House title style, exactly like the auto-lister:
//   "{Game} Twitch Drops ({N} Items) — {Item A} + {Item B} +{N-2} more"
// so a buyer sees the item and its drops, not a vague "drop account".
function listingTitle(game, drops) {
  const items = uniqueDrops(drops);
  if (items.length) {
    return buildTitle({
      game: String(game || "Twitch").trim(),
      items,
      campaignName: "",
    });
  }
  return (game ? String(game).trim() : "Twitch") + " drop account — unclaimed";
}

// SECURITY: the public description must NEVER name the account — credentials
// are attached as the platform's auto-delivery code and handed to the buyer
// ONLY after the order completes (same model as the auto-farm). Earlier this
// appended "Account: <login>", publishing the login to anyone browsing the
// marketplace.
function listingDescription(game, drops) {
  const lines = [
    "Twitch account with unclaimed Twitch Drops ready to claim. The drops are " +
      "already earned (100%) and left UNCLAIMED so you can connect your own game " +
      "account and receive them yourself.",
  ];
  if (game) lines.push("Game: " + game);
  const names = uniqueDrops(drops).map((d) => d.name).filter(Boolean);
  if (names.length) {
    lines.push("Unclaimed drops (" + names.length + "):");
    lines.push(names.join(", "));
  }
  lines.push(
    "Delivery: you receive the Twitch account login + password. Log in, go to " +
      "twitch.tv/drops/inventory, scroll to Received, click Connect on each item " +
      "and follow the instructions to add it to your account.",
  );
  return lines.join("\n");
}

// Which active-listing logins would block a fresh listing (one account, one
// buyer). Mirrors autoLister.pickDeliveryAccounts.
async function activeListingsForLogin(login) {
  const l = String(login || "").trim().toLowerCase();
  if (!l) return [];
  const esc = l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rows = await MarketplaceListing.find(
    {
      status: "active",
      $or: [
        { accountLogin: new RegExp(esc, "i") },
        { "units.login": new RegExp("^" + esc + "$", "i") },
      ],
    },
    { marketplace: 1, externalId: 1, origin: 1, accountLogin: 1, units: 1 },
  ).lean();
  return rows.filter((r) =>
    String(r.accountLogin || "")
      .split(/[,\s]+/)
      .some((x) => x.toLowerCase() === l) ||
    (r.units || []).some((u) => String(u.login || "").toLowerCase() === l),
  );
}

// Which of the given clientSecrets are already sold, keyed by clientSecret —
// the same markers the no-claim spent scan uses (BotAccount sale beats a pool
// marker; soldGames / "sold" claimedNote on the pool row).
async function soldMapForSecrets(secrets) {
  const map = new Map();
  const uniq = [...new Set((secrets || []).filter(Boolean))];
  if (!uniq.length) return map;
  const [bots, pool] = await Promise.all([
    BotAccount.find(
      { clientSecret: { $in: uniq } },
      { clientSecret: 1, soldAt: 1, soldBulkOrderId: 1, resellerId: 1 },
    ).lean(),
    AvailableAccount.find(
      { clientSecret: { $in: uniq } },
      { clientSecret: 1, soldGames: 1, claimedNote: 1 },
    ).lean(),
  ]);
  for (const b of bots) {
    let why = "";
    if (b.soldAt) why = "shop sale";
    else if (b.resellerId) why = "reseller";
    else if (b.soldBulkOrderId) why = "bulk order";
    if (why) map.set(b.clientSecret, { sold: true, why });
  }
  for (const p of pool) {
    if (map.has(p.clientSecret)) continue;
    if (Array.isArray(p.soldGames) && p.soldGames.length) {
      map.set(p.clientSecret, { sold: true, why: "sold-game marker" });
    } else if (/^sold/i.test(String(p.claimedNote || ""))) {
      map.set(p.clientSecret, { sold: true, why: "sold note" });
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------

function pi() {
  const host = hosts.resolveHost(HOST_ID);
  if (!host) {
    const e = new Error('Pi host "' + HOST_ID + '" is not configured.');
    e.status = 503;
    throw e;
  }
  return host;
}

async function sh(script, { timeout = 30000, input } = {}) {
  try {
    const { stdout } = await hosts.runShell(pi(), script, { timeout, input });
    return (stdout || "").trim();
  } catch (err) {
    if (err && err.unreachable) {
      const e = new Error("Raspberry Pi is unreachable over SSH.");
      e.status = 503;
      throw e;
    }
    throw err;
  }
}

async function readConfigRaw(id) {
  return await sh(
    `[ -f ${hosts.shq(CONFIG_PATH(id))} ] && cat ${hosts.shq(CONFIG_PATH(id))} || echo ''`,
    { timeout: 15000 },
  );
}

// Bounded mapLimit: run `fn(item)` for up to `n` items concurrently.
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

// ---------------------------------------------------------------------------
// Candidate collection
// ---------------------------------------------------------------------------

// All no-claim bot configs in ONE batched Pi round trip: enumerate the config
// paths, then read them all (gzip/base64 batched). Returns flat account rows.
async function collectNoClaimCandidates() {
  const host = pi();
  const listOut = await sh(
    `ls -1d ${hosts.shq(BOTS_DIR)}/*/Configuration/config.json 2>/dev/null || true`,
    { timeout: 20000 },
  );
  const paths = listOut
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!paths.length) return [];
  const files = await hosts.readFiles(host, paths);
  const out = [];
  for (const p of paths) {
    const f = files[p];
    if (!f || !f.ok || !f.text) continue;
    let cfg;
    try {
      cfg = JSON.parse(f.text);
    } catch {
      continue; // corrupt config — the bots page already flags those
    }
    const id = String(p.split("/")[5] || "").replace(/[^0-9]/g, "");
    const game = (cfg.FavouriteGames || [])[0] || "";
    const users = (cfg.TwitchSettings && cfg.TwitchSettings.TwitchUsers) || [];
    for (const u of users) {
      if (!u || !u.ClientSecret) continue;
      out.push({
        source: "noclaim",
        login: u.Login || "",
        twitchId: String(u.Id || ""),
        clientSecret: u.ClientSecret || "",
        game,
        botId: id,
        container: containerFor(id),
      });
    }
  }
  return out;
}

// Every enabled, non-dead web-token account. The botId field is not a
// requirement — an idle account can still hold farmed-unclaimed drops, and the
// live-inventory check decides sellability either way.
async function collectWebbotCandidates() {
  const rows = await WebBotAccount.find(
    { enabled: true, lastStatus: { $ne: "dead" } },
    {
      _id: 1,
      login: 1,
      twitchId: 1,
      webToken: 1,
      credPasswordEnc: 1,
      hasPassword: 1,
      manualSold: 1,
      currentGame: 1,
      pinnedGame: 1,
      botId: 1,
    },
  ).lean();
  const out = [];
  for (const a of rows) {
    if (!a.webToken) continue;
    out.push({
      source: "webbot",
      id: String(a._id),
      login: a.login || "",
      twitchId: a.twitchId || "",
      webToken: a.webToken,
      password: plainPassword(a.credPasswordEnc),
      hasPassword: !!a.hasPassword,
      manualSold: !!a.manualSold,
      game: a.pinnedGame || a.currentGame || "",
      botId: a.botId || "",
    });
  }
  return out;
}

// Live inventory for one candidate, plus the sellable drops in it.
async function inventoryForCandidate(cand) {
  if (cand.source === "noclaim") {
    const inv = await twitchInventory.fetchInventory(cand.clientSecret, {
      host: pi(),
    });
    return {
      inv,
      sellable: sellableDropsFromNoClaimInv(inv),
      login: inv.login || cand.login,
    };
  }
  const inv = await webbotTwitch.fetchInventory(cand.webToken);
  return { inv, sellable: sellableDropsFromWebbotInv(inv), login: cand.login };
}

// ---------------------------------------------------------------------------
// Item sets (ONE DropSet per game + exact drop set)
// ---------------------------------------------------------------------------

// The enabled marketplaces for a game, in split-priority order. ZeusX is NOT
// included: it is a manual hand-over market for the auto-farm and has no
// auto-sell path, so unclaimed stock is not published there.
async function enabledMarketsForGame(game) {
  const af = settings.getAutoFarm();
  const markets = ["gameflip"];
  if (af.platiCategoryId) markets.push("digiseller");
  let ggselCategoryId = "";
  try {
    ggselCategoryId = await mp.ggselResolveCategoryId(game);
  } catch {
    ggselCategoryId = "";
  }
  if (!ggselCategoryId) ggselCategoryId = String(af.ggselCategoryId || "");
  if (ggselCategoryId) markets.push("ggsel");
  return { markets, ggselCategoryId };
}

async function findUnclaimedSet(signature) {
  if (!signature || !signature.keys || !signature.keys.length) return null;
  return DropSet.findOne({
    note: SET_NOTE,
    "items.itemKey": { $all: signature.keys },
    items: { $size: signature.keys.length },
  }).lean();
}

async function createUnclaimedSet(signature, game, drops, price) {
  return DropSet.create({
    name: (game || "Twitch") + " drops — unclaimed",
    note: SET_NOTE,
    items: dedupeSetItems(drops, game),
    price,
    listed: false,
    custom: true,
    coverGame: game,
  });
}

// Find or create the item's set. Two concurrent workers for the same signature
// could race a duplicate create; the winner check below collapses them.
async function ensureUnclaimedSet(signature, game, drops, price) {
  const existing = await findUnclaimedSet(signature);
  if (existing) return existing;
  const created = await createUnclaimedSet(signature, game, drops, price);
  const winner = await findUnclaimedSet(signature);
  if (winner && String(winner._id) !== String(created._id)) {
    await DropSet.deleteOne({ _id: created._id }).catch(() => {});
    return winner;
  }
  return created;
}

// ---------------------------------------------------------------------------
// Row + ledger queries
// ---------------------------------------------------------------------------

async function activeRowForSetMarket(setId, marketplace) {
  if (!setId || !marketplace) return null;
  return MarketplaceListing.findOne({
    origin: ORIGIN,
    set: setId,
    marketplace,
    status: "active",
  }).lean();
}

async function listedLedgersForSetMarket(setId, market) {
  if (!setId || !market) return [];
  return UnclaimedAccount.find({ set: setId, market, status: "listed" })
    .sort({ listedAt: 1, _id: 1 })
    .lean();
}

// The marketplace row this ledger is (or was) a unit of.
async function rowForLedger(ledger) {
  if (!ledger || !ledger.set) return null;
  if (ledger.market) {
    const row = await MarketplaceListing.findOne({
      origin: ORIGIN,
      set: ledger.set,
      marketplace: ledger.market,
      status: { $in: ["active", "sold"] },
    }).lean();
    if (row) return row;
  }
  return MarketplaceListing.findOne({
    origin: ORIGIN,
    set: ledger.set,
    marketplace: "gameflip",
    status: { $in: ["active", "sold"] },
  }).lean();
}

// Rebuild a credential object for a ledger row (pool row / webbot row).
async function credentialForLedger(ledger) {
  if (!ledger) return { login: "", password: "" };
  if (ledger.source === "noclaim" && ledger.poolAccountId) {
    const pool = await AvailableAccount.findById(ledger.poolAccountId).lean();
    if (pool) {
      return { login: ledger.login || pool.login || "", password: poolPassword(pool) };
    }
  }
  if (ledger.source === "webbot" && ledger.webBotAccountId) {
    const wb = await WebBotAccount.findById(ledger.webBotAccountId).lean();
    if (wb) {
      return {
        login: ledger.login || wb.login || "",
        password: plainPassword(wb.credPasswordEnc),
      };
    }
  }
  return { login: ledger.login || "", password: "" };
}

// ---------------------------------------------------------------------------
// Publishing (ONE listing per item per marketplace)
// ---------------------------------------------------------------------------

async function publishGameflipUnit(set, cand, drops, price, img) {
  const game = cand.game || (drops[0] && drops[0].game) || set.coverGame || "";
  const r = await mp.gameflipPublish({
    title: listingTitle(game, drops),
    description: listingDescription(game, drops),
    priceUsd: price,
    imagePath: img || undefined,
    autoDeliverCode: gameflipDeliveryCode(cand.login, cand.password),
  });
  return MarketplaceListing.create({
    set: set._id,
    marketplace: "gameflip",
    externalId: r.externalId,
    url: r.url || "",
    title: listingTitle(game, drops),
    description: listingDescription(game, drops),
    price,
    status: "active",
    origin: ORIGIN,
    autoDeliver: true,
    accountId: cand.id || cand.poolAccountId || "",
    accountLogin: cand.login,
    qtyRemaining: 0, // the engine relists; the fulfiller must never (archive stock differs)
    qtyTarget: 0,
    note: "unclaimed auto-list — live unit",
  });
}

async function publishDigisellerProduct(set, units, game, drops, price, img, categoryId) {
  const r = await mp.digisellerPublish({
    title: listingTitle(game, drops),
    description: listingDescription(game, drops),
    priceUsd: price,
    categories: [
      {
        owner: 1,
        categoryId,
        attributes: settings.getAutoFarm().platiAttributes || [],
      },
    ],
  });
  let contentIds = [];
  try {
    // Digiseller's content-add API only commits the first ~17 lines of a big
    // batch (verified live: a 56-line add left 17 in stock), so feed units in
    // small chunks and record every contentId in order — the only handle to
    // delete a specific unit later.
    const CHUNK = 12;
    for (let i = 0; i < units.length; i += CHUNK) {
      const slice = units.slice(i, i + CHUNK);
      const added = await mp.digisellerAddContent(
        r.externalId,
        slice.map((u) => digisellerDeliveryCode(u.login, u.password)),
      );
      const ids = (added && added.contentIds) || [];
      if (ids.length !== slice.length) {
        throw new Error(
          "digiseller content add returned " +
            ids.length +
            " ids for " +
            slice.length +
            " lines (product " +
            r.externalId +
            ")",
        );
      }
      contentIds.push(...ids);
    }
  } catch (err) {
    await mp.digisellerDelist(r.externalId).catch(() => {});
    throw err;
  }
  if (img) await mp.digisellerUploadImage(r.externalId, img).catch(() => {});
  const row = await MarketplaceListing.create({
    set: set._id,
    marketplace: "digiseller",
    externalId: r.externalId,
    url: r.url || "",
    title: listingTitle(game, drops),
    description: listingDescription(game, drops),
    price,
    status: "active",
    origin: ORIGIN,
    accountId: units[0] && (units[0].id || units[0].poolAccountId || ""),
    accountLogin: units.map((u) => u.login).join(", "),
    qtyRemaining: 0,
    qtyTarget: 0,
    units: units.map((u, i) => ({
      contentId: contentIds[i] || "",
      accountId: u.id || u.poolAccountId || "",
      login: u.login,
      addedAt: new Date(),
    })),
    note: "unclaimed auto-list — stock product",
  });
  const stock = await mp.digisellerProductStock(r.externalId).catch(() => null);
  if (stock != null) {
    await MarketplaceListing.updateOne(
      { _id: row._id },
      { $set: { lastStock: stock } },
    ).catch(() => {});
  }
  return row;
}

async function publishGgselOffer(set, units, game, drops, price, img, categoryId) {
  const r = await mp.ggselPublish({
    title: listingTitle(game, drops),
    description: listingDescription(game, drops),
    priceUsd: price,
    categoryId,
    delivery: "auto",
    coverImagePath: img || undefined,
    products: units.map((u) => ggselDeliveryCode(u.login, u.password)),
  });
  await mp.ggselEnableAutoselling(r.externalId).catch(() => {});
  await mp.ggselFinalizeStock(r.externalId).catch(() => {});
  const row = await MarketplaceListing.create({
    set: set._id,
    marketplace: "ggsel",
    externalId: r.externalId,
    url: r.url || "",
    title: listingTitle(game, drops),
    description: listingDescription(game, drops),
    price,
    status: "active",
    origin: ORIGIN,
    accountId: units[0] && (units[0].id || units[0].poolAccountId || ""),
    accountLogin: units.map((u) => u.login).join(", "),
    qtyRemaining: 0,
    qtyTarget: 0,
    units: units.map((u) => ({
      contentId: "",
      accountId: u.id || u.poolAccountId || "",
      login: u.login,
      addedAt: new Date(),
    })),
    note: "unclaimed auto-list — stock offer",
  });
  const stock = await mp.ggselOfferStock(r.externalId).catch(() => null);
  if (stock != null) {
    await MarketplaceListing.updateOne(
      { _id: row._id },
      { $set: { lastStock: stock } },
    ).catch(() => {});
  }
  return row;
}

async function publishProduct(set, market, units, game, drops, price, img, ggselCategoryId) {
  if (market === "digiseller") {
    return publishDigisellerProduct(
      set,
      units,
      game,
      drops,
      price,
      img,
      settings.getAutoFarm().platiCategoryId,
    );
  }
  return publishGgselOffer(set, units, game, drops, price, img, ggselCategoryId);
}

// Attach one more stock unit to an existing quantity product.
async function addUnitToRow(row, cand) {
  if (row.marketplace === "digiseller") {
    const added = await mp.digisellerAddContent(row.externalId, [
      digisellerDeliveryCode(cand.login, cand.password),
    ]);
    const contentId = ((added && added.contentIds) || [])[0] || "";
    const units = [
      ...(row.units || []),
      {
        contentId,
        accountId: cand.id || cand.poolAccountId || "",
        login: cand.login,
        addedAt: new Date(),
      },
    ];
    await MarketplaceListing.updateOne(
      { _id: row._id, status: "active" },
      { $set: { units, accountLogin: units.map((u) => u.login).join(", ") } },
    );
    return;
  }
  if (row.marketplace === "ggsel") {
    await mp.ggselAddProducts(row.externalId, [ggselDeliveryCode(cand.login, cand.password)]);
    await mp.ggselFinalizeStock(row.externalId).catch(() => {});
    const units = [
      ...(row.units || []),
      {
        contentId: "",
        accountId: cand.id || cand.poolAccountId || "",
        login: cand.login,
        addedAt: new Date(),
      },
    ];
    await MarketplaceListing.updateOne(
      { _id: row._id, status: "active" },
      { $set: { units, accountLogin: units.map((u) => u.login).join(", ") } },
    );
  }
}

// Publish the next waiting Gameflip unit as the chain's new live listing.
// `excludeLogin` is the unit that just left (sold/expired) — never it.
async function publishGameflipSuccessor(setId, excludeLogin, opts = {}) {
  if (!setId) return { published: false, reason: "no set" };
  const set = await DropSet.findById(setId).lean();
  if (!set) return { published: false, reason: "no set" };
  const waitingList = await UnclaimedAccount.find({
    set: setId,
    market: "gameflip",
    status: "listed",
    loginLower: { $ne: String(excludeLogin || "").toLowerCase() },
  })
    .sort({ listedAt: 1, _id: 1 })
    .lean();
  // Never publish a unit the operator marked as sold-by-hand — the account
  // keeps farming but its credentials must not be handed to another buyer.
  const marked = await manualSoldOwnerKeys(waitingList);
  const list = filterManualSoldLedgers(waitingList, marked);
  if (!list.length) return { published: false, reason: "no waiting unit" };
  const drops = (set.items || []).map((i) => ({
    name: i.name,
    game: i.game,
    campaign: "",
    imageURL: i.image || "",
    itemKey: i.itemKey,
  }));
  const game = set.coverGame || (drops[0] && drops[0].game) || "";
  for (const waiting of list) {
    const cred = await credentialForLedger(waiting);
    if (!cred.password) continue;
    let img = "";
    try {
      img = await buildSetGridImage(set);
    } catch {
      img = "";
    }
    const cand = {
      source: waiting.source,
      id: waiting.poolAccountId || waiting.webBotAccountId || "",
      poolAccountId: waiting.poolAccountId,
      login: cred.login,
      password: cred.password,
      game,
    };
    try {
      const row = await publishGameflipUnit(
        set,
        cand,
        drops,
        Number(set.price) || 0,
        img,
      );
      if (img) await fsp.unlink(img).catch(() => {});
      await UnclaimedAccount.updateOne(
        { _id: waiting._id },
        {
          $set: {
            listingIds: [...new Set([...(waiting.listingIds || []), String(row._id)])],
            note: "unclaimed auto-list — live unit",
          },
        },
      ).catch(() => {});
      if (opts.log !== false) {
        logEvent({
          category: "unclaimed",
          action: "relisted",
          actor: "unclaimedAutoList",
          subject: cred.login,
          game,
          detail:
            "gameflip successor published for unclaimed item " + game + " ($" + (Number(set.price) || 0).toFixed(2) + ")",
        });
      }
      return { published: true, row, login: cred.login };
    } catch (e) {
      if (img) await fsp.unlink(img).catch(() => {});
      // A unit whose delivery code the platform still holds (e.g. a delisted
      // predecessor) cannot be republished — skip it and try the next in the
      // chain rather than blocking the whole item.
      console.error(
        "unclaimedAutoList successor publish failed for " + (cred.login || waiting.loginLower || "?") + ":",
        e.message,
      );
    }
  }
  return { published: false, reason: "no publishable waiting unit" };
}

// ---------------------------------------------------------------------------
// Unit removal + marketplace repair
// ---------------------------------------------------------------------------

// Remove this ledger's unit from its marketplace listing.
//  - gameflip: delist the live row (if this unit was the live one) and publish
//    the next waiting unit as the successor.
//  - digiseller: delete the unit's content line; delist the product if it is
//    now empty.
//  - ggsel: GGSel cannot delete one unit; rebuild the offer without this unit
//    when healthy units remain, else take the whole offer down.
async function removeUnitFromRow(row, ledger, opts = {}) {
  if (!row || !ledger) return { ok: true, removed: false };
  const login = String(ledger.login || "").toLowerCase();
  if (row.marketplace === "gameflip") {
    if (String(row.accountLogin || "").toLowerCase() !== login) {
      return { ok: true, removed: false }; // not the live unit — never exposed
    }
    if (row.status === "active") {
      await mp.gameflipDelist(row.externalId).catch(() => {});
      await MarketplaceListing.updateOne(
        { _id: row._id, status: "active" },
        { $set: { status: "delisted", lastError: "" } },
      ).catch(() => {});
    }
    await publishGameflipSuccessor(row.set, ledger.login, { log: opts.log !== false });
    return { ok: true, removed: true };
  }
  // A platform sale: the buyer already got this unit from the platform, so
  // its code is gone from the product and the stock read is the truth. Only
  // the ledger changes (to sold) — leave the row's bookkeeping untouched.
  if (opts.removeFromProduct === false) {
    return { ok: true, removed: true };
  }
  const was = (row.units || []).length;
  const units = (row.units || []).filter(
    (u) => String(u.login || "").toLowerCase() !== login,
  );
  const removed = units.length < was;
  if (!removed) return { ok: true, removed: false };
  if (row.marketplace === "digiseller") {
    if (opts.removeFromProduct !== false) {
      const unit = (row.units || []).find(
        (u) => String(u.login || "").toLowerCase() === login,
      );
      if (unit && unit.contentId) {
        await mp.digisellerRemoveContent(row.externalId, unit.contentId).catch(
          () => {},
        );
      }
    }
    await MarketplaceListing.updateOne(
      { _id: row._id, status: "active" },
      { $set: { units, accountLogin: units.map((u) => u.login).join(", ") } },
    ).catch(() => {});
    if (!units.length) {
      await mp.digisellerDelist(row.externalId).catch(() => {});
      await MarketplaceListing.updateOne(
        { _id: row._id, status: "active" },
        { $set: { status: "delisted", lastError: "" } },
      ).catch(() => {});
    } else {
      const stock = await mp.digisellerProductStock(row.externalId).catch(() => null);
      if (stock != null) {
        await MarketplaceListing.updateOne(
          { _id: row._id },
          { $set: { lastStock: stock } },
        ).catch(() => {});
      }
    }
  }
  if (row.marketplace === "ggsel") {
    if (units.length) {
      await rebuildGgselOffer(row, units).catch((e) =>
        console.error("unclaimedAutoList ggsel rebuild failed:", e.message),
      );
    } else {
      await mp.ggselDelist(row.externalId).catch(() => {});
      await MarketplaceListing.updateOne(
        { _id: row._id, status: "active" },
        { $set: { status: "delisted", lastError: "" } },
      ).catch(() => {});
    }
  }
  return { ok: true, removed };
}

// Every ACTIVE unclaimed row that carries this login (as a live unit or as a
// stock-unit login). The v1 era published several rows per set, so one account
// can sit on multiple rows; anything that must take an account off sale has to
// scrub ALL of them, or a leftover offer can still hand the account out.
async function rowsForLogin(login) {
  const l = String(login || "").trim().toLowerCase();
  if (!l) return [];
  const esc = l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return MarketplaceListing.find({
    origin: ORIGIN,
    status: "active",
    $or: [
      { accountLogin: new RegExp("(?:^|[,\\s])" + esc + "(?:$|[,\\s])", "i") },
      { "units.login": new RegExp("^" + esc + "$", "i") },
    ],
  }).lean();
}

// Remove one login from EVERY active row that carries it. Root-cause fix for
// the duplicate-row era: rowForLedger's findOne only ever cleaned the first
// matching row, leaving manual-sold / released accounts deliverable through
// the leftover duplicates.
async function removeLoginFromAllRows(ledger, opts = {}) {
  if (!ledger || !ledger.login) return { rows: 0, removed: 0 };
  const rows = await rowsForLogin(ledger.login);
  let removed = 0;
  for (const row of rows) {
    const r = await removeUnitFromRow(row, ledger, opts);
    if (r && r.removed) removed++;
  }
  return { rows: rows.length, removed };
}

// GGSel cannot delete a single unit, so a unit that must come off (expired /
// claimed) forces a clean rebuild of the offer with only the healthy units.
async function rebuildGgselOffer(oldRow, remainingUnits) {
  const set = await DropSet.findById(oldRow.set).lean();
  if (!set) return;
  const game = (set.items && set.items[0] && set.items[0].game) || set.coverGame || "";
  const drops = (set.items || []).map((i) => ({
    name: i.name,
    game: i.game,
    campaign: "",
    imageURL: i.image || "",
    itemKey: i.itemKey,
  }));
  const units = [];
  for (const u of remainingUnits) {
    const ledger = await UnclaimedAccount.findOne({
      loginLower: String(u.login || "").toLowerCase(),
      set: set._id,
      status: "listed",
    }).lean();
    const cred = ledger ? await credentialForLedger(ledger) : null;
    if (cred && cred.password && cred.login) {
      units.push({ login: cred.login, password: cred.password, id: ledger.poolAccountId || ledger.webBotAccountId || "" });
    }
  }
  await mp.ggselDelist(oldRow.externalId).catch(() => {});
  await MarketplaceListing.updateOne(
    { _id: oldRow._id, status: "active" },
    { $set: { status: "delisted", lastError: "rebuilt after unit removal" } },
  ).catch(() => {});
  if (!units.length) return;
  let img = "";
  try {
    img = await buildSetGridImage(set);
  } catch {
    img = "";
  }
  const { ggselCategoryId } = await enabledMarketsForGame(game);
  const row = await publishGgselOffer(
    set,
    units,
    game,
    drops,
    Number(set.price) || 0,
    img,
    ggselCategoryId,
  );
  if (img) await fsp.unlink(img).catch(() => {});
  await UnclaimedAccount.updateMany(
    { set: set._id, market: "ggsel", status: "listed" },
    { $addToSet: { listingIds: String(row._id) } },
  ).catch(() => {});
}

// ---------------------------------------------------------------------------
// Lifecycle: spent, expiry + pool return
// ---------------------------------------------------------------------------

// SPENT path: the buyer owns this account (a sale was detected, or a listed
// drop flipped to claimed). Stop farming it, remove its unit from its listing
// (unless the platform already consumed it), stamp the pool row so the
// recycler sees it, NEVER return it to the pool.
async function spendAccount(ledger, reason, opts = {}) {
  const at = new Date();
  try {
    const row = await rowForLedger(ledger);
    if (row) {
      // `removeFromProduct:false` — the platform already handed this unit to
      // the buyer (a real sale), so its code is gone from the product; only
      // the row bookkeeping needs to drop it.
      await removeUnitFromRow(row, ledger, {
        removeFromProduct: opts.removeFromProduct !== false,
        log: false,
      });
    }
  } catch (e) {
    console.error("unclaimedAutoList spend remove-unit failed:", e.message);
  }
  if (ledger.source === "noclaim") {
    const secrets = [];
    let game = ledger.game || "";
    if (ledger.botId && ledger.container) {
      try {
        const raw = await readConfigRaw(ledger.botId);
        if (raw) {
          const cfg = JSON.parse(raw);
          const users = (cfg.TwitchSettings && cfg.TwitchSettings.TwitchUsers) || [];
          game = game || (cfg.FavouriteGames || [])[0] || "";
          const victim = users.find(
            (u) => String(u.Login || "").toLowerCase() === String(ledger.login || "").toLowerCase(),
          );
          if (victim && victim.ClientSecret) secrets.push(victim.ClientSecret);
          const kept = victim
            ? users.filter((u) => u.ClientSecret !== victim.ClientSecret)
            : users;
          cfg.TwitchSettings.TwitchUsers = kept;
          await sh(
            `cat > ${hosts.shq(CONFIG_PATH(ledger.botId))} && chmod 600 ${hosts.shq(CONFIG_PATH(ledger.botId))}`,
            { timeout: 20000, input: JSON.stringify(cfg, null, 2) },
          );
          if (kept.length > 0) {
            await sh(`docker restart ${hosts.shq(ledger.container)} 2>/dev/null || true`, {
              timeout: 40000,
            });
          } else {
            await sh(`docker stop ${hosts.shq(ledger.container)} 2>/dev/null || true`, {
              timeout: 25000,
            });
          }
        }
      } catch (e) {
        // Config surgery must never block the sale bookkeeping.
        console.error("unclaimedAutoList: no-claim bot cleanup failed:", e.message);
      }
    }
    if (secrets.length) {
      const rowsPool = await AvailableAccount.find(
        { clientSecret: { $in: secrets } },
        { clientSecret: 1, soldGames: 1 },
      ).lean();
      const rowBySecret = new Map(rowsPool.map((r) => [r.clientSecret, r]));
      const stampGame = settings.normGameName(game);
      const writes = [];
      const stampedIds = [];
      for (const cs of secrets) {
        const r = rowBySecret.get(cs);
        if (!r) continue;
        const games = new Set(
          (Array.isArray(r.soldGames) ? r.soldGames : []).filter(Boolean),
        );
        if (stampGame) games.add(stampGame);
        writes.push({
          updateOne: {
            filter: { _id: r._id, status: "claimed" },
            update: {
              $set: {
                claimedNote: "spent — unclaimed auto-listed (" + reason + ")",
                soldGames: [...games],
              },
            },
          },
        });
        stampedIds.push(r._id);
      }
      if (writes.length) {
        await AvailableAccount.bulkWrite(writes).catch(() => {});
        await recordPoolUsage(stampedIds, {
          event: "spent",
          actor: "unclaimedAutoList",
          note: "spent — unclaimed auto-listed (" + reason + ")",
          game: stampGame || "",
        }).catch(() => {});
      }
    }
    // Also log into the no-claim spent view so the No-claim section shows it.
    const loginLower = String(ledger.login || "").toLowerCase();
    await NoclaimSpentAccount.updateOne(
      loginLower
        ? { loginLower }
        : { twitchId: ledger.twitchId || "", login: ledger.login || "" },
      {
        $set: {
          login: ledger.login || "",
          loginLower,
          twitchId: ledger.twitchId || "",
          game,
          botId: ledger.botId || "",
          container: ledger.container || "",
          sold: true,
          connected: false,
          soldWhy: "unclaimed auto-list: " + reason,
          tokenStatus: "ok",
          actor: "unclaimedAutoList",
          sweptAt: at,
        },
      },
      { upsert: true },
    ).catch(() => {});
  } else if (ledger.source === "webbot" && ledger.webBotAccountId) {
    await WebBotAccount.updateOne(
      { _id: ledger.webBotAccountId },
      {
        $set: {
          enabled: false,
          botId: "",
          pinnedGame: "",
          lastStatus: "idle",
          note: "auto-sold via unclaimed auto-list (" + reason + ")",
        },
      },
    ).catch(() => {});
  }

  await UnclaimedAccount.updateOne(
    { _id: ledger._id, status: "listed" },
    { $set: { status: "sold", soldAt: at, note: reason, lastCheckedAt: at } },
  ).catch(() => {});
  await markOwnerUnlisted(ledger);

  logEvent({
    category: "unclaimed",
    action: "sold",
    actor: "unclaimedAutoList",
    subject: ledger.login || ledger._id || "",
    game: ledger.game || "",
    count: 1,
    detail:
      "sold (" + reason + ") — " + (ledger.source || "") + " account " + (ledger.login || ""),
  });
  sendTelegram(
    "💰 SOLD (unclaimed auto-list)\n\n" +
      (ledger.login || "?") +
      "\nGame: " +
      (ledger.game || "?") +
      "\nSource: " +
      (ledger.source || "?") +
      "\nReason: " +
      reason,
  ).catch((e) => console.error("unclaimed sale notify error:", e.message));
}

// EXPIRY path: all of this account's drops are gone. Remove its unit from its
// listing and return it to the pool (only ever after ALL drops expired).
async function expireAccount(ledger, opts = {}) {
  const release = opts.release !== false;
  try {
    const row = await rowForLedger(ledger);
    if (row) {
      await removeUnitFromRow(row, ledger, { removeFromProduct: true, log: false });
    }
  } catch (e) {
    console.error("unclaimedAutoList expire remove-unit failed:", e.message);
  }
  const ok = release ? await releaseToPool(ledger) : false;
  const at = new Date();
  await UnclaimedAccount.updateOne(
    { _id: ledger._id, status: "listed" },
    {
      $set: {
        status: ok ? "released" : "expired",
        expiredAt: at,
        releasedAt: ok ? at : null,
        note: ok ? "drops expired — delisted + returned to pool" : "drops expired — delisted",
        lastCheckedAt: at,
      },
    },
  ).catch(() => {});
  await markOwnerUnlisted(ledger);
  logEvent({
    category: "unclaimed",
    action: "expired",
    actor: "unclaimedAutoList",
    subject: ledger.login || ledger._id || "",
    game: ledger.game || "",
    count: 1,
    detail:
      "drops expired — delisted + " +
      (ok ? "returned to pool" : "pool return pending") +
      " (" + (ledger.source || "") + ")",
  });
  return ok;
}

// Release an account whose drops all expired. No-claim -> pool row back to
// available; webbot -> idle in its own registry.
async function releaseToPool(ledger) {
  if (!ledger) return false;
  if (ledger.source === "noclaim" && ledger.poolAccountId) {
    const r = await AvailableAccount.updateOne(
      { _id: ledger.poolAccountId, status: "claimed" },
      {
        $set: {
          status: "available",
          claimedNote: "expired — unclaimed auto-list release",
        },
      },
    );
    const cur = await AvailableAccount.findById(ledger.poolAccountId, {
      status: 1,
    }).lean();
    if ((r.matchedCount || 0) > 0 || (cur && cur.status !== "claimed")) {
      await recordPoolUsage([ledger.poolAccountId], {
        event: "released",
        actor: "unclaimedAutoList",
        note: "expired — unclaimed auto-list release",
        game: ledger.game || "",
      }).catch(() => {});
      return true;
    }
    return false;
  }
  if (ledger.source === "webbot" && ledger.webBotAccountId) {
    await WebBotAccount.updateOne(
      { _id: ledger.webBotAccountId },
      { $set: { botId: "", pinnedGame: "", lastStatus: "idle" } },
    );
    return true;
  }
  return false;
}

// Delist a set of rows (used by the operator override). Marks each row
// delisted after the platform confirms, records failures in lastError.
async function delistRowsForAccount(rows) {
  const results = [];
  for (const row of rows) {
    if (!row || row.status !== "active") {
      results.push({ row, ok: true });
      continue;
    }
    let ok = true;
    try {
      if (row.marketplace === "gameflip") await mp.gameflipDelist(row.externalId);
      else if (row.marketplace === "digiseller") await mp.digisellerDelist(row.externalId);
      else if (row.marketplace === "ggsel") await mp.ggselDelist(row.externalId);
    } catch (e) {
      ok = false;
      await MarketplaceListing.updateOne(
        { _id: row._id },
        { $set: { lastError: "auto-delist: " + e.message } },
      ).catch(() => {});
    }
    if (ok) {
      await MarketplaceListing.updateOne(
        { _id: row._id },
        { $set: { status: "delisted" } },
      ).catch(() => {});
    }
    results.push({ row, ok });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Passes
// ---------------------------------------------------------------------------

// Which enabled market gets the next ready account. Balance by fewest listed
// units; a set with no live Gameflip unit gets its next account first so a
// sold/expired chain restarts immediately.
async function pickMarketForSet(setId, markets) {
  if (!markets || !markets.length) return "";
  const info = [];
  for (const m of markets) {
    const n = await UnclaimedAccount.countDocuments({
      set: setId,
      market: m,
      status: "listed",
    });
    const active = await activeRowForSetMarket(setId, m);
    info.push({ m, n, active: !!active });
  }
  const gf = info.find((x) => x.m === "gameflip");
  if (gf && !gf.active) return "gameflip";
  info.sort((a, b) => a.n - b.n || markets.indexOf(a.m) - markets.indexOf(b.m));
  return info[0].m;
}

// Owner-row "listed" flag sync. The farm consoles show an auto tick next to
// an account when the auto-lister has attached it to a listing, so the
// operator can see it is on sale and never hand it over manually. The flag is
// engine-owned: set when the ledger becomes listed, cleared when it leaves
// "listed" (sold / expired / released / manual-sold removed). A manual tick
// for a hand-made listing is left alone unless the engine owns that account.
async function markOwnerListed(cand) {
  if (!cand) return;
  if (cand.source === "noclaim" && cand.poolAccountId) {
    await AvailableAccount.updateOne(
      { _id: cand.poolAccountId, listed: { $ne: true } },
      { $set: { listed: true } },
    ).catch(() => {});
  } else if (cand.source === "webbot" && (cand.webBotAccountId || cand.id)) {
    await WebBotAccount.updateOne(
      { _id: cand.webBotAccountId || cand.id, listed: { $ne: true } },
      { $set: { listed: true } },
    ).catch(() => {});
  }
}

async function markOwnerUnlisted(ledger) {
  if (!ledger) return;
  if (ledger.source === "noclaim" && ledger.poolAccountId) {
    const still = await UnclaimedAccount.exists({
      poolAccountId: ledger.poolAccountId,
      status: "listed",
    });
    if (still) return;
    await AvailableAccount.updateOne(
      { _id: ledger.poolAccountId, listed: { $ne: false } },
      { $set: { listed: false } },
    ).catch(() => {});
  } else if (ledger.source === "webbot" && ledger.webBotAccountId) {
    const still = await UnclaimedAccount.exists({
      webBotAccountId: ledger.webBotAccountId,
      status: "listed",
    });
    if (still) return;
    await WebBotAccount.updateOne(
      { _id: ledger.webBotAccountId, listed: { $ne: false } },
      { $set: { listed: false } },
    ).catch(() => {});
  }
}

async function ledgerAccount(cand, set, market, row, sellable, game, price, note) {
  const login = cand.login || "";
  const loginLower = String(login).toLowerCase();
  const existing = await UnclaimedAccount.findOne({ loginLower, source: cand.source }).lean();
  if (existing && existing.status === "listed" && existing.market && existing.market !== market) {
    // Defense-in-depth: a listed ledger already committed to one marketplace
    // must never be re-pointed at another — one account, one buyer.
    logEvent({
      category: "unclaimed",
      action: "skip",
      actor: "unclaimedAutoList",
      subject: login,
      detail:
        "login already listed on " + existing.market + " — refused re-attach to " + market,
    });
    return existing;
  }
  const created = await UnclaimedAccount.findOneAndUpdate(
    { loginLower, source: cand.source },
    {
      $set: {
        source: cand.source,
        login,
        loginLower,
        twitchId: cand.twitchId || "",
        game,
        set: set._id,
        poolAccountId: cand.poolAccountId || "",
        webBotAccountId: cand.source === "webbot" ? cand.id || "" : "",
        botId: cand.botId || "",
        container: cand.container || "",
        drops: (sellable || []).map((d) => ({
          name: d.name,
          game: d.game || game,
          campaign: d.campaign || "",
          itemKey: d.itemKey || d.name,
        })),
        status: "listed",
        note: note || "",
        listingIds: row ? [String(row._id)] : [],
        listingExternalIds: row && row.externalId ? [String(row.externalId)] : [],
        listedAt: new Date(),
        lastCheckedAt: new Date(),
      },
      $setOnInsert: { market },
    },
    { upsert: true, new: true },
  );
  // The account is now attached to a listing — auto-tick its console box.
  await markOwnerListed(cand);
  return created;
}

// Read-only integrity check: every active unclaimed row's units must match the
// ledgers committed to that marketplace, and no login may sit on two markets.
// Returns { ok, issues: [...] } so the panel can surface drift immediately.
async function consistencyIssues() {
  const issues = [];
  const rows = await MarketplaceListing.find(
    { origin: ORIGIN, status: "active" },
    { marketplace: 1, set: 1, accountLogin: 1, units: 1 },
  ).lean();
  // Keyed by set+marketplace: several items (game + drop set) share the same
  // marketplace, so a per-market map would collapse them and misreport.
  const rowBySetMarket = new Map();
  for (const r of rows) {
    const uniq = new Map();
    for (const u of r.units || []) {
      const l = String(u.login || "").toLowerCase();
      if (l && !uniq.has(l)) uniq.set(l, u);
    }
    rowBySetMarket.set(String(r.set) + ":" + r.marketplace, {
      row: r,
      logins: new Set(uniq.keys()),
    });
  }
  const seen = new Map(); // login -> first market seen on
  for (const [key, { logins }] of rowBySetMarket.entries()) {
    const market = key.slice(key.indexOf(":") + 1);
    for (const l of logins) {
      if (seen.has(l) && seen.get(l) !== market) {
        issues.push({
          type: "cross-market",
          login: l,
          detail: "on " + seen.get(l) + " and " + market,
        });
      } else if (!seen.has(l)) {
        seen.set(l, market);
      }
    }
  }
  const ledgers = await UnclaimedAccount.find(
    { status: "listed" },
    { loginLower: 1, market: 1, set: 1, source: 1 },
  ).lean();
  for (const l of ledgers) {
    if (!l.market) continue;
    if (l.market === "gameflip") {
      // The relist chain keeps waiting units unpublished — off-row is normal.
      continue;
    }
    const mine = rowBySetMarket.get(String(l.set) + ":" + l.market);
    if (!mine) {
      issues.push({ type: "missing", login: l.loginLower, detail: "listed " + l.market + " but on no row" });
    } else if (!mine.logins.has(l.loginLower)) {
      issues.push({
        type: "wrong-market",
        login: l.loginLower,
        detail: "ledger " + l.market + " but not on its set's row (" + String(l.set) + ")",
      });
    }
  }
  for (const entry of rowBySetMarket.values()) {
    if (entry.row.marketplace !== "gameflip") continue;
    const live = String(entry.row.accountLogin || "").toLowerCase();
    if (!live) continue;
    const liveIsLedger = ledgers.some(
      (l) =>
        l.loginLower === live &&
        l.market === "gameflip" &&
        String(l.set) === String(entry.row.set),
    );
    if (!liveIsLedger) {
      issues.push({
        type: "bad-live-unit",
        login: live,
        detail: "gameflip live unit is not a listed gameflip ledger of its set",
      });
    }
  }
  return { ok: issues.length === 0, count: issues.length, issues: issues.slice(0, 50) };
}

// Scan candidates + list new sellable accounts into their item's ONE listing.
async function scanAndListPass() {
  const cands = [];
  try {
    const [noClaim, webbot] = await Promise.all([
      collectNoClaimCandidates(),
      collectWebbotCandidates(),
    ]);
    cands.push(...noClaim, ...webbot);
  } catch (e) {
    return { skipped: true, error: e.message };
  }
  if (!cands.length) return { candidates: 0, listed: 0 };

  // Resolve passwords for no-claim candidates (pool row) and record which pool
  // row each maps to, so the ledger can release it later.
  const secrets = cands
    .filter((c) => c.source === "noclaim")
    .map((c) => c.clientSecret)
    .filter(Boolean);
  const poolBySecret = new Map();
  if (secrets.length) {
    const poolRows = await AvailableAccount.find(
      { clientSecret: { $in: secrets } },
      { clientSecret: 1, password: 1, credPasswordEnc: 1, status: 1, manualSold: 1 },
    ).lean();
    for (const p of poolRows) poolBySecret.set(p.clientSecret, p);
  }
  for (const c of cands) {
    if (c.source === "noclaim") {
      const p = poolBySecret.get(c.clientSecret);
      c.poolAccountId = p ? String(p._id) : "";
      c.id = c.poolAccountId;
      c.password = poolPassword(p);
    }
  }

  // Accounts already listed/sold/removed are skipped (their drops are
  // committed, or they were sold by hand and must never be auto-sold again).
  const ledgered = await UnclaimedAccount.find(
    { status: { $in: ["listed", "sold", "removed"] } },
    { loginLower: 1, source: 1 },
  ).lean();
  const already = new Set(ledgered.map((l) => l.source + ":" + (l.loginLower || "")));
  const soldBySecret = await soldMapForSecrets(secrets);

  // Per-game cap bookkeeping for THIS pass. A fresh count each pass, then the
  // in-pass reservation map below increments as units are attached, so a batch
  // of the same game can never overshoot the cap.
  const gameListed = new Map();
  {
    const listedRows = await UnclaimedAccount.find(
      { status: "listed" },
      { game: 1 },
    ).lean();
    for (const l of listedRows) {
      const k = gameCapKey(l.game);
      if (k) gameListed.set(k, (gameListed.get(k) || 0) + 1);
    }
  }

  const work = [];
  for (const c of cands) {
    const key = c.source + ":" + String(c.login || "").toLowerCase();
    if (already.has(key)) continue;
    if (!c.login && c.source === "noclaim") continue; // config without login
    if (c.source === "noclaim" && soldBySecret.get(c.clientSecret)) continue;
    // Manual-sold accounts (sold by the operator by hand) keep farming but are
    // NEVER attached to an auto-listing — skip them entirely.
    if (c.source === "noclaim") {
      const pool = poolBySecret.get(c.clientSecret);
      if (pool && pool.manualSold) continue;
    }
    if (c.source === "webbot" && c.manualSold) continue;
    if (c.source === "webbot" && c.password === "") continue; // nothing to sell
    work.push(c);
  }
  // Ready no-claim bot accounts scan first (numeric bot id, so bot 3-6 come
  // before bot 10), then webbot accounts on a bot, then idle webbot accounts.
  work.sort((a, b) => {
    const ka = (a.source === "webbot" ? 1 : 0) + ":" + padBot(a.botId);
    const kb = (b.source === "webbot" ? 1 : 0) + ":" + padBot(b.botId);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const batch = work.slice(0, SCAN_LIMIT);

  let listed = 0;
  const skipped = [];
  const setLocks = new Map(); // signature key -> promise chain (serialize per set)
  const gameLocks = new Map(); // game key -> promise chain (serialize cap slots)

  // Reserve one of the game's GAME_CAP slots (serialized per game so parallel
  // workers of the same game can't both take the last slot). Returns false when
  // the game is at cap — the account stays unlisted for manual sale.
  const reserveGameSlot = (gkey, login) => {
    const prev = gameLocks.get(gkey) || Promise.resolve();
    const run = prev.then(() => {
      const cur = gameListed.get(gkey) || 0;
      if (cur >= GAME_CAP) {
        skipped.push({
          login,
          error: "game at cap (" + GAME_CAP + ") — kept unlisted for manual sale",
        });
        return false;
      }
      gameListed.set(gkey, cur + 1);
      return true;
    });
    gameLocks.set(gkey, run.catch(() => true));
    return run;
  };
  const releaseGameSlot = (gkey) => {
    const cur = gameListed.get(gkey) || 0;
    if (cur > 0) gameListed.set(gkey, cur - 1);
  };

  await mapLimit(batch, CONCURRENCY, async (cand) => {
    try {
      if (cand.source === "webbot" && !cand.login) {
        try {
          const v = await webbotTwitch.validateToken(cand.webToken);
          cand.login = v.login || "";
          cand.twitchId = v.twitchId || "";
        } catch {
          return; // dead token — not listable
        }
      }
      const active = await activeListingsForLogin(cand.login);
      if (active.length) return; // already on an active listing somewhere
      let inv;
      try {
        inv = await inventoryForCandidate(cand);
      } catch {
        return; // token trouble / transport — leave it for next pass
      }
      const sellable = inv.sellable || [];
      if (!sellable.length) return; // still farming / nothing ready
      const login = inv.login || cand.login;
      const password = cand.password;
      if (!password) return;
      if (!login) return;
      const withLogin = { ...cand, login, password };
      const existing = await UnclaimedAccount.findOne({
        source: withLogin.source,
        loginLower: String(login).toLowerCase(),
      }).lean();
      if (existing && (existing.status === "listed" || existing.status === "sold")) return;

      const game = cand.game || (sellable[0] && sellable[0].game) || "";
      const signature = signatureFor(game, sellable);
      if (!signature.key) return;
      const prev = setLocks.get(signature.key) || Promise.resolve();
      const run = prev.then(async () => {
        const research = await MarketResearch.findOne({ game }).lean().catch(() => null);
        const price = derivePrice(research);
        const set = await ensureUnclaimedSet(signature, game, sellable, price);
        const { markets, ggselCategoryId } = await enabledMarketsForGame(game);
        const market = await pickMarketForSet(set._id, markets);
        if (!market) {
          skipped.push({ login, error: "no enabled marketplace" });
          return;
        }
        // Per-game cap: reserve a slot BEFORE any publish/attach. At cap, the
        // account stays unlisted (the operator can still sell it by hand); a
        // sale frees the slot for the next pass's restock.
        const gkey = gameCapKey(game || set.coverGame || "");
        if (!gkey) return;
        const reserved = await reserveGameSlot(gkey, login);
        if (!reserved) return;
        let slotUsed = false;
        try {
          // One account, one buyer — re-check under the set lock before any
          // publish/attach: the login must not already be a listed ledger unit
          // (same login from both farms) nor on another active unclaimed row.
          const loginEsc = String(login).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const dupLedger = await UnclaimedAccount.exists({
            loginLower: String(login).toLowerCase(),
            status: "listed",
          });
          if (dupLedger) {
            skipped.push({ login, error: "already listed elsewhere — skipped" });
            return;
          }
          const dupRow = await MarketplaceListing.exists({
            origin: ORIGIN,
            status: "active",
            $or: [
              { accountLogin: new RegExp("(?:^|[,\\s])" + loginEsc + "(?:$|[,\\s])", "i") },
              { "units.login": new RegExp("^" + loginEsc + "$", "i") },
            ],
          });
          if (dupRow) {
            skipped.push({ login, error: "already on another active listing — skipped" });
            return;
          }
          let row = await activeRowForSetMarket(set._id, market);
          if (market === "gameflip") {
            if (!row) {
              let img = "";
              try {
                img = await buildSetGridImage(set);
              } catch {
                img = "";
              }
              row = await publishGameflipUnit(set, withLogin, sellable, price, img);
              if (img) await fsp.unlink(img).catch(() => {});
              await ledgerAccount(
                withLogin,
                set,
                "gameflip",
                row,
                sellable,
                game,
                price,
                "unclaimed auto-list — live unit",
              );
            } else {
              await ledgerAccount(
                withLogin,
                set,
                "gameflip",
                row,
                sellable,
                game,
                price,
                "unclaimed auto-list — waiting unit",
              );
            }
          } else {
            if (!row) {
              let img = "";
              try {
                img = await buildSetGridImage(set);
              } catch {
                img = "";
              }
              row = await publishProduct(
                set,
                market,
                [withLogin],
                game,
                sellable,
                price,
                img,
                ggselCategoryId,
              );
              if (img) await fsp.unlink(img).catch(() => {});
            } else {
              await addUnitToRow(row, withLogin);
            }
            await ledgerAccount(
              withLogin,
              set,
              market,
              row,
              sellable,
              game,
              price,
              "unclaimed auto-list — stock unit",
            );
          }
          slotUsed = true;
          listed++;
          logEvent({
            category: "unclaimed",
            action: "listed",
            actor: "unclaimedAutoList",
            subject: login,
            game: game || "",
            detail:
              (cand.source || "") +
              " account " +
              login +
              " = " +
              market +
              " unit of " +
              (game || "?") +
              " ($" +
              price +
              ")",
          });
        } finally {
          if (!slotUsed) releaseGameSlot(gkey);
        }
      });
      setLocks.set(signature.key, run.catch(() => {}));
      await run;
    } catch (e) {
      skipped.push({ login: cand.login || cand.id || "", error: e.message });
    }
  });

  const repaired = await repairGameflipChains();
  return { candidates: work.length, scanned: batch.length, listed, repaired, skipped };
}

// Sets with gameflip ledgers but no live row get a live unit published again
// (heals a chain after a sale/expiry with no successor, or a failed publish).
async function repairGameflipChains() {
  const setIds = await UnclaimedAccount.distinct("set", {
    market: "gameflip",
    status: "listed",
  });
  let repaired = 0;
  for (const setId of setIds) {
    if (!setId) continue;
    const active = await MarketplaceListing.findOne({
      origin: ORIGIN,
      set: setId,
      marketplace: "gameflip",
      status: "active",
    }).lean();
    if (active) continue;
    const r = await publishGameflipSuccessor(setId, "", { log: false }).catch(
      () => ({ published: false }),
    );
    if (r && r.published) repaired++;
  }
  return repaired;
}

// Rebuild a credential-bearing candidate object for a listed ledger (used by
// the expiry/sale pass to re-read live inventory).
async function candForLedger(ledger) {
  if (ledger.source === "noclaim") {
    const pool = ledger.poolAccountId
      ? await AvailableAccount.findById(ledger.poolAccountId).lean()
      : null;
    if (!pool || !pool.clientSecret) return null;
    return {
      source: "noclaim",
      login: ledger.login,
      clientSecret: pool.clientSecret,
      password: poolPassword(pool),
    };
  }
  const wb = ledger.webBotAccountId
    ? await WebBotAccount.findById(ledger.webBotAccountId).lean()
    : null;
  if (!wb || !wb.webToken) return null;
  return {
    source: "webbot",
    login: ledger.login,
    webToken: wb.webToken,
    password: plainPassword(wb.credPasswordEnc),
  };
}

// Expiry + sale pass:
//   A) quantity-market sales (a stock drop on the item's product)
//   B) per-ledger: claimed -> spent; all drops gone -> expired + pool return;
//      Gameflip live row sold -> spent + successor
//   C) Gameflip chain repair
async function expirySalePass() {
  const out = { checked: 0, sold: 0, expired: 0, released: 0, repaired: 0, manualSoldRemoved: 0 };

  // Manual-sold accounts (sold by the operator by hand) keep farming but must
  // NEVER be auto-sold. Remove them from their listings FIRST — before any
  // sale detection in this pass — so a marked unit can never be the one the
  // platform hands to a buyer. Parked as "removed": NOT sold, NOT released.
  const msPool = await AvailableAccount.find(
    { manualSold: true },
    { _id: 1 },
  ).lean();
  const msWeb = await WebBotAccount.find(
    { manualSold: true },
    { _id: 1 },
  ).lean();
  const msPoolIds = msPool.map((p) => String(p._id));
  const msWebIds = msWeb.map((w) => String(w._id));
  const markedKeys = new Set([
    ...msPoolIds.map((id) => "p:" + id),
    ...msWebIds.map((id) => "w:" + id),
  ]);
  const msLedgers = msPoolIds.length || msWebIds.length
    ? await UnclaimedAccount.find({
        status: "listed",
        $or: [
          { poolAccountId: { $in: msPoolIds } },
          { webBotAccountId: { $in: msWebIds } },
        ],
      })
        .sort({ lastCheckedAt: 1, _id: 1 })
        .limit(CHECK_LIMIT)
        .lean()
    : [];
  const removeMarkedLedger = async (ledger) => {
    // Delist/remove this login from EVERY active row that carries it (the
    // gameflip live unit + successor, digiseller content line(s), ggsel offer
    // rebuild(s)), then park the ledger as "removed".
    await removeLoginFromAllRows(ledger, { removeFromProduct: true, log: false });
    out.manualSoldRemoved++;
    await UnclaimedAccount.updateOne(
      { _id: ledger._id, status: "listed" },
      {
        $set: {
          status: "removed",
          note: "manual sold — kept farming, removed from listings",
          lastCheckedAt: new Date(),
        },
      },
    ).catch(() => {});
    await markOwnerUnlisted(ledger);
    logEvent({
      category: "unclaimed",
      action: "manual_sold_removed",
      actor: "unclaimedAutoList",
      subject: ledger.login || ledger._id || "",
      game: ledger.game || "",
      count: 1,
      detail:
        "manual-sold account removed from listing — kept farming (" +
        (ledger.source || "") +
        ")",
    });
  };
  await mapLimit(msLedgers, CONCURRENCY, async (ledger) => {
    try {
      await removeMarkedLedger(ledger);
    } catch (e) {
      console.error("unclaimedAutoList manual-sold removal failed:", e.message);
    }
  });

  // A) Quantity-market sale detection (row-level; a stock drop is one event).
  const qtyRows = await MarketplaceListing.find({
    origin: ORIGIN,
    marketplace: { $in: ["digiseller", "ggsel"] },
    status: "active",
  }).lean();
  for (const row of qtyRows) {
    try {
      const stock =
        row.marketplace === "digiseller"
          ? await mp.digisellerProductStock(row.externalId)
          : await mp.ggselOfferStock(row.externalId);
      if (stock === null) continue;
      const last = row.lastStock == null ? stock : Number(row.lastStock);
      const dropped = last - stock;
      await MarketplaceListing.updateOne(
        { _id: row._id },
        { $set: { lastStock: stock } },
      ).catch(() => {});
      if (dropped <= 0) continue;
      const set = await DropSet.findById(row.set).lean();
      if (set) {
        await recordListingSale({
          listing: row,
          set,
          units: dropped,
          priceUsd: Number(row.price) || 0,
        }).catch(() => {});
      }
      for (let i = 0; i < dropped; i++) {
        const victim = await oldestListedUnit(row);
        if (!victim) break;
        // A marked unit may still be listed if the tick flagged it mid-pass —
        // remove it from the row instead of spending it as an auto-sale.
        if (markedKeys.has(manualSoldKey(victim))) {
          await removeMarkedLedger(victim);
          continue;
        }
        out.sold++;
        // The platform already consumed this unit — do not remove its code
        // from the product, only from our bookkeeping.
        await spendAccount(victim, row.marketplace + " sale", {
          removeFromProduct: false,
        });
      }
    } catch (e) {
      console.error("unclaimedAutoList quantity sale check failed:", e.message);
    }
  }

  // B) Per-ledger claimed / expiry / Gameflip-sale checks. Marked ledgers
  // were removed at the top of this pass; the guard below is belt-and-braces
  // for an owner tick that lands while the pass is running.
  const rest = await UnclaimedAccount.find({
    status: "listed",
    _id: { $nin: msLedgers.map((l) => l._id) },
  })
    .sort({ lastCheckedAt: 1, _id: 1 })
    .limit(Math.max(0, CHECK_LIMIT - msLedgers.length))
    .lean();
  const ledgers = rest;
  await mapLimit(ledgers, CONCURRENCY, async (ledger) => {
    try {
      // Manual-sold guard (see top of pass): never sell a marked ledger — if
      // it is still listed here, remove it instead.
      if (markedKeys.has(manualSoldKey(ledger))) {
        await removeMarkedLedger(ledger);
        return;
      }
      // The account is still on a listing — keep its console box auto-ticked.
      await markOwnerListed(ledger);
      const cand = await candForLedger(ledger);
      if (!cand) return;
      let inv = null;
      let sellable = [];
      try {
        inv = await inventoryForCandidate(cand);
        sellable = inv.sellable || [];
      } catch (e) {
        // Pi/network trouble — do not delist or sell on a failed read.
        await UnclaimedAccount.updateOne(
          { _id: ledger._id },
          { $set: { lastCheckedAt: new Date(), note: "check failed: " + e.message } },
        ).catch(() => {});
        return;
      }

      // Gameflip sale: the fulfiller marked the live row sold — the buyer got
      // the code. Spend the live unit; removeUnitFromRow publishes the
      // successor (it sees the row is already sold and skips the delist).
      if (ledger.market === "gameflip") {
        const soldRow = await MarketplaceListing.findOne({
          origin: ORIGIN,
          set: ledger.set,
          marketplace: "gameflip",
          status: "sold",
          accountLogin: ledger.login,
        }).lean();
        if (soldRow) {
          out.sold++;
          await spendAccount(ledger, "gameflip sale", { removeFromProduct: false });
          return;
        }
      }

      const ledgerKeys = new Set(
        (ledger.drops || []).map((d) => String(d.name || "").toLowerCase()),
      );
      let claimedNow = false;
      if (cand.source === "noclaim") {
        claimedNow = (inv.inProgress || []).some(
          (d) => d.claimed && ledgerKeys.has(String(d.name || "").toLowerCase()),
        );
      } else {
        claimedNow = (inv.drops || []).some(
          (d) => d.claimed && ledgerKeys.has(String(d.name || "").toLowerCase()),
        );
      }
      if (claimedNow) {
        out.sold++;
        await spendAccount(ledger, "buyer claimed a listed drop");
        return;
      }

      // Everything expired -> remove unit + release to pool.
      if (!sellable.length) {
        out.expired++;
        const ok = await expireAccount(ledger);
        if (ok) out.released++;
        return;
      }

      out.checked++;
      await UnclaimedAccount.updateOne(
        { _id: ledger._id },
        {
          $set: {
            lastCheckedAt: new Date(),
            drops: sellable.map((d) => ({
              name: d.name,
              game: d.game || ledger.game,
              campaign: d.campaign || "",
              itemKey: d.itemKey || d.name,
            })),
            note: "",
          },
        },
      ).catch(() => {});
    } catch (e) {
      console.error("unclaimedAutoList expiry pass error:", e.message);
    }
  });

  // C) Heal Gameflip chains whose live row sold/expired without a successor.
  out.repaired = await repairGameflipChains();
  return out;
}

// FIFO victim for a quantity-market sale: the oldest listed unit of the row.
async function oldestListedUnit(row) {
  const logins = (row.units || [])
    .map((u) => String(u.login || "").toLowerCase())
    .filter(Boolean);
  if (!logins.length) return null;
  const ledgers = await UnclaimedAccount.find({
    set: row.set,
    market: row.marketplace,
    status: "listed",
    loginLower: { $in: logins },
  })
    .sort({ listedAt: 1, _id: 1 })
    .lean();
  return ledgers[0] || null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Acquire the cross-process run lock. Returns true when THIS process owns the
// run; false when another process is mid-run (or its lock has not gone stale).
async function acquireRunLock() {
  try {
    const col = mongoose.connection.db.collection(RUN_LOCK_COLLECTION);
    await col.updateOne(
      { _id: RUN_LOCK_ID },
      { $setOnInsert: { holder: "", at: new Date(0) } },
      { upsert: true },
    );
    const now = new Date();
    const cutoff = new Date(now.getTime() - RUN_LOCK_TTL_MS);
    const r = await col.findOneAndUpdate(
      { _id: RUN_LOCK_ID, $or: [{ at: null }, { at: { $lt: cutoff } }] },
      { $set: { holder: String(process.pid), at: now } },
      { returnDocument: "after" },
    );
    // Driver 7 returns the document itself; older drivers return a
    // { value } ModifyResult — accept either so the takeover check works
    // on both.
    const doc = r && (r.value || r);
    return !!(doc && String(doc.holder) === String(process.pid));
  } catch (e) {
    console.error("unclaimedAutoList acquireRunLock failed:", e.message);
    return true; // lock infra down — fail OPEN so a tick can still run alone
  }
}

// Release the lock ONLY if this process still holds it (never clobber a
// newer holder after our TTL was taken over).
async function releaseRunLock() {
  try {
    await mongoose.connection.db
      .collection(RUN_LOCK_COLLECTION)
      .deleteOne({ _id: RUN_LOCK_ID, holder: String(process.pid) })
      .catch(() => {});
  } catch {
    /* best-effort */
  }
}

async function runOnce(opts = {}) {
  if (running) return { skipped: "already running", lastRun };
  const held = await acquireRunLock();
  if (!held) return { skipped: "another process is running" };
  running = true;
  const startedAt = new Date();
  try {
    const scan = opts.scan !== false ? await scanAndListPass() : null;
    const check = opts.check !== false ? await expirySalePass() : null;
    lastRun = { at: startedAt, scan, check, tookMs: Date.now() - startedAt.getTime() };
    return lastRun;
  } finally {
    running = false;
    await releaseRunLock();
  }
}

function isPaused() {
  return !!settings.getAutoFarm().unclaimedAutoListPaused;
}

function status() {
  const af = settings.getAutoFarm();
  return {
    enabled: !!af.unclaimedAutoList,
    paused: !!af.unclaimedAutoListPaused,
    running,
    lastRun,
    lastCheck,
    tickMs: TICK_MS,
  };
}

function start() {
  if (timer) return;
  timer = true;
  const tick = async () => {
    try {
      if (!settings.getAutoFarm().unclaimedAutoList) return;
      if (settings.getAutoFarm().unclaimedAutoListPaused) return;
      const r = await runOnce({});
      if (r && r.check) lastCheck = r.check;
    } catch (e) {
      console.error("unclaimedAutoList tick error:", e.message);
    } finally {
      const t = setTimeout(tick, TICK_MS);
      if (t.unref) t.unref();
    }
  };
  const t = setTimeout(tick, TICK_MS);
  if (t.unref) t.unref();
}

module.exports = {
  // pure, tested
  manualSoldKey,
  filterManualSoldLedgers,
  manualSoldOwnerKeys,
  markOwnerListed,
  markOwnerUnlisted,
  sellableDropsFromNoClaimInv,
  sellableDropsFromWebbotInv,
  plainPassword,
  signatureFor,
  dedupeSetItems,
  gameCapKey,
  chooseCapReleases,
  allocateCapKeep,
  listingTitle,
  listingDescription,
  activeListingsForLogin,
  soldMapForSecrets,
  // engine
  ensureUnclaimedSet,
  publishGameflipUnit,
  publishProduct,
  addUnitToRow,
  removeUnitFromRow,
  rowsForLogin,
  removeLoginFromAllRows,
  rebuildGgselOffer,
  spendAccount,
  expireAccount,
  releaseToPool,
  delistRowsForAccount,
  publishGameflipSuccessor,
  oldestListedUnit,
  collectNoClaimCandidates,
  collectWebbotCandidates,
  inventoryForCandidate,
  runOnce,
  acquireRunLock,
  releaseRunLock,
  status,
  start,
  isPaused,
  consistencyIssues,
  ORIGIN,
  GAME_CAP,
  TICK_MS,
  SCAN_LIMIT,
  CHECK_LIMIT,
};
