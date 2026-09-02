const mongoose = require("mongoose");

// A saved coworker conversation. Stored server-side (not the browser) so a chat
// survives closing the tab, is reachable from any device, and — crucially — an
// investigation runs as a background job that writes its result HERE, so the
// answer is waiting when you come back. Each assistant turn carries its own
// status/trace so the client can poll a running turn to completion.
const messageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ["user", "assistant"], required: true },
    content: { type: String, default: "" },
    mode: { type: String, default: "analyst" }, // assistant turns: analyst | chat
    trace: { type: [String], default: [] }, // tool names as they run
    status: { type: String, enum: ["running", "done", "error"], default: "done" },
    error: { type: String, default: "" },
    at: { type: Date, default: Date.now },
    beatAt: { type: Date, default: Date.now }, // last progress write (stall detect)
  },
  { _id: false },
);

const coworkerChatSchema = new mongoose.Schema({
  actor: { type: String, default: "", index: true }, // admin:<id> owner
  title: { type: String, default: "New chat" },
  messages: { type: [messageSchema], default: [] },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now, index: true },
});

// Keep ~400 days (this {updatedAt:1} index doubles as ascending for sorting).
coworkerChatSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 400 * 24 * 60 * 60 });

module.exports = mongoose.model("CoworkerChat", coworkerChatSchema);
