// The rules that keep a live unclaimed listing honest — no Mongo, no network.
//
// On 2026-09-06 the Rainbow Six no-claim stock sold out and SIX listings stayed
// on sale for it: a Gameflip head and a Digiseller product whose units were all
// already sold by hand, plus THREE duplicate GGSel offers minted by three
// manual-sold removals that ran in parallel over one item. Each of those would
// have handed a buyer an account someone else already owns. These cover the
// three rules that now prevent it:
//   1. delistVerdict   — a row is only "delisted" when the platform agrees.
//   2. supersededRowIds — one live row per set+market; the newest survives.
//   3. reconcileRowPlan — a row that can no longer deliver comes off sale.
//   4. withSetMarketLock — removals for one item run one at a time.
// See utils/unclaimedAutoList.js.
const test = require("node:test");
const assert = require("node:assert");

const {
  delistVerdict,
  supersededRowIds,
  reconcileRowPlan,
  withSetMarketLock,
} = require("../utils/unclaimedAutoList");

// --- 1. delistVerdict --------------------------------------------------------

test("delistVerdict: a call the platform accepted is down", () => {
  assert.equal(delistVerdict({ callError: "" }), "down");
  assert.equal(delistVerdict({}), "down");
});

test("delistVerdict: sold/gone mean it is not on sale anyway", () => {
  assert.equal(delistVerdict({ callError: "boom", outcome: "sold" }), "down");
  assert.equal(delistVerdict({ callError: "boom", outcome: "gone" }), "down");
});

test("delistVerdict: a failed call defers to the platform's own state", () => {
  assert.equal(
    delistVerdict({ callError: "504 Gateway Time-out", platformState: "down" }),
    "down",
  );
  assert.equal(
    delistVerdict({ callError: "504 Gateway Time-out", platformState: "live" }),
    "live",
  );
});

test("delistVerdict: an unreadable platform stays retryable, never assumed down", () => {
  // This is the whole point: gameflip 97b49ffd was marked delisted after a
  // swallowed failure and stayed on sale for a sold account for a full day.
  assert.equal(
    delistVerdict({ callError: "timeout of 20000ms exceeded", platformState: null }),
    "unknown",
  );
});

// --- 2. supersededRowIds -----------------------------------------------------

const row = (id, set, marketplace, externalId, extra = {}) => ({
  _id: id,
  set,
  marketplace,
  externalId,
  status: "active",
  units: [],
  ...extra,
});

test("supersededRowIds: a single row per set+market supersedes nothing", () => {
  const rows = [
    row("1", "setA", "ggsel", "100"),
    row("2", "setA", "gameflip", "gf-1"),
    row("3", "setB", "ggsel", "200"),
  ];
  assert.equal(supersededRowIds(rows).size, 0);
});

test("supersededRowIds: the newest of a duplicate group survives", () => {
  // Exactly the R6 case: three GGSel offers for one item, oldest first.
  const rows = [
    row("1", "setA", "ggsel", "102872251"),
    row("2", "setA", "ggsel", "102872253"),
    row("3", "setA", "ggsel", "102872255"),
  ];
  const out = supersededRowIds(rows);
  assert.deepStrictEqual([...out.keys()].sort(), ["1", "2"]);
  assert.equal(out.get("1").externalId, "102872255");
  assert.equal(out.get("2").externalId, "102872255");
});

test("supersededRowIds: rows of the same set on different markets are not duplicates", () => {
  const rows = [
    row("1", "setA", "ggsel", "100"),
    row("2", "setA", "digiseller", "600"),
    row("3", "setA", "gameflip", "gf-1"),
  ];
  assert.equal(supersededRowIds(rows).size, 0);
});

// --- 3. reconcileRowPlan -----------------------------------------------------

const sellable = (...logins) => {
  const set = new Set(logins.map((l) => l.toLowerCase()));
  return (login) => set.has(String(login || "").toLowerCase());
};

test("reconcileRowPlan: a Gameflip head whose unit is still sellable is left alone", () => {
  const r = row("1", "setA", "gameflip", "gf-1", { accountLogin: "goodlogin" });
  assert.deepStrictEqual(reconcileRowPlan(r, sellable("goodlogin")), { action: "none" });
});

test("reconcileRowPlan: a Gameflip head selling a spent account comes off sale", () => {
  const r = row("1", "setA", "gameflip", "gf-1", { accountLogin: "xlayloe795knc" });
  const plan = reconcileRowPlan(r, sellable("someoneelse"));
  assert.equal(plan.action, "delist");
  assert.deepStrictEqual(plan.bad.map((u) => u.login), ["xlayloe795knc"]);
});

test("reconcileRowPlan: matching is case-insensitive", () => {
  const r = row("1", "setA", "gameflip", "gf-1", { accountLogin: "MixedCase" });
  assert.equal(reconcileRowPlan(r, sellable("mixedcase")).action, "none");
});

test("reconcileRowPlan: a quantity product keeps its sellable units and drops the rest", () => {
  const r = row("1", "setA", "digiseller", "6090106", {
    units: [
      { login: "alive", contentId: "c1" },
      { login: "jchuulkcxa", contentId: "c2" },
      { login: "gdvpc708r", contentId: "c3" },
    ],
  });
  const plan = reconcileRowPlan(r, sellable("alive"));
  assert.equal(plan.action, "repair");
  assert.deepStrictEqual(plan.good.map((u) => u.login), ["alive"]);
  assert.deepStrictEqual(plan.bad.map((u) => u.login), ["jchuulkcxa", "gdvpc708r"]);
});

test("reconcileRowPlan: a product whose every unit is spent comes off sale", () => {
  const r = row("1", "setA", "ggsel", "102872251", {
    units: [{ login: "sgwboobe" }, { login: "amtx479ueam" }],
  });
  const plan = reconcileRowPlan(r, sellable());
  assert.equal(plan.action, "delist");
  assert.deepStrictEqual(plan.good, []);
});

test("reconcileRowPlan: an untouched row and an empty row are both no-ops", () => {
  const ok = row("1", "setA", "digiseller", "600", {
    units: [{ login: "a" }, { login: "b" }],
  });
  assert.equal(reconcileRowPlan(ok, sellable("a", "b")).action, "none");
  assert.equal(reconcileRowPlan(row("2", "setA", "ggsel", "700"), sellable()).action, "none");
  assert.equal(reconcileRowPlan(null, sellable()).action, "none");
});

// --- 4. withSetMarketLock ----------------------------------------------------

test("withSetMarketLock: work on one set+market never overlaps", async () => {
  const events = [];
  const worker = (name) =>
    withSetMarketLock("setA", "ggsel", async () => {
      events.push("start:" + name);
      await new Promise((r) => setTimeout(r, 5));
      events.push("end:" + name);
    });
  await Promise.all([worker("a"), worker("b"), worker("c")]);
  assert.deepStrictEqual(events, [
    "start:a", "end:a", "start:b", "end:b", "start:c", "end:c",
  ]);
});

test("withSetMarketLock: different items (or markets) still run in parallel", async () => {
  const events = [];
  const worker = (set, market, name) =>
    withSetMarketLock(set, market, async () => {
      events.push("start:" + name);
      await new Promise((r) => setTimeout(r, 5));
      events.push("end:" + name);
    });
  await Promise.all([
    worker("setA", "ggsel", "a"),
    worker("setB", "ggsel", "b"),
    worker("setA", "gameflip", "c"),
  ]);
  assert.deepStrictEqual(events.slice(0, 3).sort(), ["start:a", "start:b", "start:c"]);
});

test("withSetMarketLock: a thrown task releases the lock for the next one", async () => {
  await assert.rejects(
    withSetMarketLock("setA", "ggsel", async () => {
      throw new Error("rebuild failed");
    }),
    /rebuild failed/,
  );
  assert.equal(await withSetMarketLock("setA", "ggsel", async () => "ran"), "ran");
});
