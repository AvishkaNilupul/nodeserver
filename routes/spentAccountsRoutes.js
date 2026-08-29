const express = require("express");

const { requireSuperadmin } = require("../middleware/auth");
const AvailableAccount = require("../models/AvailableAccount");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const MarketplaceListing = require("../models/MarketplaceListing");
const dropScanner = require("../utils/dropScanner");
const hosts = require("../utils/botHosts");
const settings = require("../utils/settings");
const twitchInventory = require("../utils/twitchInventory");
const { normGame } = require("../utils/gameLabel");
const { recordPoolUsage } = require("../utils/poolUsageLog");
const { recordAutoFarmEvent } = require("../utils/autoFarmEventLog");
const { spentAccountEligibility } = require("../utils/spentAccountEligibility");

const router = express.Router();
const MARKET_CLAIM_TAGS = new Set(["gameflip", "ggsel", "digiseller", "funpay", "zeusx"]);
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

function isRealSale(drop) {
  if (!drop.soldAt) return false;
  return !MARKET_CLAIM_TAGS.has(String(drop.soldToUsername || "").trim().toLowerCase());
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

async function gatherSpentAccounts() {
  const [pool, listingRows, botRows] = await Promise.all([
    AvailableAccount.find(
      { status: { $in: ["claimed", "available"] } },
      { username: 1, usernameLower: 1, status: 1, claimedAt: 1, claimedNote: 1, soldGames: 1, lastCheckStatus: 1, clientSecret: 1 },
    ).lean(),
    MarketplaceListing.find(
      { status: "active", $or: [{ accountLogin: { $ne: "" } }, { "units.0": { $exists: true } }] },
      { accountLogin: 1, "units.login": 1 },
    ).lean(),
    BotAccount.find(
      { login: { $ne: "" } },
      { login: 1, _id: 1, configFile: 1, lastScanStatus: 1, lastScanAt: 1 },
    ).lean(),
  ]);
  const botOnlyDelivered = await DropLog.distinct("login", {
    $or: [{ connected: true }, { soldAt: { $ne: null } }],
  }).catch(() => []);
  const names = [
    ...new Set(
      [...pool.map((row) => row.username), ...botOnlyDelivered].filter(Boolean),
    ),
  ];
  if (!names.length) return [];
  const soldAtExists = { $ne: [{ $ifNull: ["$soldAt", null] }, null] };
  const realSale = {
    $and: [
      soldAtExists,
      {
        $not: [
          {
            $in: [
              { $toLower: { $ifNull: ["$soldToUsername", ""] } },
              [...MARKET_CLAIM_TAGS],
            ],
          },
        ],
      },
    ],
  };
  const deliveredDrop = {
    $or: [{ $eq: ["$connected", true] }, realSale],
  };
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
  const groupedDrops = await DropLog.aggregate([
    { $match: { login: { $in: names } } },
    {
      $group: {
        _id: { $toLower: "$login" },
        available: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $ne: ["$connected", true] },
                  { $eq: [{ $ifNull: ["$soldAt", null] }, null] },
                ],
              },
              1,
              0,
            ],
          },
        },
        delivered: { $sum: { $cond: [deliveredDrop, 1, 0] } },
        soldUnconnected: {
          $sum: {
            $cond: [
              { $and: [{ $ne: ["$connected", true] }, realSale] },
              1,
              0,
            ],
          },
        },
        newestDeliveredAt: {
          $max: { $cond: [deliveredDrop, deliveryDate, null] },
        },
        soldDetails: {
          $addToSet: {
            $cond: [
              { $and: [{ $ne: ["$game", ""] }, deliveredDrop] },
              {
                game: "$game",
                connected: "$connected",
                soldAt: "$soldAt",
                soldToUsername: "$soldToUsername",
                awardedAt: "$awardedAt",
                firstSeenAt: "$firstSeenAt",
                updatedAt: "$updatedAt",
              },
              null,
            ],
          },
        },
      },
    },
  ]);
  const dropAggBy = new Map(groupedDrops.map((row) => [row._id, row]));
  const listed = listingLogins(listingRows);
  const botsBy = new Map();
  for (const bot of botRows) {
    const key = String(bot.login || "").toLowerCase();
    if (!botsBy.has(key)) botsBy.set(key, []);
    botsBy.get(key).push(bot);
  }
  const poolKeys = new Set(pool.map((account) => String(account.usernameLower || account.username || "").toLowerCase()));
  const candidates = [
    ...pool,
    ...botRows
      .filter((bot) => !poolKeys.has(String(bot.login || "").toLowerCase()))
      .filter((bot, index, rows) => rows.findIndex((other) => String(other.login || "").toLowerCase() === String(bot.login || "").toLowerCase()) === index)
      .map((bot) => ({ username: bot.login, usernameLower: String(bot.login || "").toLowerCase(), status: "needs_pool_import", claimedNote: "", soldGames: [], lastCheckStatus: bot.lastScanStatus || "", _id: null })),
  ];
  const cooldownDays = Number(settings.getAutoFarm().recycleCooldownDays) || 14;
  const now = Date.now();

  return candidates.map((account) => {
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
    const facts = {
      claimedNote: account.claimedNote,
      noClaimSpent: /^spent — no-claim/i.test(String(account.claimedNote || "")),
      availableDrops: available,
      deliveredDrops: deliveredCount,
      soldUnconnectedDrops: soldUnconnectedCount,
      onActiveListing: listed.has(key),
      deployed,
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
    if (!bot && eligibility.recyclable) {
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
      listed: listed.has(key),
      rented: /^rented to/i.test(String(account.claimedNote || "")),
      lastCheckStatus: (bot && bot.lastScanStatus) || account.lastCheckStatus || "",
      lastScanAt: (bot && bot.lastScanAt) || null,
      botId: bot ? bot._id : null,
      outOfScope: !account._id,
      needsBotRescan: !bot,
      _pool: account._id ? account : null,
      _facts: facts,
    };
  }).filter((row) => row._facts.deliveredDrops > 0 || row.soldGames.length > 0);
}

function publicRow(row) {
  const { _pool, _facts, botId, ...safe } = row;
  return safe;
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
    if (row._facts && row._facts.noClaimSpent && row._pool && row._pool.clientSecret) {
      if (!row.recyclable) {
        return { login, recycled: false, status: "not_eligible", reason: row.reason || "not eligible" };
      }
      return recycleNoClaimRow(row);
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

// Recycle a spent account pulled from the standalone no-claim bots: verify the
// pool row's own token (fresh GQL via the Pi), then return it to the pool with
// the sold games excluded — the same end state the managed-bot path produces.
// A dead/reclaimed token is branded so it never resurfaces as recyclable; a
// transient Twitch error is NOT branded (fail closed, let the operator retry).
async function recycleNoClaimRow(row) {
  const login = row.username;
  let healthy = false;
  let tokenDead = false;
  let error = "";
  try {
    const inv = await twitchInventory.fetchInventory(row._pool.clientSecret, {
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
    reason: "manual recycle (no-claim)",
  });
  return { login, recycled: true, status: "recycled", soldGames };
}

async function recycleOne(body) {
  const rows = await gatherSpentAccounts();
  const row = matchRow(rows, body);
  if (!row) {
    return { login: String((body && body.login) || ""), recycled: false, status: "not_found", reason: "spent account not found" };
  }
  return recycleRow(row);
}

router.get("/spent-accounts/list", requireSuperadmin, async (_req, res) => {
  try {
    const accounts = await gatherSpentAccounts();
    res.json({ success: true, accounts: accounts.map(publicRow) });
  } catch (err) {
    console.error("spent-accounts list error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.post("/spent-accounts/recycle", requireSuperadmin, async (req, res) => {
  try {
    const result = await recycleOne(req.body || {});
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
    const bodies = unique.slice(0, RECYCLE_BATCH);
    const rows = await gatherSpentAccounts(); // ONE gather for the whole batch
    const results = [];
    for (const body of bodies) {
      const row = matchRow(rows, body);
      results.push(
        row
          ? await recycleRow(row)
          : { login: String(body.login || ""), recycled: false, status: "not_found", reason: "spent account not found" },
      );
    }
    res.json({ success: results.some((result) => result.recycled), results, capped });
  } catch (err) {
    console.error("spent-accounts recycle-bulk error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
