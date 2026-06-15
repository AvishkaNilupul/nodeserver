// Downloads drop reward images once and stores them on disk so the archive is
// self-contained — the picture survives even if Twitch later removes the CDN
// asset. Images are deduped by a hash of the (placeholder-resolved) URL, so a
// reward shared across many accounts is only fetched once.
//
// These are static CDN assets (static-cdn.jtvnw.net), not the GQL API, so
// fetching them does not count against the inventory rate limit we throttle.
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");

// Served statically by express from the public/ directory.
const DIR = path.join(__dirname, "..", "public", "drop-images");
const WEB_PREFIX = "/drop-images/";

const EXT_BY_TYPE = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

let dirReady = false;
async function ensureDir() {
  if (dirReady) return;
  await fsp.mkdir(DIR, { recursive: true });
  dirReady = true;
}

// Twitch image URLs sometimes carry {width}/{height} placeholders.
function resolveUrl(url) {
  return String(url || "")
    .trim()
    .replace(/\{width\}/g, "80")
    .replace(/\{height\}/g, "80");
}

function hashFor(url) {
  return crypto.createHash("sha1").update(url).digest("hex");
}

// Return an existing cached file's web path for this url, if present.
function findExisting(hash) {
  for (const ext of [".png", ".jpg", ".gif", ".webp"]) {
    if (fs.existsSync(path.join(DIR, hash + ext))) {
      return WEB_PREFIX + hash + ext;
    }
  }
  return "";
}

// Download (if needed) and return the local web path, or "" on failure.
async function cacheImage(url) {
  const resolved = resolveUrl(url);
  if (!/^https?:\/\//i.test(resolved)) return "";
  const hash = hashFor(resolved);

  const existing = findExisting(hash);
  if (existing) return existing;

  try {
    await ensureDir();
    const res = await axios.get(resolved, {
      responseType: "arraybuffer",
      timeout: 20000,
      maxContentLength: 5 * 1024 * 1024,
      validateStatus: (s) => s >= 200 && s < 300,
    });
    const type = String(res.headers["content-type"] || "").split(";")[0];
    const ext = EXT_BY_TYPE[type] || ".png";
    const file = hash + ext;
    await fsp.writeFile(path.join(DIR, file), Buffer.from(res.data));
    return WEB_PREFIX + file;
  } catch {
    return "";
  }
}

module.exports = { cacheImage };
