// Does a Twitch account still EXIST?
//
// A dead token has two completely different causes and only one of them is
// fixable. Twitch rejects the token identically either way — a hard 401/403 that
// utils/twitchInventory.js records as "token_invalid" — so nothing downstream
// could tell "the token expired, re-auth it" from "Twitch deleted this account,
// it is gone forever". On prod that mattered a lot: of 1,516 accounts sitting at
// token_invalid, 1,512 no longer existed at all, and because the auto-farmer
// treats a dead token as re-authable it kept them assigned to tasks, holding
// slots that healthy accounts could not take.
//
// The public `user(login:)` query answers the question with no token at all: it
// returns the user for any live account and `null` once the account is
// suspended or deleted. Verified against prod — all 1,512 dead accounts came
// back null, every healthy control came back with a user.
//
// Everything here is deliberately conservative: only a clean HTTP 200 whose
// `data.user` is exactly null counts as gone. A 429, a 5xx, a network error or
// any GQL error is UNKNOWN, never "gone" — callers delete accounts off the back
// of this, so a Twitch hiccup must never be able to look like a suspension.
const axios = require("axios");

const GQL_URL = "https://gql.twitch.tv/gql";
const DEFAULT_CLIENT_ID = "kd1unb4b3q4t58fwlpcbzcbnm76a8fp";
const USER_QUERY = "query($login:String!){ user(login:$login){ id login } }";

const EXISTS = "exists";
const GONE = "gone";
const UNKNOWN = "unknown";

// Decide the verdict from a raw response. Split out from the request so the
// rules — which are the whole safety story here — are testable without network.
function classifyUserProbe(status, parsed) {
  if (status !== 200) return UNKNOWN;
  if (!parsed || typeof parsed !== "object") return UNKNOWN;
  if (Array.isArray(parsed.errors) && parsed.errors.length) return UNKNOWN;
  if (!parsed.data || !("user" in parsed.data)) return UNKNOWN;
  return parsed.data.user === null ? GONE : EXISTS;
}

// One probe. Never throws: a failure is UNKNOWN, which callers treat as "leave
// this account exactly as it is".
async function probeAccount(login, { clientId } = {}) {
  const name = String(login || "").trim();
  if (!name) return UNKNOWN;
  try {
    const res = await axios.post(
      GQL_URL,
      [{ operationName: null, query: USER_QUERY, variables: { login: name } }],
      {
        headers: {
          "Content-Type": "application/json",
          "Client-Id": clientId || DEFAULT_CLIENT_ID,
        },
        timeout: 20000,
        validateStatus: () => true,
      },
    );
    const data = res.data;
    return classifyUserProbe(res.status, Array.isArray(data) ? data[0] : data);
  } catch {
    return UNKNOWN;
  }
}

// Probe many logins with a small amount of concurrency. 6 workers cleared ~3,900
// prod logins without a single rate-limit response; higher is not worth risking
// UNKNOWNs on a sweep that only runs occasionally.
async function probeAccounts(logins, { clientId, concurrency = 6 } = {}) {
  const list = [...logins];
  const out = new Map();
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const login = list[i++];
      out.set(login, await probeAccount(login, { clientId }));
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(concurrency, list.length)) },
      worker,
    ),
  );
  return out;
}

// Scan verdicts that mean "this account cannot farm or be delivered". Every
// place that used to test `=== "token_invalid"` has to test both members now,
// so keep the list here rather than re-typing the pair at each call site.
const UNUSABLE_SCAN_STATUSES = ["token_invalid", "suspended"];

function isUnusableScanStatus(status) {
  return UNUSABLE_SCAN_STATUSES.includes(String(status || ""));
}

module.exports = {
  EXISTS,
  GONE,
  UNKNOWN,
  UNUSABLE_SCAN_STATUSES,
  isUnusableScanStatus,
  classifyUserProbe,
  probeAccount,
  probeAccounts,
};
