// ---------------------------------------------------------------------------
// NO-CLAIM HOLDINGS — what each no-claim farm account could hand a buyer RIGHT
// NOW (docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md §2).
//
// One NoclaimHolding row per account in a no-claim bot config: its sellable
// drops (in-progress at 100%, not claimed) folded per item, from the last
// SUCCESSFUL live Twitch read. A background sweep keeps the snapshot warm a few
// reads at a time; the Listings page's "No-claim farm" picker and the claim
// layer (utils/noclaimStock.js) read it through snapshotBase().
//
// The snapshot is a shortlist, never a licence to sell: it can say an account
// is NOT free (on a listing, sold, manual-sold, ...), but every claim re-reads
// the live inventory and commits the ledger with a compare-and-set first.
// Credentials never land in a holding row or in the cached base — the pool join
// keeps only `hasPassword`.
// ---------------------------------------------------------------------------
const NoclaimHolding = require("../models/NoclaimHolding");
const AvailableAccount = require("../models/AvailableAccount");
const UnclaimedAccount = require("../models/UnclaimedAccount");
const listedLogins = require("./listedLogins");
const settings = require("./settings");

// The auto-list engine reaches back into this file (through the no-claim
// stock/listing layers), so it is required lazily, inside functions only.
function ual() {
  return require("./unclaimedAutoList");
}

// Contract §1e defaults. Used only when settings.getNoclaimShopSettings is
// missing (the accessor ships in the same change): a settings.js without it
// must degrade to the documented defaults, never take the sweep down.
const NOCLAIM_FALLBACK = {
  enabled: true,
  autoDeliver: true,
  sweep: true,
  sweepPerTick: 30,
  sweepEveryMin: 10,
  maxAgeHours: 8,
  refreshBudget: 120,
  topUp: true,
  healthPerPass: 20,
  passEveryMin: 10,
};

function shopSettings() {
  let cur = null;
  try {
    if (typeof settings.getNoclaimShopSettings === "function") {
      cur = settings.getNoclaimShopSettings();
    }
  } catch (e) {
    console.error("noclaimHoldings: no-claim shop settings unreadable:", e.message);
  }
  return { ...NOCLAIM_FALLBACK, ...(cur && typeof cur === "object" ? cur : {}) };
}

function posNum(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

function maxAgeMsOf(cfg) {
  return posNum(cfg && cfg.maxAgeHours, NOCLAIM_FALLBACK.maxAgeHours) * 3600 * 1000;
}

const BASE_TTL_MS = 30 * 1000;
const FIRST_SWEEP_MS = 60 * 1000;
// The largest read budget the contract allows anywhere (refreshBudget 1..400).
// A caller asking for more still gets a bounded sweep — one Pi, one farm.
const MAX_BUDGET = 400;
const MAX_CONCURRENCY = 5;
// The archive's label for drops without a game; the page renders "" the same.
const OTHER_REWARDS = "Other rewards";
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

// Ledger statuses that leave an account free (contract §0 rule 3).
const FREE_STATUSES = ["skipped", "released", "expired"];
// Two ledgers for one login (a claim race mid-rollback, or a rename): the more
// committed one decides, so an account with ANY committed ledger is never free.
const LEDGER_RANK = { manual: 5, listed: 4, sold: 3, removed: 2 };
const SPENT_NOTE_RE = /^(sold|spent)/i;

let sweeping = false;
let lastSweep = null;
let baseCache = null; // { at: ms, promise }
let timer = null;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

function normGame(g) {
  return settings.normGameName(g);
}

// Grouping key for a game label. normGameName keeps only [a-z0-9], so a label
// in another script normalises to "" — fall back to the raw label so it does
// not merge into "Other rewards".
function gameKey(label) {
  const raw = String(label || "").trim();
  return normGame(raw) || raw.toLowerCase();
}

function copies(qty) {
  const q = Math.floor(Number(qty));
  return Number.isFinite(q) && q >= 1 ? q : 1;
}

// sellableDropsFromNoClaimInv output (one entry per copy) -> one entry per
// item with qty = copies, in first-seen order. An entry that already carries a
// qty counts as that many copies, so folding a folded list changes nothing.
function foldSellable(sellable) {
  const byKey = new Map();
  for (const s of Array.isArray(sellable) ? sellable : []) {
    if (!s || typeof s !== "object") continue;
    const key =
      String(s.itemKey || "").trim().toLowerCase() ||
      String(s.name || "").trim().toLowerCase() +
        "|" +
        String(s.game || "").trim().toLowerCase();
    const n = copies(s.qty);
    const cur = byKey.get(key);
    if (!cur) {
      byKey.set(key, {
        itemKey: key,
        name: String(s.name || ""),
        game: String(s.game || ""),
        campaign: String(s.campaign || ""),
        image: String(s.imageURL || s.image || ""),
        qty: n,
      });
      continue;
    }
    cur.qty += n;
    // First-seen wins; a later copy only fills a blank.
    if (!cur.name && s.name) cur.name = String(s.name);
    if (!cur.game && s.game) cur.game = String(s.game);
    if (!cur.campaign && s.campaign) cur.campaign = String(s.campaign);
    if (!cur.image && (s.imageURL || s.image)) cur.image = String(s.imageURL || s.image);
  }
  return [...byKey.values()];
}

// Both names a holding can be known by: its row key (the config's login) and
// its current login from the last live read. They differ after a Twitch
// rename — and the engine keys its ledger and listing units by the LIVE
// login, so checking only the row key would call a listed account free.
function loginKeys(h) {
  const keys = [];
  const a = String((h && h.loginLower) || "").toLowerCase();
  const b = String((h && h.login) || "").toLowerCase();
  if (a) keys.push(a);
  if (b && b !== a) keys.push(b);
  return keys;
}

function ledgerRank(l) {
  const s = l && l.status;
  if (FREE_STATUSES.includes(s)) return 0;
  return LEDGER_RANK[s] || 1; // an unknown status is committed, not free
}

function strongestLedger(list) {
  let best = null;
  for (const l of list || []) {
    if (l && (!best || ledgerRank(l) > ledgerRank(best))) best = l;
  }
  return best;
}

function ledgerFor(h, base) {
  const map = base && base.ledgerByLogin;
  if (!map) return null;
  return strongestLedger(loginKeys(h).map((k) => map.get(k)));
}

// soldGames holds normalised game names (the engine stamps normGameName).
// Matched as substrings both ways — the no-claim fleet's own rule
// (noclaimFleet.soldGameExclusion) — so an account spent on "Overwatch 2" is
// not sold again for "Overwatch". Over-matching only hides stock;
// under-matching would sell one game's drops on one login twice.
function soldForGame(soldGames, gameNorm) {
  const wants = (Array.isArray(gameNorm) ? gameNorm : [gameNorm])
    .map(normGame)
    .filter(Boolean);
  if (!wants.length) return false;
  return (Array.isArray(soldGames) ? soldGames : []).some((g) => {
    const s = normGame(g);
    return !!s && wants.some((w) => s === w || s.includes(w) || w.includes(s));
  });
}

// "" when the account is free for a set of `gameNorm` (contract §0 rules 1-4;
// item coverage is the caller's check), else the first reason it is not.
// `gameNorm` may be "" (no per-game check) or a list of games.
function freeReason(holding, base, gameNorm) {
  const h = holding || {};
  const b = base || {};
  if (h.inConfig !== true) return "not in a bot";
  const pool =
    h.poolAccountId && b.poolById ? b.poolById.get(String(h.poolAccountId)) : null;
  if (!pool) return "no pool row";
  if (!pool.hasPassword) return "no password";
  if (pool.manualSold === true) return "manual sold";
  // The no-claim console's "Listed" tick: the owner hand-listed it somewhere,
  // or an engine/manual listing holds it.
  if (pool.listed === true) return "ticked listed";
  if (soldForGame(pool.soldGames, gameNorm)) return "sold for this game";
  if (SPENT_NOTE_RE.test(String(pool.claimedNote || "").trim())) return "spent";
  if (pool.status !== "claimed") return "pool not claimed";
  const ledger = ledgerFor(h, b);
  if (ledger && !FREE_STATUSES.includes(ledger.status)) {
    if (ledger.status === "listed") return "on auto listing";
    if (ledger.status === "manual") return "on manual listing";
    if (ledger.status === "sold") return "sold";
    if (ledger.status === "removed") return "removed";
    return String(ledger.status || "ledgered");
  }
  const active = b.activeLogins;
  if (active && loginKeys(h).some((k) => active.has(k))) return "on a listing";
  return "";
}

// `now` is optional so tests (and a caller holding one clock) can pin it.
function isFresh(holding, base, now = Date.now()) {
  const readAt = holding && holding.readAt;
  if (!readAt) return false;
  const ms = new Date(readAt).getTime();
  const maxAgeMs = Number(base && base.maxAgeMs);
  if (!Number.isFinite(ms) || !Number.isFinite(maxAgeMs)) return false;
  return now - ms <= maxAgeMs;
}

// Display label for spellings that fold to one game — the archive's
// pickGameLabel rule: most common wins, ties go to Title-case, then A-Z.
function nicestLabel(counts) {
  let best = "";
  let bestScore = -Infinity;
  for (const [label, count] of counts || []) {
    const hasUpper = /[A-Z]/.test(label);
    const hasLower = /[a-z]/.test(label);
    const score = count * 4 + (hasUpper && hasLower ? 2 : 0) + (hasUpper ? 1 : 0);
    if (score > bestScore || (score === bestScore && label.localeCompare(best) < 0)) {
      best = label;
      bestScore = score;
    }
  }
  return best;
}

// Bounded parallel map (the engine's mapLimit is internal to it).
async function mapLimit(items, n, fn) {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

// ---------------------------------------------------------------------------
// Snapshot writes
// ---------------------------------------------------------------------------

// Step 5 of the sweep, shared with recordRead. A success replaces the items and
// stamps readAt; a failure only records why (the old items and readAt stay, so
// freshness keeps ageing honestly). Never an upsert: a row that exists only
// because a claim read it would claim to be in a bot config. Never throws — it
// is bookkeeping, and a claim must not fail on it.
async function writeRead(loginLower, { sellable, login, error } = {}) {
  let update;
  if (error) {
    const msg = String((error && error.message) || error || "read failed");
    update = { $set: { readError: msg.slice(0, 300) } };
  } else {
    if (!Array.isArray(sellable)) return false; // nothing read — never wipe items
    const items = foldSellable(sellable);
    update = {
      $set: {
        items,
        sellableCount: items.reduce((n, it) => n + it.qty, 0),
        readAt: new Date(),
        readError: "",
      },
    };
    // The live login wins over the config's (a Twitch rename).
    const live = String(login || "").trim();
    if (live) update.$set.login = live;
  }
  try {
    const r = await NoclaimHolding.updateOne({ loginLower }, update);
    return !!(r && (r.matchedCount || r.n));
  } catch (e) {
    console.error(
      "noclaimHoldings: holding write failed for " + loginLower + ":",
      e.message,
    );
    return false;
  }
}

// A claim's own live read, recorded so the picker and the next claim see it.
async function recordRead(loginLower, { sellable, login, error } = {}) {
  const key = String(loginLower || "").toLowerCase();
  if (!key) return false;
  const ok = await writeRead(key, { sellable, login, error });
  invalidate();
  return ok;
}

// A refresh aimed at one game re-reads the accounts of bots farming it AND the
// accounts already known to hold its items (a no-claim bot watches every
// FavouriteGame, so drops of a game often sit on another game's bot).
function sweepGameMatches(cand, state, wantNorm) {
  if (normGame(cand.game).includes(wantNorm)) return true;
  return ((state && state.items) || []).some((it) =>
    normGame(it && it.game).includes(wantNorm),
  );
}

async function sweepInner({ budget, concurrency, game, reason, t0 }) {
  const cfg = shopSettings();
  const maxAgeMs = maxAgeMsOf(cfg);
  const wantBudget =
    budget == null || !Number.isFinite(Number(budget))
      ? posNum(cfg.sweepPerTick, NOCLAIM_FALLBACK.sweepPerTick)
      : Number(budget);
  const limit = Math.min(MAX_BUDGET, Math.max(0, Math.floor(wantBudget)));
  const workers = Math.min(
    MAX_CONCURRENCY,
    Math.max(1, Math.floor(Number(concurrency)) || 2),
  );
  const engine = ual();

  // 1. Every account in every no-claim bot config (one batched Pi round trip).
  let raw;
  try {
    raw = await engine.collectNoClaimCandidates();
  } catch (e) {
    console.error(
      "noclaimHoldings sweep (" + reason + "): Pi unreachable —",
      e.message,
    );
    return {
      configs: 0,
      accounts: 0,
      picked: 0,
      read: 0,
      failed: 0,
      tookMs: Date.now() - t0,
      skipped: "pi unreachable",
      error: e.message,
    };
  }
  const cands = [];
  const seen = new Set();
  const bots = new Set();
  for (const c of Array.isArray(raw) ? raw : []) {
    if (!c) continue;
    if (c.botId) bots.add(String(c.botId));
    const loginLower = String(c.login || "").toLowerCase();
    // A config entry without a login cannot be keyed (the engine skips those
    // too); one login in two configs is one account — the first one wins.
    if (!loginLower || seen.has(loginLower)) continue;
    seen.add(loginLower);
    cands.push({ ...c, loginLower });
  }

  // 2. Pool row per account, joined by clientSecret. Same join (and the same
  // last-row-wins on a duplicated secret) as the engine's scan, so a holding
  // and the engine's ledger name the same pool row.
  const secrets = [...new Set(cands.map((c) => c.clientSecret).filter(Boolean))];
  const poolBySecret = new Map();
  if (secrets.length) {
    const rows = await AvailableAccount.find(
      { clientSecret: { $in: secrets } },
      { clientSecret: 1 },
    ).lean();
    for (const p of rows) poolBySecret.set(p.clientSecret, String(p._id));
  }

  // 3. Base fields for every account; anything not seen left its bot.
  const now = new Date();
  if (cands.length) {
    await NoclaimHolding.bulkWrite(
      cands.map((c) => ({
        updateOne: {
          filter: { loginLower: c.loginLower },
          update: {
            $set: {
              twitchId: String(c.twitchId || ""),
              poolAccountId: poolBySecret.get(c.clientSecret) || "",
              botId: String(c.botId || ""),
              container: String(c.container || ""),
              game: String(c.game || ""),
              seenAt: now,
              inConfig: true,
            },
            // Insert-only: a live read stores the account's CURRENT login (a
            // Twitch rename), and the next sweep must not put the config's
            // stale name back.
            $setOnInsert: { login: String(c.login || "") },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }
  await NoclaimHolding.updateMany(
    { loginLower: { $nin: [...seen] }, inConfig: true },
    { $set: { inConfig: false } },
  );

  // 4. What to read: never-read first, then the oldest read. Rows whose last
  // read FAILED go after every healthy one — a dead token fails forever, and
  // "never-read first" alone would spend the whole budget on those every tick
  // while the rest of the snapshot went stale.
  const state = new Map();
  if (cands.length) {
    const rows = await NoclaimHolding.find(
      { loginLower: { $in: [...seen] } },
      { loginLower: 1, readAt: 1, readError: 1, "items.game": 1 },
    ).lean();
    for (const r of rows) state.set(r.loginLower, r);
  }
  const wantGame =
    String(game || "").trim() === OTHER_REWARDS ? "" : normGame(game);
  // A refresh never re-reads something fresh: anything read within half the
  // freshness window is left alone.
  const rereadBefore = Date.now() - maxAgeMs / 2;
  const eligible = [];
  for (const c of cands) {
    const st = state.get(c.loginLower) || {};
    if (wantGame && !sweepGameMatches(c, st, wantGame)) continue;
    const readMs = st.readAt ? new Date(st.readAt).getTime() : NaN;
    if (Number.isFinite(readMs) && readMs > rereadBefore) continue;
    eligible.push({
      cand: c,
      readMs: Number.isFinite(readMs) ? readMs : 0,
      failing: st.readError ? 1 : 0,
    });
  }
  eligible.sort(
    (a, b) =>
      a.failing - b.failing ||
      a.readMs - b.readMs ||
      a.cand.loginLower.localeCompare(b.cand.loginLower),
  );
  const picked = eligible.slice(0, limit);

  // 5. Live reads, a few at a time.
  let read = 0;
  let failed = 0;
  await mapLimit(picked, workers, async ({ cand }) => {
    let res;
    try {
      res = await engine.inventoryForCandidate(cand);
      if (!res || !Array.isArray(res.sellable)) {
        throw new Error("empty inventory response");
      }
    } catch (e) {
      failed++;
      await writeRead(cand.loginLower, { error: e });
      return;
    }
    read++;
    await writeRead(cand.loginLower, { sellable: res.sellable, login: res.login });
  });

  // 6.
  invalidate();
  const tookMs = Date.now() - t0;
  console.log(
    "noclaimHoldings sweep (" + reason + "): read " + read + "/" + picked.length +
      ", failed " + failed + " in " + tookMs + "ms",
  );
  return {
    configs: bots.size,
    accounts: cands.length,
    picked: picked.length,
    read,
    failed,
    tookMs,
  };
}

async function sweepOnce({ budget, concurrency = 2, game = "", reason = "tick" } = {}) {
  if (sweeping) return { skipped: "running" };
  sweeping = true;
  const t0 = Date.now();
  let out;
  try {
    out = await sweepInner({ budget, concurrency, game, reason, t0 });
  } catch (e) {
    // A DB error mid-sweep. Never reject: the refresh route starts a sweep
    // without awaiting it, and an unhandled rejection would take the server
    // down.
    console.error("noclaimHoldings sweep (" + reason + ") failed:", e.message);
    out = {
      configs: 0,
      accounts: 0,
      picked: 0,
      read: 0,
      failed: 0,
      tookMs: Date.now() - t0,
      skipped: "error",
      error: e.message,
    };
  } finally {
    sweeping = false;
  }
  lastSweep = { at: new Date(), reason, ...out };
  return out;
}

// ---------------------------------------------------------------------------
// Snapshot reads
// ---------------------------------------------------------------------------

function invalidate() {
  baseCache = null;
}

function isSweeping() {
  return sweeping;
}

function hasPoolPassword(engine, row) {
  if (engine && typeof engine.poolPassword === "function") {
    try {
      return !!engine.poolPassword(row);
    } catch {
      return false;
    }
  }
  // An engine without the poolPassword export (it ships in the same change):
  // any stored secret counts. A claim still resolves the real credential and
  // rolls back when there is none, so this can only widen the shortlist.
  return !!(row && (row.password || row.credPasswordEnc));
}

async function buildBase() {
  const cfg = shopSettings();
  const at = new Date();
  const holdings = await NoclaimHolding.find({ inConfig: true }).lean();
  const logins = new Set();
  const poolIds = new Set();
  for (const h of holdings) {
    for (const k of loginKeys(h)) logins.add(k);
    const pid = String(h.poolAccountId || "");
    if (OBJECT_ID_RE.test(pid)) poolIds.add(pid);
  }
  const [ledgers, listed, poolRows] = await Promise.all([
    logins.size
      ? UnclaimedAccount.find(
          { source: "noclaim", loginLower: { $in: [...logins] } },
          { loginLower: 1, status: 1, manualListing: 1, set: 1, market: 1 },
        ).lean()
      : [],
    listedLogins.loginsOnActiveListings(),
    poolIds.size
      ? AvailableAccount.find(
          { _id: { $in: [...poolIds] } },
          {
            status: 1,
            manualSold: 1,
            listed: 1,
            soldGames: 1,
            claimedNote: 1,
            password: 1,
            credPasswordEnc: 1,
          },
        ).lean()
      : [],
  ]);

  const ledgerByLogin = new Map();
  for (const l of ledgers || []) {
    const key = String(l.loginLower || "").toLowerCase();
    if (!key) continue;
    const entry = {
      _id: l._id,
      status: l.status,
      manualListing: l.manualListing || "",
      set: l.set || null,
      market: l.market || "",
    };
    const cur = ledgerByLogin.get(key);
    if (!cur || ledgerRank(entry) > ledgerRank(cur)) ledgerByLogin.set(key, entry);
  }
  const activeLogins = new Set(listed || []);
  // Rename aliases: a holding's row key and its live login name ONE account,
  // so both keys answer with its strongest ledger and its listing state. A
  // consumer looking up either name sees what the other name carries.
  for (const h of holdings) {
    const keys = loginKeys(h);
    if (keys.length < 2) continue;
    const best = strongestLedger(keys.map((k) => ledgerByLogin.get(k)));
    if (best) for (const k of keys) ledgerByLogin.set(k, best);
    if (keys.some((k) => activeLogins.has(k))) for (const k of keys) activeLogins.add(k);
  }

  const engine = ual();
  const poolById = new Map();
  for (const p of poolRows || []) {
    // Only what the free rules need — never the password itself.
    poolById.set(String(p._id), {
      status: p.status || "",
      manualSold: p.manualSold === true,
      listed: p.listed === true,
      soldGames: Array.isArray(p.soldGames) ? p.soldGames.slice() : [],
      claimedNote: String(p.claimedNote || ""),
      hasPassword: hasPoolPassword(engine, p),
    });
  }
  return {
    at,
    maxAgeMs: maxAgeMsOf(cfg),
    holdings,
    ledgerByLogin,
    activeLogins,
    poolById,
  };
}

// Cached for 30 s; concurrent callers share one in-flight build, and a failed
// build is never cached.
async function snapshotBase({ force = false } = {}) {
  const now = Date.now();
  if (!force && baseCache && now - baseCache.at < BASE_TTL_MS) return baseCache.promise;
  const entry = { at: now, promise: null };
  entry.promise = buildBase().catch((e) => {
    if (baseCache === entry) baseCache = null;
    throw e;
  });
  baseCache = entry;
  return entry.promise;
}

// Games in the snapshot, by the drops' own game label (a holder counts once per
// game): accounts holding any of its items, how many are free, and how many of
// those were read recently enough to advertise.
async function pickerGames() {
  const base = await snapshotBase();
  const now = Date.now();
  const games = new Map();
  for (const h of base.holdings || []) {
    const fresh = isFresh(h, base, now);
    const counted = new Set();
    for (const it of h.items || []) {
      const label = String((it && it.game) || "").trim();
      const key = gameKey(label);
      let g = games.get(key);
      if (!g) {
        g = { labels: new Map(), accounts: new Set(), free: new Set(), fresh: new Set() };
        games.set(key, g);
      }
      if (label) g.labels.set(label, (g.labels.get(label) || 0) + 1);
      if (counted.has(key)) continue;
      counted.add(key);
      g.accounts.add(h.loginLower);
      if (freeReason(h, base, normGame(label)) === "") {
        g.free.add(h.loginLower);
        if (fresh) g.fresh.add(h.loginLower);
      }
    }
  }
  return [...games.entries()]
    .map(([key, g]) => ({
      game: key ? nicestLabel(g.labels) || key : OTHER_REWARDS,
      accounts: g.accounts.size,
      free: g.free.size,
      fresh: g.fresh.size,
    }))
    .sort(
      (a, b) =>
        b.free - a.free ||
        b.fresh - a.fresh ||
        b.accounts - a.accounts ||
        String(a.game).localeCompare(String(b.game)),
    );
}

// One row per item, shaped like /drops-archive/by-item so the Listings picker
// renders it unchanged. `accounts` counts only FREE + FRESH holders (what a
// listing can promise now); `stale` = free holders whose read is too old;
// onAuto / onManual = holders whose ledger commits them to an auto-lister /
// owner-made listing (the whole account is committed, so all of its items).
async function pickerItems({ game = "", search = "" } = {}) {
  const base = await snapshotBase();
  const now = Date.now();
  const wantGame = String(game || "").trim();
  const wantKey = wantGame === OTHER_REWARDS ? "" : gameKey(wantGame);
  const needle = String(search || "").trim().toLowerCase();
  const rows = new Map();
  for (const h of base.holdings || []) {
    const fresh = isFresh(h, base, now);
    const ledger = ledgerFor(h, base);
    const status = ledger ? ledger.status : "";
    // Re-fold defensively: one entry per item per holder, copies summed.
    for (const it of foldSellable(h.items)) {
      const label = String(it.game || "").trim();
      if (wantGame && gameKey(label) !== wantKey) continue;
      if (needle && !String(it.name || "").toLowerCase().includes(needle)) continue;
      let row = rows.get(it.itemKey);
      if (!row) {
        row = {
          itemKey: it.itemKey,
          name: it.name,
          labels: new Map(),
          image: it.image,
          accounts: 0,
          minPerAcct: 0,
          maxPerAcct: 0,
          totalCount: 0,
          onAuto: 0,
          onManual: 0,
          stale: 0,
        };
        rows.set(it.itemKey, row);
      }
      if (!row.name && it.name) row.name = it.name;
      if (!row.image && it.image) row.image = it.image;
      if (label) row.labels.set(label, (row.labels.get(label) || 0) + 1);
      if (status === "listed") row.onAuto++;
      else if (status === "manual") row.onManual++;
      if (freeReason(h, base, normGame(label)) !== "") continue;
      if (!fresh) {
        row.stale++;
        continue;
      }
      row.accounts++;
      row.totalCount += it.qty;
      row.minPerAcct = row.accounts === 1 ? it.qty : Math.min(row.minPerAcct, it.qty);
      row.maxPerAcct = Math.max(row.maxPerAcct, it.qty);
    }
  }
  return [...rows.values()]
    .filter((r) => r.accounts + r.stale + r.onAuto + r.onManual > 0)
    .map((r) => ({
      itemKey: r.itemKey,
      name: r.name,
      game: nicestLabel(r.labels),
      image: r.image,
      accounts: r.accounts,
      minPerAcct: r.minPerAcct,
      maxPerAcct: r.maxPerAcct,
      totalCount: r.totalCount,
      onAuto: r.onAuto,
      onManual: r.onManual,
      stale: r.stale,
    }))
    .sort(
      (a, b) =>
        b.accounts - a.accounts ||
        String(a.name).localeCompare(String(b.name)) ||
        String(a.itemKey).localeCompare(String(b.itemKey)),
    )
    .slice(0, 2000);
}

// Snapshot health for the status strip. A light projection, not the base: the
// page polls this every few seconds while a refresh runs.
async function summary() {
  const cfg = shopSettings();
  const maxAgeMs = maxAgeMsOf(cfg);
  const rows = await NoclaimHolding.find(
    { inConfig: true },
    { readAt: 1, readError: 1 },
  ).lean();
  const now = Date.now();
  let read = 0;
  let fresh = 0;
  let stale = 0;
  let neverRead = 0;
  let failed = 0;
  let oldest = null;
  let newest = null;
  for (const r of rows) {
    if (r.readError) failed++;
    const ms = r.readAt ? new Date(r.readAt).getTime() : NaN;
    if (!Number.isFinite(ms)) {
      neverRead++;
      continue;
    }
    read++;
    if (now - ms <= maxAgeMs) fresh++;
    else stale++;
    if (oldest == null || ms < oldest) oldest = ms;
    if (newest == null || ms > newest) newest = ms;
  }
  return {
    accounts: rows.length,
    read,
    fresh,
    stale,
    neverRead,
    failed,
    oldestReadAt: oldest == null ? null : new Date(oldest),
    newestReadAt: newest == null ? null : new Date(newest),
    sweeping,
    lastSweep,
    settings: cfg,
  };
}

// Background sweep. The switches and the interval are read fresh every tick,
// so the owner can turn the sweep on/off or retime it without a restart. A tick
// that found the Pi unreachable waits 3× the interval before the next one.
// DEMAND-DRIVEN background sweep. Every read goes through the Pi's SSH link and
// Twitch's GQL, which the auto-lister and the pool checker already share, so
// the timer only reads while the snapshot is actually wanted: someone used the
// no-claim picker in the last INTEREST_WINDOW_MS (noteInterest, called by the
// routes), or a no-claim listing is live (its stock counts and claims lean on
// a fresh snapshot). After a restart nothing is wanted until the page is
// opened again — deploying this adds no Pi traffic of its own.
const INTEREST_WINDOW_MS = 12 * 60 * 60 * 1000;
let lastInterestAt = 0;

function noteInterest() {
  lastInterestAt = Date.now();
}

async function sweepWanted() {
  if (Date.now() - lastInterestAt < INTEREST_WINDOW_MS) return true;
  try {
    const MarketplaceListing = require("../models/MarketplaceListing");
    return !!(await MarketplaceListing.exists({ noclaimStock: true, status: "active" }));
  } catch {
    return false;
  }
}

function start() {
  if (timer) return;
  timer = true;
  const schedule = (ms) => {
    const t = setTimeout(tick, ms);
    if (t.unref) t.unref();
  };
  const tick = async () => {
    let backoff = false;
    try {
      const cfg = shopSettings();
      if (cfg.enabled && cfg.sweep && (await sweepWanted())) {
        const r = await sweepOnce({ budget: cfg.sweepPerTick, reason: "tick" });
        backoff = !!(r && r.skipped === "pi unreachable");
      }
    } catch (e) {
      console.error("noclaimHoldings tick error:", e.message);
    } finally {
      const everyMin = posNum(
        shopSettings().sweepEveryMin,
        NOCLAIM_FALLBACK.sweepEveryMin,
      );
      schedule(everyMin * 60 * 1000 * (backoff ? 3 : 1));
    }
  };
  schedule(FIRST_SWEEP_MS);
}

module.exports = {
  // pure, tested
  foldSellable,
  normGame,
  freeReason,
  isFresh,
  // snapshot
  sweepOnce,
  recordRead,
  snapshotBase,
  pickerGames,
  pickerItems,
  summary,
  start,
  noteInterest,
  sweepWanted,
  invalidate,
  isSweeping,
};
