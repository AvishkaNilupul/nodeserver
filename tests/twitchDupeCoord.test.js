// Unit tests for utils/twitchDupeCoord — the state machine + reservation
// picker that gate the Overwatch dupe-box delivery pipeline. These tests only
// exercise the pure/synchronous slices and the reservation picker with a
// stubbed model — the full Mongo-backed state transitions are covered by a
// live smoke test against a real DB before the flag flips on.

// Config load has to be hermetic — settings.js reads the environment when it
// is first required, and we mirror the account-api test setup so this file
// can run standalone.
process.env.ADMIN_KEY = process.env.ADMIN_KEY || "test-admin-key";
process.env.MONGO_URI = process.env.MONGO_URI || "mongodb://localhost/test";

const test = require("node:test");
const assert = require("node:assert/strict");

// Require BEFORE mutating so we can replace model methods in place.
const TwitchDupeFireJob = require("../models/TwitchDupeFireJob");
const settings = require("../utils/settings");
const {
  mintOrderRef,
  ACTIVE_STATES,
  dupeSettings,
  reservedUsernamesInFlight,
  pickFreeUsernames,
} = require("../utils/twitchDupeCoord");

// ---------------------------- mintOrderRef -------------------------------

test("mintOrderRef looks like a t.me deep-link payload", () => {
  const ref = mintOrderRef();
  assert.match(ref, /^DPBX-[0-9a-f]{6}$/, "6 hex chars, lowercase, DPBX- prefix");
});

test("mintOrderRef gives different refs across a large batch", () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(mintOrderRef());
  // 500 draws over 16M-slot space — the odds of any collision are ~0.008.
  // A stricter equality would flake; this catches a broken RNG (e.g. hard-
  // coded seed) which is what actually breaks.
  assert.ok(seen.size >= 498, `expected ~500 unique refs, got ${seen.size}`);
});

// ---------------------------- ACTIVE_STATES ------------------------------

test("ACTIVE_STATES covers every state that still owes the buyer accounts", () => {
  // Every state where a reservation is still burnt on the pool must appear
  // here — pickFreeUsernames uses this exact list to compute what's held.
  assert.ok(ACTIVE_STATES.includes("awaitingClaim"));
  assert.ok(ACTIVE_STATES.includes("awaitingLink"));
  assert.ok(ACTIVE_STATES.includes("readyToFire"));
  assert.ok(ACTIVE_STATES.includes("firing"));
});

test("ACTIVE_STATES excludes every closed state", () => {
  // done/failed/cancelled must free the reservation so the pool can refill.
  for (const closed of ["done", "failed", "cancelled"]) {
    assert.ok(
      !ACTIVE_STATES.includes(closed),
      `${closed} must not tie up the pool`,
    );
  }
});

// ---------------------------- dupeSettings -------------------------------

test("dupeSettings coerces missing values to safe defaults", async (t) => {
  // Save + restore so we don't leak state into other tests in the same run.
  const before = settings.getAutoFarm();
  await settings.setAutoFarm({
    twitchDupeOfferId: "",
    twitchDupePool: undefined,
    twitchDupeFireCount: undefined,
    twitchDupeAuto: undefined,
    twitchDupeOwnerChatId: undefined,
    twitchDupeBotName: undefined,
    twitchDupeSilenceMinutes: undefined,
  });
  t.after(async () => {
    await settings.setAutoFarm(before);
  });

  const s = dupeSettings();
  assert.equal(s.offerId, "");
  assert.deepEqual(s.pool, []);
  assert.equal(s.fireCount, 2600, "must fall back to the bot's own default");
  assert.equal(s.auto, false, "must be OFF by default");
  assert.equal(s.ownerChatId, 0);
  assert.equal(s.silenceFallbackMinutes, 30);
});

test("dupeSettings reads a configured pool as-is (order preserved)", async (t) => {
  const before = settings.getAutoFarm();
  await settings.setAutoFarm({
    twitchDupeOfferId: "abc",
    twitchDupePool: ["one", "two", "three"],
    twitchDupeFireCount: 1500,
    twitchDupeAuto: true,
    twitchDupeOwnerChatId: 42,
    twitchDupeBotName: "TestBot",
    twitchDupeSilenceMinutes: 20,
  });
  t.after(async () => {
    await settings.setAutoFarm(before);
  });

  const s = dupeSettings();
  assert.equal(s.offerId, "abc");
  assert.deepEqual(s.pool, ["one", "two", "three"]);
  assert.equal(s.fireCount, 1500);
  assert.equal(s.auto, true);
  assert.equal(s.ownerChatId, 42);
  assert.equal(s.botName, "TestBot");
  assert.equal(s.silenceFallbackMinutes, 20);
});

// ---------------------------- pickFreeUsernames --------------------------

function stubFind(rows) {
  // Match the shape of `TwitchDupeFireJob.find(q, projection).lean()`.
  const original = TwitchDupeFireJob.find;
  TwitchDupeFireJob.find = function () {
    return {
      lean: async () => rows,
    };
  };
  return () => {
    TwitchDupeFireJob.find = original;
  };
}

test("reservedUsernamesInFlight collapses duplicates case-insensitively", async (t) => {
  const restore = stubFind([
    { reservedUsernames: [{ login: "Alpha" }, { login: "beta" }] },
    { reservedUsernames: [{ login: "ALPHA" }] },
    { reservedUsernames: [{ login: "gamma" }] },
  ]);
  t.after(restore);

  const held = await reservedUsernamesInFlight();
  // Held set is normalised to lowercase, and each distinct login appears once.
  assert.deepEqual([...held].sort(), ["alpha", "beta", "gamma"]);
});

test("pickFreeUsernames skips held logins and respects pool order", async (t) => {
  const restore = stubFind([
    { reservedUsernames: [{ login: "two" }, { login: "FIVE" }] },
  ]);
  t.after(restore);

  const before = settings.getAutoFarm();
  await settings.setAutoFarm({
    twitchDupePool: ["one", "two", "three", "four", "five"],
  });
  t.after(async () => {
    await settings.setAutoFarm(before);
  });

  const picked = await pickFreeUsernames(3);
  assert.deepEqual(
    picked,
    ["one", "three", "four"],
    "must skip 'two' (held) and 'five' (held via case-insensitive match)",
  );
});

test("pickFreeUsernames throws when the pool is dry", async (t) => {
  const restore = stubFind([]);
  t.after(restore);

  const before = settings.getAutoFarm();
  await settings.setAutoFarm({ twitchDupePool: [] });
  t.after(async () => {
    await settings.setAutoFarm(before);
  });

  await assert.rejects(pickFreeUsernames(1), /pool is empty/);
});

test("pickFreeUsernames throws when the pool is short of the ask", async (t) => {
  const restore = stubFind([{ reservedUsernames: [{ login: "one" }] }]);
  t.after(restore);

  const before = settings.getAutoFarm();
  await settings.setAutoFarm({ twitchDupePool: ["one", "two"] });
  t.after(async () => {
    await settings.setAutoFarm(before);
  });

  await assert.rejects(
    pickFreeUsernames(2),
    /pool short: need 2, have 1 free/,
  );
});

test("pickFreeUsernames dedupes typos within the pool itself", async (t) => {
  const restore = stubFind([]);
  t.after(restore);

  const before = settings.getAutoFarm();
  await settings.setAutoFarm({
    twitchDupePool: ["one", "ONE", " one ", "two"],
  });
  t.after(async () => {
    await settings.setAutoFarm(before);
  });

  const picked = await pickFreeUsernames(2);
  // "one" appears three times as a pool typo — must count once.
  assert.deepEqual(picked, ["one", "two"]);
});
