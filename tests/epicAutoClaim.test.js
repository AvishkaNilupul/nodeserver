// Contract tests for the Epic auto-claim gate: settings kill switch, per-
// account cooldown, per-offer dedupe, daily cap, and the success-path plumb
// into utils/epicClient. No Mongo — the account is a plain object with a
// save() shim, and epicClient.autoClaimFreebie is stubbed via require cache
// so the test doesn't hit Epic's payment endpoints.
process.env.ADMIN_KEY = process.env.ADMIN_KEY || "test-admin-key";
process.env.MONGO_URI = process.env.MONGO_URI || "mongodb://localhost/test";
process.env.CRED_SECRET = process.env.CRED_SECRET || "test-cred-secret";

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");

// Isolate settings.json — the block accessors read/write this file. Point at
// a scratch copy per test file so we never clobber the real one.
const scratchDir =
  process.env.SCRATCHPAD_DIR ||
  "/private/tmp/claude-501/-Users-avishkanilupul-projects-nodeserver/603d4d5b-1933-48a7-b14b-c5467e37f884/scratchpad";
try {
  fs.mkdirSync(scratchDir, { recursive: true });
} catch {}
const settingsUtilsPath = require.resolve("../utils/settings.js");
const utilsSettingsJson = path.join(path.dirname(settingsUtilsPath), "settings.json");
const backupPath = utilsSettingsJson + ".epic-autoclaim-backup";
if (fs.existsSync(utilsSettingsJson) && !fs.existsSync(backupPath)) {
  fs.copyFileSync(utilsSettingsJson, backupPath);
}
test.after(async () => {
  if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, utilsSettingsJson);
    fs.unlinkSync(backupPath);
  }
});

// Stub systemLog so settings audit writes don't hang on the DB (each write
// otherwise waits ~10s for the Mongo buffer to time out).
const systemLogPath = require.resolve("../utils/systemLog.js");
require.cache[systemLogPath] = {
  exports: { logEvent: async () => {} },
  loaded: true,
  id: systemLogPath,
};

// Stub epicClient.autoClaimFreebie before the orchestrator loads it.
const epicClientPath = require.resolve("../utils/epicClient.js");
const realEpic = require(epicClientPath);
const stub = {
  ...realEpic,
  autoClaimFreebie: async () => stub._nextResult,
  _nextResult: { status: "claimed", orderId: "ord-1" },
};
require.cache[epicClientPath] = { exports: stub, loaded: true, id: epicClientPath };

const settings = require("../utils/settings");
const epicAutoClaim = require("../utils/epicAutoClaim");

function makeAccount(over) {
  return {
    accountId: "acct-1",
    label: "test",
    displayName: "test",
    sold: false,
    autoClaimLog: [],
    autoClaimCount: 0,
    lastAutoClaimAt: null,
    save: async function () { return this; },
    ...(over || {}),
  };
}
const freebie = {
  offerId: "offer-1",
  namespace: "ns-1",
  title: "Test Freebie",
  originalPrice: "$9.99",
};

test("attemptAutoClaim is inert when the settings kill switch is off", async () => {
  epicAutoClaim._reset();
  await settings.setEpicAutoClaim({ enabled: false, captchaKey: "" });
  const out = await epicAutoClaim.attemptAutoClaim(makeAccount(), freebie, "tok");
  assert.strictEqual(out.attempted, false);
  assert.strictEqual(out.status, "disabled");
});

test("attemptAutoClaim honours the per-account cooldown", async () => {
  epicAutoClaim._reset();
  await settings.setEpicAutoClaim({
    enabled: true,
    perAccountCooldownH: 24,
    dailyCap: 100,
    captchaKey: "",
  });
  const acc = makeAccount({ lastAutoClaimAt: new Date() });
  const out = await epicAutoClaim.attemptAutoClaim(acc, freebie, "tok");
  assert.strictEqual(out.attempted, false);
  assert.strictEqual(out.status, "cooldown");
});

test("attemptAutoClaim is idempotent per (account, offer)", async () => {
  epicAutoClaim._reset();
  await settings.setEpicAutoClaim({
    enabled: true,
    perAccountCooldownH: 0,
    dailyCap: 100,
    captchaKey: "",
  });
  stub._nextResult = { status: "claimed", orderId: "ord-1" };
  const acc = makeAccount();
  const first = await epicAutoClaim.attemptAutoClaim(acc, freebie, "tok");
  assert.strictEqual(first.attempted, true);
  assert.strictEqual(first.status, "claimed");
  const second = await epicAutoClaim.attemptAutoClaim(acc, freebie, "tok");
  assert.strictEqual(second.attempted, false);
  assert.strictEqual(second.status, "already_tried");
});

test("attemptAutoClaim caps daily attempts across the fleet", async () => {
  epicAutoClaim._reset();
  await settings.setEpicAutoClaim({
    enabled: true,
    perAccountCooldownH: 0,
    dailyCap: 2,
    captchaKey: "",
  });
  stub._nextResult = { status: "claimed", orderId: "ok" };
  const a = await epicAutoClaim.attemptAutoClaim(
    makeAccount({ accountId: "a" }),
    freebie,
    "tok",
  );
  const b = await epicAutoClaim.attemptAutoClaim(
    makeAccount({ accountId: "b" }),
    freebie,
    "tok",
  );
  const c = await epicAutoClaim.attemptAutoClaim(
    makeAccount({ accountId: "c" }),
    freebie,
    "tok",
  );
  assert.strictEqual(a.attempted, true);
  assert.strictEqual(b.attempted, true);
  assert.strictEqual(c.attempted, false);
  assert.strictEqual(c.status, "daily_cap");
});

test("a claimed run stamps the account log and lifts the fleet count", async () => {
  epicAutoClaim._reset();
  await settings.setEpicAutoClaim({
    enabled: true,
    perAccountCooldownH: 0,
    dailyCap: 100,
    captchaKey: "",
  });
  stub._nextResult = { status: "claimed", orderId: "ord-777" };
  const acc = makeAccount();
  const out = await epicAutoClaim.attemptAutoClaim(acc, freebie, "tok");
  assert.strictEqual(out.attempted, true);
  assert.strictEqual(out.status, "claimed");
  assert.strictEqual(out.orderId, "ord-777");
  assert.strictEqual(acc.autoClaimCount, 1);
  assert.strictEqual(acc.autoClaimLog[0].status, "claimed");
  assert.strictEqual(acc.autoClaimLog[0].offerId, freebie.offerId);
  const status = epicAutoClaim.getStatus();
  assert.strictEqual(status.todayCount >= 1, true);
  assert.strictEqual(status.recent[0].status, "claimed");
});

test("a needs_captcha result with no solver key stays surfaced", async () => {
  epicAutoClaim._reset();
  await settings.setEpicAutoClaim({
    enabled: true,
    perAccountCooldownH: 0,
    dailyCap: 100,
    captchaKey: "",
  });
  stub._nextResult = { status: "needs_captcha", captchaKey: "some-key" };
  const acc = makeAccount();
  const out = await epicAutoClaim.attemptAutoClaim(acc, freebie, "tok");
  assert.strictEqual(out.attempted, true);
  assert.strictEqual(out.status, "needs_captcha");
  assert.strictEqual(acc.autoClaimLog[0].status, "needs_captcha");
});

test("setEpicAutoClaim encrypts the captchaKey at rest", async () => {
  epicAutoClaim._reset();
  await settings.setEpicAutoClaim({ captchaKey: "SUPER-SECRET-CAPS-KEY" });
  const cur = settings.getEpicAutoClaim();
  assert.notStrictEqual(cur.captchaKey, "SUPER-SECRET-CAPS-KEY");
  assert.ok(cur.captchaKey.startsWith("enc:"), "must be encrypted");
  // The block round-trips through secretBox back to plaintext.
  const { decrypt } = require("../utils/secretBox");
  assert.strictEqual(decrypt(cur.captchaKey), "SUPER-SECRET-CAPS-KEY");
  // Clearing to "" empties (does not re-encrypt "").
  await settings.setEpicAutoClaim({ captchaKey: "" });
  assert.strictEqual(settings.getEpicAutoClaim().captchaKey, "");
});

// One failed autoClaimLog entry for offerId, hoursAgo in the past.
function failedTry(offerId, hoursAgo) {
  return {
    at: new Date(Date.now() - hoursAgo * 3600000),
    offerId,
    status: "captcha_unsupported",
    orderId: "",
    error: "2captcha timed out after 3 min",
  };
}

async function enableForRetryTests() {
  epicAutoClaim._reset();
  await settings.setEpicAutoClaim({
    enabled: true,
    perAccountCooldownH: 0,
    dailyCap: 100,
    captchaKey: "",
    retryAfterH: null,
    maxAttemptsPerOffer: null,
  });
}

test("a captcha-failed pair waits out the retry gap, then is retried", async () => {
  await enableForRetryTests();
  stub._nextResult = { status: "claimed", orderId: "ord-retry" };
  const acc = makeAccount({ autoClaimLog: [failedTry(freebie.offerId, 1)] });
  const early = await epicAutoClaim.attemptAutoClaim(acc, freebie, "tok");
  assert.strictEqual(early.attempted, false);
  assert.strictEqual(early.status, "retry_wait");
  // Three 6-hourly ticks later the gap (17 h) has passed.
  acc.autoClaimLog[0].at = new Date(Date.now() - 18 * 3600000);
  const later = await epicAutoClaim.attemptAutoClaim(acc, freebie, "tok");
  assert.strictEqual(later.attempted, true);
  assert.strictEqual(later.status, "claimed");
  // Once it went through, the pair is done for good.
  acc.autoClaimLog[0].at = new Date(Date.now() - 48 * 3600000);
  const after = await epicAutoClaim.attemptAutoClaim(acc, freebie, "tok");
  assert.strictEqual(after.attempted, false);
  assert.strictEqual(after.status, "already_tried");
});

test("the retry gap counts from the newest try, not the first", async () => {
  await enableForRetryTests();
  const acc = makeAccount({
    autoClaimLog: [failedTry(freebie.offerId, 2), failedTry(freebie.offerId, 40)],
  });
  const out = await epicAutoClaim.attemptAutoClaim(acc, freebie, "tok");
  assert.strictEqual(out.attempted, false);
  assert.strictEqual(out.status, "retry_wait");
});

test("an already_owned result also ends retries for the pair", async () => {
  await enableForRetryTests();
  const acc = makeAccount({
    autoClaimLog: [
      { ...failedTry(freebie.offerId, 30), status: "already_owned" },
      failedTry(freebie.offerId, 60),
    ],
  });
  const out = await epicAutoClaim.attemptAutoClaim(acc, freebie, "tok");
  assert.strictEqual(out.attempted, false);
  assert.strictEqual(out.status, "already_tried");
});

test("retries stop after maxAttemptsPerOffer tries in all", async () => {
  await enableForRetryTests();
  stub._nextResult = {
    status: "captcha_unsupported",
    error: "2captcha timed out after 3 min",
  };
  const acc = makeAccount({
    autoClaimLog: [72, 54, 36, 18].map((h) => failedTry(freebie.offerId, h)),
  });
  // 4 tries so far, the newest 18 h ago: the 5th (last) one runs and fails.
  const fifth = await epicAutoClaim.attemptAutoClaim(acc, freebie, "tok");
  assert.strictEqual(fifth.attempted, true);
  assert.strictEqual(fifth.status, "captcha_unsupported");
  assert.strictEqual(acc.autoClaimLog.length, 5);
  // Even well past the gap there is no 6th try.
  acc.autoClaimLog[0].at = new Date(Date.now() - 24 * 3600000);
  const sixth = await epicAutoClaim.attemptAutoClaim(acc, freebie, "tok");
  assert.strictEqual(sixth.attempted, false);
  assert.strictEqual(sixth.status, "retries_exhausted");
});

test("a failed try on another offer does not hold this one back", async () => {
  await enableForRetryTests();
  stub._nextResult = { status: "claimed", orderId: "ord-other" };
  const acc = makeAccount({ autoClaimLog: [failedTry("offer-2", 1)] });
  const out = await epicAutoClaim.attemptAutoClaim(acc, freebie, "tok");
  assert.strictEqual(out.attempted, true);
  assert.strictEqual(out.status, "claimed");
});

test("the retry gap and try cap default to 17 h / 5 and can be overridden", async () => {
  await enableForRetryTests();
  let status = epicAutoClaim.getStatus();
  assert.strictEqual(status.retryAfterH, 17);
  assert.strictEqual(status.maxAttemptsPerOffer, 5);

  await settings.setEpicAutoClaim({ retryAfterH: 1, maxAttemptsPerOffer: 2 });
  status = epicAutoClaim.getStatus();
  assert.strictEqual(status.retryAfterH, 1);
  assert.strictEqual(status.maxAttemptsPerOffer, 2);
  stub._nextResult = { status: "claimed", orderId: "ord-fast" };
  const acc = makeAccount({ autoClaimLog: [failedTry(freebie.offerId, 2)] });
  const out = await epicAutoClaim.attemptAutoClaim(acc, freebie, "tok");
  assert.strictEqual(out.attempted, true);
  const capped = makeAccount({
    autoClaimLog: [failedTry(freebie.offerId, 5), failedTry(freebie.offerId, 9)],
  });
  const none = await epicAutoClaim.attemptAutoClaim(capped, freebie, "tok");
  assert.strictEqual(none.status, "retries_exhausted");
  await settings.setEpicAutoClaim({ retryAfterH: null, maxAttemptsPerOffer: null });
});
