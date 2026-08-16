// Per-(host,file) write serialization for bot config files.
//
// ~13 helpers across botConfigRoutes.js and renterBotOps.js run a
// read->mutate->write cycle:
//   const data = JSON.parse(await hosts.readFile(host, file));
//   ...mutate data...
//   await hosts.writeFileAtomic(host, file, JSON.stringify(data));
// writeFileAtomic makes only the FINAL rename atomic; it does NOT protect the
// read->mutate->write window. Two concurrent cycles on the SAME config both
// read the old contents and the second write clobbers the first (a lost
// update) — e.g. two renters armed on one shared bot at the same instant, one
// silently dropped from the config.
//
// withFileLock serializes cycles that touch the same (host, file) while letting
// DIFFERENT files run concurrently: a slow write on config_30 must not stall
// every other config in the fleet. The lock is a per-key promise chain, the
// same shape as admins.js withLock but keyed by host+file.
//
// It is NOT reentrant: a locked function must never call another locked
// function for the SAME key while holding it, or it self-deadlocks waiting on a
// chain it is itself holding. The one call that crosses helpers —
// renterBotOps.applyRenterGames' alone-on-config branch calling setConfigGames —
// is safe because that branch holds NO lock, so setConfigGames' own lock is a
// single acquisition. For any FUTURE caller that must set games while already
// holding the file's lock, setConfigGames is split into an unlocked core
// (_setConfigGamesUnlocked) it can call directly instead of re-locking.
const chains = new Map();

function keyFor(host, file) {
  const id = (host && (host.id || host.name)) || String(host || "");
  return id + "::" + String(file);
}

// Run fn() with exclusive access to (host, file). Returns fn's result (or
// rejection); a failed cycle never poisons the cycles queued behind it.
function withFileLock(host, file, fn) {
  const key = keyFor(host, file);
  const prev = chains.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  // The chain link swallows errors so one failed cycle does not reject every
  // cycle queued behind it; the caller still sees run's own rejection.
  const next = run.then(
    () => {},
    () => {},
  );
  chains.set(key, next);
  // Drop the map entry once the queue drains so keys for one-off files do not
  // leak. Only delete if we are still the tail — a newer waiter may have
  // chained on while this cycle ran.
  next.then(() => {
    if (chains.get(key) === next) chains.delete(key);
  });
  return run;
}

module.exports = { withFileLock };
