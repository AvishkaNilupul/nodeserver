// Guards for scripts/eldorado-farm-offers-off.js — the tool that takes every
// rent-farm offer on Eldorado off sale (and can put back exactly the ones it
// took off). The tests are about which offers it may touch, what counts as
// "done" and when it must stop.
const test = require("node:test");
const assert = require("node:assert/strict");

const { buildPlan, buildResumePlan, applyPlan } = require("../scripts/eldorado-farm-offers-off");
const farm = require("../utils/eldoradoFarmService");

const offer = (id, title, state = "Active") => ({ id, offerTitle: title, offerState: state });
const FARM = (game, term) => game + " Twitch Drops Automatic Farming " + term;
const act = (rows) => rows.map((r) => r.id + ":" + r.action);

// A fake Eldorado: `states` is offer id -> state, and a write moves the offer
// to states.__to unless `fail` names an error for that id.
const io = (states, fail = {}) => {
  const calls = [];
  const done = [];
  return {
    calls,
    done,
    act: async (id) => {
      calls.push("act " + id);
      if (fail[id]) throw fail[id];
      states[id] = states.__to;
    },
    read: async (id) => ({ offerState: states[id] }),
    confirmed: async (row) => done.push(row.id),
    sleep: async () => {},
    log: () => {},
  };
};

test("only rent-farm offers are planned, and only Active ones are paused", () => {
  const rows = buildPlan(
    [
      offer("a", FARM("Rust", "120 Days")),
      offer("b", FARM("Rust", "1 Year"), "Paused"),
      offer("c", FARM("Rust", "30 Days"), "Closed"),
      offer("d", "Rust Twitch Drops (4 Items) — Skin + Door"),
      offer("e", "Rocket League Twitch Drops PACK OF 5 ACCOUNTS"),
      offer("f", "Overwatch Twitch Drops Automatic farming 180 days"),
      { offer: offer("g", FARM("Apex Legends", "2 Years")) },
    ],
    farm,
  );
  assert.deepEqual(act(rows).sort(), ["a:pause", "b:already", "c:skip", "f:pause", "g:pause"]);
  assert.match(rows.find((r) => r.id === "c").why, /Closed/);
});

test("a farming PACK is a service offer too", () => {
  const rows = buildPlan([offer("p", "Rust Twitch Drops Automatic Farming 120 Days PACK OF 5 ACCOUNTS")], farm);
  assert.deepEqual(act(rows), ["p:pause"]);
});

test("--also adds an offer by id whatever its title", () => {
  const offers = [offer("x", "Dupe Boxes | 30–140 Loot Boxes"), offer("y", "Rust Twitch Drops (2 Items)")];
  assert.deepEqual(act(buildPlan(offers, farm)), []);
  assert.deepEqual(act(buildPlan(offers, farm, { also: new Set(["x"]) })), ["x:pause"]);
});

test("a resume puts back only what the run paused, and only while it is still Paused", () => {
  const offers = [
    offer("a", FARM("Rust", "120 Days"), "Paused"),
    offer("b", FARM("Rust", "1 Year"), "Paused"), // paused before the run: not in the file
    offer("c", FARM("Rust", "30 Days"), "Active"),
    offer("d", FARM("Rust", "2 Years"), "Closed"),
  ];
  const got = Object.fromEntries(buildResumePlan(offers, ["a", "c", "d", "gone"]).map((r) => [r.id, r.action]));
  assert.deepEqual(got, { a: "resume", c: "already", d: "skip" });
});

test("a pause counts only when Eldorado shows the offer Paused", async () => {
  const states = { __to: "Paused", a: "Active", b: "Active" };
  const rows = buildPlan([offer("a", FARM("Rust", "120 Days")), offer("b", FARM("Rust", "1 Year"))], farm);
  const f = io(states);
  // b's write "succeeds" but the offer stays Active.
  const inner = f.act;
  f.act = async (id) => {
    if (id === "b") return;
    return inner(id);
  };
  const out = await applyPlan(rows, "pause", "Paused", f);
  assert.deepEqual(out.done.map((r) => r.id), ["a"]);
  assert.equal(out.failed.length, 1);
  assert.match(out.failed[0].error, /sent, not confirmed: Eldorado still shows it Active/);
  assert.deepEqual(f.done, ["a"]);
});

test("offers that are not Active are never written to", async () => {
  const states = { __to: "Paused", a: "Active", b: "Paused", c: "Closed" };
  const rows = buildPlan(
    [offer("a", FARM("Rust", "120 Days")), offer("b", FARM("Rust", "1 Year"), "Paused"), offer("c", FARM("Rust", "30 Days"), "Closed")],
    farm,
  );
  const f = io(states);
  await applyPlan(rows, "pause", "Paused", f);
  assert.deepEqual(f.calls, ["act a"]);
});

test("a quota answer stops the run at once", async () => {
  const states = { __to: "Paused", a: "Active", b: "Active", c: "Active" };
  const rows = buildPlan([offer("a", FARM("A", "1 Year")), offer("b", FARM("B", "1 Year")), offer("c", FARM("C", "1 Year"))], farm);
  const quota = Object.assign(new Error("Eldorado delist failed (HTTP 429): Quota exceeded"), { status: 429 });
  const f = io(states, { b: quota });
  const out = await applyPlan(rows, "pause", "Paused", f);
  assert.equal(out.done.length, 1);
  assert.match(out.stopped, /quota/);
  assert.equal(out.left, 1);
  assert.deepEqual(f.calls, ["act a", "act b"]);
});

test("three failures in a row stop the run", async () => {
  const ids = ["a", "b", "c", "d", "e"];
  const states = { __to: "Paused" };
  for (const id of ids) states[id] = "Active";
  const rows = buildPlan(ids.map((id) => offer(id, FARM(id.toUpperCase(), "1 Year"))), farm);
  const boom = new Error("Eldorado delist failed (HTTP 500)");
  const f = io(states, { a: boom, b: boom, c: boom });
  const out = await applyPlan(rows, "pause", "Paused", f);
  assert.match(out.stopped, /3 failures in a row/);
  assert.equal(out.left, 2);
  assert.deepEqual(f.calls, ["act a", "act b", "act c"]);
});

test("a lapsed token is waited out, not treated as a failure", async () => {
  const states = { __to: "Paused", a: "Active" };
  const rows = buildPlan([offer("a", FARM("Rust", "1 Year"))], farm);
  const f = io(states);
  let n = 0;
  const inner = f.act;
  f.act = async (id) => {
    if (++n === 1) throw Object.assign(new Error("Eldorado session refresh failed"), { status: 401 });
    return inner(id);
  };
  const waits = [];
  f.sleep = async (ms) => waits.push(ms);
  const out = await applyPlan(rows, "pause", "Paused", f, { lapseWaitMs: 80000 });
  assert.deepEqual(out.done.map((r) => r.id), ["a"]);
  assert.ok(waits.includes(80000));
});

test("a resume goes through the same rules, towards Active", async () => {
  const states = { __to: "Active", a: "Paused", b: "Paused" };
  const rows = buildResumePlan([offer("a", FARM("Rust", "1 Year"), "Paused"), offer("b", FARM("Rust", "30 Days"), "Paused")], ["a"]);
  const f = io(states);
  const out = await applyPlan(rows, "resume", "Active", f);
  assert.deepEqual(out.done.map((r) => r.id), ["a"]);
  assert.deepEqual(f.calls, ["act a"]);
  assert.equal(states.b, "Paused");
});
