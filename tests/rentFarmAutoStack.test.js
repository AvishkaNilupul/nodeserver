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
const HOUR = 60 * 60 * 1000;
const HALF_HOUR = 30 * 60 * 1000;
const ON = { rentFarmAutoStack: true };
const cfg = (over = {}) => auto.config({ ...ON, ...over });

// An example farm: six full stacks, one with 41 free and one never started
// (50 free) — 91 free, 5.2 days at 17.4 a day.
function snapOf(over = {}) {
  const stacks = [];
  for (const n of ["02", "06", "54", "55", "56", "57"]) {
    stacks.push({ host: "contabo", file: "config_" + n + ".json", used: 50, capacity: 50, remaining: 0, running: true });
  }
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
  hostKnown: true,
  hostStacks: 8,
  unstarted: 1,
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
    [d.enabled, d.targetDays, d.minFree, d.capacity, d.maxPerDay, d.minHostFreeMb, d.perStackMb, d.maxStacks, d.host],
    [true, 14, 40, 50, 3, 2000, 300, 40, ""],
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

test("REGRESSION: 91 slots at 17 a day is five days — a stack is wanted", () => {
  const d = auto.decide(args());
  assert.equal(d.add, true);
  assert.match(d.why, /91 slot\(s\) free, about 5\.2 day\(s\)/);
});

test("it wants one only while the slots are short", () => {
  const roomy = auto.decide(args({ snap: snapOf({ stackFree: 300, totalFree: 300 }), runway: { slotDays: 300 / 17.4, netSlotsPerDay: 17.4 } }));
  assert.equal(roomy.add, false);
  assert.equal(roomy.enough, true);
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
    assert.equal(d.enough, undefined, "and it is not read as 'there is room'");
  }
});

test("a stack that is needed and may not be added carries a reason for the owner", () => {
  const cases = [
    [{ hostId: "local" }, "local", /on the web server itself/],
    [{ hostId: "Contabo VPS", hostKnown: false }, "unknown-host", /"Contabo VPS" is not in this server's host list.*host id, not a label/],
    [{ hostStacks: 40 }, "max-stacks", /already has 40 rental stacks \(limit 40/],
    [{ addedLast24h: 3 }, "daily-limit", /3 stack\(s\) were already added on contabo in the last 24 h \(limit 3/],
    [{ addedLast24h: 3, snap: snapOf({ stackFree: 30, totalFree: 30 }), runway: null }, "daily-limit", /already added on contabo/],
    [{ gate: { ok: false, reason: "host contabo has 300 MB RAM free; a new bot container needs at least 700 MB (hostMinFreeMb)" } }, "memory", /300 MB RAM free.*Another bot host is needed/],
    [{ hostFreeMb: 1500 }, "memory", /contabo has 1500 MB of memory free, and 1 stack\(s\) not yet started plus the new one will need about 600 MB — that would leave less than the 2000 MB/],
  ];
  for (const [over, reason, re] of cases) {
    const d = auto.decide(args(over));
    assert.equal(d.add, false);
    assert.equal(d.reason, reason);
    assert.match(d.blocked, re);
  }
  // The day's limit with two weeks of slots in hand is "the rest tomorrow", not a page.
  const later = auto.decide(
    args({ addedLast24h: 3, snap: snapOf({ stackFree: 241, totalFree: 241 }), runway: { slotDays: 13.9, netSlotsPerDay: 17.4 } }),
  );
  assert.equal(later.add, false);
  assert.equal(later.blocked, undefined);
  assert.match(later.why, /the next one waits for tomorrow/);
});

test("REGRESSION: memory already promised to stacks that have not started is counted", () => {
  // 2,100 MB free looks fine against a 2,000 MB floor — but five stacks are
  // waiting for their first order, and each fills to a whole container.
  const d = auto.decide(args({ hostFreeMb: 2100, unstarted: 5 }));
  assert.equal(d.add, false);
  assert.equal(d.reason, "memory");
  assert.match(d.blocked, /5 stack\(s\) not yet started plus the new one will need about 1800 MB/);
  // The same host with nothing waiting has room for one more.
  assert.equal(auto.decide(args({ hostFreeMb: 2300, unstarted: 0 })).add, true);
  assert.equal(auto.decide(args({ hostFreeMb: 2299, unstarted: 0 })).add, false);
  // Plenty of memory: stacks waiting do not stop an add.
  assert.equal(auto.decide(args({ hostFreeMb: 6614, unstarted: 5 })).add, true);
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
    tries: 0,
    events: [],
    sent: [],
    reads: [],
    blockedAt: {}, // reason -> ms, as the events would say
    failedAt: 0,
    reply: { configured: true, sent: 1, failed: 0 },
    known: ["contabo"],
    ...over,
  };
  auto._reset();
  auto.__setDeps({
    now: () => w.now,
    autoFarm: () => w.af,
    holderHost: async () => "contabo",
    hostKnown: (host) => w.known.includes(host),
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
      w.tries++;
      if (w.provisionError) throw new Error(w.provisionError);
      const n = 61 + w.made.length;
      const file = "config_" + n + ".json";
      w.made.push({ host, file, capacity });
      return { host, file, container: "twitchbotx" + n, capacity: w.capacityError ? 10 : capacity, capacityError: w.capacityError || "" };
    },
    lastBlockedAt: async (reason) => w.blockedAt[reason] || 0,
    lastFailedAt: async () => w.failedAt,
    logEvent: async (e) => {
      if (w.logError) throw new Error(w.logError);
      w.events.push(e);
      if (e.action === "rent_farm_stack_blocked") w.blockedAt[e.meta.reason] = w.now;
      if (e.action === "rent_farm_stack_add_failed") w.failedAt = w.now;
    },
    send: async (t) => {
      w.sent.push(t);
      return w.reply;
    },
  });
  return w;
}
const SHORT = { snap: snapOf(), runway: RUNWAY };
// The slots have to read short twice in a row: this is the second reading.
async function confirmed(input = SHORT) {
  const first = await auto.checkOnce(input);
  assert.equal(first.added, false);
  assert.match(first.why, /confirming on the next reading before adding/);
  return auto.checkOnce(input);
}

test("switched off it reads nothing and changes nothing", async () => {
  const w = world({ af: {} });
  auto.__setDeps({
    holderHost: async () => {
      throw new Error("must not be read while off");
    },
  });
  assert.deepEqual(await auto.checkOnce(SHORT), { added: false, why: "off" });
  assert.deepEqual([w.made, w.events, w.sent], [[], [], []]);
});

test("REGRESSION: short on two readings in a row — one 50-slot stack is made, logged and announced", async () => {
  const w = world();
  const first = await auto.checkOnce(SHORT);
  assert.equal(first.added, false);
  assert.match(first.why, /91 slot\(s\) free.*confirming on the next reading before adding/);
  assert.deepEqual([w.made, w.reads, w.sent], [[], [], []], "one short reading makes nothing and asks the host nothing");

  const r = await auto.checkOnce(SHORT);
  assert.equal(r.added, true);
  assert.deepEqual(w.made, [{ host: "contabo", file: "config_61.json", capacity: 50 }]);
  assert.deepEqual([r.host, r.file, r.container, r.capacity], ["contabo", "config_61.json", "twitchbotx61", 50]);
  assert.equal(w.events.length, 1);
  assert.equal(w.events[0].action, "rent_farm_stack_added");
  assert.equal(w.events[0].subject, "contabo/config_61.json");
  assert.equal(w.events[0].count, 50);
  assert.equal(w.sent.length, 1);
  assert.match(w.sent[0], /contabo\/config_61\.json \(50 slots\) — free slots were 91, about 5\.2 day\(s\) at ~17\.4 a day; now 141/);
  assert.match(w.sent[0], /starts with its first order/);
  assert.deepEqual(w.reads, ["addedSince:contabo:1", "hostFreeMb:contabo"], "the last 24 h on that host, and its memory");
});

test("REGRESSION: one reading with a stack missing from the listing makes no stack", async () => {
  // A config that could not be read this tick is simply absent from the
  // listing, so 141 free reads as 91. The next reading is whole again.
  const w = world();
  const whole = { snap: snapOf({ stackFree: 400, totalFree: 400 }), runway: { slotDays: 23, netSlotsPerDay: 17.4 } };
  await auto.checkOnce(SHORT);
  const r = await auto.checkOnce(whole);
  assert.equal(r.added, false);
  assert.match(r.why, /enough room/);
  // ... and that reading cleared the count: a later short one starts over.
  const again = await auto.checkOnce(SHORT);
  assert.match(again.why, /confirming on the next reading/);
  assert.deepEqual(w.made, []);
  // A tick that could not be judged at all neither counts nor clears.
  await auto.checkOnce({ snap: snapOf({ withheld: true }), runway: RUNWAY });
  assert.equal((await auto.checkOnce(SHORT)).added, true);
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
  for (let i = 0; i < 7; i++) results.push((await tick()).added);
  // confirm, then 91 -> 141 -> 191 -> 241 (13.9 days: still under 14), then the day's limit.
  assert.deepEqual(results, [false, true, true, true, false, false, false]);
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
  const r = await confirmed(short);
  assert.equal(r.added, false);
  assert.equal(r.paged, true);
  assert.equal(r.reason, "daily-limit");
  assert.match(w.sent[0], /needs another rental stack and none was added: 3 stack\(s\) were already added/);
  w.now += HALF_HOUR;
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
  let r = await confirmed();
  assert.equal(r.added, false);
  assert.equal(r.paged, true);
  assert.deepEqual(w.made, []);
  assert.match(w.sent[0], /none was added: contabo has 900 MB of memory free/);
  assert.equal(w.events[0].action, "rent_farm_stack_blocked");
  assert.deepEqual(w.events[0].meta, { reason: "memory" });

  w.now += HALF_HOUR;
  r = await auto.checkOnce(SHORT);
  assert.equal(r.paged, undefined);
  assert.equal(w.sent.length, 1);

  // A restart forgets the in-memory latch; the event does not.
  const w2 = world({ freeMb: 900, now: w.now + HOUR, blockedAt: { ...w.blockedAt } });
  await confirmed();
  assert.equal(w2.sent.length, 0);
  w2.now = w.blockedAt.memory + DAY + 1000;
  await auto.checkOnce(SHORT);
  assert.equal(w2.sent.length, 1, "and again a day later while it lasts");
});

test("REGRESSION: a reason Telegram did not take is said again on the next tick, and only then counts as said", async () => {
  const w = world({ freeMb: 900, reply: { configured: true, sent: 0, failed: 1, reasons: ["ETIMEDOUT"] } });
  let r = await confirmed();
  assert.equal(r.paged, undefined);
  assert.equal(w.sent.length, 1, "it was tried");
  assert.deepEqual(w.events, [], "and not recorded as said");
  assert.deepEqual(w.blockedAt, {});

  w.reply = { configured: true, sent: 1, failed: 0 };
  w.now += HALF_HOUR;
  r = await auto.checkOnce(SHORT);
  assert.equal(r.paged, true);
  assert.equal(w.sent.length, 2);
  w.now += HALF_HOUR;
  await auto.checkOnce(SHORT);
  assert.equal(w.sent.length, 2, "once it went, not again that day");
});

test("REGRESSION: each reason has its own day — a failed add is said although memory was said that morning", async () => {
  const w = world({ freeMb: 900 });
  await confirmed();
  assert.match(w.sent[0], /900 MB of memory free/);
  // Memory recovers; now the add itself fails.
  w.freeMb = 6614;
  w.provisionError = "Failed to update compose file: ssh timed out";
  w.now += 2 * HOUR;
  const r = await auto.checkOnce(SHORT);
  assert.equal(r.reason, "add-failed");
  assert.equal(r.paged, true);
  assert.equal(w.sent.length, 2);
  assert.match(w.sent[1], /adding a stack on contabo failed: Failed to update compose file: ssh timed out The next try is in 6 h/);
});

test("the once-a-day reason does not repeat every tick when its event cannot be written", async () => {
  const w = world({ freeMb: 900, logError: "mongo is down" });
  for (let i = 0; i < 5; i++) {
    await auto.checkOnce(SHORT);
    w.now += HALF_HOUR;
  }
  assert.equal(w.sent.length, 1, "this process remembers that it said it");
});

test("REGRESSION: a failed add is reported, nothing is announced as added, and it is not tried again for 6 hours", async () => {
  const w = world({ provisionError: "Failed to update compose file: ssh timed out" });
  const r = await confirmed();
  assert.equal(r.added, false);
  assert.match(r.why, /adding a stack failed: Failed to update compose file/);
  assert.equal(w.tries, 1);
  assert.deepEqual(w.events.map((e) => e.action), ["rent_farm_stack_add_failed", "rent_farm_stack_blocked"]);
  assert.equal(w.events.filter((e) => e.action === "rent_farm_stack_added").length, 0);

  // Every try costs a slot number and leaves a rolled-back config behind.
  for (let i = 0; i < 11; i++) {
    w.now += HALF_HOUR;
    const again = await auto.checkOnce(SHORT);
    assert.match(again.why, /the last attempt to add a stack failed \d+ min ago — the next try is 6 h after it/);
  }
  assert.equal(w.tries, 1, "5.5 hours later: still one try");

  // A restart inside the six hours does not try sooner (the event remembers).
  const w2 = world({ provisionError: "still broken", now: w.now, failedAt: w.failedAt });
  await confirmed();
  assert.equal(w2.tries, 0);
  w2.now = w.failedAt + 6 * HOUR + 1000;
  await auto.checkOnce(SHORT);
  assert.equal(w2.tries, 1, "after six hours it tries once more");

  // And once the host is well again, the next try makes the stack.
  const w3 = world({ now: w2.now + 7 * HOUR, failedAt: w2.failedAt });
  assert.equal((await confirmed()).added, true);
  assert.equal(w3.made.length, 1);
});

test("a failed add is not retried every tick even when its event cannot be written", async () => {
  const w = world({ provisionError: "ssh timed out", logError: "mongo is down" });
  await confirmed();
  for (let i = 0; i < 6; i++) {
    w.now += HALF_HOUR;
    await auto.checkOnce(SHORT);
  }
  assert.equal(w.tries, 1, "this process remembers the failure");
  assert.equal(w.failedAt, 0, "although nothing could be recorded");
});

test("a stack whose capacity did not take is still counted and said — with what it really holds", async () => {
  const w = world({ capacityError: "MongoNetworkError: connection closed" });
  const r = await confirmed();
  assert.equal(r.added, true);
  assert.equal(r.capacity, 10);
  assert.equal(r.capacityError, "MongoNetworkError: connection closed");
  assert.equal(w.events[0].action, "rent_farm_stack_added");
  assert.equal(w.events[0].count, 10);
  assert.equal(w.events[0].severity, "warn");
  assert.match(w.sent[0], /config_61\.json \(10 slots\) — free slots were 91.*now 101/);
  assert.match(w.sent[0], /Its capacity could not be set to 50 \(MongoNetworkError: connection closed\): it holds 10 until that is set on the Renters page/);
});

test("a host named in settings wins over where the holder sits; quiet mode sends nothing", async () => {
  const w = world({ af: { ...ON, rentFarmAutoStackHost: "hetzner", rentFarmAutoStackCapacity: 80 }, known: ["contabo", "hetzner"] });
  auto.__setDeps({
    holderHost: async () => {
      throw new Error("not needed when a host is named");
    },
  });
  await auto.checkOnce({ ...SHORT, notify: false });
  const r = await auto.checkOnce({ ...SHORT, notify: false });
  assert.equal(r.added, true);
  assert.deepEqual(w.made, [{ host: "hetzner", file: "config_61.json", capacity: 80 }]);
  assert.equal(w.sent.length, 0);
  assert.equal(w.events.length, 1, "still on the record");
});

test("REGRESSION: a host name the server does not know is said at once, not silently never acted on", async () => {
  const w = world({ af: { ...ON, rentFarmAutoStackHost: "Contabo VPS" } });
  const r = await auto.checkOnce(SHORT);
  assert.equal(r.added, false);
  assert.equal(r.reason, "unknown-host");
  assert.equal(r.paged, true);
  assert.match(w.sent[0], /the bot host "Contabo VPS" is not in this server's host list/);
  assert.deepEqual([w.reads, w.tries], [[], 0], "its memory is not asked for and nothing is tried");
});

// ---------------------------------------------------------------------------
// The real two calls, with the modules they reach stubbed
// ---------------------------------------------------------------------------
test("the real add: provisionEmptyConfig on the resolved host, then setStackCapacity by host id", async () => {
  const calls = [];
  let capacityReply = () => ({ host: "contabo", file: "config_61.json", capacity: 50 });
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent && /utils[\\/]rentFarmAutoStack\.js$/.test(parent.filename || "")) {
      if (request === "./botHosts") {
        return { resolveHost: (id) => (id === "contabo" ? { id: "contabo", runtime: "docker", dir: "/bots" } : null) };
      }
      if (request === "../routes/botConfigRoutes") {
        return {
          provisionEmptyConfig: async (host) => {
            calls.push(["provisionEmptyConfig", host.id, typeof host]);
            return { host: host.id, file: "config_61.json", container: "twitchbotx61" };
          },
        };
      }
      if (request === "./renterBotStacks") {
        return {
          DEFAULT_CAPACITY: 10,
          setStackCapacity: async (host, file, capacity) => {
            calls.push(["setStackCapacity", host, file, capacity]);
            return capacityReply();
          },
        };
      }
    }
    return realLoad.call(this, request, parent, isMain);
  };
  try {
    const real = auto.__real;
    assert.equal(real.hostKnown("contabo"), true);
    assert.equal(real.hostKnown("Contabo VPS"), false);
    await assert.rejects(() => real.provision("Contabo VPS", 50), /unknown bot host Contabo VPS/);
    assert.deepEqual(calls, [], "nothing is made on a host that does not resolve");

    assert.deepEqual(await real.provision("contabo", 50), {
      host: "contabo", file: "config_61.json", container: "twitchbotx61", capacity: 50, capacityError: "",
    });
    assert.deepEqual(calls, [
      ["provisionEmptyConfig", "contabo", "object"],
      ["setStackCapacity", "contabo", "config_61.json", 50],
    ]);

    // The stack exists even when its capacity does not take: it holds the default.
    capacityReply = () => null;
    let made = await real.provision("contabo", 50);
    assert.deepEqual([made.capacity, made.capacityError], [10, "its registry row was not found"]);
    capacityReply = () => {
      throw new Error("connection closed");
    };
    made = await real.provision("contabo", 50);
    assert.deepEqual([made.file, made.capacity, made.capacityError], ["config_61.json", 10, "connection closed"]);
  } finally {
    Module._load = realLoad;
  }
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
    assert.deepEqual(
      seen[0].snap.stacks.map((s) => [s.file, s.used, s.running]),
      [["config_58.json", 9, true], ["config_59.json", 0, false]],
      "what the stack count and the not-yet-started count are taken from",
    );
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
