// Free-to-play Steam games the hour booster idles by default. Every AppID was
// checked on 2026-11-03 against store.steampowered.com/api/appdetails
// (is_free = true). Steam allows at most 32 games in one session.
// `section` = the game's own Eldorado account section, for the boosted offers
// (docs/STEAM-BOOST.md, not in v1).
const GAMES = [
  { appId: 1172470, name: "Apex Legends", section: "apex-legends-accounts" },
  { appId: 730, name: "Counter-Strike 2", section: "cs2-accounts" },
  { appId: 578080, name: "PUBG: BATTLEGROUNDS", section: "pubg-accounts" },
  { appId: 570, name: "Dota 2", section: "" },
  { appId: 2767030, name: "Marvel Rivals", section: "marvel-rivals-accounts" },
  { appId: 230410, name: "Warframe", section: "warframe-accounts-for-sale" },
  { appId: 2507950, name: "Delta Force", section: "delta-force-accounts" },
  { appId: 2073850, name: "THE FINALS", section: "the-finals-accounts" },
  { appId: 236390, name: "War Thunder", section: "war-thunder-accounts" },
  { appId: 1085660, name: "Destiny 2", section: "destiny-accounts" },
  { appId: 1665460, name: "eFootball", section: "efootball-accounts" },
  { appId: 359550, name: "Rainbow Six Siege", section: "rainbow-six-siege-accounts" },
  { appId: 2073620, name: "Arena Breakout: Infinite", section: "arena-breakout-infinite-accounts" },
  { appId: 2429640, name: "Throne and Liberty", section: "throne-and-liberty-accounts" },
  { appId: 761890, name: "Albion Online", section: "albion-online-accounts" },
  { appId: 1240440, name: "Halo Infinite", section: "" },
  { appId: 1203220, name: "NARAKA: BLADEPOINT", section: "" },
  { appId: 2139460, name: "Once Human", section: "" },
  { appId: 440, name: "Team Fortress 2", section: "" },
  { appId: 8500, name: "EVE Online", section: "" },
  { appId: 238960, name: "Path of Exile", section: "" },
  { appId: 552990, name: "World of Warships", section: "" },
  { appId: 1599340, name: "Lost Ark", section: "" },
  { appId: 2437170, name: "SMITE 2", section: "" },
  { appId: 2943650, name: "FragPunk", section: "" },
  { appId: 767560, name: "War Robots", section: "" },
  { appId: 1928420, name: "Farlight 84", section: "" },
  { appId: 2524890, name: "Pixel Gun 3D: PC Edition", section: "" },
  { appId: 1818450, name: "STALZONE", section: "" },
  { appId: 766570, name: "Russian Fishing 4", section: "" },
  { appId: 1449850, name: "Yu-Gi-Oh! Master Duel", section: "" },
];

const MAX_GAMES = 32; // Steam's limit for one session
const BY_ID = new Map(GAMES.map((g) => [g.appId, g]));

function defaultGames() {
  return [730, 1172470];
}

function nameOf(appId) {
  const g = BY_ID.get(Number(appId));
  return g ? g.name : "App " + appId;
}

// A clean list of known AppIDs (unknown ones are refused: only games checked
// as free can be idled, or Steam grants no license and books nothing).
function cleanGames(list) {
  const out = [];
  for (const v of list || []) {
    const n = Number(v);
    if (!BY_ID.has(n)) throw Object.assign(new Error("Unknown game " + v), { user: true, status: 400 });
    if (!out.includes(n)) out.push(n);
  }
  if (!out.length) throw Object.assign(new Error("Pick at least one game"), { user: true, status: 400 });
  if (out.length > MAX_GAMES) throw Object.assign(new Error("Steam allows at most " + MAX_GAMES + " games at once"), { user: true, status: 400 });
  return out;
}

module.exports = { GAMES, MAX_GAMES, defaultGames, nameOf, cleanGames };
