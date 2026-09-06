// A transport failure must never retire a web-token account.
//
// `validate` used to throw a bare Error for both "Twitch says this token is
// dead" and "the request never left the Pi", and the manager treated every
// throw as a dead token: dropped from rotation for the life of the container.
// Measured 2026-09-07 on prod, that was silently retiring 7-13 accounts per bot
// per hour. These tests pin the distinction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validate, makeSession } from "../src/twitch.js";

const realFetch = globalThis.fetch;
function withFetch(impl, fn) {
  globalThis.fetch = impl;
  return fn().finally(() => { globalThis.fetch = realFetch; });
}
const session = () => makeSession({ token: "t" });

test("network failure is flagged transport, not a dead token", async () => {
  await withFetch(
    async () => { throw new TypeError("fetch failed"); },
    async () => {
      const e = await validate(session()).then(() => null, (err) => err);
      assert.ok(e, "should throw");
      assert.equal(e.transport, true);
      assert.match(e.message, /unreachable/);
    },
  );
});

for (const status of [401, 403]) {
  test(`${status} retires the account (transport false)`, async () => {
    await withFetch(
      async () => ({ ok: false, status }),
      async () => {
        const e = await validate(session()).then(() => null, (err) => err);
        assert.equal(e.transport, false);
        assert.equal(e.status, status);
      },
    );
  });
}

for (const status of [429, 500, 503]) {
  test(`${status} is transport — Twitch having a bad minute, keep the account`, async () => {
    await withFetch(
      async () => ({ ok: false, status }),
      async () => {
        const e = await validate(session()).then(() => null, (err) => err);
        assert.equal(e.transport, true);
        assert.equal(e.status, status);
      },
    );
  });
}

test("a good response still populates the session", async () => {
  await withFetch(
    async () => ({ ok: true, json: async () => ({ user_id: "42", login: "acc", client_id: "cid" }) }),
    async () => {
      const s = session();
      await validate(s);
      assert.equal(s.userId, "42");
      assert.equal(s.login, "acc");
      assert.equal(s.clientId, "cid");
    },
  );
});
