// The console stores what we SENT to a buyer, and every fulfiller's delivery
// text is literally "Username: <login>\nPassword: <password>". That body is
// rendered verbatim in a <pre> on an admin page, so an unredacted row is a
// credential dump one screenshot from leaving the machine — and unlike a leaked
// row in a log file, this one is indexed, paginated and searchable by design.
//
// Redaction is therefore the load-bearing part of utils/marketplaceLog.js, and
// its failures are all SILENT: a half-masked password still reads as masked, a
// regex metacharacter makes a replace quietly match nothing, and either way the
// row looks fine on the page. Only a test can tell the difference, so every
// numbered rule from the contract's Redaction section has one here.
//
// The other half is the best-effort contract. These calls sit inside delivery
// paths where the buyer's money is already taken (g2gFulfiller's SendBird send,
// playerauctionsFulfiller's handOver). A throw escaping logMarketEvent turns a
// paid order into an undelivered one — the exact class of bug the console was
// built to catch — so a DB failure must come back falsy, never thrown.
const test = require("node:test");
const assert = require("node:assert");

const MarketplaceEvent = require("../models/MarketplaceEvent");
const {
  logMarketEvent,
  redactSecrets,
  orderTrail,
  MASK,
  MAX_MESSAGE,
  MAX_TITLE,
  MAX_ERROR,
  TRAIL_LIMIT,
} = require("../utils/marketplaceLog");

// The real delivery body, in the shape eldoradoDeliveryCode builds it (G2G
// reuses the same function, and PlayerAuctions' credBlock is the compact
// variant). Tests assert against THIS rather than a toy string, because the
// thing that must survive redaction is a message a human can still read.
const DELIVERY = (login, password) =>
  "TWITCH DROP ACCOUNT\n\n" +
  "Username: " + login + "\n" +
  "Password: " + password + "\n\n" +
  "HOW TO CLAIM\n" +
  "1. Log in to this Twitch account and open " +
  "https://www.twitch.tv/drops/inventory\n" +
  '2. Scroll to the "Received" section at the bottom of the page.\n' +
  "Please do not change the account's password or email.";

const masks = (s) => (String(s).match(/••••••••/g) || []).length;

// Swap MarketplaceEvent.create for a collector. Nothing here ever reaches a
// database: these tests must run on a laptop with no Mongo and must never be
// able to touch the live Atlas tier.
async function capture(fn, impl) {
  const written = [];
  const real = MarketplaceEvent.create;
  MarketplaceEvent.create = async (doc) => {
    written.push(doc);
    if (impl) return impl(doc);
    return doc;
  };
  try {
    await fn(written);
  } finally {
    MarketplaceEvent.create = real;
  }
  return written;
}

// logMarketEvent deliberately reports its own failures to the pm2 log, which is
// the fallback record when this collection is the broken thing. Silence it for
// the tests that provoke one, so a green run stays readable.
async function quiet(fn) {
  const real = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = real;
  }
}

// --- 1. every secret we were handed is masked ----------------------------

test("every secret in the list is masked, wherever it appears", () => {
  // A two-account order: PlayerAuctions' numbered credBlock, both passwords
  // handed to the logger.
  const body = "2 accounts:\n1) dave_farm / Sn0wD0g!\n2) sue_farm / Tr33house";
  const out = redactSecrets(body, ["Sn0wD0g!", "Tr33house"]);
  assert.ok(!out.includes("Sn0wD0g!"), "first password survived redaction");
  assert.ok(!out.includes("Tr33house"), "second password survived redaction");
  assert.strictEqual(masks(out), 2);
  // The logins are KEPT on purpose: they are what tells you which account went
  // to which buyer, and they are printed on the listing anyway.
  assert.ok(out.includes("dave_farm") && out.includes("sue_farm"));
});

test("the same password masked at every occurrence, not just the first", () => {
  const out = redactSecrets("pw is Sn0wD0g! and again Sn0wD0g!", ["Sn0wD0g!"]);
  assert.ok(!out.includes("Sn0wD0g!"));
  assert.strictEqual(masks(out), 2);
});

// --- 2. longest first ----------------------------------------------------

test("REGRESSION: a password containing another is never half-masked", () => {
  // The failure this rule exists for. Mask "abc" first and "abc123" becomes
  // "••••••••123": the row LOOKS redacted, the reader sees a mask, and the tail
  // of the password is sitting on the page next to the login — along with the
  // length of what was hidden. Sorting longest-first consumes the long one
  // before its own prefix can be applied.
  const body = "1) dave / abc123\n2) sue / abc";
  const out = redactSecrets(body, ["abc", "abc123"]);
  assert.ok(!out.includes("123"), "the tail of the longer password leaked: " + out);
  assert.strictEqual(out, "1) dave / " + MASK + "\n2) sue / " + MASK);
});

test("longest-first does not depend on the order the caller passes them", () => {
  const body = "one abc123 two abc";
  // Both orderings must land on the same fully-masked string.
  assert.strictEqual(
    redactSecrets(body, ["abc", "abc123"]),
    redactSecrets(body, ["abc123", "abc"]),
  );
  assert.ok(!redactSecrets(body, ["abc123", "abc"]).includes("123"));
});

test("a password that is a prefix of a LONGER one still masks its own line", () => {
  // The mirror case: masking the long one must not leave the short one behind.
  const out = redactSecrets("a: hunter2extra\nb: hunter2", ["hunter2", "hunter2extra"]);
  assert.ok(!out.includes("hunter2"));
  assert.strictEqual(masks(out), 2);
});

// --- 3. regex metacharacters --------------------------------------------

test("a password full of regex metacharacters is escaped, not executed", () => {
  // Real passwords contain these. Dropped unescaped into a RegExp they either
  // throw (an unbalanced "(" is a SyntaxError) or, worse, match something that
  // is not the password and leave the real one in the row — both silent.
  const pw = "a.b*c+d?[e](f)$g^h|i\\j";
  const out = redactSecrets(DELIVERY("dave_farm", pw), [pw]);
  assert.ok(!out.includes(pw), "the metacharacter password survived");
  assert.ok(out.includes("Password: " + MASK));
});

test("an unbalanced bracket in a password does not throw", () => {
  for (const pw of ["pw(1", "pw[1", "pw\\", "a{2,", "*start", "+plus"]) {
    const out = redactSecrets("Password: " + pw, [pw]);
    assert.ok(!out.includes(pw), "leaked " + pw);
  }
});

test("escaping is exact: a metacharacter password matches only itself", () => {
  // Unescaped, "a.c" is a pattern that also matches "abc" — masking text that
  // is NOT the password. That direction is quieter than a leak but just as
  // wrong: it eats the message the console exists to show.
  const out = redactSecrets("abc and a.c", ["a.c"]);
  assert.strictEqual(out, "abc and " + MASK);
});

// --- 4. the belt-and-braces shape pass -----------------------------------

test("a labelled password is masked even when the caller forgets to pass it", () => {
  // Every capture point is a hand-edited call site, so "forgot the secrets
  // array" is the likeliest way a password reaches this collection.
  const out = redactSecrets(DELIVERY("dave_farm", "hunter2"), []);
  assert.ok(!out.includes("hunter2"), "an unlisted password leaked: " + out);
  assert.ok(out.includes("Password: " + MASK));
});

test("the shapes cover the separators and languages actually in use", () => {
  const cases = [
    ["Password: hunter2", "hunter2"],
    ["password=hunter2", "hunter2"],
    ["pass — hunter2", "hunter2"],
    ["pw: hunter2", "hunter2"],
    ["Passwd: hunter2", "hunter2"],
    // GGSel / Plati / FunPay buyers are largely Russian-speaking; a
    // hand-written reply to one says "Пароль:". \b is ASCII-only in JS, which
    // is why this needs its own pattern rather than another alternative.
    ["Пароль: тайна123", "тайна123"],
    ["Пароля - тайна123", "тайна123"],
    // The model forbids tokens and ClientSecrets here too, and a pasted support
    // reply is exactly where one turns up.
    ["token = eyJhbGciOi", "eyJhbGciOi"],
    ["client secret: shhh_value", "shhh_value"],
  ];
  for (const [text, secret] of cases) {
    const out = redactSecrets(text, []);
    assert.ok(!out.includes(secret), text + " -> " + out);
    assert.ok(out.includes(MASK), text + " was not masked at all");
  }
});

test("a short secret below the global floor is still caught when labelled", () => {
  // Secrets under 3 chars are not masked globally — a one-character "password"
  // would blank every matching letter in the message. Nothing real is skipped
  // (Twitch's own minimum is 8), and a labelled one is caught by shape anyway.
  const out = redactSecrets("Password: ab", ["ab"]);
  assert.strictEqual(out, "Password: " + MASK);
});

// --- 5. never so aggressive that the message stops being readable --------

test("the delivery message survives redaction intact apart from the password", () => {
  // The point of storing the body is seeing what the buyer received. A masker
  // that shreds the claim instructions has destroyed the evidence it was meant
  // to preserve.
  const out = redactSecrets(DELIVERY("dave_farm", "hunter2"), ["hunter2"]);
  assert.ok(out.startsWith("TWITCH DROP ACCOUNT"));
  assert.ok(out.includes("Username: dave_farm"));
  assert.ok(out.includes("HOW TO CLAIM"));
  assert.ok(out.includes("https://www.twitch.tv/drops/inventory"));
  assert.ok(out.includes('2. Scroll to the "Received" section'));
  // "password" with no separator after it is prose, not a credential.
  assert.ok(out.includes("do not change the account's password or email"));
  assert.strictEqual(masks(out), 1);
});

test("a bare 'Password:' at end of line does not swallow the next line", () => {
  // With \s instead of [ \t] around the separator, the value token would be the
  // first word of the NEXT line — here the heading the buyer needs.
  const out = redactSecrets("Password:\nHOW TO CLAIM\n1. Log in", []);
  assert.ok(out.includes("HOW TO CLAIM"), "the next line was eaten: " + out);
});

test("a hyphenated word is not mistaken for a credential separator", () => {
  const text = "the account is password-protected, pass-through is off";
  assert.strictEqual(redactSecrets(text, []), text);
});

test("case-insensitive only once a secret is long enough to be unambiguous", () => {
  // Long: a fulfiller that re-typed the password in a different case must still
  // be caught.
  const out = redactSecrets("sent HUNTER2PASS today", ["hunter2pass"]);
  assert.ok(!/hunter2pass/i.test(out));
  // Short: a 3-letter case-insensitive match would eat words out of the claim
  // guide. "log" must not blank "Log in to this Twitch account".
  const guide = redactSecrets(DELIVERY("dave_farm", "hunter2"), ["log"]);
  assert.ok(guide.includes("Log in to this Twitch account"));
});

// --- 6. degenerate input -------------------------------------------------

test("empty, null and undefined input do not throw", () => {
  assert.strictEqual(redactSecrets(null, ["hunter2"]), "");
  assert.strictEqual(redactSecrets(undefined, ["hunter2"]), "");
  assert.strictEqual(redactSecrets("", ["hunter2"]), "");
  assert.strictEqual(redactSecrets("plain text", []), "plain text");
  assert.strictEqual(redactSecrets("plain text", null), "plain text");
  assert.strictEqual(redactSecrets("plain text", undefined), "plain text");
});

test("a junk secrets list is tolerated rather than fatal", () => {
  // A logging helper that throws on a null inside an array would take a
  // delivery down with it.
  const out = redactSecrets("keep hunter2", ["hunter2", null, undefined, "", 42, {}]);
  assert.ok(!out.includes("hunter2"));
  // A single string instead of an array is the obvious call-site slip.
  assert.ok(!redactSecrets("keep hunter2", "hunter2").includes("hunter2"));
});

// --- logMarketEvent: the write is best-effort -----------------------------

test("REGRESSION: a rejected write never reaches the delivery path", async () => {
  // The whole contract in one test. Money is already taken by the time a
  // fulfiller calls this; if a validation error or a Mongo hiccup could
  // propagate, an audit row would cost a buyer their order.
  await quiet(async () => {
    const real = MarketplaceEvent.create;
    MarketplaceEvent.create = async () => {
      throw new Error("E11000 / no primary / whatever Atlas is doing today");
    };
    try {
      let result;
      await assert.doesNotReject(async () => {
        result = await logMarketEvent({
          market: "g2g",
          kind: "message_sent",
          orderId: "1788892037419NTQU",
        });
      });
      assert.ok(!result, "a failed write must return falsy, got " + result);
    } finally {
      MarketplaceEvent.create = real;
    }
  });
});

test("a synchronous throw inside create is swallowed too", async () => {
  await quiet(async () => {
    const real = MarketplaceEvent.create;
    MarketplaceEvent.create = () => {
      throw new TypeError("model not registered");
    };
    try {
      assert.ok(!(await logMarketEvent({ market: "g2g", kind: "sold" })));
    } finally {
      MarketplaceEvent.create = real;
    }
  });
});

test("garbage input is dropped, not thrown", async () => {
  await quiet(async () => {
    const written = await capture(async () => {
      assert.ok(!(await logMarketEvent()));
      assert.ok(!(await logMarketEvent(null)));
      assert.ok(!(await logMarketEvent("sold")));
      // No market means no tab can ever render it: a miswired call site.
      assert.ok(!(await logMarketEvent({ kind: "sold" })));
    });
    assert.strictEqual(written.length, 0);
  });
});

// --- logMarketEvent: what actually gets stored ---------------------------

test("the message is stored redacted and the secrets are not stored at all", async () => {
  const written = await capture(async () => {
    const ok = await logMarketEvent({
      market: "PlayerAuctions",
      kind: "message_sent",
      actor: "playerauctions-fulfiller",
      orderId: "16474028",
      channel: "order-message",
      accounts: ["dave_farm"],
      message: DELIVERY("dave_farm", "hunter2"),
      secrets: ["hunter2"],
      ok: true,
    });
    assert.strictEqual(ok, true);
  });
  assert.strictEqual(written.length, 1);
  const doc = written[0];
  assert.ok(!JSON.stringify(doc).includes("hunter2"), "a password reached the document");
  assert.strictEqual(doc.secrets, undefined, "the secrets array must never be stored");
  assert.ok(doc.message.includes("Password: " + MASK));
  assert.deepStrictEqual(doc.accounts, ["dave_farm"]);
  // Normalised for the {market, at, _id} index; the order id is not.
  assert.strictEqual(doc.market, "playerauctions");
  assert.strictEqual(doc.orderId, "16474028");
  assert.strictEqual(doc.ok, true);
});

test("the order id is stored byte for byte as the marketplace writes it", async () => {
  // It is what the owner pastes out of a buyer's complaint into the trail view.
  // Lowercasing G2G's id would leave the row unfindable by the only string
  // anyone has.
  const written = await capture(() =>
    logMarketEvent({ market: "g2g", kind: "sold", orderId: "1788892037419NTQU" }),
  );
  assert.strictEqual(written[0].orderId, "1788892037419NTQU");
});

test("a login accidentally passed as 'login:password' is still redacted", async () => {
  // funpayFulfiller's deliverable is that single line, so a call site pushing
  // "what I sent" into `accounts` is a plausible slip — and accounts is printed
  // straight onto the page.
  const written = await capture(() =>
    logMarketEvent({
      market: "funpay",
      kind: "delivered",
      accounts: ["dave_farm:hunter2"],
      secrets: ["hunter2"],
    }),
  );
  assert.ok(!written[0].accounts[0].includes("hunter2"));
  assert.ok(written[0].accounts[0].startsWith("dave_farm:"));
});

test("meta values are swept as well as meta keys", async () => {
  // systemLog.sanitize redacts secret-LOOKING KEYS; a password stored under a
  // harmless key ("line", "body") walks straight past a key-based filter.
  const written = await capture(() =>
    logMarketEvent({
      market: "eldorado",
      kind: "error",
      meta: { line: "Password: hunter2", nested: { sent: "hunter2" } },
      secrets: ["hunter2"],
    }),
  );
  assert.ok(!JSON.stringify(written[0].meta).includes("hunter2"));
});

test("z2u is dropped silently — no capture, no tab", async () => {
  // Contract rule 6. Silently, because the Z2U bridge sweeps on a timer and an
  // error line per pass would be a permanent false alarm in the pm2 log.
  const written = await capture(async () => {
    assert.ok(!(await logMarketEvent({ market: "z2u", kind: "sold", orderId: "1" })));
    assert.ok(!(await logMarketEvent({ market: "Z2U", kind: "sold", orderId: "2" })));
    assert.ok(!(await logMarketEvent({ market: " z2u ", kind: "sold", orderId: "3" })));
  });
  assert.strictEqual(written.length, 0, "a z2u row was written");
});

test("an unknown marketplace is still recorded", async () => {
  // The model takes a plain String on purpose: a row filed under a name nobody
  // expected is visible and fixable, a row that never existed is not.
  const written = await capture(() =>
    logMarketEvent({ market: "SomeNewMarket", kind: "sold" }),
  );
  assert.strictEqual(written[0].market, "somenewmarket");
});

test("long strings are truncated here rather than rejected by the schema", async () => {
  // maxlength alone REJECTS the save, and a rejected save in a best-effort
  // logger is a silently lost row. Losing the tail of a message beats losing
  // the record that the message was ever sent.
  const written = await capture(() =>
    logMarketEvent({
      market: "g2g",
      kind: "error",
      title: "T".repeat(500),
      message: "M".repeat(5000),
      error: "E".repeat(2000),
    }),
  );
  const doc = written[0];
  assert.strictEqual(doc.title.length, MAX_TITLE);
  assert.strictEqual(doc.message.length, MAX_MESSAGE);
  assert.strictEqual(doc.error.length, MAX_ERROR);
  // The ellipsis is how a reader tells a cut message from a short one.
  assert.ok(doc.message.endsWith("…"));
});

test("ok is left undefined unless the caller actually asserts an outcome", async () => {
  // G2G's sendUserMessage resolved happily on messages that never arrived,
  // which is why __g2gChatDropped exists. A row defaulting to ok:true would
  // render an unverified send as a confirmed delivery on the very page built to
  // catch that.
  const written = await capture(async () => {
    await logMarketEvent({ market: "g2g", kind: "listed" });
    await logMarketEvent({ market: "g2g", kind: "message_sent", ok: false });
    await logMarketEvent({ market: "g2g", kind: "message_sent", ok: "yes" });
  });
  assert.strictEqual("ok" in written[0], false, "a row with nothing to assert got an ok");
  assert.strictEqual(written[1].ok, false);
  assert.strictEqual("ok" in written[2], false, "a non-boolean ok must not be coerced true");
});

test("severity falls to error when the row is one, and never to junk", async () => {
  const written = await capture(async () => {
    await logMarketEvent({ market: "g2g", kind: "error" });
    await logMarketEvent({ market: "g2g", kind: "sold", error: "chat send failed" });
    await logMarketEvent({ market: "g2g", kind: "sold", severity: "CRITICAL" });
    await logMarketEvent({ market: "g2g", kind: "sold", severity: "Warn" });
  });
  assert.strictEqual(written[0].severity, "error");
  assert.strictEqual(written[1].severity, "error");
  // severity IS an enum on the schema, so an unknown value would reject the
  // save and lose the row.
  assert.strictEqual(written[2].severity, "info");
  assert.strictEqual(written[3].severity, "warn");
});

test("qty is ACCOUNTS, stored exactly as handed over", async () => {
  // Order 16474028 shipped eleven accounts for a $5 sale because a count from
  // one place was reused as a count of another (tests/paQuantity.test.js). A
  // log that recomputed qty from what it was given could not show that
  // mismatch — so qty passes through untouched, and disagreeing with
  // accounts.length is exactly the signal the console is for.
  const written = await capture(() =>
    logMarketEvent({
      market: "playerauctions",
      kind: "sold",
      qty: 1,
      paidUsd: 5,
      accounts: ["a1", "a2", "a3"],
    }),
  );
  assert.strictEqual(written[0].qty, 1);
  assert.strictEqual(written[0].accounts.length, 3);
});

test("an unparseable listing id is dropped instead of rejecting the row", async () => {
  // A CastError inside create() would reject the whole document over a field
  // nothing needs. The trail is worth more than the listing link.
  const written = await capture(async () => {
    await logMarketEvent({ market: "g2g", kind: "sold", listing: "not-an-objectid" });
    await logMarketEvent({
      market: "g2g",
      kind: "sold",
      listing: "aaaaaaaaaaaaaaaaaaaaaaaa",
    });
  });
  assert.strictEqual(written[0].listing, undefined);
  assert.strictEqual(written[1].listing, "aaaaaaaaaaaaaaaaaaaaaaaa");
});

// --- orderTrail ----------------------------------------------------------

function stubFind() {
  const calls = [];
  const real = MarketplaceEvent.find;
  MarketplaceEvent.find = (filter, projection) => {
    const call = { filter, projection };
    calls.push(call);
    const chain = {
      sort: (s) => ((call.sort = s), chain),
      limit: (n) => ((call.limit = n), chain),
      lean: async () => [],
    };
    return chain;
  };
  return { calls, restore: () => (MarketplaceEvent.find = real) };
}

test("orderTrail reads one order, oldest first, capped and projected narrow", async () => {
  const { calls, restore } = stubFind();
  try {
    await orderTrail("16474028");
  } finally {
    restore();
  }
  assert.strictEqual(calls.length, 1);
  const [call] = calls;
  assert.deepStrictEqual(call.filter, { orderId: "16474028" });
  // order_seen -> sold -> message_sent -> delivered is the whole point of the
  // view; newest-first would read the story backwards.
  assert.strictEqual(call.sort.at, 1);
  assert.strictEqual(call.limit, TRAIL_LIMIT);
  // 200 rows carrying a 2000-char message each is ~400KB on a bytes-bound Atlas
  // shared tier, so the projection is not cosmetic. `listing` is not in it.
  assert.ok(call.projection && call.projection.message === 1);
  assert.strictEqual(call.projection.listing, undefined);
});

test("orderTrail never exceeds the hard cap, whatever it is asked for", async () => {
  const { calls, restore } = stubFind();
  try {
    await orderTrail("16474028", { limit: 5000 });
    await orderTrail("16474028", { limit: 0 });
    await orderTrail("16474028", { limit: "10" });
  } finally {
    restore();
  }
  assert.strictEqual(calls[0].limit, TRAIL_LIMIT);
  assert.strictEqual(calls[1].limit, TRAIL_LIMIT);
  assert.strictEqual(calls[2].limit, 10);
});

test("orderTrail refuses a blank id instead of scanning the collection", async () => {
  // {orderId: ""} matches every row that never carried one — an unbounded scan
  // dressed up as a lookup, on the tier that can least afford it.
  const { calls, restore } = stubFind();
  try {
    for (const id of ["", null, undefined]) {
      assert.deepStrictEqual(await orderTrail(id), []);
    }
  } finally {
    restore();
  }
  assert.strictEqual(calls.length, 0, "a blank order id reached Mongo");
});
