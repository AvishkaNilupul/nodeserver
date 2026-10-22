// rotateRow on a sold-out (Closed) Eldorado offer — 2026-10-22, R6 c847f2c2.
const test = require("node:test");
const assert = require("node:assert");
const rot = require("../utils/noclaimOfferRotation");

function deps({ state = "Closed", stock = 5, titleTakes = true } = {}) {
  const calls = [];
  const row = { _id: "r1", externalId: "x1", set: "old", status: "active", autoPaused: true };
  const d = {
    calls,
    mp: {
      eldoradoOffer: async () => ({ offerState: state, pricePerUnit: { amount: 1.81 } }),
      eldoradoUpdateOffer: async (id, patch) => {
        calls.push(["update", patch]);
        return { offerTitle: titleTakes ? patch.title || "T" : "old", pricePerUnit: { amount: 1.81 } };
      },
      eldoradoRelist: async () => calls.push(["relist"]),
      eldoradoSetQuantity: async (id, n) => calls.push(["setQuantity", n]),
    },
    MarketplaceListing: {
      updateOne: async () => ({ modifiedCount: 1 }),
      findById: () => ({ lean: async () => ({ ...row, set: "new" }) }),
    },
    ncs: { requiredDropsForSet: () => [], stockForListing: async () => stock },
  };
  return { d, row, ctx: { set: { _id: "new" }, title: "T", description: "D", image: "img", now: Date.now() } };
}

test("Closed and Paused are both rewritable", () => {
  assert.ok(rot.REWRITABLE_STATES.has("Closed"));
  assert.ok(rot.REWRITABLE_STATES.has("Paused"));
  assert.ok(!rot.REWRITABLE_STATES.has("Active"));
});

test("a Closed offer is rewritten with quantity 1, then stocked through the edit and resumed", async () => {
  const { d, row, ctx } = deps({ state: "Closed", stock: 7 });
  const r = await rot.rotateRow(d, row, ctx);
  assert.deepStrictEqual(r, { rotated: true, stock: 7 });
  assert.strictEqual(d.calls[0][0], "update");
  assert.strictEqual(d.calls[0][1].quantity, 1);
  assert.deepStrictEqual(d.calls.slice(1), [["update", { quantity: 7 }], ["relist"]]);
});

test("a Paused offer keeps the old path: no quantity in the edit, setQuantity after resume", async () => {
  const { d, row, ctx } = deps({ state: "Paused", stock: 4 });
  const r = await rot.rotateRow(d, row, ctx);
  assert.deepStrictEqual(r, { rotated: true, stock: 4 });
  assert.strictEqual(d.calls[0][1].quantity, undefined);
  assert.deepStrictEqual(d.calls.slice(1), [["relist"], ["setQuantity", 4]]);
});

test("a Closed offer with no stock after the move stays closed", async () => {
  const { d, row, ctx } = deps({ state: "Closed", stock: 0 });
  const r = await rot.rotateRow(d, row, ctx);
  assert.deepStrictEqual(r, { rotated: true, stock: 0 });
  assert.strictEqual(d.calls.length, 1);
});

test("an Active offer is never rewritten", async () => {
  const { d, row, ctx } = deps({ state: "Active" });
  const r = await rot.rotateRow(d, row, ctx);
  assert.match(r.skipped, /Active/);
  assert.strictEqual(d.calls.length, 0);
});
