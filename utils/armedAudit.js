// Accounts an active auto-farm task counts as deployed that no bot is farming.
//
// A task's `assignedAccounts` is the database's word for "these are farming".
// The bots only read their config files, and the two can part company without
// either noticing: on 2026-10-09 a probe's write of a shared config was
// overwritten a second later (two farms placed at once), and 13 of its 15
// accounts sat switched off for 2.5 hours — the task read 15 deployed, so
// backfill (which counts assignedAccounts) added nobody and nothing raised it.
// The locks that close that race are in utils/fileLock, utils/dupeGuard and
// utils/farmOps; this is the check that says so if it ever happens again, by
// any road.
//
// An account is STRANDED for a task when the task's game is not being farmed
// by it and nothing explains why:
//   off        it has an entry in one of the task's bots, switched off or
//              without the task's game;
//   missing    it has no entry in any of the task's bots, and is switched on
//              nowhere on the host;
//   elsewhere  it is switched on in another config on the host, on other
//              games only — the footprint of a heal that took it from the
//              bot it had just been placed in.
// and, in every case, it passes the guards utils/reuseRearm.planRearm applies
// before it would switch an account back on: the pool row is still an
// auto-farm claim holding no unclaimed drops, the account is alive and not
// sold, no drop of this game went to a buyer or was connected, and it is in
// no no-claim bot and no renter stack. Every account that is off for one of
// those reasons is off on purpose and is not counted. The judging IS
// planRearm — a "missing" account is shown to it as a switched-off entry in a
// bot that does not exist. An account switched on in another config WITH the
// task's game is farming it and counts as armed, wherever the task thinks its
// bots are; so does one that is switched on with no game list of its own in a
// bot whose config-level list has the game (it inherits it).
//
// audit() only reads: one batched read of each host's configs, one of the
// no-claim tree, a handful of queries. rearm() is the repair for "off" — the
// same reuseRearm call a reused farm makes, then a reload of the bots it
// changed that are running. "missing" and "elsewhere" are reported only:
// putting an account into a bot is a placement, and that is the engine's.
//
// Switch: autoFarm.rearmStranded === true lets the janitor tick run rearm()
// after an audit. Off unless set; the health board check reports either way.
const hosts = require("./botHosts");
const settings = require("./settings");
const reuseRearm = require("./reuseRearm");
const { isMarketClaimTag } = require("./marketClaimTags");

const CONFIG_RE = /^config(_[A-Za-z0-9-]+)?\.json$/;
// The bot a "missing" account is shown to planRearm in. Never written.
const NO_BOT = "(no bot)";

const lower = (s) => String(s || "").trim().toLowerCase();
const secretOf = (u) => String((u && u.ClientSecret) || "").trim();
const usersOf = (cfg) =>
  cfg && cfg.TwitchSettings && Array.isArray(cfg.TwitchSettings.TwitchUsers)
    ? cfg.TwitchSettings.TwitchUsers
    : [];

// Every operator config on `hostId`: { listed: Set(file), files: Map(file ->
// users), games: Map(file -> config-level FavouriteGames), enabledIn:
// Map(secret -> ["host|file"]), unreadable: [file] }. Throws when the host
// itself cannot be listed. A file that is listed but does not read or parse
// is `unreadable`; one a task names that is not listed at all is gone.
async function readHost(hostId) {
  const h = hosts.resolveHost(hostId);
  if (!h) throw new Error("unknown host " + hostId);
  const names = (await hosts.readdir(h)).map((f) => f.name || f).filter((f) => CONFIG_RE.test(f));
  const raw = names.length ? await hosts.readFiles(h, names) : {};
  const files = new Map();
  const games = new Map();
  const enabledIn = new Map();
  const unreadable = [];
  for (const f of names) {
    let cfg = null;
    try {
      if (raw[f] && raw[f].ok) cfg = JSON.parse(raw[f].text);
    } catch {
      cfg = null;
    }
    if (!cfg || typeof cfg !== "object") {
      unreadable.push(f);
      continue;
    }
    // A config can carry a null where an entry was: not an account.
    const users = usersOf(cfg).filter((u) => u && typeof u === "object");
    files.set(f, users);
    games.set(f, Array.isArray(cfg.FavouriteGames) ? cfg.FavouriteGames : []);
    for (const u of users) {
      const s = secretOf(u);
      if (!s || u.Enabled === false) continue;
      if (!enabledIn.has(s)) enabledIn.set(s, []);
      enabledIn.get(s).push(hostId + "|" + f);
    }
  }
  return { listed: new Set(names), files, games, enabledIn, unreadable };
}

// Does this switched-on entry farm `game`? By its own list, or — with no list
// of its own — by the list of the config it sits in.
function farms(user, configGames, game) {
  const own = Array.isArray(user.FavouriteGames) ? user.FavouriteGames : [];
  const list = own.length ? own : configGames || [];
  return list.some((g) => lower(g) === lower(game));
}

// Judge every active task. Returns
//   { tasks, accounts, armed, stranded: [{ taskId, game, campaignName, decision,
//     assigned, off: [login], missing: [login], elsewhere: [login],
//     bots: [{host,file,container}] }],
//     blind: [why a task or part of it could not be judged] }
// Throws when the no-claim tree cannot be read: without it an account that
// sits in a no-claim bot cannot be told from a stranded one, and nothing is
// reported rather than something wrong.
async function audit({ now = Date.now() } = {}) {
  const AutoFarmTask = require("../models/AutoFarmTask");
  const AvailableAccount = require("../models/AvailableAccount");
  const BotAccount = require("../models/BotAccount");
  const DropLog = require("../models/DropLog");
  const RenterAccount = require("../models/RenterAccount");

  const out = { tasks: 0, accounts: 0, armed: 0, stranded: [], blind: [] };
  const all = await AutoFarmTask.find(
    { status: "active" },
    { game: 1, campaignId: 1, campaignName: 1, campaignEndAt: 1, decision: 1, assignedAccounts: 1, bots: 1 },
  ).lean();
  // A task whose campaign is over is about to be ended — its accounts are
  // switched off by that clean-up, not stranded. No-claim games' old tasks
  // are the standalone no-claim system's.
  const tasks = all.filter(
    (t) =>
      (t.assignedAccounts || []).length &&
      (t.bots || []).some((b) => b && b.host && b.file) &&
      !(t.campaignEndAt && new Date(t.campaignEndAt).getTime() < now) &&
      !settings.isNoClaimGame(t.game),
  );
  if (!tasks.length) return out;

  const hostState = new Map(); // hostId -> readHost result | null (down)
  for (const hostId of new Set(tasks.flatMap((t) => t.bots.map((b) => b.host).filter(Boolean)))) {
    try {
      hostState.set(hostId, await readHost(hostId));
    } catch (e) {
      hostState.set(hostId, null);
      out.blind.push(hostId + ": " + ((e && e.message) || e));
    }
  }
  const noclaim = await reuseRearm.noclaimSecrets();

  const wanted = [...new Set(tasks.flatMap((t) => t.assignedAccounts.map(lower)).filter(Boolean))];
  const poolRows = await AvailableAccount.find(
    { usernameLower: { $in: wanted } },
    { usernameLower: 1, status: 1, claimedNote: 1, manualSold: 1, unclaimedDropCount: 1, clientSecret: 1 },
  ).lean();
  const pool = new Map(poolRows.map((r) => [r.usernameLower, r]));

  // Every spelling of a login (DropLog keeps the case it was scanned with) and
  // every token the judged accounts carry, in a config or on the pool row.
  const spellings = new Set(wanted);
  const secrets = new Set(poolRows.map((r) => String(r.clientSecret || "").trim()).filter(Boolean));
  const wantedSet = new Set(wanted);
  for (const t of tasks) for (const u of t.assignedAccounts) if (u) spellings.add(String(u).trim());
  for (const st of hostState.values()) {
    if (!st) continue;
    for (const users of st.files.values()) {
      for (const u of users) {
        if (!wantedSet.has(lower(u.Login))) continue;
        spellings.add(String(u.Login).trim());
        if (secretOf(u)) secrets.add(secretOf(u));
      }
    }
  }
  const games = [...new Set(tasks.flatMap((t) => [String(t.game), String(t.game).trim()]))];
  const [accRows, soldDrops, renterRows] = await Promise.all([
    BotAccount.find(
      { clientSecret: { $in: [...secrets] } },
      { clientSecret: 1, lastScanStatus: 1, soldAt: 1, soldToUsername: 1 },
    ).lean(),
    DropLog.find(
      {
        login: { $in: [...spellings] },
        game: { $in: games },
        $or: [{ connected: true }, { soldAt: { $ne: null } }],
      },
      { login: 1, game: 1, soldAt: 1, soldToUsername: 1, connected: 1 },
    ).lean(),
    RenterAccount.find({ enabled: true }, { login: 1 }).lean(),
  ]);
  const botAccounts = new Map(accRows.map((r) => [r.clientSecret, r]));
  const renters = new Set(renterRows.map((r) => lower(r.login)));
  const soldByGame = new Map(); // game (lower) -> Set(login lower)
  for (const d of soldDrops) {
    if (!(d.connected || (d.soldAt && !isMarketClaimTag(d.soldToUsername)))) continue;
    const g = lower(d.game);
    if (!soldByGame.has(g)) soldByGame.set(g, new Set());
    soldByGame.get(g).add(lower(d.login));
  }

  for (const t of tasks) {
    const named = t.bots.filter((b) => b && b.host && b.file);
    const logins = [...new Set(t.assignedAccounts.map(lower).filter(Boolean))];
    // A bot the task still names whose config is no longer on the host was
    // retired: nothing of the task's is in it. One that is there and could not
    // be read is different — the task is not judged at all, because an
    // account "missing" from the files that were read may be in that one.
    const bots = named.filter((b) => {
      const st = hostState.get(b.host);
      return !st || st.listed.has(b.file);
    });
    const unread = bots.filter((b) => {
      const st = hostState.get(b.host);
      return !st || !st.files.has(b.file);
    });
    if (unread.length) {
      out.blind.push(
        t.game + ": " + unread.map((b) => b.host + "/" + b.file).join(", ") + " could not be read",
      );
      continue;
    }
    const botFiles = bots.map((b) => ({ ...b, users: hostState.get(b.host).files.get(b.file) }));
    const enabledIn = new Map();
    const blindHosts = [];
    for (const hostId of new Set(named.map((b) => b.host))) {
      const st = hostState.get(hostId);
      if (!st) continue;
      for (const [s, where] of st.enabledIn) enabledIn.set(s, (enabledIn.get(s) || []).concat(where));
      if (st.unreadable.length) blindHosts.push(hostId);
    }
    // "Missing" needs every config on the host: an account in none of the
    // task's bots may be switched on in a config that could not be read.
    const inBots = new Set(botFiles.flatMap((b) => b.users.map((u) => lower(u.Login))));
    const ghosts = blindHosts.length
      ? []
      : logins
          .filter((l) => !inBots.has(l) && pool.get(l) && String(pool.get(l).clientSecret || "").trim())
          .map((l) => ({
            Login: l,
            ClientSecret: String(pool.get(l).clientSecret).trim(),
            Enabled: false,
            FavouriteGames: [],
          }));
    if (blindHosts.length) {
      out.blind.push(
        t.game + ": accounts in none of its bots were not judged (" +
          blindHosts.join(", ") + " has an unreadable config)",
      );
    }
    const shown = ghosts.length
      ? botFiles.concat([{ host: named[0].host, file: NO_BOT, container: "", users: ghosts }])
      : botFiles;
    const { plan, skipped, alreadyArmed } = reuseRearm.planRearm({
      game: t.game,
      logins,
      botFiles: shown,
      enabledIn,
      pool,
      botAccounts,
      gameSold: soldByGame.get(lower(t.game)) || new Set(),
      noclaim,
      renters,
    });
    out.tasks += 1;
    out.accounts += logins.length;
    let armed = alreadyArmed.length;
    const off = [];
    const missing = [];
    const elsewhere = [];
    for (const [key, changes] of plan) {
      const b = shown.find((x) => x.host + "|" + x.file === key);
      for (const c of changes) {
        if (b.file === NO_BOT) {
          missing.push(c.login);
          continue;
        }
        // Switched on without the game in its OWN list: it may inherit it.
        const u = b.users.find((x) => secretOf(x) === c.secret);
        const st = hostState.get(b.host);
        if (!c.enable && u && farms(u, st.games.get(b.file), t.game)) armed += 1;
        else off.push(c.login);
      }
    }
    // Switched on in another config. Farming this game there, it is armed —
    // the task's idea of where its bots are is simply behind. On other games
    // only, the farm counts an account that farms nothing for it. "Enabled in
    // another config" is the LAST thing planRearm holds an account back for,
    // so every account it names has passed all the other guards already (the
    // sold one in tests/armedAudit.test.js would show a change of that order).
    const away = skipped["enabled in another config"] || [];
    if (away.length) {
      for (const login of away) {
        const secret =
          botFiles.flatMap((b) => b.users).filter((u) => lower(u.Login) === login).map(secretOf)[0] ||
          String((pool.get(login) || {}).clientSecret || "").trim();
        let farming = false;
        for (const where of enabledIn.get(secret) || []) {
          const [hostId, file] = where.split("|");
          const st = hostState.get(hostId);
          const u = st && (st.files.get(file) || []).find((x) => secretOf(x) === secret && x.Enabled !== false);
          if (u && farms(u, st.games.get(file), t.game)) farming = true;
        }
        if (farming) armed += 1;
        else elsewhere.push(login);
      }
    }
    out.armed += armed;
    if (off.length || missing.length || elsewhere.length) {
      out.stranded.push({
        taskId: String(t._id),
        game: t.game,
        campaignName: t.campaignName || "",
        decision: t.decision || "",
        assigned: logins.length,
        off,
        missing,
        elsewhere,
        bots: bots.map((b) => ({ host: b.host, file: b.file, container: b.container })),
      });
    }
  }
  return out;
}

// Switch the "off" accounts of an audit back on, and reload the bots that
// changed and are running (a parked bot reads its config when it next
// starts). Returns { rearmed, tasks: [{ game, rearmed, skipped, restarted }] }.
// Never throws: reuseRearm re-arms nothing when it cannot be sure.
async function rearm(found, { progress = () => {} } = {}) {
  const result = { rearmed: 0, tasks: [] };
  for (const s of (found && found.stranded) || []) {
    if (!s.off.length) continue;
    const r = await reuseRearm.rearmReusedAccounts({ bots: s.bots, logins: s.off, game: s.game });
    const restarted = [];
    for (const cb of r.changedBots || []) {
      try {
        const h = hosts.resolveHost(cb.host);
        const done = await require("./farmControl").restartIfRunning(h, cb.container);
        if (done && done.restarted) restarted.push(cb.container);
      } catch (e) {
        progress("Reload of " + cb.container + " after the re-arm failed: " + ((e && e.message) || e), "warn");
      }
    }
    if (r.error) progress("Re-arm of " + s.game + " skipped: " + r.error, "warn");
    result.rearmed += r.rearmed || 0;
    result.tasks.push({ game: s.game, rearmed: r.rearmed || 0, skipped: r.skipped || {}, restarted });
    if (r.rearmed) {
      try {
        require("./systemLog").logEvent({
          category: "autofarm",
          action: "accounts_rearmed",
          actor: "armedAudit",
          game: s.game,
          subject: s.taskId,
          count: r.rearmed,
          detail:
            r.rearmed + " account(s) " + s.game + " counted as deployed were switched off in " +
            (r.changedBots || []).map((c) => c.container).join(", ") + " — switched back on" +
            (restarted.length ? ", reloaded " + restarted.join(", ") : ""),
        });
      } catch {
        /* the progress line stands */
      }
      progress("Re-armed " + r.rearmed + " stranded account(s) for " + s.game + ".");
    }
  }
  return result;
}

module.exports = { audit, rearm, NO_BOT };
