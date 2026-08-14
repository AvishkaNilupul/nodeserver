// Account Stash: named holding folders ("sets") for Twitch accounts you're not
// ready to put to work yet. Completely separate from the Account Pool — nothing
// here is visible to any bot, the drop scanner, or the pool until you
// explicitly move a set (or a selection) into the pool. See models/StashSet.js
// and models/StashAccount.js for the isolation rationale.
//
// The only place the stash reaches into the rest of the app is
// POST /:id/move-to-pool, which hands accounts to AvailableAccount using the
// same merge-by-username / skip-if-in-use safety the pool importer uses, then
// removes them from the stash.
const express = require("express");
const mongoose = require("mongoose");
const crypto = require("crypto");

const { requireSuperadmin } = require("../middleware/auth");
const StashSet = require("../models/StashSet");
const StashAccount = require("../models/StashAccount");
const StashAgingLog = require("../models/StashAgingLog");
// AvailableAccount / BotAccount / accountPoolChecker are no longer required
// here: everything that touches the Account Pool now goes through
// utils/stashPromote.js, so the manual button and the aging runner's
// auto-graduate share one implementation of the placement rules.
const stashChecker = require("../utils/stashChecker");
const stashAging = require("../utils/stashAging");
const { promoteAccounts } = require("../utils/stashPromote");
const { parseAccountList } = require("../utils/parseAccountList");
const { planStashMove } = require("../utils/stashMovePlan");
const { encrypt, decrypt } = require("../utils/secretBox");
const botHosts = require("../utils/botHosts");

const router = express.Router();

function publicAccount(a) {
  return {
    id: a._id,
    setId: a.setId,
    username: a.username,
    hasPassword: !!a.hasPassword,
    hasEmail: !!a.email,
    // Same "ready" rule as the pool: a clientSecret is only usable if the last
    // check didn't find Twitch rejecting it.
    hasAuth:
      !!a.clientSecret &&
      a.lastCheckStatus !== "token_invalid" &&
      a.lastCheckStatus !== "integrity_failed",
    twitchId: a.twitchId || "",
    lastCheckAt: a.lastCheckAt || null,
    lastCheckStatus: a.lastCheckStatus || "",
    lastCheckError: a.lastCheckError || "",
    dropCount: a.dropCount || 0,
    source: a.source || "",
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    aging: publicAging(a),
  };
}

// The aging half of an account row. Always present (even for sets that never
// switched aging on) so the page can render one shape; `stage` simply reads
// "new" for anything the runner has never looked at.
function publicAging(a, policy) {
  const g = a.aging || {};
  const ageDays = a.createdAt
    ? Math.floor((Date.now() - new Date(a.createdAt).getTime()) / 86400000)
    : 0;
  const out = {
    stage: g.stage || "new",
    sessions: g.sessions || 0,
    watchMinutes: g.watchMinutes || 0,
    follows: g.follows || 0,
    taste: Array.isArray(g.taste) ? g.taste : [],
    lastSessionAt: g.lastSessionAt || null,
    lastChannel: g.lastChannel || "",
    lastSessionKind: g.lastSessionKind || "",
    nextEligibleAt: g.nextEligibleAt || null,
    strikes: g.strikes || 0,
    lastError: g.lastError || "",
    maturedAt: g.maturedAt || null,
    ageDays,
  };
  // Only computable with a policy in hand — the set-detail endpoint has one,
  // so it can tell you exactly what each account is still short of.
  if (policy) {
    out.gaps = stashAging.maturityGaps(a, policy);
    out.mature = g.stage === "mature" || stashAging.isMature(a, policy);
  }
  return out;
}

// Reused by both the raw-string and JSON import paths, and by move-to-pool.
// Normalizes one loosely-shaped input object into our internal fields, reading
// both bot-config names (Login/ClientSecret/UniqueId/Id) and lowercase
// credential names so a single paste can carry a mix.
function normalizeItem(item) {
  if (!item || typeof item !== "object") return null;
  const username = String(item.Login || item.username || "").trim();
  if (!username) return null;
  return {
    username,
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
}

// Merge a list of normalized items into a Map keyed by lowercase username,
// filling missing fields rather than clobbering — same within-paste dedupe the
// pool importer does.
function mergeNormalized(list) {
  const FIELDS = ["clientSecret", "uniqueId", "twitchId", "password", "email"];
  const byLower = new Map();
  for (const item of list) {
    const norm = normalizeItem(item);
    if (!norm) continue;
    const lower = norm.username.toLowerCase();
    const cur =
      byLower.get(lower) ||
      { username: norm.username, clientSecret: "", uniqueId: "", twitchId: "", password: "", email: "" };
    for (const k of FIELDS) {
      if (norm[k] && !cur[k]) cur[k] = norm[k];
    }
    byLower.set(lower, cur);
  }
  return Array.from(byLower.values());
}

// Turn req.body.accounts (a JSON array, a loosely-pasted object sequence, or
// colon-delimited lines) into a normalized, de-duped list. Mirrors the pool
// importer's tolerant parsing.
function parseImportBody(raw) {
  let list = raw;
  let badLines = [];
  if (typeof list === "string") {
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
      if (!fromLines.accounts.length) return { error: "Could not parse this as JSON or as login:password:token lines" };
      list = fromLines.accounts;
      badLines = fromLines.badLines;
    }
  }
  if (!Array.isArray(list)) return { error: "Expected an array of accounts" };
  return { normalized: mergeNormalized(list), badLines };
}

async function setWithCounts(set) {
  const counts = await StashAccount.aggregate([
    { $match: { setId: set._id } },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        live: { $sum: { $cond: [{ $eq: ["$lastCheckStatus", "ok"] }, 1, 0] } },
        dead: {
          $sum: {
            $cond: [
              { $in: ["$lastCheckStatus", ["token_invalid", "integrity_failed", "error"]] },
              1,
              0,
            ],
          },
        },
        unchecked: { $sum: { $cond: [{ $eq: ["$lastCheckStatus", ""] }, 1, 0] } },
        // Aging ladder census, folded into the SAME aggregation rather than a
        // second round trip — prod Mongo is an Atlas shared tier that
        // serialises concurrent queries, so cutting round trips matters more
        // than keeping each one minimal.
        aging: {
          $sum: {
            $cond: [
              { $in: ["$aging.stage", ["verify", "settle", "warmup", "active"]] },
              1,
              0,
            ],
          },
        },
        mature: { $sum: { $cond: [{ $eq: ["$aging.stage", "mature"] }, 1, 0] } },
        parked: {
          $sum: { $cond: [{ $in: ["$aging.stage", ["paused", "dead"]] }, 1, 0] },
        },
        watchMinutes: { $sum: { $ifNull: ["$aging.watchMinutes", 0] } },
      },
    },
  ]);
  const c = counts[0] || {
    total: 0,
    live: 0,
    dead: 0,
    unchecked: 0,
    aging: 0,
    mature: 0,
    parked: 0,
    watchMinutes: 0,
  };
  const live = stashAging.liveStatus(set._id);
  return {
    id: set._id,
    name: set.name,
    note: set.note || "",
    total: c.total,
    live: c.live,
    dead: c.dead,
    unchecked: c.unchecked,
    scanning: stashChecker.isScanning(set._id),
    aging: publicPolicy(set),
    agingCounts: {
      inLadder: c.aging || 0,
      mature: c.mature || 0,
      parked: c.parked || 0,
      watchMinutes: c.watchMinutes || 0,
      running: live.running,
      claimed: live.claimed,
    },
    createdAt: set.createdAt,
    updatedAt: set.updatedAt,
  };
}

// A set's aging policy, normalised through the runner so the page and the
// runner can never disagree about what a blank field defaults to.
function publicPolicy(set) {
  return stashAging.policyOf(set);
}

// ---------------------------------------------------------------- sets

router.get("/account-stash/sets", requireSuperadmin, async (req, res) => {
  try {
    const sets = await StashSet.find().sort({ createdAt: -1 });
    const out = await Promise.all(sets.map(setWithCounts));
    res.json({ success: true, sets: out });
  } catch (err) {
    console.error("stash sets list error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.post("/account-stash/sets", requireSuperadmin, async (req, res) => {
  try {
    const name = String((req.body && req.body.name) || "").trim();
    if (!name) return res.status(400).json({ success: false, message: "Set name required" });
    const note = String((req.body && req.body.note) || "").slice(0, 500);
    const nameLower = name.toLowerCase();
    const exists = await StashSet.findOne({ nameLower });
    if (exists) return res.status(409).json({ success: false, message: "A set with that name already exists" });
    const set = await StashSet.create({ name, nameLower, note });
    res.json({ success: true, set: await setWithCounts(set) });
  } catch (err) {
    console.error("stash set create error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.patch("/account-stash/sets/:id", requireSuperadmin, async (req, res) => {
  try {
    const set = await StashSet.findById(req.params.id);
    if (!set) return res.status(404).json({ success: false, message: "Not found" });
    if (req.body && req.body.name != null) {
      const name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ success: false, message: "Set name required" });
      const nameLower = name.toLowerCase();
      const clash = await StashSet.findOne({ nameLower, _id: { $ne: set._id } });
      if (clash) return res.status(409).json({ success: false, message: "A set with that name already exists" });
      set.name = name;
      set.nameLower = nameLower;
    }
    if (req.body && req.body.note != null) set.note = String(req.body.note).slice(0, 500);
    await set.save();
    res.json({ success: true, set: await setWithCounts(set) });
  } catch (err) {
    console.error("stash set update error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.delete("/account-stash/sets/:id", requireSuperadmin, async (req, res) => {
  try {
    const set = await StashSet.findByIdAndDelete(req.params.id);
    if (!set) return res.status(404).json({ success: false, message: "Not found" });
    const del = await StashAccount.deleteMany({ setId: set._id });
    res.json({ success: true, deletedAccounts: del.deletedCount || 0 });
  } catch (err) {
    console.error("stash set delete error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ------------------------------------------------------- accounts in a set

router.get("/account-stash/sets/:id/accounts", requireSuperadmin, async (req, res) => {
  try {
    const set = await StashSet.findById(req.params.id);
    if (!set) return res.status(404).json({ success: false, message: "Not found" });
    const accounts = await StashAccount.find({ setId: set._id }).sort({ createdAt: -1 }).lean();
    // With the set's policy in hand every row can also report what it's still
    // short of, which is what the detail table's "Ready in" column shows.
    const policy = stashAging.policyOf(set);
    res.json({
      success: true,
      set: await setWithCounts(set),
      accounts: accounts.map((a) => ({
        ...publicAccount(a),
        aging: publicAging(a, policy),
      })),
      live: stashAging.liveStatus(set._id),
    });
  } catch (err) {
    console.error("stash accounts list error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.post("/account-stash/sets/:id/import", requireSuperadmin, async (req, res) => {
  try {
    const set = await StashSet.findById(req.params.id);
    if (!set) return res.status(404).json({ success: false, message: "Not found" });

    const parsed = parseImportBody(req.body && req.body.accounts);
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
    const { normalized, badLines } = parsed;
    if (!normalized.length) {
      return res.json({ success: true, added: 0, merged: 0, badLines, badLineCount: badLines.length });
    }

    const lowers = normalized.map((n) => n.username.toLowerCase());
    const existing = await StashAccount.find({ setId: set._id, usernameLower: { $in: lowers } });
    const existingByLower = new Map(existing.map((e) => [e.usernameLower, e]));

    let added = 0;
    let merged = 0;
    const ops = [];
    for (const item of normalized) {
      const lower = item.username.toLowerCase();
      const found = existingByLower.get(lower);
      if (found) {
        // Fill only what's missing; never overwrite or duplicate within a set.
        const set$ = {};
        if (item.clientSecret && !found.clientSecret) set$.clientSecret = item.clientSecret;
        if (item.uniqueId && !found.uniqueId) set$.uniqueId = item.uniqueId;
        if (item.twitchId && !found.twitchId) set$.twitchId = item.twitchId;
        if (item.password && !found.hasPassword) {
          set$.password = encrypt(item.password);
          set$.hasPassword = true;
        }
        if (item.email && !decrypt(found.email)) set$.email = encrypt(item.email);
        if (Object.keys(set$).length) {
          ops.push({ updateOne: { filter: { _id: found._id }, update: { $set: set$ } } });
          merged++;
        }
        continue;
      }
      ops.push({
        insertOne: {
          document: {
            _id: new mongoose.Types.ObjectId(),
            setId: set._id,
            username: item.username,
            usernameLower: lower,
            clientSecret: item.clientSecret || "",
            uniqueId: item.uniqueId || "",
            twitchId: item.twitchId || "",
            password: item.password ? encrypt(item.password) : "",
            hasPassword: !!item.password,
            email: item.email ? encrypt(item.email) : "",
            source: "stash-import",
            // bulkWrite bypasses Mongoose defaults, so the aging subdocument
            // is written explicitly here. Without it an imported account would
            // land with no `aging` field and the runner would have to infer
            // one; being explicit keeps every row the same shape.
            aging: { stage: "new", nextEligibleAt: new Date() },
          },
        },
      });
      added++;
    }
    if (ops.length) await StashAccount.bulkWrite(ops, { ordered: false });
    res.json({ success: true, added, merged, badLines, badLineCount: badLines.length });
  } catch (err) {
    console.error("stash import error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// --------------------------------------------------------------- scanning

router.post("/account-stash/sets/:id/scan", requireSuperadmin, async (req, res) => {
  try {
    const set = await StashSet.findById(req.params.id);
    if (!set) return res.status(404).json({ success: false, message: "Not found" });
    const result = await stashChecker.scanSet(set._id);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("stash scan error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get("/account-stash/sets/:id/scan/status", requireSuperadmin, (req, res) => {
  res.json({ success: true, ...stashChecker.statusFor(req.params.id) });
});

// ----------------------------------------------------------------- aging
//
// Everything below drives utils/stashAging.js. Note what is NOT here: there is
// no endpoint that forces an account onto a later rung of the ladder. Stages
// are earned by elapsed time and banked sessions, and letting the UI skip them
// would make the whole thing decorative.

const NUMERIC_POLICY_FIELDS = [
  "settleDays",
  "settleDaysMax",
  "minDays",
  "minSessions",
  "minWatchMinutes",
  "sessionsPerWeek",
  "minSessionMinutes",
  "maxSessionMinutes",
  "tasteSize",
  "followTarget",
  "maxConcurrent",
];
const BOOL_POLICY_FIELDS = [
  "enabled",
  "avoidDropChannels",
  "autoGraduate",
  "dryRun",
];

router.get("/account-stash/sets/:id/aging", requireSuperadmin, async (req, res) => {
  try {
    const set = await StashSet.findById(req.params.id);
    if (!set) return res.status(404).json({ success: false, message: "Not found" });
    res.json({
      success: true,
      policy: stashAging.policyOf(set),
      live: stashAging.liveStatus(set._id),
      hosts: botHosts.listHosts().map((h) => ({ id: h.id, label: h.label })),
      limits: {
        warmupSessions: stashAging.WARMUP_SESSIONS,
        maxStrikes: stashAging.MAX_STRIKES,
        globalMaxConcurrent: stashAging.MAX_GLOBAL_CONCURRENT,
      },
    });
  } catch (err) {
    console.error("stash aging read error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.put("/account-stash/sets/:id/aging", requireSuperadmin, async (req, res) => {
  try {
    const set = await StashSet.findById(req.params.id);
    if (!set) return res.status(404).json({ success: false, message: "Not found" });
    const body = req.body || {};
    if (!set.aging) set.aging = {};

    for (const f of NUMERIC_POLICY_FIELDS) {
      if (body[f] == null) continue;
      const n = Number(body[f]);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ success: false, message: f + " must be a non-negative number" });
      }
      set.aging[f] = n;
    }
    for (const f of BOOL_POLICY_FIELDS) {
      if (body[f] == null) continue;
      set.aging[f] = !!body[f];
    }
    if (Array.isArray(body.channelPool)) {
      set.aging.channelPool = body.channelPool
        .map((c) => String(c || "").trim().toLowerCase().replace(/^@+/, ""))
        .filter(Boolean)
        .slice(0, 100);
    }
    if (Array.isArray(body.hostIds)) {
      // Only ids that actually resolve — a typo'd host would otherwise silently
      // fall back to local and look like it was honoured.
      const known = new Set(botHosts.listHosts().map((h) => h.id));
      set.aging.hostIds = body.hostIds.map(String).filter((h) => known.has(h));
    }

    // A session window with min above max would make randInt degenerate; fix it
    // here rather than letting the runner quietly clamp on every session.
    if (set.aging.minSessionMinutes > set.aging.maxSessionMinutes) {
      const lo = set.aging.maxSessionMinutes;
      set.aging.maxSessionMinutes = set.aging.minSessionMinutes;
      set.aging.minSessionMinutes = lo;
    }

    await set.save();

    // Switching a set on: give every account that has never been scheduled a
    // wake time so the runner picks it up on the next tick instead of leaving
    // it stranded with a null nextEligibleAt. Staggered across the next hour so
    // enabling a 200-account set doesn't produce a thundering herd.
    let scheduled = 0;
    if (set.aging.enabled) {
      const pending = await StashAccount.find({
        setId: set._id,
        $and: [
          { $or: [{ "aging.stage": { $exists: false } }, { "aging.stage": "new" }] },
          { $or: [{ "aging.nextEligibleAt": null }, { "aging.nextEligibleAt": { $exists: false } }] },
        ],
      })
        .select("_id")
        .lean();
      const ops = pending.map((p) => ({
        updateOne: {
          filter: { _id: p._id },
          update: {
            $set: {
              "aging.stage": "new",
              "aging.nextEligibleAt": new Date(Date.now() + Math.floor(Math.random() * 3600000)),
            },
          },
        },
      }));
      if (ops.length) await StashAccount.bulkWrite(ops, { ordered: false });
      scheduled = ops.length;
    }

    res.json({ success: true, policy: stashAging.policyOf(set), scheduled });
  } catch (err) {
    console.error("stash aging update error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Live progress for the aging panel — what's watching right now, plus the most
// recent events across the whole set.
router.get("/account-stash/sets/:id/aging/status", requireSuperadmin, async (req, res) => {
  try {
    const setId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(setId)) {
      return res.status(400).json({ success: false, message: "Bad set id" });
    }
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 30));
    const feed = await StashAgingLog.find({ setId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    res.json({
      success: true,
      live: stashAging.liveStatus(setId),
      feed: feed.map((f) => ({
        id: f._id,
        accountId: f.accountId,
        username: f.username,
        kind: f.kind,
        message: f.message,
        channel: f.channel || "",
        minutes: f.minutes || 0,
        host: f.host || "",
        kindDetail: f.kindDetail || "",
        ok: f.ok !== false,
        dryRun: !!f.dryRun,
        createdAt: f.createdAt,
      })),
    });
  } catch (err) {
    console.error("stash aging status error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// One account's full story, for the timeline drawer.
router.get("/account-stash/:id/aging/timeline", requireSuperadmin, async (req, res) => {
  try {
    const acc = await StashAccount.findById(req.params.id).lean();
    if (!acc) return res.status(404).json({ success: false, message: "Not found" });
    const set = await StashSet.findById(acc.setId).lean();
    const policy = set ? stashAging.policyOf(set) : null;
    const events = await StashAgingLog.find({ accountId: acc._id })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    res.json({
      success: true,
      account: { ...publicAccount(acc), aging: publicAging(acc, policy) },
      policy,
      events: events.map((f) => ({
        id: f._id,
        kind: f.kind,
        message: f.message,
        fromStage: f.fromStage || "",
        toStage: f.toStage || "",
        channel: f.channel || "",
        minutes: f.minutes || 0,
        host: f.host || "",
        kindDetail: f.kindDetail || "",
        ok: f.ok !== false,
        dryRun: !!f.dryRun,
        createdAt: f.createdAt,
      })),
    });
  } catch (err) {
    console.error("stash aging timeline error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Run one account's next step immediately. This is the canary: rather than
// assuming the watch pipeline works because nothing threw, point it at one real
// account and read the session row it produces — in particular whether it comes
// back "watched" (minute-watched accepted) or "presence" (no watch time).
router.post("/account-stash/:id/aging/run-now", requireSuperadmin, async (req, res) => {
  try {
    const acc = await StashAccount.findById(req.params.id).select("_id setId").lean();
    if (!acc) return res.status(404).json({ success: false, message: "Not found" });
    const set = await StashSet.findById(acc.setId).lean();
    if (!set) return res.status(404).json({ success: false, message: "Set not found" });
    if (!set.aging || !set.aging.enabled) {
      return res.status(400).json({
        success: false,
        message: "Aging is off for this set — turn it on first",
      });
    }
    const result = await stashAging.runNow(acc._id);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("stash aging run-now error:", err.message);
    res.status(500).json({ success: false, message: err.message || "Server error" });
  }
});

// Pause / resume one account. Resume deliberately returns it to `new` only when
// it never got started; an account that was mid-ladder goes back to where it
// was so a pause doesn't cost it its progress.
router.post("/account-stash/:id/aging/:action", requireSuperadmin, async (req, res) => {
  try {
    const action = String(req.params.action || "");
    if (!["pause", "resume", "reset"].includes(action)) {
      return res.status(404).json({ success: false, message: "Unknown action" });
    }
    const acc = await StashAccount.findById(req.params.id);
    if (!acc) return res.status(404).json({ success: false, message: "Not found" });
    if (!acc.aging) acc.aging = {};
    const from = acc.aging.stage || "new";

    if (action === "pause") {
      acc.aging.stage = "paused";
      acc.aging.nextEligibleAt = null;
    } else if (action === "resume") {
      // Where a resumed account rejoins the ladder depends on what it has
      // actually done, not just on how many sessions it banked.
      //
      // This used to drop straight into `warmup`, which quietly skipped BOTH
      // verification and the settle window. Combined with the token-race that
      // parked fresh automator accounts, it meant a resumed account could be
      // watching Twitch minutes after signup with a token nobody had checked —
      // the exact opposite of what settle exists to prevent.
      if (!acc.clientSecret) {
        acc.aging.stage = "new";
      } else if (acc.lastCheckStatus !== "ok") {
        // Never verified, or the last check failed. Start at verify and let
        // the ladder put it through settle properly afterwards.
        acc.aging.stage = "verify";
      } else if ((acc.aging.sessions || 0) >= stashAging.WARMUP_SESSIONS) {
        acc.aging.stage = "active";
      } else if ((acc.aging.sessions || 0) > 0) {
        acc.aging.stage = "warmup";
      } else {
        // Verified but never watched — it was paused during settle, so send it
        // back through verify, which re-draws a fresh settle window for it.
        acc.aging.stage = "verify";
      }
      acc.aging.strikes = 0;
      acc.aging.lastError = "";
      acc.aging.nextEligibleAt = new Date();
    } else {
      // Full reset: back to the bottom of the ladder, counters cleared. The
      // account's real Twitch history obviously isn't undone — this only resets
      // our bookkeeping.
      acc.aging = {
        stage: "new",
        nextEligibleAt: new Date(),
        taste: [],
        sessions: 0,
        watchMinutes: 0,
        follows: 0,
        strikes: 0,
        lastError: "",
      };
    }
    await acc.save();
    await StashAgingLog.create({
      accountId: acc._id,
      setId: acc.setId,
      username: acc.username,
      kind: "note",
      fromStage: from,
      toStage: acc.aging.stage,
      message: "Operator " + action + " (" + from + " → " + acc.aging.stage + ")",
    });
    res.json({ success: true, aging: publicAging(acc) });
  } catch (err) {
    console.error("stash aging action error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Project the schedule forward without waiting for it. Pure arithmetic on the
// policy — no Twitch requests, nothing written — so you can see the shape of a
// 14-day plan in a second rather than in 14 days. This is the answer to "what
// will this actually do", which dry-run mode alone can't give you because
// dry-run still runs on the real clock.
router.get("/account-stash/sets/:id/aging/preview", requireSuperadmin, async (req, res) => {
  try {
    const set = await StashSet.findById(req.params.id).lean();
    if (!set) return res.status(404).json({ success: false, message: "Not found" });
    const policy = stashAging.policyOf(set);

    const avgGapMs = (7 * 86400000) / Math.max(1, policy.sessionsPerWeek);
    const avgSession = (policy.minSessionMinutes + policy.maxSessionMinutes) / 2;

    // How long until the three gates all pass, starting from a fresh account.
    const daysForSessions =
      policy.settleDays + (policy.minSessions * avgGapMs) / 86400000;
    const sessionsForMinutes = Math.ceil(policy.minWatchMinutes / Math.max(1, avgSession));
    const daysForMinutes =
      policy.settleDays + (sessionsForMinutes * avgGapMs) / 86400000;
    const projectedDays = Math.ceil(
      Math.max(policy.minDays, daysForSessions, daysForMinutes),
    );

    // Which gate is the one actually holding graduation up — the useful thing
    // to know when a set is ageing slower than expected.
    let binding = "calendar age";
    if (daysForSessions >= projectedDays) binding = "session count";
    if (daysForMinutes >= projectedDays) binding = "watch minutes";

    const timeline = [];
    timeline.push({ day: 0, label: "Lands in the set, token verified" });
    timeline.push({
      day: policy.settleDays,
      label: "Settle window ends — first warm-up session",
    });
    timeline.push({
      day: Math.round(policy.settleDays + (stashAging.WARMUP_SESSIONS * avgGapMs) / 86400000),
      label:
        "Warm-up complete (" +
        stashAging.WARMUP_SESSIONS +
        " short sessions) — full-length sessions and follows begin",
    });
    timeline.push({
      day: projectedDays,
      label:
        "Matures — " +
        policy.minSessions +
        "+ sessions, " +
        policy.minWatchMinutes +
        "+ minutes, " +
        policy.minDays +
        "+ days old",
    });
    if (policy.autoGraduate) {
      timeline.push({ day: projectedDays, label: "Auto-moved into the Account Pool" });
    } else {
      timeline.push({ day: projectedDays, label: "Waits for you to move it to the pool" });
    }

    res.json({
      success: true,
      policy,
      projection: {
        projectedDays,
        binding,
        avgGapHours: Math.round(avgGapMs / 3600000),
        avgSessionMinutes: Math.round(avgSession),
        projectedSessions: Math.max(policy.minSessions, sessionsForMinutes),
        projectedMinutes: Math.round(
          Math.max(policy.minSessions, sessionsForMinutes) * avgSession,
        ),
        projectedFollows: policy.followTarget,
      },
      timeline,
    });
  } catch (err) {
    console.error("stash aging preview error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// --------------------------------------------------------- move to pool

// Hand a whole set (or a selected subset) to the Account Pool, then remove the
// moved accounts from the stash. Uses the pool's own merge-by-username /
// skip-if-in-use safety so nothing duplicates a pool row or re-adds an account
// already deployed in a live bot. Accounts skipped as "already in use" are
// still removed from the stash (they're accounted for elsewhere); accounts that
// merged or inserted are removed too. Any account that couldn't be placed stays
// in the stash so nothing is silently lost.
router.post("/account-stash/sets/:id/move-to-pool", requireSuperadmin, async (req, res) => {
  try {
    const set = await StashSet.findById(req.params.id);
    if (!set) return res.status(404).json({ success: false, message: "Not found" });

    // Optional selection of specific account ids; absent/empty means the whole set.
    let ids = req.body && Array.isArray(req.body.ids) ? req.body.ids : null;
    const filter = { setId: set._id };
    if (ids && ids.length) {
      const valid = ids.filter((x) => mongoose.Types.ObjectId.isValid(x));
      filter._id = { $in: valid };
    }
    const stashAccounts = await StashAccount.find(filter);
    if (!stashAccounts.length) {
      return res.json({ success: true, added: 0, merged: 0, alreadyInUse: [], removedFromStash: 0 });
    }

    // Informational only. Moving by hand is never blocked by the aging system —
    // the operator asked for these accounts, and the manual button predates
    // aging entirely. We just report how many hadn't finished their ladder so
    // the page can say so before it happens.
    const policy = stashAging.policyOf(set);
    const notMatured = set.aging?.enabled
      ? stashAccounts.filter(
          (a) => a.aging?.stage !== "mature" && !stashAging.isMature(a, policy),
        ).length
      : 0;

    const result = await promoteAccounts(set, stashAccounts);
    res.json({ success: true, ...result, notMatured });
  } catch (err) {
    console.error("stash move-to-pool error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ---------------------------------------------------- move between sets

// Re-parent accounts from one stash set into another — e.g. peel a batch off the
// automator's landing set ("browser-automator") into a set you want to age on
// its own. Pure bookkeeping inside the stash: nothing enters the Account Pool,
// no bot/scanner code is involved, and createdAt is left alone so an account's
// stash age survives the move.
//
// The {setId, usernameLower} unique index means the destination may already hold
// a row for the same username. That isn't an error, and utils/stashMovePlan.js
// decides which of the two ways it goes: a twin that's merely emptier gets the
// source row's fields copied in (never clobbering, same rule as import) and the
// redundant source row is dropped, whereas a twin holding DIFFERENT credentials
// is left strictly alone and reported, because a login is not a unique identity
// and deleting the source could destroy the only copy of a password or token.
//
// Deleting is the one irreversible step, so it happens in a second pass, only for
// rows whose data is visibly present on the destination (see phase 2 below).
//
// Moving during a scan is safe — utils/stashChecker.js walks accounts by _id, so
// a row that changed sets still gets its result written.
router.post("/account-stash/sets/:id/move-to-set", requireSuperadmin, async (req, res) => {
  try {
    const src = await StashSet.findById(req.params.id);
    if (!src) return res.status(404).json({ success: false, message: "Not found" });

    const body = req.body || {};

    // Destination is either an existing set id, or a name to create/reuse so the
    // operator can split a batch off without leaving the page first.
    let target = null;
    if (body.targetSetId) {
      if (!mongoose.Types.ObjectId.isValid(String(body.targetSetId))) {
        return res.status(400).json({ success: false, message: "Invalid destination set" });
      }
      target = await StashSet.findById(body.targetSetId);
      if (!target) return res.status(404).json({ success: false, message: "Destination set not found" });
    } else if (String(body.targetSetName || "").trim()) {
      const name = String(body.targetSetName).trim();
      const nameLower = name.toLowerCase();
      target = await StashSet.findOne({ nameLower });
      if (!target) {
        try {
          target = await StashSet.create({ name, nameLower, note: "" });
        } catch (err) {
          // Race with a concurrent create of the same name — re-fetch.
          if (err && err.code === 11000) target = await StashSet.findOne({ nameLower });
          else throw err;
        }
      }
    }
    if (!target) return res.status(400).json({ success: false, message: "Pick a destination set" });
    if (String(target._id) === String(src._id)) {
      return res.status(400).json({ success: false, message: "That's the set they're already in" });
    }

    // A missing/absent `ids` means the whole set. An `ids` array that survives
    // validation empty means "nothing selected" — we do NOT fall back to moving
    // the whole set, since that's the one mistake nobody could undo by hand.
    const filter = { setId: src._id };
    if (Array.isArray(body.ids)) {
      const valid = body.ids.filter((x) => mongoose.Types.ObjectId.isValid(String(x)));
      if (!valid.length) {
        return res.status(400).json({ success: false, message: "No valid accounts selected" });
      }
      filter._id = { $in: valid };
    }

    const sourceAccounts = await StashAccount.find(filter);
    if (!sourceAccounts.length) {
      return res.json({
        success: true,
        moved: 0,
        merged: 0,
        conflicts: [],
        conflictCount: 0,
        stayed: 0,
        partial: false,
        targetSetId: target._id,
        targetSetName: target.name,
      });
    }

    const lowers = sourceAccounts.map((a) => a.usernameLower || a.username.toLowerCase());
    const clashes = await StashAccount.find({ setId: target._id, usernameLower: { $in: lowers } });

    // Decryption happens here, not in the planner: stored passwords/emails use a
    // random IV, so the same secret encrypts to two different strings and only
    // the plaintext can tell "same credential" from "different credential".
    const withPlain = (r) => ({
      _id: r._id,
      username: r.username,
      usernameLower: r.usernameLower,
      clientSecret: r.clientSecret,
      uniqueId: r.uniqueId,
      twitchId: r.twitchId,
      password: r.password,
      hasPassword: r.hasPassword,
      passwordPlain: decrypt(r.password),
      email: r.email,
      emailPlain: decrypt(r.email),
      lastCheckAt: r.lastCheckAt,
      lastCheckStatus: r.lastCheckStatus,
      lastCheckError: r.lastCheckError,
      dropCount: r.dropCount,
    });

    const plan = planStashMove({
      accounts: sourceAccounts.map(withPlain),
      existing: clashes.map(withPlain),
      targetSetId: target._id,
    });

    const runBatched = async (ops) => {
      let partial = false;
      for (let i = 0; i < ops.length; i += 500) {
        try {
          await StashAccount.bulkWrite(ops.slice(i, i + 500), { ordered: false });
        } catch (err) {
          // A concurrent ingest can insert the same username into the destination
          // between our read above and this write. Only that row is refused; it
          // stays where it is rather than failing the whole move.
          const dupKey = err && (err.code === 11000 || (err.writeErrors || []).length);
          if (!dupKey) throw err;
          partial = true;
        }
      }
      return partial;
    };

    // Phase 1 — copy the source rows' fields onto the destination rows, and
    // re-parent everything that had no clash. Nothing is deleted yet.
    const fillOps = [];
    for (const m of plan.merges) {
      if (Object.keys(m.set).length) {
        fillOps.push({ updateOne: { filter: { _id: m.destId }, update: { $set: m.set } } });
      }
    }
    for (const r of plan.reparent) {
      fillOps.push({ updateOne: { filter: { _id: r.id }, update: { $set: r.set } } });
    }
    const partial = await runBatched(fillOps);

    // Phase 2 — only now drop the redundant source rows, and only the ones whose
    // data we can actually SEE on the destination row. Deleting is the one
    // irreversible step here, so it never runs on the assumption that phase 1
    // worked: a fill that didn't land leaves its source row alive and untouched.
    const applied = (docVal, wantVal) => {
      if (wantVal instanceof Date) {
        return !!docVal && new Date(docVal).getTime() === wantVal.getTime();
      }
      return String(docVal == null ? "" : docVal) === String(wantVal == null ? "" : wantVal);
    };
    const destNow = new Map(
      (await StashAccount.find({ _id: { $in: plan.merges.map((m) => m.destId) } }).lean()).map(
        (d) => [String(d._id), d],
      ),
    );
    const deletableSourceIds = plan.merges
      .filter((m) => {
        const dest = destNow.get(String(m.destId));
        if (!dest) return false; // destination row vanished — keep the source row
        return Object.entries(m.set).every(([k, v]) => applied(dest[k], v));
      })
      .map((m) => m.sourceId);
    if (deletableSourceIds.length) {
      await StashAccount.deleteMany({ _id: { $in: deletableSourceIds } });
    }

    // Report what actually landed rather than what we intended, so a partial
    // write can never be announced as a clean move.
    const moveIds = plan.reparent.map((r) => r.id);
    const moved = moveIds.length
      ? await StashAccount.countDocuments({ _id: { $in: moveIds }, setId: target._id })
      : 0;
    const mergedLeftBehind = deletableSourceIds.length
      ? await StashAccount.countDocuments({ _id: { $in: deletableSourceIds } })
      : 0;
    const merged = deletableSourceIds.length - mergedLeftBehind;

    res.json({
      success: true,
      moved,
      merged,
      // Same username, different credentials: both rows were left exactly as they
      // were, and the operator is told which ones so they can look at them.
      conflicts: plan.conflicts.map((c) => ({ username: c.username, fields: c.fields })),
      conflictCount: plan.conflicts.length,
      stayed: sourceAccounts.length - moved - merged - plan.conflicts.length,
      partial,
      targetSetId: target._id,
      targetSetName: target.name,
    });
  } catch (err) {
    console.error("stash move-to-set error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// -------------------------------------------------------- single account

router.get("/account-stash/:id/password", requireSuperadmin, async (req, res) => {
  try {
    const acc = await StashAccount.findById(req.params.id).lean();
    if (!acc) return res.status(404).json({ success: false, message: "Not found" });
    res.json({
      success: true,
      password: decrypt(acc.password),
      email: decrypt(acc.email),
      clientSecret: acc.clientSecret || "",
      uniqueId: acc.uniqueId || "",
      twitchId: acc.twitchId || "",
    });
  } catch (err) {
    console.error("stash reveal error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.delete("/account-stash/:id", requireSuperadmin, async (req, res) => {
  try {
    const acc = await StashAccount.findByIdAndDelete(req.params.id).lean();
    if (!acc) return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true });
  } catch (err) {
    console.error("stash account delete error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ---------------------------------------------------------------- ingest
//
// Machine-to-machine ingest endpoint for the browser account automator
// (Documents/drive-code/ane.js on the operator's Mac). Bearer-authenticated
// so it bypasses session/2FA. Runs entirely under the same server-side
// safety as the UI paste-import: same encryption, same merge-by-username
// semantics, same StashSet isolation. Auto-creates a default landing set
// on first use so the automator never needs to know set IDs.
//
// Two record types keyed by body.type:
//   "account" — from ane.js signup save: fills username/password/email.
//   "token"   — from ane.js token mint:  fills clientSecret/uniqueId/twitchId
//               on the existing StashAccount (matched by usernameLower).
//
// Merge semantics: fill missing fields only; never clobber. Matches the
// UI paste-import so replays don't destroy work in progress.
//
// Auth: env STASH_INGEST_TOKEN (raw string). Timing-safe SHA-256 compare
// so token length + comparison time never leak. Unset env => 503 so the
// endpoint fails closed on misconfiguration.
const STASH_INGEST_TOKEN = process.env.STASH_INGEST_TOKEN || "";
const DEFAULT_INGEST_SET_NAME = "browser-automator";

function requireIngestBearer(req, res, next) {
  if (!STASH_INGEST_TOKEN) {
    return res
      .status(503)
      .json({ success: false, message: "Ingest disabled: STASH_INGEST_TOKEN not set" });
  }
  const hdr = String(req.get("Authorization") || "");
  const m = /^Bearer\s+(\S+)$/i.exec(hdr);
  if (!m) return res.status(401).json({ success: false, message: "Missing bearer" });
  const provided = crypto.createHash("sha256").update(m[1]).digest();
  const expected = crypto.createHash("sha256").update(STASH_INGEST_TOKEN).digest();
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return res.status(401).json({ success: false, message: "Bad bearer" });
  }
  next();
}

async function findOrCreateIngestSet(name) {
  const raw = String(name || DEFAULT_INGEST_SET_NAME).trim() || DEFAULT_INGEST_SET_NAME;
  const nameLower = raw.toLowerCase();
  let set = await StashSet.findOne({ nameLower });
  if (set) return set;
  try {
    return await StashSet.create({
      name: raw,
      nameLower,
      note: "auto-created by /account-stash/ingest",
    });
  } catch (err) {
    // Race: another concurrent request created the same set — re-fetch.
    if (err && err.code === 11000) return StashSet.findOne({ nameLower });
    throw err;
  }
}

router.post("/account-stash/ingest", requireIngestBearer, async (req, res) => {
  try {
    const body = req.body || {};
    const type = String(body.type || "").toLowerCase();
    if (type !== "account" && type !== "token") {
      return res
        .status(400)
        .json({ success: false, message: "type must be 'account' or 'token'" });
    }
    const record = body.record;
    if (!record || typeof record !== "object") {
      return res.status(400).json({ success: false, message: "record missing" });
    }
    const set = await findOrCreateIngestSet(body.setName);

    if (type === "account") {
      const username = String(record.username || record.Login || "").trim();
      if (!username) {
        return res
          .status(400)
          .json({ success: false, message: "record.username required" });
      }
      const usernameLower = username.toLowerCase();
      const password = record.password != null ? String(record.password) : "";
      const email = record.email != null ? String(record.email).trim() : "";
      const source = String(record.source || "browser-automator");

      const existing = await StashAccount.findOne({ setId: set._id, usernameLower });
      if (existing) {
        const set$ = {};
        if (password && !existing.hasPassword) {
          set$.password = encrypt(password);
          set$.hasPassword = true;
        }
        if (email && !decrypt(existing.email)) set$.email = encrypt(email);
        if (Object.keys(set$).length) {
          await StashAccount.updateOne({ _id: existing._id }, { $set: set$ });
        }
        return res.json({
          success: true,
          action: "account-merged",
          setId: set._id,
          setName: set.name,
          accountId: existing._id,
        });
      }
      const created = await StashAccount.create({
        setId: set._id,
        username,
        usernameLower,
        password: password ? encrypt(password) : "",
        hasPassword: !!password,
        email: email ? encrypt(email) : "",
        clientSecret: "",
        uniqueId: "",
        twitchId: "",
        source,
      });
      return res.json({
        success: true,
        action: "account-created",
        setId: set._id,
        setName: set.name,
        accountId: created._id,
      });
    }

    // type === "token" — fill clientSecret/twitchId/uniqueId onto an existing row
    // matched by usernameLower (or create a shell row if the token arrived without
    // a prior signup save; source is tagged so the operator can spot the anomaly).
    const login = String(record.Login || record.username || "").trim();
    if (!login) {
      return res
        .status(400)
        .json({ success: false, message: "record.Login required" });
    }
    const usernameLower = login.toLowerCase();
    const clientSecret = String(record.ClientSecret || record.clientSecret || "").trim();
    if (!clientSecret) {
      return res
        .status(400)
        .json({ success: false, message: "record.ClientSecret required" });
    }
    const uniqueId = String(record.UniqueId || record.uniqueId || "").trim();
    const twitchId = String(record.Id || record.twitchId || "").trim();

    const existing = await StashAccount.findOne({ setId: set._id, usernameLower });
    if (existing) {
      const set$ = {};
      if (clientSecret && !existing.clientSecret) set$.clientSecret = clientSecret;
      if (uniqueId && !existing.uniqueId) set$.uniqueId = uniqueId;
      if (twitchId && !existing.twitchId) set$.twitchId = twitchId;
      if (Object.keys(set$).length) {
        await StashAccount.updateOne({ _id: existing._id }, { $set: set$ });
      }
      return res.json({
        success: true,
        action: "token-merged",
        setId: set._id,
        setName: set.name,
        accountId: existing._id,
      });
    }
    const created = await StashAccount.create({
      setId: set._id,
      username: login,
      usernameLower,
      password: "",
      hasPassword: false,
      email: "",
      clientSecret,
      uniqueId,
      twitchId,
      source: "browser-automator (token-first)",
    });
    return res.json({
      success: true,
      action: "token-only-created",
      setId: set._id,
      setName: set.name,
      accountId: created._id,
    });
  } catch (err) {
    console.error("stash ingest error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
