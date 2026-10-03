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
const UnclaimedAccount = require("../models/UnclaimedAccount");
const { recordPoolUsage } = require("./poolUsageLog");
const { withFileLock } = require("./fileLock");
const { logEvent } = require("./systemLog");

// The two shared guards of 2026-10-03 (docs/LIVE-FIXES-1003.md §2): the pristine
// reserve rent-farm orders draw on, and the host-RAM check on a new container.
// Required lazily, so a missing or broken helper fails the claim or the create
// that needed it — nothing spent — instead of the server's boot.
const pristineReserve = () => require("./pristineReserve");
const hostCapacity = () => require("./hostCapacity");

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

// What "claimed by this feeder" looks like on a pool row — the same test every
// other no-claim reader applies (unclaimedAutoList NOCLAIM_OWNER_NOTE,
// farmDemand's inFlight count, the Release route).
const CLAIM_NOTE_RE = new RegExp("^" + CLAIM_NOTE_PREFIX + ":", "i");

// Ledger statuses that leave a login sellable again — noclaimHoldings'
// FREE_STATUSES, mirrored. Any other status (listed, sold, removed, manual —
// and an unknown one, which freeReason also treats as committed) is a login no
// no-claim seller will ever sell again; the lister's scan skips exactly
// listed/sold/removed/manual, which is the same set under the ledger's enum.
const LEDGER_FREE_STATUSES = ["skipped", "released", "expired"];

// autoFarm.noclaimMaxBots when settings.json predates the key. settings.js owns
// the real default; this mirror only stops an old file reading as "no cap".
const NOCLAIM_MAX_BOTS_DEFAULT = 40;

// A ledger's poolAccountId is a free-form string; only a real ObjectId may go
// into an `_id: { $nin }` list (anything else is a CastError for the whole
// claim query).
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

// Pool rows claimed this process whose stored password no seller can decrypt
// (a key rotation, a corrupt field). Each is put straight back and never
// claimed again by this process, so one bad row costs one claim, not one per
// pass. A restart forgets them — the moment to have fixed their passwords.
const unreadablePasswordIds = new Set();
// At most this many such rows are put back per claimForGame call: a key that
// no longer decrypts ANY password must not churn the whole pool in one pass.
const MAX_UNREADABLE_PER_CALL = 10;

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

// A sellable password, by the sellers' own fields: noclaimStock.poolBlockReason
// refuses `!pool.password && !pool.credPasswordEnc`, and the lister's scan and
// noclaimHoldings resolve the same two fields. Both are stored as ciphertext
// strings ("" when there is none), so non-empty is the same test.
function passwordPresent() {
  return [{ password: { $gt: "" } }, { credPasswordEnc: { $gt: "" } }];
}

// Ready pool query — mirrors the auto-farmer's definition so the two systems
// agree on what "ready" means (verified token, available, not suspended). When
// a game is given, accounts already spent for that game are excluded.
//
// Since 2026-10-03 (docs/LIVE-FIXES-1003.md A2, defect 2) the feeder only
// claims an account its own sellers would accept. Every no-claim sale path
// refuses an account without a password, and none ever sells a login again once
// it holds a committed no-claim ledger — so either one was a pool account spent
// on stock nobody could sell, counted as supply all the while. The password
// rule is here; the ledger rule needs a database read, so the caller passes
// what claimExclusions() found: the committed logins as `excludeLogins`, their
// pool row ids (plus rows whose password does not decrypt) as `excludeIds`.
function readyPoolQuery(game, { excludeLogins = null, excludeIds = null } = {}) {
  const q = {
    status: "available",
    clientSecret: { $gt: "" },
    lastCheckStatus: { $in: ["", "ok"] },
    // An account the operator handed to a buyer by hand is NOT supply: it must
    // never be claimed into a new bot, farmed again and re-listed, or the same
    // login goes out twice.
    manualSold: { $ne: true },
    $or: passwordPresent(),
  };
  Object.assign(q, soldGameExclusion(game));
  if (Array.isArray(excludeLogins) && excludeLogins.length) {
    q.usernameLower = { $nin: excludeLogins };
  }
  if (Array.isArray(excludeIds) && excludeIds.length) {
    q._id = { $nin: excludeIds };
  }
  return q;
}

// The no-claim ledgers that are committed — on a listing, sold, removed, or held
// by an owner's manual listing: { logins (lower-cased), poolIds }. Per LOGIN,
// whatever game the ledger is for, because that is how both sellers key it: the
// scan's skip set is source + login, and freeReason takes the login's strongest
// ledger. The recycler never resets a ledger, so a recycled account keeps its
// old one.
//
// And per POOL ROW (2026-10-03 review): the scan writes a ledger under the LIVE
// Twitch login, so a renamed account's ledger never matches its pool row's
// usernameLower — but it carries the row's id as poolAccountId, and freeReason
// looks the ledger up by both names. Excluding by both closes the rename gap.
async function committedLedgers() {
  const q = { source: "noclaim", status: { $nin: LEDGER_FREE_STATUSES } };
  const [loginRows, idRows] = await Promise.all([
    UnclaimedAccount.distinct("loginLower", q),
    UnclaimedAccount.distinct("poolAccountId", q),
  ]);
  const logins = new Set();
  for (const l of loginRows || []) {
    const k = String(l || "").trim().toLowerCase();
    if (k) logins.add(k);
  }
  const poolIds = new Set();
  for (const p of idRows || []) {
    const k = String(p || "").trim();
    if (OBJECT_ID_RE.test(k)) poolIds.add(k);
  }
  return { logins: [...logins], poolIds: [...poolIds] };
}

async function committedLedgerLogins() {
  return (await committedLedgers()).logins;
}

// Everything a no-claim claim must skip besides the query's own field rules:
// committed-ledger logins and pool rows, and the rows this process already
// found with a password no seller can decrypt.
async function claimExclusions() {
  const { logins, poolIds } = await committedLedgers();
  return { excludeLogins: logins, excludeIds: [...poolIds, ...unreadablePasswordIds] };
}

// Would a seller be able to hand this row's password to a buyer? The sellers'
// own resolution (unclaimedAutoList.poolPassword — the lister's scan and
// noclaimHoldings call it) decrypts `password`, then `credPasswordEnc`; a value
// that no longer decrypts reads as "" and the account is never sold. Required
// lazily: the lister is a large module, already loaded in the server. Without
// that export only the field-level rule remains, as in noclaimHoldings.
function sellablePassword(row) {
  let engine = null;
  try {
    engine = require("./unclaimedAutoList");
  } catch (e) {
    engine = null;
  }
  if (!engine || typeof engine.poolPassword !== "function") {
    return !!(row && (row.password || row.credPasswordEnc));
  }
  try {
    return !!engine.poolPassword(row);
  } catch {
    return false;
  }
}

// The pristine-reserve clause for one claim: {} while the pool holds more
// never-farmed accounts than the reserve rent-farm orders need, else a clause
// that skips them (utils/pristineReserve.js). A guard that throws reads as "at
// the reserve" — skip pristine rows — which spends nothing it was keeping.
async function pristineClause(guard) {
  try {
    const f = await guard.farmClaimFilter();
    if (f && typeof f === "object") return f;
  } catch (e) {
    console.error("noclaimFleet: pristine reserve unreadable, skipping pristine rows:", e.message || e);
  }
  if (!guard.PRISTINE_CONDITIONS) throw new Error("pristine reserve unavailable — not claiming");
  return { $nor: [guard.PRISTINE_CONDITIONS] };
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
// pool below the auto-farm's reserve. Returns { ready, reserve, spendable,
// pristineHeld }.
//
// `ready` counts only rows claimForGame could actually take (2026-10-03): the
// same password, ledger and pristine-reserve rules. While the reserve still has
// headroom its clause lets pristine rows through, but claimForGame closes it the
// moment the reserve is reached — so the reserve's own share (`pristineHeld`,
// the guard's `protect`) is not supply.
async function spendable(game) {
  const reserve = Math.max(0, Number(settings.getAutoFarm().poolReserve) || 0);
  const exclude = await claimExclusions();
  const guard = pristineReserve();
  const held = await guard.farmGuard();
  const clause = await pristineClause(guard);
  const rows = await AvailableAccount.countDocuments({
    $and: [readyPoolQuery(game, exclude), clause],
  });
  const open = Object.keys(clause).length === 0;
  const pristineHeld = open ? Math.max(0, Math.floor(Number(held && held.protect) || 0)) : 0;
  const ready = Math.max(0, rows - pristineHeld);
  return { ready, reserve, spendable: Math.max(0, ready - reserve), pristineHeld };
}

// Claim up to `count` ready pool accounts for `game`, one atomic
// findOneAndUpdate each so two callers can never be handed the same row. Returns
// the claimed docs — possibly fewer than asked for, possibly none.
//
// The caller owns the rollback once it has the docs: a claim that then fails to
// reach a bot config would strand accounts out of the pool, so every caller
// releases what did NOT reach a config (`release()` below). If the claim itself
// fails part-way, the batch is put back here — nothing in it has reached a
// config yet, and the caller never got to see it.
//
// The ledger exclusion is read once per call; the pristine clause is re-read
// for EVERY claim, because noteClaimed() lowers the reserve's cached count and
// a 70-account batch must stop taking pristine rows the moment the reserve is
// reached, not at the guard's next refresh.
//
// Each claimed row's password is then resolved the way the sellers resolve it
// (sellablePassword). One that does not decrypt goes straight back, is skipped
// by this process from then on, and does not count toward `count`; the
// returned array carries how many were put back as `unreadablePasswords`.
// Rows come back lean: a hydrated document hides fields the schema does not
// declare, and `credPasswordEnc` is one of them.
async function claimForGame(game, count, { actor = "noclaim" } = {}) {
  const note = `${CLAIM_NOTE_PREFIX}:${game}`;
  const claimed = [];
  claimed.unreadablePasswords = 0;
  const want = Math.floor(Number(count) || 0);
  if (want <= 0) return claimed;
  const exclude = await claimExclusions();
  const guard = pristineReserve();
  const unreadable = [];
  try {
    while (claimed.length < want && unreadable.length < MAX_UNREADABLE_PER_CALL) {
      const clause = await pristineClause(guard);
      const doc = await AvailableAccount.findOneAndUpdate(
        { $and: [readyPoolQuery(game, exclude), clause] },
        { $set: { status: "claimed", claimedAt: new Date(), claimedNote: note } },
        { returnDocument: "after", sort: { lastCheckAt: -1 }, lean: true },
      );
      if (!doc) break;
      if (!sellablePassword(doc)) {
        unreadablePasswordIds.add(String(doc._id));
        exclude.excludeIds.push(String(doc._id));
        unreadable.push(doc);
        await recordPoolUsage(doc._id, { event: "claimed", actor, game, note });
        await release([doc], { actor });
        continue;
      }
      claimed.push(doc);
      try {
        guard.noteClaimed(doc);
      } catch (e) {
        console.error("noclaimFleet: pristine reserve bookkeeping failed:", e.message || e);
      }
      await recordPoolUsage(doc._id, { event: "claimed", actor, game, note });
    }
  } catch (err) {
    await release(claimed, { actor }).catch(() => {});
    throw err;
  }
  claimed.unreadablePasswords = unreadable.length;
  if (unreadable.length) {
    const logins = unreadable.map((d) => d.username).filter(Boolean);
    logEvent({
      category: "noclaim",
      action: "password_unreadable",
      severity: "warn",
      actor,
      game,
      count: unreadable.length,
      detail:
        `${unreadable.length} pool account(s) claimed for ${game} have a stored password no seller ` +
        `can decrypt — put back, and skipped until the next restart: ${logins.join(", ")}`,
      meta: { logins },
    });
  }
  return claimed;
}

// Put claimed rows back. Only rows STILL in "claimed" are logged as released, so
// a row another worker has already moved on is not double-counted.
//
// And only rows this feeder still HOLDS (2026-10-03, defect 1): "claimed" with
// a "noclaim-farm:" note. A row another system claimed in between — a renter's
// "rented to …", the auto-farm, an operator — belongs to that system and to its
// bot; flipping it to available would put an account that sits in a live config
// back in the pool, the 09-25 double-home.
async function release(docs, { actor = "noclaim" } = {}) {
  const ids = (docs || []).map((d) => d && d._id).filter(Boolean);
  if (!ids.length) return 0;
  const mine = { status: "claimed", claimedNote: CLAIM_NOTE_RE };
  const still = await AvailableAccount.find(
    { _id: { $in: ids }, ...mine },
    { _id: 1 },
  ).lean();
  if (!still.length) return 0;
  const r = await AvailableAccount.updateMany(
    { _id: { $in: still.map((d) => d._id) }, ...mine },
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
//
// Also returned (2026-10-03): `containers`, every noclaim-bot-* container in
// any state (what the container cap counts), and `psOk`. A `docker ps` that
// fails prints nothing, which reads as "no bot has a container" — so a caller
// that acts on container states must check psOk (null containers when false).
// `provisioningAgeSec` says how long the .provisioning lock has been held (a
// lock a crash left behind never clears), and each bot's `configMtime` (epoch
// seconds) tells one bot from a later bot that reused its id.
async function readFleet({ timeout = 25000 } = {}) {
  const lock = hosts.shq(BASE + "/.provisioning");
  const script =
    `prov=no; provAge=; if [ -f ${lock} ]; then prov=yes; ` +
    `provAge=$(( $(date +%s) - $(stat -c %Y ${lock} 2>/dev/null || date +%s) )); fi; ` +
    `echo "prov=$prov"; echo "provAge=$provAge"; ` +
    `img=no; docker image inspect ${hosts.shq(IMAGE)} >/dev/null 2>&1 && img=yes; echo "img=$img"; ` +
    `echo "PS_START"; docker ps -a --filter name=^/${CONTAINER_PREFIX} --format '{{.Names}}|{{.State}}|{{.Status}}' 2>/dev/null; echo "PS_RC=$?"; echo "PS_END"; ` +
    `echo "BOTS_START"; for d in ${hosts.shq(BOTS_DIR)}/*/Configuration/config.json; do [ -f "$d" ] || continue; ` +
    `id=$(basename $(dirname $(dirname "$d"))); ` +
    `game=$(tr -d '\\n' < "$d" | sed -n 's/.*"FavouriteGames"[^[]*\\[[^"]*"\\([^"]*\\)".*/\\1/p'); ` +
    `n=$(grep -c '"ClientSecret"' "$d"); m=$(stat -c %Y "$d" 2>/dev/null || echo 0); ` +
    `echo "$id|$game|$n|$m"; done; echo "BOTS_END"`;
  const out = await sh(script, { timeout });

  let section = "";
  let provisioning = false;
  let provisioningAgeSec = null;
  let imageBuilt = false;
  let psOk = false;
  const psMap = {};
  const bots = [];
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (line === "PS_START") { section = "ps"; continue; }
    if (line === "PS_END") { section = ""; continue; }
    if (line === "BOTS_START") { section = "bots"; continue; }
    if (line === "BOTS_END") { section = ""; continue; }
    if (line.startsWith("prov=")) { provisioning = line.slice(5) === "yes"; continue; }
    if (line.startsWith("provAge=")) {
      const age = parseInt(line.slice(8), 10);
      provisioningAgeSec = Number.isFinite(age) ? Math.max(0, age) : null;
      continue;
    }
    if (line.startsWith("img=")) { imageBuilt = line.slice(4) === "yes"; continue; }
    if (line.startsWith("PS_RC=")) { psOk = line.slice(6) === "0"; continue; }
    if (section === "ps" && line) {
      const [name, state, status] = line.split("|");
      psMap[name.replace(CONTAINER_PREFIX, "")] = { state, status };
    } else if (section === "bots" && line) {
      const [id, game, n, mtime] = line.split("|");
      bots.push({
        id,
        game: game || "",
        accounts: parseInt(n, 10) || 0,
        configMtime: parseInt(mtime, 10) || 0,
      });
    }
  }
  for (const b of bots) {
    const ps = psMap[b.id];
    b.containerState = ps ? ps.state : "none";
    b.containerStatus = ps ? ps.status : "";
    b.running = ps ? ps.state === "running" : false;
  }
  bots.sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
  return {
    provisioning,
    provisioningAgeSec: provisioning ? provisioningAgeSec : null,
    imageBuilt,
    bots,
    containers: psOk ? Object.keys(psMap).length : null,
    psOk,
  };
}

// How many no-claim containers exist right now, in any state — the container
// cap's count when no fresh fleet read is at hand. Throws when docker cannot be
// asked: a count that silently read 0 would wave every create through.
async function containerCount() {
  const out = await sh(
    `names=$(docker ps -a --filter name=^/${CONTAINER_PREFIX} --format '{{.Names}}' 2>/dev/null); ` +
      `echo "RC=$?"; printf '%s\\n' "$names"`,
    { timeout: 15000 },
  );
  const lines = String(out || "").split("\n").map((l) => l.trim());
  if (!lines.includes("RC=0")) throw new Error("could not list the no-claim containers (docker ps failed)");
  return lines.filter((l) => l.startsWith(CONTAINER_PREFIX)).length;
}

// The cap on no-claim containers (autoFarm.noclaimMaxBots; 0 = off). A value
// that is not a number reads as the default, never as "off": a typo must not
// switch the cap off.
function maxBots() {
  let raw;
  try {
    raw = settings.getAutoFarm().noclaimMaxBots;
  } catch {
    raw = undefined;
  }
  if (raw == null || raw === "") return NOCLAIM_MAX_BOTS_DEFAULT;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 0 ? n : NOCLAIM_MAX_BOTS_DEFAULT;
}

// May a NEW no-claim container be created right now? (2026-10-03, defect 16.)
// Every container is a .NET process holding host RAM, and the farm used to
// find the host's ceiling only by running into it. Two checks, in order:
//   1. the container cap — counted from `containers` (a fleet read the caller
//      already holds) or one fresh `docker ps -a`;
//   2. the host's free RAM (utils/hostCapacity.js, cached 60 s). It fails OPEN
//      on an unreadable host — the create needs the same SSH and fails loudly
//      on its own. A check that THROWS is not an answer, so it throws here and
//      the create does not happen.
// Returns { ok, reason, containers, max, availableMb, minFreeMb }.
async function newContainerGate({ containers = null } = {}) {
  const max = maxBots();
  let count = Number.isFinite(containers) ? containers : null;
  if (max > 0) {
    if (count == null) count = await containerCount();
    if (count >= max) {
      return {
        ok: false,
        reason:
          `the no-claim farm already has ${count} container(s) and its cap is ${max} ` +
          "(autoFarm.noclaimMaxBots) — remove a bot or raise the cap first",
        containers: count,
        max,
        availableMb: null,
        minFreeMb: null,
      };
    }
  }
  const ram = (await hostCapacity().newContainerAllowed(HOST_ID)) || {};
  const mb = (v) => (Number.isFinite(v) ? v : null);
  const out = { containers: count, max, availableMb: mb(ram.availableMb), minFreeMb: mb(ram.minFreeMb) };
  if (ram.ok === false) {
    return {
      ok: false,
      reason:
        out.availableMb != null && out.minFreeMb != null
          ? `host ${HOST_ID} has ${out.availableMb} MB of RAM free, under the ${out.minFreeMb} MB ` +
            "a new container needs (autoFarm.hostMinFreeMb)"
          : `host ${HOST_ID} refused a new container (${ram.reason || "low RAM"})`,
      ...out,
    };
  }
  return { ok: true, reason: "", ...out };
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

// Write a new bot's config. Guarded write (utils/botHosts.guardedWriteScript):
// a cut-off transfer is never installed as the bot's config, and the file is
// 600 from the start.
async function writeBotConfig(id, accounts, game) {
  assertNoClaimGame(game);
  const config = buildConfig(accounts, game);
  await sh(
    hosts.guardedWriteScript(configPath(id), hosts.byteLength(config), {
      mode: "600",
      mkdirs: [botDir(id) + "/Configuration", botDir(id) + "/logs"],
    }),
    { timeout: 20000, input: config },
  );
}

// The provision chain for bot `id`, one && list that launchProvision runs
// detached behind the provisioning lock.
//
// The fork is fetched and built ONLY when the image is missing (2026-10-03,
// defect 6). The image is all a container needs, and a fork that cannot be
// fetched (branch gone, GitHub down) must not stop a container whose image is
// already on the host. The old chain fetched on every create and only got away
// with a failed fetch by accident: its unbraced `docker rm … || true` caught the
// failure and ran `docker run` anyway. The rm is braced now, so the chain means
// what it says — with no image and no fork, it stops before `docker run` and
// the bot is left config-only, which the allocator reports as stuck.
//
// A `docker run` that creates the container and then fails to START it leaves
// it behind in state "created" — which reads as a usable, stopped bot, so it
// would be topped up every pass and never reported. The container is removed
// on that failure, leaving the bot config-only (stuck) as well. "created" is
// NOT treated as stuck: the image rollout leaves stopped bots in exactly that
// state, and they are parked, not broken.
function provisionSteps(id, count, game) {
  const shq = hosts.shq;
  const fetchAndBuild =
    `if [ -d ${shq(SRC_DIR + "/.git")} ]; then cd ${shq(SRC_DIR)} && git fetch --depth 1 origin ${BRANCH} && git checkout -f ${BRANCH} && git reset --hard origin/${BRANCH}; ` +
    `else rm -rf ${shq(SRC_DIR)} && git clone --depth 1 -b ${BRANCH} ${shq(REPO)} ${shq(SRC_DIR)}; fi && ` +
    `cd ${shq(SRC_DIR)} && docker build -f TwitchDropsBot.Console/Dockerfile -t ${shq(IMAGE)} .`;
  return [
    "set -e",
    `touch ${shq(BASE + "/.provisioning")}`,
    // `game` reaches here from a request body on the route path, so it is shell
    // QUOTED, not interpolated. The original inline version wrote it raw into a
    // double-quoted echo that is then embedded in a nested `sh -c`, where a
    // backtick or $( ) in a game name would execute on the Pi as root.
    `echo ${shq(`[bot ${id}] ${count} account(s), game=${game}`)}`,
    `if ! docker image inspect ${shq(IMAGE)} >/dev/null 2>&1; then ${fetchAndBuild}; fi`,
    `{ docker rm -f ${shq(containerFor(id))} >/dev/null 2>&1 || true; }`,
    `{ docker run -d ${containerRunArgs(id, IMAGE)} || { docker rm -f ${shq(containerFor(id))} >/dev/null 2>&1; false; }; }`,
    `echo "[$(date -u +%FT%TZ)] bot ${id} started"`,
  ].join(" && ");
}

// Detach the provision chain. Returns once it is launched — its outcome lands
// in BASE/provision.log, and a bot it never gave a container shows up in the
// next fleet read as config-only.
async function launchProvision(id, count, game) {
  const wrapped = `( { ${provisionSteps(id, count, game)} ; } > ${hosts.shq(BASE + "/provision.log")} 2>&1; rm -f ${hosts.shq(BASE + "/.provisioning")} )`;
  await sh(
    `mkdir -p ${hosts.shq(BASE)}; setsid sh -c ${hosts.shq(wrapped)} >/dev/null 2>&1 < /dev/null &`,
    { timeout: 20000 },
  );
  return id;
}

// Create a bot from already-claimed accounts: write its config, then detach the
// clone/build/run script behind the provisioning lock.
//
// Claiming is NOT done here. The caller claims first and owns the rollback,
// because a create that fails after claiming must return the accounts and only
// the caller knows which ones it claimed. (createBot runs the two steps itself,
// so it can tell a config that landed from one that did not.)
async function createBotFromAccounts(id, accounts, game) {
  await writeBotConfig(id, accounts, game);
  await launchProvision(id, (accounts || []).length, game);
  return id;
}

// What bot `id`'s config holds RIGHT NOW: { exists, secrets, total }. The
// re-read a failed write falls back on (topUpBot, createBot). Throws — state
// unknown — when the host cannot be read, the config does not parse, or a
// guarded write to it may still be in flight (its temp file is there): an SSH
// timeout can fire after the bytes went over and before the `mv`, so a config
// that does not hold the accounts YET is no proof that it never will.
async function readConfigSecrets(id) {
  const file = hosts.shq(configPath(id));
  const out = await sh(
    `for t in ${file}.tmp-*; do [ -e "$t" ] && echo __INFLIGHT__ && break; done; ` +
      `if [ -f ${file} ]; then echo __CFG__; cat ${file}; else echo __NOCFG__; fi`,
    { timeout: 20000 },
  );
  const text = String(out || "");
  const at = text.indexOf("__CFG__");
  const head = at >= 0 ? text.slice(0, at) : text;
  if (head.includes("__INFLIGHT__")) {
    throw new Error(`a write to bot ${id}'s config may still be in flight`);
  }
  if (at < 0) {
    if (head.includes("__NOCFG__")) return { exists: false, secrets: new Set(), total: 0 };
    throw new Error(`bot ${id}'s config could not be read`);
  }
  let cfg;
  try {
    cfg = JSON.parse(text.slice(at + "__CFG__".length));
  } catch (e) {
    throw new Error(`bot ${id}'s config is not valid JSON (${e.message})`);
  }
  const ts = (cfg && cfg.TwitchSettings) || {};
  const users = Array.isArray(ts.TwitchUsers) ? ts.TwitchUsers : [];
  return {
    exists: true,
    secrets: new Set(users.map((u) => String((u && u.ClientSecret) || "")).filter(Boolean)),
    total: users.length,
  };
}

// Which of `docs` a config holds, by ClientSecret — an account's identity in a
// config. Two pool rows sharing one token are one account to the bot, so the
// twin of a row in the config is in the config too.
function splitBySecret(docs, secrets) {
  const presentIds = [];
  const absentIds = [];
  for (const d of docs || []) {
    if (!d || d._id == null) continue;
    const s = String(d.clientSecret || "");
    (s && secrets.has(s) ? presentIds : absentIds).push(d._id);
  }
  return { presentIds, absentIds };
}

// Create one no-claim bot end to end: validate, guard the container cap, the
// host's RAM, the pool reserve and the provisioning lock, claim, write the
// config, start the container.
//
// The rollback is the whole reason this is one function. A create that claims 50
// accounts and then fails to reach the Pi would strand all 50 out of the pool
// with no owner and no way to find them but their note — so an exit BEFORE the
// config write returns them. An exit AFTER it never does (2026-10-03, defect 1):
// the config holds them, and an account in a config marked available is the
// 09-25 double-home. So:
//   * the write throws → re-read the config; release only what it does not
//     hold; if it cannot be read, release nothing (topup_state_unknown);
//   * the launch fails after the write landed → return { …, provisionError }.
//     The bot is config-only, which the allocator reports as stuck.
async function createBot({ game, count, actor = "noclaim" } = {}) {
  const g = assertNoClaimGame(game);
  const want = Math.max(1, Math.min(MAX_PER_BOT, Math.floor(Number(count) || 0)));

  const gate = await newContainerGate();
  if (!gate.ok) {
    const e = new Error(`Not creating a no-claim bot: ${gate.reason}.`);
    e.status = 409;
    e.gate = gate;
    throw e;
  }
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

  // claimForGame puts back whatever it claimed if it fails part-way.
  const claimed = await claimForGame(g, want, { actor });
  const passwordUnreadable = claimed.unreadablePasswords || 0;
  if (!claimed.length) {
    const e = new Error("No ready pool accounts to claim.");
    e.status = 409;
    e.passwordUnreadable = passwordUnreadable;
    throw e;
  }

  let id;
  try {
    id = await nextBotId();
  } catch (err) {
    await release(claimed, { actor }).catch(() => {}); // nothing written yet
    throw err;
  }

  let inConfig = claimed;
  try {
    await writeBotConfig(id, claimed, g);
  } catch (err) {
    let now = null;
    let why = "";
    try {
      now = await readConfigSecrets(id);
    } catch (probeErr) {
      why = probeErr.message || String(probeErr);
    }
    if (!now) {
      logStateUnknown({
        actor,
        id,
        game: g,
        docs: claimed,
        why: `config write failed (${err.message || err}) and the re-read failed too (${why})`,
      });
      err.unknownState = true;
      throw err;
    }
    const { presentIds } = splitBySecret(claimed, now.secrets);
    const present = new Set(presentIds.map(String));
    const back = claimed.filter((d) => !present.has(String(d._id)));
    if (back.length) await release(back, { actor }).catch(() => {});
    if (!present.size) throw err;
    // The write landed although the call failed: go on with what it holds.
    inConfig = claimed.filter((d) => present.has(String(d._id)));
  }

  try {
    await launchProvision(id, inConfig.length, g);
  } catch (err) {
    return {
      id,
      claimed: inConfig.length,
      game: g,
      passwordUnreadable,
      provisionError: err.message || String(err),
    };
  }
  return { id, claimed: inConfig.length, game: g, passwordUnreadable };
}

// Rebuild the container of a bot whose config is there but whose container is
// gone (2026-10-03 review) — a rollout whose `docker run` failed, a container
// someone removed. Such a bot is stuck: the allocator counts its accounts and
// builds no other bot for its game, and nothing on the page could fix it —
// Restart needed a container, Release refuses while any of its accounts is on
// sale, and the rollout only recreates containers that exist.
//
// It is createBot's own launch (launchProvision: the image if missing, then
// `docker run`, and a container that fails to start removed again), behind
// the same container cap + host-RAM gate and the provisioning lock. The
// config is left exactly as it is. Refuses with a `code` when there is a
// container after all ("container_exists") or no config ("no_config").
// Returns { id, game, accounts } once the launch is detached.
async function rebuildMissingContainer(id) {
  const c = containerFor(id);
  const file = hosts.shq(configPath(id));
  const out = await sh(
    `names=$(docker ps -a --filter ${hosts.shq("name=^/" + c + "$")} --format '{{.Names}}' 2>/dev/null); ` +
      `echo "RC=$?"; echo "NAMES=$names"; ` +
      `if [ -f ${file} ]; then echo __CFG__; cat ${file}; else echo __NOCFG__; fi`,
    { timeout: 20000 },
  );
  const text = String(out || "");
  const at = text.indexOf("__CFG__");
  const head = at >= 0 ? text.slice(0, at) : text;
  if (!/^RC=0$/m.test(head)) throw httpError(503, `Could not ask docker whether bot ${id} has a container.`);
  const names = ((head.match(/^NAMES=(.*)$/m) || [])[1] || "").split(/\s+/);
  if (names.includes(c)) {
    const e = httpError(409, `Bot ${id} has a container; it is not rebuilt.`);
    e.code = "container_exists";
    throw e;
  }
  if (at < 0) {
    const e = httpError(409, `Bot ${id} has no config to rebuild a container from.`);
    e.code = "no_config";
    throw e;
  }
  let cfg;
  try {
    cfg = JSON.parse(text.slice(at + "__CFG__".length));
  } catch (err) {
    throw httpError(409, `Bot ${id}'s config is not valid JSON (${err.message}) — not rebuilding it.`);
  }
  const users = (cfg && cfg.TwitchSettings && Array.isArray(cfg.TwitchSettings.TwitchUsers)
    ? cfg.TwitchSettings.TwitchUsers
    : []);
  const game = String((Array.isArray(cfg && cfg.FavouriteGames) && cfg.FavouriteGames[0]) || "");

  const gate = await newContainerGate();
  if (!gate.ok) {
    const e = httpError(409, `Not rebuilding bot ${id}'s container: ${gate.reason}.`);
    e.gate = gate;
    throw e;
  }
  if (await provisionBusy()) {
    throw httpError(409, "A build/provision is already running. Try again shortly.");
  }
  await launchProvision(id, users.length, game);
  return { id: String(id), game, accounts: users.length };
}

// A write whose outcome could not be read back (2026-10-03). The accounts stay
// claimed — a claimed row in no bot is an orphan an operator can find by its
// note; an available row in a bot is a double-home nobody can see — and this
// event says how to find every one of them.
//
// The LOCATOR comes first: systemLog keeps 500 characters of `detail`, at most
// 50 meta entries, and drops a meta over 2,000 characters whole, so a 70-login
// list cannot carry it. The claim note plus the claimedAt window finds every
// stranded row whatever got cut. In meta the note is split (prefix, game):
// systemLog masks a whitespace-free "a:b" string as a credential line.
const STATE_UNKNOWN_META_LOGIN_CHARS = 1200;
function logStateUnknown({ actor, id, game, docs, why }) {
  const rows = (docs || []).filter(Boolean);
  const logins = rows.map((d) => d.username).filter(Boolean);
  const notes = [...new Set(rows.map((d) => String(d.claimedNote || "")).filter(Boolean))];
  const times = rows
    .map((d) => new Date(d.claimedAt).getTime())
    .filter((t) => Number.isFinite(t));
  const from = times.length ? new Date(Math.min(...times)).toISOString() : "";
  const to = times.length ? new Date(Math.max(...times)).toISOString() : "";
  const noteText = notes.length ? notes.map((n) => `"${n}"`).join(" or ") : "(none recorded)";
  const metaLogins = [];
  let used = 0;
  for (const l of logins) {
    if (metaLogins.length >= 50 || used + l.length + 3 > STATE_UNKNOWN_META_LOGIN_CHARS) break;
    metaLogins.push(l);
    used += l.length + 3;
  }
  logEvent({
    category: "noclaim",
    action: "topup_state_unknown",
    severity: "error",
    actor,
    subject: containerFor(id),
    game: game || "",
    count: rows.length,
    detail:
      `bot ${id}: ${rows.length} account(s) left claimed, none released — find them by ` +
      `status "claimed", claimedNote ${noteText}, claimedAt ${from || "?"} to ${to || "?"}, ` +
      `and release any its config does not hold. Cause: ${why}. Logins: ${logins.join(", ")}`,
    meta: {
      botId: String(id),
      notePrefix: CLAIM_NOTE_PREFIX,
      noteGames: notes.map((n) => n.replace(CLAIM_NOTE_RE, "")),
      claimedFrom: from,
      claimedTo: to,
      count: rows.length,
      logins: metaLogins,
      loginsOmitted: logins.length - metaLogins.length,
    },
  });
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
//
// What it returns tells the caller what it may put back (2026-10-03, defect 1):
//   { added, total, presentIds, absentIds[, writeError][, restartError] }
// presentIds = the given docs whose ClientSecret is in the config after the
// call — newly added OR already there (an account already in this bot IS in
// this bot, and stays claimed); absentIds = the rest, the only ones a caller may
// release. The old caller released `claimed.slice(added)`, which after a skipped
// duplicate was the wrong rows: in-config accounts marked available.
//   * A restart that fails after the write is not an error: the accounts are in
//     the config and farm from the bot's next start (restartError says so).
//   * A write that throws is re-read once. Readable → the split is what is
//     really there (writeError says why). Unreadable → it throws with
//     `err.unknownState = true`, and the caller must release NOTHING.
//   * Any other throw happens before the write: nothing reached the config
//     through this call.
async function topUpBot(id, accounts, game, { restart = true } = {}) {
  const host = pi();
  const file = configPath(id);
  const docs = (accounts || []).filter(Boolean);
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
    const fresh = [];
    for (const a of docs) {
      const secret = String(a.clientSecret || "");
      if (!secret || have.has(secret)) continue;
      users.push(userEntry(a, games));
      have.add(secret);
      fresh.push(secret);
    }
    if (!fresh.length) return { added: 0, total: users.length, ...splitBySecret(docs, have) };

    const text = JSON.stringify(cfg, null, 2);
    try {
      await sh(hosts.guardedWriteScript(file, hosts.byteLength(text), { mode: "600" }), {
        timeout: 20000,
        input: text,
      });
    } catch (writeErr) {
      let now;
      try {
        now = await readConfigSecrets(id);
      } catch (readErr) {
        const e = new Error(
          `bot ${id} config write failed (${writeErr.message || writeErr}) and the re-read failed ` +
            `too (${readErr.message || readErr}) — which accounts it holds is unknown`,
        );
        e.status = writeErr.status || 503;
        e.unknownState = true;
        throw e;
      }
      const landed = fresh.filter((s) => now.secrets.has(s)).length;
      const out = {
        added: landed,
        total: now.total,
        ...splitBySecret(docs, now.secrets),
        writeError: writeErr.message || String(writeErr),
      };
      if (landed && restart) {
        const why = await restartBotIfRunning(id);
        if (why) out.restartError = why;
      }
      return out;
    }
    const out = { added: fresh.length, total: users.length, ...splitBySecret(docs, have) };
    if (restart) {
      const why = await restartBotIfRunning(id);
      if (why) out.restartError = why;
    }
    return out;
  });
}

// Bots read their config at STARTUP only, so a restart is what makes new
// accounts farm. `docker restart` on a stopped container starts it — which
// would fight the auto-power watcher's park — so only a running one is
// restarted, and the watcher wakes a parked bot on its own schedule. Returns ""
// or why it failed, and never throws: the write before it has landed, and a
// throw here used to read as "nothing written" and release in-config accounts.
async function restartBotIfRunning(id) {
  try {
    await sh(
      `if [ "$(docker inspect -f '{{.State.Running}}' ${hosts.shq(containerFor(id))} 2>/dev/null)" = "true" ]; ` +
        `then docker restart ${hosts.shq(containerFor(id))} >/dev/null 2>&1 || true; fi`,
      { timeout: 60000 },
    );
    return "";
  } catch (e) {
    return (e && e.message) || String(e);
  }
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
  CLAIM_NOTE_RE,
  LEDGER_FREE_STATUSES,
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
  committedLedgers,
  committedLedgerLogins,
  spendable,
  claimForGame,
  release,
  logStateUnknown,
  readFleet,
  containerCount,
  maxBots,
  newContainerGate,
  provisionBusy,
  nextBotId,
  writeBotConfig,
  provisionSteps,
  launchProvision,
  createBotFromAccounts,
  readConfigSecrets,
  createBot,
  rebuildMissingContainer,
  topUpBot,
  setPersonal,
  findSecretInConfigs,
  containerRunArgs,
  rolloutImage,
  rolloutImageTag,
  rolloutLogVerdict,
  validRolloutRef,
  NOCLAIM_GUARD_LINE,
  _resetForTests: () => unreadablePasswordIds.clear(),
};
