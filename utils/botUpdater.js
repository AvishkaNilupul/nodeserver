// One-click TwitchDropsBot version rollout, triggered from the Bots page.
//
// Builds a fresh image from the latest GitHub release natively on each
// managed host (arch-specific — the main server is amd64, a Raspberry Pi is
// usually arm64), sanity-checks it against a real account config in an
// isolated container *before* touching anything live, then recreates each
// host's running bots one at a time. The moment a bot fails its post-update
// health check, that one bot is rolled straight back to the previous image
// and the entire rollout stops — every bot not yet reached (on this host or
// the next) is left exactly as it was.
const axios = require("axios");

const hosts = require("./botHosts");
const { sendTelegram } = require("./telegram");

const REPO = "Alorf/TwitchDropsBot";
const IMAGE = "avishkarex/twitchbot";
const BUILD_TIMEOUT = 20 * 60 * 1000; // git clone + docker build, esp. on a Pi
const SETTLE_MS = 12000; // time to let a recreated/test container start logging
const BAD_LOG_PATTERNS = [
  /no users? found/i,
  /unhandled exception/i,
  /fatal error/i,
  /failed to start/i,
];

const state = {
  running: false,
  startedAt: null,
  finishedAt: null,
  targetTag: "",
  ok: null,
  error: "",
  log: [],
};

function log(hostLabel, message) {
  state.log.push({
    ts: new Date().toISOString(),
    host: hostLabel || "",
    message,
  });
  if (state.log.length > 500) state.log.shift();
  console.log(
    "[bot-update]" + (hostLabel ? " [" + hostLabel + "] " : " ") + message,
  );
}

function status() {
  return {
    running: state.running,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    targetTag: state.targetTag,
    ok: state.ok,
    error: state.error,
    log: state.log.slice(-300),
  };
}

async function latestRelease() {
  const r = await axios.get(
    "https://api.github.com/repos/" + REPO + "/releases/latest",
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "redeemhub-bot-updater",
      },
      timeout: 15000,
    },
  );
  const d = r.data || {};
  return {
    tag: d.tag_name || "",
    name: d.name || d.tag_name || "",
    url: d.html_url || "",
    publishedAt: d.published_at || null,
    body: String(d.body || "").slice(0, 4000),
  };
}

async function appliedVersions() {
  try {
    return JSON.parse(await hosts.readMeta("bot-version.json")) || {};
  } catch {
    return {};
  }
}

async function setAppliedVersion(hostId, tag) {
  const cur = await appliedVersions();
  cur[hostId] = { tag, appliedAt: new Date().toISOString() };
  await hosts.writeMeta("bot-version.json", JSON.stringify(cur, null, 2));
}

function sanitizeTag(tag) {
  return (
    String(tag)
      .replace(/[^a-zA-Z0-9_.-]/g, "-")
      .slice(0, 100) || "build"
  );
}

function buildDir(host) {
  return host.dir.replace(/\/+$/, "") + "-src";
}

function looksUnhealthy(logText) {
  return BAD_LOG_PATTERNS.some((re) => re.test(logText || ""));
}

// A real config on this host with at least one account, so the sanity-test
// container actually exercises a login rather than trivially "succeeding" on
// an empty config (the zero-account case is a known bug, not a health check).
async function pickTestConfig(host) {
  let files;
  try {
    files = await hosts.readdir(host);
  } catch {
    return null;
  }
  const configs = files.filter((f) => /^config(_\d{1,3})?\.json$/.test(f));
  for (const f of configs) {
    try {
      const data = JSON.parse(await hosts.readFile(host, f));
      const users =
        (data.TwitchSettings && data.TwitchSettings.TwitchUsers) || [];
      if (users.length > 0) return f;
    } catch {
      // Unreadable/malformed config — try the next one.
    }
  }
  return null;
}

function natKey(container) {
  if (container === "twitchbot") return 1;
  const m = container.match(/^twitchbotx(\d+)$/);
  return m ? parseInt(m[1], 10) : 9999;
}

// Build + sanity-test + roll out a single host. Throws on any failure; the
// caller treats that as "stop the whole rollout".
async function buildAndRolloutHost(host, tag) {
  const dir = buildDir(host);
  const imageTag = IMAGE + ":" + sanitizeTag(tag);
  const shq = hosts.shq;

  log(host.label, "cloning/checking out " + tag + " into " + dir);
  const cloneScript =
    "if [ -d " +
    shq(dir + "/.git") +
    " ]; then cd " +
    shq(dir) +
    " && git fetch --tags --force origin && git checkout " +
    shq(tag) +
    " && git reset --hard " +
    shq(tag) +
    "; else rm -rf " +
    shq(dir) +
    " && git clone https://github.com/" +
    REPO +
    ".git " +
    shq(dir) +
    " && cd " +
    shq(dir) +
    " && git checkout " +
    shq(tag) +
    "; fi";
  await hosts.runShell(host, cloneScript, { timeout: BUILD_TIMEOUT });

  log(host.label, "patching Dockerfile (INSIDE_DOCKER=false)");
  await hosts.runShell(
    host,
    "cd " +
      shq(dir) +
      " && sed -i 's/ENV INSIDE_DOCKER=true/ENV INSIDE_DOCKER=false/' " +
      "TwitchDropsBot.Console/Dockerfile",
    { timeout: 15000 },
  );

  const backupTag =
    IMAGE + ":pre-update-" + new Date().toISOString().slice(0, 10);
  log(host.label, "backing up current :latest as " + backupTag);
  const backupScript =
    "docker image inspect " +
    shq(IMAGE + ":latest") +
    " > /dev/null 2>&1 && docker tag " +
    shq(IMAGE + ":latest") +
    " " +
    shq(backupTag) +
    " && echo BACKED_UP || echo NO_PRIOR_IMAGE";
  const backupResult = await hosts.runShell(host, backupScript, {
    timeout: 15000,
  });
  const hadBackup = backupResult.stdout.trim() === "BACKED_UP";
  if (!hadBackup) {
    log(
      host.label,
      "no prior :latest image found — this host has nothing to roll back " +
        "to if the new build fails a live bot's health check",
    );
  }

  log(host.label, "building " + imageTag + " (this can take a few minutes)");
  await hosts.runShell(
    host,
    "cd " +
      shq(dir) +
      " && docker build -f TwitchDropsBot.Console/Dockerfile -t " +
      shq(imageTag) +
      " .",
    { timeout: BUILD_TIMEOUT },
  );

  const testFile = await pickTestConfig(host);
  if (!testFile) {
    log(
      host.label,
      "no bot on this host currently has accounts — skipping the sanity " +
        "test and the live rollout (nothing to safely validate or update)",
    );
    await hosts.runShell(
      host,
      "docker tag " + shq(imageTag) + " " + shq(IMAGE + ":latest"),
      { timeout: 15000 },
    );
    await setAppliedVersion(host.id, tag);
    return;
  }

  log(host.label, "sanity-testing image against " + testFile);
  await hosts
    .runShell(host, "docker rm -f twitchbot-testrun > /dev/null 2>&1 || true", {
      timeout: 10000,
    })
    .catch(() => {});
  const hostConfigPath = host.dir.replace(/\/+$/, "") + "/" + testFile;
  await hosts.runShell(
    host,
    "docker run -d --name twitchbot-testrun -v " +
      shq(hostConfigPath + ":/app/config.json") +
      " " +
      shq(imageTag),
    { timeout: 30000 },
  );
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  const testLogs = await hosts
    .runShell(host, "docker logs twitchbot-testrun 2>&1 | tail -n 150", {
      timeout: 15000,
    })
    .then((r) => r.stdout)
    .catch(() => "");
  await hosts
    .runShell(host, "docker rm -f twitchbot-testrun > /dev/null 2>&1 || true", {
      timeout: 10000,
    })
    .catch(() => {});

  if (looksUnhealthy(testLogs)) {
    throw new Error(
      host.label +
        ": sanity test failed — the new image (" +
        tag +
        ") looks broken against a real config. Nothing live was touched. " +
        "Last logs: " +
        testLogs.slice(-400),
    );
  }
  log(host.label, "sanity test passed, promoting " + imageTag + " to :latest");
  await hosts.runShell(
    host,
    "docker tag " + shq(imageTag) + " " + shq(IMAGE + ":latest"),
    { timeout: 15000 },
  );

  const states = await hosts.dockerPs(host).catch(() => ({}));
  const running = Object.keys(states)
    .filter(
      (name) =>
        (name === "twitchbot" || /^twitchbotx\d+$/.test(name)) &&
        states[name].state === "running",
    )
    .sort((a, b) => natKey(a) - natKey(b));

  if (!running.length) {
    log(host.label, "no running bots on this host to recreate");
    await setAppliedVersion(host.id, tag);
    return;
  }

  for (const container of running) {
    log(host.label, "recreating " + container + " on the new image");
    await hosts.composeUp(host, container);
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const afterStates = await hosts.dockerPs(host).catch(() => ({}));
    const isRunning =
      afterStates[container] && afterStates[container].state === "running";
    const afterLogs = await hosts
      .dockerLogs(host, container, { tail: 150 })
      .catch(() => "");
    if (!isRunning || looksUnhealthy(afterLogs)) {
      log(
        host.label,
        container +
          " failed its post-update check" +
          (isRunning ? "" : " (container not running)") +
          " — rolling it back and stopping the rollout",
      );
      if (hadBackup) {
        await hosts
          .runShell(
            host,
            "docker tag " + shq(backupTag) + " " + shq(IMAGE + ":latest"),
            { timeout: 15000 },
          )
          .catch(() => {});
        await hosts.composeUp(host, container).catch(() => {});
      }
      throw new Error(
        host.label +
          ": " +
          container +
          " failed its post-update health check on " +
          tag +
          (hadBackup
            ? " — rolled back to the previous image."
            : " — no previous image was available to roll back to; check " +
              "it manually.") +
          " Last logs: " +
          afterLogs.slice(-400),
      );
    }
    log(host.label, container + " looks healthy on the new image");
  }

  await setAppliedVersion(host.id, tag);
}

async function runRollout(tag) {
  try {
    for (const h of hosts.listHosts()) {
      const host = hosts.resolveHost(h.id);
      log(host.label, "=== starting build + rollout ===");
      await buildAndRolloutHost(host, tag);
      log(host.label, "=== done, now on " + tag + " ===");
    }
    state.ok = true;
    log("", "Rollout to " + tag + " complete on all hosts.");
    await sendTelegram(
      "✅ TwitchDropsBot updated to " + tag + " on all hosts.",
    ).catch(() => {});
  } catch (err) {
    state.ok = false;
    state.error = err.message || String(err);
    log("", "ABORTED: " + state.error);
    await sendTelegram(
      "⚠️ TwitchDropsBot rollout to " + tag + " aborted: " + state.error,
    ).catch(() => {});
  } finally {
    state.running = false;
    state.finishedAt = new Date().toISOString();
  }
}

async function start() {
  if (state.running) {
    throw new Error("A rollout is already running");
  }
  const rel = await latestRelease();
  if (!rel.tag) {
    throw new Error("Could not determine the latest release tag from GitHub");
  }
  state.running = true;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.targetTag = rel.tag;
  state.ok = null;
  state.error = "";
  state.log = [];
  log("", "Starting rollout to " + rel.tag);
  runRollout(rel.tag).catch((err) => {
    // runRollout already catches everything internally; this is a final
    // backstop so a truly unexpected throw can't leave `running` stuck true.
    state.running = false;
    state.ok = false;
    state.error = err.message || String(err);
    state.finishedAt = new Date().toISOString();
  });
  return { tag: rel.tag };
}

module.exports = { latestRelease, appliedVersions, start, status };
