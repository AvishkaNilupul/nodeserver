// Full-site backup & restore.
//
// A backup is a single `backup-<timestamp>.tar.gz` containing EVERYTHING needed
// to bring the site back from scratch:
//   db/<collection>.json   every MongoDB collection, in MongoDB Extended JSON
//                          (so ObjectIds / Dates restore with their real types)
//   uploads/...            the chat image uploads (public/uploads)
//   drop-images/...        locally cached drop reward images (public/drop-images)
//                          — these survive Twitch removing the CDN asset, so a
//                          restore must carry them or the archive loses its art
//   config/botHosts.json   remote SSH host definitions (gitignored on disk)
//   snapshots/...          the last-known Pi bot configs (accounts/passwords)
//   db/mongodump.archive.gz  the same database as a mongodump archive — keeps
//                          indexes/options; `mongorestore --gzip --archive=`
//   hosts/<host>.tgz       LIVE bot configs + compose file from every bot host,
//                          and hosts/noclaim.tgz for the no-claim fleet
//   code.tar.gz            the deployed app code (prod runs a mix of branch
//                          tips, some of it in no git ref at all)
//   secrets.tar.gz.enc     .env (CRED_SECRET decrypts every stored password),
//                          admins, Mongo credentials, nginx/TLS, pm2, cron and
//                          the /opt side apps — AES-256 encrypted with the key
//                          in BACKUP_KEY_FILE, never stored in plaintext here
//   manifest.json          createdAt, reason, per-collection counts, file counts
//
// Every backup is then copied OFF this server (BACKUP_OFFSITE_HOSTS, default
// the Pi and Contabo) as an encrypted <id>.tar.gz.enc, checksum-verified on
// arrival. Decrypt with:
//   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:<key> -in X.enc -out X
//
// Creating a backup is READ-ONLY — it only reads the DB and copies files, so it
// can never corrupt or interrupt the live site. tar runs in a child process so
// the event loop is never blocked. Restore is the only destructive operation;
// it always takes a fresh safety backup of the current state first.

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");
const mongoose = require("mongoose");
const { EJSON } = require("bson");
const hosts = require("./botHosts");

// Where backups live. Kept OUTSIDE the repo so `git pull` / editors never touch
// them and they survive redeploys. Override with BACKUP_DIR.
const BACKUP_DIR =
  process.env.BACKUP_DIR || path.join(os.homedir(), "redeemer-backups");
const UPLOADS_DIR = path.join(__dirname, "..", "public", "uploads");
const DROP_IMAGES_DIR = path.join(__dirname, "..", "public", "drop-images");
const HOSTS_FILE = path.join(__dirname, "..", "config", "botHosts.json");
const SETTINGS_FILE = path.join(__dirname, "settings.json");
const SNAPSHOT_DIR =
  process.env.TWITCHBOT_SNAPSHOT_DIR ||
  path.join(path.dirname(process.env.TWITCHBOT_DIR || "/root/twitchbot"), "twitchbot-snapshots");

const RETENTION = Math.max(1, parseInt(process.env.BACKUP_RETENTION || "14", 10));
const BACKUP_HOUR = Math.min(23, Math.max(0, parseInt(process.env.BACKUP_HOUR || "23", 10)));
const BACKUP_MINUTE = Math.min(59, Math.max(0, parseInt(process.env.BACKUP_MINUTE || "59", 10)));

const APP_DIR = path.join(__dirname, "..");
const ADMINS_FILE = path.join(__dirname, "admins.json");
const STATUS_FILE = path.join(BACKUP_DIR, "status.json");
const KEY_FILE =
  process.env.BACKUP_KEY_FILE || path.join(os.homedir(), ".redeemer-backup.key");
// Unset = the Pi and Contabo; set to "" to turn off-site copies off.
const OFFSITE_HOSTS = String(
  process.env.BACKUP_OFFSITE_HOSTS == null ? "pi,contabo" : process.env.BACKUP_OFFSITE_HOSTS,
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const OFFSITE_DIR = process.env.BACKUP_OFFSITE_DIR || "redeemer-backups";
const OFFSITE_RETENTION = Math.max(
  1,
  parseInt(process.env.BACKUP_OFFSITE_RETENTION || "14", 10),
);
// A daily run missed by a restart is made up this long after boot.
const CATCHUP_AFTER_MS = 26 * 60 * 60 * 1000;
const CATCHUP_DELAY_MS = 10 * 60 * 1000;
// Staging left behind by a process that died mid-backup.
const STALE_STAGING_MS = 3 * 60 * 60 * 1000;

// Sensitive files that must survive a lost server but never sit in a plaintext
// archive. Absolute paths; missing ones are skipped.
const SECRET_PATHS = [
  path.join(APP_DIR, ".env"),
  ADMINS_FILE,
  path.join(os.homedir(), ".mongo-redeemer.env"),
  "/var/www/redeemer/bot.py",
  "/etc/mongod.conf",
  "/etc/nginx/sites-available",
  "/etc/nginx/sites-enabled",
  "/etc/letsencrypt",
  "/etc/logrotate.d/pm2-root",
  "/etc/logrotate.d/mongod",
  path.join(os.homedir(), ".pm2", "dump.pm2"),
  "/opt/claude-pool/claude_pool.py",
  "/opt/claude-pool/chats.db",
  "/opt/claude-pool/cookies.json",
  "/opt/claude-pool/tabitoken.json",
  "/opt/claude2api/config.yaml",
  "/opt/twitch-claim-bot/bot.py",
  "/opt/twitch-claim-bot/start.sh",
];
// Never in the plaintext code snapshot: secrets live only in the encrypted one.
const CODE_EXCLUDES = [
  "./node_modules",
  "./.git",
  "./.env",
  "./.env.*",
  "./utils/admins.json",
  "./_deploy_backup_*",
  "./_integrity_*",
  "./public/drop-images",
  "./public/uploads",
  "./.graphify",
  "./tools 2",
  "./_fable",
  "*/.venv",
  "*/node_modules",
  "*/__pycache__",
  "*.log",
];

const NAME_RE = /^backup-[0-9A-Za-z_-]+\.tar\.gz$/;
const SKIP_COLLECTIONS = new Set(["sessions"]); // express sessions: transient, skip

let _busy = false; // serialise create/restore so they never overlap
let _replicating = false;

function stamp(d) {
  // 2026-06-30_2359-12 — filesystem-safe, sortable.
  const p = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    "-" + p(d.getMonth() + 1) +
    "-" + p(d.getDate()) +
    "_" + p(d.getHours()) + p(d.getMinutes()) +
    "-" + p(d.getSeconds())
  );
}

// A unique, descriptive backup id. The reason is embedded (so retention can
// recognise "pre-restore" safety copies) and a short random suffix guarantees
// two backups in the same second never collide / overwrite each other.
function makeId(reason) {
  const tag =
    String(reason || "manual")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "manual";
  return "backup-" + stamp(new Date()) + "-" + tag + "-" + crypto.randomBytes(2).toString("hex");
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const ch = spawn(cmd, args, opts);
    let stderr = "";
    if (ch.stderr) ch.stderr.on("data", (d) => (stderr += d.toString()));
    ch.on("error", reject);
    ch.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(cmd + " exited " + code + (stderr ? ": " + stderr.trim() : "")));
    });
  });
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(src, dest) {
  if (!(await exists(src))) return 0;
  await fsp.mkdir(dest, { recursive: true });
  let n = 0;
  for (const ent of await fsp.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) n += await copyDir(s, d);
    else if (ent.isFile()) {
      await fsp.copyFile(s, d);
      n++;
    }
  }
  return n;
}

function capture(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000, ...opts },
      (err, stdout, stderr) => {
        if (err) {
          const e = new Error(cmd + ": " + String(stderr || err.message).trim().slice(0, 300));
          return reject(e);
        }
        resolve(String(stdout));
      },
    );
  });
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("error", reject)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")));
  });
}

// The key that encrypts the secrets bundle and every off-site copy. Created on
// first use (0600). It must ALSO be kept off this server by the owner — a lost
// server takes its key with it, and without the key the off-site copies are
// unreadable.
async function backupKeyFile() {
  if (!(await exists(KEY_FILE))) {
    await fsp.writeFile(KEY_FILE, crypto.randomBytes(48).toString("base64") + "\n", {
      mode: 0o600,
      flag: "wx",
    }).catch((e) => {
      if (e.code !== "EEXIST") throw e;
    });
  }
  return KEY_FILE;
}

async function encryptFile(src, dest) {
  const key = await backupKeyFile();
  await run("openssl", [
    "enc", "-aes-256-cbc", "-pbkdf2", "-iter", "200000", "-salt",
    "-pass", "file:" + key, "-in", src, "-out", dest,
  ]);
}

// secrets.tar.gz.enc: every SECRET_PATHS entry that exists, plus root's
// crontab, tarred with absolute paths (restore with `tar -xzf - -C /`).
async function addSecrets(staging) {
  const present = [];
  for (const p of SECRET_PATHS) if (await exists(p)) present.push(p);
  const cronFile = path.join(staging, "crontab.txt");
  try {
    await fsp.writeFile(cronFile, await capture("crontab", ["-l"]), { mode: 0o600 });
    present.push(cronFile);
  } catch {
    /* no crontab */
  }
  const plain = path.join(staging, "secrets.tar.gz");
  await run("tar", [
    "-czf", plain, "--ignore-failed-read", "-P",
    ...present,
  ]);
  await encryptFile(plain, path.join(staging, "secrets.tar.gz.enc"));
  await fsp.rm(plain, { force: true });
  await fsp.rm(cronFile, { force: true });
  return present.length;
}

async function addCode(staging) {
  const out = path.join(staging, "code.tar.gz");
  const args = ["-czf", out];
  for (const x of CODE_EXCLUDES) args.push("--exclude=" + x);
  args.push("-C", APP_DIR, ".");
  await run("tar", args);
  return (await fsp.stat(out)).size;
}

// Full-fidelity dump next to the EJSON files: indexes, TTLs and collection
// options come back with a single `mongorestore`. The URI goes through a 0600
// config file so it never shows in `ps`.
async function addMongodump(staging) {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI || "";
  if (!uri) throw new Error("MONGO_URI is not set");
  const cfg = path.join(staging, ".mongodump.yaml");
  await fsp.writeFile(cfg, "uri: " + JSON.stringify(uri) + "\n", { mode: 0o600 });
  const out = path.join(staging, "db", "mongodump.archive.gz");
  try {
    await run("mongodump", ["--config=" + cfg, "--gzip", "--archive=" + out, "--quiet"]);
  } finally {
    await fsp.rm(cfg, { force: true });
  }
  return (await fsp.stat(out)).size;
}

// LIVE bot configs (what actually farms) from every bot host, plus the
// no-claim fleet. The snapshots/ copy above lags and never covered the
// no-claim bots. A host that cannot be read is recorded, not fatal.
const HOST_CFG_PATTERN =
  "^(config(_[0-9]+)?\\.json|docker-compose\\.ya?ml|compose\\.ya?ml)$";

async function remoteTgz(host, script) {
  const { stdout } = await hosts.runShell(host, script + " | base64 -w0", {
    timeout: 3 * 60 * 1000,
  });
  const buf = Buffer.from(String(stdout).trim(), "base64");
  if (buf.length < 20 || buf[0] !== 0x1f || buf[1] !== 0x8b) {
    throw new Error("host returned no archive");
  }
  return buf;
}

async function addHostConfigs(staging) {
  const outDir = path.join(staging, "hosts");
  await fsp.mkdir(outDir, { recursive: true });
  const result = {};
  for (const h of hosts.listHosts()) {
    const host = hosts.resolveHost(h.id);
    try {
      let buf;
      if (host.transport === "local") {
        const names = (await fsp.readdir(host.dir).catch(() => [])).filter((n) =>
          new RegExp(HOST_CFG_PATTERN).test(n),
        );
        if (!names.length) {
          result[h.id] = { ok: true, files: 0 };
          continue;
        }
        const out = path.join(outDir, h.id + ".tgz");
        await run("tar", ["-czf", out, "-C", host.dir, ...names]);
        result[h.id] = { ok: true, files: names.length, bytes: (await fsp.stat(out)).size };
        continue;
      }
      buf = await remoteTgz(
        host,
        "cd " + hosts.shq(host.dir) + " && ls -1 | grep -E " + hosts.shq(HOST_CFG_PATTERN) +
          " | tr '\\n' '\\0' | tar -czf - --null -T -",
      );
      await fsp.writeFile(path.join(outDir, h.id + ".tgz"), buf);
      result[h.id] = { ok: true, bytes: buf.length };
    } catch (e) {
      result[h.id] = { ok: false, error: String(e.message || e).slice(0, 200) };
    }
  }
  try {
    const fleet = require("./noclaimFleet");
    const host = hosts.resolveHost(fleet.HOST_ID);
    if (!host) throw new Error("no-claim host " + fleet.HOST_ID + " is not configured");
    const buf = await remoteTgz(
      host,
      "cd " + hosts.shq(fleet.BOTS_DIR) +
        " && find . -maxdepth 3 \\( -path './*/Configuration/config.json' -o -name '.autostopped'" +
        " -o -name '.operatoroff' -o -name '.finished' -o -name '.personal*' \\) -print0" +
        " | tar -czf - --null -T -",
    );
    await fsp.writeFile(path.join(outDir, "noclaim.tgz"), buf);
    result.noclaim = { ok: true, host: fleet.HOST_ID, bytes: buf.length };
  } catch (e) {
    result.noclaim = { ok: false, error: String(e.message || e).slice(0, 200) };
  }
  return result;
}

// Dump one collection to db/<name>.json as a streamed EJSON array, so even a
// large collection never has to live fully in memory.
async function dumpCollection(coll, outFile) {
  const ws = fs.createWriteStream(outFile);
  const done = new Promise((resolve, reject) => {
    ws.on("error", reject);
    ws.on("finish", resolve);
  });
  ws.write("[");
  let first = true;
  let count = 0;
  const cursor = coll.find({}, { raw: false });
  for await (const doc of cursor) {
    ws.write((first ? "" : ",\n") + EJSON.stringify(doc, { relaxed: false }));
    first = false;
    count++;
  }
  ws.write("]");
  ws.end();
  await done;
  return count;
}

// Build a full backup. Returns { id, file, size, manifest }. Does NOT manage
// the _busy lock itself — restoreBackup needs to hold that lock continuously
// across its own safety-backup call, so the lock is only acquired/released
// by the public wrappers below (createBackup and restoreBackup).
async function createBackupUnlocked({ reason = "manual" } = {}) {
  const id = makeId(reason);
  const outFile = path.join(BACKUP_DIR, id + ".tar.gz");
  const staging = path.join(BACKUP_DIR, ".staging-" + id);
  try {
    await fsp.mkdir(path.join(staging, "db"), { recursive: true });

    const manifest = {
      id,
      reason,
      createdAt: new Date().toISOString(),
      app: "redeemer",
      collections: {},
      files: {},
    };

    // 1. Database — every collection.
    const db = mongoose.connection && mongoose.connection.db;
    if (!db) throw new Error("Database is not connected");
    const colls = await db.listCollections().toArray();
    for (const info of colls) {
      const name = info.name;
      if (name.startsWith("system.")) continue;
      if (SKIP_COLLECTIONS.has(name)) continue;
      const count = await dumpCollection(
        db.collection(name),
        path.join(staging, "db", name + ".json"),
      );
      manifest.collections[name] = count;
    }

    // 2. Uploaded images.
    manifest.files.uploads = await copyDir(UPLOADS_DIR, path.join(staging, "uploads"));
    // 2b. Locally cached drop reward images (outlive Twitch's CDN, so they must
    // be in the backup or a restore would leave the archive's images broken).
    manifest.files.dropImages = await copyDir(
      DROP_IMAGES_DIR,
      path.join(staging, "drop-images"),
    );
    // 3. Remote host config + Pi snapshot copies.
    if (await exists(HOSTS_FILE)) {
      await fsp.mkdir(path.join(staging, "config"), { recursive: true });
      await fsp.copyFile(HOSTS_FILE, path.join(staging, "config", "botHosts.json"));
      manifest.files.botHosts = 1;
    }
    // Site settings (incl. encrypted marketplace API keys).
    if (await exists(SETTINGS_FILE)) {
      await fsp.mkdir(path.join(staging, "config"), { recursive: true });
      await fsp.copyFile(SETTINGS_FILE, path.join(staging, "config", "settings.json"));
      manifest.files.settings = 1;
    }
    manifest.files.snapshots = await copyDir(SNAPSHOT_DIR, path.join(staging, "snapshots"));

    // 4. Everything else a rebuilt server needs. Each part is recorded in the
    // manifest; one failing part never throws away the database backup above.
    const part = async (name, fn) => {
      try {
        manifest.files[name] = await fn();
      } catch (e) {
        manifest.files[name] = { ok: false, error: String(e.message || e).slice(0, 300) };
        manifest.problems = (manifest.problems || []).concat(name);
      }
    };
    await part("mongodump", () => addMongodump(staging));
    await part("hosts", () => addHostConfigs(staging));
    await part("code", () => addCode(staging));
    await part("secrets", async () => ({
      ok: true,
      encrypted: true,
      paths: await addSecrets(staging),
    }));
    if (manifest.files.hosts && typeof manifest.files.hosts === "object") {
      for (const [h, r] of Object.entries(manifest.files.hosts)) {
        if (r && r.ok === false) {
          manifest.problems = (manifest.problems || []).concat("hosts:" + h);
        }
      }
    }

    await fsp.writeFile(
      path.join(staging, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );

    // 5. Compress (child process — non-blocking).
    await run("tar", ["-czf", outFile, "-C", staging, "."]);
    const st = await fsp.stat(outFile);
    await fsp.rm(staging, { recursive: true, force: true });
    await enforceRetention();
    return { id, file: outFile, size: st.size, manifest };
  } catch (e) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(outFile, { force: true }).catch(() => {});
    throw e;
  }
}

async function createBackup(opts = {}) {
  if (_busy) throw new Error("Another backup/restore is already running");
  _busy = true;
  const reason = opts.reason || "manual";
  try {
    const r = await createBackupUnlocked(opts);
    const problems = r.manifest.problems || [];
    await updateStatus((s) => {
      const at = new Date().toISOString();
      s.lastRun = { at, id: r.id, ok: true, reason, problems };
      s.lastSuccess = { at, id: r.id, size: r.size, reason, problems };
    });
    return r;
  } catch (e) {
    await updateStatus((s) => {
      s.lastRun = {
        at: new Date().toISOString(),
        ok: false,
        reason,
        error: String(e.message || e).slice(0, 300),
      };
    });
    throw e;
  } finally {
    _busy = false;
  }
}

async function listBackups({ create = true } = {}) {
  if (create) await fsp.mkdir(BACKUP_DIR, { recursive: true });
  let names = [];
  try {
    names = (await fsp.readdir(BACKUP_DIR)).filter((n) => NAME_RE.test(n));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const copies = (await readStatus()).copies || {};
  const out = [];
  for (const n of names) {
    try {
      const st = await fsp.stat(path.join(BACKUP_DIR, n));
      const id = n.replace(/\.tar\.gz$/, "");
      out.push({ id, file: n, size: st.size, createdAt: st.mtime.toISOString(), offsite: copies[id] || {} });
    } catch {
      /* skip */
    }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

// ---- Status + alerts --------------------------------------------------------
// status.json: the last run, the last success, and per-backup off-site copies,
// so /backup.html and the health check can prove the chain is intact.
async function readStatus() {
  try {
    const s = JSON.parse(await fsp.readFile(STATUS_FILE, "utf8"));
    return s && typeof s === "object" ? s : {};
  } catch {
    return {};
  }
}

let _statusChain = Promise.resolve();
function updateStatus(mutate) {
  _statusChain = _statusChain.then(async () => {
    const s = await readStatus();
    mutate(s);
    await fsp.mkdir(BACKUP_DIR, { recursive: true });
    const tmp = STATUS_FILE + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(s, null, 2));
    await fsp.rename(tmp, STATUS_FILE);
  }).catch((e) => console.error("[backup] status write failed:", e.message));
  return _statusChain;
}

async function alert(text) {
  console.error("[backup] " + text);
  try {
    await require("./telegram").sendTelegram("🗄️ Backup problem — " + text);
  } catch {
    /* alerting must never throw */
  }
  try {
    await require("./systemLog").logEvent({
      category: "backup",
      action: "failed",
      severity: "error",
      actor: "backup",
      detail: text,
    });
  } catch {
    /* ignore */
  }
}

// ---- Off-site copies ----------------------------------------------------------
function scpTo(host, localFile, remotePath) {
  const ssh = host.ssh || {};
  const args = ["-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=20"];
  if (ssh.identityFile) args.push("-i", ssh.identityFile);
  if (ssh.port) args.push("-P", String(ssh.port));
  for (const o of ssh.options || []) args.push(o);
  args.push(localFile, ssh.target + ":" + remotePath);
  return run("scp", args);
}

async function copyToHost(hostId, encFile, remoteName, sha) {
  const host = hosts.resolveHost(hostId);
  if (!host || host.transport === "local") throw new Error("unknown off-site host " + hostId);
  const dir = hosts.shq(OFFSITE_DIR);
  await hosts.runShell(host, "mkdir -p " + dir + " && chmod 700 " + dir, { timeout: 60000 });
  const part = OFFSITE_DIR + "/" + remoteName + ".part";
  await scpTo(host, encFile, part);
  const { stdout } = await hosts.runShell(
    host,
    "sha256sum " + hosts.shq(part) + " | cut -c1-64",
    { timeout: 5 * 60 * 1000 },
  );
  const remoteSha = String(stdout).trim();
  if (remoteSha !== sha) {
    await hosts.runShell(host, "rm -f " + hosts.shq(part), { timeout: 60000 }).catch(() => {});
    throw new Error("checksum mismatch after copy");
  }
  await hosts.runShell(
    host,
    "mv -f " + hosts.shq(part) + " " + hosts.shq(OFFSITE_DIR + "/" + remoteName) +
      " && cd " + dir +
      " && ls -1t backup-*.tar.gz.enc 2>/dev/null | tail -n +" + (OFFSITE_RETENTION + 1) +
      " | xargs -r rm -f --; find . -maxdepth 1 -name '*.part' -mmin +1440 -delete 2>/dev/null; true",
    { timeout: 60000 },
  );
}

// Encrypt one local backup and copy it to every off-site host. Never throws;
// the per-host result lands in status.json and failures page the owner.
async function replicateOffsite(id) {
  const file = backupPath(id);
  const results = {};
  if (!file || !(await exists(file))) return { skipped: "backup not found" };
  if (!OFFSITE_HOSTS.length) return { skipped: "no off-site hosts configured" };
  if (_replicating) return { skipped: "another off-site copy is running" };
  _replicating = true;
  const enc = path.join(BACKUP_DIR, "." + id + ".tar.gz.enc");
  try {
    await encryptFile(file, enc);
    const sha = await sha256File(enc);
    for (const h of OFFSITE_HOSTS) {
      const t0 = Date.now();
      try {
        await copyToHost(h, enc, id + ".tar.gz.enc", sha);
        results[h] = { ok: true, at: new Date().toISOString(), ms: Date.now() - t0, sha256: sha };
      } catch (e) {
        results[h] = { ok: false, at: new Date().toISOString(), error: String(e.message || e).slice(0, 300) };
      }
    }
  } catch (e) {
    for (const h of OFFSITE_HOSTS) {
      if (!results[h]) results[h] = { ok: false, at: new Date().toISOString(), error: "encrypt: " + String(e.message || e).slice(0, 250) };
    }
  } finally {
    await fsp.rm(enc, { force: true }).catch(() => {});
    _replicating = false;
  }
  await updateStatus((s) => {
    s.copies = s.copies || {};
    s.copies[id] = { ...(s.copies[id] || {}), ...results };
    s.offsite = { ...(s.offsite || {}) };
    for (const [h, r] of Object.entries(results)) s.offsite[h] = { id, ...r };
    const keep = Object.keys(s.copies).sort().slice(-40);
    for (const k of Object.keys(s.copies)) if (!keep.includes(k)) delete s.copies[k];
  });
  const failed = Object.entries(results).filter(([, r]) => !r.ok);
  if (failed.length) {
    await alert(
      "off-site copy of " + id + " failed on " +
        failed.map(([h, r]) => h + " (" + r.error + ")").join(", "),
    );
  }
  return results;
}

async function status() {
  const s = await readStatus();
  const list = await listBackups({ create: false }).catch(() => []);
  return {
    dir: BACKUP_DIR,
    retention: RETENTION,
    schedule: String(BACKUP_HOUR).padStart(2, "0") + ":" + String(BACKUP_MINUTE).padStart(2, "0") + " (server time)",
    nextRunAt: new Date(Date.now() + msUntilNextRun()).toISOString(),
    offsiteHosts: OFFSITE_HOSTS,
    offsiteDir: OFFSITE_DIR,
    offsiteRetention: OFFSITE_RETENTION,
    keyFile: KEY_FILE,
    keyPresent: await exists(KEY_FILE),
    busy: _busy,
    replicating: _replicating,
    lastRun: s.lastRun || null,
    lastSuccess: s.lastSuccess || null,
    offsite: s.offsite || {},
    newest: list[0] || null,
  };
}

function backupPath(id) {
  const file = id.endsWith(".tar.gz") ? id : id + ".tar.gz";
  if (!NAME_RE.test(file)) return null; // reject traversal / bad names
  return path.join(BACKUP_DIR, file);
}

async function deleteBackup(id) {
  const p = backupPath(id);
  if (!p) throw new Error("Invalid backup id");
  await fsp.rm(p, { force: true });
}

async function enforceRetention() {
  const all = await listBackups();
  // Never auto-delete a safety backup taken right before a restore.
  const prunable = all.filter((b) => !b.id.includes("pre-restore"));
  for (const b of prunable.slice(RETENTION)) {
    await fsp.rm(path.join(BACKUP_DIR, b.file), { force: true }).catch(() => {});
  }
}

// Restore from a .tar.gz archive. Always takes a fresh safety backup of the
// current state first. With { drop:true } each restored collection is cleared
// before re-insert (a true point-in-time restore); otherwise documents are
// upserted on top of what's there.
async function restoreBackup(archivePath, { drop = true } = {}) {
  if (_busy) throw new Error("Another backup/restore is already running");
  // Held for the whole operation, including the safety backup below — using
  // the unlocked core there (instead of createBackup) means _busy never
  // drops back to false between the safety backup and the restore itself,
  // so a concurrent create/restore request can't slip into that gap.
  _busy = true;
  let safety = null;
  try {
    safety = await createBackupUnlocked({ reason: "pre-restore-safety" });
  } catch (e) {
    _busy = false;
    throw new Error("Aborted: could not take a safety backup first (" + e.message + ")");
  }

  const work = path.join(BACKUP_DIR, ".restore-" + Date.now());
  const summary = { safetyBackup: safety.id, collections: {}, files: {}, drop };
  try {
    await fsp.mkdir(work, { recursive: true });
    await run("tar", ["-xzf", archivePath, "-C", work]);

    const manifestRaw = await fsp.readFile(path.join(work, "manifest.json"), "utf8").catch(() => null);
    if (!manifestRaw) throw new Error("Not a valid backup: manifest.json missing");
    summary.manifest = JSON.parse(manifestRaw);

    const db = mongoose.connection && mongoose.connection.db;
    if (!db) throw new Error("Database is not connected");

    // 1. Database.
    const dbDir = path.join(work, "db");
    if (await exists(dbDir)) {
      for (const f of await fsp.readdir(dbDir)) {
        if (!f.endsWith(".json")) continue;
        const name = f.replace(/\.json$/, "");
        if (SKIP_COLLECTIONS.has(name)) continue;
        const docs = EJSON.parse(await fsp.readFile(path.join(dbDir, f), "utf8"), { relaxed: false });
        const coll = db.collection(name);
        if (drop) await coll.deleteMany({});
        let inserted = 0;
        for (let i = 0; i < docs.length; i += 500) {
          const chunk = docs.slice(i, i + 500);
          if (!chunk.length) continue;
          if (drop) {
            await coll.insertMany(chunk, { ordered: false });
          } else {
            await Promise.all(
              chunk.map((d) =>
                d._id !== undefined
                  ? coll.replaceOne({ _id: d._id }, d, { upsert: true })
                  : coll.insertOne(d),
              ),
            );
          }
          inserted += chunk.length;
        }
        summary.collections[name] = inserted;
      }
    }

    // 2. Uploaded images (additive; restore never deletes existing uploads).
    summary.files.uploads = await copyDir(path.join(work, "uploads"), UPLOADS_DIR);
    // 2b. Cached drop reward images (additive, same as uploads).
    summary.files.dropImages = await copyDir(
      path.join(work, "drop-images"),
      DROP_IMAGES_DIR,
    );
    // 3. Config + snapshots.
    const hostsBak = path.join(work, "config", "botHosts.json");
    if (await exists(hostsBak)) {
      await fsp.mkdir(path.dirname(HOSTS_FILE), { recursive: true });
      await fsp.copyFile(hostsBak, HOSTS_FILE);
      summary.files.botHosts = 1;
    }
    const settingsBak = path.join(work, "config", "settings.json");
    if (await exists(settingsBak)) {
      await fsp.copyFile(settingsBak, SETTINGS_FILE);
      summary.files.settings = 1;
    }
    summary.files.snapshots = await copyDir(path.join(work, "snapshots"), SNAPSHOT_DIR);

    return summary;
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    _busy = false;
  }
}

// ---- Daily scheduler -------------------------------------------------------
let _timer = null;
function msUntilNextRun() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(BACKUP_HOUR, BACKUP_MINUTE, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}
async function runScheduled(reason = "daily") {
  try {
    const r = await createBackup({ reason });
    console.log("[backup] " + reason + " backup created:", r.id, "(" + r.size + " bytes)");
    const problems = r.manifest.problems || [];
    if (problems.length) {
      await alert(reason + " backup " + r.id + " was saved WITHOUT: " + problems.join(", "));
    }
    const copies = await replicateOffsite(r.id);
    console.log("[backup] off-site copies of " + r.id + ":", JSON.stringify(copies));
  } catch (e) {
    // Never throw out of the scheduler — a backup failure must not crash the app.
    await alert(reason + " backup failed: " + e.message);
  }
}

// Staging and temp files left by a process that died mid-backup (a pm2
// restart during the old 1.5h Atlas dump left 1.3 GB of these behind).
async function cleanupStale() {
  let names = [];
  try {
    names = await fsp.readdir(BACKUP_DIR);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const n of names) {
    if (!/^\.(staging-|restore-)|^\..+\.tar\.gz\.enc$/.test(n)) continue;
    const p = path.join(BACKUP_DIR, n);
    try {
      const st = await fsp.stat(p);
      if (Date.now() - st.mtimeMs < STALE_STAGING_MS) continue;
      await fsp.rm(p, { recursive: true, force: true });
      removed++;
    } catch {
      /* ignore */
    }
  }
  if (removed) console.log("[backup] removed " + removed + " stale staging item(s)");
  return removed;
}

// A restart across the nightly slot used to skip that day silently. If the
// newest good backup is older than CATCHUP_AFTER_MS, make it up shortly after
// boot (unless the nightly run is about to happen anyway).
async function catchUpIfMissed() {
  const s = await readStatus();
  let newest = s.lastSuccess ? Date.parse(s.lastSuccess.at) : 0;
  if (!newest) {
    const list = await listBackups().catch(() => []);
    newest = list[0] ? Date.parse(list[0].createdAt) : 0;
  }
  if (newest && Date.now() - newest < CATCHUP_AFTER_MS) return false;
  if (msUntilNextRun() < 2 * 60 * 60 * 1000) return false;
  await runScheduled("catch-up");
  return true;
}

function start() {
  if (_timer) return;
  cleanupStale().catch(() => {});
  const tick = () => {
    runScheduled("daily");
    _timer = setTimeout(tick, 24 * 60 * 60 * 1000);
  };
  _timer = setTimeout(tick, msUntilNextRun());
  setTimeout(() => {
    catchUpIfMissed().catch((e) => console.error("[backup] catch-up check failed:", e.message));
  }, CATCHUP_DELAY_MS);
  console.log(
    "[backup] daily backups scheduled for " + String(BACKUP_HOUR).padStart(2, "0") + ":" +
      String(BACKUP_MINUTE).padStart(2, "0") + " (keeping " + RETENTION + "; off-site: " +
      (OFFSITE_HOSTS.join(", ") || "none") + ")",
  );
}

module.exports = {
  BACKUP_DIR,
  createBackup,
  listBackups,
  backupPath,
  deleteBackup,
  restoreBackup,
  replicateOffsite,
  status,
  cleanupStale,
  start,
};
