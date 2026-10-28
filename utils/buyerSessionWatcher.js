// Periodic sweep for live BuyerMailSession rows:
//
//   1. Flip revokedAt=now, revokedReason='expired' on rows whose expiresAt has
//      passed. The /mail/* routes already treat an expired row as dead via
//      isLive(), but stamping the row keeps the admin table honest and lets
//      future audits see what killed each session.
//
//   2. For each still-live row, read Epic mail since session.createdAt and
//      scan subjects for the "your Epic email has been changed/updated"
//      family. First match → revoke with reason='email_changed'. The buyer
//      no longer needs the viewer at that point (they own the inbox now via
//      the new email), and the Outlook address is back to being a SOOP
//      recovery that must never be reachable from /mail.
//
// Conservative on failure: a Graph read error (dead refresh token, timeout,
// 429) does NOT revoke. The buyer is innocent — we try again next tick.
//
// Interval is kept tight (default 10 min) because the window between "email
// changed" and "buyer no longer has a reason to be on /mail" is small; the
// cost is one Graph list call per live session, which is cheap.

const BuyerMailSession = require("../models/BuyerMailSession");
const outlook = require("./outlookGraphReader");

const DEFAULT_INTERVAL_MS = Number(process.env.BUYER_SESSION_SWEEP_MS) || 10 * 60 * 1000;

// Subjects Epic uses when the account's email address changes. Matched
// case-insensitively against the subject. Keep this pattern defensive: a false
// positive revokes a legitimate buyer, so prefer precision over recall. New
// phrasings add to the list.
const EMAIL_CHANGE_SUBJECT_RE =
  /(email (address )?(has been |was )?(changed|updated))|(email change (successful|confirmed|completed))|(your epic games (account )?email)/i;

function detectsEmailChange(messages) {
  if (!Array.isArray(messages)) return null;
  for (const m of messages) {
    const subject = String(m?.subject || "");
    if (EMAIL_CHANGE_SUBJECT_RE.test(subject)) return m;
  }
  return null;
}

async function expirePastDue(now = new Date()) {
  const r = await BuyerMailSession.updateMany(
    { revokedAt: null, expiresAt: { $lte: now } },
    { $set: { revokedAt: now, revokedReason: "expired" } },
  );
  return r?.modifiedCount || 0;
}

async function sweepLiveSessions({ now = new Date(), logger = console } = {}) {
  const rows = await BuyerMailSession.find({
    revokedAt: null,
    expiresAt: { $gt: now },
  })
    .limit(200) // cap one tick so a huge backlog can't melt the Graph quota
    .lean();

  let checked = 0;
  let revoked = 0;
  const errors = [];
  for (const row of rows) {
    checked++;
    try {
      const { messages } = await outlook.readEpicMailFor({
        inboxAddress: row.inboxAddress,
        sinceIso: new Date(row.createdAt).toISOString(),
        top: 20,
      });
      const hit = detectsEmailChange(messages);
      if (!hit) continue;
      await BuyerMailSession.updateOne(
        { _id: row._id, revokedAt: null },
        {
          $set: {
            revokedAt: new Date(),
            revokedReason: "email_changed",
          },
        },
      );
      revoked++;
      logger.log(
        "[buyerSessionWatcher] revoked",
        String(row._id),
        "— Epic email change detected:",
        String(hit.subject || "").slice(0, 80),
      );
    } catch (err) {
      errors.push({ id: String(row._id), msg: err && err.message });
    }
  }
  return { checked, revoked, errors };
}

async function sweepOnce({ now = new Date(), logger = console } = {}) {
  const expired = await expirePastDue(now);
  const live = await sweepLiveSessions({ now, logger });
  if (expired || live.revoked || live.errors.length) {
    logger.log(
      "[buyerSessionWatcher] sweep: expired=%d checked=%d revoked=%d errors=%d",
      expired,
      live.checked,
      live.revoked,
      live.errors.length,
    );
  }
  return { expiredAt: now, expired, ...live };
}

let timer = null;

function scheduleNext(intervalMs, logger) {
  timer = setTimeout(async () => {
    try {
      await sweepOnce({ logger });
    } catch (err) {
      (logger || console).warn("[buyerSessionWatcher] sweep failed", err && err.message);
    } finally {
      scheduleNext(intervalMs, logger);
    }
  }, intervalMs);
  if (timer && timer.unref) timer.unref();
}

function start({ intervalMs = DEFAULT_INTERVAL_MS, logger = console } = {}) {
  if (timer) return;
  // Delay the first sweep by one interval so it doesn't fight the boot storm.
  scheduleNext(intervalMs, logger);
}

function stop() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

module.exports = {
  start,
  stop,
  sweepOnce,
  sweepLiveSessions,
  expirePastDue,
  detectsEmailChange,
  EMAIL_CHANGE_SUBJECT_RE,
};
