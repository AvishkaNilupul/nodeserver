const express = require("express");

const { requireAdmin } = require("../middleware/auth");
const JapaneseProgress = require("../models/JapaneseProgress");

const router = express.Router();

// Cap the arrays so a runaway client can't grow the document without bound.
const MAX_ITEMS = 5000;

// Shape a stored document into the client's state format. `updatedAt` is what
// the client compares against its own local timestamp to decide who wins.
function toState(doc) {
  if (!doc) return null;
  return {
    srs: doc.srs || {},
    stats: doc.stats || {},
    settings: doc.settings || {},
    words: Array.isArray(doc.words) ? doc.words : [],
    sentences: Array.isArray(doc.sentences) ? doc.sentences : [],
    updatedAt: doc.clientUpdatedAt || 0,
  };
}

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

// Load the current admin's study state (null if they've never synced).
router.get("/japanese/state", requireAdmin, async (req, res) => {
  try {
    const doc = await JapaneseProgress.findOne({
      adminId: req.session.admin.id,
    }).lean();
    res.json({ success: true, state: toState(doc) });
  } catch (err) {
    console.error("japanese/state load error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Replace the current admin's study state with the client's snapshot.
// Last-write-wins: the client only pushes when its local copy is newer, so a
// straight overwrite is the intended behaviour.
router.put("/japanese/state", requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const update = {
      srs: isObj(b.srs) ? b.srs : {},
      stats: isObj(b.stats) ? b.stats : {},
      settings: isObj(b.settings) ? b.settings : {},
      words: Array.isArray(b.words) ? b.words.slice(0, MAX_ITEMS) : [],
      sentences: Array.isArray(b.sentences)
        ? b.sentences.slice(0, MAX_ITEMS)
        : [],
      clientUpdatedAt: Number(b.updatedAt) || Date.now(),
    };
    const doc = await JapaneseProgress.findOneAndUpdate(
      { adminId: req.session.admin.id },
      { $set: update },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();
    res.json({ success: true, state: toState(doc) });
  } catch (err) {
    console.error("japanese/state save error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
