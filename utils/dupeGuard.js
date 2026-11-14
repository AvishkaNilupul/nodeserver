// SINGLE-HOME GUARD
//
// A Twitch account must be enabled in exactly ONE bot config per host. Two
// containers watching with the same account looks like abuse to Twitch and
// wastes a seat, and it has happened before: a consolidation copied accounts
// into a target and then failed to retire the donor, leaving 40 accounts
// enabled twice on the Pi.
//
// Rather than trusting every write path (botFactory, the config routes, the
// renter routes, the consolidator) to remember, this hooks the one thing they
// all funnel through — hosts.writeFileAtomic — and enforces the invariant
// after the fact: the config just written is the account's home, so any OTHER
// config on that host still holding it gets the entry stripped. "Last write
// wins" is what every legitimate flow already means (deploy, move, renter
// hand-off), so this needs no caller changes and cannot lose an account: it
// only ever removes the copy that isn't the newest one.
//
// WHICH WRITE IS "THE NEWEST ONE" (2026-10-11). A write of config A carries
// every account A already held, not only the ones it is putting there. Read as
// "A is home for all of them", two placements at the same moment undid each
// other: on 2026-10-09 01:11Z the lane engine started two probes at once, the
// SPAM probe's write of config_24 was overwritten by the heal that followed
// the Alien: Isolation probe's write of config_53, and 13 of SPAM's 15
// accounts sat switched off for 2.5 hours while the task counted them as
// deployed. The same two writes could as easily have stripped the twelve
// accounts that were MOVING from config_24 to config_53 out of both. So:
//   * A write is told apart by what it switched ON (enabled now, not enabled
//     in the file a moment before): those accounts it CLAIMS, and the claim is
//     remembered for a while (noteWrite).
//   * An account a write merely carried is left alone wherever a recent claim
//     says it now lives; the claiming write's own heal removes the stale copy.
//   * Of two claims on one account the later write wins, whichever heal runs
//     first.
//   * Nothing is stripped for an account that is no longer enabled at home by
//     the time the heal runs.
// With no claim on record (a duplicate older than the memory, or left by
// another process) the rule is the old one: the config being written is home.
//
// The heal rewrites SIBLING configs, so each one is re-read and rewritten
// under its own file lock (utils/fileLock): no other read->mutate->write of
// that sibling can interleave. It never runs while the write that caused it
// still holds a lock of its own — enforceSingleHome goes through
// fileLock.afterUnlock — so two heals can never wait on each other.
const fileLock = require("./fileLock");
// Should this file ever run beside a fileLock.js from before afterUnlock
// existed (a deploy that copied one and not the other), the heal keeps to the
// old way — at once, siblings unlocked — rather than wait for a sibling's lock
// while its caller holds one.
const canDefer = typeof fileLock.afterUnlock === "function";
const afterUnlock = canDefer ? fileLock.afterUnlock : (step) => step();
const lockSibling = canDefer ? fileLock.withFileLock : (host, file, fn) => fn();

const CONFIG_RE = /^config(_[A-Za-z0-9-]+)?\.json$/;

// writeFileAtomic is re-entered while we heal sibling configs; without this
// the first heal would trigger its own sweep, and so on. Keyed per
// host|file (2026-10-01): one module-wide flag also made every OTHER write
// that happened to run during a heal skip the guard, silently.
const healingWrites = new Set();
const healKey = (host, file) => String(host && host.id) + "|" + file;

// Recent claims: host|secret -> { file, seq, at }. In memory only — after a
// restart, or once a claim is older than CLAIM_TTL_MS, the old rule applies.
const CLAIM_TTL_MS = 30 * 60 * 1000;
const CLAIM_PRUNE_AT = 5000;
const claims = new Map();
let writeSeq = 0;

function usersOf(data) {
  return data &&
    data.TwitchSettings &&
    Array.isArray(data.TwitchSettings.TwitchUsers)
    ? data.TwitchSettings.TwitchUsers
    : [];
}
const secretOf = (u) => String((u && u.ClientSecret) || "").trim();

// Every token switched on in a config text, or null when it does not parse.
function enabledSecrets(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  return new Set(
    usersOf(data)
      .filter((u) => u && u.Enabled !== false)
      .map(secretOf)
      .filter(Boolean),
  );
}

function claimOn(host, secret, now) {
  const key = String(host && host.id) + "|" + secret;
  const c = claims.get(key);
  if (!c) return null;
  if (now - c.at > CLAIM_TTL_MS) {
    claims.delete(key);
    return null;
  }
  return c;
}

// Is this (host, file) one the guard acts on right now? Not a heal's own write.
function watches(host, file) {
  return CONFIG_RE.test(String(file || "")) && !healingWrites.has(healKey(host, file));
}

// hosts.writeFileAtomic calls this the moment (host, file) holds `text`.
// `prevText` is what the file held just before: a string, null when there was
// no file, undefined when that is not known. Returns what the heal needs to
// tell a move from a bystander, or null when the guard does not act here.
function noteWrite(host, file, text, prevText) {
  if (!watches(host, file)) return null;
  const mine = enabledSecrets(text);
  if (!mine) return null;
  const seq = ++writeSeq;
  let fresh = null; // not known: every account counts as carried
  if (prevText === null) {
    fresh = new Set(mine);
  } else if (typeof prevText === "string") {
    const before = enabledSecrets(prevText);
    if (before) fresh = new Set([...mine].filter((s) => !before.has(s)));
  }
  if (fresh && fresh.size) {
    const at = Date.now();
    for (const s of fresh) claims.set(String(host && host.id) + "|" + s, { file, seq, at });
    if (claims.size > CLAIM_PRUNE_AT) {
      for (const [k, c] of claims) if (at - c.at > CLAIM_TTL_MS) claims.delete(k);
    }
  }
  return { seq, fresh };
}

// Does the write of `file` own `secret`, so that a copy switched on in another
// config is the stale one?
function owns(host, file, secret, write, now) {
  const c = claimOn(host, secret, now);
  if (write && write.fresh && write.fresh.has(secret)) {
    // This write switched it on here; only a LATER claim elsewhere outranks it.
    return !(c && c.file !== file && c.seq > write.seq);
  }
  // Already on here before this write (or the write cannot tell): home, unless
  // a recent write moved it somewhere else.
  return !(c && c.file !== file);
}

// Strip what the write of (host, file) made stale in its sibling configs.
// `write` is noteWrite's result for that write; without it every enabled
// account counts as carried.
//
// Called with no file lock held it runs now and resolves to the siblings it
// healed: [{ file, removed: [login] }]. Called from inside a file lock it
// resolves at once to [] and runs the moment that lock is released.
function enforceSingleHome(hosts, host, file, text, write) {
  if (!watches(host, file)) return Promise.resolve([]);
  return afterUnlock(() => heal(hosts, host, file, text, write)).then((r) => r || []);
}

async function heal(hosts, host, file, text, write) {
  if (!watches(host, file)) return [];
  const mine = enabledSecrets(text);
  if (!mine || !mine.size) return [];

  // The accounts of this write whose copy in a sibling is the stale one, as of
  // NOW: still switched on at home (`homeText`, when it could be read), and
  // not outranked by a claim made since.
  const staleNow = (homeText) => {
    const home = typeof homeText === "string" ? enabledSecrets(homeText) : null;
    const now = Date.now();
    return new Set(
      [...mine].filter((s) => (!home || home.has(s)) && owns(host, file, s, write, now)),
    );
  };
  const strip = (d, claimed) => {
    const removed = [];
    const kept = usersOf(d).filter((u) => {
      const s = secretOf(u);
      if (!s || !claimed.has(s) || u.Enabled === false) return true;
      removed.push(u.Login || s.slice(0, 6));
      return false;
    });
    return { removed, kept };
  };

  const healed = [];
  try {
    const files = (await hosts.readdir(host))
      .map((f) => f.name || f)
      .filter((f) => CONFIG_RE.test(f) && f !== file);
    if (!files.length) return [];
    // The home is read with its siblings: an account that is no longer
    // switched on there (another heal, a later edit) must not be stripped
    // from anywhere on this write's say-so.
    const raw = await hosts.readFiles(host, files.concat(file));
    const likely = staleNow(raw[file] && raw[file].ok ? raw[file].text : null);
    if (!likely.size) return [];
    // First, with nothing awaited in between: which siblings hold a copy this
    // write owns, and a claim for every such account that has none on record.
    // Two unrelated writes of two configs that both hold one account each own
    // it by the old rule, and each heal stripped the other's copy — the account
    // ended in neither (after a restart no claim is on record for anything).
    // Whichever heal judges first now takes the claim; the other finds it
    // taken and leaves this home alone.
    const todo = [];
    const at = Date.now();
    for (const f of files) {
      const entry = raw[f];
      if (!entry || !entry.ok) continue;
      let seen;
      try {
        seen = JSON.parse(entry.text);
      } catch {
        continue;
      }
      if (!usersOf(seen).length || !strip(seen, likely).removed.length) continue;
      todo.push(f);
      for (const u of usersOf(seen)) {
        const sec = secretOf(u);
        if (!sec || u.Enabled === false || !likely.has(sec) || claimOn(host, sec, at)) continue;
        claims.set(String(host && host.id) + "|" + sec, {
          file,
          seq: write && write.seq ? write.seq : ++writeSeq,
          at,
        });
      }
    }
    for (const f of todo) {
      // Under the sibling's own lock, from what it holds NOW: another writer
      // may have changed it since the batched read, and one that is mid-cycle
      // finishes first. Skipping a changed sibling left the token enabled in
      // two configs; writing the batched copy back undid the other writer.
      await lockSibling(host, f, async () => {
        let current = null;
        try {
          current = await hosts.readFile(host, f);
        } catch {
          current = null;
        }
        if (current === null) return;
        let data;
        try {
          data = JSON.parse(current);
        } catch {
          console.warn("[dupeGuard] " + host.id + "/" + f + " changed meanwhile and no longer parses — left alone");
          return;
        }
        // Judged again now that the sibling is ours. While this heal waited
        // for it, the cycle it waited behind may have CLAIMED one of these
        // accounts for the sibling, or another heal taken one from home —
        // stripping on the earlier answer removed an account from the very
        // config it had just been moved to.
        let homeNow = null;
        try {
          homeNow = await hosts.readFile(host, file);
        } catch {
          homeNow = null;
        }
        const { removed, kept } = strip(data, staleNow(homeNow));
        if (!removed.length) return;
        data.TwitchSettings.TwitchUsers = kept;
        const key = healKey(host, f);
        healingWrites.add(key);
        try {
          await hosts.writeFileAtomic(host, f, JSON.stringify(data, null, 2));
        } finally {
          healingWrites.delete(key);
        }
        healed.push({ file: f, removed });
        // Out of the config is not out of the BOT: a running container keeps
        // its config from startup. Recorded as owing a reload — the renter
        // owed-reload sweeper reloads it if it runs (utils/renterBotOps).
        try {
          await require("./renterBotOps").markReloadOwed(host, f, "dupe guard: accounts moved to " + file);
        } catch (e) {
          console.error("[dupeGuard] could not record the reload owed by " + f + ": " + e.message);
        }
        console.warn(
          "[dupeGuard] " + removed.length + " account(s) moved to " + file +
            " were still enabled in " + f + " on " + host.id +
            " — removed there: " + removed.join(", "),
        );
      });
    }
  } catch (e) {
    console.error("[dupeGuard] sweep failed for " + file + ": " + e.message);
  }
  return healed;
}

function _resetForTests() {
  claims.clear();
  healingWrites.clear();
  writeSeq = 0;
}

module.exports = { enforceSingleHome, noteWrite, watches, CONFIG_RE, CLAIM_TTL_MS, _resetForTests };
