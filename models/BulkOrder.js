const mongoose = require("mongoose");

// A bulk sale: one buyer orders N drop-bundle accounts at once (e.g. 50). Each
// unit is one of our farmed accounts that holds the whole bundle (a DropSet) —
// the same stock the Shop sells one at a time. Reserving a unit reuses the
// Shop's atomic claim (BotAccount.soldAt), so a bulk order and a Shop purchase
// can never be handed the same account.
//
// The buyer never logs in: they open a secret tokenized link (accessToken) and
// see their whole set as an inventory, with a health check that verifies every
// account against Twitch and auto-replaces dead ones from the pool. Credentials
// are NOT copied here — they are decrypted on demand from the linked BotAccount,
// so they live in exactly one place (mirrors the Shop's Purchase model).

const bulkUnitSchema = new mongoose.Schema(
  {
    account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BotAccount",
      required: true,
    },
    accountLogin: { type: String, default: "" },
    // Per-item copies this account held at claim time (snapshot for display).
    itemCounts: {
      type: [
        {
          _id: false,
          itemKey: { type: String, default: "" },
          count: { type: Number, default: 1 },
        },
      ],
      default: [],
    },
    health: {
      status: {
        type: String,
        enum: [
          "unchecked",
          "alive",
          "token_dead",
          "integrity_failed",
          "missing_drops",
          "error",
        ],
        default: "unchecked",
      },
      dropCount: { type: Number, default: 0 },
      checkedAt: { type: Date, default: null },
      error: { type: String, default: "" },
    },
    // A bad unit that was swapped out stays on the order (active:false) for
    // audit; its replacement is appended as a new active unit.
    active: { type: Boolean, default: true },
    replacedByLogin: { type: String, default: "" },
    replacedFromLogin: { type: String, default: "" },
    replacedAt: { type: Date, default: null },
    // First time the buyer revealed this unit's credentials in the portal.
    revealedAt: { type: Date, default: null },
  },
  { _id: false },
);

const bulkOrderSchema = new mongoose.Schema(
  {
    // Human-friendly reference shown in the UI and the buyer portal.
    orderNo: { type: String, required: true, unique: true, index: true },
    // Secret that authenticates the no-login buyer link. Long + random so a
    // guessed order number is never enough to read someone's accounts.
    accessToken: { type: String, required: true, unique: true, index: true },

    // Snapshot of the sold bundle so the order still renders if the set changes.
    setId: { type: String, default: "", index: true },
    setName: { type: String, default: "" },
    items: {
      type: [
        {
          _id: false,
          itemKey: { type: String, default: "" },
          name: { type: String, default: "" },
          game: { type: String, default: "" },
          image: { type: String, default: "" },
          qty: { type: Number, default: 1 },
        },
      ],
      default: [],
    },

    qtyOrdered: { type: Number, default: 0 },
    // Informational only — bulk sales are paid off-site, no wallet is touched.
    price: { type: Number, default: 0 },
    buyerLabel: { type: String, default: "" },

    status: {
      type: String,
      enum: ["open", "closed"],
      default: "open",
      index: true,
    },
    // Optional warranty window surfaced to the buyer in the portal.
    guaranteeUntil: { type: Date, default: null },

    units: { type: [bulkUnitSchema], default: [] },

    // Denormalised counts over the ACTIVE units, refreshed on every health
    // check so lists render without recomputing.
    healthSummary: {
      total: { type: Number, default: 0 },
      alive: { type: Number, default: 0 },
      bad: { type: Number, default: 0 },
      unchecked: { type: Number, default: 0 },
      lastCheckedAt: { type: Date, default: null },
    },

    createdBy: { type: String, default: "" },
  },
  { timestamps: true },
);

module.exports = mongoose.model("BulkOrder", bulkOrderSchema);
