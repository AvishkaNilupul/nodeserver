// ---------------------------------------------------------------------------
// UNCLAIMED-FARMS AUTO-LISTING engine (v2).
//
// Lists + sells accounts from the no-claim farm on the same marketplaces the
// auto-farmer uses: accounts live in Pi configs (noclaim-bot-*) and farm with
// Android tokens; ground truth = twitchInventory.fetchInventory.
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
//     expired (all drops gone) -> unit removed; the account stays in its
//             no-claim bot (pool row still claimed) and is listed again once
//             it farms new drops
// Rules: never claim, never touch origin "auto"/"manual" rows, only expire an
// account after ALL of its drops are gone (confirmed by repeated empty reads —
// see shouldExpire), and never mark a pool row "available" while a no-claim bot
// still holds the account (releaseToPool).
//
// v3 (docs/UNCLAIMED-BUNDLES-CONTRACT.md): an item's identity counts COPIES
// ("4× Alpha Pack" ≠ "Alpha Pack"); listings are event-bundle aware (title,
// description, DropSet.source*) via utils/unclaimedBundles.js; new listings are
// priced from market analytics (bundlePrice) with per-game floors; live rows
// can be repriced (repriceUnclaimedRows, flag unclaimedRepriceExisting, default
// OFF); Gameflip lots of N accounts (utils/unclaimedLots.js, flag
// unclaimedGameflipLots, default OFF).
// ---------------------------------------------------------------------------
const fsp = require("fs/promises");
const mongoose = require("mongoose");
const hosts = require("./botHosts");
const settings = require("./settings");
const pricingEngine = require("./pricing");
const pricingEvidenceMod = require("./pricingEvidence");
const { classifyKind } = require("./marketPricing");
const twitchInventory = require("./twitchInventory");
const mp = require("./marketplaces");
const { decrypt } = require("./secretBox");
const { buildSetGridImage } = require("./setImage");
const { derivePrice, buildDescription } = require("./autoLister");
const { digisellerDeliveryCode } = require("./digisellerFulfiller");
const { ggselDeliveryCode } = require("./ggselFulfiller");
const { gameflipDeliveryCode } = require("./gameflipFulfiller");
const { recordListingSale } = require("./saleLearning");
const { sendTelegram } = require("./telegram");
const { logEvent } = require("./systemLog");
const { recordPoolUsage } = require("./poolUsageLog");
// The per-(host, file) lock noclaimFleet.topUpBot takes on a bot config: an edit
// here and a top-up there on the same config are serialized, never lost.
const { withFileLock } = require("./fileLock");
// Item-name counting shared with the delivery gate and the listing audit, so a
// unit's "does it still hold its listing" check reads names exactly like they do.
const coverage = require("./unclaimedCoverage");
const AvailableAccount = require("../models/AvailableAccount");
const BotAccount = require("../models/BotAccount");
const DropSet = require("../models/DropSet");
const MarketplaceListing = require("../models/MarketplaceListing");
const UnclaimedAccount = require("../models/UnclaimedAccount");
const MarketResearch = require("../models/MarketResearch");
const NoclaimSpentAccount = require("../models/NoclaimSpentAccount");
const TwitchCampaign = require("../models/TwitchCampaign");

// v3 siblings (docs/UNCLAIMED-BUNDLES-CONTRACT.md): the bundle classifier /
// analytics pricer and the Gameflip lot publisher. Required lazily and guarded
// so the engine still loads (and every pure helper still works) when a sibling
// is missing or broken — a bundle/lot failure must degrade to the v2 behaviour
// (plain qty-aware titles, floor pricing, no lots), never take the tick down.
let _bundlesMod;
function bundlesMod() {
  if (_bundlesMod !== undefined) return _bundlesMod;
  try {
    _bundlesMod = require("./unclaimedBundles");
  } catch (e) {
    _bundlesMod = null;
    console.error("unclaimedAutoList: unclaimedBundles unavailable:", e.message);
  }
  return _bundlesMod;
}
let _lotsMod;
function lotsMod() {
  if (_lotsMod !== undefined) return _lotsMod;
  try {
    _lotsMod = require("./unclaimedLots");
  } catch (e) {
    _lotsMod = null;
    console.error("unclaimedAutoList: unclaimedLots unavailable:", e.message);
  }
  return _lotsMod;
}

const ORIGIN = "unclaimed";
const SET_NOTE = "Unclaimed auto-list";
const HOST_ID = "contabo";
const BASE = "/home/ubuntu/twitchbot-noclaim";
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

// ---------------------------------------------------------------------------
// Unclaimed Drop archive views (read-only browsing over UnclaimedAccount).
// The collection is small, so the endpoints feed a projected find() output
// into these pure grouping helpers — never a $group (Atlas shared tier has
// allowDiskUse OFF). Exported so the views and the tests share one rule.
// ---------------------------------------------------------------------------

// "Held / available stock" = listed + skipped. Everything else
// (sold/expired/released/removed) means the account's drops are gone.
const ARCHIVE_HELD_STATUSES = ["listed", "skipped"];
const ARCHIVE_STATUS_ZERO = {
  listed: 0,
  sold: 0,
  expired: 0,
  released: 0,
  skipped: 0,
  removed: 0,
  // Committed to an owner's hand-made no-claim listing (not "held" stock).
  manual: 0,
};

// Map the archive views' ?status= onto a Mongo filter. Empty/"held" (the
// default) mean the listed+skipped bucket; "all" means no filter (the
// per-status breakdown is shown); any other value is a single raw status.
function archiveStatusFilter(status) {
  const raw = String(status || "").trim().toLowerCase();
  if (!raw || raw === "held") return { status: { $in: ARCHIVE_HELD_STATUSES.slice() } };
  if (raw === "all") return null;
  return { status: raw };
}

// The stable key two drop copies share. Prefer the stored itemKey; legacy
// rows without one fall back to a normalized `${game}|${name}` key.
function archiveItemKey(drop, game) {
  const d = drop || {};
  const key = String(d.itemKey || "").trim();
  if (key) return key;
  return (
    String(game || "").trim().toLowerCase() +
    "|" +
    String(d.name || "").trim().toLowerCase()
  );
}

// The farm an unclaimed account can come from. Anything else is ignored for
// the per-source split (so a blank/unknown source never inflates a count).
const ARCHIVE_SOURCES = ["noclaim"];
function archiveSource(row) {
  const s = String((row && row.source) || "").trim().toLowerCase();
  return ARCHIVE_SOURCES.includes(s) ? s : "";
}

// Pick the display label for a group of game strings that normalise to the same
// game (e.g. "Overwatch" vs "overwatch"). Prefer the most common spelling, then
// one that actually has an uppercase letter (a real proper-noun casing), then
// alphabetical — so the merged row reads "Overwatch", not "overwatch".
function pickGameLabel(labelCounts) {
  let best = "";
  let bestScore = -Infinity;
  for (const [label, count] of labelCounts || []) {
    const hasUpper = /[A-Z]/.test(label);
    const hasLower = /[a-z]/.test(label);
    // Frequency dominates (×4). Ties break to proper Title-case ("Overwatch")
    // over ALL-CAPS ("OVERWATCH") over all-lowercase ("overwatch").
    const score =
      count * 4 + (hasUpper && hasLower ? 2 : 0) + (hasUpper ? 1 : 0);
    if (score > bestScore || (score === bestScore && label.localeCompare(best) < 0)) {
      best = label;
      bestScore = score;
    }
  }
  return best;
}

// Group a projected UnclaimedAccount result set by item for the By-item view.
// rows: [{ _id, source, game, status, drops:[{ name, game, itemKey }] }].
// withStatus also rolls up per-status ACCOUNT counts (one per holding account).
// bySource splits the distinct-account count into no-claim vs web-token farms.
function groupArchiveByItem(rows, withStatus) {
  const items = new Map();
  for (const row of rows || []) {
    const game = String((row && row.game) || "").trim();
    const status = (row && row.status) || "skipped";
    const source = archiveSource(row);
    const seen = new Set();
    for (const drop of (row && row.drops) || []) {
      const key = archiveItemKey(drop, game);
      let it = items.get(key);
      if (!it) {
        it = {
          itemKey: key,
          name: String((drop && drop.name) || "").trim(),
          labels: new Map(),
          accounts: new Set(),
          bySourceAccts: { noclaim: new Set() },
          units: 0,
          byStatus: withStatus ? Object.assign({}, ARCHIVE_STATUS_ZERO) : null,
        };
        items.set(key, it);
      }
      it.units += 1;
      it.accounts.add(String(row._id));
      if (source) it.bySourceAccts[source].add(String(row._id));
      if (game) it.labels.set(game, (it.labels.get(game) || 0) + 1);
      if (it.byStatus && !seen.has(key)) {
        it.byStatus[status] += 1;
        seen.add(key);
      }
    }
  }
  return [...items.values()]
    .map((it) => ({
      itemKey: it.itemKey,
      name: it.name,
      game: pickGameLabel(it.labels),
      accounts: it.accounts.size,
      units: it.units,
      bySource: { noclaim: it.bySourceAccts.noclaim.size },
      byStatus: it.byStatus,
    }))
    .sort(
      (a, b) =>
        b.accounts - a.accounts ||
        b.units - a.units ||
        String(a.itemKey).localeCompare(String(b.itemKey)),
    );
}

// Group the same result set by game for the By-game view. Games are folded by
// their normalized name (so "Overwatch" and "overwatch" are ONE row), keeping
// the nicest spelling for display. `items` is the count of DISTINCT item keys;
// bySource splits accounts into no-claim vs web-token.
function groupArchiveByGame(rows, withStatus) {
  const games = new Map();
  for (const row of rows || []) {
    const game = String((row && row.game) || "").trim();
    const status = (row && row.status) || "skipped";
    const source = archiveSource(row);
    const key = String(settings.normGameName(game) || game || "").trim() || "(none)";
    let g = games.get(key);
    if (!g) {
      g = {
        labels: new Map(),
        accounts: new Set(),
        items: new Set(),
        bySource: { noclaim: 0 },
        byStatus: withStatus ? Object.assign({}, ARCHIVE_STATUS_ZERO) : null,
      };
      games.set(key, g);
    }
    if (game) g.labels.set(game, (g.labels.get(game) || 0) + 1);
    g.accounts.add(String(row._id));
    if (source) g.bySource[source] += 1;
    for (const drop of (row && row.drops) || []) {
      g.items.add(archiveItemKey(drop, game));
    }
    if (g.byStatus) g.byStatus[status] += 1;
  }
  return [...games.values()]
    .map((g) => ({
      game: pickGameLabel(g.labels),
      accounts: g.accounts.size,
      items: g.items.size,
      bySource: g.bySource,
      byStatus: g.byStatus,
    }))
    .sort(
      (a, b) =>
        b.accounts - a.accounts || String(a.game).localeCompare(String(b.game)),
    );
}

// Stored credentials are secretBox-encrypted; some legacy rows carry a
// "plain:" prefix. Return the usable plaintext or "".
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

// Numeric-friendly bot sort key ("3" < "10" < idle "").
function padBot(id) {
  const n = parseInt(String(id || ""), 10);
  if (Number.isFinite(n)) return String(n).padStart(8, "0");
  return "zz" + String(id || "");
}

// Normalised identity key of one drop (stored itemKey, else its name).
function dropKey(d) {
  return String((d && (d.itemKey || d.name)) || "").trim().toLowerCase();
}

// How many copies one drop entry stands for. Raw inventory drops are one copy
// each (duplicates in the list ARE copies); drops rebuilt from a set's items
// carry the set's qty so a successor/rebuild keeps the "4× Alpha Pack" identity.
function dropQty(d) {
  const q = Math.floor(Number(d && d.qty));
  return Number.isFinite(q) && q > 1 ? q : 1;
}

// Count copies per itemKey, in first-seen order. Returns Map key -> qty.
function qtyByKey(drops) {
  const counts = new Map();
  for (const d of drops || []) {
    const key = dropKey(d);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + dropQty(d));
  }
  return counts;
}

// "The same item" = one game + the exact same set of drop itemKeys AND copies
// (v3: "4× Alpha Pack" and "1× Alpha Pack" are different items). A key is
// written `itemKey×qty` when qty>1 so a qty-1 signature is unchanged from v2.
//   keys     — decorated, sorted (the identity)
//   itemKeys — plain, sorted (the $all prefilter for findUnclaimedSet)
//   pairs    — [[itemKey, qty]] sorted by itemKey (the exact JS match)
function signatureFor(game, drops) {
  const g = String(game || "").trim().toLowerCase();
  const counts = qtyByKey(drops);
  const itemKeys = [...counts.keys()].sort();
  const pairs = itemKeys.map((k) => [k, counts.get(k)]);
  const keys = pairs.map(([k, q]) => (q > 1 ? k + "×" + q : k));
  return { game: g, keys, itemKeys, pairs, key: g + "|" + keys.join(",") };
}

// A set's items are ONE row per unique drop with `qty` = the number of copies
// (an account can hold several copies of the same drop — e.g. "Alpha Pack"
// from four campaigns — and the signature folds them into one qty-4 item, so
// the items must too, or findUnclaimedSet's size check never matches and every
// account gets its own set/listing).
function dedupeSetItems(drops, game) {
  const counts = qtyByKey(drops);
  const seen = new Set();
  const items = [];
  for (const d of drops || []) {
    // Lowercased exactly like signatureFor: the signature is the set's
    // identity, and findUnclaimedSet matches items.itemKey with $all — a
    // case mismatch would silently create a duplicate set per account again.
    const key = dropKey(d);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    items.push({
      itemKey: key,
      name: d.name || "Reward",
      game: d.game || game,
      image: d.imageURL || "",
      qty: counts.get(key) || 1,
    });
  }
  return items;
}

// The drops a set stands for, in the shape the publish/title helpers expect
// (like scan `sellable`), carrying each item's qty so titles and signatures
// rebuilt from the set stay qty-aware.
function dropsFromSet(set) {
  return ((set && set.items) || []).map((i) => ({
    name: i.name,
    game: i.game,
    campaign: "",
    imageURL: i.image || "",
    itemKey: i.itemKey,
    qty: dropQty(i),
  }));
}

// Expand a set's items back into one drop entry PER COPY — the shape
// classifyHoldings takes (duplicates are copies). Used when a classification
// has to be rebuilt from a stored set (successor publish, rebuild, reprice).
function expandSetDrops(set) {
  const out = [];
  for (const d of dropsFromSet(set)) {
    const n = dropQty(d);
    for (let i = 0; i < n; i++) out.push({ ...d, qty: 1 });
  }
  return out;
}

// ONE listing = ONE game. An account can farm drops for several games at once
// (a no-claim bot watches every FavouriteGame), but a listing must never
// advertise another game's items under a single "Game:" line. Group the
// account's sellable drops by their REAL game and pick one group to list:
// the account's configured game when it has drops there, otherwise the
// largest group (preferring a labeled group over unlabeled drops). Returns
// { game, drops } where drops is ONLY that game's sellable drops.
function pickListingGroup(preferredGame, drops) {
  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const groups = new Map();
  for (const d of drops || []) {
    const key = norm(d.game) || "__unlabeled__";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }
  if (!groups.size) return { game: preferredGame || "", drops: drops || [] };
  const preferred = norm(preferredGame);
  let chosen;
  if (preferred && groups.has(preferred)) chosen = groups.get(preferred);
  if (!chosen) {
    chosen = Array.from(groups.entries())
      .sort((a, b) => {
        const aEmpty = a[0] === "__unlabeled__";
        const bEmpty = b[0] === "__unlabeled__";
        if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
        return b[1].length - a[1].length;
      })[0][1];
  }
  const game = (chosen[0] && chosen[0].game) || preferredGame || "";
  return { game, drops: chosen };
}

// The drops a listing TITLE/DESCRIPTION should show: one entry per unique
// itemKey (same dedupe rule as signatureFor / dedupeSetItems) carrying `qty` =
// the number of copies, preserving the first-seen drop so the title builders
// see exactly the set's items. An account holding "Alpha Pack" from four
// campaigns is ONE item with qty 4 — "4× Alpha Pack", never
// "Alpha Pack + Alpha Pack +2 more". Never mutates the input drops.
function uniqueDrops(drops) {
  const counts = qtyByKey(drops);
  const seen = new Set();
  const out = [];
  for (const d of drops || []) {
    if (!d || !String(d.name || "").trim()) continue;
    const key = dropKey(d);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...d, itemKey: key, qty: counts.get(key) || 1 });
  }
  return out;
}

// Ledger -> owner key used to match a manual-sold tick ("p:" = pool row for a
// no-claim account).
function manualSoldKey(ledger) {
  if (!ledger) return "";
  if (ledger.source === "noclaim" && ledger.poolAccountId) return "p:" + ledger.poolAccountId;
  return "";
}

// Drop ledgers whose owner row carries the manual-sold tick. Pure + exported
// so the successor chain and the check pass share one rule.
function filterManualSoldLedgers(ledgers, markedOwnerKeys) {
  if (!markedOwnerKeys || markedOwnerKeys.size === 0) return ledgers || [];
  return (ledgers || []).filter((l) => !markedOwnerKeys.has(manualSoldKey(l)));
}

// Batch-load which of these ledgers' owner rows carry the manual-sold tick.
// Returns a Set of manualSoldKey() values ("p:<poolId>").
async function manualSoldOwnerKeys(ledgers) {
  const marked = new Set();
  const poolIds = [
    ...new Set(
      (ledgers || [])
        .filter((l) => l && l.source === "noclaim" && l.poolAccountId)
        .map((l) => l.poolAccountId),
    ),
  ];
  if (poolIds.length) {
    const rows = await AvailableAccount.find(
      { _id: { $in: poolIds }, manualSold: true },
      { _id: 1 },
    ).lean();
    for (const r of rows) marked.add("p:" + String(r._id));
  }
  return marked;
}

// Listing copy — the account and its unclaimed drops, with the connect-and-
// House title style, exactly like the auto-lister:
//   "{Game} Twitch Drops ({N} Items) — {Item A} + {Item B} +{N-2} more"
// so a buyer sees the item and its drops, not a vague "drop account".
//
// v3: qty-aware and event-aware. `cls` is the unclaimedBundles.classifyHoldings
// result for these drops (null/undefined when unknown); the title comes from
// unclaimedBundles.bundleTitle. When that module is unavailable (or throws)
// the local fallback below produces the contract's "no event" form itself:
//   "{Game} Twitch Drops (5 Items) — 4× Alpha Pack + SMELLS LIKE BURNING"
// where the item count is the SUM of copies.
function qtyTitleFallback(game, items) {
  const g = String(game || "Twitch").trim();
  const total = items.reduce((m, i) => m + dropQty(i), 0);
  const names = items.map((i) => (dropQty(i) > 1 ? dropQty(i) + "× " : "") + i.name);
  const prefix = g + " Twitch Drops";
  const countBit = " (" + total + " Item" + (total === 1 ? "" : "s") + ")";
  const more = names.length > 2 ? " +" + (names.length - 2) + " more" : "";
  let title = prefix + countBit + " — " + names.slice(0, 2).join(" + ") + more;
  if (title.length > 120) {
    const one = names[0] ? " — " + names[0] + (names.length > 1 ? " +" + (names.length - 1) + " more" : "") : "";
    title = prefix + countBit + one;
  }
  if (title.length > 120) title = (prefix + countBit).slice(0, 120);
  return title;
}

function listingTitle(game, drops, cls) {
  const items = uniqueDrops(drops);
  if (!items.length) {
    return (game ? String(game).trim() : "Twitch") + " drop account — unclaimed";
  }
  const g = String(game || "Twitch").trim();
  const ub = bundlesMod();
  if (ub && typeof ub.bundleTitle === "function") {
    try {
      const t = String(
        ub.bundleTitle({ game: g, items, classification: cls || null }) || "",
      ).trim();
      if (t) return t.slice(0, 120);
    } catch (e) {
      console.error("unclaimedAutoList bundleTitle failed:", e.message);
    }
  }
  return qtyTitleFallback(g, items);
}

// Reuse the auto-lister's house description so an unclaimed listing reads
// EXACTLY like a normal auto-farm listing: an "Includes:" item list, the
// connect-and-claim block, the standard buyer sections, and a support line
// that names the marketplace the buyer is actually on ("message me here on
// GGSel" must never appear on Gameflip, and vice versa). `marketplace` is one
// of "gameflip" / "digiseller" / "ggsel" (undefined -> a neutral support line
// with no site name). Drops are deduped to one item per set exactly as the
// title/set are, so a four-campaign "Alpha Pack" is one line, not four.
//
// SECURITY: the public description must NEVER name the account — credentials
// are attached as the platform's auto-delivery code and handed to the buyer
// ONLY after the order completes (same model as the auto-farm). It takes no
// login at all.
//
// v3: `cls` (classifyHoldings result) adds unclaimedBundles.bundleDescriptionLines
// — the event line, the copies line, the bulk line — inserted BEFORE the house
// "Includes:" list (the contract's "after the first line" for a description
// whose first line IS the item list: the bundle lines lead, the house template
// follows unchanged). `opts.lotsEnabled`/`opts.lotSize` feed the Gameflip bulk
// line. Items carry qty, so the house list already reads "- 4× Alpha Pack".
function listingDescription(game, drops, marketplace, cls, opts = {}) {
  const items = uniqueDrops(drops);
  const g = String(game || "Twitch").trim();
  if (!items.length) {
    return (
      "Twitch account with unclaimed Twitch Drops for " + g +
      " — already earned (100%) and left unclaimed, so you connect your own " +
      "game account and claim them yourself."
    );
  }
  const base = buildDescription({
    game: g,
    items,
    campaignName: "",
    postEvent: false,
    marketplace,
  });
  let extra = [];
  const ub = bundlesMod();
  if (ub && typeof ub.bundleDescriptionLines === "function") {
    try {
      extra = (
        ub.bundleDescriptionLines({
          game: g,
          items,
          classification: cls || null,
          marketplace,
          lotsEnabled: !!opts.lotsEnabled,
          lotSize: Number(opts.lotSize) || 0,
        }) || []
      )
        .map((l) => String(l == null ? "" : l))
        .filter((l) => l.trim());
    } catch (e) {
      console.error("unclaimedAutoList bundleDescriptionLines failed:", e.message);
      extra = [];
    }
  }
  if (!extra.length) return base;
  const lines = base.split("\n");
  let at = lines.findIndex((l) => l.trim() === "Includes:");
  if (at < 0) at = 0;
  lines.splice(at, 0, ...extra, "");
  return lines.join("\n").slice(0, 5000);
}

// EXPIRY STRIKES (v3). One empty inventory read is not proof the drops are
// gone — Twitch returns an empty inventory transiently, and v2 delisted on the
// spot, then re-listed the same account ten minutes later (the Marvel Rivals
// flap). Pure decision for the check pass:
//   ledger        — { emptyReads, firstEmptyAt } (the stored strikes)
//   now           — ms epoch
//   confirmPasses — consecutive empty reads required (settings, default 2)
//   campaignEnded — every campaign the ledger's drops came from ended >1h ago
//   empty         — whether THIS read was empty (default true; a non-empty
//                   read resets the strikes and never expires)
// Returns { expire, emptyReads, firstEmptyAt, reason } — the caller persists
// emptyReads/firstEmptyAt. Expire when emptyReads >= confirmPasses AND the
// first empty read was >= 20 min ago, OR the campaign(s) ended and this is at
// least the first empty read (an ended campaign's drops cannot come back).
const EXPIRY_MIN_GAP_MS = 20 * 60 * 1000;
function shouldExpire(ledger, now, opts = {}) {
  const t = Number(now);
  const nowMs = Number.isFinite(t) ? t : Date.now();
  const empty = opts.empty !== false;
  if (!empty) {
    return { expire: false, emptyReads: 0, firstEmptyAt: null, reason: "non-empty read" };
  }
  const passes = Math.max(1, Math.floor(Number(opts.confirmPasses) || 0) || 2);
  const prevRaw = Number(ledger && ledger.emptyReads);
  const prev = Number.isFinite(prevRaw) && prevRaw > 0 ? Math.floor(prevRaw) : 0;
  const emptyReads = prev + 1;
  let first = ledger && ledger.firstEmptyAt ? new Date(ledger.firstEmptyAt) : null;
  if (!first || Number.isNaN(first.getTime())) first = new Date(nowMs);
  const gapOk = nowMs - first.getTime() >= EXPIRY_MIN_GAP_MS;
  // NOTE: `opts.campaignEnded` deliberately does NOT shortcut the strikes.
  // The stock this engine sells is post-event by design (Week 1 + Finals,
  // EWC DAY 1..10), so "campaign ended" is true for most listed accounts while
  // their drops are still sitting in the inventory — an empty read on such an
  // account is far more likely a transient GQL failure than a real expiry.
  // Confirmation always needs `passes` consecutive empty reads spanning the
  // minimum gap; the flag only annotates the reason.
  if (emptyReads >= passes && gapOk) {
    return {
      expire: true,
      emptyReads,
      firstEmptyAt: first,
      reason:
        emptyReads + " consecutive empty reads" + (opts.campaignEnded ? " (campaign ended)" : ""),
    };
  }
  return {
    expire: false,
    emptyReads,
    firstEmptyAt: first,
    reason:
      emptyReads < passes
        ? "empty read " + emptyReads + "/" + passes
        : "awaiting 20-minute confirmation gap",
  };
}

// campaignEnded input for shouldExpire: every campaign named in the ledger's
// drops has ended more than an hour ago per TwitchCampaign. `ended` is a Set of
// "normGame|campaign name lowercased" keys (see endedCampaignKeys); unknown
// campaigns / drops with no campaign name count as NOT ended (conservative).
function ledgerCampaignsEnded(ledger, ended) {
  const names = [
    ...new Set(
      ((ledger && ledger.drops) || [])
        .map((d) => String((d && d.campaign) || "").trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (!names.length || !ended || !ended.size) return false;
  const g = settings.normGameName((ledger && ledger.game) || "");
  return names.every((n) => ended.has(g + "|" + n));
}

// Did a buyer claim a LISTED drop? Pure; `invData` is the Twitch inventory
// ({ inProgress, drops }), `sellable` what it still holds unclaimed at 100%.
//
// A listed item counts as claimed only when BOTH hold:
//  - fewer copies of it are still held unclaimed than the listing was made
//    with (count-aware — "2 loot boxes" with one left has lost one), AND
//  - the account shows a matching claim: the drop marked claimed inside a
//    still-running campaign (same campaign when both are named), or a claimed
//    reward of that name awarded at/after the listing. Once EVERY drop of a
//    campaign is claimed Twitch drops the campaign from inProgress, so a
//    full-bundle claim is only visible as a reward.
// Either half alone is not a sale: copies vanish when a wave expires (the
// expiry path handles that), and item names recur across campaigns — an
// account migrated from a claiming bot carries claimed rewards of the same
// names while every listed copy is still unclaimed (seen on prod 2026-09-11).
function buyerClaimedListed(ledger, invData, sellable) {
  const norm = (s) => String(s || "").trim().toLowerCase();
  const listed = new Map(); // name -> { n, campaigns }
  for (const d of (ledger && ledger.drops) || []) {
    const k = norm(d && d.name);
    if (!k) continue;
    const e = listed.get(k) || { n: 0, campaigns: new Set() };
    e.n++;
    if (d.campaign) e.campaigns.add(norm(d.campaign));
    listed.set(k, e);
  }
  if (!listed.size) return { claimed: false, items: [] };
  const held = new Map();
  for (const d of sellable || []) {
    const k = norm(d && d.name);
    if (k) held.set(k, (held.get(k) || 0) + 1);
  }
  const listedAt = ledger && ledger.listedAt ? new Date(ledger.listedAt).getTime() : 0;
  const inv = invData || {};
  const items = [];
  for (const [k, e] of listed) {
    if ((held.get(k) || 0) >= e.n) continue; // every listed copy still unclaimed
    const inCampaign = (inv.inProgress || []).some(
      (d) =>
        d &&
        d.claimed &&
        norm(d.name) === k &&
        (!e.campaigns.size || !d.campaign || e.campaigns.has(norm(d.campaign))),
    );
    const asReward = (inv.drops || []).some(
      (d) =>
        d &&
        norm(d.name) === k &&
        !!d.awardedAt &&
        new Date(d.awardedAt).getTime() >= listedAt,
    );
    if (inCampaign || asReward) items.push(k);
  }
  return { claimed: items.length > 0, items };
}

// ---------------------------------------------------------------------------
// Does a unit still hold what its listing promises? (owner, 2026-09-28)
// ---------------------------------------------------------------------------
// An event's wave expires a few days after its campaign ends and its drops
// leave every account of that cohort at once; the listing text does not
// change. Rainbow Six waves ("R6S S2 2026 N") each give three Esports Packs, so
// on 2026-09-28 five live Gameflip listings said 12× or 11× while the account
// on sale held 9×. The check pass only acted on a completely EMPTY account, so
// a unit that had lost part of its bundle stayed on sale under the full title.

// What the buyer of ONE unit is promised, as Map<normalised name, copies>: the
// row's own declared list when it has one (a rebundled title), else the set's
// items with their copies. A waiting Gameflip unit is promised the set — the
// successor is published from it.
function unitPromise(set, row) {
  const declared =
    row && Array.isArray(row.requiredDrops) && row.requiredDrops.length ? row.requiredDrops : null;
  return coverage.requiredCounts(declared || (set && set.items) || []);
}

// Copies of each item held (one inventory entry per copy; a drop rebuilt from a
// set carries its qty).
function heldByName(drops) {
  const out = new Map();
  for (const d of drops || []) {
    const k = coverage.normName(d && d.name);
    if (!k) continue;
    out.set(k, (out.get(k) || 0) + dropQty(d));
  }
  return out;
}

// [{ name, need, have }] the unit is short of; [] when it holds everything. A
// set with no items promises nothing checkable, so it is never a shortfall.
function unitShortfall(set, row, drops) {
  const promise = unitPromise(set, row);
  if (!promise.size) return [];
  return coverage.shortOf(heldByName(drops), promise);
}

function shortSummary(missing) {
  const list = missing || [];
  return (
    list
      .slice(0, 4)
      .map((m) => m.name + " " + m.have + "/" + m.need)
      .join(", ") + (list.length > 4 ? " +" + (list.length - 4) + " more" : "")
  );
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

// The pool note the no-claim farm stamps when it claims an account for a bot
// (utils/noclaimFleet.js CLAIM_NOTE_PREFIX, "noclaim-farm:<game>").
const NOCLAIM_OWNER_NOTE = /^noclaim-farm:/i;

// Why this pool row does NOT belong to the no-claim farm ("" = it does).
//
// Only an account the pool says the no-claim farm owns may be sold from a
// no-claim bot. "available" means any system may claim it at any moment, and a
// "claimed" row with another note (the auto-farm, a renter, a bot deploy) means
// a CLAIMING bot may hold the same login — it claims whatever the account
// farms, so a buyer would receive an account emptied under them. Both states
// used to come from the auto-lister itself: expiry marked the row "available"
// while the no-claim bot still held the account, and the auto-farm then claimed
// it into a second bot (34 accounts into a Marvel Rivals bot on 2026-09-25).
function poolOwnerBlock(pool) {
  if (!pool) return "no pool row";
  if (pool.status !== "claimed") return "pool row is " + (pool.status || "unset");
  const note = String(pool.claimedNote || "").trim();
  if (!NOCLAIM_OWNER_NOTE.test(note)) return "pool says: " + (note.slice(0, 60) || "(no note)");
  return "";
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

// Bots the operator marked "my own" (a `.personal` file in the bot dir,
// noclaimFleet.setPersonal). Their accounts are fenced with manualSold but were
// never sold, so nothing here ever takes one out of its bot. One listing.
async function personalBotIds() {
  const out = await sh(
    `for d in ${hosts.shq(BOTS_DIR)}/*/; do [ -f "$d.personal" ] && basename "$d"; done; true`,
    { timeout: 20000 },
  );
  return new Set(
    out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

// Take accounts OUT of one no-claim bot's config, by ClientSecret — the one
// identity a config and the pool share (a Twitch login can be renamed).
//
// Read -> filter -> write under the same per-file lock as noclaimFleet.topUpBot,
// written by tmp + mv and read back to prove the accounts are gone (the old
// in-place `cat >` with no lock could lose a concurrent top-up, or tear the
// config). A running bot restarts so it stops farming them now; a parked bot
// reads the new config when it next starts — restarting it would wake it
// against the auto-power watcher. A config left with no accounts is marked
// .operatoroff and stopped: an empty config tight-loops, and the watcher starts
// any stopped bot that lacks the marker. Throws when the config cannot be read,
// parsed or rewritten; the caller then stamps nothing and retries next pass.
async function removeFromBotConfig(botId, secrets) {
  const id = String(botId || "").replace(/[^0-9]/g, "");
  const want = new Set((secrets || []).map((s) => String(s || "")).filter(Boolean));
  if (!id || !want.size) return { removed: [], left: null, restarted: false, parked: false };
  const file = CONFIG_PATH(id);
  return withFileLock(pi(), file, async () => {
    const parse = (raw, what) => {
      try {
        return JSON.parse(raw);
      } catch (e) {
        throw new Error("bot " + id + " config " + what + " is not valid JSON (" + e.message + ")");
      }
    };
    const cfg = parse(await readConfigRaw(id), "read");
    const ts = cfg.TwitchSettings || (cfg.TwitchSettings = {});
    const users = Array.isArray(ts.TwitchUsers) ? ts.TwitchUsers : [];
    const isOut = (u) => want.has(String((u && u.ClientSecret) || ""));
    const removed = users.filter(isOut).map((u) => String(u.ClientSecret));
    if (!removed.length) return { removed: [], left: users.length, restarted: false, parked: false };
    ts.TwitchUsers = users.filter((u) => !isOut(u));
    // Guarded write: a cut-off transfer is never installed (botHosts.guardedWriteScript).
    const text = JSON.stringify(cfg, null, 2);
    await sh(hosts.guardedWriteScript(file, hosts.byteLength(text), { mode: "600" }), {
      timeout: 20000,
      input: text,
    });
    const back = parse(await readConfigRaw(id), "re-read");
    const still = ((back.TwitchSettings && back.TwitchSettings.TwitchUsers) || []).filter(isOut);
    if (still.length) {
      throw new Error("bot " + id + ": " + still.length + " account(s) still in the config after the write");
    }
    const left = ts.TwitchUsers.length;
    const container = hosts.shq(containerFor(id));
    if (!left) {
      await sh(
        `touch ${hosts.shq(BOTS_DIR + "/" + id + "/.operatoroff")}; docker stop ${container} >/dev/null 2>&1 || true`,
        { timeout: 40000 },
      );
      return { removed, left: 0, restarted: false, parked: true };
    }
    const out = await sh(
      `if [ "$(docker inspect -f '{{.State.Running}}' ${container} 2>/dev/null)" = "true" ]; ` +
        `then docker restart ${container} >/dev/null 2>&1 && echo restarted; fi; true`,
      { timeout: 60000 },
    );
    return { removed, left, restarted: /restarted/.test(out), parked: false };
  });
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
// paths, then read them all (gzip/base64 batched). Returns [{ path, id, cfg }],
// `cfg` null when the file could not be read or parsed.
async function readNoClaimConfigs() {
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
  return paths.map((p) => {
    const f = files[p];
    let cfg = null;
    if (f && f.ok && f.text) {
      try {
        cfg = JSON.parse(f.text);
      } catch {
        cfg = null; // corrupt config — the bots page already flags those
      }
    }
    return { path: p, id: String(p.split("/")[5] || "").replace(/[^0-9]/g, ""), cfg };
  });
}

// Which no-claim bots hold this ClientSecret, from one read of every config.
// `unreadable` counts configs that could not be read or parsed: any of them
// may hold the account too, so a caller deciding it is gone must treat a
// non-zero count as "not proven". So does an EMPTY listing — the fleet is never
// empty, and the listing's `|| true` turns a failed `ls` into no output.
async function botsHoldingSecret(secret) {
  const s = String(secret || "");
  const botIds = [];
  let unreadable = 0;
  let game = ""; // the first holding bot's game (FavouriteGames[0])
  const configs = await readNoClaimConfigs();
  if (!configs.length) return { botIds, unreadable: 1, game };
  for (const { id, cfg } of configs) {
    if (!cfg) {
      unreadable++;
      continue;
    }
    const users = (cfg.TwitchSettings && cfg.TwitchSettings.TwitchUsers) || [];
    if (s && users.some((u) => u && String(u.ClientSecret || "") === s)) {
      botIds.push(id);
      if (!game) game = (cfg.FavouriteGames || [])[0] || "";
    }
  }
  return { botIds, unreadable, game };
}

// Flat account rows from every readable no-claim bot config.
async function collectNoClaimCandidates() {
  const out = [];
  for (const { id, cfg } of await readNoClaimConfigs()) {
    if (!cfg) continue;
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

// Live inventory for one candidate, plus the sellable drops in it.
async function inventoryForCandidate(cand) {
  const inv = await twitchInventory.fetchInventory(cand.clientSecret, {
    host: pi(),
  });
  return {
    inv,
    sellable: sellableDropsFromNoClaimInv(inv),
    login: inv.login || cand.login,
  };
}

// ---------------------------------------------------------------------------
// Item sets (ONE DropSet per game + exact drop set)
// ---------------------------------------------------------------------------

// The enabled marketplaces for a game, in split-priority order. ZeusX is NOT
// included: it is a manual hand-over market for the auto-farm and has no
// auto-sell path, so unclaimed stock is not published there.
// Plati may take new stock only while the owner's switch is on
// (autoFarm.platiEnabled) and the seller account is not blocked — a blocked
// seller's products cannot be bought, and 52 of the 100 listed accounts once
// sat there unsellable. mp.digisellerTakesNewStock knows the block.
function platiTakesNewStock(af) {
  if (!af.platiCategoryId || af.platiEnabled === false) return false;
  return typeof mp.digisellerTakesNewStock === "function" ? mp.digisellerTakesNewStock() : true;
}

async function enabledMarketsForGame(game) {
  const af = settings.getAutoFarm();
  const markets = ["gameflip"];
  if (platiTakesNewStock(af)) markets.push("digiseller");
  // GGSel only while the owner's switch is on (autoFarm.ggselEnabled) — and
  // no category lookup at all while it is off.
  let ggselCategoryId = "";
  if (af.ggselEnabled !== false) {
    try {
      ggselCategoryId = await mp.ggselResolveCategoryId(game);
    } catch {
      ggselCategoryId = "";
    }
    if (!ggselCategoryId) ggselCategoryId = String(af.ggselCategoryId || "");
  }
  if (ggselCategoryId) markets.push("ggsel");
  // Per-game restriction (settings.unclaimedGameMarkets): e.g. Overwatch on
  // Gameflip only, so the other accounts stay free for manual bulk sale.
  const allowed = settings.gameMarketsFor ? settings.gameMarketsFor(game) : null;
  if (Array.isArray(allowed) && allowed.length) {
    const kept = markets.filter((m) => allowed.includes(m));
    return { markets: kept, ggselCategoryId: kept.includes("ggsel") ? ggselCategoryId : "" };
  }
  return { markets, ggselCategoryId };
}

// Effective per-game cap: settings.unclaimedGameCaps override, else GAME_CAP.
function capForGame(game) {
  const n = settings.gameCapFor ? settings.gameCapFor(game) : 0;
  return n > 0 ? n : GAME_CAP;
}

// The order a scan pass reads candidate inventories in.
//
// A pass can only afford SCAN_LIMIT inventory reads, so WHICH candidates get
// those reads decides what ever gets listed — and the plain bot order the
// caller hands us starves a game. Bot ids cluster by game (a bot watches one
// game's streams) and the order is deterministic, so the games on the
// low-numbered bots take every slot of every pass and a game parked on a high
// bot is never read at all: Rainbow Six sat on bots 17-18 behind 215 Overwatch
// accounts with 91 ready accounts, a cap of 83 and not one listing.
//
// So interleave the games round-robin, and put games already at their cap last
// — a capped game cannot take a new listing, so spending the pass's reads on it
// lists nothing. Capped games are NOT dropped: a bot watches every
// FavouriteGame, so an account filed under a capped game may hold drops for an
// uncapped one, and it still gets scanned once the ready games have had their
// share. Every candidate is returned exactly once, in bot order within a game.
function orderScanCandidates(work, gameListed) {
  const listed = gameListed || new Map();
  const lanes = new Map(); // game cap key -> that game's candidates, bot order
  for (const c of work) {
    const k = gameCapKey(c.game) || String((c && c.game) || "");
    if (!lanes.has(k)) lanes.set(k, []);
    lanes.get(k).push(c);
  }
  const all = [...lanes.entries()].map(([key, list]) => ({
    key,
    list,
    capped: (listed.get(key) || 0) >= capForGame(key),
  }));
  all.sort((a, b) => {
    const ca = a.capped ? 1 : 0;
    const cb = b.capped ? 1 : 0;
    if (ca !== cb) return ca - cb; // games that can still list go first
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  const ordered = [];
  const interleave = (ls) => {
    const depth = ls.reduce((m, l) => Math.max(m, l.list.length), 0);
    for (let i = 0; i < depth; i++) {
      for (const l of ls) if (i < l.list.length) ordered.push(l.list[i]);
    }
  };
  interleave(all.filter((l) => !l.capped));
  interleave(all.filter((l) => l.capped));
  return ordered;
}

// What one scan pass reads (owner, 2026-09-28). Games that can still take a
// listing are read in orderScanCandidates' order, up to SCAN_LIMIT. A game at
// its cap can list nothing, so its accounts get only CAPPED_SCAN_READS reads a
// pass — they may hold another game's drops — rotating through the lane from
// pass to pass. With both caps full every pass used to re-read the same sixty
// accounts and list nothing: ~360 Twitch reads an hour through the bot host.
const CAPPED_SCAN_READS = 5;
let cappedScanCursor = 0;
function scanBatch(ordered, gameListed) {
  const listed = gameListed || new Map();
  const capped = (c) => {
    const k = gameCapKey(c && c.game) || String((c && c.game) || "");
    return (listed.get(k) || 0) >= capForGame(k);
  };
  const open = [];
  const full = [];
  for (const c of ordered || []) (capped(c) ? full : open).push(c);
  const batch = open.slice(0, SCAN_LIMIT);
  const room = Math.min(CAPPED_SCAN_READS, SCAN_LIMIT - batch.length);
  if (room > 0 && full.length) {
    const start = cappedScanCursor % full.length;
    const take = full.slice(start, start + room);
    if (take.length < room) take.push(...full.slice(0, Math.min(start, room - take.length)));
    cappedScanCursor = (start + take.length) % full.length;
    batch.push(...take);
  }
  return batch;
}

// Waiting Gameflip units a bundle may queue behind its live one.
const GAMEFLIP_WAITING_MAX = 5;

// Sorted [itemKey, qty] pairs of a stored set (missing qty = 1, like the
// pre-v3 rows), for the exact match against a signature's pairs.
function setPairs(set) {
  return ((set && set.items) || [])
    .map((i) => [String((i && i.itemKey) || "").trim().toLowerCase(), dropQty(i)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function pairsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
  }
  return true;
}

// Items AND copies must match (v3): the $all/$size prefilter narrows to sets
// holding exactly these itemKeys, then the full sorted [itemKey, qty] signature
// is compared in JS, so a "4× Alpha Pack" set never absorbs a 1× account and
// every pre-v3 qty-1 set keeps matching qty-1 accounts.
async function findUnclaimedSet(signature) {
  const plain = (signature && (signature.itemKeys || signature.keys)) || [];
  if (!plain.length) return null;
  const want = (signature.pairs || plain.map((k) => [k, 1])).slice().sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
  const cands = await DropSet.find({
    note: SET_NOTE,
    "items.itemKey": { $all: plain },
    items: { $size: plain.length },
  })
    .sort({ _id: 1 })
    .lean();
  return cands.find((s) => pairsEqual(setPairs(s), want)) || null;
}

// `meta` (v3, optional): { cls, floor } — the classifyHoldings result and the
// price floor. The set records where its bundle came from
// (sourceType/sourceEventKey/sourceEventName/sourceCampaignIds) and is named
// by the bundle title, so the Bundles panel and the repricer can rebuild the
// classification from the set alone.
function setSourceFields(cls, game, drops) {
  const ev = cls && cls.event ? cls.event : null;
  const campaignIds = [];
  for (const w of (cls && cls.waves) || []) {
    if (w && w.campaignId && (w.held || []).length) campaignIds.push(String(w.campaignId));
  }
  return {
    sourceType: "unclaimed-bundle",
    sourceEventKey: (ev && ev.key) || "",
    sourceEventName: (ev && ev.name) || "",
    sourceCampaignIds: [...new Set(campaignIds)],
    name: listingTitle(game, drops, cls),
  };
}

async function createUnclaimedSet(signature, game, drops, price, meta = {}) {
  const src = setSourceFields(meta.cls, game, drops);
  return DropSet.create({
    name: src.name || (game || "Twitch") + " drops — unclaimed",
    note: SET_NOTE,
    items: dedupeSetItems(drops, game),
    price,
    minPriceUsd: Math.max(0, Number(meta.floor) || 0),
    listed: false,
    custom: true,
    coverGame: game,
    sourceType: src.sourceType,
    sourceEventKey: src.sourceEventKey,
    sourceEventName: src.sourceEventName,
    sourceCampaignIds: src.sourceCampaignIds,
  });
}

// Find or create the item's set. Two concurrent workers for the same signature
// could race a duplicate create; the winner check below collapses them. An
// existing set that predates v3 (no source fields) is back-filled once so the
// repricer can classify it; its price is NOT touched here (see scan pass).
async function ensureUnclaimedSet(signature, game, drops, price, meta = {}) {
  const existing = await findUnclaimedSet(signature);
  if (existing) {
    if (meta.cls && !existing.sourceEventKey && meta.cls.event && meta.cls.event.key) {
      const src = setSourceFields(meta.cls, game, drops);
      await DropSet.updateOne(
        { _id: existing._id },
        {
          $set: {
            sourceType: src.sourceType,
            sourceEventKey: src.sourceEventKey,
            sourceEventName: src.sourceEventName,
            sourceCampaignIds: src.sourceCampaignIds,
          },
        },
      ).catch(() => {});
      Object.assign(existing, {
        sourceType: src.sourceType,
        sourceEventKey: src.sourceEventKey,
        sourceEventName: src.sourceEventName,
        sourceCampaignIds: src.sourceCampaignIds,
      });
    }
    return existing;
  }
  const created = await createUnclaimedSet(signature, game, drops, price, meta);
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

// Lot rows (lotSize > 0, utils/unclaimedLots.js) are Gameflip listings that
// deliver N accounts at once. They live beside the single-unit chain and must
// never be mistaken for it: this filter keeps every "is there a live single
// unit?" query (chain publish, market pick, repair, consistency) lot-blind.
const NOT_LOT = { lotSize: { $in: [0, null] } };

async function activeRowForSetMarket(setId, marketplace) {
  if (!setId || !marketplace) return null;
  return MarketplaceListing.findOne({
    origin: ORIGIN,
    set: setId,
    marketplace,
    status: "active",
    ...NOT_LOT,
  }).lean();
}

async function listedLedgersForSetMarket(setId, market) {
  if (!setId || !market) return [];
  return UnclaimedAccount.find({ set: setId, market, status: "listed" })
    .sort({ listedAt: 1, _id: 1 })
    .lean();
}

// The marketplace row this ledger is (or was) a unit of.
// The marketplace row a ledger's unit lives on. Gameflip needs care: a set
// can hold an older SOLD single row, the current live single row and (lots on)
// a lot row all at once, and removeUnitFromRow's gameflip branch only acts when
// the row's accountLogin IS this ledger's login — an unsorted findOne used to
// hand back a sold predecessor or a lot row, silently skipping the delist while
// the account was released to the pool. So for gameflip: this login's own
// single row first (active before sold), then the live single-unit head; lot
// rows never (they are unclaimedLots' business).
async function rowForLedger(ledger) {
  if (!ledger || !ledger.set) return null;
  const login = String(ledger.login || "").trim();
  const loginEsc = login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const gameflipRow = async () => {
    if (login) {
      const own = await MarketplaceListing.find({
        origin: ORIGIN,
        set: ledger.set,
        marketplace: "gameflip",
        status: { $in: ["active", "sold"] },
        accountLogin: new RegExp("^" + loginEsc + "$", "i"),
        ...NOT_LOT,
      })
        .sort({ status: 1, updatedAt: -1 }) // "active" sorts before "sold"
        .limit(1)
        .lean();
      if (own[0]) return own[0];
    }
    return MarketplaceListing.findOne({
      origin: ORIGIN,
      set: ledger.set,
      marketplace: "gameflip",
      status: "active",
      ...NOT_LOT,
    }).lean();
  };
  if (ledger.market && ledger.market !== "gameflip") {
    const row = await MarketplaceListing.findOne({
      origin: ORIGIN,
      set: ledger.set,
      marketplace: ledger.market,
      status: { $in: ["active", "sold"] },
    })
      .sort({ status: 1, updatedAt: -1 })
      .lean();
    if (row) return row;
  }
  return gameflipRow();
}

// The owner row's email, secretBox-encrypted where present. Pool rows carry
// it under `email`; legacy/noclaim rows may use `credEmail`. Absent values
// return "" — never a decrypt error.
function ownerEmail(row) {
  if (!row) return "";
  const enc = row.credEmail || row.email || "";
  if (!enc) return "";
  // A malformed/foreign-key ciphertext must never break the credential fetch —
  // the password is what matters; an unreadable email just comes back blank.
  try {
    return String(decrypt(enc) || "");
  } catch {
    return "";
  }
}

// Rebuild a credential object for a ledger row (pool row).
// Passwords and emails are decrypted here, ON DEMAND — never in list payloads.
async function credentialForLedger(ledger) {
  if (!ledger) return { login: "", password: "", email: "" };
  if (ledger.source === "noclaim" && ledger.poolAccountId) {
    const pool = await AvailableAccount.findById(ledger.poolAccountId).lean();
    if (pool) {
      return {
        login: ledger.login || pool.login || "",
        password: poolPassword(pool),
        email: ownerEmail(pool),
      };
    }
  }
  return { login: ledger.login || "", password: "", email: "" };
}

// ---------------------------------------------------------------------------
// v3: event catalog, bundle classification, analytics pricing, lots, reprice
// (docs/UNCLAIMED-BUNDLES-CONTRACT.md — engine hunks 2, 3, 7, 8)
// ---------------------------------------------------------------------------

// Thin wrapper over unclaimedBundles.loadCatalog: the event catalog (Map) for
// these games, or an EMPTY Map when the module is missing or the load fails —
// an empty catalog classifies every account as "no event", i.e. v2 behaviour.
async function catalogForGames(games) {
  const list = [...new Set((games || []).map((g) => String(g || "").trim()).filter(Boolean))];
  const ub = bundlesMod();
  if (!ub || typeof ub.loadCatalog !== "function") return new Map();
  try {
    const cat = await ub.loadCatalog({ games: list });
    return cat instanceof Map ? cat : new Map(Object.entries(cat || {}));
  } catch (e) {
    console.error("unclaimedAutoList loadCatalog failed:", e.message);
    return new Map();
  }
}

// Per-pass catalog cache. The batch's candidate games are loaded up front; a
// listing whose REAL game (pickListingGroup) was not among them is loaded on
// demand and merged, so a mis-configured bot still gets its event resolved.
function makeCatalogLoader(initialGames) {
  const catalog = new Map();
  const loaded = new Set();
  const keyOf = (g) => settings.normGameName(g) || String(g || "").trim().toLowerCase();
  let ready = null;
  const merge = (cat) => {
    for (const [k, v] of cat || []) catalog.set(k, v);
  };
  const loadFor = async (games) => {
    const fresh = (games || []).filter((g) => g && !loaded.has(keyOf(g)));
    if (!fresh.length) return catalog;
    for (const g of fresh) loaded.add(keyOf(g));
    merge(await catalogForGames(fresh));
    return catalog;
  };
  return {
    // Map for `game` (loads the batch games once, then this game if new).
    async forGame(game) {
      if (!ready) ready = loadFor(initialGames || []);
      await ready.catch(() => {});
      if (game && !loaded.has(keyOf(game))) await loadFor([game]).catch(() => {});
      return catalog;
    },
    catalog,
  };
}

// classifyHoldings, guarded. Returns null when the module is missing, the
// catalog is empty, or the classifier throws (→ plain qty-aware listing).
function classifyDrops(game, drops, catalog, now) {
  const ub = bundlesMod();
  if (!ub || typeof ub.classifyHoldings !== "function") return null;
  if (!catalog || (catalog instanceof Map && !catalog.size)) return null;
  try {
    return ub.classifyHoldings(game, drops || [], catalog, now || Date.now()) || null;
  } catch (e) {
    console.error("unclaimedAutoList classifyHoldings failed:", e.message);
    return null;
  }
}

// Narrow a catalog to the set's recorded event when it knows one, so a set
// rebuilt from storage is classified against ITS event, not a same-item event
// from another wave (the "via sourceEventKey" rule).
function catalogForSet(set, catalog) {
  const key = String((set && set.sourceEventKey) || "");
  if (key && catalog && catalog.has(key)) return new Map([[key, catalog.get(key)]]);
  return catalog;
}

// Rebuild the classification of a stored set (successor publish, GGSel
// rebuild, reprice). `catalog` may be passed by a pass that already loaded one;
// otherwise it is loaded for the set's game. Never throws.
async function classificationForSet(set, catalog) {
  if (!set) return null;
  const game = set.coverGame || (set.items && set.items[0] && set.items[0].game) || "";
  try {
    const cat = catalog || (await catalogForGames([game]));
    return classifyDrops(game, expandSetDrops(set), catalogForSet(set, cat));
  } catch (e) {
    console.error("unclaimedAutoList classificationForSet failed:", e.message);
    return null;
  }
}

// Analytics price for a set's items (hunk 3): unclaimedBundles.bundlePrice,
// falling back to the auto-lister's derivePrice floored at the unclaimed
// floors when the module is unavailable. Always returns { price, floor, … }.
// `soldFloorUsd` (optional, EXISTING sets only — see soldFloorForSet) is the
// best price this set actually sold at recently: the analytics price is never
// allowed to drop below it, so a set that just sold at $3 is not relisted at
// $1.50 because the anchor moved. Passed through to bundlePrice and clamped
// here too, so the floor holds even on the derivePrice fallback path.
function priceForItems({ research, game, items, cls, pricing, soldFloorUsd = 0 }) {
  const p = pricing || settings.getUnclaimedPricing();
  let gameFloor = 0;
  try {
    gameFloor = Number(settings.gameFloorFor(game)) || 0;
  } catch {
    gameFloor = 0;
  }
  const floor = Math.max(Number(p.floorUsd) || 0, gameFloor, 0);
  const soldFloor = Math.max(Number(soldFloorUsd) || 0, 0);
  const ub = bundlesMod();
  if (ub && typeof ub.bundlePrice === "function") {
    try {
      const r = ub.bundlePrice({
        research: research || null,
        game,
        items: items || [],
        classification: cls || null,
        pricing: p,
        soldFloorUsd: soldFloor,
      });
      const price = Number(r && r.price);
      if (Number.isFinite(price) && price > 0) {
        return {
          price: Math.max(price, floor, soldFloor),
          floor: Math.max(Number(r.floor) || 0, floor),
          soldFloor: Math.max(Number(r.soldFloor) || 0, soldFloor),
          anchor: r.anchor,
          anchorSource: r.anchorSource || "",
          totalQty: r.totalQty,
          full: !!r.full,
        };
      }
    } catch (e) {
      console.error("unclaimedAutoList bundlePrice failed:", e.message);
    }
  }
  const base = Number(derivePrice(research)) || 0;
  const price = Math.max(Math.round(Math.max(base, floor) * 4) / 4, floor, soldFloor);
  return {
    price,
    floor,
    soldFloor,
    anchor: base,
    anchorSource: "derivePrice-fallback",
    totalQty: (items || []).reduce((m, i) => m + dropQty(i), 0),
    full: false,
  };
}

// The highest price an EXISTING set's unclaimed rows actually sold at in the
// last `days` days (MarketplaceListing status "sold", origin unclaimed, by the
// row's updatedAt — the sold flip). 0 when the set never sold in the window,
// on a missing setId, or on a DB error, so callers can always pass the result
// straight into priceForItems as `soldFloorUsd`. Lot rows are excluded: a lot
// price covers N accounts and is not a per-unit signal.
async function soldFloorForSet(setId, days = 30) {
  if (!setId) return 0;
  const span = Math.max(Number(days) || 0, 0) * 24 * 60 * 60 * 1000;
  if (!span) return 0;
  try {
    const rows = await MarketplaceListing.find(
      {
        set: setId,
        origin: ORIGIN,
        status: "sold",
        updatedAt: { $gte: new Date(Date.now() - span) },
        ...NOT_LOT,
      },
      { price: 1 },
    ).lean();
    let max = 0;
    for (const r of rows || []) {
      const v = Number(r && r.price) || 0;
      if (v > max) max = v;
    }
    return max;
  } catch (e) {
    console.error("unclaimedAutoList soldFloorForSet failed:", e.message);
    return 0;
  }
}

// MarketResearch rows for these games, keyed by lowercased game label.
async function researchByGame(games) {
  const list = [...new Set((games || []).map((g) => String(g || "").trim()).filter(Boolean))];
  const map = new Map();
  if (!list.length) return map;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rows = await MarketResearch.find({
    game: { $in: list.map((g) => new RegExp("^" + esc(g) + "$", "i")) },
  })
    .lean()
    .catch(() => []);
  for (const r of rows) map.set(String(r.game || "").toLowerCase(), r);
  return map;
}

// The set's Gameflip ledgers that are WAITING for the chain (listed, market
// gameflip, not the live single unit, not already inside a lot, owner not
// manual-sold), oldest listedAt first — the pool a lot is formed from.
async function waitingGameflipLedgers(setId) {
  if (!setId) return [];
  const ledgers = await UnclaimedAccount.find({
    set: setId,
    market: "gameflip",
    status: "listed",
    lotId: { $in: ["", null] },
  })
    .sort({ listedAt: 1, _id: 1 })
    .lean();
  if (!ledgers.length) return [];
  const live = await activeRowForSetMarket(setId, "gameflip");
  const liveLogin = String((live && live.accountLogin) || "").trim().toLowerCase();
  const marked = await manualSoldOwnerKeys(ledgers);
  return filterManualSoldLedgers(ledgers, marked).filter(
    (l) => !liveLogin || String(l.loginLower || "").toLowerCase() !== liveLogin,
  );
}

// Hunk 7: publish ONE Gameflip lot for a set when the flag is on and enough
// units are waiting. Never throws.
async function maybePublishLot(set, pricing) {
  const p = pricing || settings.getUnclaimedPricing();
  if (!p.lots || !set) return null;
  const lots = lotsMod();
  if (!lots || typeof lots.publishLotIfReady !== "function") return null;
  try {
    const waiting = await waitingGameflipLedgers(set._id);
    if (waiting.length < Math.max(2, Number(p.lotSize) || 0)) return null;
    return await lots.publishLotIfReady(set, { pricing: p });
  } catch (e) {
    console.error("unclaimedAutoList publishLotIfReady failed:", e.message);
    return null;
  }
}

// "campaign ended" keys for shouldExpire: every TwitchCampaign whose name is
// in `names` and whose endAt is more than an hour in the past, keyed
// "normGame|name-lowercased" (plus "|name" when the campaign row has no game).
async function endedCampaignKeys(names, now) {
  const list = [...new Set((names || []).map((n) => String(n || "").trim()).filter(Boolean))];
  const ended = new Set();
  if (!list.length) return ended;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const cutoff = new Date((Number(now) || Date.now()) - 60 * 60 * 1000);
  const rows = await TwitchCampaign.find(
    {
      name: { $in: list.map((n) => new RegExp("^" + esc(n) + "$", "i")) },
      endAt: { $ne: null, $lt: cutoff },
    },
    { name: 1, game: 1, endAt: 1 },
  )
    .lean()
    .catch(() => []);
  // A campaign name can exist for several games (or be re-run); only the rows
  // that ended count, and a still-running same-name row for the same game wins.
  const liveRows = await TwitchCampaign.find(
    {
      name: { $in: list.map((n) => new RegExp("^" + esc(n) + "$", "i")) },
      $or: [{ endAt: null }, { endAt: { $gte: cutoff } }],
    },
    { name: 1, game: 1 },
  )
    .lean()
    .catch(() => []);
  const live = new Set(
    liveRows.map(
      (r) => settings.normGameName(r.game || "") + "|" + String(r.name || "").trim().toLowerCase(),
    ),
  );
  for (const r of rows) {
    const key = settings.normGameName(r.game || "") + "|" + String(r.name || "").trim().toLowerCase();
    if (!live.has(key)) ended.add(key);
  }
  return ended;
}

// Hunk 8: reprice every active single-unit unclaimed row to its analytics
// price. Dry-run by default — returns the plan; `apply:true` patches the rows
// whose |drift| >= pricing.repriceDriftPct. Manual/auto rows and lot rows are
// never touched (lots are priced from their set by unclaimedLots).
async function repriceUnclaimedRows({ apply = false } = {}) {
  const pricing = settings.getUnclaimedPricing();
  const out = { apply: !!apply, driftPct: pricing.repriceDriftPct, rows: 0, changed: 0, plan: [], notes: [] };
  const rows = await MarketplaceListing.find(
    { origin: ORIGIN, status: "active", ...NOT_LOT },
    { set: 1, marketplace: 1, externalId: 1, title: 1, price: 1 },
  ).lean();
  out.rows = rows.length;
  if (!rows.length) return out;
  const setIds = [...new Set(rows.map((r) => String(r.set || "")).filter(Boolean))];
  const sets = await DropSet.find({ _id: { $in: setIds } }).lean();
  const setById = new Map(sets.map((s) => [String(s._id), s]));
  const gameOf = (s) => (s && (s.coverGame || (s.items && s.items[0] && s.items[0].game))) || "";
  const games = [...new Set(sets.map(gameOf).filter(Boolean))];
  const [catalog, research] = await Promise.all([catalogForGames(games), researchByGame(games)]);
  // Recent sold floor per set — one lookup per set for the whole run. Every
  // row of a set shares it, so a set that sold at $3 last week is never
  // repriced below $3 no matter where the analytics anchor drifted.
  const soldFloors = new Map(); // setId -> max sold price (0 when none)
  await Promise.all(
    sets.map(async (s) => {
      soldFloors.set(String(s._id), await soldFloorForSet(s._id));
    }),
  );
  const priced = new Map(); // setId -> { price, floor, soldFloor, ... }
  for (const s of sets) {
    const game = gameOf(s);
    const cls = classifyDrops(game, expandSetDrops(s), catalogForSet(s, catalog));
    priced.set(
      String(s._id),
      priceForItems({
        research: research.get(String(game).toLowerCase()) || null,
        game,
        items: s.items || [],
        cls,
        pricing,
        soldFloorUsd: soldFloors.get(String(s._id)) || 0,
      }),
    );
  }
  // One price per SET was being applied to every marketplace that set is listed
  // on. The venues do not pay the same: our realised medians are Gameflip $1.25,
  // Digiseller $1.28, GGSel $0.75 (prod 2026-09-09). So the set price — which is
  // anchored on cross-market analytics — is translated to each venue's own price
  // level, exactly as utils/autoLister.js venuePrice does for a fresh publish.
  // Gameflip is the reference and never moves; a venue with too few realised
  // sales gets a factor of 1 and is left alone.
  const venueFactors = new Map();
  for (const m of new Set(rows.map((r) => String(r.marketplace || "").toLowerCase()))) {
    if (!m || m === "gameflip") continue;
    try {
      const ev = await pricingEvidenceMod.evidenceFor({ game: "", marketplace: m });
      const f = pricingEngine.venueFactor(ev);
      if (f > 0 && f !== 1) venueFactors.set(m, f);
    } catch {
      /* evidence is a nicety; without it the set price stands */
    }
  }

  let rubRate = 0;
  const needRub = rows.some((r) => r.marketplace === "ggsel");
  if (apply && needRub) {
    if (typeof mp.usdToRub === "function") {
      try {
        rubRate = Number(await mp.usdToRub()) || 0;
      } catch {
        rubRate = 0;
      }
    }
    if (!rubRate) out.notes.push("ggsel rows skipped: USD→RUB rate unavailable");
  }
  const touchedSets = new Map();
  for (const row of rows) {
    const s = setById.get(String(row.set || ""));
    const p = priced.get(String(row.set || ""));
    if (!s || !p) {
      out.notes.push("row " + String(row._id) + " has no set — skipped");
      continue;
    }
    const current = Number(row.price) || 0;
    // The owner's rule, 2026-09-09: rent-farm ("Automatic Farming") listings
    // keep their price. A farming window is a different product and its price
    // is set by hand, never by a drop-bundle anchor.
    const venue = String(row.marketplace || "").toLowerCase();
    const vf =
      classifyKind(row.title) === "farm" ? 1 : venueFactors.get(venue) || 1;
    const marketFloor = pricingEngine.floorForMarketplace(venue);
    const target =
      vf === 1
        ? Number(p.price) || 0
        : Math.max(
            marketFloor,
            Math.round((Number(p.price) || 0) * vf * 100) / 100,
          );
    const driftPct = current > 0 ? ((target - current) / current) * 100 : target > 0 ? 100 : 0;
    const entry = {
      rowId: String(row._id),
      setId: String(s._id),
      marketplace: row.marketplace,
      externalId: row.externalId,
      title: row.title || s.name || "",
      game: gameOf(s),
      current,
      target,
      floor: p.floor,
      soldFloor: Number(p.soldFloor) || 0,
      anchorSource: p.anchorSource || "",
      venueFactor: Math.round(vf * 1000) / 1000,
      driftPct: Math.round(driftPct * 10) / 10,
      apply: false,
      applied: false,
      error: "",
    };
    entry.apply = Math.abs(driftPct) >= (Number(pricing.repriceDriftPct) || 20) && target > 0 && Math.abs(target - current) >= 0.01;
    if (apply && entry.apply) {
      try {
        if (row.marketplace === "gameflip") {
          await mp.gameflipReprice(row.externalId, { priceUsd: target });
        } else if (row.marketplace === "digiseller") {
          const r = await mp.digisellerRepriceProducts([{ productId: row.externalId, priceUsd: target }]);
          if (r && r.failed) throw new Error((r.errors && r.errors[0]) || "digiseller reprice failed");
        } else if (row.marketplace === "ggsel") {
          if (!rubRate) {
            entry.error = "skipped: no RUB rate";
            out.plan.push(entry);
            continue;
          }
          await mp.ggselUpdateOffer(row.externalId, { priceRub: Math.ceil(target * rubRate) });
        } else if (row.marketplace === "eldorado") {
          await mp.eldoradoReprice(row.externalId, target);
        } else if (row.marketplace === "playerauctions") {
          // A PlayerAuctions update is cancel-old + create-new, so the row must
          // follow the offer to its new id or the fulfiller loses the listing.
          const r = await mp.playerauctionsReprice(row.externalId, target);
          if (r && r.replaced && r.offerId) {
            await MarketplaceListing.updateOne(
              { _id: row._id },
              {
                $set: {
                  externalId: String(r.offerId),
                  url: mp.playerauctionsOfferUrl(r.offerId),
                },
              },
            ).catch(() => {});
            entry.externalId = String(r.offerId);
          }
        } else {
          entry.error = "skipped: unsupported marketplace";
          out.plan.push(entry);
          continue;
        }
        await MarketplaceListing.updateOne(
          { _id: row._id },
          { $set: { price: target, lastError: "" } },
        ).catch(() => {});
        touchedSets.set(String(s._id), p);
        entry.applied = true;
        out.changed++;
        logEvent({
          category: "unclaimed",
          action: "repriced",
          actor: "unclaimedAutoList",
          subject: String(row.externalId || row._id),
          game: entry.game,
          detail:
            row.marketplace + " $" + current.toFixed(2) + " → $" + target.toFixed(2) +
            " (" + (driftPct >= 0 ? "+" : "") + entry.driftPct + "%, anchor " + (p.anchorSource || "?") + ")",
        });
      } catch (e) {
        entry.error = e.message;
        await MarketplaceListing.updateOne(
          { _id: row._id },
          { $set: { lastError: "reprice: " + e.message } },
        ).catch(() => {});
      }
    }
    out.plan.push(entry);
  }
  for (const [setId, p] of touchedSets) {
    await DropSet.updateOne(
      { _id: setId },
      { $set: { price: p.price, minPriceUsd: p.floor } },
    ).catch(() => {});
  }
  return out;
}

// ---------------------------------------------------------------------------
// Publishing (ONE listing per item per marketplace)
// ---------------------------------------------------------------------------

// The lots flags the Gameflip bulk line in a description depends on.
function descOpts() {
  let p = null;
  try {
    p = settings.getUnclaimedPricing();
  } catch {
    p = null;
  }
  return { lotsEnabled: !!(p && p.lots), lotSize: (p && p.lotSize) || 0 };
}

// `cls` (v3, optional trailing arg on every publisher): the classifyHoldings
// result for this set's drops — drives the bundle title/description lines.
async function publishGameflipUnit(set, cand, drops, price, img, cls) {
  const game = cand.game || (drops[0] && drops[0].game) || set.coverGame || "";
  const title = listingTitle(game, drops, cls);
  const description = listingDescription(game, drops, "gameflip", cls, descOpts());
  const r = await mp.gameflipPublish({
    title,
    description,
    priceUsd: price,
    imagePath: img || undefined,
    autoDeliverCode: gameflipDeliveryCode(cand.login, cand.password),
  });
  return MarketplaceListing.create({
    set: set._id,
    marketplace: "gameflip",
    externalId: r.externalId,
    url: r.url || "",
    title,
    description,
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

async function publishDigisellerProduct(set, units, game, drops, price, img, categoryId, cls) {
  const title = listingTitle(game, drops, cls);
  const description = listingDescription(game, drops, "digiseller", cls);
  const r = await mp.digisellerPublish({
    title,
    description,
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
    title,
    description,
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

// GGSel's stock-then-activate dance, with the verdict kept.
//
// `ggselFinalizeStock` is the ONE thing in the system that can tell a live
// offer from one GGSel accepted and left off sale: batch_activate answers 2xx
// either way, so it re-reads the status and reports `activationStuck` plus the
// status it stuck at ("draft" = published and never went live, "paused" = was
// live and got taken down). Both call sites used to be
// `.catch(() => {})` with the return value dropped on the floor, so an offer
// could sit in `draft` indefinitely with stock attached and nothing anywhere
// — not the panel, not consistencyIssues, not the guardian (which only heals
// `autoDeliver` rows) — able to see it. Offer 102819378 did exactly that for
// six days with 16 accounts behind it.
//
// The verdict is written to the row's `lastError` so it surfaces in the
// console and in consistencyIssues without another network call.
const GGSEL_STUCK_PREFIX = "off sale: GGSel left the offer ";

// `finalize` is injectable so the verdict handling can be tested without a live
// GGSel session, the same way paRefreshOnce takes its refresher.
async function finalizeGgselOffer(externalId, rowId, finalize) {
  const call = finalize || ((id) => mp.ggselFinalizeStock(id));
  const note = async (msg) => {
    if (msg) console.error("unclaimedAutoList ggsel " + externalId + ": " + msg);
    if (!rowId) return;
    await MarketplaceListing.updateOne(
      { _id: rowId },
      { $set: { lastError: msg || "" } },
    ).catch(() => {});
  };
  let fin;
  try {
    fin = await call(externalId);
  } catch (e) {
    await note("could not finalize/activate: " + e.message);
    logEvent({
      category: "unclaimed",
      action: "ggsel_activate_failed",
      actor: "unclaimedAutoList",
      subject: String(externalId),
      detail: "finalize threw: " + e.message,
    });
    return { ok: false, status: "", error: e.message };
  }
  if (fin && fin.activationStuck) {
    const status = fin.activationStatus || "off sale";
    await note(
      GGSEL_STUCK_PREFIX + status + " after activation — it needs a click in " +
        "the GGSel dashboard; nothing can be sold from it until then",
    );
    logEvent({
      category: "unclaimed",
      action: "ggsel_activate_stuck",
      actor: "unclaimedAutoList",
      subject: String(externalId),
      detail: "batch_activate accepted but the offer is still " + status,
    });
    return { ok: false, status, error: "" };
  }
  await note("");
  return { ok: true, status: "active", error: "" };
}

async function publishGgselOffer(set, units, game, drops, price, img, categoryId, cls) {
  const title = listingTitle(game, drops, cls);
  const description = listingDescription(game, drops, "ggsel", cls);
  const r = await mp.ggselPublish({
    title,
    description,
    priceUsd: price,
    categoryId,
    delivery: "auto",
    coverImagePath: img || undefined,
    products: units.map((u) => ggselDeliveryCode(u.login, u.password)),
  });
  await mp.ggselEnableAutoselling(r.externalId).catch(() => {});
  const row = await MarketplaceListing.create({
    set: set._id,
    marketplace: "ggsel",
    externalId: r.externalId,
    url: r.url || "",
    title,
    description,
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
  // After the row exists, so a stuck activation has somewhere to be recorded.
  await finalizeGgselOffer(r.externalId, row._id);
  const stock = await mp.ggselOfferStock(r.externalId).catch(() => null);
  if (stock != null) {
    await MarketplaceListing.updateOne(
      { _id: row._id },
      { $set: { lastStock: stock } },
    ).catch(() => {});
  }
  return row;
}

async function publishProduct(set, market, units, game, drops, price, img, ggselCategoryId, cls) {
  if (market === "digiseller") {
    return publishDigisellerProduct(
      set,
      units,
      game,
      drops,
      price,
      img,
      settings.getAutoFarm().platiCategoryId,
      cls,
    );
  }
  return publishGgselOffer(set, units, game, drops, price, img, ggselCategoryId, cls);
}

// Attach one more stock unit to an existing quantity product.
async function addUnitToRow(row, cand) {
  return withSetMarketLock(row && row.set, row && row.marketplace, () =>
    addUnitToRowLocked(row, cand),
  );
}

async function addUnitToRowLocked(row, cand) {
  // Adding to a row another worker just took off sale would attach a code to a
  // dead product; re-read under the lock and let the scan pass republish.
  const fresh = await MarketplaceListing.findById(row._id).lean().catch(() => null);
  if (!fresh || fresh.status !== "active") return;
  row = fresh;
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
    // Adding a product pauses the offer, so this re-activation is what puts it
    // back on sale — its verdict is exactly what must not be swallowed.
    await finalizeGgselOffer(row.externalId, row._id);
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
  if (!opts.locked) {
    return withSetMarketLock(setId, "gameflip", () =>
      publishGameflipSuccessor(setId, excludeLogin, { ...opts, locked: true }),
    );
  }
  // Never add a second live head to a chain that already has one — a parallel
  // removal may have published the successor while we were waiting.
  const liveHead = await activeRowForSetMarket(setId, "gameflip");
  if (liveHead) return { published: false, reason: "chain already live" };
  const set = await DropSet.findById(setId).lean();
  if (!set) return { published: false, reason: "no set" };
  const waitingList = await UnclaimedAccount.find({
    set: setId,
    market: "gameflip",
    status: "listed",
    loginLower: { $ne: String(excludeLogin || "").toLowerCase() },
    // A member of a Gameflip lot is already on sale inside that lot listing —
    // it can never double as the chain's single live unit.
    lotId: { $in: ["", null] },
  })
    .sort({ listedAt: 1, _id: 1 })
    .lean();
  // Never publish a unit the operator marked as sold-by-hand — the account
  // keeps farming but its credentials must not be handed to another buyer.
  const marked = await manualSoldOwnerKeys(waitingList);
  // Units whose last inventory read failed go to the back (stable, so FIFO
  // otherwise): the live read below is capped per call, and a few dead tokens
  // at the head of the queue must not stop the chain for good.
  const list = filterManualSoldLedgers(waitingList, marked).sort(
    (a, b) => Number(/^check failed/.test(a.note || "")) - Number(/^check failed/.test(b.note || "")),
  );
  if (!list.length) return { published: false, reason: "no waiting unit" };
  const drops = dropsFromSet(set);
  const game = set.coverGame || (drops[0] && drops[0].game) || "";
  const cls = await classificationForSet(set);
  const skipped = { short: 0, sold: 0, unreadable: 0 };
  let reads = 0;
  for (const waiting of list) {
    // The list was read before the lock was taken; re-read this unit so a
    // ledger another worker just sold/removed can never become the new head.
    const still = await UnclaimedAccount.findOne({
      _id: waiting._id,
      status: "listed",
    })
      .lean()
      .catch(() => null);
    if (!still) continue;
    if (filterManualSoldLedgers([waiting], await manualSoldOwnerKeys([waiting])).length === 0) {
      continue;
    }
    // Only a unit that holds the WHOLE set goes on sale under its title (owner,
    // 2026-09-28): every unit of a cohort loses an expired wave at once, and a
    // successor used to be published straight from the set with no look at the
    // account. Cheap filters first — a pending strike, or a last read that
    // already shows it short. A unit on a SOLD row of this set is a sale the
    // check pass has not booked yet (the scan's chain repair runs before it),
    // never stock. Then ONE live read right before its credentials go on sale;
    // a read that fails skips the unit. Reads are capped per call, so a chain
    // whose whole cohort lost a wave costs a few reads, not one per unit.
    if (
      Number(still.emptyReads) > 0 ||
      ((still.drops || []).length && unitShortfall(set, null, still.drops).length)
    ) {
      skipped.short++;
      continue;
    }
    if (await soldRowCarries(setId, still)) {
      skipped.sold++;
      continue;
    }
    if (reads >= SUCCESSOR_MAX_READS) break;
    reads++;
    const check = await verifyUnitHolds(still, set);
    if (check.state !== "covers") {
      skipped[check.state === "short" ? "short" : "unreadable"]++;
      continue;
    }
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
      id: waiting.poolAccountId || "",
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
        cls,
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
  return { published: false, reason: "no publishable waiting unit", skipped };
}

// Live reads one publishGameflipSuccessor call may spend proving a waiting unit
// still holds its set.
const SUCCESSOR_MAX_READS = 3;

// A waiting unit whose login is on a SOLD row of this set published after it
// was listed: its buyer has it and the check pass has not booked the sale yet.
// (A sold row from an earlier listing of a recycled account predates listedAt.)
async function soldRowCarries(setId, ledger) {
  const login = String((ledger && ledger.login) || "").trim();
  if (!login) return false;
  const esc = login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rows = await MarketplaceListing.find({
    origin: ORIGIN,
    set: setId,
    marketplace: "gameflip",
    status: "sold",
    accountLogin: new RegExp("^" + esc + "$", "i"),
  })
    .lean()
    .catch(() => []);
  const since = ledger.listedAt ? new Date(ledger.listedAt).getTime() : 0;
  return rows.some((r) => !r.createdAt || new Date(r.createdAt).getTime() >= since);
}

// One live read of a waiting unit against its set. "covers" refreshes its
// snapshot and clears any strike; "short" records a strike (the check pass
// confirms it and takes the unit off); "unreadable" changes nothing.
async function verifyUnitHolds(ledger, set) {
  const failed = async (why) => {
    await UnclaimedAccount.updateOne(
      { _id: ledger._id, status: "listed" },
      { $set: { lastCheckedAt: new Date(), note: "check failed: " + why } },
    ).catch(() => {});
    return { state: "unreadable" };
  };
  const cand = await candForLedger(ledger).catch(() => null);
  if (!cand) return failed("no pool credentials");
  let inv;
  try {
    inv = await inventoryForCandidate(cand);
  } catch (e) {
    return failed(String((e && e.message) || e).slice(0, 200));
  }
  const drops = pickListingGroup(ledger.game, (inv && inv.sellable) || []).drops;
  const snapshot = drops.map((d) => ({
    name: d.name,
    game: d.game || ledger.game,
    campaign: d.campaign || "",
    itemKey: d.itemKey || d.name,
  }));
  const missing = unitShortfall(set, null, drops);
  if (!missing.length) {
    await UnclaimedAccount.updateOne(
      { _id: ledger._id, status: "listed" },
      { $set: { drops: snapshot, lastCheckedAt: new Date(), emptyReads: 0, firstEmptyAt: null } },
    ).catch(() => {});
    return { state: "covers" };
  }
  const strike = shouldExpire(ledger, Date.now(), {
    confirmPasses: settings.getUnclaimedPricing().expiryConfirmPasses,
    empty: true,
  });
  await UnclaimedAccount.updateOne(
    { _id: ledger._id, status: "listed" },
    {
      $set: {
        drops: snapshot,
        lastCheckedAt: new Date(),
        emptyReads: strike.emptyReads,
        firstEmptyAt: strike.firstEmptyAt,
        note: SHORT_NOTE + shortSummary(missing) + " — not published as the next unit",
      },
    },
  ).catch(() => {});
  return { state: "short", missing };
}

// ---------------------------------------------------------------------------
// Unit removal + marketplace repair
// ---------------------------------------------------------------------------

// One item's rows on one marketplace are edited by several passes at once:
// the manual-sold sweep alone runs CONCURRENCY removals in parallel, and the
// Gameflip chain and the GGSel offer are both "delist the row, publish its
// replacement" sequences. Run those in parallel over the same set+market and
// each worker reads the row BEFORE its sibling replaces it, so each publishes
// a replacement of its own: on 2026-09-06 three manual-sold R6 accounts
// removed together left THREE live GGSel offers (102872251/53/55) and a
// Gameflip successor for an account that was itself sold in the same sweep.
// This is an in-process mutex keyed by set+market; the cross-process run lock
// (acquireRunLock) already guarantees only one process is in a pass at a time,
// so serialising here is enough. Re-entrant callers pass { locked: true }.
const setMarketLocks = new Map();
async function withSetMarketLock(setId, market, fn) {
  const key = String(setId || "") + ":" + String(market || "");
  const prev = setMarketLocks.get(key) || Promise.resolve();
  let release;
  const mine = prev.then(() => new Promise((r) => (release = r)));
  setMarketLocks.set(key, mine);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    // Drop the key once nothing is queued behind us, so the map cannot grow
    // one entry per set+market for the life of the process.
    if (setMarketLocks.get(key) === mine) setMarketLocks.delete(key);
  }
}

// Take a row off sale and only mark it delisted once the PLATFORM agrees.
// The old code was `mp.<x>Delist(id).catch(() => {})` followed by an
// unconditional status:"delisted" write, so a delist that failed left the
// listing live for buyers while the DB called it gone — that is how gameflip
// 97b49ffd stayed on sale for a sold R6 account. A failure now leaves the row
// ACTIVE with lastError set, so the next pass (and the reconcile pass) retries
// it instead of forgetting it.
// Pure verdict for the above, so the rule is testable without a platform:
//   callError ""            -> the platform accepted the delist            (down)
//   outcome "sold" / "gone" -> not on sale anyway                          (down)
//   otherwise the platform's own state decides: "down" / "live" / unknown,
//   and unknown must stay retryable — never assume a failed call worked.
function delistVerdict({ callError = "", outcome = "", platformState = null } = {}) {
  if (!callError) return "down";
  if (outcome === "sold" || outcome === "gone") return "down";
  if (platformState === "down") return "down";
  if (platformState === "live") return "live";
  return "unknown";
}

async function delistRowVerified(row, reason = "", opts = {}) {
  if (!row || !row._id) return { ok: true, changed: false };
  // `force` is for a row we already believe is down but the platform says is
  // still on sale — there is nothing to claim, it just has to come off.
  if (row.status !== "active" && !opts.force) return { ok: true, changed: false };
  const id = row.externalId;
  let callError = "";
  try {
    if (row.marketplace === "gameflip") await mp.gameflipDelist(id);
    else if (row.marketplace === "digiseller") await mp.digisellerDelist(id);
    else if (row.marketplace === "ggsel") await mp.ggselDelist(id);
    // A marketplace this engine has no delist path for (unclaimed rows only
    // ever live on the three above — settings.UNCLAIMED_MARKETS). Reporting
    // "down" for it would be the swallowed-failure bug all over again on a
    // market added later, so say so instead of quietly claiming success.
    else {
      return {
        ok: false,
        changed: false,
        error: "no delist path for " + row.marketplace,
      };
    }
  } catch (e) {
    callError = e.message || String(e);
  }
  const outcome = callError ? mp.delistOutcome(callError) : "";
  let platformState = null;
  if (callError && !outcome) {
    // The call failed for some other reason — ask the platform directly
    // before deciding, because a transport blip on an already-processed
    // delist must not strand the row as active forever.
    try {
      if (row.marketplace === "gameflip") {
        const st = await mp.gameflipListingStatus(id);
        platformState = st === "onsale" ? "live" : "down";
      } else if (row.marketplace === "ggsel") {
        const st = await mp.ggselOfferStatus(id);
        if (st !== null && st !== "") platformState = st === "active" ? "live" : "down";
      } else if (row.marketplace === "digiseller") {
        const vis = await mp.digisellerProductVisible(id);
        if (vis !== null) platformState = vis ? "live" : "down";
      }
    } catch {
      /* unreadable — stays unknown and retries next pass */
    }
  }
  const down = delistVerdict({ callError, outcome, platformState }) === "down";
  const claim = opts.force ? { _id: row._id } : { _id: row._id, status: "active" };
  if (!down) {
    await MarketplaceListing.updateOne(
      claim,
      { $set: { lastError: "delist failed: " + (callError || "still on sale") } },
    ).catch(() => {});
    logEvent({
      category: "unclaimed",
      action: "delist_failed",
      actor: "unclaimedAutoList",
      subject: String(id),
      detail:
        row.marketplace + " listing " + id + " is still on sale after a delist" +
        (reason ? " (" + reason + ")" : "") +
        (callError ? ": " + callError.slice(0, 200) : ""),
    });
    return { ok: false, changed: false, error: callError || "still on sale" };
  }
  const r = await MarketplaceListing.updateOne(
    claim,
    { $set: { status: "delisted", lastError: reason || "" } },
  ).catch(() => null);
  // `outcome` "sold" = the platform refused because a buyer already took it; a
  // caller about to treat the unit as unsold must book the sale instead.
  return { ok: true, changed: !!(r && r.modifiedCount), outcome };
}

// Remove this ledger's unit from its marketplace listing.
//  - gameflip: delist the live row (if this unit was the live one) and publish
//    the next waiting unit as the successor.
//  - digiseller: delete the unit's content line; delist the product if it is
//    now empty.
//  - ggsel: GGSel cannot delete one unit; rebuild the offer without this unit
//    when healthy units remain, else take the whole offer down.
async function removeUnitFromRow(row, ledger, opts = {}) {
  if (!row || !ledger) return { ok: true, removed: false };
  if (opts.locked) return removeUnitFromRowLocked(row, ledger, opts);
  return withSetMarketLock(row.set, row.marketplace, () =>
    removeUnitFromRowLocked(row, ledger, opts),
  );
}

async function removeUnitFromRowLocked(row, ledger, opts = {}) {
  const login = String(ledger.login || "").toLowerCase();
  // Re-read the row inside the lock: the caller's copy may have been fetched
  // before a sibling removal replaced or delisted it, and acting on a stale
  // snapshot is exactly what published the duplicate offers.
  const fresh = await MarketplaceListing.findById(row._id).lean().catch(() => null);
  if (!fresh) return { ok: true, removed: false };
  row = fresh;
  if (row.marketplace === "gameflip") {
    if (String(row.accountLogin || "").toLowerCase() !== login) {
      return { ok: true, removed: false }; // not the live unit — never exposed
    }
    let outcome = "";
    if (row.status === "active") {
      // A row we could not take off sale must NOT be replaced by a successor:
      // that would leave two live listings for one item, one of them selling
      // an account that is already gone.
      const d = await delistRowVerified(row, "");
      if (!d.ok) return { ok: false, removed: false, error: d.error };
      outcome = d.outcome || "";
    }
    await publishGameflipSuccessor(row.set, ledger.login, {
      log: opts.log !== false,
      locked: true,
    });
    return { ok: true, removed: true, outcome };
  }
  const was = (row.units || []).length;
  const units = (row.units || []).filter(
    (u) => String(u.login || "").toLowerCase() !== login,
  );
  const removed = units.length < was;
  // A platform sale: the buyer already got this unit from the platform, so its
  // code is gone from the product — never delete a content line or rebuild the
  // offer for it. The row's own bookkeeping still has to drop the unit, or the
  // row keeps advertising accounts that are spent (digiseller 6090106 sat live
  // holding three sold R6 logins that way).
  const platformConsumed = opts.removeFromProduct === false;
  if (!removed) return { ok: true, removed: platformConsumed };
  if (row.marketplace === "digiseller") {
    if (!platformConsumed) {
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
      await delistRowVerified({ ...row, units }, "");
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
    if (!units.length) {
      await delistRowVerified({ ...row, units }, "");
    } else if (platformConsumed) {
      // GGSel took the code itself; keep the offer and just drop our unit.
      await MarketplaceListing.updateOne(
        { _id: row._id, status: "active" },
        { $set: { units, accountLogin: units.map((u) => u.login).join(", ") } },
      ).catch(() => {});
    } else {
      await rebuildGgselOffer(row, units, { locked: true }).catch((e) =>
        console.error("unclaimedAutoList ggsel rebuild failed:", e.message),
      );
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
async function rebuildGgselOffer(oldRow, remainingUnits, opts = {}) {
  if (!opts.locked) {
    return withSetMarketLock(oldRow && oldRow.set, "ggsel", () =>
      rebuildGgselOffer(oldRow, remainingUnits, { locked: true }),
    );
  }
  const set = await DropSet.findById(oldRow.set).lean();
  if (!set) return;
  const game = (set.items && set.items[0] && set.items[0].game) || set.coverGame || "";
  const drops = dropsFromSet(set);
  const cls = await classificationForSet(set);
  const units = [];
  for (const u of remainingUnits) {
    const ledger = await UnclaimedAccount.findOne({
      loginLower: String(u.login || "").toLowerCase(),
      set: set._id,
      status: "listed",
    }).lean();
    const cred = ledger ? await credentialForLedger(ledger) : null;
    if (cred && cred.password && cred.login) {
      units.push({ login: cred.login, password: cred.password, id: ledger.poolAccountId || "" });
    }
  }
  // Claim the rebuild: only the caller that actually flips this offer from
  // active to delisted may publish its replacement. Without the claim two
  // callers holding the same snapshot each publish one, and the item ends up
  // with several live offers selling the same (or already sold) accounts.
  const current = await MarketplaceListing.findById(oldRow._id).lean().catch(() => null);
  if (!current || current.status !== "active") return;
  const down = await delistRowVerified(current, "rebuilt after unit removal");
  if (!down.ok || !down.changed) return;
  if (!units.length) return;
  // GGSel switched off: the old offer comes down, no replacement goes up. The
  // remaining units' ledgers then sit on no live row, and the reconcile pass
  // parks them held for the markets that are on.
  if (settings.getAutoFarm().ggselEnabled === false) return;
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
    cls,
  );
  if (img) await fsp.unlink(img).catch(() => {});
  await UnclaimedAccount.updateMany(
    { set: set._id, market: "ggsel", status: "listed" },
    { $addToSet: { listingIds: String(row._id) } },
  ).catch(() => {});
}

// ---------------------------------------------------------------------------
// Lifecycle: spent, expiry, pool return
// ---------------------------------------------------------------------------

// Take one sold account out of EVERY no-claim bot that holds it, found by its
// ClientSecret across all configs — never by the ledger's remembered bot (stale
// after a fleet repack; on 2026-09-28 five owner-listing sales were marked spent
// on their ledgers while still in their bots) or by login (renamable).
// `proven` = it is now in no config: every holder was edited and verified, and
// every config was readable. Only then may the pool row say "spent" — the
// recycler cannot see no-claim configs, so a stamp on an account that is still
// farming lets it be recycled into a second bot. Throws when an edit fails.
async function takeOutOfBots(ledger) {
  const pool =
    ledger && ledger.poolAccountId
      ? await AvailableAccount.findById(ledger.poolAccountId, { clientSecret: 1 }).lean()
      : null;
  const secret = pool && pool.clientSecret ? String(pool.clientSecret) : "";
  if (!secret) return { secret: "", proven: false, botIds: [], game: "" };
  const held = await botsHoldingSecret(secret);
  for (const id of held.botIds) await removeFromBotConfig(id, [secret]);
  return { secret, proven: !held.unreadable, botIds: held.botIds, game: held.game };
}

// SPENT path: the buyer owns this account (a sale was detected, or a listed
// drop flipped to claimed). Stop farming it, remove its unit from its listing
// (unless the platform already consumed it), stamp the pool row so the
// recycler sees it, NEVER return it to the pool.
async function spendAccount(ledger, reason, opts = {}) {
  const at = new Date();
  // `opts.label` names a seller other than the auto-lister (the owner's no-claim
  // listings pass "manual no-claim listing") in the pool note, the spent view
  // and the alert. Without it every string below is exactly the auto-lister's.
  const label = String(opts.label || "");
  const spentNote = label
    ? "spent — " + label + " (" + reason + ")"
    : "spent — unclaimed auto-listed (" + reason + ")";
  // What this unit sold for. Captured from the listing row that carried it,
  // BEFORE the unit is removed and before any repricer moves the number — the
  // ledger's own record of a sale had no money in it at all, so per-game revenue
  // was only ever reconstructible from a price that had since drifted.
  // `opts.priceUsd` lets a caller that already knows the realised price (a
  // marketplace order total) override the shelf price.
  let soldPriceUsd = Math.max(0, Number(opts.priceUsd) || 0);
  let soldMarket = String(opts.market || ledger.market || "");
  try {
    const row = await rowForLedger(ledger);
    if (row) {
      if (!soldPriceUsd) soldPriceUsd = Math.max(0, Number(row.price) || 0);
      if (!soldMarket) soldMarket = String(row.marketplace || "");
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
    let botIds = [];
    try {
      const out = await takeOutOfBots(ledger);
      botIds = out.botIds;
      game = game || out.game;
      // Collect the secret ONLY once the account is provably out of every bot
      // (see takeOutOfBots). Stamping it earlier — with a catch that swallows a
      // host failure — marked the pool row "spent" for an account still farming
      // in a live container, which then reads as recyclable and can be deployed
      // a second time. Fail closed instead: no stamp, the row stays claimed, and
      // retireSoldFromBots retries it on the next pass.
      if (out.secret && out.proven) secrets.push(out.secret);
    } catch (e) {
      // Config surgery must never block the sale bookkeeping.
      console.error("unclaimedAutoList: no-claim bot cleanup failed:", e.message);
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
                claimedNote: spentNote,
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
          note: spentNote,
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
          // The bot it was really taken out of; the ledger's may be stale.
          botId: botIds[0] || ledger.botId || "",
          container: botIds[0] ? containerFor(botIds[0]) : ledger.container || "",
          sold: true,
          connected: false,
          soldWhy: label ? label + ": " + reason : "unclaimed auto-list: " + reason,
          tokenStatus: "ok",
          actor: "unclaimedAutoList",
          sweptAt: at,
        },
      },
      { upsert: true },
    ).catch(() => {});
  }

  // "manual" = a unit of an owner's no-claim listing; it sells the same way.
  await UnclaimedAccount.updateOne(
    { _id: ledger._id, status: { $in: ["listed", "manual"] } },
    {
      $set: {
        status: "sold",
        soldAt: at,
        note: reason,
        lastCheckedAt: at,
        soldPriceUsd,
        soldMarket,
      },
    },
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
    (label ? "💰 SOLD (" + label + ")\n\n" : "💰 SOLD (unclaimed auto-list)\n\n") +
      (ledger.login || "?") +
      "\nGame: " +
      (ledger.game || "?") +
      "\nSource: " +
      (ledger.source || "?") +
      "\nReason: " +
      reason,
  ).catch((e) => console.error("unclaimed sale notify error:", e.message));
}

// EXPIRY path: every drop this account was listed with is gone. Take its unit
// off its listing and park the ledger "expired" — and nothing else.
//
// The account is still in its no-claim bot, which keeps farming it: the next
// event's drops are new stock, and the scan lists it again once it holds them.
// So its pool row stays claimed by the no-claim farm. This used to call
// releaseToPool(), which marked the row "available" while the bot still held
// the account; every other system trusts the pool, and the auto-farm claimed
// such accounts into claiming bots (32 sat in two bots at once for 54 hours
// from 2026-09-25). Returns true when the ledger moved to "expired".
const EXPIRED_NOTE = "drops expired — off sale, still farming in its no-claim bot";

async function expireAccount(ledger) {
  try {
    const row = await rowForLedger(ledger);
    if (row) {
      await removeUnitFromRow(row, ledger, { removeFromProduct: true, log: false });
    }
  } catch (e) {
    console.error("unclaimedAutoList expire remove-unit failed:", e.message);
  }
  const at = new Date();
  const r = await UnclaimedAccount.updateOne(
    { _id: ledger._id, status: "listed" },
    {
      $set: {
        status: "expired",
        expiredAt: at,
        releasedAt: null,
        note: EXPIRED_NOTE,
        lastCheckedAt: at,
      },
    },
  ).catch(() => null);
  await markOwnerUnlisted(ledger);
  logEvent({
    category: "unclaimed",
    action: "expired",
    actor: "unclaimedAutoList",
    subject: ledger.login || ledger._id || "",
    game: ledger.game || "",
    count: 1,
    detail:
      "drops expired — delisted; kept in its no-claim bot, pool row unchanged (" +
      (ledger.source || "") +
      ")",
  });
  return !!(r && (r.matchedCount || r.n));
}

// SHORT path (owner, 2026-09-28): the account still holds drops, but fewer
// than its listing promises — a wave of its bundle expired. Confirmed exactly
// like an empty account (`expiryConfirmPasses` reads at least 20 minutes apart,
// on the same emptyReads/firstEmptyAt strike record), then it comes off that
// listing and is parked "skipped" (held). It stays in its no-claim bot, its
// pool row is untouched, and the scan lists it again under what it really
// holds. Gameflip only: the owner paused GGSel and Plati, so a short unit there
// is only noted; a Gameflip lot member (unclaimedLots, off) is left to its lot.
// Kill switch: autoFarm.unclaimedShrinkListings === false (detect and note only).
const SHRINK_MARKETS = ["gameflip"];
const SHORT_NOTE = "short of its listing: ";
const SHRUNK_NOTE = "part of its bundle expired — off its listing, re-listing with what it holds (";

function shrinkEnabled() {
  return settings.getAutoFarm().unclaimedShrinkListings !== false;
}

// The check pass met a unit short of its listing. `liveRow` is the active row
// selling THIS account right now (null for a waiting Gameflip unit); `snapshot`
// is what the read found, stored as the ledger's drops[].
async function handleShortUnit(ledger, missing, liveRow, snapshot, out, pricing) {
  const why = shortSummary(missing);
  if (!SHRINK_MARKETS.includes(ledger.market) || ledger.lotId || !shrinkEnabled()) {
    out.shortHeld++;
    await UnclaimedAccount.updateOne(
      { _id: ledger._id, status: "listed" },
      {
        $set: {
          lastCheckedAt: new Date(),
          emptyReads: 0,
          firstEmptyAt: null,
          drops: snapshot,
          note:
            SHORT_NOTE + why + " — left as is (" +
            (shrinkEnabled() ? (ledger.lotId ? "lot member" : (ledger.market || "?") + " paused") : "take-off switched off") +
            ")",
        },
      },
    ).catch(() => {});
    return;
  }
  const passes = Math.max(1, Math.floor(Number(pricing && pricing.expiryConfirmPasses) || 0) || 2);
  const decision = shouldExpire(ledger, Date.now(), { confirmPasses: passes, empty: true });
  if (!decision.expire) {
    out.shortStrikes++;
    await UnclaimedAccount.updateOne(
      { _id: ledger._id, status: "listed" },
      {
        $set: {
          emptyReads: decision.emptyReads,
          firstEmptyAt: decision.firstEmptyAt,
          lastCheckedAt: new Date(),
          drops: snapshot,
          note:
            SHORT_NOTE + why + " — strike " + decision.emptyReads + "/" + passes +
            (decision.emptyReads >= passes ? ", awaiting the 20-minute confirmation gap" : ", awaiting confirmation"),
        },
      },
    ).catch(() => {});
    return;
  }
  const r = await takeShortUnitOff(ledger, missing, liveRow, snapshot);
  if (r.result === "pulled") out.shrunk++;
  else if (r.result === "sold") out.sold++;
  else if (r.result === "failed") out.shrinkFailed++;
  else out.shrinkWaiting++;
}

// Take a confirmed-short unit off its listing and park it. A live Gameflip unit
// is on sale this minute, so its listing must not have just sold — a buyer may
// be claiming its drops, which reads exactly like a shortfall. Only a listing
// Gameflip itself reports "onsale" is taken down; anything else waits a pass.
// Returns { result: "pulled" | "sold" | "failed" | "waiting" | "changed" }.
async function takeShortUnitOff(ledger, missing, liveRow, snapshot) {
  const why = shortSummary(missing);
  if (liveRow && liveRow.marketplace === "gameflip") {
    let st = "";
    try {
      st = String((await mp.gameflipListingStatus(liveRow.externalId)) || "");
    } catch {
      st = "";
    }
    if (st !== "onsale") return { result: "waiting", status: st || "unreadable" };
    const r = await removeUnitFromRow(liveRow, ledger, { removeFromProduct: true, log: false });
    if (!r || !r.ok) return { result: "failed", error: (r && r.error) || "delist failed" };
    if (r.outcome === "sold") {
      // Sold between the status read and the delist: book it as the sale it is.
      await MarketplaceListing.updateOne(
        { _id: liveRow._id, status: "delisted" },
        { $set: { status: "sold", lastError: "" } },
      ).catch(() => {});
      await spendAccount(ledger, "gameflip sale", { removeFromProduct: false });
      return { result: "sold" };
    }
  }
  const res = await UnclaimedAccount.updateOne(
    { _id: ledger._id, status: "listed" },
    {
      $set: {
        status: "skipped",
        note: SHRUNK_NOTE + why + ")",
        lastCheckedAt: new Date(),
        drops: snapshot,
        emptyReads: 0,
        firstEmptyAt: null,
        lotId: "",
      },
    },
  ).catch(() => null);
  if (!(res && (res.matchedCount || res.n))) return { result: "changed" };
  await markOwnerUnlisted(ledger);
  logEvent({
    category: "unclaimed",
    action: "shrunk",
    actor: "unclaimedAutoList",
    subject: ledger.login || String(ledger._id || ""),
    game: ledger.game || "",
    count: 1,
    detail:
      "part of its bundle expired (" + why + ") — off its " + (ledger.market || "") + " listing" +
      (liveRow ? " (was the unit on sale)" : "") +
      "; kept in its no-claim bot, re-listing with what it holds",
  });
  return { result: "pulled" };
}

// Return an account's pool row to the general pool ("available"). Refuses
// (false) unless ALL of these hold:
//  - its ledger is off sale and unsold right now (re-read here, never trusted
//    from the caller's copy);
//  - the pool row is "claimed" by the no-claim farm itself (note
//    "noclaim-farm:…") and not fenced as hand-sold. A claimed row with any
//    other note belongs to another system; the old version released those too
//    — on 2026-09-25 it freed an account the auto-farm had claimed for Marvel
//    Rivals four hours earlier;
//  - no no-claim bot config holds the account any more. While a bot farms it,
//    "available" invites the auto-farm, the rent-farm and the fleet sizer to
//    claim it into a second bot. A config read that fails, or any config that
//    cannot be read, counts as "still held" (fail closed);
//  - the pool row did not change between those checks and the write.
// The ledger keeps its status ("expired" is sold by nothing once the account
// has left every bot) and gets releasedAt. Expiry no longer calls this — the
// account stays in its bot; the operator's Delist can still ask for it.
const RELEASE_NOTE = "released — left the no-claim farm (unclaimed auto-list)";
const ON_SALE_OR_SOLD = ["listed", "manual", "sold", "removed"];

async function releaseToPool(ledger) {
  if (!ledger || ledger.source !== "noclaim" || !ledger.poolAccountId) return false;
  const cur = await UnclaimedAccount.findById(ledger._id, { status: 1 }).lean();
  if (!cur || ON_SALE_OR_SOLD.includes(cur.status)) return false;
  const pool = await AvailableAccount.findById(ledger.poolAccountId, {
    status: 1,
    claimedNote: 1,
    clientSecret: 1,
    manualSold: 1,
  }).lean();
  if (poolOwnerBlock(pool) || pool.manualSold || !pool.clientSecret) return false;
  let held;
  try {
    held = await botsHoldingSecret(pool.clientSecret);
  } catch (e) {
    console.error("unclaimedAutoList release: bot configs unreadable:", e.message);
    return false;
  }
  if (held.botIds.length || held.unreadable) return false;
  const r = await AvailableAccount.updateOne(
    { _id: pool._id, status: "claimed", claimedNote: pool.claimedNote },
    { $set: { status: "available", claimedAt: null, claimedNote: RELEASE_NOTE } },
  );
  if (!(r && (r.matchedCount || r.n))) return false;
  await UnclaimedAccount.updateOne(
    { _id: ledger._id },
    { $set: { releasedAt: new Date(), note: RELEASE_NOTE } },
  ).catch(() => {});
  await recordPoolUsage([ledger.poolAccountId], {
    event: "released",
    actor: "unclaimedAutoList",
    note: RELEASE_NOTE,
    game: ledger.game || "",
  }).catch(() => {});
  return true;
}

// ---------------------------------------------------------------------------
// Sold accounts leave their no-claim bot (owner's rule, 2026-09-28)
// ---------------------------------------------------------------------------

// A SOLD account must not stay in a no-claim bot: it leaves the bot and goes to
// the recycler — a "spent — …" pool note plus the sold game in soldGames, the
// hand-over utils/spentAccountEligibility reads. (An UNSOLD account whose event
// ended stays and farms the next one — expireAccount.)
//
// Every path that sells an account is meant to do this itself, and several did
// not: a sale through a by-game offer (Eldorado / PlayerAuctions / G2G) only
// flips the ledger to "sold", the hand-sold tick deliberately left the account
// farming, and a spend whose config edit failed was never retried — 114 sold
// accounts were still in bots on 2026-09-28. This pass is the net under all of
// them: it runs after every scan and retries until the account is provably out.
//
// Sold = a "sold" ledger whose sale has settled (an owner listing's unit once
// its delivery was recorded; any other sale an hour after it — a claim-at-sale
// order flips the ledger at claim time, before the hand-over), or a pool row
// ticked manualSold (sold by hand). Never touched: a bot marked "my own"
// (.personal — its accounts are fenced with manualSold but were never sold),
// and a row whose pool note says it is rented to a renter.
const RETIRE_MAX_PER_PASS = 60;
const RETIRE_SETTLE_MS = 60 * 60000;
const RETIRE_OWNER_SETTLE_MS = 30 * 60000;
const RENTED_NOTE = /^rented to/i;
const SPENT_NOTE = /^spent — /i;

// Pure: why this account must leave its bot now, or "" to leave it there.
//
// A "sold" ledger is history once the pool row was claimed into a bot AFTER
// the sale (claimedAt is stamped only by noclaimFleet.claimForGame and cleared
// on release/recycle): the account was recycled and legitimately re-deployed —
// for another game, its soldGames exclude the old one — and must stay.
function reclaimedAfterSale(pool, ledger) {
  return (
    !!(pool && ledger && ledger.soldAt && pool.claimedAt) &&
    new Date(pool.claimedAt).getTime() > new Date(ledger.soldAt).getTime()
  );
}

function soldRetireReason(pool, ledger, now = Date.now()) {
  if (!pool) return "";
  if (ledger && ledger.status === "sold" && !reclaimedAfterSale(pool, ledger)) {
    const at = ledger.manualListing ? ledger.manualDeliveredAt : ledger.soldAt;
    const settle = ledger.manualListing ? RETIRE_OWNER_SETTLE_MS : RETIRE_SETTLE_MS;
    if (at && now - new Date(at).getTime() >= settle) {
      return (ledger.soldMarket || ledger.market || "marketplace") + " sale";
    }
  }
  if (pool.manualSold === true) return "sold by hand";
  return "";
}

// What a claim-at-sale unit sold for, when its ledger never recorded it: the
// shelf price of the offer that delivered it (the fulfillers append the ledger
// id to that row's units[] as contentId). Eldorado and G2G price per account;
// PlayerAuctions counts ITEMS, so its price says nothing per account — 0 stays
// "unknown", never a guess.
async function deliveredUnitPrice(ledger) {
  if (!ledger || ledger.soldPriceUsd > 0 || ledger.manualListing) return 0;
  if (!["eldorado", "g2g"].includes(String(ledger.market || ""))) return 0;
  const row = await MarketplaceListing.findOne(
    { marketplace: ledger.market, "units.contentId": String(ledger._id) },
    { price: 1 },
  )
    .lean()
    .catch(() => null);
  return row && Number(row.price) > 0 ? Number(row.price) : 0;
}

// Pool notes that belong to the no-claim farm's own history, besides its claim
// note: held stock, and the Bots-page notes the Overwatch/CoD accounts carried
// when they were migrated into no-claim bots by hand (2026-08-25/26) — stale
// unless a managed bot really has the account deployed (checked by the caller).
const NOCLAIM_LEGACY_NOTE = /^(unclaimed stock|deployed to |assigned to a bot|manual:)/i;

// The recycler's hand-over for one account that just left every bot it was in.
// `deployedElsewhere` = a managed bot has it deployed (BotAccount.configFile):
// then the pool row belongs to that system and its note is left alone.
async function handToRecycler(x, botIds, { deployedElsewhere = false } = {}) {
  const { p, l, reason } = x;
  const at = new Date();
  const game = (l && l.game) || x.game || "";
  const stampGame = settings.normGameName(game);
  const games = new Set((Array.isArray(p.soldGames) ? p.soldGames : []).filter(Boolean));
  if (stampGame) games.add(stampGame);
  const note = String(p.claimedNote || "").trim();
  // The sold game always goes on the row: its drops for that game are gone,
  // whoever owns the account now. The NOTE is only this farm's to write when
  // the row is its own (never an auto-farm or renter claim — that note is the
  // other system's ownership record); a row that already says "spent — …"
  // keeps its note (the recycler matches the prefix).
  const ours =
    !deployedElsewhere &&
    (!note || NOCLAIM_OWNER_NOTE.test(note) || NOCLAIM_LEGACY_NOTE.test(note));
  const spentNote = SPENT_NOTE.test(note)
    ? note
    : ours
      ? "spent — " + reason + " (taken out of no-claim bot " + botIds.join(", ") + ")"
      : "";
  const r = await AvailableAccount.updateOne(
    { _id: p._id, status: "claimed" },
    { $set: { soldGames: [...games], ...(spentNote && spentNote !== note ? { claimedNote: spentNote } : {}) } },
  );
  if (r && (r.matchedCount || r.n)) {
    await recordPoolUsage([p._id], {
      event: "spent",
      actor: "unclaimedAutoList",
      note: spentNote || reason + " — taken out of no-claim bot " + botIds.join(", "),
      game: stampGame || "",
    }).catch(() => {});
  }
  const login = (l && l.login) || x.login || "";
  const loginLower = String(login).toLowerCase();
  await NoclaimSpentAccount.updateOne(
    loginLower ? { loginLower } : { twitchId: x.twitchId || "", login },
    {
      $set: {
        login,
        loginLower,
        twitchId: (l && l.twitchId) || x.twitchId || "",
        game,
        botId: botIds[0] || "",
        container: botIds[0] ? containerFor(botIds[0]) : "",
        sold: true,
        connected: false,
        soldWhy: reason + " — taken out of its bot, handed to the recycler",
        tokenStatus: "ok",
        actor: "unclaimedAutoList",
        sweptAt: at,
      },
    },
    { upsert: true },
  ).catch(() => {});
  if (l) {
    const price = await deliveredUnitPrice(l);
    await UnclaimedAccount.updateOne(
      { _id: l._id, status: "sold" },
      {
        $set: {
          note: "sold — taken out of its no-claim bot, handed to the recycler",
          ...(l.soldMarket ? {} : { soldMarket: l.market || "" }),
          ...(price ? { soldPriceUsd: price } : {}),
          ...(l.manualListing && !l.manualSpentAt ? { manualSpentAt: at } : {}),
        },
      },
    ).catch(() => {});
  }
  await markOwnerUnlisted({ source: "noclaim", poolAccountId: String(p._id) });
}

// The pass. `cands` are the account rows the scan just read out of every bot
// config and `poolBySecret` their pool rows; both are only used to find who is
// sold — membership is re-read fresh before anything is edited.
async function retireSoldFromBots(cands, poolBySecret) {
  const out = {
    retired: 0, bots: 0, waiting: 0, skippedRented: 0, skippedPersonal: 0, foreignOwner: 0, errors: [],
  };
  if (settings.getAutoFarm().unclaimedRetireSold === false) return { ...out, off: true };
  const bySecret = new Map();
  for (const c of cands || []) {
    if (c.source !== "noclaim" || !c.clientSecret) continue;
    const p = poolBySecret.get(c.clientSecret);
    if (p && p._id && !bySecret.has(c.clientSecret)) bySecret.set(c.clientSecret, { c, p });
  }
  if (!bySecret.size) return out;
  const sold = await UnclaimedAccount.find(
    {
      source: "noclaim",
      status: "sold",
      poolAccountId: { $in: [...bySecret.values()].map((v) => String(v.p._id)) },
    },
    {
      poolAccountId: 1, status: 1, soldAt: 1, market: 1, soldMarket: 1, soldPriceUsd: 1,
      manualListing: 1, manualDeliveredAt: 1, manualSpentAt: 1, game: 1, login: 1, twitchId: 1,
    },
  ).lean();
  const soldByPool = new Map(sold.map((l) => [String(l.poolAccountId), l]));
  const now = Date.now();
  const picks = new Map(); // clientSecret -> account to retire
  for (const [secret, { c, p }] of bySecret) {
    const l = soldByPool.get(String(p._id)) || null;
    const reason = soldRetireReason(p, l, now);
    if (!reason) {
      // Sold, but the sale has not settled yet (not a sale it was recycled past).
      if (l && !reclaimedAfterSale(p, l)) out.waiting++;
      continue;
    }
    if (RENTED_NOTE.test(String(p.claimedNote || "").trim())) {
      out.skippedRented++;
      continue;
    }
    picks.set(secret, { p, l, reason, login: c.login, twitchId: c.twitchId, game: c.game, botId: c.botId });
  }
  if (!picks.size) return out;

  // The personal markers first (one cheap listing), so the operator's own
  // accounts never cost a full fleet read each pass. Fail closed: if the
  // markers cannot be read, nothing is edited.
  let personal;
  try {
    personal = await personalBotIds();
  } catch (e) {
    out.errors.push("could not read the bot markers: " + e.message);
    return out;
  }
  for (const [secret, x] of picks) {
    if (personal.has(String(x.botId))) {
      out.skippedPersonal++;
      picks.delete(secret);
    }
  }
  if (!picks.size) return out;

  // Fresh membership. Fail closed: with any config unreadable nothing is
  // edited this pass — an unreadable config might hold one of these accounts.
  let configs;
  try {
    configs = await readNoClaimConfigs();
  } catch (e) {
    out.errors.push("could not read the fleet: " + e.message);
    return out;
  }
  if (!configs.length || configs.some((x) => !x.cfg)) {
    out.errors.push("a no-claim config is unreadable — nothing taken out this pass");
    return out;
  }
  const botsOf = new Map(); // clientSecret -> [bot ids holding it]
  for (const { id, cfg } of configs) {
    for (const u of (cfg.TwitchSettings && cfg.TwitchSettings.TwitchUsers) || []) {
      const s = String((u && u.ClientSecret) || "");
      if (!picks.has(s)) continue;
      if (!botsOf.has(s)) botsOf.set(s, []);
      if (!botsOf.get(s).includes(id)) botsOf.get(s).push(id);
    }
  }
  const todo = [];
  for (const [secret, x] of picks) {
    const bots = botsOf.get(secret) || [];
    if (!bots.length) continue; // already out since the scan read the configs
    if (bots.some((id) => personal.has(id))) {
      out.skippedPersonal++;
      continue;
    }
    if (todo.length >= RETIRE_MAX_PER_PASS) break;
    todo.push({ secret, bots, x });
  }
  // One config edit per bot: every account this pass takes out of it at once.
  const perBot = new Map();
  for (const t of todo) {
    for (const id of t.bots) {
      if (!perBot.has(id)) perBot.set(id, []);
      perBot.get(id).push(t.secret);
    }
  }
  const leftBots = new Map(); // clientSecret -> bot ids it is now out of
  for (const [id, secrets] of perBot) {
    try {
      const res = await removeFromBotConfig(id, secrets);
      out.bots++;
      for (const s of res.removed) {
        if (!leftBots.has(s)) leftBots.set(s, []);
        leftBots.get(s).push(id);
      }
    } catch (e) {
      out.errors.push("bot " + id + ": " + e.message);
    }
  }
  // A managed (claiming) bot that has one of these accounts deployed owns its
  // pool row: the account still leaves the no-claim bot, but that row's note is
  // not ours to rewrite (handToRecycler).
  const deployed = new Set(
    (
      await BotAccount.find(
        { clientSecret: { $in: todo.map((t) => t.secret) }, configFile: { $nin: ["", null] } },
        { clientSecret: 1 },
      )
        .lean()
        .catch(() => [])
    ).map((b) => String(b.clientSecret)),
  );
  for (const t of todo) {
    const left = leftBots.get(t.secret) || [];
    // Out of EVERY bot it was in, or the recycler does not get it yet.
    if (left.length !== t.bots.length) continue;
    try {
      const deployedElsewhere = deployed.has(t.secret);
      await handToRecycler(t.x, left, { deployedElsewhere });
      if (deployedElsewhere) out.foreignOwner++;
      out.retired++;
    } catch (e) {
      out.errors.push((t.x.login || "?") + ": " + e.message);
    }
  }
  if (out.retired) {
    logEvent({
      category: "unclaimed",
      action: "sold_retired",
      actor: "unclaimedAutoList",
      count: out.retired,
      detail:
        out.retired + " sold account(s) taken out of " + out.bots +
        " no-claim bot(s) and handed to the recycler",
    });
  }
  if (out.errors.length) {
    console.error("unclaimedAutoList sold-account retire:", out.errors.slice(0, 5).join(" | "));
  }
  return out;
}

// Delist a set of rows (used by the operator override). Marks each row
// delisted after the platform confirms, records failures in lastError.
// ---------------------------------------------------------------------------
// Bulk hand sale (owner, 2026-09-28)
// ---------------------------------------------------------------------------
// The owner sells a batch by hand (a chat buyer, a bulk deal). Copying logins
// reserved nothing: the Eldorado shop offer and the auto-lister could sell the
// same accounts minutes later — 19 went to two buyers on 2026-09-18 — and
// "Export held creds" re-exported accounts already sold by hand. So a hand sale
// marks each account SOLD before its login is handed out, under the same
// compare-and-set every seller uses, and exactly one channel wins it:
//   1. it is on no active listing;
//   2. its ledger (one row per login) goes skipped/released/expired -> "sold"
//      (soldMarket "manual"); a login with no ledger gets a new "sold" row, and
//      a racing claimer's row makes this one back off;
//   3. the pool row gets the Sold tick (manualSold + soldGames, listed off),
//      only while still claimed and unticked — otherwise step 2 is undone.
// Nothing sells it again: the scan skips manualSold, the owner's shop listings
// refuse a sold ledger or a manualSold row, and the next scan takes it out of
// its bot and hands it to the recycler (retireSoldFromBots, "sold by hand").
// `accounts`: [{ login, poolAccountId, game?, botId?, container?, twitchId? }].
// Returns one { login, poolAccountId, sold, why, ledgerId } per account.
const HAND_FREE_STATUSES = ["skipped", "released", "expired"];

async function handSellAccounts(accounts, { game = "", actor = "", reason = "" } = {}) {
  const gameNorm = settings.normGameName(game);
  const out = [];
  for (const a of accounts || []) {
    const login = String((a && a.login) || "").trim();
    const loginLower = login.toLowerCase();
    const res = { login, poolAccountId: String((a && a.poolAccountId) || ""), sold: false, why: "" };
    out.push(res);
    if (!loginLower || !res.poolAccountId) {
      res.why = "no login or pool row";
      continue;
    }
    if ((await activeListingsForLogin(login)).length) {
      res.why = "on a listing";
      continue;
    }
    const now = new Date();
    const fields = {
      status: "sold",
      soldAt: now,
      soldMarket: "manual",
      soldPriceUsd: 0,
      lastCheckedAt: now,
      note: "sold by hand" + (reason ? " — " + reason : "") + (actor ? " (" + actor + ")" : ""),
    };
    const rows = await UnclaimedAccount.find({ source: "noclaim", loginLower }).lean();
    if (rows.length > 1) {
      res.why = "two ledger rows — check by hand";
      continue;
    }
    let commit;
    if (rows[0]) {
      const l = rows[0];
      if (!HAND_FREE_STATUSES.includes(l.status)) {
        res.why = "ledger " + l.status;
        continue;
      }
      const r = await UnclaimedAccount.updateOne({ _id: l._id, status: l.status }, { $set: fields });
      if (!r || !r.modifiedCount) {
        res.why = "taken meanwhile";
        continue;
      }
      commit = { id: l._id, prior: l };
    } else {
      const doc = await UnclaimedAccount.create({
        source: "noclaim",
        login,
        loginLower,
        game: (a && a.game) || game,
        poolAccountId: res.poolAccountId,
        botId: String((a && a.botId) || ""),
        container: String((a && a.container) || ""),
        twitchId: String((a && a.twitchId) || ""),
        ...fields,
      });
      const n = await UnclaimedAccount.countDocuments({ source: "noclaim", loginLower });
      if (n > 1) {
        await UnclaimedAccount.deleteOne({ _id: doc._id, status: "sold" }).catch(() => {});
        res.why = "taken meanwhile";
        continue;
      }
      commit = { id: doc._id, created: true };
    }
    const p = await AvailableAccount.updateOne(
      { _id: res.poolAccountId, status: "claimed", manualSold: { $ne: true }, listed: { $ne: true } },
      {
        $set: { manualSold: true, listed: false },
        ...(gameNorm ? { $addToSet: { soldGames: gameNorm } } : {}),
      },
    );
    if (!p || !p.modifiedCount) {
      if (commit.created) {
        await UnclaimedAccount.deleteOne({ _id: commit.id, status: "sold" }).catch(() => {});
      } else {
        const prior = commit.prior;
        await UnclaimedAccount.updateOne(
          { _id: commit.id, status: "sold" },
          {
            $set: {
              status: prior.status,
              soldAt: prior.soldAt || null,
              soldMarket: prior.soldMarket || "",
              soldPriceUsd: Number(prior.soldPriceUsd) || 0,
              lastCheckedAt: prior.lastCheckedAt || null,
              note: prior.note || "",
            },
          },
        ).catch(() => {});
      }
      res.why = "pool row not free (sold, listed or not claimed)";
      continue;
    }
    res.sold = true;
    res.ledgerId = String(commit.id);
  }
  const sold = out.filter((x) => x.sold).length;
  if (sold) {
    logEvent({
      category: "unclaimed",
      action: "hand_sold",
      actor: actor || "operator",
      game: game || "",
      count: sold,
      detail:
        sold + " account(s) sold by hand" + (reason ? " (" + reason + ")" : "") +
        " — marked sold before the logins were handed out; they leave their bots on the next run",
    });
  }
  return out;
}

async function delistRowsForAccount(rows) {
  const results = [];
  for (const row of rows) {
    if (!row || row.status !== "active") {
      results.push({ row, ok: true });
      continue;
    }
    const d = await delistRowVerified(row, "");
    results.push({ row, ok: d.ok });
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
  }
}

async function markOwnerUnlisted(ledger) {
  if (!ledger) return;
  if (ledger.source === "noclaim" && ledger.poolAccountId) {
    // An owner's no-claim listing ("manual") still holds the account too.
    const still = await UnclaimedAccount.exists({
      poolAccountId: ledger.poolAccountId,
      status: { $in: ["listed", "manual"] },
    });
    if (still) return;
    await AvailableAccount.updateOne(
      { _id: ledger.poolAccountId, listed: { $ne: false } },
      { $set: { listed: false } },
    ).catch(() => {});
  }
}

// `cls` (v3, optional): classifyHoldings result — stamps bundleKey/bundleLabel
// on the ledger so the archive views can group accounts by event bundle.
async function ledgerAccount(cand, set, market, row, sellable, game, price, note, cls) {
  const login = cand.login || "";
  const loginLower = String(login).toLowerCase();
  const existing = await UnclaimedAccount.findOne({ loginLower, source: cand.source }).lean();
  // A ledger that is NOT listed right now (skipped / expired / released /
  // removed) is being attached afresh, so its market MUST follow the new
  // attachment. `$setOnInsert:{market}` alone left a re-listed-in-place ledger
  // with its OLD market, and rowForLedger then looked on the wrong marketplace
  // (the trap the R6 re-bundle recipe worked around by deleting ledgers).
  const repointMarket = !existing || existing.status !== "listed";
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
  // Somebody else committed this account while this pass was publishing it —
  // an owner's hand-made no-claim listing (docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md)
  // or a claim-at-sale order. Never overwrite that commitment, and take back
  // what this pass just put on sale (a fresh Gameflip unit, or a GGSel/Plati
  // product line), so the account is never on two listings at once. A waiting
  // Gameflip unit sits on no row, so there is nothing to take back for it.
  const refuse = async (why) => {
    if (row) {
      await removeUnitFromRow(
        row,
        { login, loginLower, source: cand.source },
        { removeFromProduct: true, log: false },
      ).catch((e) =>
        console.error("unclaimedAutoList: undo of a refused attach failed:", e.message),
      );
    }
    logEvent({
      category: "unclaimed",
      action: "skip",
      actor: "unclaimedAutoList",
      subject: login,
      detail: why + " — refused auto attach",
    });
    return existing;
  };
  if (existing && existing.status === "manual") {
    return refuse("login committed to a manual no-claim listing");
  }
  // Sold (a claim-at-sale order took it) or removed (ticked manual-sold) since
  // this pass's own checks: the scan skips exactly these, so reaching here
  // means it changed mid-publish — listing it now would sell it twice.
  if (existing && (existing.status === "sold" || existing.status === "removed")) {
    return refuse("login " + existing.status + " while this pass was publishing");
  }
  // Compare-and-set on the status just read: a claim that lands between the
  // read above and this write would otherwise be silently overwritten with
  // "listed". Only a brand-new ledger is upserted.
  const created = await UnclaimedAccount.findOneAndUpdate(
    existing
      ? { _id: existing._id, status: existing.status }
      : { loginLower, source: cand.source },
    {
      $set: {
        source: cand.source,
        login,
        loginLower,
        twitchId: cand.twitchId || "",
        game,
        set: set._id,
        poolAccountId: cand.poolAccountId || "",
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
        bundleKey: String((cls && cls.bundleKey) || ""),
        bundleLabel: String((cls && cls.bundleLabel) || ""),
        // A fresh listing starts with a clean expiry-strike record.
        emptyReads: 0,
        firstEmptyAt: null,
        lotId: "",
        ...(repointMarket ? { market } : {}),
      },
      ...(repointMarket ? {} : { $setOnInsert: { market } }),
    },
    { upsert: !existing, returnDocument: "after" },
  );
  if (!created) {
    return refuse("ledger changed while this pass was publishing");
  }
  // The account is now attached to a listing — auto-tick its console box.
  await markOwnerListed(cand);
  return created;
}

// Read-only integrity check: every active unclaimed row's units must match the
// ledgers committed to that marketplace, and no login may sit on two markets.
// Returns { ok, issues: [...] } so the panel can surface drift immediately.
async function consistencyIssues() {
  const issues = [];
  // Lot rows (N accounts in one Gameflip listing) are checked by
  // unclaimedLots.checkLots; here they would only masquerade as a bad live unit.
  const rows = await MarketplaceListing.find(
    { origin: ORIGIN, status: "active", ...NOT_LOT },
    { marketplace: 1, set: 1, accountLogin: 1, units: 1, externalId: 1, lastError: 1 },
  ).lean();
  // A row the reconcile sweep found off sale on the platform. The verdict is
  // already on the row, so this costs no network call — and without it an
  // offer GGSel left in draft looks perfectly healthy here while selling
  // nothing (see reconcileRowsPass step 5).
  for (const r of rows) {
    if (!String(r.lastError || "").startsWith(GGSEL_STUCK_PREFIX)) continue;
    issues.push({
      type: "off-sale",
      login: r.externalId || "",
      detail: r.marketplace + " " + r.externalId + " — " + r.lastError,
    });
  }
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
      // The relist chain keeps waiting units unpublished — off-row is normal
      // (and lot members sit on their lot row, which is not read here).
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

// ---------------------------------------------------------------------------
// Reconcile pass — the self-healing net under every other path
// ---------------------------------------------------------------------------

// consistencyIssues() only REPORTS, and its set+market map even collapses
// duplicate rows so it cannot see them. This pass fixes what it finds:
//
//   1. more than one active row for the same set+market (never legitimate off
//      a lot) -> keep the newest, take the rest off sale;
//   2. a row whose deliverable logins are no longer sellable ledgers (sold,
//      manual-sold, expired, released) -> drop those units, and take the whole
//      row off sale when nothing sellable is left.
//
// Every zombie found on 2026-09-06 (a Gameflip head and a Digiseller product
// for accounts already hand-sold, plus three duplicate GGSel offers) would
// have been cleared by this on the next tick, whatever race produced it.
const RECONCILE_GRACE_MS = 10 * 60 * 1000; // let a fresh publish attach its ledgers
// The Gameflip "everything on sale" sweep shares a rate limit with the auto-farm
// watcher's own per-tick sale detection (a 429 there looks exactly like "not
// sold"), so the leak check runs on this slower clock. opts.force runs it now,
// which is what a manual reconcile wants.
const ONSALE_SWEEP_MS = 30 * 60 * 1000;
let lastOnsaleSweepAt = 0;
// The mirror of the Gameflip sweep for GGSel: rows we believe are on sale that
// GGSel has sitting in draft/paused. Same throttle, same reason.
let lastGgselSweepAt = 0;

// Which active rows are duplicates of another row for the same set+market?
// Pure: `rows` oldest-first, the NEWEST row of a group is the survivor (it is
// the one the last publish/rebuild produced and the one carrying the current
// units). Returns the ids of every other row in a group of two or more.
function supersededRowIds(rows) {
  const groups = new Map();
  for (const r of rows || []) {
    const k = String(r.set) + ":" + r.marketplace;
    groups.set(k, (groups.get(k) || []).concat(r));
  }
  const out = new Map(); // superseded id -> the row that supersedes it
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const keep = list[list.length - 1];
    for (const r of list) {
      if (String(r._id) !== String(keep._id)) out.set(String(r._id), keep);
    }
  }
  return out;
}

// What should happen to ONE live row, given whether each login it can deliver
// is still a sellable unit of that item? Pure so the rule is testable without
// Mongo or a marketplace. `isSellable(login)` answers for this row's item.
//   { action: "none" }                       nothing to do
//   { action: "delist", bad }                nothing sellable is left
//   { action: "repair", bad, good }          some units must come off
function reconcileRowPlan(row, isSellable) {
  if (!row) return { action: "none" };
  if (row.marketplace === "gameflip") {
    // A Gameflip row sells exactly one account: its live unit.
    const live = String(row.accountLogin || "").trim();
    if (!live) return { action: "none" };
    if (isSellable(live)) return { action: "none" };
    return { action: "delist", bad: [{ login: live }] };
  }
  // A unit already handed to a buyer is history, not stock — it says nothing
  // about whether this row can still deliver.
  const units = (row.units || []).filter((u) => !u.deliveredAt);
  if (!units.length) return { action: "none" };
  const good = units.filter((u) => isSellable(u.login));
  if (good.length === units.length) return { action: "none" };
  const bad = units.filter((u) => !isSellable(u.login));
  return good.length ? { action: "repair", bad, good } : { action: "delist", bad, good: [] };
}

// The game a live row sells: its own listed units' game, else its set's.
async function gameOfRow(row, ledgers) {
  for (const l of ledgers || []) {
    if (l.market === row.marketplace && String(l.set) === String(row.set) && l.game) return l.game;
  }
  const set = row.set ? await DropSet.findById(row.set).lean().catch(() => null) : null;
  return (set && (set.coverGame || (set.items && set.items[0] && set.items[0].game))) || "";
}

// Whether the owner's per-game market list (settings.unclaimedGameMarkets)
// still includes this market. No list for the game means every market.
function marketAllowedForGame(game, market) {
  const allowed = settings.gameMarketsFor ? settings.gameMarketsFor(game) : null;
  if (!Array.isArray(allowed) || !allowed.length) return true;
  return allowed.includes(market);
}

async function reconcileRowsPass(opts = {}) {
  const apply = opts.apply !== false;
  const out = { rows: 0, duplicates: 0, delisted: 0, repaired: 0, stranded: 0, offSale: 0, failed: 0, actions: [] };
  // Only the markets THIS engine publishes to and owns the stock model of.
  // An origin:"unclaimed" row can also live on Eldorado, where the offer is a
  // standing one whose accounts are picked from the ledger at delivery time
  // (utils/eldoradoFulfiller claimUnclaimedForGame) and whose units[] is a
  // record of what was already delivered — judged by the rules below it would
  // look like a row full of spent accounts and be taken off sale for doing
  // exactly what it is meant to do.
  const rows = await MarketplaceListing.find({
    origin: ORIGIN,
    status: "active",
    marketplace: { $in: settings.UNCLAIMED_MARKETS },
    ...NOT_LOT,
  })
    .sort({ createdAt: 1 })
    .lean();
  if (!rows.length) return out;
  out.rows = rows.length;

  const cutoff = Date.now() - RECONCILE_GRACE_MS;
  // Every listed unit, not just those of the sets that still have a live row —
  // a set whose only row was taken down is exactly where a stranded unit hides.
  const ledgers = await UnclaimedAccount.find({ status: "listed" })
    .select("loginLower login set market lotId listedAt poolAccountId source game")
    .lean();
  const marked = await manualSoldOwnerKeys(ledgers);
  const sellable = new Set();
  for (const l of ledgers) {
    if (marked.has(manualSoldKey(l))) continue;
    sellable.add(String(l.set) + ":" + l.market + ":" + String(l.loginLower || "").toLowerCase());
  }
  const sellableFor = (row) => (login) =>
    sellable.has(
      String(row.set) + ":" + row.marketplace + ":" + String(login || "").toLowerCase(),
    );

  // 1. Duplicate active rows for one set+market — keep the newest.
  const superseded = supersededRowIds(rows);
  for (const row of rows) {
    const keep = superseded.get(String(row._id));
    if (!keep) continue;
    out.duplicates++;
    out.actions.push({
      action: "duplicate",
      marketplace: row.marketplace,
      externalId: row.externalId,
      detail: "superseded by " + keep.externalId,
    });
    if (!apply) continue;
    const d = await withSetMarketLock(row.set, row.marketplace, () =>
      delistRowVerified(row, "duplicate row — superseded by " + keep.externalId),
    );
    if (d.ok) out.delisted++;
    else out.failed++;
  }

  // 2. Rows that can still deliver an account nobody may buy any more.
  for (const row of rows) {
    if (superseded.has(String(row._id))) continue;
    if (new Date(row.createdAt || 0).getTime() > cutoff) continue;
    try {
      const plan = reconcileRowPlan(row, sellableFor(row));
      if (plan.action === "none") continue;
      const badLogins = (plan.bad || []).map((u) => u.login).join(", ");
      out.actions.push({
        action: plan.action === "delist" ? "no-stock" : "dead-units",
        marketplace: row.marketplace,
        externalId: row.externalId,
        detail: badLogins + " no longer sellable",
      });
      if (!apply) continue;
      const ok = await withSetMarketLock(row.set, row.marketplace, async () => {
        const fresh = await MarketplaceListing.findById(row._id).lean().catch(() => null);
        if (!fresh || fresh.status !== "active") return true;
        if (plan.action === "delist") {
          const d = await delistRowVerified(fresh, "no sellable stock behind it");
          if (!d.ok) return false;
          out.delisted++;
          // A Gameflip chain whose head just came down gets its next waiting
          // unit straight away — the item stays on sale, honestly stocked.
          if (fresh.marketplace === "gameflip") {
            await publishGameflipSuccessor(fresh.set, fresh.accountLogin, {
              log: false,
              locked: true,
            });
          }
          return true;
        }
        if (fresh.marketplace === "digiseller") {
          for (const u of plan.bad) {
            if (u.contentId) {
              await mp
                .digisellerRemoveContent(fresh.externalId, u.contentId)
                .catch(() => {});
            }
          }
          await MarketplaceListing.updateOne(
            { _id: fresh._id, status: "active" },
            {
              $set: {
                units: plan.good,
                accountLogin: plan.good.map((u) => u.login).join(", "),
              },
            },
          ).catch(() => {});
          out.repaired++;
          return true;
        }
        if (fresh.marketplace === "ggsel") {
          await rebuildGgselOffer(fresh, plan.good, { locked: true });
          out.repaired++;
          return true;
        }
        return true;
      });
      if (!ok) out.failed++;
    } catch (e) {
      out.failed++;
      console.error(
        "unclaimedAutoList reconcile failed for " + row.marketplace + " " + row.externalId + ":",
        e.message,
      );
    }
  }
  // 3. The mirror of (2): a ledger that says "listed" but sits on no live row.
  // The scan pass skips every listed/sold/removed ledger, so such an account is
  // stranded forever — farming, held out of the sellable pool, on sale nowhere.
  // Park it as "skipped" (the engine's held state) so the next scan re-lists it
  // on whichever market its game allows. Gameflip units waiting in a relist
  // chain are OFF-row by design, and lot members sit on their lot row, so
  // neither counts as stranded.
  const carried = new Set();
  for (const r of rows) {
    if (superseded.has(String(r._id))) continue;
    for (const u of r.units || []) {
      carried.add(String(r.set) + ":" + r.marketplace + ":" + String(u.login || "").toLowerCase());
    }
  }
  for (const l of ledgers) {
    if (!l.market || l.market === "gameflip") continue;
    if (l.lotId) continue;
    if (new Date(l.listedAt || 0).getTime() > cutoff) continue;
    const key = String(l.set) + ":" + l.market + ":" + String(l.loginLower || "").toLowerCase();
    if (carried.has(key)) continue;
    out.actions.push({
      action: "stranded",
      marketplace: l.market,
      externalId: l.login || String(l._id),
      detail: "listed on " + l.market + " but on no live row — released for re-listing",
    });
    if (!apply) continue;
    const r = await UnclaimedAccount.updateOne(
      { _id: l._id, status: "listed" },
      {
        $set: {
          status: "skipped",
          note: "stranded — was listed on " + l.market + " with no live listing; re-listing on the next scan",
          lastCheckedAt: new Date(),
        },
      },
    ).catch(() => null);
    if (r && r.modifiedCount) out.stranded++;
  }

  // 4. Rows we believe are DOWN that Gameflip still has on sale. A delist that
  // failed used to be swallowed and the row marked delisted anyway, so nothing
  // ever looked at it again — gameflip 97b49ffd sold a hand-sold R6 account
  // that way. Gameflip is the one platform that will list everything on sale in
  // one paged call, but it is rate-limited and shared with the watcher, so the
  // check runs on ONSALE_SWEEP_MS rather than every pass.
  if (opts.force || Date.now() - lastOnsaleSweepAt >= ONSALE_SWEEP_MS) {
    try {
      lastOnsaleSweepAt = Date.now();
      const onsale = await mp.gameflipListingIdsByStatus("onsale");
      const liveIds = [...(onsale || [])].map(String);
      if (liveIds.length) {
        const leaked = await MarketplaceListing.find({
          origin: ORIGIN,
          marketplace: "gameflip",
          status: { $ne: "active" },
          externalId: { $in: liveIds },
        }).lean();
        for (const row of leaked) {
          out.actions.push({
            action: "leaked",
            marketplace: "gameflip",
            externalId: row.externalId,
            detail: "row is " + row.status + " here but still on sale on Gameflip",
          });
          if (!apply) continue;
          const d = await withSetMarketLock(row.set, "gameflip", () =>
            delistRowVerified(row, "was still on sale after a failed delist", {
              force: true,
            }),
          );
          if (d.ok) out.delisted++;
          else out.failed++;
        }
      }
    } catch (e) {
      console.error("unclaimedAutoList onsale cross-check failed:", e.message);
    }
  }

  // 5. The GGSel mirror of (4): rows we believe are ACTIVE that GGSel has off
  // sale. GGSel accepts batch_activate and can still leave an offer in "draft"
  // (published, never went live) or "paused" — and unlike Gameflip, nothing
  // else was watching: the marketplace guardian's re-activation heal only runs
  // on autoDeliver rows, and unclaimed digiseller/ggsel rows are not that. So
  // an offer sat in draft for six days holding 16 accounts nobody could buy.
  // One status read per row, throttled like the Gameflip sweep.
  if (opts.force || Date.now() - lastGgselSweepAt >= ONSALE_SWEEP_MS) {
    lastGgselSweepAt = Date.now();
    for (const row of rows) {
      if (row.marketplace !== "ggsel") continue;
      if (superseded.has(String(row._id))) continue;
      if (new Date(row.createdAt || 0).getTime() > cutoff) continue;
      let status = "";
      try {
        status = await mp.ggselOfferStatus(row.externalId);
      } catch (e) {
        console.error("unclaimedAutoList ggsel status " + row.externalId + ":", e.message);
        continue;
      }
      if (status === "active") {
        // Clear a stale stuck-marker once it really is live again.
        if (apply && String(row.lastError || "").startsWith(GGSEL_STUCK_PREFIX)) {
          await MarketplaceListing.updateOne(
            { _id: row._id },
            { $set: { lastError: "" } },
          ).catch(() => {});
        }
        continue;
      }
      // The owner took GGSel out of this game's markets (2026-09-28) and the
      // offer is off sale on GGSel itself — paused by hand in the GGSel panel,
      // because GGSel accepts the API pause but never applies it. Never switch
      // such an offer back on: close it on our side and hand its accounts back
      // as held stock for the markets the game still uses. A paused GGSel offer
      // still carries its delivery codes, so it must not be re-activated
      // before those codes are cleared.
      const rowGame = await gameOfRow(row, ledgers);
      if (status && rowGame && !marketAllowedForGame(rowGame, "ggsel")) {
        out.marketOff = (out.marketOff || 0) + 1;
        out.actions.push({
          action: "market-off",
          marketplace: "ggsel",
          externalId: row.externalId,
          detail: "GGSel is off for " + rowGame + " and the offer is " + status + " on GGSel — closed, accounts held",
        });
        if (!apply) continue;
        await withSetMarketLock(row.set, "ggsel", async () => {
          const fresh = await MarketplaceListing.findById(row._id).lean().catch(() => null);
          if (!fresh || fresh.status !== "active") return;
          await MarketplaceListing.updateOne(
            { _id: fresh._id, status: "active" },
            {
              $set: {
                status: "delisted",
                lastError:
                  "GGSel off for " + rowGame + " — offer " + status + " on GGSel, accounts released; " +
                  "it still carries their codes, clear them before re-activating it",
              },
            },
          ).catch(() => {});
          const logins = new Set(
            (fresh.units || [])
              .filter((u) => !u.deliveredAt)
              .map((u) => String(u.login || "").toLowerCase())
              .filter(Boolean),
          );
          for (const l of ledgers) {
            if (l.market !== "ggsel" || String(l.set) !== String(fresh.set)) continue;
            if (!logins.has(String(l.loginLower || "").toLowerCase())) continue;
            const r = await UnclaimedAccount.updateOne(
              { _id: l._id, status: "listed" },
              {
                $set: {
                  status: "skipped",
                  note: "held — GGSel taken off " + rowGame + "; its offer was " + status + " on GGSel",
                  lastCheckedAt: new Date(),
                  lotId: "",
                },
              },
            ).catch(() => null);
            if (r && r.modifiedCount) {
              out.marketOffHeld = (out.marketOffHeld || 0) + 1;
              await markOwnerUnlisted(l);
            }
          }
        });
        continue;
      }
      out.offSale = (out.offSale || 0) + 1;
      out.actions.push({
        action: "off-sale",
        marketplace: "ggsel",
        externalId: row.externalId,
        detail: "we call it active; GGSel says " + (status || "unknown"),
      });
      if (!apply) continue;
      // Re-activation is idempotent and is the guardian's own remedy, so try it
      // once; when it does not take, finalizeGgselOffer records why on the row.
      const fin = await withSetMarketLock(row.set, "ggsel", () =>
        finalizeGgselOffer(row.externalId, row._id),
      );
      if (fin.ok) out.repaired++;
      else out.failed++;
    }
  }

  if (apply && (out.delisted || out.repaired || out.duplicates || out.stranded || out.marketOff)) {
    logEvent({
      category: "unclaimed",
      action: "reconciled",
      actor: "unclaimedAutoList",
      count: out.delisted + out.repaired + out.stranded + (out.marketOffHeld || 0),
      detail:
        "reconcile: " + out.delisted + " row(s) taken off sale, " + out.repaired +
        " repaired, " + out.duplicates + " duplicate(s), " + out.stranded +
        " stranded unit(s) released, " +
        (out.marketOff
          ? out.marketOff + " paused GGSel offer(s) closed (" + (out.marketOffHeld || 0) + " account(s) held), "
          : "") +
        out.failed + " failed",
    });
  }
  return out;
}

// Scan candidates + list new sellable accounts into their item's ONE listing.
async function scanAndListPass() {
  const cands = [];
  try {
    cands.push(...(await collectNoClaimCandidates()));
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
      {
        clientSecret: 1, password: 1, credPasswordEnc: 1, status: 1, manualSold: 1,
        claimedNote: 1, claimedAt: 1, soldGames: 1,
      },
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
  // "manual" = committed to an owner's hand-made no-claim listing.
  const ledgered = await UnclaimedAccount.find(
    { status: { $in: ["listed", "sold", "removed", "manual"] } },
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
  // In a no-claim bot but not the no-claim farm's to sell (poolOwnerBlock):
  // skipped before any inventory read, and reported in the pass result.
  const notOwned = [];
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
      const why = poolOwnerBlock(pool);
      if (why) {
        notOwned.push({ login: c.login || "", botId: c.botId || "", why });
        continue;
      }
    }
    work.push(c);
  }
  // Ready no-claim bot accounts scan in bot order (numeric bot id, so bot 3-6
  // come before bot 10).
  work.sort((a, b) => {
    const ka = padBot(a.botId);
    const kb = padBot(b.botId);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const batch = scanBatch(orderScanCandidates(work, gameListed), gameListed);

  let listed = 0;
  const skipped = [];
  const setLocks = new Map(); // signature key -> promise chain (serialize per set)
  const gameLocks = new Map(); // game key -> promise chain (serialize cap slots)

  // v3: pricing knobs + the event catalog, loaded ONCE per pass for the
  // batch's distinct games (a listing's real game not in the batch is merged
  // on demand). Sets touched this pass are remembered for the lot hook.
  const pricing = settings.getUnclaimedPricing();
  const catalogs = makeCatalogLoader(batch.map((c) => c.game));
  const touchedSets = new Map(); // setId -> set

  // Reserve one of the game's GAME_CAP slots (serialized per game so parallel
  // workers of the same game can't both take the last slot). Returns false when
  // the game is at cap — the account stays unlisted for manual sale.
  const reserveGameSlot = (gkey, login) => {
    const prev = gameLocks.get(gkey) || Promise.resolve();
    const run = prev.then(() => {
      const cur = gameListed.get(gkey) || 0;
      const cap = capForGame(gkey);
      if (cur >= cap) {
        skipped.push({
          login,
          error: "game at cap (" + cap + ") — kept unlisted for manual sale",
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
      if (
        existing &&
        (existing.status === "listed" || existing.status === "sold" || existing.status === "manual")
      )
        return;

      // The account may hold farmed drops for several games (a no-claim bot
      // watches every FavouriteGame). Group by the drops' REAL game and list
      // only one game per account — otherwise a listing titled "Rainbow Six
      // Siege" advertises Call of Duty / Delta Force drops.
      const { game, drops } = pickListingGroup(cand.game, sellable);
      const signature = signatureFor(game, drops);
      if (!signature.key) return;
      const prev = setLocks.get(signature.key) || Promise.resolve();
      const run = prev.then(async () => {
        const research = await MarketResearch.findOne({ game }).lean().catch(() => null);
        // Bundle classification (event / waves / copies) against the pass's
        // catalog, then the analytics price for exactly these items.
        const catalog = await catalogs.forGame(game);
        const cls = classifyDrops(game, drops, catalog);
        const items = dedupeSetItems(drops, game);
        // A brand-new set has no sales history, so it is priced with
        // soldFloorUsd 0 (the default); an existing set is re-priced below
        // against what it recently sold for.
        let priced = priceForItems({ research, game, items, cls, pricing });
        const set = await ensureUnclaimedSet(signature, game, drops, priced.price, {
          cls,
          floor: priced.floor,
        });
        // The set's price is the item's price on every market. A brand-new set
        // carries the analytics price; an existing set keeps its price while it
        // has a live row (repricing live rows is the reprice job's business),
        // but a DORMANT set (no active row anywhere) is refreshed so its next
        // listing is not published at a stale flat price — and never below
        // the best price this set actually sold at in the last 30 days.
        let price = Number(set.price) || 0;
        const dormant = !(await MarketplaceListing.exists({
          origin: ORIGIN,
          set: set._id,
          status: "active",
        }));
        if (dormant) {
          const soldFloor = await soldFloorForSet(set._id);
          if (soldFloor > 0) {
            priced = priceForItems({ research, game, items, cls, pricing, soldFloorUsd: soldFloor });
          }
        }
        if (dormant && Math.abs(price - priced.price) >= 0.01) {
          price = priced.price;
          await DropSet.updateOne(
            { _id: set._id },
            { $set: { price, minPriceUsd: priced.floor } },
          ).catch(() => {});
          set.price = price;
        }
        if (!price) price = priced.price;
        touchedSets.set(String(set._id), set);
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
            status: { $in: ["listed", "manual"] }, // "manual": an owner's no-claim listing
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
              row = await publishGameflipUnit(set, withLogin, drops, price, img, cls);
              if (img) await fsp.unlink(img).catch(() => {});
              await ledgerAccount(
                withLogin,
                set,
                "gameflip",
                row,
                drops,
                game,
                price,
                "unclaimed auto-list — live unit",
                cls,
              );
            } else {
              // Gameflip sells one account per bundle at a time; the queue behind
              // it only has to replace that one. A longer queue locks accounts
              // nobody can buy here away from the shop's other channels and fills
              // the game's cap, so a NEW bundle can never get a listing.
              const waiting = await UnclaimedAccount.countDocuments({
                set: set._id,
                market: "gameflip",
                status: "listed",
                lotId: { $in: ["", null] },
              });
              if (waiting - 1 >= GAMEFLIP_WAITING_MAX) {
                skipped.push({
                  login,
                  error:
                    "Gameflip queue for this bundle is full (" + GAMEFLIP_WAITING_MAX +
                    " waiting) — kept free for the other channels",
                });
                return;
              }
              await ledgerAccount(
                withLogin,
                set,
                "gameflip",
                row,
                drops,
                game,
                price,
                "unclaimed auto-list — waiting unit",
                cls,
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
                drops,
                price,
                img,
                ggselCategoryId,
                cls,
              );
              if (img) await fsp.unlink(img).catch(() => {});
            } else {
              // A quantity row retitled to a fuller bundle (requiredDrops) sells
              // any of its units, so an account holding only the set's smaller
              // bundle must not join it (it would be sold as the fuller one).
              if (unitShortfall(set, row, drops).length) {
                skipped.push({
                  login,
                  error: "its " + market + " listing promises more than this account holds — not attached",
                });
                return;
              }
              await addUnitToRow(row, withLogin);
            }
            await ledgerAccount(
              withLogin,
              set,
              market,
              row,
              drops,
              game,
              price,
              "unclaimed auto-list — stock unit",
              cls,
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

  // Hunk 7: Gameflip lots (flag unclaimedGameflipLots, default OFF). After
  // every set's single-unit chain is settled, any set with >= lotSize WAITING
  // gameflip units gets at most ONE lot published per pass. Sets touched this
  // pass are checked first, then every other set that still has gameflip
  // ledgers waiting (units accumulate across passes).
  let lots = 0;
  if (pricing.lots && lotsMod()) {
    try {
      const setIds = await UnclaimedAccount.distinct("set", {
        market: "gameflip",
        status: "listed",
        lotId: { $in: ["", null] },
      });
      const order = [
        ...touchedSets.keys(),
        ...setIds.map(String).filter((id) => id && !touchedSets.has(id)),
      ];
      for (const id of order) {
        const set = touchedSets.get(id) || (await DropSet.findById(id).lean().catch(() => null));
        if (!set) continue;
        const r = await maybePublishLot(set, pricing);
        if (r && (r.published || r.row || r.lotId)) lots++;
      }
    } catch (e) {
      console.error("unclaimedAutoList lot hook failed:", e.message);
    }
  }
  // Sold accounts leave their bots and go to the recycler (retireSoldFromBots).
  let retire = null;
  try {
    retire = await retireSoldFromBots(cands, poolBySecret);
  } catch (e) {
    console.error("unclaimedAutoList sold-account retire failed:", e.message);
    retire = { error: e.message };
  }
  return {
    candidates: work.length,
    scanned: batch.length,
    listed,
    repaired,
    lots,
    skipped,
    notOwned: notOwned.length,
    notOwnedSample: notOwned.slice(0, 10),
    retire,
  };
}

// Sets with gameflip ledgers but no live row get a live unit published again
// (heals a chain after a sale/expiry with no successor, or a failed publish).
async function repairGameflipChains() {
  const setIds = await UnclaimedAccount.distinct("set", {
    market: "gameflip",
    status: "listed",
    lotId: { $in: ["", null] }, // lot members are on sale inside their lot
  });
  let repaired = 0;
  for (const setId of setIds) {
    if (!setId) continue;
    const active = await MarketplaceListing.findOne({
      origin: ORIGIN,
      set: setId,
      marketplace: "gameflip",
      status: "active",
      ...NOT_LOT,
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

// ---------------------------------------------------------------------------
// Manual-sold removal (shared by the periodic pass and the reactive ticks)
// ---------------------------------------------------------------------------

// Park ONE listed ledger whose owner carries the manual-sold tick: mark the
// ledger "removed" (NOT sold, NOT released; the account keeps farming), then
// pull the login off EVERY active row that still carries it (the gameflip
// live unit + successor, digiseller content line(s), ggsel offer rebuild(s)).
//
// The ledger flip comes FIRST on purpose. While it came last, a parallel
// removal's Gameflip successor could still read this account as a waiting
// "listed" unit and publish it as the chain's new head moments before it was
// parked — which is how a sold R6 account ended up as the live unit of
// gameflip dab19b8e. Marked first, no publisher can ever pick it up; if the
// row scrub below fails, the reconcile pass takes that row off sale instead.
async function removeManualSoldLedger(ledger, opts = {}) {
  if (!ledger || !ledger._id) return false;
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
  await removeLoginFromAllRows(ledger, { removeFromProduct: true, log: false });
  await markOwnerUnlisted(ledger);
  logEvent({
    category: "unclaimed",
    action: "manual_sold_removed",
    actor: opts.actor || "unclaimedAutoList",
    subject: ledger.login || String(ledger._id) || "",
    game: ledger.game || "",
    count: 1,
    detail:
      "manual-sold account removed from listing — kept farming (" +
      (ledger.source || "") +
      ")",
  });
  return true;
}

// A ledger the sale/expiry pass meets while its owner already carries the
// manual-sold tick: park it exactly like the sweep does instead of selling it.
// The pass has always called this — it was never defined, so both call sites
// threw a ReferenceError into their catch and the marked unit stayed listed
// (in the quantity-sale loop it also aborted that row's remaining sales).
async function removeMarkedLedger(ledger) {
  return removeManualSoldLedger(ledger, { actor: "unclaimedAutoList" });
}

// Every listed ledger belonging to ONE owner row that was just ticked
// manual-sold. Reactive twin of the expiry pass's sweep: the tick calls this
// so the delist happens NOW instead of up to one pass later, closing the
// window where the platform could hand the same login to a second buyer.
// Safe to call for an account that was never auto-listed (returns zeroes).
async function removeManualSoldOwner(owner = {}) {
  const out = { ledgers: 0, removed: 0, errors: [] };
  const or = [];
  if (owner.poolAccountId) or.push({ poolAccountId: String(owner.poolAccountId) });
  if (!or.length) return out;
  const ledgers = await UnclaimedAccount.find({ status: "listed", $or: or }).lean();
  out.ledgers = ledgers.length;
  for (const ledger of ledgers) {
    try {
      await removeManualSoldLedger(ledger, { actor: owner.actor || "operator" });
      out.removed++;
    } catch (e) {
      out.errors.push(e.message);
      console.error("manual-sold removal failed:", e.message);
    }
  }
  // The account may also be a unit of an owner's hand-made no-claim listing
  // ("manual" ledgers, docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md); that layer
  // takes it off its own rows. Required lazily and only when such a ledger
  // exists, so a missing or broken sibling can never fail this tick.
  out.manualUnits = 0;
  try {
    const poolAccountId = String(owner.poolAccountId);
    if (await UnclaimedAccount.exists({ poolAccountId, status: "manual" })) {
      const r = await require("./noclaimListings").removeForPoolAccount(poolAccountId, {
        actor: owner.actor || "operator",
      });
      out.manualUnits = Number(r && r.units) || 0;
      for (const e of r && Array.isArray(r.errors) ? r.errors : []) {
        out.errors.push(String((e && e.message) || e));
      }
    }
  } catch (e) {
    out.errors.push(String((e && e.message) || e).split("\n")[0]);
    console.error("manual-sold no-claim listing removal failed:", e && e.message);
  }
  return out;
}

// Expiry + sale pass:
//   A) quantity-market sales (a stock drop on the item's product)
//   B) per-ledger: claimed -> spent; all drops gone -> expired (off sale, the
//      account stays in its no-claim bot); holds LESS than its listing
//      promises -> strikes, then off that listing and held for re-listing;
//      Gameflip live row sold -> spent + successor
//   C) Gameflip chain repair
async function expirySalePass() {
  const out = {
    checked: 0,
    sold: 0,
    expired: 0,
    released: 0,
    repaired: 0,
    manualSoldRemoved: 0,
    emptyStrikes: 0,
    // Short of its listing (handleShortUnit): taken off / strike recorded /
    // noted only (paused market, lot, switch off) / live listing not "onsale"
    // this pass / take-off failed (retried next pass).
    shrunk: 0,
    shortStrikes: 0,
    shortHeld: 0,
    shrinkWaiting: 0,
    shrinkFailed: 0,
    lots: null,
  };
  const pricing = settings.getUnclaimedPricing();

  // Manual-sold accounts (sold by the operator by hand) keep farming but must
  // NEVER be auto-sold. Remove them from their listings FIRST — before any
  // sale detection in this pass — so a marked unit can never be the one the
  // platform hands to a buyer. Parked as "removed": NOT sold, NOT released.
  const msPool = await AvailableAccount.find(
    { manualSold: true },
    { _id: 1 },
  ).lean();
  const msPoolIds = msPool.map((p) => String(p._id));
  const markedKeys = new Set(msPoolIds.map((id) => "p:" + id));
  const msLedgers = msPoolIds.length
    ? await UnclaimedAccount.find({
        status: "listed",
        poolAccountId: { $in: msPoolIds },
      })
        .sort({ lastCheckedAt: 1, _id: 1 })
        .limit(CHECK_LIMIT)
        .lean()
    : [];
  await mapLimit(msLedgers, CONCURRENCY, async (ledger) => {
    try {
      await removeManualSoldLedger(ledger, { actor: "unclaimedAutoList" });
      out.manualSoldRemoved++;
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
  // for an owner tick that lands while the pass is running. A unit with a
  // pending strike is read first, so a confirmed shortfall comes off in about
  // twenty minutes instead of waiting its turn in the rotation.
  const rest = await UnclaimedAccount.find({
    status: "listed",
    _id: { $nin: msLedgers.map((l) => l._id) },
  })
    .sort({ emptyReads: -1, lastCheckedAt: 1, _id: 1 })
    .limit(Math.max(0, CHECK_LIMIT - msLedgers.length))
    .lean();
  const ledgers = rest;

  // What each unit's listing promises: its set, and the active row selling it
  // (a rebundled row declares its own list). Loaded once per pass.
  const setsById = new Map();
  const rowByLogin = new Map();
  try {
    const setIds = [...new Set(ledgers.map((l) => String(l.set || "")).filter(Boolean))];
    if (setIds.length) {
      for (const s of await DropSet.find({ _id: { $in: setIds } }).lean()) {
        setsById.set(String(s._id), s);
      }
    }
    const liveRows = await MarketplaceListing.find({
      origin: ORIGIN,
      status: "active",
      marketplace: { $in: settings.UNCLAIMED_MARKETS },
      ...NOT_LOT,
    }).lean();
    for (const r of liveRows) {
      const logins =
        r.marketplace === "gameflip"
          ? [r.accountLogin]
          : (r.units || []).filter((u) => !u.deliveredAt).map((u) => u.login);
      for (const l of logins) {
        const k = String(l || "").trim().toLowerCase();
        if (k) rowByLogin.set(k, r);
      }
    }
  } catch (e) {
    // Without the promise nothing can be judged short — the pass carries on
    // exactly as before (a covering read), and the next pass tries again.
    console.error("unclaimedAutoList listing-promise load failed:", e.message);
  }

  // Hunk 4: which of these ledgers' campaigns have ended (>1h ago) — loaded
  // ONCE per pass by campaign name; an ended campaign lets a single empty read
  // expire the account (its drops cannot come back), otherwise the strikes
  // (unclaimedExpiryConfirmPasses, min 20 min apart) must confirm.
  const passNow = Date.now();
  let endedKeys = new Set();
  try {
    const names = [];
    for (const l of ledgers) for (const d of l.drops || []) if (d && d.campaign) names.push(d.campaign);
    endedKeys = await endedCampaignKeys(names, passNow);
  } catch (e) {
    console.error("unclaimedAutoList ended-campaign load failed:", e.message);
    endedKeys = new Set();
  }

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
        // Hunk 6: a single live unit names the login in accountLogin; a sold
        // LOT names every member in units[].login (accountLogin is the joined
        // list) — either way this account went to a buyer.
        const soldRow = await MarketplaceListing.findOne({
          origin: ORIGIN,
          set: ledger.set,
          marketplace: "gameflip",
          status: "sold",
          $or: [{ accountLogin: ledger.login }, { "units.login": ledger.login }],
        }).lean();
        if (soldRow) {
          out.sold++;
          await spendAccount(ledger, "gameflip sale", { removeFromProduct: false });
          return;
        }
      }

      // A buyer claimed a listed drop (buyerClaimedListed). `inv` is
      // inventoryForCandidate's WRAPPER — the Twitch inventory is inv.inv. This
      // used to read inv.inProgress off the wrapper (always undefined), so a
      // buyer's claim was never seen: the account ran into expiry instead of
      // being spent.
      if (buyerClaimedListed(ledger, inv && inv.inv, sellable).claimed) {
        out.sold++;
        await spendAccount(ledger, "buyer claimed a listed drop");
        return;
      }

      // Everything gone -> an expiry STRIKE (hunk 4). Only a confirmed run of
      // empty reads (or an ended campaign) removes the unit + releases the
      // account; one transient empty inventory read no longer delists.
      if (!sellable.length) {
        const decision = shouldExpire(ledger, Date.now(), {
          confirmPasses: pricing.expiryConfirmPasses,
          campaignEnded: ledgerCampaignsEnded(ledger, endedKeys),
          empty: true,
        });
        if (decision.expire) {
          out.expired++;
          // Off sale only — the account stays in its no-claim bot, so its pool
          // row stays claimed (`released` counts pool returns, never made here).
          await expireAccount(ledger);
          return;
        }
        out.emptyStrikes++;
        await UnclaimedAccount.updateOne(
          { _id: ledger._id, status: "listed" },
          {
            $set: {
              emptyReads: decision.emptyReads,
              firstEmptyAt: decision.firstEmptyAt,
              lastCheckedAt: new Date(),
              note: "inventory empty — " + decision.reason + ", awaiting confirmation",
            },
          },
        ).catch(() => {});
        return;
      }

      out.checked++;
      // The LISTED game's drops only (same rule as the scan pass), so a Rainbow
      // Six listing is never judged — or shown — with the account's Call of
      // Duty drops. This is also the ledger's refreshed snapshot.
      const listedDrops = pickListingGroup(ledger.game, sellable).drops;
      const snapshot = listedDrops.map((d) => ({
        name: d.name,
        game: d.game || ledger.game,
        campaign: d.campaign || "",
        itemKey: d.itemKey || d.name,
      }));
      // Does it still hold what its listing promises (count-aware)?
      const row = rowByLogin.get(String(ledger.login || "").toLowerCase()) || null;
      const liveRow =
        row && row.marketplace === ledger.market && String(row.set) === String(ledger.set) ? row : null;
      const set = setsById.get(String(ledger.set || "")) || null;
      const missing = set ? unitShortfall(set, liveRow, listedDrops) : [];
      if (missing.length) {
        await handleShortUnit(ledger, missing, liveRow, snapshot, out, pricing);
        return;
      }
      await UnclaimedAccount.updateOne(
        { _id: ledger._id },
        {
          $set: {
            lastCheckedAt: new Date(),
            // A read that covers the listing resets the strikes (hunk 4).
            emptyReads: 0,
            firstEmptyAt: null,
            drops: snapshot,
            note: "",
          },
        },
      ).catch(() => {});
    } catch (e) {
      console.error("unclaimedAutoList expiry pass error:", e.message);
    }
  });

  // Lots lifecycle (hunk 7): sold lot rows spend their members; a lot whose
  // member left "listed" is broken up. Runs regardless of the publish flag so
  // lots created while it was on are still looked after once it is off.
  const lots = lotsMod();
  if (lots && typeof lots.checkLots === "function") {
    try {
      out.lots = (await lots.checkLots({ pricing })) || null;
    } catch (e) {
      console.error("unclaimedAutoList checkLots failed:", e.message);
      out.lots = { error: e.message };
    }
  }

  // C) Heal Gameflip chains whose live row sold/expired without a successor.
  out.repaired = await repairGameflipChains();

  // D) Reconcile every live row against the ledgers that back it — the net
  // that catches a zombie listing no matter which path leaked it.
  try {
    out.reconcile = await reconcileRowsPass();
  } catch (e) {
    console.error("unclaimedAutoList reconcile pass failed:", e.message);
    out.reconcile = { error: e.message };
  }
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
    // Hunk 8: periodic reprice of live rows, only when the owner turned
    // unclaimedRepriceExisting on (default OFF — the "Reprice now" button with
    // dry-run is the manual path).
    let reprice = null;
    if (opts.check !== false) {
      try {
        if (settings.getUnclaimedPricing().repriceExisting) {
          const r = await repriceUnclaimedRows({ apply: true });
          reprice = { rows: r.rows, changed: r.changed, notes: r.notes };
        }
      } catch (e) {
        console.error("unclaimedAutoList reprice failed:", e.message);
        reprice = { error: e.message };
      }
    }
    // Hunk 9: automatic campaign-scoped rebundle. When the owner turns
    // unclaimedAutoRebundle on (default OFF), retitle any live
    // gameflip/ggsel/eldorado no-claim listing that now under-advertises the
    // events it already sells — at the SAME price, one edit per listing per
    // hour (cooldown). Never inflates an intentional partial bundle: the target
    // is scoped to the campaigns the listing already advertises.
    let rebundle = null;
    if (opts.check !== false && settings.getAutoFarm().unclaimedAutoRebundle) {
      try {
        const report = await require("./unclaimedListingAudit").rebundleAll({
          dryRun: false,
          auto: true,
        });
        const applied = report.filter((r) => r.applied);
        rebundle = { applied: applied.length, total: report.length };
        if (applied.length) {
          logEvent({
            category: "unclaimed",
            action: "auto_rebundle",
            actor: "unclaimedAutoList",
            meta: { applied: applied.map((r) => r.marketplace + " " + r.externalId) },
          });
        }
      } catch (e) {
        console.error("unclaimedAutoList auto-rebundle failed:", e.message);
        rebundle = { error: e.message };
      }
    }
    lastRun = { at: startedAt, scan, check, reprice, rebundle, tookMs: Date.now() - startedAt.getTime() };
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
  poolOwnerBlock,
  buyerClaimedListed,
  unitPromise,
  unitShortfall,
  SUCCESSOR_MAX_READS,
  soldRetireReason,
  retireSoldFromBots,
  handSellAccounts,
  removeFromBotConfig,
  takeOutOfBots,
  markOwnerListed,
  markOwnerUnlisted,
  sellableDropsFromNoClaimInv,
  plainPassword,
  poolPassword,
  signatureFor,
  dedupeSetItems,
  pickListingGroup,
  gameCapKey,
  chooseCapReleases,
  allocateCapKeep,
  archiveStatusFilter,
  archiveItemKey,
  groupArchiveByItem,
  groupArchiveByGame,
  listingTitle,
  listingDescription,
  uniqueDrops,
  dropsFromSet,
  shouldExpire,
  ledgerCampaignsEnded,
  credentialForLedger,
  activeListingsForLogin,
  soldMapForSecrets,
  // v3 bundles / pricing / lots / reprice
  catalogForGames,
  classificationForSet,
  priceForItems,
  soldFloorForSet,
  waitingGameflipLedgers,
  repriceUnclaimedRows,
  // engine
  ensureUnclaimedSet,
  publishGameflipUnit,
  publishProduct,
  addUnitToRow,
  removeUnitFromRow,
  reconcileRowsPass,
  reconcileRowPlan,
  finalizeGgselOffer,
  GGSEL_STUCK_PREFIX,
  supersededRowIds,
  delistRowVerified,
  delistVerdict,
  withSetMarketLock,
  rowsForLogin,
  removeLoginFromAllRows,
  removeManualSoldLedger,
  removeManualSoldOwner,
  rebuildGgselOffer,
  spendAccount,
  expireAccount,
  releaseToPool,
  delistRowsForAccount,
  publishGameflipSuccessor,
  oldestListedUnit,
  collectNoClaimCandidates,
  readNoClaimConfigs,
  inventoryForCandidate,
  candForLedger,
  runOnce,
  acquireRunLock,
  releaseRunLock,
  status,
  start,
  isPaused,
  consistencyIssues,
  ORIGIN,
  GAME_CAP,
  capForGame,
  orderScanCandidates,
  scanBatch,
  CAPPED_SCAN_READS,
  GAMEFLIP_WAITING_MAX,
  enabledMarketsForGame,
  TICK_MS,
  SCAN_LIMIT,
  CHECK_LIMIT,
};
