// utils/poolStock.js — what a pool account's Twitch inventory holds, and the
// hand-over loop that refuses anything that is not empty.
//
// Written after mbryixwcgf (a re-imported web-token farm account holding six
// unclaimed Overwatch drops) was handed to an Eldorado rent-farm buyer as a
// "clean fresh account" on 2026-09-11: its pool row said dropCount 0 because
// dropCount only ever counted CLAIMED rewards. No DB connection is used here —
// every side effect of verifyFreshLive is injected.
const test = require("node:test");
const assert = require("node:assert");

const {
  STOCK_NOTE_PREFIX,
  inventoryHoldings,
  freshnessVerdict,
  stockNote,
  isStockNote,
  verifyFreshLive,
  placeFirstFresh,
} = require("../utils/poolStock");

// The shape mbryixwcgf had when it was delivered: nothing claimed, six
// Overwatch drops at 100% waiting in inProgress.
const owFinals = [
  "Pachimonarch Spray",
  "Battle Pass Tier Skip",
  "Purple Reign Name Card",
  "Sugar Hop Spray",
  "Boba Buddy Icon",
  "Esports Loot Box",
].map((name) => ({
  name,
  game: "Overwatch",
  campaign: "CAH Championship Finals",
  percent: 100,
  claimed: false,
}));
const webbotAccount = () => ({ drops: [], inProgress: owFinals.slice() });

test("unclaimed 100% drops are counted — the field that was missing", () => {
  const h = inventoryHoldings(webbotAccount());
  assert.strictEqual(h.claimed, 0, "nothing claimed: this is why dropCount read 0");
  assert.strictEqual(h.unclaimed, 6);
  assert.deepStrictEqual(h.unclaimedGames, ["Overwatch"]);
});

test("partial progress and already-claimed in-progress drops are not stock", () => {
  const h = inventoryHoldings({
    drops: [],
    inProgress: [
      { name: "a", game: "Rainbow Six Siege", percent: 40, claimed: false },
      { name: "b", game: "Rainbow Six Siege", percent: 0, claimed: false },
      // claimed in-progress entries report percent 100 — they are rewards, not stock
      { name: "c", game: "Overwatch", percent: 100, claimed: true },
    ],
  });
  assert.strictEqual(h.unclaimed, 0);
  assert.strictEqual(freshnessVerdict(h).fresh, true, "progress bars are not items");
});

test("claimed rewards are counted exactly like dropCount always was", () => {
  const h = inventoryHoldings({
    drops: [
      { name: "x", game: "Overwatch" },
      { name: "y", game: "Overwatch" },
      { name: "z", game: "" },
    ],
    inProgress: [],
  });
  assert.strictEqual(h.claimed, 3);
  assert.deepStrictEqual(h.claimedGames, ["Overwatch"], "blank game names are dropped");
});

test("junk inventories never crash", () => {
  for (const inv of [null, undefined, {}, { drops: null, inProgress: "x" }]) {
    const h = inventoryHoldings(inv);
    assert.strictEqual(h.claimed, 0);
    assert.strictEqual(h.unclaimed, 0);
  }
});

test("freshness: empty only; stock and claimed rewards both refuse, with a reason", () => {
  assert.deepStrictEqual(freshnessVerdict(inventoryHoldings({ drops: [], inProgress: [] })), {
    fresh: true,
    reason: "",
  });
  const stock = freshnessVerdict(inventoryHoldings(webbotAccount()));
  assert.strictEqual(stock.fresh, false);
  assert.match(stock.reason, /6 unclaimed/);
  assert.match(stock.reason, /Overwatch/);
  const used = freshnessVerdict(
    inventoryHoldings({ drops: [{ name: "x", game: "Apex Legends" }], inProgress: [] }),
  );
  assert.strictEqual(used.fresh, false);
  assert.match(used.reason, /1 claimed/);
  assert.strictEqual(freshnessVerdict(null).fresh, false, "no reading is never fresh");
});

test("the hold note can never be mistaken for another engine's note", () => {
  const note = stockNote(inventoryHoldings(webbotAccount()));
  assert.ok(note.startsWith(STOCK_NOTE_PREFIX));
  assert.ok(isStockNote(note));
  assert.ok(note.length <= 200);
  // Prefixes other code keys off. A match on any of these would hand a held
  // account to the recycler, the renter guards, or the sold-map.
  for (const re of [/^spent — /i, /^rented to/i, /^recycled/i, /^deployed to /i, /^sold/i, /^noclaim-farm:/i, /^auto-farm:/i]) {
    assert.ok(!re.test(note), "collides with " + re);
  }
  assert.strictEqual(isStockNote("rented to operator-selffarm"), false);
});

function recorder() {
  const calls = { persist: [], hold: [], requeue: [] };
  return {
    calls,
    persist: async (id, h) => calls.persist.push([id, h.claimed, h.unclaimed]),
    hold: async (id, h) => calls.hold.push([id, h.unclaimed]),
    requeue: (id) => calls.requeue.push(id),
  };
}

test("verifyFreshLive refuses the webbot account, saves the counts and holds it", async () => {
  const r = recorder();
  const v = await verifyFreshLive(
    { _id: "p1", clientSecret: "t" },
    { ...r, fetch: async () => webbotAccount() },
  );
  assert.strictEqual(v.fresh, false);
  assert.strictEqual(v.code, "not_fresh");
  assert.deepStrictEqual(r.calls.persist, [["p1", 0, 6]]);
  assert.deepStrictEqual(r.calls.hold, [["p1", 6]]);
});

test("a claimed-only account is refused but NOT held (a claiming bot cannot hurt it)", async () => {
  const r = recorder();
  const v = await verifyFreshLive(
    { _id: "p2", clientSecret: "t" },
    { ...r, fetch: async () => ({ drops: [{ name: "x", game: "Apex Legends" }], inProgress: [] }) },
  );
  assert.strictEqual(v.code, "not_fresh");
  assert.deepStrictEqual(r.calls.hold, []);
});

test("an empty account passes", async () => {
  const r = recorder();
  const v = await verifyFreshLive(
    { _id: "p3", clientSecret: "t" },
    { ...r, fetch: async () => ({ drops: [], inProgress: [] }) },
  );
  assert.strictEqual(v.fresh, true);
  assert.deepStrictEqual(r.calls.persist, [["p3", 0, 0]]);
});

test("a failed read writes NOTHING (a Twitch hiccup says nothing about the account)", async () => {
  const r = recorder();
  const v = await verifyFreshLive(
    { _id: "p4", clientSecret: "t" },
    {
      ...r,
      fetch: async () => {
        const e = new Error("Twitch returned no user (transient)");
        e.code = "no_user";
        throw e;
      },
    },
  );
  assert.strictEqual(v.fresh, false);
  assert.strictEqual(v.code, "unverifiable");
  assert.deepStrictEqual(r.calls, { persist: [], hold: [], requeue: [] });
});

test("a dead token is refused and queued for a proper pool re-check", async () => {
  const r = recorder();
  const v = await verifyFreshLive(
    { _id: "p5", clientSecret: "t" },
    {
      ...r,
      fetch: async () => {
        const e = new Error("Token invalid/expired");
        e.code = "token_invalid";
        throw e;
      },
    },
  );
  assert.strictEqual(v.code, "token_invalid");
  assert.deepStrictEqual(r.calls.requeue, ["p5"]);
  assert.deepStrictEqual(r.calls.persist, []);
});

test("verifyFreshLive never throws, even when every side effect does", async () => {
  const boom = async () => {
    throw new Error("db down");
  };
  const v = await verifyFreshLive(
    { _id: "p6", clientSecret: "t" },
    { fetch: async () => webbotAccount(), persist: boom, hold: boom, requeue: () => {} },
  );
  assert.strictEqual(v.code, "not_fresh");
});

// ---- placeFirstFresh: the hand-over loop ---------------------------------

const cand = (u, status = "available") => ({ _id: u, username: u, status });
const coded = (code, msg = code) => {
  const e = new Error(msg);
  if (code) e.code = code;
  return e;
};

test("walks past accounts that hold drops and fills the order with the next fresh one", async () => {
  const dirty = new Set(["a", "b"]);
  const { added, skipped } = await placeFirstFresh([cand("a"), cand("b"), cand("c"), cand("d")], {
    want: 1,
    place: async (d) => {
      if (dirty.has(d.username)) throw coded("not_fresh", "holds 6 unclaimed farmed drop(s)");
      return d.username;
    },
  });
  assert.deepStrictEqual(added, ["c"], "the order is filled, not left short");
  assert.deepStrictEqual(skipped.map((s) => s.username), ["a", "b"]);
  assert.match(skipped[0].reason, /unclaimed/);
});

test("takes exactly `want` and stops", async () => {
  const placed = [];
  const { added } = await placeFirstFresh([cand("a"), cand("b"), cand("c")], {
    want: 2,
    place: async (d) => (placed.push(d.username), d.username),
  });
  assert.deepStrictEqual(added, ["a", "b"]);
  assert.deepStrictEqual(placed, ["a", "b"], "never places more than asked");
});

test("a real placement failure still counts as the attempt (a dead host is not retried per account)", async () => {
  let calls = 0;
  const { added, skipped } = await placeFirstFresh([cand("a"), cand("b"), cand("c")], {
    want: 1,
    place: async () => {
      calls++;
      throw new Error("Rental stack capacity exceeded (10/10 accounts used)");
    },
  });
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(added, []);
  assert.match(skipped[0].reason, /capacity/);
});

test("accounts taken meanwhile are skipped, not counted", async () => {
  const { added, skipped } = await placeFirstFresh([cand("a"), cand("b"), cand("c")], {
    want: 1,
    recheck: async (d) => (d.username === "a" ? cand("a", "claimed") : d.username === "b" ? null : d),
    place: async (d) => d.username,
  });
  assert.deepStrictEqual(added, ["c"]);
  assert.deepStrictEqual(skipped.map((s) => s.reason), ["no longer available", "no longer available"]);
});

test("a claim race and a dead token both move on to the next account", async () => {
  const { added } = await placeFirstFresh([cand("a"), cand("b"), cand("c")], {
    want: 1,
    place: async (d) => {
      if (d.username === "a") throw coded("claimed_elsewhere");
      if (d.username === "b") throw coded("token_invalid");
      return d.username;
    },
  });
  assert.deepStrictEqual(added, ["c"]);
});

test("stops after a few unreadable inventories instead of hammering Twitch", async () => {
  let calls = 0;
  const { added, skipped } = await placeFirstFresh(
    ["a", "b", "c", "d", "e", "f"].map((u) => cand(u)),
    {
      want: 1,
      maxUnreadable: 3,
      place: async () => {
        calls++;
        throw coded("unverifiable", "could not read the Twitch inventory");
      },
    },
  );
  assert.strictEqual(calls, 3);
  assert.deepStrictEqual(added, []);
  assert.strictEqual(skipped.length, 3);
});

test("the live-read budget is a hard cap and says why it stopped", async () => {
  let calls = 0;
  const { added, skipped } = await placeFirstFresh(
    Array.from({ length: 50 }, (_, i) => cand("u" + i)),
    {
      want: 1,
      budget: 5,
      place: async () => {
        calls++;
        throw coded("not_fresh");
      },
    },
  );
  assert.strictEqual(calls, 5);
  assert.deepStrictEqual(added, []);
  assert.strictEqual(skipped[skipped.length - 1].username, "(stopped)");
});

test("an empty candidate list or want 0 does nothing", async () => {
  const place = async () => assert.fail("must not place");
  assert.deepStrictEqual(await placeFirstFresh([], { want: 1, place }), { added: [], skipped: [] });
  assert.deepStrictEqual(await placeFirstFresh([cand("a")], { want: 0, place }), {
    added: [],
    skipped: [],
  });
});
