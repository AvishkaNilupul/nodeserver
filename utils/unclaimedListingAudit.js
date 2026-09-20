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
      return {
        items: itemsToRequired((set.items || []).map((i) => i.name)),
        source: "dropSet",
      };
    }
  }
  return { items: [], source: "none" };
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
// listing's contract); `heldUnique` is what the fulfilling accounts hold, as
// uniqueDrops ([{name,qty,campaign,...}]). Returns the target drops when
// strictly fuller within scope, else null. Pure + tested. Count-aware, so
// "9× Esports Pack" is a rebundle of "1×" (same event, more copies). Relies on
// drops[].campaign, which the no-claim scan populates 100%.
function rebundleWithinScope(advertised, heldUnique) {
  const advCounts = coverage.requiredCounts(advertised || []);
  if (!advCounts.size || !(heldUnique || []).length) return null;
  const nameCampaign = new Map();
  for (const d of heldUnique) {
    const n = coverage.normName(d.name);
    if (n && d.campaign) nameCampaign.set(n, String(d.campaign));
  }
  // The events the listing already advertises. An advertised item the accounts
  // no longer hold is an expired wave (a "relist" case), NOT a rebundle.
  const advCampaigns = new Set();
  for (const n of advCounts.keys()) {
    const c = nameCampaign.get(n);
    if (!c) return null;
    advCampaigns.add(c);
  }
  const inScope = heldUnique.filter((d) => advCampaigns.has(String(d.campaign || "")));
  const heldCounts = new Map();
  const repByName = new Map();
  for (const d of inScope) {
    const n = coverage.normName(d.name);
    if (!n) continue;
    heldCounts.set(n, (heldCounts.get(n) || 0) + (Number(d.qty) > 0 ? Number(d.qty) : 1));
    if (!repByName.has(n)) repByName.set(n, d);
  }
  let advTotal = 0;
  for (const [n, q] of advCounts) {
    advTotal += q;
    if ((heldCounts.get(n) || 0) < q) return null; // can't cover what it advertises
  }
  let heldTotal = 0;
  for (const q of heldCounts.values()) heldTotal += q;
  if (heldTotal <= advTotal) return null; // no growth within the advertised events
  const target = [];
  for (const [n, q] of heldCounts) {
    const rep = repByName.get(n);
    target.push({ name: rep.name, game: rep.game, campaign: rep.campaign, itemKey: rep.itemKey || rep.name, qty: q });
  }
  return target;
}

// What a listing's fulfilling accounts hold, as uniqueDrops, WITHOUT a live read
// (the ledger drops[] the expiry pass refreshes each tick):
//   - vault market + set        -> its own listed ledgers (set+market).
//   - claim-at-sale + unclaimedGame -> the game's sellable pool (released/
//     skipped/listed), which is what a by-game order would pick from.
async function heldUniqueForListing(listing) {
  const ual = require("./unclaimedAutoList");
  let accounts = [];
  if (VAULT_MARKETS.includes(listing.marketplace) && listing.set) {
    accounts = await UnclaimedAccount.find(
      { source: "noclaim", set: listing.set, market: listing.marketplace, status: "listed" },
      { login: 1, drops: 1 },
    ).lean();
  } else if (listing.unclaimedGame) {
    accounts = await UnclaimedAccount.find(
      { source: "noclaim", game: gameFilter(listing.unclaimedGame), status: { $in: ["released", "skipped", "listed"] }, soldAt: null },
      { login: 1, drops: 1 },
    ).lean();
  }
  if (!accounts.length) return { held: [], count: 0 };
  const dom = dominantOffer(accounts.map((a) => ({ items: a.drops || [], unreadable: false, row: { login: a.login } })));
  const wantKeys = (dom.items || []).map(coverage.normName).sort().join("|");
  let rep = null;
  for (const a of accounts) {
    const k = (a.drops || []).map((d) => coverage.normName(d.name)).sort().join("|");
    if (k === wantKeys) { rep = a; break; }
  }
  const raw = (rep ? rep.drops : (dom.items || []).map((n) => ({ name: n }))) || [];
  return { held: ual.uniqueDrops(raw), count: dom.count || 0 };
}

// Per-listing drift verdict from held (uniqueDrops), campaign-scoped:
//   rebundle - a strictly fuller set WITHIN the advertised events (target set)
//   relist   - an advertised item the accounts no longer hold (expired wave)
//   no-stock - no backing accounts hold anything
//   unknown  - the listing declares no item list
//   ok       - advertised already matches what's held
function driftVerdict(advertisedItems, heldUnique) {
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
    const v = driftVerdict(advertised.items, held);
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
      held: held.map((d) => (Number(d.qty) > 1 ? d.name + " ×" + d.qty : d.name)),
      heldCount: count,
      verdict: v.verdict,
      added: v.added || [],
      missing: v.missing || [],
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
  const target = rebundleWithinScope(advertised.items, held);
  const set = listing.set ? await DropSet.findById(listing.set).lean() : null;
  const game =
    listing.unclaimedGame || setGame(set) || (held[0] && held[0].game) || "";
  const drops = target
    ? ual.uniqueDrops(target.map((d) => ({ ...d, game: d.game || game })))
    : [];
  return {
    isRebundle: !!target,
    game,
    backing: count,
    title: target ? ual.listingTitle(game, drops, null) : "",
    description: target ? ual.listingDescription(game, drops, listing.marketplace, null) : "",
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
  rec.action = "retitle-in-place";
  if (dryRun) {
    rec.note = "dry run — would retitle at $" + rec.price + " (unchanged)";
    return rec;
  }
  // SAME PRICE: no price field passed, so each primitive leaves price (and
  // eldorado quantity) alone.
  if (listing.marketplace === "gameflip") {
    await mp.gameflipReprice(listing.externalId, { title: plan.title, description: plan.description });
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

// Drive the whole shop's rebundle fixes, serially (Gameflip's edit cycles the
// listing off-sale and its limiter 429s on bursts, so paced). `markets` scopes
// which to touch — default the two in-place ones. Returns a change report.
async function rebundleAll({ dryRun = true, markets = null, auto = false, pauseMs = 8000 } = {}) {
  const scope = Array.isArray(markets) && markets.length ? markets : REBUNDLE_INPLACE_MARKETS;
  const rows = await listingDriftReport();
  const targets = rows.filter((r) => r.verdict === "rebundle");
  const out = [];
  for (const t of targets) {
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
    // noisy read can't put a listing into an off-sale/on-sale loop.
    if (auto && !dryRun && listing.rebundledAt && Date.now() - new Date(listing.rebundledAt).getTime() < REBUNDLE_COOLDOWN_MS) {
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
