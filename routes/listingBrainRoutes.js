// Listing brain API (utils/listingBrain, docs/LISTING-BRAIN-PLAN.md §9) — TEST MODE: where each
// game's stock would go, what each offer would cost and when a live price would move, beside what
// today's code does at the same moment, and how well the brain forecasts. Read-only GETs only; the
// runner's only write is its own log, and nothing here starts it (routes/priceTrackerRoutes.real()
// does, at boot, in the live server only).
//
// Mounted by createRouter with the tracker's guards (superadmin + 2FA in the live server). Every
// route goes through getLB, which spreads them, so no route can be added without them.
//
// What leaves, and how:
// - Cells, offers and an offer's live listings are WHITELISTED, field by field (ROW_FIELDS,
//   OFFER_FIELDS, OFFER_LIVE_FIELDS), like the tracker's SALE_FIELDS: a field the model adds later
//   stays private until it is named here.
// - The status, a run's cfg / summary / counts / notes and the accuracy report are NOT whitelisted:
//   they are scrubbed by a BLOCKLIST (FORBIDDEN_KEYS, at any depth) — the identifying keys the loader
//   strips (listing ids, logins, sellers, order keys), free-text keys (note, title, url, description,
//   name, lastError) and the run's in-memory internals (bundle, ctx, the per-listing forecasts). A new
//   key there is shown unless it is on that list.
// - Whitelisted values are scrubbed the same way, so a slip in the model cannot leak through a nested
//   object either. The status's lastError is the one free text shown, cleaned like the loader's notes
//   (inputs.cleanMsg); a route error is a 500 with a cleaned message.

const FORCE_COOLDOWN_MS = 60 * 1000;
const HISTORY_DEFAULT = 72;
const HISTORY_MAX = 288;

// Same paging as routes/priceTrackerRoutes.js (module-private there, so copied).
function clamp(n, lo, hi, d) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v)) return d;
  return Math.min(hi, Math.max(lo, v));
}

function page(rows, q, def = 50) {
  const limit = clamp(q.limit, 1, 200, def);
  const offset = clamp(q.offset, 0, 1e6, 0);
  return { total: rows.length, offset, limit, rows: rows.slice(offset, offset + limit) };
}

// One cell (game × farm × market, or the game × farm "all" placement row), plan §6.
const ROW_FIELDS = Object.freeze(["k", "g", "f", "m", "live", "hl", "pc", "sc", "old", "br", "pol", "pf", "ev", "fl", "why"]);
// One offer (exact items on one market) in the newest in-memory run. No content key, no listing id.
const OFFER_FIELDS = Object.freeze(["k", "f", "m", "n", "ref", "conf", "basis", "regime", "p", "raw", "pH", "pHask", "value", "action", "gates", "thin", "stale", "packs", "why", "live"]);
// One live listing under an offer: its ask, age and verdict — never which listing it is.
const OFFER_LIVE_FIELDS = Object.freeze(["ask", "ageDays", "a", "p7a"]);

// Dropped wherever they appear, at any depth. The loader's privacy list (utils/listingBrain/inputs
// privacyScan), the hashed listing / order keys the model carries (id, l, lid, lids, grp), the log's
// own ids (_id, run), and the run's in-memory internals.
const FORBIDDEN_KEYS = new Set([
  "id", "_id", "run", "l", "lid", "lids", "listingId", "listingIds", "externalId", "orderId", "dedupeKey", "grp",
  "login", "logins", "loginLower", "account", "accountId", "accountLogin", "seller", "sellerName", "sellerScore",
  "sellerRatings", "contentId", "twitchId", "poolAccountId", "botId", "container", "email", "password", "token",
  // free text a listing or a ledger carries (a note names a login; a title, a link or a description
  // can say anything); lastError is put back cleaned by publicStatus
  "note", "title", "url", "description", "name", "lastError",
  "bundle", "ctx", "fc",
]);
const MAX_DEPTH = 12;
// The scorer's fixed explanation of a score block, put back by publicAccuracy, is at most this long.
const MAX_NOTE_CHARS = 600;

// The loader's cleaner (inputs.js requires only crypto and fs), loaded on first use: building the
// router loads nothing.
const cleanMsg = (e) => require("../utils/listingBrain/inputs").cleanMsg(e);

// A score table names its winner ("✓ best"). Whatever shape the scorer uses for it — a name, or an
// object carrying one — the page gets the name, so the `id` scrub cannot silently drop the winner.
function nameOf(x) {
  if (typeof x === "string") return x;
  if (x && typeof x === "object") for (const k of ["id", "policy", "name"]) if (typeof x[k] === "string") return x[k];
  return null;
}
function bestOf(x) {
  const own = nameOf(x);
  if (own != null || !x || typeof x !== "object" || Array.isArray(x) || x instanceof Date) return own != null ? own : x;
  // a per-farm map of winners: { claim: {id}, noclaim: {id} }
  const o = {};
  for (const k of Object.keys(x)) o[k] = nameOf(x[k]) != null ? nameOf(x[k]) : x[k];
  return o;
}

function scrub(v, depth = 0) {
  if (v === null || v === undefined) return v;
  if (typeof v === "function" || typeof v === "symbol" || typeof v === "bigint") return undefined;
  if (typeof v !== "object") return v;
  if (v instanceof Date) return v;
  // a database ObjectId (or anything BSON) is an id by definition
  if (depth > MAX_DEPTH || v._bsontype) return undefined;
  if (Array.isArray(v) || v instanceof Set) {
    return Array.from(v, (x) => {
      const y = scrub(x, depth + 1);
      return y === undefined ? null : y;
    });
  }
  const src = v instanceof Map ? Object.fromEntries(v) : v;
  const o = {};
  for (const k of Object.keys(src)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    const y = scrub(k === "best" ? bestOf(src[k]) : src[k], depth + 1);
    if (y !== undefined) o[k] = y;
  }
  return o;
}

function pick(obj, fields) {
  const o = {};
  if (!obj || typeof obj !== "object") return o;
  for (const k of fields) {
    if (obj[k] === undefined) continue;
    const y = scrub(obj[k], 1);
    if (y !== undefined) o[k] = y;
  }
  return o;
}

function publicRow(r) {
  return pick(r, ROW_FIELDS);
}

// The runner's status, scrubbed; its last error (the page shows it) put back cleaned.
function publicStatus(st) {
  const o = scrub(st || {});
  const err = st && st.lastError ? cleanMsg(st.lastError) : "";
  return Object.assign(o, { lastError: err });
}

// The scorer's report, scrubbed. Its own fixed explanation of each score block (score.js NOTE, which
// the page shows under it) is put back at exactly those two places; anything else named note stays
// dropped.
function publicAccuracy(a) {
  const o = scrub(a || {});
  for (const k of ["backtest", "forward"]) {
    const src = a && a[k];
    if (o[k] && src && typeof src.note === "string") o[k].note = src.note.slice(0, MAX_NOTE_CHARS);
  }
  return o;
}

function publicOffer(v) {
  const o = pick(v, OFFER_FIELDS.filter((k) => k !== "live"));
  o.live = v && Array.isArray(v.live) ? v.live.map((x) => pick(x, OFFER_LIVE_FIELDS)) : [];
  return o;
}

// A logged row of a cell's history: the row plus when it was logged.
function publicHistoryRow(r) {
  return Object.assign({ at: r && r.at != null ? scrub(r.at) : null }, publicRow(r));
}

// "gameKey|farm|market". Read from the right: a game key is free text, the farm and market are not.
function parseKey(key) {
  const parts = String(key || "").split("|");
  if (parts.length < 3) return null;
  const m = parts.pop();
  const f = parts.pop();
  const g = parts.join("|");
  if (!g || !m || (f !== "claim" && f !== "noclaim")) return null;
  return { g, f, m };
}

const num = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
// Today's price for the cell: the median live ask of the system-made rows, else what a new listing
// would get today. A cell with neither (or no brain price) has no price gap, not a gap of zero dollars.
function priceGap(r) {
  const o = r.old || {};
  const b = r.br || {};
  const base = o.a != null ? o.a : o.np;
  return base == null || b.p == null ? 0 : Math.abs(num(b.p) - num(base));
}
function shelfGap(r) {
  const o = r.old || {};
  const b = r.br || {};
  return o.sh == null || b.sh == null ? 0 : Math.abs(num(b.sh) - num(o.sh));
}
const PRICE_DISAGREE = new Set(["brain-lower", "brain-higher"]);
const SHELF_DISAGREE = new Set(["brain-more", "brain-fewer", "brain-add", "brain-drop"]);
const desc = (f) => (a, c) => f(c) - f(a);
const LB_SORTS = {
  // disagreements (price or shelf) first, then the size of the gap ($ + units)
  gap: desc((r) => (PRICE_DISAGREE.has(r.pc) || SHELF_DISAGREE.has(r.sc) ? 1e6 : 0) + priceGap(r) + shelfGap(r)),
  value: desc((r) => num(r.br && r.br.wv)),
  price: desc(priceGap),
  shelf: desc(shelfGap),
  market: (a, c) => String(a.m).localeCompare(String(c.m)),
};
const byName = (a, c) => String(a.g).localeCompare(String(c.g)) || String(a.f).localeCompare(String(c.f)) || String(a.m).localeCompare(String(c.m));

function mount(router, { guards = [], brain = null } = {}) {
  // Lazy: requiring this file (or building the tracker router) loads no runner, model or database
  // module; the tests and the preview inject `brain`.
  const B = () => brain || require("../utils/listingBrain");
  let lastForceLB = 0;
  // Every listing-brain route goes through here, which spreads the guards.
  const getLB = (path, fn) =>
    router.get(path, ...guards, async (req, res) => {
      try {
        await fn(req, res, B());
      } catch (e) {
        let message = "listing brain error";
        try {
          message = cleanMsg(e);
        } catch {
          // the cleaner itself failed: the fixed text above, never the raw one
        }
        res.status(500).json({ success: false, message });
      }
    });

  getLB("/api/price-tracker/listing-brain/status", (req, res, b) => {
    res.json({ ...publicStatus(b.status()), success: true });
  });

  getLB("/api/price-tracker/listing-brain/latest", async (req, res, b) => {
    const run = await b.latest();
    if (!run) return res.json({ success: true, empty: true, status: publicStatus(b.status()) });
    let rows = Array.isArray(run.rows) ? run.rows : [];
    const q = req.query;
    const farm = String(q.farm || "");
    const m = String(q.m || "");
    const pc = String(q.pc || "");
    const sc = String(q.sc || "");
    const s = String(q.q || "").toLowerCase().trim();
    if (farm === "claim" || farm === "noclaim") rows = rows.filter((r) => r.f === farm);
    if (m) rows = rows.filter((r) => r.m === m);
    if (pc) rows = rows.filter((r) => r.pc === pc);
    if (sc) rows = rows.filter((r) => r.sc === sc);
    if (q.live === "1") rows = rows.filter((r) => r.live);
    if (s) rows = rows.filter((r) => String(r.g).toLowerCase().includes(s) || String(r.k).toLowerCase().includes(s));
    const sort = Object.prototype.hasOwnProperty.call(LB_SORTS, q.sort) ? LB_SORTS[q.sort] : LB_SORTS.gap;
    rows = [...rows].sort((a, c) => (c.live ? 1 : 0) - (a.live ? 1 : 0) || sort(a, c) || byName(a, c));
    const pg = page(rows, q, 50);
    const sum = run.summary || {};
    res.json({
      success: true,
      at: run.at,
      v: run.v,
      ms: run.ms,
      cfg: scrub(run.cfg || {}),
      summary: scrub(sum),
      counts: scrub(run.counts || {}),
      notes: scrub(Array.isArray(run.notes) ? run.notes : []),
      persisted: run.persisted !== false,
      // false when the run was computed with its log write switched off (the preview), so the page
      // does not call that a failed write
      logged: run.logged !== false,
      // how many per-listing forecasts this run logged for the live test (a count, never the list)
      fcN: Number.isFinite(run.fcN) ? run.fcN : typeof sum.fc === "number" ? sum.fc : null,
      status: publicStatus(b.status()),
      total: pg.total,
      offset: pg.offset,
      limit: pg.limit,
      rows: pg.rows.map(publicRow),
    });
  });

  getLB("/api/price-tracker/listing-brain/cell/:key", async (req, res, b) => {
    const key = String(req.params.key || "");
    const c = parseKey(key);
    if (!c) return res.status(400).json({ success: false, message: "a cell is named game|farm|market (farm: claim or noclaim)" });
    const run = await b.latest();
    const same = (x) => x && x.k === c.g && x.f === c.f && x.m === c.m;
    const row = run && Array.isArray(run.rows) ? run.rows.find(same) || null : null;
    // Offers (with reasons) live only in the newest in-memory run; after a restart there are none.
    const offers = run && Array.isArray(run.offers) ? run.offers.filter(same).map(publicOffer) : [];
    const history = (await b.cellHistory(key, clamp(req.query.limit, 1, HISTORY_MAX, HISTORY_DEFAULT))) || [];
    if (!row && !history.length) return res.status(404).json({ success: false, message: "the listing brain has not logged this cell" });
    res.json({
      success: true,
      key,
      g: c.g,
      f: c.f,
      m: c.m,
      at: run ? run.at : null,
      row: row ? publicRow(row) : null,
      offers,
      history: history.map(publicHistoryRow),
    });
  });

  getLB("/api/price-tracker/listing-brain/accuracy", async (req, res, b) => {
    let force = false;
    if (req.query.force === "1" && Date.now() - lastForceLB > FORCE_COOLDOWN_MS) {
      lastForceLB = Date.now();
      force = true;
    }
    const a = await b.accuracy({ force });
    if (!a) return res.json({ success: true, empty: true });
    res.json({ ...publicAccuracy(a), success: true });
  });
}

module.exports = { mount, publicRow, publicOffer, ROW_FIELDS, OFFER_FIELDS, OFFER_LIVE_FIELDS, FORBIDDEN_KEYS };
