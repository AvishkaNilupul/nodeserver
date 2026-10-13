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
//            can still deliver, and put back on sale. This is the only thing
//            the server does by itself (evergreenPass, after every stock sync).
//   keep     the biggest bundle we can deliver is on    } only when an operator
//            the shelf, even when it never sold.        } runs the plan
//   retire   every other never-sold offer comes down.   } (scripts/
//   upgrade  the game's best-selling offer moves up to  } g2g-evergreen.js);
//            a bigger bundle that contains everything   } upgrade and publish
//            it sells now, at the price it has.         } only when asked for
//   publish  a game's biggest bundle gets an offer.     }
//
// SAFETY
//
//   - Only offers this system made and that claim their account when an order
//     lands (origin "auto", autoClaimSet + set). The auto-lister's reserved
//     shares, no-claim copies, account listings, bulk packs, rent-farm offers
//     and anything made by hand are never rewritten or retired here.
//   - An offer is rewritten while it is OFF sale, the new text and price are
//     read back, and only then does its row follow — so nobody can pay for
//     the old text and be handed the new bundle. Any failure leaves it off
//     sale, on its old set.
//   - Never while a paid order waits on the offer, or a unit of its row is
//     mid hand-over.
//   - A bundle keeps the price it already has: the price of the offer it is
//     taken over from, else its set's own price — and a rewritten offer never
//     costs more than it did before. Raising a price is the owner's.
//   - A new bundle needs MIN_STOCK accounts behind it. One bundle, one offer:
//     a bundle that is on the shelf already is never given to a second offer.
//   - Kill switch: autoFarm.g2gEvergreen (the server pass runs only when true).

// Accounts a bundle needs behind it before an offer is moved onto it: fewer,
// and the offer sells out again within days and is rewritten once more.
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
    managed: shape === "archive" && str(row.origin) !== "manual" && row.status === "active",
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

// The price a bundle goes on an offer at. `own` is the price it already has
// (the offer it is taken over from, else its set) — and a rewrite never RAISES
// an offer's price: a set's price was written for another shelf (one 38-item
// Halo set carries $6 where our 34-item offer sells at $2.49), and what an
// offer costs more than before is the owner's to say, not this file's.
function priceFor(offer, pick, twin, floor) {
  let own = twin && twin.price > 0 ? twin.price : pick.price;
  if (!(own > 0)) return 0;
  if (offer && offer.price > 0) own = Math.min(own, offer.price);
  return round2(Math.max(Number(floor) || 0, own));
}

const bySize = (a, b) =>
  b.size - a.size || b.total - a.total || b.stock - a.stock || str(a.setId).localeCompare(str(b.setId));

// The plan for ONE game. Pure.
//   rows — rowFacts() of every active G2G row of the game
//   sets — the game's bundles we could move to: [{ setId, sig, size, total,
//          stock, price, items, name }], one per signature, stock counted the
//          way the stock sync counts it
//   opts — { rescue, upgrade, keepBest, retire, publish } (which steps),
//          minStock, minPausedMs, floor (the market's least price),
//          publishPrice (an operator's price for a published bundle)
// Returns { actions, notes }. Actions, in the order they are to be done:
//   { type:"rewrite", kind:"rescue"|"upgrade", offerId, rowId, fromSet, toSet,
//     title?, description?, price, absorb }   — absorb: a never-sold offer of
//     the same bundle that comes down once this one carries it
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
  const onShelf = new Map();
  // (An offer the sync paused whose bundle has stock again is coming back by
  // itself, so its bundle counts as on the shelf too.)
  for (const r of [...flagships, ...others]) {
    if ((!r.paused || r.stock > 0) && r.sig && !onShelf.has(r.sig)) onShelf.set(r.sig, r);
  }
  const candidates = (sets || [])
    .filter((s) => s && s.sig && s.stock >= minStock && s.price > 0)
    .sort(bySize);
  const absorbed = new Set(); // never-sold offers a rewrite takes over
  const twinOf = (sig) => never.find((r) => r.sig === sig && !r.mid && !absorbed.has(r.offerId)) || null;
  const give = (offer, pick, kind) => {
    const twin = twinOf(pick.sig);
    const price = priceFor(offer, pick, twin, floor);
    actions.push({
      type: "rewrite",
      kind,
      offerId: offer.offerId,
      rowId: offer.rowId,
      fromSet: offer.setId,
      fromTitle: offer.title,
      fromPrice: offer.price,
      toSet: pick.setId,
      // The text the bundle is already sold under, when it has an offer.
      title: twin ? twin.title : "",
      description: twin ? twin.description : "",
      price,
      size: pick.size,
      stock: pick.stock,
      absorb: twin ? twin.offerId : "",
      absorbRowId: twin ? twin.rowId : "",
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
      const pick = candidates.find((s) => s.sig !== f.sig && !onShelf.has(s.sig));
      if (!pick) {
        note(f, "no other bundle of this game has " + minStock + "+ accounts behind it");
        continue;
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
      const pick = candidates.find(
        (s) =>
          s.size > top.size &&
          s.stock >= top.stock &&
          s.sig !== top.sig &&
          !onShelf.has(s.sig) &&
          containsAll(s.items, top.items),
      );
      if (pick) give(top, pick, "upgrade");
    }
  }

  if (opts.keepBest || opts.retire || opts.publish) {
    // The biggest bundle we can deliver belongs on the shelf. When no kept
    // offer carries one at least that big: with `publish`, an offer is made
    // for it (unless a never-sold one already sells it, which is then kept);
    // without, the never-sold offer with the biggest deliverable bundle is
    // kept — a game is never left with nothing for want of the perfect one.
    let shelfMax = 0;
    for (const r of onShelf.values()) shelfMax = Math.max(shelfMax, sizeOnShelf(r, actions));
    const open = candidates.filter((s) => !onShelf.has(s.sig) && s.size > shelfMax);
    const carrier = (c) => never.find((r) => r.sig === c.sig && !absorbed.has(r.offerId)) || null;
    const best = open[0] || null;
    let keep = null;
    if (best && (opts.keepBest || opts.publish)) {
      keep = carrier(best);
      if (!keep && opts.publish) {
        const price = round2(Math.max(floor, Number(opts.publishPrice) > 0 ? Number(opts.publishPrice) : best.price));
        actions.push({ type: "publish", toSet: best.setId, name: best.name, price, size: best.size, stock: best.stock });
      } else if (!keep) {
        note(null, "the biggest bundle we can deliver (" + best.size + " items, " + best.stock + " accounts) has no offer");
        for (const c of open) {
          keep = carrier(c);
          if (keep) break;
        }
      }
    }
    if (opts.retire) {
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

// ---------------------------------------------------------------------------
// Reading the shelf
// ---------------------------------------------------------------------------

function brandKey(d, game) {
  const b = game ? d.brandForGame(game) : null;
  return b && b.brandId ? str(b.brandId) : "";
}

// Every active G2G row, grouped by the game's G2G brand:
// Map<brandId, { game, labels:Set, rows:[rowFacts], docs:Map<offerId,row> }>.
async function readShelf(d, now) {
  const rows = await d.MarketplaceListing.find({ marketplace: "g2g", status: "active" }).lean();
  const setIds = [...new Set((rows || []).map((r) => str(r.set)).filter(Boolean))];
  const sets = setIds.length
    ? await d.DropSet.find({ _id: { $in: setIds } }, { name: 1, items: 1, coverGame: 1, price: 1, minPriceUsd: 1, stockSource: 1 }).lean()
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
      g = { brandId: key, game, labels: new Set(), rows: [], docs: new Map() };
      games.set(key, g);
    }
    for (const it of (set && set.items) || []) if (it && str(it.game).trim()) g.labels.add(str(it.game).trim());
    if (game) g.labels.add(game);
    g.rows.push(rowFacts(r, set, now));
    g.docs.set(str(r.externalId), r);
  }
  return games;
}

function escapeRe(s) {
  return str(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The game's bundles we could move an offer to: archive sets whose every item
// is of this game, priced, one per signature, with at least `minStock`
// accounts that could deliver them — counted the way the stock sync counts.
async function candidateSets(d, game, { labels, onG2g, listed, want, minStock }) {
  const names = [...new Set([game, ...(labels || [])].map((l) => str(l).trim()).filter(Boolean))];
  if (!names.length) return [];
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
  if (!cands.length) return [];
  // One aggregation for a first count (it does not yet leave out accounts that
  // are attached to a live listing elsewhere, so it can only be too high).
  const rough = await d.stockForSets(cands.map((c) => c.set));
  for (const c of cands) c.stock = Number((rough.get(c.setId) || {}).stock) || 0;
  // The same bundle is often written down as several sets — the catalog's is
  // tied to the accounts it was built from, a campaign's is not. One per
  // bundle: the one most accounts can deliver, then one an offer of ours
  // already carries, then the newest.
  const bySig = new Map();
  for (const c of cands) {
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
  // The exact count, biggest first, until enough bundles are known good.
  const out = [];
  let counted = 0;
  for (const c of cands) {
    if (out.length >= want || counted >= MAX_EXACT_COUNTS) break;
    counted++;
    let avail = [];
    try {
      avail = await d.availableAccountsForSet(c.set);
    } catch {
      continue; // could not count: not a bundle to move anything to
    }
    c.stock = d.notListed(avail, listed || new Set()).length;
    if (c.stock >= minStock) out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Acting on G2G
// ---------------------------------------------------------------------------

// "live", "delisted", or "unreadable (…)". G2G answers 404 for an offer that is
// off sale, so a delisted one is looked up in the account's delisted list —
// which also gives its title and price as G2G holds them.
async function offerOnG2g(d, offerId) {
  try {
    const o = (await d.mp.g2gGetOffer(offerId)) || {};
    return {
      status: str(o.status),
      title: str(o.title),
      description: str(o.description),
      price: Number(o.unit_price),
      qty: Number(o.actual_qty),
    };
  } catch (e) {
    const off = await d.mp.g2gListOffers({ pageSize: 100, maxPages: 10, status: d.mp.G2G_STATUS.DELISTED });
    const hit = (off || []).find((o) => str(o.offerId) === str(offerId));
    if (hit) return { status: "delisted", title: str(hit.title), price: Number(hit.unitPrice), description: null, qty: null };
    return { status: "unreadable (" + str(e && e.message) + ")" };
  }
}

// Ask until G2G shows what `ok` wants, a few seconds apart.
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
const samePrice = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

// Offers G2G lists a paid order for. Read once per run.
async function paidOffers(d) {
  const orders = (await d.mp.g2gPendingOrders()) || [];
  return new Set(orders.map((o) => str(o && o.offerId)).filter(Boolean));
}

// Take a never-sold archive offer off the shelf for good: delist, read the
// status back, close the row if it is still active. It holds no accounts.
async function retireOffer(d, offerId, why, ctx = {}) {
  const row = await d.MarketplaceListing.findOne({ marketplace: "g2g", externalId: offerId }).lean();
  if (!row) return { error: "no listing row" };
  if (row.status !== "active") return { skipped: "row is already " + row.status };
  const f = rowFacts(row, null);
  if (f.shape !== "archive" || str(row.origin) === "manual") return { skipped: "not an offer this file may retire (" + f.shape + ")" };
  if (f.sold) return { skipped: "it has sold " + f.sold + " — kept" };
  if (f.mid) return { skipped: "an order is mid hand-over on it" };
  if (ctx.paid && ctx.paid.has(str(offerId))) return { skipped: "G2G lists a paid order for it" };
  await d.mp.g2gDelist(offerId);
  const w = await waitFor(d, offerId, (s) => s.status === "delisted");
  if (!w.ok) return { error: 'G2G still shows it "' + (w.seen && w.seen.status) + '" after the delist' };
  const stamp = new Date(ctx.now || Date.now()).toISOString().slice(0, 10);
  const r = await d.MarketplaceListing.updateOne(
    { _id: row._id, status: "active" },
    {
      $set: {
        status: "delisted",
        autoPaused: false,
        lastError: "",
        note: (str(row.note) + " — retired " + stamp + ": " + why).slice(0, NOTE_MAX),
      },
    },
  );
  if (!r || r.modifiedCount !== 1) return { error: "delisted on G2G, but the row was no longer active — look at it by hand" };
  return { retired: true };
}

// Rewrite one offer to another bundle. The order below IS the safety property.
//   action — a planGame "rewrite"; set — the DropSet it moves to
// Returns { rewritten:true, stock, title, price } or { skipped } / { error }.
async function rewriteOffer(d, action, set, ctx = {}) {
  const offerId = str(action.offerId);
  const row = await d.MarketplaceListing.findOne({ marketplace: "g2g", externalId: offerId }).lean();
  if (!row) return { error: "no listing row" };
  const f = rowFacts(row, null);
  if (row.status !== "active") return { skipped: "row is " + row.status };
  if (f.shape !== "archive" || str(row.origin) === "manual") return { skipped: "not an offer this file may rewrite (" + f.shape + ")" };
  if (str(row.set) !== str(action.fromSet)) return { skipped: "the row moved to another set since the plan" };
  if (f.mid) return { skipped: "an order is mid hand-over on it" };
  if (action.kind === "rescue" && !row.autoPaused) return { skipped: "back on sale since the plan" };
  if (ctx.paid && ctx.paid.has(offerId)) return { skipped: "a paid order is waiting on this offer" };

  const game = setGame(set);
  const text = action.title ? { title: action.title, description: action.description } : d.text(set, game);
  const title = str(text.title).trim().slice(0, 128);
  const description = str(text.description || text.title);
  const price = round2(action.price);
  if (!title) return { error: "no title for the new bundle" };
  if (!(price >= (Number(d.floor) || 0)) || !(price > 0)) return { error: "no usable price for the new bundle" };

  // 1. Off sale first. A rescued offer is off already; one that is on sale is
  //    taken down for the minute the rewrite takes.
  let seen = await offerOnG2g(d, offerId);
  if (action.kind === "rescue") {
    if (seen.status !== "delisted") return { skipped: "G2G shows it " + seen.status + " — left for the stock sync" };
  } else {
    if (seen.status === "live") {
      await d.mp.g2gDelist(offerId);
      const w = await waitFor(d, offerId, (s) => s.status === "delisted");
      if (!w.ok) return { error: 'could not take it off sale first (G2G shows "' + (w.seen && w.seen.status) + '")' };
      seen = w.seen;
    } else if (seen.status !== "delisted") {
      return { error: "G2G shows it " + seen.status };
    }
  }
  // From here on a failure leaves the offer OFF sale, and it must not come
  // back with a text its row cannot honour. So the old text is put back and
  // READ back; when even that cannot be confirmed the row is closed, which is
  // the one state nothing relists by itself — a human looks at the offer.
  const undo = async (error) => {
    let restored = false;
    try {
      await d.mp.g2gUpdateOffer(offerId, {
        title: str(row.title).slice(0, 128),
        description: str(row.description || row.title),
        unitPrice: row.price,
      });
      const back = await waitFor(d, offerId, (s) => s.status === "delisted" && sameTitle(s.title, row.title) && samePrice(s.price, row.price));
      restored = back.ok;
    } catch {
      restored = false;
    }
    if (restored) {
      // An offer taken down for an upgrade goes back on sale as it was.
      if (action.kind !== "rescue") {
        await d.MarketplaceListing.updateOne({ _id: row._id, set: row.set, status: "active" }, { $set: { autoPaused: true } }).catch(() => {});
      }
      return { error: error + " — the old text was put back" + (action.kind !== "rescue" ? "; the stock sync relists it" : "") };
    }
    await d.MarketplaceListing.updateOne(
      { _id: row._id, status: "active" },
      { $set: { status: "delisted", autoPaused: false, lastError: "evergreen: a rewrite failed half-way — check the offer's text on G2G before relisting" } },
    ).catch(() => {});
    return { error: error + " — the old text could NOT be confirmed back: the row is closed, check the offer on G2G by hand" };
  };

  // 2. The new text and price, while nobody can buy it.
  try {
    await d.mp.g2gUpdateOffer(offerId, { title, description, unitPrice: price });
  } catch (e) {
    return undo("G2G refused the rewrite (" + str(e && e.message) + ")");
  }
  const took = await waitFor(d, offerId, (s) => s.status === "delisted" && sameTitle(s.title, title) && samePrice(s.price, price));
  if (!took.ok) return undo("the new title and price did not show on G2G");

  // 3. Only now the row follows, by compare-and-set on the set it was on.
  const stamp = new Date(ctx.now || Date.now()).toISOString().slice(0, 16).replace("T", " ") + "Z";
  const cas = await d.MarketplaceListing.updateOne(
    { _id: row._id, set: row.set, status: "active" },
    {
      $set: {
        set: set._id,
        title,
        description,
        price,
        autoPaused: true,
        lastError: "",
        note: (str(row.note) + " — evergreen " + stamp + ": " + action.kind + " from set " + str(row.set) + " ($" + row.price + ")").slice(0, NOTE_MAX),
      },
    },
  );
  if (!cas || cas.modifiedCount !== 1) return undo("the row changed while rewriting");

  // 4. Back on sale the way the stock sync resumes its own pauses.
  const moved = await d.MarketplaceListing.findById(row._id).lean();
  let stock = null;
  try {
    stock = await d.realStockFor(moved, ctx.listed || new Set());
  } catch {
    stock = null;
  }
  if (!(stock > 0)) {
    return { rewritten: true, stock: 0, title, price, relisted: false, note: "no stock counted yet — the stock sync brings it back" };
  }
  try {
    await d.mp.g2gSetQuantity(offerId, stock);
    await d.mp.g2gRelist(offerId);
  } catch (e) {
    // Text, price and row agree and the row reads "paused by the sync": the
    // next stock sync writes the quantity and relists it.
    return { rewritten: true, stock, title, price, relisted: false, note: "the relist failed (" + str(e && e.message) + ") — the stock sync brings it back" };
  }
  await d.MarketplaceListing.updateOne({ _id: row._id, set: set._id }, { $set: { autoPaused: false, lastError: "", qtyTarget: stock } });
  // 5. What buyers see now. A wrong text or price on a LIVE offer comes down.
  const live = await waitFor(d, offerId, (s) => s.status === "live");
  const wrong = !live.ok
    ? "it did not show as live"
    : !sameTitle(live.seen.title, title)
      ? "the live title is not the new one"
      : !samePrice(live.seen.price, price)
        ? "the live price is not the new one"
        : "";
  if (wrong) {
    // Closed, not paused: a paused row is put back by the next stock sync.
    await d.mp.g2gDelist(offerId).catch(() => {});
    await d.MarketplaceListing.updateOne(
      { _id: row._id },
      { $set: { status: "delisted", autoPaused: false, lastError: "evergreen: " + wrong + " after a rewrite — check the offer on G2G" } },
    ).catch(() => {});
    return { error: wrong + " after the relist — taken off sale and closed, check it by hand" };
  }
  return { rewritten: true, stock, title, price, relisted: true };
}

// Make the offer for a bundle that has none (operator plan only), with the row
// that lets it be stock-checked and delivered — scripts/g2g-bundle-listings'
// shape, claiming from the archive when an order lands.
async function publishOffer(d, action, set, ctx = {}) {
  const game = setGame(set);
  const brand = d.brandForGame(game);
  if (!brand) return { error: "no G2G brand for " + game };
  const text = d.text(set, game);
  const price = round2(action.price);
  let stock = 0;
  try {
    stock = d.notListed(await d.availableAccountsForSet(set), ctx.listed || new Set()).length;
  } catch (e) {
    return { error: "could not count the stock: " + str(e && e.message) };
  }
  if (stock < (ctx.minStock == null ? MIN_STOCK : ctx.minStock)) return { skipped: "only " + stock + " account(s) can deliver it now" };
  const qty = Math.min(200, stock);
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
    await d.mp.g2gDelist(pub.externalId).catch(() => {});
    return { error: "published as " + pub.externalId + " but its row could not be saved (" + str(e && e.message) + ") — taken off sale" };
  }
  return { published: true, offerId: pub.externalId, title: text.title, price, stock: qty };
}

// Do a plan's actions in order. `setsById` holds the DropSets they name.
async function runActions(d, actions, setsById, ctx, { only = null, log = () => {} } = {}) {
  const out = { rewritten: [], retired: [], published: [], skipped: [], errors: [] };
  const may = (t) => !only || only.includes(t);
  for (const a of actions) {
    if (!may(a.type)) continue;
    let r;
    try {
      if (a.type === "rewrite") {
        const set = setsById.get(str(a.toSet));
        r = set ? await rewriteOffer(d, a, set, ctx) : { error: "the target set is gone" };
        if (r.rewritten) {
          out.rewritten.push({ ...a, ...r });
          log("rewrote " + a.offerId + " (" + a.kind + "): " + a.fromTitle + " $" + a.fromPrice + " -> " + r.title + " $" + r.price + (r.relisted ? ", on sale x" + r.stock : ", off sale: " + r.note));
          // The never-sold offer whose bundle it took over comes down once
          // this one is selling it (until then that offer is the bundle's
          // only one, and stays).
          if (a.absorb && !r.relisted) {
            out.skipped.push({ offerId: a.absorb, type: "retire", why: "left on sale until " + a.offerId + " is back" });
          }
          if (a.absorb && r.relisted) {
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
          continue;
        }
      } else if (a.type === "publish") {
        const set = setsById.get(str(a.toSet));
        r = set ? await publishOffer(d, a, set, ctx) : { error: "the set is gone" };
        if (r.published) {
          out.published.push({ ...a, ...r });
          log("published " + r.offerId + ": " + r.title + " $" + r.price + " x" + r.stock);
          continue;
        }
      } else continue;
    } catch (e) {
      r = { error: str(e && e.message) };
    }
    out[r.error ? "errors" : "skipped"].push({ offerId: a.offerId || "", type: a.type, why: r.error || r.skipped || "unknown" });
    log((r.error ? "FAILED " : "skipped ") + a.type + " " + (a.offerId || a.toSet) + ": " + (r.error || r.skipped));
    if (r.error && ctx.stopOnError) break;
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
  // A paused offer that has sold: is its own bundle really gone?
  for (const f of rows) {
    if (!(f.managed && f.sold > 0 && f.paused)) continue;
    try {
      f.stock = await d.realStockFor(g.docs.get(f.offerId), listed);
    } catch {
      f.stock = null;
    }
  }
  const flagships = rows
    .filter((r) => r.managed && r.sold > 0)
    .sort((a, b) => b.sold - a.sold || b.lastSoldAt - a.lastSoldAt || a.offerId.localeCompare(b.offerId));
  // The best seller's own stock: an upgrade never moves it to a thinner shelf.
  const top = flagships[0];
  if (steps.upgrade && top && !top.paused) {
    try {
      top.stock = await d.realStockFor(g.docs.get(top.offerId), listed);
    } catch {
      top.stock = null;
    }
  }
  const needy = flagships.filter((r) => r.paused && r.stock === 0).length;
  const wide = !!(steps.upgrade || steps.keepBest || steps.retire || steps.publish);
  let candidates = [];
  if (needy || wide) {
    candidates = await candidateSets(d, g.game, {
      labels: g.labels,
      onG2g: new Set(rows.map((r) => r.setId).filter(Boolean)),
      listed,
      // Every bundle that is on the shelf already can use up one pick.
      want: needy + (wide ? 6 : 0) + rows.filter((r) => !r.paused).length + 1,
      minStock,
    });
  }
  const plan = planGame(rows, candidates, { ...steps, minStock, floor: d.floor, publishPrice, now });
  const setsById = new Map(candidates.map((c) => [c.setId, c.set]));
  return { plan, setsById, candidates };
}

// ---------------------------------------------------------------------------
// The server pass: rescue only
// ---------------------------------------------------------------------------

async function evergreenPass(opts = {}) {
  if (state.running) return { skipped: "already running", log: [] };
  const d = opts.deps || realDeps();
  const now = opts.now || Date.now();
  const af = (d.settings.getAutoFarm && d.settings.getAutoFarm()) || {};
  if (af.g2gEvergreen !== true) return { skipped: "switched off (autoFarm.g2gEvergreen)", log: [] };
  // An offer put back on sale must be delivered and kept in step with stock.
  if (af.g2gAutoDeliver !== true || af.g2gDeliverDryRun !== false || af.g2gSyncStock === false) {
    return { skipped: "G2G delivery or its stock sync is not live", log: [] };
  }
  state.running = true;
  const out = { at: new Date(now), rewritten: [], retired: [], skipped: [], errors: [], log: [] };
  try {
    const games = await readShelf(d, now);
    const waiting = [...games.values()].filter((g) =>
      g.rows.some((r) => r.managed && r.sold > 0 && r.paused && !r.mid && r.pausedMs >= MIN_PAUSED_MS),
    );
    let listed = null;
    let paid = null;
    let left = MAX_REWRITES_PER_PASS;
    let looked = 0;
    for (const g of waiting) {
      if (left <= 0 || looked >= MAX_GAMES_PER_PASS) break;
      if ((state.rested.get(g.brandId) || 0) > now) continue;
      looked++;
      if (!listed) listed = await d.listedLogins();
      let p;
      try {
        p = await planFor(d, g, { steps: { rescue: true }, listed, now });
      } catch (e) {
        out.errors.push({ game: g.game, why: "plan: " + str(e && e.message) });
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
      if (!paid) {
        try {
          paid = await paidOffers(d);
        } catch (e) {
          out.errors.push({ game: g.game, why: "could not read G2G's paid orders: " + str(e && e.message) });
          break;
        }
      }
      const done = await runActions(d, todo, p.setsById, { paid, listed, now }, { log: (l) => out.log.push(l) });
      left -= todo.length;
      for (const x of done.rewritten) out.rewritten.push({ game: g.game, ...x });
      for (const x of done.retired) out.retired.push({ game: g.game, ...x });
      for (const x of done.skipped) out.skipped.push({ game: g.game, ...x });
      for (const x of done.errors) out.errors.push({ game: g.game, ...x });
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
              " ($" + x.price + ", " + x.stock + " in stock)" + (x.absorb ? "; took over the bundle of " + x.absorb : ""),
            meta: { fromSet: x.fromSet, toSet: x.toSet, kind: x.kind, absorbed: x.absorb || "" },
          }),
        ).catch(() => {});
      } catch {
        /* the audit row must never undo a rewrite */
      }
    }
    if (out.rewritten.length) {
      const text =
        "🔄 G2G offer back on sale with another bundle (it keeps its sold count)\n\n" +
        out.rewritten
          .map((x) => x.title + "\n$" + x.price + " · " + x.stock + " in stock · offer " + x.offerId + "\n(was: " + x.fromTitle + " — sold out)")
          .join("\n\n");
      try {
        Promise.resolve(d.sendTelegram(text)).catch(() => {});
      } catch {
        /* never fail the pass on a notification */
      }
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
  MAX_REWRITES_PER_PASS,
  MAX_GAMES_PER_PASS,
  // pure, tested
  itemsSignature,
  containsAll,
  unitState,
  shapeOf,
  rowFacts,
  priceFor,
  planGame,
  setGame,
  // reading the shelf
  readShelf,
  candidateSets,
  planFor,
  // acting
  offerOnG2g,
  paidOffers,
  retireOffer,
  rewriteOffer,
  publishOffer,
  runActions,
  // the server pass
  evergreenPass,
  status,
  realDeps,
  _state: state,
};
