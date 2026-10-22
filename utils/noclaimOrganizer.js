// The no-claim farm's bot organizer: keeps every game's shared bots packed
// evenly at no more than `size` accounts each, and merges bots as a game
// shrinks, so the fleet runs as few containers as it needs.
//
// WHY THIS EXISTS
//
// A no-claim container costs a fixed slice of RAM whatever it holds (~65 MB
// measured on contabo2 2026-10-22, plus ~2.8 MB per account), and the fleet
// only ever grew: sales take accounts out one at a time (retireSoldFromBots),
// the allocator tops bots up to 70, and hand-made bots stay at 1, 2 or 11
// accounts forever. On 2026-10-22 the Overwatch fleet was 17 bots holding 1 to
// 70 accounts each. The owner asked for "50 size bots" and for something that
// keeps them that way by itself. The one-off reorganisations before this
// (2026-07-28 repacker, 2026-09-18 Overwatch reorg) both drifted back within
// days because nothing ran them.
//
// WHAT IT DOES, PER GAME
//
//   needed bots = ceil(enabled accounts / size). It acts only when that saves a
//   container (more bots hold accounts than are needed), when a bot holds more
//   than `size`, or when a bot holds no enabled account at all. Otherwise it
//   leaves the game alone — it never shuffles accounts just to even out 47 vs
//   50. When it acts, the bots with the most accounts are kept (fewest moves),
//   every kept bot gets an equal share (floor/ceil of n / needed), the surplus
//   bots are emptied and retired, and a new bot is built only when the game
//   has more accounts than its bots can hold at `size`.
//
// WHAT IT NEVER TOUCHES
//
//   * "My own" bots (.personal) and bots the operator stopped (.operatoroff) —
//     they are not shared supply (the same rule unclaimedAllocator uses).
//   * Disabled config entries: they stay in the bot they are in and never count
//     toward its size (rented-out logins, retirement markers).
//   * Any account: it never claims from the pool and never drops one. Every
//     account that leaves a bot is first written into another bot.
//
// HOW A MOVE IS MADE SAFE
//
//   1. A tarball of every config is taken on the host before the first write.
//   2. Every account is ADDED to its new bot first (re-read under the same
//      per-file lock as topUpBot / removeFromBotConfig, appended, read back),
//      and only then REMOVED from its old bot. A failure in between leaves an
//      account in two configs — never in none — and that is rolled back.
//   3. An account that left its old bot by itself in the meantime (a sale's
//      clean-up) is taken back out of the bot it was just added to: a sold
//      account must never be resurrected into a bot.
//   4. Running bots are restarted old-bot-first, so one login never runs in two
//      containers at once; parked bots are not woken (the auto power watcher
//      starts them when their game is live — their `.finished` marker carries
//      the config's hash, so a changed config always gets its next run).
//   5. A retired bot's container is removed and its directory moved under
//      _retired/, with a `.retired` placeholder left so its number is never
//      handed out again (noclaimFleet.nextBotId counts directories).
//
// Settings (autoFarm.noclaimOrganize, all optional, live — no restart):
//   enabled        false   act on the hourly allocator pass
//   size           50      most enabled accounts per bot (10..MAX_PER_BOT)
//   minSaveBots    1       merge only when this many containers can go
//   maxMovesPerPass 800    refuse a plan bigger than this (run it by hand)
//   allowRunning   true    false = only organize a game while all its bots are parked

const hosts = require("./botHosts");
const settings = require("./settings");
const fleet = require("./noclaimFleet");
const { withFileLock } = require("./fileLock");
const { logEvent } = require("./systemLog");

const RETIRED_DIR = fleet.BASE + "/_retired";
const BACKUP_DIR = fleet.BASE + "/_organize_backup";
const BACKUPS_KEPT = 20;

const DEFAULTS = Object.freeze({
  enabled: false,
  size: 50,
  minSaveBots: 1,
  maxMovesPerPass: 800,
  allowRunning: true,
});

const state = {
  running: false,
  lastRun: null,
  lastResult: null,
  lastError: "",
};

const int = (v, d) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? n : d;
};

// The organizer's settings, defaults filled in and clamped. Pure over `af`.
function config(af) {
  const a = af || settings.getAutoFarm() || {};
  const c = a.noclaimOrganize && typeof a.noclaimOrganize === "object" ? a.noclaimOrganize : {};
  return {
    enabled: c.enabled === true,
    size: Math.min(fleet.MAX_PER_BOT, Math.max(10, int(c.size, DEFAULTS.size))),
    minSaveBots: Math.max(1, int(c.minSaveBots, DEFAULTS.minSaveBots)),
    maxMovesPerPass: Math.max(1, int(c.maxMovesPerPass, DEFAULTS.maxMovesPerPass)),
    allowRunning: c.allowRunning == null ? DEFAULTS.allowRunning : c.allowRunning !== false,
  };
}

// How many accounts one bot may be given. The allocator's top-ups and new bots
// use this, so feeding a game never undoes the organizer's packing. Off = the
// fleet's own limit, exactly as before.
function botCap(af) {
  const c = config(af);
  return c.enabled ? c.size : fleet.MAX_PER_BOT;
}

const isEnabled = (u) => !!u && u.Enabled !== false;
const secretOf = (u) => String((u && u.ClientSecret) || "").trim();

// ---------------------------------------------------------------------------
// The plan (pure)
// ---------------------------------------------------------------------------

// One game's plan. `bots` are that game's SHARED bots only (no .personal, no
// .operatoroff, a container), each { id, running, users: [config entries] }.
// Returns what to do; `due: false` means leave the game alone.
function planGame({ key, label, bots, size, minSaveBots = 1 }) {
  const rows = (bots || []).map((b) => {
    const enabled = (b.users || []).filter(isEnabled);
    return {
      id: String(b.id),
      running: !!b.running,
      enabled,
      disabled: (b.users || []).length - enabled.length,
    };
  });
  const n = rows.reduce((s, r) => s + r.enabled.length, 0);
  const active = rows.filter((r) => r.enabled.length > 0);
  const idle = rows.filter((r) => r.enabled.length === 0);
  const need = n ? Math.ceil(n / size) : 0;
  const over = active.filter((r) => r.enabled.length > size).map((r) => r.id);
  const out = {
    key,
    label,
    size,
    accounts: n,
    bots: rows.length,
    activeBots: active.length,
    needBots: need,
    due: false,
    reasons: [],
    keep: [],
    retire: [],
    park: [],
    create: 0,
    quotas: {},
    moves: [],
    after: {},
  };
  if (active.length - need >= minSaveBots) out.reasons.push(`${active.length - need} bot(s) more than needed`);
  if (over.length) out.reasons.push(`bot ${over.join(", ")} over ${size}`);
  if (idle.length) out.reasons.push(`bot ${idle.map((r) => r.id).join(", ")} farming nothing`);
  if (!out.reasons.length) return out;
  out.due = true;

  // Keep the fullest bots (fewest moves); ties keep the lower number.
  const byFill = [...active].sort(
    (a, b) => b.enabled.length - a.enabled.length || Number(a.id) - Number(b.id),
  );
  const keep = byFill.slice(0, Math.min(need, byFill.length));
  const drop = byFill.slice(keep.length).concat(idle);
  out.create = Math.max(0, need - keep.length);

  // Equal shares. The +1 shares go to the fullest kept bots (fewer moves); new
  // bots come last and take what is left.
  const slots = keep.map((r) => r.id).concat(Array.from({ length: out.create }, (_, i) => "new" + (i + 1)));
  const base = need ? Math.floor(n / need) : 0;
  const extra = need ? n % need : 0;
  slots.forEach((id, i) => {
    out.quotas[id] = base + (i < extra ? 1 : 0);
  });

  // Who leaves: the newest entries of an over-quota bot (the end of its list),
  // and everything enabled in a bot that is going.
  const movers = [];
  for (const r of keep) {
    const q = out.quotas[r.id];
    for (const u of r.enabled.slice(q)) movers.push({ u, from: r.id });
  }
  for (const r of drop) for (const u of r.enabled) movers.push({ u, from: r.id });

  // Who receives: kept bots under their share (biggest gap first), then new bots.
  const room = slots
    .map((id) => {
      const r = keep.find((k) => k.id === id);
      return { id, gap: out.quotas[id] - (r ? Math.min(r.enabled.length, out.quotas[id]) : 0) };
    })
    .filter((x) => x.gap > 0)
    .sort((a, b) => (a.id.startsWith("new") ? 1 : 0) - (b.id.startsWith("new") ? 1 : 0) || b.gap - a.gap);
  let i = 0;
  for (const m of movers) {
    while (i < room.length && room[i].gap <= 0) i++;
    if (i >= room.length) break; // cannot happen: shares sum to n
    room[i].gap--;
    out.moves.push({ secret: secretOf(m.u), login: String(m.u.Login || ""), from: m.from, to: room[i].id });
  }

  out.keep = keep.map((r) => r.id);
  for (const r of drop) (r.disabled > 0 ? out.park : out.retire).push(r.id);
  for (const id of slots) out.after[id] = out.quotas[id];
  return out;
}

// Group a fleet snapshot into games and plan each one. `snap.bots` entries:
// { id, label, personal, operatorOff, container, running, users, cfg }.
function planFleet(snap, cfg) {
  const groups = new Map();
  const skipped = [];
  for (const b of snap.bots) {
    if (b.personal) continue;
    if (b.operatorOff) continue;
    if (!b.container) {
      skipped.push({ id: b.id, why: "no container" });
      continue;
    }
    const key = settings.normGameName(b.label);
    if (!key) {
      skipped.push({ id: b.id, why: "no game in its config" });
      continue;
    }
    if (!groups.has(key)) groups.set(key, { key, label: b.label, bots: [] });
    groups.get(key).bots.push(b);
  }
  const games = [];
  for (const g of groups.values()) {
    const p = planGame({ key: g.key, label: g.label, bots: g.bots, size: cfg.size, minSaveBots: cfg.minSaveBots });
    p.running = g.bots.filter((b) => b.running).map((b) => b.id);
    if (p.due && !cfg.allowRunning && p.running.length) {
      p.held = "its bots are running (allowRunning is off)";
    } else if (p.due && p.moves.length > cfg.maxMovesPerPass) {
      p.held = `${p.moves.length} moves is more than maxMovesPerPass (${cfg.maxMovesPerPass}) — run it from the page`;
    }
    games.push(p);
  }
  games.sort((a, b) => a.label.localeCompare(b.label));
  return { games, skipped };
}

// ---------------------------------------------------------------------------
// Reading the fleet
// ---------------------------------------------------------------------------

// Every bot directory with a config: its markers, its container's state and
// its config, parsed. Throws when anything cannot be read — a plan built on a
// partial read could move an account into a bot that already has it.
async function readSnapshot() {
  const host = fleet.pi();
  const dir = hosts.shq(fleet.BOTS_DIR);
  const out = await fleet.sh(
    `for d in ${dir}/*/; do id=$(basename "$d"); [ -f "$d/Configuration/config.json" ] || continue; ` +
      `m=; for f in .personal .operatoroff .autostopped .finished; do [ -f "$d$f" ] && m="$m$f,"; done; ` +
      `echo "B|$id|$m"; done; ` +
      `docker ps -a --filter name=^/${fleet.containerFor("")} --format 'C|{{.Names}}|{{.State}}' 2>/dev/null; echo "PS_RC=$?"; ` +
      `docker image inspect ${hosts.shq(fleet.IMAGE)} >/dev/null 2>&1 && echo IMG=yes || echo IMG=no; ` +
      `[ -f ${hosts.shq(fleet.BASE + "/.provisioning")} ] && echo PROV=yes || echo PROV=no`,
    { timeout: 45000 },
  );
  const markers = new Map();
  const containers = new Map();
  let psOk = false;
  let image = false;
  let provisioning = false;
  for (const raw of String(out || "").split("\n")) {
    const line = raw.trim();
    const p = line.split("|");
    if (p[0] === "B") markers.set(p[1], new Set(String(p[2] || "").split(",").filter(Boolean)));
    else if (p[0] === "C") containers.set(p[1], p[2]);
    else if (line === "PS_RC=0") psOk = true;
    else if (line === "IMG=yes") image = true;
    else if (line === "PROV=yes") provisioning = true;
  }
  if (!psOk) throw new Error("docker ps failed on the no-claim host — container states unknown");
  const ids = [...markers.keys()].filter((id) => /^\d+$/.test(id));
  const paths = ids.map((id) => fleet.configPath(id));
  const files = paths.length ? await hosts.readFiles(host, paths) : {};
  const bots = [];
  for (const id of ids) {
    const f = files[fleet.configPath(id)];
    if (!f || !f.ok || !f.text) throw new Error(`bot ${id}'s config could not be read`);
    let cfg;
    try {
      cfg = JSON.parse(f.text);
    } catch (e) {
      throw new Error(`bot ${id}'s config is not valid JSON (${e.message})`);
    }
    const m = markers.get(id);
    const st = containers.get(fleet.containerFor(id));
    const users = (cfg.TwitchSettings && cfg.TwitchSettings.TwitchUsers) || [];
    bots.push({
      id,
      label: String((cfg.FavouriteGames || [])[0] || ""),
      personal: m.has(".personal"),
      operatorOff: m.has(".operatoroff"),
      autostopped: m.has(".autostopped"),
      container: !!st,
      running: st === "running",
      users: Array.isArray(users) ? users : [],
      cfg,
    });
  }
  bots.sort((a, b) => Number(a.id) - Number(b.id));
  // One account, one bot: the plan is only safe on a fleet that already obeys it.
  const seen = new Map();
  const dupes = [];
  for (const b of bots)
    for (const u of b.users) {
      const s = secretOf(u);
      if (!s) continue;
      if (seen.has(s) && seen.get(s) !== b.id) dupes.push(`${u.Login || "?"} (bots ${seen.get(s)} + ${b.id})`);
      else seen.set(s, b.id);
    }
  return { bots, image, provisioning, dupes };
}

// ---------------------------------------------------------------------------
// Doing it
// ---------------------------------------------------------------------------

const ts = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");

async function readConfig(id) {
  const raw = await fleet.sh(`cat ${hosts.shq(fleet.configPath(id))}`, { timeout: 20000 });
  return JSON.parse(raw);
}

async function writeConfig(id, cfg, { mkdirs = [] } = {}) {
  const text = JSON.stringify(cfg, null, 2);
  await fleet.sh(
    hosts.guardedWriteScript(fleet.configPath(id), hosts.byteLength(text), { mode: "600", mkdirs }),
    { timeout: 20000, input: text },
  );
}

const usersIn = (cfg) => {
  const ts_ = cfg.TwitchSettings || (cfg.TwitchSettings = {});
  if (!Array.isArray(ts_.TwitchUsers)) ts_.TwitchUsers = [];
  return ts_.TwitchUsers;
};

// Append entries (verbatim) to bot `id`, skipping any already there. Returns
// the secrets that are in the config afterwards, read back.
async function addToBot(id, entries) {
  const file = fleet.configPath(id);
  return withFileLock(fleet.pi(), file, async () => {
    const cfg = await readConfig(id);
    const users = usersIn(cfg);
    const have = new Set(users.map(secretOf));
    let added = 0;
    for (const e of entries) {
      const s = secretOf(e);
      if (!s || have.has(s)) continue;
      users.push(e);
      have.add(s);
      added++;
    }
    if (added) await writeConfig(id, cfg);
    const back = new Set(usersIn(await readConfig(id)).map(secretOf));
    return { added, present: entries.map(secretOf).filter((s) => back.has(s)) };
  });
}

// Take secrets out of bot `id`. Returns which were found and removed, read back.
async function removeFromBot(id, secrets) {
  const want = new Set(secrets);
  const file = fleet.configPath(id);
  return withFileLock(fleet.pi(), file, async () => {
    const cfg = await readConfig(id);
    const users = usersIn(cfg);
    const removed = users.filter((u) => want.has(secretOf(u))).map(secretOf);
    if (removed.length) {
      cfg.TwitchSettings.TwitchUsers = users.filter((u) => !want.has(secretOf(u)));
      await writeConfig(id, cfg);
      const still = usersIn(await readConfig(id)).filter((u) => want.has(secretOf(u)));
      if (still.length) throw new Error(`bot ${id}: ${still.length} account(s) still in the config after the write`);
    }
    return { removed, left: cfg.TwitchSettings.TwitchUsers.length };
  });
}

// A new bot for some of the moving accounts: the config is a copy of a sibling
// bot's (same game, same settings) holding only those entries, and the
// container is created STOPPED with the watcher's park marker — the auto power
// watcher starts it when its game is live, inside its RAM-limited waves.
async function buildBot(template, entries) {
  const id = await fleet.nextBotId();
  const dir = fleet.botDir(id);
  // Claim the number at once: nextBotId counts directories.
  await fleet.sh(`mkdir ${hosts.shq(dir)}`, { timeout: 15000 });
  try {
    const cfg = JSON.parse(JSON.stringify(template));
    cfg.TwitchSettings = cfg.TwitchSettings || {};
    cfg.TwitchSettings.TwitchUsers = entries;
    if (Array.isArray(cfg.KickUsers)) cfg.KickUsers = [];
    if (cfg.KickSettings && Array.isArray(cfg.KickSettings.KickUsers)) cfg.KickSettings.KickUsers = [];
    await writeConfig(id, cfg, { mkdirs: [dir + "/Configuration", dir + "/logs"] });
    const back = new Set(usersIn(await readConfig(id)).map(secretOf));
    if (entries.some((e) => !back.has(secretOf(e)))) throw new Error(`new bot ${id}: config read-back is missing accounts`);
    await fleet.sh(
      `docker create ${fleet.containerRunArgs(id)} >/dev/null && touch ${hosts.shq(fleet.markerPath(id))}`,
      { timeout: 60000 },
    );
    return id;
  } catch (e) {
    // Nothing points at it yet: take it down, keep the number reserved.
    await fleet
      .sh(
        `docker rm -f ${hosts.shq(fleet.containerFor(id))} >/dev/null 2>&1; ` +
          `mkdir -p ${hosts.shq(RETIRED_DIR)} && mv ${hosts.shq(dir)} ${hosts.shq(RETIRED_DIR + "/" + id + "-failed-" + ts())} ; ` +
          `mkdir -p ${hosts.shq(dir)} && touch ${hosts.shq(dir + "/.retired")}; true`,
        { timeout: 60000 },
      )
      .catch(() => {});
    throw e;
  }
}

// Bots read their config only when they start. A running bot restarts; a
// parked one is left parked (restarting it would fight the watcher).
async function restartIfRunning(id) {
  const c = hosts.shq(fleet.containerFor(id));
  await fleet.sh(
    `if [ "$(docker inspect -f '{{.State.Running}}' ${c} 2>/dev/null)" = "true" ]; then docker restart ${c} >/dev/null; fi`,
    { timeout: 90000 },
  );
}

// A bot left with no accounts at all: stop it, remove its container, move its
// directory under _retired/ and leave a placeholder so the number stays used.
// Re-reads the config first and refuses if anything is still in it.
async function retireBot(id) {
  const file = fleet.configPath(id);
  return withFileLock(fleet.pi(), file, async () => {
    const cfg = await readConfig(id);
    if (usersIn(cfg).length) throw new Error(`bot ${id} still holds ${usersIn(cfg).length} account(s) — not retired`);
    const dir = fleet.botDir(id);
    await fleet.sh(
      `docker stop ${hosts.shq(fleet.containerFor(id))} >/dev/null 2>&1; ` +
        `docker rm ${hosts.shq(fleet.containerFor(id))} >/dev/null 2>&1; ` +
        `mkdir -p ${hosts.shq(RETIRED_DIR)} && mv ${hosts.shq(dir)} ${hosts.shq(RETIRED_DIR + "/" + id + "-" + ts())} && ` +
        `mkdir -p ${hosts.shq(dir)} && touch ${hosts.shq(dir + "/.retired")}`,
      { timeout: 60000 },
    );
    return true;
  });
}

// A bot left holding only switched-off entries: stopped and marked as the
// operator's, so the watcher never starts a bot with nothing to farm.
async function parkBot(id) {
  await fleet.sh(
    `touch ${hosts.shq(fleet.operatorMarkerPath(id))}; docker stop ${hosts.shq(fleet.containerFor(id))} >/dev/null 2>&1; true`,
    { timeout: 40000 },
  );
}

async function backupConfigs(label) {
  const name = `${ts()}${label ? "-" + label.replace(/[^a-z0-9-]/gi, "") : ""}.tgz`;
  const file = BACKUP_DIR + "/" + name;
  await fleet.sh(
    `mkdir -p ${hosts.shq(BACKUP_DIR)} && cd ${hosts.shq(fleet.BASE)} && ` +
      `tar czf ${hosts.shq(file)} bots/*/Configuration/config.json $(ls -d bots/*/.[a-z]* 2>/dev/null) && ` +
      `chmod 600 ${hosts.shq(file)} && ` +
      `ls -1t ${hosts.shq(BACKUP_DIR)}/*.tgz | tail -n +${BACKUPS_KEPT + 1} | xargs -r rm -f`,
    { timeout: 60000 },
  );
  return file;
}

// The database remembers which bot an account is in. Spends find accounts by
// token now, but the ledger, the holdings snapshot and the old bot records are
// read by the pages and by people, so they follow the account.
async function syncPointers(moved) {
  if (!moved.length) return { ledger: 0, holdings: 0, botAccounts: 0 };
  const AvailableAccount = require("../models/AvailableAccount");
  const UnclaimedAccount = require("../models/UnclaimedAccount");
  const NoclaimHolding = require("../models/NoclaimHolding");
  const BotAccount = require("../models/BotAccount");
  const pools = await AvailableAccount.find(
    { clientSecret: { $in: moved.map((m) => m.secret) } },
    { clientSecret: 1 },
  ).lean();
  const poolBy = new Map(pools.map((p) => [String(p.clientSecret), String(p._id)]));
  const ledgerW = [];
  const holdW = [];
  const botW = [];
  for (const m of moved) {
    const container = fleet.containerFor(m.to);
    const pid = poolBy.get(m.secret);
    if (pid)
      ledgerW.push({
        updateMany: {
          filter: { source: "noclaim", poolAccountId: pid, status: { $nin: ["sold", "removed"] } },
          update: { $set: { botId: m.to, container } },
        },
      });
    if (m.login)
      holdW.push({
        updateOne: {
          filter: { loginLower: m.login.toLowerCase() },
          update: { $set: { botId: m.to, container } },
        },
      });
    botW.push({
      updateMany: {
        filter: { clientSecret: m.secret, host: fleet.HOST_ID, container: fleet.containerFor(m.from) },
        update: { $set: { container } },
      },
    });
  }
  const n = (r) => (r && (r.modifiedCount || r.nModified)) || 0;
  const [a, b, c] = await Promise.all([
    ledgerW.length ? UnclaimedAccount.bulkWrite(ledgerW, { ordered: false }) : null,
    holdW.length ? NoclaimHolding.bulkWrite(holdW, { ordered: false }) : null,
    botW.length ? BotAccount.bulkWrite(botW, { ordered: false }) : null,
  ]);
  return { ledger: n(a), holdings: n(b), botAccounts: n(c) };
}

// Carry out one game's plan against the live configs. Returns what happened.
async function applyGame(plan, snap, log) {
  const res = { key: plan.key, label: plan.label, moved: 0, created: [], retired: [], parked: [], restarted: [], errors: [], movedList: [] };
  const byId = new Map(snap.bots.map((b) => [b.id, b]));

  // 0. Fresh membership: only accounts still in the bot the plan read them in,
  //    and still switched on, move.
  const sources = [...new Set(plan.moves.map((m) => m.from))];
  const fresh = new Map();
  for (const id of sources) fresh.set(id, usersIn(await readConfig(id)));
  const entryOf = new Map();
  const moves = [];
  for (const m of plan.moves) {
    const e = (fresh.get(m.from) || []).find((u) => secretOf(u) === m.secret && isEnabled(u));
    if (!e) continue;
    entryOf.set(m.secret, e);
    moves.push(m);
  }
  const skippedGone = plan.moves.length - moves.length;
  if (skippedGone) log(`${plan.label}: ${skippedGone} account(s) left their bot since the plan — not moved`);

  // 1. New bots first, with their accounts (nothing removed anywhere yet).
  const newId = new Map();
  const template = (() => {
    const t = plan.keep.map((id) => byId.get(id)).find((b) => b && b.cfg);
    return t ? t.cfg : null;
  })();
  for (const slot of [...new Set(moves.filter((m) => m.to.startsWith("new")).map((m) => m.to))]) {
    const mine = moves.filter((m) => m.to === slot);
    try {
      if (!snap.image) throw new Error("the no-claim image is missing on the host");
      if (!template) throw new Error("no sibling bot to copy the config from");
      const gate = await fleet.newContainerGate();
      if (!gate.ok) throw new Error(gate.reason);
      const id = await buildBot(template, mine.map((m) => entryOf.get(m.secret)));
      newId.set(slot, id);
      res.created.push(id);
      log(`${plan.label}: built bot ${id} (${mine.length} accounts, parked until its game is live)`);
    } catch (e) {
      res.errors.push(`new bot: ${e.message}`);
    }
  }
  const dest = (m) => (m.to.startsWith("new") ? newId.get(m.to) : m.to);

  // 2. Add to existing bots.
  const landed = new Map(); // secret -> bot id it is now in (besides its old one)
  for (const m of moves) if (m.to.startsWith("new") && newId.has(m.to)) landed.set(m.secret, newId.get(m.to));
  const toExisting = new Map();
  for (const m of moves) {
    if (m.to.startsWith("new")) continue;
    if (!toExisting.has(m.to)) toExisting.set(m.to, []);
    toExisting.get(m.to).push(m);
  }
  for (const [id, ms] of toExisting) {
    try {
      const r = await addToBot(id, ms.map((m) => entryOf.get(m.secret)));
      for (const s of r.present) landed.set(s, id);
    } catch (e) {
      res.errors.push(`add to bot ${id}: ${e.message}`);
    }
  }

  // 3. Take out of the old bots only what landed somewhere else.
  const fromBot = new Map();
  for (const m of moves) {
    if (!landed.has(m.secret)) continue;
    if (!fromBot.has(m.from)) fromBot.set(m.from, []);
    fromBot.get(m.from).push(m.secret);
  }
  const undo = []; // [secret, botId it was added to] — must come back out
  for (const [id, secrets] of fromBot) {
    try {
      const r = await removeFromBot(id, secrets);
      const gone = new Set(r.removed);
      for (const s of secrets) {
        if (gone.has(s)) continue;
        // It left its old bot by itself (a sale's clean-up) after step 0: it
        // must not live on in the bot it was just added to.
        undo.push([s, landed.get(s)]);
      }
      for (const s of r.removed) {
        const m = moves.find((x) => x.secret === s);
        res.movedList.push({ secret: s, login: m ? m.login : "", from: id, to: landed.get(s) });
      }
    } catch (e) {
      res.errors.push(`remove from bot ${id}: ${e.message}`);
      // Unknown whether the write landed: put the copies back out of the new
      // bots so the account is in exactly its old bot again.
      for (const s of secrets) undo.push([s, landed.get(s)]);
    }
  }
  const undoBy = new Map();
  for (const [s, id] of undo) {
    if (!id) continue;
    if (!undoBy.has(id)) undoBy.set(id, []);
    undoBy.get(id).push(s);
  }
  for (const [id, secrets] of undoBy) {
    try {
      await removeFromBot(id, secrets);
      log(`${plan.label}: took ${secrets.length} account(s) back out of bot ${id} (left their old bot meanwhile, or its write failed)`);
    } catch (e) {
      res.errors.push(`UNDO on bot ${id} failed (${e.message}) — ${secrets.length} account(s) may be in two bots`);
    }
  }
  res.moved = res.movedList.length;
  // The one-home guard caches which accounts the no-claim configs hold.
  try {
    require("./fleetIntegrity").forget("noclaim");
  } catch {
    /* an older install without the guard */
  }

  // 4. Bots the plan empties.
  for (const id of plan.retire) {
    try {
      await retireBot(id);
      res.retired.push(id);
    } catch (e) {
      res.errors.push(`retire bot ${id}: ${e.message}`);
    }
  }
  for (const id of plan.park) {
    try {
      const left = usersIn(await readConfig(id));
      if (left.some(isEnabled)) throw new Error("still has enabled accounts");
      await parkBot(id);
      res.parked.push(id);
    } catch (e) {
      res.errors.push(`park bot ${id}: ${e.message}`);
    }
  }

  // 5. Restart running bots whose accounts changed: old bots first, so a login
  //    never runs in two containers at once. Parked bots are left parked.
  const changedFrom = [...fromBot.keys()].filter((id) => !plan.retire.includes(id) && !plan.park.includes(id));
  const changedTo = [...toExisting.keys()].filter((id) => !changedFrom.includes(id));
  for (const id of [...changedFrom, ...changedTo]) {
    const b = byId.get(id);
    if (!b || !b.running) continue;
    try {
      await restartIfRunning(id);
      res.restarted.push(id);
    } catch (e) {
      res.errors.push(`restart bot ${id}: ${e.message}`);
    }
  }
  return res;
}

// One organizer pass. `dryRun` (the default) only plans. `force` acts even
// with the switch off (the page's "Organize now"). `games` limits it to some
// game keys.
async function organize({ dryRun = true, force = false, actor = "organizer", games: only = null } = {}) {
  if (state.running) return { skipped: "already running" };
  state.running = true;
  const lines = [];
  const log = (s) => {
    lines.push(s);
    console.log("noclaimOrganizer: " + s);
  };
  try {
    const cfg = config();
    if (!dryRun && !force && !cfg.enabled) return { skipped: "off (autoFarm.noclaimOrganize.enabled)", config: cfg };
    const snap = await readSnapshot();
    const { games, skipped } = planFleet(snap, cfg);
    const summary = {
      at: new Date(),
      dryRun,
      actor,
      config: cfg,
      games: games.map((g) => ({
        key: g.key,
        label: g.label,
        accounts: g.accounts,
        bots: g.bots,
        activeBots: g.activeBots,
        needBots: g.needBots,
        due: g.due,
        held: g.held || "",
        reasons: g.reasons,
        moves: g.moves.length,
        create: g.create,
        retire: g.retire,
        park: g.park,
        after: g.after,
        running: g.running,
      })),
      skipped,
      results: [],
      errors: [],
    };
    if (snap.dupes.length) {
      summary.blocked = `an account is in two bots already (${snap.dupes.slice(0, 3).join("; ")}) — fix that first`;
      return summary;
    }
    // The plans carry login tokens: they never leave this module.
    if (dryRun) return summary;
    if (snap.provisioning) return { ...summary, skipped: "a bot is being built right now — next pass" };
    const todo = games.filter((g) => g.due && !g.held && (!only || only.includes(g.key)));
    if (!todo.length) {
      state.lastRun = new Date();
      state.lastResult = { ...summary, acted: false };
      return state.lastResult;
    }
    summary.backup = await backupConfigs("organize");
    log(`backup ${summary.backup}`);
    const allMoved = [];
    for (const g of todo) {
      log(`${g.label}: ${g.activeBots} bot(s) → ${g.needBots}, ${g.moves.length} move(s) (${g.reasons.join("; ")})`);
      try {
        const r = await applyGame(g, snap, log);
        summary.results.push(r);
        allMoved.push(...r.movedList);
        summary.errors.push(...r.errors.map((e) => `${g.label}: ${e}`));
      } catch (e) {
        summary.errors.push(`${g.label}: ${e.message}`);
      }
    }
    try {
      summary.pointers = await syncPointers(allMoved);
    } catch (e) {
      summary.errors.push("database pointers: " + e.message);
    }
    summary.acted = true;
    summary.moved = allMoved.length;
    summary.log = lines;
    for (const r of summary.results) delete r.movedList;
    state.lastRun = new Date();
    state.lastResult = summary;
    state.lastError = summary.errors.length ? summary.errors[0] : "";

    const line = summary.results
      .map(
        (r) =>
          `${r.label}: ${r.moved} moved` +
          (r.created.length ? `, new bot ${r.created.join(",")}` : "") +
          (r.retired.length ? `, retired ${r.retired.join(",")}` : "") +
          (r.parked.length ? `, parked ${r.parked.join(",")}` : ""),
      )
      .join(" | ");
    logEvent({
      category: "noclaim",
      action: "fleet_organized",
      actor,
      count: summary.moved,
      detail: `organized no-claim bots to ≤${cfg.size}/bot — ${line}` + (summary.errors.length ? ` — ${summary.errors.length} error(s)` : ""),
      meta: { results: summary.results, errors: summary.errors, backup: summary.backup },
    });
    try {
      require("./telegram").sendTelegram(
        `🧹 No-claim bots organized (≤${cfg.size} per bot)\n\n` +
          summary.results
            .map((r) => {
              const g = todo.find((x) => x.key === r.key);
              return `${r.label}: ${g ? g.activeBots : "?"} → ${g ? g.needBots : "?"} bots, ${r.moved} moved`;
            })
            .join("\n") +
          (summary.errors.length ? `\n⚠️ ${summary.errors.length} error(s): ${summary.errors[0]}` : ""),
      );
    } catch {
      /* best effort */
    }
    return summary;
  } catch (e) {
    state.lastError = e.message || String(e);
    console.error("noclaimOrganizer:", state.lastError);
    return { error: state.lastError };
  } finally {
    state.running = false;
  }
}

// The hourly hook (called at the end of each allocator pass). Acts only when
// the switch is on; a game with nothing due costs one fleet read and no write.
async function runAuto() {
  const cfg = config();
  if (!cfg.enabled) return { skipped: "off" };
  const r = await organize({ dryRun: false, actor: "organizer" });
  if (r && r.acted === false) state.lastResult = { ...r, acted: false };
  return r;
}

function status() {
  return {
    config: config(),
    running: state.running,
    lastRun: state.lastRun,
    lastError: state.lastError,
    lastResult: state.lastResult,
  };
}

module.exports = {
  DEFAULTS,
  config,
  botCap,
  planGame,
  planFleet,
  readSnapshot,
  organize,
  runAuto,
  status,
};
