// Bulk packs — utils/bulkPacks/markets.js, the only module that calls the
// marketplace connectors (docs/bulk-packs/MODULES.md §markets.js, API-UI.md
// "Tests (A4)").
//
// FAKES ONLY. Every dependency is injected through __setDeps: a fake `mp` that
// records its calls, fake models, fake settings / gate / images. No Mongo, no
// network, no utils/settings.json, no credentials — the last test is a tripwire
// proving no real connector, model or settings module was ever loaded.
//
// The rules under test are the ones that cost money when they break:
//   1. Unit semantics: Eldorado/G2G quantity = accounts, the tier is the
//      minimum order; a Gameflip pack is ONE listing whose code holds exactly
//      `minQty` accounts, divided by PACK_SEPARATOR.
//   2. Refusals happen before any marketplace call (closed gate, blocked
//      market, farm-looking account title, short/duplicate units, unreadable
//      password, code over GAMEFLIP_CODE_MAX).
//   3. readOffer never answers "gone"/"expired" for a failed or empty read.
//   4. Take-off-sale failures are re-thrown with their outcome, never swallowed.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const markets = require("../utils/bulkPacks/markets");

/* ------------------------------- harness -------------------------------- */

function spy(impl = async () => undefined) {
  const fn = (...args) => {
    fn.calls.push(args);
    return impl(...args);
  };
  fn.calls = [];
  return fn;
}

// Total calls recorded on every spy of a fake module.
function callCount(obj) {
  return Object.values(obj).reduce(
    (n, v) => n + (typeof v === "function" && Array.isArray(v.calls) ? v.calls.length : 0),
    0,
  );
}

function oid(n) {
  return Number(n).toString(16).padStart(24, "0");
}

function units(n, prefix = "bulkuser") {
  return Array.from({ length: n }, (_, i) => ({
    accountId: oid(i + 1),
    login: prefix + String(i + 1).padStart(2, "0"),
  }));
}

// Shaped like gameflipFulfiller.gameflipDeliveryCode (the real one is ~493
// characters for a 15-char login and 14-char password).
function fakeDeliveryCode(login, password) {
  return (
    "TWITCH DROP ACCOUNT\n\nLogin: " + login + "\nPassword: " + password + "\n\n" +
    "g".repeat(430)
  );
}

// A copy of utils/eldoradoFarmService.js termToDays (the real farm-title
// parser). The source-level test below fails if the two ever drift.
function termToDays(title) {
  const t = String(title || "");
  const d = t.match(/(\d+)\s*days?\b/i);
  if (d) return parseInt(d[1], 10);
  if (/\b1\s*year\b/i.test(t)) return 365;
  const y = t.match(/(\d+)\s*years?\b/i);
  if (y) return parseInt(y[1], 10) * 365;
  const m = t.match(/(\d+)\s*months?\b/i);
  if (m) return parseInt(m[1], 10) * 30;
  return 0;
}

// The same verdicts utils/marketplaces.js delistOutcome gives these messages.
function delistOutcome(message) {
  const m = String(message || "").toLowerCase();
  if (/\(sold\)|already sold/.test(m)) return "sold";
  if (/not found|http_status":\s*404/.test(m)) return "gone";
  if (/must be active|already (paused|inactive|hidden|cancell?ed|delisted)/.test(m)) return "gone";
  return "";
}

function fakeMp(over = {}) {
  return {
    G2G_MIN_PRICE: 1,
    G2G_ITEMS_SERVICE: "svc-game-items",
    ELD_MIN_PRICE: 0.5,
    delistOutcome,
    eldoradoPublish: spy(async () => ({ externalId: "eld-1", id: "eld-1", url: "https://eld/eld-1" })),
    g2gPublish: spy(async () => ({ externalId: "g2g-1", url: "https://g2g/g2g-1" })),
    gameflipPublish: spy(async () => ({ externalId: "gf-1", url: "https://gf/gf-1" })),
    g2gResolveOfferShape: spy(async () => ({
      relationId: "rel-1",
      attributes: [{ collection_id: "c-platform", dataset_id: "d-pc" }],
      collectionTree: ["tree-1"],
    })),
    eldoradoDelist: spy(),
    eldoradoRelist: spy(),
    eldoradoSetQuantity: spy(async (id, q) => q),
    eldoradoOffer: spy(async () => ({ offerState: "Active", quantity: 7 })),
    g2gDelist: spy(),
    g2gRelist: spy(),
    g2gSetQuantity: spy(async () => ({})),
    g2gGetOffer: spy(async () => ({ status: "live", actual_qty: 4 })),
    gameflipDelist: spy(),
    ...over,
  };
}

const RUST_BRAND = { brandId: "brand-rust", seoTerm: "rust-items", marketingTitle: "Rust Items" };

function setup(over = {}) {
  const env = {
    mp: over.mp || fakeMp(),
    gate: { ok: true, reason: "" },
    gateCalls: [],
    accounts: new Map(),
    rowQty: 20,
  };
  env.deps = {
    mp: env.mp,
    config: {
      currentGate: (market, source) => {
        env.gateCalls.push([market, source]);
        return { ...env.gate };
      },
    },
    settings: {
      isNoClaimGame: (g) => /overwatch|rainbow six|call of duty/i.test(String(g || "")),
    },
    g2gGames: {
      G2G_ITEMS_SERVICE: "svc-game-items",
      brandForGame: (g) => (/^rust$/i.test(String(g || "").trim()) ? RUST_BRAND : null),
    },
    setImage: {
      buildSetGridImage: spy(async () => "/tmp/set-grid-test.png"),
      buildPromoCoverImage: spy(async () => "/tmp/promo-cover-test.png"),
    },
    noclaimListings: {
      publishNoclaim: spy(async () => ({
        success: true,
        id: "row-1",
        externalId: "nc-1",
        url: "https://market/nc-1",
        note: "no-claim auto-delivery",
      })),
    },
    noclaimStock: { ADVERTISE_MAX: 80 },
    farmParser: { termToDays },
    gameflipDeliveryCode: fakeDeliveryCode,
    decrypt: (v) => (typeof v === "string" && v.startsWith("enc:") ? v.slice(4) : ""),
    BotAccount: {
      find: spy((filter) => ({
        // Deliberately NOT in the order asked: the code must follow the units.
        lean: async () =>
          filter._id.$in
            .map((id) => env.accounts.get(id))
            .filter(Boolean)
            .reverse(),
      })),
    },
    DropLog: {
      aggregate: spy(async () => [
        { _id: "/drop-images/a.png", accounts: 9 },
        { _id: "/drop-images/b.png", accounts: 3 },
      ]),
    },
    MarketplaceListing: {
      findById: spy((id) => ({ lean: async () => ({ _id: id, qtyTarget: env.rowQty }) })),
    },
    // Only the bundled default cover "exists" — item images do not.
    fs: { existsSync: (p) => String(p).endsWith("listing-default-cover.png") },
    fsp: { unlink: spy(async () => undefined) },
    ...(over.deps || {}),
  };
  markets.__resetDeps();
  markets.__setDeps(env.deps);
  return env;
}

function seedAccounts(env, list) {
  for (const u of list) {
    env.accounts.set(u.accountId, {
      _id: u.accountId,
      login: u.login,
      credUsername: "",
      credPassword: "enc:pw-" + u.login,
    });
  }
}

function refused(re) {
  return (err) => {
    assert.strictEqual(err.code, "BULK_PACK_REFUSED", "expected a refusal, got: " + err.message);
    if (re) assert.match(err.message, re);
    return true;
  };
}

function quietConsole() {
  const orig = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(" "));
  return {
    lines,
    restore: () => {
      console.error = orig;
    },
  };
}

const DEFAULT_COVER = path.join(__dirname, "..", "public", "listing-default-cover.png");

const SET = {
  _id: "64f000000000000000000abc",
  name: "Rust Twitch Drops bundle",
  coverGame: "Rust",
  items: [{ name: "Hoodie", game: "Rust", image: "/drop-images/hoodie.png", qty: 1 }],
};
const ACC_TITLE = "Rust Twitch Drops bundle — BULK 5+ accounts (5% off)";
const PACK_TITLE = "Rust Twitch Drops bundle — PACK OF 5 ACCOUNTS";

function accountArgs(over = {}) {
  return {
    market: "eldorado",
    set: SET,
    game: "Rust",
    title: ACC_TITLE,
    description: "Each account holds the whole bundle. Minimum order 5 accounts.",
    unitPrice: 1.19,
    packPrice: 0,
    minQty: 5,
    units: units(7),
    coverPath: "/tmp/grid.png",
    ...over,
  };
}

/* ---------------------- 1. Eldorado / G2G account packs ----------------- */

test("constants: the separator and the Gameflip code cap", () => {
  assert.strictEqual(markets.PACK_SEPARATOR, "\n\n=====\n\n");
  assert.strictEqual(markets.GAMEFLIP_CODE_MAX, 10000);
});

test("eldorado account pack: quantity = accounts, minQuantity = tier, autoLister's shape", async () => {
  const env = setup();
  const r = await markets.publishAccounts(accountArgs());
  assert.deepStrictEqual(r, { externalId: "eld-1", url: "https://eld/eld-1", price: 1.19 });
  assert.strictEqual(env.mp.eldoradoPublish.calls.length, 1);
  assert.deepStrictEqual(env.mp.eldoradoPublish.calls[0][0], {
    game: "Rust",
    title: ACC_TITLE,
    description: "Each account holds the whole bundle. Minimum order 5 accounts.",
    priceUsd: 1.19,
    quantity: 7,
    minQuantity: 5,
    coverImagePath: "/tmp/grid.png",
  });
  assert.deepStrictEqual(env.gateCalls, [["eldorado", "dropset"]]);
  assert.strictEqual(callCount(env.mp), 1, "exactly one marketplace call");
});

test("eldorado: the price Eldorado really charges is recorded ($0.50 floor, cents)", async () => {
  const env = setup();
  const low = await markets.publishAccounts(accountArgs({ unitPrice: 0.3 }));
  assert.strictEqual(low.price, 0.5);
  assert.strictEqual(env.mp.eldoradoPublish.calls[0][0].priceUsd, 0.5);
  const odd = await markets.publishAccounts(accountArgs({ unitPrice: 1.234 }));
  assert.strictEqual(odd.price, 1.23);
});

test("eldorado: no grid cover falls back to the Listings route's default cover", async () => {
  const env = setup();
  await markets.publishAccounts(accountArgs({ coverPath: "" }));
  assert.strictEqual(env.mp.eldoradoPublish.calls[0][0].coverImagePath, DEFAULT_COVER);
});

test("eldorado: an accepted publish with no offer id is an error, not a row-less success", async () => {
  const env = setup({ mp: fakeMp({ eldoradoPublish: spy(async () => ({ url: "" })) }) });
  const q = quietConsole();
  try {
    await assert.rejects(markets.publishAccounts(accountArgs()), (err) => {
      assert.notStrictEqual(err.code, "BULK_PACK_REFUSED", "something may be live");
      assert.match(err.message, /no offer id/);
      return true;
    });
  } finally {
    q.restore();
  }
  assert.strictEqual(env.mp.eldoradoPublish.calls.length, 1);
});

test("g2g account pack: hand-checked brand, $1 floor, qty = accounts, minQty = tier", async () => {
  const env = setup();
  const r = await markets.publishAccounts(
    accountArgs({ market: "g2g", unitPrice: 0.8, units: units(6) }),
  );
  assert.deepStrictEqual(r, { externalId: "g2g-1", url: "https://g2g/g2g-1", price: 1 });
  assert.deepStrictEqual(env.mp.g2gPublish.calls[0][0], {
    serviceId: "svc-game-items",
    brandId: "brand-rust",
    title: ACC_TITLE,
    description: "Each account holds the whole bundle. Minimum order 5 accounts.",
    priceUsd: 1,
    qty: 6,
    minQty: 5,
  });
  assert.deepStrictEqual(env.gateCalls, [["g2g", "dropset"]]);
});

test("g2g: a game without a G2G brand is refused, never approximated", async () => {
  const env = setup();
  await assert.rejects(
    markets.publishAccounts(accountArgs({ market: "g2g", game: "Apex Legends" })),
    refused(/no G2G brand for Apex Legends/),
  );
  assert.strictEqual(callCount(env.mp), 0);
});

/* ---------------------------- 2. Gameflip packs -------------------------- */

test("gameflip pack: ONE code with N blocks in unit order, passwords read from BotAccount", async () => {
  const env = setup();
  const list = units(5);
  seedAccounts(env, list);
  const r = await markets.publishAccounts(
    accountArgs({ market: "gameflip", title: PACK_TITLE, units: list, packPrice: 5.5, unitPrice: 0 }),
  );
  assert.deepStrictEqual(r, { externalId: "gf-1", url: "https://gf/gf-1", price: 5.5 });

  // One read, projected to the credential fields only.
  assert.strictEqual(env.deps.BotAccount.find.calls.length, 1);
  const [filter, projection] = env.deps.BotAccount.find.calls[0];
  assert.deepStrictEqual(filter, { _id: { $in: list.map((u) => u.accountId) } });
  assert.deepStrictEqual(projection, { login: 1, credUsername: 1, credPassword: 1 });

  assert.strictEqual(env.mp.gameflipPublish.calls.length, 1);
  const call = env.mp.gameflipPublish.calls[0][0];
  assert.deepStrictEqual(Object.keys(call).sort(), [
    "autoDeliverCode",
    "description",
    "imagePath",
    "priceUsd",
    "title",
  ]);
  assert.strictEqual(call.title, PACK_TITLE);
  assert.strictEqual(call.priceUsd, 5.5, "a pack is priced per pack");
  assert.strictEqual(call.imagePath, "/tmp/grid.png");

  const blocks = call.autoDeliverCode.split(markets.PACK_SEPARATOR);
  assert.strictEqual(blocks.length, 5, "exactly minQty accounts in the code");
  blocks.forEach((b, i) => {
    const login = list[i].login;
    assert.strictEqual(b, "ACCOUNT " + (i + 1) + " of 5\n" + fakeDeliveryCode(login, "pw-" + login));
  });
  assert.strictEqual(
    call.autoDeliverCode.split("=====").length - 1,
    4,
    "N-1 separators",
  );
  // Credentials travel only in the code.
  for (const u of list) {
    assert.ok(!call.title.includes("pw-" + u.login));
    assert.ok(!call.description.includes("pw-" + u.login));
  }
  assert.deepStrictEqual(env.gateCalls, [["gameflip", "dropset"]]);
});

test("gameflip pack: credUsername stands in for an empty login, as the reservation read it", async () => {
  const env = setup();
  const list = units(5);
  seedAccounts(env, list);
  const a = env.accounts.get(list[2].accountId);
  a.login = "";
  a.credUsername = list[2].login;
  await markets.publishAccounts(
    accountArgs({ market: "gameflip", title: PACK_TITLE, units: list, packPrice: 5 }),
  );
  assert.strictEqual(env.mp.gameflipPublish.calls.length, 1);
});

test("gameflip pack: a default tier of 10 fits under GAMEFLIP_CODE_MAX", async () => {
  const env = setup();
  const list = units(10);
  seedAccounts(env, list);
  await markets.publishAccounts(
    accountArgs({ market: "gameflip", title: PACK_TITLE, units: list, minQty: 10, packPrice: 9 }),
  );
  const code = env.mp.gameflipPublish.calls[0][0].autoDeliverCode;
  assert.strictEqual(code.split(markets.PACK_SEPARATOR).length, 10);
  assert.ok(code.length < markets.GAMEFLIP_CODE_MAX);
});

test("gameflip pack refusals: nothing is published and no password leaks into the error", async () => {
  const cases = [
    {
      name: "unreadable password",
      tweak: (env, list) => {
        env.accounts.get(list[3].accountId).credPassword = "garbage";
      },
      re: /bulkuser04 has no readable password/,
    },
    {
      name: "account missing",
      tweak: (env, list) => env.accounts.delete(list[1].accountId),
      re: /bulkuser02 no longer exists/,
    },
    {
      name: "login no longer matches the reservation",
      tweak: (env, list) => {
        env.accounts.get(list[0].accountId).login = "someoneelse";
      },
      re: /bulkuser01 no longer carries that login/,
    },
    {
      name: "invalid account id",
      args: { units: [{ accountId: "not-an-id", login: "x1" }, ...units(4)] },
      re: /no valid account id/,
    },
  ];
  for (const c of cases) {
    const env = setup();
    const list = units(5);
    seedAccounts(env, list);
    if (c.tweak) c.tweak(env, list);
    await assert.rejects(
      markets.publishAccounts(
        accountArgs({ market: "gameflip", title: PACK_TITLE, units: list, packPrice: 5, ...(c.args || {}) }),
      ),
      (err) => {
        refused(c.re)(err);
        assert.ok(!/pw-/.test(err.message), c.name + ": no password in the message");
        return true;
      },
      c.name,
    );
    assert.strictEqual(env.mp.gameflipPublish.calls.length, 0, c.name);
  }
});

test("gameflip pack: a code over GAMEFLIP_CODE_MAX is refused, never truncated", async () => {
  const env = setup();
  const list = units(20);
  seedAccounts(env, list);
  await assert.rejects(
    markets.publishAccounts(
      accountArgs({ market: "gameflip", title: PACK_TITLE, units: list, minQty: 20, packPrice: 18 }),
    ),
    (err) => {
      refused(/over the 10000/)(err);
      assert.ok(!/pw-/.test(err.message));
      return true;
    },
  );
  assert.strictEqual(env.mp.gameflipPublish.calls.length, 0);
});

test("gameflip pack: exactly minQty accounts, and Gameflip's $0.75 minimum", async () => {
  const env = setup();
  const list = units(6);
  seedAccounts(env, list);
  await assert.rejects(
    markets.publishAccounts(
      accountArgs({ market: "gameflip", title: PACK_TITLE, units: list, minQty: 5, packPrice: 5 }),
    ),
    refused(/exactly 5 accounts/),
  );
  await assert.rejects(
    markets.publishAccounts(
      accountArgs({ market: "gameflip", title: PACK_TITLE, units: units(5), packPrice: 0.5 }),
    ),
    refused(/minimum price is \$0\.75/),
  );
  assert.strictEqual(callCount(env.mp), 0);
  assert.strictEqual(env.deps.BotAccount.find.calls.length, 0, "no password read for a refused pack");
});

/* ---------------------- 3. Refusals before any call ---------------------- */

test("account packs refuse before any marketplace call", async () => {
  const long = (n) => "x".repeat(n);
  const cases = [
    ["fewer accounts than the minimum order", { units: units(4) }, /could never be bought/],
    ["an account twice", { units: [...units(5), units(1)[0]] }, /on this offer twice/],
    ["a login twice", { units: [...units(5), { accountId: oid(99), login: "BULKUSER01" }] }, /twice/],
    ["a unit without its login", { units: [...units(5), { accountId: oid(98) }] }, /id and login/],
    ["no units", { units: [] }, /No accounts/],
    ["minQty 1 is not a bulk tier", { minQty: 1 }, /minQty/],
    ["a farm-looking account title", { title: "Rust Twitch Drops Automatic Farming — BULK 5+" }, /must not contain "Automatic Farming"/],
    ["an eldorado title Eldorado would cut", { title: long(161) }, /cuts titles at 160/],
    ["a g2g title G2G would cut", { market: "g2g", title: long(129) }, /cuts titles at 128/],
    ["a gameflip title Gameflip would cut", { market: "gameflip", packPrice: 5, units: units(5), title: long(121) }, /cuts titles at 120/],
    ["an eldorado description Eldorado would cut", { description: long(2001) }, /cuts descriptions at 2000/],
    ["a no-claim game from the claimed archive", { game: "Overwatch" }, /no-claim game/],
    ["a no-claim set", { set: { ...SET, stockSource: "noclaim" } }, /publishNoclaim/],
    ["no set", { set: null }, /No drop set/],
    ["a zero price", { unitPrice: 0 }, /unitPrice must be a price above/],
    ["Plati (blocked)", { market: "plati" }, /blocked by the owner/],
    ["Plati as digiseller (blocked)", { market: "digiseller" }, /blocked by the owner/],
    ["GGSel (blocked)", { market: "ggsel" }, /blocked by the owner/],
    ["an unsupported market", { market: "zeusx" }, /not supported/],
    ["PlayerAuctions", { market: "playerauctions" }, /not supported/],
  ];
  for (const [name, over, re] of cases) {
    const env = setup();
    await assert.rejects(markets.publishAccounts(accountArgs(over)), refused(re), name);
    assert.strictEqual(callCount(env.mp), 0, name + ": no marketplace call");
  }
});

test("a closed or unreadable delivery gate refuses before anything is read or published", async () => {
  for (const market of ["eldorado", "g2g", "gameflip"]) {
    const env = setup();
    env.gate = { ok: false, reason: "eldoradoDeliverDryRun is on" };
    const list = units(5);
    seedAccounts(env, list);
    await assert.rejects(
      markets.publishAccounts(
        accountArgs({ market, title: market === "gameflip" ? PACK_TITLE : ACC_TITLE, units: list, packPrice: 5 }),
      ),
      refused(/not switched on for dropset offers — eldoradoDeliverDryRun is on/),
    );
    assert.strictEqual(callCount(env.mp), 0, market);
    assert.strictEqual(env.deps.BotAccount.find.calls.length, 0, market + ": no password read");
  }
  const env = setup({
    deps: {
      config: {
        currentGate: () => {
          throw new Error("settings unreadable");
        },
      },
    },
  });
  await assert.rejects(markets.publishAccounts(accountArgs()), refused(/could not be read/));
  assert.strictEqual(callCount(env.mp), 0);
});

/* ----------------------------- 4. No-claim packs ------------------------- */

const NC_SET = {
  _id: "64f000000000000000000def",
  name: "Overwatch Twitch Drops bundle",
  stockSource: "noclaim",
  coverGame: "Overwatch",
  items: [{ name: "Spray", game: "Overwatch", image: "/drop-images/spray.png", qty: 1 }],
};
const NC_TITLE = "Overwatch Twitch Drops bundle — BULK 5+ accounts (5% off)";

function noclaimArgs(over = {}) {
  return {
    market: "eldorado",
    set: NC_SET,
    game: "Overwatch",
    title: NC_TITLE,
    description: "Log in, link your own game account and claim the rewards.",
    unitPrice: 2.5,
    quantity: 20,
    minQty: 5,
    coverPath: "/tmp/grid.png",
    ...over,
  };
}

test("no-claim eldorado: the ctx the Listings route builds, and the layer publishes", async () => {
  const env = setup();
  const r = await markets.publishNoclaim(noclaimArgs());
  assert.deepStrictEqual(r, {
    rowId: "row-1",
    externalId: "nc-1",
    url: "https://market/nc-1",
    price: 2.5,
    quantity: 20,
  });
  const calls = env.deps.noclaimListings.publishNoclaim.calls;
  assert.strictEqual(calls.length, 1);
  const [name, ctx] = calls[0];
  assert.strictEqual(name, "eldorado");
  assert.strictEqual(ctx.set, NC_SET);
  assert.strictEqual(ctx.title, NC_TITLE);
  assert.strictEqual(ctx.description, "Log in, link your own game account and claim the rewards.");
  assert.strictEqual(ctx.priceUsd, 2.5);
  assert.strictEqual(ctx.gridImage, "/tmp/grid.png");
  assert.strictEqual(ctx.coverPath, DEFAULT_COVER, "coverImagePath(set)'s fallback");
  assert.deepStrictEqual(ctx.cat, {}, "Eldorado needs no category");
  assert.strictEqual(ctx.pubGame, "Overwatch");
  assert.deepStrictEqual(ctx.body.eldorado, { quantity: 20, minQuantity: 5, game: "Overwatch" });
  assert.strictEqual(ctx.body.g2g, undefined);
  assert.deepStrictEqual(ctx.body.marketplaces, ["eldorado"]);
  assert.deepStrictEqual(env.gateCalls, [["eldorado", "noclaim"]]);
  assert.strictEqual(callCount(env.mp), 0, "the no-claim layer is the one that publishes");
});

test("no-claim g2g: category resolved from the brand exactly as the route does, $1 floor", async () => {
  const env = setup();
  const set = { ...NC_SET, coverGame: "Rust", items: [{ name: "Hoodie", game: "Rust" }] };
  const r = await markets.publishNoclaim(
    noclaimArgs({ market: "g2g", set, game: "Rust", title: ACC_TITLE, unitPrice: 0.9, quantity: 12, minQty: 10 }),
  );
  assert.strictEqual(r.price, 1);
  const [name, ctx] = env.deps.noclaimListings.publishNoclaim.calls[0];
  assert.strictEqual(name, "g2g");
  assert.deepStrictEqual(ctx.cat, { serviceId: "svc-game-items", brandId: "brand-rust", seoTerm: "rust-items" });
  assert.deepStrictEqual(ctx.body.g2g, { qty: 12, minQty: 10 });
  assert.strictEqual(ctx.body.eldorado, undefined);
  assert.strictEqual(ctx.priceUsd, 1);
  assert.strictEqual(ctx.pubGame, "Rust");
});

test("no-claim g2g: a game G2G does not list is refused before the layer runs", async () => {
  const env = setup();
  await assert.rejects(
    markets.publishNoclaim(noclaimArgs({ market: "g2g" })),
    refused(/G2G does not list Overwatch/),
  );
  assert.strictEqual(env.deps.noclaimListings.publishNoclaim.calls.length, 0);
});

test("no-claim: the layer's failure is thrown as-is (it may follow a live publish)", async () => {
  const env = setup({
    deps: {
      noclaimListings: {
        publishNoclaim: spy(async () => ({
          success: false,
          message: "published on Eldorado but the row could not be saved — delist it by hand: E77",
        })),
      },
    },
  });
  await assert.rejects(markets.publishNoclaim(noclaimArgs()), (err) => {
    assert.notStrictEqual(err.code, "BULK_PACK_REFUSED");
    assert.match(err.message, /delist it by hand: E77/);
    return true;
  });
  assert.strictEqual(env.deps.noclaimListings.publishNoclaim.calls.length, 1);
});

test("no-claim refusals: short quantity, wrong set, Gameflip, farm title, closed gate", async () => {
  const cases = [
    ["quantity under the tier", { quantity: 4 }, /quantity/],
    ["a dropset set", { set: SET }, /Not a no-claim set/],
    ["Gameflip (not in v1)", { market: "gameflip" }, /not supported for no-claim packs/],
    ["GGSel (blocked)", { market: "ggsel" }, /blocked by the owner/],
    ["a farm-looking title", { title: "Overwatch Twitch Drops Automatic Farming 120 Days" }, /must not contain/],
    ["a tier above what an offer may advertise", { minQty: 81, quantity: 90 }, /at most 80/],
  ];
  for (const [name, over, re] of cases) {
    const env = setup();
    await assert.rejects(markets.publishNoclaim(noclaimArgs(over)), refused(re), name);
    assert.strictEqual(env.deps.noclaimListings.publishNoclaim.calls.length, 0, name);
  }
  const env = setup();
  env.gate = { ok: false, reason: "no-claim shop auto-delivery is off" };
  await assert.rejects(markets.publishNoclaim(noclaimArgs()), refused(/no-claim shop auto-delivery is off/));
  assert.strictEqual(env.deps.noclaimListings.publishNoclaim.calls.length, 0);
});

test("no-claim: the advertised quantity is read back from the row and a short one is flagged", async () => {
  const env = setup();
  env.rowQty = 3;
  const q = quietConsole();
  let r;
  try {
    r = await markets.publishNoclaim(noclaimArgs());
  } finally {
    q.restore();
  }
  assert.strictEqual(r.quantity, 3);
  assert.ok(q.lines.some((l) => /minimum order 5/.test(l)), "the lowered minimum is logged");
});

/* ------------------------------ 5. Farm packs ---------------------------- */

const FARM_TITLE_120 = "Rust Twitch Drops Automatic Farming 120 Days — Bulk 5+ Accounts";

function farmArgs(over = {}) {
  return {
    market: "eldorado",
    game: "Rust",
    days: 120,
    title: FARM_TITLE_120,
    description: "Minimum order 5 accounts. Each account farms Rust for 120 days.",
    unitPrice: 2.85,
    quantity: 12,
    minQty: 5,
    ...over,
  };
}

test("farm eldorado: the farm script's cover and publish, plus the tier's minimum", async () => {
  const env = setup();
  const r = await markets.publishFarm(farmArgs());
  assert.deepStrictEqual(r, { externalId: "eld-1", url: "https://eld/eld-1", price: 2.85 });

  const promo = env.deps.setImage.buildPromoCoverImage.calls;
  assert.strictEqual(promo.length, 1);
  assert.deepStrictEqual(promo[0][0], {
    title: "Rust Twitch Drops Automatic Farming",
    serviceText: "120 Days Service",
    bullets: ["Fully Automated Farming", "Account-Safe and Undetectable", "Reliable Daily Rewards"],
    itemImages: ["/drop-images/a.png", "/drop-images/b.png"],
    twitchTiles: true,
  });
  const [pipeline, options] = env.deps.DropLog.aggregate.calls[0];
  assert.ok(pipeline[0].$match.game instanceof RegExp);
  assert.ok(pipeline[0].$match.game.test("rust") && !pipeline[0].$match.game.test("Rust 2"));
  assert.ok(options && options.maxTimeMS > 0, "bounded");
  assert.ok(!("allowDiskUse" in options), "never allowDiskUse (I12)");

  assert.deepStrictEqual(env.mp.eldoradoPublish.calls[0][0], {
    game: "Rust",
    title: FARM_TITLE_120,
    description: "Minimum order 5 accounts. Each account farms Rust for 120 days.",
    priceUsd: 2.85,
    quantity: 12,
    minQuantity: 5,
    coverImagePath: "/tmp/promo-cover-test.png",
    deliveryTime: "Minute20",
  });
  assert.deepStrictEqual(env.deps.fsp.unlink.calls, [["/tmp/promo-cover-test.png"]], "temp cover removed");
  assert.deepStrictEqual(env.gateCalls, [["eldorado", "farm"]]);
});

test("farm eldorado: 365 days reads as \"1 Year\", and a failed publish still removes the cover", async () => {
  const env = setup({
    mp: fakeMp({
      eldoradoPublish: spy(async () => {
        throw new Error("Eldorado publish failed (HTTP 429)");
      }),
    }),
  });
  await assert.rejects(
    markets.publishFarm(
      farmArgs({ days: 365, title: "Rust Twitch Drops Automatic Farming 1 Year — Bulk 5+ Accounts" }),
    ),
    /HTTP 429/,
  );
  assert.strictEqual(env.deps.setImage.buildPromoCoverImage.calls[0][0].serviceText, "1 Year Service");
  assert.deepStrictEqual(env.deps.fsp.unlink.calls, [["/tmp/promo-cover-test.png"]]);
});

test("farm g2g: brand + the shape resolved from our own offers, qty and minQty", async () => {
  const env = setup();
  const title = "Rust Twitch Drops Automatic Farming 180 Days — Bulk 5+";
  const r = await markets.publishFarm(farmArgs({ market: "g2g", days: 180, title, unitPrice: 0.95 }));
  assert.deepStrictEqual(r, { externalId: "g2g-1", url: "https://g2g/g2g-1", price: 1 });
  assert.deepStrictEqual(env.mp.g2gResolveOfferShape.calls, [[{ brandId: "brand-rust" }]]);
  assert.deepStrictEqual(env.mp.g2gPublish.calls[0][0], {
    serviceId: "svc-game-items",
    brandId: "brand-rust",
    relationId: "rel-1",
    offerAttributes: [{ collection_id: "c-platform", dataset_id: "d-pc" }],
    collectionTree: ["tree-1"],
    title,
    description: "Minimum order 5 accounts. Each account farms Rust for 120 days.",
    priceUsd: 1,
    qty: 12,
    minQty: 5,
  });
  assert.strictEqual(env.deps.setImage.buildPromoCoverImage.calls.length, 0, "G2G takes no cover");
});

test("farm refusals: the title must round-trip through the farm parser (CONTRACT I5)", async () => {
  const cases = [
    ["no Automatic Farming", { title: "Rust Twitch Drops 120 Days — Bulk 5+ Accounts" }, /must contain "Automatic Farming"/],
    ["a term the parser reads differently", { days: 180 }, /read this title as 120 days, not 180/],
    ["a game the parser reads differently", { game: "Rust Console" }, /read this title's game as "Rust"/],
    ["Gameflip (not in v1)", { market: "gameflip" }, /not supported for farming packs/],
    ["no game", { game: "" }, /needs its game/],
    ["zero days", { days: 0 }, /days must be/],
    ["quantity under the tier", { quantity: 4 }, /quantity/],
    ["a title G2G would cut", { market: "g2g", title: FARM_TITLE_120 + "x".repeat(70) }, /cuts titles at 128/],
    ["no G2G brand", { market: "g2g", game: "Apex Legends", title: "Apex Legends Twitch Drops Automatic Farming 120 Days" }, /no hand-checked G2G brand/],
  ];
  for (const [name, over, re] of cases) {
    const env = setup();
    await assert.rejects(markets.publishFarm(farmArgs(over)), refused(re), name);
    assert.strictEqual(callCount(env.mp), 0, name + ": no marketplace call");
    assert.strictEqual(env.deps.setImage.buildPromoCoverImage.calls.length, 0, name);
  }
  const env = setup();
  env.gate = { ok: false, reason: "g2gDeliverDryRun is on" };
  await assert.rejects(markets.publishFarm(farmArgs({ market: "g2g" })), refused(/g2gDeliverDryRun is on/));
  assert.strictEqual(callCount(env.mp), 0);
});

test("farm g2g: an unresolvable offer shape is a refusal (read-only, nothing created)", async () => {
  const env = setup({
    mp: fakeMp({
      g2gResolveOfferShape: spy(async () => {
        throw new Error("G2G needs Platform for this game");
      }),
    }),
  });
  await assert.rejects(markets.publishFarm(farmArgs({ market: "g2g" })), refused(/needs Platform/));
  assert.strictEqual(env.mp.g2gPublish.calls.length, 0);
});

/* ------------------------------ 6. readOffer ----------------------------- */

test("readOffer eldorado: real offerState words map; anything else is unknown", async () => {
  const table = [
    ["Active", "active"],
    ["Paused", "paused"],
    ["Expired", "expired"],
    ["Deleted", "gone"],
    ["Closed", "unknown"],
    ["", "unknown"],
  ];
  for (const [word, state] of table) {
    setup({ mp: fakeMp({ eldoradoOffer: spy(async () => ({ offerState: word, quantity: 9 })) }) });
    const r = await markets.readOffer("eldorado", "E1");
    assert.strictEqual(r.state, state, word);
    assert.strictEqual(r.quantity, 9);
  }
});

test("readOffer: a failed or empty read is NEVER gone/expired", async () => {
  const failing = [
    ["a 404", async () => {
      const e = new Error("Eldorado offer failed (HTTP 404): not found");
      e.status = 404;
      throw e;
    }],
    ["a 429", async () => {
      throw new Error("Eldorado offer failed (HTTP 429)");
    }],
    ["a null offer", async () => null],
    ["a non-object", async () => "gone"],
  ];
  for (const [name, impl] of failing) {
    const env = setup({ mp: fakeMp({ eldoradoOffer: spy(impl), g2gGetOffer: spy(impl) }) });
    for (const market of ["eldorado", "g2g"]) {
      const r = await markets.readOffer(market, "X1");
      assert.strictEqual(r.state, "unknown", market + " / " + name);
      assert.strictEqual(r.quantity, null);
    }
    assert.strictEqual(env.mp.eldoradoOffer.calls.length, 1);
  }
  const env = setup();
  const r = await markets.readOffer("eldorado", "");
  assert.strictEqual(r.state, "unknown");
  assert.strictEqual(callCount(env.mp), 0, "no read for a blank id");
});

test("readOffer g2g: live/delisted map, actual_qty is the quantity, other statuses unknown", async () => {
  const table = [
    ["live", "active"],
    ["delisted", "paused"],
    ["inactive", "unknown"],
  ];
  for (const [word, state] of table) {
    setup({ mp: fakeMp({ g2gGetOffer: spy(async () => ({ status: word, actual_qty: 4, available_qty: 2 })) }) });
    const r = await markets.readOffer("g2g", "G1");
    assert.strictEqual(r.state, state, word);
    assert.strictEqual(r.quantity, 4);
  }
});

test("readOffer gameflip: always unknown, and Gameflip is never asked", async () => {
  const env = setup();
  const r = await markets.readOffer("gameflip", "F1");
  assert.strictEqual(r.state, "unknown");
  assert.strictEqual(callCount(env.mp), 0);
});

/* -------------------------- 7. Live-offer controls ----------------------- */

test("pause / resume / setQuantity / withdraw route to the right connector call", async () => {
  const env = setup();
  assert.deepStrictEqual(await markets.pause("eldorado", "E9"), { ok: true });
  assert.deepStrictEqual(env.mp.eldoradoDelist.calls, [["E9"]]);
  await markets.pause("g2g", "G9");
  assert.deepStrictEqual(env.mp.g2gDelist.calls, [["G9"]]);

  await markets.resume("eldorado", "E9");
  assert.deepStrictEqual(env.mp.eldoradoRelist.calls, [["E9"]]);
  await markets.resume("g2g", "G9", { source: "farm" });
  assert.deepStrictEqual(env.mp.g2gRelist.calls, [["G9"]]);
  assert.deepStrictEqual(env.gateCalls, [["eldorado", "dropset"], ["g2g", "farm"]]);

  assert.strictEqual(await markets.setQuantity("eldorado", "E9", 7), 7);
  assert.deepStrictEqual(env.mp.eldoradoSetQuantity.calls, [["E9", 7]]);
  assert.strictEqual(await markets.setQuantity("g2g", "G9", 0), 0, "0 is a legitimate write");
  assert.deepStrictEqual(env.mp.g2gSetQuantity.calls, [["G9", 0]]);

  await markets.withdraw("gameflip", "F9");
  assert.deepStrictEqual(env.mp.gameflipDelist.calls, [["F9"]]);
  await markets.withdraw("eldorado", "E8");
  assert.deepStrictEqual(env.mp.eldoradoDelist.calls, [["E9"], ["E8"]], "withdraw on Eldorado is a pause");
  await markets.withdraw("g2g", "G8");
  assert.deepStrictEqual(env.mp.g2gDelist.calls, [["G9"], ["G8"]]);
  assert.strictEqual(env.mp.gameflipDelist.calls.length, 1);
});

test("controls refuse Gameflip pause/resume/quantity, blank ids and bad counts without a call", async () => {
  const env = setup();
  const attempts = [
    ["gameflip pause", () => markets.pause("gameflip", "F1"), /never paused/],
    ["gameflip resume", () => markets.resume("gameflip", "F1"), /never relisted/],
    ["gameflip quantity", () => markets.setQuantity("gameflip", "F1", 3), /no quantity/],
    ["blank pause", () => markets.pause("eldorado", ""), /No marketplace offer id/],
    ["undefined resume", () => markets.resume("g2g", undefined), /No marketplace offer id/],
    ["blank quantity id", () => markets.setQuantity("eldorado", " ", 3), /No marketplace offer id/],
    ["blank withdraw", () => markets.withdraw("gameflip", null), /No marketplace offer id/],
    ["NaN quantity", () => markets.setQuantity("eldorado", "E1", NaN), /whole number/],
    ["negative quantity", () => markets.setQuantity("g2g", "G1", -1), /whole number/],
    ["fractional quantity", () => markets.setQuantity("eldorado", "E1", 2.5), /whole number/],
    ["empty-string quantity", () => markets.setQuantity("eldorado", "E1", ""), /whole number/],
    ["blocked market", () => markets.pause("ggsel", "X1"), /blocked by the owner/],
  ];
  for (const [name, fn, re] of attempts) {
    await assert.rejects(fn(), refused(re), name);
  }
  assert.strictEqual(callCount(env.mp), 0);
});

test("resume on a closed gate is refused: putting stock back on sale is a publish (I4)", async () => {
  const env = setup();
  env.gate = { ok: false, reason: "eldoradoAutoDeliver is off" };
  await assert.rejects(markets.resume("eldorado", "E1"), refused(/eldoradoAutoDeliver is off/));
  assert.strictEqual(env.mp.eldoradoRelist.calls.length, 0);
  // Taking an offer OFF sale never needs the gate.
  await markets.pause("eldorado", "E1");
  await markets.setQuantity("eldorado", "E1", 2);
  assert.strictEqual(env.mp.eldoradoDelist.calls.length, 1);
  assert.strictEqual(env.mp.eldoradoSetQuantity.calls.length, 1);
});

test("take-off-sale failures are re-thrown with their outcome, never swallowed", async () => {
  const env = setup({
    mp: fakeMp({
      gameflipDelist: spy(async () => {
        throw new Error('Gameflip delist: {"message":"listing (sold)"}');
      }),
      eldoradoDelist: spy(async () => {
        throw new Error("Eldorado delist failed (HTTP 400): To pause an offer it must be active");
      }),
      g2gDelist: spy(async () => {
        throw new Error("G2G update offer failed (HTTP 500): boom");
      }),
    }),
  });
  await assert.rejects(markets.withdraw("gameflip", "F1"), (err) => {
    assert.strictEqual(err.outcome, "sold", "the caller must leave a sold pack alone (I9)");
    assert.match(err.message, /\(sold\)/);
    return true;
  });
  await assert.rejects(markets.pause("eldorado", "E1"), (err) => {
    assert.strictEqual(err.outcome, "gone");
    return true;
  });
  await assert.rejects(markets.withdraw("g2g", "G1"), (err) => {
    assert.strictEqual(err.outcome, "");
    return true;
  });
  assert.strictEqual(env.mp.gameflipDelist.calls.length, 1);
});

/* --------------------------- 8. Set, game, covers ------------------------ */

test("gameOfSet: the canonical set -> game chain (coverGame, then the items)", () => {
  setup();
  assert.strictEqual(markets.gameOfSet({ coverGame: "Rust", items: [{ game: "Apex Legends" }] }), "Rust");
  assert.strictEqual(markets.gameOfSet({ items: [{ name: "x" }, { game: "Apex Legends" }] }), "Apex Legends");
  assert.strictEqual(markets.gameOfSet({ name: "Rust Twitch Drops bundle" }), "", "never guessed from a name");
  assert.strictEqual(markets.gameOfSet(null), "");
});

test("coverForSet: the grid image, or \"\" when it cannot be built", async () => {
  const env = setup();
  assert.strictEqual(await markets.coverForSet(SET), "/tmp/set-grid-test.png");
  assert.strictEqual(env.deps.setImage.buildSetGridImage.calls[0][0], SET);
  assert.strictEqual(await markets.coverForSet(null), "");
  setup({
    deps: {
      setImage: {
        buildSetGridImage: spy(async () => {
          throw new Error("sharp exploded");
        }),
      },
    },
  });
  const q = quietConsole();
  try {
    assert.strictEqual(await markets.coverForSet(SET), "");
  } finally {
    q.restore();
  }
});

test("coverForFarm: the promo cover, with no term line when no days are given", async () => {
  const env = setup();
  assert.strictEqual(await markets.coverForFarm("Rust"), "/tmp/promo-cover-test.png");
  assert.strictEqual(env.deps.setImage.buildPromoCoverImage.calls[0][0].serviceText, "");
  assert.strictEqual(await markets.coverForFarm(""), "");
});

/* ------------------------------- 9. Tripwires ---------------------------- */

test("the test's parser copy is the real farm-title parser, byte for byte", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "utils", "eldoradoFarmService.js"), "utf8");
  const start = src.indexOf("function termToDays(");
  const end = src.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start);
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  assert.strictEqual(norm(src.slice(start, end + 2)), norm(termToDays.toString()));
});

test("no real connector, model, settings or credential module was ever loaded", () => {
  const forbidden = [
    "utils/marketplaces.js",
    "utils/settings.js",
    "utils/secretBox.js",
    "utils/gameflipFulfiller.js",
    "utils/noclaimListings.js",
    "utils/noclaimStock.js",
    "utils/eldoradoFarmService.js",
    "utils/g2gGames.js",
    "utils/setImage.js",
    "utils/telegram.js",
    "utils/bulkPacks/config.js",
    "models/BotAccount.js",
    "models/DropLog.js",
    "models/MarketplaceListing.js",
  ].map((f) => path.join(__dirname, "..", f));
  const loaded = new Set(Object.keys(require.cache));
  for (const f of forbidden) {
    assert.ok(!loaded.has(f), path.relative(path.join(__dirname, ".."), f) + " must not load in this test");
  }
  assert.ok(!Object.keys(require.cache).some((k) => /node_modules[\\/](axios|mongoose)[\\/]/.test(k)));
});
