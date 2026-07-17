const https = require("https");

// Dictionary lookup proxy (Jisho.org). The browser can't call Jisho directly
// (no CORS), so the server fetches and returns a trimmed-down result. Cached
// in memory since dictionary entries don't change. Shared by the admin app
// (/japanese/lookup) and the guest learning app (/learn/lookup).
const lookupCache = new Map();
const LOOKUP_TTL = 24 * 60 * 60 * 1000;
const LOOKUP_CACHE_MAX = 1000;

function jishoLookup(req, res) {
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
          console.error("japanese lookup parse error:", err.message);
          res
            .status(502)
            .json({ success: false, message: "Dictionary unavailable" });
        }
      });
    })
    .on("error", () => {
      res.status(502).json({ success: false, message: "Dictionary unavailable" });
    });
}

module.exports = jishoLookup;
