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
// RE-ENTRY (2026-10-11). A locked function that takes the SAME key again runs
// straight through: the async context it runs in already has the file to
// itself, and queueing behind its own chain link could never be granted. Until
// this date that call hung for good, silently. The split of setConfigGames into
// an unlocked core (_setConfigGamesUnlocked) predates it and still stands.
// Re-entry is by async context: work a locked function starts and does NOT
// await is "inside" only for as long as that function is still running.
//
// NEVER WAIT FOR A SECOND FILE WHILE HOLDING ONE. Two cycles that each hold one
// config and wait for the other's never finish. Whatever a locked function has
// to do to OTHER files — the single-home heal of sibling configs
// (utils/dupeGuard) is the case that matters — is handed to afterUnlock, which
// runs it once this async context holds no file lock at all.
// The one nesting that exists is PROVISION_LOCK outside the lock of a config
// that is being created under it — a file nobody else can be holding.
const { AsyncLocalStorage } = require("node:async_hooks");

const chains = new Map();
// The lock section the current async context is running in (innermost; its
// `parent` links lead outwards).
const sections = new AsyncLocalStorage();

function keyFor(host, file) {
  const id = (host && (host.id || host.name)) || String(host || "");
  return id + "::" + String(file);
}

// Is `key` held by a section this async context is running inside?
function holds(key) {
  for (let s = sections.getStore(); s; s = s.parent) {
    if (s.active && s.key === key) return true;
  }
  return false;
}

// The outermost section this async context is still running inside, or null.
function outermost() {
  let root = null;
  for (let s = sections.getStore(); s; s = s.parent) {
    if (s.active) root = s;
  }
  return root;
}

// What a section put off until the lock was free. One step failing must not
// cost the steps behind it, nor turn the section's own result into a failure.
async function flush(section) {
  while (section.after.length) {
    const step = section.after.shift();
    try {
      await step();
    } catch (e) {
      console.error(
        "[fileLock] a step put off until " + section.key + " was free failed: " +
          ((e && e.message) || e),
      );
    }
  }
}

// Run fn() with exclusive access to (host, file). Returns fn's result (or
// rejection); a failed cycle never poisons the cycles queued behind it.
function withFileLock(host, file, fn) {
  const key = keyFor(host, file);
  if (holds(key)) return (async () => fn())();
  const section = { key, parent: sections.getStore() || null, active: false, after: [] };
  const prev = chains.get(key) || Promise.resolve();
  const enter = async () => {
    section.active = true;
    try {
      return await sections.run(section, fn);
    } finally {
      section.active = false;
    }
  };
  const run = prev.then(enter, enter);
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
  // `run` settling is the release. The steps this section put off until no
  // lock was held run now, and the caller gets fn's own outcome after them.
  return run.then(
    async (value) => {
      await flush(section);
      return value;
    },
    async (err) => {
      await flush(section);
      throw err;
    },
  );
}

// Run step() once this async context holds NO file lock: at once when it holds
// none (the returned promise is step's own), otherwise right after the
// outermost section it is inside has released — and before that section's
// withFileLock call returns to its caller. Inside a section the returned
// promise is already resolved: waiting for the step there would be waiting for
// one's own lock to be released.
function afterUnlock(step) {
  const root = outermost();
  if (!root) return (async () => step())();
  root.after.push(step);
  return Promise.resolve();
}

// The per-host key under which a NEW bot is given its slot number, config file
// and compose service, and a compose service is removed. It is not a config
// file, but it is taken like one: routes/botConfigRoutes.provisionEmptyConfig
// (same literal) and utils/botFactory createBot/deleteBot.
const PROVISION_LOCK = "provision.lock";

module.exports = {
  withFileLock,
  afterUnlock,
  PROVISION_LOCK,
  // Is the current async context inside a section for (host, file)?
  holdsFileLock: (host, file) => holds(keyFor(host, file)),
  // ...inside a section for any file at all?
  insideFileLock: () => outermost() !== null,
};
