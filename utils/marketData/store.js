// Market radar — the DATABASE half. Applies the pure plans from ./plan.js with bounded reads
// (every find projected and limited, no skip, no allowDiskUse) and one unordered bulkWrite per
// target. Idempotent: every sale carries a dedupe key and every rival is an upsert on
// (market, listingId), so a retried or duplicated job cannot double anything.
const plan = require("./plan");

const RIVAL_PROJ = { listingId: 1, game: 1, gameKey: 1, priceUsd: 1, priceNative: 1, counter: 1, counterMax: 1, lastSeenAt: 1, missed: 1, goneAt: 1, outcome: 1 };
const MAX_EXISTING = 2000;

// A duplicate-key error is the benign half of a race between two upserts of the same key.
function onlyDuplicates(err) {
  const errs = (err && err.writeErrors) || (err && err.result && err.result.getWriteErrors && err.result.getWriteErrors()) || null;
  if (err && err.code === 11000 && !errs) return true;
  if (!errs || !errs.length) return false;
  return errs.every((e) => (e.code !== undefined ? e.code : e.err && e.err.code) === 11000);
}

async function bulk(Model, ops) {
  if (!ops.length) return { upserted: 0, modified: 0 };
  try {
    const res = await Model.bulkWrite(ops, { ordered: false });
    return { upserted: (res && res.upsertedCount) || 0, modified: (res && res.modifiedCount) || 0 };
  } catch (e) {
    if (onlyDuplicates(e)) return { upserted: 0, modified: 0 };
    throw e;
  }
}

const saleOps = (docs) =>
  docs.map((d) => ({ updateOne: { filter: { dedupeKey: d.dedupeKey }, update: { $setOnInsert: d }, upsert: true } }));

const uniq = (a) => [...new Set(a.filter(Boolean))];

// The newest counter a recorded sale already accounts for, per listing. If a rival update failed
// after its sale was written, this — not the stale stored counter — is where the next sale starts.
async function lastSaleCounters(MarketSale, market, ids) {
  if (!ids.length || typeof MarketSale.aggregate !== "function") return new Map();
  const rows = await MarketSale.aggregate([
    { $match: { market, source: "counter", listingId: { $in: ids } } },
    { $group: { _id: "$listingId", n: { $max: "$counterAfter" } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
}

/**
 * Apply one tap job. Sales are written BEFORE the rival counters move, so a failure can never
 * advance a baseline past a sale that was not recorded; and the next baseline is the highest of
 * the stored counter and the last counter a sale accounted for, so a failure can never count the
 * same units twice either.
 * @returns {Promise<object>} counts, for the status page
 */
async function applyJob(job, models) {
  const { MarketSale, MarketRival, MarketDataState } = models;
  const out = { salesInserted: 0, rivalsInserted: 0, rivalsUpdated: 0, counterSales: 0, units: 0, dips: 0, jumps: 0, goneMarked: 0, soldLinked: 0, gameflipSkipped: 0, learned: {} };
  const fold = (s, inserted) => {
    out.rivalsInserted += inserted;
    out.rivalsUpdated += s.updated;
    out.counterSales += s.counterSales;
    out.units += s.units;
    out.dips += s.dips;
    out.jumps += s.jumps;
    out.goneMarked += s.goneMarked;
    out.soldLinked += s.soldLinked;
  };

  const gf = job.gameflip;
  if (gf && (gf.sold.length || gf.active.length)) {
    if (job.own && job.own.gameflipKnown === false) {
      // Without our owner id our own Gameflip rows would be stored as rivals, permanently.
      out.gameflipSkipped = 1;
    } else {
      const soldIds = uniq(gf.sold.map((r) => plan.idOf("gameflip", r)));
      const keys = soldIds.map((id) => "gf:" + id);
      const have = new Set(keys.length ? (await MarketSale.find({ dedupeKey: { $in: keys } }, { dedupeKey: 1 }).lean()).map((d) => d.dedupeKey) : []);
      const sales = plan.planSold(job, have);
      // Every listing on THIS page, by id (whatever game first saw it), plus this game's live
      // rivals — the only ones a miss can apply to.
      const pageIds = uniq([...gf.active.map((r) => plan.idOf("gameflip", r)), ...soldIds]);
      const [byId, byGame] = await Promise.all([
        pageIds.length ? MarketRival.find({ market: "gameflip", listingId: { $in: pageIds } }, RIVAL_PROJ).limit(MAX_EXISTING).lean() : [],
        MarketRival.find({ market: "gameflip", gameKey: job.gameKey, goneAt: null }, RIVAL_PROJ).limit(MAX_EXISTING).lean(),
      ]);
      const existing = new Map();
      for (const d of byGame) existing.set(d.listingId, d);
      for (const d of byId) existing.set(d.listingId, d);
      const rp = plan.planRivals("gameflip", job, existing);
      out.salesInserted += (await bulk(MarketSale, saleOps(sales))).upserted;
      const w = await bulk(MarketRival, rp.ops);
      fold(rp.stats, w.upserted);
    }
  }

  for (const market of plan.COUNTER_MARKETS) {
    const rows = (job[market] && job[market].rows) || [];
    if (!rows.length) continue;
    const ids = uniq(rows.map((r) => plan.idOf(market, r)));
    const [found, counted] = await Promise.all([
      ids.length ? MarketRival.find({ market, listingId: { $in: ids } }, RIVAL_PROJ).limit(MAX_EXISTING).lean() : [],
      lastSaleCounters(MarketSale, market, ids),
    ]);
    const existing = new Map(found.map((d) => [d.listingId, counted.has(d.listingId) ? { ...d, lastSaleCounter: counted.get(d.listingId) } : d]));
    const rp = plan.planRivals(market, job, existing);
    out.salesInserted += (await bulk(MarketSale, saleOps(rp.sales))).upserted;
    const w = await bulk(MarketRival, rp.ops);
    fold(rp.stats, w.upserted);
    const learned = plan.learnOwnSellers(market, rows, job.own);
    if (learned.size) {
      await MarketDataState.updateOne(
        { _id: "ownSellers" },
        { $addToSet: { [market]: { $each: [...learned] } }, $set: { updatedAt: new Date() } },
        { upsert: true },
      );
      out.learned[market] = [...learned];
    }
  }
  return out;
}

/**
 * A Gameflip owner id the radar had not known: remember it, and correct any row recorded while it
 * was unknown (our own listings stored as rivals). Bounded by the {seller, market} indexes.
 */
async function adoptGameflipOwner(owner, models) {
  const id = String(owner || "").trim();
  if (!id) return { fixedSales: 0, fixedRivals: 0 };
  const { MarketSale, MarketRival, MarketDataState } = models;
  await MarketDataState.updateOne({ _id: "ownSellers" }, { $addToSet: { gameflip: id }, $set: { updatedAt: new Date() } }, { upsert: true });
  const [s, r] = await Promise.all([
    MarketSale.updateMany({ seller: id, market: "gameflip", ours: false }, { $set: { ours: true } }),
    MarketRival.updateMany({ seller: id, market: "gameflip", ours: false }, { $set: { ours: true } }),
  ]);
  return { fixedSales: (s && s.modifiedCount) || 0, fixedRivals: (r && r.modifiedCount) || 0 };
}

module.exports = { applyJob, adoptGameflipOwner, lastSaleCounters, onlyDuplicates, RIVAL_PROJ, MAX_EXISTING };
