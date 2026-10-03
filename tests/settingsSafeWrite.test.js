// settings.json saves that cannot tear or wipe (docs/LIVE-FIXES-1003.md §A1,
// defect 12). Before 2026-10-03 every save in a process shared one temp file
// (settings.json.tmp-<pid>) and rewrote the WHOLE file from the caller's copy,
// and a file that did not parse read as DEFAULTS — which the next save wrote
// back, wiping every marketplace credential and turning Plati back on.
//
// Every case loads a FRESH utils/settings.js pointed at its own temp dir via
// SETTINGS_FILE, so the real utils/settings.json is never touched and no
// in-memory state (the last good copy, the save chain) leaks between cases.
// Two instances on one file stand for two processes (each has its own memory
// copy and save chain, so only settings.json.lock keeps them apart); one case
// runs two real child processes. systemLog is stubbed (events captured,
// mongoose never loaded) and console.error is captured. No DB, no network.
//
// Run: CRED_SECRET=x node --test tests/settingsSafeWrite.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const Module = require("module");
const { spawn, spawnSync } = require("child_process");

// setEpicAutoClaim encrypts through utils/secretBox, which needs a key.
if (!process.env.CRED_SECRET) process.env.CRED_SECRET = "x";

const SETTINGS_PATH = require.resolve("../utils/settings");
const MARKETPLACES_PATH = require.resolve("../utils/marketplaces");

// settings.js requires ./systemLog lazily (audit + corrupt-file events).
const events = [];
const realLoad = Module._load;
Module._load = function (request, parent) {
  if (request === "./systemLog" && parent && parent.filename === SETTINGS_PATH)
    return {
      logEvent: async (e) => {
        events.push(e);
      },
    };
  return realLoad.apply(this, arguments);
};

const errors = [];
const realConsoleError = console.error;
console.error = (...args) => errors.push(args.join(" "));

const dirs = [];
test.after(() => {
  Module._load = realLoad;
  console.error = realConsoleError;
  delete require.cache[SETTINGS_PATH];
  delete require.cache[MARKETPLACES_PATH];
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

// A settings module of its own (memory copy, save chain) on `file` — what a
// second process sees.
function instance(file) {
  const prev = process.env.SETTINGS_FILE;
  process.env.SETTINGS_FILE = file;
  delete require.cache[SETTINGS_PATH];
  try {
    return require(SETTINGS_PATH);
  } finally {
    if (prev === undefined) delete process.env.SETTINGS_FILE;
    else process.env.SETTINGS_FILE = prev;
  }
}

// A fresh settings module whose settings.json lives in its own temp dir;
// `files` seeds that dir (an object is written as JSON, a string verbatim).
function fresh(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-safe-write-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files))
    fs.writeFileSync(
      path.join(dir, name),
      typeof body === "string" ? body : JSON.stringify(body, null, 2),
    );
  const file = path.join(dir, "settings.json");
  const settings = instance(file);
  events.length = 0;
  errors.length = 0;
  return {
    settings,
    dir,
    file,
    lastgood: file + ".lastgood",
    disk: () => JSON.parse(fs.readFileSync(file, "utf8")),
    ls: () => fs.readdirSync(dir).sort(),
  };
}

// A production-shaped file: credentials, switches, a top-level secret.
const PROD = {
  require2fa: true,
  autoFarm: {
    enabled: true,
    dryRun: false,
    platiEnabled: false,
    ggselEnabled: true,
    maxAutoBots: 33,
    unclaimedGameCaps: { overwatch: 25 },
  },
  marketplaces: {
    gameflip: { apiKey: "enc:v1:gf-key", apiSecret: "enc:v1:gf-secret" },
    g2g: {
      userId: "enc:v1:g2g-user",
      refreshToken: "enc:v1:g2g-refresh",
      accessToken: "enc:v1:g2g-access",
    },
    eldorado: { cookie: "enc:v1:eld-cookie" },
  },
  playerauctionsInstallSecret: "pa-install-secret",
};
// A write cut short: what a torn settings.json looks like.
const TORN = JSON.stringify(PROD, null, 2).slice(0, 120);
// An operator's hand backup under the old name: older, Plati on, stale cookie.
const OPERATOR_BAK = {
  require2fa: true,
  autoFarm: { enabled: true, dryRun: false, platiEnabled: true, maxAutoBots: 40 },
  marketplaces: { eldorado: { cookie: "enc:v1:cookie-pasted-09-02" }, z2u: { cookie: "enc:v1:z2u" } },
};

// utils/marketplaces.js setKeys, in shape: load, edit one marketplace's fields
// in place, save the loaded object. (Loading happens synchronously at the call,
// exactly as there.)
async function setKeys(settings, marketplace, values) {
  const s = settings.loadSettings();
  s.marketplaces = s.marketplaces || {};
  const cur = s.marketplaces[marketplace] || {};
  for (const [f, v] of Object.entries(values)) cur[f] = v;
  s.marketplaces[marketplace] = cur;
  await settings.saveSettings(s);
}

const keptCopies = (ls, suffix = ".corrupt-") =>
  ls().filter((n) => n.startsWith("settings.json" + suffix));
const ago = (ms) => new Date(Date.now() - ms);
const isRoot = typeof process.getuid === "function" && process.getuid() === 0; // chmod does not stop root
// The pid of a process that has already exited.
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;
// A promise's outcome within `ms` — { value } / { error } / { pending: true } —
// so a save that never settles fails its test instead of hanging it.
function settle(p, ms) {
  let timer;
  return Promise.race([
    p.then((value) => ({ value }), (error) => ({ error })),
    new Promise((r) => {
      timer = setTimeout(() => r({ pending: true }), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
async function waitFor(cond, ms = 10000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("two setAutoFarm calls in flight together both land", async () => {
  const { settings, disk } = fresh({ "settings.json": PROD });
  await Promise.all([
    settings.setAutoFarm({ pristineReserve: 120 }),
    settings.setAutoFarm({ hostMinFreeMb: 2000 }),
  ]);
  const d = disk();
  assert.equal(d.autoFarm.pristineReserve, 120);
  assert.equal(d.autoFarm.hostMinFreeMb, 2000);
  assert.equal(d.autoFarm.maxAutoBots, 33);
  assert.deepEqual(d.marketplaces, PROD.marketplaces);
});

test("a credential write racing setAutoFarm keeps both, in either order", async () => {
  // The refresh loaded BEFORE the operator's toggle landed, saves AFTER it.
  {
    const { settings, disk } = fresh({ "settings.json": PROD });
    const s = settings.loadSettings();
    await settings.setAutoFarm({ ggselEnabled: false });
    s.marketplaces.eldorado.cookie = "enc:v1:eld-cookie-2";
    await settings.saveSettings(s);
    const d = disk();
    assert.equal(d.autoFarm.ggselEnabled, false);
    assert.equal(d.marketplaces.eldorado.cookie, "enc:v1:eld-cookie-2");
    assert.equal(d.autoFarm.maxAutoBots, 33);
  }
  // Both in flight at once, the credential write first.
  {
    const { settings, disk } = fresh({ "settings.json": PROD });
    await Promise.all([
      setKeys(settings, "g2g", { accessToken: "enc:v1:g2g-access-2" }),
      settings.setAutoFarm({ noclaimMaxBots: 30 }),
      setKeys(settings, "zeusx", { accessToken: "enc:v1:zx" }),
    ]);
    const d = disk();
    assert.equal(d.autoFarm.noclaimMaxBots, 30);
    assert.equal(d.marketplaces.g2g.accessToken, "enc:v1:g2g-access-2");
    assert.equal(d.marketplaces.g2g.refreshToken, "enc:v1:g2g-refresh");
    assert.equal(d.marketplaces.zeusx.accessToken, "enc:v1:zx");
    assert.deepEqual(d.marketplaces.gameflip, PROD.marketplaces.gameflip);
  }
});

test("two writers adding credentials to a file with no marketplaces block keep both", async () => {
  const { settings, disk } = fresh({ "settings.json": { require2fa: false } });
  const a = settings.loadSettings();
  const b = settings.loadSettings();
  a.marketplaces = { gameflip: { apiKey: "enc:v1:gf" } };
  b.marketplaces = { g2g: { userId: "enc:v1:u" } };
  await Promise.all([settings.saveSettings(a), settings.saveSettings(b)]);
  assert.deepEqual(disk().marketplaces, {
    gameflip: { apiKey: "enc:v1:gf" },
    g2g: { userId: "enc:v1:u" },
  });
});

test("a key the caller deleted stays deleted, and racing changes survive", async () => {
  const { settings, disk } = fresh({ "settings.json": PROD });
  const s = settings.loadSettings();
  delete s.playerauctionsInstallSecret; // top-level deletion
  delete s.marketplaces.eldorado; // nested deletion
  await settings.setAutoFarm({ ggselEnabled: false }); // racing writers
  await setKeys(settings, "g2g", { accessToken: "enc:v1:g2g-access-2" });
  await settings.saveSettings(s);
  const d = disk();
  assert.equal("playerauctionsInstallSecret" in d, false);
  assert.equal("eldorado" in d.marketplaces, false);
  assert.equal(d.autoFarm.ggselEnabled, false);
  assert.equal(d.marketplaces.g2g.accessToken, "enc:v1:g2g-access-2");
  assert.deepEqual(d.marketplaces.gameflip, PROD.marketplaces.gameflip);
});

test("a torn file is served from settings.json.lastgood, and the next save heals it", async () => {
  const { settings, disk, lastgood, dir, ls } = fresh({
    "settings.json": TORN,
    "settings.json.lastgood": PROD,
  });
  const s = settings.loadSettings();
  assert.deepEqual(s.marketplaces, PROD.marketplaces);
  assert.equal(settings.getAutoFarm().enabled, true);
  assert.equal(settings.getAutoFarm().maxAutoBots, 33);
  assert.ok(
    events.some(
      (e) => e.action === "settings_corrupt" && e.meta.served === "lastgood" && e.severity === "warn",
    ),
  );

  await settings.setAutoFarm({ noclaimMaxBots: 30 });
  const healed = disk();
  assert.deepEqual(healed.marketplaces, PROD.marketplaces);
  assert.equal(healed.autoFarm.noclaimMaxBots, 30);
  assert.equal(healed.autoFarm.enabled, true);
  assert.equal(healed.playerauctionsInstallSecret, PROD.playerauctionsInstallSecret);
  assert.deepEqual(JSON.parse(fs.readFileSync(lastgood, "utf8")), healed);
  // The torn bytes were kept, not destroyed (a hand edit with a typo looks
  // exactly like this).
  const kept = keptCopies(ls);
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, kept[0]), "utf8"), TORN);
});

test("an operator's settings.json.bak is never written, and never served for a torn file", async () => {
  // A healthy start: saves leave the hand backup byte for byte.
  {
    const { settings, dir, ls } = fresh({
      "settings.json": PROD,
      "settings.json.bak": OPERATOR_BAK,
    });
    const before = fs.readFileSync(path.join(dir, "settings.json.bak"), "utf8");
    await settings.setAutoFarm({ hostMinFreeMb: 1500 });
    await setKeys(settings, "eldorado", { cookie: "enc:v1:renewed" });
    assert.equal(fs.readFileSync(path.join(dir, "settings.json.bak"), "utf8"), before);
    assert.deepEqual(ls(), ["settings.json", "settings.json.bak", "settings.json.lastgood"]);
  }
  // A torn file at startup next to a stale hand backup: the backup (Plati on,
  // a dead cookie) is NOT served, and nothing is rebuilt from it.
  {
    const { settings, file, dir } = fresh({
      "settings.json": TORN,
      "settings.json.bak": OPERATOR_BAK,
    });
    assert.equal(settings.getAutoFarm().platiEnabled, false);
    assert.equal(settings.loadSettings().marketplaces, undefined);
    await assert.rejects(settings.setAutoFarm({ enabled: true }), { code: "SETTINGS_CORRUPT" });
    assert.equal(fs.readFileSync(file, "utf8"), TORN);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "settings.json.bak"), "utf8")), OPERATOR_BAK);
  }
});

test("the in-memory good copy serves a file torn after it was read, and a save heals from it", async () => {
  const { settings, file, disk, dir, ls } = fresh({ "settings.json": PROD });
  assert.equal(settings.getAutoFarm().maxAutoBots, 33); // the process has seen the good file
  fs.writeFileSync(file, TORN); // torn by something outside this process
  const s = settings.loadSettings();
  assert.deepEqual(s.marketplaces, PROD.marketplaces);
  assert.equal(settings.getAutoFarm().enabled, true);
  assert.ok(
    events.some(
      (e) => e.action === "settings_corrupt" && e.meta.served === "memory" && e.severity === "warn",
    ),
  );
  s.marketplaces.g2g.accessToken = "enc:v1:new";
  await settings.saveSettings(s);
  const d = disk();
  assert.equal(d.marketplaces.g2g.accessToken, "enc:v1:new");
  assert.equal(d.autoFarm.enabled, true);
  assert.equal(d.require2fa, true);
  assert.equal(d.playerauctionsInstallSecret, PROD.playerauctionsInstallSecret);
  const kept = keptCopies(ls);
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, kept[0]), "utf8"), TORN);
});

test("a stale memory copy loses to a newer .lastgood another process wrote (read and heal)", async () => {
  const { settings: script, file, disk } = fresh({ "settings.json": PROD });
  script.getAutoFarm(); // a long-running script reads the file once, at its start
  const server = instance(file);
  await setKeys(server, "g2g", { refreshToken: "enc:v1:g2g-refresh-ROTATED" });
  await server.setAutoFarm({ ggselEnabled: false });
  // settings.json is momentarily unreadable (a non-atomic writer: a backup
  // restore's copyFile, an editor saving in place).
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").slice(0, 50));
  assert.equal(script.loadSettings().marketplaces.g2g.refreshToken, "enc:v1:g2g-refresh-ROTATED");
  assert.equal(script.getAutoFarm().ggselEnabled, false);
  await script.setAutoFarm({ unclaimedAutoListPaused: true });
  const d = disk();
  assert.equal(d.marketplaces.g2g.refreshToken, "enc:v1:g2g-refresh-ROTATED");
  assert.equal(d.autoFarm.ggselEnabled, false);
  assert.equal(d.autoFarm.unclaimedAutoListPaused, true);
});

test("a memory copy NEWER than .lastgood (a hand edit read since the last save) still wins", async () => {
  const { settings, file, lastgood, disk } = fresh({ "settings.json": PROD });
  await settings.setAutoFarm({ hostMinFreeMb: 1500 }); // writes .lastgood
  fs.utimesSync(lastgood, ago(60 * 1000), ago(60 * 1000)); // that save was a minute ago
  const edited = { ...disk(), autoFarm: { ...disk().autoFarm, maxAutoBots: 99 } };
  fs.writeFileSync(file, JSON.stringify(edited)); // the operator edits by hand
  assert.equal(settings.getAutoFarm().maxAutoBots, 99); // read
  fs.writeFileSync(file, TORN); // then the file tears
  assert.equal(settings.getAutoFarm().maxAutoBots, 99);
  await settings.setAutoFarm({ noclaimMaxBots: 12 });
  assert.equal(disk().autoFarm.maxAutoBots, 99);
  assert.equal(disk().autoFarm.noclaimMaxBots, 12);
});

test("a file deleted under a running process is rebuilt from the good copy, not DEFAULTS", async () => {
  const { settings, file, disk } = fresh({ "settings.json": PROD });
  settings.loadSettings();
  fs.unlinkSync(file);
  assert.deepEqual(settings.loadSettings().marketplaces, PROD.marketplaces);
  await settings.setRequire2fa(false);
  const d = disk();
  assert.equal(d.require2fa, false);
  assert.deepEqual(d.marketplaces, PROD.marketplaces);
  assert.equal(d.autoFarm.enabled, true);
});

test("a missing settings.json next to a readable .lastgood is served from it and rebuilt", async () => {
  const { settings, disk } = fresh({ "settings.json.lastgood": PROD }); // a restart
  const s = settings.loadSettings();
  assert.deepEqual(s.marketplaces, PROD.marketplaces);
  assert.equal(settings.getAutoFarm().enabled, true);
  assert.ok(
    events.some(
      (e) =>
        e.action === "settings_corrupt" &&
        e.meta.served === "lastgood" &&
        e.meta.missing === true &&
        e.severity === "warn",
    ),
  );
  await settings.setRequire2fa(false);
  const d = disk();
  assert.equal(d.require2fa, false);
  assert.deepEqual(d.marketplaces, PROD.marketplaces);
  assert.equal(d.autoFarm.maxAutoBots, 33);
});

test("a missing settings.json next to an unreadable .lastgood is NOT a fresh install", async () => {
  const BROKEN = JSON.stringify(PROD).slice(0, 77);
  const { settings, file, lastgood, dir, ls } = fresh({ "settings.json.lastgood": BROKEN });
  const s = settings.loadSettings();
  assert.equal(s.marketplaces, undefined);
  assert.equal(settings.getAutoFarm().platiEnabled, false);
  assert.equal(settings.getAutoFarm().enabled, false);
  const loud = events.filter((e) => e.action === "settings_corrupt" && e.meta.served === "defaults");
  assert.equal(loud.length, 1);
  assert.equal(loud[0].severity, "error");
  assert.equal(loud[0].meta.missing, true);
  assert.ok(errors.some((l) => /NOT a fresh install/.test(l)));

  await assert.rejects(settings.setAutoFarm({ enabled: true }), { code: "SETTINGS_CORRUPT" });
  s.marketplaces = { gameflip: { apiKey: "enc:v1:typed-into-defaults" } };
  await assert.rejects(settings.saveSettings(s), { code: "SETTINGS_CORRUPT" });
  assert.equal(fs.existsSync(file), false); // nothing started over from defaults
  assert.equal(fs.readFileSync(lastgood, "utf8"), BROKEN); // the spare itself untouched
  // Its bytes are kept once — not again on every read, nor after a restart.
  for (let i = 0; i < 20; i++) settings.loadSettings();
  instance(file).loadSettings();
  const kept = keptCopies(ls, ".lastgood-corrupt-");
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, kept[0]), "utf8"), BROKEN);
});

test("a torn file with no good copy reads as DEFAULTS (Plati off) and every save is refused", async () => {
  for (const spare of [null, "{"]) {
    const { settings, file, ls } = fresh({
      "settings.json": TORN,
      ...(spare ? { "settings.json.lastgood": spare } : {}),
    });
    const before = ls();
    const s = settings.loadSettings();
    assert.equal(s.marketplaces, undefined);
    assert.equal(s.autoFarm.platiEnabled, false);
    assert.equal(settings.getAutoFarm().platiEnabled, false);
    assert.equal(settings.getAutoFarm().enabled, false);

    await assert.rejects(settings.setAutoFarm({ enabled: true }), { code: "SETTINGS_CORRUPT" });
    await assert.rejects(settings.setRequire2fa(true), { code: "SETTINGS_CORRUPT" });
    s.marketplaces = { gameflip: { apiKey: "enc:v1:typed-into-defaults" } };
    await assert.rejects(settings.saveSettings(s), { code: "SETTINGS_CORRUPT" });
    // An object loadSettings never handed out is no exception here.
    await assert.rejects(settings.saveSettings({ require2fa: true }), {
      code: "SETTINGS_CORRUPT",
    });
    assert.equal(fs.readFileSync(file, "utf8"), TORN); // untouched
    // No temp file and no lock left; an unreadable spare's bytes kept once.
    const added = ls().filter((n) => !before.includes(n));
    assert.deepEqual(added, spare ? keptCopies(ls, ".lastgood-corrupt-") : []);
    assert.equal(added.length, spare ? 1 : 0);

    // Reported to the console and as a SystemEvent — once a minute, not per read.
    for (let i = 0; i < 50; i++) settings.loadSettings();
    const served = events.filter((e) => e.action === "settings_corrupt" && e.meta.served === "defaults");
    assert.equal(served.length, 1);
    assert.equal(served[0].severity, "error");
    assert.ok(events.some((e) => e.action === "settings_corrupt" && e.meta.refusedSave === true));
    assert.ok(errors.some((l) => /serving DEFAULTS/.test(l)));
  }
});

test("once the file is fixed by hand, an object loaded from DEFAULTS saves only its own edits", async () => {
  const { settings, file, disk } = fresh({ "settings.json": TORN });
  const s = settings.loadSettings(); // DEFAULTS: enabled false, no marketplaces
  s.marketplaces = { zeusx: { accessToken: "enc:v1:zx" } };
  fs.writeFileSync(file, JSON.stringify(PROD)); // the operator restores the file
  await settings.saveSettings(s);
  const d = disk();
  assert.equal(d.marketplaces.zeusx.accessToken, "enc:v1:zx");
  assert.deepEqual(d.marketplaces.gameflip, PROD.marketplaces.gameflip);
  assert.equal(d.autoFarm.enabled, true); // not reverted to the default
  assert.equal(d.require2fa, true);
});

test("a missing file with no .lastgood is a fresh install: DEFAULTS, silently, and the first save creates it", async () => {
  const { settings, file, disk, ls } = fresh();
  const s = settings.loadSettings();
  assert.equal(fs.existsSync(file), false);
  assert.equal(s.autoFarm.platiEnabled, false);
  assert.equal(errors.length, 0);
  assert.equal(events.length, 0);
  s.marketplaces = { gameflip: { apiKey: "enc:v1:k1" } };
  await settings.saveSettings(s);
  const d = disk();
  assert.deepEqual(d.marketplaces, { gameflip: { apiKey: "enc:v1:k1" } });
  assert.equal(d.autoFarm.platiEnabled, false); // DEFAULTS filled in, as before
  assert.equal(d.noclaimShop.autoDeliver, true);
  assert.deepEqual(ls(), ["settings.json", "settings.json.lastgood"]);
});

test("settings.json is fsync'd before its rename; .lastgood is not (it is only the spare)", async () => {
  const { settings, disk, lastgood } = fresh({ "settings.json": PROD });
  const synced = [];
  const realOpen = fsp.open;
  fsp.open = async function (...args) {
    const fh = await realOpen.apply(this, args);
    const realSync = fh.sync.bind(fh);
    fh.sync = async () => {
      synced.push(path.basename(String(args[0])));
      return realSync();
    };
    return fh;
  };
  try {
    await settings.setAutoFarm({ hostMinFreeMb: 7 });
  } finally {
    fsp.open = realOpen;
  }
  assert.equal(synced.length, 1);
  assert.match(synced[0], /^settings\.json\.tmp-\d+-\d+-[0-9a-f]{8}$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(lastgood, "utf8")), disk());
});

test("a failed rename leaves no temp file and no lock, keeps the old file, and does not block the next save", async () => {
  const { settings, file, disk, ls } = fresh({ "settings.json": PROD });
  const before = fs.readFileSync(file, "utf8");
  const realRename = fsp.rename;
  let failures = 1;
  fsp.rename = async function (from, to) {
    if (failures > 0 && String(to).endsWith("settings.json")) {
      failures--;
      const e = new Error("EIO: injected rename failure");
      e.code = "EIO";
      throw e;
    }
    return realRename.apply(this, arguments);
  };
  try {
    await assert.rejects(settings.setAutoFarm({ hostMinFreeMb: 1 }), /injected/);
  } finally {
    fsp.rename = realRename;
  }
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.deepEqual(ls(), ["settings.json"]);
  const t0 = Date.now();
  await settings.setAutoFarm({ hostMinFreeMb: 2 });
  assert.ok(Date.now() - t0 < 1000, "the next save did not wait on a leftover lock");
  assert.equal(disk().autoFarm.hostMinFreeMb, 2);
  assert.deepEqual(ls(), ["settings.json", "settings.json.lastgood"]);
});

test("a write that fails half way removes its temp file and keeps the old file", async () => {
  // White-box: the temp file is written through a FileHandle from fsp.open.
  const { settings, file, disk, ls } = fresh({ "settings.json": PROD });
  const before = fs.readFileSync(file, "utf8");
  const realOpen = fsp.open;
  let failures = 1;
  fsp.open = async function (...args) {
    const fh = await realOpen.apply(this, args);
    if (failures > 0 && /settings\.json\.tmp-/.test(String(args[0]))) {
      failures--;
      fh.writeFile = async () => {
        const e = new Error("ENOSPC: injected disk full");
        e.code = "ENOSPC";
        throw e;
      };
    }
    return fh;
  };
  try {
    await assert.rejects(settings.setAutoFarm({ hostMinFreeMb: 1 }), /injected/);
  } finally {
    fsp.open = realOpen;
  }
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.deepEqual(ls(), ["settings.json"]);
  await settings.setAutoFarm({ hostMinFreeMb: 3 });
  assert.equal(disk().autoFarm.hostMinFreeMb, 3);
});

test("reads racing many saves always see a whole file, and every save lands", async () => {
  const { settings, disk, lastgood, ls } = fresh({ "settings.json": PROD });
  const writes = [];
  for (let i = 0; i < 30; i++) {
    writes.push(settings.setAutoFarm({ ["k" + i]: i }));
    writes.push(setKeys(settings, "eldorado", { cookie: "enc:v1:c" + i }));
  }
  let done = false;
  const all = Promise.all(writes).finally(() => {
    done = true;
  });
  let reads = 0;
  while (!done) {
    const s = settings.loadSettings();
    assert.deepEqual(s.marketplaces.gameflip, PROD.marketplaces.gameflip);
    assert.equal(s.autoFarm.enabled, true);
    reads++;
    await new Promise((r) => setImmediate(r));
  }
  await all;
  assert.ok(reads > 0);
  const d = disk();
  for (let i = 0; i < 30; i++) assert.equal(d.autoFarm["k" + i], i);
  assert.equal(d.marketplaces.eldorado.cookie, "enc:v1:c29"); // call order kept
  assert.deepEqual(JSON.parse(fs.readFileSync(lastgood, "utf8")), d);
  assert.deepEqual(ls(), ["settings.json", "settings.json.lastgood"]);
  assert.equal(errors.length, 0); // no fallback was ever needed
});

test("two processes saving into one file lose nothing (settings.json.lock)", async () => {
  const { settings: a, file, disk, ls } = fresh({ "settings.json": PROD });
  const b = instance(file); // its own memory copy and save chain
  const jobs = [];
  for (let i = 0; i < 40; i++) {
    jobs.push(a.setAutoFarm({ ["a" + i]: i }));
    jobs.push(b.setAutoFarm({ ["b" + i]: i }));
    jobs.push(setKeys(b, "g2g", { accessToken: "enc:v1:b" + i }));
    jobs.push(setKeys(a, "eldorado", { cookie: "enc:v1:a" + i }));
  }
  await Promise.all(jobs);
  const d = disk();
  for (let i = 0; i < 40; i++) {
    assert.equal(d.autoFarm["a" + i], i);
    assert.equal(d.autoFarm["b" + i], i);
  }
  assert.equal(d.marketplaces.g2g.accessToken, "enc:v1:b39");
  assert.equal(d.marketplaces.eldorado.cookie, "enc:v1:a39");
  assert.deepEqual(d.marketplaces.gameflip, PROD.marketplaces.gameflip);
  assert.deepEqual(ls(), ["settings.json", "settings.json.lastgood"]);
});

test("two real child processes saving into one file lose nothing", async () => {
  const { file, disk, ls } = fresh({ "settings.json": PROD });
  // Each child stubs systemLog like this file does (the audit would otherwise
  // load mongoose and hold the child open on a buffered write).
  const child = `
    const Module = require("module");
    const SP = process.env.SETTINGS_MODULE;
    const realLoad = Module._load;
    Module._load = function (request, parent) {
      if (request === "./systemLog" && parent && parent.filename === SP) return { logEvent: async () => {} };
      return realLoad.apply(this, arguments);
    };
    const settings = require(SP);
    (async () => {
      for (let i = 0; i < Number(process.env.N); i++) await settings.setAutoFarm({ [process.env.TAG + i]: i });
    })().then(() => process.exit(0), (e) => { console.error(e && e.stack); process.exit(1); });`;
  const N = 30;
  const run = (tag) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, ["-e", child], {
        env: { ...process.env, SETTINGS_FILE: file, SETTINGS_MODULE: SETTINGS_PATH, TAG: tag, N: String(N) },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      p.stderr.on("data", (c) => (stderr += c));
      p.on("exit", (code) => resolve({ code, stderr }));
    });
  const results = await Promise.all([run("p"), run("q")]);
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  const d = disk();
  for (let i = 0; i < N; i++) {
    assert.equal(d.autoFarm["p" + i], i);
    assert.equal(d.autoFarm["q" + i], i);
  }
  assert.deepEqual(d.marketplaces, PROD.marketplaces);
  assert.deepEqual(ls(), ["settings.json", "settings.json.lastgood"]);
});

test("a live owner's lock is never broken under 120 s, however old: the save fails with SETTINGS_LOCKED and writes nothing", async () => {
  const { settings, file, disk, ls } = fresh({ "settings.json": PROD });
  const lock = file + ".lock";
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  try {
    const token = `${holder.pid} live-holder`;
    fs.writeFileSync(lock, token);
    fs.utimesSync(lock, ago(60 * 1000), ago(60 * 1000)); // a slow save: a minute in, still alive
    const before = fs.readFileSync(file, "utf8");
    const t0 = Date.now();
    await assert.rejects(settings.setAutoFarm({ hostMinFreeMb: 1 }), { code: "SETTINGS_LOCKED" });
    const waited = Date.now() - t0;
    assert.ok(waited >= 2500 && waited < 6000, `waited ${waited} ms`);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.equal(fs.readFileSync(lock, "utf8"), token); // another process's lock is left alone
    assert.deepEqual(ls(), ["settings.json", "settings.json.lock"]);
  } finally {
    holder.kill("SIGKILL");
  }
  await new Promise((r) => holder.on("exit", r));
  // Its owner is gone: broken at once.
  const t1 = Date.now();
  await settings.setAutoFarm({ hostMinFreeMb: 2 });
  assert.ok(Date.now() - t1 < 1000);
  assert.equal(disk().autoFarm.hostMinFreeMb, 2);
  assert.deepEqual(ls(), ["settings.json", "settings.json.lastgood"]);
});

test("a lock over 120 s old is broken whoever owns it; a dead owner's at any age, a future mtime included", async () => {
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  try {
    for (const [owner, mtime] of [
      [String(holder.pid), ago(121 * 1000)], // a live owner: only age clears it
      [String(deadPid()), ago(-120 * 1000)], // the clock was stepped back after the crash
      [String(deadPid()), ago(0)],
    ]) {
      const { settings, file, disk, ls } = fresh({ "settings.json": PROD });
      fs.writeFileSync(file + ".lock", `${owner} left-behind`);
      fs.utimesSync(file + ".lock", mtime, mtime);
      const t0 = Date.now();
      await settings.setAutoFarm({ hostMinFreeMb: 3 });
      assert.ok(Date.now() - t0 < 1000, `${owner} ${mtime.toISOString()}`);
      assert.equal(disk().autoFarm.hostMinFreeMb, 3);
      assert.deepEqual(ls(), ["settings.json", "settings.json.lastgood"]);
    }
    // A live owner whose lock has a FUTURE mtime is judged by its owner, not age.
    const { settings, file } = fresh({ "settings.json": PROD });
    fs.writeFileSync(file + ".lock", `${holder.pid} clock-stepped-back`);
    fs.utimesSync(file + ".lock", ago(-300 * 1000), ago(-300 * 1000));
    await assert.rejects(settings.setRequire2fa(false), { code: "SETTINGS_LOCKED" });
    assert.equal(fs.readFileSync(file + ".lock", "utf8"), `${holder.pid} clock-stepped-back`);
  } finally {
    holder.kill("SIGKILL");
  }
});

test("a lock naming this process that none of its saves holds is stale: broken at once", async () => {
  // A token this process lost or released and someone put back, or the lock of
  // an earlier process that had our pid: saves inside a process run one at a
  // time, so it cannot be a live save of ours.
  const { settings, file, disk } = fresh({ "settings.json": PROD });
  fs.writeFileSync(file + ".lock", `${process.pid} a-save-of-ours-that-is-over`);
  const t0 = Date.now();
  await settings.setAutoFarm({ hostMinFreeMb: 6 });
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(disk().autoFarm.hostMinFreeMb, 6);
  assert.equal(fs.existsSync(file + ".lock"), false);
  // ...but a lock another save of this process holds right now is waited for.
  const other = instance(file);
  const realOpen = fsp.open;
  let slowed = false;
  fsp.open = async function (p, flags, ...rest) {
    const fh = await realOpen.call(this, p, flags, ...rest);
    if (!slowed && /settings\.json\.tmp-/.test(String(p))) {
      slowed = true;
      const realSync = fh.sync.bind(fh);
      fh.sync = async () => {
        await new Promise((r) => setTimeout(r, 300));
        return realSync();
      };
    }
    return fh;
  };
  try {
    const first = other.setAutoFarm({ noclaimMaxBots: 11 }); // holds the lock ~300 ms
    await waitFor(() => fs.existsSync(file + ".lock"));
    await settings.setAutoFarm({ hostMinFreeMb: 7 }); // must wait, not break it
    await first;
  } finally {
    fsp.open = realOpen;
  }
  assert.equal(disk().autoFarm.noclaimMaxBots, 11);
  assert.equal(disk().autoFarm.hostMinFreeMb, 7);
});

test("a lock that names no owner is judged by age alone: held under 120 s, broken beyond (either way)", async () => {
  // This code never makes one (the owner is in the lock before it exists); a
  // power cut or another writer could.
  for (const mtime of [ago(121 * 1000), ago(-300 * 1000)]) {
    const { settings, file, disk } = fresh({ "settings.json": PROD });
    fs.writeFileSync(file + ".lock", "");
    fs.utimesSync(file + ".lock", mtime, mtime);
    const t0 = Date.now();
    await settings.setAutoFarm({ hostMinFreeMb: 4 });
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(disk().autoFarm.hostMinFreeMb, 4);
  }
  const { settings, file } = fresh({ "settings.json": PROD });
  fs.writeFileSync(file + ".lock", "");
  fs.utimesSync(file + ".lock", ago(3000), ago(3000));
  await assert.rejects(settings.setAutoFarm({ hostMinFreeMb: 5 }), { code: "SETTINGS_LOCKED" });
  assert.equal(fs.readFileSync(file + ".lock", "utf8"), "");
});

test("a stale lock that cannot be removed fails the save at once instead of spinning", { skip: isRoot }, async () => {
  // The lock cannot be moved aside (EACCES on its rename): every save says so at once.
  {
    const { settings, file, disk } = fresh({ "settings.json": PROD });
    fs.writeFileSync(file + ".lock", `${deadPid()} crashed-mid-save`);
    const realRename = fsp.rename;
    fsp.rename = async function (from) {
      if (from === file + ".lock") {
        const e = new Error("EACCES: injected");
        e.code = "EACCES";
        throw e;
      }
      return realRename.apply(this, arguments);
    };
    try {
      for (const save of [() => settings.setAutoFarm({ hostMinFreeMb: 1 }), () => settings.setRequire2fa(false)]) {
        const t0 = Date.now();
        const r = await settle(save(), 6000);
        assert.ok(!r.pending, "the save is still spinning after 6 s");
        assert.equal(r.error && r.error.code, "SETTINGS_LOCKED");
        assert.match(r.error.message, /cannot be removed/);
        assert.ok(Date.now() - t0 < 1000);
      }
    } finally {
      fsp.rename = realRename;
    }
    await settings.setAutoFarm({ hostMinFreeMb: 2 });
    assert.equal(disk().autoFarm.hostMinFreeMb, 2);
  }
  // A read-only directory (an errors=remount-ro moment): every save fails at once too.
  {
    const { settings, file, dir, disk } = fresh({ "settings.json": PROD });
    fs.writeFileSync(file + ".lock", `${deadPid()} crashed-mid-save`);
    fs.chmodSync(dir, 0o555);
    try {
      for (const save of [() => settings.setAutoFarm({ hostMinFreeMb: 1 }), () => settings.setRequire2fa(false)]) {
        const t0 = Date.now();
        const r = await settle(save(), 6000);
        assert.ok(!r.pending, "the save is still spinning after 6 s");
        assert.ok(r.error, "a save into a read-only directory cannot succeed");
        assert.ok(Date.now() - t0 < 1000);
      }
    } finally {
      fs.chmodSync(dir, 0o755);
    }
    await settings.setAutoFarm({ hostMinFreeMb: 2 });
    assert.equal(disk().autoFarm.hostMinFreeMb, 2);
  }
});

test("a lock this process cannot remove is reported, and its own next save breaks it", { skip: isRoot }, async () => {
  const { settings, file, dir, disk } = fresh({ "settings.json": PROD });
  const lock = file + ".lock";
  const realLink = fsp.link;
  let armed = true;
  fsp.link = async function (from, to) {
    const r = await realLink.apply(this, arguments);
    if (armed && to === lock) {
      armed = false;
      fs.chmodSync(dir, 0o555); // the directory turns read-only while we hold the lock
    }
    return r;
  };
  try {
    await assert.rejects(settings.setAutoFarm({ hostMinFreeMb: 1 }), { code: "EACCES" });
  } finally {
    fsp.link = realLink;
    fs.chmodSync(dir, 0o755);
  }
  assert.ok(fs.existsSync(lock)); // our lock could not be removed...
  assert.ok(
    events.some((e) => e.action === "settings_lock" && /could not remove its own settings\.json\.lock/.test(e.detail)),
  ); // ...and that was said out loud
  const t0 = Date.now();
  await settings.setAutoFarm({ hostMinFreeMb: 2 }); // no 3 s wait on our own leftover
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(disk().autoFarm.hostMinFreeMb, 2);
  assert.equal(fs.existsSync(lock), false);
});

test("on a filesystem without hard links the lock is created in place instead", async () => {
  const { settings, file, disk, ls } = fresh({ "settings.json": PROD });
  const realLink = fsp.link;
  let refused = 0;
  fsp.link = async function (from, to) {
    if (to === file + ".lock") {
      refused++;
      const e = new Error("EPERM: injected, no hard links here");
      e.code = "EPERM";
      throw e;
    }
    return realLink.apply(this, arguments);
  };
  try {
    await Promise.all([settings.setAutoFarm({ hostMinFreeMb: 8 }), setKeys(settings, "g2g", { accessToken: "enc:v1:nl" })]);
  } finally {
    fsp.link = realLink;
  }
  assert.ok(refused >= 2);
  assert.equal(disk().autoFarm.hostMinFreeMb, 8);
  assert.equal(disk().marketplaces.g2g.accessToken, "enc:v1:nl");
  assert.deepEqual(ls(), ["settings.json", "settings.json.lastgood"]);
});

test("a save whose lock was taken from it mid-save is dropped, never renamed over the newer file", async () => {
  const { settings, file, disk } = fresh({ "settings.json": PROD });
  const lock = file + ".lock";
  const realOpen = fsp.open;
  let taken = false;
  fsp.open = async function (p, flags, ...rest) {
    const fh = await realOpen.call(this, p, flags, ...rest);
    if (!taken && /settings\.json\.tmp-/.test(String(p))) {
      taken = true;
      // Another process judged our lock stale, broke it, saved, and holds a new one.
      fs.writeFileSync(file, JSON.stringify({ ...PROD, marker: "newer" }, null, 2));
      fs.unlinkSync(lock);
      fs.writeFileSync(lock, "4242 someone-else");
    }
    return fh;
  };
  try {
    await assert.rejects(settings.setAutoFarm({ hostMinFreeMb: 1 }), { code: "SETTINGS_LOCK_LOST" });
  } finally {
    fsp.open = realOpen;
  }
  assert.equal(disk().marker, "newer"); // the newer save stands
  assert.equal(disk().autoFarm.hostMinFreeMb, undefined);
  assert.equal(fs.readFileSync(lock, "utf8"), "4242 someone-else"); // their lock is left alone
  assert.ok(events.some((e) => e.action === "settings_lock" && /dropped/.test(e.detail)));
  fs.unlinkSync(lock); // they finish
  await settings.setAutoFarm({ hostMinFreeMb: 2 });
  assert.equal(disk().marker, "newer");
  assert.equal(disk().autoFarm.hostMinFreeMb, 2);
});

test("two processes breaking one crashed lock never both get in: the loser waits, nothing is lost", async () => {
  const { file, dir, disk } = fresh({ "settings.json": PROD });
  const lock = file + ".lock";
  fs.writeFileSync(lock, `${deadPid()} crashed-mid-save`);
  fs.utimesSync(lock, ago(60 * 1000), ago(60 * 1000));
  // B parks its first removal of the lock (its break) until told to go; C's
  // settings.json fsync takes 600 ms, so C still holds the lock when B moves.
  const child = `
    const Module = require("module");
    const fs = require("fs"), fsp = require("fs/promises"), path = require("path");
    const SP = process.env.SETTINGS_MODULE, file = process.env.SETTINGS_FILE;
    const dir = path.dirname(file), lock = file + ".lock";
    const realLoad = Module._load;
    Module._load = function (request, parent) {
      if (request === "./systemLog" && parent && parent.filename === SP) return { logEvent: async () => {} };
      return realLoad.apply(this, arguments);
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    if (process.env.ROLE === "B") {
      let first = true;
      const park = (real) => async function (p, ...rest) {
        if (first && p === lock) {
          first = false;
          fs.writeFileSync(path.join(dir, "B-parked"), "1");
          while (!fs.existsSync(path.join(dir, "go"))) await sleep(5);
        }
        return real.call(this, p, ...rest);
      };
      fsp.rename = park(fsp.rename);
      fsp.unlink = park(fsp.unlink);
    } else {
      const realOpen = fsp.open;
      fsp.open = async function (p, flags, ...rest) {
        const fh = await realOpen.call(this, p, flags, ...rest);
        if (String(p).startsWith(file + ".tmp-")) {
          const realSync = fh.sync.bind(fh);
          fh.sync = async () => { await sleep(600); return realSync(); };
        }
        return fh;
      };
    }
    const settings = require(SP);
    (async () => {
      if (process.env.ROLE === "B") {
        const s = settings.loadSettings();
        s.marketplaces.g2g.refreshToken = "enc:v1:ROTATED";
        await settings.saveSettings(s);
      } else await settings.setAutoFarm({ maxAutoBots: 1 });
    })().then(() => process.exit(0), (e) => { console.error(e && (e.code || e.message)); process.exit(1); });`;
  const run = (role) => {
    const p = spawn(process.execPath, ["-e", child], {
      env: { ...process.env, SETTINGS_FILE: file, SETTINGS_MODULE: SETTINGS_PATH, ROLE: role },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    p.stderr.on("data", (c) => (stderr += c));
    return { pid: p.pid, done: new Promise((resolve) => p.on("exit", (code) => resolve({ code, stderr }))) };
  };
  const b = run("B");
  await waitFor(() => fs.existsSync(path.join(dir, "B-parked")));
  const c = run("C");
  await waitFor(() => {
    try {
      return fs.readFileSync(lock, "utf8").startsWith(c.pid + " ");
    } catch {
      return false;
    }
  }); // C broke the crashed lock and holds its own
  fs.writeFileSync(path.join(dir, "go"), "1"); // B now breaks "the stale lock" — C's
  const [rb, rc] = await Promise.all([b.done, c.done]);
  assert.equal(rc.code, 0, rc.stderr);
  assert.equal(rb.code, 0, rb.stderr);
  const d = disk();
  assert.equal(d.autoFarm.maxAutoBots, 1);
  assert.equal(d.marketplaces.g2g.refreshToken, "enc:v1:ROTATED");
  assert.equal(fs.existsSync(lock), false);
});

// A child process for the cross-process cases below: settings.js with systemLog
// stubbed, running `body` (which sees settings, fs, fsp, path, crypto, file,
// dir, lock, sleep, waitFlag, mark).
function childScript(body) {
  return `
    const Module = require("module");
    const crypto = require("crypto"), fs = require("fs"), fsp = require("fs/promises"), path = require("path");
    const SP = process.env.SETTINGS_MODULE, file = process.env.SETTINGS_FILE;
    const dir = path.dirname(file), lock = file + ".lock";
    const realLoad = Module._load;
    Module._load = function (request, parent) {
      if (request === "./systemLog" && parent && parent.filename === SP) return { logEvent: async () => {} };
      return realLoad.apply(this, arguments);
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const mark = (n) => fs.writeFileSync(path.join(dir, n), "1");
    const waitFlag = async (n) => { while (!fs.existsSync(path.join(dir, n))) await sleep(2); };
    ${body}
    main().then(() => process.exit(0), (e) => { console.error(e && (e.code || e.message)); process.exit(1); });`;
}
function runChild(file, body, env = {}) {
  const p = spawn(process.execPath, ["-e", childScript(body)], {
    env: { ...process.env, SETTINGS_FILE: file, SETTINGS_MODULE: SETTINGS_PATH, UV_THREADPOOL_SIZE: "4", ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  p.stderr.on("data", (c) => (stderr += c));
  return { pid: p.pid, done: new Promise((resolve) => p.on("exit", (code) => resolve({ code, stderr }))) };
}

test("a server whose libuv pool is busy while it takes the lock never loses it (the lock is born with its owner)", async () => {
  const { file, dir, disk } = fresh({ "settings.json": PROD });
  // pbkdf2 iterations that keep a libuv thread busy ~3 s on this machine.
  const t0 = Date.now();
  crypto.pbkdf2Sync("x", "y", 200000, 32, "sha512");
  const iterations = Math.round((200000 * 3000) / Math.max(1, Date.now() - t0));
  const server = runChild(
    file,
    `async function main() {
      const saving = settings.setAutoFarm({ maxAutoBots: 1 });
      // Right after its lock is under way every libuv thread turns busy for
      // ~3 s (DNS timeouts, hashing, a slow disk); the event loop stays free.
      setImmediate(() => {
        for (let i = 0; i < 4; i++) crypto.pbkdf2("x", "y", ${iterations}, 32, "sha512", () => {});
        mark("pool-busy");
      });
      await saving;
    }
    const settings = require(SP);`,
  );
  const script = runChild(
    file,
    `async function main() {
      await waitFlag("pool-busy");
      await sleep(300);
      const s = settings.loadSettings();
      s.marketplaces.g2g.refreshToken = "enc:v1:SCRIPT-ROTATED";
      await settings.saveSettings(s);
    }
    const settings = require(SP);`,
  );
  const [rs, rp] = await Promise.all([server.done, script.done]);
  assert.equal(rs.code, 0, "server: " + rs.stderr);
  assert.equal(rp.code, 0, "script: " + rp.stderr);
  const d = disk();
  assert.equal(d.autoFarm.maxAutoBots, 1);
  assert.equal(d.marketplaces.g2g.refreshToken, "enc:v1:SCRIPT-ROTATED");
  assert.equal(fs.existsSync(file + ".lock"), false);
  assert.equal(fs.existsSync(path.join(dir, "pool-busy")), true);
});

test("a lock put back after its owner finished does not block that owner: its next save breaks it at once", async () => {
  const { file, dir, disk } = fresh({ "settings.json": PROD });
  const lock = file + ".lock";
  const has = (n) => fs.existsSync(path.join(dir, n));
  const flag = (n) => fs.writeFileSync(path.join(dir, n), "1");
  fs.writeFileSync(lock, `${deadPid()} crashed-mid-save`); // a crash leftover two processes judge stale
  // An ops script: parks before moving the stale lock aside, and again after.
  const breaker = runChild(
    file,
    `const realRename = fsp.rename;
    let first = true;
    fsp.rename = async function (src, dst) {
      if (first && src === lock) {
        first = false;
        mark("breaker-before-rename");
        await waitFlag("go-rename");
        const r = await realRename.call(this, src, dst);
        mark("breaker-moved");
        await waitFlag("go-verify");
        return r;
      }
      return realRename.call(this, src, dst);
    };
    const settings = require(SP);
    async function main() {
      const s = settings.loadSettings();
      s.marketplaces.g2g.refreshToken = "enc:v1:BREAKER";
      await settings.saveSettings(s).catch(() => {}); // its own outcome is not the point
    }`,
  );
  await waitFor(() => has("breaker-before-rename"));
  // The long-lived server: breaks the leftover first and holds its own lock
  // through a slow fsync; the ops script then moves THAT lock aside.
  const server = runChild(
    file,
    `const realOpen = fsp.open;
    let first = true;
    fsp.open = async function (p, flags, ...rest) {
      const fh = await realOpen.call(this, p, flags, ...rest);
      if (first && String(p).startsWith(file + ".tmp-")) {
        first = false;
        const realSync = fh.sync.bind(fh);
        fh.sync = async () => { mark("server-in-fsync"); await waitFlag("go-server"); return realSync(); };
      }
      return fh;
    };
    const settings = require(SP);
    async function main() {
      await settings.setAutoFarm({ maxAutoBots: 7 }).catch(() => {}); // loses its lock mid-save: dropped
      mark("server-save1-done");
      await waitFlag("server-next");
      const t = Date.now();
      try {
        await settings.setAutoFarm({ maxAutoBots: 9 });
        fs.writeFileSync(path.join(dir, "server-result"), "ok " + (Date.now() - t));
      } catch (e) {
        fs.writeFileSync(path.join(dir, "server-result"), "fail " + e.code + " " + (Date.now() - t));
      }
    }`,
  );
  await waitFor(() => has("server-in-fsync"));
  flag("go-rename");
  await waitFor(() => has("breaker-moved"));
  flag("go-server");
  await waitFor(() => has("server-save1-done"));
  flag("go-verify"); // the ops script puts the server's (finished) lock back
  await waitFor(() => {
    try {
      return fs.readFileSync(lock, "utf8").startsWith(server.pid + " ");
    } catch {
      return false;
    }
  });
  flag("server-next");
  const [rs] = await Promise.all([server.done, breaker.done]);
  assert.equal(rs.code, 0, rs.stderr);
  const result = fs.readFileSync(path.join(dir, "server-result"), "utf8");
  assert.match(result, /^ok \d+$/, result);
  assert.ok(Number(result.split(" ")[1]) < 1000, result);
  assert.equal(disk().autoFarm.maxAutoBots, 9);
});

test("unreadable bytes count as kept only once their copy is written: a failed copy blocks the overwrite", async () => {
  // A hand edit with a typo: a new cookie pasted, a comma lost.
  const handEdit = JSON.stringify(PROD, null, 2).replace('"enc:v1:eld-cookie"', '"HAND-PASTED-COOKIE" "x"');
  const fullDisk = (alsoTheSave) => {
    const realWrite = fs.writeFileSync;
    const realOpen = fsp.open;
    fs.writeFileSync = function (p, data, opts) {
      if (String(p).includes(".corrupt-")) {
        realWrite.call(fs, p, "", opts); // created, nothing written
        const e = new Error("ENOSPC: injected disk full");
        e.code = "ENOSPC";
        throw e;
      }
      return realWrite.apply(fs, arguments);
    };
    if (alsoTheSave)
      fsp.open = async function (p, flags, ...rest) {
        const fh = await realOpen.call(this, p, flags, ...rest);
        if (/settings\.json\.tmp-/.test(String(p)))
          fh.writeFile = async () => {
            const e = new Error("ENOSPC: injected disk full");
            e.code = "ENOSPC";
            throw e;
          };
        return fh;
      };
    return () => {
      fs.writeFileSync = realWrite;
      fsp.open = realOpen;
    };
  };
  for (const alsoTheSave of [true, false]) {
    const { settings, file, dir, disk, ls } = fresh({
      "settings.json": handEdit,
      "settings.json.lastgood": PROD,
    });
    const restore = fullDisk(alsoTheSave);
    try {
      await assert.rejects(settings.setRequire2fa(false));
    } finally {
      restore();
    }
    assert.equal(fs.readFileSync(file, "utf8"), handEdit); // not overwritten without its copy
    assert.deepEqual(keptCopies(ls), []); // and no empty "copy" left behind
    await settings.setRequire2fa(false); // space freed
    const kept = keptCopies(ls);
    assert.equal(kept.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, kept[0]), "utf8"), handEdit);
    assert.equal(disk().require2fa, false);
  }
});

test("the first load sweeps only this store's own temp files older than 10 minutes", () => {
  const OLD = [
    "settings.json.tmp-111-1-aaaaaaaa",
    "settings.json.lastgood.tmp-111-2-bbbbbbbb",
  ];
  const KEPT_OLD = [
    "settings.json.tmp-12345", // the old code's leftovers: moved by hand
    "settings.json.bak", // the operator's
    "settings.json.bak-20260920",
    "settings.json.bak.tmp-111-3-cccccccc",
  ];
  const YOUNG = ["settings.json.tmp-222-4-dddddddd"]; // possibly mid-write elsewhere
  const files = { "settings.json": PROD };
  for (const n of [...OLD, ...KEPT_OLD, ...YOUNG]) files[n] = "x";
  const { settings, dir, ls } = fresh(files);
  for (const n of [...OLD, ...KEPT_OLD])
    fs.utimesSync(path.join(dir, n), ago(11 * 60 * 1000), ago(11 * 60 * 1000));
  settings.loadSettings();
  assert.deepEqual(ls(), ["settings.json", ...KEPT_OLD, ...YOUNG].sort());
});

test(".gitignore covers every file the settings store writes next to settings.json", () => {
  const lines = fs
    .readFileSync(path.join(__dirname, "..", ".gitignore"), "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("!") && !l.endsWith("/"));
  // gitignore globs, as far as these names need: "*" never crosses a "/", and
  // a pattern without a "/" matches the last path segment anywhere.
  const re = (pat) => {
    const body = pat.replace(/^\//, "").replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
    return new RegExp(pat.includes("/") ? `^${body}$` : `(^|/)${body}$`);
  };
  const ignored = (p) => lines.some((l) => re(l).test(p));
  for (const p of [
    "utils/settings.json",
    "utils/settings.json.tmp-1234-5-0123abcd",
    "utils/settings.json.lastgood",
    "utils/settings.json.lastgood.tmp-1234-5-0123abcd",
    "utils/settings.json.lastgood-corrupt-2026-10-03T00-00-00-000Z",
    "utils/settings.json.corrupt-2026-10-03T00-00-00-000Z",
    "utils/settings.json.lock",
  ])
    assert.ok(ignored(p), p + " is not ignored");
  assert.ok(!ignored("utils/settings.js"));
});

test("marketplaces' Plati switch reads the merged default; GGSel's keeps its own", () => {
  for (const [body, plati, ggsel] of [
    [{ autoFarm: { enabled: true } }, false, true], // a block written before the keys
    [{ autoFarm: { platiEnabled: true, ggselEnabled: false } }, true, false],
    [null, false, true], // no file at all
  ]) {
    fresh(body ? { "settings.json": body } : {});
    delete require.cache[MARKETPLACES_PATH];
    const mp = require(MARKETPLACES_PATH); // on the settings instance fresh() just loaded
    assert.equal(mp.digisellerTakesNewStock(), plati, JSON.stringify(body));
    assert.equal(mp.ggselTakesNewStock(), ggsel, JSON.stringify(body));
  }
  delete require.cache[MARKETPLACES_PATH];
});

test("a save writes the object as it was at the call; saving it again applies only newer edits", async () => {
  const { settings, disk } = fresh({ "settings.json": PROD });
  const s = settings.loadSettings();
  s.marketplaces.gameflip.apiKey = "enc:v1:A";
  const pending = settings.saveSettings(s);
  s.marketplaces.gameflip.apiKey = "enc:v1:edited-after-the-call";
  await pending;
  assert.equal(disk().marketplaces.gameflip.apiKey, "enc:v1:A");

  s.marketplaces.gameflip.apiKey = "enc:v1:A"; // back to what it saved
  await setKeys(settings, "gameflip", { apiKey: "enc:v1:C" }); // someone else, later
  s.require2fa = false; // the caller's newer edit
  await settings.saveSettings(s);
  const d = disk();
  assert.equal(d.marketplaces.gameflip.apiKey, "enc:v1:C"); // not re-asserted
  assert.equal(d.require2fa, false);
});

test("an object loadSettings did not hand out is written whole, as before; a non-object is refused", async () => {
  const { settings, file, disk } = fresh({ "settings.json": PROD });
  for (const bad of [null, undefined, [1, 2], "text"]) {
    await assert.rejects(settings.saveSettings(bad), TypeError);
  }
  assert.deepEqual(disk(), PROD);
  const own = { require2fa: false, custom: 1 };
  await settings.saveSettings(own);
  const d = disk();
  assert.equal(d.custom, 1);
  assert.equal(d.marketplaces, undefined); // whole write: the contract's "today's behaviour"
  assert.equal(d.autoFarm.platiEnabled, false); // DEFAULTS filled in
  assert.ok(fs.existsSync(file));
  // Saved again it is no longer unknown: only its own edit lands, and the
  // autoFarm block it never carried is not reset over another writer's change.
  await settings.setAutoFarm({ hostMinFreeMb: 900 });
  own.custom = 2;
  await settings.saveSettings(own);
  assert.equal(disk().custom, 2);
  assert.equal(disk().autoFarm.hostMinFreeMb, 900);
});

test("DEFAULTS cannot be edited through an object loadSettings returned", () => {
  const { settings } = fresh();
  const s = settings.loadSettings();
  s.autoFarm.noClaimGames.push("fortnite");
  s.autoFarm.platiEnabled = true;
  s.noclaimShop.enabled = false;
  const again = settings.loadSettings();
  assert.deepEqual(again.autoFarm.noClaimGames, ["overwatch", "rainbow six", "call of duty"]);
  assert.equal(again.autoFarm.platiEnabled, false);
  assert.equal(settings.getNoclaimShopSettings().enabled, true);
  assert.equal(settings.isNoClaimGame("Fortnite"), false);
});

test("the shared keys of contract §1 and the Plati default", () => {
  const af = fresh().settings.getAutoFarm();
  assert.equal(af.pristineReserve, 150);
  assert.equal(af.hostMinFreeMb, 1500);
  assert.equal(af.noclaimMaxBots, 40);
  assert.equal(af.noclaimBurstGuard, false);
  assert.equal(af.platiEnabled, false);
  // A value in the file still wins over every default.
  const set = fresh({
    "settings.json": { autoFarm: { platiEnabled: true, pristineReserve: 0, hostMinFreeMb: 0 } },
  }).settings.getAutoFarm();
  assert.equal(set.platiEnabled, true);
  assert.equal(set.pristineReserve, 0);
  assert.equal(set.hostMinFreeMb, 0);
  assert.equal(set.noclaimMaxBots, 40);
});

test("a hand-edited file saved with a BOM is not mistaken for a torn one", () => {
  const { settings } = fresh({ "settings.json": "﻿" + JSON.stringify(PROD) });
  assert.deepEqual(settings.loadSettings().marketplaces, PROD.marketplaces);
  assert.equal(errors.length, 0);
});

test("setRequire2fa and setEpicAutoClaim share the chain with credential writes", async () => {
  const { settings, disk } = fresh({ "settings.json": PROD });
  const [, epic] = await Promise.all([
    settings.setRequire2fa(false),
    settings.setEpicAutoClaim({ enabled: true, captchaKey: "plain-key", dailyCap: "7" }),
    setKeys(settings, "eldorado", { cookie: "enc:v1:eld-cookie-3" }),
    settings.setAutoFarm({ noclaimBurstGuard: true }),
  ]);
  const d = disk();
  assert.equal(d.require2fa, false);
  assert.equal(d.epicAutoClaim.enabled, true);
  assert.equal(d.epicAutoClaim.dailyCap, 7);
  assert.match(d.epicAutoClaim.captchaKey, /^enc:v1:/);
  assert.notEqual(d.epicAutoClaim.captchaKey, "plain-key");
  assert.deepEqual(epic, d.epicAutoClaim);
  assert.equal(d.marketplaces.eldorado.cookie, "enc:v1:eld-cookie-3");
  assert.equal(d.autoFarm.noclaimBurstGuard, true);
  assert.equal(d.autoFarm.maxAutoBots, 33);
});

test("setAutoFarm audits what changed against the file as it was, and returns the saved block", async () => {
  const { settings, disk } = fresh({ "settings.json": PROD });
  const saved = await settings.setAutoFarm({ maxAutoBots: 40, enabled: true }, { actor: "admin:1" });
  assert.deepEqual(saved, disk().autoFarm);
  const audit = events.filter((e) => e.action === "settings_changed");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor, "admin:1");
  assert.deepEqual(audit[0].meta, { maxAutoBots: { from: 33, to: 40 } }); // enabled was already true
});
