// The drop scanner re-reads every BotAccount, dead ones included. Two rules:
//   1. An account already known to be gone keeps that verdict unless Twitch
//      says it EXISTS again. Demoting it to token_invalid on an inconclusive
//      probe is what let the tick's sweep re-date and re-announce the same ban
//      every day.
//   2. A NEW ban found here is told to the operator (one Telegram per batch),
//      and "was working, now gone" is kept apart from "already gone on its
//      first ever read" — 44 of the latter surfaced in one move on 2026-09-20.
const test = require("node:test");
const assert = require("node:assert");

// Stand-ins for the network/telegram/audit edges, installed before the scanner
// is loaded because it destructures them at require time.
function fakeModule(rel, exportsObj) {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
}
let nextScanError = null;
const telegrams = [];
fakeModule("../utils/twitchInventory", {
  fetchInventory: async () => {
    throw nextScanError;
  },
  itemKeyFor: () => "",
});
fakeModule("../utils/telegram", {
  sendTelegram: async (msg) => {
    telegrams.push(msg);
  },
});
fakeModule("../utils/systemLog", { logEvent: () => {} });

const accountState = require("../utils/twitchAccountState");
const suspendedAccounts = require("../utils/suspendedAccounts");
const scanner = require("../utils/dropScanner");
const { scanAccount, flushBanNews, banNews } = scanner.__test;

const worker = () => ({ host: { transport: "local", id: "local" }, errors: 0 });
const tokenRejected = () => Object.assign(new Error("401 token"), { code: "token_invalid" });

function account(fields) {
  return {
    _id: "id-" + fields.login,
    container: "",
    save: async () => {},
    ...fields,
  };
}

function withProbe(verdict, t) {
  const orig = accountState.probeAccount;
  accountState.probeAccount = async () => verdict;
  const origProp = suspendedAccounts.propagateSuspensionToPool;
  suspendedAccounts.propagateSuspensionToPool = async () => 0;
  t.after(() => {
    accountState.probeAccount = orig;
    suspendedAccounts.propagateSuspensionToPool = origProp;
  });
}

test("a known ban survives an inconclusive probe or a scan error", async (t) => {
  withProbe(accountState.UNKNOWN, t);
  const bannedAt = new Date("2026-08-26T11:07:23Z");
  const a = account({ login: "velvet36phoenix409249", lastScanStatus: "suspended", suspendedAt: bannedAt });
  nextScanError = tokenRejected();
  await scanAccount(a, worker());
  assert.equal(a.lastScanStatus, "suspended");
  assert.equal(a.suspendedAt, bannedAt);

  const b = account({ login: "deadtoo", lastScanStatus: "suspended", suspendedAt: bannedAt });
  nextScanError = new Error("socket hang up");
  await scanAccount(b, worker());
  assert.equal(b.lastScanStatus, "suspended");
  assert.equal(banNews.banned.length + banNews.deadOnArrival.length, 0, "nothing new to tell");
});

test("a known ban that Twitch says EXISTS again goes back to token_invalid", async (t) => {
  withProbe(accountState.EXISTS, t);
  const a = account({ login: "cameback", lastScanStatus: "suspended", suspendedAt: new Date("2026-09-01") });
  nextScanError = tokenRejected();
  await scanAccount(a, worker());
  assert.equal(a.lastScanStatus, "token_invalid");
});

test("new bans are queued once, split by whether the account ever worked", async (t) => {
  withProbe(accountState.GONE, t);
  nextScanError = tokenRejected();
  const working = account({ login: "cbqy105fd", lastScanStatus: "ok", suspendedAt: null });
  const firstRead = account({ login: "humble4glionr91769", lastScanStatus: "pending", suspendedAt: null });
  const flapped = account({ login: "oldflap", lastScanStatus: "token_invalid", suspendedAt: new Date("2026-08-01") });
  for (const acc of [working, firstRead, flapped]) await scanAccount(acc, worker());

  assert.equal(working.lastScanStatus, "suspended");
  assert.ok(working.suspendedAt instanceof Date);
  assert.equal(flapped.lastScanStatus, "suspended");
  assert.equal(flapped.suspendedAt.toISOString(), "2026-08-01T00:00:00.000Z", "old ban keeps its date");
  assert.deepEqual(banNews.banned, ["cbqy105fd"]);
  assert.deepEqual(banNews.deadOnArrival, ["humble4glionr91769"]);

  telegrams.length = 0;
  await flushBanNews();
  assert.equal(telegrams.length, 1, "one message per batch");
  assert.match(telegrams[0], /banned 1 account\(s\) that were working until now: cbqy105fd/);
  assert.match(telegrams[0], /1 account\(s\) were already gone the first time they were scanned/);
  assert.equal(banNews.banned.length + banNews.deadOnArrival.length, 0);
  assert.equal(banNews.timer, null);

  await flushBanNews();
  assert.equal(telegrams.length, 1, "an empty batch sends nothing");
});
