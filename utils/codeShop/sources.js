"use strict";
// Code shop — where stored codes come from (2026-10-23).
//
// Two farms store reward codes: SOOP (`SoopInventoryItem`, identity
// { loginId, key }) and CHZZK (`ChzzkReward`, identity { accountId, rewardNo }).
// The ledger keys every code by { loginId, itemKey }; a CHZZK code gets
//   loginId "chzzk:<ChzzkAccount _id>"  itemKey "r<rewardNo>"
// so it can never collide with a SOOP login (SOOP login ids hold no ":").
// Everything after ingest (bundles, listings, expiry, delivery, after-sale) is
// the same for both; only the three things below need to know the source:
//   - reading a code's ciphertext (units build, held release, replacement)
//   - which farm logins were sold (their buyers can see their codes)
//   - turning CHZZK reward rows into ingest rows
// Never a plaintext code here: callers decrypt what encOf() returns.

const { groupKeyOf } = require("./slots");

const CHZZK_PREFIX = "chzzk:";
const CODE_TYPES = ["CODE_FIRST_COME", "CODE_LOTTERY"];

// CHZZK category id -> the ledger's game number. A game SOOP also farms keeps
// SOOP's number, so the shop's per-game settings and guides apply to both.
// CHZZK-only games get numbers in 910000+ (config.games keys are digits).
const CHZZK_GAMES = Object.freeze({
  overwatch: { gameNo: "12", gameName: "Overwatch 2" },
  dokkaebi: { gameNo: "429", gameName: "Dokkaebi World" },
  call_of_duty_modern_warfare4: { gameNo: "910001", gameName: "Call of Duty: Modern Warfare 4" },
  world_of_warcraft_midnight: { gameNo: "910002", gameName: "World of Warcraft: Midnight" },
  stellasora: { gameNo: "910003", gameName: "Stella Sora" },
  once_human: { gameNo: "910004", gameName: "Once Human" },
  fifa_online4: { gameNo: "910005", gameName: "FC Online" },
  wutheringwaves: { gameNo: "910006", gameName: "Wuthering Waves" },
  lost_ark: { gameNo: "910007", gameName: "Lost Ark" },
  black_desert: { gameNo: "910008", gameName: "Black Desert" },
  arknights_endfield: { gameNo: "910009", gameName: "Arknights: Endfield" },
});

const text = (v) => (v === undefined || v === null ? "" : String(v));
const leanOf = (q) => (q && typeof q.lean === "function" ? q.lean() : q);
const OBJECT_ID = /^[a-f0-9]{24}$/i;

function modelOf(deps, name) {
  const given = deps && deps.models && deps.models[name];
  return given || require("../../models/" + name);
}

// A CHZZK model, or null when the caller passed its own model set without it
// (a test of the SOOP path, an older wiring): CHZZK is then simply absent.
// The service passes every model, CHZZK ones included (service.js).
function chzzkModel(deps, name) {
  if (deps && deps.models && typeof deps.models === "object") return deps.models[name] || null;
  return require("../../models/" + name);
}

const isChzzkLogin = (loginId) => text(loginId).startsWith(CHZZK_PREFIX);
const chzzkLoginId = (accountId) => CHZZK_PREFIX + text(accountId);
const chzzkItemKey = (rewardNo) => "r" + text(rewardNo);

// { accountId, rewardNo } of a CHZZK ledger identity, or null.
function parseChzzk(loginId, itemKey) {
  if (!isChzzkLogin(loginId)) return null;
  const accountId = text(loginId).slice(CHZZK_PREFIX.length);
  const m = /^r(\d+)$/.exec(text(itemKey));
  if (!OBJECT_ID.test(accountId) || !m) return null;
  return { accountId, rewardNo: Number(m[1]) };
}

// Unknown categories get a stable number from their id (9200000-9299999).
function chzzkGame(categoryId, categoryValue) {
  const id = text(categoryId);
  const hit = CHZZK_GAMES[id.toLowerCase()];
  if (hit) return { gameNo: hit.gameNo, gameName: hit.gameName };
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.codePointAt(0)) % 100000;
  const pretty = id.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return { gameNo: id ? String(9200000 + h) : "", gameName: pretty || text(categoryValue) };
}

const idKey = (loginId, itemKey) => JSON.stringify([text(loginId), text(itemKey)]);

// rows: [{ loginId, itemKey }] -> Map(idKey -> codeEnc) for the rows whose
// stored code exists, whichever farm holds it. One query per source.
async function encOf(deps, rows) {
  const out = new Map();
  const soop = [];
  const chzzk = [];
  for (const r of rows || []) {
    if (!r) continue;
    const c = parseChzzk(r.loginId, r.itemKey);
    if (c) chzzk.push(c);
    else if (!isChzzkLogin(r.loginId)) soop.push({ loginId: text(r.loginId), key: text(r.itemKey) });
  }
  if (soop.length) {
    const inv = await leanOf(modelOf(deps, "SoopInventoryItem").find({ $or: soop }, { loginId: 1, key: 1, codeEnc: 1 }));
    for (const x of inv || []) out.set(idKey(x.loginId, x.key), x.codeEnc);
  }
  const Reward = chzzk.length ? chzzkModel(deps, "ChzzkReward") : null;
  if (Reward) {
    const found = await leanOf(
      Reward.find(
        { $or: chzzk.map((c) => ({ accountId: c.accountId, rewardNo: c.rewardNo })), hasCode: true },
        { accountId: 1, rewardNo: 1, codeEnc: 1 },
      ),
    );
    for (const x of found || []) out.set(idKey(chzzkLoginId(x.accountId), chzzkItemKey(x.rewardNo)), x.codeEnc);
  }
  return out;
}

// The ciphertext of one ledger row's code, or null.
async function encFor(deps, row) {
  const m = await encOf(deps, [row]);
  const v = m.get(idKey(row && row.loginId, row && row.itemKey));
  return v === undefined ? null : v;
}

// Every ledger loginId whose farm login was sold, from both farms.
async function soldLoginIds(deps) {
  const out = [];
  const soop = await leanOf(modelOf(deps, "SoopAccount").find({ sold: true }, { _id: 0, loginId: 1 }));
  for (const a of soop || []) if (text(a.loginId)) out.push(text(a.loginId));
  // A read error is not caught: a caller about to sell must never take a
  // sold login for an unsold one.
  const Account = chzzkModel(deps, "ChzzkAccount");
  if (Account) {
    const chz = await leanOf(Account.find({ sold: true }, { _id: 1 }));
    for (const a of chz || []) out.push(chzzkLoginId(a._id));
  }
  return out;
}

async function isSoldLogin(deps, loginId) {
  const c = isChzzkLogin(loginId) ? text(loginId).slice(CHZZK_PREFIX.length) : null;
  if (c !== null) {
    const Account = chzzkModel(deps, "ChzzkAccount");
    if (!Account || !OBJECT_ID.test(c)) return false;
    return !!(await Account.exists({ _id: c, sold: true }));
  }
  return !!(await modelOf(deps, "SoopAccount").exists({ loginId: text(loginId), sold: true }));
}

// CHZZK stored codes as ingest rows (the shape ingest.describe() returns,
// with the campaign fields already resolved). codeEnc is carried for ingest
// to fingerprint; nothing here decrypts.
async function chzzkRows(deps) {
  const Reward = chzzkModel(deps, "ChzzkReward");
  const Campaign = chzzkModel(deps, "ChzzkCampaign");
  if (!Reward) return [];
  const rewards = await leanOf(
    Reward
      .find({ hasCode: true, rewardType: { $in: CODE_TYPES } })
      .select("accountId rewardNo campaignNo title rewardType categoryId campaignTitle earnedAt codeEndAt codeEnc"),
  );
  if (!rewards || !rewards.length) return [];
  const nos = [...new Set(rewards.map((r) => Number(r.campaignNo)).filter(Number.isFinite))];
  const camps = Campaign
    ? await leanOf(Campaign.find({ campaignNo: { $in: nos } }).select("campaignNo title categoryId categoryValue endAt rewards"))
    : [];
  const campOf = new Map((camps || []).map((c) => [Number(c.campaignNo), c]));
  const rows = [];
  for (const r of rewards) {
    if (!text(r.accountId) || !Number.isFinite(Number(r.rewardNo))) continue;
    const camp = campOf.get(Number(r.campaignNo)) || {};
    const game = chzzkGame(camp.categoryId || r.categoryId, camp.categoryValue);
    const reward = (camp.rewards || []).find((x) => Number(x.rewardNo) === Number(r.rewardNo)) || {};
    const campaignIdx = "chzzk-" + Number(r.campaignNo);
    rows.push({
      loginId: chzzkLoginId(r.accountId),
      itemKey: chzzkItemKey(r.rewardNo),
      itemId: r._id || null,
      gameNo: game.gameNo,
      gameName: game.gameName,
      // CHZZK's own reward title; an English one becomes the default label,
      // any other leaves the label for the owner (texts.defaultLabel).
      nameRaw: text(r.title) || text(reward.title) || "Reward " + r.rewardNo,
      name: text(r.title) || text(reward.title),
      image: text(reward.imageUrl),
      earnedAt: r.earnedAt instanceof Date ? r.earnedAt : r.earnedAt ? new Date(r.earnedAt) : null,
      useBy: r.codeEndAt instanceof Date ? r.codeEndAt : r.codeEndAt ? new Date(r.codeEndAt) : null,
      dropsName: "",
      codeEnc: r.codeEnc,
      campaignIdx,
      campaignTitle: text(camp.title) || text(r.campaignTitle),
      campaignEndAt: camp.endAt ? new Date(camp.endAt) : null,
      groupKey: groupKeyOf({ gameNo: game.gameNo, campaignIdx }),
      source: "chzzk",
    });
  }
  return rows;
}

// Reward rows revealed in the CHZZK panel: Map(ChzzkReward _id -> ms).
async function chzzkReveals(deps) {
  const Reward = chzzkModel(deps, "ChzzkReward");
  if (!Reward) return new Map();
  const rows = await leanOf(
    Reward.find({ hasCode: true, revealedAt: { $ne: null } }).select("_id revealedAt"),
  );
  const out = new Map();
  for (const r of rows || []) {
    const ms = r.revealedAt ? new Date(r.revealedAt).getTime() : NaN;
    if (Number.isFinite(ms)) out.set(text(r._id), ms);
  }
  return out;
}

// loginId -> display name for the Sales panel ("CHZZK · nickname").
async function chzzkNicknames(deps, loginIds) {
  const ids = [...new Set((loginIds || []).filter(isChzzkLogin).map((l) => text(l).slice(CHZZK_PREFIX.length)))].filter((x) => OBJECT_ID.test(x));
  const out = new Map();
  const Account = chzzkModel(deps, "ChzzkAccount");
  if (!ids.length || !Account) return out;
  const accs = await leanOf(Account.find({ _id: { $in: ids } }, { nickname: 1 }));
  for (const a of accs || []) out.set(chzzkLoginId(a._id), "CHZZK · " + (text(a.nickname) || "login"));
  return out;
}

module.exports = {
  CHZZK_PREFIX,
  CHZZK_GAMES,
  isChzzkLogin,
  chzzkLoginId,
  chzzkItemKey,
  parseChzzk,
  chzzkGame,
  idKey,
  encOf,
  encFor,
  soldLoginIds,
  isSoldLogin,
  chzzkRows,
  chzzkReveals,
  chzzkNicknames,
};
