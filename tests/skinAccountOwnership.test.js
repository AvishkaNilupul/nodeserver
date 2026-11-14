const test = require("node:test");
const assert = require("node:assert/strict");
const { createAuditor, _internals } = require("../utils/skinAccountOwnership");
const BOT_ID = "aaaaaaaaaaaaaaaaaaaaaaaa",
  POOL_ID = "bbbbbbbbbbbbbbbbbbbbbbbb";
const bot = {
  _id: BOT_ID,
  login: "test_viewer",
  twitchId: "12345",
  soldAt: null,
  soldPurchaseId: "",
  soldBulkOrderId: "",
  resellerId: "",
};
const pool = {
  _id: POOL_ID,
  username: "test_viewer",
  usernameLower: "test_viewer",
  twitchId: "12345",
  manualSold: false,
  soldGames: [],
  usageHistory: [],
};
const names = [
  "SuppliedAccount",
  "UnclaimedAccount",
  "Purchase",
  "BulkOrder",
  "MarketplaceListing",
];

function valuesAt(value, path) {
  if (Array.isArray(value)) return value.flatMap((v) => valuesAt(v, path));
  if (!path.length) return [value];
  return value == null ? [] : valuesAt(value[path[0]], path.slice(1));
}
function matchValue(actual, expected) {
  if (expected instanceof RegExp)
    return typeof actual === "string" && expected.test(actual);
  if (expected && expected.$in)
    return expected.$in.some((v) => String(actual) === String(v));
  return String(actual) === String(expected);
}
function matches(row, query) {
  return Object.entries(query).every(([key, value]) =>
    key === "$or"
      ? value.some((q) => matches(row, q))
      : valuesAt(row, key.split(".")).some((v) => matchValue(v, value)),
  );
}
function setup(records = {}, options = {}) {
  const reads = [];
  const models = Object.fromEntries(
    names.map((name) => [
      name,
      {
        findOne(filter) {
          const read = { name, filter };
          reads.push(read);
          return {
            select(projection) {
              read.projection = projection;
              return this;
            },
            maxTimeMS(ms) {
              read.maxTimeMS = ms;
              return this;
            },
            lean() {
              read.lean = true;
              return this;
            },
            async exec() {
              if (options.error === name)
                throw new Error(
                  "Database error with buyer@example.invalid private-token-marker",
                );
              const found = (records[name] || []).find((r) =>
                matches(r, filter),
              );
              return found ? { _id: found._id || "history-row" } : null;
            },
          };
        },
      },
    ]),
  );
  return {
    ...createAuditor({ models, maxQueryMs: options.maxQueryMs }),
    reads,
  };
}
function reviewError(error, label) {
  assert.equal(error.user, true);
  assert.equal(error.status, 409);
  assert.match(error.message, /review its history before enrollment/);
  if (label) assert.match(error.message, new RegExp(label));
  assert.doesNotMatch(
    error.message,
    /buyer@example|private-token|buyer-name|order-secret/,
  );
  return true;
}

test("a clean pair passes bounded identity reads without reading private record fields", async () => {
  const audit = setup();
  assert.equal(await audit.assertUnspent(bot, pool), true);
  assert.equal(audit.reads.length, 10);
  for (const read of audit.reads) {
    assert.deepEqual(read.projection, { _id: 1 });
    assert.equal(read.maxTimeMS, 3000);
    assert.equal(read.lean, true);
    assert.doesNotMatch(
      JSON.stringify(read.filter),
      /status|refundedAt|active|deliveredAt|password|clientSecret|buyer/,
    );
  }
});

test("supplied stock blocks in every state, even removed or available", async () => {
  for (const status of ["available", "fed", "sold", "removed"]) {
    const audit = setup({
      SuppliedAccount: [
        { loginLower: "test_viewer", status, password: "private-token-marker" },
      ],
    });
    await assert.rejects(
      () => audit.assertUnspent(bot, pool),
      (e) => reviewError(e, "supplied-account stock"),
    );
    assert.equal(
      audit.reads.filter((r) => r.name === "SuppliedAccount").length,
      1,
      "direct mirror hit avoids legacy read",
    );
  }
});

test("legacy supplied logins match case-insensitively without a lowercased mirror", async () => {
  await assert.rejects(
    () =>
      setup({
        SuppliedAccount: [{ login: "TEST_VIEWER", status: "removed" }],
      }).assertUnspent(bot, pool),
    reviewError,
  );
});

test("unclaimed history blocks after sold flags are reset, for every ledger state", async () => {
  for (const status of [
    "listed",
    "sold",
    "expired",
    "released",
    "skipped",
    "removed",
    "manual",
  ]) {
    await assert.rejects(
      () =>
        setup({
          UnclaimedAccount: [
            { poolAccountId: POOL_ID, login: "old_name", status },
          ],
        }).assertUnspent(bot, pool),
      (e) => reviewError(e, "unclaimed-account ledger"),
    );
  }
  await assert.rejects(
    () =>
      setup({
        UnclaimedAccount: [{ twitchId: "12345", login: "older_name" }],
      }).assertUnspent(bot, pool),
    reviewError,
  );
});

test("refunded purchases still prove prior handover through account ID", async () => {
  await assert.rejects(
    () =>
      setup({
        Purchase: [
          {
            account: BOT_ID,
            accountLogin: "old_name",
            refundedAt: new Date(),
            buyerUsername: "buyer-name",
          },
        ],
      }).assertUnspent(bot, pool),
    (e) => reviewError(e, "shop purchase"),
  );
});

test("purchase login remains evidence after the inventory record ID changed", async () => {
  await assert.rejects(
    () =>
      setup({
        Purchase: [
          {
            account: "cccccccccccccccccccccccc",
            accountLogin: "TEST_VIEWER",
            refundedAt: new Date(),
          },
        ],
      }).assertUnspent(bot, pool),
    reviewError,
  );
});

test("closed bulk orders and inactive replaced units retain whole-account history", async () => {
  for (const unit of [
    {
      account: BOT_ID,
      accountLogin: "old_name",
      active: false,
      replacedAt: new Date(),
    },
    {
      account: "cccccccccccccccccccccccc",
      accountLogin: "TEST_VIEWER",
      active: false,
    },
    {
      account: "cccccccccccccccccccccccc",
      accountLogin: "replacement",
      replacedFromLogin: "test_viewer",
    },
    {
      account: "cccccccccccccccccccccccc",
      accountLogin: "original",
      replacedByLogin: "TEST_VIEWER",
    },
  ])
    await assert.rejects(
      () =>
        setup({
          BulkOrder: [
            { status: "closed", units: [unit], accessToken: "order-secret" },
          ],
        }).assertUnspent(bot, pool),
      (e) => reviewError(e, "bulk order"),
    );
});

test("bulk candidate scope alone is not evidence that the account was ever handed over", async () => {
  assert.equal(
    await setup({
      BulkOrder: [
        {
          accountScopeIds: [BOT_ID],
          accountScopeLogins: ["test_viewer"],
          units: [],
        },
      ],
    }).assertUnspent(bot, pool),
    true,
  );
});

test("all marketplace identity fields block across every historical state", async () => {
  const references = [
    { accountId: BOT_ID },
    { accountLogin: "TEST_VIEWER" },
    { units: [{ accountId: POOL_ID }] },
    { units: [{ login: "TEST_VIEWER" }] },
    { rentFarmPoolId: POOL_ID },
  ];
  for (const status of ["active", "sold", "delisted", "error", "removed"])
    for (const reference of references) {
      await assert.rejects(
        () =>
          setup({
            MarketplaceListing: [{ ...reference, status }],
          }).assertUnspent(bot, pool),
        (e) => reviewError(e, "marketplace listing"),
      );
    }
});

test("legacy packed marketplace logins and IDs match complete tokens at all positions", async () => {
  for (const accountLogin of [
    "TEST_VIEWER, another",
    "another, TEST_VIEWER",
    "first, TEST_VIEWER, last",
    "first\ttest_viewer\nlast",
  ]) {
    await assert.rejects(
      () =>
        setup({
          MarketplaceListing: [{ accountLogin, status: "removed" }],
        }).assertUnspent(bot, pool),
      reviewError,
    );
  }
  for (const accountId of [
    BOT_ID + ",cccccccccccccccccccccccc",
    "cccccccccccccccccccccccc, " + POOL_ID,
  ]) {
    await assert.rejects(
      () =>
        setup({
          MarketplaceListing: [{ accountId, status: "removed" }],
        }).assertUnspent(bot, pool),
      reviewError,
    );
  }
});

test("login substrings and unrelated identities never block the candidate", async () => {
  const audit = setup({
    SuppliedAccount: [{ login: "prefix_test_viewer_suffix" }],
    UnclaimedAccount: [{ loginLower: "test_viewer2", twitchId: "123456" }],
    Purchase: [{ accountLogin: "test_viewer_extra" }],
    BulkOrder: [{ units: [{ accountLogin: "not_test_viewer" }] }],
    MarketplaceListing: [
      {
        accountLogin: "other, test_viewer2, prefix_test_viewer",
        accountId: BOT_ID + "extra",
        units: [{ login: "test_viewer_extra" }],
      },
    ],
  });
  assert.equal(await audit.assertUnspent(bot, pool), true);
});

test("missing and inconsistent identity fail before any database read", async () => {
  const audit = setup();
  for (const [b, p] of [
    [null, pool],
    [bot, null],
    [{ ...bot, twitchId: "" }, pool],
    [bot, { ...pool, twitchId: "999" }],
    [bot, { ...pool, usernameLower: "other" }],
    [{ ...bot, login: "test.*" }, pool],
  ]) {
    await assert.rejects(
      () => audit.assertUnspent(b, p),
      (e) => {
        assert.equal(e.status, 409);
        assert.equal(e.user, true);
        return true;
      },
    );
  }
  assert.equal(audit.reads.length, 0);
});

test("database failure blocks enrollment without exposing error details", async () => {
  const audit = setup({}, { error: "Purchase" });
  await assert.rejects(
    () => audit.assertUnspent(bot, pool),
    (e) => {
      assert.equal(e.user, true);
      assert.equal(e.status, 409);
      assert.match(e.message, /could not be verified/);
      assert.doesNotMatch(e.message, /buyer@example|private-token/);
      return true;
    },
  );
});

test("query limits cannot be disabled and regex metacharacters are escaped", async () => {
  const audit = setup({}, { maxQueryMs: 90000 });
  await audit.assertUnspent(bot, pool);
  assert.ok(audit.reads.every((r) => r.maxTimeMS === 3000));
  assert.equal(_internals.escapeRegex("a.b+[c]$"), "a\\.b\\+\\[c\\]\\$");
});
