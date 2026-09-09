// Why automatic G2G delivery had never once worked, and the two separate
// defects behind it.
//
// Order 1788892037419NTQU (Rocket League Twitch Drops, $2.18) sat reserved but
// unsent. The SDK was installed, the seller session was valid, a SendBird
// channel with the buyer existed — and the fulfiller reported, every 60 seconds,
// "waiting for the operator to hand the credential over in G2G chat".
//
// 1. The SendBird SDK is a BROWSER library: it opens its realtime connection
//    with a bare `new WebSocket(...)` off the global. Node exposes a global
//    WebSocket only from v22 and prod runs v20.20.2, so connect() threw
//    "WebSocket is not defined" on every attempt. `ws` was already present in
//    node_modules — undeclared, hoisted, depended on by nothing, one `npm prune`
//    from vanishing.
// 2. Even with the SDK working, the order could never recover. The send lives in
//    the stock-picking path, and once units are reserved the function returns
//    early — above it. So a first send that failed parked the order forever.
//
// Both had to be fixed: the polyfill alone leaves the stuck order stuck.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const CHAT = fs.readFileSync(
  path.join(__dirname, "..", "utils", "g2gChat.js"),
  "utf8",
);
const FULFILLER = fs.readFileSync(
  path.join(__dirname, "..", "utils", "g2gFulfiller.js"),
  "utf8",
);

/* ----------------------------- the polyfill ------------------------------ */

test("REGRESSION: a WebSocket is provided for the SendBird SDK", () => {
  assert.match(CHAT, /function ensureWebSocket\(\)/);
  assert.match(CHAT, /globalThis\.WebSocket = require\("ws"\)/);
});

test("a native WebSocket is never overwritten", () => {
  // Node 22+ ships one. Clobbering it with `ws` would swap a maintained
  // implementation for a shim for no reason.
  const fn = CHAT.slice(
    CHAT.indexOf("function ensureWebSocket()"),
    CHAT.indexOf("// Mint a SendBird session token"),
  );
  assert.match(
    fn,
    /if \(typeof globalThis\.WebSocket !== "undefined"\) return true;/,
    "must return early when a global WebSocket already exists",
  );
  assert.ok(
    fn.indexOf('typeof globalThis.WebSocket !== "undefined"') <
      fn.indexOf('globalThis.WebSocket = require("ws")'),
    "the guard must come before the assignment",
  );
});

test("ensureWebSocket actually works in this Node", async () => {
  // The only assertion here that touches reality rather than source text.
  const chat = require("../utils/g2gChat");
  assert.strictEqual(chat.ensureWebSocket(), true);
  assert.notStrictEqual(typeof globalThis.WebSocket, "undefined");
});

test("a missing WebSocket is 'unavailable', not a mystery send failure", () => {
  // The distinction decides behaviour: `__g2gChatUnavailable` makes the
  // fulfiller hand the credential to the operator over Telegram. Without the
  // flag it took the generic branch and recorded
  // "chat send failed: WebSocket is not defined", which reads like a network
  // fault and tells nobody what to do about it.
  const block = CHAT.slice(CHAT.indexOf("if (!ensureWebSocket())"));
  assert.match(block.slice(0, 600), /__g2gChatUnavailable = true/);
});

test("canSend means the SDK AND something to run it over", () => {
  // `sdkAvailable()` alone was TRUE on this host the entire time delivery was
  // broken, so anything gating on it was asking the wrong question.
  assert.match(CHAT, /canSend: \(\) => sdkAvailable\(\) && ensureWebSocket\(\)/);
});

/* ------------------------------- the retry ------------------------------- */

test("REGRESSION: a reserved-but-unsent order retries the send", () => {
  // Without this the order is parked forever: the send is further down, in the
  // stock-picking path, and the reserved-units branch returns before reaching it.
  const branch = FULFILLER.slice(
    FULFILLER.indexOf("// Reserved, but nothing has reached the buyer"),
    FULFILLER.indexOf("const stock = await pickStock"),
  );
  assert.match(branch, /chat\.canSend\(\)/, "must check whether chat can send now");
  assert.match(branch, /chat\.sendToBuyer\(/, "must actually retry the send");
  assert.match(branch, /source: "retry-send"/);
});

test("the retry re-reads credentials rather than trusting the reserved copy", () => {
  // Same rule the first attempt follows: a password can have been rotated since
  // the unit was reserved, and shipping a stale one is a silent dud delivery.
  const branch = FULFILLER.slice(
    FULFILLER.indexOf("// Reserved, but nothing has reached the buyer"),
    FULFILLER.indexOf("const stock = await pickStock"),
  );
  assert.match(branch, /credentialsFor\(/);
  assert.match(branch, /no readable/i, "an unreadable password must stop the re-send");
});

test("a failed retry keeps the units on THIS order", () => {
  // Releasing them would let the next order spend the same stock, and the buyer
  // who already paid would be served an account that has gone somewhere else.
  const branch = FULFILLER.slice(
    FULFILLER.indexOf("// Reserved, but nothing has reached the buyer"),
    FULFILLER.indexOf("const stock = await pickStock"),
  );
  assert.match(branch, /chat re-send failed/);
  assert.doesNotMatch(branch, /releaseAccounts/, "a failed re-send must not release stock");
});

test("the retry never runs in a dry run", () => {
  const branch = FULFILLER.slice(
    FULFILLER.indexOf("// Reserved, but nothing has reached the buyer"),
    FULFILLER.indexOf("const stock = await pickStock"),
  );
  assert.match(branch, /if \(!dryRun && chat\.canSend/);
});

test("the operator fallback survives when chat genuinely cannot send", () => {
  // The retry must not delete the parked path — when there is no SDK and no
  // WebSocket, handing the credential to the operator is still the right answer.
  const branch = FULFILLER.slice(
    FULFILLER.indexOf("// Reserved, but nothing has reached the buyer"),
    FULFILLER.indexOf("const stock = await pickStock"),
  );
  assert.match(branch, /pending: mine\.length/);
  assert.match(branch, /waiting for the operator/);
});

test("`ws` is a declared dependency, not a hoisted accident", () => {
  // It was present in node_modules while nothing depended on it: `npm ls ws`
  // reported "(empty)". One prune and delivery breaks again with an error that
  // points at SendBird rather than at a missing package.
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
  );
  assert.ok(
    pkg.dependencies && pkg.dependencies.ws,
    "add ws to dependencies — utils/g2gChat.js requires it directly",
  );
});

/* --------------------- resolving the actual password --------------------- */

test("REGRESSION: credentialsFor reads credPassword, not password", () => {
  // BotAccount stores the sellable credential in `credPassword`; `password` is a
  // different field and is empty on real stock. Reading the wrong one made a
  // re-send report "no readable password" for account marolkapong, which had a
  // perfectly good credPassword.
  //
  // The bug survived because the happy path never exercises this fallback:
  // claimAccountsForSet already hands back a resolved password, so only a RETRY
  // reaches it. Every other fulfiller in this codebase reads credPassword
  // (gameflipFulfiller, eldoradoFulfiller x2, digisellerFulfiller) — G2G was the
  // odd one out.
  const fn = FULFILLER.slice(
    FULFILLER.indexOf("async function credentialsFor("),
    FULFILLER.indexOf("async function deliverPendingOrders("),
  );
  assert.match(fn, /credPassword: 1/, "must project credPassword");
  assert.match(
    fn,
    /acc\.credPassword \|\| acc\.password/,
    "credPassword first, password only as a fallback",
  );
});

test("credentialsFor falls back to the login when the id does not resolve", () => {
  // A unit's accountId is not one thing: a BotAccount id on archive stock, but
  // the POOL account id on a no-claim one. Looking up only by id silently fails
  // for half the stock in the shop.
  const fn = FULFILLER.slice(
    FULFILLER.indexOf("async function credentialsFor("),
    FULFILLER.indexOf("async function deliverPendingOrders("),
  );
  assert.match(fn, /BotAccount\.findOne\(\s*\{\s*login: p\.login\s*\}/);
  assert.ok(
    fn.indexOf("findById(p.accountId") < fn.indexOf("findOne(\n        { login: p.login }") ||
      fn.indexOf("findById(p.accountId") < fn.indexOf("{ login: p.login }"),
    "the id lookup should be tried first, the login as a fallback",
  );
});

test("an already-resolved password is passed straight through", () => {
  // The happy path arrives with one from claimAccountsForSet; re-reading it
  // would be a pointless query per unit on every delivery.
  const fn = FULFILLER.slice(
    FULFILLER.indexOf("async function credentialsFor("),
    FULFILLER.indexOf("async function deliverPendingOrders("),
  );
  assert.match(fn, /if \(p\.password\) \{\s*\n\s*out\.push\(p\);\s*\n\s*continue;/);
});

/* ------------ a send that resolves is not a send that arrived ------------ */

test("REGRESSION: the send is verified by reading the channel back", () => {
  // On order 1788892037419NTQU, sendUserMessage RESOLVED and the message never
  // appeared. Read back afterwards, the last four messages in the channel were
  // all from the buyer — who was meanwhile asking "when its gonna be done?".
  // The caller stamped messagedAt on that resolve and recorded a delivery that
  // had not happened. G2G moderates this chat: its own banner tells buyers
  // "only deliver account or product information through the order page using
  // our secure system. Do not share sensitive details in chat."
  assert.match(CHAT, /createPreviousMessageListQuery/, "must read the channel back");
  assert.match(CHAT, /__g2gChatDropped = true/);
  assert.match(
    CHAT,
    /confirmed: true/,
    "a verified send should say so, so callers can tell the two apart",
  );
});

test("an unreadable read-back counts as NOT delivered", () => {
  // Only one of "could not verify" and "delivered" is safe to assume.
  const block = CHAT.slice(CHAT.indexOf("const messageId = sent && sent.messageId;"));
  const guard = block.slice(0, block.indexOf("if (!confirmed)"));
  assert.match(guard, /catch\s*\{[\s\S]*confirmed = false;/, "a failed read-back must not pass");
});

test("a dropped message is handed to the operator, not retried forever", () => {
  // Retrying a moderated message fails identically every time. What it needs is
  // a human on the G2G order page.
  assert.match(
    FULFILLER,
    /!e\.__g2gChatUnavailable && !e\.__g2gChatDropped/,
    "a dropped message must take the operator hand-over path",
  );
  const retry = FULFILLER.slice(
    FULFILLER.indexOf("// Reserved, but nothing has reached the buyer"),
    FULFILLER.indexOf("const stock = await pickStock"),
  );
  assert.match(retry, /e\.__g2gChatDropped \|\| e\.__g2gChatUnavailable/);
  assert.match(retry, /pending: mine\.length/, "report it as pending, not as an error");
});

test("messagedAt is only stamped after a verified send", () => {
  // The stamp is what tells every later tick "the buyer has it". Stamping on an
  // unverified send is how a paid order looked served while the buyer had
  // nothing.
  const retry = FULFILLER.slice(
    FULFILLER.indexOf("// Reserved, but nothing has reached the buyer"),
    FULFILLER.indexOf("const stock = await pickStock"),
  );
  const sendAt = retry.indexOf("chat.sendToBuyer(");
  const stampAt = retry.indexOf("u.messagedAt = sentAt");
  assert.ok(sendAt > 0 && stampAt > 0, "both should be present");
  assert.ok(sendAt < stampAt, "the send (which throws unless verified) must come first");
});
