// BotAccount is the database mirror of the bot configs: host / configFile /
// container say where an account is deployed, and `enabled` says whether that
// config entry is switched on. The flag is trusted: the retro-reaper keeps an
// account claimed for as long as BotAccount says it is enabled
// (utils/autoFarmer.reapRetiredBots), and the seat counts, the reseller
// forecast and the Bots pages count it. So a config edit that switches an
// account off has to switch the mirror off too.
//
// Two config writers did not. completeEndedTasks trims an ended game out of a
// SHARED auto bot and disables the accounts left with no game, and
// farmControl.stopFarmingGame does the same after a sale. Neither touched
// BotAccount, so only a manual "Sync from bots" ever caught the database up.
// Measured on prod 2026-10-21: 823 rows on the four shared auto containers
// said enabled while their config said off (twitchbotx44 "397 on", 93 real).
// botFactory.deleteBot has always mirrored a whole config going away; this is
// the same rule for single entries.

const str = (v) => (v == null ? "" : String(v).trim());

// Switch the mirror off for `secrets` (ClientSecrets) that were just disabled
// in `file` on `hostId`. Only rows that still point at THAT config are touched:
// a row naming another config was deployed there since, and that placement
// decides its flag. Returns how many rows changed. Throws on a database error —
// callers run it best-effort, after the config write has already succeeded.
async function mirrorDisabled(hostId, file, secrets, { BotAccount } = {}) {
  const list = [...new Set((secrets || []).map(str).filter(Boolean))];
  if (!list.length || !str(hostId) || !str(file)) return 0;
  const Model = BotAccount || require("../models/BotAccount");
  const r = await Model.updateMany(
    {
      host: str(hostId),
      configFile: str(file),
      clientSecret: { $in: list },
      enabled: true,
    },
    { $set: { enabled: false } },
  );
  return (r && (r.modifiedCount != null ? r.modifiedCount : r.nModified)) || 0;
}

// Pure. Given every config entry one ClientSecret was found in —
// [{ host, file, container, enabled, renter, kind }] — pick the entry that
// decides where the account really lives:
//   * an ENABLED copy beats a disabled one. A disabled entry is retirement
//     residue: completeEndedTasks leaves the account in the shared bot,
//     switched off, and the same token is often enabled in another bot.
//   * two enabled copies is a dupeGuard-class problem, not bookkeeping, so it
//     is returned as a conflict and the caller writes nothing for it.
//   * with no enabled copy, an operator config decides over a renter stack:
//     only the operator side owns the BotAccount fields.
// Returns { conflict: true, hits } or { conflict: false, home } (home may be
// undefined for an empty list).
function chooseHome(hits) {
  const list = Array.isArray(hits) ? hits : [];
  const on = list.filter((h) => h && h.enabled);
  if (on.length > 1) return { conflict: true, hits: on };
  return {
    conflict: false,
    home: on[0] || list.find((h) => h && !h.renter) || list[0],
  };
}

module.exports = { mirrorDisabled, chooseHome };
