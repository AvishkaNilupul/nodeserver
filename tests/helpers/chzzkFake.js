// In-memory CHZZK for tests (docs/CHZZK-FARM.md §14). Hands out clients with
// exactly the §6 method surface, no network and no timers of its own — time is
// whatever the caller's `now()` returns.
//
// Minutes are credited on each `watchEvent({ type: "WATCH_CONTINUED" })` beat
// against an OPEN live whose campaign is in its start/end window. The world
// also tracks when a key's minutes crossed a reward's threshold (the "reach
// time"), so `claims()` can hand back a KST `createdDate` and `couponCode()`
// can refuse rewards that are not yet reached.

const { ChzzkError } = require("../../utils/chzzk/errors");
const { kst, liveRow } = require("../../utils/chzzk/normalize");

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const CODE_TYPES = new Set(["CODE_FIRST_COME", "CODE_LOTTERY"]);
const LOGIN_METHODS = new Set([
  "userStatus",
  "watchEvent",
  "challenges",
  "claims",
  "couponCode",
]);

// UTC ms -> "YYYY-MM-DD HH:mm:ss" in KST (what CHZZK sends back).
function toKst(ms) {
  const d = new Date(ms + KST_OFFSET_MS);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear() +
    "-" +
    pad(d.getUTCMonth() + 1) +
    "-" +
    pad(d.getUTCDate()) +
    " " +
    pad(d.getUTCHours()) +
    ":" +
    pad(d.getUTCMinutes()) +
    ":" +
    pad(d.getUTCSeconds())
  );
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v) => (v == null ? "" : String(v));

function createFakeChzzk({
  campaigns = [],
  lives = [],
  minutesPerBeat = 0.5,
  now = Date.now,
} = {}) {
  const campsByNo = new Map(); // campaignNo -> raw campaign object
  const livesById = new Map(); // channelId -> raw live row
  const minutes = new Map(); // "<key>|<campaignNo>" -> float minutes
  const earned = new Map(); // "<key>|<rewardNo>" -> { reachAtMs, campaignNo, rewardNo }
  const seenByKey = new Map(); // key -> Set(campaignNo) that the key has sent any event for
  const loggedOut = new Set(); // keys that have been logged out
  const failQueue = new Map(); // method -> [{ code, left }]
  const noCredit = new Set(); // channelIds that must not credit minutes

  const fake = { country: "JP", calls: [], minutesPerBeat };

  for (const c of campaigns) addCampaignRaw(c);
  for (const l of lives) addLiveRaw(l);

  function addCampaignRaw(c) {
    const no = num(c && c.campaignNo);
    if (!no) throw new Error("fake CHZZK: campaign needs a campaignNo");
    const copy = {
      ...c,
      campaignNo: no,
      rewardList: Array.isArray(c.rewardList) ? c.rewardList.map((r) => ({ ...r })) : [],
    };
    campsByNo.set(no, copy);
  }

  function addLiveRaw(l) {
    const id = str(l && l.channelId);
    if (!id) throw new Error("fake CHZZK: live needs a channelId");
    const copy = {
      ...l,
      channelId: id,
      status: l.status || "OPEN",
      adult: !!l.adult,
      krOnly: !!l.krOnly,
      viewers: num(l.viewers),
      dropsCampaignNo: num(l.dropsCampaignNo),
    };
    livesById.set(id, copy);
  }

  function campaignInWindow(no, atMs) {
    const c = campsByNo.get(num(no));
    if (!c) return false;
    if (c.state === "TERMINATED") return false;
    const start = kst(c.startDate);
    const end = kst(c.endDate);
    if (!start || !end) return false;
    return start.getTime() <= atMs && atMs < end.getTime();
  }

  function recordAndMaybeFail(key, method, args) {
    fake.calls.push({ key, method, args });
    const q = failQueue.get(method);
    if (q && q.length) {
      const slot = q[0];
      slot.left -= 1;
      if (slot.left <= 0) q.shift();
      throw new ChzzkError(`fake CHZZK: ${method} failed`, { code: slot.code });
    }
  }

  function mins(key, no) {
    return minutes.get(key + "|" + num(no)) || 0;
  }

  function makeClient(key, { logged }) {
    const clientKey = key;
    const checkLogin = () => {
      if (!logged || loggedOut.has(clientKey)) {
        throw new ChzzkError("Not logged in", { code: "AUTH" });
      }
    };
    const enter = (method, args) => {
      recordAndMaybeFail(clientKey, method, args);
      if (LOGIN_METHODS.has(method)) checkLogin();
    };

    async function userStatus() {
      enter("userStatus", []);
      return {
        loggedIn: true,
        userIdHash: "hash-" + clientKey,
        nickname: "nick-" + clientKey,
        penalties: [],
      };
    }

    async function categoriesLive(next) {
      enter("categoriesLive", [next]);
      const groups = new Map();
      for (const l of livesById.values()) {
        if (l.status !== "OPEN" || !l.dropsCampaignNo) continue;
        const type = str(l.categoryType) || "GAME";
        const id = str(l.categoryId);
        const gkey = type + "|" + id;
        let g = groups.get(gkey);
        if (!g) {
          const cat = campsByNo.get(l.dropsCampaignNo);
          g = {
            categoryType: type,
            categoryId: id,
            categoryValue: (cat && cat.categoryValue) || str(l.categoryValue),
            openLiveCount: 0,
            dropsCampaignNos: [],
            _seen: new Set(),
          };
          groups.set(gkey, g);
        }
        g.openLiveCount += 1;
        if (!g._seen.has(l.dropsCampaignNo)) {
          g._seen.add(l.dropsCampaignNo);
          g.dropsCampaignNos.push(l.dropsCampaignNo);
        }
      }
      return {
        rows: [...groups.values()].map(({ _seen, ...r }) => r),
        next: null,
      };
    }

    async function campaign(no) {
      enter("campaign", [no]);
      const c = campsByNo.get(num(no));
      if (!c) {
        throw new ChzzkError("Not found", { code: "API", status: 200 });
      }
      return {
        ...c,
        rewardList: c.rewardList.map((r) => ({ ...r })),
      };
    }

    async function dropsLives(type, id, no, { size = 20 } = {}) {
      enter("dropsLives", [type, id, no, { size }]);
      return [...livesById.values()]
        .filter((l) => l.status === "OPEN" && l.dropsCampaignNo === num(no))
        .sort((a, b) => b.viewers - a.viewers)
        .slice(0, num(size) || 20)
        .map((l) =>
          liveRow({
            liveId: l.liveId,
            channelId: l.channelId,
            channelName: l.channelName,
            concurrentUserCount: l.viewers,
            adult: l.adult,
            paidProductId: l.paidProductId,
            watchPartyPaidProductId: l.watchPartyPaidProductId,
            watchPartyNo: l.watchPartyNo,
            openDate: l.openDate,
            dropsCampaignNo: l.dropsCampaignNo,
          }),
        );
    }

    async function liveDetail(channelId) {
      enter("liveDetail", [channelId]);
      const l = livesById.get(str(channelId)) || {};
      return {
        liveId: num(l.liveId),
        openAt: kst(l.openDate),
        status: str(l.status) || "CLOSE",
        dropsCampaignNo: num(l.dropsCampaignNo),
        channelName: str(l.channelName),
      };
    }

    async function liveStatus(channelId) {
      enter("liveStatus", [channelId]);
      const l = livesById.get(str(channelId)) || {};
      return {
        status: str(l.status) || "CLOSE",
        dropsCampaignNo: num(l.dropsCampaignNo),
        liveTokens: Array.isArray(l.liveTokens) ? l.liveTokens.slice() : [],
        krOnly: !!l.krOnly,
        blindType: l.blindType || null,
        adult: !!l.adult,
        abroad: !!l.abroad,
      };
    }

    async function watchEvent(args) {
      enter("watchEvent", [args]);
      const a = args || {};
      const channelId = str(a.channelId);
      const l = livesById.get(channelId);
      if (l && l.dropsCampaignNo) {
        let s = seenByKey.get(clientKey);
        if (!s) seenByKey.set(clientKey, (s = new Set()));
        s.add(l.dropsCampaignNo);
      }
      if (a.type !== "WATCH_CONTINUED") return true;
      if (!l || l.status !== "OPEN") return true;
      const campaignNo = l.dropsCampaignNo;
      if (!campaignNo) return true;
      if (!campaignInWindow(campaignNo, now())) return true;
      if (noCredit.has(channelId)) return true;
      const was = mins(clientKey, campaignNo);
      const total = was + minutesPerBeat;
      minutes.set(clientKey + "|" + campaignNo, total);
      const c = campsByNo.get(campaignNo);
      if (!c) return true;
      for (const r of c.rewardList) {
        if (!CODE_TYPES.has(r.rewardType)) continue;
        const req = num(r.conditionForMinutes);
        const earnKey = clientKey + "|" + num(r.rewardNo);
        if (!earned.has(earnKey) && was < req && total >= req) {
          earned.set(earnKey, {
            reachAtMs: now(),
            campaignNo,
            rewardNo: num(r.rewardNo),
          });
        }
      }
      return true;
    }

    async function challenges() {
      enter("challenges", []);
      const seen = seenByKey.get(clientKey);
      if (!seen) return [];
      const out = [];
      for (const no of seen) {
        const c = campsByNo.get(no);
        if (!c) continue;
        const m = mins(clientKey, no);
        for (const r of c.rewardList) {
          if (!CODE_TYPES.has(r.rewardType)) continue;
          const earnKey = clientKey + "|" + num(r.rewardNo);
          if (earned.has(earnKey)) continue;
          out.push({
            rewardNo: num(r.rewardNo),
            campaignNo: no,
            title: str(r.title),
            rewardType: r.rewardType,
            conditionForMinutes: num(r.conditionForMinutes),
            accumWatchMinutes: Math.floor(m),
            challengeStatus: "IN_PROGRESS",
            codeRemainingCount:
              r.codeRemainingCount == null ? null : num(r.codeRemainingCount),
          });
        }
      }
      return out;
    }

    async function claims() {
      enter("claims", []);
      const prefix = clientKey + "|";
      const out = [];
      for (const [earnKey, info] of earned) {
        if (!earnKey.startsWith(prefix)) continue;
        const c = campsByNo.get(info.campaignNo);
        if (!c) continue;
        const r = c.rewardList.find((x) => num(x.rewardNo) === info.rewardNo);
        if (!r) continue;
        out.push({
          rewardNo: info.rewardNo,
          campaignNo: info.campaignNo,
          title: str(r.title),
          rewardType: r.rewardType,
          fulfillmentState: "COMPLIED",
          createdDate: toKst(info.reachAtMs),
          codeEndDate: "2026-11-30 23:59:59",
          categoryId: str(c.categoryId),
          campaign: { title: str(c.title) },
        });
      }
      return out;
    }

    async function couponCode(rewardNo) {
      enter("couponCode", [rewardNo]);
      const earnKey = clientKey + "|" + num(rewardNo);
      if (!earned.has(earnKey)) {
        throw new ChzzkError("Not earned yet", { code: "API", status: 200 });
      }
      return {
        codeNo: String(num(rewardNo)),
        code: "FAKE-" + clientKey + "-" + num(rewardNo),
      };
    }

    async function egressCountry() {
      enter("egressCountry", []);
      return fake.country || "";
    }

    return {
      userStatus,
      categoriesLive,
      campaign,
      dropsLives,
      liveDetail,
      liveStatus,
      watchEvent,
      challenges,
      claims,
      couponCode,
      egressCountry,
    };
  }

  // -------------------------------------------------- public world controls
  fake.clientFor = (key) => makeClient(String(key), { logged: true });
  fake.anonymous = () => makeClient(null, { logged: false });
  fake.logout = (key) => {
    loggedOut.add(String(key));
  };
  fake.failNext = (method, code, n = 1) => {
    const q = failQueue.get(method) || [];
    q.push({ code, left: Math.max(1, Number(n) || 1) });
    failQueue.set(method, q);
  };
  fake.noCredit = (channelId) => {
    noCredit.add(String(channelId));
  };
  fake.setLive = (channelId, patch) => {
    const l = livesById.get(String(channelId));
    if (!l) return false;
    Object.assign(l, patch || {});
    if (patch && typeof patch.viewers !== "undefined") {
      l.viewers = num(patch.viewers);
    }
    if (patch && typeof patch.dropsCampaignNo !== "undefined") {
      l.dropsCampaignNo = num(patch.dropsCampaignNo);
    }
    return true;
  };
  fake.minutes = (key, campaignNo) => mins(String(key), campaignNo);
  fake.addCampaign = (c) => addCampaignRaw(c);
  fake.addLive = (l) => addLiveRaw(l);

  return fake;
}

module.exports = { createFakeChzzk };
