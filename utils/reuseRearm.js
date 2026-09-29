// Re-arm a reused task's accounts for the game it is farming again.
//
// completeEndedTasks (utils/autoFarmer.js) takes an ended campaign's game off
// every account of a SHARED bot and disables the ones left with no game at all
// — right when the event is over. But both reuse paths (farm2's executeReuse
// and the legacy branch in processCampaign) only START the reused bots again:
// the accounts they count as "reused" stay disabled with an empty game list,
// so a recurring campaign farmed nothing. Measured on prod 2026-09-25: 45 of 54
// reuse tasks in 8 days earned 0 drops, and 349 of the 637 accounts assigned to
// active tasks were disabled with no game.
//
// Eligibility is deliberately narrow, because re-enabling the wrong account is
// worse than farming nothing — it farms a buyer's login or destroys no-claim
// stock (every auto-farm bot claims every claimable drop within a minute):
//   * the pool row is still an auto-farm claim — not available, held stock,
//     no-claim, spent, rented or manualSold — and holds no unclaimed drops;
//   * the BotAccount is alive (not suspended / token_invalid) and not sold to a
//     real buyer, and no drop of THIS game went to a real buyer or was connected;
//   * the token is in no no-claim bot config and the login in no renter stack;
//   * it is enabled in no OTHER operator config on the host — writeFileAtomic's
//     single-home guard (utils/dupeGuard) would otherwise strip it from the
//     config it is farming in now.
// If the no-claim fleet cannot be read, nothing is re-armed (fail closed): the
// reuse then behaves exactly as it did before this module existed.
//
// Switch: autoFarm.reuseRearm === false turns it off live.
const hosts = require("./botHosts");
const settings = require("./settings");
const { withFileLock } = require("./fileLock");
const { isMarketClaimTag } = require("./marketClaimTags");

const CONFIG_RE = /^config(_[A-Za-z0-9-]+)?\.json$/;
const AUTO_FARM_NOTE = /^auto-farm( backfill)?:/i;
const DEAD_SCAN = new Set(["suspended", "token_invalid"]);

const lower = (s) => String(s || "").trim().toLowerCase();
const secretOf = (u) => String((u && u.ClientSecret) || "").trim();
const usersOf = (cfg) =>
  cfg && cfg.TwitchSettings && Array.isArray(cfg.TwitchSettings.TwitchUsers)
    ? cfg.TwitchSettings.TwitchUsers
    : [];

// Pure. Decide which config entries to re-arm.
//   game          the task's game (compared trimmed + case-insensitively, the
//                 same way completeEndedTasks removed it)
//   logins        the reused task's accounts (any case)
//   botFiles      [{ host, file, container, users }] — the reused bots' parsed
//                 TwitchUsers
//   enabledIn     Map(secret -> [ "host|file", … ]) over EVERY operator config
//                 on the hosts involved (enabled entries only)
//   pool          Map(loginLower -> { status, claimedNote, manualSold,
//                 unclaimedDropCount })
//   botAccounts   Map(secret -> { lastScanStatus, soldAt, soldToUsername })
//   gameSold      Set(loginLower) — a drop of this game was really sold or
//                 connected
//   noclaim       Set(secret) — tokens present in any no-claim bot config
//   renters       Set(loginLower) — logins enabled in a renter stack
// Returns { plan: Map("host|file" -> [{ secret, login, addGame, enable }]),
//           skipped: { reason: [login, …] }, alreadyArmed: [login, …] }.
function planRearm({
  game,
  logins,
  botFiles,
  enabledIn,
  pool,
  botAccounts,
  gameSold,
  noclaim,
  renters,
}) {
  const g = lower(game);
  const plan = new Map();
  const skipped = {};
  const alreadyArmed = [];
  const skip = (why, login) => {
    (skipped[why] = skipped[why] || []).push(login);
  };
  const seen = new Set();
  for (const raw of logins || []) {
    const login = lower(raw);
    if (!login || seen.has(login)) continue;
    seen.add(login);
    // Where the account sits among the reused bots. If it is in more than one,
    // prefer an entry that is still enabled; the others are left alone.
    let hit = null;
    for (const b of botFiles || []) {
      const u = (b.users || []).find((x) => x && lower(x.Login) === login);
      if (!u) continue;
      if (!hit || (hit.user.Enabled === false && u.Enabled !== false)) {
        hit = { bot: b, user: u };
      }
    }
    if (!hit) { skip("not in the reused bots", login); continue; }
    const secret = secretOf(hit.user);
    if (!secret) { skip("no token in config", login); continue; }

    const p = pool.get(login);
    if (!p) { skip("no pool row", login); continue; }
    if (p.manualSold) { skip("hand-sold (manualSold)", login); continue; }
    if (p.status !== "claimed") { skip("back in the pool", login); continue; }
    if (!AUTO_FARM_NOTE.test(String(p.claimedNote || ""))) {
      skip("claimed by something else", login);
      continue;
    }
    // Farmed-but-unclaimed drops are stock a claiming bot would claim (and, for
    // a no-claim game, destroy) within a minute of the restart.
    if (Number(p.unclaimedDropCount) > 0) { skip("holds unclaimed drops", login); continue; }
    const acc = botAccounts.get(secret);
    if (acc && DEAD_SCAN.has(acc.lastScanStatus)) { skip("dead token / suspended", login); continue; }
    if (acc && acc.soldAt && !isMarketClaimTag(acc.soldToUsername)) {
      skip("sold to a buyer", login);
      continue;
    }
    if (gameSold.has(login)) { skip("this game sold or connected", login); continue; }
    if (noclaim.has(secret)) { skip("in a no-claim bot", login); continue; }
    if (renters.has(login)) { skip("in a renter stack", login); continue; }
    const key = hit.bot.host + "|" + hit.bot.file;
    const elsewhere = (enabledIn.get(secret) || []).filter((k) => k !== key);
    if (elsewhere.length) { skip("enabled in another config", login); continue; }

    const own = Array.isArray(hit.user.FavouriteGames) ? hit.user.FavouriteGames : [];
    const addGame = !own.some((f) => lower(f) === g);
    const enable = hit.user.Enabled === false;
    if (!addGame && !enable) { alreadyArmed.push(login); continue; }
    if (!plan.has(key)) plan.set(key, []);
    plan.get(key).push({ secret, login, addGame, enable });
  }
  return { plan, skipped, alreadyArmed };
}

// Every token in any no-claim bot config, in one batched read of the fleet
// host. Throws when the fleet cannot be read — the caller then re-arms nothing.
async function noclaimSecrets() {
  const fleet = require("./noclaimFleet");
  const out = await fleet.sh(
    `for f in ${hosts.shq(fleet.BOTS_DIR)}/*/Configuration/config.json; do ` +
      `[ -f "$f" ] || continue; echo "__CFG__"; cat "$f"; done`,
    { timeout: 45000 },
  );
  const set = new Set();
  for (const chunk of String(out || "").split("__CFG__")) {
    const text = chunk.trim();
    if (!text) continue;
    let cfg;
    try {
      cfg = JSON.parse(text);
    } catch {
      // A config we cannot parse could hold anything — treat the read as failed.
      throw new Error("a no-claim config did not parse");
    }
    for (const u of usersOf(cfg)) {
      const s = secretOf(u);
      if (s) set.add(s);
    }
  }
  return set;
}

// Gather, plan and (unless dryRun) write. `bots` are the reused task's bot
// entries ({ host, file, container }), `logins` the accounts it reuses.
// Returns { rearmed, changedBots: [{ host, file, container, count }], skipped,
// alreadyArmed, error? }. Never throws: a failure re-arms nothing and says why.
async function rearmReusedAccounts({ bots, logins, game, dryRun = false } = {}) {
  const result = { rearmed: 0, changedBots: [], skipped: {}, alreadyArmed: 0 };
  try {
    const af = settings.getAutoFarm();
    if (af && af.reuseRearm === false) return { ...result, disabled: true };
    const list = (bots || []).filter((b) => b && b.host && b.file && b.container);
    if (!list.length || !(logins || []).length || !game) return result;

    const AvailableAccount = require("../models/AvailableAccount");
    const BotAccount = require("../models/BotAccount");
    const DropLog = require("../models/DropLog");
    const RenterAccount = require("../models/RenterAccount");

    // Every operator config on each host involved: the reused bots' own
    // entries, and the "enabled anywhere else" map the single-home guard needs.
    const enabledIn = new Map();
    const botFiles = [];
    for (const hostId of [...new Set(list.map((b) => b.host))]) {
      const h = hosts.resolveHost(hostId);
      if (!h) throw new Error("unknown host " + hostId);
      const names = (await hosts.readdir(h))
        .map((f) => f.name || f)
        .filter((f) => CONFIG_RE.test(f));
      const raw = await hosts.readFiles(h, names);
      for (const f of names) {
        if (!raw[f] || !raw[f].ok) throw new Error("cannot read " + hostId + "/" + f);
        const users = usersOf(JSON.parse(raw[f].text));
        for (const u of users) {
          const s = secretOf(u);
          if (!s || u.Enabled === false) continue;
          if (!enabledIn.has(s)) enabledIn.set(s, []);
          enabledIn.get(s).push(hostId + "|" + f);
        }
        for (const b of list) {
          if (b.host === hostId && b.file === f) botFiles.push({ ...b, users });
        }
      }
    }

    const wanted = [...new Set(logins.map(lower).filter(Boolean))];
    const secrets = [];
    // DropLog.login keeps whatever case the account was scanned with (684 prod
    // logins carry capitals), so match every spelling seen, exactly — an
    // index-friendly $in, where a case-insensitive regex per login would scan.
    const spellings = new Set(wanted);
    for (const l of logins) if (l) spellings.add(String(l).trim());
    for (const b of botFiles) {
      for (const u of b.users) {
        if (!wanted.includes(lower(u.Login))) continue;
        secrets.push(secretOf(u));
        spellings.add(String(u.Login).trim());
      }
    }
    const [poolRows, accRows, soldDrops, renterRows, noclaim] = await Promise.all([
      AvailableAccount.find(
        { usernameLower: { $in: wanted } },
        { usernameLower: 1, status: 1, claimedNote: 1, manualSold: 1, unclaimedDropCount: 1 },
      ).lean(),
      BotAccount.find(
        { clientSecret: { $in: secrets.filter(Boolean) } },
        { clientSecret: 1, lastScanStatus: 1, soldAt: 1, soldToUsername: 1 },
      ).lean(),
      DropLog.find(
        {
          login: { $in: [...spellings] },
          game: { $in: [...new Set([String(game), String(game).trim()])] },
          $or: [{ connected: true }, { soldAt: { $ne: null } }],
        },
        { login: 1, soldAt: 1, soldToUsername: 1, connected: 1 },
      ).lean(),
      RenterAccount.find({ enabled: true }, { login: 1 }).lean(),
      noclaimSecrets(),
    ]);
    const pool = new Map(poolRows.map((r) => [r.usernameLower, r]));
    const botAccounts = new Map(accRows.map((r) => [r.clientSecret, r]));
    const gameSold = new Set(
      soldDrops
        .filter((d) => d.connected || (d.soldAt && !isMarketClaimTag(d.soldToUsername)))
        .map((d) => lower(d.login)),
    );
    const renters = new Set(renterRows.map((r) => lower(r.login)));

    const { plan, skipped, alreadyArmed } = planRearm({
      game, logins: wanted, botFiles, enabledIn, pool, botAccounts, gameSold, noclaim, renters,
    });
    result.skipped = Object.fromEntries(Object.entries(skipped).map(([k, v]) => [k, v.length]));
    result.alreadyArmed = alreadyArmed.length;
    if (dryRun) {
      result.wouldRearm = [...plan.values()].reduce((n, v) => n + v.length, 0);
      result.wouldChange = [...plan.keys()];
      return result;
    }

    for (const [key, changes] of plan) {
      const b = botFiles.find((x) => x.host + "|" + x.file === key);
      const h = hosts.resolveHost(b.host);
      const bySecret = new Map(changes.map((c) => [c.secret, c]));
      let n = 0;
      await withFileLock(h, b.file, async () => {
        const cur = await hosts.readFile(h, b.file);
        const cfg = JSON.parse(cur);
        for (const u of usersOf(cfg)) {
          const c = bySecret.get(secretOf(u));
          if (!c) continue;
          const own = Array.isArray(u.FavouriteGames) ? u.FavouriteGames : [];
          if (!own.some((f) => lower(f) === lower(game))) u.FavouriteGames = own.concat([game]);
          u.Enabled = true;
          n++;
        }
        if (!n) return;
        await hosts.saveSnapshot(h.id, b.file, cur);
        await hosts.writeFileAtomic(h, b.file, JSON.stringify(cfg, null, 2));
      });
      if (!n) continue;
      await BotAccount.updateMany(
        { clientSecret: { $in: [...bySecret.keys()] } },
        { $set: { enabled: true, host: b.host, configFile: b.file, container: b.container } },
      );
      result.rearmed += n;
      result.changedBots.push({ host: b.host, file: b.file, container: b.container, count: n });
    }
    return result;
  } catch (e) {
    return { ...result, error: e.message || String(e) };
  }
}

module.exports = { planRearm, rearmReusedAccounts, noclaimSecrets };
