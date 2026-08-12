// Works out what moving a batch of stash accounts into another stash set has to
// do to each row, before anything is written. Kept as a pure function because
// the interesting part isn't the mongo call, it's the collision rule:
//
// models/StashAccount.js has a unique {setId, usernameLower} index, so a
// destination set may already hold a row for a username we're moving. Those rows
// can't both exist, and neither should be thrown away, so a clash goes one of
// two ways:
//
//   * The two rows agree (or one is just emptier) — the source row's fields fill
//     the destination's blanks, never clobbering, exactly like the paste-importer,
//     and the redundant source row is dropped.
//   * The two rows hold DIFFERENT credentials for the same username — a
//     different password, token, uniqueId or twitch id. A Twitch login is not a
//     unique identity (the ClientSecret is), so these may well be two different
//     accounts that happen to share a name. Dropping the source row would
//     destroy a credential that exists nowhere else, so we touch neither row and
//     hand the clash back to the operator instead.
//
// Everything without a clash is simply re-parented, which preserves createdAt so
// an account's stash age survives the move.
//
// Passwords and emails are stored encrypted (utils/secretBox) with a random IV,
// so two ciphertexts of the same secret don't match. The caller therefore passes
// `passwordPlain`/`emailPlain` alongside the stored values: this function
// compares plaintext but only ever copies the stored ciphertext, and stays pure.
const CRED_FIELDS = ["clientSecret", "uniqueId", "twitchId"];

// Which credentials the two rows disagree on. Both sides having a value that
// differs is the dangerous case; one side being empty is just a blank to fill.
function conflictingFields(a, dupe) {
  const out = [];
  for (const f of CRED_FIELDS) {
    if (a[f] && dupe[f] && String(a[f]) !== String(dupe[f])) out.push(f);
  }
  // Presence comes from hasPassword, equality from the plaintext — so a password
  // that no longer decrypts (a rotated key) counts as a disagreement rather than
  // being quietly discarded.
  if (a.hasPassword && dupe.hasPassword && a.passwordPlain !== dupe.passwordPlain) {
    out.push("password");
  }
  if (a.emailPlain && dupe.emailPlain && a.emailPlain !== dupe.emailPlain) {
    out.push("email");
  }
  return out;
}

function planStashMove({ accounts, existing, targetSetId }) {
  const byLower = new Map();
  for (const e of existing || []) {
    byLower.set(String(e.usernameLower || "").toLowerCase(), e);
  }

  const reparent = [];
  const merges = [];
  const conflicts = [];
  for (const a of accounts || []) {
    const lower = String(a.usernameLower || a.username || "").toLowerCase();
    const dupe = byLower.get(lower);
    if (!dupe) {
      reparent.push({ id: a._id, set: { setId: targetSetId } });
      continue;
    }

    // Two different accounts wearing the same name: leave both alone. Nothing is
    // filled either, so the destination row can't end up holding a credential
    // from what might be a different account.
    const fields = conflictingFields(a, dupe);
    if (fields.length) {
      conflicts.push({
        sourceId: a._id,
        destId: dupe._id,
        username: a.username || lower,
        fields,
      });
      continue;
    }

    const set = {};
    for (const f of CRED_FIELDS) {
      if (a[f] && !dupe[f]) set[f] = a[f];
    }
    // Ciphertext from both rows is under the same key, so it copies across as-is.
    if (a.hasPassword && !dupe.hasPassword) {
      set.password = a.password;
      set.hasPassword = true;
    }
    if (a.emailPlain && !dupe.emailPlain) set.email = a.email;
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

  return { reparent, merges, conflicts };
}

module.exports = { planStashMove, conflictingFields };
