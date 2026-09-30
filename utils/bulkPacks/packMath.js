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

// The pack size a listing TITLE promises ("… — PACK OF 5 ACCOUNTS"), or 0.
// Every bulk title carries it (copy.js), and no other listing ever has (checked
// on prod 2026-09-30: zero rows). It is the last line of defence when the pack
// size itself was lost — a publish whose outcome was unknown, a link that
// failed: an order on such an offer must be refused, never delivered x1.
const PACK_TITLE_RE = /\bPACK\s+OF\s+(\d+)\s+ACCOUNTS\b/i;
function titlePackSize(title) {
  const m = PACK_TITLE_RE.exec(String(title || ""));
  const n = m ? parseInt(m[1], 10) : 0;
  return Number.isFinite(n) && n >= 2 ? n : 0;
}

// Why an order on this listing row must be refused, or "" when it may proceed:
// a bulk row without a pack size, or a title that promises a different pack
// than the row records (including a pack title on a row that is not a pack).
function packMismatch(row) {
  if (!row) return "";
  const n = packSizeOf(row);
  const t = titlePackSize(row.title);
  if (row.bulkOfferId && n < 2) {
    return "this bulk listing has no pack size recorded";
  }
  if (t && t !== n) {
    return (
      "the title promises PACK OF " + t + " ACCOUNTS but the listing records " +
      (n > 1 ? "a pack of " + n : "no pack")
    );
  }
  return "";
}

module.exports = { packSizeOf, accountsForUnits, packsFor, titlePackSize, packMismatch };
