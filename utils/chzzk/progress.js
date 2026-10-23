// Works out one account's progress on one campaign from CHZZK's two lists:
//   challenges() — rewards still being worked on (accumWatchMinutes per reward)
//   claims()     — rewards already earned (moved off challenges)
// Pure: no I/O, no clock. Used by the worker (utils/chzzk/worker.js).
//
// Why both lists: CHZZK leaves a campaign OUT of challenges() until it has
// credited at least one minute, and an earned reward also leaves it. A reward
// missing from challenges() therefore means nothing on its own — only claims()
// (or minutes past the reward's condition) says it is earned. Reading only
// challenges() marked brand-new campaigns "done" after 3 minutes (2026-10-23).

const { isFarmableReward, CODE_TYPES } = require("./normalize");

// challengeStatus values that need no more watching. A lottery reward waits
// for its draw ("DRAWING_WAITING") or has lost ("NOT_WON"); a win shows up in
// claims(). Anything else unknown is reported, never treated as done.
const DONE_STATUSES = new Set([
  "DRAWING_WAITING", "NOT_WON", "WON", "COMPLETE", "COMPLETED",
  "ACHIEVED", "CLAIMED", "EXPIRED", "FAILED",
]);
const WORKING_STATUSES = new Set(["IN_PROGRESS", ""]);
// Reward states that count as finished for this account.
const FINISHED = new Set(["claimed", "reached", "passed"]);

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * progressOf(camp, challenges, claims, { floorMinutes })
 *  camp        — store shape: { campaignNo, rewards: [{ rewardNo, rewardType, minutes, remaining }] }
 *  floorMinutes — the most minutes seen for this campaign in earlier REAL reads
 *                 this session (never a persisted value: those may be wrong).
 * Returns {
 *   minutes,            // campaign watch minutes CHZZK has credited
 *   listed,             // the campaign appears in challenges() or claims()
 *   states,             // { [rewardNo]: "claimed" | "reached" | "passed" | "working" | "not_started" }
 *   finished,           // count of farmable rewards in a finished state
 *   total,              // count of farmable rewards
 *   done,               // every farmable reward finished (and there is at least one)
 *   next,               // minutes the next unfinished reward needs, or null
 *   unknown,            // [{ rewardNo, status }] statuses this file does not know
 * }
 * States:
 *   claimed     — in claims() (earned; the code collector reads it)
 *   reached     — still in challenges() but past its minutes, or a lottery waiting/lost
 *   passed      — gone from both lists while the campaign's minutes are past its
 *                 condition (earned a moment ago and the claim is not visible yet,
 *                 or CHZZK ran out of codes) — nothing more watching can do
 *   working     — in challenges(), minutes still short
 *   not_started — in neither list and the minutes are short
 */
function progressOf(camp, challenges, claims, { floorMinutes = 0 } = {}) {
  const no = num(camp && camp.campaignNo);
  const forCamp = (Array.isArray(challenges) ? challenges : [])
    .filter((c) => c && num(c.campaignNo) === no);
  const claimed = new Set(
    (Array.isArray(claims) ? claims : [])
      .filter((c) => c && num(c.campaignNo) === no)
      .map((c) => num(c.rewardNo)),
  );
  const byNo = new Map(forCamp.map((c) => [num(c.rewardNo), c]));

  // Minutes are shared by all of a campaign's rewards, so an earned reward
  // also proves the campaign has at least that reward's minutes.
  let minutes = Math.max(0, num(floorMinutes));
  for (const c of forCamp) minutes = Math.max(minutes, num(c.accumWatchMinutes));
  for (const r of (camp && camp.rewards) || []) {
    if (claimed.has(num(r.rewardNo))) minutes = Math.max(minutes, num(r.minutes));
  }

  const states = {};
  const unknown = [];
  let finished = 0;
  let total = 0;
  let next = null;
  for (const r of (camp && camp.rewards) || []) {
    const rn = num(r.rewardNo);
    // A code reward counts while it can still be earned, or once it was
    // (a sold-out pool must not undo an earned one). IN_APP never counts.
    const isCode = CODE_TYPES.includes(r && r.rewardType);
    if (!isFarmableReward(r) && !(isCode && claimed.has(rn))) continue;
    const need = num(r.minutes);
    const ch = byNo.get(rn);
    const status = ch ? String(ch.challengeStatus || "").toUpperCase() : "";
    let st;
    if (claimed.has(rn)) st = "claimed";
    else if (ch && DONE_STATUSES.has(status)) st = "reached";
    else if (ch && need > 0 && num(ch.accumWatchMinutes) >= num(ch.conditionForMinutes || need)) st = "reached";
    else if (ch) st = "working";
    else if (need > 0 && minutes >= need) st = "passed";
    else st = "not_started";
    if (ch && !DONE_STATUSES.has(status) && !WORKING_STATUSES.has(status)) {
      unknown.push({ rewardNo: rn, status });
    }
    states[rn] = st;
    total++;
    if (FINISHED.has(st)) finished++;
    else if (need > 0 && (next === null || need < next)) next = need;
  }
  return {
    minutes,
    listed: forCamp.length > 0 || claimed.size > 0,
    states,
    finished,
    total,
    done: total > 0 && finished === total,
    next,
    unknown,
  };
}

module.exports = { progressOf, DONE_STATUSES, FINISHED };
