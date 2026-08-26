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
