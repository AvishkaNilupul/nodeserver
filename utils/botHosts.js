// Multi-host bot management.
//
// Historically the Bots page managed a single set of TwitchDropsBot instances
// that lived on the SAME machine as this node server: config files in a local
// directory (BOT_DIR) and docker containers controlled with a local `docker`
// command. This module generalises "where a bot lives" into a HOST so the same
// page can also manage bots running on a remote machine (e.g. a Raspberry Pi)
// reached over SSH.
//
// There is always an implicit `local` host (the server itself). Additional
// hosts are declared in config/botHosts.json (see config/botHosts.example.json)
// or via the BOT_HOSTS env var (same JSON shape). Each remote host runs its
// commands over SSH; the file/docker operations exposed here are otherwise
// identical to the local ones, so the routes can stay host-agnostic.
//
// A host may also declare `"runtime": "native"` for machines that can't run
// Docker. Native hosts run their bots as plain processes managed by a `botctl`
// shell script in the host's bot directory; botctl speaks the same vocabulary
// as docker — ps / start / stop / restart / rm / logs / stats / policy — so
// every docker* function here simply dispatches to it and the routes stay
// unchanged. Native hosts have no compose file (composeName returns null); bots
// are discovered from the config_NN.json files directly.
//
// NO host currently uses this. It was built for an Android/Termux phone host,
// retired 2026-08-11 (its accounts moved to the Pi). The branches are kept
// because they are generic and inert without a `native` host in the config —
// but nothing exercises them, so treat them as untested if one comes back.
// The `botctl` script itself is no longer in this repo either; recover it from
// git history (scripts/botctl, removed in the same commit) to set one up.

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const zlib = require("zlib");
const { execFile } = require("child_process");

// Reuse a single SSH connection across the many short-lived commands the Bots
// page fires per refresh (list, status, file reads, stats). Without this each
// command pays a full TCP+SSH handshake (~hundreds of ms each, over the
// internet); with ControlMaster the first connection is kept alive and the
// rest piggyback on it, making the Raspberry Pi tab feel near-instant.
const SSH_CONTROL_PATH = path.join(os.tmpdir(), "redeemhub-ssh-%C");

// Local bot directory (unchanged default + override). The implicit `local`
// host points at this.
const BOT_DIR = process.env.TWITCHBOT_DIR || "/root/twitchbot";

const COMPOSE_NAMES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
];

const EXEC_TIMEOUT = 60000;
// Budget for a "quick" remote read (ls, cat, docker ps).
//
// This was 8s — the SAME value as the SSH ConnectTimeout below, which made a
// read structurally impossible on a slow link: the handshake alone could eat
// the entire budget, leaving nothing for the command itself. Measured on the
// Pi 2026-07-29 while it was struggling: 4.75 SECOND round-trip time and 66%
// packet loss, at which point 5 of 6 SSH attempts failed and whole auto-farm
// ticks were being written off as "host unreachable".
//
// These bots live on a Raspberry Pi at the end of a home connection reached
// over Tailscale, so multi-second latency is a normal condition to tolerate,
// not an exception. Generous timeouts cost nothing when the link is healthy —
// the connection is multiplexed (ControlMaster/ControlPersist), so only the
// first command pays the handshake at all.
const SHORT_TIMEOUT = 30000;

// ----------------------------------------------------------------------------
// Host registry
// ----------------------------------------------------------------------------

function loadConfiguredHosts() {
  // BOT_HOSTS (inline JSON) wins over the file so a deployment can override
  // without shipping a file. Either may hold an array or { hosts: [...] }.
  let raw = null;
  if (process.env.BOT_HOSTS) {
    raw = process.env.BOT_HOSTS;
  } else {
    const file =
      process.env.BOT_HOSTS_FILE ||
      path.join(__dirname, "..", "config", "botHosts.json");
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") {
        console.error("botHosts: failed to read host config:", e.message);
      }
      return [];
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error("botHosts: host config is not valid JSON:", e.message);
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : parsed && parsed.hosts;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const h of list) {
    if (!h || typeof h !== "object") continue;
    const id = String(h.id || "").trim();
    // `local` is reserved for the implicit server host.
    if (!id || id === "local" || !/^[a-z0-9_-]{1,32}$/i.test(id)) {
      if (id === "local") {
        console.error('botHosts: ignoring host with reserved id "local"');
      } else if (id) {
        console.error("botHosts: ignoring host with invalid id:", id);
      }
      continue;
    }
    const dir = String(h.dir || "").trim();
    if (!dir) {
      console.error("botHosts: ignoring host without dir:", id);
      continue;
    }
    const ssh = h.ssh && typeof h.ssh === "object" ? h.ssh : null;
    if (!ssh || !ssh.target) {
      console.error("botHosts: ignoring host without ssh.target:", id);
      continue;
    }
    const runtime = h.runtime === "native" ? "native" : "docker";
    out.push({
      id,
      label: String(h.label || id),
      transport: "ssh",
      runtime,
      dir,
      ssh: {
        target: String(ssh.target),
        identityFile: ssh.identityFile ? String(ssh.identityFile) : null,
        port: ssh.port ? parseInt(ssh.port, 10) : null,
        options: Array.isArray(ssh.options) ? ssh.options.map(String) : [],
      },
    });
  }
  return out;
}

const LOCAL_HOST = {
  id: "local",
  label: "Server",
  transport: "local",
  runtime: "docker",
  dir: BOT_DIR,
};

// Loaded once at startup; host config rarely changes and a restart picks it up.
const REMOTE_HOSTS = loadConfiguredHosts();
const ALL_HOSTS = [LOCAL_HOST, ...REMOTE_HOSTS];
const HOST_BY_ID = new Map(ALL_HOSTS.map((h) => [h.id, h]));

function listHosts() {
  return ALL_HOSTS.map((h) => ({
    id: h.id,
    label: h.label,
    transport: h.transport,
    runtime: h.runtime || "docker",
    dir: h.dir,
  }));
}

// Resolve a requested host id to a host object. Empty / missing defaults to the
// local host so existing callers (and old URLs without ?host=) keep working.
function resolveHost(id) {
  if (id === undefined || id === null || id === "") return LOCAL_HOST;
  return HOST_BY_ID.get(String(id)) || null;
}

// ----------------------------------------------------------------------------
// SSH plumbing
// ----------------------------------------------------------------------------

// Single-quote a string for safe interpolation into a remote /bin/sh command.
function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function sshBaseArgs(host) {
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    // Must comfortably exceed several round trips on a congested home link
    // (see SHORT_TIMEOUT). At 8s a 4.75s-RTT link could not complete a
    // handshake at all.
    "ConnectTimeout=20",
    "-o",
    "ControlMaster=auto",
    "-o",
    "ControlPath=" + SSH_CONTROL_PATH,
    "-o",
    // How long the multiplexed master lingers after the last command. This was
    // 60s, which is shorter than the gap between visits to a page: opening
    // /renters.html a minute after the previous look always paid the full cold
    // handshake again. Measured on the Pi over Tailscale 2026-08-11: 2975ms
    // cold vs 565ms on a warm master. Ten minutes keeps the socket alive across
    // a normal working session; ServerAliveInterval below still tears down a
    // master whose link actually died, so a longer persist cannot wedge later
    // commands.
    "ControlPersist=600",
    // Kill a session whose link has died instead of holding the slot until the
    // command timeout fires — with multiplexing, one wedged master would
    // otherwise stall every later command queued behind it.
    "-o",
    "ServerAliveInterval=5",
    "-o",
    "ServerAliveCountMax=3",
  ];
  if (host.ssh.identityFile) args.push("-i", host.ssh.identityFile);
  if (host.ssh.port) args.push("-p", String(host.ssh.port));
  for (const opt of host.ssh.options) args.push(opt);
  args.push(host.ssh.target);
  return args;
}

// Run a /bin/sh command string on a remote host. Resolves with
// { stdout, stderr }; rejects with an Error carrying .code (exit code),
// .stderr and .unreachable (true when the SSH transport itself failed, as
// opposed to the remote command returning non-zero).
function sshRun(host, command, { input, timeout = EXEC_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    const args = [...sshBaseArgs(host), command];
    const child = execFile(
      "ssh",
      args,
      { timeout, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const e = new Error((stderr || err.message || "").trim());
          e.code = typeof err.code === "number" ? err.code : null;
          e.stderr = stderr || "";
          // ssh exits 255 when it can't establish the connection at all.
          e.unreachable = err.code === 255 || err.killed === true;
          return reject(e);
        }
        resolve({ stdout, stderr });
      },
    );
    if (input !== undefined && child.stdin) {
      child.stdin.end(input);
    }
  });
}

function localRun(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        timeout: opts.timeout || EXEC_TIMEOUT,
        maxBuffer: 8 * 1024 * 1024,
        cwd: opts.cwd,
      },
      (err, stdout, stderr) => {
        if (err) {
          const e = new Error((stderr || err.message || "").trim());
          e.code = typeof err.code === "number" ? err.code : null;
          e.stderr = stderr || "";
          return reject(e);
        }
        resolve({ stdout, stderr });
      },
    );
    if (opts.input !== undefined && child.stdin) {
      child.stdin.end(opts.input);
    }
  });
}

// ----------------------------------------------------------------------------
// File operations (host-aware)
// ----------------------------------------------------------------------------

function remotePath(host, file) {
  // host.dir + file, joined with POSIX semantics (remote is always *nix).
  return path.posix.join(host.dir, file);
}

// Retry a READ-ONLY host operation when the SSH transport itself failed.
//
// The Pi is reached over Tailscale across a home connection and drops the odd
// connection under load — the auto-farm tick, the drop scanner and the park
// sweep all talk to it at once. Observed twice on 2026-07-29: a `ls` failed at
// the top of a tick (recording ~30 campaigns as "host unreachable"), and later
// one failed mid-execution and killed a farm that had already been decided.
// Both times the host answered again seconds afterwards.
//
// Applied ONLY to reads. `e.unreachable` covers a connection that never landed
// as well as one killed by timeout, and for a read either way it is always safe
// to simply ask again — which is not true of writes or docker actions, so those
// deliberately keep failing fast.
const READ_RETRIES = 2;
const READ_RETRY_DELAY_MS = 1500;

async function retryRead(fn, retries = READ_RETRIES) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      // A real answer from the far side (missing file, bad path) is final.
      if (!e || !e.unreachable) throw e;
      last = e;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, READ_RETRY_DELAY_MS));
      }
    }
  }
  throw last;
}

// List a host's bot directory.
//
// The defaults are the patient ones above — right for anything that must not
// lose a config to a momentary flap. A caller that is merely populating a
// picker can pass a smaller budget instead: a host that is genuinely OFF never
// answers, so patience there costs the full 3 attempts x 20s connect timeout
// (63s measured with the phone host down on 2026-08-11) and every caller behind
// it waits out that proof. `timeout` is enforced by killing the ssh process, so
// it bounds the wall clock regardless of ConnectTimeout.
async function readdir(host, opts) {
  const { timeout = SHORT_TIMEOUT, retries = READ_RETRIES } =
    opts && typeof opts === "object" ? opts : {};
  if (host.transport === "local") {
    return fsp.readdir(host.dir);
  }
  return retryRead(async () => {
    try {
      const { stdout } = await sshRun(host, "ls -1 -- " + shq(host.dir), {
        timeout,
      });
      return stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    } catch (e) {
      if (/No such file|not found/i.test(e.stderr || e.message || "")) {
        const err = new Error(e.message);
        err.code = "ENOENT";
        throw err;
      }
      throw e;
    }
  }, retries);
}

async function readFile(host, file) {
  if (host.transport === "local") {
    return fsp.readFile(path.join(host.dir, file), "utf8");
  }
  return retryRead(async () => {
    try {
      const { stdout } = await sshRun(
        host,
        "cat -- " + shq(remotePath(host, file)),
        {
          timeout: SHORT_TIMEOUT,
        },
      );
      return stdout;
    } catch (e) {
      if (/No such file/i.test(e.stderr || e.message || "")) {
        const err = new Error("Not found");
        err.code = "ENOENT";
        throw err;
      }
      throw e;
    }
  });
}

// Read MANY files in one go. Returns { [file]: { ok: true, text } | { ok:
// false, error } } — one entry per requested file, never throwing for a single
// bad file so one unreadable config cannot cost the whole listing.
//
// Why this exists: reading the Pi's 27 configs one `cat` at a time took 110s
// end to end, which is what left the Bots page sitting on "Loading…" for
// minutes. Two separate costs had to go:
//
//   * Latency. Each round trip over the Pi's home link costs ~2s, so 27 reads
//     is a minute before any work happens. One command covers the whole set.
//   * Bandwidth. Those configs are 627KB of very repetitive JSON, and the Pi's
//     uplink is slow enough that even a single raw transfer took 31s. Piping
//     the WHOLE batch through one gzip (rather than compressing each file
//     separately) shares one dictionary across all of them: 847KB -> 204KB,
//     and 31s -> ~2s. Measured against the live Pi 2026-07-30.
//
// The stream is a sequence of `\n<nonce> ok <file>\n<contents>` records, gzipped
// and base64-armoured so it survives the SSH text channel. The nonce is random
// per call, so no file body can forge a record header. If the remote lacks gzip
// or base64 the whole command fails and we fall back to reading one at a time —
// slow, but the page still gets its data.
const READ_FILES_CHUNK = 50;

async function readFilesOneByOne(host, files, out) {
  for (const f of files) {
    try {
      out[f] = { ok: true, text: await readFile(host, f) };
    } catch (e) {
      if (e && e.unreachable) throw e;
      out[f] = {
        ok: false,
        error: e.code === "ENOENT" ? "Not found" : e.message,
      };
    }
  }
  return out;
}

async function readFiles(host, files) {
  const out = {};
  if (!files || !files.length) return out;
  if (host.transport === "local") {
    await Promise.all(
      files.map(async (f) => {
        try {
          out[f] = {
            ok: true,
            text: await fsp.readFile(path.join(host.dir, f), "utf8"),
          };
        } catch (e) {
          out[f] = {
            ok: false,
            error: e.code === "ENOENT" ? "Not found" : e.message,
          };
        }
      }),
    );
    return out;
  }

  for (let i = 0; i < files.length; i += READ_FILES_CHUNK) {
    const chunk = files.slice(i, i + READ_FILES_CHUNK);
    const nonce =
      "BOTCFG" + Math.random().toString(36).slice(2, 12).toUpperCase();
    const mark = (state) =>
      "printf '\\n%s " + state + " %s\\n' " + shq(nonce) + ' "$f"';
    const script =
      "cd " +
      shq(host.dir) +
      " || exit 1\n" +
      "{ for f in " +
      chunk.map(shq).join(" ") +
      "; do\n" +
      '  if [ -r "$f" ]; then ' +
      mark("ok") +
      '; cat -- "$f";\n' +
      "  else " +
      mark("err") +
      "; fi\n" +
      "done; } | gzip -c | base64\n";
    let stdout;
    try {
      ({ stdout } = await retryRead(() =>
        sshRun(host, script, { timeout: EXEC_TIMEOUT }),
      ));
    } catch (e) {
      // A host outage is not a per-file problem — let it propagate so callers
      // can mark the host offline. Anything else (no gzip, no base64, a shell
      // that choked) falls back to the slow path rather than failing the page.
      if (e && e.unreachable) throw e;
      await readFilesOneByOne(host, chunk, out);
      continue;
    }

    let text;
    try {
      text = zlib
        .gunzipSync(Buffer.from(stdout.replace(/\s+/g, ""), "base64"))
        .toString("utf8");
    } catch {
      // Truncated or non-gzip output (a shell banner, a partial transfer).
      await readFilesOneByOne(host, chunk, out);
      continue;
    }

    // Records are delimited by a marker LINE. Content is every line after a
    // marker up to the next one; joining them with "\n" reproduces the file
    // byte for byte, because the newline printf writes before each marker is
    // exactly the one consumed as the split boundary.
    let cur = null;
    let buf = [];
    const flush = () => {
      if (!cur) return;
      out[cur.file] = cur.ok
        ? { ok: true, text: buf.join("\n") }
        : { ok: false, error: "Not found" };
      cur = null;
      buf = [];
    };
    for (const line of text.split("\n")) {
      if (line.startsWith(nonce + " ")) {
        const rest = line.slice(nonce.length + 1);
        const sp = rest.indexOf(" ");
        const state = sp === -1 ? "" : rest.slice(0, sp);
        if (state === "ok" || state === "err") {
          flush();
          cur = { ok: state === "ok", file: rest.slice(sp + 1) };
          continue;
        }
      }
      if (cur && cur.ok) buf.push(line);
    }
    flush();
    // A file the remote never mentioned (marker lost, truncated output).
    for (const f of chunk) {
      if (!out[f]) out[f] = { ok: false, error: "no response for this file" };
    }
  }
  return out;
}

async function exists(host, file) {
  if (host.transport === "local") {
    return fs.existsSync(path.join(host.dir, file));
  }
  try {
    await sshRun(host, "test -e " + shq(remotePath(host, file)), {
      timeout: SHORT_TIMEOUT,
    });
    return true;
  } catch (e) {
    if (e.unreachable) throw e;
    return false;
  }
}

// Write `text` to <dir>/<file> atomically (temp file + rename), keeping a .bak
// copy of any previous version — matching the local behaviour the routes relied
// on before, but for either transport.
async function writeFileAtomic(host, file, text) {
  await writeFileRaw(host, file, text);
  // An account may only be enabled in one config per host — strip stale copies
  // left in sibling configs (utils/dupeGuard.js).
  try {
    const guard = require("./dupeGuard");
    await guard.enforceSingleHome(module.exports, host, file, text);
  } catch (e) {
    console.error("[botHosts] dupe guard error: " + e.message);
  }
}
async function writeFileRaw(host, file, text) {
  if (host.transport === "local") {
    const full = path.join(host.dir, file);
    try {
      const cur = await fsp.readFile(full, "utf8");
      await fsp.writeFile(full + ".bak", cur, "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const tmp = full + ".tmp-" + process.pid;
    await fsp.writeFile(tmp, text, "utf8");
    await fsp.rename(tmp, full);
    return;
  }
  const dest = remotePath(host, file);
  const tmp = dest + ".tmp-" + process.pid;
  const bak = dest + ".bak";
  // Single remote shell: back up existing file (best effort), then read stdin
  // into a temp file and atomically move it into place.
  const cmd =
    "[ -f " +
    shq(dest) +
    " ] && cp -f " +
    shq(dest) +
    " " +
    shq(bak) +
    "; " +
    "cat > " +
    shq(tmp) +
    " && mv -f " +
    shq(tmp) +
    " " +
    shq(dest);
  await sshRun(host, cmd, { input: text });
}

async function rename(host, from, to) {
  if (host.transport === "local") {
    return fsp.rename(path.join(host.dir, from), path.join(host.dir, to));
  }
  await sshRun(
    host,
    "mv -f -- " + shq(remotePath(host, from)) + " " + shq(remotePath(host, to)),
  );
}

// ----------------------------------------------------------------------------
// Compose-file operations (raw read/write; YAML editing stays in the route)
// ----------------------------------------------------------------------------

// Name of the compose file present in the host dir, or null if none.
// Native hosts have no compose file by design.
async function composeName(host) {
  if (isNative(host)) return null;
  for (const name of COMPOSE_NAMES) {
    if (await exists(host, name)) return name;
  }
  return null;
}

async function composeRead(host, name) {
  return readFile(host, name);
}

async function composeWrite(host, name, text) {
  return writeFileAtomic(host, name, text);
}

// ----------------------------------------------------------------------------
// Native runtime (botctl) plumbing
// ----------------------------------------------------------------------------

const isNative = (host) => host.runtime === "native";

// Run `botctl <args>` in the host's bot directory. botctl is a plain sh
// script, so this works on anything with a POSIX shell.
async function botctl(host, args, { timeout = EXEC_TIMEOUT } = {}) {
  const script =
    "sh " +
    shq(path.posix.join(host.dir, "botctl")) +
    " " +
    args.map(shq).join(" ");
  const { stdout } = await runShell(host, script, { timeout });
  return stdout;
}

// ----------------------------------------------------------------------------
// Docker operations (host-aware)
// ----------------------------------------------------------------------------

// `docker ps -a`, parsed into { name: { state, status } }.
async function dockerPs(host) {
  if (isNative(host)) {
    const stdout = await botctl(host, ["ps"], { timeout: SHORT_TIMEOUT });
    const states = {};
    stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .forEach((line) => {
        const [name, state, status] = line.split("\t");
        if (name) states[name] = { state, status };
      });
    return states;
  }
  const fmt = "{{.Names}}\t{{.State}}\t{{.Status}}";
  let stdout;
  if (host.transport === "local") {
    ({ stdout } = await localRun("docker", ["ps", "-a", "--format", fmt], {
      timeout: SHORT_TIMEOUT,
    }));
  } else {
    // Read-only: safe to re-ask when the link drops (see retryRead).
    ({ stdout } = await retryRead(() =>
      sshRun(host, "docker ps -a --format " + shq(fmt), {
        timeout: SHORT_TIMEOUT,
      }),
    ));
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
  return states;
}

// Run a single-container docker verb (restart/start/stop/rm -f).
async function dockerContainer(host, action, container) {
  if (isNative(host)) {
    return (await botctl(host, [action, container])).trim();
  }
  const args = action === "rm" ? ["rm", "-f", container] : [action, container];
  if (host.transport === "local") {
    const { stdout } = await localRun("docker", args);
    return stdout.trim();
  }
  const { stdout } = await sshRun(host, "docker " + args.map(shq).join(" "));
  return stdout.trim();
}

// Bring a single service up (-d) using whichever compose CLI the host has.
// Detection is cached per host id.
const _composeCmd = new Map();
async function detectComposeCmd(host) {
  if (_composeCmd.has(host.id)) return _composeCmd.get(host.id);
  let cmd;
  try {
    if (host.transport === "local") {
      await localRun("docker", ["compose", "version"], {
        timeout: SHORT_TIMEOUT,
      });
    } else {
      await sshRun(host, "docker compose version", { timeout: SHORT_TIMEOUT });
    }
    cmd = { cmd: "docker", pre: ["compose"] };
  } catch {
    cmd = { cmd: "docker-compose", pre: [] };
  }
  _composeCmd.set(host.id, cmd);
  return cmd;
}

// ----------------------------------------------------------------------------
// Logs & resource stats (host-aware)
// ----------------------------------------------------------------------------

// Run an arbitrary /bin/sh command string on a host regardless of transport.
// Local runs go through `sh -c`, remote ones over SSH (same shell semantics),
// so a single command string works for both. `input`, when given, is piped to
// the command's stdin (locally or through SSH) — used e.g. to feed a request
// body to a `curl --data-binary @-` running on a remote scan host.
function runShell(host, script, { timeout = SHORT_TIMEOUT, input } = {}) {
  if (host.transport === "local") {
    return localRun("/bin/sh", ["-c", script], { timeout, input });
  }
  return sshRun(host, script, { timeout, input });
}

// Tail a container's docker logs. docker writes logs to stderr, so we merge
// 2>&1. Returns the raw text (caller splits into lines).
//
// `since` (optional) bounds the window by time using docker's `--since`
// (a duration like "6h"/"30m" or an absolute timestamp). It combines with the
// `tail` line cap: docker returns lines newer than `since`, then the cap keeps
// transfer size bounded on a busy container. Native hosts (botctl) have no
// time filter, so `since` is ignored there and only the line cap applies.
async function dockerLogs(host, container, { tail = 200, since } = {}) {
  const n = Math.max(1, Math.min(2000, parseInt(tail, 10) || 200));
  if (isNative(host)) {
    return botctl(host, ["logs", container, String(n)], { timeout: 25000 });
  }
  const sinceArg = since ? "--since " + shq(String(since)) + " " : "";
  const script =
    "docker logs " +
    sinceArg +
    "--tail " +
    n +
    " " +
    shq(container) +
    " 2>&1 | tail -n " +
    n;
  const { stdout } = await runShell(host, script, { timeout: 25000 });
  return stdout;
}

// One shell snippet that samples CPU (two /proc/stat reads 0.4s apart), memory
// from /proc/meminfo, disk for the bot directory's filesystem, uptime and the
// CPU count. Emitted as "key value" lines so parsing stays trivial and works
// identically over SSH or locally.
//
// IMPORTANT: memory/disk are emitted in KILOBYTES, not bytes. The conversion to
// bytes happens in JS (64-bit). mawk (default on Raspberry Pi OS) uses 32-bit
// ints for printf %d, so multiplying kB*1024 inside awk overflows at ~2.1 GB
// and clamps everything to ~2.0 GB. Keeping the awk values small avoids that.
function statsScript(dir) {
  return [
    "S1=$(awk '/^cpu /{t=0;for(i=2;i<=NF;i++)t+=$i;print t\" \"($5+$6)}' /proc/stat)",
    "sleep 0.4",
    "S2=$(awk '/^cpu /{t=0;for(i=2;i<=NF;i++)t+=$i;print t\" \"($5+$6)}' /proc/stat)",
    'echo "cpu $(awk -v a="$S1" -v b="$S2" \'BEGIN{split(a,x);split(b,y);dt=y[1]-x[1];di=y[2]-x[2];if(dt<=0){print 0}else{p=(1-di/dt)*100;if(p<0)p=0;printf "%.1f",p}}\')"',
    "awk '/^MemTotal:/{t=$2}/^MemAvailable:/{a=$2}END{printf \"mem_total_kb %d\\nmem_avail_kb %d\\n\",t,a}' /proc/meminfo",
    "df -P -k " +
      shq(dir) +
      " 2>/dev/null | awk 'NR==2{printf \"disk_total_kb %d\\ndisk_used_kb %d\\n\",$2,$3}'",
    "awk '{printf \"uptime %d\\n\",$1}' /proc/uptime",
    'echo "ncpu $(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)"',
  ].join("; ");
}

async function hostStats(host) {
  const { stdout } = await runShell(host, statsScript(host.dir), {
    timeout: 15000,
  });
  const out = {};
  stdout
    .trim()
    .split("\n")
    .forEach((line) => {
      const sp = line.indexOf(" ");
      if (sp < 0) return;
      const k = line.slice(0, sp).trim();
      const v = Number(line.slice(sp + 1).trim());
      if (k && !Number.isNaN(v)) out[k] = v;
    });
  const kb = (v) => (v == null ? null : v * 1024); // JS is 64-bit: no overflow
  const memTotal = out.mem_total_kb != null ? kb(out.mem_total_kb) : null;
  const memUsed =
    out.mem_total_kb != null && out.mem_avail_kb != null
      ? kb(out.mem_total_kb - out.mem_avail_kb)
      : null;
  return {
    cpu: out.cpu ?? null,
    ncpu: out.ncpu ?? null,
    memTotal,
    memUsed,
    diskTotal: out.disk_total_kb != null ? kb(out.disk_total_kb) : null,
    diskUsed: out.disk_used_kb != null ? kb(out.disk_used_kb) : null,
    uptime: out.uptime ?? null,
  };
}

// Per-container CPU/mem from `docker stats --no-stream`, keyed by container name.
async function dockerStats(host) {
  let stdout;
  if (isNative(host)) {
    stdout = await botctl(host, ["stats"], { timeout: 20000 });
  } else {
    const fmt = "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}";
    const script = "docker stats --no-stream --format " + shq(fmt);
    ({ stdout } = await runShell(host, script, { timeout: 20000 }));
  }
  const out = {};
  stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .forEach((line) => {
      const [name, cpu, mem, memPerc] = line.split("\t");
      if (name) out[name] = { cpu, mem, memPerc };
    });
  return out;
}

async function composeUp(host, container) {
  if (isNative(host)) {
    return (
      await botctl(host, ["start", container], { timeout: 120000 })
    ).trim();
  }
  const c = await detectComposeCmd(host);
  const args = [...c.pre, "up", "-d", container];
  if (host.transport === "local") {
    const { stdout } = await localRun(c.cmd, args, {
      cwd: host.dir,
      timeout: 120000,
    });
    return stdout.trim();
  }
  const cmd =
    "cd " + shq(host.dir) + " && " + c.cmd + " " + args.map(shq).join(" ");
  const { stdout } = await sshRun(host, cmd, { timeout: 120000 });
  return stdout.trim();
}

// ----------------------------------------------------------------------------
// Server-side "last known" snapshots + small metadata files.
//
// Remote hosts (a Raspberry Pi) can be powered off or fall off the network. So
// the server keeps a copy of each host's config files (refreshed whenever we
// successfully read them) plus a tiny metadata store. This is what lets the
// "All bots" view list a host's bots while it's offline, and what lets the
// emergency "move to server" recover a bot even when the Pi is unreachable.
// ----------------------------------------------------------------------------
const SNAPSHOT_DIR =
  process.env.TWITCHBOT_SNAPSHOT_DIR ||
  path.join(path.dirname(BOT_DIR), "twitchbot-snapshots");

function snapshotPath(hostId, file) {
  return path.join(SNAPSHOT_DIR, "hosts", String(hostId), file);
}
async function saveSnapshot(hostId, file, text) {
  const p = snapshotPath(hostId, file);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, text, "utf8");
}
async function readSnapshot(hostId, file) {
  return fsp.readFile(snapshotPath(hostId, file), "utf8");
}
async function listSnapshot(hostId) {
  try {
    return await fsp.readdir(path.join(SNAPSHOT_DIR, "hosts", String(hostId)));
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}
async function readMeta(name) {
  try {
    return await fsp.readFile(path.join(SNAPSHOT_DIR, name), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
async function writeMeta(name, text) {
  await fsp.mkdir(SNAPSHOT_DIR, { recursive: true });
  await fsp.writeFile(path.join(SNAPSHOT_DIR, name), text, "utf8");
}

// Best-effort "what is this container farming right now", parsed from the tail
// of its docker logs. TwitchDropsBot prints lines about the game/campaign it's
// watching; we return the most recent recognisable one (ANSI stripped), or the
// last log line as a fallback. Returns null when there's nothing to show.
// eslint-disable-next-line no-control-regex
const _ansiRe = /\u001b\[[0-9;]*[A-Za-z]/g;
async function farmingStatus(host, container) {
  let text;
  try {
    text = (await dockerLogs(host, container, { tail: 160 })) || "";
  } catch {
    return null;
  }
  const lines = text
    .replace(_ansiRe, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  // These require a literal colon after the trigger word, not just any
  // whitespace — TwitchDropsBot's real status line is "Current drop
  // campaign: <name>, watching <streamer>", but plain chatter like "No
  // broadcaster or campaign left." also contains the bare word "campaign"
  // followed by a space, and used to be misread as a campaign name.
  const patterns = [
    /\bnow watching\s+(.+)/i,
    /\bwatching\s+(.+)/i,
    /\bmining\s+(.+)/i,
    /\bfarming\s+(.+)/i,
    /\bcampaign:\s*(.+)/i,
    /\bcurrent drop:\s*(.+)/i,
    /\bdrop:\s*(.+)/i,
    /\bstreamer:\s*(.+)/i,
  ];
  // Guards against known junk captures (e.g. the "campaign left." line
  // above) slipping through as a plausible-looking but meaningless detail.
  const junkDetail = /^(left|found|n\/a)\.?$/i;
  for (let i = lines.length - 1; i >= 0; i--) {
    for (const re of patterns) {
      const m = lines[i].match(re);
      if (!m) continue;
      const detail = m[1].trim();
      if (detail.length < 4 || junkDetail.test(detail)) continue;
      return { line: lines[i], detail: detail.slice(0, 180) };
    }
  }
  const last = lines[lines.length - 1];
  return { line: last, detail: last.slice(0, 180) };
}

// Set a container's restart policy (survives a docker/host restart, unlike a
// plain `docker stop` — a `restart: always` container comes back on the next
// daemon restart even if it was manually stopped beforehand).
async function setRestartPolicy(host, container, policy) {
  if (isNative(host)) {
    await botctl(host, ["policy", container, policy]);
    return;
  }
  const args = ["update", "--restart=" + policy, container];
  if (host.transport === "local") {
    await localRun("docker", args);
  } else {
    await sshRun(host, "docker " + args.map(shq).join(" "));
  }
}

// TwitchDropsBot has a known bug: with zero accounts configured, it retries
// an interactive login prompt in a tight loop with no backoff — tens of
// thousands of log lines per second, which has filled a disk and pegged a
// CPU core in production. A bot's account list can end up empty from several
// places (a raw config save, purging bad tokens, resolving duplicates), so
// this is called after any of those instead of duplicating the check at each
// call site. If the container is currently running, stops it and clears its
// restart policy so it can't come back — including across a host reboot —
// until accounts are added again (see restoreRestartPolicy).
async function stopIfNoAccounts(host, file, container) {
  let data;
  try {
    data = JSON.parse(await readFile(host, file));
  } catch {
    return { stopped: false };
  }
  const users = (data.TwitchSettings && data.TwitchSettings.TwitchUsers) || [];
  if (users.length > 0) return { stopped: false };

  const states = await dockerPs(host).catch(() => ({}));
  const running = states[container] && states[container].state === "running";
  if (!running) return { stopped: false };

  await setRestartPolicy(host, container, "no").catch(() => {});
  await dockerContainer(host, "stop", container).catch(() => {});
  return { stopped: true };
}

// Re-enable normal crash/reboot auto-restart once a bot has accounts again —
// pairs with stopIfNoAccounts, which clears the policy on the way out.
async function restoreRestartPolicy(host, container) {
  await setRestartPolicy(host, container, "always").catch(() => {});
}

module.exports = {
  BOT_DIR,
  COMPOSE_NAMES,
  listHosts,
  resolveHost,
  readdir,
  readFile,
  readFiles,
  exists,
  writeFileAtomic,
  rename,
  composeName,
  composeRead,
  composeWrite,
  dockerPs,
  dockerContainer,
  dockerLogs,
  dockerStats,
  hostStats,
  composeUp,
  runShell,
  shq,
  saveSnapshot,
  readSnapshot,
  listSnapshot,
  readMeta,
  writeMeta,
  farmingStatus,
  stopIfNoAccounts,
  restoreRestartPolicy,
  setRestartPolicy,
};
