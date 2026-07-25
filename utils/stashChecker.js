// Simple, server-only live-check sweep for a stash set. Deliberately much
// smaller than utils/accountPoolChecker.js: no remote-host fanout and, above
// all, NO write to the Drops Archive — a stash scan must stay fully isolated
// from the rest of the app (that's the whole reason the stash exists). All it
// does is ask Twitch, one account at a time at a gentle pace, "does this token
// still authenticate, and how many drops does it see", and record the answer
// on the StashAccount row.
//
// One sweep runs at a time per process. Progress is tracked per set so the page
// can show "checked N of M" for the set you're looking at.
const StashAccount = require("../models/StashAccount");
const { fetchInventory, fetchDropCampaigns } = require("./twitchInventory");

const CHECK_DELAY_MS = Number(process.env.STASH_CHECK_DELAY_MS) || 1200;

// setId -> { running, checked, total, live, dead, startedAt }
const progress = new Map();
// Guards against two overlapping sweeps of the same set.
const running = new Set();

function statusFor(setId) {
  const key = String(setId);
  const p = progress.get(key);
  if (!p) {
    return { running: false, checked: 0, total: 0, live: 0, dead: 0 };
  }
  return {
    running: !!p.running,
    checked: p.checked,
    total: p.total,
    live: p.live,
    dead: p.dead,
  };
}

function isScanning(setId) {
  return running.has(String(setId));
}

// Same integrity-gate logic the pool checker uses: Inventory passing only
// proves the token authenticates; a supplier token that never went through
// device-auth clears Inventory but fails the drops query a bot actually runs.
// Only a genuine integrity rejection downgrades the account — a transient error
// is treated as "still ok" and left for the next sweep.
async function checkIntegrity(token) {
  try {
    await fetchDropCampaigns(token);
    return { ok: true, message: "" };
  } catch (e) {
    if (e.code === "integrity_failed") {
      return { ok: false, message: (e.message || String(e)).slice(0, 300) };
    }
    return { ok: true, message: "" };
  }
}

async function checkOne(acc) {
  const now = new Date();
  if (!acc.clientSecret) {
    // Nothing to verify yet — record that we looked so the UI can distinguish
    // "no token" from "never scanned".
    acc.lastCheckAt = now;
    acc.lastCheckStatus = "token_invalid";
    acc.lastCheckError = "No auth token stored for this account";
    await acc.save();
    return false;
  }
  try {
    const inv = await fetchInventory(acc.clientSecret);
    if (inv.twitchId) acc.twitchId = inv.twitchId;
    acc.dropCount = inv.drops.length;
    const integrity = await checkIntegrity(acc.clientSecret);
    acc.lastCheckAt = now;
    acc.lastCheckStatus = integrity.ok ? "ok" : "integrity_failed";
    acc.lastCheckError = integrity.ok ? "" : integrity.message;
    await acc.save();
    return integrity.ok;
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
    return false;
  }
}

// Kicks off a background sweep of one set. Returns immediately with how many
// accounts were queued; the page polls statusFor() to watch it drain. Calling
// it again while a set is mid-sweep is a no-op (returns already:true).
async function scanSet(setId) {
  const key = String(setId);
  if (running.has(key)) {
    return { started: false, already: true, ...statusFor(key) };
  }
  const accounts = await StashAccount.find({ setId }).select("_id");
  const ids = accounts.map((a) => a._id);
  running.add(key);
  progress.set(key, {
    running: true,
    checked: 0,
    total: ids.length,
    live: 0,
    dead: 0,
    startedAt: Date.now(),
  });

  (async () => {
    const p = progress.get(key);
    try {
      for (const id of ids) {
        const acc = await StashAccount.findById(id);
        if (!acc) {
          p.checked++;
          continue;
        }
        const ok = await checkOne(acc);
        p.checked++;
        if (ok) p.live++;
        else p.dead++;
        if (p.checked < p.total) {
          await new Promise((r) => setTimeout(r, CHECK_DELAY_MS));
        }
      }
    } catch (err) {
      console.error("stashChecker: sweep failed for set", key, err.message);
    } finally {
      p.running = false;
      running.delete(key);
    }
  })();

  return { started: true, already: false, total: ids.length };
}

module.exports = { scanSet, statusFor, isScanning };
