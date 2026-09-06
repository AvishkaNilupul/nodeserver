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
const UnclaimedAccount = require("../models/UnclaimedAccount");
const MarketplaceListing = require("../models/MarketplaceListing");
const { encrypt, decrypt } = require("../utils/secretBox");
const { recordPoolUsage } = require("../utils/poolUsageLog");
const { logEvent, actorFromReq } = require("../utils/systemLog");
const webbotTwitch = require("../utils/webbotTwitch");
const webbotFarmWatcher = require("../utils/webbotFarmWatcher");
const unclaimedAutoList = require("../utils/unclaimedAutoList");

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
// Markers the auto-power watcher (utils/webbotFarmWatcher.js) reads.
// `.autostopped` = the watcher parked this bot on a dark game (resume when
// live); `.operatoroff` = the operator hit Stop (stay off until Start/Create).
const markerPath = (id) => botDir(id) + "/.autostopped";
const operatorMarkerPath = (id) => botDir(id) + "/.operatoroff";
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
    // An account the operator handed to a buyer by hand is NOT supply: it must
    // never be claimed into a new bot, farmed again and re-listed, or the same
    // login goes out twice.
    manualSold: { $ne: true },
  };
}

// Superadmin-only DTO. Includes the full web token (client secret) and the
// decrypted password so the operator can re-use them off-site (e.g. claim
// drops in a real browser). Never sent to non-superadmin routes.
function toDTO(a) {
  return {
    id: String(a._id),
    login: a.login || "",
    twitchId: a.twitchId || "",
    webToken: a.webToken || "",
    password: decrypt(a.credPasswordEnc),
    tokenTail: tail(a.webToken),
    credUsername: a.credUsername || "",
    hasPassword: !!a.hasPassword,
    enabled: a.enabled !== false,
    manualSold: !!a.manualSold,
    listed: !!a.listed,
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
// ---------------------------------------------------------------------------
// Auto power (utils/webbotFarmWatcher.js): the live/dark gate that stops a bot's
// container when its pinned game has no live campaign and starts it when the
// game goes live. GET returns the master-switch state + the watcher's last pass;
// POST flips the switch (OFF by default). Mirrors /api/noclaim-farm/auto.
// ---------------------------------------------------------------------------
router.get("/api/webbot-farm/auto", requireSuperadmin, (req, res) => {
  res.json({
    success: true,
    enabled: !!settings.getAutoFarm().webbotStreamGate,
    watcher: webbotFarmWatcher.status(),
  });
});

router.post("/api/webbot-farm/auto", requireSuperadmin, async (req, res) => {
  try {
    const enabled = !!req.body.enabled;
    const saved = await settings.setAutoFarm({ webbotStreamGate: enabled });
    logEvent({
      category: "webbot",
      action: enabled ? "auto_power_on" : "auto_power_off",
      actor: actorFromReq(req),
    });
    res.json({ success: true, enabled: !!saved.webbotStreamGate });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

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
// Summarise a bot's `channels.json` (written per tick by the auto-power
// watcher — see docs/WEBBOT-ACL-CHANNELS-CONTRACT.md) for the bot card:
// `{updatedAt, error, campaigns:[{name, gated, liveCount, aclCount}]}`.
// Unparsable content → `{error:"unparsable", campaigns:[]}` so the page can
// still say something; a missing file is `null` (handled by the caller).
function summariseChannelsFile(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { updatedAt: null, error: "unparsable", campaigns: [] };
  }
  if (!doc || typeof doc !== "object") return { updatedAt: null, error: "unparsable", campaigns: [] };
  const campaigns = (Array.isArray(doc.campaigns) ? doc.campaigns : []).map((c) => {
    const acl = Array.isArray(c && c.acl) ? c.acl : null;
    const live = Array.isArray(c && c.live) ? c.live : [];
    return {
      name: String((c && c.name) || ""),
      endAt: (c && c.endAt) || null,
      gated: acl !== null,
      aclCount: acl ? acl.length : 0,
      liveCount: live.length,
    };
  });
  return {
    updatedAt: doc.updatedAt || null,
    game: doc.game || "",
    error: doc.error ? String(doc.error) : null,
    campaigns,
  };
}

// Heartbeat verdict fallback when the watcher's own `hbVerdict` is absent
// (mirrors the contract's `heartbeatVerdict`: progress → farming; no-session
// only → idle; all zero → starting; no heartbeat → unknown).
function hbVerdictFor(hb) {
  if (!hb || typeof hb !== "object") return "unknown";
  const progress = Number(hb.progress) || 0;
  const noSession = Number(hb.noSession) || 0;
  if (progress > 0) return "farming";
  if (noSession > 0) return "idle";
  return "starting";
}

// The watcher's per-bot heartbeat, read defensively: `status().heartbeat[id]`
// and/or `status().bots[].{hb,hbVerdict}`. Any shape the watcher does not yet
// expose degrades to `{hb:null, hbVerdict:"unknown"}`.
function watcherHeartbeats() {
  const out = {};
  let st = null;
  try {
    st = typeof webbotFarmWatcher.status === "function" ? webbotFarmWatcher.status() : null;
  } catch {
    st = null;
  }
  if (!st || typeof st !== "object") return out;
  const hbMap = st.heartbeat && typeof st.heartbeat === "object" ? st.heartbeat : {};
  for (const id of Object.keys(hbMap)) {
    const hb = hbMap[id] || null;
    out[String(id)] = { hb, hbVerdict: hbVerdictFor(hb) };
  }
  for (const b of Array.isArray(st.bots) ? st.bots : []) {
    if (!b || b.id == null) continue;
    const id = String(b.id);
    const cur = out[id] || { hb: null, hbVerdict: "unknown" };
    if (b.hb && typeof b.hb === "object") cur.hb = b.hb;
    if (typeof b.hbVerdict === "string" && b.hbVerdict) cur.hbVerdict = b.hbVerdict;
    else if (cur.hb) cur.hbVerdict = hbVerdictFor(cur.hb);
    out[id] = cur;
  }
  return out;
}

router.get("/api/webbot-farm/bots-status", requireSuperadmin, async (req, res) => {
  try {
    // One round trip: provisioning lock, image, `docker ps`, and every bot's
    // channels.json (the ACL/live-channel hint the watcher writes per tick).
    const script =
      `prov=no; [ -f ${hosts.shq(BASE + "/.provisioning")} ] && prov=yes; echo "prov=$prov"; ` +
      `img=no; docker image inspect ${hosts.shq(IMAGE)} >/dev/null 2>&1 && img=yes; echo "img=$img"; ` +
      `echo PS_START; docker ps -a --filter name=^/${CONTAINER_PREFIX} --format '{{.Names}}|{{.State}}|{{.Status}}' 2>/dev/null; echo PS_END; ` +
      `for d in ${hosts.shq(BOTS_DIR)}/*/; do [ -d "$d" ] || continue; bid=$(basename "$d"); ` +
      `if [ -f "$d/channels.json" ]; then echo "CH_START $bid"; cat "$d/channels.json" 2>/dev/null; echo; echo CH_END; fi; done`;
    const out = await sh(script, { timeout: 25000 });
    const containers = {};
    const channels = {};
    let provisioning = false;
    let imageBuilt = false;
    let section = "";
    let chId = "";
    let chBuf = [];
    for (const raw of out.split("\n")) {
      const line = raw.trim();
      if (section === "ch") {
        if (line === "CH_END") {
          channels[chId] = summariseChannelsFile(chBuf.join("\n"));
          section = ""; chId = ""; chBuf = [];
        } else {
          chBuf.push(raw);
        }
        continue;
      }
      if (line === "PS_START") { section = "ps"; continue; }
      if (line === "PS_END") { section = ""; continue; }
      if (line.startsWith("CH_START ")) { section = "ch"; chId = line.slice(9).trim(); chBuf = []; continue; }
      if (line.startsWith("prov=")) { provisioning = line.slice(5) === "yes"; continue; }
      if (line.startsWith("img=")) { imageBuilt = line.slice(4) === "yes"; continue; }
      if (section === "ps" && line) {
        const [name, state, status] = line.split("|");
        containers[name.replace(CONTAINER_PREFIX, "")] = { state, status, running: state === "running" };
      }
    }
    const heartbeats = watcherHeartbeats();
    for (const id of Object.keys(containers)) {
      const c = containers[id];
      const h = heartbeats[id] || { hb: null, hbVerdict: "unknown" };
      c.hb = h.hb;
      c.hbVerdict = h.hbVerdict;
      c.channels = channels[id] || null;
    }
    res.json({ success: true, provisioning, imageBuilt, containers, channels });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Paged account list (for the management table). Supports ?page=, ?pageSize=
// and ?q= (name/token search) so the table loads 20 at a time instead of the
// whole collection.
// ---------------------------------------------------------------------------
router.get("/api/webbot-farm/accounts", requireSuperadmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    const q = String(req.query.q || "").trim();
    const filter = {};
    if (q) {
      const rx = new RegExp(escapeRegExp(q), "i");
      filter.$or = [{ login: rx }, { credUsername: rx }, { webToken: rx }];
    }
    const total = await WebBotAccount.countDocuments(filter);
    const rows = await WebBotAccount.find(filter)
      .sort({ updatedAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean();
    res.json({
      success: true,
      accounts: rows.map(toDTO),
      total,
      page,
      pageSize,
      pages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

// Parse one supplier line into { user, pass, token }. The account format the
// feeder is built for is `user:pass:token` where the TOKEN is the web session
// token (the 30-char kimne… OAuth token) — so we treat the token as the LAST
// colon field and the password as everything between the first field and it.
// That keeps a password with a stray ":" from stealing the token slot. Also
// accepts `user:token` and a bare `token`.
function parseFeedLine(line) {
  const parts = line.split(":");
  if (parts.length >= 3) {
    return { user: parts[0].trim(), pass: parts.slice(1, -1).join(":"), token: parts[parts.length - 1].trim() };
  }
  if (parts.length === 2) {
    return { user: parts[0].trim(), pass: "", token: parts[1].trim() };
  }
  return { user: "", pass: "", token: parts[0].trim() };
}

// A web session token is a 30-ish char alphanumeric string. Reject anything
// with an "@" (an email footer line) or other punctuation so junk lines don't
// become dead accounts.
function looksLikeToken(t) {
  return /^[A-Za-z0-9]{20,60}$/.test(t || "");
}

// Validate an array of WebBotAccount docs against Twitch with bounded
// concurrency, writing login/twitchId/status back. Returns {checked, ok, dead}.
async function validateAccounts(docs, { concurrency = 8 } = {}) {
  let ok = 0;
  let dead = 0;
  let next = 0;
  async function worker() {
    while (next < docs.length) {
      const doc = docs[next++];
      try {
        const who = await webbotTwitch.validateToken(doc.webToken);
        doc.login = who.login || doc.login;
        doc.twitchId = who.twitchId || doc.twitchId;
        doc.lastStatus = "idle";
        doc.lastStatusMessage = `token valid · ${who.login}${who.expiresIn ? ` · expires_in ${who.expiresIn}s` : " · no expiry"}`;
        doc.lastCheckedAt = new Date();
        await doc.save();
        ok++;
      } catch (e) {
        if (e && e.code === "token_invalid") {
          doc.lastStatus = "dead";
          doc.lastStatusMessage = "token invalid";
          doc.lastCheckedAt = new Date();
          await doc.save();
          dead++;
        }
        // transient (network / non-401) errors leave the row "pending" for a retry
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, docs.length) }, worker));
  return { checked: docs.length, ok, dead };
}

// ---------------------------------------------------------------------------
// FEEDER — the primary intake for the web-token farm. Paste supplier lines in
// `user:pass:token` (or `user:token` / `token`) form; each becomes a row in the
// standalone WebBotAccount registry (this farm's OWN storage — it never spends
// or reads the shared AvailableAccount pool). Tokens are validated live on
// intake (bounded), so the bot creator only ever sees accounts known to be
// alive. Large pastes beyond `validateLimit` are stored "pending" and can be
// checked later with /validate-idle.
// ---------------------------------------------------------------------------
router.post("/api/webbot-farm/feed", requireSuperadmin, async (req, res) => {
  try {
    const text = String(req.body.text || "");
    const doValidate = req.body.validate !== false;
    const validateLimit = Math.max(0, Math.min(500, parseInt(req.body.validateLimit, 10) || 120));
    const skipped = [];
    let duplicate = 0;
    const createdDocs = [];
    const seenInPaste = new Set();
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const { user, pass, token } = parseFeedLine(line);
      if (!looksLikeToken(token)) {
        skipped.push({ reason: "no valid token", line: line.slice(0, 40) });
        continue;
      }
      if (seenInPaste.has(token)) { duplicate++; continue; }
      seenInPaste.add(token);
      const exists = await WebBotAccount.findOne({ webToken: token }, { _id: 1 }).lean();
      if (exists) { duplicate++; continue; }
      const doc = await WebBotAccount.create({
        webToken: token,
        credUsername: user || "",
        credPasswordEnc: pass ? encrypt(pass) : "",
        hasPassword: !!pass,
        enabled: true,
        lastStatus: "pending",
      });
      createdDocs.push(doc);
    }

    let validated = null;
    if (doValidate && createdDocs.length) {
      validated = await validateAccounts(createdDocs.slice(0, validateLimit));
    }
    if (createdDocs.length) {
      logEvent({
        category: "webbot",
        action: "accounts_fed",
        actor: actorFromReq(req),
        count: createdDocs.length,
        detail:
          "fed " +
          createdDocs.length +
          " account(s); " +
          duplicate +
          " dup, " +
          skipped +
          " skipped",
      });
    }
    res.json({
      success: true,
      fed: createdDocs.length,
      duplicate,
      skipped,
      validated, // {checked, ok, dead} or null
      pending: createdDocs.length - (validated ? validated.checked : 0),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Bulk-validate accounts still "pending" (fed but not yet checked, e.g. from a
// large paste). Bounded concurrency; caps at `limit` per call.
router.post("/api/webbot-farm/validate-idle", requireSuperadmin, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(1000, parseInt(req.body.limit, 10) || 200));
    const docs = await WebBotAccount.find({
      lastStatus: "pending",
      webToken: { $gt: "" },
    })
      .sort({ createdAt: 1 })
      .limit(limit);
    if (!docs.length) return res.json({ success: true, checked: 0, ok: 0, dead: 0 });
    const r = await validateAccounts(docs);
    res.json({ success: true, ...r });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Seed accounts from pasted lines (user:pass:token / user:token / token).
// Legacy fast intake (no validation) — the UI now uses /feed instead.
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

    // Accounts to assign: an EXPLICIT login list (exact accounts — e.g.
    // re-pinning a released set to a new game) when given, else N oldest idle.
    // Behaviour is unchanged when `logins` is absent.
    const wantLogins = Array.isArray(req.body.logins)
      ? req.body.logins.map((s) => String(s)).filter(Boolean)
      : null;
    const pickQuery = { enabled: true, botId: "", lastStatus: { $ne: "dead" }, webToken: { $gt: "" } };
    if (wantLogins && wantLogins.length) pickQuery.login = { $in: wantLogins };
    const picked = await WebBotAccount.find(pickQuery)
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
      // Fresh bot / re-pin = operator taking control: clear any stale auto-power
      // markers so the watcher manages it cleanly from here.
      `rm -f ${hosts.shq(markerPath(id))} ${hosts.shq(operatorMarkerPath(id))} 2>/dev/null || true`,
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

    logEvent({
      category: "webbot",
      action: "bot_created",
      actor: actorFromReq(req),
      subject: containerFor(id),
      game: game || "",
      count: picked.length,
      detail: "webbot " + id + " created with " + picked.length + " account(s)",
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
    // Mark it operator-off so the auto-power watcher won't cold-start it back on
    // the next live event — an explicit Stop stays stopped until Start/Create.
    await sh(
      `docker stop ${hosts.shq(containerFor(id))} 2>/dev/null || true; ` +
        `touch ${hosts.shq(operatorMarkerPath(id))} 2>/dev/null || true`,
      { timeout: 25000 },
    );
    logEvent({
      category: "webbot",
      action: "bot_stopped",
      actor: actorFromReq(req),
      subject: containerFor(id),
    });
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.post("/api/webbot-farm/bots/:id/start", requireSuperadmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    if (!validId(id)) return res.status(400).json({ success: false, message: "bad id" });
    // Clear both auto-power markers: a manual Start means the operator is taking
    // control, so the watcher manages this bot fresh from here (neither "parked
    // by me" nor "operator-off" applies once they start it themselves).
    await sh(
      `rm -f ${hosts.shq(markerPath(id))} ${hosts.shq(operatorMarkerPath(id))} 2>/dev/null || true; ` +
        `docker start ${hosts.shq(containerFor(id))} 2>/dev/null || true`,
      { timeout: 25000 },
    );
    logEvent({
      category: "webbot",
      action: "bot_started",
      actor: actorFromReq(req),
      subject: containerFor(id),
    });
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// Recreate: `docker rm -f` + the same `docker run` line /bots uses, so a bot
// picks up a rebuilt image (after /rebuild) without touching its config or
// accounts. Auto-power markers are PRESERVED: `.operatoroff` (operator Stop) or
// `.autostopped` (parked on a dark game) → the fresh container is stopped right
// after run, so a parked bot stays parked and the watcher wakes it as before.
router.post("/api/webbot-farm/bots/:id/recreate", requireSuperadmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    if (!validId(id)) return res.status(400).json({ success: false, message: "bad id" });
    const script = [
      `[ -f ${hosts.shq(BASE + "/.provisioning")} ] && { echo busy; exit 0; }`,
      `[ -s ${hosts.shq(configPath(id))} ] || { echo noconfig; exit 0; }`,
      `docker image inspect ${hosts.shq(IMAGE)} >/dev/null 2>&1 || { echo noimage; exit 0; }`,
      `park=no; [ -f ${hosts.shq(operatorMarkerPath(id))} ] && park=operator; [ -f ${hosts.shq(markerPath(id))} ] && park=auto`,
      `docker rm -f ${hosts.shq(containerFor(id))} >/dev/null 2>&1 || true`,
      `if docker run -d --name ${hosts.shq(containerFor(id))} --restart unless-stopped ` +
        `-v ${hosts.shq(botDir(id))}:/config:ro ${hosts.shq(IMAGE)} >/dev/null 2>${hosts.shq(BASE + "/recreate.err")}; ` +
        `then echo ran; else echo "runfail $(tr '\\n' ' ' < ${hosts.shq(BASE + "/recreate.err")})"; exit 0; fi`,
      `if [ "$park" != no ]; then docker stop ${hosts.shq(containerFor(id))} >/dev/null 2>&1 || true; echo "parked $park"; fi`,
    ].join("; ");
    const out = await sh(script, { timeout: 60000 });
    const lines = out.split("\n").map((s) => s.trim()).filter(Boolean);
    const first = lines[0] || "";
    if (first === "busy") return res.status(409).json({ success: false, message: "A build/provision is running — recreate after it finishes." });
    if (first === "noconfig") return res.status(404).json({ success: false, message: `Bot ${id} has no config on the Pi (released?).` });
    if (first === "noimage") return res.status(409).json({ success: false, message: "The farmer image is missing on the Pi — Rebuild image first." });
    if (first.startsWith("runfail")) {
      return res.status(500).json({ success: false, message: "docker run failed: " + (first.slice(8).trim() || "unknown error") });
    }
    const parkedLine = lines.find((l) => l.startsWith("parked ")) || "";
    const parked = parkedLine ? parkedLine.slice(7).trim() : "";
    logEvent({
      category: "webbot",
      action: "bot_recreated",
      actor: actorFromReq(req),
      subject: containerFor(id),
      detail:
        "webbot " + id + " container recreated on " + IMAGE +
        (parked ? " — kept stopped (" + (parked === "operator" ? ".operatoroff" : ".autostopped") + " marker)" : " — running"),
    });
    res.json({
      success: true,
      parked: parked || null,
      message: `Bot ${id} recreated on the current image` + (parked ? ` (kept stopped — ${parked === "operator" ? "operator Stop" : "parked by auto power"}).` : "."),
    });
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
    logEvent({
      category: "webbot",
      action: "bot_released",
      actor: actorFromReq(req),
      subject: containerFor(id),
      count: r.modifiedCount || 0,
      detail: "released " + (r.modifiedCount || 0) + " account(s) to idle",
    });
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

// Manual "sold" tick — the operator handed this account to a buyer BY HAND.
// The account keeps farming, but an account that went to a buyer must come off
// every listing that still offers it or the platform can hand the same login
// to a second buyer. So ticking sold also runs the unclaimed engine's
// manual-sold removal here (delist from every active row, park the ledger
// "removed", clear the listed tick) rather than waiting for the periodic
// auto-list pass to do the same sweep.
router.post("/api/webbot-farm/accounts/:id/manual-sold", requireSuperadmin, async (req, res) => {
  try {
    const doc = await findAccount(req, res);
    if (!doc) return;
    const sold = !!req.body.sold;
    doc.manualSold = sold;
    await doc.save();
    let removal = null;
    if (sold) {
      removal = await unclaimedAutoList
        .removeManualSoldOwner({
          webBotAccountId: String(doc._id),
          actor: actorFromReq(req) || "operator",
        })
        .catch((e) => ({ ledgers: 0, removed: 0, errors: [e.message] }));
      logEvent({
        category: "unclaimed",
        action: "manual_sold",
        actor: actorFromReq(req),
        subject: doc.login || String(doc._id),
        count: removal.removed || 0,
        detail:
          "manual-sold tick (web-token) — removed from " +
          (removal.removed || 0) +
          " listing ledger(s)",
      });
    }
    res.json({
      success: true,
      account: toDTO(doc),
      delisted: removal ? removal.removed : 0,
      delistErrors: removal ? removal.errors : [],
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Manual "listed" tick — memory only, so the operator can see at a glance
// which accounts are on sale. The account keeps farming; nothing else changes.
router.post("/api/webbot-farm/accounts/:id/listed", requireSuperadmin, async (req, res) => {
  try {
    const doc = await findAccount(req, res);
    if (!doc) return;
    doc.listed = !!req.body.listed;
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

// ---------------------------------------------------------------------------
// SELL-SIDE tooling (docs/UNCLAIMED-BUNDLES-CONTRACT.md, "Webbot routes").
//
// The web-token farm had only the per-row manual sold/listed ticks: no view of
// what is READY to sell, no spent (sold/connected) sweep, no bulk export. The
// routes below add exactly that, mirroring the no-claim console's spent
// scan/remove. Live inventory is truth (re-read on every scan, never stored
// as such); the only Mongo side effect of a scan is the per-row
// `dropsReadyUnclaimed` + `lastCheckedAt` refresh the page already shows.
//
// Bundle labels come from utils/unclaimedBundles.js (a sibling module being
// built against the same contract) — it is required LAZILY inside the handler
// and every failure degrades to bundleLabel "" so a missing/broken module can
// never take the scan down.
// ---------------------------------------------------------------------------

const SELL_SCAN_CONCURRENCY = 8;
const OBJECT_ID_RX = /^[a-f0-9]{24}$/i;

// ?botId= selector shared by the sellable + spent scans:
//   "<n>"  → that bot's accounts; "idle" → unassigned (botId ""); "all" / ""
//   → the whole registry. Returns null for an unparseable value.
function botSelector(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (!v || v === "all") return {};
  if (v === "idle") return { botId: "" };
  if (validId(v)) return { botId: v };
  return null;
}

// Body `accounts` → unique, well-formed WebBotAccount ids. Accepts plain id
// strings or `{ id }` objects (the spent table posts back what it scanned).
function idsFromBody(list) {
  const out = [];
  const seen = new Set();
  for (const a of Array.isArray(list) ? list : []) {
    const id = String((a && typeof a === "object" ? a.id || a._id : a) || "").trim();
    if (!OBJECT_ID_RX.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// Live inventory for one account with the dead-token bookkeeping the single
// /drops route does: a 401/auth GQL error flips the row "dead" so the next scan
// skips it. Returns { ok, drops, connected, tokenStatus }.
async function liveInventoryFor(a) {
  try {
    const inv = await webbotTwitch.fetchInventory(a.webToken);
    const drops = (inv && inv.drops) || [];
    return {
      ok: true,
      drops,
      connected: drops.some((d) => d.connected),
      tokenStatus: "ok",
      tokenError: "",
    };
  } catch (e) {
    const dead = !!(e && e.code === "token_invalid");
    if (dead) {
      await WebBotAccount.updateOne(
        { _id: a._id },
        { $set: { lastStatus: "dead", lastStatusMessage: "token invalid", lastCheckedAt: new Date() } },
      ).catch(() => {});
    }
    return {
      ok: false,
      drops: [],
      connected: false,
      tokenStatus: dead ? "token_invalid" : "error",
      tokenError: (e && e.message) || "error",
    };
  }
}

// One UnclaimedAccount ledger per WebBotAccount id: a LISTED ledger wins,
// otherwise the most recently touched one (so a sold/removed history still
// shows). Map<webBotAccountId, { status, market, soldAt }>.
async function ledgerByOwner(ids) {
  const out = new Map();
  if (!ids.length) return out;
  const rows = await UnclaimedAccount.find(
    { source: "webbot", webBotAccountId: { $in: ids } },
    { webBotAccountId: 1, status: 1, market: 1, soldAt: 1, updatedAt: 1 },
  ).lean();
  for (const r of rows) {
    const k = String(r.webBotAccountId || "");
    const cur = out.get(k);
    const better =
      !cur ||
      (r.status === "listed" && cur.status !== "listed") ||
      (cur.status !== "listed" &&
        new Date(r.updatedAt || 0).getTime() > new Date(cur.updatedAt || 0).getTime());
    if (better) out.set(k, r);
  }
  return out;
}

// Unclaimed MarketplaceListing rows that carry any of these logins, keyed by
// lowercased login → { sold:boolean, active:boolean, markets:[...] }. A row's
// `accountLogin` is a single login (Gameflip) or a ", "-joined lot list;
// `units[].login` holds Digiseller/GGSel delivery units. Projected find +
// JS matching — never a $group (Atlas shared tier).
async function unclaimedRowsByLogin(logins) {
  const out = new Map();
  const wanted = new Set(logins.map((l) => String(l || "").trim().toLowerCase()).filter(Boolean));
  if (!wanted.size) return out;
  const rx = [...wanted].map((l) => new RegExp("^" + escapeRegExp(l) + "$", "i"));
  const rows = await MarketplaceListing.find(
    {
      origin: "unclaimed",
      status: { $in: ["active", "sold"] },
      $or: [{ "units.login": { $in: rx } }, { accountLogin: { $in: rx } }, { accountLogin: /,/ }],
    },
    { marketplace: 1, status: 1, accountLogin: 1, units: 1 },
  ).lean();
  for (const r of rows) {
    const hit = new Set();
    for (const part of String(r.accountLogin || "").split(/[,\s]+/)) {
      const l = part.toLowerCase();
      if (wanted.has(l)) hit.add(l);
    }
    for (const u of r.units || []) {
      const l = String((u && u.login) || "").toLowerCase();
      if (wanted.has(l)) hit.add(l);
    }
    for (const l of hit) {
      const cur = out.get(l) || { sold: false, active: false, markets: [] };
      if (r.status === "sold") cur.sold = true;
      if (r.status === "active") cur.active = true;
      if (r.marketplace && !cur.markets.includes(r.marketplace)) cur.markets.push(r.marketplace);
      out.set(l, cur);
    }
  }
  return out;
}

// The DB-side "sold" verdict for a batch of WebBotAccount rows (no Twitch):
// ledger status sold, the operator's manual-sold tick, or a SOLD unclaimed
// listing row still carrying the login. Map<id, { sold, why, listed }>.
// `listed` = an ACTIVE unclaimed row (or listed ledger) still offers it — see
// the spent scan for why that is reported separately and not as "sold".
async function soldVerdicts(rows) {
  const ids = rows.map((a) => String(a._id));
  const [ledgers, byLogin] = await Promise.all([
    ledgerByOwner(ids),
    unclaimedRowsByLogin(rows.map((a) => a.login || a.credUsername || "")),
  ]);
  const out = new Map();
  for (const a of rows) {
    const id = String(a._id);
    const ledger = ledgers.get(id);
    const row = byLogin.get(String(a.login || a.credUsername || "").toLowerCase());
    let why = "";
    if (ledger && ledger.status === "sold") why = "ledger sold (" + (ledger.market || "unclaimed") + ")";
    else if (a.manualSold) why = "manual sold";
    else if (row && row.sold) why = "listing sold (" + row.markets.join(", ") + ")";
    out.set(id, {
      sold: !!why,
      why,
      listed: !!((ledger && ledger.status === "listed") || (row && row.active)),
      ledger: ledger || null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sellable stock: live scan of enabled, non-dead accounts — what each one holds
// ready to sell (farmed-unclaimed drops), which event bundle that resolves to,
// whether the account is already connected (spent), and its auto-list ledger
// state. Paged by _id cursor so the page can sweep 500 accounts in chunks.
//   GET /api/webbot-farm/sellable?botId=<id|idle|all>&limit=60&cursor=<id>
//   → { success, accounts:[...], nextCursor, scanned }
// ---------------------------------------------------------------------------
router.get("/api/webbot-farm/sellable", requireSuperadmin, async (req, res) => {
  try {
    const sel = botSelector(req.query.botId);
    if (!sel) return res.status(400).json({ success: false, message: "bad botId" });
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 60));
    const cursor = String(req.query.cursor || "").trim();
    const filter = {
      ...sel,
      enabled: true,
      lastStatus: { $ne: "dead" },
      webToken: { $gt: "" },
    };
    if (cursor) {
      if (!OBJECT_ID_RX.test(cursor)) return res.status(400).json({ success: false, message: "bad cursor" });
      filter._id = { $gt: cursor };
    }
    const rows = await WebBotAccount.find(filter, {
      login: 1,
      credUsername: 1,
      webToken: 1,
      botId: 1,
      pinnedGame: 1,
      currentGame: 1,
      manualSold: 1,
      listed: 1,
    })
      .sort({ _id: 1 })
      .limit(limit)
      .lean();
    if (!rows.length) return res.json({ success: true, accounts: [], nextCursor: null, scanned: 0 });

    // Live Twitch, bounded fan-out (direct web-token GQL like the Drops tab).
    const live = new Array(rows.length);
    let next = 0;
    async function worker() {
      while (next < rows.length) {
        const i = next++;
        live[i] = await liveInventoryFor(rows[i]);
      }
    }
    await Promise.all(Array.from({ length: Math.min(SELL_SCAN_CONCURRENCY, rows.length) }, worker));

    // Sellable drops per account, grouped onto ONE game by the engine's rule
    // (the pinned game when it holds anything, else the biggest group).
    const picked = rows.map((a, i) => {
      const sellable = unclaimedAutoList.sellableDropsFromWebbotInv({ drops: live[i].drops });
      const grp = unclaimedAutoList.pickListingGroup(a.pinnedGame || a.currentGame || "", sellable);
      return { game: grp.game || "", ready: grp.drops || [] };
    });

    // Event catalog ONCE per call, lazily — a missing/broken sibling module
    // degrades to no bundle labels rather than a failed scan.
    let bundles = null;
    let catalog = null;
    const games = [...new Set(picked.map((p) => p.game).filter(Boolean))];
    if (games.length) {
      try {
        bundles = require("../utils/unclaimedBundles");
        catalog = await bundles.loadCatalog({ games });
      } catch (e) {
        bundles = null;
        catalog = null;
      }
    }

    const verdicts = await soldVerdicts(rows);
    const now = new Date();
    const accounts = [];
    for (let i = 0; i < rows.length; i++) {
      const a = rows[i];
      const l = live[i];
      const p = picked[i];
      let bundleLabel = "";
      let full = false;
      if (bundles && catalog && p.ready.length) {
        try {
          const cls = bundles.classifyHoldings(p.game, p.ready, catalog);
          bundleLabel = (cls && cls.bundleLabel) || "";
          full = !!(cls && cls.full);
        } catch {
          bundleLabel = "";
          full = false;
        }
      }
      const v = verdicts.get(String(a._id)) || { ledger: null };
      if (l.ok) {
        await WebBotAccount.updateOne(
          { _id: a._id },
          { $set: { dropsReadyUnclaimed: p.ready.length, lastCheckedAt: now } },
        ).catch(() => {});
      }
      accounts.push({
        id: String(a._id),
        login: a.login || a.credUsername || "",
        botId: a.botId || "",
        pinnedGame: a.pinnedGame || "",
        game: p.game,
        ready: p.ready.map((d) => ({
          name: d.name || "",
          game: d.game || "",
          campaign: d.campaign || "",
          itemKey: d.itemKey || "",
        })),
        readyCount: p.ready.length,
        bundleLabel,
        full,
        connected: !!l.connected,
        ledgerStatus: v.ledger ? v.ledger.status || "" : "",
        market: v.ledger ? v.ledger.market || "" : "",
        manualSold: !!a.manualSold,
        listed: !!a.listed,
        tokenStatus: l.tokenStatus,
      });
    }
    res.json({
      success: true,
      accounts,
      nextCursor: rows.length === limit ? String(rows[rows.length - 1]._id) : null,
      scanned: rows.length,
    });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Spent scan: accounts that are SOLD (DB: ledger sold / manual-sold tick /
// sold unclaimed row carrying the login) or CONNECTED (live Twitch:
// campaign-level isAccountConnected). Mirrors /api/noclaim-farm/spent/scan.
//   GET /api/webbot-farm/spent/scan?botId=<id|idle|all>
//   → { success, botId, scanned, spent:[{ id, login, botId, game, sold, soldWhy,
//        connected, listed, tokenStatus, tokenError }] }
// An account still on an ACTIVE unclaimed listing is NOT "sold" — it is for
// sale, and pulling it off its bot would orphan a live listing — so it is
// reported as `listed:true` and only lands in `spent` when sold/connected.
// ---------------------------------------------------------------------------
router.get("/api/webbot-farm/spent/scan", requireSuperadmin, async (req, res) => {
  try {
    const sel = botSelector(req.query.botId);
    if (!sel) return res.status(400).json({ success: false, message: "bad botId" });
    const rows = await WebBotAccount.find(
      { ...sel, enabled: true, webToken: { $gt: "" } },
      { login: 1, credUsername: 1, webToken: 1, botId: 1, pinnedGame: 1, currentGame: 1, manualSold: 1, lastStatus: 1 },
    )
      .sort({ botId: 1, createdAt: 1 })
      .lean();
    if (!rows.length) return res.json({ success: true, botId: String(req.query.botId || "all"), scanned: 0, spent: [] });

    const verdicts = await soldVerdicts(rows);

    // Live connected check, one GQL per account, bounded. Dead rows are still
    // scanned here (a dead token can still be a sold account worth removing);
    // the token verdict just rides along.
    const live = new Array(rows.length);
    let next = 0;
    async function worker() {
      while (next < rows.length) {
        const i = next++;
        live[i] = await liveInventoryFor(rows[i]);
      }
    }
    await Promise.all(Array.from({ length: Math.min(SELL_SCAN_CONCURRENCY, rows.length) }, worker));

    const spent = [];
    rows.forEach((a, i) => {
      const v = verdicts.get(String(a._id)) || { sold: false, why: "", listed: false };
      const l = live[i] || {};
      if (!v.sold && !l.connected) return;
      spent.push({
        id: String(a._id),
        login: a.login || a.credUsername || "",
        botId: a.botId || "",
        game: a.pinnedGame || a.currentGame || "",
        sold: !!v.sold,
        soldWhy: v.why || "",
        connected: !!l.connected,
        listed: !!v.listed,
        tokenStatus: l.tokenStatus || "",
        tokenError: l.tokenError || "",
      });
    });
    res.json({ success: true, botId: String(req.query.botId || "all"), scanned: rows.length, spent });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Remove spent accounts from the farm: disable + unassign in Mongo only.
//   POST /api/webbot-farm/spent/remove { accounts:[id | {id, why}] }
//   → { success, removed, needsRecreate:true, bots:[botId...], accounts:[{id,login,why}], note }
// The Pi container reads a Mongo-free bot config, so it KEEPS farming these
// logins until the operator releases + re-creates that bot (needsRecreate).
// Pool / AvailableAccount rows are untouched (the registry's delete route
// handles pool release when the row is actually deleted).
// ---------------------------------------------------------------------------
router.post("/api/webbot-farm/spent/remove", requireSuperadmin, async (req, res) => {
  try {
    const ids = idsFromBody(req.body.accounts);
    if (!ids.length) return res.status(400).json({ success: false, message: "No accounts selected." });
    const supplied = new Map();
    for (const a of Array.isArray(req.body.accounts) ? req.body.accounts : []) {
      if (a && typeof a === "object" && a.id) supplied.set(String(a.id), a);
    }
    const rows = await WebBotAccount.find(
      { _id: { $in: ids } },
      { login: 1, credUsername: 1, botId: 1, pinnedGame: 1, currentGame: 1, manualSold: 1 },
    ).lean();
    if (!rows.length) return res.status(404).json({ success: false, message: "No such accounts." });

    // Authoritative sold reason from the DB; the client's scan row is only the
    // fallback for the connected detail the DB does not hold.
    const verdicts = await soldVerdicts(rows);
    const actor = actorFromReq(req);
    const bots = new Set();
    const removed = [];
    for (const a of rows) {
      const id = String(a._id);
      const v = verdicts.get(id) || { sold: false, why: "" };
      const meta = supplied.get(id) || {};
      const why =
        v.why ||
        (meta.connected ? "connected" : "") ||
        String(meta.why || meta.soldWhy || "").slice(0, 80) ||
        "operator removed";
      await WebBotAccount.updateOne(
        { _id: a._id },
        { $set: { enabled: false, botId: "", pinnedGame: "", lastStatusMessage: "spent: " + why } },
      );
      if (a.botId) bots.add(a.botId);
      removed.push({ id, login: a.login || a.credUsername || "", botId: a.botId || "", why });
    }
    logEvent({
      category: "webbot",
      action: "spent_removed",
      actor,
      subject: bots.size === 1 ? containerFor([...bots][0]) : "",
      count: removed.length,
      detail:
        "removed " +
        removed.length +
        " spent (sold/connected) web-token account(s)" +
        (bots.size ? " from bot(s) " + [...bots].join(", ") : "") +
        " — bot config(s) not rewritten; re-create to drop them from the container",
      meta: { bots: [...bots], logins: removed.map((r) => r.login).slice(0, 50) },
    });
    res.json({
      success: true,
      removed: removed.length,
      needsRecreate: true,
      bots: [...bots].sort((x, y) => (parseInt(x, 10) || 0) - (parseInt(y, 10) || 0)),
      accounts: removed,
      note:
        "Disabled + unassigned in the registry only. The Pi bot reads its own config file, so it keeps farming these logins until you release and re-create the bot.",
    });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Bulk manual-sold tick — the single /accounts/:id/manual-sold handler's logic
// per id: set the flag and, when marking sold, run the unclaimed engine's
// reactive removal (delist from every active row, park the ledger "removed").
//   POST /api/webbot-farm/manual-sold-bulk { accounts:[ids], value:true|false }
//   → { success, value, updated, delisted, errors:[...], accounts:[{id,login,delisted}] }
// ---------------------------------------------------------------------------
router.post("/api/webbot-farm/manual-sold-bulk", requireSuperadmin, async (req, res) => {
  try {
    const ids = idsFromBody(req.body.accounts);
    if (!ids.length) return res.status(400).json({ success: false, message: "No accounts selected." });
    const value = req.body.value === undefined ? !!req.body.sold : !!req.body.value;
    const rows = await WebBotAccount.find({ _id: { $in: ids } }, { login: 1, credUsername: 1 }).lean();
    if (!rows.length) return res.status(404).json({ success: false, message: "No such accounts." });
    const actor = actorFromReq(req);
    const out = [];
    const errors = [];
    let delisted = 0;
    for (const a of rows) {
      await WebBotAccount.updateOne({ _id: a._id }, { $set: { manualSold: value } });
      let removal = null;
      if (value) {
        removal = await unclaimedAutoList
          .removeManualSoldOwner({ webBotAccountId: String(a._id), actor: actor || "operator" })
          .catch((e) => ({ ledgers: 0, removed: 0, errors: [e.message] }));
        delisted += removal.removed || 0;
        for (const e of removal.errors || []) errors.push((a.login || String(a._id)) + ": " + e);
        logEvent({
          category: "unclaimed",
          action: "manual_sold",
          actor,
          subject: a.login || String(a._id),
          count: removal.removed || 0,
          detail:
            "manual-sold tick (web-token, bulk) — removed from " +
            (removal.removed || 0) +
            " listing ledger(s)",
        });
      }
      out.push({ id: String(a._id), login: a.login || a.credUsername || "", delisted: removal ? removal.removed || 0 : 0 });
    }
    if (!value) {
      logEvent({
        category: "unclaimed",
        action: "manual_sold_unmarked",
        actor,
        count: out.length,
        detail: "manual-sold tick cleared on " + out.length + " web-token account(s) (bulk)",
      });
    }
    res.json({ success: true, value, updated: out.length, delisted, errors, accounts: out });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Credentials export for a hand sale: text/plain `login:password` lines.
//   POST /api/webbot-farm/export-creds { accounts:[ids] }
//   → text/plain body; headers X-Exported-Count / X-Skipped-No-Password.
// Accounts with no stored (or undecryptable) password are skipped rather than
// emitted as a bare "login:" — a buyer can't use a login without a password.
// Audited as webbot/creds_exported (count only; never the secrets).
// ---------------------------------------------------------------------------
router.post("/api/webbot-farm/export-creds", requireSuperadmin, async (req, res) => {
  try {
    const ids = idsFromBody(req.body.accounts);
    if (!ids.length) return res.status(400).json({ success: false, message: "No accounts selected." });
    const rows = await WebBotAccount.find(
      { _id: { $in: ids } },
      { login: 1, credUsername: 1, credPasswordEnc: 1 },
    ).lean();
    // Keep the caller's order (the checked rows in the table).
    const byId = new Map(rows.map((r) => [String(r._id), r]));
    const lines = [];
    let skipped = 0;
    for (const id of ids) {
      const a = byId.get(id);
      if (!a) continue;
      const login = a.login || a.credUsername || "";
      let pw = "";
      try {
        pw = unclaimedAutoList.plainPassword(a.credPasswordEnc);
      } catch {
        pw = "";
      }
      if (!login || !pw) {
        skipped++;
        continue;
      }
      lines.push(login + ":" + pw);
    }
    logEvent({
      category: "webbot",
      action: "creds_exported",
      actor: actorFromReq(req),
      count: lines.length,
      detail:
        "exported credentials for " +
        lines.length +
        " web-token account(s)" +
        (skipped ? " (" + skipped + " skipped: no password)" : ""),
    });
    res.set("Content-Type", "text/plain; charset=utf-8");
    res.set("X-Exported-Count", String(lines.length));
    res.set("X-Skipped-No-Password", String(skipped));
    res.set("Cache-Control", "no-store");
    res.send(lines.join("\n") + (lines.length ? "\n" : ""));
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
