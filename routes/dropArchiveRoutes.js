const express = require("express");
const mongoose = require("mongoose");

const { requireSuperadmin } = require("../middleware/auth");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const DropSet = require("../models/DropSet");
const { encrypt, decrypt } = require("../utils/secretBox");
const scanner = require("../utils/dropScanner");
const { cacheImage } = require("../utils/imageCache");
const hosts = require("../utils/botHosts");
const {
  fillBotPasswordsFromPool,
  markDeployedPoolAccountsClaimed,
} = require("../utils/poolPasswords");
const MarketplaceListing = require("../models/MarketplaceListing");
const SaleSignal = require("../models/SaleSignal");
const mp = require("../utils/marketplaces");
const guardian = require("../utils/marketplaceGuardian");
const gfFulfiller = require("../utils/gameflipFulfiller");
const { buildSetGridImage } = require("../utils/setImage");
const { sameGame } = require("../utils/gameLabel");
const fsp = require("fs").promises;

// Reservation tags written by the marketplace fulfillers into
// DropLog.soldToUsername. A drop carrying one is attached to a live
// listing, not sold to anyone yet.
const MARKET_CLAIM_TAGS = [
  "gameflip",
  "ggsel",
  "digiseller",
  "funpay",
  "zeusx",
];

const router = express.Router();

// ------------------------------------------------------------------
// Short-lived read cache for the heavy archive aggregations
// (overview / by-game / by-item). Each re-scans 150k+ drops, and the page
// fires all three on load and again on every tab switch, so without a cache a
// single superadmin flipping tabs re-runs the full pipelines constantly.
// Entries live for DROP_CACHE_TTL; any successful write to a /drops-archive/*
// endpoint clears the cache, so the owner's own scans/sells/edits show up at
// once. Worst-case staleness for passive viewing is one TTL window.
// ------------------------------------------------------------------
const DROP_CACHE_TTL = 15000;
// How long a fresh-enough entry may still be served while a refresh runs in the
// background. Beyond this an entry is treated as gone and the caller waits.
const DROP_CACHE_STALE_TTL = 10 * 60 * 1000;
const dropCache = new Map(); // key -> { exp, staleExp, data }
const inFlight = new Map(); // key -> Promise, so N viewers cause 1 recompute

function dropCacheSet(key, data) {
  const now = Date.now();
  dropCache.set(key, {
    exp: now + DROP_CACHE_TTL,
    staleExp: now + DROP_CACHE_STALE_TTL,
    data,
  });
}
function bustDropCache() {
  dropCache.clear();
  _exclCache = null;
}

// Serve an expensive view without ever making two people pay for it at once.
//
// - fresh entry            -> returned immediately
// - expired but not stale  -> returned immediately, refreshed in the background
// - missing/too stale      -> compute, and anyone arriving meanwhile waits on
//                             the same promise instead of starting their own
//                             full pass over ~160k drops
//
// These views are rollups of a slowly-growing archive, so a few seconds of
// staleness is invisible — but a page load that blocks for 4s is not. Any
// successful write to /drops-archive/* still clears the cache outright, so an
// operator's own edits and scans show up at once.
async function cachedView(key, compute) {
  const entry = dropCache.get(key);
  const now = Date.now();
  if (entry && entry.exp > now) return entry.data;

  const refresh = () => {
    if (inFlight.has(key)) return inFlight.get(key);
    const p = (async () => {
      try {
        const data = await compute();
        dropCacheSet(key, data);
        return data;
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, p);
    return p;
  };

  if (entry && entry.staleExp > now) {
    // Stale-while-revalidate: hand back what we have, refresh behind the scenes.
    refresh().catch((e) =>
      console.error(
        "drops-archive background refresh (" + key + "):",
        e.message,
      ),
    );
    return entry.data;
  }
  return refresh();
}

// Invalidate on any successful mutation so writes are reflected immediately.
router.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return next();
  res.on("finish", () => {
    if (res.statusCode < 400) bustDropCache();
  });
  next();
});

// Same filename rules as the bot manager.
const FILE_RE = /^config(_\d{1,3})?\.json$/;

// Accounts whose Twitch token no longer works ("bad token" in the scan bar).
// They can't be logged into or farmed, so they're treated as trash: excluded
// from every cross-account / search / inventory view and from the main account
// list, and surfaced only in the dedicated "Bad tokens" tab (from where they
// can be pulled out of the bot config files with /bad-tokens/purge).
const BAD_STATUS = "token_invalid";

// _ids of the bad-token accounts, used to keep their drops out of the
// aggregations below. Small list (hundreds at most) so $nin stays cheap.
async function badAccountIds() {
  const rows = await BotAccount.find(
    { lastScanStatus: BAD_STATUS },
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
// item drill-down. We exclude it from every stock/count view alongside the
// bad-token accounts. Kept deliberately: a shadow that's already been sold
// (never hide a sale) and any login whose only records are all deployed (the
// rare same-account-in-two-bots case — a config problem, not a phantom row).
// Computed live from botaccounts (one small collection) — no data is modified,
// so turning this off later fully restores the old numbers.
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

// The full set of account _ids excluded from stock/count/inventory views:
// dead tokens plus shadow duplicates. Used everywhere a $nin filter guards an
// aggregation, so every view agrees on what counts as real, sellable stock.
async function excludedAccountIds() {
  const [bad, shadow] = await Promise.all([
    badAccountIds(),
    shadowDuplicateIds(),
  ]);
  return bad.concat(shadow);
}

// Cached wrapper: excludedAccountIds() runs two aggregations and is called by
// every heavy read endpoint, so one page load would otherwise recompute the
// same set three times. Memoized for DROP_CACHE_TTL; cleared by bustDropCache.
let _exclCache = null; // { exp, ids }
async function excludedAccountIdsCached() {
  if (_exclCache && _exclCache.exp > Date.now()) return _exclCache.ids;
  const ids = await excludedAccountIds();
  _exclCache = { exp: Date.now() + DROP_CACHE_TTL, ids };
  return ids;
}

function containerForFile(file) {
  const m = file.match(/^config_0*(\d+)\.json$/);
  if (m) return "twitchbotx" + parseInt(m[1], 10);
  if (file === "config.json") return "twitchbot";
  return "";
}

// Exactly the fields publicAccount() reads. Passing this as a projection keeps
// the two heavy account lists from hauling every account's clientSecret and
// encrypted password across the wire and into memory just to throw them away —
// measured 1116ms -> 563ms for 2.1k accounts, and a much smaller response.
const PUBLIC_ACCOUNT_FIELDS = {
  login: 1,
  twitchId: 1,
  configFile: 1,
  container: 1,
  host: 1,
  enabled: 1,
  dropCount: 1,
  lastScanAt: 1,
  lastScanStatus: 1,
  lastScanError: 1,
  hasPassword: 1,
  credUsername: 1,
  credEmail: 1,
  copiedCount: 1,
  lastCopiedAt: 1,
};

function publicAccount(a) {
  return {
    id: a._id,
    login: a.login,
    twitchId: a.twitchId,
    configFile: a.configFile,
    container: a.container,
    host: a.host || "local",
    enabled: a.enabled,
    dropCount: a.dropCount,
    lastScanAt: a.lastScanAt,
    lastScanStatus: a.lastScanStatus,
    lastScanError: a.lastScanError,
    hasPassword: a.hasPassword,
    credUsername: a.credUsername || "",
    credEmail: decrypt(a.credEmail),
    copiedCount: a.copiedCount || 0,
    lastCopiedAt: a.lastCopiedAt || null,
  };
}

// ------------------------------------------------------------------
// Progress (for the global progress bar)
// ------------------------------------------------------------------
router.get("/drops-archive/progress", requireSuperadmin, async (req, res) => {
  try {
    res.json({ success: true, progress: await scanner.getProgress() });
  } catch (err) {
    console.error("drops-archive progress error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ------------------------------------------------------------------
// Account list
// ------------------------------------------------------------------
router.get("/drops-archive/accounts", requireSuperadmin, async (req, res) => {
  try {
    // Accounts with no configFile aren't wired into any bot — usually a
    // stale leftover from a deleted/moved config (see stopIfNoAccounts /
    // dedupeAccounts in botConfigRoutes.js, which already treat these as
    // "not really placed" for the same reason). Left in, they show up as
    // confusing duplicates of the same login's real, deployed account. Their
    // drop history isn't hidden — By item/By game and the item drill-down
    // still include them — this only trims the account-management list.
    const q = { configFile: { $nin: ["", null] } };
    const search = String(req.query.search || "").trim();
    if (search) {
      const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      q.$or = [{ login: re }, { credUsername: re }, { configFile: re }];
    }
    const status = String(req.query.status || "").trim();
    if (["ok", "token_invalid", "error", "pending"].includes(status)) {
      q.lastScanStatus = status;
    } else {
      // Bad-token accounts have their own tab; keep them out of the main list
      // (and therefore out of the "search" the operator uses to build orders).
      q.lastScanStatus = { $ne: BAD_STATUS };
    }
    const limit = Math.min(Number(req.query.limit) || 1000, 5000);
    const load = async () => {
      const accounts = await BotAccount.find(q, PUBLIC_ACCOUNT_FIELDS)
        .sort({ login: 1 })
        .limit(limit)
        .lean();
      return { success: true, accounts: accounts.map(publicAccount) };
    };
    // The unfiltered list is what the page loads every time it opens, and it's
    // the same answer for every viewer — cache that one. Searches are typed
    // per-operator and would just fill the map with single-use entries, so
    // they always run live.
    const payload = search
      ? await load()
      : await cachedView("accounts:" + status + ":" + limit, load);
    res.json(payload);
  } catch (err) {
    console.error("drops-archive accounts error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ------------------------------------------------------------------
// Bad-token accounts (dead accounts) — their own tab + bulk removal
// ------------------------------------------------------------------
// List every account with a dead token. This is the "one spot" they live in;
// they appear nowhere else in the archive.
router.get("/drops-archive/bad-tokens", requireSuperadmin, async (req, res) => {
  try {
    const q = { lastScanStatus: BAD_STATUS };
    const search = String(req.query.search || "").trim();
    if (search) {
      const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      q.$or = [{ login: re }, { credUsername: re }, { configFile: re }];
    }
    const load = async () => {
      const accounts = await BotAccount.find(q, PUBLIC_ACCOUNT_FIELDS)
        .sort({ login: 1 })
        .limit(5000)
        .lean();
      return { success: true, accounts: accounts.map(publicAccount) };
    };
    // Same reasoning as the account list: cache the unfiltered tab, not searches.
    const payload = search
      ? await load()
      : await cachedView("bad-tokens", load);
    res.json(payload);
  } catch (err) {
    console.error("drops-archive bad-tokens error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Physically remove the bad-token accounts from the bot config files so the
// bots stop trying to use them. Each config file is read, its TwitchUsers array
// filtered to drop the dead accounts (matched by ClientSecret), and written
// back atomically (botHosts keeps a .bak). The account docs are kept — they
// just stay in the Bad tokens tab, disabled and with their bot placement
// cleared — so the record of "this was trash" isn't lost and a later
// "Sync from bots" won't re-import them (they're gone from every config).
router.post(
  "/drops-archive/bad-tokens/purge",
  requireSuperadmin,
  async (req, res) => {
    try {
      const bad = await BotAccount.find({ lastScanStatus: BAD_STATUS }).lean();
      if (!bad.length) {
        return res.json({
          success: true,
          removedFromConfigs: 0,
          filesUpdated: 0,
          accountsUpdated: 0,
          offlineHosts: [],
          missingFiles: [],
        });
      }

      // Group the dead accounts by host + config file so each file is only
      // read/rewritten once.
      const byHostFile = new Map(); // host -> Map(file -> Set(clientSecret))
      const secretToId = new Map();
      for (const a of bad) {
        const secret = String(a.clientSecret || "").trim();
        if (secret) secretToId.set(secret, a._id);
        const file = a.configFile || "";
        if (!file || !FILE_RE.test(file) || !secret) continue;
        const hostId = a.host || "local";
        if (!byHostFile.has(hostId)) byHostFile.set(hostId, new Map());
        const byFile = byHostFile.get(hostId);
        if (!byFile.has(file)) byFile.set(file, new Set());
        byFile.get(file).add(secret);
      }

      let removedFromConfigs = 0;
      let filesUpdated = 0;
      const offlineHosts = new Set();
      const missingFiles = [];
      const removedSecrets = new Set();

      for (const [hostId, byFile] of byHostFile) {
        const host = hosts.resolveHost(hostId);
        if (!host) continue;

        for (const [file, secrets] of byFile) {
          let data;
          try {
            data = JSON.parse(await hosts.readFile(host, file));
          } catch (e) {
            if (e.unreachable) {
              offlineHosts.add(hostId);
            } else if (e.code === "ENOENT") {
              missingFiles.push(file);
            }
            continue;
          }

          const ts = data.TwitchSettings;
          const users =
            ts && Array.isArray(ts.TwitchUsers) ? ts.TwitchUsers : null;
          if (!users || !users.length) continue;

          const kept = [];
          let removed = 0;
          for (const u of users) {
            const tok =
              typeof u.ClientSecret === "string" ? u.ClientSecret.trim() : "";
            if (tok && secrets.has(tok)) {
              removed++;
              removedSecrets.add(tok);
            } else {
              kept.push(u);
            }
          }
          if (!removed) continue;

          ts.TwitchUsers = kept;
          try {
            await hosts.writeFileAtomic(
              host,
              file,
              JSON.stringify(data, null, 2) + "\n",
            );
          } catch (e) {
            if (e.unreachable) offlineHosts.add(hostId);
            continue;
          }
          removedFromConfigs += removed;
          filesUpdated++;
          // A purge can empty a config out entirely — a running bot with no
          // accounts left hits TwitchDropsBot's infinite-retry-loop bug (see
          // utils/botHosts.js), so stop it rather than leave it spinning.
          if (!kept.length) {
            await hosts
              .stopIfNoAccounts(host, file, containerForFile(file))
              .catch(() => {});
          }
        }
      }

      // Disable and un-place the accounts we actually pulled from a config, so
      // the tab can flag them "removed from bots" and nothing picks them up
      // again. The doc itself is retained as the permanent trash record.
      let accountsUpdated = 0;
      if (removedSecrets.size) {
        const ids = [...removedSecrets]
          .map((s) => secretToId.get(s))
          .filter(Boolean);
        if (ids.length) {
          const r = await BotAccount.updateMany(
            { _id: { $in: ids } },
            { $set: { enabled: false, container: "", configFile: "" } },
          );
          accountsUpdated = r.modifiedCount || r.nModified || 0;
        }
      }

      res.json({
        success: true,
        removedFromConfigs,
        filesUpdated,
        accountsUpdated,
        offlineHosts: [...offlineHosts],
        missingFiles,
      });
    } catch (err) {
      console.error("drops-archive bad-tokens purge error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// ------------------------------------------------------------------
// One account + its drops grouped by game
// ------------------------------------------------------------------
router.get(
  "/drops-archive/accounts/:id",
  requireSuperadmin,
  async (req, res) => {
    try {
      const acc = await BotAccount.findById(req.params.id).lean();
      if (!acc) {
        return res
          .status(404)
          .json({ success: false, message: "Account not found" });
      }
      const drops = await DropLog.find({ account: acc._id })
        .sort({ awardedAt: -1, lastSeenAt: -1 })
        .lean();
      const byGame = new Map();
      for (const d of drops) {
        const g = d.game || "Other rewards";
        if (!byGame.has(g)) byGame.set(g, []);
        byGame.get(g).push({
          benefitId: d.benefitId,
          itemKey: d.itemKey,
          name: d.name,
          image: d.imageLocal || d.imageURL,
          game: d.game,
          campaign: d.campaign,
          count: d.count,
          awardedAt: d.awardedAt,
          state: d.state,
          connected: d.connected,
          requiredAccountLink: d.requiredAccountLink,
          firstSeenAt: d.firstSeenAt,
          lastSeenAt: d.lastSeenAt,
        });
      }
      const games = [...byGame.entries()].map(([game, items]) => ({
        game,
        items,
      }));
      res.json({
        success: true,
        account: publicAccount(acc),
        totalDrops: drops.length,
        games,
      });
    } catch (err) {
      console.error("drops-archive account detail error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// Reveal the decrypted password for one account (superadmin only, on demand).
router.get(
  "/drops-archive/accounts/:id/password",
  requireSuperadmin,
  async (req, res) => {
    try {
      const acc = await BotAccount.findById(req.params.id).lean();
      if (!acc) {
        return res
          .status(404)
          .json({ success: false, message: "Account not found" });
      }
      res.json({ success: true, password: decrypt(acc.credPassword) });
    } catch (err) {
      console.error("drops-archive reveal error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// Manually edit credentials for one account.
router.put(
  "/drops-archive/accounts/:id",
  requireSuperadmin,
  async (req, res) => {
    try {
      const acc = await BotAccount.findById(req.params.id);
      if (!acc) {
        return res
          .status(404)
          .json({ success: false, message: "Account not found" });
      }
      const body = req.body || {};
      if (typeof body.username === "string")
        acc.credUsername = body.username.trim();
      if (typeof body.email === "string")
        acc.credEmail = encrypt(body.email.trim());
      if (typeof body.password === "string") {
        acc.credPassword = encrypt(body.password);
        acc.hasPassword = !!body.password;
      }
      await acc.save();
      res.json({ success: true, account: publicAccount(acc) });
    } catch (err) {
      console.error("drops-archive edit error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// Record that this account's credentials were copied (delivery bookkeeping),
// so the UI can flag accounts that were already handed out.
router.post(
  "/drops-archive/accounts/:id/copied",
  requireSuperadmin,
  async (req, res) => {
    try {
      const acc = await BotAccount.findByIdAndUpdate(
        req.params.id,
        { $inc: { copiedCount: 1 }, $set: { lastCopiedAt: new Date() } },
        { new: true },
      ).lean();
      if (!acc) {
        return res
          .status(404)
          .json({ success: false, message: "Account not found" });
      }
      res.json({
        success: true,
        copiedCount: acc.copiedCount || 0,
        lastCopiedAt: acc.lastCopiedAt,
      });
    } catch (err) {
      console.error("drops-archive copied error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// ------------------------------------------------------------------
// Manual "mark sold" — for marketplaces with no API, where the operator
// copies credentials out of the archive and delivers by hand. Reserves ONE
// game's drops on the account (the rest stay sellable), pulls the account
// out of any live auto-lister listing that sells the sold game, and writes a
// SaleSignal so the auto-farmer's demand learning sees the sale.
// ------------------------------------------------------------------

// What could be sold on this account: its games with per-game drop states,
// plus the live listings the account is attached to.
router.get(
  "/drops-archive/accounts/:id/sale-info",
  requireSuperadmin,
  async (req, res) => {
    try {
      const acc = await BotAccount.findById(req.params.id, {
        login: 1,
      }).lean();
      if (!acc) {
        return res
          .status(404)
          .json({ success: false, message: "Account not found" });
      }
      const games = await DropLog.aggregate([
        { $match: { account: acc._id } },
        {
          $group: {
            _id: { $ifNull: ["$game", ""] },
            total: { $sum: 1 },
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
            redeemed: { $sum: { $cond: [{ $eq: ["$connected", true] }, 1, 0] } },
            reserved: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $ne: ["$connected", true] },
                      { $ne: [{ $ifNull: ["$soldAt", null] }, null] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
        { $sort: { available: -1, total: -1 } },
      ]);
      const idRe = new RegExp(
        "(^|,\\s*)" + String(acc._id) + "(\\s*,|$)",
      );
      const listings = await MarketplaceListing.find(
        { status: "active", accountId: idRe },
        { marketplace: 1, externalId: 1, title: 1, price: 1, set: 1 },
      ).lean();
      res.json({
        success: true,
        login: acc.login || "",
        games: games.map((g) => ({
          game: g._id || "Other rewards",
          gameValue: g._id,
          total: g.total,
          available: g.available,
          redeemed: g.redeemed,
          reserved: g.reserved,
        })),
        listings: listings.map((l) => ({
          marketplace: l.marketplace,
          externalId: l.externalId,
          title: l.title,
          price: l.price,
        })),
      });
    } catch (err) {
      console.error("drops-archive sale-info error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// Remove one account from a listing row's comma-separated account fields.
async function detachAccountFromRow(listing, accountId, login) {
  const ids = String(listing.accountId || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => x !== String(accountId));
  const lower = String(login || "").trim().toLowerCase();
  const logins = String(listing.accountLogin || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => !lower || x.toLowerCase() !== lower);
  await MarketplaceListing.updateOne(
    { _id: listing._id },
    { $set: { accountId: ids.join(","), accountLogin: logins.join(", ") } },
  );
}

// Does this listing's set sell the given game? Uses sameGame() so formatting
// drift between the DropLog label and a DropSet item label can't make this
// silently miss and leave a sold account in a live same-game listing.
async function listingSellsGame(listing, gameLabel) {
  const set = listing.set ? await DropSet.findById(listing.set).lean() : null;
  if (!set) return true; // no set to check — assume affected, safer to detach
  return (set.items || []).some((i) => {
    const g = String(i.game || "").trim() ||
      String(i.itemKey || "").split("|")[1] || "";
    return sameGame(g, gameLabel);
  });
}

router.post(
  "/drops-archive/accounts/:id/mark-sold",
  requireSuperadmin,
  async (req, res) => {
    try {
      const acc = await BotAccount.findById(req.params.id).lean();
      if (!acc) {
        return res
          .status(404)
          .json({ success: false, message: "Account not found" });
      }
      const body = req.body || {};
      if (!("game" in body)) {
        return res
          .status(400)
          .json({ success: false, message: "game required" });
      }
      const game = String(body.game || "").trim(); // "" = Other rewards
      const buyer = String(body.buyer || "").trim();
      const now = new Date();
      const stamp = {
        soldAt: now,
        soldToUsername: "manual" + (buyer ? ":" + buyer : ""),
        soldToAdminId: "",
        soldSetId: "",
        soldBulkOrderId: "",
      };
      const gameMatch = game
        ? { game }
        : { $or: [{ game: "" }, { game: null }] };
      const upd = await DropLog.updateMany(
        {
          account: acc._id,
          ...gameMatch,
          connected: { $ne: true },
          soldAt: null,
        },
        { $set: stamp },
      );
      if (!upd.modifiedCount) {
        return res.status(409).json({
          success: false,
          message:
            "No available (unredeemed, unreserved) drops for that game on " +
            (acc.login || "this account"),
        });
      }
      // Shadow onto the account (first reservation wins) — same as the
      // Shop/marketplace sale path.
      await BotAccount.updateOne(
        { _id: acc._id, soldAt: null },
        { $set: stamp },
      ).catch(() => {});
      // Demand learning: one signal per (account, game), same shape the
      // automated sale paths write.
      const gameLabel = game || "Other rewards";
      await SaleSignal.updateOne(
        {
          dedupeKey:
            "manual-sold:" + acc._id + ":" + gameLabel.toLowerCase(),
        },
        {
          $setOnInsert: {
            game: gameLabel,
            gameKey: gameLabel.toLowerCase(),
            itemKey: "",
            name: "manual sale",
            login: acc.login || "",
            account: acc._id,
            source: "drop_reserved",
            at: now,
          },
        },
        { upsert: true },
      ).catch(() => {});

      // Pull the account out of live listings that sell the sold game. Other
      // games' listings keep it — that stock is still real.
      const detached = [];
      const warnings = [];
      const idRe = new RegExp("(^|,\\s*)" + String(acc._id) + "(\\s*,|$)");
      const listings = await MarketplaceListing.find({
        status: "active",
        accountId: idRe,
      }).lean();
      for (const row of listings) {
        if (!(await listingSellsGame(row, gameLabel))) continue;
        const label = row.marketplace + " " + row.externalId;
        try {
          if (row.marketplace === "gameflip" && row.autoDeliver) {
            // The live Gameflip listing carries this account's credentials in
            // its delivery code — it must come down, then the chain continues
            // with a fresh account if one exists.
            await mp.gameflipDelist(row.externalId).catch(() => {});
            await MarketplaceListing.updateOne(
              { _id: row._id },
              {
                $set: {
                  status: "delisted",
                  note: "account sold manually — delisted",
                },
              },
            );
            detached.push(label + " (delisted)");
            const set = row.set
              ? await DropSet.findById(row.set).lean()
              : null;
            if (set) {
              let img = "";
              try {
                img = await buildSetGridImage(set);
              } catch {
                img = "";
              }
              try {
                const fresh = await gfFulfiller.publishAutoDelivery({
                  set,
                  title: row.title,
                  description: row.description,
                  priceUsd: row.price,
                  imagePath: img,
                  qtyRemaining: Number(row.qtyRemaining) || 0,
                  origin: row.origin,
                });
                detached.push(
                  "republished on gameflip as " +
                    fresh.externalId +
                    " with " +
                    (fresh.accountLogin || "a fresh account"),
                );
              } catch (e) {
                warnings.push(
                  label +
                    " was delisted but could not be republished: " +
                    e.message,
                );
              } finally {
                if (img) await fsp.unlink(img).catch(() => {});
              }
            }
          } else if (
            row.marketplace === "digiseller" &&
            (row.units || []).some(
              (u) => u && String(u.accountId) === String(acc._id) && u.contentId,
            )
          ) {
            const unit = (row.units || []).find(
              (u) => u && String(u.accountId) === String(acc._id) && u.contentId,
            );
            await mp.digisellerRemoveContent(row.externalId, unit.contentId);
            await MarketplaceListing.updateOne(
              { _id: row._id },
              { $pull: { units: { contentId: String(unit.contentId) } } },
            );
            await detachAccountFromRow(row, acc._id, acc.login);
            detached.push(label + " (delivery unit removed)");
            try {
              await guardian.feedOne(String(row._id));
            } catch {
              /* auto-feed refills on its next pass */
            }
          } else if (
            row.marketplace === "digiseller" ||
            row.marketplace === "ggsel"
          ) {
            await detachAccountFromRow(row, acc._id, acc.login);
            detached.push(label + " (detached)");
            try {
              await guardian.feedOne(String(row._id));
            } catch {
              /* auto-feed refills on its next pass */
            }
          } else {
            warnings.push(
              label +
                " still references this account — remove it there manually",
            );
          }
        } catch (e) {
          warnings.push(label + ": " + e.message);
        }
      }

      bustDropCache();
      res.json({
        success: true,
        message:
          "Marked " +
          upd.modifiedCount +
          " " +
          gameLabel +
          " drop(s) sold on " +
          (acc.login || String(acc._id)),
        reserved: upd.modifiedCount,
        detached,
        warnings,
      });
    } catch (err) {
      console.error("drops-archive mark-sold error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// Queue an on-demand scan of a whole bot set (by container or config file).
// Accounts are scanned back-to-back by the scanner's priority queue instead
// of waiting for the daily rotation.
router.post("/drops-archive/scan-set", requireSuperadmin, async (req, res) => {
  try {
    const body = req.body || {};
    const container = String(body.container || "").trim();
    const configFile = String(body.configFile || "").trim();
    const host = String(body.host || "").trim();
    const filter = {};
    if (container) filter.container = container;
    if (configFile) filter.configFile = configFile;
    // "local" also matches pre-multi-host rows where the field is absent
    // (Mongoose defaults don't backfill existing documents).
    if (host === "local") filter.host = { $in: ["local", "", null] };
    else if (host) filter.host = host;
    if (!container && !configFile) {
      return res
        .status(400)
        .json({ success: false, message: "container or configFile required" });
    }
    const label =
      (container || configFile) +
      (host && host !== "local" ? " [" + host + "]" : "");
    const r = await scanner.queueSetScan(filter, label);
    res.json({ success: true, ...r });
  } catch (err) {
    console.error("drops-archive scan-set error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Force-scan one account immediately.
router.post(
  "/drops-archive/accounts/:id/scan",
  requireSuperadmin,
  async (req, res) => {
    try {
      const result = await scanner.scanAccountNow(req.params.id);
      res.json({ success: !!result.ok, result });
    } catch (err) {
      console.error("drops-archive scan error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// ------------------------------------------------------------------
// Sync accounts from the bot config files
// ------------------------------------------------------------------
// A full sync (many config files, possibly over SSH to remote hosts) can take
// several minutes, which outlives typical reverse-proxy request timeouts and
// surfaces as a 504 even though the work keeps going. So the route only kicks
// the sync off and the client polls /drops-archive/sync/status.
let syncState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  result: null,
  error: null,
};

// Duplicate accounts found by the most recent sync — the same account
// (ClientSecret) present in more than one bot config, which means two bots
// are simultaneously farming with the same Twitch session. Populated as a
// side effect of runSync()'s walk so detecting duplicates doesn't need its
// own separate pass over every host. Null until a sync has run at least once.
let lastDuplicates = null;

// Password mirroring from the account pool lives in utils/poolPasswords so
// the deploy paste (botConfigRoutes) and the pool import mirror too, not just
// this manual sync.

async function runSync() {
  let found = 0;
  let inserted = 0;
  let updated = 0;
  let filesRead = 0;
  const offlineHosts = [];
  // clientSecret -> every (host, file) it was seen in during this walk.
  const occurrences = new Map();

  // Sync across every managed host (the local server plus any remote hosts),
  // so accounts running on a Raspberry Pi etc. are tracked too. A host that's
  // unreachable is skipped (best effort) and reported back.
  for (const h of hosts.listHosts()) {
    const host = hosts.resolveHost(h.id);
    let files;
    try {
      files = await hosts.readdir(host);
    } catch (e) {
      if (e.unreachable) {
        offlineHosts.push(host.id);
        continue;
      }
      // Local config dir missing is a hard error; remote dir issues are soft.
      if (host.id === "local") {
        throw new Error(
          "Config directory not found: " +
            host.dir +
            " (" +
            (e.code || e.message) +
            ")",
        );
      }
      offlineHosts.push(host.id);
      continue;
    }
    const configs = files.filter((f) => FILE_RE.test(f)).sort();
    for (const file of configs) {
      let data;
      try {
        data = JSON.parse(await hosts.readFile(host, file));
      } catch {
        continue;
      }
      filesRead++;
      const users =
        (data.TwitchSettings && data.TwitchSettings.TwitchUsers) || [];
      // One bulk upsert per config file instead of a round trip per account.
      const ops = [];
      for (const u of users) {
        const token =
          typeof u.ClientSecret === "string" ? u.ClientSecret.trim() : "";
        if (!token) continue;
        found++;
        if (!occurrences.has(token)) occurrences.set(token, []);
        occurrences.get(token).push({
          host: host.id,
          file,
          login: u.Login || "",
          enabled: u.Enabled !== false,
        });
        ops.push({
          updateOne: {
            filter: { clientSecret: token },
            update: {
              $set: {
                login: u.Login || "",
                twitchId: u.Id == null ? "" : String(u.Id),
                uniqueId: u.UniqueId || "",
                configFile: file,
                container: containerForFile(file),
                host: host.id,
                enabled: u.Enabled !== false,
              },
            },
            upsert: true,
          },
        });
      }
      if (ops.length) {
        const r = await BotAccount.bulkWrite(ops, { ordered: false });
        inserted += r.upsertedCount || 0;
        updated += r.modifiedCount || 0;
      }
    }
  }

  // Any account recorded against a host we successfully read this pass, but
  // whose token wasn't actually seen inside any config file this pass, has a
  // stale placement — its bot was deleted (or moved) since the last sync.
  // Checking against `occurrences` (built from each file's real contents,
  // above) rather than just "does a file with this name still exist" matters
  // because slot numbers get reused: deleting the highest-numbered bot and
  // creating a new one both land on the same filename (e.g. config_08.json),
  // so a filename-only check would wrongly treat the old bot's accounts as
  // still live just because *a* file with that name exists again.
  const syncedHostIds = hosts
    .listHosts()
    .map((h) => h.id)
    .filter((id) => !offlineHosts.includes(id));
  if (syncedHostIds.length) {
    await BotAccount.updateMany(
      {
        host: { $in: syncedHostIds },
        configFile: { $nin: ["", null] },
        clientSecret: { $nin: [...occurrences.keys()] },
      },
      { $set: { configFile: "", container: "" } },
    ).catch(() => {});
  }

  lastDuplicates = [...occurrences.entries()]
    .filter(([, occ]) => occ.length > 1)
    .map(([clientSecret, occ]) => ({
      clientSecret,
      login: occ.find((o) => o.login)?.login || "",
      occurrences: occ,
    }));

  // Mirror pool passwords onto any newly-synced accounts that lack one, so
  // farmed stock is sellable without a manual backfill.
  const passwordsFilled = await fillBotPasswordsFromPool().catch(() => 0);
  // Sweep: any pool row still "available" whose account is deployed in a
  // config gets marked claimed, healing drift from deploys that predate the
  // auto-marking (or any path that bypassed it).
  const poolClaimed = await markDeployedPoolAccountsClaimed().catch(() => 0);

  return {
    filesRead,
    accountsFound: found,
    inserted,
    updated,
    passwordsFilled,
    poolClaimed,
    offlineHosts,
    duplicateAccounts: lastDuplicates.length,
  };
}

router.post("/drops-archive/sync", requireSuperadmin, (req, res) => {
  if (syncState.running) {
    return res.json({ success: true, started: false, running: true });
  }
  syncState = {
    running: true,
    startedAt: new Date(),
    finishedAt: null,
    result: null,
    error: null,
  };
  runSync()
    .then((result) => {
      syncState.running = false;
      syncState.finishedAt = new Date();
      syncState.result = result;
    })
    .catch((err) => {
      console.error("drops-archive sync error:", err.message);
      syncState.running = false;
      syncState.finishedAt = new Date();
      syncState.error = err.message;
    });
  res.json({ success: true, started: true, running: true });
});

router.get("/drops-archive/sync/status", requireSuperadmin, (req, res) => {
  res.json({ success: true, ...syncState });
});

// ------------------------------------------------------------------
// Duplicate accounts (same ClientSecret in more than one bot config) — a
// side effect of the last sync's walk, so this just reads what it found
// rather than re-walking every host again.
// ------------------------------------------------------------------
function maskToken(v) {
  if (!v) return "";
  if (v.length <= 4) return "****";
  return v.slice(0, 3) + "…" + v.slice(-2);
}

router.get("/drops-archive/duplicates", requireSuperadmin, async (req, res) => {
  if (lastDuplicates === null) {
    return res.json({
      success: true,
      ranAt: null,
      duplicates: [],
      message: "Run a sync first to check for duplicates.",
    });
  }
  if (!lastDuplicates.length) {
    return res.json({
      success: true,
      ranAt: syncState.finishedAt,
      duplicates: [],
    });
  }
  const canonical = await BotAccount.find(
    { clientSecret: { $in: lastDuplicates.map((d) => d.clientSecret) } },
    { clientSecret: 1, host: 1, configFile: 1 },
  ).lean();
  const canonicalBySecret = new Map(canonical.map((c) => [c.clientSecret, c]));

  res.json({
    success: true,
    ranAt: syncState.finishedAt,
    duplicates: lastDuplicates.map((d) => {
      const c = canonicalBySecret.get(d.clientSecret);
      const keep =
        c &&
        d.occurrences.some((o) => o.host === c.host && o.file === c.configFile)
          ? { host: c.host, file: c.configFile }
          : null;
      return {
        token: maskToken(d.clientSecret),
        login: d.login,
        occurrences: d.occurrences,
        keep,
      };
    }),
  });
});

// Resolve every known duplicate group by keeping whichever bot BotAccount
// currently considers canonical for that account (the same pointer the rest
// of the app already treats as "where this account lives") and removing it
// from every other config file it was also found in. Requires a sync to have
// run first; a group whose BotAccount pointer doesn't match any occurrence
// from that sync (e.g. the account moved again since) is left alone rather
// than guessed at.
router.post(
  "/drops-archive/duplicates/purge",
  requireSuperadmin,
  async (req, res) => {
    if (!lastDuplicates || !lastDuplicates.length) {
      return res.json({
        success: true,
        groupsResolved: 0,
        groupsSkipped: 0,
        removedFromConfigs: 0,
        filesUpdated: 0,
        offlineHosts: [],
        missingFiles: [],
      });
    }
    try {
      const secrets = lastDuplicates.map((d) => d.clientSecret);
      const canonical = await BotAccount.find(
        { clientSecret: { $in: secrets } },
        { clientSecret: 1, host: 1, configFile: 1 },
      ).lean();
      const canonicalBySecret = new Map(
        canonical.map((c) => [c.clientSecret, c]),
      );

      // Group removals by host + config file so each file is only
      // read/rewritten once, same as the bad-tokens purge above.
      const byHostFile = new Map(); // host -> Map(file -> Set(clientSecret))
      let groupsSkipped = 0;
      const resolvedGroups = [];
      for (const d of lastDuplicates) {
        const keep = canonicalBySecret.get(d.clientSecret);
        const keepMatchesOccurrence =
          keep &&
          d.occurrences.some(
            (o) => o.host === keep.host && o.file === keep.configFile,
          );
        if (!keepMatchesOccurrence) {
          groupsSkipped++;
          continue;
        }
        resolvedGroups.push(d);
        for (const o of d.occurrences) {
          if (o.host === keep.host && o.file === keep.configFile) continue;
          if (!byHostFile.has(o.host)) byHostFile.set(o.host, new Map());
          const byFile = byHostFile.get(o.host);
          if (!byFile.has(o.file)) byFile.set(o.file, new Set());
          byFile.get(o.file).add(d.clientSecret);
        }
      }

      let removedFromConfigs = 0;
      let filesUpdated = 0;
      const offlineHosts = new Set();
      const missingFiles = [];

      for (const [hostId, byFile] of byHostFile) {
        const host = hosts.resolveHost(hostId);
        if (!host) continue;

        for (const [file, secretSet] of byFile) {
          let data;
          try {
            data = JSON.parse(await hosts.readFile(host, file));
          } catch (e) {
            if (e.unreachable) {
              offlineHosts.add(hostId);
            } else if (e.code === "ENOENT") {
              missingFiles.push(file);
            }
            continue;
          }

          const ts = data.TwitchSettings;
          const users =
            ts && Array.isArray(ts.TwitchUsers) ? ts.TwitchUsers : null;
          if (!users || !users.length) continue;

          const kept = [];
          let removed = 0;
          for (const u of users) {
            const tok =
              typeof u.ClientSecret === "string" ? u.ClientSecret.trim() : "";
            if (tok && secretSet.has(tok)) {
              removed++;
            } else {
              kept.push(u);
            }
          }
          if (!removed) continue;

          ts.TwitchUsers = kept;
          try {
            await hosts.writeFileAtomic(
              host,
              file,
              JSON.stringify(data, null, 2) + "\n",
            );
          } catch (e) {
            if (e.unreachable) offlineHosts.add(hostId);
            continue;
          }
          removedFromConfigs += removed;
          filesUpdated++;
          // Same reasoning as the bad-tokens purge: don't leave a bot
          // running with zero accounts, it'll hit TwitchDropsBot's
          // infinite-retry-loop bug (utils/botHosts.js).
          if (!kept.length) {
            await hosts
              .stopIfNoAccounts(host, file, containerForFile(file))
              .catch(() => {});
          }
        }
      }

      // Optimistically drop resolved groups from the in-memory report so the
      // tab reflects the cleanup immediately, without waiting on another
      // full sync.
      const resolvedSecrets = new Set(
        resolvedGroups.map((d) => d.clientSecret),
      );
      lastDuplicates = lastDuplicates.filter(
        (d) => !resolvedSecrets.has(d.clientSecret),
      );

      res.json({
        success: true,
        groupsResolved: resolvedGroups.length,
        groupsSkipped,
        removedFromConfigs,
        filesUpdated,
        offlineHosts: [...offlineHosts],
        missingFiles,
      });
    } catch (err) {
      console.error("drops-archive duplicates purge error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// ------------------------------------------------------------------
// Import credentials ({username, password, email}[]), match by login
// ------------------------------------------------------------------
router.post(
  "/drops-archive/credentials",
  requireSuperadmin,
  async (req, res) => {
    try {
      let list = req.body && req.body.accounts;
      if (typeof list === "string") {
        // Tolerate a pasted loose object sequence like the bot manager does.
        const trimmed = list.trim().replace(/,\s*$/, "");
        try {
          list = JSON.parse("[" + trimmed.replace(/^\[|\]$/g, "") + "]");
        } catch {
          try {
            list = JSON.parse(trimmed);
          } catch {
            return res
              .status(400)
              .json({ success: false, message: "Could not parse JSON" });
          }
        }
      }
      if (!Array.isArray(list)) {
        return res
          .status(400)
          .json({ success: false, message: "Expected an array of accounts" });
      }
      // Build a single in-memory index of login/credUsername → account id so
      // matching is one DB read + one bulk write, instead of a regex findOne +
      // save per imported row (which was N round-trips and used no index).
      const accounts = await BotAccount.find(
        {},
        { login: 1, credUsername: 1 },
      ).lean();
      // A login can map to MORE THAN ONE account record (identity is the
      // ClientSecret, and a re-minted+redeployed token leaves a duplicate that
      // shares the login). Map each key to every matching _id so the creds land
      // on ALL of them — otherwise the live/deployed copy can be left without a
      // password and show as "no pw" (unsellable) while a stale duplicate holds
      // the creds. Dedup by id string so an account whose login == credUsername
      // isn't listed twice.
      const byKey = new Map(); // key -> Map(idString -> _id)
      for (const a of accounts) {
        for (const k of [a.login, a.credUsername]) {
          const key = String(k || "")
            .trim()
            .toLowerCase();
          if (!key) continue;
          if (!byKey.has(key)) byKey.set(key, new Map());
          byKey.get(key).set(String(a._id), a._id);
        }
      }

      let matched = 0;
      let recordsUpdated = 0;
      const unmatched = [];
      const ops = [];
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const username = String(item.username || "").trim();
        if (!username) continue;
        const ids = byKey.get(username.toLowerCase());
        if (!ids || !ids.size) {
          unmatched.push(username);
          continue;
        }
        const set = { credUsername: username };
        if (item.email != null)
          set.credEmail = encrypt(String(item.email).trim());
        if (item.password != null) {
          set.credPassword = encrypt(String(item.password));
          set.hasPassword = !!String(item.password);
        }
        for (const id of ids.values()) {
          ops.push({
            updateOne: { filter: { _id: id }, update: { $set: set } },
          });
          recordsUpdated++;
        }
        matched++;
      }
      if (ops.length) await BotAccount.bulkWrite(ops, { ordered: false });
      res.json({
        success: true,
        matched,
        recordsUpdated,
        unmatched,
        unmatchedCount: unmatched.length,
      });
    } catch (err) {
      console.error("drops-archive credentials error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// ------------------------------------------------------------------
// Scheduler controls (pause/resume, rate)
// ------------------------------------------------------------------
router.post("/drops-archive/scheduler", requireSuperadmin, (req, res) => {
  const body = req.body || {};
  if (typeof body.enabled === "boolean") scanner.setEnabled(body.enabled);
  if (body.intervalMs != null) scanner.setIntervalMs(body.intervalMs);
  res.json({ success: true });
});

// ------------------------------------------------------------------
// Aggregated / cross-account views (for building sell orders)
// ------------------------------------------------------------------
function searchRegex(s) {
  return new RegExp(String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

// Grouping key for every aggregate view. This is the STORED, indexed itemKey —
// not a per-document computation.
//
// It used to be a $cond that recomputed name|game whenever itemKey was empty,
// as a guard for rows logged before the field existed. That guard ran
// $strLenCP + two $toLower/$trim + $concat against all ~160k drops on every
// pass of every archive view: measured 633ms vs 258ms for the same grouping on
// the stored field. The guard is no longer needed — the scanner now always
// writes a key (utils/dropScanner.js), the startup backfill fills any legacy
// row, and a prod check found 0 of 158,944 rows without one. Grouping on the
// bare field is also what lets these pipelines use the itemKey index.
const ITEM_KEY_FIELD = "$itemKey";

// High-level totals for the dashboard header. Bad-token accounts (and their
// drops) are left out so the header only counts sellable stock. Pool-account
// drops (accountModel: "AvailableAccount" — checked but not deployed to any
// bot yet) are also excluded from these deployed/sellable numbers and
// reported separately as poolItems/poolDrops instead of inflating them.
router.get("/drops-archive/overview", requireSuperadmin, async (req, res) => {
  try {
    const payload = await cachedView("overview", async () => {
      const badIds = await excludedAccountIdsCached();
      const dropMatch = {
        account: { $nin: badIds },
        accountModel: { $ne: "AvailableAccount" },
      };
      const poolMatch = { accountModel: "AvailableAccount" };
      const [
        accounts,
        totalDrops,
        totalItemsHeld,
        games,
        items,
        poolDrops,
        poolItems,
      ] = await Promise.all([
        BotAccount.countDocuments({ lastScanStatus: { $ne: BAD_STATUS } }),
        DropLog.countDocuments(dropMatch),
        DropLog.aggregate([
          { $match: dropMatch },
          { $group: { _id: null, n: { $sum: "$count" } } },
        ]),
        DropLog.distinct("game", dropMatch),
        DropLog.aggregate([
          { $match: dropMatch },
          { $group: { _id: ITEM_KEY_FIELD } },
          { $count: "n" },
        ]),
        DropLog.countDocuments(poolMatch),
        DropLog.aggregate([
          { $match: poolMatch },
          { $group: { _id: ITEM_KEY_FIELD } },
          { $count: "n" },
        ]),
      ]);
      return {
        success: true,
        overview: {
          accounts,
          totalDrops,
          totalItemsHeld: (totalItemsHeld[0] && totalItemsHeld[0].n) || 0,
          games: games.filter(Boolean).length,
          items: (items[0] && items[0].n) || 0,
          poolDrops,
          poolItems: (poolItems[0] && poolItems[0].n) || 0,
        },
      };
    });
    res.json(payload);
  } catch (err) {
    console.error("drops-archive overview error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// One row per game: how many rewards, distinct items, accounts, total held —
// split into deployed (BotAccount) vs. in-pool (AvailableAccount, checked but
// not wired into a bot yet) rather than merging them into one number.
router.get("/drops-archive/by-game", requireSuperadmin, async (req, res) => {
  try {
    const payload = await cachedView("by-game", async () => {
      const badIds = await excludedAccountIdsCached();
      const isPool = { $eq: ["$accountModel", "AvailableAccount"] };
      const rows = await DropLog.aggregate([
        { $match: { account: { $nin: badIds } } },
        {
          $group: {
            _id: "$game",
            drops: { $sum: { $cond: [isPool, 0, 1] } },
            totalCount: { $sum: { $cond: [isPool, 0, "$count"] } },
            accounts: {
              $addToSet: { $cond: [isPool, "$$REMOVE", "$account"] },
            },
            items: {
              $addToSet: { $cond: [isPool, "$$REMOVE", ITEM_KEY_FIELD] },
            },
            poolDrops: { $sum: { $cond: [isPool, 1, 0] } },
            poolCount: { $sum: { $cond: [isPool, "$count", 0] } },
            poolAccounts: {
              $addToSet: { $cond: [isPool, "$account", "$$REMOVE"] },
            },
            poolItems: {
              $addToSet: { $cond: [isPool, ITEM_KEY_FIELD, "$$REMOVE"] },
            },
          },
        },
        {
          $project: {
            _id: 0,
            game: "$_id",
            drops: 1,
            totalCount: 1,
            accounts: { $size: "$accounts" },
            items: { $size: "$items" },
            poolDrops: 1,
            poolCount: 1,
            poolAccounts: { $size: "$poolAccounts" },
            poolItems: { $size: "$poolItems" },
          },
        },
        { $sort: { totalCount: -1 } },
      ]);
      return { success: true, games: rows };
    });
    res.json(payload);
  } catch (err) {
    console.error("drops-archive by-game error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// One row per distinct item (reward), collapsed across all accounts. This is
// the inventory view for selling: name, game, image, total held, # accounts.
router.get("/drops-archive/by-item", requireSuperadmin, async (req, res) => {
  try {
    const game = String(req.query.game || "").trim();
    const search = String(req.query.search || "").trim();
    const cacheKey = "by-item:" + game + "\u0000" + search;
    const payload = await cachedView(cacheKey, async () => {
      const badIds = await excludedAccountIdsCached();
      const match = { account: { $nin: badIds } };
      if (game) match.game = game === "Other rewards" ? "" : game;
      if (search) match.name = searchRegex(search);

      const isPool = { $eq: ["$accountModel", "AvailableAccount"] };
      const notPool = { $not: isPool };

      // Two lean aggregations instead of one. Prod Mongo is an Atlas shared tier
      // where allowDiskUse is disabled, so a single pipeline that pre-groups by
      // (item, account) while carrying name/game/campaign/image strings blows
      // past MongoDB's 100MB in-memory $group limit as the archive grows (150k+
      // drops). Keeping the heavy per-account pre-group numeric-only, and pulling
      // everything else from a group keyed by item alone (far fewer buckets),
      // holds both well under the limit. Verified byte-identical to the old
      // single-pipeline output.

      // Item-level rollup: metadata, count/state tallies, distinct-account
      // counts. Grouped by item only, so each string field costs one copy per
      // item rather than one per (item, account) pair.
      const mainP = DropLog.aggregate([
        { $match: match },
        // Fall back to a computed name|game key for any row whose itemKey
        // wasn't backfilled yet, so items never merge into one bucket.
        {
          $group: {
            _id: ITEM_KEY_FIELD,
            name: { $first: "$name" },
            game: { $first: "$game" },
            imageLocal: { $max: "$imageLocal" },
            imageURL: { $first: "$imageURL" },
            campaign: { $first: "$campaign" },
            // "Deployed" numbers — accounts actually wired into a bot, the
            // sellable stock this view has always meant. Pool accounts
            // (accountModel: "AvailableAccount") are excluded per row, matching
            // the old $first(isPool)-then-exclude two-stage exactly.
            totalCount: { $sum: { $cond: [isPool, 0, "$count"] } },
            claimed: {
              $sum: {
                $cond: [
                  { $and: [notPool, { $eq: ["$state", "claimed"] }] },
                  1,
                  0,
                ],
              },
            },
            connect: {
              $sum: {
                $cond: [
                  { $and: [notPool, { $eq: ["$state", "connect"] }] },
                  1,
                  0,
                ],
              },
            },
            connected: {
              $sum: {
                $cond: [
                  { $and: [notPool, { $eq: ["$state", "connected"] }] },
                  1,
                  0,
                ],
              },
            },
            // Distinct accounts. $addToSet keyed by item alone stays small: the
            // union across all items is bounded by the drop count, not by
            // (items × accounts).
            acctSet: { $addToSet: { $cond: [isPool, "$$REMOVE", "$account"] } },
            poolAcctSet: {
              $addToSet: { $cond: [isPool, "$account", "$$REMOVE"] },
            },
            // "In pool" count — checked, not yet wired into any bot.
            poolCount: { $sum: { $cond: [isPool, "$count", 0] } },
          },
        },
        {
          $project: {
            _id: 0,
            itemKey: "$_id",
            name: 1,
            game: 1,
            // Prefer the locally cached image; fall back to the live URL. Note
            // imageLocal defaults to "" (not null), so test its length.
            image: {
              $cond: [
                { $gt: [{ $strLenCP: { $ifNull: ["$imageLocal", ""] } }, 0] },
                "$imageLocal",
                "$imageURL",
              ],
            },
            imageURL: 1,
            campaign: 1,
            totalCount: 1,
            accounts: { $size: "$acctSet" },
            claimed: 1,
            connect: 1,
            connected: 1,
            poolCount: 1,
            poolAccounts: { $size: "$poolAcctSet" },
          },
        },
      ]);

      // The one thing that genuinely needs a per-(item, account) pre-group: exact
      // min/max copies held per deployed account (an account with 4x vs 5x of a
      // drop differs). Numeric-only and non-pool, so it stays tiny. Pool rows are
      // dropped up front, matching the old $$REMOVE-on-pool for these two fields
      // (an item held only in the pool yields no row here → null min/max below).
      const minMaxP = DropLog.aggregate([
        { $match: { ...match, accountModel: { $ne: "AvailableAccount" } } },
        {
          $group: {
            _id: { k: ITEM_KEY_FIELD, acct: "$account" },
            cnt: { $sum: "$count" },
          },
        },
        {
          $group: {
            _id: "$_id.k",
            minPerAcct: { $min: "$cnt" },
            maxPerAcct: { $max: "$cnt" },
          },
        },
      ]);

      const [mainRows, minMaxRows] = await Promise.all([mainP, minMaxP]);
      const mmByKey = new Map(minMaxRows.map((r) => [r._id, r]));
      const rows = mainRows
        .map((r) => {
          const mm = mmByKey.get(r.itemKey);
          return {
            ...r,
            minPerAcct: mm ? mm.minPerAcct : null,
            maxPerAcct: mm ? mm.maxPerAcct : null,
          };
        })
        // Same order the old { $sort: { accounts: -1, totalCount: -1 } } gave.
        // There are ~1.3k items, so the 2000 cap never actually clips.
        .sort((a, b) => b.accounts - a.accounts || b.totalCount - a.totalCount);
      // ~1.3k items today; expose hasMore so the UI can flag if the cap ever bites.
      const LIMIT = 2000;
      const hasMore = rows.length > LIMIT;
      return { success: true, items: rows.slice(0, LIMIT), hasMore };
    });
    res.json(payload);
  } catch (err) {
    console.error("drops-archive by-item error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Which accounts hold a given item (by itemKey) — the delivery picker.
router.get(
  "/drops-archive/item-accounts",
  requireSuperadmin,
  async (req, res) => {
    try {
      const itemKey = String(req.query.itemKey || "").trim();
      if (!itemKey) {
        return res
          .status(400)
          .json({ success: false, message: "itemKey required" });
      }
      const badIds = await excludedAccountIds();
      const rows = await DropLog.aggregate([
        // Match the indexed itemKey directly so this uses the index instead of
        // scanning every drop (legacy rows are backfilled on startup). Dead
        // accounts are excluded so they never appear here or in "Copy logins".
        { $match: { itemKey, account: { $nin: badIds } } },
        {
          $lookup: {
            from: "botaccounts",
            localField: "account",
            foreignField: "_id",
            as: "acc",
          },
        },
        { $unwind: { path: "$acc", preserveNullAndEmptyArrays: true } },
        // Pool accounts (accountModel: "AvailableAccount") aren't in
        // botaccounts, so the lookup above leaves "acc" empty for them —
        // this second lookup fills in a username so they show as something
        // other than a blank row, labelled via inPool below.
        {
          $lookup: {
            from: "availableaccounts",
            localField: "account",
            foreignField: "_id",
            as: "poolAcc",
          },
        },
        { $unwind: { path: "$poolAcc", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 0,
            accountId: "$account",
            inPool: { $eq: ["$accountModel", "AvailableAccount"] },
            login: {
              $ifNull: [
                "$acc.login",
                { $ifNull: ["$poolAcc.username", "$login"] },
              ],
            },
            container: "$acc.container",
            configFile: "$acc.configFile",
            hasPassword: "$acc.hasPassword",
            copiedCount: { $ifNull: ["$acc.copiedCount", 0] },
            name: 1,
            game: 1,
            campaign: 1,
            imageLocal: 1,
            imageURL: 1,
            count: 1,
            state: 1,
            connected: 1,
            soldAt: 1,
            soldToUsername: 1,
            requiredAccountLink: 1,
            awardedAt: 1,
            firstSeenAt: 1,
            lastSeenAt: 1,
          },
        },
        { $sort: { state: 1, login: 1 } },
      ]);
      // An account is sold PER GAME. The row's own soldAt only says whether
      // this item is spoken for, which is not what the operator needs to see:
      // they need which games on the account are gone and whether there is
      // anything left to sell before they copy or re-sell it.
      const accIds = [...new Set(rows.map((r) => String(r.accountId)))]
        .filter(Boolean)
        .map((id) => new mongoose.Types.ObjectId(id));
      const gameRows = accIds.length
        ? await DropLog.aggregate([
            { $match: { account: { $in: accIds } } },
            {
              $group: {
                _id: {
                  account: "$account",
                  game: { $ifNull: ["$game", ""] },
                },
                // soldAt doubles as "reserved for a live listing": the
                // marketplace fulfillers stamp it with their claim tag when
                // they attach the account to an offer. Only a real hand-over
                // (Shop buyer, bulk order, manual sale) counts as sold —
                // otherwise every listed account reads as sold.
                sold: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $ne: [{ $ifNull: ["$soldAt", null] }, null] },
                          {
                            $not: [
                              {
                                $in: [
                                  { $ifNull: ["$soldToUsername", ""] },
                                  MARKET_CLAIM_TAGS,
                                ],
                              },
                            ],
                          },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                listed: {
                  $sum: {
                    $cond: [
                      {
                        $in: [
                          { $ifNull: ["$soldToUsername", ""] },
                          MARKET_CLAIM_TAGS,
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                open: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $eq: [{ $ifNull: ["$soldAt", null] }, null] },
                          { $ne: ["$connected", true] },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
              },
            },
          ])
        : [];
      const soldGames = new Map();
      const openGames = new Map();
      const listedGames = new Map();
      for (const g of gameRows) {
        const key = String(g._id.account);
        const label = g._id.game || "Other rewards";
        if (g.sold) {
          if (!soldGames.has(key)) soldGames.set(key, []);
          soldGames.get(key).push(label);
        }
        if (g.listed) {
          if (!listedGames.has(key)) listedGames.set(key, []);
          listedGames.get(key).push(label);
        }
        if (g.open) {
          if (!openGames.has(key)) openGames.set(key, []);
          openGames.get(key).push(label);
        }
      }
      for (const r of rows) {
        const key = String(r.accountId);
        r.soldGames = (soldGames.get(key) || []).sort();
        r.openGames = (openGames.get(key) || []).sort();
        r.listedGames = (listedGames.get(key) || []).sort();
      }
      const first = rows[0];
      res.json({
        success: true,
        item: first
          ? {
              name: first.name,
              game: first.game,
              campaign: first.campaign,
              image: first.imageLocal || first.imageURL,
            }
          : {},
        accounts: rows,
      });
    } catch (err) {
      console.error("drops-archive item-accounts error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// ------------------------------------------------------------------
// Sets / bundles — group items sold together as one order
// ------------------------------------------------------------------

// Resolve display metadata (name/game/image) for a list of itemKeys from the
// logged drops, so a set always shows accurate names/images. Pass the set's
// current items as `prevItems` on edits so archive-unknown items keep their
// stored metadata instead of degrading to bare key fragments.
async function resolveItemsMeta(keys, prevItems) {
  const uniq = [
    ...new Set(keys.map((k) => String(k || "").trim()).filter(Boolean)),
  ];
  if (!uniq.length) return [];
  const rows = await DropLog.aggregate([
    { $match: { itemKey: { $in: uniq } } },
    {
      $group: {
        _id: "$itemKey",
        name: { $first: "$name" },
        game: { $first: "$game" },
        imageLocal: { $max: "$imageLocal" },
        imageURL: { $first: "$imageURL" },
      },
    },
  ]);
  const byKey = new Map(rows.map((r) => [r._id, r]));
  // `prevItems` (the set's items before an edit) outranks the raw itemKey
  // fallback: a campaign listed before its drops are farmed has proper-cased
  // names and cached Twitch images stored by from-items, and the archive knows
  // nothing yet — without this, every editor save wiped that data down to
  // lowercase key fragments with no image (the Shop then showed letter tiles).
  const prevByKey = new Map(
    (Array.isArray(prevItems) ? prevItems : [])
      .filter((i) => i && i.itemKey)
      .map((i) => [i.itemKey, i]),
  );
  return uniq.map((k) => {
    const m = byKey.get(k) || {};
    const prev = prevByKey.get(k) || {};
    return {
      itemKey: k,
      name: m.name || prev.name || k.split("|")[0] || "Reward",
      game: m.game || prev.game || k.split("|")[1] || "",
      image: m.imageLocal || m.imageURL || prev.image || "",
    };
  });
}

// Apply the exact per-item quantities the seller chose ({itemKey: qty}) to a
// resolved item list. Stock only counts accounts holding at least item.qty.
function applyItemQuantities(items, quantities) {
  const q = quantities && typeof quantities === "object" ? quantities : {};
  return items.map((it) => {
    const n = Math.floor(Number(q[it.itemKey]));
    return { ...it, qty: Number.isFinite(n) && n >= 1 ? n : 1 };
  });
}

function publicSet(s) {
  return {
    id: String(s._id),
    name: s.name,
    note: s.note || "",
    items: s.items || [],
    itemCount: (s.items || []).length,
    price: Number(s.price) || 0,
    listed: !!s.listed,
    custom: !!s.custom,
    coverStyle: s.coverStyle || "grid",
    coverGame: s.coverGame || "",
    coverServiceText: s.coverServiceText || "",
    coverBullets: Array.isArray(s.coverBullets) ? s.coverBullets : [],
    coverImages: Array.isArray(s.coverImages) ? s.coverImages : [],
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

// List sets (lightweight). Regular Shop listings and custom listings are kept
// separate: ?custom=1 returns only custom listings, otherwise only non-custom.
router.get("/drops-archive/sets", requireSuperadmin, async (req, res) => {
  try {
    const wantCustom = req.query.custom === "1" || req.query.custom === "true";
    // Sets carry their full item arrays, so this is a fat response for a list
    // that only changes when an operator edits a bundle — and any such edit is
    // a write to /drops-archive/*, which clears the cache immediately.
    const payload = await cachedView("sets:" + wantCustom, async () => {
      const sets = await DropSet.find({
        custom: wantCustom ? true : { $ne: true },
      })
        .sort({ updatedAt: -1 })
        .lean();
      return {
        success: true,
        sets: sets.map((s) => ({
          id: String(s._id),
          name: s.name,
          note: s.note || "",
          items: s.items || [],
          itemCount: (s.items || []).length,
          price: Number(s.price) || 0,
          listed: !!s.listed,
          custom: !!s.custom,
          coverStyle: s.coverStyle || "grid",
          coverGame: s.coverGame || "",
          updatedAt: s.updatedAt,
        })),
      };
    });
    res.json(payload);
  } catch (err) {
    console.error("drops-archive sets list error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Create a set.
router.post("/drops-archive/sets", requireSuperadmin, async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name || "").trim();
    if (!name) {
      return res.status(400).json({ success: false, message: "Name required" });
    }
    const keys = Array.isArray(body.itemKeys) ? body.itemKeys : [];
    const items = applyItemQuantities(
      await resolveItemsMeta(keys),
      body.itemQuantities,
    );
    const doc = {
      name,
      note: String(body.note || "").trim(),
      items,
    };
    // Optional shop-listing fields so a listing can be created and published in
    // one call (superadmin Listings page). Same validation as the update route.
    if (body.price !== undefined) {
      const price = Number(body.price);
      if (!Number.isFinite(price) || price < 0) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid price" });
      }
      doc.price = Math.round(price * 100) / 100;
    }
    if (body.listed !== undefined) doc.listed = !!body.listed;
    if (body.custom !== undefined) doc.custom = !!body.custom;
    if (body.coverStyle !== undefined) {
      doc.coverStyle = String(body.coverStyle) === "promo" ? "promo" : "grid";
    }
    if (body.coverGame !== undefined) doc.coverGame = String(body.coverGame);
    if (body.coverServiceText !== undefined) {
      doc.coverServiceText = String(body.coverServiceText);
    }
    if (Array.isArray(body.coverBullets)) {
      doc.coverBullets = body.coverBullets
        .map((b) => String(b || ""))
        .slice(0, 4);
    }
    if (Array.isArray(body.coverImages)) {
      doc.coverImages = body.coverImages
        .map((i) => String(i || ""))
        .slice(0, 30);
    }
    const set = await DropSet.create(doc);
    res.json({ success: true, set: publicSet(set) });
  } catch (err) {
    console.error("drops-archive set create error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Buyer-facing default note (the Shop card's description) built from a set's
// items — same shape the Listings editor auto-fills. Used when a set is
// created without a note (the quick "Create listing" paths), which previously
// left the Shop card with no included-items list at all.
function buildSetNote(items) {
  const games = [...new Set(items.map((i) => i.game).filter(Boolean))];
  const total = items.reduce((n, i) => n + (i.qty || 1), 0);
  const lines = [
    "This account includes " +
      total +
      " item" +
      (total === 1 ? "" : "s") +
      (games.length === 1 ? " from " + games[0] : "") +
      ":",
  ];
  for (const i of items) {
    lines.push(
      "• " +
        ((i.qty || 1) > 1 ? i.qty + "× " : "") +
        i.name +
        (i.game ? " (" + i.game + ")" : ""),
    );
  }
  lines.push("");
  lines.push(
    "Buyer receives one in-stock account holding every item listed above.",
  );
  return lines.join("\n");
}

// Create a set straight from item snapshots (name/game/image/qty) instead of
// from claimed-archive itemKeys. This is the "list a campaign before it's
// claimed" path: the Twitch-inventory page fetches a campaign live by token and
// posts its drops here, so the items don't exist in DropLog yet and can't be
// resolveItemsMeta'd. itemKey is name|game normalised — the exact key DropLog
// records once the bots claim these — so the set's deliverable stock fills in
// on its own as farming completes; nothing here touches the archive.
router.post(
  "/drops-archive/sets/from-items",
  requireSuperadmin,
  async (req, res) => {
    try {
      const body = req.body || {};
      const name = String(body.name || "").trim();
      if (!name) {
        return res
          .status(400)
          .json({ success: false, message: "Name required" });
      }
      const raw = Array.isArray(body.items) ? body.items : [];
      const byKey = new Map();
      const items = [];
      for (const it of raw) {
        const iname = String((it && it.name) || "").trim();
        if (!iname) continue;
        const game = String((it && it.game) || "").trim();
        // Same normalisation as utils/twitchInventory itemKeyFor + the archive's
        // itemKeyFor(), so this key lines up with what the bots log on claim.
        const itemKey = iname.toLowerCase() + "|" + game.toLowerCase();
        // Duplicate reward (same item at several watch-time tiers): fold the
        // copies into qty rather than dropping them, so a 5-drop campaign with
        // 4× the same crate still promises 5 items.
        const dup = byKey.get(itemKey);
        if (dup) {
          dup.qty += Math.max(1, parseInt(it && it.qty, 10) || 1);
          continue;
        }
        // Cache the reward image locally (Twitch URL -> /drop-images/<hash>),
        // exactly like the archive does. coverImagePath() only accepts a file
        // inside public/, so a bare remote URL would leave the set with no cover
        // photo and Gameflip rejects the listing ("must have active
        // cover_photo"). Falls back to "" if the download fails.
        let image = String((it && it.image) || "").trim();
        if (image && !image.startsWith("/")) {
          image = (await cacheImage(image)) || "";
        }
        const entry = {
          itemKey,
          name: iname,
          game,
          image,
          qty: Math.max(1, parseInt(it && it.qty, 10) || 1),
        };
        byKey.set(itemKey, entry);
        items.push(entry);
      }
      if (!items.length) {
        return res
          .status(400)
          .json({ success: false, message: "No valid items to add" });
      }
      const doc = {
        name,
        note: String(body.note || "").trim() || buildSetNote(items),
        items,
      };
      const set = await DropSet.create(doc);
      res.json({ success: true, set: publicSet(set) });
    } catch (err) {
      console.error("drops-archive set from-items error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// Collapse a reward name to its "core" so the same item matches across seasons
// and campaign prefixes: drop "EAS10#1"/"EAS9 #2" campaign codes, "#3" suffixes,
// and all spaces/punctuation. So "EAS10#1 4x Gold CoinPouch" and
// "EAS9 #2 4x Gold Coin Pouch" both become "4xgoldcoinpouch".
function coreItemName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/eas\s*\d+\s*#?\s*\d*/g, "")
    .replace(/#\d+/g, "")
    .replace(/[^a-z0-9]/g, "");
}

// Fill in missing item images on a set from the drop archive, matched by
// game + core name. Lets a hand-entered set (typed names, no images) pick up the
// real reward art the bots already cached, so its grid cover shows images
// instead of text tiles. Only items without a local image are touched.
router.post(
  "/drops-archive/sets/:id/fill-images",
  requireSuperadmin,
  async (req, res) => {
    try {
      const set = await DropSet.findById(req.params.id);
      if (!set) {
        return res.status(404).json({ success: false, message: "Not found" });
      }
      const need = (set.items || []).filter(
        (i) => i && !String(i.image || "").startsWith("/"),
      );
      if (!need.length) {
        return res.json({
          success: true,
          filled: 0,
          total: (set.items || []).length,
          unmatched: [],
          message: "Every item already has an image",
        });
      }
      const games = [
        ...new Set(
          need.map((i) => String(i.game || "").toLowerCase()).filter(Boolean),
        ),
      ];
      const gameRes = games.map(
        (g) =>
          new RegExp("^" + g.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i"),
      );
      const rows = gameRes.length
        ? await DropLog.find(
            { imageLocal: { $ne: "" }, game: { $in: gameRes } },
            { name: 1, game: 1, imageLocal: 1 },
          ).lean()
        : [];
      const map = new Map();
      for (const r of rows) {
        const k =
          String(r.game || "").toLowerCase() + "|" + coreItemName(r.name);
        if (coreItemName(r.name) && !map.has(k)) map.set(k, r.imageLocal);
      }
      let filled = 0;
      const unmatched = [];
      for (const it of set.items) {
        if (String(it.image || "").startsWith("/")) continue;
        const k =
          String(it.game || "").toLowerCase() + "|" + coreItemName(it.name);
        const img = map.get(k);
        if (img) {
          it.image = img;
          filled++;
        } else {
          unmatched.push(it.name);
        }
      }
      if (filled) {
        set.markModified("items");
        await set.save();
      }
      res.json({
        success: true,
        filled,
        total: set.items.length,
        unmatched,
      });
    } catch (err) {
      console.error("drops-archive set fill-images error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// Update a set: rename, note, replace/add/remove items.
router.put("/drops-archive/sets/:id", requireSuperadmin, async (req, res) => {
  try {
    const set = await DropSet.findById(req.params.id);
    if (!set) {
      return res.status(404).json({ success: false, message: "Not found" });
    }
    const body = req.body || {};
    if (typeof body.name === "string" && body.name.trim()) {
      set.name = body.name.trim();
    }
    if (typeof body.note === "string") set.note = body.note.trim();

    // Shop listing controls (superadmin only — this whole route is guarded by
    // requireSuperadmin). Price is a flat amount; listed toggles visibility in
    // the Shop tab for regular admins.
    if (body.price !== undefined) {
      const price = Number(body.price);
      if (!Number.isFinite(price) || price < 0) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid price" });
      }
      set.price = Math.round(price * 100) / 100;
    }
    if (body.listed !== undefined) set.listed = !!body.listed;

    let keys = set.items.map((i) => i.itemKey);
    if (Array.isArray(body.itemKeys)) keys = body.itemKeys;
    if (Array.isArray(body.addItemKeys)) keys = keys.concat(body.addItemKeys);
    if (Array.isArray(body.removeItemKeys)) {
      const rm = new Set(body.removeItemKeys);
      keys = keys.filter((k) => !rm.has(k));
    }
    // Keep each item's chosen qty unless the caller sends new ones.
    const prevQty = {};
    for (const i of set.items) prevQty[i.itemKey] = i.qty || 1;
    set.items = applyItemQuantities(
      await resolveItemsMeta(keys, set.items),
      body.itemQuantities !== undefined ? body.itemQuantities : prevQty,
    );
    await set.save();
    res.json({ success: true, set: publicSet(set) });
  } catch (err) {
    console.error("drops-archive set update error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Delete a set.
router.delete(
  "/drops-archive/sets/:id",
  requireSuperadmin,
  async (req, res) => {
    try {
      await DropSet.findByIdAndDelete(req.params.id);
      res.json({ success: true });
    } catch (err) {
      console.error("drops-archive set delete error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// Fulfillment: which accounts can deliver the whole bundle, plus per-item stock.
router.get(
  "/drops-archive/sets/:id/fulfillment",
  requireSuperadmin,
  async (req, res) => {
    try {
      const set = await DropSet.findById(req.params.id).lean();
      if (!set) {
        return res.status(404).json({ success: false, message: "Not found" });
      }
      const keys = (set.items || []).map((i) => i.itemKey);
      if (!keys.length) {
        return res.json({
          success: true,
          set: {
            id: String(set._id),
            name: set.name,
            note: set.note || "",
            price: Number(set.price) || 0,
            listed: !!set.listed,
          },
          items: set.items || [],
          accounts: [],
          fullAccounts: 0,
          bundlesAvailable: 0,
        });
      }

      const badIds = await excludedAccountIds();

      // Per account: which of the set's items they hold and the count of each.
      // Connected/redeemed drops can't be delivered again, so they don't count
      // — this keeps these numbers identical to the Shop's stock. Dead accounts
      // are excluded so their unusable stock never inflates availability.
      const rows = await DropLog.aggregate([
        {
          $match: {
            itemKey: { $in: keys },
            connected: { $ne: true },
            account: { $nin: badIds },
          },
        },
        {
          $group: {
            _id: { account: "$account", k: "$itemKey" },
            count: { $sum: "$count" },
            // Copies still free to sell (reservation is per drop now): only
            // unreserved rows count toward availability. $ifNull so legacy docs
            // that predate the soldAt field (where it's MISSING, not null) are
            // treated as free — an aggregation $eq to null is false for a
            // missing field, unlike a {soldAt: null} query match.
            availCount: {
              $sum: {
                $cond: [
                  { $eq: [{ $ifNull: ["$soldAt", null] }, null] },
                  "$count",
                  0,
                ],
              },
            },
            state: { $first: "$state" },
          },
        },
        {
          $group: {
            _id: "$_id.account",
            items: {
              $push: {
                itemKey: "$_id.k",
                count: "$count",
                availCount: "$availCount",
                state: "$state",
              },
            },
          },
        },
        {
          $lookup: {
            from: "botaccounts",
            localField: "_id",
            foreignField: "_id",
            as: "acc",
          },
        },
        { $unwind: { path: "$acc", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 0,
            accountId: "$_id",
            login: "$acc.login",
            container: "$acc.container",
            configFile: "$acc.configFile",
            soldAt: "$acc.soldAt",
            hasPassword: {
              $gt: [{ $strLenCP: { $ifNull: ["$acc.credPassword", ""] } }, 0],
            },
            items: 1,
          },
        },
      ]);

      const total = keys.length;
      // An account is only "complete" when it holds at least the promised
      // qty of EVERY item, so the exact numbers on the listing always hold.
      const needByKey = new Map(
        (set.items || []).map((i) => [i.itemKey, Math.max(1, i.qty || 1)]),
      );
      const accounts = rows
        .map((r) => {
          const have = r.items.length;
          const complete =
            have === total &&
            r.items.every(
              (i) => (i.count || 0) >= (needByKey.get(i.itemKey) || 1),
            );
          // "available" = holds the whole bundle with every item still
          // UNRESERVED for this set; "held" = holds it but this set's drops are
          // reserved (sold for this game, on another listing).
          const available =
            have === total &&
            r.items.every(
              (i) => (i.availCount || 0) >= (needByKey.get(i.itemKey) || 1),
            );
          const minCount = complete
            ? Math.min(...r.items.map((i) => i.count || 0))
            : 0;
          return {
            accountId: r.accountId,
            login: r.login || "",
            container: r.container || "",
            configFile: r.configFile || "",
            hasPassword: !!r.hasPassword,
            // Per-game: this set's drops on the account are (partly) reserved.
            sold: complete && !available,
            have,
            total,
            complete,
            available,
            minCount,
            haveKeys: r.items.map((i) => i.itemKey),
          };
        })
        .sort((a, b) => b.have - a.have || b.minCount - a.minCount);

      // Per-item stock across all accounts.
      const perItem = await DropLog.aggregate([
        {
          $match: {
            itemKey: { $in: keys },
            connected: { $ne: true },
            account: { $nin: badIds },
          },
        },
        {
          $group: {
            _id: "$itemKey",
            totalCount: { $sum: "$count" },
            accounts: { $addToSet: "$account" },
          },
        },
      ]);
      const stockByKey = new Map(
        perItem.map((p) => [
          p._id,
          { totalCount: p.totalCount, accounts: p.accounts.length },
        ]),
      );
      const items = (set.items || []).map((it) => {
        const s = stockByKey.get(it.itemKey) || { totalCount: 0, accounts: 0 };
        return { ...it, totalCount: s.totalCount, accounts: s.accounts };
      });

      // Self-heal: a complete-but-passwordless account is usually a missed
      // pool mirror (the pool row appeared after the account was deployed, and
      // no sync ran since — the twitchbotx16 incident). Run the targeted
      // mirror right here so merely viewing a listing repairs it, and reflect
      // any fills in this response instead of reporting stale zeros.
      const missingPw = accounts.filter((a) => a.complete && !a.hasPassword);
      if (missingPw.length) {
        const filled = await fillBotPasswordsFromPool(
          missingPw.map((a) => a.login),
        ).catch(() => 0);
        if (filled) {
          const fixed = await BotAccount.find(
            {
              _id: { $in: missingPw.map((a) => a.accountId) },
              credPassword: { $gt: "" },
            },
            { _id: 1 },
          ).lean();
          const ok = new Set(fixed.map((f) => String(f._id)));
          for (const a of accounts) {
            if (ok.has(String(a.accountId))) a.hasPassword = true;
          }
        }
      }

      const fullAccounts = accounts.filter((a) => a.complete);
      // One deliverable bundle per account that holds the whole set with this
      // set's drops still free (unreserved) and a stored password. Matches the
      // Shop's "in stock" exactly. Reservation is per game, so an account sold
      // for another game still counts here as long as THIS set's drops are free.
      const bundlesAvailable = accounts.filter(
        (a) => a.available && a.hasPassword,
      ).length;
      // Complete accounts whose drops for THIS set are already reserved (this
      // game sold on another listing). Surfaced so a reserved-out bundle reads
      // as "held by other listings" instead of a baffling plain 0.
      const bundlesHeld = fullAccounts.filter(
        (a) => a.hasPassword && !a.available,
      ).length;
      // Would-be stock blocked only by a missing password (no pool match even
      // after the self-heal above). Surfaced so the listing row can say WHY
      // it's out of stock instead of a bare 0.
      const bundlesMissingPassword = accounts.filter(
        (a) => a.available && !a.hasPassword,
      ).length;

      res.json({
        success: true,
        set: {
          id: String(set._id),
          name: set.name,
          note: set.note || "",
          price: Number(set.price) || 0,
          listed: !!set.listed,
        },
        items,
        accounts,
        fullAccounts: fullAccounts.length,
        bundlesAvailable,
        bundlesHeld,
        bundlesMissingPassword,
      });
    } catch (err) {
      console.error("drops-archive fulfillment error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// Warm the expensive archive views a few seconds after boot.
//
// by-item/by-game/overview are served from an in-memory cache, so the first
// request after any restart pays the full aggregation over 150k+ drops — ~20-35s
// of "Loading…" for whoever opens the page first. Nothing else changes: this
// just pays that cost in the background instead of on someone's click.
function warmArchiveViews() {
  const targets = [
    "/drops-archive/overview",
    "/drops-archive/by-game",
    "/drops-archive/by-item",
  ];
  for (const path of targets) {
    const layer = router.stack.find(
      (l) => l.route && l.route.path === path && l.route.methods.get,
    );
    if (!layer) continue;
    // Last handler in the chain = the route body, skipping requireSuperadmin.
    const handlers = layer.route.stack;
    const handler = handlers[handlers.length - 1].handle;
    const req = { query: {}, params: {}, body: {} };
    const res = {
      statusCode: 200,
      status(c) {
        this.statusCode = c;
        return this;
      },
      json() {},
      send() {},
    };
    const t = Date.now();
    Promise.resolve(handler(req, res, () => {}))
      .then(() =>
        console.log(
          "[dropsArchive] warmed " + path + " in " + (Date.now() - t) + "ms",
        ),
      )
      .catch((e) => console.error("[dropsArchive] warm " + path + ":", e.message));
  }
}
setTimeout(warmArchiveViews, 15000).unref();

module.exports = router;
