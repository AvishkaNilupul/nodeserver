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
//   8. COPIES (autoFarm.autofarmOfferCopyMarkets, default none). A finished
//      offer of this lister's is also listed on another claim-at-sale market
//      (G2G) — the SAME set, so the stock sync splits the one shelf between
//      the two offers and no account is advertised twice over. Only where the
//      market lists the game, its orders are really delivered, and enough
//      accounts hold the bundle. A copy follows its Eldorado offer: when that
//      one moves on to another bundle or comes down, the copy comes down too —
//      and that sweep runs whether or not the lister itself is switched on
//      (its own switch: autoFarm.autofarmOfferCopySweep). A game whose copy
//      somebody else took down is left alone for two weeks, like rule 5.
//      GAMEFLIP is a copy market of another kind: it takes the account when
//      the listing is MADE, one account per listing. There an account is HELD
//      (utils/autofarmStock's vault switch, on top of this one), a chain of a
//      few units is listed, nobody's shelf is shared — so nothing follows
//      anything — and a set gets a new chain only after the last one sold out.
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
// Rule 8 — the claim-at-sale markets a copy may go to, and their title limits.
const COPY_MARKETS = ["g2g", "gameflip"];
// How a copy market takes an account. "claim": when a buyer pays — the copy
// shares the set's shelf with the Eldorado offer and follows it. "vault": when
// the listing is made — the account is HELD from then on (utils/autofarmStock
// decides whether, and for how long it may be), so no shelf is shared.
const COPY_KIND = { g2g: "claim", gameflip: "vault" };
const SHELF_MARKETS = COPY_MARKETS.filter((m) => COPY_KIND[m] === "claim");
const COPY_TITLE_MAX = { g2g: 128, gameflip: 120 };
// Gameflip refuses a listing without a photo.
const COPY_NEEDS_COVER = { gameflip: true };
// On the row of every copy this makes: what tells it from a listing the owner
// published by hand, which is never taken down from here.
const COPY_MARK = " — auto-farm copy";
// The sweep's own words on a row it took down: what tells its take-downs from
// anyone else's (the owner's Delist button).
const SWEPT_MARK = ": its Eldorado offer moved on";
// The least a market lets an offer cost (utils/marketplaces G2G_MIN_PRICE:
// G2G enforces min_qty × unit_price >= USD 1).
const COPY_MIN_PRICE = { g2g: 1, gameflip: 0.75 };
// A G2G publish is two calls and a read-back (create a shell, write the offer,
// read it). The write is worded "G2G publish offer failed …" and the read-back
// "G2G publish: offer … did not read back". Once the write was sent, the copy
// MAY be live unless G2G plainly refused it with a 4xx: a 5xx, no answer at
// all, a 2xx whose body broke off, an error reported inside a 200, a failed
// read-back — none of those says it did not land. (A needless hold costs one
// look at G2G; a missed one is a second live offer no order can reach.)
// Gameflip's own lane decides what a failed publish leaves behind, and says so
// in the error when it kept the account held (utils/gameflipFulfiller
// HELD_MARK — it has paged the owner itself by then).
const COPY_MAYBE = {
  g2g: /^G2G publish(?!.*\(HTTP 4\d\d\))/i,
  gameflip: /\[account kept held\]/,
};
// The record a copy leaves on its set's note:
//   " — HOLD: <market> copy <YYYY-MM-DD HH:MM>Z: <what happened>"
// It carries its own time, so the six-hour rest and the daily limit below are
// read off the database and outlive a restart.
const COPY_RECORD_RE = / — HOLD: (\w+) copy (\d{4}-\d{2}-\d{2} \d{2}:\d{2})Z: /;
// …while a publish is in flight, and once the owner was told it never ended.
const COPY_STARTED = "publish started and never finished";
const COPY_STARTED_TOLD = "publish never finished (owner told)";
// How long a publish may be in flight before "started" means "never finished".
const COPY_UNFINISHED_MS = 10 * 60 * 1000;
// After a copy that may be live without a row, no other copy is tried for this
// long: whatever broke that publish would break the next one the same way.
const COPY_PAUSE_MS = 6 * HOUR_MS;
// Not worth a second offer when the bundle comes off sale within the day.
const COPY_MIN_LIFE_MS = 24 * HOUR_MS;
// The sets the grow and rotation passes make name the set they came from.
const LINEAGE_RE = /^Made \d{4}-\d{2}-\d{2} by the no-claim offer (?:grow|rotation):[^]*?\bset ([0-9a-f]{24})\b/i;

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
    // Rule 8. Only markets this module knows how to copy to are kept.
    copyMarkets: (Array.isArray(af.autofarmOfferCopyMarkets) ? af.autofarmOfferCopyMarkets : [])
      .map(lower)
      .filter((m, i, a) => COPY_MARKETS.includes(m) && a.indexOf(m) === i),
    // G2G orders really delivered, and its stock really kept in step — the
    // switches utils/g2gFulfiller reads (its dry-run ships ON).
    g2gOn: af.g2gAutoDeliver === true && af.g2gDeliverDryRun === false && af.g2gSyncStock !== false,
    copyMinHolders: Math.floor(clampNum(af.autofarmOfferCopyMinHolders, 6, 2, 80)),
    // A market that HOLDS accounts (Gameflip): how many units one chain sells
    // (one live listing at a time, the rest queued), and how many free
    // accounts must hold the bundle before any is taken off the shelf for it.
    vaultUnits: Math.floor(clampNum(af.autofarmOfferVaultUnits, 2, 1, 10)),
    vaultMinHolders: Math.floor(clampNum(af.autofarmOfferVaultMinHolders, 8, 2, 80)),
    copiesPerDay: Math.floor(clampNum(af.autofarmOfferCopiesPerDay, 6, 1, 30)),
    // A copy never costs more than the Eldorado offer of the same bundle times
    // this: the engine's figure for a market is an average over bundles of
    // every size sold there.
    copyPriceFactor: clampNum(af.autofarmOfferCopyPriceFactor, 1.2, 1, 2),
    // Copies left behind come down even while the lister is off — unless this
    // says not to.
    copySweep: af.autofarmOfferCopySweep !== false,
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

// What a copy costs on `market`: the engine's price for that market, made
// cheaper like any offer — but never above the Eldorado offer of the same
// bundle times the copy factor (rounded down to a x.x9), and never under what
// the market lets an offer cost.
function copyPrice(enginePrice, eldoradoPrice, market, c) {
  const conf = c || cfg();
  let p = offerPrice(enginePrice, conf);
  const eld = Number(eldoradoPrice);
  if (Number.isFinite(eld) && eld > 0) {
    p = Math.min(p, Math.floor(eld * conf.copyPriceFactor * 10 + 1e-9) / 10 - 0.01);
  }
  const floor = Math.max(conf.minPrice, Number(COPY_MIN_PRICE[market]) || 0);
  return Math.round(Math.max(floor, p) * 100) / 100;
}

// A set's note with a HOLD record on it. The record is what must survive: the
// note is cut to make room for it, never the other way round.
function holdNote(note, text) {
  const mark = (HOLD_MARK + str(text)).slice(0, 240);
  return str(note).slice(0, 600 - mark.length) + mark;
}

// The text of a copy's record (see COPY_RECORD_RE).
function copyRecordText(market, now, what) {
  return str(market) + " copy " + new Date(now).toISOString().slice(0, 16).replace("T", " ") + "Z: " + str(what);
}

// The copy record on a set's note, or null:
//   { market, at (ms), started, told }
function copyRecord(note) {
  const text = str(note);
  const m = COPY_RECORD_RE.exec(text);
  if (!m) return null;
  const at = Date.parse(m[2].replace(" ", "T") + ":00Z");
  const rest = text.slice(m.index + m[0].length);
  return {
    market: lower(m[1]),
    at: Number.isFinite(at) ? at : 0,
    started: rest.startsWith(COPY_STARTED),
    told: rest.startsWith(COPY_STARTED_TOLD),
  };
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
function fullTitle(game, campaign, items, max = TITLE_MAX) {
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
    if (t.length <= max) return t;
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
  copyRetryAt: new Map(), // set id + "|" + market -> ms before which a copy is not tried
  copyTries: new Map(), // set id + "|" + market -> failed copies today
  copyPauseUntil: 0, // ms before which no copy at all is tried
  day: "",
  madeToday: 0,
};

function resetMemory() {
  memory.firstSeen.clear();
  memory.retryAt.clear();
  memory.tries.clear();
  memory.copyRetryAt.clear();
  memory.copyTries.clear();
  memory.copyPauseUntil = 0;
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
    // Rule 8: { serviceId, brandId } of the game on G2G, or null (never a guess).
    g2gCategory: (game) => {
      const g = require("./g2gGames");
      const brand = g.brandForGame(game);
      return brand ? { serviceId: g.G2G_ITEMS_SERVICE, brandId: brand.brandId } : null;
    },
    // May an auto-farm account be HELD for this market, and how long its
    // bundle must still last for that (utils/autofarmStock's vault rules).
    vaultAllowed: (market) => require("./autofarmStock").vaultAllowed(market),
    vaultMinLifeMs: () => require("./autofarmStock").vaultMinLifeMs(),
    // Takes a copy off sale (a status change on G2G, never a delete).
    delistCopy: (market, externalId) => {
      if (market === "g2g") return require("./marketplaces").g2gDelist(externalId);
      throw new Error("no way to take a " + market + " copy down");
    },
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

// Rule 1: the games the no-claim bots farm — a bot's own game, or one whose
// drops several of them hold. (One stray account that picked up another
// game's drop on the side does not make it theirs.)
function fleetKeys(base) {
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
  return fleet;
}

// Is this a game the no-claim bots (or the owner's no-claim list) own?
function ownersGame(key, c, fleet) {
  return c.noClaimGames.some((g) => key.includes(g)) || [...fleet].some((f) => sameKey(f, key));
}

// One fresh auto-farm account as the rules below read it:
//   heldAtSell  what it will still hold a sell lead from now (item key -> copies)
//   raw         its items as its last read wrote them (item key -> item)
//   left(k)     drops it has still to earn for game key k (null = not known)
//   isFree(k)   may a paid order take it for game key k?
function accountOf(d, h, base, now, sellLeadMs) {
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
  return {
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
    isFree: (k) => {
      if (!freeFor.has(k)) freeFor.set(k, d.nh.freeReason(h, base, k) === "");
      return freeFor.get(k);
    },
  };
}

// When the copies a buyer of `items` is promised first leave ANY of the
// accounts in `who`, whether every campaign they came from is over, and the
// campaigns' names.
function bundleLife(d, base, items, who, now) {
  let goneAt = Infinity;
  let ended = (items || []).length > 0;
  const camps = new Set();
  for (const w of who || []) {
    for (const it of items || []) {
      const rawItem = w.raw.get(keyOfItem(it)) || it;
      for (const part of longestLived(rawItem, it.qty, (name) => d.nh.waveGoneAt(base, it.game, name, w.readMs))) {
        if (part.gone < goneAt) goneAt = part.gone;
        if (part.campaign) camps.add(part.campaign);
        if (!part.campaign || !campaignOver(d, base, it.game, part.campaign, now)) ended = false;
      }
    }
  }
  return { goneAt, ended, camps };
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

  const fleet = fleetKeys(base);

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
    const acct = accountOf(d, h, base, now, sellLeadMs);
    // Rule 2 — any shelf, any game: the claim hands over the whole account.
    acct.onShelf = shelves.some((x) => d.ncs.covers(acct.heldAtSell, x.required));
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
    const { goneAt, ended, camps } = bundleLife(d, base, items, best.who, now);
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
    if (ownersGame(key, c, fleet)) {
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
  const out = { created: [], waiting: [], skipped: {}, errors: [], copies: [], copiesDown: [] };
  const skip = (why) => {
    out.skipped[why] = (out.skipped[why] || 0) + 1;
  };
  const c = cfg();
  const d = deps || defaultDeps();
  // Rule 8's sweep comes first and does not ask whether the lister is on: a
  // copy whose Eldorado offer moved on advertises the same accounts a second
  // time, and switching the lister off must not leave it doing so.
  if (!dryRun && c.copySweep) {
    try {
      out.copiesDown = await sweepCopies({ deps: d, now });
    } catch (e) {
      out.errors.push("copy sweep: " + ((e && e.message) || String(e)));
    }
  }
  if (!c.on) return { ...out, off: true };
  if (!c.eldoradoOn) return { ...out, off: true, why: "Eldorado auto-delivery is off or in dry-run" };
  try {
    if (!d.ncs.deliveryEnabled()) return { ...out, off: true, why: "no-claim auto-delivery is off" };
    if (memory.day !== utcDay(now)) {
      memory.day = utcDay(now);
      memory.madeToday = 0;
      memory.tries.clear();
      memory.copyTries.clear();
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
  // Rule 8, on its own feet: nothing above may keep a copy that was left
  // behind on sale, and nothing here may undo what the pass above did.
  try {
    await copyPass(c, d, out, skip, { dryRun, now });
  } catch (e) {
    out.errors.push("copies: " + ((e && e.message) || String(e)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule 8 — copies on another claim-at-sale market
// ---------------------------------------------------------------------------

// Is this set one of this lister's: made by it, or made by the grow / rotation
// pass out of one that was? `byId` holds the sets already read.
function ownSet(set, byId, depth = 0) {
  const note = str(set && set.note);
  if (note.startsWith(SET_NOTE)) return true;
  if (depth >= 4) return false;
  const m = LINEAGE_RE.exec(note);
  const parent = m ? byId.get(m[1].toLowerCase()) : null;
  return parent ? ownSet(parent, byId, depth + 1) : false;
}

// Does this set, or a set it was grown or rotated from, carry the record of a
// copy on `market` that is or may be live without a row? Its family then gets
// no copy by itself: a second offer beside a stray one is how one bundle ends
// up on a market twice.
function familyHeld(set, byId, market, depth = 0) {
  const rec = copyRecord(set && set.note);
  if (rec && rec.market === market) return true;
  if (depth >= 4) return false;
  const m = LINEAGE_RE.exec(str(set && set.note));
  const parent = m ? byId.get(m[1].toLowerCase()) : null;
  return parent ? familyHeld(parent, byId, market, depth + 1) : false;
}

// Every copy record there is, with its set: [{ set, rec }].
async function copyRecords(d) {
  const sets =
    (await d.DropSet.find(
      { stockSource: "noclaim", note: /— HOLD: \w+ copy / },
      { name: 1, note: 1, coverGame: 1 },
    )
      .limit(200)
      .lean()) || [];
  return sets.map((set) => ({ set, rec: copyRecord(set.note) })).filter((x) => x.rec);
}

// A publish that never answered (the server stopped in the middle of it, or
// its record could not be cleared): the set is held, and until now nobody
// would have known. The owner is told once; the record then says so.
async function tellUnfinished(d, records, now) {
  for (const x of records) {
    if (!x.rec.started || now - x.rec.at < COPY_UNFINISHED_MS) continue;
    const note = str(x.set.note);
    let w = null;
    try {
      w = await d.DropSet.updateOne({ _id: x.set._id, note }, { $set: { note: note.replace(COPY_STARTED, COPY_STARTED_TOLD) } });
    } catch {
      w = null;
    }
    if (!(w && (w.modifiedCount || w.nModified))) continue; // told already, or the note moved on
    x.rec.started = false;
    x.rec.told = true;
    const name = str(x.set.name || x.set.coverGame || x.set._id);
    try {
      Promise.resolve(
        d.logEvent({
          category: "noclaim_shop",
          action: "autofarm_copy_unfinished",
          actor: "autofarmOffers",
          severity: "error",
          subject: name,
          count: 1,
          detail:
            "a " + x.rec.market + " copy of this set was being published at " + new Date(x.rec.at).toISOString().slice(0, 16).replace("T", " ") +
            "Z and never finished — check " + x.rec.market + " for an offer with no listing row; the set is held",
        }),
      ).catch(() => {});
      Promise.resolve(
        d.sendTelegram(
          "⚠️ Auto-farm unclaimed copy: a " + x.rec.market + " publish of \"" + name + "\" started at " +
            new Date(x.rec.at).toISOString().slice(0, 16).replace("T", " ") + "Z and never finished (the server stopped, or its record could not be cleared).\n" +
            "Check " + x.rec.market + " for an offer of it that is not on the Listings page and take it down. It will not be copied again by itself.",
        ),
      ).catch(() => {});
    } catch {
      /* the notice is best-effort */
    }
  }
}

// The offers of this lister's that could get a copy, one entry per (set,
// market), the most widely held first. Database only. Each entry:
//   { market, set, setId, key, game, cover, finished, goneAt, campaign,
//     category, skip }
// `skip` is "" for a copy that may be published, else why not.
async function planCopies({ deps, now = Date.now() } = {}) {
  const d = deps || defaultDeps();
  const c = cfg();
  if (!c.copyMarkets.length) return [];
  // Offers that are on sale on Eldorado right now.
  const eld = (
    (await d.MarketplaceListing.find(
      { marketplace: MARKET, noclaimStock: true, status: "active" },
      { set: 1, autoPaused: 1, price: 1 },
    ).lean()) || []
  ).filter((r) => r.autoPaused !== true && r.set);
  const setIds = [...new Set(eld.map((r) => str(r.set)))];
  if (!setIds.length) return [];
  // What the bundle costs on Eldorado (the cheapest of its offers there).
  const eldPrice = new Map();
  for (const r of eld) {
    const p = Number(r.price);
    if (!(p > 0)) continue;
    const k = str(r.set);
    if (!eldPrice.has(k) || p < eldPrice.get(k)) eldPrice.set(k, p);
  }
  // Copies somebody else took down lately (the owner's Delist button): their
  // games are left alone, as rule 5 leaves a game whose offer was taken down.
  // A shelf copy this lister swept carries the sweep's own words; a held unit
  // every automatic take-down writes its reason on (lastError) — the owner's
  // Delist button leaves that empty.
  const gone = (
    (await d.MarketplaceListing.find(
      { marketplace: { $in: c.copyMarkets }, noclaimStock: true, status: "delisted", updatedAt: { $gte: new Date(now - DELIST_REST_MS) } },
      { set: 1, marketplace: 1, note: 1, title: 1, lastError: 1 },
    ).lean()) || []
  ).filter((r) =>
    COPY_KIND[r.marketplace] === "vault"
      ? !str(r.lastError).trim()
      : str(r.note).includes(COPY_MARK) && !str(r.note).includes(SWEPT_MARK),
  );
  // What each set has, or had, on each copy market.
  //   shelf copy — one per set and market, ever, whatever became of it;
  //   held chain — none while one is on sale, and a new one only when the
  //                last listing of the set SOLD (a chain that sold through is
  //                demand; one that came down unsold is not asked twice).
  const past = new Map(); // set id + "|" + market -> { active, lastStatus, lastAt }
  for (const r of (await d.MarketplaceListing.find(
    { marketplace: { $in: c.copyMarkets }, noclaimStock: true, set: { $in: setIds } },
    { set: 1, marketplace: 1, status: 1, createdAt: 1 },
  ).lean()) || []) {
    const k = str(r.set) + "|" + r.marketplace;
    const cur = past.get(k) || { active: false, lastStatus: "", lastAt: -Infinity };
    if (r.status === "active") cur.active = true;
    const at = msOf(r.createdAt);
    if (!(at < cur.lastAt)) {
      cur.lastAt = Number.isFinite(at) ? at : cur.lastAt;
      cur.lastStatus = str(r.status);
    }
    past.set(k, cur);
  }
  const had = (id, market) => {
    const p = past.get(id + "|" + market);
    if (!p) return false;
    if (COPY_KIND[market] !== "vault") return true;
    return p.active || p.lastStatus !== "sold";
  };
  const fields = { name: 1, note: 1, price: 1, items: 1, coverGame: 1, stockSource: 1, createdAt: 1 };
  const byId = new Map();
  let want = [...new Set(setIds.concat(gone.map((r) => str(r.set)).filter(Boolean)))];
  // The sets, and the sets they were grown or rotated from (a few steps back).
  for (let step = 0; step < 5 && want.length; step++) {
    const got = (await d.DropSet.find({ _id: { $in: want } }, fields).lean()) || [];
    for (const x of got) byId.set(str(x._id).toLowerCase(), x);
    want = [];
    for (const x of got) {
      const m = LINEAGE_RE.exec(str(x.note));
      if (m && !byId.has(m[1].toLowerCase()) && !want.includes(m[1].toLowerCase())) want.push(m[1].toLowerCase());
    }
  }
  // market + "|" + game key of every copy taken down by someone else. A row
  // whose set is gone still names its game in its title.
  const rested = gone.map((r) => {
    const set = byId.get(str(r.set).toLowerCase());
    return { market: r.marketplace, keys: set ? setKeys(set) : [], title: set ? "" : gameKey(r.title) };
  });
  const isRested = (market, key) =>
    rested.some((x) => x.market === market && (x.keys.some((k) => sameKey(k, key)) || (x.title && x.title.includes(key))));
  const base = await d.nh.snapshotBase();
  const exp = (base && base.expiry) || {};
  const fleet = fleetKeys(base);
  const accounts = []; // every fresh account that can be handed over
  const strangers = []; // …and the no-claim bots' own
  const out = [];
  for (const market of c.copyMarkets) {
    const vault = COPY_KIND[market] === "vault";
    // A shelf copy stops when its market stops advertising the bundle; a held
    // unit comes off a day early as an Eldorado offer does.
    const sellLeadMs = d.nh.advertiseLeadMs(vault ? MARKET : market);
    // What the accounts must still hold for the copy to be worth making: past
    // the market's lead for a shelf copy; for a held unit the life the claim
    // layer itself asks before it holds an account, and a margin.
    const buildLeadMs = vault
      ? Math.max(Number(d.vaultMinLifeMs()) || 0, sellLeadMs) + 12 * HOUR_MS
      : Math.max(Number(exp.bundleLeadMs) || 0, sellLeadMs + 12 * HOUR_MS);
    accounts.length = 0;
    strangers.length = 0;
    for (const h of (base && base.holdings) || []) {
      if (!h || h.inConfig !== true || !d.nh.isFresh(h, base, now)) continue;
      const acct = accountOf(d, h, base, now, sellLeadMs);
      acct.heldAtBuild = d.ncs.heldCounts(d.nh.durableItems(h, base, now + buildLeadMs) || []);
      (h.farm === FARM ? accounts : strangers).push(acct);
    }
    for (const id of setIds) {
      const set = byId.get(id.toLowerCase());
      if (!set || set.stockSource !== "noclaim" || had(id, market)) continue;
      // A set kept as the record of an Eldorado publish that may be live without
      // a row. (A copy's own record is reported below, as a skip.)
      if (str(set.note).includes(HOLD_MARK) && !copyRecord(set.note)) continue;
      if (!ownSet(set, byId)) continue;
      const game = str(set.coverGame || (set.items && set.items[0] && set.items[0].game)).trim();
      const key = gameKey(game);
      const required = d.ncs.requiredFromSet(set);
      if (!key || !required.size) continue;
      const who = accounts.filter((a) => a.isFree(key) && d.ncs.covers(a.heldAtBuild, required));
      const foreign = strangers.filter((a) => a.isFree(key) && d.ncs.covers(a.heldAtBuild, required)).length;
      const life = bundleLife(d, base, set.items || [], who, now);
      const finished = who.length > 0 && (life.ended || who.every((w) => w.left(key) === 0));
      // G2G files an offer under the game's own brand; Gameflip has no such
      // shelf (every listing is one generic digital-goods item).
      const category = market === "g2g" ? d.g2gCategory(game) : {};
      let skip = "";
      if (market === "g2g" && !c.g2gOn) skip = "G2G delivery or its stock sync is off";
      else if (vault && !d.vaultAllowed(market)) skip = "holding accounts for this market is switched off";
      else if (familyHeld(set, byId, market)) skip = "an earlier copy of this bundle may be live — left to the owner";
      else if (ownersGame(key, c, fleet)) skip = "a no-claim bot farms this game";
      else if (isRested(market, key)) skip = "a copy of this game was taken down lately — left to the owner";
      else if (foreign > 0) skip = "a no-claim bot account holds this bundle too";
      else if (!category) skip = "the market does not list this game";
      else if (who.length < (vault ? c.vaultMinHolders : c.copyMinHolders)) skip = "too few accounts for a second market";
      else if (!finished) skip = "its accounts are still earning";
      // A held account needs a leave date on record (the claim layer refuses
      // one without); "who" already holds only what lasts the vault's minimum.
      else if (vault && !Number.isFinite(life.goneAt)) skip = "no leave date on record for its drops";
      else if (!vault && Number.isFinite(life.goneAt) && life.goneAt - sellLeadMs - now < COPY_MIN_LIFE_MS) {
        skip = "it comes off sale within the day";
      }
      out.push({
        market,
        set,
        setId: str(set._id),
        key,
        game,
        kind: COPY_KIND[market],
        cover: who.length,
        finished,
        goneAt: life.goneAt,
        campaign: life.camps.size === 1 ? [...life.camps][0] : "",
        category,
        eldoradoPrice: eldPrice.get(id) || 0,
        skip,
      });
    }
  }
  return out.sort((a, b) => b.cover - a.cover || a.game.localeCompare(b.game));
}

// Copies this lister made since `since`.
async function copiesMadeSince(d, since) {
  const rows =
    (await d.MarketplaceListing.find(
      { marketplace: { $in: COPY_MARKETS }, noclaimStock: true, createdAt: { $gte: since } },
      { note: 1 },
    ).lean()) || [];
  return rows.filter((r) => str(r.note).includes(COPY_MARK)).length;
}

// A copy follows its Eldorado offer. One whose set no longer carries an
// Eldorado offer — it grew or rotated on to another bundle, or was taken down
// — comes off sale: the stock sync splits a shelf only between offers of the
// SAME set, so left alone the two would advertise the same accounts twice.
// Only rows this lister made (COPY_MARK). Returns what came down.
async function sweepCopies({ deps, now = Date.now(), limit = 2 } = {}) {
  const d = deps || defaultDeps();
  const rows = (
    (await d.MarketplaceListing.find(
      // Shelf copies only: a held unit shares nobody's shelf, and comes off
      // by its own rules (noclaimListings' expiry and health steps).
      { marketplace: { $in: SHELF_MARKETS }, noclaimStock: true, status: "active" },
      { set: 1, marketplace: 1, externalId: 1, note: 1, title: 1 },
    ).lean()) || []
  ).filter((r) => str(r.note).includes(COPY_MARK));
  if (!rows.length) return [];
  const setIds = [...new Set(rows.map((r) => str(r.set)).filter(Boolean))];
  const kept = new Set(
    (
      (await d.MarketplaceListing.find(
        { marketplace: MARKET, noclaimStock: true, status: "active", set: { $in: setIds } },
        { set: 1 },
      ).lean()) || []
    ).map((r) => str(r.set)),
  );
  const down = [];
  let tries = 0;
  for (const r of rows) {
    if (kept.has(str(r.set))) continue;
    if (tries >= limit) break;
    tries++;
    try {
      await d.delistCopy(r.marketplace, str(r.externalId));
    } catch (e) {
      // Still on sale: the stock sync keeps its quantity honest, and the next
      // pass tries again. The market is not answering — the others wait too.
      console.error("autofarmOffers: copy " + r.marketplace + " " + r.externalId + " could not be taken down:", e && e.message);
      break;
    }
    await d.MarketplaceListing.updateOne(
      { _id: r._id, status: "active" },
      {
        $set: {
          status: "delisted",
          autoPaused: false,
          lastError: "",
          note: (str(r.note) + " — taken down " + new Date(now).toISOString().slice(0, 16).replace("T", " ") + "Z" + SWEPT_MARK).slice(0, 600),
        },
      },
    );
    down.push({ market: r.marketplace, externalId: str(r.externalId), title: str(r.title) });
    try {
      Promise.resolve(
        d.logEvent({
          category: "noclaim_shop",
          action: "autofarm_copy_down",
          actor: "autofarmOffers",
          severity: "info",
          subject: str(r.title),
          count: 1,
          detail: "the " + r.marketplace + " copy " + r.externalId + " was taken down: its Eldorado offer moved on to another bundle or came down",
        }),
      ).catch(() => {});
    } catch {
      /* the notice is best-effort */
    }
  }
  return down;
}

async function copyPass(c, d, out, skip, { dryRun, now }) {
  if (!c.copyMarkets.length) return;
  const records = await copyRecords(d);
  if (!dryRun) await tellUnfinished(d, records, now);
  // After a copy that is or may be live without a row, no other copy is tried
  // for six hours — read off the records, so a restart does not forget it.
  if (memory.copyPauseUntil > now || records.some((x) => now - x.rec.at < COPY_PAUSE_MS)) {
    skip("copy: resting after a publish that may be live");
    return;
  }
  const dayStart = utcDayStart(now);
  const entries = await planCopies({ deps: d, now });
  let made = null;
  for (const e of entries) {
    const id = e.setId + "|" + e.market;
    if (e.skip) {
      skip("copy: " + e.skip);
      continue;
    }
    if ((memory.copyRetryAt.get(id) || 0) > now) {
      skip("copy: waiting after a failed publish");
      continue;
    }
    if ((memory.copyTries.get(id) || 0) >= MAX_TRIES_PER_DAY) {
      skip("copy: failed " + MAX_TRIES_PER_DAY + " times today");
      continue;
    }
    // Today's copies, and today's publishes that may be live: both are offers
    // this lister put (or may have put) on the market.
    if (made == null) {
      made = (await copiesMadeSince(d, dayStart)) + records.filter((x) => x.rec.at >= dayStart.getTime()).length;
    }
    if (made >= c.copiesPerDay) {
      skip("copy: daily limit reached");
      break;
    }
    try {
      out.copies.push(await copyOne(e, c, d, dryRun, now));
      if (!dryRun) break; // one copy a pass
    } catch (err) {
      const msg = (err && err.message) || String(err);
      out.errors.push(e.game + " (" + e.market + " copy): " + msg);
      console.error("autofarmOffers: " + e.game + " was not copied to " + e.market + ": " + msg);
      const held = !!(err && err.hold);
      // The market cannot take this game as things stand (no offer of ours to
      // copy its fields from, no product): asking again tomorrow changes nothing.
      const unlistable = /no offer of our own to copy|cannot be listed there|no delivery method available/i.test(msg);
      memory.copyRetryAt.set(id, now + (held ? 24 * HOUR_MS : unlistable ? 7 * 24 * HOUR_MS : RETRY_AFTER_MS));
      memory.copyTries.set(id, (memory.copyTries.get(id) || 0) + 1);
      if (held) memory.copyPauseUntil = now + COPY_PAUSE_MS;
      if (held && !err.told) {
        try {
          Promise.resolve(
            d.sendTelegram(
              "⚠️ Auto-farm unclaimed copy for " + e.game + " on " + e.market +
                (err.hold === "orphan"
                  ? " went live but was not recorded — take it down by hand.\n"
                  : " may have gone live without being recorded — check " + e.market + " for a stray offer.\n") +
                msg + "\nIt will not be tried again by itself.",
            ),
          ).catch(() => {});
        } catch {
          /* the notice is best-effort */
        }
      }
      // One attempt a pass, whatever became of it: a market that refuses one
      // copy is not asked for the next in the same breath.
      if (!dryRun) break;
    }
  }
}

// Publish one copy: the SAME set as the Eldorado offer, on `e.market`.
async function copyOne(e, c, d, dryRun, now = Date.now()) {
  const set = e.set;
  const { title, description } = offerText(d, e.market, e.game, e.campaign, set.items || [], e.goneAt);
  if (!title.trim()) throw new Error("no title for the bundle");
  const { engine, basis } = await enginePrice(d, e.market, e.game, (set.items || []).length);
  const price = copyPrice(engine, e.eldoradoPrice, e.market, c);
  const vault = e.kind === "vault";
  // A shelf copy: the publish itself advertises this offer's SHARE of the
  // shelf. A held chain: its units, one listing at a time.
  const quantity = vault ? c.vaultUnits : Math.max(1, Math.min(e.cover, c.quantityCap));
  const summary = {
    market: e.market, game: e.game, title, price, enginePrice: engine, basis, quantity,
    items: (set.items || []).length, holders: e.cover, setId: e.setId,
    claimBefore: Number.isFinite(e.goneAt) ? new Date(e.goneAt).toISOString() : null,
  };
  if (dryRun) return { ...summary, dryRun: true };
  let cover = "";
  if (COPY_NEEDS_COVER[e.market]) {
    try {
      cover = await d.buildCover(set);
    } catch {
      cover = "";
    }
    if (!cover) throw new Error("no cover image could be built");
  }
  const dropCover = () =>
    cover
      ? Promise.resolve()
          .then(() => d.unlink(cover))
          .catch(() => {})
      : Promise.resolve();
  // Written BEFORE the publish, on the note the plan read (compare-and-set, so
  // two passes can never copy one set at once): if this process dies between
  // the market accepting the offer and the row being saved, the record is what
  // stops a restart from publishing a second copy. It comes off again when the
  // publish has an answer.
  const before = str(set.note);
  const started = holdNote(
    before,
    copyRecordText(e.market, now, COPY_STARTED + " — check " + e.market + " for a stray offer"),
  );
  let lock = null;
  try {
    lock = await d.DropSet.updateOne({ _id: set._id, note: before }, { $set: { note: started } });
  } catch (err) {
    await dropCover();
    throw err;
  }
  if (!(lock && (lock.modifiedCount || lock.nModified))) {
    await dropCover();
    throw new Error("the set changed while its copy was being prepared");
  }
  // Put the note back as it was (twice: the record must not outlive a publish
  // that ended cleanly, or the set never gets its copy).
  const unlock = async () => {
    for (let i = 0; i < 2; i++) {
      try {
        await d.DropSet.updateOne({ _id: set._id, note: started }, { $set: { note: before } });
        return;
      } catch (err) {
        console.error("autofarmOffers: the copy record on set " + str(set._id) + " could not be cleared:", err && err.message);
      }
    }
  };
  let r;
  try {
    r = await d.nl().publishNoclaim(e.market, {
      set,
      body: { [e.market]: { qty: quantity } },
      title,
      description,
      priceUsd: price,
      gridImage: cover,
      coverPath: "",
      cat: e.category || {},
      pubGame: d.listingGame({ set }),
    });
  } catch (err) {
    r = { success: false, message: (err && err.message) || String(err) };
  } finally {
    await dropCover();
  }
  if (!r || !r.success) {
    const msg = (r && r.message) || "the publish failed";
    const hold = ORPHAN_RE.test(msg) ? "orphan" : COPY_MAYBE[e.market].test(msg) ? "maybe" : "";
    if (hold) {
      // The copy is, or may be, live with no row: an order against it would
      // reach nothing. The set's note is the record that outlives a restart —
      // no copy of it is tried again (and its Eldorado offer is untouched).
      // Should this write fail, the record made before the publish stands.
      await d.DropSet.updateOne(
        { _id: set._id },
        { $set: { note: holdNote(before, copyRecordText(e.market, now, msg)) } },
      ).catch(() => {});
    } else {
      await unlock();
    }
    const err = new Error(msg);
    err.hold = hold;
    // Gameflip's lane pages the owner itself when it keeps an account held.
    err.told = vault && hold === "maybe";
    throw err;
  }
  await unlock();
  // What tells this row from one the owner published by hand (sweepCopies).
  let tagged = false;
  for (let i = 0; i < 2 && !tagged; i++) {
    try {
      await d.MarketplaceListing.updateOne({ _id: r.id }, { $set: { note: (str(r.note) || "no-claim auto-delivery") + COPY_MARK } });
      tagged = true;
    } catch (err) {
      console.error("autofarmOffers: the " + e.market + " copy " + r.externalId + " could not be marked as a copy:", err && err.message);
    }
  }
  const made = { ...summary, listingId: str(r.id), externalId: str(r.externalId), url: str(r.url), tagged };
  console.log(
    "autofarmOffers: copied " + title + " to " + e.market + " at $" + price.toFixed(2) + " × " + quantity +
      " (offer " + made.externalId + ")",
  );
  try {
    Promise.resolve(
      d.logEvent({
        category: "noclaim_shop",
        action: "autofarm_offer_copied",
        actor: "autofarmOffers",
        severity: tagged ? "info" : "warn",
        subject: title,
        game: e.game,
        count: quantity,
        detail:
          "auto-farm unclaimed offer also listed on " + e.market + ": " + (set.items || []).length + " item(s) at $" +
          price.toFixed(2) + " (engine $" + engine.toFixed(2) + (basis ? ", " + basis : "") + "), " + e.cover +
          " free account(s) hold it" +
          (vault ? " — a chain of " + quantity + ", one account held at a time" : "") +
          (tagged ? "" : " — NOT marked as a copy" + (vault ? "" : ": it will not follow its Eldorado offer")),
      }),
    ).catch(() => {});
    Promise.resolve(
      d.sendTelegram(
        "🆕 ALSO LISTED on " + e.market.toUpperCase() + " (auto-farm unclaimed stock)\n\n" + title + "\n$" +
          price.toFixed(2) +
          (vault
            ? " — " + quantity + " unit(s), one account held at a time (" + e.cover + " hold the bundle)"
            : " — the same accounts as the Eldorado offer (" + e.cover + " hold it)"),
      ),
    ).catch(() => {});
  } catch {
    /* the notice is best-effort */
  }
  return made;
}

// The title and description of an offer for `items` on `market`. The title is
// "" when none could be built.
function offerText(d, market, game, campaign, items, goneAt) {
  const max = COPY_TITLE_MAX[market] || TITLE_MAX;
  const drops = [];
  for (const it of items || []) {
    for (let i = 0; i < copiesOf(it); i++) drops.push({ name: it.name, game: it.game, itemKey: it.itemKey, imageURL: it.image });
  }
  const ual = d.ual();
  const title = fullTitle(game, campaign, items, max) || str(ual.listingTitle(game, drops, null)).slice(0, max);
  let description = str(ual.listingDescription(game, drops, market, null));
  if (Number.isFinite(goneAt)) {
    // A day before the copies are due to leave, to the minute and in UTC —
    // the moment the offer itself comes off sale, so the line is never in the
    // past while a buyer can still read it.
    const line =
      "\n\n⏳ These drops are unclaimed: connect your game account and claim them right after " +
      "delivery. Twitch removes unclaimed drops about a week after the event ends — claim these before " +
      utcStamp(goneAt - 24 * HOUR_MS) + ".";
    description = description.slice(0, DESCRIPTION_MAX - line.length) + line;
  }
  return { title, description };
}

// What the pricing engine reads off our own sales for this game on `market`.
async function enginePrice(d, market, game, itemCount) {
  try {
    const ev = await d.pricingEvidence().evidenceFor({ game, marketplace: market });
    const r = d.pricing().priceListing({ evidence: ev, itemCount, marketplace: market });
    return { engine: Number(r && r.price) || 0, basis: str(r && r.basis) };
  } catch (e) {
    console.error("autofarmOffers: pricing for " + game + " on " + market + " failed:", e && e.message);
    return { engine: 0, basis: "" };
  }
}

async function publishOne(p, reuse, c, d, dryRun) {
  const { title, description } = offerText(d, MARKET, p.game, p.campaign, p.items, p.goneAt);
  if (!title.trim()) throw new Error("no title for the bundle");
  const { engine, basis } = await enginePrice(d, MARKET, p.game, p.items.length);
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
  // rule 8
  COPY_MARKETS,
  COPY_KIND,
  COPY_MARK,
  SWEPT_MARK,
  copyPrice,
  holdNote,
  copyRecord,
  ownSet,
  planCopies,
  sweepCopies,
};
