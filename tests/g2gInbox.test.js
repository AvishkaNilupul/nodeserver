// G2G buyer chats in the complaint sweep (2026-10-01). utils/g2gInbox reads our
// SendBird DMs READ-ONLY for scripts/complaint-sweep.js: it never sends, never
// marks a channel read, never refreshes the 15-minute G2G token, and masks
// passwords before a transcript can reach support-sweeps/. SendBird, G2G,
// settings and the clock are faked; nothing touches the network.
const test = require("node:test");
const assert = require("node:assert/strict");
const inbox = require("../utils/g2gInbox");

const SELLER = "5700688";
const NOW = Date.UTC(2026, 9, 1, 12, 0);
const jwt = (expMs) =>
  "h." + Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000) })).toString("base64") + ".s";
const FRESH = jwt(NOW + 14 * 60000);
const decrypt = (v) => String(v).replace(/^enc:/, "");
const settingsWith = (token) => () => ({
  marketplaces: { g2g: { accessToken: "enc:" + token, userId: "enc:" + SELLER } },
});

function fakeHttp(respond) {
  const calls = [];
  return {
    calls,
    post: async (url, body, cfg) => {
      calls.push({ url, body, headers: cfg.headers });
      return respond({ url, body });
    },
  };
}
const sessionOk = () => ({ data: { code: 2000, payload: { session_tokens: [{ session_token: "sess-1" }] } } });

let nextId = 100;
function msg(who, minutesAgo, text, extra = {}) {
  return {
    messageId: nextId++,
    createdAt: NOW - minutesAgo * 60000,
    messageType: "user",
    message: text,
    sender: who === "system" ? null : { userId: who === "us" ? SELLER : extra.from || "1001" },
    ...extra,
  };
}
function channel({ url, other = "1001", nick = "buyer1", messages, customType = "dm", memberCount = 2, isSuper = false }) {
  const c = {
    url,
    customType,
    memberCount,
    isSuper,
    isBroadcast: false,
    members: [{ userId: SELLER }, { userId: other, nickname: nick }],
    lastMessage: messages[messages.length - 1],
    unreadMessageCount: 3,
    marked: 0,
    markAsRead: async () => {
      c.marked++;
    },
    createPreviousMessageListQuery: ({ limit }) => ({ load: async () => messages.slice(-limit) }),
  };
  return c;
}
function fakeSendbird(channels) {
  const log = { built: 0, connected: null, disconnected: 0, query: null };
  const factory = () => {
    log.built++;
    return {
      connect: async (id, token) => {
        log.connected = [id, token];
      },
      disconnect: async () => {
        log.disconnected++;
      },
      groupChannel: {
        createMyGroupChannelListQuery: (params) => {
          log.query = params;
          return { next: async () => channels };
        },
      },
    };
  };
  return { log, factory };
}

test("passwords are masked in every shape we send; prose, URLs and order ids survive", () => {
  const cases = [
    ["TWITCH DROP ACCOUNT Username: maroll6jcol Password: Xy8#k2!aa HOW TO CLAIM", "TWITCH DROP ACCOUNT Username: maroll6jcol Password: *** HOW TO CLAIM"],
    ["**Username:** 5388yrgq **Password:** nyxgmmbqytja8865 ### How to Claim", "**Username:** 5388yrgq **Password: *** ### How to Claim"],
    ["Password: *** HOW TO CLAIM", "Password: *** HOW TO CLAIM"],
    ["Login: Cameron64Skinner49 Password: Aa1!bb2@", "Login: Cameron64Skinner49 Password: ***"],
    ["coolbladelive52290:Qw3rty!9 plase link the account", "coolbladelive52290:*** plase link the account"],
    ["pass = hunter22", "pass: ***"],
    ["PW - abc12345 thanks", "PW: *** thanks"],
    ["Please do not change the account's password or email", "Please do not change the account's password or email"],
    ["pass-through is fine", "pass-through is fine"],
    ["https://www.g2g.com/g2g-user/sale/order/item/1789989042734V2P8-1", "https://www.g2g.com/g2g-user/sale/order/item/1789989042734V2P8-1"],
    ["Order 1790705383264O9BE-1 at 10:30", "Order 1790705383264O9BE-1 at 10:30"],
  ];
  for (const [input, want] of cases) assert.equal(inbox.maskSecrets(input), want, input);
});

test("only private DMs active in the window are read; nothing is marked read, the session always closes", async () => {
  const delivery = msg("us", 300, "Order 1790705383264O9BE-1\n\nTWITCH DROP ACCOUNT\n\nUsername: maroll6jcol\nPassword: Secret#123\n\nHOW TO CLAIM");
  const waiting = channel({ url: "g2g_dm_5700688_1001", messages: [delivery, msg("them", 120, "same account"), msg("them", 119, "give me a new one")] });
  const answered = channel({ url: "g2g_dm_5700688_1002", other: "1002", messages: [msg("them", 60, "is this available?", { from: "1002" }), msg("us", 30, "yes")] });
  // A supergroup reporting 2 members still never qualifies: isSuper alone rules it out.
  const supergroup = channel({ url: "g2g_sg_seller_game_items-2", messages: [msg("them", 5, "hello all")], isSuper: true, memberCount: 2 });
  const threeWay = channel({ url: "g2g_dm_x", messages: [msg("them", 5, "hi")], memberCount: 3 });
  const notDm = channel({ url: "g2g_other", messages: [msg("them", 5, "hi")], customType: "" });
  const old = channel({ url: "g2g_dm_5700688_1003", other: "1003", messages: [msg("them", 20 * 24 * 60, "hello?", { from: "1003" })] });
  const all = [waiting, answered, supergroup, threeWay, notDm, old];
  const sb = fakeSendbird(all);
  const http = fakeHttp(sessionOk);

  const r = await inbox.readG2gInbox({
    deps: { loadSettings: settingsWith(FRESH), decrypt, http, sendbird: sb.factory, clock: () => NOW, sleep: async () => {} },
  });

  assert.equal(r.status, "ok", r.detail);
  assert.deepEqual(r.threads.map((t) => t.channelUrl), ["g2g_dm_5700688_1001", "g2g_dm_5700688_1002"]);
  const t = r.threads[0];
  assert.equal(t.buyerId, "1001");
  assert.deepEqual(t.messages.map((m) => m.who), ["seller", "buyer", "buyer"]);
  assert.ok(!JSON.stringify(r).includes("Secret#123"), "the delivered password never leaves the module");
  assert.match(t.messages[0].text, /Password: \*\*\*/);

  // G2G: one chat-profile call with the stored token, RAW (no "Bearer").
  assert.equal(http.calls.length, 1);
  assert.match(http.calls[0].url, /\/chat\/user$/);
  assert.equal(http.calls[0].headers.authorization, FRESH);
  assert.deepEqual(http.calls[0].body, { user_id: SELLER });
  // SendBird: our session, DMs only, read-only, closed.
  assert.deepEqual(sb.log.connected, [SELLER, "sess-1"]);
  assert.deepEqual(sb.log.query.customTypesFilter, ["dm"]);
  assert.equal(sb.log.disconnected, 1);
  assert.equal(all.reduce((n, c) => n + c.marked, 0), 0, "no channel is ever marked read");
});

test("a token G2G refuses is a stale source, never refreshed, and SendBird is not touched", async () => {
  const sb = fakeSendbird([]);
  const http = fakeHttp(() => {
    const e = new Error("Request failed with status code 401");
    e.response = { status: 401 };
    throw e;
  });
  const r = await inbox.readG2gInbox({
    deps: { loadSettings: settingsWith(FRESH), decrypt, http, sendbird: sb.factory, clock: () => NOW, sleep: async () => {} },
  });
  assert.equal(r.status, "stale");
  assert.match(r.detail, /401/);
  assert.equal(http.calls.length, 1, "no refresh call, no retry");
  assert.equal(sb.log.built, 0);
});

test("a token about to expire waits for the server's renewal; one never renewed is stale with no call at all", async () => {
  // Renewed on the third read of settings.
  let t = NOW;
  let reads = 0;
  const sleeps = [];
  const renewing = () => {
    reads++;
    return settingsWith(reads < 3 ? jwt(NOW + 30000) : jwt(t + 14 * 60000))();
  };
  const http = fakeHttp(sessionOk);
  const sb = fakeSendbird([]);
  const r = await inbox.readG2gInbox({
    deps: {
      loadSettings: renewing,
      decrypt,
      http,
      sendbird: sb.factory,
      clock: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
    },
  });
  assert.equal(r.status, "ok", r.detail);
  assert.equal(sleeps.length, 2);
  assert.equal(http.calls[0].headers.authorization, jwt(t + 14 * 60000), "the renewed token is the one used");

  // Never renewed inside the wait.
  t = NOW;
  const http2 = fakeHttp(sessionOk);
  const sb2 = fakeSendbird([]);
  const r2 = await inbox.readG2gInbox({
    waitMs: 30000,
    deps: {
      loadSettings: settingsWith(jwt(NOW + 20000)),
      decrypt,
      http: http2,
      sendbird: sb2.factory,
      clock: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    },
  });
  assert.equal(r2.status, "stale");
  assert.match(r2.detail, /not refreshed here on purpose/);
  assert.equal(http2.calls.length, 0);
  assert.equal(sb2.log.built, 0);
});

// threadItem works on what readG2gInbox returns.
let mid = 1;
const line = (who, minutesAgo, text) => ({ id: String(mid++), who, at: new Date(NOW - minutesAgo * 60000).toISOString(), text });
const thread = (messages, extra = {}) => ({ channelUrl: "g2g_dm_5700688_1001", buyerId: "1001", buyer: "Sinxty", unread: 2, messages, ...extra });

test("the buyer who spoke last is an item, loud by age; we or the system speaking last is not", () => {
  const delivered = line("seller", 300, "Order 1790705383264O9BE-1 === ACCOUNT 1 of 2 === TWITCH DROP ACCOUNT Username: maroly2pq28 Password: ***");
  const msgs = [delivered, line("buyer", 120, "same account"), line("buyer", 119, "give me a new one")];
  const it = inbox.threadItem(thread(msgs), { now: NOW });
  assert.equal(it.key, "g2g:thread:g2g_dm_5700688_1001:" + msgs[2].id);
  assert.equal(it.platform, "g2g");
  assert.equal(it.kind, "buyer-message");
  assert.equal(it.severity, "urgent");
  assert.equal(it.body, "same account\ngive me a new one", "only the unanswered run");
  assert.deepEqual(it.meta.orderIds, ["1790705383264O9BE-1"]);
  assert.equal(it.meta.afterDelivery, true);
  assert.equal(it.subject, "buyer waiting — Sinxty — order 1790705383264O9BE-1 (2h)");
  assert.equal(it.meta.transcript.length, 3);

  const aged = (minutes) => inbox.threadItem(thread([line("buyer", minutes, "hello?")]), { now: NOW }).severity;
  assert.equal(aged(50 * 60), "warn");
  assert.equal(aged(200 * 60), "info");

  assert.equal(inbox.threadItem(thread([line("buyer", 60, "hi"), line("seller", 30, "hey")]), { now: NOW }), null);
  assert.equal(inbox.threadItem(thread([line("buyer", 60, "hi"), line("system", 30, "notice")]), { now: NOW }), null);
  assert.equal(inbox.threadItem(thread([]), { now: NOW }), null);
});

test("spam and threads where WE are the buyer are kept, but quiet", () => {
  const spam = inbox.threadItem(
    thread([line("buyer", 60, "Hi Avishka_ReX, Top new games on G2G (~15,776 est. monthly sales) rmt hub.com/en/g2g (remove all spaces in the link)")]),
    { now: NOW },
  );
  assert.equal(spam.severity, "info");
  assert.equal(spam.meta.spam, true);
  assert.match(spam.subject, /^\(spam\?\) /);

  const theirSale = inbox.threadItem(
    thread([
      line("buyer", 70, "Initiate chat via Sold Order Item 1789989042734V2P8-1 https://www.g2g.com/g2g-user/sale/order/item/1789989042734V2P8-1"),
      line("buyer", 69, "your order is unpaid order."),
    ]),
    { now: NOW },
  );
  assert.equal(theirSale.severity, "info");
  assert.equal(theirSale.meta.weAreBuyer, true);
  assert.match(theirSale.subject, /^\(we are the buyer\) /);

  const confirmNudge = inbox.threadItem(thread([line("seller", 80, "how long it takes to deliver"), line("buyer", 70, "Don’t forget to confirm your order, my friend")]), { now: NOW });
  assert.equal(confirmNudge.meta.weAreBuyer, true);
  assert.equal(confirmNudge.severity, "info");

  // A real buyer asking about an offer is neither.
  const real = inbox.threadItem(thread([line("buyer", 60, "Initiate chat via Offer G1788852725944IN https://www.g2g.com/categories/brawlhalla-items/offer/G1788852725944IN"), line("buyer", 59, "Hello, is this available?")]), { now: NOW });
  assert.equal(real.severity, "urgent");
  assert.equal(real.meta.spam, false);
  assert.equal(real.meta.weAreBuyer, false);
  assert.deepEqual(real.meta.offerIds, ["G1788852725944IN"]);
});

test("a buyer writing again after we answered is a NEW sweep item", () => {
  const first = [line("buyer", 300, "hello")];
  const k1 = inbox.threadItem(thread(first), { now: NOW }).key;
  const again = [...first, line("seller", 200, "hi, how can I help?"), line("buyer", 10, "it still doesn't work")];
  const it2 = inbox.threadItem(thread(again), { now: NOW });
  assert.notEqual(it2.key, k1);
  assert.equal(it2.body, "it still doesn't work");
});
