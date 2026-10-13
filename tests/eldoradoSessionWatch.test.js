// Eldorado ends a seller login 30 days after sign-in and no refresh can move
// that. On 2026-10-02 the stored login reached the limit, every call answered
// 403 and orders stopped until a fresh cookie was pasted — with no warning
// before it. utils/eldoradoSessionWatch reads the sign-in time out of the
// stored cookie (a local decode, never a call to Eldorado) and says so ahead.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const watch = require("../utils/eldoradoSessionWatch");

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const SIGNED_IN = Date.UTC(2026, 8, 28, 1, 30, 0); // 2026-09-28T01:30:00Z
const LIMIT = SIGNED_IN + 30 * DAY; // 2026-10-28T01:30:00Z = 10:30 JST

function jwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return b64({ alg: "RS256", kid: "k" }) + "." + b64(payload) + ".sig";
}
function cookieFor(authMs) {
  return (
    "_ga=GA1.1.1; cf_clearance=abc; __Host-XSRF-TOKEN=x; " +
    "__Host-EldoradoIdToken=" + jwt({ sub: "u", auth_time: Math.floor(authMs / 1000), exp: 1 }) +
    "; __Host-EldoradoRefreshToken=opaque.jwe.value; forterToken=f"
  );
}

// One "server": the events it wrote survive a restart (watch._reset()), the
// way SystemEvent rows do.
function world({ authMs = SIGNED_IN, now = SIGNED_IN + DAY } = {}) {
  const w = {
    now,
    cookie: cookieFor(authMs),
    af: {},
    events: [],
    unreadableAt: 0,
    sent: [],
    reply: { configured: true, sent: 1, failed: 0 },
    restart() {
      watch._reset();
      wire();
    },
  };
  function wire() {
    watch.__setDeps({
      now: () => w.now,
      autoFarm: () => w.af,
      cookie: () => w.cookie,
      sentStages: async (a) =>
        new Set(w.events.filter((e) => e.action === "eldorado_login_reminder" && e.authTime === a).map((e) => e.stage)),
      lastSeenAuth: async () => (w.events.length ? w.events[w.events.length - 1].authTime : null),
      record: async (action, authTime, stage) => {
        w.events.push({ action, authTime, stage });
      },
      lastUnreadableAt: async () => w.unreadableAt,
      recordUnreadable: async () => {
        w.unreadableAt = w.now;
      },
      send: async (text) => {
        w.sent.push(text);
        return w.reply;
      },
    });
  }
  w.restart();
  return w;
}

test("the sign-in time is read out of the stored cookie, and nothing else is", () => {
  assert.equal(watch.authTimeMs(cookieFor(SIGNED_IN)), SIGNED_IN);
  assert.equal(watch.limitMs(SIGNED_IN), LIMIT);
  assert.equal(watch.authTimeMs(""), null);
  assert.equal(watch.authTimeMs(null), null);
  assert.equal(watch.authTimeMs("a=b; c=d"), null, "no id token in the jar");
  assert.equal(watch.authTimeMs("__Host-EldoradoIdToken=not-a-jwt"), null);
  assert.equal(watch.authTimeMs("__Host-EldoradoIdToken=a.%%%.c"), null, "a payload that is not JSON");
  assert.equal(watch.authTimeMs("__Host-EldoradoIdToken=" + jwt({ sub: "u" })), null, "no auth_time claim");
  assert.equal(watch.authTimeMs("__Host-EldoradoIdToken=" + jwt({ auth_time: "soon" })), null);
  assert.equal(
    watch.authTimeMs("x__Host-EldoradoIdToken=" + jwt({ auth_time: 5 })),
    null,
    "another cookie whose name merely ends the same way is not the id token",
  );
});

test("stages: nothing above 5 days, then the most urgent one reached", () => {
  const key = (ms) => (watch.stageFor(ms) || {}).key || null;
  assert.equal(key(30 * DAY), null);
  assert.equal(key(5 * DAY + 1), null);
  assert.equal(key(5 * DAY), "5d");
  assert.equal(key(4 * DAY), "5d");
  assert.equal(key(2 * DAY), "2d");
  assert.equal(key(36 * HOUR), "2d");
  assert.equal(key(24 * HOUR), "1d");
  assert.equal(key(7 * HOUR), "1d");
  assert.equal(key(6 * HOUR), "6h");
  assert.equal(key(60 * 1000), "6h");
  assert.equal(key(0), "expired");
  assert.equal(key(-5 * DAY), "expired");
  assert.equal(key(NaN), null);
});

test("a login with weeks left says nothing — the first look only records what it found", async () => {
  const w = world({ now: SIGNED_IN + 10 * DAY });
  const r = await watch.check();
  assert.equal(r.ok, true);
  assert.equal(r.stage, null);
  assert.equal(r.limit, LIMIT);
  assert.deepEqual(w.sent, []);
  assert.deepEqual(w.events, [{ action: "eldorado_login_seen", authTime: SIGNED_IN, stage: "" }]);
  await watch.check();
  assert.equal(w.events.length, 1, "the first look is recorded once");
});

test("REGRESSION: 5 days before the limit the owner is told — once, also across restarts", async () => {
  const w = world({ now: LIMIT - 5 * DAY });
  await watch.check();
  assert.equal(w.sent.length, 1);
  assert.match(w.sent[0], /Eldorado login expires in 5 days — 28 Oct, 10:30 JST/);
  assert.match(w.sent[0], /Listings → Marketplace keys → Eldorado/);
  w.now += 30 * 60 * 1000;
  await watch.check();
  assert.equal(w.sent.length, 1, "not again half an hour later");
  for (let i = 0; i < 5; i++) {
    w.restart(); // this server restarts several times a day
    w.now += 60 * 60 * 1000;
    await watch.check();
  }
  assert.equal(w.sent.length, 1, "a restart does not repeat a stage that was already sent");
});

test("each stage is sent exactly once on the way down, and then that the limit has passed", async () => {
  const w = world({ now: LIMIT - 6 * DAY });
  const at = async (left) => {
    w.now = LIMIT - left;
    await watch.check();
    await watch.check();
  };
  await at(6 * DAY);
  assert.equal(w.sent.length, 0);
  await at(5 * DAY - 1000);
  await at(3 * DAY);
  assert.equal(w.sent.length, 1, "still the 5-day stage at 3 days");
  await at(47 * HOUR);
  assert.match(w.sent[1], /expires in 47 hours — /);
  await at(23 * HOUR);
  assert.match(w.sent[2], /expires in 23 hours — /);
  await at(5 * HOUR);
  assert.match(w.sent[3], /expires in 5 hours — /);
  await at(-60 * 1000);
  assert.equal(w.sent.length, 5);
  assert.match(w.sent[4], /reached its 30-day limit \(28 Oct, 10:30 JST\)/);
  assert.match(w.sent[4], /orders are not delivered/);
  await at(-3 * DAY);
  assert.equal(w.sent.length, 5, "the limit having passed is said once");
  assert.deepEqual(
    w.events.filter((e) => e.action === "eldorado_login_reminder").map((e) => e.stage),
    ["5d", "2d", "1d", "6h", "expired"],
  );
});

test("a server that was down across two stages sends the one that matters now, not three", async () => {
  const w = world({ now: LIMIT - 6 * DAY });
  await watch.check();
  w.restart();
  w.now = LIMIT - 20 * HOUR;
  await watch.check();
  assert.equal(w.sent.length, 1);
  assert.match(w.sent[0], /expires in 20 hours/);
});

test("a message Telegram did not take is not recorded, so the next tick sends it again", async () => {
  const w = world({ now: LIMIT - 2 * DAY });
  w.reply = { configured: true, sent: 0, failed: 1, reasons: ["ETIMEDOUT"] };
  await watch.check();
  assert.equal(w.sent.length, 1);
  assert.equal(w.events.filter((e) => e.action === "eldorado_login_reminder").length, 0);
  w.reply = { configured: true, sent: 1, failed: 0 };
  w.now += 30 * 60 * 1000;
  await watch.check();
  assert.equal(w.sent.length, 2, "tried again");
  await watch.check();
  assert.equal(w.sent.length, 2, "and once it went, not a third time");
});

test("with no Telegram chat set up there is nothing to retry", async () => {
  const w = world({ now: LIMIT - 2 * DAY });
  w.reply = { configured: false, chats: 0, sent: 0, failed: 0 };
  await watch.check();
  await watch.check();
  assert.equal(w.sent.length, 1);
});

test("a stage is not repeated every tick when its record cannot be written", async () => {
  const w = world({ now: LIMIT - 10 * DAY });
  await watch.check(); // first look recorded, nothing to say yet
  watch.__setDeps({
    record: async () => {
      throw new Error("mongo is down");
    },
    sentStages: async () => new Set(),
  });
  w.now = LIMIT - 2 * DAY;
  await assert.rejects(() => watch.check(), /mongo is down/);
  assert.equal(w.sent.length, 1);
  await watch.check();
  await watch.check();
  assert.equal(w.sent.length, 1, "this process remembers what it sent");
});

test("a fresh cookie is confirmed with the date it lasts to, and the stages start over", async () => {
  const w = world({ now: LIMIT - 5 * DAY });
  await watch.check();
  assert.equal(w.sent.length, 1, "the old login's 5-day reminder");

  const fresh = LIMIT - 5 * DAY + HOUR; // signed in an hour after the reminder
  w.cookie = cookieFor(fresh);
  w.now = fresh + 10 * 60 * 1000;
  await watch.check();
  assert.equal(w.sent.length, 2);
  assert.match(w.sent[1], /^✅ Eldorado login updated — good until 22 Nov, \d\d:\d\d JST \(30 days\)\.$/);
  await watch.check();
  w.restart();
  await watch.check();
  assert.equal(w.sent.length, 2, "one line per paste");

  w.now = fresh + 25 * DAY;
  await watch.check();
  assert.equal(w.sent.length, 3, "the new login gets its own 5-day reminder");
  assert.match(w.sent[2], /expires in 5 days/);
});

test("a cookie from a browser that signed in weeks ago is called out, in one message", async () => {
  const w = world({ now: LIMIT - 6 * DAY });
  await watch.check();
  const old = w.now - 26 * DAY; // that browser signed in 26 days ago
  w.cookie = cookieFor(old);
  w.now += 60 * 1000;
  const r = await watch.check();
  assert.deepEqual(r.sent, ["new-login"]);
  assert.equal(w.sent.length, 1);
  assert.match(w.sent[0], /^⚠️ Eldorado login updated, but it only lasts until .* \(4 days\)/);
  assert.match(w.sent[0], /sign in again/);
  await watch.check();
  assert.equal(w.sent.length, 1, "the 5-day stage it is already in is not sent on top");
  w.now = old + 30 * DAY - 40 * HOUR;
  await watch.check();
  assert.equal(w.sent.length, 2, "the next stage still comes");
  assert.match(w.sent[1], /expires in 40 hours/);
});

test("time left is said to the nearest unit, in hours under two days", () => {
  const left = (ms) => watch.reminderText(watch.stageFor(ms), SIGNED_IN, LIMIT - ms).match(/expires in ([^—]+) —/)[1];
  assert.equal(left(5 * DAY - 15 * 60 * 1000), "5 days", "the first tick after the 5-day line");
  assert.equal(left(2 * DAY), "2 days");
  assert.equal(left(2 * DAY - 20 * 60 * 1000), "48 hours");
  assert.equal(left(DAY), "24 hours");
  assert.equal(left(6 * HOUR - 10 * 60 * 1000), "6 hours");
  assert.equal(left(80 * 60 * 1000), "80 minutes");
  assert.equal(left(20 * 1000), "1 minute");
});

test("a pasted cookie that is already past its limit says so", () => {
  const text = watch.newLoginText(SIGNED_IN, LIMIT + HOUR);
  assert.match(text, /already past its 30-day limit/);
});

test("switched off, unset or unreadable settings: silent, and never a throw", async () => {
  const w = world({ now: LIMIT - DAY });
  w.af = { eldoradoLoginReminder: false };
  assert.deepEqual(await watch.check(), { skipped: "off" });
  w.af = {};
  w.cookie = "";
  assert.deepEqual(await watch.check(), { skipped: "not configured" });
  watch.__setDeps({
    cookie: () => {
      throw new Error("settings.json is damaged");
    },
  });
  assert.match((await watch.check()).skipped, /could not be read: settings\.json is damaged/);
  assert.deepEqual(w.sent, []);
  assert.deepEqual(w.events, []);
});

test("REGRESSION: a stored cookie whose sign-in time cannot be read is said — once a week, not kept to the log", async () => {
  // No reminder can ever fire for such a cookie, and the owner would go on
  // believing he will be warned.
  const w = world({ now: LIMIT - DAY });
  w.cookie = "cf_clearance=abc; __Host-XSRF-TOKEN=x; __Host-EldoradoIdToken=opaque-not-a-jwt";
  const r = await watch.check();
  assert.deepEqual(r, { skipped: "no sign-in time in the stored cookie", sent: ["unreadable"] });
  assert.equal(w.sent.length, 1);
  assert.match(w.sent[0], /no readable sign-in time, so nothing can warn before the 30-day limit/);
  assert.deepEqual(w.events, [], "no stage is recorded for a login that could not be read");

  for (let i = 0; i < 4; i++) {
    w.now += 30 * 60 * 1000;
    w.restart();
    assert.deepEqual(await watch.check(), { skipped: "no sign-in time in the stored cookie" });
  }
  assert.equal(w.sent.length, 1, "not every tick, and not after every restart");
  w.now += 7 * DAY;
  await watch.check();
  assert.equal(w.sent.length, 2, "again a week later while it lasts");

  // Not taken by Telegram = not said: the next tick says it.
  const w2 = world({ now: LIMIT - DAY });
  w2.cookie = "__Host-XSRF-TOKEN=x";
  w2.reply = { configured: true, sent: 0, failed: 1 };
  await watch.check();
  assert.equal(w2.unreadableAt, 0);
  w2.reply = { configured: true, sent: 1, failed: 0 };
  await watch.check();
  assert.equal(w2.sent.length, 2);
  assert.equal(w2.unreadableAt, w2.now);
});

test("the unreadable-cookie notice does not repeat every tick when it cannot be recorded", async () => {
  const w = world({ now: LIMIT - DAY });
  w.cookie = "__Host-XSRF-TOKEN=x";
  watch.__setDeps({
    recordUnreadable: async () => {
      throw new Error("mongo is down");
    },
  });
  for (let i = 0; i < 4; i++) {
    await watch.check();
    w.now += 30 * 60 * 1000;
  }
  assert.equal(w.sent.length, 1, "this process remembers that it said it");
});

test("REGRESSION: going back to an older cookie and forward again is confirmed every time", async () => {
  const A = SIGNED_IN;
  const B = SIGNED_IN + 3 * DAY;
  const w = world({ authMs: A, now: B + HOUR });
  await watch.check(); // first look at A
  const paste = async (auth) => {
    w.cookie = cookieFor(auth);
    w.now += 10 * 60 * 1000;
    const r = await watch.check();
    await watch.check(); // the next tick says nothing more
    return r.sent;
  };
  assert.deepEqual(await paste(B), ["new-login"]);
  assert.deepEqual(await paste(A), ["new-login"]);
  assert.deepEqual(await paste(B), ["new-login"], "the same process had confirmed B before — it still says so now");
  assert.equal(w.sent.length, 3);
});

test("the reminder has no way to call Eldorado", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "utils", "eldoradoSessionWatch.js"), "utf8");
  const required = [...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(
    [...new Set(required)],
    ["../models/SystemEvent", "./secretBox", "./settings", "./telegram"],
    "no marketplace client and no HTTP library: a login check that calls Eldorado can spend the session",
  );
  // Nor any way round a require: no computed require, no global HTTP client.
  const code = src
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
  assert.equal((code.match(/\brequire\(/g) || []).length, required.length, "every require names its module literally");
  assert.doesNotMatch(code, /\bfetch\s*\(|XMLHttpRequest|WebSocket|\bimport\s*\(|child_process|\beval\s*\(|process\.binding/);
  assert.doesNotMatch(code, /eldorado\.gg\/api|https?:\/\/[^\s"']*eldorado/i, "no Eldorado address to call");
  // Nothing in it writes the stored session either.
  assert.doesNotMatch(code, /setKeys|saveSettings|updateSettings|setAutoFarm|writeFile/);
});
