// Every rent-farm window sold holds a slot in a rental stack until it ends. The
// watchdog said "register another rental stack" and a person then ran
// provisionEmptyConfig + setStackCapacity by hand; an order failed whenever
// that was late. utils/rentFarmAutoStack makes the same two calls from the
// watchdog's own readings.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const auto = require("../utils/rentFarmAutoStack");

const DAY = 24 * 60 * 60 * 1000;
const ON = { rentFarmAutoStack: true };
const cfg = (over = {}) => auto.config({ ...ON, ...over });

// An example farm: six full stacks, one with 41 free and one never started
// (50 free) — 91 free, 5.2 days at 17.4 a day.
function snapOf(over = {}) {
  const stacks = [];
  for (const n of ["02", "06", "54", "55", "56"]) {
    stacks.push({ host: "contabo", file: "config_" + n + ".json", used: 50, capacity: 50, remaining: 0, running: true });
  }
  stacks.push({ host: "contabo", file: "config_57.json", used: 50, capacity: 50, remaining: 0, running: true });
  stacks.push({ host: "contabo", file: "config_58.json", used: 9, capacity: 50, remaining: 41, running: true });
  stacks.push({ host: "contabo", file: "config_59.json", used: 0, capacity: 50, remaining: 50, running: false });
  return {
    stacks,
    offlineHosts: [],
    totalFree: 91,
    stackFree: 91,
    quota: { max: 2000, used: 467, remaining: 1533 },
    limitedBy: "stacks",
    level: "ok",
    ...over,
  };
}
const RUNWAY = { slotDays: 91 / 17.4, netSlotsPerDay: 17.4, freeSlots: 91 };
const args = (over = {}) => ({
  cfg: cfg(),
  snap: snapOf(),
  runway: RUNWAY,
  hostId: "contabo",
  hostStacks: 8,
  addedLast24h: 0,
  hostFreeMb: 6614,
  gate: { ok: true },
  ...over,
});

test("settings: off unless switched on, and a bad value falls back to its default", () => {
  assert.equal(auto.config({}).enabled, false);
  assert.equal(auto.config(null).enabled, false);
  assert.equal(auto.config({ rentFarmAutoStack: "true" }).enabled, false, "only a real true switches it on");
  const d = auto.config(ON);
  assert.deepEqual(
    [d.enabled, d.targetDays, d.minFree, d.capacity, d.maxPerDay, d.minHostFreeMb, d.maxStacks, d.host],
    [true, 14, 40, 50, 3, 2000, 40, ""],
  );
  const c = auto.config({
    ...ON,
    rentFarmAutoStackTargetDays: "abc",
    rentFarmAutoStackCapacity: 500, // a stack holds at most 100
    rentFarmAutoStackMaxPerDay: 0,
    rentFarmAutoStackMinHostFreeMb: 0, // 0 = do not look at memory
    rentFarmAutoStackHost: " contabo ",
  });
  assert.deepEqual([c.targetDays, c.capacity, c.maxPerDay, c.minHostFreeMb, c.host], [14, 100, 1, 0, "contabo"]);
});

test("REGRESSION: 91 slots at 17 a day is five days — a stack is added", () => {
  const d = auto.decide(args());
  assert.equal(d.add, true);
  assert.match(d.why, /91 slot\(s\) free, about 5\.2 day\(s\)/);
});

test("it adds only while the slots are short", () => {
  const roomy = { slotDays: 300 / 17.4, netSlotsPerDay: 17.4 };
  assert.equal(auto.decide(args({ snap: snapOf({ stackFree: 300, totalFree: 300 }), runway: roomy })).add, false);
  // Nothing is being sold (no days figure): only the floor counts.
  assert.equal(auto.decide(args({ snap: snapOf({ stackFree: 60, totalFree: 60 }), runway: null })).add, false);
  assert.equal(auto.decide(args({ snap: snapOf({ stackFree: 30, totalFree: 30 }), runway: null })).add, true);
  assert.equal(auto.decide(args({ snap: snapOf({ stackFree: 30, totalFree: 30 }), runway: { slotDays: null } })).add, true);
  // Plenty of slots, but they go fast.
  assert.equal(
    auto.decide(args({ snap: snapOf({ stackFree: 200, totalFree: 200 }), runway: { slotDays: 4, netSlotsPerDay: 50 } })).add,
    true,
  );
});

test("it never adds on a reading it cannot trust, and says nothing about those", () => {
  for (const over of [
    { cfg: auto.config({}) },
    { snap: null },
    { snap: snapOf({ withheld: true, level: "unknown" }) },
    { snap: snapOf({ offlineHosts: ["Contabo VPS"], stackFree: 0, totalFree: 0 }) },
    { snap: snapOf({ limitedBy: "holder-limit", totalFree: 3 }) },
    { hostFreeMb: null },
    { hostId: "" },
  ]) {
    const d = auto.decide(args(over));
    assert.equal(d.add, false, JSON.stringify(Object.keys(over)));
    assert.equal(d.blocked, undefined, "a state that clears by itself is not paged: " + d.why);
  }
});

test("a stack that is needed and may not be added carries a reason for the owner", () => {
  const cases = [
    [{ hostId: "local" }, /on the web server itself/],
    [{ hostStacks: 40 }, /already has 40 rental stacks \(limit 40/],
    [{ addedLast24h: 3 }, /3 stack\(s\) were already added on contabo in the last 24 h \(limit 3/],
    [{ addedLast24h: 3, snap: snapOf({ stackFree: 30, totalFree: 30 }), runway: null }, /already added on contabo/],
    [{ gate: { ok: false, reason: "host contabo has 300 MB RAM free; a new bot container needs at least 700 MB (hostMinFreeMb)" } }, /300 MB RAM free.*Another bot host is needed/],
    [{ hostFreeMb: 1500 }, /contabo has only 1500 MB of memory free \(a new stack needs 2000 MB/],
  ];
  for (const [over, re] of cases) {
    const d = auto.decide(args(over));
    assert.equal(d.add, false);
    assert.match(d.blocked, re);
  }
  // The day's limit with two weeks of slots in hand is "the rest tomorrow", not a page.
  const later = auto.decide(
    args({ addedLast24h: 3, snap: snapOf({ stackFree: 241, totalFree: 241 }), runway: { slotDays: 13.9, netSlotsPerDay: 17.4 } }),
  );
  assert.equal(later.add, false);
  assert.equal(later.blocked, undefined);
  assert.match(later.why, /the next one waits for tomorrow/);
  // Memory is not looked at when its floor is set to 0.
  assert.equal(auto.decide(args({ cfg: cfg({ rentFarmAutoStackMinHostFreeMb: 0 }), hostFreeMb: null })).add, true);
});

// ---------------------------------------------------------------------------
// checkOnce: the reads and the two calls, injected
// ---------------------------------------------------------------------------
function world(over = {}) {
  const w = {
    now: 1_800_000_000_000,
    af: { ...ON },
    made: [],
    events: [],
    sent: [],
    reads: [],
    blockedAt: 0,
    ...over,
  };
  auto._reset();
  auto.__setDeps({
    now: () => w.now,
    autoFarm: () => w.af,
    holderHost: async () => "contabo",
    addedSince: async (host, since) => {
      w.reads.push("addedSince:" + host + ":" + (w.now - since) / DAY);
      return w.added || 0;
    },
    hostFreeMb: async (host) => {
      w.reads.push("hostFreeMb:" + host);
      return "freeMb" in w ? w.freeMb : 6614;
    },
    gate: async () => ({ ok: true }),
    provision: async (host, capacity) => {
      if (w.provisionError) throw new Error(w.provisionError);
      const file = "config_" + (60 + w.made.length) + ".json";
      w.made.push({ host, file, capacity });
      return { host, file, container: "twitchbotx" + (60 + w.made.length - 1) };
    },
    lastBlockedAt: async () => w.blockedAt,
    logEvent: async (e) => {
      w.events.push(e);
      if (e.action === "rent_farm_stack_blocked") w.blockedAt = w.now;
    },
    send: async (t) => {
      w.sent.push(t);
    },
  });
  return w;
}

test("switched off it reads nothing and changes nothing", async () => {
  const w = world({ af: {} });
  auto.__setDeps({
    holderHost: async () => {
      throw new Error("must not be read while off");
    },
  });
  assert.deepEqual(await auto.checkOnce({ snap: snapOf(), runway: RUNWAY }), { added: false, why: "off" });
  assert.deepEqual([w.made, w.events, w.sent], [[], [], []]);
});

test("REGRESSION: short of slots — one 50-slot stack is made on the holder's host, logged and announced", async () => {
  const w = world();
  const r = await auto.checkOnce({ snap: snapOf(), runway: RUNWAY });
  assert.equal(r.added, true);
  assert.deepEqual(w.made, [{ host: "contabo", file: "config_60.json", capacity: 50 }]);
  assert.deepEqual([r.host, r.file, r.container, r.capacity], ["contabo", "config_60.json", "twitchbotx60", 50]);
  assert.equal(w.events.length, 1);
  assert.equal(w.events[0].action, "rent_farm_stack_added");
  assert.equal(w.events[0].subject, "contabo/config_60.json");
  assert.equal(w.events[0].count, 50);
  assert.equal(w.sent.length, 1);
  assert.match(w.sent[0], /contabo\/config_60\.json \(50 slots\) — free slots were 91, about 5\.2 day\(s\) at ~17\.4 a day; now 141/);
  assert.match(w.sent[0], /starts with its first order/);
  assert.deepEqual(w.reads, ["addedSince:contabo:1", "hostFreeMb:contabo"], "the last 24 h on that host, and its memory");
});

test("one stack a tick, and it stops by itself once there is room", async () => {
  const w = world();
  let free = 91;
  const tick = async () => {
    const r = await auto.checkOnce({
      snap: snapOf({ stackFree: free, totalFree: free }),
      runway: { slotDays: free / 17.4, netSlotsPerDay: 17.4 },
    });
    if (r.added) {
      free += 50;
      w.added = (w.added || 0) + 1;
    }
    return r;
  };
  const results = [];
  for (let i = 0; i < 6; i++) results.push((await tick()).added);
  // 91 -> 141 -> 191 -> 241 (13.9 days: still under 14) and then the day's limit.
  assert.deepEqual(results, [true, true, true, false, false, false]);
  assert.equal(w.made.length, 3, "three a day at most");
  assert.equal(w.sent.length, 3, "three additions announced; waiting for tomorrow with 13.9 days in hand is not a page");

  // Next day the limit is clear again: one more takes it past 14 days.
  w.added = 0;
  w.now += DAY;
  assert.equal((await tick()).added, true);
  assert.equal((await tick()).added, false);
  assert.equal(free, 291);
});

test("the day's limit IS said when the slots are really short — once", async () => {
  const w = world({ added: 3 });
  const short = { snap: snapOf({ stackFree: 60, totalFree: 60 }), runway: { slotDays: 1.2, netSlotsPerDay: 50 } };
  const r = await auto.checkOnce(short);
  assert.equal(r.added, false);
  assert.equal(r.paged, true);
  assert.match(w.sent[0], /needs another rental stack and none was added: 3 stack\(s\) were already added/);
  w.now += 30 * 60 * 1000;
  await auto.checkOnce(short);
  assert.equal(w.sent.length, 1, "not every tick");
  assert.deepEqual(w.made, []);
});

test("with room to spare the host is not even asked for its memory", async () => {
  const w = world();
  const r = await auto.checkOnce({
    snap: snapOf({ stackFree: 400, totalFree: 400 }),
    runway: { slotDays: 23, netSlotsPerDay: 17.4 },
  });
  assert.equal(r.added, false);
  assert.match(r.why, /enough room \(400 slot\(s\) free, about 23 day\(s\)\)/);
  assert.deepEqual(w.reads, []);
});

test("a host short of memory gets no stack — the owner is told once a day, restarts included", async () => {
  const w = world({ freeMb: 900 });
  let r = await auto.checkOnce({ snap: snapOf(), runway: RUNWAY });
  assert.equal(r.added, false);
  assert.equal(r.paged, true);
  assert.deepEqual(w.made, []);
  assert.match(w.sent[0], /none was added: contabo has only 900 MB of memory free/);
  assert.equal(w.events[0].action, "rent_farm_stack_blocked");

  w.now += 30 * 60 * 1000;
  r = await auto.checkOnce({ snap: snapOf(), runway: RUNWAY });
  assert.equal(r.paged, undefined);
  assert.equal(w.sent.length, 1);

  // A restart forgets the in-memory latch; the event does not.
  const blockedAt = w.blockedAt;
  const w2 = world({ freeMb: 900, now: w.now + 60 * 60 * 1000, blockedAt });
  await auto.checkOnce({ snap: snapOf(), runway: RUNWAY });
  assert.equal(w2.sent.length, 0);
  w2.now = blockedAt + DAY + 1000;
  await auto.checkOnce({ snap: snapOf(), runway: RUNWAY });
  assert.equal(w2.sent.length, 1, "and again a day later while it lasts");
});

test("the once-a-day reason does not repeat every tick when its event cannot be written", async () => {
  const w = world({ freeMb: 900 });
  auto.__setDeps({
    logEvent: async () => {
      throw new Error("mongo is down");
    },
    lastBlockedAt: async () => 0,
  });
  for (let i = 0; i < 4; i++) {
    await auto.checkOnce({ snap: snapOf(), runway: RUNWAY });
    w.now += 30 * 60 * 1000;
  }
  assert.equal(w.sent.length, 1, "this process remembers that it said it");
});

test("a failed add is reported and nothing is announced as added", async () => {
  const w = world({ provisionError: "Failed to update compose file: ssh timed out" });
  const r = await auto.checkOnce({ snap: snapOf(), runway: RUNWAY });
  assert.equal(r.added, false);
  assert.match(r.why, /adding a stack failed: Failed to update compose file/);
  assert.equal(w.events.filter((e) => e.action === "rent_farm_stack_added").length, 0);
  assert.match(w.sent[0], /adding a stack on contabo failed/);
});

test("a host named in settings wins over where the holder sits; quiet mode sends nothing", async () => {
  const w = world({ af: { ...ON, rentFarmAutoStackHost: "hetzner", rentFarmAutoStackCapacity: 80 } });
  auto.__setDeps({
    holderHost: async () => {
      throw new Error("not needed when a host is named");
    },
  });
  const r = await auto.checkOnce({ snap: snapOf(), runway: RUNWAY, notify: false });
  assert.equal(r.added, true);
  assert.deepEqual(w.made, [{ host: "hetzner", file: "config_60.json", capacity: 80 }]);
  assert.equal(w.sent.length, 0);
  assert.equal(w.events.length, 1, "still on the record");
});

// ---------------------------------------------------------------------------
// The watchdog tick hands it this tick's own readings
// ---------------------------------------------------------------------------
test("the watchdog tick runs it after the capacity and runway checks, with their results", async () => {
  const seen = [];
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent && /utils[\\/]rentFarmCapacity\.js$/.test(parent.filename || "")) {
      if (request === "./telegram") return { sendTelegram: async () => {} };
      if (request === "./systemLog") return { logEvent: async () => {} };
      if (request === "./renterIntegrity") return { checkOnce: async () => null };
      if (request === "./farmOrderWatch") return { checkOnce: async () => null };
      if (request === "./operatorFarm") return { holderQuota: async () => ({ max: 2000, used: 467, remaining: 1533 }) };
      if (request === "./rentFarmAutoStack") {
        return {
          checkOnce: async (a) => {
            seen.push(a);
            return { added: false, why: "stub" };
          },
        };
      }
    }
    return realLoad.call(this, request, parent, isMain);
  };
  const capPath = require.resolve("../utils/rentFarmCapacity");
  delete require.cache[capPath];
  try {
    const cap = require("../utils/rentFarmCapacity");
    cap._reset();
    let listing = {
      bots: [
        { host: "contabo", file: "config_58.json", accounts: 9, capacity: 50, remaining: 41, running: true },
        { host: "contabo", file: "config_59.json", accounts: 0, capacity: 50, remaining: 50, running: false },
      ],
      offlineHosts: [],
    };
    cap.__setDeps({
      now: () => 1_800_000_000_000,
      rentalStackOptions: async () => {
        if (!listing) throw new Error("ssh: connect to host contabo timed out");
        return listing;
      },
      listStacks: async () => [],
      holderId: async () => "holder",
      countRows: async (q) => (q.createdAt ? 122 : 0), // 122 windows sold in 7 days, none ended
      poolTrend: async () => null,
      gatherPoolEligibility: async () => ({ eligible: new Array(410).fill(0) }),
    });
    const out = await cap.tickOnce();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].snap.stackFree, 91);
    assert.equal(seen[0].snap.limitedBy, "stacks");
    assert.equal(seen[0].runway.netSlotsPerDay, 17.4);
    assert.ok(Math.abs(seen[0].runway.slotDays - 91 / (122 / 7)) < 1e-9);
    assert.deepEqual(out.autoStack, { value: { added: false, why: "stub" } });

    // No stack listing this tick = no reading to act on: it is not called.
    listing = null;
    const out2 = await cap.tickOnce();
    assert.equal(seen.length, 1);
    assert.equal(out2.autoStack, undefined);
  } finally {
    Module._load = realLoad;
    delete require.cache[capPath];
  }
});
