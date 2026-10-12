// The SOOP login alert (docs/SOOP-FARM-CONTRACT.md §16): the owner hears, once,
// when logins stop being able to farm, and once when they are all back.
//
// Runs against the real SoopAccount model on an in-memory MongoDB with a pinned
// clock and a recording `send`. No network, no Telegram.
//
// The failures these exist to prevent:
//  1. SILENCE. On 2026-10-11 all eight logins were refused by the drops site and
//     nobody was told for nine hours.
//  2. NOISE. An alert that repeats on every pass, every restart, or once per
//     login is one the owner mutes — and then it is silence again.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const SoopAccount = require("../models/SoopAccount");
const { createLoginAlert, createTelegramSend, WAIT_MS, QUIET_MS, MAX_WAIT_MS, RETRY_MS } = require("../utils/soop/loginAlert");

const MIN = 60000;
const T0 = Date.parse("2026-10-11T18:02:00Z");

let mongod;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await SoopAccount.init();
});

test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

test.beforeEach(async () => {
  await SoopAccount.deleteMany({});
});

// A farm with a clock that only moves when told to.
function world(opts = {}) {
  const w = { at: T0, sent: [], notes: [] };
  const build = () =>
    createLoginAlert({
      send: async (text) => w.sent.push(text),
      activity: { add: (e) => w.notes.push(e) },
      now: () => w.at,
      ...opts,
    });
  w.alert = build();
  // A pm2 restart: everything the process remembered is gone.
  w.restart = () => (w.alert = build());
  w.pass = () => w.alert.pass();
  // Move the clock, then look — as the farm's one-minute timer would.
  w.after = (ms) => {
    w.at += ms;
    return w.pass();
  };
  return w;
}

const add = (ids, status = "ok", extra = {}) =>
  SoopAccount.insertMany([].concat(ids).map((loginId) => ({ loginId, status, ...extra })));
const set = (ids, status, extra = {}) =>
  SoopAccount.updateMany({ loginId: { $in: [].concat(ids) } }, { $set: { status, ...extra } });
const row = (id) => SoopAccount.findOne({ loginId: id }).lean();

test("nothing is said, and nothing is stamped, while every login works", async () => {
  const w = world();
  await add(["a", "b"], "ok");
  await add("c", "untested");
  for (let i = 0; i < 20; i++) assert.equal((await w.after(MIN)).sent, null);
  assert.deepEqual(w.sent, []);
  for (const id of ["a", "b", "c"]) {
    const doc = await row(id);
    assert.equal(doc.unusableSince, null);
    assert.equal(doc.unusableAlertAt, null);
  }
});

test("logins the drops site refuses are reported once, after the wait, all in one message", async () => {
  const w = world();
  await add(["a", "b", "c"], "drops_rejected");

  const first = await w.pass();
  assert.equal(first.sent, null, "not on first sight");
  assert.equal(first.pending, 3);
  assert.equal((await row("a")).unusableSince.getTime(), T0, "since when is remembered");

  assert.equal((await w.after(WAIT_MS - MIN)).sent, null, "still inside the wait");
  const due = await w.after(MIN);
  assert.equal(due.sent, "down");
  assert.equal(w.sent.length, 1);
  assert.match(w.sent[0], /none of the 3 logins can farm/);
  assert.match(w.sent[0], /Refused by the drops site \(3\): a, b, c/);
  assert.match(w.sent[0], /drops\.sooplive\.com/);
  assert.equal((await row("b")).unusableAlertAt.getTime(), w.at);
  assert.equal(w.notes.filter((n) => n.kind === "alert" && n.level === "error").length, 1, "the activity log says a message went out");

  for (let i = 0; i < 30; i++) await w.after(MIN);
  assert.equal(w.sent.length, 1, "and never again while nothing changes");
});

test("logins that die minutes apart go out as one message, not one each (the 2026-10-11 shape)", async () => {
  const w = world();
  const all = ["a", "b", "c", "d", "e", "f", "g", "h"];
  await add(all, "ok");
  await set(["a", "b", "c"], "not_logged_in"); // 18:02 — three sessions end on a refused call
  await w.pass();
  for (let i = 0; i < 4; i++) await w.after(MIN);
  await set(["d", "e", "f", "g", "h"], "not_logged_in"); // 18:07 — the other five
  assert.equal((await w.after(MIN)).sent, null, "the first three are due, but the batch is still growing");
  assert.equal((await w.after(MIN)).sent, null);
  assert.equal((await w.after(MIN)).sent, "down", "quiet for long enough");
  assert.equal(w.sent.length, 1);
  assert.match(w.sent[0], /none of the 8 logins can farm/);
  assert.match(w.sent[0], /Logged out \(8\): a, b, c, d, e, f, g, h/);
});

test("the news is never held past the longest wait, however long logins keep failing", async () => {
  const w = world();
  const ids = Array.from({ length: 30 }, (_, i) => "acc" + String(i).padStart(2, "0"));
  await add(ids, "ok");
  let sentAfter = null;
  for (let i = 0; i < ids.length && sentAfter === null; i++) {
    await set(ids[i], "drops_rejected"); // another one every minute: never quiet
    if ((await w.after(MIN)).sent === "down") sentAfter = w.at - T0;
  }
  assert.ok(sentAfter !== null, "a message went out");
  assert.ok(sentAfter <= MAX_WAIT_MS + MIN, "within the longest wait of the first failure");
  assert.match(w.sent[0], / of 30 logins can no longer farm/);
  assert.match(w.sent[0], / and \d+ more/, "a long list is cut short, with a count");
});

test("a refusal the next check takes back is never reported", async () => {
  const w = world();
  await add("a", "drops_rejected");
  await add("b", "ok");
  await w.pass();
  await w.after(WAIT_MS - 2 * MIN);
  await set("a", "ok"); // the health check asked again and SOOP accepted it
  for (let i = 0; i < 20; i++) await w.after(MIN);
  assert.deepEqual(w.sent, [], "neither the failure nor a recovery nobody was waiting for");
  assert.equal((await row("a")).unusableSince, null, "and the stamp is gone, so a later failure starts a fresh wait");
});

test("a login that flips between logged out and refused is one problem, reported once", async () => {
  const w = world();
  await add("a", "not_logged_in");
  await add("b", "ok");
  await w.pass();
  for (let i = 0; i < 12; i++) {
    await set("a", i % 2 ? "not_logged_in" : "drops_rejected");
    await w.after(MIN);
  }
  assert.equal(w.sent.length, 1);
  assert.match(w.sent[0], /1 of 2 logins can no longer farm/);
});

test("a restart neither repeats a message nor loses one that was still waiting", async () => {
  const w = world();
  await add(["a", "b"], "drops_rejected");
  await w.pass();
  await w.after(2 * MIN);
  w.restart(); // mid-wait: the stamp in the database carries the clock over
  assert.equal((await w.after(MIN)).sent, null, "3 minutes in — a restart must not make it due early");
  assert.equal((await w.after(2 * MIN)).sent, "down", "5 minutes after it was first seen, not after the restart");
  assert.equal(w.sent.length, 1);

  for (let i = 0; i < 5; i++) {
    w.restart();
    await w.after(MIN);
    await w.after(10 * MIN);
  }
  assert.equal(w.sent.length, 1, "five restarts later the owner has still been told once");
});

test("once every login is accepted again the owner is told, once", async () => {
  const w = world();
  await add(["a", "b", "c"], "drops_rejected");
  await w.pass();
  await w.after(WAIT_MS);
  assert.equal(w.sent.length, 1);

  await set(["a", "b"], "ok"); // two cookies re-imported
  await set("c", "untested", { cookieAt: new Date(w.at) }); // the third is imported, its check still to come
  assert.equal((await w.after(MIN)).sent, null, "not while one that was reported is unconfirmed");
  await set("c", "ok");
  assert.equal((await w.after(MIN)).sent, "back");
  assert.match(w.sent[1], /all 3 logins are accepted again/);
  for (let i = 0; i < 10; i++) await w.after(MIN);
  assert.equal(w.sent.length, 2);
  assert.equal((await row("a")).unusableAlertAt, null);

  await set("a", "drops_rejected"); // and the next failure is news again
  await w.after(MIN);
  await w.after(WAIT_MS);
  assert.equal(w.sent.length, 3);
  assert.match(w.sent[2], /1 of 3 logins can no longer farm/);
});

test("fixing some of the logins is not announced as a recovery", async () => {
  const w = world();
  await add(["a", "b", "c"], "drops_rejected");
  await w.pass();
  await w.after(WAIT_MS);
  await set(["a", "b"], "ok");
  for (let i = 0; i < 10; i++) await w.after(MIN);
  assert.equal(w.sent.length, 1, "one login is still out: nothing to celebrate, nothing new to report");
});

test("a fresh cookie that is refused as well is reported again, and says so", async () => {
  const w = world();
  await add(["a", "b"], "drops_rejected");
  await w.pass();
  await w.after(WAIT_MS);
  assert.equal(w.sent.length, 1);

  w.at += 30 * MIN;
  // The owner re-imports both; the farm's check right after the import is refused again.
  await set(["a", "b"], "drops_rejected", { cookieAt: new Date(w.at) });
  assert.equal((await w.pass()).sent, null, "a new problem starts a new wait");
  assert.equal((await w.after(WAIT_MS)).sent, "down");
  assert.equal(w.sent.length, 2);
  assert.match(w.sent[1], /imported minutes before — the new cookie does not work either/);
  for (let i = 0; i < 10; i++) await w.after(MIN);
  assert.equal(w.sent.length, 2);
});

test("a later failure names only the new login and counts the ones already reported", async () => {
  const w = world();
  await add(["a", "b", "c", "d"], "ok");
  await set("a", "not_logged_in");
  await w.pass();
  await w.after(WAIT_MS);
  await set("b", "drops_rejected");
  await w.after(MIN);
  await w.after(WAIT_MS);
  assert.equal(w.sent.length, 2);
  assert.match(w.sent[1], /2 of 4 logins can no longer farm/);
  assert.match(w.sent[1], /Refused by the drops site \(1\): b/);
  assert.doesNotMatch(w.sent[1], /Logged out/);
  assert.match(w.sent[1], /1 more reported earlier still need a cookie/);
});

test("sold accounts are not ours to report", async () => {
  const w = world();
  await add("a", "ok");
  await add("gone", "not_logged_in", { sold: true });
  for (let i = 0; i < 20; i++) await w.after(MIN);
  assert.deepEqual(w.sent, []);
});

test("a message that could not be sent is tried again; one that was sent is not repeated when its stamp cannot be saved", async () => {
  let fail = true;
  const w = world();
  w.alert = createLoginAlert({
    send: async (text) => {
      if (fail) throw new Error("telegram is down");
      w.sent.push(text);
    },
    now: () => w.at,
  });
  await add("a", "drops_rejected");
  await w.pass();
  await assert.rejects(w.after(WAIT_MS), /telegram is down/);
  assert.equal((await row("a")).unusableAlertAt, null, "nothing is marked as told");
  fail = false;
  assert.equal((await w.after(MIN)).sent, null, "not hammered: a failed send is followed by a pause");
  assert.equal((await w.after(RETRY_MS)).sent, "down", "then it is delivered");
  assert.equal(w.sent.length, 1);

  // Reads work, writes do not (2026-09-29 looked like this for hours).
  await SoopAccount.deleteMany({});
  await add("b", "drops_rejected");
  const sent = [];
  const t = { at: T0 };
  const readOnly = {
    SoopAccount: {
      find: (...a) => SoopAccount.find(...a),
      updateMany: async () => {
        throw new Error("writes are blocked");
      },
    },
  };
  const logged = [];
  const realError = console.error;
  console.error = (...a) => logged.push(a.join(" "));
  try {
    const blind = createLoginAlert({ models: readOnly, send: async (x) => sent.push(x), now: () => t.at });
    await blind.pass();
    for (let i = 0; i < 20; i++) {
      t.at += MIN;
      await blind.pass();
    }
  } finally {
    console.error = realError;
  }
  assert.equal(sent.length, 1, "told once, on time, from memory alone");
  assert.ok(logged.some((l) => /could not save its stamps/.test(l)), "and the failed write is logged");
});

test("a recovery message that could not be sent is still owed, and is sent once", async () => {
  let fail = false;
  const w = world();
  const notes = [];
  w.alert = createLoginAlert({
    send: async (text) => {
      if (fail) throw new Error("telegram is down");
      w.sent.push(text);
    },
    activity: { add: (e) => notes.push(e) },
    now: () => w.at,
  });
  await add(["a", "b"], "drops_rejected");
  await w.pass();
  await w.after(WAIT_MS);
  assert.equal(w.sent.length, 1);

  await set(["a", "b"], "ok");
  fail = true;
  await assert.rejects(w.after(MIN), /telegram is down/);
  assert.ok((await row("a")).unusableAlertAt, "the stamp that says a message is owed is kept");
  assert.equal(notes.filter((n) => n.level === "warn" && /could not be sent/.test(n.msg)).length, 1, "the activity log says the send failed");
  fail = false;
  assert.equal((await w.after(MIN)).sent, null);
  assert.equal((await w.after(RETRY_MS)).sent, "back");
  assert.match(w.sent[1], /all 2 logins are accepted again/);
  for (let i = 0; i < 10; i++) await w.after(MIN);
  assert.equal(w.sent.length, 2);
  assert.equal((await row("a")).unusableAlertAt, null);
});

// The real sender. On 2026-10-12 the alert's first live message was logged as
// "Telegram error:" with no text and stamped as told. utils/telegram never
// throws; this is what turns "nobody received it" into something the pass sees.
test("the Telegram sender throws when no chat took the message, and only then", async () => {
  const via = (result) => createTelegramSend({ telegram: { sendTelegram: async () => result } });

  await assert.rejects(
    via({ configured: true, chats: 2, sent: 0, failed: 2, reasons: ["AggregateError ETIMEDOUT (ETIMEDOUT+ENETUNREACH)"] })("hello"),
    /none of 2 chat\(s\): AggregateError ETIMEDOUT/,
  );
  // one chat of two is enough: it arrived somewhere, so it is not sent again
  assert.deepEqual(await via({ configured: true, chats: 2, sent: 1, failed: 1, reasons: ["HTTP 403 Forbidden"] })("hello"), { sent: 1, configured: true });
  // Telegram is not set up: nobody to tell, nothing to retry
  assert.deepEqual(await via({ configured: false, chats: 0, sent: 0, failed: 0, reasons: [] })("hello"), { sent: 0, configured: false });
  // a helper that reports nothing (an older utils/telegram) must not turn into a retry loop
  assert.deepEqual(await via(undefined)("hello"), { sent: null, configured: true });
});

test("a send that reaches nobody is retried by the alert until one arrives", async () => {
  const w = world();
  let result = { configured: true, chats: 1, sent: 0, failed: 1, reasons: ["AggregateError ETIMEDOUT"] };
  let posts = 0;
  w.alert = createLoginAlert({
    send: createTelegramSend({ telegram: { sendTelegram: async () => (posts++, result) } }),
    now: () => w.at,
  });
  await add("a", "drops_rejected");
  await w.pass();
  await assert.rejects(w.after(WAIT_MS), /none of 1 chat/);
  assert.equal((await row("a")).unusableAlertAt, null, "not marked as told");
  result = { configured: true, chats: 1, sent: 1, failed: 0, reasons: [] };
  assert.equal((await w.after(RETRY_MS)).sent, "down");
  assert.ok((await row("a")).unusableAlertAt, "told only once Telegram took it");
  assert.equal(posts, 2);
});

test("the timings: a wait long enough to skip a blip, short enough to matter", () => {
  assert.ok(WAIT_MS >= 2 * MIN && WAIT_MS <= 10 * MIN);
  assert.ok(QUIET_MS < WAIT_MS && MAX_WAIT_MS > WAIT_MS && MAX_WAIT_MS <= 30 * MIN);
});
