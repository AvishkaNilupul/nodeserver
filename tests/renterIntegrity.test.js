// The renter / rent-farm integrity check (2026-10-01): the problems the 09-29
// scratch audit found by hand — paid buyers with dead tokens for days, an
// expired renter still farming, wrong-game placements — now page on their own.
const test = require("node:test");
const assert = require("node:assert/strict");
const ri = require("../utils/renterIntegrity");

const NOW = Date.UTC(2026, 9, 1, 12);
const cfg = (users) => ({ TwitchSettings: { TwitchUsers: users } });
const u = (s, games = [], extra = {}) => ({ ClientSecret: s, Login: s, Enabled: true, FavouriteGames: games, ...extra });
const renters = new Map([
  ["H", { _id: "H", username: "operator-selffarm", usernameLower: "operator-selffarm", status: "active" }],
  ["J", { _id: "J", username: "jhonkwiall", status: "active", accessEnd: new Date(NOW + 9e9) }],
  ["W", { _id: "W", username: "wasd", status: "active", accessEnd: new Date(NOW - 9e9), botStoppedAt: new Date(NOW - 9e9) }],
  ["S", { _id: "S", username: "stopped", status: "active", accessEnd: new Date(NOW + 9e9), botStoppedAt: new Date(NOW - 1000) }],
]);
const row = (renter, s, extra = {}) => ({ renter, clientSecret: s, login: s, host: "contabo", configFile: "config_03.json", ...extra });

function run(over = {}) {
  return ri.classify({
    homes: [
      { host: "contabo", file: "config_03.json", running: true, cfg: cfg([u("b1", ["Overwatch"]), u("b2", ["Rust"]), u("j1"), u("w1"), u("dup")]) },
      { host: "contabo", file: "config_05.json", running: true, cfg: cfg([u("dup"), u("lapsed")]) },
      { host: "contabo", file: "config_06.json", running: false, cfg: cfg([u("w2")]) },
    ],
    live: [
      row("H", "b1"),
      row("H", "b2"),
      row("H", "dead", { lastScanStatus: "token_invalid" }),
      row("H", "gone"),
      row("J", "j1"),
      row("W", "w1"),
      row("W", "w2"),
      row("S", "s1"),
      row("J", "dup"),
    ],
    ended: [row("H", "lapsed")],
    renters,
    holderId: "H",
    orders: new Map([["b1", { game: "Overwatch" }], ["b2", { game: "Escape from Tarkov", market: "eldorado", orderId: "o2" }]]),
    now: NOW,
    ...over,
  });
}

test("classify finds each class, and nothing on healthy rows", () => {
  const f = run();
  const byKind = (k) => f.filter((x) => x.kind === k).map((x) => x.login).sort();
  assert.deepEqual(byKind("deadToken"), ["dead"]);
  assert.deepEqual(byKind("notFarming"), ["dead", "gone"], "in no config on its host");
  assert.deepEqual(byKind("farmingPastEnd"), ["lapsed", "w1"], "w2 sits in a STOPPED bot — not farming");
  assert.deepEqual(byKind("double"), ["dup"]);
  assert.deepEqual(byKind("wrongGame"), ["b2"]);
  assert.ok(!f.some((x) => x.login === "b1" || x.login === "j1"), "healthy rows are silent");
  assert.ok(!f.some((x) => x.login === "s1"), "a renter who pressed Stop is not 'not farming'");
});

test("REGRESSION: a dead token on an expired, suspended or stopped renter's account is not paged (nobody is owed it)", () => {
  const f = run({
    live: [
      row("W", "wdead", { lastScanStatus: "token_invalid" }), // lease over
      row("S", "sdead", { lastScanStatus: "token_invalid" }), // pressed Stop
      row("J", "jdead", { lastScanStatus: "token_invalid", configFile: "config_03.json" }),
    ],
    ended: [],
  });
  const dead = f.filter((x) => x.kind === "deadToken").map((x) => x.login);
  assert.deepEqual(dead, ["jdead"], "only the active, farming renter's");
});

test("an entry in a RENTAL STACK with no ledger row at all is an orphan; operator configs are not judged", () => {
  const f = run({
    homes: [
      { host: "contabo", file: "config_03.json", running: true, cfg: cfg([u("b1", ["Overwatch"]), u("stray")]) },
      { host: "contabo", file: "config_40.json", running: true, cfg: cfg([u("operatorOwn")]) }, // not a stack
    ],
    live: [row("H", "b1")],
    ended: [],
    known: new Set(["b1"]),
    stackKeys: new Set(["contabo/config_03.json"]),
  });
  assert.deepEqual(f.filter((x) => x.kind === "orphan").map((x) => x.login), ["stray"]);
});

test("an unreadable rental stack is a finding of its own", () => {
  const f = run({ homes: [], live: [], ended: [], unreadableStacks: ["contabo/config_07.json"] });
  assert.deepEqual(f.map((x) => x.id), ["unreadable:contabo/config_07.json"]);
});

test("a window that already lapsed is renterExpiry's business, not a finding", () => {
  const f = run({ live: [row("H", "old", { farmUntil: new Date(NOW - 1000), lastScanStatus: "token_invalid" })], ended: [] });
  assert.deepEqual(f, []);
});

test("checkOnce pages a finding only when seen twice, then daily, then says all clear", async () => {
  ri._reset();
  const sent = [];
  let clock = NOW;
  let live = [row("H", "dead", { lastScanStatus: "token_invalid", configFile: "config_03.json" })];
  const fakeHosts = {
    resolveHost: (id) => ({ id }),
    readdir: async () => ["config_03.json"],
    readFiles: async () => ({ "config_03.json": { ok: true, text: JSON.stringify(cfg([u("dead", ["Overwatch"])])) } }),
    dockerPs: async () => ({ twitchbotx3: { state: "running" } }),
  };
  const model = (rows) => ({ find: () => ({ lean: async () => rows() }) });
  ri.__setDeps({
    now: () => clock,
    hosts: () => fakeHosts,
    listStacks: async () => [{ host: "contabo", file: "config_03.json" }],
    RenterAccount: () => ({
      find: (q) => ({ lean: async () => (q.farmEndedAt === null ? live : []) }),
      distinct: async () => live.map((x) => x.clientSecret),
    }),
    Renter: () => model(() => [...renters.values()]),
    FarmServiceOrder: () => model(() => [{ orderId: "e328ee9d-1", market: "eldorado", buyerUsername: "JumpyPage", game: "Overwatch", accounts: [{ login: "dead" }] }]),
    sendTelegram: async (m) => sent.push(m),
    logEvent: () => {},
  });
  let r = await ri.checkOnce({ force: true });
  assert.equal(r.findings.length, 1);
  assert.equal(sent.length, 0, "first sighting is not paged (could be a race)");
  clock += 60 * 60000;
  r = await ri.checkOnce();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /dead token: dead — eldorado order e328ee9d \(JumpyPage\)/);
  clock += 60 * 60000;
  await ri.checkOnce();
  assert.equal(sent.length, 1, "not every hour");
  clock += 24 * 60 * 60000;
  await ri.checkOnce();
  assert.equal(sent.length, 2, "daily reminder");
  live = [row("H", "dead", { configFile: "config_03.json" })]; // token fixed
  clock += 60 * 60000;
  await ri.checkOnce();
  assert.match(sent[2], /no problems left/);
  ri._reset();
});

test("checkOnce runs at most hourly unless forced", async () => {
  ri._reset();
  let n = 0;
  ri.__setDeps({
    now: () => NOW,
    hosts: () => ({ resolveHost: () => null }),
    listStacks: async () => { n++; return []; },
    RenterAccount: () => ({ find: () => ({ lean: async () => [] }), distinct: async () => [] }),
    Renter: () => ({ find: () => ({ lean: async () => [] }) }),
    FarmServiceOrder: () => ({ find: () => ({ lean: async () => [] }) }),
    sendTelegram: async () => {},
    logEvent: () => {},
  });
  await ri.checkOnce();
  await ri.checkOnce();
  assert.equal(n, 1);
  ri._reset();
});

// ---- review 5 (2026-10-01) ----------------------------------------------
function harness({ readFails = () => false, live = () => [], known = () => null, sent }) {
  let clock = NOW;
  ri._reset();
  ri.__setDeps({
    now: () => clock,
    hosts: () => ({
      resolveHost: (id) => ({ id }),
      readdir: async () => {
        if (readFails()) throw Object.assign(new Error("ssh: timed out"), { unreachable: true });
        return ["config_03.json"];
      },
      readFiles: async () => ({ "config_03.json": { ok: true, text: JSON.stringify(cfg([u("dead", ["Overwatch"])])) } }),
      dockerPs: async () => ({ twitchbotx3: { state: "running" } }),
    }),
    listStacks: async () => [{ host: "contabo", file: "config_03.json" }],
    RenterAccount: () => ({
      find: (q) => ({ lean: async () => (q.farmEndedAt === null ? live() : []) }),
      distinct: async () => (known() === null ? Promise.reject(new Error("db")) : known()),
    }),
    Renter: () => ({ find: () => ({ lean: async () => [...renters.values()] }) }),
    FarmServiceOrder: () => ({ find: () => ({ lean: async () => [] }) }),
    sendTelegram: async (m) => sent.push(m),
    logEvent: () => {},
  });
  return { tick: async () => { clock += 60 * 60000; return ri.checkOnce({ force: true }); } };
}

test("REGRESSION: a host that cannot be read keeps the latches and never says 'all clear'", async () => {
  const sent = [];
  let down = false;
  const liveRows = [row("H", "dead", { lastScanStatus: "token_invalid", configFile: "config_03.json" })];
  const h = harness({ readFails: () => down, live: () => liveRows, known: () => ["dead"], sent });
  await h.tick();
  await h.tick();
  assert.equal(sent.length, 1, "paged on the second sighting");
  down = true;
  const r = await h.tick();
  assert.equal(r.partial, true);
  assert.ok(!sent.some((m) => /no problems left/.test(m)), "no false all-clear");
  down = false;
  await h.tick();
  assert.equal(sent.length, 1, "back up: the daily latch still holds (no re-page 2 h later)");
  ri._reset();
});

test("REGRESSION: a finding seen once and never paged is followed by no 'all clear'", async () => {
  const sent = [];
  let liveRows = [row("H", "dead", { lastScanStatus: "token_invalid", configFile: "config_03.json" })];
  const h = harness({ live: () => liveRows, known: () => ["dead"], sent });
  await h.tick(); // seen once, not paged
  liveRows = [row("H", "dead", { configFile: "config_03.json" })];
  await h.tick();
  assert.equal(sent.length, 0, "nothing was paged, so nothing is 'cleared'");
  ri._reset();
});

test("REGRESSION: the same orphan token twice (two stacks) is ONE finding — the seen-twice wait holds", () => {
  const f = ri.classify({
    homes: [
      { host: "contabo", file: "config_03.json", running: true, cfg: cfg([u("stray")]) },
      { host: "contabo", file: "config_05.json", running: true, cfg: cfg([u("stray")]) },
    ],
    live: [], ended: [], renters, holderId: "H", orders: new Map(), now: NOW,
    known: new Set(), stackKeys: new Set(["contabo/config_03.json", "contabo/config_05.json"]),
  });
  assert.equal(f.filter((x) => x.kind === "orphan").length, 1);
});
