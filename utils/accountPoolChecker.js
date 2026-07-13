// Auto-verifies newly-imported account-pool entries against Twitch instead of
// requiring a manual "Check" click per row — same fetchInventory call and
// lastCheckAt/lastCheckStatus bookkeeping the manual button uses (see
// routes/accountPoolRoutes.js's /:id/check), just queued and drained one at a
// time in the background so importing hundreds of accounts at once doesn't
// fire that many concurrent requests at Twitch.
const AvailableAccount = require("../models/AvailableAccount");
const { fetchInventory } = require("./twitchInventory");

const CHECK_DELAY_MS = Number(process.env.ACCOUNT_POOL_CHECK_DELAY_MS) || 1200;

const queue = [];
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
      }
      state.checked++;
      if (queue.length) await new Promise((r) => setTimeout(r, CHECK_DELAY_MS));
    }
  } finally {
    state.running = false;
    draining = false;
  }
}

// Queues account ids for a background auth check. Starting a fresh batch
// (queue was empty and idle) resets the progress counters so the UI's
// "checked/total" reads as this batch's progress, not a lifetime tally.
function enqueue(ids) {
  const fresh = (ids || []).filter(Boolean).map(String);
  if (!fresh.length) return;
  if (!queue.length && !draining) {
    state.checked = 0;
    state.total = 0;
  }
  queue.push(...fresh);
  state.total += fresh.length;
  drain().catch(() => {});
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
