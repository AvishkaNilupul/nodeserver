// scripts/reconcile-listing-status.js must never delist a row that is paused on
// purpose (2026-09-30).
//
// On 2026-09-09 `--market eldorado --apply` read offer 48a19c2e as "paused" and
// set its row delisted. The pause was the stock sync's own: the row was
// `autoPaused`, which keeps status "active" so the sync resumes it when stock
// returns. Delisted, it fell out of that loop — and since the 2026-09-30 fix
// nothing resumes a delisted row, so the listing was silently dropped from
// management. Bulk pack rows are the same case: their loop owns the pause.
//
// The REAL script runs here, end to end, as `node scripts/… --market eldorado`
// would run it, with its five requires stubbed: no database, no marketplace.
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const Module = require("node:module");

const SCRIPT = path.join(__dirname, "..", "scripts", "reconcile-listing-status.js");

function matches(row, filter) {
  return Object.entries(filter).every(([k, want]) => {
    const v = row[k] === undefined ? null : row[k];
    if (want && typeof want === "object" && "$ne" in want) return v !== want.$ne;
    return v === want;
  });
}

let world = null;
const STUBS = {
  dotenv: { config() {} },
  mongoose: {
    async connect() {},
    async disconnect() {
      world.done();
    },
  },
  "../models/MarketplaceListing": {
    find(filter) {
      const rows = world.rows.filter((r) => matches(r, filter)).map((r) => ({ ...r }));
      return { lean: async () => rows };
    },
    async updateOne(filter, update) {
      const row = world.rows.find((r) => matches(r, filter));
      if (!row) return { modifiedCount: 0 };
      world.writes.push({ id: row.externalId, set: update.$set });
      Object.assign(row, update.$set);
      return { modifiedCount: 1 };
    },
  },
  "../utils/marketplaces": {
    async eldoradoOffer(id) {
      world.reads.push(id);
      return { id, offerState: world.states[id] || "Active" };
    },
  },
  "../utils/systemLog": {
    async logEvent(e) {
      world.events.push(e);
    },
  },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && parent.filename === SCRIPT && request in STUBS) return STUBS[request];
  return origLoad.apply(this, arguments);
};

// Run the script once; resolves when it disconnects. Its 250 ms pacing between
// reads is collapsed and its report captured.
function runScript(args, { rows, states }) {
  return new Promise((resolve, reject) => {
    const saved = {
      argv: process.argv,
      exit: process.exit,
      log: console.log,
      error: console.error,
      setTimeout: global.setTimeout,
    };
    const restore = () => {
      process.argv = saved.argv;
      process.exit = saved.exit;
      console.log = saved.log;
      console.error = saved.error;
      global.setTimeout = saved.setTimeout;
    };
    world = {
      rows: rows.map((r) => ({ ...r })),
      states,
      reads: [],
      writes: [],
      events: [],
      lines: [],
      done: () => {
        restore();
        resolve(world);
      },
    };
    process.argv = ["node", SCRIPT, ...args];
    process.exit = (code) => {
      restore();
      reject(new Error("script exited " + code + ": " + world.lines.join(" / ")));
    };
    console.log = (...a) => world.lines.push(a.join(" "));
    console.error = (...a) => world.lines.push(a.join(" "));
    global.setTimeout = (cb, _ms, ...a) => saved.setTimeout(cb, 0, ...a);
    delete require.cache[SCRIPT];
    try {
      require(SCRIPT);
    } catch (e) {
      restore();
      reject(e);
    }
  });
}

const row = (externalId, over = {}) => ({
  _id: "row-" + externalId,
  marketplace: "eldorado",
  externalId,
  title: "Offer " + externalId,
  status: "active",
  origin: "manual",
  lastError: "",
  ...over,
});

// The 2026-09-09 picture: one row paused by the stock sync, one really drifted
// (paused on Eldorado by hand, our row never told), one live and in agreement.
const ROWS = [
  row("live"),
  row("48a19c2e", { autoPaused: true, lastError: "paused: no claimable stock" }),
  row("drift"),
  row("bulk", { bulkOfferId: "bulk-offer-1" }),
];
const STATES = { live: "Active", "48a19c2e": "Paused", drift: "Paused", bulk: "Paused" };

test("--apply never delists a row our own stock sync paused (48a19c2e, 2026-09-09)", async () => {
  const w = await runScript(["--market", "eldorado", "--apply"], { rows: ROWS, states: STATES });

  assert.ok(!w.reads.includes("48a19c2e"), "an autoPaused row is not even asked about");
  const r = w.rows.find((x) => x.externalId === "48a19c2e");
  assert.strictEqual(r.status, "active", "it stays in the stock sync's hands");
  assert.strictEqual(r.lastError, "paused: no claimable stock");
  // A genuine drift is still found and corrected exactly as before.
  assert.deepStrictEqual(w.writes.map((x) => x.id), ["drift"]);
  assert.strictEqual(w.rows.find((x) => x.externalId === "drift").status, "delisted");
  assert.strictEqual(w.events.length, 1);
  assert.strictEqual(w.events[0].count, 1);
  assert.doesNotMatch(w.events[0].detail, /48a19c2e|bulk/);
});

test("a bulk pack row is its loop's to manage, never judged here", async () => {
  const w = await runScript(["--market", "eldorado", "--apply"], { rows: ROWS, states: STATES });

  assert.ok(!w.reads.includes("bulk"));
  assert.strictEqual(w.rows.find((x) => x.externalId === "bulk").status, "active");
});

test("the report says how many rows it left alone, and a dry run writes nothing", async () => {
  const w = await runScript(["--market", "eldorado"], { rows: ROWS, states: STATES });

  assert.match(w.lines.join("\n"), /4 row\(s\) we call active, 2 of them paused by our own stock sync or bulk loop — not judged/);
  assert.match(w.lines.join("\n"), /1 row\(s\) drifted, 0 unreadable, 1 agree/);
  assert.match(w.lines.join("\n"), /DRY RUN — nothing changed/);
  assert.deepStrictEqual(w.writes, []);
  assert.deepStrictEqual(w.reads.sort(), ["drift", "live"]);
});
