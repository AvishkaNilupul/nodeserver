const express = require("express");
const https = require("https");

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

// Dictionary lookup proxy (Jisho.org). The browser can't call Jisho directly
// (no CORS), so the server fetches and returns a trimmed-down result. Cached
// in memory since dictionary entries don't change.
const lookupCache = new Map();
const LOOKUP_TTL = 24 * 60 * 60 * 1000;
const LOOKUP_CACHE_MAX = 1000;

router.get("/japanese/lookup", requireAdmin, (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 64);
  if (!q) return res.status(400).json({ success: false, message: "Missing q" });

  const hit = lookupCache.get(q);
  if (hit && Date.now() - hit.t < LOOKUP_TTL) {
    return res.json({ success: true, data: hit.data });
  }

  const url =
    "https://jisho.org/api/v1/search/words?keyword=" + encodeURIComponent(q);
  https
    .get(url, { headers: { "User-Agent": "nodeserver-japanese" } }, (r) => {
      let body = "";
      r.on("data", (c) => (body += c));
      r.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          const data = (Array.isArray(parsed.data) ? parsed.data : [])
            .slice(0, 5)
            .map((e) => ({
              japanese: (e.japanese || []).slice(0, 4).map((j) => ({
                word: j.word || "",
                reading: j.reading || "",
              })),
              senses: (e.senses || [])
                .slice(0, 4)
                .map((s) => (s.english_definitions || []).slice(0, 4)),
              common: !!e.is_common,
            }));
          if (lookupCache.size >= LOOKUP_CACHE_MAX) lookupCache.clear();
          lookupCache.set(q, { t: Date.now(), data });
          res.json({ success: true, data });
        } catch (err) {
          console.error("japanese/lookup parse error:", err.message);
          res
            .status(502)
            .json({ success: false, message: "Dictionary unavailable" });
        }
      });
    })
    .on("error", () => {
      res.status(502).json({ success: false, message: "Dictionary unavailable" });
    });
});

module.exports = router;
