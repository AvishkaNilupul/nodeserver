// The listing brain's planted-truth fixture generator (scripts/listing-brain-fixture.js; docs/LISTING-BRAIN-PLAN.md
// §2.1 for the bundle, §11 for why): deterministic per seed, the plan's bundle shape, nothing identifying, the
// large-mode volume, and every planted truth of PLANTED really present in the data — so a model test that fails on
// this fixture fails because of the model, not because the truth was never planted.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const F = require("../scripts/listing-brain-fixture");
const { VENUES } = require("../utils/priceTracker/venues");
const { sizeBand } = require("../utils/priceTracker/setIdentity");

const DAY = 86400000;
const HOUR = 3600000;
const MIN = 60000;
const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "listing-brain-fixture.js");
const SMALL_FILE = path.join(__dirname, "fixtures", "listingBrain", "small.json");
const MARKETS = ["gameflip", "digiseller", "ggsel", "zeusx", "eldorado", "playerauctions", "g2g"];
const P = F.PLANTED;

const small = F.generate();
const t0 = process.hrtime.bigint();
const large = F.generate({ large: true });
const largeMs = Number(process.hrtime.bigint() - t0) / 1e6;

/* ---------------------------------------------------------------- helpers */

const rowsOf = (b, g, m) => b.listings.filter((L) => L.g === g && (!m || L.m === m));
const salesOf = (b, g, m) => b.sales.filter((s) => s.g === g && (!m || s.m === m));
const demandOf = (b, k) => b.demand.find((d) => d.k === k);
const median = (a) => {
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const firstSaleByLid = (b) => {
  const m = new Map();
  for (const s of b.sales) if (s.lid && (!m.has(s.lid) || s.t < m.get(s.lid))) m.set(s.lid, s.t);
  return m;
};
// Priced orders of one market by content key, as plan §4.1 counts them: p in (0, 25], not hand/shop, one per order,
// inside the 180-day reference window, never a rent-farm row's.
function ordersByCk(b, m) {
  const farmIds = new Set(b.listings.filter((L) => L.kind === "farm").map((L) => L.id));
  const seen = new Set();
  const out = new Map();
  for (const s of b.sales) {
    if (s.m !== m || !(s.p > 0) || s.p > 25 || s.src === "hand" || s.src === "shop" || farmIds.has(s.lid)) continue;
    if (s.t < b.now - 180 * DAY || s.t >= b.now || seen.has(s.grp) || !s.ck) continue;
    seen.add(s.grp);
    if (!out.has(s.ck)) out.set(s.ck, []);
    out.get(s.ck).push(s.p);
  }
  return out;
}

// The plan's sell-through estimate without shrinkage: Gameflip claim auto rows with an exact-here ref (>= 3 orders,
// median), x = ask / ref, exposure from createdAt to the first sale / now / updatedAt, capped at createdAt + 30 d,
// clipped to the 90-day window; bucket hazards S / D, log-linear between bucket centres (plan §4.3).
const EDGES = [0.8, 1.0, 1.2, 1.5, 2.0, Infinity];
const CENTRES = [0.7, 0.9, 1.1, 1.35, 1.75, 2.5];
function gameflipHazard(b) {
  const now = b.now;
  const ords = ordersByCk(b, "gameflip");
  const fs1 = firstSaleByLid(b);
  const S = [0, 0, 0, 0, 0, 0];
  const D = [0, 0, 0, 0, 0, 0];
  const xs = [];
  for (const L of b.listings) {
    if (L.m !== "gameflip" || L.o !== "auto" || L.kind !== "single" || L.f !== "claim") continue;
    const o = ords.get(L.ck);
    if (!o || o.length < 3) continue;
    const x = Math.max(L.p, 0.75) / median(o);
    const sold = fs1.get(L.id);
    const end = Math.min(sold != null ? sold : L.st === "active" ? now : L.u, L.c + 30 * DAY);
    const a = Math.max(L.c, now - 90 * DAY);
    const z = Math.min(end, now);
    if (z <= a) continue;
    xs.push(x);
    const bi = EDGES.findIndex((e) => x <= e);
    D[bi] += (z - a) / DAY;
    if (sold != null && sold >= a && sold <= z) S[bi]++;
  }
  const h = S.map((s, i) => s / D[i]);
  const at = (x) => {
    if (x <= CENTRES[0]) return h[0];
    for (let i = 0; i < 5; i++) {
      if (x <= CENTRES[i + 1]) {
        const f = (x - CENTRES[i]) / (CENTRES[i + 1] - CENTRES[i]);
        return Math.exp(Math.log(h[i]) * (1 - f) + Math.log(h[i + 1]) * f);
      }
    }
    return h[5];
  };
  return { S, D, h, at, xs };
}

function walk(v, visit, p = "$") {
  visit(v, p);
  if (Array.isArray(v)) v.forEach((x, i) => walk(x, visit, `${p}[${i}]`));
  else if (v && typeof v === "object") for (const k of Object.keys(v)) walk(v[k], visit, `${p}.${k}`);
}

const isMs = (t) => Number.isInteger(t) && t > Date.UTC(2025, 0, 1) && t < Date.UTC(2028, 0, 1);
const isHex12 = (s) => typeof s === "string" && /^[0-9a-f]{12}$/.test(s);
const isNumOrNull = (v) => v === null || (typeof v === "number" && Number.isFinite(v));

/* ---------------------------------------------------------------- module, CLI, determinism */

test("require runs nothing: no output, no file, only the exports", () => {
  const out = execFileSync(process.execPath, ["-e", `require(${JSON.stringify(SCRIPT)})`], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(out, "");
  assert.deepEqual(Object.keys(F).sort(), ["DEFAULT_NOW", "LAWS", "PLANTED", "generate", "mulberry32", "toJson"]);
  assert.equal(F.DEFAULT_NOW, Date.UTC(2026, 9, 3, 12));
  // The source never reads the clock or Math.random: the default `now` is the only time.
  const src = fs.readFileSync(SCRIPT, "utf8");
  assert.doesNotMatch(src, /Date\.now\(|Math\.random\(|new Date\(/);
});

test("mulberry32 is the seeded PRNG: same seed same stream, floats in [0, 1)", () => {
  const a = F.mulberry32(42);
  const b = F.mulberry32(42);
  const c = F.mulberry32(43);
  const xs = Array.from({ length: 1000 }, () => a());
  assert.deepEqual(
    xs,
    Array.from({ length: 1000 }, () => b()),
  );
  assert.notDeepEqual(
    xs.slice(0, 10),
    Array.from({ length: 10 }, () => c()),
  );
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  assert.ok(Math.abs(mean - 0.5) < 0.05, "roughly uniform");
});

test("deterministic for a seed, different for another seed, `now` moves every time", () => {
  assert.deepEqual(F.generate(), small);
  assert.equal(F.toJson(F.generate({ seed: 1 })), F.toJson(small));
  const other = F.generate({ seed: 2 });
  assert.notDeepEqual(other.sales, small.sales);
  assert.notDeepEqual(
    other.listings.map((L) => L.id),
    small.listings.map((L) => L.id),
  );
  const later = F.generate({ now: small.now + 7 * DAY });
  assert.equal(later.now, small.now + 7 * DAY);
  assert.equal(later.listings.length, small.listings.length);
  assert.equal(later.listings[0].c, small.listings[0].c + 7 * DAY);
  assert.throws(() => F.generate({ seed: -1 }), /seed/);
  assert.throws(() => F.generate({ now: "soon" }), /now/);
});

test("the committed small fixture is generate() with the defaults (regenerate with the CLI when it changes)", () => {
  const text = fs.readFileSync(SMALL_FILE, "utf8");
  assert.deepEqual(
    JSON.parse(text),
    small,
    "run: node scripts/listing-brain-fixture.js --out tests/fixtures/listingBrain/small.json",
  );
  assert.equal(text, F.toJson(small));
  assert.ok(Buffer.byteLength(text) < 410 * 1024, `small fixture is ${Buffer.byteLength(text)} bytes`);
});

test("CLI: JSON on stdout by default, --seed and --out, bad argument refused", () => {
  const out = execFileSync(process.execPath, [SCRIPT, "--seed", "3"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  assert.deepEqual(JSON.parse(out), F.generate({ seed: 3 }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lb-fixture-"));
  try {
    const file = path.join(dir, "b.json");
    execFileSync(process.execPath, [SCRIPT, "--seed=4", "--out", file], { cwd: ROOT, stdio: "pipe" });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), F.generate({ seed: 4 }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, "--bogus"], { cwd: ROOT, stdio: "pipe" }));
});

/* ---------------------------------------------------------------- shape (plan §2.1) */

function checkShape(b) {
  assert.deepEqual(Object.keys(b), [
    "kind",
    "v",
    "now",
    "af",
    "sizing",
    "fees",
    "pricing",
    "bulk",
    "listings",
    "sales",
    "demandOnly",
    "bulkPrices",
    "radar",
    "demand",
    "noclaim",
    "old",
    "notes",
    "counts",
  ]);
  assert.equal(b.kind, "listing-brain-bundle");
  assert.equal(b.v, 1);
  assert.ok(isMs(b.now));

  // Plain JSON only: no Date, Map, Set, undefined, NaN or Infinity anywhere, and it survives a round trip.
  walk(b, (v, p) => {
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number") return assert.ok(Number.isFinite(v), p + " is not finite");
    if (Array.isArray(v)) return;
    assert.equal(typeof v, "object", p);
    assert.equal(Object.getPrototypeOf(v), Object.prototype, p + " is not a plain object");
  });
  assert.deepEqual(JSON.parse(JSON.stringify(b)), b);

  const af = b.af;
  assert.deepEqual(Object.keys(af), [
    "listingBrain",
    "perMarketStock",
    "takes",
    "mapped",
    "noClaimGames",
    "noclaimAutoSize",
    "capDefault",
    "caps",
  ]);
  assert.equal(af.perMarketStock, 3);
  assert.deepEqual(af.takes, {
    gameflip: true,
    digiseller: false,
    ggsel: true,
    zeusx: true,
    eldorado: true,
    playerauctions: true,
    g2g: true,
  });
  assert.deepEqual(af.noClaimGames, ["omega"]);
  assert.equal(af.capDefault, 70);
  for (const [g, map] of Object.entries(af.mapped)) {
    assert.deepEqual(Object.keys(map).sort(), MARKETS.slice().sort(), g);
    assert.ok(Object.values(map).every((x) => typeof x === "boolean"));
  }
  for (const n of Object.values(af.caps)) assert.ok(Number.isInteger(n) && n > 0);
  assert.deepEqual(b.sizing, { coverageDays: 28, safetyStock: 6, maxPerGame: 250 });
  assert.deepEqual(b.fees, {});
  assert.deepEqual(b.pricing, {
    floorUsd: 0.75,
    ceilingUsd: 4.5,
    gameFloors: {},
    itemStepPct: 15,
    itemCapMult: 2.5,
    fullEventBonusPct: 25,
  });
  assert.deepEqual(b.bulk, {
    markets: ["eldorado", "g2g"],
    tiers: [
      { size: 5, discountPct: 10 },
      { size: 10, discountPct: 20 },
    ],
    reserveSingles: 2,
  });

  const ids = new Set();
  for (const L of b.listings) {
    assert.deepEqual(Object.keys(L), [
      "id",
      "g",
      "gl",
      "m",
      "o",
      "f",
      "kind",
      "script",
      "ck",
      "bk",
      "ex",
      "n",
      "p",
      "vmin",
      "smin",
      "st",
      "c",
      "u",
      "units",
      "qty",
      "qr",
      "rb",
      "pack",
    ]);
    assert.ok(isHex12(L.id) && !ids.has(L.id), L.id);
    ids.add(L.id);
    assert.ok(typeof L.g === "string" && L.g && typeof L.gl === "string" && L.gl.toLowerCase() === L.g, L.g);
    assert.ok(MARKETS.includes(L.m));
    assert.ok(["auto", "unclaimed", "manual"].includes(L.o));
    assert.ok(["claim", "noclaim"].includes(L.f));
    assert.ok(["single", "cas", "bulk", "lot", "account", "farm"].includes(L.kind));
    assert.equal(typeof L.script, "boolean");
    if (L.script) assert.ok(L.o === "auto" && L.kind === "cas", "script only on auto claim-at-sale rows");
    assert.ok(L.ck === null || /^[st]:[0-9a-f]{12}$/.test(L.ck), L.ck);
    assert.ok(L.bk.startsWith(L.g + "|"));
    if (L.n != null) assert.equal(L.bk, L.g + "|" + sizeBand(L.n));
    assert.equal(typeof L.ex, "boolean");
    assert.ok(L.n === null || (Number.isInteger(L.n) && L.n > 0));
    assert.ok(typeof L.p === "number" && L.p > 0);
    assert.ok(isNumOrNull(L.vmin) && isNumOrNull(L.smin));
    assert.ok(["active", "sold", "delisted", "removed", "error", "paused"].includes(L.st));
    assert.ok(isMs(L.c) && isMs(L.u) && L.u >= L.c && L.c <= b.now && L.u <= b.now, L.id);
    assert.ok(Array.isArray(L.units) && L.units.length <= 200);
    for (const w of L.units) {
      assert.deepEqual(Object.keys(w), ["a", "d"]);
      assert.ok(isMs(w.a) && (w.d === null || (isMs(w.d) && w.d >= w.a)));
    }
    assert.ok(Number.isInteger(L.qty) && L.qty >= 0);
    if (L.st !== "active") assert.equal(L.qty, 0, "only a live row lists units");
    assert.ok(L.qr === null || Number.isInteger(L.qr));
    assert.ok(L.rb === null || (isMs(L.rb) && L.rb > L.c));
    assert.ok(L.pack === null || (Number.isInteger(L.pack) && L.pack > 1));
  }
  const byId = new Map(b.listings.map((L) => [L.id, L]));
  for (const s of b.sales) {
    assert.deepEqual(Object.keys(s), [
      "lid",
      "g",
      "m",
      "o",
      "f",
      "ck",
      "bk",
      "ex",
      "n",
      "p",
      "t",
      "grp",
      "basis",
      "src",
    ]);
    assert.ok(s.lid === "" || byId.has(s.lid), "a sale's listing exists");
    if (s.lid) {
      const L = byId.get(s.lid);
      assert.ok(
        L.g === s.g && L.m === s.m && L.ck === s.ck && L.o === s.o && L.f === s.f,
        "sale carries its row's identity",
      );
      assert.ok(s.t >= L.c, "no sale before its row existed");
    } else assert.equal(s.src, "hand");
    assert.ok(MARKETS.includes(s.m) || s.m === "unknown");
    assert.ok(typeof s.p === "number" && s.p >= 0 && s.p <= 25);
    assert.ok(isMs(s.t) && s.t <= b.now);
    assert.ok(isHex12(s.grp));
    assert.ok(["reported", "listing-now", "row", "paid"].includes(s.basis));
    assert.ok(["unit", "signal", "row", "hand", "shop", "unclaimed"].includes(s.src));
    if (["eldorado", "playerauctions", "g2g"].includes(s.m) && s.src === "unit") assert.equal(s.basis, "listing-now");
    if (s.src === "unclaimed") assert.equal(byId.get(s.lid).o, "unclaimed");
  }
  // Units sharing an order key share a time (one order) and a listing.
  const byGrp = new Map();
  for (const s of b.sales) {
    if (!byGrp.has(s.grp)) byGrp.set(s.grp, []);
    byGrp.get(s.grp).push(s);
  }
  for (const list of byGrp.values()) assert.ok(list.every((s) => s.t === list[0].t && s.lid === list[0].lid));
  for (const d of b.demandOnly) {
    assert.deepEqual(Object.keys(d), ["g", "m", "f", "t", "src"]);
    assert.ok(["bulk", "bulk-order", "shop", "burst"].includes(d.src) && isMs(d.t) && typeof d.m === "string");
  }
  for (const x of b.bulkPrices) {
    assert.deepEqual(Object.keys(x), ["g", "m", "t", "pa", "size"]);
    assert.ok(b.bulk.markets.includes(x.m) && x.pa > 0 && [5, 10].includes(x.size) && isMs(x.t));
  }
  assert.ok(isMs(b.radar.at));
  for (const rg of b.radar.games) {
    assert.deepEqual(Object.keys(rg), ["key", "perWeek", "rivalSellers", "medianTtsHours", "byMarket"]);
    assert.deepEqual(Object.keys(rg.byMarket), ["gameflip", "ggsel", "digiseller"]);
    for (const bm of Object.values(rg.byMarket)) {
      assert.deepEqual(Object.keys(bm), ["perWeek", "liveSellers", "sold", "medianTtsHours"]);
      assert.deepEqual(Object.keys(bm.sold), ["n", "p25", "median", "p75"]);
      assert.ok(bm.sold.p25 <= bm.sold.median && bm.sold.median <= bm.sold.p75);
    }
  }
  for (const r of b.radar.feed) {
    assert.deepEqual(Object.keys(r), ["g", "m", "p", "u", "n", "t", "tts"]);
    assert.ok(
      ["gameflip", "ggsel"].includes(r.m) &&
        r.p > 0 &&
        r.u > 0 &&
        Number.isInteger(r.n) &&
        isMs(r.t) &&
        isNumOrNull(r.tts),
    );
  }
  for (const d of b.demand) {
    assert.deepEqual(Object.keys(d), ["k", "f", "at", "live", "hl", "c", "w", "t", "on", "fl", "a30", "a45"]);
    assert.ok(isMs(d.at) && typeof d.live === "boolean" && isNumOrNull(d.hl) && d.w > 0 && d.on >= 0 && d.fl >= 0);
    assert.ok(d.f === "noclaim" ? d.c === "fleet" : ["farm", "probe", "skip"].includes(d.c));
  }
  for (const u of b.noclaim.units) {
    assert.deepEqual(Object.keys(u), ["g", "m", "st", "l", "s", "p", "sm", "x", "lids", "bk", "camps"]);
    assert.ok(["listed", "sold", "expired", "released", "skipped", "removed", "manual"].includes(u.st));
    assert.ok(isMs(u.l) && (u.s === null || isMs(u.s)) && (u.x === null || isMs(u.x)));
    assert.ok(
      u.lids.every((id) => byId.has(id)),
      "a unit's listing ids exist",
    );
    assert.ok(Array.isArray(u.camps) && u.camps.length && u.bk.startsWith(u.g + "|"));
    if (u.st === "sold") assert.ok(u.s != null && u.sm);
    if (u.st === "expired") assert.ok(u.x != null);
  }
  for (const w of b.noclaim.waves) {
    assert.deepEqual(Object.keys(w), ["g", "ev", "wave", "startAt", "endAt"]);
    assert.ok(isMs(w.startAt) && isMs(w.endAt) && w.endAt > w.startAt);
  }
  for (const [g, og] of Object.entries(b.old.games)) {
    assert.deepEqual(Object.keys(og), ["base", "ggsel", "post", "split", "flat", "order"]);
    assert.ok(og.base >= 0.75 && og.ggsel >= 0.75 && og.post >= 0.75, g);
    assert.deepEqual(og.order, ["gameflip", "ggsel", "zeusx", "eldorado", "playerauctions", "g2g"]);
    const on = demandOf(b, g) ? demandOf(b, g).on : og.split.listNow + og.split.holdBack;
    assert.deepEqual(og.split, { listNow: Math.ceil(on / 2), holdBack: on - Math.ceil(on / 2) });
    assert.equal(
      Object.values(og.flat).reduce((a, x) => a + x, 0),
      og.split.listNow,
      "flat deals exactly listNow",
    );
  }
  for (const [key, oo] of Object.entries(b.old.offers)) {
    assert.match(key, /^(gameflip|digiseller|ggsel|zeusx|eldorado|playerauctions|g2g)\|/);
    assert.deepEqual(Object.keys(oo), ["np", "tracker"]);
    assert.ok(typeof oo.np === "number" && oo.np > 0);
    if (oo.tracker) assert.deepEqual(Object.keys(oo.tracker), ["price", "basis", "confidence"]);
  }
  assert.ok(Array.isArray(b.notes) && b.notes.every((n) => typeof n === "string"));
  assert.equal(b.counts.listings, b.listings.length);
  assert.equal(b.counts.sales, b.sales.length);
  assert.equal(b.counts.units, b.noclaim.units.length);
}

test("shape: every record has the plan §2.1 fields with the right types (small and large)", () => {
  checkShape(small);
  checkShape(large);
});

test("privacy: no identifying key anywhere, no address-like value", () => {
  const FORBIDDEN = new Set([
    "login",
    "logins",
    "loginLower",
    "account",
    "accountId",
    "accountLogin",
    "seller",
    "sellerName",
    "sellerScore",
    "sellerRatings",
    "dedupeKey",
    "orderId",
    "externalId",
    "note",
    "contentId",
    "twitchId",
    "poolAccountId",
    "botId",
    "container",
    "_id",
    "email",
    "password",
    "token",
  ]);
  for (const b of [small, large]) {
    walk(b, (v, p) => {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        for (const k of Object.keys(v)) assert.ok(!FORBIDDEN.has(k), `${p}.${k}`);
      }
      if (typeof v === "string") assert.doesNotMatch(v, /@|https?:\/\/|\.com\b/, p);
    });
  }
});

/* ---------------------------------------------------------------- large mode */

test("large mode: 150 games on all 7 markets, >= 3,000 listings, >= 5,000 sales over ~120 days, in < 2 s", () => {
  const c = large.counts;
  assert.equal(c.games, 150);
  const games = new Set([...large.listings.map((L) => L.g), ...large.noclaim.units.map((u) => u.g)]);
  assert.equal(games.size, 150);
  assert.deepEqual([...new Set(large.listings.map((L) => L.m))].sort(), MARKETS.slice().sort());
  assert.ok(large.listings.length >= 3000, `${large.listings.length} listings`);
  assert.ok(large.sales.length >= 5000, `${large.sales.length} sales`);
  const span = (large.now - Math.min(...large.sales.map((s) => s.t))) / DAY;
  assert.ok(span >= 100 && span <= 130, `sales span ${span.toFixed(0)} days`);
  assert.ok(largeMs < 2000, `large generation took ${largeMs.toFixed(0)} ms`);
  // Plausible prices: system-made single rows sit in $0.75-$6 except the planted outliers (Digiseller 3x, the
  // PlayerAuctions $5 floor is inside the range anyway).
  for (const L of large.listings) {
    if (L.kind !== "single" || L.o === "manual" || L.m === "digiseller") continue;
    assert.ok(L.p >= 0.75 && L.p <= 6, `${L.g} ${L.m} ${L.p}`);
  }
  // Large is small plus fillers: the planted games are byte-identical in both.
  const inLarge = new Set(large.listings.map((L) => JSON.stringify(L)));
  assert.ok(small.listings.every((L) => inLarge.has(JSON.stringify(L))));
  const salesLarge = new Set(large.sales.map((s) => JSON.stringify(s)));
  assert.ok(small.sales.every((s) => salesLarge.has(JSON.stringify(s))));
  assert.ok(large.radar.games.length < c.games, "some games unwatched by the radar");
  assert.ok(large.demand.length < c.games, "some games have no farm-brain row");
});

/* ---------------------------------------------------------------- planted truths */

test("A: Gameflip claim rows recover the planted elasticity h(x) = h0 exp(-beta (x - 1))", () => {
  const want = Math.exp(P.A.beta * (P.A.ratio.x2 - P.A.ratio.x1));
  assert.equal(P.A.ratio.value, Math.round(want * 1e4) / 1e4);
  for (const [b, tol] of [
    [small, 0.2],
    [large, 0.1],
  ]) {
    const hz = gameflipHazard(b);
    const ratio = hz.at(P.A.ratio.x1) / hz.at(P.A.ratio.x2);
    assert.ok(Math.abs(ratio / want - 1) <= tol, `h(0.9)/h(1.5) = ${ratio.toFixed(3)}, planted ${want.toFixed(3)}`);
    const h1 = hz.at(1);
    assert.ok(Math.abs(h1 / P.A.h0 - 1) <= P.A.h0TolPct / 100, `h(1) = ${h1.toFixed(4)}`);
    assert.ok(Math.min(...hz.xs) <= 0.65 && Math.max(...hz.xs) >= 2.1, "asks spread over 0.6-2.2");
    assert.ok(
      hz.S.every((s) => s >= 5),
      "every bucket has sales: " + hz.S.join(","),
    );
  }
  // The reference price is the realised median of each exact offer (>= 3 orders) and equals the planted R (the price
  // of its older rows at x = 1).
  const ords = ordersByCk(small, "gameflip");
  for (const g of P.A.games) {
    const rows = rowsOf(small, g, "gameflip").filter((L) => L.o === "auto");
    assert.ok(
      rows.some((L) => L.st === "active") && rows.some((L) => L.st === "delisted") && rows.some((L) => L.st === "sold"),
      g,
    );
  }
  for (const o of P.A.offers) {
    const rows = rowsOf(small, o.game, "gameflip").filter((L) => L.o === "auto" && L.n === o.n);
    const cks = new Set(rows.map((L) => L.ck));
    assert.equal(cks.size, 1);
    const [ck] = cks;
    assert.ok(ords.get(ck).length >= P.A.minOrdersPerOffer);
    assert.equal(median(ords.get(ck)), o.R, `${o.game} n=${o.n}`);
    const xs = rows.filter((L) => L.c >= small.now - 90 * DAY).map((L) => L.p / o.R);
    assert.ok(Math.min(...xs) <= 0.8 && Math.max(...xs) >= 2, `${o.game} asks reach both end buckets`);
  }
  // The older rows at x = 1 that pin each median ended before the 90-day fit window opened: they make the reference
  // price and nothing else (their loop stops on a sale, so their outcomes are not a fair draw of the law).
  const fs1 = firstSaleByLid(small);
  for (const L of small.listings.filter((x) => x.m === "gameflip" && x.f === "claim" && x.c < small.now - 90 * DAY)) {
    const end = fs1.has(L.id) ? fs1.get(L.id) : L.u;
    assert.ok(end < small.now - 90 * DAY, `anchor ${L.id} reaches into the fit window`);
  }
  // Rows past their 30-day Gameflip expiry stayed `active` until the cleanup pass: updatedAt overstates exposure.
  assert.ok(small.listings.some((L) => L.m === "gameflip" && L.st === "delisted" && L.u - L.c > 31 * DAY));
});

test("B, B2, C, C2: regime inputs on the farm-brain rows", () => {
  const T = small.sizing.coverageDays / 7;
  const b = demandOf(small, P.B.game);
  assert.equal(b.w, P.B.w);
  assert.equal(b.on, P.B.on);
  assert.ok(b.on / b.w > 2 * T, "overstock cover");
  assert.ok(rowsOf(small, P.B.game, "gameflip").every((L) => L.o !== "auto" || L.smin != null));
  const b2 = demandOf(small, P.B2.game);
  assert.ok(b2.a30 < 0.5 * b2.a45, "fading");
  assert.ok(b2.on / b2.w > 0.5 * T && b2.on / b2.w < 2 * T, "ordinary cover");
  const c = demandOf(small, P.C.game);
  assert.equal(c.w, P.C.w);
  assert.equal(c.on, P.C.on);
  assert.ok(c.on / c.w < 0.5 * T, "scarce cover");
  const live = rowsOf(small, P.C.game)
    .filter((L) => L.st === "active" && L.o === "auto")
    .reduce((a, L) => a + L.qty, 0);
  assert.ok(live <= P.C.on, "no more live units than stock on hand");
  const c2 = demandOf(small, P.C2.game);
  assert.equal(c2.live, false);
  assert.ok(c2.on / c2.w > 0.5 * T && c2.on / c2.w < 2 * T);
  const wave = small.noclaim.waves.find((w) => w.g === P.C2.game);
  assert.ok(Math.abs((small.now - wave.endAt) / DAY - P.C2.endedDaysAgo) < 0.01);
  const rg = small.radar.games.find((r) => r.key === P.C2.game);
  assert.ok(rg.rivalSellers <= P.C2.liveRivalSellers);
  // The other planted claim games are in neither extreme unless planted so.
  for (const g of ["zeta legends", "nu frontier", "theta drift"]) {
    const d = demandOf(small, g);
    assert.ok(d.on / d.w >= 0.5 * T && d.on / d.w <= 2 * T, g);
  }
});

test("D: GGSel stocked half the window sells at Gameflip's rate per in-stock day", () => {
  const now = small.now;
  const D = P.D;
  const fs1 = firstSaleByLid(small);
  const overlap = (a, z) => Math.max(0, Math.min(z, now) - Math.max(a, now - 30 * DAY)) / DAY;
  for (const m of ["gameflip", "ggsel"]) {
    const rows = rowsOf(small, D.game, m);
    assert.ok(rows.every((L) => L.o === "auto" && L.f === "claim"));
    const end = (L) => (m === "gameflip" && fs1.has(L.id) ? fs1.get(L.id) : L.st === "active" ? now : L.u);
    const days = rows.reduce((a, L) => a + overlap(L.c, end(L)), 0);
    const sales = salesOf(small, D.game, m).filter((s) => s.t >= now - 30 * DAY).length;
    assert.ok(Math.abs(days - D.markets[m].inStockDays30) < 0.1, `${m} in stock ${days}`);
    assert.equal(sales, D.markets[m].sales30, m);
    assert.ok(Math.abs(sales / days / D.markets[m].dailyRate - 1) < 0.15, `${m} rate`);
  }
  // GGSel rows exist only in alternate periods: a gap of a full period between consecutive rows.
  const gg = rowsOf(small, D.game, "ggsel").sort((a, b) => a.c - b.c);
  for (let i = 1; i < gg.length; i++) assert.ok(gg[i].c - gg[i - 1].u >= (D.periodDays - 0.01) * DAY);
  // Gameflip is never empty: one row after another.
  const gf = rowsOf(small, D.game, "gameflip").sort((a, b) => a.c - b.c);
  for (let i = 1; i < gf.length; i++) assert.ok(gf[i].c - fs1.get(gf[i - 1].id) < HOUR);
  assert.equal(gf.filter((L) => L.st === "active").length, 1);
});

test("E: Digiseller is blocked but has history, at 3x the other markets' price", () => {
  assert.equal(VENUES.digiseller.blocked, true);
  assert.equal(small.af.takes.digiseller, false);
  for (const g of P.E.games) {
    const rows = rowsOf(small, g, "digiseller");
    assert.ok(rows.length > 0 && salesOf(small, g, "digiseller").length > 0, g);
  }
  // Every Digiseller sale is ~3x the same offer's Gameflip price.
  const gf = ordersByCk(small, "gameflip");
  let compared = 0;
  for (const s of small.sales.filter((x) => x.m === "digiseller" && x.src !== "unclaimed")) {
    const o = gf.get(s.ck);
    if (!o) continue;
    compared++;
    const r = s.p / median(o);
    assert.ok(r > 2.5 && r < 3.5, `${s.g} digiseller ${s.p} vs gameflip ${median(o)}`);
  }
  assert.ok(compared >= 10);
  // The probe: 2 Gameflip orders, 5 GGSel, 6 Digiseller, and nothing on Eldorado.
  const pr = P.E.probe;
  const probeCk = rowsOf(small, pr.game, "gameflip").find((L) => L.n === pr.n).ck;
  for (const [m, n] of Object.entries(pr.orders)) {
    const sales = salesOf(small, pr.game, m).filter((s) => s.ck === probeCk);
    assert.equal(sales.length, n, m);
    assert.ok(
      sales.every((s) => Math.abs(s.p / pr.prices[m] - 1) < 0.05),
      m,
    );
  }
  const sameBand = salesOf(small, pr.game, "gameflip").filter(
    (s) => s.bk === small.listings.find((L) => L.ck === probeCk).bk,
  );
  assert.equal(sameBand.length, pr.orders.gameflip, "no band-here fallback on Gameflip either");
  assert.ok(
    rowsOf(small, pr.game, "digiseller").some((L) => L.st === "active" && L.ck === probeCk),
    "a live row on the blocked market",
  );
});

test("F: a hand-made Eldorado ladder ($1, $2, $4) beside an auto row of the same exact offer", () => {
  const rows = rowsOf(small, P.F.game, "eldorado").filter((L) => L.st === "active");
  const ck = rows.find((L) => L.p === 4).ck;
  const ladder = rows.filter((L) => L.ck === ck);
  assert.deepEqual(
    ladder
      .filter((L) => L.o === "manual")
      .map((L) => L.p)
      .sort((a, b) => a - b),
    [1, 2, 4],
  );
  assert.deepEqual(
    ladder.filter((L) => L.o === "auto").map((L) => L.p),
    [1.75],
  );
  for (const r of P.F.rungs) {
    const L = ladder.find((x) => x.p === r.p);
    const sales = small.sales.filter((s) => s.lid === L.id);
    assert.equal(sales.length, r.sold, `rung ${r.p}`);
    assert.equal(new Set(sales.map((s) => s.grp)).size, r.orders);
    assert.equal(L.qty, r.qty - r.sold);
    assert.ok(sales.every((s) => s.basis === "listing-now" && s.src === "unit" && s.p === r.p));
  }
  // Orders of 2-3 units share one order key somewhere on Eldorado.
  const grp = new Map();
  for (const s of small.sales.filter((x) => x.m === "eldorado")) grp.set(s.grp, (grp.get(s.grp) || 0) + 1);
  assert.ok([...grp.values()].some((n) => n >= 2));
});

test("G: a rent-farm row with sales", () => {
  const farm = small.listings.filter((L) => L.kind === "farm");
  assert.equal(farm.length, 1);
  const [L] = farm;
  assert.equal(L.g, P.G.game);
  assert.equal(L.p, P.G.price);
  assert.equal(L.ex, false);
  assert.match(L.ck, /^t:/);
  const sales = small.sales.filter((s) => s.lid === L.id);
  assert.equal(sales.length, P.G.sales);
  assert.ok(sales.every((s) => s.p === P.G.price && s.src === "signal"));
});

test("H: a mass-close burst is demand only, at a fake price, with no sale behind it", () => {
  const bursts = small.demandOnly.filter((d) => d.g === P.H.game && d.src === "burst").sort((a, b) => a.t - b.t);
  assert.ok(bursts.length >= 10 && bursts.length === P.H.n);
  assert.ok(bursts.every((d) => d.m === P.H.market && d.f === "claim"));
  assert.ok(bursts[bursts.length - 1].t - bursts[0].t <= P.H.windowMinutes * MIN);
  const closed = rowsOf(small, P.H.game, P.H.market).filter((L) => L.p === P.H.fakePrice);
  assert.equal(closed.length, P.H.n);
  assert.ok(closed.every((L) => L.st === "delisted" && L.o === "manual" && Math.abs(L.u - bursts[0].t) < 10 * MIN));
  const closedIds = new Set(closed.map((L) => L.id));
  assert.ok(!small.sales.some((s) => closedIds.has(s.lid)));
  assert.ok(!salesOf(small, P.H.game).some((s) => s.p >= P.H.fakePrice * 0.9));
  // Hand sales at a high price: in the sales list, never priced evidence (src "hand", no listing).
  const hand = salesOf(small, P.H.handHigh.game).filter((s) => s.src === "hand");
  assert.equal(hand.length, P.H.handHigh.n);
  assert.ok(hand.every((s) => s.p === P.H.handHigh.price && s.lid === "" && s.ck === null));
});

test("I: a game with no farm-brain row, and one whose row is stale", () => {
  assert.equal(demandOf(small, P.I.noDemand), undefined);
  assert.ok(rowsOf(small, P.I.noDemand).length > 0 && salesOf(small, P.I.noDemand).length > 0);
  const stale = demandOf(small, P.I.staleGame);
  assert.ok(Math.abs((small.now - stale.at) / HOUR - P.I.staleHours) < 0.01);
  assert.ok(P.I.staleHours > P.I.maxDemandAgeH);
  const fresh = small.demand.filter((d) => d.k !== P.I.staleGame);
  assert.ok(fresh.every((d) => small.now - d.at < P.I.maxDemandAgeH * HOUR));
});

test("J: claim-at-sale rows — an Eldorado noclaimStock row and a G2G operator-script row", () => {
  const cas = small.listings.filter((L) => L.kind === "cas");
  const ns = cas.find((L) => L.m === P.J.cas.market);
  assert.ok(
    ns && ns.g === P.J.cas.game && ns.o === "manual" && ns.f === "noclaim" && !ns.script && ns.qty === P.J.cas.qty,
  );
  const sc = cas.find((L) => L.m === P.J.script.market);
  assert.ok(
    sc && sc.g === P.J.script.game && sc.o === "auto" && sc.f === "claim" && sc.script && sc.qty === P.J.script.qty,
  );
  for (const [L, sold] of [
    [ns, P.J.cas.sold],
    [sc, P.J.script.sold],
  ]) {
    assert.ok(
      L.units.every((w) => w.a === w.d),
      "claim-at-sale units are delivery records",
    );
    assert.equal(small.sales.filter((s) => s.lid === L.id).length, sold);
  }
  // The noclaimStock row's sold units are also in the ledger of units (the same units).
  assert.equal(small.noclaim.units.filter((u) => u.lids.includes(ns.id) && u.st === "sold").length, P.J.cas.sold);
  // Their advertised quantity dwarfs the real stock: summing it would be wrong.
  assert.ok(sc.qty > demandOf(small, P.J.script.game).on);
});

test("K: fees left empty, so five are assumed; a fee near-tie game", () => {
  assert.deepEqual(small.fees, P.K.fees);
  const assumed = Object.keys(VENUES)
    .filter((m) => !VENUES[m].verified)
    .sort();
  assert.deepEqual(assumed, P.K.assumed.slice().sort());
  assert.deepEqual(
    Object.keys(VENUES)
      .filter((m) => VENUES[m].verified)
      .sort(),
    P.K.verified.slice().sort(),
  );
  const k = P.K.design;
  assert.ok(k.eldorado.ref > k.gameflip.ref, "gross: Eldorado higher");
  assert.ok(
    k.eldorado.ref * (1 - k.eldorado.feePct / 100) < k.gameflip.ref * (1 - k.gameflip.feePct / 100),
    "net: Gameflip higher",
  );
  const gf = ordersByCk(small, "gameflip");
  const el = ordersByCk(small, "eldorado");
  const ck = rowsOf(small, P.K.game, "eldorado")[0].ck;
  assert.equal(median(gf.get(ck)), k.gameflip.ref);
  assert.ok(el.get(ck).length >= 3);
  assert.equal(median(el.get(ck)), k.eldorado.ref);
});

test("L: ZeusX auto rows never record a sale", () => {
  const rows = rowsOf(small, P.L.game, "zeusx");
  assert.ok(rows.length >= 2 && rows.every((L) => L.o === "auto") && rows.some((L) => L.st === "active"));
  assert.equal(small.sales.filter((s) => s.m === "zeusx").length, 0);
  assert.equal(large.sales.filter((s) => s.m === "zeusx").length, 0);
  assert.ok(large.listings.filter((L) => L.m === "zeusx").length > 10);
});

test("M: a PlayerAuctions row at the $5 floor for an offer that sells for ~$1.50 elsewhere", () => {
  const pa = rowsOf(small, P.M.game, "playerauctions");
  assert.equal(pa.length, 1);
  assert.ok(pa[0].st === "active" && pa[0].p === P.M.floor && pa[0].o === "auto");
  assert.equal(salesOf(small, P.M.game, "playerauctions").length, 0);
  const gf = ordersByCk(small, "gameflip");
  assert.equal(median(gf.get(pa[0].ck)), P.M.sellsFor);
  assert.ok(VENUES.playerauctions && P.M.floor > P.M.sellsFor * 2);
});

test("N: a wave that ended with stock unsold, a live wave about to perish, a ~1-day claim window", () => {
  const waveOf = (u) => small.noclaim.waves.find((w) => w.g === u.g && `${w.ev} ${w.wave}` === u.camps[0]);
  const gaps = small.noclaim.units.filter((u) => u.st === "expired").map((u) => (u.x - waveOf(u).endAt) / DAY);
  assert.ok(gaps.length >= 10);
  assert.ok(
    Math.abs(median(gaps) - P.N.claimWindowDays.value) <= P.N.claimWindowDays.tolDays,
    `median ${median(gaps)}`,
  );
  const camp = (x) => `${x.event} ${x.wave}`;
  const ended = small.noclaim.units.filter((u) => u.g === P.N.ended.game && u.camps[0] === camp(P.N.ended));
  const wEnded = small.noclaim.waves.find((w) => w.g === P.N.ended.game && w.wave === P.N.ended.wave);
  assert.ok(Math.abs((small.now - wEnded.endAt) / DAY - P.N.ended.endedDaysAgo) < 0.01);
  const n = (list, st) => list.filter((u) => u.st === st).length;
  assert.ok(n(ended, "expired") > 2 * n(ended, "sold"), `expired ${n(ended, "expired")} sold ${n(ended, "sold")}`);
  assert.equal(n(ended, "listed"), 0);
  const per = small.noclaim.units.filter((u) => u.g === P.N.perish.game && u.camps[0] === camp(P.N.perish));
  const wPer = small.noclaim.waves.find((w) => w.g === P.N.perish.game && w.wave === P.N.perish.wave);
  assert.ok(Math.abs((wPer.endAt - small.now) / HOUR - P.N.perish.endsInHours) < 0.01);
  assert.ok(n(per, "listed") >= 10, `${n(per, "listed")} listed`);
  assert.ok(wPer.endAt + P.N.claimWindowDays.value * DAY - small.now < 48 * HOUR, "expires within perishHours");
  assert.ok(per.filter((u) => u.st === "listed").every((u) => u.m && (u.lids.length || u.m === "gameflip")));
  const d = demandOf(small, P.N.perish.game);
  assert.ok(d.live && d.on / d.w > 2 && d.on / d.w < 8, "ordinary cover: overstock only through perishing");
});

test("O: a no-claim game sold mostly in bulk, with a per-account bulk price series", () => {
  const now = small.now;
  const bulk = small.demandOnly.filter((d) => d.g === P.O.game && d.src === "bulk" && d.t >= now - 30 * DAY);
  const singles = salesOf(small, P.O.game).filter((s) => s.t >= now - 30 * DAY);
  assert.ok(bulk.length >= 5 * singles.length, `${bulk.length} bulk vs ${singles.length} single`);
  assert.ok(bulk.every((d) => P.O.markets.includes(d.m)));
  const bp = small.bulkPrices.filter((x) => x.g === P.O.game);
  assert.equal(bp.length, P.O.packs30);
  for (const x of bp) assert.equal(x.pa, P.O.perAccount[x.size]);
  const single = median(singles.filter((s) => s.p > 0).map((s) => s.p));
  assert.ok(Math.max(...bp.map((x) => x.pa)) < single, "bulk per-account price below the single price");
  const packs = rowsOf(small, P.O.game).filter((L) => L.kind === "bulk");
  assert.ok(packs.length === P.O.packs30 + 1 && packs.every((L) => P.O.packSizes.includes(L.pack)));
  assert.ok(!small.sales.some((s) => packs.some((L) => L.id === s.lid)), "pack sales are never single sales");
  assert.ok(small.demandOnly.some((d) => d.g === P.O.game && d.src === "bulk-order"));
});

test("P: a no-claim row rebundled mid-window, with sales before and after", () => {
  const L = rowsOf(small, P.P.game, P.P.market).find((x) => x.rb != null);
  assert.ok(L && L.o === "unclaimed" && L.st === "active" && L.p === P.P.after.p);
  assert.ok(Math.abs((small.now - L.rb) / DAY - P.P.rbDaysAgo) < 0.01);
  const sales = small.sales.filter((s) => s.lid === L.id);
  const before = sales.filter((s) => s.t < L.rb);
  const after = sales.filter((s) => s.t >= L.rb);
  assert.equal(before.length, P.P.before.n);
  assert.equal(after.length, P.P.after.n);
  assert.ok(before.every((s) => s.p === P.P.before.p && s.ck === L.ck && s.basis === "paid" && s.src === "unclaimed"));
  assert.ok(after.every((s) => s.p === P.P.after.p));
  assert.equal(
    median(sales.map((s) => s.p)),
    P.P.expectRef.leakWouldGive,
    "with the before-sales the median would be wrong",
  );
  assert.equal(median(after.map((s) => s.p)), P.P.expectRef.value);
  assert.equal(rowsOf(small, P.P.game, P.P.market).filter((x) => x.ck === L.ck).length, 1, "the only row of its offer");
});

test("Q: a no-claim ladder on Gameflip — the auto-lister's row beside hand-made rows of the same offer", () => {
  const live = rowsOf(small, P.Q.game, P.Q.market).filter((L) => L.st === "active");
  const ck = live.find((L) => L.o === "manual" && L.p === P.Q.manualPrices[1]).ck;
  const rungs = live.filter((L) => L.ck === ck);
  assert.ok(rungs.every((L) => L.f === "noclaim"));
  assert.deepEqual(
    rungs.filter((L) => L.o === "unclaimed").map((L) => L.p),
    [P.Q.autoPrice],
  );
  assert.deepEqual(
    rungs
      .filter((L) => L.o === "manual")
      .map((L) => L.p)
      .sort((a, b) => a - b),
    P.Q.manualPrices,
  );
  assert.equal(small.sales.filter((s) => s.ck === ck && s.o === "unclaimed").length, P.Q.autoSold);
  assert.ok(small.sales.some((s) => s.ck === ck && s.o === "manual"));
});

test("R: an explicit no-claim cap for one game, the default for the others", () => {
  assert.deepEqual(small.af.caps, P.R.explicit);
  assert.equal(small.af.capDefault, P.R.capDefault);
  assert.equal(small.af.caps[P.R.defaultGame], undefined);
  const noclaim = small.demand.filter((d) => d.f === "noclaim").map((d) => d.k);
  assert.ok(
    noclaim.every((k) => k.includes("omega")),
    "no-claim games fall in the 'omega' bucket",
  );
  assert.ok(small.demand.filter((d) => d.f === "claim").every((d) => !d.k.includes("omega")));
  assert.ok(
    small.listings.filter((L) => L.o === "unclaimed").every((L) => ["gameflip", "digiseller", "ggsel"].includes(L.m)),
  );
});

test("extras: GGSel hidden minimum, an unmapped G2G game, an unwatched game, the old side", () => {
  const gg = rowsOf(small, P.V.game, "ggsel");
  assert.ok(gg.length && gg.every((L) => L.vmin === P.V.vmin && L.p >= P.V.vmin));
  assert.equal(small.af.mapped[P.U.game].g2g, false);
  assert.equal(rowsOf(small, P.U.game, "g2g").length, 0);
  for (const g of P.unwatched)
    assert.ok(!small.radar.games.some((r) => r.key === g) && !small.radar.feed.some((r) => r.g === g));
  // old.games for every claim game with stock or a live auto row; old.offers for every system-made offer.
  const claimGames = new Set(small.listings.filter((L) => L.f === "claim" && L.o === "auto").map((L) => L.g));
  for (const g of claimGames) assert.ok(small.old.games[g], g);
  for (const L of small.listings.filter((x) => x.kind === "single" && (x.o === "auto" || x.o === "unclaimed"))) {
    assert.ok(small.old.offers[L.m + "|" + L.ck], L.m + "|" + L.ck);
  }
  // Eldorado multi-unit orders, an account listing, hand and shop demand: the other record kinds are present.
  assert.ok(small.listings.some((L) => L.kind === "account"));
  assert.ok(small.demandOnly.some((d) => d.src === "shop"));
});
