// Keep claimed inventory distinct from drops the buyer still needs to claim.
const TWITCH_LINK_TIP =
  "If you can't connect from Twitch Inventory, link Twitch through your game account's website (e.g. Epic Games) or in-game.";

// Also sent as a standalone PlayerAuctions message: must stay below 300 chars.
const CLAIMED_DROPS_TIP =
  'These older drops are already claimed into Twitch inventory, not redeemed to a game account. Twitch may show only "Claimed", with no Connect button. Link this Twitch account from your own game account website (e.g. Epic Games for Rocket League) or in-game to receive them.';

module.exports = { TWITCH_LINK_TIP, CLAIMED_DROPS_TIP };
