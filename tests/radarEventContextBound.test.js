/* global fetch, structuredClone */
// The drops radar's event preview / event listing read ONE event, not the whole radar
// (routes/radarRoutes.js eventContext; docs/LIVE-FIXES-1003.md §A9.6).
//
// Before 2026-10-03 every "listing preview" click and every "create listing" built the full
// "show ended" radar to find one event: EVERY AutoFarmTask with its assignedAccounts and bots
// (no filter, no limit), every campaign a task names (no projection) and the 500 newest
// campaigns (no projection). Now the event id's game bounds every read, every read is
// projected, and the event is rebuilt from exactly the campaigns the full radar gives it.
//
// Same output is pinned against the UNCHANGED `GET /api/radar/list?ended=1` (the full read):
// for every event of a world that exercises each membership rule — a campaign outside the 500
// listed ones (in only when a task names it), a task whose campaign row is missing (a
// synthetic campaign, and one whose id another game's task claimed first), the " Drops" alias,
// a case variant of the game name — the preview's event and waves equal the full radar's, and
// the listing create writes the same bundle and the same account scope in the same order.
//
// No database: the router is mounted in a bare express app; its models are in-memory fakes
// that filter, sort and project like Mongo and record every read. RADAR_ROUTES_PATH points the
// same tests at another copy of the router (e.g. the pre-fix bytes).
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const express = require("express");

const ROUTES_PATH = process.env.RADAR_ROUTES_PATH
  ? path.resolve(process.env.RADAR_ROUTES_PATH)
  : require.resolve("../routes/radarRoutes");
const ROOT = path.join(__dirname, "..");

const DAY = 86400000;
const NOW = Date.now();
const ago = (d) => new Date(NOW - d * DAY);
const ahead = (d) => new Date(NOW + d * DAY);
let oidSeq = 0x100000;
const oid = () => (oidSeq++).toString(16).padStart(24, "0");

/* ------------------------------ a tiny Mongo --------------------------------- */

const get = (doc, key) => key.split(".").reduce((v, k) => (v == null ? undefined : v[k]), doc);
const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof RegExp);

function eq(v, x) {
  if (x === null) return v === null || v === undefined;
  if (x instanceof Date) return v instanceof Date && v.getTime() === x.getTime();
  return String(v) === String(x) && typeof v === typeof x;
}

function cmp(v, x) {
  const a = v instanceof Date ? v.getTime() : v;
  const b = x instanceof Date ? x.getTime() : x;
  return a < b ? -1 : a > b ? 1 : 0;
}

function matches(doc, filter) {
  for (const [k, cond] of Object.entries(filter || {})) {
    if (k === "$or") {
      if (!cond.some((f) => matches(doc, f))) return false;
      continue;
    }
    const v = get(doc, k);
    if (cond instanceof RegExp) {
      if (typeof v !== "string" || !cond.test(v)) return false;
      continue;
    }
    if (isPlainObject(cond)) {
      for (const [op, arg] of Object.entries(cond)) {
        if (op === "$in") {
          if (!arg.some((x) => (x instanceof RegExp ? typeof v === "string" && x.test(v) : eq(v, x)))) return false;
        } else if (op === "$gte") {
          if (v == null || cmp(v, arg) < 0) return false;
        } else if (op === "$ne") {
          if (eq(v, arg)) return false;
        } else {
          throw new Error("fake Mongo: unsupported operator " + op);
        }
      }
      continue;
    }
    if (!eq(v, cond)) return false;
  }
  return true;
}

// BSON sort order for the types these collections hold: null < number < string < boolean < date.
function rank(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return 1;
  if (typeof v === "string") return 2;
  if (typeof v === "boolean") return 3;
  if (v instanceof Date) return 4;
  return 5;
}
function sortDocs(docs, spec) {
  const keys = Object.entries(spec || {});
  return docs.slice().sort((a, b) => {
    for (const [k, dir] of keys) {
      const x = get(a, k);
      const y = get(b, k);
      const r = rank(x) - rank(y) || (rank(x) === 0 ? 0 : cmp(x, y));
      if (r) return dir < 0 ? -r : r;
    }
    return 0;
  });
}

function project(doc, proj) {
  if (!proj || !Object.keys(proj).length) return structuredClone(doc);
  const out = {};
  if (proj._id !== 0) out._id = doc._id;
  for (const [k, on] of Object.entries(proj)) {
    if (!on || k === "_id") continue;
    const v = get(doc, k);
    if (v === undefined) continue;
    const parts = k.split(".");
    let o = out;
    for (const p of parts.slice(0, -1)) o = o[p] || (o[p] = {});
    o[parts[parts.length - 1]] = structuredClone(v);
  }
  return out;
}

function collection(name, rows, reads) {
  const find = (filter = {}, proj = null) => {
    const read = { model: name, op: "find", filter, proj, sort: null, limit: null };
    reads.push(read);
    let out = null;
    const run = () => {
      if (out) return out;
      let docs = rows.filter((d) => matches(d, filter));
      if (read.sort) docs = sortDocs(docs, read.sort);
      if (read.limit) docs = docs.slice(0, read.limit);
      out = docs.map((d) => project(d, proj));
      return out;
    };
    const q = {
      sort(s) {
        read.sort = s;
        return q;
      },
      limit(n) {
        read.limit = n;
        return q;
      },
      lean: () => Promise.resolve().then(run),
      then: (a, b) => Promise.resolve().then(run).then(a, b),
    };
    return q;
  };
  return {
    find,
    findOne(filter = {}, proj = null) {
      const q = find(filter, proj);
      reads[reads.length - 1].op = "findOne";
      const one = { sort: (s) => (q.sort(s), one), lean: () => q.lean().then((d) => d[0] || null), then: (a, b) => q.lean().then((d) => d[0] || null).then(a, b) };
      return one;
    },
    aggregate(pipeline) {
      reads.push({ model: name, op: "aggregate", filter: pipeline[0] && pipeline[0].$match, proj: null });
      return Promise.resolve([]);
    },
    exists: () => Promise.resolve(null),
  };
}

/* --------------------------------- the world --------------------------------- */

const LOGIN = (n) => "farmer" + n;

function world() {
  const campaigns = [];
  const tasks = [];
  const sets = [];
  const camp = (o) => {
    const doc = { _id: oid(), owner: "pub", status: "EXPIRED", active: false, startAt: ago(30), endAt: ago(20), detailsURL: "https://x", image: "img", boxArt: "box", firstSeenAt: ago(31), lastSeenAt: ago(20), accountConnected: false, ...o };
    campaigns.push(doc);
    return doc;
  };
  const task = (o) => {
    const doc = { _id: oid(), status: "completed", decision: "farm", reason: "r", assignedAccounts: [], bots: [{ host: "contabo", container: "twitchbot-1" }], createdAt: ago(5), updatedAt: ago(4), campaignEndAt: ago(3), ...o };
    tasks.push(doc);
    return doc;
  };

  // Rust: one live round, one recent round, two very old rounds (outside the 500 listed).
  camp({ campaignId: "rust-30", game: "Rust", name: "Rust Twitch Drops Round 30", active: true, status: "ACTIVE", startAt: ago(2), endAt: ahead(5) });
  camp({ campaignId: "rust-29", game: "Rust", name: "Rust Twitch Drops Round 29", startAt: ago(9), endAt: ago(3) });
  camp({ campaignId: "rust-10", game: "Rust", name: "Rust Twitch Drops Round 10", startAt: ago(400), endAt: ago(390) });
  camp({ campaignId: "rust-11", game: "rust", name: "RUST Twitch Drops Round 11", startAt: ago(380), endAt: ago(370) });
  // Marvel Rivals: a " Drops" alias of a name the same game also uses.
  camp({ campaignId: "mr-1", game: "Marvel Rivals", name: "Season 4 Drops", startAt: ago(12), endAt: ago(6) });
  camp({ campaignId: "mr-2", game: "Marvel Rivals", name: "Season 4", startAt: ago(4), endAt: ahead(3), active: true, status: "ACTIVE" });
  // A campaign with no game ("Unknown game"), and a padded game name.
  camp({ campaignId: "nogame-1", game: "", name: "Mystery Drops", startAt: ago(3), endAt: ahead(2), active: true, status: "ACTIVE" });
  camp({ campaignId: "pad-1", game: "  Padded Game ", name: "Padded Event", startAt: ago(6), endAt: ago(1) });
  // 520 other campaigns, newer than the old Rust rounds, so those fall outside the 500 listed.
  for (let i = 0; i < 520; i += 1) camp({ campaignId: "fill-" + i, game: "Filler " + (i % 40), name: "Filler Event " + i, startAt: ago(10 + (i % 300) / 10), endAt: ago(1 + (i % 9)) });

  // Tasks, in insertion order.
  task({ game: "Rust", campaignId: "rust-30", campaignName: "Rust Twitch Drops Round 30", status: "active", assignedAccounts: [LOGIN(1), LOGIN(2), "Farmer3"], listing: { setId: "" } });
  task({ game: "Rust", campaignId: "rust-11", campaignName: "RUST Twitch Drops Round 11", status: "completed", assignedAccounts: [LOGIN(4), LOGIN(1)] });
  // A campaign row that never existed: synthetic, and "RUST" claims the wave before "Rust".
  task({ game: "RUST", campaignId: "orphan-1", campaignName: "Rust Twitch Drops Round 5", status: "completed", assignedAccounts: [LOGIN(5)] });
  task({ game: "Rust", campaignId: "orphan-1", campaignName: "Rust Twitch Drops Round 5", status: "failed", assignedAccounts: [LOGIN(6)] });
  // Another game's task names orphan-2 first: the wave is that game's, not Rust's.
  task({ game: "Other Game", campaignId: "orphan-2", campaignName: "Other Event", status: "completed", assignedAccounts: [LOGIN(7)] });
  task({ game: "Rust", campaignId: "orphan-2", campaignName: "Rust Twitch Drops Round 6", status: "completed", assignedAccounts: [LOGIN(8)] });
  const snap = { _id: oid(), name: "snap", items: [{ itemKey: "mr-item", name: "Cape", game: "Marvel Rivals", image: "https://img/cape", qty: 2 }] };
  sets.push(snap);
  task({ game: "Marvel Rivals", campaignId: "mr-1", campaignName: "Season 4 Drops", status: "completed", assignedAccounts: [LOGIN(9)], listing: { setId: String(snap._id) } });
  task({ game: "Marvel Rivals", campaignId: "mr-2", campaignName: "Season 4", status: "planned", assignedAccounts: [LOGIN(10), LOGIN(9)] });
  for (let i = 0; i < 30; i += 1) task({ game: "Filler " + (i % 40), campaignId: "fill-" + i, campaignName: "Filler Event " + i, assignedAccounts: [LOGIN(100 + i)] });
  task({ game: "Unknown game", campaignId: "nogame-1", campaignName: "Mystery Drops", status: "active", assignedAccounts: [LOGIN(20)] });
  task({ game: "Unknown game", campaignId: "orphan-3", campaignName: "Mystery Drops Week 2", status: "planned", assignedAccounts: [LOGIN(21)] });
  task({ game: "Padded Game", campaignId: "pad-1", campaignName: "Padded Event", assignedAccounts: [LOGIN(22)] });
  return { campaigns, tasks, sets };
}

/* ------------------------------ mount the router ------------------------------ */

function strict(name, impl = {}) {
  return new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === "symbol" || prop === "then" || prop === "__esModule") return undefined;
      return () => {
        throw new Error("unexpected call: " + name + "." + String(prop));
      };
    },
  });
}

async function serve(w) {
  const reads = [];
  const calls = { scopes: [], created: [] };
  const stubs = new Map([
    ["../middleware/auth", { requireSuperadmin: (req, res, next) => next() }],
    ["../models/TwitchCampaign", collection("TwitchCampaign", w.campaigns, reads)],
    ["../models/AutoFarmTask", collection("AutoFarmTask", w.tasks, reads)],
    ["../models/EpicFreebie", collection("EpicFreebie", [], reads)],
    ["../models/DropLog", collection("DropLog", [], reads)],
    ["../models/BotAccount", collection("BotAccount", [], reads)],
    ["../models/MarketplaceListing", collection("MarketplaceListing", [], reads)],
    [
      "../models/DropSet",
      {
        ...collection("DropSet", w.sets, reads),
        create: async (doc) => {
          calls.created.push(doc);
          return { _id: "new-set", ...doc };
        },
      },
    ],
    ["../utils/campaignWatcher", strict("campaignWatcher", { status: () => ({}) })],
    ["../utils/epicWatcher", strict("epicWatcher", { status: () => ({}) })],
    [
      "../utils/autoLister",
      strict("autoLister", {
        campaignItems: async (campaignId, game, name) => [{ itemKey: "k-" + campaignId, name: "Reward of " + name, game, image: "", qty: 1 }],
      }),
    ],
    ["../utils/imageCache", strict("imageCache", { cacheImage: async () => "/img/cached" })],
    [
      "./shopRoutes",
      strict("shopRoutes", {
        availableAccountsForSet: async ({ accountScopeLogins }) => {
          calls.scopes.push(accountScopeLogins);
          return [{ accountId: "a1" }];
        },
      }),
    ],
    ["../utils/dropReservation", { AVAILABLE_DROP: { connected: { $ne: true }, soldAt: null } }],
    ["../utils/radarEvents", require(path.join(ROOT, "utils/radarEvents"))],
    ["../utils/radarEventListings", require(path.join(ROOT, "utils/radarEventListings"))],
  ]);
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent && parent.filename === ROUTES_PATH) {
      if (stubs.has(request)) return stubs.get(request);
      if (request.startsWith(".")) return strict(request);
      // Bare packages resolve from this repo, wherever the router copy lives.
      return realLoad.call(this, request, module, isMain);
    }
    return realLoad.call(this, request, parent, isMain);
  };
  let router;
  try {
    delete require.cache[ROUTES_PATH];
    router = require(ROUTES_PATH);
    delete require.cache[ROUTES_PATH];
  } finally {
    Module._load = realLoad;
  }
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const base = "http://127.0.0.1:" + server.address().port;
  const call = async (method, p) => {
    const res = await fetch(base + p, { method, headers: { Accept: "application/json" } });
    return { status: res.status, body: await res.json() };
  };
  return { reads, calls, call, close: () => new Promise((r) => server.close(r)) };
}

const waveView = (w) => ({ campaignId: w.campaignId, name: w.name, label: w.label, farm: w.farm });

// What the full radar (the unchanged list route, every task, every campaign) says per event.
async function reference(w) {
  const s = await serve(w);
  try {
    const r = await s.call("GET", "/api/radar/list?ended=1");
    assert.equal(r.status, 200);
    return r.body.events;
  } finally {
    await s.close();
  }
}

/* ----------------------------------- tests ----------------------------------- */

test("the preview of EVERY event equals the full radar's event, wave for wave", async () => {
  const w = world();
  const events = await reference(w);
  const s = await serve(w);
  try {
    assert.ok(events.length > 40, "the world has many events");
    for (const ev of events) {
      const r = await s.call("GET", "/api/radar/events/" + ev.id + "/listing-preview");
      assert.equal(r.status, 200, ev.game + " / " + ev.name);
      assert.deepEqual(r.body.event, { id: ev.id, name: ev.name, game: ev.game, campaignIds: ev.campaignIds }, ev.name);
      assert.deepEqual(r.body.waves.map(waveView), ev.waves.map(waveView), ev.name);
    }
  } finally {
    await s.close();
  }
});

test("the membership rules: the 500 listed, task-named old rounds, synthetic rounds, first claim wins", async () => {
  const w = world();
  const events = await reference(w);
  const rust = events.find((e) => e.game.toLowerCase() === "rust" && e.name.toLowerCase() === "rust twitch drops");
  assert.ok(rust, "the Rust event exists");
  // Round 10 is outside the 500 listed and no task names it: not in the event.
  // Round 11 is just as old, but a task names it. orphan-1 has no campaign row (synthetic);
  // orphan-2's wave went to "Other Game", whose task named it first.
  assert.deepEqual([...rust.campaignIds].sort(), ["orphan-1", "rust-11", "rust-29", "rust-30"]);
  const s = await serve(w);
  try {
    const r = await s.call("GET", "/api/radar/events/" + rust.id + "/listing-preview");
    assert.deepEqual([...r.body.event.campaignIds].sort(), ["orphan-1", "rust-11", "rust-29", "rust-30"]);
    assert.equal(r.body.event.game, rust.game, "the game's spelling comes from the same first campaign");
    // Logins of the event's tasks, in the order the tasks were written, de-duplicated.
    assert.equal(r.body.assignedAccounts, 6);
    assert.deepEqual(s.calls.scopes[0], [LOGIN(1), LOGIN(2), "farmer3", LOGIN(4), LOGIN(5), LOGIN(6)]);
  } finally {
    await s.close();
  }
  // A campaign with no game and a task's synthetic wave meet under "Unknown game".
  const mystery = events.find((e) => e.game === "Unknown game");
  assert.ok(mystery);
  assert.deepEqual([...mystery.campaignIds].sort(), ["nogame-1", "orphan-3"]);
  assert.ok(events.some((e) => e.game === "Padded Game" && e.campaignIds.includes("pad-1")));
});

test("the preview reads only the event's game, and every read is projected (the full read is gone)", async () => {
  const w = world();
  const events = await reference(w);
  const rust = events.find((e) => e.name.toLowerCase() === "rust twitch drops");
  const s = await serve(w);
  try {
    const r = await s.call("GET", "/api/radar/events/" + rust.id + "/listing-preview");
    assert.equal(r.status, 200);
    const finds = s.reads.filter((x) => x.op === "find" && (x.model === "AutoFarmTask" || x.model === "TwitchCampaign"));
    for (const x of finds) {
      assert.ok(x.proj && Object.keys(x.proj).length, x.model + " read without a projection: " + JSON.stringify(x.filter));
      const unfiltered = !Object.keys(x.filter || {}).length;
      if (x.model === "AutoFarmTask") assert.ok(!unfiltered, "every AutoFarmTask was read");
      if (unfiltered) assert.ok(x.limit && x.limit <= 500, "an unfiltered campaign read must stay bounded");
      assert.ok(!(x.proj && x.proj.bots), "bots are never read for a preview");
    }
    // The task reads return the event's game's tasks only, never the other games'.
    const taskRows = s.reads.filter((x) => x.model === "AutoFarmTask");
    assert.ok(taskRows.length >= 1);
    for (const x of taskRows) {
      const hits = w.tasks.filter((t) => matches(t, x.filter));
      assert.ok(hits.every((t) => /rust|other game/i.test(t.game)), "only tasks that can belong to this event are read");
    }
  } finally {
    await s.close();
  }
});

test("creating the event listing writes the same bundle and account scope as the full radar did", async () => {
  const w = world();
  const events = await reference(w);
  const mr = events.find((e) => e.game === "Marvel Rivals");
  assert.ok(mr, "the alias merged Season 4 and Season 4 Drops into one event");
  assert.deepEqual([...mr.campaignIds].sort(), ["mr-1", "mr-2"]);
  const s = await serve(w);
  try {
    const r = await s.call("POST", "/api/radar/events/" + mr.id + "/listing");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(s.calls.created.length, 1);
    const set = s.calls.created[0];
    assert.equal(set.name, "Marvel Rivals Twitch Drops - " + mr.name);
    assert.deepEqual(set.sourceCampaignIds, mr.campaignIds);
    assert.deepEqual(set.accountScopeLogins, [LOGIN(9), LOGIN(10)]);
    // Wave mr-1's items come from its listing snapshot, mr-2's from Twitch; merged by name.
    assert.deepEqual(
      set.items.map((i) => [i.itemKey, i.qty]),
      [["mr-item", 2], ["k-mr-2", 1]],
    );
  } finally {
    await s.close();
  }
});

test("an id that is not an event is a 404, as before", async () => {
  const w = world();
  const s = await serve(w);
  try {
    for (const id of ["nope", Buffer.from("rust\u0000no such event", "utf8").toString("base64url"), Buffer.from("RUST\u0000rust twitch drops").toString("base64url")]) {
      const r = await s.call("GET", "/api/radar/events/" + id + "/listing-preview");
      assert.equal(r.status, 404, id);
    }
  } finally {
    await s.close();
  }
});
