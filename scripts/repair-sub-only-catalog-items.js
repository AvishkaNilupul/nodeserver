// One-time repair for the storefront cards of campaigns that have a
// subscriber-only drop (run on the server, from the repo root).
//
// Until utils/autoLister.resolveCampaignItems skipped drops with
// requiredSubs > 0, a campaign's item list included rewards only a paying
// subscriber gets. The auto-farm stamps that list onto the campaign's catalog
// card (utils/catalogPreorder.stampPreorderSet), so the storefront advertised
// items no farmed account can ever hold: on 2026-10-08, 8 of the 9 public
// pre-order cards — two that mixed watch drops with a sub drop (CONTROL
// Resonant, PAYDAY 3) and six whose only reward was a sub badge.
//
// New cards are right once the code is in place; a card that already exists is
// never re-stamped (syncActivePreorders skips a campaign that has one). This
// takes the unearnable items off the existing cards:
//
//   - a card with earnable items left keeps those. While its campaign is still
//     running it stays listed and comes IN STOCK the usual way, as accounts do
//     hold what is left — which makes it buyable, in the internal Shop and on
//     the public storefront, exactly as a normal campaign's card is. Run this
//     only once selling those bundles has been agreed;
//   - the same card for a campaign that has ENDED is also taken off the
//     storefront. With its items corrected it would read as in stock, and a
//     repair must not put a new offer on sale — that is the owner's call;
//   - a card with nothing earnable left is taken off the storefront
//     (`listed: false`) — there is nothing to sell behind it.
//
// An item is only ever removed when NO account has ever held it. The same
// reward can be subscriber-only in one campaign and a watch drop in another
// (Predecessor's loot cores: 338 accounts hold them), and that item stays.
//
// It writes `items` and/or `listed` on DropSet rows of sourceType
// "autofarm_event" whose key is a campaign ("autofarm:<campaignId>"), and
// nothing else: no marketplace call, no marketplace listing row, no task, no
// account, no reservation. The rows it changes are saved to a JSON file first
// (_bk_sub_only_catalog_repair_<time>.json, a name .gitignore already covers).
//
// Run it AFTER the new utils/autoLister.js is live (before that, the next
// campaign to start is stamped the old way). Safe to run again: a second run
// finds nothing to do.
//
//   node scripts/repair-sub-only-catalog-items.js            # dry run (no writes)
//   node scripts/repair-sub-only-catalog-items.js --apply    # write
const { isWatchableDrop, watchabilityKnown } = require("../utils/campaignFarmability");

const CAMPAIGN_KEY_RE = /^autofarm:(?!set:)/;

const campaignIdOf = (set) => String((set && set.sourceEventKey) || "").replace(/^autofarm:/, "");

// Item keys of this manifest that EVERY drop granting them needs a subscription
// for. A key a watch drop also gives is earnable and is not in the set.
function subOnlyKeysOf(manifest) {
  const drops = (manifest && manifest.drops) || [];
  const watchable = new Set(drops.filter(isWatchableDrop).map((d) => d.itemKey));
  return new Set(
    drops
      .filter((d) => !isWatchableDrop(d))
      .map((d) => d.itemKey)
      .filter((k) => k && !watchable.has(k)),
  );
}

/**
 * Pure: what to do with each catalog card.
 * @param {object[]} sets       campaign cards { _id, name, sourceEventKey, items, listed, catalogState, campaignEndAt }
 * @param {object[]} manifests  CampaignDrops rows { campaignId, watchVersion, drops:[{ itemKey, requiredSubs }] }
 *                              — the cards' own campaigns and every manifest with a subscriber-only drop
 * @param {Iterable<string>} everHeld  item keys at least one account has held, in any state
 * @param {Map<string, boolean>} [campaignEnded]  campaignId -> is it over, for the campaigns
 *                              Twitch still has a row for. That answer wins: a card keeps the
 *                              end date it was stamped with, and campaigns get extended. Only a
 *                              campaign with no row is judged by its card's own campaignEndAt.
 * @param {Date|number} now
 * @returns {object[]} one row per card that names an unearnable item:
 *   { setId, name, campaignId, listed, catalogState, updatedAt, ended, basis, before, remove, keep, action, write }
 *   action: "trim" (keep the earnable items) | "trim-hide" (the same, and off the storefront:
 *           the campaign has ended) | "unlist" (nothing earnable; hide it) |
 *           "none" (nothing earnable, already hidden)
 *   write:  the fields to $set, or null for "none"
 *   basis:  "manifest" (the card's own campaign says so) | "ended" (its campaign has ended
 *           and its manifest predates the subscription field; another campaign marks the
 *           same reward subscriber-only)
 */
function planRepair({ sets, manifests, everHeld, campaignEnded, now = Date.now() }) {
  const byCampaign = new Map();
  const subOnlyAnywhere = new Set();
  for (const m of manifests || []) {
    if (!m || !m.campaignId) continue;
    byCampaign.set(String(m.campaignId), m);
    if (watchabilityKnown(m)) for (const k of subOnlyKeysOf(m)) subOnlyAnywhere.add(k);
  }
  const held = new Set(everHeld || []);
  const endedBy = campaignEnded instanceof Map ? campaignEnded : new Map();
  const nowMs = new Date(now).getTime();
  const out = [];
  for (const set of sets || []) {
    if (!set || !CAMPAIGN_KEY_RE.test(String(set.sourceEventKey || ""))) continue;
    const id = campaignIdOf(set);
    const own = byCampaign.get(id);
    const ended = endedBy.has(id)
      ? !!endedBy.get(id)
      : !!(set.campaignEndAt && new Date(set.campaignEndAt).getTime() < nowMs);
    let subOnly;
    let basis;
    if (watchabilityKnown(own)) {
      subOnly = subOnlyKeysOf(own);
      basis = "manifest";
    } else {
      // No word from the card's own campaign. Only an ENDED campaign is judged
      // on other evidence: nobody can earn anything from it any more, so an
      // item no account has ever held is one it will never deliver.
      if (!ended) continue;
      subOnly = subOnlyAnywhere;
      basis = "ended";
    }
    const items = set.items || [];
    const remove = items.filter((i) => i && subOnly.has(i.itemKey) && !held.has(i.itemKey));
    if (!remove.length) continue;
    const gone = new Set(remove.map((i) => i.itemKey));
    const keep = items.filter((i) => i && !gone.has(i.itemKey));
    const listed = !!set.listed;
    let action;
    let write;
    if (!keep.length) {
      action = listed ? "unlist" : "none";
      write = listed ? { listed: false } : null;
    } else if (ended && listed) {
      action = "trim-hide";
      write = { items: keep, listed: false };
    } else {
      action = "trim";
      write = { items: keep };
    }
    out.push({
      setId: String(set._id),
      name: String(set.name || ""),
      campaignId: id,
      listed,
      catalogState: String(set.catalogState || ""),
      updatedAt: set.updatedAt || null,
      ended,
      basis,
      before: items,
      remove,
      keep,
      action,
      write,
    });
  }
  return out;
}

const names = (items) => (items || []).map((i) => i.name + (Number(i.qty) > 1 ? " x" + i.qty : "")).join(" + ") || "(nothing)";

// Is this campaign over? Its end date decides when Twitch gave one. The status
// alone does not: the campaign watcher marks a campaign EXPIRED the first time
// it is missing from one dashboard read.
const isOver = (c, nowMs) => (c.endAt ? new Date(c.endAt).getTime() < nowMs : c.status === "EXPIRED");

/**
 * Read, plan, report — and write when `apply`. Uses the open mongoose connection.
 * @returns {{ plan: object[], written: number, backup: string }}
 */
async function run({ apply = false, log = console.log, now = Date.now(), backupDir = "." } = {}) {
  const fs = require("fs");
  const path = require("path");
  const CampaignDrops = require("../models/CampaignDrops");
  const TwitchCampaign = require("../models/TwitchCampaign");
  const DropSet = require("../models/DropSet");
  const DropLog = require("../models/DropLog");
  const CatalogInquiry = require("../models/CatalogInquiry");
  const { AVAILABLE_DROP } = require("../utils/dropReservation");
  const nowMs = new Date(now).getTime();

  const subManifests = await CampaignDrops.find(
    { watchVersion: { $gte: 1 }, "drops.requiredSubs": { $gt: 0 } },
    { campaignId: 1, watchVersion: 1, drops: 1 },
  ).lean();
  const subKeys = [...new Set(subManifests.flatMap((m) => [...subOnlyKeysOf(m)]))];
  const sets = subKeys.length
    ? await DropSet.find({ sourceType: "autofarm_event", sourceEventKey: CAMPAIGN_KEY_RE, "items.itemKey": { $in: subKeys } }).lean()
    : [];
  const ownIds = [...new Set(sets.map(campaignIdOf).filter(Boolean))];
  const ownManifests = ownIds.length
    ? await CampaignDrops.find({ campaignId: { $in: ownIds } }, { campaignId: 1, watchVersion: 1, drops: 1 }).lean()
    : [];
  const everHeld = subKeys.length
    ? (await DropLog.aggregate([{ $match: { itemKey: { $in: subKeys } } }, { $group: { _id: "$itemKey" } }])).map((r) => r._id)
    : [];
  const campaigns = ownIds.length
    ? await TwitchCampaign.find({ campaignId: { $in: ownIds } }, { campaignId: 1, status: 1, endAt: 1 }).lean()
    : [];
  const campaignEnded = new Map(campaigns.map((c) => [String(c.campaignId), isOver(c, nowMs)]));
  // Own manifests last: for a campaign in both lists they are the same row.
  const plan = planRepair({ sets, manifests: [...subManifests, ...ownManifests], everHeld, campaignEnded, now });

  log(
    "campaigns with a subscriber-only drop: " + subManifests.length + " | subscriber-only rewards: " + subKeys.length +
      " (" + everHeld.length + " of them held by some account — those are never removed)",
  );
  log("campaign cards naming one of those rewards: " + sets.length + " | to change: " + plan.filter((p) => p.action !== "none").length);

  for (const p of plan) {
    let outcome = "nothing earnable is left; already hidden, nothing to write";
    if (p.action === "unlist") outcome = "nothing earnable is left -> taken off the storefront";
    if (p.keep.length) {
      // A rough count (no password or copy-count check): enough to say whether
      // anything stands behind the card once it is corrected.
      const keys = [...new Set(p.keep.map((i) => i.itemKey))];
      const rows = await DropLog.aggregate([
        { $match: { itemKey: { $in: keys }, ...AVAILABLE_DROP } },
        { $group: { _id: { account: "$account", k: "$itemKey" } } },
        { $group: { _id: "$_id.account", have: { $sum: 1 } } },
        { $match: { have: keys.length } },
        { $count: "n" },
      ]);
      const n = (rows[0] && rows[0].n) || 0;
      outcome = "keep:   " + names(p.keep) + " | accounts holding that, unsold: about " + n;
      if (p.action === "trim-hide") outcome += " -> campaign over: taken off the storefront, not put on sale";
      else if (!p.listed) outcome += " -> stays hidden";
      else outcome += n ? " -> the card comes IN STOCK: buyable in the Shop and on the storefront" : " -> the card stays " + p.catalogState;
    }
    log(
      "  " + (p.action === "none" ? "leave" : apply ? p.action : "would " + p.action) + "  " + p.name +
        " [" + p.catalogState + ", " + (p.listed ? "on the storefront" : "hidden") + ", campaign " + (p.ended ? "over" : "running") + ", by " + p.basis + "]" +
        "\n      now:    " + names(p.before) +
        "\n      remove: " + names(p.remove) +
        "\n      " + outcome,
    );
  }

  const todo = plan.filter((p) => p.action !== "none");
  // Someone asking about a card is worth knowing before it changes under them.
  const asked = todo.length
    ? await CatalogInquiry.countDocuments({ listing: { $in: todo.map((p) => p.setId) }, status: { $in: ["new", "contacted"] } })
    : 0;
  if (asked) log("OPEN customer inquiries on those cards: " + asked + " — read them (catalog admin) before applying");

  if (!apply || !todo.length) {
    log(apply ? "nothing to write" : "dry run: nothing written (pass --apply to write)");
    return { plan, written: 0, backup: "" };
  }
  // To the millisecond: a copy is never written over an earlier one ("wx").
  const stamp = new Date().toISOString().replace(/[-:.Z]/g, "");
  const backup = path.join(backupDir, "_bk_sub_only_catalog_repair_" + stamp + ".json");
  fs.writeFileSync(
    backup,
    JSON.stringify({ at: new Date().toISOString(), restore: "DropSet.updateOne({ _id }, { $set: { items, listed } }) per row", sets: todo.map((p) => ({ _id: p.setId, name: p.name, listed: p.listed, items: p.before })) }, null, 2),
    { flag: "wx" },
  );
  log("rows as they were: " + backup);
  let written = 0;
  for (const p of todo) {
    // Guarded at the write: a card something else touched since the read is left for the next run.
    const r = await DropSet.updateOne(
      { _id: p.setId, sourceType: "autofarm_event", updatedAt: p.updatedAt },
      { $set: p.write },
    );
    if (r.modifiedCount) written += 1;
    else log("  skipped " + p.name + ": changed since it was read — run again");
  }
  log("changed " + written + " of " + todo.length + " card(s). The storefront picks it up within its 5-minute cache.");
  return { plan, written, backup };
}

async function main() {
  require("dotenv").config({ quiet: true });
  const mongoose = require("mongoose");
  // MONGO_URI is the one the app itself connects with (config/config.js).
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI, { autoIndex: false, autoCreate: false });
  try {
    console.log("database: " + mongoose.connection.name + " @ " + mongoose.connection.host);
    await run({ apply: process.argv.includes("--apply") });
  } finally {
    await mongoose.disconnect();
  }
}

module.exports = { planRepair, run, subOnlyKeysOf, campaignIdOf, CAMPAIGN_KEY_RE };

if (require.main === module) {
  main().catch((e) => {
    console.error("repair failed: " + (e && e.message ? e.message : e));
    process.exit(1);
  });
}
