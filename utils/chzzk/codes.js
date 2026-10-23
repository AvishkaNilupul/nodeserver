// CHZZK code collector (docs/CHZZK-FARM.md §8).
//
// Reads an account's /drops/rewards/claims list, upserts a row per claim, and
// — for every CODE reward in the "COMPLIED" state whose code we have not read
// yet — asks CHZZK for the coupon code, encrypts it, and stores it. Nothing
// here fetches or stores a code twice: a stored code can only ever be read
// again (reveal), never overwritten.
//
// Everything runs through ONE global queue. Collections serialise. Coupon
// code reads inside a collection wait `gapMs` (default 3 s) between calls so
// one account does not shout at CHZZK.
//
// Error handling (§8):
//  - AUTH from any call stops this account's collection and rethrows. The
//    farm uses that to mark the login not_logged_in.
//  - EGRESS / TIMEOUT stops this account's collection and returns
//    { error: "egress" }. The farm's watchdog is responsible for the pause.
//  - Any other failure of a single coupon-code read bumps `tries` and schedules
//    a retry 30 min later; the row's lastError is a short sentence (no code).
//
// Nothing in this file writes, logs, or returns a code in clear text.

const { ChzzkError, isAuthError, isEgressError } = require("./errors");
const { CODE_TYPES } = require("./normalize");
const { encrypt, decrypt } = require("../secretBox");

const DEFAULT_GAP_MS = 3000;
const RETRY_MS = 30 * 60 * 1000;
const MAX_LAST_ERROR = 200;

const CODE_TYPE_SET = new Set(CODE_TYPES);
const UNCODED = { $ne: true };

// A short, operator-readable sentence for a reward row's lastError. Never
// echoes the code value — only the error's kind and message tail.
function brief(err) {
  if (!err) return "unknown error";
  const code = err.code ? `${err.code}` : "ERR";
  const msg = err.message ? String(err.message) : "";
  const text = msg ? `${code}: ${msg}` : code;
  return text.length > MAX_LAST_ERROR ? text.slice(0, MAX_LAST_ERROR) : text;
}

// Parse the KST wall-clock string the claim carries. normalize.kst() can do
// it too, but we keep this file importable without a hot path dependency.
function parseKst(s) {
  if (s instanceof Date) return Number.isNaN(s.getTime()) ? null : s;
  if (typeof s !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(
    s.trim(),
  );
  if (!m) return null;
  const [y, mo, d, h, mi, sec] = m.slice(1).map((p) => Number(p || 0));
  if (!y || !mo || !d) return null;
  const wall = Date.UTC(y, mo - 1, d, h, mi, sec);
  return new Date(wall - 9 * 60 * 60 * 1000);
}

function toDate(d) {
  if (d == null) return null;
  if (d instanceof Date) return Number.isNaN(d.getTime()) ? null : d;
  if (typeof d === "number") return Number.isFinite(d) ? new Date(d) : null;
  return parseKst(String(d));
}

function sleepReal(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms | 0));
    if (t && t.unref) t.unref();
  });
}

function tryActivity(activity, entry) {
  if (!activity || typeof activity.add !== "function") return;
  try {
    activity.add(entry);
  } catch {
    /* logging is never a reason to fail */
  }
}

function createCollector({
  Account,
  Reward,
  activity,
  clientFor,
  now = Date.now,
  sleep = sleepReal,
  gapMs = DEFAULT_GAP_MS,
} = {}) {
  if (typeof clientFor !== "function") {
    throw new TypeError("codes collector needs clientFor(accountDoc) -> client");
  }
  const AccountModel = () => Account || (Account = require("../../models/ChzzkAccount"));
  const RewardModel = () => Reward || (Reward = require("../../models/ChzzkReward"));

  // ONE global queue: whatever queues up is executed one at a time.
  let chain = Promise.resolve();
  let pendingCount = 0;
  let lastCodeCallAt = 0;

  // Keep a per-collection timestamp of the latest coupon-code call so the
  // `gapMs` wait is only honoured between those, never on the first one.
  async function paceCode() {
    const wait = lastCodeCallAt + gapMs - now();
    if (wait > 0) await sleep(wait);
    lastCodeCallAt = now();
  }

  function enqueue(fn) {
    pendingCount += 1;
    const run = chain.then(fn, fn).finally(() => {
      pendingCount -= 1;
    });
    chain = run.catch(() => {});
    return run;
  }

  async function loadAccount(accountId) {
    const Acc = AccountModel();
    if (!Acc) return null;
    try {
      // Keep this cheap — one lookup by _id.
      return await Acc.findById(accountId);
    } catch {
      return null;
    }
  }

  // Upsert the row for this claim; returns the row (lean enough to drive the
  // next step) and whether a code read is wanted.
  async function upsertFromClaim(account, claim) {
    const R = RewardModel();
    const rewardNo = Number(claim && claim.rewardNo);
    if (!R || !Number.isFinite(rewardNo) || rewardNo <= 0) return null;

    const campaignNo = Number(claim.campaignNo) || 0;
    const earnedAt = toDate(claim.createdDate);
    const codeEndAt = toDate(claim.codeEndDate);
    const campaignTitle = (claim.campaign && claim.campaign.title) || "";
    const rewardType = String(claim.rewardType || "");
    const fulfillmentState = String(claim.fulfillmentState || "");
    const inApp = rewardType === "IN_APP";
    const isCodeType = CODE_TYPE_SET.has(rewardType);

    // $setOnInsert fields never clobber a stored code's hasCode or codeEnc.
    // We only $set the mutable descriptive fields; `state` is downgraded to
    // "earned" or "in_app" only when the row has no code yet (filtered by
    // hasCode: $ne true below).
    const common = {
      accountId: String(account._id),
      userIdHash: account.userIdHash || "",
      campaignNo,
      rewardNo,
      title: String(claim.title || ""),
      rewardType,
      categoryId: String(claim.categoryId || ""),
      campaignTitle,
    };
    // A date CHZZK did not send (or sent in a shape we cannot read) never
    // wipes a known one: the code shop pulls stock by codeEndAt.
    if (earnedAt) common.earnedAt = earnedAt;
    if (codeEndAt) common.codeEndAt = codeEndAt;

    // First make sure the row exists.
    await R.updateOne(
      { accountId: String(account._id), rewardNo },
      {
        $set: common,
        $setOnInsert: {
          state: inApp ? "in_app" : "earned",
          codeEnc: "",
          hasCode: false,
          codeNo: "",
          codeAt: null,
          tries: 0,
          nextTryAt: null,
          lastError: "",
          revealedAt: null,
          revealedBy: "",
        },
      },
      { upsert: true },
    );

    // IN_APP: just mark it and move on. Never fetch anything.
    if (inApp) {
      await R.updateOne(
        { accountId: String(account._id), rewardNo, hasCode: UNCODED },
        { $set: { state: "in_app" } },
      );
      return { fetchCode: false };
    }

    if (!isCodeType) return { fetchCode: false };
    if (fulfillmentState !== "COMPLIED") return { fetchCode: false };

    // Read the row back for scheduling. { hasCode: $ne: true } ensures we
    // skip rows that already carry a code — they are permanent.
    const row = await R.findOne({
      accountId: String(account._id),
      rewardNo,
      hasCode: UNCODED,
    }).lean();
    if (!row) return { fetchCode: false }; // already stored

    const codeEndMs = row.codeEndAt ? new Date(row.codeEndAt).getTime() : null;
    if (codeEndMs && codeEndMs <= now()) {
      // Expired already; mark lastError once so the panel can show it, but
      // never fetch. (Not changing state here; it stays "earned" so a review
      // can tell "we had it but it ran out" from "we never had it".)
      await R.updateOne(
        { accountId: String(account._id), rewardNo, hasCode: UNCODED },
        { $set: { lastError: "expired" } },
      );
      return { fetchCode: false };
    }
    const nextTryAt = row.nextTryAt ? new Date(row.nextTryAt).getTime() : null;
    if (nextTryAt && nextTryAt > now()) return { fetchCode: false };
    return { fetchCode: true, row };
  }

  // Fetch and store a single coupon code. Returns:
  //   { stored: true }  on success
  //   { stored: false } on an ordinary failure (tries incremented)
  //   throws            on AUTH / EGRESS / TIMEOUT (collection stops)
  async function fetchAndStore(client, account, row) {
    await paceCode();
    let payload;
    try {
      payload = await client.couponCode(row.rewardNo);
    } catch (err) {
      if (isAuthError(err)) throw err;
      if (isEgressError(err)) throw err;
      await recordFailure(account, row, err);
      return { stored: false };
    }
    const code = payload && typeof payload.code === "string" ? payload.code : "";
    if (!code) {
      await recordFailure(
        account,
        row,
        new ChzzkError("empty code", { code: "API" }),
      );
      return { stored: false };
    }
    const codeNo = payload && payload.codeNo != null ? String(payload.codeNo) : "";
    const codeEnc = encrypt(code);
    if (!codeEnc) {
      // Encryption failed — treat like an ordinary failure, never store plaintext.
      await recordFailure(
        account,
        row,
        new ChzzkError("encrypt failed", { code: "HTTP" }),
      );
      return { stored: false };
    }
    const R = RewardModel();
    // STRUCTURAL "never overwrite a code": the filter requires hasCode false.
    // Mongoose's returnDocument: "after" gives back the updated row, but we
    // do not need it here — we just need to know a doc was matched.
    const updated = await R.findOneAndUpdate(
      { _id: row._id, hasCode: UNCODED },
      {
        $set: {
          state: "stored",
          codeEnc,
          hasCode: true,
          codeNo,
          codeAt: new Date(now()),
          lastError: "",
        },
      },
      { returnDocument: "after" },
    );
    if (!updated) {
      // Another concurrent run stored it first; treat as success for counting,
      // but do not emit a duplicate activity line.
      return { stored: false, raced: true };
    }
    tryActivity(activity, {
      kind: "code",
      accountId: String(account._id),
      campaignNo: row.campaignNo || 0,
      msg: `Stored the code for "${row.title || ""}" on ${account.nickname || ""}`,
    });
    return { stored: true };
  }

  async function recordFailure(account, row, err) {
    const R = RewardModel();
    const next = new Date(now() + RETRY_MS);
    await R.updateOne(
      { _id: row._id, hasCode: UNCODED },
      {
        $set: { lastError: brief(err), nextTryAt: next },
        $inc: { tries: 1 },
      },
    );
  }

  // Collect for one account. Returns { read, stored, failed, error? }.
  async function collectOne(accountId, { reason } = {}) {
    const stats = { read: 0, stored: 0, failed: 0 };
    const account = await loadAccount(accountId);
    if (!account) return { ...stats, error: "unknown-account" };
    if (account.sold) return { ...stats, error: "sold" };

    let client;
    try {
      client = clientFor(account);
    } catch (err) {
      if (isAuthError(err)) throw err;
      if (isEgressError(err)) return { ...stats, error: "egress" };
      return { ...stats, error: brief(err) };
    }
    if (!client || typeof client.claims !== "function") {
      return { ...stats, error: "no-client" };
    }

    let claims;
    try {
      claims = await client.claims();
    } catch (err) {
      if (isAuthError(err)) throw err;
      if (isEgressError(err)) return { ...stats, error: "egress" };
      return { ...stats, error: brief(err) };
    }
    if (!Array.isArray(claims)) return { ...stats };

    tryActivity(activity, {
      kind: "collect",
      accountId: String(account._id),
      msg: `Collecting codes${reason ? ` (${reason})` : ""} on ${account.nickname || ""}`,
    });

    for (const claim of claims) {
      stats.read += 1;
      let outcome;
      try {
        outcome = await upsertFromClaim(account, claim);
      } catch (err) {
        if (isAuthError(err)) throw err;
        if (isEgressError(err)) return { ...stats, error: "egress" };
        stats.failed += 1;
        continue;
      }
      if (!outcome || !outcome.fetchCode) continue;
      let result;
      try {
        result = await fetchAndStore(client, account, outcome.row);
      } catch (err) {
        if (isAuthError(err)) throw err;
        if (isEgressError(err)) return { ...stats, error: "egress" };
        stats.failed += 1;
        continue;
      }
      if (result && result.stored) stats.stored += 1;
      else if (result && !result.raced) stats.failed += 1;
    }
    return stats;
  }

  function collect(accountId, opts = {}) {
    return enqueue(() => collectOne(accountId, opts));
  }

  async function sweepRun(accountIds) {
    const ids = Array.isArray(accountIds) ? accountIds : [];
    const out = [];
    for (const id of ids) {
      const result = await collectOne(id, { reason: "sweep" }).catch((err) => {
        if (isAuthError(err)) return { read: 0, stored: 0, failed: 0, error: "auth", _authId: id };
        return { read: 0, stored: 0, failed: 0, error: brief(err) };
      });
      out.push({ id: String(id), ...result });
      if (result && result.error === "egress") break; // stop the sweep on an egress fault
    }
    return out;
  }

  function sweep(accountIds) {
    return enqueue(() => sweepRun(accountIds));
  }

  // Decrypt one row's code, stamp revealedAt/revealedBy, return { code, row }
  // with codeEnc stripped from the row. Null when nothing to reveal.
  async function reveal(rewardId, who) {
    const R = RewardModel();
    if (!R || !rewardId) return null;
    const row = await R.findById(rewardId);
    if (!row || !row.hasCode || !row.codeEnc) return null;
    const code = decrypt(row.codeEnc);
    if (!code) return null;
    const stamped = await R.findOneAndUpdate(
      { _id: row._id, hasCode: true },
      { $set: { revealedAt: new Date(now()), revealedBy: who ? String(who) : "" } },
      { returnDocument: "after" },
    );
    const safe = (stamped || row).toObject
      ? (stamped || row).toObject({ versionKey: false })
      : { ...(stamped || row) };
    delete safe.codeEnc;
    tryActivity(activity, {
      kind: "reveal",
      accountId: String(row.accountId || ""),
      campaignNo: row.campaignNo || 0,
      msg: `Revealed the code for "${row.title || ""}" to ${who || "unknown"}`,
    });
    return { code, row: safe };
  }

  function pending() {
    return pendingCount;
  }

  return { collect, sweep, reveal, pending };
}

module.exports = { createCollector };
