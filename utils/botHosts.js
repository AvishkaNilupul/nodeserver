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

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");

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
const SHORT_TIMEOUT = 8000;

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
    out.push({
      id,
      label: String(h.label || id),
      transport: "ssh",
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
    "ConnectTimeout=8",
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

async function readdir(host) {
  if (host.transport === "local") {
    return fsp.readdir(host.dir);
  }
  try {
    const { stdout } = await sshRun(host, "ls -1 -- " + shq(host.dir), {
      timeout: SHORT_TIMEOUT,
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
}

async function readFile(host, file) {
  if (host.transport === "local") {
    return fsp.readFile(path.join(host.dir, file), "utf8");
  }
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
async function composeName(host) {
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
// Docker operations (host-aware)
// ----------------------------------------------------------------------------

// `docker ps -a`, parsed into { name: { state, status } }.
async function dockerPs(host) {
  const fmt = "{{.Names}}\t{{.State}}\t{{.Status}}";
  let stdout;
  if (host.transport === "local") {
    ({ stdout } = await localRun("docker", ["ps", "-a", "--format", fmt], {
      timeout: SHORT_TIMEOUT,
    }));
  } else {
    ({ stdout } = await sshRun(host, "docker ps -a --format " + shq(fmt), {
      timeout: SHORT_TIMEOUT,
    }));
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

async function composeUp(host, container) {
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

module.exports = {
  BOT_DIR,
  COMPOSE_NAMES,
  listHosts,
  resolveHost,
  readdir,
  readFile,
  exists,
  writeFileAtomic,
  rename,
  composeName,
  composeRead,
  composeWrite,
  dockerPs,
  dockerContainer,
  composeUp,
};
