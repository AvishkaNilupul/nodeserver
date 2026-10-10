// No-claim stock that knows when a wave expires
// (docs/NOCLAIM-OFFER-ROTATION-CONTRACT.md, "Expiry").
//
// The case it exists for, measured on prod 2026-10-10: Eldorado offer c847f2c2
// sold "OL' CLANKER + 14× Esports Pack 26 Stage 2.1". Wave 12 ("R6S S2 2026
// 12") had ended 2026-10-03 04:58Z, and its three packs left EVERY account
// seven days later, at 04:58Z on the 10th. The holdings snapshot still listed
// 14 packs on each row until that row was read again, so the offer stayed on
// sale for 3 h 55 min with nothing behind it. A buyer paid (order 588d88a3),
// no account held the bundle, and the order was disputed.
//
// No Mongo, no network: models, settings and the engine are stubbed at require
// time through Module._load, the way tests/noclaimHoldings.test.js does it.
process.env.CRED_SECRET ||= "test-secret";
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");
const path = require("path");
const realSettings = require("../utils/settings");

const ROOT = path.join(__dirname, "..");
const HOLDINGS_PATH = path.join(ROOT, "utils", "noclaimHoldings.js");
const STOCK_PATH = path.join(ROOT, "utils", "noclaimStock.js");
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const G = "Rainbow Six Siege";
const PACK = "esports pack 26 stage 2.1|rainbow six siege";
const OLC = "ol' clanker|rainbow six siege";

let stubs = new Map();
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (parent && parent.filename && request.startsWith(".")) {
    const abs = path.resolve(path.dirname(parent.filename), request).replace(/\.js$/, "");
    if (stubs.has(abs)) return stubs.get(abs);
  }
  return origLoad.apply(this, arguments);
};
test.after(() => {
  Module._load = origLoad;
});

/* ------------------------------ fake Mongo ------------------------------- */

const ms = (v) => (v == null ? null : v instanceof Date ? v.getTime() : new Date(v).getTime());

function field(doc, key) {
  if (!key.includes(".")) return [doc[key]];
  const [head, ...rest] = key.split(".");
  const v = doc[head];
  if (Array.isArray(v)) return v.flatMap((x) => (x == null ? [] : field(x, rest.join("."))));
  return v == null ? [undefined] : field(v, rest.join("."));
}

function matches(doc, q) {
  for (const [k, cond] of Object.entries(q || {})) {
    if (k === "$or") {
      if (!cond.some((c) => matches(doc, c))) return false;
      continue;
    }
    if (k === "$expr") {
      const [a, b] = cond.$lt.map((p) => ms(doc[String(p).slice(1)]));
      // BSON order: null sorts before every date.
      if (!((a == null ? -Infinity : a) < (b == null ? -Infinity : b))) return false;
      continue;
    }
    const vals = field(doc, k);
    const ok = vals.some((v) => {
      if (cond && typeof cond === "object" && !Array.isArray(cond) && !(cond instanceof Date)) {
        if (cond.$in && !cond.$in.some((x) => (x instanceof RegExp ? x.test(String(v)) : String(x) === String(v)))) return false;
        if (cond.$nin && cond.$nin.map(String).includes(String(v))) return false;
        if ("$ne" in cond && (v == null ? null : v) === cond.$ne) return false;
        if (cond.$not && cond.$not.test(String(v == null ? "" : v))) return false;
        if (cond.$lte != null && !(v != null && ms(v) <= ms(cond.$lte))) return false;
        if (cond.$lt != null && !(v != null && ms(v) < ms(cond.$lt))) return false;
        return true;
      }
      if (cond === null) return v == null;
      return v === cond;
    });
    if (!ok) return false;
  }
  return true;
}

// A model whose writes APPLY, so a flag set by one call is seen by the next.
function liveModel(rows = []) {
  const calls = { updateMany: [], updateOne: [], find: [] };
  const chain = (list) => {
    const p = Promise.resolve(list);
    p.lean = () => Promise.resolve(list.map((r) => ({ ...r })));
    p.sort = () => p;
    p.limit = () => p;
    return p;
  };
  return {
    rows,
    calls,
    find(q) {
      calls.find.push(q);
      return chain(rows.filter((r) => matches(r, q)));
    },
    findOne(q) {
      const hit = rows.find((r) => matches(r, q)) || null;
      return { lean: async () => (hit ? { ...hit } : null) };
    },
    findById(id) {
      const hit = rows.find((r) => String(r._id) === String(id)) || null;
      return { lean: async () => (hit ? { ...hit } : null) };
    },
    async countDocuments(q) {
      return rows.filter((r) => matches(r, q)).length;
    },
    async bulkWrite() {
      return { ok: 1 };
    },
    async updateMany(q, u) {
      calls.updateMany.push({ q, u });
      let n = 0;
      for (const r of rows) {
        if (!matches(r, q)) continue;
        Object.assign(r, u.$set || {});
        n++;
      }
      return { modifiedCount: n };
    },
    async updateOne(q, u) {
      calls.updateOne.push({ q, u });
      const r = rows.find((x) => matches(x, q));
      if (!r) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(r, u.$set || {});
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
}

/* -------------------------------- loading -------------------------------- */

const pid = (n) => String(n).padStart(24, "0");

function poolRow(n) {
  return {
    _id: pid(n),
    clientSecret: "secret-" + n,
    status: "claimed",
    manualSold: false,
    listed: false,
    soldGames: [],
    claimedNote: "",
    password: "enc:pw-" + n,
  };
}

// Both modules for real, over fake models. `af` is the autoFarm settings block
// (the expiry switches live there); `inventory` answers live reads by login.
function load({
  holdings = [],
  campaigns = [],
  ledgers = [],
  listings = [],
  sets = [],
  cands = null,
  inventory = {},
  af = {},
  shop = {},
} = {}) {
  const Holding = liveModel(holdings);
  const Pool = liveModel(
    [...new Set(holdings.map((h) => h.poolAccountId).filter(Boolean))].map((id) => ({
      ...poolRow(Number(id)),
      _id: id,
    })),
  );
  const Ledger = liveModel(ledgers);
  const Campaign = liveModel(campaigns);
  const Listing = liveModel(listings);
  const DropSet = liveModel(sets);
  const reads = [];
  const events = [];
  const engine = {
    poolPassword: (row) => (row && row.password ? "pw" : ""),
    credentialForLedger: async (r) => ({ login: r.login, password: "pw-" + r.login }),
    activeListingsForLogin: async () => [],
    collectNoClaimCandidates: async () =>
      (cands || holdings.map((h) => ({ login: h.login, clientSecret: "secret-" + Number(h.poolAccountId), game: G, botId: "17" }))).map((c) => ({ ...c })),
    async inventoryForCandidate(cand) {
      reads.push(String(cand.login).toLowerCase());
      const r = inventory[String(cand.login).toLowerCase()];
      if (r instanceof Error) throw r;
      return r || { inv: {}, sellable: [], login: cand.login };
    },
  };
  const settingsStub = {
    normGameName: realSettings.normGameName,
    getNoclaimShopSettings: () => ({
      enabled: true,
      autoDeliver: true,
      sweep: true,
      sweepPerTick: 30,
      sweepEveryMin: 10,
      maxAgeHours: 8,
      refreshBudget: 120,
      ...shop,
    }),
    getAutoFarm: () => ({ ...af }),
  };
  stubs = new Map([
    [path.join(ROOT, "models", "NoclaimHolding"), Holding],
    [path.join(ROOT, "models", "AvailableAccount"), Pool],
    [path.join(ROOT, "models", "UnclaimedAccount"), Ledger],
    [path.join(ROOT, "models", "TwitchCampaign"), Campaign],
    [path.join(ROOT, "models", "MarketplaceListing"), Listing],
    [path.join(ROOT, "models", "DropSet"), DropSet],
    [path.join(ROOT, "utils", "listedLogins"), { loginsOnActiveListings: async () => new Set() }],
    [path.join(ROOT, "utils", "settings"), settingsStub],
    [path.join(ROOT, "utils", "unclaimedAutoList"), engine],
    [path.join(ROOT, "utils", "systemLog"), { logEvent: (f) => events.push(f) }],
    [path.join(ROOT, "utils", "suppliedStock"), { shareOfShelf: (n, id, ids) => (ids.length > 1 ? Math.floor(n / ids.length) : n) }],
  ]);
  delete require.cache[HOLDINGS_PATH];
  delete require.cache[STOCK_PATH];
  const h = require("../utils/noclaimHoldings");
  // The stock layer reaches the holdings lazily; hand it THIS instance.
  stubs.set(path.join(ROOT, "utils", "noclaimHoldings"), h);
  const s = require("../utils/noclaimStock");
  delete require.cache[HOLDINGS_PATH];
  delete require.cache[STOCK_PATH];
  return { h, s, Holding, Campaign, Listing, DropSet, Ledger, reads, events };
}

async function quiet(fn) {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
}

/* -------------------------------- fixtures ------------------------------- */

const wave = (n) => "R6S S2 2026 " + n;
const WASTE = "R6S Wasteland circuit";

// Wave ends relative to `now`, so each is `goneIn` away from leaving the
// accounts (7 days after it ended). Prod's shape on 2026-10-10: three packs
// from wave 12, three from 13, four each from 14 and 15.
function r6Campaigns(now, goneIn = {}) {
  const end = (inMs) => new Date(now + inMs - 7 * DAY);
  return [
    { name: wave(12), game: G, endAt: end(goneIn.w12 ?? -MIN) },
    { name: wave(13), game: G, endAt: end(goneIn.w13 ?? 2 * DAY) },
    { name: wave(14), game: G, endAt: end(goneIn.w14 ?? 4 * DAY) },
    { name: wave(15), game: G, endAt: end(goneIn.w15 ?? 7 * DAY) },
    { name: WASTE, game: G, endAt: end(goneIn.waste ?? 10 * DAY) },
  ];
}

const packs14 = () => ({
  itemKey: PACK,
  name: "Esports Pack 26 Stage 2.1",
  game: G,
  campaign: wave(12),
  image: "",
  qty: 14,
  waves: [
    { campaign: wave(12), qty: 3 },
    { campaign: wave(13), qty: 3 },
    { campaign: wave(14), qty: 4 },
    { campaign: wave(15), qty: 4 },
  ],
});
const clanker = () => ({
  itemKey: OLC,
  name: "OL' CLANKER",
  game: G,
  campaign: WASTE,
  image: "",
  qty: 1,
  waves: [{ campaign: WASTE, qty: 1 }],
});

let seq = 0;
function account(now, { readAgo = 2 * HOUR, items = [packs14(), clanker()], ...over } = {}) {
  seq++;
  return {
    loginLower: "acct" + seq,
    login: "acct" + seq,
    poolAccountId: pid(seq),
    inConfig: true,
    game: G,
    items,
    readAt: new Date(now - readAgo),
    readError: "",
    recheckAt: null,
    ...over,
  };
}

const setOf = (id, packs) => ({
  _id: id,
  stockSource: "noclaim",
  coverGame: G,
  items: [
    { itemKey: OLC, name: "OL' CLANKER", game: G, qty: 1 },
    { itemKey: PACK, name: "Esports Pack 26 Stage 2.1", game: G, qty: packs },
  ],
});

// One copy per entry with its campaign — what a live inventory read returns.
function liveCopies(perWave, withClanker = true) {
  const out = [];
  for (const [campaign, n] of Object.entries(perWave)) {
    for (let i = 0; i < n; i++) {
      out.push({ name: "Esports Pack 26 Stage 2.1", game: G, campaign, itemKey: PACK });
    }
  }
  if (withClanker) out.push({ name: "OL' CLANKER", game: G, campaign: WASTE, itemKey: OLC });
  return out;
}

/* ============================ the pure rules ============================= */

test("foldSellable keeps each copy's campaign, and folding a folded list changes nothing", () => {
  const { h } = load();
  const once = h.foldSellable(liveCopies({ [wave(12)]: 3, [wave(13)]: 3, [wave(14)]: 4, [wave(15)]: 4 }));
  const packs = once.find((i) => i.itemKey === PACK);
  assert.strictEqual(packs.qty, 14);
  assert.deepStrictEqual(packs.waves, packs14().waves);
  assert.strictEqual(packs.campaign, wave(12), "the first-seen campaign label is unchanged");
  assert.deepStrictEqual(h.foldSellable(once), once);
});

test("foldSellable: a row from before waves were kept is copies of UNKNOWN origin, not of its first campaign", () => {
  const { h } = load();
  const [it] = h.foldSellable([{ itemKey: PACK, name: "Pack", game: G, campaign: wave(12), qty: 14 }]);
  assert.deepStrictEqual(it.waves, [{ campaign: "", qty: 14 }]);
  // ...and a waves list that does not add up leaves the rest unknown too.
  const [short] = h.foldSellable([{ itemKey: PACK, game: G, qty: 5, waves: [{ campaign: wave(13), qty: 3 }] }]);
  assert.deepStrictEqual(short.waves, [
    { campaign: wave(13), qty: 3 },
    { campaign: "", qty: 2 },
  ]);
});

test("waveGoneAt: the campaign's end plus the claim window; anything unknown never expires on paper", () => {
  const { h } = load();
  const now = Date.now();
  const base = {
    expiry: { on: true, claimWindowMs: 7 * DAY },
    campaignEnds: h.campaignEndIndex([
      { name: wave(12), game: G, endAt: new Date(now - 7 * DAY - MIN) },
      { name: wave(13), game: G, endAt: new Date(now - 5 * DAY) },
      { name: "No End Date", game: G, endAt: null },
      { name: "Shared Name", game: "Overwatch", endAt: new Date(now - 30 * DAY) },
    ]),
  };
  const read = now - 2 * HOUR;
  assert.strictEqual(h.waveGoneAt(base, G, wave(12), read), now - MIN);
  assert.strictEqual(h.waveGoneAt(base, G, wave(13).toUpperCase(), read), now + 2 * DAY, "names match case-free");
  assert.strictEqual(h.waveGoneAt(base, G, "Never Heard Of", read), Infinity);
  assert.strictEqual(h.waveGoneAt(base, G, "No End Date", read), Infinity);
  assert.strictEqual(h.waveGoneAt(base, G, "", read), Infinity);
  assert.strictEqual(h.waveGoneAt(base, G, "Shared Name", read), Infinity, "another game's campaign of the same name");
  assert.strictEqual(h.waveGoneAt({ ...base, expiry: { on: false } }, G, wave(12), read), Infinity, "switched off");
});

test("waveGoneAt: a copy seen alive long after its campaign should have taken it is not that campaign's", () => {
  const { h } = load();
  const now = Date.now();
  const gone = now - 2 * DAY;
  const base = {
    expiry: { on: true, claimWindowMs: 7 * DAY },
    campaignEnds: h.campaignEndIndex([{ name: "Summer Rerun", game: G, endAt: new Date(gone - 7 * DAY) }]),
  };
  // Read a few hours after: Twitch clearing up slowly. Still believed gone.
  assert.strictEqual(h.waveGoneAt(base, G, "Summer Rerun", gone + 5 * HOUR), gone);
  // Read a day and a half after and still there: unknown expiry.
  assert.strictEqual(h.waveGoneAt(base, G, "Summer Rerun", gone + 36 * HOUR), Infinity);
  // A name Twitch re-used: the old run is refuted, the current one decides.
  base.campaignEnds = h.campaignEndIndex([
    { name: "Summer Rerun", game: G, endAt: new Date(now - 300 * DAY) },
    { name: "Summer Rerun", game: G, endAt: new Date(now - DAY) },
  ]);
  assert.strictEqual(h.waveGoneAt(base, G, "Summer Rerun", now - HOUR), now + 6 * DAY);
});

test("durableItems: 14 packs are 11 once wave 12 has gone — without reading the account again", () => {
  const { h } = load();
  const now = Date.now();
  const base = { expiry: { on: true, claimWindowMs: 7 * DAY }, campaignEnds: h.campaignEndIndex(r6Campaigns(now)) };
  const row = account(now);
  const at = (t) => new Map(h.durableItems(row, base, t).map((i) => [i.itemKey, i.qty]));
  assert.strictEqual(at(now - 2 * MIN).get(PACK), 14, "two minutes before the wave went");
  assert.strictEqual(at(now).get(PACK), 11);
  assert.strictEqual(at(now + DAY).get(PACK), 11);
  assert.strictEqual(at(now + 2 * DAY + MIN).get(PACK), 8, "wave 13 goes two days on");
  assert.strictEqual(at(now + 8 * DAY).get(PACK), undefined, "an item with nothing left is dropped");
  assert.strictEqual(at(now + 8 * DAY).get(OLC), 1);
  assert.strictEqual(row.items[0].qty, 14, "the holding itself is never changed");
  // What is left is labelled by its longest-lived copies, so "is this item
  // part of a current event?" is asked of what will actually be sold.
  assert.strictEqual(h.durableItems(row, base, now).find((i) => i.itemKey === PACK).campaign, wave(15));
});

test("durableItems: an old row with no waves counts whole, and the switch turns the rule off", () => {
  const { h } = load();
  const now = Date.now();
  const ends = h.campaignEndIndex(r6Campaigns(now));
  const legacy = account(now, { items: [{ itemKey: PACK, name: "Pack", game: G, campaign: wave(12), qty: 14 }] });
  assert.strictEqual(h.durableItems(legacy, { expiry: { on: true, claimWindowMs: 7 * DAY }, campaignEnds: ends }, now)[0].qty, 14);
  const row = account(now);
  assert.strictEqual(h.durableItems(row, { expiry: { on: false }, campaignEnds: ends }, now), row.items);
  assert.strictEqual(h.durableItems(row, {}, now), row.items, "a base without the rules");
});

test("isFresh: a row flagged for a re-read is not stock until a read lands after the flag", () => {
  const { h } = load();
  const now = Date.now();
  const base = { maxAgeMs: 8 * HOUR };
  const row = { readAt: new Date(now - HOUR), recheckAt: null };
  assert.strictEqual(h.isFresh(row, base, now), true);
  row.recheckAt = new Date(now - 30 * MIN);
  assert.strictEqual(h.needsRecheck(row), true);
  assert.strictEqual(h.isFresh(row, base, now), false);
  row.readAt = new Date(row.recheckAt);
  assert.strictEqual(h.needsRecheck(row), false, "a read at the flag's own moment answers it");
  row.readAt = new Date(now - MIN);
  assert.strictEqual(h.needsRecheck(row), false);
  assert.strictEqual(h.isFresh(row, base, now), true);
  assert.strictEqual(h.needsRecheck({ readAt: null, recheckAt: new Date(now) }), true, "never read");
});

test("unpredictedLosses: an expiry on schedule is not a loss; copies gone for no known reason are", () => {
  const { h } = load();
  const now = Date.now();
  const base = { expiry: { on: true, claimWindowMs: 7 * DAY }, campaignEnds: h.campaignEndIndex(r6Campaigns(now)) };
  const before = account(now);
  const fold = (perWave, withClanker) => h.foldSellable(liveCopies(perWave, withClanker));
  // Wave 12 went a minute ago and the read shows exactly that.
  assert.deepStrictEqual(h.unpredictedLosses(before, fold({ [wave(13)]: 3, [wave(14)]: 4, [wave(15)]: 4 }), base, now), []);
  // More than before is never a loss.
  assert.deepStrictEqual(h.unpredictedLosses(before, fold({ [wave(13)]: 3, [wave(14)]: 4, [wave(15)]: 4, [wave(16)]: 2 }), base, now), []);
  // Wave 14 gone four days early, and the charm with it.
  const lost = h.unpredictedLosses(before, fold({ [wave(13)]: 3, [wave(15)]: 4 }, false), base, now);
  assert.deepStrictEqual(
    lost.map((l) => [l.itemKey, l.had, l.has]),
    [
      [PACK, 11, 7],
      [OLC, 1, 0],
    ],
  );
});

test("expirySettings: seven days and a one-day lead by default; the lead never drops under an hour", () => {
  const a = load().h;
  assert.deepStrictEqual(a.expirySettings(), {
    on: true,
    claimWindowMs: 7 * DAY,
    sellLeadMs: 24 * HOUR,
    bundleLeadMs: 36 * HOUR,
  });
  assert.strictEqual(a.advertiseLeadMs("eldorado"), 24 * HOUR);
  assert.strictEqual(a.advertiseLeadMs("playerauctions"), HOUR, "no rotation behind it: the safety hour only");
  assert.strictEqual(a.advertiseLeadMs("g2g"), HOUR);

  const b = load({ af: { noclaimSellLeadHours: "6", noclaimClaimWindowHours: 48 } }).h;
  assert.strictEqual(b.expirySettings().sellLeadMs, 6 * HOUR);
  assert.strictEqual(b.expirySettings().bundleLeadMs, 18 * HOUR);
  assert.strictEqual(b.expirySettings().claimWindowMs, 48 * HOUR);

  const c = load({ af: { noclaimSellLeadHours: 0, noclaimClaimWindowHours: "junk" } }).h;
  assert.strictEqual(c.expirySettings().sellLeadMs, HOUR, "a typed 0 is not 'sell to the last second'");
  assert.strictEqual(c.expirySettings().claimWindowMs, 7 * DAY);

  const off = load({ af: { noclaimExpiryAware: false } }).h;
  assert.strictEqual(off.expirySettings().on, false);
  assert.strictEqual(off.advertiseLeadMs("eldorado"), 0);
});

/* ===================== the incident, through the stock ==================== */

test("REGRESSION 2026-10-10: rows read before the wave went no longer count as 14-pack stock", async () => {
  const now = Date.now();
  const holdings = [account(now), account(now), account(now)];
  const { s } = load({ holdings, campaigns: r6Campaigns(now) });
  // The offer's bundle: nothing holds it any more, though every row says 14.
  const dead = await s.stockForSet(setOf("s14", 14));
  assert.strictEqual(dead.free, 0);
  assert.strictEqual(dead.stale, 0);
  assert.strictEqual(dead.covering, 0);
  assert.deepStrictEqual(await s.freeCandidates(setOf("s14", 14)), [], "a claim does not even spend a live read on them");
  // What they really hold is still stock.
  assert.strictEqual((await s.stockForSet(setOf("s11", 11))).free, 3);
});

test("a campaign Twitch names with a stray blank or another case still dates its copies", async () => {
  const now = Date.now();
  // Prod, 2026-10-10: the campaign row is "Ironmouse Drops Rerun! " (it ends in
  // a space); the copy's label is stored trimmed. An exact-name lookup found
  // nothing and the copy's expiry read as unknown.
  const campaigns = r6Campaigns(now).map((c) => (c.name === wave(12) ? { ...c, name: " r6s S2 2026 12  " } : c));
  const { s } = load({ holdings: [account(now), account(now), account(now)], campaigns });
  assert.strictEqual((await s.stockForSet(setOf("s14", 14))).free, 0, "wave 12 is known to have gone");
  assert.strictEqual((await s.stockForSet(setOf("s11", 11))).free, 3);
  // A name that only LOOKS like a pattern is matched literally.
  const odd = load({
    holdings: [account(now, { items: [{ itemKey: PACK, name: "Pack", game: G, qty: 2, waves: [{ campaign: "Drop (v2.0)+", qty: 2 }] }] })],
    campaigns: [
      { name: "Drop (v2.0)+", game: G, endAt: new Date(now - 8 * DAY) },
      { name: "Drop v2x0", game: G, endAt: new Date(now + DAY) },
    ],
  });
  const base = await odd.h.snapshotBase();
  assert.deepStrictEqual([...base.campaignEnds.keys()], ["drop (v2.0)+"]);
});

test("the same rows with the switch off are counted the old way — the four-hour hole", async () => {
  const now = Date.now();
  const holdings = [account(now), account(now), account(now)];
  const { s } = load({ holdings, campaigns: r6Campaigns(now), af: { noclaimExpiryAware: false } });
  assert.strictEqual((await s.stockForSet(setOf("s14", 14))).free, 3);
});

test("an offer stops being advertised a day before a wave goes, not hours after", async () => {
  const now = Date.now();
  // Wave 12 leaves in 20 hours: inside the one-day lead.
  const campaigns = r6Campaigns(now, { w12: 20 * HOUR });
  const holdings = [account(now), account(now), account(now)];
  // (PlayerAuctions sells the same bundle from a set of its own: two offers on
  // ONE set would share its shelf.)
  const sets = [setOf("s14", 14), setOf("s11", 11), setOf("s14pa", 14)];
  const row = (id, marketplace, set) => ({ _id: id, marketplace, noclaimStock: true, status: "active", set });
  const listings = [row("eld14", "eldorado", "s14"), row("eld11", "eldorado", "s11"), row("pa14", "playerauctions", "s14pa")];
  const { s } = load({ holdings, campaigns, sets, listings });

  assert.strictEqual((await s.stockForSet(setOf("s14", 14))).free, 3, "they do hold it right now");
  assert.strictEqual((await s.stockForSet(setOf("s14", 14), { leadMs: 24 * HOUR })).free, 0);
  assert.strictEqual(await s.stockForListing(listings[0]), 0, "Eldorado: off sale while there is still a day to claim");
  assert.strictEqual(await s.stockForListing(listings[1]), 3, "the 11 packs that last are advertised");
  assert.strictEqual(await s.stockForListing(listings[2]), 3, "PlayerAuctions keeps selling to the last hour");

  // A paid order that slips in before the pause is still filled: a claim asks
  // what the accounts hold NOW, and they hold all fourteen.
  assert.strictEqual((await s.freeCandidates(setOf("s14", 14))).length, 3);
});

test("inside the last hour every claim-at-sale market is off sale", async () => {
  const now = Date.now();
  const campaigns = r6Campaigns(now, { w12: 40 * MIN });
  const holdings = [account(now), account(now), account(now)];
  const listings = [{ _id: "pa14", marketplace: "playerauctions", noclaimStock: true, status: "active", set: "s14" }];
  const { s } = load({ holdings, campaigns, sets: [setOf("s14", 14)], listings });
  assert.strictEqual(await s.stockForListing(listings[0]), 0);
});

test("copies a late read still shows are believed gone for six hours, then counted as unknown", async () => {
  const now = Date.now();
  // Wave 12 "went" 30 hours ago. Two rows were read 2 h ago and STILL list its
  // copies: the seven-day rule did not hold for it, so they count. A third was
  // read an hour after it went: inside the grace, not believed.
  const campaigns = r6Campaigns(now, { w12: -30 * HOUR });
  const holdings = [account(now), account(now), account(now, { readAgo: 29 * HOUR })];
  const { s } = load({ holdings, campaigns, shop: { maxAgeHours: 72 } });
  assert.strictEqual((await s.stockForSet(setOf("s14", 14))).free, 2);
});

test("a claim left short says why: read and found short, or never read at all", async () => {
  const now = Date.now();
  const campaigns = r6Campaigns(now, { w12: 3 * DAY });
  const order = { market: "eldorado", mode: "sold", listingId: "L1", orderId: "o-1", dryRun: true };

  // The snapshot says 14 on three accounts; Twitch says 11 on each.
  let holdings = [account(now), account(now), account(now)];
  let inventory = {};
  for (const hd of holdings) {
    inventory[hd.loginLower] = { sellable: liveCopies({ [wave(13)]: 3, [wave(14)]: 4, [wave(15)]: 4 }), login: hd.login };
  }
  let env = load({ holdings, campaigns, inventory });
  let out = await quiet(() => env.s.claimForSet(setOf("s14", 14), 1, order));
  assert.strictEqual(out.length, 0);
  assert.deepStrictEqual(out.missed, { "short of the set": 3 });
  assert.deepStrictEqual(Object.keys(out), [], "still just the list of claimed accounts");
  assert.strictEqual(env.Holding.rows[0].items[0].qty, 11, "each read corrected its row");

  // The scan host is down: nothing was learned about any account.
  holdings = [account(now), account(now)];
  inventory = {};
  for (const hd of holdings) inventory[hd.loginLower] = new Error("scan host: contabo unreachable");
  env = load({ holdings, campaigns, inventory });
  out = await quiet(() => env.s.claimForSet(setOf("s14", 14), 1, order));
  assert.deepStrictEqual(out.missed, { "live read failed": 2 });
  assert.strictEqual(env.Holding.rows[0].items[0].qty, 14, "a failed read never wipes what a row holds");

  // And an account that does hold it is simply claimed.
  holdings = [account(now)];
  inventory = {
    [holdings[0].loginLower]: {
      sellable: liveCopies({ [wave(12)]: 3, [wave(13)]: 3, [wave(14)]: 4, [wave(15)]: 4 }),
      login: holdings[0].login,
    },
  };
  env = load({ holdings, campaigns, inventory });
  out = await quiet(() => env.s.claimForSet(setOf("s14", 14), 1, order));
  assert.deepStrictEqual(out.map((a) => a.login), [holdings[0].login]);
  assert.deepStrictEqual(out.missed, {});
});

/* ============================ forced re-reads ============================ */

test("flagRecheck takes the holders out of stock, and the sweep reads them first", async () => {
  const now = Date.now();
  const campaigns = r6Campaigns(now, { w12: 3 * DAY });
  // Three fresh holders, one row read too long ago to matter either way.
  const holdings = [
    account(now, { readAgo: 10 * MIN }),
    account(now, { readAgo: 20 * MIN }),
    account(now, { readAgo: 30 * MIN }),
    account(now, { readAgo: 7 * HOUR, items: [clanker()] }),
  ];
  const inventory = {};
  for (const hd of holdings.slice(0, 3)) {
    inventory[hd.loginLower] = { sellable: liveCopies({ [wave(13)]: 3, [wave(14)]: 4, [wave(15)]: 4 }), login: hd.login };
  }
  const { h, s, Holding, reads, events } = load({ holdings, campaigns, inventory, shop: { sweepPerTick: 2 } });
  assert.strictEqual((await s.stockForSet(setOf("s14", 14))).free, 3);

  const r = await quiet(() => h.flagRecheck({ itemKeys: [PACK], reason: "order x found no account" }));
  assert.strictEqual(r.flagged, 3, "only holders of the item");
  assert.strictEqual(holdings[3].recheckAt, null);
  assert.strictEqual(await h.pendingRecheck(), 3);
  const flaggedStock = await s.stockForSet(setOf("s14", 14));
  assert.strictEqual(flaggedStock.free, 0, "not advertised until re-read");
  assert.strictEqual(flaggedStock.stale, 3, "but still on a paid order's shortlist");
  assert.strictEqual(events[0].action, "recheck_flagged");

  // A normal tick (budget 2): the flagged rows go first although they were
  // read minutes ago; the old row waits.
  await quiet(() => h.sweepOnce({ budget: 2, reason: "tick" }));
  assert.deepStrictEqual([...reads].sort(), [holdings[1].loginLower, holdings[2].loginLower].sort(), "oldest flagged first");
  assert.strictEqual(await h.pendingRecheck(), 1);

  // The drain's pass reads nothing but flagged rows.
  reads.length = 0;
  await quiet(() => h.sweepOnce({ budget: 50, reason: "recheck", recheckOnly: true }));
  assert.deepStrictEqual(reads, [holdings[0].loginLower]);
  assert.strictEqual(await h.pendingRecheck(), 0);
  assert.strictEqual(Holding.rows[0].items[0].qty, 11, "the truth is in the snapshot now");
  assert.strictEqual((await s.stockForSet(setOf("s11", 11))).free, 3);
});

test("a row stored before waves were kept is re-read at once, however fresh", async () => {
  const now = Date.now();
  const legacy = account(now, {
    readAgo: 5 * MIN,
    items: [{ itemKey: PACK, name: "Esports Pack 26 Stage 2.1", game: G, campaign: wave(12), qty: 14 }],
  });
  const modern = account(now, { readAgo: 5 * MIN });
  const inventory = {
    [legacy.loginLower]: { sellable: liveCopies({ [wave(12)]: 3, [wave(13)]: 3, [wave(14)]: 4, [wave(15)]: 4 }, false), login: legacy.login },
  };
  const { h, reads, Holding } = load({ holdings: [legacy, modern], campaigns: r6Campaigns(now, { w12: 3 * DAY }), inventory });
  await quiet(() => h.sweepOnce({ budget: 30 }));
  assert.deepStrictEqual(reads, [legacy.loginLower]);
  assert.deepStrictEqual(Holding.rows[0].items[0].waves, packs14().waves);

  // With the rules off nothing needs waves, and a fresh row is left alone.
  const off = load({ holdings: [account(now, { readAgo: 5 * MIN, items: legacy.items })], af: { noclaimExpiryAware: false } });
  await quiet(() => off.h.sweepOnce({ budget: 30 }));
  assert.deepStrictEqual(off.reads, []);
});

test("three free accounts losing copies no campaign explains flags every other holder", async () => {
  const now = Date.now();
  // Nothing is due to expire for days...
  const campaigns = r6Campaigns(now, { w12: 3 * DAY });
  const old = () => account(now, { readAgo: 5 * HOUR });
  const holdings = [old(), old(), old(), account(now, { readAgo: 30 * MIN }), account(now, { readAgo: 40 * MIN })];
  // ...yet the three rows due a read come back three packs short.
  const inventory = {};
  for (const hd of holdings.slice(0, 3)) {
    inventory[hd.loginLower] = { sellable: liveCopies({ [wave(13)]: 3, [wave(14)]: 4, [wave(15)]: 4 }), login: hd.login };
  }
  const { h, s, events } = load({ holdings, campaigns, inventory });
  assert.strictEqual((await s.stockForSet(setOf("s14", 14))).free, 5, "all five are trusted: read within 8 hours");

  await quiet(() => h.sweepOnce({ budget: 30 }));
  assert.strictEqual(events.filter((e) => e.action === "recheck_flagged").length, 1);
  assert.match(events[0].detail, /3 free accounts lost copies of Esports Pack 26 Stage 2\.1/);
  assert.ok(holdings[3].recheckAt && holdings[4].recheckAt, "the holders not yet re-read are flagged");
  assert.strictEqual((await s.stockForSet(setOf("s14", 14))).free, 0, "and no longer advertised");
  for (const hd of holdings.slice(0, 3)) assert.strictEqual(h.needsRecheck(hd), false, "the ones just read are the truth");
});

test("two accounts are not enough, a predicted expiry is not a loss, and a sold account's loss is its buyer claiming", async () => {
  const now = Date.now();
  const short = (hd) => ({ sellable: liveCopies({ [wave(13)]: 3, [wave(14)]: 4, [wave(15)]: 4 }), login: hd.login });
  const old = () => account(now, { readAgo: 5 * HOUR });

  // 1. Only two accounts short.
  let holdings = [old(), old(), account(now, { readAgo: 30 * MIN })];
  let env = load({
    holdings,
    campaigns: r6Campaigns(now, { w12: 3 * DAY }),
    inventory: { [holdings[0].loginLower]: short(holdings[0]), [holdings[1].loginLower]: short(holdings[1]) },
  });
  await quiet(() => env.h.sweepOnce({ budget: 30 }));
  assert.strictEqual(env.events.length, 0);
  assert.strictEqual(holdings[2].recheckAt, null);

  // 2. Three accounts short of exactly the wave that went a minute ago.
  holdings = [old(), old(), old(), account(now, { readAgo: 30 * MIN })];
  let inventory = {};
  for (const hd of holdings.slice(0, 3)) inventory[hd.loginLower] = short(hd);
  env = load({ holdings, campaigns: r6Campaigns(now), inventory });
  await quiet(() => env.h.sweepOnce({ budget: 30 }));
  assert.strictEqual(env.events.length, 0, "the expiry rules already knew");

  // 3. Three accounts short, but each is committed to a buyer.
  holdings = [old(), old(), old(), account(now, { readAgo: 30 * MIN })];
  inventory = {};
  for (const hd of holdings.slice(0, 3)) inventory[hd.loginLower] = short(hd);
  env = load({
    holdings,
    campaigns: r6Campaigns(now, { w12: 3 * DAY }),
    inventory,
    ledgers: holdings.slice(0, 3).map((hd) => ({ source: "noclaim", loginLower: hd.loginLower, status: "sold" })),
  });
  await quiet(() => env.h.sweepOnce({ budget: 30 }));
  assert.strictEqual(env.events.length, 0);
});

test("a forced re-read never empties a row: Twitch's empty answer waits for the regular sweep", async () => {
  const now = Date.now();
  const campaigns = r6Campaigns(now, { w12: 3 * DAY });
  const holdings = [account(now, { readAgo: 20 * MIN }), account(now, { readAgo: 30 * MIN })];
  // Twitch answers "nothing" for the first account, the truth for the second.
  const inventory = {
    [holdings[0].loginLower]: { sellable: [], login: holdings[0].login },
    [holdings[1].loginLower]: {
      sellable: liveCopies({ [wave(12)]: 3, [wave(13)]: 3, [wave(14)]: 4, [wave(15)]: 4 }),
      login: holdings[1].login,
    },
  };
  const { h, s, Holding, reads, events } = load({ holdings, campaigns, inventory });
  await quiet(() => h.flagRecheck({ itemKeys: [PACK], reason: "an order found no account" }));

  const r = await quiet(() => h.sweepOnce({ budget: 50, recheckOnly: true }));
  assert.deepStrictEqual([r.read, r.failed], [1, 1]);
  assert.strictEqual(Holding.rows[0].items[0].qty, 14, "not emptied on a forced read");
  assert.match(Holding.rows[0].readError, /^empty inventory on a forced re-read/);
  assert.strictEqual(h.needsRecheck(Holding.rows[0]), true, "and still not stock");
  assert.strictEqual((await s.stockForSet(setOf("s14", 14))).free, 1, "the account that answered is back");
  assert.strictEqual(await h.pendingRecheck(), 0, "nothing left for the drain");

  // The drain does not ask it again...
  reads.length = 0;
  await quiet(() => h.sweepOnce({ budget: 50, recheckOnly: true }));
  assert.deepStrictEqual(reads, []);
  // ...the regular sweep does, first in line, and is believed either way.
  inventory[holdings[0].loginLower] = { sellable: liveCopies({ [wave(13)]: 3, [wave(14)]: 4, [wave(15)]: 4 }), login: holdings[0].login };
  await quiet(() => h.sweepOnce({ budget: 1 }));
  assert.deepStrictEqual(reads, [holdings[0].loginLower]);
  assert.strictEqual(Holding.rows[0].items[0].qty, 11);
  assert.strictEqual(Holding.rows[0].readError, "");
  assert.strictEqual(h.needsRecheck(Holding.rows[0]), false);
  assert.strictEqual(events.filter((e) => e.action === "recheck_flagged").length, 1, "one account's loss is not an expiry");
});

test("accounts read as holding nothing at all are not evidence of an expiry", async () => {
  const now = Date.now();
  const old = () => account(now, { readAgo: 5 * HOUR });
  const holdings = [old(), old(), old(), account(now, { readAgo: 30 * MIN })];
  const inventory = {};
  for (const hd of holdings.slice(0, 3)) inventory[hd.loginLower] = { sellable: [], login: hd.login };
  const { h, events } = load({ holdings, campaigns: r6Campaigns(now, { w12: 3 * DAY }), inventory });
  await quiet(() => h.sweepOnce({ budget: 30 }));
  assert.strictEqual(events.length, 0);
  assert.strictEqual(holdings[3].recheckAt, null, "the other holder stays in stock");
});

test("flagRecheck with nothing to flag, or a database error, changes nothing and never throws", async () => {
  const now = Date.now();
  const { h, Holding, events } = load({ holdings: [account(now)], campaigns: r6Campaigns(now) });
  assert.deepStrictEqual(await h.flagRecheck({ itemKeys: [] }), { flagged: 0 });
  assert.deepStrictEqual(await quiet(() => h.flagRecheck({ itemKeys: ["no such item|game"] })), { flagged: 0 });
  Holding.updateMany = async () => {
    throw new Error("atlas hiccup");
  };
  const r = await quiet(() => h.flagRecheck({ itemKeys: [PACK] }));
  assert.strictEqual(r.flagged, 0);
  assert.match(r.error, /atlas hiccup/);
  assert.strictEqual(events.length, 0);
});

/* ====================== the offer follows the rules ====================== */

const rot = require("../utils/noclaimOfferRotation");
const grow = require("../utils/noclaimOfferGrow");

// The rotation's and the grow's injected dependencies, over REAL expiry rules
// (`h`): a base as snapshotBase builds it, and a stock counter that records
// how far ahead it was asked to count.
function offerDeps({ h, now, holdings, campaigns, row, set, stock, af = {} }) {
  const calls = [];
  const base = {
    holdings,
    maxAgeMs: 8 * HOUR,
    expiry: h.expirySettings(),
    campaignEnds: h.campaignEndIndex(campaigns),
  };
  const rows = new Map([[String(row._id), { ...row }]]);
  const sets = new Map([[String(set._id), set]]);
  const offer = {
    offerState: row.autoPaused ? "Paused" : "Active",
    offerTitle: "old title",
    pricePerUnit: { amount: row.price, currency: "USD" },
    quantity: 15,
  };
  let made = 0;
  const d = {
    settings: { getAutoFarm: () => af },
    MarketplaceListing: {
      find: () => ({ lean: async () => [...rows.values()] }),
      findById: (id) => ({ lean: async () => ({ ...rows.get(String(id)) }) }),
      updateOne: async (q, u) => {
        const r = rows.get(String(q._id));
        if (!r) return { modifiedCount: 0 };
        Object.assign(r, u.$set);
        return { modifiedCount: 1 };
      },
    },
    DropSet: {
      findById: (id) => ({ lean: async () => sets.get(String(id)) || null }),
      find: () => {
        const q = { sort: () => q, limit: () => q, lean: async () => [] };
        return q;
      },
      create: async (doc) => {
        const s = { _id: "newset" + ++made, ...doc };
        sets.set(String(s._id), s);
        return s;
      },
      deleteOne: async () => ({}),
    },
    TwitchCampaign: {
      find: () => ({
        lean: async () => campaigns.map((c) => ({ ...c, status: c.endAt > new Date(now) ? "ACTIVE" : "EXPIRED", active: c.endAt > new Date(now) })),
      }),
    },
    ncs: {
      stockForSet: async (s, opts) => {
        calls.push(["stockForSet", String(s._id || "candidate"), opts]);
        return stock(s, opts);
      },
      stockForListing: async () => 40,
      requiredDropsForSet: (s) => s.items.map((i) => ({ name: i.name, qty: i.qty })),
    },
    nh: {
      snapshotBase: async () => base,
      freeReason: () => "",
      isFresh: () => true,
      expirySettings: h.expirySettings,
      durableHoldings: h.durableHoldings,
    },
    mp: {
      eldoradoOffer: async () => ({ ...offer }),
      eldoradoUpdateOffer: async (ext, patch) => {
        calls.push(["update", patch.title]);
        offer.offerTitle = patch.title;
        return { ...offer };
      },
      eldoradoUploadImage: async () => ({ largeImage: "cover.png" }),
      eldoradoRelist: async () => {
        calls.push(["relist"]);
        offer.offerState = "Active";
      },
      eldoradoSetQuantity: async (ext, q) => calls.push(["quantity", q]),
      eldoradoPaidOrders: async () => [],
    },
    text: async (s) => ({ title: "Rainbow Six Siege — " + rot.bundleLabel(s.items), description: "x" }),
    buildCover: async () => "/tmp/cover.png",
    unlink: () => {},
    logEvent: () => {},
    sendTelegram: async () => {},
  };
  return { d, calls, rows, sets };
}

const forty = (now, over) => Array.from({ length: 40 }, () => account(now, over));
const packsOf = (items) => (items.find((i) => i.itemKey === PACK) || {}).qty;

test("rotation: an offer paused a day ahead moves to the packs that LAST, and is asked about a day ahead", async () => {
  const now = Date.now();
  const { h } = load();
  // Wave 12 leaves in 20 hours. The stock sync has paused the 14-pack offer.
  const campaigns = r6Campaigns(now, { w12: 20 * HOUR });
  const row = {
    _id: "row1",
    marketplace: "eldorado",
    externalId: "c847f2c2",
    noclaimStock: true,
    status: "active",
    autoPaused: true,
    lastError: rot.PAUSED_ERROR,
    set: "s14",
    price: 1.81,
    updatedAt: new Date(now - 40 * MIN),
    units: [{ login: "x", deliveredAt: new Date(now - 20 * HOUR) }],
  };
  const f = offerDeps({
    h,
    now,
    holdings: forty(now),
    campaigns,
    row,
    set: setOf("s14", 14),
    // Counted a day ahead nothing holds 14; counted today everything does.
    stock: (s, opts) => (opts && opts.leadMs >= 24 * HOUR ? { free: 0, stale: 0 } : { free: 40, stale: 0 }),
  });
  const out = await rot.rotationPass({ deps: f.d, now });
  assert.strictEqual(out.rotated.length, 1, JSON.stringify(out.skipped.concat(out.errors)));
  assert.deepStrictEqual(f.calls[0], ["stockForSet", "s14", { leadMs: 24 * HOUR }]);
  const to = f.sets.get(String(f.rows.get("row1").set));
  assert.strictEqual(packsOf(to.items), 11, "not the 14 that are three short tomorrow");
  assert.strictEqual(f.rows.get("row1").autoPaused, false, "and it is back on sale");
});

test("rotation with the rules off asks about today and builds from everything held (the old behaviour)", async () => {
  const now = Date.now();
  const { h } = load({ af: { noclaimExpiryAware: false } });
  const row = {
    _id: "row1",
    marketplace: "eldorado",
    externalId: "c847f2c2",
    noclaimStock: true,
    status: "active",
    autoPaused: true,
    lastError: rot.PAUSED_ERROR,
    set: "s9",
    price: 1.81,
    updatedAt: new Date(now - 40 * MIN),
    units: [{ login: "x", deliveredAt: new Date(now - 20 * HOUR) }],
  };
  const f = offerDeps({
    h,
    now,
    // (The item is judged "current" by its stored first-seen label here, as it
    // was before the rules: give it a running wave's.)
    holdings: forty(now, { items: [{ ...packs14(), campaign: WASTE }, clanker()] }),
    campaigns: r6Campaigns(now, { w12: 20 * HOUR }),
    row,
    set: setOf("s9", 9),
    stock: () => ({ free: 0, stale: 0 }),
  });
  const out = await rot.rotationPass({ deps: f.d, now });
  assert.deepStrictEqual(f.calls[0], ["stockForSet", "s9", { leadMs: 0 }]);
  assert.strictEqual(packsOf(f.sets.get(String(f.rows.get("row1").set)).items), 14, JSON.stringify(out.skipped));
});

test("grow: packs that leave tomorrow do not make an offer bigger — the 2026-10-09 mistake", async () => {
  const now = Date.now();
  const { h } = load();
  const row = {
    _id: "row1",
    marketplace: "eldorado",
    externalId: "c847f2c2",
    noclaimStock: true,
    status: "active",
    autoPaused: false,
    set: "s11",
    price: 1.81,
    note: "",
    units: [],
  };
  const run = async (campaigns) => {
    const f = offerDeps({ h, now, holdings: forty(now), campaigns, row, set: setOf("s11", 11), stock: () => ({ free: 40 }) });
    const out = await grow.growPass({ deps: f.d, now, dryRun: true });
    return { out, f };
  };
  // Wave 12 goes in 18 hours: the accounts show 14, but only 11 will last.
  const soon = await run(r6Campaigns(now, { w12: 18 * HOUR }));
  assert.deepStrictEqual(soon.out.plan, [], "nothing more to sell");

  // The same accounts with every wave days from expiring: 14 is real.
  const later = await run(r6Campaigns(now, { w12: 3 * DAY, w13: 5 * DAY, w14: 6 * DAY }));
  assert.strictEqual(later.out.plan.length, 1, JSON.stringify(later.out.skipped));
  assert.match(later.out.plan[0].added, /14× Esports Pack 26 Stage 2\.1 \(was 11×\)/);
  const asked = later.f.calls.find((c) => c[0] === "stockForSet");
  assert.deepStrictEqual(asked[2], { leadMs: 24 * HOUR }, "the bigger bundle must be advertisable, not merely held");
});
