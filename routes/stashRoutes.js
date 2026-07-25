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

const { requireSuperadmin } = require("../middleware/auth");
const StashSet = require("../models/StashSet");
const StashAccount = require("../models/StashAccount");
const AvailableAccount = require("../models/AvailableAccount");
const BotAccount = require("../models/BotAccount");
const accountPoolChecker = require("../utils/accountPoolChecker");
const stashChecker = require("../utils/stashChecker");
const { parseAccountList } = require("../utils/parseAccountList");
const { encrypt, decrypt } = require("../utils/secretBox");

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
  };
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
      },
    },
  ]);
  const c = counts[0] || { total: 0, live: 0, dead: 0, unchecked: 0 };
  return {
    id: set._id,
    name: set.name,
    note: set.note || "",
    total: c.total,
    live: c.live,
    dead: c.dead,
    unchecked: c.unchecked,
    scanning: stashChecker.isScanning(set._id),
    createdAt: set.createdAt,
    updatedAt: set.updatedAt,
  };
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
    res.json({
      success: true,
      set: await setWithCounts(set),
      accounts: accounts.map(publicAccount),
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

    // Decrypt back to plaintext and normalize/merge exactly like an import.
    const normalized = mergeNormalized(
      stashAccounts.map((a) => ({
        username: a.username,
        clientSecret: a.clientSecret,
        uniqueId: a.uniqueId,
        twitchId: a.twitchId,
        password: a.hasPassword ? decrypt(a.password) : "",
        email: a.email ? decrypt(a.email) : "",
      })),
    );

    const inUseAccounts = await BotAccount.find({}, { login: 1 }).lean();
    const inUseSet = new Set(
      inUseAccounts.filter((a) => String(a.login || "").trim()).map((a) => String(a.login).trim().toLowerCase()),
    );

    const lowers = normalized.map((n) => n.username.toLowerCase());
    const existing = await AvailableAccount.find({ usernameLower: { $in: lowers } });
    const existingByLower = new Map(existing.map((e) => [e.usernameLower, e]));

    let added = 0;
    let merged = 0;
    const alreadyInUse = [];
    const placedLowers = new Set();
    const ops = [];
    const toAutoCheck = [];

    for (const item of normalized) {
      const lower = item.username.toLowerCase();
      if (inUseSet.has(lower)) {
        alreadyInUse.push(item.username);
        placedLowers.add(lower); // accounted for elsewhere -> ok to leave the stash
        continue;
      }
      const found = existingByLower.get(lower);
      if (found) {
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
          if (set$.clientSecret) toAutoCheck.push(found._id);
        }
        placedLowers.add(lower); // row already in the pool -> ok to leave the stash
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
            source: "stash:" + set.name,
          },
        },
      });
      added++;
      placedLowers.add(lower);
      if (item.clientSecret) toAutoCheck.push(newId);
    }

    if (ops.length) await AvailableAccount.bulkWrite(ops, { ordered: false });
    const autoChecking = toAutoCheck.length ? accountPoolChecker.enqueue(toAutoCheck) : 0;

    // Remove from the stash only the accounts we actually placed in the pool.
    const removeIds = stashAccounts
      .filter((a) => placedLowers.has(a.username.toLowerCase()))
      .map((a) => a._id);
    let removedFromStash = 0;
    if (removeIds.length) {
      const del = await StashAccount.deleteMany({ _id: { $in: removeIds } });
      removedFromStash = del.deletedCount || 0;
    }

    res.json({
      success: true,
      added,
      merged,
      alreadyInUse,
      alreadyInUseCount: alreadyInUse.length,
      autoChecking,
      removedFromStash,
    });
  } catch (err) {
    console.error("stash move-to-pool error:", err.message);
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

module.exports = router;
