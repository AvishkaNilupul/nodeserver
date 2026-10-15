// Code shop — the owner releases a held code (utils/codeShop/held.js,
// docs/code-shop/05-REVIEW-FIXES.md R6).
//
// What must hold, because a released code goes back on sale:
// - only three problems can be lifted by hand ("stored code is missing or
//   changed", "its stock row is gone", "its code was shown in the farm panel");
// - the code is re-read and must match its fingerprint; a sold farm login, a
//   vault mark, or the code sitting in ANY stock row keeps it held;
// - a refused release changes nothing; a stock-row read failure is a 503;
// - the write is guarded, so a row that moved meanwhile is not released;
// - no code in anything it returns or logs.
//
// Real Mongo via mongodb-memory-server. Codes, logins and offers are made up.
process.env.CRED_SECRET ||= "code-shop-held-test";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const CodeStock = require("../models/CodeStock");
const SoopInventoryItem = require("../models/SoopInventoryItem");
const SoopAccount = require("../models/SoopAccount");
const SuppliedAccount = require("../models/SuppliedAccount");
const AccountOffer = require("../models/AccountOffer");
const secretBox = require("../utils/secretBox");
const slots = require("../utils/codeShop/slots");
const { createHeld, RELEASABLE, PROBLEMS, releasedWhy } = require("../utils/codeShop/held");
const { foreignProblem } = require("../utils/codeShop/foreign");

const ObjectId = mongoose.Types.ObjectId;
const NOW = Date.parse("2026-10-15T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const ALL = [CodeStock, SoopInventoryItem, SoopAccount, SuppliedAccount, AccountOffer];

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("codeshopheld"));
  await Promise.all(ALL.map((m) => m.init()));
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

test.beforeEach(async () => {
  await Promise.all(ALL.map((m) => m.deleteMany({})));
});

const ALL_CODES = new Set();
let seq = 0;
function newCode() {
  seq += 1;
  const code = `HL${String(seq).padStart(2, "0")}-PLMK-OIJNB-UHYG-TFCV`;
  ALL_CODES.add(code);
  return code;
}

function fakeEvents() {
  const logs = [];
  return {
    logs,
    async log(e) {
      logs.push(e);
      return true;
    },
  };
}

function makeHeld(extra = {}) {
  const events = fakeEvents();
  const held = createHeld({ secret: secretBox, now: () => NOW, events, ...extra });
  return { held, events };
}

// A held ledger row with its inventory row. `stored` is what the farm holds now.
async function heldRow(problem, opts = {}) {
  const code = opts.code || newCode();
  const loginId = opts.loginId || "farm-" + seq;
  const itemKey = "item-" + seq;
  const stored = opts.stored === undefined ? code : opts.stored;
  if (stored !== null) {
    await SoopInventoryItem.create({ loginId, key: itemKey, kind: "code", hasCode: true, codeEnc: secretBox.encrypt(stored) });
  }
  const row = await CodeStock.create({
    loginId,
    itemKey,
    gameNo: "12",
    gameName: "Overwatch 2",
    slotKey: "12:1001:abc:1",
    name: "Sun Tea Player Icon",
    codeHash: opts.codeHash === undefined ? slots.hashCode(code) : opts.codeHash,
    codeShape: slots.codeShape(code),
    state: opts.state || "held",
    problem,
    wasFed: opts.wasFed === true,
    unit: opts.unit || null,
    product: opts.unit ? new ObjectId() : null,
    unitStatus: opts.unit ? "available" : "",
    useBy: new Date(NOW + 20 * DAY),
    history: [{ at: new Date(NOW - DAY), from: "in_unit", to: opts.state || "held", why: problem }],
  });
  return { id: row._id, code };
}

async function stockRow(password, fields = {}) {
  const offer = await AccountOffer.create({ title: "Hand-made listing", game: "Overwatch", status: "active", priceUsd: 2 });
  seq += 1;
  return SuppliedAccount.create({ offer: offer._id, login: "owkey-" + seq, password: secretBox.encrypt(password), status: "available", ...fields });
}

const lean = (id) => CodeStock.findById(id).lean();

function assertNoCode(...values) {
  for (const v of values) {
    const json = JSON.stringify(v);
    for (const code of ALL_CODES) {
      assert.ok(!json.includes(code), "a plaintext code leaked");
      assert.ok(!json.includes(code.replace(/-/g, "")), "a plaintext code leaked (no dashes)");
    }
    assert.ok(!json.includes("OIJNB"), "part of a plaintext code leaked");
  }
}

async function refused(promise, status, re) {
  let error = null;
  await assert.rejects(promise, (err) => {
    error = err;
    assert.equal(err.status, status, "status of: " + err.message);
    if (re) assert.match(err.message, re);
    return true;
  });
  assertNoCode(error.message);
  return error;
}

// ── releases ────────────────────────────────────────────────────────────────

test("the three releasable problems, exactly", () => {
  assert.deepEqual([...RELEASABLE].sort(), [
    "its code was shown in the farm panel",
    "its stock row is gone",
    "stored code is missing or changed",
  ]);
  assert.equal(PROBLEMS.revealed, "its code was shown in the farm panel");
  assert.equal(releasedWhy(PROBLEMS.revealed), "released by the owner (was: its code was shown in the farm panel)");
});

test("release: each releasable code goes back to stock, unlinked, with a history line and a warn event", async () => {
  const { held, events } = makeHeld();
  const unit = new ObjectId();
  const rows = [
    await heldRow(PROBLEMS.codeCheck),
    await heldRow(PROBLEMS.unitGone, { unit }),
    await heldRow(PROBLEMS.revealed),
  ];
  const problems = [PROBLEMS.codeCheck, PROBLEMS.unitGone, PROBLEMS.revealed];

  for (const [i, r] of rows.entries()) {
    const res = await held.release(String(r.id), { actor: "owner" });
    assert.equal(res.released, problems[i]);
    assert.equal(String(res.row._id), String(r.id));
    assert.equal(res.row.state, "in_stock");
    assert.equal(res.row.problem, "");
    assert.equal(res.row.codeShape, slots.codeShape(r.code));
    assert.equal(res.row.gameName, "Overwatch 2");
    assert.ok(!("codeHash" in res.row), "the fingerprint is not handed out either");

    const row = await lean(r.id);
    assert.equal(row.state, "in_stock");
    assert.equal(row.problem, "");
    assert.equal(row.unit, null);
    assert.equal(row.product, null);
    assert.equal(row.offer, null);
    assert.equal(row.unitStatus, "");
    assert.equal(row.codeHash, slots.hashCode(r.code), "the fingerprint is kept");
    const h = row.history.at(-1);
    assert.deepEqual({ from: h.from, to: h.to, why: h.why, at: h.at.getTime() }, { from: "held", to: "in_stock", why: releasedWhy(problems[i]), at: NOW });
  }
  const logs = events.logs.filter((e) => e.kind === "held-release");
  assert.equal(logs.length, 3);
  assert.ok(logs.every((e) => e.level === "warn" && e.data.by === "owner"));
  assert.match(logs[1].msg, /its stock row is gone/);
  assertNoCode(events.logs);
});

// ── refusals: nothing changes ───────────────────────────────────────────────

test("refused: a bad id, an unknown row, a row that is not held", async () => {
  const { held } = makeHeld();
  await refused(held.release("nope"), 400);
  await refused(held.release(String(new ObjectId())), 404);
  const inStock = await heldRow("", { state: "in_stock" });
  await refused(held.release(String(inStock.id)), 409, /Only a held code/);
  assert.equal((await lean(inStock.id)).state, "in_stock");
});

test("refused: every other problem stays held whatever the owner says", async () => {
  const { held, events } = makeHeld();
  const others = [
    "its farm login was sold",
    "same code as another stored code",
    foreignProblem(new ObjectId()),
    "was in a platform vault and came back; it may already be sold",
    "was in a removed unit of an adopted offer that went out through a market; it may already be sold",
    "",
  ];
  for (const problem of others) {
    const r = await heldRow(problem);
    const before = await lean(r.id);
    await refused(held.release(String(r.id), { actor: "owner" }), 409, /cannot be released by hand/);
    assert.deepEqual(await lean(r.id), before, problem);
  }
  assert.equal(events.logs.length, 0);
});

test("refused: ever in a platform vault, or no fingerprint", async () => {
  const { held } = makeHeld();
  const fed = await heldRow(PROBLEMS.unitGone, { wasFed: true, unit: new ObjectId() });
  await refused(held.release(String(fed.id)), 409, /platform vault/);
  assert.equal((await lean(fed.id)).state, "held");
  const noHash = await heldRow(PROBLEMS.codeCheck, { codeHash: "" });
  await refused(held.release(String(noHash.id)), 409, /no fingerprint/);
  assert.equal((await lean(noHash.id)).state, "held");
});

test("refused: the farm login was sold since", async () => {
  const { held } = makeHeld();
  const r = await heldRow(PROBLEMS.revealed, { loginId: "farm-sold" });
  await SoopAccount.create({ loginId: "farm-sold", sold: true });
  await refused(held.release(String(r.id)), 409, /farm login was sold/);
  assert.equal((await lean(r.id)).state, "held");
});

test("refused: the stored code is still missing, unreadable or another code", async () => {
  const { held } = makeHeld();
  const changed = await heldRow(PROBLEMS.codeCheck, { stored: newCode() });
  const missing = await heldRow(PROBLEMS.codeCheck, { stored: null });
  const blank = await heldRow(PROBLEMS.codeCheck, { stored: "   " });
  for (const r of [changed, missing, blank]) {
    await refused(held.release(String(r.id)), 409, /still missing or does not match/);
    assert.equal((await lean(r.id)).state, "held");
  }
  // The inventory row cannot be read.
  const broken = createHeld({
    secret: secretBox,
    now: () => NOW,
    models: { SoopInventoryItem: { findOne: () => ({ lean: () => Promise.reject(new Error("db down")) }) } },
  });
  const r = await heldRow(PROBLEMS.revealed);
  await refused(broken.release(String(r.id)), 409, /still missing/);
  assert.equal((await lean(r.id)).state, "held");
});

test("refused: the code sits in a stock row of any listing (any status, any field)", async () => {
  const { held } = makeHeld();
  const cases = [
    async (code) => stockRow(`1) Reward = ${code}`),
    async (code) => stockRow("nothing", { status: "removed", extra: secretBox.encrypt(code) }),
    async (code) => stockRow("nothing", { status: "sold", login: code }),
    async (code) => stockRow("nothing", { status: "fed", email: secretBox.encrypt(code) }),
  ];
  for (const place of cases) {
    const r = await heldRow(PROBLEMS.revealed);
    await place(r.code);
    await refused(held.release(String(r.id)), 409, /sits in 1 stock row of a listing/);
    assert.equal((await lean(r.id)).state, "held");
  }
});

test("refused (503): the stock rows cannot be read", async () => {
  const Broken = {
    find() {
      throw new Error("connection reset");
    },
  };
  const { held } = makeHeld({ models: { SuppliedAccount: Broken } });
  const r = await heldRow(PROBLEMS.unitGone, { unit: new ObjectId() });
  await refused(held.release(String(r.id)), 503, /could not be read; nothing was released/);
  assert.equal((await lean(r.id)).state, "held");
});

test("refused: the row moved between the checks and the write", async () => {
  const r = await heldRow(PROBLEMS.revealed);
  const Racy = new Proxy(CodeStock, {
    get(target, prop) {
      if (prop === "findOneAndUpdate") {
        return (filter, update, opts) => {
          // Another writer settles the row first.
          const first = target.updateOne({ _id: r.id }, { $set: { problem: "same code as another stored code" } });
          return {
            lean: async () => {
              await first;
              return target.findOneAndUpdate(filter, update, opts).lean();
            },
          };
        };
      }
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const { held, events } = makeHeld({ models: { CodeStock: Racy } });
  await refused(held.release(String(r.id)), 409, /changed while it was being released/);
  const row = await lean(r.id);
  assert.equal(row.state, "held");
  assert.equal(row.problem, "same code as another stored code");
  assert.equal(events.logs.length, 0);
});
