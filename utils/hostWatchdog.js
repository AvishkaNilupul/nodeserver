// Keeps the bot hosts themselves honest: the layer under every other monitor.
//
// WHY THIS EXISTS (2026-09-11)
// The Pi lost power at 05:00 JST. It booted again at 06:19 and NOTHING came back
// for five hours, although 11 of the 13 dead containers were `restart=always`:
// the SD card had corrupted /usr/bin/containerd-shim-runc-v2 (2,013 bytes,
// same size — `dpkg --verify` flagged it) and every `docker start` died inside
// the shim with a Go runtime panic. Rent-farm buyers on twitchbotx30/31/37 were
// not farmed, and no alert fired, because every monitor we had looked only at
// RUNNING containers: botHealthMonitor skips unreachable hosts and stopped
// containers by design, and the system-health page never sends Telegram.
//
// So this watches the three things that failed, and fixes what it safely can:
//   1. Reachability — a host that stops answering is reported after
//      UNREACHABLE_TICKS consecutive misses, and again when it is back.
//   2. The container runtime — after every reboot (and every RUNTIME_RECHECK_MS)
//      `dpkg --verify` checks the Docker/containerd/runc package files and the
//      shim is executed once. A damaged file is restored from the IDENTICAL
//      package version in the host's own apt cache, and only when the restored
//      file's md5 equals the one dpkg recorded for it — a restore to
//      known-good, never an upgrade. Off with autoFarm.hostAutoRepair=false.
//   3. Dead bots Docker did not bring back — a bot container whose restart
//      policy says it should run (`always`, or `unless-stopped` for no-claim
//      bots), that is not running, and whose last exit was NOT a clean stop.
//      Every deliberate stop in this codebase either flips the policy to `no`
//      first (botWaker parks, stopIfNoAccounts) or is a `docker stop` (exit
//      143), so this set is exactly "died and was never restarted" — this
//      morning's 13, and never a bot somebody parked. They are started.
//      Off with autoFarm.hostAutoStart=false.
// Everything it does or cannot do goes to Telegram, once per state change.
// Whole thing off with autoFarm.hostWatchdog=false.
const hosts = require("./botHosts");
const settings = require("./settings");
const { sendTelegram } = require("./telegram");
const { logEvent } = require("./systemLog");

const TICK_MS = Number(process.env.HOST_WATCHDOG_MS) || 5 * 60 * 1000;
const FIRST_DELAY_MS = 90 * 1000;
const UNREACHABLE_TICKS = 3; // 15 min of silence before crying wolf
const RUNTIME_RECHECK_MS = 6 * 3600 * 1000;
// While the runtime is known to be broken, look again often: an operator's
// manual fix should be noticed (and the dead bots started) within minutes.
const RUNTIME_RECHECK_BROKEN_MS = 10 * 60 * 1000;
const START_GRACE_MS = 3 * 60 * 1000; // let Docker's own restart try first
const START_RETRY_MS = 15 * 60 * 1000; // per container
const START_MAX_PER_TICK = 25;
const REMIND_MS = 3 * 3600 * 1000;
const PROBE_TIMEOUT_MS = 20000;

const BOT_NAME = /^(twitchbot(x\d+)?|noclaim-bot-\d+)$/;
// Exit codes a deliberate stop produces: 0 (clean exit) and 143 (SIGTERM from
// `docker stop`). Everything else — 128 (runtime died under it), 137, 139, 255 —
// is a death.
const CLEAN_EXIT = new Set([0, 143]);

// Packages that make up the container runtime, under either packaging.
const RUNTIME_PKGS = [
  "containerd.io",
  "containerd",
  "runc",
  "docker-ce",
  "docker-ce-cli",
  "docker.io",
];

// ---------------------------------------------------------------- pure parts

function parseProbe(stdout) {
  const lines = String(stdout || "").trim().split("\n").map((s) => s.trim());
  const bootId = lines[0] || "";
  const uptimeS = Number.parseFloat(lines[1]);
  return {
    bootId: /^[0-9a-f-]{16,}$/i.test(bootId) ? bootId : "",
    uptimeS: Number.isFinite(uptimeS) ? uptimeS : null,
  };
}

// Output of VERIFY_SCRIPT: "PKGS <names>", "BAD <pkg> <path>", "SHIM ok|fail".
function parseVerify(stdout) {
  const out = { packages: [], damaged: [], shimOk: null };
  for (const raw of String(stdout || "").split("\n")) {
    const f = raw.split("\t");
    if (f[0] === "PKGS") out.packages = f.slice(1).join(" ").split(/\s+/).filter(Boolean);
    else if (f[0] === "BAD" && f[1] && f[2]) out.damaged.push({ pkg: f[1], path: f[2] });
    else if (f[0] === "SHIM") out.shimOk = f[1] === "ok";
  }
  return out;
}

function runtimeHealthy(v) {
  return !!v && v.damaged.length === 0 && v.shimOk !== false;
}

// Output of repairScript: one status line per file.
function parseRepair(stdout) {
  const out = { fixed: [], noDeb: [], mismatch: [], failed: [] };
  for (const raw of String(stdout || "").split("\n")) {
    const f = raw.split("\t");
    if (f[0] === "FIXED") out.fixed.push(f[1]);
    else if (f[0] === "NODEB") out.noDeb.push(f[1] + " (" + (f[2] || "") + ")");
    else if (f[0] === "MISMATCH") out.mismatch.push(f[1]);
    else if (f[0] === "FAIL") out.failed.push(f[1]);
  }
  return out;
}

// Output of INSPECT_SCRIPT: name|policy|running|restarting|exitCode|finishedAt
function parseInspect(stdout) {
  const rows = [];
  for (const raw of String(stdout || "").split("\n")) {
    const f = raw.trim().replace(/^\//, "").split("|");
    if (f.length < 6 || !f[0]) continue;
    const finished = new Date(f[5]);
    rows.push({
      name: f[0],
      policy: f[1],
      running: f[2] === "true",
      restarting: f[3] === "true",
      exitCode: Number.parseInt(f[4], 10),
      finishedAt: Number.isNaN(finished.getTime()) ? null : finished,
    });
  }
  return rows;
}

// Containers that should be running and are not because they DIED.
function deadBots(rows, now = Date.now()) {
  return rows.filter((r) => {
    // `restarting` = Docker is still handling it (a crash loop in back-off);
    // starting it by hand only fails with "container is restarting".
    if (!BOT_NAME.test(r.name) || r.running || r.restarting) return false;
    const wantsRun =
      r.policy === "always" ||
      (r.policy === "unless-stopped" && /^noclaim-bot-/.test(r.name));
    if (!wantsRun) return false;
    if (CLEAN_EXIT.has(r.exitCode)) return false;
    // A zero-value FinishedAt (never ran) is still a container that should.
    if (r.finishedAt && r.finishedAt.getTime() > 0 && now - r.finishedAt.getTime() < START_GRACE_MS) {
      return false;
    }
    return true;
  });
}

function jst(d) {
  const t = new Date(d instanceof Date ? d.getTime() : d);
  return new Date(t.getTime() + 9 * 3600 * 1000).toISOString().slice(5, 16).replace("T", " ") + " JST";
}

function humanMs(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  return m >= 90 ? (m / 60).toFixed(1) + "h" : m + "m";
}

// --------------------------------------------------------------- the scripts

const PROBE_SCRIPT = "cat /proc/sys/kernel/random/boot_id; cut -d' ' -f1 /proc/uptime";

// `dpkg --verify` prints "??5?????? c /etc/x" for config files (edited on
// purpose, ignored) and "??5??????   /usr/bin/x" for everything else; the third
// flag is the md5 check. "missing" means the file is gone. No sudo needed.
const VERIFY_AWK =
  '$2 != "c" && (substr($1,3,1) == "5" || $1 == "missing") { printf "BAD\\t%s\\t%s\\n", p, $NF }';
const VERIFY_SCRIPT = [
  "pk=''",
  "for p in " + RUNTIME_PKGS.join(" ") + "; do",
  "  dpkg-query -W -f='${Status}' \"$p\" 2>/dev/null | grep -q 'install ok installed' && pk=\"$pk $p\"",
  "done",
  "printf 'PKGS\\t%s\\n' \"$pk\"",
  "for p in $pk; do",
  "  dpkg --verify \"$p\" 2>/dev/null | awk -v p=\"$p\" " + hosts.shq(VERIFY_AWK),
  "done",
  "s=$(command -v containerd-shim-runc-v2 2>/dev/null)",
  "if [ -n \"$s\" ]; then if \"$s\" -v >/dev/null 2>&1; then printf 'SHIM\\tok\\n'; else printf 'SHIM\\tfail\\n'; fi; fi",
].join("\n");

// Restore each damaged file from the apt cache .deb of the INSTALLED version,
// only when the extracted copy matches dpkg's recorded md5. The damaged copy is
// kept beside the extraction for a post-mortem. `dryRun` does every step except
// the install itself (it prints what it would install) — how the pipeline is
// proven against a live host without writing a system file.
function repairScript(damaged, { dryRun = false } = {}) {
  const lines = [
    "T=$(mktemp -d /tmp/rtrepair.XXXXXX) || exit 1",
    dryRun
      ? "S='echo WOULD-RUN'"
      : "if [ \"$(id -u)\" = 0 ]; then S=''; else S='sudo -n'; fi",
  ];
  const byPkg = new Map();
  for (const d of damaged) {
    if (!byPkg.has(d.pkg)) byPkg.set(d.pkg, []);
    byPkg.get(d.pkg).push(d.path);
  }
  for (const [pkg, paths] of byPkg) {
    const p = hosts.shq(pkg);
    lines.push(
      "v=$(dpkg-query -W -f='${Version}' " + p + "); a=$(dpkg-query -W -f='${Architecture}' " + p + ")",
      "deb=/var/cache/apt/archives/" + pkg + "_$(printf %s \"$v\" | sed 's/:/%3a/')_${a}.deb",
      "m=/var/lib/dpkg/info/" + pkg + ".md5sums; [ -f \"$m\" ] || m=/var/lib/dpkg/info/" + pkg + ":${a}.md5sums",
      "if [ ! -f \"$deb\" ]; then printf 'NODEB\\t%s\\t%s\\n' " + p + " \"$deb\"; else",
      "  mkdir -p \"$T\"/" + p + " && dpkg-deb -x \"$deb\" \"$T\"/" + p,
    );
    for (const path of paths) {
      const q = hosts.shq(path);
      const rel = hosts.shq(String(path).replace(/^\//, ""));
      lines.push(
        "  want=$(awk -v r=" + rel + " '$2 == r { print $1 }' \"$m\"); got=$(md5sum \"$T\"/" + p + "/" + rel + " 2>/dev/null | cut -d' ' -f1)",
        "  if [ -n \"$want\" ] && [ \"$want\" = \"$got\" ]; then",
        "    cp -p " + q + " \"$T/damaged.$(basename " + q + ")\" 2>/dev/null",
        "    if $S install -m \"$(stat -c %a \"$T\"/" + p + "/" + rel + ")\" -o root -g root \"$T\"/" + p + "/" + rel + " " + q + "; then printf 'FIXED\\t%s\\n' " + q + "; else printf 'FAIL\\t%s\\n' " + q + "; fi",
        "  else printf 'MISMATCH\\t%s\\n' " + q + "; fi",
      );
    }
    lines.push("fi");
  }
  return lines.join("\n");
}

const INSPECT_SCRIPT =
  "docker ps -a --format '{{.Names}}' | grep -E '^(twitchbot(x[0-9]+)?|noclaim-bot-[0-9]+)$' | " +
  "xargs -r docker inspect -f '{{.Name}}|{{.HostConfig.RestartPolicy.Name}}|{{.State.Running}}|{{.State.Restarting}}|{{.State.ExitCode}}|{{.State.FinishedAt}}'";

// ---------------------------------------------------------------- the loop

const hostState = new Map();
let timer = null;
let lastTick = null;

function st(id) {
  if (!hostState.has(id)) {
    hostState.set(id, {
      misses: 0,
      downSince: null,
      downAlerted: false,
      bootId: "",
      bootAt: null,
      runtimeCheckedAt: 0,
      runtimeOk: null,
      runtimeAlertedAt: 0,
      repairedBootId: "",
      startTries: new Map(),
      startFailAlertedAt: 0,
    });
  }
  return hostState.get(id);
}

function cfg() {
  const af = settings.getAutoFarm() || {};
  return {
    enabled: af.hostWatchdog !== false,
    repair: af.hostAutoRepair !== false,
    start: af.hostAutoStart !== false,
  };
}

function record(dry, fields) {
  if (dry) return;
  logEvent(fields);
}

async function say(text, dry) {
  if (dry) {
    console.log("[hostWatchdog dry] " + text);
    return;
  }
  await sendTelegram(text).catch(() => {});
}

async function checkRuntime(host, s, { dry, reason }) {
  let v;
  try {
    const { stdout } = await hosts.runShell(host, VERIFY_SCRIPT, { timeout: 120000 });
    v = parseVerify(stdout);
  } catch (e) {
    return { ok: null, error: String((e && e.message) || e).slice(0, 200) };
  }
  s.runtimeCheckedAt = Date.now();
  const ok = runtimeHealthy(v);
  const was = s.runtimeOk;
  s.runtimeOk = ok;
  if (ok) {
    if (was === false) {
      await say("✅ " + host.label + ": container runtime verified healthy again.", dry);
    }
    return { ok: true, verify: v };
  }

  const files = v.damaged.map((d) => d.path);
  record(dry, {
    category: "bots",
    action: "host_runtime_damaged",
    actor: "hostWatchdog",
    severity: "error",
    host: host.id,
    detail: (reason || "") + " damaged: " + files.join(", ") + (v.shimOk === false ? " (shim will not execute)" : ""),
  });

  let repaired = null;
  if (cfg().repair && v.damaged.length && s.repairedBootId !== s.bootId && !dry) {
    s.repairedBootId = s.bootId; // once per boot, whatever happens
    try {
      const { stdout } = await hosts.runShell(host, repairScript(v.damaged), { timeout: 180000 });
      repaired = parseRepair(stdout);
    } catch (e) {
      repaired = { fixed: [], noDeb: [], mismatch: [], failed: [String((e && e.message) || e).slice(0, 160)] };
    }
    const after = await hosts
      .runShell(host, VERIFY_SCRIPT, { timeout: 120000 })
      .then((r) => parseVerify(r.stdout))
      .catch(() => null);
    s.runtimeOk = runtimeHealthy(after);
    record(dry, {
      category: "bots",
      action: "host_runtime_repair",
      actor: "hostWatchdog",
      severity: s.runtimeOk ? "warn" : "error",
      host: host.id,
      detail: JSON.stringify({ repaired, healthyAfter: s.runtimeOk }).slice(0, 900),
    });
  }

  if (repaired && s.runtimeOk) {
    await say(
      "🛠 " + host.label + ": the container runtime was DAMAGED (" + files.join(", ") +
        ") — restored " + repaired.fixed.length + " file(s) from the host's own apt cache " +
        "(same version, checksum-verified). Docker can start containers again; dead bots are " +
        "being restarted.",
      dry,
    );
  } else if (Date.now() - s.runtimeAlertedAt > REMIND_MS || was !== false) {
    s.runtimeAlertedAt = Date.now();
    await say(
      "🔴 " + host.label + ": the container runtime is DAMAGED — Docker cannot start bots. " +
        "Bad file(s): " + (files.join(", ") || "(shim will not execute)") + ". " +
        (repaired
          ? "Automatic restore did not complete (" +
            [
              repaired.noDeb.length ? "no cached package: " + repaired.noDeb.join(", ") : "",
              repaired.mismatch.length ? "checksum mismatch: " + repaired.mismatch.join(", ") : "",
              repaired.failed.length ? "failed: " + repaired.failed.join(", ") : "",
            ].filter(Boolean).join("; ") +
            "). "
          : "") +
        "Fix: reinstall the package (sudo apt-get install --reinstall " +
        [...new Set(v.damaged.map((d) => d.pkg))].join(" ") + "), then start the bots.",
      dry,
    );
  }
  return { ok: s.runtimeOk, verify: v, repaired };
}

async function restartDeadBots(host, s, { dry }) {
  let rows;
  try {
    const { stdout } = await hosts.runShell(host, INSPECT_SCRIPT, { timeout: 60000 });
    rows = parseInspect(stdout);
  } catch {
    return; // a failed read is not evidence of anything
  }
  const now = Date.now();
  const dead = deadBots(rows, now).filter((r) => {
    const t = s.startTries.get(r.name);
    return !t || now - t >= START_RETRY_MS;
  });
  if (!dead.length || !cfg().start) return;

  const started = [];
  const failed = [];
  for (const r of dead.slice(0, START_MAX_PER_TICK)) {
    s.startTries.set(r.name, now);
    if (dry) {
      started.push(r.name + " (dry)");
      continue;
    }
    try {
      await hosts.dockerContainer(host, "start", r.name);
      started.push(r.name);
    } catch (e) {
      failed.push({ name: r.name, error: String((e && e.message) || e).split("\n")[0].slice(0, 180) });
      // The first failure says it all when the runtime itself is broken; do not
      // hammer the rest of the list against the same error.
      if (failed.length >= 2 && !started.length) break;
    }
  }
  if (started.length) {
    record(dry, {
      category: "bots",
      action: "dead_bots_restarted",
      actor: "hostWatchdog",
      severity: "warn",
      host: host.id,
      count: started.length,
      detail: started.join(", "),
    });
    await say(
      "🔄 " + host.label + ": restarted " + started.length + " bot(s) that had died and Docker " +
        "had not brought back: " + started.join(", ") + ".",
      dry,
    );
  }
  if (failed.length) {
    record(dry, {
      category: "bots",
      action: "dead_bots_start_failed",
      actor: "hostWatchdog",
      severity: "error",
      host: host.id,
      count: failed.length,
      detail: failed.map((f) => f.name + ": " + f.error).join(" | ").slice(0, 900),
    });
    // A start that fails is the loudest possible hint that the runtime is
    // broken — check (and repair) it right away instead of in six hours.
    s.runtimeCheckedAt = 0;
    if (now - s.startFailAlertedAt > REMIND_MS) {
      s.startFailAlertedAt = now;
      await say(
        "🔴 " + host.label + ": " + dead.length + " bot(s) are down and could NOT be started (" +
          failed.map((f) => f.name).join(", ") + "): " + failed[0].error,
        dry,
      );
    }
  }
}

async function checkHost(host, { dry = false } = {}) {
  const s = st(host.id);
  const now = Date.now();
  let probe;
  try {
    const { stdout } = await hosts.runShell(host, PROBE_SCRIPT, { timeout: PROBE_TIMEOUT_MS });
    probe = parseProbe(stdout);
    if (!probe.bootId) throw new Error("no boot id in probe output");
  } catch (e) {
    s.misses++;
    if (!s.downSince) s.downSince = now;
    if (s.misses >= UNREACHABLE_TICKS && !s.downAlerted) {
      s.downAlerted = true;
      record(dry, { category: "bots", action: "host_unreachable", actor: "hostWatchdog", severity: "error", host: host.id, detail: String((e && e.message) || e).slice(0, 200) });
      await say(
        "🔴 " + host.label + " has not answered since " + jst(s.downSince) +
          " — every bot on it (rent-farm stacks included) has stopped farming. " +
          "Likely power or network at the host.",
        dry,
      );
    }
    return { reachable: false };
  }

  if (s.downAlerted) {
    await say("✅ " + host.label + " is answering again (down " + humanMs(now - s.downSince) + ").", dry);
    record(dry, { category: "bots", action: "host_reachable", actor: "hostWatchdog", host: host.id, detail: "back after " + humanMs(now - s.downSince) });
  }
  s.misses = 0;
  s.downSince = null;
  s.downAlerted = false;

  // A new boot: the boot id changed, or this is the first look since our own
  // start and the host came up recently. Either way the runtime is re-verified
  // before anything else, because a boot is when a damaged file bites.
  const bootAt = probe.uptimeS != null ? new Date(now - probe.uptimeS * 1000) : null;
  const newBoot = s.bootId ? probe.bootId !== s.bootId : probe.uptimeS != null && probe.uptimeS < 3 * 3600;
  if (newBoot && s.bootId) {
    await say("ℹ️ " + host.label + " rebooted at " + (bootAt ? jst(bootAt) : "?") + ". Checking its container runtime and bots.", dry);
    record(dry, { category: "bots", action: "host_rebooted", actor: "hostWatchdog", host: host.id, detail: "booted " + (bootAt ? bootAt.toISOString() : "?") });
  }
  s.bootId = probe.bootId;
  s.bootAt = bootAt;

  let runtime = null;
  const recheckEvery = s.runtimeOk === false ? RUNTIME_RECHECK_BROKEN_MS : RUNTIME_RECHECK_MS;
  if (newBoot || now - s.runtimeCheckedAt >= recheckEvery) {
    runtime = await checkRuntime(host, s, { dry, reason: newBoot ? "after boot" : "periodic" });
    // One line per runtime check (every few hours) so the logs show the
    // watchdog is alive even when there is nothing to report.
    console.log(
      "hostWatchdog: " + host.id + " reachable, booted " + (bootAt ? jst(bootAt) : "?") +
        ", container runtime " +
        (runtime.ok === true ? "verified ok" : runtime.ok === false ? "DAMAGED" : "unreadable (" + (runtime.error || "?") + ")"),
    );
  }
  // Never start bots against a runtime known to be broken — it only produces
  // the same panic N times. A repaired runtime has runtimeOk=true by now.
  if (s.runtimeOk !== false) await restartDeadBots(host, s, { dry });
  return { reachable: true, newBoot, runtime };
}

async function tick({ dry = false } = {}) {
  lastTick = new Date();
  if (!cfg().enabled) return { skipped: "off" };
  const out = {};
  for (const h of hosts.listHosts()) {
    const host = hosts.resolveHost(h.id);
    if (!host || host.runtime === "native") continue;
    try {
      out[h.id] = await checkHost(host, { dry });
    } catch (e) {
      out[h.id] = { error: String((e && e.message) || e).slice(0, 200) };
    }
  }
  return out;
}

function start() {
  if (timer) return;
  const loop = () => {
    tick()
      .catch((e) => console.error("hostWatchdog:", e.message))
      .finally(() => {
        timer = setTimeout(loop, TICK_MS);
        if (timer.unref) timer.unref();
      });
  };
  timer = setTimeout(loop, FIRST_DELAY_MS);
  if (timer.unref) timer.unref();
}

function status() {
  const hostsOut = {};
  for (const [id, s] of hostState) {
    hostsOut[id] = {
      reachable: !s.downSince,
      downSince: s.downSince ? new Date(s.downSince).toISOString() : null,
      bootAt: s.bootAt ? s.bootAt.toISOString() : null,
      runtimeOk: s.runtimeOk,
      runtimeCheckedAt: s.runtimeCheckedAt ? new Date(s.runtimeCheckedAt).toISOString() : null,
    };
  }
  return { lastTick, tickMs: TICK_MS, hosts: hostsOut };
}

module.exports = {
  start,
  tick,
  status,
  // pure, for tests
  parseProbe,
  parseVerify,
  parseRepair,
  parseInspect,
  deadBots,
  runtimeHealthy,
  repairScript,
  VERIFY_AWK,
  VERIFY_SCRIPT,
  PROBE_SCRIPT,
  INSPECT_SCRIPT,
  START_GRACE_MS,
};
