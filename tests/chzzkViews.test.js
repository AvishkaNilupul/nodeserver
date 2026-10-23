// Pins utils/chzzk/views.js (docs/CHZZK-PANEL-V2.md §2) and the cookie
// lifetime read in utils/chzzk/cookies.js. Pure functions: no DB, no network.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const views = require("../utils/chzzk/views");
const { parseImport, loginInfo } = require("../utils/chzzk/cookies");

const NOW = Date.parse("2026-10-23T05:00:00Z");
const H = 3600_000;
const code = (rewardNo, minutes, remaining = 100) => ({ rewardNo, title: "R" + rewardNo, rewardType: "CODE_FIRST_COME", minutes, remaining });
const camp = (extra = {}) => ({
  campaignNo: 1954, title: "OW", categoryValue: "Overwatch", enabled: true, state: "PROMOTED", needsLink: false,
  startAt: new Date(NOW - 24 * H), endAt: new Date(NOW + 10 * H), rewards: [code(5089, 180)], ...extra,
});
const acc = (extra = {}) => ({
  _id: "a1", userIdHash: "ff0d49eaXXXX", nickname: "nick", status: "ok", sold: false, paused: false,
  cookieAt: new Date(NOW - 2 * 24 * H), cookieKind: "session", progress: {}, ...extra,
});

test("campaignWhy names the reason in plain words", () => {
  assert.equal(views.campaignWhy(camp(), NOW), "");
  assert.equal(views.campaignWhy(camp({ enabled: false }), NOW), "Turned off here");
  assert.equal(views.campaignWhy(camp({ needsLink: true }), NOW), "Needs a linked game account");
  assert.equal(views.campaignWhy(camp({ endAt: new Date(NOW - 1) }), NOW), "Ended");
  assert.equal(views.campaignWhy(camp({ startAt: new Date(NOW + H) }), NOW), "Not started yet");
  assert.equal(views.campaignWhy(camp({ rewards: [{ rewardNo: 1, rewardType: "IN_APP", minutes: 60 }] }), NOW), "In-game rewards only (no codes)");
  assert.equal(views.campaignWhy(camp({ rewards: [code(1, 60, 0)] }), NOW), "Every code is gone");
});

test("accountView: v1 done marks are not done; idle accounts say why; no worker = no current", () => {
  const a = views.accountView(acc({ progress: { 1954: { minutes: 180, done: true }, 1987: { minutes: 45, done: true, verified: true } }, current: { state: "watching" } }),
    { worker: null, switchOn: true, egressOk: false, now: NOW });
  assert.equal(a.progress[1954].done, false);
  assert.equal(a.progress[1987].done, true);
  assert.equal(a.running, false);
  assert.equal(a.current, null, "a stale stored 'watching' is not shown");
  assert.equal(a.why, "Egress is down");
  assert.equal(a.userIdHash, "ff0d49ea");
  assert.equal(a.login.kind, "session");
  assert.equal(a.login.ageDays, 2);
  const dead = views.accountView(acc({ status: "not_logged_in", unusableSince: new Date(NOW - 12 * H) }), { worker: null, switchOn: true, egressOk: true, now: NOW });
  assert.equal(dead.why, "Logged out — re-import its cookie");
  assert.equal(dead.login.livedDays, 1.5);
  const running = views.accountView(acc(), { worker: { current: { state: "watching", campaignNo: 1954 } }, switchOn: true, egressOk: true, now: NOW });
  assert.equal(running.why, "");
  assert.equal(running.current.campaignNo, 1954);
});

test("campaignView counts logins done / watching and lists them", () => {
  const a1 = views.accountView(acc({ _id: "a1", progress: { 1954: { minutes: 30 } } }), { worker: { current: { state: "watching", campaignNo: 1954, minutes: 31 } }, switchOn: true, egressOk: true, now: NOW });
  const a2 = views.accountView(acc({ _id: "a2", progress: { 1954: { minutes: 180, done: true, verified: true } } }), { worker: null, switchOn: true, egressOk: true, now: NOW });
  const v = views.campaignView(camp(), { earnedByReward: new Map([[5089, 1]]), accounts: [a1, a2], now: NOW });
  assert.equal(v.farmable, true);
  assert.equal(v.maxMinutes, 180);
  assert.deepEqual({ e: v.logins.eligible, d: v.logins.done, w: v.logins.watching }, { e: 2, d: 1, w: 1 });
  assert.equal(v.logins.list.find((x) => x.id === "a1").minutes, 31);
  assert.equal(v.rewards[0].earned, 1);
});

test("stockView groups by reward: fresh, revealed, expired, waiting, earliest use-by", () => {
  const camps = new Map([[1987, { campaignNo: 1987, title: "MW4", categoryValue: "CoD" }]]);
  const row = (extra) => ({ campaignNo: 1987, rewardNo: 5149, title: "Gas Ready", rewardType: "CODE_FIRST_COME", state: "stored", hasCode: true, earnedAt: new Date(NOW - H), codeEndAt: new Date(NOW + 30 * 24 * H), ...extra });
  const { stock, totals } = views.stockView([
    row({}), row({ revealedAt: new Date(NOW) }), row({ codeEndAt: new Date(NOW - 1) }),
    row({ hasCode: false, state: "earned" }), row({ codeEndAt: new Date(NOW + 5 * 24 * H) }), row({ rewardNo: 1, state: "in_app", hasCode: false }),
  ], { campaignsByNo: camps, now: NOW });
  assert.equal(stock.length, 1);
  assert.deepEqual({ s: stock[0].stored, f: stock[0].fresh, r: stock[0].revealed, x: stock[0].expired, w: stock[0].waiting },
    { s: 4, f: 2, r: 1, x: 1, w: 1 });
  assert.equal(stock[0].game, "CoD");
  assert.equal(+new Date(stock[0].useBy), NOW + 5 * 24 * H);
  assert.equal(totals.fresh, 2);
});

test("alerts: egress, logged out, ending soon, session cookies — worst first", () => {
  const ok = views.accountView(acc(), { worker: null, switchOn: true, egressOk: true, now: NOW });
  const dead = views.accountView(acc({ _id: "a2", nickname: "gone", status: "not_logged_in" }), { worker: null, switchOn: true, egressOk: true, now: NOW });
  const c = views.campaignView(camp(), { accounts: [ok, dead], now: NOW });
  const list = views.alerts({ switchOn: true, egress: { ok: false, error: "tunnel down" }, accounts: [ok, dead], campaigns: [c], counts: { waiting: 0, expiringSoon: 0 }, now: NOW });
  assert.deepEqual(list.map((a) => a.kind), ["egress", "login", "ending", "cookie"]);
  assert.match(list[1].msg, /gone/);
  assert.match(list[2].msg, /^Overwatch: "OW" ends in 10 hours — 1 of 1 login still to finish it \(180 min needed\)/);
  assert.equal(views.gameName("Call_of_Duty_Modern_Warfare4", "콜 오브 듀티"), "Call of Duty: MW4");
  assert.equal(views.gameName("SomeNew_Game", ""), "Some New Game");
  assert.equal(views.gameName("", "게임"), "게임");
  const off = views.alerts({ switchOn: false, egress: { ok: true }, accounts: [], campaigns: [], counts: {}, now: NOW });
  assert.equal(off[0].kind, "switch");
});

test("loginInfo / parseImport infos: session vs persistent, values never echoed", () => {
  const exp = Math.floor((NOW + 365 * 24 * H) / 1000);
  const session = [{ name: "NID_AUT", value: "AAA", domain: ".naver.com", session: true }, { name: "NID_SES", value: "SSS", domain: ".naver.com", session: true }];
  const persistent = [{ name: "NID_AUT", value: "BBB", domain: ".naver.com", session: false, expirationDate: exp }, { name: "NID_SES", value: "TTT", domain: ".naver.com", session: true }];
  assert.deepEqual(loginInfo(session), { kind: "session", expiresAt: null });
  assert.equal(loginInfo(persistent).kind, "persistent");
  assert.equal(+loginInfo(persistent).expiresAt, exp * 1000);
  const parsed = parseImport(JSON.stringify(session) + "\n" + JSON.stringify(persistent) + "\nNID_AUT=x; NID_SES=y");
  assert.deepEqual(parsed.infos.map((i) => i.kind), ["session", "persistent", "unknown"]);
  assert.equal(parsed.jars.length, 3);
  assert.ok(!JSON.stringify(parsed.infos).includes("AAA"));
  assert.deepEqual(Object.keys(parsed.jars[0][0]).sort(), ["domain", "name", "value"], "jar shape unchanged");
});

test("campaignView: a paused login is not counted as still to finish", () => {
  const ctx = { worker: null, switchOn: true, egressOk: true, now: NOW };
  const v = views.campaignView(camp(), { accounts: [views.accountView(acc({ _id: "a1" }), ctx), views.accountView(acc({ _id: "a2", paused: true }), ctx)], now: NOW });
  assert.equal(v.logins.eligible, 1);
});

test("shop state: a code on sale or sold in the code shop is said so, and counted per reward", () => {
  const shopOf = new Map([["a1|5089", "in_unit"], ["a2|5089", "sold"]]);
  const r = (accountId, extra = {}) => ({ _id: "x" + accountId, accountId, rewardNo: 5089, campaignNo: 1954, hasCode: true, state: "stored", codeEndAt: new Date(NOW + 9 * 24 * H), ...extra });
  const v = views.rewardView(r("a1"), { accountsById: new Map(), campaignsByNo: new Map(), shopOf });
  assert.equal(v.shop, "in_unit");
  assert.equal(v.shopWord, "on sale");
  assert.equal(views.rewardView(r("a3"), { accountsById: new Map(), campaignsByNo: new Map(), shopOf }).shop, "");
  const { stock, totals } = views.stockView([r("a1"), r("a2"), r("a3")], { campaignsByNo: new Map(), now: NOW, shopOf });
  assert.deepEqual([stock[0].onSale, stock[0].sold, totals.onSale, totals.sold], [1, 1, 1, 1]);
});
