// Row lifecycle of owner-made no-claim Shop listings (utils/noclaimListings.js,
// docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md §4): the per-market publish, FIFO
// quantity-sale settlement, the delist release rules, manual-sold removal and
// the lifecycle pass.
//
// Mongo- and network-free. The four models are a small in-memory stand-in that
// understands exactly the queries and updates the module issues, and every
// sibling it talks to — the claim layer, the holdings snapshot, the marketplace
// client, the Gameflip fulfiller, the engine — is a recording stub swapped in
// through Module._load (the tests/manualSoldRemoval.test.js technique), so the
// module's real control flow runs end to end.
const { test, after } = require("node:test");
const assert = require("node:assert");
const Module = require("module");

process.env.CRED_SECRET ||= "test-secret";

const MOD = require.resolve("../utils/noclaimListings");

// ---------------------------------------------------------------------------
// In-memory stand-in for the models
// ---------------------------------------------------------------------------

const clone = (v) => structuredClone(v);

function eq(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (a instanceof Date || b instanceof Date) {
    return new Date(a).getTime() === new Date(b).getTime();
  }
  return String(a) === String(b);
}

// Every value at a dotted path, descending into arrays ("units.login").
function valuesAt(doc, path) {
  let vals = [doc];
  for (const part of path.split(".")) {
    const next = [];
    for (const v of vals) {
      if (Array.isArray(v)) for (const e of v) next.push(e == null ? undefined : e[part]);
      else next.push(v == null ? undefined : v[part]);
    }
    vals = next;
  }
  return vals;
}

function isOps(c) {
  return (
    !!c &&
    typeof c === "object" &&
    !Array.isArray(c) &&
    !(c instanceof Date) &&
    !(c instanceof RegExp) &&
    Object.keys(c).some((k) => k.startsWith("$"))
  );
}

function matchValue(v, cond) {
  if (cond instanceof RegExp) return typeof v === "string" && cond.test(v);
  if (!isOps(cond)) return Array.isArray(v) ? v.some((x) => eq(x, cond)) : eq(v, cond);
  return Object.entries(cond).every(([op, arg]) => {
    switch (op) {
      case "$in":
        return arg.some((a) => (Array.isArray(v) ? v.some((x) => eq(x, a)) : eq(v, a)));
      case "$ne":
        return !eq(v, arg);
      case "$gt":
        return v != null && v > arg;
      case "$lt":
        return v != null && v < arg;
      case "$elemMatch":
        return Array.isArray(v) && v.some((e) => matches(e, arg));
      default:
        throw new Error("fake mongo: unsupported operator " + op);
    }
  });
}

function matches(doc, q) {
  return Object.entries(q || {}).every(([k, cond]) =>
    valuesAt(doc, k).some((v) => matchValue(v, cond)),
  );
}

function applyUpdate(doc, u, q) {
  // The positional "$" names the element the query's $elemMatch matched —
  // fixed before any field of the update is written.
  const pos = {};
  for (const [f, cond] of Object.entries(q || {})) {
    if (cond && cond.$elemMatch && Array.isArray(doc[f])) {
      pos[f] = doc[f].findIndex((e) => matches(e, cond.$elemMatch));
    }
  }
  for (const [op, fields] of Object.entries(u)) {
    for (const [k, val] of Object.entries(fields)) {
      const m = /^(\w+)\.\$\.(\w+)$/.exec(k);
      if (op === "$set" && m) {
        const i = pos[m[1]];
        if (i == null || i < 0) throw new Error("fake mongo: positional update matched nothing");
        doc[m[1]][i][m[2]] = clone(val);
      } else if (op === "$set") {
        doc[k] = clone(val);
      } else if (op === "$inc") {
        doc[k] = (Number(doc[k]) || 0) + val;
      } else if (op === "$push") {
        if (!Array.isArray(doc[k])) doc[k] = [];
        doc[k].push(...clone(val && val.$each ? val.$each : [val]));
      } else if (op === "$pull") {
        if (Array.isArray(doc[k])) doc[k] = doc[k].filter((e) => !matches(e, val));
      } else {
        throw new Error("fake mongo: unsupported update " + op);
      }
    }
  }
}

function cmpBy(spec) {
  const val = (x) => (x == null ? -Infinity : x instanceof Date ? x.getTime() : x);
  return (a, b) => {
    for (const [k, dir] of Object.entries(spec)) {
      const av = val(a[k]);
      const bv = val(b[k]);
      if (av < bv) return -dir;
      if (av > bv) return dir;
    }
    return 0;
  };
}

function fakeModel(prefix, docs = []) {
  let seq = 0;
  const m = { docs: docs.map(clone), creates: [], updates: [], failCreate: null };
  const query = (pick) => {
    let sortSpec = null;
    let lim = null;
    const run = () => {
      const got = pick();
      if (!Array.isArray(got)) return got ? clone(got) : null;
      let out = got;
      if (sortSpec) out = out.slice().sort(cmpBy(sortSpec));
      if (lim != null) out = out.slice(0, lim);
      return out.map(clone);
    };
    const chain = {
      sort(s) {
        sortSpec = s;
        return chain;
      },
      limit(n) {
        lim = n;
        return chain;
      },
      lean() {
        return Promise.resolve().then(run);
      },
      then(ok, bad) {
        return Promise.resolve().then(run).then(ok, bad);
      },
    };
    return chain;
  };
  m.find = (q) => query(() => m.docs.filter((d) => matches(d, q)));
  m.findOne = (q) => query(() => m.docs.find((d) => matches(d, q)) || null);
  m.findById = (id) => query(() => m.docs.find((d) => eq(d._id, id)) || null);
  m.create = async (doc) => {
    if (m.failCreate) throw m.failCreate;
    const d = { _id: prefix + "-new" + ++seq, ...clone(doc) };
    m.docs.push(d);
    m.creates.push(clone(d));
    return clone(d);
  };
  m.updateOne = async (q, u) => {
    m.updates.push({ q, u });
    const d = m.docs.find((x) => matches(x, q));
    if (!d) return { matchedCount: 0, modifiedCount: 0 };
    const before = JSON.stringify(d);
    applyUpdate(d, u, q);
    return { matchedCount: 1, modifiedCount: JSON.stringify(d) === before ? 0 : 1 };
  };
  m.updateMany = async (q, u) => {
    m.updates.push({ q, u, many: true });
    let n = 0;
    for (const d of m.docs.filter((x) => matches(x, q))) {
      const before = JSON.stringify(d);
      applyUpdate(d, u, q);
      if (JSON.stringify(d) !== before) n++;
    }
    return { matchedCount: n, modifiedCount: n };
  };
  m.get = (id) => m.docs.find((d) => eq(d._id, id));
  return m;
}

// ---------------------------------------------------------------------------
// Harness: fresh module + fresh stubs per test
// ---------------------------------------------------------------------------

const SETTINGS = {
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
const LABELS = {
  gameflip: "Gameflip",
  digiseller: "Plati",
  ggsel: "GGSel",
  eldorado: "Eldorado",
  playerauctions: "PlayerAuctions",
  g2g: "G2G",
  funpay: "FunPay",
  zeusx: "ZeusX",
  epicnpc: "EpicNPC",
  z2u: "Z2U",
};
const UNSUPPORTED_TAIL =
  " is not supported for no-claim listings yet — use Gameflip, GGSel, Plati, Eldorado, " +
  "PlayerAuctions or G2G";

// Only requires made BY the module under test are intercepted, keyed by the
// request string exactly as it writes it; an unstubbed relative require fails
// loudly instead of quietly loading a real model or marketplace client.
let stubs = new Map();
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && parent.filename === MOD) {
    if (stubs.has(request)) return stubs.get(request);
    if (request.startsWith(".")) {
      throw new Error("noclaimListings required an unstubbed module: " + request);
    }
  }
  return origLoad.apply(this, arguments);
};
after(() => {
  Module._load = origLoad;
});

const SET = {
  _id: "set1",
  name: "R6 Alpha bundle",
  stockSource: "noclaim",
  coverGame: "Rainbow Six Siege",
  items: [
    {
      itemKey: "alpha pack|rainbow six siege",
      name: "Alpha Pack",
      game: "Rainbow Six Siege",
      qty: 1,
    },
  ],
};

function countBy(list, qtyOf) {
  const m = new Map();
  for (const i of list || []) m.set(i.itemKey, (m.get(i.itemKey) || 0) + qtyOf(i));
  return m;
}

function load(o = {}) {
  const db = {
    Listing: fakeModel("row", o.rows || []),
    Ledger: fakeModel("led", o.ledgers || []),
    Set: fakeModel("set", o.sets || [SET]),
    Pool: fakeModel("pool", o.pool || []),
  };
  const calls = [];
  const events = [];
  const state = {
    settings: { ...SETTINGS, ...(o.settings || {}) },
    delivery: o.delivery !== false,
    claimable: (o.claimable || []).slice(),
    stock: o.stock || null,
    share: o.share === undefined ? null : o.share,
    ggStock: o.ggStock === undefined ? null : o.ggStock,
    dsStock: o.dsStock === undefined ? null : o.dsStock,
    inventory: o.inventory || {},
    spendThrows: o.spendThrows || "",
    spendGate: null,
  };
  const rec = (fn, impl) => async (...args) => {
    calls.push({ fn, args });
    return impl ? impl(...args) : undefined;
  };
  const stubFns = (defaults, over = {}) => {
    const out = {};
    for (const [fn, impl] of Object.entries({ ...defaults, ...over })) out[fn] = rec(fn, impl);
    return out;
  };

  let contentSeq = 0;
  const mp = {
    PA_MIN_PRICE: 5,
    PA_DELIVERY: { min20: 5 },
    delistOutcome: (msg) => {
      const s = String(msg || "").toLowerCase();
      if (/\(sold\)|already sold/.test(s)) return "sold";
      if (/not found/.test(s)) return "gone";
      return "";
    },
    ...stubFns(
      {
        ggselPublish: (p) => ({
          externalId: "gg-new",
          url: "https://ggsel.net/gg-new",
          note: "",
          qty: (p.products || []).length,
        }),
        ggselEnableAutoselling: () => ({ changed: false }),
        ggselAddProducts: (id, values) => values.length,
        ggselOfferStock: () => state.ggStock,
        ggselOfferPrice: () => 950,
        ggselResolveCategoryId: () => "cat-auto",
        ggselDelist: () => undefined,
        digisellerPublish: () => ({
          externalId: "ds-new",
          url: "https://plati.market/itm/ds-new",
          price: 4,
        }),
        digisellerAddContent: (id, lines) => ({
          added: lines.length,
          contentIds: lines.map(() => "c" + ++contentSeq),
        }),
        digisellerRemoveContent: () => ({ removed: true }),
        digisellerUploadImage: () => ({}),
        digisellerProductStock: () => state.dsStock,
        digisellerDelist: () => undefined,
        gameflipListingStatus: () => "onsale",
        eldoradoPublish: () => ({ externalId: "el-1", url: "https://eldorado.gg/el-1" }),
        playerauctionsPublish: () => ({
          offerId: "pa-1",
          id: "pa-1",
          url: "https://playerauctions.com/pa-1",
        }),
        g2gPublish: () => ({ externalId: "g2g-1", url: "https://g2g.com/g2g-1" }),
      },
      o.mp,
    ),
  };
  const ncs = {
    FREE_STATUSES: ["skipped", "released", "expired"],
    VAULT_MARKETS: ["gameflip", "ggsel", "digiseller"],
    CLAIM_AT_SALE_MARKETS: ["eldorado", "playerauctions", "g2g"],
    SUPPORTED_MARKETS: ["gameflip", "ggsel", "digiseller", "eldorado", "playerauctions", "g2g"],
    ADVERTISE_MAX: 25,
    MARKET_LABELS: LABELS,
    isNoclaimSet: (s) => !!s && s.stockSource === "noclaim",
    requiredFromSet: (set) => countBy(set.items, (i) => Number(i.qty) || 1),
    heldCounts: (items) => countBy(items, (i) => (i.qty == null ? 1 : Number(i.qty))),
    covers: (held, req) => req.size > 0 && [...req].every(([k, q]) => (held.get(k) || 0) >= q),
    rowFields: (set, market, accounts) => ({
      set: set._id,
      noclaimStock: true,
      origin: "manual",
      accountId: "",
      accountLogin: market === "gameflip" && accounts.length === 1 ? accounts[0].login : "",
      requiredDrops: (set.items || []).map((i) => ({ name: i.name, qty: i.qty || 1 })),
      units: accounts.map((a) => ({
        contentId: String(a.contentId || ""),
        accountId: "",
        login: a.login,
        addedAt: new Date(),
        deliveredAt: null,
        orderId: "",
      })),
    }),
    unsupportedMessage: (m) => (LABELS[m] || m) + UNSUPPORTED_TAIL,
    deliveryEnabled: () => state.delivery,
    ...stubFns(
      {
        claimForSet: (set, want) => state.claimable.splice(0, want),
        stockForSet: () =>
          state.stock || { free: 0, stale: 0, onAuto: 0, onManual: 0, covering: [] },
        // This offer's share of the free stock; by default no other sharer.
        stockForListing: () =>
          state.share != null ? state.share : Math.min((state.stock && state.stock.free) || 0, 25),
        // The ledger writes keep the real layer's guards: attach and release
        // only ever touch "manual", markSold only "manual" / "sold".
        attachListing: (ids, listingId) => {
          let n = 0;
          for (const id of ids) {
            const l = db.Ledger.get(id);
            if (l && l.status === "manual") {
              l.manualListing = String(listingId);
              n++;
            }
          }
          return n;
        },
        releaseClaim: (ids) => {
          let n = 0;
          for (const id of ids) {
            const l = db.Ledger.get(id);
            if (!l || l.status !== "manual") continue;
            if (!l.manualPriorStatus) {
              db.Ledger.docs.splice(db.Ledger.docs.indexOf(l), 1);
            } else {
              l.status = l.manualPriorStatus;
              l.manualListing = "";
              l.manualPriorStatus = "";
            }
            n++;
          }
          return n;
        },
        markSold: (ids) => {
          let n = 0;
          for (const id of ids) {
            const l = db.Ledger.get(id);
            if (l && (l.status === "manual" || l.status === "sold")) {
              l.status = "sold";
              n++;
            }
          }
          return n;
        },
        spendPending: async () => {
          if (state.spendGate) await state.spendGate;
          if (state.spendThrows) throw new Error(state.spendThrows);
          return 0;
        },
      },
      o.ncs,
    ),
  };
  const gf = stubFns(
    {
      publishAutoDelivery: () => ({
        _id: "gf-row",
        externalId: "gf-ext",
        url: "https://gameflip.com/item/gf-ext",
        note: "",
      }),
      relistNoclaimSuccessor: () => null,
    },
    o.gf,
  );
  const ual = stubFns(
    {
      finalizeGgselOffer: () => ({ ok: true }),
      credentialForLedger: (l) => ({ login: l.login, password: "pw-" + l.login, email: "" }),
      delistRowVerified: (r) => {
        const d = db.Listing.get(r._id);
        const was = !!d && d.status === "active";
        if (was) d.status = "delisted";
        return { ok: true, changed: was };
      },
      inventoryForCandidate: (cand) => {
        const r = state.inventory[cand.login];
        if (!r) throw new Error("no inventory scripted for " + cand.login);
        return r;
      },
      markOwnerUnlisted: () => undefined,
    },
    o.ual,
  );
  const holdings = stubFns(
    { recordRead: () => undefined, sweepOnce: () => ({ read: 0 }), start: () => undefined },
    o.holdings,
  );
  stubs = new Map([
    ["../models/MarketplaceListing", db.Listing],
    ["../models/UnclaimedAccount", db.Ledger],
    ["../models/DropSet", db.Set],
    ["../models/AvailableAccount", db.Pool],
    ["./marketplaces", mp],
    [
      "./settings",
      {
        getNoclaimShopSettings: () => state.settings,
        getAutoFarm: () => ({ ggselCategoryId: "" }),
        normGameName: (s) => String(s || "").toLowerCase(),
      },
    ],
    ["./systemLog", { logEvent: (e) => events.push(e) }],
    ["./noclaimStock", ncs],
    ["./noclaimHoldings", holdings],
    ["./digisellerFulfiller", { digisellerDeliveryCode: (l, p) => "DS " + l + ":" + p }],
    ["./ggselFulfiller", { ggselDeliveryCode: (l, p) => "GG " + l + ":" + p }],
    ["./gameflipFulfiller", gf],
    ["./unclaimedAutoList", ual],
    ["./setImage", { buildSetGridImage: async () => "" }],
    ["./playerauctionsCopy", { bundleInstruction: () => "PA GUIDE" }],
  ]);
  delete require.cache[MOD];
  const mod = require(MOD);
  return { mod, db, calls, events, state, called: (fn) => calls.filter((c) => c.fn === fn) };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = Date.parse("2026-09-11T00:00:00Z");
const at = (min) => new Date(T0 + min * 60 * 1000);
const ago = (min) => new Date(Date.now() - min * 60 * 1000);
// Pool ids are ObjectId-shaped: the module refuses anything else in an _id $in.
const poolId = (n) => String(n).padStart(24, "a");
const claim = (n) => ({
  ledgerId: "L" + n,
  login: "acc" + n,
  password: "pw" + n,
  email: "",
  poolAccountId: poolId(n),
});
const ledger = (n, extra = {}) => ({
  _id: "L" + n,
  source: "noclaim",
  login: "acc" + n,
  loginLower: "acc" + n,
  status: "manual",
  manualListing: "",
  manualPriorStatus: "skipped",
  manualAt: ago(1),
  poolAccountId: poolId(n),
  set: "set1",
  game: "Rainbow Six Siege",
  note: "manual no-claim listing — ggsel",
  emptyReads: 0,
  firstEmptyAt: null,
  lastCheckedAt: null,
  ...extra,
});
const unit = (login, min, extra = {}) => ({
  contentId: "c-" + login,
  accountId: "",
  login,
  addedAt: at(min),
  deliveredAt: null,
  orderId: "",
  ...extra,
});
const row = (extra = {}) => ({
  _id: "R1",
  set: "set1",
  marketplace: "digiseller",
  externalId: "ds-9",
  status: "active",
  noclaimStock: true,
  origin: "manual",
  title: "R6 Alpha Pack account",
  description: "Holds Alpha Pack",
  price: 7,
  lastStock: null,
  qtyTarget: 0,
  lastError: "",
  requiredDrops: [{ name: "Alpha Pack", qty: 1 }],
  units: [],
  ...extra,
});
// One Gameflip no-claim row: the listing IS its single account.
const gameflipRow = (extra = {}) =>
  row({
    _id: "G1",
    marketplace: "gameflip",
    externalId: "gf-1",
    accountLogin: "acc1",
    units: [unit("acc1", 1, { contentId: "" })],
    ...extra,
  });

function ctx(body = {}, extra = {}) {
  return {
    set: SET,
    body,
    title: "R6 Alpha Pack account",
    description: "Holds Alpha Pack, unclaimed",
    priceUsd: 9.5,
    gridImage: "/tmp/grid.png",
    coverPath: "/tmp/cover.png",
    cat: {
      categoryId: "cat-9",
      categories: [{ owner: 1, categoryId: 34187 }],
      serviceId: "svc-auto",
      brandId: "brand-auto",
    },
    pubGame: "Rainbow Six Siege",
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// publishNoclaim
// ---------------------------------------------------------------------------

test("publishNoclaim: every refusal answers before anything is claimed or published", async () => {
  const cases = [
    [{ settings: { enabled: false } }, "ggsel", ctx(), /^No-claim listings are switched off$/],
    [{ delivery: false }, "ggsel", ctx(), /^No-claim auto-delivery is switched off$/],
    [{}, "funpay", ctx(), new RegExp("^FunPay" + UNSUPPORTED_TAIL + "$")],
    [{}, "zeusx", ctx(), /^ZeusX is not supported for no-claim listings yet/],
    [{}, "ggsel", ctx({}, { set: { ...SET, stockSource: "" } }), /^Not a no-claim listing/],
    [{}, "ggsel", ctx({}, { cat: {} }), /^Pick a GGSel category first$/],
  ];
  for (const [opts, market, c, re] of cases) {
    const t = load({ claimable: [claim(1)], ...opts });
    const r = await t.mod.publishNoclaim(market, c);
    assert.strictEqual(r.success, false, market + " must refuse");
    assert.match(r.message, re);
    assert.strictEqual(t.called("claimForSet").length, 0, "nothing may be claimed on a refusal");
    assert.strictEqual(t.db.Listing.creates.length, 0);
    assert.strictEqual(t.calls.filter((x) => /Publish$/.test(x.fn)).length, 0);
  }
});

test("publishNoclaim gameflip: the fulfiller's no-claim branch, 1 live + qty-1 queued", async () => {
  const t = load();
  const r = await t.mod.publishNoclaim(
    "gameflip",
    ctx({ gameflip: { qty: "3", autoDeliver: true } }),
  );
  assert.deepStrictEqual(r, {
    success: true,
    id: "gf-row",
    externalId: "gf-ext",
    url: "https://gameflip.com/item/gf-ext",
    note: "no-claim auto-delivery: 1 live, 2 queued",
  });
  const a = t.called("publishAutoDelivery")[0].args[0];
  assert.strictEqual(a.set, SET);
  assert.strictEqual(a.noclaim, true);
  assert.strictEqual(a.qtyRemaining, 2);
  assert.strictEqual(a.origin, "manual");
  assert.strictEqual(a.imagePath, "/tmp/grid.png");
  assert.strictEqual(a.priceUsd, 9.5);

  const t2 = load({
    gf: {
      publishAutoDelivery: () => {
        throw new Error("Out of stock — no free no-claim account holds this whole bundle");
      },
    },
  });
  assert.deepStrictEqual(await t2.mod.publishNoclaim("gameflip", ctx()), {
    success: false,
    message: "Out of stock — no free no-claim account holds this whole bundle",
  });
});

test("publishNoclaim ggsel: claimed codes become products; row saved, attached, finalized", async () => {
  const t = load({ claimable: [claim(1), claim(2)], ledgers: [ledger(1), ledger(2)], ggStock: 2 });
  const r = await t.mod.publishNoclaim(
    "ggsel",
    ctx({ ggsel: { quantity: "3", priceRub: 900, instructions: "claim guide" } }),
  );
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.externalId, "gg-new");

  const [cl] = t.called("claimForSet");
  assert.strictEqual(cl.args[1], 3);
  assert.deepStrictEqual(cl.args[2], { market: "ggsel", mode: "fed" });

  const pub = t.called("ggselPublish")[0].args[0];
  assert.deepStrictEqual(pub.products, ["GG acc1:pw1", "GG acc2:pw2"]);
  assert.strictEqual(pub.delivery, "auto");
  assert.strictEqual(pub.categoryId, "cat-9");
  assert.strictEqual(pub.priceRub, 900);
  assert.strictEqual(pub.instructions, "claim guide");
  assert.strictEqual(pub.coverImagePath, "/tmp/grid.png");
  assert.strictEqual(t.called("ggselEnableAutoselling")[0].args[0], "gg-new");

  const saved = t.db.Listing.get(r.id);
  assert.strictEqual(saved.noclaimStock, true);
  assert.strictEqual(saved.origin, "manual");
  assert.strictEqual(saved.accountId, "");
  assert.strictEqual(saved.accountLogin, "");
  assert.strictEqual(saved.autoDeliver, false);
  assert.strictEqual(saved.qtyTarget, 3, "the asked quantity stays the target for top-up");
  assert.strictEqual(saved.qtyRemaining, 0);
  assert.strictEqual(saved.externalNode, "cat-9", "the category is kept for a later rebuild");
  assert.strictEqual(saved.note, "no-claim auto-delivery: 2 account(s)");
  assert.deepStrictEqual(saved.units.map((u) => u.login), ["acc1", "acc2"]);
  assert.strictEqual(saved.lastStock, 2);
  assert.strictEqual(saved.price, 9.5);

  assert.deepStrictEqual(t.called("attachListing")[0].args, [["L1", "L2"], r.id]);
  assert.deepStrictEqual(t.called("finalizeGgselOffer")[0].args, ["gg-new", r.id]);
  assert.strictEqual(t.db.Ledger.get("L1").manualListing, r.id);
});

test("publishNoclaim ggsel: out of stock names the stale snapshots, publishes nothing", async () => {
  const t = load({ claimable: [], stock: { free: 0, stale: 2, onAuto: 0, onManual: 0 } });
  const r = await t.mod.publishNoclaim("ggsel", ctx({ ggsel: { quantity: 2 } }));
  assert.deepStrictEqual(r, {
    success: false,
    message:
      "Out of stock — no free no-claim account holds this whole bundle right now " +
      "(2 stale snapshot(s) — try Refresh stock)",
  });
  assert.strictEqual(t.called("ggselPublish").length, 0);
  assert.strictEqual(t.db.Listing.creates.length, 0);
});

test("publishNoclaim ggsel: a failed publish hands every claim back", async () => {
  const t = load({
    claimable: [claim(1), claim(2)],
    ledgers: [ledger(1), ledger(2)],
    mp: {
      ggselPublish: () => {
        throw new Error("GGSel create: category closed");
      },
    },
  });
  const r = await t.mod.publishNoclaim("ggsel", ctx({ ggsel: { quantity: 2 } }));
  assert.deepStrictEqual(r, { success: false, message: "GGSel create: category closed" });
  assert.deepStrictEqual(t.called("releaseClaim")[0].args[0], ["L1", "L2"]);
  assert.strictEqual(t.db.Listing.creates.length, 0);
});

test("publishNoclaim digiseller: content in chunks of 12, every contentId kept in order", async () => {
  const claims = Array.from({ length: 13 }, (_, i) => claim(i + 1));
  const t = load({
    claimable: claims,
    ledgers: claims.map((c, i) => ledger(i + 1)),
    dsStock: 13,
  });
  const r = await t.mod.publishNoclaim("digiseller", ctx({ digiseller: { quantity: 13 } }));
  assert.strictEqual(r.success, true);
  const adds = t.called("digisellerAddContent");
  assert.deepStrictEqual(adds.map((c) => c.args[1].length), [12, 1]);
  assert.strictEqual(adds[0].args[1][0], "DS acc1:pw1");
  const pub = t.called("digisellerPublish")[0].args[0];
  assert.deepStrictEqual(pub.categories, [{ owner: 1, categoryId: 34187 }]);
  const saved = t.db.Listing.get(r.id);
  assert.deepStrictEqual(
    saved.units.map((u) => [u.login, u.contentId]),
    claims.map((c, i) => [c.login, "c" + (i + 1)]),
  );
  assert.strictEqual(saved.price, 4, "Plati's floored price is what gets recorded");
  assert.strictEqual(saved.lastStock, 13);
  assert.deepStrictEqual(t.called("digisellerUploadImage")[0].args, ["ds-new", "/tmp/grid.png"]);
  assert.strictEqual(t.called("releaseClaim").length, 0);
});

test("publishNoclaim digiseller: a short content add takes the product down, claims go back", async () => {
  const t = load({
    claimable: [claim(1), claim(2)],
    ledgers: [ledger(1), ledger(2)],
    mp: { digisellerAddContent: () => ({ added: 2, contentIds: ["c1"] }) },
  });
  const r = await t.mod.publishNoclaim("digiseller", ctx({ digiseller: { quantity: 2 } }));
  assert.strictEqual(r.success, false);
  assert.match(r.message, /returned 1 ids for 2 lines/);
  assert.deepStrictEqual(t.called("digisellerDelist")[0].args, ["ds-new"]);
  assert.deepStrictEqual(t.called("releaseClaim")[0].args[0], ["L1", "L2"]);
  assert.strictEqual(t.db.Listing.creates.length, 0);
});

test("publishNoclaim digiseller: a half-fed product that won't come down pins what it holds", async () => {
  const claims = Array.from({ length: 13 }, (_, i) => claim(i + 1));
  const t = load({
    claimable: claims,
    ledgers: claims.map((c, i) => ledger(i + 1)),
    mp: {
      // The first chunk comes back one id short; the product then refuses to
      // be disabled for a reason that does not mean "already off sale".
      digisellerAddContent: (id, lines) => ({
        added: lines.length,
        contentIds: lines.slice(1).map((_, i) => "c" + i),
      }),
      digisellerDelist: () => {
        throw new Error("Digiseller delist: HTTP 502");
      },
    },
  });
  const r = await t.mod.publishNoclaim("digiseller", ctx({ digiseller: { quantity: 13 } }));
  assert.strictEqual(r.success, false);
  assert.match(r.message, /delist it by hand: ds-new/);
  // Only the 13th account never reached Plati; the 12 that may have are kept.
  const released = t.called("releaseClaim").flatMap((c) => c.args[0]);
  assert.deepStrictEqual(released, ["L13"]);
  for (let i = 1; i <= 12; i++) {
    const l = t.db.Ledger.get("L" + i);
    assert.strictEqual(l.status, "manual");
    assert.match(l.note, /^unrecorded publish — Plati ds-new/);
  }
  assert.ok(t.events.some((e) => e.action === "publish_orphan" && e.severity === "error"));
});

test("publishNoclaim: a row that cannot be saved after the publish releases nothing", async () => {
  const t = load({ claimable: [claim(1)], ledgers: [ledger(1)] });
  t.db.Listing.failCreate = new Error("MarketplaceListing validation failed");
  const r = await t.mod.publishNoclaim("ggsel", ctx({ ggsel: { quantity: 1 } }));
  assert.deepStrictEqual(r, {
    success: false,
    message: "published on GGSel but the row could not be saved — delist it by hand: gg-new",
  });
  assert.strictEqual(t.called("releaseClaim").length, 0, "the credentials are in GGSel's vault");
  assert.strictEqual(t.db.Ledger.get("L1").status, "manual");
  assert.match(t.db.Ledger.get("L1").note, /^unrecorded publish — GGSel gg-new/);
  assert.ok(t.events.some((e) => e.action === "publish_orphan" && e.severity === "error"));
});

test("publishNoclaim claim-at-sale: advertises min(requested, free, 25), claims nothing", async () => {
  const el = load({ stock: { free: 3, stale: 0 } });
  const r = await el.mod.publishNoclaim(
    "eldorado",
    ctx({ eldorado: { quantity: 10, minQuantity: 5 } }),
  );
  assert.strictEqual(r.success, true);
  const e = el.called("eldoradoPublish")[0].args[0];
  assert.strictEqual(e.quantity, 3);
  assert.strictEqual(e.minQuantity, 3, "a minimum above what is advertised is capped");
  assert.strictEqual(e.game, "Rainbow Six Siege");
  assert.strictEqual(e.coverImagePath, "/tmp/grid.png");
  const saved = el.db.Listing.get(r.id);
  assert.strictEqual(saved.marketplace, "eldorado");
  assert.strictEqual(saved.externalId, "el-1");
  assert.strictEqual(saved.qtyTarget, 3);
  assert.strictEqual(saved.noclaimStock, true);
  assert.strictEqual(saved.autoDeliver, false);
  assert.deepStrictEqual(saved.units, []);
  assert.strictEqual(el.called("claimForSet").length, 0);

  const pa = load({ stock: { free: 40 } });
  const r2 = await pa.mod.publishNoclaim(
    "playerauctions",
    ctx({ playerauctions: { quantity: 50 } }, { priceUsd: 2 }),
  );
  assert.strictEqual(r2.success, true);
  assert.strictEqual(r2.externalId, "pa-1", "PlayerAuctions answers offerId, never externalId");
  const a = pa.called("playerauctionsPublish")[0].args[0];
  assert.strictEqual(a.totalUnit, 25);
  assert.strictEqual(a.priceUsd, 5, "PlayerAuctions' platform minimum");
  assert.strictEqual(a.instruction, "PA GUIDE");
  assert.strictEqual(a.itemsPerUnit, 1);
  assert.strictEqual(a.deliveryGuarantee, 5);
  assert.strictEqual(pa.db.Listing.get(r2.id).price, 5);

  const g = load({ stock: { free: 4 } });
  const r3 = await g.mod.publishNoclaim("g2g", ctx({ g2g: { qty: 2 } }));
  assert.strictEqual(r3.success, true);
  const b = g.called("g2gPublish")[0].args[0];
  assert.strictEqual(b.qty, 2);
  assert.strictEqual(b.brandId, "brand-auto", "no owner pick: the resolved brand and service");
  assert.strictEqual(b.serviceId, "svc-auto");
  assert.strictEqual(b.productId, undefined);

  // Other offers of the set already advertise every free account: this one's
  // share is 0, so it is refused instead of over-advertising.
  const full = load({ stock: { free: 3 }, share: 0 });
  const rFull = await full.mod.publishNoclaim("eldorado", ctx({ eldorado: { quantity: 2 } }));
  assert.strictEqual(rFull.success, false);
  assert.match(rFull.message, /already advertised by your other no-claim listings/);
  assert.strictEqual(full.called("eldoradoPublish").length, 0);
  // And a partial share caps the quantity below the free count.
  const part = load({ stock: { free: 6 }, share: 2 });
  await part.mod.publishNoclaim("eldorado", ctx({ eldorado: { quantity: 5 } }));
  assert.strictEqual(part.called("eldoradoPublish")[0].args[0].quantity, 2);

  const none = load({ stock: { free: 0, stale: 5 } });
  const r4 = await none.mod.publishNoclaim("eldorado", ctx({ eldorado: { quantity: 1 } }));
  assert.deepStrictEqual(r4, {
    success: false,
    message: "Out of stock — no free no-claim account holds this whole bundle right now",
  });
  assert.strictEqual(none.called("eldoradoPublish").length, 0);
});

// ---------------------------------------------------------------------------
// settleQuantitySales
// ---------------------------------------------------------------------------

test("settleQuantitySales: a stock drop sells the OLDEST undelivered units (FIFO)", async () => {
  const r1 = row({
    lastStock: 4,
    units: [
      unit("acc2", 2),
      unit("acc1", 1),
      unit("acc3", 3),
      unit("acc9", 0, { deliveredAt: at(5), orderId: "qty-sale" }),
    ],
  });
  const t = load({
    rows: [r1],
    ledgers: [1, 2, 3].map((n) => ledger(n, { manualListing: "R1" })),
    dsStock: 2,
  });
  assert.strictEqual(await t.mod.settleQuantitySales(r1), 2);
  const after = t.db.Listing.get("R1");
  const byLogin = Object.fromEntries(after.units.map((u) => [u.login, u]));
  assert.ok(byLogin.acc1.deliveredAt && byLogin.acc1.orderId === "qty-sale");
  assert.ok(byLogin.acc2.deliveredAt && byLogin.acc2.orderId === "qty-sale");
  assert.strictEqual(byLogin.acc3.deliveredAt, null, "the newest unit is still for sale");
  assert.strictEqual(after.lastStock, 2);
  const sales = t.called("markSold");
  assert.deepStrictEqual(sales.map((c) => c.args[0]), [["L1"], ["L2"]]);
  assert.deepStrictEqual(sales[0].args[1], {
    market: "digiseller",
    priceUsd: 7,
    reason: "digiseller sale",
  });
  assert.strictEqual(t.db.Ledger.get("L3").status, "manual");
});

test("settleQuantitySales: unreadable stock sells nothing; a first read only sets it", async () => {
  const r1 = row({ lastStock: 4, units: [unit("acc1", 1)] });
  const t = load({ rows: [r1], ledgers: [ledger(1, { manualListing: "R1" })], dsStock: null });
  assert.strictEqual(await t.mod.settleQuantitySales(r1), 0);
  assert.strictEqual(t.db.Listing.get("R1").lastStock, 4, "an unknown stock keeps the baseline");
  assert.strictEqual(t.called("markSold").length, 0);

  const fresh = row({ lastStock: null, units: [unit("acc1", 1)] });
  const t2 = load({ rows: [fresh], ledgers: [ledger(1, { manualListing: "R1" })], dsStock: 3 });
  assert.strictEqual(await t2.mod.settleQuantitySales(fresh), 0);
  assert.strictEqual(t2.db.Listing.get("R1").lastStock, 3);
  assert.strictEqual(t2.called("markSold").length, 0);
});

test("settleQuantitySales: a drop another settler already counted is never counted twice", async () => {
  const r1 = row({ lastStock: 3, units: [unit("acc1", 1), unit("acc2", 2)] });
  let t = null;
  t = load({
    rows: [r1],
    ledgers: [1, 2].map((n) => ledger(n, { manualListing: "R1" })),
    mp: {
      // Another process settles this very drop while our stock read is out.
      digisellerProductStock: () => {
        t.db.Listing.get("R1").lastStock = 2;
        return 2;
      },
    },
  });
  assert.strictEqual(await t.mod.settleQuantitySales(r1), 0);
  assert.strictEqual(t.called("markSold").length, 0);
  assert.ok(t.db.Listing.get("R1").units.every((u) => !u.deliveredAt));
});

// ---------------------------------------------------------------------------
// Delist hooks
// ---------------------------------------------------------------------------

test("afterDelist: only undelivered units committed to THIS row are handed back", async () => {
  const r1 = row({
    marketplace: "ggsel",
    externalId: "gg-1",
    lastStock: 4,
    units: [
      unit("acc1", 1),
      unit("acc2", 2),
      unit("acc3", 3),
      unit("acc4", 4, { deliveredAt: at(9), orderId: "qty-sale" }),
      unit("acc5", 5),
    ],
  });
  const r2 = row({ _id: "R2", marketplace: "ggsel", externalId: "gg-2" });
  const t = load({
    rows: [r1, r2],
    ledgers: [
      ledger(1, { manualListing: "R1" }),
      ledger(2, { manualListing: "R2" }), // committed to another LIVE row
      ledger(3, { status: "sold", manualListing: "R1" }), // a buyer has it
      ledger(4, { manualListing: "R1" }), // its unit was delivered
      ledger(5, { manualListing: "" }), // publish had not attached yet
    ],
    ggStock: 4,
  });
  assert.deepStrictEqual(await t.mod.beforeDelist(r1), { sold: 0 });
  t.db.Listing.get("R1").status = "delisted"; // what the route does next
  const out = await t.mod.afterDelist(r1, { outcome: "" });
  assert.deepStrictEqual(out, { released: 2, sold: 0, held: 0 });
  const rel = t.called("releaseClaim");
  assert.strictEqual(rel.length, 1);
  assert.deepStrictEqual(rel[0].args[0], ["L1", "L5"]);
  assert.strictEqual(t.db.Ledger.get("L2").status, "manual");
  assert.strictEqual(t.db.Ledger.get("L3").status, "sold");
  assert.strictEqual(t.db.Ledger.get("L4").status, "manual");
  const ev = t.events.find((e) => e.action === "delisted");
  assert.strictEqual(ev.category, "noclaim_shop");
  assert.strictEqual(ev.count, 2);
});

test("afterDelist: claim-at-sale hands nothing back; Gameflip 'sold' sells its unit", async () => {
  const el = row({
    marketplace: "eldorado",
    externalId: "el-1",
    units: [unit("acc1", 1, { contentId: "L1", deliveredAt: at(3), orderId: "o-1" })],
  });
  const t = load({ rows: [el], ledgers: [ledger(1, { status: "sold", manualListing: "R1" })] });
  const none = await t.mod.afterDelist(el, { outcome: "" });
  assert.deepStrictEqual(none, { released: 0, sold: 0, held: 0 });
  assert.strictEqual(t.called("releaseClaim").length, 0);

  const g1 = gameflipRow({ price: 12 });
  const g = load({ rows: [g1], ledgers: [ledger(1, { manualListing: "G1" })] });
  const out = await g.mod.afterDelist(g1, { outcome: "sold" });
  assert.deepStrictEqual(out, { released: 0, sold: 1, held: 0 });
  assert.strictEqual(g.called("releaseClaim").length, 0);
  assert.deepStrictEqual(g.called("markSold")[0].args, [
    ["L1"],
    { market: "gameflip", priceUsd: 12, reason: "gameflip sale" },
  ]);
  const u = g.db.Listing.get("G1").units[0];
  assert.ok(u.deliveredAt);
  assert.strictEqual(u.orderId, "gameflip-sale");
});

test("afterDelist: unreadable stock HOLDS the units; the next pass settles, then releases", async () => {
  const r1 = row({ lastStock: 2, units: [unit("acc1", 1), unit("acc2", 2)] });
  const t = load({
    rows: [r1],
    ledgers: [ledger(1, { manualListing: "R1" }), ledger(2, { manualListing: "R1" })],
    dsStock: null,
    settings: { healthPerPass: 0, topUp: false },
  });
  await t.mod.beforeDelist(r1);
  t.db.Listing.get("R1").status = "delisted";
  const out = await t.mod.afterDelist(r1, { outcome: "" });
  assert.deepStrictEqual(out, { released: 0, sold: 0, held: 2 });
  assert.strictEqual(t.called("releaseClaim").length, 0, "a just-sold unit looks unsold");
  assert.match(t.db.Listing.get("R1").lastError, /^no-claim hold: 2 account\(s\) kept committed/);

  // Plati answers again, one unit lighter: that unit sold, the other goes back.
  t.state.dsStock = 1;
  const pass = await t.mod.runPass();
  assert.strictEqual(pass.settled, 1);
  assert.strictEqual(pass.heldReleased, 1);
  assert.strictEqual(t.db.Ledger.get("L1").status, "sold");
  assert.strictEqual(t.db.Ledger.get("L2").status, "skipped");
  assert.strictEqual(t.db.Listing.get("R1").lastError, "");
});

test("onGameflipRetired: the unsold unit goes back; a sold ledger never does", async () => {
  const g1 = gameflipRow();
  const t = load({ rows: [g1], ledgers: [ledger(1, { manualListing: "G1" })] });
  assert.deepStrictEqual(await t.mod.onGameflipRetired(g1, { reason: "expired" }), {
    released: 1,
  });
  assert.strictEqual(t.called("releaseClaim")[0].args[1].reason, "expired");

  const t2 = load({ rows: [g1], ledgers: [ledger(1, { status: "sold", manualListing: "G1" })] });
  assert.deepStrictEqual(await t2.mod.onGameflipRetired(g1, { reason: "expired" }), {
    released: 0,
  });
  assert.strictEqual(t2.db.Ledger.get("L1").status, "sold");
});

// ---------------------------------------------------------------------------
// Unit removal
// ---------------------------------------------------------------------------

test("removeForPoolAccount: manual-sold units come off and are parked removed, not released", async () => {
  const P = poolId(1);
  const r1 = row({ lastStock: 2, units: [unit("acc1", 1), unit("acc7", 2)] });
  const t = load({
    rows: [r1],
    ledgers: [
      ledger(1, { manualListing: "R1", poolAccountId: P }),
      ledger(2, { manualListing: "", poolAccountId: P, manualAt: ago(120) }), // long-dead publish
      ledger(3, { manualListing: "", poolAccountId: P, manualAt: ago(1) }), // mid-publish, on no row
      ledger(7, { manualListing: "R1" }),
    ],
    dsStock: 2,
  });
  const out = await t.mod.removeForPoolAccount(P, { actor: "operator" });
  assert.deepStrictEqual(out, { units: 1, rows: 1, ledgers: 2, errors: [], deferred: 1 });
  assert.strictEqual(
    t.db.Ledger.get("L3").status,
    "manual",
    "a publish still in flight is left for the next pass, never parked under it",
  );
  assert.deepStrictEqual(t.called("digisellerRemoveContent")[0].args, ["ds-9", "c-acc1"]);
  const after = t.db.Listing.get("R1");
  assert.deepStrictEqual(after.units.map((u) => u.login), ["acc7"]);
  assert.strictEqual(after.lastStock, 1, "our own removal is folded into the baseline");
  assert.strictEqual(after.status, "active", "a unit still remains on it");
  for (const id of ["L1", "L2"]) {
    assert.strictEqual(t.db.Ledger.get(id).status, "removed");
    assert.strictEqual(t.db.Ledger.get(id).note, "manual sold — removed from manual listing");
  }
  assert.strictEqual(t.db.Ledger.get("L7").status, "manual");
  assert.strictEqual(t.called("releaseClaim").length, 0);
  assert.strictEqual(t.called("markOwnerUnlisted").length, 2);
  const evs = t.events.filter((e) => e.action === "manual_sold_removed");
  assert.strictEqual(evs.length, 2);
  assert.ok(evs.every((e) => e.actor === "operator"));
});

test("removeForPoolAccount: a unit that could not be pulled keeps its ledger manual", async () => {
  const P = poolId(1);
  const r1 = row({ lastStock: 1, units: [unit("acc1", 1)] });
  const t = load({
    rows: [r1],
    ledgers: [ledger(1, { manualListing: "R1", poolAccountId: P })],
    dsStock: 1,
    mp: {
      digisellerRemoveContent: () => {
        throw new Error("Digiseller remove content: HTTP 500");
      },
    },
  });
  const out = await t.mod.removeForPoolAccount(P, {});
  assert.deepStrictEqual(out, {
    units: 0,
    rows: 0,
    ledgers: 0,
    errors: ["acc1: Digiseller remove content: HTTP 500"],
  });
  assert.strictEqual(t.db.Ledger.get("L1").status, "manual");
  assert.deepStrictEqual(t.db.Listing.get("R1").units.map((u) => u.login), ["acc1"]);
});

test("removeUnit gameflip: an unsold listing gets a successor; a sold one is left alone", async () => {
  const g1 = gameflipRow();
  const t = load({ rows: [g1], ledgers: [ledger(1, { manualListing: "G1" })] });
  const r = await t.mod.removeUnit(g1, "ACC1", { reason: "drops expired" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.removed, true);
  assert.strictEqual(t.db.Listing.get("G1").status, "delisted");
  assert.strictEqual(t.called("relistNoclaimSuccessor").length, 1);

  const t2 = load({
    rows: [g1],
    ledgers: [ledger(1, { manualListing: "G1" })],
    mp: { gameflipListingStatus: () => "sold" },
  });
  const r2 = await t2.mod.removeUnit(g1, "acc1", { reason: "drops expired" });
  assert.deepStrictEqual(r2, { ok: true, removed: false, sold: true });
  assert.strictEqual(t2.called("delistRowVerified").length, 0);
  assert.strictEqual(t2.called("relistNoclaimSuccessor").length, 0);

  // Unreadable (a 429) or not on sale proves nothing: never taken down, and
  // ok:false so no caller hands the account back.
  for (const status of [
    () => {
      throw new Error("429 Too Many Requests");
    },
    () => "draft",
  ]) {
    const t3 = load({
      rows: [gameflipRow()],
      ledgers: [ledger(1, { manualListing: "G1" })],
      mp: { gameflipListingStatus: status },
    });
    const r3 = await t3.mod.removeUnit(gameflipRow(), "acc1", { reason: "drops expired" });
    assert.strictEqual(r3.ok, false);
    assert.strictEqual(r3.removed, false);
    assert.strictEqual(t3.called("delistRowVerified").length, 0);
    assert.strictEqual(t3.called("relistNoclaimSuccessor").length, 0);
  }
});

// ---------------------------------------------------------------------------
// runPass
// ---------------------------------------------------------------------------

test("runPass: a failing step never stops the ones after it", async () => {
  const r1 = row({
    marketplace: "ggsel",
    externalId: "gg-1",
    externalNode: "cat-9",
    lastStock: 3,
    qtyTarget: 3,
    units: [unit("acc1", 1), unit("acc2", 2), unit("acc3", 3)],
  });
  const t = load({
    rows: [r1],
    ledgers: [
      ledger(1, { manualListing: "R1" }),
      ledger(2, { manualListing: "R1" }),
      ledger(3, { manualListing: "R1" }),
      ledger(9, { manualListing: "", manualAt: new Date() }),
    ],
    claimable: [claim(9)],
    ggStock: 2,
    spendThrows: "atlas down",
    settings: { healthPerPass: 0 },
  });
  const out = await t.mod.runPass();
  assert.deepStrictEqual(out.errors, ["spend: atlas down"]);
  assert.deepStrictEqual(t.called("spendPending")[0].args[0], { limit: 10 });
  assert.strictEqual(out.settled, 1, "step 2 still ran");
  assert.strictEqual(t.db.Ledger.get("L1").status, "sold");
  assert.strictEqual(out.toppedUp, 1, "step 6 still ran");
  const [cl] = t.called("claimForSet");
  assert.deepStrictEqual(cl.args[2], { market: "ggsel", listingId: "R1", mode: "fed" });
  assert.deepStrictEqual(t.called("ggselAddProducts")[0].args, ["gg-1", ["GG acc9:pw9"]]);
  const after = t.db.Listing.get("R1");
  assert.deepStrictEqual(
    after.units.filter((u) => !u.deliveredAt).map((u) => u.login),
    ["acc2", "acc3", "acc9"],
  );
  assert.strictEqual(after.lastStock, 3, "fed units are folded into the baseline");
  assert.strictEqual(t.db.Ledger.get("L9").manualListing, "R1");
  assert.ok(t.called("finalizeGgselOffer").some((c) => c.args[0] === "gg-1"));
  assert.strictEqual(t.mod.status().running, false);
  assert.strictEqual(t.mod.status().lastPass.settled, 1);
});

test("runPass: one pass at a time, and none at all while switched off", async () => {
  const off = load({ settings: { enabled: false } });
  assert.deepStrictEqual(await off.mod.runPass(), { skipped: "disabled" });
  assert.strictEqual(off.called("spendPending").length, 0);

  const t = load({ settings: { healthPerPass: 0 } });
  let open;
  t.state.spendGate = new Promise((r) => (open = r));
  const first = t.mod.runPass();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(t.mod.status().running, true);
  assert.strictEqual((await t.mod.runPass()).skipped, "running");
  open();
  assert.deepStrictEqual((await first).errors, []);
  assert.strictEqual(t.mod.status().running, false);
});

test("runPass orphans: an old unattached claim is re-homed onto its row, or pinned — never released", async () => {
  const r1 = row({ marketplace: "ggsel", externalId: "gg-1", units: [unit("acc1", 1)] });
  const t = load({
    rows: [r1],
    ledgers: [
      ledger(1, { manualAt: ago(120) }), // on R1 — the attach never landed
      ledger(2, { manualAt: ago(120) }), // on no row — the publish died
      ledger(3, { manualAt: ago(5) }), // may still be publishing
      ledger(4, { status: "sold", manualAt: ago(120) }), // never touched here
      ledger(5, { manualAt: ago(120), note: "unrecorded publish — GGSel gg-x holds it" }),
    ],
    settings: { healthPerPass: 0, topUp: false },
  });
  const out = await t.mod.runPass();
  assert.deepStrictEqual(out.orphans, { attached: 1, pinned: 1 });
  assert.strictEqual(t.db.Ledger.get("L1").manualListing, "R1");
  // Whether the platform already holds L2's credential is unknown: it stays
  // committed, pinned as unrecorded, and the owner is told.
  assert.strictEqual(t.called("releaseClaim").length, 0);
  assert.strictEqual(t.db.Ledger.get("L2").status, "manual");
  assert.match(t.db.Ledger.get("L2").note, /^unrecorded publish — /);
  assert.ok(t.events.some((e) => e.action === "orphan_pinned" && e.severity === "error"));
  assert.strictEqual(t.db.Ledger.get("L3").status, "manual");
  assert.strictEqual(t.db.Ledger.get("L3").manualListing, "");
  assert.strictEqual(t.db.Ledger.get("L4").status, "sold");
  assert.strictEqual(t.db.Ledger.get("L5").status, "manual");
  assert.strictEqual(out.conflicts.removed, 0, "the re-homed unit is no conflict");
});

test("runPass conflicts: a foreign unit leaves via a GGSel rebuild; stale pointers heal first", async () => {
  const r1 = row({
    marketplace: "ggsel",
    externalId: "gg-1",
    externalNode: "cat-9",
    price: 9,
    lastStock: 3,
    units: [unit("acc1", 1), unit("acc2", 2), unit("acc3", 3)],
  });
  const t = load({
    rows: [r1],
    ledgers: [
      ledger(1, { manualListing: "R1" }),
      ledger(2, { status: "listed", manualListing: "" }), // the auto-lister took it
      ledger(3, { manualListing: "R-gone" }), // pointer at a row that no longer exists
    ],
    ggStock: 3,
    settings: { healthPerPass: 0, topUp: false },
  });
  const out = await t.mod.runPass();
  assert.deepStrictEqual(out.errors, []);
  assert.deepStrictEqual(out.conflicts, { removed: 1, reattached: 1 });
  assert.strictEqual(t.db.Listing.get("R1").status, "delisted", "the old offer comes down first");
  const pub = t.called("ggselPublish")[0].args[0];
  assert.deepStrictEqual(pub.products, ["GG acc1:pw-acc1", "GG acc3:pw-acc3"]);
  assert.strictEqual(pub.priceRub, 950, "the live rouble price, not a fresh conversion");
  assert.strictEqual(pub.categoryId, "cat-9");
  const replacement = t.db.Listing.creates[0];
  assert.strictEqual(replacement.noclaimStock, true);
  assert.strictEqual(replacement.externalId, "gg-new");
  assert.deepStrictEqual(replacement.units.map((u) => u.login), ["acc1", "acc3"]);
  assert.strictEqual(
    new Date(replacement.units[0].addedAt).getTime(),
    at(1).getTime(),
    "FIFO order survives the rebuild",
  );
  assert.strictEqual(t.db.Ledger.get("L3").manualListing, replacement._id);
  assert.strictEqual(t.db.Ledger.get("L1").manualListing, replacement._id);
  assert.strictEqual(t.db.Ledger.get("L2").status, "listed", "a foreign ledger is never touched");
  assert.strictEqual(t.called("releaseClaim").length, 0);
});

test("runPass health: a claimed drop is a sale; two short reads 20+ min apart expire", async () => {
  const g1 = gameflipRow({ price: 12 });
  const ds = row({ lastStock: 1, units: [unit("acc2", 2)] });
  const claimedDrop = {
    name: "Alpha Pack",
    game: "Rainbow Six Siege",
    percent: 100,
    claimed: true,
  };
  const t = load({
    rows: [g1, ds],
    ledgers: [
      ledger(1, { manualListing: "G1" }),
      ledger(2, { manualListing: "R1", emptyReads: 1, firstEmptyAt: ago(30) }),
    ],
    pool: [
      { _id: poolId(1), clientSecret: "cs1" },
      { _id: poolId(2), clientSecret: "cs2" },
    ],
    inventory: {
      acc1: { inv: { inProgress: [claimedDrop] }, sellable: [], login: "acc1" },
      acc2: { inv: { inProgress: [] }, sellable: [], login: "acc2" },
    },
    dsStock: 1,
    settings: { topUp: false },
  });
  const out = await t.mod.runPass();
  assert.deepStrictEqual(out.errors, []);
  assert.deepStrictEqual(out.health, {
    checked: 2,
    ok: 0,
    sold: 1,
    strikes: 0,
    expired: 1,
    failed: 0,
  });
  // acc1: the buyer claimed an advertised drop.
  assert.strictEqual(t.db.Ledger.get("L1").status, "sold");
  const sale = t.called("markSold").find((c) => c.args[0][0] === "L1");
  assert.deepStrictEqual(sale.args[1], {
    market: "gameflip",
    priceUsd: 12,
    reason: "buyer claimed a listed drop",
  });
  assert.strictEqual(t.db.Listing.get("G1").units[0].orderId, "buyer-claimed");
  // acc2: drops gone on two reads spanning 20+ minutes.
  assert.deepStrictEqual(t.called("digisellerRemoveContent")[0].args, ["ds-9", "c-acc2"]);
  assert.strictEqual(t.db.Listing.get("R1").status, "delisted", "no units remain on it");
  const rel = t.called("releaseClaim");
  assert.deepStrictEqual(rel.map((c) => c.args), [[["L2"], { reason: "drops expired" }]]);
  assert.strictEqual(t.db.Ledger.get("L2").status, "skipped");
  assert.strictEqual(t.called("recordRead").length, 2);
});

test("runPass health: a failed read changes nothing but the check time", async () => {
  const ds = row({ lastStock: 1, units: [unit("acc2", 2)] });
  const t = load({
    rows: [ds],
    ledgers: [ledger(2, { manualListing: "R1", emptyReads: 1, firstEmptyAt: ago(30) })],
    pool: [{ _id: poolId(2), clientSecret: "cs2" }],
    inventory: {}, // the read throws
    dsStock: 1,
    settings: { topUp: false },
  });
  const out = await t.mod.runPass();
  assert.strictEqual(out.health.failed, 1);
  const l = t.db.Ledger.get("L2");
  assert.strictEqual(l.status, "manual");
  assert.strictEqual(l.emptyReads, 1, "no strike on a failed read");
  assert.ok(l.lastCheckedAt, "it moves to the back of the queue");
  assert.strictEqual(t.called("digisellerRemoveContent").length, 0);
  assert.strictEqual(t.called("releaseClaim").length, 0);
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("healthStrike: two strikes spanning 20 minutes expire, fewer or faster do not", () => {
  const { mod } = load();
  const now = T0;
  const minutesAgo = (m) => new Date(now - m * 60000);
  assert.deepStrictEqual(mod.healthStrike({ emptyReads: 0 }, now), {
    expire: false,
    strikes: 1,
    firstAt: new Date(now),
  });
  assert.strictEqual(
    mod.healthStrike({ emptyReads: 1, firstEmptyAt: minutesAgo(5) }, now).expire,
    false,
  );
  assert.strictEqual(
    mod.healthStrike({ emptyReads: 1, firstEmptyAt: minutesAgo(20) }, now).expire,
    true,
  );
});

test("writeMaybeLanded: a refusal never landed; a 5xx, timeout or dropped socket may have", () => {
  const { mod } = load();
  const withStatus = (msg, status) => Object.assign(new Error(msg), { status });
  assert.strictEqual(mod.writeMaybeLanded(withStatus("GGSel add products: 422", 422)), false);
  assert.strictEqual(mod.writeMaybeLanded(new Error('Missing credentials for "ggsel"')), false);
  assert.strictEqual(mod.writeMaybeLanded(withStatus("GGSel add products: 504", 504)), true);
  assert.strictEqual(
    mod.writeMaybeLanded(new Error("GGSel add products: timeout of 30000ms exceeded")),
    true,
  );
  assert.strictEqual(mod.writeMaybeLanded(new Error("socket hang up")), true);
});

test("undeliveredUnits: FIFO order, delivered and login-less units left out", () => {
  const { mod } = load();
  const units = [unit("b", 2), unit("a", 1), unit("c", 3, { deliveredAt: at(4) }), { login: "" }];
  assert.deepStrictEqual(mod.undeliveredUnits({ units }).map((u) => u.login), ["a", "b"]);
  assert.deepStrictEqual(mod.undeliveredUnits(null), []);
});
