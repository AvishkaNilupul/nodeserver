// Quest catalog and code reads. Completion deadline and claim deadline differ;
// claimed history remains useful after a campaign has disappeared from @me.
const { discordRequest } = require("./discordHttp");
const { discordHeaders } = require("./discordQuestFarmer");

function normalizeQuest(q) {
  const config = q.config || {};
  return {
    id: String(q.id), config,
    name: config.messages?.quest_name || config.application?.name || String(q.id),
    game: config.messages?.game_title || config.application?.name || "",
    expiresAt: config.expires_at,
    claimExpiresAt: config.rewards_config?.rewards_expire_at || null,
    taskConfig: config.task_config_v2 || config.tasks_config || null,
    rewards: config.rewards_config?.rewards || (config.rewards || []).map((r) => ({ ...r, messages: { name: r.name } })),
    userStatus: q.user_status || null,
  };
}

function canClaim(q, now = Date.now()) {
  if (!q.userStatus?.completed_at || q.userStatus.claimed_at) return false;
  // Missing reward deadlines do not establish that an ended quest is claimable.
  const deadline = Date.parse(q.claimExpiresAt || q.expiresAt);
  return Number.isFinite(deadline) && deadline > now;
}

function codeReward(q, tier = q.userStatus?.claimed_tier) {
  const rewards = q.rewards || [];
  if (q.config?.rewards_config?.assignment_method === 2 && Number.isInteger(tier)) {
    return rewards[tier]?.type === 1 ? rewards[tier] : null;
  }
  return rewards.find((r) => r.type === 1) || null;
}

function createRewardReader(request = discordRequest) {
  async function read(session, path) {
    const r = await request(session.host, { path, headers: discordHeaders(session), proxy: session.proxy });
    if (r.status !== 200) {
      const e = new Error("Discord reward lookup failed");
      e.httpStatus = r.status;
      throw e;
    }
    return r.data;
  }
  async function catalog(session, { history = false } = {}) {
    const current = await read(session, "/api/v9/quests/@me");
    if (!Array.isArray(current?.quests)) throw new Error("Invalid Discord quest catalog");
    const map = new Map();
    if (history) {
      const claimed = await read(session, "/api/v9/quests/@me/claimed");
      if (!Array.isArray(claimed?.quests)) throw new Error("Invalid Discord claimed history");
      for (const q of claimed.quests) map.set(String(q.id), normalizeQuest(q));
    }
    for (const q of current.quests) {
      const value = normalizeQuest(q), previous = map.get(value.id);
      // Current definitions carry redemption links and deadlines omitted from
      // claimed history. Keep a claimed timestamp if only history supplies it.
      if (!value.userStatus?.claimed_at && previous?.userStatus?.claimed_at) value.userStatus = previous.userStatus;
      map.set(value.id, value);
    }
    return [...map.values()];
  }
  async function rewardCode(session, questId) {
    const data = await read(session, "/api/v9/quests/" + encodeURIComponent(questId) + "/reward-code");
    if (data?.quest_id !== questId || typeof data.code !== "string" || !data.code.trim()
        || !data.claimed_at || !/^\d{15,25}$/.test(data.user_id || "")
        || !Number.isInteger(data.platform) || data.platform < 0) throw new Error("Invalid Discord reward code");
    return data;
  }
  return { catalog, rewardCode };
}

module.exports = { normalizeQuest, canClaim, codeReward, createRewardReader };
