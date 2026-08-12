// Works out what moving a batch of stash accounts into another stash set has to
// do to each row, before anything is written. Kept as a pure function because
// the interesting part isn't the mongo call, it's the collision rule:
//
// models/StashAccount.js has a unique {setId, usernameLower} index, so a
// destination set may already hold a row for a username we're moving. Those rows
// can't both exist, and neither should be thrown away — so the source row's
// fields are folded into the destination row (filling blanks only, never
// clobbering, exactly like the paste-importer) and the source row is dropped.
// Everything without a clash is simply re-parented, which preserves createdAt so
// an account's stash age survives the move.
//
// `existing` rows carry a precomputed `hasEmail` because emails are stored
// encrypted (utils/secretBox) and "" and an undecryptable value both count as
// missing — the caller decrypts, this stays pure.
function planStashMove({ accounts, existing, targetSetId }) {
  const byLower = new Map();
  for (const e of existing || []) {
    byLower.set(String(e.usernameLower || "").toLowerCase(), e);
  }

  const reparent = [];
  const merges = [];
  for (const a of accounts || []) {
    const lower = String(a.usernameLower || a.username || "").toLowerCase();
    const dupe = byLower.get(lower);
    if (!dupe) {
      reparent.push({ id: a._id, set: { setId: targetSetId } });
      continue;
    }

    const set = {};
    if (a.clientSecret && !dupe.clientSecret) set.clientSecret = a.clientSecret;
    if (a.uniqueId && !dupe.uniqueId) set.uniqueId = a.uniqueId;
    if (a.twitchId && !dupe.twitchId) set.twitchId = a.twitchId;
    // Ciphertext from both rows is under the same key, so it copies across as-is.
    if (a.hasPassword && !dupe.hasPassword) {
      set.password = a.password;
      set.hasPassword = true;
    }
    if (a.email && !dupe.hasEmail) set.email = a.email;
    // Only carry a live-check result onto a destination row that has never been
    // checked, so a merge can never replace a fresher answer with a staler one.
    if (a.lastCheckStatus && !dupe.lastCheckStatus) {
      set.lastCheckAt = a.lastCheckAt || null;
      set.lastCheckStatus = a.lastCheckStatus;
      set.lastCheckError = a.lastCheckError || "";
      set.dropCount = a.dropCount || 0;
    }
    merges.push({ destId: dupe._id, sourceId: a._id, set });
  }

  return { reparent, merges };
}

module.exports = { planStashMove };
