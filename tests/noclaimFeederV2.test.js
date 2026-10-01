// No-claim feeder v2 (docs/NOCLAIM-FEEDER-V2-CONTRACT.md): the fleet allocator
// sized from honest demand. Every case is a shape measured on prod 2026-10-01.
// No Mongo, no network.
const test = require("node:test");
const assert = require("node:assert/strict");

const sizing = require("../utils/farmSizing");
const farmDemand = require("../utils/farmDemand");
const allocator = require("../utils/unclaimedAllocator");

const DAY = 86400000;
const NOW = Date.parse("2026-10-01T16:00:00Z");
const KEYS = ["overwatch", "rainbow six", "call of duty"];
const ago = (d) => new Date(NOW - d * DAY);
const since30 = ago(30);

/* ------------------------------ one sale, one date ------------------------------ */

test("the 09-28 backfill sweep does not re-date a sale the ledger dated earlier", () => {
  // retireSoldFromBots took 142 sold accounts out of their bots on 09-28 and
  // swept them; their ledger sale was 40 days earlier.
  const acc = farmDemand.saleAccumulator(KEYS);
  acc.add("Overwatch", "OldBuyer1", "ledger", { at: ago(40), market: "eldorado" });
  acc.add("Overwatch", "oldbuyer1", "swept", { at: ago(3) });
  const { units, undated } = acc.split(since30);
  assert.equal(units.get("overwatch").size, 0, "sold 40 days ago — not a sale in this window");
  assert.equal(undated.get("overwatch"), 0);
});

test("a hand-sold tick with no dated evidence is reported undated and drives nothing", () => {
  const acc = farmDemand.saleAccumulator(KEYS);
  acc.add("overwatch", "bulk1", "manual_sold", { at: ago(2) });
  acc.add("Overwatch", "bulk2", "swept", { at: ago(3) });
  const { units, undated } = acc.split(since30);
  assert.equal(units.get("overwatch").size, 0);
  assert.equal(undated.get("overwatch"), 2);
});

test("an account is dated by its EARLIEST evidence and takes that evidence's market", () => {
  const acc = farmDemand.saleAccumulator(KEYS);
  // The scanner saw the buyer connect after the Eldorado ledger sale.
  acc.add("Rainbow Six Siege", "r6a", "connected", { at: ago(2) });
  acc.add("Rainbow Six Siege", "r6a", "ledger", { at: ago(5), market: "eldorado", priceUsd: 1.81 });
  const u = acc.split(since30).units.get("rainbow six").get("r6a");
  assert.equal(u.firstAt.getTime(), ago(5).getTime());
  assert.equal(u.market, "eldorado");
  assert.equal(u.priceUsd, 1.81);
  assert.deepEqual([...u.sources].sort(), ["connected", "ledger"]);
});

test("a market named only by later evidence still fills a blank market", () => {
  const acc = farmDemand.saleAccumulator(KEYS);
  acc.add("Rainbow Six Siege", "r6b", "connected", { at: ago(4) });
  acc.add("Rainbow Six Siege", "r6b", "listing_sold", { at: ago(3), market: "gameflip" });
  const u = acc.split(since30).units.get("rainbow six").get("r6b");
  assert.equal(u.firstAt.getTime(), ago(4).getTime());
  assert.equal(u.market, "gameflip");
});

test("a grouped signal row is dated by its first sighting, not its latest", () => {
  const acc = farmDemand.saleAccumulator(KEYS);
  acc.add("overwatch", "ow1", "connected", { at: ago(1), firstAt: ago(45) });
  assert.equal(acc.split(since30).units.get("overwatch").size, 0, "first seen 45 days ago");
});

test("anonymous quantity-listing units stay separate sales", () => {
  const acc = farmDemand.saleAccumulator(KEYS);
  acc.add("Overwatch", "", "listing_sold", { at: ago(1), dedupe: "anon:a" });
  acc.add("Overwatch", "", "listing_sold", { at: ago(1), dedupe: "anon:b" });
  assert.equal(acc.split(since30).units.get("overwatch").size, 2);
});

/* ------------------------------- in-stock demand ------------------------------- */

test("stock-out days do not drag a daily seller's rate down", () => {
  // 78 sales on 26 selling days of 30 (R6, other markets) -> 21/week, not 18.2.
  assert.equal(Math.round(sizing.inStockRate({ count: 78, sellingDays: 26, windowDays: 30 }) * 10) / 10, 21);
});

test("a game that genuinely sells every few days is not read as a daily seller", () => {
  // 4 sales on 4 days of 30: the half-window floor caps the boost at 2x.
  const raw = sizing.salesPerWeek(4, 30);
  const adj = sizing.inStockRate({ count: 4, sellingDays: 4, windowDays: 30 });
  assert.ok(adj <= raw * 2 + 1e-9, `adjusted ${adj} vs raw ${raw}`);
  assert.equal(sizing.inStockRate({ count: 0, sellingDays: 0, windowDays: 30 }), 0);
});

function unit(daysAgo, market) {
  return { firstAt: ago(daysAgo), market };
}

test("shelf sales keep their raw rate; every other sale gets the in-stock rate", () => {
  const units = [];
  // 20 shelf sales spread over the month (Gameflip/Plati).
  for (let i = 0; i < 20; i++) units.push(unit(1 + i * 1.4, i % 2 ? "gameflip" : "digiseller"));
  // Eldorado: 6 a day on 13 of the last 14 days (one stock-out day), nothing before.
  for (let d = 1; d <= 14; d++) {
    if (d === 7) continue;
    for (let k = 0; k < 6; k++) units.push(unit(d - 0.5, "eldorado"));
  }
  const r = farmDemand.demandRates(units, { days: 30, now: NOW });
  assert.equal(r.shelfSales, 20);
  assert.equal(r.otherSales, 78);
  // Raw, the larger window rate: 10 of them in the last 14 days (5.0/week) beat
  // 20 over 30 days (4.7/week). No in-stock boost — a shelf never runs dry.
  assert.equal(r.shelfPerWeek, 5);
  // 14-day in-stock rate: 78 sales / 13 selling days * 7 = 42/week beats the
  // 30-day 78/15*7 = 36.4 — a rise shows within two weeks.
  assert.equal(r.otherPerWeek, 42);
});

/* ------------------------------ shelf-aware target ------------------------------ */

test("R6 2026-10-01: the 50 accounts on a slow shelf are not counted as Eldorado cover", () => {
  const { target, parts } = sizing.shelfAwareTarget({
    shelfHeld: 50,
    shelfPerWeek: 4.7,
    otherPerWeek: 24.5,
    coverageDays: 28,
    safetyStock: 6,
    max: 250,
  });
  assert.deepEqual(parts, { shelf: 50, other: 98, safety: 6 });
  assert.equal(target, 154);
  // The old rule: (4.7 + 24.5) * 4 + 6 = 123 — 31 short, with 50 of it parked.
  assert.ok(target > sizing.coverageTarget({ salesPerWeek: 29.2, coverageDays: 28, safetyStock: 6 }));
});

test("a shelf that sells more than it holds is sized by its sales", () => {
  const { parts } = sizing.shelfAwareTarget({ shelfHeld: 10, shelfPerWeek: 7, otherPerWeek: 0, coverageDays: 28, safetyStock: 6 });
  assert.equal(parts.shelf, 28);
});

test("the per-game max still caps the whole target (Overwatch at 250)", () => {
  const { target } = sizing.shelfAwareTarget({ shelfHeld: 50, shelfPerWeek: 3, otherPerWeek: 70.7, coverageDays: 28, safetyStock: 6, max: 250 });
  assert.equal(target, 250);
});

test("a game with no dated sale gets the floor only, whatever its shelf holds", () => {
  assert.equal(sizing.shelfAwareTarget({ shelfHeld: 50, shelfPerWeek: 0, otherPerWeek: 0, min: 0 }).target, 0);
  assert.equal(sizing.shelfAwareTarget({ shelfHeld: 50, shelfPerWeek: 0, otherPerWeek: 0, min: 12 }).target, 12);
});

/* -------------------------------- the allocator -------------------------------- */

test("a new bot farms the exact game its siblings farm, not the bucket keyword", () => {
  const bots = [
    { id: "17", game: "Rainbow Six Siege" },
    { id: "18", game: "Rainbow Six Siege" },
    { id: "5", game: "Overwatch" },
    { id: "37", game: "overwatch" },
    { id: "38", game: "Overwatch" },
  ];
  assert.equal(allocator.botGameFor("rainbow six", bots, new Map(), "Rainbow Six"), "Rainbow Six Siege");
  assert.equal(allocator.botGameFor("overwatch", bots, new Map(), "Overwatch"), "Overwatch");
  // No bot yet: the live campaign's own game name, else the keyword.
  const live = new Map([["call of duty", "Call of Duty: Black Ops 7"]]);
  assert.equal(allocator.botGameFor("call of duty", bots, live, "Call Of Duty"), "Call of Duty: Black Ops 7");
  assert.equal(allocator.botGameFor("call of duty", bots, new Map(), "Call Of Duty"), "Call Of Duty");
});

test("apply never creates a bot for a parked game — its plan carries no need", async () => {
  // plan() zeroes fleetNeed for a parked game; apply acts only on fleetNeed.
  const out = await allocator.apply({
    dryRun: true,
    plan: {
      fleetKnown: true,
      policy: { coverageDays: 28 },
      games: [
        {
          key: "call of duty",
          label: "Call Of Duty",
          grant: 0,
          fleetNeed: 0,
          sales: { perWeek: 1 },
          shelf: { cap: 70, explicit: false, need: 0, suggested: 70 },
          fleet: { roomBots: [], parked: true, botGame: "Call of Duty: Black Ops 7" },
        },
      ],
    },
  });
  assert.equal(out.results[0].want, 0);
  assert.equal(out.results[0].plannedCreate, undefined);
});

test("a dry run plans top-ups into existing bots before any new container", async () => {
  const out = await allocator.apply({
    dryRun: true,
    plan: {
      fleetKnown: true,
      policy: { coverageDays: 28 },
      games: [
        {
          key: "rainbow six",
          label: "Rainbow Six",
          grant: 36,
          fleetNeed: 36,
          sales: { perWeek: 29.2 },
          shelf: { cap: 50, explicit: true, need: 0, suggested: 50 },
          fleet: {
            roomBots: [
              { id: "17", game: "Rainbow Six Siege", accounts: 39, room: 31 },
              { id: "21", game: "Rainbow Six Siege", accounts: 39, room: 31 },
            ],
            parked: false,
            botGame: "Rainbow Six Siege",
          },
        },
      ],
    },
  });
  assert.deepEqual(out.results[0].plannedTopUps, [
    { id: "17", add: 31 },
    { id: "21", add: 5 },
  ]);
  assert.equal(out.results[0].plannedCreate, undefined);
});
