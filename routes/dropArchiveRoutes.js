const express = require("express");

const { requireSuperadmin } = require("../middleware/auth");
const AvailableAccount = require("../models/AvailableAccount");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const DropSet = require("../models/DropSet");
const { encrypt, decrypt } = require("../utils/secretBox");
const scanner = require("../utils/dropScanner");
const { cacheImage } = require("../utils/imageCache");
const hosts = require("../utils/botHosts");

const router = express.Router();

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

function containerForFile(file) {
  const m = file.match(/^config_0*(\d+)\.json$/);
  if (m) return "twitchbotx" + parseInt(m[1], 10);
  if (file === "config.json") return "twitchbot";
  return "";
}

function publicAccount(a) {
  return {
    id: a._id,
    login: a.login,
    twitchId: a.twitchId,
    configFile: a.configFile,
    container: a.container,
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
    const accounts = await BotAccount.find(q)
      .sort({ login: 1 })
      .limit(limit)
      .lean();
    res.json({ success: true, accounts: accounts.map(publicAccount) });
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
    const accounts = await BotAccount.find(q)
      .sort({ login: 1 })
      .limit(5000)
      .lean();
    res.json({ success: true, accounts: accounts.map(publicAccount) });
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
    if (host) filter.host = host;
    if (!Object.keys(filter).length) {
      return res
        .status(400)
        .json({ success: false, message: "container or configFile required" });
    }
    const label = container || configFile;
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

// Bot configs only carry the ClientSecret (token), so a BotAccount synced from a
// config has no credPassword — but selling an account hands the buyer its
// login+password, and that password lives in the account pool (AvailableAccount).
// Mirror it across for any BotAccount that lacks one, so farmed accounts holding
// sellable drops are actually deliverable. Fill-only: never overwrites an
// existing password. Returns how many were filled.
async function fillBotPasswordsFromPool() {
  const bots = await BotAccount.find(
    { $or: [{ credPassword: "" }, { credPassword: { $exists: false } }] },
    { login: 1 },
  ).lean();
  if (!bots.length) return 0;
  const lowers = [
    ...new Set(bots.map((b) => String(b.login || "").toLowerCase()).filter(Boolean)),
  ];
  const pool = await AvailableAccount.find(
    { usernameLower: { $in: lowers }, password: { $ne: "" } },
    { usernameLower: 1, password: 1 },
  ).lean();
  const poolMap = new Map(pool.map((a) => [a.usernameLower, a.password]));
  const ops = [];
  for (const b of bots) {
    const enc = poolMap.get(String(b.login || "").toLowerCase());
    if (!enc) continue;
    const pw = decrypt(enc);
    if (!pw) continue;
    ops.push({
      updateOne: {
        filter: { _id: b._id },
        update: { $set: { credPassword: encrypt(pw), hasPassword: true } },
      },
    });
  }
  if (ops.length) await BotAccount.bulkWrite(ops, { ordered: false });
  return ops.length;
}

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

  return {
    filesRead,
    accountsFound: found,
    inserted,
    updated,
    passwordsFilled,
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
      const byKey = new Map();
      for (const a of accounts) {
        for (const k of [a.login, a.credUsername]) {
          const key = String(k || "")
            .trim()
            .toLowerCase();
          if (key && !byKey.has(key)) byKey.set(key, a._id);
        }
      }

      let matched = 0;
      const unmatched = [];
      const ops = [];
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const username = String(item.username || "").trim();
        if (!username) continue;
        const id = byKey.get(username.toLowerCase());
        if (!id) {
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
        ops.push({ updateOne: { filter: { _id: id }, update: { $set: set } } });
        matched++;
      }
      if (ops.length) await BotAccount.bulkWrite(ops, { ordered: false });
      res.json({
        success: true,
        matched,
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

// Aggregation expression for the grouping key: stored itemKey when present,
// else a computed name|game (handles rows logged before itemKey existed).
const itemKeyExpr = {
  $cond: [
    { $gt: [{ $strLenCP: { $ifNull: ["$itemKey", ""] } }, 0] },
    "$itemKey",
    {
      $concat: [
        { $toLower: { $trim: { input: { $ifNull: ["$name", ""] } } } },
        "|",
        { $toLower: { $trim: { input: { $ifNull: ["$game", ""] } } } },
      ],
    },
  ],
};

// High-level totals for the dashboard header. Bad-token accounts (and their
// drops) are left out so the header only counts sellable stock. Pool-account
// drops (accountModel: "AvailableAccount" — checked but not deployed to any
// bot yet) are also excluded from these deployed/sellable numbers and
// reported separately as poolItems/poolDrops instead of inflating them.
router.get("/drops-archive/overview", requireSuperadmin, async (req, res) => {
  try {
    const badIds = await badAccountIds();
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
        { $addFields: { _k: itemKeyExpr } },
        { $group: { _id: "$_k" } },
        { $count: "n" },
      ]),
      DropLog.countDocuments(poolMatch),
      DropLog.aggregate([
        { $match: poolMatch },
        { $addFields: { _k: itemKeyExpr } },
        { $group: { _id: "$_k" } },
        { $count: "n" },
      ]),
    ]);
    res.json({
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
    });
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
    const badIds = await badAccountIds();
    const isPool = { $eq: ["$accountModel", "AvailableAccount"] };
    const rows = await DropLog.aggregate([
      { $match: { account: { $nin: badIds } } },
      { $addFields: { _k: itemKeyExpr } },
      {
        $group: {
          _id: "$game",
          drops: { $sum: { $cond: [isPool, 0, 1] } },
          totalCount: { $sum: { $cond: [isPool, 0, "$count"] } },
          accounts: { $addToSet: { $cond: [isPool, "$$REMOVE", "$account"] } },
          items: { $addToSet: { $cond: [isPool, "$$REMOVE", "$_k"] } },
          poolDrops: { $sum: { $cond: [isPool, 1, 0] } },
          poolCount: { $sum: { $cond: [isPool, "$count", 0] } },
          poolAccounts: {
            $addToSet: { $cond: [isPool, "$account", "$$REMOVE"] },
          },
          poolItems: { $addToSet: { $cond: [isPool, "$_k", "$$REMOVE"] } },
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
    res.json({ success: true, games: rows });
  } catch (err) {
    console.error("drops-archive by-game error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// One row per distinct item (reward), collapsed across all accounts. This is
// the inventory view for selling: name, game, image, total held, # accounts.
router.get("/drops-archive/by-item", requireSuperadmin, async (req, res) => {
  try {
    const badIds = await badAccountIds();
    const match = { account: { $nin: badIds } };
    const game = String(req.query.game || "").trim();
    if (game) match.game = game === "Other rewards" ? "" : game;
    const search = String(req.query.search || "").trim();
    if (search) match.name = searchRegex(search);

    const isPool = { $eq: ["$accountModel", "AvailableAccount"] };
    const rows = await DropLog.aggregate([
      { $match: match },
      // Fall back to a computed name|game key for any row whose itemKey
      // wasn't backfilled yet, so items never merge into one bucket.
      { $addFields: { _k: itemKeyExpr } },
      // First collapse per (item, account) so min/max copies per holding
      // account are exact — accounts holding e.g. 4x vs 5x of a drop differ.
      {
        $group: {
          _id: { k: "$_k", acct: "$account" },
          name: { $first: "$name" },
          game: { $first: "$game" },
          imageLocal: { $max: "$imageLocal" },
          imageURL: { $first: "$imageURL" },
          campaign: { $first: "$campaign" },
          pool: { $first: isPool },
          cnt: { $sum: "$count" },
          claimed: {
            $sum: { $cond: [{ $eq: ["$state", "claimed"] }, 1, 0] },
          },
          connect: {
            $sum: { $cond: [{ $eq: ["$state", "connect"] }, 1, 0] },
          },
          connected: {
            $sum: { $cond: [{ $eq: ["$state", "connected"] }, 1, 0] },
          },
        },
      },
      {
        $group: {
          _id: "$_id.k",
          name: { $first: "$name" },
          game: { $first: "$game" },
          imageLocal: { $max: "$imageLocal" },
          imageURL: { $first: "$imageURL" },
          campaign: { $first: "$campaign" },
          // "Deployed" numbers — accounts actually wired into a bot, the
          // sellable stock this view has always meant.
          totalCount: { $sum: { $cond: ["$pool", 0, "$cnt"] } },
          accounts: { $sum: { $cond: ["$pool", 0, 1] } },
          minPerAcct: { $min: { $cond: ["$pool", "$$REMOVE", "$cnt"] } },
          maxPerAcct: { $max: { $cond: ["$pool", "$$REMOVE", "$cnt"] } },
          claimed: { $sum: { $cond: ["$pool", 0, "$claimed"] } },
          connect: { $sum: { $cond: ["$pool", 0, "$connect"] } },
          connected: { $sum: { $cond: ["$pool", 0, "$connected"] } },
          // "In pool" numbers — checked, not yet wired into any bot.
          poolCount: { $sum: { $cond: ["$pool", "$cnt", 0] } },
          poolAccounts: { $sum: { $cond: ["$pool", 1, 0] } },
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
          accounts: 1,
          minPerAcct: 1,
          maxPerAcct: 1,
          claimed: 1,
          connect: 1,
          connected: 1,
          poolCount: 1,
          poolAccounts: 1,
        },
      },
      { $sort: { accounts: -1, totalCount: -1 } },
      { $limit: 2000 },
    ]);
    res.json({ success: true, items: rows });
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
      const badIds = await badAccountIds();
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
              $ifNull: ["$acc.login", { $ifNull: ["$poolAcc.username", "$login"] }],
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
            requiredAccountLink: 1,
            awardedAt: 1,
            firstSeenAt: 1,
            lastSeenAt: 1,
          },
        },
        { $sort: { state: 1, login: 1 } },
      ]);
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
// logged drops, so a set always shows accurate names/images.
async function resolveItemsMeta(keys) {
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
  return uniq.map((k) => {
    const m = byKey.get(k) || {};
    return {
      itemKey: k,
      name: m.name || k.split("|")[0] || "Reward",
      game: m.game || k.split("|")[1] || "",
      image: m.imageLocal || m.imageURL || "",
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
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

// List all sets (lightweight).
router.get("/drops-archive/sets", requireSuperadmin, async (req, res) => {
  try {
    const sets = await DropSet.find({}).sort({ updatedAt: -1 }).lean();
    res.json({
      success: true,
      sets: sets.map((s) => ({
        id: String(s._id),
        name: s.name,
        note: s.note || "",
        items: s.items || [],
        itemCount: (s.items || []).length,
        price: Number(s.price) || 0,
        listed: !!s.listed,
        updatedAt: s.updatedAt,
      })),
    });
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
    const set = await DropSet.create(doc);
    res.json({ success: true, set: publicSet(set) });
  } catch (err) {
    console.error("drops-archive set create error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

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
      const seen = new Set();
      const items = [];
      for (const it of raw) {
        const iname = String((it && it.name) || "").trim();
        if (!iname) continue;
        const game = String((it && it.game) || "").trim();
        // Same normalisation as utils/twitchInventory itemKeyFor + the archive's
        // itemKeyExpr, so this key lines up with what the bots log on claim.
        const itemKey = iname.toLowerCase() + "|" + game.toLowerCase();
        if (seen.has(itemKey)) continue; // collapse duplicate rewards
        seen.add(itemKey);
        // Cache the reward image locally (Twitch URL -> /drop-images/<hash>),
        // exactly like the archive does. coverImagePath() only accepts a file
        // inside public/, so a bare remote URL would leave the set with no cover
        // photo and Gameflip rejects the listing ("must have active
        // cover_photo"). Falls back to "" if the download fails.
        let image = String((it && it.image) || "").trim();
        if (image && !image.startsWith("/")) {
          image = (await cacheImage(image)) || "";
        }
        items.push({
          itemKey,
          name: iname,
          game,
          image,
          qty: Math.max(1, parseInt(it && it.qty, 10) || 1),
        });
      }
      if (!items.length) {
        return res
          .status(400)
          .json({ success: false, message: "No valid items to add" });
      }
      const doc = { name, note: String(body.note || "").trim(), items };
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
        ...new Set(need.map((i) => String(i.game || "").toLowerCase()).filter(Boolean)),
      ];
      const gameRes = games.map(
        (g) => new RegExp("^" + g.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i"),
      );
      const rows = gameRes.length
        ? await DropLog.find(
            { imageLocal: { $ne: "" }, game: { $in: gameRes } },
            { name: 1, game: 1, imageLocal: 1 },
          ).lean()
        : [];
      const map = new Map();
      for (const r of rows) {
        const k = String(r.game || "").toLowerCase() + "|" + coreItemName(r.name);
        if (coreItemName(r.name) && !map.has(k)) map.set(k, r.imageLocal);
      }
      let filled = 0;
      const unmatched = [];
      for (const it of set.items) {
        if (String(it.image || "").startsWith("/")) continue;
        const k = String(it.game || "").toLowerCase() + "|" + coreItemName(it.name);
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
      await resolveItemsMeta(keys),
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

      const badIds = await badAccountIds();

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
            state: { $first: "$state" },
          },
        },
        {
          $group: {
            _id: "$_id.account",
            items: {
              $push: { itemKey: "$_id.k", count: "$count", state: "$state" },
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
          const minCount = complete
            ? Math.min(...r.items.map((i) => i.count || 0))
            : 0;
          return {
            accountId: r.accountId,
            login: r.login || "",
            container: r.container || "",
            configFile: r.configFile || "",
            hasPassword: !!r.hasPassword,
            sold: !!r.soldAt,
            have,
            total,
            complete,
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

      const fullAccounts = accounts.filter((a) => a.complete);
      // One deliverable bundle per account that holds the whole set and is
      // actually sellable (has a stored password and hasn't been sold). This
      // matches the Shop's "in stock" exactly — a buyer receives the whole
      // account, so duplicate copies on one account are not counted twice.
      const bundlesAvailable = fullAccounts.filter(
        (a) => a.hasPassword && !a.sold,
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
      });
    } catch (err) {
      console.error("drops-archive fulfillment error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

module.exports = router;
