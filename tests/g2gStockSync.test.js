// The G2G stock sync (utils/g2gFulfiller syncStock / realStockFor): the number
// an offer advertises must be what a delivery could really hand over, and it
// must actually reach G2G.
//
// For a month neither was true and nothing said so. The quantity write used a
// field G2G does not take on an update (see tests/g2g.test.js), every caller
// swallowed the refusal, and the loop dropped the pass's result. Behind that
// sat a second fault the first one hid: a row that sells pre-reserved units was
// counted as deep as the whole archive — 569 on an offer with one account.
//
// No Mongo and no network: everything the fulfiller loads is replaced, and the
// stubs stay in place while it runs (several requires happen at call time).
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

function spy(impl = async () => undefined) {
  const fn = (...args) => {
    fn.calls.push(args);
    return impl(...args);
  };
  fn.calls = [];
  return fn;
}

async function withStubbed(target, stubs, fn) {
  const targetFile = require.resolve(target);
  const map = new Map(Object.entries(stubs).map(([k, v]) => [require.resolve(k), v]));
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    let file;
    try {
      file = Module._resolveFilename(request, parent, isMain);
    } catch {
      return origLoad.apply(this, arguments);
    }
    return map.has(file) ? map.get(file) : origLoad.apply(this, arguments);
  };
  delete require.cache[targetFile];
  try {
    return await fn(require(target));
  } finally {
    Module._load = origLoad;
    delete require.cache[targetFile];
  }
}

let seq = 0;
function row(fields) {
  const d = {
    _id: "row" + ++seq,
    marketplace: "g2g",
    status: "active",
    origin: "auto",
    units: [],
    autoPaused: false,
    ...fields,
    saves: 0,
    async save() {
      d.saves++;
      return d;
    },
  };
  return d;
}
const unit = (login, sold = false) => ({ login, orderId: sold ? "order-" + login : "", deliveredAt: sold ? new Date() : null });

// `archive` maps a set id to the accounts that still hold it; `listed` are
// logins on a live listing somewhere, which a claim would skip.
function env({ rows = [], archive = {}, listed = [], af = {}, failSet = () => false } = {}) {
  const calls = [];
  const mp = {
    g2gSetQuantity: spy(async (id, n) => {
      if (failSet(id, n)) throw new Error('G2G update offer failed (HTTP 400): Missing mandatory parameter: no attributes to be updated');
      calls.push("set " + id + " " + n);
    }),
    g2gDelist: spy(async (id) => calls.push("delist " + id)),
    g2gRelist: spy(async (id) => calls.push("relist " + id)),
  };
  const chain = () => {
    const p = Promise.resolve(rows);
    p.limit = () => p;
    p.lean = () => p;
    return p;
  };
  const archiveReads = [];
  const stubs = {
    "../models/MarketplaceListing": {
      find: () => chain(),
      findOne: async (q) => rows.find((r) => String(r._id) === String(q._id) && r.status === "active") || null,
    },
    "../models/BotAccount": { findById: () => ({ lean: async () => null }) },
    "../models/DropSet": { findById: (id) => ({ lean: async () => ({ _id: id, name: "set " + id }) }) },
    "../routes/shopRoutes": {
      availableAccountsForSet: async (set) => {
        archiveReads.push(String(set._id));
        return (archive[String(set._id)] || []).map((login) => ({ login }));
      },
    },
    "../utils/listedLogins": {
      loginsOnActiveListings: async () => new Set(listed),
      notListed: (accounts, set) => accounts.filter((a) => !set.has(a.login)),
    },
    "../utils/secretBox": { decrypt: (v) => String(v || "") },
    "../utils/settings": {
      getAutoFarm: () => ({ g2gAuto: true, g2gAutoDeliver: true, g2gDeliverDryRun: false, ...af }),
      getAccountListingSettings: () => ({ enabled: true, autoDeliver: true }),
    },
    "../utils/marketplaces": mp,
    "../utils/g2gChat": { canSend: () => false, sendToBuyer: async () => ({}) },
    "../utils/g2gFarmService": { deliverFarmOrder: async () => null },
    "../utils/eldoradoFulfiller": {
      claimAccountsForSet: async () => [],
      claimUnclaimedForGame: async () => [],
      releaseAccounts: async () => 0,
      eldoradoDeliveryCode: () => "",
    },
    "../utils/telegram": { sendTelegram: async () => {} },
  };
  return { stubs, mp, calls, archiveReads };
}
const run = (e, fn) => withStubbed("../utils/g2gFulfiller", e.stubs, fn);
const taken = (e) => e.calls.splice(0);

/* --------------------- what an offer can really hand over ---------------- */

test("a row that sells reserved units is as deep as its free units, not as the archive", async () => {
  // The auto-lister's G2G share: it carries the set it was cut from, but a
  // delivery takes its own units and nothing else (pickStock's last branch).
  const share = row({ set: "S1", autoClaimSet: false, units: [unit("a"), unit("b", true), unit("c")] });
  const e = env({ archive: { S1: Array.from({ length: 569 }, (_, i) => "acc" + i) } });
  const n = await run(e, (g) => g.realStockFor(share, new Set()));
  assert.equal(n, 2);
  assert.deepEqual(e.archiveReads, [], "the archive is not even read for it");
});

test("a row that claims its set at the sale is as deep as the archive, less what is listed elsewhere", async () => {
  const bundle = row({ set: "S1", autoClaimSet: true, units: [unit("old", true)] });
  const e = env({ archive: { S1: ["a", "b", "c", "d"] } });
  const n = await run(e, (g) => g.realStockFor(bundle, new Set(["b"])));
  assert.equal(n, 3);
  assert.deepEqual(e.archiveReads, ["S1"]);
});

test("reserved units all sold is zero; a row with no stock source at all is 'cannot tell'", async () => {
  const e = env();
  await run(e, async (g) => {
    assert.equal(await g.realStockFor(row({ set: "S1", units: [unit("a", true), unit("b", true)] }), new Set()), 0);
    // Never a guess: null leaves the offer exactly as it is.
    assert.equal(await g.realStockFor(row({ set: "S1" }), new Set()), null);
    assert.equal(await g.realStockFor(row({}), new Set()), null);
    assert.equal(await g.realStockFor(null, new Set()), null);
  });
});

/* ------------------------------ the passes ------------------------------- */

test("the first pass writes every quantity; after that only a number that moved is written", async () => {
  const share = row({ externalId: "G-SHARE", set: "S1", units: [unit("a"), unit("b"), unit("c")] });
  const bundle = row({ externalId: "G-BUNDLE", set: "S2", autoClaimSet: true });
  const archive = { S2: ["x", "y", "z", "w"] };
  const e = env({ rows: [share, bundle], archive });
  await run(e, async (g) => {
    let out = await g.syncStock();
    assert.deepEqual(taken(e), ["set G-SHARE 3", "set G-BUNDLE 4"]);
    assert.deepEqual(out.changes, [{ offer: "G-SHARE", set: 3 }, { offer: "G-BUNDLE", set: 4 }]);

    out = await g.syncStock();
    assert.deepEqual(taken(e), [], "nothing moved, nothing written");
    assert.deepEqual(out.changes, [{ offer: "G-SHARE", unchanged: 3 }, { offer: "G-BUNDLE", unchanged: 4 }]);

    share.units[0] = unit("a", true); // one sold
    archive.S2.pop(); // one left the archive
    archive.S2.pop();
    await g.syncStock();
    assert.deepEqual(taken(e), ["set G-SHARE 2", "set G-BUNDLE 2"]);
  });
});

test("a quantity G2G refused is not taken as written: the next pass sends it again", async () => {
  const share = row({ externalId: "G1", set: "S1", units: [unit("a"), unit("b")] });
  let refuse = true;
  const e = env({ rows: [share], failSet: () => refuse });
  await run(e, async (g) => {
    const out = await g.syncStock();
    assert.match(out.changes[0].error, /no attributes to be updated/);
    assert.deepEqual(taken(e), []);
    refuse = false;
    await g.syncStock();
    assert.deepEqual(taken(e), ["set G1 2"]);
    await g.syncStock();
    assert.deepEqual(taken(e), []);
  });
});

test("an empty offer is taken off sale, and comes back with its quantity when the stock does", async () => {
  const share = row({ externalId: "G1", set: "S1", units: [unit("a")] });
  const e = env({ rows: [share] });
  await run(e, async (g) => {
    await g.syncStock();
    assert.deepEqual(taken(e), ["set G1 1"]);

    share.units[0] = unit("a", true);
    let out = await g.syncStock();
    assert.deepEqual(taken(e), ["delist G1"]);
    assert.deepEqual(out.changes, [{ offer: "G1", delisted: true }]);
    assert.equal(share.autoPaused, true);

    // still empty: delisted again, as before, but not counted as news
    out = await g.syncStock();
    assert.deepEqual(out.changes, [{ offer: "G1", delisted: true, again: true }]);
    taken(e);

    // one account is back. The quantity is written even though "1" was the
    // last number this process put there — G2G counted it down to zero since.
    share.units.push(unit("b"));
    out = await g.syncStock();
    assert.deepEqual(taken(e), ["set G1 1", "relist G1"]);
    assert.deepEqual(out.changes, [{ offer: "G1", set: 1, relisted: true }]);
    assert.equal(share.autoPaused, false);
  });
});

test("an offer this pass took off sale itself is brought back; a refused quantity leaves it off", async () => {
  // The relist sits behind the quantity write. While that write was refused,
  // an offer that sold out never came back however much stock returned.
  const paused = row({ externalId: "G1", set: "S1", autoPaused: true, units: [unit("a"), unit("b")] });
  let refuse = true;
  const e = env({ rows: [paused], failSet: () => refuse });
  await run(e, async (g) => {
    await g.syncStock();
    assert.deepEqual(taken(e), []);
    assert.equal(paused.autoPaused, true);
    refuse = false;
    await g.syncStock();
    assert.deepEqual(taken(e), ["set G1 2", "relist G1"]);
    assert.equal(paused.autoPaused, false);
  });
});

test("an offer somebody else paused is brought back even when its number has not moved", async () => {
  // The auto-lister's copy sweep (or the owner) can mark a row autoPaused
  // without this pass having delisted it. The stock is what it was, so the
  // number is "already written" — and the relist must still happen, with it.
  const share = row({ externalId: "G1", set: "S1", units: [unit("a"), unit("b")] });
  const e = env({ rows: [share] });
  await run(e, async (g) => {
    await g.syncStock();
    assert.deepEqual(taken(e), ["set G1 2"]);
    share.autoPaused = true;
    const out = await g.syncStock();
    assert.deepEqual(taken(e), ["set G1 2", "relist G1"]);
    assert.deepEqual(out.changes, [{ offer: "G1", set: 2, relisted: true }]);
    assert.equal(share.autoPaused, false);
  });
});

test("every 24th pass writes all the numbers again, in case G2G's own counter drifted", async () => {
  const share = row({ externalId: "G1", set: "S1", units: [unit("a"), unit("b")] });
  const e = env({ rows: [share] });
  await run(e, async (g) => {
    const wrote = [];
    for (let pass = 1; pass <= 49; pass++) {
      await g.syncStock();
      if (taken(e).length) wrote.push(pass);
    }
    assert.deepEqual(wrote, [1, 25, 49]);
  });
});

test("a row delisted by somebody else since the pass began is not written", async () => {
  const share = row({ externalId: "G1", set: "S1", units: [unit("a")] });
  const e = env({ rows: [share] });
  await run(e, async (g) => {
    share.status = "delisted"; // the owner's delist landed after the read
    const out = await g.syncStock();
    assert.deepEqual(taken(e), []);
    assert.deepEqual(out.changes, [{ offer: "G1", skipped: "no longer active" }]);
  });
});

test("in dry-run mode a pass writes nothing and remembers nothing", async () => {
  const share = row({ externalId: "G1", set: "S1", units: [unit("a"), unit("b")] });
  let dry = true;
  const e = env({ rows: [share] });
  e.stubs["../utils/settings"].getAutoFarm = () => ({ g2gAuto: true, g2gAutoDeliver: true, g2gDeliverDryRun: dry });
  await run(e, async (g) => {
    const out = await g.syncStock();
    assert.deepEqual(out.changes, [{ offer: "G1", wouldSet: 2 }]);
    assert.deepEqual(taken(e), []);
    dry = false;
    await g.syncStock();
    assert.deepEqual(taken(e), ["set G1 2"], "the first real pass still writes");
  });
});

/* ----------------------------- saying what happened ---------------------- */

function captured(fn) {
  const out = { log: [], error: [] };
  const orig = { log: console.log, error: console.error };
  console.log = (...a) => out.log.push(a.join(" "));
  console.error = (...a) => out.error.push(a.join(" "));
  try {
    out.result = fn();
  } finally {
    console.log = orig.log;
    console.error = orig.error;
  }
  return out;
}

test("a pass that could not update an offer says so, with the offer and G2G's words", async () => {
  const e = env();
  await run(e, async (g) => {
    const c = captured(() =>
      g.reportStockSync({
        checked: 4,
        changes: [
          { offer: "G1", error: "G2G update offer failed (HTTP 400): no attributes to be updated" },
          { offer: "G2", error: "G2G update offer failed (HTTP 400): no attributes to be updated" },
          { offer: "G3", unchanged: 5 },
          { offer: "G4", set: 2 },
        ],
      }),
    );
    assert.deepEqual(c.result, { set: 1, relisted: 0, delisted: 0, failed: 2 });
    assert.deepEqual(c.error, ["g2g stock sync: 2 of 4 offer(s) could not be updated — G1: G2G update offer failed (HTTP 400): no attributes to be updated (+1 more)"]);
    assert.deepEqual(c.log, ["g2g stock sync: 1 quantity write(s), 0 relisted, 0 delisted, of 4 offer(s)"]);
  });
});

test("a pass that changed nothing says nothing; an offer delisted again is not news", async () => {
  const e = env();
  await run(e, async (g) => {
    const quiet = captured(() => g.reportStockSync({ checked: 3, changes: [{ offer: "G1", unchanged: 5 }, { offer: "G2", delisted: true, again: true }, { offer: "G3", skipped: "no longer active" }] }));
    assert.deepEqual([quiet.log, quiet.error], [[], []]);
    const news = captured(() => g.reportStockSync({ checked: 2, changes: [{ offer: "G1", delisted: true }, { offer: "G2", set: 3, relisted: true }] }));
    assert.deepEqual(news.log, ["g2g stock sync: 1 quantity write(s), 1 relisted, 1 delisted, of 2 offer(s)"]);
    assert.deepEqual(captured(() => g.reportStockSync({ skipped: "g2g is off" })).result, { set: 0, relisted: 0, delisted: 0, failed: 0 });
    assert.deepEqual(captured(() => g.reportStockSync(undefined)).result, { set: 0, relisted: 0, delisted: 0, failed: 0 });
  });
});
