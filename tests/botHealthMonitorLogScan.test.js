// The hourly log scan behind the thread-decay check and the GQL parse-error
// alarm. 2026-09-29: contabo/twitchbotx44 logged ~45,000 lines an hour of a
// GQL parse error's stack traces, so the old "--tail 2000" window was the last
// 21 seconds; 23 of 132 accounts happened to print in it and the healthy bot
// was restarted as "decayed". Covers the awk program the host runs, its
// parser, and decayScanHost end to end against a stubbed host layer.
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

const HOUR = 3600 * 1000;
const NOW = Date.parse("2026-09-29T13:42:58Z");
const iso19 = (ms) => new Date(ms).toISOString().slice(0, 19);

// ---- the awk program ------------------------------------------------------

function dockerLine(ms, text) {
  return new Date(ms).toISOString().replace(/\.\d+Z$/, ".123456789Z") + " " + text;
}

function runAwk(awkBin, st, lines) {
  return spawnSync(awkBin, ["-v", "st=" + st, mon.LOG_SCAN_AWK], {
    input: lines.join("\n") + "\n",
    encoding: "utf8",
  });
}

const availableAwks = ["awk", "mawk", "gawk"].filter(
  (b) => spawnSync(b, ["BEGIN { exit 0 }"], { encoding: "utf8" }).status === 0,
);

for (const awkBin of availableAwks) {
  test(`[${awkBin}] counts every account over the whole window and parse errors since start only`, () => {
    const started = NOW - 2 * HOUR;
    const lines = [];
    // Pre-restart history: an old parse error must NOT count as current.
    lines.push(dockerLine(NOW - 5 * HOUR, "2026-09-29 08:42:58.000 +00:00 [INF] [TwitchUser - early] Checking \"X\"..."));
    lines.push(dockerLine(NOW - 5 * HOUR + 1000, "System.Text.Json.JsonException: old. Path: $.data.old[3].field | LineNumber: 0"));
    // Since start: 3 accounts, a parse-error flood on one path, and a shape warning with a '|'.
    for (let i = 0; i < 3; i++) {
      const t = started + (i + 1) * 60000;
      lines.push(dockerLine(t, `2026-09-29 12:00:00.000 +00:00 [ERR] [TwitchUser - acc${i}] Failed to execute the query DropChannelCampaignsProgress (attempt 1/5).`));
      lines.push(dockerLine(t + 1, "System.Text.Json.JsonException: The JSON value could not be converted to System.String. Path: $.data.channelDropCampaignsProgress[" + i + "].rewardGroups[0].progressCriteria.channels | LineNumber: 0 | BytePositionInLine: 4371."));
      lines.push(dockerLine(t + 2, "   at System.Text.Json.ThrowHelper.ReThrowWithPath(ReadStack& state, Utf8JsonReader& reader, Exception ex)"));
    }
    lines.push(dockerLine(started + 5 * 60000, "2026-09-29 12:05:00.000 +00:00 [WRN] [TwitchUser - acc0] Twitch response shape changed (Inventory): DistributionType received unknown value \"NEW|X\" — read as UNKNOWN"));
    lines.push(dockerLine(started + 6 * 60000, "2026-09-29 12:06:00.000 +00:00 [WRN] [TwitchUser - acc1] Twitch response shape changed (Inventory): DistributionType received unknown value \"NEW|X\" — read as UNKNOWN"));

    const r = runAwk(awkBin, iso19(started), lines);
    assert.strictEqual(r.status, 0, r.stderr);
    const scan = mon.parseLogScan("SCAN|twitchbotx44|" + iso19(started) + "\n" + r.stdout + "END|twitchbotx44\n").twitchbotx44;
    assert.strictEqual(scan.first, iso19(NOW - 5 * HOUR));
    assert.strictEqual(scan.active, 4, "early + acc0..acc2 — the whole window, no line cap");
    assert.strictEqual(scan.jsonErrors, 3, "the pre-restart parse error is history");
    assert.deepStrictEqual(scan.jsonPaths, [
      { count: 3, path: "$.data.channelDropCampaignsProgress[N].rewardGroups[N].progressCriteria.channels" },
    ]);
    assert.deepStrictEqual(scan.shapes, ['(Inventory): DistributionType received unknown value "NEW/X" — read as UNKNOWN']);
  });
}

test("parseLogScan keeps containers apart and tolerates noise", () => {
  const out = mon.parseLogScan(
    [
      "noise before",
      "SCAN|twitchbotx2|2026-09-29T10:00:00",
      "FIRST|2026-09-29T08:00:00",
      "USERS|50",
      "JSON|0",
      "END|twitchbotx2",
      "SCAN|twitchbotx44|2026-09-29T12:00:00",
      "FIRST|2026-09-29T07:43:00",
      "USERS|132",
      "JSON|3000",
      "JPATH|12|$.data.b",
      "JPATH|2988|$.data.a",
      "END|twitchbotx44",
    ].join("\n"),
  );
  assert.strictEqual(out.twitchbotx2.active, 50);
  assert.strictEqual(out.twitchbotx2.jsonErrors, 0);
  assert.strictEqual(out.twitchbotx44.jsonPaths[0].path, "$.data.a", "sorted by count");
  assert.strictEqual(mon.logCoverageMs(out.twitchbotx44, NOW), 6 * HOUR - 2000);
});

test("logScanScript reads the whole window (no --tail) and skips unsafe names", () => {
  const script = mon.logScanScript(["twitchbotx44", "bad;name"], "6h");
  assert.match(script, /docker logs -t --since '6h' "\$c"/);
  assert.doesNotMatch(script, /--tail/);
  assert.match(script, /echo "SCAN\|\$c\|\$st"/);
  assert.doesNotMatch(script, /bad;name/);
});

// ---- decayScanHost end to end ------------------------------------------------

const HOST = { id: "contabo", label: "Contabo VPS", runtime: "docker", transport: "ssh" };

function configWith(n) {
  const users = Array.from({ length: n }, (_, i) => ({ Login: "u" + i, Enabled: true }));
  return JSON.stringify({ TwitchSettings: { TwitchUsers: users } });
}

function stubHost({ status = "Up 3 hours", enabled, scanLines }) {
  const calls = { restarts: [], scripts: [] };
  hosts.dockerPs = async () => ({ twitchbotx44: { state: "running", status } });
  hosts.readFiles = async (host, files) =>
    Object.fromEntries(files.map((f) => [f, { ok: true, text: configWith(enabled) }]));
  hosts.readFile = async () => configWith(enabled);
  hosts.runShell = async (host, script) => {
    calls.scripts.push(script);
    return { stdout: ["SCAN|twitchbotx44|" + iso19(NOW - 2 * HOUR), ...scanLines, "END|twitchbotx44"].join("\n") };
  };
  hosts.dockerContainer = async (host, action, c) => { calls.restarts.push(action + " " + c); };
  hosts.dockerLogs = async () => { throw new Error("docker hosts must not pull a capped tail"); };
  return calls;
}

function reset() {
  sent.length = 0;
  events.length = 0;
}

test("the 2026-09-29 x44 case: all 132 active + a parse-error flood → no decay, one parse alarm", async () => {
  reset();
  const calls = stubHost({
    enabled: 132,
    scanLines: [
      "FIRST|" + iso19(NOW - 6 * HOUR),
      "USERS|132",
      "JSON|3000",
      "JPATH|3000|$.data.channelDropCampaignsProgress[N].rewardGroups[N].progressCriteria.channels",
    ],
  });
  await mon.decayScanHost(HOST, NOW);
  assert.deepStrictEqual(calls.restarts, [], "a healthy bot is never restarted");
  assert.strictEqual(calls.scripts.length, 1, "one round trip for the whole host");
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /🧩 Contabo VPS\/twitchbotx44: 3000 Twitch GQL parse errors/);
  assert.match(sent[0], /progressCriteria\.channels ×3000/);
  assert.ok(events.some((e) => e.action === "gql_parse_errors" && e.count === 3000));
  assert.ok(!events.some((e) => /stall/.test(e.action)));

  // Same state an hour later: no repeat inside the reminder window.
  reset();
  await mon.decayScanHost(HOST, NOW + HOUR);
  assert.strictEqual(sent.length, 0);

  // After a fixed build is rolled out the count since start is 0: all-clear.
  stubHost({ enabled: 132, scanLines: ["FIRST|" + iso19(NOW - 6 * HOUR), "USERS|132", "JSON|0"] });
  await mon.decayScanHost(HOST, NOW + 2 * HOUR);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /✅ Contabo VPS\/twitchbotx44 no longer logs Twitch GQL parse errors/);
});

test("a genuinely decayed bot (18 of 94 over 6h) is still caught", async () => {
  reset();
  const calls = stubHost({
    enabled: 94,
    scanLines: ["FIRST|" + iso19(NOW - 6 * HOUR), "USERS|18", "JSON|0"],
  });
  await mon.decayScanHost(HOST, NOW + 10 * HOUR);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /thread decay: only 18\/94 accounts \(19%\)/);
  assert.ok(events.some((e) => e.action === "stall_detected" || e.action === "stall_restart"));
  // Default action is "alert" (BOT_DECAY_ACTION unset in tests): no restart.
  assert.deepStrictEqual(calls.restarts, []);
});

test("a log that reaches back only minutes gives no decay verdict at all", async () => {
  reset();
  const calls = stubHost({
    enabled: 132,
    scanLines: ["FIRST|" + iso19(NOW + 20 * HOUR - 10 * 60000), "USERS|23", "JSON|0"],
  });
  await mon.decayScanHost(HOST, NOW + 20 * HOUR);
  assert.strictEqual(sent.length, 0);
  assert.deepStrictEqual(calls.restarts, []);
  const row = mon.status().decay.containers.find((c) => c.key === "contabo:twitchbotx44");
  assert.strictEqual(row.inconclusive, true);
  assert.strictEqual(row.coverageMin, 10);
});

test("a freshly restarted bot is not judged", async () => {
  reset();
  const calls = stubHost({
    status: "Up 20 minutes",
    enabled: 132,
    scanLines: ["FIRST|" + iso19(NOW + 30 * HOUR - 6 * HOUR), "USERS|5", "JSON|0"],
  });
  await mon.decayScanHost(HOST, NOW + 30 * HOUR);
  assert.strictEqual(sent.length, 0);
  assert.deepStrictEqual(calls.restarts, []);
});

test("absorbed shape changes are reported once per host", async () => {
  reset();
  const lines = [
    "FIRST|" + iso19(NOW + 40 * HOUR - 6 * HOUR),
    "USERS|132",
    "JSON|0",
    'SHAPE|(Inventory): DistributionType received unknown value "SOMETHING" — read as UNKNOWN',
  ];
  stubHost({ enabled: 132, scanLines: lines });
  await mon.decayScanHost(HOST, NOW + 40 * HOUR);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /Twitch changed a GQL response shape and the bot absorbed it/);
  assert.match(sent[0], /SOMETHING/);
  assert.ok(events.some((e) => e.action === "gql_shape_changed"));
  reset();
  await mon.decayScanHost(HOST, NOW + 41 * HOUR);
  assert.strictEqual(sent.length, 0, "the same shape is not re-reported");
});
