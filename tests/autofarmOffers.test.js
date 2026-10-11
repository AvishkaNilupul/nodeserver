// utils/autofarmOffers.js — putting AUTO-FARM unclaimed stock on sale.
//
// utils/autofarmStock.js makes an auto-farm account's finished, unclaimed drops
// sellable; this module is what gives that stock an offer. It publishes on a
// live market with nobody watching, so these tests pin what keeps that safe:
//   - a game the no-claim bots farm is the owner's, never touched;
//   - an account an existing offer can already sell is on a shelf: a bundle
//     never gets two offers, a second campaign of a game gets its own;
//   - nothing is listed while the accounts are still earning (the offer keeps
//     the price it was made with);
//   - an account on a shelf is never counted on a second one (the stock sync
//     splits a shelf only between offers of the SAME set);
//   - a bundle that ever had an offer is never listed twice, and a game whose
//     offer was taken down is left alone;
//   - a failed publish leaves no set behind and rests an hour; one that may be
//     live without a row is never tried again;
//   - a few offers a pass and a day.
//
// Mongo/network-free: the module takes its collaborators as `deps`.
process.env.CRED_SECRET ||= "test-secret";
const test = require("node:test");
const assert = require("node:assert");

const settings = require("../utils/settings");
const realNcs = require("../utils/noclaimStock");
const ao = require("../utils/autofarmOffers");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-10-11T08:00:00Z");

const realGetAutoFarm = settings.getAutoFarm;
let autoFarm = {};
settings.getAutoFarm = () => ({ ...autoFarm });
test.after(() => {
  settings.getAutoFarm = realGetAutoFarm;
});
test.beforeEach(() => {
  autoFarm = {
    autofarmOffers: true,
    eldoradoAutoDeliver: true,
    eldoradoDeliverDryRun: false,
    noClaimGames: ["overwatch", "rainbow six"],
  };
  ao.resetMemory();
});

// ---------------------------------------------------------------------------
// A small world: holdings, sets, listing rows, and what was published.
// ---------------------------------------------------------------------------
let seq = 0;
const oid = () => (++seq).toString(16).padStart(24, "0");

const item = (name, game, campaign, qty = 1) => ({
  itemKey: (name + "|" + game).toLowerCase(),
  name,
  game,
  campaign,
  image: "https://img/" + encodeURIComponent(name) + ".png",
  qty,
  waves: campaign ? [{ campaign, qty }] : [],
});

// `n` auto-farm accounts holding the same items.
function cohort(prefix, n, items, extra = {}) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push({
      loginLower: prefix + i,
      login: prefix + i,
      farm: "autofarm",
      inConfig: true,
      fresh: true,
      notFree: "",
      game: (items[0] && items[0].game) || "",
      items: items.map((x) => ({ ...x, waves: x.waves.map((w) => ({ ...w })) })),
      ...extra,
    });
  }
  return out;
}

function world(o = {}) {
  const w = {
    holdings: o.holdings || [],
    // campaign name -> ms its copies leave the accounts (end + the 7 days).
    gone: o.gone || {},
    sets: (o.sets || []).map((s) => ({ _id: oid(), stockSource: "noclaim", createdAt: new Date(T0 - DAY), ...s })),
    rows: [],
    delivery: o.delivery !== false,
    publishResult: o.publishResult || null,
    cover: o.cover === undefined ? "/tmp/cover.png" : o.cover,
    enginePrice: o.enginePrice === undefined ? 1.21 : o.enginePrice,
    published: [],
    unlinked: [],
    telegrams: [],
    events: [],
    delisted: [],
    reads: { snapshot: 0, durableAt: [] },
  };
  for (const r of o.rows || []) w.rows.push({ _id: oid(), marketplace: "eldorado", noclaimStock: true, status: "active", ...r });
  // The snapshot's index of campaign ends: a campaign ends seven days before
  // its copies leave. `o.ends` adds or replaces entries (a re-issued name).
  const campaignEnds = new Map();
  for (const [name, gone] of Object.entries(w.gone)) campaignEnds.set(name.toLowerCase(), [{ game: "", endMs: gone - 7 * DAY }]);
  for (const [name, list] of Object.entries(o.ends || {})) campaignEnds.set(name.toLowerCase(), list);
  const base = {
    holdings: w.holdings,
    expiry: { on: true, claimWindowMs: 7 * DAY, sellLeadMs: 24 * HOUR, bundleLeadMs: 36 * HOUR },
    campaignEnds,
  };
  const matchSet = (s, q) => {
    if (q._id && q._id.$in && !q._id.$in.map(String).includes(String(s._id))) return false;
    if (q.stockSource && s.stockSource !== q.stockSource) return false;
    if (q.note instanceof RegExp && !q.note.test(String(s.note || ""))) return false;
    if (q.createdAt && q.createdAt.$gte && !(new Date(s.createdAt) >= q.createdAt.$gte)) return false;
    return true;
  };
  const chain = (list) => ({
    sort: () => chain(list),
    limit: (n) => chain(list.slice(0, n)),
    lean: async () => list.map((x) => ({ ...x })),
  });
  w.deps = {
    nh: {
      snapshotBase: async () => {
        w.reads.snapshot++;
        return base;
      },
      advertiseLeadMs: () => 24 * HOUR,
      isFresh: (h) => h.fresh !== false,
      // The real rule: an item's copies leave wave by wave; a copy no wave
      // accounts for counts; an item with none left is dropped.
      durableItems: (h, b, at) => {
        w.reads.durableAt.push(at);
        const out = [];
        for (const it of h.items) {
          if (!it.waves || !it.waves.length) {
            out.push(it);
            continue;
          }
          let qty = 0;
          let known = 0;
          for (const wv of it.waves) {
            known += wv.qty || 1;
            const g = wv.campaign in w.gone ? w.gone[wv.campaign] : Infinity;
            if (g > at) qty += wv.qty || 1;
          }
          qty += Math.max(0, (it.qty || 1) - known);
          if (qty > 0) out.push(qty === (it.qty || 1) ? it : { ...it, qty });
        }
        return out;
      },
      freeReason: (h) => h.notFree || "",
      waveGoneAt: (b, game, name) => (name in w.gone ? w.gone[name] : Infinity),
    },
    ncs: { ...realNcs, deliveryEnabled: () => w.delivery },
    ual: () => ({
      listingTitle: (game, drops) => game + " Twitch Drops (" + drops.length + " Items)",
      listingDescription: (game) => "House description for " + game + ".",
    }),
    nl: () => ({
      publishNoclaim: async (market, ctx) => {
        w.published.push({ market, ...ctx });
        if (typeof o.onPublish === "function") o.onPublish(ctx, w);
        if (w.publishResult) {
          if (w.publishResult instanceof Error) throw w.publishResult;
          return w.publishResult;
        }
        const row = {
          _id: oid(), marketplace: market, noclaimStock: true, status: "active", set: ctx.set._id,
          externalId: "ext-" + w.published.length, createdAt: new Date(o.createdAt || T0),
          note: "no-claim auto-delivery: an account is claimed when an order lands",
        };
        w.rows.push(row);
        return { success: true, id: String(row._id), externalId: row.externalId, url: "https://eldorado/x", note: row.note };
      },
    }),
    DropSet: {
      find: (q) => chain(w.sets.filter((s) => matchSet(s, q))),
      countDocuments: async (q) => w.sets.filter((s) => matchSet(s, q)).length,
      create: async (doc) => {
        const s = { _id: oid(), createdAt: new Date(o.createdAt || T0), ...doc };
        w.sets.push(s);
        return { ...s, toObject: () => ({ ...s }) };
      },
      deleteOne: async (q) => {
        const i = w.sets.findIndex((s) => String(s._id) === String(q._id));
        if (i >= 0) w.sets.splice(i, 1);
        return { deletedCount: i >= 0 ? 1 : 0 };
      },
      updateOne: async (q, u) => {
        if (typeof o.onSetUpdate === "function") o.onSetUpdate(q, u, w);
        const doc = w.sets.find(
          (s) => String(s._id) === String(q._id) && (q.note === undefined || String(s.note || "") === q.note),
        );
        if (doc) Object.assign(doc, u.$set || {});
        return { modifiedCount: doc ? 1 : 0 };
      },
    },
    MarketplaceListing: {
      find: (q) =>
        chain(
          w.rows.filter((r) => {
            if (q.marketplace && q.marketplace.$in) {
              if (!q.marketplace.$in.includes(r.marketplace)) return false;
            } else if (q.marketplace && r.marketplace !== q.marketplace) return false;
            if (q.noclaimStock !== undefined && r.noclaimStock !== q.noclaimStock) return false;
            if (q.status && r.status !== q.status) return false;
            if (q.set && q.set.$in) {
              if (!q.set.$in.map(String).includes(String(r.set))) return false;
            } else if (q.set && String(r.set) !== String(q.set)) return false;
            if (q.updatedAt && q.updatedAt.$gte && !(new Date(r.updatedAt || 0) >= q.updatedAt.$gte)) return false;
            if (q.createdAt && q.createdAt.$gte && !(new Date(r.createdAt || 0) >= q.createdAt.$gte)) return false;
            return true;
          }),
        ),
      updateOne: async (q, u) => {
        if (o.tagError) throw new Error(o.tagError);
        const row = w.rows.find((r) => String(r._id) === String(q._id) && (!q.status || r.status === q.status));
        if (row) Object.assign(row, u.$set || {});
        return { modifiedCount: row ? 1 : 0 };
      },
    },
    // Rule 8: the games G2G lists, and taking a copy down.
    g2gCategory: (game) =>
      (o.g2gGames || ["Brawlhalla"]).includes(game) ? { serviceId: "svc-items", brandId: "brand-" + game.toLowerCase() } : null,
    delistCopy: async (market, id) => {
      if (o.delistError) throw new Error(o.delistError);
      w.delisted.push({ market, id });
    },
    // utils/autofarmStock's vault rules: may an account be HELD for a market,
    // and how long its bundle must still last for that.
    vaultAllowed: (market) => o.vault === true && market === "gameflip",
    vaultMinLifeMs: () => 72 * HOUR,
    pricing: () => ({ priceListing: () => ({ price: w.enginePrice, basis: "game" }) }),
    pricingEvidence: () => ({ evidenceFor: async () => ({}) }),
    buildCover: async () => w.cover,
    listingGame: () => "Twitch",
    unlink: async (p) => {
      w.unlinked.push(p);
    },
    logEvent: (e) => {
      w.events.push(e);
    },
    sendTelegram: async (t) => {
      w.telegrams.push(t);
    },
    // utils/noclaimOfferRotation's own numbers and its "last hand-over" rule.
    rotation: () => ({
      PAUSED_ERROR: "paused: no claimable stock",
      MIN_ACCOUNTS: 10,
      RECENT_SALE_MS: 7 * DAY,
      lastDeliveredAt: (row) =>
        Math.max(0, ...((row && row.units) || []).map((u) => (u && u.deliveredAt ? new Date(u.deliveredAt).getTime() : 0))),
    }),
  };
  return w;
}

// A set as a row's shelf: the bundle's items the way a DropSet stores them.
const asSet = (items) => items.map(({ itemKey, name, game, qty }) => ({ itemKey, name, game, qty }));

const BRAWL = [
  item("Bitten Diana Skin", "Brawlhalla", "Brawlhalloween"),
  item("Teros CCv2", "Brawlhalla", "Brawlhalloween"),
  item("Brain Rotted Title", "Brawlhalla", "Brawlhalloween"),
];
const ENDED = { Brawlhalloween: T0 + 5 * DAY }; // ended two days ago, leaves in five

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("pickBundle: the fullest bundle enough accounts hold, never a rarer one", () => {
  const h = (pairs) => ({ items: new Map(pairs.map(([k, q]) => [k, { qty: q }])) });
  const holders = [
    h([["a", 1], ["b", 1], ["c", 1]]),
    h([["a", 1], ["b", 1], ["c", 1]]),
    h([["a", 1], ["b", 1]]),
    h([["a", 1], ["b", 1]]),
    h([["a", 1], ["b", 1]]),
  ];
  // Only two hold all three; all five hold a + b.
  const best = ao.pickBundle(holders, 3);
  assert.deepStrictEqual([...best.items.keys()].sort(), ["a", "b"]);
  assert.strictEqual(best.cover, 5);
  assert.strictEqual(best.copies, 2);
  // With a bar of two, the three-item bundle is the fuller one.
  assert.deepStrictEqual([...ao.pickBundle(holders, 2).items.keys()].sort(), ["a", "b", "c"]);
  assert.strictEqual(ao.pickBundle(holders, 6), null);
  assert.strictEqual(ao.pickBundle([], 1), null);
});

test("pickBundle: copies count — an account with fewer copies does not cover", () => {
  const h = (q) => ({ items: new Map([["pack", { qty: q }]]) });
  const best = ao.pickBundle([h(4), h(4), h(4), h(2), h(2)], 3);
  assert.strictEqual(best.items.get("pack").qty, 4);
  assert.strictEqual(best.cover, 3);
  // Five hold two copies: with a bar of four that is the bundle.
  const low = ao.pickBundle([h(4), h(4), h(4), h(2), h(2)], 4);
  assert.strictEqual(low.items.get("pack").qty, 2);
  assert.strictEqual(low.cover, 5);
});

test("offerPrice: the engine's price, cheaper, rounded down to x.x9, inside the limits", () => {
  const c = { priceFactor: 0.85, minPrice: 0.99, maxPrice: 1.49 };
  assert.strictEqual(ao.offerPrice(1.62, c), 1.29);
  assert.strictEqual(ao.offerPrice(1.34, c), 1.09);
  assert.strictEqual(ao.offerPrice(1.21, c), 0.99);
  assert.strictEqual(ao.offerPrice(0.91, c), 0.99); // never under the floor
  assert.strictEqual(ao.offerPrice(4.0, c), 1.49); // never over the ceiling
  assert.strictEqual(ao.offerPrice(0, c), 0.99); // no evidence
  assert.strictEqual(ao.offerPrice(NaN, c), 0.99);
  assert.strictEqual(ao.offerPrice(undefined, { priceFactor: 0.85, minPrice: 1.19, maxPrice: 1.49 }), 1.19);
});

test("cfg: off unless the switch is exactly true; numbers are clamped", () => {
  autoFarm = {};
  assert.strictEqual(ao.cfg().on, false);
  autoFarm = { autofarmOffers: "true" };
  assert.strictEqual(ao.cfg().on, false);
  autoFarm = { autofarmOffers: true, autofarmOfferMinHolders: 0, autofarmOfferMaxPerDay: 999, autofarmOfferMinPrice: 2, autofarmOfferMaxPrice: 1 };
  const c = ao.cfg();
  assert.strictEqual(c.on, true);
  assert.strictEqual(c.minHolders, 2);
  assert.strictEqual(c.maxPerDay, 30);
  assert.ok(c.maxPrice >= c.minPrice, "the ceiling is never under the floor");
  // Eldorado's own delivery switches: both must say "really delivering".
  assert.strictEqual(c.eldoradoOn, false);
  autoFarm = { eldoradoAutoDeliver: true };
  assert.strictEqual(ao.cfg().eldoradoOn, false, "the dry-run flag ships on");
  autoFarm = { eldoradoAutoDeliver: true, eldoradoDeliverDryRun: false };
  assert.strictEqual(ao.cfg().eldoradoOn, true);
});

test("longestLived: the copies an offer promises are the ones that last, and an unknown copy is never called finished", () => {
  const gone = { Old: 100, Mid: 500, New: 900 };
  const of = (name) => (name in gone ? gone[name] : Infinity);
  const coin = { qty: 4, waves: [{ campaign: "Old", qty: 1 }, { campaign: "Mid", qty: 1 }, { campaign: "New", qty: 2 }] };
  // Three of the four: the two newest and the middle one — not the one that leaves first.
  assert.deepStrictEqual(ao.longestLived(coin, 3, of), [{ campaign: "New", gone: 900 }, { campaign: "Mid", gone: 500 }]);
  assert.deepStrictEqual(ao.longestLived(coin, 2, of), [{ campaign: "New", gone: 900 }]);
  assert.deepStrictEqual(ao.longestLived(coin, 4, of).map((x) => x.campaign), ["New", "Mid", "Old"]);
  // Copies no wave accounts for: they count first, with no campaign and no date.
  assert.deepStrictEqual(ao.longestLived({ qty: 3, waves: [{ campaign: "Old", qty: 1 }] }, 2, of), [{ campaign: "", gone: Infinity }]);
  assert.deepStrictEqual(ao.longestLived({ qty: 1, waves: [] }, 1, of), [{ campaign: "", gone: Infinity }]);
  // A campaign nobody has an end date for.
  assert.deepStrictEqual(ao.longestLived({ qty: 1, waves: [{ campaign: "Unknown", qty: 1 }] }, 1, of), [{ campaign: "Unknown", gone: Infinity }]);
});

test("utcStamp: the minute, in UTC, in words no time zone can misread", () => {
  assert.strictEqual(ao.utcStamp(Date.parse("2026-10-16T14:04:59.999Z")), "16 Oct 2026, 14:04 UTC");
  assert.strictEqual(ao.utcStamp(Date.parse("2026-01-02T03:04:00Z")), "2 Jan 2026, 03:04 UTC");
});

test("fullTitle: names the event and every item, and gives up rather than cut", () => {
  assert.strictEqual(
    ao.fullTitle("Brawlhalla", "Brawlhalloween", BRAWL),
    "Brawlhalla Brawlhalloween Twitch Drops (3 Items) — Bitten Diana Skin + Teros CCv2 + Brain Rotted Title",
  );
  // An event that already names the game stands alone.
  assert.strictEqual(
    ao.fullTitle("SPAM", "SPAM Launch", [item("Avatar Sunset", "SPAM", "SPAM Launch")]),
    "SPAM Launch Twitch Drops (1 Item) — Avatar Sunset",
  );
  // "…Drops" is not said twice.
  assert.strictEqual(
    ao.fullTitle("RavenQuest", "Launch Drops", [item("Raven Cape", "RavenQuest", "Launch Drops")]),
    "RavenQuest Launch Twitch Drops (1 Item) — Raven Cape",
  );
  // No event, or one that adds nothing.
  assert.strictEqual(
    ao.fullTitle("THE FINALS", "", [item("Coin", "THE FINALS", "", 4)]),
    "THE FINALS Twitch Drops (4 Items) — 4× Coin",
  );
  assert.strictEqual(
    ao.fullTitle("THE FINALS", "The Finals Twitch Drops", [item("Coin", "THE FINALS", "")]),
    "THE FINALS Twitch Drops (1 Item) — Coin",
  );
  // Too long for a title: null, and the caller uses the house title.
  const many = Array.from({ length: 12 }, (_, i) => item("A Very Long Reward Name " + i, "Game", "Event"));
  assert.strictEqual(ao.fullTitle("Game", "Event", many), null);
  // An item without a name is never papered over.
  assert.strictEqual(ao.fullTitle("Game", "Event", [item("", "Game", "Event")]), null);
});

test("signatureOf: order-free, copy-aware, case-blind", () => {
  const a = [{ itemKey: "X|g", qty: 2 }, { itemKey: "y|g" }];
  const b = [{ itemKey: "y|g", qty: 1 }, { itemKey: "x|g", qty: 2 }];
  assert.strictEqual(ao.signatureOf(a), ao.signatureOf(b));
  assert.notStrictEqual(ao.signatureOf(a), ao.signatureOf([{ itemKey: "x|g" }, { itemKey: "y|g" }]));
});

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

test("off: nothing is read and nothing is published", async () => {
  autoFarm = { autofarmOffers: false };
  const w = world({ holdings: cohort("b", 8, BRAWL), gone: ENDED });
  const r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(r.off, true);
  assert.strictEqual(w.reads.snapshot, 0);
  assert.strictEqual(w.published.length, 0);
});

test("no-claim auto-delivery off: nothing is published", async () => {
  const w = world({ holdings: cohort("b", 8, BRAWL), gone: ENDED, delivery: false });
  const r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(r.off, true);
  assert.strictEqual(w.published.length, 0);
});

test("a finished bundle enough free accounts hold is listed once, at a low price, with quantity discounts", async () => {
  const w = world({ holdings: cohort("b", 8, BRAWL), gone: ENDED });
  const r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.created.length, 1);
  assert.strictEqual(w.published.length, 1);
  const pub = w.published[0];
  assert.strictEqual(pub.market, "eldorado");
  assert.strictEqual(pub.priceUsd, 0.99); // 1.21 x 0.85 -> 0.99
  assert.strictEqual(pub.body.eldorado.quantity, 8);
  assert.deepStrictEqual(pub.body.eldorado.volumeDiscounts, [
    { quantity: 3, percentage: 5 },
    { quantity: 5, percentage: 10 },
    { quantity: 10, percentage: 15 },
  ]);
  assert.match(pub.title, /^Brawlhalla Brawlhalloween Twitch Drops \(3 Items\) — /);
  // The buyer is told the drops are unclaimed and by when to claim them: a
  // day before the copies are due to leave (16 Oct 08:00), to the minute.
  assert.match(pub.description, /^House description for Brawlhalla\./);
  assert.match(pub.description, /claim these before 15 Oct 2026, 08:00 UTC\.$/);
  // The set is a no-claim set holding exactly the bundle.
  const set = w.sets.find((s) => String(s._id) === String(pub.set._id));
  assert.strictEqual(set.stockSource, "noclaim");
  assert.strictEqual(set.publicCatalog, false);
  assert.match(set.note, /^auto-farm unclaimed stock/);
  assert.deepStrictEqual(set.items.map((i) => i.name).sort(), BRAWL.map((i) => i.name).sort());
  assert.strictEqual(set.coverGame, "Brawlhalla");
  // The cover file is cleaned up, the owner is told.
  assert.deepStrictEqual(w.unlinked, ["/tmp/cover.png"]);
  assert.strictEqual(w.telegrams.length, 1);
  assert.match(w.telegrams[0], /LISTED/);
  assert.strictEqual(w.events[0].action, "autofarm_offer_created");

  // The next pass: those accounts are on a shelf now. Nothing more.
  const again = await ao.runPass({ deps: w.deps, now: T0 + 10 * 60 * 1000 });
  assert.strictEqual(again.created.length, 0);
  assert.strictEqual(w.published.length, 1);
});

test("the quantity a new offer advertises is capped", async () => {
  autoFarm.autofarmOfferQuantity = 20;
  const w = world({ holdings: cohort("b", 46, BRAWL), gone: ENDED });
  await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(w.published[0].body.eldorado.quantity, 20);
});

test("too few holders, stale reads and accounts that are not free do not make an offer", async () => {
  const few = world({ holdings: cohort("b", 4, BRAWL), gone: ENDED });
  assert.strictEqual((await ao.runPass({ deps: few.deps, now: T0 })).created.length, 0);

  const stale = world({ holdings: cohort("b", 8, BRAWL, { fresh: false }), gone: ENDED });
  assert.strictEqual((await ao.runPass({ deps: stale.deps, now: T0 })).created.length, 0);

  const taken = world({
    holdings: cohort("b", 4, BRAWL).concat(cohort("s", 6, BRAWL, { notFree: "sold or reserved (bot record)" })),
    gone: ENDED,
  });
  assert.strictEqual((await ao.runPass({ deps: taken.deps, now: T0 })).created.length, 0);

  // A no-claim BOT account is not this module's stock (and a single one does
  // not make the game the bots' either — see the fleet test).
  const bots = world({ holdings: cohort("b", 4, BRAWL).concat(cohort("n", 1, BRAWL, { farm: "", game: "Overwatch" })), gone: ENDED });
  assert.strictEqual((await ao.runPass({ deps: bots.deps, now: T0 })).created.length, 0);
});

test("a bundle is built from the copies that outlast the market's lead plus the margin", async () => {
  // "Old Wave" leaves in 30 hours: still there for a buyer today, but an offer
  // built on it would be taken off sale by the next stock sync.
  const items = BRAWL.concat([item("Old Skin", "Brawlhalla", "Old Wave")]);
  const w = world({ holdings: cohort("b", 6, items), gone: { ...ENDED, "Old Wave": T0 + 30 * HOUR } });
  const r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(r.created.length, 1);
  assert.deepStrictEqual(
    w.published[0].set.items.map((i) => i.name).sort(),
    BRAWL.map((i) => i.name).sort(),
  );
  assert.ok(w.reads.durableAt.includes(T0 + 36 * HOUR), "asked what is still held 36 hours from now");
});

test("nothing is listed while the accounts are still earning; six quiet hours later it is", async () => {
  // The campaign is still running: its copies leave long after (end + 7 days).
  const running = { Brawlhalloween: T0 + 20 * DAY };
  const two = BRAWL.slice(0, 2);
  const w = world({ holdings: cohort("b", 8, two), gone: running });
  let r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(r.created.length, 0);
  assert.strictEqual(r.waiting.length, 1);
  assert.strictEqual(r.waiting[0].game, "Brawlhalla");
  assert.strictEqual(r.waiting[0].readyAt, new Date(T0 + 6 * HOUR).toISOString());

  // Three hours in, the accounts finish a third drop: the wait starts again.
  for (const h of w.holdings) h.items = BRAWL.map((x) => ({ ...x }));
  r = await ao.runPass({ deps: w.deps, now: T0 + 3 * HOUR });
  assert.strictEqual(r.created.length, 0);
  assert.strictEqual(r.waiting[0].readyAt, new Date(T0 + 9 * HOUR).toISOString());

  r = await ao.runPass({ deps: w.deps, now: T0 + 8 * HOUR });
  assert.strictEqual(r.created.length, 0);

  r = await ao.runPass({ deps: w.deps, now: T0 + 9 * HOUR });
  assert.strictEqual(r.created.length, 1);
  assert.strictEqual(w.published[0].set.items.length, 3, "the finished bundle, not its first two drops");
  // The deadline is told whenever the leave time is known.
  assert.match(w.published[0].description, /claim these before 30 Oct 2026, 08:00 UTC\.$/);
});

test("a bundle whose accounts have nothing left to earn is listed at once — no six-hour wait", async () => {
  // The campaign runs for weeks yet, but its only three drops are done on
  // every account: the sweep's last read of each says "nothing left".
  const running = { Brawlhalloween: T0 + 20 * DAY };
  const done = { pendingAt: new Date(T0 - 10 * 60 * 1000), pending: [] };
  const w = world({ holdings: cohort("b", 8, BRAWL, done), gone: running });
  let r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(r.created.length, 1);
  assert.strictEqual(w.published[0].set.items.length, 3);

  // One of them still has a drop to go: the bundle may yet grow. It waits.
  const some = cohort("b", 8, BRAWL, done);
  some[3].pending = [{ game: "Brawlhalla", n: 1 }];
  const w2 = world({ holdings: some, gone: running });
  r = await ao.runPass({ deps: w2.deps, now: T0 });
  assert.strictEqual(r.created.length, 0);
  assert.strictEqual(r.waiting.length, 1);

  // …but only the accounts that can DELIVER the bundle are asked: seven are
  // done with all three; an eighth, two drops in, is still earning.
  const mixed = cohort("b", 7, BRAWL, done).concat(
    cohort("late", 1, BRAWL.slice(0, 2), { pendingAt: new Date(T0), pending: [{ game: "Brawlhalla", n: 1 }] }),
  );
  const w3 = world({ holdings: mixed, gone: running });
  r = await ao.runPass({ deps: w3.deps, now: T0 });
  assert.strictEqual(r.created.length, 1);
  assert.strictEqual(w3.published[0].body.eldorado.quantity, 7);

  // Drops still to earn on ANOTHER game say nothing about this bundle.
  const other = cohort("b", 8, BRAWL, { pendingAt: new Date(T0), pending: [{ game: "Marvel Rivals", n: 3 }] });
  const w4 = world({ holdings: other, gone: running });
  r = await ao.runPass({ deps: w4.deps, now: T0 });
  assert.strictEqual(r.created.length, 1);

  // Not known (a row no sweep has read since this was stored): the quiet
  // hours decide, as before.
  const unknown = world({ holdings: cohort("b", 8, BRAWL), gone: running });
  r = await ao.runPass({ deps: unknown.deps, now: T0 });
  assert.strictEqual(r.created.length, 0);
  r = await ao.runPass({ deps: unknown.deps, now: T0 + 6 * HOUR });
  assert.strictEqual(r.created.length, 1);
});

test("an item with no campaign on record is never called finished: it waits the quiet hours", async () => {
  const plain = [item("Mystery", "Predecessor", ""), item("Box", "Predecessor", "")];
  const w = world({ holdings: cohort("p", 6, plain) });
  let r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(r.created.length, 0);
  r = await ao.runPass({ deps: w.deps, now: T0 + 6 * HOUR });
  assert.strictEqual(r.created.length, 1);
  assert.doesNotMatch(w.published[0].description, /claim these before/, "no date is invented");
});

test("accounts an existing offer can sell are on a shelf — a second campaign gets its own offer, a bundle never two", async () => {
  const s4 = [item("S4 Spray", "Marvel Rivals", "Season 4"), item("S4 Emote", "Marvel Rivals", "Season 4")];
  const s5 = [item("S5 Spray", "Marvel Rivals", "Season 5"), item("S5 Emote", "Marvel Rivals", "Season 5")];
  const gone = { "Season 4": T0 + 3 * DAY, "Season 5": T0 + 6 * DAY };
  const w = world({
    holdings: cohort("a", 15, s4).concat(cohort("c", 6, s5)),
    gone,
    // The owner already made an offer for the Season 4 bundle by hand.
    sets: [{ coverGame: "Marvel Rivals", items: s4.map(({ itemKey, name, game, qty }) => ({ itemKey, name, game, qty })), note: "made by hand" }],
  });
  w.rows.push({ _id: oid(), marketplace: "eldorado", noclaimStock: true, status: "active", set: w.sets[0]._id });
  const r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(r.created.length, 1);
  assert.deepStrictEqual(w.published[0].set.items.map((i) => i.name).sort(), ["S5 Emote", "S5 Spray"]);
  assert.strictEqual(w.published[0].body.eldorado.quantity, 6);
  // And nothing more afterwards.
  const again = await ao.runPass({ deps: w.deps, now: T0 + HOUR });
  assert.strictEqual(again.created.length, 0);
  assert.strictEqual(w.published.length, 1);
});

test("accounts part-way to a bundle that is on sale wait for it — and after the campaign, until the fuller offer has sold", async () => {
  const mk = (gone) => {
    const w = world({
      // 10 accounts hold the whole bundle (on the shelf), 8 newer ones hold
      // its first two drops.
      holdings: cohort("old", 10, BRAWL).concat(cohort("new", 8, BRAWL.slice(0, 2))),
      gone,
      sets: [{ coverGame: "Brawlhalla", items: asSet(BRAWL) }],
    });
    w.rows.push({ _id: oid(), marketplace: "eldorado", noclaimStock: true, status: "active", set: w.sets[0]._id });
    return w;
  };
  // The campaign is still running: however long they sit there, no second
  // Brawlhalla offer is made for a part of the first.
  const running = mk({ Brawlhalloween: T0 + 20 * DAY });
  let r = await ao.runPass({ deps: running.deps, now: T0 });
  assert.strictEqual(r.created.length, 0);
  r = await ao.runPass({ deps: running.deps, now: T0 + 12 * HOUR });
  assert.strictEqual(r.created.length, 0);
  assert.strictEqual(running.published.length, 0);

  // The campaign is over: they will never hold more. But the ten accounts on
  // the shelf hold these two drops as well — the stock sync would count them
  // on BOTH offers (18 advertised here, 10 there, 18 accounts in all), and a
  // buyer could pay for an account that is not there.
  const over = mk(ENDED);
  r = await ao.runPass({ deps: over.deps, now: T0 });
  assert.strictEqual(r.created.length, 0);
  assert.strictEqual(r.skipped["accounts another offer already sells hold this bundle too"], 1);
  assert.strictEqual(over.published.length, 0);

  // Once the fuller offer has sold its accounts, what the others stopped at
  // is a bundle of its own.
  for (const h of over.holdings) if (/^old/.test(h.loginLower)) h.notFree = "sold";
  r = await ao.runPass({ deps: over.deps, now: T0 + HOUR });
  assert.strictEqual(r.created.length, 1);
  assert.strictEqual(over.published[0].set.items.length, 2);
  assert.strictEqual(over.published[0].body.eldorado.quantity, 8);
});

test("six cohorts stopped at different points of a finished campaign: one offer at a time, never the same account on two", async () => {
  const five = [1, 2, 3, 4, 5].map((n) => item("Drop " + n, "Arc Raiders", "Launch"));
  const holdings = [1, 2, 3, 4, 5].flatMap((n) => cohort("c" + n + "x", 6, five.slice(0, n)));
  const w = world({ holdings, gone: { Launch: T0 + 5 * DAY } });
  // Pass after pass, only the fullest bundle is on sale.
  for (let i = 0; i < 4; i++) {
    const r = await ao.runPass({ deps: w.deps, now: T0 + i * 10 * 60 * 1000 });
    assert.strictEqual(r.created.length, i === 0 ? 1 : 0);
  }
  assert.strictEqual(w.published.length, 1);
  assert.strictEqual(w.published[0].set.items.length, 5);
  assert.strictEqual(w.published[0].body.eldorado.quantity, 6);
  // When those six are sold, the next fullest follows — and so on down.
  for (const h of holdings) if (/^c5x/.test(h.loginLower)) h.notFree = "sold";
  const r = await ao.runPass({ deps: w.deps, now: T0 + HOUR });
  assert.strictEqual(r.created.length, 1);
  assert.strictEqual(w.published[1].set.items.length, 4);
  assert.strictEqual(w.published[1].body.eldorado.quantity, 6);
});

test("accounts holding two games' bundles get ONE offer: the buyer of the first takes the account, second game and all", async () => {
  const a = [item("Alpha Skin", "Alpha", "Alpha Event"), item("Alpha Hat", "Alpha", "Alpha Event")];
  const b = [item("Beta Skin", "Beta", "Beta Event")];
  const w = world({ holdings: cohort("m", 8, a.concat(b)), gone: { "Alpha Event": T0 + 4 * DAY, "Beta Event": T0 + 4 * DAY } });
  let r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(r.created.length, 1, "one pass, one offer — the plan is made again after the first");
  assert.strictEqual(w.published.length, 1);
  r = await ao.runPass({ deps: w.deps, now: T0 + 10 * 60 * 1000 });
  assert.strictEqual(r.created.length, 0);
  assert.strictEqual(w.published.length, 1);

  // Other accounts holding only the second game's bundle do not get an offer
  // either while the eight above hold it too.
  const w2 = world({
    holdings: cohort("m", 8, a.concat(b)).concat(cohort("solo", 6, b)),
    gone: { "Alpha Event": T0 + 4 * DAY, "Beta Event": T0 + 4 * DAY },
    sets: [{ coverGame: "Alpha", items: asSet(a) }],
  });
  w2.rows.push({ _id: oid(), marketplace: "eldorado", noclaimStock: true, status: "active", set: w2.sets[0]._id });
  r = await ao.runPass({ deps: w2.deps, now: T0 });
  assert.strictEqual(r.created.length, 0);
  assert.strictEqual(r.skipped["accounts another offer already sells hold this bundle too"], 1);
});

test("a shelf on another claim-at-sale market is a shelf too", async () => {
  const w = world({
    holdings: cohort("b", 8, BRAWL),
    gone: ENDED,
    // Two of the three drops are on sale on PlayerAuctions (a hand-made offer).
    sets: [{ coverGame: "Brawlhalla", items: asSet(BRAWL.slice(0, 2)) }],
  });
  w.rows.push({ _id: oid(), marketplace: "playerauctions", noclaimStock: true, status: "active", set: w.sets[0]._id });
  const r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(r.created.length, 0);
  assert.strictEqual(w.published.length, 0);
});

test("Eldorado orders are not really being delivered: nothing is listed", async () => {
  for (const flags of [
    { eldoradoAutoDeliver: false, eldoradoDeliverDryRun: false },
    { eldoradoAutoDeliver: true, eldoradoDeliverDryRun: true },
    { eldoradoAutoDeliver: true }, // the dry-run flag ships on
    {},
  ]) {
    autoFarm = { autofarmOffers: true, ...flags };
    const w = world({ holdings: cohort("b", 8, BRAWL), gone: ENDED });
    const r = await ao.runPass({ deps: w.deps, now: T0 });
    assert.strictEqual(r.off, true);
    assert.match(r.why, /Eldorado/);
    assert.strictEqual(w.reads.snapshot, 0);
    assert.strictEqual(w.published.length, 0);
  }
});

test("the date a buyer is given is about the copies they are sold — on every account that can be handed over", async () => {
  // Every account holds 4 Coins: one from an old wave that leaves in 30 hours,
  // three from the current one. Only three outlast the bundle lead, so the
  // offer is for three — and its date is theirs, not the old copy's.
  const coin = { ...item("Coin", "Arc Raiders", "Wave 2", 4), waves: [{ campaign: "Wave 1", qty: 1 }, { campaign: "Wave 2", qty: 3 }] };
  const gone = { "Wave 1": T0 + 30 * HOUR, "Wave 2": T0 + 6 * DAY };
  const w = world({ holdings: cohort("a", 6, [coin]), gone });
  let r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(r.created.length, 1);
  assert.strictEqual(w.published[0].set.items[0].qty, 3);
  assert.match(w.published[0].title, /\(3 Items\) — 3× Coin$/);
  assert.match(w.published[0].title, /^Arc Raiders Wave 2 /, "the event is the one the three copies came from");
  assert.match(w.published[0].description, /claim these before 16 Oct 2026, 08:00 UTC\.$/);

  // Two cohorts earned the same item in two campaigns: the date is the earlier
  // one — any of these accounts may be the one a buyer gets — and no single
  // event is named.
  const early = item("Badge", "Arc Raiders", "Week 1");
  const late = item("Badge", "Arc Raiders", "Week 2");
  const w2 = world({
    holdings: cohort("late", 4, [late]).concat(cohort("early", 4, [early])),
    gone: { "Week 1": T0 + 3 * DAY, "Week 2": T0 + 6 * DAY },
  });
  r = await ao.runPass({ deps: w2.deps, now: T0 });
  assert.strictEqual(r.created.length, 1);
  assert.strictEqual(w2.published[0].body.eldorado.quantity, 8);
  assert.match(w2.published[0].description, /claim these before 13 Oct 2026, 08:00 UTC\.$/);
  assert.match(w2.published[0].title, /^Arc Raiders Twitch Drops \(1 Item\) — Badge$/);
});

test("a campaign whose name was re-issued is not over while its namesake still runs", async () => {
  const w = world({
    holdings: cohort("b", 8, BRAWL),
    gone: ENDED,
    // Twitch re-used the name: one ended two days ago, one ends in ten.
    ends: { Brawlhalloween: [{ game: "Brawlhalla", endMs: T0 - 2 * DAY }, { game: "Brawlhalla", endMs: T0 + 10 * DAY }] },
  });
  let r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(r.created.length, 0, "the accounts may still be earning: it waits its quiet hours");
  assert.strictEqual(r.waiting.length, 1);
  r = await ao.runPass({ deps: w.deps, now: T0 + 6 * HOUR });
  assert.strictEqual(r.created.length, 1);
});

test("an offer of the game was taken down lately: the game is left to the owner, in whatever shape the bundle is now", async () => {
  const mk = (row, sets) => {
    const w = world({ holdings: cohort("b", 8, BRAWL), gone: ENDED, sets });
    w.rows.push({ _id: oid(), marketplace: "eldorado", noclaimStock: true, ...row, set: row.set === undefined ? w.sets[0]._id : row.set });
    return w;
  };
  // Delisted three days ago, on a SMALLER bundle of the game (the accounts
  // have earned a third drop since): rule 5's exact match would not see it.
  let w = mk({ status: "delisted", updatedAt: new Date(T0 - 3 * DAY) }, [{ coverGame: "Brawlhalla", items: asSet(BRAWL.slice(0, 2)) }]);
  let r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(r.created.length, 0);
  assert.strictEqual(r.skipped["an offer of this game was taken down lately — left to the owner"], 1);

  // The owner deleted the set as well: the row still names the game.
  w = mk({ status: "delisted", updatedAt: new Date(T0 - DAY), set: oid(), title: "Brawlhalla Brawlhalloween Twitch Drops (2 Items) — A + B" }, []);
  r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(r.created.length, 0);
  assert.strictEqual(w.published.length, 0);

  // Another game's delisted offer says nothing about this one…
  w = mk({ status: "delisted", updatedAt: new Date(T0 - DAY) }, [{ coverGame: "SPAM", items: asSet([item("Avatar", "SPAM", "SPAM Launch")]) }]);
  r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(r.created.length, 1);

  // …and after two weeks the game is the module's again (the exact bundle
  // that was delisted still is not: see the next test).
  w = mk({ status: "delisted", updatedAt: new Date(T0 - 15 * DAY) }, [{ coverGame: "Brawlhalla", items: asSet(BRAWL.slice(0, 2)) }]);
  r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(r.created.length, 1);
});

test("a paused offer the rotation can bring back is the rotation's — only then", async () => {
  const s4 = [item("S4 Spray", "Marvel Rivals", "Season 4")];
  const s5 = [item("S5 Spray", "Marvel Rivals", "Season 5")];
  const gone = { "Season 4": T0 + 20 * HOUR, "Season 5": T0 + 6 * DAY }; // S4 is inside the sell lead
  const mk = (n, row) => {
    const w = world({
      holdings: cohort("a", n, s4.concat(s5)),
      gone,
      // The offer was for both seasons' drops; the stock sync has paused it.
      sets: [{ coverGame: "Marvel Rivals", items: asSet(s4.concat(s5)) }],
    });
    w.rows.push({
      _id: oid(), marketplace: "eldorado", noclaimStock: true, status: "active", set: w.sets[0]._id,
      autoPaused: true, lastError: "paused: no claimable stock",
      units: [{ login: "x", deliveredAt: new Date(T0 - 2 * DAY) }],
      ...row,
    });
    return w;
  };
  // Twelve accounts hold what is left, the offer sold two days ago: the
  // rotation will move it onto this very bundle. A second offer next to it
  // would be a duplicate.
  let w = mk(12, {});
  let r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(r.created.length, 0);
  assert.strictEqual(r.skipped["a paused offer of this game is the rotation's to bring back"], 1);

  // Fewer than the rotation's ten: it will not act, so this does.
  w = mk(6, {});
  r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(r.created.length, 1);
  assert.deepStrictEqual(w.published[0].set.items.map((i) => i.name), ["S5 Spray"]);

  // No sale in a week: the rotation leaves such an offer paused for good.
  w = mk(12, { units: [{ login: "x", deliveredAt: new Date(T0 - 9 * DAY) }] });
  r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(r.created.length, 1);

  // A pause the owner made is not the rotation's either.
  w = mk(12, { autoPaused: false, lastError: "" });
  // (That offer is live as far as the shelves go, and nobody covers its set a
  // sell lead out, so the accounts are free for a new bundle.)
  r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(r.created.length, 1);

  // The rotation switched off.
  autoFarm.noclaimRotateOffers = false;
  w = mk(12, {});
  r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(r.created.length, 1);
});

test("an offer that went live without a row is never tried again — not after a day, not after a restart — and the owner is told", async () => {
  const w = world({
    holdings: cohort("b", 8, BRAWL),
    gone: ENDED,
    publishResult: { success: false, message: "published on Eldorado but the row could not be saved — delist it by hand: abc-123" },
  });
  let r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(r.errors.length, 1);
  assert.strictEqual(w.telegrams.length, 1);
  assert.match(w.telegrams[0], /went live but was not recorded/);
  assert.match(w.telegrams[0], /delist it by hand: abc-123/);
  // Its set is kept as the record.
  assert.strictEqual(w.sets.length, 1);
  assert.match(w.sets[0].note, /^auto-farm unclaimed stock .* — HOLD: published on Eldorado/);

  w.publishResult = null;
  r = await ao.runPass({ deps: w.deps, now: T0 + 2 * HOUR });
  assert.strictEqual(w.published.length, 1);
  // A restart forgets everything the process knew; the set does not.
  ao.resetMemory();
  r = await ao.runPass({ deps: w.deps, now: T0 + 3 * HOUR });
  assert.strictEqual(w.published.length, 1);
  assert.strictEqual(r.skipped["this bundle has had an offer already"], 1);
  r = await ao.runPass({ deps: w.deps, now: T0 + 25 * HOUR });
  assert.strictEqual(w.published.length, 1);
  assert.strictEqual(w.telegrams.length, 1, "told once");
});

test("a create that timed out or answered 5xx may have landed: held exactly like the one that did", async () => {
  for (const message of [
    "Eldorado publish failed (HTTP 502): Bad Gateway",
    "Eldorado publish failed: timeout of 30000ms exceeded",
    "Eldorado publish failed: socket hang up",
  ]) {
    ao.resetMemory();
    const w = world({ holdings: cohort("b", 8, BRAWL), gone: ENDED, publishResult: { success: false, message } });
    let r = await ao.runPass({ deps: w.deps, now: T0 });
    assert.deepStrictEqual(r.errors, ["Brawlhalla: " + message]);
    assert.strictEqual(w.sets.length, 1, message);
    assert.match(w.sets[0].note, / — HOLD: Eldorado publish failed/);
    assert.match(w.telegrams[0], /may have gone live without being recorded/);
    w.publishResult = null;
    ao.resetMemory();
    r = await ao.runPass({ deps: w.deps, now: T0 + 2 * DAY });
    assert.strictEqual(w.published.length, 1, "never tried again by itself");
  }
  // A refusal, or a failure before the create call, never landed: no hold.
  for (const message of [
    "Eldorado publish failed (HTTP 400): Maximum quantity exceeded",
    "Eldorado image upload failed (HTTP 503)",
    "Out of stock — no free no-claim account holds this whole bundle right now",
  ]) {
    ao.resetMemory();
    const w = world({ holdings: cohort("b", 8, BRAWL), gone: ENDED, publishResult: { success: false, message } });
    await ao.runPass({ deps: w.deps, now: T0 });
    assert.strictEqual(w.sets.length, 0, message);
    assert.strictEqual(w.telegrams.length, 0, message);
  }
});

test("a game whose publish keeps failing is tried three times a day, no more", async () => {
  const w = world({ holdings: cohort("b", 8, BRAWL), gone: ENDED, publishResult: { success: false, message: "Eldorado publish failed (HTTP 400): no" } });
  for (let i = 0; i < 6; i++) await ao.runPass({ deps: w.deps, now: T0 + i * (HOUR + 1000) });
  assert.strictEqual(w.published.length, 3);
  const r = await ao.runPass({ deps: w.deps, now: T0 + 7 * HOUR });
  assert.strictEqual(r.skipped["failed 3 times today"], 1);
  // The next day it may try again.
  await ao.runPass({ deps: w.deps, now: T0 + DAY });
  assert.strictEqual(w.published.length, 4);
});

test("a set another pass took over while the publish was failing is not deleted from under it", async () => {
  const w = world({
    holdings: cohort("b", 8, BRAWL),
    gone: ENDED,
    publishResult: { success: false, message: "Eldorado publish failed (HTTP 400): no" },
    // The rotation's own timer fired mid-publish and moved a paused offer onto
    // the identical set this pass had just made.
    onPublish: (ctx, world_) => {
      world_.rows.push({ _id: oid(), marketplace: "eldorado", noclaimStock: true, status: "active", set: ctx.set._id });
    },
  });
  const r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(r.errors.length, 1);
  assert.strictEqual(w.sets.length, 1, "a row points at it: it stays");
});

test("an offer the stock sync paused still holds its shelf while accounts can deliver it", async () => {
  const w = world({
    holdings: cohort("b", 8, BRAWL),
    gone: ENDED,
    sets: [{ coverGame: "Brawlhalla", items: BRAWL.map(({ itemKey, name, game, qty }) => ({ itemKey, name, game, qty })) }],
  });
  w.rows.push({ _id: oid(), marketplace: "eldorado", noclaimStock: true, status: "active", autoPaused: true, set: w.sets[0]._id });
  const r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(r.created.length, 0);
  assert.strictEqual(w.published.length, 0);
});

test("a game the no-claim bots farm is the owner's: never listed here", async () => {
  const ow = [item("Sun Tea Icon", "Overwatch", "OWCS Stage 3"), item("Spray", "Overwatch", "OWCS Stage 3")];
  const gone = { "OWCS Stage 3": T0 + 4 * DAY, Brawlhalloween: T0 + 5 * DAY };
  // By the fleet itself: bots whose game it is.
  const byBots = world({
    holdings: cohort("af", 9, ow).concat(cohort("bot", 1, [], { farm: "", game: "Overwatch 2" })),
    gone,
  });
  let r = await ao.runPass({ deps: byBots.deps, now: T0 });
  assert.strictEqual(r.created.length, 0);
  assert.strictEqual(r.skipped["a no-claim bot farms this game"], 1);

  // By the owner's no-claim list, even with no bot holding anything.
  autoFarm.noClaimGames = ["brawlhalla"];
  const byList = world({ holdings: cohort("b", 8, BRAWL), gone });
  r = await ao.runPass({ deps: byList.deps, now: T0 });
  assert.strictEqual(r.created.length, 0);
  assert.strictEqual(r.skipped["a no-claim bot farms this game"], 1);
  autoFarm.noClaimGames = ["overwatch", "rainbow six"];

  // Several bot accounts holding a game's drops make it theirs…
  const several = world({
    holdings: cohort("b", 8, BRAWL).concat(cohort("bot", 3, BRAWL, { farm: "", game: "Overwatch" })),
    gone,
  });
  r = await ao.runPass({ deps: several.deps, now: T0 });
  assert.strictEqual(r.created.length, 0);

  // …one stray account that picked a drop up on the side does not.
  const stray = world({
    holdings: cohort("b", 8, BRAWL).concat(cohort("bot", 1, BRAWL, { farm: "", game: "Overwatch" })),
    gone,
  });
  r = await ao.runPass({ deps: stray.deps, now: T0 });
  assert.strictEqual(r.created.length, 1);
  assert.strictEqual(stray.published[0].body.eldorado.quantity, 8, "the bot's own account is not counted as stock here");
});

test("a bundle that ever had an offer is never listed again — a delisted offer stays delisted", async () => {
  const w = world({
    holdings: cohort("b", 8, BRAWL),
    gone: ENDED,
    sets: [{ coverGame: "Brawlhalla", items: BRAWL.map(({ itemKey, name, game, qty }) => ({ itemKey, name, game, qty })), note: "auto-farm unclaimed stock (utils/autofarmOffers)" }],
  });
  w.rows.push({ _id: oid(), marketplace: "eldorado", noclaimStock: true, status: "delisted", set: w.sets[0]._id });
  const r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(r.created.length, 0);
  assert.strictEqual(r.skipped["this bundle has had an offer already"], 1);
  assert.strictEqual(w.published.length, 0);
  assert.strictEqual(w.sets.length, 1, "no second set is made");
});

test("an identical set no Eldorado offer was ever made on is reused, and never deleted when the publish fails", async () => {
  const mk = (publishResult) => {
    const w = world({
      holdings: cohort("b", 8, BRAWL),
      gone: ENDED,
      publishResult,
      sets: [{ coverGame: "Brawlhalla", items: asSet(BRAWL), note: "made for PlayerAuctions" }],
    });
    // Its only offer was on another market, and is no longer live.
    w.rows.push({ _id: oid(), marketplace: "playerauctions", noclaimStock: true, status: "delisted", set: w.sets[0]._id });
    return w;
  };
  const ok = mk(null);
  let r = await ao.runPass({ deps: ok.deps, now: T0 });
  assert.strictEqual(r.created.length, 1);
  assert.strictEqual(ok.sets.length, 1, "the existing set is used: no second copy of the bundle");
  assert.strictEqual(String(ok.published[0].set._id), String(ok.sets[0]._id));

  const bad = mk({ success: false, message: "Eldorado said no" });
  r = await ao.runPass({ deps: bad.deps, now: T0 });
  assert.strictEqual(r.created.length, 0);
  assert.deepStrictEqual(r.errors, ["Brawlhalla: Eldorado said no"]);
  assert.strictEqual(bad.sets.length, 1, "a set this pass did not make is not deleted");
  assert.strictEqual(bad.sets[0].note, "made for PlayerAuctions", "nor is its note touched");
});

test("a failed publish leaves no set behind and the game rests an hour", async () => {
  const w = world({ holdings: cohort("b", 8, BRAWL), gone: ENDED, publishResult: { success: false, message: "Out of stock" } });
  let r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.deepStrictEqual(r.errors, ["Brawlhalla: Out of stock"]);
  assert.strictEqual(w.sets.length, 0);
  assert.deepStrictEqual(w.unlinked, ["/tmp/cover.png"]);
  assert.strictEqual(w.telegrams.length, 0);

  // Ten minutes later: not tried again.
  r = await ao.runPass({ deps: w.deps, now: T0 + 10 * 60 * 1000 });
  assert.strictEqual(w.published.length, 1);
  assert.strictEqual(r.skipped["waiting after a failed publish"], 1);

  // An hour later it is, and this time it works.
  w.publishResult = null;
  r = await ao.runPass({ deps: w.deps, now: T0 + HOUR + 1000 });
  assert.strictEqual(r.created.length, 1);
  assert.strictEqual(w.sets.length, 1);
});

test("a publish that throws is a failure like any other", async () => {
  const w = world({ holdings: cohort("b", 8, BRAWL), gone: ENDED, publishResult: new Error("socket hang up") });
  const r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.deepStrictEqual(r.errors, ["Brawlhalla: socket hang up"]);
  assert.strictEqual(w.sets.length, 0);
});

test("no cover picture: nothing is published and no set is kept", async () => {
  const w = world({ holdings: cohort("b", 8, BRAWL), gone: ENDED, cover: "" });
  const r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.deepStrictEqual(r.errors, ["Brawlhalla: no cover image could be built"]);
  assert.strictEqual(w.published.length, 0);
  assert.strictEqual(w.sets.length, 0);
});

test("the market's own cap on offers ends the pass", async () => {
  const games = ["Alpha", "Beta", "Gamma"];
  const holdings = games.flatMap((g) => cohort(g.toLowerCase(), 6, [item(g + " Skin", g, g + " Event")]));
  const gone = Object.fromEntries(games.map((g) => [g + " Event", T0 + 4 * DAY]));
  const w = world({ holdings, gone, publishResult: { success: false, message: "Maximum of 300 active offers reached" } });
  const r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(w.published.length, 1, "the rest of the pass is not tried");
  assert.strictEqual(r.errors.length, 1);
});

test("at most two offers a pass and six a day", async () => {
  const games = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta"];
  const holdings = games.flatMap((g, i) => cohort(g.toLowerCase(), 6 + i, [item(g + " Skin", g, g + " Event")]));
  const gone = Object.fromEntries(games.map((g) => [g + " Event", T0 + 4 * DAY]));
  const w = world({ holdings, gone });
  let total = 0;
  for (let i = 0; i < 6; i++) {
    const r = await ao.runPass({ deps: w.deps, now: T0 + i * 10 * 60 * 1000 });
    assert.ok(r.created.length <= 2, "never more than two in one pass");
    total += r.created.length;
  }
  assert.strictEqual(total, 6);
  assert.strictEqual(w.published.length, 6);
  // The most widely held bundles went first.
  assert.match(w.published[0].title, /^Theta /);
  assert.match(w.published[1].title, /^Eta /);

  // A restart forgets the count; the sets it made today still say it.
  ao.resetMemory();
  const after = await ao.runPass({ deps: w.deps, now: T0 + 2 * HOUR });
  assert.strictEqual(after.created.length, 0);
  assert.ok(after.skipped["daily or per-pass limit reached"] >= 1);

  // Tomorrow there is room again.
  const next = await ao.runPass({ deps: w.deps, now: T0 + DAY });
  assert.strictEqual(next.created.length, 2);
});

test("a dry run reports what it would list and writes nothing", async () => {
  const w = world({ holdings: cohort("b", 8, BRAWL), gone: ENDED });
  const r = await ao.runPass({ deps: w.deps, now: T0, dryRun: true });
  assert.strictEqual(r.created.length, 1);
  assert.strictEqual(r.created[0].dryRun, true);
  assert.strictEqual(r.created[0].price, 0.99);
  assert.strictEqual(w.published.length, 0);
  assert.strictEqual(w.sets.length, 0);
  // …and uses up no room.
  const real = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(real.created.length, 1);
});

test("the pass never throws: a broken snapshot is an error line", async () => {
  const w = world({ holdings: cohort("b", 8, BRAWL), gone: ENDED });
  w.deps.nh.snapshotBase = async () => {
    throw new Error("mongo down");
  };
  const r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.deepStrictEqual(r.errors, ["mongo down"]);
  assert.strictEqual(w.published.length, 0);
});

// ---------------------------------------------------------------------------
// Rule 8 — copies on a second claim-at-sale market (G2G)
// ---------------------------------------------------------------------------

const OWN_NOTE = ao.SET_NOTE + " (utils/autofarmOffers)";
const G2G_ON = { autofarmOfferCopyMarkets: ["g2g"], g2gAutoDeliver: true, g2gDeliverDryRun: false };

// A world in which the Brawlhalla bundle is already on sale on Eldorado, on a
// set this lister made, and `n` free accounts hold it.
function copyWorld(n = 8, o = {}) {
  const w = world({
    holdings: cohort("b", n, BRAWL, o.extra || {}).concat(o.more || []),
    gone: o.gone || ENDED,
    sets: [{ name: "Brawlhalla set", note: o.note === undefined ? OWN_NOTE : o.note, coverGame: "Brawlhalla", items: asSet(BRAWL), price: 0.99 }].concat(o.sets || []),
    ...o.world,
  });
  w.set = w.sets[0];
  w.eld = { _id: oid(), marketplace: "eldorado", noclaimStock: true, status: "active", set: w.set._id, externalId: "eld-1", price: 0.99, ...(o.eld || {}) };
  w.rows.push(w.eld);
  return w;
}

test("cfg: copies are off by default, only a known market is kept, and G2G must really be delivering", () => {
  assert.deepStrictEqual(ao.cfg().copyMarkets, []);
  autoFarm = { ...autoFarm, autofarmOfferCopyMarkets: ["G2G", "g2g", "ggsel", "digiseller", "playerauctions", ""] };
  assert.deepStrictEqual(ao.cfg().copyMarkets, ["g2g"], "never a vault market, never Plati");
  assert.strictEqual(ao.cfg().g2gOn, false);
  autoFarm = { ...autoFarm, g2gAutoDeliver: true };
  assert.strictEqual(ao.cfg().g2gOn, false, "the dry-run flag ships on");
  autoFarm = { ...autoFarm, g2gDeliverDryRun: false };
  assert.strictEqual(ao.cfg().g2gOn, true);
  autoFarm = { ...autoFarm, g2gSyncStock: false };
  assert.strictEqual(ao.cfg().g2gOn, false, "a copy nobody keeps in step with the stock oversells");
  autoFarm = { ...autoFarm, autofarmOfferCopyMarkets: "g2g" };
  assert.deepStrictEqual(ao.cfg().copyMarkets, [], "a list, or nothing");
  // Gameflip is a copy market of the other kind (it HOLDS the account).
  autoFarm = { ...autoFarm, autofarmOfferCopyMarkets: ["gameflip", "g2g", "Gameflip"] };
  assert.deepStrictEqual(ao.cfg().copyMarkets, ["gameflip", "g2g"]);
  assert.deepStrictEqual(ao.COPY_KIND, { g2g: "claim", gameflip: "vault" });
  assert.strictEqual(ao.cfg().vaultUnits, 2);
  assert.strictEqual(ao.cfg().vaultMinHolders, 8);
  autoFarm = { ...autoFarm, autofarmOfferVaultUnits: 99, autofarmOfferVaultMinHolders: 0 };
  assert.strictEqual(ao.cfg().vaultUnits, 10);
  assert.strictEqual(ao.cfg().vaultMinHolders, 2);
});

test("ownSet: this lister's sets, and sets grown or rotated out of them — never anyone else's", () => {
  const a = { _id: "a".repeat(24), note: OWN_NOTE };
  const grown = { _id: "b".repeat(24), note: "Made 2026-10-11 by the no-claim offer grow: the accounts behind set " + "a".repeat(24) + " (3 Items) now also hold X." };
  const rotated = { _id: "c".repeat(24), note: "Made 2026-10-12 by the no-claim offer rotation: set " + "b".repeat(24) + " (4 Items) had expired off every account." };
  const owners = { _id: "d".repeat(24), note: "Overwatch OWCS bundle" };
  const fromOwners = { _id: "e".repeat(24), note: "Made 2026-10-11 by the no-claim offer grow: the accounts behind set " + "d".repeat(24) + " (6 Items) now also hold Y." };
  const byId = new Map([a, grown, rotated, owners, fromOwners].map((x) => [x._id, x]));
  assert.strictEqual(ao.ownSet(a, byId), true);
  assert.strictEqual(ao.ownSet(grown, byId), true);
  assert.strictEqual(ao.ownSet(rotated, byId), true, "two steps back");
  assert.strictEqual(ao.ownSet(owners, byId), false);
  assert.strictEqual(ao.ownSet(fromOwners, byId), false);
  // A parent that cannot be read proves nothing.
  assert.strictEqual(ao.ownSet(grown, new Map()), false);
  // A note that merely mentions a set is not a lineage.
  assert.strictEqual(ao.ownSet({ note: "see set " + "a".repeat(24) }, byId), false);
  assert.strictEqual(ao.ownSet(null, byId), false);
});

test("a finished offer gets ONE copy on G2G: the same set, G2G's fields, and marked as a copy", async () => {
  autoFarm = { ...autoFarm, ...G2G_ON };
  const w = copyWorld(8);
  const r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.created.length, 0, "the accounts are on a shelf: no second Eldorado offer");
  assert.strictEqual(r.copies.length, 1);
  assert.strictEqual(w.published.length, 1);
  const p = w.published[0];
  assert.strictEqual(p.market, "g2g");
  assert.strictEqual(String(p.set._id), String(w.set._id), "the SAME set: the stock sync splits one shelf");
  assert.deepStrictEqual(p.body, { g2g: { qty: 8 } });
  assert.deepStrictEqual(p.cat, { serviceId: "svc-items", brandId: "brand-brawlhalla" });
  assert.strictEqual(p.priceUsd, 1, "G2G's own floor: an offer under a dollar is refused there");
  assert.strictEqual(w.set.note, OWN_NOTE, "the record made before the publish is gone again");
  assert.ok(p.title.length <= 128, "G2G cuts a title at 128");
  assert.match(p.title, /^Brawlhalla Brawlhalloween Twitch Drops \(3 Items\)/);
  assert.match(p.description, /claim these before 15 Oct 2026, 08:00 UTC\.$/);
  assert.strictEqual(w.sets.length, 1, "no new set");
  const row = w.rows.find((x) => x.marketplace === "g2g");
  assert.ok(row.note.endsWith(ao.COPY_MARK));
  assert.strictEqual(r.copies[0].tagged, true);
  assert.strictEqual(r.copies[0].holders, 8);
  assert.ok(w.telegrams.some((t) => /ALSO LISTED on G2G/.test(t)));
  assert.ok(w.events.some((e) => e.action === "autofarm_offer_copied" && e.severity === "info"));

  // The next pass: the set has its copy.
  const again = await ao.runPass({ deps: w.deps, now: T0 + HOUR });
  assert.strictEqual(again.copies.length, 0);
  assert.strictEqual(w.published.length, 1);
  assert.deepStrictEqual(again.copiesDown, [], "it still has its Eldorado offer");
});

test("a copy is made only when every condition holds", async () => {
  const run = async (o = {}, af = {}) => {
    autoFarm = { autofarmOffers: true, eldoradoAutoDeliver: true, eldoradoDeliverDryRun: false, noClaimGames: ["overwatch", "rainbow six"], ...G2G_ON, ...af };
    ao.resetMemory();
    const w = copyWorld(o.n || 8, o);
    const r = await ao.runPass({ deps: w.deps, now: T0 });
    return { w, r, n: w.published.filter((p) => p.market === "g2g").length };
  };
  assert.strictEqual((await run()).n, 1, "the base case copies");

  // The switch.
  assert.strictEqual((await run({}, { autofarmOfferCopyMarkets: [] })).n, 0);
  // G2G not really delivering.
  let x = await run({}, { g2gDeliverDryRun: true });
  assert.strictEqual(x.n, 0);
  assert.strictEqual(x.r.skipped["copy: G2G delivery or its stock sync is off"], 1);
  // A game G2G does not list (or that nobody mapped): never a guess.
  x = await run({ world: { g2gGames: [] } });
  assert.strictEqual(x.n, 0);
  assert.strictEqual(x.r.skipped["copy: the market does not list this game"], 1);
  // Too few accounts to share between two offers.
  x = await run({ n: 5 });
  assert.strictEqual(x.n, 0);
  assert.strictEqual(x.r.skipped["copy: too few accounts for a second market"], 1);
  assert.strictEqual((await run({ n: 5 }, { autofarmOfferCopyMinHolders: 5 })).n, 1);
  // Still earning: the offer may yet grow, and a copy would be left behind.
  x = await run({ gone: { Brawlhalloween: T0 + 12 * DAY }, extra: { pendingAt: new Date(T0 - HOUR), pending: [{ game: "Brawlhalla", n: 2 }] } });
  assert.strictEqual(x.n, 0);
  assert.strictEqual(x.r.skipped["copy: its accounts are still earning"], 1);
  // …and copied the moment every account has nothing left to earn.
  x = await run({ gone: { Brawlhalloween: T0 + 12 * DAY }, extra: { pendingAt: new Date(T0 - HOUR), pending: [] } });
  assert.strictEqual(x.n, 1);
  // Not known whether they are still earning (no sweep read since): wait.
  x = await run({ gone: { Brawlhalloween: T0 + 12 * DAY } });
  assert.strictEqual(x.n, 0);
  // About to come off sale: a day's lead, and under a day of selling left.
  x = await run({ gone: { Brawlhalloween: T0 + 47 * HOUR } });
  assert.strictEqual(x.n, 0);
  // The Eldorado offer is paused by the stock sync: nothing to stand beside.
  assert.strictEqual((await run({ eld: { autoPaused: true } })).n, 0);
  // …or delisted.
  assert.strictEqual((await run({ eld: { status: "delisted" } })).n, 0);
  // A set this lister did not make (the owner's own listing of the game).
  assert.strictEqual((await run({ note: "my Brawlhalla bundle" })).n, 0);
  // A set kept as the record of a publish that may be live without a row.
  assert.strictEqual((await run({ note: OWN_NOTE + " — HOLD: Eldorado publish failed (HTTP 502)" })).n, 0);
  // The owner's no-claim game, even on a set with this lister's note.
  x = await run({}, { noClaimGames: ["brawlhalla"] });
  assert.strictEqual(x.n, 0);
  assert.strictEqual(x.r.skipped["copy: a no-claim bot farms this game"], 1);
  // A no-claim bot account that holds the bundle too: not purely auto-farm stock.
  x = await run({ more: [{ loginLower: "fleet1", login: "fleet1", farm: "", inConfig: true, fresh: true, game: "Overwatch", items: BRAWL.map((i) => ({ ...i })) }] });
  assert.strictEqual(x.n, 0);
  assert.strictEqual(x.r.skipped["copy: a no-claim bot account holds this bundle too"], 1);
  // Accounts that are not free do not count toward the bar.
  assert.strictEqual((await run({ n: 8, extra: { notFree: "a game is connected" } })).n, 0);
});

test("a set grown out of this lister's set gets its copy; one grown out of the owner's does not", async () => {
  autoFarm = { ...autoFarm, ...G2G_ON };
  const parent = { name: "parent", note: OWN_NOTE, coverGame: "Brawlhalla", items: asSet(BRAWL.slice(0, 2)) };
  const w = copyWorld(8, { note: "placeholder", sets: [parent] });
  w.set.note = "Made 2026-10-11 by the no-claim offer grow: the accounts behind set " + String(w.sets[1]._id) + " (2 Items) now also hold Brain Rotted Title.";
  const r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(r.copies.length, 1);
  assert.strictEqual(String(w.published[0].set._id), String(w.set._id));

  ao.resetMemory();
  const w2 = copyWorld(8, { note: "placeholder", sets: [{ ...parent, note: "the owner's set" }] });
  w2.set.note = "Made 2026-10-11 by the no-claim offer grow: the accounts behind set " + String(w2.sets[1]._id) + " (2 Items) now also hold Brain Rotted Title.";
  assert.strictEqual((await ao.runPass({ deps: w2.deps, now: T0 })).copies.length, 0);
});

test("a set never gets a second copy on a market — whatever became of the first", async () => {
  autoFarm = { ...autoFarm, ...G2G_ON };
  for (const status of ["active", "delisted", "sold", "removed"]) {
    ao.resetMemory();
    const w = copyWorld(8);
    w.rows.push({ _id: oid(), marketplace: "g2g", noclaimStock: true, status, set: w.set._id, externalId: "g-old", note: "x" + ao.COPY_MARK, createdAt: new Date(T0 - 3 * DAY) });
    const r = await ao.runPass({ deps: w.deps, now: T0 });
    assert.strictEqual(r.copies.length, 0, status);
    assert.strictEqual(w.published.length, 0, status);
  }
});

test("one copy a pass, the most widely held first, and a daily limit", async () => {
  autoFarm = { ...autoFarm, ...G2G_ON, autofarmOfferCopiesPerDay: 2 };
  const games = ["Alpha", "Beta", "Gamma"];
  const holdings = [];
  const sets = [];
  const gone = {};
  games.forEach((g, i) => {
    const items = [item(g + " Skin", g, g + " Launch")];
    gone[g + " Launch"] = T0 + 5 * DAY;
    holdings.push(...cohort(g.toLowerCase(), 6 + i, items));
    sets.push({ name: g, note: OWN_NOTE, coverGame: g, items: asSet(items) });
  });
  const w = world({ holdings, gone, sets, g2gGames: games });
  for (const s of w.sets) w.rows.push({ _id: oid(), marketplace: "eldorado", noclaimStock: true, status: "active", set: s._id });
  const first = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(first.copies.length, 1);
  assert.strictEqual(first.copies[0].game, "Gamma", "eight accounts: the widest shelf first");
  const second = await ao.runPass({ deps: w.deps, now: T0 + HOUR });
  assert.strictEqual(second.copies[0].game, "Beta");
  const third = await ao.runPass({ deps: w.deps, now: T0 + 2 * HOUR });
  assert.strictEqual(third.copies.length, 0);
  assert.strictEqual(third.skipped["copy: daily limit reached"], 1);
  // A restart forgets nothing: the rows themselves say what was made today.
  ao.resetMemory();
  assert.strictEqual((await ao.runPass({ deps: w.deps, now: T0 + 3 * HOUR })).copies.length, 0);
  // Tomorrow there is room again.
  assert.strictEqual((await ao.runPass({ deps: w.deps, now: T0 + DAY })).copies[0].game, "Alpha");
});

test("a copy follows its Eldorado offer: when that moves on or comes down, the copy comes down too", async () => {
  autoFarm = { ...autoFarm, ...G2G_ON };
  const w = copyWorld(8);
  await ao.runPass({ deps: w.deps, now: T0 });
  const copy = w.rows.find((x) => x.marketplace === "g2g");
  assert.strictEqual(copy.status, "active");
  // A row the owner published by hand on the same set: no mark, never touched.
  const manual = { _id: oid(), marketplace: "g2g", noclaimStock: true, status: "active", set: w.set._id, externalId: "g-manual", note: "my own listing" };
  w.rows.push(manual);

  // While the Eldorado offer stands on the set — even paused by the stock sync — nothing moves.
  w.eld.autoPaused = true;
  assert.deepStrictEqual((await ao.runPass({ deps: w.deps, now: T0 + HOUR })).copiesDown, []);
  assert.deepStrictEqual(w.delisted, []);

  // The grow pass moves the Eldorado offer on to a bigger set.
  w.eld.autoPaused = false;
  w.eld.set = oid();
  const r = await ao.runPass({ deps: w.deps, now: T0 + 2 * HOUR });
  assert.deepStrictEqual(r.copiesDown, [{ market: "g2g", externalId: copy.externalId, title: "" }]);
  assert.deepStrictEqual(w.delisted, [{ market: "g2g", id: copy.externalId }]);
  assert.strictEqual(copy.status, "delisted");
  assert.match(copy.note, /taken down 2026-10-11 10:00Z: its Eldorado offer moved on$/);
  assert.strictEqual(manual.status, "active", "the owner's own row is not this lister's to take down");
  assert.ok(w.events.some((e) => e.action === "autofarm_copy_down"));
  // Once: a delisted copy is not swept again.
  assert.deepStrictEqual((await ao.runPass({ deps: w.deps, now: T0 + 3 * HOUR })).copiesDown, []);
  assert.strictEqual(w.delisted.length, 1);
});

test("a copy that cannot be taken down stays on the books and is tried again; copies are swept even with the copy switch off", async () => {
  autoFarm = { ...autoFarm, ...G2G_ON };
  const w = copyWorld(8, { world: { delistError: "G2G update offer failed (HTTP 503)" } });
  await ao.runPass({ deps: w.deps, now: T0 });
  const copy = w.rows.find((x) => x.marketplace === "g2g");
  w.eld.status = "delisted";
  const r = await ao.runPass({ deps: w.deps, now: T0 + HOUR });
  assert.deepStrictEqual(r.copiesDown, []);
  assert.strictEqual(copy.status, "active", "still on sale: the row must keep saying so");

  // The owner turns copies off: no new ones, but the one left behind still comes down.
  autoFarm = { ...autoFarm, autofarmOfferCopyMarkets: [] };
  w.deps.delistCopy = async (market, id) => {
    w.delisted.push({ market, id });
  };
  const r2 = await ao.runPass({ deps: w.deps, now: T0 + 2 * HOUR });
  assert.strictEqual(r2.copiesDown.length, 1);
  assert.strictEqual(copy.status, "delisted");
});

test("a failed copy: a clean refusal rests an hour, an unlistable game a week, and nothing is marked", async () => {
  autoFarm = { ...autoFarm, ...G2G_ON };
  const w = copyWorld(8, { world: { publishResult: { success: false, message: "Could not count the no-claim stock right now: x" } } });
  const r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(r.copies.length, 0);
  assert.match(r.errors[0], /^Brawlhalla \(g2g copy\): Could not count/);
  assert.strictEqual(w.set.note, OWN_NOTE, "a clean failure leaves the set as it was");
  assert.strictEqual(w.telegrams.length, 0);
  // Not again inside the hour…
  const soon = await ao.runPass({ deps: w.deps, now: T0 + 30 * 60 * 1000 });
  assert.strictEqual(w.published.length, 1);
  assert.strictEqual(soon.skipped["copy: waiting after a failed publish"], 1);
  // …then again, three times a day at most.
  await ao.runPass({ deps: w.deps, now: T0 + 61 * 60 * 1000 });
  await ao.runPass({ deps: w.deps, now: T0 + 122 * 60 * 1000 });
  assert.strictEqual(w.published.length, 3);
  const capped = await ao.runPass({ deps: w.deps, now: T0 + 190 * 60 * 1000 });
  assert.strictEqual(w.published.length, 3);
  assert.strictEqual(capped.skipped["copy: failed 3 times today"], 1);

  ao.resetMemory();
  const u = copyWorld(8, { world: { publishResult: { success: false, message: "G2G needs Server for this game and we have no offer of our own to copy it from. List one brand offer by hand on g2g.com first" } } });
  await ao.runPass({ deps: u.deps, now: T0 });
  await ao.runPass({ deps: u.deps, now: T0 + 2 * DAY });
  assert.strictEqual(u.published.length, 1, "asking again tomorrow changes nothing");
  await ao.runPass({ deps: u.deps, now: T0 + 8 * DAY - HOUR });
  assert.strictEqual(u.published.length, 1);
});

test("a copy that may be live without a row is never tried again, and the owner is told once", async () => {
  autoFarm = { ...autoFarm, ...G2G_ON };
  for (const [message, kind] of [
    ["G2G publish offer failed (HTTP 502): Bad gateway", /may have gone live without being recorded — check g2g/],
    ["G2G publish: offer 123 did not read back as a live offer", /may have gone live without being recorded/],
    ["published on G2G but the row could not be saved — delist it by hand: 123", /went live but was not recorded — take it down by hand/],
  ]) {
    ao.resetMemory();
    const w = copyWorld(8, { world: { publishResult: { success: false, message } } });
    const r = await ao.runPass({ deps: w.deps, now: T0 });
    assert.strictEqual(r.copies.length, 0);
    assert.ok(w.set.note.startsWith(OWN_NOTE + " — HOLD: g2g copy 2026-10-11 08:00Z: "), w.set.note);
    assert.strictEqual(w.telegrams.length, 1);
    assert.match(w.telegrams[0], kind);
    // Not after a day, not after a restart: the set's own note says so.
    ao.resetMemory();
    await ao.runPass({ deps: w.deps, now: T0 + 2 * DAY });
    assert.strictEqual(w.published.length, 1, message);
    assert.strictEqual(w.telegrams.length, 1);
    // And the Eldorado offer of the set is untouched.
    assert.strictEqual(w.eld.status, "active");
  }
});

test("a copy whose row could not be marked is reported, and a dry run writes nothing", async () => {
  autoFarm = { ...autoFarm, ...G2G_ON };
  const w = copyWorld(8, { world: { tagError: "mongo write failed" } });
  const r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(r.copies.length, 1);
  assert.strictEqual(r.copies[0].tagged, false);
  assert.ok(w.events.some((e) => e.action === "autofarm_offer_copied" && e.severity === "warn" && /NOT marked as a copy/.test(e.detail)));

  ao.resetMemory();
  const d = copyWorld(8);
  const dry = await ao.runPass({ deps: d.deps, now: T0, dryRun: true });
  assert.strictEqual(dry.copies.length, 1);
  assert.strictEqual(dry.copies[0].dryRun, true);
  assert.strictEqual(dry.copies[0].market, "g2g");
  assert.strictEqual(d.published.length, 0);
  assert.strictEqual(d.rows.filter((x) => x.marketplace === "g2g").length, 0);
});

test("copies run on their own feet: a failure in them never undoes the Eldorado pass, and the pass still never throws", async () => {
  autoFarm = { ...autoFarm, ...G2G_ON };
  const w = world({ holdings: cohort("b", 8, BRAWL), gone: ENDED });
  const realFind = w.deps.MarketplaceListing.find;
  let calls = 0;
  w.deps.MarketplaceListing.find = (q) => {
    // The copy sweep's read (active rows on the copy markets alone) fails.
    if (q.marketplace && q.marketplace.$in && q.marketplace.$in.join() === "g2g" && q.status === "active") {
      calls++;
      return { lean: async () => { throw new Error("mongo blip"); } };
    }
    return realFind(q);
  };
  const r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(r.created.length, 1, "the Eldorado offer was made");
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(r.errors, ["copy sweep: mongo blip"]);

  // The copy plan failing is an error line too, after the Eldorado pass.
  ao.resetMemory();
  const w2 = world({ holdings: cohort("b", 8, BRAWL), gone: ENDED });
  const find2 = w2.deps.MarketplaceListing.find;
  w2.deps.MarketplaceListing.find = (q) => {
    if (q.marketplace === "eldorado" && q.status === "active" && !q.set) {
      return { lean: async () => { throw new Error("plan blip"); } };
    }
    return find2(q);
  };
  const r2 = await ao.runPass({ deps: w2.deps, now: T0 });
  assert.strictEqual(r2.created.length, 1);
  assert.deepStrictEqual(r2.errors, ["copies: plan blip"]);
});

// --- what the independent review found, pinned -------------------------------

test("copyPrice: never above the Eldorado offer times the factor, never under the market's own floor", () => {
  const c = { priceFactor: 0.85, minPrice: 0.75, maxPrice: 1.49, copyPriceFactor: 1.2 };
  // The engine wants $1.49 for a bundle that costs $0.99 on Eldorado: $1.09.
  assert.strictEqual(ao.copyPrice(1.81, 0.99, "g2g", c), 1.09);
  // The engine's own figure when it is the lower one.
  assert.strictEqual(ao.copyPrice(3.21, 1.39, "g2g", c), 1.49);
  assert.strictEqual(ao.copyPrice(1.34, 1.39, "g2g", c), 1.09);
  // G2G refuses an offer under a dollar: a $0.75 bundle is $1.00 there, not $0.89.
  assert.strictEqual(ao.copyPrice(1.13, 0.75, "g2g", c), 1);
  assert.strictEqual(ao.copyPrice(0, 0.75, "g2g", c), 1);
  // No Eldorado price on record: the engine's figure, still over the floor.
  assert.strictEqual(ao.copyPrice(1.25, 0, "g2g", c), 1);
  assert.strictEqual(ao.copyPrice(1.62, undefined, "g2g", c), 1.29);
  // A market with no floor of its own keeps the lister's.
  assert.strictEqual(ao.copyPrice(1.13, 0.75, "elsewhere", c), 0.89);
});

test("holdNote: the record survives however long the set's note is", () => {
  const long = "Made 2026-10-11 by the no-claim offer grow: " + "x".repeat(700);
  const n = ao.holdNote(long, "g2g copy: G2G publish offer failed (HTTP 502): Bad gateway");
  assert.ok(n.length <= 600);
  assert.ok(n.includes(" — HOLD: g2g copy: G2G publish offer failed (HTTP 502)"));
  assert.ok(n.startsWith("Made 2026-10-11 by the no-claim offer grow: "));
  // A very long message is cut, the mark is not.
  const m = ao.holdNote("short", "y".repeat(900));
  assert.ok(m.startsWith("short — HOLD: y"));
  assert.ok(m.length <= 600);
});

test("the price of a copy follows its Eldorado offer", async () => {
  autoFarm = { ...autoFarm, ...G2G_ON };
  let w = copyWorld(8, { world: { enginePrice: 1.81 } });
  await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(w.published[0].priceUsd, 1.09, "$0.99 on Eldorado, never $1.49 beside it");
  ao.resetMemory();
  w = copyWorld(8, { eld: { price: 1.39 }, world: { enginePrice: 3.21 } });
  await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(w.published[0].priceUsd, 1.49);
  // Two Eldorado offers on the set: the cheaper one decides.
  ao.resetMemory();
  w = copyWorld(8, { eld: { price: 1.39 }, world: { enginePrice: 3.21 } });
  w.rows.push({ _id: oid(), marketplace: "eldorado", noclaimStock: true, status: "active", set: w.set._id, price: 0.99 });
  await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(w.published[0].priceUsd, 1.09);
});

test("one attempt a pass even when it fails — five sets are never five refusals in one breath", async () => {
  autoFarm = { ...autoFarm, ...G2G_ON };
  const games = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"];
  const holdings = [];
  const sets = [];
  const gone = {};
  for (const g of games) {
    const items = [item(g + " Skin", g, g + " Launch")];
    gone[g + " Launch"] = T0 + 5 * DAY;
    holdings.push(...cohort(g.toLowerCase(), 7, items));
    sets.push({ name: g, note: OWN_NOTE, coverGame: g, items: asSet(items) });
  }
  const w = world({ holdings, gone, sets, g2gGames: games, publishResult: { success: false, message: "G2G publish offer failed (HTTP 400): title is invalid" } });
  for (const s of w.sets) w.rows.push({ _id: oid(), marketplace: "eldorado", noclaimStock: true, status: "active", set: s._id, price: 0.99 });
  const r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(w.published.length, 1, "one try, then the pass is over");
  assert.strictEqual(r.errors.length, 1);
  // A plain refusal (4xx) did not land: nothing is held, nobody is paged.
  assert.strictEqual(w.telegrams.length, 0);
  assert.ok(w.sets.every((s) => s.note === OWN_NOTE));
  // The next pass moves on to the next set.
  await ao.runPass({ deps: w.deps, now: T0 + 10 * 60 * 1000 });
  assert.strictEqual(w.published.length, 2);
  assert.notStrictEqual(String(w.published[0].set._id), String(w.published[1].set._id));
});

test("what counts as 'may be live': once the write was sent, everything but a plain 4xx refusal", async () => {
  autoFarm = { ...autoFarm, ...G2G_ON };
  const held = [
    "G2G publish offer failed (HTTP 502): Bad gateway",
    "G2G publish offer failed (HTTP 504)",
    "G2G publish offer failed: timeout of 30000ms exceeded",
    "G2G publish offer failed: socket hang up",
    "G2G publish offer failed: read ECONNRESET",
    // G2G answered 200 and the body broke off: the write landed.
    "G2G publish offer failed (HTTP 200): stream has been aborted",
    // An error reported INSIDE a 200 does not say which side failed.
    "G2G publish offer failed: Internal server error",
    "G2G publish offer failed: code 5003",
    "G2G publish offer failed: Missing mandatory parameter: currency",
    "G2G publish: offer 9f3 did not read back as a live offer",
    "published on G2G but the row could not be saved — delist it by hand: 9f3",
  ];
  const clean = [
    "G2G publish offer failed (HTTP 400): title is invalid",
    "G2G publish offer failed (HTTP 422): unit_price below the minimum; timeout window",
    "G2G publish offer failed (HTTP 429): Too many requests",
    "G2G publish offer failed (HTTP 401): Unauthorized",
    "G2G's minimum price is 1.00",
    "G2G create offer failed (HTTP 502): Bad gateway", // the shell: nothing is on sale yet
    "G2G needs Server for this game and we have no offer of our own to copy it from.",
    "Out of stock — no free no-claim account holds this whole bundle right now",
  ];
  for (const message of held) {
    ao.resetMemory();
    const w = copyWorld(8, { world: { publishResult: { success: false, message } } });
    await ao.runPass({ deps: w.deps, now: T0 });
    const rec = ao.copyRecord(w.set.note);
    assert.ok(rec && rec.market === "g2g" && rec.at === T0 && !rec.started, "held: " + message + " | " + w.set.note);
    assert.strictEqual(w.telegrams.length, 1, message);
  }
  for (const message of clean) {
    ao.resetMemory();
    const w = copyWorld(8, { world: { publishResult: { success: false, message } } });
    await ao.runPass({ deps: w.deps, now: T0 });
    assert.strictEqual(w.set.note, OWN_NOTE, "clean: " + message);
    assert.strictEqual(w.telegrams.length, 0, message);
  }
});

test("after a copy that may be live, no other copy is tried for six hours", async () => {
  autoFarm = { ...autoFarm, ...G2G_ON };
  const games = ["Alpha", "Beta"];
  const holdings = [];
  const sets = [];
  const gone = {};
  for (const g of games) {
    const items = [item(g + " Skin", g, g + " Launch")];
    gone[g + " Launch"] = T0 + 5 * DAY;
    holdings.push(...cohort(g.toLowerCase(), 7, items));
    sets.push({ name: g, note: OWN_NOTE, coverGame: g, items: asSet(items) });
  }
  const w = world({ holdings, gone, sets, g2gGames: games, publishResult: { success: false, message: "G2G publish offer failed (HTTP 502): Bad gateway" } });
  for (const s of w.sets) w.rows.push({ _id: oid(), marketplace: "eldorado", noclaimStock: true, status: "active", set: s._id, price: 0.99 });
  await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(w.published.length, 1);
  assert.strictEqual(w.telegrams.length, 1);
  const soon = await ao.runPass({ deps: w.deps, now: T0 + HOUR });
  assert.strictEqual(w.published.length, 1, "the other set waits too");
  assert.strictEqual(soon.skipped["copy: resting after a publish that may be live"], 1);
  // A restart forgets nothing: the record on the set carries its own time.
  ao.resetMemory();
  const restarted = await ao.runPass({ deps: w.deps, now: T0 + 2 * HOUR });
  assert.strictEqual(w.published.length, 1);
  assert.strictEqual(restarted.skipped["copy: resting after a publish that may be live"], 1);
  // Six hours on, the other set is tried (the held one never again).
  w.publishResult = null;
  ao.resetMemory();
  const later = await ao.runPass({ deps: w.deps, now: T0 + 6 * HOUR + 60 * 1000 });
  assert.strictEqual(later.copies.length, 1);
  assert.strictEqual(w.published.length, 2);
  assert.notStrictEqual(String(w.published[0].set._id), String(w.published[1].set._id));
  assert.strictEqual(later.skipped["copy: an earlier copy of this bundle may be live — left to the owner"], 1);
});

test("a publish that may be live counts toward the day's copies — the limit bounds attempts, not only successes", async () => {
  autoFarm = { ...autoFarm, ...G2G_ON, autofarmOfferCopiesPerDay: 1 };
  const games = ["Alpha", "Beta", "Gamma"];
  const holdings = [];
  const sets = [];
  const gone = {};
  for (const g of games) {
    const items = [item(g + " Skin", g, g + " Launch")];
    gone[g + " Launch"] = T0 + 5 * DAY;
    holdings.push(...cohort(g.toLowerCase(), 7, items));
    sets.push({ name: g, note: OWN_NOTE, coverGame: g, items: asSet(items) });
  }
  const w = world({ holdings, gone, sets, g2gGames: games, publishResult: { success: false, message: "G2G publish offer failed (HTTP 502): Bad gateway" } });
  for (const s of w.sets) w.rows.push({ _id: oid(), marketplace: "eldorado", noclaimStock: true, status: "active", set: s._id, price: 0.99 });
  // Three passes with a restart between each: one attempt, one page.
  for (let i = 0; i < 3; i++) {
    ao.resetMemory();
    await ao.runPass({ deps: w.deps, now: T0 + i * 10 * 60 * 1000 });
  }
  assert.strictEqual(w.published.length, 1);
  assert.strictEqual(w.telegrams.length, 1);
  // Past the six hours, still the same day: the day's one copy is spent.
  ao.resetMemory();
  const later = await ao.runPass({ deps: w.deps, now: T0 + 7 * HOUR });
  assert.strictEqual(w.published.length, 1);
  assert.strictEqual(later.skipped["copy: daily limit reached"], 1);
  // Tomorrow the next set is tried.
  ao.resetMemory();
  await ao.runPass({ deps: w.deps, now: T0 + DAY });
  assert.strictEqual(w.published.length, 2);
});

test("a hold is inherited: a set grown out of one whose copy may be live gets no copy of its own", async () => {
  autoFarm = { ...autoFarm, ...G2G_ON };
  const parent = { name: "parent", note: OWN_NOTE + " — HOLD: g2g copy 2026-10-09 10:00Z: G2G publish offer failed (HTTP 502): Bad gateway", coverGame: "Brawlhalla", items: asSet(BRAWL.slice(0, 2)) };
  const w = copyWorld(8, { note: "placeholder", sets: [parent] });
  w.set.note = "Made 2026-10-11 by the no-claim offer grow: the accounts behind set " + String(w.sets[1]._id) + " (2 Items) now also hold Brain Rotted Title.";
  const r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(r.copies.length, 0);
  assert.strictEqual(w.published.length, 0);
  assert.strictEqual(r.skipped["copy: an earlier copy of this bundle may be live — left to the owner"], 1);
  // An Eldorado-side hold on the parent says nothing about G2G.
  ao.resetMemory();
  const w2 = copyWorld(8, { note: "placeholder", sets: [{ ...parent, note: OWN_NOTE + " — HOLD: Eldorado publish failed (HTTP 502)" }] });
  w2.set.note = "Made 2026-10-11 by the no-claim offer grow: the accounts behind set " + String(w2.sets[1]._id) + " (2 Items) now also hold Brain Rotted Title.";
  assert.strictEqual((await ao.runPass({ deps: w2.deps, now: T0 })).copies.length, 1);
});

test("the sweep stops at the first take-down the market refuses, and takes at most two a pass", async () => {
  autoFarm = { ...autoFarm, ...G2G_ON };
  const mk = (o = {}) => {
    const w = world({ holdings: [], gone: {}, ...o });
    for (let i = 0; i < 5; i++) {
      w.rows.push({ _id: oid(), marketplace: "g2g", noclaimStock: true, status: "active", set: oid(), externalId: "left-" + i, note: "x" + ao.COPY_MARK });
    }
    return w;
  };
  // G2G is not answering: one call, not five 30-second waits.
  const bad = mk({ delistError: "G2G update offer failed: timeout of 30000ms exceeded" });
  let calls = 0;
  bad.deps.delistCopy = async () => {
    calls++;
    throw new Error("G2G update offer failed: timeout of 30000ms exceeded");
  };
  const r = await ao.runPass({ deps: bad.deps, now: T0 });
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(r.copiesDown, []);
  assert.ok(bad.rows.every((x) => x.status === "active"));
  // Answering: two a pass.
  const ok = mk();
  const r1 = await ao.runPass({ deps: ok.deps, now: T0 });
  assert.strictEqual(r1.copiesDown.length, 2);
  const r2 = await ao.runPass({ deps: ok.deps, now: T0 + 10 * 60 * 1000 });
  assert.strictEqual(r2.copiesDown.length, 2);
  assert.strictEqual(ok.rows.filter((x) => x.status === "delisted").length, 4);
});

test("the copy's record is on the set BEFORE the publish, and a set that changed meanwhile is not copied", async () => {
  autoFarm = { ...autoFarm, ...G2G_ON };
  let during = "";
  const w = copyWorld(8, { world: { onPublish: (ctx, world) => { during = world.sets[0].note; } } });
  await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(during, OWN_NOTE + " — HOLD: g2g copy 2026-10-11 08:00Z: publish started and never finished — check g2g for a stray offer");
  assert.strictEqual(w.set.note, OWN_NOTE, "and comes off once the publish has answered");

  // A process that dies mid-publish leaves the record: a restart copies nothing…
  ao.resetMemory();
  const dead = copyWorld(8);
  dead.set.note = during;
  const r = await ao.runPass({ deps: dead.deps, now: T0 + 60 * 1000 });
  assert.strictEqual(r.copies.length, 0);
  assert.strictEqual(dead.published.length, 0);
  assert.strictEqual(dead.telegrams.length, 0, "a publish can take a minute: nobody is paged yet");
  // …and once it has plainly not finished, the owner is told — once.
  ao.resetMemory();
  await ao.runPass({ deps: dead.deps, now: T0 + 11 * 60 * 1000 });
  assert.strictEqual(dead.telegrams.length, 1);
  assert.match(dead.telegrams[0], /a g2g publish of "Brawlhalla set" started at 2026-10-11 08:00Z and never finished/);
  assert.ok(dead.events.some((e) => e.action === "autofarm_copy_unfinished" && e.severity === "error"));
  assert.match(dead.set.note, / — HOLD: g2g copy 2026-10-11 08:00Z: publish never finished \(owner told\) — check g2g for a stray offer$/);
  ao.resetMemory();
  await ao.runPass({ deps: dead.deps, now: T0 + 30 * 60 * 1000 });
  await ao.runPass({ deps: dead.deps, now: T0 + 2 * DAY });
  assert.strictEqual(dead.telegrams.length, 1, "told once, whatever restarts in between");
  assert.strictEqual(dead.published.length, 0, "and the set is never copied by itself");

  // Two passes at once: the note the plan read is no longer the note on the set.
  ao.resetMemory();
  const race = copyWorld(8, { world: { onSetUpdate: (q, u, world) => { if (q.note !== undefined && !race.raced) { race.raced = true; world.sets[0].note = OWN_NOTE + " (touched)"; } } } });
  const rr = await ao.runPass({ deps: race.deps, now: T0 });
  assert.strictEqual(race.published.length, 0, "nothing reaches the market");
  assert.match(rr.errors[0], /the set changed while its copy was being prepared/);
  assert.strictEqual(race.telegrams.length, 0);

  // A clean failure takes the record off again.
  ao.resetMemory();
  const f = copyWorld(8, { world: { publishResult: { success: false, message: "G2G publish offer failed (HTTP 400): nope" } } });
  await ao.runPass({ deps: f.deps, now: T0 });
  assert.strictEqual(f.set.note, OWN_NOTE);
});

test("a held copy on a set with a very long note still leaves its record", async () => {
  autoFarm = { ...autoFarm, ...G2G_ON };
  const parent = { name: "parent", note: OWN_NOTE, coverGame: "Brawlhalla", items: asSet(BRAWL.slice(0, 2)) };
  const w = copyWorld(8, { note: "placeholder", sets: [parent], world: { publishResult: { success: false, message: "G2G publish offer failed (HTTP 502): Bad gateway" } } });
  w.set.note = "Made 2026-10-11 by the no-claim offer grow: the accounts behind set " + String(w.sets[1]._id) + " (" + "A + ".repeat(170) + "Z) now also hold Brain Rotted Title.";
  assert.ok(w.set.note.length > 700);
  await ao.runPass({ deps: w.deps, now: T0 });
  assert.ok(w.set.note.length <= 600);
  assert.ok(w.set.note.includes(" — HOLD: g2g copy 2026-10-11 08:00Z: G2G publish offer failed (HTTP 502)"));
  // …and it still reads as a set of this lister's family, held.
  ao.resetMemory();
  await ao.runPass({ deps: w.deps, now: T0 + 2 * DAY });
  assert.strictEqual(w.published.length, 1);
});

test("the sweep does not ask whether the lister is on — only its own switch stops it", async () => {
  autoFarm = { ...autoFarm, ...G2G_ON };
  const mk = async (af) => {
    autoFarm = { autofarmOffers: true, eldoradoAutoDeliver: true, eldoradoDeliverDryRun: false, noClaimGames: [], ...G2G_ON };
    ao.resetMemory();
    const w = copyWorld(8);
    await ao.runPass({ deps: w.deps, now: T0 });
    const copy = w.rows.find((x) => x.marketplace === "g2g");
    w.eld.set = oid(); // the Eldorado offer grew on to another set
    autoFarm = { ...autoFarm, ...af };
    const r = await ao.runPass({ deps: w.deps, now: T0 + HOUR });
    return { r, copy, w };
  };
  // The lister switched off.
  let x = await mk({ autofarmOffers: false });
  assert.strictEqual(x.r.off, true);
  assert.strictEqual(x.copy.status, "delisted");
  assert.strictEqual(x.r.copiesDown.length, 1);
  // Eldorado delivery in dry-run.
  x = await mk({ eldoradoDeliverDryRun: true });
  assert.strictEqual(x.copy.status, "delisted");
  // No-claim delivery off.
  autoFarm = { autofarmOffers: true, eldoradoAutoDeliver: true, eldoradoDeliverDryRun: false, noClaimGames: [], ...G2G_ON };
  ao.resetMemory();
  const w = copyWorld(8);
  await ao.runPass({ deps: w.deps, now: T0 });
  const copy = w.rows.find((r) => r.marketplace === "g2g");
  w.eld.set = oid();
  w.delivery = false;
  const off = await ao.runPass({ deps: w.deps, now: T0 + HOUR });
  assert.strictEqual(off.off, true);
  assert.strictEqual(copy.status, "delisted");
  // The sweep's own switch.
  x = await mk({ autofarmOfferCopySweep: false });
  assert.strictEqual(x.copy.status, "active");
  assert.deepStrictEqual(x.w.delisted, []);
  // A dry run takes nothing down.
  autoFarm = { autofarmOffers: true, eldoradoAutoDeliver: true, eldoradoDeliverDryRun: false, noClaimGames: [], ...G2G_ON };
  ao.resetMemory();
  const d = copyWorld(8);
  await ao.runPass({ deps: d.deps, now: T0 });
  d.eld.set = oid();
  await ao.runPass({ deps: d.deps, now: T0 + HOUR, dryRun: true });
  assert.deepStrictEqual(d.delisted, []);
});

test("a copy somebody else took down rests the game for two weeks; one the sweep took down does not", async () => {
  autoFarm = { ...autoFarm, ...G2G_ON };
  // The owner delisted the copy of an EARLIER Brawlhalla set by hand; the Eldorado offer has since grown on to this one.
  const old = { name: "old", note: OWN_NOTE, coverGame: "Brawlhalla", items: asSet(BRAWL.slice(0, 2)) };
  // A campaign that runs for weeks yet, and accounts with nothing left to earn.
  const w = copyWorld(8, { sets: [old], gone: { Brawlhalloween: T0 + 60 * DAY }, extra: { pendingAt: new Date(T0 - HOUR), pending: [] } });
  const gone = { _id: oid(), marketplace: "g2g", noclaimStock: true, status: "delisted", set: w.sets[1]._id, externalId: "g-old", note: "no-claim auto-delivery" + ao.COPY_MARK, updatedAt: new Date(T0 - 3 * DAY) };
  w.rows.push(gone);
  const r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(r.copies.length, 0);
  assert.strictEqual(r.skipped["copy: a copy of this game was taken down lately — left to the owner"], 1);
  // Ten days on (thirteen since the take-down): still the owner's call.
  ao.resetMemory();
  assert.strictEqual((await ao.runPass({ deps: w.deps, now: T0 + 10 * DAY })).copies.length, 0);
  // After the fortnight it is this lister's again.
  ao.resetMemory();
  const later = await ao.runPass({ deps: w.deps, now: T0 + 12 * DAY });
  assert.strictEqual(later.copies.length, 1, JSON.stringify(later.skipped));
  // A copy whose set is gone still names its game in its title.
  ao.resetMemory();
  const w2 = copyWorld(8);
  w2.rows.push({ _id: oid(), marketplace: "g2g", noclaimStock: true, status: "delisted", set: oid(), externalId: "g-x", title: "Brawlhalla Twitch Drops (2 Items)", note: "x" + ao.COPY_MARK, updatedAt: new Date(T0 - DAY) });
  assert.strictEqual((await ao.runPass({ deps: w2.deps, now: T0 })).copies.length, 0);
});

test("…and the sweep's own take-down never rests a game", async () => {
  autoFarm = { ...autoFarm, ...G2G_ON };
  const old = { name: "old", note: OWN_NOTE, coverGame: "Brawlhalla", items: asSet(BRAWL.slice(0, 2)) };
  const w = copyWorld(8, { sets: [old] });
  w.rows.push({ _id: oid(), marketplace: "g2g", noclaimStock: true, status: "delisted", set: w.sets[1]._id, externalId: "g-old", note: "no-claim auto-delivery" + ao.COPY_MARK + " — taken down 2026-10-10 09:00Z" + ao.SWEPT_MARK, updatedAt: new Date(T0 - DAY) });
  // A row that is not a copy at all (the owner's own G2G listing, delisted) says nothing either.
  w.rows.push({ _id: oid(), marketplace: "g2g", noclaimStock: true, status: "delisted", set: w.sets[1]._id, externalId: "g-own", note: "mine", updatedAt: new Date(T0 - DAY) });
  const r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(r.copies.length, 1);
});

// ---------------------------------------------------------------------------
// Rule 8, the other kind — Gameflip HOLDS the account when the listing is made
// ---------------------------------------------------------------------------

const GF_ON = { autofarmOfferCopyMarkets: ["gameflip"] };
const gfWorld = (n = 10, o = {}) => copyWorld(n, { ...o, world: { vault: true, ...(o.world || {}) } });

test("a finished bundle gets a Gameflip chain: a few units, one account held at a time, its own price floor and a photo", async () => {
  autoFarm = { ...autoFarm, ...GF_ON };
  const w = gfWorld(10, { world: { enginePrice: 1.4 } });
  const r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.copies.length, 1);
  const p = w.published[0];
  assert.strictEqual(p.market, "gameflip");
  assert.strictEqual(String(p.set._id), String(w.set._id));
  assert.deepStrictEqual(p.body, { gameflip: { qty: 2 } }, "one live listing, one queued — not the whole shelf");
  assert.deepStrictEqual(p.cat, {});
  assert.strictEqual(p.gridImage, "/tmp/cover.png", "Gameflip refuses a listing without a photo");
  assert.deepStrictEqual(w.unlinked, ["/tmp/cover.png"]);
  assert.ok(p.title.length <= 120);
  // $0.99 on Eldorado: never more than 1.2x that; Gameflip's own floor is $0.75, not G2G's dollar.
  assert.strictEqual(p.priceUsd, 1.09);
  const pc = { priceFactor: 0.85, minPrice: 0.75, maxPrice: 1.49, copyPriceFactor: 1.2 };
  assert.strictEqual(ao.copyPrice(1.13, 0.75, "gameflip", pc), 0.89);
  assert.strictEqual(ao.copyPrice(1.13, 0.75, "g2g", pc), 1);
  assert.strictEqual(r.copies[0].quantity, 2);
  assert.strictEqual(w.set.note, OWN_NOTE);
  const row = w.rows.find((x) => x.marketplace === "gameflip");
  assert.ok(row.note.endsWith(ao.COPY_MARK));
  assert.ok(w.telegrams.some((t) => /ALSO LISTED on GAMEFLIP[^]*2 unit\(s\), one account held at a time/.test(t)));
  // While that chain is on sale the set gets no second one.
  const again = await ao.runPass({ deps: w.deps, now: T0 + HOUR });
  assert.strictEqual(again.copies.length, 0);
  assert.strictEqual(w.published.length, 1);
});

test("no Gameflip chain unless every condition holds", async () => {
  const run = async (o = {}, af = {}) => {
    autoFarm = { autofarmOffers: true, eldoradoAutoDeliver: true, eldoradoDeliverDryRun: false, noClaimGames: ["overwatch"], ...GF_ON, ...af };
    ao.resetMemory();
    const w = gfWorld(o.n || 10, o);
    const r = await ao.runPass({ deps: w.deps, now: T0 });
    return { w, r, n: w.published.filter((p) => p.market === "gameflip").length };
  };
  assert.strictEqual((await run()).n, 1, "the base case lists");
  // The stock side's own switch: without it no account may be held at all.
  let x = await run({ world: { vault: false } });
  assert.strictEqual(x.n, 0);
  assert.strictEqual(x.r.skipped["copy: holding accounts for this market is switched off"], 1);
  // Fewer accounts than it takes to spare some for a second market.
  x = await run({ n: 7 });
  assert.strictEqual(x.n, 0);
  assert.strictEqual(x.r.skipped["copy: too few accounts for a second market"], 1);
  assert.strictEqual((await run({ n: 7 }, { autofarmOfferVaultMinHolders: 7 })).n, 1);
  // Drops that leave inside the vault's minimum life (72 h, and a margin): nobody could be held.
  x = await run({ gone: { Brawlhalloween: T0 + 3 * DAY } });
  assert.strictEqual(x.n, 0);
  // No leave date on record at all.
  x = await run({ gone: {}, extra: { pendingAt: new Date(T0 - HOUR), pending: [] } });
  assert.strictEqual(x.n, 0);
  assert.strictEqual(x.r.skipped["copy: no leave date on record for its drops"], 1);
  // Still earning.
  x = await run({ gone: { Brawlhalloween: T0 + 12 * DAY }, extra: { pendingAt: new Date(T0 - HOUR), pending: [{ game: "Brawlhalla", n: 1 }] } });
  assert.strictEqual(x.n, 0);
  assert.strictEqual(x.r.skipped["copy: its accounts are still earning"], 1);
  // The owner's game; a set this lister did not make; a paused Eldorado offer.
  assert.strictEqual((await run({}, { noClaimGames: ["brawlhalla"] })).n, 0);
  assert.strictEqual((await run({ note: "my own bundle" })).n, 0);
  assert.strictEqual((await run({ eld: { autoPaused: true } })).n, 0);
  // G2G's switches say nothing about Gameflip.
  assert.strictEqual((await run({}, { g2gAutoDeliver: false })).n, 1);
});

test("a set gets a new Gameflip chain only after the last one SOLD — never while one is on sale, never after one came down unsold", async () => {
  autoFarm = { ...autoFarm, ...GF_ON };
  const withRows = async (rows) => {
    ao.resetMemory();
    const w = gfWorld(10);
    for (const r of rows) w.rows.push({ _id: oid(), marketplace: "gameflip", noclaimStock: true, set: w.set._id, externalId: "gf-" + oid().slice(-4), note: "no-claim auto-delivery — x", ...r });
    await ao.runPass({ deps: w.deps, now: T0 });
    return w.published.length;
  };
  const old = (d) => new Date(T0 - d * DAY);
  // On sale now.
  assert.strictEqual(await withRows([{ status: "active", createdAt: old(1) }]), 0);
  // The chain sold through (two units, both sold): demand — another chain.
  assert.strictEqual(await withRows([{ status: "sold", createdAt: old(3) }, { status: "sold", createdAt: old(2) }]), 1);
  // A sold unit, and its successor still on sale.
  assert.strictEqual(await withRows([{ status: "sold", createdAt: old(3) }, { status: "active", createdAt: old(2) }]), 0);
  // The last listing came down unsold (its drops were about to leave): not asked twice.
  assert.strictEqual(await withRows([{ status: "sold", createdAt: old(3) }, { status: "delisted", lastError: "drops leave within 24 h", createdAt: old(2) }]), 0);
  assert.strictEqual(await withRows([{ status: "removed", createdAt: old(2) }]), 0);
  // Sold, with its relist still to come — the chain is not over: the relist
  // lane says it failed and will retry (a backoff)…
  assert.strictEqual(
    await withRows([{ status: "sold", qtyRemaining: 1, lastError: "auto-relist failed: Gameflip create: Too many attempts - Retry later", createdAt: old(1), updatedAt: old(0.5) }]),
    0,
  );
  // …or it sold minutes ago and the relist may be inside its publish right now.
  assert.strictEqual(await withRows([{ status: "sold", qtyRemaining: 1, createdAt: old(1), updatedAt: new Date(T0 - 5 * 60 * 1000) }]), 0);
  // A sold unit KEEPS its qtyRemaining after its relist went through (the debt
  // moved to the new row; the number is never cleared). Read as "relist
  // pending", the first unit of every chain of two blocked the set for good —
  // no set ever got a second chain. Both units sold: that is demand.
  assert.strictEqual(
    await withRows([
      { status: "sold", qtyRemaining: 1, lastError: "", createdAt: old(3), updatedAt: old(2.5) },
      { status: "sold", qtyRemaining: 0, lastError: "", createdAt: old(2), updatedAt: old(1) },
    ]),
    1,
  );
  // The same first unit while its successor is still on sale: not yet.
  assert.strictEqual(
    await withRows([
      { status: "sold", qtyRemaining: 1, lastError: "", createdAt: old(3), updatedAt: old(2.5) },
      { status: "active", qtyRemaining: 0, createdAt: old(2), updatedAt: old(2) },
    ]),
    0,
  );
  // Its own relist lane stopped the chain (an account kept held, a listing live without a row):
  // something of it may still be out there — never another by itself.
  assert.strictEqual(await withRows([{ status: "sold", qtyRemaining: 0, lastError: "auto-relist stopped: x [account kept held]", createdAt: old(1) }]), 0);
});

test("a Gameflip listing somebody else took down rests the game; one the system took down does not", async () => {
  autoFarm = { ...autoFarm, ...GF_ON };
  const other = { name: "old", note: OWN_NOTE, coverGame: "Brawlhalla", items: asSet(BRAWL.slice(0, 2)) };
  const mk = async (lastError) => {
    ao.resetMemory();
    const w = gfWorld(10, { sets: [other] });
    w.rows.push({ _id: oid(), marketplace: "gameflip", noclaimStock: true, status: "delisted", set: w.sets[1]._id, externalId: "gf-old", note: "no-claim auto-delivery — x", lastError, updatedAt: new Date(T0 - 2 * DAY), createdAt: new Date(T0 - 4 * DAY) });
    const r = await ao.runPass({ deps: w.deps, now: T0 });
    return { n: w.published.length, r };
  };
  // The owner's Delist button leaves no reason on the row.
  const owner = await mk("");
  assert.strictEqual(owner.n, 0);
  assert.strictEqual(owner.r.skipped["copy: a copy of this game was taken down lately — left to the owner"], 1);
  // Every automatic take-down says why.
  assert.strictEqual((await mk("drops leave within 24 h")).n, 1);
  assert.strictEqual((await mk("drops expired")).n, 1);
});

test("a failed Gameflip chain: held accounts and live-without-a-row hold the set; anything else rests an hour", async () => {
  autoFarm = { ...autoFarm, ...GF_ON };
  // Gameflip's own lane kept the account held and paged the owner itself: recorded, not paged twice.
  let w = gfWorld(10, { world: { publishResult: { success: false, message: "Gameflip created 4f1b-aaaa but could not put it on sale (draft discarded): x [account kept held]" } } });
  await ao.runPass({ deps: w.deps, now: T0 });
  let rec = ao.copyRecord(w.set.note);
  assert.ok(rec && rec.market === "gameflip" && !rec.started, w.set.note);
  assert.strictEqual(w.telegrams.length, 0, "Gameflip's lane told the owner already");
  assert.deepStrictEqual(w.unlinked, ["/tmp/cover.png"], "the cover is cleaned up whatever happened");
  ao.resetMemory();
  await ao.runPass({ deps: w.deps, now: T0 + 2 * DAY });
  assert.strictEqual(w.published.length, 1, "never again by itself");

  // Live on Gameflip, no row: the words every such failure uses.
  ao.resetMemory();
  w = gfWorld(10, { world: { publishResult: { success: false, message: "published on Gameflip but the row could not be saved — delist it by hand: gf-9 (E11000)" } } });
  await ao.runPass({ deps: w.deps, now: T0 });
  rec = ao.copyRecord(w.set.note);
  assert.ok(rec && rec.market === "gameflip");
  assert.strictEqual(w.telegrams.length, 1);
  assert.match(w.telegrams[0], /went live but was not recorded/);

  // Nothing could be held, or Gameflip refused before anything existed: clean.
  for (const message of ["Out of stock — no free no-claim account holds this whole bundle", "Gameflip create: Too many attempts - Retry later", "Gameflip created 4f1b-bbbb but could not put it on sale (draft discarded): x"]) {
    ao.resetMemory();
    w = gfWorld(10, { world: { publishResult: { success: false, message } } });
    const r = await ao.runPass({ deps: w.deps, now: T0 });
    assert.strictEqual(w.set.note, OWN_NOTE, message);
    assert.strictEqual(w.telegrams.length, 0);
    assert.strictEqual(r.errors.length, 1);
    await ao.runPass({ deps: w.deps, now: T0 + 30 * 60 * 1000 });
    assert.strictEqual(w.published.length, 1, "rests an hour: " + message);
  }

  // No photo: nothing is asked of Gameflip, and the set is not even marked.
  ao.resetMemory();
  w = gfWorld(10, { world: { cover: "" } });
  const r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(w.published.length, 0);
  assert.match(r.errors[0], /no cover image could be built/);
  assert.strictEqual(w.set.note, OWN_NOTE);
});

test("the sweep leaves Gameflip alone — a held unit shares nobody's shelf", async () => {
  autoFarm = { ...autoFarm, ...GF_ON };
  const w = gfWorld(10);
  await ao.runPass({ deps: w.deps, now: T0 });
  const chain = w.rows.find((x) => x.marketplace === "gameflip");
  // The Eldorado offer grows on to another set.
  w.eld.set = oid();
  const r = await ao.runPass({ deps: w.deps, now: T0 + HOUR });
  assert.deepStrictEqual(r.copiesDown, []);
  assert.deepStrictEqual(w.delisted, []);
  assert.strictEqual(chain.status, "active");
});

test("both kinds together: one a pass, the day's limit shared", async () => {
  autoFarm = { ...autoFarm, ...G2G_ON, autofarmOfferCopyMarkets: ["g2g", "gameflip"], autofarmOfferCopiesPerDay: 2 };
  const w = gfWorld(10);
  const a = await ao.runPass({ deps: w.deps, now: T0 });
  const b = await ao.runPass({ deps: w.deps, now: T0 + 10 * 60 * 1000 });
  const c = await ao.runPass({ deps: w.deps, now: T0 + 20 * 60 * 1000 });
  assert.deepStrictEqual([a.copies.length, b.copies.length, c.copies.length], [1, 1, 0]);
  assert.deepStrictEqual(w.published.map((p) => p.market).sort(), ["g2g", "gameflip"]);
  // The G2G copy advertises what is free; the Gameflip chain its two units.
  assert.deepStrictEqual(w.published.find((p) => p.market === "g2g").body, { g2g: { qty: 10 } });
  assert.deepStrictEqual(w.published.find((p) => p.market === "gameflip").body, { gameflip: { qty: 2 } });
});
