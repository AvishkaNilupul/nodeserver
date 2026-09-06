// Pure-function coverage for the unclaimed Gameflip LOTS module — no Mongo,
// no network (docs/UNCLAIMED-BUNDLES-CONTRACT.md, "Lots" + "Tests"):
//   1. pickLotMembers — oldest listedAt first, skips the live single unit and
//      ledgers already in a lot, all-or-nothing, one entry per login.
//   2. buildLotCode — N delivery blocks joined by the divider.
//   3. lotTitle / lotDescription — suffix always survives Gameflip's 120-char
//      cut, and neither ever carries a login.
//   4. lotPriceFor fallback formula (used only when unclaimedBundles is absent).
// See utils/unclaimedLots.js.
const test = require("node:test");
const assert = require("node:assert");

const {
  pickLotMembers,
  eligibleLotLedgers,
  buildLotCode,
  lotTitle,
  lotDescription,
  lotPriceFor,
  LOT_SEPARATOR,
} = require("../utils/unclaimedLots");
const { gameflipDeliveryCode } = require("../utils/gameflipFulfiller");

function ledger(login, listedAt, extra = {}) {
  return {
    _id: login + "-id",
    login,
    loginLower: login.toLowerCase(),
    status: "listed",
    market: "gameflip",
    lotId: "",
    listedAt: new Date(listedAt),
    ...extra,
  };
}

test("pickLotMembers: oldest listedAt first, exactly N", () => {
  const ledgers = [
    ledger("c", "2026-09-03T00:00:00Z"),
    ledger("a", "2026-09-01T00:00:00Z"),
    ledger("d", "2026-09-04T00:00:00Z"),
    ledger("b", "2026-09-02T00:00:00Z"),
  ];
  const picked = pickLotMembers(ledgers, 3);
  assert.deepStrictEqual(picked.map((l) => l.login), ["a", "b", "c"]);
});

test("pickLotMembers: skips the live single unit and lotted ledgers", () => {
  const ledgers = [
    ledger("live", "2026-08-30T00:00:00Z"), // the chain's head — never in a lot
    ledger("lotted", "2026-08-31T00:00:00Z", { lotId: "64f000000000000000000001" }),
    ledger("a", "2026-09-01T00:00:00Z"),
    ledger("b", "2026-09-02T00:00:00Z"),
    ledger("c", "2026-09-03T00:00:00Z"),
  ];
  const picked = pickLotMembers(ledgers, 3, { liveLogin: "LIVE" });
  assert.deepStrictEqual(picked.map((l) => l.login), ["a", "b", "c"]);
});

test("pickLotMembers: all-or-nothing — fewer than N eligible returns []", () => {
  const ledgers = [
    ledger("live", "2026-08-30T00:00:00Z"),
    ledger("a", "2026-09-01T00:00:00Z"),
    ledger("b", "2026-09-02T00:00:00Z"),
  ];
  assert.deepStrictEqual(pickLotMembers(ledgers, 3, { liveLogin: "live" }), []);
  assert.deepStrictEqual(pickLotMembers(ledgers, 0), []);
  assert.deepStrictEqual(pickLotMembers([], 2), []);
});

test("eligibleLotLedgers: drops non-listed / non-gameflip / duplicate logins / excluded", () => {
  const ledgers = [
    ledger("a", "2026-09-01T00:00:00Z"),
    ledger("A", "2026-09-05T00:00:00Z"), // same account twice — keep the oldest
    ledger("sold", "2026-09-01T00:00:00Z", { status: "sold" }),
    ledger("dg", "2026-09-01T00:00:00Z", { market: "digiseller" }),
    ledger("nopw", "2026-09-01T00:00:00Z"),
    ledger("b", "2026-09-02T00:00:00Z"),
  ];
  const out = eligibleLotLedgers(ledgers, { excludeLogins: ["nopw"] });
  assert.deepStrictEqual(out.map((l) => l.login), ["a", "b"]);
});

test("buildLotCode: N blocks joined by the divider, one per account", () => {
  const creds = [
    { login: "user_one", password: "pw1" },
    { login: "user_two", password: "pw2" },
    { login: "user_three", password: "pw3" },
  ];
  const code = buildLotCode(creds);
  const blocks = code.split(LOT_SEPARATOR);
  assert.strictEqual(blocks.length, 3);
  assert.strictEqual(LOT_SEPARATOR, "\n\n=====\n\n");
  assert.strictEqual(blocks[0], gameflipDeliveryCode("user_one", "pw1"));
  assert.strictEqual(blocks[2], gameflipDeliveryCode("user_three", "pw3"));
  assert.ok(blocks[1].includes("Login: user_two"));
  assert.ok(blocks[1].includes("Password: pw2"));
  // A credential without a password can never be delivered — it is dropped.
  assert.strictEqual(
    buildLotCode([...creds, { login: "broken", password: "" }]).split(LOT_SEPARATOR).length,
    3,
  );
});

test("lotTitle: appends the lot suffix and keeps it inside Gameflip's 120 chars", () => {
  const t = lotTitle("Overwatch Twitch Drops (3 Items) — Pachimonarch Icon + Spray +1 more", 5);
  assert.ok(t.endsWith(" — LOT OF 5 ACCOUNTS"));
  assert.ok(t.startsWith("Overwatch Twitch Drops (3 Items)"));
  assert.ok(t.length <= 120);

  const long = "X".repeat(130);
  const cut = lotTitle(long, 10);
  assert.ok(cut.length <= 120, "title must fit Gameflip's 120-char name cut");
  assert.ok(cut.endsWith(" — LOT OF 10 ACCOUNTS"), "the suffix must survive the cut");
});

test("lotDescription: adds the delivery line; copy never carries a login", () => {
  const d = lotDescription("House description\nIncludes:\n- Alpha Pack", 5);
  assert.ok(d.startsWith("House description"));
  assert.ok(d.endsWith("This lot delivers 5 separate accounts, each holding the full item set."));
  const t = lotTitle("Rainbow Six Siege Twitch Drops (1 Item) — Alpha Pack", 5);
  for (const s of [t, d]) {
    assert.ok(!/login|password/i.test(s), "public copy must not mention credentials");
  }
});

test("lotPriceFor fallback: unit × N × (1 − discount), rounded to $0.25, floored at N × floor", () => {
  const pricing = { lotDiscountPct: 10, floorUsd: 0.75 };
  // 2.35 * 5 * 0.9 = 10.575 -> 10.50
  assert.strictEqual(lotPriceFor(2.35, 5, pricing), 10.5);
  // 0.75 * 5 * 0.9 = 3.375 -> 3.50 but never below 5 * 0.75 = 3.75
  assert.strictEqual(lotPriceFor(0.75, 5, pricing), 3.75);
  assert.strictEqual(lotPriceFor(0, 5, pricing), 3.75);
});
