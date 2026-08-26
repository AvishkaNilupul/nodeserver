const AutoFarmEvent = require("../models/AutoFarmEvent");
const { logEvent } = require("./systemLog");

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
  // Mirror into the unified audit log so one query spans every subsystem.
  // Fire-and-forget: logEvent is best-effort and never throws (utils/systemLog.js).
  logEvent({
    category: "autofarm",
    action: fields.type,
    actor: fields.actor || "tick",
    game: fields.game || "",
    host: fields.host || "",
    container: fields.container || "",
    count: fields.count || 0,
    detail: fields.reason || "",
    meta: fields.campaignId ? { campaignId: fields.campaignId } : undefined,
  });
}

module.exports = { recordAutoFarmEvent };
