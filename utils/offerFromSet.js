// Copy a Shop / Custom listing (a DropSet) into an account listing
// (docs/ACCOUNT-LISTINGS-CONTRACT.md Feature B, extended 2026-09-11).
//
// The owner builds bundles on the Twitch-inventory page — "Create listing" from
// a checked account's drops — and those land on the Shop tab as DropSets. They
// also want to sell the same bundle as their OWN accounts, which is what an
// account listing is: so the set is copied into a draft AccountOffer, and the
// owner opens it, pastes the logins and publishes.
//
// What is copied is the PRODUCT — title, game, description, price, cover — and
// nothing else. Above all not the set's stock: a DropSet's stock is whichever
// Drop Archive account holds every item, an account listing's stock is exactly
// the accounts pasted into it, and letting the first become the second would
// put archive accounts on a supplied shelf — one account sold by both paths,
// the double-sell the in-archive conflict gate in utils/suppliedStock exists to
// stop. Nor anything that means VISIBILITY (listed, publicCatalog): an
// AccountOffer has no such fields on purpose (models/AccountOffer.js). So the
// result is a whitelist of AccountOffer fields, built here and nowhere else.
//
// Pure: a lean object or a hydrated Mongoose document in (every field is read
// through its getter — spreading a sub-document yields undefined for every
// schema field), a plain object out. No I/O.
const { listingGame } = require("./listingGame");

// The caps applyOfferBody (routes/accountListingRoutes.js) puts on the same
// fields, so a copy can never hold what a hand-made offer could not.
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 8000;
const GAME_MAX = 120;
const SERVICE_TEXT_MAX = 200;
const BULLETS_MAX = 4; // what the cover draws and the form edits
const BULLET_LEN_MAX = 120;
const COVER_IMAGES_MAX = 30;

function clean(v) {
  return typeof v === "string" ? v.trim() : "";
}

function strings(v) {
  return (Array.isArray(v) ? v : []).map(clean).filter(Boolean);
}

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
}

function itemsOf(set) {
  return (Array.isArray(set.items) ? set.items : []).filter(
    (i) => i && typeof i === "object",
  );
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Does the note already name this item as a word of its own? "Hood" must not
// count as listed just because the note says "Hoodie".
function namesItem(note, name) {
  const re = new RegExp(
    "(^|[^\\p{L}\\p{N}])" + escapeRegExp(name) + "(?=$|[^\\p{L}\\p{N}])",
    "iu",
  );
  return re.test(note);
}

// Same line shape as the publish route's buildDescription
// (routes/marketplaceRoutes.js), so an account listing reads like its set did.
function itemLine(i) {
  const qty = Math.max(1, Math.floor(Number(i.qty) || 1));
  const game = clean(i.game);
  return (
    "- " +
    (qty > 1 ? qty + "× " : "") +
    (clean(i.name) || "Reward") +
    (game ? " (" + game + ")" : "")
  );
}

// An account listing has no items behind it, so its description is the whole
// contract with the buyer — the publish route sends it verbatim instead of
// building an "Includes:" list. The copy must therefore still say which drops
// the account carries. A set's own note usually does already (the
// Twitch-inventory path and the Shop editor both write one that lists every
// item), and then it is kept exactly as written; otherwise the same
// "Includes:" block the set would have been published with is appended, so
// nothing the Shop listing promised goes missing from the copy.
function offerDescriptionFromSet(set) {
  const s = set && typeof set === "object" ? set : {};
  const note = clean(s.note);
  const items = itemsOf(s);
  const listed =
    note &&
    items.every((i) => {
      const name = clean(i.name);
      return !name || namesItem(note, name);
    });
  if (!items.length || listed) return note.slice(0, DESCRIPTION_MAX);
  return (
    (note ? note + "\n\n" : "") +
    "Includes:\n" +
    items.map(itemLine).join("\n")
  ).slice(0, DESCRIPTION_MAX);
}

// Tiles for the promo cover. The set's own cover images win, exactly as they
// do when the set itself is published (promoTileImages); otherwise the items'
// images, so the cover shows the drops this account actually carries rather
// than whatever the game's archive has cached most.
//
// Only files this app serves (a leading "/": /drop-images, /uploads). The cover
// generator would download a remote URL — serially, up to 15s each — inside
// every publish, and a copy with no usable tile just falls back to the game's
// cached drop images at publish time, which is what a hand-made offer gets.
function isHostedImage(src) {
  return src.startsWith("/") && !src.startsWith("//");
}

function coverImagesFromSet(set) {
  const s = set && typeof set === "object" ? set : {};
  const own = strings(s.coverImages).filter(isHostedImage);
  const src = own.length
    ? own
    : itemsOf(s)
        .map((i) => clean(i.image))
        .filter(isHostedImage);
  const out = [];
  for (const img of src) {
    if (out.includes(img)) continue;
    out.push(img);
    if (out.length >= COVER_IMAGES_MAX) break;
  }
  return out;
}

// The AccountOffer fields for a copy of `set`. Always a DRAFT: the shelf is
// empty until the owner pastes accounts, so there is nothing to sell yet and
// nothing is published anywhere by making the copy.
function offerFieldsFromSet(set) {
  const s = set && typeof set === "object" ? set : {};
  return {
    title: (clean(s.name) || "Account listing").slice(0, TITLE_MAX),
    description: offerDescriptionFromSet(s),
    game: listingGame({ set: s }).slice(0, GAME_MAX),
    priceUsd: money(s.price),
    minPriceUsd: money(s.minPriceUsd),
    status: "draft",
    // The only cover an account listing can publish with: the grid collage
    // numbers the set's items, and an offer has none.
    coverStyle: "promo",
    coverServiceText: clean(s.coverServiceText).slice(0, SERVICE_TEXT_MAX),
    coverBullets: strings(s.coverBullets)
      .slice(0, BULLETS_MAX)
      .map((b) => b.slice(0, BULLET_LEN_MAX)),
    coverImages: coverImagesFromSet(s),
    sourceSet: s._id || null,
  };
}

module.exports = {
  COVER_IMAGES_MAX,
  offerFieldsFromSet,
  offerDescriptionFromSet,
  coverImagesFromSet,
};
