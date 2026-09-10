const test = require("node:test");
const assert = require("node:assert");

const { sanitize, actorFromReq, logEvent } = require("../utils/systemLog");
const auditRequest = require("../middleware/auditRequest");
const SystemEvent = require("../models/SystemEvent");

test("sanitize redacts secret-looking keys at any depth", () => {
  const out = sanitize({
    login: "bob",
    password: "hunter2",
    clientSecret: "x",
    api_key: "k",
    nested: { token: "t", ok: 1 },
  });
  assert.equal(out.login, "bob");
  assert.equal(out.password, "[redacted]");
  assert.equal(out.clientSecret, "[redacted]");
  assert.equal(out.api_key, "[redacted]");
  assert.equal(out.nested.token, "[redacted]");
  assert.equal(out.nested.ok, 1);
});

test("sanitize caps long strings and long arrays", () => {
  assert.ok(sanitize("a".repeat(1000)).length < 1000);
  assert.ok(sanitize(new Array(200).fill(1)).length <= 50);
});

test("actorFromReq reads whichever tenant session is present", () => {
  assert.equal(actorFromReq({ session: { admin: { id: "42" } } }), "admin:42");
  assert.equal(actorFromReq({ session: { renter: { id: "9" } } }), "renter:9");
  assert.equal(
    actorFromReq({ session: { reseller: { id: "7" } } }),
    "reseller:7",
  );
  assert.equal(actorFromReq({ session: {} }), "anon");
  assert.equal(actorFromReq({}), "anon");
});

test("logEvent never throws even when the DB write fails", async () => {
  const orig = SystemEvent.create;
  SystemEvent.create = () => Promise.reject(new Error("db down"));
  try {
    await logEvent({ category: "test", action: "x" }); // must resolve, not reject
  } finally {
    SystemEvent.create = orig;
  }
});

test("logEvent ignores empty events without touching the DB", async () => {
  let called = false;
  const orig = SystemEvent.create;
  SystemEvent.create = () => {
    called = true;
    return Promise.resolve();
  };
  try {
    await logEvent({});
    assert.equal(called, false);
  } finally {
    SystemEvent.create = orig;
  }
});

test("logEvent redacts secrets in meta before persistence", async () => {
  let saved = null;
  const orig = SystemEvent.create;
  SystemEvent.create = (doc) => {
    saved = doc;
    return Promise.resolve(doc);
  };
  try {
    await logEvent({
      category: "request",
      action: "post",
      meta: { username: "u", password: "p" },
    });
    assert.equal(saved.meta.username, "u");
    assert.equal(saved.meta.password, "[redacted]");
  } finally {
    SystemEvent.create = orig;
  }
});

test("auditRequest skips GET but instruments POST", () => {
  const fakeRes = () => {
    const h = {};
    return { statusCode: 200, on: (ev, fn) => (h[ev] = fn), _h: h };
  };
  let nextCalls = 0;
  const next = () => nextCalls++;

  const getRes = fakeRes();
  auditRequest({ method: "GET", path: "/foo", session: {} }, getRes, next);
  assert.equal(nextCalls, 1);
  assert.equal(getRes._h.finish, undefined);

  const postRes = fakeRes();
  auditRequest(
    { method: "POST", path: "/foo", session: { admin: { id: "1" } }, body: { a: 1 } },
    postRes,
    next,
  );
  assert.equal(nextCalls, 2);
  assert.equal(typeof postRes._h.finish, "function");
});

test("auditRequest skips asset requests without registering a hook", () => {
  const res = {
    on: () => {
      throw new Error("should not register on an asset request");
    },
  };
  let nexted = false;
  auditRequest(
    { method: "POST", path: "/admin-nav.js", session: {} },
    res,
    () => (nexted = true),
  );
  assert.equal(nexted, true);
});

// ---------------------------------------------------------------------------
// F6 — the pasted account list must never reach SystemEvent.meta.
//
// public/listings.html POSTs the whole supplied-stock paste as
// { accounts: "<login:password:token:email>" }. express.json parses it, then
// auditRequest summarizes EVERY mutating body before the router runs — so the
// row was written on a 403 and a 500 too, and public/activity.html renders meta
// verbatim for the full 90-day TTL. models/SystemEvent.js:28 is explicit that
// meta is NEVER a secret. Same house rule as tests/marketplaceLog.test.js: the
// failure is SILENT (a leaked row looks exactly like a good one on the page),
// so only a test can tell the difference.
const PASTE =
  "dropfarm_x91:Tr0ub4dor&3:kunuxa5qz9mybot:dropfarm_x91@mail.tm\n" +
  "dropfarm_x92:c0rrect-horse:zq7v1n4m8kpx:dropfarm_x92@mail.tm";
const SECRETS = [
  "Tr0ub4dor&3",
  "kunuxa5qz9mybot",
  "c0rrect-horse",
  "zq7v1n4m8kpx",
];

function assertNoSecrets(saved) {
  const blob = JSON.stringify(saved || {});
  for (const s of SECRETS)
    assert.ok(!blob.includes(s), "persisted row leaked " + s + ": " + blob);
}

// Drives the REAL middleware end to end (summarizeBody -> logEvent -> the
// model) and hands back the document that would have been persisted.
async function runAudit(body, statusCode = 200) {
  const handlers = {};
  const res = {
    statusCode,
    on: (ev, fn) => (handlers[ev] = fn),
  };
  let saved = null;
  const orig = SystemEvent.create;
  SystemEvent.create = (doc) => {
    saved = doc;
    return Promise.resolve(doc);
  };
  try {
    auditRequest(
      {
        method: "POST",
        path: "/account-offers/68b0/stock",
        session: { admin: { id: "1" } },
        body,
      },
      res,
      () => {},
    );
    handlers.finish();
    // logEvent is fire-and-forget; let its microtasks settle.
    await new Promise((r) => setImmediate(r));
  } finally {
    SystemEvent.create = orig;
  }
  return saved;
}

test("auditRequest never persists a pasted credential list", async () => {
  const saved = await runAudit({ accounts: PASTE });
  assert.ok(saved, "the request should still be audited");
  assert.equal(saved.route, "/account-offers/68b0/stock");
  assert.equal(saved.meta.accounts, "[redacted]");
  assertNoSecrets(saved);
});

test("the paste is redacted on a refused request too (403/500)", async () => {
  for (const status of [403, 500]) {
    const saved = await runAudit({ accounts: PASTE }, status);
    assert.equal(saved.status, status);
    assertNoSecrets(saved);
  }
});

test("a paste under an unlisted key is caught by its SHAPE", async () => {
  // The key-name list can never be complete, so the value-shaped guard is what
  // stops the next route from reintroducing the leak under its own spelling.
  const saved = await runAudit({ whateverField: PASTE, note: "bulk import" });
  assertNoSecrets(saved);
  assert.equal(saved.meta.note, "bulk import");
});

test("sanitize redacts pasted lists by key and by shape", () => {
  const out = sanitize({
    accounts: PASTE,
    text: PASTE,
    badLines: [":Tr0ub4dor&3", "junk"],
    payload: PASTE,
    // A single line, which is what a 40-char body summary leaves behind.
    slice: "dropfarm_x91:Tr0ub4dor&3:kunuxa5qz9mybot:dropf…",
    // G6: the count middleware/auditRequest.js:38 writes for an array body —
    // a string by the time it gets here, and the point of the whole summary.
    lines: "[2]",
    // …but only a BARE count. Text wrapped around one is still a paste.
    paste: "[2] dropfarm_x91:Tr0ub4dor&3",
  });
  assert.equal(out.accounts, "[redacted]");
  assert.equal(out.text, "[redacted]");
  assert.deepEqual(out.badLines, ["[redacted]", "[redacted]"]);
  assert.equal(out.slice, "[redacted]");
  assert.equal(out.lines, "[2]");
  assert.equal(out.paste, "[redacted]");
  assertNoSecrets(out);
});

test("an array body keeps its count and the paste itself stays redacted", async () => {
  // G6 — both halves have to hold at once. auditRequest collapses an array to
  // "[N]" BEFORE logEvent sees it, so the count-preserving branches written for
  // a real array never ran on any route that POSTs `accounts` as an array, and
  // the audit row said "[redacted]" where it should have said how many.
  const saved = await runAudit({ accounts: PASTE.split("\n"), note: "bulk" });
  assert.equal(saved.meta.accounts, "[2]", "the count is what the row is for");
  assert.equal(saved.meta.note, "bulk");
  assertNoSecrets(saved);

  // The half that must NOT move: the F6 leak put a working password in
  // SystemEvent.meta for the 90-day TTL, so a paste — and the 40-char slice
  // this same middleware leaves of one — is still dropped wholesale.
  const blob = await runAudit({ accounts: PASTE });
  assert.equal(blob.meta.accounts, "[redacted]");
  assertNoSecrets(blob);
});

test("the guard leaves ordinary diagnostic meta alone", () => {
  // The audit log's whole value is that it says what changed, so the shapes a
  // summary is actually made of must survive: counts, logins (kept on purpose,
  // they are printed on the listing), URLs, ports, clock times, ISO stamps and
  // prose with a colon in it.
  const out = sanitize({
    accounts: 12,
    added: 3,
    logins: ["dropfarm_x91", "dropfarm_x92"],
    file: "/root/bots/TwitchBotX18/config.json",
    url: "https://www.twitch.tv/drops/inventory",
    host: "192.168.1.40:8080",
    at: "2026-09-10T12:30:00.000Z",
    detail: "error: no such offer",
    ratio: "3:1",
  });
  assert.equal(out.accounts, 12);
  assert.equal(out.added, 3);
  assert.deepEqual(out.logins, ["dropfarm_x91", "dropfarm_x92"]);
  assert.equal(out.file, "/root/bots/TwitchBotX18/config.json");
  assert.equal(out.url, "https://www.twitch.tv/drops/inventory");
  assert.equal(out.host, "192.168.1.40:8080");
  assert.equal(out.at, "2026-09-10T12:30:00.000Z");
  assert.equal(out.detail, "error: no such offer");
  assert.equal(out.ratio, "3:1");
});

test("logEvent applies the shape guard to detail, not to subject", async () => {
  let saved = null;
  const orig = SystemEvent.create;
  SystemEvent.create = (doc) => {
    saved = doc;
    return Promise.resolve(doc);
  };
  try {
    await logEvent({
      category: "listings",
      action: "account_offer_stock_added",
      // A title with a colon in it is a title, not a credential, and it is
      // looked up by exact string — the guard must not touch it.
      subject: "GGSel:RocketLeague",
      detail: "supplied stock added: 3 new, 0 duplicate\n" + PASTE,
    });
    assert.equal(saved.subject, "GGSel:RocketLeague");
    assert.ok(saved.detail.startsWith("supplied stock added: 3 new"));
    assertNoSecrets(saved);
  } finally {
    SystemEvent.create = orig;
  }
});
