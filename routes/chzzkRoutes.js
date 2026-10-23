// HTTP API for the CHZZK drops farm (docs/CHZZK-FARM.md §11).
//
// Thin handlers: validate shape, call utils/chzzkFarm, return what it answered.
// Every route is superadmin-only. Request bodies carry naver.com cookies, so
// nothing here logs one, and a reward code leaves through exactly one route —
// /rewards/reveal — which records who asked and sends no-store.
const express = require("express");

const { requireSuperadmin } = require("../middleware/auth");
const farm = require("../utils/chzzkFarm");
const { ChzzkError } = require("../utils/chzzk/errors");

const router = express.Router();

// Test swap seam: tests do router._setFarmForTests(stub). Handlers call
// router.farm.xxx(...) so the stub is picked up. The real farm module stays
// required at module load — this is the only hook.
router.farm = farm;
router._setFarmForTests = (f) => {
  router.farm = f || farm;
};

const MAX_LIST = 500;
const MAX_COOKIE_BYTES = 90 * 1024; // §11 — "cookies ≤ 90 kB"
const MAX_NOTE_LEN = 500;
const MAX_CAMPAIGN_NO = 1_000_000_000; // §11 — int 1..10^9
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

// ChzzkError → operator-facing sentence. The farm module logs the real cause;
// the response never leaks a cookie, a code or a proxy URL.
const UPSTREAM = new Map([
  ["AUTH", { status: 401, message: "That CHZZK login is logged out — re-import its cookie" }],
  ["EGRESS", { status: 503, message: "CHZZK egress not ready — the proxy or network is unreachable" }],
  ["TIMEOUT", { status: 503, message: "CHZZK egress not ready — CHZZK did not answer in time" }],
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

// A trimmed string, or undefined when the field was not sent. Numbers accepted
// because campaignNo, limit etc. may come unquoted in a JSON body.
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

// A positive integer between min and max. Rejects floats, strings that are not
// numeric, and anything outside the window. Used for campaignNo and limit.
function intIn(value, name, { min = 1, max = Number.MAX_SAFE_INTEGER, required = true } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) bad(`${name} is required`);
    return undefined;
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n)) bad(`${name} must be a whole number`);
  if (n < min || n > max) bad(`${name} must be between ${min} and ${max}`);
  return n;
}

// ---- plumbing ---------------------------------------------------------------

function whoFromReq(req) {
  const admin = (req.session && req.session.admin) || {};
  return String(admin.username || admin.id || "unknown admin").slice(0, 80);
}

function route(method, path, handler) {
  const name = path.slice(1).replace(/\//g, " ");
  router[method]("/api/chzzk" + path, requireSuperadmin, async (req, res) => {
    try {
      const b = req.body;
      const body = b && typeof b === "object" && !Array.isArray(b) ? b : {};
      const out = await handler({ body, query: req.query || {}, req, res });
      if (!res.headersSent) res.json({ success: true, ...(out || {}) });
    } catch (err) {
      if (err instanceof HttpError) return fail(res, err.status, err.message);
      if (err instanceof ChzzkError) {
        const up = UPSTREAM.get(err.code);
        // Code name (AUTH/EGRESS/…) and short message only — never body data.
        console.error(`chzzk ${name} upstream:`, err.code, err.message);
        if (up) return fail(res, up.status, up.message);
        return fail(res, 502, err.message || "CHZZK refused the request");
      }
      console.error(`chzzk ${name} error:`, err && err.message);
      if (res.headersSent) return undefined;
      return fail(res, 500, "Server error");
    }
  });
}

// ---- state ------------------------------------------------------------------

route("get", "/state", async () => router.farm.stateView());

// ---- accounts ---------------------------------------------------------------

// Cookie paste — never logged. One or many Cookie-Editor exports in one blob.
route("post", "/accounts/import", async ({ body }) => {
  if (typeof body.cookies !== "string") bad("Paste a cookie export first");
  const cookies = body.cookies.trim();
  if (!cookies) bad("Paste a cookie export first");
  if (Buffer.byteLength(cookies) > MAX_COOKIE_BYTES) {
    bad("That paste is larger than 90 kB — import it in smaller batches");
  }
  return { results: await router.farm.importAccounts(cookies) };
});

// Empty list = every account that is not sold. Runs in the background.
route("post", "/accounts/check", async ({ body }) => {
  const { total } = await router.farm.checkAccounts(idList(body.ids, "ids"), { background: true });
  return { total };
});

route("post", "/accounts/update", async ({ body }) => {
  const id = text(body.id, "id", { required: true });
  const sold = flag(body.sold, "sold");
  const paused = flag(body.paused, "paused");
  const note = text(body.note, "note", { max: MAX_NOTE_LEN });
  if (sold === undefined && paused === undefined && note === undefined) {
    bad("Nothing to change — send sold, paused or note");
  }
  const ok = await router.farm.updateAccount(id, { sold, paused, note });
  if (!ok) throw new HttpError(404, "Unknown account");
  return {};
});

// "Farm again": clear one campaign's progress on one login (a wrong done mark).
route("post", "/accounts/reset-progress", async ({ body }) => {
  const id = text(body.id, "id", { required: true });
  const no = intIn(body.campaignNo, "campaignNo", { min: 1, max: MAX_CAMPAIGN_NO });
  const ok = await router.farm.resetProgress(id, no);
  if (!ok) throw new HttpError(404, "Unknown account");
  return {};
});

// Reward rows with hasCode:true are kept (farm.deleteAccounts returns keptCodes).
route("post", "/accounts/delete", async ({ body }) => {
  const { deleted, keptCodes, keptSold = 0 } = await router.farm.deleteAccounts(
    idList(body.ids, "ids", { required: true }),
  );
  return { deleted, keptCodes, keptSold };
});

// ---- campaigns --------------------------------------------------------------

route("get", "/campaigns", async () => router.farm.campaignsView());

route("post", "/campaigns/refresh", async () => {
  const { found, updated } = await router.farm.refreshCampaigns();
  return { found, updated };
});

route("post", "/campaigns/add", async ({ body }) => {
  const no = intIn(body.campaignNo, "campaignNo", { min: 1, max: MAX_CAMPAIGN_NO });
  const result = await router.farm.addCampaign(no);
  if (result && result.ok === false) {
    throw new HttpError(400, result.error || "That campaign could not be added");
  }
  return { campaign: (result && result.campaign) || null };
});

route("post", "/campaigns/enable", async ({ body }) => {
  const no = intIn(body.campaignNo, "campaignNo", { min: 1, max: MAX_CAMPAIGN_NO });
  const enabled = flag(body.enabled, "enabled");
  if (enabled === undefined) bad("enabled is required (true or false)");
  const ok = await router.farm.setCampaignEnabled(no, enabled);
  if (!ok) throw new HttpError(404, "Unknown campaign");
  return {};
});

// ---- rewards ----------------------------------------------------------------

route("get", "/rewards", async ({ query }) => {
  const accountId = text(query.accountId, "accountId") || undefined;
  const campaignNo = intIn(query.campaignNo, "campaignNo", {
    min: 1,
    max: MAX_CAMPAIGN_NO,
    required: false,
  });
  return router.farm.rewardsView({ accountId, campaignNo });
});

// Codes on hand per reward kind — counts and dates only, never a code.
route("get", "/stock", async () => router.farm.stockView());

// The one route that returns a code. 404 when the reward is unknown or has no
// code. Response is no-store so the browser never caches the plaintext.
route("post", "/rewards/reveal", async ({ body, req, res }) => {
  const id = text(body.id, "id", { required: true });
  if (!OBJECT_ID_RE.test(id)) bad("id is not a reward id");
  const who = whoFromReq(req);
  const found = await router.farm.revealCode(id, who);
  if (!found || !found.code) throw new HttpError(404, "No code is stored for that reward");
  res.set("Cache-Control", "no-store");
  return { code: found.code };
});

// Empty list = sweep every account the farm chooses. Returns how many were queued.
route("post", "/rewards/collect", async ({ body }) => {
  const { queued } = await router.farm.collectNow(idList(body.ids, "ids"));
  return { queued };
});

// ---- activity ---------------------------------------------------------------

route("get", "/activity", async ({ query }) => {
  const limit = intIn(query.limit, "limit", { min: 1, max: MAX_LIST, required: false }) || 100;
  const accountId = text(query.accountId, "accountId") || undefined;
  return router.farm.activityView({ limit, accountId });
});

// ---- switch -----------------------------------------------------------------

route("post", "/switch", async ({ body, req }) => {
  const on = flag(body.on, "on");
  if (on === undefined) bad("on is required (true or false)");
  const actor = whoFromReq(req);
  const result = await router.farm.setSwitch(on, actor);
  return { on: result && typeof result.on === "boolean" ? result.on : on };
});

module.exports = router;
