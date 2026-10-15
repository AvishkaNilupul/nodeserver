"use strict";
// Code shop ingest (docs/code-shop/02-ENGINE.md, "ingest.js"): every reward
// code the farm has stored (SoopInventoryItem kind "code" with hasCode) gets
// exactly one ledger row (CodeStock), identified by the inventory row's
// { loginId, key } — inventory ids can change, that pair does not.
//
// The code itself is decrypted only to hash it (codeHash: catches the same code
// stored twice) and to measure its shape (codeShape: safe to show). It is never
// stored, logged or returned: run() hands back counts, the event carries counts.
//
// What ingest may change on a row that already exists: its metadata, and its
// group/slot only while it is still in_stock (a code already in a unit keeps
// the slot it was sold under). Never state, unit or codeHash — with one
// exception from the contract: an in_stock row of a farm login that was sold
// (the login now belongs to a buyer, who can see its inventory) becomes held.

const slots = require("./slots");

// Bounded writes: one ledger read and at most this many writes per round trip.
const BATCH = 500;
// utils/soop/inventory.js keeps claim.dropsName cut to 200 characters, so a
// longer campaign title is compared by the same first 200.
const DROPS_NAME_MAX = 200;
const SOLD_PROBLEM = "its farm login was sold";
const DUP_PROBLEM = "same code as another stored code";
const HISTORY_MAX = 20;

// codeEnc is read only to decrypt a NEW identity's code; nothing else in the
// raw / claim objects is needed.
const INV_FIELDS =
  "loginId key gameNo gameName name nameRaw image sentAt division expiresAt raw.useExpDate claim.dropsName codeEnc";
const LEDGER_FIELDS =
  "loginId itemKey state itemId gameName name image campaignTitle campaignIdx campaignEndAt useBy groupKey slotKey";
const CAMPAIGN_FIELDS = "dropsIdx title titleRaw startDate endDate gameNo";

const text = (v) => (v === undefined || v === null ? "" : String(v));
const leanOf = (q) => (q && typeof q.lean === "function" ? q.lean() : q);

function msOf(v) {
  if (v === undefined || v === null || v === "") return null;
  const ms = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(ms) ? ms : null;
}

function dateOf(v) {
  const ms = msOf(v);
  return ms === null ? null : new Date(ms);
}

// JSON keeps ("a|b", "c") and ("a", "b|c") apart.
const identityOf = (loginId, itemKey) => JSON.stringify([text(loginId), text(itemKey)]);
const isDuplicateKey = (code) => code === 11000 || code === 11001;

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// Numeric ids compare as numbers ("9" before "10"), anything else as text.
function cmpIdx(a, b) {
  const x = text(a);
  const y = text(b);
  if (/^\d+$/.test(x) && /^\d+$/.test(y) && x.length !== y.length) return x.length - y.length;
  return x < y ? -1 : x > y ? 1 : 0;
}

// Several stored campaigns can carry the same name (a re-run event). Take the
// latest one that had started when the code was earned; with no earn date, or
// none started by then, the earliest. A campaign that appears later never
// starts before an already earned code, so a row's campaign does not move.
function pickCampaign(list, earnedMs) {
  if (list.length === 1) return list[0];
  const sorted = list.slice().sort((a, b) => {
    const sa = msOf(a.startDate);
    const sb = msOf(b.startDate);
    const x = sa === null ? -Infinity : sa;
    const y = sb === null ? -Infinity : sb;
    if (x !== y) return x < y ? -1 : 1;
    return cmpIdx(a.dropsIdx, b.dropsIdx);
  });
  if (earnedMs === null) return sorted[0];
  let pick = null;
  for (const c of sorted) {
    const s = msOf(c.startDate);
    if (s === null || s <= earnedMs) pick = c;
  }
  return pick || sorted[0];
}

// The driver's write errors after an unordered insert, as [{ index, code }];
// null when the error is not a per-document write failure.
function writeErrorsOf(err) {
  if (!err) return null;
  if (Array.isArray(err.validationErrors) && err.validationErrors.length) return null;
  if (err.mongoose && Array.isArray(err.mongoose.validationErrors) && err.mongoose.validationErrors.length) return null;
  const raw = err.writeErrors;
  if (!raw) return null;
  const list = Array.isArray(raw) ? raw : [raw];
  if (!list.length) return null;
  return list.map((we) => {
    const inner = (we && we.err) || {};
    return {
      index: we && Number.isInteger(we.index) ? we.index : inner.index,
      code: we && we.code !== undefined ? we.code : inner.code,
    };
  });
}

function createIngest(deps = {}) {
  const models = deps.models || {};
  // Resolved on first use so a test can pass its own models and the real ones
  // never have to load.
  const model = (name) => models[name] || require("../../models/" + name);
  const secret = deps.secret || require("../secretBox");
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const events = deps.events || null;

  // Unordered insert. -> { ok: [doc], dup: [doc] }: dup = refused by a unique
  // index. Any other failure is thrown (rows that did go in stay; the next run
  // sees them as existing).
  async function insertSome(docs) {
    if (!docs.length) return { ok: [], dup: [] };
    try {
      await model("CodeStock").insertMany(docs, { ordered: false, throwOnValidationError: true });
      return { ok: docs, dup: [] };
    } catch (err) {
      const wes = writeErrorsOf(err);
      if (!wes) throw err;
      const failed = new Set();
      for (const we of wes) {
        if (!isDuplicateKey(we.code) || !Number.isInteger(we.index)) throw err;
        failed.add(we.index);
      }
      return {
        ok: docs.filter((_, i) => !failed.has(i)),
        dup: docs.filter((_, i) => failed.has(i)),
      };
    }
  }

  // Which of these docs' identities exist in the ledger now.
  async function existingIdentities(docs) {
    const found = new Set();
    for (const part of chunks(docs, BATCH)) {
      const rows = await leanOf(
        model("CodeStock")
          .find({
            loginId: { $in: [...new Set(part.map((d) => d.loginId))] },
            itemKey: { $in: [...new Set(part.map((d) => d.itemKey))] },
          })
          .select("loginId itemKey"),
      );
      for (const r of rows || []) found.add(identityOf(r.loginId, r.itemKey));
    }
    return found;
  }

  async function soldLogins() {
    const rows = await leanOf(model("SoopAccount").find({ sold: true }).select("loginId"));
    return new Set((rows || []).map((r) => text(r.loginId)).filter(Boolean));
  }

  // A sold login belongs to a buyer now, and the buyer can open its inventory:
  // its free codes can no longer be sold safely.
  async function holdSoldLogins(logins, at) {
    let held = 0;
    for (const part of chunks([...logins], BATCH)) {
      const res = await model("CodeStock").updateMany(
        { loginId: { $in: part }, state: "in_stock" },
        {
          $set: { state: "held", problem: SOLD_PROBLEM },
          $push: { history: { $each: [{ at, from: "in_stock", to: "held", why: SOLD_PROBLEM }], $slice: -HISTORY_MAX } },
        },
      );
      held += (res && res.modifiedCount) || 0;
    }
    return held;
  }

  // (gameNo, name) -> campaigns, by titleRaw and by title.
  async function campaignIndex(rows) {
    const byRaw = new Map();
    const byTitle = new Map();
    const games = new Set();
    for (const r of rows) if (r.dropsName) games.add(r.gameNo);
    if (!games.size) return { byRaw, byTitle };
    const values = [...games];
    // An inventory row with no game matches a campaign with no game.
    const filter = values.includes("") ? { $in: [...values, null] } : { $in: values };
    const list = await leanOf(model("SoopCampaign").find({ gameNo: filter }).select(CAMPAIGN_FIELDS));
    const add = (map, gameNo, name, c) => {
      const n = text(name).slice(0, DROPS_NAME_MAX);
      if (!n) return; // an empty title must never match an empty dropsName
      const k = JSON.stringify([gameNo, n]);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(c);
    };
    for (const c of list || []) {
      if (!c || !text(c.dropsIdx)) continue;
      const g = text(c.gameNo);
      add(byRaw, g, c.titleRaw, c);
      add(byTitle, g, c.title, c);
    }
    return { byRaw, byTitle };
  }

  function campaignOf(index, row) {
    if (!row.dropsName) return null;
    const k = JSON.stringify([row.gameNo, row.dropsName.slice(0, DROPS_NAME_MAX)]);
    const list = index.byRaw.get(k) || index.byTitle.get(k);
    return list ? pickCampaign(list, msOf(row.earnedAt)) : null;
  }

  // An inventory row -> what the ledger should say about it (no code here).
  function describe(inv) {
    const claim = inv.claim && typeof inv.claim === "object" ? inv.claim : {};
    return {
      loginId: text(inv.loginId),
      itemKey: text(inv.key),
      itemId: inv._id || null,
      gameNo: text(inv.gameNo),
      gameName: text(inv.gameName),
      // A row with no raw name falls back to its translated one, so two
      // different rewards of one campaign never share a slot.
      nameRaw: text(inv.nameRaw) || text(inv.name),
      name: text(inv.name),
      image: text(inv.image),
      earnedAt: dateOf(inv.sentAt),
      useBy: slots.useByOf(inv),
      dropsName: text(claim.dropsName),
      codeEnc: inv.codeEnc,
    };
  }

  // The $set for an existing ledger row, or null when nothing changed.
  function updateOf(cur, row) {
    const set = {};
    if (text(cur.itemId) !== text(row.itemId)) set.itemId = row.itemId;
    for (const f of ["gameName", "name", "image", "campaignTitle", "campaignIdx"]) {
      if (text(cur[f]) !== row[f]) set[f] = row[f];
    }
    for (const f of ["campaignEndAt", "useBy"]) {
      if (msOf(cur[f]) !== msOf(row[f])) set[f] = row[f];
    }
    const regroup = cur.state === "in_stock" && (text(cur.groupKey) !== row.groupKey || text(cur.slotKey) !== row.slotKey);
    if (regroup) {
      set.groupKey = row.groupKey;
      set.slotKey = row.slotKey;
    }
    if (!Object.keys(set).length) return null;
    // A group/slot move is guarded by the state it was decided on: a row that
    // went into a unit meanwhile keeps its slot (its metadata waits a run).
    const filter = regroup ? { _id: cur._id, state: "in_stock" } : { _id: cur._id };
    return { updateOne: { filter, update: { $set: set } } };
  }

  function ledgerDoc(row, extra) {
    return {
      loginId: row.loginId,
      itemKey: row.itemKey,
      itemId: row.itemId,
      gameNo: row.gameNo,
      gameName: row.gameName,
      groupKey: row.groupKey,
      campaignIdx: row.campaignIdx,
      campaignTitle: row.campaignTitle,
      campaignEndAt: row.campaignEndAt,
      slotKey: row.slotKey,
      nameRaw: row.nameRaw,
      name: row.name,
      image: row.image,
      earnedAt: row.earnedAt,
      useBy: row.useBy,
      ...extra,
    };
  }

  function heldDoc(row, codeShape, at) {
    return ledgerDoc(row, {
      codeHash: "",
      codeShape,
      state: "held",
      problem: DUP_PROBLEM,
      history: [{ at, from: "", to: "held", why: DUP_PROBLEM }],
    });
  }

  // The code is decrypted here and nowhere else; only its hash and shape leave.
  function readCode(row) {
    let code = "";
    try {
      const plain = secret.decrypt(row.codeEnc);
      code = plain === undefined || plain === null ? "" : String(plain).trim();
    } catch {
      code = ""; // unreadable reads as missing: skipped, retried next run
    }
    if (!code) return null;
    return { hash: slots.hashCode(code), shape: slots.codeShape(code) };
  }

  async function batchRun(batch, ctx) {
    const { out, at, nowMs, seen, tally } = ctx;
    const CodeStock = model("CodeStock");

    const current = await leanOf(
      CodeStock.find({
        loginId: { $in: [...new Set(batch.map((r) => r.loginId))] },
        itemKey: { $in: [...new Set(batch.map((r) => r.itemKey))] },
      }).select(LEDGER_FIELDS),
    );
    const byIdentity = new Map();
    for (const c of current || []) byIdentity.set(identityOf(c.loginId, c.itemKey), c);

    const updates = [];
    const fresh = [];
    for (const row of batch) {
      const cur = byIdentity.get(identityOf(row.loginId, row.itemKey));
      if (!cur) {
        fresh.push(row);
        continue;
      }
      const op = updateOf(cur, row);
      if (op) updates.push(op);
    }
    if (updates.length) {
      const res = await CodeStock.bulkWrite(updates, { ordered: false });
      out.updated += (res && res.modifiedCount) || 0;
    }

    const docs = [];
    const held = [];
    for (const row of fresh) {
      const code = readCode(row);
      row.codeEnc = undefined; // nothing encrypted kept past this point
      if (!code) {
        out.skipped += 1;
        continue;
      }
      // The first copy of a code in this run goes to stock; a later copy is
      // held without the hash (the unique index would refuse it anyway).
      if (seen.has(code.hash)) {
        held.push(heldDoc(row, code.shape, at));
        continue;
      }
      seen.add(code.hash);
      const expired = row.useBy !== null && row.useBy.getTime() <= nowMs;
      const state = expired ? "expired" : "in_stock";
      docs.push(
        ledgerDoc(row, {
          codeHash: code.hash,
          codeShape: code.shape,
          state,
          history: [{ at, from: "", to: state, why: expired ? "stored after its use-by" : "stored" }],
        }),
      );
    }

    const first = await insertSome(docs);
    for (const d of first.ok) {
      out.added += 1;
      if (d.state === "expired") tally.expired += 1;
      tally.byGame[d.gameNo || "?"] = (tally.byGame[d.gameNo || "?"] || 0) + 1;
    }
    if (first.dup.length) {
      // Either another writer stored this identity first (skip), or the same
      // code is already in the ledger under another identity (held).
      const exists = await existingIdentities(first.dup);
      for (const d of first.dup) {
        if (exists.has(identityOf(d.loginId, d.itemKey))) out.skipped += 1;
        else held.push(heldDoc(d, d.codeShape, at));
      }
    }

    const second = await insertSome(held);
    out.held += second.ok.length;
    out.skipped += second.dup.length; // held rows carry no hash: identity race only
  }

  async function runOnce() {
    const nowMs = msOf(now());
    if (nowMs === null) throw new TypeError("codeShop.ingest: deps.now() must return a time");
    const at = new Date(nowMs);
    const out = { scanned: 0, added: 0, updated: 0, held: 0, skipped: 0 };

    const inventory = await leanOf(
      model("SoopInventoryItem").find({ kind: "code", hasCode: true }).select(INV_FIELDS),
    );
    const rows = (inventory || []).map(describe);
    out.scanned = rows.length;

    const sold = await soldLogins();
    if (sold.size) out.held += await holdSoldLogins(sold, at);

    const index = await campaignIndex(rows);
    for (const row of rows) {
      const c = campaignOf(index, row);
      row.campaignIdx = c ? text(c.dropsIdx) : "";
      row.campaignTitle = (c && text(c.title)) || row.dropsName;
      row.campaignEndAt = c ? dateOf(c.endDate) : null;
      row.groupKey = slots.groupKeyOf({ gameNo: row.gameNo, campaignIdx: row.campaignIdx, campaignName: row.dropsName });
    }

    // Oldest first, so of two rows holding the same code the earlier one is
    // the one that sells. Plain code-unit order: the same on every server.
    const cmpText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    rows.sort((a, b) => {
      const x = msOf(a.earnedAt);
      const y = msOf(b.earnedAt);
      if (x !== y) {
        if (x === null) return 1;
        if (y === null) return -1;
        return x - y;
      }
      return cmpText(a.loginId, b.loginId) || cmpText(a.itemKey, b.itemKey);
    });

    // Ordinals over every scanned row (sold logins and unreadable codes too),
    // so a reward's slot never depends on what else got skipped this run.
    const ordinals = slots.assignOrdinals(rows);
    for (const row of rows) {
      row.slotKey = slots.slotKeyOf(row.groupKey, row.nameRaw, ordinals.get(`${row.loginId}|${row.itemKey}`));
    }

    const live = [];
    for (const row of rows) {
      if (!row.loginId || !row.itemKey || sold.has(row.loginId)) {
        row.codeEnc = undefined;
        out.skipped += 1;
      } else {
        live.push(row);
      }
    }

    const ctx = { out, at, nowMs, seen: new Set(), tally: { expired: 0, byGame: {} } };
    for (const batch of chunks(live, BATCH)) await batchRun(batch, ctx);

    if (out.added > 0 && events && typeof events.log === "function") {
      const { expired, byGame } = ctx.tally;
      const inStock = out.added - expired;
      const msg =
        expired === 0
          ? `${out.added} new code${out.added === 1 ? "" : "s"} in stock`
          : `${out.added} new codes stored: ${inStock} in stock, ${expired} already past their use-by`;
      try {
        await events.log({
          level: "info",
          kind: "ingest",
          product: null,
          msg,
          data: { added: out.added, inStock, expired, held: out.held, byGame },
        });
      } catch {
        // the activity log is best-effort; the ledger is already written
      }
    }
    return out;
  }

  // One run at a time per process: a second caller shares the running one.
  let running = null;
  function run() {
    if (!running) {
      running = runOnce().finally(() => {
        running = null;
      });
    }
    return running;
  }

  return { run };
}

module.exports = { createIngest };
