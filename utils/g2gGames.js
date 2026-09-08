// Farm game name -> the G2G "Game Items" product coordinates a publish needs.
//
// A Game Items offer is filed under a (service_id, brand_id) pair. The service
// is constant — every Twitch Drops offer on this account already lives in Game
// Items — so only the brand varies, and on G2G the brand IS the game.
//
// WHY THE MAP IS CHECKED IN
// The coordinates come from the public catalog
// https://assets.g2g.com/offer/categories.json (6.8MB, no auth, keyed
// seo_term -> {service_id, brand_id, cat_path, marketing_title}). That file is
// far too big to pull and parse on every publish, and it changes only when G2G
// adds a game, so it was read ONCE and the Game Items slice for the games this
// farm has actually run is pasted below. Regenerate by hand — read the catalog,
// filter on G2G_ITEMS_SERVICE, match by brand label — when a new game needs a
// G2G listing.
//
// WHY A MISS RETURNS null AND NEVER THE NEAREST BRAND
// brand_id decides which game's page the offer shows up on, and the account is
// already paying for one such mistake: nine Rainbow Six Siege bundles sit under
// "Tom Clancy's Rainbow Six Mobile" (lgc_game_30876) — a different game with a
// different audience — even though the right brand exists
// (tom-clancys-rainbow-six-siege-item, lgc_game_24713). So nothing here is
// approximated. A game either matches a brand exactly, or it matches a
// hand-checked alias, or brandForGame returns null and the auto-lister skips
// that game on G2G. Games whose nearest brand is a DIFFERENT title are absent
// on purpose: Escape from Tarkov: Arena, Halo: The Master Chief Collection,
// Halo: Campaign Evolved, World of Tanks: HEAT / Console, Mir Tankov,
// Mir Korabley, Tom Clancy's The Division: Resurgence, ARKNIGHTS: ENDFIELD,
// Tanks Blitz, SMITE 2, PUBG: BATTLEGROUNDS.

// The value lives in utils/marketplaces.js next to the rest of the G2G
// connector; re-exported here so the two can never drift.
const { G2G_ITEMS_SERVICE } = require("./marketplaces");

// farm game -> { seoTerm, brandId, marketingTitle }, ordered by how much this
// farm has actually farmed the game (busiest first). seoTerm is the catalog key
// and the offer's public URL slug; marketingTitle is G2G's own label for the
// product, useful in logs and in the operator UI. serviceId is not repeated per
// row — it is G2G_ITEMS_SERVICE for every one of them.
const GAME_BRANDS = {
  "World of Tanks": {
    seoTerm: "world-of-tanks-item",
    brandId: "lgc_game_22932",
    marketingTitle: "World of Tanks Items",
  },
  Overwatch: {
    seoTerm: "overwatch-item",
    brandId: "lgc_game_21555",
    marketingTitle: "Overwatch Items",
  },
  "Escape from Tarkov": {
    seoTerm: "escape-from-tarkov-item",
    brandId: "lgc_game_24640",
    marketingTitle: "EFT Items",
  },
  "Rocket League": {
    seoTerm: "rocket-league-item",
    brandId: "lgc_game_23797",
    marketingTitle: "Rocket League Items",
  },
  "Marvel Rivals": {
    seoTerm: "marvel-rivals-items",
    brandId: "lgc_game_34430",
    marketingTitle: "Marvel Rivals Items",
  },
  RavenQuest: {
    seoTerm: "ravenquest-items",
    brandId: "lgc_game_36721",
    marketingTitle: "RavenQuest Items",
  },
  "Delta Force": {
    seoTerm: "delta-force-items",
    brandId: "lgc_game_33932",
    marketingTitle: "Delta Force Items",
  },
  Warframe: {
    seoTerm: "warframe-item",
    brandId: "lgc_game_23657",
    marketingTitle: "Warframe Items",
  },
  Brawlhalla: {
    seoTerm: "brawlhalla-items",
    brandId: "lgc_game_24929",
    marketingTitle: "Brawlhalla",
  },
  "Dark and Darker": {
    seoTerm: "dark-and-darker-items",
    brandId: "lgc_game_31849",
    marketingTitle: "Dark and Darker Items",
  },
  "Hunt: Showdown 1896": {
    seoTerm: "hunt-showdown-item",
    brandId: "lgc_game_24901",
    marketingTitle: "Hunt: Showdown",
  },
  "Sea of Thieves": {
    seoTerm: "sea-of-thieves-item",
    brandId: "lgc_game_24939",
    marketingTitle: "Sea of Thieves",
  },
  "Halo Infinite": {
    seoTerm: "halo-infinite-items",
    brandId: "lgc_game_30075",
    marketingTitle: "Halo Infinite",
  },
  "The First Descendant": {
    seoTerm: "the-first-descendant-items",
    brandId: "lgc_game_32635",
    marketingTitle: "The First Descendant",
  },
  "Rainbow Six Siege": {
    seoTerm: "tom-clancys-rainbow-six-siege-item",
    brandId: "lgc_game_24713",
    marketingTitle: "Tom Clancys Rainbow Six Siege",
  },
  "Tom Clancy's The Division 2": {
    seoTerm: "the-division-2-item",
    brandId: "lgc_game_25783",
    marketingTitle: "Division 2 Items",
  },
  "Black Desert": {
    seoTerm: "black-desert-online-item",
    brandId: "lgc_game_23306",
    marketingTitle: "Black Desert Online Item",
  },
  Rust: {
    seoTerm: "rus-item",
    brandId: "lgc_game_24849",
    marketingTitle: "Rus Items",
  },
  Ravendawn: {
    seoTerm: "ravendawn-items",
    brandId: "lgc_game_32923",
    marketingTitle: "Ravendawn Items",
  },
  "Dead by Daylight": {
    seoTerm: "dead-by-daylight-item",
    brandId: "lgc_game_25227",
    marketingTitle: "Dead by Daylight",
  },
  "THE FINALS": {
    seoTerm: "the-finals-items",
    brandId: "lgc_game_32786",
    marketingTitle: "The Finals Item",
  },
  "EVE Online": {
    seoTerm: "eve-item",
    brandId: "lgc_game_1660",
    marketingTitle: "EVE Online Items",
  },
  "NARAKA: BLADEPOINT": {
    seoTerm: "naraka-bladepoint-items",
    brandId: "lgc_game_28950",
    marketingTitle: "NARAKA: BLADEPOINT",
  },
  "Gray Zone Warfare": {
    seoTerm: "gray-zone-warfare-items",
    brandId: "lgc_game_33611",
    marketingTitle: "Gray Zone Warfare",
  },
  "Mistfall Hunter": {
    seoTerm: "mistfall-hunter-items",
    brandId: "lgc_game_37093",
    marketingTitle: "Mistfall Hunter Items",
  },
  "Albion Online": {
    seoTerm: "albion-online-global-item",
    brandId: "lgc_game_21695",
    marketingTitle: "Albion Online Items",
  },
  "Throne and Liberty": {
    seoTerm: "tnl-items",
    brandId: "lgc_game_30627",
    marketingTitle: "T&L Items",
  },
  "Arena Breakout: Infinite": {
    seoTerm: "arena-breakout-infinite-items",
    brandId: "lgc_game_33715",
    marketingTitle: "Arena Breakout: Infinite",
  },
  // G2G carries one generic "Call of Duty" brand (plus a separate Mobile one),
  // so every CoD title the farm names resolves to the same coordinates, and the
  // bare franchise name — how utils/settings noClaimGames spells it — resolves
  // too.
  "Call of Duty: Black Ops 7": {
    seoTerm: "cod-items",
    brandId: "lgc_game_4644",
    marketingTitle: "Call of Duty Items",
  },
  "Call of Duty": {
    seoTerm: "cod-items",
    brandId: "lgc_game_4644",
    marketingTitle: "Call of Duty Items",
  },
  "Guild Wars 2": {
    seoTerm: "gw2-item-for-sale",
    brandId: "lgc_game_16824",
    marketingTitle: "GW2 Items",
  },
  "ARC Raiders": {
    seoTerm: "arc-raiders-items",
    brandId: "lgc_game_35181",
    marketingTitle: "Arc Raiders Items",
  },
  Metin2: {
    seoTerm: "metin2-item",
    brandId: "lgc_game_25002",
    marketingTitle: "Metin 2 Items",
  },
  "Once Human": {
    seoTerm: "once-human-items",
    brandId: "lgc_game_33664",
    marketingTitle: "Once Human Item",
  },
  Palia: {
    seoTerm: "palia-items",
    brandId: "lgc_game_32001",
    marketingTitle: "Palia Items",
  },
  "Disney Dreamlight Valley": {
    seoTerm: "disney-dreamlight-valley-items",
    brandId: "lgc_game_31627",
    marketingTitle: "Disney Dreamlight Valley Items",
  },
  FragPunk: {
    seoTerm: "fragpunk-items",
    brandId: "lgc_game_35083",
    marketingTitle: "FragPunk Items",
  },
  "Zenless Zone Zero": {
    seoTerm: "zenless-zone-zero-items",
    brandId: "lgc_game_33618",
    marketingTitle: "Zenless Zone Zero Items",
  },
  "Path of Exile 2": {
    seoTerm: "path-of-exile-2-item",
    brandId: "lgc_game_27013",
    marketingTitle: "POE 2 Items",
  },
  Caliber: {
    seoTerm: "caliber-items",
    brandId: "lgc_game_32244",
    marketingTitle: "Caliber Items",
  },
  "Borderlands 4": {
    seoTerm: "borderlands-4-items",
    brandId: "lgc_game_35224",
    marketingTitle: "Borderlands 4 Items",
  },
  "Star Citizen": {
    seoTerm: "star-citizen-global-items",
    brandId: "lgc_game_19789",
    marketingTitle: "Star Citizen (Global)",
  },
  Marathon: {
    seoTerm: "marathon-items",
    brandId: "lgc_game_37004",
    marketingTitle: "Marathon Items",
  },
  "The Quinfall": {
    seoTerm: "the-quinfall-items",
    brandId: "lgc_game_33779",
    marketingTitle: "The Quinfall Items",
  },
  "Call of Duty: Modern Warfare 4": {
    seoTerm: "cod-items",
    brandId: "lgc_game_4644",
    marketingTitle: "Call of Duty Items",
  },
  "Blue Protocol: Star Resonance": {
    seoTerm: "blue-protocol-items",
    brandId: "lgc_game_31772",
    marketingTitle: "Blue Protocol: Star Resonance Items",
  },
  VALORANT: {
    seoTerm: "valorant-items",
    brandId: "lgc_game_27301",
    marketingTitle: "Valorant Items",
  },
  "Lords Mobile": {
    seoTerm: "lords-mobile-item",
    brandId: "lgc_game_23794",
    marketingTitle: "Lords Mobile",
  },
  "Madden NFL 27": {
    seoTerm: "madden-nfl-27-items",
    brandId: "lgc_game_41766",
    marketingTitle: "Madden NFL 27 Items",
  },
  "Legend of YMIR": {
    seoTerm: "legend-of-ymir-items",
    brandId: "lgc_game_32092",
    marketingTitle: "Legend of Ymir",
  },
  "No Man's Sky": {
    seoTerm: "no-man-s-sky-item",
    brandId: "lgc_game_28294",
    marketingTitle: "No Man's Sky Items",
  },
  "Lost Ark": {
    seoTerm: "lost-ark-item",
    brandId: "lgc_game_23027",
    marketingTitle: "Lost Ark Items",
  },
  "Star Wars: The Old Republic": {
    seoTerm: "swtor-item",
    brandId: "lgc_game_14756",
    marketingTitle: "SWTOR Items",
  },
  "Night Crows": {
    seoTerm: "night-crows-items",
    brandId: "lgc_game_32958",
    marketingTitle: "Night Crows Items",
  },
  "Conqueror's Blade": {
    seoTerm: "conqueror-s-blade-items",
    brandId: "lgc_game_26253",
    marketingTitle: "Conqueror's Blade Item",
  },
  "Rise Online": {
    seoTerm: "rise-online-items",
    brandId: "lgc_game_30697",
    marketingTitle: "Rise Online Items",
  },
  "EA Sports FC 26": {
    seoTerm: "fc-26-items",
    brandId: "lgc_game_37599",
    marketingTitle: "FC 26 Items",
  },
  Enshrouded: {
    seoTerm: "enshrouded-items",
    brandId: "lgc_game_32997",
    marketingTitle: "Enshrouded",
  },
  "Apex Legends": {
    seoTerm: "apex-legends-items",
    brandId: "lgc_game_25694",
    marketingTitle: "Apex Legends Items",
  },
  "Ragnarok Origin: Classic": {
    seoTerm: "ragnarok-origin-classic-items",
    brandId: "lgc_game_40415",
    marketingTitle: "Ragnarok Origin Classic Items",
  },
  Trove: {
    seoTerm: "trove-item",
    brandId: "lgc_game_22925",
    marketingTitle: "Trove Items",
  },
  "Path of Exile": {
    seoTerm: "poe-items",
    brandId: "lgc_game_19398",
    marketingTitle: "POE Items",
  },
  "War Thunder": {
    seoTerm: "war-thunder-item",
    brandId: "lgc_game_23741",
    marketingTitle: "War Thunder Items",
  },
  Eldegarde: {
    seoTerm: "eldegarde-items",
    brandId: "lgc_game_39910",
    marketingTitle: "Eldegarde Items",
  },
  Hearthstone: {
    seoTerm: "hearthstone-global-items",
    brandId: "lgc_game_20740",
    marketingTitle: "Hearthstone (Global)",
  },
  "The Elder Scrolls Online": {
    seoTerm: "eso-item",
    brandId: "lgc_game_20028",
    marketingTitle: "ESO Items",
  },
  Soulmask: {
    seoTerm: "soulmask-items",
    brandId: "lgc_game_33770",
    marketingTitle: "Soulmask",
  },
  Dofus: {
    seoTerm: "dofus-global-item",
    brandId: "lgc_game_1958",
    marketingTitle: "Dofus Items",
  },
  "RF Online Next": {
    seoTerm: "rf-online-next-items",
    brandId: "lgc_game_36798",
    marketingTitle: "RF Online Next Items",
  },
  "World of Warships": {
    seoTerm: "world-of-warships-item",
    brandId: "lgc_game_22609",
    marketingTitle: "World of Warships",
  },
  "Grand Theft Auto V": {
    seoTerm: "gta-5-online-item",
    brandId: "lgc_game_24309",
    marketingTitle: "GTA 5 Items",
  },
  "DOFUS Touch": {
    seoTerm: "dofus-touch-item",
    brandId: "lgc_game_23884",
    marketingTitle: "Dofus Touch Item",
  },
  "League of Legends": {
    seoTerm: "league-of-legends-item",
    brandId: "lgc_game_22666",
    marketingTitle: "LOL Items",
  },
  NextWorld2: {
    seoTerm: "nextworld2-items",
    brandId: "lgc_game_41351",
    marketingTitle: "NextWorld2 Items",
  },
  "Skull and Bones": {
    seoTerm: "skull-and-bones-items",
    brandId: "lgc_game_31135",
    marketingTitle: "Skull and Bones Items",
  },
  "Torchlight: Infinite": {
    seoTerm: "torchlight-infinite-items",
    brandId: "lgc_game_31452",
    marketingTitle: "Torchlight: Infinite Items",
  },
  "Lineage II": {
    seoTerm: "lineage-2-item",
    brandId: "lgc_game_22652",
    marketingTitle: "Lineage 2 Items",
  },
  "Pokémon GO": {
    seoTerm: "pokemon-go-item",
    brandId: "lgc_game_23630",
    marketingTitle: "Pokemon Go Items",
  },
  "Blade & Soul NEO": {
    seoTerm: "bns-neo-items",
    brandId: "lgc_game_36382",
    marketingTitle: "Blade & Soul NEO Items",
  },
  Crossout: {
    seoTerm: "crossout-item",
    brandId: "lgc_game_27517",
    marketingTitle: "Crossout Items",
  },
  "Crystal of Atlan": {
    seoTerm: "crystal-of-atlan-items",
    brandId: "lgc_game_37593",
    marketingTitle: "Crystal of Atlan Items",
  },
  "Doomsday: Last Survivors": {
    seoTerm: "doomsday-last-survivors-items",
    brandId: "lgc_game_32472",
    marketingTitle: "Doomsday: Last Survivors",
  },
  "FINAL FANTASY XIV ONLINE": {
    seoTerm: "final-fantasy-xiv-arr-item",
    brandId: "lgc_game_6063",
    marketingTitle: "Final Fantasy XIV Items",
  },
  "Call of Duty: Warzone": {
    seoTerm: "cod-items",
    brandId: "lgc_game_4644",
    marketingTitle: "Call of Duty Items",
  },
  "ELDEN RING": {
    seoTerm: "elden-ring-items",
    brandId: "lgc_game_30089",
    marketingTitle: "Elden Ring",
  },
  "Hero Siege": {
    seoTerm: "hero-siege-item",
    brandId: "lgc_game_26399",
    marketingTitle: "Hero Siege Items",
  },
  Krunker: {
    seoTerm: "krunker-items",
    brandId: "lgc_game_27243",
    marketingTitle: "Krunker",
  },
  "Sand: Raiders Of Sophie": {
    seoTerm: "sand-raiders-of-sophie-items",
    brandId: "lgc_game_41211",
    marketingTitle: "SAND Raiders of Sophie Items",
  },
  "World of Warcraft": {
    seoTerm: "wow-item",
    brandId: "lgc_game_2299",
    marketingTitle: "WOW Items",
  },
};

// Storefront and legacy spellings that mean a game already in GAME_BRANDS.
// Same alias-then-normalise shape as utils/eldoradoFarmService.js
// canonicalGame(): resolve the alias first, then match the normalised name.
// Its GAME_ALIASES rows are carried over verbatim rather than re-invented, so a
// title that resolves on Eldorado resolves the same way here. The only
// difference is a stricter normaliser — G2G brand labels are full of
// apostrophes, colons and accents, so those are folded away rather than trimmed.
const GAME_ALIASES = {
  "Tom Clancy's Rainbow Six Siege X": "Rainbow Six Siege",
  "Tom Clancy's Rainbow Six Siege": "Rainbow Six Siege",
  "Rainbow Six Siege X": "Rainbow Six Siege",
  "Overwatch 2": "Overwatch",
  "The Division 2": "Tom Clancy's The Division 2",
  "Hunt: Showdown": "Hunt: Showdown 1896",
  "GTA V": "Grand Theft Auto V",
  "GTA 5": "Grand Theft Auto V",
  EFT: "Escape from Tarkov",
  COD: "Call of Duty",
  ESO: "The Elder Scrolls Online",
  "Elder Scrolls Online": "The Elder Scrolls Online",
  SWTOR: "Star Wars: The Old Republic",
  "Blue Protocol": "Blue Protocol: Star Resonance",
};

// Tolerant enough that "tom clancy's the division 2", "Tom Clancys The
// Division 2" and "TOM CLANCY'S THE DIVISION 2" are one key, strict enough that
// "Rainbow Six Siege" and "Rainbow Six Mobile" stay two.
function normGame(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // fold accents, so Pokemon matches
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "");
}

// Both tables are indexed by the normalised name once, at load, so a lookup is
// a Map hit rather than a scan of ~90 keys per candidate listing.
const BY_NORM = new Map();
for (const game of Object.keys(GAME_BRANDS)) {
  Object.freeze(GAME_BRANDS[game]);
  BY_NORM.set(normGame(game), game);
}
Object.freeze(GAME_BRANDS);

const ALIAS_BY_NORM = new Map();
for (const [from, to] of Object.entries(GAME_ALIASES)) {
  // An alias pointing at a game we have no brand for would silently resolve to
  // nothing, so drop it here rather than let it look like a live route.
  if (BY_NORM.has(normGame(to))) ALIAS_BY_NORM.set(normGame(from), to);
}
Object.freeze(GAME_ALIASES);

// The G2G coordinates for a game, or null when we have no verified brand for
// it. null means "skip this game on G2G" — never "publish it somewhere close".
function brandForGame(game) {
  const n = normGame(game);
  if (!n) return null;
  const alias = ALIAS_BY_NORM.get(n);
  const key = (alias && BY_NORM.get(normGame(alias))) || BY_NORM.get(n);
  return key ? GAME_BRANDS[key] : null;
}

// The farm game names that do map, busiest first.
function gamesWithG2gBrand() {
  return Object.keys(GAME_BRANDS);
}

module.exports = {
  G2G_ITEMS_SERVICE,
  GAME_BRANDS,
  GAME_ALIASES,
  normGame,
  brandForGame,
  gamesWithG2gBrand,
};
