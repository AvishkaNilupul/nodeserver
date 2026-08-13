// Hand stashed accounts to the Account Pool.
//
// Lifted verbatim out of the POST /account-stash/sets/:id/move-to-pool route so
// that the aging runner's auto-graduate path and the operator's manual button
// go through exactly the same code. That shared path is the point: the promote
// step is where a stashed account stops being isolated and becomes something a
// bot can pick up, so there must not be two versions of its safety rules.
//
// The rules, unchanged from the original route:
//   - merge by username into an existing pool row, filling only blanks; never
//     clobber a value the pool already has
//   - skip anything already deployed in a live bot (BotAccount.login), but
//     still clear it out of the stash, because it's accounted for elsewhere
//   - only remove from the stash what was actually placed; anything that
//     couldn't be placed stays put rather than being silently lost
const mongoose = require("mongoose");

const StashAccount = require("../models/StashAccount");
const AvailableAccount = require("../models/AvailableAccount");
const BotAccount = require("../models/BotAccount");
const accountPoolChecker = require("./accountPoolChecker");
const { encrypt, decrypt } = require("./secretBox");

// Merge a list of normalized items into a Map keyed by lowercase username,
// filling missing fields rather than clobbering.
function mergeNormalized(list) {
  const FIELDS = ["clientSecret", "uniqueId", "twitchId", "password", "email"];
  const byLower = new Map();
  for (const item of list) {
    if (!item || !item.username) continue;
    const lower = String(item.username).toLowerCase();
    const cur =
      byLower.get(lower) ||
      { username: item.username, clientSecret: "", uniqueId: "", twitchId: "", password: "", email: "" };
    for (const k of FIELDS) {
      if (item[k] && !cur[k]) cur[k] = item[k];
    }
    byLower.set(lower, cur);
  }
  return Array.from(byLower.values());
}

// Promote a concrete list of StashAccount documents into the pool.
//
// `set` is only used for the provenance string written onto new pool rows, so
// callers holding a lean set object are fine.
//
// Returns { added, merged, alreadyInUse, alreadyInUseCount, autoChecking,
// removedFromStash } — the exact shape the route has always returned, because
// the page reads those field names.
async function promoteAccounts(set, stashAccounts) {
  if (!stashAccounts || !stashAccounts.length) {
    return {
      added: 0,
      merged: 0,
      alreadyInUse: [],
      alreadyInUseCount: 0,
      autoChecking: 0,
      removedFromStash: 0,
      promotedIds: [],
    };
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
    inUseAccounts
      .filter((a) => String(a.login || "").trim())
      .map((a) => String(a.login).trim().toLowerCase()),
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
          source: "stash:" + (set && set.name ? set.name : "unknown"),
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
  const promoted = stashAccounts.filter((a) =>
    placedLowers.has(a.username.toLowerCase()),
  );
  const removeIds = promoted.map((a) => a._id);
  let removedFromStash = 0;
  if (removeIds.length) {
    const del = await StashAccount.deleteMany({ _id: { $in: removeIds } });
    removedFromStash = del.deletedCount || 0;
  }

  return {
    added,
    merged,
    alreadyInUse,
    alreadyInUseCount: alreadyInUse.length,
    autoChecking,
    removedFromStash,
    promotedIds: removeIds,
  };
}

module.exports = { promoteAccounts, mergeNormalized };
