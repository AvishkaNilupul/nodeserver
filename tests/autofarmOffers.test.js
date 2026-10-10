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
        const row = { _id: oid(), marketplace: market, noclaimStock: true, status: "active", set: ctx.set._id };
        w.rows.push(row);
        return { success: true, id: String(row._id), externalId: "ext-" + w.published.length, url: "https://eldorado/x" };
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
        const doc = w.sets.find((s) => String(s._id) === String(q._id));
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
            return true;
          }),
        ),
    },
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
