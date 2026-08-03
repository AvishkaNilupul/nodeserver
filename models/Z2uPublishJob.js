const mongoose = require("mongoose");

// One document per Z2U publish that the server tried and Cloudflare 403'd,
// so LO's Chrome extension bridge can pick it up and upload from within a
// signed-in z2u.com tab (where cf_clearance is inherently valid).
//
// Lifecycle:
//   pending  -> the fallback landed the row here; extension will claim it
//   running  -> extension checked it out (claimedAt is set)
//   done     -> extension confirmed the upload succeeded; result carries the
//               offer id(s) and Z2U's response note
//   failed   -> extension gave up (bad payload, session expired, etc.); the
//               error is human-readable so the admin UI can surface it
//
// The .xlsx we already built server-side is stored inline as base64 so the
// extension can POST it verbatim — no template regeneration in the browser.
const z2uPublishJobSchema = new mongoose.Schema(
  {
    // 'items' vs 'accounts' etc. Kept as the string key so it round-trips
    // clean into the extension's FormData without another lookup.
    game: { type: String, required: true },
    service: { type: String, default: "items" },

    // Everything we need to reconstruct a MarketplaceListing once the
    // extension reports success, without a second DropSet lookup.
    meta: {
      setId: { type: mongoose.Schema.Types.ObjectId, ref: "DropSet" },
      title: String,
      description: String,
      priceUsd: Number,
    },

    xlsxB64: { type: String, required: true }, // pre-built payload
    xlsxLen: { type: Number, default: 0 },

    status: {
      type: String,
      enum: ["pending", "running", "done", "failed"],
      default: "pending",
      index: true,
    },
    claimedAt: { type: Date, default: null },
    doneAt: { type: Date, default: null },

    // Extension-reported result on success. externalIds is best-effort; some
    // upload responses don't echo the created ids and require a follow-up
    // /sell/manageList scrape.
    result: {
      externalIds: [String],
      url: String,
      note: String,
    },

    // Populated on failure so the admin UI knows exactly why the browser
    // couldn't publish (validation error, expired session, network, ...).
    error: { type: String, default: "" },

    // Bookkeeping. Extension identifies itself so a stale/lost extension
    // instance can be told apart from a fresh one when we ship multiple.
    claimedBy: { type: String, default: "" },
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// Cap at 7 days — jobs older than that are either done (kept in
// MarketplaceListing) or unrecoverable (session was expired for a week).
z2uPublishJobSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 7 * 24 * 60 * 60 },
);

module.exports = mongoose.model("Z2uPublishJob", z2uPublishJobSchema);
