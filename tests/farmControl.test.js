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

// In-memory host: one config file, one container (twitchbotx19) whose docker
// state every docker path shares — `docker ps` + a separate `docker restart`
// (the old two-call restartIfRunning), and runShell running the one-command
// check-and-restart atomically — with every call recorded. `parkAfterFirstTrip`
// lands the auto-farm tick's park (`docker stop`) right after the first docker
// round trip, i.e. between a `docker ps` and a separate `docker restart`.
function fakeHost({ config, state = "exited", psError = null, parkAfterFirstTrip = false }) {
  const calls = { writes: [], docker: [], ps: 0, shell: 0, policy: [], timeline: [], restartedStopped: 0 };
  let text = JSON.stringify(config, null, 2);
  let st = state; // "missing" = no such container
  let trips = 0;
  const trip = () => {
    trips++;
    if (parkAfterFirstTrip && trips === 1 && st === "running") {
      st = "exited";
      calls.timeline.push("park");
    }
  };
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
      const snap =
        st === "missing"
          ? {}
          : { twitchbotx19: { state: st, status: st === "running" ? "Up 2 hours" : "Exited (143) 3 hours ago" } };
      trip();
      return snap;
    },
    dockerContainer: async (_h, action, container) => {
      calls.docker.push(action + " " + container);
      if (action === "restart" && container === "twitchbotx19") {
        // `docker restart` STARTS a stopped container.
        if (st !== "running") calls.restartedStopped++;
        if (st !== "missing") st = "running";
        calls.timeline.push("restart");
      }
      trip();
      return "";
    },
    runShell: async (_h, script) => {
      calls.shell++;
      if (psError) throw psError;
      const m = /docker restart '([^']+)'/.exec(script);
      const c = m && m[1];
      const cur = c === "twitchbotx19" ? st : "missing";
      let stdout;
      if (cur === "running") {
        calls.docker.push("restart " + c);
        calls.timeline.push("restart");
        stdout = "RESTARTED\n";
      } else {
        stdout = "STATE " + cur + "\n";
      }
      trip();
      return { stdout, stderr: "" };
    },
    restoreRestartPolicy: async (_h, c) => {
      calls.policy.push(c);
      calls.timeline.push("policy");
    },
  };
  for (const k of Object.keys(stub)) {
    orig[k] = hosts[k];
    hosts[k] = stub[k];
  }
  return {
    calls,
    config: () => JSON.parse(text),
    state: () => st,
    setState: (s) => {
      st = s;
    },
    setPsError: (e) => {
      psError = e;
    },
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
const findingUpdates = [];
const starts = []; // what botHosts' start observers hear
hosts.onContainerStart((info) => starts.push(info));
const origCreate = AuditFinding.create;
const origUpdateOne = AuditFinding.updateOne;
test.before(() => {
  AuditFinding.create = async (doc) => {
    const d = { _id: "finding-" + findings.length, ...doc };
    findings.push(d);
    return d;
  };
  AuditFinding.updateOne = async (filter, update) => {
    findingUpdates.push({ filter, update });
    return { modifiedCount: 1 };
  };
});
test.after(() => {
  AuditFinding.create = origCreate;
  AuditFinding.updateOne = origUpdateOne;
});
test.beforeEach(() => {
  findings.length = 0;
  findingUpdates.length = 0;
  starts.length = 0;
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

// ---------------------------------------------------------------------------
// One shell command, under the container's lock (2026-10-03 review).
// restartIfRunning read `docker ps`, then sent `docker restart` in a second SSH
// call; a park whose stop landed in that round trip was undone, because
// `docker restart` STARTS a stopped container.
// ---------------------------------------------------------------------------

test("a park landing between the check and the restart is never undone (no ps-then-restart)", async () => {
  const h = fakeHost({ config: config19({ Enabled: true }), state: "running", parkAfterFirstTrip: true });
  try {
    const { restartIfRunning } = freshFarmControl();
    await restartIfRunning(HOST, "twitchbotx19");
    assert.equal(h.calls.restartedStopped, 0, "a just-parked (stopped) container was restarted");
    assert.equal(h.state(), "exited", "the park holds");
    assert.equal(h.calls.ps, 0, "no separate docker ps");
    assert.equal(h.calls.shell, 1, "check and restart are one command");
  } finally {
    h.restore();
  }
});

test("a park still in flight holds the container's lock: restartIfRunning waits it out", async () => {
  const h = fakeHost({ config: config19({ Enabled: true }), state: "running" });
  try {
    const { restartIfRunning } = freshFarmControl();
    let release;
    const gate = new Promise((r) => (release = r));
    // botWaker's park: policy "no", then `docker stop` — the bot still reads
    // "running" until it exits.
    const park = hosts.withContainerLock(HOST, "twitchbotx19", async () => {
      await gate;
      h.setState("exited");
    });
    const pending = restartIfRunning(HOST, "twitchbotx19");
    await new Promise((r) => setImmediate(r));
    assert.equal(h.calls.shell + h.calls.ps + h.calls.docker.length, 0, "no docker step while the park runs");
    release();
    await park;
    assert.deepEqual(await pending, { restarted: false, state: "exited" });
    assert.equal(h.state(), "exited");
  } finally {
    h.restore();
  }
});

test("restartIfRunning never reports a start: it only ever restarts a RUNNING container", async () => {
  // Round-2 review: reporting its reload as a start made botWaker blame the
  // drop scanner for a parked bot the operator had started by hand.
  for (const state of ["running", "exited"]) {
    starts.length = 0;
    const h = fakeHost({ config: config19({ Enabled: true }), state });
    try {
      const { restartIfRunning } = freshFarmControl();
      const r = await restartIfRunning(HOST, "twitchbotx19");
      assert.equal(r.restarted, state === "running");
    } finally {
      h.restore();
    }
    assert.deepEqual(starts, [], state);
  }
});

test("restorePolicy restores the restart policy only after a real restart", async () => {
  for (const [state, want] of [
    ["running", ["twitchbotx19"]],
    ["exited", []],
    ["missing", []],
  ]) {
    const h = fakeHost({ config: config19({ Enabled: true }), state });
    try {
      const { restartIfRunning } = freshFarmControl();
      await restartIfRunning(HOST, "twitchbotx19", { restorePolicy: true });
      assert.deepEqual(h.calls.policy, want, state);
      if (want.length) assert.deepEqual(h.calls.timeline, ["restart", "policy"]);
    } finally {
      h.restore();
    }
  }
  for (const [opts, psError] of [[{}, null], [{ restorePolicy: true }, new Error("ssh: timed out")]]) {
    const h = fakeHost({ config: config19({ Enabled: true }), state: "running", psError });
    try {
      const { restartIfRunning } = freshFarmControl();
      await restartIfRunning(HOST, "twitchbotx19", opts).catch(() => {});
      assert.deepEqual(h.calls.policy, [], "no option, or a failed check: policy untouched");
    } finally {
      h.restore();
    }
  }
});

test("the real shell command restarts only a running container, quoting the name", async () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "farmcontrol-docker-"));
  const log = path.join(dir, "calls.log");
  fs.writeFileSync(
    path.join(dir, "docker"),
    [
      "#!/bin/sh",
      'echo "$*" >> "$FAKE_DOCKER_LOG"',
      'case "$1:$FAKE_DOCKER_STATE" in',
      '  inspect:) echo "Error: No such object: $4" >&2; exit 1;;',
      '  inspect:DAEMON) echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2; exit 1;;',
      '  inspect:PERM) echo "permission denied while trying to connect to the Docker daemon socket" >&2; exit 1;;',
      '  inspect:*) echo "$FAKE_DOCKER_STATE";;',
      '  restart:*) [ "$FAKE_DOCKER_FAIL" = 1 ] && { echo "Error response from daemon: boom" >&2; exit 1; }; echo "$2";;',
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const env = ["PATH", "FAKE_DOCKER_LOG", "FAKE_DOCKER_STATE", "FAKE_DOCKER_FAIL"];
  const saved = Object.fromEntries(env.map((k) => [k, process.env[k]]));
  process.env.PATH = dir + path.delimiter + process.env.PATH;
  process.env.FAKE_DOCKER_LOG = log;
  const LOCAL = { id: "local-test", transport: "local", runtime: "docker", dir };
  try {
    const { restartIfRunning } = freshFarmControl();
    for (const [state, want] of [
      ["running", { restarted: true, state: "running" }],
      ["exited", { restarted: false, state: "exited" }],
      ["paused", { restarted: false, state: "paused" }],
      ["restarting", { restarted: false, state: "restarting" }],
      ["", { restarted: false, state: "missing" }],
    ]) {
      fs.writeFileSync(log, "");
      process.env.FAKE_DOCKER_STATE = state;
      assert.deepEqual(await restartIfRunning(LOCAL, "twitchbotx19"), want, state || "missing");
      const calls = fs.readFileSync(log, "utf8").trim().split("\n");
      assert.equal(calls[0], "inspect -f {{.State.Status}} twitchbotx19");
      assert.equal(calls.includes("restart twitchbotx19"), want.restarted);
    }
    // A name is one quoted argument, never shell text.
    fs.writeFileSync(log, "");
    process.env.FAKE_DOCKER_STATE = "running";
    await restartIfRunning(LOCAL, "x'; echo pwned >&2 #");
    assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), [
      "inspect -f {{.State.Status}} x'; echo pwned >&2 #",
      "restart x'; echo pwned >&2 #",
    ]);
    // Only "No such object" is a missing container. A daemon that is down or a
    // denied socket is an error the caller sees — never "missing", which
    // stopFarmingGame took as a reload not needed (round-2 review).
    for (const [mode, re] of [["DAEMON", /Cannot connect to the Docker daemon/], ["PERM", /permission denied/]]) {
      fs.writeFileSync(log, "");
      process.env.FAKE_DOCKER_STATE = mode;
      await assert.rejects(restartIfRunning(LOCAL, "twitchbotx19"), re, mode);
      assert.ok(!fs.readFileSync(log, "utf8").includes("restart twitchbotx19"), mode + ": nothing restarted");
    }
    // A failed restart is an error for the caller, not "not running".
    process.env.FAKE_DOCKER_STATE = "running";
    process.env.FAKE_DOCKER_FAIL = "1";
    await assert.rejects(restartIfRunning(LOCAL, "twitchbotx19"), /boom/);
  } finally {
    for (const k of env) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Round-2 review (2026-10-03).
// ---------------------------------------------------------------------------

test("a failed reload is not recorded as done: the next visit retries just the reload", async () => {
  const h = fakeHost({
    config: config19({ Enabled: true, FavouriteGames: [] }),
    state: "running",
    psError: new Error("Cannot connect to the Docker daemon"),
  });
  try {
    const fc = freshFarmControl();
    const first = await fc.stopFarmingGame(ACC, "Sea of Thieves");
    assert.equal(first.changed, true, "the edit itself landed");
    assert.match(first.reason, /twitchbotx19 restart FAILED: Cannot connect to the Docker daemon/);
    assert.equal(findings[0].status, "open", "a failed reload is not a resolved stop");
    assert.match(findings[0].message, /retried on the account's next scan/);

    // The daemon is back; the scanner visits the account again (same process).
    h.setPsError(null);
    const again = await fc.stopFarmingGame(ACC, "Sea of Thieves");
    assert.match(again.reason, /^reload retried: restarted twitchbotx19$/);
    assert.deepEqual(h.calls.docker, ["restart twitchbotx19"], "the bot reloads now");
    assert.deepEqual(h.calls.writes, ["config_19.json"], "no second edit");
    assert.deepEqual(findingUpdates.map((u) => [u.filter._id, u.update.$set.status]), [["finding-0", "resolved"]]);

    const third = await fc.stopFarmingGame(ACC, "Sea of Thieves");
    assert.equal(third.reason, "already done");
  } finally {
    h.restore();
  }
});

test("two stops on one config at once both land (the config's file lock)", async () => {
  const cfg = {
    FavouriteGames: ["Rust", "Sea of Thieves"],
    TwitchSettings: {
      TwitchUsers: [
        { Login: "a", ClientSecret: "sa", Enabled: true },
        { Login: "b", ClientSecret: "sb", Enabled: true },
      ],
    },
  };
  const h = fakeHost({ config: cfg, state: "exited" });
  try {
    const fc = freshFarmControl();
    const acc = (login) => ({ _id: login, login, clientSecret: "s" + login, host: "contabo", configFile: "config_19.json", container: "twitchbotx19" });
    // Two drop-scanner lanes, two sold accounts of one bot, the same moment.
    const [ra, rb] = await Promise.all([fc.stopFarmingGame(acc("a"), "Rust"), fc.stopFarmingGame(acc("b"), "Rust")]);
    assert.equal(ra.changed, true);
    assert.equal(rb.changed, true);
    const users = h.config().TwitchSettings.TwitchUsers;
    assert.deepEqual(users.map((u) => [u.Login, u.FavouriteGames]), [
      ["a", ["Sea of Thieves"]],
      ["b", ["Sea of Thieves"]],
    ]);
  } finally {
    h.restore();
  }
});

test("the remote check-and-restart is cut off inside the SSH budget: no restart after the lock is gone", async () => {
  // An SSH client that gives up leaves its remote command running (no pty).
  // The fake ssh does exactly that; the fake docker answers `inspect` after 3 s
  // with the state it read BEFORE the wait (a slow daemon).
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "farmcontrol-orphan-"));
  const stateFile = path.join(dir, "state");
  fs.writeFileSync(stateFile, "running");
  fs.writeFileSync(
    path.join(dir, "ssh"),
    '#!/bin/sh\nfor last; do :; done\nout=$(mktemp)\n/bin/sh -c "$last" > "$out" 2>&1 < /dev/null &\nwait $!\nrc=$?\ncat "$out"; rm -f "$out"\nexit $rc\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(dir, "docker"),
    [
      "#!/bin/sh",
      'case "$1" in',
      '  inspect) s=$(cat "$FAKE_STATE_FILE"); sleep 3 >/dev/null 2>&1; echo "$s";;',
      '  restart) echo running > "$FAKE_STATE_FILE"; echo "$2";;',
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const saved = { PATH: process.env.PATH, FAKE_STATE_FILE: process.env.FAKE_STATE_FILE };
  process.env.PATH = dir + path.delimiter + process.env.PATH;
  process.env.FAKE_STATE_FILE = stateFile;
  const REMOTE = { id: "pi-test", transport: "ssh", runtime: "docker", dir: "/x", ssh: { target: "fake", identityFile: null, port: null, options: [] } };
  // The client's patience, shortened for the test (as a congested link ends it).
  const realRunShell = hosts.runShell;
  hosts.runShell = (h, s, o) => realRunShell(h, s, { ...o, timeout: Math.min((o && o.timeout) || 60000, 2500) });
  try {
    const { restartIfRunning } = freshFarmControl();
    const scanner = restartIfRunning(REMOTE, "twitchbotx19", { budget: { inspectS: 1, restartS: 2, settleS: 1 } }).then(
      () => "resolved",
      () => "rejected",
    );
    await new Promise((r) => setTimeout(r, 100));
    // The tick's park, queued behind the scanner on the container's lock.
    const park = hosts.withContainerLock(REMOTE, "twitchbotx19", async () => {
      fs.writeFileSync(stateFile, "exited");
    });
    assert.equal(await scanner, "rejected", "the slow check fails; it is never read as an answer");
    await park;
    await new Promise((r) => setTimeout(r, 3500)); // past the slow inspect
    assert.equal(fs.readFileSync(stateFile, "utf8").trim(), "exited", "the park holds: no orphaned restart");
  } finally {
    hosts.runShell = realRunShell;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
