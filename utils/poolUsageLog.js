const AvailableAccount = require("../models/AvailableAccount");
const PoolUsageEvent = require("../models/PoolUsageEvent");

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
}

module.exports = { recordPoolUsage };
