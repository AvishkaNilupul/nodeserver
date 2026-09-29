// farmControl.stopFarmingGame: stop farming a sold game on one account.
//
// WHY THESE TESTS EXIST (2026-09-29)
// Parked bots on contabo (twitchbotx8/x19/x11/x10/x13/x51) were started about
// twice a day for a week and parked again by the next tick — 84 parks, only 2
// wakes on record. The starter was this module: disabling an account leaves its
// own FavouriteGames EMPTY ("inherit the config list"), so every later scan of
// that sold account re-derived the inherited list, "removed" the same game
// again, rewrote an identical config and ran `docker restart` — which STARTS a
// stopped container. The in-process memo hid it until the server restarted,
// i.e. about daily. The prod state is reproduced exactly below.
const test = require("node:test");
const assert = require("node:assert/strict");

const hosts = require("../utils/botHosts");
const AuditFinding = require("../models/AuditFinding");

const HOST = { id: "contabo", transport: "ssh", dir: "/home/ubuntu/twitchbot" };

// In-memory host: one config file, one container state, every call recorded.
function fakeHost({ config, state = "exited", psError = null }) {
  const calls = { writes: [], docker: [], ps: 0 };
  let text = JSON.stringify(config, null, 2);
  const orig = {};
  const stub = {
    resolveHost: (id) => (id === HOST.id ? HOST : null),
    readFile: async () => text,
    saveSnapshot: async () => {},
    writeFileAtomic: async (_h, file, t) => {
      calls.writes.push(file);
      text = t;
    },
    dockerPs: async () => {
      calls.ps++;
      if (psError) throw psError;
      return { twitchbotx19: { state, status: state === "running" ? "Up 2 hours" : "Exited (143) 3 hours ago" } };
    },
    dockerContainer: async (_h, action, container) => {
      calls.docker.push(action + " " + container);
      return "";
    },
  };
  for (const k of Object.keys(stub)) {
    orig[k] = hosts[k];
    hosts[k] = stub[k];
  }
  return {
    calls,
    config: () => JSON.parse(text),
    restore() {
      for (const k of Object.keys(orig)) hosts[k] = orig[k];
    },
  };
}

// A fresh module = a fresh `handled` memo = what a server restart does.
function freshFarmControl() {
  delete require.cache[require.resolve("../utils/farmControl")];
  return require("../utils/farmControl");
}

const findings = [];
const origCreate = AuditFinding.create;
test.before(() => {
  AuditFinding.create = async (doc) => {
    findings.push(doc);
    return doc;
  };
});
test.after(() => {
  AuditFinding.create = origCreate;
});
test.beforeEach(() => {
  findings.length = 0;
});

const ACC = {
  _id: "a1",
  login: "ivhlj785py",
  clientSecret: "secret-ivhlj785py",
  host: "contabo",
  configFile: "config_19.json",
  container: "twitchbotx19",
};

function config19(entry) {
  return {
    FavouriteGames: ["Sea of Thieves"],
    TwitchSettings: {
      TwitchUsers: [
        { Login: "other", ClientSecret: "secret-other", Enabled: true, FavouriteGames: [] },
        { Login: ACC.login, ClientSecret: ACC.clientSecret, ...entry },
      ],
    },
  };
}

test("an already-disabled sold account is left alone: no write, no restart", async () => {
  // Exactly contabo config_19.json on 2026-09-29.
  const h = fakeHost({ config: config19({ Enabled: false, FavouriteGames: [] }) });
  try {
    const { stopFarmingGame } = freshFarmControl();
    const r = await stopFarmingGame(ACC, "Sea of Thieves");
    assert.equal(r.changed, false);
    assert.equal(r.reason, "account already disabled");
    assert.deepEqual(h.calls.writes, []);
    assert.deepEqual(h.calls.docker, []);
    assert.equal(findings.length, 0);
  } finally {
    h.restore();
  }
});

test("the daily repeat is gone: after a server restart the same stop is a no-op", async () => {
  // First stop on a PARKED bot: the account is trimmed (disabled — its only
  // game), the config written, and the stopped container is NOT started.
  const h = fakeHost({
    config: config19({ Enabled: true, FavouriteGames: [] }),
    state: "exited",
  });
  try {
    let fc = freshFarmControl();
    const first = await fc.stopFarmingGame(ACC, "Sea of Thieves");
    assert.equal(first.changed, true);
    assert.deepEqual(h.calls.writes, ["config_19.json"]);
    assert.deepEqual(h.calls.docker, [], "a parked bot must never be started");
    assert.match(first.reason, /twitchbotx19 is exited, left stopped/);
    const me = h.config().TwitchSettings.TwitchUsers[1];
    assert.equal(me.Enabled, false);
    assert.deepEqual(me.FavouriteGames, []);
    assert.equal(h.config().TwitchSettings.TwitchUsers[0].Enabled, true, "siblings untouched");
    assert.match(findings[0].message, /left stopped/);
    assert.doesNotMatch(findings[0].message, /restarted twitchbotx19/);

    // Server restart (memo cleared), the scanner reaches the account again —
    // before the fix this rewrote the config and restarted the container.
    fc = freshFarmControl();
    const again = await fc.stopFarmingGame(ACC, "Sea of Thieves");
    assert.equal(again.changed, false);
    assert.deepEqual(h.calls.writes, ["config_19.json"], "no second write");
    assert.deepEqual(h.calls.docker, [], "no restart");
  } finally {
    h.restore();
  }
});

test("a RUNNING bot is still restarted once so it drops the sold game", async () => {
  const h = fakeHost({
    config: config19({ Enabled: true, FavouriteGames: [] }),
    state: "running",
  });
  try {
    const { stopFarmingGame } = freshFarmControl();
    const r = await stopFarmingGame(ACC, "Sea of Thieves");
    assert.equal(r.changed, true);
    assert.equal(r.reason, "");
    assert.deepEqual(h.calls.docker, ["restart twitchbotx19"]);
    assert.match(findings[0].message, /restarted twitchbotx19\.$/);
  } finally {
    h.restore();
  }
});

test("a multi-game account keeps its other games and converges to a no-op", async () => {
  const h = fakeHost({
    config: config19({ Enabled: true, FavouriteGames: ["Sea of Thieves", "Rust"] }),
    state: "running",
  });
  try {
    let fc = freshFarmControl();
    const r = await fc.stopFarmingGame(ACC, "sea of thieves");
    assert.equal(r.changed, true);
    const me = h.config().TwitchSettings.TwitchUsers[1];
    assert.deepEqual(me.FavouriteGames, ["Rust"]);
    assert.equal(me.Enabled, true);
    assert.deepEqual(h.calls.docker, ["restart twitchbotx19"]);

    fc = freshFarmControl();
    const again = await fc.stopFarmingGame(ACC, "Sea of Thieves");
    assert.equal(again.changed, false);
    assert.equal(again.reason, "game not in FavouriteGames");
    assert.deepEqual(h.calls.docker, ["restart twitchbotx19"], "still one restart");
  } finally {
    h.restore();
  }
});

test("an unreadable container state never starts anything", async () => {
  const h = fakeHost({
    config: config19({ Enabled: true, FavouriteGames: [] }),
    psError: new Error("ssh: connect to host timed out"),
  });
  try {
    const { stopFarmingGame } = freshFarmControl();
    const r = await stopFarmingGame(ACC, "Sea of Thieves");
    assert.equal(r.changed, true, "the config edit itself still lands");
    assert.deepEqual(h.calls.docker, []);
    assert.match(r.reason, /twitchbotx19 restart FAILED: ssh: connect to host timed out/);
  } finally {
    h.restore();
  }
});

test("restartIfRunning only restarts a running container", async () => {
  for (const [state, want] of [
    ["running", true],
    ["exited", false],
    ["created", false],
    ["restarting", false],
  ]) {
    const h = fakeHost({ config: config19({ Enabled: true }), state });
    try {
      const { restartIfRunning } = freshFarmControl();
      const r = await restartIfRunning(HOST, "twitchbotx19");
      assert.equal(r.restarted, want, state);
      assert.equal(r.state, state);
      assert.deepEqual(h.calls.docker, want ? ["restart twitchbotx19"] : []);
    } finally {
      h.restore();
    }
  }
  const h = fakeHost({ config: config19({ Enabled: true }) });
  try {
    const { restartIfRunning } = freshFarmControl();
    const r = await restartIfRunning(HOST, "twitchbotx99");
    assert.deepEqual(r, { restarted: false, state: "missing" });
    assert.deepEqual(h.calls.docker, []);
  } finally {
    h.restore();
  }
});
