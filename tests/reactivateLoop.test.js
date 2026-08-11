// The guardian's GGSel self-heal re-activates an offer that is stocked but
// paused. When GGSel accepts the activate call and pauses the offer again
// anyway, that "heal" repeats every tick forever — 466 times for one offer,
// which is what the reactivate-loop detection exists to catch.
//
// Two defects in that detection are pinned here:
//
//   1. The finding it raises could never close. Its type is "restock-failed"
//      and its dedupeKey is "reactivate-loop:", which autoResolveStale does
//      not sweep (not a CONDITION_TYPE, and the only restock-failed prefix it
//      whitelists is "restock-empty:"). Once GGSel stopped re-pausing, the
//      finding stayed open forever.
//
//   2. The streak was cleared on a case that was never verified. reactivated
//      is false both when the offer was already active AND on the `pending`
//      early return, where finalize saw no stock and never read the offer's
//      status at all. Because ggselStockField (used by the upstream gate)
//      prefers in_stock_splitted_products_count while ggselFinalizeStock read
//      only in_stock_products_count, a splitted-products offer could reach the
//      self-heal branch, come back pending, and reset its streak every single
//      pass — making the detection permanently unreachable for that class.
//
// feedListing is exercised through its real module with the marketplace and
// model layers stubbed, so the branch wiring itself is what's under test.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

// ---------------------------------------------------------------- harness --

const ROW = {
  _id: "listing-1",
  marketplace: "ggsel",
  externalId: "102669379",
  qtyTarget: 5,
  set: "set-1",
  status: "active",
  autoDeliver: true,
};

// Load a fresh copy of the guardian with ../marketplaces and the mongoose
// models replaced. Fresh because the reactivate streak is module-level state:
// each scenario must start from zero.
function loadGuardian({ finalizeResults, findingSink, listingStatus }) {
  const calls = { finalize: 0, updates: [] };
  let finalizeIdx = 0;

  const fakeMp = {
    async ggselOfferStockDetailed() {
      // Stocked to target, so feedListing takes the need <= 0 self-heal path.
      return { stock: 5, reason: "" };
    },
    async digisellerProductStockDetailed() {
      return { stock: 5, reason: "" };
    },
    async ggselFinalizeStock() {
      calls.finalize++;
      const r =
        finalizeResults[Math.min(finalizeIdx, finalizeResults.length - 1)];
      finalizeIdx++;
      return r;
    },
  };

  // Minimal AuditFinding: records upserts and resolution updates.
  const fakeFinding = {
    async findOneAndUpdate(query, update) {
      findingSink.upserts.push({
        dedupeKey: query.dedupeKey,
        message: update.$set && update.$set.message,
        type: update.$set && update.$set.type,
      });
      return { lastErrorObject: { upserted: true }, value: null };
    },
    async updateMany(query, update) {
      findingSink.updates.push({
        dedupeKey: query.dedupeKey,
        status: update.$set && update.$set.status,
        resolution: update.$set && update.$set.resolution,
      });
      return { modifiedCount: 1 };
    },
    async updateOne() {
      return { modifiedCount: 1 };
    },
    async countDocuments() {
      return 0;
    },
  };

  const fakeListing = {
    findOne() {
      // feedOne calls .findOne(...).lean()
      return {
        lean: async () =>
          listingStatus ? { ...ROW, status: listingStatus } : null,
      };
    },
    async updateOne(q, u) {
      calls.updates.push(u);
      return { modifiedCount: 1 };
    },
    find() {
      return { limit: () => ({ lean: async () => [] }) };
    },
  };

  const guardianPath = require.resolve("../utils/marketplaceGuardian");
  const mpPath = require.resolve("../utils/marketplaces");
  const findingPath = require.resolve("../models/AuditFinding");
  const listingPath = require.resolve("../models/MarketplaceListing");

  const origLoad = Module._load;
  const stubs = new Map([
    [mpPath, fakeMp],
    [findingPath, fakeFinding],
    [listingPath, fakeListing],
  ]);
  Module._load = function (request, parent, isMain) {
    try {
      const resolved = Module._resolveFilename(request, parent, isMain);
      if (stubs.has(resolved)) return stubs.get(resolved);
    } catch {
      /* fall through to the real loader */
    }
    return origLoad.apply(this, arguments);
  };

  delete require.cache[guardianPath];
  let guardian;
  try {
    guardian = require(guardianPath);
  } finally {
    Module._load = origLoad;
    delete require.cache[guardianPath];
  }
  return { guardian, calls };
}

// Drive N guardian passes over the same listing. feedOne is the exported entry
// into feedListing; the reactivate streak lives in module state, so successive
// passes accumulate exactly as they do in a running guardian.
async function runPasses(guardian, n) {
  for (let i = 0; i < n; i++) {
    await guardian.feedOne(ROW._id);
  }
}

// --------------------------------------------------------------- defect 1 --

test("the reactivate-loop finding resolves once the offer stays active", async () => {
  const sink = { upserts: [], updates: [] };
  // Three passes where GGSel re-pauses (streak hits the threshold of 3 and
  // raises the finding), then a pass that finds the offer already active.
  const { guardian } = loadGuardian({
    findingSink: sink,
    listingStatus: "active",
    finalizeResults: [
      { stock: 5, reactivated: true, pending: false },
      { stock: 5, reactivated: true, pending: false },
      { stock: 5, reactivated: true, pending: false },
      { stock: 5, reactivated: false, pending: false }, // verified active
    ],
  });

  await runPasses(guardian, 4);

  const raised = sink.upserts.filter((u) =>
    String(u.dedupeKey).startsWith("reactivate-loop:"),
  );
  assert.ok(raised.length >= 1, "the loop finding should have been raised");

  // The fix: a pass that proves the offer is active must explicitly resolve
  // the finding, because nothing else ever will.
  const resolved = sink.updates.filter(
    (u) =>
      String(u.dedupeKey).startsWith("reactivate-loop:") &&
      u.status === "resolved",
  );
  assert.strictEqual(
    resolved.length,
    1,
    "the loop finding must be resolved when the offer is found active",
  );
});

// --------------------------------------------------------------- defect 2 --

test("a pending finalize does not reset an accumulated streak", async () => {
  const sink = { upserts: [], updates: [] };
  // Two re-activations, then a `pending` result (finalize saw no stock and
  // never read the offer status), then a third re-activation. Pending must not
  // count as "verified active", so the streak survives and the third
  // re-activation crosses the threshold.
  const { guardian } = loadGuardian({
    findingSink: sink,
    listingStatus: "active",
    finalizeResults: [
      { stock: 5, reactivated: true, pending: false },
      { stock: 5, reactivated: true, pending: false },
      { stock: 0, reactivated: false, pending: true }, // must NOT clear
      { stock: 5, reactivated: true, pending: false },
    ],
  });

  await runPasses(guardian, 4);

  const raised = sink.upserts.filter((u) =>
    String(u.dedupeKey).startsWith("reactivate-loop:"),
  );
  assert.ok(
    raised.length >= 1,
    "a pending finalize must not wipe the streak — the loop stayed undetected",
  );

  // And a pending result must never be mistaken for proof of health.
  const resolvedOnPending = sink.updates.filter(
    (u) =>
      String(u.dedupeKey).startsWith("reactivate-loop:") &&
      u.status === "resolved",
  );
  assert.strictEqual(
    resolvedOnPending.length,
    0,
    "a pending finalize must not resolve the loop finding",
  );
});

test("a stuck activation is reported on the first pass", async () => {
  const sink = { upserts: [], updates: [] };
  // finalize re-read the offer straight after batch_activate and it was STILL
  // paused. That is direct proof, so it must not wait for three passes.
  const { guardian } = loadGuardian({
    findingSink: sink,
    listingStatus: "active",
    finalizeResults: [
      {
        stock: 5,
        reactivated: true,
        pending: false,
        activationStuck: true,
        activationStatus: "paused",
      },
    ],
  });

  await runPasses(guardian, 1);

  const raised = sink.upserts.filter((u) =>
    String(u.dedupeKey).startsWith("reactivate-loop:"),
  );
  assert.strictEqual(
    raised.length,
    1,
    "an activation verified as stuck must raise on the first pass",
  );
  assert.match(String(raised[0].message), /still reads paused immediately/);
});

// The finding text is the only thing a human sees when triaging this, so it has
// to name the status the offer is actually in. 102669379 sat in DRAFT while the
// message said "paused", which points the reader at the wrong problem: a paused
// offer was live and came off sale, a draft one never went live at all.
test("the finding names the real status, and draft says why it matters", async () => {
  const sink = { upserts: [], updates: [] };
  const { guardian } = loadGuardian({
    findingSink: sink,
    listingStatus: "active",
    finalizeResults: [
      {
        stock: 3,
        reactivated: true,
        pending: false,
        activationStuck: true,
        activationStatus: "draft",
      },
    ],
  });

  await runPasses(guardian, 1);

  const raised = sink.upserts.filter((u) =>
    String(u.dedupeKey).startsWith("reactivate-loop:"),
  );
  assert.strictEqual(raised.length, 1, "a stuck draft offer must raise");
  const msg = String(raised[0].message);
  assert.match(msg, /still reads draft immediately/);
  assert.doesNotMatch(
    msg,
    /still reads paused/,
    "a draft offer must never be described as paused",
  );
  assert.match(
    msg,
    /never went live/,
    "draft is worth explaining — it is not something this end can retry",
  );
});
