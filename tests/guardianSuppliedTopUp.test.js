// The guardian's GGSel / Plati top-up on an ACCOUNT-LISTING row
// (docs/ACCOUNT-LISTINGS-FIXES-3.md S2 and S6).
//
// S2 THE MONEY ONE. claimSupplied claimed the owner's pasted accounts, rendered
//    each through the offer's deliveryTemplate and fed the result straight to
//    the platform's vault without ever looking at it. A template made of
//    placeholders the pasted accounts do not carry ("{token}" against a
//    login:password paste) renders empty, and both vault APIs .filter(Boolean)
//    the list they are handed — so the accounts were claimed and markFed while
//    the platform received fewer units, or none. On GGSel an all-empty add is
//    worse than a no-op: `autoselling` goes false, so the offer stays live as a
//    MANUAL one while our row still says autoDeliver:true.
//
// S6 SWITCHING DELIVERY OFF ERASED A STANDING WARNING. The deliveryEnabled gate
//    returned without seeding seenKeys, so autoResolveStale closed an already
//    open restock-failed finding as "condition no longer detected" — while the
//    shelf was just as empty and the offer just as short.
//
// feedListing/runOnce are exercised through the real module with the
// marketplace, ledger and model layers stubbed, so the branch wiring itself is
// what is under test.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

// ---------------------------------------------------------------- harness --

const SUPPLIED_ROW = {
  _id: "listing-supplied-1",
  marketplace: "ggsel",
  externalId: "900001",
  qtyTarget: 4,
  lastStock: 2, // equal to the stock read below, so no sale is inferred
  set: null,
  accountOffer: "offer-1",
  status: "active",
  autoDeliver: true,
};

const ARCHIVE_ROW = {
  _id: "listing-archive-1",
  marketplace: "ggsel",
  externalId: "900002",
  qtyTarget: 4,
  lastStock: 2,
  set: "set-1",
  status: "active",
  autoDeliver: true,
};

// Two pasted accounts, the second with no password — the shape that renders
// empty against a template built out of {password}.
function shelf() {
  return [
    { ledgerId: "led-1", login: "acct1", password: "pw1" },
    { ledgerId: "led-2", login: "acct2", password: "" },
  ];
}

function loadGuardian(opts = {}) {
  const world = {
    added: [],
    released: [],
    fed: [],
    claims: 0,
    renders: 0,
    upserts: [],
    resolves: [],
    created: [],
    offer: { _id: "offer-1", title: "Pasted accounts", deliveryTemplate: "" },
    deliveryEnabled: opts.deliveryEnabled !== false,
    shelf: opts.shelf || shelf(),
  };

  const fakeMp = {
    async ggselOfferStockDetailed() {
      return { stock: 2, reason: "" };
    },
    async digisellerProductStockDetailed() {
      return { stock: 2, reason: "" };
    },
    async ggselEnableAutoselling() {},
    async ggselAddProducts(externalId, codes) {
      world.added.push({ externalId, codes });
    },
    async ggselFinalizeStock() {
      return { stock: 4, reactivated: true, pending: false };
    },
    async ggselOfferStock() {
      return 2;
    },
  };

  // The shelf. Only the calls the top-up makes are implemented; anything else
  // the guardian reaches for on this path would be a surprise worth failing on.
  const fakeSupplied = {
    async offerFor() {
      return world.offer;
    },
    deliveryEnabled() {
      return world.deliveryEnabled;
    },
    async claimForListing(row, want) {
      world.claims++;
      return world.shelf.slice(0, want);
    },
    deliveryText(account) {
      world.renders++;
      // An all-{password} template: empty for an account that carries none.
      return account.password ? "Password: " + account.password : "";
    },
    async releaseClaim(ids) {
      world.released.push(...ids);
      return ids.length;
    },
    async markFed(ids, o) {
      world.fed.push({ ids, opts: o });
      return ids.length;
    },
  };

  const fakeFinding = {
    async findOneAndUpdate(query, update) {
      world.upserts.push({
        dedupeKey: query.dedupeKey,
        severity: update.$set && update.$set.severity,
        message: update.$set && update.$set.message,
      });
      return { lastErrorObject: { upserted: true }, value: null };
    },
    async updateMany(query, update) {
      world.resolves.push({
        query,
        status: update.$set && update.$set.status,
        resolution: update.$set && update.$set.resolution,
      });
      return { modifiedCount: 1 };
    },
    async updateOne() {
      return { modifiedCount: 1 };
    },
    async create(doc) {
      world.created.push(doc);
      return doc;
    },
    async countDocuments() {
      return 0;
    },
  };

  const row = opts.row || SUPPLIED_ROW;
  const fakeListing = {
    findOne() {
      return { lean: async () => row };
    },
    async updateOne() {
      return { modifiedCount: 1 };
    },
    find() {
      const r = { lean: async () => [row] };
      r.limit = () => r;
      return r;
    },
  };

  // runChecks skips offer-backed rows, but its orphaned-reservation sweep runs
  // unconditionally — stubbed so a pass needs no live Mongo.
  const fakeDropLog = {
    async distinct() {
      return [];
    },
    find() {
      return { lean: async () => [] };
    },
  };
  const fakeDropSet = {
    findById() {
      return { lean: async () => (row.set ? { _id: row.set, items: [] } : null) };
    },
    find() {
      return { lean: async () => [] };
    },
  };
  // The archive path's claim, so the untouched-behaviour test can prove a
  // DropSet-backed feed never reaches the supplied layer.
  const fakeGg = {
    GG_CLAIM_TAG: "ggsel",
    async claimAccountsForSet(set, need) {
      return Array.from({ length: need }, (_, i) => ({
        accountId: "acc-" + (i + 1),
        login: "farmed" + (i + 1),
        code: "Login: farmed" + (i + 1),
      }));
    },
    async releaseAccounts() {},
  };

  const stubs = new Map([
    [require.resolve("../utils/marketplaces"), fakeMp],
    [require.resolve("../utils/suppliedStock"), fakeSupplied],
    [require.resolve("../utils/ggselFulfiller"), fakeGg],
    [require.resolve("../models/AuditFinding"), fakeFinding],
    [require.resolve("../models/MarketplaceListing"), fakeListing],
    [require.resolve("../models/DropLog"), fakeDropLog],
    [require.resolve("../models/DropSet"), fakeDropSet],
    [require.resolve("../utils/telegram"), { sendTelegram: async () => {} }],
    [
      require.resolve("../utils/guardianAutoHeal"),
      { healOpenFindings: async () => null },
    ],
  ]);

  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    try {
      const resolved = Module._resolveFilename(request, parent, isMain);
      if (stubs.has(resolved)) return stubs.get(resolved);
    } catch {
      /* fall through to the real loader */
    }
    return origLoad.apply(this, arguments);
  };

  const guardianPath = require.resolve("../utils/marketplaceGuardian");
  delete require.cache[guardianPath];
  const guardian = require(guardianPath);
  // The stub loader stays installed for the whole run, unlike
  // tests/reactivateLoop.test.js: the supplied layer and the auto-healer are
  // required LAZILY inside the functions under test, so restoring at require
  // time would hand them the real modules and a live Mongo call.
  const restore = () => {
    Module._load = origLoad;
    delete require.cache[guardianPath];
  };
  return { guardian, world, restore };
}

// --------------------------------------------------------------- S2 (money) --

test("an empty delivery render feeds nothing and puts the accounts back", async () => {
  const { guardian, world, restore } = loadGuardian();
  try {
    const fed = await guardian.feedOne(SUPPLIED_ROW._id);
    assert.strictEqual(fed, 0, "nothing was fed");
  } finally {
    restore();
  }

  assert.strictEqual(
    world.added.length,
    0,
    "GGSel must never be handed a list the vault would silently drop — an " +
      "all-empty add also flips autoselling off",
  );
  assert.deepStrictEqual(
    world.released,
    ["led-1", "led-2"],
    "every claimed account goes back on the shelf, not just the empty one",
  );
  assert.strictEqual(world.fed.length, 0, "nothing may be marked fed");

  const raised = world.upserts.filter((u) =>
    String(u.dedupeKey).startsWith("restock-empty:render:"),
  );
  assert.strictEqual(raised.length, 1, "the refusal must be reported");
  assert.strictEqual(raised[0].severity, "high");
  assert.match(String(raised[0].message), /rendered empty for 1 of 2/);
  // The key stays under the "restock-empty:" prefix so autoResolveStale can
  // close it once the owner fixes the template — nothing else ever would.
  assert.ok(/^restock-empty:/.test(raised[0].dedupeKey));
});

test("a template that renders for every account still feeds", async () => {
  const { guardian, world, restore } = loadGuardian({
    shelf: [
      { ledgerId: "led-1", login: "acct1", password: "pw1" },
      { ledgerId: "led-2", login: "acct2", password: "pw2" },
    ],
  });
  try {
    const fed = await guardian.feedOne(SUPPLIED_ROW._id);
    assert.strictEqual(fed, 2, "both accounts fed");
  } finally {
    restore();
  }

  assert.deepStrictEqual(world.added[0].codes, [
    "Password: pw1",
    "Password: pw2",
  ]);
  assert.deepStrictEqual(world.fed[0].ids, ["led-1", "led-2"]);
  assert.strictEqual(world.released.length, 0);
  // Rendered once and fed, never rendered a second time: a value that is
  // checked and a value that is sent must be the same value.
  assert.strictEqual(world.renders, 2);
});

test("a DropSet-backed row never reaches the supplied guard", async () => {
  const { guardian, world, restore } = loadGuardian({ row: ARCHIVE_ROW });
  try {
    const fed = await guardian.feedOne(ARCHIVE_ROW._id);
    assert.strictEqual(fed, 2, "the archive feed is unchanged");
  } finally {
    restore();
  }
  assert.strictEqual(world.claims, 0, "no supplied claim");
  assert.strictEqual(world.renders, 0, "no supplied render");
  assert.deepStrictEqual(world.added[0].codes, [
    "Login: farmed1",
    "Login: farmed2",
  ]);
});

// ----------------------------------------------------------------- S6 -------

test("pausing delivery does not auto-resolve the standing restock warning", async () => {
  const { guardian, world, restore } = loadGuardian({ deliveryEnabled: false });
  try {
    await guardian.runOnce();
  } finally {
    restore();
  }

  assert.strictEqual(world.claims, 0, "the kill switch still stops the claim");
  const sweep = world.resolves.find(
    (r) => r.query.dedupeKey && Array.isArray(r.query.dedupeKey.$nin),
  );
  assert.ok(sweep, "autoResolveStale ran");
  const seen = sweep.query.dedupeKey.$nin;
  assert.ok(
    seen.includes("restock-empty:" + SUPPLIED_ROW._id),
    "an empty shelf is still an empty shelf while delivery is paused",
  );
  assert.ok(
    seen.includes("restock-empty:render:" + SUPPLIED_ROW._id),
    "a broken delivery template is still broken while delivery is paused",
  );
  assert.strictEqual(
    world.resolves.filter((r) => r.resolution === "auto-resolved").length,
    0,
  );
});
