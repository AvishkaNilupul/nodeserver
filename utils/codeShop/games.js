// Code shop — per-game buyer guides (contract 02-ENGINE.md, games.js).
//
// What a buyer reads about HOW to redeem a code, per game number. Pure data:
// texts.js builds titles, descriptions and delivery messages from it.
//
// Every line is plain ASCII and says only what the buyer gets and how to
// redeem it — never where the codes come from (no platform, country, region
// or event name). The text guard refuses anything else at publish time.
//
// Lines are printed exactly as written (numbering and "- " bullets included).
// Good-to-know lines are dropped from the END when a description runs over
// the market's limit, so the least needed line goes last.

const GUIDES = {
  "12": {
    displayName: "Overwatch 2",
    marketGame: "Overwatch",
    accountWord: "Battle.net",
    howTo: [
      "1. Open battle.net/redeem and sign in to the Battle.net account you play Overwatch 2 on.",
      "2. Enter one code exactly as delivered (with the dashes) and confirm. Repeat for each code.",
      "3. Start Overwatch 2: the rewards are on that account.",
    ],
    goodToKnow: [
      "- No account linking needed - you redeem the codes yourself on Battle.net.",
      "- One code = one reward, for one Battle.net account. A code can be used only once.",
      "- Any problem? Message us in the order chat before leaving feedback and we will sort it out quickly.",
      "- Please redeem soon after purchase.",
      "- Want the bundle on several accounts? Buy one bundle per account.",
    ],
    deliveryHelp:
      "Redeem each code at https://battle.net/redeem (sign in, enter the code with the dashes, confirm). Each code works once, on one Battle.net account. Any problem? Reply here and we will help.",
  },

  "200": {
    displayName: "Delta Force",
    marketGame: "Delta Force",
    accountWord: "Delta Force",
    howTo: [
      "1. Open the Delta Force Redemption Center: playdeltaforce.com/en/cdkredeem.html",
      "2. Enter your character UID and one code, then confirm. Repeat for each code.",
      "In-game alternative: Events > Other > Exchange Center, then enter the code.",
    ],
    goodToKnow: [
      "- Codes are case-sensitive - copy and paste them exactly.",
      "- For the version of Delta Force that redeems on playdeltaforce.com. Garena and China-server accounts use a different redemption system.",
      "- One code = one reward, for one account. A code can be used only once.",
      "- Any problem? Message us in the order chat before leaving feedback and we will sort it out quickly.",
      "- No account linking needed - you redeem the codes yourself.",
      "- Item names can read a little differently in your game's language.",
      "- Please redeem soon after purchase.",
    ],
    deliveryHelp:
      "Redeem each code at https://www.playdeltaforce.com/en/cdkredeem.html (enter your character UID + the code) or in game: Events > Other > Exchange Center. Codes are case-sensitive and each works once. Any problem? Reply here and we will help.",
  },

  // Any other game: generic wording. The owner names the game in
  // config.games[gameNo].displayName / marketGame before it sells.
  default: {
    displayName: "Game",
    marketGame: "",
    accountWord: "game",
    howTo: [
      "1. Redeem each code on the game's official redeem page or in game, signed in to the account you play on.",
      "2. Enter one code exactly as delivered and confirm. Repeat for each code.",
    ],
    goodToKnow: [
      "- One code = one reward, for one account. A code can be used only once.",
      "- Codes can be case-sensitive - copy and paste them exactly.",
      "- Any problem? Message us in the order chat before leaving feedback and we will sort it out quickly.",
      "- No account linking needed - you redeem the codes yourself.",
      "- Please redeem soon after purchase.",
    ],
    deliveryHelp:
      "Redeem each code on the game's official redeem page or in game, signed in to your own account. Each code works once. Any problem? Reply here and we will help.",
  },
};

// Frozen so a caller editing its copy can never change the shared defaults.
for (const g of Object.values(GUIDES)) {
  Object.freeze(g.howTo);
  Object.freeze(g.goodToKnow);
  Object.freeze(g);
}
Object.freeze(GUIDES);

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const filled = (v) => typeof v === "string" && v.trim() !== "";

// The guide for a game, with the owner's config.games[gameNo] displayName /
// marketGame laid over it. Always a fresh copy (arrays included).
function guideFor(gameNo, config) {
  const key = gameNo == null ? "" : String(gameNo).trim();
  const base = key !== "default" && own(GUIDES, key) ? GUIDES[key] : GUIDES.default;
  const games = config && config.games && typeof config.games === "object" ? config.games : {};
  const over = own(games, key) && games[key] && typeof games[key] === "object" ? games[key] : {};
  const out = { ...base, howTo: [...base.howTo], goodToKnow: [...base.goodToKnow] };
  if (filled(over.displayName)) out.displayName = over.displayName.trim();
  if (filled(over.marketGame)) out.marketGame = over.marketGame.trim();
  return out;
}

module.exports = { GUIDES, guideFor };
