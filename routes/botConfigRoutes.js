const express = require("express");
const crypto = require("crypto");

const { requireSuperadmin } = require("../middleware/auth");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const hosts = require("../utils/botHosts");

const router = express.Router();

// Default image used when a new bot can't inherit one from an existing service.
const DEFAULT_IMAGE = "avishkarex/twitchbot:latest";
// Hard cap on accounts accepted in one paste, as a sanity/DoS guard.
const MAX_BULK_ACCOUNTS = 2000;

// Only files matching this pattern are ever read/written. This is the security
// boundary that prevents path traversal / reading arbitrary files.
const FILE_RE = /^config(_\d{1,3})?\.json$/;

// Set TWITCHBOT_ALLOW_RESTART=0 to disable the docker restart endpoint.
const ALLOW_RESTART = process.env.TWITCHBOT_ALLOW_RESTART !== "0";

// Bot configuration is a superadmin-only capability. The guard is applied
// per-route (not via router.use) because this router is mounted at "/", so a
// router-level guard would intercept unrelated requests and redirect them.

// Resolve the host a request targets. Accepts ?host= (query) or { host } in the
// body; missing/empty defaults to the local server, so old URLs keep working.
// Returns null for an unknown host id (the caller turns that into a 400).
function hostFromReq(req) {
  const id = (req.query && req.query.host) || (req.body && req.body.host) || "";
  return hosts.resolveHost(id);
}

function badHost(res) {
  return res.status(400).json({ success: false, message: "Unknown host" });
}

// Translate a transport/SSH failure into a friendly message. Unreachable hosts
// (e.g. a Raspberry Pi that's powered off) are reported as such rather than as
// a generic server error.
function hostErrorMessage(host, e) {
  if (e && e.unreachable) {
    return host.label + " is unreachable (host offline or SSH not set up)";
  }
  return (e && e.message) || "Operation failed";
}

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

// Validate a requested config filename (the path-traversal security boundary).
function validFile(file) {
  return typeof file === "string" && FILE_RE.test(file);
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
  const token = typeof o.ClientSecret === "string" ? o.ClientSecret.trim() : "";
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

// Given the list of files in a host dir, work out the next free bot slot.
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

// Add a new service (mirroring the existing twitchbotxN ones) to a compose
// document given its raw YAML text. Uses js-yaml to parse + re-emit so
// hand-written indentation can't be corrupted. Returns the new text plus
// whether the service already existed.
function addServiceToComposeText(raw, container, file) {
  const yaml = require("js-yaml");
  const doc = yaml.load(raw) || {};
  if (!doc.services || typeof doc.services !== "object") doc.services = {};
  if (doc.services[container]) return { exists: true, text: raw };

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

  const text = yaml.dump(doc, { lineWidth: -1, noRefs: true });
  return { exists: false, image, text };
}

// Remove a service from a compose document given its raw YAML text. Returns the
// new text plus whether anything was removed.
function removeServiceFromComposeText(raw, container) {
  const yaml = require("js-yaml");
  const doc = yaml.load(raw) || {};
  if (!doc.services || !doc.services[container])
    return { removed: false, text: raw };
  delete doc.services[container];
  const text = yaml.dump(doc, { lineWidth: -1, noRefs: true });
  return { removed: true, text };
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

// LIST the configured hosts (so the UI can render a tab per host).
router.get("/bot-configs/hosts", requireSuperadmin, (req, res) => {
  res.json({ success: true, hosts: hosts.listHosts() });
});

// LIST all config files on a host with a parsed summary.
router.get("/bot-configs", requireSuperadmin, async (req, res) => {
  const host = hostFromReq(req);
  if (!host) return badHost(res);
  try {
    let files;
    try {
      files = await hosts.readdir(host);
    } catch (e) {
      if (e.unreachable) {
        return res.status(502).json({
          success: false,
          offline: true,
          message: hostErrorMessage(host, e),
        });
      }
      return res.status(500).json({
        success: false,
        message:
          "Config directory not found: " +
          host.dir +
          " (" +
          (e.code || e.message) +
          ").",
      });
    }
    const configs = files.filter((f) => FILE_RE.test(f)).sort();
    const out = [];
    for (const file of configs) {
      try {
        const raw = await hosts.readFile(host, file);
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
    res.json({ success: true, host: host.id, dir: host.dir, configs: out });
  } catch (err) {
    console.error("bot-configs list error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// HEALTH summary per config file for a host: account scan status counts, total
// drops and last-drop time. Aggregated from the BotAccount/DropLog archive (the
// scanner's data), keyed by configFile so the Bots page can show it per bot.
// Best effort: returns an empty map on error so the page still renders.
router.get("/bot-configs/health", requireSuperadmin, async (req, res) => {
  const host = hostFromReq(req);
  if (!host) return badHost(res);
  try {
    // Local accounts may predate the `host` field, so treat missing as local.
    const hostMatch =
      host.id === "local"
        ? {
            $or: [
              { host: "local" },
              { host: { $exists: false } },
              { host: "" },
            ],
          }
        : { host: host.id };

    const byFile = await BotAccount.aggregate([
      { $match: hostMatch },
      {
        $group: {
          _id: "$configFile",
          accounts: { $sum: 1 },
          ok: { $sum: { $cond: [{ $eq: ["$lastScanStatus", "ok"] }, 1, 0] } },
          error: {
            $sum: { $cond: [{ $eq: ["$lastScanStatus", "error"] }, 1, 0] },
          },
          tokenInvalid: {
            $sum: {
              $cond: [{ $eq: ["$lastScanStatus", "token_invalid"] }, 1, 0],
            },
          },
          pending: {
            $sum: { $cond: [{ $eq: ["$lastScanStatus", "pending"] }, 1, 0] },
          },
          drops: { $sum: "$dropCount" },
          lastScanAt: { $max: "$lastScanAt" },
        },
      },
    ]);

    // Most recent drop time per account, then rolled up to the config file.
    const accs = await BotAccount.find(hostMatch, { configFile: 1 }).lean();
    const accIdToFile = {};
    accs.forEach((a) => {
      accIdToFile[String(a._id)] = a.configFile || "";
    });
    const accIds = accs.map((a) => a._id);
    const lastDropByAccount = await DropLog.aggregate([
      { $match: { account: { $in: accIds } } },
      {
        $group: {
          _id: "$account",
          lastDropAt: { $max: { $ifNull: ["$awardedAt", "$firstSeenAt"] } },
        },
      },
    ]);
    const lastDropByFile = {};
    lastDropByAccount.forEach((r) => {
      const f = accIdToFile[String(r._id)];
      if (!f || !r.lastDropAt) return;
      const t = new Date(r.lastDropAt).getTime();
      if (!lastDropByFile[f] || t > lastDropByFile[f]) lastDropByFile[f] = t;
    });

    const health = {};
    byFile.forEach((r) => {
      const f = r._id || "";
      if (!f) return;
      health[f] = {
        accounts: r.accounts,
        ok: r.ok,
        error: r.error,
        tokenInvalid: r.tokenInvalid,
        pending: r.pending,
        drops: r.drops || 0,
        lastScanAt: r.lastScanAt || null,
        lastDropAt: lastDropByFile[f] ? new Date(lastDropByFile[f]) : null,
      };
    });
    res.json({ success: true, health });
  } catch (err) {
    console.error("bot-configs health error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// READ one full config (parsed JSON object).
router.get("/bot-configs/file/:file", requireSuperadmin, async (req, res) => {
  const host = hostFromReq(req);
  if (!host) return badHost(res);
  if (!validFile(req.params.file)) {
    return res.status(400).json({ success: false, message: "Invalid file" });
  }
  try {
    const raw = await hosts.readFile(host, req.params.file);
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
    if (e.unreachable) {
      return res
        .status(502)
        .json({
          success: false,
          offline: true,
          message: hostErrorMessage(host, e),
        });
    }
    console.error("bot-configs read error:", e.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// WRITE one config (full replace). Keeps a .bak of the previous version and
// writes atomically via a temp file + rename.
router.put("/bot-configs/file/:file", requireSuperadmin, async (req, res) => {
  const host = hostFromReq(req);
  if (!host) return badHost(res);
  if (!validFile(req.params.file)) {
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
    const text = JSON.stringify(data, null, 2);
    await hosts.writeFileAtomic(host, req.params.file, text);
    res.json({ success: true });
  } catch (e) {
    if (e.unreachable) {
      return res
        .status(502)
        .json({
          success: false,
          offline: true,
          message: hostErrorMessage(host, e),
        });
    }
    console.error("bot-configs write error:", e.message);
    res
      .status(500)
      .json({
        success: false,
        message: "Write failed: " + (e.code || e.message),
      });
  }
});

// Docker container statuses (best effort; empty map if docker unavailable).
router.get("/bot-configs/status", requireSuperadmin, async (req, res) => {
  const host = hostFromReq(req);
  if (!host) return badHost(res);
  try {
    const states = await hosts.dockerPs(host);
    res.json({ success: true, available: true, states });
  } catch (e) {
    res.json({
      success: true,
      available: false,
      offline: !!e.unreachable,
      states: {},
    });
  }
});

// LIVE LOGS: tail the docker logs of the container backing a config file.
// The frontend polls this for a live feed; ?tail=N controls how many lines.
router.get("/bot-configs/logs/:file", requireSuperadmin, async (req, res) => {
  const host = hostFromReq(req);
  if (!host) return badHost(res);
  if (!validFile(req.params.file)) {
    return res.status(400).json({ success: false, message: "Invalid file" });
  }
  const container = containerForFile(req.params.file);
  if (!container) {
    return res
      .status(400)
      .json({ success: false, message: "No container mapped to this file" });
  }
  try {
    const logs = await hosts.dockerLogs(host, container, {
      tail: req.query.tail,
    });
    res.json({ success: true, container, logs });
  } catch (e) {
    res.status(e.unreachable ? 502 : 500).json({
      success: false,
      offline: !!e.unreachable,
      message: hostErrorMessage(host, e),
    });
  }
});

// HOST STATS: CPU / memory / disk / uptime for the machine this host runs on,
// plus per-container CPU/mem. Used for the resource-usage strip on each tab.
// Fails soft (available:false) so the page never breaks when a host is offline.
router.get("/bot-configs/host-stats", requireSuperadmin, async (req, res) => {
  const host = hostFromReq(req);
  if (!host) return badHost(res);
  try {
    const stats = await hosts.hostStats(host);
    let containers = {};
    try {
      containers = await hosts.dockerStats(host);
    } catch {
      /* docker stats is best-effort */
    }
    res.json({ success: true, available: true, stats, containers });
  } catch (e) {
    res.json({
      success: true,
      available: false,
      offline: !!e.unreachable,
    });
  }
});

// RESTART the docker container backing a config file.
router.post(
  "/bot-configs/restart/:file",
  requireSuperadmin,
  async (req, res) => {
    const host = hostFromReq(req);
    if (!host) return badHost(res);
    if (!ALLOW_RESTART) {
      return res
        .status(403)
        .json({ success: false, message: "Restart disabled on this server" });
    }
    if (!validFile(req.params.file)) {
      return res.status(400).json({ success: false, message: "Invalid file" });
    }
    const container = containerForFile(req.params.file);
    if (!container) {
      return res
        .status(400)
        .json({ success: false, message: "No container mapped to this file" });
    }
    try {
      // Confirm the config exists before bouncing the container.
      if (!(await hosts.exists(host, req.params.file))) {
        return res
          .status(404)
          .json({ success: false, message: "Config not found" });
      }
      const output = await hosts.dockerContainer(host, "restart", container);
      res.json({ success: true, container, output });
    } catch (e) {
      res.status(e.unreachable ? 502 : 500).json({
        success: false,
        offline: !!e.unreachable,
        message: hostErrorMessage(host, e),
      });
    }
  },
);

// CREATE a brand-new bot: pick the next slot, clone a template's settings
// (without its accounts), seed any pasted accounts, register a compose service,
// and (by default) start the container.
router.post("/bot-configs/create", requireSuperadmin, async (req, res) => {
  const host = hostFromReq(req);
  if (!host) return badHost(res);
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

    let files;
    try {
      files = await hosts.readdir(host);
    } catch (e) {
      return res.status(e.unreachable ? 502 : 500).json({
        success: false,
        offline: !!e.unreachable,
        message: e.unreachable
          ? hostErrorMessage(host, e)
          : "Config directory not found: " +
            host.dir +
            " (" +
            (e.code || e.message) +
            ")",
      });
    }

    const composeFile = await hosts.composeName(host);
    if (!composeFile) {
      return res.status(500).json({
        success: false,
        message: "No docker compose file found in " + host.dir,
      });
    }

    const slot = findNextSlot(files);
    if (await hosts.exists(host, slot.file)) {
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
    if (!validFile(templateName)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid template" });
    }
    let data;
    try {
      data = JSON.parse(await hosts.readFile(host, templateName));
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

    await hosts.writeFileAtomic(host, slot.file, JSON.stringify(data, null, 2));

    // Register the compose service (read -> edit YAML -> write back).
    try {
      const raw = await hosts.composeRead(host, composeFile);
      const edited = addServiceToComposeText(raw, slot.container, slot.file);
      if (!edited.exists) {
        await hosts.composeWrite(host, composeFile, edited.text);
      }
    } catch (e) {
      // Roll back the config file so a failed compose edit doesn't leave an
      // orphan config behind.
      try {
        await hosts.rename(
          host,
          slot.file,
          slot.file + ".rollback-" + Date.now(),
        );
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
      host: host.id,
      file: slot.file,
      container: slot.container,
      accountCount: accounts.length,
    };

    if (!startRunning) {
      return res.json(Object.assign({ started: false }, base));
    }

    try {
      const output = await hosts.composeUp(host, slot.container);
      res.json(Object.assign({ started: true, output }, base));
    } catch (e) {
      // Config + compose were written; only the start failed. Report 207 so
      // the UI can show a partial-success warning.
      res.status(207).json(
        Object.assign(
          {
            started: false,
            warning:
              "Bot created, but starting the container failed: " +
              hostErrorMessage(host, e),
          },
          base,
        ),
      );
    }
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
    const host = hostFromReq(req);
    if (!host) return badHost(res);
    if (!validFile(req.params.file)) {
      return res.status(400).json({ success: false, message: "Invalid file" });
    }
    const defaultGames = parseGamesList(req.body && req.body.favouriteGames);
    const accounts = parseAccounts(req.body && req.body.accounts, defaultGames);
    if (!accounts.length) {
      return res
        .status(400)
        .json({ success: false, message: "No valid accounts found in input" });
    }
    const wantRestart = !!(req.body && req.body.restart);
    try {
      let data;
      try {
        data = JSON.parse(await hosts.readFile(host, req.params.file));
      } catch (e) {
        if (e.code === "ENOENT") {
          return res.status(404).json({ success: false, message: "Not found" });
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

      await hosts.writeFileAtomic(
        host,
        req.params.file,
        JSON.stringify(data, null, 2),
      );

      const container = containerForFile(req.params.file);
      if (!wantRestart || !ALLOW_RESTART || !container) {
        return res.json({
          success: true,
          added: accounts.length,
          total,
          restarted: false,
        });
      }
      let restarted = true;
      try {
        await hosts.dockerContainer(host, "restart", container);
      } catch {
        restarted = false;
      }
      res.json({ success: true, added: accounts.length, total, restarted });
    } catch (e) {
      if (e.unreachable) {
        return res
          .status(502)
          .json({
            success: false,
            offline: true,
            message: hostErrorMessage(host, e),
          });
      }
      console.error("bulk accounts error:", e.message);
      res
        .status(500)
        .json({
          success: false,
          message: "Write failed: " + (e.code || e.message),
        });
    }
  },
);

// START / STOP the container backing a config file.
async function dockerSimpleAction(host, action, file, res) {
  if (!ALLOW_RESTART) {
    return res.status(403).json({
      success: false,
      message: "Container control disabled on this server",
    });
  }
  if (!validFile(file)) {
    return res.status(400).json({ success: false, message: "Invalid file" });
  }
  const container = containerForFile(file);
  if (!container) {
    return res
      .status(400)
      .json({ success: false, message: "No container mapped to this file" });
  }
  try {
    const output = await hosts.dockerContainer(host, action, container);
    res.json({ success: true, container, output });
  } catch (e) {
    res.status(e.unreachable ? 502 : 500).json({
      success: false,
      offline: !!e.unreachable,
      message: hostErrorMessage(host, e),
    });
  }
}

router.post("/bot-configs/start/:file", requireSuperadmin, (req, res) => {
  const host = hostFromReq(req);
  if (!host) return badHost(res);
  dockerSimpleAction(host, "start", req.params.file, res);
});

router.post("/bot-configs/stop/:file", requireSuperadmin, (req, res) => {
  const host = hostFromReq(req);
  if (!host) return badHost(res);
  dockerSimpleAction(host, "stop", req.params.file, res);
});

// DELETE a bot: force-remove its container, drop the compose service, and
// archive (not destroy) its config file so it can be recovered if needed.
// The base config.json / twitchbot is protected from deletion.
router.delete(
  "/bot-configs/file/:file",
  requireSuperadmin,
  async (req, res) => {
    const host = hostFromReq(req);
    if (!host) return badHost(res);
    const file = req.params.file;
    if (!validFile(file)) {
      return res.status(400).json({ success: false, message: "Invalid file" });
    }
    if (file === "config.json") {
      return res
        .status(400)
        .json({
          success: false,
          message: "The base bot cannot be deleted here",
        });
    }
    const container = containerForFile(file);
    if (!container) {
      return res.status(400).json({ success: false, message: "Invalid file" });
    }
    try {
      if (!(await hosts.exists(host, file))) {
        return res
          .status(404)
          .json({ success: false, message: "Config not found" });
      }
      // Remove the compose service first (best effort if a compose file exists).
      const composeFile = await hosts.composeName(host);
      if (composeFile) {
        try {
          const raw = await hosts.composeRead(host, composeFile);
          const edited = removeServiceFromComposeText(raw, container);
          if (edited.removed) {
            await hosts.composeWrite(host, composeFile, edited.text);
          }
        } catch (e) {
          return res.status(500).json({
            success: false,
            message: "Failed to update compose file: " + e.message,
          });
        }
      }
      // Archive the config rather than deleting outright.
      const archive = file + ".deleted-" + Date.now();
      await hosts.rename(host, file, archive);

      // Force-remove the container (ignore "no such container").
      try {
        await hosts.dockerContainer(host, "rm", container);
      } catch {
        /* ignore */
      }
      res.json({ success: true, container, archived: archive });
    } catch (e) {
      if (e.unreachable) {
        return res
          .status(502)
          .json({
            success: false,
            offline: true,
            message: hostErrorMessage(host, e),
          });
      }
      console.error("bot delete error:", e.message);
      res
        .status(500)
        .json({
          success: false,
          message: "Delete failed: " + (e.code || e.message),
        });
    }
  },
);

module.exports = router;
