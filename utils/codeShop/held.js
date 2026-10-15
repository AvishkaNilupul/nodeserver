"use strict";
// Code shop — the owner releases a held code (docs/code-shop/05-REVIEW-FIXES.md, R6).
//
// A held code is one the shop will not sell on its own. Only three reasons
// can be lifted here, each one a fact the owner can vouch for:
// - "stored code is missing or changed" (units.js: its check failed while a
//   bundle was being built, so it never went into one);
// - "its stock row is gone" (reconcile.js: its unit disappeared);
// - "its code was shown in the farm panel" (ingest.js, R9).
// Anything else (a vault that may have sold it, a sold farm login, a duplicate
// code, another listing's stock row) stays held whatever the owner says.
//
// Before the release, every fact the shop CAN check is checked again:
// - the code is re-read from the farm inventory and must still match the
//   ledger's fingerprint;
// - its farm login is not sold, and it was never in a platform vault;
// - it is in no stock row of any listing (the foreign guard's own check, for
//   this one fingerprint, over every SuppliedAccount row of any status).
// The release itself is one update guarded by the state, problem and
// fingerprint that were checked, so a row that moved meanwhile is not touched.
//
// The code is decrypted only to compare its fingerprint; it is never returned,
// logged or stored. Errors carry an HTTP status (400/404/409/503).

const mongoose = require("mongoose");
const { hashCode } = require("./slots");
const { stockRowsHolding } = require("./foreign");

const ObjectId = mongoose.Types.ObjectId;
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;
const HISTORY_MAX = 20;

const PROBLEMS = Object.freeze({
  codeCheck: "stored code is missing or changed",
  unitGone: "its stock row is gone",
  revealed: "its code was shown in the farm panel",
});
const RELEASABLE = Object.freeze([PROBLEMS.codeCheck, PROBLEMS.unitGone, PROBLEMS.revealed]);
const RELEASED_WHY = "released by the owner";

// The history line of a release. ingest.js reads it back: a reveal older than
// the owner's release of "shown in the farm panel" is already vouched for.
function releasedWhy(problem) {
  return `${RELEASED_WHY} (was: ${String(problem || "")})`;
}

const ROW_FIELDS = {
  loginId: 1,
  itemKey: 1,
  itemId: 1,
  gameNo: 1,
  gameName: 1,
  slotKey: 1,
  name: 1,
  nameRaw: 1,
  codeHash: 1,
  codeShape: 1,
  state: 1,
  problem: 1,
  wasFed: 1,
  useBy: 1,
};

// Factories, not values: a test that passes its own models never loads these.
const REAL_MODELS = {
  CodeStock: () => require("../../models/CodeStock"),
  SoopInventoryItem: () => require("../../models/SoopInventoryItem"),
  SoopAccount: () => require("../../models/SoopAccount"),
  SuppliedAccount: () => require("../../models/SuppliedAccount"),
};

function modelOf(deps, name) {
  const given = deps && deps.models && deps.models[name];
  return given || REAL_MODELS[name]();
}

const text = (v) => (v === undefined || v === null ? "" : String(v));

function toObjectId(v) {
  const raw = v && typeof v === "object" && v._id ? v._id : v;
  if (raw instanceof ObjectId) return raw;
  const s = text(raw);
  return OBJECT_ID_HEX.test(s) ? new ObjectId(s) : null;
}

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function createHeld(deps = {}) {
  const M = (name) => modelOf(deps, name);
  const secret = deps.secret || require("../secretBox");
  const now = typeof deps.now === "function" ? deps.now : Date.now;

  async function note(entry) {
    try {
      if (deps.events && typeof deps.events.log === "function") await deps.events.log(entry);
    } catch {
      // the activity log is best-effort
    }
  }

  // The stored code still matches the fingerprint ingest took.
  async function codeStillMatches(row) {
    let plain = "";
    try {
      const inv = await M("SoopInventoryItem").findOne({ loginId: row.loginId, key: row.itemKey }, { codeEnc: 1 }).lean();
      if (!inv) return false;
      plain = text(secret.decrypt(text(inv.codeEnc))).trim();
    } catch {
      return false;
    }
    // Outside the try: a missing CRED_SECRET is a server fault, not "no match".
    return !!plain && hashCode(plain) === row.codeHash;
  }

  // -> { row, released } ; throws an error with a status for every refusal.
  async function release(rowId, { actor } = {}) {
    const id = toObjectId(rowId);
    if (!id) throw fail(400, "Unknown code id");
    const CodeStock = M("CodeStock");
    const row = await CodeStock.findById(id, ROW_FIELDS).lean();
    if (!row) throw fail(404, "No code with that id is in the ledger");
    if (row.state !== "held") throw fail(409, "Only a held code can be released");
    const problem = text(row.problem);
    if (!RELEASABLE.includes(problem)) {
      throw fail(409, `This code is held because ${problem ? `"${problem}"` : "of an unknown problem"}; that cannot be released by hand`);
    }
    if (row.wasFed === true) throw fail(409, "This code was in a platform vault, which may have sold it; it stays held");
    if (!text(row.codeHash)) throw fail(409, "This code has no fingerprint to check; it stays held");

    if (await M("SoopAccount").exists({ loginId: text(row.loginId), sold: true })) {
      throw fail(409, "Its farm login was sold (its buyer can see the code); it stays held");
    }
    if (!(await codeStillMatches(row))) {
      throw fail(409, "Its stored code is still missing or does not match its fingerprint; it stays held");
    }
    let holders;
    try {
      holders = await stockRowsHolding(row.codeHash, deps);
    } catch {
      throw fail(503, "The listings' stock rows could not be read; nothing was released");
    }
    if (holders.length) {
      throw fail(409, `Its code sits in ${holders.length} stock row${holders.length === 1 ? "" : "s"} of a listing; it stays held`);
    }

    const at = new Date(now());
    const by = text(actor).slice(0, 200);
    const why = releasedWhy(problem);
    const doc = await CodeStock.findOneAndUpdate(
      { _id: id, state: "held", problem, codeHash: row.codeHash, wasFed: { $ne: true } },
      {
        $set: { state: "in_stock", problem: "", unit: null, product: null, offer: null, unitStatus: "" },
        $push: { history: { $each: [{ at, from: "held", to: "in_stock", why }], $slice: -HISTORY_MAX } },
      },
      { returnDocument: "after", projection: ROW_FIELDS },
    ).lean();
    if (!doc) throw fail(409, "The code changed while it was being released; reload and try again");

    await note({
      level: "warn",
      kind: "held-release",
      product: null,
      msg: `${by || "The owner"} released a held code (${text(doc.codeShape)}) back to stock; it was held because ${problem}`,
      data: { row: String(id), problem, by },
    });
    // The fingerprint stays in the ledger: the panel needs none of it.
    const out = { ...doc };
    delete out.codeHash;
    delete out.wasFed;
    return { row: out, released: problem };
  }

  return { release };
}

module.exports = { createHeld, RELEASABLE, PROBLEMS, RELEASED_WHY, releasedWhy };
