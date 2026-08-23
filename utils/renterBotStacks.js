const Renter = require("../models/Renter");
const RenterBotStack = require("../models/RenterBotStack");

const DEFAULT_CAPACITY = 10;
let backfillComplete = false;
let backfillPromise = null;

function hostId(value) {
  return String(value || "local");
}

function stackKey(host, file) {
  return hostId(host) + "|" + String(file || "");
}

// Existing production renter configs predate the registry. Backfill them with
// setOnInsert so deployment only records the current boundary; it never moves
// accounts, edits configs, or changes a capacity already chosen by an operator.
async function backfillExistingStacks() {
  const rows = await Renter.find(
    { botFile: { $gt: "" } },
    { botHost: 1, botFile: 1 },
  ).lean();
  if (!rows.length) return 0;
  const unique = new Map();
  for (const row of rows) {
    unique.set(stackKey(row.botHost, row.botFile), {
      host: hostId(row.botHost),
      file: row.botFile,
    });
  }
  try {
    await RenterBotStack.bulkWrite(
      [...unique.values()].map((row) => ({
        updateOne: {
          filter: { host: row.host, file: row.file },
          update: {
            $setOnInsert: {
              host: row.host,
              file: row.file,
              capacity: DEFAULT_CAPACITY,
              enabled: true,
            },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  } catch (err) {
    // Two first requests can race while seeding the same legacy rows. The
    // unique index makes the end state correct; losing that insert race is not
    // an endpoint failure. Any other database error still propagates.
    const duplicateOnly =
      err &&
      (err.code === 11000 ||
        (Array.isArray(err.writeErrors) &&
          err.writeErrors.length > 0 &&
          err.writeErrors.every((e) => e.code === 11000)));
    if (!duplicateOnly) throw err;
  }
  return unique.size;
}

async function ensureExistingStacks() {
  if (backfillComplete) return 0;
  if (!backfillPromise) {
    backfillPromise = backfillExistingStacks()
      .then((count) => {
        backfillComplete = true;
        return count;
      })
      .finally(() => {
        backfillPromise = null;
      });
  }
  return backfillPromise;
}

async function registerStack(host, file, capacity = DEFAULT_CAPACITY) {
  const row = await RenterBotStack.findOneAndUpdate(
    { host: hostId(host), file: String(file || "") },
    {
      $setOnInsert: {
        host: hostId(host),
        file: String(file || ""),
        capacity: Math.max(1, Math.floor(Number(capacity) || DEFAULT_CAPACITY)),
        enabled: true,
      },
    },
    { new: true, upsert: true },
  );
  return row;
}

async function listStacks() {
  await ensureExistingStacks();
  return RenterBotStack.find({ enabled: true })
    .sort({ host: 1, file: 1 })
    .lean();
}

async function requireStack(host, file) {
  await ensureExistingStacks();
  const row = await RenterBotStack.findOne({
    host: hostId(host),
    file: String(file || ""),
    enabled: true,
  }).lean();
  if (!row) {
    const err = new Error(
      "That config is not a dedicated rental stack. Create or select one from Renting.",
    );
    err.code = "not_rental_stack";
    throw err;
  }
  return row;
}

// Soft lookup for display: the enabled stack row for (host, file), or null.
// Unlike requireStack this never throws, so a caller that only wants to SHOW a
// stack's capacity (e.g. the renter detail payload) degrades to null instead of
// breaking the whole response when a row is somehow absent.
async function findStack(host, file) {
  await ensureExistingStacks();
  return RenterBotStack.findOne({
    host: hostId(host),
    file: String(file || ""),
    enabled: true,
  }).lean();
}

// Validate an operator-supplied capacity. Returns a whole number within the
// schema bounds [1, 100], or null when the input is not a usable integer. The
// route turns null into a clear 400; keeping this pure lets it be unit-tested.
function normalizeCapacity(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i < 1 || i > 100) return null;
  return i;
}

// Change an existing enabled stack's capacity. This is the ONLY place capacity
// is mutated — registration and backfill create rows via $setOnInsert and never
// touch a capacity an operator has since chosen. Returns the updated row, or
// null when no enabled stack matches. Throws on an out-of-range capacity.
async function setStackCapacity(host, file, capacity) {
  const cap = normalizeCapacity(capacity);
  if (cap == null) {
    const err = new Error("Capacity must be a whole number between 1 and 100.");
    err.code = "bad_capacity";
    throw err;
  }
  return RenterBotStack.findOneAndUpdate(
    { host: hostId(host), file: String(file || ""), enabled: true },
    { $set: { capacity: cap } },
    { new: true },
  ).lean();
}

function assertCapacity(current, additions, capacity) {
  const used = Math.max(0, Math.floor(Number(current) || 0));
  const fresh = Math.max(0, Math.floor(Number(additions) || 0));
  const max = Math.max(1, Math.floor(Number(capacity) || DEFAULT_CAPACITY));
  if (used + fresh > max) {
    const err = new Error(
      "Rental stack capacity exceeded (" +
        used +
        "/" +
        max +
        " accounts used).",
    );
    err.code = "rental_stack_full";
    err.capacity = max;
    err.used = used;
    err.requested = fresh;
    throw err;
  }
  return {
    used,
    additions: fresh,
    capacity: max,
    remaining: max - used - fresh,
  };
}

// Pick a stack for the one-click farming flow. Prefer reachable remote hosts
// (the Pi fleet) over the web server, then pack the fullest stack first so we
// do not spread a handful of accounts across many running containers.
function chooseAvailableStack(stacks) {
  return (Array.isArray(stacks) ? stacks : [])
    .filter((stack) => Number(stack.remaining) > 0)
    .slice()
    .sort((a, b) => {
      const aLocal = hostId(a.host) === "local" ? 1 : 0;
      const bLocal = hostId(b.host) === "local" ? 1 : 0;
      if (aLocal !== bLocal) return aLocal - bLocal;
      const used = (Number(b.accounts) || 0) - (Number(a.accounts) || 0);
      if (used) return used;
      return stackKey(a.host, a.file).localeCompare(stackKey(b.host, b.file));
    })[0] || null;
}

async function dedicatedConfigSet() {
  const rows = await listStacks();
  return new Set(rows.map((row) => stackKey(row.host, row.file)));
}

module.exports = {
  DEFAULT_CAPACITY,
  hostId,
  stackKey,
  ensureExistingStacks,
  registerStack,
  listStacks,
  requireStack,
  findStack,
  normalizeCapacity,
  setStackCapacity,
  assertCapacity,
  chooseAvailableStack,
  dedicatedConfigSet,
};
