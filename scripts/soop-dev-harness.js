#!/usr/bin/env node
/* global setInterval */
// SOOP farm dev harness (contract §12):
//
//   node scripts/soop-dev-harness.js [port=4599]   ->   http://127.0.0.1:4599/soop.html
//
// The real routes, farm service and page, running against an in-memory MongoDB
// and the fake SOOP from tests/helpers/soopFake.js. Nothing here can reach the
// real database or sooplive.com: .env is never loaded, MONGO_URI is dropped, the
// farm only ever gets fake clients, and outbound requests to SOOP hosts throw.
// Time runs 30x: the fake credits one minute every 2 s and the farm's waits are
// shortened to match, so progress moves while you watch.
const path = require("path");
const http = require("http");
const https = require("https");

delete process.env.MONGO_URI;
delete process.env.SOOP_PROXY_URL;
// Cookies and reward codes are encrypted at rest; the key only has to be stable
// for the life of this throwaway database.
if (!process.env.CRED_SECRET) process.env.CRED_SECRET = "soop-dev-harness-only";

// Tripwire: a bug that reaches for the real site fails loudly instead of connecting.
for (const mod of [http, https]) {
  for (const fn of ["request", "get"]) {
    const real = mod[fn];
    mod[fn] = function guarded(...args) {
      const target = args
        .slice(0, 2)
        .map((a) => (typeof a === "string" ? a : a && (a.href || a.hostname || a.host)) || "")
        .join(" ");
      if (/sooplive|afreecatv/i.test(target)) {
        throw new Error("soop-dev-harness: blocked a real SOOP request (" + target.trim() + ")");
      }
      return real.apply(this, args);
    };
  }
}

const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { createFakeSoop } = require("../tests/helpers/soopFake");

const PORT = Number(process.argv[2]) || 4599;
const SPEED = 30; // simulated minutes per real minute
const ADVANCE_MS = 60000 / SPEED; // one fake minute
const HOUR = 3600 * 1000;
const kst = (ms) => new Date(ms + 9 * HOUR).toISOString().slice(0, 19).replace("T", " ");
const log = (...a) => console.log("[harness]", ...a);

// The farm's waits, 30x faster. Resolves early on abort, like the worker's own sleep.
function fastSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(5, ms / SPEED));
    if (signal) signal.addEventListener("abort", done, { once: true });
  });
}

// The farm and routes are rebuilt alongside this file: one failed step is
// reported and the rest of the harness still comes up.
async function step(name, fn) {
  try {
    return await fn();
  } catch (err) {
    log(`${name} FAILED: ${err && err.message}`);
    return null;
  }
}

// ~14 campaigns over 5 games. Returns the ids the rest of the seed refers to.
function seedCampaigns(world) {
  const code = (name, term) => ({ itemType: "1", itemName: name, giveTerm: term });
  const ingame = (name, term) => ({ itemType: "4", itemName: name, giveTerm: term });
  const kuro = {
    gameNo: "244", cateNo: "00360100", cateName: "명조: 워더링 웨이브", typeNm: "kuro", ingameGiveYn: "Y",
    loginPath: "https://example.invalid/link/kuro", acctLinkPath: "https://example.invalid/link/kuro",
  };
  const krafton = {
    gameNo: "8", typeNm: "krafton", ingameGiveYn: "Y",
    loginPath: "https://example.invalid/link/krafton", acctLinkPath: "https://example.invalid/link/krafton",
  };
  const ow = [{ userId: "owesports", userNick: "owesports" }, { userId: "ow_sub", userNick: "OW서브" }];
  const pubg = [{ userId: "pubg01", userNick: "PUBG서브" }];
  const add = (p) => world.addCampaign(p).dropsIdx;

  const ids = {
    // Overwatch
    owLive: add({ title: "OWCS KOREA 드롭스 3주차", gameNo: "12", live: true, broadIdList: ow,
      itemList: [code("OWCS 스프레이 코드", 30), code("OWCS 플레이어 아이콘", 60), code("OWCS 전설 스킨", 120)] }),
    owRaffle: add({ title: "OWCS KOREA 문화상품권 드롭스", gameNo: "12", giveCon: "none", dropsType: "I", live: true,
      broadIdList: ow, itemList: [{ itemName: "문화상품권 5천원", giveTerm: 0, ongoingTerm: "200" }] }),
    owNext: add({ title: "OWCS ASIA Championship Day 1", gameNo: "12", filter: "scheduled", broadIdList: ow,
      itemList: [code("Championship spray", 30), code("Championship skin", 90)] }),
    owOld: add({ title: "OWCS KOREA 드롭스 2주차", gameNo: "12", broadIdList: ow,
      itemList: [code("OWCS 스프레이 코드", 30), code("OWCS 플레이어 아이콘", 60)] }),
    // Wuthering Waves: category-wide, rewards go to a linked game account
    wuwaLive: add({ ...kuro, title: "명조:워더링 웨이브 라이브 드롭스 이벤트", live: true,
      cateChannels: ["wuwa_haru", "wuwa_mina"],
      itemList: [ingame("클램 코인*25,000", 15), ingame("고급 에너지 코어*3", 30), ingame("별의 소리*100", 60)] }),
    wuwaNext: add({ ...kuro, title: "Wuthering Waves 3.0 launch stream", filter: "scheduled",
      itemList: [ingame("Astrite x100", 30), ingame("Lustrous Tide x1", 120)] }),
    // PUBG
    pubgLive: add({ ...krafton, title: "PUBG ASIA STARS 드롭스 Day 3", dropsType: "I", live: true, broadIdList: pubg,
      itemList: [ingame("SOOP 드롭스 베이직 상자 (Day 3)", 60)] }),
    pubgNext: add({ ...krafton, title: "PUBG ASIA STARS 드롭스 Day 4", filter: "scheduled", broadIdList: pubg,
      itemList: [ingame("SOOP 드롭스 베이직 상자 (Day 4)", 60)] }),
    pubgRaffle: add({ title: "PUBG WEEKLY SERIES 기프티콘 추첨", gameNo: "8", giveCon: "draw",
      broadIdList: ["pubg_weekly"], itemList: [{ itemType: "2", itemName: "치킨 기프티콘", giveTerm: 60 }] }),
    pubgOld: add({ ...krafton, title: "PUBG ASIA STARS 드롭스 Day 2", broadIdList: pubg,
      itemList: [ingame("SOOP 드롭스 베이직 상자 (Day 2)", 60)] }),
    // Delta Force
    deltaLive: add({ title: "DELTA FORCE RISE SERIES 2026 DAY 1", gameNo: "200", live: true,
      broadIdList: ["deltaforce_kr"], itemList: [code("Rise Series charm", 30), code("Rise Series weapon skin", 60), code("Operator outfit", 90)] }),
    deltaNext: add({ title: "DELTA FORCE RISE SERIES 2026 DAY 2", gameNo: "200", filter: "scheduled",
      broadIdList: ["deltaforce_kr"], itemList: [code("Rise Series charm II", 30), code("Rise Series weapon skin II", 60)] }),
    // League of Legends: one guaranteed campaign whose stream is not on yet, one link/form raffle
    lolWait: add({ title: "2026 LCK 결승전 시청 미션", gameNo: "4", broadIdList: [{ userId: "lck", userNick: "LCK" }],
      itemList: [code("LCK 결승전 이모티콘", 30), code("LCK 결승전 와드 스킨", 120)] }),
    lolForm: add({ title: "LCK 기프티콘 이벤트", gameNo: "4", giveCon: "none", live: true,
      broadIdList: ["lck_event"], itemList: [{ itemType: "2", itemName: "편의점 기프티콘", giveTerm: 45 }] }),
  };
  return ids;
}

function seedInventory(world, ids, now) {
  const fakeCode = (n) => `FAKE-OWCS-${String(n).padStart(4, "0")}-DEMO`;
  ids.slice(0, 6).forEach((id, n) => {
    world.addInventory(id, { itemName: "OWCS 스프레이 코드", gameNo: "12", itemCode: fakeCode(n + 1) });
    world.addInventory(id, { itemName: "Rise Series charm", gameNo: "200", itemCode: fakeCode(n + 101),
      expDate: kst(now + (20 + n * 30) * HOUR) }); // the first three expire within 72 h
    if (n % 2 === 0) {
      world.addInventory(id, { itemName: "클램 코인*25,000", itemType: "4", gameNo: "244", typeNm: "kuro",
        ingameGiveYn: "Y", acctConn: false, acctLinkPath: "https://example.invalid/link/kuro" });
    }
    if (n < 3) {
      world.addInventory(id, { itemName: "OWCS 플레이어 아이콘", gameNo: "12", itemCode: fakeCode(n + 201), useFlag: "Y" }, "acquired");
      world.addInventory(id, { itemName: "SOOP 드롭스 베이직 상자 (Day 1)", itemType: "4", gameNo: "8", typeNm: "krafton" }, "expired");
    }
  });
}

async function seed(farm, world) {
  const now = Date.now();
  const camps = seedCampaigns(world);
  // 12 accounts, all seen from Sri Lanka (a country SOOP credits).
  const ids = Array.from({ length: 12 }, (_, i) => `soopdev${String(i + 1).padStart(2, "0")}`);
  const nicks = ["하루", "Mina", "도윤", "Kasun", "Nimal", "서연", "Ruwan", "지호", "Tharu", "Yuna", "Old cookie", "Sold one"];
  const exports = ids.map((id, i) => JSON.stringify(world.addAccount({ id, nick: nicks[i], country: "LK" })));
  seedInventory(world, ids, now);
  const [loggedOut, sold] = ids.slice(10);

  await step("farm.start", () => farm.start());
  const results = await step("import accounts", () => farm.importAccounts(exports.join("\n")));
  if (results) log(`imported ${results.filter((r) => r.ok).length}/${results.length} accounts`);
  await step("mark one sold", () => farm.updateAccount(sold, { sold: true }));
  await step("log one out", () => {
    world.logout(loggedOut);
    return farm.checkAccounts([loggedOut]);
  });

  // Seen once, then taken off SOOP's list: these two become "unlisted".
  await step("first campaign scan", () => farm.campaignsView({ force: true }));
  for (const key of ["owOld", "pubgOld"]) {
    world.setLive(camps[key], false);
    world.delist(camps[key]);
  }
  const view = await step("second campaign scan", () => farm.campaignsView({ force: true }));
  if (view) log(`${view.campaigns.length} campaigns over ${view.games.length} games`);

  const bots = [
    { name: "Overwatch squad", mode: "game", gameNo: "12", accountIds: ids.slice(0, 4), target: "all", codesOnly: false },
    { name: "Delta Force day 1", mode: "campaign", dropsIdx: camps.deltaLive, accountIds: ids.slice(4, 6), target: "first", codesOnly: false },
    { name: "LCK final", mode: "campaign", dropsIdx: camps.lolWait, accountIds: ids.slice(6, 7), target: "all", codesOnly: false },
  ];
  for (const b of bots) {
    const r = await step(`create bot "${b.name}"`, () => farm.createBot(b));
    if (r && !r.ok) log(`create bot "${b.name}" refused: ${r.error}`);
  }
  await step("inventory sync", () => farm.inventory.syncMany(ids.slice(0, 10)));
  log(`seeded: ${ids.length} accounts (${loggedOut} logged out, ${sold} sold, ${ids.slice(7, 10).join(", ")} free), ${bots.length} bots`);
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
  app.get("/", (req, res) => res.redirect("/soop.html"));
  app.use(require("../routes/soopRoutes"));
  app.use(express.static(path.join(__dirname, "..", "public")));
  app.use((req, res) => res.status(404).json({ success: false, message: "Not in the harness: " + req.path }));
  return app;
}

async function main() {
  const mem = await MongoMemoryServer.create();
  const uri = mem.getUri("soop_harness");
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(uri)) throw new Error("refusing a non-local MongoDB");
  await mongoose.connect(uri);
  log("in-memory MongoDB ready");

  const world = createFakeSoop();
  const farm = require("../utils/soopFarm");
  farm.setClientFactory((cookies, opts) => world.clientFor(cookies, opts));
  farm.setClock({ sleep: fastSleep });
  await seed(farm, world);

  setInterval(() => world.advance(1), ADVANCE_MS);
  const server = buildApp().listen(PORT, "127.0.0.1", () => {
    log(`SOOP farm harness: http://127.0.0.1:${PORT}/soop.html   (Ctrl+C to stop)`);
  });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    server.close();
    await step("stop bots", () => farm.stopAllBots());
    await mongoose.disconnect().catch(() => {});
    await mem.stop().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[harness] could not start:", err);
  process.exit(1);
});
