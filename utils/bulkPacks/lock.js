// Bulk packs — one in-process FIFO mutex per bulk offer
// (docs/bulk-packs/FIXES-1.md "New module: utils/bulkPacks/lock.js").
//
// WHY
// Every writer of a BulkOffer used to act on a snapshot read before it wrote:
// the loop loaded all offers at the start of a pass, the owner's take-out and
// the send.js actions read theirs when the click arrived. Two of them on the
// same offer interleaved at every await, so a pass could put back on sale an
// account the owner had taken out a moment earlier (review repro F-C). Each
// writer now runs inside withOfferLock(offerId, fn) and RE-READS the offer (and
// its row) inside it, so at most one of them touches an offer at a time, in
// the order they asked.
//
// SCOPE
// In-process only: the server runs as ONE PM2 process, and marketplace APIs are
// only ever called from it (CONTRACT I7). Nothing here is persisted, so a
// restart simply starts with every offer unlocked.
//
// NOT RE-ENTRANT
// A holder must never ask for the same offer again: the second call would wait
// for the first, which is waiting for it — a silent deadlock that would stall
// the maintenance loop for good. The call is refused instead (it rejects at
// once), detected through AsyncLocalStorage: a call made from inside fn (or
// from anything fn awaits) sees the ids its context holds. Work fn starts
// without awaiting it and that outlives fn sees the id as released.

const { AsyncLocalStorage } = require("node:async_hooks");

// key -> a promise that settles when the LAST caller queued on that key
// releases. A new caller waits for it, then becomes the new tail. The entry is
// dropped when its tail releases with nobody queued behind it, so the map only
// ever holds offers that are locked right now.
const tails = new Map();
// The ids the current async context holds (a Set per holder, copied from its
// parent so nesting A -> B -> A is caught as well).
const held = new AsyncLocalStorage();

function keyOf(offerId) {
  if (offerId == null) {
    throw new TypeError("withOfferLock: an offer id is required");
  }
  const key = String(offerId);
  if (!key || key === "undefined" || key === "null") {
    throw new TypeError("withOfferLock: an offer id is required");
  }
  return key;
}

// Run fn() while holding offerId's lock and resolve with its result. Callers
// run strictly one at a time per id, in the order they called; different ids
// never wait for each other. fn's error releases the lock and rejects the
// returned promise with that same error.
function withOfferLock(offerId, fn) {
  let key;
  try {
    key = keyOf(offerId);
    if (typeof fn !== "function") {
      throw new TypeError("withOfferLock: fn must be a function");
    }
    const mine = held.getStore();
    if (mine && mine.has(key)) {
      throw new Error(
        "withOfferLock: bulk offer " +
          key +
          " is already locked by this caller — the lock is not re-entrant",
      );
    }
  } catch (e) {
    return Promise.reject(e);
  }
  const prev = tails.get(key) || Promise.resolve();
  let release;
  const done = new Promise((resolve) => {
    release = resolve;
  });
  tails.set(key, done);
  const store = new Set(held.getStore() || []);
  store.add(key);
  return prev.then(() =>
    held.run(store, async () => {
      try {
        return await fn();
      } finally {
        // Released: anything fn left running must not read as a holder.
        store.delete(key);
        if (tails.get(key) === done) tails.delete(key);
        release();
      }
    }),
  );
}

// Tests only: forget every lock. Callers already queued still run in turn
// (each holds its own predecessor); new callers start unlocked.
function __reset() {
  tails.clear();
}

// Tests only: how many offer ids are locked (or queued) right now.
function __size() {
  return tails.size;
}

module.exports = { withOfferLock, __reset, __size };
