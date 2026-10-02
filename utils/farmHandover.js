// The rent-farm hand-over, shared by the Eldorado, G2G and PlayerAuctions farm
// services (2026-10-01):
//
//   - the term in the buyer's own words: "1 year", "2 years", "180 days"
//     (a 2-year window read "730 days" to someone who bought "2 Years");
//
//   - the window counts from the HAND-OVER. Provisioning stamps now + days on
//     each account, but the login can reach the buyer much later — Eldorado
//     holds an order until its chat exists, and a send that fails is retried
//     tick after tick. The message now says "until <date>", and every account
//     is re-stamped to end no earlier than that date, so the buyer gets the
//     whole term they were told about (never less than was already stamped);
//
//   - a failure AFTER the login reached the buyer keeps the order "sent": the
//     buyer has it; only confirming the delivery on the market failed. A page
//     that said "NOT delivered" invited a second hand-over by hand, or a
//     refund, for an order that was fine.
const DAY_MS = 24 * 60 * 60 * 1000;
const HOLDER = "operator-selffarm";

function termWords(days) {
  const d = Math.max(0, Math.floor(Number(days) || 0));
  if (d >= 365 && d % 365 === 0) {
    const y = d / 365;
    return y === 1 ? "1 year" : y + " years";
  }
  return d === 1 ? "1 day" : d + " days";
}

// The end of a window of `days` starting at `from`.
function untilFrom(days, from = new Date()) {
  return new Date(new Date(from).getTime() + Math.max(0, Number(days) || 0) * DAY_MS);
}

// "2026-11-01" — the date the buyer is told (UTC, as every window is kept).
function dayText(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Re-stamp an order's accounts to end no earlier than `until`: the rent-farm
// holder's live, bounded ledger rows (an open-ended row stays open) and the
// order row's own copy (the caller saves the row). Never moves a window
// earlier. Returns how many ledger rows moved.
async function stampFromHandover(row, until) {
  const at = new Date(until);
  const accts = (row.accounts || []).filter((a) => a && String(a.login || "").trim());
  if (!accts.length) return 0;
  for (const a of row.accounts || []) {
    if (!a.farmUntil || new Date(a.farmUntil) < at) a.farmUntil = at;
  }
  const Renter = require("../models/Renter");
  const RenterAccount = require("../models/RenterAccount");
  const holder = await Renter.findOne({ usernameLower: HOLDER }, { _id: 1 }).lean();
  if (!holder) return 0;
  // Each account by its TOKEN (read from its pool row) where that can be read:
  // a login is not an identity in this pool — duplicate logins are a known
  // population — and a login match would move a twin's window as well. An
  // account whose pool row cannot be read falls back to its login.
  const poolIds = accts.map((a) => String(a.poolId || "")).filter((x) => /^[a-f0-9]{24}$/i.test(x));
  let secretByPool = new Map();
  if (poolIds.length) {
    const AvailableAccount = require("../models/AvailableAccount");
    const pools = await AvailableAccount.find({ _id: { $in: poolIds } }, { clientSecret: 1 })
      .lean()
      .catch(() => []);
    secretByPool = new Map(pools.filter((p) => p.clientSecret).map((p) => [String(p._id), p.clientSecret]));
  }
  // A pool token no holder row carries (the two sides refreshed apart) falls
  // back to the login too, rather than leaving that account un-stamped.
  const poolSecrets = [...new Set(accts.map((a) => secretByPool.get(String(a.poolId || ""))).filter(Boolean))];
  const ledgerHas = poolSecrets.length
    ? new Set(
        (await RenterAccount.find({ renter: holder._id, clientSecret: { $in: poolSecrets } }, { clientSecret: 1 })
          .lean()
          .catch(() => [])).map((r) => r.clientSecret),
      )
    : new Set();
  const secrets = [];
  const logins = [];
  for (const a of accts) {
    const cs = secretByPool.get(String(a.poolId || ""));
    if (cs && ledgerHas.has(cs)) secrets.push(cs);
    else logins.push(String(a.login).trim());
  }
  const which = [];
  if (secrets.length) which.push({ clientSecret: { $in: secrets } });
  if (logins.length) {
    which.push({ login: { $in: logins.map((l) => new RegExp("^" + escapeRegExp(l) + "$", "i")) } });
  }
  const r = await RenterAccount.updateMany(
    {
      renter: holder._id,
      farmEndedAt: null,
      farmUntil: { $ne: null, $lt: at },
      $or: which,
    },
    { $set: { farmUntil: at } },
  );
  return (r && (r.modifiedCount || r.nModified)) || 0;
}

// The date the hand-over names, fixed at the FIRST send attempt and saved on
// the order BEFORE anything is sent. A retry — a send that timed out after it
// reached the buyer, a send retried after UTC midnight, a moderated G2G send
// re-offered later — must rebuild the SAME text: Eldorado's idempotency key and
// G2G's duplicate check are both computed from the message body, so a new date
// is a new message and the buyer gets the login twice, with two different end
// dates. The ledger is still stamped to end no earlier than now + days when the
// login really goes out (see `handoverStamp`), so a late hand-over never gives
// the buyer less than the date they were told.
async function pinUntil(row, days) {
  if (row.handoverUntil) return new Date(row.handoverUntil);
  const until = untilFrom(days);
  row.handoverUntil = until;
  await row.save();
  return until;
}

// What the ledger is stamped to when the login goes out: the pinned date, or
// now + days if the hand-over is happening later than that date assumed.
function handoverStamp(pinned, days) {
  const now = untilFrom(days);
  return new Date(Math.max(new Date(pinned).getTime(), now.getTime()));
}

// A failure after the login reached the buyer: the row stays "sent" (the next
// tick only confirms the delivery on the market) and says so. Returns the
// reason recorded.
function sentButUnconfirmed(row, market, err) {
  const when = row.messageSentAt
    ? new Date(row.messageSentAt).toISOString().replace("T", " ").slice(0, 16) + "Z"
    : "?";
  row.state = "sent";
  row.lastError = (
    "the login WAS delivered to the buyer (" + when + "); only confirming it on " +
    market + " failed: " + String((err && err.message) || err || "unknown")
  ).slice(0, 400);
  return row.lastError;
}

function loginsOf(row) {
  return ((row && row.accounts) || []).map((a) => String((a && a.login) || "")).filter(Boolean);
}

module.exports = { termWords, untilFrom, dayText, pinUntil, handoverStamp, stampFromHandover, sentButUnconfirmed, loginsOf };
