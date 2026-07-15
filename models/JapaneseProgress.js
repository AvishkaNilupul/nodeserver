const mongoose = require("mongoose");

// Per-admin Japanese (JLPT N5) study state, so progress follows the user
// across devices (desktop + mobile) instead of living only in one browser's
// localStorage. Kept as a single document per admin: the whole study state is
// small (a few hundred spaced-repetition entries plus any custom words and
// sentences) and is loaded/saved as one blob, which keeps the sync logic
// simple and lets the client work offline and reconcile on reconnect.
//
// The flexible maps/arrays use loose types on purpose — the shapes are owned
// by the client (see public/japanese.html):
//   srs       { [cardId]: { box, due, reps, lapses } }
//   stats     { streak, lastStudy, history, reviewsTotal }
//   settings  { script, showRomaji }
//   words     [ { id, w, k, r, m, note, createdAt } ]   custom vocabulary
//   sentences [ { id, j, r, m, note, createdAt } ]      conversation practice
const japaneseProgressSchema = new mongoose.Schema(
  {
    adminId: { type: String, required: true, unique: true, index: true },
    srs: { type: Object, default: {} },
    stats: { type: Object, default: {} },
    settings: { type: Object, default: {} },
    words: { type: Array, default: [] },
    sentences: { type: Array, default: [] },
    // Client wall-clock (ms) of the last local change, used for last-writer
    // reconciliation between devices.
    clientUpdatedAt: { type: Number, default: 0 },
  },
  { timestamps: true, minimize: false },
);

module.exports = mongoose.model("JapaneseProgress", japaneseProgressSchema);
