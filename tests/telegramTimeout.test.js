// utils/telegram: a post that never answers must not hold up whatever awaits
// it. Since 2026-10-11 the auto-farm's structural steps run one at a time
// (utils/farmOps) and several of them await a Telegram message; with no
// deadline, one stalled connection to Telegram stopped every placement and
// clean-up behind it.
const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");

test("every Telegram post carries a deadline", async () => {
  const realPost = axios.post;
  const saved = { token: process.env.TG_TOKEN, chats: process.env.TG_CHAT_IDS };
  process.env.TG_TOKEN = "test-token";
  process.env.TG_CHAT_IDS = "111, 222";
  const calls = [];
  axios.post = async (url, body, config) => {
    calls.push({ chat: body.chat_id, timeout: config && config.timeout });
    return { data: { ok: true } };
  };
  try {
    await require("../utils/telegram").sendTelegram("hello");
  } finally {
    axios.post = realPost;
    if (saved.token === undefined) delete process.env.TG_TOKEN;
    else process.env.TG_TOKEN = saved.token;
    if (saved.chats === undefined) delete process.env.TG_CHAT_IDS;
    else process.env.TG_CHAT_IDS = saved.chats;
  }
  assert.deepEqual(calls.map((c) => c.chat), ["111", "222"]);
  for (const c of calls) {
    assert.ok(Number.isFinite(c.timeout) && c.timeout > 0 && c.timeout <= 30000, "a deadline of at most 30 s, got " + c.timeout);
  }
});
