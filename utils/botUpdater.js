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

const DEFAULT_REPO = "Alorf/TwitchDropsBot";
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
  targetRepo: "",
  targetTag: "",
  ok: null,
  error: "",
  log: [],
};

// owner/repo, letters/digits/._- only — this gets interpolated into a git
// clone URL, so keep it as strict as GitHub's own naming rules.
function validRepo(repo) {
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(String(repo || ""));
}

// A git ref (branch, tag, or commit) — no shell metacharacters. Broader than
// validRepo since refs can contain slashes (e.g. "hotfix/gql-progress").
function validRef(ref) {
  return /^[A-Za-z0-9._/-]{1,200}$/.test(String(ref || ""));
}

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
    targetRepo: state.targetRepo,
    targetTag: state.targetTag,
    ok: state.ok,
    error: state.error,
    log: state.log.slice(-300),
  };
}

async function latestRelease(repo) {
  const r = await axios.get(
    "https://api.github.com/repos/" + (repo || DEFAULT_REPO) + "/releases/latest",
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

async function setAppliedVersion(hostId, tag, repo) {
  const cur = await appliedVersions();
  cur[hostId] = { tag, repo: repo || DEFAULT_REPO, appliedAt: new Date().toISOString() };
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
//
// `repo` can point at a fork (e.g. for an emergency patch pushed ahead of an
// upstream release), so the clone step re-points `origin` and fetches the
// exact ref by name rather than assuming it's a tag — this also means a host
// previously built from a different repo/ref (its build dir already has a
// `.git`) gets correctly redirected instead of silently reusing stale history
// from the old origin.
async function buildAndRolloutHost(host, tag, repo) {
  const sourceRepo = repo || DEFAULT_REPO;
  const dir = buildDir(host);
  const imageTag = IMAGE + ":" + sanitizeTag(tag);
  const shq = hosts.shq;
  const url = "https://github.com/" + sourceRepo + ".git";

  log(
    host.label,
    "fetching " + sourceRepo + "@" + tag + " into " + dir,
  );
  const cloneScript =
    "if [ -d " +
    shq(dir + "/.git") +
    " ]; then cd " +
    shq(dir) +
    " && git remote set-url origin " +
    shq(url) +
    "; else rm -rf " +
    shq(dir) +
    " && git init -q " +
    shq(dir) +
    " && cd " +
    shq(dir) +
    " && git remote add origin " +
    shq(url) +
    "; fi && git fetch --force origin " +
    shq(tag) +
    " && git checkout --force FETCH_HEAD && git reset --hard FETCH_HEAD";
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
    await setAppliedVersion(host.id, tag, sourceRepo);
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
    await setAppliedVersion(host.id, tag, sourceRepo);
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

  await setAppliedVersion(host.id, tag, sourceRepo);
}

// Resolve the linux-arm64 Console release asset for a repo's latest release.
// Returns { tag, url } or null when the repo publishes no arm64 asset (upstream
// ships x64 only) — the caller treats null as "nothing to install here" rather
// than an error.
async function latestArmAsset(repo) {
  const r = await axios.get(
    "https://api.github.com/repos/" +
      (repo || DEFAULT_REPO) +
      "/releases/latest",
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "redeemhub-bot-updater",
      },
      timeout: 15000,
    },
  );
  const d = r.data || {};
  const asset = (d.assets || []).find(
    (a) =>
      /console/i.test(a.name) &&
      /linux-arm64/i.test(a.name) &&
      /\.(tar\.gz|tgz)$/i.test(a.name),
  );
  return asset
    ? { tag: d.tag_name || "", url: asset.browser_download_url }
    : null;
}

// Native (non-Docker) host rollout — an Android/Termux phone. There's no image
// to build; fetch the latest published arm64 Console release, swap it into the
// host's app dir (keeping the old one for rollback), and restart each running
// bot on it via botctl (through the host abstraction — dockerPs/composeUp/etc.
// dispatch to botctl for native hosts). All bots on a native host share one
// binary, so this is all-or-nothing: if any bot fails its post-update check,
// the previous app dir is restored and every bot is put back on it.
async function rolloutNativeHost(host, repo) {
  const sourceRepo = repo || DEFAULT_REPO;
  const shq = hosts.shq;
  const dir = host.dir.replace(/\/+$/, "");

  const asset = await latestArmAsset(sourceRepo);
  if (!asset) {
    log(
      host.label,
      "no linux-arm64 Console asset in " +
        sourceRepo +
        "'s latest release — leaving this host unchanged",
    );
    return;
  }
  // Which bots are running — fetched BEFORE the swap so it doubles as a
  // reachability check. Deliberately not caught: an unreachable phone throws
  // here, before anything on disk is touched, and runRollout treats that as a
  // clean non-fatal skip. (Catching it would look like "no bots" and leave the
  // app swapped but never restarted — bots stuck on the old binary.)
  const states = await hosts.dockerPs(host);
  const running = Object.keys(states)
    .filter(
      (n) =>
        (n === "twitchbot" || /^twitchbotx\d+$/.test(n)) &&
        states[n].state === "running",
    )
    .sort((a, b) => natKey(a) - natKey(b));

  log(host.label, "installing " + sourceRepo + "@" + asset.tag + " (arm64)");

  // Download + extract + swap the app dir. Runs in the device shell (not proot)
  // — plain file ops. The archive wraps files in a top-level dir, so flatten.
  const swap =
    "set -e; cd " +
    shq(dir) +
    "; curl -fsSL " +
    shq(asset.url) +
    " -o app.new.tar.gz; rm -rf app.new; mkdir app.new; " +
    "tar xzf app.new.tar.gz -C app.new; " +
    'if [ ! -f app.new/TwitchDropsBot.Console ]; then ' +
    'inner=$(find app.new -name TwitchDropsBot.Console -type f | head -1); ' +
    '[ -n "$inner" ] && mv "$(dirname "$inner")"/* app.new/; fi; ' +
    '[ -f app.new/TwitchDropsBot.Console ] || { echo NO_BINARY; exit 1; }; ' +
    "chmod +x app.new/TwitchDropsBot.Console; rm -rf app.old; " +
    "[ -d app ] && mv app app.old; mv app.new app; rm -f app.new.tar.gz; echo SWAPPED";
  await hosts.runShell(host, swap, { timeout: BUILD_TIMEOUT });

  if (!running.length) {
    log(host.label, "app updated; no running bots to restart");
    await setAppliedVersion(host.id, asset.tag, sourceRepo);
    return;
  }

  // Stop each, clear its per-bot copy (botctl only re-copies the app when the
  // binary is missing, so this forces it to pick up the new one), start each.
  const restartAll = async () => {
    for (const n of running) {
      await hosts.dockerContainer(host, "stop", n).catch(() => {});
    }
    await hosts
      .runShell(
        host,
        "cd " +
          shq(dir) +
          " && for n in " +
          running.join(" ") +
          "; do rm -rf run/$n; done",
        { timeout: 30000 },
      )
      .catch(() => {});
    for (const n of running) {
      await hosts.composeUp(host, n).catch(() => {});
    }
  };
  await restartAll();
  await new Promise((r) => setTimeout(r, SETTLE_MS));

  let bad = "";
  for (const n of running) {
    const after = await hosts.dockerPs(host).catch(() => ({}));
    const up = after[n] && after[n].state === "running";
    const logs = await hosts.dockerLogs(host, n, { tail: 150 }).catch(() => "");
    if (!up || looksUnhealthy(logs)) {
      bad = n + (up ? " (unhealthy logs)" : " (not running)");
      break;
    }
  }

  if (bad) {
    log(
      host.label,
      bad + " failed post-update check — restoring the previous app",
    );
    await hosts
      .runShell(
        host,
        "cd " + shq(dir) + " && rm -rf app && [ -d app.old ] && mv app.old app",
        { timeout: 30000 },
      )
      .catch(() => {});
    await restartAll().catch(() => {});
    throw new Error(
      host.label +
        ": " +
        bad +
        " failed its post-update check on " +
        asset.tag +
        " — rolled back to the previous build.",
    );
  }

  await setAppliedVersion(host.id, asset.tag, sourceRepo);
  log(host.label, "all bots healthy on " + asset.tag);
}

async function runRollout(tag, repo) {
  const sourceRepo = repo || DEFAULT_REPO;
  try {
    for (const h of hosts.listHosts()) {
      const host = hosts.resolveHost(h.id);
      if (host.runtime === "native") {
        // No Docker image to build/swap — install the latest arm64 release
        // instead. A phone is often offline, so a native failure is logged but
        // doesn't abort a rollout that already updated the Docker hosts.
        log(host.label, "=== native host: installing latest arm64 release ===");
        try {
          await rolloutNativeHost(host, sourceRepo);
          log(host.label, "=== done ===");
        } catch (e) {
          log(
            host.label,
            "native rollout failed (non-fatal): " + (e.message || String(e)),
          );
        }
        continue;
      }
      log(host.label, "=== starting build + rollout ===");
      await buildAndRolloutHost(host, tag, sourceRepo);
      log(host.label, "=== done, now on " + sourceRepo + "@" + tag + " ===");
    }
    state.ok = true;
    log("", "Rollout to " + sourceRepo + "@" + tag + " complete on all hosts.");
    await sendTelegram(
      "✅ TwitchDropsBot updated to " +
        tag +
        (sourceRepo !== DEFAULT_REPO ? " (from " + sourceRepo + ")" : "") +
        " on all hosts.",
    ).catch(() => {});
  } catch (err) {
    state.ok = false;
    state.error = err.message || String(err);
    log("", "ABORTED: " + state.error);
    await sendTelegram(
      "⚠️ TwitchDropsBot rollout to " +
        sourceRepo +
        "@" +
        tag +
        " aborted: " +
        state.error,
    ).catch(() => {});
  } finally {
    state.running = false;
    state.finishedAt = new Date().toISOString();
  }
}

// { repo, ref }: both optional. With neither, behaves as before — rolls out
// the latest upstream release. Passing `ref` (a branch, tag, or commit on
// `repo`, which may be a fork) skips the "latest release" lookup entirely and
// builds that exact ref — this is the emergency-patch path: push a fix to a
// fork branch and roll it out immediately instead of waiting for an upstream
// release to exist.
async function start({ repo, ref } = {}) {
  if (state.running) {
    throw new Error("A rollout is already running");
  }
  if (repo && !validRepo(repo)) {
    throw new Error("repo must look like owner/name");
  }
  if (ref && !validRef(ref)) {
    throw new Error("ref must be a valid branch, tag, or commit name");
  }
  const sourceRepo = repo || DEFAULT_REPO;

  let tag = ref;
  if (!tag) {
    const rel = await latestRelease(sourceRepo);
    if (!rel.tag) {
      throw new Error(
        "Could not determine the latest release tag from GitHub",
      );
    }
    tag = rel.tag;
  }

  state.running = true;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.targetRepo = sourceRepo;
  state.targetTag = tag;
  state.ok = null;
  state.error = "";
  state.log = [];
  log("", "Starting rollout to " + sourceRepo + "@" + tag);
  runRollout(tag, sourceRepo).catch((err) => {
    // runRollout already catches everything internally; this is a final
    // backstop so a truly unexpected throw can't leave `running` stuck true.
    state.running = false;
    state.ok = false;
    state.error = err.message || String(err);
    state.finishedAt = new Date().toISOString();
  });
  return { repo: sourceRepo, tag };
}

module.exports = {
  latestRelease,
  latestArmAsset,
  rolloutNativeHost,
  appliedVersions,
  start,
  status,
};
