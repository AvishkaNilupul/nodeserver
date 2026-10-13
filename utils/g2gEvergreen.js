// Evergreen G2G offers — one long-lived bundle offer per game, rewritten in place.
//
// WHY THIS EXISTS
//
// G2G orders its lists by the seller's rank and by each OFFER's own sales and
// ratings. We are on the lowest seller rank, so an offer of ours that never
// sold sits at the bottom of its game (score 3.9), while the few that did sell
// and were rated sit near the top (Halo 1st and 2nd of 36). Every bundle used
// to get its own offer, so that standing died with the bundle: on 2026-10-13
// the Brawlhalla offer with 14 sales was off sale, sold out for good, while a
// dozen never-sold offers of the same game held the shelf.
//
// Owner, 2026-10-13: fewer, stronger offers — one per game per product, and
// the SAME offer is rewritten when the drops change, so it keeps its sold
// count and its rating.
//
// WHAT IT DOES
//
//   rescue   an offer that HAS SOLD and that the stock sync took off sale for
//            want of stock is rewritten to the biggest bundle of its game we
//            can still deliver, and put back on sale. A never-sold offer that
//            already sold that bundle comes down with it. This is the only
//            thing the server does by itself (evergreenPass, after every stock
//            sync).
//   keep     the biggest bundle we can deliver is on    } only when an operator
//            the shelf, even when it never sold.        } runs the plan
//   retire   every other never-sold offer comes down.   } (scripts/
//   upgrade  the game's best-selling offer moves up to  } g2g-evergreen.js);
//            a bigger bundle that contains everything   } upgrade and publish
//            it sells now.                              } only when asked for
//   publish  a game's biggest bundle gets an offer.     }
//
// SAFETY
//
//   - Only offers this system made and that claim their account when an order
//     lands (origin "auto", autoClaimSet + set). The auto-lister's reserved
//     shares, no-claim copies, account listings, bulk packs, rent-farm offers
//     and anything made by hand are never rewritten or retired here. Neither
//     is an offer whose title on G2G is no longer the one on our row (edited
//     by hand), nor one G2G itself shows a sale or a rating on (retire).
//   - An offer is rewritten while it is OFF sale, with its row PARKED (closed)
//     so that nothing can relist it meanwhile; the new text and price are read
//     back from G2G, and only then does the row follow. So nobody can pay for
//     the old text and be handed the new bundle — not after a throw, a crash
//     or a restart half-way either: recoverParked() puts such a row back on
//     its old bundle, and when the old text cannot be confirmed the row stays
//     closed and the owner is paged.
//   - Never while a paid order waits on the offer or a unit of its row is mid
//     hand-over. An order that only shows up afterwards is held for a hand-over
//     by delivery itself (g2gFulfiller.orderPredatesRewrite, off `rebundledAt`).
//   - Prices are never made up and never bent. A bundle goes on an offer at
//     the price it already has (the offer it is taken over from, else its
//     set's own), and ONLY when that is no more than the offer costs now. A
//     bundle that costs more is not moved to: it is named, and left to the
//     owner. Nothing here raises a price or sells a bundle under its own.
//   - A new bundle needs MIN_STOCK accounts behind it. One bundle, one offer:
//     a bundle that is on the shelf already is never given to a second offer.
//   - A plan never leaves a game with nothing of ours on sale, and retires
//     nothing when a bundle on the shelf could not be counted.
//   - Kill switch: autoFarm.g2gEvergreen (the server pass runs only when true).

const MIN_STOCK = 5;
const MIN_PAUSED_MS = 30 * 60 * 1000;
// A game with nothing else to move to is not looked at again for this long.
const NOTHING_REST_MS = 6 * 60 * 60 * 1000;
const MAX_REWRITES_PER_PASS = 2;
const MAX_GAMES_PER_PASS = 3;
// How many candidate bundles get the exact (slow) stock count, per game.
const MAX_EXACT_COUNTS = 25;
// G2G's lists trail a status change by a few seconds.
const STATUS_TRIES = 6;
const STATUS_WAIT_MS = 4000;
const NOTE_MAX = 1000;
// G2G caps a quantity nowhere we know of; an archive offer advertises at most this.
const MAX_QTY = 200;
// A game whose rewrite was refused or failed is left alone this long.
const RETRY_REST_MS = 60 * 60 * 1000;
// On the lastError of a row that is parked (status "delisted") for the seconds
// a rewrite takes: "<mark><ISO time> -> set <id>". See rewriteOffer.
const PARK_MARK = "evergreen: rewriting — ";
const PARK_RE = /^evergreen: rewriting — /;
// A parked row older than this was left by a rewrite that never finished.
const PARK_STALE_MS = 10 * 60 * 1000;

const state = { running: false, lastRun: null, lastSummary: "", rested: new Map() };

// ---------------------------------------------------------------------------
// Pure helpers (tested)
// ---------------------------------------------------------------------------

function str(v) {
  return v == null ? "" : String(v);
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function copiesOf(it) {
  const q = Math.floor(Number(it && it.qty));
  return Number.isFinite(q) && q >= 1 ? q : 1;
}

// A stored itemKey wins, else "name|game" — the archive's own key rule.
function keyOfItem(it) {
  if (!it) return "";
  const stored = str(it.itemKey).trim().toLowerCase();
  if (stored) return stored;
  const k = str(it.name).trim().toLowerCase() + "|" + str(it.game).trim().toLowerCase();
  return k === "|" ? "" : k;
}

// Map<key, copies> of an item list.
function needsOf(items) {
  const out = new Map();
  for (const it of items || []) {
    const k = keyOfItem(it);
    if (k) out.set(k, (out.get(k) || 0) + copiesOf(it));
  }
  return out;
}

// Order-free identity of a bundle: the same keys in the same numbers.
function itemsSignature(items) {
  return [...needsOf(items).entries()]
    .map(([k, q]) => k + "×" + q)
    .sort()
    .join("\n");
}

// True when bundle `big` hands over everything bundle `small` promises.
function containsAll(big, small) {
  const b = needsOf(big);
  const s = needsOf(small);
  if (!s.size) return false;
  for (const [k, q] of s) if ((b.get(k) || 0) < q) return false;
  return true;
}

function setGame(set) {
  const first = ((set && set.items) || []).find((i) => i && str(i.game).trim());
  return str((set && set.coverGame) || (first && first.game)).trim();
}

// A unit is the buyer's once the credential went out; "mid" while an order
// holds it and nothing has been sent.
function unitState(u) {
  if (!u) return "none";
  if (u.messagedAt || u.deliveredAt) return "sold";
  if (u.orderId) return "mid";
  return "free";
}

function timeOf(v) {
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) ? t : 0;
}

// How a row sells, which decides whether this file may touch it.
function shapeOf(row) {
  if (!row) return "none";
  if (row.bulkOfferId) return "bulk";
  if (row.accountOffer) return "accountOffer";
  if (row.noclaimStock) return "noclaim";
  if (row.unclaimedGame) return "bygame";
  if (row.autoClaimSet && row.set) return "archive";
  if ((row.units || []).length) return "units";
  return "other";
}

// What the plan needs to know of one G2G row. `set` is the row's DropSet (or
// null). Only an "archive" row this system made is `managed`.
function rowFacts(row, set, now = Date.now()) {
  const units = (row && row.units) || [];
  const shape = shapeOf(row);
  const items = (set && set.items) || [];
  let lastSoldAt = 0;
  for (const u of units) lastSoldAt = Math.max(lastSoldAt, timeOf(u && (u.messagedAt || u.deliveredAt)));
  return {
    offerId: str(row && row.externalId),
    rowId: str(row && row._id),
    setId: str(row && row.set),
    title: str(row && row.title),
    description: str(row && row.description),
    price: Number(row && row.price) || 0,
    shape,
    // origin "auto" exactly: a row with no origin, or another one, is treated
    // as somebody's own.
    managed: shape === "archive" && str(row.origin) === "auto" && row.status === "active",
    sold: units.filter((u) => unitState(u) === "sold").length,
    lastSoldAt,
    mid: units.some((u) => unitState(u) === "mid"),
    paused: !!(row && row.autoPaused),
    pausedMs: Math.max(0, now - timeOf(row && row.updatedAt)),
    // Filled in by the caller for a paused row it wants judged: how many
    // accounts could deliver its bundle now (null = could not count).
    stock: null,
    items,
    sig: itemsSignature(items),
    size: needsOf(items).size,
  };
}

// The price a bundle goes on an offer at: the price it already has — the offer
// it is taken over from, else its set — and never under the market's floor.
// It is NOT bent to fit the offer: a bundle that costs more than the offer does
// is not moved to at all (see planGame), because what an offer costs more than
// before, and what a big bundle may be sold under its price for, are both the
// owner's to say.
function priceFor(pick, twin, floor) {
  const own = twin && twin.price > 0 ? twin.price : pick.price;
  if (!(own > 0)) return 0;
  return round2(Math.max(Number(floor) || 0, own));
}

const PRICE_EPS = 0.005;

const bySize = (a, b) =>
  b.size - a.size || b.total - a.total || b.stock - a.stock || str(a.setId).localeCompare(str(b.setId));

// The plan for ONE game. Pure.
//   rows — rowFacts() of every active G2G row of the game
//   sets — the game's bundles we could move to: [{ setId, sig, size, total,
//          stock, price, items, name }], one per signature, stock counted the
//          way the stock sync counts it
//   opts — { rescue, upgrade, keepBest, retire, publish } (which steps),
//          minStock, minPausedMs, floor (the market's least price),
//          publishPrice (an operator's price for a published bundle),
//          incomplete (a bundle on the shelf could not be counted)
// Returns { actions, notes }. Actions, in the order they are to be done:
//   { type:"rewrite", kind:"rescue"|"upgrade", sameBundle, offerId, rowId,
//     fromSet, toSet, sig, title?, description?, price, absorb }
//       sameBundle — the same items under another set that has stock: only the
//                    row moves, the text stays
//       absorb     — a never-sold offer of that bundle, which comes down once
//                    this one carries it
//   { type:"publish", toSet, price }
//   { type:"retire", offerId, rowId, why }
function planGame(rows, sets, opts = {}) {
  const minStock = opts.minStock == null ? MIN_STOCK : opts.minStock;
  const minPausedMs = opts.minPausedMs == null ? MIN_PAUSED_MS : opts.minPausedMs;
  const floor = Number(opts.floor) || 0;
  const actions = [];
  const notes = [];
  const note = (r, why) => notes.push({ offerId: r ? r.offerId : "", title: r ? r.title : "", why });

  const managed = (rows || []).filter((r) => r.managed);
  const others = (rows || []).filter((r) => !r.managed);
  const flagships = managed
    .filter((r) => r.sold > 0)
    .sort((a, b) => b.sold - a.sold || b.lastSoldAt - a.lastSoldAt || a.offerId.localeCompare(b.offerId));
  const never = managed.filter((r) => r.sold === 0);

  // Bundles a kept offer sells right now, by signature. A never-sold managed
  // offer is not "kept" yet: its bundle is free to be taken over.
  // (An offer the sync paused whose bundle has stock again is coming back by
  // itself, so its bundle counts as on the shelf too.)
  const onShelf = new Map();
  for (const r of [...flagships, ...others]) {
    if ((!r.paused || r.stock > 0) && r.sig && !onShelf.has(r.sig)) onShelf.set(r.sig, r);
  }
  const candidates = (sets || [])
    .filter((s) => s && s.sig && s.stock >= minStock && s.price > 0)
    .sort(bySize);
  const absorbed = new Set(); // never-sold offers a rewrite takes over
  const twinOf = (sig) => never.find((r) => r.sig === sig && !r.mid && !absorbed.has(r.offerId)) || null;
  const ownPrice = (s) => priceFor(s, twinOf(s.sig), floor);
  const give = (offer, pick, kind, sameBundle = false) => {
    const twin = sameBundle ? null : twinOf(pick.sig);
    actions.push({
      type: "rewrite",
      kind,
      sameBundle,
      offerId: offer.offerId,
      rowId: offer.rowId,
      fromSet: offer.setId,
      fromTitle: offer.title,
      fromPrice: offer.price,
      toSet: pick.setId,
      sig: pick.sig,
      // The text the bundle is already sold under, when it has an offer.
      title: sameBundle ? offer.title : twin ? twin.title : "",
      description: sameBundle ? offer.description : twin ? twin.description : "",
      price: sameBundle ? offer.price : priceFor(pick, twin, floor),
      size: pick.size,
      stock: pick.stock,
      absorb: twin ? twin.offerId : "",
    });
    // The bundle is on the shelf from here on: no later pick may take it.
    if (onShelf.get(offer.sig) === offer) onShelf.delete(offer.sig);
    onShelf.set(pick.sig, offer);
    if (twin) absorbed.add(twin.offerId);
  };

  if (opts.rescue) {
    for (const f of flagships) {
      if (!f.paused) continue; // on sale: this step never touches it
      if (f.stock == null) {
        note(f, "its stock could not be counted");
        continue;
      }
      if (f.stock > 0) continue; // the stock sync puts it back by itself
      if (f.mid) {
        note(f, "an order is mid hand-over on it");
        continue;
      }
      if (f.pausedMs < minPausedMs) {
        note(f, "off sale for under " + Math.round(minPausedMs / 60000) + " min");
        continue;
      }
      // The same bundle, written down as another set that still has accounts
      // behind it: the offer stays word for word what it is.
      const same = candidates.find((s) => s.sig === f.sig && s.setId !== f.setId);
      if (same) {
        give(f, same, "rescue", true);
        continue;
      }
      const free = candidates.filter((s) => s.sig !== f.sig && !onShelf.has(s.sig));
      const pick = free.find((s) => ownPrice(s) <= f.price + PRICE_EPS);
      if (!pick) {
        note(
          f,
          free.length
            ? "every bundle it could move to costs more than it does ($" + f.price + "; the biggest: " + free[0].size +
                " items at $" + ownPrice(free[0]) + ") — a price for the owner to set"
            : "no other bundle of this game has " + minStock + "+ accounts behind it",
        );
        continue;
      }
      if (free[0] !== pick) {
        note(
          f,
          "a bigger bundle (" + free[0].size + " items) costs $" + ownPrice(free[0]) + ", more than this offer's $" + f.price +
            " — left to the owner; moved to the biggest one within its price",
        );
      }
      give(f, pick, "rescue");
    }
  }

  if (opts.upgrade) {
    const top = flagships[0];
    const moved = top && actions.some((a) => a.offerId === top.offerId);
    // Never onto a thinner shelf: the bigger bundle must have at least as many
    // accounts behind it as the one it replaces (unknown = not moved).
    if (top && !top.paused && !top.mid && !moved && top.stock != null) {
      const bigger = candidates.filter(
        (s) =>
          s.size > top.size &&
          s.stock >= top.stock &&
          s.sig !== top.sig &&
          !onShelf.has(s.sig) &&
          containsAll(s.items, top.items),
      );
      const pick = bigger.find((s) => ownPrice(s) <= top.price + PRICE_EPS);
      if (pick) give(top, pick, "upgrade");
      else if (bigger.length) {
        note(top, "it could carry " + bigger[0].size + " items instead of " + top.size + ", at $" + ownPrice(bigger[0]) + " against its $" + top.price + " — a price for the owner to set");
      }
    }
  }

  if (opts.keepBest || opts.retire || opts.publish) {
    // The biggest bundle we can deliver belongs on the shelf. What counts as
    // "on the shelf" here is an offer WITH SALES that is selling: a reserved
    // share with one account left, or a no-claim copy, is no reason to take
    // the game's archive offers down. When no such offer carries a bundle that
    // big: with `publish`, an offer is made for it (unless a never-sold one
    // already sells it, which is then kept); without, the never-sold offer on
    // sale with the biggest deliverable bundle is kept.
    const movedTo = (f) => actions.some((a) => a.type === "rewrite" && a.offerId === f.offerId);
    const selling = flagships.filter((f) => !f.paused || f.stock > 0 || movedTo(f));
    let shelfMax = 0;
    for (const f of selling) shelfMax = Math.max(shelfMax, sizeOnShelf(f, actions));
    const open = candidates.filter((s) => !onShelf.has(s.sig) && s.size > shelfMax);
    const carrier = (c) => never.find((r) => r.sig === c.sig && !r.paused && !absorbed.has(r.offerId)) || null;
    const best = open[0] || null;
    let keep = null;
    let published = false;
    if (best && (opts.keepBest || opts.publish)) {
      keep = carrier(best);
      if (!keep && opts.publish) {
        const price = round2(Math.max(floor, Number(opts.publishPrice) > 0 ? Number(opts.publishPrice) : best.price));
        actions.push({ type: "publish", toSet: best.setId, sig: best.sig, name: best.name, price, size: best.size, stock: best.stock });
        published = true;
      } else if (!keep) {
        note(null, "the biggest bundle we can deliver (" + best.size + " items, " + best.stock + " accounts) has no offer");
        for (const c of open) {
          keep = carrier(c);
          if (keep) break;
        }
      }
    }
    // A game is never left with nothing of ours on sale: with no selling offer
    // that has sales, nothing kept and nothing published, the biggest
    // never-sold offer still on sale stays — whatever stands behind it.
    if (!keep && !published && !selling.length) {
      keep =
        never
          .filter((r) => !r.paused && !absorbed.has(r.offerId))
          .sort((a, b) => b.size - a.size || a.offerId.localeCompare(b.offerId))[0] || null;
    }
    if (opts.retire && opts.incomplete) {
      note(null, "a bundle on the shelf could not be counted — nothing is retired this time");
    } else if (opts.retire) {
      for (const r of never) {
        if (absorbed.has(r.offerId)) continue; // comes down with its rewrite
        if (keep && r.offerId === keep.offerId) {
          note(r, "kept: the biggest bundle we can deliver (" + r.size + " items)");
          continue;
        }
        if (r.mid) {
          note(r, "an order is mid hand-over on it");
          continue;
        }
        actions.push({
          type: "retire",
          offerId: r.offerId,
          rowId: r.rowId,
          title: r.title,
          why: onShelf.has(r.sig)
            ? "another offer already sells this bundle"
            : r.paused
              ? "never sold, and nothing left to deliver"
              : "never sold",
        });
      }
    }
  }
  return { actions, notes };
}

// The size a kept offer has on the shelf once this plan's rewrites are done.
function sizeOnShelf(row, actions) {
  const moved = actions.find((a) => a.type === "rewrite" && a.offerId === row.offerId);
  return moved ? moved.size : row.size;
}

// ---------------------------------------------------------------------------
// Dependencies (injectable for tests)
// ---------------------------------------------------------------------------

function realDeps() {
  const mp = require("./marketplaces");
  return {
    settings: require("./settings"),
    MarketplaceListing: require("../models/MarketplaceListing"),
    DropSet: require("../models/DropSet"),
    mp,
    floor: mp.G2G_MIN_PRICE,
    brandForGame: (game) => require("./g2gGames").brandForGame(game),
    isNoClaimGame: (game) => require("./settings").isNoClaimGame(game),
    stockForSets: (sets) => require("../routes/shopRoutes").stockForSets(sets),
    availableAccountsForSet: (set) => require("../routes/shopRoutes").availableAccountsForSet(set),
    listedLogins: () => require("./listedLogins").loginsOnActiveListings(),
    notListed: (avail, listed) => require("./listedLogins").notListed(avail, listed),
    realStockFor: (row, listed) => require("./g2gFulfiller").realStockFor(row, listed),
    // House copy for a bundle on G2G, exactly what scripts/g2g-bundle-listings
    // writes for a set.
    text: (set, game) => {
      const al = require("./autoLister");
      const items = (set.items || []).map((i) => (i && typeof i.toObject === "function" ? i.toObject() : i));
      return {
        title: al.buildTitle({ game, items, campaignName: set.name }),
        description: al.buildDescription({ game, items, campaignName: set.name, postEvent: false, marketplace: "g2g" }),
      };
    },
    logEvent: (fields) => require("./systemLog").logEvent(fields),
    sendTelegram: (text) => require("./telegram").sendTelegram(text),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

// G2G delivery and its stock sync really running: an offer put on sale, or
// left "for the stock sync", is only safe when both are.
function g2gIsLive(d) {
  const af = (d.settings.getAutoFarm && d.settings.getAutoFarm()) || {};
  return af.g2gAutoDeliver === true && af.g2gDeliverDryRun === false && af.g2gSyncStock !== false;
}

// ---------------------------------------------------------------------------
// Reading the shelf
// ---------------------------------------------------------------------------

function brandKey(d, game) {
  const b = game ? d.brandForGame(game) : null;
  return b && b.brandId ? str(b.brandId) : "";
}

// Every active G2G row, grouped by the game's G2G brand:
// Map<brandId, { game, labels:Set, rows:[rowFacts], docs:Map<offerId,row>,
// sets:Map<setId,set> }>.
async function readShelf(d, now) {
  const rows = await d.MarketplaceListing.find({ marketplace: "g2g", status: "active" }).lean();
  const setIds = [...new Set((rows || []).map((r) => str(r.set)).filter(Boolean))];
  const sets = setIds.length
    ? await d.DropSet.find(
        { _id: { $in: setIds } },
        { name: 1, items: 1, coverGame: 1, price: 1, minPriceUsd: 1, stockSource: 1, accountScopeLogins: 1, accountScopeIds: 1 },
      ).lean()
    : [];
  const setById = new Map((sets || []).map((s) => [str(s._id), s]));
  const games = new Map();
  for (const r of rows || []) {
    const set = setById.get(str(r.set)) || null;
    const game = setGame(set);
    const key = brandKey(d, game);
    if (!key) continue; // no set, or a game G2G does not list: not ours to judge
    let g = games.get(key);
    if (!g) {
      g = { brandId: key, game, labels: new Set(), rows: [], docs: new Map(), sets: new Map() };
      games.set(key, g);
    }
    for (const it of (set && set.items) || []) if (it && str(it.game).trim()) g.labels.add(str(it.game).trim());
    if (game) g.labels.add(game);
    g.rows.push(rowFacts(r, set, now));
    g.docs.set(str(r.externalId), r);
    if (set) g.sets.set(str(set._id), set);
  }
  return games;
}

function escapeRe(s) {
  return str(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The game's bundles we could move an offer to: archive sets whose every item
// is of this game, priced, one per signature, with at least `minStock`
// accounts that could deliver them — counted the way the stock sync counts.
// Returns { cands, incomplete }: `incomplete` when a set that one of our own
// offers carries could not be counted, so "nothing behind it" is not known.
async function candidateSets(d, game, { labels, onG2g, listed, want, minStock }) {
  const names = [...new Set([game, ...(labels || [])].map((l) => str(l).trim()).filter(Boolean))];
  if (!names.length) return { cands: [], incomplete: false };
  const key = brandKey(d, game);
  const found = await d.DropSet.find(
    { "items.game": { $in: names.map((n) => new RegExp("^" + escapeRe(n) + "$", "i")) } },
    // The account scope is part of a set's stock: both counts below read it.
    { name: 1, items: 1, coverGame: 1, price: 1, minPriceUsd: 1, stockSource: 1, accountScopeLogins: 1, accountScopeIds: 1, createdAt: 1 },
  ).lean();
  let cands = [];
  for (const s of found || []) {
    if (!s || s.stockSource === "noclaim") continue;
    const items = (s.items || []).filter(Boolean);
    if (!items.length) continue;
    // Every item of this game — a mixed "everything" account is another product.
    if (!items.every((i) => brandKey(d, i.game) === key)) continue;
    const price = Number(s.price) > 0 ? Number(s.price) : Number(s.minPriceUsd) || 0;
    if (!(price > 0)) continue;
    const sig = itemsSignature(items);
    if (!sig) continue;
    cands.push({
      setId: str(s._id),
      set: s,
      sig,
      items,
      name: str(s.name),
      size: needsOf(items).size,
      total: items.reduce((a, i) => a + copiesOf(i), 0),
      price,
      onG2g: !!(onG2g && onG2g.has(str(s._id))),
      at: timeOf(s.createdAt),
      stock: 0,
    });
  }
  if (!cands.length) return { cands: [], incomplete: false };
  // One aggregation for a first count (it does not yet leave out accounts that
  // are attached to a live listing elsewhere, so it can only be too high).
  const rough = await d.stockForSets(cands.map((c) => c.set));
  for (const c of cands) c.stock = Number((rough.get(c.setId) || {}).stock) || 0;
  // The same bundle is often written down as several sets — the catalog's is
  // tied to the accounts it was built from, a campaign's is not. One per
  // bundle: the one most accounts can deliver, then one an offer of ours
  // already carries, then the newest.
  const bySig = new Map();
  const shelfSigs = new Set();
  for (const c of cands) {
    if (c.onG2g) shelfSigs.add(c.sig);
    const cur = bySig.get(c.sig);
    if (
      !cur ||
      c.stock > cur.stock ||
      (c.stock === cur.stock && c.onG2g && !cur.onG2g) ||
      (c.stock === cur.stock && c.onG2g === cur.onG2g && c.at > cur.at)
    ) {
      bySig.set(c.sig, c);
    }
  }
  cands = [...bySig.values()].filter((c) => c.stock >= minStock).sort(bySize);
  // The exact count, biggest first, until enough bundles are known good. A
  // bundle one of our own offers carries is ALWAYS counted, whatever the
  // limits: a plan must never call it empty because it ran out of counts.
  const out = [];
  let counted = 0;
  let incomplete = false;
  for (const c of cands) {
    const ours = shelfSigs.has(c.sig);
    if (!ours && (out.length >= want || counted >= MAX_EXACT_COUNTS)) continue;
    counted++;
    let avail = null;
    try {
      avail = await d.availableAccountsForSet(c.set);
    } catch {
      avail = null;
    }
    if (!avail) {
      if (ours) incomplete = true; // could not count: not a bundle to move anything to
      continue;
    }
    c.stock = d.notListed(avail, listed || new Set()).length;
    if (c.stock >= minStock) out.push(c);
  }
  return { cands: out, incomplete };
}

// ---------------------------------------------------------------------------
// Acting on G2G
// ---------------------------------------------------------------------------

// What G2G shows for one offer. Never throws: { status } is "live", "delisted"
// or "unreadable (…)". G2G answers 404 for an offer that is off sale, so a
// delisted one is looked up in the account's delisted list — which gives its
// title and price, and nothing else. A live read also carries G2G's OWN count
// of the offer's sales and ratings.
async function offerOnG2g(d, offerId) {
  try {
    const o = (await d.mp.g2gGetOffer(offerId)) || {};
    return {
      status: str(o.status),
      title: str(o.title),
      description: str(o.description),
      price: Number(o.unit_price),
      qty: Number(o.actual_qty),
      sold: Number(o.total_success_order) || 0,
      ratings: Number(o.total_rating) || 0,
    };
  } catch (e) {
    try {
      const off = await d.mp.g2gListOffers({ pageSize: 100, maxPages: 10, status: d.mp.G2G_STATUS.DELISTED });
      const hit = (off || []).find((o) => str(o.offerId) === str(offerId));
      if (hit) return { status: "delisted", title: str(hit.title), price: Number(hit.unitPrice), description: null, qty: null };
      return { status: "unreadable (" + str(e && e.message) + ")" };
    } catch (e2) {
      return { status: "unreadable (" + str(e2 && e2.message) + ")" };
    }
  }
}

// Ask until G2G shows what `ok` wants, a few seconds apart. Never throws.
async function waitFor(d, offerId, ok) {
  let seen = null;
  for (let t = 1; t <= STATUS_TRIES; t++) {
    seen = await offerOnG2g(d, offerId);
    if (ok(seen)) return { ok: true, seen };
    if (t < STATUS_TRIES) await d.sleep(STATUS_WAIT_MS);
  }
  return { ok: false, seen };
}

const sameTitle = (a, b) => str(a).trim().slice(0, 128) === str(b).trim().slice(0, 128);
const samePrice = (a, b) => Math.abs(Number(a) - Number(b)) < PRICE_EPS;
// G2G strips what it does not store (emoji, measured 2026-10-13: a 1,794
// character description read back as 1,784), so two descriptions are the same
// when their letters and digits are: enough to tell one item list from another.
const wordsOf = (t) =>
  str(t)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const sameDescription = (a, b) => wordsOf(a) === wordsOf(b);

// Offers G2G lists a paid order for.
async function paidOffers(d) {
  const orders = (await d.mp.g2gPendingOrders()) || [];
  return new Set(orders.map((o) => str(o && o.offerId)).filter(Boolean));
}

function keepNewest(note) {
  const n = str(note);
  return n.length > NOTE_MAX ? "…" + n.slice(n.length - NOTE_MAX + 1) : n;
}

// Take a never-sold archive offer off the shelf for good: delist, read the
// status back, close the row if it is still active. It holds no accounts.
async function retireOffer(d, offerId, why, ctx = {}) {
  const row = await d.MarketplaceListing.findOne({ marketplace: "g2g", externalId: offerId }).lean();
  if (!row) return { error: "no listing row" };
  if (row.status !== "active") return { skipped: "row is already " + row.status };
  const f = rowFacts(row, null);
  if (!f.managed) return { skipped: "not an offer this file may retire (" + f.shape + ", origin " + (str(row.origin) || "none") + ")" };
  if (f.sold) return { skipped: "it has sold " + f.sold + " — kept" };
  if (f.mid) return { skipped: "an order is mid hand-over on it" };
  let paid = ctx.paid;
  if (!paid) {
    try {
      paid = await paidOffers(d);
    } catch (e) {
      return { skipped: "could not read G2G's paid orders (" + str(e && e.message) + ")" };
    }
  }
  if (paid.has(str(offerId))) return { skipped: "G2G lists a paid order for it" };
  // Our receipts are not the only record: an offer handed over outside the bot
  // has none. While it is on sale G2G says itself what the offer has sold, and
  // that standing is the one thing this file exists to keep.
  const seen = await offerOnG2g(d, offerId);
  if (seen.status === "live" && (seen.sold > 0 || seen.ratings > 0)) {
    return { skipped: "G2G itself shows " + seen.sold + " sale(s) and " + seen.ratings + " rating(s) on it — kept" };
  }
  if (seen.status !== "live" && seen.status !== "delisted") return { error: "G2G shows it " + seen.status };
  if (seen.status === "live") {
    await d.mp.g2gDelist(offerId);
    const w = await waitFor(d, offerId, (s) => s.status === "delisted");
    if (!w.ok) return { error: 'G2G still shows it "' + (w.seen && w.seen.status) + '" after the delist' };
  }
  const stamp = new Date(ctx.now || Date.now()).toISOString().slice(0, 10);
  const r = await d.MarketplaceListing.updateOne(
    { _id: row._id, status: "active" },
    {
      $set: {
        status: "delisted",
        autoPaused: false,
        lastError: "",
        note: keepNewest(str(row.note) + " — retired " + stamp + ": " + why),
      },
    },
  );
  if (!r || r.modifiedCount !== 1) return { error: "delisted on G2G, but the row was no longer active — look at it by hand" };
  return { retired: true };
}

// Rewrite one offer to another bundle. The order below IS the safety property.
//   action — a planGame "rewrite"; set — the DropSet it moves to
// Returns { rewritten:true, relisted, stock, title, price } or { skipped } /
// { error, parked? } — `parked`: the row was left closed and needs a human.
//
// While the rewrite runs the row is PARKED: status "delisted" with PARK_MARK in
// lastError. A parked row is in nobody's query — the stock sync cannot relist
// it, a second writer's compare-and-set misses it — and delivery still finds
// it. So a crash, a restart or a throw between "new text sent" and "row moved"
// leaves an offer that is off sale with a closed row, never one that can come
// back on sale carrying a text its row cannot deliver. recoverParked() puts
// such a row back at the start of the next pass.
async function rewriteOffer(d, action, set, ctx = {}) {
  const offerId = str(action.offerId);
  const now = ctx.now || Date.now();
  if (!set || !set._id) return { error: "the target set is gone" };
  const row = await d.MarketplaceListing.findOne({ marketplace: "g2g", externalId: offerId }).lean();
  if (!row) return { error: "no listing row" };
  const f = rowFacts(row, null);
  const upgrade = action.kind !== "rescue";
  if (row.status !== "active") return { skipped: "row is " + row.status };
  if (!f.managed) return { skipped: "not an offer this file may rewrite (" + f.shape + ", origin " + (str(row.origin) || "none") + ")" };
  if (str(row.set) !== str(action.fromSet)) return { skipped: "the row moved to another set since the plan" };
  if (f.mid) return { skipped: "an order is mid hand-over on it" };
  if (!upgrade && !row.autoPaused) return { skipped: "back on sale since the plan" };
  if (upgrade && row.autoPaused) return { skipped: "paused since the plan" };

  // The bundle as it is now: a set edited since the plan is another bundle.
  const target = await d.DropSet.findById(set._id).lean();
  if (!target || itemsSignature(target.items) !== (action.sig || itemsSignature(set.items))) {
    return { skipped: "the bundle's set changed since the plan" };
  }

  // What G2G shows before anything is touched — and what an undo puts back.
  const seen = await offerOnG2g(d, offerId);
  if (!upgrade && seen.status !== "delisted") return { skipped: "G2G shows it " + seen.status + " — left for the stock sync" };
  if (upgrade && seen.status !== "live") return { skipped: "G2G shows it " + seen.status + ", not on sale — left alone" };
  // The row is our copy; the owner can edit an offer on g2g.com or through the
  // price box, and neither writes the row. An offer whose title is not ours
  // any more is his; a price he changed is the price it has.
  if (!sameTitle(seen.title, row.title)) return { skipped: "its title on G2G is not the one on our row — edited by hand, left alone" };
  const priceNow = seen.price > 0 ? seen.price : row.price;
  const old = { title: row.title, description: seen.description != null ? seen.description : str(row.description || row.title), price: priceNow };

  const game = setGame(target);
  const text = action.sameBundle
    ? { title: row.title, description: old.description }
    : action.title
      ? { title: action.title, description: action.description }
      : d.text(target, game);
  const title = str(text.title).trim().slice(0, 128);
  const description = str(text.description || text.title);
  const price = action.sameBundle ? priceNow : round2(action.price);
  if (!title) return { error: "no title for the new bundle" };
  if (!(price > 0) || price < (Number(d.floor) || 0)) return { error: "no usable price for the new bundle" };
  if (price > priceNow + PRICE_EPS) {
    return { skipped: "the offer costs $" + priceNow + " on G2G, less than this bundle's $" + price + " — a price for the owner to set" };
  }

  // Paid orders, read NOW: an order that came in since the plan was made.
  let paid;
  try {
    paid = await paidOffers(d);
  } catch (e) {
    return { skipped: "could not read G2G's paid orders (" + str(e && e.message) + ")" };
  }
  if (paid.has(offerId)) return { skipped: "a paid order is waiting on this offer" };

  // 1. Park the row.
  const marker = PARK_MARK + new Date(now).toISOString() + " -> set " + str(target._id);
  const parked = await d.MarketplaceListing.updateOne(
    { _id: row._id, set: row.set, status: "active", autoPaused: !!row.autoPaused },
    { $set: { status: "delisted", lastError: marker } },
  );
  if (!parked || parked.modifiedCount !== 1) return { skipped: "the row changed since the plan" };
  // Give the row back as it was (`autoPaused` says who relists it).
  const unpark = async (autoPaused) => {
    const r = await d.MarketplaceListing.updateOne(
      { _id: row._id, status: "delisted", lastError: marker },
      { $set: { status: "active", lastError: "", autoPaused } },
    ).catch(() => null);
    return !!(r && r.modifiedCount === 1);
  };
  // Leave nothing half done: the old text is back on G2G (read first — when it
  // never changed there is nothing to put back), then the row. When the old
  // text cannot be CONFIRMED, the row stays parked and a human is told.
  const undo = async (error) => {
    let s = await offerOnG2g(d, offerId);
    let restored = (s.status === "live" || s.status === "delisted") && sameTitle(s.title, old.title) && samePrice(s.price, old.price);
    if (!restored && (s.status === "live" || s.status === "delisted")) {
      try {
        // Never a word changed on an offer that is on sale.
        if (s.status === "live") {
          await d.mp.g2gDelist(offerId);
          await waitFor(d, offerId, (x) => x.status === "delisted");
        }
        await d.mp.g2gUpdateOffer(offerId, { title: old.title.slice(0, 128), description: old.description, unitPrice: old.price });
      } catch {
        /* judged by the read below */
      }
      const back = await waitFor(d, offerId, (x) => (x.status === "live" || x.status === "delisted") && sameTitle(x.title, old.title) && samePrice(x.price, old.price));
      restored = back.ok;
      s = back.seen;
    }
    if (restored) {
      // On sale and untouched: exactly as before. Off sale: handed to the
      // stock sync, which counts the row's own bundle before it relists.
      const given = await unpark(s.status === "live" ? false : true);
      if (given) return { error: error + " — nothing is changed: the offer has its old text" + (upgrade && s.status !== "live" ? ", the stock sync relists it" : "") };
      return { error: error + " — the offer has its old text, but its row could not be reopened", parked: true };
    }
    return { error: error + " — the old text could NOT be confirmed back: the row stays closed, check the offer on G2G by hand", parked: true };
  };

  let moved = false;
  try {
    // 2. Off sale before a word changes.
    if (upgrade) {
      await d.mp.g2gDelist(offerId);
      const off = await waitFor(d, offerId, (x) => x.status === "delisted");
      if (!off.ok) return await undo("could not take it off sale first");
      // An order placed in its last seconds on sale shows now.
      if ((await paidOffers(d)).has(offerId)) {
        await d.mp.g2gRelist(offerId);
        await waitFor(d, offerId, (x) => x.status === "live");
        return (await unpark(false))
          ? { skipped: "a paid order arrived as it was taken down — back on sale, untouched" }
          : { error: "a paid order arrived as it was taken down; it is back on sale but its row could not be reopened", parked: true };
      }
    }
    // 3. The new text and price, read back from G2G.
    if (!action.sameBundle) {
      await d.mp.g2gUpdateOffer(offerId, { title, description, unitPrice: price });
      const took = await waitFor(d, offerId, (x) => x.status === "delisted" && sameTitle(x.title, title) && samePrice(x.price, price));
      if (!took.ok) return await undo("the new title and price did not show on G2G");
    }
    // 4. Only now the row follows — and comes back from its parking — in one
    //    compare-and-set. `rebundledAt` is what delivery reads to hold an order
    //    that was placed on the old text (g2gFulfiller.orderPredatesRewrite).
    const stamp = new Date(now).toISOString().slice(0, 16).replace("T", " ") + "Z";
    const cas = await d.MarketplaceListing.updateOne(
      { _id: row._id, status: "delisted", lastError: marker, set: row.set },
      {
        $set: {
          status: "active",
          set: target._id,
          title,
          description,
          price,
          autoPaused: true,
          rebundledAt: new Date(now),
          lastError: "",
          note: keepNewest(str(row.note) + " — evergreen " + stamp + ": " + action.kind + " from set " + str(row.set) + " ($" + old.price + ")"),
        },
      },
    );
    if (!cas || cas.modifiedCount !== 1) return await undo("the row changed while rewriting");
    moved = true;
  } catch (e) {
    if (!moved) return undo("the rewrite failed (" + str(e && e.message) + ")");
    throw e;
  }

  // 5. Back on sale the way the stock sync resumes its own pauses. From here
  //    text, price and row agree and the row reads "paused by the sync", so
  //    whatever fails, the next stock sync finishes the job.
  const fresh = await d.MarketplaceListing.findById(row._id).lean().catch(() => null);
  let stock = null;
  try {
    stock = fresh ? await d.realStockFor(fresh, ctx.listed || new Set()) : null;
  } catch {
    stock = null;
  }
  const done = { rewritten: true, title, price, stock: stock > 0 ? stock : 0, relisted: false };
  if (!(stock > 0)) return { ...done, note: "no stock counted yet — the stock sync brings it back" };
  try {
    await d.mp.g2gSetQuantity(offerId, stock);
    await d.mp.g2gRelist(offerId);
  } catch (e) {
    return { ...done, note: "the relist failed (" + str(e && e.message) + ") — the stock sync brings it back" };
  }
  const on = await d.MarketplaceListing.updateOne(
    { _id: row._id, status: "active", set: target._id, autoPaused: true },
    { $set: { autoPaused: false, qtyTarget: stock } },
  ).catch(() => null);
  if (!on || on.modifiedCount !== 1) {
    // Closed or changed in these seconds (the owner's delist): an offer must
    // not stay on sale over a row that says otherwise.
    const down = await d.mp.g2gDelist(offerId).then(() => true, () => false);
    return down
      ? { ...done, note: "its row changed during the relist — taken off sale again" }
      : { error: "its row changed during the relist and the offer could NOT be taken off sale again — check it on G2G", parked: true };
  }
  // 6. What buyers see now.
  const live = await waitFor(d, offerId, (x) => x.status === "live");
  if (!live.ok) {
    // Not shown as live yet: handed to the stock sync, which relists a paused
    // row by itself.
    await d.MarketplaceListing.updateOne({ _id: row._id, status: "active", set: target._id }, { $set: { autoPaused: true } }).catch(() => {});
    return { ...done, note: "G2G did not show it on sale yet — the stock sync relists it" };
  }
  const wrong = !sameTitle(live.seen.title, title)
    ? "the live title is not the new one"
    : !samePrice(live.seen.price, price)
      ? "the live price is not the new one"
      : !sameDescription(live.seen.description, description)
        ? "the live description is not the new one"
        : "";
  if (wrong) {
    // A live offer that reads differently from what its row delivers comes
    // down and stays down: closed, the one state nothing relists.
    const down = await d.mp.g2gDelist(offerId).then(() => true, () => false);
    const closed = await d.MarketplaceListing.updateOne(
      { _id: row._id },
      { $set: { status: "delisted", autoPaused: false, lastError: "evergreen: " + wrong + " after a rewrite — check the offer on G2G before relisting" } },
    ).then((r) => !!(r && r.modifiedCount === 1), () => false);
    return {
      error: wrong + " after the relist — " + (down ? "taken off sale" : "it could NOT be taken off sale") + (closed ? ", row closed" : ", and its row could not be closed") + "; check it on G2G by hand",
      parked: true,
    };
  }
  return { ...done, relisted: true };
}

// Rows a rewrite left parked — a crash, a restart, a failure it could not
// undo. For each one older than PARK_STALE_MS: when G2G shows the row's own
// (old) text, or takes it back, the row is reopened as "paused by the sync";
// otherwise it stays closed and is reported. Returns [{ offerId, reopened,
// why }].
async function recoverParked(d, now = Date.now()) {
  const rows = await d.MarketplaceListing.find({ marketplace: "g2g", status: "delisted", lastError: PARK_RE }).lean();
  const out = [];
  for (const row of rows || []) {
    const at = timeOf(str(row.lastError).slice(PARK_MARK.length).split(" ")[0]);
    if (at && now - at < PARK_STALE_MS) continue; // a rewrite may be running
    const offerId = str(row.externalId);
    const ok = (x) => (x.status === "live" || x.status === "delisted") && sameTitle(x.title, row.title) && samePrice(x.price, row.price);
    let seen = await offerOnG2g(d, offerId);
    if (seen.status !== "live" && seen.status !== "delisted") {
      out.push({ offerId, title: str(row.title), reopened: false, why: "G2G shows it " + seen.status });
      continue;
    }
    if (!ok(seen)) {
      try {
        if (seen.status === "live") {
          await d.mp.g2gDelist(offerId);
          await waitFor(d, offerId, (x) => x.status === "delisted");
        }
        await d.mp.g2gUpdateOffer(offerId, { title: str(row.title).slice(0, 128), description: str(row.description || row.title), unitPrice: row.price });
      } catch {
        /* judged by the read below */
      }
      seen = (await waitFor(d, offerId, ok)).seen;
    }
    if (!ok(seen)) {
      out.push({ offerId, title: str(row.title), reopened: false, why: "its old text could not be put back on G2G" });
      continue;
    }
    const r = await d.MarketplaceListing.updateOne(
      { _id: row._id, status: "delisted", lastError: row.lastError },
      { $set: { status: "active", lastError: "", autoPaused: seen.status !== "live" } },
    ).catch(() => null);
    out.push({ offerId, title: str(row.title), reopened: !!(r && r.modifiedCount === 1), why: "an interrupted rewrite — put back on its old bundle" });
  }
  return out;
}

// Make the offer for a bundle that has none (operator plan only), with the row
// that lets it be stock-checked and delivered — scripts/g2g-bundle-listings'
// shape, claiming from the archive when an order lands.
async function publishOffer(d, action, set, ctx = {}) {
  const game = setGame(set);
  const brand = d.brandForGame(game);
  if (!brand) return { error: "no G2G brand for " + game };
  if (d.isNoClaimGame && d.isNoClaimGame(game)) return { skipped: game + " is a no-claim game — sold from the no-claim farm, never from the archive" };
  const text = d.text(set, game);
  const price = round2(action.price);
  if (!(price > 0) || price < (Number(d.floor) || 0)) return { error: "no usable price" };
  let stock = 0;
  try {
    stock = d.notListed(await d.availableAccountsForSet(set), ctx.listed || new Set()).length;
  } catch (e) {
    return { error: "could not count the stock: " + str(e && e.message) };
  }
  if (stock < (ctx.minStock == null ? MIN_STOCK : ctx.minStock)) return { skipped: "only " + stock + " account(s) can deliver it now" };
  const qty = Math.min(MAX_QTY, stock);
  const pub = await d.mp.g2gPublish({
    serviceId: d.mp.G2G_ITEMS_SERVICE,
    brandId: brand.brandId,
    title: text.title,
    description: text.description,
    priceUsd: price,
    qty,
    minQty: 1,
  });
  try {
    await d.MarketplaceListing.create({
      set: set._id,
      marketplace: "g2g",
      externalId: pub.externalId,
      url: pub.url || "",
      title: text.title,
      description: text.description,
      price,
      status: "active",
      origin: "auto",
      autoClaimSet: true,
      qtyTarget: qty,
      note: "evergreen: the biggest " + game + " bundle we can deliver; claims from the Drop Archive at delivery",
    });
  } catch (e) {
    // An offer with no row can be bought and never delivered: take it down.
    const down = await d.mp.g2gDelist(pub.externalId).then(() => true, () => false);
    return {
      error: "published as " + pub.externalId + " but its row could not be saved (" + str(e && e.message) + ") — " + (down ? "taken off sale" : "and it could NOT be taken off sale: delist it on G2G now"),
      parked: !down,
    };
  }
  return { published: true, offerId: pub.externalId, title: text.title, price, stock: qty };
}

// Do a plan's actions in order. `setsById` holds the DropSets they name.
// A game's plan is one piece: once a rewrite or a publish of it did not end
// with the offer on sale, what is left of the plan is NOT done — its retires
// were written for a shelf that now looks different.
async function runActions(d, actions, setsById, ctx, { only = null, log = () => {} } = {}) {
  const out = { rewritten: [], retired: [], published: [], skipped: [], errors: [], parked: [] };
  const may = (t) => !only || only.includes(t);
  let broken = "";
  for (const a of actions) {
    if (!may(a.type)) continue;
    if (broken) {
      out.skipped.push({ offerId: a.offerId || "", type: a.type, why: "not done: " + broken });
      continue;
    }
    let r;
    try {
      if (a.type === "rewrite") {
        const set = setsById.get(str(a.toSet));
        r = set ? await rewriteOffer(d, a, set, ctx) : { error: "the target set is gone" };
        if (r.rewritten) {
          out.rewritten.push({ ...a, ...r });
          log("rewrote " + a.offerId + " (" + a.kind + "): " + a.fromTitle + " $" + a.fromPrice + " -> " + r.title + " $" + r.price + (r.relisted ? ", on sale x" + r.stock : ", off sale: " + r.note));
          if (!r.relisted) {
            broken = a.offerId + " is not back on sale yet";
            if (a.absorb) out.skipped.push({ offerId: a.absorb, type: "retire", why: "left on sale until " + a.offerId + " is back" });
            continue;
          }
          // The never-sold offer whose bundle it took over comes down now that
          // this one is selling it.
          if (a.absorb) {
            const t = await retireOffer(d, a.absorb, "its bundle moved to offer " + a.offerId, ctx);
            if (t.retired) {
              out.retired.push({ offerId: a.absorb, why: "merged into " + a.offerId });
              log("retired " + a.absorb + " (merged into " + a.offerId + ")");
            } else out[t.error ? "errors" : "skipped"].push({ offerId: a.absorb, type: "retire", why: t.error || t.skipped });
          }
          continue;
        }
      } else if (a.type === "retire") {
        r = await retireOffer(d, a.offerId, a.why, ctx);
        if (r.retired) {
          out.retired.push({ offerId: a.offerId, why: a.why });
          log("retired " + a.offerId + " (" + a.why + "): " + str(a.title));
          if (ctx.gapMs) await d.sleep(ctx.gapMs);
          continue;
        }
      } else if (a.type === "publish") {
        const set = setsById.get(str(a.toSet));
        r = set ? await publishOffer(d, a, set, ctx) : { error: "the set is gone" };
        if (r.published) {
          out.published.push({ ...a, ...r });
          log("published " + r.offerId + ": " + r.title + " $" + r.price + " x" + r.stock);
          if (ctx.gapMs) await d.sleep(ctx.gapMs);
          continue;
        }
      } else continue;
    } catch (e) {
      r = { error: str(e && e.message) };
    }
    const entry = { offerId: a.offerId || "", type: a.type, why: r.error || r.skipped || "unknown" };
    out[r.error ? "errors" : "skipped"].push(entry);
    if (r.parked) out.parked.push(entry);
    log((r.error ? "FAILED " : "skipped ") + a.type + " " + (a.offerId || a.toSet) + ": " + entry.why);
    if (a.type !== "retire") broken = "the " + a.type + " before it did not go through";
    // An offer left closed needs a human before anything else is touched.
    if (r.parked) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Planning one game against the live shelf (the server pass and the tool)
// ---------------------------------------------------------------------------

// `g` is one readShelf() game. Counts what a plan needs and returns
// { plan, setsById, candidates }.
async function planFor(d, g, { steps, listed, now, publishPrice, minStock = MIN_STOCK }) {
  const rows = g.rows;
  if (d.isNoClaimGame && d.isNoClaimGame(g.game)) {
    return {
      plan: { actions: [], notes: [{ offerId: "", title: "", why: g.game + " is a no-claim game — sold from the no-claim farm, never from the archive" }] },
      setsById: new Map(),
      candidates: [],
    };
  }
  // How many accounts can deliver a row's OWN bundle now. A read that fails is
  // "could not count" (null) — never zero: zero is what moves an offer.
  const ownStock = async (f) => {
    const set = g.sets && g.sets.get(f.setId);
    if (!set) return null;
    try {
      return d.notListed(await d.availableAccountsForSet(set), listed || new Set()).length;
    } catch {
      return null;
    }
  };
  const flagships = rows
    .filter((r) => r.managed && r.sold > 0)
    .sort((a, b) => b.sold - a.sold || b.lastSoldAt - a.lastSoldAt || a.offerId.localeCompare(b.offerId));
  // A paused offer that has sold: is its own bundle really gone?
  for (const f of flagships) if (f.paused) f.stock = await ownStock(f);
  // The best seller's own stock: an upgrade never moves it to a thinner shelf.
  const top = flagships[0];
  if (steps.upgrade && top && !top.paused) top.stock = await ownStock(top);
  const needy = flagships.filter((r) => r.paused && r.stock === 0).length;
  const wide = !!(steps.upgrade || steps.keepBest || steps.retire || steps.publish);
  let found = { cands: [], incomplete: false };
  if (needy || wide) {
    found = await candidateSets(d, g.game, {
      labels: g.labels,
      onG2g: new Set(rows.map((r) => r.setId).filter(Boolean)),
      listed,
      // Every bundle that is on the shelf already can use up one pick.
      want: needy + (wide ? 6 : 0) + rows.filter((r) => !r.paused).length + 1,
      minStock,
    });
  }
  const plan = planGame(rows, found.cands, { ...steps, minStock, floor: d.floor, publishPrice, incomplete: found.incomplete });
  const setsById = new Map(found.cands.map((c) => [c.setId, c.set]));
  return { plan, setsById, candidates: found.cands };
}

// ---------------------------------------------------------------------------
// The server pass: rescue only
// ---------------------------------------------------------------------------

function page(d, text) {
  try {
    Promise.resolve(d.sendTelegram(text)).catch(() => {});
  } catch {
    /* never fail the pass on a notification */
  }
}

async function evergreenPass(opts = {}) {
  if (state.running) return { skipped: "already running", log: [] };
  const d = opts.deps || realDeps();
  const now = opts.now || Date.now();
  const af = (d.settings.getAutoFarm && d.settings.getAutoFarm()) || {};
  if (af.g2gEvergreen !== true) return { skipped: "switched off (autoFarm.g2gEvergreen)", log: [] };
  // An offer put back on sale must be delivered and kept in step with stock.
  if (!g2gIsLive(d)) return { skipped: "G2G delivery or its stock sync is not live", log: [] };
  state.running = true;
  const out = { at: new Date(now), rewritten: [], retired: [], skipped: [], errors: [], parked: [], recovered: [], log: [] };
  try {
    // First, anything an earlier rewrite left half done.
    try {
      out.recovered = await recoverParked(d, now);
    } catch (e) {
      out.errors.push({ game: "", why: "could not look for interrupted rewrites: " + str(e && e.message) });
    }
    for (const r of out.recovered) {
      out.log.push((r.reopened ? "reopened " : "STILL CLOSED ") + r.offerId + ": " + r.why);
      if (!r.reopened) out.parked.push({ game: "", offerId: r.offerId, why: r.why });
    }

    const games = await readShelf(d, now);
    const waiting = [...games.values()].filter((g) =>
      g.rows.some((r) => r.managed && r.sold > 0 && r.paused && !r.mid && r.pausedMs >= MIN_PAUSED_MS),
    );
    let listed = null;
    let left = MAX_REWRITES_PER_PASS;
    let looked = 0;
    for (const g of waiting) {
      if (left <= 0 || looked >= MAX_GAMES_PER_PASS || out.parked.length) break;
      if ((state.rested.get(g.brandId) || 0) > now) continue;
      looked++;
      if (!listed) listed = await d.listedLogins();
      let p;
      try {
        p = await planFor(d, g, { steps: { rescue: true }, listed, now });
      } catch (e) {
        out.errors.push({ game: g.game, why: "plan: " + str(e && e.message) });
        state.rested.set(g.brandId, now + RETRY_REST_MS);
        continue;
      }
      for (const n of p.plan.notes) out.skipped.push({ game: g.game, ...n });
      const todo = p.plan.actions.filter((a) => a.type === "rewrite").slice(0, left);
      if (!todo.length) {
        // Nothing to move to (or nothing that may move): not asked again for
        // a while — the counts above are a query per bundle.
        state.rested.set(g.brandId, now + NOTHING_REST_MS);
        continue;
      }
      const done = await runActions(d, todo, p.setsById, { listed, now }, { log: (l) => out.log.push(l) });
      left -= done.rewritten.length;
      for (const x of done.rewritten) out.rewritten.push({ game: g.game, ...x });
      for (const x of done.retired) out.retired.push({ game: g.game, ...x });
      for (const x of done.skipped) out.skipped.push({ game: g.game, ...x });
      for (const x of done.errors) out.errors.push({ game: g.game, ...x });
      for (const x of done.parked) out.parked.push({ game: g.game, ...x });
      // A game whose rewrite was refused or failed is not tried again every 15
      // minutes: the same refusal, twice an hour, helps nobody.
      if (done.skipped.length || done.errors.length) state.rested.set(g.brandId, now + RETRY_REST_MS);
    }

    for (const x of out.rewritten) {
      try {
        Promise.resolve(
          d.logEvent({
            category: "marketplace",
            action: "g2g_offer_rewritten",
            actor: "g2gEvergreen",
            subject: "g2g " + x.offerId,
            game: x.game,
            count: x.stock,
            detail:
              "G2G offer " + x.offerId + " rewritten in place: " + x.fromTitle + " ($" + x.fromPrice + ") -> " + x.title +
              " ($" + x.price + ", " + x.stock + " in stock" + (x.relisted ? "" : ", not on sale yet") + ")" +
              (x.absorb ? "; took over the bundle of " + x.absorb : ""),
            meta: { fromSet: x.fromSet, toSet: x.toSet, kind: x.kind, absorbed: x.absorb || "", relisted: !!x.relisted },
          }),
        ).catch(() => {});
      } catch {
        /* the audit row must never undo a rewrite */
      }
    }
    if (out.rewritten.length) {
      page(
        d,
        "🔄 G2G offer moved to another bundle (it keeps its sold count)\n\n" +
          out.rewritten
            .map(
              (x) =>
                x.title + "\n$" + x.price + " · " + (x.relisted ? x.stock + " in stock, on sale" : "not on sale yet: " + x.note) +
                " · offer " + x.offerId + "\n(was: " + x.fromTitle + " $" + x.fromPrice + " — sold out)",
            )
            .join("\n\n"),
      );
    }
    // A row left closed is the one outcome that needs a human, so it is said
    // every time it is found — and the pass stops moving offers until it is
    // looked at (see the loop's `out.parked.length`).
    if (out.parked.length) {
      page(
        d,
        "⚠️ G2G: an offer is OFF SALE after a rewrite that could not be finished or undone\n\n" +
          out.parked.map((x) => "offer " + x.offerId + " — " + x.why).join("\n") +
          "\n\nCheck its text on G2G, then relist it from the Listings page. No other offer is rewritten until then.",
      );
    }
    // Skips and errors are said once per change, not every 15 minutes.
    const summary = [
      ...out.skipped.map((s) => "skip " + (s.game || "") + " " + (s.offerId || "") + ": " + s.why),
      ...out.errors.map((s) => "error " + (s.game || "") + " " + (s.offerId || "") + ": " + s.why),
    ].join(" | ");
    if (summary && summary !== state.lastSummary) out.log.push(summary);
    state.lastSummary = summary;
    state.lastRun = out;
    return out;
  } finally {
    state.running = false;
  }
}

function status() {
  const af = require("./settings").getAutoFarm() || {};
  return { enabled: af.g2gEvergreen === true, running: state.running, lastRun: state.lastRun };
}

module.exports = {
  MIN_STOCK,
  MIN_PAUSED_MS,
  NOTHING_REST_MS,
  RETRY_REST_MS,
  MAX_REWRITES_PER_PASS,
  MAX_GAMES_PER_PASS,
  PARK_MARK,
  // pure, tested
  itemsSignature,
  containsAll,
  unitState,
  shapeOf,
  rowFacts,
  priceFor,
  planGame,
  setGame,
  sameDescription,
  // reading the shelf
  readShelf,
  candidateSets,
  planFor,
  g2gIsLive,
  // acting
  offerOnG2g,
  paidOffers,
  retireOffer,
  rewriteOffer,
  recoverParked,
  publishOffer,
  runActions,
  // the server pass
  evergreenPass,
  status,
  realDeps,
  _state: state,
};
