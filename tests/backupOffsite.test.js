// The backup chain must be provable: stale staging from a dead process is
// cleaned up, status.json drives the page and the health check, and the
// health check fails loudly when the newest good backup is old or an off-site
// copy is missing. No DB, no SSH: BACKUP_DIR is a temp dir and no off-site
// host is configured.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bk-"));
process.env.BACKUP_DIR = DIR;
process.env.BACKUP_KEY_FILE = path.join(DIR, "key");
process.env.BACKUP_OFFSITE_HOSTS = "";
const backup = require("../utils/backup");
const health = require("../utils/systemHealth");

test("cleanupStale removes old staging and temp copies, keeps fresh ones", async () => {
  const old = path.join(DIR, ".staging-backup-old");
  const fresh = path.join(DIR, ".staging-backup-new");
  const enc = path.join(DIR, ".backup-x.tar.gz.enc");
  const real = path.join(DIR, "backup-2026-09-28_2359-00-daily-aaaa.tar.gz");
  for (const d of [old, fresh]) fs.mkdirSync(d);
  fs.writeFileSync(enc, "x");
  fs.writeFileSync(real, "x");
  const past = new Date(Date.now() - 4 * 3600e3);
  fs.utimesSync(old, past, past);
  fs.utimesSync(enc, past, past);
  fs.utimesSync(real, past, past);
  assert.strictEqual(await backup.cleanupStale(), 2);
  assert.ok(!fs.existsSync(old));
  assert.ok(!fs.existsSync(enc));
  assert.ok(fs.existsSync(fresh));
  assert.ok(fs.existsSync(real), "a real backup is never touched");
});

test("status reports last success, off-site results and per-backup copies", async () => {
  const id = "backup-2026-09-28_2359-00-daily-aaaa";
  fs.writeFileSync(
    path.join(DIR, "status.json"),
    JSON.stringify({
      lastSuccess: { at: "2026-09-28T23:59:30Z", id, size: 1 },
      offsite: { pi: { id, ok: true, at: "2026-09-29T00:02:00Z" } },
      copies: { [id]: { pi: { ok: true } } },
    }),
  );
  const s = await backup.status();
  assert.strictEqual(s.lastSuccess.id, id);
  assert.strictEqual(s.offsite.pi.ok, true);
  const list = await backup.listBackups();
  assert.deepStrictEqual(list.find((b) => b.id === id).offsite, { pi: { ok: true } });
});

test("replicateOffsite with no off-site host configured is a no-op, not an error", async () => {
  const r = await backup.replicateOffsite("backup-2026-09-28_2359-00-daily-aaaa");
  assert.ok(r.skipped);
});

const NOW = new Date("2026-09-29T12:00:00Z");
async function runBackupCheck(status) {
  const run = await health.runAll({
    only: ["backups.offsite"],
    deps: { backup: { status: async () => status } },
    now: () => NOW,
  });
  return run.checks[0];
}

test("health: fresh backup verified everywhere is ok", async () => {
  const c = await runBackupCheck({
    lastSuccess: { at: "2026-09-29T00:00:00Z", id: "b1", problems: [] },
    offsiteHosts: ["pi", "contabo"],
    offsite: { pi: { id: "b1", ok: true }, contabo: { id: "b1", ok: true } },
  });
  assert.strictEqual(c.status, "ok");
});

test("health: a failed or missing off-site copy warns", async () => {
  const c = await runBackupCheck({
    lastSuccess: { at: "2026-09-29T00:00:00Z", id: "b2", problems: [] },
    offsiteHosts: ["pi", "contabo"],
    offsite: { pi: { id: "b2", ok: false, error: "unreachable" }, contabo: { id: "b1", ok: true } },
  });
  assert.strictEqual(c.status, "warn");
  assert.strictEqual(c.items.length, 2);
});

test("health: no good backup in 26h fails", async () => {
  const c = await runBackupCheck({
    lastSuccess: { at: "2026-09-27T23:59:00Z", id: "b0" },
    offsiteHosts: [],
    offsite: {},
  });
  assert.strictEqual(c.status, "fail");
});

test("health: never backed up fails", async () => {
  const c = await runBackupCheck({ offsiteHosts: [], offsite: {} });
  assert.strictEqual(c.status, "fail");
});
