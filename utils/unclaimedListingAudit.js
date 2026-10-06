// Do our no-claim listings still advertise things a buyer can actually claim?
//
// Every event we farm dies on a schedule. When a wave ends its drops stop being
// claimable and vanish from the account's Twitch inventory — the account keeps
// the newer wave and silently loses the older one. The listing text does not
// change, so a bundle published across two waves keeps advertising both long
// after only one is real.
//
// That is not a bug to fix once; it is the normal life cycle, so it needs a
// standing check. Eldorado order 99d443eb (2026-09-07) is the worked example:
// a 10-item Overwatch CAH bundle sold as "Week 1 + Week 2", delivered from
// accounts that by then held only Week 2's six items. The buyer counted his loot
// boxes — one, not two — and was right. A live read of all 15 sellable accounts
// the next day confirmed it: Week 1 was gone from every single one.
//
// This module answers, per listing, from Twitch itself: what does it advertise,
// how many accounts can still honour that, and if none can, what set COULD we
// honestly sell instead?
//
// Only the no-claim games matter here (Overwatch / Rainbow Six / Call of Duty):
// their whole point is that the drops reach the buyer UNCLAIMED so they can
// connect them to their own game account. A claimed drop is not stock at all.
//
// THREE STOCK SOURCES, and a listing must be judged against its own:
//   - `unclaimedGame`      -> the no-claim ledger, picked by GAME at delivery
//   - a DropSet + no unclaimedGame -> the DROP ARCHIVE, picked by SET
//   - `origin: "unclaimed"` with a set -> the no-claim ledger, picked by SET
// A rent-farm listing ("... Automatic Farming") sells a WINDOW, not an account,
// so it has no item contract and is skipped rather than judged.
//
// The archive and the ledger mean different things by "still sellable", and
// getting that wrong would condemn every healthy listing:
//   - a NO-CLAIM account has not claimed anything, so its sellable items are the
//     `inProgress` entries at 100% and unclaimed.
//   - an ARCHIVE account claimed its drops as it farmed — that is the whole
//     design — so its items live in `drops[]` and stay sellable for as long as
//     they are NOT yet `connected` to somebody's game account. "Claimed" is
//     normal there; "connected" is what spends it.
const MarketplaceListing = require("../models/MarketplaceListing");
const UnclaimedAccount = require("../models/UnclaimedAccount");
const BotAccount = require("../models/BotAccount");
const DropSet = require("../models/DropSet");
const coverage = require("./unclaimedCoverage");
const twitchInventory = require("./twitchInventory");
const { loginsOnActiveListings, notListed } = require("./listedLogins");
const { FARM_TITLE } = require("./eldoradoFarmService");

// Sellable in the ledger's sense: not spent, and not already a unit on another
// marketplace's live listing.
const SELLABLE_STATUSES = ["released", "skipped"];

// Live reads go through the Pi like every other scanner, so keep the fan-out
// modest — this runs against real Twitch GQL.
const READ_CONCURRENCY = 5;

// How many candidate accounts to live-read per DropSet. The question is "can
// ANY account still honour this listing", so a sample answers it: 61 archive
// listings share only 33 sets, and a deep read of every candidate would be
// thousands of GQL calls for the same verdict.
const ARCHIVE_SAMPLE = 10;

function gameFilter(game) {
  const base = String(game || "")
    .trim()
    .replace(/\s*2$/, "");
  if (!base) return /.^/;
  return new RegExp("^" + base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]);
      } catch (e) {
        out[i] = { error: (e && e.message) || String(e) };
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}

// --- what we actually hold, right now ------------------------------------

// Live inventory for every sellable ledger row of one game.
//
// `refresh` writes what Twitch says back onto the ledger row. That matters
// beyond this audit: `drops[]` is what the stock counters, the bundle maker and
// the archive views all read, and it had drifted far enough that an account
// holding six claimable items was recorded as holding three.
async function liveStockForGame(game, { refresh = false } = {}) {
  const rows = await UnclaimedAccount.find({
    source: "noclaim",
    game: gameFilter(game),
    status: { $in: SELLABLE_STATUSES },
    soldAt: null,
  }).lean();

  const read = await mapLimit(rows, READ_CONCURRENCY, async (row) => {
    const sellable = await coverage.liveHeld(row);
    return { row, sellable, unreadable: sellable === null };
  });

  const stock = [];
  for (const r of read) {
    if (!r || r.error || r.unreadable || !r.sellable) {
      stock.push({ row: (r && r.row) || null, items: [], unreadable: true });
      continue;
    }
    stock.push({ row: r.row, items: r.sellable, unreadable: false });
    if (refresh) {
      // Same shape the no-claim scan writes, so every other reader sees no
      // difference except that it is now true.
      await UnclaimedAccount.updateOne(
        { _id: r.row._id },
        {
          $set: {
            drops: r.sellable.map((d) => ({
              name: d.name,
              game: d.game || game,
              campaign: d.campaign || "",
              itemKey: d.itemKey || "",
            })),
            lastCheckedAt: new Date(),
          },
        },
      ).catch(() => {});
    }
  }
  return stock;
}

// --- stock source 2: the Drop Archive ------------------------------------

// One archive account's live inventory, reduced to what a BUYER could still
// claim off it.
//
// An archive account's drops are already claimed on Twitch — the auto-farm
// claims as it farms — so "claimed" is not the disqualifier it is on the
// no-claim side. What spends a drop is `connected`: once it has been linked to
// a game account, it belongs to whoever linked it and a new buyer can never
// connect it again. That is the same rule `connectableLoadForAccounts` in
// routes/shopRoutes already ranks by (`DropLog.connected != true`), applied to
// live data instead of the archive's stored copy.
//
// Returns null when the account cannot be read at all (dead token, host down) —
// which must never be confused with "holds nothing".
// The pure half, so the rule is testable without Twitch: split an archive
// account's earned drops into what a buyer could still claim and what is already
// spoken for. Mirrors `sellableDropsFromNoClaimInv` on the no-claim side.
function sellableDropsFromArchiveInv(inv) {
  const sellable = [];
  const connected = [];
  for (const d of (inv && inv.drops) || []) {
    const entry = {
      name: d.name,
      game: d.game,
      campaign: d.campaign || "",
      itemKey: d.itemKey,
    };
    if (d.connected) {
      connected.push(entry);
      continue;
    }
    // `count` is how many copies of that reward the account holds, and a bundle
    // promising two loot boxes needs two of them — so expand the copies rather
    // than collapsing the drop to a single entry.
    const copies = Math.max(1, parseInt(d.count, 10) || 1);
    for (let i = 0; i < copies; i++) sellable.push({ ...entry });
  }
  return { sellable, connected };
}

async function liveHeldArchive(accountId, { host } = {}) {
  const acc = await BotAccount.findById(accountId, { clientSecret: 1, login: 1 }).lean();
  if (!acc || !acc.clientSecret) return null;
  const inv = await twitchInventory.fetchInventory(acc.clientSecret, { host });
  const { sellable, connected } = sellableDropsFromArchiveInv(inv);
  return { sellable, connected, login: (inv && inv.login) || acc.login || "" };
}

// Live stock behind a DropSet-backed listing: exactly the accounts a delivery
// would choose, then asked what they really still hold.
//
// The candidate list mirrors `claimAccountsForSet` in the fulfillers — the
// archive's own availability query, MINUS anything already attached to another
// marketplace's live listing, because handing that account over would ship the
// other listing's drops too.
async function archiveStockForSet(set, { max = ARCHIVE_SAMPLE, host } = {}) {
  const { availableAccountsForSet } = require("../routes/shopRoutes");
  let candidates = [];
  try {
    candidates = notListed(
      await availableAccountsForSet(set),
      await loginsOnActiveListings(),
    );
  } catch (e) {
    return { stock: [], candidates: 0, error: e.message };
  }
  const cap = Math.max(1, max);
  const sample = candidates.slice(0, cap);
  const read = await mapLimit(sample, READ_CONCURRENCY, async (c) => {
    const held = await liveHeldArchive(c.accountId, { host });
    return { c, held };
  });
  const stock = [];
  for (const r of read) {
    if (!r || r.error || !r.held) {
      stock.push({ row: r && r.c ? { login: r.c.login } : null, items: [], unreadable: true });
      continue;
    }
    stock.push({
      row: { login: r.held.login || r.c.login, accountId: String(r.c.accountId) },
      items: r.held.sellable,
      connected: r.held.connected,
      unreadable: false,
    });
  }
  return {
    stock,
    candidates: candidates.length,
    truncated: candidates.length > cap,
  };
}

// --- stock source 0: the units already fed to the platform ----------------
// A quantity listing (Digiseller content lines, GGSel units, an Eldorado
// reservation) is not backed by a pool at all — the accounts are already sitting
// on the platform waiting for a buyer, named in `units[]`. Those exact accounts
// ARE the stock, so they are what must be verified; judging such a listing
// against a pool would call it empty while 17 real units sit on sale.
//
// A unit points at its account in one of two ways: `accountId` for a Drop
// Archive account, or `contentId` carrying the no-claim ledger row id (that is
// how the unclaimed fulfillers stamp them). Both are resolved here, and each is
// read with ITS OWN sellability rule.
async function unitStock(listing, { max = ARCHIVE_SAMPLE, host } = {}) {
  const units = (listing.units || []).filter(
    (u) => !u.deliveredAt && (u.accountId || u.contentId || u.login),
  );
  const cap = Math.max(1, max);
  const sample = units.slice(0, cap);
  const read = await mapLimit(sample, READ_CONCURRENCY, async (u) => {
    // Resolve the LEDGER first, by login. `unit.accountId` is not one thing:
    // on an archive unit it is a BotAccount id, but on a no-claim unit it is the
    // POOL account id (AvailableAccount) — feeding that to BotAccount.findById
    // returns null, which read as "unreadable" and wrongly condemned three live
    // Call of Duty listings whose 17 units were fine.
    //
    // A login that is in the no-claim ledger is definitively a no-claim account,
    // so it must be judged by the no-claim rule (unclaimed inProgress), never the
    // archive one.
    let row = null;
    if (u.contentId && /^[0-9a-f]{24}$/i.test(String(u.contentId))) {
      row = await UnclaimedAccount.findById(u.contentId).lean();
    }
    if (!row && u.login) {
      row = await UnclaimedAccount.findOne({
        loginLower: String(u.login).toLowerCase(),
      }).lean();
    }
    if (row) return { u, items: await coverage.liveHeld(row) };

    // Not in the ledger: an archive account, by id then by login.
    if (u.accountId) {
      const held = await liveHeldArchive(u.accountId, { host }).catch(() => null);
      if (held) return { u, items: held.sellable };
    }
    if (!u.login) return { u, items: null };
    const acc = await BotAccount.findOne({ login: u.login }, { _id: 1 }).lean();
    if (!acc) return { u, items: null };
    const held = await liveHeldArchive(acc._id, { host }).catch(() => null);
    return { u, items: held ? held.sellable : null };
  });
  const stock = read.map((r) =>
    !r || r.error || !r.items
      ? { row: { login: (r && r.u && r.u.login) || "" }, items: [], unreadable: true }
      : { row: { login: r.u.login || "" }, items: r.items, unreadable: false },
  );
  return { stock, candidates: units.length, truncated: units.length > cap };
}

// --- stock source 3: the no-claim ledger, picked by SET -------------------
// The unclaimed auto-lister publishes gameflip/ggsel/digiseller rows that carry
// a DropSet but draw on the no-claim ledger, so they are judged against ledger
// rows for that set rather than the archive.
async function ledgerStockForSet(setId, { max = ARCHIVE_SAMPLE } = {}) {
  const q = {
    source: "noclaim",
    set: setId,
    status: { $in: SELLABLE_STATUSES },
    soldAt: null,
  };
  const total = await UnclaimedAccount.countDocuments(q);
  const rows = await UnclaimedAccount.find(q)
    .limit(Math.max(1, max))
    .lean();
  const read = await mapLimit(rows, READ_CONCURRENCY, async (row) => {
    const sellable = await coverage.liveHeld(row);
    return { row, sellable };
  });
  const stock = read.map((r) =>
    !r || r.error || !r.sellable
      ? { row: (r && r.row) || null, items: [], unreadable: true }
      : { row: r.row, items: r.sellable, unreadable: false },
  );
  return { stock, candidates: total, truncated: total > Math.max(1, max) };
}

// Which stock source a listing draws on. Getting this wrong judges a listing
// against a pool it never sells from, so it is decided on the row's own fields
// rather than inferred from its title.
function classify(listing, set) {
  if (FARM_TITLE.test(listing.title || "")) return "service";
  if (listing.unclaimedGame) return "ledger-game";
  if (!set || !(set.items || []).length) return "unauditable";
  if (listing.origin === "unclaimed") return "ledger-set";
  return "archive";
}

// The largest set of items that some group of accounts ALL still hold — i.e. the
// biggest bundle we could honestly advertise today, and how many accounts back
// it.
//
// Accounts of an event cohort hold identical inventories, so grouping by exact
// item signature finds the real cohorts rather than inventing an intersection no
// single account satisfies. Ties break toward the bigger bundle: with equal
// stock, more items is the better listing.
function dominantOffer(stock) {
  const groups = new Map();
  for (const s of stock) {
    if (s.unreadable || !s.items.length) continue;
    const names = s.items.map((i) => i.name).sort();
    const key = names.map(coverage.normName).join(" ");
    const g = groups.get(key) || { items: names, count: 0, logins: [] };
    g.count += 1;
    if (s.row) g.logins.push(s.row.login);
    groups.set(key, g);
  }
  const best = [...groups.values()].sort(
    (a, b) => b.count - a.count || b.items.length - a.items.length,
  )[0];
  return best || { items: [], count: 0, logins: [] };
}

// Collapse a cohort's item names into an advertised list with counts, which is
// what a listing declares and what the delivery gate checks against.
function itemsToRequired(names) {
  const counts = new Map();
  for (const n of names || []) {
    const key = String(n || "").trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].map(([name, qty]) => ({ name, qty }));
}

// Has the stock grown past what the listing advertises? A no-claim account keeps
// farming after it goes on sale, so an event's later waves land on accounts
// already listed under the earlier, smaller bundle — and the scan only
// re-groups RELEASED accounts, so a listed one never grows into the fuller
// listing on its own. `advertised` is the listing's item list ([{name, qty}] or
// bare names); `heldNames` is what the dominant cohort actually holds (the name
// array dominantOffer returns, duplicates preserved for copies).
//
// Returns the extra copies when the held set is a strict SUPERSET, else null.
// Count-aware on purpose: gaining a SECOND Esports Loot Box is a richer bundle
// even though the name was already there — two loot boxes is a different product
// from one, which a set-membership check would miss. A set that DROPPED an item
// is NOT richer (that is "stale", judged elsewhere), so it returns null.
function richerBundle(advertised, heldNames) {
  const req = coverage.requiredCounts(advertised || []);
  const have = coverage.requiredCounts(heldNames || []);
  if (!req.size || !have.size) return null;
  for (const [name, need] of req) if ((have.get(name) || 0) < need) return null;
  const added = [];
  for (const [name, has] of have) {
    const extra = has - (req.get(name) || 0);
    if (extra > 0) added.push({ name, qty: extra });
  }
  if (!added.length) return null;
  return {
    added,
    items: [...have.entries()].map(([name, qty]) => ({ name, qty })),
  };
}

// Compare a listing's advertised items against the biggest bundle its backing
// accounts still hold (`dominant` = a dominantOffer result, or null). Pure, so
// the caller decides where `dominant` comes from — the drift report feeds it the
// ledger `drops[]` the expiry pass refreshes each tick, so no live read is made.
//   ok        - advertised == what is held
//   rebundle  - held is a STRICT SUPERSET (new items farmed since publish)
//   relist    - held is MISSING an advertised item (a wave expired off them)
//   no-stock  - no listed account holds anything (sold out / fully expired)
//   unknown   - the listing never declared what it sells
function classifyDrift(advertised, dominant) {
  const req = coverage.requiredCounts(advertised || []);
  if (!req.size) return { verdict: "unknown", missing: [], added: [] };
  const heldNames = (dominant && dominant.items) || [];
  if (!heldNames.length) return { verdict: "no-stock", missing: [], added: [] };
  const missing = coverage.shortOf(coverage.requiredCounts(heldNames), req);
  if (missing.length) return { verdict: "relist", missing, added: [] };
  const richer = richerBundle(advertised, heldNames);
  if (richer)
    return { verdict: "rebundle", missing: [], added: richer.added, suggest: richer.items };
  return { verdict: "ok", missing: [], added: [] };
}

// --- per-listing verdict --------------------------------------------------

// What a listing claims to sell. `requiredDrops` is the declared contract; a
// DropSet is the fallback for rows published before it existed.
async function advertisedItems(listing) {
  if ((listing.requiredDrops || []).length) {
    return { items: listing.requiredDrops, source: "requiredDrops" };
  }
  if (listing.set) {
    const set = await DropSet.findById(listing.set).lean();
    if (set && (set.items || []).length) {
      return { items: setItemsToRequired(set), source: "dropSet" };
    }
  }
  return { items: [], source: "none" };
}

// A set's items as the listing's advertised list. A set item carries its copies
// in `qty` ("9× Esports Pack" is ONE item with qty 9) — counting item names
// alone read it as 1×, so every multi-copy listing looked under-advertised and
// was "rebundled" on its very first check.
function setItemsToRequired(set) {
  const counts = new Map();
  const names = new Map();
  for (const i of (set && set.items) || []) {
    const key = coverage.normName(i && i.name);
    if (!key) continue;
    const q = Math.max(1, Math.floor(Number(i.qty)) || 1);
    counts.set(key, (counts.get(key) || 0) + q);
    if (!names.has(key)) names.set(key, String(i.name).trim());
  }
  return [...counts.entries()].map(([key, qty]) => ({ name: names.get(key), qty }));
}

// One listing, judged against live stock.
//
//   ok       - enough accounts still hold everything it advertises
//   short    - some do, but fewer than the quantity on sale
//   stale    - NONE do, yet stock exists holding a different set (an expired
//              wave, almost always); `suggest` is what to sell instead
//   empty    - no sellable stock for this game at all
//   unknown  - the listing never declared what it sells, so nothing can be
//              checked; declare it and this becomes answerable
function judge(listing, advertised, stock, { truncated = false } = {}) {
  const req = coverage.requiredCounts(advertised.items);
  const readable = stock.filter((s) => !s.unreadable);
  const withItems = readable.filter((s) => s.items.length);
  const suggestion = dominantOffer(stock);

  if (!req.size) {
    return {
      verdict: "unknown",
      covering: 0,
      stock: withItems.length,
      unreadable: stock.length - readable.length,
      suggest: suggestion,
      missing: "",
    };
  }
  // Nothing could be read at all — a dead token, a host outage, an id that
  // resolved to nothing. That is NOT "no stock": it is no evidence, and calling
  // it empty would pause healthy listings on a Pi hiccup.
  if (!readable.length && stock.length) {
    return {
      verdict: "unreadable",
      covering: 0,
      stock: 0,
      unreadable: stock.length,
      suggest: suggestion,
      missing: "",
    };
  }
  const covering = [];
  const missLists = [];
  for (const s of readable) {
    const missing = coverage.shortOf(coverage.countLogNames(s.items), req);
    if (missing.length) missLists.push(missing);
    else covering.push(s);
  }
  const onSale = Math.max(0, parseInt(listing.qtyTarget, 10) || 0);
  let verdict = "ok";
  if (!covering.length) verdict = withItems.length ? "stale" : "empty";
  // "short" means the pool cannot cover the quantity on sale — a claim about a
  // COUNT, so it may only be made when the count is real. When stock was sampled
  // rather than read whole, `covering` is capped by the sample size and every
  // listing with a larger target would read short for no reason. A sample can
  // still prove the negative (nothing covers it), which is why "stale" is
  // unaffected.
  else if (onSale && covering.length < onSale && !truncated) verdict = "short";
  return {
    verdict,
    covering: covering.length,
    stock: withItems.length,
    unreadable: stock.length - readable.length,
    suggest: suggestion,
    missing: coverage.summarizeMissing(missLists),
  };
}

// Audit every active listing that draws on the no-claim farm for `game`.
// Live stock is read ONCE per game and shared, because the expensive part is
// Twitch, not the comparison.
async function auditGame(game, { refresh = false } = {}) {
  const stock = await liveStockForGame(game, { refresh });
  const listings = await MarketplaceListing.find({
    status: "active",
    unclaimedGame: gameFilter(game),
  }).lean();
  const out = [];
  for (const listing of listings) {
    const advertised = await advertisedItems(listing);
    const judged = judge(listing, advertised, stock);
    out.push({
      listing,
      advertised,
      ...judged,
      richer: richerBundle(advertised.items, (judged.suggest && judged.suggest.items) || []),
    });
  }
  return { game, stock, listings: out };
}

// Every no-claim game that has at least one active listing behind it.
async function auditAll({ refresh = false } = {}) {
  const games = await MarketplaceListing.distinct("unclaimedGame", {
    status: "active",
    unclaimedGame: { $nin: ["", null] },
  });
  const out = [];
  for (const game of games) out.push(await auditGame(game, { refresh }));
  return out;
}

// --- the whole shop, every stock source ----------------------------------

// The game a DropSet is about, for falling back to a game-wide ledger read.
function setGame(set) {
  if (!set) return "";
  if (set.coverGame) return set.coverGame;
  for (const i of set.items || []) if (i.game) return i.game;
  return "";
}

// Is this listing about a no-claim game at all? Judged from the set's items and
// the row's own game field, with the title as the last resort for rows whose set
// is missing.
function touchesNoClaimGame(listing, set) {
  const settings = require("./settings");
  const isNo = (g) => {
    try {
      return settings.isNoClaimGame(g);
    } catch {
      return false;
    }
  };
  if (listing.unclaimedGame && isNo(listing.unclaimedGame)) return true;
  const games = new Set();
  if (set) {
    if (set.coverGame) games.add(set.coverGame);
    for (const i of set.items || []) if (i.game) games.add(i.game);
  }
  if ([...games].some(isNo)) return true;
  return /overwatch|rainbow six|call of duty/i.test(listing.title || "");
}

// Audit every ACTIVE listing that sells no-claim-game drops, whichever pool it
// draws on.
//
// Stock is resolved ONCE per DropSet and shared: 61 archive listings sit on 33
// sets, so per-listing reads would multiply the Twitch traffic for an identical
// answer. `host` routes the GQL through the Pi like the scanners do.
async function auditShop({
  refresh = false,
  max = ARCHIVE_SAMPLE,
  host,
  marketplace = "",
  onProgress,
} = {}) {
  const listings = await MarketplaceListing.find({
    status: "active",
    ...(marketplace ? { marketplace } : {}),
  }).lean();
  const setIds = [...new Set(listings.map((l) => String(l.set || "")).filter(Boolean))];
  const sets = await DropSet.find({ _id: { $in: setIds } }).lean();
  const setById = new Map(sets.map((x) => [String(x._id), x]));

  const scoped = listings
    .map((l) => ({ listing: l, set: setById.get(String(l.set || "")) || null }))
    .filter((e) => touchesNoClaimGame(e.listing, e.set));

  const stockCache = new Map();
  const out = [];
  for (const { listing, set } of scoped) {
    const kind = classify(listing, set);
    if (kind === "service" || kind === "unauditable") {
      out.push({ listing, set, kind, verdict: kind, covering: 0, stock: 0, unreadable: 0, advertised: { items: [], source: "none" }, missing: "", suggest: { items: [], count: 0, logins: [] } });
      continue;
    }
    // Units are per-listing, so they get their own cache key and take priority:
    // the accounts already on the platform are what this listing will hand over.
    const hasUnits = (listing.units || []).some((u) => !u.deliveredAt);
    const key = hasUnits
      ? "units:" + String(listing._id)
      : kind + ":" + (kind === "ledger-game" ? listing.unclaimedGame : String(listing.set));
    if (!stockCache.has(key)) {
      if (onProgress) onProgress(key);
      let stock = [];
      let candidates = null;
      let truncated = false;
      let via = kind;
      if (hasUnits) {
        const r = await unitStock(listing, { max, host });
        stock = r.stock;
        candidates = r.candidates;
        truncated = r.truncated;
        via = "units already fed to the platform (" + r.candidates + ")";
      } else if (kind === "ledger-game") {
        stock = await liveStockForGame(listing.unclaimedGame, { refresh });
        candidates = stock.length;
      } else if (kind === "ledger-set") {
        const r = await ledgerStockForSet(listing.set, { max });
        stock = r.stock;
        candidates = r.candidates;
        truncated = r.truncated;
        // A set-scoped ledger query can come back empty for two very different
        // reasons: the accounts really are gone, or they were simply never
        // linked to THIS set. Falling back to the game's whole ledger tells the
        // two apart — and gives the operator the item list they could sell
        // instead, which "0 of 0" never would.
        if (!stock.length) {
          const game = setGame(set);
          if (game) {
            const gk = "ledger-game:" + game;
            if (!stockCache.has(gk)) {
              if (onProgress) onProgress(gk + " (fallback)");
              const gs = await liveStockForGame(game, { refresh });
              stockCache.set(gk, { stock: gs, candidates: gs.length, truncated: false, via: "ledger-game" });
            }
            const g = stockCache.get(gk);
            stock = g.stock;
            candidates = g.candidates;
            via = "ledger-set (no stock on this set; judged against the whole " + game + " ledger)";
          }
        }
      } else {
        const r = await archiveStockForSet(set, { max, host });
        stock = r.stock;
        candidates = r.candidates;
        truncated = r.truncated;
      }
      stockCache.set(key, { stock, candidates, truncated, via });
    }
    const { stock, candidates, truncated, via } = stockCache.get(key);
    const advertised = await advertisedItems(listing);
    const judged = judge(listing, advertised, stock, { truncated });
    out.push({
      listing,
      set,
      kind,
      via,
      candidates,
      truncated,
      advertised,
      ...judged,
      // A live-verified rebundle opportunity: the stock covers everything
      // advertised AND holds strictly more. Null unless so.
      richer: richerBundle(advertised.items, (judged.suggest && judged.suggest.items) || []),
    });
  }
  return out;
}

// --- report-only drift, no live reads -------------------------------------

// Every active auto-lister bundle (`origin: "unclaimed"` + a set), judged
// against the freshest inventory we have WITHOUT calling Twitch: the listed
// ledgers' `drops[]`, which `expirySalePass` rewrites from a live read every
// check tick (~10 min). That is what makes this cheap enough to hit on a button
// and safe to run hourly — it touches no marketplace and no Pi. For a definitive
// LIVE sweep, `auditShop` / `scripts/unclaimed-listing-audit.js --shop` remain
// the tools; this one answers "which listings are drifting" at a glance so the
// operator knows which ones to relist by hand.
//
// It is deliberately scoped to the engine's OWN rows: they are the ones that
// carry a fixed advertised bundle AND a pool of listed ledgers behind them. A
// claim-at-sale row (eldorado/PA, `unclaimedGame` only) advertises by game with
// no listed ledgers to compare, and the live `listings.stale` health check
// already watches those.
// The markets whose listings pre-attach their own accounts (per set+market).
// Claim-at-sale markets (eldorado/PA/g2g) advertise by GAME and pick at sale.
const VAULT_MARKETS = ["gameflip", "ggsel", "digiseller"];

// The fuller set to advertise that COMPLETES the events a listing already spans,
// and NEVER adds a new one — so a "Day 1 only" bundle is completed to all of
// Day 1, not inflated to Day 1 + Day 2. `advertised` is [{name,qty}] (the
// listing's contract); `held` is what the unit(s) a buyer would get hold, with
// each copy's campaign: raw drops (one entry per copy) or entries folded per
// name AND campaign ({name, campaign, qty}). Returns the target drops when
// strictly fuller within scope, else null. Pure + tested. Count-aware, so
// "3× Esports Pack" is a rebundle of "1×" when the copies come from the same
// campaign. Relies on drops[].campaign, which the no-claim scan populates.
//
// Scope is decided per COPY (owner, 2026-09-28). An advertised item whose held
// copies all come from ONE campaign names that campaign as one of the listing's
// events. An item that recurs across campaigns — a Rainbow Six "Esports Pack"
// from every "R6S S2 2026 N" wave, a loot box in both BlizzCon days — cannot say
// which copies were advertised, so it anchors nothing; its copies count only
// inside the events the other items name. The old rule folded every copy of a
// name into its first campaign, so each new R6 wave read as "more of the same
// event": 9× titles were raised to 12× and then over-advertised when the oldest
// wave expired.
function rebundleWithinScope(advertised, held) {
  const advCounts = coverage.requiredCounts(advertised || []);
  if (!advCounts.size || !(held || []).length) return null;
  const byName = new Map(); // name -> Map(campaign -> { qty, rep })
  for (const d of held) {
    const n = coverage.normName(d && d.name);
    if (!n) continue;
    const c = String((d && d.campaign) || "");
    const q = Number(d.qty) > 0 ? Math.floor(Number(d.qty)) : 1;
    if (!byName.has(n)) byName.set(n, new Map());
    const perCampaign = byName.get(n);
    const e = perCampaign.get(c) || { qty: 0, rep: d };
    e.qty += q;
    perCampaign.set(c, e);
  }
  // The events the listing already advertises. An advertised item the unit no
  // longer holds is an expired wave (a "relist" case), NOT a rebundle.
  const advCampaigns = new Set();
  for (const n of advCounts.keys()) {
    const perCampaign = byName.get(n);
    if (!perCampaign) return null;
    if (perCampaign.size !== 1) continue; // recurs across campaigns: no anchor
    const [c] = perCampaign.keys();
    if (!c) return null; // no campaign recorded: no evidence of scope
    advCampaigns.add(c);
  }
  if (!advCampaigns.size) return null;
  const inScope = new Map(); // name -> { qty, rep }
  for (const [n, perCampaign] of byName) {
    for (const [c, e] of perCampaign) {
      if (!advCampaigns.has(c)) continue;
      const cur = inScope.get(n) || { qty: 0, rep: e.rep };
      cur.qty += e.qty;
      inScope.set(n, cur);
    }
  }
  let advTotal = 0;
  for (const [n, q] of advCounts) {
    advTotal += q;
    if (((inScope.get(n) || {}).qty || 0) < q) return null; // can't cover it from inside its events
  }
  let heldTotal = 0;
  for (const e of inScope.values()) heldTotal += e.qty;
  if (heldTotal <= advTotal) return null; // no growth within the advertised events
  const target = [];
  for (const e of inScope.values()) {
    const rep = e.rep;
    target.push({ name: rep.name, game: rep.game, campaign: rep.campaign, itemKey: rep.itemKey || rep.name, qty: e.qty });
  }
  return target;
}

// What a listing's buyer would get, WITHOUT a live read (the ledger drops[] the
// expiry pass refreshes from Twitch every ~20-35 min), as drops that keep each
// copy's campaign ({name, campaign, qty, ...}):
//   - vault market + set -> the units the platform hands over (deliverableHeld).
//   - claim-at-sale + unclaimedGame -> the game's sellable pool (released/
//     skipped/listed), which is what a by-game order would pick from; its
//     delivery gate checks the listing's requiredDrops per account at sale.
async function heldUniqueForListing(listing, now = Date.now()) {
  if (VAULT_MARKETS.includes(listing.marketplace) && listing.set) {
    return deliverableHeld(listing, now);
  }
  if (!listing.unclaimedGame) return { held: [], count: 0 };
  const accounts = await UnclaimedAccount.find(
    { source: "noclaim", game: gameFilter(listing.unclaimedGame), status: { $in: ["released", "skipped", "listed"] }, soldAt: null },
    { login: 1, drops: 1 },
  ).lean();
  if (!accounts.length) return { held: [], count: 0 };
  const dom = dominantOffer(accounts.map((a) => ({ items: a.drops || [], unreadable: false, row: { login: a.login } })));
  const wantKeys = (dom.items || []).map(coverage.normName).sort().join("|");
  let rep = null;
  for (const a of accounts) {
    const k = (a.drops || []).map((d) => coverage.normName(d.name)).sort().join("|");
    if (k === wantKeys) { rep = a; break; }
  }
  const raw = (rep ? rep.drops : (dom.items || []).map((n) => ({ name: n }))) || [];
  return { held: intersectCopies([raw]), count: dom.count || 0 };
}

// A vault listing is sold from the accounts ALREADY attached to it, and the
// dominant cohort of the set's ledgers is not who the buyer gets (owner,
// 2026-09-28: on 09-24 a 9× Rainbow Six listing was raised to 12× because most
// of its set held 12, and the unit on sale held 9). So: a Gameflip row hands
// over exactly its live unit (accountLogin); a quantity row hands over ANY of
// its undelivered units, so only what every one of them holds counts. A unit
// with no listed ledger on this set+market, with a pending strike, or not read
// within HELD_FRESH_MS is no evidence, and nothing is returned (no rebundle).
const HELD_FRESH_MS = 45 * 60 * 1000;

async function deliverableHeld(listing, now = Date.now()) {
  const raw =
    listing.marketplace === "gameflip"
      ? [listing.accountLogin]
      : (listing.units || []).filter((u) => !u.deliveredAt).map((u) => u.login);
  const want = [...new Set(raw.map((l) => String(l || "").trim().toLowerCase()).filter(Boolean))];
  if (!want.length) return { held: [], count: 0 };
  const ledgers = await UnclaimedAccount.find(
    { source: "noclaim", set: listing.set, market: listing.marketplace, status: "listed", loginLower: { $in: want } },
    { loginLower: 1, drops: 1, lastCheckedAt: 1, emptyReads: 1 },
  ).lean();
  const trusted = ledgers.filter(
    (l) =>
      !(Number(l.emptyReads) > 0) &&
      l.lastCheckedAt &&
      now - new Date(l.lastCheckedAt).getTime() <= HELD_FRESH_MS,
  );
  if (trusted.length !== want.length) {
    return { held: [], count: 0, unverified: want.length - trusted.length };
  }
  return { held: intersectCopies(trusted.map((l) => l.drops || [])), count: trusted.length };
}

// The copies EVERY list holds, per item name and campaign (the minimum across
// the lists), folded to [{name, game, campaign, itemKey, qty}]. Pure + tested.
function intersectCopies(lists) {
  let acc = null;
  for (const list of lists || []) {
    const m = new Map();
    for (const d of list || []) {
      const n = coverage.normName(d && d.name);
      if (!n) continue;
      const k = n + "\u0000" + String((d && d.campaign) || "");
      const q = Number(d.qty) > 0 ? Math.floor(Number(d.qty)) : 1;
      const e = m.get(k) || { rep: d, qty: 0 };
      e.qty += q;
      m.set(k, e);
    }
    if (acc === null) {
      acc = m;
      continue;
    }
    for (const [k, e] of acc) {
      const other = m.get(k);
      if (!other) acc.delete(k);
      else e.qty = Math.min(e.qty, other.qty);
    }
  }
  return [...(acc || new Map()).values()].map((e) => ({
    name: e.rep.name,
    game: e.rep.game,
    campaign: String(e.rep.campaign || ""),
    itemKey: e.rep.itemKey || e.rep.name,
    qty: e.qty,
  }));
}

// --- exact mode: a vault listing says what its units hold -------------------
//
// Owner rule, 2026-10-06: "when there are more items to sell, why are we still
// on the wrong min set — and when items expire it should adjust as well."
//
// The campaign scope above (rebundleWithinScope) only ever completed the events
// a listing already named. Measured that day, 16 of the 18 vault listings
// advertised less than the account a buyer would get: a "(1 Item) — OL'
// CLANKER" Gameflip listing sold an account holding 12, every Overwatch row
// said 6 items for accounts holding 11. Two GGSel offers still advertised a
// Rainbow Six wave that had expired off all of their units.
//
// In exact mode the target is simply everything the deliverable unit(s) hold —
// for a quantity row, what EVERY undelivered unit holds (deliverableHeld) — in
// either direction:
//   grow   - they hold all that is advertised and more  -> verdict "rebundle"
//   shrink - an advertised item is gone or short        -> verdict "relist"
// Both carry `target`. What is safe to apply automatically differs by market
// and is decided in rebundleAll, not here.
//
// Why the 2026-09-28 worry (a 9× title raised to 12× and left there when the
// oldest wave expired) no longer holds: since that day the engine's check pass
// takes a Gameflip unit that is short of its row's promise off sale and relists
// it under what it holds (unclaimedAutoList.handleShortUnit), and refuses to
// attach a unit to a quantity row that promises more than it holds.
// Kill switch: autoFarm.unclaimedRebundleExact === false (back to the scope rule).
function exactEnabled() {
  try {
    return require("./settings").getAutoFarm().unclaimedRebundleExact !== false;
  } catch {
    return true;
  }
}

// Held copies folded by item name across campaigns, as drops a title can be
// built from: [{name, game, campaign, itemKey, qty}]. Pure + tested.
function foldHeldByName(held) {
  const byName = new Map();
  for (const d of held || []) {
    const n = coverage.normName(d && d.name);
    if (!n) continue;
    const q = Number(d.qty) > 0 ? Math.floor(Number(d.qty)) : 1;
    const e = byName.get(n);
    if (e) e.qty += q;
    else byName.set(n, { name: d.name, game: d.game, campaign: String(d.campaign || ""), itemKey: d.itemKey || d.name, qty: q });
  }
  return [...byName.values()];
}

// Exact-mode verdict for one listing. Pure + tested.
function exactVerdict(advertisedItems, held) {
  const req = coverage.requiredCounts(advertisedItems || []);
  if (!req.size) return { verdict: "unknown", added: [], missing: [] };
  if (!(held || []).length) return { verdict: "no-stock", added: [], missing: [] };
  // What the listing already names keeps its place; what is new follows.
  const order = [...req.keys()];
  const rank = (d) => {
    const i = order.indexOf(coverage.normName(d.name));
    return i === -1 ? order.length : i;
  };
  const target = foldHeldByName(held)
    .map((d, i) => ({ d, i }))
    .sort((a, b) => rank(a.d) - rank(b.d) || a.i - b.i)
    .map((x) => x.d);
  const heldCounts = new Map();
  for (const d of target) heldCounts.set(coverage.normName(d.name), d.qty);
  const missing = coverage.shortOf(heldCounts, req);
  const added = [];
  for (const d of target) {
    const extra = d.qty - (req.get(coverage.normName(d.name)) || 0);
    if (extra > 0) added.push({ name: d.name, qty: extra });
  }
  if (!missing.length && !added.length) return { verdict: "ok", added: [], missing: [] };
  return { verdict: missing.length ? "relist" : "rebundle", exact: true, target, added, missing };
}

// Held copies folded by name only, for display ("Esports Pack ×9").
function heldByNameLabel(held) {
  const counts = new Map();
  const names = new Map();
  for (const d of held || []) {
    const n = coverage.normName(d && d.name);
    if (!n) continue;
    counts.set(n, (counts.get(n) || 0) + (Number(d.qty) > 0 ? Math.floor(Number(d.qty)) : 1));
    if (!names.has(n)) names.set(n, d.name);
  }
  return [...counts.entries()].map(([n, q]) => (q > 1 ? names.get(n) + " ×" + q : names.get(n)));
}

// Per-listing drift verdict from held (uniqueDrops), campaign-scoped:
//   rebundle - a strictly fuller set WITHIN the advertised events (target set)
//   relist   - an advertised item the accounts no longer hold (expired wave)
//   no-stock - no backing accounts hold anything
//   unknown  - the listing declares no item list
//   ok       - advertised already matches what's held
function driftVerdict(advertisedItems, heldUnique, opts) {
  if (opts && opts.exact) return exactVerdict(advertisedItems, heldUnique);
  const req = coverage.requiredCounts(advertisedItems || []);
  if (!req.size) return { verdict: "unknown", added: [], missing: [] };
  if (!(heldUnique || []).length) return { verdict: "no-stock", added: [], missing: [] };
  const target = rebundleWithinScope(advertisedItems, heldUnique);
  if (target) {
    const added = [];
    for (const d of target) {
      const extra = (Number(d.qty) > 0 ? Number(d.qty) : 1) - (req.get(coverage.normName(d.name)) || 0);
      if (extra > 0) added.push({ name: d.name, qty: extra });
    }
    return { verdict: "rebundle", target, added, missing: [] };
  }
  const heldCounts = new Map();
  for (const d of heldUnique) {
    const n = coverage.normName(d.name);
    if (n) heldCounts.set(n, (heldCounts.get(n) || 0) + (Number(d.qty) > 0 ? Number(d.qty) : 1));
  }
  const missing = coverage.shortOf(heldCounts, req);
  return { verdict: missing.length ? "relist" : "ok", added: [], missing };
}

// Every active no-claim listing this can auto-fix or report on, judged WITHOUT a
// live read. Covers VAULT rows (origin:"unclaimed" set-backed on gameflip/ggsel/
// digiseller) AND claim-at-sale rows (eldorado/PA/g2g by unclaimedGame). The
// verdict is campaign-scoped, so a "Day 1 only" bundle is never inflated to a
// two-day one. For a definitive LIVE sweep, `auditShop` remains the tool.
async function listingDriftReport() {
  const listings = await MarketplaceListing.find({
    status: "active",
    $or: [
      { origin: "unclaimed", marketplace: { $in: VAULT_MARKETS }, set: { $exists: true, $ne: null } },
      { marketplace: { $in: ["eldorado", "playerauctions", "g2g"] }, unclaimedGame: { $nin: ["", null] } },
    ],
  })
    .sort({ updatedAt: -1 })
    .lean();
  if (!listings.length) return [];
  const out = [];
  for (const listing of listings) {
    const advertised = await advertisedItems(listing);
    const { held, count } = await heldUniqueForListing(listing);
    const exact = VAULT_MARKETS.includes(listing.marketplace) && exactEnabled();
    const v = driftVerdict(advertised.items, held, { exact });
    out.push({
      id: String(listing._id),
      marketplace: listing.marketplace,
      externalId: listing.externalId,
      url: listing.url || "",
      title: listing.title || "",
      price: Number(listing.price) || 0,
      backing: count,
      claimAtSale: !VAULT_MARKETS.includes(listing.marketplace),
      advertised: advertised.items,
      held: heldByNameLabel(held),
      heldCount: count,
      verdict: v.verdict,
      added: v.added || [],
      missing: v.missing || [],
      // Exact mode: the verdict carries what the listing should say instead.
      exact: !!v.exact,
      to: v.exact ? heldByNameLabel(v.target) : [],
    });
  }
  // Worst first so the operator sees what needs acting on at the top.
  const rank = { relist: 0, rebundle: 1, "no-stock": 2, unknown: 3, ok: 4 };
  out.sort((a, b) => (rank[a.verdict] ?? 9) - (rank[b.verdict] ?? 9));
  return out;
}

// --- rebundle apply: advertise the fuller set, SAME price ------------------

// The markets a rebundle can be applied to IN PLACE (reversible text edits,
// same price): gameflip (name/description patch), ggsel and eldorado (offer
// update that preserves price + quantity). digiseller has no text-edit API (a
// rebundle there is delist + republish, a new irreversible product id) and PA
// edits can knock an offer out of Active, so both are left for a deliberate
// step and never auto-touched.
const REBUNDLE_INPLACE_MARKETS = ["gameflip", "ggsel", "eldorado"];
// What the AUTOMATIC pass edits. Not GGSel (owner, 2026-09-28: GGSel paused;
// and a retitled GGSel offer keeps its smaller set, so any unit attached later
// would be sold as the fuller bundle) — the manual button can still ask for it.
const REBUNDLE_AUTO_MARKETS = ["gameflip", "eldorado"];
// GGSel is back (owner, 2026-10-01) and in exact mode its title follows what
// every undelivered unit holds, up and down; the engine no longer attaches a
// unit that holds less than the row promises. So the automatic pass edits it
// again while the GGSel switch is on.
function autoMarkets() {
  const out = REBUNDLE_AUTO_MARKETS.slice();
  try {
    if (exactEnabled() && require("./settings").getAutoFarm().ggselEnabled !== false) out.push("ggsel");
  } catch {
    /* settings unreadable: the two defaults */
  }
  return out;
}
// A listing whose advertised items its units no longer hold is retitled DOWN in
// place only where the row keeps its units (GGSel). A Gameflip unit short of
// its row is taken off sale and relisted by the engine itself
// (unclaimedAutoList.handleShortUnit) — two fixers on one listing would fight.
const SHRINK_INPLACE_MARKETS = ["ggsel"];
// A shrink is applied only when two passes at least this far apart agree on it
// (one partial inventory read must not rewrite a listing).
const SHRINK_CONFIRM_MS = 9 * 60 * 1000;
const shrinkSeen = new Map(); // listing id -> { sig, at }
// Edits per automatic pass: each Gameflip edit is an off-sale/on-sale cycle.
const AUTO_MAX_PER_PASS = 4;
// Never re-edit the same listing more than once an hour (flap guard for the
// automatic pass).
const REBUNDLE_COOLDOWN_MS = 60 * 60 * 1000;

// The campaign-scoped fuller set for one listing, as full drop objects so the
// title/description read like the auto-lister's own. `isRebundle` is false when
// the listing already matches its events (nothing to do). Built from the ledger
// drops[] the expiry pass refreshes each tick — no live read, no price change.
async function rebundlePlan(listing) {
  const ual = require("./unclaimedAutoList");
  const { held, count } = await heldUniqueForListing(listing);
  const advertised = await advertisedItems(listing);
  const exact = VAULT_MARKETS.includes(listing.marketplace) && exactEnabled();
  const ev = exact ? exactVerdict(advertised.items, held) : null;
  const target = exact ? ev.target || null : rebundleWithinScope(advertised.items, held);
  const set = listing.set ? await DropSet.findById(listing.set).lean() : null;
  const game =
    listing.unclaimedGame || setGame(set) || (held[0] && held[0].game) || "";
  const drops = target
    ? ual.uniqueDrops(target.map((d) => ({ ...d, game: d.game || game })))
    : [];
  // Exact mode names the events the bundle spans, as a fresh listing of the
  // same items would ("… OWCS Stage 3 + Reign of Talon COMPLETE BUNDLE (11 Items)").
  let cls = null;
  if (exact && target) {
    try {
      cls = await ual.classificationForSet({
        coverGame: game,
        items: drops.map((d) => ({ name: d.name, game: d.game || game, itemKey: d.itemKey, qty: d.qty || 1 })),
      });
    } catch {
      cls = null;
    }
  }
  return {
    isRebundle: !!target,
    exact,
    // "shrink" = an advertised item is gone; "grow" = everything advertised is
    // held, and more.
    kind: exact && ev.verdict === "relist" ? "shrink" : "grow",
    drops,
    game,
    backing: count,
    title: target ? ual.listingTitle(game, drops, cls) : "",
    description: target ? ual.listingDescription(game, drops, listing.marketplace, cls) : "",
    requiredDrops: drops.map((d) => ({ name: d.name, qty: d.qty || 1 })),
    advertised: advertised.items,
  };
}

// Apply the rebundle to ONE listing at its CURRENT price (no reprice: the
// marketplace primitives are called with no price field, so they leave it
// alone). Reversible where it acts; digiseller is never touched here.
async function applyRebundle(listing, { dryRun = true } = {}) {
  const mp = require("./marketplaces");
  const plan = await rebundlePlan(listing);
  const rec = {
    id: String(listing._id),
    marketplace: listing.marketplace,
    externalId: listing.externalId,
    price: Number(listing.price) || 0,
    verdict: plan.verdict,
    fromItems: plan.advertised,
    toItems: plan.requiredDrops,
    newTitle: plan.title,
    applied: false,
    action: "",
    note: "",
  };
  if (!plan.isRebundle || !plan.requiredDrops.length) {
    rec.action = "skip";
    rec.note = "not a rebundle (already matches its events, or nothing fuller in scope)";
    return rec;
  }
  if (!REBUNDLE_INPLACE_MARKETS.includes(listing.marketplace)) {
    rec.action = "needs-attention";
    rec.note =
      listing.marketplace +
      " has no safe in-place edit (digiseller = delist+republish/irreversible; PA can drop Active) — handled separately";
    return rec;
  }
  rec.kind = plan.kind;
  if (plan.kind === "shrink" && !SHRINK_INPLACE_MARKETS.includes(listing.marketplace)) {
    rec.action = "skip";
    rec.note =
      listing.marketplace === "gameflip"
        ? "an advertised item expired — the engine takes this unit off sale and relists it with what it holds"
        : "an advertised item expired — no in-place fix on " + listing.marketplace;
    return rec;
  }
  rec.action = "retitle-in-place";
  if (dryRun) {
    rec.note = "dry run — would retitle at $" + rec.price + " (unchanged)";
    return rec;
  }
  // A Gameflip row sells exactly one account: read it live (one GQL call) and
  // raise the title only if what it holds right now gives the same bundle.
  if (listing.marketplace === "gameflip") {
    const live = await confirmLiveUnit(listing, plan);
    if (!live.ok) {
      rec.action = "skip";
      rec.note = "not retitled — the account on sale did not confirm it live (" + live.why + ")";
      return rec;
    }
  }
  // SAME PRICE: no price field passed, so each primitive leaves price (and
  // eldorado quantity) alone.
  if (listing.marketplace === "gameflip") {
    // The cover goes with the text (same off-sale window): a picture of the old
    // bundle under the new title is the complaint this exists to end. A cover
    // that cannot be built never blocks the text.
    const cover = plan.exact ? await coverForPlan(listing, plan) : "";
    try {
      await mp.gameflipReprice(listing.externalId, {
        title: plan.title,
        description: plan.description,
        ...(cover ? { imagePath: cover } : {}),
      });
    } finally {
      if (cover) require("fs").promises.unlink(cover).catch(() => {});
    }
  } else if (listing.marketplace === "ggsel") {
    await mp.ggselUpdateOffer(listing.externalId, { title: plan.title, description: plan.description });
  } else if (listing.marketplace === "eldorado") {
    await mp.eldoradoUpdateOffer(listing.externalId, { title: plan.title, description: plan.description });
  }
  await MarketplaceListing.updateOne(
    { _id: listing._id },
    { $set: { title: plan.title, description: plan.description, requiredDrops: plan.requiredDrops, rebundledAt: new Date(), lastError: "" } },
  );
  rec.applied = true;
  rec.note = "retitled at $" + rec.price + " (price unchanged)";
  return rec;
}

// Live check of the ONE account a Gameflip row sells before its title goes up:
// its current holdings must yield exactly the planned bundle. Any doubt (no
// listed ledger, unreadable inventory, a different bundle) is a no.
async function confirmLiveUnit(listing, plan) {
  const ual = require("./unclaimedAutoList");
  const login = String(listing.accountLogin || "").trim().toLowerCase();
  if (!login) return { ok: false, why: "no live unit" };
  const ledger = await UnclaimedAccount.findOne({
    source: "noclaim",
    set: listing.set,
    market: "gameflip",
    status: "listed",
    loginLower: login,
  }).lean();
  if (!ledger) return { ok: false, why: "no listed ledger" };
  let sellable = null;
  try {
    const cand = await ual.candForLedger(ledger);
    if (cand) sellable = ((await ual.inventoryForCandidate(cand)) || {}).sellable || null;
  } catch {
    sellable = null;
  }
  if (!sellable) return { ok: false, why: "unreadable" };
  const drops = ual.pickListingGroup(ledger.game, sellable).drops;
  if (plan.exact) {
    // Right now the account must hold exactly what the title is about to say.
    const v = exactVerdict(plan.requiredDrops, drops);
    return v.verdict === "ok" ? { ok: true } : { ok: false, why: "live holdings differ from the planned bundle" };
  }
  const target = rebundleWithinScope(plan.advertised, drops);
  if (!target) return { ok: false, why: "live holdings are not a fuller bundle" };
  const want = coverage.requiredCounts(plan.requiredDrops);
  const got = coverage.requiredCounts(target);
  if (want.size !== got.size) return { ok: false, why: "live bundle differs" };
  for (const [k, q] of want) if (got.get(k) !== q) return { ok: false, why: "live bundle differs" };
  return { ok: true };
}

// The grid cover for a planned bundle; "" when it cannot be built. Ledger drops
// carry no picture, so each item's comes from the account's own holdings
// snapshot (NoclaimHolding, the picture Twitch gave for that very drop), then
// from the listing's set.
async function coverForPlan(listing, plan) {
  try {
    const images = new Map();
    const take = (name, image) => {
      const k = coverage.normName(name);
      if (k && image && !images.has(k)) images.set(k, String(image));
    };
    const login = String(listing.accountLogin || "").trim().toLowerCase();
    if (login) {
      const h = await require("../models/NoclaimHolding")
        .findOne({ loginLower: login }, { "items.name": 1, "items.image": 1 })
        .lean();
      for (const it of (h && h.items) || []) take(it.name, it.image);
    }
    const set = listing.set ? await DropSet.findById(listing.set, { "items.name": 1, "items.image": 1 }).lean() : null;
    for (const it of (set && set.items) || []) take(it.name, it.image);
    const items = (plan.drops || []).map((d) => ({
      name: d.name,
      game: d.game || plan.game,
      image: images.get(coverage.normName(d.name)) || "",
      qty: d.qty || 1,
    }));
    if (!items.length) return "";
    return (await require("./setImage").buildSetGridImage({ items }, { showTotal: true })) || "";
  } catch {
    return "";
  }
}

// Drive the whole shop's rebundle fixes, serially (Gameflip's edit cycles the
// listing off-sale and its limiter 429s on bursts, so paced). `markets` scopes
// which to touch — default the two in-place ones. Returns a change report.
async function rebundleAll({ dryRun = true, markets = null, auto = false, pauseMs = 8000 } = {}) {
  const scope =
    Array.isArray(markets) && markets.length
      ? markets
      : auto
        ? autoMarkets()
        : REBUNDLE_INPLACE_MARKETS;
  const rows = await listingDriftReport();
  // Exact mode adds the shrink case; listings that over-advertise go first.
  const targets = rows.filter((r) => r.verdict === "rebundle" || (r.exact && r.verdict === "relist"));
  const out = [];
  let appliedCount = 0;
  const liveIds = new Set(targets.map((t) => t.id));
  for (const id of [...shrinkSeen.keys()]) if (!liveIds.has(id)) shrinkSeen.delete(id);
  for (const t of targets) {
    if (auto && !dryRun && appliedCount >= AUTO_MAX_PER_PASS) {
      out.push({ id: t.id, marketplace: t.marketplace, externalId: t.externalId, action: "skip", applied: false, note: "left for the next pass" });
      continue;
    }
    if (t.verdict === "relist") {
      if (!SHRINK_INPLACE_MARKETS.includes(t.marketplace)) continue; // the engine's own job
      if (auto && !dryRun) {
        const sig = JSON.stringify(t.to);
        const seen = shrinkSeen.get(t.id);
        if (!seen || seen.sig !== sig) {
          shrinkSeen.set(t.id, { sig, at: Date.now() });
          out.push({ id: t.id, marketplace: t.marketplace, externalId: t.externalId, action: "skip", applied: false, note: "an advertised item is gone — confirming on the next pass" });
          continue;
        }
        if (Date.now() - seen.at < SHRINK_CONFIRM_MS) {
          out.push({ id: t.id, marketplace: t.marketplace, externalId: t.externalId, action: "skip", applied: false, note: "an advertised item is gone — confirming on the next pass" });
          continue;
        }
      }
    }
    if (!scope.includes(t.marketplace)) {
      const safe = REBUNDLE_INPLACE_MARKETS.includes(t.marketplace);
      out.push({
        id: t.id,
        marketplace: t.marketplace,
        externalId: t.externalId,
        action: safe ? "skip" : "needs-attention",
        applied: false,
        note: safe ? "market not in scope" : t.marketplace + " needs manual handling (no safe in-place edit / blocked)",
      });
      continue;
    }
    const listing = await MarketplaceListing.findById(t.id).lean();
    if (!listing) {
      out.push({ id: t.id, marketplace: t.marketplace, action: "skip", applied: false, note: "listing gone" });
      continue;
    }
    // Automatic pass: never re-edit a listing we touched in the last hour, so a
    // noisy read can't put a listing into an off-sale/on-sale loop. A shrink is
    // exempt: it has its own two-pass confirmation, and a listing that promises
    // what its units no longer hold must not wait an hour.
    if (auto && !dryRun && t.verdict !== "relist" && listing.rebundledAt && Date.now() - new Date(listing.rebundledAt).getTime() < REBUNDLE_COOLDOWN_MS) {
      out.push({ id: t.id, marketplace: t.marketplace, externalId: t.externalId, action: "skip", applied: false, note: "cooldown (rebundled within the hour)" });
      continue;
    }
    let rec;
    try {
      rec = await applyRebundle(listing, { dryRun });
    } catch (e) {
      rec = { id: t.id, marketplace: t.marketplace, externalId: t.externalId, action: "error", applied: false, note: (e && e.message) || String(e) };
    }
    out.push(rec);
    if (rec.applied) {
      appliedCount++;
      shrinkSeen.delete(t.id);
    }
    // Pace real Gameflip writes: each is an off-sale/patch/on-sale cycle behind
    // a minutes-wide rate limiter.
    if (!dryRun && rec.applied && listing.marketplace === "gameflip") {
      await new Promise((r) => setTimeout(r, Math.max(0, pauseMs)));
    }
  }
  return out;
}

// --- the fix --------------------------------------------------------------

// Push the honest number onto the platform, and take the offer down when that
// number is zero. Text is NOT rewritten here: correcting an item list changes
// what the listing promises, which is the operator's call, so the audit reports
// the suggestion and the script's --retitle applies it.
// How many live offers draw on the SAME ledger. Every listing for a game shares
// one pool of accounts — the Eldorado and PlayerAuctions copies of a bundle are
// two shop windows onto the same eleven accounts — so advertising the full count
// on each promises the pool twice over. Splitting it is the honest number, and
// it is the same rule the PlayerAuctions fulfiller already applies within its
// own marketplace, widened to all of them.
async function sharersForGame(game) {
  try {
    const n = await MarketplaceListing.countDocuments({
      status: "active",
      autoPaused: { $ne: true },
      unclaimedGame: gameFilter(game),
    });
    return Math.max(1, n);
  } catch {
    // Never let a bookkeeping lookup inflate stock: falling back to "one
    // listing" would advertise MORE, so fall back to what we were asked about.
    return 1;
  }
}

async function applyStock(entry, { dryRun = true } = {}) {
  const mp = require("./marketplaces");
  const { listing, covering, verdict } = entry;
  const id = listing.externalId;
  const actions = [];

  const setQty = {
    eldorado: (n) => mp.eldoradoSetQuantity(id, n),
    playerauctions: (n) => mp.playerauctionsSetQuantity(id, n),
    g2g: (n) => mp.g2gSetQuantity(id, n),
  }[listing.marketplace];
  // Taking an unsellable offer DOWN is possible on every marketplace this
  // engine publishes to, and it is the half that matters: a listing whose
  // advertised items no longer exist is a promise we cannot keep, whatever its
  // quantity says. Only Eldorado and PlayerAuctions carry a quantity API — and
  // neither is in settings.UNCLAIMED_MARKETS — so gating the whole function on
  // `setQty` below meant the three markets that DO carry unclaimed stock
  // (gameflip, digiseller, ggsel) could never be paused. Four Overwatch
  // listings sat on sale for days advertising drops that had expired off every
  // account, the dearest at $6.25 against an all-time realised max of $4.50.
  // Every entry here is reversible: draft on Gameflip, pause on GGSel/Eldorado,
  // hidden on ZeusX/PlayerAuctions, delisted (not deleted) on G2G.
  const pause = {
    eldorado: () => mp.eldoradoDelist(id),
    playerauctions: () => mp.playerauctionsHide(id),
    gameflip: () => mp.gameflipDelist(id),
    digiseller: () => mp.digisellerDelist(id),
    ggsel: () => mp.ggselDelist(id),
    zeusx: () => mp.zeusxDelist(id),
    g2g: () => mp.g2gDelist(id),
    // Markets with no delist API fall through to a manual note.
  }[listing.marketplace];

  if (covering <= 0 && (verdict === "stale" || verdict === "empty")) {
    if (!pause) {
      // Say so out loud. Silently returning "nothing to do" here is how the
      // Gameflip rows stayed up: a listing that cannot be paused automatically
      // still has to reach the operator, because it is still selling.
      return [
        {
          note:
            "MANUAL: no delist API for " + listing.marketplace + " — " +
            verdict + ", take it down by hand (" + id + ")",
        },
      ];
    }
    actions.push("pause (" + verdict + ": nothing on sale is still claimable)");
    if (!dryRun) {
      await pause().catch((e) => actions.push("pause failed: " + e.message));
      await MarketplaceListing.updateOne(
        { _id: listing._id },
        {
          $set: {
            autoPaused: true,
            lastError:
              "paused: advertised items are no longer claimable on any account",
          },
        },
      ).catch(() => {});
      // ...and let go of the accounts, or the engine puts the listing straight
      // back. `repairGameflipChains` republishes any set that has ledger rows
      // marked "listed" but no active row — from the SET, with no coverage
      // check at all. Measured 2026-09-08: six stale Overwatch/CoD/R6 rows were
      // paused at 17:52 and all six were live again by 17:58, same sets, same
      // prices, new listing ids. Pausing alone is not a fix, it is a five-minute
      // pause.
      //
      // "released" rather than "removed": these accounts are still perfectly
      // good stock, they simply do not hold what THIS listing promised. It is in
      // SELLABLE_STATUSES, so the scan pass re-reads them live and re-lists them
      // under the signature of what they ACTUALLY hold — which is how the honest
      // 6-item Finals bundle came to exist alongside the stale 10-item one.
      const freed = await UnclaimedAccount.updateMany(
        {
          set: listing.set,
          market: listing.marketplace,
          status: "listed",
        },
        {
          $set: {
            status: "released",
            note:
              "released by the listing audit: the set's items are no longer " +
              "claimable, so this account is re-listed under what it really holds",
          },
        },
      ).catch(() => null);
      const n = freed ? freed.modifiedCount || freed.nModified || 0 : 0;
      if (n) {
        actions.push(
          "released " + n + " ledger account(s) so the chain repair cannot " +
            "republish this set",
        );
      }
    }
    return actions;
  }
  // Only the quantity half needs a quantity API. Reaching this guard AFTER the
  // pause branch is the whole point: an unsellable Gameflip row must come down
  // even though Gameflip has no per-offer quantity to correct.
  if (!setQty) return [{ note: "no quantity API for " + listing.marketplace }];
  if (covering > 0) {
    const sharers = await sharersForGame(listing.unclaimedGame);
    const share = sharers > 1 ? Math.floor(covering / sharers) : covering;
    if (share < 1) {
      // More shop windows than accounts: leave the quantity alone rather than
      // set 0, which on some platforms reads as "delisted" rather than "one
      // left". The operator can pause the surplus listings.
      actions.push(
        "not enough stock to split " + covering + " across " + sharers +
          " live listing(s) — left as is",
      );
      return actions;
    }
    actions.push(
      "quantity to " + share +
        (sharers > 1 ? " (" + covering + " split across " + sharers + " listings)" : ""),
    );
    if (!dryRun) {
      await setQty(share).catch((e) =>
        actions.push("quantity failed: " + e.message),
      );
    }
  }
  return actions;
}

module.exports = {
  SELLABLE_STATUSES,
  ARCHIVE_SAMPLE,
  gameFilter,
  classify,
  sellableDropsFromArchiveInv,
  liveHeldArchive,
  archiveStockForSet,
  unitStock,
  ledgerStockForSet,
  liveStockForGame,
  dominantOffer,
  itemsToRequired,
  richerBundle,
  classifyDrift,
  rebundleWithinScope,
  driftVerdict,
  heldUniqueForListing,
  deliverableHeld,
  intersectCopies,
  setItemsToRequired,
  HELD_FRESH_MS,
  REBUNDLE_AUTO_MARKETS,
  autoMarkets,
  SHRINK_INPLACE_MARKETS,
  exactEnabled,
  foldHeldByName,
  exactVerdict,
  coverForPlan,
  listingDriftReport,
  VAULT_MARKETS,
  REBUNDLE_INPLACE_MARKETS,
  REBUNDLE_COOLDOWN_MS,
  rebundlePlan,
  applyRebundle,
  rebundleAll,
  advertisedItems,
  judge,
  sharersForGame,
  auditGame,
  auditAll,
  auditShop,
  touchesNoClaimGame,
  setGame,
  applyStock,
};
