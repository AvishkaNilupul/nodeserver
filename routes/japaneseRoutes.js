const express = require("express");
const crypto = require("crypto");

const { requireAdmin } = require("../middleware/auth");
const JapaneseProgress = require("../models/JapaneseProgress");
const JapaneseAccessCode = require("../models/JapaneseAccessCode");
const jishoLookup = require("../utils/jishoLookup");

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

router.get("/japanese/lookup", requireAdmin, jishoLookup);

// ---- Guest access codes (Students tab) -----------------------------------
// Codes use an unambiguous alphabet (no 0/O/1/I/L) so they survive being read
// out loud or typed from a phone.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function generateCode() {
  const bytes = crypto.randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return s.slice(0, 4) + "-" + s.slice(4);
}

// Compact progress summary the Students list shows per guest.
function progressSummary(doc) {
  if (!doc) return null;
  const stats = doc.stats || {};
  const exams = Array.isArray(stats.exams) ? stats.exams : [];
  return {
    xp: stats.xp || 0,
    streak: stats.streak || 0,
    reviewsTotal: stats.reviewsTotal || 0,
    cards: Object.keys(doc.srs || {}).length,
    words: Array.isArray(doc.words) ? doc.words.length : 0,
    sentences: Array.isArray(doc.sentences) ? doc.sentences.length : 0,
    level: (doc.settings || {}).level || "n5",
    exams: exams.slice(0, 8),
    history: stats.history || {},
    updatedAt: doc.clientUpdatedAt || 0,
  };
}

router.get("/japanese/codes", requireAdmin, async (req, res) => {
  try {
    const codes = await JapaneseAccessCode.find({}).sort({ createdAt: -1 }).lean();
    const progressDocs = await JapaneseProgress.find({
      adminId: { $in: codes.map((c) => "learn:" + c.code) },
    }).lean();
    const byId = {};
    progressDocs.forEach((d) => (byId[d.adminId] = d));
    res.json({
      success: true,
      codes: codes.map((c) => ({
        id: String(c._id),
        code: c.code,
        label: c.label,
        active: c.active,
        createdAt: c.createdAt,
        lastActiveAt: c.lastActiveAt || 0,
        progress: progressSummary(byId["learn:" + c.code]),
      })),
    });
  } catch (err) {
    console.error("japanese/codes list error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.post("/japanese/codes", requireAdmin, async (req, res) => {
  try {
    const label = String((req.body || {}).label || "").trim().slice(0, 60);
    let code;
    for (let i = 0; i < 5; i++) {
      code = generateCode();
      const clash = await JapaneseAccessCode.findOne({ code }).lean();
      if (!clash) break;
      code = null;
    }
    if (!code) return res.status(500).json({ success: false, message: "Could not generate code" });
    const doc = await JapaneseAccessCode.create({
      code,
      label,
      createdBy: (req.session.admin || {}).username || "",
    });
    res.json({ success: true, code: { id: String(doc._id), code: doc.code, label: doc.label, active: doc.active } });
  } catch (err) {
    console.error("japanese/codes create error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.put("/japanese/codes/:id", requireAdmin, async (req, res) => {
  try {
    const doc = await JapaneseAccessCode.findByIdAndUpdate(
      req.params.id,
      { $set: { active: !!(req.body || {}).active } },
      { new: true },
    ).lean();
    if (!doc) return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true });
  } catch (err) {
    console.error("japanese/codes update error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.delete("/japanese/codes/:id", requireAdmin, async (req, res) => {
  try {
    const doc = await JapaneseAccessCode.findByIdAndDelete(req.params.id).lean();
    if (!doc) return res.status(404).json({ success: false, message: "Not found" });
    await JapaneseProgress.deleteOne({ adminId: "learn:" + doc.code });
    res.json({ success: true });
  } catch (err) {
    console.error("japanese/codes delete error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
