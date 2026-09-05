// Logins that are ALREADY attached to a live listing, on any marketplace.
//
// One account sells once. A buyer receives the whole account, so an account
// attached to listing A must never be fed to listing B — B's buyer would get
// A's promised drops (and A's buyer, if A sells first, would find B's drops
// gone). Per-drop reservation guards the SAME set; it cannot see a different
// set on the same account, which is exactly the cross-set collision found on
// prod (113 logins on two or more active listings, still being created on
// 2026-09-03 by the guardian's restock through the GGSel/Digiseller claimers).
//
// Two fields carry the attachment: `accountLogin` (the auto-delivery account,
// or the comma-separated initial share of a Plati/GGSel product) and `units[]`
// (every unit fed to a stock product later — refills, restocks). Readers that
// looked only at accountLogin missed every refilled account. This is the ONE
// implementation; every claimer and picker uses it.
const MarketplaceListing = require("../models/MarketplaceListing");

async function loginsOnActiveListings() {
  const listed = new Set();
  const rows = await MarketplaceListing.find(
    { status: "active" },
    { accountLogin: 1, units: 1 },
  ).lean();
  for (const r of rows) {
    for (const l of String(r.accountLogin || "").split(/[,\s]+/)) {
      if (l) listed.add(l.toLowerCase());
    }
    for (const u of r.units || []) {
      const l = String((u && u.login) || "").toLowerCase();
      if (l) listed.add(l);
    }
  }
  return listed;
}

// Filter helper for candidate lists shaped { login, ... }.
function notListed(candidates, listed) {
  return (candidates || []).filter(
    (c) => !listed.has(String((c && c.login) || "").toLowerCase()),
  );
}

module.exports = { loginsOnActiveListings, notListed };
