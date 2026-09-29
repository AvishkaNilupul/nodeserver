// Coverage for utils/bulkPacks/copy.js — no Mongo connection, no network, no
// settings file (docs/bulk-packs/API-UI.md "Tests" A2, CONTRACT I5, MODULES.md
// §copy.js):
//   1. Account titles: exact formats, every market's length limit (the suffix
//      is never the part cut), and they NEVER match the farm-title regex.
//   2. stripBulkSuffix undoes every suffix this module adds, and nothing else.
//   3. Account descriptions: the required buyer statements per market/source,
//      the DESC_MAX limit, and never a login or password.
//   4. Farm titles round-trip through the REAL parsers — the Eldorado farm
//      service's parseFarmOrder and the G2G one (which runs PlayerAuctions'
//      termToDays/canonicalGame) — for 120/180/365 days and long game names up
//      to each market's exact limit; games the parsers would misread are
//      refused.
//   5. Farm descriptions and baseTitleForSet.
//
// The farm services resolve the game against knownFarmGames(), which reads
// AutoFarmTask/CampaignDrops.distinct("game"). Those two statics are stubbed
// for this file's lifetime with the test's own game list (before the first
// parse — both services cache the list), so the whole real parse runs with no
// database behind it.
// Run: node --test tests/bulkPacksCopy.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const copy = require("../utils/bulkPacks/copy");
const {
  TITLE_MAX,
  DESC_MAX,
  FARM_TITLE_RE,
} = require("../utils/bulkPacks/config");

const AutoFarmTask = require("../models/AutoFarmTask");
const CampaignDrops = require("../models/CampaignDrops");
const eldFarm = require("../utils/eldoradoFarmService");
const paFarm = require("../utils/playerauctionsFarmService");
const g2gFarm = require("../utils/g2gFarmService");

const {
  stripBulkSuffix,
  accountsTitle,
  accountsDescription,
  farmTerm,
  farmTitle,
  farmDescription,
  baseTitleForSet,
} = copy;

const ACCOUNT_MARKETS = ["eldorado", "g2g", "gameflip"];
const FARM_MARKETS = ["eldorado", "g2g"];
const TERMS = [120, 180, 365];
const TIER_SIZES = [5, 10];
// The parse the farm services run on a title (eldoradoFarmService.js:99,
// g2gFarmService.js:62). The real parseFarmOrder below runs it for real too.
const GAME_SPLIT = /\s+Twitch\s+Drops\b/i;

// ---------------------------------------------------------------------------
// game corpus + the stubbed known-games list
// ---------------------------------------------------------------------------

// A game name of exactly `len` characters: words, no digits, no hazards,
// never ending in a space (the parse trims).
const FILLER =
  "Legends of the Forgotten Realm Chronicles Ultimate Deluxe Collectors " +
  "Edition Remastered Anthology Saga ";
function nameOfLength(len) {
  let s = "";
  while (s.length < len) s += FILLER;
  s = s.slice(0, len);
  return s.endsWith(" ") ? s.slice(0, -1) + "X" : s;
}

function termLabel(days) {
  return days === 365 ? "1 Year" : days + " Days";
}

// Longest game whose FULL title (with " Accounts") fits, per combination.
function maxFullGame(market, days, n) {
  const fixed = (
    " Twitch Drops Automatic Farming " +
    termLabel(days) +
    " — Bulk " +
    n +
    "+ Accounts"
  ).length;
  return TITLE_MAX[market] - fixed;
}

// Real game names that must round-trip — several are traps for a sloppier
// guard: digits next to "day" ("Payday 3", "Dead by Daylight"), a "1 Year"
// inside the game, accents (PlayerAuctions' resolver folds them), punctuation.
const NORMAL_GAMES = [
  "Rust",
  "Overwatch",
  "Rainbow Six Siege",
  "Marvel Rivals",
  "Days Gone",
  "Payday 3",
  "Dead by Daylight",
  "Dying Light 2",
  "Battlefield 2042",
  "NBA 2K26",
  "Call of Duty: Black Ops 6",
  "Counter-Strike 2",
  "Tom Clancy's The Division 2",
  "Pokémon GO",
  "Escape from Tarkov",
  "1 Year Anniversary Edition",
  "12 Minutes",
  "The Elder Scrolls Online: Gold Road and Every Chapter Collection Upgrade",
];

// Every boundary-length game the length tests generate.
const BOUNDARY_GAMES = [];
for (const market of FARM_MARKETS) {
  for (const days of TERMS) {
    for (const n of TIER_SIZES) {
      const full = maxFullGame(market, days, n);
      BOUNDARY_GAMES.push(
        nameOfLength(full),
        nameOfLength(full + 1),
        nameOfLength(full + " Accounts".length),
      );
    }
  }
}

// Decoys the farm also knows, so resolution is a real choice, not a
// one-entry list ("Call of Duty" is the prefix PlayerAuctions' fuzzy match
// would fall back to).
const KNOWN_GAMES = [
  ...new Set(["Call of Duty", "Fortnite", ...NORMAL_GAMES, ...BOUNDARY_GAMES]),
];

const hadOwnDistinct = {
  task: Object.prototype.hasOwnProperty.call(AutoFarmTask, "distinct"),
  drops: Object.prototype.hasOwnProperty.call(CampaignDrops, "distinct"),
};
const originalDistinct = {
  task: AutoFarmTask.distinct,
  drops: CampaignDrops.distinct,
};
AutoFarmTask.distinct = async () => KNOWN_GAMES.slice();
CampaignDrops.distinct = async () => [];

test.after(() => {
  if (hadOwnDistinct.task) AutoFarmTask.distinct = originalDistinct.task;
  else delete AutoFarmTask.distinct;
  if (hadOwnDistinct.drops) CampaignDrops.distinct = originalDistinct.drops;
  else delete CampaignDrops.distinct;
});

// Parse `title` exactly as a paid order would be parsed, on BOTH farm services.
async function assertFarmRoundTrip(title, { game, days }) {
  assert.ok(FARM_TITLE_RE.test(title), "farm regex: " + title);
  assert.ok(eldFarm.FARM_TITLE.test(title), "eldorado FARM_TITLE: " + title);
  assert.ok(g2gFarm.FARM_TITLE.test(title), "g2g FARM_TITLE: " + title);
  assert.equal(eldFarm.termToDays(title), days, "eldorado termToDays: " + title);
  assert.equal(paFarm.termToDays(title), days, "g2g/PA termToDays: " + title);
  assert.equal(title.split(GAME_SPLIT)[0].trim(), game, "Twitch Drops split: " + title);

  const eld = await eldFarm.parseFarmOrder({
    orderOfferDetails: { offerTitle: title },
  });
  const g2g = await g2gFarm.parseFarmOrder({ title });
  for (const [who, parsed] of [
    ["eldorado", eld],
    ["g2g", g2g],
  ]) {
    assert.ok(parsed, who + " parseFarmOrder returned null for " + title);
    assert.equal(parsed.days, days, who + " days: " + title);
    assert.equal(parsed.rawGame, game, who + " rawGame: " + title);
    assert.equal(parsed.game, game, who + " resolved game: " + title);
  }
}

// ---------------------------------------------------------------------------
// account titles
// ---------------------------------------------------------------------------

test("accountsTitle: the exact formats per market", () => {
  const base = "Rust Twitch Drops bundle";
  // The Send-dialog example in API-UI.md.
  assert.equal(
    accountsTitle({ baseTitle: base, market: "eldorado", minQty: 5, discountPct: 5 }),
    "Rust Twitch Drops bundle — BULK 5+ accounts (5% off)",
  );
  assert.equal(
    accountsTitle({ baseTitle: base, market: "g2g", minQty: 10, discountPct: 10 }),
    "Rust Twitch Drops bundle — BULK 10+ accounts (10% off)",
  );
  assert.equal(
    accountsTitle({ baseTitle: base, market: "gameflip", minQty: 5, discountPct: 5 }),
    "Rust Twitch Drops bundle — PACK OF 5 ACCOUNTS",
  );
});

test("accountsTitle: '(0% off)' is left out; the % shown is the priced one", () => {
  for (const discountPct of [0, undefined, null, NaN, "x", -5]) {
    assert.equal(
      accountsTitle({ baseTitle: "Rust", market: "eldorado", minQty: 5, discountPct }),
      "Rust — BULK 5+ accounts",
      "discountPct " + String(discountPct),
    );
  }
  assert.equal(
    accountsTitle({ baseTitle: "Rust", market: "g2g", minQty: 5, discountPct: 7.5 }),
    "Rust — BULK 5+ accounts (7.5% off)",
  );
  // pricing.js caps a discount at the settings' 60%, so the title does too.
  assert.equal(
    accountsTitle({ baseTitle: "Rust", market: "eldorado", minQty: 5, discountPct: 90 }),
    "Rust — BULK 5+ accounts (60% off)",
  );
});

test("accountsTitle: fits every market's limit; the base is cut with '…', never the suffix", () => {
  const long =
    "Rust Twitch Drops (12 Items) — Garage Door Skin + Hazmat Suit Bundle " +
    "With An Extra Long Name +10 more, and some words to overflow any limit";
  for (const market of ACCOUNT_MARKETS) {
    for (const minQty of [2, 5, 10, 100]) {
      for (const discountPct of [0, 5, 10]) {
        for (let len = 0; len <= 400; len += 7) {
          const base = (long + " " + long + " " + long).slice(0, len).trim();
          const title = accountsTitle({ baseTitle: base, market, minQty, discountPct });
          const suffix =
            market === "gameflip"
              ? " — PACK OF " + minQty + " ACCOUNTS"
              : " — BULK " + minQty + "+ accounts" + (discountPct ? " (" + discountPct + "% off)" : "");
          const where = market + " n=" + minQty + " d=" + discountPct + " len=" + len;
          assert.ok(title.length <= TITLE_MAX[market], where + ": " + title.length);
          assert.ok(title.endsWith(suffix), where + ": suffix kept: " + title);
          assert.ok(!FARM_TITLE_RE.test(title), where + ": reads as a farm title");
          assert.ok(title.isWellFormed(), where + ": well-formed UTF-16");
          const room = TITLE_MAX[market] - suffix.length;
          if (base && base.length <= room) {
            assert.equal(title, base + suffix, where + ": short base kept whole");
            assert.equal(stripBulkSuffix(title), base, where + ": strip round-trips");
          } else if (base) {
            assert.ok(title.slice(0, -suffix.length).endsWith("…"), where + ": cut marked");
            assert.ok(
              base.startsWith(title.slice(0, -suffix.length - 1)),
              where + ": the cut keeps the base's own start",
            );
          }
        }
      }
    }
  }
});

test("accountsTitle: never splits an emoji across the cut", () => {
  for (const market of ACCOUNT_MARKETS) {
    const title = accountsTitle({
      baseTitle: "Rust 🎁".repeat(60),
      market,
      minQty: 10,
      discountPct: 10,
    });
    assert.ok(title.isWellFormed(), market + ": " + title);
    assert.ok(title.length <= TITLE_MAX[market]);
  }
});

test("accountsTitle: THROWS rather than publish a title the farm service would take", () => {
  for (const market of ACCOUNT_MARKETS) {
    for (const baseTitle of [
      "Rust Twitch Drops Automatic Farming 120 Days",
      "Rust automatic   farming bundle",
      "Rust — AUTOMATIC FARMING",
    ]) {
      assert.throws(
        () => accountsTitle({ baseTitle, market, minQty: 5, discountPct: 5 }),
        /rent-farm/,
        market + ": " + baseTitle,
      );
    }
  }
});

test("accountsTitle: only account-pack markets, only whole minQty >= 1", () => {
  for (const market of ["ggsel", "plati", "digiseller", "playerauctions", "zeusx", "Eldorado", "", undefined]) {
    assert.throws(
      () => accountsTitle({ baseTitle: "Rust", market, minQty: 5 }),
      /not offered/,
      "market " + String(market),
    );
  }
  for (const minQty of [0, -1, 2.5, "abc", "", undefined, null, NaN]) {
    assert.throws(
      () => accountsTitle({ baseTitle: "Rust", market: "eldorado", minQty }),
      /minQty/,
      "minQty " + String(minQty),
    );
  }
  assert.equal(
    accountsTitle({ baseTitle: "Rust", market: "eldorado", minQty: "5", discountPct: 5 }),
    "Rust — BULK 5+ accounts (5% off)",
  );
});

test("accountsTitle: one line, single spaces; no base -> 'Twitch Drops bundle'; no doubled suffix", () => {
  assert.equal(
    accountsTitle({ baseTitle: "  Rust\n\tTwitch   Drops \r\n", market: "eldorado", minQty: 5, discountPct: 5 }),
    "Rust Twitch Drops — BULK 5+ accounts (5% off)",
  );
  for (const baseTitle of ["", "   ", null, undefined]) {
    assert.equal(
      accountsTitle({ baseTitle, market: "gameflip", minQty: 5 }),
      "Twitch Drops bundle — PACK OF 5 ACCOUNTS",
    );
  }
  assert.equal(
    accountsTitle({ baseTitle: "Rust — BULK 5+ accounts (5% off)", market: "eldorado", minQty: 10, discountPct: 10 }),
    "Rust — BULK 10+ accounts (10% off)",
  );
});

// ---------------------------------------------------------------------------
// stripBulkSuffix + baseTitleForSet
// ---------------------------------------------------------------------------

test("stripBulkSuffix: removes every suffix this module adds", () => {
  const cases = [
    ["Rust — BULK 5+ accounts (5% off)", "Rust"],
    ["Rust — BULK 10+ accounts", "Rust"],
    ["Rust — BULK 5+ accounts (7.5% off)", "Rust"],
    ["Rust — PACK OF 5 ACCOUNTS", "Rust"],
    ["Rust Twitch Drops Automatic Farming 120 Days — Bulk 5+ Accounts", "Rust Twitch Drops Automatic Farming 120 Days"],
    ["Rust Twitch Drops Automatic Farming 1 Year — Bulk 10+", "Rust Twitch Drops Automatic Farming 1 Year"],
    // Any case, and a dash a sanitiser may have flattened.
    ["Rust - bulk 5+ ACCOUNTS (5% OFF)", "Rust"],
    ["Rust – Pack of 5 accounts", "Rust"],
    ["  Rust — BULK 5+ accounts  ", "Rust"],
    // Stacked.
    ["Rust — BULK 5+ accounts (5% off) — PACK OF 5 ACCOUNTS", "Rust"],
    // A cut base keeps its own "…".
    ["Rust Twitch Drops (12 Items) — Garage… — BULK 5+ accounts (5% off)", "Rust Twitch Drops (12 Items) — Garage…"],
  ];
  for (const [title, want] of cases) assert.equal(stripBulkSuffix(title), want, title);
  for (const farm of FARM_MARKETS) {
    for (const days of TERMS) {
      const t = farmTitle({ game: "Rust", days, minQty: 5, market: farm });
      assert.equal(stripBulkSuffix(t), "Rust Twitch Drops Automatic Farming " + termLabel(days));
    }
  }
});

test("stripBulkSuffix: leaves every other title alone", () => {
  for (const title of [
    "Rust Twitch Drops (5 Items) — Hazmat Suit + Garage Door +3 more",
    "Rust Twitch Drops — Winter Pack",
    "Starter Pack",
    "Bulk Buy Edition",
    "Rust — Pack Opening Bundle",
    "Rust — Bulk Discount Weekend",
    "Rust Twitch Drops Automatic Farming 120 Days",
  ]) {
    assert.equal(stripBulkSuffix(title), title, title);
  }
  assert.equal(stripBulkSuffix(null), "");
  assert.equal(stripBulkSuffix(undefined), "");
  assert.equal(stripBulkSuffix(42), "42");
});

test("baseTitleForSet: anchor title (unsuffixed) -> set name -> 'Twitch Drops bundle'", () => {
  const set = { name: "Rust — Winter Event" };
  assert.equal(
    baseTitleForSet({ set, anchorRow: { title: "Rust Twitch Drops (3 Items) — Hazmat Suit + Door +1 more" } }),
    "Rust Twitch Drops (3 Items) — Hazmat Suit + Door +1 more",
  );
  assert.equal(
    baseTitleForSet({ set, anchorRow: { title: "Rust Twitch Drops — BULK 5+ accounts (5% off)" } }),
    "Rust Twitch Drops",
  );
  for (const anchorRow of [null, undefined, {}, { title: "" }, { title: "   " }, { title: " — BULK 5+ accounts" }]) {
    assert.equal(baseTitleForSet({ set, anchorRow }), "Rust — Winter Event", JSON.stringify(anchorRow));
  }
  assert.equal(baseTitleForSet({ set: { name: "  " }, anchorRow: null }), "Twitch Drops bundle");
  assert.equal(baseTitleForSet({ set: null }), "Twitch Drops bundle");
  assert.equal(baseTitleForSet(), "Twitch Drops bundle");
});

// ---------------------------------------------------------------------------
// account descriptions
// ---------------------------------------------------------------------------

const ITEMS = [
  { name: "Hazmat Suit", qty: 2 },
  { name: "Garage Door", qty: 1 },
  { name: "Assault Rifle Skin" },
];

test("accountsDescription (eldorado/g2g, dropset): whole bundle per account + the minimum order", () => {
  for (const market of ["eldorado", "g2g"]) {
    const d = accountsDescription({
      setName: "Rust — Winter Event",
      items: ITEMS,
      game: "Rust",
      market,
      minQty: 5,
      source: "dropset",
    });
    assert.ok(d.includes("Each account holds the whole bundle:"), market);
    assert.ok(d.includes("the minimum order is 5 accounts"), market);
    assert.ok(d.includes("Minimum order: 5 accounts."), market);
    assert.ok(d.includes("Set the quantity to 5 or more"), market);
    assert.ok(d.includes("- 2× Hazmat Suit\n- Garage Door\n- Assault Rifle Skin"), market);
    assert.ok(d.includes("Rust — Winter Event"), market);
    assert.ok(d.includes("press Connect"), market);
    assert.ok(d.includes("arrive in the order chat"), market);
    assert.ok(d.includes("message me here on " + (market === "g2g" ? "G2G" : "Eldorado")), market);
    assert.ok(!d.includes("separate accounts in this one purchase"), market);
    assert.ok(!d.includes("claim the rewards yourself"), market + ": no-claim copy on a claimed pack");
    assert.ok(!d.includes("…and"), market + ": nothing hidden");
    assert.ok(d.length <= DESC_MAX[market]);
  }
});

test("accountsDescription (gameflip, dropset): you receive N separate accounts", () => {
  const d = accountsDescription({
    setName: "Rust — Winter Event",
    items: ITEMS,
    game: "Rust",
    market: "gameflip",
    minQty: 10,
    source: "dropset",
  });
  assert.ok(d.startsWith("PACK OF 10 ACCOUNTS — you receive 10 separate accounts in this one purchase."));
  assert.ok(d.includes("You receive 10 separate accounts"));
  assert.ok(d.includes("Each account holds the whole bundle:"));
  assert.ok(d.includes("message me here on Gameflip"));
  assert.ok(!d.includes("Minimum order:"), "no quantity on a Gameflip pack");
  assert.ok(!d.includes("order chat"), "Gameflip delivers by code");
});

test("accountsDescription (noclaim): the buyer logs in, links their own game account, claims", () => {
  for (const market of ["eldorado", "g2g"]) {
    const d = accountsDescription({
      setName: "Overwatch — OWCS Finals",
      items: [{ name: "Spray", qty: 1 }, { name: "Player Icon", qty: 1 }],
      game: "Overwatch",
      market,
      minQty: 5,
      source: "noclaim",
    });
    assert.ok(
      /log in, link your own game account, then claim the rewards yourself/.test(d),
      market + ": " + d,
    );
    assert.ok(d.includes("Each account holds the whole bundle:"), market);
    assert.ok(d.includes("Minimum order: 5 accounts."), market);
    assert.ok(!d.includes("press Connect"), market + ": claimed-pack copy on a no-claim pack");
  }
});

test("accountsDescription: refuses what v1 does not sell", () => {
  const base = { setName: "Rust", items: ITEMS, game: "Rust", minQty: 5 };
  assert.throws(() => accountsDescription({ ...base, market: "gameflip", source: "noclaim" }), /not offered/);
  for (const source of ["farm", "", undefined, "DROPSET"]) {
    assert.throws(() => accountsDescription({ ...base, market: "eldorado", source }), /account packs only/);
  }
  for (const market of ["ggsel", "plati", "digiseller", "playerauctions", undefined]) {
    assert.throws(() => accountsDescription({ ...base, market, source: "dropset" }), /not offered/);
  }
  assert.throws(() => accountsDescription({ ...base, market: "eldorado", source: "dropset", minQty: 0 }), /minQty/);
});

test("accountsDescription: never over DESC_MAX — as many items as fit, then '…and N more'", () => {
  const many = Array.from({ length: 300 }, (_, i) => ({
    name: "Very Long Legendary Item Name Number " + (i + 1) + " With Extra Words Attached",
    qty: (i % 3) + 1,
  }));
  const hugeName = "Rust — " + "Winter Event ".repeat(60);
  const hugeGame = "Rust " + "Ultimate ".repeat(40);
  for (const [market, source] of [
    ["eldorado", "dropset"],
    ["g2g", "dropset"],
    ["gameflip", "dropset"],
    ["eldorado", "noclaim"],
    ["g2g", "noclaim"],
  ]) {
    const d = accountsDescription({ setName: hugeName, items: many, game: hugeGame, market, minQty: 5, source });
    const where = market + "/" + source;
    assert.ok(d.length <= DESC_MAX[market], where + ": " + d.length);
    const shown = d.split("\n").filter((l) => /^- (\d+× )?Very Long/.test(l));
    assert.ok(shown.length > 0, where + ": some items shown");
    // Shown in input order, and the hidden count is exact.
    shown.forEach((l, i) => assert.ok(l.includes("Number " + (i + 1) + " "), where + ": order at " + i));
    const more = d.match(/^- …and (\d+) more$/m);
    assert.ok(more, where + ": '…and N more' line");
    assert.equal(Number(more[1]) + shown.length, many.length, where + ": hidden count");
    // The closing lines survive the cut — only items are dropped.
    assert.ok(d.includes("before opening a dispute"), where);
  }
});

test("accountsDescription: never a login or a password, whatever rides along", () => {
  const d = accountsDescription({
    setName: "Rust — Winter Event",
    items: ITEMS,
    game: "Rust",
    market: "eldorado",
    minQty: 5,
    source: "dropset",
    // Nothing below is part of the signature; none of it may leak.
    login: "acct_login_4711",
    password: "pw-SECRET-4711",
    units: [{ accountId: "a1", login: "acct_login_0815", password: "hunter2-0815" }],
  });
  for (const secret of ["acct_login_4711", "pw-SECRET-4711", "acct_login_0815", "hunter2-0815"]) {
    assert.ok(!d.includes(secret), "leaked " + secret);
  }
  assert.ok(!/password|username/i.test(d), "no credential wording at all");
});

test("accountsDescription: an empty or junk item list still reads as a description", () => {
  for (const items of [[], null, undefined, [null, {}, { name: "   " }]]) {
    const d = accountsDescription({ setName: "", items, game: "Rust", market: "g2g", minQty: 5, source: "dropset" });
    assert.ok(d.includes("Rust Twitch Drops bundle"), "heading from the game");
    assert.ok(d.includes("- every item shown in the title and the pictures"));
    assert.ok(d.includes("Each account holds the whole bundle:"));
  }
});

// ---------------------------------------------------------------------------
// farm titles — the REAL parsers
// ---------------------------------------------------------------------------

test("farmTerm: '1 Year' for 365, else 'N Days'; only whole days 1..730", () => {
  assert.equal(farmTerm(365), "1 Year");
  assert.equal(farmTerm(120), "120 Days");
  assert.equal(farmTerm(180), "180 Days");
  assert.equal(farmTerm("180"), "180 Days");
  assert.equal(farmTerm(730), "730 Days");
  for (const bad of [0, -1, 731, 12.5, "abc", "", undefined, null, NaN]) {
    assert.throws(() => farmTerm(bad), /days must be/, "farmTerm(" + String(bad) + ")");
  }
});

test("farmTitle: the exact format", () => {
  assert.equal(
    farmTitle({ game: "Rust", days: 120, minQty: 5, market: "eldorado" }),
    "Rust Twitch Drops Automatic Farming 120 Days — Bulk 5+ Accounts",
  );
  assert.equal(
    farmTitle({ game: "Rust", days: 365, minQty: 10, market: "g2g" }),
    "Rust Twitch Drops Automatic Farming 1 Year — Bulk 10+ Accounts",
  );
  assert.equal(
    farmTitle({ game: "  Rust  ", days: "180", minQty: "5", market: "g2g" }),
    "Rust Twitch Drops Automatic Farming 180 Days — Bulk 5+ Accounts",
    "outer spaces trimmed, numeric strings accepted",
  );
});

test("farmTitle round-trips through the real Eldorado + G2G parsers: 120/180/365, every tier", async () => {
  for (const market of FARM_MARKETS) {
    for (const days of TERMS) {
      for (const minQty of TIER_SIZES) {
        for (const game of NORMAL_GAMES) {
          const title = farmTitle({ game, days, minQty, market });
          assert.ok(title.length <= TITLE_MAX[market], market + ": " + title);
          await assertFarmRoundTrip(title, { game, days });
        }
      }
    }
  }
});

test("the resolver behind the round trip is live: a game the farm does not know stays unresolved", async () => {
  // Without this, a stub that echoed any game back would make every
  // round-trip assertion above vacuous.
  const title = farmTitle({ game: "Zzyzx Unknown Quest", days: 120, minQty: 5, market: "eldorado" });
  const eld = await eldFarm.parseFarmOrder({ orderOfferDetails: { offerTitle: title } });
  const g2g = await g2gFarm.parseFarmOrder({ title });
  for (const parsed of [eld, g2g]) {
    assert.equal(parsed.rawGame, "Zzyzx Unknown Quest");
    assert.equal(parsed.days, 120);
    assert.equal(parsed.game, "", "an unknown game must not resolve");
  }
});

test("farmTitle round-trips any configurable duration (30/90/730)", async () => {
  for (const days of [30, 90, 730]) {
    for (const market of FARM_MARKETS) {
      await assertFarmRoundTrip(farmTitle({ game: "Rust", days, minQty: 5, market }), { game: "Rust", days });
    }
  }
});

test("farmTitle: long game names up to each market's exact limit, then ' Accounts' drops, then THROW", async () => {
  for (const market of FARM_MARKETS) {
    const max = TITLE_MAX[market];
    for (const days of TERMS) {
      for (const minQty of TIER_SIZES) {
        const where = market + " " + days + "d n=" + minQty;
        const full = maxFullGame(market, days, minQty);
        assert.ok(full > 40, where + ": room for a real game name");

        // Longest game that keeps " Accounts": exactly at the limit.
        const g1 = nameOfLength(full);
        const t1 = farmTitle({ game: g1, days, minQty, market });
        assert.equal(t1.length, max, where);
        assert.ok(t1.endsWith(" — Bulk " + minQty + "+ Accounts"), where + ": " + t1);
        await assertFarmRoundTrip(t1, { game: g1, days });

        // One longer: " Accounts" is dropped, the rest is intact.
        const g2 = nameOfLength(full + 1);
        const t2 = farmTitle({ game: g2, days, minQty, market });
        assert.ok(t2.endsWith(" — Bulk " + minQty + "+"), where + ": " + t2);
        assert.ok(t2.length <= max, where);
        await assertFarmRoundTrip(t2, { game: g2, days });

        // Longest game at all: the short form exactly at the limit.
        const g3 = nameOfLength(full + " Accounts".length);
        const t3 = farmTitle({ game: g3, days, minQty, market });
        assert.equal(t3.length, max, where);
        await assertFarmRoundTrip(t3, { game: g3, days });

        // One more character: the game cannot be shortened, so refuse.
        assert.throws(
          () => farmTitle({ game: nameOfLength(full + " Accounts".length + 1), days, minQty, market }),
          /cannot be shortened/,
          where,
        );
      }
    }
  }
});

test("farmTitle refuses a game the real parsers would misread — and only such games", () => {
  // termToDays takes the FIRST "N days" in the title, and the game comes
  // first; the parse cuts the game at the first "Twitch Drops".
  const termHazards = ["7 Days to Die", "Borderlands 4 Day One Edition", "2Days Hunt"];
  const splitHazards = ["Foo Twitch Drops Edition", "Foo twitch  drops"];
  for (const market of FARM_MARKETS) {
    for (const days of TERMS) {
      for (const game of termHazards) {
        assert.throws(() => farmTitle({ game, days, minQty: 5, market }), /farming term/, game);
        // The refusal is earned: the unguarded title really is misread.
        const naive = game + " Twitch Drops Automatic Farming " + termLabel(days) + " — Bulk 5+ Accounts";
        assert.notEqual(
          eldFarm.termToDays(naive),
          days,
          "the real termToDays now reads " + JSON.stringify(naive) +
            " correctly — copy.js TERM_HAZARD_RE may be relaxed",
        );
      }
      for (const game of splitHazards) {
        assert.throws(() => farmTitle({ game, days, minQty: 5, market }), /Twitch Drops/, game);
        const naive = game + " Twitch Drops Automatic Farming " + termLabel(days) + " — Bulk 5+ Accounts";
        assert.notEqual(naive.split(GAME_SPLIT)[0].trim(), game, "the real split would cut " + game);
      }
    }
  }
});

test("farmTitle: only farm markets, a real game, whole days 1..730, whole minQty", () => {
  const ok = { game: "Rust", days: 120, minQty: 5, market: "eldorado" };
  for (const market of ["gameflip", "ggsel", "plati", "digiseller", "playerauctions", "", undefined]) {
    assert.throws(() => farmTitle({ ...ok, market }), /not offered/, "market " + String(market));
  }
  for (const game of ["", "   ", null, undefined]) {
    assert.throws(() => farmTitle({ ...ok, game }), /needs a game/, "game " + String(game));
  }
  for (const game of ["Rust\nNew", "Rust\tNew", "Rust\u2028New"]) {
    assert.throws(() => farmTitle({ ...ok, game }), /single line/, JSON.stringify(game));
  }
  for (const days of [0, 731, 12.5, "x", undefined]) {
    assert.throws(() => farmTitle({ ...ok, days }), /days must be/, "days " + String(days));
  }
  for (const minQty of [0, -2, 1.5, undefined, "x"]) {
    assert.throws(() => farmTitle({ ...ok, minQty }), /minQty/, "minQty " + String(minQty));
  }
});

test("account titles and farm titles never cross: bulk account titles are never parsed as farm orders", async () => {
  for (const market of ACCOUNT_MARKETS) {
    for (const baseTitle of ["Rust Twitch Drops (3 Items) — Hazmat Suit + Door +1 more", "Overwatch Twitch Drops bundle"]) {
      const title = accountsTitle({ baseTitle, market, minQty: 5, discountPct: 5 });
      assert.equal(await eldFarm.parseFarmOrder({ orderOfferDetails: { offerTitle: title } }), null, title);
      assert.equal(await g2gFarm.parseFarmOrder({ title }), null, title);
    }
  }
});

// ---------------------------------------------------------------------------
// farm descriptions
// ---------------------------------------------------------------------------

test("farmDescription: the bulk house copy — minimum order, full window, order chat, keep linked, no password change", () => {
  const d = farmDescription({ game: "Rust", days: 120, minQty: 5 });
  assert.ok(d.startsWith("Automatic Farm on our Twitch for the game Rust"), "house opening line");
  assert.ok(d.includes("The minimum order is 5 accounts"));
  assert.ok(d.includes("set the quantity to 5 or more"));
  assert.ok(d.includes("each one is farmed for Rust for the whole period [120 days]"));
  assert.ok(d.includes("arrive in the order chat"));
  assert.ok(d.includes("Keep every account linked"));
  assert.ok(d.includes("do not change the password"));
  assert.ok(d.includes("you will not receive a refund"), "the refund warning is kept");
  for (const section of ["Activation & Timing:", "Manual Pickup:", "Bot Guarantee:", "Account Status:", "Exclusivity:", "Important Warning:", "Event Restrictions:"]) {
    assert.ok(d.includes(section), section);
  }
  assert.ok(!/username\s*:|password\s*:/i.test(d), "no credential fields");
});

test("farmDescription: the term in the copy always matches the title's term", () => {
  for (const days of TERMS) {
    const d = farmDescription({ game: "Rust", days, minQty: 10 });
    const promised = [...d.matchAll(/\[(\d+) days\]/g)].map((m) => Number(m[1]));
    assert.ok(promised.length >= 2, "the window is stated");
    assert.ok(promised.every((p) => p === days), days + ": " + promised.join(","));
    const title = farmTitle({ game: "Rust", days, minQty: 10, market: "eldorado" });
    assert.equal(eldFarm.termToDays(title), days);
  }
});

test("farmDescription: fits every farm market, even with the longest title-able game", () => {
  const longest = Math.max(
    ...FARM_MARKETS.flatMap((m) => TERMS.map((days) => maxFullGame(m, days, 5) + " Accounts".length)),
  );
  for (const game of [nameOfLength(longest), nameOfLength(150)]) {
    for (const days of TERMS) {
      const d = farmDescription({ game, days, minQty: 100 });
      for (const market of FARM_MARKETS) {
        assert.ok(d.length <= DESC_MAX[market], market + ": " + d.length);
      }
    }
  }
});

test("farmDescription: refuses bad input instead of promising the wrong thing", () => {
  const ok = { game: "Rust", days: 120, minQty: 5 };
  assert.throws(() => farmDescription({ ...ok, game: "" }), /needs a game/);
  assert.throws(() => farmDescription({ ...ok, game: "Rust\nx" }), /single line/);
  assert.throws(() => farmDescription({ ...ok, days: 0 }), /days must be/);
  assert.throws(() => farmDescription({ ...ok, minQty: 0 }), /minQty/);
  assert.throws(() => farmDescription({ ...ok, game: "Rust " + "x".repeat(900) }), /over the/);
});

test("the module is pure: __setDeps / __resetDeps exist and change nothing", () => {
  assert.equal(typeof copy.__setDeps, "function");
  assert.equal(typeof copy.__resetDeps, "function");
  copy.__setDeps({ anything: true });
  assert.equal(
    farmTitle({ game: "Rust", days: 120, minQty: 5, market: "eldorado" }),
    "Rust Twitch Drops Automatic Farming 120 Days — Bulk 5+ Accounts",
  );
  copy.__resetDeps();
});
