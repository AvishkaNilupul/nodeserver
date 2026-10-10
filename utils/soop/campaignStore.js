// SOOP farm — campaign store (docs/SOOP-FARM-CONTRACT.md §8).
//
// The campaign list is the same for every account, so the whole farm shares
// one cached scan. SOOP also drops an event from its list mid-broadcast, so
// every campaign ever seen is remembered (memory + the SoopCampaign
// collection) and can still be looked up by id as filter "unlisted".
//
// What is stored is SOOP's raw text and raw lists, never the normalised shape:
// a Campaign is rebuilt through normalize.js on demand, so a glossary change,
// a renamed game or a fixed translation applies to old rows too.

const SoopCampaign = require("../../models/SoopCampaign");
const SoopGame = require("../../models/SoopGame");
const SoopTranslation = require("../../models/SoopTranslation");
const { normalizeCampaign } = require("./normalize");

const KST_MS = 9 * 60 * 60 * 1000;
const MAX_SOURCE = 500;
const MAX_ENGLISH = 500;
const MAX_GAME_NAME = 80;

const str = (v) => (v === undefined || v === null ? "" : String(v));
const strOrNull = (v) => (str(v) === "" ? null : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);
const ms = (d) => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.getTime() : 0);
const log = (what, err) => console.error(`[soop] campaign store ${what}:`, err && err.message);

function createCampaignStore({
  models = { SoopCampaign, SoopGame, SoopTranslation },
  ttlMs = 60000,
  staleOkMs = 600000,
  now = Date.now,
} = {}) {
  const known = new Map(); // dropsIdx -> stored-shape record of every campaign ever seen
  const scanned = new Set(); // ids whose record came from a scan of this process
  const translations = new Map(); // exact SOOP text -> English
  const gameNames = Object.create(null); // gameNo -> operator's name
  const hiddenGames = new Set();
  let good = { at: null, raws: [], list: [] }; // the last successful scan
  let view = null; // { unlisted, byId } derived from `good` + `known`; null = rebuild
  let inflight = null;
  let saving = Promise.resolve(); // tail of the campaign write queue
  let scanInfo = { at: null, ok: false, error: null, count: 0 };

  const opts = (filter) => ({ overrides: translations, gameOverrides: gameNames, filter });

  // ---- stored row <-> Campaign --------------------------------------------

  function toRecord(raw, c, at, prev) {
    return {
      dropsIdx: c.dropsIdx,
      title: c.title,
      titleRaw: str(raw.title),
      image: strOrNull(raw.image),
      giveCon: str(raw.giveCon),
      gameNo: strOrNull(raw.gameNo),
      cateName: str(raw.cateName),
      cateNo: str(raw.cateNo),
      ingameGiveYn: str(raw.ingameGiveYn),
      typeNm: strOrNull(raw.typeNm),
      live: c.live,
      lastLiveAt: c.live ? new Date(at) : (prev && prev.lastLiveAt) || null,
      filter: c.filter,
      startDate: c.startAt,
      endDate: c.endAt,
      broadIdList: arr(raw.broadIdList),
      itemList: arr(raw.itemList),
      seenAt: new Date(at),
    };
  }

  // A row read back from the collection. v1 wrote no `titleRaw` and parsed
  // SOOP's Korea-time strings as server time, so its dates sit nine hours late;
  // a row SOOP no longer lists is never rescanned, so they are corrected here.
  function fromDoc(doc) {
    const late = "titleRaw" in doc ? 0 : KST_MS;
    const fix = (d) => (ms(d) ? new Date(ms(d) - late) : null);
    return {
      ...doc,
      dropsIdx: String(doc.dropsIdx),
      startDate: fix(doc.startDate),
      endDate: fix(doc.endDate),
    };
  }

  // Rebuild a Campaign from a remembered record. It is not on SOOP's list any
  // more, so whatever `live` said when it was last seen no longer holds.
  function fromRecord(rec) {
    const c = normalizeCampaign(
      {
        dropsIdx: rec.dropsIdx,
        title: rec.titleRaw || rec.title || "",
        image: rec.image || null,
        giveCon: rec.giveCon || "",
        gameNo: rec.gameNo || null,
        cateName: rec.cateName || "",
        cateNo: rec.cateNo || "",
        ingameGiveYn: rec.ingameGiveYn || "",
        typeNm: rec.typeNm || null,
        broadIdList: arr(rec.broadIdList),
        itemList: arr(rec.itemList),
        live: false,
      },
      opts("unlisted"),
    );
    c.filter = "unlisted";
    c.live = false;
    // The stored dates are already instants; they must not go through parseKst.
    c.startAt = ms(rec.startDate) ? new Date(ms(rec.startDate)) : null;
    c.endAt = ms(rec.endDate) ? new Date(ms(rec.endDate)) : null;
    return c;
  }

  // One malformed row from SOOP must not cost the whole list.
  function safely(what, fn) {
    try {
      return fn();
    } catch (err) {
      log(`skipped a ${what}`, err);
      return null;
    }
  }

  function getView() {
    if (view) return view;
    const byId = new Map(good.list.map((c) => [c.dropsIdx, c]));
    const unlisted = [...known.values()]
      .filter((rec) => !byId.has(rec.dropsIdx))
      .sort((a, b) => ms(b.seenAt) - ms(a.seenAt)) // most recently seen first
      .map((rec) => safely("stored row", () => fromRecord(rec)))
      .filter(Boolean);
    for (const c of unlisted) byId.set(c.dropsIdx, c);
    view = { unlisted, byId };
    return view;
  }

  // Overrides changed: the cached Campaigns carry the old names.
  function renormalise() {
    good.list = good.raws
      .map((raw) => safely("listed row", () => normalizeCampaign(raw, opts())))
      .filter(Boolean);
    view = null;
  }

  // ---- scanning -------------------------------------------------------------

  function remember(raws, at) {
    const seen = new Set();
    const keep = [];
    const list = [];
    const ops = [];
    for (const raw of raws) {
      if (!raw || str(raw.dropsIdx) === "") continue;
      const c = safely("listed row", () => normalizeCampaign(raw, opts()));
      if (!c || !c.dropsIdx || seen.has(c.dropsIdx)) continue;
      seen.add(c.dropsIdx);
      const rec = toRecord(raw, c, at, known.get(c.dropsIdx));
      known.set(c.dropsIdx, rec);
      scanned.add(c.dropsIdx);
      keep.push(raw);
      list.push(c);
      // `lastLiveAt` is only written while live, so the last time survives.
      const { dropsIdx, lastLiveAt, ...set } = rec;
      if (rec.live) set.lastLiveAt = lastLiveAt;
      ops.push({ updateOne: { filter: { dropsIdx }, update: { $set: set }, upsert: true } });
    }
    // v1 never cleared `live`: a campaign that left the list stayed "live" for
    // good. SOOP not reporting it at all is the same as reporting it not live.
    for (const rec of known.values()) if (!seen.has(rec.dropsIdx)) rec.live = false;
    ops.push({
      updateMany: {
        filter: { dropsIdx: { $nin: [...seen] }, live: true },
        update: { $set: { live: false } },
      },
    });
    good = { at, raws: keep, list };
    view = null;
    // Fire and forget: the list is served from memory, a slow or failed write
    // must not delay or fail the scan. Writes are chained so that two scans
    // close together cannot land out of order and leave a stale `live` behind.
    saving = saving
      .then(() => models.SoopCampaign.bulkWrite(ops, { ordered: false }))
      .catch((err) => log("save failed", err));
    return list;
  }

  async function runScan(scan) {
    let raws;
    try {
      if (typeof scan !== "function") throw new Error("no campaign scan available");
      raws = await scan();
      if (!Array.isArray(raws)) throw new Error("campaign scan returned no list");
    } catch (err) {
      const at = now();
      scanInfo = {
        at: new Date(at),
        ok: false,
        error: str(err && err.message).slice(0, 300) || "scan failed",
        count: good.list.length,
      };
      // A blip must not blank the panel or stop the bots: serve the last good
      // list while it is young enough. The cache time is NOT renewed, so the
      // next caller tries SOOP again.
      if (good.at !== null && at - good.at < staleOkMs) return good.list;
      throw err;
    }
    const at = now();
    const list = remember(raws, at);
    scanInfo = { at: new Date(at), ok: true, error: null, count: list.length };
    return list;
  }

  function list({ scan, force = false } = {}) {
    // `good.at` rather than the list length decides freshness: v1 treated an
    // empty list as "no cache" and rescanned SOOP on every call while it was empty.
    if (!force && good.at !== null && now() - good.at < ttlMs) return Promise.resolve(good.list);
    if (!inflight) {
      inflight = runScan(scan).finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  // ---- reads ----------------------------------------------------------------

  async function get(dropsIdx) {
    const key = str(dropsIdx).trim();
    if (!key) return null;
    const hit = getView().byId.get(key);
    if (hit) return hit;
    const doc = await models.SoopCampaign.findOne({ dropsIdx: key }).lean();
    if (!doc) return null;
    if (!known.has(key)) known.set(key, fromDoc(doc));
    view = null;
    return getView().byId.get(key) || null;
  }

  function all() {
    return [...good.list, ...getView().unlisted];
  }

  function games() {
    const groups = new Map();
    for (const c of all()) {
      if (c.gameNo && hiddenGames.has(c.gameNo)) continue;
      // A v1 row has no gameNo; group those by name instead of into one heap.
      const key = c.gameNo ? `#${c.gameNo}` : `~${c.gameName}`;
      let g = groups.get(key);
      if (!g) {
        g = { gameNo: c.gameNo || null, name: c.gameName || "Other", campaigns: 0, live: 0, guaranteed: 0 };
        groups.set(key, g);
      }
      g.campaigns += 1;
      if (c.live) g.live += 1;
      if (c.guaranteed) g.guaranteed += 1;
    }
    return [...groups.values()].sort((a, b) => b.live - a.live || a.name.localeCompare(b.name));
  }

  const lastScan = () => ({ ...scanInfo });

  // ---- overrides --------------------------------------------------------------

  // An empty name / English text removes the override. The database is written
  // first so memory never shows a name that would be gone after a restart.
  async function setGameName(gameNo, name) {
    const key = str(gameNo).trim();
    if (!key || key.length > 32) throw new Error("gameNo is required");
    const value = str(name).trim().slice(0, MAX_GAME_NAME);
    await models.SoopGame.updateOne({ gameNo: key }, { $set: { name: value } }, { upsert: true });
    if (value) gameNames[key] = value;
    else delete gameNames[key];
    renormalise();
  }

  async function setTranslation(source, english) {
    // Not trimmed: the override is matched against SOOP's exact text.
    const key = str(source);
    if (!key.trim() || key.length > MAX_SOURCE) throw new Error("source text is required");
    const value = str(english).trim().slice(0, MAX_ENGLISH);
    if (value) {
      await models.SoopTranslation.updateOne({ source: key }, { $set: { english: value } }, { upsert: true });
      translations.set(key, value);
    } else {
      await models.SoopTranslation.deleteOne({ source: key });
      translations.delete(key);
    }
    renormalise();
  }

  // ---- boot -------------------------------------------------------------------

  // Each collection loads on its own and a failure is logged, not thrown: the
  // farm must still start (and scan SOOP) when the remembered rows cannot be read.
  async function load() {
    const loaded = { campaigns: 0, games: 0, translations: 0 };
    const part = (what, fn) => fn().catch((err) => log(`${what} load failed`, err));
    await Promise.all([
      part("campaign", async () => {
        const docs = await models.SoopCampaign.find({}).lean();
        for (const doc of docs) {
          const key = str(doc && doc.dropsIdx);
          // A record scanned by this process is newer than its stored copy.
          if (!key || scanned.has(key)) continue;
          known.set(key, fromDoc(doc));
          loaded.campaigns += 1;
        }
      }),
      part("game", async () => {
        const docs = await models.SoopGame.find({}).lean();
        for (const key of Object.keys(gameNames)) delete gameNames[key];
        hiddenGames.clear();
        for (const doc of docs) {
          const key = str(doc && doc.gameNo);
          if (!key) continue;
          if (doc.name) gameNames[key] = String(doc.name);
          if (doc.hidden) hiddenGames.add(key);
          loaded.games += 1;
        }
      }),
      part("translation", async () => {
        const docs = await models.SoopTranslation.find({}).lean();
        translations.clear();
        for (const doc of docs) {
          if (!doc || !doc.source || !doc.english) continue;
          translations.set(String(doc.source), String(doc.english));
          loaded.translations += 1;
        }
      }),
    ]);
    renormalise();
    return loaded;
  }

  return { load, list, get, all, games, setGameName, setTranslation, lastScan };
}

module.exports = { createCampaignStore };
