const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const sharp = require("sharp");

const SOURCE_DIR = path.join(__dirname, "..", "public", "drop-images");
const CACHE_DIR =
  process.env.CATALOG_THUMB_DIR ||
  path.join(os.tmpdir(), "redeemer-catalog-thumbnails");
const SAFE_FILE = /^[a-f0-9]{40}\.(?:png|jpe?g|gif|webp)$/i;
const jobs = new Map();

function thumbnailUrl(image) {
  const value = String(image || "");
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      url.hostname === "static-cdn.jtvnw.net" &&
      url.pathname.startsWith("/twitch-quests-assets/")
    ) {
      return url.href;
    }
  } catch {
    // Local catalog artwork is handled below.
  }
  if (!value.startsWith("/drop-images/")) return "";
  const file = path.basename(value);
  return SAFE_FILE.test(file) ? `/catalog/thumb/${file}` : "";
}

async function ensureThumbnail(file) {
  if (!SAFE_FILE.test(file)) return "";
  const output = path.join(CACHE_DIR, `${path.parse(file).name}.webp`);
  try {
    await fs.access(output);
    return output;
  } catch {
    // The first request creates the cached thumbnail below.
  }
  if (!jobs.has(output)) {
    jobs.set(
      output,
      (async () => {
        await fs.mkdir(CACHE_DIR, { recursive: true });
        await sharp(path.join(SOURCE_DIR, file), { animated: false })
          .rotate()
          .resize(320, 320, { fit: "cover", withoutEnlargement: true })
          .webp({ quality: 76, effort: 4 })
          .toFile(output);
        return output;
      })().finally(() => jobs.delete(output)),
    );
  }
  return jobs.get(output);
}

module.exports = { SAFE_FILE, thumbnailUrl, ensureThumbnail };
