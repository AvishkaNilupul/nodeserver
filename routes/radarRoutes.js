const express = require("express");
const mongoose = require("mongoose");

const { requireSuperadmin } = require("../middleware/auth");
const TwitchCampaign = require("../models/TwitchCampaign");
const EpicFreebie = require("../models/EpicFreebie");
const AutoFarmTask = require("../models/AutoFarmTask");
const DropLog = require("../models/DropLog");
const DropSet = require("../models/DropSet");
const BotAccount = require("../models/BotAccount");
const MarketplaceListing = require("../models/MarketplaceListing");
const campaignWatcher = require("../utils/campaignWatcher");
const epicWatcher = require("../utils/epicWatcher");
const { buildRadarEvents } = require("../utils/radarEvents");
const { campaignItems } = require("../utils/autoLister");
const {
  eventListingNote,
  mergeWaveItems,
} = require("../utils/radarEventListings");
const { cacheImage } = require("../utils/imageCache");
const { availableAccountsForSet } = require("./shopRoutes");
const { AVAILABLE_DROP } = require("../utils/dropReservation");

const router = express.Router();

const TASK_FIELDS = {
  game: 1,
  campaignId: 1,
  campaignName: 1,
  campaignEndAt: 1,
  status: 1,
  decision: 1,
  reason: 1,
  assignedAccounts: 1,
  bots: 1,
  "listing.setId": 1,
  createdAt: 1,
  updatedAt: 1,
};

function dedupeCampaigns(campaigns) {
  const byId = new Map();
  for (const campaign of campaigns || []) {
    const id = String(campaign.campaignId || "");
    if (id && !byId.has(id)) byId.set(id, campaign);
  }
  return [...byId.values()];
}

function syntheticCampaign(task) {
  return {
    campaignId: task.campaignId,
    name: task.campaignName || "Unnamed event",
    game: task.game || "Unknown game",
    status: "EXPIRED",
    active: false,
    startAt: null,
    endAt: task.campaignEndAt || null,
    firstSeenAt: task.createdAt || null,
  };
}

async function dropStatsForCampaigns(campaigns) {
  const names = [
    ...new Set(campaigns.map((campaign) => campaign.name).filter(Boolean)),
  ];
  if (!names.length) return [];
  return DropLog.aggregate([
    { $match: { campaign: { $in: names } } },
    {
      $group: {
        _id: { campaign: "$campaign", game: "$game" },
        dropRows: { $sum: 1 },
        totalCount: { $sum: { $ifNull: ["$count", 1] } },
        accounts: { $addToSet: "$account" },
        items: { $addToSet: "$itemKey" },
      },
    },
    {
      $project: {
        _id: 0,
        campaign: "$_id.campaign",
        game: "$_id.game",
        dropRows: 1,
        totalCount: 1,
        accounts: 1,
        items: 1,
      },
    },
  ]);
}

// How long a fully-farmed event stays in the default (live-only) view after its
// Twitch window closes. A drop you just finished farming is exactly when you
// want to turn it into a listing, so it shouldn't vanish the instant it ends.
const RECENT_FARMED_GRACE_HOURS = 48;
const RECENT_FARMED_GRACE_MS = RECENT_FARMED_GRACE_HOURS * 60 * 60 * 1000;

async function loadRadarData(
  showEnded,
  includeEpic = true,
  includeDropStats = true,
) {
  const campaignQuery = TwitchCampaign.find(showEnded ? {} : { active: true })
    .sort(
      showEnded
        ? { active: -1, startAt: -1, endAt: -1 }
        : { active: -1, status: 1, endAt: 1 },
    )
    .limit(500)
    .lean();
  const taskQuery = showEnded
    ? AutoFarmTask.find({}, TASK_FIELDS).lean()
    : null;
  const epicQuery = includeEpic
    ? EpicFreebie.find(showEnded ? {} : { active: true })
        .sort({ active: -1, upcoming: 1, endDate: 1 })
        .limit(200)
        .lean()
    : Promise.resolve([]);
  let [campaigns, tasks, epic] = await Promise.all([
    campaignQuery,
    taskQuery || Promise.resolve(null),
    epicQuery,
  ]);

  // `campaigns` is what the Twitch-dashboard table shows (live-only unless
  // "show ended"). `eventCampaigns` is the broader set the event roll-up is
  // built from — it additionally carries recently-ended campaigns so their
  // fully-farmed events linger in the live view for the grace window.
  let eventCampaigns = campaigns;
  if (showEnded) {
    const taskIds = [
      ...new Set(tasks.map((task) => task.campaignId).filter(Boolean)),
    ];
    const taskCampaigns = taskIds.length
      ? await TwitchCampaign.find({ campaignId: { $in: taskIds } }).lean()
      : [];
    campaigns = dedupeCampaigns([...campaigns, ...taskCampaigns]);
    const known = new Set(campaigns.map((campaign) => campaign.campaignId));
    campaigns.push(
      ...tasks
        .filter((task) => task.campaignId && !known.has(task.campaignId))
        .map(syntheticCampaign),
    );
    eventCampaigns = campaigns;
  } else {
    const graceCutoff = new Date(Date.now() - RECENT_FARMED_GRACE_MS);
    const recentlyEnded = await TwitchCampaign.find({
      active: false,
      endAt: { $gte: graceCutoff },
    })
      .sort({ endAt: -1 })
      .limit(500)
      .lean();
    eventCampaigns = recentlyEnded.length
      ? dedupeCampaigns([...campaigns, ...recentlyEnded])
      : campaigns;
    const campaignIds = eventCampaigns.map((campaign) => campaign.campaignId);
    tasks = campaignIds.length
      ? await AutoFarmTask.find(
          { campaignId: { $in: campaignIds } },
          TASK_FIELDS,
        ).lean()
      : [];
  }

  const dropStats = includeDropStats
    ? await dropStatsForCampaigns(eventCampaigns)
    : [];
  let events = buildRadarEvents(eventCampaigns, tasks, dropStats);
  if (!showEnded) {
    // A grace-window campaign only earns a spot if its event is fully farmed
    // (stock ready to list). Ended-and-unfarmed campaigns are dropped so the
    // live view isn't cluttered with expired misses.
    events = events.filter(
      (event) => event.active || (event.farm && event.farm.state === "farmed"),
    );
  }
  return {
    campaigns,
    tasks,
    dropStats,
    events,
    epic,
  };
}

function tasksForEvent(event, tasks) {
  const ids = new Set(event.campaignIds || []);
  return (tasks || []).filter((task) => ids.has(String(task.campaignId || "")));
}

function assignedLogins(tasks) {
  return [
    ...new Set(
      (tasks || [])
        .flatMap((task) => task.assignedAccounts || [])
        .map((login) =>
          String(login || "")
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean),
    ),
  ];
}

async function accountIdsForLogins(logins) {
  if (!logins.length) return [];
  const patterns = logins.map(
    (login) =>
      new RegExp(
        "^" + login.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&") + "$",
        "i",
      ),
  );
  const accounts = await BotAccount.find(
    { login: { $in: patterns } },
    { _id: 1 },
  ).lean();
  return accounts.map((account) => account._id);
}

async function itemCoverage(items, logins) {
  const accountIds = await accountIdsForLogins(logins);
  if (!items.length || !accountIds.length) return [];
  const keys = items.map((item) => item.itemKey);
  const rows = await DropLog.aggregate([
    {
      $match: {
        itemKey: { $in: keys },
        account: { $in: accountIds },
        ...AVAILABLE_DROP,
      },
    },
    {
      $group: {
        _id: { itemKey: "$itemKey", account: "$account" },
        count: { $sum: "$count" },
      },
    },
  ]);
  const byKey = new Map();
  for (const row of rows) {
    if (!byKey.has(row._id.itemKey)) byKey.set(row._id.itemKey, []);
    byKey.get(row._id.itemKey).push(Number(row.count) || 0);
  }
  return items.map((item) => {
    const counts = byKey.get(item.itemKey) || [];
    return {
      itemKey: item.itemKey,
      accounts: counts.filter((count) => count >= item.qty).length,
      totalCount: counts.reduce((sum, count) => sum + count, 0),
    };
  });
}

async function resolveEventPreview(event, tasks) {
  const eventTasks = tasksForEvent(event, tasks);
  const taskByCampaign = new Map();
  const setIds = [];
  for (const task of eventTasks) {
    const campaignId = String(task.campaignId || "");
    if (!taskByCampaign.has(campaignId)) taskByCampaign.set(campaignId, []);
    taskByCampaign.get(campaignId).push(task);
    const setId = task.listing && task.listing.setId;
    if (setId) setIds.push(String(setId));
  }
  const validSetIds = setIds.filter((id) => mongoose.isValidObjectId(id));
  const snapshots = validSetIds.length
    ? await DropSet.find({ _id: { $in: validSetIds } }).lean()
    : [];
  const snapshotById = new Map(snapshots.map((set) => [String(set._id), set]));

  const waves = await Promise.all(
    (event.waves || []).map(async (wave) => {
      const waveTasks = taskByCampaign.get(String(wave.campaignId || "")) || [];
      let items = [];
      let source = "";
      for (const task of waveTasks) {
        const setId = task.listing && task.listing.setId;
        const set = setId ? snapshotById.get(String(setId)) : null;
        if (set && set.items && set.items.length) {
          items = set.items;
          source = "listing snapshot";
          break;
        }
      }
      let error = "";
      if (!items.length) {
        try {
          items = await campaignItems(wave.campaignId, event.game, wave.name);
          source = "Twitch";
        } catch (err) {
          error = err.message || "Campaign rewards could not be resolved";
        }
      }
      return { ...wave, game: event.game, items, source, error };
    }),
  );
  const items = mergeWaveItems(waves);
  const logins = assignedLogins(eventTasks);
  const readyAccounts = items.length
    ? await availableAccountsForSet({
        items,
        accountScopeLogins: logins,
      })
    : [];
  const coverage = await itemCoverage(items, logins);
  const coverageByKey = new Map(coverage.map((row) => [row.itemKey, row]));
  const errors = waves
    .filter((wave) => wave.error)
    .map((wave) => ({
      campaignId: wave.campaignId,
      name: wave.name,
      message: wave.error,
    }));
  const existing = await DropSet.findOne({
    sourceType: "radar-event",
    sourceEventKey: event.id,
  })
    .sort({ updatedAt: -1 })
    .lean();

  return {
    event: {
      id: event.id,
      name: event.name,
      game: event.game,
      campaignIds: event.campaignIds,
    },
    waves: waves.map((wave) => ({
      campaignId: wave.campaignId,
      name: wave.name,
      label: wave.label,
      farm: wave.farm,
      source: wave.source,
      items: wave.items,
      error: wave.error,
    })),
    items: items.map((item) => ({
      ...item,
      coverage: coverageByKey.get(item.itemKey) || {
        accounts: 0,
        totalCount: 0,
      },
    })),
    assignedAccounts: logins.length,
    listingReadyAccounts: readyAccounts.length,
    errors,
    canCreate:
      items.length > 0 &&
      logins.length > 0 &&
      readyAccounts.length > 0 &&
      errors.length === 0,
    existingSetId: existing ? String(existing._id) : "",
  };
}

async function eventContext(eventIdValue) {
  const data = await loadRadarData(true, false, false);
  const event = data.events.find((candidate) => candidate.id === eventIdValue);
  return event ? { event, tasks: data.tasks } : null;
}

// Twitch campaigns + Epic giveaways for the Radar tab.
router.get("/api/radar/list", requireSuperadmin, async (req, res) => {
  try {
    const showEnded = String(req.query.ended || "") === "1";
    const data = await loadRadarData(showEnded);
    res.json({
      success: true,
      campaigns: data.campaigns,
      events: data.events,
      epic: data.epic,
      status: {
        twitch: campaignWatcher.status(),
        epic: epicWatcher.status(),
      },
    });
  } catch (err) {
    console.error("radar list error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get(
  "/api/radar/events/:eventId/listing-preview",
  requireSuperadmin,
  async (req, res) => {
    try {
      const context = await eventContext(req.params.eventId);
      if (!context) {
        return res
          .status(404)
          .json({ success: false, message: "Event not found" });
      }
      const preview = await resolveEventPreview(context.event, context.tasks);
      res.json({ success: true, ...preview });
    } catch (err) {
      console.error("radar event preview error:", err.message);
      res.status(500).json({
        success: false,
        message: err.message || "Could not build event preview",
      });
    }
  },
);

router.post(
  "/api/radar/events/:eventId/listing",
  requireSuperadmin,
  async (req, res) => {
    try {
      const context = await eventContext(req.params.eventId);
      if (!context) {
        return res
          .status(404)
          .json({ success: false, message: "Event not found" });
      }
      const preview = await resolveEventPreview(context.event, context.tasks);
      if (!preview.canCreate) {
        const reason = preview.errors.length
          ? "Every event wave must resolve before creating an accurate listing."
          : !preview.assignedAccounts
            ? "This event has no assigned farming accounts."
            : "No assigned account currently holds the complete event bundle.";
        return res
          .status(409)
          .json({ success: false, message: reason, preview });
      }

      const items = await Promise.all(
        preview.items.map(async (item) => {
          let image = String(item.image || "");
          if (image && !image.startsWith("/")) {
            image = (await cacheImage(image).catch(() => "")) || "";
          }
          return {
            itemKey: item.itemKey,
            name: item.name,
            game: item.game,
            image,
            qty: item.qty,
          };
        }),
      );
      const eventTasks = tasksForEvent(context.event, context.tasks);
      const scope = assignedLogins(eventTasks);
      let set = await DropSet.findOne({
        sourceType: "radar-event",
        sourceEventKey: context.event.id,
      }).sort({ updatedAt: -1 });
      let created = false;

      if (set) {
        const nextSignature = JSON.stringify(
          items.map((item) => [item.itemKey, item.qty]).sort(),
        );
        const currentSignature = JSON.stringify(
          (set.items || []).map((item) => [item.itemKey, item.qty]).sort(),
        );
        const liveMarketplace = await MarketplaceListing.exists({
          set: set._id,
          status: "active",
        });
        if (
          nextSignature !== currentSignature &&
          (set.listed || liveMarketplace)
        ) {
          return res.status(409).json({
            success: false,
            message:
              "This event listing is already live and its waves changed. Delist it before rebuilding the bundle.",
          });
        }
        set.name = context.event.game + " Twitch Drops - " + context.event.name;
        set.note = eventListingNote(context.event, items);
        set.items = items;
        set.accountScopeLogins = scope;
        set.sourceEventName = context.event.name;
        set.sourceCampaignIds = context.event.campaignIds;
        await set.save();
      } else {
        created = true;
        set = await DropSet.create({
          name: context.event.game + " Twitch Drops - " + context.event.name,
          note: eventListingNote(context.event, items),
          items,
          accountScopeLogins: scope,
          sourceType: "radar-event",
          sourceEventKey: context.event.id,
          sourceEventName: context.event.name,
          sourceCampaignIds: context.event.campaignIds,
        });
      }
      res.json({
        success: true,
        created,
        setId: String(set._id),
        listingsUrl:
          "/listings.html?publishSet=" + encodeURIComponent(String(set._id)),
      });
    } catch (err) {
      console.error("radar event listing error:", err.message);
      res.status(500).json({
        success: false,
        message: err.message || "Could not create event listing",
      });
    }
  },
);

// Manual "check now" — runs both watchers; either failing is reported but
// doesn't hide the other's result.
router.post("/api/radar/check", requireSuperadmin, async (req, res) => {
  const out = { success: true, twitch: null, epic: null, errors: [] };
  try {
    out.twitch = await campaignWatcher.runOnce();
  } catch (err) {
    out.errors.push("Twitch: " + (err.message || "check failed"));
  }
  try {
    out.epic = await epicWatcher.runOnce();
  } catch (err) {
    out.errors.push("Epic: " + (err.message || "check failed"));
  }
  out.status = { twitch: campaignWatcher.status(), epic: epicWatcher.status() };
  res.json(out);
});

module.exports = router;
