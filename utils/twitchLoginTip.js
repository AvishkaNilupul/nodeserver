// The one line every Twitch account hand-over carries about the code prompt.
//
// On the first log-in from a new browser Twitch often asks for a code sent to
// the account's email. Our drop accounts have no mailbox the buyer can open, so
// the right move is to skip it with "Remind me later" — and buyers kept getting
// stuck there and writing to support (owner, 2026-11-03). Kept in one place so
// every market says it the same way.
//
// Plain ASCII on purpose: PlayerAuctions and some vaults are picky about
// characters, and this has to fit the 300-character PlayerAuctions message.
const TWITCH_CODE_TIP =
  'If Twitch asks you for a code, click "Remind me later" - you do not need it.';

// For the PlayerAuctions order message, where every character counts.
const TWITCH_CODE_TIP_SHORT =
  'If Twitch asks for a code, click "Remind me later".';

module.exports = { TWITCH_CODE_TIP, TWITCH_CODE_TIP_SHORT };
