// "Watching but not credited". 2026-10-07 ~21:30Z Twitch stopped counting
// Drops watch time unless the viewer requests the stream's media segments.
// Every bot stayed up, kept every account logging "N/M minutes watched" once a
// minute with no error, and N stopped moving: ~1% of watched minutes credited
// on every bot on every host for 18 hours, and no alarm. Covers the awk
// measurement the host runs, the verdict, and decayScanHost end to end against
// a stubbed host layer.
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("child_process");

// Capture instead of sending: stub Telegram + the audit log BEFORE the monitor
// loads (it destructures both at require time).
const sent = [];
const events = [];
function stub(rel, exportsObj) {
  const id = require.resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
}
stub("../utils/telegram", { sendTelegram: async (m) => { sent.push(m); } });
stub("../utils/systemLog", { logEvent: (e) => { events.push(e); } });

const hosts = require("../utils/botHosts");
const mon = require("../utils/botHealthMonitor");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const NOW = Date.parse("2026-10-08T15:00:00Z");
const iso19 = (ms) => new Date(ms).toISOString().slice(0, 19);

// ---- the awk program ------------------------------------------------------

// One line as `docker logs -t` prints it: docker's time, then the bot's own.
function watchLine(ms, login, cur, tot) {
  const d = new Date(ms).toISOString();
  return (
    d.replace(/\.\d+Z$/, ".123456789Z") + " " + d.slice(0, 10) + " " + d.slice(11, 23) +
    " +00:00 [INF] [TwitchUser - " + login + "] Waiting 60 seconds... " + cur + "/" + tot + " minutes watched."
  );
}

function credit(awkBin, lines, cs = "") {
  const r = spawnSync(awkBin, ["-v", "st=" + iso19(NOW - 6 * HOUR), "-v", "cs=" + cs, mon.LOG_SCAN_AWK], {
    input: lines.join("\n") + "\n",
    encoding: "utf8",
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const scan = mon.parseLogScan("SCAN|b|x\n" + r.stdout + "END|b\n").b;
  return { watchedSec: scan.watchedSec, creditedMin: scan.creditedMin, watchers: scan.watchers };
}

const availableAwks = ["awk", "mawk", "gawk"].filter(
  (b) => spawnSync(b, ["BEGIN { exit 0 }"], { encoding: "utf8" }).status === 0,
);

for (const awkBin of availableAwks) {
  test(`[${awkBin}] a healthy account is credited a minute per minute watched`, () => {
    const lines = [];
    for (let i = 0; i <= 10; i++) lines.push(watchLine(NOW - 20 * MIN + i * MIN, "good", 5 + i, 60));
    assert.deepStrictEqual(credit(awkBin, lines), { watchedSec: 600, creditedMin: 10, watchers: 1 });
  });

  test(`[${awkBin}] the outage shape: minutes watched, nothing credited`, () => {
    const lines = [];
    for (let i = 0; i <= 10; i++) {
      lines.push(watchLine(NOW - 20 * MIN + i * MIN, "flat1", 8, 60));
      lines.push(watchLine(NOW - 20 * MIN + i * MIN + 500, "flat2", 0, 120));
    }
    assert.deepStrictEqual(credit(awkBin, lines), { watchedSec: 1200, creditedMin: 0, watchers: 2 });
  });

  test(`[${awkBin}] only the credit window counts, and only continuous watching of one drop`, () => {
    const t0 = NOW - 3 * HOUR;
    const lines = [
      // Two hours ago, credited — before the window: history.
      watchLine(t0, "a", 1, 60),
      watchLine(t0 + MIN, "a", 2, 60),
      // Inside the window. The first pair spans a 2h break in watching: skipped.
      watchLine(NOW - 30 * MIN, "a", 2, 60),
      watchLine(NOW - 29 * MIN, "a", 3, 60),
      // The next drop (another total): the pair across the change is skipped.
      watchLine(NOW - 28 * MIN, "a", 0, 120),
      watchLine(NOW - 27 * MIN, "a", 1, 120),
      // A line with no account, and a non-watch line of that account: ignored.
      "2026-10-08T14:33:00.000000000Z 12/60 minutes watched.",
      watchLine(NOW - 27 * MIN + 1000, "a", 1, 120).replace(/Waiting.*$/, 'Checking "X"...'),
    ];
    assert.deepStrictEqual(credit(awkBin, lines, iso19(NOW - HOUR)), { watchedSec: 120, creditedMin: 2, watchers: 1 });
    // No window start (a host whose `date` could not compute it): everything scanned counts.
    assert.deepStrictEqual(credit(awkBin, lines), { watchedSec: 180, creditedMin: 3, watchers: 1 });
  });

  test(`[${awkBin}] a pair across midnight is one minute, not a negative day`, () => {
    const midnight = Date.parse("2026-10-08T00:00:00Z");
    const lines = [watchLine(midnight - 30000, "n", 4, 60), watchLine(midnight + 30000, "n", 5, 60)];
    assert.deepStrictEqual(credit(awkBin, lines), { watchedSec: 60, creditedMin: 1, watchers: 1 });
  });
}

// ---- the verdict ------------------------------------------------------------

test("creditVerdict: healthy, the outage, and too little watching to say", () => {
  const v = mon.creditVerdict;
  // Measured 2026-10-08 after the fix (contabo/twitchbotx20, 6 minutes).
  assert.strictEqual(v({ watchedSec: 384 * 60, creditedMin: 387, watchers: 100 }).verdict, "ok");
  // Measured during the outage (contabo/twitchbotx56, one hour): 1 of 294.
  const out = v({ watchedSec: 294 * 60, creditedMin: 1, watchers: 11 });
  assert.strictEqual(out.verdict, "not_credited");
  assert.strictEqual(out.watchedMin, 294);
  // Half credited is degraded, not this alarm (floor is 30%).
  assert.strictEqual(v({ watchedSec: 1000 * 60, creditedMin: 500, watchers: 50 }).verdict, "ok");
  assert.strictEqual(v({ watchedSec: 1000 * 60, creditedMin: 290, watchers: 50 }).verdict, "not_credited");
  // Not enough minutes, or not enough accounts: no verdict either way.
  assert.strictEqual(v({ watchedSec: 150 * 60, creditedMin: 0, watchers: 30 }).verdict, "inconclusive");
  assert.strictEqual(v({ watchedSec: 600 * 60, creditedMin: 0, watchers: 9 }).verdict, "inconclusive");
  assert.strictEqual(v({ watchedSec: 0, creditedMin: 0, watchers: 0 }).verdict, "inconclusive");
});

test("isNoClaimBot / sumCredit", () => {
  assert.ok(mon.isNoClaimBot("noclaim-bot-17"));
  assert.ok(!mon.isNoClaimBot("twitchbotx17"));
  assert.ok(!mon.isNoClaimBot("noclaim-rollout-test"));
  assert.deepStrictEqual(
    mon.sumCredit([
      { watchedSec: 600, creditedMin: 9, watchers: 3 },
      undefined, // a bot the scan returned nothing for
      { watchedSec: 0, creditedMin: 0, watchers: 0 },
      { watchedSec: 1200, creditedMin: 1, watchers: 5 },
    ]),
    { watchedSec: 1800, creditedMin: 10, watchers: 8, bots: 2 },
  );
});

test("logScanScript hands the credit window to awk and stays empty for no bots", () => {
  const script = mon.logScanScript(["twitchbotx44"], "6h", 45);
  assert.match(script, /^cs=\$\(date -u -d '-45 minutes' \+%Y-%m-%dT%H:%M:%S 2>\/dev\/null\); /);
  assert.match(script, /awk -v st="\$st" -v cs="\$cs" /);
  assert.strictEqual(mon.logScanScript([], "6h"), "");
  assert.strictEqual(mon.logScanScript(["bad;name"], "6h"), "");
});

// ---- decayScanHost end to end ------------------------------------------------

const HOST = { id: "contabo", label: "Contabo VPS", runtime: "docker", transport: "ssh" };

// bots: { name: [watchedMin, creditedMin, watchers] } — every listed bot is running.
function stubHost(bots) {
  const calls = { scripts: [], restarts: [] };
  const states = {};
  for (const name of Object.keys(bots)) states[name] = { state: "running", status: "Up 3 hours" };
  hosts.dockerPs = async () => states;
  // Small configs: the decay check has nothing to say about these bots.
  hosts.readFiles = async (host, files) =>
    Object.fromEntries(files.map((f) => [f, { ok: true, text: JSON.stringify({ TwitchSettings: { TwitchUsers: [] } }) }]));
  hosts.readFile = async () => JSON.stringify({ TwitchSettings: { TwitchUsers: [] } });
  hosts.runShell = async (host, script) => {
    calls.scripts.push(script);
    const out = [];
    for (const [name, [watchedMin, creditedMin, watchers]] of Object.entries(bots)) {
      if (!script.includes("c='" + name + "';")) continue;
      out.push(
        "SCAN|" + name + "|" + iso19(NOW - 3 * HOUR),
        "FIRST|" + iso19(NOW - 3 * HOUR),
        "USERS|" + watchers,
        "JSON|0",
        "CREDIT|" + watchedMin * 60 + "|" + creditedMin + "|" + watchers,
        "END|" + name,
      );
    }
    return { stdout: out.join("\n") };
  };
  hosts.dockerContainer = async (host, action, c) => { calls.restarts.push(action + " " + c); };
  hosts.dockerLogs = async () => { throw new Error("docker hosts must not pull a capped tail"); };
  return calls;
}

function reset() {
  sent.length = 0;
  events.length = 0;
}

const farmRow = (k) => mon.status().credit.farms.find((f) => f.key === k);

test("a healthy host raises nothing, and one flat bot among healthy ones is not an outage", async () => {
  reset();
  stubHost({
    twitchbotx20: [384, 387, 100],
    twitchbotx32: [175, 179, 35],
    // An event channel between broadcasts: 12 accounts watching, nothing credited.
    twitchbotx4: [84, 0, 12],
    "noclaim-bot-17": [268, 270, 67],
  });
  await mon.decayScanHost(HOST, NOW);
  assert.deepStrictEqual(sent, []);
  assert.deepStrictEqual(events, []);
  const farm = farmRow("contabo:farm");
  assert.strictEqual(farm.verdict, "ok");
  assert.strictEqual(farm.watchedMin, 643);
  assert.strictEqual(farm.creditedMin, 566);
  assert.strictEqual(farm.creditedPct, 88);
  assert.strictEqual(farm.bots, 3);
  assert.strictEqual(farmRow("contabo:noclaim").verdict, "ok");
  assert.match(mon.status().credit.basis, /minutes watched/);
});

test("the 2026-10-07 outage: both farms alarm once, are not restarted, and clear when credit returns", async () => {
  reset();
  // Figures from the outage, one hour per bot.
  const outage = {
    twitchbotx56: [294, 1, 11],
    twitchbotx54: [85, 0, 13],
    twitchbotx5: [430, 1, 14],
    "noclaim-bot-21": [628, 2, 46],
  };
  let calls = stubHost(outage);
  await mon.decayScanHost(HOST, NOW + HOUR);
  assert.strictEqual(calls.scripts.length, 2, "one scan for the farm bots, one for the no-claim bots");
  assert.match(calls.scripts.find((s) => s.includes("noclaim-bot-21")), /docker logs -t --since '70m'/);
  assert.deepStrictEqual(calls.restarts, [], "a restart cannot fix this — never restart for it");
  assert.strictEqual(sent.length, 2);
  const farmMsg = sent.find((m) => m.includes("Contabo VPS farm bots"));
  assert.match(farmMsg, /watching but Twitch credits almost nothing: 2 of 809 watched minutes credited \(0%\) across 38 accounts on 3 bots in the last 60 min/);
  assert.match(sent.find((m) => m.includes("Contabo VPS no-claim bots")), /2 of 628 watched minutes credited/);
  const ev = events.filter((e) => e.action === "watch_not_credited");
  assert.strictEqual(ev.length, 2);
  assert.ok(ev.every((e) => e.severity === "error" && e.host === "contabo" && e.actor === "healthMonitor"));
  assert.strictEqual(farmRow("contabo:farm").alerting, true);

  // Still out an hour later: no repeat inside the reminder window.
  reset();
  await mon.decayScanHost(HOST, NOW + 2 * HOUR);
  assert.deepStrictEqual(sent, []);

  // Bots just recreated on a fixed build: too little watching yet. No verdict,
  // and the open alarm is not cleared on it.
  reset();
  stubHost({ twitchbotx56: [20, 20, 11], "noclaim-bot-21": [30, 29, 46] });
  await mon.decayScanHost(HOST, NOW + 3 * HOUR);
  assert.deepStrictEqual(sent, []);
  assert.strictEqual(farmRow("contabo:farm").verdict, "inconclusive");
  assert.strictEqual(farmRow("contabo:farm").alerting, true);

  // Credit is back: one all-clear per farm.
  reset();
  stubHost({ twitchbotx56: [300, 297, 11], twitchbotx5: [420, 425, 14], "noclaim-bot-21": [620, 600, 46] });
  await mon.decayScanHost(HOST, NOW + 4 * HOUR);
  assert.strictEqual(sent.length, 2);
  assert.ok(sent.every((m) => /^✅ Contabo VPS (farm|no-claim) bots: Twitch is crediting watch time again/.test(m)));
  assert.strictEqual(events.filter((e) => e.action === "watch_credited_again").length, 2);
  assert.strictEqual(farmRow("contabo:farm").alerting, false);

  // The outage again, more than the reminder window after the first alarm: alarms again.
  reset();
  stubHost(outage);
  await mon.decayScanHost(HOST, NOW + 12 * HOUR);
  assert.strictEqual(sent.length, 2);
});

test("a host with only no-claim bots is still measured", async () => {
  reset();
  const other = { id: "nchost", label: "NC host", runtime: "docker", transport: "ssh" };
  const calls = stubHost({ "noclaim-bot-5": [400, 3, 40] });
  await mon.decayScanHost(other, NOW);
  assert.strictEqual(calls.scripts.length, 1);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /NC host no-claim bots are watching but Twitch credits almost nothing/);
  assert.strictEqual(farmRow("nchost:farm"), undefined);
});

test("a failed scan gives no verdict", async () => {
  reset();
  const other = { id: "flaky", label: "Flaky", runtime: "docker", transport: "ssh" };
  stubHost({ twitchbotx2: [400, 0, 40], "noclaim-bot-9": [400, 0, 40] });
  hosts.runShell = async () => { throw new Error("ssh: connect timed out"); };
  await mon.decayScanHost(other, NOW);
  assert.deepStrictEqual(sent, []);
  assert.strictEqual(farmRow("flaky:farm"), undefined);
  assert.strictEqual(farmRow("flaky:noclaim"), undefined);
});
