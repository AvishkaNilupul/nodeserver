// The PlayerAuctions session watchdog's alerting logic — the predictive
// "re-paste before it expires" reminder and the two death-shape messages.
//
// None of this touches the network: the watchdog reads the token expiry out of
// the stored jar locally, and the live probe / Telegram send are stubbed here.
// What is worth guarding is the ONCE-per-cookie behaviour (a reminder that
// fired every 5-minute tick would be worse than none) and that a fresh paste
// re-arms it.
const test = require("node:test");
const assert = require("node:assert");

const mp = require("../utils/marketplaces");
const telegram = require("../utils/telegram");
const watch = require("../utils/playerauctionsSessionWatch");

// Capture what would have been Telegrammed, and drive the two things the
// watchdog reads about the session: whether the live probe passes, and when the
// refresh token expires.
function harness({ testOk, refreshInMs }) {
  const sent = [];
  const orig = {
    keyStatus: mp.keyStatus,
    test: mp.playerauctionsTest,
    expiry: mp.playerauctionsTokenExpiry,
    tg: telegram.sendTelegram,
  };
  // A real token's expiry is a FIXED absolute instant — it does not drift tick
  // to tick — so pin it once here, not per call.
  const refreshAt = refreshInMs == null ? null : new Date(Date.now() + refreshInMs);
  mp.keyStatus = () => ({ playerauctions: { configured: true } });
  mp.playerauctionsTest = async () => (testOk ? { ok: true, detail: "ok" } : { ok: false, detail: "session not accepted" });
  mp.playerauctionsTokenExpiry = () => ({
    access: new Date(Date.now() + 20 * 60000),
    refresh: refreshAt,
  });
  telegram.sendTelegram = async (t) => {
    sent.push(t);
    return { ok: true };
  };
  const restore = () => Object.assign(mp, { keyStatus: orig.keyStatus, playerauctionsTest: orig.test, playerauctionsTokenExpiry: orig.expiry }) && (telegram.sendTelegram = orig.tg);
  return { sent, restore };
}

function resetState() {
  watch.state.alerted = false;
  watch.state.lastOkAt = Date.now();
  watch.state.warnedForExpiry = null;
}

test("a healthy session ~50m from expiry sends exactly one pre-expiry reminder", async () => {
  resetState();
  const h = harness({ testOk: true, refreshInMs: 50 * 60000 });
  try {
    const r1 = await watch.check();
    assert.strictEqual(r1.ok, true);
    const warnings = h.sent.filter((t) => t.includes("expires soon"));
    assert.strictEqual(warnings.length, 1, "one reminder on the first in-window tick");
    // A second tick for the SAME cookie must not re-send.
    await watch.check();
    assert.strictEqual(h.sent.filter((t) => t.includes("expires soon")).length, 1, "no repeat for the same cookie");
  } finally {
    h.restore();
  }
});

test("a fresh paste (later expiry) re-arms the reminder", async () => {
  resetState();
  let h = harness({ testOk: true, refreshInMs: 50 * 60000 });
  try {
    await watch.check();
    assert.strictEqual(h.sent.filter((t) => t.includes("expires soon")).length, 1);
  } finally {
    h.restore();
  }
  // New cookie: expiry jumps to a fresh ~24h out, then ticks back into the window.
  h = harness({ testOk: true, refreshInMs: 24 * 3600000 });
  try {
    await watch.check();
    assert.strictEqual(h.sent.filter((t) => t.includes("expires soon")).length, 0, "far-out expiry does not warn");
  } finally {
    h.restore();
  }
  h = harness({ testOk: true, refreshInMs: 40 * 60000 });
  try {
    await watch.check();
    assert.strictEqual(h.sent.filter((t) => t.includes("expires soon")).length, 1, "the new cookie warns again near its own expiry");
  } finally {
    h.restore();
  }
});

test("a session more than an hour from expiry is not nagged", async () => {
  resetState();
  const h = harness({ testOk: true, refreshInMs: 5 * 3600000 });
  try {
    await watch.check();
    assert.strictEqual(h.sent.filter((t) => t.includes("expires soon")).length, 0);
  } finally {
    h.restore();
  }
});

test("a natural 24h expiry death is reported as normal, not as something broken", async () => {
  resetState();
  const h = harness({ testOk: false, refreshInMs: -5 * 60000 }); // expired 5m ago
  try {
    const r = await watch.check();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.naturalCeiling, true);
    const dead = h.sent.find((t) => t.includes("DEAD"));
    assert.ok(dead, "a dead alert is sent");
    assert.ok(/normal daily expiry/i.test(dead), "worded as the normal daily expiry");
  } finally {
    h.restore();
  }
});

test("an early death (expiry still in the future) is reported as a browser-tab rotation", async () => {
  resetState();
  const h = harness({ testOk: false, refreshInMs: 10 * 3600000 }); // 10h left but dead
  try {
    const r = await watch.check();
    assert.strictEqual(r.naturalCeiling, false);
    const dead = h.sent.find((t) => t.includes("DEAD"));
    assert.ok(/browser tab/i.test(dead), "worded as a browser-tab rotation");
  } finally {
    h.restore();
  }
});

test("the dead alert fires once per outage, not every tick", async () => {
  resetState();
  const h = harness({ testOk: false, refreshInMs: -60000 });
  try {
    await watch.check();
    const r2 = await watch.check();
    assert.strictEqual(r2.alreadyAlerted, true);
    assert.strictEqual(h.sent.filter((t) => t.includes("DEAD")).length, 1);
  } finally {
    h.restore();
  }
});
