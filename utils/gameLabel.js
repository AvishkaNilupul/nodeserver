// Game-label matching for the drop archive.
//
// A DropLog carries a game label ("Overwatch"), and a DropSet item carries its
// own ("Overwatch", sometimes "Overwatch " / "Overwatch™" / "Rainbow  Six
// Siege"). The manual mark-sold flow (routes/dropArchiveRoutes.js) compares the
// two to decide whether a live listing sells the game just sold — and only then
// pulls the sold account out and lets the auto-feed replace it. A strict
// equality check silently missed on any formatting drift, leaving a sold
// account inside a same-game listing and skipping its replacement.
//
// normGame canonicalises a label so that drift can't cause a miss: lowercase,
// drop trademark marks, and collapse every run of punctuation/whitespace to a
// single space. Digits are kept ON PURPOSE — "Overwatch" and "Overwatch 2" are
// different games and must never collapse together. So this only absorbs
// formatting noise; it never conflates two distinct games.
function normGame(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[™®©]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// True when two game labels refer to the same game after canonicalisation.
function sameGame(a, b) {
  return normGame(a) === normGame(b);
}

module.exports = { normGame, sameGame };
