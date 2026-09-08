// The standing check that a no-claim listing still advertises things a buyer
// can actually claim.
//
// The case it is built from: the Overwatch CAH bundle was published across two
// event waves, Week 1 expired, and every backing account silently lost Week 1's
// items — including one of the two Esports Loot Boxes the listing promised. The
// listing text never changed, so it kept selling a bundle that no longer existed.
const test = require("node:test");
const assert = require("node:assert");

const audit = require("../utils/unclaimedListingAudit");

// What a live read of the sellable Overwatch accounts actually returned
// (2026-09-08): eleven accounts holding the six Finals items, four holding
// nothing claimable at all.
const FINALS = [
  "Pachimonarch Spray",
  "Battle Pass Tier Skip",
  "Purple Reign Name Card",
  "Sugar Hop Spray",
  "Boba Buddy Icon",
  "Esports Loot Box",
];
const stockOf = (n, names) =>
  Array.from({ length: n }, (_, i) => ({
    row: { login: "acct" + i },
    items: names.map((name) => ({ name })),
    unreadable: false,
  }));

const LIVE = [
  ...stockOf(11, FINALS),
  ...stockOf(4, []),
];

// What the listing said it was selling: both waves, two loot boxes.
const ADVERTISED = {
  source: "requiredDrops",
  items: [
    { name: "Pachimonarch Icon" },
    { name: "Battle Pass Tier Skip", qty: 2 },
    { name: "Crown Jewels Spray" },
    { name: "Esports Loot Box", qty: 2 },
    { name: "Pachimonarch Spray" },
    { name: "Purple Reign Name Card" },
    { name: "Sugar Hop Spray" },
    { name: "Boba Buddy Icon" },
  ],
};

test("a listing whose wave expired reads STALE, not merely out of stock", () => {
  // The distinction is the whole point: "empty" means farm more, "stale" means
  // the listing is wrong and stock is sitting right there unsold.
  const r = audit.judge({ qtyTarget: 0 }, ADVERTISED, LIVE);
  assert.strictEqual(r.verdict, "stale");
  assert.strictEqual(r.covering, 0);
  assert.strictEqual(r.stock, 11);
  assert.match(r.missing, /esports loot box/);
});

test("the suggestion is the set the stock really holds", () => {
  const r = audit.judge({ qtyTarget: 0 }, ADVERTISED, LIVE);
  assert.strictEqual(r.suggest.count, 11);
  assert.deepStrictEqual(r.suggest.items.slice().sort(), FINALS.slice().sort());
});

test("a listing matching its stock reads OK", () => {
  const honest = { source: "requiredDrops", items: FINALS.map((name) => ({ name })) };
  const r = audit.judge({ qtyTarget: 0 }, honest, LIVE);
  assert.strictEqual(r.verdict, "ok");
  assert.strictEqual(r.covering, 11);
});

test("fewer covering accounts than the quantity on sale reads SHORT", () => {
  const honest = { source: "requiredDrops", items: FINALS.map((name) => ({ name })) };
  const r = audit.judge({ qtyTarget: 50 }, honest, LIVE);
  assert.strictEqual(r.verdict, "short");
  assert.strictEqual(r.covering, 11);
});

test("no claimable stock at all reads EMPTY, which is a different fix", () => {
  const honest = { source: "requiredDrops", items: FINALS.map((name) => ({ name })) };
  const r = audit.judge({ qtyTarget: 0 }, honest, stockOf(5, []));
  assert.strictEqual(r.verdict, "empty");
});

test("a listing that declares nothing is UNKNOWN, never silently OK", () => {
  // Undeclared must not read as passing: nothing was checked.
  const r = audit.judge({ qtyTarget: 0 }, { source: "none", items: [] }, LIVE);
  assert.strictEqual(r.verdict, "unknown");
  assert.strictEqual(r.suggest.count, 11);
});

test("unreadable accounts are counted, never treated as empty", () => {
  // A Pi outage must not look like expired stock and pause a healthy listing.
  const honest = { source: "requiredDrops", items: FINALS.map((name) => ({ name })) };
  const stock = [...stockOf(3, FINALS), { row: null, items: [], unreadable: true }];
  const r = audit.judge({ qtyTarget: 0 }, honest, stock);
  assert.strictEqual(r.unreadable, 1);
  assert.strictEqual(r.covering, 3);
  assert.strictEqual(r.verdict, "ok");
});

test("dominantOffer groups by exact item signature, not by intersection", () => {
  // Two cohorts: an intersection would invent a bundle (the shared item alone)
  // that misrepresents both. The bigger cohort wins.
  const stock = [
    ...stockOf(6, ["A", "B", "C"]),
    ...stockOf(2, ["A", "D"]),
  ];
  const best = audit.dominantOffer(stock);
  assert.strictEqual(best.count, 6);
  assert.deepStrictEqual(best.items, ["A", "B", "C"]);
});

test("with equal stock the larger bundle wins", () => {
  const stock = [...stockOf(3, ["A", "B", "C"]), ...stockOf(3, ["A"])];
  assert.strictEqual(audit.dominantOffer(stock).items.length, 3);
});

test("repeated items become a count, so two loot boxes stay two", () => {
  const items = audit.itemsToRequired([
    "Esports Loot Box",
    "Esports Loot Box",
    "Boba Buddy Icon",
  ]);
  const lb = items.find((i) => i.name === "Esports Loot Box");
  assert.strictEqual(lb.qty, 2);
  assert.strictEqual(items.length, 2);
});

test("the game filter matches the ledger's spellings of one game", () => {
  const f = audit.gameFilter("Overwatch 2");
  assert.ok(f.test("Overwatch"));
  assert.ok(f.test("overwatch"));
  assert.ok(!f.test("Rainbow Six Siege"));
});

// --- the other 87: DropSet-backed listings --------------------------------
// The archive and the no-claim ledger disagree about what "still sellable"
// means, and using the ledger's rule on an archive account would condemn every
// healthy listing in the shop.

test("a listing is routed to the pool it actually sells from", () => {
  const set = { items: [{ name: "A", itemKey: "a|g" }] };
  // A rent-farm listing sells a window, not an account — no item contract.
  assert.strictEqual(
    audit.classify({ title: "Overwatch Twitch Drops Automatic Farming" }, set),
    "service",
  );
  assert.strictEqual(
    audit.classify({ title: "x", unclaimedGame: "Overwatch" }, set),
    "ledger-game",
  );
  // Published by the unclaimed auto-lister: carries a set, but its stock is the
  // no-claim ledger, not the archive.
  assert.strictEqual(
    audit.classify({ title: "x", origin: "unclaimed" }, set),
    "ledger-set",
  );
  assert.strictEqual(audit.classify({ title: "x", origin: "auto" }, set), "archive");
  // No set with items = no contract to check, which must not read as passing.
  assert.strictEqual(audit.classify({ title: "x" }, null), "unauditable");
  assert.strictEqual(audit.classify({ title: "x" }, { items: [] }), "unauditable");
});

test("lowercase 'automatic farming' is still a rent-farm listing", () => {
  // The live Gameflip row is titled "... Twitch Drops Automatic farming 120 days".
  assert.strictEqual(
    audit.classify(
      { title: "Tom Clancy's Rainbow Six Siege X Twitch Drops Automatic farming 120 days" },
      { items: [{ name: "A" }] },
    ),
    "service",
  );
});

test("a no-claim game is recognised from the set, not just the title", () => {
  assert.ok(
    audit.touchesNoClaimGame({ title: "Bundle" }, { items: [{ game: "Overwatch" }] }),
  );
  assert.ok(audit.touchesNoClaimGame({ title: "Bundle" }, { coverGame: "Rainbow Six Siege" }));
  // Falls back to the title for a row whose set is missing.
  assert.ok(audit.touchesNoClaimGame({ title: "Call of Duty Twitch Drops" }, null));
  assert.ok(!audit.touchesNoClaimGame({ title: "Rust bundle" }, { items: [{ game: "Rust" }] }));
});

test("an archive drop stays sellable while claimed but NOT connected", () => {
  // The auto-farm claims as it farms, so "claimed" is the normal state and must
  // not disqualify anything. What spends a drop is being connected to somebody's
  // game account — after that no new buyer can ever claim it.
  const { sellable, connected } = audit.sellableDropsFromArchiveInv({
    drops: [
      { name: "Esports Pack", state: "connect", connected: false, count: 1 },
      { name: "Alpha Pack", state: "claimed", connected: false, count: 1 },
      { name: "Already Linked", state: "connected", connected: true, count: 1 },
    ],
  });
  assert.deepStrictEqual(sellable.map((d) => d.name), ["Esports Pack", "Alpha Pack"]);
  assert.deepStrictEqual(connected.map((d) => d.name), ["Already Linked"]);
});

test("an archive account's copy count is expanded, so two really is two", () => {
  const { sellable } = audit.sellableDropsFromArchiveInv({
    drops: [{ name: "Esports Loot Box", connected: false, count: 2 }],
  });
  assert.strictEqual(sellable.length, 2);
  const req = require("../utils/unclaimedCoverage").requiredCounts([
    { name: "Esports Loot Box", qty: 2 },
  ]);
  const cov = require("../utils/unclaimedCoverage");
  assert.deepStrictEqual(cov.shortOf(cov.countLogNames(sellable), req), []);
});

test("a connected copy does not count toward the advertised quantity", () => {
  // One claimable + one already linked must NOT satisfy a promise of two.
  const { sellable } = audit.sellableDropsFromArchiveInv({
    drops: [
      { name: "Esports Loot Box", connected: false, count: 1 },
      { name: "Esports Loot Box", connected: true, count: 1 },
    ],
  });
  const cov = require("../utils/unclaimedCoverage");
  const missing = cov.shortOf(
    cov.countLogNames(sellable),
    cov.requiredCounts([{ name: "Esports Loot Box", qty: 2 }]),
  );
  assert.deepStrictEqual(missing, [{ name: "esports loot box", need: 2, have: 1 }]);
});

test("all-unreadable stock is NOT reported as empty", () => {
  // A dead token or a Pi outage is an absence of evidence, not evidence of
  // absence. Calling it "empty" would pause healthy listings on a hiccup — and
  // it did: three live Call of Duty listings whose 17 units were fine read as
  // empty because their unit ids resolved to nothing.
  const honest = { source: "requiredDrops", items: [{ name: "A" }] };
  const stock = [
    { row: null, items: [], unreadable: true },
    { row: null, items: [], unreadable: true },
  ];
  const r = audit.judge({ qtyTarget: 0 }, honest, stock);
  assert.strictEqual(r.verdict, "unreadable");
  assert.strictEqual(r.unreadable, 2);
});

test("a sampled read never yields a count-based SHORT verdict", () => {
  // covering is capped by the sample size, so comparing it to a larger quantity
  // on sale would mark every big listing short for no reason.
  const honest = { source: "requiredDrops", items: [{ name: "A" }] };
  const stock = stockOf(6, ["A"]);
  assert.strictEqual(audit.judge({ qtyTarget: 50 }, honest, stock).verdict, "short");
  assert.strictEqual(
    audit.judge({ qtyTarget: 50 }, honest, stock, { truncated: true }).verdict,
    "ok",
  );
  // A sample can still prove the negative, so "stale" is unaffected by it.
  const none = audit.judge({ qtyTarget: 50 }, { source: "x", items: [{ name: "Z" }] }, stock, {
    truncated: true,
  });
  assert.strictEqual(none.verdict, "stale");
});

/* ------------------------- taking the offer down -------------------------- */
// The audit judged these four Gameflip rows "stale" correctly for days and
// still nothing came down, because applyStock returned early on every
// marketplace without a QUANTITY api — and the only two that have one,
// Eldorado and PlayerAuctions, are not even in settings.UNCLAIMED_MARKETS
// (["gameflip","digiseller","ggsel"]). Pausing and re-quantifying are separate
// capabilities and must be gated separately.
const staleEntry = (marketplace, extra = {}) => ({
  listing: { _id: "x", externalId: "ext-1", marketplace, unclaimedGame: "Overwatch", ...extra },
  covering: 0,
  verdict: "stale",
});

test("a stale listing is paused on every marketplace that can be delisted", async () => {
  for (const m of ["gameflip", "digiseller", "ggsel", "zeusx", "g2g", "eldorado", "playerauctions"]) {
    const actions = await audit.applyStock(staleEntry(m), { dryRun: true });
    assert.ok(
      actions.some((a) => typeof a === "string" && a.startsWith("pause (stale")),
      m + " did not plan a pause: " + JSON.stringify(actions),
    );
  }
});

test("a marketplace with no delist api asks for the operator instead of going quiet", async () => {
  // epicnpc has no offer api at all. The old code returned "no stock API for
  // epicnpc" for EVERY market and that read as "nothing to do" — which is how
  // an unsellable listing stays on sale. It has to be loud.
  const actions = await audit.applyStock(staleEntry("epicnpc"), { dryRun: true });
  assert.match(JSON.stringify(actions), /MANUAL/);
  assert.match(JSON.stringify(actions), /ext-1/);
});

test("FunPay can only be delisted when the category node was captured", async () => {
  // funpayDelist re-saves the offer's editor form, so without externalNode
  // there is nothing to post back to.
  assert.match(
    JSON.stringify(await audit.applyStock(staleEntry("funpay"), { dryRun: true })),
    /MANUAL/,
  );
  assert.ok(
    (await audit.applyStock(staleEntry("funpay", { externalNode: "1234" }), { dryRun: true }))
      .some((a) => typeof a === "string" && a.startsWith("pause (stale")),
  );
});

test("an 'empty' verdict comes down too, but a healthy one is left alone", async () => {
  const empty = { ...staleEntry("gameflip"), verdict: "empty" };
  assert.ok(
    (await audit.applyStock(empty, { dryRun: true }))
      .some((a) => typeof a === "string" && a.startsWith("pause (empty")),
  );
  // covering > 0 must never reach the pause branch, whatever the verdict says.
  const stocked = { ...staleEntry("gameflip"), covering: 3, verdict: "short" };
  const actions = await audit.applyStock(stocked, { dryRun: true });
  assert.match(JSON.stringify(actions), /no quantity API for gameflip/);
});

/* ------------- pausing must also let go of the accounts ------------------- */
// Six stale rows were paused on 2026-09-08 at 17:52 and all six were live again
// by 17:58 — same sets, same prices, new listing ids. repairGameflipChains
// republishes any set whose ledger rows still say "listed" but which has no
// active row, straight from the SET and with no coverage check. So a pause that
// leaves the ledger alone is not a fix; it is a five-minute pause.
test("REGRESSION: pausing a stale listing releases its ledger accounts", async () => {
  const Module = require("node:module");
  const realLoad = Module._load;
  const calls = { listing: [], ledger: [], paused: [] };
  Module._load = function (request, parent, isMain) {
    const fromAudit = parent && /unclaimedListingAudit\.js$/.test(parent.filename || "");
    if (fromAudit && request === "../models/UnclaimedAccount") {
      return { updateMany: async (q, u) => { calls.ledger.push({ q, u }); return { modifiedCount: 2 }; } };
    }
    if (fromAudit && request === "../models/MarketplaceListing") {
      return { updateOne: async (q, u) => { calls.listing.push({ q, u }); return { modifiedCount: 1 }; },
               countDocuments: async () => 1 };
    }
    if (fromAudit && request === "./marketplaces") {
      return { gameflipDelist: async (id) => { calls.paused.push(id); } };
    }
    return realLoad.call(this, request, parent, isMain);
  };
  // applyStock does `require("./marketplaces")` INSIDE the function, so the
  // interception has to stay installed across the call, not just the load.
  let actions;
  try {
    const p = require.resolve("../utils/unclaimedListingAudit");
    delete require.cache[p];
    const fresh = require("../utils/unclaimedListingAudit");
    delete require.cache[p];
    actions = await fresh.applyStock(
      {
        listing: {
          _id: "listing-1",
          set: "set-9281abec",
          externalId: "2820d683",
          marketplace: "gameflip",
          unclaimedGame: "Overwatch",
        },
        covering: 0,
        verdict: "stale",
      },
      { dryRun: false },
    );
  } finally {
    Module._load = realLoad;
  }

  assert.deepStrictEqual(calls.paused, ["2820d683"], "the offer must actually come down");
  assert.strictEqual(calls.ledger.length, 1, "the ledger must be released");
  const { q, u } = calls.ledger[0];
  assert.strictEqual(q.set, "set-9281abec");
  assert.strictEqual(q.market, "gameflip");
  assert.strictEqual(q.status, "listed", "only rows the chain repair would act on");
  assert.strictEqual(
    u.$set.status,
    "released",
    "released, not removed: the accounts are good stock, just not for THIS set",
  );
  assert.ok(
    actions.some((a) => typeof a === "string" && /released 2 ledger account/.test(a)),
    "the release must be reported: " + JSON.stringify(actions),
  );
});

test("a healthy listing never releases anything", async () => {
  // covering > 0 must not reach the pause branch at all.
  const actions = await audit.applyStock(
    { listing: { _id: "l", set: "s", externalId: "e", marketplace: "gameflip" }, covering: 4, verdict: "ok" },
    { dryRun: true },
  );
  assert.match(JSON.stringify(actions), /no quantity API for gameflip/);
});
