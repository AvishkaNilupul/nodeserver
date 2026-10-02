// The market radar's two hooks into LIVE code (scripts/apply-market-radar-hooks.js):
//   utils/priceScout.js     — additive row fields + an explicit `complete` flag on a Gameflip page;
//   utils/marketResearch.js — one guarded tap() inside scanGame.
// What must hold:
//   - the patcher is all-or-nothing and idempotent;
//   - the scouts' rows keep every field they had (consumers are unchanged) and gain the new ones;
//   - `complete` is set only by a successful read that came back under the page limit — a failed
//     fetch (which the scanner turns into []) must never look like "a full page with no rivals";
//   - the scan calls tap() with exactly the rows it scored, and a scan's RESULT is byte-identical
//     whether the radar is on, off, or throwing.
// RESEARCH_PATH / SCOUT_PATH point the same tests at a patched copy of another checkout.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const hooks = require("../scripts/apply-market-radar-hooks");
const ROOT = path.join(__dirname, "..");
// The file as it was BEFORE its hook: the current file with every hunk reversed (each new block
// must occur exactly once). Works whether or not the hooks are committed yet.
const pristineOf = (rel, hunks, marker) => {
  let s = fs.readFileSync(path.join(ROOT, rel), "utf8");
  if (!s.includes(marker)) return s;
  for (const h of hunks) {
    assert.strictEqual(s.split(h.new).length - 1, 1, rel + ": hook block '" + h.label + "' must occur exactly once");
    s = s.replace(h.new, () => h.old);
  }
  return s;
};

/* --------------------------------- the patcher --------------------------------- */

test("the patcher applies to the pristine files, is idempotent, and is all-or-nothing", () => {
  const scout = pristineOf("utils/priceScout.js", hooks.SCOUT_HUNKS, hooks.SCOUT_MARKER);
  const research = pristineOf("utils/marketResearch.js", hooks.TAP_HUNKS, hooks.TAP_MARKER);
  assert.ok(!scout.includes(hooks.SCOUT_MARKER) && !research.includes(hooks.TAP_MARKER), "really pristine");
  // and the committed files are exactly pristine + hooks (nothing else edited by hand)
  assert.strictEqual(hooks.applyHunks(scout, hooks.SCOUT_HUNKS, hooks.SCOUT_MARKER).src, fs.readFileSync(path.join(ROOT, "utils/priceScout.js"), "utf8"));
  assert.strictEqual(hooks.applyHunks(research, hooks.TAP_HUNKS, hooks.TAP_MARKER).src, fs.readFileSync(path.join(ROOT, "utils/marketResearch.js"), "utf8"));
  const a = hooks.applyHunks(scout, hooks.SCOUT_HUNKS, hooks.SCOUT_MARKER);
  assert.strictEqual(a.status, "applied");
  assert.strictEqual(hooks.applyHunks(a.src, hooks.SCOUT_HUNKS, hooks.SCOUT_MARKER).status, "already");
  const b = hooks.applyHunks(research, hooks.TAP_HUNKS, hooks.TAP_MARKER);
  assert.strictEqual(b.status, "applied");
  assert.strictEqual(hooks.applyHunks(b.src, hooks.TAP_HUNKS, hooks.TAP_MARKER).status, "already");
  // a missing anchor: refused, nothing changed
  const broken = scout.replace("sold: Number(o.cnt_sell) || 0,", "sold: Number(o.cnt_sell),");
  const r = hooks.applyHunks(broken, hooks.SCOUT_HUNKS, hooks.SCOUT_MARKER);
  assert.strictEqual(r.status, "refused");
  assert.strictEqual(r.src, broken);
  assert.match(r.problems.join(" "), /ggsel rows: anchor matches 0/);
  // a duplicated anchor: refused
  const twice = research + "\n" + hooks.TAP_HUNKS[0].old;
  assert.strictEqual(hooks.applyHunks(twice, hooks.TAP_HUNKS, hooks.TAP_MARKER).status, "refused");
  // the patch only ADDS lines (nothing the old code did is removed or reworded)
  // counted as a multiset: a line that also occurs elsewhere must not hide its removal here
  const removed = (before, after) => {
    const left = new Map();
    for (const l of after.split("\n")) left.set(l, (left.get(l) || 0) + 1);
    const out = [];
    for (const l of before.split("\n")) {
      if (left.get(l)) left.set(l, left.get(l) - 1);
      else out.push(l);
    }
    return out;
  };
  assert.deepStrictEqual(removed(research, b.src), []);
  assert.deepStrictEqual(removed(scout, a.src), ["  return rows"], "only gameflipSearch's `return rows` became `const out = rows` + `return out`");
});

/* --------------------------------- the scouts --------------------------------- */

function loadScout(fake) {
  const scoutPath = require.resolve(process.env.SCOUT_PATH || "../utils/priceScout");
  const remotePath = require.resolve("../utils/remoteHttp");
  const orig = Module._load;
  Module._load = function (request, parent, isMain) {
    try {
      if (Module._resolveFilename(request, parent, isMain) === remotePath) return fake;
    } catch {
      /* fall through */
    }
    return orig.apply(this, arguments);
  };
  delete require.cache[scoutPath];
  try {
    return require(scoutPath);
  } finally {
    Module._load = orig;
    delete require.cache[scoutPath];
  }
}

const gfApi = (n) => ({
  data: {
    data: Array.from({ length: n }, (_, i) => ({
      id: "gf-" + i,
      name: "Alpha Twitch Drops (3 Items) — X",
      price: 125 + i,
      owner: "owner-" + (i % 3),
      created: "2026-09-30T00:00:00.000Z",
      onsale: "2026-09-30T00:00:10.000Z",
      updated: "2026-10-01T00:00:00.000Z",
      platform: "pc",
      seller_score: 0.9,
      seller_rating_score: 0.95,
      seller_ratings: i === 0 ? null : 120,
    })),
  },
});

test("Gameflip rows keep their old fields, gain the radar's, and say whether the page was complete", async () => {
  let calls = 0;
  const scout = loadScout({ fetchJson: async (_u, o) => (calls++, gfApi(o.params.limit === 100 ? 3 : 0)) });
  const rows = await scout.gameflipScout("alpha twitch drops");
  assert.strictEqual(calls, 1, "still exactly one request");
  assert.strictEqual(rows.length, 3);
  const r = rows[0];
  for (const k of ["title", "price", "url", "updated", "seller", "sellerName"]) assert.ok(k in r, "old field kept: " + k);
  assert.strictEqual(r.price, 1.25);
  assert.strictEqual(r.url, "https://gameflip.com/item/gf-0");
  assert.strictEqual(r.id, "gf-0");
  assert.strictEqual(r.onsale, "2026-09-30T00:00:10.000Z");
  assert.strictEqual(r.created, "2026-09-30T00:00:00.000Z");
  assert.strictEqual(r.sellerScore, 0.9);
  assert.strictEqual(r.sellerRating, 0.95);
  assert.strictEqual(r.sellerRatings, null, "an absent count is unknown, not zero");
  assert.strictEqual(rows[1].sellerRatings, 120);
  assert.strictEqual(rows.complete, true, "3 rows under a 100 limit: the page is everything");
  assert.ok(!Object.keys(rows).includes("complete") && !JSON.stringify(rows).includes("complete"), "the flag is invisible to serialisation");
});

test("a FULL Gameflip page is not complete, and a failed or empty-on-error fetch never carries the flag", async () => {
  const full = loadScout({ fetchJson: async () => gfApi(100) });
  assert.strictEqual((await full.gameflipScout("x")).complete, false);
  const sold = loadScout({ fetchJson: async () => gfApi(5) });
  assert.strictEqual((await sold.gameflipSoldScout("x", 5)).complete, false, "5 of limit 5: maybe more");
  const failing = loadScout({ fetchJson: async () => { throw new Error("timeout"); } });
  await assert.rejects(() => failing.gameflipScout("x"));
  // what the scanner does with a failure: settle(p) -> [] — no flag, so nothing is ever marked gone
  const settled = await failing.gameflipScout("x").then((v) => v, () => []);
  assert.strictEqual(settled.complete, undefined);
  // the Pi relays with `curl -sL` (no --fail): a 429 comes back as a JSON body with no data array.
  // It parses, it yields no rows — and it must NOT read as "a complete page with no rivals".
  const throttled = loadScout({ fetchJson: async () => ({ data: { message: "Too many attempts", code: 429 }, via: "pi" }) });
  const rows = await throttled.gameflipScout("x");
  assert.deepStrictEqual(rows, []);
  assert.strictEqual(rows.complete, false);
  const weird = loadScout({ fetchJson: async () => ({ data: { data: null } }) });
  assert.strictEqual((await weird.gameflipScout("x")).complete, false);
  const html = loadScout({ fetchJson: async () => ({ data: "<html>502 Bad Gateway</html>" }) });
  assert.strictEqual((await html.gameflipScout("x")).complete, false);
});

test("GGSel and Plati rows keep their fields and gain id / rating / counters", async () => {
  const html = '<script>window.__NUXT__={"x":[{"id_goods":5367595,"url":"marvel-5367595","is_active":true,"id_seller":751257,"seller_name":"el9in","name":"Marvel Rivals Twitch Drops 143 items","price_wmz":"8.38","price_wmr":"700","cnt_sell":2,"rating":4.9,"autoselling":true},{"id_goods":7,"is_active":true,"id_seller":1,"seller_name":"b","name":"x twitch drops","price_wmz":"0","cnt_sell":0}]}</script>';
  const plati = { data: { items: [
    { id: 4773868, name_eng: "Marvel Rivals | TWITCH DROPS | 148 ITEMS", price_usd: 2.27, price_rur: 189, url: "https://plati.market/itm/4773868", seller_id: 1053014, seller_name: "DerkeShop", seller_rating: 10.2345, numsold: 176, numsold_hidden: 100, count_positiveresponses: 1, count_negativeresponses: 0, count_returns: 0, TicksLastChange: 843936933 },
    { id: 5, name_eng: "no counter on this one", price_usd: 1, url: "https://plati.market/itm/5", seller_id: 1, seller_name: "x" },
  ] } };
  const scout = loadScout({ fetchText: async () => ({ text: html }), fetchJson: async () => plati });
  const gg = await scout.ggselScout("marvel rivals twitch drops");
  assert.strictEqual(gg.length, 1, "a zero-priced product is still dropped, as before");
  assert.deepStrictEqual(
    { title: gg[0].title, price: gg[0].price, seller: gg[0].seller, sellerName: gg[0].sellerName, sold: gg[0].sold, id: gg[0].id, rating: gg[0].rating, autoselling: gg[0].autoselling, soldRaw: gg[0].soldRaw, priceRub: gg[0].priceRub },
    { title: "Marvel Rivals Twitch Drops 143 items", price: 8.38, seller: "751257", sellerName: "el9in", sold: 2, id: "5367595", rating: 4.9, autoselling: true, soldRaw: 2, priceRub: 700 },
  );
  const pl = await scout.platiScout("marvel rivals twitch drops");
  assert.deepStrictEqual(
    { title: pl[0].title, price: pl[0].price, seller: pl[0].seller, sold: pl[0].sold, id: pl[0].id, rating: pl[0].rating, soldHidden: pl[0].soldHidden, positive: pl[0].positive, negative: pl[0].negative, returns: pl[0].returns, ticks: pl[0].ticks, soldRaw: pl[0].soldRaw, priceRub: pl[0].priceRub },
    { title: "Marvel Rivals | TWITCH DROPS | 148 ITEMS", price: 2.27, seller: "1053014", sold: 176, id: "4773868", rating: 10.2345, soldHidden: 100, positive: 1, negative: 0, returns: 0, ticks: 843936933, soldRaw: 176, priceRub: 189 },
  );
  // a product with no counter: `sold` is the old 0 (consumers unchanged), `soldRaw` says unknown
  assert.deepStrictEqual([pl[1].sold, pl[1].soldRaw], [0, null]);
});

/* ------------------------------ the scanner's tap ------------------------------ */

function emptyQuery(value = []) {
  const q = {
    then: (res, rej) => Promise.resolve(value).then(res, rej),
    catch: (rej) => Promise.resolve(value).catch(rej),
  };
  for (const m of ["lean", "sort", "limit", "skip", "select", "populate"]) q[m] = () => q;
  return q;
}
function emptyModel(over = {}) {
  return new Proxy(over, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === "then") return undefined;
      return () => emptyQuery();
    },
  });
}

// One clock for every harness load, so two scans of the same rows are comparable (and the sold
// row is always inside the scanner's 30-day window, whatever the date the suite runs on).
const NOW0 = Date.now();
const SOLD_AT = new Date(NOW0 - 3600e3).toISOString();

function loadResearch({ tap }) {
  const world = { updates: [], taps: [] };
  const rows = {
    sold: [{ title: "Alpha Twitch Drops (3 Items)", price: 1.5, url: "https://gameflip.com/item/s1", updated: SOLD_AT, seller: "riv", sellerName: "", id: "s1" }],
    active: Object.defineProperty(
      [
        { title: "Alpha Twitch Drops (3 Items)", price: 1.25, url: "https://gameflip.com/item/a1", seller: "riv", sellerName: "", id: "a1" },
        { title: "Alpha Twitch Drops (3 Items)", price: 0.9, url: "https://gameflip.com/item/a2", seller: "OURS", sellerName: "", id: "a2" },
        { title: "Something else entirely", price: 9, url: "https://gameflip.com/item/a3", seller: "riv", sellerName: "", id: "a3" },
      ],
      "complete",
      { value: true, enumerable: false },
    ),
    gg: [{ title: "Alpha Twitch Drops 3 items", price: 0.8, url: "u/10", seller: "g", sellerName: "G", sold: 5, id: "10" }],
    pl: [{ title: "Alpha twitch drops", price: 1.1, url: "u/20", seller: "p", sellerName: "P", sold: 9, id: "20" }],
  };
  const stubs = new Map([
    [require.resolve("../utils/priceScout"), {
      gameflipScout: async () => rows.active,
      gameflipSoldScout: async () => rows.sold,
      ggselScout: async () => rows.gg,
      platiScout: async () => rows.pl,
      funpayScout: async () => [],
    }],
    [require.resolve("../utils/marketplaces"), { gameflipOwnerId: async () => "OURS", usdRate: async () => 1 }],
    [require.resolve("../utils/settings"), { getAutoFarm: () => ({}), isNoClaimGame: () => false }],
    [require.resolve("../utils/marketData"), { tap: (input) => (world.taps.push(input), tap ? tap(input) : true) }],
    [require.resolve("../models/MarketResearch"), emptyModel({ updateOne: async (f, u) => (world.updates.push(u.$set), {}), findOne: () => emptyQuery(null) })],
  ]);
  for (const m of ["DropLog", "DropSet", "MarketplaceListing", "MarketResearchSnapshot", "SaleSignal", "TwitchCampaign", "UnclaimedAccount"]) stubs.set(require.resolve("../models/" + m), emptyModel());
  const orig = Module._load;
  Module._load = function (request, parent, isMain) {
    try {
      const r = Module._resolveFilename(request, parent, isMain);
      if (stubs.has(r)) return stubs.get(r);
    } catch {
      /* fall through */
    }
    return orig.apply(this, arguments);
  };
  const p = require.resolve(process.env.RESEARCH_PATH || "../utils/marketResearch");
  delete require.cache[p];
  const research = require(p);
  const restore = () => {
    Module._load = orig;
    delete require.cache[p];
  };
  return { research, world, restore };
}

test("a scan hands the radar exactly the rows it scored, our owner id, and whether the page was complete", async () => {
  const { research, world, restore } = loadResearch({});
  try {
    await research.refreshGame("Alpha");
    assert.strictEqual(world.taps.length, 1);
    const t = world.taps[0];
    assert.strictEqual(t.game, "Alpha");
    assert.strictEqual(t.ownGf, "OURS");
    assert.strictEqual(t.gfActiveComplete, true);
    assert.deepStrictEqual(t.gfActive.map((r) => r.id), ["a1", "a2"], "the irrelevant row was filtered out, ours kept");
    assert.deepStrictEqual(t.gfSold.map((r) => r.id), ["s1"]);
    assert.deepStrictEqual(t.gg.map((r) => r.id), ["10"]);
    assert.deepStrictEqual(t.pl.map((r) => r.id), ["20"]);
    assert.ok(t.at instanceof Date);
  } finally {
    restore();
  }
});

test("the scan's RESULT is identical whether the radar is on, off, or throwing", async () => {
  const run = async (tap) => {
    const { research, world, restore } = loadResearch({ tap });
    try {
      const realNow = Date.now;
      const frozen = NOW0;
      Date.now = () => frozen;
      try {
        await research.refreshGame("Alpha");
      } finally {
        Date.now = realNow;
      }
      const doc = { ...world.updates[0] };
      delete doc.scannedAt;
      return JSON.stringify(doc);
    } finally {
      restore();
    }
  };
  const on = await run(() => true);
  const off = await run(() => false);
  const boom = await run(() => {
    throw new Error("recorder exploded");
  });
  assert.ok(on.length > 50, "the scan produced a research document");
  assert.strictEqual(off, on);
  assert.strictEqual(boom, on, "a throwing recorder changes nothing about the scan");
});
