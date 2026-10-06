// No-claim Eldorado offer rotation — docs/NOCLAIM-OFFER-ROTATION-CONTRACT.md.
//
// WHY THIS EXISTS
//
// A no-claim Eldorado offer sells ONE fixed no-claim DropSet. Rainbow Six drops
// a new "Esports Pack" wave every two to three days, each wave's items leave the
// accounts about a week after it ends, and later waves even rename the item
// ("Esports Pack 26 stage 2" -> "Esports Pack 26 Stage 2.1"). So the set's items
// expire off every account, eldoradoFulfiller.syncBundleStock pauses the offer
// ("paused: no claimable stock"), and nothing ever brought it back: on
// 2026-09-30 R6's selling offer (c847f2c2, ~4 sales a day) sat paused for 31
// hours while 41 free accounts held the current wave.
//
// Owner rule (2026-10-02): when a no-claim Eldorado offer runs dry because its
// wave expired, it switches itself to the newest bundle the farm holds — same
// offer, same price — and comes back on sale.
//
// SAFETY
//
//   - Only rows the stock sync paused (autoPaused + its exact error). A pause
//     the owner made (autoPaused:false) is never touched.
//   - A live no-claim bulk pack on the set moves with it, keeping its pack
//     title, pack cover and pack-counted quantity (utils/noclaimOfferPack).
//     Any other bulk row is left alone.
//   - Only when no FREE account holds the old bundle any more, and the free
//     farm holds a different one. Free accounts all sold or reserved is
//     contention, and a new bundle cannot fix that.
//   - Only offers that delivered an order in the last 7 days: an offer that has
//     been dead for a week is not brought back at an old price.
//   - Never while a paid order waits on the offer.
//   - The offer id, price and quantity rules never change. A new set is made
//     (or an identical one reused) — the old set keeps its sold ledgers.
//   - The offer text is rewritten while the offer is still PAUSED and read
//     back before the row moves, so nobody can pay for the old text and be
//     handed the new bundle. Any failure leaves the offer paused.
//   - Kill switch: autoFarm.noclaimRotateOffers === false.

const settings = require("./settings");
const pk = require("./noclaimOfferPack");

const PAUSED_ERROR = "paused: no claimable stock";
const MIN_PAUSED_MS = 30 * 60 * 1000;
const RECENT_SALE_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_CAMPAIGN_MS = 72 * 60 * 60 * 1000;
const REUSE_SET_MS = 30 * 24 * 60 * 60 * 1000;
// A bundle must be held by at least this many free accounts, and by at least
// MIN_SHARE of the game's free accounts — "the bundle the farm holds", not a
// rarity two accounts happen to carry.
const MIN_ACCOUNTS = 10;
const MIN_SHARE = 0.5;
// Each rotated row costs ~5 Eldorado calls; the stock tick runs every 15 min.
const MAX_SETS_PER_PASS = 2;
const MAX_ROWS_PER_PASS = 6;

const state = {
  running: false,
  lastRun: null,
  lastSummary: "",
};

// ---------------------------------------------------------------------------
// Pure helpers (tested)
// ---------------------------------------------------------------------------

function str(v) {
  return v == null ? "" : String(v);
}

function norm(g) {
  return settings.normGameName(g);
}

// Same game, matched as substrings both ways — the rule noclaimStock and
// noclaimHoldings use, so "Overwatch 2" items count for an "Overwatch" set.
function sameGame(a, b) {
  const x = norm(a);
  const y = norm(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

function copiesOf(it) {
  const q = Math.floor(Number(it && it.qty));
  return Number.isFinite(q) && q >= 1 ? q : 1;
}

// noclaimStock's key rule: a stored itemKey wins, else "name|game".
function keyOfItem(it) {
  if (!it) return "";
  const stored = str(it.itemKey).trim().toLowerCase();
  if (stored) return stored;
  const k = str(it.name).trim().toLowerCase() + "|" + str(it.game).trim().toLowerCase();
  return k === "|" ? "" : k;
}

// Order-free identity of an item list (key × copies), so a reused set is the
// SAME bundle, not merely the same item names.
function itemsSignature(items) {
  const byKey = new Map();
  for (const it of items || []) {
    const k = keyOfItem(it);
    if (!k) continue;
    byKey.set(k, (byKey.get(k) || 0) + copiesOf(it));
  }
  return [...byKey.entries()]
    .map(([k, q]) => k + "×" + q)
    .sort()
    .join("\n");
}

function bundleLabel(items) {
  return (items || [])
    .map((i) => (copiesOf(i) > 1 ? copiesOf(i) + "× " : "") + (str(i.name).trim() || keyOfItem(i)))
    .join(" + ");
}

function timeOf(v) {
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) ? t : 0;
}

// When the row last handed an account to a buyer (0 = never).
function lastDeliveredAt(row) {
  let best = 0;
  for (const u of (row && row.units) || []) {
    const t = timeOf(u && u.deliveredAt);
    if (t > best) best = t;
  }
  return best;
}

// "" when the stock sync paused this row and it may be rotated; else why not.
function rowSkipReason(row, now = Date.now()) {
  if (!row) return "no row";
  if (row.marketplace !== "eldorado") return "not an Eldorado row";
  if (row.noclaimStock !== true) return "not a no-claim row";
  if (row.status !== "active") return "row is " + (row.status || "?");
  if (row.autoPaused !== true) return "not paused by the stock sync";
  if (str(row.lastError) !== PAUSED_ERROR) return "paused for another reason";
  if (!row.set) return "no set";
  if (now - timeOf(row.updatedAt) < MIN_PAUSED_MS) return "paused under 30 min ago";
  return "";
}

// Map<lowercased campaign name, { active, endAt }> from TwitchCampaign rows.
// A name seen twice (Twitch re-issues a campaign) keeps the newest end and is
// active if either copy is.
function campaignRecency(campaigns, now = Date.now()) {
  const out = new Map();
  for (const c of campaigns || []) {
    const name = str(c && c.name).trim().toLowerCase();
    if (!name) continue;
    const end = timeOf(c.endAt);
    const active =
      c.active === true && c.status === "ACTIVE" && (!c.endAt || end > now);
    const cur = out.get(name) || { active: false, endAt: 0 };
    out.set(name, { active: cur.active || active, endAt: Math.max(cur.endAt, end) });
  }
  return out;
}

// The bundle the farm holds now for `game`, out of the free + fresh holdings.
//   holdings  — NoclaimHolding docs (noclaimHoldings.snapshotBase().holdings)
//   isFree(h) / isFresh(h) — the snapshot's own rules, bound by the caller
//   campaigns — campaignRecency() output
// Returns { items, covering, minCover, pool, newestOnly } or { items:null, reason }.
function pickRotationBundle({ holdings, isFree, isFresh, game, campaigns, now = Date.now() } = {}) {
  const pool = [];
  const meta = new Map();
  for (const h of holdings || []) {
    if (!h || h.inConfig === false) continue;
    if (!isFree(h) || !isFresh(h)) continue;
    const counts = new Map();
    for (const it of h.items || []) {
      if (!it || !sameGame(it.game, game)) continue;
      const k = keyOfItem(it);
      if (!k) continue;
      counts.set(k, (counts.get(k) || 0) + copiesOf(it));
      let m = meta.get(k);
      if (!m) {
        m = { itemKey: k, name: str(it.name), game: str(it.game), image: str(it.image), campaigns: new Set() };
        meta.set(k, m);
      }
      if (!m.name && it.name) m.name = str(it.name);
      if (!m.image && it.image) m.image = str(it.image);
      const c = str(it.campaign).trim().toLowerCase();
      if (c) m.campaigns.add(c);
    }
    if (counts.size) pool.push(counts);
  }
  if (pool.length < MIN_ACCOUNTS) {
    return {
      items: null,
      pool: pool.length,
      reason: "only " + pool.length + " free account(s) hold " + (game || "this game") + " drops",
    };
  }
  const minCover = Math.max(MIN_ACCOUNTS, Math.ceil(pool.length * MIN_SHARE));

  const rec = campaigns instanceof Map ? campaigns : new Map();
  let cands = [...meta.values()].map((m) => {
    let active = false;
    let endAt = 0;
    for (const c of m.campaigns) {
      const r = rec.get(c);
      if (!r) continue;
      if (r.active) active = true;
      if (r.endAt > endAt) endAt = r.endAt;
    }
    const holders = pool.filter((counts) => counts.has(m.itemKey)).length;
    return { m, active, endAt, holders };
  });
  const newest = cands.filter((c) => c.active || (c.endAt && c.endAt >= now - RECENT_CAMPAIGN_MS));
  const newestOnly = newest.length > 0;
  if (newestOnly) cands = newest;
  cands.sort(
    (a, b) =>
      (b.active ? 1 : 0) - (a.active ? 1 : 0) ||
      b.holders - a.holders ||
      b.endAt - a.endAt ||
      a.m.itemKey.localeCompare(b.m.itemKey),
  );

  let cover = pool;
  const items = [];
  for (const c of cands) {
    const k = c.m.itemKey;
    const held = cover
      .map((counts) => counts.get(k) || 0)
      .filter((q) => q > 0)
      .sort((x, y) => y - x);
    if (held.length < minCover) continue;
    // The minCover-th largest count is the most copies at least minCover of
    // the still-covering accounts hold.
    const q = held[minCover - 1];
    cover = cover.filter((counts) => (counts.get(k) || 0) >= q);
    items.push({ itemKey: k, name: c.m.name || k.split("|")[0], game: c.m.game || game, image: c.m.image, qty: q });
  }
  if (!items.length) {
    return {
      items: null,
      pool: pool.length,
      reason: "no item is held by " + minCover + "+ of the " + pool.length + " free accounts",
    };
  }
  return { items, covering: cover.length, minCover, pool: pool.length, newestOnly };
}

// ---------------------------------------------------------------------------
// Dependencies (injectable for tests)
// ---------------------------------------------------------------------------

function realDeps() {
  return {
    settings,
    MarketplaceListing: require("../models/MarketplaceListing"),
    DropSet: require("../models/DropSet"),
    TwitchCampaign: require("../models/TwitchCampaign"),
    ncs: require("./noclaimStock"),
    nh: require("./noclaimHoldings"),
    mp: require("./marketplaces"),
    // House listing copy for Eldorado, exactly what the engine writes for a set.
    text: async (set) => {
      const ual = require("./unclaimedAutoList");
      const game = setGame(set);
      const cls = await ual.classificationForSet(set);
      const drops = ual.dropsFromSet(set);
      return {
        title: ual.listingTitle(game, drops, cls),
        description: ual.listingDescription(game, drops, "eldorado", cls),
      };
    },
    // showTotal: a bundle with several copies of an item says its real size
    // on the cover ("11 ITEMS"), not just one numbered tile per distinct item.
    buildCover: (set) => require("./setImage").buildSetGridImage(set, { showTotal: true }),
    unlink: (p) => {
      try {
        require("fs").unlinkSync(p);
      } catch {
        /* a temp file left behind is not worth failing a rotation */
      }
    },
    logEvent: (fields) => require("./systemLog").logEvent(fields),
    sendTelegram: (text) => require("./telegram").sendTelegram(text),
  };
}

function setGame(set) {
  const first = ((set && set.items) || []).find((i) => i && str(i.game).trim());
  return str((set && set.coverGame) || (first && first.game)).trim();
}

function setGameNorms(set) {
  const out = new Set();
  const add = (g) => {
    const n = norm(g);
    if (n) out.add(n);
  };
  add(set && set.coverGame);
  for (const it of (set && set.items) || []) add(it && it.game);
  return [...out];
}

// ---------------------------------------------------------------------------
// One pass
// ---------------------------------------------------------------------------

// An existing no-claim set holding exactly these items (a previous rotation's,
// or another offer's) is reused, so a retried or parallel rotation never mints
// a second copy; otherwise a new one is made with the fields
// POST /noclaim-stock/sets writes.
//
// `tag` and `note` let the grow pass (utils/noclaimOfferGrow) make its sets
// through the same door; left out, they read as a rotation's.
async function targetSet(d, items, { game, price, fromSet, now, tag, note }) {
  const sig = itemsSignature(items);
  const recent = await d.DropSet.find(
    { stockSource: "noclaim", createdAt: { $gte: new Date(now - REUSE_SET_MS) } },
    { name: 1, items: 1, coverGame: 1, price: 1, stockSource: 1, createdAt: 1 },
  )
    .sort({ createdAt: -1 })
    .limit(300)
    .lean();
  for (const s of recent || []) {
    if (sameGame(setGame(s), game) && itemsSignature(s.items) === sig) {
      return { set: s, created: false };
    }
  }
  const doc = await d.DropSet.create({
    name: (game + " — " + bundleLabel(items) + " · Eldorado (" + (tag || "auto-rotated") + ")").slice(0, 200),
    note:
      note ||
      "Made " + new Date(now).toISOString().slice(0, 10) + " by the no-claim offer rotation: set " +
        String(fromSet._id) + " (" + bundleLabel(fromSet.items) + ") had expired off every account.",
    price: Number(price) > 0 ? Number(price) : 0,
    items: items.map((i) => ({ itemKey: i.itemKey, name: i.name, game: i.game, image: i.image, qty: i.qty })),
    stockSource: "noclaim",
    listed: false,
    publicCatalog: false,
    custom: false,
    sourceType: "",
    coverGame: game,
  });
  // A model without stockSource would silently make an ordinary Drop-archive
  // set — the same refusal the set route makes.
  if (doc.stockSource !== "noclaim") {
    await d.DropSet.deleteOne({ _id: doc._id }).catch(() => {});
    throw new Error("DropSet model has no stockSource — nothing was saved");
  }
  return { set: typeof doc.toObject === "function" ? doc.toObject() : doc, created: true };
}

// Rewrite one paused offer and move its row. Returns { rotated:true, stock } or
// { skipped } / { error }. The order below IS the safety property.
async function rotateRow(d, row, ctx) {
  const ext = str(row.externalId);
  const live = await d.mp.eldoradoOffer(ext);
  if (!live) return { error: "offer unreadable on Eldorado" };
  if (live.offerState !== "Paused") return { skipped: "offer is " + (live.offerState || "?") + " on Eldorado" };
  const priceBefore = Number(live.pricePerUnit && live.pricePerUnit.amount);

  // 1. Text + cover while paused. Price and quantity are left as they are.
  const updated = await d.mp.eldoradoUpdateOffer(ext, {
    title: ctx.title,
    description: ctx.description,
    mainOfferImage: ctx.image,
    offerImages: [],
  });
  if (!updated || str(updated.offerTitle) !== ctx.title.slice(0, 160)) {
    return { error: "the new title did not take on Eldorado — row left on its old set" };
  }
  if (
    Number.isFinite(priceBefore) &&
    Number(updated.pricePerUnit && updated.pricePerUnit.amount) !== priceBefore
  ) {
    return { error: "the price moved during the edit — row left on its old set" };
  }

  // 2. Only now the row follows, by compare-and-set on the set it was paused on.
  const cas = await d.MarketplaceListing.updateOne(
    { _id: row._id, set: row.set, status: "active", autoPaused: true },
    {
      $set: {
        set: ctx.set._id,
        requiredDrops: d.ncs.requiredDropsForSet(ctx.set),
        title: ctx.title,
        description: ctx.description,
        lastError: "",
        note:
          "no-claim auto-delivery: an account is claimed when an order lands — rotated " +
          new Date(ctx.now).toISOString().slice(0, 16).replace("T", " ") + "Z from set " +
          String(row.set) + " (expired) to " + String(ctx.set._id),
      },
    },
  );
  if (!cas || cas.modifiedCount !== 1) {
    return { error: "the row changed while rotating — left for the next pass" };
  }

  if (ctx.pack) {
    try {
      await pk.recordOnOffer(d, ctx.pack, ctx.set, ctx);
    } catch {
      /* the bulk dashboard's copy of the text is display only */
    }
  }

  // 3. Back on sale exactly the way syncBundleStock resumes its own pauses. A
  // pack row counts whole packs; under one pack it stays paused for the sync.
  const moved = await d.MarketplaceListing.findById(row._id).lean();
  const stock = pk.quantityFor(d, ctx.pack, await d.ncs.stockForListing(moved));
  if (stock > 0) {
    await d.mp.eldoradoRelist(ext);
    await d.MarketplaceListing.updateOne(
      { _id: row._id, set: ctx.set._id },
      { $set: { autoPaused: false, lastError: "", qtyTarget: stock } },
    );
    await d.mp.eldoradoSetQuantity(ext, stock);
  }
  return { rotated: true, stock };
}

async function rotationPass(opts = {}) {
  if (state.running) return { skipped: "already running" };
  const d = opts.deps || realDeps();
  const now = opts.now || Date.now();
  const af = (d.settings.getAutoFarm && d.settings.getAutoFarm()) || {};
  if (af.noclaimRotateOffers === false) {
    return { skipped: "switched off (autoFarm.noclaimRotateOffers)" };
  }
  state.running = true;
  const out = { at: new Date(now), stale: 0, rotated: [], skipped: [], errors: [], log: [] };
  try {
    const rows = await d.MarketplaceListing.find({
      marketplace: "eldorado",
      noclaimStock: true,
      status: "active",
      autoPaused: true,
    }).lean();
    const bySet = new Map();
    const packs = new Map(); // row id -> { offer, n } for live no-claim pack rows
    for (const r of rows || []) {
      if (rowSkipReason(r, now)) continue;
      if (pk.isPackRow(r)) {
        let p;
        try {
          p = await pk.packFor(d, r);
        } catch (e) {
          p = { skip: e.message };
        }
        if (p.skip) continue; // not a live no-claim pack: left exactly as it is
        packs.set(String(r._id), p);
      }
      const k = String(r.set);
      (bySet.get(k) || bySet.set(k, []).get(k)).push(r);
    }

    let base = null;
    let paidOffers = null;
    let setsDone = 0;
    let rowsLeft = MAX_ROWS_PER_PASS;
    for (const [setId, group] of bySet) {
      if (setsDone >= MAX_SETS_PER_PASS || rowsLeft <= 0) break;
      const set = await d.DropSet.findById(setId).lean();
      const label = set ? setGame(set) + " " + bundleLabel(set.items) : setId;
      const skip = (why) => out.skipped.push({ set: setId, label, why });
      if (!set || set.stockSource !== "noclaim") {
        skip("not a no-claim set");
        continue;
      }
      const st = await d.ncs.stockForSet(set);
      if (st.free > 0 || st.stale > 0) {
        // A free account still holds it (or did at its last read): the sync
        // resumes the offer by itself.
        continue;
      }
      // No free account holds the bundle any more. When accounts that are NOT
      // free still do (sold, or on another listing), this used to be left as
      // contention for good — but an offer grown to a bigger bundle
      // (utils/noclaimOfferGrow) lands exactly here when the extra drops
      // expire. The picker below settles it: fewer than MIN_ACCOUNTS free
      // accounts, or the same bundle again, is real contention and is skipped.
      out.stale++;
      const lastSale = Math.max(0, ...group.map(lastDeliveredAt));
      if (now - lastSale > RECENT_SALE_MS) {
        skip("no sale in 7 days — left paused");
        continue;
      }

      const game = setGame(set);
      if (!base) base = await d.nh.snapshotBase();
      const norms = setGameNorms(set);
      const names = new Set();
      for (const h of (base && base.holdings) || []) {
        for (const it of (h && h.items) || []) {
          if (it && it.campaign && sameGame(it.game, game)) names.add(str(it.campaign).trim());
        }
      }
      const campaigns = names.size
        ? campaignRecency(
            await d.TwitchCampaign.find(
              { name: { $in: [...names] } },
              { name: 1, status: 1, active: 1, endAt: 1 },
            ).lean(),
            now,
          )
        : new Map();
      const pick = pickRotationBundle({
        holdings: (base && base.holdings) || [],
        isFree: (h) => d.nh.freeReason(h, base, norms) === "",
        isFresh: (h) => d.nh.isFresh(h, base, now),
        game,
        campaigns,
        now,
      });
      if (!pick.items) {
        skip(pick.reason);
        continue;
      }
      if (itemsSignature(pick.items) === itemsSignature(set.items)) {
        skip("the farm still holds the same bundle");
        continue;
      }

      // A buyer who paid for the old text must get the old bundle (or a human),
      // never a silently different one. Read once per pass, only when needed.
      if (!paidOffers) {
        try {
          const orders = (await d.mp.eldoradoPaidOrders()) || [];
          paidOffers = new Set(orders.map((o) => str(o && o.offerId)).filter(Boolean));
        } catch (e) {
          skip("could not read paid orders: " + e.message);
          break;
        }
      }
      if (group.some((r) => paidOffers.has(str(r.externalId)))) {
        skip("a paid order is waiting on this offer — left for the fulfiller");
        continue;
      }

      // Only offers still paused on Eldorado are rewritten; check before a set
      // or a cover is made for nobody. rotateRow re-reads right before its edit.
      const paused = [];
      for (const r of group.slice(0, rowsLeft)) {
        let live = null;
        try {
          live = await d.mp.eldoradoOffer(str(r.externalId));
        } catch (e) {
          out.errors.push({ set: setId, label, externalId: str(r.externalId), error: "offer read: " + e.message });
          continue;
        }
        if (live && live.offerState === "Paused") paused.push(r);
        else {
          out.skipped.push({
            set: setId,
            label,
            externalId: str(r.externalId),
            why: live ? "offer is " + (live.offerState || "?") + " on Eldorado" : "offer unreadable on Eldorado",
          });
        }
      }
      if (!paused.length) continue;

      setsDone++;
      let ctx;
      let cover = "";
      try {
        const target = await targetSet(d, pick.items, { game, price: set.price, fromSet: set, now });
        const text = await d.text(target.set);
        if (!str(text && text.title).trim()) throw new Error("no title for the new bundle");
        cover = await d.buildCover(target.set);
        if (!cover) throw new Error("cover image not built");
        const image = await d.mp.eldoradoUploadImage(cover);
        ctx = { set: target.set, created: target.created, title: text.title, description: text.description || "", image, now };
      } catch (e) {
        out.errors.push({ set: setId, label, error: e.message });
        continue;
      } finally {
        if (cover) d.unlink(cover);
      }

      for (const row of paused) {
        if (rowsLeft <= 0) break;
        rowsLeft--;
        const ext = str(row.externalId);
        let r;
        let rowCtx = ctx;
        try {
          const pack = packs.get(String(row._id));
          if (pack) {
            // The pack's own title, description and cover, under its offer's lock.
            rowCtx = { ...ctx, ...(await pk.packCopy(d, pack, ctx.set, ctx, game)), pack };
            const locked = await pk.withLock(d, pack, () => rotateRow(d, row, rowCtx));
            r = locked.ran ? locked.value : { skipped: "the bulk offer is busy — left for the next pass" };
          } else {
            r = await rotateRow(d, row, ctx);
          }
        } catch (e) {
          r = { error: e.message };
        }
        if (r.rotated) {
          const done = {
            externalId: ext,
            price: row.price,
            from: bundleLabel(set.items),
            to: rowCtx.title,
            set: String(ctx.set._id),
            newSet: ctx.created,
            stock: r.stock,
            covering: pick.covering,
          };
          out.rotated.push(done);
          try {
            d.logEvent({
              category: "noclaim_shop",
              action: "offer_rotated",
              actor: "noclaimOfferRotation",
              subject: "eldorado " + ext,
              subjectId: row._id,
              game,
              count: r.stock,
              detail:
                "Eldorado offer switched to the bundle the farm holds now: " + rowCtx.title +
                " ($" + row.price + ", " + r.stock + " in stock) — " + bundleLabel(set.items) +
                " had expired off every account",
              meta: { fromSet: setId, toSet: String(ctx.set._id), newSet: ctx.created },
            });
          } catch {
            /* the audit row must never undo a rotation */
          }
        } else if (r.skipped) {
          out.skipped.push({ set: setId, label, externalId: ext, why: r.skipped });
        } else {
          out.errors.push({ set: setId, label, externalId: ext, error: r.error || "unknown" });
        }
      }
    }

    if (out.rotated.length) {
      const text =
        "🔄 No-claim Eldorado offer back on sale with the new wave\n\n" +
        out.rotated
          .map(
            (x) =>
              x.to + "\n$" + x.price + " · " + x.stock + " in stock · offer " + x.externalId.slice(0, 8) +
              "\n(was: " + x.from + " — expired)",
          )
          .join("\n\n");
      try {
        Promise.resolve(d.sendTelegram(text)).catch(() => {});
      } catch {
        /* never fail the pass on a notification */
      }
    }

    // One line per outcome CHANGE, plus every rotation: the stock tick runs
    // every 15 min, and two long-dead offers would otherwise print the same
    // skip 96 times a day.
    for (const x of out.rotated) {
      out.log.push("rotated eldorado " + x.externalId + " -> " + x.to + " (" + x.stock + " in stock)");
    }
    const summary = [
      ...out.skipped.map((s) => "skip " + s.label + (s.externalId ? " [" + s.externalId.slice(0, 8) + "]" : "") + ": " + s.why),
      ...out.errors.map((s) => "error " + s.label + (s.externalId ? " [" + s.externalId.slice(0, 8) + "]" : "") + ": " + s.error),
    ].join(" | ");
    if (summary && summary !== state.lastSummary) out.log.push(summary);
    state.lastSummary = summary;
    state.lastRun = out;
    return out;
  } finally {
    state.running = false;
  }
}

function status() {
  return {
    enabled: (settings.getAutoFarm() || {}).noclaimRotateOffers !== false,
    running: state.running,
    lastRun: state.lastRun,
  };
}

module.exports = {
  // constants
  PAUSED_ERROR,
  MIN_PAUSED_MS,
  RECENT_SALE_MS,
  RECENT_CAMPAIGN_MS,
  MIN_ACCOUNTS,
  MIN_SHARE,
  MAX_SETS_PER_PASS,
  MAX_ROWS_PER_PASS,
  // pure, tested
  sameGame,
  itemsSignature,
  bundleLabel,
  lastDeliveredAt,
  rowSkipReason,
  campaignRecency,
  pickRotationBundle,
  // pass
  rotationPass,
  rotateRow,
  status,
  // shared with utils/noclaimOfferGrow
  keyOfItem,
  copiesOf,
  setGame,
  setGameNorms,
  targetSet,
  realDeps,
};
