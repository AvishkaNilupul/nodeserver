// The no-claim bot organizer's plan: pure functions only (no host, no DB).
const test = require("node:test");
const assert = require("node:assert");
const { planGame, planFleet, config, botCap } = require("../utils/noclaimOrganizer");

let seq = 0;
const acct = (on = true) => ({ Login: "a" + ++seq, Id: String(seq), ClientSecret: "s" + seq, Enabled: on });
const bot = (id, n, { off = 0, running = false } = {}) => ({
  id: String(id),
  running,
  users: Array.from({ length: n }, () => acct(true)).concat(Array.from({ length: off }, () => acct(false))),
});

// Apply a plan to the bots in memory and return { id: [secrets] }.
function applied(bots, plan) {
  const out = {};
  for (const b of bots) out[b.id] = b.users.filter((u) => u.Enabled !== false).map((u) => u.ClientSecret);
  for (const id of Object.keys(plan.quotas)) if (!out[id]) out[id] = [];
  for (const m of plan.moves) {
    out[m.from] = out[m.from].filter((s) => s !== m.secret);
    out[m.to].push(m.secret);
  }
  return out;
}

test("a tidy game is left alone", () => {
  const p = planGame({ key: "ow", label: "Overwatch", bots: [bot(1, 50), bot(2, 48), bot(3, 12)], size: 50 });
  assert.strictEqual(p.due, false);
  assert.deepStrictEqual(p.moves, []);
});

test("bots over the size are split evenly and a new bot is built", () => {
  const bots = [bot(1, 70), bot(2, 70), bot(3, 60)];
  const p = planGame({ key: "ow", label: "Overwatch", bots, size: 50 });
  assert.strictEqual(p.due, true);
  assert.strictEqual(p.needBots, 4);
  assert.strictEqual(p.create, 1);
  const after = applied(bots, p);
  const sizes = Object.values(after).map((a) => a.length).sort();
  assert.deepStrictEqual(sizes, [50, 50, 50, 50]);
  assert.strictEqual(p.moves.length, 50);
});

test("small bots are merged and the empty ones retired", () => {
  const bots = [bot(5, 1), bot(13, 70), bot(25, 11), bot(27, 2), bot(30, 40)];
  const p = planGame({ key: "ow", label: "Overwatch", bots, size: 50 });
  // 124 accounts -> 3 bots of 41/41/42
  assert.strictEqual(p.needBots, 3);
  assert.deepStrictEqual(p.keep.sort(), ["13", "25", "30"]);
  assert.deepStrictEqual(p.retire.sort(), ["27", "5"]);
  assert.strictEqual(p.create, 0);
  const after = applied(bots, p);
  assert.deepStrictEqual(after["5"], []);
  assert.deepStrictEqual(after["27"], []);
  for (const id of p.keep) assert.ok(after[id].length >= 41 && after[id].length <= 42, id + " " + after[id].length);
});

test("every account ends in exactly one bot, none lost", () => {
  const bots = [bot(1, 70), bot(2, 3), bot(3, 69), bot(4, 1), bot(5, 55), bot(6, 0)];
  const before = bots.flatMap((b) => b.users.map((u) => u.ClientSecret)).sort();
  const p = planGame({ key: "g", label: "G", bots, size: 50 });
  const after = Object.values(applied(bots, p)).flat().sort();
  assert.deepStrictEqual(after, before);
  assert.strictEqual(new Set(after).size, after.length);
  for (const [id, list] of Object.entries(applied(bots, p))) assert.ok(list.length <= 50, id);
});

test("disabled entries never move and never count", () => {
  const bots = [bot(25, 6, { off: 5 }), bot(13, 70)];
  const p = planGame({ key: "ow", label: "Overwatch", bots, size: 50 });
  assert.strictEqual(p.accounts, 76);
  assert.strictEqual(p.needBots, 2);
  const moved = new Set(p.moves.map((m) => m.secret));
  for (const u of bots[0].users.filter((u) => !u.Enabled)) assert.ok(!moved.has(u.ClientSecret));
});

test("a bot with only switched-off entries is parked, not retired", () => {
  const bots = [bot(25, 0, { off: 4 }), bot(13, 40)];
  const p = planGame({ key: "ow", label: "Overwatch", bots, size: 50 });
  assert.strictEqual(p.due, true);
  assert.deepStrictEqual(p.park, ["25"]);
  assert.deepStrictEqual(p.retire, []);
  assert.strictEqual(p.moves.length, 0);
});

test("the fullest bots are kept, so the fewest accounts move", () => {
  const bots = [bot(1, 30), bot(2, 30), bot(3, 10)];
  const p = planGame({ key: "g", label: "G", bots, size: 50 });
  assert.strictEqual(p.needBots, 2);
  assert.deepStrictEqual(p.keep, ["1", "2"]);
  assert.strictEqual(p.moves.length, 10);
  assert.ok(p.moves.every((m) => m.from === "3"));
});

test("merging waits until it saves a whole container (minSaveBots)", () => {
  const bots = [bot(1, 30), bot(2, 30), bot(3, 30)]; // 90 -> needs 2
  assert.strictEqual(planGame({ key: "g", label: "G", bots, size: 50, minSaveBots: 2 }).due, false);
  assert.strictEqual(planGame({ key: "g", label: "G", bots, size: 50, minSaveBots: 1 }).due, true);
});

test("planFleet skips personal, operator-stopped and container-less bots", () => {
  const snap = {
    bots: [
      { ...bot(36, 1), label: "Overwatch", personal: true, container: true },
      { ...bot(10, 10), label: "Call of Duty", operatorOff: true, container: true },
      { ...bot(13, 70), label: "Overwatch", container: true },
      { ...bot(14, 70), label: "overwatch", container: true },
      { ...bot(99, 5), label: "Overwatch", container: false },
    ],
  };
  const { games, skipped } = planFleet(snap, config({ noclaimOrganize: { size: 50 } }));
  assert.strictEqual(games.length, 1);
  assert.strictEqual(games[0].accounts, 140);
  assert.strictEqual(games[0].needBots, 3);
  assert.deepStrictEqual(skipped.map((s) => s.id), ["99"]);
});

test("allowRunning off holds a game whose bots are running", () => {
  const snap = { bots: [{ ...bot(17, 70, { running: true }), label: "Rainbow Six Siege", container: true }] };
  const { games } = planFleet(snap, config({ noclaimOrganize: { size: 50, allowRunning: false } }));
  assert.strictEqual(games[0].due, true);
  assert.match(games[0].held, /running/);
});

test("config clamps the size and botCap follows the switch", () => {
  assert.strictEqual(config({ noclaimOrganize: { size: 5 } }).size, 10);
  assert.strictEqual(config({ noclaimOrganize: { size: 500 } }).size, 70);
  assert.strictEqual(config({}).enabled, false);
  assert.strictEqual(botCap({ noclaimOrganize: { enabled: true, size: 50 } }), 50);
  assert.strictEqual(botCap({ noclaimOrganize: { enabled: false, size: 50 } }), 70);
});
