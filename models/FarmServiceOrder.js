const mongoose = require("mongoose");

// One row per marketplace "Twitch Drops Automatic Farming" order (the rent-farm
// service, NOT the drops-bundle listings that hand over a farmed account).
// Shared by the Eldorado and PlayerAuctions fulfillers.
//
// This row is what makes automatic fulfilment safe to retry. Each order burns
// PRISTINE pool accounts, so a retry that re-provisions would quietly spend the
// pool twice. The row is claimed on a unique orderId BEFORE anything is
// provisioned, and each stage is stamped as it completes, so a tick that dies
// half-way resumes at the right step instead of starting over.
const farmServiceOrderSchema = new mongoose.Schema(
  {
    // The marketplace order. Unique — this is the idempotency key. Ids from
    // different marketplaces share this collection, so non-Eldorado ones are
    // namespaced by their fulfiller ("pa:16458589") to keep them from ever
    // colliding with an Eldorado UUID.
    orderId: { type: String, required: true, unique: true, index: true },
    market: { type: String, default: "eldorado", index: true },
    offerId: { type: String, default: "", index: true },
    offerTitle: { type: String, default: "" },
    buyerUsername: { type: String, default: "" },

    // Parsed from the offer title, which is where the contract with the buyer
    // lives: "<Game> Twitch Drops Automatic Farming <term>".
    game: { type: String, default: "", index: true },
    days: { type: Number, default: 0 },
    quantity: { type: Number, default: 1 },

    // The pool accounts handed to this buyer, and the window they farm for.
    accounts: {
      type: [
        {
          _id: false,
          login: { type: String, default: "" },
          poolId: { type: String, default: "" },
          farmUntil: { type: Date, default: null },
        },
      ],
      default: [],
    },

    // Stage stamps. Fulfilment is: claim -> provision -> send -> deliver.
    // Never mark delivered before the credential has actually reached the buyer.
    provisionedAt: { type: Date, default: null },
    messageSentAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },

    state: {
      type: String,
      // "cancelled" is the buyer walking away, and it is NOT the same as
      // "failed". A failed order is still owed and must keep alerting; a
      // cancelled one is closed and must stop, or the health check cries wolf
      // forever over an order nobody is waiting for. Eldorado order e69b19d3
      // (Black Desert, 1 Year) was the first: it failed 25 times on a full
      // rental stack and the buyer cancelled before the fix landed.
      enum: ["claimed", "provisioned", "sent", "delivered", "failed", "cancelled"],
      default: "claimed",
      index: true,
    },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: "" },
  },
  { timestamps: true },
);

module.exports = mongoose.model("FarmServiceOrder", farmServiceOrderSchema);
