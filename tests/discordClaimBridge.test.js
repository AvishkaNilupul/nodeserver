const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const root = path.join(__dirname, "../extension/discord-claim-bridge");

test("browser bridge captures only the armed tab and sends sessions only to the selected own server", async () => {
  const state = {}, requests = [];
  let listener, messageListener;
  const chrome = {
    storage: { session: { get: async (key) => ({ [key]: state[key] }),
      set: async (data) => Object.assign(state, data),
      remove: async (keys) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key]; } } },
    tabs: { query: async () => [{ id: 7, url: "https://discord.com/quest-home" }], reload: async () => {},
      get: async () => ({ url: "https://discord.com/quest-home" }) },
    webRequest: { onBeforeSendHeaders: { addListener: (fn) => { listener = fn; } } },
    runtime: { id: "bridge", getURL: (file) => "chrome-extension://bridge/" + file,
      onMessage: { addListener: (fn) => { messageListener = fn; } } },
  };
  const sandbox = { chrome, URL, Date, atob: (s) => Buffer.from(s, "base64").toString(), fetch: async (...args) => {
    requests.push(args); return { ok: true, json: async () => ({ userId: "123456789012345678", state: "alive" }) };
  } };
  vm.runInNewContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), sandbox);
  const sender = { id: "bridge", url: "chrome-extension://bridge/popup.html" };
  const send = (message, from = sender) => new Promise((resolve) => messageListener(message, from, resolve));
  const token = Buffer.from("123456789012345678").toString("base64url") + ".segment.signature";
  const emit = async (tabId) => {
    listener({ tabId, requestHeaders: [{ name: "Authorization", value: token }] });
    await new Promise((resolve) => setImmediate(resolve));
  };
  await emit(7); assert.equal(state.captured, undefined);
  assert.equal((await send({ action: "arm" }, { ...sender, url: "https://discord.com/" })).ok, false);
  await send({ action: "arm" });
  await emit(8); assert.equal(state.captured, undefined);
  await emit(7); assert.equal(state.captured.userId, "123456789012345678");
  assert.equal(state.armed, undefined);
  assert.equal((await send({ action: "import", target: "https://other.test" })).ok, false);
  assert.equal(requests.length, 0);
  const status = await send({ action: "status" });
  assert.ok(!JSON.stringify(status).includes(token));
  assert.equal((await send({ action: "import", target: "https://redeemhub.lets.game" })).ok, true);
  assert.equal(requests[0][1].credentials, "include");
  assert.equal(JSON.parse(requests[0][1].body).token, token);
  assert.equal(state.captured, undefined);
  assert.equal((await send({ action: "import", target: "https://redeemhub.lets.game" })).ok, false);
  await send({ action: "arm" }); state.armed.until = 0;
  await emit(7); assert.equal(state.captured, undefined);
});

test("bridge has no content scripts or persistent credential storage", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json")));
  assert.equal(manifest.content_scripts, undefined);
  assert.ok(!manifest.host_permissions.includes("<all_urls>"));
  for (const file of ["background.js", "popup.js"]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotThrow(() => new vm.Script(source));
    assert.ok(!/storage\.(local|sync)|console\.log|eval\(/.test(source));
  }
});
