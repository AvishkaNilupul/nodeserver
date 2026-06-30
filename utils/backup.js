// Full-site backup & restore.
//
// A backup is a single `backup-<timestamp>.tar.gz` containing EVERYTHING needed
// to bring the site back from scratch:
//   db/<collection>.json   every MongoDB collection, in MongoDB Extended JSON
//                          (so ObjectIds / Dates restore with their real types)
//   uploads/...            the chat image uploads (public/uploads)
//   config/botHosts.json   remote SSH host definitions (gitignored on disk)
//   snapshots/...          the last-known Pi bot configs (accounts/passwords)
//   manifest.json          createdAt, reason, per-collection counts, file counts
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
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const { EJSON } = require("bson");

// Where backups live. Kept OUTSIDE the repo so `git pull` / editors never touch
// them and they survive redeploys. Override with BACKUP_DIR.
const BACKUP_DIR =
  process.env.BACKUP_DIR || path.join(os.homedir(), "redeemer-backups");
const UPLOADS_DIR = path.join(__dirname, "..", "public", "uploads");
const HOSTS_FILE = path.join(__dirname, "..", "config", "botHosts.json");
const SNAPSHOT_DIR =
  process.env.TWITCHBOT_SNAPSHOT_DIR ||
  path.join(path.dirname(process.env.TWITCHBOT_DIR || "/root/twitchbot"), "twitchbot-snapshots");

const RETENTION = Math.max(1, parseInt(process.env.BACKUP_RETENTION || "14", 10));
const BACKUP_HOUR = Math.min(23, Math.max(0, parseInt(process.env.BACKUP_HOUR || "23", 10)));
const BACKUP_MINUTE = Math.min(59, Math.max(0, parseInt(process.env.BACKUP_MINUTE || "59", 10)));

const NAME_RE = /^backup-[0-9A-Za-z_-]+\.tar\.gz$/;
const SKIP_COLLECTIONS = new Set(["sessions"]); // express sessions: transient, skip

let _busy = false; // serialise create/restore so they never overlap

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

// Build a full backup. Returns { id, file, size, manifest }.
async function createBackup({ reason = "manual" } = {}) {
  if (_busy) throw new Error("Another backup/restore is already running");
  _busy = true;
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
    // 3. Remote host config + Pi snapshot copies.
    if (await exists(HOSTS_FILE)) {
      await fsp.mkdir(path.join(staging, "config"), { recursive: true });
      await fsp.copyFile(HOSTS_FILE, path.join(staging, "config", "botHosts.json"));
      manifest.files.botHosts = 1;
    }
    manifest.files.snapshots = await copyDir(SNAPSHOT_DIR, path.join(staging, "snapshots"));

    await fsp.writeFile(
      path.join(staging, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );

    // 4. Compress (child process — non-blocking).
    await run("tar", ["-czf", outFile, "-C", staging, "."]);
    const st = await fsp.stat(outFile);
    await fsp.rm(staging, { recursive: true, force: true });
    await enforceRetention();
    return { id, file: outFile, size: st.size, manifest };
  } catch (e) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(outFile, { force: true }).catch(() => {});
    throw e;
  } finally {
    _busy = false;
  }
}

async function listBackups() {
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
  const names = (await fsp.readdir(BACKUP_DIR)).filter((n) => NAME_RE.test(n));
  const out = [];
  for (const n of names) {
    try {
      const st = await fsp.stat(path.join(BACKUP_DIR, n));
      out.push({ id: n.replace(/\.tar\.gz$/, ""), file: n, size: st.size, createdAt: st.mtime.toISOString() });
    } catch {
      /* skip */
    }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
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
  // Safety net first (uses its own _busy lock, so take it before we set ours).
  let safety = null;
  try {
    safety = await createBackup({ reason: "pre-restore-safety" });
  } catch (e) {
    throw new Error("Aborted: could not take a safety backup first (" + e.message + ")");
  }

  _busy = true;
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
    // 3. Config + snapshots.
    const hostsBak = path.join(work, "config", "botHosts.json");
    if (await exists(hostsBak)) {
      await fsp.mkdir(path.dirname(HOSTS_FILE), { recursive: true });
      await fsp.copyFile(hostsBak, HOSTS_FILE);
      summary.files.botHosts = 1;
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
async function runScheduled() {
  try {
    const r = await createBackup({ reason: "daily" });
    console.log("[backup] daily backup created:", r.id, "(" + r.size + " bytes)");
  } catch (e) {
    // Never throw out of the scheduler — a backup failure must not crash the app.
    console.error("[backup] daily backup failed:", e.message);
  }
}
function start() {
  if (_timer) return;
  const tick = () => {
    runScheduled();
    _timer = setTimeout(tick, 24 * 60 * 60 * 1000);
  };
  _timer = setTimeout(tick, msUntilNextRun());
  console.log("[backup] daily backups scheduled for " + String(BACKUP_HOUR).padStart(2, "0") + ":" + String(BACKUP_MINUTE).padStart(2, "0") + " (keeping " + RETENTION + ")");
}

module.exports = {
  BACKUP_DIR,
  createBackup,
  listBackups,
  backupPath,
  deleteBackup,
  restoreBackup,
  start,
};
