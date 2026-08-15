// ---------------------------------------------------------------------------
// Standalone NO-CLAIM FARMING system.
//
// Some games (Overwatch, Rainbow Six) can't be sold via the normal
// click-claim-then-sell flow: the drop has to be left UNCLAIMED so the buyer
// connects their own game account and claims it. This is a self-contained
// console for exactly those games, separate from the auto-farmer / Drop Archive
// / scanner / listings:
//
//   * bots run the no-claim build (ClaimDrops:false) as their own Docker
//     containers in a DEDICATED Pi directory (BASE), never the managed bot dir;
//   * accounts are pulled from the shared pool (AvailableAccount), respecting
//     the auto-farm reserve so this never starves it;
//   * source of truth is the per-bot config files on the Pi (like the Bots
//     page) — no new Mongo model, nothing coupled to the old systems;
//   * it never creates listings — the operator lists manually from the account
//     credentials this page surfaces.
//
// Every heavy read (per-bot accounts, live drop inventory) is a separate
// on-demand endpoint so the page opens on a cheap summary and only does slow
// work when a row is expanded.
// ---------------------------------------------------------------------------
const express = require("express");

const { requireSuperadmin } = require("../middleware/auth");
const hosts = require("../utils/botHosts");
const settings = require("../utils/settings");
const twitchInventory = require("../utils/twitchInventory");
const AvailableAccount = require("../models/AvailableAccount");
const { decrypt } = require("../utils/secretBox");

const router = express.Router();

// --- Sandbox constants (all on the Pi, separate from the real bot dir) --------
const HOST_ID = "pi";
const BASE = "/home/avishka/twitchbot-noclaim";
const SRC_DIR = BASE + "/src";
const BOTS_DIR = BASE + "/bots"; // bots/<id>/Configuration/config.json + bots/<id>/logs
const IMAGE = "twitchbot-noclaim:latest";
const CONTAINER_PREFIX = "noclaim-bot-";
const REPO = "https://github.com/AvishkaNilupul/TwitchDropsBot.git";
const BRANCH = "noclaim-test";
const CLAIM_NOTE_PREFIX = "noclaim-farm";

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
const configPath = (id) => botDir(id) + "/Configuration/config.json";

// Build one bot's config.json from a set of pool account docs.
function buildConfig(accounts, game) {
  const games = game ? [game] : [];
  return JSON.stringify(
    {
      TwitchSettings: {
        TwitchUsers: accounts.map((a) => ({
          Login: a.username || "",
          Id: String(a.twitchId || ""),
          ClientSecret: a.clientSecret || "",
          Enabled: true,
          FavouriteGames: games,
        })),
        OnlyFavouriteGames: games.length > 0,
        OnlyConnectedAccounts: false,
        ClaimDrops: false, // the whole point
      },
      FavouriteGames: games,
      WatchBrowserHeadless: true,
      WaitingSeconds: 300,
      AttemptToWatch: 5,
    },
    null,
    2,
  );
}

// Ready pool query — mirrors the auto-farmer's definition so the two systems
// agree on what "ready" means (verified token, available, not suspended).
function readyPoolQuery() {
  return {
    status: "available",
    clientSecret: { $gt: "" },
    lastCheckStatus: { $in: ["", "ok"] },
  };
}

// ---------------------------------------------------------------------------
// No-claim game list (shared with the auto-farmer's exclusion — single source
// of truth). Editable here.
// ---------------------------------------------------------------------------
router.get("/api/noclaim-farm/games", requireSuperadmin, (req, res) => {
  res.json({ success: true, games: settings.getAutoFarm().noClaimGames || [] });
});

router.post("/api/noclaim-farm/games", requireSuperadmin, async (req, res) => {
  try {
    let games = Array.isArray(req.body.games) ? req.body.games : null;
    if (!games)
      return res
        .status(400)
        .json({ success: false, message: "games must be an array." });
    games = games
      .map((g) => String(g || "").trim().toLowerCase())
      .filter(Boolean);
    const saved = await settings.setAutoFarm({ noClaimGames: games });
    res.json({ success: true, games: saved.noClaimGames });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Pool availability (cheap count for the create form).
// ---------------------------------------------------------------------------
router.get("/api/noclaim-farm/pool", requireSuperadmin, async (req, res) => {
  try {
    const ready = await AvailableAccount.countDocuments(readyPoolQuery());
    const reserve = settings.getAutoFarm().poolReserve || 0;
    res.json({
      success: true,
      ready,
      reserve,
      spendable: Math.max(0, ready - reserve),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Summary: list bots (cheap — one config sweep + one docker ps).
// ---------------------------------------------------------------------------
router.get("/api/noclaim-farm/state", requireSuperadmin, async (req, res) => {
  try {
    // Provisioning lock, image presence, per-bot config game + account count,
    // and container states — one round trip.
    const script =
      `prov=no; [ -f ${hosts.shq(BASE + "/.provisioning")} ] && prov=yes; echo "prov=$prov"; ` +
      `img=no; docker image inspect ${hosts.shq(IMAGE)} >/dev/null 2>&1 && img=yes; echo "img=$img"; ` +
      `echo "PS_START"; docker ps -a --filter name=^/${CONTAINER_PREFIX} --format '{{.Names}}|{{.State}}|{{.Status}}' 2>/dev/null; echo "PS_END"; ` +
      `echo "BOTS_START"; for d in ${hosts.shq(BOTS_DIR)}/*/Configuration/config.json; do [ -f "$d" ] || continue; ` +
      `id=$(basename $(dirname $(dirname "$d"))); ` +
      `game=$(sed -n 's/.*"FavouriteGames"[^]]*\\[[^"]*"\\([^"]*\\)".*/\\1/p' "$d" | head -1); ` +
      `n=$(grep -c '"ClientSecret"' "$d"); ` +
      `echo "$id|$game|$n"; done; echo "BOTS_END"`;
    const out = await sh(script, { timeout: 25000 });

    const lines = out.split("\n");
    let section = "";
    const provLine = {};
    const psMap = {};
    const bots = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (line === "PS_START") { section = "ps"; continue; }
      if (line === "PS_END") { section = ""; continue; }
      if (line === "BOTS_START") { section = "bots"; continue; }
      if (line === "BOTS_END") { section = ""; continue; }
      if (line.startsWith("prov=")) { provLine.prov = line.slice(5) === "yes"; continue; }
      if (line.startsWith("img=")) { provLine.img = line.slice(4) === "yes"; continue; }
      if (section === "ps" && line) {
        const [name, state, status] = line.split("|");
        const id = name.replace(CONTAINER_PREFIX, "");
        psMap[id] = { state, status };
      } else if (section === "bots" && line) {
        const [id, game, n] = line.split("|");
        bots.push({ id, game: game || "", accounts: parseInt(n, 10) || 0 });
      }
    }
    for (const b of bots) {
      const ps = psMap[b.id];
      b.containerState = ps ? ps.state : "none";
      b.containerStatus = ps ? ps.status : "";
      b.running = ps ? ps.state === "running" : false;
    }
    bots.sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
    res.json({
      success: true,
      provisioning: !!provLine.prov,
      imageBuilt: !!provLine.img,
      bots,
    });
  } catch (err) {
    res
      .status(err.status || 500)
      .json({ success: false, message: err.message || "State failed" });
  }
});

// ---------------------------------------------------------------------------
// Create a bot: claim N ready pool accounts, write its config, run it.
// ---------------------------------------------------------------------------
router.post("/api/noclaim-farm/bots", requireSuperadmin, async (req, res) => {
  let claimed = [];
  try {
    const game = String(req.body.game || "").trim();
    const count = Math.max(1, Math.min(70, parseInt(req.body.count, 10) || 0));
    if (!game)
      return res.status(400).json({ success: false, message: "Pick a game." });
    if (!count)
      return res
        .status(400)
        .json({ success: false, message: "Account count required." });

    // Reserve guard: never draw the shared pool below the auto-farm reserve.
    const reserve = settings.getAutoFarm().poolReserve || 0;
    const ready = await AvailableAccount.countDocuments(readyPoolQuery());
    if (ready - count < reserve) {
      return res.status(409).json({
        success: false,
        message: `Only ${Math.max(0, ready - reserve)} account(s) spendable (${ready} ready, reserve ${reserve}). Lower the count.`,
      });
    }

    // Don't stomp an in-flight provision.
    const busy = await sh(
      `[ -f ${hosts.shq(BASE + "/.provisioning")} ] && echo busy || echo free`,
      { timeout: 15000 },
    );
    if (busy === "busy")
      return res.status(409).json({
        success: false,
        message: "A build/provision is already running. Try again shortly.",
      });

    // Claim N accounts atomically (available -> claimed) with our note so they
    // can be found and released later.
    const note = `${CLAIM_NOTE_PREFIX}:${game}`;
    for (let i = 0; i < count; i++) {
      const doc = await AvailableAccount.findOneAndUpdate(
        readyPoolQuery(),
        { $set: { status: "claimed", claimedAt: new Date(), claimedNote: note } },
        { new: true, sort: { lastCheckAt: -1 } },
      );
      if (!doc) break;
      claimed.push(doc);
    }
    if (!claimed.length)
      return res
        .status(409)
        .json({ success: false, message: "No ready pool accounts to claim." });

    // Pick the next free bot id.
    const idsRaw = await sh(
      `ls -1 ${hosts.shq(BOTS_DIR)} 2>/dev/null || true`,
      { timeout: 15000 },
    );
    const used = idsRaw
      .split("\n")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n));
    const id = String((used.length ? Math.max(...used) : 0) + 1);

    // Write config (secret list via stdin — never in argv).
    const config = buildConfig(claimed, game);
    await sh(
      `mkdir -p ${hosts.shq(botDir(id) + "/Configuration")} ${hosts.shq(botDir(id) + "/logs")} && ` +
        `cat > ${hosts.shq(configPath(id))} && chmod 600 ${hosts.shq(configPath(id))}`,
      { timeout: 20000, input: config },
    );

    // Provision (clone + build image if missing + run this bot) detached.
    const provision = [
      "set -e",
      `touch ${hosts.shq(BASE + "/.provisioning")}`,
      `echo "[$(date -u +%FT%TZ)] bot ${id}: ${claimed.length} account(s), game=${game}"`,
      `if [ -d ${hosts.shq(SRC_DIR + "/.git")} ]; then cd ${hosts.shq(SRC_DIR)} && git fetch --depth 1 origin ${BRANCH} && git checkout -f ${BRANCH} && git reset --hard origin/${BRANCH}; else rm -rf ${hosts.shq(SRC_DIR)} && git clone --depth 1 -b ${BRANCH} ${hosts.shq(REPO)} ${hosts.shq(SRC_DIR)}; fi`,
      `if ! docker image inspect ${hosts.shq(IMAGE)} >/dev/null 2>&1; then cd ${hosts.shq(SRC_DIR)} && docker build -f TwitchDropsBot.Console/Dockerfile -t ${hosts.shq(IMAGE)} .; fi`,
      `docker rm -f ${hosts.shq(containerFor(id))} >/dev/null 2>&1 || true`,
      `docker run -d --name ${hosts.shq(containerFor(id))} --restart unless-stopped --user 0:0 ` +
        `-e INSIDE_DOCKER=true -v ${hosts.shq(botDir(id) + "/Configuration")}:/app/Configuration ` +
        `-v ${hosts.shq(botDir(id) + "/logs")}:/app/logs ${hosts.shq(IMAGE)}`,
      `echo "[$(date -u +%FT%TZ)] bot ${id} started"`,
    ].join(" && ");
    const wrapped =
      `( { ${provision} ; } > ${hosts.shq(BASE + "/provision.log")} 2>&1; rm -f ${hosts.shq(BASE + "/.provisioning")} )`;
    await sh(
      `mkdir -p ${hosts.shq(BASE)}; setsid sh -c ${hosts.shq(wrapped)} >/dev/null 2>&1 < /dev/null &`,
      { timeout: 20000 },
    );

    res.json({
      success: true,
      id,
      claimed: claimed.length,
      message: `Bot ${id} created with ${claimed.length} account(s). Building/starting on the Pi — watch the logs.`,
    });
  } catch (err) {
    // Roll the claim back so accounts aren't stranded out of the pool.
    if (claimed.length) {
      await AvailableAccount.updateMany(
        { _id: { $in: claimed.map((d) => d._id) } },
        { $set: { status: "available", claimedAt: null, claimedNote: "" } },
      ).catch(() => {});
    }
    res
      .status(err.status || 500)
      .json({ success: false, message: err.message || "Create failed" });
  }
});

// ---------------------------------------------------------------------------
// Per-bot accounts (lazy — reads that bot's config from the Pi).
// ---------------------------------------------------------------------------
router.get(
  "/api/noclaim-farm/bots/:id/accounts",
  requireSuperadmin,
  async (req, res) => {
    try {
      const id = String(req.params.id).replace(/[^0-9]/g, "");
      if (!id) return res.status(400).json({ success: false, message: "bad id" });
      const raw = await sh(
        `[ -f ${hosts.shq(configPath(id))} ] && cat ${hosts.shq(configPath(id))} || echo ''`,
        { timeout: 15000 },
      );
      if (!raw)
        return res.status(404).json({ success: false, message: "No such bot." });
      const cfg = JSON.parse(raw);
      const users = (cfg.TwitchSettings && cfg.TwitchSettings.TwitchUsers) || [];
      // Join back to the pool by clientSecret to recover the login PASSWORD
      // (the config only carries the token). Passwords are stored encrypted in
      // the pool — decrypt here for the operator to list the account manually.
      const secrets = users.map((u) => u.ClientSecret).filter(Boolean);
      const pwMap = new Map();
      if (secrets.length) {
        const rows = await AvailableAccount.find(
          { clientSecret: { $in: secrets } },
          { clientSecret: 1, password: 1 },
        ).lean();
        for (const r of rows) {
          let pw = "";
          try {
            pw = r.password ? decrypt(r.password) || "" : "";
          } catch {
            pw = "";
          }
          pwMap.set(r.clientSecret, pw);
        }
      }
      // Surface the credentials so the operator can list manually — this whole
      // console is superadmin-only and the token already lives on the Pi.
      const accounts = users.map((u) => ({
        login: u.Login || "",
        twitchId: u.Id || "",
        password: pwMap.get(u.ClientSecret) || "",
        clientSecret: u.ClientSecret || "",
      }));
      res.json({
        success: true,
        game: (cfg.FavouriteGames || [])[0] || "",
        accounts,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ---------------------------------------------------------------------------
// Per-bot live drops (lazy + slow — one Twitch inventory query per account).
// Returns each account's in-progress drops, flagging farmed-but-unclaimed.
// ---------------------------------------------------------------------------
router.get(
  "/api/noclaim-farm/bots/:id/drops",
  requireSuperadmin,
  async (req, res) => {
    try {
      const id = String(req.params.id).replace(/[^0-9]/g, "");
      if (!id) return res.status(400).json({ success: false, message: "bad id" });
      const raw = await sh(
        `[ -f ${hosts.shq(configPath(id))} ] && cat ${hosts.shq(configPath(id))} || echo ''`,
        { timeout: 15000 },
      );
      if (!raw)
        return res.status(404).json({ success: false, message: "No such bot." });
      const cfg = JSON.parse(raw);
      const users = (cfg.TwitchSettings && cfg.TwitchSettings.TwitchUsers) || [];
      const host = pi();
      // Route the GQL through the Pi host (like the scanners) to keep the
      // fan-out off this server; bounded concurrency keeps it responsive even
      // for a full 70-account bot.
      const CONCURRENCY = 5;
      const out = new Array(users.length);
      let next = 0;
      async function worker() {
        while (next < users.length) {
          const i = next++;
          const u = users[i];
          try {
            const inv = await twitchInventory.fetchInventory(u.ClientSecret, {
              host,
            });
            out[i] = {
              login: u.Login || inv.login,
              ok: true,
              drops: (inv.inProgress || []).map((d) => ({
                name: d.name,
                game: d.game,
                percent: d.percent,
                claimed: d.claimed,
                farmedUnclaimed: d.percent >= 100 && !d.claimed,
              })),
            };
          } catch (e) {
            out[i] = {
              login: u.Login || "",
              ok: false,
              error:
                e && e.code === "token_invalid" ? "token invalid" : e.message,
            };
          }
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, users.length) }, worker),
      );
      res.json({ success: true, accounts: out });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ---------------------------------------------------------------------------
// Container logs for one bot.
// ---------------------------------------------------------------------------
router.get(
  "/api/noclaim-farm/bots/:id/logs",
  requireSuperadmin,
  async (req, res) => {
    try {
      const id = String(req.params.id).replace(/[^0-9]/g, "");
      const tail = Math.max(20, Math.min(1000, parseInt(req.query.tail, 10) || 200));
      let container = "";
      try {
        container = await hosts.dockerLogs(pi(), containerFor(id), { tail });
      } catch (e) {
        container = "(no logs: " + (e.message || "") + ")";
      }
      const provision = await sh(
        `[ -f ${hosts.shq(BASE + "/provision.log")} ] && tail -n 60 ${hosts.shq(BASE + "/provision.log")} || true`,
        { timeout: 15000 },
      );
      res.json({ success: true, container, provision });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ---------------------------------------------------------------------------
// Stop a bot's container (keeps config + accounts claimed).
// ---------------------------------------------------------------------------
router.post(
  "/api/noclaim-farm/bots/:id/stop",
  requireSuperadmin,
  async (req, res) => {
    try {
      const id = String(req.params.id).replace(/[^0-9]/g, "");
      await sh(`docker stop ${hosts.shq(containerFor(id))} 2>/dev/null || true`, {
        timeout: 25000,
      });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ---------------------------------------------------------------------------
// Release a bot: stop+remove container, release its accounts back to the pool,
// delete its config. Use once you've listed the accounts (or to abandon).
// ---------------------------------------------------------------------------
router.post(
  "/api/noclaim-farm/bots/:id/release",
  requireSuperadmin,
  async (req, res) => {
    try {
      const id = String(req.params.id).replace(/[^0-9]/g, "");
      if (!id) return res.status(400).json({ success: false, message: "bad id" });
      // Read the config to recover which pool accounts to release.
      const raw = await sh(
        `[ -f ${hosts.shq(configPath(id))} ] && cat ${hosts.shq(configPath(id))} || echo ''`,
        { timeout: 15000 },
      );
      let released = 0;
      if (raw) {
        const cfg = JSON.parse(raw);
        const secrets = (
          (cfg.TwitchSettings && cfg.TwitchSettings.TwitchUsers) ||
          []
        )
          .map((u) => u.ClientSecret)
          .filter(Boolean);
        if (secrets.length) {
          const r = await AvailableAccount.updateMany(
            { clientSecret: { $in: secrets } },
            {
              $set: { status: "available", claimedAt: null, claimedNote: "" },
            },
          );
          released = r.modifiedCount || 0;
        }
      }
      await sh(
        `docker rm -f ${hosts.shq(containerFor(id))} >/dev/null 2>&1 || true; rm -rf ${hosts.shq(botDir(id))}`,
        { timeout: 25000 },
      );
      res.json({ success: true, released });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

module.exports = router;
