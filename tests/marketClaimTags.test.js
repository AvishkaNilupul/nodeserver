const test = require("node:test");
const assert = require("node:assert");
const {
  MARKET_CLAIM_TAGS,
  isMarketClaimTag,
  isRealSale,
} = require("../utils/marketClaimTags");

// Every marketplace the site can publish to writes its own reservation tag into
// DropLog.soldToUsername. A tag missing from this list reads as a buyer's name,
// which turns listed-but-unsold stock into a "sale" everywhere the list is
// consulted — the drop archive's sold counts, the scanner's stop-farming
// decision, and the spent-accounts recycler.
const PUBLISHED_MARKETS = require("../models/MarketplaceListing").schema
  .path("marketplace").enumValues;

test("every marketplace we publish to has its reservation tag listed", () => {
  for (const market of PUBLISHED_MARKETS) {
    assert.ok(
      isMarketClaimTag(market),
      `"${market}" can hold live listings but is not a known reservation tag`,
    );
  }
});

test("the tags that went live most recently are covered", () => {
  // Eldorado and PlayerAuctions were added after the original copy-pasted
  // lists were written, and were the ones actually missing in production.
  assert.ok(isMarketClaimTag("eldorado"));
  assert.ok(isMarketClaimTag("playerauctions"));
  assert.ok(isMarketClaimTag("ELDORADO"));
  assert.ok(isMarketClaimTag("  PlayerAuctions  "));
});

test("real buyers are never mistaken for reservation tags", () => {
  assert.equal(isMarketClaimTag(""), false);
  assert.equal(isMarketClaimTag(null), false);
  assert.equal(isMarketClaimTag("manual"), false);
  assert.equal(isMarketClaimTag("Avishka"), false);
  assert.equal(isMarketClaimTag("bulk:BULK-A4C231"), false);
  assert.equal(isMarketClaimTag("reseller:someone"), false);
});

test("isRealSale separates a delivery from a listing reservation", () => {
  const at = new Date();
  assert.equal(isRealSale({ soldAt: at, soldToUsername: "eldorado" }), false);
  assert.equal(isRealSale({ soldAt: at, soldToUsername: "playerauctions" }), false);
  assert.equal(isRealSale({ soldAt: at, soldToUsername: "digiseller" }), false);
  assert.equal(isRealSale({ soldAt: at, soldToUsername: "somebuyer" }), true);
  assert.equal(isRealSale({ soldAt: at, soldToUsername: "bulk:BULK-1" }), true);
  assert.equal(isRealSale({ soldAt: null, soldToUsername: "somebuyer" }), false);
  assert.equal(isRealSale(null), false);
});

// The second enum with the same failure mode. UnclaimedAccount.market records
// which marketplace a no-claim account was handed to, and mongoose REJECTS a
// value outside its enum — so a fulfiller that claims stock with a market tag
// the enum has never heard of throws at the moment of delivery, with a buyer
// already waiting. Nothing else in the repo checks the two sides agree.
const fs = require("fs");
const path = require("path");
const UNCLAIMED_MARKETS = require("../models/UnclaimedAccount").schema
  .path("market").enumValues;

// The tags actually written, read out of the source rather than hand-listed, so
// a NEW fulfiller is covered the day it lands instead of the day someone
// remembers this test. Both spellings the callers use are collected: a literal
// (`market: "z2u"`, or the `market = "eldorado"` default) and a module constant
// (`market: Z2U_CLAIM_TAG`), which is resolved to its value in the same file.
function marketTagsWrittenInSource() {
  const dir = path.join(__dirname, "..", "utils");
  const found = new Map(); // tag -> the file that writes it
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(dir, file), "utf8");
    const add = (tag) => {
      if (!found.has(tag)) found.set(tag, file);
    };
    for (const re of [/\bmarket:\s*"([a-z0-9]+)"/g, /\bmarket\s*=\s*"([a-z0-9]+)"/g]) {
      let m;
      while ((m = re.exec(src))) add(m[1]);
    }
    const ident = /\bmarket:\s*([A-Z][A-Z0-9_]*)\b/g;
    let m;
    while ((m = ident.exec(src))) {
      const decl = new RegExp("\\b" + m[1] + '\\s*=\\s*"([a-z0-9]+)"').exec(src);
      // An unresolvable constant must fail loudly: silently skipping it is how
      // a market slips past this check.
      add(decl ? decl[1] : "UNRESOLVED:" + m[1]);
    }
  }
  return found;
}

test("every market a fulfiller can claim into is accepted by the schema", () => {
  const written = marketTagsWrittenInSource();
  assert.ok(written.size >= 4, "the source scan found nothing — it has rotted");
  for (const [tag, file] of written) {
    assert.ok(
      !tag.startsWith("UNRESOLVED:"),
      `utils/${file} passes ${tag.slice(11)} as a market and this test cannot ` +
        "resolve it — check it by hand and teach the scan to read it",
    );
    assert.ok(
      UNCLAIMED_MARKETS.includes(tag),
      `utils/${file} claims stock with market "${tag}", which ` +
        "UnclaimedAccount.market rejects — the claim would throw mid-delivery",
    );
    assert.ok(
      isMarketClaimTag(tag),
      `"${tag}" is written as a market but is not a known reservation tag`,
    );
  }
});

test("nothing in the market enum is a stranger to the tag list", () => {
  // The reverse direction: a market the schema accepts but the tag list does
  // not know reads as a real sale everywhere DropLog is consulted.
  for (const market of UNCLAIMED_MARKETS) {
    if (!market) continue; // "" is the undecided state, not a marketplace
    assert.ok(
      isMarketClaimTag(market),
      `UnclaimedAccount.market accepts "${market}" but it is not a claim tag`,
    );
  }
});

test("the list stays a superset of every copy it replaced", () => {
  // The three former copies, verbatim, so a future trim cannot silently
  // reintroduce the drift this module exists to end.
  for (const tag of ["gameflip", "ggsel", "digiseller", "funpay", "zeusx", "plati", "epicnpc"]) {
    assert.ok(MARKET_CLAIM_TAGS.includes(tag), `${tag} dropped from the shared list`);
  }
});
