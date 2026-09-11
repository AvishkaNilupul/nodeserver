// utils/noclaimStock.js is the ONE claim layer for owner-made no-claim listings
// (docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md §3). Every account it hands out is a
// whole Twitch account a buyer pays for, and the no-claim auto-lister sells the
// same farm, so these tests pin the rules that stop one account reaching two
// buyers: the ledger compare-and-set, the live re-read before any commit, the
// post-commit listing re-check and its rollback, and the order resume.
//
// Mongo/network-free: every model, the engine (utils/unclaimedAutoList) and the
// holdings snapshot (utils/noclaimHoldings) are stubbed at require time via
// Module._load. The hook stays installed for the whole file because the claim
// layer requires the engine and the holdings module lazily, at call time.
process.env.CRED_SECRET ||= "test-secret";
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const Module = require("module");

const HOUR = 3600 * 1000;

// ---------------------------------------------------------------------------
// A tiny in-memory Mongo: enough query semantics for the claim layer, with
// MongoDB's missing-field rules (a missing field matches `null` and `$ne`, and
// never matches `$gt`) because spendPending's scoping depends on exactly that.
// ---------------------------------------------------------------------------

let seq = 0;
function oid() {
  seq++;
  return seq.toString(16).padStart(24, "0");
}

function eq(a, b) {
  if (b === null) return a == null;
  if (a == null) return false;
  if (a instanceof Date || b instanceof Date) {
    return new Date(a).getTime() === new Date(b).getTime();
  }
  return String(a) === String(b);
}

function matches(doc, q) {
  for (const [k, cond] of Object.entries(q || {})) {
    const v = doc[k];
    const isOps =
      cond &&
      typeof cond === "object" &&
      !(cond instanceof Date) &&
      !Array.isArray(cond) &&
      Object.keys(cond).some((x) => x.startsWith("$"));
    if (!isOps) {
      if (!eq(v, cond)) return false;
      continue;
    }
    for (const [op, arg] of Object.entries(cond)) {
      if (op === "$in") {
        if (!arg.some((a) => eq(v, a))) return false;
      } else if (op === "$nin") {
        if (arg.some((a) => eq(v, a))) return false;
      } else if (op === "$ne") {
        if (eq(v, arg)) return false;
      } else if (op === "$gt") {
        if (typeof v !== typeof arg || !(v > arg)) return false;
      } else {
        throw new Error("fake model: unsupported operator " + op);
      }
    }
  }
  return true;
}

function sortKey(v) {
  if (v == null) return -Infinity;
  if (v instanceof Date) return v.getTime();
  return v;
}

function bySpec(spec) {
  const keys = Object.entries(spec || {});
  return (a, b) => {
    for (const [k, dir] of keys) {
      const x = sortKey(a[k]);
      const y = sortKey(b[k]);
      if (x < y) return -dir;
      if (x > y) return dir;
    }
    return 0;
  };
}

const clone = (v) => structuredClone(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function fakeModel(name) {
  const m = {
    name,
    docs: [],
    calls: [],
    hooks: {},
    reset() {
      m.docs = [];
      m.calls = [];
      m.hooks = {};
    },
    writes() {
      return m.calls.filter((c) => ["updateOne", "updateMany", "create", "deleteOne"].includes(c[0]));
    },
  };
  const hook = (op, ...args) => (m.hooks[op] ? m.hooks[op](...args) : undefined);
  const listChain = (getRows) => {
    let spec = null;
    let lim = 0;
    const c = {
      sort(s) {
        spec = s;
        return c;
      },
      limit(n) {
        lim = n;
        return c;
      },
      lean: async () => {
        let rows = getRows();
        if (spec) rows = rows.slice().sort(bySpec(spec));
        if (lim) rows = rows.slice(0, lim);
        return rows.map(clone);
      },
    };
    return c;
  };
  const oneChain = (getRow) => ({
    lean: async () => {
      const r = getRow();
      return r ? clone(r) : null;
    },
  });
  m.find = (q) => {
    m.calls.push(["find", q]);
    hook("find", q);
    return listChain(() => m.docs.filter((d) => matches(d, q)));
  };
  m.findOne = (q) => {
    m.calls.push(["findOne", q]);
    hook("findOne", q);
    return oneChain(() => m.docs.find((d) => matches(d, q)) || null);
  };
  m.findById = (id) => {
    m.calls.push(["findById", id]);
    hook("findById", id);
    return oneChain(() => m.docs.find((d) => eq(d._id, id)) || null);
  };
  const apply = (d, $set) => {
    let changed = false;
    for (const [k, v] of Object.entries($set || {})) {
      if (!same(d[k], v)) changed = true;
      d[k] = v === undefined ? v : clone(v);
    }
    return changed;
  };
  m.updateOne = async (q, u) => {
    m.calls.push(["updateOne", q, u]);
    await hook("updateOne", q, u, m);
    const d = m.docs.find((x) => matches(x, q));
    if (!d) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
    return { acknowledged: true, matchedCount: 1, modifiedCount: apply(d, u.$set) ? 1 : 0 };
  };
  m.updateMany = async (q, u) => {
    m.calls.push(["updateMany", q, u]);
    await hook("updateMany", q, u, m);
    let matched = 0;
    let modified = 0;
    for (const d of m.docs.filter((x) => matches(x, q))) {
      matched++;
      if (apply(d, u.$set)) modified++;
    }
    return { acknowledged: true, matchedCount: matched, modifiedCount: modified };
  };
  m.create = async (doc) => {
    m.calls.push(["create", doc]);
    const d = { _id: oid(), ...clone(doc) };
    m.docs.push(d);
    await hook("create", d, m);
    return clone(d);
  };
  m.deleteOne = async (q) => {
    m.calls.push(["deleteOne", q]);
    const i = m.docs.findIndex((x) => matches(x, q));
    if (i < 0) return { acknowledged: true, deletedCount: 0 };
    m.docs.splice(i, 1);
    return { acknowledged: true, deletedCount: 1 };
  };
  m.countDocuments = async (q) => {
    m.calls.push(["countDocuments", q]);
    return m.docs.filter((d) => matches(d, q)).length;
  };
  return m;
}

const Unclaimed = fakeModel("UnclaimedAccount");
const Pool = fakeModel("AvailableAccount");
const Listing = fakeModel("MarketplaceListing");
const Sets = fakeModel("DropSet");

// ---------------------------------------------------------------------------
// Stubbed collaborators. `state` is reset before every test.
// ---------------------------------------------------------------------------

const state = {};
function resetState() {
  Object.assign(state, {
    settings: { enabled: true, autoDeliver: true, maxAgeHours: 8 },
    events: [],
    base: null,
    snapshotCalls: 0,
    reads: [],
    invalidated: 0,
    inventory: new Map(), // loginLower -> { sellable, login } | Error
    invCalls: [],
    active: () => [], // (loginLower, nthCallForLogin) -> active rows
    activeCalls: [],
    unlisted: [],
    spent: [],
    spendFail: new Set(),
  });
}
resetState();

const normGameName = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const settingsStub = {
  getNoclaimShopSettings: () => state.settings,
  normGameName,
};

const systemLogStub = {
  logEvent: (e) => {
    state.events.push(e);
  },
};

// A faithful-enough stand-in for noclaimHoldings' pure rules (§2): the claim
// layer's own logic is what is under test here.
const holdingsStub = {
  snapshotBase: async () => {
    state.snapshotCalls++;
    return state.base;
  },
  freeReason(h, base, gameNorm) {
    if (h.inConfig !== true) return "not in a bot";
    const pool = base.poolById.get(String(h.poolAccountId));
    if (!pool) return "no pool row";
    if (!pool.hasPassword) return "no password";
    if (pool.manualSold) return "manual sold";
    if (pool.listed) return "ticked listed";
    const wants = (Array.isArray(gameNorm) ? gameNorm : [gameNorm]).filter(Boolean);
    if ((pool.soldGames || []).some((g) => wants.includes(normGameName(g)))) return "sold for this game";
    if (/^(sold|spent)/i.test(pool.claimedNote || "")) return "spent";
    if (pool.status !== "claimed") return "pool not claimed";
    const led = base.ledgerByLogin.get(h.loginLower);
    if (led && !["skipped", "released", "expired"].includes(led.status)) {
      if (led.status === "listed") return "on auto listing";
      if (led.status === "manual") return "on manual listing";
      return led.status;
    }
    if (base.activeLogins.has(h.loginLower)) return "on a listing";
    return "";
  },
  isFresh: (h, base) => !!h.readAt && Date.now() - new Date(h.readAt).getTime() <= base.maxAgeMs,
  recordRead: async (loginLower, r) => {
    state.reads.push({ loginLower, ...r });
    return true;
  },
  invalidate: () => {
    state.invalidated++;
  },
};

const ualStub = {
  async inventoryForCandidate(cand) {
    const key = String(cand.login || "").toLowerCase();
    state.invCalls.push(key);
    assert.ok(cand.clientSecret, "a live read needs the pool row's clientSecret");
    const r = state.inventory.get(key);
    if (!r) throw new Error("no inventory scripted for " + key);
    if (r instanceof Error) throw r;
    return { inv: {}, sellable: clone(r.sellable), login: r.login || cand.login };
  },
  async credentialForLedger(ledger) {
    const pool = Pool.docs.find((p) => eq(p._id, ledger.poolAccountId));
    if (!pool) return { login: ledger.login || "", password: "", email: "" };
    const readable = (pool.password || pool.credPasswordEnc) && pool.password !== "undecryptable";
    return {
      login: ledger.login || pool.username,
      password: readable ? "pw:" + pool.username : "",
      email: readable ? "mail:" + pool.username : "",
    };
  },
  async activeListingsForLogin(login) {
    const key = String(login || "").toLowerCase();
    const nth = state.activeCalls.filter((l) => l === key).length;
    state.activeCalls.push(key);
    return state.active(key, nth);
  },
  async markOwnerUnlisted(ledger) {
    state.unlisted.push(String(ledger._id));
  },
  async spendAccount(ledger, reason, opts) {
    state.spent.push({ id: String(ledger._id), reason, opts });
    if (state.spendFail.has(String(ledger._id))) throw new Error("pi unreachable");
  },
};

const ROOT = path.join(__dirname, "..");
const STUBS = new Map([
  [path.join(ROOT, "models/UnclaimedAccount.js"), Unclaimed],
  [path.join(ROOT, "models/AvailableAccount.js"), Pool],
  [path.join(ROOT, "models/MarketplaceListing.js"), Listing],
  [path.join(ROOT, "models/DropSet.js"), Sets],
  [path.join(ROOT, "utils/settings.js"), settingsStub],
  [path.join(ROOT, "utils/systemLog.js"), systemLogStub],
  [path.join(ROOT, "utils/noclaimHoldings.js"), holdingsStub],
  [path.join(ROOT, "utils/unclaimedAutoList.js"), ualStub],
]);

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  let resolved;
  try {
    resolved = Module._resolveFilename(request, parent, isMain);
  } catch {
    // A sibling that is not on disk yet still resolves to its stub.
    if (parent && parent.filename && request.startsWith(".")) {
      resolved = path.resolve(path.dirname(parent.filename), request);
      if (!resolved.endsWith(".js")) resolved += ".js";
    }
  }
  if (resolved && STUBS.has(resolved)) return STUBS.get(resolved);
  return origLoad.apply(this, arguments);
};
test.after(() => {
  Module._load = origLoad;
});

const ncs = require("../utils/noclaimStock");

test.beforeEach(() => {
  resetState();
  for (const m of [Unclaimed, Pool, Listing, Sets]) m.reset();
});

// ---------------------------------------------------------------------------
// Fixtures: a set promising 2× Alpha Pack + 1× Beta Spray (Overwatch 2).
// ---------------------------------------------------------------------------

const SET_ID = "5e0000000000000000000001";
const OTHER_SET = "5e0000000000000000000002";
const LISTING_ID = "5f0000000000000000000001";

const item = (name, qty = 1, game = "Overwatch 2") => ({
  itemKey: name.toLowerCase() + "|" + game.toLowerCase(),
  name,
  game,
  image: "",
  qty,
});
const ALPHA = (qty = 2) => item("Alpha Pack", qty);
const BETA = (qty = 1) => item("Beta Spray", qty);
const GAMMA = (qty = 1) => item("Gamma Skin", qty);

const SET = {
  _id: SET_ID,
  name: "OW spring bundle",
  stockSource: "noclaim",
  coverGame: "Overwatch 2",
  items: [ALPHA(2), BETA(1)],
};

// Folded items -> the raw inventory's one-entry-per-copy sellable list.
function sellableOf(items) {
  const out = [];
  for (const it of items || []) {
    for (let i = 0; i < (it.qty || 1); i++) {
      out.push({ name: it.name, game: it.game, campaign: "Spring", imageURL: "", itemKey: it.itemKey });
    }
  }
  return out;
}

// Build pool rows, ledgers, the snapshot base and the live inventory for a
// list of accounts in one go.
function world(accounts, { maxAgeMs = 8 * HOUR } = {}) {
  const base = {
    at: new Date(),
    maxAgeMs,
    holdings: [],
    ledgerByLogin: new Map(),
    activeLogins: new Set(),
    poolById: new Map(),
  };
  const out = {};
  for (const a of accounts) {
    const lower = a.login.toLowerCase();
    const pool = {
      _id: oid(),
      username: a.login,
      usernameLower: lower,
      status: "claimed",
      password: "enc:v1:x",
      credPasswordEnc: "",
      clientSecret: "cs-" + lower,
      soldGames: [],
      claimedNote: "",
      manualSold: false,
      listed: false,
      ...(a.pool || {}),
    };
    Pool.docs.push(pool);
    base.poolById.set(String(pool._id), {
      status: pool.status,
      manualSold: pool.manualSold,
      listed: pool.listed,
      soldGames: pool.soldGames.slice(),
      claimedNote: pool.claimedNote,
      hasPassword: !!(pool.password || pool.credPasswordEnc),
      ...(a.snapshotPool || {}),
    });
    const holding = {
      loginLower: lower,
      login: a.snapshotLogin || a.login,
      twitchId: "tw-" + lower,
      poolAccountId: String(pool._id),
      botId: a.botId || "7",
      container: "noclaim-bot-" + (a.botId || "7"),
      game: a.botGame || "Overwatch 2",
      items: a.items,
      readAt: a.readAt === undefined ? new Date() : a.readAt,
      inConfig: true,
    };
    base.holdings.push(holding);
    let ledger = null;
    if (a.ledger) {
      ledger = {
        _id: oid(),
        source: "noclaim",
        login: a.login,
        loginLower: lower,
        status: "skipped",
        ...a.ledger,
      };
      Unclaimed.docs.push(ledger);
      if (a.snapshotLedger !== false) {
        base.ledgerByLogin.set(lower, {
          _id: ledger._id,
          status: ledger.status,
          manualListing: ledger.manualListing || "",
          set: ledger.set || null,
          market: ledger.market || "",
        });
      }
    }
    state.inventory.set(
      lower,
      a.live !== undefined ? a.live : { sellable: sellableOf(a.items), login: a.login },
    );
    out[lower] = { pool, holding, ledger };
  }
  state.base = base;
  return out;
}

const ledgerFor = (login) => Unclaimed.docs.filter((d) => d.loginLower === login.toLowerCase());
const poolFor = (login) => Pool.docs.find((p) => p.usernameLower === login.toLowerCase());

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("itemKeyOf is exactly the inventory's item key", () => {
  assert.strictEqual(ncs.itemKeyOf("  Alpha Pack ", " Overwatch 2 "), "alpha pack|overwatch 2");
  assert.strictEqual(ncs.itemKeyOf(null, undefined), "|");
});

test("isNoclaimSet / isNoclaimRow only answer to their own flags", () => {
  assert.strictEqual(ncs.isNoclaimSet(SET), true);
  assert.strictEqual(ncs.isNoclaimSet({ stockSource: "" }), false);
  assert.strictEqual(ncs.isNoclaimSet(null), false);
  assert.strictEqual(ncs.isNoclaimRow({ noclaimStock: true }), true);
  assert.strictEqual(ncs.isNoclaimRow({ noclaimStock: false, set: SET_ID }), false);
  assert.strictEqual(ncs.isNoclaimRow(undefined), false);
});

test("requiredFromSet: stored itemKey wins, qty defaults to 1, duplicates add up", () => {
  const req = ncs.requiredFromSet({
    items: [
      { itemKey: " Alpha Pack|Overwatch 2 ", name: "ignored", game: "ignored", qty: 2 },
      { name: "Beta Spray", game: "Overwatch 2" }, // no itemKey, no qty
      { itemKey: "alpha pack|overwatch 2", qty: 0 }, // qty below 1 counts as 1
      { itemKey: "", name: "", game: "" }, // junk
    ],
  });
  assert.deepStrictEqual([...req], [
    ["alpha pack|overwatch 2", 3],
    ["beta spray|overwatch 2", 1],
  ]);
  assert.strictEqual(ncs.requiredFromSet({ items: [] }).size, 0);
  assert.strictEqual(ncs.requiredFromSet(null).size, 0);
});

test("heldCounts: folded items carry qty, raw sellable entries count one each", () => {
  const folded = ncs.heldCounts([ALPHA(3), BETA(1), { itemKey: "x|y", qty: 0 }]);
  assert.deepStrictEqual([...folded], [
    ["alpha pack|overwatch 2", 3],
    ["beta spray|overwatch 2", 1],
  ]);
  const raw = ncs.heldCounts(sellableOf([ALPHA(2), BETA(1)]));
  assert.deepStrictEqual([...raw], [
    ["alpha pack|overwatch 2", 2],
    ["beta spray|overwatch 2", 1],
  ]);
  assert.strictEqual(ncs.heldCounts(null).size, 0);
});

test("covers: every promised copy must be held; an empty requirement covers nothing", () => {
  const req = ncs.requiredFromSet(SET);
  assert.strictEqual(ncs.covers(ncs.heldCounts([ALPHA(2), BETA(1)]), req), true);
  assert.strictEqual(ncs.covers(ncs.heldCounts([ALPHA(5), BETA(2), GAMMA(1)]), req), true);
  assert.strictEqual(ncs.covers(ncs.heldCounts([ALPHA(1), BETA(1)]), req), false, "one Alpha short");
  assert.strictEqual(ncs.covers(ncs.heldCounts([ALPHA(2)]), req), false, "Beta missing");
  assert.strictEqual(ncs.covers(ncs.heldCounts([ALPHA(2)]), new Map()), false);
  // Lists are accepted directly too.
  assert.strictEqual(ncs.covers([ALPHA(2), BETA(1)], SET.items), true);
});

test("extraLoad: spare copies across every item, never negative", () => {
  const req = ncs.requiredFromSet(SET);
  assert.strictEqual(ncs.extraLoad(ncs.heldCounts([ALPHA(2), BETA(1)]), req), 0);
  assert.strictEqual(ncs.extraLoad(ncs.heldCounts([ALPHA(3), BETA(1), GAMMA(2)]), req), 3);
  assert.strictEqual(ncs.extraLoad(ncs.heldCounts([ALPHA(1)]), req), 0);
});

test("orderCandidates: leanest first, then freshest read, then login; stable and pure", () => {
  const t0 = new Date("2026-09-11T00:00:00Z");
  const t1 = new Date("2026-09-11T01:00:00Z");
  const cands = [
    { loginLower: "fat", items: [ALPHA(2), BETA(1), GAMMA(3)], readAt: t1 },
    { loginLower: "zed", items: [ALPHA(2), BETA(1)], readAt: t0 },
    { loginLower: "amy", items: [ALPHA(2), BETA(1)], readAt: t0 },
    { loginLower: "new", items: [ALPHA(2), BETA(1)], readAt: t1 },
    { loginLower: "unread", items: [ALPHA(2), BETA(1)], readAt: null },
  ];
  const before = JSON.stringify(cands);
  const order = ncs.orderCandidates(cands, ncs.requiredFromSet(SET)).map((c) => c.loginLower);
  assert.deepStrictEqual(order, ["new", "amy", "zed", "unread", "fat"]);
  assert.strictEqual(JSON.stringify(cands), before, "input must not be reordered");
});

test("requiredDropsForSet: one {name, qty} per distinct item", () => {
  assert.deepStrictEqual(ncs.requiredDropsForSet(SET), [
    { name: "Alpha Pack", qty: 2 },
    { name: "Beta Spray", qty: 1 },
  ]);
  assert.deepStrictEqual(
    ncs.requiredDropsForSet({ items: [ALPHA(1), ALPHA(2)] }),
    [{ name: "Alpha Pack", qty: 3 }],
  );
});

test("rowFields: the exact no-claim row shape per market", () => {
  const gf = ncs.rowFields(SET, "gameflip", [{ login: "alpha" }]);
  assert.strictEqual(gf.set, SET_ID);
  assert.strictEqual(gf.noclaimStock, true);
  assert.strictEqual(gf.origin, "manual");
  assert.strictEqual(gf.accountId, "");
  assert.strictEqual(gf.accountLogin, "alpha", "a Gameflip row IS its one unit");
  assert.deepStrictEqual(gf.requiredDrops, ncs.requiredDropsForSet(SET));
  assert.strictEqual(gf.units.length, 1);
  const u = gf.units[0];
  assert.deepStrictEqual(
    { contentId: u.contentId, accountId: u.accountId, login: u.login, deliveredAt: u.deliveredAt, orderId: u.orderId },
    { contentId: "", accountId: "", login: "alpha", deliveredAt: null, orderId: "" },
  );
  assert.ok(u.addedAt instanceof Date);
  assert.ok(!("unclaimedGame" in gf) && !("autoClaimSet" in gf), "never set on a no-claim row");

  const dg = ncs.rowFields(SET, "digiseller", [
    { login: "alpha", contentId: 123 },
    { login: "bravo", contentId: "456" },
  ]);
  assert.strictEqual(dg.accountLogin, "", "only a single Gameflip unit goes in accountLogin");
  assert.deepStrictEqual(dg.units.map((x) => [x.login, x.contentId]), [["alpha", "123"], ["bravo", "456"]]);

  const gfTwo = ncs.rowFields(SET, "gameflip", [{ login: "a" }, { login: "b" }]);
  assert.strictEqual(gfTwo.accountLogin, "");

  const eld = ncs.rowFields(SET, "eldorado", []);
  assert.deepStrictEqual(eld.units, []);
  assert.strictEqual(eld.accountLogin, "");
});

test("unsupportedMessage names the market and the supported ones", () => {
  assert.strictEqual(
    ncs.unsupportedMessage("funpay"),
    "FunPay is not supported for no-claim listings yet — use Gameflip, GGSel, Plati, Eldorado, PlayerAuctions or G2G",
  );
  assert.match(ncs.unsupportedMessage("z2u"), /^Z2U is not supported/);
  assert.match(ncs.unsupportedMessage("somewhere"), /^somewhere is not supported/);
});

test("constants: markets split vault / claim-at-sale, statuses split free / committed", () => {
  assert.deepStrictEqual(ncs.VAULT_MARKETS, ["gameflip", "ggsel", "digiseller"]);
  assert.deepStrictEqual(ncs.CLAIM_AT_SALE_MARKETS, ["eldorado", "playerauctions", "g2g"]);
  assert.deepStrictEqual(ncs.SUPPORTED_MARKETS.slice().sort(), [
    "digiseller", "eldorado", "g2g", "gameflip", "ggsel", "playerauctions",
  ]);
  assert.deepStrictEqual(ncs.FREE_STATUSES, ["skipped", "released", "expired"]);
  assert.deepStrictEqual(ncs.COMMITTED_STATUSES, ["listed", "sold", "removed", "manual"]);
  assert.strictEqual(ncs.ADVERTISE_MAX, 25);
  assert.strictEqual(ncs.MARKET_LABELS.digiseller, "Plati");
  for (const m of ["funpay", "zeusx", "epicnpc", "z2u"]) {
    assert.ok(!ncs.SUPPORTED_MARKETS.includes(m), m + " must be refused");
  }
});

test("deliveryEnabled needs enabled AND autoDeliver; a missing or broken accessor is OFF", () => {
  state.settings = { enabled: true, autoDeliver: true };
  assert.strictEqual(ncs.deliveryEnabled(), true);
  state.settings = { enabled: true, autoDeliver: false };
  assert.strictEqual(ncs.deliveryEnabled(), false);
  state.settings = { enabled: false, autoDeliver: true };
  assert.strictEqual(ncs.deliveryEnabled(), false);
  const real = settingsStub.getNoclaimShopSettings;
  try {
    delete settingsStub.getNoclaimShopSettings;
    assert.strictEqual(ncs.deliveryEnabled(), false);
    settingsStub.getNoclaimShopSettings = () => {
      throw new Error("settings doc unreadable");
    };
    assert.strictEqual(ncs.deliveryEnabled(), false);
  } finally {
    settingsStub.getNoclaimShopSettings = real;
  }
});

test("poolBlockReason: the §0 pool rules, re-checked at claim time", () => {
  const ok = { status: "claimed", password: "enc", clientSecret: "cs", soldGames: [], claimedNote: "" };
  const games = ["overwatch 2"];
  assert.strictEqual(ncs.poolBlockReason(ok, games), "");
  assert.strictEqual(ncs.poolBlockReason(null, games), "no pool row");
  assert.strictEqual(ncs.poolBlockReason({ ...ok, status: "available" }, games), "pool not claimed");
  assert.strictEqual(ncs.poolBlockReason({ ...ok, manualSold: true }, games), "manual sold");
  assert.strictEqual(ncs.poolBlockReason({ ...ok, listed: true }, games), "ticked listed");
  assert.strictEqual(ncs.poolBlockReason({ ...ok, soldGames: ["overwatch 2"] }, games), "sold for this game");
  assert.strictEqual(
    ncs.poolBlockReason({ ...ok, soldGames: ["overwatch"] }, games),
    "sold for this game",
    "matched as substrings both ways, like freeReason",
  );
  assert.strictEqual(ncs.poolBlockReason({ ...ok, soldGames: ["valorant"] }, games), "");
  assert.strictEqual(ncs.poolBlockReason({ ...ok, claimedNote: "spent — unclaimed auto-listed (x)" }, games), "spent");
  assert.strictEqual(ncs.poolBlockReason({ ...ok, claimedNote: "Sold on G2G" }, games), "spent");
  assert.strictEqual(ncs.poolBlockReason({ ...ok, password: "" }, games), "no password");
  assert.strictEqual(ncs.poolBlockReason({ ...ok, password: "", credPasswordEnc: "enc" }, games), "");
  assert.strictEqual(ncs.poolBlockReason({ ...ok, clientSecret: "" }, games), "no client secret");
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

test("stockForSet: free / stale / on auto / on manual / covering from one snapshot", async () => {
  world([
    { login: "fresh1", items: [ALPHA(2), BETA(1)] },
    { login: "fresh2", items: [ALPHA(3), BETA(1)] },
    { login: "stale1", items: [ALPHA(2), BETA(1)], readAt: new Date(Date.now() - 9 * HOUR) },
    { login: "auto1", items: [ALPHA(2), BETA(1)], ledger: { status: "listed" } },
    // Our own fed claims tick the pool "listed" — freeReason then answers
    // "ticked listed", but the LEDGER says where it is committed.
    { login: "manual1", items: [ALPHA(2), BETA(1)], ledger: { status: "manual" }, pool: { listed: true }, snapshotPool: { listed: true } },
    { login: "sold1", items: [ALPHA(2), BETA(1)], ledger: { status: "sold" } },
    { login: "short1", items: [ALPHA(1), BETA(1)] },
    { login: "released", items: [ALPHA(2), BETA(1)], ledger: { status: "released" } },
  ]);
  const st = await ncs.stockForSet(SET);
  assert.deepStrictEqual(
    { free: st.free, stale: st.stale, onAuto: st.onAuto, onManual: st.onManual, covering: st.covering },
    { free: 3, stale: 1, onAuto: 1, onManual: 1, covering: 7 },
  );
  assert.ok(st.snapshotAt instanceof Date);
});

test("stockForSet: zeros on an empty snapshot, and a non-no-claim set never reads it", async () => {
  state.base = { at: null, maxAgeMs: HOUR, holdings: [], ledgerByLogin: new Map(), activeLogins: new Set(), poolById: new Map() };
  assert.deepStrictEqual(await ncs.stockForSet(SET), {
    free: 0, stale: 0, onAuto: 0, onManual: 0, covering: 0, snapshotAt: null,
  });
  state.snapshotCalls = 0;
  const archiveSet = { ...SET, stockSource: "" };
  assert.strictEqual((await ncs.stockForSet(archiveSet)).free, 0);
  assert.strictEqual(state.snapshotCalls, 0);
});

test("freeCandidates: fresh-only by default, leanest first; fresh:false adds the stale", async () => {
  world([
    { login: "fat", items: [ALPHA(2), BETA(1), GAMMA(2)] },
    { login: "lean", items: [ALPHA(2), BETA(1)] },
    { login: "old", items: [ALPHA(2), BETA(1)], readAt: new Date(Date.now() - 20 * HOUR) },
    { login: "busy", items: [ALPHA(2), BETA(1)], ledger: { status: "listed" } },
  ]);
  const fresh = await ncs.freeCandidates(SET);
  assert.deepStrictEqual(fresh.map((c) => c.loginLower), ["lean", "fat"]);
  const c = fresh[0];
  for (const k of ["loginLower", "login", "poolAccountId", "botId", "container", "game", "twitchId", "items", "readAt", "ledgerStatus"]) {
    assert.ok(k in c, "candidate carries " + k);
  }
  assert.strictEqual(fresh[1].extra, 2);
  const all = await ncs.freeCandidates(SET, { fresh: false });
  assert.deepStrictEqual(all.map((x) => x.loginLower).sort(), ["fat", "lean", "old"]);
});

test("stockForListing: a vault row advertises its undelivered units", async () => {
  const row = {
    _id: LISTING_ID,
    noclaimStock: true,
    marketplace: "ggsel",
    set: SET_ID,
    units: [{ login: "a" }, { login: "b", deliveredAt: new Date() }, { login: "c", deliveredAt: null }],
  };
  assert.strictEqual(await ncs.stockForListing(row), 2);
  assert.strictEqual(Sets.calls.length, 0, "a vault row never needs the farm");
});

test("stockForListing: claim-at-sale rows split the capped free count by id rank", async () => {
  Sets.docs.push({ ...SET });
  world(
    Array.from({ length: 7 }, (_, i) => ({ login: "acct" + i, items: [ALPHA(2), BETA(1)] })),
  );
  const ids = ["5f00000000000000000000a1", "5f00000000000000000000a2", "5f00000000000000000000a3"];
  for (const [i, id] of ids.entries()) {
    Listing.docs.push({ _id: id, noclaimStock: true, set: SET_ID, status: "active", marketplace: ["eldorado", "g2g", "playerauctions"][i] });
  }
  // Rows that must not take a share: delisted, a vault market, another set.
  Listing.docs.push({ _id: "5f00000000000000000000b1", noclaimStock: true, set: SET_ID, status: "delisted", marketplace: "eldorado" });
  Listing.docs.push({ _id: "5f00000000000000000000b2", noclaimStock: true, set: SET_ID, status: "active", marketplace: "ggsel" });
  Listing.docs.push({ _id: "5f00000000000000000000b3", noclaimStock: true, set: OTHER_SET, status: "active", marketplace: "g2g" });
  const shares = [];
  for (const [i, id] of ids.entries()) {
    shares.push(await ncs.stockForListing({ _id: id, noclaimStock: true, set: SET_ID, marketplace: ["eldorado", "g2g", "playerauctions"][i] }));
  }
  assert.deepStrictEqual(shares, [3, 2, 2], "7 free over 3 offers, the spare to the lowest id");
  assert.strictEqual(shares.reduce((a, b) => a + b, 0), 7, "never more than the farm holds");
});

test("stockForListing: capped at ADVERTISE_MAX; 0 only when the stock really is 0", async () => {
  Sets.docs.push({ ...SET });
  world(Array.from({ length: 30 }, (_, i) => ({ login: "acct" + i, items: [ALPHA(2), BETA(1)] })));
  const row = { _id: LISTING_ID, noclaimStock: true, set: SET_ID, marketplace: "eldorado" };
  Listing.docs.push({ ...row, status: "active" });
  assert.strictEqual(await ncs.stockForListing(row), 25);

  world([]);
  assert.strictEqual(await ncs.stockForListing(row), 0);
  assert.strictEqual(await ncs.stockForListing({ ...row, set: null }), 0);
  assert.strictEqual(await ncs.stockForListing({ ...row, set: OTHER_SET }), 0, "set gone = nothing deliverable");
});

test("stockForListing THROWS on a DB error or a row it does not own (never a fake 0)", async () => {
  const row = { _id: LISTING_ID, noclaimStock: true, set: SET_ID, marketplace: "eldorado" };
  Sets.hooks.findById = () => {
    throw new Error("atlas down");
  };
  await assert.rejects(ncs.stockForListing(row), /atlas down/);
  Sets.hooks = {};
  Sets.docs.push({ ...SET });
  state.base = null;
  holdingsStub.snapshotBase = async () => {
    throw new Error("snapshot build failed");
  };
  try {
    await assert.rejects(ncs.stockForListing(row), /snapshot build failed/);
  } finally {
    holdingsStub.snapshotBase = async () => {
      state.snapshotCalls++;
      return state.base;
    };
  }
  await assert.rejects(ncs.stockForListing({ ...row, noclaimStock: false }), /not a no-claim listing/);
  await assert.rejects(ncs.stockForListing({ ...row, marketplace: "funpay" }), /not a no-claim market/);
});

// ---------------------------------------------------------------------------
// claimForSet
// ---------------------------------------------------------------------------

test("claimForSet refuses without reading anything: wrong set, switch off, bad market/mode/qty", async () => {
  world([{ login: "alpha", items: [ALPHA(2), BETA(1)] }]);
  const fed = { market: "ggsel", mode: "fed" };
  assert.deepStrictEqual(await ncs.claimForSet({ ...SET, stockSource: "" }, 1, fed), []);
  assert.deepStrictEqual(await ncs.claimForSet(SET, 1, { market: "funpay" }), []);
  assert.deepStrictEqual(await ncs.claimForSet(SET, 1, { market: "ggsel", mode: "gift" }), []);
  assert.deepStrictEqual(await ncs.claimForSet(SET, 0, fed), []);
  assert.deepStrictEqual(await ncs.claimForSet({ ...SET, items: [] }, 1, fed), []);
  state.settings = { enabled: true, autoDeliver: false };
  assert.deepStrictEqual(await ncs.claimForSet(SET, 1, fed), []);
  state.settings = { enabled: false, autoDeliver: true };
  assert.deepStrictEqual(await ncs.claimForSet(SET, 1, fed), []);
  assert.strictEqual(state.snapshotCalls, 0);
  assert.strictEqual(state.invCalls.length, 0);
  assert.strictEqual(Unclaimed.writes().length, 0);
});

test("claimForSet fed: creates the ledger as 'manual', ticks the pool, returns creds, logs no secret", async () => {
  world([{ login: "Alpha", botGame: "Marvel Rivals", items: [ALPHA(2), BETA(1), GAMMA(1)] }]);
  const out = await ncs.claimForSet(SET, 1, { market: "ggsel", mode: "fed" });
  assert.strictEqual(out.length, 1);
  const [acc] = out;
  assert.strictEqual(acc.login, "Alpha");
  assert.strictEqual(acc.password, "pw:Alpha");
  assert.strictEqual(acc.email, "mail:Alpha");
  assert.strictEqual(acc.poolAccountId, String(poolFor("alpha")._id));

  const rows = ledgerFor("alpha");
  assert.strictEqual(rows.length, 1);
  const l = rows[0];
  assert.strictEqual(acc.ledgerId, String(l._id));
  assert.strictEqual(l.source, "noclaim");
  assert.strictEqual(l.status, "manual");
  assert.strictEqual(l.manualPriorStatus, "", "created by the manual claim → deleted on release");
  assert.strictEqual(l.manualListing, "", "publish still in flight");
  assert.ok(l.manualAt instanceof Date && l.listedAt instanceof Date && l.lastCheckedAt instanceof Date);
  assert.strictEqual(l.market, "ggsel");
  assert.strictEqual(String(l.set), SET_ID);
  assert.strictEqual(l.note, "manual no-claim listing — ggsel");
  assert.strictEqual(l.game, "Overwatch 2", "the sold drops' game, not the bot's");
  assert.strictEqual(l.botId, "7");
  assert.strictEqual(l.container, "noclaim-bot-7");
  assert.strictEqual(l.poolAccountId, acc.poolAccountId);
  // One entry per live copy of the SET's items — the extra Gamma is not listed.
  assert.deepStrictEqual(l.drops.map((d) => d.itemKey), [
    "alpha pack|overwatch 2",
    "alpha pack|overwatch 2",
    "beta spray|overwatch 2",
  ]);
  assert.deepStrictEqual(Object.keys(l.drops[0]).sort(), ["campaign", "game", "itemKey", "name"]);

  assert.strictEqual(poolFor("alpha").listed, true, "the console's Listed tick");
  assert.deepStrictEqual(state.invCalls, ["alpha"], "one live read before the commit");
  assert.strictEqual(state.reads.length, 1);
  assert.strictEqual(state.reads[0].loginLower, "alpha");
  assert.ok(state.invalidated >= 1);

  const ev = state.events.find((e) => e.action === "claimed");
  assert.ok(ev, "claim is audited");
  assert.strictEqual(ev.category, "noclaim_shop");
  assert.strictEqual(ev.actor, "noclaimStock");
  assert.strictEqual(ev.subject, SET_ID);
  assert.strictEqual(ev.count, 1);
  assert.ok(!JSON.stringify(state.events).includes("pw:"), "never log a password");
  assert.ok(!JSON.stringify(state.events).includes("mail:"), "never log an email");
});

test("claimForSet fed on an existing FREE ledger: compare-and-set, prior status kept, identity refreshed", async () => {
  world([
    {
      login: "alpha",
      items: [ALPHA(2), BETA(1)],
      botId: "12",
      ledger: { status: "released", botId: "3", container: "noclaim-bot-3", poolAccountId: "5a0000000000000000000009", market: "gameflip", note: "drops expired" },
    },
  ]);
  const out = await ncs.claimForSet(SET, 1, { market: "digiseller", listingId: LISTING_ID, mode: "fed" });
  assert.strictEqual(out.length, 1);
  const [l] = ledgerFor("alpha");
  const cas = Unclaimed.calls.find((c) => c[0] === "updateOne" && c[2].$set.status === "manual");
  assert.deepStrictEqual(cas[1], { _id: l._id, status: "released" }, "guarded on the status it had");
  assert.strictEqual(l.status, "manual");
  assert.strictEqual(l.manualPriorStatus, "released");
  assert.strictEqual(l.manualListing, LISTING_ID);
  assert.strictEqual(l.market, "digiseller");
  // Where the account lives NOW — spendAccount acts on these later.
  assert.strictEqual(l.botId, "12");
  assert.strictEqual(l.container, "noclaim-bot-12");
  assert.strictEqual(l.poolAccountId, String(poolFor("alpha")._id));
  assert.strictEqual(l.emptyReads, 0);
  assert.strictEqual(l.firstEmptyAt, null);
  assert.strictEqual(ledgerFor("alpha").length, 1, "never a second ledger row");
});

test("claimForSet takes the LEANEST covering account first", async () => {
  world([
    { login: "fat", items: [ALPHA(4), BETA(2), GAMMA(1)] },
    { login: "lean", items: [ALPHA(2), BETA(1)] },
  ]);
  const out = await ncs.claimForSet(SET, 1, { market: "ggsel" });
  assert.deepStrictEqual(out.map((a) => a.login), ["lean"]);
  assert.deepStrictEqual(state.invCalls, ["lean"]);
});

test("claimForSet: the live read decides — failures, renames and short inventories are skipped", async () => {
  const readAt = new Date();
  world([
    { login: "broken", readAt, items: [ALPHA(2), BETA(1)], live: new Error("token invalid") },
    { login: "renamed", readAt, items: [ALPHA(2), BETA(1)], live: { sellable: sellableOf([ALPHA(2), BETA(1)]), login: "renamed_2026" } },
    { login: "expired", readAt, items: [ALPHA(2), BETA(1)], live: { sellable: sellableOf([ALPHA(1), BETA(1)]), login: "expired" } },
    { login: "good", items: [ALPHA(2), BETA(1)], readAt: new Date(readAt.getTime() - 60 * 1000) },
  ]);
  const out = await ncs.claimForSet(SET, 1, { market: "ggsel" });
  assert.deepStrictEqual(out.map((a) => a.login), ["good"]);
  // Equal lean + equal read time → login order; the older read comes last.
  assert.deepStrictEqual(state.invCalls, ["broken", "expired", "renamed", "good"]);
  assert.ok(state.reads.find((r) => r.loginLower === "broken" && /token invalid/.test(r.error)));
  assert.ok(state.reads.find((r) => r.loginLower === "renamed" && r.login === "renamed_2026"));
  for (const l of ["broken", "renamed", "expired"]) {
    assert.strictEqual(ledgerFor(l).length, 0, l + " must not be committed");
  }
});

test("claimForSet never reads an account the snapshot already knows was renamed", async () => {
  world([{ login: "oldname", snapshotLogin: "newname", items: [ALPHA(2), BETA(1)] }]);
  assert.deepStrictEqual(await ncs.claimForSet(SET, 1, { market: "ggsel" }), []);
  assert.strictEqual(state.invCalls.length, 0);
});

test("claimForSet re-checks the pool row: a manual-sold tick after the snapshot wins", async () => {
  world([
    { login: "handsold", items: [ALPHA(2), BETA(1)], pool: { manualSold: true }, snapshotPool: { manualSold: false } },
    { login: "ticked", items: [ALPHA(2), BETA(1)], pool: { listed: true }, snapshotPool: { listed: false } },
    { login: "nopw", items: [ALPHA(2), BETA(1)], pool: { password: "" }, snapshotPool: { hasPassword: true } },
    { login: "unreadable", items: [ALPHA(2), BETA(1)], pool: { password: "undecryptable" } },
  ]);
  assert.deepStrictEqual(await ncs.claimForSet(SET, 1, { market: "ggsel" }), []);
  assert.strictEqual(state.invCalls.length, 0, "no Twitch read is spent on an account we could not sell");
  assert.strictEqual(Unclaimed.writes().length, 0);
});

test("claimForSet: an account already on an active listing is never committed", async () => {
  world([
    { login: "alpha", items: [ALPHA(2), BETA(1)] },
    { login: "bravo", items: [ALPHA(2), BETA(1)] },
  ]);
  state.active = (login) => (login === "alpha" ? [{ _id: "5f00000000000000000000c1", marketplace: "gameflip" }] : []);
  const out = await ncs.claimForSet(SET, 1, { market: "ggsel" });
  assert.deepStrictEqual(out.map((a) => a.login), ["bravo"]);
  assert.strictEqual(ledgerFor("alpha").length, 0);
});

test("claimForSet: the ledger in the DB beats the cached snapshot (committed or duplicated → skip)", async () => {
  world([
    // The snapshot has no ledger for these; the DB does.
    { login: "alpha", items: [ALPHA(2), BETA(1)], ledger: { status: "listed", market: "gameflip" }, snapshotLedger: false },
    { login: "bravo", items: [ALPHA(2), BETA(1)], ledger: { status: "skipped" }, snapshotLedger: false },
    { login: "charlie", items: [ALPHA(2), BETA(1)] },
  ]);
  // A second, committed ledger row for bravo: ambiguous → never guess.
  Unclaimed.docs.push({ _id: oid(), source: "noclaim", login: "bravo", loginLower: "bravo", status: "sold" });
  const out = await ncs.claimForSet(SET, 1, { market: "ggsel" });
  assert.deepStrictEqual(out.map((a) => a.login), ["charlie"]);
  assert.strictEqual(ledgerFor("alpha")[0].status, "listed", "the auto-lister's unit is untouched");
  assert.deepStrictEqual(ledgerFor("bravo").map((l) => l.status).sort(), ["skipped", "sold"]);
});

test("claimForSet: losing the compare-and-set moves on to the next account", async () => {
  const shared = new Date();
  world([
    { login: "alpha", items: [ALPHA(2), BETA(1)], readAt: shared, ledger: { status: "skipped" } },
    { login: "bravo", items: [ALPHA(2), BETA(1)], readAt: shared },
  ]);
  // The auto-lister lists alpha between our read and our write.
  Unclaimed.hooks.updateOne = (q) => {
    if (q.status === "skipped") {
      const d = Unclaimed.docs.find((x) => x.loginLower === "alpha");
      if (d) d.status = "listed";
    }
  };
  const out = await ncs.claimForSet(SET, 1, { market: "ggsel" });
  assert.deepStrictEqual(out.map((a) => a.login), ["bravo"]);
  assert.strictEqual(ledgerFor("alpha")[0].status, "listed");
  assert.notStrictEqual(poolFor("alpha").listed, true);
});

test("claimForSet: a ledger created beside ours makes ours back off and vanish", async () => {
  world([{ login: "alpha", items: [ALPHA(2), BETA(1)] }]);
  Unclaimed.hooks.create = (doc, model) => {
    model.docs.push({ _id: oid(), source: "noclaim", login: "alpha", loginLower: "alpha", status: "listed" });
  };
  assert.deepStrictEqual(await ncs.claimForSet(SET, 1, { market: "ggsel" }), []);
  const rows = ledgerFor("alpha");
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].status, "listed", "only the racer's row is left");
  assert.notStrictEqual(poolFor("alpha").listed, true);
});

test("claimForSet: a listing that appears after the commit rolls an existing ledger back EXACTLY", async () => {
  const listedAt = new Date("2026-09-01T00:00:00Z");
  const drops = [{ name: "Old Drop", game: "Overwatch 2", campaign: "Winter", itemKey: "old drop|overwatch 2" }];
  world([
    {
      login: "alpha",
      items: [ALPHA(2), BETA(1)],
      ledger: { status: "released", market: "gameflip", set: OTHER_SET, note: "drops expired", drops, listedAt, emptyReads: 2, botId: "7" },
    },
  ]);
  const before = structuredClone(ledgerFor("alpha")[0]);
  // Empty at the first check, a racing row at the re-check.
  state.active = (login, nth) => (nth === 0 ? [] : [{ _id: "5f00000000000000000000c9", marketplace: "gameflip", origin: "unclaimed" }]);
  assert.deepStrictEqual(await ncs.claimForSet(SET, 1, { market: "ggsel" }), []);
  const after = ledgerFor("alpha")[0];
  for (const k of Object.keys(before)) {
    assert.deepStrictEqual(after[k], before[k], "field " + k + " restored");
  }
  assert.strictEqual(after.manualListing, "");
  assert.strictEqual(after.manualPriorStatus, "");
  assert.strictEqual(after.manualAt, null);
  assert.notStrictEqual(poolFor("alpha").listed, true, "the pool tick only follows a kept claim");
});

test("claimForSet: a post-commit conflict deletes a ledger the claim created", async () => {
  world([{ login: "alpha", items: [ALPHA(2), BETA(1)] }]);
  state.active = (login, nth) => (nth === 0 ? [] : [{ _id: "5f00000000000000000000c9" }]);
  assert.deepStrictEqual(await ncs.claimForSet(SET, 1, { market: "ggsel", mode: "fed" }), []);
  assert.strictEqual(ledgerFor("alpha").length, 0);
});

test("claimForSet: the row being filled does not count as a conflict at the re-check", async () => {
  world([{ login: "alpha", items: [ALPHA(2), BETA(1)] }]);
  state.active = (login, nth) => (nth === 0 ? [] : [{ _id: LISTING_ID }]);
  const out = await ncs.claimForSet(SET, 1, { market: "ggsel", listingId: LISTING_ID });
  assert.strictEqual(out.length, 1);
});

test("claimForSet: live reads are bounded by max(10, want × 4)", async () => {
  const accounts = Array.from({ length: 14 }, (_, i) => ({
    login: "acct" + String(i).padStart(2, "0"),
    items: [ALPHA(2), BETA(1)],
    live: new Error("gql timeout"),
  }));
  world(accounts);
  assert.deepStrictEqual(await ncs.claimForSet(SET, 1, { market: "ggsel" }), []);
  assert.strictEqual(state.invCalls.length, 10);
  state.invCalls = [];
  assert.deepStrictEqual(await ncs.claimForSet(SET, 3, { market: "ggsel" }), []);
  assert.strictEqual(state.invCalls.length, 12);
});

test("claimForSet: a stale snapshot row still qualifies after the fresh ones — the live read decides", async () => {
  world([
    { login: "stale", items: [ALPHA(2), BETA(1)], readAt: new Date(Date.now() - 30 * HOUR) },
    { login: "fresh", items: [ALPHA(2), BETA(1)], live: { sellable: sellableOf([BETA(1)]), login: "fresh" } },
  ]);
  const out = await ncs.claimForSet(SET, 1, { market: "eldorado", listingId: LISTING_ID, orderId: "E-1", mode: "sold" });
  assert.deepStrictEqual(state.invCalls, ["fresh", "stale"]);
  assert.deepStrictEqual(out.map((a) => a.login), ["stale"]);
});

test("claimForSet dryRun: same walk and live checks, zero commits, works with delivery off", async () => {
  world([
    { login: "alpha", items: [ALPHA(2), BETA(1)], ledger: { status: "skipped" } },
    { login: "bravo", items: [ALPHA(2), BETA(1)] },
  ]);
  state.settings = { enabled: true, autoDeliver: false };
  const out = await ncs.claimForSet(SET, 5, { market: "eldorado", dryRun: true });
  assert.deepStrictEqual(out.map((a) => a.login).sort(), ["alpha", "bravo"]);
  const alpha = out.find((a) => a.login === "alpha");
  assert.strictEqual(alpha.ledgerId, String(ledgerFor("alpha")[0]._id));
  assert.strictEqual(alpha.password, "pw:alpha");
  assert.strictEqual(out.find((a) => a.login === "bravo").ledgerId, "");
  assert.strictEqual(Unclaimed.writes().length, 0);
  assert.strictEqual(Pool.writes().length, 0);
  assert.strictEqual(state.reads.length, 2, "the snapshot is still refreshed from the reads");
  assert.strictEqual(state.events.length, 0);
});

test("claimForSet sold: the ledger goes straight to 'sold', anchored to the order", async () => {
  world([{ login: "alpha", items: [ALPHA(2), BETA(1)], ledger: { status: "skipped", soldPriceUsd: 9 } }]);
  const out = await ncs.claimForSet(SET, 1, { market: "g2g", listingId: LISTING_ID, orderId: "G-9", mode: "sold" });
  assert.strictEqual(out.length, 1);
  const [l] = ledgerFor("alpha");
  assert.strictEqual(l.status, "sold");
  assert.ok(l.soldAt instanceof Date);
  assert.strictEqual(l.soldMarket, "g2g");
  assert.strictEqual(l.soldPriceUsd, 0, "a previous life's price is not this sale's");
  assert.strictEqual(l.note, "g2g order G-9");
  assert.strictEqual(l.manualListing, LISTING_ID);
  assert.strictEqual(l.manualSpentAt, null);
  assert.strictEqual(l.manualDeliveredAt, null, "claimed is not delivered — only markSold says so");
  assert.strictEqual(l.manualPriorStatus, "skipped");
  assert.notStrictEqual(poolFor("alpha").listed, true, "no Listed tick for a sold account");
});

test("claimForSet clears a reused row's stale delivery/spend stamps", async () => {
  const old = new Date("2026-08-01T00:00:00Z");
  world([{ login: "alpha", items: [ALPHA(2), BETA(1)], ledger: { status: "released", manualDeliveredAt: old, manualSpentAt: old } }]);
  await ncs.claimForSet(SET, 1, { market: "eldorado", listingId: LISTING_ID, orderId: "E-2", mode: "sold" });
  const [l] = ledgerFor("alpha");
  assert.strictEqual(l.manualDeliveredAt, null);
  assert.strictEqual(l.manualSpentAt, null);
  assert.strictEqual(await ncs.spendPending(), 0, "an undelivered order is never spent");
});

test("claimForSet sold: a retry of the same order re-sends the SAME accounts without reading the farm", async () => {
  world([{ login: "bravo", items: [ALPHA(2), BETA(1)] }]);
  const pool = { _id: oid(), username: "alpha", usernameLower: "alpha", status: "claimed", password: "enc", clientSecret: "cs-alpha" };
  Pool.docs.push(pool);
  Unclaimed.docs.push({
    _id: oid(), source: "noclaim", login: "alpha", loginLower: "alpha", status: "sold",
    manualListing: LISTING_ID, note: "eldorado order E-7", poolAccountId: String(pool._id),
    soldAt: new Date(), manualAt: new Date(),
  });
  const opts = { market: "eldorado", listingId: LISTING_ID, orderId: "E-7", mode: "sold" };
  const again = await ncs.claimForSet(SET, 1, opts);
  assert.deepStrictEqual(again.map((a) => [a.login, a.password]), [["alpha", "pw:alpha"]]);
  assert.strictEqual(state.snapshotCalls, 0);
  assert.strictEqual(state.invCalls.length, 0);

  // Two ordered, one already taken: only the difference is topped up.
  const two = await ncs.claimForSet(SET, 2, opts);
  assert.deepStrictEqual(two.map((a) => a.login), ["alpha", "bravo"]);
  assert.deepStrictEqual(state.invCalls, ["bravo"]);
  assert.strictEqual(ledgerFor("bravo")[0].note, "eldorado order E-7");

  // A third try of the 2-account order resumes both, claims nothing.
  state.invCalls = [];
  const three = await ncs.claimForSet(SET, 2, opts);
  assert.deepStrictEqual(three.map((a) => a.login).sort(), ["alpha", "bravo"]);
  assert.strictEqual(state.invCalls.length, 0);
});

test("claimForSet sold: an unreadable resumed account still counts — short return, no replacement", async () => {
  world([{ login: "bravo", items: [ALPHA(2), BETA(1)] }]);
  const pool = { _id: oid(), username: "alpha", status: "claimed", password: "undecryptable", clientSecret: "cs" };
  Pool.docs.push(pool);
  Unclaimed.docs.push({
    _id: oid(), source: "noclaim", login: "alpha", loginLower: "alpha", status: "sold",
    manualListing: LISTING_ID, note: "playerauctions order P-1", poolAccountId: String(pool._id), manualAt: new Date(),
  });
  const out = await ncs.claimForSet(SET, 1, { market: "playerauctions", listingId: LISTING_ID, orderId: "P-1", mode: "sold" });
  assert.deepStrictEqual(out, []);
  assert.strictEqual(ledgerFor("bravo").length, 0, "bravo is not burned for an order that already holds an account");
});

test("claimForSet: another order's sold ledgers are never resumed", async () => {
  world([{ login: "bravo", items: [ALPHA(2), BETA(1)] }]);
  Unclaimed.docs.push({
    _id: oid(), source: "noclaim", login: "alpha", loginLower: "alpha", status: "sold",
    manualListing: LISTING_ID, note: "eldorado order OTHER", poolAccountId: "", manualAt: new Date(),
  });
  const out = await ncs.claimForSet(SET, 1, { market: "eldorado", listingId: LISTING_ID, orderId: "E-8", mode: "sold" });
  assert.deepStrictEqual(out.map((a) => a.login), ["bravo"]);
});

// ---------------------------------------------------------------------------
// attachListing / releaseClaim / markSold / spendPending / ledgerForLogin
// ---------------------------------------------------------------------------

function ledgerDoc(fields) {
  const d = { _id: oid(), source: "noclaim", login: "x", loginLower: "x", status: "manual", manualListing: "", manualPriorStatus: "", manualAt: new Date(), ...fields };
  Unclaimed.docs.push(d);
  return d;
}

test("attachListing points only 'manual' ledgers at the row", async () => {
  const a = ledgerDoc({ login: "a", loginLower: "a" });
  const b = ledgerDoc({ login: "b", loginLower: "b", status: "sold" });
  const n = await ncs.attachListing([String(a._id), b._id, "not-an-id", null], LISTING_ID);
  assert.strictEqual(n, 1);
  assert.strictEqual(a.manualListing, LISTING_ID);
  assert.strictEqual(b.manualListing, "");
  assert.strictEqual(await ncs.attachListing([a._id], ""), 0);
  assert.strictEqual(await ncs.attachListing([], LISTING_ID), 0);
});

test("releaseClaim: created rows are deleted, reused rows go back, sold rows are never touched", async () => {
  const created = ledgerDoc({ login: "new", loginLower: "new", manualPriorStatus: "", manualListing: LISTING_ID, poolAccountId: "p1" });
  const reused = ledgerDoc({ login: "old", loginLower: "old", manualPriorStatus: "released", manualListing: LISTING_ID, poolAccountId: "p2" });
  const sold = ledgerDoc({ login: "gone", loginLower: "gone", status: "sold", manualPriorStatus: "skipped" });
  const n = await ncs.releaseClaim([created._id, reused._id, sold._id], { reason: "gameflip publish failed" });
  assert.strictEqual(n, 2);
  assert.strictEqual(ledgerFor("new").length, 0);
  const [r] = ledgerFor("old");
  assert.strictEqual(r.status, "released");
  assert.strictEqual(r.manualListing, "");
  assert.strictEqual(r.manualPriorStatus, "");
  assert.strictEqual(r.manualAt, null);
  assert.strictEqual(r.note, "manual listing released — gameflip publish failed");
  assert.strictEqual(ledgerFor("gone")[0].status, "sold");
  assert.deepStrictEqual(state.unlisted.sort(), [String(created._id), String(reused._id)].sort());
  assert.ok(state.events.find((e) => e.action === "released" && e.count === 2));
  // Idempotent: a second release finds nothing left to release.
  assert.strictEqual(await ncs.releaseClaim([created._id, reused._id]), 0);
});

test("releaseClaim never restores a committed status it did not come from", async () => {
  const odd = ledgerDoc({ login: "odd", loginLower: "odd", manualPriorStatus: "listed" });
  assert.strictEqual(await ncs.releaseClaim([odd._id]), 1);
  assert.strictEqual(ledgerFor("odd")[0].status, "skipped");
});

test("markSold: 'manual' → 'sold' stamps the delivery and never touches manualSpentAt", async () => {
  const l = ledgerDoc({ login: "a", loginLower: "a", market: "ggsel", manualListing: LISTING_ID });
  assert.strictEqual(await ncs.markSold([l._id], { market: "ggsel", priceUsd: 4.5 }), 1);
  assert.strictEqual(l.status, "sold");
  assert.ok(l.soldAt instanceof Date);
  assert.ok(l.manualDeliveredAt instanceof Date);
  assert.strictEqual(l.soldMarket, "ggsel");
  assert.strictEqual(l.soldPriceUsd, 4.5);
  assert.strictEqual(l.note, "ggsel sale");
  const markSoldSets = Unclaimed.calls.filter((c) => c[0] === "updateOne").map((c) => c[2].$set);
  assert.ok(markSoldSets.every((s) => !("manualSpentAt" in s)), "markSold never writes manualSpentAt");

  // The bookkeeping ran; a repeat keeps every stamp it already has.
  const spentAt = new Date("2026-09-11T02:00:00Z");
  const soldAt = l.soldAt;
  const deliveredAt = l.manualDeliveredAt;
  l.manualSpentAt = spentAt;
  assert.strictEqual(await ncs.markSold([l._id], { market: "ggsel", reason: "qty-sale" }), 1);
  assert.strictEqual(l.manualSpentAt.getTime(), spentAt.getTime());
  assert.strictEqual(l.soldAt.getTime(), soldAt.getTime(), "soldAt is kept");
  assert.strictEqual(l.manualDeliveredAt.getTime(), deliveredAt.getTime(), "manualDeliveredAt is kept");
  assert.strictEqual(l.soldPriceUsd, 4.5, "a repeat without a price keeps the recorded one");
  assert.strictEqual(l.note, "qty-sale");
});

test("markSold on a claim-at-sale ledger records the price and keeps the order anchor", async () => {
  const soldAt = new Date("2026-09-10T10:00:00Z");
  const l = ledgerDoc({ login: "a", loginLower: "a", status: "sold", market: "eldorado", soldMarket: "eldorado", note: "eldorado order E-1", soldAt, manualListing: LISTING_ID, manualSpentAt: null, manualDeliveredAt: null });
  assert.strictEqual(await ncs.markSold([l._id], { market: "eldorado", priceUsd: 7, orderId: "E-1" }), 1);
  assert.strictEqual(l.soldPriceUsd, 7);
  assert.strictEqual(l.soldAt.getTime(), soldAt.getTime());
  assert.ok(l.manualDeliveredAt instanceof Date, "the hand-over is what marks it delivered");
  assert.strictEqual(l.note, "eldorado order E-1", "an orderId with no reason keeps the resume anchor");
  // A bare repeat changes nothing that matters.
  assert.strictEqual(await ncs.markSold([l._id], {}), 1);
  assert.strictEqual(l.note, "eldorado order E-1");
  assert.strictEqual(l.soldMarket, "eldorado");
  assert.strictEqual(l.soldPriceUsd, 7);
});

test("a claim-at-sale account is not spent until handed over, and markSold twice spends it once", async () => {
  world([{ login: "alpha", items: [ALPHA(2), BETA(1)] }]);
  const opts = { market: "eldorado", listingId: LISTING_ID, orderId: "E-3", mode: "sold" };
  const [acc] = await ncs.claimForSet(SET, 1, opts);
  assert.ok(acc, "claimed");
  // Claimed and flipped to "sold", but the buyer has nothing yet (the send
  // may fail and be retried): the account must stay in its bot.
  assert.strictEqual(await ncs.spendPending(), 0);
  assert.strictEqual(state.spent.length, 0);

  // The hand-over succeeded.
  assert.strictEqual(await ncs.markSold([acc.ledgerId], { market: "eldorado", priceUsd: 6, orderId: "E-3", reason: "eldorado order E-3" }), 1);
  assert.strictEqual(await ncs.spendPending(), 1);
  assert.strictEqual(state.spent.length, 1);
  assert.strictEqual(state.spent[0].opts.priceUsd, 6);

  // A retried hand-over reports the sale again: the bookkeeping never re-runs.
  assert.strictEqual(await ncs.markSold([acc.ledgerId], { market: "eldorado", priceUsd: 6, orderId: "E-3" }), 1);
  assert.strictEqual(await ncs.spendPending(), 0);
  assert.strictEqual(state.spent.length, 1, "spendAccount ran exactly once");
  // …and the order anchor survived, so a later retry still resumes the account.
  const again = await ncs.claimForSet(SET, 1, opts);
  assert.deepStrictEqual(again.map((a) => a.ledgerId), [acc.ledgerId]);
});

test("markSold leaves other statuses and the auto-lister's own ledgers alone", async () => {
  const freeRow = ledgerDoc({ login: "f", loginLower: "f", status: "released" });
  const autoSold = { _id: oid(), source: "noclaim", login: "auto", loginLower: "auto", status: "sold", soldPriceUsd: 3, note: "gameflip sale" };
  Unclaimed.docs.push(autoSold);
  assert.strictEqual(await ncs.markSold([freeRow._id, autoSold._id], { market: "g2g", priceUsd: 99, reason: "x" }), 0);
  assert.strictEqual(freeRow.status, "released");
  assert.strictEqual(autoSold.soldPriceUsd, 3);
  assert.strictEqual(autoSold.note, "gameflip sale");
});

test("spendPending: only this layer's delivered, unspent sales, oldest first, with the contract's spend call", async () => {
  const delivered = new Date("2026-09-11T00:00:00Z");
  const older = ledgerDoc({ login: "one", loginLower: "one", status: "sold", manualListing: LISTING_ID, soldAt: new Date("2026-09-10T00:00:00Z"), soldPriceUsd: 5, soldMarket: "ggsel", note: "ggsel sale", manualDeliveredAt: delivered, manualSpentAt: null });
  const newer = ledgerDoc({ login: "two", loginLower: "two", status: "sold", manualListing: LISTING_ID, soldAt: new Date("2026-09-11T00:00:00Z"), soldMarket: "g2g", note: "", manualDeliveredAt: delivered, manualSpentAt: null });
  ledgerDoc({ login: "done", loginLower: "done", status: "sold", manualListing: LISTING_ID, soldAt: new Date(), manualDeliveredAt: delivered, manualSpentAt: new Date() });
  ledgerDoc({ login: "vault", loginLower: "vault", status: "manual", manualListing: LISTING_ID });
  ledgerDoc({ login: "orphan", loginLower: "orphan", status: "sold", manualListing: "", manualDeliveredAt: delivered, manualSpentAt: null });
  // Claimed for an order whose hand-over has not happened (or is being retried).
  ledgerDoc({ login: "inflight", loginLower: "inflight", status: "sold", manualListing: LISTING_ID, soldAt: new Date("2026-09-09T00:00:00Z"), note: "g2g order G-1", manualDeliveredAt: null, manualSpentAt: null });
  // Written before these fields existed: no manualListing / manualDeliveredAt /
  // manualSpentAt at all. A bare `$ne: ""` + `null` filter would re-spend it.
  Unclaimed.docs.push({ _id: oid(), source: "noclaim", login: "legacy", loginLower: "legacy", status: "sold", soldAt: new Date("2026-01-01T00:00:00Z") });

  const n = await ncs.spendPending({ limit: 10 });
  assert.strictEqual(n, 2);
  assert.deepStrictEqual(state.spent.map((s) => s.id), [String(older._id), String(newer._id)]);
  assert.deepStrictEqual(state.spent[0].opts, {
    priceUsd: 5,
    market: "ggsel",
    removeFromProduct: false,
    label: "manual no-claim listing",
  });
  assert.strictEqual(state.spent[0].reason, "ggsel sale");
  assert.strictEqual(state.spent[1].reason, "manual listing sale", "a blank note falls back");
  assert.ok(older.manualSpentAt instanceof Date && newer.manualSpentAt instanceof Date);
  assert.strictEqual(await ncs.spendPending(), 0, "nothing runs twice");
});

test("spendPending: one failure never blocks the rest, and hands its lease back for a retry", async () => {
  const delivered = new Date();
  const bad = ledgerDoc({ login: "bad", loginLower: "bad", status: "sold", manualListing: LISTING_ID, soldAt: new Date("2026-09-10T00:00:00Z"), manualDeliveredAt: delivered, manualSpentAt: null });
  const good = ledgerDoc({ login: "good", loginLower: "good", status: "sold", manualListing: LISTING_ID, soldAt: new Date("2026-09-11T00:00:00Z"), manualDeliveredAt: delivered, manualSpentAt: null });
  state.spendFail.add(String(bad._id));
  assert.strictEqual(await ncs.spendPending(), 1);
  assert.strictEqual(bad.manualSpentAt, null, "retried next pass");
  assert.ok(good.manualSpentAt instanceof Date);
  state.spendFail.clear();
  assert.strictEqual(await ncs.spendPending(), 1);
  assert.ok(bad.manualSpentAt instanceof Date);
});

test("spendPending: a row another pass leased first is never spent twice", async () => {
  const l = ledgerDoc({ login: "a", loginLower: "a", status: "sold", manualListing: LISTING_ID, soldAt: new Date(), manualDeliveredAt: new Date(), manualSpentAt: null });
  Unclaimed.hooks.updateOne = (q, u) => {
    if (u.$set && u.$set.manualSpentAt instanceof Date) l.manualSpentAt = new Date(0);
  };
  assert.strictEqual(await ncs.spendPending(), 0);
  assert.strictEqual(state.spent.length, 0);
});

test("ledgerForLogin: case-insensitive, null when unknown", async () => {
  const l = ledgerDoc({ login: "MixedCase", loginLower: "mixedcase", status: "skipped" });
  const got = await ncs.ledgerForLogin("  MIXEDcase ");
  assert.strictEqual(String(got._id), String(l._id));
  assert.strictEqual(await ncs.ledgerForLogin("nobody"), null);
  assert.strictEqual(await ncs.ledgerForLogin(""), null);
});
