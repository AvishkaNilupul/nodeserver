const AutoFarmEvent = require("../models/AutoFarmEvent");

// Lifecycle history is diagnostic only. Never make the farming action fail
// because Mongo is unavailable or the audit document is malformed.
async function recordAutoFarmEvent(fields = {}) {
  try {
    if (!fields.type) return;
    await AutoFarmEvent.create({
      at: new Date(),
      type: "",
      game: "",
      campaignId: "",
      host: "",
      container: "",
      count: 0,
      reason: "",
      actor: "",
      ...fields,
    });
  } catch (e) {
    console.error("recordAutoFarmEvent failed:", e.message);
  }
}

module.exports = { recordAutoFarmEvent };
