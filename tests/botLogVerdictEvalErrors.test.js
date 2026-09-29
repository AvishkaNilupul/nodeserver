// "Couldn't evaluate" must never read as "nothing left to farm" (2026-09-29:
// a Twitch GQL shape change made every Plants on Fire progress check throw,
// the bot logged "No broadcaster or campaign left" after the error, and
// twitchbotx53 was parked with 11 unfarmed accounts). Runs the exact python
// classifier the bot host executes against synthetic TwitchDropsBot logs.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { LOG_VERDICT_PY, parseLogVerdicts, isNothingLeft } = require("../utils/botLogVerdict");

const STARTED = "2026-09-29T11:00:00.000000000Z";

function writeConfig(logins, disabled = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logverdict-"));
  const file = path.join(dir, "config.json");
  const users = logins
    .map((Login) => ({ Login, Enabled: true }))
    .concat(disabled.map((Login) => ({ Login, Enabled: false })));
  fs.writeFileSync(file, JSON.stringify({ TwitchSettings: { TwitchUsers: users } }));
  return file;
}

// One log line in TwitchDropsBot's format.
let clock = 0;
function line(level, login, msg, at = null) {
  const t = at || new Date(Date.parse("2026-09-29T11:05:00Z") + clock++ * 1000);
  const ts = t.toISOString().replace("T", " ").replace("Z", "").slice(0, 23) + " +00:00";
  return `${ts} [${level}] [TwitchUser - ${login}] ${msg}`;
}

// A cycle that ends "nothing left", optionally with extra lines inside it.
function cycle(login, inner = []) {
  return [
    line("INF", login, "Removing 0 finished campaigns..."),
    ...inner,
    line("DBG", login, "No broadcaster or campaign left."),
    line("DBG", login, "Waiting 300 seconds before trying again."),
  ];
}

function verdict(configFile, logLines) {
  const r = spawnSync("python3", ["-c", LOG_VERDICT_PY, configFile, STARTED], {
    input: logLines.join("\n") + "\n",
    encoding: "utf8",
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const [enabled, finished, pending, unknown] = r.stdout.trim().split("|").map(Number);
  return { enabled, finished, pending, unknown };
}

test("two clean nothing-left cycles read as finished", () => {
  const cfg = writeConfig(["acc"]);
  assert.deepStrictEqual(verdict(cfg, [...cycle("acc"), ...cycle("acc")]), {
    enabled: 1, finished: 1, pending: 0, unknown: 0,
  });
});

test("a campaign the bot could not evaluate is NOT finished (2026-09-29 Plants on Fire)", () => {
  const cfg = writeConfig(["pof"]);
  const broken = [
    line("INF", "pof", 'Checking "Plants on Fire" ("Plants on Fire")...'),
    line("ERR", "pof", "Failed to execute the query DropChannelCampaignsProgress (attempt 1/5)."),
    "System.Text.Json.JsonException: The JSON value could not be converted to System.String. Path: $.data.channelDropCampaignsProgress[1].rewardGroups[0].progressCriteria.channels",
    "   at System.Text.Json.ThrowHelper.ReThrowWithPath(ReadStack& state, Utf8JsonReader& reader, Exception ex)",
    line("ERR", "pof", "Error fetching campaign progress"),
    line("INF", "pof", "No campaign found."),
  ];
  const v = verdict(cfg, [...cycle("pof", broken), ...cycle("pof", broken)]);
  assert.deepStrictEqual(v, { enabled: 1, finished: 0, pending: 0, unknown: 1 });
  assert.strictEqual(
    isNothingLeft({ ...v, uptimeS: 3600 }),
    false,
    "a bot whose only account could not evaluate its campaign must not be parked",
  );
});

test("claim errors alone do not block the finished verdict", () => {
  const cfg = writeConfig(["acc"]);
  const claimFail = [
    line("ERR", "acc", "Failed to claim drop Seed Pack for campaign Plants on Fire."),
    line("ERR", "acc", "Failed to fetch reward code for Skin. Skipping for 8 hours."),
  ];
  assert.deepStrictEqual(verdict(cfg, [...cycle("acc", claimFail), ...cycle("acc", claimFail)]), {
    enabled: 1, finished: 1, pending: 0, unknown: 0,
  });
});

test("an error before the last complete cycle no longer matters", () => {
  const cfg = writeConfig(["acc"]);
  const err = [line("ERR", "acc", "Failed to execute the query ViewerDropsDashboard (attempt 1/5).")];
  // cycle 1 errors, cycles 2 and 3 are clean: the last complete cycle is clean.
  assert.deepStrictEqual(verdict(cfg, [...cycle("acc", err), ...cycle("acc"), ...cycle("acc")]), {
    enabled: 1, finished: 1, pending: 0, unknown: 0,
  });
});

test("an error in the cycle now running makes the account unknown", () => {
  const cfg = writeConfig(["acc"]);
  const logs = [
    ...cycle("acc"),
    ...cycle("acc"),
    line("ERR", "acc", "Error fetching campaign progress"),
  ];
  assert.deepStrictEqual(verdict(cfg, logs), { enabled: 1, finished: 0, pending: 0, unknown: 1 });
});

test("watching or waiting for a broadcast is pending", () => {
  const cfg = writeConfig(["w", "b"]);
  // Pending needs one complete cycle first (two "Waiting 300 seconds" lines);
  // before that an account is unknown — either way it is not finished.
  const logs = [
    ...cycle("w"),
    ...cycle("w"),
    ...cycle("b"),
    line("INF", "w", "Waiting 60 seconds... 5/60 minutes watched."),
    line("INF", "b", "No broadcaster found for this campaign."),
    line("DBG", "b", "Waiting 300 seconds before trying again."),
  ];
  assert.deepStrictEqual(verdict(cfg, logs), { enabled: 2, finished: 0, pending: 2, unknown: 0 });
});

test("lines from before the container started are ignored; silent accounts are unknown", () => {
  const cfg = writeConfig(["old", "quiet"], ["off"]);
  const before = new Date("2026-09-29T10:00:00Z");
  const logs = [
    line("DBG", "old", "No broadcaster or campaign left.", before),
    line("DBG", "old", "Waiting 300 seconds before trying again.", new Date(before.getTime() + 1000)),
    line("DBG", "old", "No broadcaster or campaign left.", new Date(before.getTime() + 2000)),
    line("DBG", "old", "Waiting 300 seconds before trying again.", new Date(before.getTime() + 3000)),
    ...cycle("off"),
    ...cycle("off"),
  ];
  assert.deepStrictEqual(verdict(cfg, logs), { enabled: 2, finished: 0, pending: 0, unknown: 2 });
});
