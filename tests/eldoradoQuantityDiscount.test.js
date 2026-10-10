// Eldorado refuses a quantity that sits under one of the offer's own
// quantity-discount tiers — "Invalid discount quantity of: 10. It must be
// greater than 1 and less or equal to 9." (seen live 2026-10-10, both when an
// offer is created and when its quantity is pushed).
//
// Every caller of the quantity push swallows its error (the stock sync, the
// push after a sale, the rotation). So an offer with a "10 or more" tier whose
// stock fell to 9 simply kept advertising its old quantity: accounts the farm
// no longer had, on sale. utils/marketplaces.eldSetQuantityVia is the fix, and
// this file pins it.
const test = require("node:test");
const assert = require("node:assert");

const mp = require("../utils/marketplaces");

const TIERS = [
  { quantity: 3, percentage: 5 },
  { quantity: 5, percentage: 10 },
  { quantity: 10, percentage: 15 },
];
// The error axios hands eldRequest's caller.
const refusal = (limit) => {
  const e = new Error("Request failed with status code 400");
  e.response = { status: 400, data: { messages: ["Invalid discount quantity of: 10. It must be greater than 1 and less or equal to " + limit + "."] } };
  return e;
};
const http = (status, message) => {
  const e = new Error("Request failed with status code " + status);
  e.response = { status, data: { messages: [message] } };
  return e;
};

// A fake offer on a fake Eldorado that enforces the same rule.
function eldorado({ quantity = 15, tiers = TIERS, updateTakes = true } = {}) {
  const offer = { quantity, volumeDiscounts: tiers.map((t) => ({ ...t })) };
  const calls = [];
  const io = {
    put: async (id, q) => {
      calls.push(["put", q]);
      const over = offer.volumeDiscounts.find((t) => t.quantity > q);
      if (over) throw refusal(q);
      offer.quantity = q;
    },
    read: async () => {
      calls.push(["read"]);
      return { ...offer, volumeDiscounts: offer.volumeDiscounts.map((t) => ({ ...t })) };
    },
    update: async (id, patch) => {
      calls.push(["update", patch]);
      if (updateTakes) {
        offer.quantity = patch.quantity;
        offer.volumeDiscounts = patch.volumeDiscounts;
      }
      return { ...offer };
    },
    fail: (e) => {
      calls.push(["fail"]);
      const err = new Error("Eldorado set quantity failed (HTTP " + ((e.response && e.response.status) || "?") + ")");
      err.__eld = true;
      throw err;
    },
  };
  return { offer, calls, io };
}

test("a quantity above every tier is a plain push, exactly as before", async () => {
  const e = eldorado();
  assert.strictEqual(await mp.eldSetQuantityVia(e.io, "o-1", 12), 12);
  assert.deepStrictEqual(e.calls, [["put", 12]]);
  assert.strictEqual(e.offer.quantity, 12);
  assert.deepStrictEqual(e.offer.volumeDiscounts, TIERS);
  // An offer with no tiers at all, at any quantity.
  const plain = eldorado({ tiers: [] });
  assert.strictEqual(await mp.eldSetQuantityVia(plain.io, "o-2", 1), 1);
  assert.deepStrictEqual(plain.calls, [["put", 1]]);
});

test("a quantity under a tier: the unreachable tiers go, and the TRUE quantity is set", async () => {
  const e = eldorado({ quantity: 15 });
  assert.strictEqual(await mp.eldSetQuantityVia(e.io, "o-1", 9), 9);
  assert.strictEqual(e.offer.quantity, 9, "the offer no longer advertises accounts that are not there");
  assert.deepStrictEqual(e.offer.volumeDiscounts, TIERS.slice(0, 2), "3+ and 5+ still apply; 10+ could not");
  assert.deepStrictEqual(e.calls.map((c) => c[0]), ["put", "read", "update"]);
  assert.deepStrictEqual(e.calls[2][1], { quantity: 9, volumeDiscounts: TIERS.slice(0, 2) });

  const four = eldorado({ quantity: 15 });
  await mp.eldSetQuantityVia(four.io, "o-1", 4);
  assert.deepStrictEqual(four.offer.volumeDiscounts, TIERS.slice(0, 1));
  // Two left, then one: no tier can apply (a tier must be over 1 and no more
  // than the quantity).
  const two = eldorado({ quantity: 15 });
  await mp.eldSetQuantityVia(two.io, "o-1", 2);
  assert.deepStrictEqual(two.offer.volumeDiscounts, []);
  assert.strictEqual(two.offer.quantity, 2);
  const one = eldorado({ quantity: 15 });
  await mp.eldSetQuantityVia(one.io, "o-1", 1);
  assert.deepStrictEqual(one.offer.volumeDiscounts, []);
  assert.strictEqual(one.offer.quantity, 1);
  // From then on it is a plain push again.
  await mp.eldSetQuantityVia(one.io, "o-1", 3);
  assert.deepStrictEqual(one.calls.slice(-1), [["put", 3]]);
});

test("if the quantity still does not take, it fails loudly — never a quiet success", async () => {
  const e = eldorado({ quantity: 15, updateTakes: false });
  await assert.rejects(() => mp.eldSetQuantityVia(e.io, "o-1", 9), /did not take/);
  assert.strictEqual(e.offer.quantity, 15);
});

test("any other refusal fails as it always did: no read, no edit", async () => {
  for (const err of [http(400, "Maximum quantity exceeded"), http(500, "boom"), http(401, "session"), new Error("socket hang up")]) {
    const e = eldorado();
    e.io.put = async () => {
      e.calls.push(["put"]);
      throw err;
    };
    await assert.rejects(() => mp.eldSetQuantityVia(e.io, "o-1", 9), /Eldorado set quantity failed/);
    assert.deepStrictEqual(e.calls.map((c) => c[0]), ["put", "fail"]);
  }
  // Quantity 0 is the pause's job, not this push's.
  const zero = eldorado();
  await assert.rejects(() => mp.eldSetQuantityVia(zero.io, "o-1", 0), /Eldorado set quantity failed/);
  assert.deepStrictEqual(zero.calls.map((c) => c[0]), ["put", "fail"]);
});

test("eldDiscountRefusal: Eldorado's own words, raw or already wrapped", () => {
  assert.strictEqual(mp.eldDiscountRefusal(refusal(9)), true);
  const wrapped = new Error("Eldorado set quantity failed (HTTP 400): Invalid discount quantity of: 10. It must be greater than 1 and less or equal to 9.");
  wrapped.status = 400;
  assert.strictEqual(mp.eldDiscountRefusal(wrapped), true);
  const text = new Error("x");
  text.response = { status: 400, data: "Invalid discount quantity of: 5." };
  assert.strictEqual(mp.eldDiscountRefusal(text), true);
  assert.strictEqual(mp.eldDiscountRefusal(http(400, "Maximum quantity exceeded")), false);
  assert.strictEqual(mp.eldDiscountRefusal(http(500, "Invalid discount quantity")), false, "only a refusal, never a server error");
  assert.strictEqual(mp.eldDiscountRefusal(new Error("timeout")), false);
  assert.strictEqual(mp.eldDiscountRefusal(null), false);
});
