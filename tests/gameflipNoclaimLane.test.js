// The no-claim lane of utils/gameflipFulfiller.js — one listing, one account,
// its login inside the listing's delivery code from the moment it is made.
//
// An auto-farm account's unclaimed drops reach Gameflip through this lane
// (utils/autofarmOffers → noclaimListings.publishNoclaim("gameflip")), and it
// had no behavioural test. What must hold when the account is in a market's
// hands before anybody has paid:
//   - exactly one account is claimed, "fed", for Gameflip, and ITS credentials
//     are what the code carries — with the steps for unclaimed drops when it is
//     an auto-farm account, and the old text, byte for byte, when it is not;
//   - a publish that fails gives the account back… unless it is an auto-farm
//     account and the listing the failed publish had built may still exist:
//     that account is sold whole wherever it is free, so it stays held until
//     Gameflip says the listing is gone;
//   - nothing is published without an account, or without its password.
//
// No Mongo, no network: the fulfiller is loaded with its collaborators stubbed.
process.env.CRED_SECRET ||= "test-secret";
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const file = (rel) => require.resolve(path.join(ROOT, rel));

function gfError(message, status) {
  const e = new Error(message);
  if (status) e.status = status;
  return e;
}

// Load the real fulfiller with marketplaces / the listing model / telegram /
// the no-claim claim layer replaced, for the length of `fn`.
async function withLane(world, fn) {
  const stubs = new Map([
    [file("utils/marketplaces.js"), world.mp],
    [file("models/MarketplaceListing.js"), world.Listing],
    [file("utils/telegram.js"), { sendTelegram: async (t) => { world.telegrams.push(t); } }],
    [file("utils/noclaimStock.js"), world.ncs],
  ]);
  const target = file("utils/gameflipFulfiller.js");
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    let resolved = "";
    try {
      resolved = Module._resolveFilename(request, parent, isMain);
    } catch {
      resolved = "";
    }
    return stubs.has(resolved) ? stubs.get(resolved) : origLoad.apply(this, arguments);
  };
  delete require.cache[target];
  const { error } = console;
  console.error = (...a) => world.errors.push(a.join(" "));
  try {
    return await fn(require(target));
  } finally {
    console.error = error;
    Module._load = origLoad;
    delete require.cache[target];
  }
}

const SET = { _id: "set-1", stockSource: "noclaim", coverGame: "Brawlhalla", items: [{ itemKey: "a|brawlhalla", name: "A", game: "Brawlhalla", qty: 1 }] };

function makeWorld(o = {}) {
  const w = {
    telegrams: [],
    errors: [],
    published: [],
    statusReads: [],
    ends: [],
    delists: [],
    released: [],
    attached: [],
    rows: [],
    claims: [],
  };
  w.mp = {
    gameflipPublish: async (args) => {
      w.published.push(args);
      if (o.publishError) throw o.publishError;
      return { externalId: "gf-" + w.published.length, url: "https://gameflip.com/item/gf-" + w.published.length };
    },
    // What Gameflip says about the listing a failed publish had built.
    gameflipListingStatus: async (id) => {
      w.statusReads.push(id);
      const next = (o.statuses || []).shift();
      if (next instanceof Error) throw next;
      if (next === undefined) throw gfError("Gameflip listing status: not found", 404);
      return next;
    },
    // Ends a listing from the status the caller just read — off sale first
    // only when it is on sale, the delete, then Gameflip's own 404 read back.
    // It returns only once the listing is gone; otherwise it throws.
    gameflipEndListing: async (id, opts) => {
      w.ends.push([id, opts && opts.status]);
      if (o.endError) throw o.endError;
      return { deleted: true };
    },
    gameflipDelist: async (id) => {
      w.delists.push(id);
    },
    delistOutcome: (m) => (/not found|http_status":\s*404/i.test(String(m || "")) ? "gone" : ""),
  };
  w.Listing = {
    create: (doc) => {
      const row = { _id: "row-" + (w.rows.length + 1), ...doc };
      w.rows.push(row);
      const p = Promise.resolve(row);
      return p;
    },
  };
  w.ncs = {
    claimForSet: async (set, want, opts) => {
      w.claims.push({ set, want, opts });
      return (o.accounts || []).slice(0, want);
    },
    rowFields: (set, market, accounts) => ({
      noclaimStock: true,
      origin: "manual",
      accountId: "",
      units: accounts.map((a) => ({ login: a.login, deliveredAt: null })),
    }),
    attachListing: async (ids, listingId) => {
      w.attached.push({ ids, listingId });
    },
    releaseClaim: async (ids, opts) => {
      w.released.push({ ids, ...opts });
      return ids.length;
    },
  };
  return w;
}

const FLEET = { ledgerId: "L1", login: "fleet_one", password: "pw-fleet", farm: "" };
const FARM = { ledgerId: "L2", login: "farm_one", password: "pw-farm", farm: "autofarm" };
const ARGS = { set: SET, title: "Brawlhalla Twitch Drops (1 Item)", description: "desc", priceUsd: 1.09, imagePath: "", qtyRemaining: 2, origin: "manual", noclaim: true };

test("a no-claim publish holds ONE account for Gameflip and puts its own login in the code", async () => {
  const w = makeWorld({ accounts: [FLEET] });
  const doc = await withLane(w, (g) => g.publishAutoDelivery(ARGS));
  assert.deepStrictEqual(w.claims.map((c) => [c.want, c.opts]), [[1, { market: "gameflip", mode: "fed" }]]);
  assert.strictEqual(w.published.length, 1);
  const code = w.published[0].autoDeliverCode;
  assert.match(code, /^TWITCH DROP ACCOUNT\n\nLogin: fleet_one\nPassword: pw-fleet\n\n/);
  // A no-claim bot's account: the text Gameflip has always been given.
  assert.match(code, /"Received" section/);
  assert.strictEqual(w.published[0].priceUsd, 1.09);
  assert.strictEqual(w.rows.length, 1);
  assert.strictEqual(doc.externalId, "gf-1");
  const row = w.rows[0];
  assert.strictEqual(row.marketplace, "gameflip");
  assert.strictEqual(row.noclaimStock, true);
  assert.strictEqual(row.autoDeliver, true);
  assert.strictEqual(row.origin, "manual", "never repriced");
  assert.strictEqual(row.accountId, "");
  assert.strictEqual(row.qtyRemaining, 2, "one live, two still owed");
  assert.deepStrictEqual(row.units.map((u) => u.login), ["fleet_one"]);
  assert.deepStrictEqual(w.attached, [{ ids: ["L1"], listingId: "row-1" }]);
  assert.deepStrictEqual(w.released, []);
});

test("an auto-farm account's code tells the buyer to connect first, then claim", async () => {
  const w = makeWorld({ accounts: [FARM] });
  await withLane(w, (g) => g.publishAutoDelivery(ARGS));
  const code = w.published[0].autoDeliverCode;
  assert.match(code, /^TWITCH DROP ACCOUNT\n\nLogin: farm_one\nPassword: pw-farm\n\n/);
  assert.match(code, /FIRST press "Connect"/);
  assert.match(code, /Claim Now/);
  assert.doesNotMatch(code, /"Received" section/);
  assert.deepStrictEqual(w.rows[0].units.map((u) => u.login), ["farm_one"]);
});

test("nothing is published without an account, or without its password", async () => {
  let w = makeWorld({ accounts: [] });
  await assert.rejects(withLane(w, (g) => g.publishAutoDelivery(ARGS)), /Out of stock — no free no-claim account holds this whole bundle/);
  assert.strictEqual(w.published.length, 0);
  assert.strictEqual(w.rows.length, 0);

  w = makeWorld({ accounts: [{ ...FARM, password: "" }] });
  await assert.rejects(withLane(w, (g) => g.publishAutoDelivery(ARGS)), /has no readable password/);
  assert.strictEqual(w.published.length, 0);
  // Nothing was sent to Gameflip: the claim layer is told so, or an auto-farm
  // claim attached to no listing row would never be handed back.
  assert.deepStrictEqual(w.released, [{ ids: ["L2"], reason: "no readable password", listingGone: true }]);
});

test("a publish that failed before any listing existed gives the account back — either kind", async () => {
  for (const acc of [FLEET, FARM]) {
    const w = makeWorld({ accounts: [acc], publishError: gfError("Gameflip create: Too many attempts - Retry later", 429) });
    await assert.rejects(withLane(w, (g) => g.publishAutoDelivery(ARGS)), /Gameflip create/);
    // An auto-farm claim is attached to no listing row yet, and such a claim
    // goes back only with the word that no listing carries its login — which
    // a publish that built none can give. A no-claim bot's claim is released
    // exactly as it always was.
    assert.deepStrictEqual(
      w.released,
      [acc.farm === "autofarm"
        ? { ids: [acc.ledgerId], reason: "gameflip publish failed", listingGone: true }
        : { ids: [acc.ledgerId], reason: "gameflip publish failed" }],
      acc.login,
    );
    assert.deepStrictEqual(w.statusReads, [], "no listing was built: nothing to look for");
    assert.strictEqual(w.rows.length, 0);
    assert.strictEqual(w.telegrams.length, 0);
  }
});

test("a no-claim bot's account is released after ANY failed publish, exactly as before", async () => {
  const w = makeWorld({
    accounts: [FLEET],
    publishError: gfError("Gameflip created 4f1b3263-aaaa-bbbb-cccc-000000000001 but could not put it on sale (draft discarded): status settled on \"ready\""),
    statuses: ["ready", "ready"],
  });
  await assert.rejects(withLane(w, (g) => g.publishAutoDelivery(ARGS)), /could not put it on sale/);
  assert.deepStrictEqual(w.released, [{ ids: ["L1"], reason: "gameflip publish failed" }]);
  assert.deepStrictEqual(w.statusReads, [], "that farm's rule is untouched: Gameflip is not even asked");
});

test("an auto-farm account goes back after a failed publish only when the listing it built is provably gone", async () => {
  const ID = "4f1b3263-aaaa-bbbb-cccc-000000000002";
  const onsale = gfError("Gameflip created " + ID + " but could not put it on sale (draft discarded): status settled on \"ready\"");
  const attach = gfError("Gameflip could not attach the delivery content (draft " + ID + " discarded): timeout of 20000ms exceeded");

  // Gameflip no longer has it (the publish's own delete worked): released.
  let w = makeWorld({ accounts: [FARM], publishError: onsale, statuses: [] });
  await assert.rejects(withLane(w, (g) => g.publishAutoDelivery(ARGS)), /could not put it on sale/);
  assert.deepStrictEqual(w.statusReads, [ID]);
  assert.deepStrictEqual(w.released, [{ ids: ["L2"], reason: "gameflip publish failed", listingGone: true }]);
  assert.strictEqual(w.telegrams.length, 0);

  // Still there as a draft: ended once more AS a draft (deleted outright — a
  // draft refuses the off-sale patch, and that used to stop the delete), and
  // the end's own 404 read-back is the proof.
  w = makeWorld({ accounts: [FARM], publishError: attach, statuses: ["draft"] });
  await assert.rejects(withLane(w, (g) => g.publishAutoDelivery(ARGS)), /could not attach/);
  assert.deepStrictEqual(w.statusReads, [ID]);
  assert.deepStrictEqual(w.ends, [[ID, "draft"]]);
  assert.deepStrictEqual(w.delists, [], "never the patch-then-delete a draft can refuse");
  assert.deepStrictEqual(w.released, [{ ids: ["L2"], reason: "gameflip publish failed", listingGone: true }]);

  // Still there after that — maybe even on sale: the account stays held, the owner is told.
  w = makeWorld({ accounts: [FARM], publishError: onsale, statuses: ["onsale", "onsale"], endError: gfError("Gameflip end listing: still exists after the delete", 409) });
  await assert.rejects(withLane(w, (g) => g.publishAutoDelivery(ARGS)), /could not put it on sale/);
  assert.deepStrictEqual(w.released, [], "its login may be in a live listing: it is not stock");
  assert.deepStrictEqual(w.ends, [[ID, "onsale"]]);
  assert.deepStrictEqual(w.statusReads, [ID, ID], "Gameflip's second answer is the verdict");
  assert.strictEqual(w.telegrams.length, 1);
  assert.match(w.telegrams[0], /could not be confirmed deleted[^]*farm_one[^]*stays held/);
  assert.ok(w.errors.some((e) => /farm_one stays HELD/.test(e)));
  assert.strictEqual(w.rows.length, 0);
  // …and the error says so, for a caller that would otherwise just try again.
  w = makeWorld({ accounts: [FARM], publishError: gfError("Gameflip created " + ID + " but could not put it on sale (draft discarded): x"), statuses: ["onsale", "onsale"], endError: gfError("429", 429) });
  await assert.rejects(withLane(w, (g) => g.publishAutoDelivery(ARGS)), /\[account kept held\]$/);

  // It SOLD (the "failed" publish went live after all, and a buyer was quick):
  // never deleted, never handed back.
  w = makeWorld({ accounts: [FARM], publishError: onsale, statuses: ["sold", "sold"], endError: gfError("Gameflip listing " + ID + " is sold — not ended") });
  await assert.rejects(withLane(w, (g) => g.publishAutoDelivery(ARGS)), /\[account kept held\]$/);
  assert.deepStrictEqual(w.released, []);

  // Gameflip will not say (its limiter): not known is not gone.
  w = makeWorld({ accounts: [FARM], publishError: onsale, statuses: [gfError("Gameflip listing status: Too many attempts", 429)] });
  await assert.rejects(withLane(w, (g) => g.publishAutoDelivery(ARGS)), /could not put it on sale/);
  assert.deepStrictEqual(w.released, []);
  assert.strictEqual(w.telegrams.length, 1);
});

test("failedPublishRemains: none / gone / there", async () => {
  const ID = "4f1b3263-aaaa-bbbb-cccc-000000000003";
  const ask = async (message, o) => {
    const w = makeWorld(o);
    const r = await withLane(w, (g) => g.failedPublishRemains(new Error(message)));
    return { r, w };
  };
  assert.strictEqual((await ask("Gameflip create: bad request", {})).r, "none");
  assert.strictEqual((await ask("Gameflip minimum price is $0.75", {})).r, "none");
  assert.strictEqual((await ask("Gameflip created " + ID + " but could not put it on sale (draft discarded): x", { statuses: [] })).r, "gone");
  // "Not found" said in WORDS is no answer about the listing (a refused key
  // says it too): gone is Gameflip's HTTP 404 and nothing else.
  for (const e of [
    new Error('Gameflip listing status: {"http_status": 404}'),
    gfError('Gameflip listing status: {"error":{"message":"Api key not found"}}', 401),
  ]) {
    assert.strictEqual((await ask("x (draft " + ID + " discarded): y", { statuses: [e] })).r, "there", e.message);
  }
  const still = await ask("x (draft " + ID + " discarded): y", { statuses: ["draft", "draft"], endError: new Error("429") });
  assert.strictEqual(still.r, "there");
  assert.deepStrictEqual(still.w.ends, [[ID, "draft"]], "one more end was tried, from the status just read");
  // The end went through: its own read-back is the proof, Gameflip is not asked again.
  const ended = await ask("x (draft " + ID + " discarded): y", { statuses: ["ready"] });
  assert.strictEqual(ended.r, "gone");
  assert.deepStrictEqual(ended.w.statusReads, [ID]);
});

test("a listing that is live but whose row could not be saved says so in the words every such failure uses", async () => {
  const w = makeWorld({ accounts: [FARM] });
  w.Listing.create = () => Promise.reject(new Error("E11000 duplicate key"));
  await assert.rejects(
    withLane(w, (g) => g.publishAutoDelivery(ARGS)),
    /^Error: published on Gameflip but the row could not be saved — delist it by hand: gf-1 \(E11000 duplicate key\)$/,
  );
  assert.deepStrictEqual(w.released, [], "Gameflip has its login: the account is not handed back");
  assert.strictEqual(w.published.length, 1);
});

test("a relist that kept an account held, or went live without a row, STOPS its chain — it is not retried with another account", async () => {
  const mk = () => {
    const w = makeWorld({});
    w.updates = [];
    w.Listing.updateOne = (q, u) => {
      w.updates.push({ q, u });
      return Promise.resolve({ modifiedCount: 1 });
    };
    w.Listing.countDocuments = () => Promise.resolve(0);
    return w;
  };
  const row = { _id: "row-9", externalId: "gf-9", title: "T", qtyRemaining: 3, relistAttempts: 0 };
  for (const message of [
    "Gameflip created 4f1b-aaaa but could not put it on sale (draft discarded): x [account kept held]",
    "published on Gameflip but the row could not be saved — delist it by hand: gf-10 (E11000)",
  ]) {
    const w = mk();
    await withLane(w, (g) => g.noteRelistFailure(row, new Error(message)));
    assert.strictEqual(w.updates.length, 1, message);
    const set = w.updates[0].u.$set;
    assert.strictEqual(set.qtyRemaining, 0, "the chain owes nothing more");
    assert.strictEqual(set.relistRetryAt, null, "and has no next try");
    assert.match(set.lastError, /^auto-relist stopped: /);
    assert.ok(!("relistAttempts" in set));
    assert.strictEqual(w.telegrams.length, 0, "the publish itself told the owner");
  }
  // Any other failure keeps the lane's own backoff.
  const w = mk();
  await withLane(w, (g) => g.noteRelistFailure(row, new Error("Gameflip create: Too many attempts - Retry later")));
  const set = w.updates[0].u.$set;
  assert.strictEqual(set.relistAttempts, 1);
  assert.ok(set.relistRetryAt instanceof Date);
  assert.match(set.lastError, /^auto-relist failed: /);
  assert.ok(!("qtyRemaining" in set));
});
