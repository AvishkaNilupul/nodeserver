// Code shop — per-game buyer guides (contract 02-ENGINE.md, games.js).
//
// What a buyer reads about HOW to redeem a code, per game number. Pure data:
// texts.js builds titles, descriptions and delivery messages from it.
//
// Every line is plain ASCII and says only what the buyer gets and how to
// redeem it — never where the codes come from (no platform, country, region
// or event title). The text guard refuses anything else at publish time.
// texts.js adds the event's start date and the once-per-account rule itself.
//
// Lines are printed exactly as written (numbering and "- " bullets included).
// Good-to-know lines are dropped from the END when a description runs over
// the market's limit, so the least needed line goes last.

const GUIDES = {
  "930001": {
    displayName: "Infinity Nikki", marketGame: "Infinity Nikki", accountWord: "Infinity Nikki",
    howTo: ["1. Open Infinity Nikki and sign in to your own game account.",
      "2. Open Pear-Pal > Settings > Other > Redeem Code, then enter each code exactly as delivered.",
      "3. Collect the rewards in your game. Each reward from this event is redeemable once per account."],
    goodToKnow: ["- These are item codes, not a game account. Do not buy if you already redeemed the same event rewards.",
      "- Redeem before the stated deadline. No account details are required."],
    deliveryHelp: "Redeem in Infinity Nikki: Pear-Pal > Settings > Other > Redeem Code. Each event reward works once per game account. Redeem before the listing's deadline.",
  },
  "930002": {
    displayName: "Happy Clinic", marketGame: "Happy Clinic", accountWord: "Happy Clinic",
    howTo: ["1. Sign in to your Nordcurrent ID at store.nordcurrent.com and connect your Happy Clinic game.",
      "2. Open store.nordcurrent.com/en/redeem, enter the code and select Redeem.",
      "3. Collect the reward in Happy Clinic."],
    goodToKnow: ["- Requires your own Happy Clinic game connected to your Nordcurrent ID.", "- Each code can be used once; do not buy repeat rewards from the same event."],
    deliveryHelp: "Sign in to your Nordcurrent ID with Happy Clinic connected, then redeem at https://store.nordcurrent.com/en/redeem. Each code works once.",
  },
  "930003": {
    displayName: "World of Tanks (EU)", marketGame: "World of Tanks", accountWord: "World of Tanks EU",
    howTo: ["1. Requires a World of Tanks PC account on the EU server. Not for Blitz, Console or other regions.",
      "2. Sign in at worldoftanks.eu, click your account name > Activate Wargaming Code.",
      "3. Enter each code exactly as delivered, redeem it, then check your game."],
    goodToKnow: ["- One of each event reward per game account. Do not buy if already redeemed.", "- Redeem before the stated deadline."],
    deliveryHelp: "World of Tanks PC EU only, not Blitz/Console. Sign in at https://worldoftanks.eu > account name > Activate Wargaming Code. Each event reward once per account.",
  },
  "930004": {
    displayName: "Wolvesville", marketGame: "Wolvesville", accountWord: "Wolvesville",
    howTo: ["1. Open vouchers.wolvesville.com.", "2. Enter the delivered code and your exact in-game username, then redeem."],
    goodToKnow: ["- Each code can be used once. Do not buy the same event reward again for the same game account."],
    deliveryHelp: "Redeem at https://vouchers.wolvesville.com using your in-game username. Each code works once.",
  },
  "930005": {
    displayName: "PUBG Mobile", marketGame: "PUBG Mobile", accountWord: "PUBG Mobile",
    howTo: ["1. Open pubgmobile.com/en/event/redeemcode/.",
      "2. Enter your PUBG Mobile Character ID, one delivered code and the verification code shown on the page.",
      "3. Confirm the correct character, redeem, then collect the reward from your in-game mail. Repeat for each code."],
    goodToKnow: ["- For PUBG Mobile accounts using the linked redemption center, not PUBG PC or console.",
      "- Each event reward is redeemable once per game account. Item duration follows the game's reward terms."],
    deliveryHelp: "Redeem each code at https://www.pubgmobile.com/en/event/redeemcode/ with your Character ID and the page's verification code. Collect rewards from in-game mail. Each event reward once per account.",
  },
  "930006": {
    displayName: "Delta Force Mobile", marketGame: "Delta Force", accountWord: "Delta Force Mobile",
    howTo: ["1. These codes are for Delta Force Mobile using playdeltaforce.com, not the Garena or China version.",
      "2. Open playdeltaforce.com/en/cdkredeem.html. Enter your mobile character UID and one code, then redeem.",
      "3. Repeat for each code and check the rewards on that character."],
    goodToKnow: ["- Mobile reward bundle. Do not buy the PC bundle as an additional copy of these same event rewards.",
      "- Each reward from this event is redeemable once per game account."],
    deliveryHelp: "Delta Force Mobile using playdeltaforce.com only. Redeem at https://www.playdeltaforce.com/en/cdkredeem.html with your mobile character UID and each code. Each event reward once per account; not Garena/China.",
  },
  "930007": {
    displayName: "Delta Force (PC)", marketGame: "Delta Force", accountWord: "Delta Force PC",
    howTo: ["1. These codes are for Delta Force PC using playdeltaforce.com, not the Garena or China version.",
      "2. Open playdeltaforce.com/en/cdkredeem.html. Enter your PC character UID and one code, then redeem.",
      "3. Repeat for each code and check the rewards on that character."],
    goodToKnow: ["- PC reward bundle. Do not buy the Mobile bundle as an additional copy of these same event rewards.",
      "- Each reward from this event is redeemable once per game account."],
    deliveryHelp: "Delta Force PC using playdeltaforce.com only. Redeem at https://www.playdeltaforce.com/en/cdkredeem.html with your PC character UID and each code. Each event reward once per account; not Garena/China.",
  },
  "930008": {
    displayName: "OneState (US)", marketGame: "OneState", accountWord: "OneState US",
    howTo: ["1. This reward is for OneState US: 10,000 State Bucks in-game currency, not real money or State Coins.",
      "2. Open onestate.com/promocode and authorize your own game account.",
      "3. Enter the code, select your US server and the character to receive the reward, then activate."],
    goodToKnow: ["- US reward only. Do not buy for a character in another region.",
      "- Each event reward is redeemable once per game account."],
    deliveryHelp: "OneState US reward: 10,000 State Bucks, not State Coins. Redeem at https://onestate.com/promocode: authorize, enter the code, select your US server and character, then activate. Each code works once.",
  },
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
