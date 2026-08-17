function text(value) {
  return String(value || "").trim();
}

function keyPart(value) {
  return text(value).toLowerCase();
}

const WAVE_SUFFIX = new RegExp(
  "\\s*(?:[-\\u2013\\u2014:|]\\s*)?[\\[(]?\\s*" +
    "((?:week|wk|day|wave|phase|part|stage|round)\\s*#?\\s*" +
    "(?:\\d+|[ivxlcdm]+))\\s*[\\])]?(?:\\s+drops)?\\s*$",
  "i",
);

// Twitch publishers are inconsistent about weekly campaign names. Remove only
// an explicit terminal wave marker, never a bare number, season, or version.
function splitEventWave(name) {
  const clean = text(name) || "Unnamed event";
  const match = clean.match(WAVE_SUFFIX);
  if (!match) return { eventName: clean, waveLabel: "" };
  const eventName = clean.slice(0, match.index).trim();
  if (!eventName) return { eventName: clean, waveLabel: "" };
  return {
    eventName,
    waveLabel: match[1].replace(/\s+/g, " ").trim(),
  };
}

function eventNameResolver(campaigns) {
  const namesByGame = new Map();
  for (const campaign of campaigns || []) {
    const gameKey = keyPart(campaign.game);
    const split = splitEventWave(campaign.name);
    const name = split.eventName;
    if (!namesByGame.has(gameKey)) namesByGame.set(gameKey, new Map());
    namesByGame.get(gameKey).set(keyPart(name), name);
  }

  return (game, name) => {
    const split = splitEventWave(name);
    const clean = split.eventName;
    const names = namesByGame.get(keyPart(game));
    const base = clean.replace(/\s+drops$/i, "").trim();
    // Keep a standalone "Drops" name intact. It is only an alias when Twitch
    // also supplied the same event name without that suffix for this game.
    if (base !== clean && names && names.has(keyPart(base))) {
      return { name: names.get(keyPart(base)), waveLabel: split.waveLabel };
    }
    return { name: clean, waveLabel: split.waveLabel };
  };
}

function eventKey(game, name) {
  return keyPart(game) + "\u0000" + keyPart(name);
}

function eventId(game, name) {
  return Buffer.from(eventKey(game, name), "utf8").toString("base64url");
}

function earlier(current, candidate) {
  if (!candidate) return current || null;
  if (!current) return candidate;
  return new Date(candidate) < new Date(current) ? candidate : current;
}

function later(current, candidate) {
  if (!candidate) return current || null;
  if (!current) return candidate;
  return new Date(candidate) > new Date(current) ? candidate : current;
}

function taskState(tasks, hasArchiveEvidence, assignedAccounts) {
  if (tasks.some((task) => task.status === "active")) return "farming";
  if (tasks.some((task) => task.status === "planned")) return "planned";
  if (
    hasArchiveEvidence ||
    tasks.some(
      (task) =>
        task.status === "completed" || task.decision === "skip_already_covered",
    )
  ) {
    return "farmed";
  }
  if (tasks.some((task) => task.status === "failed")) return "failed";
  if (tasks.some((task) => task.status === "skipped")) return "skipped";
  if (assignedAccounts > 0) return "planned";
  return "untracked";
}

function parentState(waves) {
  const states = waves.map((wave) => wave.farm.state);
  if (states.includes("farming")) return "farming";
  if (states.length && states.every((state) => state === "farmed")) {
    return "farmed";
  }
  if (states.includes("farmed")) return "partially_farmed";
  if (states.includes("planned")) return "planned";
  if (states.includes("failed")) return "failed";
  if (states.includes("skipped")) return "skipped";
  return "untracked";
}

function waveOrder(label) {
  const match = text(label).match(/(?:\d+|[ivxlcdm]+)$/i);
  if (!match) return Number.MAX_SAFE_INTEGER;
  if (/^\d+$/.test(match[0])) return Number(match[0]);
  const roman = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  let value = 0;
  let previous = 0;
  for (const ch of match[0].toLowerCase().split("").reverse()) {
    const current = roman[ch] || 0;
    value += current < previous ? -current : current;
    previous = Math.max(previous, current);
  }
  return value || Number.MAX_SAFE_INTEGER;
}

function buildRadarEvents(campaigns, tasks, dropStats) {
  const resolveName = eventNameResolver(campaigns);
  const events = new Map();
  const eventByCampaignId = new Map();
  const waveByCampaignId = new Map();

  for (const campaign of campaigns || []) {
    const game = text(campaign.game) || "Unknown game";
    const resolved = resolveName(game, campaign.name);
    const name = resolved.name;
    const key = eventKey(game, name);
    let event = events.get(key);
    if (!event) {
      event = {
        id: eventId(game, name),
        key,
        name,
        game,
        active: false,
        status: "EXPIRED",
        startAt: null,
        endAt: null,
        firstSeenAt: null,
        image: campaign.boxArt || campaign.image || "",
        detailsURL: campaign.detailsURL || "",
        campaignIds: new Set(),
        waves: [],
        tasks: [],
        botKeys: new Set(),
        assignedAccounts: new Set(),
        archiveAccounts: new Set(),
        archiveItems: new Set(),
        archiveDrops: 0,
        archivedQuantity: 0,
        latestReason: "",
        latestTaskAt: 0,
      };
      events.set(key, event);
    }
    const campaignId = text(campaign.campaignId);
    let wave = campaignId ? waveByCampaignId.get(campaignId) : null;
    if (!wave) {
      wave = {
        campaignId,
        name: text(campaign.name) || name,
        label: resolved.waveLabel || text(campaign.name) || name,
        active: !!campaign.active,
        status: campaign.status || "EXPIRED",
        startAt: campaign.startAt || null,
        endAt: campaign.endAt || null,
        detailsURL: campaign.detailsURL || "",
        tasks: [],
        assignedAccounts: new Set(),
        archiveEvidence: false,
      };
      event.waves.push(wave);
      if (campaignId) {
        event.campaignIds.add(campaignId);
        eventByCampaignId.set(campaignId, event);
        waveByCampaignId.set(campaignId, wave);
      }
    }
    event.active = event.active || !!campaign.active;
    if (campaign.status === "ACTIVE") event.status = "ACTIVE";
    else if (event.status !== "ACTIVE" && campaign.status === "UPCOMING") {
      event.status = "UPCOMING";
    }
    event.startAt = earlier(event.startAt, campaign.startAt);
    event.endAt = later(event.endAt, campaign.endAt);
    event.firstSeenAt = earlier(event.firstSeenAt, campaign.firstSeenAt);
    if (!event.image) event.image = campaign.boxArt || campaign.image || "";
    if (!event.detailsURL) event.detailsURL = campaign.detailsURL || "";
  }

  for (const task of tasks || []) {
    const campaignId = text(task.campaignId);
    const wave = waveByCampaignId.get(campaignId);
    const event = eventByCampaignId.get(campaignId);
    if (!wave || !event) continue;
    wave.tasks.push(task);
    event.tasks.push(task);
    for (const account of task.assignedAccounts || []) {
      const login = keyPart(account);
      if (!login) continue;
      wave.assignedAccounts.add(login);
      event.assignedAccounts.add(login);
    }
    for (const bot of task.bots || []) {
      const botKey = [bot.host || "local", bot.container || bot.file]
        .filter(Boolean)
        .join("|");
      if (botKey) event.botKeys.add(botKey);
    }
    const taskAt =
      new Date(task.updatedAt || task.createdAt || 0).getTime() || 0;
    if (task.reason && taskAt >= event.latestTaskAt) {
      event.latestTaskAt = taskAt;
      event.latestReason = task.reason;
    }
  }

  for (const stats of dropStats || []) {
    const game = text(stats.game) || "Unknown game";
    const resolved = resolveName(game, stats.campaign);
    const event = events.get(eventKey(game, resolved.name));
    if (!event) continue;
    event.archiveDrops += Number(stats.dropRows) || 0;
    event.archivedQuantity += Number(stats.totalCount) || 0;
    for (const account of stats.accounts || []) {
      event.archiveAccounts.add(String(account));
    }
    for (const item of stats.items || []) {
      if (item) event.archiveItems.add(String(item));
    }
    const campaignKey = keyPart(stats.campaign);
    for (const wave of event.waves) {
      if (keyPart(wave.name) === campaignKey) wave.archiveEvidence = true;
    }
  }

  return [...events.values()]
    .map((event) => {
      const waves = event.waves
        .map((wave) => ({
          campaignId: wave.campaignId,
          name: wave.name,
          label: wave.label,
          active: wave.active,
          status: wave.status,
          startAt: wave.startAt,
          endAt: wave.endAt,
          detailsURL: wave.detailsURL,
          farm: {
            state: taskState(
              wave.tasks,
              wave.archiveEvidence,
              wave.assignedAccounts.size,
            ),
            assignedAccounts: wave.assignedAccounts.size,
            taskCount: wave.tasks.length,
          },
        }))
        .sort(
          (a, b) =>
            new Date(a.startAt || 0) - new Date(b.startAt || 0) ||
            waveOrder(a.label) - waveOrder(b.label) ||
            a.name.localeCompare(b.name),
        );
      const state = parentState(waves);
      return {
        id: event.id,
        key: event.key,
        name: event.name,
        game: event.game,
        active: event.active,
        status: event.status,
        startAt: event.startAt,
        endAt: event.endAt,
        firstSeenAt: event.firstSeenAt,
        image: event.image,
        detailsURL: event.detailsURL,
        campaignCount: event.campaignIds.size,
        campaignIds: [...event.campaignIds],
        waves,
        farm: {
          state,
          bots: event.botKeys.size,
          assignedAccounts: event.assignedAccounts.size,
          archiveAccounts: event.archiveAccounts.size,
          archiveItems: event.archiveItems.size,
          archiveDrops: event.archiveDrops,
          archivedQuantity: event.archivedQuantity,
          taskCount: event.tasks.length,
          reason: event.latestReason,
        },
      };
    })
    .sort((a, b) => {
      const priority = {
        farming: 0,
        partially_farmed: 1,
        planned: 2,
        untracked: 3,
        failed: 4,
        skipped: 5,
        farmed: 6,
      };
      return (
        Number(b.active) - Number(a.active) ||
        (priority[a.farm.state] ?? 9) - (priority[b.farm.state] ?? 9) ||
        new Date(b.startAt || 0) - new Date(a.startAt || 0) ||
        a.game.localeCompare(b.game)
      );
    });
}

module.exports = {
  buildRadarEvents,
  eventId,
  splitEventWave,
};
