// The farm tag keeps vanishing from the main server: on 2026-09-27 docker
// logged `untag twitchbot-farm:latest` at 05:28:56 UTC, two seconds after the
// hosting provider's agent.service restarted. The stale-build scan already
// PROVES when the missing tag's image is the farm build (the id it pointed at
// before, or another host's farm tag), and its alert asked a human to run the
// one-line `docker tag`. These tests pin that it now runs that line itself in
// the proven case only, restarts nothing, and still alerts when it cannot.
//
// Telegram and the SystemEvent log are stubbed through require.cache; the host
// layer is stubbed by swapping runShell on the shared botHosts module object.
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const Module = require("node:module");

function stubModule(rel, exports) {
  const file = require.resolve(path.join(__dirname, "..", "utils", rel));
  const m = new Module(file);
  m.filename = file;
  m.loaded = true;
  m.exports = exports;
  require.cache[file] = m;
}

const sent = [];
const events = [];
stubModule("telegram", { sendTelegram: async (msg) => void sent.push(msg) });
stubModule("systemLog", { logEvent: (e) => void events.push(e) });

const hosts = require("../utils/botHosts");
const mon = require("../utils/botHealthMonitor");

const HOUR = 60 * 60 * 1000;
const realRunShell = hosts.runShell;
const ID = "sha256:fdd990dd54f1bb71956365baf97ec0c9621488c08451d5d9df0118bf80b45e82";

function reset() {
  sent.length = 0;
  events.length = 0;
  hosts.runShell = realRunShell;
}
test.after(() => {
  hosts.runShell = realRunShell;
});

const host = (id) => ({ id, label: id.toUpperCase(), dir: "/root/twitchbot", runtime: "docker" });
const inspectOut = (expectedId, rows) =>
  "EXPECTED " + (expectedId || "") + "\n" + rows.map((r) => "/" + r.join("|")).join("\n") + "\n";

// A host whose tag can be removed and put back. `tagOk` false = `docker tag` fails.
function fakeHost(rows, { tagOk = true } = {}) {
  const state = { tagged: true, commands: [] };
  const run = async (_h, cmd) => {
    state.commands.push(cmd);
    if (/docker tag /.test(cmd)) {
      if (!tagOk) throw new Error("docker tag failed");
      state.tagged = true;
      return { stdout: ID + "\n" };
    }
    return { stdout: inspectOut(state.tagged ? ID : "", rows) };
  };
  return { state, run };
}

test("a proven missing farm tag is put back automatically — no error alert, nothing restarted", async () => {
  reset();
  const rows = [
    ["twitchbotx3", ID, "running"],
    ["twitchbotx7", ID, "created"],
  ];
  const h = host("r1");
  const f = fakeHost(rows);
  hosts.runShell = f.run;
  const t0 = 60 * 24 * HOUR;
  await mon.buildScanHost(h, t0); // healthy: remembers the id the tag points at
  assert.strictEqual(sent.length, 0);

  f.state.tagged = false; // the hosting agent restarts and the tag is gone
  await mon.buildScanHost(h, t0 + HOUR);
  const tagCmds = f.state.commands.filter((c) => /docker tag /.test(c));
  assert.strictEqual(tagCmds.length, 1, "one re-tag");
  assert.match(tagCmds[0], /docker tag 'sha256:fdd990dd54f1[0-9a-f]+' 'twitchbot-farm:latest'/);
  assert.ok(
    !f.state.commands.some((c) => /restart|compose|rm |stop/.test(c)),
    "nothing but the tag is touched",
  );
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].action, "farm_tag_restored");
  assert.strictEqual(events[0].severity, "warn");
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /put it back automatically on fdd990dd54f1/);
  assert.doesNotMatch(sent[0], /tag is gone/);

  await mon.buildScanHost(h, t0 + 2 * HOUR); // tag present again → quiet
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(events.length, 1);

  f.state.tagged = false; // removed again the same day
  await mon.buildScanHost(h, t0 + 3 * HOUR);
  assert.strictEqual(events.length, 2, "every restore is logged");
  assert.strictEqual(sent.length, 1, "but Telegram at most once a day per host");
});

test("when the re-tag fails, the proven one-line fix is still alerted", async () => {
  reset();
  const rows = [["twitchbotx3", ID, "running"]];
  const h = host("r2");
  const f = fakeHost(rows, { tagOk: false });
  hosts.runShell = f.run;
  await mon.buildScanHost(h, 70 * 24 * HOUR);
  f.state.tagged = false;
  await mon.buildScanHost(h, 70 * 24 * HOUR + HOUR);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /tag is gone, but all 1 farm bots here still run fdd990dd54f1/);
  assert.match(sent[0], /Fix, no restart needed: docker tag fdd990dd54f1 twitchbot-farm:latest$/);
  assert.strictEqual(events[0].action, "stale_build");
  assert.strictEqual(events[0].severity, "error");
});

test("an image with no proof of being a farm build is never re-tagged", async () => {
  reset();
  // An id no host has ever carried the farm tag on (the earlier tests' hosts DO
  // carry ID, which would legitimately count as proof).
  const unproven = "sha256:" + "ab".repeat(32);
  const rows = [["twitchbotx2", unproven, "running"]];
  const f = fakeHost(rows);
  f.state.tagged = false; // no history on this host, no peer with this id
  hosts.runShell = f.run;
  await mon.buildScanHost(host("r3"), 80 * 24 * HOUR);
  assert.ok(!f.state.commands.some((c) => /docker tag /.test(c)), "no re-tag without proof");
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /no local twitchbot-farm:latest image/);
});

test("BOT_FARM_TAG_AUTORESTORE=0 turns the re-tag off and leaves the alert", async () => {
  reset();
  const rows = [["twitchbotx3", ID, "running"]];
  const h = host("r4");
  const f = fakeHost(rows);
  hosts.runShell = f.run;
  await mon.buildScanHost(h, 90 * 24 * HOUR);
  f.state.tagged = false;
  process.env.BOT_FARM_TAG_AUTORESTORE = "0";
  try {
    await mon.buildScanHost(h, 90 * 24 * HOUR + HOUR);
  } finally {
    delete process.env.BOT_FARM_TAG_AUTORESTORE;
  }
  assert.ok(!f.state.commands.some((c) => /docker tag /.test(c)));
  assert.match(sent[0], /tag is gone/);
});
