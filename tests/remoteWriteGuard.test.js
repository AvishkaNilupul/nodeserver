// Every remote bot-config write is size-checked (2026-10-01).
//
// botHosts.writeFileRaw learned to install its temp file only when it holds
// every byte sent (tests/botHostsWriteCheck.test.js). The no-claim fleet, the
// token replacer and the no-claim auto-lister wrote configs with their own
// `cat > tmp && mv` — two of them `cat` straight onto the live config — so a
// cut-off ssh transfer (`cat` exits 0 on any EOF) installed a torn config the
// bot could not parse. They now all build the same guarded command,
// botHosts.guardedWriteScript.
//
// The "remote" here is a local /bin/sh running the exact command, fed the
// stdin ssh would have carried — whole, or cut short.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");

const hosts = require("../utils/botHosts");

// Run `script` under /bin/sh with `input` (optionally cut to `cutAt` bytes).
function runSh(script, input, { cutAt = null } = {}) {
  return new Promise((resolve) => {
    const child = cp.execFile("/bin/sh", ["-c", script], (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr }),
    );
    let data = Buffer.from(input, "utf8");
    if (cutAt !== null) data = data.subarray(0, cutAt);
    child.stdin.end(data);
  });
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "remote-write-guard-"));
const tempsIn = (dir) => fs.readdirSync(dir).filter((f) => /\.tmp-/.test(f));
const modeOf = (f) => fs.statSync(f).mode & 0o777;
const TEXT = JSON.stringify({ TwitchSettings: { TwitchUsers: [{ Login: "ünïcode-🎮", ClientSecret: "s1" }] } }, null, 2);

/* ------------------------------ the helper ------------------------------ */

test("guardedWriteScript: a whole transfer is installed, already chmod 600, with its directories made", async () => {
  const dir = tmpDir();
  const dest = path.join(dir, "bots/7/Configuration/config.json");
  const script = hosts.guardedWriteScript(dest, hosts.byteLength(TEXT), {
    mode: "600",
    mkdirs: [path.join(dir, "bots/7/Configuration"), path.join(dir, "bots/7/logs")],
  });
  const r = await runSh(script, TEXT);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(dest, "utf8"), TEXT);
  assert.equal(modeOf(dest), 0o600);
  assert.ok(fs.existsSync(path.join(dir, "bots/7/logs")));
  assert.deepEqual(tempsIn(path.dirname(dest)), []);
});

test("REGRESSION: guardedWriteScript: a transfer cut part-way is NOT installed — the old config stays, the command fails", async () => {
  const dir = tmpDir();
  const dest = path.join(dir, "config.json");
  fs.writeFileSync(dest, "{\"old\":true}");
  const script = hosts.guardedWriteScript(dest, hosts.byteLength(TEXT), { mode: "600" });
  const r = await runSh(script, TEXT, { cutAt: 20 });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /short or failed write: \d+ bytes expected/);
  assert.equal(fs.readFileSync(dest, "utf8"), "{\"old\":true}", "the bot's config is untouched");
  assert.deepEqual(tempsIn(dir), [], "the short temp file is removed");
});

test("guardedWriteScript: every write gets its own temp name; a quoted path is safe; bad arguments throw", async () => {
  const a = hosts.guardedWriteScript("/x/config.json", 5);
  const b = hosts.guardedWriteScript("/x/config.json", 5);
  const tmpName = (s) => /cat > '([^']+)'/.exec(s)[1];
  assert.notEqual(tmpName(a), tmpName(b));
  const dir = path.join(tmpDir(), "it's here");
  fs.mkdirSync(dir);
  const dest = path.join(dir, "config.json");
  const r = await runSh(hosts.guardedWriteScript(dest, hosts.byteLength(TEXT)), TEXT);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(dest, "utf8"), TEXT);
  assert.throws(() => hosts.guardedWriteScript("/x", -1));
  assert.throws(() => hosts.guardedWriteScript("/x", 1.5));
  assert.throws(() => hosts.guardedWriteScript("/x", 3, { mode: "6;rm -rf /" }));
});

/* ----------------------- the no-claim fleet, end to end ----------------------- */

// noclaimFleet against a fake bot host: file commands run for real (under a temp
// dir standing in for /home/ubuntu/twitchbot-noclaim), docker/git are skipped.
const BASE = "/home/ubuntu/twitchbot-noclaim";
const fleetWorld = { root: null, cutAt: null, scripts: [] };
const fakeHosts = {
  ...hosts,
  resolveHost: () => ({ id: "contabo", label: "contabo", transport: "ssh", dir: "/x", ssh: { target: "u@h", options: [] } }),
  runShell: async (host, script, { input } = {}) => {
    fleetWorld.scripts.push(script);
    if (/docker|git /.test(script)) return { stdout: "", stderr: "" };
    const local = script.split(BASE).join(fleetWorld.root);
    const r = await runSh(local, input === undefined ? "" : String(input), { cutAt: fleetWorld.cutAt });
    if (r.code) {
      const e = new Error(String(r.stderr || "exit " + r.code).trim());
      e.code = r.code;
      throw e;
    }
    return { stdout: r.stdout, stderr: r.stderr };
  },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && /utils[\\/]noclaimFleet\.js$/.test(parent.filename || "")) {
    if (request === "./botHosts") return fakeHosts;
    if (request === "./settings") return { isNoClaimGame: () => true, getAutoFarm: () => ({}) };
  }
  return realLoad.call(this, request, parent, isMain);
};
const fleet = require("../utils/noclaimFleet");
test.after(() => {
  Module._load = realLoad;
});

function freshFleet() {
  fleetWorld.root = tmpDir();
  fleetWorld.cutAt = null;
  fleetWorld.scripts = [];
}
const cfgPath = (id) => path.join(fleetWorld.root, "bots", String(id), "Configuration", "config.json");
const acct = (n) => ({ username: "acct" + n, clientSecret: "secret" + n, twitchId: "" + n });

test("no-claim create: the config is written guarded, 600 from the start; a cut transfer leaves NO config", async () => {
  freshFleet();
  await fleet.createBotFromAccounts("7", [acct(1), acct(2)], "Overwatch");
  const cfg = JSON.parse(fs.readFileSync(cfgPath(7), "utf8"));
  assert.equal(cfg.TwitchSettings.TwitchUsers.length, 2);
  assert.equal(modeOf(cfgPath(7)), 0o600);
  assert.match(fleetWorld.scripts[0], /-eq \d+ \]/, "size-checked");

  freshFleet();
  fleetWorld.cutAt = 30;
  await assert.rejects(fleet.createBotFromAccounts("8", [acct(1)], "Overwatch"), /short or failed write/);
  assert.equal(fs.existsSync(cfgPath(8)), false, "no half config for the bot to start on");
  assert.ok(!fleetWorld.scripts.some((s) => /docker run/.test(s)), "nothing was started");
});

test("REGRESSION: no-claim top-up: a cut transfer keeps the old config whole and the call fails", async () => {
  freshFleet();
  await fleet.createBotFromAccounts("9", [acct(1)], "Overwatch");
  const before = fs.readFileSync(cfgPath(9), "utf8");
  fleetWorld.cutAt = 40;
  await assert.rejects(fleet.topUpBot("9", [acct(2), acct(3)], "Overwatch", { restart: false }), /short or failed write/);
  assert.equal(fs.readFileSync(cfgPath(9), "utf8"), before, "untouched");
  assert.deepEqual(tempsIn(path.dirname(cfgPath(9))), []);
  fleetWorld.cutAt = null;
  const r = await fleet.topUpBot("9", [acct(2), acct(3)], "Overwatch", { restart: false });
  assert.equal(r.added, 2);
  assert.equal(JSON.parse(fs.readFileSync(cfgPath(9), "utf8")).TwitchSettings.TwitchUsers.length, 3);
  assert.equal(modeOf(cfgPath(9)), 0o600);
});

/* --------------------------- no unguarded writes --------------------------- */

test("no remote config write outside botHosts is an unguarded `cat >`", () => {
  const root = path.join(__dirname, "..");
  const offenders = [];
  for (const dir of ["utils", "routes"]) {
    const walk = (d) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (ent.name.endsWith(".js")) {
          const rel = path.relative(root, p);
          if (rel === path.join("utils", "botHosts.js")) continue;
          fs.readFileSync(p, "utf8").split("\n").forEach((line, i) => {
            if (/^\s*\/\//.test(line)) return; // comments
            // A template-literal redirect into a quoted (shq) path: `cat > ${...}`
            if (/cat\s*>\s*\$\{/.test(line)) offenders.push(rel + ":" + (i + 1));
          });
        }
      }
    };
    walk(path.join(root, dir));
  }
  assert.deepEqual(offenders, [], "use botHosts.guardedWriteScript (or writeFileAtomic) instead");
});
