// Gameflip's Game Accounts category ("ACCOUNT") for the listings we make there.
//
// Every listing this server puts on Gameflip hands a buyer a Twitch account —
// the drops bundles, the unclaimed units and lots, the bulk packs, the no-claim
// shop, the farming windows. Until 2026-10-15 every one of them was filed under
// "UNKNOWN" ("Other"): Game Accounts needs Gameflip's approval, and a try on
// 2026-10-13 was refused ("Your account is not eligible to publish this
// listing"). On 2026-10-15 every listing came off Gameflip and the approval was
// applied for.
//
// This is what a listing needs once the approval is granted, and it is OFF
// until the owner says so: autoFarm.gameflipCategory stays "UNKNOWN" and
// listingFields() answers null, so gameflipPublish sends exactly the body it
// always sent. Switched to "ACCOUNT" BEFORE the approval, every Gameflip
// publish fails at the on-sale step.
//
// The shape is copied from live Game Accounts listings read on 2026-10-15
// (public API, ~1,900 listings): kind "item", category "ACCOUNT",
// digital_deliverable "code" — so the auto-delivered login works there exactly
// as it does today — shipping_within_days 1, and the tags
//   "id: <Gameflip game id>", "title: <game>",
//   "profile: Changeable|Not Changeable", "password: …", "email: …"
// plus upc "GAME" + the id padded to 9 digits for a game Gameflip knows. A game
// it does not know is "id: other" with its own name and no upc — what sellers
// there do for MARVEL SNAP, THE FINALS, PUBG or Battlefield 6.
//
// The tags must be true for what we deliver: the login and password only (the
// account's email is never handed over), and a farming window's buyer is told
// "Do not change any data on the account you received, otherwise the automatic
// farm will stop working" (utils/gameflipFarmService.js offerDescription), so a
// window is "Not Changeable" where an account sold outright is "Changeable".
const settings = require("./settings");

// [Gameflip game id, the game's title on Gameflip, other labels it goes by].
// Harvested 2026-10-15 from ~1,900 live Game Accounts listings (public API):
// each id with the title most of them carry, then the other spellings seen
// and how our farm names the same game ("Overwatch"). College Football 27 and
// NBA 2K27 are from the 2026-10-13 market scan. Matching is on the WHOLE
// normalised name, never a leading part: "World of Tanks Console", "World of
// Tanks: HEAT" and "Escape from Tarkov: Arena" are other games, and a game that
// is not here is simply "other" — a weaker tag, never a wrong one.
const GAMES = [
  ["115270", "112 Operator"],
  ["5574", "7 Days to Die"],
  ["20927", "911 Operator"],
  ["19698", "Albion Online"],
  ["228258", "Amnesia: The Bunker"],
  ["114795", "Apex Legends"],
  ["185258", "ARC Raiders"],
  ["300976", "Assassin's Creed Shadows"],
  ["133004", "Assassin's Creed Valhalla"],
  ["116200", "Back 4 Blood"],
  ["194504", "Backpack Hero"],
  ["119171", "Baldur's Gate 3"],
  ["317407", "Battlefield 6"],
  ["143113", "Beacon Pines"],
  ["28311", "Bendy and the Ink Machine"],
  ["103373", "Beyond Blue"],
  ["6292", "Black Desert", "Black Desert Online"],
  ["10760", "Bloodstained: Ritual of the Night"],
  ["103380", "Bloons TD 6"],
  ["6611", "Botanicula"],
  ["10233", "Brawlhalla"],
  ["199116", "Brotato"],
  ["122345", "Calico"],
  ["83727", "Call of Duty Black Ops 4"],
  ["348220", "Call of Duty Black Ops 7"],
  ["9509", "Call of Duty Black Ops III"],
  ["18968", "Call of Duty Infinite Warfare"],
  ["131800", "Call of Duty: Warzone"],
  ["133866", "Cassette Beasts"],
  ["36597", "Cat Quest"],
  ["101869", "Cat Quest II"],
  ["119342", "Chivalry 2"],
  ["152271", "Citizen Sleeper"],
  ["5589", "Clash of Clans"],
  ["29411", "Clone Drone in the Danger Zone"],
  ["103329", "Control"],
  ["242408", "Counter-Strike 2"],
  ["144800", "Cozy Grove"],
  ["34894", "Crossout"],
  ["277807", "Cyberpunk 2077 Ultimate Edition"],
  ["207266", "Dark and Darker"],
  ["2117", "DayZ"],
  ["18866", "Dead by Daylight"],
  ["26855", "Dead Cells"],
  ["7329", "Dead Island 2"],
  ["113598", "Deathloop"],
  ["194740", "Deliver Us Mars"],
  ["666", "Delta Force"],
  ["25657", "Destiny 2"],
  ["125165", "Diablo IV"],
  ["18337", "Dofus"],
  ["152122", "Doki Doki Literature Club Plus!"],
  ["54548", "Dragon Quest Builders 2"],
  ["80659", "Dumb Ways to Die"],
  ["214394", "Dune: Awakening", "Dune Awakening"],
  ["400601", "EA Sports College Football 27", "College Football 27"],
  ["15536", "Escape from Tarkov"],
  ["135842", "Eternal Return"],
  ["2584", "Eve Online"],
  ["119313", "Fall Guys"],
  ["103020", "Fallout 76"],
  ["142862", "Farlight 84"],
  ["20329", "Figment"],
  ["119801", "Figment 2: Creed Valley"],
  ["14144", "Final Fantasy X/X-2 HD Remaster"],
  ["80877", "Final Fantasy XV Royal Edition"],
  ["130182", "Floppy Knights"],
  ["266382", "Football Manager 2024"],
  ["11162", "For Honor"],
  ["1905", "Fortnite"],
  ["119277", "Genshin Impact"],
  ["121752", "Ghostrunner"],
  ["125624", "Grounded"],
  ["1183", "Guild Wars 2"],
  ["103281", "Halo Infinite"],
  ["7348", "Halo: The Master Chief Collection"],
  ["141681", "Happy Game"],
  ["1279", "Hearthstone"],
  ["32365", "Hell Let Loose"],
  ["26809", "Hidden Folks"],
  ["11157", "Hitman"],
  ["136625", "Hogwarts Legacy"],
  ["178282", "Honkai: Star Rail"],
  ["7291", "Hunt Showdown 1896", "Hunt: Showdown 1896", "Hunt: Showdown"],
  ["7578", "I Have No Mouth, and I Must Scream"],
  ["43178", "Idle Champions of the Forgotten Realms"],
  ["152064", "Jurassic World Evolution 2"],
  ["4843", "Kingdom Come: Deliverance"],
  ["152476", "Kirka.io"],
  ["109096", "Krunker"],
  ["95118", "Last Epoch"],
  ["115", "League of Legends"],
  ["361855", "LEGO Batman: Legacy of the Dark Knight"],
  ["1331", "Limbo"],
  ["2971", "Lineage II"],
  ["9174", "Little Nightmares"],
  ["26128", "Lost Ark"],
  ["23582", "Lost Castle"],
  ["2990", "Machinarium"],
  ["18869", "Mages of Mystralia"],
  ["111544", "Maid of Sker"],
  ["46800", "Maneater"],
  ["250630", "Marathon"],
  ["294041", "Marvel Rivals"],
  ["3119", "Metin2"],
  ["106764", "Middle-earth Shadow of War - Definitive Edition"],
  ["135400", "Minecraft"],
  ["204910", "Minecraft Java & Bedrock Edition"],
  ["243611", "Mir Korabley"],
  ["79392", "Mobile Legends Bang Bang"],
  ["8900", "Monument Valley"],
  ["36749", "Monument Valley 2"],
  ["132050", "Mortal Shell"],
  ["64957", "Mutazione"],
  ["46665", "Naruto Shippuden Ultimate Ninja Storm 4 - Road to Boruto"],
  ["239385", "Naruto x Boruto Ultimate Ninja Storm Connections"],
  ["408823", "NBA 2K27"],
  ["1908", "Neverwinter"],
  ["290911", "Nobody Wants to Die"],
  ["18918", "Northgard"],
  ["204538", "Once Human"],
  ["121754", "Orcs Must Die! 3"],
  ["125174", "Overwatch 2", "Overwatch"],
  ["151467", "Palia"],
  ["127816", "Paradise Killer"],
  ["1911", "Path of Exile"],
  ["125642", "Path of Exile 2"],
  ["132516", "Phasmophobia"],
  ["122766", "Pilgrims"],
  ["12515", "Pokémon Go"],
  ["155706", "Potion Permit"],
  ["138590", "PowerWash Simulator"],
  ["111033", "Project Winter"],
  ["95340", "PUBG Mobile"],
  ["133581", "Rise Online"],
  ["117533", "River City Girls"],
  ["11602", "Road Redemption"],
  ["11198", "Rocket League"],
  ["3277", "Rust"],
  ["79995", "Sable"],
  ["8621", "Samorost 2"],
  ["15537", "Samorost 3"],
  ["11137", "Sea of Thieves"],
  ["18090", "Shakes and Fidget"],
  ["19130", "Sid Meier's Civilization VI"],
  ["144022", "Sifu"],
  ["127842", "Skul: The Hero Slayer"],
  ["119346", "Songs of Conquest"],
  ["76885", "SoulCalibur VI"],
  ["7584", "Star Trek Online"],
  ["186597", "Strange Horticulture"],
  ["191692", "Street Fighter 6"],
  ["107262", "Streets of Rage 4"],
  ["6072", "Styx: Master of Shadows"],
  ["13554", "Styx: Shards of Darkness"],
  ["23622", "Summoners War Sky Arena"],
  ["109826", "Super Animal Royale"],
  ["44129", "Super Meat Boy Forever"],
  ["57153", "The Battle of Polytopia"],
  ["141538", "The Callisto Protocol"],
  ["35283", "The Darkside Detective"],
  ["1081", "The Elder Scrolls Online"],
  ["4786", "The Evil Within"],
  ["36813", "The Evil Within 2"],
  ["121709", "The Falconeer"],
  ["214417", "The Finals"],
  ["28213", "The Jackbox Party Pack 4"],
  ["216958", "The Operator"],
  ["113114", "The Outer Worlds"],
  ["90099", "Tom Clancy's The Division 2", "The Division 2"],
  ["114058", "Totally Reliable Delivery Service"],
  ["6247", "Trine"],
  ["6250", "Trine 2"],
  ["128097", "Turnip Boy Commits Tax Evasion"],
  ["217645", "Turnip Boy Robs a Bank"],
  ["126459", "Valorant"],
  ["142549", "Viewfinder"],
  ["2165", "War Thunder"],
  ["2903", "Warframe"],
  ["109535", "We Were Here Together"],
  ["30408", "Witch It"],
  ["19935", "Wizard of Legend"],
  ["19452", "Wonder Boy: The Dragon's Trap"],
  ["1184", "World of Tanks"],
  ["123", "World of Warcraft"],
  ["5587", "World of Warships"],
  ["202956", "Wuthering Waves"],
  ["75341", "Wytchwood"],
];

const PLATFORMS = new Set([
  "windows", "mac", "linux", "crossplatform", "unknown",
  "playstation_4", "playstation_5", "xbox_one", "xbox_series",
]);
const DEFAULT_PLATFORM = "windows";
const FARM_RE = /\bautomatic farming\b/i;
const TITLE_TAG_MAX = 60;

function norm(s) {
  return settings.normGameName(s);
}

const BY_NAME = new Map();
for (const [id, title, ...aka] of GAMES) {
  for (const name of [title, ...aka]) BY_NAME.set(norm(name), { id, title });
}

// The Gameflip game of exactly this name, or null.
function knownGame(name) {
  const n = norm(name);
  return (n && BY_NAME.get(n)) || null;
}

// The game a listing title names: our titles lead with it — "<Game> Twitch
// Drops …", "<Game> Twitch bundle — …", "<Game> bundle — …" — and a bundle of
// several games leads with "<A> + <B> + …". Decoration in front (an emoji, a
// count like "116x") is dropped. "" when there is nothing to read.
function gameFromTitle(title) {
  const s = String(title || "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/^\d+x\s+/i, "")
    .trim();
  if (!s) return "";
  const m = /^(.*?)\s+(?:twitch\b|bundle\b|—|–|-\s|\()/iu.exec(s);
  const lead = (m ? m[1] : s).split(/\s+\+\s+/)[0];
  return lead.trim().slice(0, TITLE_TAG_MAX);
}

// { id, title } for the game of a listing: the caller's game label when it
// gave one, else the title's. Unknown to Gameflip = "other" + its own name.
// `label` is our own name for it (what the owner's settings maps are keyed by).
function resolveGame({ title, game } = {}) {
  const named = String(game || "").trim();
  const own = (named || gameFromTitle(title)).slice(0, TITLE_TAG_MAX);
  const hit = knownGame(own);
  if (hit) return { id: hit.id, title: hit.title, label: own };
  return { id: "other", title: own || "Twitch", label: own };
}

function categoryOf(af) {
  return String((af && af.gameflipCategory) || "").trim().toUpperCase() === "ACCOUNT"
    ? "ACCOUNT"
    : "UNKNOWN";
}

// The owner's map may name the game either way ("Overwatch" or Gameflip's
// "Overwatch 2"); a value that is not a Gameflip platform is ignored.
function platformFor(names, af) {
  const map = af && af.gameflipAccountPlatforms;
  if (map && typeof map === "object") {
    const want = new Set([].concat(names || []).map(norm).filter(Boolean));
    for (const [k, v] of Object.entries(map)) {
      const p = String(v || "").trim().toLowerCase();
      if (want.has(norm(k)) && PLATFORMS.has(p)) return p;
    }
  }
  return DEFAULT_PLATFORM;
}

// The fields a NEW listing carries in Game Accounts, laid over gameflipPublish's
// own body — or null while autoFarm.gameflipCategory is not "ACCOUNT", which
// leaves that body exactly as it always was.
//   title  the listing's title (the game is read off it when `game` is absent)
//   game   optional: the game's label, when the caller knows it
//   farm   optional: true for a farming window (else the title says so)
//   auto   the listing auto-delivers a code (the delivery itself is unchanged)
//   af     optional: the auto-farm settings (read fresh when absent)
function listingFields({ title, game, farm, auto, af } = {}) {
  const cfg = af || settings.getAutoFarm();
  if (categoryOf(cfg) !== "ACCOUNT") return null;
  const g = resolveGame({ title, game });
  const isFarm = farm === true || (farm !== false && FARM_RE.test(String(title || "")));
  const change = isFarm ? "Not Changeable" : "Changeable";
  const fields = {
    category: "ACCOUNT",
    platform: platformFor([g.title, g.label], cfg),
    tags: [
      "id: " + g.id,
      "title: " + g.title,
      "profile: " + change,
      "password: " + change,
      "email: Not Included",
    ],
  };
  // Every Game Accounts listing read on 2026-10-15 had 1 here; ours in "Other"
  // used 0. Delivery is the same instant code either way.
  if (auto) fields.shipping_within_days = 1;
  if (g.id !== "other" && cfg.gameflipAccountUpc !== false) {
    fields.upc = "GAME" + String(g.id).padStart(9, "0");
  }
  return fields;
}

module.exports = {
  listingFields,
  resolveGame,
  gameFromTitle,
  knownGame,
  categoryOf,
  platformFor,
  GAMES,
  DEFAULT_PLATFORM,
};
