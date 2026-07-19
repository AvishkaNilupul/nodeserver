const mongoose = require("mongoose");

// A batch of Twitch accounts a renter submitted for the operator to approve.
// Nothing a renter submits touches a live bot config: the parsed accounts are
// held here (tokens encrypted at rest via utils/secretBox) until a superadmin
// approves the batch, at which point they are written into the renter's
// assigned config and this row keeps only the non-secret summary.
const renterSubmissionSchema = new mongoose.Schema(
  {
    renter: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Renter",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
      index: true,
    },
    // secretBox-encrypted JSON of the parsed TwitchUsers entries (ClientSecret
    // tokens included). Cleared once approved/rejected so tokens don't linger.
    accountsEnc: { type: String, default: "" },
    count: { type: Number, default: 0 },
    // Non-secret preview so the operator can review and the renter can see their
    // own history without ever re-exposing tokens.
    logins: { type: [String], default: [] },

    // Review outcome.
    reviewedBy: { type: String, default: "" },
    reviewedAt: { type: Date, default: null },
    rejectReason: { type: String, default: "" },
    // How many actually landed on the config after dedupe (approve path).
    added: { type: Number, default: 0 },
  },
  { timestamps: true },
);

module.exports = mongoose.model("RenterSubmission", renterSubmissionSchema);
