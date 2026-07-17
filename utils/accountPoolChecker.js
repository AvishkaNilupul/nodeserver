// Auto-verifies newly-imported account-pool entries against Twitch instead of
// requiring a manual "Check" click per row — same fetchInventory call and
// lastCheckAt/lastCheckStatus bookkeeping the manual button uses (see
// routes/accountPoolRoutes.js's /:id/check), just queued and drained one at a
// time in the background so importing hundreds of accounts at once doesn't
// fire that many concurrent requests at Twitch.
const AvailableAccount = require("../models/AvailableAccount");
const dropScanner = require("./dropScanner");
const { fetchInventory } = require("./twitchInventory");

const CHECK_DELAY_MS = Number(process.env.ACCOUNT_POOL_CHECK_DELAY_MS) || 1200;

const queue = [];
// Ids queued or currently in flight. Without this an id can be queued twice —
// kicking off a sweep while one is already draining would re-check every
// account and fire double the requests at Twitch. An id is only released once
// its check finishes, so the one being checked right now can't be re-queued
// underneath the drain either.
const queued = new Set();
const state = { running: false, checked: 0, total: 0 };
let draining = false;

async function checkOne(id) {
  const acc = await AvailableAccount.findById(id);
  if (!acc || !acc.clientSecret) return;
  const now = new Date();
  try {
    const { twitchId, drops } = await fetchInventory(acc.clientSecret);
    if (twitchId) acc.twitchId = twitchId;
    acc.dropCount = drops.length;
    acc.lastCheckAt = now;
    acc.lastCheckStatus = "ok";
    acc.lastCheckError = "";
    // Best-effort — a drops-archive write hiccup shouldn't fail the check
    // itself (the account is still verified either way).
    await dropScanner
      .upsertDrops(acc._id, "AvailableAccount", acc.username, drops)
      .catch((e) =>
        console.error(
          "accountPoolChecker: drop-archive upsert failed for",
          id,
          e.message,
        ),
      );
  } catch (e) {
    acc.lastCheckAt = now;
    acc.lastCheckStatus =
      e.code === "token_invalid" ? "token_invalid" : "error";
    acc.lastCheckError = (e.message || String(e)).slice(0, 300);
  }
  await acc.save();
}

async function drain() {
  if (draining) return;
  draining = true;
  state.running = true;
  try {
    while (queue.length) {
      const id = queue.shift();
      try {
        await checkOne(id);
      } catch (err) {
        console.error("accountPoolChecker: check failed for", id, err.message);
      } finally {
        queued.delete(id);
      }
      state.checked++;
      if (queue.length) await new Promise((r) => setTimeout(r, CHECK_DELAY_MS));
    }
  } finally {
    state.running = false;
    draining = false;
  }
}

// Queues account ids for a background auth check, skipping any already queued
// or in flight (deduped within the batch too, not just against the queue).
// Starting a fresh batch (queue was empty and idle) resets the progress
// counters so the UI's "checked/total" reads as this batch's progress, not a
// lifetime tally. Returns how many were actually queued, so callers can report
// the real number rather than what they asked for.
function enqueue(ids) {
  const fresh = [];
  for (const raw of ids || []) {
    if (!raw) continue;
    const id = String(raw);
    if (queued.has(id)) continue;
    queued.add(id);
    fresh.push(id);
  }
  if (!fresh.length) return 0;
  if (!queue.length && !draining) {
    state.checked = 0;
    state.total = 0;
  }
  queue.push(...fresh);
  state.total += fresh.length;
  drain().catch(() => {});
  return fresh.length;
}

function status() {
  return {
    running: state.running,
    queued: queue.length,
    checked: state.checked,
    total: state.total,
  };
}

module.exports = { enqueue, status };
