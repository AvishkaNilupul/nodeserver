const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

const { requireSuperadmin } = require("../middleware/auth");

const router = express.Router();

// Default image used when a new bot can't inherit one from an existing service.
const DEFAULT_IMAGE = "avishkarex/twitchbot:latest";
// Possible compose filenames inside BOT_DIR (first match wins).
const COMPOSE_NAMES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
];
// Hard cap on accounts accepted in one paste, as a sanity/DoS guard.
const MAX_BULK_ACCOUNTS = 2000;

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

// Normalize a comma-separated string (or array) of game names into a clean
// string array.
function parseGamesList(v) {
  if (Array.isArray(v)) {
    return v.map((g) => String(g).trim()).filter(Boolean);
  }
  if (typeof v === "string") {
    return v
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean);
  }
  return [];
}

// Coerce a single parsed JSON account object into a valid TwitchUsers entry.
// Preserves caller-supplied fields and fills in sensible defaults. Returns
// null when there's no usable auth token.
function normalizeAccount(o, defaultGames) {
  if (!o || typeof o !== "object") return null;
  const token =
    typeof o.ClientSecret === "string" ? o.ClientSecret.trim() : "";
  if (!token) return null;
  let fav = Array.isArray(o.FavouriteGames)
    ? o.FavouriteGames.map((g) => String(g).trim()).filter(Boolean)
    : [];
  if (!fav.length && Array.isArray(defaultGames)) fav = defaultGames.slice();
  return {
    ClientSecret: token,
    UniqueId:
      typeof o.UniqueId === "string" && o.UniqueId
        ? o.UniqueId
        : crypto.randomBytes(16).toString("hex"),
    Login: typeof o.Login === "string" ? o.Login : "",
    Id: o.Id == null ? "" : String(o.Id),
    Enabled: o.Enabled === false ? false : true,
    FavouriteGames: fav,
  };
}

// Try to interpret the pasted text as JSON account objects. Handles three
// shapes: a proper array `[ {...}, {...} ]`, a single object `{...}`, and a
// loose comma-separated sequence of objects (what you get when copying lines
// straight out of a config's TwitchUsers array, trailing comma and all).
function tryParseJsonAccounts(s) {
  const attempts = [s, "[" + s.replace(/,\s*$/, "") + "]"];
  for (const a of attempts) {
    try {
      const v = JSON.parse(a);
      if (Array.isArray(v)) return v;
      if (v && typeof v === "object") return [v];
    } catch {
      /* try next shape */
    }
  }
  return null;
}

// Parse pasted account text into TwitchDropsBot TwitchUsers entries.
// Two input styles are accepted:
//   1. JSON: an array, a single object, or a loose `{...},{...},` sequence of
//      account objects (fields like ClientSecret/Login/Id/Enabled preserved).
//   2. Plain lines: one account per line (separator ":", "," or whitespace):
//        <token>            -> ClientSecret only
//        <login> <token>    -> Login + ClientSecret
// `defaultGames` (array) is applied as FavouriteGames to any account that
// doesn't already specify its own.
function parseAccounts(text, defaultGames) {
  if (typeof text !== "string") return [];
  const games = Array.isArray(defaultGames) ? defaultGames : [];
  const trimmed = text.trim();
  if (!trimmed) return [];

  // JSON path: only attempt when there's an object/array in the input.
  if (trimmed.includes("{") || trimmed.startsWith("[")) {
    const parsed = tryParseJsonAccounts(trimmed);
    if (parsed) {
      const out = [];
      for (const o of parsed) {
        const acct = normalizeAccount(o, games);
        if (acct) out.push(acct);
        if (out.length >= MAX_BULK_ACCOUNTS) break;
      }
      return out;
    }
    // Fall through to line parsing if it wasn't valid JSON after all.
  }

  const out = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/[\s:,]+/).filter(Boolean);
    let login = "";
    let token = "";
    if (parts.length === 1) {
      token = parts[0];
    } else {
      login = parts[0];
      token = parts[1];
    }
    if (!token) continue;
    out.push({
      ClientSecret: token,
      UniqueId: crypto.randomBytes(16).toString("hex"),
      Login: login,
      Id: "",
      Enabled: true,
      FavouriteGames: games.slice(),
    });
    if (out.length >= MAX_BULK_ACCOUNTS) break;
  }
  return out;
}

// Given the list of files in BOT_DIR, work out the next free bot slot.
// config.json -> index 1 (twitchbot); config_0N.json -> index N (twitchbotxN).
function findNextSlot(files) {
  let max = 0;
  for (const f of files) {
    if (f === "config.json") {
      if (max < 1) max = 1;
      continue;
    }
    const m = f.match(/^config_0*(\d+)\.json$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  const index = max + 1;
  return {
    index,
    file: "config_" + String(index).padStart(2, "0") + ".json",
    container: "twitchbotx" + index,
  };
}

// Choose a template config to clone when the caller didn't specify one. Prefer
// the base config.json, otherwise the first config file available.
function pickDefaultTemplate(files) {
  if (files.includes("config.json")) return "config.json";
  const cfgs = files.filter((f) => FILE_RE.test(f)).sort();
  return cfgs[0] || null;
}

// Locate the docker compose file inside BOT_DIR (first candidate that exists).
function findComposePath() {
  for (const name of COMPOSE_NAMES) {
    const p = path.join(BOT_DIR, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Add a new service (mirroring the existing twitchbotxN ones) to the compose
// file. Uses js-yaml to parse + re-emit so hand-written indentation can't be
// corrupted. Backs up the original to .bak and writes atomically.
function addServiceToCompose(composePath, container, file) {
  const yaml = require("js-yaml");
  const raw = fs.readFileSync(composePath, "utf8");
  const doc = yaml.load(raw) || {};
  if (!doc.services || typeof doc.services !== "object") doc.services = {};
  if (doc.services[container]) return { exists: true };

  let image = DEFAULT_IMAGE;
  for (const key of Object.keys(doc.services)) {
    const svc = doc.services[key];
    if (svc && typeof svc.image === "string" && svc.image) {
      image = svc.image;
      break;
    }
  }

  doc.services[container] = {
    image,
    container_name: container,
    restart: "always",
    volumes: ["./" + file + ":/app/config.json", "./logs:/app/logs"],
  };

  fs.writeFileSync(composePath + ".bak", raw, "utf8");
  const text = yaml.dump(doc, { lineWidth: -1, noRefs: true });
  const tmp = composePath + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, composePath);
  return { exists: false, image };
}

// Remove a service from the compose file (used when deleting a bot).
function removeServiceFromCompose(composePath, container) {
  const yaml = require("js-yaml");
  const raw = fs.readFileSync(composePath, "utf8");
  const doc = yaml.load(raw) || {};
  if (!doc.services || !doc.services[container]) return false;
  delete doc.services[container];
  fs.writeFileSync(composePath + ".bak", raw, "utf8");
  const text = yaml.dump(doc, { lineWidth: -1, noRefs: true });
  const tmp = composePath + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, composePath);
  return true;
}

// Detect whether to use `docker compose` (v2 plugin) or `docker-compose` (v1).
// Cached after the first probe.
let _composeCmd = null;
function detectComposeCmd(cb) {
  if (_composeCmd) return cb(_composeCmd);
  execFile("docker", ["compose", "version"], { timeout: 8000 }, (err) => {
    _composeCmd = err ? { cmd: "docker-compose", pre: [] } : { cmd: "docker", pre: ["compose"] };
    cb(_composeCmd);
  });
}

// Write a config object to disk atomically, keeping a .bak of any prior file.
async function writeConfigAtomic(full, data) {
  try {
    const cur = await fsp.readFile(full, "utf8");
    await fsp.writeFile(full + ".bak", cur, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const tmp = full + ".tmp-" + process.pid;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fsp.rename(tmp, full);
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

// CREATE a brand-new bot: pick the next slot, clone a template's settings
// (without its accounts), seed any pasted accounts, register a compose service,
// and (by default) start the container.
router.post("/bot-configs/create", requireSuperadmin, async (req, res) => {
  try {
    const body = req.body || {};
    const startRunning = body.startRunning !== false; // default true

    if (!ALLOW_RESTART && startRunning) {
      return res.status(403).json({
        success: false,
        message: "Starting containers is disabled on this server",
      });
    }

    try {
      require("js-yaml");
    } catch {
      return res.status(500).json({
        success: false,
        message:
          "js-yaml is not installed. Run `npm install` in the nodeserver directory and restart.",
      });
    }

    const composePath = findComposePath();
    if (!composePath) {
      return res.status(500).json({
        success: false,
        message: "No docker compose file found in " + BOT_DIR,
      });
    }

    let files;
    try {
      files = await fsp.readdir(BOT_DIR);
    } catch (e) {
      return res.status(500).json({
        success: false,
        message: "Config directory not found: " + BOT_DIR + " (" + e.code + ")",
      });
    }

    const slot = findNextSlot(files);
    const newPath = path.join(BOT_DIR, slot.file);
    if (fs.existsSync(newPath)) {
      return res.status(409).json({
        success: false,
        message: "Target config already exists: " + slot.file,
      });
    }

    // Resolve the template to clone settings from.
    const templateName = body.template || pickDefaultTemplate(files);
    if (!templateName) {
      return res.status(400).json({
        success: false,
        message: "No template config available to clone from",
      });
    }
    const tplPath = resolveConfigPath(templateName);
    if (!tplPath) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid template" });
    }
    let data;
    try {
      data = JSON.parse(await fsp.readFile(tplPath, "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") {
        return res
          .status(404)
          .json({ success: false, message: "Template not found" });
      }
      return res
        .status(422)
        .json({ success: false, message: "Template is not valid JSON" });
    }

    // A new bot never inherits the template's accounts — it starts with only
    // the accounts pasted in (if any).
    if (!data.TwitchSettings || typeof data.TwitchSettings !== "object") {
      data.TwitchSettings = {};
    }
    const defaultGames = parseGamesList(body.favouriteGames);
    const accounts = parseAccounts(body.accounts, defaultGames);
    data.TwitchSettings.TwitchUsers = accounts;
    if (data.KickSettings && typeof data.KickSettings === "object") {
      data.KickSettings.KickUsers = [];
    }

    await writeConfigAtomic(newPath, data);

    try {
      addServiceToCompose(composePath, slot.container, slot.file);
    } catch (e) {
      // Roll back the config file so a failed compose edit doesn't leave an
      // orphan config behind.
      try {
        await fsp.unlink(newPath);
      } catch {
        /* ignore */
      }
      return res.status(500).json({
        success: false,
        message: "Failed to update compose file: " + e.message,
      });
    }

    const base = {
      success: true,
      file: slot.file,
      container: slot.container,
      accountCount: accounts.length,
    };

    if (!startRunning) {
      return res.json(Object.assign({ started: false }, base));
    }

    detectComposeCmd((c) => {
      const args = [...c.pre, "up", "-d", slot.container];
      execFile(
        c.cmd,
        args,
        { cwd: BOT_DIR, timeout: 120000 },
        (err, stdout, stderr) => {
          if (err) {
            // Config + compose were written; only the start failed. Report 207
            // so the UI can show a partial-success warning.
            return res.status(207).json(
              Object.assign(
                {
                  started: false,
                  warning:
                    "Bot created, but starting the container failed: " +
                    (stderr || err.message || "").trim(),
                },
                base,
              ),
            );
          }
          res.json(Object.assign({ started: true, output: (stdout || "").trim() }, base));
        },
      );
    });
  } catch (err) {
    console.error("bot create error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// BULK-APPEND accounts to an existing config (mass feed). Optionally restart
// the container afterwards so the bot picks them up.
router.post(
  "/bot-configs/file/:file/accounts",
  requireSuperadmin,
  async (req, res) => {
    const full = resolveConfigPath(req.params.file);
    if (!full) {
      return res.status(400).json({ success: false, message: "Invalid file" });
    }
    const defaultGames = parseGamesList(req.body && req.body.favouriteGames);
    const accounts = parseAccounts(
      req.body && req.body.accounts,
      defaultGames,
    );
    if (!accounts.length) {
      return res
        .status(400)
        .json({ success: false, message: "No valid accounts found in input" });
    }
    const wantRestart = !!(req.body && req.body.restart);
    try {
      let data;
      try {
        data = JSON.parse(await fsp.readFile(full, "utf8"));
      } catch (e) {
        if (e.code === "ENOENT") {
          return res
            .status(404)
            .json({ success: false, message: "Not found" });
        }
        if (e instanceof SyntaxError) {
          return res
            .status(422)
            .json({ success: false, message: "File is not valid JSON" });
        }
        throw e;
      }
      if (!data.TwitchSettings || typeof data.TwitchSettings !== "object") {
        data.TwitchSettings = {};
      }
      if (!Array.isArray(data.TwitchSettings.TwitchUsers)) {
        data.TwitchSettings.TwitchUsers = [];
      }
      data.TwitchSettings.TwitchUsers.push(...accounts);
      const total = data.TwitchSettings.TwitchUsers.length;

      await writeConfigAtomic(full, data);

      const container = containerForFile(req.params.file);
      if (!wantRestart || !ALLOW_RESTART || !container) {
        return res.json({
          success: true,
          added: accounts.length,
          total,
          restarted: false,
        });
      }
      execFile("docker", ["restart", container], { timeout: 60000 }, (err) => {
        res.json({
          success: true,
          added: accounts.length,
          total,
          restarted: !err,
        });
      });
    } catch (e) {
      console.error("bulk accounts error:", e.message);
      res
        .status(500)
        .json({ success: false, message: "Write failed: " + (e.code || e.message) });
    }
  },
);

// START / STOP the container backing a config file.
function dockerSimpleAction(action, file, res) {
  if (!ALLOW_RESTART) {
    return res
      .status(403)
      .json({ success: false, message: "Container control disabled on this server" });
  }
  if (!FILE_RE.test(file)) {
    return res.status(400).json({ success: false, message: "Invalid file" });
  }
  const container = containerForFile(file);
  if (!container) {
    return res
      .status(400)
      .json({ success: false, message: "No container mapped to this file" });
  }
  execFile(
    "docker",
    [action, container],
    { timeout: 60000 },
    (err, stdout, stderr) => {
      if (err) {
        return res.status(500).json({
          success: false,
          message: (stderr || err.message || action + " failed").trim(),
        });
      }
      res.json({ success: true, container, output: (stdout || "").trim() });
    },
  );
}

router.post("/bot-configs/start/:file", requireSuperadmin, (req, res) => {
  dockerSimpleAction("start", req.params.file, res);
});

router.post("/bot-configs/stop/:file", requireSuperadmin, (req, res) => {
  dockerSimpleAction("stop", req.params.file, res);
});

// DELETE a bot: force-remove its container, drop the compose service, and
// archive (not destroy) its config file so it can be recovered if needed.
// The base config.json / twitchbot is protected from deletion.
router.delete("/bot-configs/file/:file", requireSuperadmin, async (req, res) => {
  const file = req.params.file;
  if (!FILE_RE.test(file)) {
    return res.status(400).json({ success: false, message: "Invalid file" });
  }
  if (file === "config.json") {
    return res
      .status(400)
      .json({ success: false, message: "The base bot cannot be deleted here" });
  }
  const full = resolveConfigPath(file);
  const container = containerForFile(file);
  if (!full || !container) {
    return res.status(400).json({ success: false, message: "Invalid file" });
  }
  if (!fs.existsSync(full)) {
    return res.status(404).json({ success: false, message: "Config not found" });
  }
  try {
    // Remove the compose service first (best effort if a compose file exists).
    const composePath = findComposePath();
    if (composePath) {
      try {
        removeServiceFromCompose(composePath, container);
      } catch (e) {
        return res.status(500).json({
          success: false,
          message: "Failed to update compose file: " + e.message,
        });
      }
    }
    // Archive the config rather than deleting outright.
    const archive = full + ".deleted-" + Date.now();
    await fsp.rename(full, archive);

    // Force-remove the container (ignore "no such container").
    execFile("docker", ["rm", "-f", container], { timeout: 60000 }, () => {
      res.json({ success: true, container, archived: path.basename(archive) });
    });
  } catch (e) {
    console.error("bot delete error:", e.message);
    res.status(500).json({ success: false, message: "Delete failed: " + (e.code || e.message) });
  }
});

module.exports = router;
