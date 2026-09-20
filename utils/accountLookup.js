// Unified "username -> client token" lookup across EVERY account collection in
// the system. Powers routes/accountApiRoutes.js (the external bearer-token API)
// so a caller can resolve one login to its Twitch auth token (clientSecret) and
// credentials no matter which subsystem the account currently lives in:
//
//   bot       -> BotAccount        (the Drops Archive: deployed farming accounts)
//   pool      -> AvailableAccount  (the ready-to-deploy pool)
//   unclaimed -> UnclaimedAccount  (no-claim / unclaimed farms; token resolved
//                                   from its pool row via poolAccountId)
//   supplied  -> SuppliedAccount   (owner-supplied account-listing stock)
//   renter    -> RenterAccount     (a renter's isolated tenant inventory)
//   epic      -> EpicAccount       (Epic Games stock; token is a refresh token)
//
// clientSecret is stored in the clear (it is the live Twitch token we query
// Twitch with); password/email/refreshToken are encrypted at rest via
// utils/secretBox and decrypted here only when the caller asks for credentials.
//
// The same login can legitimately exist in more than one collection (e.g. a
// pool row that is also deployed on a bot), so this returns EVERY match grouped
// by source, plus a single `clientToken` picked by source priority for the
// common "just give me the token" case.
const BotAccount = require("../models/BotAccount");
const AvailableAccount = require("../models/AvailableAccount");
const UnclaimedAccount = require("../models/UnclaimedAccount");
const SuppliedAccount = require("../models/SuppliedAccount");
const RenterAccount = require("../models/RenterAccount");
const EpicAccount = require("../models/EpicAccount");
const { decrypt } = require("./secretBox");

// Escape a user-supplied string for safe use inside a RegExp. Logins can carry
// characters that are regex metacharacters; without this a crafted username
// could change the query's meaning (or match far more than intended).
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Case-insensitive EXACT match on a field that has no lowercased mirror.
function exactCI(value) {
  return new RegExp("^" + escapeRegex(value) + "$", "i");
}

// Never return more than this many rows from a single collection. Matches are
// anchored/exact so this is a safety cap, not normal behaviour.
const PER_SOURCE_LIMIT = 25;

// Order in which a source's token is preferred when one login appears in
// several collections. A live deployed bot account is the most authoritative.
const SOURCE_PRIORITY = [
  "bot",
  "pool",
  "supplied",
  "renter",
  "unclaimed",
  "epic",
];

function safeDecrypt(value) {
  try {
    return decrypt(value) || "";
  } catch {
    return "";
  }
}

// Given all matched source entries, pick the single most authoritative token.
function pickPrimary(sources) {
  for (const src of SOURCE_PRIORITY) {
    const hit = sources.find((s) => s.source === src && s.clientToken);
    if (hit) {
      return { clientToken: hit.clientToken, primarySource: hit.source };
    }
  }
  return { clientToken: "", primarySource: "" };
}

// Look one username up across every account source.
//
// opts.includeCredentials (default true) controls whether decrypted
// password/email/refresh-token values are attached. When false, only the
// clientToken and non-secret metadata come back.
async function lookupAccountByUsername(username, opts = {}) {
  const includeCredentials = opts.includeCredentials !== false;
  const raw = String(username || "").trim();
  const result = {
    username: raw,
    found: false,
    clientToken: "",
    primarySource: "",
    count: 0,
    sources: [],
  };
  if (!raw) return result;

  const lower = raw.toLowerCase();
  const ciExact = exactCI(raw);
  const sources = [];

  // --- bot (Drops Archive) ------------------------------------------------
  try {
    const rows = await BotAccount.find({ login: ciExact })
      .limit(PER_SOURCE_LIMIT)
      .lean();
    for (const r of rows) {
      sources.push({
        source: "bot",
        collection: "BotAccount",
        id: String(r._id),
        login: r.login || "",
        twitchId: r.twitchId || "",
        tokenType: "twitch_client_secret",
        clientToken: r.clientSecret || "",
        credentials: includeCredentials
          ? {
              username: r.credUsername || r.login || "",
              password: safeDecrypt(r.credPassword),
              email: safeDecrypt(r.credEmail),
            }
          : undefined,
        meta: {
          host: r.host || "",
          container: r.container || "",
          configFile: r.configFile || "",
          enabled: r.enabled !== false,
          hasPassword: !!r.hasPassword,
          soldAt: r.soldAt || null,
          lastScanStatus: r.lastScanStatus || "",
          dropCount: r.dropCount || 0,
        },
      });
    }
  } catch (e) {
    result.errors = result.errors || [];
    result.errors.push({ source: "bot", message: e.message });
  }

  // --- pool (AvailableAccount) -------------------------------------------
  try {
    const rows = await AvailableAccount.find({ usernameLower: lower })
      .limit(PER_SOURCE_LIMIT)
      .lean();
    for (const r of rows) {
      sources.push({
        source: "pool",
        collection: "AvailableAccount",
        id: String(r._id),
        login: r.username || "",
        twitchId: r.twitchId || "",
        tokenType: "twitch_client_secret",
        clientToken: r.clientSecret || "",
        credentials: includeCredentials
          ? {
              username: r.username || "",
              password: safeDecrypt(r.password),
              email: safeDecrypt(r.email),
            }
          : undefined,
        meta: {
          status: r.status || "",
          uniqueId: r.uniqueId || "",
          hasPassword: !!r.hasPassword,
          soldGames: r.soldGames || [],
        },
      });
    }
  } catch (e) {
    result.errors = result.errors || [];
    result.errors.push({ source: "pool", message: e.message });
  }

  // --- unclaimed (no-claim farms) ----------------------------------------
  // The ledger row carries no token of its own; it points at the pool row that
  // was farmed via poolAccountId. Resolve that to recover the clientSecret.
  try {
    const rows = await UnclaimedAccount.find({ loginLower: lower })
      .limit(PER_SOURCE_LIMIT)
      .lean();
    for (const r of rows) {
      let clientToken = "";
      let credentials;
      if (r.poolAccountId) {
        try {
          const pool = await AvailableAccount.findById(r.poolAccountId).lean();
          if (pool) {
            clientToken = pool.clientSecret || "";
            if (includeCredentials) {
              credentials = {
                username: pool.username || r.login || "",
                password: safeDecrypt(pool.password),
                email: safeDecrypt(pool.email),
              };
            }
          }
        } catch {
          /* poolAccountId may not be a resolvable pool row; ignore */
        }
      }
      sources.push({
        source: "unclaimed",
        collection: "UnclaimedAccount",
        id: String(r._id),
        login: r.login || "",
        twitchId: r.twitchId || "",
        tokenType: "twitch_client_secret",
        clientToken,
        credentials: includeCredentials ? credentials : undefined,
        meta: {
          game: r.game || "",
          market: r.market || "",
          status: r.status || "",
          botId: r.botId || "",
          container: r.container || "",
          poolAccountId: r.poolAccountId || "",
          soldAt: r.soldAt || null,
        },
      });
    }
  } catch (e) {
    result.errors = result.errors || [];
    result.errors.push({ source: "unclaimed", message: e.message });
  }

  // --- supplied (account listings stock) ---------------------------------
  try {
    const rows = await SuppliedAccount.find({ loginLower: lower })
      .limit(PER_SOURCE_LIMIT)
      .lean();
    for (const r of rows) {
      sources.push({
        source: "supplied",
        collection: "SuppliedAccount",
        id: String(r._id),
        login: r.login || "",
        twitchId: "",
        tokenType: "twitch_client_secret",
        clientToken: r.clientSecret || "",
        credentials: includeCredentials
          ? {
              username: r.login || "",
              password: safeDecrypt(r.password),
              email: safeDecrypt(r.email),
              extra: r.extra || "",
            }
          : undefined,
        meta: {
          status: r.status || "",
          market: r.market || "",
          offer: r.offer ? String(r.offer) : "",
        },
      });
    }
  } catch (e) {
    result.errors = result.errors || [];
    result.errors.push({ source: "supplied", message: e.message });
  }

  // --- renter (isolated tenant inventory) --------------------------------
  try {
    const rows = await RenterAccount.find({ login: ciExact })
      .limit(PER_SOURCE_LIMIT)
      .lean();
    for (const r of rows) {
      sources.push({
        source: "renter",
        collection: "RenterAccount",
        id: String(r._id),
        login: r.login || "",
        twitchId: r.twitchId || "",
        tokenType: "twitch_client_secret",
        clientToken: r.clientSecret || "",
        credentials: undefined, // renter accounts store no operator-side creds
        meta: {
          renter: r.renter ? String(r.renter) : "",
          host: r.host || "",
          container: r.container || "",
          enabled: r.enabled !== false,
          farmUntil: r.farmUntil || null,
        },
      });
    }
  } catch (e) {
    result.errors = result.errors || [];
    result.errors.push({ source: "renter", message: e.message });
  }

  // --- epic (Epic Games stock) -------------------------------------------
  // Epic accounts have no Twitch login; match on displayName / label /
  // accountId and return the refresh token, clearly typed so a caller does not
  // confuse it with a Twitch clientSecret.
  try {
    const rows = await EpicAccount.find({
      $or: [
        { displayName: ciExact },
        { label: ciExact },
        { accountId: ciExact },
      ],
    })
      .limit(PER_SOURCE_LIMIT)
      .lean();
    for (const r of rows) {
      sources.push({
        source: "epic",
        collection: "EpicAccount",
        id: String(r._id),
        login: r.displayName || r.label || r.accountId || "",
        twitchId: "",
        tokenType: "epic_refresh_token",
        clientToken: includeCredentials ? safeDecrypt(r.refreshToken) : "",
        credentials: undefined,
        meta: {
          accountId: r.accountId || "",
          displayName: r.displayName || "",
          label: r.label || "",
          status: r.status || "",
          sold: !!r.sold,
          libraryCount: r.libraryCount || 0,
        },
      });
    }
  } catch (e) {
    result.errors = result.errors || [];
    result.errors.push({ source: "epic", message: e.message });
  }

  const { clientToken, primarySource } = pickPrimary(sources);
  result.sources = sources;
  result.count = sources.length;
  result.found = sources.length > 0;
  result.clientToken = clientToken;
  result.primarySource = primarySource;
  return result;
}

// Shortest prefix worth scanning. Below this every query just returns an
// arbitrary slice of the whole fleet, which is noise, not a suggestion.
const MIN_SUGGEST_PREFIX = 2;
const SUGGEST_LIMIT = 8;

// Prefix search over the Twitch account sources, for the "did you mean" list
// shown when a typed username matched nothing exactly. Returns one entry per
// distinct login with the sources it appears in — NEVER a token: this is a
// name-completion aid, and the caller still has to run the real lookup.
//
// Epic rows are left out on purpose: their token is an Epic refresh token, so
// an Epic display name is never a useful answer to "which Twitch account?".
//
// `hasToken` is a HINT, not a promise. It reports whether the matched row
// itself carries a clientSecret (for unclaimed, whether it points at a pool row
// at all); only lookupAccountByUsername resolves the real thing.
async function suggestUsernames(prefix, opts = {}) {
  const raw = String(prefix || "").trim();
  if (raw.length < MIN_SUGGEST_PREFIX) return [];
  const limit = Math.min(Math.max(Number(opts.limit) || SUGGEST_LIMIT, 1), 25);
  // Lowercase mirror fields (pool/unclaimed/supplied) are indexed and already
  // normalised, so an anchored lowercase regex can use the index. bot/renter
  // have no mirror and need the case-insensitive form.
  const startsLower = new RegExp("^" + escapeRegex(raw.toLowerCase()));
  const startsCI = new RegExp("^" + escapeRegex(raw), "i");
  // Pull a little more than we return: the same login often appears in several
  // collections and collapses to one entry.
  const perSource = Math.min(limit * 3, 40);

  const queries = [
    [
      "bot",
      () =>
        BotAccount.find({ login: startsCI }, { login: 1, clientSecret: 1 })
          .limit(perSource)
          .lean(),
      (r) => ({ login: r.login, hasToken: !!r.clientSecret }),
    ],
    [
      "pool",
      () =>
        AvailableAccount.find(
          { usernameLower: startsLower },
          { username: 1, clientSecret: 1 },
        )
          .limit(perSource)
          .lean(),
      (r) => ({ login: r.username, hasToken: !!r.clientSecret }),
    ],
    [
      "unclaimed",
      () =>
        UnclaimedAccount.find(
          { loginLower: startsLower },
          { login: 1, poolAccountId: 1 },
        )
          .limit(perSource)
          .lean(),
      (r) => ({ login: r.login, hasToken: !!r.poolAccountId }),
    ],
    [
      "supplied",
      () =>
        SuppliedAccount.find(
          { loginLower: startsLower },
          { login: 1, clientSecret: 1 },
        )
          .limit(perSource)
          .lean(),
      (r) => ({ login: r.login, hasToken: !!r.clientSecret }),
    ],
    [
      "renter",
      () =>
        RenterAccount.find({ login: startsCI }, { login: 1, clientSecret: 1 })
          .limit(perSource)
          .lean(),
      (r) => ({ login: r.login, hasToken: !!r.clientSecret }),
    ],
  ];

  // allSettled: one unreachable collection must not blank the whole list.
  const settled = await Promise.allSettled(queries.map(([, run]) => run()));
  const byLogin = new Map();
  settled.forEach((outcome, i) => {
    if (outcome.status !== "fulfilled") return;
    const [source, , shape] = queries[i];
    for (const row of outcome.value) {
      const { login, hasToken } = shape(row);
      if (!login) continue;
      const key = login.toLowerCase();
      const entry = byLogin.get(key) || {
        login,
        sources: [],
        hasToken: false,
      };
      if (!entry.sources.includes(source)) entry.sources.push(source);
      entry.hasToken = entry.hasToken || hasToken;
      byLogin.set(key, entry);
    }
  });

  // Closest to what was typed first (shortest login), then alphabetical.
  return [...byLogin.values()]
    .sort(
      (a, b) =>
        a.login.length - b.login.length || a.login.localeCompare(b.login),
    )
    .slice(0, limit);
}

module.exports = {
  lookupAccountByUsername,
  suggestUsernames,
  // exported for tests
  escapeRegex,
  exactCI,
  pickPrimary,
  SOURCE_PRIORITY,
};
