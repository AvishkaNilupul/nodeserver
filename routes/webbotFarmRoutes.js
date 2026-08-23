// ---------------------------------------------------------------------------
// Standalone WEB-TOKEN FARM console.
//
// A sandboxed system for the web-client-OAuth drop farmer (the `webbot-drops`
// project), completely apart from the Android-token BotAccount rig, the
// auto-farmer, the scanner, listings and the Drop Archive. Structured like the
// no-claim console:
//
//   * ACCOUNTS live in the standalone `WebBotAccount` Mongo model — seeded from
//     user:pass:token lines or pulled from the shared pool. This collection is
//     the account registry; nothing else on the site touches it.
//   * BOTS run on the Pi as isolated Docker containers (one per bot), farming a
//     group of accounts on one game via the vendored `webbot-farmer` image
//     (`--bot-config`). Each bot is provisioned into a DEDICATED Pi directory
//     (BASE), never the managed bot dir, and reads only its own config file.
//   * The Pi container is FARM-ONLY and never writes to Mongo, so live progress
//     is read on demand by querying Twitch directly (per-bot Drops), exactly
//     like the no-claim console reads live inventory.
//
// Superadmin-only. Nothing here creates listings or spends the shared pool
// beyond the reserve-guarded pull.
// ---------------------------------------------------------------------------
const express = require("express");
const path = require("path");
const { execFileSync } = require("child_process");

const { requireSuperadmin } = require("../middleware/auth");
const hosts = require("../utils/botHosts");
const settings = require("../utils/settings");
const WebBotAccount = require("../models/WebBotAccount");
const AvailableAccount = require("../models/AvailableAccount");
const { encrypt } = require("../utils/secretBox");
const { recordPoolUsage } = require("../utils/poolUsageLog");
const webbotTwitch = require("../utils/webbotTwitch");

const router = express.Router();

// --- Pi sandbox constants (isolated from the real bot dir) -------------------
const HOST_ID = "pi";
const BASE = "/home/avishka/webbot-drops-farm";
const SRC_DIR = BASE + "/src"; // vendored webbot-farmer (Dockerfile + src/)
const BOTS_DIR = BASE + "/bots"; // bots/<id>/config.json
const IMAGE = "webbot-drops-farm:latest";
const CONTAINER_PREFIX = "webbot-bot-";
const POOL_NOTE = "webbot-farm";
const FARMER_SRC_DIR = path.join(__dirname, "..", "webbot-farmer");

function pi() {
  const host = hosts.resolveHost(HOST_ID);
  if (!host) {
    const e = new Error(`Pi host "${HOST_ID}" is not configured.`);
    e.status = 503;
    throw e;
  }
  return host;
}

async function sh(script, { timeout = 30000, input } = {}) {
  try {
    const { stdout } = await hosts.runShell(pi(), script, { timeout, input });
    return (stdout || "").trim();
  } catch (err) {
    if (err && err.unreachable) {
      const e = new Error("Raspberry Pi is unreachable over SSH.");
      e.status = 503;
      throw e;
    }
    throw err;
  }
}

const containerFor = (id) => CONTAINER_PREFIX + id;
const botDir = (id) => BOTS_DIR + "/" + id;
const configPath = (id) => botDir(id) + "/config.json";
const stagingPath = (id) => BASE + "/staging/" + id + ".json";
const tail = (t) => (t ? String(t).slice(-6) : "");

// Ship the vendored farmer source (Dockerfile + package.json + src/) to the Pi
// so the image can be built there. Small (~80 KB); tar'd on this host and piped
// base64 over the SSH transport.
async function ensureSourceOnPi() {
  const tarB64 = execFileSync(
    "tar",
    ["czf", "-", "--exclude", "._*", "--exclude", ".DS_Store", "-C", FARMER_SRC_DIR, "."],
    { maxBuffer: 32 * 1024 * 1024 },
  ).toString("base64");
  await sh(
    `rm -rf ${hosts.shq(SRC_DIR)} && mkdir -p ${hosts.shq(SRC_DIR)} && base64 -d | tar xzf - -C ${hosts.shq(SRC_DIR)}`,
    { timeout: 60000, input: tarB64 },
  );
}

function readyPoolQuery() {
  return {
    status: "available",
    clientSecret: { $gt: "" },
    lastCheckStatus: { $in: ["", "ok"] },
  };
}

// Safe DTO — never leaks the full web token or the stored password.
function toDTO(a) {
  return {
    id: String(a._id),
    login: a.login || "",
    twitchId: a.twitchId || "",
    tokenTail: tail(a.webToken),
    credUsername: a.credUsername || "",
    hasPassword: !!a.hasPassword,
    enabled: a.enabled !== false,
    lastStatus: a.lastStatus || "pending",
    lastStatusMessage: a.lastStatusMessage || "",
    currentGame: a.currentGame || "",
    currentChannel: a.currentChannel || "",
    currentMinutes: a.currentMinutes || 0,
    requiredMinutes: a.requiredMinutes || 0,
    totalMinutesWatched: a.totalMinutesWatched || 0,
    dropsClaimed: a.dropsClaimed || 0,
    claimBlocked: !!a.claimBlocked,
    dropsReadyUnclaimed: a.dropsReadyUnclaimed || 0,
    fromPool: !!a.fromPool,
    pinnedGame: a.pinnedGame || "",
    botId: a.botId || "",
    lastCheckedAt: a.lastCheckedAt || null,
    createdAt: a.createdAt || null,
  };
}

// ---------------------------------------------------------------------------
// State (Mongo only, fast): summary, idle-account count, and bots aggregated
// from account assignments. Container run-state comes from /bots-status.
// ---------------------------------------------------------------------------
router.get("/api/webbot-farm/state", requireSuperadmin, async (req, res) => {
  try {
    const rows = await WebBotAccount.find(
      {},
      { webToken: 0, credPasswordEnc: 0 },
    ).lean();
    let enabled = 0;
    let idle = 0;
    let dead = 0;
    let readyUnclaimed = 0;
    let claimBlocked = 0;
    const byStatus = {};
    const botMap = new Map();
    for (const a of rows) {
      byStatus[a.lastStatus] = (byStatus[a.lastStatus] || 0) + 1;
      if (a.enabled !== false) enabled++;
      if (a.lastStatus === "dead") dead++;
      readyUnclaimed += a.dropsReadyUnclaimed || 0;
      if (a.claimBlocked) claimBlocked++;
      const bid = a.botId || "";
      if (!bid) {
        if (a.enabled !== false && a.lastStatus !== "dead") idle++;
        continue;
      }
      let b = botMap.get(bid);
      if (!b) {
        b = { id: bid, game: a.pinnedGame || a.currentGame || "", count: 0, dead: 0 };
        botMap.set(bid, b);
      }
      b.count++;
      if (a.lastStatus === "dead") b.dead++;
    }
    const bots = [...botMap.values()].sort(
      (x, y) => (parseInt(x.id, 10) || 0) - (parseInt(y.id, 10) || 0),
    );
    res.json({
      success: true,
      summary: {
        total: rows.length,
        enabled,
        idle,
        dead,
        readyUnclaimed,
        claimBlocked,
        bots: bots.length,
        byStatus,
      },
      bots,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Container run-state + image/provisioning (one Pi round trip).
// ---------------------------------------------------------------------------
router.get("/api/webbot-farm/bots-status", requireSuperadmin, async (req, res) => {
  try {
    const script =
      `prov=no; [ -f ${hosts.shq(BASE + "/.provisioning")} ] && prov=yes; echo "prov=$prov"; ` +
      `img=no; docker image inspect ${hosts.shq(IMAGE)} >/dev/null 2>&1 && img=yes; echo "img=$img"; ` +
      `echo PS_START; docker ps -a --filter name=^/${CONTAINER_PREFIX} --format '{{.Names}}|{{.State}}|{{.Status}}' 2>/dev/null; echo PS_END`;
    const out = await sh(script, { timeout: 25000 });
    const containers = {};
    let provisioning = false;
    let imageBuilt = false;
    let section = "";
    for (const raw of out.split("\n")) {
      const line = raw.trim();
      if (line === "PS_START") { section = "ps"; continue; }
      if (line === "PS_END") { section = ""; continue; }
      if (line.startsWith("prov=")) { provisioning = line.slice(5) === "yes"; continue; }
      if (line.startsWith("img=")) { imageBuilt = line.slice(4) === "yes"; continue; }
      if (section === "ps" && line) {
        const [name, state, status] = line.split("|");
        containers[name.replace(CONTAINER_PREFIX, "")] = { state, status, running: state === "running" };
      }
    }
    res.json({ success: true, provisioning, imageBuilt, containers });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Full account list (for the management table).
// ---------------------------------------------------------------------------
router.get("/api/webbot-farm/accounts", requireSuperadmin, async (req, res) => {
  try {
    const rows = await WebBotAccount.find({}).sort({ updatedAt: -1 }).lean();
    res.json({ success: true, accounts: rows.map(toDTO) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Pool availability (cheap count for the pull control).
// ---------------------------------------------------------------------------
router.get("/api/webbot-farm/pool", requireSuperadmin, async (req, res) => {
  try {
    const ready = await AvailableAccount.countDocuments(readyPoolQuery());
    const reserve = settings.getAutoFarm().poolReserve || 0;
    res.json({ success: true, ready, reserve, spendable: Math.max(0, ready - reserve) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Seed accounts from pasted lines (user:pass:token / user:token / token).
// ---------------------------------------------------------------------------
router.post("/api/webbot-farm/seed", requireSuperadmin, async (req, res) => {
  try {
    const text = String(req.body.text || "");
    const created = [];
    const skipped = [];
    let duplicate = 0;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const parts = line.split(":");
      let user = "";
      let pass = "";
      let token = "";
      if (parts.length >= 3) { user = parts[0]; pass = parts[1]; token = parts[2]; }
      else if (parts.length === 2) { user = parts[0]; token = parts[1]; }
      else { token = parts[0]; }
      token = (token || "").trim();
      if (!token || token.length < 20) { skipped.push({ reason: "bad token", line: line.slice(0, 40) }); continue; }
      const exists = await WebBotAccount.findOne({ webToken: token }).lean();
      if (exists) { duplicate++; continue; }
      await WebBotAccount.create({
        webToken: token,
        credUsername: user || "",
        credPasswordEnc: pass ? encrypt(pass) : "",
        hasPassword: !!pass,
        enabled: true,
        lastStatus: "pending",
      });
      created.push(tail(token));
    }
    res.json({ success: true, created: created.length, duplicate, skipped });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Pull N ready pool accounts into the test set (reserve-guarded; released on
// delete). The pool's clientSecret becomes the WebBotAccount webToken.
// ---------------------------------------------------------------------------
router.post("/api/webbot-farm/pull", requireSuperadmin, async (req, res) => {
  const claimed = [];
  try {
    const count = Math.max(1, Math.min(500, parseInt(req.body.count, 10) || 0));
    if (!count) return res.status(400).json({ success: false, message: "Account count required." });
    const reserve = settings.getAutoFarm().poolReserve || 0;
    const ready = await AvailableAccount.countDocuments(readyPoolQuery());
    if (ready - count < reserve) {
      return res.status(409).json({
        success: false,
        message: `Only ${Math.max(0, ready - reserve)} account(s) spendable (${ready} ready, reserve ${reserve}). Lower the count.`,
      });
    }
    for (let i = 0; i < count; i++) {
      const doc = await AvailableAccount.findOneAndUpdate(
        readyPoolQuery(),
        { $set: { status: "claimed", claimedAt: new Date(), claimedNote: POOL_NOTE } },
        { new: true, sort: { lastCheckAt: -1 } },
      );
      if (!doc) break;
      claimed.push(doc);
      await recordPoolUsage(doc._id, { event: "claimed", actor: "webbot", note: POOL_NOTE });
    }
    if (!claimed.length) return res.status(409).json({ success: false, message: "No ready pool accounts to claim." });
    let created = 0;
    let duplicate = 0;
    for (const a of claimed) {
      const token = a.clientSecret;
      const exists = await WebBotAccount.findOne({ webToken: token }).lean();
      if (exists) {
        await AvailableAccount.updateOne({ _id: a._id }, { $set: { status: "available", claimedAt: null, claimedNote: "" } });
        await recordPoolUsage(a._id, { event: "released", actor: "webbot" });
        duplicate++;
        continue;
      }
      await WebBotAccount.create({
        webToken: token,
        login: a.username || "",
        twitchId: a.twitchId || "",
        credUsername: a.username || "",
        credPasswordEnc: a.password || "",
        hasPassword: !!a.hasPassword,
        enabled: true,
        lastStatus: "pending",
        fromPool: true,
      });
      created++;
    }
    res.json({ success: true, created, duplicate, claimed: claimed.length });
  } catch (err) {
    if (claimed.length) {
      const stillClaimed = await AvailableAccount.find(
        { _id: { $in: claimed.map((d) => d._id) }, status: "claimed" },
        { _id: 1 },
      ).lean();
      const rolledBack = await AvailableAccount.updateMany(
        { _id: { $in: claimed.map((d) => d._id) } },
        { $set: { status: "available", claimedAt: null, claimedNote: "" } },
      ).catch(() => {});
      if (rolledBack && (rolledBack.modifiedCount || rolledBack.nModified)) {
        await recordPoolUsage(stillClaimed.map((d) => d._id), { event: "released", actor: "webbot" });
      }
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Create a bot: take N idle accounts, assign them a game, write the Pi config,
// build the image if needed, and run the container. Detached like no-claim.
// ---------------------------------------------------------------------------
router.post("/api/webbot-farm/bots", requireSuperadmin, async (req, res) => {
  let assignedIds = [];
  try {
    const game = String(req.body.game || "").trim();
    const count = Math.max(1, Math.min(200, parseInt(req.body.count, 10) || 0));
    if (!game) return res.status(400).json({ success: false, message: "Pick a game." });
    if (!count) return res.status(400).json({ success: false, message: "Account count required." });

    // Image + provisioning lock, and the highest Pi bot dir id — one round trip.
    const pre = await sh(
      `img=no; docker image inspect ${hosts.shq(IMAGE)} >/dev/null 2>&1 && img=yes; echo "img=$img"; ` +
        `[ -f ${hosts.shq(BASE + "/.provisioning")} ] && echo busy || echo free; ` +
        `echo IDS_START; ls -1 ${hosts.shq(BOTS_DIR)} 2>/dev/null || true; echo IDS_END`,
      { timeout: 20000 },
    );
    let imageBuilt = false;
    let busy = false;
    const piIds = [];
    let sect = "";
    for (const raw of pre.split("\n")) {
      const line = raw.trim();
      if (line === "IDS_START") { sect = "ids"; continue; }
      if (line === "IDS_END") { sect = ""; continue; }
      if (line.startsWith("img=")) { imageBuilt = line.slice(4) === "yes"; continue; }
      if (line === "busy") { busy = true; continue; }
      if (line === "free") continue;
      if (sect === "ids" && line) { const n = parseInt(line, 10); if (Number.isFinite(n)) piIds.push(n); }
    }
    if (busy) return res.status(409).json({ success: false, message: "A build/provision is already running. Try again shortly." });

    // Grab N idle, enabled, non-dead accounts.
    const picked = await WebBotAccount.find({
      enabled: true,
      botId: "",
      lastStatus: { $ne: "dead" },
      webToken: { $gt: "" },
    })
      .sort({ createdAt: 1 })
      .limit(count)
      .lean();
    if (!picked.length) {
      return res.status(409).json({ success: false, message: "No idle accounts. Seed or pull some first." });
    }

    // Next bot id: max of Mongo assignments and Pi dirs, +1.
    const mongoIds = await WebBotAccount.distinct("botId", { botId: { $ne: "" } });
    const usedNums = mongoIds.map((s) => parseInt(s, 10)).filter(Number.isFinite).concat(piIds);
    const id = String((usedNums.length ? Math.max(...usedNums) : 0) + 1);

    // Assign in Mongo first (rollback on any later failure).
    assignedIds = picked.map((p) => p._id);
    await WebBotAccount.updateMany(
      { _id: { $in: assignedIds } },
      {
        $set: {
          botId: id,
          pinnedGame: game,
          currentGame: game,
          lastStatus: "pending",
          lastStatusMessage: `assigned to bot ${id}`,
        },
      },
    );

    // Write the bot config to a STAGING file (secrets via stdin, never argv).
    // The detached provision copies it into the mount dir immediately before
    // `docker run` — so a slow image build can't leave a window where the mount
    // dir is empty (which would silently start a broken container).
    const config = JSON.stringify(
      {
        game,
        maxConcurrent: picked.length,
        accounts: picked.map((p) => ({ login: p.login || p.credUsername || "", webToken: p.webToken })),
      },
      null,
      2,
    );
    await sh(
      `mkdir -p ${hosts.shq(BASE + "/staging")} && cat > ${hosts.shq(stagingPath(id))} && chmod 600 ${hosts.shq(stagingPath(id))}`,
      { timeout: 20000, input: config },
    );

    // Ship the farmer source only if the image still needs building.
    if (!imageBuilt) await ensureSourceOnPi();

    // Provision (build if missing → place config → run) detached.
    const provision = [
      "set -e",
      `touch ${hosts.shq(BASE + "/.provisioning")}`,
      `echo "[$(date -u +%FT%TZ)] bot ${id}: ${picked.length} account(s), game=${game}"`,
      `if ! docker image inspect ${hosts.shq(IMAGE)} >/dev/null 2>&1; then cd ${hosts.shq(SRC_DIR)} && docker build -t ${hosts.shq(IMAGE)} .; fi`,
      `[ -s ${hosts.shq(stagingPath(id))} ] || { echo "staging config for bot ${id} missing"; exit 1; }`,
      `mkdir -p ${hosts.shq(botDir(id))} && cp ${hosts.shq(stagingPath(id))} ${hosts.shq(configPath(id))} && chmod 600 ${hosts.shq(configPath(id))}`,
      `docker rm -f ${hosts.shq(containerFor(id))} >/dev/null 2>&1 || true`,
      `docker run -d --name ${hosts.shq(containerFor(id))} --restart unless-stopped ` +
        `-v ${hosts.shq(botDir(id))}:/config:ro ${hosts.shq(IMAGE)}`,
      `rm -f ${hosts.shq(stagingPath(id))}`,
      `echo "[$(date -u +%FT%TZ)] bot ${id} started"`,
    ].join(" && ");
    const wrapped = `( { ${provision} ; } > ${hosts.shq(BASE + "/provision.log")} 2>&1; rm -f ${hosts.shq(BASE + "/.provisioning")} )`;
    await sh(`mkdir -p ${hosts.shq(BASE)}; setsid sh -c ${hosts.shq(wrapped)} >/dev/null 2>&1 < /dev/null &`, {
      timeout: 20000,
    });

    res.json({
      success: true,
      id,
      accounts: picked.length,
      message: `Bot ${id} created with ${picked.length} account(s). ${imageBuilt ? "Starting" : "Building image + starting"} on the Pi — watch the logs.`,
    });
  } catch (err) {
    if (assignedIds.length) {
      await WebBotAccount.updateMany(
        { _id: { $in: assignedIds } },
        { $set: { botId: "", pinnedGame: "", currentGame: "", lastStatus: "pending", lastStatusMessage: "" } },
      ).catch(() => {});
    }
    res.status(err.status || 500).json({ success: false, message: err.message || "Create failed" });
  }
});

const validId = (s) => /^[0-9]+$/.test(String(s || ""));

// ---------------------------------------------------------------------------
// Accounts in a bot.
// ---------------------------------------------------------------------------
router.get("/api/webbot-farm/bots/:id/accounts", requireSuperadmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    if (!validId(id)) return res.status(400).json({ success: false, message: "bad id" });
    const rows = await WebBotAccount.find({ botId: id }).sort({ createdAt: 1 }).lean();
    res.json({ success: true, game: rows[0] ? rows[0].pinnedGame || "" : "", accounts: rows.map(toDTO) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Live drops for a bot's accounts (direct web-token GQL, bounded fan-out).
// ---------------------------------------------------------------------------
router.get("/api/webbot-farm/bots/:id/drops", requireSuperadmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    if (!validId(id)) return res.status(400).json({ success: false, message: "bad id" });
    const rows = await WebBotAccount.find({ botId: id }).lean();
    if (!rows.length) return res.status(404).json({ success: false, message: "No such bot." });
    const CONCURRENCY = 5;
    const out = new Array(rows.length);
    let next = 0;
    async function worker() {
      while (next < rows.length) {
        const i = next++;
        const a = rows[i];
        try {
          const inv = await webbotTwitch.fetchInventory(a.webToken);
          out[i] = { login: a.login || tail(a.webToken), ok: true, drops: inv.drops };
        } catch (e) {
          out[i] = {
            login: a.login || tail(a.webToken),
            ok: false,
            error: e && e.code === "token_invalid" ? "token invalid" : e.message,
          };
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
    res.json({ success: true, accounts: out });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Container logs for one bot (+ provision log tail).
// ---------------------------------------------------------------------------
router.get("/api/webbot-farm/bots/:id/logs", requireSuperadmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    if (!validId(id)) return res.status(400).json({ success: false, message: "bad id" });
    const t = Math.max(20, Math.min(1000, parseInt(req.query.tail, 10) || 200));
    let container = "";
    try {
      container = await hosts.dockerLogs(pi(), containerFor(id), { tail: t });
    } catch (e) {
      container = "(no logs: " + (e.message || "") + ")";
    }
    const provision = await sh(
      `[ -f ${hosts.shq(BASE + "/provision.log")} ] && tail -n 60 ${hosts.shq(BASE + "/provision.log")} || true`,
      { timeout: 15000 },
    );
    res.json({ success: true, container, provision });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Stop / release a bot.
// ---------------------------------------------------------------------------
router.post("/api/webbot-farm/bots/:id/stop", requireSuperadmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    if (!validId(id)) return res.status(400).json({ success: false, message: "bad id" });
    await sh(`docker stop ${hosts.shq(containerFor(id))} 2>/dev/null || true`, { timeout: 25000 });
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.post("/api/webbot-farm/bots/:id/start", requireSuperadmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    if (!validId(id)) return res.status(400).json({ success: false, message: "bad id" });
    await sh(`docker start ${hosts.shq(containerFor(id))} 2>/dev/null || true`, { timeout: 25000 });
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// Release: stop+remove the container, delete its Pi config, and set its
// accounts back to idle (they stay in the registry, reusable for a new bot).
router.post("/api/webbot-farm/bots/:id/release", requireSuperadmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    if (!validId(id)) return res.status(400).json({ success: false, message: "bad id" });
    await sh(
      `docker rm -f ${hosts.shq(containerFor(id))} >/dev/null 2>&1 || true; ` +
        `rm -rf ${hosts.shq(botDir(id))}; rm -f ${hosts.shq(stagingPath(id))}`,
      { timeout: 25000 },
    );
    const r = await WebBotAccount.updateMany(
      { botId: id },
      { $set: { botId: "", pinnedGame: "", currentGame: "", currentChannel: "", lastStatus: "idle", lastStatusMessage: "" } },
    );
    res.json({ success: true, released: r.modifiedCount || 0 });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// Rebuild the farmer image on the Pi (after a farmer code change). Ships the
// current vendored source and rebuilds; existing containers keep running the
// old image until released + recreated.
router.post("/api/webbot-farm/rebuild", requireSuperadmin, async (req, res) => {
  try {
    const busy = await sh(`[ -f ${hosts.shq(BASE + "/.provisioning")} ] && echo busy || echo free`, { timeout: 15000 });
    if (busy === "busy") return res.status(409).json({ success: false, message: "A build is already running." });
    await ensureSourceOnPi();
    const script = [
      "set -e",
      `touch ${hosts.shq(BASE + "/.provisioning")}`,
      `cd ${hosts.shq(SRC_DIR)} && docker build -t ${hosts.shq(IMAGE)} .`,
      `echo "[$(date -u +%FT%TZ)] image rebuilt"`,
    ].join(" && ");
    const wrapped = `( { ${script} ; } > ${hosts.shq(BASE + "/provision.log")} 2>&1; rm -f ${hosts.shq(BASE + "/.provisioning")} )`;
    await sh(`mkdir -p ${hosts.shq(BASE)}; setsid sh -c ${hosts.shq(wrapped)} >/dev/null 2>&1 < /dev/null &`, { timeout: 20000 });
    res.json({ success: true, message: "Rebuilding the farmer image on the Pi — watch a bot's logs / provision log." });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Per-account operations (registry management).
// ---------------------------------------------------------------------------
async function findAccount(req, res) {
  const id = String(req.params.id || "");
  if (!/^[a-f0-9]{24}$/i.test(id)) { res.status(400).json({ success: false, message: "bad id" }); return null; }
  const doc = await WebBotAccount.findById(id);
  if (!doc) { res.status(404).json({ success: false, message: "No such account." }); return null; }
  return doc;
}

router.post("/api/webbot-farm/accounts/:id/validate", requireSuperadmin, async (req, res) => {
  try {
    const doc = await findAccount(req, res);
    if (!doc) return;
    try {
      const who = await webbotTwitch.validateToken(doc.webToken);
      doc.login = who.login || doc.login;
      doc.twitchId = who.twitchId || doc.twitchId;
      doc.lastCheckedAt = new Date();
      doc.lastStatusMessage = `token valid · ${who.login}${who.expiresIn ? ` · expires_in ${who.expiresIn}s` : " · no expiry"}`;
      if (doc.lastStatus === "dead" || doc.lastStatus === "pending") doc.lastStatus = "idle";
      await doc.save();
      res.json({ success: true, account: toDTO(doc) });
    } catch (e) {
      if (e.code === "token_invalid") {
        doc.lastStatus = "dead";
        doc.lastStatusMessage = "token invalid";
        doc.lastCheckedAt = new Date();
        await doc.save();
        return res.json({ success: true, account: toDTO(doc) });
      }
      throw e;
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/api/webbot-farm/accounts/:id/drops", requireSuperadmin, async (req, res) => {
  try {
    const doc = await findAccount(req, res);
    if (!doc) return;
    try {
      const inv = await webbotTwitch.fetchInventory(doc.webToken);
      res.json({ success: true, drops: inv.drops });
    } catch (e) {
      if (e.code === "token_invalid") {
        doc.lastStatus = "dead";
        doc.lastStatusMessage = "token invalid";
        doc.lastCheckedAt = new Date();
        await doc.save();
        return res.status(409).json({ success: false, message: "token invalid" });
      }
      throw e;
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/api/webbot-farm/accounts/:id/toggle", requireSuperadmin, async (req, res) => {
  try {
    const doc = await findAccount(req, res);
    if (!doc) return;
    doc.enabled = !doc.enabled;
    await doc.save();
    res.json({ success: true, account: toDTO(doc) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/api/webbot-farm/accounts/:id/clear-claimblock", requireSuperadmin, async (req, res) => {
  try {
    const doc = await findAccount(req, res);
    if (!doc) return;
    doc.claimBlocked = false;
    doc.dropsReadyUnclaimed = 0;
    await doc.save();
    res.json({ success: true, account: toDTO(doc) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete("/api/webbot-farm/accounts/:id", requireSuperadmin, async (req, res) => {
  try {
    const doc = await findAccount(req, res);
    if (!doc) return;
    if (doc.botId) {
      return res.status(409).json({ success: false, message: `In bot ${doc.botId} — release the bot first.` });
    }
    let released = false;
    if (doc.fromPool && doc.webToken) {
      const poolRow = await AvailableAccount.findOne(
        { clientSecret: doc.webToken, status: "claimed", claimedNote: POOL_NOTE },
        { _id: 1 },
      ).lean();
      const r = await AvailableAccount.updateOne(
        { clientSecret: doc.webToken, status: "claimed", claimedNote: POOL_NOTE },
        { $set: { status: "available", claimedAt: null, claimedNote: "" } },
      );
      released = (r.modifiedCount || 0) > 0;
      if (released && poolRow) await recordPoolUsage(poolRow._id, { event: "released", actor: "webbot" });
    }
    await doc.deleteOne();
    res.json({ success: true, released });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
