// "Does each marketplace still let us in?" — the connector half of the system
// health page (docs/SYSTEM-HEALTH-CONTRACT.md, PART B).
//
// This exists because a dead connector is invisible. When the PlayerAuctions
// session died twice on 2026-09-07 the delivery bot simply stopped shipping;
// nothing threw where anyone was looking, and the outage was found by a human
// deciding to check. The same shape of silence lost order e69b19d3.
//
// READ-ONLY BY CONSTRUCTION. Every call in here is a GET-shaped liveness probe
// that marketplaces.js already exposes (`gameflipTest`, `eldoradoTest`, ...)
// plus one aggregate count against our own listings collection. Nothing here
// publishes, delists, reprices, provisions or writes a key.
//
// THE THREE RULES THAT COST SOMETHING TO LEARN
//
// 1. SERIAL, WITH A GAP. Gameflip runs a silent rate limiter that answers 429
//    with no warning, and a parallel sweep of eight connectors is exactly the
//    fan-out banned by feedback_live_market_safety. The whole sweep is one
//    call at a time with ~1.5s between them: ~11s an hour, which is nothing.
//
// 2. A 429 IS `unknown`, NEVER `fail`. Being throttled means the endpoint
//    answered us — it says nothing about whether the credentials work. Calling
//    that a broken marketplace is how you get woken up for our own traffic.
//
// 3. A TIMEOUT IS `unknown`, NEVER `fail`. Mistaking a transport hiccup for a
//    broken marketplace already produced one wrong diagnosis in this codebase.
//    Only an auth refusal — the market actively saying no — is `fail`.
//
// AND THE TRAP THIS CHECK CANNOT SEE ON ITS OWN:
// Eldorado answers this probe perfectly happily while the entire shop is set
// Offline at the account level, and so does PlayerAuctions with every offer
// paused. "Connector reachable" is NOT "we are selling". So every result here
// also carries how many offers that market currently has live in our records —
// an authenticating connector with 0 live offers is a different situation from
// an authenticating connector with 12, and only the second one means the
// marketplace is actually earning.
const CONNECTOR_GROUP = "Connectors";

// The eight the owner sells on. z2u is deliberately absent: it is run and
// watched separately (utils/z2uFulfiller.js keeps its own shelf), so probing it
// here would only add a ninth live call for a surface nobody reads on this page.
const MARKETS = [
  { id: "gameflip", label: "Gameflip", test: "gameflipTest" },
  { id: "digiseller", label: "Digiseller / Plati", test: "digisellerTest" },
  { id: "ggsel", label: "GGSel", test: "ggselTest" },
  { id: "zeusx", label: "ZeusX", test: "zeusxTest" },
  { id: "eldorado", label: "Eldorado", test: "eldoradoTest" },
  { id: "playerauctions", label: "PlayerAuctions", test: "playerauctionsTest" },
  { id: "g2g", label: "G2G", test: "g2gTest" },
  { id: "funpay", label: "FunPay", test: "funpayTest" },
];

// Space between two live probes. Sized against Gameflip, the only one of the
// eight with a rate limiter we have actually tripped; the others are far more
// forgiving. Seven gaps ~= 10.5s added to an hourly run.
const GAP_MS = 1500;

// Local watchdog on each probe. The underlying axios calls already set 20-30s
// timeouts of their own, but not every path through them is bounded (FunPay
// scrapes HTML, G2G may refresh a token mid-call), and one hung connector must
// never be able to hold the whole hourly run open.
const CALL_BUDGET_MS = 30000;

const MAX_DETAIL_CHARS = 400;

// Transport-level failures: the request never got an answer, so the credentials
// were never actually tested. Every one of these is `unknown`.
const NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ERR_NETWORK",
  "ERR_BAD_RESPONSE",
  "UND_ERR_CONNECT_TIMEOUT",
]);

// Gateway/edge statuses. 502/503/504 are the marketplace's own infrastructure
// failing in front of its API — our key was never presented to anything that
// could judge it, so this is the same "could not run" bucket as a timeout.
const GATEWAY_STATUSES = new Set([408, 502, 503, 504, 520, 521, 522, 524]);

const AUTH_STATUSES = new Set([401, 403]);

// The credential actually being refused, in the words each connector uses.
// eldError/paError write "session not accepted"; funpayTest writes "golden_key
// not accepted"; digisellerToken throws "apilogin failed: ..."; Plati says
// "продавец товара заблокирован" when the seller account itself is blocked.
const AUTH_MESSAGE_RE =
  /not accepted|unauthori[sz]ed|forbidden|account suspended|apilogin failed|invalid[ _-]?(?:api[ _-]?)?(?:key|token|secret|credential|session)|token (?:is )?(?:expired|invalid)|golden_key|заблокирован/i;

const RATE_LIMIT_MESSAGE_RE = /rate[ -]?limit|too many requests/i;

const NETWORK_MESSAGE_RE =
  /timeout|timed out|socket hang up|network error|getaddrinfo|connect ECONN|read ECONN/i;

const UNCONFIGURED_MESSAGE_RE = /not configured/i;

// Real sleep. Deliberately NOT unref'd: this one has to resolve for the sweep to
// continue, and an unref'd gap timer would let a short-lived process (a script,
// a one-shot run) exit in the middle of the loop. It is at most 1.5s.
function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function trim(text) {
  return String(text == null ? "" : text)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DETAIL_CHARS);
}

// Run `fn` but never wait longer than the budget.
//
// The watchdog timer is deliberately NOT unref'd, which is the opposite of the
// habit everywhere else in this codebase. It was written unref'd first, and the
// offline harness caught what that does: with a probe that never settles, the
// unref'd timer was the only handle left, so node emptied its event loop and
// EXITED — no timeout, no results, no error, exit code 0, the sweep simply
// gone. A health check that disappears silently when a connector hangs is the
// precise failure mode this whole file was written to end.
//
// The cost of keeping it ref'd is bounded and small: the timer is cleared on
// every normal path, so it only ever holds the process for the remainder of one
// budget (30s) and only when a probe is genuinely stuck — which is exactly when
// the run needs to survive long enough to say so.
function callWithBudget(fn, budgetMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error("no reply within " + budgetMs + " ms");
      err.__healthTimeout = true;
      reject(err);
    }, budgetMs);
    const finish = (fnc, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fnc(value);
    };
    Promise.resolve()
      .then(fn)
      .then(
        (v) => finish(resolve, v),
        (e) => finish(reject, e),
      );
  });
}

// The HTTP status behind an error, wherever the connector happened to leave it.
// apiError/g2gError/eldError/paError all set `err.status`, but zxError builds a
// message and drops it — so ZeusX 401s arrive only as axios's own "Request
// failed with status code 401" text, and eldoradoTest/playerauctionsTest hand
// back "(HTTP 401)" inside a plain `{ ok: false, detail }` string with no Error
// at all. Reading all three shapes is what stops a ZeusX auth refusal being
// filed as a generic failure.
function httpStatusOf(err) {
  const direct = Number(err && err.status);
  if (Number.isFinite(direct) && direct >= 100 && direct < 600) return direct;
  const fromResponse = Number(err && err.response && err.response.status);
  if (Number.isFinite(fromResponse) && fromResponse >= 100) return fromResponse;
  const m = String((err && err.message) || "").match(
    /\b(?:HTTP|status code)[: ]\s*(\d{3})\b/i,
  );
  return m ? Number(m[1]) : 0;
}

// Which of the four buckets a failure belongs in. Only "auth" is the market
// telling us no; everything else either never reached the market or never
// asked it anything.
function classify(err) {
  const status = httpStatusOf(err);
  const code = String((err && err.code) || "").toUpperCase();
  const message = String((err && err.message) || "");

  if (UNCONFIGURED_MESSAGE_RE.test(message)) {
    return { kind: "unconfigured", status };
  }
  if (status === 429 || RATE_LIMIT_MESSAGE_RE.test(message)) {
    return { kind: "ratelimit", status: status || 429 };
  }
  if (
    (err && err.__healthTimeout) ||
    NETWORK_CODES.has(code) ||
    GATEWAY_STATUSES.has(status) ||
    (!status && NETWORK_MESSAGE_RE.test(message))
  ) {
    return { kind: "network", status };
  }
  if (AUTH_STATUSES.has(status) || AUTH_MESSAGE_RE.test(message)) {
    return { kind: "auth", status };
  }
  return { kind: "other", status };
}

// eldoradoTest and playerauctionsTest do not throw on failure — they return
// `{ ok: false, detail }`. Everything downstream reasons about Errors, so give
// those two the same shape as the six that throw.
function errorFromResult(result) {
  return new Error(
    trim((result && result.detail) || "test reported failure with no detail"),
  );
}

function statusSuffix(status) {
  return status ? " (HTTP " + status + ")" : "";
}

// `null` means we could not count, which must read differently from a real
// zero — "0 live offers" is reassuring, "we don't know" is not.
function offersPhrase(live) {
  if (live == null) return "live offer count unavailable";
  return live + " live offer(s)";
}

// What a refused credential actually costs, in the same three cases. Kept
// separate from offersPhrase because "0 live offer(s) cannot be delivered" is
// nonsense on the page and the zero case is the reassuring one.
function blockedPhrase(live) {
  if (live == null) return "live offer count unavailable";
  if (live === 0) return "nothing of ours is live on it right now";
  return live + " live offer(s) cannot be delivered";
}

// An authenticating connector on a market with no live offers is not losing
// money, so it is not critical. An unknown count is treated as "there may well
// be offers up": when the evidence is missing, be loud rather than reassuring.
function severityFor(status, kind, live) {
  if (status === "ok") return "info";
  // Being throttled is our own traffic answering back. It is never a money
  // event on its own, whatever is on sale.
  if (kind === "ratelimit") return "info";
  const maybeSelling = live == null || live > 0;
  if (status === "fail") return maybeSelling ? "critical" : "warn";
  return maybeSelling ? "warn" : "info";
}

// Which markets have credentials at all. Read once per run from settings on
// disk, so an unconfigured market costs zero network calls instead of a
// guaranteed throw from requireKeys.
function readKeyStatus(mp) {
  try {
    return mp.keyStatus() || {};
  } catch {
    // Settings unreadable: say nothing about configuration and let each probe
    // speak for itself. Better a slow honest run than a fast wrong one.
    return null;
  }
}

// How many listings we believe are live on each market. One aggregate over
// indexed fields (marketplace + status), not eight countDocuments — prod Mongo
// is an Atlas shared tier and this runs every hour.
async function defaultLiveOfferCounts(ids) {
  const MarketplaceListing = require("../models/MarketplaceListing");
  const rows = await MarketplaceListing.aggregate([
    { $match: { marketplace: { $in: ids }, status: "active" } },
    { $group: { _id: "$marketplace", n: { $sum: 1 } } },
  ]);
  const out = {};
  for (const id of ids) out[id] = 0;
  for (const row of rows || []) {
    const key = String((row && row._id) || "");
    if (key in out) out[key] = Number(row.n) || 0;
  }
  return out;
}

async function readLiveOfferCounts(ctx, ids) {
  const load = ctx.liveOfferCounts || defaultLiveOfferCounts;
  try {
    const counts = await load(ids);
    if (!counts || typeof counts !== "object") return null;
    return counts;
  } catch {
    // A DB hiccup must not cost us the connector results — the probes are the
    // expensive part of this check and they have already been paid for.
    return null;
  }
}

function liveFor(counts, id) {
  if (!counts) return null;
  const n = Number(counts[id]);
  return Number.isFinite(n) ? n : null;
}

function connectorCheck(market, fields) {
  return {
    id: "connector." + market.id,
    title: market.label + " connector",
    group: CONNECTOR_GROUP,
    status: fields.status,
    severity: fields.severity,
    summary: fields.summary,
    measured: fields.measured,
    threshold: fields.threshold,
    detail: fields.detail,
    ms: fields.ms,
    checkedAt: fields.checkedAt,
  };
}

// Turn one probe outcome into the frozen check shape. Kept separate from the
// loop so the mapping from "what happened" to "what the page says" is readable
// in one screen.
function describeOutcome({ market, outcome, err, detail, elapsedMs, live, budgetMs, checkedAt }) {
  const threshold =
    "an authenticated reply within " +
    budgetMs +
    " ms; HTTP 429 and transport failures count as unknown, not fail";
  const offers = offersPhrase(live);
  const base = { threshold, ms: elapsedMs, checkedAt };

  if (outcome === "ok") {
    return connectorCheck(market, {
      ...base,
      status: "ok",
      severity: severityFor("ok", null, live),
      summary: market.label + " authenticated in " + elapsedMs + " ms — " + offers,
      measured: "authenticated reply in " + elapsedMs + " ms; " + offers,
      // The connector's own words, verbatim: "Connected as AvishkaREX" is how
      // the owner recognises that the RIGHT account is still attached — a probe
      // that passes against the wrong seller account is a silent disaster.
      detail: trim(detail) || "no detail returned",
    });
  }

  const { kind, status } = classify(err);
  const message = trim((err && err.message) || "unknown error");

  if (kind === "unconfigured") {
    return connectorCheck(market, {
      ...base,
      status: "unknown",
      severity: severityFor("unknown", kind, live),
      summary: market.label + " has no credentials set — nothing to test (" + offers + ")",
      measured: "no API keys stored; " + offers,
      detail: message,
    });
  }

  if (kind === "ratelimit") {
    return connectorCheck(market, {
      ...base,
      status: "unknown",
      severity: severityFor("unknown", kind, live),
      summary:
        market.label +
        " rate-limited" +
        statusSuffix(status) +
        " — reachability not measured this run (" +
        offers +
        ")",
      measured:
        "throttled after " + elapsedMs + " ms" + statusSuffix(status) + "; " + offers,
      detail: message,
    });
  }

  if (kind === "network") {
    return connectorCheck(market, {
      ...base,
      status: "unknown",
      severity: severityFor("unknown", kind, live),
      summary:
        market.label +
        " did not answer — reachability not measured, not a failure (" +
        offers +
        ")",
      measured:
        "no answer after " + elapsedMs + " ms" + statusSuffix(status) + "; " + offers,
      detail: message,
    });
  }

  if (kind === "auth") {
    return connectorCheck(market, {
      ...base,
      status: "fail",
      // Always critical, even at 0 live offers. The market has actively refused
      // the credential, so nothing can be published, delivered OR delisted there
      // until a human pastes a fresh one — and the fulfillers that need it are
      // already failing silently, which is how order e69b19d3 was lost.
      severity: "critical",
      summary:
        market.label +
        " is NOT authenticating" +
        statusSuffix(status) +
        " — " +
        blockedPhrase(live),
      measured:
        "credential refused after " +
        elapsedMs +
        " ms" +
        statusSuffix(status) +
        "; " +
        offers,
      detail: message,
    });
  }

  return connectorCheck(market, {
    ...base,
    status: "fail",
    severity: severityFor("fail", kind, live),
    summary:
      market.label +
      " test call failed" +
      statusSuffix(status) +
      " — " +
      offers,
    measured:
      "test call threw after " + elapsedMs + " ms" + statusSuffix(status) + "; " + offers,
    detail: message,
  });
}

/**
 * One check per marketplace: gameflip, digiseller, ggsel, zeusx, eldorado,
 * playerauctions, g2g, funpay. Always resolves, always returns one result per
 * market, never throws — a connector sweep that can die takes the whole health
 * run with it.
 *
 * Everything it touches comes from `ctx`, so the whole sweep is testable with
 * no network and no database:
 *   ctx.marketplaces      module exposing the `*Test()` functions + keyStatus()
 *   ctx.liveOfferCounts   async (ids) => { [marketId]: liveCount }
 *   ctx.sleep             async (ms) => void   (the inter-call gap)
 *   ctx.now               () => epoch ms
 *   ctx.gapMs             gap between live probes
 *   ctx.timeoutMs         per-probe watchdog budget
 *   ctx.markets           subset of market ids, for a targeted re-check
 */
async function connectorChecks(ctx = {}) {
  const mp = ctx.marketplaces || require("./marketplaces");
  const sleep = typeof ctx.sleep === "function" ? ctx.sleep : defaultSleep;
  const now = typeof ctx.now === "function" ? ctx.now : () => Date.now();
  const gapMs = num(ctx.gapMs, GAP_MS);
  const budgetMs = num(ctx.timeoutMs, CALL_BUDGET_MS) || CALL_BUDGET_MS;

  const wanted = Array.isArray(ctx.markets) && ctx.markets.length
    ? new Set(ctx.markets.map((m) => String(m)))
    : null;
  const markets = MARKETS.filter((m) => !wanted || wanted.has(m.id));

  const keys = readKeyStatus(mp);
  const counts = await readLiveOfferCounts(ctx, markets.map((m) => m.id));

  const out = [];
  // Counts LIVE probes only, so the gap is never spent on a market we skipped
  // for having no credentials.
  let probes = 0;

  for (const market of markets) {
    const live = liveFor(counts, market.id);

    // No credentials stored: report it without spending a call. `unknown`, not
    // `fail` — a market we never configured is not a market that broke.
    if (keys && keys[market.id] && keys[market.id].configured === false) {
      out.push(
        describeOutcome({
          market,
          outcome: "error",
          err: new Error(market.id + " is not configured — set its API keys first"),
          elapsedMs: 0,
          live,
          budgetMs,
          checkedAt: new Date(now()),
        }),
      );
      continue;
    }

    if (probes > 0) {
      // Never in parallel. See rule 1 at the top of this file.
      try {
        await sleep(gapMs);
      } catch {
        /* an injected sleep failing must not stop the sweep */
      }
    }
    probes += 1;

    const startedAt = now();
    let result = null;
    let err = null;
    try {
      const fn = mp[market.test];
      if (typeof fn !== "function") {
        throw new Error(market.test + " is not available on the marketplaces module");
      }
      result = await callWithBudget(() => fn(), budgetMs);
      // The two cookie-auth connectors resolve with `{ ok: false }` instead of
      // throwing, so a bare `await` reads as success on a dead session.
      if (!result || result.ok === false) {
        err = errorFromResult(result);
        result = null;
      }
    } catch (e) {
      err = e instanceof Error ? e : new Error(String(e));
    }

    // Wall time of the probe itself. The deliberate gap above is our own
    // politeness, not the market's latency, so it is excluded.
    const elapsedMs = Math.max(0, now() - startedAt);

    try {
      out.push(
        describeOutcome({
          market,
          outcome: err ? "error" : "ok",
          err,
          detail: result && result.detail,
          elapsedMs,
          live,
          budgetMs,
          checkedAt: new Date(now()),
        }),
      );
    } catch (e) {
      // Formatting must never be the thing that loses a check. Emit the honest
      // "we don't know" rather than dropping the market from the page.
      out.push(
        connectorCheck(market, {
          status: "unknown",
          severity: "warn",
          summary: market.label + " result could not be read",
          measured: "probe took " + elapsedMs + " ms",
          threshold: "an authenticated reply within " + budgetMs + " ms",
          detail: trim((e && e.message) || "unknown formatting error"),
          ms: elapsedMs,
          checkedAt: new Date(now()),
        }),
      );
    }
  }

  return out;
}

module.exports = { connectorChecks };
