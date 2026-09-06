const STALE_PROGRESS_MS = 12 * 60 * 60 * 1000;
const HISTORICAL_EVENT_NOTE_RE = /^Auto-farmed Twitch drops \(/;
// Preorder mirrors stamped from a live campaign (never orphan `autofarm:set:` keys).
const PREORDER_EVENT_KEY_RE = /^autofarm:(?!set:)/;
// Only preorders that started inside this window get a watch-minutes lookup.
const REQUIRED_MINUTES_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
// Duplicate-signature fold: lower rank survives.
const FOLD_KIND_RANK = { event: 0, stack: 1, orphan: 2 };

function norm(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function toMs(value) {
  if (value == null) return Date.now();
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : Date.now();
}

// Same rule as catalogPublic.signatureFor, re-implemented locally so this file
// stays dependency-free: "<itemKey>x<qty>|..." sorted; items without an
// itemKey are skipped; no items → "".
function signature(set) {
  return ((set && set.items) || [])
    .filter((item) => item && item.itemKey)
    .map((item) => `${item.itemKey}x${Math.max(1, Number(item.qty) || 1)}`)
    .sort()
    .join("|");
}

// Top-tier watch requirement of a campaign: max(items[].requiredMinutes) || 0.
function maxRequiredMinutes(items) {
  let max = 0;
  for (const item of Array.isArray(items) ? items : []) {
    const minutes = Number(item && item.requiredMinutes);
    if (Number.isFinite(minutes) && minutes > max) max = minutes;
  }
  return max;
}

// Duplicate-signature fold order: lower kind rank wins, then more stock, then
// a newer source.updatedAt (missing → oldest). Ties keep the first candidate.
function foldOrder(a, b) {
  return a.rank - b.rank || b.stock - a.stock || b.updated - a.updated;
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
    requiredWatchMinutes: maxRequiredMinutes(items),
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

let activePreorderRun = null;

// Module-level in-flight guard: while a run is in progress every caller gets
// the SAME promise, so overlapping schedulers never run twice or double-upsert.
function syncActivePreorders(opts) {
  if (activePreorderRun) return activePreorderRun;
  activePreorderRun = runActivePreorders(opts).finally(() => {
    activePreorderRun = null;
  });
  return activePreorderRun;
}

async function runActivePreorders({
  AutoFarmTask,
  DropSet,
  campaignItems,
  derivePrice,
  researchForGame,
  apply = true,
  now = new Date(),
  fillRequiredMinutes = true,
  fillLimit = 5,
} = {}) {
  const tasks = await AutoFarmTask.find(
    { status: "active", campaignId: { $exists: true, $nin: ["", null] } },
    {
      game: 1,
      campaignId: 1,
      campaignName: 1,
      campaignEndAt: 1,
      assignedAccounts: 1,
    },
  ).lean();
  const keys = tasks.map((task) => `autofarm:${task.campaignId}`);
  const existing = tasks.length
    ? await DropSet.find(
        { sourceType: "autofarm_event", sourceEventKey: { $in: keys } },
        { sourceEventKey: 1 },
      ).lean()
    : [];
  const existingKeys = new Set(
    existing.map((set) => String(set.sourceEventKey)),
  );
  let stamped = 0;
  for (const task of tasks) {
    if (existingKeys.has(`autofarm:${task.campaignId}`)) continue;
    stamped++;
    if (!apply) continue;
    const research = researchForGame ? await researchForGame(task.game) : null;
    await stampPreorderSet(task, {
      DropSet,
      campaignItems,
      derivePrice,
      research,
      now,
    });
  }
  // Backfill requiredWatchMinutes on recent live preorders that were stamped
  // before the field existed (or whose lookup yielded 0). Bounded per run;
  // -1 marks "looked up, unknown" so a set is never retried forever.
  let filled = 0;
  const limit = Math.max(0, Math.floor(Number(fillLimit) || 0));
  if (
    apply &&
    fillRequiredMinutes &&
    limit > 0 &&
    typeof campaignItems === "function"
  ) {
    const pending = await DropSet.find(
      {
        sourceType: "autofarm_event",
        catalogState: "preorder",
        listed: true,
        sourceEventKey: PREORDER_EVENT_KEY_RE,
        farmStartedAt: {
          $gte: new Date(toMs(now) - REQUIRED_MINUTES_WINDOW_MS),
        },
        $or: [
          { requiredWatchMinutes: { $exists: false } },
          { requiredWatchMinutes: 0 },
        ],
      },
      { sourceEventKey: 1, sourceEventName: 1, "items.game": 1 },
      { limit },
    ).lean();
    for (const set of (pending || []).slice(0, limit)) {
      const campaignId = String(set.sourceEventKey || "").slice(
        "autofarm:".length,
      );
      if (!campaignId) continue;
      let items = [];
      try {
        items = await campaignItems(
          campaignId,
          set.items?.[0]?.game || "",
          set.sourceEventName,
        );
      } catch (err) {
        console.error("catalog preorder watch minutes:", err.message);
      }
      const minutes = maxRequiredMinutes(items);
      await DropSet.updateOne(
        { _id: set._id },
        { $set: { requiredWatchMinutes: minutes > 0 ? minutes : -1 } },
      );
      filled++;
    }
  }
  return { candidates: tasks.length, stamped, filled };
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
    return {
      candidates: 0,
      stocked: 0,
      published: 0,
      preordered: 0,
      retired: 0,
      deduped: 0,
    };
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
      preordered: 0,
      retired: 0,
      deduped: 0,
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
  // Fold duplicates: the same game + identical items×qty publishes ONE mirror.
  // Losers are never published and their listed mirrors are retired. Empty
  // signatures (items without itemKeys) are never grouped.
  const groups = new Map();
  for (const row of usable) {
    const source = sourceById.get(row.setId);
    const sig = signature(source);
    if (!sig) continue;
    const game = String(source.items[0]?.game || "").toLowerCase();
    const groupKey = `${game}::${sig}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(row);
  }
  const folded = new Set();
  let deduped = 0;
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    const scored = rows.map((row) => {
      const source = sourceById.get(row.setId);
      return {
        row,
        rank: FOLD_KIND_RANK[row.kind] ?? 9,
        stock: stockMap.get(String(source._id))?.stock || 0,
        updated: new Date(source.updatedAt).getTime() || 0,
      };
    });
    const best = scored.reduce((keep, entry) =>
      foldOrder(entry, keep) < 0 ? entry : keep,
    ).row;
    for (const row of rows) {
      if (row === best) continue;
      folded.add(row);
      const current = existingByKey.get(row.key);
      if (!current || !current.listed) continue;
      deduped++;
      if (!apply) continue;
      await DropSet.updateOne(
        { _id: current._id },
        { $set: { listed: false } },
      );
    }
  }
  let stocked = 0;
  let published = 0;
  let preordered = 0;
  let retired = 0;
  for (const row of usable) {
    if (folded.has(row)) continue;
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
    // Tasks that were already active before the preorder feature was deployed
    // have no mirror yet. Seed those mirrors from the existing event DropSet
    // so the first scheduled sync does not leave current farming invisible.
    if (
      !current &&
      row.kind !== "orphan" &&
      ["active", "planned"].includes(row.task.status)
    ) {
      preordered++;
      if (!apply) continue;
      const eventName = row.task.campaignName || source.name;
      await DropSet.updateOne(
        { sourceType: "autofarm_event", sourceEventKey: row.key },
        {
          $set: {
            name: source.name,
            note: `Pre-order for ${eventName}. Delivery begins when a farmed account completes the bundle.`,
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
            sourceCampaignIds: [String(row.task.campaignId)],
            catalogState: "preorder",
            farmStartedAt: now,
            campaignEndAt: row.task.campaignEndAt || null,
            expectedUnits: (row.task.assignedAccounts || []).length,
            autoFarmTaskId: String(row.task._id),
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
  return {
    candidates: usable.length,
    stocked,
    published,
    preordered,
    retired,
    deduped,
  };
}

module.exports = {
  STALE_PROGRESS_MS,
  signature,
  computePreorderEta,
  stampPreorderSet,
  syncActivePreorders,
  syncHistoricalEventSets,
};
