// The no-claim watcher must not keep (or cold-start) bots whose accounts have
// already finished every live campaign — 21 finished Overwatch bots sat running
// through each OWCS broadcast. Covers the pure decisions, the readBots parser,
// and the exact python program that classifies a bot's log on the host.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const {
  decideActions,
  parseBots,
  finishedCovers,
  markerCampaignIds,
  LOG_VERDICT_PY,
} = require("../utils/noclaimWatcher");

const MIN = 60 * 1000;
const NOW = Date.parse("2026-09-29T10:00:00Z");
const liveOw = (ids) => ({
  overwatch: {
    live: true,
    uncertain: false,
    canStop: false,
    campaigns: ids.map((id) => ({ id, startAt: new Date(NOW - 5 * 24 * 60 * MIN) })),
  },
});

test("a running bot whose accounts all finished is stopped even while the game is live", () => {
  const bots = [{ id: "24", game: "Overwatch", running: true, finishedNow: true }];
  const r = decideActions(bots, liveOw(["owcs"]));
  assert.deepStrictEqual(r.finished, ["24"]);
  assert.deepStrictEqual(r.starts, []);
  assert.deepStrictEqual(r.stops, []);
});

test("a running bot with work left is left alone while live", () => {
  const bots = [{ id: "17", game: "Overwatch", running: true, finishedNow: false }];
  const r = decideActions(bots, liveOw(["owcs"]));
  assert.deepStrictEqual(r.finished, []);
  assert.deepStrictEqual(r.stops, []);
});

test("a finished marker covering the live campaigns blocks the cold-start", () => {
  const bots = [{
    id: "24", game: "Overwatch", running: false, operatorOff: false,
    accountsKey: "k1", finishedMarker: { campaignIds: ["owcs"], accountsKey: "k1" },
  }];
  assert.deepStrictEqual(decideActions(bots, liveOw(["owcs"])).starts, []);
});

test("a NEW campaign wakes a bot that finished the old one", () => {
  const bots = [{
    id: "24", game: "Overwatch", running: false, operatorOff: false,
    accountsKey: "k1", finishedMarker: { campaignIds: ["owcs"], accountsKey: "k1" },
  }];
  assert.deepStrictEqual(decideActions(bots, liveOw(["owcs", "new"])).starts, ["24"]);
});

test("a changed config (new accounts) wakes a finished bot", () => {
  const bots = [{
    id: "24", game: "Overwatch", running: false, operatorOff: false,
    accountsKey: "k2", finishedMarker: { campaignIds: ["owcs"], accountsKey: "k1" },
  }];
  assert.deepStrictEqual(decideActions(bots, liveOw(["owcs"])).starts, ["24"]);
});

test("without a marker the old cold-start behaviour is unchanged", () => {
  const bots = [{ id: "9", game: "Overwatch", running: false, operatorOff: false }];
  assert.deepStrictEqual(decideActions(bots, liveOw(["owcs"])).starts, ["9"]);
});

test("finishedCovers needs a non-empty live campaign set and a matching config", () => {
  const b = { accountsKey: "k", finishedMarker: { campaignIds: ["a"], accountsKey: "k" } };
  assert.strictEqual(finishedCovers(b, { campaigns: [] }), false);
  assert.strictEqual(finishedCovers(b, { campaigns: [{ id: "a" }] }), true);
  assert.strictEqual(finishedCovers({ ...b, accountsKey: "" }, { campaigns: [{ id: "a" }] }), false);
  assert.strictEqual(finishedCovers({ accountsKey: "k" }, { campaigns: [{ id: "a" }] }), false);
});

test("markerCampaignIds leaves out a campaign too young to have been seen", () => {
  const v = {
    campaigns: [
      { id: "old", startAt: new Date(NOW - 2 * 60 * MIN) },
      { id: "young", startAt: new Date(NOW - 5 * MIN) },
    ],
  };
  assert.deepStrictEqual(markerCampaignIds(v, NOW), ["old"]);
});

test("parseBots reads markers, config keys and the log verdict", () => {
  const out = [
    "PS_START", "noclaim-bot-24|running", "noclaim-bot-5|exited", "noclaim-bot-17|running", "PS_END",
    "BOTS_START",
    'noclaim-bot-x|ignored',
    '24|Overwatch|no|no|abc123|',
    '5|Overwatch|yes|no|def456|{"at":"2026-09-29T09:00:00Z","campaignIds":["c1"],"accountsKey":"def456"}',
    "17|Rainbow Six Siege|no|no|ghi789|",
    "BOTS_END",
    "LOGS_START", "24|1800|46|46|0|0", "17|1800|38|36|2|0", "LOGS_END",
  ].join("\n");
  const bots = parseBots(out);
  const by = Object.fromEntries(bots.map((b) => [b.id, b]));
  assert.strictEqual(by["24"].finishedNow, true);
  assert.strictEqual(by["17"].finishedNow, false); // 2 accounts still waiting on a broadcast
  assert.strictEqual(by["5"].running, false);
  assert.deepStrictEqual(by["5"].finishedMarker.campaignIds, ["c1"]);
  assert.strictEqual(by["24"].accountsKey, "abc123");
});

test("parseBots: too-young containers and failed verdicts are never finished", () => {
  const base = ["PS_START", "noclaim-bot-1|running", "noclaim-bot-2|running", "PS_END",
    "BOTS_START", "1|Overwatch|no|no|k|", "2|Overwatch|no|no|k|", "BOTS_END"];
  const bots = parseBots(base.concat(["LOGS_START", "1|300|10|10|0|0", "2|9999|ERR|py", "LOGS_END"]).join("\n"));
  assert.strictEqual(bots.find((b) => b.id === "1").finishedNow, false); // up 5 min only
  assert.strictEqual(bots.find((b) => b.id === "2").finishedNow, false);
});

test("parseBots still reads the old 4-field bot lines", () => {
  const bots = parseBots(["PS_START", "noclaim-bot-3|exited", "PS_END", "BOTS_START", "3|Overwatch|yes|no", "BOTS_END"].join("\n"));
  assert.strictEqual(bots[0].autostopped, true);
  assert.strictEqual(bots[0].finishedMarker, null);
  assert.strictEqual(bots[0].finishedNow, false);
});

// ---- the host-side log classifier (python3) --------------------------------
const hasPython = spawnSync("python3", ["-c", "print(1)"]).status === 0;

function runVerdict(users, lines, started) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ncw-"));
  const cfgPath = path.join(dir, "config.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ TwitchSettings: { TwitchUsers: users } }));
  const r = spawnSync("python3", ["-c", LOG_VERDICT_PY, cfgPath, started], {
    input: lines.join("\n") + "\n",
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return String(r.stdout).trim();
}
const L = (t, acct, msg) => `2026-09-29 ${t}.000 +00:00 [INF] [TwitchUser - ${acct}] ${msg}`;
const doneCycle = (t, a) => [
  L(t, a, "Removing 1 finished campaigns..."),
  L(t, a, "ClaimDrops is disabled — skipping claim, leaving drops unclaimed for the buyer."),
  L(t, a, "No broadcaster or campaign left."),
  L(t, a, "Waiting 300 seconds before trying again."),
];

test("log verdict: finished / pending / unknown per enabled account", { skip: !hasPython }, () => {
  const users = [
    { Login: "accA", Enabled: true }, { Login: "accB", Enabled: true },
    { Login: "accC", Enabled: true }, { Login: "accD", Enabled: false },
    { Login: "accE" }, // no Enabled key = enabled
  ];
  const lines = [
    L("08:50:00", "accA", "Waiting 60 seconds... 11/60 minutes watched."), // before start: ignored
    ...doneCycle("09:10:00", "accA"), ...doneCycle("09:15:00", "accA"), ...doneCycle("09:20:00", "accA"),
    ...doneCycle("09:10:01", "accB"),
    L("09:15:01", "accB", 'Checking "Overwatch" ("OWCS")...'),
    L("09:15:01", "accB", "No live broadcaster found in this group of channels. (1/1)"),
    L("09:15:01", "accB", "No broadcaster found for this campaign."),
    L("09:15:01", "accB", "No broadcaster or campaign left."),
    L("09:15:01", "accB", "Waiting 300 seconds before trying again."),
    ...doneCycle("09:10:02", "accC"), // only one cycle -> unknown
    ...doneCycle("09:10:03", "accD"), ...doneCycle("09:15:03", "accD"), // disabled
  ];
  // enabled = A, B, C, E -> 1 finished, 1 pending, 2 unknown (C one cycle, E silent)
  assert.strictEqual(runVerdict(users, lines, "2026-09-29T09:00:00.123456Z"), "4|1|1|2");
});

test("log verdict: a finished cycle before the container started does not count", { skip: !hasPython }, () => {
  const users = [{ Login: "accA", Enabled: true }];
  const lines = [...doneCycle("08:10:00", "accA"), ...doneCycle("08:15:00", "accA")];
  assert.strictEqual(runVerdict(users, lines, "2026-09-29T09:00:00Z"), "1|0|0|1");
});

test("log verdict: a new campaign after the last clean cycle makes it pending", { skip: !hasPython }, () => {
  const users = [{ Login: "accA", Enabled: true }];
  const lines = [
    ...doneCycle("09:10:00", "accA"), ...doneCycle("09:15:00", "accA"),
    L("09:20:00", "accA", "Waiting 60 seconds... 1/60 minutes watched."),
  ];
  assert.strictEqual(runVerdict(users, lines, "2026-09-29T09:00:00Z"), "1|0|1|0");
});

test("log verdict: every enabled account finished", { skip: !hasPython }, () => {
  const users = [{ Login: "accA", Enabled: true }, { Login: "AccB", Enabled: true }];
  const lines = [
    ...doneCycle("09:10:00", "accA"), ...doneCycle("09:15:00", "accA"),
    ...doneCycle("09:10:00", "accb"), ...doneCycle("09:15:00", "accb"),
  ];
  assert.strictEqual(runVerdict(users, lines, "2026-09-29T09:00:00Z"), "2|2|0|0");
});

test("log verdict: an unreadable config prints ERR, never a verdict", { skip: !hasPython }, () => {
  const r = spawnSync("python3", ["-c", LOG_VERDICT_PY, "/nonexistent/config.json", "2026-09-29T09:00:00Z"], { input: "" });
  assert.strictEqual(String(r.stdout).trim(), "ERR|config");
});
