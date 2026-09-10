// Which account _ids the Drops Archive must leave out of every stock, count and
// inventory view, and a shared cache for that set.
//
// This used to live inside routes/dropArchiveRoutes.js. It moved here because
// the background rollup builder (utils/archiveSnapshot.js) needs exactly the
// same exclusion set as the request handlers — computing it twice would both
// waste round trips on the Atlas shared tier and risk the two disagreeing about
// what counts as sellable stock.
const BotAccount = require("../models/BotAccount");
const AvailableAccount = require("../models/AvailableAccount");
const accountState = require("./twitchAccountState");

// Accounts whose Twitch token no longer works ("bad token" in the scan bar).
// They can't be logged into or farmed, so they're treated as trash: excluded
// from every cross-account / search / inventory view and from the main account
// list, and surfaced only in the dedicated "Bad tokens" tab.
//
// "suspended" belongs here too, and every use is a set membership test for that
// reason: it is a strictly worse token_invalid (the account is gone from
// Twitch, not merely locked out), so treating it as anything other than trash
// would quietly promote these accounts back into the searches the operator uses
// to build orders.
const BAD_STATUSES = accountState.UNUSABLE_SCAN_STATUSES;

// The set changes only when a scan flips an account's status or a sync moves a
// placement — minutes-to-hours events. A short TTL bought nothing and made
// every heavy read pay for the recompute, so it is deliberately generous;
// invalidateExclusions() clears it the moment an archive write lands.
const EXCLUSION_TTL_MS = 60 * 1000;

// _ids of the bad-token accounts, used to keep their drops out of the
// aggregations. Small list (hundreds at most) so $nin stays cheap.
async function badAccountIds() {
  const rows = await BotAccount.find(
    { lastScanStatus: { $in: BAD_STATUSES } },
    { _id: 1 },
  ).lean();
  return rows.map((r) => r._id);
}

// _ids of "shadow" duplicate accounts: an account with no bot placement whose
// login ALSO has a live (deployed) sibling. These are stale old-token copies
// left behind when an account's token was re-minted and redeployed — identity
// is the ClientSecret, so a redeploy creates a fresh record and the sync strips
// this one's container. Login is the (unique) Twitch username, so a shadow is
// the SAME Twitch account as its live sibling and scans the same inventory;
// counting it again double-counts held stock and shows the account twice in the
// item drill-down. Kept deliberately: a shadow that's already been sold (never
// hide a sale) and any login whose only records are all deployed (the rare
// same-account-in-two-bots case — a config problem, not a phantom row).
async function shadowDuplicateIds() {
  const groups = await BotAccount.aggregate([
    { $match: { login: { $nin: ["", null] } } },
    {
      $group: {
        _id: { $toLower: "$login" },
        docs: {
          $push: {
            id: "$_id",
            deployed: {
              $gt: [
                {
                  $strLenCP: {
                    $concat: [
                      { $ifNull: ["$container", ""] },
                      { $ifNull: ["$configFile", ""] },
                    ],
                  },
                },
                0,
              ],
            },
            sold: { $ne: [{ $ifNull: ["$soldAt", null] }, null] },
          },
        },
      },
    },
    { $match: { "docs.1": { $exists: true } } }, // only logins with 2+ records
  ]);
  const ids = [];
  for (const g of groups) {
    if (!g.docs.some((d) => d.deployed)) continue; // no live sibling to defer to
    for (const d of g.docs) if (!d.deployed && !d.sold) ids.push(d.id);
  }
  return ids;
}

// _ids of pool (AvailableAccount) rows whose Twitch login is ALSO deployed in a
// bot. The account pool is scanned ahead of deployment, so once a pool account
// is wired into a bot the SAME Twitch login exists twice — the deployed
// BotAccount and the leftover pool AvailableAccount — and its drops get logged
// under BOTH. This defers the pool copy to its deployed sibling, the mirror
// image of shadowDuplicateIds. Only ever returns AvailableAccount ids, so it
// can never hide deployed/sellable stock.
//
// The intersection is done in Node rather than with a $in of every deployed
// login. The pool is a small collection (~2k rows), so pulling its usernames
// with a projection is one cheap indexed read, whereas the old
// `find({ usernameLower: { $in: <3.8k logins> } })` measured 3.1s on the
// production Atlas shared tier — on the critical path of every archive view.
async function poolShadowIds() {
  const [deployedLogins, poolRows] = await Promise.all([
    BotAccount.distinct("login", {
      login: { $nin: ["", null] },
      configFile: { $nin: ["", null] },
    }),
    AvailableAccount.find({}, { _id: 1, usernameLower: 1 }).lean(),
  ]);
  const deployed = new Set(
    deployedLogins.map((l) => String(l || "").toLowerCase()).filter(Boolean),
  );
  if (!deployed.size) return [];
  return poolRows
    .filter((p) => p.usernameLower && deployed.has(p.usernameLower))
    .map((p) => p._id);
}

// The full set of account _ids excluded from stock/count/inventory views: dead
// tokens, shadow duplicates (idle BotAccount twins), and pool shadows (pool
// AvailableAccount copies of an already-deployed login). Used everywhere a $nin
// filter guards an aggregation, so every view agrees on what counts as real,
// sellable stock and no Twitch account is shown or counted twice.
async function excludedAccountIds() {
  const [bad, shadow, poolShadow] = await Promise.all([
    badAccountIds(),
    shadowDuplicateIds(),
    poolShadowIds(),
  ]);
  return bad.concat(shadow, poolShadow);
}

let cache = null; // { exp, ids }
let inFlight = null; // shared promise, so N concurrent readers cause 1 recompute

// Memoized excludedAccountIds(). Every heavy archive read calls this, and on
// the Atlas shared tier concurrent queries serialise — so without the in-flight
// share a page load that fires three views at once paid for the same three
// queries three times over.
async function excludedAccountIdsCached() {
  if (cache && cache.exp > Date.now()) return cache.ids;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const ids = await excludedAccountIds();
      cache = { exp: Date.now() + EXCLUSION_TTL_MS, ids };
      return ids;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function invalidateExclusions() {
  cache = null;
}

module.exports = {
  BAD_STATUSES,
  EXCLUSION_TTL_MS,
  badAccountIds,
  shadowDuplicateIds,
  poolShadowIds,
  excludedAccountIds,
  excludedAccountIdsCached,
  invalidateExclusions,
};
