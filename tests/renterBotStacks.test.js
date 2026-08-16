const test = require("node:test");
const assert = require("node:assert");
const {
  DEFAULT_CAPACITY,
  hostId,
  stackKey,
  assertCapacity,
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
