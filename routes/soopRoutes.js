// HTTP API for the SOOP drops farm (docs/SOOP-FARM-CONTRACT.md §11).
//
// Thin handlers: check the shape of the input, call the farm service
// (utils/soopFarm.js) and return what it answered. Every route is
// superadmin-only. Request bodies carry session cookies, so nothing here logs
// one, and a reward code leaves through exactly one route — /inventory/reveal —
// which records who asked for it.
const express = require("express");

const { requireSuperadmin } = require("../middleware/auth");
const farm = require("../utils/soopFarm");
const { SoopError } = require("../utils/soop/errors");

const router = express.Router();

const MAX_LIST = 500;
const MAX_COOKIE_BYTES = 2 * 1024 * 1024;
const LEVELS = ["info", "warn", "error"];
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

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
  const code = await farm.inventory.revealCode(itemId);
  if (!code) throw new HttpError(404, "No code is stored for that item");
  const admin = (req.session && req.session.admin) || {};
  const who = String(admin.username || admin.id || "unknown admin").slice(0, 80);
  // The entry names who and which item — never the code itself.
  farm.activity.add({
    kind: "reveal",
    msg: `${who} revealed the code of inventory item ${itemId}`,
    data: { itemId, admin: who },
  });
  res.set("Cache-Control", "no-store");
  return { code };
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

module.exports = router;
