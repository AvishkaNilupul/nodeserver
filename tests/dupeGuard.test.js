// utils/dupeGuard (2026-10-01): a moved account is stripped from sibling
// configs AND the sibling is recorded as owing a reload (out of the config is
// not out of a running bot); a sibling that changed since the batched read is
// stripped from its fresh text (no lost update, no double); the guard skips only its own heal writes, not
// every write that happens to run meanwhile.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const owed = [];
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && /utils[\\/]dupeGuard\.js$/.test(parent.filename || "") && request === "./renterBotOps") {
    return { markReloadOwed: async (host, file, reason) => { owed.push(host.id + "/" + file + ": " + reason); } };
  }
  return realLoad.call(this, request, parent, isMain);
};
const guard = require("../utils/dupeGuard");
test.after(() => { Module._load = realLoad; });

const cfg = (users) => JSON.stringify({ TwitchSettings: { TwitchUsers: users } });
const u = (s, extra = {}) => ({ ClientSecret: s, Login: s, Enabled: true, ...extra });

function fakeHosts(files, { onRead } = {}) {
  const h = {
    files,
    writes: [],
    readdir: async () => Object.keys(files),
    readFiles: async (host, names) => Object.fromEntries(names.map((f) => [f, { ok: true, text: files[f] }])),
    readFile: async (host, f) => {
      if (onRead) await onRead(f);
      return files[f];
    },
    writeFileAtomic: async (host, f, text) => {
      files[f] = text;
      h.writes.push(f);
      await guard.enforceSingleHome(h, host, f, text);
    },
  };
  return h;
}
const HOST = { id: "contabo" };

test("a moved account is stripped from the sibling AND the sibling owes a reload", async () => {
  owed.length = 0;
  const hosts = fakeHosts({
    "config_03.json": cfg([u("a"), u("b")]),
    "config_05.json": cfg([u("a")]),
  });
  const healed = await guard.enforceSingleHome(hosts, HOST, "config_05.json", hosts.files["config_05.json"]);
  assert.deepEqual(healed, [{ file: "config_03.json", removed: ["a"] }]);
  assert.deepEqual(JSON.parse(hosts.files["config_03.json"]).TwitchSettings.TwitchUsers.map((x) => x.ClientSecret), ["b"]);
  assert.deepEqual(owed, ["contabo/config_03.json: dupe guard: accounts moved to config_05.json"]);
});

test("REGRESSION: a sibling that changed since the batched read is stripped from what is there NOW — no lost update, and no token left enabled twice", async () => {
  owed.length = 0;
  let hosts = null;
  hosts = fakeHosts(
    { "config_03.json": cfg([u("a"), u("b")]), "config_05.json": cfg([u("a")]) },
    {
      onRead: async (f) => {
        // Another (locked) writer adds "c" to config_03 in between.
        if (f === "config_03.json") hosts.files["config_03.json"] = cfg([u("a"), u("b"), u("c")]);
      },
    },
  );
  const healed = await guard.enforceSingleHome(hosts, HOST, "config_05.json", hosts.files["config_05.json"]);
  assert.deepEqual(healed, [{ file: "config_03.json", removed: ["a"] }]);
  assert.deepEqual(
    JSON.parse(hosts.files["config_03.json"]).TwitchSettings.TwitchUsers.map((x) => x.ClientSecret),
    ["b", "c"],
    "the other writer's change stands AND the moved token is gone",
  );
  assert.deepEqual(owed, ["contabo/config_03.json: dupe guard: accounts moved to config_05.json"]);
});

test("REGRESSION: a write that runs WHILE a heal is under way is still guarded", async () => {
  owed.length = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  let hosts = null;
  hosts = fakeHosts({
    "config_03.json": cfg([u("a")]),
    "config_05.json": cfg([u("a")]),
    "config_07.json": cfg([u("z")]),
    "config_09.json": cfg([u("z")]),
  });
  const realWrite = hosts.writeFileAtomic;
  hosts.writeFileAtomic = async (host, f, text) => {
    if (f === "config_03.json") await gate; // the heal write of config_03 hangs a moment
    return realWrite(host, f, text);
  };
  const heal = guard.enforceSingleHome(hosts, HOST, "config_05.json", hosts.files["config_05.json"]);
  // Meanwhile an unrelated write lands on config_09 — its guard must still run.
  await new Promise((r) => setImmediate(r));
  const other = await guard.enforceSingleHome(hosts, HOST, "config_09.json", hosts.files["config_09.json"]);
  release();
  await heal;
  assert.deepEqual(other.map((x) => x.file), ["config_07.json"], "not skipped by a heal elsewhere");
});

// ---------------------------------------------------------------------------
// 2026-10-11 — which write is "the newest one", and the heal under the
// sibling's lock. The fake below does what utils/botHosts.writeFileAtomic does:
// the previous text, the write, noteWrite, then the heal.
// ---------------------------------------------------------------------------
const { withFileLock } = require("../utils/fileLock");
const tick = (ms = 1) => new Promise((r) => setTimeout(r, ms));
const ids = (text) => JSON.parse(text).TwitchSettings.TwitchUsers.filter((x) => x.Enabled !== false).map((x) => x.ClientSecret).sort();

// `heals` collects each write's heal instead of running it, so a test can run
// them in the order it wants to prove does not matter.
function liveHosts(files, { heals = null } = {}) {
  const h = {
    files,
    readdir: async () => Object.keys(files),
    readFiles: async (host, names) =>
      Object.fromEntries(names.map((f) => [f, f in files ? { ok: true, text: files[f] } : { ok: false, error: "Not found" }])),
    readFile: async (host, f) => files[f],
    writeFileAtomic: async (host, f, text, opts) => {
      const prev = opts && "prev" in opts ? opts.prev : f in files ? files[f] : null;
      files[f] = text;
      const write = guard.noteWrite(host, f, text, prev);
      const heal = () => guard.enforceSingleHome(h, host, f, text, write);
      if (heals) heals.push({ file: f, run: heal });
      else await heal();
    },
  };
  return h;
}
// A read->mutate->write of one config under its lock, as every writer does.
const edit = (hosts, file, mutate) =>
  withFileLock(HOST, file, async () => {
    const prev = hosts.files[file];
    const data = JSON.parse(prev);
    mutate(data.TwitchSettings.TwitchUsers);
    await hosts.writeFileAtomic(HOST, file, JSON.stringify(data), { prev });
  });

test.beforeEach(() => {
  guard._resetForTests();
  owed.length = 0;
});

for (const first of ["the mover's heal first", "the bystander's heal first"]) {
  test("2026-10-09: a write that merely CARRIES an account does not strip it from the config it just moved to — " + first, async () => {
    // config_24 holds m1,m2 (about to move) and gets s1 added by one farm; at
    // the same moment another farm moves m1,m2 into config_53. Read as "the
    // config just written is home for all it holds", the first write's heal
    // strips m1,m2 from config_53 and the second's strips them from config_24:
    // both accounts end in no config at all.
    const heals = [];
    const hosts = liveHosts(
      { "config_24.json": cfg([u("m1"), u("m2")]), "config_53.json": cfg([u("z")]) },
      { heals },
    );
    await edit(hosts, "config_53.json", (users) => users.push(u("m1"), u("m2"))); // the move
    await edit(hosts, "config_24.json", (users) => users.push(u("s1"))); // read while m1,m2 were still here
    assert.deepEqual(ids(hosts.files["config_24.json"]), ["m1", "m2", "s1"], "the bystander's write carried them");
    const [mover, bystander] = heals;
    for (const h of first.startsWith("the mover") ? [mover, bystander] : [bystander, mover]) await h.run();
    assert.deepEqual(ids(hosts.files["config_53.json"]), ["m1", "m2", "z"], "they live where they were moved to");
    assert.deepEqual(ids(hosts.files["config_24.json"]), ["s1"], "and the bystander's own account is still in place");
  });
}

for (const first of ["the older claim's heal first", "the newer claim's heal first"]) {
  test("of two claims on one account the LATER write wins — " + first, async () => {
    const heals = [];
    const hosts = liveHosts(
      { "config_03.json": cfg([u("x")]), "config_05.json": cfg([u("y")]), "config_07.json": cfg([u("a")]) },
      { heals },
    );
    await edit(hosts, "config_03.json", (users) => users.push(u("a"))); // older claim
    await edit(hosts, "config_05.json", (users) => users.push(u("a"))); // newer claim
    const [older, newer] = heals;
    for (const h of first.startsWith("the older") ? [older, newer] : [newer, older]) await h.run();
    assert.deepEqual(ids(hosts.files["config_05.json"]), ["a", "y"], "the later write is home");
    assert.deepEqual(ids(hosts.files["config_03.json"]), ["x"]);
    assert.deepEqual(ids(hosts.files["config_07.json"]), [], "and the copy neither write made is gone too");
  });
}

test("nothing is stripped for an account that is no longer switched on at home when the heal runs", async () => {
  const heals = [];
  const hosts = liveHosts({ "config_03.json": cfg([u("a")]), "config_05.json": cfg([]) }, { heals });
  await edit(hosts, "config_05.json", (users) => users.push(u("a")));
  // Before that heal runs, the account is switched off at its new home.
  hosts.files["config_05.json"] = cfg([u("a", { Enabled: false })]);
  await heals[0].run();
  assert.deepEqual(ids(hosts.files["config_03.json"]), ["a"], "its only live copy is left alone");
});

test("with no claim on record the old rule stands: the config being written is home", async () => {
  // A duplicate that predates this process (or its memory): a later write of
  // either config still heals it.
  const hosts = liveHosts({ "config_03.json": cfg([u("a"), u("b")]), "config_05.json": cfg([u("a")]) });
  await edit(hosts, "config_05.json", (users) => users.push(u("c")));
  assert.deepEqual(ids(hosts.files["config_03.json"]), ["b"]);
  assert.deepEqual(ids(hosts.files["config_05.json"]), ["a", "c"]);
});

for (const first of ["config_20's heal judges first", "config_21's heal judges first"]) {
  test("a duplicate NO claim covers, both configs written at once: the account stays in exactly one — " + first, async () => {
    // y is switched on in two configs and nothing on record says which is
    // home (always so after a restart). Two unrelated writes, one of each
    // config, each own y by the old rule; each heal stripped the other's copy
    // and y farmed nowhere.
    const heals = [];
    const hosts = liveHosts(
      { "config_20.json": cfg([u("y"), u("p")]), "config_21.json": cfg([u("y"), u("q")]) },
      { heals },
    );
    await edit(hosts, "config_20.json", (users) => users.push(u("n20")));
    await edit(hosts, "config_21.json", (users) => users.push(u("n21")));
    const order = first.startsWith("config_20") ? [heals[0], heals[1]] : [heals[1], heals[0]];
    // Together, as they run in production: neither has finished when the other starts.
    await Promise.all(order.map((h) => h.run()));
    const in20 = ids(hosts.files["config_20.json"]).includes("y");
    const in21 = ids(hosts.files["config_21.json"]).includes("y");
    assert.equal(Number(in20) + Number(in21), 1, "y is switched on in exactly one config");
    assert.equal(in20, first.startsWith("config_20"), "the home is the config whose heal judged first");
    assert.deepEqual(ids(hosts.files["config_20.json"]).filter((x) => x !== "y"), ["n20", "p"]);
    assert.deepEqual(ids(hosts.files["config_21.json"]).filter((x) => x !== "y"), ["n21", "q"]);
  });
}

test("a claim is forgotten after CLAIM_TTL_MS — from then on a carried copy is home again", async (t) => {
  const heals = [];
  const hosts = liveHosts({ "config_03.json": cfg([u("a")]), "config_05.json": cfg([]) }, { heals });
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  await edit(hosts, "config_05.json", (users) => users.push(u("a"))); // claimed into 05; its heal never runs
  t.mock.timers.tick(guard.CLAIM_TTL_MS - 1000);
  await edit(hosts, "config_03.json", (users) => users.push(u("k")));
  await heals[1].run();
  assert.deepEqual(ids(hosts.files["config_05.json"]), ["a"], "inside the memory: the claim protects its home");
  t.mock.timers.tick(2000);
  await edit(hosts, "config_03.json", (users) => users.push(u("l")));
  await heals[2].run();
  assert.deepEqual(ids(hosts.files["config_05.json"]), [], "past it: the old rule");
});

test("a write whose previous text is not known claims nothing, and still heals by the old rule", async () => {
  const hosts = liveHosts({ "config_03.json": cfg([u("a")]), "config_05.json": cfg([u("a")]) });
  const text = hosts.files["config_05.json"];
  const write = guard.noteWrite(HOST, "config_05.json", text, undefined);
  assert.equal(write.fresh, null);
  const healed = await guard.enforceSingleHome(hosts, HOST, "config_05.json", text, write);
  assert.deepEqual(healed, [{ file: "config_03.json", removed: ["a"] }]);
});

test("a NEW file claims every account in it", () => {
  const write = guard.noteWrite(HOST, "config_09.json", cfg([u("a"), u("b", { Enabled: false })]), null);
  assert.deepEqual([...write.fresh], ["a"]);
});

test("REGRESSION 2026-10-09: the heal waits for a cycle that is rewriting the sibling — neither write is lost", async () => {
  // The other writer has READ config_03 and not yet written it when the heal
  // arrives. The re-read alone (2026-10-01) could not help: the heal read the
  // same old text, and whichever of the two wrote second undid the other.
  const hosts = liveHosts({ "config_03.json": cfg([u("a"), u("b")]), "config_05.json": cfg([]) });
  let release;
  const gate = new Promise((r) => { release = r; });
  const other = withFileLock(HOST, "config_03.json", async () => {
    const prev = hosts.files["config_03.json"];
    const data = JSON.parse(prev);
    await gate; // mid-cycle
    data.TwitchSettings.TwitchUsers.push(u("c"));
    await hosts.writeFileAtomic(HOST, "config_03.json", JSON.stringify(data), { prev });
  });
  await tick();
  const move = edit(hosts, "config_05.json", (users) => users.push(u("a")));
  await tick(10);
  assert.deepEqual(ids(hosts.files["config_03.json"]), ["a", "b"], "the heal has not touched the sibling mid-cycle");
  release();
  await Promise.all([other, move]);
  assert.deepEqual(ids(hosts.files["config_03.json"]), ["b", "c"], "the other writer's account is there AND the moved one is gone");
  assert.deepEqual(ids(hosts.files["config_05.json"]), ["a"]);
});

test("called from inside a file lock the heal is put off until that lock is released", async () => {
  const hosts = liveHosts({ "config_03.json": cfg([u("a")]), "config_05.json": cfg([]) });
  let midway = null;
  await withFileLock(HOST, "config_05.json", async () => {
    const prev = hosts.files["config_05.json"];
    await hosts.writeFileAtomic(HOST, "config_05.json", cfg([u("a")]), { prev });
    midway = ids(hosts.files["config_03.json"]);
  });
  assert.deepEqual(midway, ["a"], "not yet healed while the writer still held its own file");
  assert.deepEqual(ids(hosts.files["config_03.json"]), [], "healed by the time the writer's lock call returned");
});

test("two writers that each hold one config and whose heals need the other's both finish", async () => {
  // a moves 03 -> 05 while b moves 05 -> 03. A heal that waited for the
  // sibling's lock from inside its own would leave both hanging for good.
  const hosts = liveHosts({ "config_03.json": cfg([u("a")]), "config_05.json": cfg([u("b")]) });
  const slowEdit = (file, add) =>
    withFileLock(HOST, file, async () => {
      const prev = hosts.files[file];
      const data = JSON.parse(prev);
      await tick(5); // both are inside their own file now
      data.TwitchSettings.TwitchUsers.push(u(add));
      await hosts.writeFileAtomic(HOST, file, JSON.stringify(data), { prev });
    });
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("the two writers never finished")), 1000); });
  await Promise.race([Promise.all([slowEdit("config_05.json", "a"), slowEdit("config_03.json", "b")]), late]).finally(() => clearTimeout(timer));
  assert.deepEqual(ids(hosts.files["config_05.json"]), ["a"]);
  assert.deepEqual(ids(hosts.files["config_03.json"]), ["b"]);
});

test("a heal's own write claims nothing and starts no heal of its own", async () => {
  const hosts = liveHosts({ "config_03.json": cfg([u("a"), u("b")]), "config_05.json": cfg([]), "config_07.json": cfg([u("b")]) });
  await edit(hosts, "config_05.json", (users) => users.push(u("a")));
  // config_03 was rewritten by the heal and still holds b, which config_07
  // holds too: had that rewrite counted as a write of its own, b would be gone
  // from config_07.
  assert.deepEqual(ids(hosts.files["config_03.json"]), ["b"]);
  assert.deepEqual(ids(hosts.files["config_07.json"]), ["b"]);
});
