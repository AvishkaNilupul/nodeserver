// Keep marketplace IO separate so interrupted edits and a concurrent sale can
// be exercised without ever publishing test stock.
const { contentHash } = require("./skinAccountContent");
function usdPrice(offer) {
  const p =
    offer?.pricePerUnitInUSD?.currency === "USD"
      ? offer.pricePerUnitInUSD
      : offer?.pricePerUnit;
  if (p?.currency !== "USD" || !Number.isFinite(+p.amount) || +p.amount < 0.05)
    throw new Error("Marketplace USD price is not readable");
  return +p.amount;
}
async function updateListed({ skin, preview, priceUsd }, deps) {
  const { eld, read, record, saveListing } = deps;
  let before = await read(skin);
  if (before.sold) return { sold: true };
  if (
    (before.privateValues || []).some(
      (v) => v && (preview.title + "\n" + preview.description).includes(v),
    )
  )
    throw new Error("Private delivery value found in public copy");
  const textChanged =
    before.offer.offerTitle !== preview.title ||
    before.offer.description !== preview.description;
  const priceChanged = Math.abs(usdPrice(before.offer) - priceUsd) > 0.005;
  if (!textChanged && !priceChanged) {
    await record({ "listingMeta.lastContentHash": contentHash(preview) });
    return { changed: false };
  }
  // Price-only edits never submit a stock snapshot.
  if (!textChanged) {
    await eld.changeAccountOfferPrice(skin.remoteOfferId, priceUsd);
    const after = await read(skin);
    if (after.sold) return { sold: true };
    if (Math.abs(usdPrice(after.offer) - priceUsd) > 0.005)
      throw new Error("Price read-back differs");
    await saveListing({ priceUsd });
    await record({ listingPriceUsd: priceUsd });
    return { changed: true };
  }
  await record({
    mutation: { kind: "edit", at: new Date(), wasActive: before.active },
    "farm.allowed": false,
  });
  if (before.active) await eld.pauseAccountOffer(skin.remoteOfferId);
  before = await read(skin);
  if (before.sold) return { sold: true };
  if (before.offer.offerState !== "Paused")
    throw new Error("Offer pause was not verified");
  const entry = before.entry;
  if (!entry?.id)
    throw new Error("An edit must preserve the existing stock entry ID");
  // Never reconstruct credentials or add an entry without an ID. A consumed
  // entry must fail the remote edit; it must never become newly-created stock.
  await eld.updateAccountOffer(skin.remoteOfferId, {
    title: preview.title,
    description: preview.description,
    priceUsd,
    hasOriginalEmail: before.offer.hasOriginalEmail,
    mainOfferImage: before.offer.mainOfferImage,
    offerImages: before.offer.offerImages || [],
    entries: [entry],
    section: deps.section(skin),
  });
  let after = await read(skin);
  if (after.sold) return { sold: true };
  if (
    after.entry.id !== entry.id ||
    after.entry.additionalInfo !== entry.additionalInfo ||
    after.entry.accountPassword !== entry.accountPassword ||
    after.entry.emailPassword !== entry.emailPassword ||
    JSON.stringify(after.offer.mainOfferImage) !==
      JSON.stringify(before.offer.mainOfferImage) ||
    JSON.stringify(after.offer.offerImages || []) !==
      JSON.stringify(before.offer.offerImages || []) ||
    after.offer.offerTitle !== preview.title ||
    after.offer.description !== preview.description ||
    Math.abs(usdPrice(after.offer) - priceUsd) > 0.005
  )
    throw new Error("Offer read-back differs from the verified update");
  await saveListing({
    title: preview.title,
    description: preview.description,
    priceUsd,
  });
  if (skin.state === "listed" && skin.ownershipStatus === "owned") {
    // One more read immediately before resume; no cached entry is reused.
    after = await read(skin);
    if (after.sold) return { sold: true };
    await eld.resumeAccountOffer(skin.remoteOfferId);
    after = await read(skin);
    if (after.sold) return { sold: true };
    if (!after.active) throw new Error("Offer resume was not verified");
  }
  await record({
    mutation: {},
    listingPriceUsd: priceUsd,
    "listingMeta.lastContentHash": contentHash(preview),
  });
  return { changed: true };
}
module.exports = { updateListed, usdPrice };
