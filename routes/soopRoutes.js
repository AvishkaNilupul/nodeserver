// HTTP API for the SOOP drops farm (docs/SOOP-FARM-CONTRACT.md §11).
//
// Thin handlers: check the shape of the input, call the farm service
// (utils/soopFarm.js) and return what it answered. Every route is
// superadmin-only. Request bodies carry session cookies, so nothing here logs
// one, and a reward code leaves through exactly one route — /inventory/reveal —
// which records who asked for it.
const crypto = require("node:crypto");
const express = require("express");

const { requireSuperadmin } = require("../middleware/auth");
const farm = require("../utils/soopFarm");
const { SoopError } = require("../utils/soop/errors");
const TwitchWebCookie = require("../models/TwitchWebCookie");
const { encrypt } = require("../utils/secretBox");
const twitchJar = require("../utils/soop/twitchJar");

const router = express.Router();

const MAX_LIST = 500;
const MAX_COOKIE_BYTES = 2 * 1024 * 1024;
const MAX_JAR = 100; // cookies in one Twitch login's jar (twitch.tv sets about 15)
const LEVELS = ["info", "warn", "error"];
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

// Shared-secret auth for /accounts/save-twitch-cookies — the harvester
// userscript running in a browser does not carry an admin session. The key
// must be at least 32 characters long; anything shorter is treated as unset
// and the endpoint falls through to superadmin.
const HARVEST_KEY = (() => {
  const k = String(process.env.SOOP_HARVEST_KEY || "").trim();
  if (k && k.length < 32) {
    console.warn("[soopRoutes] SOOP_HARVEST_KEY is set but under 32 chars — ignoring it");
    return "";
  }
  return k;
})();
const HARVEST_KEY_BUF = HARVEST_KEY ? Buffer.from(HARVEST_KEY, "utf8") : null;

function requireHarvestKey(req, res, next) {
  if (!HARVEST_KEY_BUF) return requireSuperadmin(req, res, next);
  const supplied =
    String(req.headers["x-harvest-key"] || "") ||
    String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  if (supplied) {
    const a = Buffer.from(supplied, "utf8");
    if (a.length === HARVEST_KEY_BUF.length && crypto.timingSafeEqual(a, HARVEST_KEY_BUF)) {
      return next();
    }
  }
  return res.status(401).json({ success: false, error: "bad or missing harvest key" });
}

function cookieExpiryDate(cookies, name) {
  const c = (cookies || []).find((x) => x && x.name === name);
  if (!c || !c.expirationDate) return null;
  return new Date(c.expirationDate * 1000);
}

// SoopError codes -> what the operator reads. SOOP's own wording stays in the log.
const UPSTREAM = new Map([
  ["EGRESS", "Could not reach SOOP — the proxy or the network is down"],
  ["TIMEOUT", "SOOP did not answer in time — try again in a moment"],
  ["HTTP", "SOOP sent a reply that could not be read — try again in a moment"],
  ["API", "SOOP refused the request — try again in a moment"],
  ["AUTH", "SOOP says the account is logged out — re-import its cookie"],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (message) => {
  throw new HttpError(400, message);
};

function fail(res, status, message) {
  return res.status(status).json({ success: false, error: message, message });
}

// ---- input ------------------------------------------------------------------

// A trimmed string, or undefined when the field was not sent. Numbers are
// accepted because SOOP ids (dropsIdx, gameNo) are numeric and a caller may
// send them unquoted.
function text(value, name, { required = false, max = 200 } = {}) {
  if (value === undefined || value === null) {
    if (required) bad(`${name} is required`);
    return undefined;
  }
  const ok = typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
  if (!ok) bad(`${name} must be text`);
  const s = String(value).trim();
  if (required && !s) bad(`${name} is required`);
  if (s.length > max) bad(`${name} is too long (${max} characters at most)`);
  return s;
}

// A list of ids: an array of strings, trimmed, blanks and repeats dropped.
function idList(value, name, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) bad(`${name} is required`);
    return [];
  }
  if (!Array.isArray(value)) bad(`${name} must be a list`);
  if (value.length > MAX_LIST) bad(`${name} can hold ${MAX_LIST} entries at most`);
  const out = new Set();
  for (const v of value) {
    if (typeof v !== "string" || v.length > 100) bad(`${name} must be a list of ids`);
    if (v.trim()) out.add(v.trim());
  }
  if (required && !out.size) bad(`${name} is empty — pick at least one`);
  return [...out];
}

function flag(value, name) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") bad(`${name} must be true or false`);
  return value;
}

// The farm answers { ok: false, error } with a sentence meant for the operator.
// "Unknown bot" is the one answer that means the id does not exist.
function unwrap(result) {
  if (result && result.ok === false) {
    const message = result.error || "That could not be done";
    throw new HttpError(/^unknown bot\b/i.test(message) ? 404 : 400, message);
  }
  return result || {};
}

// ---- plumbing ---------------------------------------------------------------

// handler({ body, query, req, res }) returns the payload (without `success`),
// or sends the response itself.
function route(method, path, handler) {
  const name = path.slice(1).replace(/\//g, " ");
  router[method]("/api/soop" + path, requireSuperadmin, async (req, res) => {
    try {
      const b = req.body;
      const body = b && typeof b === "object" && !Array.isArray(b) ? b : {};
      const out = await handler({ body, query: req.query || {}, req, res });
      if (!res.headersSent) res.json({ success: true, ...(out || {}) });
    } catch (err) {
      if (err instanceof HttpError) return fail(res, err.status, err.message);
      console.error(`soop ${name} error:`, err && err.message);
      if (res.headersSent) return undefined;
      const upstream = err instanceof SoopError ? UPSTREAM.get(err.code) : null;
      return fail(res, upstream ? 502 : 500, upstream || "Server error");
    }
  });
}

// ---- state and campaigns ----------------------------------------------------

route("get", "/state", () => farm.stateView());

route("get", "/campaigns", ({ query }) =>
  farm.campaignsView({ force: ["1", "true"].includes(String(query.force || "")) }),
);

// ---- accounts ---------------------------------------------------------------

// One or many Cookie-Editor exports in one paste; one result per account.
route("post", "/accounts/import", async ({ body }) => {
  if (typeof body.cookies !== "string") bad("Paste a cookie export first");
  const cookies = body.cookies.trim();
  if (!cookies) bad("Paste a cookie export first");
  if (Buffer.byteLength(cookies) > MAX_COOKIE_BYTES) {
    bad("That paste is larger than 2 MB — import it in smaller batches");
  }
  return { results: await farm.importAccounts(cookies) };
});

// Empty list = every account that is not sold. Runs in the background.
route("post", "/accounts/check", async ({ body }) => {
  const { total } = await farm.checkAccounts(idList(body.ids, "ids"));
  return { total };
});

route("post", "/accounts/update", async ({ body }) => {
  const id = text(body.id, "id", { required: true });
  const sold = flag(body.sold, "sold");
  const note = text(body.note, "note", { max: 500 });
  if (sold === undefined && note === undefined) bad("Nothing to change — send sold or note");
  const ok = await farm.updateAccount(id, { sold, note });
  if (!ok) throw new HttpError(404, "Unknown account");
  return {};
});

route("post", "/accounts/delete", async ({ body }) => ({
  deleted: await farm.deleteAccounts(idList(body.ids, "ids", { required: true })),
}));

// ---- bots -------------------------------------------------------------------

route("post", "/bots/create", async ({ body }) => {
  const { bot } = unwrap(
    await farm.createBot({
      name: text(body.name, "name", { max: 120 }),
      mode: text(body.mode, "mode", { max: 20 }),
      dropsIdx: text(body.dropsIdx, "dropsIdx", { max: 40 }),
      gameNo: text(body.gameNo, "gameNo", { max: 32 }),
      accountIds: idList(body.accountIds, "accountIds", { required: true }),
      target: text(body.target, "target", { max: 20 }),
      codesOnly: flag(body.codesOnly, "codesOnly"),
      priorityGameNo: text(body.priorityGameNo, "priorityGameNo", { max: 32 }),
      autoJoin: flag(body.autoJoin, "autoJoin"),
    }),
  );
  return { bot };
});

route("post", "/bots/update", async ({ body }) => {
  const id = text(body.id, "id", { required: true });
  const { bot } = unwrap(
    await farm.updateBot(id, {
      name: text(body.name, "name", { max: 120 }),
      target: text(body.target, "target", { max: 20 }),
      addIds: idList(body.addIds, "addIds"),
      removeIds: idList(body.removeIds, "removeIds"),
      priorityGameNo: text(body.priorityGameNo, "priorityGameNo", { max: 32 }),
      autoJoin: flag(body.autoJoin, "autoJoin"),
    }),
  );
  return { bot };
});

route("post", "/bots/stop", async ({ body }) => {
  if (flag(body.all, "all") === true) return { stopped: await farm.stopAllBots() };
  unwrap(await farm.stopBot(text(body.id, "id", { required: true })));
  return { stopped: 1 };
});

route("post", "/bots/resume", async ({ body }) => {
  unwrap(await farm.resumeBot(text(body.id, "id", { required: true })));
  return {};
});

route("post", "/bots/delete", async ({ body }) => {
  unwrap(await farm.deleteBot(text(body.id, "id", { required: true })));
  return {};
});

// ---- names ------------------------------------------------------------------

// An empty name / english removes the override.
route("post", "/games/rename", async ({ body }) => {
  const gameNo = text(body.gameNo, "gameNo", { required: true, max: 32 });
  if (typeof body.name !== "string") bad("name must be text");
  await farm.renameGame(gameNo, text(body.name, "name", { max: 80 }));
  return {};
});

route("post", "/translate", async ({ body }) => {
  // The source is NOT trimmed: an override is matched against SOOP's exact text.
  const { source, english } = body;
  if (typeof source !== "string" || !source.trim()) bad("source is required");
  if (source.length > 500) bad("source is too long (500 characters at most)");
  if (typeof english !== "string") bad("english must be text");
  await farm.setTranslation(source, text(english, "english", { max: 500 }));
  return {};
});

// ---- inventory --------------------------------------------------------------

route("get", "/inventory/summary", async () => ({
  ...(await farm.inventory.summary()),
  sync: farm.inventory.status(),
}));

route("get", "/inventory/account", async ({ query }) => ({
  items: await farm.inventory.forAccount(text(query.id, "id", { required: true })),
}));

// Empty list = every account that is not sold. Runs in the background.
route("post", "/inventory/sync", async ({ body }) => {
  let ids = idList(body.ids, "ids");
  if (!ids.length) {
    const { accounts } = await farm.stateView();
    ids = accounts.filter((a) => !a.sold).map((a) => a.id);
  }
  const { total } = farm.inventory.syncMany(ids);
  return { total };
});

route("post", "/inventory/reveal", async ({ body, req, res }) => {
  const itemId = text(body.itemId, "itemId", { required: true });
  if (!OBJECT_ID_RE.test(itemId)) bad("itemId is not an inventory item id");
  const found = await farm.inventory.reveal(itemId);
  if (!found || (!found.code && !found.claim)) throw new HttpError(404, "No code is stored for that item");
  const code = found.code;
  const admin = (req.session && req.session.admin) || {};
  const who = String(admin.username || admin.id || "unknown admin").slice(0, 80);
  // The entry names who and which item — never the code itself.
  farm.activity.add({
    kind: "reveal",
    msg: `${who} revealed the code of inventory item ${itemId}`,
    data: { itemId, admin: who },
  });
  res.set("Cache-Control", "no-store");
  return { code, claim: found.claim || null };
});

// Claims ONE reward on SOOP with the account's stored session. Irreversible, so
// it is only ever a deliberate click, and it is recorded with who clicked.
route("post", "/inventory/claim", async ({ body, req, res }) => {
  const itemId = text(body.itemId, "itemId", { required: true });
  if (!OBJECT_ID_RE.test(itemId)) bad("itemId is not an inventory item id");
  const out = await farm.inventory.claim(itemId);
  if (!out.ok) throw new HttpError(/unknown/i.test(out.error) ? 404 : 400, out.error);
  const admin = (req.session && req.session.admin) || {};
  const who = String(admin.username || admin.id || "unknown admin").slice(0, 80);
  farm.activity.add({
    kind: "claim",
    accountId: out.result.loginId,
    msg: `${who} claimed "${out.result.name}" on ${out.result.loginId}`,
    data: { itemId, admin: who, kind: out.result.kind },
  });
  res.set("Cache-Control", "no-store");
  return { result: out.result };
});

route("get", "/inventory/export.csv", async ({ res }) => {
  const csv = await farm.inventory.csv();
  res.set({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": 'attachment; filename="soop-inventory.csv"',
    "Cache-Control": "no-store",
  });
  res.send(csv);
});

// ---- activity ---------------------------------------------------------------

route("get", "/activity", ({ query }) => {
  const level = text(query.level, "level", { max: 10 }) || undefined;
  if (level && !LEVELS.includes(level)) bad("level must be info, warn or error");
  const asked = text(query.limit, "limit", { max: 9 });
  const limit = asked ? Number(asked) : 200;
  if (!Number.isInteger(limit) || limit < 1) bad("limit must be a whole number above zero");
  return {
    entries: farm.activity.recent({
      limit: Math.min(limit, MAX_LIST),
      level,
      accountId: text(query.accountId, "accountId") || undefined,
      botId: text(query.botId, "botId") || undefined,
    }),
  };
});

// ---- Twitch -> SOOP cookie auto-renew --------------------------------------

// Harvester drop-off. Shape (same as the old emailnator-proxy endpoint it
// replaces): { Login, cookies: [cookie-editor shape], source? }. password is
// never sent and never stored — the OAuth replay re-mints SOOP cookies from
// the twitch.tv jar alone. Shared-secret auth (SOOP_HARVEST_KEY) or
// superadmin when the key is unset.
router.post("/api/soop/accounts/save-twitch-cookies", requireHarvestKey, async (req, res) => {
  try {
    const b = req.body && typeof req.body === "object" ? req.body : {};
    const login = String(b.Login || b.login || "").trim().toLowerCase();
    if (!login) return fail(res, 400, "missing login");
    if (!Array.isArray(b.cookies)) return fail(res, 400, "cookies must be an array");

    const cookies = b.cookies.filter(
      (c) =>
        c &&
        typeof c.name === "string" &&
        c.value != null &&
        /twitch\.tv/i.test(String(c.domain || "")),
    );
    if (!cookies.length) return fail(res, 400, "no twitch.tv cookies");

    const names = new Set(cookies.map((c) => c.name));
    if (!names.has("auth-token")) return fail(res, 400, "missing auth-token — login didn't complete?");
    const shortLived = !names.has("persistent");

    await TwitchWebCookie.findOneAndUpdate(
      { twitchLogin: login },
      {
        $set: {
          twitchLogin: login,
          cookies: encrypt(JSON.stringify(cookies)),
          cookieCount: cookies.length,
          shortLived,
          persistentExpiresAt: cookieExpiryDate(cookies, "persistent"),
          authTokenExpiresAt: cookieExpiryDate(cookies, "auth-token"),
          harvestedAt: new Date(),
          source: String(b.source || ""),
        },
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    );
    const total = await TwitchWebCookie.countDocuments();
    res.set("Cache-Control", "no-store");
    res.json({ success: true, login, cookieCount: cookies.length, shortLived, totalAccounts: total });
  } catch (err) {
    console.error("soop accounts save-twitch-cookies error:", err && err.message);
    fail(res, 500, "Server error");
  }
});

// Admin inventory of harvested Twitch cookies — the UI picker reads this to
// show which SOOP accounts can be auto-renewed. No cookie plaintext leaves.
route("get", "/accounts/twitch-cookies", async () => {
  const rows = await TwitchWebCookie.find({})
    .select("twitchLogin cookieCount shortLived persistentExpiresAt authTokenExpiresAt harvestedAt source")
    .sort({ twitchLogin: 1 })
    .lean();
  const now = Date.now();
  return {
    count: rows.length,
    accounts: rows.map((r) => ({
      twitchLogin: r.twitchLogin,
      cookieCount: r.cookieCount,
      shortLived: !!r.shortLived,
      persistentDaysLeft: r.persistentExpiresAt
        ? +((r.persistentExpiresAt.getTime() - now) / 86400000).toFixed(1)
        : null,
      authTokenDaysLeft: r.authTokenExpiresAt
        ? +((r.authTokenExpiresAt.getTime() - now) / 86400000).toFixed(1)
        : null,
      harvestedAt: r.harvestedAt,
      source: r.source,
    })),
  };
});

// Set / clear the Twitch login that drives auto-renew for one SOOP account.
// Empty string removes the mapping (auto-renew is skipped for that account).
route("post", "/accounts/twitch-link", async ({ body }) => {
  const id = text(body.id, "id", { required: true });
  const twitchLogin = text(body.twitchLogin, "twitchLogin", { max: 60 });
  if (twitchLogin === undefined) bad("twitchLogin is required (empty string clears)");
  const value = await farm.setTwitchLogin(id, twitchLogin);
  if (value === null) throw new HttpError(404, "Unknown account");
  return { id, twitchLogin: value };
});

// The SOOP page's "Twitch logins" dialog, one Twitch login per request:
//   { cookies: [twitch.tv cookies], login?, soopId?, capturedAt?, source? }
// stores that login's cookies and links it to the SOOP account `soopId`.
// Without `cookies` it only links cookies stored before. The login is read
// from the jar's own `login` cookie; a file that names another login is
// refused. A link is never overwritten (utils/soop/twitchJar.js linkJar).
route("post", "/accounts/twitch-cookies/import", async ({ body }) => {
  const named = (text(body.login, "login", { max: 60 }) || "").toLowerCase();
  const soopId = text(body.soopId, "soopId", { max: 100 }) || "";
  let login = named;
  let saved = null;
  if (body.cookies !== undefined && body.cookies !== null) {
    if (!Array.isArray(body.cookies)) bad("cookies must be a list");
    if (body.cookies.length > MAX_JAR) bad(`cookies can hold ${MAX_JAR} entries at most`);
    const cookies = twitchJar.twitchCookies(body.cookies);
    if (!cookies.length) bad("No twitch.tv cookie in it — save the cookies while signed in on twitch.tv");
    const own = twitchJar.loginOf(cookies);
    if (own && named && own !== named) bad(`These cookies are signed in as ${own}, not ${named}`);
    login = own || named;
    if (!login) bad("Could not tell which Twitch login these cookies are for — the login cookie is missing");
    if (!twitchJar.LOGIN_RE.test(login)) bad(`${login} is not a Twitch login name`);
    const jar = twitchJar.describe(cookies);
    if (!jar.hasAuthToken) bad("No auth-token cookie — the Twitch sign-in had not finished when these were saved");
    const at = Date.parse(text(body.capturedAt, "capturedAt", { max: 40 }) || "");
    const harvestedAt = Number.isFinite(at) && at <= Date.now() + 60000 ? new Date(at) : new Date();
    const source = text(body.source, "source", { max: 200 }) || "SOOP page import";
    const r = await twitchJar.saveJar({ login, cookies, harvestedAt, source });
    saved = {
      replaced: !r.created,
      cookieCount: r.cookieCount,
      shortLived: r.shortLived,
      persistentDaysLeft: twitchJar.daysLeft(r.persistentExpiresAt),
      authTokenDaysLeft: twitchJar.daysLeft(r.authTokenExpiresAt),
    };
  } else {
    if (!login) bad("login is required");
    if (!twitchJar.LOGIN_RE.test(login)) bad(`${login} is not a Twitch login name`);
    if (!(await TwitchWebCookie.exists({ twitchLogin: login }))) bad(`No Twitch cookies are stored for ${login} — import its cookie file`);
  }
  const link = await twitchJar.linkJar({ login, soopId }, (id, value) => farm.setTwitchLogin(id, value));
  return { login, saved, link };
});

// Manual kick for auto-renew — one id or many. The periodic refresher does
// this on its own every 3 h; this is the "I don't want to wait" button.
route("post", "/accounts/renew", async ({ body }) => {
  const ids = idList(body.ids, "ids");
  const single = text(body.id, "id");
  const list = ids.length ? ids : single ? [single] : [];
  if (!list.length) bad("no account given");
  const results = [];
  for (const id of list) {
    try {
      results.push({ id, ...(await farm.renewAccount(id, { reason: "manual" })) });
    } catch (e) {
      results.push({ id, ok: false, reason: "exception", detail: e.message });
    }
  }
  return { results };
});

module.exports = router;
