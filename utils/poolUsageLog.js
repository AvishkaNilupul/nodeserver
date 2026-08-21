const AvailableAccount = require("../models/AvailableAccount");

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
  await AvailableAccount.updateMany(
    { _id: { $in: ids } },
    { $push: { usageHistory: { $each: [doc], $slice: -50 } } },
  ).catch((e) => console.error("recordPoolUsage failed:", e.message));
}

module.exports = { recordPoolUsage };
