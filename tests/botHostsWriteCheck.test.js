// A remote config write installs the new file ONLY when every byte arrived
// (2026-10-01).
//
// writeFileRaw ran `cat > tmp && mv -f tmp dest` on the host. `cat` exits 0 on
// any EOF, and a transfer cut off part-way is an EOF too (a timed-out ssh client
// behind the shared ControlMaster closes the channel cleanly), so half a bot
// config was moved into place as if it were whole and the bot lost every
// account past the cut. Now the temp file's size must equal the bytes sent.
//
// The "remote" here is a local /bin/sh running the exact command string
// writeFileRaw builds, fed the stdin ssh would have carried — whole, or cut.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const { Writable } = require("node:stream");

const world = { cutAt: null, commands: [] };

function fakeExecFile(file, args, opts, cb) {
  if (file !== "ssh") return cp.execFile(file, args, opts, cb);
  const command = args[args.length - 1];
  world.commands.push(command);
  const real = cp.execFile("/bin/sh", ["-c", command], opts, cb);
  const chunks = [];
  const stdin = new Writable({
    write(c, _enc, done) {
      chunks.push(Buffer.from(c));
      done();
    },
    final(done) {
      let data = Buffer.concat(chunks);
      if (world.cutAt !== null) data = data.subarray(0, world.cutAt);
      real.stdin.end(data);
      done();
    },
  });
  return { stdin };
}

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && /utils[\\/]botHosts\.js$/.test(parent.filename || "")) {
    if (request === "child_process") return { ...cp, execFile: fakeExecFile };
    if (request === "./dupeGuard") return { enforceSingleHome: async () => {} };
  }
  return realLoad.call(this, request, parent, isMain);
};
const hosts = require("../utils/botHosts");
test.after(() => {
  Module._load = realLoad;
});

function remoteHost() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bothosts-write-"));
  return {
    host: { id: "t", label: "t", transport: "ssh", dir, ssh: { target: "nobody@127.0.0.1", options: [] } },
    dir,
  };
}

// Multi-byte characters on purpose: the check counts BYTES, not characters.
const NEW_TEXT = JSON.stringify({ TwitchSettings: { TwitchUsers: { a: { Login: "ünïcode-émoji-🎮" }, b: { Login: "plain" } } } }, null, 2);
const OLD_TEXT = JSON.stringify({ TwitchSettings: { TwitchUsers: { a: { Login: "old" } } } }, null, 2);

test("a whole transfer is installed, the previous version kept as .bak, no temp file left", async () => {
  world.cutAt = null;
  const { host, dir } = remoteHost();
  fs.writeFileSync(path.join(dir, "config_07.json"), OLD_TEXT);

  await hosts.writeFileAtomic(host, "config_07.json", NEW_TEXT);

  assert.equal(fs.readFileSync(path.join(dir, "config_07.json"), "utf8"), NEW_TEXT);
  assert.equal(fs.readFileSync(path.join(dir, "config_07.json.bak"), "utf8"), OLD_TEXT);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => /\.tmp-/.test(f)), []);
  assert.match(world.commands.at(-1), new RegExp("-eq " + Buffer.byteLength(NEW_TEXT, "utf8") + " \\]"));
});

test("REGRESSION: a transfer cut off part-way is NOT installed — the write fails and the old config stays", async () => {
  const { host, dir } = remoteHost();
  fs.writeFileSync(path.join(dir, "config_07.json"), OLD_TEXT);
  world.cutAt = Math.floor(Buffer.byteLength(NEW_TEXT, "utf8") / 2);
  try {
    await assert.rejects(
      hosts.writeFileAtomic(host, "config_07.json", NEW_TEXT),
      /short or failed write/,
    );
  } finally {
    world.cutAt = null;
  }
  assert.equal(fs.readFileSync(path.join(dir, "config_07.json"), "utf8"), OLD_TEXT, "the bot's config is untouched");
  assert.deepEqual(fs.readdirSync(dir).filter((f) => /\.tmp-/.test(f)), [], "the short temp file is removed");
});

test("a brand-new file is written whole, and a cut transfer leaves no file at all", async () => {
  const { host, dir } = remoteHost();
  await hosts.writeFileAtomic(host, "config_08.json", NEW_TEXT);
  assert.equal(fs.readFileSync(path.join(dir, "config_08.json"), "utf8"), NEW_TEXT);
  assert.equal(fs.existsSync(path.join(dir, "config_08.json.bak")), false);

  world.cutAt = 10;
  try {
    await assert.rejects(hosts.writeFileAtomic(host, "config_09.json", NEW_TEXT), /short or failed write/);
  } finally {
    world.cutAt = null;
  }
  assert.equal(fs.existsSync(path.join(dir, "config_09.json")), false);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => /\.tmp-/.test(f)), []);
});

test("a path with a quote in it is still quoted safely", async () => {
  world.cutAt = null;
  const { host, dir } = remoteHost();
  const sub = path.join(dir, "it's here");
  fs.mkdirSync(sub);
  await hosts.writeFileAtomic({ ...host, dir: sub }, "config_10.json", NEW_TEXT);
  assert.equal(fs.readFileSync(path.join(sub, "config_10.json"), "utf8"), NEW_TEXT);
});
