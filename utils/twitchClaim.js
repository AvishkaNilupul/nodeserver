// Twitch drop claim race — a straight Node port of scripts/twitch_claim_spam.py.
//
// Same shape as the reference: N per-worker HTTP clients (each = own TCP+TLS,
// no keepalive, one socket), each with a unique Client-Session-Id and
// X-Device-Id so Twitch's inventory service sees N distinct "devices" landing
// on DropsPage_ClaimDropRewards at the same instant. Pre-warm every client
// concurrently, then park every worker on one shared gate promise and open the
// gate at once so the actual race is as tight as this box's kernel can make
// it.
//
// The persisted-query hash and the ANDROID_APP client-id are copied verbatim
// from TDB's Postman collection — the web Client-Id is behind Kasada's
// Client-Integrity gate and would 401 our requests before they ever reached
// the inventory service.

const https = require("https");
const crypto = require("crypto");

const GQL_HOST = "gql.twitch.tv";
const GQL_PATH = "/gql";
const CLIENT_ID = "kd1unb4b3q4t58fwlpcbzcbnm76a8fp";
const USER_AGENT =
  "Dalvik/2.1.0 (Linux; U; Android 15; SM-G977N Build/BP1A.250505.005)";
const ORIGIN = "https://www.twitch.tv";
const CLAIM_PERSISTED_HASH =
  "a455deea71bdc9015b78eb49f4acfbce8baa7ccbedd28e549bb025bd0f751930";

const INVENTORY_QUERY = `
query Inventory {
  currentUser {
    id
    login
    inventory {
      dropCampaignsInProgress {
        id
        name
        game { id name displayName }
        timeBasedDrops {
          id
          name
          requiredMinutesWatched
          benefitEdges { benefit { id name } }
          self {
            dropInstanceID
            hasPreconditionsMet
            isClaimed
            currentMinutesWatched
          }
        }
      }
    }
  }
}
`.trim();

function randSessionId(length = 16) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(length);
  let s = "";
  for (let i = 0; i < length; i++) s += chars[bytes[i] % chars.length];
  return s;
}

function makeHeaders(token, sessionId, deviceId) {
  const h = {
    Authorization: `OAuth ${token}`,
    "Client-Id": CLIENT_ID,
    "Content-Type": "application/json",
    "Accept-Language": "en-US",
    Origin: ORIGIN,
    Referer: ORIGIN,
    "User-Agent": USER_AGENT,
  };
  if (sessionId) h["Client-Session-Id"] = sessionId;
  if (deviceId) h["X-Device-Id"] = deviceId;
  return h;
}

// One request over the given agent. Never throws — either resolves with the
// response, or resolves with an error string. Ms is measured against the
// perf-hrtime clock so a big fire keeps sub-millisecond resolution.
function postGql(agent, headers, bodyBuf, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    let settled = false;
    function done(payload) {
      if (settled) return;
      settled = true;
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      resolve({ ms, ...payload });
    }
    const req = https.request(
      {
        method: "POST",
        hostname: GQL_HOST,
        path: GQL_PATH,
        headers: { ...headers, "Content-Length": bodyBuf.length },
        agent,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          done({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", (e) => done({ error: e.message || String(e) }));
      },
    );
    req.on("error", (e) => done({ error: e.message || String(e) }));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.write(bodyBuf);
    req.end();
  });
}

async function fetchClaimableDrops(token) {
  const sid = randSessionId(16);
  const did = crypto.randomUUID();
  const headers = makeHeaders(token, sid, did);
  const agent = new https.Agent({ keepAlive: true, maxSockets: 4 });
  const body = Buffer.from(
    JSON.stringify({
      operationName: "Inventory",
      query: INVENTORY_QUERY,
      variables: {},
    }),
  );
  try {
    const r = await postGql(agent, headers, body);
    if (r.error) throw new Error(`inventory query failed: ${r.error}`);
    if (r.status === 401)
      throw new Error("401 Unauthorized — auth-token is wrong or expired.");
    if (r.status >= 400)
      throw new Error(
        `inventory HTTP ${r.status}: ${(r.body || "").slice(0, 200)}`,
      );
    let data;
    try {
      data = JSON.parse(r.body);
    } catch (e) {
      throw new Error(`inventory JSON parse: ${e.message}`);
    }
    if (data && data.errors)
      throw new Error(`GQL error on inventory: ${JSON.stringify(data.errors)}`);
    const user = (data && data.data && data.data.currentUser) || {};
    const login = user.login || "?";
    const inv = user.inventory || {};
    const campaigns = inv.dropCampaignsInProgress || [];
    const drops = [];
    for (const camp of campaigns) {
      for (const drop of camp.timeBasedDrops || []) {
        const self_ = drop.self || {};
        const iid = self_.dropInstanceID;
        if (!iid) continue;
        let reward = "?";
        const edges = drop.benefitEdges || [];
        if (edges.length) {
          const b = edges[0].benefit || {};
          reward = b.name || "?";
        }
        drops.push({
          campaignName: camp.name || "?",
          gameName:
            (camp.game && (camp.game.displayName || camp.game.name)) || "",
          dropId: drop.id || "",
          dropName: drop.name || "?",
          rewardName: reward,
          dropInstanceId: iid,
          isClaimed: Boolean(self_.isClaimed),
          preconditionsMet: Boolean(self_.hasPreconditionsMet),
          requiredMinutesWatched: drop.requiredMinutesWatched,
          currentMinutesWatched: self_.currentMinutesWatched,
        });
      }
    }
    return { login, drops };
  } finally {
    agent.destroy();
  }
}

// Two-phase race, faithful to the python:
//   1. build N per-worker https.Agents (one socket each, no keepalive),
//      pre-warm every one with a full round-trip so the TCP+TLS is hot;
//   2. every worker awaits one shared gate promise, we resolve it after a
//      short buffer, they all fire at once.
async function spamClaim(token, dropInstanceId, nParallel) {
  const bodyBuf = Buffer.from(
    JSON.stringify({
      operationName: "DropsPage_ClaimDropRewards",
      variables: { input: { dropInstanceID: dropInstanceId } },
      extensions: {
        persistedQuery: {
          sha256Hash: CLAIM_PERSISTED_HASH,
          version: 1,
        },
      },
    }),
  );

  const identities = new Array(nParallel);
  const workerHeaders = new Array(nParallel);
  for (let i = 0; i < nParallel; i++) {
    const sid = randSessionId(16);
    const did = crypto.randomUUID();
    identities[i] = { sid, did };
    workerHeaders[i] = makeHeaders(token, sid, did);
  }
  const agents = identities.map(
    () =>
      new https.Agent({
        keepAlive: false,
        maxSockets: 1,
        maxFreeSockets: 0,
      }),
  );

  // Phase 1 — warmup, bounded concurrency (matches the python's ceiling).
  const warmCap = Math.min(500, Math.max(50, Math.floor(nParallel / 20)));
  await new Promise((resolveAll) => {
    let started = 0;
    let finished = 0;
    let inFlight = 0;
    function pump() {
      while (inFlight < warmCap && started < nParallel) {
        const i = started++;
        inFlight++;
        postGql(agents[i], workerHeaders[i], bodyBuf).finally(() => {
          inFlight--;
          finished++;
          if (finished === nParallel) resolveAll();
          else pump();
        });
      }
    }
    pump();
  });

  // Phase 2 — the race.
  let openGate;
  const gate = new Promise((r) => (openGate = r));
  const results = new Array(nParallel);
  const workers = new Array(nParallel);
  for (let i = 0; i < nParallel; i++) {
    workers[i] = (async () => {
      await gate;
      const r = await postGql(agents[i], workerHeaders[i], bodyBuf);
      if (r.error) {
        results[i] = {
          worker: i,
          sessionId: identities[i].sid,
          deviceId: identities[i].did,
          error: r.error,
          ms: Math.round(r.ms * 10) / 10,
          success: false,
        };
        return;
      }
      let j = null;
      try {
        j = JSON.parse(r.body);
      } catch {}
      const success =
        r.status === 200 && j && !j.errors && !!j.data;
      results[i] = {
        worker: i,
        sessionId: identities[i].sid,
        deviceId: identities[i].did,
        status: r.status,
        ms: Math.round(r.ms * 10) / 10,
        success,
        body: (r.body || "").slice(0, 200),
      };
    })();
  }

  // Short buffer so every worker reaches its `await gate` before we open it.
  await new Promise((r) => setTimeout(r, 200));
  const raceStart = process.hrtime.bigint();
  openGate();
  await Promise.all(workers);
  const raceElapsedMs =
    Number(process.hrtime.bigint() - raceStart) / 1e6;

  for (const a of agents) a.destroy();

  const uniqueSessionIds = new Set(
    results.map((r) => r && r.sessionId).filter(Boolean),
  ).size;
  const uniqueDeviceIds = new Set(
    results.map((r) => r && r.deviceId).filter(Boolean),
  ).size;

  // Stats block the UI renders alongside the per-worker table.
  const msVals = results
    .map((r) => (typeof r.ms === "number" ? r.ms : null))
    .filter((v) => v !== null)
    .sort((a, b) => a - b);
  const pct = (p) =>
    msVals.length
      ? msVals[Math.max(0, Math.floor(msVals.length * p) - 1)]
      : 0;
  const statusHistogram = {};
  for (const r of results) {
    const k = r && (r.status || (r.error ? "ERR" : "?"));
    statusHistogram[k] = (statusHistogram[k] || 0) + 1;
  }
  const okCount = results.filter((r) => r && r.success).length;

  return {
    n: nParallel,
    dropInstanceId,
    raceElapsedMs: Math.round(raceElapsedMs * 10) / 10,
    okCount,
    uniqueSessionIds,
    uniqueDeviceIds,
    statusHistogram,
    timing: msVals.length
      ? {
          min: msVals[0],
          p50: pct(0.5),
          p90: pct(0.9),
          p99: pct(0.99),
          max: msVals[msVals.length - 1],
        }
      : null,
    results,
  };
}

// Post-fire truth check: does Twitch's inventory now say the drop is claimed?
async function checkClaimState(token, dropIdOrInstance) {
  const { drops } = await fetchClaimableDrops(token);
  const suffix = String(dropIdOrInstance).split("#").pop();
  for (const d of drops) {
    if (d.dropId === suffix || d.dropInstanceId === dropIdOrInstance) {
      return {
        found: true,
        isClaimed: d.isClaimed,
        currentMinutesWatched: d.currentMinutesWatched,
        dropName: d.dropName,
        campaignName: d.campaignName,
      };
    }
  }
  return { found: false };
}

module.exports = {
  fetchClaimableDrops,
  spamClaim,
  checkClaimState,
};
