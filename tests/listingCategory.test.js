// The failure these tests exist to prevent: a Twitch-drop bundle filed under
// the wrong game — or a superadmin's modal hanging for minutes on a cold GGSel
// cache.
//
// utils/listingCategory.js answers "where does this listing go on this
// marketplace" for ten markets at once, and the temptation in a module like
// that is to make every market answer the same way. It must not. There are
// THREE different kinds of "no answer" and collapsing them is how a Twitch
// drops bundle ends up on another game's shelf:
//
//   GGSel   — a miss means "use the configured default category". Falling back
//             is correct; the section is per-game but the default is ours.
//   G2G     — a miss means NOT_LISTABLE (utils/g2gGames.js:560). Overwatch and
//             Siege have no creatable Game Items product at all, so there is
//             nothing to fall back TO. Picking "the nearest brand" is exactly
//             how the account's Siege bundles ended up under Rainbow Six
//             Mobile. ok:false, and the owner picks by hand.
//   PA      — a miss means the game exists but has no item leaf. Publishing
//             anyway earns "Invalid Item Name" against a live offer.
//
// The other half is the clock. mp.ggselCategoryHistory (marketplaces.js:2048)
// is a SERIAL loop of awaited axios calls at 20s each over up to 100 offers,
// and this module is called on every modal open. Unbounded, one cold cache
// holds a superadmin HTTP request open for minutes. So: every lookup races a
// timer, a lost race is a miss (not an error), and a MISS IS CACHED TOO —
// without that, an unmapped game name re-enters the serial loop every single
// time the modal opens.
//
// Everything here injects deps. utils/marketplaces.js — which owns every live
// API key — is never loaded, and no test touches the network. The two deps
// that ARE the real module (utils/g2gGames, utils/epicnpcCatalog) are pure
// lookup tables: stubbing them would only test the stub, and NOT_LISTABLE is
// the whole point.
const test = require("node:test");
const assert = require("node:assert");

const {
  resolveCategory,
  RESOLVE_TIMEOUT_MS,
  MARKETS_NEEDING_CATEGORY,
  CACHE_TTL_MS,
  MISS_TTL_MS,
  clearCache,
} = require("../utils/listingCategory");
const g2gGames = require("../utils/g2gGames");
const epicnpc = require("../utils/epicnpcCatalog");

// Injected deps are VALUES, not factories — makeCtx returns them verbatim
// (utils/listingCategory.js:72) and only REAL_DEPS entries are called.
const settingsWith = (autoFarm) => ({ getAutoFarm: () => autoFarm });

// Counts calls so "the cache served it" is proved by the dep NOT running,
// rather than by timing.
function counting(fn) {
  const wrapped = (...args) => {
    wrapped.calls.push(args);
    return fn(...args);
  };
  wrapped.calls = [];
  return wrapped;
}

// A lookup that never settles. Deliberately not a long setTimeout: a pending
// timer would keep the test runner alive for its full duration even after the
// assertion passed.
const hangs = () => new Promise(() => {});

// The clock tests get their own hard deadline. Without it, a regression that
// drops the timeout does not FAIL — it hangs, and `npm test` stalls forever
// instead of going red. Proved by mutation: removing withTimeout from
// utils/listingCategory.js:165 hung the whole run.
const CLOCK = { timeout: 5000 };

// Real shapes, copied from the live callers on 2026-09-10.
const PLATI_ATTRS = [{ attributeId: 91328, attributeValueId: 183570 }];
const ZEUSX_BASE = {
  serviceCategoryId: "1",
  serviceCategoryBaseId: "269",
  gameId: "3300",
  name: "Rust",
};
const PA_GAME = { gameId: "1046", gameName: "Rust", productType: "Item,Account" };
const PA_LEAF = {
  rootItem: 55,
  rootName: "Skins",
  itemId: 77,
  itemName: "Twitch Drops",
  itemPath: "55|77",
};

/* ------------------------------ the surface ------------------------------ */

test("the exported surface is the one the publish route was promised", () => {
  assert.strictEqual(RESOLVE_TIMEOUT_MS, 8000);
  assert.deepStrictEqual(MARKETS_NEEDING_CATEGORY, [
    "ggsel",
    "digiseller",
    "funpay",
    "g2g",
  ]);
});

/* --------------------------- a hit, every market -------------------------- */

// One row per marketplace in the contract's table. `noCache` keeps each row
// independent of the module-level cache, which the cache tests below own.
const HITS = [
  {
    market: "ggsel",
    game: "Rust",
    deps: {
      marketplaces: { ggselResolveCategoryId: async () => 32450 },
      settings: settingsWith({}),
    },
    // The live lookup returns a number; the publish body needs a string.
    value: { categoryId: "32450" },
    source: "search",
  },
  {
    market: "digiseller",
    game: "Rust",
    deps: {
      settings: settingsWith({
        platiCategoryId: "34187",
        platiAttributes: PLATI_ATTRS,
      }),
    },
    // Without the Content-type attribute Plati refuses the create with
    // "you can not add goods", so the attributes must ride along.
    value: {
      categories: [
        { owner: 1, categoryId: "34187", attributes: PLATI_ATTRS },
      ],
    },
    source: "settings",
  },
  {
    market: "funpay",
    game: "Rainbow Six Siege",
    // The settings key is the full Twitch spelling and the listing's game is
    // the short one: the normaliser is what bridges them.
    deps: {
      settings: settingsWith({
        funpayNodes: { "Tom Clancy's Rainbow Six Siege": " 1135 " },
      }),
    },
    // `node` is the contract's name, `nodeId` is what the publish route reads
    // (routes/marketplaceRoutes.js:622, :1116). Both must be present.
    value: { node: "1135", nodeId: "1135" },
    source: "settings",
  },
  {
    market: "g2g",
    game: "World of Tanks",
    deps: { g2gGames },
    value: {
      serviceId: g2gGames.G2G_ITEMS_SERVICE,
      brandId: "lgc_game_22932",
      seoTerm: "world-of-tanks-item",
    },
    source: "catalog",
  },
  {
    market: "zeusx",
    game: "Rust",
    deps: {
      marketplaces: { zeusxResolveCategory: async () => ZEUSX_BASE },
      settings: settingsWith({}),
    },
    value: {
      serviceCategoryId: "1",
      serviceCategoryBaseId: "269",
      gameId: "3300",
    },
    source: "search",
  },
  {
    market: "eldorado",
    game: "Rust",
    deps: {},
    // Eldorado has a native Twitch Drops node pinned inside eldoradoPublish;
    // there is nothing per-game to send.
    value: {},
    source: "static",
  },
  {
    market: "gameflip",
    game: "Rust",
    deps: {},
    // Empty on purpose: an auto-delivered code MUST stay category UNKNOWN
    // (marketplaces.js:313), so overriding gameflipPublish from here would
    // break auto-delivery.
    value: {},
    source: "static",
  },
  {
    market: "playerauctions",
    game: "Rust",
    deps: {
      marketplaces: {
        playerauctionsResolveGame: async () => PA_GAME,
        playerauctionsPickItemPath: async () => PA_LEAF,
      },
    },
    value: { gameId: "1046", itemId: 77, itemPath: "55|77", rootItem: 55 },
    source: "catalog",
  },
  {
    market: "epicnpc",
    game: "Rust",
    deps: { epicnpc },
    value: { node: 303 },
    source: "static",
  },
  {
    market: "z2u",
    game: "Rust",
    deps: {
      marketplaces: {
        z2uGroups: async () => [
          { service: "13", game: "8801", label: "Rust Items", offers: 5 },
        ],
        z2uGameOptions: async () => ({ gameName: "Rust", service: "13" }),
      },
    },
    // The numeric ids ride along because service + gameName alone cannot
    // address the group again.
    value: { gameName: "Rust", service: "13", game: "8801" },
    source: "catalog",
  },
];

for (const row of HITS) {
  test(row.market + ": a hit carries the placement the publish body needs", async () => {
    const r = await resolveCategory(row.market, row.game, {
      deps: row.deps,
      noCache: true,
    });
    assert.strictEqual(r.ok, true, r.reason);
    assert.strictEqual(r.marketplace, row.market);
    assert.deepStrictEqual(r.value, row.value);
    assert.strictEqual(r.source, row.source);
    assert.strictEqual(r.reason, "");
    assert.ok(r.label, "a hit must carry a human-readable placement");
  });
}

/* -------------------------- a miss, every market -------------------------- */

const MISSES = [
  {
    market: "ggsel",
    game: "Game GGSel Never Heard Of",
    // No live category AND no configured default: only now is it a refusal.
    deps: {
      marketplaces: { ggselResolveCategoryId: async () => "" },
      settings: settingsWith({}),
    },
    reason: /no Twitch Drops category/,
  },
  {
    market: "digiseller",
    game: "Rust",
    // getAutoFarm() back-fills platiCategoryId (utils/settings.js:431-434), so
    // this branch is only reachable when settings itself is unreadable — which
    // is exactly what autoFarm() degrades to (listingCategory.js:179).
    deps: { settings: settingsWith({}) },
    reason: "No Plati category configured in Auto-farm settings",
  },
  {
    market: "funpay",
    game: "Rust",
    deps: { settings: settingsWith({ funpayNodes: { "Albion Online": "1" } }) },
    reason: "No FunPay node mapped for Rust",
  },
  {
    market: "g2g",
    game: "Overwatch",
    deps: { g2gGames },
    reason: "G2G does not list Overwatch",
  },
  {
    market: "zeusx",
    game: "Game ZeusX Never Heard Of",
    deps: {
      marketplaces: { zeusxResolveCategory: async () => null },
      settings: settingsWith({}),
    },
    reason: /in its Accounts catalog/,
  },
  {
    market: "playerauctions",
    game: "Rust",
    deps: {
      marketplaces: {
        playerauctionsResolveGame: async () => null,
        playerauctionsPickItemPath: async () => PA_LEAF,
      },
    },
    reason: /has no game matching Rust/,
  },
  {
    market: "epicnpc",
    game: "Totally Not A Game 9000",
    deps: { epicnpc },
    reason: /has no forum/,
  },
  {
    market: "z2u",
    game: "Rust",
    deps: { marketplaces: { z2uGroups: async () => [] } },
    reason: /no seller group/,
  },
];

for (const row of MISSES) {
  test(row.market + ": a miss refuses with a reason instead of guessing", async () => {
    const r = await resolveCategory(row.market, row.game, {
      deps: row.deps,
      noCache: true,
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.marketplace, row.market);
    // A refusal must carry NO placement — a half-filled value merged into a
    // publish body is how an offer lands in the wrong section.
    assert.deepStrictEqual(r.value, {});
    assert.strictEqual(r.label, "");
    if (row.reason instanceof RegExp) assert.match(r.reason, row.reason);
    else assert.strictEqual(r.reason, row.reason);
  });
}

test("eldorado and gameflip cannot miss, not even with no game at all", async () => {
  // Both are static, so an un-hydrated light list row (set.items undefined,
  // no coverGame) must still resolve rather than blocking the publish.
  for (const market of ["eldorado", "gameflip"]) {
    const r = await resolveCategory(market, "", { deps: {} });
    assert.strictEqual(r.ok, true, market + " must never miss");
    assert.strictEqual(r.source, "static");
  }
});

test("an unknown marketplace is a miss, never a throw", async () => {
  const r = await resolveCategory("mercadolibre", "Rust", { deps: {} });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /No category resolver for mercadolibre/);
});

test("a resolver that throws is a miss, so the route never 500s", async () => {
  const r = await resolveCategory("g2g", "Rust", {
    deps: {
      g2gGames: {
        brandForGame() {
          throw new Error("catalog file unreadable");
        },
      },
    },
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /catalog file unreadable/);
});

/* ------------------ the three "no answer" semantics differ ---------------- */

test("REGRESSION: the three kinds of 'no answer' stay different", async () => {
  clearCache();

  // 1. GGSel — nothing found live, but a default is configured. Falling back
  //    is CORRECT here: the section is ours, only the per-game shelf is not.
  const gg = await resolveCategory("ggsel", "Game GGSel Never Heard Of", {
    deps: {
      marketplaces: { ggselResolveCategoryId: async () => null },
      settings: settingsWith({ ggselCategoryId: "34188" }),
    },
    noCache: true,
  });
  assert.strictEqual(gg.ok, true, "a GGSel miss falls back, it does not refuse");
  assert.strictEqual(gg.source, "settings");
  assert.deepStrictEqual(gg.value, { categoryId: "34188" });

  // 2. G2G — Overwatch is in NOT_LISTABLE (utils/g2gGames.js:561). There is no
  //    fallback shelf and there must never be a "nearest brand".
  const g2g = await resolveCategory("g2g", "Overwatch", { deps: { g2gGames } });
  assert.strictEqual(g2g.ok, false, "NOT_LISTABLE must refuse, not fall back");
  assert.deepStrictEqual(g2g.value, {});
  assert.strictEqual(g2g.reason, "G2G does not list Overwatch");
  // The refusal is the real catalog's, not a stub's.
  assert.strictEqual(g2gGames.brandForGame("Overwatch"), null);
  assert.ok(g2gGames.NOT_LISTABLE.has("lgc_game_21555"));

  // 3. PlayerAuctions — the game row resolves but the item leaf is null. That
  //    is a deliberate refusal too: a null itemPath published anyway earns
  //    "Invalid Item Name" with a live offer already created.
  const pickItemPath = counting(async () => null);
  const pa = await resolveCategory("playerauctions", "Rust", {
    deps: {
      marketplaces: {
        playerauctionsResolveGame: async () => PA_GAME,
        playerauctionsPickItemPath: pickItemPath,
      },
    },
    noCache: true,
  });
  assert.strictEqual(pa.ok, false);
  assert.deepStrictEqual(pa.value, {});
  assert.match(pa.reason, /No item category found for PlayerAuctions game Rust/);
  assert.strictEqual(pickItemPath.calls.length, 1, "the leaf was really asked for");

  // Same question, three genuinely different answers.
  assert.notStrictEqual(gg.ok, g2g.ok);
  assert.notStrictEqual(g2g.reason, pa.reason);
});

test("a PlayerAuctions game with no Item offers is refused early", async () => {
  // Only ~149 of PA's games accept an Item offer. Asking for a leaf on one
  // that does not is a wasted round trip and a misfiled listing.
  const pickItemPath = counting(async () => PA_LEAF);
  const r = await resolveCategory("playerauctions", "Rust", {
    deps: {
      marketplaces: {
        playerauctionsResolveGame: async () => ({
          ...PA_GAME,
          productType: "Account,Currency",
        }),
        playerauctionsPickItemPath: pickItemPath,
      },
    },
    noCache: true,
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /does not accept Item offers \(allowed: Account,Currency\)/);
  assert.strictEqual(pickItemPath.calls.length, 0, "no leaf lookup once refused");
});

test("a pinned ZeusX category wins and skips the network entirely", async () => {
  // The operator's own zeusxGames map is them saying "this one, I mean it" —
  // and it is also the only ZeusX path that costs nothing.
  const live = counting(async () => ZEUSX_BASE);
  const r = await resolveCategory("zeusx", "Rust", {
    deps: {
      marketplaces: { zeusxResolveCategory: live },
      settings: settingsWith({
        zeusxGames: {
          rust: { serviceCategoryId: "1", serviceCategoryBaseId: "901", gameId: "77" },
        },
      }),
    },
    noCache: true,
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.serviceCategoryBaseId, "901");
  assert.strictEqual(r.source, "settings");
  assert.strictEqual(live.calls.length, 0, "a pinned category must not hit ZeusX");
});

/* -------------------------------- the clock ------------------------------- */
test(
  "REGRESSION: a hanging GGSel lookup is cut off and falls back, not hung",
  CLOCK,
  async () => {
    // The cold-cache trap. ggselCategoryHistory is a serial loop of 20s axios
    // calls over up to 100 offers, and this runs on every modal open.
    clearCache();
    const started = Date.now();
    const r = await resolveCategory("ggsel", "Hanging Game", {
      timeoutMs: 25,
      deps: {
        marketplaces: { ggselResolveCategoryId: hangs },
        settings: settingsWith({ ggselCategoryId: "34187" }),
      },
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, "the lookup was bounded, took " + elapsed + "ms");
    assert.ok(elapsed < RESOLVE_TIMEOUT_MS, "the per-call budget was honoured");
    // A timeout is a MISS, not an error: the settings default still publishes.
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.source, "settings");
    assert.deepStrictEqual(r.value, { categoryId: "34187" });
  },
);

test(
  "a hanging ZeusX lookup is reported as a miss, since it has no fallback",
  CLOCK,
  async () => {
    clearCache();
    const started = Date.now();
    const r = await resolveCategory("zeusx", "Hanging Game", {
      timeoutMs: 25,
      deps: {
        marketplaces: { zeusxResolveCategory: hangs },
        settings: settingsWith({}),
      },
    });
    assert.ok(Date.now() - started < 2000);
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(
      r.value,
      {},
      "a timeout must not half-fill a placement",
    );
    assert.match(r.reason, /in its Accounts catalog/);
  },
);

test(
  "a hanging PlayerAuctions game lookup never reaches the item lookup",
  CLOCK,
  async () => {
    clearCache();
    const pickItemPath = counting(async () => PA_LEAF);
    const started = Date.now();
    const r = await resolveCategory("playerauctions", "Hanging Game", {
      timeoutMs: 25,
      deps: {
        marketplaces: {
          playerauctionsResolveGame: hangs,
          playerauctionsPickItemPath: pickItemPath,
        },
      },
    });
    assert.ok(Date.now() - started < 2000);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(
      pickItemPath.calls.length,
      0,
      "a timed-out first half must not start the second",
    );
  },
);

/* -------------------------------- the cache ------------------------------- */

test("a resolved category is cached, so the second call is free", async () => {
  clearCache();
  const lookup = counting(async () => "32450");
  const deps = {
    marketplaces: { ggselResolveCategoryId: lookup },
    settings: settingsWith({}),
  };
  const first = await resolveCategory("ggsel", "Cached Game", { deps });
  const second = await resolveCategory("ggsel", "Cached Game", { deps });
  assert.strictEqual(lookup.calls.length, 1, "the second call must be served cold");
  assert.strictEqual(second.ok, true);
  assert.deepStrictEqual(second.value, first.value);

  // The key is case-folded, because the same game arrives spelled both ways
  // from DropLog.game and from a hand-typed offer.
  const third = await resolveCategory("ggsel", "cached game", { deps });
  assert.strictEqual(lookup.calls.length, 1);
  assert.deepStrictEqual(third.value, first.value);
});

test("REGRESSION: a MISS is cached too, or the loop runs on every open", async () => {
  // This is the half that actually protects the request. Without it, a game
  // GGSel has never heard of costs the full history crawl on EVERY modal open.
  clearCache();
  const lookup = counting(async () => "");
  const deps = {
    marketplaces: { ggselResolveCategoryId: lookup },
    settings: settingsWith({}),
  };
  const first = await resolveCategory("ggsel", "Unknown Game", { deps });
  const second = await resolveCategory("ggsel", "Unknown Game", { deps });
  assert.strictEqual(first.ok, false);
  assert.strictEqual(second.ok, false);
  assert.strictEqual(lookup.calls.length, 1, "the miss must be remembered too");
  assert.strictEqual(second.reason, first.reason);
});

test("two simultaneous modal opens share one lookup", async () => {
  clearCache();
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const lookup = counting(async () => {
    await gate;
    return "32450";
  });
  const deps = {
    marketplaces: { ggselResolveCategoryId: lookup },
    settings: settingsWith({}),
  };
  const both = Promise.all([
    resolveCategory("ggsel", "Concurrent Game", { deps }),
    resolveCategory("ggsel", "Concurrent Game", { deps }),
  ]);
  release();
  const [a, b] = await both;
  assert.strictEqual(lookup.calls.length, 1, "the second open waits on the first");
  assert.deepStrictEqual(a.value, { categoryId: "32450" });
  assert.deepStrictEqual(b.value, a.value);
});

test("noCache re-asks, so a manual retry is never served a stale refusal", async () => {
  clearCache();
  const lookup = counting(async () => "");
  const deps = {
    marketplaces: { ggselResolveCategoryId: lookup },
    settings: settingsWith({}),
  };
  await resolveCategory("ggsel", "Retried Game", { deps });
  await resolveCategory("ggsel", "Retried Game", { deps, noCache: true });
  assert.strictEqual(lookup.calls.length, 2);
});

test("settings-backed markets are never cached: a fix shows at once", async () => {
  // The owner reads "No FunPay node mapped for Rust", adds the node, reopens
  // the modal. A cached miss would show the same refusal for five more
  // minutes for no saving at all — the read is a local file.
  clearCache();
  const autoFarm = { funpayNodes: {} };
  const deps = { settings: { getAutoFarm: () => autoFarm } };
  const before = await resolveCategory("funpay", "Rust", { deps });
  assert.strictEqual(before.ok, false);

  autoFarm.funpayNodes = { Rust: "1135" };
  const after = await resolveCategory("funpay", "Rust", { deps });
  assert.strictEqual(after.ok, true, "the new node must be visible at once");
  assert.deepStrictEqual(after.value, { node: "1135", nodeId: "1135" });
});

test("the cache keeps marketplaces apart", async () => {
  // One key per marketplace+game, or a GGSel category id would be served as a
  // ZeusX base id for the same game.
  clearCache();
  const deps = {
    marketplaces: {
      ggselResolveCategoryId: async () => "32450",
      zeusxResolveCategory: async () => ZEUSX_BASE,
    },
    settings: settingsWith({}),
  };
  const gg = await resolveCategory("ggsel", "Shared Game", { deps });
  const zx = await resolveCategory("zeusx", "Shared Game", { deps });
  assert.deepStrictEqual(gg.value, { categoryId: "32450" });
  assert.strictEqual(zx.value.serviceCategoryBaseId, "269");
});

// The cache reads the wall clock, so "half an hour later" is a patched
// Date.now, not a wait. setTimeout is untouched, so the real per-call timer in
// withTimeout still fires normally.
async function atMinutesLater(mins, fn) {
  const realNow = Date.now;
  Date.now = () => realNow() + mins * 60 * 1000;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

test(
  "REGRESSION (F5): a fallback taken because the lookup HUNG expires fast",
  CLOCK,
  async () => {
    // The money in this one: GGSel's per-game Twitch Drops section is often 2%
    // where the generic default is 15%+. A timed-out lookup still publishes
    // (the owner must not be blocked by GGSel being slow), but before this fix
    // that transient failure was written into the cache as a 30-MINUTE HIT —
    // so half an hour of real offers went to the generic shelf, and the owner
    // could not clear it by retrying because the retry was served from cache.
    clearCache();
    const hung = counting(hangs);
    const first = await resolveCategory("ggsel", "Slow Game", {
      timeoutMs: 25,
      deps: {
        marketplaces: { ggselResolveCategoryId: hung },
        settings: settingsWith({ ggselCategoryId: "34187" }),
      },
    });
    assert.strictEqual(first.ok, true, "a timeout must still publish");
    assert.strictEqual(first.source, "settings");
    assert.deepStrictEqual(first.value, { categoryId: "34187" });
    // Marked where the fallback was taken, not guessed at the cache site.
    assert.strictEqual(first.degraded, true);
    assert.match(first.label, /live lookup unavailable/);

    // Still cached for the SHORT window — dropping the entry entirely would
    // put the serial history crawl back on every modal open, which is the
    // other half of what this cache is for.
    const again = await resolveCategory("ggsel", "Slow Game", {
      timeoutMs: 25,
      deps: {
        marketplaces: { ggselResolveCategoryId: hung },
        settings: settingsWith({ ggselCategoryId: "34187" }),
      },
    });
    assert.strictEqual(hung.calls.length, 1, "the degraded answer is cached");
    assert.strictEqual(again.value.categoryId, "34187");

    // Past the miss TTL but well inside the hit TTL: if the timeout had been
    // stored as a hit this call would be served the generic default again.
    const live = counting(async () => "32450");
    const after = await atMinutesLater(MISS_TTL_MS / 60000 + 1, () =>
      resolveCategory("ggsel", "Slow Game", {
        deps: {
          marketplaces: { ggselResolveCategoryId: live },
          settings: settingsWith({ ggselCategoryId: "34187" }),
        },
      }),
    );
    assert.strictEqual(live.calls.length, 1, "the failure must be re-asked");
    assert.deepStrictEqual(after.value, { categoryId: "32450" });
    assert.strictEqual(after.degraded, false);
    assert.ok(CACHE_TTL_MS > MISS_TTL_MS + 60000, "the two TTLs differ enough");
  },
);

test("a GGSel fallback the market really answered keeps the hit TTL", async () => {
  // The other side of F5, so the fix cannot be "demote every settings
  // fallback". An empty answer from a REACHABLE GGSel is a stable fact — that
  // game has no Twitch Drops section — and re-crawling it every five minutes
  // is exactly the serial-loop cost the cache exists to stop.
  clearCache();
  const lookup = counting(async () => "");
  const deps = {
    marketplaces: { ggselResolveCategoryId: lookup },
    settings: settingsWith({ ggselCategoryId: "34187" }),
  };
  const first = await resolveCategory("ggsel", "Shelfless Game", { deps });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.degraded, false, "answered ≠ degraded");
  assert.strictEqual(first.label, "GGSel default category 34187");

  const after = await atMinutesLater(MISS_TTL_MS / 60000 + 1, () =>
    resolveCategory("ggsel", "Shelfless Game", { deps }),
  );
  assert.strictEqual(lookup.calls.length, 1, "a real answer stays cached");
  assert.deepStrictEqual(after.value, { categoryId: "34187" });
});

test(
  "REGRESSION (F5): ZeusX reads its pin BEFORE the lookup, so it cannot degrade",
  CLOCK,
  async () => {
    // ZeusX is the other resolver with a settings value, and it is only safe
    // because of that ordering: the pin wins first, and a hung live lookup
    // falls through to a refusal (which already takes the short TTL) instead
    // of being absorbed into a settings answer the way GGSel's was.
    clearCache();
    const r = await resolveCategory("zeusx", "Hung ZeusX Game", {
      timeoutMs: 25,
      deps: {
        marketplaces: { zeusxResolveCategory: hangs },
        settings: settingsWith({
          zeusxGames: { "some other game": { serviceCategoryBaseId: "901" } },
        }),
      },
    });
    assert.strictEqual(r.ok, false, "a hung ZeusX lookup must not fall back");
    assert.strictEqual(r.degraded, false);
    assert.deepStrictEqual(r.value, {});
  },
);

/* ------------------------------ name matching ----------------------------- */

test("FunPay matches on the normalised name, and only exactly", async () => {
  // Exact by design: a wrong node lists the account in a different game's
  // section where nobody looking for this game will ever see it.
  const deps = {
    settings: settingsWith({
      funpayNodes: { "Tom Clancy's Rainbow Six Siege": "1135" },
    }),
  };
  const hit = await resolveCategory("funpay", "rainbow six siege", { deps });
  assert.strictEqual(hit.ok, true);
  assert.strictEqual(hit.value.nodeId, "1135");

  // "Rainbow Six" is a prefix of the mapped game and must NOT match: Siege,
  // Extraction and Mobile are three different FunPay sections.
  const near = await resolveCategory("funpay", "Rainbow Six", { deps });
  assert.strictEqual(near.ok, false, "a prefix must not be treated as a match");
});
