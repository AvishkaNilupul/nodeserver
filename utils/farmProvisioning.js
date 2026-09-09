// The arithmetic behind "provision N accounts for one rent-farm order, and
// survive a partial result".
//
// Both rent-farm services used to do exactly this, on EVERY attempt:
//
//   const res = await operatorFarm.farmFreshAccounts({ count: qty });
//   row.accounts = (res.added || []).map(...);      // <-- OVERWRITE
//
// and after a shortfall they deliberately left `provisionedAt` null with the
// comment "the next tick tops it up". It did not top up. The next tick asked
// for the FULL quantity again and overwrote `row.accounts`, so every account the
// previous attempt had already pinned to a bot was dropped off the order:
//
//   - still deployed on the Pi, still burning a rental stack slot;
//   - still farming, for a buyer whose order no longer lists it;
//   - `farmUntil` stamped on its RenterAccount, so renterExpiry will one day
//     tear it down for an order that never knew it existed;
//   - never returned to the pool, because nothing can find it.
//
// A 3-account order that managed 1, then 1, then 1 across three ticks ends up
// owning ONE account and silently leaking two pristine ones. The pool is ~100
// accounts and each one is bought, so this is real money, and it compounds every
// time the Pi is briefly unreachable — which is the ordinary case this branch
// exists to handle (see utils/farmServiceAlert for order 4b20765f, where the Pi
// config write failed transiently and the pool itself was fine).
//
// Two rules, and both are needed:
//   1. ask only for what is still MISSING, not for the whole order again;
//   2. APPEND to what the order already holds, never replace it.
//
// `farmUntil` is per-CALL, not per-order: operatorFarm computes
// `now + days` inside each farmFreshAccounts call and stamps that on the
// RenterAccount it claims. A top-up batch therefore has a genuinely later window
// than the first batch, and the row must mirror what was actually stamped rather
// than recomputing one value for everybody.

const login = (a) => String((a && a.login) || "").trim();
const key = (a) => login(a).toLowerCase();

// The accounts this order already holds — real entries only, deduped by login.
// A row read back from Mongo holds sub-documents, so read fields through the
// getters and never spread (see reference_mongoose_subdoc_spread: a spread drops
// every schema path and once shipped "Username: undefined" to a paying buyer).
function heldAccounts(row) {
  const out = [];
  const seen = new Set();
  for (const a of (row && row.accounts) || []) {
    const k = key(a);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push({
      login: login(a),
      poolId: a.poolId ? String(a.poolId) : "",
      farmUntil: a.farmUntil || null,
    });
  }
  return out;
}

// How many MORE accounts this order still owes the buyer. Never negative: an
// order that somehow holds more than it should must not ask for a negative
// count, which farmFreshAccounts would read as "give me some".
function stillNeeded(row, qty) {
  const want = Math.max(1, parseInt(qty, 10) || 1);
  return Math.max(0, want - heldAccounts(row).length);
}

// Append a freshly provisioned batch to what the order already holds.
//
// `farmUntil` is the window operatorFarm actually stamped for THIS batch. It is
// applied only to the new entries; anything already on the row keeps the window
// it was really given.
function mergeProvisioned(held, added, farmUntil) {
  const out = heldAccounts({ accounts: held });
  const seen = new Set(out.map(key));
  for (const a of added || []) {
    const k = key(a);
    // A login we already hold is not a second account. Counting it twice would
    // make a short order look complete and leave the buyer a unit down.
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push({
      login: login(a),
      poolId: a.poolId ? String(a.poolId) : "",
      farmUntil: farmUntil || null,
    });
  }
  return out;
}

module.exports = { heldAccounts, stillNeeded, mergeProvisioned };
