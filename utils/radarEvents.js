function text(value) {
  return String(value || "").trim();
}

function keyPart(value) {
  return text(value).toLowerCase();
}

function eventNameResolver(campaigns) {
  const namesByGame = new Map();
  for (const campaign of campaigns || []) {
    const gameKey = keyPart(campaign.game);
    const name = text(campaign.name) || "Unnamed event";
    if (!namesByGame.has(gameKey)) namesByGame.set(gameKey, new Map());
    namesByGame.get(gameKey).set(keyPart(name), name);
  }

  return (game, name) => {
    const clean = text(name) || "Unnamed event";
    const names = namesByGame.get(keyPart(game));
    const base = clean.replace(/\s+drops$/i, "").trim();
    if (base !== clean && names && names.has(keyPart(base))) {
      return names.get(keyPart(base));
    }
    return clean;
  };
}

function eventKey(game, name) {
  return keyPart(game) + "\u0000" + keyPart(name);
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
    assignedAccounts > 0 ||
    tasks.some(
      (task) =>
        task.status === "completed" || task.decision === "skip_already_covered",
    )
  ) {
    return "farmed";
  }
  if (tasks.some((task) => task.status === "failed")) return "failed";
  if (tasks.some((task) => task.status === "skipped")) return "skipped";
  return "untracked";
}

function buildRadarEvents(campaigns, tasks, dropStats) {
  const resolveName = eventNameResolver(campaigns);
  const events = new Map();
  const eventByCampaignId = new Map();

  for (const campaign of campaigns || []) {
    const game = text(campaign.game) || "Unknown game";
    const name = resolveName(game, campaign.name);
    const key = eventKey(game, name);
    let event = events.get(key);
    if (!event) {
      event = {
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
    if (campaignId) {
      event.campaignIds.add(campaignId);
      eventByCampaignId.set(campaignId, event);
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
    const event = eventByCampaignId.get(text(task.campaignId));
    if (!event) continue;
    event.tasks.push(task);
    for (const account of task.assignedAccounts || []) {
      const login = keyPart(account);
      if (login) event.assignedAccounts.add(login);
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
    const name = resolveName(game, stats.campaign);
    const event = events.get(eventKey(game, name));
    if (!event) continue;
    event.archiveDrops += Number(stats.dropRows) || 0;
    event.archivedQuantity += Number(stats.totalCount) || 0;
    for (const account of stats.accounts || []) {
      event.archiveAccounts.add(String(account));
    }
    for (const item of stats.items || []) {
      if (item) event.archiveItems.add(String(item));
    }
  }

  return [...events.values()]
    .map((event) => {
      const state = taskState(
        event.tasks,
        event.archiveDrops > 0,
        event.assignedAccounts.size,
      );
      return {
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
        planned: 1,
        untracked: 2,
        failed: 3,
        skipped: 4,
        farmed: 5,
      };
      return (
        Number(b.active) - Number(a.active) ||
        (priority[a.farm.state] ?? 9) - (priority[b.farm.state] ?? 9) ||
        new Date(b.startAt || 0) - new Date(a.startAt || 0) ||
        a.game.localeCompare(b.game)
      );
    });
}

module.exports = { buildRadarEvents };
