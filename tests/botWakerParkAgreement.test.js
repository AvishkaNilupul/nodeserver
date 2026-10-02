// The wake and park rules must agree, and a parked bot that something else
// starts must leave a record.
//
// WHY (2026-09-29)
// Contabo's parked bots were started ~twice a day for a week and parked again
// by the next tick, with almost no "woken" events. Two things are pinned here:
//   1. An idle_no_campaign park is woken by EXACTLY the rule its parker uses
//      (a farmable, non-no-claim campaign for one of its games). The old waker
//      took "any live campaign that started in the 48h before the park" — so a
//      sub-only campaign the parker ignores woke the bot and the next tick
//      parked it straight back, while a farmable campaign the catalog found late
//      never woke it at all.
//   2. A parked bot found running that the waker did not start is recorded
//      (AutoFarmEvent + SystemEvent "started"), attributed to the code path
//      that started it when that went through utils/botHosts.
// Real botWaker, stubbed hosts/models — no docker, no Mongo.
const test = require("node:test");
const assert = require("node:assert/strict");

const hosts = require("../utils/botHosts");
const settings = require("../utils/settings");
const farmCompletion = require("../utils/farmCompletion");
const TwitchCampaign = require("../models/TwitchCampaign");
const CampaignLiveState = require("../models/CampaignLiveState");
const CampaignDrops = require("../models/CampaignDrops");
const AutoFarmEvent = require("../models/AutoFarmEvent");
const SystemEvent = require("../models/SystemEvent");

// botWaker destructures botCompletion at load, so stub it before requiring.
let verdict = { total: 31, working: 0, unknown: 0, finished: 0, notStarted: 31, stoppable: false, assignedGames: [] };
farmCompletion.botCompletion = async () => verdict;
const botWaker = require("../utils/botWaker");

const HOST = { id: "contabo", transport: "ssh", dir: "/home/ubuntu/twitchbot" };
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const q = (rows) => ({ lean: async () => rows });

let W; // the current world
function world({ registry = {}, states = {}, configs = {}, campaigns = [], manifests = [] } = {}) {
  W = {
    registry: JSON.parse(JSON.stringify(registry)),
    states,
    configs,
    campaigns,
    manifests,
    docker: [],
    events: [],
    systemEvents: [],
  };
  return W;
}

const saved = {};
function stub(obj, name, fn) {
  saved[name] = saved[name] || [obj, obj[name]];
  obj[name] = fn;
}

test.before(() => {
  stub(hosts, "resolveHost", (id) => (id === HOST.id ? HOST : null));
  stub(hosts, "readMeta", async () => JSON.stringify(W.registry));
  stub(hosts, "writeMeta", async (_n, text) => {
    W.registry = JSON.parse(text);
  });
  stub(hosts, "dockerPs", async () => W.states);
  stub(hosts, "readFile", async (_h, file) => {
    if (!W.configs[file]) throw new Error("ENOENT " + file);
    return JSON.stringify(W.configs[file]);
  });
  stub(hosts, "dockerContainer", async (_h, action, container) => {
    W.docker.push(action + " " + container);
    if (action === "start") W.states[container] = { state: "running", status: "Up 1 second" };
    if (action === "stop") W.states[container] = { state: "exited", status: "Exited (143)" };
    return "";
  });
  stub(hosts, "setRestartPolicy", async () => {});
  stub(hosts, "restoreRestartPolicy", async () => {});
  stub(TwitchCampaign, "find", () => q(W.campaigns));
  stub(CampaignLiveState, "find", () => q([]));
  stub(CampaignDrops, "find", (filter) =>
    q(W.manifests.filter((m) => filter.campaignId.$in.includes(m.campaignId))),
  );
  stub(AutoFarmEvent, "create", async (doc) => {
    W.events.push(doc);
    return doc;
  });
  stub(SystemEvent, "create", async (doc) => {
    W.systemEvents.push(doc);
    return doc;
  });
  stub(settings, "getAutoFarm", () => ({ parkIdleNoCampaignBots: true, noClaimGames: ["overwatch"] }));
  stub(settings, "isNoClaimGame", (g) => String(g || "").toLowerCase().includes("overwatch"));
  stub(settings, "getStreamGate", () => ({ enabled: false, games: {} }));
});

test.after(() => {
  for (const name of Object.keys(saved)) {
    const [obj, fn] = saved[name];
    obj[name] = fn;
  }
});

function sotConfig(game = "Sea of Thieves") {
  return {
    FavouriteGames: [game],
    TwitchSettings: {
      TwitchUsers: [
        { Login: "a", ClientSecret: "s1", Enabled: true, FavouriteGames: [] },
        { Login: "b", ClientSecret: "s2", Enabled: false, FavouriteGames: [] },
      ],
    },
  };
}

const SUB_ONLY = (id) => ({ campaignId: id, watchVersion: 1, drops: [{ requiredSubs: 1, requiredMinutesWatched: 0 }] });
const WATCHABLE = (id) => ({ campaignId: id, watchVersion: 1, drops: [{ requiredSubs: 0, requiredMinutesWatched: 60 }] });

// Park x19 as idle_no_campaign at `parkedAt`, then run one waker pass.
async function wakePass({ parkedAt, campaigns, manifests, game }) {
  world({
    registry: {
      "contabo|twitchbotx19": {
        parkedAt: new Date(parkedAt).toISOString(),
        recordedAt: new Date(parkedAt).toISOString(),
        games: [String(game || "sea of thieves").toLowerCase()],
        accounts: 1,
        reason: botWaker.IDLE_NO_CAMPAIGN_REASON,
      },
    },
    states: { twitchbotx19: { state: "exited", status: "Exited (143) 2 hours ago" } },
    configs: { "config_19.json": sotConfig(game) },
    campaigns,
    manifests,
  });
  const r = await botWaker.wakeFinishedBots("contabo");
  return r.woken.length > 0;
}

// Would the idle-no-campaign parker park x19 if it were running right now?
async function parkerWouldPark() {
  W.states.twitchbotx19 = { state: "running", status: "Up 1 minute" };
  W.registry = {};
  const before = W.docker.length;
  const r = await botWaker.parkIdleNoCampaignBots("contabo");
  const parked = r.parked.some((p) => p.container === "twitchbotx19");
  assert.equal(parked, W.docker.slice(before).includes("stop twitchbotx19"));
  return parked;
}

const now = Date.now();
const PARKED = now - 2 * HOUR;
const SCENARIOS = [
  {
    name: "sub-only campaign that started 1h before the park (the flap)",
    campaigns: [{ campaignId: "sub", game: "Sea of Thieves", name: "SoT Sub Drops", startAt: new Date(PARKED - HOUR) }],
    manifests: [SUB_ONLY("sub")],
    wake: false,
  },
  {
    name: "farmable campaign the catalog found late (started 5 days before the park)",
    campaigns: [{ campaignId: "late", game: "Sea of Thieves", name: "Season 18", startAt: new Date(PARKED - 5 * DAY) }],
    manifests: [WATCHABLE("late")],
    wake: true,
  },
  {
    name: "new farmable campaign after the park",
    campaigns: [{ campaignId: "new", game: "Sea of Thieves", name: "Season 19", startAt: new Date(PARKED + HOUR) }],
    manifests: [WATCHABLE("new")],
    wake: true,
  },
  {
    name: "campaign with no manifest yet (unknown ⇒ farmable, fail toward farming)",
    campaigns: [{ campaignId: "nomani", game: "Sea of Thieves", name: "Mystery", startAt: new Date(PARKED + HOUR) }],
    manifests: [],
    wake: true,
  },
  {
    name: "a campaign for another game only",
    campaigns: [{ campaignId: "rust", game: "Rust", name: "Rust Drops", startAt: new Date(PARKED + HOUR) }],
    manifests: [WATCHABLE("rust")],
    wake: false,
  },
  {
    name: "label drift: config 'naraka' vs campaign 'NARAKA: BLADEPOINT'",
    game: "naraka",
    campaigns: [{ campaignId: "nbpl", game: "NARAKA: BLADEPOINT", name: "NBPL", startAt: new Date(PARKED - 3 * DAY) }],
    manifests: [WATCHABLE("nbpl")],
    wake: true,
  },
  {
    name: "sub-only AND farmable for the same game — the farmable one wakes it",
    campaigns: [
      { campaignId: "sub2", game: "Sea of Thieves", name: "Sub", startAt: new Date(PARKED - HOUR) },
      { campaignId: "ok2", game: "Sea of Thieves", name: "Watch", startAt: new Date(PARKED - 4 * DAY) },
    ],
    manifests: [SUB_ONLY("sub2"), WATCHABLE("ok2")],
    wake: true,
  },
];

for (const s of SCENARIOS) {
  test("idle_no_campaign wake == parker keeps it up: " + s.name, async () => {
    const woke = await wakePass({ parkedAt: PARKED, ...s });
    assert.equal(woke, s.wake, "waker");
    if (woke) {
      assert.ok(W.docker.includes("start twitchbotx19"));
      const ev = W.events.find((e) => e.type === "woken");
      assert.equal(ev.actor, "wakeFinishedBots");
      assert.match(ev.reason, /^campaign to farm: /);
      assert.equal(W.registry["contabo|twitchbotx19"], undefined);
    }
    // The invariant: whatever the waker decides, the parker agrees — a woken
    // bot is kept up, an unwoken one would be parked. No flap either way.
    assert.equal(await parkerWouldPark(), !woke, "parker");
  });
}

test("a no-claim game in a parked bot keeps the old grace rule (never stranded)", async () => {
  // Parked idle_no_campaign, then its config gained a no-claim game: outside
  // the parker's rule, so the waker falls back to the 48h-grace test and still
  // wakes it for that game's campaign, as it did before.
  const woke = await wakePass({
    parkedAt: PARKED,
    game: "Overwatch 2",
    campaigns: [{ campaignId: "ow", game: "Overwatch 2", name: "OWCS", startAt: new Date(PARKED - HOUR) }],
    manifests: [WATCHABLE("ow")],
  });
  assert.equal(woke, true);
});

test("a parked bot started by another code path is recorded with that path", async () => {
  const parkedAt = new Date(now - HOUR).toISOString();
  world({
    registry: {
      "contabo|twitchbotx8": { parkedAt, recordedAt: parkedAt, games: ["the outlast trials"], accounts: 31, reason: botWaker.IDLE_NO_CAMPAIGN_REASON },
    },
    states: { twitchbotx8: { state: "running", status: "Up 4 minutes" } },
    configs: { "config_08.json": sotConfig("The Outlast Trials") },
  });
  const caller = "restartIfRunning (utils/farmControl.js:57) < stopFarmingGame (utils/farmControl.js:138)";
  botWaker.noteContainerStart({ hostId: "contabo", action: "restart", container: "twitchbotx8", caller });

  const r = await botWaker.wakeFinishedBots("contabo");
  assert.deepEqual(r.woken, []);
  assert.deepEqual(r.external, [{ container: "twitchbotx8", by: caller }]);
  assert.deepEqual(W.docker, [], "recording it starts nothing");
  assert.equal(W.registry["contabo|twitchbotx8"], undefined, "no longer parked");

  const ev = W.events.find((e) => e.type === "started");
  assert.equal(ev.actor, caller);
  assert.equal(ev.host, "contabo");
  assert.equal(ev.container, "twitchbotx8");
  assert.equal(ev.game, "the outlast trials");
  assert.match(ev.reason, /not started by the waker; docker restart from restartIfRunning/);
  assert.match(ev.reason, /idle_no_campaign/);
  assert.match(ev.reason, /docker: Up 4 minutes$/);
  // Mirrored into the unified audit log (SystemEvent autofarm/started).
  await new Promise((res) => setImmediate(res));
  const se = W.systemEvents.find((e) => e.action === "started");
  assert.equal(se.category, "autofarm");
  assert.equal(se.actor, caller);
  assert.equal(se.container, "twitchbotx8");
});

test("a start the server did not make (or one before the park) is recorded as external", async () => {
  const parkedAt = new Date(now - HOUR).toISOString();
  for (const note of [null, { at: now - 2 * HOUR }]) {
    world({
      registry: {
        "contabo|twitchbotx11": { parkedAt, recordedAt: parkedAt, games: ["dark and darker"], accounts: 35, reason: botWaker.IDLE_NO_CAMPAIGN_REASON },
      },
      states: { twitchbotx11: { state: "running", status: "Up 9 minutes" } },
      configs: { "config_11.json": sotConfig("Dark and Darker") },
    });
    if (note) {
      // A restart seen BEFORE the park must not be blamed for this start.
      const realNow = Date.now;
      Date.now = () => note.at;
      try {
        botWaker.noteContainerStart({ hostId: "contabo", action: "restart", container: "twitchbotx11", caller: "old (x.js:1)" });
      } finally {
        Date.now = realNow;
      }
    }
    const r = await botWaker.wakeFinishedBots("contabo");
    assert.deepEqual(r.external, [{ container: "twitchbotx11", by: "external" }]);
    const ev = W.events.find((e) => e.type === "started");
    assert.equal(ev.actor, "external");
    assert.match(ev.reason, /no start through this server since the park/);
  }
});

test("a park still in flight is neither reported nor dropped", async () => {
  // Registry written, stop not landed yet (a concurrent Scout nudge pass).
  const recordedAt = new Date(Date.now() - 30e3).toISOString();
  const parkedAt = new Date(Date.now() - 30 * 60e3).toISOString(); // nothing_left backdates
  world({
    registry: {
      "contabo|twitchbotx50": { parkedAt, recordedAt, games: ["the crew: motorfest"], accounts: 55, reason: botWaker.NOTHING_LEFT_REASON },
    },
    states: { twitchbotx50: { state: "running", status: "Up 3 days" } },
    configs: { "config_50.json": sotConfig("The Crew: Motorfest") },
  });
  const r = await botWaker.wakeFinishedBots("contabo");
  assert.deepEqual(r.external, []);
  assert.deepEqual(W.events, []);
  assert.ok(W.registry["contabo|twitchbotx50"], "entry kept — the stop is about to land");
});

test("parkInFlight uses the write time, not a backdated parkedAt", () => {
  const t = Date.parse("2026-09-29T15:00:00Z");
  const iso = (ms) => new Date(ms).toISOString();
  assert.equal(botWaker.parkInFlight({ recordedAt: iso(t - 60e3), parkedAt: iso(t - 30 * 60e3) }, t), true);
  assert.equal(botWaker.parkInFlight({ recordedAt: iso(t - 10 * 60e3) }, t), false);
  assert.equal(botWaker.parkInFlight({ parkedAt: iso(t - 60e3) }, t), true, "old entries fall back to parkedAt");
  assert.equal(botWaker.parkInFlight({}, t), false);
  assert.equal(botWaker.parkInFlight(null, t), false);
});

test("recordParked stamps recordedAt", async () => {
  world({});
  const e = await botWaker.recordParked("contabo", "twitchbotx19", {
    parkedAt: "2026-09-29T14:30:00.000Z",
    games: ["sea of thieves"],
    reason: botWaker.IDLE_NO_CAMPAIGN_REASON,
  });
  assert.equal(e.parkedAt, "2026-09-29T14:30:00.000Z");
  assert.ok(Date.now() - Date.parse(e.recordedAt) < 5000);
  assert.deepEqual(W.registry["contabo|twitchbotx19"], e);
});

// ---------------------------------------------------------------------------
// The registry under concurrency (review of the fix above, 2026-10-03).
// streamScout's nudge runs wake passes while the auto-farm tick parks bots. A
// pass used to write its start-time copy of the registry back at the end,
// erasing parks recorded while it ran — a parked bot with no entry is never
// woken again.
// ---------------------------------------------------------------------------

const iso = (ms) => new Date(ms).toISOString();

test("parks recorded while a wake pass runs survive it; only the entries it read are dropped", async () => {
  const old = iso(now - 3 * HOUR);
  world({
    registry: {
      // Both containers are gone, so the pass drops both entries and writes.
      "contabo|twitchbotx77": { parkedAt: old, recordedAt: old, games: ["rust"], accounts: 5, reason: botWaker.IDLE_NO_CAMPAIGN_REASON },
      "contabo|twitchbotx78": { parkedAt: old, recordedAt: old, games: ["rust"], accounts: 5, reason: botWaker.IDLE_NO_CAMPAIGN_REASON },
    },
    states: {},
  });
  let reached;
  const atDocker = new Promise((r) => (reached = r));
  let release;
  const gate = new Promise((r) => (release = r));
  const ps = hosts.dockerPs;
  hosts.dockerPs = async () => {
    reached();
    await gate;
    return W.states;
  };
  let x78;
  try {
    const pass = botWaker.wakeFinishedBots("contabo");
    await atDocker; // the pass has read the registry and waits on docker
    // Meanwhile the tick parks x8, and parks x78 again (a new entry).
    await botWaker.recordParked("contabo", "twitchbotx8", { games: ["the outlast trials"], accounts: 31, reason: botWaker.IDLE_NO_CAMPAIGN_REASON });
    x78 = await botWaker.recordParked("contabo", "twitchbotx78", { games: ["rust"], accounts: 6, reason: botWaker.NOTHING_LEFT_REASON });
    release();
    await pass;
  } finally {
    hosts.dockerPs = ps;
  }
  assert.ok(W.registry["contabo|twitchbotx8"], "a park recorded mid-pass is kept");
  assert.deepEqual(W.registry["contabo|twitchbotx78"], x78, "a re-park mid-pass keeps its new entry");
  assert.equal(W.registry["contabo|twitchbotx77"], undefined, "the entry the pass was done with is dropped");
});

test("an unreadable registry is never overwritten: the park is refused and the bot stays up", async () => {
  world({
    states: { twitchbotx19: { state: "running", status: "Up 1 hour" } },
    configs: { "config_19.json": sotConfig() },
    campaigns: [],
  });
  const torn = '{\n  "contabo|twitchbotx8": {\n    "parkedAt": "2026-09-';
  const rm = hosts.readMeta;
  const wm = hosts.writeMeta;
  let writes = 0;
  hosts.readMeta = async () => torn;
  hosts.writeMeta = async () => {
    writes++;
  };
  try {
    await assert.rejects(
      botWaker.recordParked("contabo", "twitchbotx19", { reason: botWaker.IDLE_NO_CAMPAIGN_REASON }),
      /unreadable/,
    );
    // The parker treats that as "cannot record" and leaves the bot running.
    const r = await botWaker.parkIdleNoCampaignBots("contabo");
    assert.deepEqual(r.parked, []);
    assert.deepEqual(W.docker, [], "no stop — fail toward farming");
    // A JSON array would silently lose the new entry on write: refused too.
    hosts.readMeta = async () => "[]";
    await assert.rejects(
      botWaker.recordParked("contabo", "twitchbotx19", { reason: botWaker.IDLE_NO_CAMPAIGN_REASON }),
      /holds no object/,
    );
    assert.equal(writes, 0, "the file is left for a human, not replaced by one entry");
    // A missing or empty registry is just empty — parks are recorded.
    hosts.readMeta = async () => null;
    await botWaker.recordParked("contabo", "twitchbotx19", { reason: botWaker.IDLE_NO_CAMPAIGN_REASON });
    assert.equal(writes, 1);
  } finally {
    hosts.readMeta = rm;
    hosts.writeMeta = wm;
  }
});

test("two wake passes at once start a parked bot once and blame nobody", async () => {
  world({
    registry: {
      "contabo|twitchbotx19": { parkedAt: iso(PARKED), recordedAt: iso(PARKED), games: ["sea of thieves"], accounts: 1, reason: botWaker.IDLE_NO_CAMPAIGN_REASON },
    },
    states: { twitchbotx19: { state: "exited", status: "Exited (143) 2 hours ago" } },
    configs: { "config_19.json": sotConfig() },
    campaigns: [{ campaignId: "new", game: "Sea of Thieves", name: "Season 19", startAt: new Date(PARKED + HOUR) }],
    manifests: [WATCHABLE("new")],
  });
  // The tick's pass and streamScout's nudge, at the same moment.
  const [a, b] = await Promise.all([
    botWaker.wakeFinishedBots("contabo"),
    botWaker.wakeFinishedBots("contabo"),
  ]);
  assert.deepEqual(W.docker, ["start twitchbotx19"]);
  assert.equal(a.woken.length + b.woken.length, 1);
  assert.equal(W.events.filter((e) => e.type === "woken").length, 1);
  assert.equal(W.events.filter((e) => e.type === "started").length, 0, "the waker's own start is not a stranger's");
  assert.equal(W.registry["contabo|twitchbotx19"], undefined);
});

test("a park whose stop never landed is dropped quietly, not recorded as a start", async () => {
  // The parker recorded the park, then `docker stop` failed ("Could not stop").
  const recordedAt = iso(Date.now() - 20 * 60e3);
  const parkedAt = iso(Date.now() - 50 * 60e3); // nothing_left backdates parkedAt
  world({
    registry: {
      "contabo|twitchbotx50": { parkedAt, recordedAt, games: ["the crew: motorfest"], accounts: 55, reason: botWaker.NOTHING_LEFT_REASON },
    },
    states: { twitchbotx50: { state: "running", status: "Up 3 days" } },
    configs: { "config_50.json": sotConfig("The Crew: Motorfest") },
  });
  const r = await botWaker.wakeFinishedBots("contabo");
  assert.deepEqual(r.external, []);
  assert.deepEqual(W.events, []);
  assert.deepEqual(W.docker, []);
  assert.equal(W.registry["contabo|twitchbotx50"], undefined, "it is not parked, so the entry goes");
});

test("a restart-if-running that arrives mid-park waits for the stop and leaves the bot parked", async () => {
  // The drop scanner (farmControl.restartIfRunning) and the auto-farm tick's
  // parker run in one process. docker as it behaves: `docker stop` takes a
  // while and the container reads "running" until it exits; a `docker restart`
  // that arrives meanwhile joins the stop and then STARTS the container.
  const farmControl = require("../utils/farmControl");
  world({
    states: { twitchbotx19: { state: "running", status: "Up 3 hours" } },
    configs: { "config_19.json": sotConfig() },
    campaigns: [],
  });
  let stopping = false;
  let startAfterStop = false;
  let stopBegun;
  const begun = new Promise((r) => (stopBegun = r));
  let finishStop;
  const stopGate = new Promise((r) => (finishStop = r));
  const dc = hosts.dockerContainer;
  const rs = hosts.runShell;
  hosts.dockerContainer = async (_h, action, container) => {
    W.docker.push(action + " " + container);
    if (action === "stop") {
      stopping = true;
      stopBegun();
      await stopGate;
      stopping = false;
      W.states[container] = startAfterStop
        ? { state: "running", status: "Up 1 second" }
        : { state: "exited", status: "Exited (143) 1 second ago" };
    } else if (action === "restart") {
      if (stopping) startAfterStop = true;
      else W.states[container] = { state: "running", status: "Up 1 second" };
    }
    return "";
  };
  hosts.runShell = async (_h, script) => {
    const c = /docker restart '([^']+)'/.exec(script)[1];
    const st = W.states[c];
    if (!st || st.state !== "running") return { stdout: "STATE " + (st ? st.state : "missing") + "\n" };
    W.docker.push("restart " + c);
    if (stopping) startAfterStop = true;
    return { stdout: "RESTARTED\n" };
  };
  try {
    const parking = botWaker.parkIdleNoCampaignBots("contabo");
    await begun; // the park's `docker stop` is in flight
    const restart = farmControl.restartIfRunning(HOST, "twitchbotx19");
    await new Promise((r) => setImmediate(r));
    finishStop();
    const p = await parking;
    const r = await restart;
    assert.deepEqual(p.parked.map((x) => x.container), ["twitchbotx19"]);
    assert.deepEqual(r, { restarted: false, state: "exited" });
    assert.equal(W.states.twitchbotx19.state, "exited", "the bot stays parked");
    assert.deepEqual(W.docker, ["stop twitchbotx19"]);
  } finally {
    hosts.dockerContainer = dc;
    hosts.runShell = rs;
  }
});

test("upForMs reads docker's uptime as a lower bound", () => {
  const MIN = 60e3;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const cases = [
    ["Up Less than a second", 0],
    ["Up 1 second", 1000],
    ["Up 45 seconds", 45000],
    ["Up About a minute", MIN],
    ["Up 5 minutes", 5 * MIN],
    ["Up About an hour (healthy)", HOUR],
    ["Up 2 hours", 1.5 * HOUR],
    ["Up 3 days", 3 * DAY - HOUR / 2],
    ["Up 3 weeks (unhealthy)", 21 * DAY - HOUR / 2],
    ["Up 2 months", 60 * DAY - HOUR / 2],
    ["Up 1 year", 365 * DAY],
    ["Exited (143) 2 hours ago", null],
    ["Created", null],
    ["", null],
    [undefined, null],
  ];
  for (const [status, want] of cases) {
    assert.equal(botWaker.upForMs(status), want, String(status));
  }
});
