// Pack rows in the no-claim Eldorado offer rotation and grow.
//
// A bulk pack (docs/bulk-packs/PACKS-2.md) on a no-claim set is an ordinary
// claim-at-sale row plus `bulkOfferId` + `bulkPackSize: N`: one unit bought is N
// accounts, each holding the whole set. Its stock and delivery follow the ROW's
// set like any other no-claim row; the bulk loop only watches it. So when the
// set's single offers move to another bundle, the pack can move with them — but
// with its own title ("… — PACK OF 5 ACCOUNTS (-5%)"), its own description and
// the pack cover, a quantity counted in PACKS, and its BulkOffer told about it.
//
// Only a live no-claim pack is touched. Anything else about a bulk row (a
// dropset or farm pack, an offer the owner paused or closed, a row whose title
// and pack size disagree) is left exactly as it is.

function str(v) {
  return v == null ? "" : String(v);
}

function isPackRow(row) {
  return !!(row && row.bulkOfferId);
}

function realDeps() {
  return {
    BulkOffer: require("../models/BulkOffer"),
    copy: require("./bulkPacks/copy"),
    packMath: require("./bulkPacks/packMath"),
    lock: require("./bulkPacks/lock"),
    buildPackCover: (set, opts) => require("./setImage").buildBulkCoverImage(set, opts),
  };
}

// Tests inject `d.pack`; production builds it once per deps object.
function depsOf(d) {
  if (!d.pack) d.pack = realDeps();
  return d.pack;
}

// { offer, n } when the row is a live no-claim pack; else { skip: why }.
async function packFor(d, row) {
  const p = depsOf(d);
  const n = p.packMath.packSizeOf(row);
  if (n < 2) return { skip: "bulk row with no pack size" };
  const bad = p.packMath.packMismatch(row);
  if (bad) return { skip: bad };
  const offer = await p.BulkOffer.findById(row.bulkOfferId, {
    source: 1,
    state: 1,
    open: 1,
    minQty: 1,
    discountPct: 1,
    market: 1,
  }).lean();
  if (!offer) return { skip: "bulk offer missing" };
  if (offer.source !== "noclaim") return { skip: "not a no-claim pack" };
  if (offer.state !== "live" || offer.open === false) {
    return { skip: "bulk offer is " + (offer.state || "?") };
  }
  return { offer, n };
}

// The pack's own title, description and uploaded cover for `set`. `base` is the
// single offer's copy ({ title }) — the pack title is that plus the pack suffix,
// built by the bulk system's own copy module so it reads like every other pack.
async function packCopy(d, pack, set, base, game) {
  const p = depsOf(d);
  const title = p.copy.accountsTitle({
    baseTitle: base.title,
    market: "eldorado",
    minQty: pack.n,
    discountPct: pack.offer.discountPct,
  });
  const description = p.copy.accountsDescription({
    setName: base.title,
    items: (set.items || []).map((i) => ({ name: i.name, qty: Number(i.qty) || 1 })),
    game,
    market: "eldorado",
    minQty: pack.n,
    source: "noclaim",
  });
  let cover = "";
  try {
    cover = await p.buildPackCover(set, {
      packSize: pack.n,
      discountPct: pack.offer.discountPct,
      showTotal: true,
    });
    if (!cover) throw new Error("pack cover not built");
    const image = await d.mp.eldoradoUploadImage(cover);
    return { title, description, image };
  } finally {
    if (cover) d.unlink(cover);
  }
}

// The bulk dashboard reads the offer's own copy of these.
async function recordOnOffer(d, pack, set, copy) {
  const p = depsOf(d);
  await p.BulkOffer.updateOne(
    { _id: pack.offer._id },
    { $set: { set: set._id, setName: str(set.name), title: copy.title, description: copy.description } },
  );
}

// What the row may advertise with `stock` free accounts: whole packs.
function quantityFor(d, pack, stock) {
  if (!pack) return stock;
  return depsOf(d).packMath.packsFor(stock, pack.n);
}

// Run `fn` under the bulk offer's lock (the bulk loop and the owner's buttons
// take the same one). { ran:false } when it is busy — the caller retries later.
function withLock(d, pack, fn) {
  return depsOf(d).lock.tryWithOfferLock(str(pack.offer._id), fn);
}

module.exports = { isPackRow, packFor, packCopy, recordOnOffer, quantityFor, withLock };
