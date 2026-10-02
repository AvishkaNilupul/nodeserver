// The no-claim farm's bot machinery, as a service.
//
// WHY THIS EXISTS
//
// All of this lived inside routes/noclaimFarmRoutes.js, reachable only by an
// operator submitting an HTML form. The fleet allocator (utils/
// unclaimedAllocator.js) needs the same primitives — claim from the pool, write
// a bot config, start a container, add accounts to a bot that already exists —
// and the project's standing rule is IMPORT, NEVER REIMPLEMENT: a second copy
// of the claim path would drift from the first and reintroduce the bugs the
// first one has already paid for (the reserve guard, the rollback on failure,
// the soldGames exclusion, the config permissions).
//
// So the machinery moved here and the route became a caller. Nothing about its
// behaviour changed in the move.
//
// TWO PERMISSION RULES THAT LOOK LIKE TYPOS AND ARE NOT
//
//   * No-claim configs are chmod 600. These containers run `--user 0:0` (root),
//     so 600 is readable to them. The MANAGED bots are the opposite — they run
//     as a non-root uid and a 600 config makes them exit 139 — so never copy a
//     chmod between the two systems.
//   * Configs are written by a GUARDED `cat > tmp && mv` (botHosts.
//     guardedWriteScript: the temp file is installed only when it holds every
//     byte sent), never by string concatenation. A bad concat once left a
//     duplicated JSON tail on config_04, which .NET read as "Extra data", and
//     90 accounts sat idle for five days.

const hosts = require("./botHosts");
const settings = require("./settings");
const AvailableAccount = require("../models/AvailableAccount");
const { recordPoolUsage } = require("./poolUsageLog");
const { withFileLock } = require("./fileLock");

// --- Sandbox constants (all on the Pi, separate from the managed bot dir) ----
const HOST_ID = "contabo";
const BASE = "/home/ubuntu/twitchbot-noclaim";
const SRC_DIR = BASE + "/src";
const BOTS_DIR = BASE + "/bots"; // bots/<id>/Configuration/config.json + logs
const IMAGE = "twitchbot-noclaim:latest";
const CONTAINER_PREFIX = "noclaim-bot-";
const REPO = "https://github.com/AvishkaNilupul/TwitchDropsBot.git";
const BRANCH = "noclaim-test";
const CLAIM_NOTE_PREFIX = "noclaim-farm";

// The create form's own clamp, kept here so the allocator and the route cannot
// disagree about how big one bot may get.
const MAX_PER_BOT = 70;

function pi() {
  const host = hosts.resolveHost(HOST_ID);
  if (!host) {
    const e = new Error(`Pi host "${HOST_ID}" is not configured.`);
    e.status = 503;
    throw e;
  }
  return host;
}

async function sh(script, { timeout = 30000, input } = {}) {
  try {
    const { stdout } = await hosts.runShell(pi(), script, { timeout, input });
    return (stdout || "").trim();
  } catch (err) {
    if (err && err.unreachable) {
      const e = new Error("Raspberry Pi is unreachable over SSH.");
      e.status = 503;
      throw e;
    }
    throw err;
  }
}

const containerFor = (id) => CONTAINER_PREFIX + id;
const botDir = (id) => BOTS_DIR + "/" + id;
const configPath = (id) => botDir(id) + "/Configuration/config.json";
// Markers the auto-power watcher (utils/noclaimWatcher.js) reads. `.autostopped`
// = the watcher parked this bot on a dark game (resume when live). `.operatoroff`
// = the operator hit Stop (stay off until Restart/Create). Restart / Create
// clear BOTH so manual control always wins.
const markerPath = (id) => botDir(id) + "/.autostopped";
const operatorMarkerPath = (id) => botDir(id) + "/.operatoroff";
// `.personal` = the operator's OWN bot. Purely a label the console reads to show
// it in the "My own" section (and the add-by-username path fences its account
// from the auto-lister with manualSold). The watcher and containers ignore it,
// and it is independent of the two auto-power markers above.
const personalMarkerPath = (id) => botDir(id) + "/.personal";

// One TwitchUsers entry from a pool account doc. `Id` MUST be the real numeric
// Twitch user id — WatchRequest.GetPayload does Int32.Parse on it, so a
// placeholder throws a FormatException on every watch and the container stays
// up while never accumulating a minute.
function userEntry(a, games) {
  return {
    Login: a.username || "",
    Id: String(a.twitchId || ""),
    ClientSecret: a.clientSecret || "",
    Enabled: true,
    FavouriteGames: games,
  };
}

// Build one bot's config.json from a set of pool account docs.
function buildConfig(accounts, game) {
  const games = game ? [game] : [];
  return JSON.stringify(
    {
      TwitchSettings: {
        TwitchUsers: accounts.map((a) => userEntry(a, games)),
        OnlyFavouriteGames: games.length > 0,
        OnlyConnectedAccounts: false,
        ClaimDrops: false, // the whole point
      },
      FavouriteGames: games,
      WatchBrowserHeadless: true,
      WaitingSeconds: 300,
      AttemptToWatch: 5,
    },
    null,
    2,
  );
}

// Accounts recycled back to the pool carry soldGames (the canonical game they
// were spent on). Never re-claim one whose spent game matches the keyword the
// operator is creating a bot for — substring semantics like isNoClaimGame, so
// "rainbow six" also matches a soldGames entry of "rainbow six siege".
function soldGameExclusion(game) {
  const g = settings.normGameName(game);
  if (!g) return {};
  const esc = g.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ +/g, "\\s+");
  return { soldGames: { $not: { $regex: esc } } };
}

// Ready pool query — mirrors the auto-farmer's definition so the two systems
// agree on what "ready" means (verified token, available, not suspended). When
// a game is given, accounts already spent for that game are excluded.
function readyPoolQuery(game) {
  const q = {
    status: "available",
    clientSecret: { $gt: "" },
    lastCheckStatus: { $in: ["", "ok"] },
    // An account the operator handed to a buyer by hand is NOT supply: it must
    // never be claimed into a new bot, farmed again and re-listed, or the same
    // login goes out twice.
    manualSold: { $ne: true },
  };
  Object.assign(q, soldGameExclusion(game));
  return q;
}

// A no-claim bot may only ever be built for a game on `noClaimGames`. Nothing
// enforced this before: a typo'd or arbitrary game name built a container that
// farmed a game the auto-farmer ALSO farms, so the two systems would fight over
// the same campaign — the one thing the no-claim split exists to prevent.
function assertNoClaimGame(game) {
  const g = String(game || "").trim();
  if (!g) {
    const e = new Error("Pick a game.");
    e.status = 400;
    throw e;
  }
  if (!settings.isNoClaimGame(g)) {
    const e = new Error(
      `"${g}" is not a no-claim game. Add it to the no-claim list first, or the auto-farmer will farm it too.`,
    );
    e.status = 400;
    throw e;
  }
  return g;
}

// How many accounts this system may claim right now without drawing the shared
// pool below the auto-farm's reserve. Returns { ready, reserve, spendable }.
async function spendable(game) {
  const reserve = Math.max(0, Number(settings.getAutoFarm().poolReserve) || 0);
  const ready = await AvailableAccount.countDocuments(readyPoolQuery(game));
  return { ready, reserve, spendable: Math.max(0, ready - reserve) };
}

// Claim up to `count` ready pool accounts for `game`, one atomic
// findOneAndUpdate each so two callers can never be handed the same row. Returns
// the claimed docs — possibly fewer than asked for, possibly none.
//
// The caller owns the rollback: a partial claim that then fails to reach a bot
// config would strand accounts out of the pool forever, so every caller here
// wraps this in a try/catch that releases what it claimed. `release()` below is
// that path.
async function claimForGame(game, count, { actor = "noclaim" } = {}) {
  const note = `${CLAIM_NOTE_PREFIX}:${game}`;
  const claimed = [];
  for (let i = 0; i < count; i++) {
    const doc = await AvailableAccount.findOneAndUpdate(
      readyPoolQuery(game),
      { $set: { status: "claimed", claimedAt: new Date(), claimedNote: note } },
      { returnDocument: "after", sort: { lastCheckAt: -1 } },
    );
    if (!doc) break;
    claimed.push(doc);
    await recordPoolUsage(doc._id, { event: "claimed", actor, game, note });
  }
  return claimed;
}

// Put claimed rows back. Only rows STILL in "claimed" are logged as released, so
// a row another worker has already moved on is not double-counted.
async function release(docs, { actor = "noclaim" } = {}) {
  const ids = (docs || []).map((d) => d && d._id).filter(Boolean);
  if (!ids.length) return 0;
  const still = await AvailableAccount.find(
    { _id: { $in: ids }, status: "claimed" },
    { _id: 1 },
  ).lean();
  const r = await AvailableAccount.updateMany(
    { _id: { $in: ids } },
    { $set: { status: "available", claimedAt: null, claimedNote: "" } },
  ).catch(() => null);
  if (r && (r.modifiedCount || r.nModified)) {
    await recordPoolUsage(
      still.map((d) => d._id),
      { event: "released", actor },
    );
  }
  return still.length;
}

// --- Fleet read -------------------------------------------------------------

// Every no-claim bot: id, the game its config farms, how many accounts it holds,
// and its container state — in ONE SSH round trip. The Pi's link is seconds of
// RTT, so this is deliberately a single batched script rather than a read loop.
//
// The game is parsed by FLATTENING the config first. buildConfig pretty-prints,
// so the `[` and the `"Overwatch"` sit on different lines and a single-line sed
// never matches — which is exactly the bug that made every bot show a blank game
// label until 2026-08-25.
async function readFleet({ timeout = 25000 } = {}) {
  const script =
    `prov=no; [ -f ${hosts.shq(BASE + "/.provisioning")} ] && prov=yes; echo "prov=$prov"; ` +
    `img=no; docker image inspect ${hosts.shq(IMAGE)} >/dev/null 2>&1 && img=yes; echo "img=$img"; ` +
    `echo "PS_START"; docker ps -a --filter name=^/${CONTAINER_PREFIX} --format '{{.Names}}|{{.State}}|{{.Status}}' 2>/dev/null; echo "PS_END"; ` +
    `echo "BOTS_START"; for d in ${hosts.shq(BOTS_DIR)}/*/Configuration/config.json; do [ -f "$d" ] || continue; ` +
    `id=$(basename $(dirname $(dirname "$d"))); ` +
    `game=$(tr -d '\\n' < "$d" | sed -n 's/.*"FavouriteGames"[^[]*\\[[^"]*"\\([^"]*\\)".*/\\1/p'); ` +
    `n=$(grep -c '"ClientSecret"' "$d"); ` +
    `echo "$id|$game|$n"; done; echo "BOTS_END"`;
  const out = await sh(script, { timeout });

  let section = "";
  let provisioning = false;
  let imageBuilt = false;
  const psMap = {};
  const bots = [];
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (line === "PS_START") { section = "ps"; continue; }
    if (line === "PS_END") { section = ""; continue; }
    if (line === "BOTS_START") { section = "bots"; continue; }
    if (line === "BOTS_END") { section = ""; continue; }
    if (line.startsWith("prov=")) { provisioning = line.slice(5) === "yes"; continue; }
    if (line.startsWith("img=")) { imageBuilt = line.slice(4) === "yes"; continue; }
    if (section === "ps" && line) {
      const [name, state, status] = line.split("|");
      psMap[name.replace(CONTAINER_PREFIX, "")] = { state, status };
    } else if (section === "bots" && line) {
      const [id, game, n] = line.split("|");
      bots.push({ id, game: game || "", accounts: parseInt(n, 10) || 0 });
    }
  }
  for (const b of bots) {
    const ps = psMap[b.id];
    b.containerState = ps ? ps.state : "none";
    b.containerStatus = ps ? ps.status : "";
    b.running = ps ? ps.state === "running" : false;
  }
  bots.sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
  return { provisioning, imageBuilt, bots };
}

// --- Writes -----------------------------------------------------------------

// Is a build/provision already in flight? Two concurrent provisions would fight
// over the same source checkout and image tag, so every create waits its turn.
async function provisionBusy() {
  const busy = await sh(
    `[ -f ${hosts.shq(BASE + "/.provisioning")} ] && echo busy || echo free`,
    { timeout: 15000 },
  );
  return busy === "busy";
}

// Next free numeric bot id. Empty leftover directories count, deliberately: an
// id whose directory still exists is not free, whatever is inside it.
async function nextBotId() {
  const raw = await sh(`ls -1 ${hosts.shq(BOTS_DIR)} 2>/dev/null || true`, {
    timeout: 15000,
  });
  const used = raw
    .split("\n")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  return String((used.length ? Math.max(...used) : 0) + 1);
}

// The one container shape every no-claim bot runs with — shared by create and
// the image rollout, so a recreated bot is indistinguishable from a new one.
// Root (the bot writes its mounted config back), INSIDE_DOCKER + the
// /app/Configuration mount (they must agree or the bot spins on "no users
// found"), capped json-file logs (a 186 GB runaway log once filled the host).
function containerRunArgs(id, image = IMAGE) {
  return (
    `--name ${hosts.shq(containerFor(id))} --restart unless-stopped --log-opt max-size=10m --log-opt max-file=3 --user 0:0 ` +
    `-e INSIDE_DOCKER=true -v ${hosts.shq(botDir(id) + "/Configuration")}:/app/Configuration ` +
    `-v ${hosts.shq(botDir(id) + "/logs")}:/app/logs ${hosts.shq(image)}`
  );
}

// Create a bot from already-claimed accounts: write its config, then detach the
// clone/build/run script behind the provisioning lock.
//
// Claiming is NOT done here. The caller claims first and owns the rollback,
// because a create that fails after claiming must return the accounts and only
// the caller knows which ones it claimed.
async function createBotFromAccounts(id, accounts, game) {
  assertNoClaimGame(game);
  const config = buildConfig(accounts, game);
  // Guarded write (utils/botHosts.guardedWriteScript): a cut-off transfer is
  // never installed as the bot's config, and the file is 600 from the start.
  await sh(
    hosts.guardedWriteScript(configPath(id), hosts.byteLength(config), {
      mode: "600",
      mkdirs: [botDir(id) + "/Configuration", botDir(id) + "/logs"],
    }),
    { timeout: 20000, input: config },
  );

  const provision = [
    "set -e",
    `touch ${hosts.shq(BASE + "/.provisioning")}`,
    // `game` reaches here from a request body on the route path, so it is shell
    // QUOTED, not interpolated. The original inline version wrote it raw into a
    // double-quoted echo that is then embedded in a nested `sh -c`, where a
    // backtick or $( ) in a game name would execute on the Pi as root.
    `echo ${hosts.shq(`[bot ${id}] ${accounts.length} account(s), game=${game}`)}`,
    `if [ -d ${hosts.shq(SRC_DIR + "/.git")} ]; then cd ${hosts.shq(SRC_DIR)} && git fetch --depth 1 origin ${BRANCH} && git checkout -f ${BRANCH} && git reset --hard origin/${BRANCH}; else rm -rf ${hosts.shq(SRC_DIR)} && git clone --depth 1 -b ${BRANCH} ${hosts.shq(REPO)} ${hosts.shq(SRC_DIR)}; fi`,
    `if ! docker image inspect ${hosts.shq(IMAGE)} >/dev/null 2>&1; then cd ${hosts.shq(SRC_DIR)} && docker build -f TwitchDropsBot.Console/Dockerfile -t ${hosts.shq(IMAGE)} .; fi`,
    `docker rm -f ${hosts.shq(containerFor(id))} >/dev/null 2>&1 || true`,
    `docker run -d ${containerRunArgs(id, IMAGE)}`,
    `echo "[$(date -u +%FT%TZ)] bot ${id} started"`,
  ].join(" && ");
  const wrapped = `( { ${provision} ; } > ${hosts.shq(BASE + "/provision.log")} 2>&1; rm -f ${hosts.shq(BASE + "/.provisioning")} )`;
  await sh(
    `mkdir -p ${hosts.shq(BASE)}; setsid sh -c ${hosts.shq(wrapped)} >/dev/null 2>&1 < /dev/null &`,
    { timeout: 20000 },
  );
  return id;
}

// Create one no-claim bot end to end: validate, guard the pool reserve and the
// provisioning lock, claim, write the config, start the container.
//
// The rollback is the whole reason this is one function. A create that claims 50
// accounts and then fails to reach the Pi would strand all 50 out of the pool
// with no owner and no way to find them but their note — so every exit after the
// claim returns them.
async function createBot({ game, count, actor = "noclaim" } = {}) {
  const g = assertNoClaimGame(game);
  const want = Math.max(1, Math.min(MAX_PER_BOT, Math.floor(Number(count) || 0)));

  const supply = await spendable(g);
  if (supply.ready - want < supply.reserve) {
    const e = new Error(
      `Only ${supply.spendable} account(s) spendable (${supply.ready} ready, reserve ${supply.reserve}). Lower the count.`,
    );
    e.status = 409;
    throw e;
  }
  if (await provisionBusy()) {
    const e = new Error("A build/provision is already running. Try again shortly.");
    e.status = 409;
    throw e;
  }

  let claimed = [];
  try {
    claimed = await claimForGame(g, want, { actor });
    if (!claimed.length) {
      const e = new Error("No ready pool accounts to claim.");
      e.status = 409;
      throw e;
    }
    const id = await nextBotId();
    await createBotFromAccounts(id, claimed, g);
    return { id, claimed: claimed.length, game: g };
  } catch (err) {
    await release(claimed, { actor }).catch(() => {});
    throw err;
  }
}

// Add already-claimed accounts to an EXISTING bot's config.
//
// This is the capability the system did not have: the only way to give a game
// more accounts was to create another container, and containers are the scarce
// resource (~130MB of Pi RAM each). Topping a bot from 20 to 50 costs nothing.
//
// Done as read -> parse -> append -> write, under the per-file lock, because two
// concurrent top-ups on the same config would both read the old contents and the
// second write would silently drop the first one's accounts.
//
// Accounts already present (by ClientSecret) are skipped rather than duplicated:
// the same login twice in one config is a dupeGuard violation that makes the bot
// fight itself for the session.
async function topUpBot(id, accounts, game, { restart = true } = {}) {
  const host = pi();
  const file = configPath(id);
  return withFileLock(host, file, async () => {
    const raw = await sh(`cat ${hosts.shq(file)}`, { timeout: 20000 });
    let cfg;
    try {
      cfg = JSON.parse(raw);
    } catch (e) {
      const err = new Error(
        `bot ${id} config is not valid JSON (${e.message}) — refusing to append`,
      );
      err.status = 409;
      throw err;
    }
    const ts = cfg.TwitchSettings || (cfg.TwitchSettings = {});
    const users = Array.isArray(ts.TwitchUsers) ? ts.TwitchUsers : (ts.TwitchUsers = []);
    const have = new Set(users.map((u) => String((u && u.ClientSecret) || "")).filter(Boolean));
    // Farm the game the CONFIG already declares, not the caller's label: a
    // bot's own FavouriteGames is what its container is actually watching, and a
    // mismatched per-user list would quietly farm nothing.
    const games = Array.isArray(cfg.FavouriteGames) && cfg.FavouriteGames.length
      ? cfg.FavouriteGames
      : game
        ? [game]
        : [];
    let added = 0;
    for (const a of accounts) {
      const secret = String(a.clientSecret || "");
      if (!secret || have.has(secret)) continue;
      users.push(userEntry(a, games));
      have.add(secret);
      added++;
    }
    if (!added) return { added: 0, total: users.length };

    const text = JSON.stringify(cfg, null, 2);
    await sh(hosts.guardedWriteScript(file, hosts.byteLength(text), { mode: "600" }), {
      timeout: 20000,
      input: text,
    });
    // Bots read their config at STARTUP only, so a restart is what makes the new
    // accounts farm. `docker restart` on a stopped container starts it — which
    // would fight the auto-power watcher's park — so only restart one that is
    // already running and let the watcher wake a parked bot on its own schedule.
    if (restart) {
      await sh(
        `if [ "$(docker inspect -f '{{.State.Running}}' ${hosts.shq(containerFor(id))} 2>/dev/null)" = "true" ]; ` +
          `then docker restart ${hosts.shq(containerFor(id))} >/dev/null 2>&1 || true; fi`,
        { timeout: 60000 },
      );
    }
    return { added, total: users.length };
  });
}

// --- Personal ("my own") bots ----------------------------------------------

// Flag / unflag a bot as the operator's personal one (a `.personal` marker file,
// the same mechanism as the auto-power markers). The console lists personal bots
// in their own section; nothing in the farming path depends on it.
async function setPersonal(id, on) {
  const p = personalMarkerPath(id);
  if (on)
    await sh(`mkdir -p ${hosts.shq(botDir(id))} && touch ${hosts.shq(p)}`, {
      timeout: 15000,
    });
  else await sh(`rm -f ${hosts.shq(p)}`, { timeout: 15000 });
  return !!on;
}

// Which no-claim bot config(s), if any, already hold this ClientSecret. The same
// token in two configs makes the login fight itself for the Twitch session (a
// dupeGuard violation), so the add-by-username path checks this before writing a
// new config. Best-effort: a config that will not parse is skipped, exactly like
// the dupe scan in scripts/noclaim-readd-sold-batch.js.
async function findSecretInConfigs(secret) {
  const s = String(secret || "");
  if (!s) return [];
  const { bots } = await readFleet();
  const ids = bots.map((b) => b.id).filter(Boolean);
  if (!ids.length) return [];
  const script = ids
    .map(
      (id) =>
        `echo "__CFG__${id}__"; cat ${hosts.shq(configPath(id))} 2>/dev/null || true`,
    )
    .join("; ");
  const out = await sh(script, { timeout: 45000 });
  const found = [];
  for (const chunk of out.split("__CFG__")) {
    const m = chunk.match(/^([0-9]+)__/);
    if (!m) continue;
    let cfg;
    try {
      cfg = JSON.parse(chunk.slice(m[0].length).trim());
    } catch {
      continue;
    }
    for (const u of (cfg.TwitchSettings && cfg.TwitchSettings.TwitchUsers) || [])
      if (u && String(u.ClientSecret) === s) {
        found.push(m[1]);
        break;
      }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Rolling a new bot build out to the whole no-claim fleet
// ---------------------------------------------------------------------------
// createBotFromAccounts only builds the image when it is MISSING, and the Bots
// page rollout (utils/botUpdater.js) only ever touches twitchbot-farm — so a
// fix pushed to the fork never reached a no-claim bot that already existed.
// 2026-09-29 is the case in point: the GQL shape break that stopped a whole
// auto-farm task was latent in every no-claim bot too. This is that path:
//   1. fetch `ref` of the fork into SRC_DIR, build twitchbot-noclaim:<ref>;
//   2. sanity-test it on a COPY of a stopped bot's config (never a second
//      login of a running account) and require the no-claim guard's own log
//      line — an image that would CLAIM must never reach this fleet: it would
//      spend the drops every listing sells as unclaimed;
//   3. keep the current :latest as twitchbot-noclaim:pre-<stamp>, promote;
//   4. recreate every noclaim-bot-* with containerRunArgs — stopped bots with
//      `docker create` (they stay stopped: the .autostopped/.operatoroff/
//      .finished markers are files and survive, a never-run container exits 0,
//      which hostWatchdog leaves alone), then running bots one at a time with a
//      health check; the first failure puts :latest back on that bot and stops.
// Holds the .provisioning lock throughout, so no create/top-up interleaves.
const NOCLAIM_GUARD_LINE = "ClaimDrops is disabled";
const ROLLOUT_GOOD =
  /\[TwitchUser - [^\]]+\] (?:Checking "|Current drop campaign|Waiting \d+ seconds|No campaign found|No broadcaster|Campaign ")/;
const ROLLOUT_BAD = /no users? found|unhandled exception|fatal error|failed to start|Progress: \d+\/\d+ minutes/i;
const ROLLOUT_TEST_CONTAINER = "noclaim-rollout-test";
const ROLLOUT_BUILD_TIMEOUT_MS = 25 * 60 * 1000;
const ROLLOUT_TEST_WINDOW_MS = 120 * 1000;
const ROLLOUT_TEST_POLL_MS = 10 * 1000;
const ROLLOUT_SETTLE_POLLS = 12;
const ROLLOUT_SETTLE_POLL_MS = 5 * 1000;

function validRolloutRef(ref) {
  return /^[A-Za-z0-9._/-]{1,200}$/.test(String(ref || "")) && !String(ref).includes("..");
}

function rolloutImageTag(ref) {
  return "twitchbot-noclaim:" + String(ref).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 100);
}

// What a healthy, still-no-claim bot has logged since it started.
function rolloutLogVerdict(logText) {
  const text = String(logText || "");
  if (ROLLOUT_BAD.test(text)) return "bad";
  if (ROLLOUT_GOOD.test(text) && text.includes(NOCLAIM_GUARD_LINE)) return "ok";
  return "pending";
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function rolloutImage({ ref = BRANCH, dryRun = false, log = () => {}, timing = {} } = {}) {
  const t = {
    testWindowMs: ROLLOUT_TEST_WINDOW_MS,
    testPollMs: ROLLOUT_TEST_POLL_MS,
    settlePolls: ROLLOUT_SETTLE_POLLS,
    settlePollMs: ROLLOUT_SETTLE_POLL_MS,
    ...timing,
  };
  if (!validRolloutRef(ref)) throw httpError(400, "ref must be a branch, tag or commit name");
  if (await provisionBusy()) {
    throw httpError(409, "A no-claim build/provision is already running — try again when it finishes.");
  }
  const shq = hosts.shq;
  const newImage = rolloutImageTag(ref);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13).toLowerCase();
  const backup = "twitchbot-noclaim:pre-" + stamp;
  const lock = shq(BASE + "/.provisioning");
  const testDir = BASE + "/.rollout-test";
  const result = { ref, image: newImage, backup: null, testedOn: null, recreated: [], created: [], skipped: [] };
  await sh(`mkdir -p ${shq(BASE)} && touch ${lock}`, { timeout: 15000 });
  try {
    // 1. Source + build. Same checkout the create path uses.
    log(`fetching ${REPO} @ ${ref} and building ${newImage}`);
    result.imageId = await sh(
      `if [ -d ${shq(SRC_DIR + "/.git")} ]; then cd ${shq(SRC_DIR)} && git remote set-url origin ${shq(REPO)}; ` +
        `else rm -rf ${shq(SRC_DIR)} && git init -q ${shq(SRC_DIR)} && cd ${shq(SRC_DIR)} && git remote add origin ${shq(REPO)}; fi && ` +
        `git fetch -q --force origin ${shq(ref)} && git checkout -q --force FETCH_HEAD && git reset -q --hard FETCH_HEAD && ` +
        `docker build -q -f TwitchDropsBot.Console/Dockerfile -t ${shq(newImage)} . >/dev/null && ` +
        `docker image inspect -f '{{.Id}}' ${shq(newImage)}`,
      { timeout: ROLLOUT_BUILD_TIMEOUT_MS },
    );
    log(`built ${newImage} = ${result.imageId.slice(7, 19)}`);

    // 2. Sanity test on a COPY of a stopped bot's config (no double login). With
    // every bot running, fall back to one account of a running bot's config.
    const picked = await sh(
      `for c in $(docker ps -a --filter name=^/${CONTAINER_PREFIX} --format '{{.Names}}|{{.State}}' | sort -t'|' -k2,2 | cut -d'|' -f1); do ` +
        `id=\${c#${CONTAINER_PREFIX}}; f=${shq(BOTS_DIR)}/"$id"/Configuration/config.json; ` +
        `st=$(docker inspect -f '{{.State.Status}}' "$c"); ` +
        `[ -f "$f" ] && python3 -c ${shq(
          "import json,sys\nd=json.load(open(sys.argv[1]))\nt=d.get('TwitchSettings') or {}\n" +
            "u=[x for x in t.get('TwitchUsers') or [] if isinstance(x,dict) and x.get('Enabled',True) is not False]\n" +
            "sys.exit(0 if u and t.get('ClaimDrops') is False else 1)",
        )} "$f" && { echo "$id|$st"; break; }; done`,
      { timeout: 60000 },
    );
    const [testId, testState] = picked.split("|");
    if (!testId) throw new Error("no no-claim bot config with accounts and ClaimDrops:false to test against");
    const trimToOne = testState === "running";
    result.testedOn = CONTAINER_PREFIX + testId + (trimToOne ? " (1 account — every bot was running)" : "");
    log(`sanity-testing on a copy of bot ${testId}'s config${trimToOne ? " (one account)" : ""}`);
    await sh(
      `docker rm -f ${ROLLOUT_TEST_CONTAINER} >/dev/null 2>&1; rm -rf ${shq(testDir)} && mkdir -p ${shq(testDir + "/Configuration")} && ` +
        `cp ${shq(configPath(testId))} ${shq(testDir + "/Configuration/config.json")} && chmod 600 ${shq(testDir + "/Configuration/config.json")}` +
        (trimToOne
          ? ` && python3 -c ${shq(
              "import json,sys\np=sys.argv[1]\nd=json.load(open(p))\nt=d['TwitchSettings']\n" +
                "u=[x for x in t['TwitchUsers'] if isinstance(x,dict) and x.get('Enabled',True) is not False][:1]\n" +
                "t['TwitchUsers']=u\njson.dump(d,open(p,'w'))",
            )} ${shq(testDir + "/Configuration/config.json")}`
          : "") +
        ` && docker run -d --name ${ROLLOUT_TEST_CONTAINER} --user 0:0 -e INSIDE_DOCKER=true --log-opt max-size=10m --log-opt max-file=1 ` +
        `-v ${shq(testDir + "/Configuration")}:/app/Configuration ${shq(newImage)} >/dev/null`,
      { timeout: 60000 },
    );
    let verdict = "pending";
    let testLogs = "";
    const deadline = Date.now() + t.testWindowMs;
    while (Date.now() < deadline && verdict === "pending") {
      await new Promise((r) => setTimeout(r, t.testPollMs));
      testLogs = await sh(`docker logs ${ROLLOUT_TEST_CONTAINER} 2>&1 | tail -n 400`, { timeout: 20000 }).catch(() => "");
      verdict = rolloutLogVerdict(testLogs);
    }
    await sh(`docker rm -f ${ROLLOUT_TEST_CONTAINER} >/dev/null 2>&1; rm -rf ${shq(testDir)}`, { timeout: 30000 }).catch(() => {});
    if (verdict !== "ok") {
      throw new Error(
        `sanity test failed (${verdict === "bad" ? "logged a known failure" : "no per-account loop and no-claim guard line within " + t.testWindowMs / 1000 + "s"}) — nothing live was touched. Last logs: ` +
          testLogs.slice(-400),
      );
    }
    log("sanity test passed: per-account loop running and the no-claim guard is active");
    if (dryRun) return { ...result, dryRun: true };

    // 3. Promote, keeping the current build for rollback.
    result.backup = await sh(
      `docker image inspect ${shq(IMAGE)} >/dev/null 2>&1 && docker tag ${shq(IMAGE)} ${shq(backup)} && echo ${shq(backup)} || true; ` +
        `docker tag ${shq(newImage)} ${shq(IMAGE)}`,
      { timeout: 30000 },
    ) || null;
    log(`promoted ${newImage} to ${IMAGE}` + (result.backup ? ` (previous kept as ${result.backup})` : ""));

    // 4. Recreate: stopped first (no live impact), then running one at a time.
    const rows = (await sh(`docker ps -a --filter name=^/${CONTAINER_PREFIX} --format '{{.Names}}|{{.State}}'`, { timeout: 30000 }))
      .split("\n")
      .map((l) => l.trim().split("|"))
      .filter(([name]) => new RegExp("^" + CONTAINER_PREFIX + "\\d+$").test(name || ""))
      .map(([name, state]) => ({ name, id: name.slice(CONTAINER_PREFIX.length), running: state === "running" }))
      .sort((a, b) => Number(a.running) - Number(b.running) || Number(a.id) - Number(b.id));
    for (const b of rows) {
      const hasDir = (await sh(`[ -f ${shq(configPath(b.id))} ] && echo yes || echo no`, { timeout: 15000 })) === "yes";
      if (!hasDir) {
        result.skipped.push(b.name + " (no config dir)");
        log(`skipped ${b.name}: no config at ${configPath(b.id)}`);
        continue;
      }
      if (!b.running) {
        await sh(`docker rm -f ${shq(b.name)} >/dev/null 2>&1; docker create ${containerRunArgs(b.id, IMAGE)} >/dev/null`, { timeout: 60000 });
        result.created.push(b.name);
        log(`${b.name} (stopped) rebuilt on the new image, still stopped`);
        continue;
      }
      const t0 = new Date().toISOString();
      await sh(
        `docker stop -t 20 ${shq(b.name)} >/dev/null 2>&1; docker rm -f ${shq(b.name)} >/dev/null 2>&1; docker run -d ${containerRunArgs(b.id, IMAGE)} >/dev/null`,
        { timeout: 90000 },
      );
      let v = "pending";
      let logs = "";
      for (let i = 0; i < t.settlePolls && v === "pending"; i++) {
        await new Promise((r) => setTimeout(r, t.settlePollMs));
        const out = await sh(
          `echo "RUNNING=$(docker inspect -f '{{.State.Running}}' ${shq(b.name)} 2>/dev/null)"; docker logs --since ${shq(t0)} ${shq(b.name)} 2>&1 | tail -n 400`,
          { timeout: 20000 },
        ).catch(() => "");
        logs = out;
        v = /RUNNING=true/.test(out) ? rolloutLogVerdict(out) : /RUNNING=false/.test(out) ? "bad" : "pending";
      }
      if (v !== "ok") {
        log(`${b.name} failed its check on the new image (${v}) — rolling it back and stopping`);
        if (result.backup) {
          await sh(
            `docker tag ${shq(result.backup)} ${shq(IMAGE)} && docker rm -f ${shq(b.name)} >/dev/null 2>&1; docker run -d ${containerRunArgs(b.id, IMAGE)} >/dev/null`,
            { timeout: 90000 },
          ).catch(() => {});
        }
        throw new Error(
          `${b.name} failed its post-update check (${v})` +
            (result.backup ? `; ${IMAGE} put back to ${result.backup} and ${b.name} recreated on it` : "") +
            `. Recreated before it: ${result.recreated.join(", ") || "none"}. Last logs: ` +
            logs.slice(-400),
        );
      }
      result.recreated.push(b.name);
      log(`${b.name} healthy on the new image (no-claim guard active)`);
    }
    return result;
  } finally {
    await sh(`rm -f ${lock}`, { timeout: 15000 }).catch(() => {});
  }
}

module.exports = {
  HOST_ID,
  BASE,
  SRC_DIR,
  BOTS_DIR,
  IMAGE,
  CONTAINER_PREFIX,
  REPO,
  BRANCH,
  CLAIM_NOTE_PREFIX,
  MAX_PER_BOT,
  pi,
  sh,
  assertNoClaimGame,
  containerFor,
  botDir,
  configPath,
  markerPath,
  operatorMarkerPath,
  personalMarkerPath,
  buildConfig,
  soldGameExclusion,
  readyPoolQuery,
  spendable,
  claimForGame,
  release,
  readFleet,
  provisionBusy,
  nextBotId,
  createBotFromAccounts,
  createBot,
  topUpBot,
  setPersonal,
  findSecretInConfigs,
  containerRunArgs,
  rolloutImage,
  rolloutImageTag,
  rolloutLogVerdict,
  validRolloutRef,
  NOCLAIM_GUARD_LINE,
};
