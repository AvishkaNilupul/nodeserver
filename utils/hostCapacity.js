// ---------------------------------------------------------------------------
// Host RAM gate for NEW bot containers.
//
// Nothing weighed a bot host's memory before a container was created. The
// auto-farm counts its own containers (maxAutoBots), the no-claim feeder had no
// container cap at all, the rent-farm counts stack slots — and all three
// create containers on the same Contabo VPS. Each new TwitchDropsBot container
// is a whole process's worth of RAM; a seat in a container that already runs
// costs a fraction of that.
//
// newContainerAllowed(hostId) answers one question before a NEW container is
// created: does the host still have `hostMinFreeMb` of MemAvailable? Seats in
// existing containers are never gated. One /proc/meminfo read per host per
// 60 s, shared by every caller (concurrent reads share one SSH command), so a
// farm tick that asks ten times costs one read. A failed read is remembered for
// the same 60 s: a dead host costs one 15-s timeout a minute, not one per
// caller.
//
// An unreadable host FAILS OPEN ("RAM unknown"). The create itself needs the
// same SSH link and fails loudly on its own; a gate that failed closed would
// stop every farm on one dropped packet.
// ---------------------------------------------------------------------------

const hosts = require("./botHosts");
const settings = require("./settings");

const CACHE_MS = 60 * 1000;
const READ_TIMEOUT_MS = 15000;
// Divided inside awk on purpose: mawk (Raspberry Pi OS) prints 32-bit ints,
// so kB → bytes would overflow there (see botHosts.statsScript); MB never does.
const MEMINFO_SCRIPT = "awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo";

const cache = new Map(); // host key -> { availableMb: number|null, at: ms }
const lastGood = new Map(); // host key -> { availableMb: number, at: Date }
const pending = new Map(); // host key -> Promise<number|null>

// A resolved host object is taken for its id: passed whole, it would key the
// cache on "[object Object]", resolve to nothing and fail open for good.
function normId(hostId) {
  return hostId && typeof hostId === "object" ? hostId.id : hostId;
}

// The same mapping botHosts.resolveHost applies: no id = the local host.
function hostKey(hostId) {
  const id = normId(hostId);
  return id === undefined || id === null || id === "" ? "local" : String(id);
}

async function readMeminfo(hostId) {
  try {
    const h = hosts.resolveHost(normId(hostId));
    if (!h) return null;
    const { stdout } = await hosts.runShell(h, MEMINFO_SCRIPT, { timeout: READ_TIMEOUT_MS });
    const mb = parseInt(String(stdout || "").trim(), 10);
    return Number.isFinite(mb) && mb >= 0 ? mb : null;
  } catch (err) {
    return null;
  }
}

// MemAvailable in MB, or null when the host cannot be read (unknown host,
// SSH failure, no MemAvailable line). Never throws.
async function memAvailableMb(hostId) {
  const key = hostKey(hostId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.availableMb;
  if (pending.has(key)) return pending.get(key);
  const p = readMeminfo(hostId)
    .then((mb) => {
      const at = Date.now();
      cache.set(key, { availableMb: mb, at });
      if (mb !== null) lastGood.set(key, { availableMb: mb, at: new Date(at) });
      return mb;
    })
    .finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}

function minFreeSetting() {
  try {
    const n = Math.floor(Number(settings.getAutoFarm().hostMinFreeMb));
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (err) {
    return 0;
  }
}

// { ok, availableMb, minFreeMb, reason } — may a NEW container be created on
// this host now? `reason` is plain words, written to be shown or logged as is.
async function newContainerAllowed(hostId) {
  const minFreeMb = minFreeSetting();
  if (minFreeMb === 0) {
    return { ok: true, availableMb: null, minFreeMb: 0, reason: "RAM gate off" };
  }
  const availableMb = await memAvailableMb(hostId);
  if (availableMb === null) {
    return { ok: true, availableMb: null, minFreeMb, reason: "RAM unknown" };
  }
  if (availableMb < minFreeMb) {
    return {
      ok: false,
      availableMb,
      minFreeMb,
      reason:
        "host " + hostKey(hostId) + " has " + availableMb + " MB RAM free; a new bot container " +
        "needs at least " + minFreeMb + " MB (hostMinFreeMb)",
    };
  }
  return {
    ok: true,
    availableMb,
    minFreeMb,
    reason: availableMb + " MB RAM free (needs " + minFreeMb + " MB)",
  };
}

// The last SUCCESSFUL reading and when it was taken — cached value only, never
// SSH (for the health page, which judges its age from `at`). null until a read
// has succeeded.
function lastReading(hostId) {
  const r = lastGood.get(hostKey(hostId));
  return r ? { availableMb: r.availableMb, at: r.at } : null;
}

function _resetForTests() {
  cache.clear();
  lastGood.clear();
  pending.clear();
}

module.exports = { memAvailableMb, newContainerAllowed, lastReading, _resetForTests };
