// Guards the PlayerAuctions integration's load-bearing rules — the ones that
// were learned from the live API and that nothing else in the codebase would
// catch if they regressed.
//
// The 300-character message cap is the sharpest of them: every other
// marketplace we deliver on takes a ~500-character hand-over, so the natural
// mistake is to reuse that copy here and have PlayerAuctions reject the send —
// silently, from the fulfiller's point of view, at the exact moment a buyer is
// waiting on credentials.
const test = require("node:test");
const assert = require("node:assert");

const mp = require("../utils/marketplaces");
const copy = require("../utils/playerauctionsCopy");

test("playerauctions is a registered marketplace with a cookie credential", () => {
  assert.ok(mp.MARKETPLACES.includes("playerauctions"));
  assert.deepStrictEqual(mp.FIELDS.playerauctions, ["cookie"]);
});

test("the verified API constants match what the live API enforces", () => {
  // $5, not Eldorado's $0.50: "The minimum trade price can't be lower than $5".
  assert.strictEqual(mp.PA_MIN_PRICE, 5);
  assert.strictEqual(mp.PA_MAX_MESSAGE, 300);
  // 20 Minutes is the fastest guarantee and the one a delivery bot can honour.
  assert.strictEqual(mp.PA_DELIVERY.min20, 5);
  assert.strictEqual(mp.PA_DELIVERY.hour6, 106);
});

/* ---------------------------- delivery copy ---------------------------- */

test("every hand-over message fits PlayerAuctions' 300-character cap", () => {
  const mk = (n) =>
    Array.from({ length: n }, (_, i) => ({
      login: "account" + String(i).padStart(5, "0"),
      password: "Pw" + i + "zzQm44kk",
    }));
  for (const n of [1, 2, 3, 5, 8, 12, 25, 40]) {
    for (const kind of ["bundle", "farm"]) {
      const msgs = copy.deliveryMessages(mk(n), { kind, days: 180, game: "Overwatch" });
      for (const m of msgs) {
        assert.ok(
          m.length <= copy.LIMIT,
          `${kind} x${n}: a message was ${m.length} chars (limit ${copy.LIMIT})`,
        );
      }
    }
  }
});

test("a single-account hand-over is one message carrying the credential", () => {
  const msgs = copy.deliveryMessages([{ login: "someLogin", password: "somePass" }], {
    kind: "bundle",
  });
  assert.strictEqual(msgs.length, 1);
  assert.match(msgs[0], /someLogin/);
  assert.match(msgs[0], /somePass/);
});

test("an order too large for one message keeps every credential exactly once", () => {
  const accounts = Array.from({ length: 30 }, (_, i) => ({
    login: "login" + i,
    password: "pass" + i,
  }));
  const joined = copy.deliveryMessages(accounts, { kind: "bundle" }).join("\n");
  for (const a of accounts) {
    const hits = joined.split(a.login + " / " + a.password).length - 1;
    assert.strictEqual(hits, 1, `${a.login} appeared ${hits} times, expected exactly 1`);
  }
});

test("the farm hand-over states the term the buyer actually bought", () => {
  const one = [{ login: "l", password: "p" }];
  assert.match(copy.deliveryMessages(one, { kind: "farm", days: 180 })[0], /180 days/);
  assert.match(copy.deliveryMessages(one, { kind: "farm", days: 365 })[0], /1 year/);
});

test("the long claim guide lives in the instruction, not the message", () => {
  // The instruction is what carries the twitch.tv link and the full steps; the
  // message only points at it. If this inverts, the message stops fitting.
  assert.ok(copy.bundleInstruction().length > copy.LIMIT);
  assert.match(copy.bundleInstruction(), /twitch\.tv\/drops\/inventory/);
  const msg = copy.deliveryMessages([{ login: "l", password: "p" }], { kind: "bundle" })[0];
  assert.doesNotMatch(msg, /https?:\/\//);
});

test("the farm instruction names the same term as the message", () => {
  assert.match(copy.farmInstruction(120, "Rust"), /120 DAYS/);
  assert.match(copy.farmInstruction(120, "Rust"), /Rust/);
  assert.match(copy.farmInstruction(365, "Rust"), /1 YEAR/);
});

/* ------------------------------ order state ---------------------------- */

const fulfiller = require("../utils/playerauctionsFulfiller");

test("an order already claimed as delivered is never shipped again", () => {
  // Real shape from live order 16458589. The coarse orderStatus still reads
  // "Pending Delivery" here even though the seller HAS delivered, which is why
  // the event log is the authority. Getting this wrong re-ships — and
  // re-spends — every completed order on the next tick.
  const delivered = {
    status: { orderStatus: "Pending Delivery", current: "Delivery Pending Buyer Confirmation" },
    eventLogs: [
      { content: "Full delivery claimed by seller", dateTime: "Sep-04-2026 07:17:37 PM(PST)" },
      { content: "Payment settlement completed", dateTime: "Sep-04-2026 11:50:30 AM(PST)" },
      { content: "Order created", dateTime: "Sep-04-2026 11:49:22 AM(PST)" },
    ],
  };
  assert.strictEqual(mp.playerauctionsDetailNeedsDelivery(delivered), false);
  assert.strictEqual(
    mp.playerauctionsNeedsDelivery({ status: "Delivery Fully Completed" }),
    false,
  );
});

test("a settled, unshipped order is picked up on event-log evidence", () => {
  // The same order one step earlier: paid, no seller claim yet. No order in
  // this state existed on the account while the API was mapped, so the display
  // string for it is unknown — which is exactly why the log decides.
  const paid = {
    status: { orderStatus: "Pending Delivery", current: "Whatever PlayerAuctions Calls It" },
    eventLogs: [
      { content: "Payment settlement completed", dateTime: "Sep-04-2026 11:50:30 AM(PST)" },
      { content: "Verifying Payment", dateTime: "Sep-04-2026 11:50:24 AM(PST)" },
      { content: "Order created", dateTime: "Sep-04-2026 11:49:22 AM(PST)" },
    ],
  };
  assert.strictEqual(mp.playerauctionsDetailNeedsDelivery(paid), true);
});

test("an order with no payment event yet is not shipped", () => {
  const unpaid = {
    status: { orderStatus: "Pending payment", current: "Pending Payment" },
    eventLogs: [{ content: "Order created", dateTime: "x" }],
  };
  assert.strictEqual(mp.playerauctionsDetailNeedsDelivery(unpaid), false);
});

test("a plausible paid label is not mistaken for a completed order", () => {
  // The exact label for "paid, awaiting delivery" is unobserved. A guard broad
  // enough to match "Payment Completed" would silently stop every delivery, so
  // only delivery/order completion may exclude an order.
  for (const s of ["Payment Completed", "Payment Verified", "Awaiting Delivery"]) {
    assert.strictEqual(
      mp.playerauctionsNeedsDelivery({ status: s }),
      true,
      `${s} must still reach the detail fetch`,
    );
  }
});

test("the cheap list pre-filter drops everything obviously finished", () => {
  for (const s of [
    "Pending Payment",
    "Payment Failed",
    "Buyer Cancelled",
    "Buyer Cancelled Early",
    "Delivery Fully Completed",
    "Delivery Pending Buyer Confirmation",
    "Disputed Delivery Not Completed",
  ]) {
    assert.strictEqual(
      mp.playerauctionsNeedsDelivery({ status: s }),
      false,
      `${s} should not reach the detail fetch`,
    );
  }
});

test("an order is tied back to its listing through the offer link", () => {
  // The seller orders LIST carries no offerId field at all, so the id has to be
  // recovered from the offer URL on the order detail. Without this, every order
  // would fall back to a title match.
  assert.strictEqual(
    mp.playerauctionsOfferIdFromUrl(
      "https://www.playerauctions.com/overwatch-items/294684983i!overwatch-twitch-drops-26-items/",
    ),
    "294684983",
  );
  assert.strictEqual(mp.playerauctionsOfferIdFromUrl("not-an-offer-url"), "");
  assert.strictEqual(mp.playerauctionsOfferIdFromUrl(null), "");
});

test("the proof receipt reads the promised item count off the title", () => {
  assert.strictEqual(
    fulfiller.paItemCount({ title: "Overwatch Twitch Drops (26 Items) OWWC Groups 2026" }),
    26,
  );
  assert.strictEqual(fulfiller.paItemCount({ title: "Halo Twitch Drops (1 Item) Stream" }), 1);
  assert.strictEqual(fulfiller.paItemCount({ title: "no count here" }), 0);
});

test("quantity never reads the item count as a unit count", () => {
  // The orders list reports quantity as "26 Other Skins" — the ITEM count.
  // Parsing that as units would hand a buyer 26 accounts for one unit's money.
  assert.strictEqual(fulfiller.paQuantity({ quantity: "26 Other Skins" }), 1);
  assert.strictEqual(fulfiller.paQuantity({ purchaseQuantity: 3 }), 3);
  assert.strictEqual(fulfiller.paQuantity({}), 1);
});

test("a failed confirm-delivery does not re-send the buyer their credentials", async () => {
  // A hand-over is several HTTP calls: N messages, then confirm-delivery. If
  // the confirm fails, the next tick must re-confirm ONLY — re-sending would
  // hand the buyer their credentials again every 60s until it started working.
  const sent = [];
  const saved = require("../utils/marketplaces");
  const realSend = saved.playerauctionsSendOrderMessage;
  const realMark = saved.playerauctionsMarkDelivered;
  saved.playerauctionsSendOrderMessage = async (_id, text) => sent.push(text);
  saved.playerauctionsMarkDelivered = async () => ({ ok: true });
  try {
    const accounts = [{ login: "l", password: "p" }];
    await fulfiller.handOver({ orderId: "1", accounts, kind: "bundle", offerTitle: "T" });
    assert.strictEqual(sent.length, 1, "first attempt should send");
    await fulfiller.handOver({
      orderId: "1", accounts, kind: "bundle", offerTitle: "T", alreadyMessaged: true,
    });
    assert.strictEqual(sent.length, 1, "retry must not send a second time");
  } finally {
    saved.playerauctionsSendOrderMessage = realSend;
    saved.playerauctionsMarkDelivered = realMark;
  }
});

test("units reserved for an order are found again on a retry", () => {
  // This is what stops a part-failed multi-message hand-over from spending a
  // second set of accounts on the next tick.
  const listing = {
    units: [
      { login: "a", orderId: "111", deliveredAt: null },
      { login: "b", orderId: "", deliveredAt: null },
      { login: "c", orderId: "222", deliveredAt: new Date() },
    ],
  };
  assert.deepStrictEqual(
    fulfiller.unitsForOrder(listing, "111").map((u) => u.login),
    ["a"],
  );
  assert.deepStrictEqual(
    fulfiller.undeliveredUnits(listing).map((u) => u.login),
    ["a", "b"],
  );
});

test("an offer that is already off sale is a successful delist, not a failure", () => {
  // Eldorado answers "To pause an offer it must be active" when the offer is
  // not active — the delist goal already met. Left unmatched it stranded the
  // row as active-with-an-error, holding its accounts reserved forever.
  assert.strictEqual(
    mp.delistOutcome("Eldorado delist failed (HTTP 400): To pause an offer it must be active."),
    "gone",
  );
  assert.strictEqual(mp.delistOutcome("offer already paused"), "gone");
  assert.strictEqual(mp.delistOutcome("listing not found"), "gone");
  assert.strictEqual(mp.delistOutcome("item (sold)"), "sold");
  // A real failure must still read as a failure.
  assert.strictEqual(mp.delistOutcome("connection reset"), "");
});

/* ------------------------- the no-claim rule ---------------------------- */

test("Overwatch, Rainbow Six and Call of Duty are no-claim games", () => {
  // These drops must reach the buyer UNCLAIMED so they can connect and claim to
  // their own game account. The regular auto-farm claims as it farms, so its
  // Drop Archive accounts are exactly the wrong stock for them.
  const { isNoClaimGame } = require("../utils/settings");
  for (const g of [
    "Overwatch",
    "Overwatch 2",
    "Rainbow Six Siege",
    "Tom Clancys Rainbow Six Siege",
    "Call of Duty: Modern Warfare 4",
    "Call of Duty: Black Ops 7",
  ]) {
    assert.strictEqual(isNoClaimGame(g), true, `${g} should be a no-claim game`);
  }
  for (const g of ["Fortnite", "Marvel Rivals", "Halo Infinite", "Palia"]) {
    assert.strictEqual(isNoClaimGame(g), false, `${g} should NOT be a no-claim game`);
  }
});

test("an already-claimed drop is never handed to a buyer", async () => {
  // Per-account, not per-game: a claimed drop is worthless whatever the game,
  // because it has already gone to whoever the farm account was linked to.
  const DropLog = require("../models/DropLog");
  const set = { items: [{ name: "Esports Loot Box 41" }, { name: "OWWC Busan Spray" }] };
  // One batched query for every candidate, asking only for rows that ARE
  // claimed — the per-account loop this replaced was ~1000 round trips a tick.
  const real = DropLog.find;
  let queries = 0;
  DropLog.find = (q) => {
    queries++;
    assert.ok(q.login && q.login.$in, "must query all logins in one go");
    assert.strictEqual(q.claimed, true, "must ask only for claimed rows");
    return { lean: async () => [{ login: "spent" }] };
  };
  try {
    const kept = await fulfiller.unclaimedOnly(set, [{ login: "clean" }, { login: "spent" }]);
    assert.deepStrictEqual(kept.map((c) => c.login), ["clean"]);
    assert.strictEqual(queries, 1, "one query for the whole candidate list");
  } finally {
    DropLog.find = real;
  }
});

test("two offers on the same no-claim pool split it, not double it", async () => {
  // Both the CAH offer and the 26-item offer are backed by "Overwatch" and see
  // the same 11 sellable accounts. Reporting 11 on each advertises 22, and the
  // second buyer cannot be served.
  const ML = require("../models/MarketplaceListing");
  const realCount = ML.countDocuments;
  ML.countDocuments = async () => 2;
  try {
    const fakeClaim = async () => Array.from({ length: 11 }, (_, i) => ({ login: "a" + i }));
    const n = await fulfiller.stockFor({ unclaimedGame: "Overwatch", externalId: "1" }, fakeClaim);
    assert.strictEqual(n, 5, "11 accounts across 2 listings should report 5, not 11");
  } finally {
    ML.countDocuments = realCount;
  }
});

/* ----------------------- auto-listing no-claim guard --------------------- */

test("the auto-lister refuses to publish a no-claim game from the archive", async () => {
  // isNoClaimGame appeared NOWHERE in autoLister, so switching auto-listing on
  // would have published Overwatch/CoD bundles backed by the auto-farm's
  // CLAIMED archive — drops the buyer can never connect to their own account.
  const al = require("../utils/autoLister");
  const set = { _id: "s1", items: [{ name: "x" }] };
  for (const game of ["Overwatch", "Rainbow Six Siege", "Call of Duty"]) {
    await assert.rejects(
      () => al.publishPlayerAuctionsShare({ set, title: "t", game, accounts: [], price: 5 }),
      /no-claim game/i,
      game + " should be refused",
    );
    await assert.rejects(
      () => al.publishEldoradoShare({ set, title: "t", game, accounts: [], price: 5 }),
      /no-claim game/i,
      game + " should be refused on Eldorado too",
    );
  }
});

/* --------------------- unfulfillable-order alerting --------------------- */

test("a paid order the bot cannot ship alerts once, not every tick", async () => {
  // The four offers made by hand on PlayerAuctions have no listing row, so a
  // sale on one looks like a routine "skipped" line while the buyer waits and
  // the delivery guarantee runs down.
  const tg = require("../utils/telegram");
  const real = tg.sendTelegram;
  const sent = [];
  tg.sendTelegram = async (t) => sent.push(t);
  try {
    fulfiller.alertedOrders.clear();
    const order = { orderId: "16460001", orderTitle: "Overwatch Twitch Drops (26 Items)", name: "someBuyer", price: "$5.00" };
    await fulfiller.alertUnfulfillable(order, "no listing row for ...");
    await fulfiller.alertUnfulfillable(order, "no listing row for ...");
    await fulfiller.alertUnfulfillable(order, "no listing row for ...");
    assert.strictEqual(sent.length, 1, "should alert once per order");
    assert.match(sent[0], /16460001/);
    assert.match(sent[0], /cannot ship/);
    // A different order still gets its own alert.
    await fulfiller.alertUnfulfillable({ orderId: "16460002", orderTitle: "x" }, "no listing row");
    assert.strictEqual(sent.length, 2);
  } finally {
    tg.sendTelegram = real;
    fulfiller.alertedOrders.clear();
  }
});

/* ------------------------- the session watchdog ------------------------- */

test("a dead session alerts once, and recovery alerts once", async () => {
  // The expensive part of an outage is not the outage, it is the hours before
  // anyone notices — so this must fire promptly, and then shut up.
  const watch = require("../utils/playerauctionsSessionWatch");
  const tg = require("../utils/telegram");
  const realSend = tg.sendTelegram;
  const realTest = mp.playerauctionsTest;
  const realStatus = mp.keyStatus;
  const sent = [];
  tg.sendTelegram = async (t) => sent.push(t);
  mp.keyStatus = () => ({ playerauctions: { configured: true } });
  try {
    watch.state.alerted = false;
    mp.playerauctionsTest = async () => ({ ok: false, detail: "session not accepted" });
    await watch.check();
    await watch.check();
    await watch.check();
    assert.strictEqual(sent.length, 1, "should alert once per outage, not per tick");
    assert.match(sent[0], /DEAD/);
    assert.match(sent[0], /ONE session per account/);

    mp.playerauctionsTest = async () => ({ ok: true, detail: "Connected" });
    await watch.check();
    await watch.check();
    assert.strictEqual(sent.length, 2, "should announce recovery exactly once");
    assert.match(sent[1], /back/i);
  } finally {
    tg.sendTelegram = realSend;
    mp.playerauctionsTest = realTest;
    mp.keyStatus = realStatus;
    watch.state.alerted = false;
  }
});

/* --------------------------- the refresh lock --------------------------- */

test("concurrent refreshes are serialised into exactly one", async () => {
  // This is the bug that destroyed two live sessions on 2026-09-07. The pm2
  // server ticks every 60s while a publishing script runs for an hour in its
  // own process; both read the same jar, both 401 when the 30-minute access
  // token expires, both refresh — and the second one presents a spent refresh
  // token, which PlayerAuctions reads as reuse and revokes the whole family.
  const fs = require("fs");
  const pathmod = require("path");
  const lock = pathmod.join(__dirname, "..", "utils", ".playerauctions-refresh.lock");
  const stamp = pathmod.join(__dirname, "..", "utils", ".playerauctions-refresh.stamp");
  for (const f of [lock, stamp]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* not present */
    }
  }

  let refreshes = 0;
  // Stands in for the network call. The delay is what makes the race real: the
  // window between "lock looks free" and "we hold it" is where a double
  // refresh would slip through.
  const fakeRefresh = async () => {
    refreshes++;
    await new Promise((r) => setTimeout(r, 60));
    return true;
  };
  try {
    // Ten callers that all believe the same (empty) token is current.
    await Promise.all(
      Array.from({ length: 10 }, () => mp.paRefreshOnce("", fakeRefresh)),
    );
    assert.strictEqual(
      refreshes,
      1,
      `expected exactly 1 refresh across 10 concurrent callers, got ${refreshes}`,
    );
  } finally {
    for (const f of [lock, stamp]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* already gone */
      }
    }
  }
  // And the lock must not be left behind, or every later refresh wedges.
  assert.strictEqual(fs.existsSync(lock), false, "lock file was not released");
});

test("a caller whose token is already stale does not refresh at all", async () => {
  let refreshes = 0;
  const fakeRefresh = async () => {
    refreshes++;
    return true;
  };
  // "a-token-that-is-not-in-the-jar" is not what the jar holds, i.e. another
  // process has already rotated it. Spending ours again revokes the family.
  const did = await mp.paRefreshOnce("a-token-that-is-not-in-the-jar", fakeRefresh);
  assert.strictEqual(did, false, "should have deferred to the other process");
  assert.strictEqual(refreshes, 0, "must not refresh when the jar already moved");
});

/* ------------------------------ farm orders ---------------------------- */

const farm = require("../utils/playerauctionsFarmService");

test("the farming term is read from every title form we have shipped", () => {
  assert.strictEqual(farm.termToDays("Rust Twitch Drops Automatic Farming 120 Days"), 120);
  assert.strictEqual(
    farm.termToDays("Overwatch Twitch Drops Automatic farming 180 days"),
    180,
  );
  assert.strictEqual(farm.termToDays("Rust Twitch Drops Automatic Farming 1 Year"), 365);
  // A title we cannot read must yield 0 so the caller refuses rather than guesses.
  assert.strictEqual(farm.termToDays("Rust Twitch Drops Automatic Farming"), 0);
});

test("rent-farm listings are told apart from drops-bundle listings", async () => {
  assert.ok(farm.FARM_TITLE.test("Overwatch Twitch Drops Automatic farming 180 days"));
  assert.ok(!farm.FARM_TITLE.test("Overwatch Twitch Drops (26 Items) OWWC Groups 2026"));
  // parseFarmOrder returns null for a bundle so the caller falls through.
  assert.strictEqual(
    await farm.parseFarmOrder({ orderTitle: "Halo: Campaign Evolved Twitch Drops (1 Item)" }),
    null,
  );
});

test("PlayerAuctions order ids are namespaced away from Eldorado's", () => {
  // Both fulfillers share the FarmServiceOrder collection, whose orderId is
  // globally unique.
  assert.strictEqual(farm.farmOrderKey("16458589"), "pa:16458589");
  assert.notStrictEqual(farm.farmOrderKey("x"), "x");
});

test("storefront game spellings resolve onto names the farm knows", async () => {
  const known = ["Overwatch", "Rainbow Six Siege", "Call of Duty", "Fortnite"];
  assert.strictEqual(
    await farm.canonicalGame("Tom Clancys Rainbow Six Siege", known),
    "Rainbow Six Siege",
  );
  assert.strictEqual(await farm.canonicalGame("Overwatch 2", known), "Overwatch");
  assert.strictEqual(
    await farm.canonicalGame("Call of Duty - Warzone / BO7 & All Legacy Versions", known),
    "Call of Duty",
  );
  assert.strictEqual(await farm.canonicalGame("Fortnight", known), "Fortnite");
  // A game the farm has never seen must resolve to "" so the order is refused
  // rather than provisioned against the wrong game.
  assert.strictEqual(await farm.canonicalGame("Some Unknown Game", known), "");
});

test("an accented catalogue game resolves from its ASCII offer title", async () => {
  // PlayerAuctions rejects a title that is not plain ASCII, so a game whose
  // real name carries an accent can NEVER be advertised under that name --
  // the farm has to recognise the folded spelling instead. It did not, and
  // six live "Pokmon GO ... Automatic Farming" offers could not resolve their
  // game at all: every one of them would have taken a buyer's money and
  // delivered nothing.
  const known = ["Pok\u00e9mon GO", "MARVEL T\u014cKON: Fighting Souls", "Fortnite"];

  // What the older sanitiser published (the accented letter dropped).
  assert.strictEqual(await farm.canonicalGame("Pokmon GO", known), "Pok\u00e9mon GO");
  // What it publishes now (folded to the base letter).
  assert.strictEqual(await farm.canonicalGame("Pokemon GO", known), "Pok\u00e9mon GO");
  // And the real name, in case a title ever reaches us unfolded.
  assert.strictEqual(await farm.canonicalGame("Pok\u00e9mon GO", known), "Pok\u00e9mon GO");
  // Non-Latin folding, not just Latin-1.
  assert.strictEqual(
    await farm.canonicalGame("MARVEL TOKON: Fighting Souls", known),
    "MARVEL T\u014cKON: Fighting Souls",
  );
  // Folding must not turn an unknown game into a false match.
  assert.strictEqual(await farm.canonicalGame("Pokemon Sleep", known), "");
});

test("PlayerAuctions titles fold accents rather than dropping the letter", () => {
  // "Pokmon" is not a word, and it is what the fulfiller has to read the game
  // back out of.
  assert.strictEqual(
    mp.paSanitizeTitle("Pok\u00e9mon GO Twitch Drops Automatic Farming 1 Year"),
    "Pokemon GO Twitch Drops Automatic Farming 1 Year",
  );
  assert.strictEqual(mp.paSanitizeTitle("MARVEL T\u014cKON"), "MARVEL TOKON");
  // Still ASCII-only afterwards -- the API rejects anything else.
  assert.ok(!/[^\x20-\x7E]/.test(mp.paSanitizeTitle("caf\u00e9 \u2014 na\u00efve \u65e5\u672c")));
});

test("a paid order that cannot ship wakes the operator; a routine skip does not", () => {
  const ff = require("../utils/playerauctionsFulfiller");
  // Two events routinely render the SAME bundle title (game + item count +
  // the first item names, truncated), and six such pairs are live right now.
  // If an order arrives without a recoverable offer id, guessing between them
  // ships an account that does not hold what the buyer paid for -- a dispute
  // AND spent stock. Refusing is correct, but only if it is LOUD.
  assert.ok(ff.alertsOperator('ambiguous listing title -- 2+ listings share "Halo"'));
  assert.ok(ff.alertsOperator('no listing row for "Overwatch Twitch Drops"'));
  assert.ok(ff.alertsOperator("manual-delivery listing"));
  // Routine, self-resolving states must stay quiet or the alert is worthless.
  assert.ok(!ff.alertsOperator("already delivered"));
  assert.ok(!ff.alertsOperator("no stock"));
  assert.ok(!ff.alertsOperator(""));
  assert.ok(!ff.alertsOperator(undefined));
});

/* --------------------------- proof of delivery -------------------------- */

const proof = require("../utils/playerauctionsProof");

test("the delivery proof names the order but never the credential", () => {
  // The image is uploaded to PlayerAuctions and seen by their staff, so it must
  // record that a hand-over happened without leaking the login itself.
  const svg = proof.proofSvg({
    orderId: "16458589",
    offerTitle: "Overwatch Twitch Drops (26 Items)",
    accountCount: 1,
    itemCount: 26,
  });
  assert.match(svg, /16458589/);
  assert.match(svg, /Overwatch Twitch Drops/);
  assert.doesNotMatch(svg, /password/i);
});

test("proof markup escapes offer titles that carry XML metacharacters", () => {
  const svg = proof.proofSvg({
    orderId: "1",
    offerTitle: 'Call of Duty <Warzone> & "Legacy"',
    accountCount: 1,
  });
  assert.doesNotMatch(svg, /<Warzone>/);
  assert.match(svg, /&lt;Warzone&gt;/);
  assert.match(svg, /&amp;/);
});

/* ----------------------------- game mapping ---------------------------- */

test("our campaign game names resolve onto PlayerAuctions' storefront names", async () => {
  // Our names come from Twitch campaign data and are usually MORE specific than
  // the storefront's, so exact matching alone resolved barely half the shelf:
  // "NBA 2K27", "Call of Duty: Modern Warfare 4" and "Hunt: Showdown 1896" all
  // missed, and three real listings were silently skipped as "no such game".
  const games = await mp.playerauctionsGames().catch(() => []);
  if (!games.length) return; // offline
  const cases = [
    ["NBA 2K27", "NBA 2K"],
    ["Call of Duty: Modern Warfare 4", "Call of Duty - Warzone / BO7 & All Legacy Versions"],
    ["Call of Duty: Black Ops 7", "Call of Duty - Warzone / BO7 & All Legacy Versions"],
    ["Hunt: Showdown 1896", "Hunt: Showdown"],
    ["Overwatch 2", "Overwatch"],
    ["Halo: Campaign Evolved", "Halo Infinite"],
    ["Metin2", "Metin 2"],
  ];
  for (const [ours, theirs] of cases) {
    const g = await mp.playerauctionsResolveGame(ours);
    assert.ok(g, `${ours} resolved to nothing`);
    assert.strictEqual(g.gameName.trim(), theirs, `${ours} resolved to ${g.gameName}`);
  }
  // A game that genuinely is not on PlayerAuctions must stay null rather than
  // fuzzy-matching onto something unrelated.
  assert.strictEqual(
    await mp.playerauctionsResolveGame("Assassin's Creed Black Flag Resynced"),
    null,
  );
});

test("a drops bundle is never filed under currency or raw materials", async () => {
  // The first real publish run filed Fortnite under "Ore > Copper Ore" and
  // NBA 2K under "VC > 15000 VC". Both were ACCEPTED by the API and both are
  // wrong — a buyer browsing NBA 2K currency should not find a drops bundle.
  const games = await mp.playerauctionsGames().catch(() => []);
  if (!games.length) return; // offline

  // Marvel Rivals has a literal "Twitch Drops" category; it must win outright.
  const mr = await mp.playerauctionsPickItemPath(14147);
  assert.ok(mr && /twitch/i.test(mr.rootName), "Marvel Rivals should use its Twitch Drops category");

  // Overwatch and Call of Duty must land where the hand-made live offers are.
  assert.strictEqual((await mp.playerauctionsPickItemPath(7097)).itemPath, "1653|8305");
  assert.strictEqual((await mp.playerauctionsPickItemPath(7313)).itemName, "Other Bundles");

  // Fortnite has no generic leaf, but Skins is still the right ROOT — and it
  // must not fall back to the Ore/Weapons roots that come before it.
  const fn = await mp.playerauctionsPickItemPath(7876);
  assert.ok(fn && /skin/i.test(fn.rootName), "Fortnite should file under Skins, got " + (fn && fn.rootName));

  // A currency-only tree and a sentinel-only tree must both REFUSE.
  assert.strictEqual(await mp.playerauctionsPickItemPath(10063), null, "NBA 2K is VC-only");
  assert.strictEqual(await mp.playerauctionsPickItemPath(13444), null, "Palia has only the -1 sentinel");
});

test("the delivery guarantee falls back to what the game actually offers", async () => {
  const games = await mp.playerauctionsGames().catch(() => []);
  if (!games.length) return;
  // Overwatch has the 20-minute tier; Marvel Rivals and Palia do not, and
  // sending customId 5 there is rejected outright.
  assert.strictEqual(await mp.playerauctionsResolveDelivery(7097, mp.PA_DELIVERY.min20), 5);
  const mr = await mp.playerauctionsResolveDelivery(14147, mp.PA_DELIVERY.min20);
  assert.notStrictEqual(mr, 5);
  assert.strictEqual(mr, mp.PA_DELIVERY.hour1);
});

test("item-only product gating is enforced per game", async () => {
  // Only 149 of PlayerAuctions' ~400 games accept Item offers. Publishing a
  // bundle for an account-only game is rejected by the API, so the publisher
  // has to know before it spends a write.
  const games = await mp.playerauctionsGames().catch(() => []);
  if (!games.length) return; // offline: the network guard below still applies
  const ow = games.find((g) => g.gameName === "Overwatch");
  const r6 = games.find((g) => /Rainbow Six/i.test(g.gameName));
  if (ow) assert.match(ow.productType, /item/);
  if (r6) assert.doesNotMatch(r6.productType, /item/);
});
