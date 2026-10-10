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
//   - a bundle that ever had an offer is never listed twice;
//   - a failed publish leaves no set behind and rests an hour;
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
  autoFarm = { autofarmOffers: true, noClaimGames: ["overwatch", "rainbow six"] };
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
  const base = {
    holdings: w.holdings,
    expiry: { on: true, claimWindowMs: 7 * DAY, sellLeadMs: 24 * HOUR, bundleLeadMs: 36 * HOUR },
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
      // An item whose campaign's copies are gone by `at` is dropped.
      durableItems: (h, b, at) => {
        w.reads.durableAt.push(at);
        return h.items.filter((it) => {
          const g = it.campaign in w.gone ? w.gone[it.campaign] : Infinity;
          return g > at;
        });
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
    },
    MarketplaceListing: {
      find: (q) =>
        chain(
          w.rows.filter((r) => {
            if (q.marketplace && r.marketplace !== q.marketplace) return false;
            if (q.noclaimStock !== undefined && r.noclaimStock !== q.noclaimStock) return false;
            if (q.status && r.status !== q.status) return false;
            if (q.set && q.set.$in && !q.set.$in.map(String).includes(String(r.set))) return false;
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
  };
  return w;
}

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
  // The buyer is told the drops are unclaimed and when they leave: a day
  // before the copies really go.
  assert.match(pub.description, /^House description for Brawlhalla\./);
  assert.match(pub.description, /claim before 2026-10-15\./);
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
  // No deadline is promised for a campaign that has not ended… the copies'
  // leave date is still told when it is known.
  assert.match(w.published[0].description, /claim before /);
});

test("an item with no campaign on record is never called finished: it waits the quiet hours", async () => {
  const plain = [item("Mystery", "Predecessor", ""), item("Box", "Predecessor", "")];
  const w = world({ holdings: cohort("p", 6, plain) });
  let r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(r.created.length, 0);
  r = await ao.runPass({ deps: w.deps, now: T0 + 6 * HOUR });
  assert.strictEqual(r.created.length, 1);
  assert.doesNotMatch(w.published[0].description, /claim before/, "no date is invented");
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

test("accounts part-way to a bundle that is on sale wait for it; once the campaign is over, what they stopped at is listed", async () => {
  const full = BRAWL.map(({ itemKey, name, game, qty }) => ({ itemKey, name, game, qty }));
  const mk = (gone) => {
    const w = world({
      // 10 accounts hold the whole bundle (on the shelf), 8 newer ones hold
      // its first two drops.
      holdings: cohort("old", 10, BRAWL).concat(cohort("new", 8, BRAWL.slice(0, 2))),
      gone,
      sets: [{ coverGame: "Brawlhalla", items: full }],
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
  assert.strictEqual(r.skipped["still earning toward a bundle that is on sale"], 1);
  assert.strictEqual(running.published.length, 0);

  // The campaign is over: they will never hold more, so it is a bundle of its own.
  const over = mk(ENDED);
  r = await ao.runPass({ deps: over.deps, now: T0 });
  assert.strictEqual(r.created.length, 1);
  assert.strictEqual(over.published[0].set.items.length, 2);
  assert.strictEqual(over.published[0].body.eldorado.quantity, 8);
});

test("an offer that went live without a row is never retried within the day, and the owner is told", async () => {
  const w = world({
    holdings: cohort("b", 8, BRAWL),
    gone: ENDED,
    publishResult: { success: false, message: "published on Eldorado but the row could not be saved — delist it by hand: abc-123" },
  });
  let r = await ao.runPass({ deps: w.deps, now: T0 });
  assert.strictEqual(r.errors.length, 1);
  assert.strictEqual(w.telegrams.length, 1);
  assert.match(w.telegrams[0], /delist it by hand: abc-123/);
  // Two hours later an ordinary failure would be retried; this one is not.
  w.publishResult = null;
  r = await ao.runPass({ deps: w.deps, now: T0 + 2 * HOUR });
  assert.strictEqual(w.published.length, 1);
  assert.strictEqual(r.skipped["waiting after a failed publish"], 1);
  r = await ao.runPass({ deps: w.deps, now: T0 + 25 * HOUR });
  assert.strictEqual(w.published.length, 2);
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

test("an identical set no offer was made on is reused, and never deleted when the publish fails", async () => {
  const mk = (publishResult) => {
    const w = world({
      holdings: cohort("b", 8, BRAWL),
      gone: ENDED,
      publishResult,
      sets: [{ coverGame: "Brawlhalla", items: BRAWL.map(({ itemKey, name, game, qty }) => ({ itemKey, name, game, qty })), note: "made for PlayerAuctions" }],
    });
    // Its only offer is on another market.
    w.rows.push({ _id: oid(), marketplace: "playerauctions", noclaimStock: true, status: "active", set: w.sets[0]._id });
    return w;
  };
  const ok = mk(null);
  let r = await ao.runPass({ deps: ok.deps, now: T0 });
  assert.strictEqual(r.created.length, 1);
  assert.strictEqual(ok.sets.length, 1, "the existing set is used: both markets share one shelf");
  assert.strictEqual(String(ok.published[0].set._id), String(ok.sets[0]._id));

  const bad = mk({ success: false, message: "Eldorado said no" });
  r = await ao.runPass({ deps: bad.deps, now: T0 });
  assert.strictEqual(r.created.length, 0);
  assert.deepStrictEqual(r.errors, ["Brawlhalla: Eldorado said no"]);
  assert.strictEqual(bad.sets.length, 1, "a set this pass did not make is not deleted");
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
