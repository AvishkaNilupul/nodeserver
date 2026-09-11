// A G2G rent-farm order whose credential reached the buyer's chat must not read
// as FAILED because G2G refused the delivered count.
//
// delivered_qty answers HTTP 500 to this client (still open); the owner confirms
// G2G orders by hand on the order page. deliverFarmOrder used to let that 500
// fall into its catch-all: row `state:"failed"` plus a "rent-farm order FAILED"
// page about a buyer who already had the account. And once the owner confirmed
// by hand, the order left g2gPendingOrders, so nothing ever closed the row and
// the critical `orders.undelivered` health check stayed red for a served buyer.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const mp = require("../utils/marketplaces");
const farm = require("../utils/g2gFarmService");
const FarmServiceOrder = require("../models/FarmServiceOrder");

const FARM = fs.readFileSync(path.join(__dirname, "..", "utils", "g2gFarmService.js"), "utf8");
const FULFILLER = fs.readFileSync(path.join(__dirname, "..", "utils", "g2gFulfiller.js"), "utf8");

function fakeRow(extra) {
  return Object.assign(
    {
      orderId: "g2g:1789000000000ABCD-1",
      state: "sent",
      messageSentAt: new Date("2026-09-11T03:00:00Z"),
      deliveredAt: null,
      lastError: "",
      saves: 0,
      async save() {
        this.saves += 1;
      },
    },
    extra || {},
  );
}

async function withStub(obj, key, fn, body) {
  const real = obj[key];
  obj[key] = fn;
  try {
    return await body();
  } finally {
    obj[key] = real;
  }
}

/* ------------------------- the refused count ----------------------------- */

test("REGRESSION: a refused count after a verified send leaves the row 'sent'", async () => {
  const row = fakeRow();
  const r = await withStub(
    mp,
    "g2gSetDeliveredQty",
    async () => {
      throw new Error("G2G delivered qty failed (HTTP 500): Internal server error");
    },
    () => farm.confirmFarmOnG2g(row, "1789000000000ABCD-1", 1),
  );
  assert.strictEqual(r.confirmed, false);
  assert.strictEqual(row.state, "sent", "not 'failed' — the buyer has the account");
  assert.strictEqual(row.deliveredAt, null, "G2G has not counted it yet");
  assert.match(row.lastError, /confirm it on the G2G order page/);
  assert.ok(row.saves >= 1);
});

test("an accepted count closes the row", async () => {
  const row = fakeRow();
  const r = await withStub(mp, "g2gSetDeliveredQty", async () => ({}), () =>
    farm.confirmFarmOnG2g(row, "1789000000000ABCD-1", 1),
  );
  assert.strictEqual(r.confirmed, true);
  assert.strictEqual(row.state, "delivered");
  assert.ok(row.deliveredAt instanceof Date);
});

test("deliverFarmOrder reports 'sent, confirm it', never an error, on a refused count", () => {
  const fn = FARM.slice(FARM.indexOf("async function deliverFarmOrder("));
  const step3 = fn.slice(fn.indexOf("// 3. Only now"), fn.indexOf("} catch (e) {", fn.indexOf("// 3. Only now")));
  assert.match(step3, /await confirmFarmOnG2g\(row, orderId, qty\)/);
  assert.match(step3, /awaitingConfirm: true/);
  assert.doesNotMatch(step3, /alertFarmFailure|state = "failed"/);
  // Only the helper talks to delivered_qty.
  assert.strictEqual((FARM.match(/mp\.g2gSetDeliveredQty\(/g) || []).length, 1);
});

test("the fulfiller pages a farm 'awaitingConfirm' as SENT, not as a failure", () => {
  // deliverFarmOrder's result is the loop's `r`, so the bundle path's routing
  // covers rent-farm orders too.
  assert.match(FULFILLER, /\(await farmService\.deliverFarmOrder\(order, \{ dryRun \}\)\) \|\|/);
  assert.match(FULFILLER, /if \(r\.awaitingConfirm && !r\.error\) \{\s*await alertSentAwaitingConfirm/);
});

/* ------------------ closing rows the owner confirmed by hand --------------- */

test("REGRESSION: a row the owner confirmed on G2G is closed", async () => {
  const confirmed = fakeRow({ orderId: "g2g:AAA-1" });
  const waiting = fakeRow({ orderId: "g2g:BBB-1" });
  const unreadable = fakeRow({ orderId: "g2g:CCC-1" });
  const oldFailed = fakeRow({ orderId: "g2g:DDD-1", state: "failed" });
  let query = null;
  const asked = [];
  const r = await withStub(
    FarmServiceOrder,
    "find",
    async (q) => {
      query = q;
      return [confirmed, waiting, unreadable, oldFailed];
    },
    () =>
      withStub(
        mp,
        "g2gOrder",
        async (id) => {
          asked.push(id);
          if (id === "CCC-1") throw new Error("HTTP 502");
          if (id === "BBB-1") return { purchased_qty: 1, delivered_qty: 0 };
          return { purchased_qty: 1, delivered_qty: 1 };
        },
        () => farm.closeConfirmedFarmOrders(),
      ),
  );
  assert.deepStrictEqual(asked, ["AAA-1", "BBB-1", "CCC-1", "DDD-1"], "the g2g: prefix is stripped");
  assert.strictEqual(r.closed, 2);
  assert.strictEqual(confirmed.state, "delivered");
  assert.ok(confirmed.deliveredAt instanceof Date);
  assert.strictEqual(oldFailed.state, "delivered", "a count-refused 'failed' row closes too");
  assert.strictEqual(waiting.state, "sent", "not confirmed on G2G yet — stays open");
  assert.strictEqual(waiting.deliveredAt, null);
  assert.strictEqual(unreadable.state, "sent", "an unreadable order is left for the next pass");

  // Only G2G rows whose credential already went out.
  assert.strictEqual(query.market, "g2g");
  assert.deepStrictEqual(query.state, { $in: ["sent", "failed"] });
  assert.deepStrictEqual(query.messageSentAt, { $ne: null });
  assert.strictEqual(query.deliveredAt, null);
});

test("a partial delivery count does not close the row", async () => {
  const row = fakeRow({ orderId: "g2g:EEE-1" });
  await withStub(FarmServiceOrder, "find", async () => [row], () =>
    withStub(mp, "g2gOrder", async () => ({ purchased_qty: 3, delivered_qty: 2 }), () =>
      farm.closeConfirmedFarmOrders(),
    ),
  );
  assert.strictEqual(row.state, "sent");
});

test("the sweep runs on its own timer, behind the auto-deliver flag", () => {
  assert.match(FULFILLER, /loop\(sweepConfirmedFarmOrders, CONFIRM_SWEEP_MS,/);
  const fn = FULFILLER.slice(FULFILLER.indexOf("async function sweepConfirmedFarmOrders("));
  assert.match(fn.slice(0, 300), /if \(!af\.g2gAutoDeliver\) return/);
  assert.match(fn.slice(0, 300), /farmService\.closeConfirmedFarmOrders\(\)/);
});
