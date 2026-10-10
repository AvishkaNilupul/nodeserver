// SOOP farm activity log (docs/SOOP-FARM-CONTRACT.md §9).
//
// What happened, newest first: a bounded ring in memory that the panel reads on
// every poll, plus a batched copy in Mongo (SoopActivity, 14-day TTL) so the
// history survives a restart. The DB copy is best-effort — a failed write is
// dropped, never retried and never allowed to break the caller.
//
// Callers must not put cookies or reward codes in `msg` / `data`.

const LEVELS = ["info", "warn", "error"];
const MAX_MSG = 500;

function idOrNull(v) {
  return v === undefined || v === null || v === "" ? null : String(v);
}

function createActivityLog({ model, cap = 500, flushMs = 5000, now = Date.now } = {}) {
  const size = Math.max(1, Number(cap) || 500);
  // A dead database must not grow the queue without bound between flushes.
  const maxQueue = Math.max(size * 4, 1000);
  const ring = []; // oldest first
  let queue = [];
  let timer = null;
  let stopped = false;
  let inFlight = Promise.resolve();
  let seq = 0;

  // Resolved on first write so a test (or a script) can pass its own model
  // without the real one having to load.
  const getModel = () => model || (model = require("../../models/SoopActivity"));

  function schedule() {
    if (timer || stopped) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, Math.max(0, Number(flushMs) || 0));
    if (timer.unref) timer.unref();
  }

  function add(input) {
    try {
      const e = input || {};
      const entry = {
        id: `${now().toString(36)}-${(seq++).toString(36)}`,
        at: new Date(now()),
        level: LEVELS.includes(e.level) ? e.level : "info",
        kind: e.kind ? String(e.kind) : "note",
        accountId: idOrNull(e.accountId),
        botId: idOrNull(e.botId),
        dropsIdx: idOrNull(e.dropsIdx),
        msg: String(e.msg === undefined || e.msg === null ? "" : e.msg).slice(0, MAX_MSG),
        data: e.data === undefined ? null : e.data,
      };
      ring.push(entry);
      if (ring.length > size) ring.splice(0, ring.length - size);
      if (queue.length < maxQueue) queue.push(entry);
      schedule();
      return entry;
    } catch (err) {
      // Logging is never a reason for the farm to fail.
      console.error("soop activity add error:", err.message);
      return null;
    }
  }

  function recent({ limit = 200, level, accountId, botId } = {}) {
    const max = Math.min(size, Math.max(1, Number(limit) || 200));
    const out = [];
    for (let i = ring.length - 1; i >= 0 && out.length < max; i--) {
      const e = ring[i];
      if (level && e.level !== level) continue;
      if (accountId && e.accountId !== String(accountId)) continue;
      if (botId && e.botId !== String(botId)) continue;
      out.push(e);
    }
    return out;
  }

  // Writes everything queued so far in one insert. Never rejects.
  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const batch = queue;
    queue = [];
    if (!batch.length) return inFlight;
    const docs = batch.map(({ id, ...doc }) => doc);
    inFlight = inFlight
      .then(() => getModel().insertMany(docs, { ordered: false }))
      .catch((err) => {
        console.error(`soop activity flush error (${docs.length} dropped):`, err.message);
      });
    return inFlight;
  }

  // Cancels the pending write timer. Entries still land in memory afterwards;
  // call flush() first when the tail must reach the database.
  function stop() {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return { add, recent, flush, stop };
}

module.exports = { createActivityLog };
