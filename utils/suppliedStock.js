// Account listings (docs/ACCOUNT-LISTINGS-CONTRACT.md §B4): the ONE claim layer
// for stock the owner supplied by hand — a pasted list of accounts that back a
// single AccountOffer, one account per sale.
//
// Why a whole new layer instead of the existing claim paths: reserveSetOnAccount
// returns false unless the account already holds a DropLog row for every itemKey
// (utils/dropReservation.js:44-57), so a pasted external account can never be
// reserved, never shows up in availableAccountsForSet, and cannot use any
// existing claimer. There are no DropLog rows to reserve against here, so the
// double-sell guard is the ledger's own atomic status transition
// (findOneAndUpdate on status "available") plus the conflict:"in-archive" gate —
// nothing else. That is why no fulfiller may query SuppliedAccount directly: a
// second copy of this transition WOULD drift, and the drift is an oversold
// account.
//
// Ordering of the two guards matters: an account that also exists in the Drop
// Archive can be claimed by the archive path too, so those rows are excluded
// from claimable stock until the owner explicitly allows them.
const { encrypt, decrypt } = require("./secretBox");

// The delivery message when an offer sets no template of its own.
const DEFAULT_TEMPLATE =
  "Login: {login}\nPassword: {password}\n\n" +
  "Do not change the email or the password.";

// Placeholders deliveryText understands. Anything else in a template is left
// LITERAL: a typo must show up as "{lgoin}" in the preview, not as an empty gap
// the owner never notices, and never as the string "undefined" (a spread
// Mongoose sub-document once shipped "Username: undefined" to a paying buyer).
const PLACEHOLDERS = [
  "login",
  "password",
  "token",
  "email",
  "extra",
  "line",
  "title",
  "game",
];

// Ceiling on one claim. A marketplace's "quantity" is not always a number of
// accounts — an "11 Ship Skins" PlayerAuctions sale once shipped 11 accounts for
// one $5 order — so a caller passing a quantity straight through can ask for the
// whole shelf. Returning fewer than asked is a short claim, which every caller
// must already handle; draining the shelf is not recoverable.
const MAX_CLAIM = 50;

// How deep to read the shelf when looking for claimable rows. Bounded so a
// 5,000-account offer does not pull its whole ledger into memory per order.
const CLAIM_SCAN_MAX = 400;

// Values the ledger's `market` enum accepts. findOneAndUpdate/updateMany SKIP
// validation, so an unknown market string would land in the DB fine and then
// every later doc.save() on that row would throw — that is exactly how 33
// MarketplaceListing rows got status:"removed" and 172 pool accounts became
// unsaveable. Anything not on this list is written as "" instead.
const MARKETS = [
  "gameflip",
  "digiseller",
  "ggsel",
  "funpay",
  "zeusx",
  "eldorado",
  "playerauctions",
  "g2g",
  "z2u",
];

// The ledger's own status enum (models/SuppliedAccount). offerStats reports one
// count per status and nothing else may be written into that object.
const STATUSES = ["available", "fed", "sold", "removed"];

// A hung Telegram POST must not hold up a paid buyer's delivery.
const NOTIFY_TIMEOUT_MS = 5000;

// How many live listings on one offer are read when dividing the shelf (S4).
// A shelf realistically feeds one row per market; the bound only stops a
// pathological offer from pulling thousands of rows into a count that runs on
// every stock sync. Read in a stable _id order so the same rows are taken —
// and so the same row keeps the same rank — on every pass.
const SHARER_SCAN_MAX = 100;

// How many anchored case-insensitive RegExps go into one $in when sweeping
// BotAccount for a case-different login (F1b). Such a regex can only SCAN the
// { login: 1 } index, never seek it, so the cost grows with the terms in one
// query: 50 keeps each sweep short while a 1,000-login paste still costs 20
// queries rather than 1,000.
const ARCHIVE_REGEX_CHUNK = 50;

// ---------------------------------------------------------------------------
// Dependency seam
// ---------------------------------------------------------------------------

// Factories, not values (the utils/systemHealth.js:52-94 pattern): a test that
// overrides SuppliedAccount must never pay for mongoose loading the real model,
// and nothing here may require a model at module load — this file is pulled in
// by fulfillers that run at boot.
const REAL_DEPS = {
  SuppliedAccount: () => require("../models/SuppliedAccount"),
  AccountOffer: () => require("../models/AccountOffer"),
  // S4: one shelf can back several live listings, so the claim layer has to be
  // able to see them to divide it. Lazy like the rest — a fulfiller pulling
  // this file in at boot must not drag the listing model in with it.
  MarketplaceListing: () => require("../models/MarketplaceListing"),
  BotAccount: () => require("../models/BotAccount"),
  AvailableAccount: () => require("../models/AvailableAccount"),
  settings: () => require("./settings"),
  telegram: () => require("./telegram"),
  systemLog: () => require("./systemLog"),
};

function dep(name, deps = {}) {
  if (Object.prototype.hasOwnProperty.call(deps, name)) return deps[name];
  const make = REAL_DEPS[name];
  if (!make) throw new Error("suppliedStock: unknown dependency " + name);
  return make();
}

// ---------------------------------------------------------------------------
// Pure helpers (no I/O, no clock, no Mongo — unit-testable as-is)
// ---------------------------------------------------------------------------

function str(v) {
  return v == null ? "" : String(v);
}

// Reconstructs the "login:password:token:email:extra" one-liner. Trailing empty
// columns are dropped but interior ones are kept as "::" so the result parses
// back to the same fields — this is the {line} placeholder and the `raw` a
// claim returns; the ledger stores no raw line of its own (see the report note
// on the B2/B4 mismatch).
//
// Every secret column is read through decrypt(), which returns a non-prefixed
// value unchanged: the two internal callers already hand it plaintext, so this
// is a no-op for them, but the helper is exported and a caller passing a RAW
// ledger row must get the credential rather than a line of base64. `extra` is
// ciphertext at rest as of F1a — it carries mail passwords and second
// addresses — so it has to be decrypted here like its siblings.
function rawLine(a) {
  const parts = [
    str(a.login),
    decrypt(str(a.password)),
    decrypt(str(a.clientSecret)),
    decrypt(str(a.email)),
    decrypt(str(a.extra)),
  ];
  while (parts.length && !parts[parts.length - 1]) parts.pop();
  return parts.join(":");
}

function isEmailish(s) {
  return str(s).includes("@");
}

// Extends utils/parseAccountList's rules from 3 colon fields to 5.
//
// Slot 3 is still disambiguated by "@" so an email pasted there is never stored
// as a bogus token that then fails its auto-check against Twitch — and with a
// 4th field either order (token:email or email:token) is accepted, because both
// spellings turn up in supplier lists. A leading "*"/"-" bullet is tolerated so
// a list copied out of a chat or a markdown note imports as-is.
//
// A line that does not split into >= 2 non-empty leading fields is REPORTED,
// never guessed at. What cannot be detected is a password containing ":" that
// still yields 3-5 fields — that ambiguity is inherent to the format, and
// guessing at it is what silently mangles credentials into the wrong columns.
function parseSuppliedAccounts(text) {
  const accounts = [];
  const badLines = [];
  for (const rawInput of str(text).split(/\r?\n/)) {
    const line = rawInput.trim().replace(/^[*-]\s+/, "");
    if (!line) continue;
    const parts = line.split(":").map((p) => p.trim());
    if (parts.length < 2 || !parts[0] || !parts[1]) {
      badLines.push(line.slice(0, 80));
      continue;
    }
    const [login, password] = parts;
    const f3 = parts[2] || "";
    const f4 = parts[3] || "";
    const tail = parts.slice(4);
    let clientSecret = "";
    let email = "";
    const spill = [];
    if (f3 && f4) {
      if (isEmailish(f3) && isEmailish(f4)) {
        // Two addresses and no way to know which is the account's: keep the
        // first and hand the second to `extra` rather than inventing a token.
        email = f3;
        spill.push(f4);
      } else if (isEmailish(f4)) {
        clientSecret = f3;
        email = f4;
      } else if (isEmailish(f3)) {
        email = f3;
        clientSecret = f4;
      } else {
        // Neither is an address, so field 4 is not the documented email column.
        // Keep it verbatim in `extra` instead of filing it as something it is
        // not.
        clientSecret = f3;
        spill.push(f4);
      }
    } else if (f3 || f4) {
      const only = f3 || f4;
      if (isEmailish(only)) email = only;
      else clientSecret = only;
    }
    const extra = spill.concat(tail).join(":");
    accounts.push({
      login,
      password,
      clientSecret,
      email,
      extra,
      raw: line,
    });
  }
  return { accounts, badLines };
}

// Renders one account's hand-over text.
//
// Accepts either a decrypted account from claimForListing or a raw ledger row —
// secretBox.decrypt returns non-prefixed values unchanged, so it is idempotent
// and the caller never has to know which it holds. Every field is read through
// its own getter: `{...listing.units[0]}` yields login: undefined on a Mongoose
// sub-document, and that shipped "Username: undefined" to a paying buyer.
function deliveryText(account, offer) {
  const a = account || {};
  const o = offer || {};
  const values = {
    login: str(a.login),
    password: decrypt(str(a.password)),
    token: decrypt(str(a.clientSecret)),
    email: decrypt(str(a.email)),
    // F1a: `extra` used to be the one column stored in cleartext. A 5-field
    // paste routes real credential material into it (a mail password, a second
    // address), so it is encrypted at rest now and decrypted here — decrypt()
    // passes plaintext through, so rows written before the fix still render.
    extra: decrypt(str(a.extra)),
    title: str(o.title),
    game: str(o.game),
  };
  values.line = rawLine({
    login: values.login,
    password: values.password,
    clientSecret: values.token,
    email: values.email,
    extra: values.extra,
  });
  const template = str(o.deliveryTemplate).trim() || DEFAULT_TEMPLATE;
  const re = new RegExp("\\{(" + PLACEHOLDERS.join("|") + ")\\}", "g");
  return template.replace(re, (_m, key) => values[key] || "");
}

// The one test for "is this row backed by owner-supplied stock". Every new
// fulfiller branch is guarded by it, so behaviour is byte-identical on the rows
// that exist today.
function isSuppliedRow(listing) {
  return !!(listing && listing.accountOffer);
}

// Resolve whatever the caller had to hand into an AccountOffer id: an id string,
// an ObjectId, a MarketplaceListing row, or an AccountOffer document.
//
// A MarketplaceListing WITHOUT accountOffer returns null rather than falling
// through to its own _id — an archive-backed row must never be able to look like
// an offer, or a claim against it would silently match nothing (or, worse, some
// unrelated offer whose id it shared).
function offerIdOf(src) {
  if (!src) return null;
  if (typeof src === "string") return src.trim() || null;
  if (typeof src.toHexString === "function") return src;
  if (src.accountOffer) return src.accountOffer;
  if (src.marketplace || src.externalId) return null;
  if (src.offer) return src.offer;
  if (src._id) return src._id;
  return null;
}

// Only stamp `listing` when the caller really handed us a listing ROW backed by
// an offer. claimForListing's first argument may be a bare offer id, and
// writing that into the ledger's listing ref would point the reconciler at a
// MarketplaceListing that does not exist.
function listingIdOf(src) {
  if (!src || typeof src !== "object") return null;
  if (!src.accountOffer) return null;
  return src._id || null;
}

// markFed/markDelivered are told the listing explicitly, so an id, an ObjectId
// or the row itself are all fine there.
function listingRefOf(src) {
  if (!src) return null;
  if (typeof src === "string") return src.trim() || null;
  if (typeof src.toHexString === "function") return src;
  return src._id || null;
}

function safeMarket(market) {
  const m = str(market).trim().toLowerCase();
  return MARKETS.includes(m) ? m : "";
}

function idList(ids) {
  const out = [];
  for (const id of Array.isArray(ids) ? ids : [ids]) {
    if (id == null) continue;
    const s = typeof id === "object" && id._id ? id._id : id;
    if (str(s)) out.push(s);
  }
  return out;
}

function toAccount(row) {
  const login = str(row.login);
  const password = decrypt(str(row.password));
  const clientSecret = decrypt(str(row.clientSecret));
  const email = decrypt(str(row.email));
  // F1a: encrypted at rest like its siblings; decrypt() is idempotent, so a row
  // pasted before the fix still comes back as the owner typed it.
  const extra = decrypt(str(row.extra));
  return {
    ledgerId: String(row._id),
    login,
    password,
    clientSecret,
    email,
    extra,
    raw: rawLine({ login, password, clientSecret, email, extra }),
  };
}

function logSafely(deps, fields) {
  try {
    const { logEvent } = dep("systemLog", deps);
    // Fire-and-forget, as the rest of the codebase calls it: logEvent swallows
    // its own errors, and an audit write must never be able to fail a delivery.
    Promise.resolve(logEvent(fields)).catch(() => {});
  } catch {
    /* logging is best-effort */
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// The WHOLE shelf behind an offer: available AND conflict-free. A conflicted
// row is real stock but the archive path can sell it too, so it is not ours to
// promise.
//
// This is the undivided figure and it is almost never what a marketplace should
// be told — use stockFor for that. It is here for the callers that genuinely
// mean "how many accounts does this offer own": the Account listings panel's
// own totals, and the low-stock warning (which is about the shelf running out,
// not about one market's slice of it).
//
// This THROWS on a DB error rather than reporting 0. Five stock counters feed
// the marketplace stock syncs and 0 takes a live offer off sale (eldorado
// pause, PA hide, G2G delist, Z2U off_line) — a fabricated 0 would unlist a
// healthy offer, so the caller decides what a failed read means.
async function shelfFor(listingOrOfferId, opts = {}) {
  const deps = opts.deps || {};
  const offer = offerIdOf(listingOrOfferId);
  if (!offer) return 0;
  const SuppliedAccount = dep("SuppliedAccount", deps);
  return SuppliedAccount.countDocuments({
    offer,
    status: "available",
    conflict: "",
  });
}

// The ids of every ACTIVE listing drawing on this offer, in a stable order.
//
// Every market is counted, not just the caller's: the shelf does not care which
// marketplace empties it, and counting per-market is exactly the hole S4
// describes — the only guard that existed counted ACTIVE PlayerAuctions rows
// alone (utils/playerauctionsFulfiller.js's old sharersOfAccountOffer, now
// deleted in favour of this), so four markets still advertised the full shelf.
async function sharerIds(offer, opts = {}) {
  const deps = opts.deps || {};
  const MarketplaceListing = dep("MarketplaceListing", deps);
  const rows = await MarketplaceListing.find(
    { accountOffer: offer, status: "active" },
    { _id: 1 },
  )
    .sort({ _id: 1 })
    .limit(SHARER_SCAN_MAX)
    .lean();
  return (rows || []).map((r) => str(r && r._id));
}

// This listing's share of `free` accounts (S4). Pure, so the rounding rule can
// be tested without Mongo.
//
// THE ROUNDING RULE: floor(free / n) each, and the remainder goes to the
// lowest-sorting listing ids, one apiece. So the shares sum to EXACTLY the
// shelf — never more, which is the invariant that matters (an oversold account
// is money already taken), and never less, which plain flooring would waste:
// 3 accounts across 4 markets would floor to 0 everywhere and take a fully
// stocked offer off sale on all of them.
//
// Sorting by id rather than by, say, price keeps the split STABLE: a listing
// keeps its rank between syncs, so two markets do not swap the spare account
// back and forth on every pass.
//
// A row with no id yet — a publish counting stock before its MarketplaceListing
// is saved — is counted as one more sharer and ranked last. It cannot be given
// a rank among rows it is not yet part of, and taking the smallest share is the
// direction that cannot oversell.
function shareOfShelf(free, selfId, ids) {
  const n0 = Math.max(0, Number(free) || 0);
  if (!n0) return 0;
  const list = (Array.isArray(ids) ? ids : []).map(str).filter(Boolean);
  const self = str(selfId);
  if (self && !list.includes(self)) list.push(self);
  const n = self ? list.length : list.length + 1;
  if (n <= 1) return n0;
  list.sort();
  const rank = self ? list.indexOf(self) : n - 1;
  return Math.floor(n0 / n) + (rank < n0 % n ? 1 : 0);
}

// What THIS listing may advertise: its share of the shelf (S4).
//
// Every claim-at-sale counter pushes the number it gets from here straight onto
// its own live offer, and they all used to get the whole shelf. Publish one
// 50-account offer to Eldorado, PlayerAuctions, G2G and Z2U and the world saw
// 200 for sale: the first 50 sales were honoured and every sale after that
// found an empty shelf with the buyer already paid. Dividing HERE means no
// counter can forget to — a per-fulfiller guard is a copy, and copies drift
// (utils/marketClaimTags.js had four).
//
// This is only about what is ADVERTISED. claimForListing is deliberately
// untouched: the shelf stays first-come-first-served at claim time, so a market
// that sells its share early can still be filled from the remainder rather than
// stranding a paid order beside stock we hold.
//
// Handed a bare offer id there is no "this listing" to take a share, so the
// whole shelf comes back — that keeps warnLowStock talking about the shelf.
async function stockFor(listingOrOfferId, opts = {}) {
  const free = await shelfFor(listingOrOfferId, opts);
  if (!free || !isSuppliedRow(listingOrOfferId)) return free;
  const offer = offerIdOf(listingOrOfferId);
  // Let a failed sharer read THROW rather than quietly falling back to the
  // whole shelf: falling back is the over-advertising direction this exists to
  // stop, and every caller already treats a failed read as "leave the offer
  // alone" (eldoradoFulfiller.syncBundleStock skips the row and re-counts next
  // pass) — which is the safe outcome.
  const ids = await sharerIds(offer, opts);
  return shareOfShelf(free, listingIdOf(listingOrOfferId), ids);
}

// The panel's counts. `claimable` and `heldBack` (S7) are the two the browser
// actually needs and the two it could not derive: grouping by status makes
// `available` count conflicted rows too, and `conflicts` is summed over EVERY
// status — including "removed" — so `available − conflicts` under-counts the
// moment the owner removes a conflicted row, which is the obvious response to
// the "Also in the Drop Archive" warning. A fully stocked offer then read as
// empty forever.
//
// claimable + heldBack === available by construction, and claimable is the same
// predicate shelfFor counts (status "available", conflict ""), so the panel and
// the claim layer can never disagree about what a sale would find.
//
// `conflicts` keeps its old meaning (every status) on purpose: it is what the
// browser falls back to on an older payload, and narrowing it would change a
// number two callers already read.
async function offerStats(offerId, opts = {}) {
  const deps = opts.deps || {};
  const offer = offerIdOf(offerId);
  const stats = {
    available: 0,
    fed: 0,
    sold: 0,
    removed: 0,
    conflicts: 0,
    claimable: 0,
    heldBack: 0,
    total: 0,
  };
  if (!offer) return stats;
  const SuppliedAccount = dep("SuppliedAccount", deps);
  const rows = await SuppliedAccount.aggregate([
    { $match: { offer: typeof offer === "string" ? toObjectId(offer) : offer } },
    {
      $group: {
        _id: "$status",
        n: { $sum: 1 },
        conflicts: {
          $sum: { $cond: [{ $ne: ["$conflict", ""] }, 1, 0] },
        },
      },
    },
  ]);
  for (const r of rows) {
    const key = str(r._id);
    // Only the four ledger statuses may land in `stats`: the enum is widened by
    // schema changes, not by whatever string an aggregate hands back, and
    // hasOwnProperty on the seeded object would otherwise let a future status
    // overwrite `total` or `claimable` themselves.
    if (STATUSES.includes(key)) stats[key] = r.n;
    if (key === "available") {
      stats.heldBack = r.conflicts || 0;
      stats.claimable = r.n - (r.conflicts || 0);
    }
    stats.conflicts += r.conflicts || 0;
    stats.total += r.n;
  }
  return stats;
}

// $match does NOT cast strings to ObjectId the way find() does, so an aggregate
// fed a string offer id matches nothing at all — silently, as an empty result.
function toObjectId(id) {
  try {
    const mongoose = require("mongoose");
    return new mongoose.Types.ObjectId(String(id));
  } catch {
    return id;
  }
}

async function offerFor(listingOrOfferId, opts = {}) {
  const deps = opts.deps || {};
  const id = offerIdOf(listingOrOfferId);
  if (!id) return null;
  const AccountOffer = dep("AccountOffer", deps);
  return AccountOffer.findById(id).lean();
}

// The delivery gate (contract §B8): the global switch, then the per-offer one.
// One live settings edit stops every account-listing delivery without touching
// any other market.
function deliveryEnabled(offer, opts = {}) {
  const deps = opts.deps || {};
  const s = dep("settings", deps).getAccountListingSettings();
  if (!s.enabled || !s.autoDeliver) return false;
  return !offer || offer.autoDeliver !== false;
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// A pasted login is owner text, not a pattern: without this "acct.x9" would
// also match "acctx9" and flag a perfectly clean account as a conflict.
function escapeRegExp(s) {
  return str(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Logins that already exist as a farm account.
//
// F1b — CASE. BotAccount.login is stored verbatim from the bot config's `Login`
// field and the model has no lowercased mirror, so an $in of the pasted
// spellings alone misses a row stored as "DropFarm_X91" when the owner pastes
// "dropfarm_x91". Every other login join in this repo compares lowercased; this
// one did not, and a missed overlap here is exactly the double-sell the gate
// exists to stop — the row becomes claimable supplied stock while the Drop
// Archive can still sell the same account.
//
// So two passes over BotAccount. The exact $in first: it SEEKS the
// { login: 1 } index and catches the ordinary case for nothing. Then an
// anchored /^login$/i $in over ONLY the logins the first pass did not find. The
// index cost of the second pass is accepted deliberately — a case-insensitive
// regex cannot seek that index, only scan it — because it is bounded
// (ARCHIVE_REGEX_CHUNK terms per query, over misses only), it runs once per
// paste rather than once per sale, and the thing it buys is not a double-sell.
//
// AvailableAccount needs none of that: usernameLower is already a lowercased
// mirror, so its $in is exact.
//
// F1c — FAILURE. Neither read swallows its error any more. Both used to end in
// .catch(() => []), which reports "no overlaps" for a transient read failure;
// because the conflict flag is computed only at ingest and never revisited,
// every row of that paste would stay claimable forever. The throw reaches
// addAccounts, which refuses the paste.
async function archiveLogins(accounts, deps) {
  const found = new Set();
  const lowers = [...new Set(accounts.map((a) => a.login.toLowerCase()))];
  const originals = [...new Set(accounts.map((a) => a.login))];
  const BotAccount = dep("BotAccount", deps);
  const AvailableAccount = dep("AvailableAccount", deps);
  for (const part of chunk([...new Set(lowers.concat(originals))], 500)) {
    const bots = await BotAccount.find(
      { login: { $in: part } },
      { login: 1 },
    ).lean();
    for (const b of bots) found.add(str(b.login).toLowerCase());
  }
  const unmatched = lowers.filter((l) => !found.has(l));
  for (const part of chunk(unmatched, ARCHIVE_REGEX_CHUNK)) {
    const bots = await BotAccount.find(
      {
        login: {
          $in: part.map((l) => new RegExp("^" + escapeRegExp(l) + "$", "i")),
        },
      },
      { login: 1 },
    ).lean();
    for (const b of bots) found.add(str(b.login).toLowerCase());
  }
  for (const part of chunk(lowers, 500)) {
    const avail = await AvailableAccount.find(
      { usernameLower: { $in: part } },
      { usernameLower: 1 },
    ).lean();
    for (const a of avail) found.add(str(a.usernameLower).toLowerCase());
  }
  return found;
}

// Parse a pasted list onto an offer. Credentials are encrypted through
// utils/secretBox before they touch the DB, exactly as BotAccount and
// AvailableAccount store theirs.
//
// Nothing is silently dropped: a login already on this offer is reported as a
// duplicate, a login that also exists in the Drop Archive is INSERTED but
// flagged conflict:"in-archive" (so the owner can see it and decide), and a line
// that could not be split is handed back verbatim.
async function addAccounts(offerId, text, opts = {}) {
  const deps = opts.deps || {};
  const offer = offerIdOf(offerId);
  const { accounts, badLines } = parseSuppliedAccounts(text);
  const result = {
    added: 0,
    duplicates: [],
    conflicts: [],
    badLines,
  };
  if (!offer || !accounts.length) return result;
  const SuppliedAccount = dep("SuppliedAccount", deps);

  // Duplicates inside the paste itself count once, and the first spelling wins.
  const seen = new Set();
  const unique = [];
  for (const a of accounts) {
    const lower = a.login.toLowerCase();
    if (seen.has(lower)) {
      result.duplicates.push(a.login);
      continue;
    }
    seen.add(lower);
    unique.push(a);
  }

  const existingRows = await SuppliedAccount.find(
    { offer },
    { loginLower: 1 },
  ).lean();
  const existing = new Set(existingRows.map((r) => str(r.loginLower)));
  const fresh = unique.filter((a) => {
    if (existing.has(a.login.toLowerCase())) {
      result.duplicates.push(a.login);
      return false;
    }
    return true;
  });
  if (!fresh.length) return result;

  // FAIL CLOSED (F1c). A failed archive lookup must never be reported as "no
  // conflicts": the flag is written here and never recomputed, so a paste that
  // sailed through a transient read failure would stay claimable forever while
  // the archive path could still sell the very same accounts.
  //
  // Of the two fail-closed options this is the cheaper one: refusing costs the
  // owner one re-paste, whereas inserting everything flagged "in-archive" would
  // have them bulk-clearing conflicts by hand — and that click, once learned,
  // is what defeats the guard on the paste where the overlap is REAL. Nothing
  // has been inserted at this point, so a refusal leaves no half state.
  let inArchive;
  try {
    inArchive = await archiveLogins(fresh, deps);
  } catch (err) {
    const e = new Error(
      "Could not check the Drop Archive for overlapping logins, so nothing " +
        "was added — a supplied account that also exists as a farm account " +
        "could be sold twice. Paste again: " +
        str(err && err.message),
    );
    e.code = "ARCHIVE_CHECK_FAILED";
    throw e;
  }
  const note = str(opts.note);
  const docs = fresh.map((a) => {
    const conflict = inArchive.has(a.login.toLowerCase()) ? "in-archive" : "";
    if (conflict) result.conflicts.push(a.login);
    return {
      offer,
      login: a.login,
      loginLower: a.login.toLowerCase(),
      password: encrypt(a.password),
      clientSecret: encrypt(a.clientSecret),
      email: encrypt(a.email),
      // F1a: encrypted like its siblings. `extra` is whatever the supplier put
      // past field 4 — a mail password, a recovery code, a second address — so
      // storing it raw left the same class of secret as ciphertext in one
      // column and cleartext in the next. Read back through decrypt(), which
      // returns the rows pasted before this fix unchanged.
      extra: encrypt(a.extra),
      status: "available",
      conflict,
      note,
    };
  });

  for (const part of chunk(docs, 200)) {
    try {
      // ordered:false so one duplicate-key race cannot abandon the rest of the
      // paste. Validators still run — this is an insert, not a
      // validateBeforeSave:false write.
      await SuppliedAccount.insertMany(part, { ordered: false });
    } catch {
      // A concurrent paste can win the { offer, loginLower } unique index. The
      // count is re-read below either way, so a partial insert is not a lie.
    }
  }

  // Truth, not bookkeeping: re-read which of these logins now exist. `existing`
  // was captured before the insert, so the delta is what this call added.
  const lowers = docs.map((d) => d.loginLower);
  let landed = 0;
  for (const part of chunk(lowers, 500)) {
    const rows = await SuppliedAccount.find(
      { offer, loginLower: { $in: part } },
      { loginLower: 1 },
    ).lean();
    landed += rows.length;
  }
  result.added = landed;
  if (result.conflicts.length) {
    logSafely(deps, {
      category: "account-listings",
      action: "ingest-conflicts",
      severity: "warn",
      subject: String(offer),
      count: result.conflicts.length,
      detail:
        result.conflicts.length +
        " supplied account(s) also exist in the Drop Archive and are held back",
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

// THE contract every fulfiller depends on. Returns the same shape as
// eldoradoFulfiller.claimUnclaimedForGame so the call sites stay symmetrical:
//   [{ ledgerId, login, password, clientSecret, email, extra, raw }]
//
// Returns FEWER than `want` when stock is short. A short claim is not a
// success — callers MUST check the length and refuse rather than part-deliver.
async function claimForListing(listing, want, opts = {}) {
  const deps = opts.deps || {};
  const dryRun = !!opts.dryRun;
  const orderId = str(opts.orderId);
  const market = safeMarket(opts.market);
  const offer = offerIdOf(listing);
  if (!offer) return [];
  const SuppliedAccount = dep("SuppliedAccount", deps);
  const n = Math.max(1, Math.min(MAX_CLAIM, parseInt(want, 10) || 1));

  // THE DELIVERY GATE (F1d, contract §B8). deliveryEnabled existed from the
  // first cut and nothing here ever called it, so an offer with
  // autoDeliver:false still handed its shelf to the next paid order — while
  // utils/g2gFulfiller.js:220-222 told its reader that "the claim layer
  // enforces" that switch. This IS the single claim layer, so the gate belongs
  // here and every fulfiller inherits it from one place instead of five.
  //
  // dryRun is exempt on purpose: the Accounts panel and the marketplace stock
  // syncs read the shelf through a dry claim, and reporting 0 while delivery is
  // merely PAUSED would take a healthy offer off sale (eldorado pause, PA hide,
  // G2G delist, Z2U off_line) — a pause would look like an empty shelf.
  //
  // Ahead of the resume block deliberately: while delivery is off, a retry must
  // hand back nothing at all. The rows a previous attempt already claimed stay
  // claimed under their orderId and come back from the resume the moment the
  // switch goes on again.
  if (!dryRun) {
    const offerRow = await offerFor(offer, { deps });
    if (!deliveryEnabled(offerRow, { deps })) {
      logSafely(deps, {
        category: "account-listings",
        action: "delivery-off",
        severity: "warn",
        subject: String(offer),
        detail:
          "claim refused: account-listing delivery is switched off for this " +
          "offer or globally" +
          (orderId ? " (order " + orderId + ")" : ""),
      });
      return [];
    }
  }

  // RESUME WHATEVER A PREVIOUS ATTEMPT ALREADY TOOK FOR THIS ORDER.
  //
  // The claim below is atomic and permanent, but the record linking those rows
  // back to the order lives in MarketplaceListing.units, written only AFTER the
  // credential has been sent. A send that throws — a TalkJS 5xx, a timeout, an
  // order row with no conversation id — leaves the accounts spent with nothing
  // tying them to the order; the caller's "already handled" guard finds no unit
  // and the next tick claims a brand new account. Eldorado order e69b19d3
  // retried 25 times that way. utils/playerauctionsFulfiller.js:166 still has
  // no such block; this layer must never repeat it.
  //
  // The ledger's orderId is the anchor. Reading it back makes the claim
  // idempotent per order, so a retry re-sends the SAME accounts.
  const out = [];
  if (orderId && !dryRun) {
    const filter = {
      offer,
      orderId,
      status: { $in: ["sold", "fed"] },
    };
    if (market) filter.market = market;
    const prior = await SuppliedAccount.find(filter)
      .sort({ soldAt: 1, _id: 1 })
      .limit(n)
      .lean();
    for (const row of prior) out.push(toAccount(row));
    if (out.length >= n) return out.slice(0, n);
  }

  const candidates = await SuppliedAccount.find({
    offer,
    status: "available",
    conflict: "",
  })
    .sort({ createdAt: 1, _id: 1 })
    .limit(Math.min(CLAIM_SCAN_MAX, (n - out.length) * 4 + 20))
    .lean();

  if (dryRun) {
    for (const row of candidates) {
      if (out.length >= n) break;
      out.push(toAccount(row));
    }
    return out;
  }

  const now = new Date();
  for (const row of candidates) {
    if (out.length >= n) break;
    // The status guard IS the double-sell guard: two concurrent orders race on
    // this one write and exactly one of them gets the row. There is no DropLog
    // reservation behind this stock to catch a second winner.
    const taken = await SuppliedAccount.findOneAndUpdate(
      { _id: row._id, status: "available", conflict: "" },
      {
        $set: {
          status: "sold",
          soldAt: now,
          market,
          orderId,
          listing: listingIdOf(listing),
        },
      },
      { new: true },
    ).lean();
    if (!taken) continue;
    out.push(toAccount(taken));
  }

  if (out.length < n) {
    logSafely(deps, {
      category: "account-listings",
      action: "short-claim",
      severity: "warn",
      subject: String(offer),
      count: out.length,
      detail:
        "asked for " + n + " supplied account(s), claimed " + out.length,
    });
  }
  if (out.length) await warnLowStock(offer, out.length, deps);
  return out;
}

// Telegram warning when an offer's shelf crosses the configured low-stock mark.
// Best-effort and bounded: this runs inside a paid buyer's delivery path, and a
// hung notification must never hold that up.
async function warnLowStock(offer, taken, deps) {
  try {
    const { lowStockWarnAt } = dep("settings", deps).getAccountListingSettings();
    if (!lowStockWarnAt) return;
    // The WHOLE shelf, not one market's share (S4): the owner is being told to
    // paste more accounts in, and a per-market slice would fire the warning
    // four times as early on a four-market offer.
    const left = await shelfFor(offer, { deps });
    // Only on the crossing: at or below before this claim means the warning has
    // already been sent, and one message per sale is noise the owner will mute.
    if (left > lowStockWarnAt || left + taken <= lowStockWarnAt) return;
    const row = await offerFor(offer, { deps });
    const title = (row && str(row.title)) || String(offer);
    const { sendTelegram } = dep("telegram", deps);
    await Promise.race([
      sendTelegram(
        "Account listing low on stock: " +
          title +
          " has " +
          left +
          " account(s) left.",
      ),
      new Promise((resolve) => setTimeout(resolve, NOTIFY_TIMEOUT_MS)),
    ]);
  } catch {
    /* a warning must never fail a delivery */
  }
}

// Put claimed rows back on the shelf. Used on every failure path.
//
// Releases "sold" AND "fed" (F1e), and only the ids given. The filter used to
// be status:"sold" alone, on the theory that a fed row's credential sits inside
// the platform's own vault — but the credential-baked-in markets move a row to
// "fed" at PUBLISH time, so every id
// utils/gameflipFulfiller.js:516 (releaseSuppliedUnits — the function that
// hands accounts back when a Gameflip listing 404s or is retired) passed in was
// already "fed": it matched zero rows, returned 0, logged nothing, and the
// account stayed stranded out of sellable stock forever. Its callers only reach
// it once the listing itself is gone, which is when the vault copy goes too.
//
// deliveredAt is the hard stop that survives, and it is the one that matters: a
// credential that has reached a buyer must never be sellable again, whatever
// its status says. A fed row still live in a vault is pulled with the offer's
// Remove action (utils/listingDetach.js:106), not with this.
async function releaseClaim(ledgerIds, opts = {}) {
  const deps = opts.deps || {};
  const ids = idList(ledgerIds);
  if (!ids.length) return 0;
  const SuppliedAccount = dep("SuppliedAccount", deps);
  // Which states may be handed back. Default is both, for a fulfiller undoing
  // its own failed claim.
  //
  // A DELIST passes ["fed"] instead, and the difference is load-bearing. "fed"
  // means the credential is parked in a marketplace's own vault, and that copy
  // dies with the offer — so it is always safe to return. "sold" means it is
  // committed to a buyer's order, which a delist does not cancel. Asking the
  // LEDGER which of the two it is, rather than reading the unit's orderId, is
  // what this fixes: gameflipFulfiller stamps a SYNTHETIC orderId on its unit
  // at publish time (":384", unique per attempt so the resume path cannot hand
  // unit 2 the account unit 1 is selling), and the delist release skipped any
  // unit carrying an orderId on the assumption it meant a live sale. Measured
  // on prod 2026-09-10: a Gameflip test listing delisted with returned=0 and
  // left its account stranded at "fed" — exactly the S1 bug the delist branch
  // was written to fix, reintroduced through a different door.
  const statuses = Array.isArray(opts.statuses) && opts.statuses.length
    ? opts.statuses
    : ["sold", "fed"];
  const filter = {
    _id: { $in: ids },
    status: { $in: statuses },
    deliveredAt: null,
  };
  const orderId = str(opts.orderId);
  if (orderId) filter.orderId = orderId;
  const res = await SuppliedAccount.updateMany(filter, {
    $set: {
      status: "available",
      soldAt: null,
      orderId: "",
      market: "",
      listing: null,
      // The vault hand-off this release just undid. A stale contentId would go
      // on pointing at a deleted Digiseller content unit, and markFed only
      // overwrites it when the market hands a new id back — so an id kept here
      // would outlive the thing it names.
      fedAt: null,
      contentId: "",
    },
  });
  const n = res.modifiedCount || 0;
  if (n) {
    logSafely(deps, {
      category: "account-listings",
      action: "release",
      subject: orderId || "",
      count: n,
      detail: n + " supplied account(s) returned to the shelf",
    });
  }
  return n;
}

// Mark rows as handed to a platform's own vault (the credential-baked-in
// markets). "fed" means: no longer sellable anywhere else, not yet known to have
// reached a buyer.
//
// `contentIds` may be one string for all rows, an array parallel to ledgerIds,
// or a map keyed by ledger id. Digiseller returns a content_id per unit on add
// and offers no endpoint to list a product's content afterwards, so an id not
// captured here is unreachable forever.
async function markFed(ledgerIds, opts = {}) {
  const deps = opts.deps || {};
  const ids = idList(ledgerIds);
  if (!ids.length) return 0;
  const SuppliedAccount = dep("SuppliedAccount", deps);
  const market = safeMarket(opts.market);
  const listingId = listingRefOf(opts.listing);
  const now = new Date();
  const contentFor = contentIdResolver(ids, opts.contentIds);
  let n = 0;
  for (const id of ids) {
    const $set = { status: "fed", fedAt: now };
    if (market) $set.market = market;
    if (listingId) $set.listing = listingId;
    const contentId = contentFor(id);
    if (contentId) $set.contentId = contentId;
    const res = await SuppliedAccount.updateOne(
      // "available" is allowed as well as "sold": a feed without a prior claim
      // is a caller bug, but the account IS in the vault by then and leaving it
      // on the shelf would sell it twice.
      { _id: id, status: { $in: ["available", "sold"] } },
      { $set },
    );
    n += res.modifiedCount || 0;
  }
  return n;
}

function contentIdResolver(ids, contentIds) {
  if (!contentIds) return () => "";
  if (typeof contentIds === "string") return () => contentIds;
  if (Array.isArray(contentIds)) {
    const byIndex = new Map();
    ids.forEach((id, i) => byIndex.set(String(id), str(contentIds[i])));
    return (id) => byIndex.get(String(id)) || "";
  }
  return (id) => str(contentIds[String(id)]);
}

// Mark claimed rows as actually delivered to a buyer.
//
// Always lands on "sold", including from "available": whatever the row's state
// was, the credential has reached a buyer and it must never be sellable again.
async function markDelivered(ledgerIds, opts = {}) {
  const deps = opts.deps || {};
  const ids = idList(ledgerIds);
  if (!ids.length) return 0;
  const SuppliedAccount = dep("SuppliedAccount", deps);
  const now = new Date();
  const $set = { status: "sold", deliveredAt: now };
  const orderId = str(opts.orderId);
  if (orderId) $set.orderId = orderId;
  const market = safeMarket(opts.market);
  if (market) $set.market = market;
  // soldAt is when the row left the shelf; a resumed delivery must not restamp
  // it, so only rows that never carried one are filled in.
  await SuppliedAccount.updateMany(
    { _id: { $in: ids }, soldAt: null },
    { $set: { soldAt: now } },
  );
  const res = await SuppliedAccount.updateMany(
    { _id: { $in: ids }, status: { $ne: "removed" } },
    { $set },
  );
  return res.modifiedCount || 0;
}

module.exports = {
  DEFAULT_TEMPLATE,
  PLACEHOLDERS,
  MAX_CLAIM,
  MARKETS,
  STATUSES,
  SHARER_SCAN_MAX,
  REAL_DEPS,
  parseSuppliedAccounts,
  deliveryText,
  rawLine,
  isSuppliedRow,
  offerIdOf,
  addAccounts,
  stockFor,
  shelfFor,
  shareOfShelf,
  offerStats,
  offerFor,
  deliveryEnabled,
  claimForListing,
  releaseClaim,
  markFed,
  markDelivered,
};
