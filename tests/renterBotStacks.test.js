const test = require("node:test");
const assert = require("node:assert");
const {
  DEFAULT_CAPACITY,
  hostId,
  stackKey,
  assertCapacity,
  chooseAvailableStack,
  normalizeCapacity,
} = require("../utils/renterBotStacks");

test("rental stack keys normalize the local host", () => {
  assert.equal(hostId(""), "local");
  assert.equal(stackKey("", "config_16.json"), "local|config_16.json");
  assert.equal(stackKey("pi", "config_30.json"), "pi|config_30.json");
});

test("a rental stack accepts accounts up to its ten-account capacity", () => {
  assert.equal(DEFAULT_CAPACITY, 10);
  assert.deepEqual(assertCapacity(7, 3, 10), {
    used: 7,
    additions: 3,
    capacity: 10,
    remaining: 0,
  });
});

test("a rental stack rejects additions beyond capacity", () => {
  assert.throws(
    () => assertCapacity(7, 4, 10),
    (err) =>
      err.code === "rental_stack_full" &&
      err.used === 7 &&
      err.capacity === 10 &&
      err.requested === 4,
  );
});

test("quick farming packs the fullest available remote stack", () => {
  const picked = chooseAvailableStack([
    { host: "local", file: "config_16.json", accounts: 8, remaining: 2 },
    { host: "pi", file: "config_31.json", accounts: 3, remaining: 7 },
    { host: "pi", file: "config_30.json", accounts: 7, remaining: 3 },
    { host: "pi", file: "config_40.json", accounts: 10, remaining: 0 },
  ]);
  assert.equal(picked.file, "config_30.json");
});

test("quick farming returns null when every stack is full", () => {
  assert.equal(
    chooseAvailableStack([{ host: "pi", file: "config_30.json", remaining: 0 }]),
    null,
  );
});

test("normalizeCapacity accepts whole numbers within the schema bounds", () => {
  assert.equal(normalizeCapacity(1), 1);
  assert.equal(normalizeCapacity(100), 100);
  assert.equal(normalizeCapacity("50"), 50);
  assert.equal(normalizeCapacity(10.9), 10); // floored, not rounded
});

test("normalizeCapacity rejects out-of-range and non-numeric input as null", () => {
  assert.equal(normalizeCapacity(0), null);
  assert.equal(normalizeCapacity(101), null);
  assert.equal(normalizeCapacity(-5), null);
  assert.equal(normalizeCapacity("abc"), null);
  assert.equal(normalizeCapacity(""), null);
  assert.equal(normalizeCapacity(null), null);
  assert.equal(normalizeCapacity(undefined), null);
  assert.equal(normalizeCapacity(NaN), null);
});
