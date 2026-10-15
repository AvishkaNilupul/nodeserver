// Gameflip's Game Accounts category (utils/gameflipAccountCategory.js), built
// dark on 2026-10-15 while Gameflip reviews the approval application.
//
// What has to hold:
//   - switch off (the default, absent, anything but "ACCOUNT"): gameflipPublish
//     sends EXACTLY the body it always sent, byte for byte;
//   - switch on: the listing carries category ACCOUNT, a platform, the five
//     tags and, for a game Gameflip knows, its upc — and the delivery (the
//     code, the on-sale step) is untouched;
//   - the game comes off the title for every shape our titles take, and a game
//     Gameflip does not know is "other" — never a neighbour's id;
//   - a farming window is "Not Changeable" and an account sold outright
//     "Changeable", because that is what each buyer is told.
//
// The real gameflipPublish runs against stubbed axios and stubbed keys; nothing
// leaves the process.
process.env.CRED_SECRET = process.env.CRED_SECRET || "test-only-cred-secret";
process.env.TG_TOKEN = "";
const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const settings = require("../utils/settings");
const { encrypt } = require("../utils/secretBox");

let AF = {};
const orig = {
  loadSettings: settings.loadSettings,
  getAutoFarm: settings.getAutoFarm,
  post: axios.post,
  put: axios.put,
  patch: axios.patch,
  get: axios.get,
  delete: axios.delete,
};
// Before marketplaces.js loads: it takes loadSettings at require time.
settings.loadSettings = () => ({
  marketplaces: {
    gameflip: { apiKey: encrypt("test-key"), apiSecret: encrypt("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP") },
  },
});
settings.getAutoFarm = () => ({ ...AF });
const mp = require("../utils/marketplaces");
const gac = require("../utils/gameflipAccountCategory");

let calls = [];
test.before(() => {
  axios.post = async (url, body) => {
    calls.push(["post", url, body]);
    return { data: { data: { id: "gf-test-1" } } };
  };
  axios.put = async (url, body) => {
    calls.push(["put", url, body]);
    return { data: {} };
  };
  axios.patch = async (url, body) => {
    calls.push(["patch", url, body]);
    return { data: {} };
  };
  axios.get = async (url) => {
    calls.push(["get", url]);
    return { data: { data: { status: "onsale" } } };
  };
  axios.delete = async (url) => {
    calls.push(["delete", url]);
    return { data: {} };
  };
});

test.after(() => {
  Object.assign(axios, { post: orig.post, put: orig.put, patch: orig.patch, get: orig.get, delete: orig.delete });
  settings.loadSettings = orig.loadSettings;
  settings.getAutoFarm = orig.getAutoFarm;
});

const TITLE = "Rocket League Twitch Drops (10 Items) — RLCS 2025 Import Drop +9 more";
const DESC = "Bundle text";
const CODE = "TWITCH DROP ACCOUNT\n\nLogin: someone\nPassword: secret";

// The body gameflipPublish sent before this change, field for field and in the
// same order (utils/marketplaces.js, gameflipPublish).
function todayBody({ title = TITLE, auto = true } = {}) {
  return {
    kind: "item",
    name: title,
    description: DESC,
    category: auto ? "UNKNOWN" : "DIGITAL_INGAME",
    platform: "unknown",
    price: 150,
    accept_currency: "USD",
    shipping_within_days: auto ? 0 : 3,
    expire_in_days: 30,
    shipping_fee: 0,
    shipping_paid_by: "seller",
    shipping_predefined_package: "None",
    digital: true,
    digital_region: "none",
    digital_fee_included: false,
    digital_deliverable: auto ? "code" : "transfer",
    tags: ["twitch", "drops"],
  };
}

async function publish(extra = {}, { auto = true } = {}) {
  calls = [];
  const r = await mp.gameflipPublish({
    title: TITLE,
    description: DESC,
    priceUsd: 1.5,
    ...(auto ? { autoDeliverCode: CODE } : {}),
    ...extra,
  });
  const post = calls.find((c) => c[0] === "post");
  return { r, body: post && post[2] };
}

/* ------------------------------ switch off ------------------------------ */

test("switch off: the create body is byte-for-byte what it always was", async () => {
  for (const af of [{}, { gameflipCategory: "UNKNOWN" }, { gameflipCategory: "" }, { gameflipCategory: "yes" }, { gameflipCategory: true }]) {
    AF = af;
    const { r, body } = await publish();
    assert.equal(JSON.stringify(body), JSON.stringify(todayBody()), JSON.stringify(af));
    assert.equal(r.externalId, "gf-test-1");
    const { body: manual } = await publish({}, { auto: false });
    assert.equal(JSON.stringify(manual), JSON.stringify(todayBody({ auto: false })), JSON.stringify(af));
  }
});

test("switch off: a game or farm hint changes nothing", async () => {
  AF = {};
  const { body } = await publish({ game: "Fortnite", farm: true });
  assert.equal(JSON.stringify(body), JSON.stringify(todayBody()));
});

test("the shipped default is UNKNOWN, with the upc on and no platform overrides", () => {
  const D = orig.getAutoFarm.call(settings);
  assert.equal(D.gameflipCategory, "UNKNOWN");
  assert.equal(D.gameflipAccountUpc, true);
  assert.deepEqual(D.gameflipAccountPlatforms, {});
  assert.equal(gac.listingFields({ title: TITLE, auto: true, af: D }), null);
});

/* ------------------------------ switch on ------------------------------- */

test("switch on: Game Accounts fields over the same body; delivery untouched", async () => {
  AF = { gameflipCategory: "ACCOUNT" };
  const { r, body } = await publish();
  const want = {
    ...todayBody(),
    category: "ACCOUNT",
    platform: "windows",
    shipping_within_days: 1,
    tags: ["id: 11198", "title: Rocket League", "profile: Changeable", "password: Changeable", "email: Not Included"],
    upc: "GAME000011198",
  };
  assert.deepEqual(body, want);
  assert.equal(r.externalId, "gf-test-1");
  // the code goes on exactly as before, then the listing goes on sale
  const put = calls.find((c) => c[0] === "put");
  assert.match(put[1], /\/listing\/gf-test-1\/digital_goods$/);
  assert.deepEqual(put[2], { code: CODE });
  const patch = calls.find((c) => c[0] === "patch");
  assert.deepEqual(patch[2], [{ op: "replace", path: "/status", value: "onsale" }]);
});

test("switch on, any case: \"account\" is the same switch", async () => {
  AF = { gameflipCategory: " account " };
  const { body } = await publish();
  assert.equal(body.category, "ACCOUNT");
});

test("switch on: a listing without a code is filed there too, still delivered by hand", async () => {
  AF = { gameflipCategory: "ACCOUNT" };
  const { body } = await publish({}, { auto: false });
  assert.equal(body.category, "ACCOUNT");
  assert.equal(body.digital_deliverable, "transfer");
  assert.equal(body.shipping_within_days, 3);
  assert.equal(body.tags.length, 5);
});

test("switch on: the caller's game and farm flag win over the title", async () => {
  AF = { gameflipCategory: "ACCOUNT" };
  const { body } = await publish({ game: "Fortnite", farm: true });
  assert.deepEqual(body.tags, ["id: 1905", "title: Fortnite", "profile: Not Changeable", "password: Not Changeable", "email: Not Included"]);
  assert.equal(body.upc, "GAME000001905");
  const { body: notFarm } = await publish({ title: "Overwatch Twitch Drops Automatic Farming 1 Year", farm: false });
  assert.ok(notFarm.tags.includes("password: Changeable"));
});

/* ------------------------------ the game -------------------------------- */

const ON = { gameflipCategory: "ACCOUNT" };
const fields = (title, more = {}) => gac.listingFields({ title, auto: true, af: ON, ...more });
const idOf = (title, more) => fields(title, more).tags[0];
const nameOf = (title, more) => fields(title, more).tags[1];

test("the game comes off every shape our titles take", () => {
  const cases = [
    ["Rocket League Twitch Drops (10 Items) — RLCS 2025 Import Drop +9 more", "id: 11198", "title: Rocket League"],
    ["Overwatch Twitch Drops Automatic Farming 180 Days", "id: 125174", "title: Overwatch 2"],
    ["Escape from Tarkov bundle (18 items)— KORD BREACH S1 Drops All 18/18 Items", "id: 15536", "title: Escape from Tarkov"],
    ["Rocket League bundle — RLCS 2025 Import Drop, RLCS 2025 Very Rare Drop +10 more (24 items)", "id: 11198", "title: Rocket League"],
    ["Fortnite twitch bundle — Wipeout Harley Spray (3 items)", "id: 1905", "title: Fortnite"],
    ["Fortnite Twitch Drop  — The Helm Guitar (1 item)", "id: 1905", "title: Fortnite"],
    ["Halo Infinite Twitch bundle — Ultra Violent Visor +19 more (23 items)", "id: 103281", "title: Halo Infinite"],
    ["Call of Duty: Black Ops 7 Twitch bundle — Championship Chip Emblem (5 items+)", "id: 348220", "title: Call of Duty Black Ops 7"],
    ["THE FINALS Twitch Drops Automatic Farming 1 Year", "id: 214417", "title: The Finals"],
    ["EVE Online bundle — Prowler Hrada-Oki SKIN +9 more (11 items)", "id: 2584", "title: Eve Online"],
    ["Hunt: Showdown 1896 Twitch Drops (3 Items) — x", "id: 7291", "title: Hunt Showdown 1896"],
    ["Rocket League + THE FINALS + Tarkov + VAIL + Halo: CE + 1 more — 58 Twitch Drops", "id: 11198", "title: Rocket League"],
    ["⚡ 116x GOALS Twitch Drops (3 Items)", "id: other", "title: GOALS"],
    ["Rainbow Six Siege Twitch Drops (15 Items) — 14× Esports Pack", "id: other", "title: Rainbow Six Siege"],
    ["SMITE 2 Twitch Drop bundle (83 items +)", "id: other", "title: SMITE 2"],
    ["MARVEL Contest of Champions Twitch Drops (3 Items) — Drop 1", "id: other", "title: MARVEL Contest of Champions"],
  ];
  for (const [title, id, name] of cases) {
    assert.equal(idOf(title), id, title);
    assert.equal(nameOf(title), name, title);
  }
});

test("never a neighbour's id: only a whole game name matches", () => {
  for (const title of [
    "World of Tanks Console Twitch Drops (3 Items) — x",
    "World of Tanks: HEAT Twitch Drops (2 Items) — x",
    "Escape from Tarkov: Arena SOUER GAMES ShootOut #3 Twitch drop bundle  5+ Items",
    "Rustler - Grand Theft Horse Twitch Drops (1 Item)",
    "Halo: Campaign Evolved Twitch Drop — Stream of the Crop (1 item)",
    "Overwatch BlizzCon Day 1 Twitch Drops (4 Items)",
  ]) {
    assert.equal(idOf(title), "id: other", title);
    assert.equal(fields(title).upc, undefined, title);
  }
  assert.equal(idOf("Path of Exile 2 Twitch Drops (2 Items) — x"), "id: 125642");
  assert.equal(idOf("Path of Exile Twitch Drops (2 Items) — x"), "id: 1911");
  assert.equal(idOf("World of Tanks Twitch Drops (2 Items) — x"), "id: 1184");
});

test("nothing to read is still a valid listing: other, with a name", () => {
  assert.deepEqual(fields("").tags.slice(0, 2), ["id: other", "title: Twitch"]);
  assert.deepEqual(fields(undefined).tags.slice(0, 2), ["id: other", "title: Twitch"]);
  assert.equal(nameOf("A Very Long Game Name That Goes On And On Beyond Any Reasonable Length For A Tag Twitch Drops").length <= "title: ".length + 60, true);
});

/* ------------------------- what the buyer is told ------------------------ */

test("a farming window is Not Changeable; an account sold outright is Changeable; email never included", () => {
  const farm = fields("Rocket League Twitch Drops Automatic Farming 120 Days").tags;
  assert.deepEqual(farm.slice(2), ["profile: Not Changeable", "password: Not Changeable", "email: Not Included"]);
  const sold = fields(TITLE).tags;
  assert.deepEqual(sold.slice(2), ["profile: Changeable", "password: Changeable", "email: Not Included"]);
});

test("its name normalisation is settings.normGameName, exactly", () => {
  for (const n of ["Hunt: Showdown 1896", "  WORLD   OF-TANKS ", "Tom Clancy's The Division 2", "Pokémon GO", "Kirka.io", "THE FINALS", "", null, "⚡ 116x GOALS"]) {
    assert.equal(gac.norm(n), settings.normGameName(n), String(n));
  }
});

/* ------------------------------ the knobs ------------------------------- */

test("upc: only for a game Gameflip knows, and off with gameflipAccountUpc false", () => {
  assert.equal(fields(TITLE).upc, "GAME000011198");
  assert.equal(fields(TITLE, { af: { ...ON, gameflipAccountUpc: false } }).upc, undefined);
  assert.equal(fields("Rainbow Six Siege Twitch Drops").upc, undefined);
});

test("platform: windows unless the owner's map names a real platform for the game", () => {
  const af = { ...ON, gameflipAccountPlatforms: { fortnite: "crossplatform", "Rocket League": "nintendo_64" } };
  assert.equal(fields("Fortnite Twitch Drops (1 Item)", { af }).platform, "crossplatform");
  assert.equal(fields(TITLE, { af }).platform, "windows");
  assert.equal(fields("Warframe Twitch Drops (1 Item)", { af }).platform, "windows");
  // our label or Gameflip's name, either way
  const ow = { ...ON, gameflipAccountPlatforms: { Overwatch: "crossplatform" } };
  assert.equal(fields("Overwatch Twitch Drops (2 Items)", { af: ow }).platform, "crossplatform");
  const ow2 = { ...ON, gameflipAccountPlatforms: { "Overwatch 2": "crossplatform" } };
  assert.equal(fields("Overwatch Twitch Drops (2 Items)", { af: ow2 }).platform, "crossplatform");
});

test("shipping days: 1 for an instant code (as every Game Accounts listing read), untouched without one", () => {
  assert.equal(fields(TITLE).shipping_within_days, 1);
  assert.equal(gac.listingFields({ title: TITLE, auto: false, af: ON }).shipping_within_days, undefined);
});

test("the game table: unique ids, numeric, and no name that points at two games", () => {
  const ids = new Set();
  const names = new Map();
  for (const [id, title, ...aka] of gac.GAMES) {
    assert.match(id, /^\d+$/, title);
    assert.ok(!ids.has(id), "duplicate id " + id);
    ids.add(id);
    for (const n of [title, ...aka]) {
      const k = settings.normGameName(n);
      assert.ok(!names.has(k) || names.get(k) === id, "name " + n + " points at " + names.get(k) + " and " + id);
      names.set(k, id);
    }
  }
  assert.ok(gac.GAMES.length > 100);
});
