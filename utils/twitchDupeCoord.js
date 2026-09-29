// State machine + reservation manager for the Overwatch dupe-box delivery
// pipeline. Two callers use it:
//
//   utils/eldoradoDupeFulfiller.js — the 60s prod tick. Detects a Paid dupe
//     order, calls enqueueForOrder() to reserve N farm-Twitch usernames and
//     mint the deep-link ref, then posts that ref into the Eldorado chat.
//
//   routes/twitchDupeRoutes.js — the HTTP surface the Mac's Telegram bot
//     hits. Its three calls (claimByOrderRef, markLinked, complete) walk the
//     job through its states, one at a time, per FIRE_LOCK on the bot side.
//
// This file deliberately has NO side effects on Eldorado, on Telegram, or on
// Twitch itself. It only mutates TwitchDupeFireJob rows and resolves creds
// via utils/accountLookup. That keeps the state machine unit-testable without
// mocking half the internet, and it means a bug in one side-effect module
// can't wedge a job in a mixed state.
const crypto = require("crypto");

const TwitchDupeFireJob = require("../models/TwitchDupeFireJob");
const { getAutoFarm } = require("./settings");
const { lookupAccountByUsername } = require("./accountLookup");

// A job's "active" states — one where the reserved usernames are still owed
// to a buyer and must not be handed to another order. Closed states (done /
// failed / cancelled) are excluded so a burnt reservation frees the slot.
const ACTIVE_STATES = [
  "awaitingClaim",
  "awaitingLink",
  "readyToFire",
  "firing",
];

// Short, unambiguous ID for the t.me?start= deep link. Six hex chars gives us
// ~16M combinations — far more than any conceivable order backlog, and short
// enough to type by hand if the deep link ever fails. The `DPBX-` prefix
// makes the intent obvious both to the buyer and in prod logs.
function mintOrderRef() {
  return "DPBX-" + crypto.randomBytes(3).toString("hex").toLowerCase();
}

// Settings accessor. Every knob lives under settings.autoFarm.twitchDupe* so
// the existing settings-audit trail catches changes for free (setAutoFarm
// already logs before→after).
function dupeSettings() {
  const af = getAutoFarm() || {};
  return {
    offerId: af.twitchDupeOfferId || "",
    // Ordered list of farm-Twitch logins we may hand out. Ordered so an
    // operator can put the freshest at the top and drain them first.
    pool: Array.isArray(af.twitchDupePool) ? af.twitchDupePool : [],
    fireCount: Number(af.twitchDupeFireCount) || 2600,
    auto: !!af.twitchDupeAuto,
    ownerChatId: Number(af.twitchDupeOwnerChatId) || 0,
    botName: af.twitchDupeBotName || "",
    silenceFallbackMinutes: Number(af.twitchDupeSilenceMinutes) || 30,
  };
}

// Return the set of usernames currently held by ANY active job. Callers use
// this to filter the pool before reserving new logins. `excludeOrderId` lets
// a re-enqueue for the same order not count its own reservation against
// itself (paranoid — enqueueForOrder is idempotent, but this keeps the guard
// honest even if a caller races).
async function reservedUsernamesInFlight(excludeOrderId = "") {
  const q = { state: { $in: ACTIVE_STATES } };
  if (excludeOrderId) q.orderId = { $ne: excludeOrderId };
  const rows = await TwitchDupeFireJob.find(q, { reservedUsernames: 1 }).lean();
  const held = new Set();
  for (const r of rows || []) {
    for (const u of r.reservedUsernames || []) {
      if (u && u.login) held.add(String(u.login).toLowerCase());
    }
  }
  return held;
}

// Pick N free usernames from the pool. Throws if the pool is dry or short.
// Order is preserved (freshest-first is on the operator to maintain in
// settings). Case-insensitive on the held check because the pool is
// user-typed and Eldorado usernames come back with mixed casing.
async function pickFreeUsernames(count, excludeOrderId = "") {
  const { pool } = dupeSettings();
  if (!pool.length) {
    throw new Error(
      "twitch dupe pool is empty — set settings.autoFarm.twitchDupePool",
    );
  }
  const held = await reservedUsernamesInFlight(excludeOrderId);
  const free = [];
  const seen = new Set();
  for (const raw of pool) {
    const login = String(raw || "").trim();
    if (!login) continue;
    const key = login.toLowerCase();
    if (seen.has(key)) continue; // pool typo dedupe
    if (held.has(key)) continue;
    seen.add(key);
    free.push(login);
    if (free.length === count) break;
  }
  if (free.length < count) {
    throw new Error(
      `twitch dupe pool short: need ${count}, have ${free.length} free`,
    );
  }
  return free;
}

// Idempotent per orderId. First call creates + reserves; subsequent calls
// return the existing row untouched so a fulfiller retry after a partial
// crash can never double-reserve or re-mint the orderRef the buyer is
// already staring at in the Eldorado chat.
async function enqueueForOrder({
  orderId,
  offerId,
  offerTitle = "",
  buyerUsername = "",
  purchaseQuantity = 1,
}) {
  if (!orderId) throw new Error("enqueueForOrder: orderId required");
  const existing = await TwitchDupeFireJob.findOne({ orderId });
  if (existing) return { job: existing, created: false };

  const need = Math.max(1, Number(purchaseQuantity) || 1);
  const chosen = await pickFreeUsernames(need, orderId);
  const now = new Date();
  const doc = await TwitchDupeFireJob.create({
    orderId,
    orderRef: mintOrderRef(),
    offerId,
    offerTitle,
    buyerUsername,
    purchaseQuantity: need,
    reservedUsernames: chosen.map((login) => ({ login })),
    state: "awaitingClaim",
    reservedAt: now,
  });
  return { job: doc, created: true };
}

// Bot /start handler calls this with the orderRef from the deep link + the
// chat_id of the DM. Resolves creds for every reserved login and returns
// them so the bot can DM the buyer the `user:pass` block. Guarded so a
// stranger who guesses an orderRef can't re-open a job already owned by
// someone else's chat.
async function claimByOrderRef(orderRef, chatId) {
  if (!orderRef) throw new Error("claim: orderRef required");
  if (!chatId) throw new Error("claim: chatId required");
  const job = await TwitchDupeFireJob.findOne({ orderRef });
  if (!job) {
    const err = new Error("unknown orderRef");
    err.code = "not_found";
    throw err;
  }
  // Re-claim by the SAME chatId is fine — buyer might delete the DM and
  // click the deep link again. A DIFFERENT chatId is a hijack attempt.
  if (
    job.telegramChatId &&
    Number(job.telegramChatId) !== Number(chatId)
  ) {
    const err = new Error("orderRef already claimed by another chat");
    err.code = "already_claimed";
    throw err;
  }
  if (job.state !== "awaitingClaim" && job.state !== "awaitingLink") {
    const err = new Error(`orderRef not claimable in state ${job.state}`);
    err.code = "bad_state";
    throw err;
  }

  const creds = [];
  const failed = [];
  for (const u of job.reservedUsernames || []) {
    let hit;
    try {
      hit = await lookupAccountByUsername(u.login, {
        includeCredentials: true,
      });
    } catch (e) {
      failed.push({ login: u.login, error: e.message });
      continue;
    }
    if (!hit || !hit.found) {
      failed.push({ login: u.login, error: "not in accountLookup" });
      continue;
    }
    // Prefer the credentials from the primary source. Password may be blank
    // on a source that never had one (renter etc.) — reject those, we need
    // both parts to hand to the buyer.
    const src = hit.sources.find((s) => s.source === hit.primarySource);
    const password = src?.credentials?.password || "";
    if (!password) {
      failed.push({ login: u.login, error: "no password stored" });
      continue;
    }
    creds.push({ login: u.login, password });
  }

  if (failed.length) {
    // One dead reservation is fatal for the whole job — a buyer expecting
    // N accounts must get N. Refuse the claim, mark job failed, surface the
    // reason so the ops fallback fires.
    job.state = "failed";
    job.lastError = "cred lookup failed: " + JSON.stringify(failed);
    await job.save();
    const err = new Error(job.lastError);
    err.code = "cred_lookup_failed";
    err.detail = failed;
    throw err;
  }

  if (job.state === "awaitingClaim") {
    job.state = "awaitingLink";
    job.claimedAt = new Date();
  }
  job.telegramChatId = Number(chatId);
  await job.save();

  return {
    orderRef: job.orderRef,
    orderId: job.orderId,
    offerId: job.offerId,
    buyerUsername: job.buyerUsername,
    purchaseQuantity: job.purchaseQuantity,
    creds,
  };
}

// Bot /linked handler flips the job forward and unblocks the FIRE_LOCK
// picker. Idempotent on state==readyToFire so a buyer's double-tap is fine.
async function markLinked(orderRef, chatId) {
  const job = await TwitchDupeFireJob.findOne({ orderRef });
  if (!job) {
    const err = new Error("unknown orderRef");
    err.code = "not_found";
    throw err;
  }
  if (Number(job.telegramChatId) !== Number(chatId)) {
    const err = new Error("chat mismatch");
    err.code = "forbidden";
    throw err;
  }
  if (job.state === "readyToFire") return { job, changed: false };
  if (job.state !== "awaitingLink") {
    const err = new Error(`cannot mark linked from ${job.state}`);
    err.code = "bad_state";
    throw err;
  }
  job.state = "readyToFire";
  job.linkedAt = new Date();
  await job.save();
  return { job, changed: true };
}

// Bot calls this AFTER acquiring its FIRE_LOCK, so the Node coord and the
// Python bot agree that no other job may enter firing on this Mac.
async function startFiring(orderRef, chatId) {
  const job = await TwitchDupeFireJob.findOne({ orderRef });
  if (!job) {
    const err = new Error("unknown orderRef");
    err.code = "not_found";
    throw err;
  }
  if (Number(job.telegramChatId) !== Number(chatId)) {
    const err = new Error("chat mismatch");
    err.code = "forbidden";
    throw err;
  }
  if (job.state === "firing") return { job, changed: false };
  if (job.state !== "readyToFire") {
    const err = new Error(`cannot start firing from ${job.state}`);
    err.code = "bad_state";
    throw err;
  }
  job.state = "firing";
  job.firedAt = new Date();
  await job.save();
  return { job, changed: true };
}

// Bot posts fire results here. Passing `success:false` on any result flips
// the whole job to `failed` so the fallback path picks it up — the buyer
// still paid, someone has to close the loop by hand. On success the caller
// (routes/twitchDupeRoutes.js) is responsible for the Eldorado-side effects.
async function complete(orderRef, chatId, results = []) {
  const job = await TwitchDupeFireJob.findOne({ orderRef });
  if (!job) {
    const err = new Error("unknown orderRef");
    err.code = "not_found";
    throw err;
  }
  if (Number(job.telegramChatId) !== Number(chatId)) {
    const err = new Error("chat mismatch");
    err.code = "forbidden";
    throw err;
  }
  if (job.state !== "firing") {
    const err = new Error(`cannot complete from ${job.state}`);
    err.code = "bad_state";
    throw err;
  }
  job.results = Array.isArray(results) ? results : [];
  const anyFailure = job.results.some((r) => r && r.success === false);
  job.state = anyFailure ? "failed" : "done";
  job.doneAt = new Date();
  if (anyFailure) {
    job.lastError =
      "one or more fires failed: " +
      job.results
        .filter((r) => r && !r.success)
        .map((r) => `${r.login}: ${r.error || "no reason"}`)
        .join("; ");
  }
  await job.save();
  return { job, failed: anyFailure };
}

async function findByOrderRef(orderRef) {
  if (!orderRef) return null;
  return TwitchDupeFireJob.findOne({ orderRef });
}

// Jobs that have been sitting at awaitingClaim past the fallback window and
// have not yet had the owner paged. Fulfiller consumes this + pages once.
async function pendingSilentJobs(now = new Date()) {
  const { silenceFallbackMinutes } = dupeSettings();
  const cutoff = new Date(now.getTime() - silenceFallbackMinutes * 60 * 1000);
  return TwitchDupeFireJob.find({
    state: "awaitingClaim",
    reservedAt: { $lte: cutoff },
    ownerNotifiedAt: null,
  });
}

async function stampOwnerNotified(id) {
  await TwitchDupeFireJob.updateOne(
    { _id: id, ownerNotifiedAt: null },
    { $set: { ownerNotifiedAt: new Date() } },
  );
}

module.exports = {
  // High-level
  enqueueForOrder,
  claimByOrderRef,
  markLinked,
  startFiring,
  complete,
  findByOrderRef,
  pendingSilentJobs,
  stampOwnerNotified,
  // Building blocks (exported for tests / power users)
  mintOrderRef,
  dupeSettings,
  reservedUsernamesInFlight,
  pickFreeUsernames,
  ACTIVE_STATES,
};
