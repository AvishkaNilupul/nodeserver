// settings.json saves that cannot tear or wipe (docs/LIVE-FIXES-1003.md §A1,
// defect 12). Before 2026-10-03 every save in a process shared one temp file
// (settings.json.tmp-<pid>) and rewrote the WHOLE file from the caller's copy,
// and a file that did not parse read as DEFAULTS — which the next save wrote
// back, wiping every marketplace credential and turning Plati back on.
//
// Every case loads a FRESH utils/settings.js pointed at its own temp dir via
// SETTINGS_FILE, so the real utils/settings.json is never touched and no
// in-memory state (the last good copy, the save chain) leaks between cases.
// systemLog is stubbed (events captured, mongoose never loaded) and
// console.error is captured. No DB, no network.
//
// Run: CRED_SECRET=x node --test tests/settingsSafeWrite.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const Module = require("module");

// setEpicAutoClaim encrypts through utils/secretBox, which needs a key.
if (!process.env.CRED_SECRET) process.env.CRED_SECRET = "x";

const SETTINGS_PATH = require.resolve("../utils/settings");

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
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

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
  const prev = process.env.SETTINGS_FILE;
  process.env.SETTINGS_FILE = file;
  delete require.cache[SETTINGS_PATH];
  let settings;
  try {
    settings = require(SETTINGS_PATH);
  } finally {
    if (prev === undefined) delete process.env.SETTINGS_FILE;
    else process.env.SETTINGS_FILE = prev;
  }
  events.length = 0;
  errors.length = 0;
  return {
    settings,
    dir,
    file,
    bak: file + ".bak",
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

const keptCopies = (ls) => ls().filter((n) => n.startsWith("settings.json.bak-corrupt-"));

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

test("a torn file is served from settings.json.bak, and the next save heals it", async () => {
  const { settings, disk, bak, dir, ls } = fresh({
    "settings.json": TORN,
    "settings.json.bak": PROD,
  });
  const s = settings.loadSettings();
  assert.deepEqual(s.marketplaces, PROD.marketplaces);
  assert.equal(settings.getAutoFarm().enabled, true);
  assert.equal(settings.getAutoFarm().maxAutoBots, 33);
  assert.ok(events.some((e) => e.action === "settings_corrupt" && e.meta.served === "bak"));

  await settings.setAutoFarm({ noclaimMaxBots: 30 });
  const healed = disk();
  assert.deepEqual(healed.marketplaces, PROD.marketplaces);
  assert.equal(healed.autoFarm.noclaimMaxBots, 30);
  assert.equal(healed.autoFarm.enabled, true);
  assert.equal(healed.playerauctionsInstallSecret, PROD.playerauctionsInstallSecret);
  assert.deepEqual(JSON.parse(fs.readFileSync(bak, "utf8")), healed);
  // The torn bytes were kept, not destroyed (a hand edit with a typo looks
  // exactly like this).
  const kept = keptCopies(ls);
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, kept[0]), "utf8"), TORN);
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
      (e) => e.action === "settings_corrupt" && e.meta.served === "last-good" && e.severity === "warn",
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

test("a torn file with no good copy reads as DEFAULTS (Plati off) and every save is refused", async () => {
  for (const extra of [{}, { "settings.json.bak": "{" }]) {
    const { settings, file, ls } = fresh({ "settings.json": TORN, ...extra });
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
    assert.deepEqual(ls(), before); // no temp file, no .bak, no copy

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

test("a missing file is a fresh install: DEFAULTS, silently, and the first save creates it", async () => {
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
  assert.deepEqual(ls(), ["settings.json", "settings.json.bak"]);
});

test("a failed rename leaves no temp file, keeps the old file, and does not block the next save", async () => {
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
  await settings.setAutoFarm({ hostMinFreeMb: 2 });
  assert.equal(disk().autoFarm.hostMinFreeMb, 2);
  assert.deepEqual(ls(), ["settings.json", "settings.json.bak"]);
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
  const { settings, disk, bak, ls } = fresh({ "settings.json": PROD });
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
  assert.deepEqual(JSON.parse(fs.readFileSync(bak, "utf8")), d);
  assert.deepEqual(ls(), ["settings.json", "settings.json.bak"]);
  assert.equal(errors.length, 0); // no fallback was ever needed
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
