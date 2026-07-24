// EpicNPC game -> forum node id catalog + bridge helpers.
//
// EpicNPC (epicnpc.com) has no seller API and is bot-protected, so listings are
// created by a client-side "bridge": the site opens the game's XenForo
// "Post thread" compose form (deep-linked past the sale-type wizard) with the
// listing payload in the URL hash, and a one-time bookmarklet fills the form in
// the seller's own logged-in tab. See project_epicnpc_publish + listings.html.
//
// Node ids were harvested from EpicNPC's A-Z forum directory and matched against
// the live drop catalog on 2026-07-24, then hand-verified for sequel/base-game
// collisions (e.g. Path of Exile vs Path of Exile 2, Division vs Division 2,
// World of Tanks vs Tanks Blitz). A wrong slug is fine — `/forums/x.<id>/...`
// 301s to the canonical slug and preserves the query string, so only the id
// matters.

// Game name (as stored on DropLog.game) -> EpicNPC forum node id.
const NODES = {
  "ARC Raiders": 4611,
  "ARKNIGHTS: ENDFIELD": 3785,
  "Active Matter": 5431,
  "Albion Online": 443,
  "Arena Breakout: Infinite": 4298,
  "Battlefield 6": 5321,
  "Black Desert": 422,
  "Blue Protocol: Star Resonance": 5317,
  "Borderlands 4": 5243,
  Brawlhalla: 1361,
  "Chaos Zero Nightmare": 4750,
  "Crimson Desert": 5864,
  "Dark and Darker": 2976,
  "Dead by Daylight": 1243,
  "Delta Force": 4286,
  "EVE Online": 56,
  Enshrouded: 4219,
  "Epic Seven": 1670,
  "Escape from Tarkov": 835,
  "Escape from Tarkov: Arena": 3789,
  "Eternal Return": 2324,
  Fortnite: 733,
  "Gray Zone Warfare": 4154,
  "Guild Wars 2": 19,
  "Halo Infinite": 2583,
  Hearthstone: 234,
  "Honkai: Star Rail": 2566,
  "Hunt: Showdown 1896": 4415,
  "Infinity Nikki": 4697,
  "League of Legends": 160,
  "Legend of YMIR": 4934,
  "Lost Ark": 1387,
  Marathon: 5046,
  "Marvel Rivals": 4095,
  "Mistfall Hunter": 6176,
  "NARAKA: BLADEPOINT": 2486,
  "Night Crows": 3911,
  "No Man's Sky": 2092,
  "Once Human": 4061,
  Overwatch: 2796,
  "PGA TOUR 2K25": 5266,
  "PUBG: BATTLEGROUNDS": 1176,
  Palia: 3388,
  "Path of Exile": 152,
  "Path of Exile 2": 4292,
  Predecessor: 2960,
  "RF Online Next": 6046,
  "Ragnarok Origin: Classic": 6099,
  "Rainbow Six Siege": 1071,
  Ravendawn: 3842,
  "Rocket League": 913,
  Rust: 303,
  "Sea of Thieves": 1226,
  "Shakes and Fidget": 1242,
  Soulmask: 5199,
  "Standoff 2": 1979,
  "Star Citizen": 353,
  "Star Wars: The Old Republic": 88,
  "THE FINALS": 3604,
  "Tanki Online": 1041,
  "Tanks Blitz": 549,
  "The Crew: Motorfest": 4893,
  "The Elder Scrolls Online": 250,
  "The First Descendant": 4197,
  "The Outlast Trials": 2929,
  "Throne and Liberty": 3253,
  "Tom Clancy's The Division 2": 1702,
  "Tom Clancy's The Division: Resurgence": 5912,
  "Torchlight: Infinite": 2916,
  VALORANT: 1974,
  "War Thunder": 199,
  Warframe: 190,
  "Warhammer 40,000: Space Marine II": 4476,
  "Where Winds Meet": 4093,
  "World of Tanks": 112,
  "Zenless Zone Zero": 2847,
};

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/tom clancy'?s/g, "")
    .replace(/[’'`:.,\-–™®_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Precomputed normalized index so lookups tolerate punctuation/case drift
// between DropLog.game and the map keys.
const NORM_INDEX = {};
for (const [name, node] of Object.entries(NODES)) {
  NORM_INDEX[normalize(name)] = { name, node };
}

// Resolve a game name to its EpicNPC forum node. Exact (normalized) match only —
// no fuzzy fallback, because a wrong node silently lists in the wrong game's
// forum. Returns { node, name } or null if the game has no EpicNPC forum.
function nodeForGame(game) {
  if (!game) return null;
  return NORM_INDEX[normalize(game)] || null;
}

// The compose deep-link that skips EpicNPC's "single/multiple item" wizard and
// lands directly on the account-sale "Post thread" form for `node`.
function composePath(node) {
  return (
    "/forums/x." +
    node +
    "/post-thread?field_id=ThreadTypeAccounts&field_value=SingleItem&question1a=0"
  );
}

// Base64url so the payload rides safely in a URL hash (never sent to a server).
function encodePayload(payload) {
  const json = JSON.stringify(payload);
  return Buffer.from(json, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Full EpicNPC URL the site opens in a new tab; the bookmarklet reads #epfill.
function buildComposeUrl(node, payload) {
  return (
    "https://www.epicnpc.com" +
    composePath(node) +
    "#epfill=" +
    encodePayload(payload)
  );
}

module.exports = {
  NODES,
  normalize,
  nodeForGame,
  composePath,
  buildComposeUrl,
  encodePayload,
  supportedGames: Object.keys(NODES),
};
