// The connector half of the system-health page, as it stood on 2026-10-01.
//
// Two of the board's three "unknown" rows came from here, and neither was what
// it claimed to be:
//   - connector.gameflip read "rate-limited — not measured" on 16 of 72 runs:
//     a 429 earned by our own traffic seconds earlier (the sale watcher was
//     polling 98 expired listings one by one every minute). One retry after a
//     pause answers most of those for real.
//   - connector.playerauctions read "rate-limited (HTTP 429)" for 14 hours, its
//     detail 400 characters of a Cloudflare challenge page, while the session
//     had simply hit its 24h ceiling. The dead-session error is now an HTTP 401
//     (utils/marketplaces.js playerauctionsRefreshSession), which must read as a
//     FAIL — and an HTML page must read as one line, not as markup.
//
// No network: every marketplace probe here is a fake.
const test = require("node:test");
const assert = require("node:assert");

const { connectorChecks, describeHtml } = require("../utils/systemHealthConnectors");

function fakeMp(probes) {
  const calls = {};
  const mp = {
    keyStatus() {
      const out = {};
      for (const id of ["gameflip", "digiseller", "ggsel", "zeusx", "eldorado", "playerauctions", "g2g"]) {
        out[id] = { configured: true };
      }
      return out;
    },
  };
  for (const [fnName, impl] of Object.entries(probes)) {
    mp[fnName] = async () => {
      calls[fnName] = (calls[fnName] || 0) + 1;
      return impl(calls[fnName]);
    };
  }
  return { mp, calls };
}

function run(mp, over = {}) {
  const slept = [];
  return connectorChecks({
    marketplaces: mp,
    liveOfferCounts: async (ids) => Object.fromEntries(ids.map((id) => [id, 10])),
    sleep: async (ms) => {
      slept.push(ms);
    },
    gapMs: 1,
    retryMs: 7,
    ...over,
  }).then((rows) => ({ rows, slept }));
}

const ok = (detail) => () => ({ ok: true, detail });
const throttled = () => {
  const e = new Error('Gameflip: {"status":"FAILURE","error":{"message":"Too many attempts - Retry later","code":429}}');
  e.status = 429;
  throw e;
};

test("a throttled probe gets one retry after a pause, and a real answer is ok", async () => {
  const { mp, calls } = fakeMp({
    gameflipTest: (n) => (n === 1 ? throttled() : { ok: true, detail: "Connected as AvishkaREX" }),
  });
  const { rows, slept } = await run(mp, { markets: ["gameflip"] });
  assert.strictEqual(calls.gameflipTest, 2);
  assert.ok(slept.includes(7), "the retry waits retryMs first");
  assert.strictEqual(rows[0].status, "ok");
  assert.match(rows[0].detail, /AvishkaREX/);
});

test("throttled twice is still unknown — never fail — and there is no third try", async () => {
  const { mp, calls } = fakeMp({ gameflipTest: throttled });
  const { rows } = await run(mp, { markets: ["gameflip"] });
  assert.strictEqual(calls.gameflipTest, 2);
  assert.strictEqual(rows[0].status, "unknown");
  assert.match(rows[0].summary, /rate-limited/);
});

test("an auth refusal is not retried: it is the market saying no", async () => {
  const { mp, calls } = fakeMp({
    zeusxTest: () => {
      throw new Error("Request failed with status code 401");
    },
  });
  const { rows } = await run(mp, { markets: ["zeusx"] });
  assert.strictEqual(calls.zeusxTest, 1);
  assert.strictEqual(rows[0].status, "fail");
});

test("REGRESSION 2026-10-01: a PlayerAuctions session past its 24h ceiling FAILS, it is not 'rate-limited'", async () => {
  // playerauctionsTest resolves { ok:false, detail } — the detail is all the
  // connector ever sees, so the HTTP 401 has to be in the words.
  const { mp } = fakeMp({
    playerauctionsTest: () => ({
      ok: false,
      detail:
        "PlayerAuctions session refresh failed (HTTP 401): session expired 2026-09-30T14:16:42.000Z — its refresh token reached the 24h PlayerAuctions limit, so no refresh can renew it; paste a fresh PlayerAuctions cookie header from a signed-in seller session",
    }),
  });
  const { rows } = await run(mp, { markets: ["playerauctions"] });
  assert.strictEqual(rows[0].status, "fail");
  assert.strictEqual(rows[0].severity, "critical");
  assert.match(rows[0].summary, /NOT authenticating \(HTTP 401\)/);
  assert.match(rows[0].detail, /paste a fresh PlayerAuctions cookie/);
});

test("an HTML error page reads as one line naming what answered", async () => {
  const page =
    'PlayerAuctions session refresh failed (HTTP 429): <!DOCTYPE html> <html lang="en-US"> <head> <title>Just a moment...</title> <meta name="robots" content="noindex,nofollow"> <style>*{box-sizing:border-box;margin:0;p';
  assert.strictEqual(
    describeHtml(page),
    'PlayerAuctions session refresh failed (HTTP 429): [an HTML page titled "Just a moment..." — Cloudflare\'s challenge page, not the marketplace\'s API]',
  );
  assert.strictEqual(describeHtml("plain text stays as it is"), "plain text stays as it is");
  assert.strictEqual(
    describeHtml("Bad gateway: <html><head><title>502 Bad Gateway</title></head></html>"),
    'Bad gateway: [an HTML page titled "502 Bad Gateway"]',
  );

  const { mp } = fakeMp({ playerauctionsTest: () => ({ ok: false, detail: page }) });
  const { rows } = await run(mp, { markets: ["playerauctions"] });
  assert.doesNotMatch(rows[0].detail, /<!DOCTYPE|<html|<meta/i);
  assert.match(rows[0].detail, /Cloudflare's challenge page/);
});
