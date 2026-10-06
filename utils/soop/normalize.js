// SOOP farm — normalised shapes (contract §6).
//
// SOOP answers with string-typed numbers, Korea-local timestamps and Korean
// text. Everything the rest of the farm reads goes through here once, so the
// worker, the stores and the UI share one Campaign / Mission / InventoryItem
// shape. Pure functions: no network, no database, no logging.

const crypto = require("crypto");
const { translate, gameName, rewardKind } = require("./i18n");

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const KST_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const FILTERS = ["progress", "scheduled", "completed", "unlisted"];
const DIVISIONS = ["available", "acquired", "expired"];
// Reward codes are secrets: they are lifted out of the row and never kept in `raw`.
const CODE_FIELDS = ["itemCode", "code", "pinNo", "couponNo"];
// itemCodeIdx is the id SOOP's inventory really uses (seen on production
// 2026-10-06); the others are kept for rows that may be shaped differently.
const KEY_FIELDS = ["itemCodeIdx", "idx", "itemIdx", "dropsItemIdx", "giveIdx", "seq", "no"];

const present = (v) => v !== undefined && v !== null && v !== "";
const str = (v) => (present(v) ? String(v) : "");
const strOrNull = (v) => (present(v) ? String(v) : null);
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

// SOOP dates carry no zone and are Korea time. `new Date("2026-10-11 05:00:00")`
// would read them in the server's zone, which is how v1 ended campaigns nine
// hours off.
function parseKst(s) {
  if (s instanceof Date) return Number.isNaN(s.getTime()) ? null : new Date(s.getTime());
  if (typeof s !== "string") return null;
  const m = KST_RE.exec(s.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, sec] = m.slice(1).map((p) => Number(p || 0));
  if (y === 0 || mo === 0 || d === 0) return null; // "0000-00-00 00:00:00" = not set
  const wall = new Date(Date.UTC(y, mo - 1, d, h, mi, sec));
  // Date.UTC rolls 02-31 over to March; a date that does not round-trip is junk.
  if (
    wall.getUTCFullYear() !== y ||
    wall.getUTCMonth() !== mo - 1 ||
    wall.getUTCDate() !== d ||
    wall.getUTCHours() !== h ||
    wall.getUTCMinutes() !== mi ||
    wall.getUTCSeconds() !== sec
  ) {
    return null;
  }
  return new Date(wall.getTime() - KST_OFFSET_MS);
}

// The watch-time thresholds of a campaign, from a raw row (itemList[].giveTerm)
// or an already normalised one (items[].minutes).
function stepsOf(rawOrCampaign) {
  const c = rawOrCampaign || {};
  const mins = Array.isArray(c.items)
    ? c.items.map((i) => num(i && i.minutes))
    : (Array.isArray(c.itemList) ? c.itemList : []).map((i) => num(i && i.giveTerm));
  return [...new Set(mins.filter((n) => n > 0))].sort((a, b) => a - b);
}

// Kind of the majority of items; a tie goes to the kind seen first.
function majorityKind(items) {
  const counts = new Map();
  for (const i of items) counts.set(i.kind, (counts.get(i.kind) || 0) + 1);
  let best = "other";
  let bestN = 0;
  for (const [kind, n] of counts) {
    if (n > bestN) {
      best = kind;
      bestN = n;
    }
  }
  return best;
}

function normalizeCampaign(raw, { overrides, gameOverrides, filter } = {}) {
  const r = raw || {};
  const gameNo = strOrNull(r.gameNo);
  const cateNo = strOrNull(r.cateNo);
  const provider = strOrNull(r.typeNm);
  const giveCon = str(r.giveCon);
  const wanted = filter || r.filter;

  const channels = (Array.isArray(r.broadIdList) ? r.broadIdList : [])
    .filter((b) => b && present(b.userId))
    .map((b) => ({ id: String(b.userId), nick: str(b.userNick), onAir: b.onAir === true }));

  const items = (Array.isArray(r.itemList) ? r.itemList : [])
    .filter((i) => i && typeof i === "object")
    .map((i) => ({
      name: translate(str(i.itemName), { overrides }),
      nameRaw: str(i.itemName),
      kind: rewardKind(i.itemType),
      minutes: num(i.giveTerm),
      image: strOrNull(i.itemImage),
    }))
    .sort((a, b) => a.minutes - b.minutes); // stable: SOOP's order survives within a step

  return {
    dropsIdx: str(r.dropsIdx),
    title: translate(str(r.title), { overrides }),
    titleRaw: str(r.title),
    image: strOrNull(r.image),
    gameNo,
    gameName: gameName(gameNo, { cateName: r.cateName, typeNm: r.typeNm, overrides: gameOverrides }),
    giveCon,
    guaranteed: giveCon === "term",
    live: r.live === true,
    filter: FILTERS.includes(wanted) ? wanted : "unlisted",
    startAt: parseKst(r.startDate),
    endAt: parseKst(r.endDate),
    categoryWide: channels.length === 0 && cateNo !== null,
    cateNo,
    cateName: translate(str(r.cateName), { overrides }),
    channels,
    items,
    steps: stepsOf({ items }),
    rewardKind: majorityKind(items),
    needsLink: r.ingameGiveYn === "Y",
    provider,
  };
}

// A mission row is the account's own progress on one campaign: every item
// repeats the minutes watched so far (viewTime), so the max is the progress.
function normalizeMission(raw) {
  const r = raw || {};
  const items = (Array.isArray(r.itemList) ? r.itemList : [])
    .filter((i) => i && typeof i === "object")
    .map((i) => ({
      name: translate(str(i.itemName)),
      minutes: num(i.giveTerm),
      viewTime: num(i.viewTime),
    }));
  return {
    dropsIdx: str(r.dropsIdx),
    minutes: items.reduce((max, i) => Math.max(max, i.viewTime), 0),
    items,
  };
}

function inventoryKey(r, expiry) {
  for (const f of KEY_FIELDS) if (present(r[f])) return String(r[f]);
  // No id on the row: hash what does not change while the item sits in the
  // inventory. Division is left out on purpose — claiming moves a row from
  // "available" to "acquired" and it must stay the same item.
  const basis = [str(r.itemName), str(r.sendDate), str(expiry), str(r.gameNo)].join("|");
  return crypto.createHash("sha1").update(basis).digest("hex").slice(0, 16);
}

function normalizeInventoryItem(raw, division) {
  const r = raw || {};
  const expiry = present(r.expDate) ? r.expDate : r.useExpDate;
  const gameNo = strOrNull(r.gameNo);

  let code = null;
  for (const f of CODE_FIELDS) {
    if (present(r[f])) {
      code = String(r[f]);
      break;
    }
  }
  const safe = { ...r };
  for (const f of CODE_FIELDS) delete safe[f];

  let div = "available";
  if (DIVISIONS.includes(division)) div = division;
  else if (DIVISIONS.includes(r.division)) div = r.division;

  return {
    key: inventoryKey(r, expiry),
    division: div,
    name: translate(str(r.itemName)),
    nameRaw: str(r.itemName),
    kind: rewardKind(r.itemType),
    gameNo,
    gameName: gameName(gameNo, { cateName: r.cateName, typeNm: r.typeNm || r.type }),
    image: strOrNull(r.itemImage) || strOrNull(r.image),
    expiresAt: parseKst(expiry),
    sentAt: parseKst(r.sendDate),
    receivedAt: parseKst(r.receiveDate),
    needsLink: r.ingameGiveYn === "Y" && r.acctConn === false,
    linkPath: strOrNull(r.acctLinkPath) || strOrNull(r.loginPath),
    used: r.useFlag === "Y",
    code,
    raw: safe,
  };
}

module.exports = {
  parseKst,
  stepsOf,
  normalizeCampaign,
  normalizeMission,
  normalizeInventoryItem,
};
