// A long account-listing delivery on Eldorado goes out as one chat message per
// unit; a short one goes out exactly as it always did.
//
// An account listing renders its offer's whole deliveryTemplate once per unit,
// and the lot used to be ONE message. Eldorado's chat (TalkJS) refused a
// 14,952-character delivery with HTTP 400 on 2026-09-15 and that order sat paid
// and undelivered for hours; on 2026-10-11 a whole shelf of the two code
// bundles on sale measured 4,638 and 7,186 characters, growing with every code.
//
// What this file holds still:
//   1. UNDER THE THRESHOLD NOTHING MOVED. Same single message, byte for byte,
//      same calls in the same order, same result object, same dry run.
//   2. OVER IT, one message per unit, in ledger order — and the ORDER is marked
//      delivered, and its sale recorded, only after the last one is in the chat.
//   3. A FAILED MESSAGE HALF WAY marks the order as nothing. The retry sends the
//      same texts (so TalkJS is handed the same idempotency keys), never a
//      renumbered one, and does not post again what the chat already accepted
//      in this process.
//   4. THE OPERATOR HEARS about an order that stays half sent — once, when it
//      has stopped getting anywhere, and not about a chat that is merely not
//      open yet.
//
// No Mongo and no network. Sections 1-3 replace the models, the marketplace
// client and the supplied stock layer before the fulfiller loads, the way
// tests/suppliedFulfilment.test.js does. The keys are read off the REAL
// eldoradoSendOrderMessage, loaded with the network, the settings file and the
// secret box replaced. The real claim layer's part in a retry is in
// tests/eldoradoLongDeliveryResume.test.js.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

/* ------------------------------- harness -------------------------------- */

function spy(impl = async () => undefined) {
  const fn = (...args) => {
    fn.calls.push(args);
    return impl(...args);
  };
  fn.calls = [];
  return fn;
}

// Load `target` with the given dependencies replaced, and keep them replaced
// for the whole of `fn`: the fulfiller requires utils/suppliedStock lazily,
// INSIDE the branch under test.
async function withStubbed(target, stubs, fn) {
  const targetFile = require.resolve(target);
  const map = new Map(
    Object.entries(stubs).map(([k, v]) => [require.resolve(k), v]),
  );
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

function fakeById(value) {
  return {
    findById() {
      const p = Promise.resolve(value);
      p.lean = () => Promise.resolve(value);
      return p;
    },
  };
}

const header = (i, n) => "=== ACCOUNT " + i + " of " + n + " ===\n\n";

// The single message exactly as the fulfiller built it before long deliveries
// existed — written out here on purpose, not imported from the code under test.
function legacyMessage(blocks) {
  const qty = blocks.length;
  return qty > 1
    ? blocks
        .map((b, i) => "=== ACCOUNT " + (i + 1) + " of " + qty + " ===\n\n" + b)
        .join("\n\n")
    : blocks[0];
}

// A shelf of `n` units whose rendered text is `chars` long each ({password} is
// the whole template unless a test says otherwise). Ledger ids ascend in shelf
// order, as ObjectIds minted one after another do — and the logins run the
// OTHER way, so anything that orders units by login shows up at once.
function shelf(n, chars = 600) {
  return Array.from({ length: n }, (_, i) => {
    const tag = "U" + String(i + 1).padStart(2, "0") + ":";
    return {
      ledgerId: "LED" + String(i + 1).padStart(2, "0"),
      login: "bundle-" + String(99 - i),
      password: tag + "x".repeat(chars - tag.length),
    };
  });
}

// The whole environment of one offer: an offer-backed Eldorado listing row, a
// shelf of units, and every call that leaves the fulfiller recorded in ONE
// timeline, so a test can assert what came before what.
//
// `claims` is what the claim layer hands back on each successive call (the last
// entry repeats). The real layer resumes an order's units by its order id;
// handing the same units back in ANOTHER order is how a test plays the
// (createdAt, _id) first claim against the (soldAt, _id) resume.
//
// `refuse(text, n)` decides which chat sends fail (n counts every send, from 1).
function makeEnv({
  units,
  template = "{password}",
  claims,
  refuse = () => false,
  stock = 5,
  af = {},
  mp: realMp = null,
}) {
  const timeline = [];
  const listing = {
    marketplace: "eldorado",
    externalId: "e-long",
    accountOffer: "OFFER1",
    status: "active",
    units: [],
    saves: 0,
    markModified() {},
    async save() {
      listing.saves++;
      timeline.push("listing.save");
      return listing;
    },
  };
  const offer = { title: "Code bundle", autoDeliver: true, deliveryTemplate: template };

  const accepted = [];
  let sendNo = 0;
  const mp = realMp || {
    eldoradoSendOrderMessage: spy(async (order, text) => {
      sendNo += 1;
      if (refuse(text, sendNo, order)) {
        timeline.push("send-FAILED");
        throw new Error(
          "Eldorado chat send failed (HTTP 400): Request failed with status code 400",
        );
      }
      accepted.push(text);
      timeline.push("send");
      return { ok: "1" };
    }),
    eldoradoMarkDelivered: spy(async () => {
      timeline.push("markDelivered");
    }),
    eldoradoSetQuantity: spy(async () => ({})),
    eldoradoDelist: spy(async () => ({})),
  };

  const calls = { claimForListing: [], markDelivered: [] };
  const sequence = claims || [units];
  const supplied = {
    calls,
    stampFails: false,
    stampHangs: false,
    async claimForListing(row, want, opts) {
      const n = calls.claimForListing.push({ want, opts });
      const batch = sequence[Math.min(n, sequence.length) - 1];
      return batch.slice(0, want);
    },
    // Called once per accepted unit of a long delivery (a stamp), and once for
    // the whole order after it is marked delivered (the burn).
    async markDelivered(ids, opts) {
      calls.markDelivered.push({ ids, opts });
      const burn = timeline.includes("markDelivered");
      if (!burn && supplied.stampFails) throw new Error("mongo: write refused");
      if (!burn && supplied.stampHangs) return new Promise(() => {});
      timeline.push(burn ? "ledger.burn(" + ids.length + ")" : "ledger.stamp:" + ids.join(","));
      return ids.length;
    },
    async stockFor() {
      return stock;
    },
    // The offer's own template, as utils/suppliedStock.deliveryText renders it.
    deliveryText(account, off) {
      const values = {
        login: account.login,
        password: account.password,
        title: (off && off.title) || "",
      };
      return String(off.deliveryTemplate).replace(
        /\{(login|password|title)\}/g,
        (_m, k) => values[k] || "",
      );
    },
  };

  const telegrams = [];
  const stubs = {
    "../models/MarketplaceListing": { findOne: async () => listing },
    "../models/BotAccount": fakeById(null),
    "../models/UnclaimedAccount": fakeById(null),
    "../models/AccountOffer": fakeById(offer),
    "../routes/shopRoutes": { availableAccountsForSet: async () => [] },
    "../utils/listedLogins": {
      loginsOnActiveListings: async () => new Set(),
      notListed: (a) => a,
    },
    "../utils/secretBox": { decrypt: (v) => String(v || "") },
    "../utils/dropReservation": {},
    "../utils/settings": {
      getAutoFarm: () => af,
      getAccountListingSettings: () => ({ enabled: true, autoDeliver: true }),
    },
    "../utils/marketplaces": mp,
    "../utils/eldoradoFarmService": { deliverFarmOrder: async () => null },
    "../utils/operatorFarm": {},
    "../utils/telegram": { sendTelegram: async (t) => telegrams.push(t) },
    "../utils/suppliedStock": supplied,
  };
  const sent = () => mp.eldoradoSendOrderMessage.calls.map((c) => c[1]);
  const stamps = () =>
    timeline.filter((x) => x.startsWith("ledger.stamp:")).map((x) => x.slice(13));
  return { stubs, mp, supplied, listing, offer, timeline, sent, accepted, stamps, telegrams, af };
}

const order = (id, qty, extra = {}) => ({
  id,
  offerId: "e-long",
  purchaseQuantity: qty,
  sellerId: "seller-1",
  talkJsConversationId: "conv-" + id,
  buyerName: "someBuyer",
  orderOfferDetails: { offerTitle: "Code bundle" },
  ...extra,
});

const run = (env, fn) => withStubbed("../utils/eldoradoFulfiller", env.stubs, fn);
const deliver = (e, o) => e.deliverOrder(o, { dryRun: false, unitGapMs: 0 });

// Silence, and collect, what the code under test prints.
async function quiet(fn) {
  const out = [];
  const real = { log: console.log, error: console.error };
  console.log = (...a) => out.push("log: " + a.join(" "));
  console.error = (...a) => out.push("error: " + a.join(" "));
  try {
    return [await fn(), out];
  } finally {
    console.log = real.log;
    console.error = real.error;
  }
}

/* ------------------- 1. under the threshold nothing moved ------------------ */

test("the default threshold is under the largest message the chat has ever taken", async () => {
  // About 2,400 characters is the largest delivery proven to arrive, and 14,952
  // was refused. A single message bigger than anything proven fails the way
  // 2026-09-15 did; a split one cannot. Raising this is a decision, not a tidy-up.
  await run(makeEnv({ units: [] }), (e) => {
    assert.strictEqual(e.ELD_LONG_DELIVERY_CHARS, 2000);
  });
});

test("a short multi-unit order is still ONE message, byte for byte", async () => {
  const units = shelf(3, 200);
  const env = makeEnv({
    units,
    template: "Login: {login}\nCodes:\n{password}\n\nRedeem them within 30 days.",
  });

  const out = await run(env, async (e) => {
    const r = await e.deliverOrder(order("eo-short", 3), { dryRun: false });
    assert.strictEqual(e.longDeliveryProgress.size, 0, "a short order leaves nothing behind");
    return r;
  });

  const blocks = units.map(
    (u) => "Login: " + u.login + "\nCodes:\n" + u.password + "\n\nRedeem them within 30 days.",
  );
  assert.deepStrictEqual(env.sent(), [legacyMessage(blocks)]);
  assert.deepStrictEqual(out, {
    orderId: "eo-short",
    delivered: 3,
    source: "offer:Code bundle",
  });
  // One send, the order marked, the ledger burned once for all three — and no
  // unit stamped on its own.
  assert.deepStrictEqual(env.timeline, [
    "send",
    "markDelivered",
    "ledger.burn(3)",
    "listing.save",
  ]);
  assert.deepStrictEqual(env.supplied.calls.markDelivered[0].ids, ["LED01", "LED02", "LED03"]);
});

test("a short dry run reports exactly what it always did", async () => {
  const units = shelf(2, 150);
  const env = makeEnv({ units });

  const out = await run(env, (e) =>
    e.deliverOrder(order("eo-dry", 2), { dryRun: true }),
  );

  const text = legacyMessage(units.map((u) => u.password));
  assert.deepStrictEqual(out, {
    orderId: "eo-dry",
    dryRun: true,
    source: "offer:Code bundle",
    wouldSend: "2 account(s) [bundle-99, bundle-98], " + text.length + " chars",
    preview: text,
  });
  assert.strictEqual(env.sent().length, 0);
});

// Two units whose single message is exactly `chars` long: two 24-character
// headers and the blank line between the blocks, the rest split over the two.
function pairOf(chars) {
  const body = chars - (header(1, 2).length + header(2, 2).length + 2);
  return [
    { ledgerId: "LED01", login: "a", password: "x".repeat(Math.floor(body / 2)) },
    { ledgerId: "LED02", login: "b", password: "y".repeat(Math.ceil(body / 2)) },
  ];
}

test("an order exactly AT the threshold is one message; one character over is split", async () => {
  const envAt = makeEnv({ units: pairOf(2000) });
  await run(envAt, (e) => deliver(e, order("eo-at", 2)));
  assert.strictEqual(envAt.sent().length, 1);
  assert.strictEqual(envAt.sent()[0].length, 2000);

  const envOver = makeEnv({ units: pairOf(2001) });
  await quiet(() => run(envOver, (e) => deliver(e, order("eo-over", 2))));
  assert.strictEqual(envOver.sent().length, 2);
});

test("a ONE-unit order is never split, however long it is", async () => {
  const units = shelf(1, 9000);
  const env = makeEnv({ units });

  const out = await run(env, (e) =>
    e.deliverOrder(order("eo-one", 1), { dryRun: false }),
  );

  // No header, no second message: the bare rendered text, as before.
  assert.deepStrictEqual(env.sent(), [units[0].password]);
  assert.strictEqual(out.delivered, 1);
  assert.deepStrictEqual(env.timeline, ["send", "markDelivered", "ledger.burn(1)", "listing.save"]);
});

test("the threshold is a setting: 0 is one message again, a number moves it", async () => {
  const units = shelf(8, 600); // 5,006 characters as one message
  const single = legacyMessage(units.map((u) => u.password));

  for (const off of [0, false, "0"]) {
    const env = makeEnv({ units, af: { eldoradoLongDeliveryChars: off } });
    await run(env, (e) => deliver(e, order("eo-off", 8)));
    assert.deepStrictEqual(env.sent(), [single], "off = " + JSON.stringify(off));
    assert.deepStrictEqual(env.timeline, [
      "send",
      "markDelivered",
      "ledger.burn(8)",
      "listing.save",
    ]);
  }

  // Raised above this order: one message. Lowered under a short order: split.
  const high = makeEnv({ units, af: { eldoradoLongDeliveryChars: 6000 } });
  await run(high, (e) => deliver(e, order("eo-high", 8)));
  assert.strictEqual(high.sent().length, 1);

  for (const low of ["500", " 500 ", 500.9]) {
    const env = makeEnv({ units: shelf(3, 200), af: { eldoradoLongDeliveryChars: low } });
    await quiet(() => run(env, (e) => deliver(e, order("eo-low", 3))));
    assert.strictEqual(env.sent().length, 3, "low = " + JSON.stringify(low));
  }
});

test("a setting nobody can read is the default: never off, never a limit of its own", async () => {
  // Off is the unsafe side, so only 0, false and "0" mean it. And a value that
  // merely converts to a small number must not start splitting every order.
  const long = shelf(8, 600); // 5,006 characters: split at the default
  const short = shelf(3, 200); // 676 characters: one message at the default
  const junk = [
    "abc", "off", "false", "no", " ", "\n", "", "00", "2e3", "1.5", "-5",
    -5, 0.5, NaN, Infinity, true, null, undefined, {}, [], [0], [3000],
  ];
  for (const value of junk) {
    const a = makeEnv({ units: long, af: { eldoradoLongDeliveryChars: value } });
    await quiet(() => run(a, (e) => deliver(e, order("eo-junk-long", 8))));
    assert.strictEqual(a.sent().length, 8, "long order, setting " + JSON.stringify(value));

    const b = makeEnv({ units: short, af: { eldoradoLongDeliveryChars: value } });
    await run(b, (e) => deliver(e, order("eo-junk-short", 3)));
    assert.strictEqual(b.sent().length, 1, "short order, setting " + JSON.stringify(value));
  }
});

test("no setting can put the limit above the chat editor's own", async () => {
  // 14,952 characters is known to be refused. A typo of 20000 for 2000 must not
  // send one message of that size.
  await run(makeEnv({ units: [] }), (e) => {
    assert.strictEqual(e.ELD_LONG_DELIVERY_MAX, 10000);
  });
  for (const huge of [20000, "20000", 1e308]) {
    const over = makeEnv({ units: pairOf(10001), af: { eldoradoLongDeliveryChars: huge } });
    await quiet(() => run(over, (e) => deliver(e, order("eo-huge-over", 2))));
    assert.strictEqual(over.sent().length, 2, "10,001 characters, setting " + huge);

    const at = makeEnv({ units: pairOf(10000), af: { eldoradoLongDeliveryChars: huge } });
    await run(at, (e) => deliver(e, order("eo-huge-at", 2)));
    assert.strictEqual(at.sent().length, 1, "10,000 characters, setting " + huge);
  }
});

test("the setting is read for every order, not once: it takes effect without a restart", async () => {
  const units = shelf(8, 600);
  const env = makeEnv({ units });

  await quiet(() =>
    run(env, async (e) => {
      await deliver(e, order("eo-live-1", 8));
      assert.strictEqual(env.sent().length, 8, "unset: split");

      env.af.eldoradoLongDeliveryChars = 0;
      env.listing.units = [];
      await deliver(e, order("eo-live-2", 8));
      assert.strictEqual(env.sent().length, 9, "switched off: the next order is one message");

      delete env.af.eldoradoLongDeliveryChars;
      env.listing.units = [];
      await deliver(e, order("eo-live-3", 8));
      assert.strictEqual(env.sent().length, 17, "and back");
    }),
  );
});

test("an order already going out per unit FINISHES per unit when the setting is switched off", async () => {
  // Message 1 is with the buyer, message 2 keeps failing, and the owner turns
  // splitting off. Sending this order as one message now would put unit 1 in
  // front of the buyer again — on the path that neither counts its failures
  // nor pages. New orders follow the setting; this one finishes the way it began.
  const units = shelf(8, 600);
  let refusing = true;
  const env = makeEnv({ units, refuse: (text) => refusing && text.startsWith(header(2, 8)) });
  const expected = units.map((u, i) => header(i + 1, 8) + u.password);

  await quiet(() =>
    run(env, async (e) => {
      const first = await deliver(e, order("eo-switch", 8));
      assert.match(first.error, /interrupted at message 2 of 8/);

      env.af.eldoradoLongDeliveryChars = 0;
      const second = await deliver(e, order("eo-switch", 8));
      assert.match(second.error, /^long delivery interrupted at message 2 of 8/, "still per unit, still counted");

      refusing = false;
      const third = await deliver(e, order("eo-switch", 8));
      assert.strictEqual(third.delivered, 8);
    }),
  );
  assert.deepStrictEqual(env.accepted, expected, "eight unit messages, each accepted once");
});

/* ---------------------- 2. over it: one message a unit --------------------- */

test("a long order goes out one message per unit, in order, and only THEN is marked delivered", async () => {
  const units = shelf(8, 600);
  const env = makeEnv({ units, stock: 4 });

  const [out, printed] = await quiet(() =>
    run(env, async (e) => {
      const r = await deliver(e, order("eo-long", 8));
      assert.strictEqual(e.longDeliveryProgress.size, 0, "a finished order is forgotten");
      return r;
    }),
  );

  const sent = env.sent();
  assert.strictEqual(sent.length, 8);
  sent.forEach((text, i) => {
    assert.strictEqual(text, header(i + 1, 8) + units[i].password, "message " + (i + 1));
  });
  // Together they are the single message, cut at the unit boundaries — the
  // buyer reads the same text either way.
  assert.strictEqual(sent.join("\n\n"), legacyMessage(units.map((u) => u.password)));

  // Each unit is stamped on its ledger row as its own message lands. The ORDER
  // is marked delivered, the ledger burned and the row saved only after all
  // eight are in the chat — that order is load-bearing.
  assert.deepStrictEqual(env.timeline, [
    ...units.flatMap((u) => ["send", "ledger.stamp:" + u.ledgerId]),
    "markDelivered",
    "ledger.burn(8)",
    "listing.save",
  ]);
  assert.deepStrictEqual(env.mp.eldoradoMarkDelivered.calls, [["eo-long"]]);
  const burn = env.supplied.calls.markDelivered[8];
  assert.deepStrictEqual(burn.ids.slice().sort(), units.map((u) => u.ledgerId));
  assert.deepStrictEqual(burn.opts, { orderId: "eo-long", market: "eldorado" });
  assert.deepStrictEqual(env.supplied.calls.markDelivered[0], {
    ids: ["LED01"],
    opts: { orderId: "eo-long", market: "eldorado" },
  });
  assert.strictEqual(env.listing.units.length, 8);
  assert.ok(env.listing.units.every((u) => u.orderId === "eo-long" && u.deliveredAt));
  assert.deepStrictEqual(out, {
    orderId: "eo-long",
    delivered: 8,
    source: "offer:Code bundle",
  });
  assert.deepStrictEqual(env.mp.eldoradoSetQuantity.calls[0], ["e-long", 4]);
  assert.ok(
    printed.some((l) => /eldorado long delivery eo-long: 5006 chars sent as 8 messages \(8 posted now\)/.test(l)),
    "the log says the order went out per unit: " + printed.join(" | "),
  );
});

test("two units with IDENTICAL text are still two messages", async () => {
  // The same code text pasted on two rows: without its place in the header the
  // second would be the first one's text, carry its key, and never arrive.
  const units = shelf(6, 700).map((u) => ({ ...u, password: "SAME".repeat(175) }));
  const env = makeEnv({ units });
  await quiet(() => run(env, (e) => deliver(e, order("eo-same", 6))));

  assert.strictEqual(env.sent().length, 6);
  assert.strictEqual(new Set(env.sent()).size, 6);
});

test("a unit that is itself over the threshold is still sent, not refused", async () => {
  const units = shelf(2, 5000);
  const env = makeEnv({ units });

  const [out] = await quiet(() => run(env, (e) => deliver(e, order("eo-big", 2))));

  assert.strictEqual(out.delivered, 2);
  assert.deepStrictEqual(
    env.sent(),
    units.map((u, i) => header(i + 1, 2) + u.password),
  );
});

test("a long dry run sends nothing, stamps nothing, and says how the order would be split", async () => {
  const units = shelf(8, 600);
  const env = makeEnv({ units });

  const out = await run(env, async (e) => {
    const r = await e.deliverOrder(order("eo-longdry", 8), { dryRun: true });
    assert.strictEqual(e.longDeliveryProgress.size, 0);
    return r;
  });

  const single = legacyMessage(units.map((u) => u.password));
  assert.deepStrictEqual(out, {
    orderId: "eo-longdry",
    dryRun: true,
    source: "offer:Code bundle",
    wouldSend:
      "8 account(s) [bundle-99, bundle-98, bundle-97, bundle-96, bundle-95, bundle-94, " +
      "bundle-93, bundle-92], 5006 chars as 8 messages, one per unit (longest 624 chars)",
    preview: single,
    messages: [624, 624, 624, 624, 624, 624, 624, 624],
  });
  assert.strictEqual(env.sent().length, 0);
  assert.strictEqual(env.mp.eldoradoMarkDelivered.calls.length, 0);
  assert.strictEqual(env.supplied.calls.markDelivered.length, 0);
  assert.strictEqual(env.supplied.calls.claimForListing[0].opts.dryRun, true);
});

// Every pause the code under test asks for, without waiting for any of them.
async function recordingPauses(fn) {
  const asked = [];
  const real = global.setTimeout;
  global.setTimeout = (cb, ms, ...rest) => {
    asked.push(ms);
    return real(cb, 0, ...rest);
  };
  try {
    return [await fn(), asked];
  } finally {
    global.setTimeout = real;
  }
}

test("the unit messages are spaced: one pause BETWEEN two posts, none before the first", async () => {
  const units = shelf(8, 600);
  const env = makeEnv({ units, refuse: (_t, n) => n === 4 });

  await quiet(() =>
    run(env, async (e) => {
      const gap = e.ELD_UNIT_MESSAGE_GAP_MS;
      const wait = e.ELD_UNIT_STAMP_WAIT_MS;
      assert.ok(gap >= 200 && gap <= 1000, "a human-sized pause, not a burst and not a crawl: " + gap);
      assert.ok(wait >= 1000 && wait <= 10000 && wait !== gap, "a bounded wait for the ledger: " + wait);

      // The tick's own call: no unitGapMs. Messages 1-3 land, 4 is refused.
      // One pause before each of messages 2, 3 and 4 — none before the first —
      // and then one bounded wait for the three ledger stamps.
      const [, first] = await recordingPauses(() =>
        e.deliverOrder(order("eo-gap", 8), { dryRun: false }),
      );
      assert.deepStrictEqual(first, [gap, gap, gap, wait]);

      // The retry skips 1-3 and posts 4-8: four pauses, none before message 4.
      const [second, again] = await recordingPauses(() =>
        e.deliverOrder(order("eo-gap", 8), { dryRun: false }),
      );
      assert.strictEqual(second.delivered, 8);
      assert.deepStrictEqual(again, [gap, gap, gap, gap, wait]);
    }),
  );
});

/* -------------------- 3. a failed message half way through ----------------- */

test("a failed SECOND message leaves the order unmarked; the retry sends the rest and finishes", async () => {
  const units = shelf(8, 600);
  let refusing = true;
  const env = makeEnv({ units, refuse: (text) => refusing && text.startsWith(header(2, 8)) });
  const expected = units.map((u, i) => header(i + 1, 8) + u.password);

  await quiet(() =>
    run(env, async (e) => {
      const first = await deliver(e, order("eo-retry", 8));

      assert.strictEqual(
        first.error,
        "long delivery interrupted at message 2 of 8 (at least 1 of 8 are in the buyer's chat): " +
          "Eldorado chat send failed (HTTP 400): Request failed with status code 400" +
          " — the order is not marked delivered, the next tick tries again",
      );
      assert.strictEqual(first.delivered, undefined);
      assert.strictEqual(e.alertsOperator(first.error), false, "one failed send is not a page");
      // Unit 1 is with the buyer and its ledger row says so. Nothing else moved:
      // the order is not marked, the ledger is not burned, the row holds no unit.
      assert.deepStrictEqual(env.timeline, ["send", "ledger.stamp:LED01", "send-FAILED"]);
      assert.strictEqual(env.mp.eldoradoMarkDelivered.calls.length, 0, "the order is NOT marked delivered");
      assert.strictEqual(env.listing.units.length, 0, "no unit is recorded on the row");
      assert.strictEqual(env.listing.saves, 0);
      assert.deepStrictEqual(env.sent(), [expected[0], expected[1]]);

      // The next 60-second tick. The claim resumes the same units by order id.
      refusing = false;
      const second = await deliver(e, order("eo-retry", 8));

      assert.deepStrictEqual(second, {
        orderId: "eo-retry",
        delivered: 8,
        source: "offer:Code bundle",
      });
      // Message 1 is in the chat already and is not posted again; 2 to 8 follow,
      // message 2 with the very text that failed.
      assert.deepStrictEqual(env.sent().slice(2), expected.slice(1));
      assert.deepStrictEqual(env.timeline.slice(3), [
        ...units.slice(1).flatMap((u) => ["send", "ledger.stamp:" + u.ledgerId]),
        "markDelivered",
        "ledger.burn(8)",
        "listing.save",
      ]);
      assert.deepStrictEqual(
        env.supplied.calls.claimForListing.map((c) => c.opts.orderId),
        ["eo-retry", "eo-retry"],
        "both attempts claim under the same order id — that is what resumes the units",
      );
      assert.strictEqual(env.listing.units.length, 8);
      assert.strictEqual(e.longDeliveryProgress.size, 0);
    }),
  );
  // Each unit's text was accepted by the chat exactly once.
  assert.deepStrictEqual(env.accepted, expected);
});

test("after a RESTART the retry re-sends the same texts from the top", async () => {
  const units = shelf(8, 600);
  let refusing = true;
  const env = makeEnv({ units, refuse: (text) => refusing && text.startsWith(header(4, 8)) });

  await quiet(() =>
    run(env, async (e) => {
      const first = await deliver(e, order("eo-restart", 8));
      assert.match(first.error, /interrupted at message 4 of 8 \(at least 3 of 8 are in the buyer's chat\)/);
      const before = env.sent().slice();
      assert.strictEqual(before.length, 4);

      // pm2 restart: what this process knew the chat had accepted is gone.
      e.longDeliveryProgress.clear();
      refusing = false;

      const second = await deliver(e, order("eo-restart", 8));
      assert.strictEqual(second.delivered, 8);

      const after = env.sent().slice(4);
      assert.strictEqual(after.length, 8, "every message is posted again from the top");
      // Messages 1 to 3 go out a second time WORD FOR WORD — which is what lets
      // the chat recognise them by their key (next section).
      assert.deepStrictEqual(after.slice(0, 4), before);
      assert.strictEqual(new Set(after).size, 8);
      assert.deepStrictEqual(env.mp.eldoradoMarkDelivered.calls, [["eo-restart"]]);
    }),
  );
});

test("a resume that hands the units back in ANOTHER order still numbers them the same", async () => {
  // utils/suppliedStock.claimForListing returns a first claim in
  // (createdAt, _id) order and a resumed one in (soldAt, _id) order. A unit that
  // changed place would change its "ACCOUNT i of N" header, its text, and its
  // key — and reach the buyer twice under two numbers.
  const units = shelf(8, 600);
  const firstClaim = [units[2], units[0], units[1], units[5], units[4], units[3], units[7], units[6]];
  const resumed = units.slice().reverse();
  let refusing = true;
  const env = makeEnv({
    units,
    claims: [firstClaim, resumed],
    refuse: (text) => refusing && text.startsWith(header(3, 8)),
  });
  const expected = units.map((u, i) => header(i + 1, 8) + u.password);

  await quiet(() =>
    run(env, async (e) => {
      const first = await deliver(e, order("eo-order", 8));
      assert.match(first.error, /interrupted at message 3 of 8/);
      // Ledger-id order, whatever order the claim came back in — and not login
      // order either, which on this shelf runs the other way.
      assert.deepStrictEqual(env.sent(), expected.slice(0, 3));
      assert.deepStrictEqual(env.stamps(), ["LED01", "LED02"]);

      e.longDeliveryProgress.clear();
      refusing = false;
      const second = await deliver(e, order("eo-order", 8));
      assert.strictEqual(second.delivered, 8);
      assert.deepStrictEqual(env.sent().slice(3), expected);
    }),
  );

  // Across both attempts the buyer's chat was offered exactly eight texts.
  assert.strictEqual(new Set(env.sent()).size, 8);
});

test("when the UNITS change between attempts, every unit of the order still gets its message", async () => {
  // A ledger row removed by hand between two attempts: the resume comes back one
  // short and the claim tops it up with a new unit. The numbering shifts, so
  // most texts are new — and what was accepted before must be judged by TEXT.
  // Skipping "the first three messages" instead would mark the order delivered
  // with a unit the buyer never received.
  const units = shelf(9, 600);
  const before = units.slice(0, 8);
  const after = [units[0], ...units.slice(2, 9)]; // LED02 gone, LED09 in
  let refusing = true;
  const env = makeEnv({
    units,
    claims: [before, after],
    refuse: (text) => refusing && text.startsWith(header(4, 8)),
  });

  await quiet(() =>
    run(env, async (e) => {
      const first = await deliver(e, order("eo-swap", 8));
      assert.match(first.error, /interrupted at message 4 of 8/);
      refusing = false;
      const second = await deliver(e, order("eo-swap", 8));
      assert.strictEqual(second.delivered, 8);
    }),
  );

  const final = after.map((u, i) => header(i + 1, 8) + u.password);
  for (const text of final) {
    assert.strictEqual(
      env.accepted.filter((t) => t === text).length,
      1,
      "accepted exactly once: " + text.slice(0, 30),
    );
  }
  // Only LED01 kept its number, so only its message was left out of the retry.
  assert.deepStrictEqual(env.sent().slice(4), final.slice(1));
});

test("a delivery that failed AFTER every message landed re-sends none of them", async () => {
  // Marking the order delivered threw. The next tick must mark it — and must
  // not put eight unit messages in front of the buyer a second time.
  const units = shelf(8, 600);
  const env = makeEnv({ units });
  let refuseMark = true;
  env.mp.eldoradoMarkDelivered = spy(async () => {
    if (refuseMark) {
      refuseMark = false;
      throw new Error("Eldorado mark delivered failed (HTTP 502)");
    }
    env.timeline.push("markDelivered");
  });

  await quiet(() =>
    run(env, async (e) => {
      await assert.rejects(deliver(e, order("eo-mark", 8)), /mark delivered failed/);
      assert.strictEqual(env.sent().length, 8);
      assert.strictEqual(env.listing.units.length, 0);

      const second = await deliver(e, order("eo-mark", 8));
      assert.strictEqual(second.delivered, 8);
      assert.strictEqual(env.sent().length, 8, "nothing was posted again");
      assert.strictEqual(env.listing.units.length, 8);
      assert.strictEqual(e.longDeliveryProgress.size, 0);
    }),
  );
});

test("a unit's ledger stamp that fails does not hold up the delivery", async () => {
  // The stamp is bookkeeping about a unit the buyer already holds. A write that
  // fails must never leave a paid buyer waiting for the rest.
  const units = shelf(8, 600);
  const env = makeEnv({ units });
  env.supplied.stampFails = true;

  const [out, printed] = await quiet(() => run(env, (e) => deliver(e, order("eo-stamp", 8))));

  assert.strictEqual(out.delivered, 8);
  assert.strictEqual(env.sent().length, 8);
  assert.strictEqual(printed.filter((l) => /unit stamp: mongo: write refused/.test(l)).length, 8);
  assert.deepStrictEqual(env.timeline.slice(-3), ["markDelivered", "ledger.burn(8)", "listing.save"]);
});

test("a ledger write that never comes back does not hold up the order either", async () => {
  // Not waited for between two messages, and waited for once, with a bound, at
  // the end of the attempt: eight units, one wait, order delivered.
  const units = shelf(8, 600);
  const env = makeEnv({ units });
  env.supplied.stampHangs = true;

  let wait;
  const [[out, timers]] = await quiet(() =>
    run(env, (e) => {
      wait = e.ELD_UNIT_STAMP_WAIT_MS;
      return recordingPauses(() =>
        e.deliverOrder(order("eo-hang", 8), { dryRun: false, unitGapMs: 0 }),
      );
    }),
  );

  assert.strictEqual(out.delivered, 8);
  assert.strictEqual(env.sent().length, 8);
  assert.deepStrictEqual(timers, [wait], "one bounded wait, not one per unit");
  assert.deepStrictEqual(env.timeline.slice(-3), ["markDelivered", "ledger.burn(8)", "listing.save"]);
});

test("a unit that rendered EMPTY stops a long delivery before the attempt sends anything", async () => {
  const units = shelf(8, 600);
  units[4] = { ...units[4], password: "   " };
  const env = makeEnv({ units });

  await run(env, async (e) => {
    const out = await deliver(e, order("eo-blank", 8));
    assert.match(out.error, /rendered empty for unit 5 of 8/);
    assert.strictEqual(e.alertsOperator(out.error), true);
  });
  assert.strictEqual(env.sent().length, 0);
  assert.strictEqual(env.mp.eldoradoMarkDelivered.calls.length, 0);
});

test("an edit of the offer's text mid-order re-sends the units under the new text, still per unit", async () => {
  const units = shelf(8, 600);
  let refusing = true;
  const env = makeEnv({ units, refuse: (text) => refusing && text.startsWith(header(4, 8)) });

  await quiet(() =>
    run(env, async (e) => {
      const first = await deliver(e, order("eo-edit", 8));
      assert.match(first.error, /interrupted at message 4 of 8 \(at least 3 of 8 are in the buyer's chat\)/);
      assert.strictEqual(e.longDeliveryProgress.size, 1);

      // The owner shortens the offer's text: as ONE message it would now be
      // well under the threshold. It still goes out per unit — and since every
      // text is new, the process has seen none of THESE accepted, and says so
      // rather than repeating a count that belongs to the old text.
      env.offer.deliveryTemplate = "short {login}";
      const second = await deliver(e, order("eo-edit", 8));
      assert.match(
        second.error,
        /^long delivery interrupted at message 4 of 8 \(at least 3 of 8 are in the buyer's chat\)/,
        "messages 1-3 of the new text landed in this attempt",
      );
      env.offer.deliveryTemplate = "shorter {login}";
      refusing = "all";
      env.mp.eldoradoSendOrderMessage = spy(async () => {
        throw new Error("Eldorado chat send failed (HTTP 503)");
      });
      const third = await deliver(e, order("eo-edit", 8));
      assert.match(
        third.error,
        /^long delivery interrupted at message 1 of 8 \(this process has not seen any of them accepted\)/,
      );
      assert.strictEqual(e.longDeliveryProgress.size, 1);
    }),
  );
});

test("a finished order leaves nothing behind, whichever way it finished", async () => {
  const units = shelf(8, 600);
  let refusing = true;
  const env = makeEnv({ units, refuse: (text) => refusing && text.startsWith(header(2, 8)) });

  await quiet(() =>
    run(env, async (e) => {
      await deliver(e, order("eo-done", 8));
      assert.strictEqual(e.longDeliveryProgress.size, 1);
      refusing = false;
      assert.strictEqual((await deliver(e, order("eo-done", 8))).delivered, 8);
      assert.strictEqual(e.longDeliveryProgress.size, 0);
    }),
  );
});

test("what is remembered of half-sent orders is bounded, oldest out first", async () => {
  const units = shelf(8, 600);
  const env = makeEnv({ units, refuse: (text) => text.startsWith(header(2, 8)) });

  await quiet(() =>
    run(env, async (e) => {
      const max = e.LONG_DELIVERY_PROGRESS_MAX;
      assert.ok(max >= 50 && max <= 1000, "a bound, and a roomy one: " + max);
      for (let i = 0; i < max; i++) {
        e.longDeliveryProgress.set("old-" + i, { sent: new Set(["x"]), stalled: 0 });
      }
      await deliver(e, order("eo-new", 8));
      assert.strictEqual(e.longDeliveryProgress.size, max);
      assert.strictEqual(e.longDeliveryProgress.has("old-0"), false, "the oldest made room");
      assert.strictEqual(e.longDeliveryProgress.has("old-1"), true, "and only the oldest");
      assert.strictEqual(e.longDeliveryProgress.has("eo-new"), true);
    }),
  );
});

/* ------------------ the keys, off the REAL eldoradoSendOrderMessage ---------- */

// utils/marketplaces with only the network replaced: the token read and every
// PUT answer 200, and each chat post is recorded with the idempotencyKey the
// real code gave it. `refusePost(n, text)` makes a post answer HTTP 400.
async function withRealConnector(fn) {
  const posts = [];
  const state = { refusePost: () => false };
  const fakeAxios = async (cfg) =>
    /\/api\/conversations\/me\/authorize$/.test(String(cfg.url))
      ? { data: { token: "talk-token" }, headers: {} }
      : { data: {}, headers: {} };
  fakeAxios.post = async (url, payload) => {
    const n = posts.push({ url, key: payload.idempotencyKey, text: payload.text, ok: true });
    if (state.refusePost(n, payload.text)) {
      posts[n - 1].ok = false;
      const err = new Error("Request failed with status code 400");
      err.response = { status: 400, data: "" };
      throw err;
    }
    return { data: { ok: "1" } };
  };
  return withStubbed(
    "../utils/marketplaces",
    {
      axios: fakeAxios,
      "../utils/settings": {
        loadSettings: () => ({
          marketplaces: { eldorado: { cookie: "sid=1; __Host-XSRF-TOKEN=x" } },
        }),
        saveSettings: async () => {},
      },
      "../utils/secretBox": { encrypt: (v) => v, decrypt: (v) => v },
    },
    (mp) => fn(mp, posts, state),
  );
}

test("REAL SEND: every unit message has its own idempotency key, made of the order id and its text", async () => {
  const units = shelf(8, 600);
  await withRealConnector(async (mp, posts) => {
    const env = makeEnv({ units, mp });
    const [out] = await quiet(() => run(env, (e) => deliver(e, order("eo-keys", 8))));
    assert.strictEqual(out.delivered, 8);

    assert.strictEqual(posts.length, 8);
    assert.deepStrictEqual(
      posts.map((p) => p.text),
      units.map((u, i) => header(i + 1, 8) + u.password),
    );
    assert.strictEqual(new Set(posts.map((p) => p.key)).size, 8, "two units sharing a key would reach the buyer as one");
    for (const p of posts) assert.match(p.key, /^eld-eo-keys-[0-9a-f]{12}$/);
    // The same text under another order is another key: a repeat buyer's second
    // order is never mistaken for a re-send of the first.
    await mp.eldoradoSendOrderMessage(order("eo-other", 1), posts[0].text);
    assert.notStrictEqual(posts[8].key, posts[0].key);
    assert.strictEqual(posts[8].key.slice(-12), posts[0].key.slice(-12), "same text, same hash");
  });
});

test("REAL SEND: a retry after a failed second message hands TalkJS the keys it has already seen", async () => {
  const units = shelf(8, 600);
  await withRealConnector(async (mp, posts, state) => {
    const env = makeEnv({ units, mp });
    await quiet(() =>
      run(env, async (e) => {
        state.refusePost = (n) => n === 2;
        const first = await deliver(e, order("eo-realretry", 8));
        // The connector's own wording, carried into the fulfiller's error.
        assert.match(
          first.error,
          /^long delivery interrupted at message 2 of 8 \(at least 1 of 8 are in the buyer's chat\): Eldorado chat send failed \(HTTP 400\)/,
        );
        assert.deepStrictEqual(posts.map((p) => p.ok), [true, false]);
        const firstKeys = posts.map((p) => p.key);

        // Same process, next tick: message 1 is not posted again at all.
        state.refusePost = (n) => n === 5;
        const second = await deliver(e, order("eo-realretry", 8));
        assert.match(second.error, /interrupted at message 4 of 8 \(at least 3 of 8/);
        assert.deepStrictEqual(
          posts.slice(2).map((p) => p.key),
          [firstKeys[1], posts[3].key, posts[4].key],
        );
        assert.strictEqual(posts[2].key, firstKeys[1], "message 2 goes out again under the key that failed");

        // A restart: everything is posted again, each under the key TalkJS has
        // already seen for it — that is the whole of what protects the buyer.
        e.longDeliveryProgress.clear();
        state.refusePost = () => false;
        const third = await deliver(e, order("eo-realretry", 8));
        assert.strictEqual(third.delivered, 8);
        const replay = posts.slice(5);
        assert.strictEqual(replay.length, 8);
        assert.strictEqual(replay[0].key, firstKeys[0]);
        assert.strictEqual(replay[1].key, firstKeys[1]);
        assert.strictEqual(replay[2].key, posts[3].key);
        assert.strictEqual(new Set(replay.map((p) => p.key)).size, 8);
        assert.strictEqual(new Set(posts.map((p) => p.key)).size, 8, "eight keys in all, however often they were sent");
      }),
    );
  });
});

test("REAL SEND: leading and trailing blank space does not change which message it is", async () => {
  // eldoradoSendOrderMessage trims before it hashes, and so does the fulfiller
  // when it remembers what the chat accepted: one text, one message, to both.
  const units = shelf(8, 600).map((u) => ({ ...u, password: u.password + "\n\n" }));
  await withRealConnector(async (mp, posts, state) => {
    const env = makeEnv({ units, mp });
    await quiet(() =>
      run(env, async (e) => {
        state.refusePost = (n) => n === 3;
        await deliver(e, order("eo-trim", 8));
        state.refusePost = () => false;
        const second = await deliver(e, order("eo-trim", 8));
        assert.strictEqual(second.delivered, 8);
      }),
    );
    assert.strictEqual(posts.filter((p) => p.ok).length, 8, "each unit accepted once");
    assert.ok(posts.every((p) => p.text === p.text.trim()));
  });
});

/* ---------------------- 4. the operator hears about it --------------------- */

test("a long delivery that gets no further is called stuck after three attempts in a row", async () => {
  const units = shelf(8, 600);
  // Message 1 lands; message 2 is refused every time.
  const env = makeEnv({ units, refuse: (text) => text.startsWith(header(2, 8)) });

  await quiet(() =>
    run(env, async (e) => {
      assert.strictEqual(e.ELD_LONG_DELIVERY_STUCK_AFTER, 3);
      const errors = [];
      for (let attempt = 1; attempt <= 5; attempt++) {
        errors.push((await deliver(e, order("eo-stuck", 8))).error);
      }
      // Attempt 1 got somewhere (message 1). 2, 3 and 4 got nowhere.
      assert.match(errors[0], /^long delivery interrupted at message 2 of 8 /);
      assert.match(errors[1], /^long delivery interrupted at message 2 of 8 /);
      assert.match(errors[2], /^long delivery interrupted at message 2 of 8 /);
      assert.match(
        errors[3],
        /^long delivery stuck at message 2 of 8 \(at least 1 of 8 are in the buyer's chat; 3 attempts in a row got no further\): /,
      );
      assert.match(errors[4], /^long delivery stuck .*; 4 attempts in a row got no further/);
      assert.deepStrictEqual(
        errors.map((x) => e.alertsOperator(x)),
        [false, false, false, true, true],
      );
      // Message 1 was posted once in five attempts; the other calls are message 2.
      const first = header(1, 8) + units[0].password;
      assert.strictEqual(env.sent().filter((t) => t === first).length, 1);
      assert.strictEqual(env.sent().length, 6);
      assert.strictEqual(env.mp.eldoradoMarkDelivered.calls.length, 0);
    }),
  );
});

test("an order that keeps getting FURTHER is never called stuck", async () => {
  // A chat that takes three messages a minute and refuses the fourth: slow, but
  // arriving. Paging "deliver it by hand" a minute before it finishes by itself
  // is how a second copy goes out.
  const units = shelf(12, 600);
  const env = makeEnv({ units, refuse: (_t, n) => n % 4 === 0 });

  await quiet(() =>
    run(env, async (e) => {
      const results = [];
      for (let attempt = 1; attempt <= 4; attempt++) {
        results.push(await deliver(e, order("eo-slow", 12)));
      }
      assert.match(results[0].error, /^long delivery interrupted at message 4 of 12 \(at least 3 of 12/);
      assert.match(results[1].error, /^long delivery interrupted at message 7 of 12 \(at least 6 of 12/);
      assert.match(results[2].error, /^long delivery interrupted at message 10 of 12 \(at least 9 of 12/);
      assert.strictEqual(results[3].delivered, 12);
      assert.ok(results.slice(0, 3).every((r) => !e.alertsOperator(r.error)));
    }),
  );
});

test("a FIRST message the chat refuses is counted too — also after a restart", async () => {
  const units = shelf(8, 600);
  let mode = "fourth";
  const env = makeEnv({
    units,
    refuse: (text) => (mode === "all" ? true : mode === "fourth" && text.startsWith(header(4, 8))),
  });

  await quiet(() =>
    run(env, async (e) => {
      // Three units land, the fourth fails, the process restarts, and the chat
      // now refuses everything. The buyer holds three units and this process
      // has no memory of it: it must still say so within three ticks.
      assert.match((await deliver(e, order("eo-first", 8))).error, /interrupted at message 4 of 8/);
      e.longDeliveryProgress.clear();
      mode = "all";

      const errors = [];
      for (let attempt = 1; attempt <= 3; attempt++) {
        errors.push((await deliver(e, order("eo-first", 8))).error);
      }
      assert.match(errors[0], /^long delivery interrupted at message 1 of 8 \(this process has not seen any of them accepted\): /);
      assert.match(errors[1], /^long delivery interrupted at message 1 of 8 /);
      assert.match(errors[2], /^long delivery stuck at message 1 of 8 \(this process has not seen any of them accepted; 3 attempts in a row got no further\): /);
      assert.strictEqual(e.alertsOperator(errors[2]), true);
    }),
  );
});

test("a chat that is not OPEN yet is not a failure: it throws as it always did and is counted nowhere", async () => {
  // A freshly paid order has no chat until the buyer opens it: Eldorado mints
  // the conversation lazily, the send throws, and the order ships by itself a
  // few ticks later. Nothing was handed over, so nothing is "stuck" — however
  // long the buyer takes.
  const units = shelf(8, 600);
  const env = makeEnv({ units });
  env.mp.eldoradoSendOrderMessage = spy(async (o) => {
    if (!o.talkJsConversationId) throw new Error("Eldorado chat: order has no talkJsConversationId");
    return { ok: "1" };
  });
  const closed = order("eo-nochat", 8, { talkJsConversationId: null });

  await quiet(() =>
    run(env, async (e) => {
      for (let tick = 1; tick <= 6; tick++) {
        await assert.rejects(deliver(e, closed), /^Error: Eldorado chat: order has no talkJsConversationId$/);
        assert.strictEqual(e.longDeliveryProgress.size, 0, "tick " + tick + " left nothing behind");
      }
      assert.strictEqual(env.mp.eldoradoMarkDelivered.calls.length, 0);
      assert.strictEqual(env.supplied.calls.markDelivered.length, 0);

      const out = await deliver(e, order("eo-nochat", 8));
      assert.strictEqual(out.delivered, 8);
      // Six refused tries of message 1, then all eight.
      assert.strictEqual(env.mp.eldoradoSendOrderMessage.calls.length, 14);
    }),
  );
});

test("each order counts its own attempts", async () => {
  const units = shelf(8, 600);
  const env = makeEnv({ units, refuse: (text) => text.startsWith(header(1, 8)) });

  await quiet(() =>
    run(env, async (e) => {
      const a1 = await deliver(e, order("eo-a", 8));
      const a2 = await deliver(e, order("eo-a", 8));
      const b1 = await deliver(e, order("eo-b", 8));
      const a3 = await deliver(e, order("eo-a", 8));
      const b2 = await deliver(e, order("eo-b", 8));
      assert.match(a1.error, /^long delivery interrupted/);
      assert.match(a2.error, /^long delivery interrupted/);
      assert.match(b1.error, /^long delivery interrupted/, "another order's failures are not this one's");
      assert.match(a3.error, /^long delivery stuck .*; 3 attempts in a row/);
      assert.match(b2.error, /^long delivery interrupted/);
    }),
  );
});

// The real tick, the way pm2 runs it: one paid order, read again every minute.
function tickEnv(env, paid) {
  env.af.eldoradoAutoDeliver = true;
  env.af.eldoradoDeliverDryRun = false;
  env.mp.keyStatus = () => ({ eldorado: { configured: true } });
  env.mp.eldoradoEnsureFreshSession = async () => ({});
  env.mp.eldoradoPaidOrders = async () => [paid];
  return env;
}

test("TICK: an order stuck half sent pages ONCE, when it has stopped getting anywhere", async () => {
  const units = shelf(8, 600);
  const env = tickEnv(
    makeEnv({ units, refuse: (text) => text.startsWith(header(2, 8)) }),
    order("eo-tick", 8),
  );

  const [, printed] = await quiet(() =>
    run(env, async (e) => {
      for (let tick = 1; tick <= 3; tick++) await e.deliverPaidOrders();
      assert.strictEqual(env.telegrams.length, 0, "three ticks in: still a blip");
      for (let tick = 4; tick <= 8; tick++) await e.deliverPaidOrders();
    }),
  );

  assert.strictEqual(env.telegrams.length, 1, "one page for the order, not one a minute");
  assert.match(env.telegrams[0], /Eldorado order eo-tick is PAID/);
  assert.match(env.telegrams[0], /Reason: long delivery stuck at message 2 of 8 \(at least 1 of 8 are in the buyer's chat/);
  // The remedy has to match the state: part of the order is out, so "deliver it
  // by hand" alone would put the first unit in front of the buyer twice.
  assert.match(env.telegrams[0], /send only the missing units/);
  assert.doesNotMatch(env.telegrams[0], /This one needs delivering by hand/);
  // Every failed tick leaves a line that names the order.
  assert.strictEqual(
    printed.filter((l) => /^error: eldorado deliver eo-tick: long delivery (interrupted|stuck)/.test(l)).length,
    8,
  );
  assert.strictEqual(env.mp.eldoradoMarkDelivered.calls.length, 0);
});

test("TICK: an order already paged for something else is STILL heard about when it sticks half sent", async () => {
  // Out of stock on the first tick (one page). The owner pastes the missing
  // units; the delivery starts and then sticks at message 2. That is a second,
  // different thing to know about the same order.
  const units = shelf(8, 600);
  const env = tickEnv(
    makeEnv({
      units,
      claims: [units.slice(0, 5), units],
      refuse: (text) => text.startsWith(header(2, 8)),
    }),
    order("eo-twice", 8),
  );

  await quiet(() =>
    run(env, async (e) => {
      await e.deliverPaidOrders();
      assert.strictEqual(env.telegrams.length, 1);
      assert.match(env.telegrams[0], /out of stock: only 5 of 8/);
      for (let tick = 2; tick <= 9; tick++) await e.deliverPaidOrders();
    }),
  );

  assert.strictEqual(env.telegrams.length, 2);
  assert.match(env.telegrams[1], /long delivery stuck at message 2 of 8/);
});

test("TICK: a buyer who has not opened the chat yet pages nobody", async () => {
  const units = shelf(8, 600);
  const env = tickEnv(makeEnv({ units }), order("eo-closed", 8, { talkJsConversationId: null }));
  env.mp.eldoradoSendOrderMessage = spy(async () => {
    throw new Error("Eldorado chat: order has no talkJsConversationId");
  });

  const [, printed] = await quiet(() =>
    run(env, async (e) => {
      for (let tick = 1; tick <= 10; tick++) await e.deliverPaidOrders();
    }),
  );

  assert.strictEqual(env.telegrams.length, 0);
  // The line the tick has always written for it, unchanged.
  assert.strictEqual(
    printed.filter((l) => l === "error: eldorado deliver failed: Eldorado chat: order has no talkJsConversationId").length,
    10,
  );
});

test("TICK: two orders stuck half sent are two pages", async () => {
  const units = shelf(8, 600);
  const env = tickEnv(
    makeEnv({ units, refuse: (text) => text.startsWith(header(2, 8)) }),
    order("eo-pair-a", 8),
  );
  env.mp.eldoradoPaidOrders = async () => [order("eo-pair-a", 8), order("eo-pair-b", 8)];

  await quiet(() =>
    run(env, async (e) => {
      for (let tick = 1; tick <= 6; tick++) await e.deliverPaidOrders();
    }),
  );

  assert.strictEqual(env.telegrams.length, 2);
  assert.ok(env.telegrams.some((t) => /Eldorado order eo-pair-a is PAID/.test(t)));
  assert.ok(env.telegrams.some((t) => /Eldorado order eo-pair-b is PAID/.test(t)));
});

test("TICK: a half-sent order stopped by ANOTHER fault is heard about too", async () => {
  // Out of stock (page 1). Restocked; three units go out, the fourth is
  // refused. Then a row is found empty: "rendered empty" from now on. The buyer
  // holds three units and the first page said nothing of the kind.
  const units = shelf(8, 600);
  let refusing = true;
  const env = tickEnv(
    makeEnv({
      units,
      claims: [units.slice(0, 5), units],
      refuse: (text) => refusing && text.startsWith(header(4, 8)),
    }),
    order("eo-two-faults", 8),
  );

  await quiet(() =>
    run(env, async (e) => {
      await e.deliverPaidOrders();
      assert.strictEqual(env.telegrams.length, 1);
      await e.deliverPaidOrders(); // 3 of 8 out, message 4 refused: a blip
      assert.strictEqual(env.telegrams.length, 1);

      units[6] = { ...units[6], password: " " };
      for (let tick = 3; tick <= 6; tick++) await e.deliverPaidOrders();
    }),
  );

  assert.strictEqual(env.telegrams.length, 2, "one more page, and only one");
  assert.match(env.telegrams[1], /rendered empty for unit 7 of 8/);
  // Three units are out: "deliver it by hand" alone would send them twice.
  assert.match(env.telegrams[1], /send only the missing units/);
  assert.match(env.telegrams[0], /This one needs delivering by hand/, "the first page was the ordinary one");
});

test("blank space around a unit's text does not make it a new message", async () => {
  // The chat is sent trimmed text and keys on it, so the fulfiller remembers a
  // message by its trimmed text too: a row re-saved with a trailing newline is
  // the same message, and is not posted a second time.
  const units = shelf(8, 600);
  const padded = units.map((u) => ({ ...u, password: u.password + "\n \n" }));
  let refusing = true;
  const env = makeEnv({
    units,
    claims: [units, padded],
    refuse: (text) => refusing && text.startsWith(header(4, 8)),
  });

  await quiet(() =>
    run(env, async (e) => {
      await deliver(e, order("eo-pad", 8));
      refusing = false;
      const second = await deliver(e, order("eo-pad", 8));
      assert.strictEqual(second.delivered, 8);
    }),
  );
  // 3 accepted + 1 refused, then messages 4-8 only.
  assert.strictEqual(env.sent().length, 9);
  assert.strictEqual(env.accepted.length, 8);
});

test("an order row that comes back without its chat id does not forget what was accepted", async () => {
  const units = shelf(8, 600);
  let refusing = true;
  const env = makeEnv({ units });
  env.mp.eldoradoSendOrderMessage = spy(async (o, text) => {
    if (!o.talkJsConversationId) throw new Error("Eldorado chat: order has no talkJsConversationId");
    if (refusing && text.startsWith(header(3, 8))) throw new Error("Eldorado chat send failed (HTTP 500)");
    env.accepted.push(text);
    return { ok: "1" };
  });

  await quiet(() =>
    run(env, async (e) => {
      await deliver(e, order("eo-flicker", 8));
      await assert.rejects(
        deliver(e, order("eo-flicker", 8, { talkJsConversationId: null })),
        /no talkJsConversationId/,
      );
      assert.strictEqual(e.longDeliveryProgress.size, 1, "two units are out: that is not forgotten");
      refusing = false;
      assert.strictEqual((await deliver(e, order("eo-flicker", 8))).delivered, 8);
    }),
  );
  assert.strictEqual(env.accepted.length, 8, "each unit accepted once");
});
