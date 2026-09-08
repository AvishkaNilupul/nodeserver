const express = require("express");

const { requireSuperadmin } = require("../middleware/auth");
const AvailableAccount = require("../models/AvailableAccount");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const MarketplaceListing = require("../models/MarketplaceListing");
const UnclaimedAccount = require("../models/UnclaimedAccount");
const dropScanner = require("../utils/dropScanner");
const hosts = require("../utils/botHosts");
const settings = require("../utils/settings");
const twitchInventory = require("../utils/twitchInventory");
const { normGame } = require("../utils/gameLabel");
const { recordPoolUsage } = require("../utils/poolUsageLog");
const { recordAutoFarmEvent } = require("../utils/autoFarmEventLog");
const { spentAccountEligibility, isFarmSpentNote } = require("../utils/spentAccountEligibility");
const { MARKET_CLAIM_TAGS } = require("../utils/marketClaimTags");

const router = express.Router();
const DAY_MS = 86400000;
const RECYCLE_BATCH = 20;
// Only these persisted scan statuses prove the buyer took the account over. A
// transient "already being scanned" / "Account not found" / timeout / network
// "error" must NEVER brand a healthy account — the continuous scanner runs
// against these same logins, so a scan collision is expected, not a dead token.
const DEAD_TOKEN_STATUSES = new Set(["token_invalid", "suspended"]);

// The standalone no-claim bots farm pool accounts directly (no BotAccount row),
// so a no-claim-spent account has nothing to rescan with except its own token.
// The spent scan already routes those GQL calls through the Pi; recycle does the
// same so the fresh check comes from the same egress the account farmed on.
function resolvePiHost() {
  const host = hosts.resolveHost("pi");
  if (!host) {
    const e = new Error('Pi host "pi" is not configured.');
    e.status = 503;
    throw e;
  }
  return host;
}

function deliveredAt(drop) {
  return drop.soldAt || drop.awardedAt || drop.firstSeenAt || drop.updatedAt || drop.lastSeenAt || null;
}

function listingLogins(rows) {
  const out = new Set();
  for (const row of rows) {
    const values = [row.accountLogin, ...(row.units || []).map((unit) => unit.login)];
    for (const value of values.flatMap((item) => String(item || "").split(/[\s,]+/))) {
      const login = value.trim().toLowerCase();
      if (login) out.add(login);
    }
  }
  return out;
}

// One document per login carrying the drop facts the eligibility rule needs.
// `logins` scopes the scan to a handful of accounts for the recycle path; left
// out, it rolls up the whole archive.
//
// Bucket to one row per (login, game, buyer, connected, sold) FIRST, then roll
// the buckets up per login. A single-stage $addToSet carried each drop's four
// timestamps inside the set element, so almost nothing deduplicated and the
// group shipped back roughly one object per drop — which is what made this page
// take over a minute against Atlas (the bound here is bytes returned, not query
// time).
function dropRollupPipeline(logins) {
  const buyerLower = { $toLower: { $ifNull: ["$soldToUsername", ""] } };
  const deliveryDate = {
    $ifNull: [
      "$soldAt",
      {
        $ifNull: [
          "$awardedAt",
          { $ifNull: ["$firstSeenAt", "$updatedAt"] },
        ],
      },
    ],
  };
  return [
    ...(logins ? [{ $match: { login: { $in: logins } } }] : []),
    {
      $group: {
        _id: {
          login: { $toLower: "$login" },
          game: { $ifNull: ["$game", ""] },
          buyer: buyerLower,
          connected: { $eq: ["$connected", true] },
          sold: { $ne: [{ $ifNull: ["$soldAt", null] }, null] },
        },
        n: { $sum: 1 },
        newestAt: { $max: deliveryDate },
        buyerLabel: { $first: { $ifNull: ["$soldToUsername", ""] } },
      },
    },
    {
      // A reservation tag means "attached to a live listing", not "sold to
      // someone" — so only a buyer-tagged reservation counts as delivered.
      $set: { realSale: { $and: ["$_id.sold", { $not: [{ $in: ["$_id.buyer", MARKET_CLAIM_TAGS] }] }] } },
    },
    { $set: { delivered: { $or: ["$_id.connected", "$realSale"] } } },
    {
      $group: {
        _id: "$_id.login",
        available: {
          $sum: { $cond: [{ $and: [{ $not: ["$_id.connected"] }, { $not: ["$_id.sold"] }] }, "$n", 0] },
        },
        delivered: { $sum: { $cond: ["$delivered", "$n", 0] } },
        soldUnconnected: {
          $sum: { $cond: [{ $and: [{ $not: ["$_id.connected"] }, "$realSale"] }, "$n", 0] },
        },
        newestDeliveredAt: { $max: { $cond: ["$delivered", "$newestAt", null] } },
        soldDetails: {
          $push: {
            $cond: [
              { $and: ["$delivered", { $ne: ["$_id.game", ""] }] },
              {
                game: "$_id.game",
                connected: "$_id.connected",
                soldToUsername: "$buyerLabel",
                soldAt: "$newestAt",
              },
              null,
            ],
          },
        },
      },
    },
    // A login with nothing delivered can never be a spent account, and the two
    // gates that could still have used its counts are unreachable without a
    // delivery: `soldUnconnected` is a subset of `delivered`, and a row that
    // reaches the `available` gate at all got here through `soldGames`, which
    // only the farm engines (which bypass that gate) and a past recycle (which
    // is rejected earlier) ever stamp. Dropping them here is what turns a
    // 4590-row transfer into an 870-row one.
    { $match: { delivered: { $gt: 0 } } },
  ];
}

function uniqueLower(values) {
  return [...new Set(values.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))];
}

// Every record that can hold a live sale: the marketplace listing rows and the
// unclaimed engine's ledger. Always read fresh — for a farm-spent account this
// is the ONLY thing standing between still-purchasable stock and the farmer
// taking it back, so it must never come from a cached snapshot.
function loadLiveStock() {
  return Promise.all([
    MarketplaceListing.find(
      { status: "active", $or: [{ accountLogin: { $ne: "" } }, { "units.0": { $exists: true } }] },
      { accountLogin: 1, "units.login": 1 },
    ).lean(),
    UnclaimedAccount.distinct("loginLower", { status: "listed" }).catch(() => []),
  ]);
}

// BotAccount.login is stored in the account's own casing (661 of 4692 on prod
// carry capitals), so an $in against lowercase logins would silently miss them
// — and a missed bot row reads as "not deployed", which is exactly the way this
// page must never be wrong. The lowercase compare therefore happens server-side.
function loadBots(loginsLower) {
  return BotAccount.aggregate([
    { $match: { login: { $ne: "" } } },
    { $set: { loginLower: { $toLower: "$login" } } },
    { $match: { loginLower: { $in: loginsLower } } },
    { $project: { login: 1, configFile: 1, lastScanStatus: 1, lastScanAt: 1 } },
  ]);
}

// `clientSecret` is deliberately NOT projected: it is a long encrypted blob on
// every one of thousands of pool rows, and Atlas bills this page in bytes
// returned. The one path that needs it (the farm-spent rescan) reads it for the
// single account being recycled.
const POOL_FIELDS = {
  username: 1,
  usernameLower: 1,
  status: 1,
  claimedAt: 1,
  claimedNote: 1,
  soldGames: 1,
  lastCheckStatus: 1,
  listed: 1,
  // A hand-sold account (buyer holds login AND password) must never go back to
  // the farm; the eligibility rule rejects it and the row surfaces it as a chip.
  manualSold: 1,
};

// Pass `logins` to gather just those accounts — the recycle paths do, so a
// write never pays for a full-archive scan (and gets a fresher read than the
// bulk snapshot could give it). Without it, every spent account is gathered.
//
// The shape matters: the old version pulled ALL 3235 pool rows and ALL 4692 bot
// rows and matched DropLog against a 4801-name $in, to end up rendering ~800
// rows. Now the archive rollup names its own candidates first and only those
// rows are fetched.
async function gatherSpentAccounts(options = {}) {
  const scope = Array.isArray(options.logins) ? uniqueLower(options.logins) : null;
  let pool;
  let dropRows;
  let botRows;
  let listingRows;
  let unclaimedLive;
  let candidates;

  if (scope) {
    if (!scope.length) return [];
    // Pool first, only to learn each account's own casing: 210 archive logins
    // carry capitals and DropLog.login stores them exactly as the pool does.
    pool = await AvailableAccount.find(
      { status: { $in: ["claimed", "available"] }, usernameLower: { $in: scope } },
      POOL_FIELDS,
    ).lean();
    const variants = [...new Set([...scope, ...pool.map((row) => row.username).filter(Boolean)])];
    candidates = scope;
    [dropRows, botRows, [listingRows, unclaimedLive]] = await Promise.all([
      DropLog.aggregate(dropRollupPipeline(variants)),
      loadBots(scope),
      loadLiveStock(),
    ]);
  } else {
    let soldGameLogins;
    [dropRows, soldGameLogins, [listingRows, unclaimedLive]] = await Promise.all([
      DropLog.aggregate(dropRollupPipeline(null)),
      // The other half of the final filter: a farm engine can stamp soldGames on
      // an account that never entered the drop archive at all.
      AvailableAccount.distinct("usernameLower", { "soldGames.0": { $exists: true } }),
      loadLiveStock(),
    ]);
    candidates = uniqueLower([...dropRows.map((row) => row._id), ...soldGameLogins]);
    if (!candidates.length) return [];
    [pool, botRows] = await Promise.all([
      AvailableAccount.find(
        { status: { $in: ["claimed", "available"] }, usernameLower: { $in: candidates } },
        POOL_FIELDS,
      ).lean(),
      loadBots(candidates),
    ]);
  }

  const dropAggBy = new Map(dropRows.map((row) => [row._id, row]));
  const listed = listingLogins(listingRows);
  for (const login of unclaimedLive) {
    const key = String(login || "").trim().toLowerCase();
    if (key) listed.add(key);
  }
  const botsBy = new Map();
  for (const bot of botRows) {
    const key = String(bot.login || "").toLowerCase();
    if (!botsBy.has(key)) botsBy.set(key, []);
    botsBy.get(key).push(bot);
  }
  const poolKeys = new Set(pool.map((account) => String(account.usernameLower || account.username || "").toLowerCase()));
  const accounts = [
    ...pool,
    ...botRows
      .filter((bot) => !poolKeys.has(String(bot.login || "").toLowerCase()))
      .filter((bot, index, rows) => rows.findIndex((other) => String(other.login || "").toLowerCase() === String(bot.login || "").toLowerCase()) === index)
      .map((bot) => ({ username: bot.login, usernameLower: String(bot.login || "").toLowerCase(), status: "needs_pool_import", claimedNote: "", soldGames: [], lastCheckStatus: bot.lastScanStatus || "", listed: false, manualSold: false, _id: null })),
  ];
  const cooldownDays = Number(settings.getAutoFarm().recycleCooldownDays) || 14;
  const now = Date.now();

  return accounts.map((account) => {
    const key = String(account.usernameLower || account.username || "").toLowerCase();
    const agg = dropAggBy.get(key) || {};
    const delivered = (agg.soldDetails || []).filter(Boolean);
    const available = Number(agg.available) || 0;
    const deliveredCount = Number(agg.delivered) || 0;
    const soldUnconnectedCount = Number(agg.soldUnconnected) || 0;
    const detailByGame = new Map();
    for (const drop of delivered.filter((item) => item.game)) {
      const gameKey = normGame(drop.game);
      const buyer = drop.connected && !drop.soldToUsername ? "connected" : (drop.soldToUsername || "manual");
      const detailKey = gameKey + "|" + buyer;
      const existing = detailByGame.get(detailKey);
      const at = deliveredAt(drop);
      if (!existing || (at && new Date(at) > new Date(existing.soldAt || 0))) {
        detailByGame.set(detailKey, { game: drop.game, gameKey, buyer, soldAt: at, connected: drop.connected === true });
      }
    }
    const soldDetails = [...detailByGame.values()];
    const newestDeliveredAt = agg.newestDeliveredAt || null;
    const bots = botsBy.get(key) || [];
    const deployed = bots.some((bot) => !!bot.configFile);
    const bot = bots.slice().sort((a, b) => {
      const aScore = (a.configFile ? 4 : 0) + (a.lastScanStatus === "ok" ? 2 : 0) + (a.lastScanAt ? 1 : 0);
      const bScore = (b.configFile ? 4 : 0) + (b.lastScanStatus === "ok" ? 2 : 0) + (b.lastScanAt ? 1 : 0);
      return bScore - aScore;
    })[0] || null;
    // On sale by ANY of the three records that can hold it: a marketplace
    // listing row, the unclaimed engine's live ledger, or the engine-owned
    // `listed` flag on the pool row itself. Farm-spent accounts skip the
    // DropLog stock gate, so this is the only thing standing between a
    // still-purchasable account and the farmer taking it back.
    const onSale = listed.has(key) || account.listed === true;
    const facts = {
      claimedNote: account.claimedNote,
      farmSpent: isFarmSpentNote(account.claimedNote),
      availableDrops: available,
      deliveredDrops: deliveredCount,
      soldUnconnectedDrops: soldUnconnectedCount,
      onActiveListing: onSale,
      deployed,
      manualSold: account.manualSold === true,
      newestDeliveredAt,
      cooldownDays,
      now,
    };
    const eligibility = spentAccountEligibility(facts);
    if (account.status !== "claimed" && eligibility.recyclable) {
      eligibility.recyclable = false;
      eligibility.reason = account.status === "needs_pool_import"
        ? "needs pool import — out of scope v1"
        : "already available in the pool";
    }
    // A farm-spent account never had a BotAccount — the standalone no-claim
    // bots farm pool rows directly — so recycle verifies its stored token
    // against Twitch instead. Demanding a BotAccount here contradicted that
    // path and is what kept those accounts un-recyclable in practice.
    if (!bot && !facts.farmSpent && eligibility.recyclable) {
      eligibility.recyclable = false;
      eligibility.reason = "no BotAccount available for a fresh rescan";
    }
    // An already-dead token can never pass the recycle-time rescan, so don't
    // dangle it as "ready" — the operator would click and just get branded.
    const resolvedStatus = (bot && bot.lastScanStatus) || account.lastCheckStatus || "";
    if (eligibility.recyclable && DEAD_TOKEN_STATUSES.has(resolvedStatus)) {
      eligibility.recyclable = false;
      eligibility.reason = "token " + resolvedStatus + " — reclaimed by buyer, cannot recycle";
    }
    const cooldownAt = newestDeliveredAt ? new Date(new Date(newestDeliveredAt).getTime() + cooldownDays * DAY_MS) : null;
    const daysLeft = cooldownAt ? Math.max(0, Math.ceil((cooldownAt.getTime() - now) / DAY_MS)) : null;
    return {
      id: account._id,
      username: account.username,
      status: account.status,
      soldGames: Array.isArray(account.soldGames) ? account.soldGames : [],
      soldDetails,
      cooldownDays,
      cooldownPassed: eligibility.cooldownPassed,
      daysLeft,
      recyclable: eligibility.recyclable,
      reason: eligibility.reason,
      deployed,
      listed: onSale,
      rented: /^rented to/i.test(String(account.claimedNote || "")),
      manualSold: account.manualSold === true,
      inBotConfig: /^deployed to /i.test(String(account.claimedNote || "")),
      lastCheckStatus: (bot && bot.lastScanStatus) || account.lastCheckStatus || "",
      lastScanAt: (bot && bot.lastScanAt) || null,
      botId: bot ? bot._id : null,
      outOfScope: !account._id,
      // Only a blocker when there is no stored token to fall back on.
      needsBotRescan: !bot && !facts.farmSpent,
      _pool: account._id ? account : null,
      _facts: facts,
    };
  }).filter((row) => row._facts.deliveredDrops > 0 || row.soldGames.length > 0);
}

function publicRow(row) {
  const { _pool, _facts, botId, ...safe } = row;
  return safe;
}

// A full gather is ~9s of Atlas transfer even after the narrowing, and this is
// a manual review queue whose contents only change when someone recycles or a
// farm engine stamps a pool row. So the list serves a short-lived snapshot and
// the page's Refresh button (?fresh=1) forces a new one; a recycle drops it.
// The write paths never read this — they run their own scoped, fresh gather.
const LIST_TTL_MS = 60000;
let snapshot = null; // { at, rows }
let inFlight = null;

function invalidateListSnapshot() {
  snapshot = null;
}

function listSnapshot(force) {
  if (!force && snapshot && Date.now() - snapshot.at < LIST_TTL_MS) return Promise.resolve(snapshot);
  // Concurrent callers (two tabs, or a reload mid-gather) share one gather
  // rather than each paying for their own.
  if (!inFlight) {
    inFlight = gatherSpentAccounts()
      .then((rows) => {
        snapshot = { at: Date.now(), rows };
        return snapshot;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

// Pure matcher: pick the row for a {login} or {id} body out of an existing
// gatherSpentAccounts() snapshot. No DB access, so a bulk request can match
// every requested account against ONE gather.
function matchRow(rows, body) {
  const id = body && body.id != null && String(body.id) !== "" ? String(body.id) : null;
  const loginLower = String((body && body.login) || "").trim().toLowerCase();
  if (!id && !loginLower) return null;
  return (
    rows.find((row) => {
      if (!row._pool) return false;
      return (
        (id && String(row._pool._id) === id) ||
        (loginLower && row._pool.usernameLower === loginLower)
      );
    }) || null
  );
}

// Recycle a single row taken from a gatherSpentAccounts() snapshot. The live
// rescan and the status:"claimed" guarded update keep this correct even if the
// snapshot is a few seconds stale, so a batch can share one gather.
async function recycleRow(row) {
  if (!row) {
    return { login: "", recycled: false, status: "not_found", reason: "spent account not found" };
  }
  const login = row.username;
  if (row.outOfScope || !row.botId) {
    // A no-claim-spent account has no BotAccount to rescan with, but its pool
    // row carries the token it farmed on — verify that token directly instead
    // of refusing it. Everything else (eligibility, guarded update) is shared.
    if (row._facts && row._facts.farmSpent && row._pool) {
      if (!row.recyclable) {
        return { login, recycled: false, status: "not_eligible", reason: row.reason || "not eligible" };
      }
      return recycleFarmSpentRow(row);
    }
    return { login, recycled: false, status: "out_of_scope", reason: "needs pool import — no BotAccount to rescan" };
  }
  if (!row.recyclable) {
    return { login, recycled: false, status: "not_eligible", reason: row.reason || "not eligible" };
  }
  let scanResult = null;
  try {
    scanResult = await dropScanner.scanAccountNow(row.botId);
  } catch {
    // Treated as "could not verify" below — never as a dead token.
  }
  const fresh = await BotAccount.findById(row.botId, { lastScanStatus: 1 }).lean();
  const status = fresh && fresh.lastScanStatus;
  // Recycle only on a positive, fresh "token still works" signal.
  const healthy = !!scanResult && scanResult.ok === true && status === "ok";
  if (!healthy) {
    if (DEAD_TOKEN_STATUSES.has(status)) {
      // A scan actually reached Twitch and the token is gone/suspended — the
      // buyer reclaimed it. Brand it so it never resurfaces as recyclable.
      await AvailableAccount.updateOne(
        { _id: row._pool._id },
        { $set: { claimedNote: "sold — token reclaimed by buyer" } },
      );
      await recordPoolUsage(row._pool._id, { event: "sold", actor: "spent-accounts", note: "sold — token reclaimed by buyer" });
      return { login, recycled: false, status: "token_reclaimed", reason: "token reclaimed by buyer" };
    }
    // Transient (mid-scan collision, stale id, timeout, network error). Do NOT
    // brand a healthy account — surface the reason and let the operator retry.
    return {
      login,
      recycled: false,
      status: "rescan_unverified",
      reason: (scanResult && scanResult.error) || "rescan could not confirm the token — try again",
    };
  }
  // Merge with whatever the pool row already excluded (e.g. a no-claim-spent
  // stamp written by the no-claim remove flow) — the derived set alone would
  // drop games that were spent without a DropLog delivery record.
  const derived = [...new Set((row.soldDetails || []).map((detail) => detail.gameKey).filter(Boolean))];
  const prior = Array.isArray(row._pool && row._pool.soldGames) ? row._pool.soldGames : [];
  const soldGames = [...new Set([...prior, ...derived])];
  const update = await AvailableAccount.updateOne(
    { _id: row._pool._id, status: "claimed" },
    {
      $set: {
        status: "available",
        claimedAt: null,
        claimedNote: "recycled — spent (never re-farm sold games)",
        soldGames,
      },
    },
  );
  if (!(update.modifiedCount || update.nModified)) {
    return { login, recycled: false, status: "not_eligible", reason: "pool row changed before recycle" };
  }
  await recordPoolUsage(row._pool._id, { event: "recycled", actor: "spent-accounts", note: "recycled — sold games excluded", game: "" });
  await recordAutoFarmEvent({ type: "recycled", count: 1, actor: "spentAccountsTab", reason: "manual recycle" });
  return { login, recycled: true, status: "recycled", soldGames };
}

// Recycle a spent account handed over by one of the standalone farm engines
// (no-claim removal, unclaimed auto-list sale): verify the pool row's own token
// (fresh GQL via the Pi), then return it to the pool with the sold games
// excluded — the same end state the managed-bot path produces. A dead/reclaimed
// token is branded so it never resurfaces as recyclable; a transient Twitch
// error is NOT branded (fail closed, let the operator retry).
async function recycleFarmSpentRow(row) {
  const login = row.username;
  // The list gather skips clientSecret (thousands of encrypted blobs); read it
  // for just this account, at the moment it is actually needed.
  const secretRow = await AvailableAccount.findById(row._pool._id, { clientSecret: 1 }).lean();
  const clientSecret = (secretRow && secretRow.clientSecret) || "";
  if (!clientSecret) {
    return { login, recycled: false, status: "rescan_unverified", reason: "no stored token to verify — cannot recycle" };
  }
  let healthy = false;
  let tokenDead = false;
  let error = "";
  try {
    const inv = await twitchInventory.fetchInventory(clientSecret, {
      host: resolvePiHost(),
    });
    healthy = !!(inv && inv.twitchId);
  } catch (e) {
    if (e && e.code === "token_invalid") tokenDead = true;
    else error = (e && e.message) || String(e);
  }
  if (tokenDead) {
    await AvailableAccount.updateOne(
      { _id: row._pool._id },
      { $set: { claimedNote: "sold — token reclaimed by buyer" } },
    );
    await recordPoolUsage(row._pool._id, {
      event: "sold",
      actor: "spent-accounts",
      note: "sold — token reclaimed by buyer",
    });
    return { login, recycled: false, status: "token_reclaimed", reason: "token reclaimed by buyer" };
  }
  if (!healthy) {
    return {
      login,
      recycled: false,
      status: "rescan_unverified",
      reason: error || "rescan could not confirm the token — try again",
    };
  }
  const soldGames = [...new Set((Array.isArray(row._pool.soldGames) ? row._pool.soldGames : []).filter(Boolean))];
  const update = await AvailableAccount.updateOne(
    { _id: row._pool._id, status: "claimed" },
    {
      $set: {
        status: "available",
        claimedAt: null,
        claimedNote: "recycled — spent (never re-farm sold games)",
        soldGames,
      },
    },
  );
  if (!(update.modifiedCount || update.nModified)) {
    return { login, recycled: false, status: "not_eligible", reason: "pool row changed before recycle" };
  }
  await recordPoolUsage(row._pool._id, {
    event: "recycled",
    actor: "spent-accounts",
    note: "recycled — sold games excluded",
    game: "",
  });
  await recordAutoFarmEvent({
    type: "recycled",
    count: 1,
    actor: "spentAccountsTab",
    reason: "manual recycle (farm-spent)",
  });
  return { login, recycled: true, status: "recycled", soldGames };
}

// Turn whatever the client sent — a login, a pool id, or a mix — into the set
// of lowercase logins the scoped gather needs. Only an id costs a lookup.
async function loginsForBodies(bodies) {
  const ids = bodies.map((body) => body && body.id).filter((id) => id != null && String(id) !== "");
  const byId = ids.length
    ? await AvailableAccount.find({ _id: { $in: ids } }, { usernameLower: 1 }).lean().catch(() => [])
    : [];
  return uniqueLower([
    ...bodies.map((body) => (body && body.login) || ""),
    ...byId.map((row) => row.usernameLower),
  ]);
}

// The recycle paths gather ONLY the accounts they are about to touch. That is
// both far cheaper than a full-archive scan and strictly safer than reusing the
// list snapshot: every guard — on an active listing, still deployed, stock left
// to sell — is read at the moment of the write, not up to a minute earlier.
async function recycleBodies(bodies) {
  const logins = await loginsForBodies(bodies);
  const rows = logins.length ? await gatherSpentAccounts({ logins }) : [];
  const results = [];
  for (const body of bodies) {
    const row = matchRow(rows, body);
    results.push(
      row
        ? await recycleRow(row)
        : { login: String((body && body.login) || ""), recycled: false, status: "not_found", reason: "spent account not found" },
    );
  }
  if (results.some((result) => result.recycled)) invalidateListSnapshot();
  return results;
}

router.get("/spent-accounts/list", requireSuperadmin, async (req, res) => {
  try {
    const snapshot = await listSnapshot(req.query && String(req.query.fresh || "") === "1");
    res.json({
      success: true,
      accounts: snapshot.rows.map(publicRow),
      gatheredAt: new Date(snapshot.at).toISOString(),
      ageMs: Date.now() - snapshot.at,
      ttlMs: LIST_TTL_MS,
    });
  } catch (err) {
    console.error("spent-accounts list error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.post("/spent-accounts/recycle", requireSuperadmin, async (req, res) => {
  try {
    const [result] = await recycleBodies([req.body || {}]);
    const code = result.status === "not_found" ? 404 : (!result.recycled && result.status === "not_eligible" ? 409 : 200);
    res.status(code).json({ success: result.recycled, result });
  } catch (err) {
    console.error("spent-accounts recycle error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.post("/spent-accounts/recycle-bulk", requireSuperadmin, async (req, res) => {
  try {
    const values = Array.isArray(req.body) ? req.body : (req.body && (req.body.logins || req.body.accounts));
    const raw = Array.isArray(values) ? values : [];
    // Normalize to {login|id} bodies and drop duplicates so one account is never
    // rescanned twice in a single batch.
    const seen = new Set();
    const unique = [];
    for (const value of raw) {
      const body = typeof value === "string" ? { login: value } : (value || {});
      const hasId = body.id != null && String(body.id) !== "";
      const loginLower = String(body.login || "").trim().toLowerCase();
      if (!hasId && !loginLower) continue;
      const key = hasId ? "id:" + String(body.id) : "login:" + loginLower;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(body);
    }
    if (!unique.length) {
      return res.status(400).json({ success: false, message: "Provide an array of logins or account ids" });
    }
    const capped = unique.length > RECYCLE_BATCH;
    // ONE scoped gather for the whole batch.
    const results = await recycleBodies(unique.slice(0, RECYCLE_BATCH));
    res.json({ success: results.some((result) => result.recycled), results, capped });
  } catch (err) {
    console.error("spent-accounts recycle-bulk error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
module.exports.gatherSpentAccounts = gatherSpentAccounts;
module.exports.dropRollupPipeline = dropRollupPipeline;
module.exports.matchRow = matchRow;
module.exports.publicRow = publicRow;
module.exports.invalidateListSnapshot = invalidateListSnapshot;
