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
  const rows = {
    clean: [{ claimed: false }, { claimed: false }],
    spent: [{ claimed: false }, { claimed: true }],
  };
  const real = DropLog.find;
  DropLog.find = (q) => ({ lean: async () => rows[q.login] || [] });
  try {
    const kept = await fulfiller.unclaimedOnly(set, [{ login: "clean" }, { login: "spent" }]);
    assert.deepStrictEqual(kept.map((c) => c.login), ["clean"]);
  } finally {
    DropLog.find = real;
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
