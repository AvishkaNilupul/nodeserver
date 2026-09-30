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
//   1. Unit semantics (PACKS-2 §1): one listing unit = one PACK of N (the
//      tier's minQty) accounts, priced whole. Eldorado/G2G quantity = packs,
//      minimum order 1, price = the pack price; the title must say
//      "PACK OF N" and a pack price that reads like one account's is refused.
//      A Gameflip pack is ONE listing whose code holds exactly N accounts,
//      divided by PACK_SEPARATOR.
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
    // What the no-claim layer's row says it advertises (packs).
    rowQty: 4,
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
// PACKS-2 §3: every market's title says what the listing is.
const ACC_TITLE = "Rust Twitch Drops bundle — PACK OF 5 ACCOUNTS (-5%)";
const PACK_TITLE = "Rust Twitch Drops bundle — PACK OF 5 ACCOUNTS";
const ACC_DESC = "PACK OF 5 ACCOUNTS — each purchase is a pack of 5 separate accounts.";

// Two whole packs of 5 at $5.94 a pack ($1.19 each).
function accountArgs(over = {}) {
  return {
    market: "eldorado",
    set: SET,
    game: "Rust",
    title: ACC_TITLE,
    description: ACC_DESC,
    unitPrice: 1.19,
    packPrice: 5.94,
    minQty: 5,
    units: units(10),
    coverPath: "/tmp/grid.png",
    ...over,
  };
}

/* ---------------------- 1. Eldorado / G2G account packs ----------------- */

test("constants: the separator and the Gameflip code cap", () => {
  assert.strictEqual(markets.PACK_SEPARATOR, "\n\n=====\n\n");
  assert.strictEqual(markets.GAMEFLIP_CODE_MAX, 10000);
});

test("eldorado account pack: quantity = PACKS, minQuantity 1, price = the pack, autoLister's shape", async () => {
  const env = setup();
  const r = await markets.publishAccounts(accountArgs());
  assert.deepStrictEqual(r, { externalId: "eld-1", url: "https://eld/eld-1", price: 5.94 });
  assert.strictEqual(env.mp.eldoradoPublish.calls.length, 1);
  assert.deepStrictEqual(env.mp.eldoradoPublish.calls[0][0], {
    game: "Rust",
    title: ACC_TITLE,
    description: ACC_DESC,
    priceUsd: 5.94,
    quantity: 2, // 10 accounts = 2 packs of 5
    minQuantity: 1,
    coverImagePath: "/tmp/grid.png",
  });
  assert.deepStrictEqual(env.gateCalls, [["eldorado", "dropset"]]);
  assert.strictEqual(callCount(env.mp), 1, "exactly one marketplace call");
  // One pack.
  await markets.publishAccounts(accountArgs({ units: units(5) }));
  assert.strictEqual(env.mp.eldoradoPublish.calls[1][0].quantity, 1);
  assert.strictEqual(env.mp.eldoradoPublish.calls[1][0].minQuantity, 1);
});

test("eldorado: the price Eldorado really charges for a pack is recorded ($0.50 floor, cents)", async () => {
  const env = setup();
  const low = await markets.publishAccounts(accountArgs({ packPrice: 0.3, unitPrice: 0.06 }));
  assert.strictEqual(low.price, 0.5);
  assert.strictEqual(env.mp.eldoradoPublish.calls[0][0].priceUsd, 0.5);
  const odd = await markets.publishAccounts(accountArgs({ packPrice: 6.234, unitPrice: 1.25 }));
  assert.strictEqual(odd.price, 6.23);
  // No per-account figure given: the pack price alone decides.
  const bare = await markets.publishAccounts(accountArgs({ unitPrice: undefined }));
  assert.strictEqual(bare.price, 5.94);
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

test("g2g account pack: hand-checked brand, $1 floor per listing, qty = PACKS, minQty 1", async () => {
  const env = setup();
  const r = await markets.publishAccounts(
    accountArgs({ market: "g2g", packPrice: 0.8, unitPrice: 0.16, units: units(15) }),
  );
  assert.deepStrictEqual(r, { externalId: "g2g-1", url: "https://g2g/g2g-1", price: 1 });
  assert.deepStrictEqual(env.mp.g2gPublish.calls[0][0], {
    serviceId: "svc-game-items",
    brandId: "brand-rust",
    title: ACC_TITLE,
    description: ACC_DESC,
    priceUsd: 1,
    qty: 3,
    minQty: 1,
  });
  assert.deepStrictEqual(env.gateCalls, [["g2g", "dropset"]]);
});

test("account packs: a partial pack, a title without the pack, or a per-account price as the pack price is refused", async () => {
  for (const market of ["eldorado", "g2g"]) {
    for (const [name, over, re] of [
      ["7 accounts are not whole packs of 5", { units: units(7) }, /7 accounts do not make whole packs of 5/],
      ["11 accounts are not whole packs of 5", { units: units(11) }, /whole packs of 5/],
      ["a v1 title", { title: "Rust Twitch Drops bundle — BULK 5+ accounts (5% off)" }, /must say "PACK OF 5"/],
      ["the wrong pack size", { title: "Rust Twitch Drops bundle — PACK OF 50 ACCOUNTS" }, /must say "PACK OF 5"/],
      ["a single account's price for the pack", { packPrice: 1.19, unitPrice: 1.19 }, /does not add up/],
      ["no pack price", { packPrice: 0 }, /packPrice/],
      ["a pack price that is not a number", { packPrice: "abc" }, /packPrice/],
    ]) {
      const env = setup();
      await assert.rejects(markets.publishAccounts(accountArgs({ market, ...over })), refused(re), market + ": " + name);
      assert.strictEqual(callCount(env.mp), 0, market + ": " + name);
    }
  }
  // Gameflip: the same title and price guards.
  const env = setup();
  const list = units(5);
  seedAccounts(env, list);
  await assert.rejects(
    markets.publishAccounts(accountArgs({ market: "gameflip", title: "Rust bundle x5", units: list, packPrice: 5 })),
    refused(/must say "PACK OF 5"/),
  );
  await assert.rejects(
    markets.publishAccounts(accountArgs({ market: "gameflip", title: PACK_TITLE, units: list, packPrice: 1.19, unitPrice: 1.19 })),
    refused(/does not add up/),
  );
  assert.strictEqual(callCount(env.mp), 0);
  assert.strictEqual(env.deps.BotAccount.find.calls.length, 0, "no password read for a refused pack");
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
    accountArgs({
      market: "gameflip",
      title: "Rust Twitch Drops bundle — PACK OF 10 ACCOUNTS",
      units: list,
      minQty: 10,
      packPrice: 9,
      unitPrice: 0.9,
    }),
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
      accountArgs({
        market: "gameflip",
        title: "Rust Twitch Drops bundle — PACK OF 20 ACCOUNTS",
        units: list,
        minQty: 20,
        packPrice: 18,
        unitPrice: 0.9,
      }),
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
      accountArgs({ market: "gameflip", title: PACK_TITLE, units: units(5), packPrice: 0.5, unitPrice: 0.1 }),
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
    ["fewer accounts than one pack", { units: units(4) }, /could never be bought/],
    ["an account twice", { units: [...units(5), units(1)[0]] }, /on this offer twice/],
    ["a login twice", { units: [...units(5), { accountId: oid(99), login: "BULKUSER01" }] }, /twice/],
    ["a unit without its login", { units: [...units(5), { accountId: oid(98) }] }, /id and login/],
    ["no units", { units: [] }, /No accounts/],
    ["minQty 1 is not a bulk tier", { minQty: 1 }, /minQty/],
    ["a farm-looking account title", { title: "Rust Twitch Drops Automatic Farming — PACK OF 5 ACCOUNTS" }, /must not contain "Automatic Farming"/],
    ["an eldorado title Eldorado would cut", { title: long(161) }, /cuts titles at 160/],
    ["a g2g title G2G would cut", { market: "g2g", title: long(129) }, /cuts titles at 128/],
    ["a gameflip title Gameflip would cut", { market: "gameflip", packPrice: 5, units: units(5), title: long(121) }, /cuts titles at 120/],
    ["an eldorado description Eldorado would cut", { description: long(2001) }, /cuts descriptions at 2000/],
    ["a no-claim game from the claimed archive", { game: "Overwatch" }, /no-claim game/],
    ["a no-claim set", { set: { ...SET, stockSource: "noclaim" } }, /publishNoclaim/],
    ["no set", { set: null }, /No drop set/],
    ["a zero pack price", { packPrice: 0 }, /packPrice \(the price of one pack\) must be a price above/],
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
const NC_TITLE = "Overwatch Twitch Drops bundle — PACK OF 5 ACCOUNTS (-5%)";

// Four packs of 5 at $11.88 a pack ($2.38 each).
function noclaimArgs(over = {}) {
  return {
    market: "eldorado",
    set: NC_SET,
    game: "Overwatch",
    title: NC_TITLE,
    description: "Log in, link your own game account and claim the rewards.",
    unitPrice: 2.38,
    packPrice: 11.88,
    quantity: 4,
    minQty: 5,
    coverPath: "/tmp/grid.png",
    ...over,
  };
}

test("no-claim eldorado: the ctx the Listings route builds — quantity = packs, minimum 1, the pack price", async () => {
  const env = setup();
  const r = await markets.publishNoclaim(noclaimArgs());
  assert.deepStrictEqual(r, {
    rowId: "row-1",
    externalId: "nc-1",
    url: "https://market/nc-1",
    price: 11.88,
    quantity: 4,
  });
  const calls = env.deps.noclaimListings.publishNoclaim.calls;
  assert.strictEqual(calls.length, 1);
  const [name, ctx] = calls[0];
  assert.strictEqual(name, "eldorado");
  assert.strictEqual(ctx.set, NC_SET);
  assert.strictEqual(ctx.title, NC_TITLE);
  assert.strictEqual(ctx.description, "Log in, link your own game account and claim the rewards.");
  assert.strictEqual(ctx.priceUsd, 11.88);
  assert.strictEqual(ctx.body.price, 11.88);
  assert.strictEqual(ctx.gridImage, "/tmp/grid.png");
  assert.strictEqual(ctx.coverPath, DEFAULT_COVER, "coverImagePath(set)'s fallback");
  assert.deepStrictEqual(ctx.cat, {}, "Eldorado needs no category");
  assert.strictEqual(ctx.pubGame, "Overwatch");
  assert.deepStrictEqual(ctx.body.eldorado, { quantity: 4, minQuantity: 1, game: "Overwatch" });
  assert.strictEqual(ctx.body.g2g, undefined);
  assert.deepStrictEqual(ctx.body.marketplaces, ["eldorado"]);
  assert.deepStrictEqual(env.gateCalls, [["eldorado", "noclaim"]]);
  assert.strictEqual(callCount(env.mp), 0, "the no-claim layer is the one that publishes");
});

const G2G_TEN_TITLE = "Rust Twitch Drops bundle — PACK OF 10 ACCOUNTS (-10%)";

test("no-claim g2g: category resolved from the brand exactly as the route does, $1 floor per listing", async () => {
  const env = setup();
  const set = { ...NC_SET, coverGame: "Rust", items: [{ name: "Hoodie", game: "Rust" }] };
  const r = await markets.publishNoclaim(
    noclaimArgs({
      market: "g2g",
      set,
      game: "Rust",
      title: G2G_TEN_TITLE,
      packPrice: 0.9,
      unitPrice: 0.09,
      quantity: 2,
      minQty: 10,
    }),
  );
  assert.strictEqual(r.price, 1);
  const [name, ctx] = env.deps.noclaimListings.publishNoclaim.calls[0];
  assert.strictEqual(name, "g2g");
  assert.deepStrictEqual(ctx.cat, { serviceId: "svc-game-items", brandId: "brand-rust", seoTerm: "rust-items" });
  assert.deepStrictEqual(ctx.body.g2g, { qty: 2, minQty: 1 });
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

test("no-claim refusals: no pack, wrong set, Gameflip, farm title, no pack title, per-account price, closed gate", async () => {
  const cases = [
    ["no pack on offer", { quantity: 0 }, /quantity \(packs on the offer\)/],
    ["a fraction of a pack", { quantity: 1.5 }, /quantity/],
    ["a pack of one", { minQty: 1 }, /minQty/],
    ["a dropset set", { set: SET }, /Not a no-claim set/],
    ["Gameflip (not in v1)", { market: "gameflip" }, /not supported for no-claim packs/],
    ["GGSel (blocked)", { market: "ggsel" }, /blocked by the owner/],
    ["a farm-looking title", { title: "Overwatch Twitch Drops Automatic Farming 120 Days" }, /must not contain/],
    ["a v1 title", { title: "Overwatch Twitch Drops bundle — BULK 5+ accounts (5% off)" }, /must say "PACK OF 5"/],
    ["a single account's price for the pack", { packPrice: 2.38, unitPrice: 2.38 }, /does not add up/],
    ["no pack price", { packPrice: undefined }, /packPrice/],
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

test("no-claim: the advertised packs are read back from the row, and a shelf the layer capped is flagged", async () => {
  const env = setup();
  env.rowQty = 1;
  const q = quietConsole();
  let r;
  try {
    r = await markets.publishNoclaim(noclaimArgs());
  } finally {
    q.restore();
  }
  assert.strictEqual(r.quantity, 1);
  assert.ok(
    q.lines.some((l) => /advertising 1 of the 4 pack\(s\) of 5 asked for/.test(l)),
    "the capped quantity is logged: " + q.lines.join(" | "),
  );
  // Nothing capped: nothing logged.
  const env2 = setup();
  env2.rowQty = 4;
  const q2 = quietConsole();
  try {
    assert.strictEqual((await markets.publishNoclaim(noclaimArgs())).quantity, 4);
  } finally {
    q2.restore();
  }
  assert.deepStrictEqual(q2.lines, []);
});

/* ------------------------------ 5. Farm packs ---------------------------- */

const FARM_TITLE_120 = "Rust Twitch Drops Automatic Farming 120 Days — PACK OF 5 ACCOUNTS";
const FARM_DESC = "Each purchase is a pack of 5 separate Twitch accounts, each farmed for Rust for 120 days.";

// Three packs of 5 at $14.25 a pack ($2.85 each).
function farmArgs(over = {}) {
  return {
    market: "eldorado",
    game: "Rust",
    days: 120,
    title: FARM_TITLE_120,
    description: FARM_DESC,
    unitPrice: 2.85,
    packPrice: 14.25,
    quantity: 3,
    minQty: 5,
    ...over,
  };
}

test("farm eldorado: the farm script's cover and publish — quantity = packs, minimum 1, the pack price", async () => {
  const env = setup();
  const r = await markets.publishFarm(farmArgs());
  assert.deepStrictEqual(r, { externalId: "eld-1", url: "https://eld/eld-1", price: 14.25 });

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
    description: FARM_DESC,
    priceUsd: 14.25,
    quantity: 3,
    minQuantity: 1,
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
      farmArgs({ days: 365, title: "Rust Twitch Drops Automatic Farming 1 Year — PACK OF 5 ACCOUNTS" }),
    ),
    /HTTP 429/,
  );
  assert.strictEqual(env.deps.setImage.buildPromoCoverImage.calls[0][0].serviceText, "1 Year Service");
  assert.deepStrictEqual(env.deps.fsp.unlink.calls, [["/tmp/promo-cover-test.png"]]);
});

test("farm g2g: brand + the shape resolved from our own offers, qty = packs, minQty 1, $1 floor per listing", async () => {
  const env = setup();
  const title = "Rust Twitch Drops Automatic Farming 180 Days — PACK OF 5";
  const r = await markets.publishFarm(
    farmArgs({ market: "g2g", days: 180, title, packPrice: 0.95, unitPrice: 0.19 }),
  );
  assert.deepStrictEqual(r, { externalId: "g2g-1", url: "https://g2g/g2g-1", price: 1 });
  assert.deepStrictEqual(env.mp.g2gResolveOfferShape.calls, [[{ brandId: "brand-rust" }]]);
  assert.deepStrictEqual(env.mp.g2gPublish.calls[0][0], {
    serviceId: "svc-game-items",
    brandId: "brand-rust",
    relationId: "rel-1",
    offerAttributes: [{ collection_id: "c-platform", dataset_id: "d-pc" }],
    collectionTree: ["tree-1"],
    title,
    description: FARM_DESC,
    priceUsd: 1,
    qty: 3,
    minQty: 1,
  });
  assert.strictEqual(env.deps.setImage.buildPromoCoverImage.calls.length, 0, "G2G takes no cover");
});

test("farm refusals: the title must round-trip through the farm parser (CONTRACT I5)", async () => {
  const cases = [
    ["no Automatic Farming", { title: "Rust Twitch Drops 120 Days — PACK OF 5 ACCOUNTS" }, /must contain "Automatic Farming"/],
    ["no pack in the title", { title: "Rust Twitch Drops Automatic Farming 120 Days" }, /must say "PACK OF 5"/],
    ["a single account's price for the pack", { packPrice: 2.85, unitPrice: 2.85 }, /does not add up/],
    ["a pack of one", { minQty: 1 }, /minQty/],
    ["a term the parser reads differently", { days: 180 }, /read this title as 120 days, not 180/],
    ["a game the parser reads differently", { game: "Rust Console" }, /read this title's game as "Rust"/],
    ["Gameflip (not in v1)", { market: "gameflip" }, /not supported for farming packs/],
    ["no game", { game: "" }, /needs its game/],
    ["zero days", { days: 0 }, /days must be/],
    ["no pack on offer", { quantity: 0 }, /quantity \(packs on the offer\)/],
    ["a title G2G would cut", { market: "g2g", title: FARM_TITLE_120 + "x".repeat(70) }, /cuts titles at 128/],
    [
      "no G2G brand",
      { market: "g2g", game: "Apex Legends", title: "Apex Legends Twitch Drops Automatic Farming 120 Days — PACK OF 5 ACCOUNTS" },
      /no hand-checked G2G brand/,
    ],
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

// PACKS-2 §3/§5: the pack covers are setImage's newer builders — reached
// lazily, with today's covers as the fallback when they are absent, fail or
// build nothing.
test("coverForSet with a pack: setImage.buildBulkCoverImage(set, {packSize, discountPct}), else the grid", async () => {
  const bulk = spy(async () => "/tmp/bulk-set-test.png");
  let env = setup({
    deps: {
      setImage: {
        buildSetGridImage: spy(async () => "/tmp/set-grid-test.png"),
        buildBulkCoverImage: bulk,
      },
    },
  });
  assert.strictEqual(await markets.coverForSet(SET, { packSize: 5, discountPct: 5 }), "/tmp/bulk-set-test.png");
  assert.deepStrictEqual(bulk.calls, [[SET, { packSize: 5, discountPct: 5 }]]);
  assert.strictEqual(env.deps.setImage.buildSetGridImage.calls.length, 0);
  // No pack asked for: today's grid, the pack builder untouched.
  assert.strictEqual(await markets.coverForSet(SET), "/tmp/set-grid-test.png");
  assert.strictEqual(await markets.coverForSet(SET, { packSize: 1 }), "/tmp/set-grid-test.png");
  assert.strictEqual(bulk.calls.length, 1);
  // A junk discount reaches the builder as 0.
  await markets.coverForSet(SET, { packSize: "10", discountPct: "x" });
  assert.deepStrictEqual(bulk.calls[1], [SET, { packSize: 10, discountPct: 0 }]);

  // The builder is missing (the setImage module predates it), builds nothing,
  // or throws: the plain grid, every time.
  for (const pack of [undefined, spy(async () => ""), spy(async () => { throw new Error("sharp exploded"); })]) {
    env = setup({
      deps: {
        setImage: {
          buildSetGridImage: spy(async () => "/tmp/set-grid-test.png"),
          ...(pack ? { buildBulkCoverImage: pack } : {}),
        },
      },
    });
    const q = quietConsole();
    try {
      assert.strictEqual(await markets.coverForSet(SET, { packSize: 5, discountPct: 5 }), "/tmp/set-grid-test.png");
    } finally {
      q.restore();
    }
    assert.strictEqual(env.deps.setImage.buildSetGridImage.calls.length, 1);
  }
});

test("coverForFarm with a pack: setImage.buildBulkFarmCoverImage(game, days, {packSize, discountPct, itemImages}), else the promo", async () => {
  const bulk = spy(async () => "/tmp/bulk-farm-test.png");
  let env = setup({
    deps: {
      setImage: {
        buildPromoCoverImage: spy(async () => "/tmp/promo-cover-test.png"),
        buildBulkFarmCoverImage: bulk,
      },
    },
  });
  assert.strictEqual(
    await markets.coverForFarm("Rust", 365, { packSize: 10, discountPct: 10 }),
    "/tmp/bulk-farm-test.png",
  );
  assert.deepStrictEqual(bulk.calls, [
    ["Rust", 365, { packSize: 10, discountPct: 10, itemImages: ["/drop-images/a.png", "/drop-images/b.png"] }],
  ]);
  assert.strictEqual(env.deps.setImage.buildPromoCoverImage.calls.length, 0);

  for (const pack of [undefined, spy(async () => ""), spy(async () => { throw new Error("font missing"); })]) {
    env = setup({
      deps: {
        setImage: {
          buildPromoCoverImage: spy(async () => "/tmp/promo-cover-test.png"),
          ...(pack ? { buildBulkFarmCoverImage: pack } : {}),
        },
      },
    });
    const q = quietConsole();
    try {
      assert.strictEqual(await markets.coverForFarm("Rust", 120, { packSize: 5, discountPct: 5 }), "/tmp/promo-cover-test.png");
    } finally {
      q.restore();
    }
    assert.strictEqual(env.deps.setImage.buildPromoCoverImage.calls[0][0].serviceText, "120 Days Service");
  }
});

test("farm eldorado publish uses the pack cover (and removes it afterwards) when the builder exists", async () => {
  const bulk = spy(async () => "/tmp/bulk-farm-test.png");
  const env = setup({
    deps: {
      setImage: {
        buildPromoCoverImage: spy(async () => "/tmp/promo-cover-test.png"),
        buildBulkFarmCoverImage: bulk,
      },
    },
  });
  await markets.publishFarm(farmArgs({ discountPct: 5 }));
  assert.deepStrictEqual(bulk.calls[0].slice(0, 2), ["Rust", 120]);
  assert.deepStrictEqual(
    { packSize: bulk.calls[0][2].packSize, discountPct: bulk.calls[0][2].discountPct },
    { packSize: 5, discountPct: 5 },
  );
  assert.strictEqual(env.mp.eldoradoPublish.calls[0][0].coverImagePath, "/tmp/bulk-farm-test.png");
  assert.deepStrictEqual(env.deps.fsp.unlink.calls, [["/tmp/bulk-farm-test.png"]], "temp cover removed");
});

/* ---------------- 9. Publish outcomes (FIXES-1 S2/S5) -------------------- */
//
// Every publish throw carries `outcome` ("not_created" -> the caller releases;
// "may_be_live" -> it HOLDS the accounts) and `externalId` when known. Each
// fake below throws the exact shape utils/marketplaces.js throws at that step —
// message AND status — so these verdicts are the ones the real connectors get.
// The last test here pins those texts to the connector source.

// apiError (marketplaces.js:160-170): "<prefix>: <body json>", status from the response.
function gfError(prefix, status, body) {
  const e = new Error(prefix + ": " + JSON.stringify(body || { status: "FAILURE" }));
  e.status = status;
  return e;
}

// eldError (marketplaces.js:4347-4370).
function eldError(label, status, detail) {
  const e = new Error(
    label + " failed" + (status ? " (HTTP " + status + ")" : "") + (detail ? ": " + detail : ""),
  );
  e.__eld = true;
  e.status = status;
  return e;
}

// g2gError (marketplaces.js:2636-2659).
function g2gError(what, status, detail) {
  const e = new Error(what + " failed" + (status ? " (HTTP " + status + ")" : "") + ": " + detail);
  e.__g2g = true;
  e.status = status;
  return e;
}

// A spy that throws a FRESH error from `make` on every call.
function throwing(make) {
  return spy(async () => {
    throw make();
  });
}

async function thrown(promise) {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  return assert.fail("the publish was expected to throw");
}

async function quietly(fn) {
  const q = quietConsole();
  try {
    return await fn();
  } finally {
    q.restore();
  }
}

function gfPackArgs(env) {
  const list = units(5);
  seedAccounts(env, list);
  return accountArgs({ market: "gameflip", title: PACK_TITLE, units: list, packPrice: 5.5, unitPrice: 0 });
}

const GF_RATE = { status: "FAILURE", error: { code: 429, message: "Too many attempts - Retry later" } };
// marketplaces.js:420-425 — the listing exists; its own discard may have failed.
const gfOnsaleError = () => gfError("Gameflip created L9 but could not put it on sale (draft discarded)", 429, GF_RATE);
// marketplaces.js:351-356 — the delivery code PUT failed on a created draft.
const gfCodeError = () =>
  gfError("Gameflip could not attach the delivery content (draft D7 discarded)", 400, {
    status: "FAILURE",
    error: { code: 400, message: "code for digital goods already exists" },
  });

test("S2: a refusal, or any failure before the market call, is not_created", async () => {
  let env = setup();
  let err = await thrown(markets.publishAccounts(accountArgs({ market: "plati" })));
  assert.strictEqual(err.code, "BULK_PACK_REFUSED", "a refusal keeps its code");
  assert.strictEqual(err.outcome, "not_created");
  assert.strictEqual(err.externalId, "");

  // The pack's password read fails: nothing reached Gameflip.
  env = setup({
    deps: {
      BotAccount: {
        find: () => ({
          lean: async () => {
            throw new Error("db down");
          },
        }),
      },
    },
  });
  err = await thrown(
    markets.publishAccounts(accountArgs({ market: "gameflip", title: PACK_TITLE, units: units(5), packPrice: 5 })),
  );
  assert.strictEqual(err.outcome, "not_created");
  assert.notStrictEqual(err.code, "BULK_PACK_REFUSED");
  assert.strictEqual(env.mp.gameflipPublish.calls.length, 0);

  setup();
  err = await thrown(markets.publishFarm(farmArgs({ days: 180 })));
  assert.strictEqual(err.outcome, "not_created");
  err = await thrown(markets.publishNoclaim(noclaimArgs({ quantity: 0 })));
  assert.strictEqual(err.outcome, "not_created");
});

test("S5 gameflip: an error before a listing id exists is not_created, and nothing is taken down", async () => {
  const cases = [
    ["no keys", () => new Error("gameflip is not configured — set its API keys first")],
    ["price floor", () => new Error("Gameflip minimum price is $0.75")],
    ["the create answered 429", () => gfError("Gameflip create", 429, GF_RATE)],
    ["the create timed out", () => new Error("Gameflip create: timeout of 30000ms exceeded")],
    // listingId undefined: the patch and the code went to /listing/undefined.
    ["no id in the create response", () => new Error("Gameflip created undefined but could not put it on sale (draft discarded): x")],
  ];
  for (const [name, make] of cases) {
    const env = setup({ mp: fakeMp({ gameflipPublish: throwing(make) }) });
    const err = await thrown(markets.publishAccounts(gfPackArgs(env)));
    assert.strictEqual(err.outcome, "not_created", name);
    assert.strictEqual(err.externalId, "", name);
    assert.notStrictEqual(err.code, "BULK_PACK_REFUSED", name);
    assert.strictEqual(env.mp.gameflipDelist.calls.length, 0, name + ": nothing to take down");
  }
});

test("S5 gameflip: a listing that exists after the throw is taken down (gameflipDelist) — done -> not_created", async () => {
  for (const [make, id] of [[gfOnsaleError, "L9"], [gfCodeError, "D7"]]) {
    const env = setup({ mp: fakeMp({ gameflipPublish: throwing(make) }) });
    const err = await thrown(markets.publishAccounts(gfPackArgs(env)));
    assert.deepStrictEqual(env.mp.gameflipDelist.calls, [[id]], "the real draft-then-delete delist");
    assert.strictEqual(err.outcome, "not_created", id);
    assert.strictEqual(err.externalId, id);
    assert.deepStrictEqual(err.cleanup, { tried: true, ok: true, error: "" });
    assert.match(err.message, /discarded.*taken down again/);
  }
});

test("S5 gameflip: the take-down answers 404 (Gameflip's own discard took) -> not_created", async () => {
  const env = setup({
    mp: fakeMp({
      gameflipPublish: throwing(gfOnsaleError),
      gameflipDelist: throwing(() =>
        gfError("Gameflip delist", 404, { status: "FAILURE", error: { code: 404, message: "Not found" } }),
      ),
    }),
  });
  const err = await thrown(markets.publishAccounts(gfPackArgs(env)));
  assert.deepStrictEqual(env.mp.gameflipDelist.calls, [["L9"]]);
  assert.strictEqual(err.outcome, "not_created");
  assert.strictEqual(err.externalId, "L9");
  assert.match(err.message, /no longer exists on Gameflip \(404\)/);
});

test("S5 gameflip: the take-down fails -> may_be_live + the listing id (the pack may be on sale)", async () => {
  const failures = [
    ["rate limited", () => gfError("Gameflip delist", 429, GF_RATE), /may be ON SALE/],
    ["timed out", () => new Error("Gameflip delist: timeout of 20000ms exceeded"), /may be ON SALE/],
    ["already sold", () => gfError("Gameflip delist", 400, { message: "listing (sold)" }), /already SOLD/],
  ];
  for (const [make, id] of [[gfOnsaleError, "L9"], [gfCodeError, "D7"]]) {
    for (const [name, fail, re] of failures) {
      const env = setup({
        mp: fakeMp({ gameflipPublish: throwing(make), gameflipDelist: throwing(fail) }),
      });
      const err = await quietly(() => thrown(markets.publishAccounts(gfPackArgs(env))));
      assert.deepStrictEqual(env.mp.gameflipDelist.calls, [[id]], name);
      assert.strictEqual(err.outcome, "may_be_live", id + " / " + name);
      assert.strictEqual(err.externalId, id, name);
      assert.strictEqual(err.cleanup.ok, false, name);
      assert.match(err.message, re, name);
      assert.notStrictEqual(err.code, "BULK_PACK_REFUSED");
    }
  }
});

test("S5 gameflip: an unrecognised publish error is may_be_live with no id, and nothing is called", async () => {
  const env = setup({ mp: fakeMp({ gameflipPublish: throwing(() => new Error("something new broke")) }) });
  const err = await thrown(markets.publishAccounts(gfPackArgs(env)));
  assert.strictEqual(err.outcome, "may_be_live");
  assert.strictEqual(err.externalId, "");
  assert.strictEqual(env.mp.gameflipDelist.calls.length, 0);
});

test("S5 gameflip: an accepted publish with no listing id is may_be_live", async () => {
  const env = setup({ mp: fakeMp({ gameflipPublish: spy(async () => ({ url: "" })) }) });
  const err = await quietly(() => thrown(markets.publishAccounts(gfPackArgs(env))));
  assert.strictEqual(err.outcome, "may_be_live");
  assert.strictEqual(err.externalId, "");
  assert.match(err.message, /no offer id/);
});

const g2gAccountArgs = () => accountArgs({ market: "g2g", units: units(5) });
const G2G_FARM_TITLE = "Rust Twitch Drops Automatic Farming 180 Days — PACK OF 5";
const g2gFarmArgs = () => farmArgs({ market: "g2g", days: 180, title: G2G_FARM_TITLE });

test("S5 g2g: everything before the create, and the create itself (an empty shell), is not_created", async () => {
  const cases = [
    () => new Error("g2g is not configured — set its API keys first"),
    () => new Error("G2G brand_id is required (the game)"),
    () => new Error("G2G needs a price above 0"),
    () => new Error("G2G's minimum price is 1.00"),
    () => g2gError("G2G list offers", 503, "Service Unavailable"),
    () => g2gError("G2G relation", undefined, "timeout of 30000ms exceeded"),
    () => g2gError("G2G collections", 500, "boom"),
    () => new Error("G2G: no product (relation_id) for brand brand-rust under Game Items — this game cannot be listed there"),
    () => new Error("G2G needs Platform for this game and we have no offer of our own to copy it from."),
    () => g2gError("G2G product settings", 502, "Bad Gateway"),
    () => new Error("G2G: no delivery method available for this game — cannot publish"),
    () => new Error("G2G refresh: no session stored — paste a G2G session once"),
    () => g2gError("G2G refresh", 400, "invalid refresh token"),
    () => g2gError("G2G create offer", 500, "Internal Server Error"),
    () => g2gError("G2G create offer", undefined, "timeout of 30000ms exceeded"),
    () => new Error("G2G create: no offer id in response: {}"),
  ];
  for (const make of cases) {
    for (const [path_, args] of [["accounts", g2gAccountArgs], ["farm", g2gFarmArgs]]) {
      const env = setup({ mp: fakeMp({ g2gPublish: throwing(make) }) });
      const err = await thrown(
        path_ === "farm" ? markets.publishFarm(args()) : markets.publishAccounts(args()),
      );
      assert.strictEqual(err.outcome, "not_created", path_ + ": " + err.message);
      assert.strictEqual(err.externalId, "");
      assert.strictEqual(env.mp.g2gDelist.calls.length, 0, err.message);
    }
  }
});

test("S5 g2g: the PUT that fills the shell — an answered rejection is not_created, a write that may have landed is may_be_live", async () => {
  const cases = [
    [() => g2gError("G2G publish offer", 400, "Missing mandatory parameter: currency"), "not_created"],
    [() => g2gError("G2G publish offer", 401, "unauthorised"), "not_created"],
    [() => g2gError("G2G publish offer", 429, "Too many requests"), "not_created"],
    // 200 with an in-band error code (marketplaces.js:2786-2794): no status, answered.
    [() => new Error("G2G publish offer failed: Invalid unit price"), "not_created"],
    [() => g2gError("G2G publish offer", 502, "Bad Gateway"), "may_be_live"],
    [() => g2gError("G2G publish offer", undefined, "timeout of 30000ms exceeded"), "may_be_live"],
    [() => g2gError("G2G publish offer", undefined, "socket hang up"), "may_be_live"],
    [() => g2gError("G2G publish offer", undefined, "read ECONNRESET"), "may_be_live"],
  ];
  for (const [make, want] of cases) {
    const env = setup({ mp: fakeMp({ g2gPublish: throwing(make) }) });
    const err = await thrown(markets.publishAccounts(g2gAccountArgs()));
    assert.strictEqual(err.outcome, want, err.message);
    assert.strictEqual(err.externalId, "", "the PUT's message does not carry the id");
    assert.strictEqual(env.mp.g2gDelist.calls.length, 0);
  }
});

test("S5 g2g: an offer that did not read back is delisted (g2gDelist) — done -> not_created, failed -> may_be_live + id", async () => {
  // The reviewers' repro: review-ssm/g2gReadbackOrphan.test.js.
  const readBack = () => new Error("G2G publish: offer G2G-777 did not read back as a live offer");
  for (const [path_, run] of [
    ["accounts", () => markets.publishAccounts(g2gAccountArgs())],
    ["farm", () => markets.publishFarm(g2gFarmArgs())],
  ]) {
    let env = setup({ mp: fakeMp({ g2gPublish: throwing(readBack) }) });
    let err = await thrown(run());
    assert.deepStrictEqual(env.mp.g2gDelist.calls, [["G2G-777"]], path_);
    assert.strictEqual(err.outcome, "not_created", path_);
    assert.strictEqual(err.externalId, "G2G-777");
    assert.deepStrictEqual(err.cleanup, { tried: true, ok: true, error: "" });
    assert.match(err.message, /did not read back.*was delisted/);

    env = setup({
      mp: fakeMp({
        g2gPublish: throwing(readBack),
        g2gDelist: throwing(() => g2gError("G2G update offer", 429, "Too many requests")),
      }),
    });
    err = await quietly(() => thrown(run()));
    assert.deepStrictEqual(env.mp.g2gDelist.calls, [["G2G-777"]]);
    assert.strictEqual(err.outcome, "may_be_live", path_);
    assert.strictEqual(err.externalId, "G2G-777");
    assert.strictEqual(err.cleanup.ok, false);
    assert.match(err.message, /may be LIVE/);
  }
});

test("S5 g2g: an unrecognised error is may_be_live with no id", async () => {
  const env = setup({ mp: fakeMp({ g2gPublish: throwing(() => new Error("G2G said something new")) }) });
  const err = await thrown(markets.publishAccounts(g2gAccountArgs()));
  assert.strictEqual(err.outcome, "may_be_live");
  assert.strictEqual(err.externalId, "");
  assert.strictEqual(env.mp.g2gDelist.calls.length, 0);
});

test("S5 eldorado: the create POST — 4xx (incl. 429) is not_created; 5xx, no status or a timeout is may_be_live (no id)", async () => {
  const cases = [
    [() => eldError("Eldorado publish", 400, "Offer main image is missing."), "not_created"],
    [() => eldError("Eldorado publish", 401, "session not accepted"), "not_created"],
    [() => eldError("Eldorado publish", 429), "not_created"],
    [() => new Error("Eldorado publish failed (HTTP 429)"), "not_created"], // status only in the text
    [() => eldError("Eldorado publish", 500, "Internal Server Error"), "may_be_live"],
    [() => eldError("Eldorado publish", 503), "may_be_live"],
    [() => eldError("Eldorado publish", undefined, "timeout of 45000ms exceeded"), "may_be_live"],
    // The offer was created; saving the renewed cookie after it failed.
    [() => eldError("Eldorado publish", undefined, "EACCES: permission denied, open 'settings.json'"), "may_be_live"],
  ];
  for (const [make, want] of cases) {
    for (const [path_, run] of [
      ["accounts", () => markets.publishAccounts(accountArgs())],
      ["farm", () => markets.publishFarm(farmArgs())],
    ]) {
      setup({ mp: fakeMp({ eldoradoPublish: throwing(make) }) });
      const err = await thrown(run());
      assert.strictEqual(err.outcome, want, path_ + ": " + err.message);
      assert.strictEqual(err.externalId, "", "Eldorado's errors carry no offer id");
    }
  }
});

test("S5 eldorado: every step before the create POST is not_created, whatever its status", async () => {
  const LIB = "https://www.eldorado.gg/api/library/235/CustomItem?locale=en-US";
  const cases = [
    () => new Error("eldorado is not configured — set its API keys first"),
    () => new Error("Eldorado: a title is required"),
    () => new Error("Eldorado: a cover image is required (the API rejects offers without one)"),
    () => new Error("Eldorado: could not resolve a Twitch Drops game slot"),
    () => eldError("Eldorado image upload", 503, "Service Unavailable"),
    () => eldError("Eldorado image upload", undefined, "timeout of 90000ms exceeded"),
    () => new Error("Eldorado image upload returned no paths"),
    () => new Error("Eldorado: invalid price"),
    () => eldError("Eldorado session refresh", 401, "session not accepted"),
    // The trade-environment library READ: a raw AxiosError, not wrapped by eldError.
    () => Object.assign(new Error("timeout of 45000ms exceeded"), { isAxiosError: true, code: "ECONNABORTED", config: { url: LIB } }),
    () => Object.assign(new Error("Request failed with status code 502"), { isAxiosError: true, status: 502, config: { url: LIB } }),
  ];
  for (const make of cases) {
    setup({ mp: fakeMp({ eldoradoPublish: throwing(make) }) });
    const err = await thrown(markets.publishAccounts(accountArgs()));
    assert.strictEqual(err.outcome, "not_created", err.message);
  }
});

test("S5 eldorado: an unrecognised error follows the status rule; an id-less success is may_be_live", async () => {
  setup({ mp: fakeMp({ eldoradoPublish: throwing(() => Object.assign(new Error("odd"), { status: 403 })) }) });
  assert.strictEqual((await thrown(markets.publishAccounts(accountArgs()))).outcome, "not_created");
  setup({ mp: fakeMp({ eldoradoPublish: throwing(() => new Error("odd")) }) });
  assert.strictEqual((await thrown(markets.publishAccounts(accountArgs()))).outcome, "may_be_live");
  setup({ mp: fakeMp({ eldoradoPublish: spy(async () => ({ url: "" })) }) });
  const err = await quietly(() => thrown(markets.publishFarm(farmArgs())));
  assert.strictEqual(err.outcome, "may_be_live");
  assert.strictEqual(err.externalId, "");
});

// The no-claim layer answers {success:false, message} — the connector's
// status is gone, so the MESSAGE is what gets judged.
function noclaimLayer(answer) {
  return {
    noclaimListings: {
      publishNoclaim: spy(async () => (typeof answer === "string" ? { success: false, message: answer } : answer)),
    },
  };
}

const NC_G2G_SET = { ...NC_SET, coverGame: "Rust", items: [{ name: "Hoodie", game: "Rust" }] };
const ncG2gArgs = () =>
  noclaimArgs({
    market: "g2g",
    set: NC_G2G_SET,
    game: "Rust",
    title: G2G_TEN_TITLE,
    unitPrice: 1.5,
    packPrice: 15,
    quantity: 1,
    minQty: 10,
  });

test("S5 no-claim: the layer's own refusals are not_created; its orphan is may_be_live + the offer id", async () => {
  for (const message of [
    "No-claim listings are switched off",
    "No-claim auto-delivery is switched off",
    "Zeusx is not supported for no-claim listings yet — use Gameflip, GGSel, Plati, Eldorado, PlayerAuctions or G2G",
    "Not a no-claim listing — it has no no-claim stock to deliver",
    "Out of stock — no free no-claim account holds this whole bundle right now",
    "Could not count the no-claim stock right now: snapshot unreadable",
    "All 7 free account(s) for this bundle are already advertised by your other no-claim listings — delist one first, or wait for more stock",
  ]) {
    setup({ deps: noclaimLayer(message) });
    const err = await thrown(markets.publishNoclaim(noclaimArgs()));
    assert.strictEqual(err.outcome, "not_created", message);
    assert.strictEqual(err.message, message, "the layer's words reach the owner unchanged");
  }
  setup({ deps: noclaimLayer("published on Eldorado but the row could not be saved — delist it by hand: E77") });
  let err = await thrown(markets.publishNoclaim(noclaimArgs()));
  assert.strictEqual(err.outcome, "may_be_live");
  assert.strictEqual(err.externalId, "E77");
  setup({
    deps: noclaimLayer(
      "published on G2G but the row could not be saved — delist it by hand: (the platform returned no id)",
    ),
  });
  err = await thrown(markets.publishNoclaim(ncG2gArgs()));
  assert.strictEqual(err.outcome, "may_be_live");
  assert.strictEqual(err.externalId, "", "orphanedPublish's no-id placeholder is not an id");
});

test("S5 no-claim: a market error the layer passes on is judged by its market's rules, from its text", async () => {
  const eldorado = [
    ["Eldorado publish failed (HTTP 400): Offer main image is missing.", "not_created"],
    ["Eldorado publish failed (HTTP 429)", "not_created"],
    ["Eldorado publish failed (HTTP 503): Service Unavailable", "may_be_live"],
    ["Eldorado publish failed: timeout of 45000ms exceeded", "may_be_live"],
    ["Eldorado image upload failed (HTTP 500): boom", "not_created"],
    ["Eldorado: could not resolve a Twitch Drops game slot", "not_created"],
    ["Cannot read properties of undefined (reading 'externalId')", "may_be_live"],
  ];
  for (const [message, want] of eldorado) {
    setup({ deps: noclaimLayer(message) });
    assert.strictEqual((await thrown(markets.publishNoclaim(noclaimArgs()))).outcome, want, message);
  }
  const g2g = [
    ["G2G create offer failed (HTTP 500): boom", "not_created"],
    ["G2G publish offer failed (HTTP 400): Missing mandatory parameter: currency", "not_created"],
    ["G2G publish offer failed: timeout of 30000ms exceeded", "may_be_live"],
    ["G2G publish offer failed (HTTP 504): Gateway Timeout", "may_be_live"],
    ["G2G product settings failed (HTTP 500): boom", "not_created"],
  ];
  for (const [message, want] of g2g) {
    const env = setup({ deps: noclaimLayer(message) });
    assert.strictEqual((await thrown(markets.publishNoclaim(ncG2gArgs()))).outcome, want, message);
    assert.strictEqual(env.mp.g2gDelist.calls.length, 0);
  }
  // A read-back failure through the layer is taken down exactly like a direct one.
  let env = setup({ deps: noclaimLayer("G2G publish: offer G5 did not read back as a live offer") });
  let err = await thrown(markets.publishNoclaim(ncG2gArgs()));
  assert.deepStrictEqual(env.mp.g2gDelist.calls, [["G5"]]);
  assert.strictEqual(err.outcome, "not_created");
  assert.strictEqual(err.externalId, "G5");
  env = setup({
    mp: fakeMp({ g2gDelist: throwing(() => g2gError("G2G update offer", undefined, "socket hang up")) }),
    deps: noclaimLayer("G2G publish: offer G5 did not read back as a live offer"),
  });
  err = await quietly(() => thrown(markets.publishNoclaim(ncG2gArgs())));
  assert.strictEqual(err.outcome, "may_be_live");
  assert.strictEqual(err.externalId, "G5");
  // The layer throwing instead of answering is judged the same way.
  setup({
    deps: {
      noclaimListings: {
        publishNoclaim: throwing(() => new Error("Eldorado publish failed (HTTP 502): Bad Gateway")),
      },
    },
  });
  assert.strictEqual((await thrown(markets.publishNoclaim(noclaimArgs()))).outcome, "may_be_live");
});

test("S5 no-claim: a success missing either id is may_be_live, naming what is known", async () => {
  // "undefined" is what the layer writes when Eldorado answered without an id.
  setup({ deps: noclaimLayer({ success: true, id: "row-1", externalId: "undefined", url: "" }) });
  let err = await quietly(() => thrown(markets.publishNoclaim(noclaimArgs())));
  assert.strictEqual(err.outcome, "may_be_live");
  assert.strictEqual(err.externalId, "");
  assert.strictEqual(err.rowId, "row-1");
  setup({ deps: noclaimLayer({ success: true, id: "", externalId: "nc-9" }) });
  err = await quietly(() => thrown(markets.publishNoclaim(noclaimArgs())));
  assert.strictEqual(err.outcome, "may_be_live");
  assert.strictEqual(err.externalId, "nc-9");
});

test("S5: the connector texts the verdicts key on are still the ones the connectors throw", () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", "utils", f), "utf8");
  const pins = {
    "marketplaces.js": [
      'marketplace + " is not configured — set its API keys first"',
      '"Gameflip minimum price is $0.75"',
      'apiError("Gameflip create", e)',
      '"Gameflip could not attach the delivery content (draft " +',
      '"Gameflip created " +',
      '" but could not put it on sale (draft discarded)"',
      'apiError("Gameflip delist", e)',
      'what: "G2G create offer"',
      '"G2G create: no offer id in response: "',
      'what: "G2G publish offer"',
      '"G2G publish: offer " + offerId + " did not read back as a live offer"',
      '"G2G: no delivery method available for this game — cannot publish"',
      'eldError("Eldorado publish", e)',
      'eldError("Eldorado image upload", e)',
      'eldError("Eldorado session refresh", e)',
      '"Eldorado: could not resolve a Twitch Drops game slot"',
      '" failed" + (status ? " (HTTP " + status + ")" : "")',
    ],
    "noclaimListings.js": [
      '" but the row could not be saved — delist it by hand: "',
      '"(the platform returned no id)"',
      '"Out of stock — no free no-claim account holds this whole bundle right now"',
      '"Could not count the no-claim stock right now: "',
      '" free account(s) for this bundle are already advertised by your other "',
    ],
    // The 404 the Gameflip take-down treats as "no such listing" is the one the
    // fulfiller already retires rows and releases accounts on.
    "gameflipFulfiller.js": ["if (e && e.status === 404) {"],
  };
  for (const [file, needles] of Object.entries(pins)) {
    const src = read(file);
    for (const n of needles) assert.ok(src.includes(n), "utils/" + file + " no longer contains " + n);
  }
});

/* ------------------------------ 10. Tripwires ---------------------------- */

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
