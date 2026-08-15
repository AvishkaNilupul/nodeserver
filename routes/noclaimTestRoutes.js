// ---------------------------------------------------------------------------
// No-claim farming TEST harness (isolated, throwaway).
//
// This drives a SINGLE sandbox TwitchDropsBot container on the Raspberry Pi that
// runs the experimental "no-claim" build (fork branch AvishkaNilupul/
// TwitchDropsBot@noclaim-test): it watches drops to 100% but never presses
// "Claim", leaving them earned-but-unclaimed so a buyer can connect their own
// game account and claim them.
//
// ISOLATION IS THE POINT. Nothing here touches the real bot fleet, the account
// pool, the drop scanner, listings, or any Mongo model. It only:
//   * writes/reads files under a DEDICATED Pi directory (SANDBOX_DIR), never the
//     managed /home/avishka/twitchbot dir the Bots page uses, and
//   * runs ONE container with a dedicated name/image, never a compose service.
// The only shared code it borrows is botHosts (SSH plumbing) and twitchInventory
// (a read-only GQL inventory fetch), both side-effect free against our systems.
//
// This is a manual testing tool. Keep it that way — do not wire it into any
// automated flow.
// ---------------------------------------------------------------------------
const express = require("express");

const { requireSuperadmin } = require("../middleware/auth");
const hosts = require("../utils/botHosts");
const twitchInventory = require("../utils/twitchInventory");

const router = express.Router();

// --- Sandbox constants (all on the Pi, all separate from the real bot dir) ---
const HOST_ID = "pi";
const SANDBOX_DIR = "/home/avishka/twitchbot-noclaim-test";
const SRC_DIR = SANDBOX_DIR + "/src";
const CONFIG_DIR = SANDBOX_DIR + "/Configuration";
const CONFIG_FILE = CONFIG_DIR + "/config.json";
const LOG_DIR = SANDBOX_DIR + "/logs";
const PROVISION_LOG = SANDBOX_DIR + "/provision.log";
const PROVISION_LOCK = SANDBOX_DIR + "/.provisioning";
const IMAGE = "twitchbot-noclaim-test:latest";
const CONTAINER = "twitchbot-noclaimtest";
const REPO = "https://github.com/AvishkaNilupul/TwitchDropsBot.git";
const BRANCH = "noclaim-test";

function pi() {
  const host = hosts.resolveHost(HOST_ID);
  if (!host) {
    const e = new Error(
      `Pi host "${HOST_ID}" is not configured (config/botHosts.json). ` +
        "The no-claim test only runs on the Pi.",
    );
    e.status = 503;
    throw e;
  }
  return host;
}

// Run a shell command on the Pi, resolving to stdout (trimmed). Rejects with a
// friendly message when the host is unreachable.
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

// Build the bot config.json (BotSettings shape the C# bot reads). ClaimDrops is
// hard-wired false — that's the whole point of this harness.
function buildConfig({ clientSecret, login, game }) {
  const games = game ? [game] : [];
  return JSON.stringify(
    {
      TwitchSettings: {
        TwitchUsers: [
          {
            Login: login || "noclaim-test",
            Id: "noclaimtest",
            ClientSecret: clientSecret,
            Enabled: true,
            FavouriteGames: games,
          },
        ],
        // If a game was given, restrict to it so the test is predictable;
        // otherwise the bot farms whatever drops are live.
        OnlyFavouriteGames: games.length > 0,
        OnlyConnectedAccounts: false,
        ClaimDrops: false,
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

// ---------------------------------------------------------------------------
// State: is the sandbox provisioned / building / running?
// ---------------------------------------------------------------------------
router.get("/api/noclaim-test/state", requireSuperadmin, async (req, res) => {
  try {
    // One round trip: probe lock, image, container status, and config presence.
    const script =
      `prov=no; [ -f ${hosts.shq(PROVISION_LOCK)} ] && prov=yes; ` +
      `img=no; docker image inspect ${hosts.shq(IMAGE)} >/dev/null 2>&1 && img=yes; ` +
      `cfg=no; [ -f ${hosts.shq(CONFIG_FILE)} ] && cfg=yes; ` +
      `stat=$(docker ps -a --filter name=^/${CONTAINER}$ --format '{{.State}}|{{.Status}}' 2>/dev/null); ` +
      `echo "prov=$prov"; echo "img=$img"; echo "cfg=$cfg"; echo "stat=$stat"`;
    const out = await sh(script, { timeout: 20000 });
    const map = {};
    out.split("\n").forEach((line) => {
      const i = line.indexOf("=");
      if (i > 0) map[line.slice(0, i)] = line.slice(i + 1);
    });
    const stat = map.stat || "";
    const [state, status] = stat.split("|");
    res.json({
      success: true,
      provisioning: map.prov === "yes",
      imageBuilt: map.img === "yes",
      hasConfig: map.cfg === "yes",
      containerState: state || "none", // running | exited | none | created ...
      containerStatus: status || "",
      running: state === "running",
    });
  } catch (err) {
    res
      .status(err.status || 500)
      .json({ success: false, message: err.message || "State check failed" });
  }
});

// ---------------------------------------------------------------------------
// Start: write config, then provision (clone + build if needed + run) in the
// BACKGROUND on the Pi (the first image build takes minutes). Returns quickly;
// the client polls /state and /logs.
// ---------------------------------------------------------------------------
router.post("/api/noclaim-test/start", requireSuperadmin, async (req, res) => {
  try {
    const clientSecret =
      typeof req.body.clientSecret === "string"
        ? req.body.clientSecret.trim()
        : "";
    const login =
      typeof req.body.login === "string" ? req.body.login.trim() : "";
    const game =
      typeof req.body.game === "string" ? req.body.game.trim() : "";

    if (!clientSecret) {
      return res
        .status(400)
        .json({ success: false, message: "ClientSecret is required." });
    }

    // Refuse to stomp an in-flight provision.
    const busy = await sh(
      `[ -f ${hosts.shq(PROVISION_LOCK)} ] && echo busy || echo free`,
      { timeout: 15000 },
    );
    if (busy === "busy") {
      return res.status(409).json({
        success: false,
        message: "A provision/build is already running. Wait for it to finish.",
      });
    }

    // 1) Write the config atomically via stdin (secret never appears in argv).
    const config = buildConfig({ clientSecret, login, game });
    await sh(
      `mkdir -p ${hosts.shq(CONFIG_DIR)} ${hosts.shq(LOG_DIR)} && ` +
        `cat > ${hosts.shq(CONFIG_FILE)} && chmod 600 ${hosts.shq(CONFIG_FILE)}`,
      { timeout: 20000, input: config },
    );

    // 2) Kick off provisioning detached so the HTTP request returns now.
    //    setsid + nohup so it survives the SSH channel closing.
    const provision = [
      "set -e",
      `touch ${hosts.shq(PROVISION_LOCK)}`,
      `echo "[$(date -u +%FT%TZ)] provisioning start (branch ${BRANCH})"`,
      // clone or refresh the source
      `if [ -d ${hosts.shq(SRC_DIR + "/.git")} ]; then ` +
        `cd ${hosts.shq(SRC_DIR)} && git fetch --depth 1 origin ${BRANCH} && ` +
        `git checkout -f ${BRANCH} && git reset --hard origin/${BRANCH}; ` +
        `else rm -rf ${hosts.shq(SRC_DIR)} && ` +
        `git clone --depth 1 -b ${BRANCH} ${hosts.shq(REPO)} ${hosts.shq(SRC_DIR)}; fi`,
      // build the image only if it's missing (cache the slow first build)
      `if ! docker image inspect ${hosts.shq(IMAGE)} >/dev/null 2>&1; then ` +
        `echo "building image (first run, may take several minutes)..."; ` +
        `cd ${hosts.shq(SRC_DIR)} && ` +
        `docker build -f TwitchDropsBot.Console/Dockerfile -t ${hosts.shq(IMAGE)} .; ` +
        `else echo "image present, skipping build"; fi`,
      // replace any old container
      `docker rm -f ${hosts.shq(CONTAINER)} >/dev/null 2>&1 || true`,
      // run the sandbox bot (no restart policy — it's a throwaway test)
      `docker run -d --name ${hosts.shq(CONTAINER)} --restart no ` +
        `-e INSIDE_DOCKER=true ` +
        `-v ${hosts.shq(CONFIG_DIR)}:/app/Configuration ` +
        `-v ${hosts.shq(LOG_DIR)}:/app/logs ` +
        `${hosts.shq(IMAGE)}`,
      `echo "[$(date -u +%FT%TZ)] provisioning done"`,
    ].join(" && ");

    // Wrap so the lock is always cleared, success or failure, and all output
    // lands in provision.log for the UI to tail.
    const wrapped =
      `( { ${provision} ; } > ${hosts.shq(PROVISION_LOG)} 2>&1; ` +
      `rm -f ${hosts.shq(PROVISION_LOCK)} ) `;
    const detached =
      `mkdir -p ${hosts.shq(SANDBOX_DIR)}; ` +
      `setsid sh -c ${hosts.shq(wrapped)} >/dev/null 2>&1 < /dev/null &`;

    await sh(detached, { timeout: 20000 });

    res.json({
      success: true,
      provisioning: true,
      message:
        "Started. Cloning + building on the Pi (first build takes a few minutes), then the bot runs. Watch the logs.",
    });
  } catch (err) {
    res
      .status(err.status || 500)
      .json({ success: false, message: err.message || "Start failed" });
  }
});

// ---------------------------------------------------------------------------
// Logs: provision.log (build progress) + the container's own logs.
// ---------------------------------------------------------------------------
router.get("/api/noclaim-test/logs", requireSuperadmin, async (req, res) => {
  const tail = Math.max(20, Math.min(1000, parseInt(req.query.tail, 10) || 300));
  try {
    const provision = await sh(
      `[ -f ${hosts.shq(PROVISION_LOG)} ] && tail -n ${tail} ${hosts.shq(PROVISION_LOG)} || true`,
      { timeout: 25000 },
    );
    let container = "";
    try {
      container = await hosts.dockerLogs(pi(), CONTAINER, { tail });
    } catch (e) {
      container =
        e && e.message ? "(no container logs yet: " + e.message + ")" : "";
    }
    res.json({ success: true, provision, container });
  } catch (err) {
    res
      .status(err.status || 500)
      .json({ success: false, message: err.message || "Log fetch failed" });
  }
});

// ---------------------------------------------------------------------------
// Inventory check: read the entered token back from the sandbox config and ask
// Twitch (read-only) what's in the account's drop inventory. The whole point is
// to SEE drops sitting at 100% but unclaimed — proof the no-claim mode works.
// ---------------------------------------------------------------------------
router.get(
  "/api/noclaim-test/inventory",
  requireSuperadmin,
  async (req, res) => {
    try {
      const raw = await sh(
        `[ -f ${hosts.shq(CONFIG_FILE)} ] && cat ${hosts.shq(CONFIG_FILE)} || echo ''`,
        { timeout: 15000 },
      );
      if (!raw) {
        return res.status(400).json({
          success: false,
          message: "No test config on the Pi yet — start a test first.",
        });
      }
      let token = "";
      try {
        const cfg = JSON.parse(raw);
        token =
          cfg &&
          cfg.TwitchSettings &&
          Array.isArray(cfg.TwitchSettings.TwitchUsers) &&
          cfg.TwitchSettings.TwitchUsers[0]
            ? cfg.TwitchSettings.TwitchUsers[0].ClientSecret
            : "";
      } catch {
        return res
          .status(500)
          .json({ success: false, message: "Sandbox config is not valid JSON." });
      }
      if (!token) {
        return res
          .status(400)
          .json({ success: false, message: "No ClientSecret in the config." });
      }

      const inv = await twitchInventory.fetchInventory(token);
      // Flag the drops that are the point of this test: fully watched, unclaimed.
      const inProgress = (inv.inProgress || []).map((d) => ({
        ...d,
        farmedUnclaimed: d.percent >= 100 && !d.claimed,
      }));
      res.json({
        success: true,
        login: inv.login,
        twitchId: inv.twitchId,
        inProgress,
        earned: inv.drops || [],
      });
    } catch (err) {
      if (err && err.code === "token_invalid") {
        return res.status(400).json({
          success: false,
          message: "Twitch rejected the token (invalid/expired ClientSecret).",
        });
      }
      res
        .status(err.status || 500)
        .json({ success: false, message: err.message || "Inventory check failed" });
    }
  },
);

// ---------------------------------------------------------------------------
// Stop / teardown. `?wipe=1` also removes the config + logs (image is kept so a
// re-run doesn't rebuild).
// ---------------------------------------------------------------------------
router.post("/api/noclaim-test/stop", requireSuperadmin, async (req, res) => {
  try {
    let script = `docker rm -f ${hosts.shq(CONTAINER)} >/dev/null 2>&1 || true`;
    if (String(req.query.wipe) === "1") {
      script +=
        `; rm -f ${hosts.shq(CONFIG_FILE)} ${hosts.shq(PROVISION_LOG)} ${hosts.shq(PROVISION_LOCK)}` +
        `; rm -rf ${hosts.shq(LOG_DIR)}`;
    }
    await sh(script, { timeout: 25000 });
    res.json({ success: true });
  } catch (err) {
    res
      .status(err.status || 500)
      .json({ success: false, message: err.message || "Stop failed" });
  }
});

module.exports = router;
