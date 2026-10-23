// CHZZK — normalised shapes (docs/CHZZK-FARM.md §5).
//
// CHZZK answers with Korea-local timestamps and nested shapes. Everything the
// rest of the farm reads goes through here once, so the worker, the stores
// and the UI share one Campaign / Reward / Live shape. Pure functions: no
// network, no database, no logging.
//
// KST is UTC+9 with no daylight saving, so a wall-clock "YYYY-MM-DD HH:mm:ss"
// is converted here (v1 of the SOOP farm read these in the server's zone and
// ended campaigns nine hours off).

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const KST_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

const CODE_TYPES = ["CODE_FIRST_COME", "CODE_LOTTERY"];

function kst(s) {
  if (s instanceof Date) {
    return Number.isNaN(s.getTime()) ? null : new Date(s.getTime());
  }
  if (typeof s !== "string") return null;
  const m = KST_RE.exec(s.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, sec] = m.slice(1).map((p) => Number(p || 0));
  if (y === 0 || mo === 0 || d === 0) return null; // "0000-00-00 00:00:00" = not set
  const wall = new Date(Date.UTC(y, mo - 1, d, h, mi, sec));
  // Date.UTC rolls 02-31 into March; a date that does not round-trip is junk.
  if (
    wall.getUTCFullYear() !== y ||
    wall.getUTCMonth() !== mo - 1 ||
    wall.getUTCDate() !== d ||
    wall.getUTCHours() !== h ||
    wall.getUTCMinutes() !== mi ||
    wall.getUTCSeconds() !== sec
  ) {
    return null;
  }
  return new Date(wall.getTime() - KST_OFFSET_MS);
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const posNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const str = (v) => (v == null ? "" : String(v));
const strOrNull = (v) => (v == null || v === "" ? null : String(v));

function clipGuide(text, max = 2000) {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) : text;
}

function campaignFromApi(c) {
  const r = c || {};
  const rewardList = Array.isArray(r.rewardList) ? r.rewardList : [];
  const rewards = rewardList
    .filter((x) => x && typeof x === "object")
    .map((x) => ({
      rewardNo: num(x.rewardNo),
      title: str(x.title),
      rewardType: str(x.rewardType),
      minutes: num(x.conditionForMinutes),
      remaining: x.codeRemainingCount == null ? null : num(x.codeRemainingCount),
      imageUrl: strOrNull(x.imageUrl),
    }));
  return {
    campaignNo: num(r.campaignNo),
    title: str(r.title),
    categoryType: str(r.categoryType),
    categoryId: str(r.categoryId),
    categoryValue: str(r.categoryValue),
    imageUrl: strOrNull(r.imageUrl),
    state: str(r.state),
    startAt: kst(r.startDate),
    endAt: kst(r.endDate),
    needsLink: !!(r.accountLinkUrl || r.providerId || r.externalProvider),
    guide: clipGuide(str(r.description)),
    rewards,
  };
}

function isFarmableReward(r) {
  if (!r) return false;
  if (r.rewardType === "CODE_LOTTERY") return true;
  if (r.rewardType === "CODE_FIRST_COME") return r.remaining !== 0;
  return false;
}

// Accept a Date, a number (epoch ms), or a KST string; fall back to now for
// anything else, so callers can hand us whatever clock shape they have.
function toTs(t) {
  if (t == null) return Date.now();
  if (t instanceof Date) {
    const v = t.getTime();
    return Number.isNaN(v) ? Date.now() : v;
  }
  if (typeof t === "number") return Number.isFinite(t) ? t : Date.now();
  const parsed = kst(t);
  return parsed ? parsed.getTime() : Date.now();
}

function toMs(d) {
  if (d == null) return null;
  if (d instanceof Date) {
    const v = d.getTime();
    return Number.isNaN(v) ? null : v;
  }
  if (typeof d === "number") return Number.isFinite(d) ? d : null;
  const parsed = kst(d);
  return parsed ? parsed.getTime() : null;
}

function isCampaignFarmable(camp, t) {
  if (!camp || !camp.enabled) return false;
  if (camp.needsLink) return false;
  if (camp.state === "TERMINATED") return false;
  const now = toTs(t);
  const start = toMs(camp.startAt);
  const end = toMs(camp.endAt);
  if (start == null || end == null) return false;
  if (!(start <= now && now < end)) return false;
  const rewards = Array.isArray(camp.rewards) ? camp.rewards : [];
  return rewards.some(isFarmableReward);
}

function liveRow(l) {
  const r = l || {};
  const channel = r.channel && typeof r.channel === "object" ? r.channel : {};
  return {
    liveId: num(r.liveId),
    channelId: str(r.channelId || channel.channelId),
    channelName: str(r.channelName || channel.channelName),
    viewers: posNum(r.concurrentUserCount != null ? r.concurrentUserCount : r.viewers),
    adult: !!r.adult,
    paid: !!(r.paidProductId || r.watchPartyPaidProductId),
    watchParty: !!r.watchPartyNo,
    openAt: kst(r.openDate),
    dropsCampaignNo: num(r.dropsCampaignNo),
  };
}

module.exports = {
  kst,
  CODE_TYPES,
  campaignFromApi,
  isFarmableReward,
  isCampaignFarmable,
  liveRow,
};
