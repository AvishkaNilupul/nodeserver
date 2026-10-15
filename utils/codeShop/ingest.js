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
// the slot it was sold under). State, unit and codeHash move only for these
// (contract + docs/code-shop/05-REVIEW-FIXES.md, R9):
// - an in_stock row of a farm login that was sold (the login now belongs to a
//   buyer, who can see its inventory) becomes held;
// - the farm's stored code changed (it re-claimed a re-issued reward): a free
//   row (in_stock / expiring / expired, or held only because its code check
//   failed) takes the new fingerprint; an in_unit row whose unit is on sale
//   pulls that unit (its other codes go back to stock) and then takes it; a
//   row anywhere else (sold, dead, in a vault, ...) only gets an event, once;
// - an expiring / expired row whose use-by moved beyond the lead time goes
//   back to in_stock (never one that was in a platform vault);
// - an in_stock row whose inventory item was revealed in the farm panel
//   (SoopActivity kind "reveal") becomes held, unless the owner released it
//   for exactly that after the reveal (held.js).

const crypto = require("node:crypto");
const slots = require("./slots");
const { PROBLEMS: HELD_PROBLEMS, releasedWhy } = require("./held");

// Bounded writes: one ledger read and at most this many writes per round trip.
const BATCH = 500;
// utils/soop/inventory.js keeps claim.dropsName cut to 200 characters, so a
// longer campaign title is compared by the same first 200.
const DROPS_NAME_MAX = 200;
const SOLD_PROBLEM = "its farm login was sold";
const DUP_PROBLEM = "same code as another stored code";
const REVEALED_PROBLEM = HELD_PROBLEMS.revealed;
const HISTORY_MAX = 20;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_LEAD_HOURS = 36;
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;
// Free rows: no buyer can have their code, so a changed code just re-keys them.
const FREE_STATES = ["in_stock", "expiring", "expired"];
const WHY = {
  rehashed: "its stored code changed (the reward was re-issued)",
  pulledOther: "its unit was pulled: another code in it changed",
  pulledSelf: "its unit was pulled: its stored code changed (the reward was re-issued)",
  revived: "its use-by moved beyond the lead time",
};
const PULL_NOTE = "code unit — a stored code in it changed";

// codeEnc is read to decrypt a NEW identity's code, and an existing one's when
// its ciphertext changed (R9); nothing else in the raw / claim objects is needed.
const INV_FIELDS =
  "loginId key gameNo gameName name nameRaw image sentAt division expiresAt raw.useExpDate claim.dropsName codeEnc";
const LEDGER_FIELDS =
  "loginId itemKey state itemId gameName name image campaignTitle campaignIdx campaignEndAt useBy groupKey slotKey " +
  "codeHash codeShape unit unitStatus wasFed problem";
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

// A lead that is missing or unreadable falls back to the default, never to 0.
function leadHoursOf(v) {
  const n = Number(v);
  return v !== null && v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : DEFAULT_LEAD_HOURS;
}

const historyPush = (at, from, to, why) => ({ $each: [{ at, from, to, why }], $slice: -HISTORY_MAX });

function createIngest(deps = {}) {
  const models = deps.models || {};
  // Resolved on first use so a test can pass its own models and the real ones
  // never have to load.
  const model = (name) => models[name] || require("../../models/" + name);
  const secret = deps.secret || require("../secretBox");
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const events = deps.events || null;
  let config = deps.config || null;
  const configOf = () => config || (config = require("./config").createConfig({ model: models.CodeShopConfig, now }));
  let puller = null;
  const pull = (unitId, opts) => (puller || (puller = require("./reconcile").pullerOf(deps)))(unitId, opts);

  // identity -> { enc: digest of the ciphertext, code: { hash, shape } | null }
  // of the last code read for it, so a code is decrypted again only when the
  // stored ciphertext changes. Digests and fingerprints only.
  const codeCache = new Map();
  // "Told once" for changed codes when events cannot stamp.
  const toldChanged = new Set();

  async function note(entry) {
    try {
      if (events && typeof events.log === "function") await events.log(entry);
    } catch {
      // the activity log is best-effort
    }
  }

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

  // The fingerprint of the code the farm holds now for an existing row, or
  // null when it cannot be read (unreadable is never "changed").
  function currentCode(row) {
    const id = identityOf(row.loginId, row.itemKey);
    const enc = crypto.createHash("sha1").update(text(row.codeEnc), "utf8").digest("base64");
    const hit = codeCache.get(id);
    if (hit && hit.enc === enc) return hit.code;
    const code = readCode(row);
    codeCache.set(id, { enc, code });
    return code;
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
      // The farm may hold another code for this reward now (re-claimed).
      if (text(cur.codeHash)) {
        const code = currentCode(row);
        if (code && code.hash !== cur.codeHash) ctx.changed.push({ cur, hash: code.hash, shape: code.shape });
      }
      row.codeEnc = undefined;
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
    const out = { scanned: 0, added: 0, updated: 0, held: 0, skipped: 0, rehashed: 0, revived: 0 };

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

    const ctx = { out, at, nowMs, seen: new Set(), tally: { expired: 0, byGame: {} }, changed: [] };
    for (const batch of chunks(live, BATCH)) await batchRun(batch, ctx);
    const scannedIds = new Set(live.map((r) => identityOf(r.loginId, r.itemKey)));
    for (const id of codeCache.keys()) if (!scannedIds.has(id)) codeCache.delete(id);

    if (ctx.changed.length) await settleChanged(ctx.changed, at, out);
    out.revived = await revive(at, nowMs, sold);
    out.held += await holdRevealed(at);

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

  // ── R9: a stored code that changed ───────────────────────────────────────

  // Row -> the new fingerprint, guarded by the state and fingerprint it was
  // read with (and `guard`). A new code that another row already holds makes
  // this row a held duplicate instead. -> "rehashed" | "duplicate" | "lost".
  async function rekey(c, from, at, guard = {}, $set = {}, why = WHY.rehashed) {
    const CodeStock = model("CodeStock");
    const filter = { _id: c.cur._id, state: from, codeHash: c.cur.codeHash, ...guard };
    try {
      const res = await CodeStock.updateMany(filter, {
        $set: { codeHash: c.hash, codeShape: c.shape, ...$set },
        $push: { history: historyPush(at, from, $set.state || from, why) },
      });
      return (res && res.modifiedCount) === 1 ? "rehashed" : "lost";
    } catch (err) {
      if (!isDuplicateKey(err && err.code)) throw err;
      const res = await CodeStock.updateMany(filter, {
        $set: { ...$set, state: "held", problem: DUP_PROBLEM, codeHash: "", codeShape: c.shape },
        $push: { history: historyPush(at, from, "held", DUP_PROBLEM) },
      });
      return (res && res.modifiedCount) === 1 ? "duplicate" : "lost";
    }
  }

  // Once per (row, new code): a stamp when the events can stamp, else once
  // per process.
  async function tellChanged(c, msg, level = "warn") {
    const key = `code-changed:${String(c.cur._id)}:${c.hash.slice(0, 16)}`;
    let fresh = false;
    if (events && typeof events.stamp === "function") {
      try {
        fresh = (await events.stamp(key, { kind: "code-changed", msg })) === true;
      } catch {
        fresh = !toldChanged.has(key);
      }
    } else {
      fresh = !toldChanged.has(key);
    }
    toldChanged.add(key);
    if (!fresh) return;
    await note({
      level,
      kind: "code-changed",
      product: c.cur.product || null,
      msg,
      data: { row: String(c.cur._id), state: text(c.cur.state), unit: c.cur.unit ? String(c.cur.unit) : null, oldShape: text(c.cur.codeShape), newShape: c.shape },
    });
  }

  const nameOf = (c) => text(c.cur.name) || "a reward";

  async function settleChanged(changed, at, out) {
    const byUnit = new Map();
    for (const c of changed) {
      const { state, problem } = c.cur;
      if (FREE_STATES.includes(state) || (state === "held" && text(problem) === HELD_PROBLEMS.codeCheck)) {
        const r = await rekey(c, state, at);
        if (r === "rehashed") out.rehashed += 1;
        if (r === "duplicate") out.held += 1;
        if (r !== "lost") {
          await note({
            level: r === "duplicate" ? "warn" : "info",
            kind: "code-changed",
            msg:
              `The farm's stored code for ${nameOf(c)} changed (${text(c.cur.codeShape)} -> ${c.shape}); ` +
              (r === "duplicate" ? "the new code is already in stock under another row, so this one is held" : "the ledger follows the new code"),
            data: { row: String(c.cur._id), state },
          });
        }
        continue;
      }
      if (state === "in_unit" && c.cur.unit) {
        const k = String(c.cur.unit);
        if (!byUnit.has(k)) byUnit.set(k, { unit: c.cur.unit, list: [] });
        byUnit.get(k).list.push(c);
        continue;
      }
      const sold = state === "sold" || state === "dead";
      await tellChanged(
        c,
        `The farm's stored code for ${nameOf(c)} changed (${text(c.cur.codeShape)} -> ${c.shape}) while it was ${state}` +
          (sold ? ": its buyer has the old code — check it still works" : ": nothing was changed"),
      );
    }
    for (const { unit, list } of byUnit.values()) await settleChangedUnit(unit, list, at, out);
  }

  // An in_unit row's code changed: the unit's buyer text holds the OLD code.
  // Only a unit on sale with no vault or delivery mark is pulled here; any
  // other unit is left to reconcile (it holds what may have gone out).
  async function settleChangedUnit(unitId, list, at, out) {
    const CodeStock = model("CodeStock");
    const unit = await leanOf(model("SuppliedAccount").findById(unitId).select("status fedAt contentId deliveredAt"));
    const rows = (await leanOf(CodeStock.find({ unit: unitId }).select("_id state wasFed unitStatus"))) || [];
    const marked = !!unit && !!(unit.fedAt || text(unit.contentId) || unit.deliveredAt);
    const wasFed = rows.some((r) => r.wasFed === true || r.unitStatus === "fed");
    const pullable = !!unit && unit.status === "available" && !marked && !wasFed;
    const won = pullable ? await pull(unitId, { note: PULL_NOTE }) : false;
    if (!won) {
      for (const c of list) {
        await tellChanged(
          c,
          `The farm's stored code for ${nameOf(c)} changed (${text(c.cur.codeShape)} -> ${c.shape}) while it is in a bundle that ` +
            (unit ? `is ${text(unit.status) || "unknown"}${marked || wasFed ? " and went through a market" : ""}` : "is gone") +
            ": the bundle still holds the old code",
        );
      }
      return;
    }
    const changedIds = new Set(list.map((c) => String(c.cur._id)));
    const others = rows.filter((r) => r.state === "in_unit" && !changedIds.has(String(r._id))).map((r) => r._id);
    const free = { unit: null, product: null, offer: null, unitStatus: "" };
    if (others.length) {
      await CodeStock.updateMany(
        { _id: { $in: others }, unit: unitId, state: "in_unit" },
        { $set: { state: "in_stock", ...free }, $push: { history: historyPush(at, "in_unit", "in_stock", WHY.pulledOther) } },
      );
    }
    let rehashed = 0;
    for (const c of list) {
      const r = await rekey(c, "in_unit", at, { unit: unitId }, { state: "in_stock", ...free }, WHY.pulledSelf);
      if (r === "rehashed") rehashed += 1;
      if (r === "duplicate") out.held += 1;
    }
    out.rehashed += rehashed;
    await note({
      level: "warn",
      kind: "code-changed",
      msg: `Took a bundle off sale: ${list.length} of its stored code(s) changed (the reward was re-issued); its codes are back in stock`,
      data: { unit: String(unitId), changed: list.length, rehashed, back: others.length },
    });
  }

  // ── R9: use-by moved beyond the lead ─────────────────────────────────────

  async function revive(at, nowMs, sold) {
    const cfg = (await configOf().get()) || {};
    const horizon = new Date(nowMs + leadHoursOf(cfg.expiryLeadHours) * HOUR_MS);
    const CodeStock = model("CodeStock");
    let n = 0;
    for (const from of ["expiring", "expired"]) {
      const filter = { state: from, useBy: { $gt: horizon }, wasFed: { $ne: true } };
      if (sold.size) filter.loginId = { $nin: [...sold] };
      const res = await CodeStock.updateMany(filter, {
        $set: { state: "in_stock", unit: null, product: null, offer: null, unitStatus: "" },
        $push: { history: historyPush(at, from, "in_stock", WHY.revived) },
      });
      n += (res && res.modifiedCount) || 0;
    }
    if (n) {
      await note({ level: "info", kind: "ingest", msg: `${n} code(s) back in stock: their use-by moved beyond the lead time`, data: { revived: n } });
    }
    return n;
  }

  // ── R9: a code shown in the farm panel ───────────────────────────────────

  // When the owner last released this row for exactly "shown in the farm
  // panel" (-Infinity when never): a reveal before that is vouched for.
  function lastVouchMs(row) {
    const why = releasedWhy(REVEALED_PROBLEM);
    let best = -Infinity;
    for (const h of Array.isArray(row.history) ? row.history : []) {
      if (!h || h.why !== why) continue;
      const ms = msOf(h.at);
      if (ms !== null && ms > best) best = ms;
    }
    return best;
  }

  // The farm's activity log has no index on `kind`, only on `at` (its TTL):
  // the first pass reads the whole 14 days once, every later pass only what
  // was written since (minus a minute of slack), so a tick never scans the log.
  const revealSeen = new Map(); // item id -> ms of its newest reveal
  let revealReadTo = null; // ms the reveals have been read up to

  async function holdRevealed(at) {
    const nowMs = msOf(at);
    const q = { kind: "reveal" };
    if (revealReadTo !== null) q.at = { $gte: new Date(revealReadTo - 60e3) };
    const reveals = (await leanOf(model("SoopActivity").find(q).select("at data.itemId"))) || [];
    revealReadTo = nowMs === null ? Date.now() : nowMs;
    for (const r of reveals) {
      const id = text(r && r.data && r.data.itemId);
      const ms = msOf(r && r.at);
      if (!OBJECT_ID_HEX.test(id) || ms === null) continue;
      if (!revealSeen.has(id) || ms > revealSeen.get(id)) revealSeen.set(id, ms);
    }
    // Forget what the log itself has forgotten (14 days), so the map stays small.
    for (const [id, ms] of revealSeen) if (revealReadTo - ms > 15 * 86400e3) revealSeen.delete(id);
    const lastReveal = revealSeen;
    if (!lastReveal.size) return 0;
    const CodeStock = model("CodeStock");
    let held = 0;
    for (const part of chunks([...lastReveal.keys()], BATCH)) {
      const rows = (await leanOf(CodeStock.find({ state: "in_stock", itemId: { $in: part } }).select("_id itemId history"))) || [];
      const hold = rows.filter((r) => lastReveal.get(text(r.itemId)) > lastVouchMs(r)).map((r) => r._id);
      if (!hold.length) continue;
      const res = await CodeStock.updateMany(
        { _id: { $in: hold }, state: "in_stock" },
        { $set: { state: "held", problem: REVEALED_PROBLEM }, $push: { history: historyPush(at, "in_stock", "held", REVEALED_PROBLEM) } },
      );
      held += (res && res.modifiedCount) || 0;
    }
    if (held) {
      await note({
        level: "warn",
        kind: "code-held",
        msg: `Held ${held} code(s) that were shown in the farm panel; release them from the Stock tab if they were never given out`,
        data: { held },
      });
    }
    return held;
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
