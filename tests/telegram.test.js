// utils/telegram: an alert must arrive, and when it cannot, someone must be
// able to tell.
//
// In the two weeks to 2026-10-12 nine sends failed on the production server,
// every one logged as "Telegram error:" with nothing after it. The server has
// no IPv6 route; Node gave the IPv4 connect 250 ms and then fell through to
// IPv6, which fails at once, and the result was an AggregateError with an empty
// message. The helper swallowed it and no caller could know. The last of the
// nine was the SOOP login alert's first live message.
//
// No network: axios.post is replaced, the way tests/telegramTimeout.test.js does.
const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");

const telegram = require("../utils/telegram");

const TOKEN = "123456789:SECRET-token_value";

// The error exactly as it was captured on the server (through axios 1.16.1).
function lostConnectRace() {
  const inner = [Object.assign(new Error("connect ETIMEDOUT 149.154.167.220:443"), { code: "ETIMEDOUT" }), Object.assign(new Error("connect ENETUNREACH 2001:67c:4e8:f004::9:443"), { code: "ENETUNREACH" })];
  const cause = Object.assign(new Error(""), { name: "AggregateError", code: "ETIMEDOUT", errors: inner });
  return Object.assign(new Error(""), { name: "AggregateError", code: "ETIMEDOUT", cause, config: { url: `https://api.telegram.org/bot${TOKEN}/sendMessage` } });
}
const refused = (status, description, parameters) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { name: "AxiosError", response: { status, data: { ok: false, error_code: status, description, parameters } } });

// Run `fn` with Telegram configured, axios.post replaced by `post`, no real
// pauses, and the console captured. Everything is put back afterwards.
async function withTelegram({ post, chats = "111", token = TOKEN, timing = {} }, fn) {
  const saved = { post: axios.post, token: process.env.TG_TOKEN, chats: process.env.TG_CHAT_IDS, timing: { ...telegram.TIMING }, error: console.error, log: console.log };
  const calls = [];
  const logs = [];
  axios.post = async (url, body, config) => {
    calls.push({ url, chat: body.chat_id, text: body.text, timeout: config && config.timeout, family: (config && config.family) || null });
    return post(calls.length, body, config);
  };
  if (token === null) delete process.env.TG_TOKEN;
  else process.env.TG_TOKEN = token;
  process.env.TG_CHAT_IDS = chats;
  Object.assign(telegram.TIMING, { pauseMs: 0 }, timing);
  console.error = (...a) => logs.push(a.join(" "));
  console.log = (...a) => logs.push(a.join(" "));
  try {
    return await fn({ calls, logs });
  } finally {
    axios.post = saved.post;
    console.error = saved.error;
    console.log = saved.log;
    Object.assign(telegram.TIMING, saved.timing);
    for (const [key, name] of [["token", "TG_TOKEN"], ["chats", "TG_CHAT_IDS"]]) {
      if (saved[key] === undefined) delete process.env[name];
      else process.env[name] = saved[key];
    }
  }
}

test("REGRESSION: a send that loses Node's connect race is tried again and arrives", async () => {
  await withTelegram({ post: async (n) => { if (n === 1) throw lostConnectRace(); return { data: { ok: true } }; } }, async ({ calls, logs }) => {
    const r = await telegram.sendTelegram("⚠️ an order was not delivered");
    assert.deepEqual(r, { configured: true, chats: 1, sent: 1, failed: 0, reasons: [] });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].text, "⚠️ an order was not delivered", "the retry carries the same message");
    assert.equal(logs.length, 1, "one line says it took a second try, and why");
    assert.match(logs[0], /delivered on try 2 \(before that: AggregateError ETIMEDOUT \(ETIMEDOUT\+ENETUNREACH\)\)/);
  });
});

test("the tries ask for IPv4, where there is no race to lose; the last lets Node choose", async () => {
  await withTelegram({ post: async () => { throw lostConnectRace(); } }, async ({ calls, logs }) => {
    const r = await telegram.sendTelegram("hello");
    assert.deepEqual(calls.map((c) => c.family), [4, 4, null]);
    assert.deepEqual({ sent: r.sent, failed: r.failed, chats: r.chats, configured: r.configured }, { sent: 0, failed: 1, chats: 1, configured: true });
    assert.deepEqual(r.reasons, ["AggregateError ETIMEDOUT (ETIMEDOUT+ENETUNREACH)"]);
    assert.equal(logs.length, 1, "one error line for the chat, not one per try");
    assert.match(logs[0], /^Telegram error: AggregateError ETIMEDOUT \(ETIMEDOUT\+ENETUNREACH\) \(not delivered after 3 tries\)$/);
  });
});

test("a failure is never an empty line, and never carries the bot token", async () => {
  const shapes = [
    lostConnectRace(),
    Object.assign(new Error(""), { name: "AggregateError" }),
    new Error(""),
    Object.assign(new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}/sendMessage`), { code: "ECONNREFUSED" }),
    Object.assign(new Error("timeout of 10000ms exceeded"), { name: "AxiosError", code: "ECONNABORTED" }),
    refused(401, `Unauthorized for bot${TOKEN}`),
    "a string was thrown",
    null,
    undefined,
    { not: "an error" },
  ];
  for (const shape of shapes) {
    await withTelegram({ post: async () => { throw shape; } }, async ({ logs }) => {
      const r = await telegram.sendTelegram("hello");
      assert.equal(r.sent, 0);
      assert.equal(r.reasons.length, 1);
      const said = r.reasons[0] + "\n" + logs.join("\n");
      assert.ok(r.reasons[0].trim().length >= 4, "an empty reason: " + JSON.stringify(r.reasons[0]));
      assert.doesNotMatch(logs[0], /^Telegram error:\s*\(/, "the log line says nothing: " + logs[0]);
      assert.ok(!said.includes(TOKEN) && !said.includes("SECRET"), "the bot token leaked: " + said);
    });
  }
});

test("it never throws, and existing callers can still hang a .catch on it", async () => {
  await withTelegram({ post: async () => { throw lostConnectRace(); } }, async () => {
    const p = telegram.sendTelegram("hello");
    assert.equal(typeof p.catch, "function");
    await assert.doesNotReject(p);
    await assert.doesNotReject(telegram.sendToChat("111", "hello"));
    await assert.doesNotReject(telegram.sendToChatIds(["111"], "hello"));
    await assert.doesNotReject(telegram.sendTelegramToSeller(null, "hello"));
  });
});

test("Telegram's own refusal is an answer: it is reported, not retried", async () => {
  for (const [status, description] of [[400, "Bad Request: chat not found"], [403, "Forbidden: bot was blocked by the user"], [401, "Unauthorized"]]) {
    await withTelegram({ post: async () => { throw refused(status, description); } }, async ({ calls, logs }) => {
      const r = await telegram.sendToChat("111", "hello");
      assert.deepEqual(r, { ok: false, configured: true, tries: 1, reason: `HTTP ${status} ${description}` });
      assert.equal(calls.length, 1);
      assert.match(logs[0], new RegExp(`^Telegram error: HTTP ${status} .* \\(not delivered after 1 try\\)$`));
    });
  }
});

test("a server error or a short 'retry after' is tried again; a long one is not waited out", async () => {
  await withTelegram({ post: async (n) => { if (n === 1) throw refused(502, "Bad Gateway"); return { data: { ok: true } }; } }, async ({ calls }) => {
    assert.equal((await telegram.sendToChat("111", "hello")).ok, true);
    assert.equal(calls.length, 2);
  });
  await withTelegram({ post: async (n) => { if (n === 1) throw refused(429, "Too Many Requests: retry after 0", { retry_after: 0 }); return { data: { ok: true } }; } }, async ({ calls }) => {
    assert.equal((await telegram.sendToChat("111", "hello")).ok, true);
    assert.equal(calls.length, 2);
  });
  await withTelegram({ post: async () => { throw refused(429, "Too Many Requests: retry after 40", { retry_after: 40 }); } }, async ({ calls }) => {
    const t0 = Date.now();
    const r = await telegram.sendToChat("111", "hello");
    assert.equal(r.ok, false);
    assert.equal(calls.length, 1, "a caller is not held for 40 seconds");
    assert.ok(Date.now() - t0 < 1000);
    assert.match(r.reason, /HTTP 429 Too Many Requests: retry after 40/);
  });
});

test("every try has a deadline, and all the tries for a chat share one budget", async () => {
  await withTelegram({ post: async () => { throw lostConnectRace(); } }, async ({ calls }) => {
    await telegram.sendToChat("111", "hello");
    for (const c of calls) assert.ok(Number.isFinite(c.timeout) && c.timeout > 0 && c.timeout <= telegram.TIMING.timeoutMs, "deadline " + c.timeout);
  });
  // A try that hangs to its deadline leaves no room for another: the caller is
  // held for about one deadline, as it was before there were retries.
  const slow = async () => { await new Promise((r) => setTimeout(r, 60)); throw Object.assign(new Error("timeout of 50ms exceeded"), { code: "ECONNABORTED" }); };
  await withTelegram({ post: slow, timing: { timeoutMs: 50, budgetMs: 2050 } }, async ({ calls }) => {
    const r = await telegram.sendToChat("111", "hello");
    assert.equal(calls.length, 1);
    assert.deepEqual({ ok: r.ok, tries: r.tries }, { ok: false, tries: 1 });
  });
  assert.ok(telegram.TIMING.budgetMs <= 30000, "a caller that awaits a send must not be held for long");
});

test("each chat is on its own: one that fails does not stop the next, repeats and blanks are skipped", async () => {
  const post = async (n, body) => { if (body.chat_id === "111") throw refused(403, "Forbidden: bot was blocked by the user"); return { data: { ok: true } }; };
  await withTelegram({ post }, async ({ calls }) => {
    const r = await telegram.sendToChatIds(["111", " 111 ", "", "222", "222"], "hello");
    assert.deepEqual(calls.map((c) => c.chat), ["111", "222"]);
    assert.deepEqual(r, { configured: true, chats: 2, sent: 1, failed: 1, reasons: ["HTTP 403 Forbidden: bot was blocked by the user"] });
  });
  await withTelegram({ post: async () => ({ data: { ok: true } }), chats: "111, 222 ,111" }, async ({ calls }) => {
    const r = await telegram.sendTelegram("hello");
    assert.deepEqual(calls.map((c) => c.chat), ["111", "222"]);
    assert.deepEqual({ sent: r.sent, chats: r.chats }, { sent: 2, chats: 2 });
    assert.deepEqual(calls.map((c) => c.family), [4, 4], "a send that works is one post per chat");
  });
});

test("Telegram not set up: nothing is attempted, and the answer says so rather than 'failed'", async () => {
  for (const off of [{ token: null }, { chats: "" }, { chats: " , " }]) {
    await withTelegram({ post: async () => assert.fail("nothing may be posted"), ...off }, async ({ calls, logs }) => {
      assert.deepEqual(await telegram.sendTelegram("hello"), { configured: false, chats: 0, sent: 0, failed: 0, reasons: [] });
      assert.equal(calls.length, 0);
      assert.deepEqual(logs, []);
    });
  }
  await withTelegram({ post: async () => assert.fail("nothing may be posted") }, async () => {
    assert.deepEqual(await telegram.sendToChat("", "hello"), { ok: false, configured: false, tries: 0, reason: null });
  });
});
