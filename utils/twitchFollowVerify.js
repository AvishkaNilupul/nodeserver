// "Do our follows still stick?" — for a given follow-bot job, ask Twitch as
// each ok-logged account whether that account is still following the target
// channel right now. Twitch will accept a follow (the mutation returns ok
// and our runner logs status='ok'), then silently retract it minutes later
// if the follower fails their spam heuristics — this is how the platform
// pushes back on follow-bots. This util is what powers both:
//   * the ad-hoc tools/verify-<channel>.js diagnostic scripts
//   * the "Verify" button surfaced per job in /twitch-follows.html
//
// The check itself is one GQL query per ok-logged account:
//   user(login: TARGET).self.follower  -> Follow record if still following,
//                                        null if silently dropped.
// Egresses from the same host we USED for the follow (matches the IP that
// integrity is bound to), falls back to local on transport failure since
// the answer to "am I following" isn't integrity-gated the way the mutation
// is.
const axios = require("axios");

const BotAccount = require("../models/BotAccount");
const TwitchFollowJob = require("../models/TwitchFollowJob");
const TwitchFollowLog = require("../models/TwitchFollowLog");
const hosts = require("./botHosts");
const secretBox = require("./secretBox");

const GQL_URL = "https://gql.twitch.tv/gql";
const DEFAULT_CLIENT_ID = "kd1unb4b3q4t58fwlpcbzcbnm76a8fp";
const CHECK_CONCURRENCY = 4;

const IS_FOLLOWING_QUERY =
  "query($login: String!) { user(login: $login) { id login self { follower { disableNotifications followedAt } } } }";

function cleanToken(raw) {
  return String(raw || "")
    .trim()
    .replace(/^OAuth\s+/i, "")
    .replace(/^Bearer\s+/i, "");
}

function readToken(a) {
  const raw = a.clientSecret || "";
  if (!raw) return "";
  try {
    return secretBox.decrypt(raw);
  } catch {
    return raw;
  }
}

async function gqlLocal(body, token) {
  const res = await axios.post(GQL_URL, body, {
    headers: {
      "Content-Type": "application/json",
      "Client-Id": DEFAULT_CLIENT_ID,
      Authorization: "OAuth " + cleanToken(token),
    },
    timeout: 15000,
    validateStatus: () => true,
  });
  return {
    status: res.status,
    parsed: Array.isArray(res.data) ? res.data[0] : res.data,
  };
}

async function gqlViaHost(body, token, host) {
  const { runShell, shq } = hosts;
  const cmd =
    "curl -sS --max-time 15 -X POST " +
    shq(GQL_URL) +
    " -H " +
    shq("Content-Type: application/json") +
    " -H " +
    shq("Client-Id: " + DEFAULT_CLIENT_ID) +
    " -H " +
    shq("Authorization: OAuth " + cleanToken(token)) +
    " --data-binary @- -w " +
    shq("\\n%{http_code}");
  const { stdout } = await runShell(host, cmd, {
    timeout: 20000,
    input: JSON.stringify(body),
  });
  const text = String(stdout || "");
  const nl = text.lastIndexOf("\n");
  const statusStr = (nl >= 0 ? text.slice(nl + 1) : "").trim();
  const bodyStr = nl >= 0 ? text.slice(0, nl) : text;
  const status = parseInt(statusStr, 10) || 0;
  const data = JSON.parse(bodyStr);
  return { status, parsed: Array.isArray(data) ? data[0] : data };
}

// Returns { state, followedAt?, reason? } where state is one of
//   still_following | dropped | check_failed.
async function checkStillFollowing({ token, host, targetLogin }) {
  const body = [
    { query: IS_FOLLOWING_QUERY, variables: { login: targetLogin } },
  ];
  let res;
  try {
    if (host && host.transport && host.transport !== "local") {
      res = await gqlViaHost(body, token, host);
    } else {
      res = await gqlLocal(body, token);
    }
  } catch {
    // Transport error (the host is down). "Am I following" isn't
    // integrity-bound, so retrying via local is fine.
    try {
      res = await gqlLocal(body, token);
    } catch (e2) {
      return { state: "check_failed", reason: e2.message || String(e2) };
    }
  }
  if (res.parsed?.errors?.length) {
    return {
      state: "check_failed",
      reason: res.parsed.errors.map((e) => e.message).join("; "),
    };
  }
  const user = res.parsed?.data?.user;
  if (!user) {
    if (res.status === 401 || res.status === 403) {
      return { state: "check_failed", reason: "token dead" };
    }
    return {
      state: "check_failed",
      reason: "no user in response [HTTP " + res.status + "]",
    };
  }
  const follower = user.self && user.self.follower;
  return follower
    ? { state: "still_following", followedAt: follower.followedAt }
    : { state: "dropped" };
}

// Run the check for every ok-logged account of a job and record the tallies
// on the job doc. Returns the tallies (same shape) so the caller can
// respond synchronously if it wants to await, or fire-and-forget and rely
// on the persisted result.
async function verifyFollowsForJob(jobId) {
  const job = await TwitchFollowJob.findById(jobId).lean();
  if (!job) throw new Error("job not found");

  const logs = await TwitchFollowLog.find({
    jobId: job._id,
    status: { $in: ["ok", "already_following"] },
  }).lean();

  if (!logs.length) {
    const empty = {
      stillFollowing: 0,
      dropped: 0,
      checkFailed: 0,
      total: 0,
      samples: [],
    };
    await TwitchFollowJob.findByIdAndUpdate(jobId, {
      $set: {
        lastVerifiedAt: new Date(),
        verifiedStillFollowing: 0,
        verifiedDropped: 0,
        verifiedCheckFailed: 0,
      },
    });
    return empty;
  }

  const accountIds = [...new Set(logs.map((l) => String(l.botAccountId)))];
  const accounts = await BotAccount.find({ _id: { $in: accountIds } })
    .select("_id login host clientSecret")
    .lean();
  const byId = new Map(accounts.map((a) => [String(a._id), a]));

  const jobs = logs.map((l) => ({
    log: l,
    acct: byId.get(String(l.botAccountId)),
    host: hosts.resolveHost(l.host || "local"),
  }));

  const results = [];
  async function worker() {
    while (jobs.length) {
      const item = jobs.shift();
      if (!item || !item.acct) continue;
      const token = readToken(item.acct);
      if (!token) {
        results.push({
          ...item,
          r: { state: "check_failed", reason: "empty token" },
        });
        continue;
      }
      try {
        const r = await checkStillFollowing({
          token,
          host: item.host,
          targetLogin: job.channelLogin,
        });
        results.push({ ...item, r });
      } catch (e) {
        results.push({
          ...item,
          r: { state: "check_failed", reason: e.message || String(e) },
        });
      }
    }
  }
  await Promise.all(
    Array.from({ length: CHECK_CONCURRENCY }, () => worker()),
  );

  const tally = { stillFollowing: 0, dropped: 0, checkFailed: 0 };
  for (const r of results) {
    if (r.r.state === "still_following") tally.stillFollowing += 1;
    else if (r.r.state === "dropped") tally.dropped += 1;
    else tally.checkFailed += 1;
  }
  const dropped = results
    .filter((r) => r.r.state === "dropped")
    .slice(0, 25)
    .map((r) => ({
      login: r.acct.login || String(r.acct._id).slice(-6),
      host: r.acct.host || "local",
    }));

  await TwitchFollowJob.findByIdAndUpdate(jobId, {
    $set: {
      lastVerifiedAt: new Date(),
      verifiedStillFollowing: tally.stillFollowing,
      verifiedDropped: tally.dropped,
      verifiedCheckFailed: tally.checkFailed,
    },
  });

  return {
    total: results.length,
    ...tally,
    droppedSample: dropped,
  };
}

module.exports = {
  verifyFollowsForJob,
  checkStillFollowing,
};
