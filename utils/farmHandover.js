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
  const logins = (row.accounts || []).map((a) => String((a && a.login) || "").trim()).filter(Boolean);
  if (!logins.length) return 0;
  for (const a of row.accounts || []) {
    if (!a.farmUntil || new Date(a.farmUntil) < at) a.farmUntil = at;
  }
  const Renter = require("../models/Renter");
  const RenterAccount = require("../models/RenterAccount");
  const holder = await Renter.findOne({ usernameLower: HOLDER }, { _id: 1 }).lean();
  if (!holder) return 0;
  const r = await RenterAccount.updateMany(
    {
      renter: holder._id,
      farmEndedAt: null,
      farmUntil: { $ne: null, $lt: at },
      login: { $in: logins.map((l) => new RegExp("^" + escapeRegExp(l) + "$", "i")) },
    },
    { $set: { farmUntil: at } },
  );
  return (r && (r.modifiedCount || r.nModified)) || 0;
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

module.exports = { termWords, untilFrom, dayText, stampFromHandover, sentButUnconfirmed, loginsOf };
