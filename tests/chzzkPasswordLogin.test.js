const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { cookieExport, writeExport, login } = require("../tools/chzzk-login");

const NOW = Date.parse("2026-01-01T00:00:00Z");
const cookies = () => [
  { name: "NID_AUT", value: "synthetic-aut", domain: ".naver.com", expires: NOW / 1000 + 86400, sameSite: "None", httpOnly: true, secure: true },
  { name: "NID_SES", value: "synthetic-ses", domain: ".naver.com", expires: -1, sameSite: "Lax" },
];

test("export preserves expiry and session metadata and excludes unrelated domains", () => {
  const out = cookieExport([...cookies(), { name: "X", value: "bad", domain: ".evilnaver.com", expires: -1 }], NOW);
  assert.equal(out.length, 2);
  assert.equal(out[0].session, false);
  assert.equal(out[0].expirationDate, NOW / 1000 + 86400);
  assert.equal(out[0].sameSite, "no_restriction");
  assert.equal(out[1].session, true);
  assert.equal(out[1].sameSite, "lax");
  assert.throws(() => cookieExport(cookies().map((c) => ({ ...c, expires: NOW / 1000 - 1 })), NOW), /required login cookies/);
});

test("export atomically replaces a file with owner-only permissions", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chzzk-export-test-"));
  try {
    const out = path.join(dir, "cookies.json");
    await fs.writeFile(out, "old", { mode: 0o644 });
    await writeExport(out, cookieExport(cookies(), NOW));
    assert.equal((await fs.stat(out)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await fs.readFile(out, "utf8")).length, 2);
    assert.deepEqual(await fs.readdir(dir), ["cookies.json"]);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

function fake({ checks = [false, true], missingCookie = false, failedCheck = false } = {}) {
  const actions = [];
  let count = 0;
  let clock = NOW;
  let closed = false;
  const page = {
    async goto() { actions.push("goto"); },
    locator(selector) {
      return {
        async fill(value) { actions.push(selector === "#pw" ? "password-filled" : "id-filled"); },
        async count() { return 1; },
        async check() { actions.push("remember-checked"); },
        async isChecked() { return true; },
        async click() { actions.push("submitted"); },
      };
    },
    isClosed: () => false,
  };
  const context = {
    pages: () => [page],
    request: { async get() {
      actions.push("status");
      const ok = checks[Math.min(count++, checks.length - 1)];
      return {
        status: () => failedCheck ? 503 : 200, ok: () => !failedCheck,
        json: async () => ({ code: 200, content: { loggedIn: ok, userIdHash: ok ? "synthetic" : "" } }),
        dispose: async () => {},
      };
    } },
    cookies: async () => { actions.push("cookies"); return missingCookie ? cookies().slice(0, 1) : cookies(); },
    close: async () => { closed = true; },
  };
  const output = [];
  const options = {
    chromium: { async launchPersistentContext(profile, opts) {
      assert.equal(opts.headless, false);
      assert.equal(opts.args, undefined, "no browser fingerprint overrides");
      return context;
    } },
    id: "synthetic-id", password: "synthetic-password", now: () => clock,
    sleep: async (ms) => { clock += ms; }, timeoutMs: 10, pollMs: 5,
    save: async (file, rows) => { output.push(rows); return file; }, log: (msg) => actions.push(msg),
  };
  return { options, actions, output, closed: () => closed };
}

test("password login selects remember before submitting and exports only after verification", async () => {
  const f = fake();
  const result = await login(f.options);
  assert.equal(result.persistent, true);
  assert.ok(f.actions.indexOf("remember-checked") < f.actions.indexOf("submitted"));
  assert.ok(f.actions.lastIndexOf("status") < f.actions.indexOf("cookies"));
  assert.equal(f.output.length, 1);
  assert.equal(f.closed(), true);
  assert.equal(JSON.stringify(f.actions).includes("synthetic-password"), false);
  assert.equal(JSON.stringify(f.actions).includes("synthetic-ses"), false);
});

test("an existing verified session is exported without submitting credentials", async () => {
  const f = fake({ checks: [true] });
  await login({ ...f.options, id: "", password: "" });
  assert.equal(f.actions.includes("submitted"), false);
  assert.equal(f.output.length, 1);
  assert.equal(f.closed(), true);
});

test("an incomplete verification never exports and always closes the browser", async () => {
  const f = fake({ checks: [false] });
  await assert.rejects(login(f.options), /Sign-in was not completed/);
  assert.equal(f.output.length, 0);
  assert.equal(f.actions.filter((a) => a === "submitted").length, 1);
  assert.equal(f.closed(), true);
});

test("a login check outage does not resubmit credentials or export stale cookies", async () => {
  const f = fake({ failedCheck: true });
  await assert.rejects(login(f.options), /login check did not answer/);
  assert.equal(f.actions.includes("submitted"), false);
  assert.equal(f.output.length, 0);
  assert.equal(f.closed(), true);
});

test("a missing required cookie prevents writing an export even after reported login success", async () => {
  const f = fake({ checks: [true], missingCookie: true });
  await assert.rejects(login(f.options), /required login cookies/);
  assert.equal(f.output.length, 0);
  assert.equal(f.closed(), true);
});
