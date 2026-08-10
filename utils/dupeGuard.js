// SINGLE-HOME GUARD
//
// A Twitch account must be enabled in exactly ONE bot config per host. Two
// containers watching with the same account looks like abuse to Twitch and
// wastes a seat, and it has happened before: a consolidation copied accounts
// into a target and then failed to retire the donor, leaving 40 accounts
// enabled twice on the Pi.
//
// Rather than trusting every write path (botFactory, the config routes, the
// renter routes, the consolidator) to remember, this hooks the one thing they
// all funnel through — hosts.writeFileAtomic — and enforces the invariant
// after the fact: the config just written is the account's home, so any OTHER
// config on that host still holding it gets the entry stripped. "Last write
// wins" is what every legitimate flow already means (deploy, move, renter
// hand-off), so this needs no caller changes and cannot lose an account: it
// only ever removes the copy that isn't the newest one.
const CONFIG_RE = /^config(_[A-Za-z0-9-]+)?\.json$/;

// writeFileAtomic is re-entered while we heal sibling configs; without this
// the first heal would trigger its own sweep, and so on.
let healing = false;

function usersOf(data) {
  return data &&
    data.TwitchSettings &&
    Array.isArray(data.TwitchSettings.TwitchUsers)
    ? data.TwitchSettings.TwitchUsers
    : [];
}
const secretOf = (u) => String((u && u.ClientSecret) || "").trim();

// Returns the sibling configs it healed: [{ file, removed: [login] }].
async function enforceSingleHome(hosts, host, file, text) {
  if (healing || !CONFIG_RE.test(String(file || ""))) return [];
  let mine;
  try {
    mine = JSON.parse(text);
  } catch {
    return [];
  }
  const claimed = new Set(
    usersOf(mine)
      .filter((u) => u && u.Enabled !== false)
      .map(secretOf)
      .filter(Boolean),
  );
  if (!claimed.size) return [];

  healing = true;
  const healed = [];
  try {
    const files = (await hosts.readdir(host))
      .map((f) => f.name || f)
      .filter((f) => CONFIG_RE.test(f) && f !== file);
    if (!files.length) return [];
    const raw = await hosts.readFiles(host, files);
    for (const f of files) {
      const entry = raw[f];
      if (!entry || !entry.ok) continue;
      let data;
      try {
        data = JSON.parse(entry.text);
      } catch {
        continue;
      }
      const users = usersOf(data);
      if (!users.length) continue;
      const removed = [];
      const kept = users.filter((u) => {
        const s = secretOf(u);
        if (!s || !claimed.has(s) || u.Enabled === false) return true;
        removed.push(u.Login || s.slice(0, 6));
        return false;
      });
      if (!removed.length) continue;
      data.TwitchSettings.TwitchUsers = kept;
      await hosts.writeFileAtomic(host, f, JSON.stringify(data, null, 2));
      healed.push({ file: f, removed });
      console.warn(
        "[dupeGuard] " + removed.length + " account(s) moved to " + file +
          " were still enabled in " + f + " on " + host.id +
          " — removed there: " + removed.join(", "),
      );
    }
  } catch (e) {
    console.error("[dupeGuard] sweep failed for " + file + ": " + e.message);
  } finally {
    healing = false;
  }
  return healed;
}

module.exports = { enforceSingleHome, CONFIG_RE };
