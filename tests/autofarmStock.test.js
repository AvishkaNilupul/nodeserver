// utils/autofarmStock.js — AUTO-FARM accounts sold for their unclaimed drops.
//
// Since 2026-10-05 Twitch refuses a claim from an account that is not linked
// to the game, so an auto-farm account ends a campaign with its drops finished
// and unclaimed. These tests pin what makes selling such an account safe:
//   - only drops its claiming bot CANNOT claim count as stock;
//   - only an account nobody else has a claim on is a candidate (never sold,
//     never linked, on no listing, not rented, one live bot record);
//   - its claimed drops leave the Drops Archive with it, compare-and-set;
//   - after the sale it really leaves farming — and its pool row says "spent"
//     only once every bot config was read and none holds it any more.
//
// Mongo/SSH-free: the module takes its collaborators as `deps`.
process.env.CRED_SECRET ||= "test-secret";
const test = require("node:test");
const assert = require("node:assert");

const settings = require("../utils/settings");
const af = require("../utils/autofarmStock");

// ---------------------------------------------------------------------------
// The switch. The module reads settings.getAutoFarm() fresh on every call.
// ---------------------------------------------------------------------------
const realGetAutoFarm = settings.getAutoFarm;
let autoFarm = {};
settings.getAutoFarm = () => ({ ...autoFarm });
test.after(() => {
  settings.getAutoFarm = realGetAutoFarm;
});
test.beforeEach(() => {
  autoFarm = { autofarmStock: true };
});

// ---------------------------------------------------------------------------
// A tiny in-memory Mongo with MongoDB's missing-field rules.
// ---------------------------------------------------------------------------
let seq = 0;
const oid = () => (++seq).toString(16).padStart(24, "0");
const eq = (a, b) => (b === null ? a == null : a != null && String(a) === String(b));

function matchValue(v, cond) {
  if (cond instanceof RegExp) return typeof v === "string" && cond.test(v);
  const ops =
    cond && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond) &&
    Object.keys(cond).some((k) => k.startsWith("$"));
  if (!ops) {
    // An array field matches when any element does (assignedAccounts).
    if (Array.isArray(v) && !Array.isArray(cond)) return v.some((x) => eq(x, cond));
    return eq(v, cond);
  }
  for (const [op, arg] of Object.entries(cond)) {
    if (op === "$in") {
      const vals = Array.isArray(v) ? v : [v];
      if (!vals.some((x) => arg.some((a) => eq(x, a)))) return false;
    } else if (op === "$ne") {
      if (eq(v, arg)) return false;
    } else if (op === "$gte") {
      if (v == null || !(new Date(v).getTime() >= new Date(arg).getTime())) return false;
    } else {
      throw new Error("fake model: unsupported operator " + op);
    }
  }
  return true;
}

function matches(doc, q) {
  for (const [k, cond] of Object.entries(q || {})) {
    if (k === "$or") {
      if (!cond.some((sub) => matches(doc, sub))) return false;
      continue;
    }
    if (!matchValue(doc[k], cond)) return false;
  }
  return true;
}

function fakeModel(docs = []) {
  const m = { docs, writes: [] };
  const chain = (rows) => {
    const c = {
      sort: () => c,
      limit: (n) => {
        rows = rows.slice(0, n);
        return c;
      },
      lean: async () => rows.map((r) => ({ ...r })),
    };
    return c;
  };
  m.find = (q) => chain(m.docs.filter((d) => matches(d, q)));
  m.findById = (id) => ({ lean: async () => m.docs.find((d) => eq(d._id, id)) || null });
  m.distinct = async (field, q) => [...new Set(m.docs.filter((d) => matches(d, q)).map((d) => d[field]))];
  m.countDocuments = async (q) => m.docs.filter((d) => matches(d, q)).length;
  // The one pipeline the module runs: $match, then count per account.
  m.aggregate = async (pipeline) => {
    const rows = m.docs.filter((d) => matches(d, pipeline[0].$match));
    const by = new Map();
    for (const r of rows) by.set(String(r.account), (by.get(String(r.account)) || 0) + 1);
    return [...by].map(([_id, n]) => ({ _id, n }));
  };
  const apply = (d, u) => {
    let changed = false;
    for (const [k, v] of Object.entries(u.$set || {})) {
      if (JSON.stringify(d[k]) !== JSON.stringify(v)) changed = true;
      d[k] = v;
    }
    for (const [k, cond] of Object.entries(u.$pull || {})) {
      const before = (d[k] || []).length;
      d[k] = (d[k] || []).filter((x) => !cond.$in.some((a) => eq(x, a)));
      if (d[k].length !== before) changed = true;
    }
    return changed;
  };
  m.updateOne = async (q, u, opts) => {
    m.writes.push(["updateOne", q, u]);
    let d = m.docs.find((x) => matches(x, q));
    if (!d && opts && opts.upsert) {
      d = { _id: oid(), ...(u.$setOnInsert || {}) };
      for (const [k, v] of Object.entries(q)) if (typeof v !== "object" || v === null) d[k] = v;
      m.docs.push(d);
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
    }
    if (!d) return { matchedCount: 0, modifiedCount: 0 };
    return { matchedCount: 1, modifiedCount: apply(d, u) ? 1 : 0 };
  };
  m.updateMany = async (q, u) => {
    m.writes.push(["updateMany", q, u]);
    let n = 0;
    for (const d of m.docs.filter((x) => matches(x, q))) if (apply(d, u)) n++;
    return { modifiedCount: n };
  };
  return m;
}

// A world: pool rows, bot records, archive drops, tasks, campaigns, bot hosts.
function world(o = {}) {
  const hostFiles = o.hostFiles || {}; // hostId -> { file: [users] } | Error
  const removals = [];
  const reloads = [];
  const usage = [];
  const events = [];
  const deps = {
    AvailableAccount: fakeModel(o.pool || []),
    BotAccount: fakeModel(o.bots || []),
    DropLog: fakeModel(o.drops || []),
    AutoFarmTask: fakeModel(o.tasks || []),
    TwitchCampaign: fakeModel(o.campaigns || []),
    UnclaimedAccount: fakeModel(o.ledgers || []),
    SaleSignal: fakeModel([]),
    MarketplaceListing: fakeModel(o.listings || []),
    RenterBotStack: fakeModel(o.stacks || []),
    rentedAccounts: {
      rentedIndex: async () => ({ secrets: new Set(o.rentedSecrets || []), logins: new Set(o.rentedLogins || []) }),
      isRented: (idx, acc) =>
        idx.secrets.has(String(acc.clientSecret)) || idx.logins.has(String(acc.login || "").toLowerCase()),
    },
    listedLogins: { loginsOnActiveListings: async () => new Set(o.listed || []) },
    hosts: {
      listHosts: () => Object.keys(hostFiles).map((id) => ({ id })),
      resolveHost: (id) => (id in hostFiles ? { id } : null),
      readdir: async (h) => {
        if (hostFiles[h.id] instanceof Error) throw hostFiles[h.id];
        return Object.keys(hostFiles[h.id]);
      },
      readFiles: async (h, names) => {
        const out = {};
        for (const n of names) {
          const users = hostFiles[h.id][n];
          out[n] =
            users === null
              ? { ok: false }
              : { ok: true, text: JSON.stringify({ TwitchSettings: { TwitchUsers: users } }) };
        }
        return out;
      },
    },
    recordPoolUsage: async (ids, entry) => usage.push({ ids: ids.map(String), ...entry }),
    logEvent: async (e) => events.push(e),
    removeAccountFromConfig: async (host, file, { clientSecret }) => {
      const users = hostFiles[host.id][file];
      const kept = users.filter((u) => u.ClientSecret !== clientSecret);
      const n = users.length - kept.length;
      hostFiles[host.id][file] = kept;
      removals.push(host.id + "/" + file);
      return n;
    },
    reloadConfig: async (host, file, container) => {
      reloads.push(host.id + "/" + file + " -> " + container);
      return { done: true, outcome: "restarted" };
    },
    containerForFile: (f) => (f === "config.json" ? "twitchbot" : "twitchbotx" + parseInt(f.replace(/\D/g, ""), 10)),
  };
  return { deps, hostFiles, removals, reloads, usage, events };
}

const NEEDS_LINK = "https://www.brawlhalla.com/twitch-link";
const poolRow = (login, extra = {}) => ({
  _id: oid(),
  username: login,
  usernameLower: login.toLowerCase(),
  clientSecret: "cs-" + login.toLowerCase(),
  twitchId: "tw-" + login.toLowerCase(),
  status: "claimed",
  claimedNote: "auto-farm: Brawlhalla",
  manualSold: false,
  listed: false,
  soldGames: [],
  ...extra,
});
const botRow = (login, extra = {}) => ({
  _id: oid(),
  login,
  clientSecret: "cs-" + login.toLowerCase(),
  lastScanStatus: "ok",
  soldAt: null,
  ...extra,
});
const drop = (bot, extra = {}) => ({ _id: oid(), account: bot._id, connected: false, soldAt: null, soldToUsername: "", ...extra });

// ---------------------------------------------------------------------------
// The switch and the pure rules
// ---------------------------------------------------------------------------

test("cfg: OFF unless autofarmStock is exactly true; numbers are clamped", () => {
  autoFarm = {};
  assert.strictEqual(af.cfg().on, false);
  autoFarm = { autofarmStock: "yes" };
  assert.strictEqual(af.cfg().on, false);
  autoFarm = { autofarmStock: true, autofarmStockPerTick: 999, autofarmStockMaxLeftover: -3, autofarmStockGames: ["Brawlhalla", ""] };
  const c = af.cfg();
  assert.strictEqual(c.on, true);
  assert.strictEqual(c.perTick, 60);
  assert.strictEqual(c.maxLeftover, 0);
  assert.strictEqual(c.games.length, 1);
  autoFarm = { autofarmStock: true };
  assert.deepStrictEqual(
    { perTick: af.cfg().perTick, maxLeftover: af.cfg().maxLeftover, taskDays: af.cfg().taskDays, games: af.cfg().games },
    { perTick: 15, maxLeftover: 5, taskDays: 8, games: [] },
  );
});

test("linkRequired: only a campaign KNOWN to need a link", () => {
  assert.strictEqual(af.linkRequired(NEEDS_LINK), true);
  // Twitch's own placeholder for "no link needed" — a claiming bot claims these.
  for (const u of ["https://twitch.tv/", "https://twitch.tv", "https://www.twitch.tv/", "HTTP://WWW.TWITCH.TV"]) {
    assert.strictEqual(af.linkRequired(u), false, u);
  }
  // Unknown is not stock.
  assert.strictEqual(af.linkRequired(""), false);
  assert.strictEqual(af.linkRequired(null), false);
  assert.strictEqual(af.linkRequired("https://www.twitch.tv/drops/campaigns"), true, "a real page on twitch.tv is a link");
});

test("sellableFromInv: finished, unclaimed, link needed, account not connected — nothing else", () => {
  const d = (extra) => ({ name: "Sword", game: "Brawlhalla", campaign: "Autumn", imageURL: "i", percent: 100, claimed: false, connected: false, accountLinkURL: NEEDS_LINK, ...extra });
  const out = af.sellableFromInv({
    inProgress: [
      d({}),
      d({ name: "Half", percent: 60 }),
      d({ name: "Claimed", claimed: true }),
      d({ name: "Linked", connected: true }), // its bot claims this within a minute
      d({ name: "NoLink", accountLinkURL: "https://twitch.tv/" }), // and this
      d({ name: "Unknown", accountLinkURL: "" }),
      d({ name: "", game: "" }),
    ],
  });
  assert.deepStrictEqual(out, [
    { name: "Sword", game: "Brawlhalla", campaign: "Autumn", imageURL: "i", itemKey: "sword|brawlhalla" },
    { name: "Reward", game: "", campaign: "Autumn", imageURL: "i", itemKey: "|" },
  ]);
  assert.deepStrictEqual(af.sellableFromInv(null), []);
});

test("blockReason: every rule, in order; a clean auto-farm account is free", () => {
  const clean = { noteOk: true, token: true, bots: 1, twins: false, scan: "ok", reseller: false, botSold: false, rented: false, connected: 0, sold: 0, leftover: 2 };
  assert.strictEqual(af.blockReason(clean), "");
  assert.strictEqual(af.blockReason(null), "not checked");
  const cases = [
    [{ noteOk: false }, "not an auto-farm account"],
    [{ token: false }, "no token"],
    [{ bots: 0 }, "no bot record"],
    [{ bots: 2 }, "two bot records for one token"],
    [{ twins: true }, "login used by another token"],
    [{ scan: "token_invalid" }, "dead token or suspended"],
    [{ scan: "suspended" }, "dead token or suspended"],
    [{ reseller: true }, "reseller account"],
    [{ botSold: true }, "sold or reserved (bot record)"],
    [{ rented: true }, "in a renter stack"],
    [{ connected: 1 }, "a game is connected"],
    [{ sold: 1 }, "a drop is sold or reserved"],
    [{ leftover: 6 }, "holds 6 unsold claimed drops"],
  ];
  for (const [patch, why] of cases) assert.strictEqual(af.blockReason({ ...clean, ...patch }), why);
  // The leftover ceiling is the caller's.
  assert.strictEqual(af.blockReason({ ...clean, leftover: 6 }, { maxLeftover: 10 }), "");
  assert.strictEqual(af.blockReason({ ...clean, leftover: 1 }, { maxLeftover: 0 }), "holds 1 unsold claimed drops");
  // "error" is the scanner's transient verdict, not a dead token.
  assert.strictEqual(af.blockReason({ ...clean, scan: "error" }), "");
});

test("soldTag / orderIdOf: the archive tag is rebuilt from the ledger's order note", () => {
  assert.strictEqual(af.soldTag("eldorado", "ab-12"), "unclaimed-sale:eldorado:ab-12");
  assert.strictEqual(af.soldTag("g2g", ""), "unclaimed-sale:g2g");
  assert.strictEqual(af.orderIdOf({ note: "eldorado order ab-12" }), "ab-12");
  assert.strictEqual(af.orderIdOf({ note: "g2g sale" }), "");
  // Not a marketplace tag, so the archive reads it as a real sale.
  const { isMarketClaimTag } = require("../utils/marketClaimTags");
  assert.strictEqual(isMarketClaimTag(af.soldTag("eldorado", "x")), false);
});

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

test("factsFor: one clean account, and what each kind of history does to it", async () => {
  const bots = ["clean", "linked", "reserved", "fat", "dead", "twin", "rented"].map((l) => botRow(l));
  const by = Object.fromEntries(bots.map((b) => [b.login, b]));
  by.dead.lastScanStatus = "token_invalid";
  const drops = [
    drop(by.clean), drop(by.clean),
    drop(by.linked, { connected: true }),
    drop(by.reserved, { soldAt: new Date(), soldToUsername: "gameflip" }),
    ...Array.from({ length: 7 }, () => drop(by.fat)),
  ];
  // The same login under a second token.
  bots.push({ _id: oid(), login: "Twin", clientSecret: "cs-other", lastScanStatus: "ok", soldAt: null });
  const { deps } = world({ bots, drops, rentedSecrets: ["cs-rented"] });
  const accounts = ["clean", "linked", "reserved", "fat", "dead", "twin", "rented", "ghost"].map((l) => ({
    loginLower: l, login: l, clientSecret: "cs-" + l, note: "auto-farm: Brawlhalla",
  }));
  accounts.push({ loginLower: "stranger", login: "stranger", clientSecret: "cs-clean-2", note: "noclaim-farm: bot 3" });
  const facts = await af.factsFor(accounts, { maxLeftover: 5, deps });
  const reason = (l) => facts.get(l).reason;
  assert.strictEqual(reason("clean"), "");
  assert.strictEqual(facts.get("clean").leftover, 2);
  assert.strictEqual(reason("linked"), "a game is connected");
  assert.strictEqual(reason("reserved"), "a drop is sold or reserved");
  assert.strictEqual(reason("fat"), "holds 7 unsold claimed drops");
  assert.strictEqual(reason("dead"), "dead token or suspended");
  assert.strictEqual(reason("twin"), "login used by another token");
  assert.strictEqual(reason("rented"), "in a renter stack");
  assert.strictEqual(reason("ghost"), "no bot record");
  assert.strictEqual(reason("stranger"), "not an auto-farm account");
});

test("factsFor: a held account (recycled, 'unclaimed stock — …') is an auto-farm account too", async () => {
  const bot = botRow("held");
  const { deps } = world({ bots: [bot] });
  const facts = await af.factsFor(
    [{ loginLower: "held", login: "held", clientSecret: "cs-held", note: "unclaimed stock — 4 drop(s) (Brawlhalla) held out of the pool until sold" }],
    { deps },
  );
  assert.strictEqual(facts.get("held").reason, "");
});

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

function candidateWorld(extra = {}) {
  const pool = [
    poolRow("Free"),
    poolRow("Listed"),
    poolRow("Linked"),
    poolRow("NoLinkGame", { claimedNote: "auto-farm: Twitch Rivals" }),
    poolRow("Recycled", { status: "available", claimedNote: "recycled after Brawlhalla" }),
    poolRow("Held", { claimedNote: "unclaimed stock — 3 drop(s) (SMITE 2) held out of the pool until sold" }),
    poolRow("HandSold", { manualSold: true }),
    poolRow("Other", { claimedNote: "rented to bob" }),
  ];
  const bots = pool.map((p) => botRow(p.username));
  const linked = bots.find((b) => b.login === "Linked");
  const now = Date.now();
  return world({
    pool,
    bots,
    drops: [drop(linked, { connected: true })],
    listed: ["listed"],
    tasks: [
      { _id: oid(), game: "Brawlhalla", campaignId: "c-link", status: "active", assignedAccounts: ["Free", "Listed", "Linked", "Recycled", "HandSold", "Other"] },
      { _id: oid(), game: "Twitch Rivals", campaignId: "c-nolink", status: "active", assignedAccounts: ["NoLinkGame"] },
      { _id: oid(), game: "Old", campaignId: "c-link", status: "completed", completedAt: new Date(now - 30 * 864e5), assignedAccounts: ["Free"] },
      { _id: oid(), game: "Dry", campaignId: "c-link", status: "active", dryRun: true, assignedAccounts: ["HandSold"] },
    ],
    campaigns: [
      { campaignId: "c-link", accountLinkURL: NEEDS_LINK },
      { campaignId: "c-nolink", accountLinkURL: "https://twitch.tv/" },
    ],
    ...extra,
  });
}

test("collectCandidates: switched off, it reads nothing and offers nobody", async () => {
  autoFarm = {};
  const { deps } = candidateWorld();
  let reads = 0;
  for (const m of [deps.AutoFarmTask, deps.AvailableAccount, deps.BotAccount]) {
    const find = m.find;
    m.find = (...a) => {
      reads++;
      return find(...a);
    };
  }
  assert.deepStrictEqual(await af.collectCandidates({ deps }), []);
  assert.strictEqual(reads, 0);
});

test("collectCandidates: deployed on a link-needed campaign or held as stock — and free", async () => {
  const { deps } = candidateWorld();
  const out = await af.collectCandidates({ deps });
  assert.deepStrictEqual(out.map((c) => c.login).sort(), ["Free", "Held"]);
  const free = out.find((c) => c.login === "Free");
  assert.deepStrictEqual(free, {
    source: "noclaim",
    farm: "autofarm",
    login: "Free",
    twitchId: "tw-free",
    clientSecret: "cs-free",
    game: "Brawlhalla",
    botId: "",
    container: "",
  });
  // Listed (on an active listing), Linked (a connected game), NoLinkGame (its
  // bot claims those drops), Recycled (back in the pool), HandSold, Other
  // (someone else's claim) are not candidates.
  assert.strictEqual(out.find((c) => c.login === "Held").game, "");
});

test("collectCandidates: a game allow-list narrows a first rollout (and holds back held rows)", async () => {
  autoFarm = { autofarmStock: true, autofarmStockGames: ["SMITE 2"] };
  const a = candidateWorld();
  assert.deepStrictEqual(await af.collectCandidates({ deps: a.deps }), []);
  autoFarm = { autofarmStock: true, autofarmStockGames: ["brawlhalla"] };
  const b = candidateWorld();
  assert.deepStrictEqual((await af.collectCandidates({ deps: b.deps })).map((c) => c.login), ["Free"]);
});

test("claimBlockReason: straight from the database, and refused while switched off", async () => {
  const pool = poolRow("Free");
  const bot = botRow("Free");
  const { deps } = world({ pool: [pool], bots: [bot], drops: [] });
  assert.strictEqual(await af.claimBlockReason({ loginLower: "free", login: "Free" }, pool, { deps }), "");
  // A listing reserved one of its drops since the snapshot was built.
  deps.DropLog.docs.push(drop(bot, { soldAt: new Date(), soldToUsername: "eldorado" }));
  assert.strictEqual(
    await af.claimBlockReason({ loginLower: "free", login: "Free" }, pool, { deps }),
    "a drop is sold or reserved",
  );
  autoFarm = {};
  assert.strictEqual(
    await af.claimBlockReason({ loginLower: "free", login: "Free" }, pool, { deps }),
    "auto-farm stock is switched off",
  );
  assert.strictEqual(await af.claimBlockReason({ loginLower: "free" }, null, { deps }), "auto-farm stock is switched off");
});

// ---------------------------------------------------------------------------
// The claimed drops that leave with the account
// ---------------------------------------------------------------------------

test("reserveLeftovers: every free claimed drop and the bot record are stamped with the order", async () => {
  const pool = poolRow("Free");
  const bot = botRow("Free");
  const drops = [drop(bot), drop(bot), drop(bot)];
  const { deps } = world({ pool: [pool], bots: [bot], drops });
  const r = await af.reserveLeftovers(pool, { market: "eldorado", orderId: "E-1", setId: "set-1", deps });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reserved, 3);
  for (const d of drops) {
    assert.ok(d.soldAt instanceof Date);
    assert.strictEqual(d.soldToUsername, "unclaimed-sale:eldorado:E-1");
    assert.strictEqual(d.soldSetId, "set-1");
  }
  assert.strictEqual(bot.soldToUsername, "unclaimed-sale:eldorado:E-1");
  assert.ok(bot.soldAt instanceof Date, "no recycle and no re-arm from this moment");
  // An account with no claimed drop at all still gets its sold marker.
  const p2 = poolRow("Bare");
  const b2 = botRow("Bare");
  const w2 = world({ pool: [p2], bots: [b2], drops: [] });
  const r2 = await af.reserveLeftovers(p2, { market: "g2g", orderId: "G-2", deps: w2.deps });
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.reserved, 0);
  assert.ok(b2.soldAt instanceof Date);
});

test("reserveLeftovers: a drop someone else reserved a moment ago wins — ours are released", async () => {
  const pool = poolRow("Raced");
  const bot = botRow("Raced");
  const mine = drop(bot);
  const theirs = drop(bot, { soldAt: new Date(), soldToUsername: "gameflip" });
  const { deps } = world({ pool: [pool], bots: [bot], drops: [mine, theirs] });
  const r = await af.reserveLeftovers(pool, { market: "eldorado", orderId: "E-1", deps });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(mine.soldAt, null, "released");
  assert.strictEqual(mine.soldToUsername, "");
  assert.strictEqual(theirs.soldToUsername, "gameflip", "theirs is untouched");
  assert.strictEqual(bot.soldAt, null, "the bot record is not marked sold");
});

test("reserveLeftovers: a bot record somebody stamped first, or two records, is never ours", async () => {
  const pool = poolRow("Taken");
  const bot = botRow("Taken", { soldAt: new Date(), soldToUsername: "bulk:9" });
  const d1 = drop(bot);
  const a = world({ pool: [pool], bots: [bot], drops: [d1] });
  const r = await af.reserveLeftovers(pool, { market: "eldorado", orderId: "E-1", deps: a.deps });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(d1.soldAt, null);
  assert.strictEqual(bot.soldToUsername, "bulk:9");

  const b = world({ pool: [pool], bots: [botRow("Taken"), botRow("Taken")], drops: [] });
  assert.strictEqual((await af.reserveLeftovers(pool, { market: "eldorado", orderId: "E-1", deps: b.deps })).ok, false);
  assert.strictEqual((await af.reserveLeftovers({ clientSecret: "" }, { deps: b.deps })).ok, false);
});

test("releaseForPool: undoes exactly what one order stamped", async () => {
  const pool = poolRow("Free");
  const bot = botRow("Free");
  const d1 = drop(bot);
  const other = drop(bot, { soldAt: new Date(), soldToUsername: "unclaimed-sale:eldorado:OTHER" });
  const { deps } = world({ pool: [pool], bots: [bot], drops: [d1, other] });
  d1.soldAt = new Date();
  d1.soldToUsername = "unclaimed-sale:eldorado:E-1";
  bot.soldAt = new Date();
  bot.soldToUsername = "unclaimed-sale:eldorado:E-1";
  assert.strictEqual(await af.releaseForPool(pool, { market: "eldorado", orderId: "E-1", deps }), 1);
  assert.strictEqual(d1.soldAt, null);
  assert.strictEqual(bot.soldAt, null);
  assert.strictEqual(other.soldToUsername, "unclaimed-sale:eldorado:OTHER");
});

// ---------------------------------------------------------------------------
// After the sale
// ---------------------------------------------------------------------------

function soldWorld(extra = {}) {
  const pool = poolRow("Sold");
  const bot = botRow("Sold", { host: "contabo", configFile: "config_07.json", container: "twitchbotx7", enabled: true });
  const ledger = {
    _id: oid(),
    source: "noclaim",
    farm: "autofarm",
    login: "Sold",
    loginLower: "sold",
    game: "Brawlhalla",
    poolAccountId: String(pool._id),
    status: "sold",
    soldAt: new Date("2026-10-11T01:00:00Z"),
    soldMarket: "eldorado",
    market: "eldorado",
    soldPriceUsd: 1.5,
    note: "eldorado order E-7",
    set: "set-1",
    manualListing: "5f0000000000000000000001",
    manualDeliveredAt: new Date("2026-10-11T01:00:05Z"),
    manualSpentAt: null,
  };
  const w = world({
    pool: [pool],
    bots: [bot],
    drops: [drop(bot), drop(bot, { connected: true })],
    ledgers: [ledger],
    tasks: [
      { _id: oid(), status: "active", game: "Brawlhalla", assignedAccounts: ["Sold", "Mate"] },
      { _id: oid(), status: "completed", game: "Old", assignedAccounts: ["Sold"] },
    ],
    hostFiles: {
      contabo: {
        "config_07.json": [
          { Login: "Sold", ClientSecret: "cs-sold", Enabled: true },
          { Login: "Mate", ClientSecret: "cs-mate", Enabled: true },
        ],
        "config_09.json": [{ Login: "Sold", ClientSecret: "cs-sold", Enabled: false }],
        "notes.txt": [],
      },
      pi: { "config.json": [{ Login: "Else", ClientSecret: "cs-else", Enabled: true }] },
    },
    ...extra,
  });
  return { ...w, pool, bot, ledger };
}

test("retirePending: nothing waiting = no host is read", async () => {
  const w = world({ hostFiles: { contabo: new Error("should not be read") } });
  const r = await af.retirePending({ deps: w.deps });
  assert.deepStrictEqual(r, { pending: 0, retired: 0, waiting: 0, removed: 0, reloaded: [], errors: [] });
});

test("retirePending: the account leaves its bots, its tasks and the archive, then the pool says spent", async () => {
  autoFarm = {}; // a sale already made is cleaned up whatever the switch says now
  const w = soldWorld();
  const r = await af.retirePending({ deps: w.deps });
  assert.strictEqual(r.retired, 1);
  assert.strictEqual(r.removed, 2, "out of BOTH configs that held its token");
  assert.deepStrictEqual(r.errors, []);
  // Configs: gone everywhere, the co-tenant untouched.
  assert.deepStrictEqual(w.hostFiles.contabo["config_07.json"].map((u) => u.Login), ["Mate"]);
  assert.deepStrictEqual(w.hostFiles.contabo["config_09.json"], []);
  // Only the bot it was ENABLED in reloads — a disabled entry changes nothing for a running bot.
  assert.deepStrictEqual(w.reloads, ["contabo/config_07.json -> twitchbotx7"]);
  // Tasks: active ones release it; history keeps it.
  assert.deepStrictEqual(w.deps.AutoFarmTask.docs[0].assignedAccounts, ["Mate"]);
  assert.deepStrictEqual(w.deps.AutoFarmTask.docs[1].assignedAccounts, ["Sold"]);
  // Archive: the unsold claimed drop went with the account; a connected one is history.
  const [left, linked] = w.deps.DropLog.docs;
  assert.strictEqual(left.soldToUsername, "unclaimed-sale:eldorado:E-7");
  assert.strictEqual(linked.soldAt, null);
  // Bot record.
  assert.strictEqual(w.bot.enabled, false);
  assert.strictEqual(w.bot.configFile, "");
  assert.strictEqual(w.bot.soldToUsername, "unclaimed-sale:eldorado:E-7");
  // Pool row: spent, with the sold game.
  assert.strictEqual(w.pool.status, "claimed");
  assert.match(w.pool.claimedNote, /^spent — auto-farm unclaimed sale \(eldorado order E-7\)$/);
  assert.deepStrictEqual(w.pool.soldGames, [settings.normGameName("Brawlhalla")]);
  assert.strictEqual(w.usage[0].event, "spent");
  // Ledger: done, so the next pass has nothing to do.
  assert.ok(w.ledger.manualSpentAt instanceof Date);
  assert.strictEqual((await af.retirePending({ deps: w.deps })).pending, 0);
  // One sale signal the auto-farm's demand model can see.
  assert.strictEqual(w.deps.SaleSignal.docs.length, 1);
  const sig = w.deps.SaleSignal.docs[0];
  assert.strictEqual(sig.source, "listing_sold");
  assert.strictEqual(sig.gameKey, "brawlhalla");
  assert.strictEqual(sig.marketplace, "eldorado");
  assert.strictEqual(sig.priceUsd, 1.5);
  assert.strictEqual(String(sig.account), String(w.bot._id));
  assert.strictEqual(sig.dedupeKey, "afstock:" + String(w.ledger._id));
});

test("retirePending: an unreadable host proves nothing — the pool row is not stamped, the sale is retried", async () => {
  const w = soldWorld();
  w.hostFiles.pi = new Error("ssh timeout");
  const r = await af.retirePending({ deps: w.deps });
  assert.strictEqual(r.retired, 0);
  assert.strictEqual(r.waiting, 1);
  assert.match(r.errors.join(" "), /unreadable config/);
  // What could be done was done …
  assert.deepStrictEqual(w.hostFiles.contabo["config_07.json"].map((u) => u.Login), ["Mate"]);
  assert.deepStrictEqual(w.deps.AutoFarmTask.docs[0].assignedAccounts, ["Mate"]);
  // … but an account that may still sit in a config nobody could read is not "spent".
  assert.strictEqual(w.pool.claimedNote, "auto-farm: Brawlhalla");
  assert.strictEqual(w.ledger.manualSpentAt, null);
  // The host comes back: the next pass finishes the job, without a second removal or reload.
  w.hostFiles.pi = { "config.json": [] };
  const again = await af.retirePending({ deps: w.deps });
  assert.strictEqual(again.retired, 1);
  assert.strictEqual(again.removed, 0);
  assert.deepStrictEqual(again.reloaded, []);
  assert.match(w.pool.claimedNote, /^spent — /);
  assert.strictEqual(w.deps.SaleSignal.docs.length, 1, "still one sale");
});

test("retirePending: a config that does not parse, or a file that cannot be read, is 'unreadable' too", async () => {
  const w = soldWorld();
  w.hostFiles.pi["config_02.json"] = null;
  const r = await af.retirePending({ deps: w.deps });
  assert.strictEqual(r.retired, 0);
  assert.strictEqual(r.waiting, 1);
  assert.strictEqual(w.ledger.manualSpentAt, null);
});

test("retirePending: an account found in a renter stack config is left for a human", async () => {
  const w = soldWorld({ stacks: [{ host: "contabo", file: "config_09.json" }] });
  const r = await af.retirePending({ deps: w.deps });
  assert.strictEqual(r.retired, 0);
  assert.match(r.errors.join(" "), /renter stack config/);
  assert.strictEqual(w.hostFiles.contabo["config_09.json"].length, 1, "the renter's config is never edited");
  assert.strictEqual(w.pool.claimedNote, "auto-farm: Brawlhalla");
  assert.strictEqual(w.ledger.manualSpentAt, null);
});

test("retirePending: only delivered auto-farm sales — never a no-claim ledger, never an order still in flight", async () => {
  const w = soldWorld();
  const base = { source: "noclaim", status: "sold", poolAccountId: String(w.pool._id), manualListing: "x", manualSpentAt: null };
  w.deps.UnclaimedAccount.docs.push(
    { _id: oid(), ...base, login: "noclaim", manualDeliveredAt: new Date() },
    { _id: oid(), ...base, login: "inflight", farm: "autofarm", manualDeliveredAt: null },
    { _id: oid(), ...base, login: "done", farm: "autofarm", manualDeliveredAt: new Date(), manualSpentAt: new Date() },
  );
  const r = await af.retirePending({ deps: w.deps });
  assert.strictEqual(r.pending, 1);
  assert.strictEqual(r.retired, 1);
});

test("retirePending: a pack sale is marked as bulk in its sale signal", async () => {
  const w = soldWorld({ listings: [{ _id: "5f0000000000000000000001", bulkOfferId: "b-1" }] });
  await af.retirePending({ deps: w.deps });
  assert.strictEqual(w.deps.SaleSignal.docs[0].bulk, true);
});

test("retirePending: a sale that cannot be finished never holds up the ones behind it", async () => {
  const w = soldWorld();
  // Older than the real one, and its pool row is gone.
  w.deps.UnclaimedAccount.docs.unshift({
    _id: oid(), source: "noclaim", farm: "autofarm", login: "orphan", status: "sold",
    poolAccountId: "ffffffffffffffffffffffff", soldAt: new Date("2026-10-01T00:00:00Z"),
    manualDeliveredAt: new Date(), manualSpentAt: null,
  });
  const r = await af.retirePending({ limit: 1, deps: w.deps });
  assert.strictEqual(r.retired, 1);
  assert.match(r.errors.join(" "), /orphan: no pool row or token/);
  assert.ok(w.ledger.manualSpentAt instanceof Date);
});

// ---------------------------------------------------------------------------
// The unclaimed era: who the auto-farm farms a link-needed campaign on, and
// how many (autoFarm.unclaimedEra)
// ---------------------------------------------------------------------------

const ERA = { on: true, headroom: 2, safety: 3, minAccounts: 6, claimWindowDays: 7, maxWindowDays: 28, cleanMax: 5 };

test("eraCfg: OFF unless unclaimedEra is exactly true; the numbers are clamped", () => {
  autoFarm = {};
  assert.strictEqual(af.eraCfg().on, false);
  autoFarm = { unclaimedEra: true, unclaimedEraHeadroom: 99, unclaimedEraSafety: -1, unclaimedEraMinAccounts: 0, autofarmStockMaxLeftover: 2 };
  const c = af.eraCfg();
  assert.deepStrictEqual(
    { on: c.on, headroom: c.headroom, safety: c.safety, minAccounts: c.minAccounts, cleanMax: c.cleanMax },
    { on: true, headroom: 5, safety: 0, minAccounts: 1, cleanMax: 2 },
  );
});

test("eraTarget: what the window can sell, with headroom — never above the engine's target", () => {
  // 8 a week, 12 days left + 7 to claim - 1 of lead = 18 days: 21 sales, x2 + 3.
  const big = af.eraTarget({ ratePerWeek: 8.09, hoursLeft: 296, engineTarget: 74, cfg: ERA });
  assert.deepStrictEqual(big, { target: 46, windowDays: 18.3, expected: 21.2 });
  // A long campaign is capped at the 28-day window.
  assert.strictEqual(af.eraTarget({ ratePerWeek: 1.4, hoursLeft: 642, engineTarget: 60, cfg: ERA }).target, 15);
  // No sales on record: the floor, so the game is still tested.
  assert.strictEqual(af.eraTarget({ ratePerWeek: 0, hoursLeft: 114, engineTarget: 44, cfg: ERA }).target, 6);
  // The engine's own target is a ceiling, whatever the rate says.
  assert.strictEqual(af.eraTarget({ ratePerWeek: 50, hoursLeft: 200, engineTarget: 4, cfg: ERA }).target, 4);
  assert.strictEqual(af.eraTarget({ ratePerWeek: 50, hoursLeft: 200, engineTarget: 0, cfg: ERA }).target, 0);
  // An unknown end reads as a long campaign; junk rates read as none.
  assert.strictEqual(af.eraTarget({ ratePerWeek: NaN, hoursLeft: NaN, engineTarget: 60, cfg: ERA }).target, 6);
  assert.strictEqual(af.eraTarget({ ratePerWeek: 2, hoursLeft: Infinity, engineTarget: 60, cfg: ERA }).windowDays, 28);
  // An ended campaign still has its claim window to sell in.
  assert.strictEqual(af.eraTarget({ ratePerWeek: 7, hoursLeft: -5, engineTarget: 60, cfg: ERA }).windowDays, 6);
});

test("campaignNeedsLink: true / false, and null for a campaign that is not on record", async () => {
  const { deps } = world({
    campaigns: [
      { campaignId: "a", accountLinkURL: NEEDS_LINK },
      { campaignId: "b", accountLinkURL: "https://twitch.tv/" },
      { campaignId: "c", accountLinkURL: "" },
    ],
  });
  deps.TwitchCampaign.findOne = (q) => ({ lean: async () => deps.TwitchCampaign.docs.find((d) => d.campaignId === q.campaignId) || null });
  assert.strictEqual(await af.campaignNeedsLink("a", { deps }), true);
  assert.strictEqual(await af.campaignNeedsLink("b", { deps }), false);
  assert.strictEqual(await af.campaignNeedsLink("c", { deps }), null, "no link URL stored = unknown");
  assert.strictEqual(await af.campaignNeedsLink("zzz", { deps }), null);
  assert.strictEqual(await af.campaignNeedsLink("", { deps }), null);
});

test("weeklyRate: the demand model's clean count when it is recent, else the engine's 45 days", async () => {
  const row = (ageMs, avg45) => [{ at: new Date(Date.now() - ageMs), est: { avg45 } }];
  const brain = (rows) => ({ gameHistory: async (k) => (k === "brawlhalla" ? rows : []) });
  assert.deepStrictEqual(await af.weeklyRate("Brawlhalla", { count: 109 }, { brain: brain(row(60e3, 8.09)) }), { rate: 8.09, basis: "brain" });
  // A stale row, no row, or a model that throws: the engine's own count.
  const engine = { rate: Math.round(((109 * 7) / 45) * 100) / 100, basis: "engine" };
  assert.deepStrictEqual(await af.weeklyRate("Brawlhalla", { count: 109 }, { brain: brain(row(7 * 3600e3, 8.09)) }), engine);
  assert.deepStrictEqual(await af.weeklyRate("Other", { count: 109 }, { brain: brain(row(60e3, 8.09)) }), engine);
  assert.deepStrictEqual(
    await af.weeklyRate("Brawlhalla", 109, { brain: { gameHistory: async () => { throw new Error("db"); } } }),
    engine,
  );
  assert.deepStrictEqual(await af.weeklyRate("Brawlhalla", null, { brain: {} }), { rate: 0, basis: "engine" });
});

function eraWorld() {
  const pool = [
    poolRow("Clean"),
    poolRow("OnListing"),
    poolRow("Linked"),
    poolRow("Fresh"), // deployed a moment ago: no bot record yet
    poolRow("Recycled", { status: "available", claimedNote: "recycled after Brawlhalla" }),
    poolRow("HandSold", { manualSold: true }),
  ];
  const bots = pool.filter((p) => p.username !== "Fresh").map((p) => botRow(p.username));
  const linked = bots.find((b) => b.login === "Linked");
  const w = world({
    pool,
    bots,
    drops: [drop(linked, { connected: true })],
    listed: ["onlisting"],
    campaigns: [
      { campaignId: "c-link", accountLinkURL: NEEDS_LINK },
      { campaignId: "c-free", accountLinkURL: "https://twitch.tv/" },
    ],
  });
  w.deps.TwitchCampaign.findOne = (q) => ({ lean: async () => w.deps.TwitchCampaign.docs.find((d) => d.campaignId === q.campaignId) || null });
  return w;
}

test("unsellableLogins: only what is PROVEN unsellable — an unknown is never a gap", async () => {
  const { deps } = eraWorld();
  const bad = await af.unsellableLogins(["Clean", "OnListing", "Linked", "Fresh", "Recycled", "HandSold", "NoPoolRow"], { deps });
  assert.deepStrictEqual(Object.fromEntries(bad), {
    onlisting: "on an active listing",
    linked: "a game is connected",
    recycled: "back in the pool",
    handsold: "hand-sold",
  });
  // "Fresh" (no bot record yet) and "NoPoolRow" (nothing known) count as there:
  // a top-up that read them as missing would add accounts again every tick.
  assert.ok(!bad.has("fresh") && !bad.has("nopoolrow") && !bad.has("clean"));
});

test("eraForTask: null unless the era is on and the campaign needs a link", async () => {
  const { deps } = eraWorld();
  const task = { game: "Brawlhalla", campaignId: "c-link", campaignEndAt: new Date(Date.now() + 296 * 3600e3), assignedAccounts: ["Clean"] };
  autoFarm = {};
  assert.strictEqual(await af.eraForTask(task, { engineTarget: 74, sales: { count: 0 }, deps }), null);
  autoFarm = { unclaimedEra: true };
  assert.strictEqual(await af.eraForTask({ ...task, campaignId: "c-free" }, { engineTarget: 74, sales: { count: 0 }, deps }), null);
  assert.strictEqual(await af.eraForTask({ ...task, campaignId: "unknown" }, { engineTarget: 74, sales: { count: 0 }, deps }), null);
  assert.strictEqual(await af.eraForTask(null, { deps }), null);
});

test("eraForTask: counts what could be sold, sizes to the window, asks for clean accounts", async () => {
  autoFarm = { unclaimedEra: true };
  const { deps } = eraWorld();
  const task = {
    game: "Brawlhalla",
    campaignId: "c-link",
    campaignEndAt: new Date(Date.now() + 296 * 3600e3),
    assignedAccounts: ["Clean", "OnListing", "Linked", "Fresh", "HandSold", "clean"],
  };
  const brain = { gameHistory: async () => [{ at: new Date(), est: { avg45: 8.09 } }] };
  const era = await af.eraForTask(task, { engineTarget: 74, sales: { count: 109 }, deps, brain });
  assert.deepStrictEqual(era, {
    target: 46,
    sellable: 2, // Clean and Fresh — the same login twice is one account
    unsellable: 3,
    cleanMax: 5,
    rate: 8.09,
    basis: "brain",
    windowDays: 18.3,
  });
});

// ---------------------------------------------------------------------------
// The engine's three hooks (utils/autoFarmer.js). claimPoolAccounts and the
// top-up need a farm host and the no-claim fence to run, so — like
// tests/farmSizingIntegration.test.js does for the top-up's ceiling — the
// wiring is pinned by reading the source. What the hooks COMPUTE is tested
// above (eraForTask, eraTarget, unsellableLogins).
// ---------------------------------------------------------------------------

function fnBody(src, header) {
  const from = src.indexOf(header);
  assert.ok(from >= 0, "missing " + header);
  const rest = src.slice(from);
  return rest
    .slice(0, rest.indexOf("\n}\n"))
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

test("auto-farm hooks: a clean claim narrows BOTH passes, and null changes nothing", () => {
  const src = require("fs").readFileSync(require.resolve("../utils/autoFarmer.js"), "utf8");
  const claim = fnBody(src, "async function claimPoolAccounts(");
  assert.match(claim, /cleanMax = null/, "off by default");
  assert.match(claim, /const clean = cleanCap === null \? \{\} : \{ dropCount: \{ \$not: \{ \$gt: cleanCap \} \} \};/);
  // Inside the one query both passes share, next to the ready rule and the fence.
  assert.match(claim, /\.\.\.readyPoolQuery\(\),\s*\.\.\.extra,\s*\.\.\.clean,/);
  // The pristine reserve still guards every claim.
  assert.match(claim, /pristineGuard,/);
});

test("auto-farm hooks: the top-up measures an era task by what can be sold, and claims clean", () => {
  const src = require("fs").readFileSync(require.resolve("../utils/autoFarmer.js"), "utf8");
  const backfill = fnBody(src, "async function backfillActiveTasks");
  assert.match(backfill, /eraForTask\(task, \{\s*engineTarget: target,\s*sales: gameSales,\s*\}\)/);
  assert.match(backfill, /goal = era\.target;\s*have = Math\.min\(have, era\.sellable\);\s*eraCleanMax = era\.cleanMax;/);
  assert.match(backfill, /const missing = goal - have;/);
  assert.match(backfill, /recycledOnly: reuseOnly, cleanMax: eraCleanMax \}/, "reuse-only games stay reuse-only");
  // The ceiling the era may never exceed is still the game's own cap.
  assert.match(backfill, /capForGame\(af, gameSales, task\.game\)/);

  const exec = fnBody(src, "async function executeTask(");
  assert.match(exec, /eraForTask\(task, \{\s*engineTarget: want,\s*sales: taskSales,\s*\}\)/);
  assert.match(exec, /want = Math\.max\(1, Math\.min\(want, era\.target - era\.sellable\)\);/);
  assert.match(exec, /recycledOnly: reuseOnly, cleanMax: eraCleanMax \}/);
});
