const AvailableAccount = require("../models/AvailableAccount");
const PoolUsageEvent = require("../models/PoolUsageEvent");
const { logEvent } = require("./systemLog");

// Pool events that put an account back into the available pool.
const RECHECK_EVENTS = new Set(["released", "returned", "recycled"]);

// Best-effort audit trail: never make the pool transition that this records
// fail just because the history write was unavailable.
async function recordPoolUsage(idOrIds, entry) {
  const ids = Array.isArray(idOrIds) ? idOrIds.filter(Boolean) : [idOrIds].filter(Boolean);
  if (!ids.length) return;
  const doc = {
    at: new Date(),
    event: "",
    game: "",
    campaignId: "",
    note: "",
    actor: "",
    host: "",
    ...entry,
  };
  // PoolUsageEvent.event is `required`, so an entry that arrives without one
  // would fail insertMany, get swallowed by the catch below, and land in the
  // per-account history but NOT in the watcher — the two trails would diverge
  // with nothing but a console line to show for it. Substituting a visible
  // placeholder keeps them consistent and makes the omission obvious in the UI
  // instead of silently dropping the event.
  if (!doc.event) doc.event = "unknown";
  // Resolve usernames once for the denormalized watcher feed. Do this before
  // the two independent best-effort writes so one failure cannot suppress the
  // other audit trail.
  let accounts = [];
  try {
    accounts = await AvailableAccount.find({ _id: { $in: ids } }, { username: 1 }).lean();
  } catch (e) {
    console.error("recordPoolUsage username lookup failed:", e.message);
  }

  await AvailableAccount.updateMany(
    { _id: { $in: ids } },
    { $push: { usageHistory: { $each: [doc], $slice: -50 } } },
  ).catch((e) => console.error("recordPoolUsage failed:", e.message));

  // Keep the capped per-account history for the existing modal, and also
  // append an uncapped event so the usage watcher remains useful long-term.
  try {
    const byId = new Map(accounts.map((account) => [String(account._id), account.username || ""]));
    await PoolUsageEvent.insertMany(
      ids.map((id) => ({
        accountId: id,
        username: byId.get(String(id)) || "",
        ...doc,
      })),
      { ordered: false },
    );
  } catch (e) {
    console.error("recordPoolUsage event log failed:", e.message);
  }

  // An account going BACK into the pool gets its Twitch inventory re-read right
  // away. Every release path (auto-farm, no-claim, renters, the Gameflip buffer,
  // the recyclers) logs through here, and an account that comes back holding
  // farmed-but-unclaimed drops must be held before a claiming bot can take it
  // and claim them (utils/poolStock.js). The checker's own "stock expired"
  // release is skipped — it has just looked. Only active inside the server
  // (enqueueIfStarted), so tests and scripts never trigger live Twitch reads.
  if (RECHECK_EVENTS.has(doc.event) && doc.actor !== "pool-check") {
    try {
      require("./accountPoolChecker").enqueueIfStarted(ids);
    } catch (e) {
      console.error("recordPoolUsage re-check enqueue failed:", e.message);
    }
  }

  // Mirror ONE summary row into the unified audit log (not one per account, to
  // keep the feed readable). Fire-and-forget, best-effort (utils/systemLog.js).
  logEvent({
    category: "pool",
    action: doc.event || "unknown",
    actor: doc.actor || "system",
    game: doc.game || "",
    host: doc.host || "",
    count: ids.length,
    detail: doc.note || "",
  });
}

module.exports = { recordPoolUsage };
