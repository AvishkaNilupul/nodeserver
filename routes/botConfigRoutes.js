const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");

const { requireSuperadmin } = require("../middleware/auth");

const router = express.Router();

// Directory that holds the TwitchDropsBot config files + docker-compose.yml.
// Defaults to the production path; override with TWITCHBOT_DIR for local testing.
const BOT_DIR = process.env.TWITCHBOT_DIR || "/root/twitchbot";

// Only files matching this pattern are ever read/written. This is the security
// boundary that prevents path traversal / reading arbitrary files.
const FILE_RE = /^config(_\d{1,3})?\.json$/;

// Set TWITCHBOT_ALLOW_RESTART=0 to disable the docker restart endpoint.
const ALLOW_RESTART = process.env.TWITCHBOT_ALLOW_RESTART !== "0";

// Bot configuration is a superadmin-only capability. The guard is applied
// per-route (not via router.use) because this router is mounted at "/", so a
// router-level guard would intercept unrelated requests and redirect them.

// config.json -> twitchbot ; config_02.json -> twitchbotx2 ; config_06.json -> twitchbotx6
function containerForFile(file) {
  const m = file.match(/^config_0*(\d+)\.json$/);
  if (m) {
    return "twitchbotx" + parseInt(m[1], 10);
  }
  if (file === "config.json") {
    return "twitchbot";
  }
  return null;
}

// Validate a requested filename and resolve it safely inside BOT_DIR.
function resolveConfigPath(file) {
  if (typeof file !== "string" || !FILE_RE.test(file)) {
    return null;
  }
  const full = path.join(BOT_DIR, file);
  const rel = path.relative(BOT_DIR, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return full;
}

function summarize(file, data) {
  const ts = (data && data.TwitchSettings) || {};
  const users = Array.isArray(ts.TwitchUsers) ? ts.TwitchUsers : [];
  const ks = (data && data.KickSettings) || {};
  const kickUsers = Array.isArray(ks.KickUsers) ? ks.KickUsers : [];
  return {
    file,
    container: containerForFile(file),
    accountCount: users.length,
    enabledCount: users.filter((u) => u && u.Enabled).length,
    kickCount: kickUsers.length,
    logins: users.map((u) => (u && u.Login) || "?"),
    favouriteGames: Array.isArray(data && data.FavouriteGames)
      ? data.FavouriteGames
      : [],
    onlyFavouriteGames: !!(ts && ts.OnlyFavouriteGames),
    waitingSeconds: data ? data.WaitingSeconds : undefined,
    headless: data ? data.WatchBrowserHeadless : undefined,
  };
}

// LIST all config files with a parsed summary.
router.get("/bot-configs", requireSuperadmin, async (req, res) => {
  try {
    let files;
    try {
      files = await fsp.readdir(BOT_DIR);
    } catch (e) {
      return res.status(500).json({
        success: false,
        message:
          "Config directory not found: " +
          BOT_DIR +
          " (" +
          e.code +
          "). Set TWITCHBOT_DIR if it lives elsewhere.",
      });
    }
    const configs = files.filter((f) => FILE_RE.test(f)).sort();
    const out = [];
    for (const file of configs) {
      try {
        const raw = await fsp.readFile(path.join(BOT_DIR, file), "utf8");
        out.push({ ...summarize(file, JSON.parse(raw)), ok: true });
      } catch (e) {
        out.push({
          file,
          container: containerForFile(file),
          ok: false,
          error: e.message,
        });
      }
    }
    res.json({ success: true, dir: BOT_DIR, configs: out });
  } catch (err) {
    console.error("bot-configs list error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// READ one full config (parsed JSON object).
router.get("/bot-configs/file/:file", requireSuperadmin, async (req, res) => {
  const full = resolveConfigPath(req.params.file);
  if (!full) {
    return res.status(400).json({ success: false, message: "Invalid file" });
  }
  try {
    const raw = await fsp.readFile(full, "utf8");
    res.json({
      success: true,
      file: req.params.file,
      container: containerForFile(req.params.file),
      data: JSON.parse(raw),
    });
  } catch (e) {
    if (e.code === "ENOENT") {
      return res.status(404).json({ success: false, message: "Not found" });
    }
    if (e instanceof SyntaxError) {
      return res
        .status(422)
        .json({ success: false, message: "File is not valid JSON" });
    }
    console.error("bot-configs read error:", e.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// WRITE one config (full replace). Keeps a .bak of the previous version and
// writes atomically via a temp file + rename.
router.put("/bot-configs/file/:file", requireSuperadmin, async (req, res) => {
  const full = resolveConfigPath(req.params.file);
  if (!full) {
    return res.status(400).json({ success: false, message: "Invalid file" });
  }
  const data = req.body && req.body.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return res
      .status(400)
      .json({ success: false, message: "Body must be { data: <object> }" });
  }
  // Light structural validation so we never write something the bot can't read.
  if (data.TwitchSettings && data.TwitchSettings.TwitchUsers !== undefined) {
    if (!Array.isArray(data.TwitchSettings.TwitchUsers)) {
      return res.status(400).json({
        success: false,
        message: "TwitchSettings.TwitchUsers must be an array",
      });
    }
  }
  try {
    // Back up the current file (best effort).
    try {
      const cur = await fsp.readFile(full, "utf8");
      await fsp.writeFile(full + ".bak", cur, "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const text = JSON.stringify(data, null, 2);
    const tmp = full + ".tmp-" + process.pid;
    await fsp.writeFile(tmp, text, "utf8");
    await fsp.rename(tmp, full);
    res.json({ success: true });
  } catch (e) {
    console.error("bot-configs write error:", e.message);
    res
      .status(500)
      .json({ success: false, message: "Write failed: " + e.code });
  }
});

// Docker container statuses (best effort; empty map if docker unavailable).
router.get("/bot-configs/status", requireSuperadmin, (req, res) => {
  execFile(
    "docker",
    ["ps", "-a", "--format", "{{.Names}}\t{{.State}}\t{{.Status}}"],
    { timeout: 8000 },
    (err, stdout) => {
      if (err) {
        return res.json({ success: true, available: false, states: {} });
      }
      const states = {};
      stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .forEach((line) => {
          const [name, state, status] = line.split("\t");
          states[name] = { state, status };
        });
      res.json({ success: true, available: true, states });
    },
  );
});

// RESTART the docker container backing a config file.
router.post("/bot-configs/restart/:file", requireSuperadmin, (req, res) => {
  if (!ALLOW_RESTART) {
    return res
      .status(403)
      .json({ success: false, message: "Restart disabled on this server" });
  }
  if (!FILE_RE.test(req.params.file)) {
    return res.status(400).json({ success: false, message: "Invalid file" });
  }
  const container = containerForFile(req.params.file);
  if (!container) {
    return res
      .status(400)
      .json({ success: false, message: "No container mapped to this file" });
  }
  // Confirm the config exists before bouncing the container.
  if (!fs.existsSync(path.join(BOT_DIR, req.params.file))) {
    return res
      .status(404)
      .json({ success: false, message: "Config not found" });
  }
  execFile(
    "docker",
    ["restart", container],
    { timeout: 60000 },
    (err, stdout, stderr) => {
      if (err) {
        return res.status(500).json({
          success: false,
          message: (stderr || err.message || "restart failed").trim(),
        });
      }
      res.json({ success: true, container, output: stdout.trim() });
    },
  );
});

module.exports = router;
