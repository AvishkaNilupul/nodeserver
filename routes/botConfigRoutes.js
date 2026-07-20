const express = require("express");
const crypto = require("crypto");

const { requireSuperadmin } = require("../middleware/auth");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const Renter = require("../models/Renter");
const RenterAccount = require("../models/RenterAccount");
const hosts = require("../utils/botHosts");

const router = express.Router();

// Config files that are rented out to a renter (managed in the Renting section,
// not on the operator's Bots page). Returned as a Set of "<hostId>|<file>" so
// the bot-list endpoints can keep renter bots out of the operator's own view.
async function getRentedConfigSet() {
  try {
    const rows = await Renter.find(
      { botFile: { $gt: "" } },
      { botHost: 1, botFile: 1 },
    ).lean();
    return new Set(rows.map((r) => (r.botHost || "") + "|" + r.botFile));
  } catch {
    return new Set();
  }
}

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

// Split freshly-parsed accounts into ones safe to add and ones already
// claimed elsewhere, so a mass paste never silently double-assigns an
// account to two bots (or duplicates it within the same one). Checks two
// things: repeats within the same paste, and a ClientSecret already tracked
// by BotAccount (the cross-host index kept in sync by /drops-archive/sync
// and by writes through this router) — including one already sitting in the
// very file being written to, since re-appending it would just create an
// in-array duplicate there too.
async function dedupeAccounts(accounts) {
  const seen = new Set();
  const skipped = [];
  const unique = [];
  for (const a of accounts) {
    if (seen.has(a.ClientSecret)) {
      skipped.push({ account: a, reason: "duplicate in the pasted list" });
    } else {
      seen.add(a.ClientSecret);
      unique.push(a);
    }
  }
  if (!unique.length) return { kept: [], skipped };

  // A BotAccount doc can exist with no active placement — e.g. pulled out by
  // the bad-tokens purge, or un-claimed when its bot was deleted (see the
  // DELETE /bot-configs/file/:file route) — so only a non-empty configFile
  // counts as "still assigned to a bot," not merely "known to the index."
  const secrets = unique.map((a) => a.ClientSecret);
  // Cross-check BOTH inventories: an operator paste must not grab a token that
  // is already live on a renter's bot (RenterAccount), and vice-versa the
  // renter approve path (which calls this same helper) must not grab one that
  // is already on an operator bot — so no Twitch account is ever double-farmed.
  const [existing, existingRenter] = await Promise.all([
    BotAccount.find(
      { clientSecret: { $in: secrets }, configFile: { $nin: ["", null] } },
      { clientSecret: 1, host: 1, configFile: 1, login: 1 },
    ).lean(),
    RenterAccount.find(
      { clientSecret: { $in: secrets }, configFile: { $nin: ["", null] } },
      { clientSecret: 1, host: 1, configFile: 1, login: 1 },
    ).lean(),
  ]);
  const bySecret = new Map(existing.map((e) => [e.clientSecret, e]));
  // BotAccount matches win the "assigned to" message if a token somehow appears
  // in both; either way the token is blocked.
  for (const e of existingRenter) {
    if (!bySecret.has(e.clientSecret)) {
      bySecret.set(e.clientSecret, { ...e, rented: true });
    }
  }

  const kept = [];
  for (const a of unique) {
    const ex = bySecret.get(a.ClientSecret);
    if (ex) {
      skipped.push({
        account: a,
        reason:
          "already assigned to " +
          (ex.login || "an account") +
          " in " +
          ex.configFile +
          " on " +
          ex.host +
          (ex.rented ? " (a rented bot)" : ""),
      });
    } else {
      kept.push(a);
    }
  }
  return { kept, skipped };
}

// Keep the cross-host BotAccount index current the moment accounts are
// written, instead of only after a manual "Sync from bots" — so the very
// next paste (to this bot or another) sees them as already claimed.
async function upsertBotAccounts(accounts, host, file) {
  if (!accounts.length) return;
  const ops = accounts.map((u) => ({
    updateOne: {
      filter: { clientSecret: u.ClientSecret },
      update: {
        $set: {
          login: u.Login || "",
          twitchId: u.Id == null ? "" : String(u.Id),
          uniqueId: u.UniqueId || "",
          configFile: file,
          container: containerForFile(file),
          host: host.id,
          enabled: u.Enabled !== false,
        },
      },
      upsert: true,
    },
  }));
  await BotAccount.bulkWrite(ops, { ordered: false }).catch(() => {});
}

// Refuse to start a bot with no accounts — see stopIfNoAccounts in
// utils/botHosts.js for why: TwitchDropsBot retries a login prompt in a
// tight, unthrottled loop when its config has zero users, which has taken
// down a production host (disk + CPU) before. Fails open (allows the start)
// if the config can't be read, since that's a different, more visible error
// the operator will hit immediately anyway.
async function hasAccounts(host, file) {
  let data;
  try {
    data = JSON.parse(await hosts.readFile(host, file));
  } catch {
    return true;
  }
  const users = (data.TwitchSettings && data.TwitchSettings.TwitchUsers) || [];
  return users.length > 0;
}

const NO_ACCOUNTS_MESSAGE =
  "This bot has no accounts — starting it would trigger a known " +
  "TwitchDropsBot bug (infinite login-retry loop with no backoff) that " +
  "floods logs and pegs CPU. Add accounts first.";

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
    // Caps each container's own stdout/stderr log (separate from the app's
    // internal log files under ./logs) so a bot stuck retrying in a tight
    // loop — e.g. TwitchDropsBot's known infinite-retry bug when a config
    // has zero accounts — can never fill the disk on its own. Baked in here
    // (rather than only as a host-level Docker daemon default) so a fresh
    // server gets this automatically the moment a bot is created through
    // the app, with no separate manual setup step.
    logging: {
      driver: "json-file",
      options: { "max-size": "10m", "max-file": "3" },
    },
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

// AGGREGATE every bot across every host into one view (the "All bots" tab).
// For reachable hosts we read live + refresh the server-side snapshot and parse
// what each running container is farming. For an offline host we fall back to
// the last-known snapshot so its bots still appear (so the data is never lost
// even if the Pi is down). Always 200: per-host errors are reported inline.
router.get("/bot-configs/all", requireSuperadmin, async (req, res) => {
  const out = [];
  const rented = await getRentedConfigSet();
  let rentedCount = 0;
  for (const meta of hosts.listHosts()) {
    const host = hosts.resolveHost(meta.id);
    const entry = {
      id: meta.id,
      label: meta.label,
      transport: meta.transport,
      online: true,
      bots: [],
    };
    let states = {};
    try {
      states = await hosts.dockerPs(host);
    } catch (e) {
      if (e.unreachable) entry.online = false;
    }
    let files = null;
    try {
      files = (await hosts.readdir(host)).filter((f) => FILE_RE.test(f)).sort();
    } catch {
      entry.online = false;
    }

    if (files) {
      for (const file of files) {
        // Renter bots live in the Renting section, not the operator's Bots page.
        if (rented.has(meta.id + "|" + file)) {
          rentedCount++;
          continue;
        }
        try {
          const raw = await hosts.readFile(host, file);
          // Keep a server-side copy so an offline host (or emergency move)
          // still has this bot's accounts/tokens.
          hosts.saveSnapshot(meta.id, file, raw).catch(() => {});
          const data = JSON.parse(raw);
          const sum = summarize(file, data);
          const st = states[sum.container];
          const running = !!(st && /^running/i.test(st.state || ""));
          let farming = null;
          if (running) {
            try {
              farming = await hosts.farmingStatus(host, sum.container);
            } catch {
              /* best effort */
            }
          }
          entry.bots.push({
            ...sum,
            source: "live",
            state: st ? st.state : null,
            status: st ? st.status : null,
            running,
            farming,
          });
        } catch {
          /* skip unreadable file */
        }
      }
    } else {
      // Offline: reconstruct from the last-known snapshots.
      const snaps = (await hosts.listSnapshot(meta.id).catch(() => []))
        .filter((f) => FILE_RE.test(f))
        .sort();
      for (const file of snaps) {
        if (rented.has(meta.id + "|" + file)) {
          rentedCount++;
          continue;
        }
        try {
          const data = JSON.parse(await hosts.readSnapshot(meta.id, file));
          entry.bots.push({
            ...summarize(file, data),
            source: "snapshot",
            running: false,
            farming: null,
          });
        } catch {
          /* skip */
        }
      }
    }
    out.push(entry);
  }
  res.json({ success: true, hosts: out, rentedCount });
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
    const rented = await getRentedConfigSet();
    const configs = files
      .filter((f) => FILE_RE.test(f) && !rented.has(host.id + "|" + f))
      .sort();
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
    const container = containerForFile(req.params.file);
    let stoppedEmpty = false;
    if (container) {
      const r = await hosts.stopIfNoAccounts(host, req.params.file, container);
      stoppedEmpty = r.stopped;
    }
    res.json({ success: true, stoppedEmpty });
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
      if (!(await hasAccounts(host, req.params.file))) {
        return res
          .status(400)
          .json({ success: false, message: NO_ACCOUNTS_MESSAGE });
      }
      const output = await hosts.dockerContainer(host, "restart", container);
      await hosts.restoreRestartPolicy(host, container);
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

    // Native (non-Docker) hosts have no compose file — botctl discovers bots
    // straight from the config files, so there's nothing to register.
    const composeFile = await hosts.composeName(host);
    if (!composeFile && host.runtime !== "native") {
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
    const parsed = parseAccounts(body.accounts, defaultGames);
    const { kept: accounts, skipped } = await dedupeAccounts(parsed);
    data.TwitchSettings.TwitchUsers = accounts;
    if (data.KickSettings && typeof data.KickSettings === "object") {
      data.KickSettings.KickUsers = [];
    }

    await hosts.writeFileAtomic(host, slot.file, JSON.stringify(data, null, 2));
    await upsertBotAccounts(accounts, host, slot.file);

    // Register the compose service (read -> edit YAML -> write back).
    try {
      if (composeFile) {
        const raw = await hosts.composeRead(host, composeFile);
        const edited = addServiceToComposeText(raw, slot.container, slot.file);
        if (!edited.exists) {
          await hosts.composeWrite(host, composeFile, edited.text);
        }
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
      skippedDuplicates: skipped.map((s) => ({
        login: s.account.Login,
        reason: s.reason,
      })),
    };

    if (!startRunning || !accounts.length) {
      return res.json(
        Object.assign(
          {
            started: false,
            warning: !startRunning ? undefined : NO_ACCOUNTS_MESSAGE,
          },
          base,
        ),
      );
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

// Server-side record of where bots have been moved to, so repeating a move is
// idempotent (it re-uses the same target slot instead of piling up copies).
// Shape: { "<toHostId>": { "<fromHostId>:<file>": "<targetFile>" } }
async function readMoves() {
  const t = await hosts.readMeta("moves.json").catch(() => null);
  if (!t) return {};
  try {
    return JSON.parse(t) || {};
  } catch {
    return {};
  }
}
async function recordMove(toHostId, marker, targetFile) {
  const m = await readMoves();
  m[toHostId] = m[toHostId] || {};
  m[toHostId][marker] = targetFile;
  await hosts.writeMeta("moves.json", JSON.stringify(m, null, 2)).catch(() => {});
}

// EMERGENCY MOVE / SWITCH a bot from one host to another (e.g. Raspberry Pi ->
// server if the Pi dies). The source's accounts/tokens come from a live read
// when reachable, otherwise from the last-known server snapshot. To guarantee
// the same accounts never farm on two machines at once, the source container
// is STOPPED first whenever the source host is reachable.
router.post("/bot-configs/move", requireSuperadmin, async (req, res) => {
  const body = req.body || {};
  const fromHost = hosts.resolveHost(body.fromHost || "");
  const toHost = hosts.resolveHost(
    body.toHost === undefined ? "local" : body.toHost,
  );
  if (!fromHost || !toHost) return badHost(res);
  if (fromHost.id === toHost.id) {
    return res
      .status(400)
      .json({ success: false, message: "Source and target host are the same" });
  }
  const file = body.file;
  if (!validFile(file)) {
    return res.status(400).json({ success: false, message: "Invalid file" });
  }
  const start = body.start !== false; // default true
  if (!ALLOW_RESTART && start) {
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
      message: "js-yaml is not installed. Run `npm install` and restart.",
    });
  }

  // 1. Get the source config: prefer a fresh live read, fall back to snapshot.
  let raw = null;
  let sourceOnline = true;
  try {
    raw = await hosts.readFile(fromHost, file);
    hosts.saveSnapshot(fromHost.id, file, raw).catch(() => {});
  } catch (e) {
    if (e.unreachable) {
      sourceOnline = false;
      raw = await hosts.readSnapshot(fromHost.id, file).catch(() => null);
    } else if (e.code === "ENOENT") {
      return res
        .status(404)
        .json({ success: false, message: "Config not found on source host" });
    } else {
      return res.status(500).json({
        success: false,
        message: "Could not read source config: " + (e.code || e.message),
      });
    }
  }
  if (raw == null) {
    return res.status(404).json({
      success: false,
      message:
        fromHost.label +
        " is offline and no saved copy exists yet. Open the All bots tab while it's online at least once, then try again.",
    });
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return res
      .status(422)
      .json({ success: false, message: "Source config is not valid JSON" });
  }

  // 2. Never double-farm: stop it on the source first (best effort; skipped if
  //    the source is already offline/down).
  const srcContainer = containerForFile(file);
  if (sourceOnline && srcContainer) {
    try {
      await hosts.dockerContainer(fromHost, "stop", srcContainer);
    } catch {
      /* best effort — proceed with the move regardless */
    }
  }

  // 3. Pick the target slot: re-use a previous move target if one exists
  //    (idempotent), else allocate the next free slot on the target host.
  let targetFiles;
  try {
    targetFiles = await hosts.readdir(toHost);
  } catch (e) {
    return res.status(e.unreachable ? 502 : 500).json({
      success: false,
      offline: !!e.unreachable,
      message: hostErrorMessage(toHost, e),
    });
  }
  const composeFile = await hosts.composeName(toHost);
  if (!composeFile && toHost.runtime !== "native") {
    return res.status(500).json({
      success: false,
      message: "No docker compose file found on " + toHost.label,
    });
  }
  const marker = fromHost.id + ":" + file;
  const moves = await readMoves();
  const prev = moves[toHost.id] && moves[toHost.id][marker];
  let slot;
  if (prev && targetFiles.includes(prev) && containerForFile(prev)) {
    slot = { file: prev, container: containerForFile(prev) };
  } else {
    slot = findNextSlot(targetFiles);
  }

  // 4. Write the config (accounts kept!) and register the compose service.
  try {
    await hosts.writeFileAtomic(toHost, slot.file, JSON.stringify(data, null, 2));
    if (composeFile) {
      const rawc = await hosts.composeRead(toHost, composeFile);
      const edited = addServiceToComposeText(rawc, slot.container, slot.file);
      if (!edited.exists) {
        await hosts.composeWrite(toHost, composeFile, edited.text);
      }
    }
  } catch (e) {
    return res.status(e.unreachable ? 502 : 500).json({
      success: false,
      offline: !!e.unreachable,
      message: "Failed to write bot on target: " + hostErrorMessage(toHost, e),
    });
  }
  await recordMove(toHost.id, marker, slot.file);

  const base = {
    success: true,
    fromHost: fromHost.id,
    toHost: toHost.id,
    sourceOnline,
    sourceStopped: sourceOnline && !!srcContainer,
    file: slot.file,
    container: slot.container,
    accountCount: summarize(file, data).accountCount,
  };
  if (!start || !base.accountCount) {
    return res.json(
      Object.assign(
        { started: false, warning: start ? NO_ACCOUNTS_MESSAGE : undefined },
        base,
      ),
    );
  }
  try {
    const output = await hosts.composeUp(toHost, slot.container);
    res.json(Object.assign({ started: true, output }, base));
  } catch (e) {
    res.status(207).json(
      Object.assign(
        {
          started: false,
          warning:
            "Moved, but starting it on " +
            toHost.label +
            " failed: " +
            hostErrorMessage(toHost, e),
        },
        base,
      ),
    );
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
    const parsed = parseAccounts(req.body && req.body.accounts, defaultGames);
    if (!parsed.length) {
      return res
        .status(400)
        .json({ success: false, message: "No valid accounts found in input" });
    }
    const { kept: accounts, skipped } = await dedupeAccounts(parsed);
    const skippedDuplicates = skipped.map((s) => ({
      login: s.account.Login,
      reason: s.reason,
    }));
    if (!accounts.length) {
      return res.status(400).json({
        success: false,
        message:
          "No new accounts to add — all " +
          skipped.length +
          " were already assigned elsewhere",
        skippedDuplicates,
      });
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
      await upsertBotAccounts(accounts, host, req.params.file);

      const container = containerForFile(req.params.file);
      if (!wantRestart || !ALLOW_RESTART || !container) {
        return res.json({
          success: true,
          added: accounts.length,
          total,
          restarted: false,
          skippedDuplicates,
        });
      }
      let restarted = true;
      try {
        // Undoes stopIfNoAccounts's restart=no from an earlier empty-account
        // stop, if this bot had one — otherwise it'd stay unprotected
        // against crash/reboot recovery even though it has accounts again.
        await hosts.restoreRestartPolicy(host, container);
        await hosts.dockerContainer(host, "restart", container);
      } catch {
        restarted = false;
      }
      res.json({
        success: true,
        added: accounts.length,
        total,
        restarted,
        skippedDuplicates,
      });
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
    if (action === "start" && !(await hasAccounts(host, file))) {
      return res
        .status(400)
        .json({ success: false, message: NO_ACCOUNTS_MESSAGE });
    }
    const output = await hosts.dockerContainer(host, action, container);
    if (action === "start") {
      await hosts.restoreRestartPolicy(host, container);
    }
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
      // Archive the config first (same ordering as /bot-configs/create: do
      // the file op first, so a failure in the second step below has a live
      // config to roll back to instead of leaving the compose file already
      // edited but the config still live and un-archived).
      const archive = file + ".deleted-" + Date.now();
      await hosts.rename(host, file, archive);

      // Remove the compose service (best effort if a compose file exists).
      const composeFile = await hosts.composeName(host);
      if (composeFile) {
        try {
          const raw = await hosts.composeRead(host, composeFile);
          const edited = removeServiceFromComposeText(raw, container);
          if (edited.removed) {
            await hosts.composeWrite(host, composeFile, edited.text);
          }
        } catch (e) {
          // Roll back the archive so a failed compose edit doesn't leave the
          // container running with no compose entry pointing at it.
          try {
            await hosts.rename(host, archive, file);
          } catch {
            /* ignore */
          }
          return res.status(500).json({
            success: false,
            message: "Failed to update compose file: " + e.message,
          });
        }
      }

      // Force-remove the container (ignore "no such container").
      try {
        await hosts.dockerContainer(host, "rm", container);
      } catch {
        /* ignore */
      }

      // Un-claim these accounts in the cross-host index — otherwise they'd
      // stay stamped as belonging to this now-archived file forever, and the
      // duplicate check on a future paste would keep rejecting them as
      // "already assigned" to a bot that no longer exists.
      await BotAccount.updateMany(
        { host: host.id, configFile: file },
        { $set: { configFile: "", container: "" } },
      ).catch(() => {});

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

// ------------------------------------------------------------------
// Shared helpers reused by the renter system (routes/renterAdminRoutes.js).
// Keeping the write path here means renter-approved accounts land through the
// exact same parse/dedupe/write/index pipeline (and the same validFile /
// TwitchUsers layout) the operator's own "add accounts" endpoint uses.
// ------------------------------------------------------------------

// Append already-parsed TwitchUsers entries to a config file: read → push →
// atomic write → sync the BotAccount index. Enforces the FILE_RE boundary.
// Returns { added, total }. Callers should dedupe first (dedupeAccounts).
async function addAccountsToConfig(host, file, accounts) {
  if (!validFile(file)) throw new Error("Invalid config file");
  if (!Array.isArray(accounts) || !accounts.length) return { added: 0, total: 0 };
  const data = JSON.parse(await hosts.readFile(host, file));
  if (!data.TwitchSettings || typeof data.TwitchSettings !== "object") {
    data.TwitchSettings = {};
  }
  if (!Array.isArray(data.TwitchSettings.TwitchUsers)) {
    data.TwitchSettings.TwitchUsers = [];
  }
  data.TwitchSettings.TwitchUsers.push(...accounts);
  const total = data.TwitchSettings.TwitchUsers.length;
  await hosts.writeFileAtomic(host, file, JSON.stringify(data, null, 2));
  await upsertBotAccounts(accounts, host, file);
  return { added: accounts.length, total };
}

// Renter counterpart of upsertBotAccounts: keep the renter's OWN account
// inventory (RenterAccount) in sync the moment tokens are written to their bot
// config — never touching BotAccount, so renter tokens stay out of the
// operator's cross-host index and the Drops Archive. Stamped with the owning
// renter so the inventory is scoped to them.
async function upsertRenterAccounts(accounts, host, file, renterId) {
  if (!accounts.length) return;
  const ops = accounts.map((u) => ({
    updateOne: {
      filter: { clientSecret: u.ClientSecret },
      update: {
        $set: {
          renter: renterId,
          login: u.Login || "",
          twitchId: u.Id == null ? "" : String(u.Id),
          uniqueId: u.UniqueId || "",
          configFile: file,
          container: containerForFile(file),
          host: host.id,
          enabled: u.Enabled !== false,
        },
      },
      upsert: true,
    },
  }));
  await RenterAccount.bulkWrite(ops, { ordered: false }).catch(() => {});
}

// Renter counterpart of addAccountsToConfig: append already-parsed TwitchUsers
// entries to a renter's bot config (same read → push → atomic write path the
// operator uses) but sync the RenterAccount inventory instead of BotAccount.
// Callers should dedupe first (dedupeAccounts, which cross-checks both indexes).
async function addRenterAccountsToConfig(host, file, accounts, renterId) {
  if (!validFile(file)) throw new Error("Invalid config file");
  if (!Array.isArray(accounts) || !accounts.length) return { added: 0, total: 0 };
  const data = JSON.parse(await hosts.readFile(host, file));
  if (!data.TwitchSettings || typeof data.TwitchSettings !== "object") {
    data.TwitchSettings = {};
  }
  if (!Array.isArray(data.TwitchSettings.TwitchUsers)) {
    data.TwitchSettings.TwitchUsers = [];
  }
  data.TwitchSettings.TwitchUsers.push(...accounts);
  const total = data.TwitchSettings.TwitchUsers.length;
  await hosts.writeFileAtomic(host, file, JSON.stringify(data, null, 2));
  await upsertRenterAccounts(accounts, host, file, renterId);
  return { added: accounts.length, total };
}

// How many accounts a config currently holds (for renter quota accounting).
// Returns 0 for a missing/unreadable/absent config rather than throwing.
async function countConfigAccounts(host, file) {
  if (!validFile(file)) return 0;
  try {
    const data = JSON.parse(await hosts.readFile(host, file));
    const users =
      data && data.TwitchSettings && data.TwitchSettings.TwitchUsers;
    return Array.isArray(users) ? users.length : 0;
  } catch {
    return 0;
  }
}

// The config's "farming" game list (root FavouriteGames). Returns [] for a
// missing/unreadable config.
async function getConfigGames(host, file) {
  if (!validFile(file)) return [];
  try {
    const data = JSON.parse(await hosts.readFile(host, file));
    return Array.isArray(data.FavouriteGames)
      ? data.FavouriteGames.filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

// Set the config's farming games. Writes the root FavouriteGames (what the Bots
// UI shows as "Farming"), flips TwitchSettings.OnlyFavouriteGames on when a list
// is given (so ONLY those games are farmed), and mirrors the list onto every
// account's FavouriteGames so a per-account override can't silently ignore the
// change. Used by the renter's own "games to farm" control — the host/file are
// always the renter's, never client input.
async function setConfigGames(host, file, games) {
  if (!validFile(file)) throw new Error("Invalid config file");
  const list = parseGamesList(games).slice(0, 50).map((g) => g.slice(0, 100));
  const data = JSON.parse(await hosts.readFile(host, file));
  data.FavouriteGames = list;
  if (!data.TwitchSettings || typeof data.TwitchSettings !== "object") {
    data.TwitchSettings = {};
  }
  data.TwitchSettings.OnlyFavouriteGames = list.length > 0;
  const users = data.TwitchSettings.TwitchUsers;
  if (Array.isArray(users)) {
    for (const u of users) {
      if (u && typeof u === "object") u.FavouriteGames = list.slice();
    }
  }
  await hosts.writeFileAtomic(host, file, JSON.stringify(data, null, 2));
  return list;
}

// Read ONE account's FavouriteGames from a config, matched by ClientSecret.
// Returns [] for a missing/unreadable config or an account not found. Used by
// the renter's per-account "games to farm" control.
async function getAccountGames(host, file, clientSecret) {
  if (!validFile(file)) return [];
  try {
    const data = JSON.parse(await hosts.readFile(host, file));
    const users =
      (data.TwitchSettings && data.TwitchSettings.TwitchUsers) || [];
    const u = users.find((x) => x && x.ClientSecret === clientSecret);
    return u && Array.isArray(u.FavouriteGames)
      ? u.FavouriteGames.filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

// Set ONE account's FavouriteGames in a config, matched by ClientSecret (so a
// renter can tune a single account without touching the others). When a
// non-empty list is given, OnlyFavouriteGames is switched on so the favourites
// are actually honoured. Returns the saved list, or null when the account
// wasn't found in the config.
async function setAccountGames(host, file, clientSecret, games) {
  if (!validFile(file)) throw new Error("Invalid config file");
  const list = parseGamesList(games)
    .slice(0, 50)
    .map((g) => g.slice(0, 100));
  const data = JSON.parse(await hosts.readFile(host, file));
  if (!data.TwitchSettings || typeof data.TwitchSettings !== "object") {
    data.TwitchSettings = {};
  }
  const users = data.TwitchSettings.TwitchUsers;
  if (!Array.isArray(users)) return null;
  const u = users.find((x) => x && x.ClientSecret === clientSecret);
  if (!u) return null;
  u.FavouriteGames = list.slice();
  if (list.length) data.TwitchSettings.OnlyFavouriteGames = true;
  await hosts.writeFileAtomic(host, file, JSON.stringify(data, null, 2));
  return list;
}

// Restart the container backing a config (so a games change takes effect on a
// running bot). Best-effort; honours ALLOW_RESTART. No-op when the file has no
// container mapping.
async function restartConfigContainer(host, file) {
  if (!ALLOW_RESTART) return { restarted: false };
  const container = containerForFile(file);
  if (!container) return { restarted: false };
  await hosts.dockerContainer(host, "restart", container);
  await hosts.restoreRestartPolicy(host, container);
  return { restarted: true, container };
}

// Stop the container backing a config file (used when a renter is suspended or
// their lease ends, or when a renter stops their own bot). No-op-safe: unknown
// container or an offline host just throws, which the caller can ignore.
async function stopConfigContainer(host, file) {
  const container = containerForFile(file);
  if (!container) return { stopped: false };
  await hosts.dockerContainer(host, "stop", container);
  return { stopped: true, container };
}

// Start the container backing a config file, with the same guards the operator
// start route uses: restart control must be enabled, the file name must be
// valid, and the config must actually have accounts (an empty config makes
// TwitchDropsBot spin in a tight login-retry loop — see hasAccounts). Errors
// carry a `.code` ("disabled" / "no_accounts") so a caller (e.g. the renter
// start route) can turn them into the right status. Used by the renter's own
// start button — the host/file are always the renter's, never client input.
async function startConfigContainer(host, file) {
  if (!ALLOW_RESTART) {
    const e = new Error("Container control is disabled on this server");
    e.code = "disabled";
    throw e;
  }
  if (!validFile(file)) throw new Error("Invalid config file");
  const container = containerForFile(file);
  if (!container) throw new Error("No container mapped to this file");
  if (!(await hasAccounts(host, file))) {
    const e = new Error(NO_ACCOUNTS_MESSAGE);
    e.code = "no_accounts";
    throw e;
  }
  // On a docker host, make sure the container actually EXISTS before starting:
  // register the compose service if it's missing (cloning an existing service's
  // image, exactly like the create flow) and bring it up with compose — which
  // creates+starts it. This lets a renter be assigned a config slot that was
  // never provisioned and still have "start" work, instead of failing with
  // "No such container: twitchbotxNN". Only the missing service is ever added,
  // so running bots are untouched. Native hosts (botctl) discover configs on
  // their own, so they just start.
  if (host.runtime !== "native") {
    const composeFile = await hosts.composeName(host);
    if (composeFile) {
      const raw = await hosts.composeRead(host, composeFile);
      const edited = addServiceToComposeText(raw, container, file);
      if (!edited.exists) {
        await hosts.composeWrite(host, composeFile, edited.text);
      }
    }
    const output = await hosts.composeUp(host, container);
    await hosts.restoreRestartPolicy(host, container);
    return { started: true, container, output };
  }
  const output = await hosts.dockerContainer(host, "start", container);
  await hosts.restoreRestartPolicy(host, container);
  return { started: true, container, output };
}

// Provision a brand-new EMPTY bot config slot on a host for the renter system:
// allocate the next slot, clone a template's settings (WITHOUT its accounts),
// and register a compose service — but do NOT start it (a renter bot starts on
// approval, once it actually has accounts). Returns { host, file, container }.
// Mirrors the operator create route's core so renter bots are provisioned the
// exact same way; kept as a shared helper so routes/renterAdminRoutes.js can
// create bots from within the Renting section instead of borrowing an operator
// config. Throws on failure (host offline, no compose file, no template).
async function provisionEmptyConfig(host) {
  try {
    require("js-yaml");
  } catch {
    throw new Error(
      "js-yaml is not installed. Run `npm install` in the nodeserver directory and restart.",
    );
  }
  const files = await hosts.readdir(host);
  const composeFile = await hosts.composeName(host);
  if (!composeFile && host.runtime !== "native") {
    throw new Error("No docker compose file found in " + host.dir);
  }
  const slot = findNextSlot(files);
  if (await hosts.exists(host, slot.file)) {
    throw new Error("Target config already exists: " + slot.file);
  }
  const templateName = pickDefaultTemplate(files);
  if (!templateName) {
    throw new Error("No template config available to clone from");
  }
  let data;
  try {
    data = JSON.parse(await hosts.readFile(host, templateName));
  } catch {
    throw new Error("Template config is not valid JSON");
  }
  if (!data.TwitchSettings || typeof data.TwitchSettings !== "object") {
    data.TwitchSettings = {};
  }
  data.TwitchSettings.TwitchUsers = [];
  if (data.KickSettings && typeof data.KickSettings === "object") {
    data.KickSettings.KickUsers = [];
  }
  await hosts.writeFileAtomic(host, slot.file, JSON.stringify(data, null, 2));
  try {
    if (composeFile) {
      const raw = await hosts.composeRead(host, composeFile);
      const edited = addServiceToComposeText(raw, slot.container, slot.file);
      if (!edited.exists) {
        await hosts.composeWrite(host, composeFile, edited.text);
      }
    }
  } catch (e) {
    // Roll back the config so a failed compose edit doesn't orphan a config.
    try {
      await hosts.rename(host, slot.file, slot.file + ".rollback-" + Date.now());
    } catch {
      /* ignore */
    }
    throw new Error("Failed to update compose file: " + e.message);
  }
  return { host: host.id, file: slot.file, container: slot.container };
}

module.exports = router;
module.exports.parseAccounts = parseAccounts;
module.exports.parseGamesList = parseGamesList;
module.exports.dedupeAccounts = dedupeAccounts;
module.exports.validFile = validFile;
module.exports.containerForFile = containerForFile;
module.exports.addAccountsToConfig = addAccountsToConfig;
module.exports.addRenterAccountsToConfig = addRenterAccountsToConfig;
module.exports.provisionEmptyConfig = provisionEmptyConfig;
module.exports.countConfigAccounts = countConfigAccounts;
module.exports.getConfigGames = getConfigGames;
module.exports.setConfigGames = setConfigGames;
module.exports.getAccountGames = getAccountGames;
module.exports.setAccountGames = setAccountGames;
module.exports.stopConfigContainer = stopConfigContainer;
module.exports.startConfigContainer = startConfigContainer;
module.exports.restartConfigContainer = restartConfigContainer;
