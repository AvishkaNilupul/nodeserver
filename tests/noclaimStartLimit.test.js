// The no-claim watcher's start limit: a live broadcast must not start every
// bot at once (the host ran out of RAM). Pure functions only.
const test = require("node:test");
const assert = require("node:assert");
const {
  parseHostMem,
  memUsageMb,
  limitStarts,
  startLimitConfig,
} = require("../utils/noclaimWatcher");

const cfg = (o = {}) => ({ ...startLimitConfig({ hostMinFreeMb: 1500 }), ...o });
const stopped = (id) => ({ id, game: "Overwatch", running: false });
const running = (id, uptimeS = 600) => ({ id, game: "Overwatch", running: true, logVerdict: { uptimeS } });

test("memUsageMb reads docker's units", () => {
  assert.strictEqual(memUsageMb("130.5MiB / 11.68GiB"), 130.5);
  assert.strictEqual(memUsageMb("1.5GiB / 11.68GiB"), 1536);
  assert.strictEqual(memUsageMb("512KiB / 1GiB"), 0.5);
  assert.ok(Number.isNaN(memUsageMb("--")));
});

test("parseHostMem reads free RAM and only no-claim bots", () => {
  const out = [
    "LOGS_END",
    "MEM_START",
    "avail|7483",
    "noclaim-bot-21|130.5MiB / 11.68GiB",
    "twitchbotx2|264.2MiB / 11.68GiB",
    "MEM_END",
  ].join("\n");
  assert.deepStrictEqual(parseHostMem(out), { availableMb: 7483, botMb: { 21: 130.5 } });
  assert.deepStrictEqual(parseHostMem(""), { availableMb: null, botMb: {} });
});

test("config: on by default, floor from hostMinFreeMb, off only when false", () => {
  const c = startLimitConfig({ hostMinFreeMb: 2000 });
  assert.strictEqual(c.enabled, true);
  assert.strictEqual(c.minFreeMb, 2000);
  assert.strictEqual(c.perTick, 3);
  assert.strictEqual(startLimitConfig({ noclaimStartLimit: { enabled: false } }).enabled, false);
  assert.strictEqual(startLimitConfig({ noclaimStartLimit: { perTick: "x" } }).perTick, 3);
});

test("live with plenty of RAM: ramps, lowest id first, perTick at a time", () => {
  const starts = ["47", "13", "30", "41", "51"];
  const r = limitStarts({ starts }, starts.map(stopped), { availableMb: 7000, botMb: {} }, cfg());
  assert.deepStrictEqual(r.go, ["13", "30", "41"]);
  assert.deepStrictEqual(r.wait, ["47", "51"]);
  assert.strictEqual(r.shed, null);
});

test("RAM floor holds the rest until a bot finishes and frees its memory", () => {
  const bots = [running("13"), running("30"), stopped("41"), stopped("42")];
  const mem = { availableMb: 1800, botMb: { 13: 600, 30: 600 } };
  // 1800 free, keep 1500, a bot costs ~600 -> none fit
  let r = limitStarts({ starts: ["41", "42"] }, bots, mem, cfg());
  assert.deepStrictEqual(r.go, []);
  assert.deepStrictEqual(r.wait, ["41", "42"]);
  assert.match(r.reason, /1800 MB free/);
  // bot 13 finished this pass: its 600 MB comes back -> exactly one fits
  r = limitStarts({ starts: ["41", "42"], finished: ["13"] }, bots, mem, cfg());
  assert.deepStrictEqual(r.go, ["41"]);
  assert.deepStrictEqual(r.wait, ["42"]);
});

test("the estimate never trusts an idle bot's low reading", () => {
  const r = limitStarts({ starts: ["2"] }, [stopped("2")], { availableMb: 1800, botMb: { 9: 130 } }, cfg());
  // 300 MB above the floor < 450 MB estimate floor
  assert.deepStrictEqual(r.go, []);
  assert.strictEqual(r.estimateMb, 450);
});

test("maxRunning caps how many run at once", () => {
  const bots = [running("1"), running("2"), stopped("3"), stopped("4")];
  const r = limitStarts({ starts: ["3", "4"] }, bots, { availableMb: 9000, botMb: {} }, cfg({ maxRunning: 3 }));
  assert.deepStrictEqual(r.go, ["3"]);
});

test("unknown RAM still ramps instead of blocking farming", () => {
  const r = limitStarts({ starts: ["1", "2", "3", "4"] }, [], { availableMb: null, botMb: {} }, cfg());
  assert.deepStrictEqual(r.go, ["1", "2", "3"]);
});

test("disabled: every start goes, as before", () => {
  const r = limitStarts({ starts: ["5", "1"] }, [], { availableMb: 100, botMb: {} }, cfg({ enabled: false }));
  assert.deepStrictEqual(r.go, ["1", "5"]);
  assert.deepStrictEqual(r.wait, []);
});

test("nearly out of RAM: parks the bot that started last, never the only one", () => {
  const bots = [running("1", 5000), running("2", 300), running("3", 900)];
  const mem = { availableMb: 400, botMb: { 1: 700, 2: 700, 3: 700 } };
  assert.strictEqual(limitStarts({ starts: [] }, bots, mem, cfg()).shed, "2");
  assert.strictEqual(limitStarts({ starts: [] }, [running("1")], mem, cfg()).shed, null);
  // a stop already happening this pass frees RAM: no extra park
  assert.strictEqual(limitStarts({ starts: [], stops: ["3"] }, bots, mem, cfg()).shed, null);
});
