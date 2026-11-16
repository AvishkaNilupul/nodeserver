"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createZ2uClient } = require("../utils/z2u/client");

test("session-header failures are sanitized and cannot imply a dispatched write", async () => {
  for (const getHeaders of [async () => { throw new Error("cookie=PRIVATE_TOKEN"); }, () => ({ Cookie: "PRIVATE_TOKEN\r\nBad: header" })]) {
    let requests = 0;
    const client = createZ2uClient({ intervalMs: 0, getHeaders, fetch: async () => { requests++; return new Response("ok"); } });
    await assert.rejects(client.mutate("/write", () => new FormData()), error => error.code === "SESSION_SETUP_FAILED" && error.uncertain === false && !error.message.includes("PRIVATE_TOKEN"));
    assert.equal(requests, 0);
  }
});

function pendingBody(onCancel) {
  return new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("unused")); }, cancel: onCancel });
}

test("redirects and failed response hooks cancel unread bodies", async () => {
  for (const redirect of [true, false]) {
    let canceled = 0;
    const client = createZ2uClient({ intervalMs: 0,
      fetch: async () => new Response(pendingBody(() => { canceled++; }), redirect ? { status: 302, headers: { location: "/login" } } : {}),
      acceptResponse: async () => { throw new Error("PRIVATE_COOKIE_METADATA"); },
    });
    await assert.rejects(client.readPage("/userStorage/product"), error => !error.message.includes("PRIVATE_COOKIE_METADATA"));
    assert.equal(canceled, 1);
  }
});

test("oversized declared bodies are canceled before buffering and writes stay uncertain", async () => {
  let canceled = 0, requests = 0;
  const client = createZ2uClient({ intervalMs: 0, maxResponseBytes: 4, fetch: async () => {
    requests++;
    return new Response(pendingBody(() => { canceled++; }), { headers: { "content-length": "1000000" } });
  } });
  await assert.rejects(client.mutate("/write", () => new FormData()), { code: "RESPONSE_TOO_LARGE", uncertain: true });
  assert.equal(canceled, 1);
  assert.equal(requests, 1);
});

test("actual streamed byte count enforces the bound even without a trustworthy Content-Length", async () => {
  let canceled = 0;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("ééé")); },
    cancel() { canceled++; },
  });
  const client = createZ2uClient({ intervalMs: 0, maxResponseBytes: 4, fetch: async () => new Response(stream, { headers: { "content-length": "1" } }) });
  await assert.rejects(client.readPage("/userStorage/product"), { code: "RESPONSE_TOO_LARGE", uncertain: false });
  assert.equal(canceled, 1);
});

test("bounded decoder preserves split multibyte Unicode and accepts exactly the limit", async () => {
  const bytes = new TextEncoder().encode("éé");
  const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 1)); controller.enqueue(bytes.slice(1)); controller.close(); } });
  const client = createZ2uClient({ intervalMs: 0, maxResponseBytes: 4, fetch: async () => new Response(stream) });
  assert.equal(await client.readPage("/userStorage/product"), "éé");
});

test("invalid body limits fail before requests", () => {
  for (const maxResponseBytes of [0, -1, Infinity, 1.5, 129 * 1024 * 1024]) assert.throws(() => createZ2uClient({ maxResponseBytes }), /response size/);
});
