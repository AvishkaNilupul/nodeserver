// ---------------------------------------------------------------------------
// Bulk packs — the ONE place a pack is multiplied (docs/bulk-packs/PACKS-2.md §1).
//
// A bulk listing is one item priced as a whole pack of N accounts. Everything
// the marketplace counts (quantity, units bought, delivered qty) is in PACKS;
// everything we hand over or reserve is in ACCOUNTS. Converting between the two
// anywhere else is how a quantity gets misread — PlayerAuctions order 16474028
// shipped eleven accounts for a $5 sale because "11" meant items, not accounts.
//
// Pure: no I/O. A row that is not a bulk pack is always ×1, so existing
// listings behave exactly as before.
// ---------------------------------------------------------------------------

// N for a MarketplaceListing row: >= 2 only for a bulk pack row.
function packSizeOf(row) {
  if (!row || !row.bulkOfferId) return 1;
  const n = Math.floor(Number(row.bulkPackSize));
  return Number.isFinite(n) && n >= 2 ? n : 1;
}

// Accounts to hand over for `units` units bought on this row.
function accountsForUnits(row, units) {
  const u = Math.floor(Number(units));
  if (!Number.isFinite(u) || u < 1) return 0;
  return u * packSizeOf(row);
}

// Whole packs that `freeAccounts` accounts can fill (what a listing may advertise).
function packsFor(freeAccounts, packSize) {
  const free = Math.floor(Number(freeAccounts));
  const n = Math.floor(Number(packSize));
  if (!Number.isFinite(free) || free <= 0) return 0;
  if (!Number.isFinite(n) || n < 1) return 0;
  return Math.floor(free / n);
}

module.exports = { packSizeOf, accountsForUnits, packsFor };
