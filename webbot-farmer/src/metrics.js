// Opt-in fetch instrumentation for load/perf runs. Wraps the global fetch to
// tally request counts by host and by Twitch GQL operationName, plus request
// body bytes and response content-length. Byte totals are app-visible (they
// exclude TLS/HTTP framing) — cross-check wire bytes with the OS if needed.
// Zero cost unless installMetrics() is called.

let S = null;

const hostOf = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return "?";
  }
};
const inc = (map, k, n = 1) => map.set(k, (map.get(k) || 0) + n);

export function installMetrics() {
  if (S) return S;
  S = {
    start: Date.now(),
    total: 0,
    errors: 0,
    reqBytes: 0,
    respBytes: 0,
    byHost: new Map(),
    byOp: new Map(),
    status: new Map(),
  };
  const orig = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    S.total++;
    const url = typeof input === "string" ? input : input?.url || "";
    inc(S.byHost, hostOf(url));
    const body = init?.body;
    if (typeof body === "string") {
      S.reqBytes += Buffer.byteLength(body);
      if (hostOf(url) === "gql.twitch.tv") tagOps(body);
    }
    try {
      const r = await orig(input, init);
      inc(S.status, r.status);
      const cl = Number(r.headers.get("content-length"));
      if (Number.isFinite(cl)) S.respBytes += cl;
      return r;
    } catch (e) {
      S.errors++;
      throw e;
    }
  };
  return S;
}

function tagOps(body) {
  try {
    const arr = JSON.parse(body);
    for (const op of Array.isArray(arr) ? arr : [arr]) {
      const name =
        op.operationName ||
        (op.extensions?.persistedQuery?.sha256Hash
          ? "persisted:" + op.extensions.persistedQuery.sha256Hash.slice(0, 8)
          : "anon");
      inc(S.byOp, name);
    }
  } catch {
    /* ignore non-JSON bodies */
  }
}

export function snapshot() {
  if (!S) return null;
  const secs = (Date.now() - S.start) / 1000;
  const sortDesc = (m) => [...m].sort((a, b) => b[1] - a[1]);
  return {
    secs,
    total: S.total,
    errors: S.errors,
    reqBytes: S.reqBytes,
    respBytes: S.respBytes,
    rpm: secs > 0 ? S.total / (secs / 60) : 0,
    byHost: sortDesc(S.byHost),
    byOp: sortDesc(S.byOp),
    status: sortDesc(S.status),
  };
}

export function formatReport() {
  const s = snapshot();
  if (!s) return "(metrics not installed)";
  const kb = (n) => (n / 1024).toFixed(1) + " KB";
  const pair = (arr) => arr.map(([k, n]) => `${k}=${n}`).join("  ");
  const rssMB = (process.memoryUsage().rss / 1048576).toFixed(0);
  return [
    `rss      : ${rssMB} MB`,
    `requests : ${s.total} in ${s.secs.toFixed(0)}s = ${s.rpm.toFixed(1)}/min (errors ${s.errors})`,
    `app bytes: req ${kb(s.reqBytes)}  ·  resp(content-length) ${kb(s.respBytes)}`,
    `by host  : ${pair(s.byHost)}`,
    `by gqlop : ${pair(s.byOp)}`,
    `status   : ${pair(s.status)}`,
  ].join("\n");
}
