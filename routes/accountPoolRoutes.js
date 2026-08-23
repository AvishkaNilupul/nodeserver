// A pool of Twitch accounts that are ready to use for a *new* bot but not
// wired into any bot config yet. Two shapes can be imported and are merged
// by username instead of creating duplicates:
//   - Bot-config style: { Login, ClientSecret, UniqueId, Id, Enabled, ... }
//     (already through Twitch's device-auth flow — no password needed)
//   - Raw credential style: { username, password, email }
//     (bought from a supplier, not yet authenticated with Twitch)
//
// Anything already deployed in a live bot config (tracked in BotAccount) is
// treated as "in use", not "available" — importing it is a no-op reported
// back to the caller rather than silently added to the pool.
const express = require("express");
const mongoose = require("mongoose");

const { requireSuperadmin } = require("../middleware/auth");
const AvailableAccount = require("../models/AvailableAccount");
const PoolUsageEvent = require("../models/PoolUsageEvent");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const accountPoolChecker = require("../utils/accountPoolChecker");
const dropScanner = require("../utils/dropScanner");
const { parseAccountList } = require("../utils/parseAccountList");
const { encrypt, decrypt } = require("../utils/secretBox");
const { fetchInventory, fetchDropCampaigns } = require("../utils/twitchInventory");
const { recordPoolUsage } = require("../utils/poolUsageLog");
const { usageSince, summarizeUsageRows } = require("../utils/poolUsageWatcher");

const router = express.Router();

function publicAccount(a) {
  const history = Array.isArray(a.usageHistory) ? a.usageHistory : [];
  const lastUsedGame = a.lastUsedGame || [...history].reverse().find((entry) => entry.game)?.game || "";
  return {
    id: a._id,
    username: a.username,
    hasPassword: !!a.hasPassword,
    hasEmail: !!a.email,
    // A ClientSecret alone is NOT enough, despite /bot-configs/create happily
    // auto-generating a UniqueId when one is missing: the drops query a bot
    // runs is integrity-gated, and that gate only accepts tokens issued
    // through a real device-auth session. A supplier token authenticates fine
    // and fails it, so anything the check has confirmed Twitch refuses — dead
    // token or failed integrity — isn't "ready" no matter what's stored.
    hasAuth:
      !!a.clientSecret &&
      a.lastCheckStatus !== "token_invalid" &&
      a.lastCheckStatus !== "integrity_failed" &&
      a.lastCheckStatus !== "suspended",
    twitchId: a.twitchId || "",
    status: a.status,
    claimedAt: a.claimedAt,
    claimedNote: a.claimedNote || "",
    source: a.source || "",
    lastCheckAt: a.lastCheckAt || null,
    lastCheckStatus: a.lastCheckStatus || "",
    lastCheckError: a.lastCheckError || "",
    dropCount: a.dropCount || 0,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    usageCount: Number.isFinite(a.usageCount) ? a.usageCount : history.length,
    lastUsedGame,
  };
}

router.get("/account-pool/list", requireSuperadmin, async (req, res) => {
  try {
    // Rows whose account no longer exists on Twitch are kept only when they are
    // sale evidence, and they are not stock any more — so they get their own tab
    // instead of padding the lists the operator works from.
    const status = String(req.query.status || "available");
    const filter =
      status === "suspended"
        ? { lastCheckStatus: "suspended" }
        : status === "all"
          ? { lastCheckStatus: { $ne: "suspended" } }
          : { status, lastCheckStatus: { $ne: "suspended" } };
    // Derive usageCount/lastUsedGame and DROP the full usageHistory array
    // BEFORE the $sort, so the in-memory sort buffers only the small projected
    // docs — Atlas shared tier has allowDiskUse off and a 100MB aggregation
    // cap (see memory: atlas-no-diskuse). Sort by createdAt is untouched, so
    // the ordering is identical to the old find().sort().
    const accounts = await AvailableAccount.aggregate([
      { $match: filter },
      {
        $set: {
          usageCount: { $size: { $ifNull: ["$usageHistory", []] } },
          lastUsedGame: {
            $let: {
              vars: {
                withGames: {
                  $filter: {
                    input: { $reverseArray: { $ifNull: ["$usageHistory", []] } },
                    as: "entry",
                    cond: { $ne: [{ $ifNull: ["$$entry.game", ""] }, ""] },
                  },
                },
              },
              in: {
                $ifNull: [
                  {
                    $arrayElemAt: [
                      { $map: { input: "$$withGames", as: "entry", in: "$$entry.game" } },
                      0,
                    ],
                  },
                  "",
                ],
              },
            },
          },
        },
      },
      { $project: { usageHistory: 0 } },
      { $sort: { createdAt: -1 } },
    ]);
    res.json({ success: true, accounts: accounts.map(publicAccount) });
  } catch (err) {
    console.error("account-pool list error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get("/account-pool/:id/history", requireSuperadmin, async (req, res) => {
  try {
    const acc = await AvailableAccount.findById(req.params.id, { usageHistory: 1 }).lean();
    if (!acc) return res.status(404).json({ success: false, message: "Not found" });
    const history = (acc.usageHistory || []).slice().sort((a, b) => new Date(b.at) - new Date(a.at));
    res.json({ success: true, history });
  } catch (err) {
    console.error("account-pool history error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get("/account-pool/usage-summary", requireSuperadmin, async (req, res) => {
  try {
    const { key: window, since } = usageSince(
      String(req.query.window || "today"),
      new Date(),
      String(req.query.since || ""),
    );
    const rows = await PoolUsageEvent.aggregate([
      { $match: since ? { at: { $gte: since } } : {} },
      {
        $group: {
          _id: { game: "$game", event: "$event", actor: "$actor" },
          count: { $sum: 1 },
        },
      },
    ]);
    const summary = summarizeUsageRows(rows);
    const readyPool = await AvailableAccount.countDocuments({
      status: "available",
      clientSecret: { $gt: "" },
      lastCheckStatus: { $in: ["", "ok"] },
    });
    res.json({
      success: true,
      window,
      totals: { consumed: summary.consumed, returned: summary.returned, net: summary.net, readyPool },
      games: summary.games,
    });
  } catch (err) {
    console.error("account-pool usage summary error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get("/account-pool/usage-feed", requireSuperadmin, async (req, res) => {
  try {
    const { key: window, since } = usageSince(
      String(req.query.window || "today"),
      new Date(),
      String(req.query.since || ""),
    );
    const requestedLimit = parseInt(req.query.limit, 10);
    const limit = Math.max(1, Math.min(100, Number.isFinite(requestedLimit) ? requestedLimit : 100));
    const filter = since ? { at: { $gte: since } } : {};
    const feed = await PoolUsageEvent.find(filter, { _id: 0 })
      .sort({ at: -1 })
      .limit(limit)
      .lean();
    res.json({ success: true, window, feed });
  } catch (err) {
    console.error("account-pool usage feed error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Accounts that still need a working auth token — no clientSecret at all, or
// one the Check button already confirmed Twitch rejects — as decrypted
// {username, password} pairs, so they can be run through an external
// device-auth flow and the resulting clientSecret brought back in via the
// normal import (which fills it onto the existing row, doesn't duplicate).
// `source` selects which table to draw from:
//   pool (default) — AvailableAccount, the original behaviour
//   bots           — BotAccount: accounts already deployed to (or retired from)
//                    a bot config, whose token the drop scanner found dead
//   all            — both, de-duplicated by login
//
// The bots source exists because the pool export could not reach the accounts
// that need re-auth MOST. Audited on prod 2026-07-29: 436 accounts carry a dead
// token, and the 35 sitting inside live Digiseller listings — the ones a buyer
// could be handed right now — are every one of them BotAccount rows, so the
// pool-only export returned exactly none of them. Their credentials are stored
// (credPassword, encrypted), so they are all recoverable; there was simply no
// route that handed them to the device-auth tool.
router.get("/account-pool/export-needs-auth", requireSuperadmin, async (req, res) => {
  try {
    const status = String(req.query.status || "available");
    const source = String(req.query.source || "pool");
    const out = [];
    const seen = new Set();

    if (source !== "bots") {
      const filter = status === "all" ? {} : { status };
      filter.hasPassword = true;
      // integrity_failed belongs here alongside dead tokens: the token
      // authenticates but no bot can use it, and re-running the account through
      // device-auth (which is what this export feeds) is precisely the remedy.
      // A row confirmed gone from Twitch is excluded even when it has no token
      // at all: there is nothing left to device-auth, so exporting it only sends
      // the operator to log into an account that no longer exists.
      filter.lastCheckStatus = { $ne: "suspended" };
      filter.$or = [
        { clientSecret: "" },
        { lastCheckStatus: "token_invalid" },
        { lastCheckStatus: "integrity_failed" },
      ];
      for (const a of await AvailableAccount.find(filter).lean()) {
        const key = String(a.username || "").toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push({ username: a.username, password: decrypt(a.password), source: "pool" });
      }
    }

    if (source === "bots" || source === "all") {
      const rows = await BotAccount.find(
        { hasPassword: true, lastScanStatus: { $in: ["token_invalid", "error"] } },
        { login: 1, credUsername: 1, credPassword: 1, enabled: 1 },
      ).lean();
      for (const r of rows) {
        const username = r.credUsername || r.login;
        const key = String(username || "").toLowerCase();
        if (!key || seen.has(key)) continue;
        const password = decrypt(r.credPassword);
        if (!password) continue;
        seen.add(key);
        out.push({
          username,
          password,
          source: "bot",
          deployed: r.enabled !== false,
        });
      }
    }

    res.json({ success: true, accounts: out, count: out.length });
  } catch (err) {
    console.error("account-pool export error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.post("/account-pool/import", requireSuperadmin, async (req, res) => {
  try {
    let list = req.body && req.body.accounts;
    let badLines = [];
    if (typeof list === "string") {
      // Tolerate a loosely-pasted object sequence, same as the drops-archive
      // credentials importer, then fall back to colon-delimited lines.
      const trimmed = list.trim().replace(/,\s*$/, "");
      let parsed = null;
      try {
        parsed = JSON.parse("[" + trimmed.replace(/^\[|\]$/g, "") + "]");
      } catch {
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          parsed = null;
        }
      }
      if (parsed) {
        list = parsed;
      } else {
        const fromLines = parseAccountList(trimmed);
        if (!fromLines.accounts.length) {
          return res.status(400).json({
            success: false,
            message:
              "Could not parse this as JSON or as login:password:token lines",
          });
        }
        list = fromLines.accounts;
        badLines = fromLines.badLines;
      }
    }
    if (!Array.isArray(list)) {
      return res
        .status(400)
        .json({ success: false, message: "Expected an array of accounts" });
    }

    // Normalize input to one internal shape. Fields are read independently
    // (both the capitalized bot-config names and their lowercase equivalents)
    // rather than branching on "which shape is this" — a single pasted object
    // can legitimately carry a mix, e.g. a supplier handing over
    // { username, password, clientSecret } all at once. Duplicate usernames
    // *within this paste* are merged (e.g. a bot-config entry and a
    // credential entry for the same account pasted together) before ever
    // touching the database.
    const FIELDS = ["clientSecret", "uniqueId", "twitchId", "password", "email"];
    const byLower = new Map();
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const username = String(item.Login || item.username || "").trim();
      if (!username) continue;
      const patch = {
        clientSecret: String(item.ClientSecret || item.clientSecret || "").trim(),
        uniqueId: String(item.UniqueId || item.uniqueId || "").trim(),
        twitchId:
          item.Id != null
            ? String(item.Id).trim()
            : item.twitchId != null
            ? String(item.twitchId).trim()
            : "",
        password: item.password != null ? String(item.password) : "",
        email: item.email != null ? String(item.email).trim() : "",
      };
      const lower = username.toLowerCase();
      const cur =
        byLower.get(lower) ||
        { username, clientSecret: "", uniqueId: "", twitchId: "", password: "", email: "" };
      for (const k of FIELDS) {
        if (patch[k] && !cur[k]) cur[k] = patch[k];
      }
      byLower.set(lower, cur);
    }
    const normalized = Array.from(byLower.values());

    if (!normalized.length) {
      return res.json({
        success: true,
        added: 0,
        merged: 0,
        alreadyInUse: [],
        alreadyInUseCount: 0,
        badLines,
        badLineCount: badLines.length,
      });
    }

    // Accounts already deployed in a live bot config are "in use", not
    // available — they aren't added to the pool, reported back rather than
    // silently added. But a paste that carries a password for an in-use
    // account whose BotAccount lacks one fills that password in (fill-only),
    // instead of dropping it on the floor — otherwise the account stays
    // undeliverable (0 stock) with no way to fix it short of the credentials
    // importer.
    const inUseAccounts = await BotAccount.find(
      {},
      { login: 1, credPassword: 1 },
    ).lean();
    const inUseByLower = new Map(
      inUseAccounts
        .filter((a) => String(a.login || "").trim())
        .map((a) => [String(a.login).trim().toLowerCase(), a]),
    );
    const inUseSet = new Set(inUseByLower.keys());

    const lowers = normalized.map((n) => n.username.toLowerCase());
    const existing = await AvailableAccount.find({
      usernameLower: { $in: lowers },
    });
    const existingByLower = new Map(existing.map((e) => [e.usernameLower, e]));

    let added = 0;
    let merged = 0;
    const alreadyInUse = [];
    const ops = [];
    // Every account that just received a clientSecret it didn't have before
    // — brand new or freshly filled in on an existing row — gets queued for
    // an automatic Twitch check instead of waiting on a manual click.
    const toAutoCheck = [];

    const botPwOps = [];
    for (const item of normalized) {
      const lower = item.username.toLowerCase();
      if (inUseSet.has(lower)) {
        alreadyInUse.push(item.username);
        const bot = inUseByLower.get(lower);
        if (
          item.password &&
          bot &&
          (!bot.credPassword || !String(bot.credPassword).length)
        ) {
          botPwOps.push({
            updateOne: {
              filter: { _id: bot._id },
              update: {
                $set: {
                  credPassword: encrypt(item.password),
                  hasPassword: true,
                },
              },
            },
          });
        }
        continue;
      }

      const found = existingByLower.get(lower);
      if (found) {
        // Fill in only what's missing — never overwrite a value already
        // stored, and never create a second row for the same username.
        const set = {};
        if (item.clientSecret && !found.clientSecret) set.clientSecret = item.clientSecret;
        if (item.uniqueId && !found.uniqueId) set.uniqueId = item.uniqueId;
        if (item.twitchId && !found.twitchId) set.twitchId = item.twitchId;
        if (item.password && !found.hasPassword) {
          set.password = encrypt(item.password);
          set.hasPassword = true;
        }
        if (item.email && !decrypt(found.email)) set.email = encrypt(item.email);
        if (Object.keys(set).length) {
          ops.push({ updateOne: { filter: { _id: found._id }, update: { $set: set } } });
          merged++;
          if (set.clientSecret) toAutoCheck.push(found._id);
        }
        continue;
      }

      const newId = new mongoose.Types.ObjectId();
      ops.push({
        insertOne: {
          document: {
            _id: newId,
            username: item.username,
            usernameLower: lower,
            clientSecret: item.clientSecret || "",
            uniqueId: item.uniqueId || "",
            twitchId: item.twitchId || "",
            password: item.password ? encrypt(item.password) : "",
            hasPassword: !!item.password,
            email: item.email ? encrypt(item.email) : "",
            status: "available",
            source: "manual-import",
          },
        },
      });
      added++;
      if (item.clientSecret) toAutoCheck.push(newId);
    }

    if (ops.length) await AvailableAccount.bulkWrite(ops, { ordered: false });
    if (botPwOps.length)
      await BotAccount.bulkWrite(botPwOps, { ordered: false }).catch(() => {});
    const autoChecking = toAutoCheck.length
      ? accountPoolChecker.enqueue(toAutoCheck)
      : 0;

    res.json({
      success: true,
      added,
      merged,
      alreadyInUse,
      alreadyInUseCount: alreadyInUse.length,
      botPasswordsFilled: botPwOps.length,
      autoChecking,
      badLines,
      badLineCount: badLines.length,
    });
  } catch (err) {
    console.error("account-pool import error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Progress of the background auto-check queue kicked off by /import, so the
// page can show "checking N of M" instead of the admin wondering whether
// anything is happening.
router.get(
  "/account-pool/check-queue/status",
  requireSuperadmin,
  (req, res) => {
    res.json({ success: true, ...accountPoolChecker.status() });
  },
);

// Sweeps every account that has a clientSecret but hasn't fed the drops
// archive yet. That's not just accounts with lastCheckStatus:"" — plenty
// were auto-checked (and are sitting there "verified" with a real dropCount)
// from before the archive-write step existed on that path, so their actual
// per-item drops were never persisted anywhere. Re-checking is what
// backfills them; the cached dropCount alone isn't enough to reconstruct the
// item list. New imports queue themselves automatically going forward — this
// is for catching up the historical backlog by hand, once.
router.post(
  "/account-pool/check-queue/enqueue-unchecked",
  requireSuperadmin,
  async (req, res) => {
    try {
      // Default scope is the available accounts shown on the page. The old
      // whole-pool sweep (which also backfills claimed accounts) is opt-in via
      // ?includeClaimed=1, since claimed accounts are hidden from the list and
      // seeing hundreds queued from a 41-row page reads as a bug otherwise.
      const includeClaimed =
        req.query.includeClaimed === "1" || req.query.includeClaimed === "true";
      const archivedIds = await DropLog.distinct("account", {
        accountModel: "AvailableAccount",
      });
      const filter = {
        clientSecret: { $ne: "" },
        _id: { $nin: archivedIds },
        // A confirmed-gone account cannot be re-checked into life.
        lastCheckStatus: { $ne: "suspended" },
      };
      if (!includeClaimed) filter.status = "available";
      const rows = await AvailableAccount.find(filter, {
        _id: 1,
        status: 1,
      }).lean();
      const ids = rows.map((r) => r._id);
      const queued = accountPoolChecker.enqueue(ids);
      // Report the available/claimed split so the toast can spell it out —
      // relevant when includeClaimed is on and the total exceeds the visible
      // (available-only) list.
      res.json({
        success: true,
        queued,
        targetedAvailable: rows.filter((r) => r.status === "available").length,
        targetedClaimed: rows.filter((r) => r.status === "claimed").length,
        alreadyQueued: ids.length - queued,
      });
    } catch (err) {
      console.error("account-pool enqueue-unchecked error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// Reveal the decrypted password for one account (superadmin only, on demand).
router.get(
  "/account-pool/:id/password",
  requireSuperadmin,
  async (req, res) => {
    try {
      const acc = await AvailableAccount.findById(req.params.id).lean();
      if (!acc) {
        return res.status(404).json({ success: false, message: "Not found" });
      }
      res.json({
        success: true,
        password: decrypt(acc.password),
        email: decrypt(acc.email),
        clientSecret: acc.clientSecret || "",
        uniqueId: acc.uniqueId || "",
        twitchId: acc.twitchId || "",
      });
    } catch (err) {
      console.error("account-pool reveal error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// Verify a stored clientSecret against Twitch itself (not just "is it
// non-empty") and pull the account's actual drops inventory — the same
// GQL call and token-validity rules the drop-archive scanner uses
// (utils/twitchInventory.js), so "auth ready" here means Twitch actually
// accepted the token just now, not just that a value is present.
router.post("/account-pool/:id/check", requireSuperadmin, async (req, res) => {
  try {
    const acc = await AvailableAccount.findById(req.params.id);
    if (!acc) {
      return res.status(404).json({ success: false, message: "Not found" });
    }
    if (!acc.clientSecret) {
      return res.status(400).json({
        success: false,
        message: "No auth token stored for this account yet",
      });
    }
    const now = new Date();
    try {
      const { twitchId, login, drops } = await fetchInventory(acc.clientSecret);
      if (twitchId) acc.twitchId = twitchId;
      acc.dropCount = drops.length;
      // Inventory passing only means the token authenticates. Verify the
      // integrity-gated query a bot actually runs too, otherwise this button
      // green-lights tokens no bot can use (see utils/accountPoolChecker.js).
      let integrityOk = true;
      let integrityError = "";
      try {
        await fetchDropCampaigns(acc.clientSecret);
      } catch (e) {
        if (e.code === "integrity_failed") {
          integrityOk = false;
          integrityError = (e.message || String(e)).slice(0, 300);
        }
      }
      acc.lastCheckAt = now;
      acc.lastCheckStatus = integrityOk ? "ok" : "integrity_failed";
      acc.lastCheckError = integrityOk ? "" : integrityError;
      await acc.save();
      // Best-effort — feeds the drops-archive "in pool" view; a write
      // hiccup here shouldn't fail the check itself.
      await dropScanner
        .upsertDrops(acc._id, "AvailableAccount", login || acc.username, drops)
        .catch((e) =>
          console.error("account-pool check: drop-archive upsert failed:", e.message),
        );
      res.json({
        success: true,
        status: acc.lastCheckStatus,
        message: acc.lastCheckError,
        twitchId: acc.twitchId,
        login: login || acc.username,
        dropCount: drops.length,
        drops: drops.slice(0, 300).map((d) => ({
          name: d.name,
          game: d.game,
          count: d.count,
          state: d.state,
        })),
      });
    } catch (e) {
      acc.lastCheckAt = now;
      acc.lastCheckStatus =
        e.code === "token_invalid"
          ? "token_invalid"
          : e.code === "integrity_failed"
            ? "integrity_failed"
            : "error";
      acc.lastCheckError = (e.message || String(e)).slice(0, 300);
      await acc.save();
      res.json({
        success: true,
        status: acc.lastCheckStatus,
        message: acc.lastCheckError,
      });
    }
  } catch (err) {
    console.error("account-pool check error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Mark an account claimed (you're using it for a new bot) so it drops out
// of the "available" list. Doesn't delete it — reversible via /unclaim.
router.post("/account-pool/:id/claim", requireSuperadmin, async (req, res) => {
  try {
    const note = req.body && req.body.note ? String(req.body.note).slice(0, 200) : "";
    const acc = await AvailableAccount.findByIdAndUpdate(
      req.params.id,
      { $set: { status: "claimed", claimedAt: new Date(), claimedNote: note } },
      { new: true },
    ).lean();
    if (!acc) {
      return res.status(404).json({ success: false, message: "Not found" });
    }
    await recordPoolUsage(acc._id, { event: "claimed", actor: "manual", note });
    res.json({ success: true, account: publicAccount(acc) });
  } catch (err) {
    console.error("account-pool claim error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.post("/account-pool/:id/unclaim", requireSuperadmin, async (req, res) => {
  try {
    const acc = await AvailableAccount.findByIdAndUpdate(
      req.params.id,
      { $set: { status: "available", claimedAt: null, claimedNote: "" } },
      { new: true },
    ).lean();
    if (!acc) {
      return res.status(404).json({ success: false, message: "Not found" });
    }
    await recordPoolUsage(acc._id, { event: "released", actor: "manual" });
    res.json({ success: true, account: publicAccount(acc) });
  } catch (err) {
    console.error("account-pool unclaim error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.delete("/account-pool/:id", requireSuperadmin, async (req, res) => {
  try {
    const acc = await AvailableAccount.findByIdAndDelete(req.params.id).lean();
    if (!acc) {
      return res.status(404).json({ success: false, message: "Not found" });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("account-pool delete error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
