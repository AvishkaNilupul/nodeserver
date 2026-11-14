// Read-only lifetime references for a whole Twitch account. Current sold flags
// can be cleared by refunds/recycling; none of these historical ledgers can be
// treated as clean stock merely because its current status says "removed".
const MAX_QUERY_MS = 3000;
const norm = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();
const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function deny(message) {
  const error = new Error(message);
  error.user = true;
  error.status = 409;
  throw error;
}

function identityFor(bot, pool) {
  const login = norm(bot && bot.login);
  const poolLogin = norm(pool && (pool.usernameLower || pool.username));
  const botId = String((bot && bot._id) || ""),
    poolId = String((pool && pool._id) || "");
  const twitchId = String((bot && bot.twitchId) || "");
  if (
    !/^[a-z0-9_]{3,25}$/.test(login) ||
    login !== poolLogin ||
    !/^[a-f0-9]{24}$/i.test(botId) ||
    !/^[a-f0-9]{24}$/i.test(poolId) ||
    !/^\d+$/.test(twitchId)
  ) {
    deny(
      "Twitch ownership identities are incomplete or inconsistent; review the account pair",
    );
  }
  if (pool.twitchId && String(pool.twitchId) !== twitchId)
    deny("Twitch ownership identities disagree; review the account pair");
  const ids = [...new Set([botId, poolId])];
  const names = [
    ...new Set(
      [
        login,
        String(bot.login).trim(),
        String(pool.username || "").trim(),
      ].filter(Boolean),
    ),
  ];
  return { login, ids, names, botId, poolId, twitchId };
}

function queriesFor(identity) {
  const { login, ids, names, poolId, twitchId } = identity;
  const exactLogin = new RegExp("^" + escapeRegex(login) + "$", "i");
  // Older vault listings packed their initial account IDs/logins into one
  // comma-separated field. Match a complete token, never a substring. These
  // two fallbacks are bounded and run only after exact identity reads miss.
  const packed = (values) =>
    new RegExp(
      "(?:^|[,\\s])(?:" + values.map(escapeRegex).join("|") + ")(?=$|[,\\s])",
      "i",
    );
  return [
    {
      model: "SuppliedAccount",
      label: "supplied-account stock",
      direct: { $or: [{ loginLower: login }, { login: { $in: names } }] },
      legacy: { login: exactLogin },
    },
    {
      model: "UnclaimedAccount",
      label: "an unclaimed-account ledger",
      direct: {
        $or: [
          { loginLower: login },
          { login: { $in: names } },
          { twitchId },
          { poolAccountId: poolId },
        ],
      },
      legacy: { login: exactLogin },
    },
    {
      model: "Purchase",
      label: "a shop purchase",
      direct: {
        $or: [{ account: { $in: ids } }, { accountLogin: { $in: names } }],
      },
      legacy: { accountLogin: exactLogin },
    },
    {
      model: "BulkOrder",
      label: "a bulk order",
      direct: {
        $or: [
          { "units.account": { $in: ids } },
          { "units.accountLogin": { $in: names } },
          { "units.replacedFromLogin": { $in: names } },
          { "units.replacedByLogin": { $in: names } },
        ],
      },
      legacy: {
        $or: [
          { "units.accountLogin": exactLogin },
          { "units.replacedFromLogin": exactLogin },
          { "units.replacedByLogin": exactLogin },
        ],
      },
    },
    {
      model: "MarketplaceListing",
      label: "a marketplace listing",
      direct: {
        $or: [
          { accountId: { $in: ids } },
          { accountLogin: { $in: names } },
          { "units.accountId": { $in: ids } },
          { "units.login": { $in: names } },
          { rentFarmPoolId: poolId },
        ],
      },
      legacy: {
        $or: [
          { accountId: packed(ids) },
          { accountLogin: packed([login]) },
          { "units.login": exactLogin },
        ],
      },
    },
  ];
}

function createAuditor({ models, maxQueryMs = MAX_QUERY_MS } = {}) {
  let loaded = models;
  const timeout = Number.isFinite(maxQueryMs)
    ? Math.max(100, Math.min(MAX_QUERY_MS, maxQueryMs))
    : MAX_QUERY_MS;
  function getModels() {
    if (!loaded)
      loaded = {
        SuppliedAccount: require("../models/SuppliedAccount"),
        UnclaimedAccount: require("../models/UnclaimedAccount"),
        Purchase: require("../models/Purchase"),
        BulkOrder: require("../models/BulkOrder"),
        MarketplaceListing: require("../models/MarketplaceListing"),
      };
    return loaded;
  }
  async function exists(model, query) {
    // No passwords, order details, buyer identifiers or tokens leave MongoDB.
    return !!(await model
      .findOne(query)
      .select({ _id: 1 })
      .maxTimeMS(timeout)
      .lean()
      .exec());
  }
  async function assertUnspent(bot, pool) {
    const identity = identityFor(bot, pool);
    const checks = queriesFor(identity);
    let results;
    try {
      const db = getModels();
      results = await Promise.all(
        checks.map(async (check) => {
          const model = db[check.model];
          if (!model) throw new Error("Missing ownership ledger");
          return (
            (await exists(model, check.direct)) ||
            (await exists(model, check.legacy))
          );
        }),
      );
    } catch (_) {
      // Incomplete evidence is never permission to recycle an account. Do not
      // echo database errors: they may contain configuration or personal data.
      deny(
        "Twitch ownership history could not be verified; check again before reserving",
      );
    }
    const index = results.findIndex(Boolean);
    if (index !== -1)
      deny(
        "Twitch account has a reference in " +
          checks[index].label +
          "; review its history before enrollment",
      );
    return true;
  }
  return { assertUnspent };
}

const auditor = createAuditor();
module.exports = {
  assertUnspent: auditor.assertUnspent,
  createAuditor,
  _internals: { identityFor, queriesFor, escapeRegex, MAX_QUERY_MS },
};
