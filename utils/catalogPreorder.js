const STALE_PROGRESS_MS = 12 * 60 * 60 * 1000;
const HISTORICAL_EVENT_NOTE_RE = /^Auto-farmed Twitch drops \(/;

function norm(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function computePreorderEta(accounts, campaignName, now = new Date()) {
  const rows = [];
  const percents = [];
  for (const account of accounts || []) {
    const snapshot = account.farmingSnapshotAt
      ? new Date(account.farmingSnapshotAt)
      : null;
    const progress = (account.farmingProgress || []).filter((row) => {
      if (!row || row.connected === true || !row.game) return false;
      if (!campaignName) return true;
      return norm(row.campaign) === norm(campaignName);
    });
    if (!progress.length) continue;
    percents.push(
      ...progress.map((row) =>
        Math.max(0, Math.min(100, Number(row.percent) || 0)),
      ),
    );
    const remaining = progress
      .map((row) =>
        Math.max(0, (Number(row.required) || 0) - (Number(row.current) || 0)),
      )
      .filter(Number.isFinite);
    rows.push({
      remaining: remaining.length ? Math.max(...remaining) : 0,
      snapshot,
    });
  }
  if (!rows.length) return {};
  const progressPercent =
    Math.round(
      (percents.reduce((sum, percent) => sum + percent, 0) / percents.length) *
        10,
    ) / 10;
  const stale = rows.some(
    (row) => !row.snapshot || now - row.snapshot > STALE_PROGRESS_MS,
  );
  const result = { progressPercent };
  if (!stale) {
    result.readyInMinutes = Math.max(
      0,
      Math.round(
        Math.min(
          ...rows.map(
            (row) =>
              row.remaining - Math.max(0, now - row.snapshot.getTime()) / 60000,
          ),
        ),
      ),
    );
  }
  return result;
}

async function stampPreorderSet(
  task,
  { DropSet, campaignItems, derivePrice, research },
) {
  if (!task || !task._id || !task.campaignId) return null;
  let items;
  try {
    items = await campaignItems(task.campaignId, task.game, task.campaignName);
  } catch (err) {
    console.error("catalog preorder campaign items:", err.message);
    return null;
  }
  if (!Array.isArray(items) || !items.length) return null;
  const price = derivePrice(research);
  const doc = {
    name: `${task.game} — ${task.campaignName || task.campaignId}`,
    note: `Pre-order for ${task.campaignName || task.game}. Delivery begins when a farmed account completes the bundle.`,
    items: items.map((item) => ({
      itemKey: item.itemKey,
      name: item.name,
      game: item.game,
      image: item.image,
      qty: Math.max(1, Number(item.qty) || 1),
    })),
    sourceType: "autofarm_event",
    sourceEventKey: `autofarm:${task.campaignId}`,
    sourceEventName: task.campaignName || task.campaignId,
    listed: true,
    publicCatalog: true,
    custom: false,
    price,
    catalogState: "preorder",
    campaignEndAt: task.campaignEndAt || null,
    expectedUnits: (task.assignedAccounts || []).length,
    autoFarmTaskId: String(task._id),
  };
  return DropSet.updateOne(
    { sourceType: doc.sourceType, sourceEventKey: doc.sourceEventKey },
    { $set: doc, $setOnInsert: { farmStartedAt: new Date() } },
    { upsert: true },
  );
}

function mirrorKey(task, kind) {
  return kind === "stack"
    ? `autofarm-stack:${task._id}`
    : `autofarm:${task.campaignId}`;
}

function orphanMirrorKey(set) {
  return `autofarm:set:${set._id}`;
}

function sourceSetId(task, kind) {
  return kind === "stack" ? task.stackListing?.setId : task.listing?.setId;
}

async function syncHistoricalEventSets({
  AutoFarmTask,
  DropSet,
  stockForSets,
  apply = true,
  now = new Date(),
}) {
  const tasks = await AutoFarmTask.find(
    {
      $or: [
        { "listing.setId": { $exists: true, $nin: ["", null] } },
        { "stackListing.setId": { $exists: true, $nin: ["", null] } },
      ],
    },
    {
      game: 1,
      campaignId: 1,
      campaignName: 1,
      campaignEndAt: 1,
      assignedAccounts: 1,
      status: 1,
      "listing.setId": 1,
      "stackListing.setId": 1,
    },
  ).lean();
  const candidates = [];
  const taskSetIds = new Set();
  for (const task of tasks) {
    for (const kind of ["event", "stack"]) {
      const setId = sourceSetId(task, kind);
      if (!setId || !task.campaignId) continue;
      taskSetIds.add(String(setId));
      candidates.push({
        task,
        kind,
        setId: String(setId),
        key: mirrorKey(task, kind),
      });
    }
  }
  const referencedSetIds = [...taskSetIds];
  const sourceSets = await DropSet.find(
    referencedSetIds.length
      ? {
          $or: [
            { _id: { $in: referencedSetIds } },
            { custom: true, note: HISTORICAL_EVENT_NOTE_RE },
          ],
        }
      : { custom: true, note: HISTORICAL_EVENT_NOTE_RE },
  ).lean();
  for (const source of sourceSets) {
    if (taskSetIds.has(String(source._id))) continue;
    candidates.push({
      task: {
        _id: "",
        campaignId: "",
        campaignName: source.name,
        campaignEndAt: null,
        assignedAccounts: [],
      },
      kind: "orphan",
      setId: String(source._id),
      key: orphanMirrorKey(source),
    });
  }
  if (!candidates.length) {
    return { candidates: 0, stocked: 0, published: 0, retired: 0 };
  }
  const sourceById = new Map(sourceSets.map((set) => [String(set._id), set]));
  const usable = candidates.filter((row) => {
    const set = sourceById.get(row.setId);
    return set && (set.items || []).length && Number(set.price) > 0;
  });
  if (!usable.length) {
    return {
      candidates: candidates.length,
      stocked: 0,
      published: 0,
      retired: 0,
    };
  }
  const existing = await DropSet.find({
    sourceType: "autofarm_event",
    sourceEventKey: { $in: usable.map((row) => row.key) },
  }).lean();
  const existingByKey = new Map(
    existing.map((set) => [String(set.sourceEventKey || ""), set]),
  );
  const stockMap = await stockForSets(
    usable.map((row) => sourceById.get(row.setId)),
  );
  let stocked = 0;
  let published = 0;
  let retired = 0;
  for (const row of usable) {
    const source = sourceById.get(row.setId);
    const stock = stockMap.get(String(source._id))?.stock || 0;
    const current = existingByKey.get(row.key);
    if (stock > 0) {
      stocked++;
      if (!apply) continue;
      const eventName =
        row.kind === "stack"
          ? source.name
          : row.task.campaignName || source.name;
      await DropSet.updateOne(
        { sourceType: "autofarm_event", sourceEventKey: row.key },
        {
          $set: {
            name: source.name,
            note: source.note,
            items: (source.items || []).map((item) => ({
              itemKey: item.itemKey,
              name: item.name,
              game: item.game,
              image: item.image,
              qty: Math.max(1, Number(item.qty) || 1),
            })),
            price: Number(source.price) || 0,
            listed: true,
            publicCatalog: true,
            custom: false,
            sourceType: "autofarm_event",
            sourceEventKey: row.key,
            sourceEventName: eventName,
            sourceCampaignIds: row.task.campaignId
              ? [String(row.task.campaignId)]
              : [],
            catalogState: "instock",
            campaignEndAt: row.task.campaignEndAt || null,
            expectedUnits: (row.task.assignedAccounts || []).length,
            autoFarmTaskId: row.task._id ? String(row.task._id) : "",
          },
          $setOnInsert: {
            bulkMinQty: 5,
            bulkDiscountPct: 8,
            publicFeatured: false,
            publicSort: 0,
          },
        },
        { upsert: true },
      );
      published++;
      continue;
    }
    if (!current || current.catalogState === "preorder" || !apply) continue;
    const campaignExpired =
      current.campaignEndAt && new Date(current.campaignEndAt) < now;
    if (current.farmStartedAt && !campaignExpired) {
      await DropSet.updateOne(
        { _id: current._id },
        { $set: { catalogState: "soldout", listed: true } },
      );
    } else {
      await DropSet.updateOne(
        { _id: current._id },
        { $set: { listed: false } },
      );
    }
    retired++;
  }
  return { candidates: usable.length, stocked, published, retired };
}

module.exports = {
  STALE_PROGRESS_MS,
  computePreorderEta,
  stampPreorderSet,
  syncHistoricalEventSets,
};
