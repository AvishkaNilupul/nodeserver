// Unit tests for the external account API's building blocks that don't need a
// live Mongo connection: the regex-safe username matching + token-priority
// helpers (utils/accountLookup) and the bearer-token guard (middleware/
// apiToken). The DB-backed lookupAccountByUsername path is covered by manual
// smoke testing against a real database.

// Make config load hermetically: set the vars it requires BEFORE anything pulls
// it in (dotenv does not overwrite already-set process.env values).
process.env.ADMIN_KEY = process.env.ADMIN_KEY || "test-admin-key";
process.env.MONGO_URI = process.env.MONGO_URI || "mongodb://localhost/test";
process.env.ACCOUNT_API_TOKEN = "test-token-abc123";

const test = require("node:test");
const assert = require("node:assert");

const {
  escapeRegex,
  exactCI,
  pickPrimary,
} = require("../utils/accountLookup");
const {
  safeEqual,
  extractBearer,
  requireApiToken,
} = require("../middleware/apiToken");

test("escapeRegex neutralises regex metacharacters", () => {
  assert.strictEqual(escapeRegex("a.b*c"), "a\\.b\\*c");
  // A crafted username can't turn into a wildcard.
  const re = exactCI("a.b");
  assert.ok(re.test("a.b"));
  assert.ok(!re.test("axb"), "the '.' must be literal, not any-char");
});

test("exactCI matches only the exact login, case-insensitively", () => {
  const re = exactCI("CoolUser");
  assert.ok(re.test("cooluser"));
  assert.ok(re.test("COOLUSER"));
  assert.ok(!re.test("cooluser2"));
  assert.ok(!re.test("xcooluser"));
});

test("pickPrimary prefers the highest-priority source with a token", () => {
  const sources = [
    { source: "unclaimed", clientToken: "tok-unclaimed" },
    { source: "pool", clientToken: "tok-pool" },
    { source: "bot", clientToken: "tok-bot" },
  ];
  const { clientToken, primarySource } = pickPrimary(sources);
  assert.strictEqual(primarySource, "bot");
  assert.strictEqual(clientToken, "tok-bot");
});

test("pickPrimary skips a higher-priority source that has no token", () => {
  const sources = [
    { source: "bot", clientToken: "" }, // deployed row with no token yet
    { source: "pool", clientToken: "tok-pool" },
  ];
  const { clientToken, primarySource } = pickPrimary(sources);
  assert.strictEqual(primarySource, "pool");
  assert.strictEqual(clientToken, "tok-pool");
});

test("pickPrimary returns empty when nothing has a token", () => {
  const { clientToken, primarySource } = pickPrimary([
    { source: "bot", clientToken: "" },
  ]);
  assert.strictEqual(clientToken, "");
  assert.strictEqual(primarySource, "");
});

test("safeEqual is correct for equal, unequal, and different-length inputs", () => {
  assert.ok(safeEqual("abc", "abc"));
  assert.ok(!safeEqual("abc", "abd"));
  assert.ok(!safeEqual("abc", "abcd"));
  assert.ok(!safeEqual("", "x"));
});

test("extractBearer reads the Authorization header (case-insensitive)", () => {
  assert.strictEqual(
    extractBearer({ headers: { authorization: "Bearer xyz" }, query: {} }),
    "xyz",
  );
  assert.strictEqual(
    extractBearer({ headers: { authorization: "bearer  spaced " }, query: {} }),
    "spaced",
  );
  assert.strictEqual(
    extractBearer({ headers: {}, query: { api_token: "fromquery" } }),
    "fromquery",
  );
  assert.strictEqual(extractBearer({ headers: {}, query: {} }), "");
});

// Minimal res double capturing status()/json().
function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test("requireApiToken rejects a missing token with 401", () => {
  const res = mockRes();
  let nexted = false;
  requireApiToken({ headers: {}, query: {} }, res, () => {
    nexted = true;
  });
  assert.strictEqual(nexted, false);
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.body.code, "unauthorized");
});

test("requireApiToken rejects a wrong token with 401", () => {
  const res = mockRes();
  requireApiToken(
    { headers: { authorization: "Bearer wrong" }, query: {} },
    res,
    () => {},
  );
  assert.strictEqual(res.statusCode, 401);
});

test("requireApiToken calls next() for the correct token", () => {
  const res = mockRes();
  let nexted = false;
  requireApiToken(
    { headers: { authorization: "Bearer test-token-abc123" }, query: {} },
    res,
    () => {
      nexted = true;
    },
  );
  assert.strictEqual(nexted, true);
  assert.strictEqual(res.statusCode, 200);
});

test("requireApiToken returns 503 when the API token is not configured", () => {
  const config = require("../config/config");
  const saved = config.ACCOUNT_API_TOKEN;
  config.ACCOUNT_API_TOKEN = "";
  try {
    const res = mockRes();
    requireApiToken(
      { headers: { authorization: "Bearer test-token-abc123" }, query: {} },
      res,
      () => {},
    );
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.code, "api_disabled");
  } finally {
    config.ACCOUNT_API_TOKEN = saved;
  }
});
