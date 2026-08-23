// One-shot diagnostic: for every account we logged as ok-following
// aviskarex, ask Twitch as that account whether it's STILL following. Twitch
// will accept a follow mutation (our runner sees ok) and silently retract it
// minutes later if the follower looks bot-like — this is the standard way
// they push back on follow-bots. Comparing "we logged ok" vs "still follows"
// tells us the drop rate and, from the account metadata, what pattern the
// dropped ones share.

// Lives at nodeserver/tools/, so requires reach the app root via ../.
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const mongoose = require("mongoose");

const config = require("../config/config");
const BotAccount = require("../models/BotAccount");
const TwitchFollowLog = require("../models/TwitchFollowLog");
const twitchFollow = require("../utils/twitchFollow");
const hosts = require("../utils/botHosts");
const secretBox = require("../utils/secretBox");
const axios = require("axios");

const TARGET_LOGIN = "aviskarex";
const CHECK_CONCURRENCY = 4;

// Same "is X following Y" query the follow button uses. self.follower is
// null when the querying token isn't following the target, or a Follow
// record when it is — no ambiguity like the followUser mutation.
const IS_FOLLOWING_QUERY =
  "query($login: String!) { user(login: $login) { id login self { follower { disableNotifications followedAt } } } }";

const GQL_URL = "https://gql.twitch.tv/gql";
const DEFAULT_CLIENT_ID = "kd1unb4b3q4t58fwlpcbzcbnm76a8fp";

function readToken(a) {
  const raw = a.clientSecret || "";
  if (!raw) return "";
  try {
    return secretBox.decrypt(raw);
  } catch {
    return raw;
  }
}

// Copy of twitchFollow's gqlRequest wiring, because that file only exports
// followChannel + resolveChannel — no arbitrary-query escape hatch.
async function gqlLocal({ token, clientId, body }) {
  const res = await axios.post(GQL_URL, body, {
    headers: {
      "Content-Type": "application/json",
      "Client-Id": clientId,
      Authorization: "OAuth " + token,
    },
    timeout: 15000,
    validateStatus: () => true,
  });
  return { status: res.status, parsed: Array.isArray(res.data) ? res.data[0] : res.data };
}

async function gqlViaHost({ token, clientId, body, host }) {
  const { runShell, shq } = require("../utils/botHosts");
  const cmd =
    "curl -sS --max-time 15 -X POST " +
    shq(GQL_URL) +
    " -H " +
    shq("Content-Type: application/json") +
    " -H " +
    shq("Client-Id: " + clientId) +
    " -H " +
    shq("Authorization: OAuth " + token) +
    " --data-binary @- -w " +
    shq("\\n%{http_code}");
  const { stdout } = await runShell(host, cmd, { timeout: 20000, input: JSON.stringify(body) });
  const text = String(stdout || "");
  const nl = text.lastIndexOf("\n");
  const statusStr = (nl >= 0 ? text.slice(nl + 1) : "").trim();
  const bodyStr = nl >= 0 ? text.slice(0, nl) : text;
  const status = parseInt(statusStr, 10) || 0;
  const data = JSON.parse(bodyStr);
  return { status, parsed: Array.isArray(data) ? data[0] : data };
}

async function checkFollow({ token, host }) {
  const body = [{ query: IS_FOLLOWING_QUERY, variables: { login: TARGET_LOGIN } }];
  const cid = DEFAULT_CLIENT_ID;
  let res;
  // Prefer the host we USED for the follow so integrity IP is consistent.
  // On failure, fall back to local — the answer to "am I following" is not
  // integrity-gated, so a wrong-IP query usually still works.
  try {
    if (host && host.transport && host.transport !== "local") {
      res = await gqlViaHost({ token, clientId: cid, body, host });
    } else {
      res = await gqlLocal({ token, clientId: cid, body });
    }
  } catch (e) {
    // Transport error — retry via local.
    res = await gqlLocal({ token, clientId: cid, body });
  }
  if (res.parsed && res.parsed.errors && res.parsed.errors.length) {
    return { state: "check_failed", reason: res.parsed.errors.map((e) => e.message).join("; ") };
  }
  const user = res.parsed && res.parsed.data && res.parsed.data.user;
  if (!user) {
    if (res.status === 401 || res.status === 403) return { state: "check_failed", reason: "token dead now" };
    return { state: "check_failed", reason: "no user in response [HTTP " + res.status + "]" };
  }
  const follower = user.self && user.self.follower;
  return follower ? { state: "still_following", followedAt: follower.followedAt } : { state: "dropped" };
}

async function main() {
  await mongoose.connect(config.MONGO_URI);
  console.log("mongo connected");

  const logs = await TwitchFollowLog.find({
    channelLogin: TARGET_LOGIN,
    status: "ok",
  })
    .sort({ at: 1 })
    .lean();
  console.log(
    "found " + logs.length + " ok-logged follows for " + TARGET_LOGIN,
  );
  if (!logs.length) {
    await mongoose.disconnect();
    return;
  }

  const accountIds = [...new Set(logs.map((l) => String(l.botAccountId)))];
  const accounts = await BotAccount.find({ _id: { $in: accountIds } })
    .select("_id login host clientSecret lastScanStatus lastScanAt dropCount createdAt")
    .lean();
  const byId = new Map(accounts.map((a) => [String(a._id), a]));
  console.log("hydrated " + accounts.length + " BotAccount docs");

  // Preserve the (account, host used) pair from the log for accurate re-check.
  const jobs = logs.map((l) => ({
    log: l,
    acct: byId.get(String(l.botAccountId)),
    host: hosts.resolveHost(l.host || "local"),
  }));

  const results = [];
  let done = 0;
  async function worker() {
    while (jobs.length) {
      const j = jobs.shift();
      if (!j || !j.acct) continue;
      const token = readToken(j.acct);
      if (!token) {
        results.push({ ...j, r: { state: "check_failed", reason: "empty token" } });
        continue;
      }
      const r = await checkFollow({ token, host: j.host });
      results.push({ ...j, r });
      done += 1;
      if (done % 10 === 0) console.log("  checked " + done);
    }
  }
  await Promise.all(Array.from({ length: CHECK_CONCURRENCY }, worker));

  const tally = { still_following: 0, dropped: 0, check_failed: 0 };
  for (const r of results) tally[r.r.state] += 1;

  console.log("\n===== SUMMARY =====");
  console.log("total ok-logged follows checked : " + results.length);
  console.log("still following now             : " + tally.still_following);
  console.log("silently dropped by twitch      : " + tally.dropped);
  console.log("check itself failed             : " + tally.check_failed);
  const dropRate = tally.dropped / (tally.dropped + tally.still_following || 1);
  console.log(
    "drop rate (of conclusive checks): " + (dropRate * 100).toFixed(1) + "%",
  );

  const dropped = results.filter((r) => r.r.state === "dropped");
  const still = results.filter((r) => r.r.state === "still_following");
  const failed = results.filter((r) => r.r.state === "check_failed");

  function pattern(label, arr) {
    if (!arr.length) return;
    const byHost = {};
    const byIntegrity = {};
    let ageSum = 0;
    let dropSum = 0;
    for (const r of arr) {
      const a = r.acct;
      byHost[a.host || "local"] = (byHost[a.host || "local"] || 0) + 1;
      byIntegrity[a.lastScanStatus || "unknown"] =
        (byIntegrity[a.lastScanStatus || "unknown"] || 0) + 1;
      ageSum += (Date.now() - new Date(a.createdAt).getTime()) / (86400 * 1000);
      dropSum += a.dropCount || 0;
    }
    console.log(
      "\n[" + label + "] n=" + arr.length +
        "  avgAgeDays=" + (ageSum / arr.length).toFixed(1) +
        "  avgDropCount=" + (dropSum / arr.length).toFixed(1),
    );
    console.log("  by host       : " + JSON.stringify(byHost));
    console.log("  by scanStatus : " + JSON.stringify(byIntegrity));
  }
  pattern("STILL FOLLOWING", still);
  pattern("DROPPED", dropped);
  pattern("CHECK FAILED", failed);

  if (dropped.length) {
    console.log(
      "\nFirst 25 dropped account logins (age d / dropCount / host / scanStatus):",
    );
    dropped.slice(0, 25).forEach((r) => {
      const a = r.acct;
      const age = Math.round(
        (Date.now() - new Date(a.createdAt).getTime()) / 86400000,
      );
      console.log(
        "  " +
          (a.login || String(a._id).slice(-6)).padEnd(30) +
          " " +
          String(age).padStart(4) + "d  " +
          String(a.dropCount || 0).padStart(4) + "  " +
          (a.host || "local").padEnd(8) +
          " " + (a.lastScanStatus || "?"),
      );
    });
  }
  if (failed.length) {
    console.log("\nFirst 10 check_failed reasons:");
    failed.slice(0, 10).forEach((r) => {
      console.log("  " + (r.acct.login || "?") + " -> " + r.r.reason);
    });
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
