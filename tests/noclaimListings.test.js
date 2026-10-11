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
      case "$nin":
        return !arg.some((a) => (Array.isArray(v) ? v.some((x) => eq(x, a)) : eq(v, a)));
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

// What Gameflip answers for a listing it no longer has — HTTP 404 with its own
// error envelope, as read live on 2026-10-11 (utils/gameflipGone).
function gone404() {
  const e = new Error(
    'Gameflip listing status: {"status":"FAILURE","data":null,"error":{"message":"Not Found","code":404,"http_status":404}}',
  );
  e.status = 404;
  return e;
}
// A Gameflip status stub for a listing that reads `status` until it is ended
// (state.gfDown), and 404s afterwards. `world` returns the harness, which only
// exists once load() has returned.
function until(world, status) {
  return (id) => {
    if (world().state.gfDown.has(String(id))) throw gone404();
    return status;
  };
}
// What a take-down that did not take throws (mp.gameflipEndListing).
function stillThere(status = "onsale") {
  const e = new Error('Gameflip end listing: still exists after the delete (status "' + status + '")');
  e.status = 409;
  return e;
}

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
    gfDown: new Set(), // Gameflip listings that were deleted
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
        // A listing is on sale until it is ended; then Gameflip 404s.
        gameflipListingStatus: (id) => {
          if (state.gfDown.has(String(id))) throw gone404();
          return "onsale";
        },
        // Off sale, deleted, and Gameflip's own 404 read back — or it throws.
        gameflipEndListing: (id) => {
          state.gfDown.add(String(id));
          return { deleted: true };
        },
        gameflipDelist: (id) => {
          state.gfDown.add(String(id));
        },
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
    {
      recordRead: () => undefined,
      sweepOnce: () => ({ read: 0 }),
      start: () => undefined,
      snapshotBase: () => ({ holdings: [], expiry: { on: true } }),
    },
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
    // What a booked sale teaches the demand model (one call a sale, ever).
    ["./saleLearning", stubFns({ recordListingSale: () => 1 })],
    // The real rule for "Gameflip says it is gone" — it is what is under test.
    ["./gameflipGone", require("../utils/gameflipGone")],
    // Messages to the owner's phone.
    ["./telegram", stubFns({ sendTelegram: () => undefined })],
    ["./playerauctionsCopy", { bundleInstruction: () => "PA GUIDE" }],
    // Sold AUTO-FARM accounts are cleaned up by their own module; the pass
    // only calls it (tests/autofarmStock.test.js covers what it does).
    [
      "./autofarmStock",
      stubFns(
        {
          retirePending: () => ({ pending: 0, retired: 0, waiting: 0, removed: 0, reloaded: [], errors: [] }),
          parkHeld: () => ({ pending: 0, retired: 0, waiting: 0, removed: 0, reloaded: [], errors: [] }),
          // A held auto-farm unit comes off sale this long before its drops leave.
          vaultLeadMs: () => 24 * 60 * 60 * 1000,
        },
        o.autofarm,
      ),
    ],
    // …and their unclaimed stock is put on sale by its own module too
    // (tests/autofarmOffers.test.js).
    [
      "./autofarmOffers",
      stubFns({ runPass: () => ({ created: [], waiting: [], skipped: {}, errors: [] }) }, o.offers),
    ],
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

  // Quantity discounts: Eldorado refuses an offer with a tier above its
  // quantity, and the quantity was just capped — so only reachable tiers go.
  const tiers = [{ quantity: 3, percentage: 5 }, { quantity: 5, percentage: 10 }, { quantity: 10, percentage: 15 }];
  const five = load({ stock: { free: 5 }, share: 5 });
  await five.mod.publishNoclaim("eldorado", ctx({ eldorado: { quantity: 20, volumeDiscounts: tiers } }));
  assert.strictEqual(five.called("eldoradoPublish")[0].args[0].quantity, 5);
  assert.deepStrictEqual(five.called("eldoradoPublish")[0].args[0].volumeDiscounts, tiers.slice(0, 2));
  const two = load({ stock: { free: 2 }, share: 2 });
  await two.mod.publishNoclaim("eldorado", ctx({ eldorado: { quantity: 20, volumeDiscounts: tiers } }));
  assert.deepStrictEqual(two.called("eldoradoPublish")[0].args[0].volumeDiscounts, []);
  const plenty = load({ stock: { free: 30 }, share: 30 });
  await plenty.mod.publishNoclaim("eldorado", ctx({ eldorado: { quantity: 20, volumeDiscounts: tiers } }));
  assert.deepStrictEqual(plenty.called("eldoradoPublish")[0].args[0].volumeDiscounts, tiers);
  // An offer made without discounts is sent exactly as before.
  assert.strictEqual(part.called("eldoradoPublish")[0].args[0].volumeDiscounts, undefined);

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

test("the market's own 'gone' travels with a release — and is never made up", async () => {
  // Retired as expired or cancelled the listing still exists on Gameflip: the
  // release says nothing about it (the claim layer then asks Gameflip itself
  // before it hands an auto-farm account back).
  const g1 = gameflipRow();
  let t = load({ rows: [g1], ledgers: [ledger(1, { manualListing: "G1" })] });
  await t.mod.onGameflipRetired(g1, { reason: 'gameflip reports "cancelled"' });
  assert.deepStrictEqual(t.called("releaseClaim")[0].args[1], { reason: 'gameflip reports "cancelled"' });
  // Retired on Gameflip's 404: that answer goes along.
  t = load({ rows: [g1], ledgers: [ledger(1, { manualListing: "G1" })] });
  await t.mod.onGameflipRetired(g1, { reason: "listing 404 on Gameflip", gone: true });
  assert.deepStrictEqual(t.called("releaseClaim")[0].args[1], { reason: "listing 404 on Gameflip", listingGone: true });

  // The Delist button: its verified take-down saw the listing gone…
  t = load({ rows: [g1], ledgers: [ledger(1, { manualListing: "G1" })] });
  await t.mod.beforeDelist(g1);
  t.db.Listing.get("G1").status = "delisted";
  await t.mod.afterDelist(g1, { outcome: "", gone: true });
  assert.deepStrictEqual(t.called("releaseClaim")[0].args[1], { reason: "listing delisted", listingGone: true });
  // …and a delist that has no such answer (any other market) claims none.
  t = load({ rows: [g1], ledgers: [ledger(1, { manualListing: "G1" })] });
  await t.mod.beforeDelist(g1);
  t.db.Listing.get("G1").status = "delisted";
  await t.mod.afterDelist(g1, { outcome: "" });
  assert.deepStrictEqual(t.called("releaseClaim")[0].args[1], { reason: "listing delisted" });
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
  assert.strictEqual(r.gone, true, "Gameflip itself said the listing is gone");
  // Ended from the status just read: off sale, deleted, and the 404 read back.
  assert.deepStrictEqual(t.called("gameflipEndListing").map((c) => c.args), [["gf-1", { status: "onsale" }]]);
  assert.strictEqual(t.db.Listing.get("G1").status, "delisted");
  assert.strictEqual(t.db.Listing.get("G1").lastError, "drops expired", "every automatic take-down says why");
  assert.strictEqual(t.called("relistNoclaimSuccessor").length, 1);

  const t2 = load({
    rows: [g1],
    ledgers: [ledger(1, { manualListing: "G1" })],
    mp: { gameflipListingStatus: () => "sold" },
  });
  const r2 = await t2.mod.removeUnit(g1, "acc1", { reason: "drops expired" });
  assert.deepStrictEqual(r2, { ok: true, removed: false, sold: true });
  assert.strictEqual(t2.called("gameflipEndListing").length, 0);
  assert.strictEqual(t2.called("relistNoclaimSuccessor").length, 0);

  // Unreadable (a 429) proves nothing: never taken down, and ok:false so no
  // caller hands the account back.
  const t3 = load({
    rows: [gameflipRow()],
    ledgers: [ledger(1, { manualListing: "G1" })],
    mp: {
      gameflipListingStatus: () => {
        throw new Error("429 Too Many Requests");
      },
    },
  });
  const r3 = await t3.mod.removeUnit(gameflipRow(), "acc1", { reason: "drops expired" });
  assert.strictEqual(r3.ok, false);
  assert.strictEqual(r3.removed, false);
  assert.match(r3.error, /^gameflip status unreadable/);
  assert.strictEqual(t3.called("gameflipEndListing").length, 0);
  assert.strictEqual(t3.db.Listing.get("G1").status, "active");
});

test("removeUnit gameflip: 'down' is Gameflip's word — a delete that did not take is not a removal", async () => {
  // Under its limiter Gameflip answers the take-down with 200 and changes
  // nothing: the read-back still finds the listing.
  let t = load({
    rows: [gameflipRow()],
    ledgers: [ledger(1, { manualListing: "G1" })],
    mp: {
      gameflipListingStatus: () => "onsale",
      gameflipEndListing: () => {
        throw stillThere("onsale");
      },
    },
  });
  let r = await t.mod.removeUnit(gameflipRow(), "acc1", { reason: "drops leave within 24 h" });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.removed, false);
  assert.match(r.error, /is onsale after the take-down/);
  assert.strictEqual(t.db.Listing.get("G1").status, "active", "the row keeps saying it is on sale");
  assert.strictEqual(t.called("relistNoclaimSuccessor").length, 0);

  // The draft patch landed and the delete was refused: a draft keeps the login.
  let calls = 0;
  t = load({
    rows: [gameflipRow()],
    ledgers: [ledger(1, { manualListing: "G1" })],
    mp: {
      gameflipListingStatus: () => (calls++ === 0 ? "onsale" : "draft"),
      gameflipEndListing: () => {
        throw new Error("Gameflip end listing (delete): 429");
      },
    },
  });
  r = await t.mod.removeUnit(gameflipRow(), "acc1", { reason: "x" });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /draft after the take-down/);
  assert.strictEqual(t.db.Listing.get("G1").status, "active");

  // …and the next pass finishes it: a draft is ours to bin, and it is ended AS
  // a draft (no off-sale patch a draft could refuse before its delete).
  t = load({
    rows: [gameflipRow()],
    ledgers: [ledger(1, { manualListing: "G1" })],
    mp: { gameflipListingStatus: until(() => t, "draft") },
  });
  r = await t.mod.removeUnit(gameflipRow(), "acc1", { reason: "x" });
  assert.strictEqual(r.removed, true);
  assert.deepStrictEqual(t.called("gameflipEndListing").map((c) => c.args), [["gf-1", { status: "draft" }]]);
  assert.strictEqual(t.called("gameflipListingStatus").length, 2, "read, ended, read again: the second read is the proof");
  assert.strictEqual(t.db.Listing.get("G1").status, "delisted");

  // Expired on Gameflip — dead for every buyer, the login still in it: binned too.
  t = load({
    rows: [gameflipRow()],
    ledgers: [ledger(1, { manualListing: "G1" })],
    mp: { gameflipListingStatus: until(() => t, "expired") },
  });
  r = await t.mod.removeUnit(gameflipRow(), "acc1", { reason: "x" });
  assert.strictEqual(r.removed, true);
  assert.deepStrictEqual(t.called("gameflipEndListing").map((c) => c.args), [["gf-1", { status: "expired" }]]);

  // The end call REPORTS the listing ended — its delete answered 404, and it
  // read nothing back — while Gameflip still shows the draft. Its report is
  // not the verdict: the listing is still there, nothing is handed back.
  t = load({
    rows: [gameflipRow()],
    ledgers: [ledger(1, { manualListing: "G1" })],
    mp: { gameflipListingStatus: () => "draft", gameflipEndListing: () => ({ deleted: false }) },
  });
  r = await t.mod.removeUnit(gameflipRow(), "acc1", { reason: "x" });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.removed, false);
  assert.match(r.error, /draft after the take-down/);
  assert.strictEqual(t.db.Listing.get("G1").status, "active");

  // Already gone on Gameflip (deleted by hand): nothing to delete, the books follow.
  t = load({
    rows: [gameflipRow()],
    ledgers: [ledger(1, { manualListing: "G1" })],
    mp: {
      gameflipListingStatus: () => {
        throw gone404();
      },
    },
  });
  r = await t.mod.removeUnit(gameflipRow(), "acc1", { reason: "x" });
  assert.strictEqual(r.removed, true);
  assert.strictEqual(t.called("gameflipEndListing").length, 0);

  // A status that is neither ours to bin nor a sale — a buyer in the middle of
  // paying, a sale paid and refunded: not now, and nothing is deleted.
  for (const st of ["sale_pending", "cancelled"]) {
    t = load({
      rows: [gameflipRow()],
      ledgers: [ledger(1, { manualListing: "G1" })],
      mp: { gameflipListingStatus: () => st },
    });
    r = await t.mod.removeUnit(gameflipRow(), "acc1", { reason: "x" });
    assert.strictEqual(r.ok, false, st);
    assert.match(r.error, new RegExp(st + " — not taking it down now"));
    assert.strictEqual(t.called("gameflipEndListing").length, 0, st);
    assert.strictEqual(t.db.Listing.get("G1").status, "active", st);
  }
});

test("removeUnit gameflip: gone is Gameflip's 404 — an error that only SAYS 'not found' is no answer", async () => {
  // A refused key, a proxy's page: the words "not found" with no 404 behind
  // them. Read as gone, the row was delisted, a successor published and the
  // account handed back with no delete ever sent.
  for (const err of [
    Object.assign(new Error('Gameflip listing status: {"error":{"message":"Api key not found"}}'), { status: 401 }),
    new Error("Gameflip listing status: getaddrinfo ENOTFOUND — host not found"),
    Object.assign(new Error('Gameflip listing status: {"http_status": 404}'), { status: 502 }),
    // A 404 that is not Gameflip's own answer: something in between replied.
    Object.assign(new Error('Gameflip listing status: "<html><h1>404 Not Found</h1><hr>nginx</html>"'), { status: 404 }),
    Object.assign(new Error("Gameflip listing status: Request failed with status code 404"), { status: 404 }),
  ]) {
    const t = load({
      rows: [gameflipRow()],
      ledgers: [ledger(1, { manualListing: "G1" })],
      mp: {
        gameflipListingStatus: () => {
          throw err;
        },
      },
    });
    const r = await t.mod.removeUnit(gameflipRow(), "acc1", { reason: "drops expired" });
    assert.strictEqual(r.ok, false, err.message);
    assert.strictEqual(r.removed, false, err.message);
    assert.match(r.error, /^gameflip status unreadable/);
    assert.strictEqual(t.db.Listing.get("G1").status, "active", "the row keeps saying it is on sale");
    assert.strictEqual(t.called("relistNoclaimSuccessor").length, 0);
    assert.strictEqual(t.called("gameflipEndListing").length, 0);
  }
});

test("removeUnit gameflip: a sale that lands during the take-down is the sale watcher's — booked once, relisted once", async () => {
  // First look: on sale. The take-down is refused — a buyer got there first.
  let looks = 0;
  const t = load({
    rows: [gameflipRow({ price: 12, qtyRemaining: 3 })],
    ledgers: [ledger(1, { manualListing: "G1" })],
    mp: {
      gameflipListingStatus: () => (looks++ === 0 ? "onsale" : "sold"),
      gameflipEndListing: () => {
        throw new Error("Gameflip end listing (off sale): listing is sold");
      },
    },
  });
  const r = await t.mod.removeUnit(gameflipRow({ price: 12, qtyRemaining: 3 }), "acc1", { reason: "x" });
  assert.deepStrictEqual(r, { ok: true, removed: false, sold: true });
  // Nothing is booked here: the row stays active, which is exactly what the
  // sale watcher looks for — it stamps the ledger, records the sale and
  // publishes the next unit, once. Doing it here as well published two.
  assert.strictEqual(t.db.Listing.get("G1").status, "active");
  assert.strictEqual(t.db.Listing.get("G1").qtyRemaining, 3);
  assert.strictEqual(t.db.Ledger.get("L1").status, "manual");
  assert.strictEqual(t.called("markSold").length, 0);
  assert.strictEqual(t.called("relistNoclaimSuccessor").length, 0);
  assert.strictEqual(t.called("recordListingSale").length, 0);
  assert.strictEqual(t.called("releaseClaim").length, 0);
});

test("gameflipTakeDown: the Delist button's answer is Gameflip's — gone, sold, there or unreadable", async () => {
  let t = load({});
  assert.deepStrictEqual(await t.mod.gameflipTakeDown("gf-1"), { state: "gone", status: "gone" });
  assert.deepStrictEqual(t.called("gameflipEndListing").map((c) => c.args), [["gf-1", { status: "onsale" }]]);

  t = load({ mp: { gameflipListingStatus: () => "sold" } });
  assert.deepStrictEqual(await t.mod.gameflipTakeDown("gf-1"), { state: "sold", status: "sold" });
  assert.strictEqual(t.called("gameflipEndListing").length, 0);

  // The take-down answered and changed nothing.
  t = load({
    mp: {
      gameflipListingStatus: () => "onsale",
      gameflipEndListing: () => {
        throw stillThere("onsale");
      },
    },
  });
  assert.deepStrictEqual(await t.mod.gameflipTakeDown("gf-1"), { state: "there", status: "onsale" });

  t = load({ mp: { gameflipListingStatus: () => "sale_pending" } });
  assert.deepStrictEqual(await t.mod.gameflipTakeDown("gf-1"), { state: "there", status: "sale_pending" });
  assert.strictEqual(t.called("gameflipEndListing").length, 0);

  t = load({
    mp: {
      gameflipListingStatus: () => {
        throw new Error("429");
      },
    },
  });
  assert.deepStrictEqual(await t.mod.gameflipTakeDown("gf-1"), { state: "unreadable", status: "" });

  // The end threw and then Gameflip would not say: unreadable, never gone.
  let looks = 0;
  t = load({
    mp: {
      gameflipListingStatus: () => {
        if (looks++ === 0) return "onsale";
        throw new Error("429");
      },
      gameflipEndListing: () => {
        throw new Error("429");
      },
    },
  });
  assert.deepStrictEqual(await t.mod.gameflipTakeDown("gf-1"), { state: "unreadable", status: "" });
});

// ---------------------------------------------------------------------------
// runPass
// ---------------------------------------------------------------------------

// A held auto-farm unit: its ledger carries the date its drops leave.
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const farmLedger = (n, extra = {}) =>
  ledger(n, {
    farm: "autofarm",
    manualPriorStatus: "",
    market: "gameflip",
    note: "manual no-claim listing — gameflip",
    farmGoneAt: new Date(Date.now() + 20 * HOUR_MS), // twenty hours left
    ...extra,
  });
const QUIET = { topUp: false, healthPerPass: 0 };

test("runPass expiry: a held auto-farm unit comes off sale a day before its drops leave — and is handed back", async () => {
  const t = load({ rows: [gameflipRow()], ledgers: [farmLedger(1, { manualListing: "G1" })], settings: QUIET });
  const out = await t.mod.runPass();
  assert.deepStrictEqual(out.errors, []);
  assert.deepStrictEqual(out.expiring, { due: 1, removed: 1 });
  // Down on Gameflip first — by Gameflip's own word — then released with that proof.
  assert.deepStrictEqual(t.called("gameflipEndListing").map((c) => c.args), [["gf-1", { status: "onsale" }]]);
  assert.strictEqual(t.db.Listing.get("G1").status, "delisted");
  assert.strictEqual(t.db.Listing.get("G1").lastError, "drops leave within 24 h");
  assert.deepStrictEqual(t.called("releaseClaim").map((c) => c.args), [[["L1"], { reason: "drops leave within 24 h", listingGone: true }]]);
  assert.ok(t.events.some((e) => e.action === "autofarm_unit_expiring" && e.subject === "acc1"));
  // The chain is asked for a successor; the claim layer only holds one that lasts.
  assert.strictEqual(t.called("relistNoclaimSuccessor").length, 1);
  // The snapshot is not asked: the date is the ledger's own.
  assert.strictEqual(t.called("snapshotBase").length, 0);
});

test("runPass expiry: nothing is taken off while the drops have more than the lead left, or when no date is on record", async () => {
  for (const farmGoneAt of [new Date(Date.now() + 3 * DAY_MS), null]) {
    const t = load({ rows: [gameflipRow()], ledgers: [farmLedger(1, { manualListing: "G1", farmGoneAt })], settings: QUIET });
    const out = await t.mod.runPass();
    assert.deepStrictEqual(out.expiring, { due: 0, removed: 0 }, String(farmGoneAt));
    assert.strictEqual(t.db.Listing.get("G1").status, "active");
    assert.strictEqual(t.called("releaseClaim").length, 0);
    assert.strictEqual(t.called("gameflipListingStatus").length, 0, "database only until a unit is due");
  }
});

test("runPass expiry: only auto-farm units, only undelivered ones, never a pinned one — and a unit that will not come down is not released", async () => {
  // A no-claim bot's unit on the same kind of row is the health step's, as it always was.
  let t = load({ rows: [gameflipRow()], ledgers: [ledger(1, { manualListing: "G1", farmGoneAt: new Date(Date.now() + HOUR_MS) })], settings: QUIET });
  let out = await t.mod.runPass();
  assert.deepStrictEqual(out.expiring, { due: 0, removed: 0 });
  assert.strictEqual(t.called("gameflipListingStatus").length, 0);

  // Already delivered: a buyer has it.
  t = load({
    rows: [gameflipRow({ units: [unit("acc1", 1, { contentId: "", deliveredAt: at(5), orderId: "gameflip-sale" })] })],
    ledgers: [farmLedger(1, { manualListing: "G1" })],
    settings: QUIET,
  });
  out = await t.mod.runPass();
  assert.deepStrictEqual(out.expiring, { due: 0, removed: 0 });
  assert.strictEqual(t.called("releaseClaim").length, 0);

  // Pinned as unrecorded: only a human releases it.
  t = load({
    rows: [gameflipRow()],
    ledgers: [farmLedger(1, { manualListing: "G1", note: "unrecorded publish — gameflip (offer unknown)" })],
    settings: QUIET,
  });
  out = await t.mod.runPass();
  assert.deepStrictEqual(out.expiring, { due: 0, removed: 0 });

  // Gameflip will not say whether it is on sale: not taken down, NOT released, an error line.
  t = load({
    rows: [gameflipRow()],
    ledgers: [farmLedger(1, { manualListing: "G1" })],
    mp: {
      gameflipListingStatus: () => {
        throw new Error("429 Too Many Requests");
      },
    },
    settings: QUIET,
  });
  out = await t.mod.runPass();
  assert.deepStrictEqual(out.expiring, { due: 1, removed: 0 });
  assert.strictEqual(t.called("releaseClaim").length, 0, "its login may still be on sale");
  assert.ok(out.errors.some((e) => /^expiry acc1: gameflip status unreadable/.test(e)), JSON.stringify(out.errors));
  assert.strictEqual(t.db.Listing.get("G1").status, "active");

  // The delete did not take (200, nothing changed): still on sale, still held.
  t = load({
    rows: [gameflipRow()],
    ledgers: [farmLedger(1, { manualListing: "G1" })],
    mp: {
      gameflipListingStatus: () => "onsale",
      gameflipEndListing: () => {
        throw stillThere("onsale");
      },
    },
    settings: QUIET,
  });
  out = await t.mod.runPass();
  assert.deepStrictEqual(out.expiring, { due: 1, removed: 0 });
  assert.strictEqual(t.called("releaseClaim").length, 0);
  assert.strictEqual(t.db.Listing.get("G1").status, "active");

  // Sold a moment ago: the sale path owns it.
  t = load({
    rows: [gameflipRow()],
    ledgers: [farmLedger(1, { manualListing: "G1" })],
    mp: { gameflipListingStatus: () => "sold" },
    settings: QUIET,
  });
  out = await t.mod.runPass();
  assert.deepStrictEqual(out.expiring, { due: 1, removed: 0 });
  assert.strictEqual(t.called("releaseClaim").length, 0);
});

// Four held units, all inside the lead; acc4's drops leave first.
function fourDue() {
  const rows = [];
  const ledgers = [];
  for (let i = 1; i <= 4; i++) {
    rows.push(gameflipRow({ _id: "G" + i, externalId: "gf-" + i, accountLogin: "acc" + i, units: [unit("acc" + i, i, { contentId: "" })] }));
    ledgers.push(farmLedger(i, { manualListing: "G" + i, farmGoneAt: new Date(Date.now() + (10 - i) * HOUR_MS) }));
  }
  return { rows, ledgers };
}

test("runPass expiry: ONE take-down a pass, the soonest first — and a failed one is not followed by another", async () => {
  const { rows, ledgers } = fourDue();
  const t = load({ rows, ledgers, settings: QUIET });
  const out = await t.mod.runPass();
  assert.deepStrictEqual(out.expiring, { due: 4, removed: 1 });
  assert.deepStrictEqual(t.called("gameflipEndListing").map((c) => c.args[0]), ["gf-4"]);
  const again = await t.mod.runPass();
  assert.deepStrictEqual(again.expiring, { due: 3, removed: 1 });
  assert.deepStrictEqual(t.called("gameflipEndListing").map((c) => c.args[0]), ["gf-4", "gf-3"]);

  // Gameflip is throttling: one call, not one per due unit.
  const bad = load({
    rows,
    ledgers,
    mp: {
      gameflipListingStatus: () => {
        throw new Error("429 Too Many Requests");
      },
    },
    settings: QUIET,
  });
  const o = await bad.mod.runPass();
  assert.deepStrictEqual(o.expiring, { due: 4, removed: 0 });
  assert.strictEqual(bad.called("gameflipListingStatus").length, 1);
});

test("runPass expiry: a unit that will not come down does not keep the ones behind it on sale", async () => {
  // acc4 is first in line and a buyer is in the middle of paying for it: it
  // cannot be taken down, pass after pass. Tried again and again at the head,
  // the three behind it stayed buyable until their drops were gone.
  const { rows, ledgers } = fourDue();
  const t = load({
    rows,
    ledgers,
    mp: {
      gameflipListingStatus: (id) => {
        if (id === "gf-4") return "sale_pending";
        if (t.state.gfDown.has(String(id))) throw gone404();
        return "onsale";
      },
    },
    settings: QUIET,
  });
  const tried = [];
  for (let pass = 0; pass < 5; pass++) {
    const before = t.called("gameflipListingStatus").length;
    await t.mod.runPass();
    tried.push(t.called("gameflipListingStatus").slice(before)[0].args[0]);
  }
  // The stuck one, then each of the others in the order their drops leave —
  // and only then the stuck one again.
  assert.deepStrictEqual(tried, ["gf-4", "gf-3", "gf-2", "gf-1", "gf-4"]);
  assert.deepStrictEqual(t.called("gameflipEndListing").map((c) => c.args[0]), ["gf-3", "gf-2", "gf-1"]);
  for (const id of ["G1", "G2", "G3"]) assert.strictEqual(t.db.Listing.get(id).status, "delisted", id);
  assert.strictEqual(t.db.Listing.get("G4").status, "active");
  assert.strictEqual(t.db.Ledger.get("L4").status, "manual", "still held: a buyer may be about to own it");
  assert.ok(t.db.Ledger.get("L4").farmDownTriedAt, "its own clock says when it was last tried");
});

test("runPass limbo: a held account whose row came down but was not handed back is asked about again — one a pass", async () => {
  const down = (extra = {}) => gameflipRow({ status: "delisted", lastError: "drops leave within 24 h", ...extra });
  // Gameflip no longer has it: handed back, with that proof.
  let t = load({
    rows: [down()],
    ledgers: [farmLedger(1, { manualListing: "G1", farmGoneAt: null })],
    mp: {
      gameflipListingStatus: () => {
        throw gone404();
      },
    },
    settings: QUIET,
  });
  let out = await t.mod.runPass();
  assert.deepStrictEqual(out.limbo, { released: 1, sold: 0, retried: 0 });
  assert.deepStrictEqual(t.called("releaseClaim").map((c) => c.args), [[["L1"], { reason: "its listing is gone", listingGone: true }]]);

  // It SOLD while our books said it was down: booked as the sale it is — and
  // the demand model hears of it, as it does of every sale the watcher books.
  t = load({
    rows: [down({ price: 9 })],
    ledgers: [farmLedger(1, { manualListing: "G1", farmGoneAt: null })],
    mp: { gameflipListingStatus: () => "sold" },
    settings: QUIET,
  });
  out = await t.mod.runPass();
  assert.deepStrictEqual(out.limbo, { released: 0, sold: 1, retried: 0 });
  assert.strictEqual(t.db.Ledger.get("L1").status, "sold");
  assert.strictEqual(t.db.Listing.get("G1").status, "sold");
  assert.strictEqual(t.db.Listing.get("G1").units[0].orderId, "gameflip-sale");
  assert.deepStrictEqual(t.called("markSold")[0].args[1], { market: "gameflip", priceUsd: 9, reason: "gameflip sale" });
  assert.strictEqual(t.called("releaseClaim").length, 0);
  assert.strictEqual(t.called("recordListingSale").length, 1);
  assert.strictEqual(t.called("recordListingSale")[0].args[0].priceUsd, 9);
  assert.strictEqual(t.called("recordListingSale")[0].args[0].units, 1);
  assert.deepStrictEqual(t.called("recordListingSale")[0].args[0].logins, ["acc1"], "whose sale it was — demand is counted per account");

  // Still there as a draft: the take-down is finished — ended AS a draft — and
  // with Gameflip's 404 for it the account goes back in the same pass.
  t = load({
    rows: [down()],
    ledgers: [farmLedger(1, { manualListing: "G1", farmGoneAt: null })],
    mp: { gameflipListingStatus: until(() => t, "draft") },
    settings: QUIET,
  });
  out = await t.mod.runPass();
  assert.deepStrictEqual(out.limbo, { released: 1, sold: 0, retried: 0 });
  assert.deepStrictEqual(t.called("gameflipEndListing").map((c) => c.args), [["gf-1", { status: "draft" }]]);
  assert.deepStrictEqual(t.called("releaseClaim").map((c) => c.args), [[["L1"], { reason: "its listing is gone", listingGone: true }]]);

  // …and when the delete does not take, nothing is released: asked again next pass.
  t = load({
    rows: [down()],
    ledgers: [farmLedger(1, { manualListing: "G1", farmGoneAt: null })],
    mp: {
      gameflipListingStatus: () => "draft",
      gameflipEndListing: () => {
        throw stillThere("draft");
      },
    },
    settings: QUIET,
  });
  out = await t.mod.runPass();
  assert.deepStrictEqual(out.limbo, { released: 0, sold: 0, retried: 1 });
  assert.strictEqual(t.called("releaseClaim").length, 0);
  assert.strictEqual(t.db.Ledger.get("L1").status, "manual");

  // Gameflip will not say: an error line, nothing else.
  t = load({
    rows: [down()],
    ledgers: [farmLedger(1, { manualListing: "G1", farmGoneAt: null })],
    mp: {
      gameflipListingStatus: () => {
        throw new Error("429");
      },
    },
    settings: QUIET,
  });
  out = await t.mod.runPass();
  assert.deepStrictEqual(out.limbo, { released: 0, sold: 0, retried: 0 });
  assert.ok(out.errors.some((e) => /^limbo acc1: gameflip status unreadable/.test(e)));

  // Not its business: a unit on a live row, a pinned claim, a no-claim bot's ledger.
  for (const [row, led] of [
    [gameflipRow(), farmLedger(1, { manualListing: "G1", farmGoneAt: null })],
    [down(), farmLedger(1, { manualListing: "G1", farmGoneAt: null, note: "unrecorded publish — gameflip gf-1" })],
    [down(), ledger(1, { manualListing: "G1" })],
  ]) {
    t = load({ rows: [row], ledgers: [led], mp: { gameflipListingStatus: () => "draft" }, settings: QUIET });
    out = await t.mod.runPass();
    assert.deepStrictEqual(out.limbo, { released: 0, sold: 0, retried: 0 });
    assert.strictEqual(t.called("gameflipEndListing").length, 0);
  }

  // A park in flight does not stop the take-down — getting the login off the
  // market is always right. Its hand-back waits for the park (the claim
  // layer's own gate: tests/noclaimStock.test.js).
  t = load({
    rows: [down()],
    ledgers: [farmLedger(1, { manualListing: "G1", farmGoneAt: null, farmParkStartedAt: new Date() })],
    mp: { gameflipListingStatus: () => "draft" },
    settings: QUIET,
  });
  out = await t.mod.runPass();
  assert.deepStrictEqual(t.called("gameflipEndListing").map((c) => c.args[0]), ["gf-1"]);

  // The row that named its listing is gone: pinned for a human, never released.
  t = load({ rows: [], ledgers: [farmLedger(1, { manualListing: "G1", farmGoneAt: null })], settings: QUIET });
  out = await t.mod.runPass();
  assert.strictEqual(out.limbo.released, 0);
  assert.strictEqual(out.limbo.pinned, 1);
  assert.match(t.db.Ledger.get("L1").note, /^unrecorded publish — /);
  assert.strictEqual(t.called("releaseClaim").length, 0);
  const pin = t.events.find((e) => e.action === "orphan_pinned");
  assert.match(pin.detail, /listing row is missing/);
  assert.match(pin.detail, /"confirmGone": true/, "the owner is told how to release it once they have looked");

  // One a pass.
  const rows = [];
  const ledgers = [];
  for (let i = 1; i <= 3; i++) {
    rows.push(down({ _id: "G" + i, externalId: "gf-" + i, accountLogin: "acc" + i, units: [unit("acc" + i, i, { contentId: "" })] }));
    ledgers.push(farmLedger(i, { manualListing: "G" + i, farmGoneAt: null }));
  }
  t = load({
    rows,
    ledgers,
    mp: {
      gameflipListingStatus: () => "draft",
      gameflipEndListing: () => {
        throw stillThere("draft");
      },
    },
    settings: QUIET,
  });
  out = await t.mod.runPass();
  assert.strictEqual(t.called("gameflipEndListing").length, 1);
  assert.deepStrictEqual(out.limbo, { released: 0, sold: 0, retried: 1 });
});

test("runPass limbo: only a listing that is ours to bin is deleted — a buyer mid-payment waits, a refunded sale burns the account", async () => {
  const down = (extra = {}) => gameflipRow({ status: "removed", lastError: 'gameflip reports "cancelled" — retired by the watcher', ...extra });
  // A buyer is paying right now: nothing is deleted, nothing released.
  let t = load({
    rows: [down()],
    ledgers: [farmLedger(1, { manualListing: "G1", farmGoneAt: null })],
    mp: { gameflipListingStatus: () => "sale_pending" },
    settings: QUIET,
  });
  let out = await t.mod.runPass();
  assert.deepStrictEqual(out.limbo, { released: 0, sold: 0, retried: 1 });
  assert.strictEqual(t.called("gameflipEndListing").length, 0);
  assert.strictEqual(t.called("releaseClaim").length, 0);
  assert.strictEqual(t.db.Ledger.get("L1").status, "manual");

  // Paid, then refunded: the buyer has SEEN this login. Deleted and handed
  // back, the account would be sold to a second buyer the first can lock out.
  t = load({
    rows: [down({ price: 9 })],
    ledgers: [farmLedger(1, { manualListing: "G1", farmGoneAt: null })],
    mp: { gameflipListingStatus: () => "cancelled" },
    settings: QUIET,
  });
  out = await t.mod.runPass();
  assert.deepStrictEqual(out.limbo, { released: 0, sold: 0, retried: 0, burned: 1 });
  assert.strictEqual(t.called("gameflipEndListing").length, 0);
  assert.strictEqual(t.called("releaseClaim").length, 0);
  assert.strictEqual(t.db.Ledger.get("L1").status, "sold", "out of stock and out of farming, as a sold one");
  assert.deepStrictEqual(t.called("markSold")[0].args[1], {
    market: "gameflip",
    priceUsd: 0,
    reason: "gameflip sale cancelled after delivery — its login was seen",
  });
  // Nobody bought it: the row is not called sold (a "sold" row is what lets
  // the lister start another chain), and the demand model hears nothing.
  assert.strictEqual(t.db.Listing.get("G1").status, "removed");
  assert.strictEqual(t.db.Listing.get("G1").units[0].orderId, "gameflip-cancelled");
  assert.ok(t.db.Listing.get("G1").units[0].deliveredAt, "its buyer did receive the login");
  assert.strictEqual(t.called("recordListingSale").length, 0, "a refund is not demand");
  assert.ok(t.events.some((e) => e.action === "unit_burned" && e.subject === "acc1"));
});

test("runPass limbo: a row our own books call SOLD is finished as that sale — never released, whatever Gameflip says now", async () => {
  // The sale watcher flipped the row; its ledger write failed. Gameflip
  // answering 404 for the listing later (deleted by hand) must not hand a
  // buyer's account back to stock.
  const t = load({
    rows: [gameflipRow({ status: "sold", price: 7, units: [unit("acc1", 1, { contentId: "", deliveredAt: at(5), orderId: "gameflip-sale" })] })],
    ledgers: [farmLedger(1, { manualListing: "G1", farmGoneAt: null })],
    mp: {
      gameflipListingStatus: () => {
        throw gone404();
      },
    },
    settings: QUIET,
  });
  const out = await t.mod.runPass();
  assert.deepStrictEqual(out.limbo, { released: 0, sold: 1, retried: 0 });
  assert.strictEqual(t.db.Ledger.get("L1").status, "sold");
  assert.strictEqual(t.called("releaseClaim").length, 0);
  assert.strictEqual(t.called("gameflipListingStatus").length, 0, "the books already say it: Gameflip is not asked");
  assert.strictEqual(t.called("recordListingSale").length, 0, "the watcher recorded this sale when it flipped the row");
});

test("runPass limbo: ledgers that are not its business never starve the one that is", async () => {
  // Twenty-five pinned claims and twenty-five units on live rows, all looked
  // at longer ago than the one account really in limbo. A window of twenty
  // filled with those, and the one that needed the pass was never reached.
  const rows = [];
  const ledgers = [];
  for (let i = 1; i <= 25; i++) {
    rows.push(gameflipRow({ _id: "P" + i, externalId: "gf-p" + i, status: "delisted", accountLogin: "acc" + i, units: [unit("acc" + i, i, { contentId: "" })] }));
    ledgers.push(farmLedger(i, { manualListing: "P" + i, farmGoneAt: null, note: "unrecorded publish — gameflip gf-p" + i, lastCheckedAt: at(i) }));
  }
  for (let i = 26; i <= 50; i++) {
    rows.push(gameflipRow({ _id: "A" + i, externalId: "gf-a" + i, accountLogin: "acc" + i, units: [unit("acc" + i, i, { contentId: "" })] }));
    ledgers.push(farmLedger(i, { manualListing: "A" + i, farmGoneAt: null, lastCheckedAt: at(i) }));
  }
  rows.push(gameflipRow({ _id: "Z", externalId: "gf-z", status: "delisted", accountLogin: "acc99", units: [unit("acc99", 99, { contentId: "" })] }));
  ledgers.push(farmLedger(99, { manualListing: "Z", farmGoneAt: null, lastCheckedAt: new Date() }));
  const t = load({
    rows,
    ledgers,
    mp: {
      gameflipListingStatus: (id) => {
        if (id === "gf-z") throw gone404();
        return "onsale";
      },
    },
    settings: QUIET,
  });
  const out = await t.mod.runPass();
  assert.deepStrictEqual(out.limbo, { released: 1, sold: 0, retried: 0 });
  assert.deepStrictEqual(t.called("releaseClaim").map((c) => c.args[0]), [["L99"]]);
});

test("removeForPoolAccount: an auto-farm account sold by hand is booked as a sale, not parked 'removed'", async () => {
  const t = load({
    rows: [gameflipRow()],
    ledgers: [farmLedger(1, { manualListing: "G1", farmGoneAt: null })],
    pool: [{ _id: poolId(1), clientSecret: "cs1", manualSold: true }],
  });
  const out = await t.mod.removeForPoolAccount(poolId(1), { actor: "owner" });
  assert.deepStrictEqual(out.errors, []);
  assert.strictEqual(out.units, 1);
  assert.strictEqual(out.ledgers, 1);
  // Off Gameflip (verified), then SOLD — so its own clean-up takes it out of its bot.
  assert.strictEqual(t.db.Listing.get("G1").status, "delisted");
  assert.strictEqual(t.db.Ledger.get("L1").status, "sold");
  assert.deepStrictEqual(t.called("markSold")[0].args, [["L1"], { market: "gameflip", priceUsd: 0, reason: "sold by hand" }]);
  assert.strictEqual(t.called("releaseClaim").length, 0);
});

test("removeForPoolAccount: a hand sale is not booked over a listing Gameflip still has — a delisted ROW proves nothing", async () => {
  // The owner pressed Delist; Gameflip answered 200 and changed nothing. Our
  // row says delisted, the listing is still buyable, the account stays held.
  // Then the owner ticks it sold by hand. Booked, the ledger left "manual" —
  // the only state the limbo step watches — and the listing stayed on sale
  // with a login that now belongs to somebody.
  const P = poolId(1);
  const down = gameflipRow({ status: "delisted" });
  let t = load({
    rows: [down],
    ledgers: [farmLedger(1, { manualListing: "G1", farmGoneAt: null, poolAccountId: P })],
    mp: { gameflipListingStatus: () => "onsale" },
  });
  let out = await t.mod.removeForPoolAccount(P, { actor: "owner" });
  assert.strictEqual(out.ledgers, 0);
  assert.strictEqual(out.errors.length, 1);
  assert.match(out.errors[0], /^acc1: not booked as sold by hand yet — its Gameflip listing still exists \(onsale\)/);
  assert.strictEqual(t.db.Ledger.get("L1").status, "manual", "still held, so the limbo step keeps taking the listing down");
  assert.strictEqual(t.called("markSold").length, 0);

  // Gameflip would not say: not booked either.
  t = load({
    rows: [down],
    ledgers: [farmLedger(1, { manualListing: "G1", farmGoneAt: null, poolAccountId: P })],
    mp: {
      gameflipListingStatus: () => {
        throw new Error("429");
      },
    },
  });
  out = await t.mod.removeForPoolAccount(P, { actor: "owner" });
  assert.match(out.errors[0], /Gameflip would not say whether its listing is gone/);
  assert.strictEqual(t.db.Ledger.get("L1").status, "manual");

  // It SOLD on Gameflip: that sale is what gets booked (the limbo step), not a hand sale.
  t = load({
    rows: [down],
    ledgers: [farmLedger(1, { manualListing: "G1", farmGoneAt: null, poolAccountId: P })],
    mp: { gameflipListingStatus: () => "sold" },
  });
  out = await t.mod.removeForPoolAccount(P, { actor: "owner" });
  assert.match(out.errors[0], /its Gameflip listing SOLD there/);
  assert.strictEqual(t.called("markSold").length, 0);

  // Gameflip no longer has it: now the hand sale is booked.
  t = load({
    rows: [down],
    ledgers: [farmLedger(1, { manualListing: "G1", farmGoneAt: null, poolAccountId: P })],
    mp: {
      gameflipListingStatus: () => {
        throw gone404();
      },
    },
  });
  out = await t.mod.removeForPoolAccount(P, { actor: "owner" });
  assert.deepStrictEqual(out.errors, []);
  assert.strictEqual(out.ledgers, 1);
  assert.strictEqual(t.db.Ledger.get("L1").status, "sold");
  assert.deepStrictEqual(t.called("markSold")[0].args, [["L1"], { market: "gameflip", priceUsd: 0, reason: "sold by hand" }]);

  // Its listing row is gone, or it never had one: nobody can ask, nobody books.
  for (const led of [
    farmLedger(1, { manualListing: "G1", farmGoneAt: null, poolAccountId: P }),
    farmLedger(1, { manualListing: "", manualAt: ago(90), farmGoneAt: null, poolAccountId: P }),
  ]) {
    t = load({ rows: [], ledgers: [led] });
    out = await t.mod.removeForPoolAccount(P, { actor: "owner" });
    assert.strictEqual(out.ledgers, 0, led.manualListing || "(unattached)");
    assert.match(out.errors[0], /listing row is missing|attached to no listing row/);
    assert.strictEqual(t.db.Ledger.get("L1").status, "manual");
    assert.strictEqual(t.called("gameflipListingStatus").length, 0);
  }

  // A no-claim bot's account on the same kind of row is parked "removed" as it always was.
  t = load({
    rows: [down],
    ledgers: [ledger(1, { manualListing: "G1", poolAccountId: P })],
    mp: { gameflipListingStatus: () => "onsale" },
  });
  out = await t.mod.removeForPoolAccount(P, { actor: "owner" });
  assert.deepStrictEqual(out.errors, []);
  assert.strictEqual(t.db.Ledger.get("L1").status, "removed");
  assert.strictEqual(t.called("gameflipListingStatus").length, 0);
});

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

test("runPass: unclaimed auto-farm stock is offered each pass; a failure there is one error line, not a stopped pass", async () => {
  const ok = load({
    settings: { healthPerPass: 0 },
    offers: { runPass: () => ({ created: [{ game: "Brawlhalla" }], waiting: [], skipped: {}, errors: ["SPAM: Eldorado said no"] }) },
  });
  const r = await ok.mod.runPass();
  assert.strictEqual(ok.called("runPass").length, 1);
  assert.strictEqual(r.offers.created.length, 1);
  assert.deepStrictEqual(r.errors, ["autofarm offer SPAM: Eldorado said no"]);

  const bad = load({
    settings: { healthPerPass: 0 },
    offers: {
      runPass: () => {
        throw new Error("boom");
      },
    },
  });
  const r2 = await bad.mod.runPass();
  assert.deepStrictEqual(r2.errors, ["autofarm-offers: boom"]);
  // Every other step still ran.
  assert.strictEqual(bad.called("spendPending").length, 1);
  assert.strictEqual(bad.called("retirePending").length, 1);
  assert.strictEqual(bad.called("parkHeld").length, 1, "accounts held for a vault unit are parked each pass");
  assert.strictEqual(bad.mod.status().running, false);
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
  assert.strictEqual(t.called("sendTelegram").length, 0, "a no-claim bot's pin is told as it always was: in the activity log");
});

test("a held AUTO-FARM account that is pinned is said out loud, once — with the one way to release it", async () => {
  // Its publish never recorded a row (the orphans step pins it)…
  let t = load({
    rows: [],
    ledgers: [farmLedger(1, { manualListing: "", manualAt: ago(120), farmGoneAt: null })],
    settings: QUIET,
  });
  await t.mod.runPass();
  assert.match(t.db.Ledger.get("L1").note, /^unrecorded publish — /);
  let told = t.called("sendTelegram");
  assert.strictEqual(told.length, 1);
  assert.match(told[0].args[0], /An auto-farm account is HELD and needs you/);
  assert.match(told[0].args[0], /acc1 \(Rainbow Six Siege\)/);
  assert.match(told[0].args[0], /POST \/noclaim-stock\/ledgers\/L1\/release with \{ "confirmGone": true \}/);
  const pin = t.events.find((e) => e.action === "orphan_pinned");
  assert.match(pin.detail, /"confirmGone": true/);
  // A pinned claim is never looked at again: no second message, pass after pass.
  await t.mod.runPass();
  await t.mod.runPass();
  assert.strictEqual(t.called("sendTelegram").length, 1);

  // …or its listing row went missing (the limbo step pins it).
  t = load({ rows: [], ledgers: [farmLedger(1, { manualListing: "G1", farmGoneAt: null })], settings: QUIET });
  await t.mod.runPass();
  told = t.called("sendTelegram");
  assert.strictEqual(told.length, 1);
  assert.match(told[0].args[0], /whose row is missing from our books/);
  assert.match(told[0].args[0], /POST \/noclaim-stock\/ledgers\/L1\/release with \{ "confirmGone": true \}/);
  await t.mod.runPass();
  assert.strictEqual(t.called("sendTelegram").length, 1);
});

test("runPass limbo: a held account that keeps waiting is said out loud after three hours — once, with why", async () => {
  const down = gameflipRow({ status: "delisted", lastError: "drops leave within 24 h" });
  const stuck = { gameflipListingStatus: () => "sale_pending" }; // a buyer who never finishes paying
  // First sight: nothing is said, the wait is timed from here.
  let t = load({ rows: [down], ledgers: [farmLedger(1, { manualListing: "G1", farmGoneAt: null })], mp: stuck, settings: QUIET });
  let out = await t.mod.runPass();
  assert.deepStrictEqual(out.limbo, { released: 0, sold: 0, retried: 1 });
  assert.ok(t.db.Ledger.get("L1").farmLimboAt, "the wait is on the ledger, so a restart does not forget it");
  assert.strictEqual(t.called("sendTelegram").length, 0);
  await t.mod.runPass();
  assert.strictEqual(t.called("sendTelegram").length, 0, "minutes of waiting are normal");

  // Three hours on: said once.
  t = load({
    rows: [down],
    ledgers: [farmLedger(1, { manualListing: "G1", farmGoneAt: null, farmLimboAt: ago(200) })],
    mp: stuck,
    settings: QUIET,
  });
  await t.mod.runPass();
  let told = t.called("sendTelegram");
  assert.strictEqual(told.length, 1);
  assert.match(told[0].args[0], /A held auto-farm account has been waiting 3 h/);
  assert.match(told[0].args[0], /acc1[^]*Gameflip listing gf-1[^]*Gameflip still has its listing \(sale_pending\)/);
  assert.ok(t.db.Ledger.get("L1").farmLimboToldAt);
  assert.ok(t.events.some((e) => e.action === "autofarm_unit_waiting" && e.subject === "acc1"));
  await t.mod.runPass();
  await t.mod.runPass();
  assert.strictEqual(t.called("sendTelegram").length, 1, "once");

  // Gone on Gameflip but not handed back (its bot removal never finishes): the release gate's own reason.
  t = load({
    rows: [down],
    ledgers: [farmLedger(1, { manualListing: "G1", farmGoneAt: null, farmLimboAt: ago(200), farmParkStartedAt: ago(190) })],
    mp: {
      gameflipListingStatus: () => {
        throw gone404();
      },
    },
    ncs: { releaseClaim: () => 0 }, // the claim layer's gate refuses it
    autofarm: { releaseBlocked: () => "its bot removal is still under way" },
    settings: QUIET,
  });
  out = await t.mod.runPass();
  assert.deepStrictEqual(out.limbo, { released: 0, sold: 0, retried: 0 });
  told = t.called("sendTelegram");
  assert.strictEqual(told.length, 1);
  assert.match(told[0].args[0], /its listing is gone, but its bot removal is still under way/);

  // Gameflip not answering is a wait too.
  t = load({
    rows: [down],
    ledgers: [farmLedger(1, { manualListing: "G1", farmGoneAt: null, farmLimboAt: ago(200) })],
    mp: {
      gameflipListingStatus: () => {
        throw new Error("429");
      },
    },
    settings: QUIET,
  });
  await t.mod.runPass();
  assert.match(t.called("sendTelegram")[0].args[0], /Gameflip would not answer about its listing/);

  // Settled in the same pass: nothing to say, however long it waited.
  t = load({
    rows: [down],
    ledgers: [farmLedger(1, { manualListing: "G1", farmGoneAt: null, farmLimboAt: ago(200) })],
    mp: {
      gameflipListingStatus: () => {
        throw gone404();
      },
    },
    settings: QUIET,
  });
  out = await t.mod.runPass();
  assert.deepStrictEqual(out.limbo, { released: 1, sold: 0, retried: 0 });
  assert.strictEqual(t.called("sendTelegram").length, 0);
});

test("onGameflipRetired: retired as CANCELLED the account is never handed back — whichever farm it came from", async () => {
  // Paid, then refunded: the buyer has seen the login. A no-claim bot's
  // account used to go straight back to stock here.
  for (const led of [ledger(1, { manualListing: "G1" }), farmLedger(1, { manualListing: "G1", farmGoneAt: null })]) {
    const g1 = gameflipRow({ status: "removed", price: 9 });
    const t = load({ rows: [g1], ledgers: [led] });
    const out = await t.mod.onGameflipRetired(g1, { reason: 'gameflip reports "cancelled"', burned: true });
    assert.deepStrictEqual(out, { released: 0, burned: 1 }, led.farm || "fleet");
    assert.strictEqual(t.called("releaseClaim").length, 0);
    assert.strictEqual(t.db.Ledger.get("L1").status, "sold", "closed like a sale: out of stock, out of its bot");
    assert.deepStrictEqual(t.called("markSold")[0].args, [
      ["L1"],
      { market: "gameflip", priceUsd: 0, reason: "gameflip sale cancelled after delivery — its login was seen" },
    ]);
    const row = t.db.Listing.get("G1");
    assert.strictEqual(row.status, "removed", "nobody bought it: the row is not called sold");
    assert.strictEqual(row.units[0].orderId, "gameflip-cancelled");
    assert.strictEqual(t.called("recordListingSale").length, 0);
    assert.ok(t.events.some((e) => e.action === "unit_burned" && e.subject === "acc1"));
  }
  // Retired as expired (or 404): the old rule, a release.
  const g1 = gameflipRow({ status: "removed" });
  const t = load({ rows: [g1], ledgers: [ledger(1, { manualListing: "G1" })] });
  assert.deepStrictEqual(await t.mod.onGameflipRetired(g1, { reason: 'gameflip reports "expired"' }), { released: 1 });
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
