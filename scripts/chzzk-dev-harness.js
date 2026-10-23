#!/usr/bin/env node
/* global setInterval */
// CHZZK farm dev harness (docs/CHZZK-PANEL-V2.md §5):
//
//   node scripts/chzzk-dev-harness.js [port=4600]   ->   http://127.0.0.1:4600/chzzk.html
//   node scripts/chzzk-dev-harness.js 4600 --cookie-files=<dir>   also writes cookie
//                         exports the farm does not have yet into <dir>, to try the
//                         import dialog with: drop that folder's files on the page
//
// The real routes and a real Farm, running against an in-memory MongoDB and the
// fake CHZZK from tests/helpers/chzzkFake.js. Nothing here can reach the real
// database, naver.com or Telegram: .env is never loaded, MONGO_URI and the proxy
// URLs are dropped, the farm only ever gets fake clients and a fake transport,
// and outbound requests to Naver / ipinfo / Telegram throw. The farm beats every
// second and the fake credits one minute per beat, so progress moves while you
// watch. Telegram alerts are printed instead of sent. Every name, cookie, code and
// title below is made up.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const https = require("https");

for (const k of ["MONGO_URI", "CHZZK_PROXY_URL", "SOOP_PROXY_URL", "CHZZK_FARM", "CHZZK_COUNTRIES"]) delete process.env[k];
// Cookies and codes are encrypted at rest; the key lives only as long as this
// throwaway database, so it is never the real one.
process.env.CRED_SECRET = "chzzk-dev-harness-" + crypto.randomBytes(8).toString("hex");

// utils/telegram.js runs require("dotenv").config() when it loads, which would
// pull the main checkout's .env (real database, proxy, Telegram token) into this
// process. Neutered before anything can require it.
const dotenv = require("dotenv");
dotenv.config = dotenv.configDotenv = () => ({ parsed: {} });

// Tripwire: a bug that reaches for a real site fails loudly instead of connecting.
const BLOCKED = /naver\.(com|net)|pstatic\.net|ipinfo\.io|telegram\.org/i;
const blocked = (target) => new Error("chzzk-dev-harness: blocked a real request (" + String(target).trim() + ")");
for (const mod of [http, https]) {
  for (const fn of ["request", "get"]) {
    const real = mod[fn];
    mod[fn] = function guarded(...args) {
      const target = args
        .slice(0, 2)
        .map((a) => (typeof a === "string" ? a : a && (a.href || a.hostname || a.host)) || "")
        .join(" ");
      if (BLOCKED.test(target)) throw blocked(target);
      return real.apply(this, args);
    };
  }
}
if (typeof globalThis.fetch === "function") {
  const realFetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(input, init) {
    const target = typeof input === "string" ? input : (input && (input.href || input.url)) || "";
    if (BLOCKED.test(target)) throw blocked(target);
    return realFetch.call(this, input, init);
  };
}

const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { createFakeChzzk } = require("../tests/helpers/chzzkFake");
const { Farm } = require("../utils/chzzkFarm");
const { runSession } = require("../utils/chzzk/worker");
const { createCollector } = require("../utils/chzzk/codes");
const { encrypt } = require("../utils/secretBox");
const ChzzkAccount = require("../models/ChzzkAccount");
const ChzzkCampaign = require("../models/ChzzkCampaign");
const ChzzkReward = require("../models/ChzzkReward");
const ChzzkActivity = require("../models/ChzzkActivity");
const chzzkRoutes = require("../routes/chzzkRoutes");

const leaked = ["MONGO_URI", "CHZZK_PROXY_URL", "SOOP_PROXY_URL"].filter((k) => process.env[k]);
if (leaked.length) {
  console.error(`[harness] refusing to run: ${leaked.join(", ")} reappeared, so something loaded .env`);
  process.exit(1);
}

const PORT = Number(process.argv[2]) || 4600;
const COOKIE_DIR = (process.argv.find((a) => a.startsWith("--cookie-files=")) || "").slice(15);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ENDFIELD_STARTS_IN = 10 * MIN; // a "Not started yet" campaign that opens while you watch
const log = (...a) => console.log("[harness]", ...a);
// UTC ms -> the "YYYY-MM-DD HH:mm:ss" Korea wall clock CHZZK sends.
const kst = (ms) => new Date(ms + 9 * HOUR).toISOString().slice(0, 19).replace("T", " ");
const hex = (s, n) => crypto.createHash("sha256").update(s).digest("hex").slice(0, n);
const hashOf = (key) => hex("user|" + key, 32); // what the fake's userStatus answers for a login

// The farm's waits, shortened so progress shows within seconds (contract §5).
const FARM_TIMINGS = {
  egressStartMs: 500, egressIntervalMs: 60_000,
  discoveryStartMs: 30_000, discoveryIntervalMs: 30_000,
  loginStartMs: 60_000, loginIntervalMs: 5 * MIN,
  codesStartMs: 20_000, codesIntervalMs: 2 * MIN,
  alertStartMs: 5_000, alertIntervalMs: 10_000,
  alertWaitMs: 15_000, alertQuietMs: 10_000, alertMaxWaitMs: 60_000, alertRetryMs: 30 * MIN,
  supervisorIntervalMs: 3_000,
  pickStreamMemoMs: 30_000,
};
// The farm never passes timings to runSession, so the harness wraps it.
const WORKER_TIMINGS = {
  heartbeatMs: 1000, statusMs: 1000, challengesMs: 4000, tickMs: 250,
  idlePollMs: 3000, egressWaitMs: 3000, precheckMs: 20_000,
  streamBackoffMs: 60_000, campaignBackoffMs: 60_000,
};

// One failed seeding step is reported and the rest of the harness still comes up.
const step = (name, fn) => Promise.resolve().then(fn).catch((err) => log(`${name} FAILED: ${err && err.message}`) || null);

// ---- the fake CHZZK ---------------------------------------------------------

// Thumbnails for the seeded campaigns, served by the harness itself so the page
// never shows broken images (real ones come from CHZZK's CDN).
const ART = {
  ow: ["#f99e1a", "#2b2f36", "OW2"], lostark: ["#3b6fd8", "#141a2e", "LOA"],
  bdo: ["#a3172a", "#1a0c10", "BDO"], wuwa: ["#2bb5a8", "#0d2230", "WW"],
  fco: ["#1f9d55", "#0b2214", "FCO"], endfield: ["#e8c547", "#1d1d1d", "AE"],
  code: ["#7c5cff", "#2a3040", "CODE"], lottery: ["#f6c453", "#3a2d0c", "DRAW"], gift: ["#38bdf8", "#0c2433", "GIFT"],
};
const img = (name) => `/harness/img/${name}.svg`;
const svg = ([a, b, label]) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
  `<stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>` +
  `<rect width="320" height="180" fill="url(#g)"/><text x="160" y="108" font-family="Helvetica,Arial,sans-serif" ` +
  `font-size="54" font-weight="700" fill="#fff" text-anchor="middle">${label}</text></svg>`;

const C = { ow: 9101, lostark: 9102, bdo: 9103, wuwa: 9104, fco: 9105, endfield: 9106 };
const GUIDE = "치지직에서 참여 방송을 시청하면 보상을 받을 수 있어요.\n1. 치지직에 로그인\n2. 드롭스 참여 방송 시청\n3. 보상함에서 쿠폰 확인\n(개발용 가짜 안내문입니다)";

function buildWorld(t0) {
  const code = (rewardNo, title, minutes, remaining) =>
    ({ rewardNo, title, rewardType: "CODE_FIRST_COME", conditionForMinutes: minutes, codeRemainingCount: remaining, imageUrl: img("code") });
  const lottery = (rewardNo, title, minutes) =>
    ({ rewardNo, title, rewardType: "CODE_LOTTERY", conditionForMinutes: minutes, codeRemainingCount: null, imageUrl: img("lottery") });
  const inGame = (rewardNo, title, minutes) =>
    ({ rewardNo, title, rewardType: "IN_APP", conditionForMinutes: minutes, codeRemainingCount: null, imageUrl: img("gift") });
  const camp = (no, art, o) => ({
    campaignNo: no, categoryType: "GAME", state: "PROMOTED", imageUrl: img(art), description: GUIDE,
    startDate: kst(t0 - 2 * DAY), endDate: kst(t0 + 6 * DAY), ...o,
  });
  const camps = {
    ow: camp(C.ow, "ow", { title: "오버워치 2 가을 시청 이벤트 드롭스", categoryId: "OVERWATCH", categoryValue: "오버워치 2",
      rewardList: [code(910101, "스프레이 쿠폰", 30, 4812), code(910102, "플레이어 아이콘 쿠폰", 60, 2950),
        code(910103, "무기 장식 쿠폰", 120, 1204), lottery(910104, "전설 스킨 추첨권", 240),
        code(910105, "하이라이트 인트로 쿠폰", 480, 388), inGame(910106, "시청 보상 상자", 15)] }),
    lostark: camp(C.lostark, "lostark", { title: "로스트아크 가을 축제 시청 보상", categoryId: "Lost_Ark", categoryValue: "로스트아크",
      startDate: kst(t0 - 5 * DAY), endDate: kst(t0 + 2 * HOUR),
      rewardList: [code(910201, "골드 패키지 쿠폰", 20, 1530), lottery(910202, "희귀 펫 추첨권", 60), code(910203, "축제 아바타 쿠폰", 150, 620)] }),
    bdo: camp(C.bdo, "bdo", { title: "검은사막 신규 클래스 출시 기념 드롭스", categoryId: "Black_Desert", categoryValue: "검은사막",
      accountLinkUrl: "https://example.invalid/link-game-account",
      rewardList: [inGame(910301, "성장 지원 상자", 30), code(910302, "한정 의상 쿠폰", 60, 900)] }),
    wuwa: camp(C.wuwa, "wuwa", { title: "명조 3.0 업데이트 기념 시청 이벤트", categoryId: "WutheringWaves", categoryValue: "명조: 워더링 웨이브",
      rewardList: [inGame(910401, "성음 x100", 30), inGame(910402, "고급 에너지 코어 x3", 60), inGame(910403, "별의 소리 x300", 120)] }),
    fco: camp(C.fco, "fco", { title: "FC 온라인 리그 결승 드롭스", categoryId: "FIFA_ONLINE4", categoryValue: "FC 온라인",
      startDate: kst(t0 - 10 * DAY), endDate: kst(t0 + 3 * DAY),
      rewardList: [code(910501, "개막전 응원 쿠폰", 10, 0), code(910502, "결승전 선수팩 쿠폰", 30, 0), code(910503, "결승전 프리미엄 쿠폰", 60, 0)] }),
    endfield: camp(C.endfield, "endfield", { title: "엔드필드 출시 전야 특별 방송", categoryId: "Arknights_Endfield", categoryValue: "명일방주: 엔드필드",
      startDate: kst(t0 + ENDFIELD_STARTS_IN), endDate: kst(t0 + 9 * DAY),
      rewardList: [lottery(910601, "출시 기념 추첨권", 30), code(910602, "합성옥 x500 쿠폰", 60, 3000)] }),
  };
  let liveSeq = 70000;
  const live = (name, no, categoryId, viewers) => ({
    channelId: hex("channel|" + name, 32), channelName: name, liveId: ++liveSeq, viewers, status: "OPEN",
    openDate: kst(t0 - 90 * MIN), categoryType: "GAME", categoryId, dropsCampaignNo: no, liveTokens: [`harness-live-token-${liveSeq}`],
  });
  const lives = {
    owHaru: live("하루의 오버워치", C.ow, "OVERWATCH", 3812), owMint: live("Mint_Tank", C.ow, "OVERWATCH", 2140),
    owPotato: live("새벽감자 TV", C.ow, "OVERWATCH", 960), owQuiet: live("조용한 관전방", C.ow, "OVERWATCH", 120),
    laBear: live("로아하는 곰돌이", C.lostark, "Lost_Ark", 5230), laDaily: live("Ark_Daily", C.lostark, "Lost_Ark", 1870),
    bdo: live("검사 초보방", C.bdo, "Black_Desert", 640), wuwa: live("명조 같이해요", C.wuwa, "WutheringWaves", 1120),
    fco: live("FC 리그 중계석", C.fco, "FIFA_ONLINE4", 2400),
  };
  // Endfield's streams go on air shortly before its campaign starts.
  const endfieldLives = [live("엔드필드 첫날", C.endfield, "Arknights_Endfield", 4100), live("Endfield_Fan", C.endfield, "Arknights_Endfield", 900)];
  return { camps, lives, endfieldLives };
}

// The farm's makeClient: anonymous without cookies, else the fake login keyed by
// NID_AUT (as tests/chzzkFarm.test.js does). The fake answers "nick-<key>" /
// "hash-<key>" and codes that contain the key; the panel gets readable
// nicknames, real-looking hashes and code-looking codes instead.
const codeOf = (key, rewardNo) => "HARNESS-" + hex(`code|${key}|${rewardNo}`, 8).toUpperCase().replace(/(.{4})/, "$1-");
function clientFactory(fake, nickByKey) {
  return ({ cookies }) => {
    const aut = Array.isArray(cookies) ? cookies.find((c) => c && c.name === "NID_AUT") : null;
    if (!aut || !aut.value) return fake.anonymous();
    const key = String(aut.value);
    const client = fake.clientFor(key);
    return {
      ...client,
      async userStatus() {
        const who = await client.userStatus();
        return { ...who, userIdHash: hashOf(key), nickname: nickByKey.get(key) || "Login " + key.replace(/^.*_/, "") };
      },
      async couponCode(rewardNo) {
        return { ...(await client.couponCode(rewardNo)), code: codeOf(key, rewardNo) };
      },
    };
  };
}

// ---- logins -----------------------------------------------------------------

const LOGINS = [
  { key: "FAKE_NID_AUT_skystar_01", nick: "하늘별", jar: "persistent", expDays: 300, ageDays: 21 },
  { key: "FAKE_NID_AUT_mintlatte_02", nick: "Mint Latte", jar: "session", ageDays: 3, note: "spare phone — session cookie" },
  { key: "FAKE_NID_AUT_moonrabbit_03", nick: "달빛토끼", jar: "session", ageDays: 1 },
  { key: "FAKE_NID_AUT_kai_04", nick: "Kai_07", jar: "header", ageDays: 6 },
  { key: "FAKE_NID_AUT_oldcookie_05", nick: "낡은쿠키", jar: "persistent", expDays: 340, ageDays: 12, then: "logout" },
  { key: "FAKE_NID_AUT_resting_06", nick: "쉬는계정", jar: "persistent", expDays: 5, ageDays: 9, then: "pause", note: "resting this one" },
];

// A Cookie-Editor export of naver.com (JSON), or a raw Cookie header line.
function exportOf(login, t0) {
  const n = login.key.slice(-2);
  const uuid = crypto.randomUUID();
  if (login.jar === "header") return `NID_AUT=${login.key}; NID_SES=FAKE_NID_SES_${n}; ba.uuid=${uuid}`;
  const exp = login.jar === "persistent" ? Math.floor((t0 + login.expDays * DAY) / 1000) : null;
  const cookie = (name, value, domain = ".naver.com") => ({
    domain, hostOnly: false, httpOnly: name !== "ba.uuid", name, path: "/", sameSite: "unspecified",
    secure: true, session: exp == null, storeId: "0", value, ...(exp == null ? {} : { expirationDate: exp }),
  });
  return JSON.stringify([cookie("NID_AUT", login.key), cookie("NID_SES", `FAKE_NID_SES_${n}`), cookie("ba.uuid", uuid, "chzzk.naver.com")], null, 2);
}

async function seedLogins(farm, fake, t0) {
  // JSON exports back to back, the header line last: one paste, like an operator's.
  const ordered = [...LOGINS.filter((l) => l.jar !== "header"), ...LOGINS.filter((l) => l.jar === "header")];
  const results = (await step("import logins", () => farm.importAccounts(ordered.map((l) => exportOf(l, t0)).join("\n")))) || [];
  log(`imported ${results.filter((r) => r.ok).length}/${results.length} logins`);
  for (const r of results) if (!r.ok) log(`  import refused: ${r.error}`);
  const byKey = {};
  for (const l of LOGINS) {
    const doc = await ChzzkAccount.findOne({ userIdHash: hashOf(l.key) }).lean();
    if (!doc) continue;
    byKey[l.key] = doc;
    // importAccounts stamps cookieAt = now; spread the ages so "imported N days ago" varies.
    await ChzzkAccount.updateOne({ _id: doc._id }, { $set: { cookieAt: new Date(t0 - l.ageDays * DAY) } });
    if (l.note) await farm.updateAccount(String(doc._id), { note: l.note });
    if (l.then === "pause") await farm.updateAccount(String(doc._id), { paused: true });
    if (l.then === "logout") {
      fake.logout(l.key);
      await farm.checkAccounts([String(doc._id)]);
    }
  }
  return byKey;
}

// Codes earned before FC Online sold out, so Codes / Stock show every state at
// once: fresh, revealed, use-by soon, expired, waiting for CHZZK, and in-game.
async function seedCodes(byKey, world, t0) {
  const [sky, mint, moon, kai] = LOGINS.slice(0, 4).map((l) => byKey[l.key]);
  if (!sky || !mint || !moon || !kai) throw new Error("the seeded logins are missing");
  const reward = (acc, camp, rewardNo) => {
    const r = camp.rewardList.find((x) => x.rewardNo === rewardNo);
    return { accountId: String(acc._id), userIdHash: acc.userIdHash, campaignNo: camp.campaignNo, rewardNo, title: r.title,
      rewardType: r.rewardType, categoryId: camp.categoryId, campaignTitle: camp.title };
  };
  const stored = (acc, rewardNo, earnedDaysAgo, useByDays, extra = {}) => ({
    ...reward(acc, world.camps.fco, rewardNo), state: "stored", hasCode: true, codeEnc: encrypt(codeOf(acc.userIdHash, rewardNo)),
    codeNo: String(rewardNo), earnedAt: new Date(t0 - earnedDaysAgo * DAY), codeAt: new Date(t0 - earnedDaysAgo * DAY + 2 * MIN),
    codeEndAt: new Date(t0 + useByDays * DAY), ...extra,
  });
  await ChzzkReward.create([
    stored(sky, 910502, 3, 25),
    stored(mint, 910502, 3, 25, { revealedAt: new Date(t0 - DAY), revealedBy: "harness" }),
    stored(moon, 910503, 2, 4),
    stored(kai, 910501, 8, -1),
    { ...reward(sky, world.camps.fco, 910503), state: "earned", hasCode: false, earnedAt: new Date(t0 - 2 * DAY),
      codeEndAt: new Date(t0 + 25 * DAY), tries: 2, nextTryAt: new Date(t0 + 20 * MIN), lastError: "API: coupon not issued yet" },
    { ...reward(mint, world.camps.wuwa, 910401), state: "in_app", hasCode: false, earnedAt: new Date(t0 - 4 * DAY) },
  ]);
  log("seeded 6 reward rows (4 codes, 1 waiting, 1 in-game) on FC Online / Wuthering Waves");
}

async function seed(farm, fake, world, t0) {
  await step("egress check", () => farm._checkEgress());
  const scan = await step("campaign scan", () => farm.refreshCampaigns());
  if (scan) log(`campaign scan: ${scan.found} found, ${scan.updated} stored`);
  const added = await step("add Endfield by number", () => farm.addCampaign(C.endfield));
  if (added && !added.ok) log(`add Endfield refused: ${added.error}`);
  const byKey = await step("seed logins", () => seedLogins(farm, fake, t0));
  if (byKey) await step("seed codes", () => seedCodes(byKey, world, t0));
}

// Things that happen on CHZZK while you watch.
function startWorldEvents(fake, world) {
  // First-come pools drain; the 30 s discovery copies the new counts into the panel.
  setInterval(() => {
    for (const raw of [world.camps.ow, world.camps.lostark, world.camps.endfield]) {
      for (const r of raw.rewardList) {
        if (r.rewardType === "CODE_FIRST_COME" && r.codeRemainingCount > 60) r.codeRemainingCount -= 1 + Math.floor(Math.random() * 6);
      }
      fake.addCampaign(raw);
    }
  }, 20_000);
  const onAir = (live, status, msg) => () => { fake.setLive(live.channelId, { status }); log(`"${live.channelName}" ${msg}`); };
  setTimeout(onAir(world.lives.owMint, "CLOSE", "went off air — its watchers move to another stream"), 3 * MIN);
  setTimeout(onAir(world.lives.owMint, "OPEN", "is back on air"), 6 * MIN);
  setTimeout(() => {
    for (const l of world.endfieldLives) fake.addLive(l);
    log("Endfield streams are on air; the campaign starts in 30 s");
  }, ENDFIELD_STARTS_IN - 30_000);
}

// Logins the farm does not have yet, plus the files an import has to refuse.
function writeCookieFiles(fake, dir, t0) {
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, text) => fs.writeFileSync(path.join(dir, name), text);
  write("new-login-persistent.json", exportOf({ key: "FAKE_NID_AUT_newfile_11", jar: "persistent", expDays: 200 }, t0));
  write("new-login-session.json", exportOf({ key: "FAKE_NID_AUT_newfile_12", jar: "session" }, t0));
  write("logged-out.json", exportOf({ key: "FAKE_NID_AUT_dead_13", jar: "persistent", expDays: 90 }, t0));
  fake.logout("FAKE_NID_AUT_dead_13");
  write("signed-out.json", JSON.stringify([{ domain: ".naver.com", name: "NNB", value: "FAKE_NNB_14", path: "/", session: true }], null, 2));
  write("not-a-cookie.txt", "Not a cookie export.\n");
  log(`cookie files to try the import dialog with: ${dir}`);
}

function buildApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));
  // Everyone is the same stub superadmin; there is no login in the harness.
  app.use((req, res, next) => {
    req.session = { admin: { id: "harness", role: "superadmin", username: "harness" } };
    next();
  });
  // admin-nav.js redirects to the login page unless this answers 200 with { admin }.
  app.get("/whoami", (req, res) => res.json({ admin: req.session.admin }));
  app.get("/", (req, res) => res.redirect("/chzzk.html"));
  app.get("/harness/img/:file", (req, res) => {
    const name = String(req.params.file).replace(/\.svg$/, "");
    if (!Object.prototype.hasOwnProperty.call(ART, name)) return res.status(404).end();
    res.type("image/svg+xml").set("Cache-Control", "max-age=3600").send(svg(ART[name]));
  });
  app.use(chzzkRoutes);
  app.use(express.static(path.join(__dirname, "..", "public")));
  app.use((req, res) => res.status(404).json({ success: false, message: "Not in the harness: " + req.path }));
  return app;
}

async function main() {
  const mem = await MongoMemoryServer.create();
  const uri = mem.getUri("chzzk_harness");
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(uri)) throw new Error("refusing a non-local MongoDB");
  await mongoose.connect(uri);
  await Promise.all([ChzzkAccount.init(), ChzzkCampaign.init(), ChzzkReward.init(), ChzzkActivity.init()]);
  log("in-memory MongoDB ready");

  const t0 = Date.now();
  const world = buildWorld(t0);
  const fake = createFakeChzzk({ campaigns: Object.values(world.camps), lives: Object.values(world.lives), minutesPerBeat: 1 });
  fake.noCredit(world.lives.owQuiet.channelId); // one stream CHZZK never credits: its watcher leaves after 3 flat reads

  const transport = { ready: true, describe: () => "harness (fake CHZZK)",
    request: async () => { throw new Error("the harness transport never sends a request"); },
    stats: () => ({ requests: 0, failures: 0, lastOkAt: 0, lastErrorAt: 0, lastError: "" }) };
  let switchOn = true; // the real switch lives in utils/settings.json; the harness keeps its own
  const settings = {
    getAutoFarm: () => ({ chzzkFarm: switchOn }),
    setAutoFarm: async (patch) => {
      if (patch && typeof patch.chzzkFarm === "boolean") switchOn = patch.chzzkFarm;
      log(`farm switched ${switchOn ? "ON" : "OFF"}`);
      return { chzzkFarm: switchOn };
    },
  };
  const telegram = { sendTelegram: async (text) => { log("Telegram (stub, not sent): " + text); return true; } };

  const farm = new Farm({
    makeClient: clientFactory(fake, new Map(LOGINS.map((l) => [l.key, l.nick]))),
    runSession: (opts) => runSession({ ...opts, timings: WORKER_TIMINGS }),
    createCollector: (deps) => createCollector({ ...deps, gapMs: 500 }),
    transport, transportFactory: () => transport, settings, telegram, timings: FARM_TIMINGS,
  });
  // Seeding runs before start() so no worker races the logout / pause; the
  // methods it calls only need the transport, as in tests/chzzkFarm.test.js.
  farm.transport = transport;
  await seed(farm, fake, world, t0);
  if (COOKIE_DIR) await step("write cookie files", () => writeCookieFiles(fake, path.resolve(COOKIE_DIR), t0));
  farm.start();
  chzzkRoutes._setFarmForTests(farm);
  startWorldEvents(fake, world);

  const server = buildApp().listen(PORT, "127.0.0.1", () => {
    log(`CHZZK farm harness: http://127.0.0.1:${PORT}/chzzk.html   (Ctrl+C to stop)`);
    log("4 logins farm Lost Ark (ends in 2 h), then Overwatch; Endfield opens in 10 min. To try the import box, paste:");
    log("  NID_AUT=FAKE_NID_AUT_paste_21; NID_SES=FAKE_NID_SES_21");
  });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    server.close();
    await step("stop farm", () => farm.stop());
    await mongoose.disconnect().catch(() => {});
    await mem.stop().catch(() => {});
    process.exit(0); // keep-alive page connections would otherwise hold the process
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// A stray rejection is reported, not fatal: the page under test keeps its server.
process.on("unhandledRejection", (err) => log("unhandled rejection:", err && err.message));

main().catch((err) => {
  console.error("[harness] could not start:", err);
  process.exit(1);
});
