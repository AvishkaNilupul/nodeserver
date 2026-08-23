const express = require("express");
const mongoose = require("mongoose");

const { requireSuperadmin } = require("../middleware/auth");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const DropSet = require("../models/DropSet");
const AvailableAccount = require("../models/AvailableAccount");
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
const { detachAccountFromListing } = require("../utils/listingDetach");
const { sameGame } = require("../utils/gameLabel");
const { paginateArchiveItems } = require("../utils/archivePagination");
const {
  BAD_STATUSES,
  excludedAccountIdsCached,
  invalidateExclusions,
} = require("../utils/archiveExclusions");
const archiveSnapshot = require("../utils/archiveSnapshot");

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
const DROP_CACHE_MAX_ENTRIES = 64;
const dropCache = new Map(); // key -> { exp, staleExp, data }
// The item drill-down is cached separately and kept short. Its payloads are
// megabytes (thousands of holdings for a popular reward), so letting them into
// the 64-entry map above would trade a fixed memory cost for a cache that is
// mostly one-shot entries. Eight is enough for "open an item, close it, open it
// again" and for two operators looking at the same item.
const ITEM_ACCOUNTS_CACHE_MAX = 8;
const itemAccountsCache = new Map(); // itemKey -> { exp, staleExp, data }
const inFlight = new Map(); // key -> Promise, so N viewers cause 1 recompute

function dropCacheSet(key, data) {
  const now = Date.now();
  // Map preserves insertion order. Refresh the key's position and evict the
  // oldest entries so one-off item searches cannot grow this process forever.
  dropCache.delete(key);
  dropCache.set(key, {
    exp: now + DROP_CACHE_TTL,
    staleExp: now + DROP_CACHE_STALE_TTL,
    data,
  });
  while (dropCache.size > DROP_CACHE_MAX_ENTRIES) {
    dropCache.delete(dropCache.keys().next().value);
  }
}
// The view prefixes that mean "this write changed the archive itself", and so
// must drop BOTH shared archive caches: the exclusion set and the background
// rollup built from it. Split out from bustDropCache so the rule can be tested
// on its own — getting it wrong is silent, showing stale numbers with no error.
const ARCHIVE_BUST_PREFIXES = ["archive:", "overview", "by-game", "by-item:"];

// The two used to be decided separately, and disagreed. /mark-sold busts
// ["by-item:", "sets:"], which rebuilt the rollup but left the exclusions cache
// alone — and stamping soldAt un-excludes a sold shadow duplicate ("never hide
// a sale"), so the rebuild that fired 3s later baked the PRE-write exclusion set
// into the numbers, hiding the account just sold until the next periodic
// refresh. They read the same set, so they invalidate together or not at all.
//
// Deliberately still false for ["accounts:"] (copied) and ["accounts:",
// "bad-tokens"] (password): neither touches scan status, placement or soldAt, so
// neither changes the exclusion set — and recomputing it uncached measured ~4.7s
// on the Atlas shared tier, which is not a bill to hand the next reader for a
// copy-count bump.
function bustTargets(prefixes) {
  const archive =
    !prefixes ||
    !prefixes.length ||
    prefixes.some((p) => ARCHIVE_BUST_PREFIXES.includes(p));
  return { exclusions: archive, snapshot: archive };
}

function bustDropCache(prefixes) {
  // Any archive write can change who holds what, and the drill-down is the
  // view an operator checks right before handing an account over — so it is
  // always dropped outright rather than served stale.
  itemAccountsCache.clear();
  if (!prefixes || !prefixes.length) {
    dropCache.clear();
  } else {
    for (const key of dropCache.keys()) {
      if (prefixes.some((prefix) => key.startsWith(prefix))) {
        dropCache.delete(key);
      }
    }
  }
  const targets = bustTargets(prefixes);
  // Exclusions first: the rollup rebuild below reads them, so clearing them
  // afterwards would leave the rebuild it just kicked off using the old set.
  if (targets.exclusions) invalidateExclusions();
  // overview / by-game / by-item are no longer in this map at all — they come
  // from the background rollup. Tell it to rebuild, but let it keep serving the
  // current numbers until the new ones land: a write must never turn the next
  // page load into a cold half-minute aggregation.
  if (targets.snapshot) archiveSnapshot.invalidate();
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

// Same stale-while-revalidate contract as cachedView, over the small dedicated
// map. Kept separate rather than parameterising cachedView so the eviction
// policy for these megabyte payloads can't drift from the general one.
async function cachedItemAccounts(itemKey, compute) {
  const now = Date.now();
  const entry = itemAccountsCache.get(itemKey);
  if (entry && entry.exp > now) return entry.data;

  const refresh = async () => {
    const data = await compute();
    itemAccountsCache.delete(itemKey);
    itemAccountsCache.set(itemKey, {
      exp: Date.now() + DROP_CACHE_TTL,
      staleExp: Date.now() + DROP_CACHE_STALE_TTL,
      data,
    });
    while (itemAccountsCache.size > ITEM_ACCOUNTS_CACHE_MAX) {
      itemAccountsCache.delete(itemAccountsCache.keys().next().value);
    }
    return data;
  };

  if (entry && entry.staleExp > now) {
    refresh().catch((e) =>
      console.error("drops-archive item-accounts refresh:", e.message),
    );
    return entry.data;
  }
  return refresh();
}

// Invalidate on any successful mutation so writes are reflected immediately.
router.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return next();
  res.on("finish", () => {
    if (res.statusCode >= 400) return;
    const path = req.path;
    if (path === "/drops-archive/scheduler") return;
    if (/\/copied$/.test(path)) return bustDropCache(["accounts:"]);
    if (/\/password$/.test(path)) {
      return bustDropCache(["accounts:", "bad-tokens"]);
    }
    if (/\/mark-sold$/.test(path)) {
      return bustDropCache(["by-item:", "sets:"]);
    }
    // Imports, syncs, scans, purges and account edits can change membership or
    // rollups. Clear archive-related views, while leaving unrelated caches hot.
    bustDropCache([
      "overview",
      "by-game",
      "by-item:",
      "accounts:",
      "bad-tokens",
      "sets:",
      "archive:",
    ]);
  });
  next();
});

// Same filename rules as the bot manager.
const FILE_RE = /^config(_\d{1,3})?\.json$/;

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
    if (
      ["ok", "token_invalid", "error", "pending", "suspended"].includes(status)
    ) {
      q.lastScanStatus = status;
    } else {
      // Bad-token accounts have their own tab; keep them out of the main list
      // (and therefore out of the "search" the operator uses to build orders).
      q.lastScanStatus = { $nin: BAD_STATUSES };
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
    const q = { lastScanStatus: { $in: BAD_STATUSES } };
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
      const bad = await BotAccount.find({
        lastScanStatus: { $in: BAD_STATUSES },
      }).lean();
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
      // Demand learning: one signal per (account, game). Recorded as
      // "listing_sold" because that is what it is — the operator delivered to a
      // paying buyer on a marketplace with no API. It used to be filed as
      // "drop_reserved", which now means "stock was claimed" and is excluded
      // from demand, so a hand-delivered sale would have stopped counting.
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
            source: "listing_sold",
            marketplace: String(body.marketplace || "").trim(),
            priceUsd: Number(body.priceUsd) || 0,
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
        const r = await detachAccountFromListing(
          row,
          { _id: acc._id, login: acc.login },
          { reason: "sold manually" },
        );
        detached.push(...r.detached);
        warnings.push(...r.warnings);
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

// The three cross-archive views: the dashboard header, the per-game rollup and
// the per-item inventory.
//
// All three are served from utils/archiveSnapshot.js rather than aggregated per
// request. Between them they used to run ten full passes over ~200k drops —
// measured at 33s for by-item alone on the production Atlas shared tier — and
// the page fires all three the moment it opens. They are now one background
// rebuild every few minutes, and a read is a filter over ~1.7k rows already in
// memory. The `game` and `search` filters moved into that filter for the same
// reason: as cache keys, every new filter combination was its own cold
// aggregation, so narrowing to one game was the slowest thing on the page.
//
// Bad-token accounts (and their drops) are left out of all three so they only
// count sellable stock. Pool-account drops (accountModel: "AvailableAccount" —
// checked but not deployed to any bot yet) are excluded from the
// deployed/sellable numbers and reported separately as poolItems/poolDrops
// instead of inflating them.

// Fields the snapshot carries only so by-game and the overview can be derived
// from the same rows. They are not part of the by-item contract, so they are
// stripped before the response goes out.
function publicItem(it) {
  return {
    itemKey: it.itemKey,
    name: it.name,
    game: it.game,
    image: it.image,
    imageURL: it.imageURL,
    campaign: it.campaign,
    totalCount: it.totalCount,
    accounts: it.accounts,
    claimed: it.claimed,
    connect: it.connect,
    connected: it.connected,
    poolCount: it.poolCount,
    poolAccounts: it.poolAccounts,
    minPerAcct: it.minPerAcct,
    maxPerAcct: it.maxPerAcct,
  };
}

// ?fresh=1 waits for a rebuild that covers any write already made, instead of
// returning the rollup as it stands. The page uses it only after an action that
// changed the archive (a sync, a scan, a purge), where instantly showing the
// pre-write numbers would read as the action having done nothing.
function snapshotOpts(req) {
  return { fresh: req.query.fresh === "1" || req.query.fresh === "true" };
}

router.get("/drops-archive/overview", requireSuperadmin, async (req, res) => {
  try {
    const snap = await archiveSnapshot.getSnapshot(snapshotOpts(req));
    res.json({ success: true, overview: snap.overview, builtAt: snap.builtAt });
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
    const snap = await archiveSnapshot.getSnapshot(snapshotOpts(req));
    res.json({ success: true, games: snap.games, builtAt: snap.builtAt });
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
    const snap = await archiveSnapshot.getSnapshot(snapshotOpts(req));

    // Same predicates the pipeline's $match used to apply, against the same
    // stored values: an exact game match ("Other rewards" is the UI's label for
    // the empty game), and a case-insensitive substring of the item name.
    let rows = snap.items;
    if (game) {
      const want = game === "Other rewards" ? "" : game;
      rows = rows.filter((r) => (r.rawGame || "") === want);
    }
    if (search) {
      const re = searchRegex(search);
      rows = rows.filter((r) => re.test(r.name || ""));
    }

    // ~1.7k items today; expose hasMore so the UI can flag if the cap ever bites.
    const LIMIT = 2000;
    const payload = {
      success: true,
      items: rows.slice(0, LIMIT).map(publicItem),
      hasMore: rows.length > LIMIT,
      builtAt: snap.builtAt,
    };
    // Existing consumers receive the complete response. The archive page opts
    // into paging so it only transfers and renders a small first viewport.
    res.json(paginateArchiveItems(payload, req.query));
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
      const payload = await cachedItemAccounts(itemKey, async () => {
        // excludedAccountIdsCached(), not the raw computation: this runs on
        // every click of the drill-down and the uncached version measured ~4.7s
        // on the production Atlas shared tier — nearly half the old open time,
        // spent re-deriving a set that changes only when a scan flips a status.
        const badIds = await excludedAccountIdsCached();
        // Plain indexed find, then two batched lookups by _id, instead of a
        // $lookup per drop row. The lookups were correlated subqueries — the
        // popular items have ~4.6k rows, so opening one fired ~9k of them and
        // measured 4.9s. The same joins as three round trips take a fraction of
        // that, and the merge is trivial in JS.
        const excluded = new Set(badIds.map((id) => String(id)));
        // The exclusion is applied in JS, not as a $nin in the query. itemKey is
        // indexed and already selective, so the $nin bought nothing at the index
        // and instead made the server compare every matched drop against ~2.9k
        // ObjectIds one at a time — 13M comparisons for a popular item. A Set
        // membership test per row is the same filter for none of the cost.
        //
        // The projection is the single biggest lever here, because what this
        // endpoint is really bounded by is bytes off the Atlas shared tier, not
        // query planning. Measured on the same 5.3k-row item:
        //     full documents ............ 50.0s
        //     11 fields ................. 13.4s
        //     _id + account .............  3.9s
        // — roughly a second per projected field. So it reads only the six that
        // vary per holding. Everything else the response carries describes the
        // ITEM, not the holding, and is identical on all 5.3k rows; it's read
        // once below, for the modal header.
        const allRows = await DropLog.find(
          { itemKey },
          {
            account: 1,
            accountModel: 1,
            login: 1,
            count: 1,
            state: 1,
            soldAt: 1,
          },
        ).lean();
        const dropRows = allRows.filter(
          (r) => !excluded.has(String(r.account)),
        );
        // One row's worth of the item's own fields. Cheap: itemKey is indexed, so
        // this is a single-document lookup, and it's the same value the old
        // pipeline surfaced as rows[0] for the modal header.
        // Read once for the modal header — NOT copied onto each row. A row used
        // to carry the item's name, game, campaign, both image URLs and the
        // account-link URL, all identical across the item's thousands of rows:
        // for the biggest item that was 3.4MB of the 4.0MB response, for fields
        // the page reads only from `item` below.
        const itemMeta =
          (await DropLog.findOne(
            { itemKey },
            {
              name: 1,
              game: 1,
              campaign: 1,
              imageLocal: 1,
              imageURL: 1,
              requiredAccountLink: 1,
            },
          ).lean()) || {};

        const ids = [...new Set(dropRows.map((r) => String(r.account)))]
          .filter(Boolean)
          .map((id) => new mongoose.Types.ObjectId(id));
        const [botAccs, poolAccs] = ids.length
          ? await Promise.all([
              BotAccount.find(
                { _id: { $in: ids } },
                {
                  login: 1,
                  container: 1,
                  configFile: 1,
                  hasPassword: 1,
                  copiedCount: 1,
                },
              ).lean(),
              // Pool accounts (accountModel: "AvailableAccount") aren't in
              // botaccounts, so they'd otherwise show as blank rows; their
              // username labels them, flagged via inPool below.
              AvailableAccount.find(
                { _id: { $in: ids } },
                { username: 1 },
              ).lean(),
            ])
          : [[], []];
        const botById = new Map(botAccs.map((a) => [String(a._id), a]));
        const poolById = new Map(poolAccs.map((a) => [String(a._id), a]));

        const rows = dropRows.map((d) => {
          const acc = botById.get(String(d.account));
          const poolAcc = poolById.get(String(d.account));
          return {
            // The drop row's own id. Only a stable tiebreak for the sort below —
            // an account can hold the same reward under several benefit ids, and
            // those rows tie on both of the original sort keys, so without this
            // their order in the table changed from one open to the next.
            dropId: d._id,
            accountId: d.account,
            inPool: d.accountModel === "AvailableAccount",
            login:
              acc && acc.login != null
                ? acc.login
                : poolAcc && poolAcc.username != null
                  ? poolAcc.username
                  : d.login == null
                    ? null
                    : d.login,
            container: acc ? acc.container : undefined,
            configFile: acc ? acc.configFile : undefined,
            hasPassword: acc ? acc.hasPassword : undefined,
            copiedCount: (acc && acc.copiedCount) || 0,
            count: d.count,
            // "connected" is exactly the state label, which the row already
            // carries — the page reads state and never the boolean.
            state: d.state,
            soldAt: d.soldAt,
          };
        });
        // Reproduces the old { $sort: { state: 1, login: 1 } }: missing values
        // sort ahead of present ones, then plain byte order on the strings.
        const cmp = (a, b) => {
          if (a == null && b == null) return 0;
          if (a == null) return -1;
          if (b == null) return 1;
          return a < b ? -1 : a > b ? 1 : 0;
        };
        rows.sort(
          (a, b) =>
            cmp(a.state, b.state) ||
            cmp(a.login, b.login) ||
            cmp(String(a.dropId), String(b.dropId)),
        );
        // Only ever a sort key; the client has no use for it.
        for (const r of rows) delete r.dropId;

        // An account is sold PER GAME. The row's own soldAt only says whether
        // this item is spoken for, which is not what the operator needs to see:
        // they need which games on the account are gone and whether there is
        // anything left to sell before they copy or re-sell it.
        // `ids` is already the de-duplicated account list built for the joins
        // above, so reuse it instead of walking every drop row again.
        const accIds = ids;
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
              // Rows where all three tallies are zero carry no information — the
              // loop below only ever reads a non-zero one — and dropping them
              // server-side is worth doing here specifically: this endpoint is
              // bound by bytes returned over a slow link to Atlas, not by query
              // time (the match itself executes in ~99ms).
              {
                $match: {
                  $or: [
                    { sold: { $gt: 0 } },
                    { listed: { $gt: 0 } },
                    { open: { $gt: 0 } },
                  ],
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
        // The modal header. Same values the old rows[0] carried, now read once
        // rather than off whichever row happened to sort first — and still {}
        // when the item has no visible holdings, as before.
        return {
          success: true,
          item: rows.length
            ? {
                name: itemMeta.name,
                game: itemMeta.game,
                campaign: itemMeta.campaign,
                image: itemMeta.imageLocal || itemMeta.imageURL,
              }
            : {},
          accounts: rows,
        };
      });
      res.json(payload);
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
    accountScopeLogins: Array.isArray(s.accountScopeLogins)
      ? s.accountScopeLogins
      : [],
    sourceType: s.sourceType || "",
    sourceEventKey: s.sourceEventKey || "",
    sourceEventName: s.sourceEventName || "",
    sourceCampaignIds: Array.isArray(s.sourceCampaignIds)
      ? s.sourceCampaignIds
      : [],
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

// List sets (lightweight). Regular Shop listings and custom listings are kept
// separate: ?custom=1 returns only custom listings, otherwise only non-custom.
router.get("/drops-archive/sets", requireSuperadmin, async (req, res) => {
  try {
    const wantCustom = req.query.custom === "1" || req.query.custom === "true";
    // A set carries its full item snapshots, so the full response is fat for a
    // list whose rows only ever show 4 thumbnails and a count. `light=1` drops
    // the per-item arrays and returns just the first four thumbnail URLs — the
    // Listings page loads with this so the initial render never has to ship (or
    // parse) every item of every bundle. The full items are then fetched one
    // set at a time from GET /drops-archive/sets/:id when a row is edited or
    // published. Any edit is a write to /drops-archive/*, which clears the
    // cache immediately, so both variants stay fresh.
    const light = req.query.light === "1" || req.query.light === "true";
    const key = "sets:" + wantCustom + (light ? ":light" : "");
    const match = { custom: wantCustom ? true : { $ne: true } };
    const payload = await cachedView(key, async () => {
      if (light) {
        // Light mode computes the item count and the first four thumbnail URLs
        // on Atlas itself, so only those cross the wire — never the item arrays.
        // Projecting `items.image` in a find() instead forces Mongo to walk and
        // rebuild every item array server-side: measured at ~50s for this
        // archive vs ~7s for this aggregation, for the same response bytes. The
        // full items are fetched one set at a time from GET
        // /drops-archive/sets/:id when a row is edited or published. Any edit is
        // a write to /drops-archive/*, which clears the cache, so both the light
        // and full variants stay fresh.
        const rows = await DropSet.aggregate([
          { $match: match },
          {
            $project: {
              name: 1,
              note: 1,
              price: 1,
              listed: 1,
              custom: 1,
              coverStyle: 1,
              coverGame: 1,
              sourceType: 1,
              sourceEventName: 1,
              sourceCampaignIds: 1,
              updatedAt: 1,
              itemCount: { $size: { $ifNull: ["$items", []] } },
              // Slice to the first four FIRST, then map — so only four elements
              // are ever materialised, not the whole array.
              thumbs: {
                $map: {
                  input: { $slice: [{ $ifNull: ["$items", []] }, 4] },
                  as: "i",
                  in: { $ifNull: ["$i.image", ""] },
                },
              },
            },
          },
          // Sort the already-shrunk docs (memory-safe under Atlas no-diskUse).
          { $sort: { updatedAt: -1 } },
        ]);
        return {
          success: true,
          sets: rows.map((s) => ({
            id: String(s._id),
            name: s.name,
            note: s.note || "",
            itemCount: Number(s.itemCount) || 0,
            price: Number(s.price) || 0,
            listed: !!s.listed,
            custom: !!s.custom,
            coverStyle: s.coverStyle || "grid",
            coverGame: s.coverGame || "",
            sourceType: s.sourceType || "",
            sourceEventName: s.sourceEventName || "",
            sourceCampaignIds: Array.isArray(s.sourceCampaignIds)
              ? s.sourceCampaignIds
              : [],
            updatedAt: s.updatedAt,
            // Just what a row's thumbnail strip renders — the first four images.
            thumbs: Array.isArray(s.thumbs) ? s.thumbs : [],
          })),
        };
      }
      // Full mode (custom list / callers that need every item snapshot).
      const sets = await DropSet.find(match).sort({ updatedAt: -1 }).lean();
      return {
        success: true,
        sets: sets.map((s) => ({
          id: String(s._id),
          name: s.name,
          note: s.note || "",
          itemCount: (s.items || []).length,
          price: Number(s.price) || 0,
          listed: !!s.listed,
          custom: !!s.custom,
          coverStyle: s.coverStyle || "grid",
          coverGame: s.coverGame || "",
          sourceType: s.sourceType || "",
          sourceEventName: s.sourceEventName || "",
          sourceCampaignIds: Array.isArray(s.sourceCampaignIds)
            ? s.sourceCampaignIds
            : [],
          updatedAt: s.updatedAt,
          items: s.items || [],
        })),
      };
    });
    res.json(payload);
  } catch (err) {
    console.error("drops-archive sets list error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Full detail (including every item) for one set. The Listings page loads its
// list in `light=1` mode without item arrays, then fetches this for the single
// set an operator opens to edit or publish.
router.get("/drops-archive/sets/:id", requireSuperadmin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ success: false, message: "Not found" });
    }
    const set = await DropSet.findById(req.params.id).lean();
    if (!set) {
      return res.status(404).json({ success: false, message: "Not found" });
    }
    res.json({ success: true, set: publicSet(set) });
  } catch (err) {
    console.error("drops-archive set detail error:", err.message);
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
//
// Reservations are keyed on soldSetId, so deleting a set that still owns any
// strands them: the drops read as unavailable forever and no code path can
// free them, because every release needs the set that made them. Live prod
// carries 16,445 unredeemed drops frozen this way behind six deleted sets,
// and two of those sets still have ACTIVE listings selling a product whose
// definition is gone.
//
// They cannot simply be released here — a marketplace reservation looks the
// same whether the unit is still on the shelf or already sold and waiting for
// the buyer to redeem, and freeing the latter hands that account to a second
// buyer. So deletion is refused while anything is outstanding: delisting
// releases the unsold drops through the paths that do know which is which,
// and the set then deletes cleanly. Redeemed reservations are settled history
// and never block.
router.delete(
  "/drops-archive/sets/:id",
  requireSuperadmin,
  async (req, res) => {
    try {
      const live = await MarketplaceListing.find({
        set: req.params.id,
        status: "active",
      })
        .select("marketplace externalId")
        .lean();
      if (live.length) {
        return res.status(409).json({
          success: false,
          message:
            "Delist first: " +
            live.length +
            " live listing(s) still sell this set (" +
            live
              .slice(0, 4)
              .map((l) => l.marketplace + " " + l.externalId)
              .join(", ") +
            (live.length > 4 ? ", …" : "") +
            "). Deleting it now would freeze their reserved drops forever.",
        });
      }
      const frozen = await DropLog.countDocuments({
        soldSetId: String(req.params.id),
        soldAt: { $ne: null },
        connected: { $ne: true },
      });
      if (frozen) {
        return res.status(409).json({
          success: false,
          message:
            frozen +
            " unredeemed drop(s) are still reserved for this set. Release " +
            "them (or let the sales they belong to complete) before " +
            "deleting it, or they can never be sold again.",
        });
      }
      await DropSet.findByIdAndDelete(req.params.id);
      res.json({ success: true });
    } catch (err) {
      console.error("drops-archive set delete error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// Fulfillment: which accounts can deliver the whole bundle, plus per-item stock.
async function fulfillmentAccountScope(set) {
  const logins = [
    ...new Set(
      (set.accountScopeLogins || [])
        .map((login) =>
          String(login || "")
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean),
    ),
  ];
  if (!logins.length) return null;
  const patterns = logins.map(
    (login) =>
      new RegExp(
        "^" + login.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&") + "$",
        "i",
      ),
  );
  const accounts = await BotAccount.find(
    { login: { $in: patterns } },
    { _id: 1 },
  ).lean();
  return accounts.map((account) => account._id);
}

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

      const [badIds, scopedIds] = await Promise.all([
        excludedAccountIdsCached(),
        fulfillmentAccountScope(set),
      ]);
      const bad = new Set(badIds.map((id) => String(id)));
      const allowedIds = scopedIds
        ? scopedIds.filter((id) => !bad.has(String(id)))
        : null;
      const accountMatch = allowedIds ? { $in: allowedIds } : { $nin: badIds };

      // Per account: which of the set's items they hold and the count of each.
      // Connected/redeemed drops can't be delivered again, so they don't count
      // — this keeps these numbers identical to the Shop's stock. Dead accounts
      // are excluded so their unusable stock never inflates availability.
      const rows = await DropLog.aggregate([
        {
          $match: {
            itemKey: { $in: keys },
            connected: { $ne: true },
            account: accountMatch,
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
            account: accountMatch,
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

// Bring the archive rollups up at boot.
//
// This used to replay the by-item/by-game/overview route handlers on a
// staggered timer to fill their per-request caches. All three are now views
// onto one background rollup, so warming means starting the builder: it loads
// the last persisted rollup (instant, survives a restart) and rebuilds it in
// the background if it has gone stale, then keeps it refreshed on a timer.
function warmArchiveViews() {
  archiveSnapshot.start();
}

router.warmArchiveViews = warmArchiveViews;
// Exported for tests only — see tests/archiveBustTargets.test.js.
router.bustTargets = bustTargets;
module.exports = router;
