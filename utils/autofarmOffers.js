// ---------------------------------------------------------------------------
// AUTO-FARM UNCLAIMED STOCK — putting it on sale
// (docs/UNCLAIMED-SELLING-PLAN.md; switch autoFarm.autofarmOffers, default OFF)
//
// utils/autofarmStock.js makes an auto-farm account's finished, unclaimed drops
// stock the claim layer can sell. Nothing sold it until someone made an offer
// by hand — and this stock is gone seven days after its campaign ends.
//
// Each maintenance pass (utils/noclaimListings.runPass, inside the server, so
// every marketplace call uses the live session) this looks at what the free,
// freshly read auto-farm accounts hold and publishes ONE claim-at-sale Eldorado
// offer for a bundle that is on no shelf yet — through the same
// noclaimListings.publishNoclaim the Listings page calls. An account is only
// taken when a buyer pays. From then on the offer is an ordinary no-claim
// offer: the stock sync counts it, the grow and rotation passes keep its text
// in step with the accounts, the Listings page delists it.
//
// The rules, in the order they are applied:
//
//   0. Nothing is listed unless Eldorado orders are really being delivered
//      (autoFarm.eldoradoAutoDeliver on, its dry-run off) — an offer nobody
//      hands over is a paid order waiting.
//   1. A game a no-claim BOT farms (the owner's no-claim list, or a game the
//      bots hold) is left alone. Those offers and their prices are the
//      owner's; an auto-farm account holding the same bundle already counts as
//      their stock.
//   2. An account that can deliver the set of ANY live claim-at-sale no-claim
//      offer — whatever the game or market — is on a shelf already, and is
//      never the base of a second one.
//   3. The bundle is the fullest one at least `minHolders` of the other
//      accounts hold in full, built from copies that outlast the bundle lead.
//      It is refused when an account that IS on a shelf holds it too: the
//      stock sync would count that account on both offers, and the layer only
//      splits a shelf between offers of the SAME set. (So accounts that
//      stopped part-way wait until the fuller offer has sold.)
//   4. It is listed once it is FINISHED: every account that can deliver it
//      has nothing left to earn for the game (the sweep stores that with each
//      read), or its campaigns have ended, or — when neither is known — it has
//      not changed for `settleHours`. An offer keeps the price it was made
//      with, so one made while the accounts are still earning would sell the
//      finished bundle at the price of its first drop. And while a campaign
//      runs, accounts part-way to a bundle that is already on sale wait for it.
//   5. A bundle that has, or ever had, an Eldorado no-claim offer is never
//      listed again, and a game whose offer was taken down in the last two
//      weeks is left to the owner: a delisted offer stays delisted, in any
//      shape.
//   6. A paused offer of the game that the rotation can bring back on this
//      bundle is the rotation's to bring back.
//   7. A few offers a pass and a day; an hour's rest for a game whose publish
//      failed, three tries a day. A publish that may have gone live without
//      a row (a timeout, a 5xx, a row that could not be saved) is never tried
//      again by itself: its set is kept as the record and the owner is told.
// ---------------------------------------------------------------------------
const settings = require("./settings");

const HOUR_MS = 60 * 60 * 1000;
const FARM = "autofarm";
const SET_NOTE = "auto-farm unclaimed stock";
const MARKET = "eldorado";
// Eldorado cuts a title at 160; the house titles stop at 120.
const TITLE_MAX = 150;
const DESCRIPTION_MAX = 2000;
// How far back an identical set is looked for (rule 5, and set reuse).
const SAME_SET_MS = 60 * 24 * HOUR_MS;
const RETRY_AFTER_MS = HOUR_MS;
const MAX_TRIES_PER_DAY = 3;
// No-claim bot accounts holding a game's drops before the game counts as theirs.
const FLEET_GAME_MIN = 3;
// How long a game is left alone after one of its offers was taken down.
const DELIST_REST_MS = 14 * 24 * HOUR_MS;
// Written into the note of a set whose publish may be live without a row. It
// is what rule 5 reads, so it outlives a restart.
const HOLD_MARK = " — HOLD: ";
// noclaimListings.writeMaybeLanded's rule, on the text publishNoclaim hands
// back: the create call itself answered 5xx, or never answered.
const MAYBE_LANDED_RE =
  /^Eldorado publish failed.*(\(HTTP 5\d\d\)|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNABORTED|socket hang up|network)/i;
const ORPHAN_RE = /row could not be saved/i;

const lower = (s) => String(s || "").trim().toLowerCase();
const str = (v) => (v == null ? "" : String(v));

function clampNum(v, d, lo, hi) {
  if (v == null || (typeof v === "string" && !v.trim())) return d;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
}

function cfg() {
  let af = null;
  try {
    if (typeof settings.getAutoFarm === "function") af = settings.getAutoFarm();
  } catch (e) {
    console.error("autofarmOffers: auto-farm settings unreadable:", e && e.message);
  }
  af = af && typeof af === "object" ? af : {};
  const minPrice = clampNum(af.autofarmOfferMinPrice, 0.99, 0.5, 5);
  return {
    on: af.autofarmOffers === true,
    // Rule 0 — the two switches utils/eldoradoFulfiller reads before it looks
    // at a single order (and utils/bulkPacks refuses on).
    eldoradoOn: af.eldoradoAutoDeliver === true && af.eldoradoDeliverDryRun === false,
    rotateOn: af.noclaimRotateOffers !== false,
    // A bundle is offered once this many free accounts can deliver it.
    minHolders: Math.floor(clampNum(af.autofarmOfferMinHolders, 5, 2, 50)),
    // …and has not changed for this long (rule 4).
    settleMs: clampNum(af.autofarmOfferSettleHours, 6, 0, 72) * HOUR_MS,
    maxPerPass: Math.floor(clampNum(af.autofarmOfferMaxPerPass, 2, 1, 5)),
    maxPerDay: Math.floor(clampNum(af.autofarmOfferMaxPerDay, 6, 1, 30)),
    // The price: what the pricing engine reads off our own sales, times this,
    // rounded down to a x.x9 — sell-through matters more than margin for stock
    // that expires — inside [minPrice, maxPrice].
    priceFactor: clampNum(af.autofarmOfferPriceFactor, 0.85, 0.5, 1.2),
    minPrice,
    maxPrice: Math.max(minPrice, clampNum(af.autofarmOfferMaxPrice, 1.49, 0.5, 10)),
    // Most accounts one new offer advertises (the stock sync follows the real
    // stock from then on).
    quantityCap: Math.floor(clampNum(af.autofarmOfferQuantity, 20, 1, 80)),
    // The owner's no-claim games (settings.isNoClaimGame's list and rule: each
    // entry is a keyword matched inside the normalised game name).
    noClaimGames: (Array.isArray(af.noClaimGames) ? af.noClaimGames : [])
      .map((g) => settings.normGameName(g))
      .filter(Boolean),
  };
}

// Buyers who take several get a discount: the marketplace's own tiers.
const VOLUME_DISCOUNTS = [
  { quantity: 3, percentage: 5 },
  { quantity: 5, percentage: 10 },
  { quantity: 10, percentage: 15 },
];

// ---------------------------------------------------------------------------
// Pure helpers (tested as-is)
// ---------------------------------------------------------------------------

function gameKey(label) {
  return settings.normGameName(label) || lower(label);
}

// Same game, matched as substrings both ways — the claim layer's own rule, so
// "Overwatch 2" items count for an "Overwatch" set.
function sameKey(a, b) {
  const x = str(a);
  const y = str(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

// The claim layer's item key: a stored itemKey wins, else "name|game".
function keyOfItem(it) {
  if (!it) return "";
  const stored = lower(it.itemKey);
  if (stored) return stored;
  const k = lower(it.name) + "|" + lower(it.game);
  return k === "|" ? "" : k;
}

function copiesOf(it) {
  const q = Math.floor(Number(it && it.qty));
  return Number.isFinite(q) && q >= 1 ? q : 1;
}

// Order-free identity of a bundle (key × copies).
function signatureOf(items) {
  const byKey = new Map();
  for (const it of items || []) {
    const k = keyOfItem(it);
    if (k) byKey.set(k, (byKey.get(k) || 0) + copiesOf(it));
  }
  return [...byKey].map(([k, q]) => k + "×" + q).sort().join("\n");
}

// The bundle to offer: the FULLEST set of items (most copies) that at least
// `minHolders` of these accounts hold in full.
//   holders  [{ items: Map(itemKey -> { qty, … }) }]
// Returns { items: Map, cover, copies } or null. Candidates are the holders'
// own item sets, so the answer is always something a real account holds.
function pickBundle(holders, minHolders) {
  const list = (holders || []).filter((h) => h && h.items && h.items.size);
  const sigs = new Map();
  for (const h of list) {
    const sig = [...h.items].map(([k, v]) => k + "×" + (v.qty || 1)).sort().join("\n");
    if (!sigs.has(sig)) sigs.set(sig, h.items);
  }
  let best = null;
  for (const items of sigs.values()) {
    const who = [];
    for (const h of list) {
      let ok = true;
      for (const [k, v] of items) {
        const have = h.items.get(k);
        if (!have || (have.qty || 1) < (v.qty || 1)) {
          ok = false;
          break;
        }
      }
      if (ok) who.push(h);
    }
    const cover = who.length;
    if (cover < minHolders) continue;
    const copies = [...items.values()].reduce((n, v) => n + (v.qty || 1), 0);
    if (!best || copies > best.copies || (copies === best.copies && cover > best.cover)) {
      best = { items, cover, copies, who };
    }
  }
  return best;
}

// The `need` copies of one item an account will hold the longest, as
// [{ campaign, gone }] — longest-lived first. `rawItem` is the account's item
// as its last read wrote it ({ qty, waves:[{campaign, qty}] }); `goneOf(name)`
// says when a campaign's copies leave (Infinity = not known). Copies no wave
// accounts for are unknown: they count, they outlive everything, and they are
// never called finished. An offer for 3 of an account's 4 copies is a promise
// about these three — not about the one that leaves tonight.
function longestLived(rawItem, need, goneOf) {
  const total = copiesOf(rawItem);
  const parts = [];
  let left = total;
  for (const w of (rawItem && Array.isArray(rawItem.waves) ? rawItem.waves : [])) {
    const n = Math.min(left, copiesOf(w));
    if (n <= 0) continue;
    left -= n;
    const campaign = str(w && w.campaign).trim();
    parts.push({ campaign, n, gone: campaign ? goneOf(campaign) : Infinity });
  }
  if (left > 0) parts.push({ campaign: "", n: left, gone: Infinity });
  parts.sort((x, y) => (y.gone === x.gone ? 0 : y.gone > x.gone ? 1 : -1));
  const out = [];
  let take = Math.max(1, Math.floor(Number(need)) || 1);
  for (const part of parts) {
    if (take <= 0) break;
    out.push({ campaign: part.campaign, gone: part.gone });
    take -= Math.min(take, part.n);
  }
  return out;
}

// "16 Oct 2026, 14:04 UTC" — the minute the copies leave, said in full so no
// time zone can read a day into it.
function utcStamp(ms) {
  const d = new Date(ms);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const two = (n) => String(n).padStart(2, "0");
  return d.getUTCDate() + " " + mon + " " + d.getUTCFullYear() + ", " + two(d.getUTCHours()) + ":" + two(d.getUTCMinutes()) + " UTC";
}

// The engine's price, made a little cheaper and rounded DOWN to a x.x9.
function offerPrice(enginePrice, c) {
  const conf = c || cfg();
  const fit = (p) => Math.round(Math.max(conf.minPrice, Math.min(conf.maxPrice, p)) * 100) / 100;
  const e = Number(enginePrice);
  if (!Number.isFinite(e) || e <= 0) return fit(0.99);
  const raw = e * conf.priceFactor;
  return fit(Math.floor(raw * 10 + 1e-9) / 10 - 0.01);
}

// A campaign's name as a title can carry it: "Launch Drops" -> "Launch".
function eventLabel(campaign) {
  return str(campaign)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s\-–—:|]*\b(twitch\s+)?(drops?|campaign|rewards?)\s*$/i, "")
    .replace(/[\s\-–—:|]+$/, "")
    .trim();
}

// "{Game} {Event} Twitch Drops (N Items) — A + B + C" with every item named
// when it fits; null when it does not (the caller then uses the house title).
function fullTitle(game, campaign, items) {
  const g = str(game).trim();
  const list = items || [];
  const names = list
    .filter((i) => str(i && i.name).trim())
    .map((i) => (copiesOf(i) > 1 ? copiesOf(i) + "× " : "") + str(i.name).trim());
  if (!g || !names.length || names.length !== list.length) return null;
  const copies = list.reduce((n, i) => n + copiesOf(i), 0);
  const ev = eventLabel(campaign);
  const heads = [];
  if (ev && ev.length <= 48 && !lower(g).includes(lower(ev))) {
    // An event that already names the game stands alone ("SPAM Launch"); one
    // that says nothing the game does not is dropped.
    heads.push(lower(ev).includes(lower(g)) ? ev : g + " " + ev);
  }
  heads.push(g);
  const count = " Twitch Drops (" + copies + " Item" + (copies === 1 ? "" : "s") + ") — ";
  for (const head of heads) {
    const t = head + count + names.join(" + ");
    if (t.length <= TITLE_MAX) return t;
  }
  return null;
}

function utcDay(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function utcDayStart(now = Date.now()) {
  return new Date(utcDay(now) + "T00:00:00.000Z");
}

// ---------------------------------------------------------------------------
// What the module remembers between passes (lost on a restart, by design: a
// restart only makes it wait again)
// ---------------------------------------------------------------------------

const memory = {
  firstSeen: new Map(), // game key + "\n" + signature -> ms the bundle was first seen
  retryAt: new Map(), // game key -> ms before which a failed publish is not retried
  tries: new Map(), // game key -> failed publishes today
  day: "",
  madeToday: 0,
};

function resetMemory() {
  memory.firstSeen.clear();
  memory.retryAt.clear();
  memory.tries.clear();
  memory.day = "";
  memory.madeToday = 0;
}

// ---------------------------------------------------------------------------
// The plan and the pass
// ---------------------------------------------------------------------------

function defaultDeps() {
  return {
    nh: require("./noclaimHoldings"),
    ncs: require("./noclaimStock"),
    ual: () => require("./unclaimedAutoList"),
    nl: () => require("./noclaimListings"),
    DropSet: require("../models/DropSet"),
    MarketplaceListing: require("../models/MarketplaceListing"),
    pricing: () => require("./pricing"),
    pricingEvidence: () => require("./pricingEvidence"),
    buildCover: (set) => require("./setImage").buildSetGridImage(set, { showTotal: true }),
    listingGame: (src) => require("./listingGame").listingGame(src),
    unlink: (p) => require("fs/promises").unlink(p),
    logEvent: (fields) => require("./systemLog").logEvent(fields),
    sendTelegram: (text) => require("./telegram").sendTelegram(text),
    // { PAUSED_ERROR, MIN_ACCOUNTS, RECENT_SALE_MS, lastDeliveredAt } — rule 6.
    rotation: () => require("./noclaimOfferRotation"),
  };
}

// The games of a set, as game keys.
function setKeys(set) {
  const out = new Set();
  const add = (g) => {
    const k = gameKey(g);
    if (k) out.add(k);
  };
  add(set && set.coverGame);
  for (const it of (set && set.items) || []) add(it && it.game);
  return [...out];
}

function msOf(v) {
  if (!v) return NaN;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : NaN;
}

// Is every campaign of this name, for this game, over? The snapshot's own
// index (Map<lowercased name, [{ game, endMs }]>) when it has one — Twitch
// re-issues names, and one that ended does not make a running namesake over —
// else what the copies' leave time implies.
function campaignOver(d, base, game, name, now) {
  const idx = base && base.campaignEnds;
  if (idx && typeof idx.get === "function") {
    const list = idx.get(lower(name)) || [];
    const mine = list.filter((x) => !x.game || sameKey(gameKey(x.game), gameKey(game)));
    return mine.length > 0 && mine.every((x) => Number.isFinite(x.endMs) && x.endMs <= now);
  }
  const gone = d.nh.waveGoneAt(base, game, name, now);
  const windowMs = Number(base && base.expiry && base.expiry.claimWindowMs) || 0;
  return Number.isFinite(gone) && gone - windowMs <= now;
}

// What could be offered right now: one entry per game, bundles that are ready
// first, then the most widely held. Database only. Each entry:
//   { key, game, items:[{itemKey,name,game,image,qty}], signature, campaign,
//     cover, holders, onShelf, goneAt, ended, complete, ready, readyAt, skip }
// `skip` is "" for a bundle that may be published (when ready), else why not.
async function plan({ deps, now = Date.now() } = {}) {
  const d = deps || defaultDeps();
  const c = cfg();
  const base = await d.nh.snapshotBase();
  const exp = (base && base.expiry) || {};
  const sellLeadMs = d.nh.advertiseLeadMs(MARKET);
  // Built on what will still be there a margin past the market's own lead, so
  // the next stock sync does not take a brand-new offer off again.
  const buildLeadMs = Math.max(Number(exp.bundleLeadMs) || 0, sellLeadMs + 12 * HOUR_MS);

  // Rule 1: the games the no-claim bots farm — a bot's own game, or one whose
  // drops several of them hold. (One stray account that picked up another
  // game's drop on the side does not make it theirs.)
  const fleet = new Set();
  const strays = new Map();
  for (const h of (base && base.holdings) || []) {
    if (!h || h.farm === FARM || h.inConfig !== true) continue;
    const k0 = gameKey(h.game);
    if (k0) fleet.add(k0);
    const mine = new Set();
    for (const it of h.items || []) {
      const k = gameKey(it && it.game);
      if (k) mine.add(k);
    }
    for (const k of mine) strays.set(k, (strays.get(k) || 0) + 1);
  }
  for (const [k, n] of strays) if (n >= FLEET_GAME_MIN) fleet.add(k);

  // Rules 2, 5 and 6 read the no-claim rows: every live claim-at-sale one
  // (their sets are the shelves), and the Eldorado ones taken down lately.
  const markets = Array.isArray(d.ncs.CLAIM_AT_SALE_MARKETS) && d.ncs.CLAIM_AT_SALE_MARKETS.length
    ? d.ncs.CLAIM_AT_SALE_MARKETS.slice()
    : [MARKET];
  const live = await d.MarketplaceListing.find(
    { marketplace: { $in: markets }, noclaimStock: true, status: "active" },
    { set: 1, marketplace: 1, autoPaused: 1, lastError: 1, units: 1 },
  ).lean();
  const down = await d.MarketplaceListing.find(
    { marketplace: MARKET, noclaimStock: true, status: "delisted", updatedAt: { $gte: new Date(now - DELIST_REST_MS) } },
    { set: 1, title: 1 },
  ).lean();
  const setIds = [...new Set((live || []).concat(down || []).map((r) => str(r.set)).filter(Boolean))];
  const sets = setIds.length
    ? await d.DropSet.find({ _id: { $in: setIds } }, { coverGame: 1, items: 1 }).lean()
    : [];
  const setById = new Map((sets || []).map((x) => [str(x._id), x]));
  const shelves = [];
  for (const id of new Set((live || []).map((r) => str(r.set)).filter(Boolean))) {
    const set = setById.get(id);
    const required = set ? d.ncs.requiredFromSet(set) : new Map();
    if (required.size) shelves.push({ keys: setKeys(set), required });
  }
  // Rule 5: games an offer of which was taken down lately. A row whose set
  // was deleted afterwards still names its game in its title.
  const rested = (down || []).map((r) => {
    const set = setById.get(str(r.set));
    return set ? { keys: setKeys(set), title: "" } : { keys: [], title: gameKey(r.title) };
  });
  const isRested = (key) =>
    rested.some((x) => x.keys.some((k) => sameKey(k, key)) || (x.title && x.title.includes(key)));
  // Rule 6: games with an Eldorado offer the stock sync paused that sold
  // lately — exactly the rows the rotation brings back.
  const revivable = [];
  const rot = (() => {
    try {
      return (typeof d.rotation === "function" && d.rotation()) || {};
    } catch {
      return {};
    }
  })();
  if (c.rotateOn && rot.PAUSED_ERROR && typeof rot.lastDeliveredAt === "function") {
    for (const r of live || []) {
      if (r.marketplace !== MARKET || r.autoPaused !== true || str(r.lastError) !== rot.PAUSED_ERROR) continue;
      if (now - rot.lastDeliveredAt(r) > (Number(rot.RECENT_SALE_MS) || 0)) continue;
      const set = setById.get(str(r.set));
      if (set) revivable.push(...setKeys(set));
    }
  }

  const all = []; // every fresh auto-farm account, with what it holds a sell lead out
  const byGame = new Map();
  for (const h of (base && base.holdings) || []) {
    if (!h || h.farm !== FARM || h.inConfig !== true) continue;
    if (!d.nh.isFresh(h, base, now)) continue;
    const heldAtSell = d.ncs.heldCounts(d.nh.durableItems(h, base, now + sellLeadMs) || []);
    const raw = new Map();
    for (const it of h.items || []) {
      const k = keyOfItem(it);
      if (k) raw.set(k, it);
    }
    const freeFor = new Map();
    // What its last sweep read said it has still to earn, per game.
    const pend = new Map();
    for (const x of Array.isArray(h.pending) ? h.pending : []) {
      const pk = gameKey(x && x.game);
      if (pk) pend.set(pk, (pend.get(pk) || 0) + (Math.max(0, Number(x.n)) || 0));
    }
    const acct = {
      loginLower: h.loginLower,
      readMs: msOf(h.readAt),
      heldAtSell,
      raw,
      // null = not known (a row no sweep has read since this was stored).
      left: (k) => {
        if (!h.pendingAt) return null;
        let n = 0;
        for (const [pk, v] of pend) if (sameKey(pk, k)) n += v;
        return n;
      },
      // Rule 2 — any shelf, any game: the claim hands over the whole account.
      onShelf: shelves.some((x) => d.ncs.covers(heldAtSell, x.required)),
      isFree: (k) => {
        if (!freeFor.has(k)) freeFor.set(k, d.nh.freeReason(h, base, k) === "");
        return freeFor.get(k);
      },
    };
    all.push(acct);
    const perGame = new Map();
    for (const it of d.nh.durableItems(h, base, now + buildLeadMs) || []) {
      const label = str(it && it.game).trim();
      const itemKey = keyOfItem(it);
      if (!label || !itemKey) continue;
      const k = gameKey(label);
      if (!perGame.has(k)) perGame.set(k, { label, items: new Map() });
      perGame.get(k).items.set(itemKey, {
        // The stored key as the account's inventory wrote it: the set carries
        // it, and the claim layer matches a set to an account by it.
        itemKey: str(it.itemKey).trim() || itemKey,
        qty: copiesOf(it),
        name: str(it.name),
        image: str(it.image),
        game: label,
      });
    }
    for (const [k, pg] of perGame) {
      if (!byGame.has(k)) byGame.set(k, { label: pg.label, holders: [], onShelf: 0 });
      const G = byGame.get(k);
      if (!acct.isFree(k)) continue;
      if (acct.onShelf) {
        G.onShelf++;
        continue;
      }
      G.holders.push({ ...acct, items: pg.items });
    }
  }

  const out = [];
  const seen = new Set();
  for (const [key, G] of byGame) {
    const best = pickBundle(G.holders, c.minHolders);
    if (!best) continue;
    const items = [...best.items.values()].map((v) => ({
      itemKey: v.itemKey, name: v.name, game: v.game, image: v.image || "", qty: v.qty,
    }));
    const signature = signatureOf(items);
    const need = d.ncs.requiredFromSet({ items });
    // When the copies a buyer is promised first leave ANY account that can be
    // handed over, whether every campaign they came from is over, and the
    // event's name (one, or none when they span several).
    let goneAt = Infinity;
    let ended = items.length > 0;
    const camps = new Set();
    for (const who of best.who) {
      for (const it of items) {
        const rawItem = who.raw.get(keyOfItem(it)) || it;
        for (const part of longestLived(rawItem, it.qty, (name) => d.nh.waveGoneAt(base, it.game, name, who.readMs))) {
          if (part.gone < goneAt) goneAt = part.gone;
          if (part.campaign) camps.add(part.campaign);
          if (!part.campaign || !campaignOver(d, base, it.game, part.campaign, now)) ended = false;
        }
      }
    }
    const memKey = key + "\n" + signature;
    seen.add(memKey);
    if (!memory.firstSeen.has(memKey)) memory.firstSeen.set(memKey, now);
    // Complete: every account that can deliver it has nothing left to earn for
    // this game. Then there is nothing to wait for.
    const complete = best.who.length > 0 && best.who.every((w) => w.left(key) === 0);
    const readyAt = ended || complete ? now : memory.firstSeen.get(memKey) + c.settleMs;
    // Rule 3: accounts that are on a shelf and hold this bundle too.
    const shared = all.filter((a) => a.onShelf && a.isFree(key) && d.ncs.covers(a.heldAtSell, need)).length;
    // Rule 4: accounts part-way through a campaign whose full bundle is
    // already on sale are on their way to that offer. Only once the campaign
    // is over is what they stopped at a bundle of its own.
    const partOfShelf =
      !ended &&
      shelves.some(
        (x) =>
          x.keys.some((sk) => sameKey(sk, key)) &&
          x.required.size > need.size &&
          [...need].every(([k, q]) => (x.required.get(k) || 0) >= q),
      );
    let skip = "";
    if (c.noClaimGames.some((g) => key.includes(g)) || [...fleet].some((f) => sameKey(f, key))) {
      skip = "a no-claim bot farms this game";
    } else if (isRested(key)) {
      skip = "an offer of this game was taken down lately — left to the owner";
    } else if (shared > 0) {
      skip = "accounts another offer already sells hold this bundle too";
    } else if (partOfShelf) {
      skip = "still earning toward a bundle that is on sale";
    } else if (best.cover >= (Number(rot.MIN_ACCOUNTS) || Infinity) && revivable.some((k) => sameKey(k, key))) {
      skip = "a paused offer of this game is the rotation's to bring back";
    }
    out.push({
      key,
      game: G.label,
      items,
      signature,
      campaign: camps.size === 1 ? [...camps][0] : "",
      cover: best.cover,
      holders: G.holders.length,
      onShelf: G.onShelf,
      shared,
      goneAt,
      ended,
      complete,
      ready: readyAt <= now,
      readyAt,
      skip,
    });
  }
  // A bundle that is no longer the pick starts its wait again if it returns.
  for (const k of [...memory.firstSeen.keys()]) if (!seen.has(k)) memory.firstSeen.delete(k);
  return out.sort(
    (a, b) => (b.ready ? 1 : 0) - (a.ready ? 1 : 0) || b.cover - a.cover || a.game.localeCompare(b.game),
  );
}

// Every no-claim set of the last two months holding exactly these items for
// this game, and whether any of them has ever had an offer on the market.
async function sameBundle(d, p, now) {
  const recent = await d.DropSet.find(
    { stockSource: "noclaim", createdAt: { $gte: new Date(now - SAME_SET_MS) } },
    { name: 1, note: 1, price: 1, items: 1, coverGame: 1, stockSource: 1, createdAt: 1 },
  )
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();
  const same = (recent || []).filter(
    (s) => setKeys(s).some((k) => sameKey(k, p.key)) && signatureOf(s.items) === p.signature,
  );
  if (!same.length) return { sets: [], listed: false };
  // A set kept as the record of a publish that may be live without a row.
  if (same.some((s) => str(s.note).includes(HOLD_MARK))) return { sets: same, listed: true };
  const rows = await d.MarketplaceListing.find(
    { marketplace: MARKET, set: { $in: same.map((s) => s._id) } },
    { _id: 1 },
  )
    .limit(1)
    .lean();
  return { sets: same, listed: (rows || []).length > 0 };
}

// One pass. Never throws. Returns
//   { created:[…], waiting:[{game, readyAt}], skipped:{reason:n}, errors:[…] }
async function runPass({ deps, dryRun = false, now = Date.now() } = {}) {
  const out = { created: [], waiting: [], skipped: {}, errors: [] };
  const skip = (why) => {
    out.skipped[why] = (out.skipped[why] || 0) + 1;
  };
  const c = cfg();
  if (!c.on) return { ...out, off: true };
  if (!c.eldoradoOn) return { ...out, off: true, why: "Eldorado auto-delivery is off or in dry-run" };
  const d = deps || defaultDeps();
  try {
    if (!d.ncs.deliveryEnabled()) return { ...out, off: true, why: "no-claim auto-delivery is off" };
    if (memory.day !== utcDay(now)) {
      memory.day = utcDay(now);
      memory.madeToday = 0;
      memory.tries.clear();
    }
    let room = 0;
    let roomKnown = false;
    const handled = new Set(); // bundles this pass has already dealt with
    // The plan is made again after every offer this pass publishes: the
    // accounts behind it are on a shelf from that moment (rules 2 and 3).
    for (let round = 0; round <= c.maxPerPass; round++) {
      const plans = await plan({ deps: d, now });
      let published = false;
      let capped = false;
      for (const p of plans) {
        const id = p.key + "\n" + p.signature;
        if (handled.has(id)) continue;
        handled.add(id);
        if (p.skip) {
          skip(p.skip);
          continue;
        }
        if (!p.ready) {
          out.waiting.push({
            game: p.game, items: p.items.length, holders: p.cover, readyAt: new Date(p.readyAt).toISOString(),
          });
          continue;
        }
        if ((memory.retryAt.get(p.key) || 0) > now) {
          skip("waiting after a failed publish");
          continue;
        }
        if ((memory.tries.get(p.key) || 0) >= MAX_TRIES_PER_DAY) {
          skip("failed " + MAX_TRIES_PER_DAY + " times today");
          continue;
        }
        if (!roomKnown) {
          // What this has published today: what it remembers, or the sets it
          // made (they carry SET_NOTE) when a restart wiped that.
          const made = await d.DropSet.countDocuments({
            stockSource: "noclaim",
            note: new RegExp("^" + SET_NOTE),
            createdAt: { $gte: utcDayStart(now) },
          });
          room = Math.min(c.maxPerPass, c.maxPerDay - Math.max(memory.madeToday, Number(made) || 0));
          roomKnown = true;
        }
        if (room < 1) {
          skip("daily or per-pass limit reached");
          continue;
        }
        try {
          const same = await sameBundle(d, p, now);
          if (same.listed) {
            skip("this bundle has had an offer already");
            continue;
          }
          const made = await publishOne(p, same.sets[0] || null, c, d, dryRun);
          out.created.push(made);
          room--;
          if (!dryRun) {
            memory.madeToday++;
            published = true;
            break; // plan again before the next one
          }
        } catch (e) {
          const msg = (e && e.message) || String(e);
          out.errors.push(p.game + ": " + msg);
          console.error("autofarmOffers: " + p.game + " was not listed: " + msg);
          // An offer that is, or may be, live without a row is invisible to
          // every rule above: trying again would put a second one next to it.
          // publishOne kept its set as the record (rule 5 reads it); the game
          // also waits a day here, and the owner is told to look.
          const held = !!(e && e.hold);
          memory.retryAt.set(p.key, now + (held ? 24 * HOUR_MS : RETRY_AFTER_MS));
          memory.tries.set(p.key, (memory.tries.get(p.key) || 0) + 1);
          if (held) {
            try {
              Promise.resolve(
                d.sendTelegram(
                  "⚠️ Auto-farm unclaimed offer for " + p.game +
                    (e.hold === "orphan"
                      ? " went live but was not recorded — take it down by hand.\n"
                      : " may have gone live without being recorded — check Eldorado for a stray offer.\n") +
                    msg + "\nIt will not be tried again by itself.",
                ),
              ).catch(() => {});
            } catch {
              /* the notice is best-effort */
            }
          }
          // The market's own cap on active offers ends the pass: every further
          // publish would fail the same way.
          if (/Maximum of \d+ active offers/i.test(msg)) {
            capped = true;
            break;
          }
        }
      }
      if (!published || capped) break;
    }
  } catch (e) {
    out.errors.push((e && e.message) || String(e));
  }
  return out;
}

async function publishOne(p, reuse, c, d, dryRun) {
  const drops = [];
  for (const it of p.items) {
    for (let i = 0; i < it.qty; i++) drops.push({ name: it.name, game: it.game, itemKey: it.itemKey, imageURL: it.image });
  }
  const ual = d.ual();
  const title = fullTitle(p.game, p.campaign, p.items) || str(ual.listingTitle(p.game, drops, null)).slice(0, TITLE_MAX);
  if (!title.trim()) throw new Error("no title for the bundle");
  let description = str(ual.listingDescription(p.game, drops, MARKET, null));
  if (Number.isFinite(p.goneAt)) {
    // A day before the copies are due to leave, to the minute and in UTC —
    // the moment the offer itself comes off sale, so the line is never in the
    // past while a buyer can still read it.
    const line =
      "\n\n⏳ These drops are unclaimed: connect your game account and claim them right after " +
      "delivery. Twitch removes unclaimed drops about a week after the event ends — claim these before " +
      utcStamp(p.goneAt - 24 * HOUR_MS) + ".";
    description = description.slice(0, DESCRIPTION_MAX - line.length) + line;
  }
  let engine = 0;
  let basis = "";
  try {
    const ev = await d.pricingEvidence().evidenceFor({ game: p.game, marketplace: MARKET });
    const r = d.pricing().priceListing({ evidence: ev, itemCount: p.items.length, marketplace: MARKET });
    engine = Number(r && r.price) || 0;
    basis = str(r && r.basis);
  } catch (e) {
    console.error("autofarmOffers: pricing for " + p.game + " failed:", e && e.message);
  }
  const price = offerPrice(engine, c);
  const quantity = Math.max(1, Math.min(p.cover, c.quantityCap));
  const summary = {
    game: p.game, title, price, enginePrice: engine, basis, quantity,
    items: p.items.length, holders: p.cover,
    claimBefore: Number.isFinite(p.goneAt) ? new Date(p.goneAt).toISOString() : null,
  };
  if (dryRun) return { ...summary, dryRun: true };

  // An identical set no offer was ever made on (another market's, or one a
  // failed publish left) is used as it is, so two markets selling the same
  // bundle share one shelf; otherwise a new one is made.
  let set = reuse;
  let created = false;
  if (!set) {
    const doc = await d.DropSet.create({
      name: title.slice(0, 200),
      note: SET_NOTE + " (utils/autofarmOffers)",
      price,
      items: p.items,
      stockSource: "noclaim",
      listed: false,
      publicCatalog: false,
      custom: false,
      sourceType: "",
      coverGame: p.game,
    });
    set = typeof doc.toObject === "function" ? doc.toObject() : doc;
    created = true;
  }
  // A set this call made is removed again when nothing came of it — unless a
  // row points at it by now (the rotation and grow passes reuse an identical
  // set on their own timer; deleting it would strand their offer).
  const dropNew = async () => {
    if (!created) return;
    try {
      const used = await d.MarketplaceListing.find({ set: set._id }, { _id: 1 }).limit(1).lean();
      if ((used || []).length) return;
      await d.DropSet.deleteOne({ _id: set._id });
    } catch {
      /* a set left behind is harmless: nothing sells it */
    }
  };
  if (set.stockSource !== "noclaim") {
    await dropNew();
    throw new Error("the set was not saved as a no-claim set");
  }
  let cover = "";
  try {
    cover = await d.buildCover(set);
  } catch (e) {
    cover = "";
  }
  if (!cover) {
    // The market refuses an offer without a picture; a set nothing sells is
    // not kept.
    await dropNew();
    throw new Error("no cover image could be built");
  }
  let r;
  try {
    r = await d.nl().publishNoclaim(MARKET, {
      set,
      body: { eldorado: { quantity, volumeDiscounts: VOLUME_DISCOUNTS } },
      title,
      description,
      priceUsd: price,
      gridImage: cover,
      coverPath: "",
      cat: {},
      pubGame: d.listingGame({ set }),
    });
  } catch (e) {
    r = { success: false, message: (e && e.message) || String(e) };
  } finally {
    await Promise.resolve()
      .then(() => d.unlink(cover))
      .catch(() => {});
  }
  if (!r || !r.success) {
    const msg = (r && r.message) || "the publish failed";
    const hold = ORPHAN_RE.test(msg) ? "orphan" : MAYBE_LANDED_RE.test(msg) ? "maybe" : "";
    if (hold && created) {
      // The offer is, or may be, live with no row. The set stays as the one
      // record that outlives a restart: rule 5 never lists its bundle again.
      await d.DropSet.updateOne(
        { _id: set._id },
        { $set: { note: (SET_NOTE + " (utils/autofarmOffers)" + HOLD_MARK + msg).slice(0, 600) } },
      ).catch(() => {});
    } else {
      await dropNew();
    }
    const err = new Error(msg);
    err.hold = hold;
    throw err;
  }
  const made = { ...summary, setId: str(set._id), listingId: str(r.id), externalId: str(r.externalId), url: str(r.url) };
  console.log(
    "autofarmOffers: listed " + title + " on Eldorado at $" + price.toFixed(2) + " × " + quantity +
      " (offer " + made.externalId + ")",
  );
  try {
    Promise.resolve(
      d.logEvent({
        category: "noclaim_shop",
        action: "autofarm_offer_created",
        actor: "autofarmOffers",
        severity: "info",
        subject: title,
        game: p.game,
        count: quantity,
        detail:
          "auto-farm unclaimed stock listed on Eldorado: " + p.items.length + " item(s) at $" + price.toFixed(2) +
          " (engine $" + engine.toFixed(2) + (basis ? ", " + basis : "") + "), " + p.cover + " free account(s) hold it",
      }),
    ).catch(() => {});
    Promise.resolve(
      d.sendTelegram(
        "🆕 LISTED (auto-farm unclaimed stock)\n\n" + title + "\nEldorado — $" + price.toFixed(2) + " × " + quantity +
          "\n" + p.cover + " free account(s) hold it" +
          (summary.claimBefore ? "\nDrops leave the accounts: " + summary.claimBefore.slice(0, 16).replace("T", " ") + "Z" : ""),
      ),
    ).catch(() => {});
  } catch {
    /* the notice is best-effort */
  }
  return made;
}

module.exports = {
  SET_NOTE,
  VOLUME_DISCOUNTS,
  cfg,
  // pure, tested
  pickBundle,
  longestLived,
  utcStamp,
  offerPrice,
  eventLabel,
  fullTitle,
  signatureOf,
  sameKey,
  utcDayStart,
  // the pass
  plan,
  runPass,
  resetMemory,
  defaultDeps,
};
