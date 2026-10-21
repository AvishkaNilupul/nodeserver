"use strict";
// Code shop — the start date of the event(s) a product's codes come from.
//
// A reward of one event can be redeemed only once per account, so buyers need
// to see which of our bundles share an event. The listing names an event by
// its START DATE only ("Event 11 Oct 2026"). The campaign's own title is never
// used in buyer text: it is machine-translated and can carry the platform,
// region or stage, and nothing a buyer reads may say where the codes come from.
//
// One event = one campaign group (slots.groupKeyOf: "<gameNo>:<campaignIdx>").
// Its date is the campaign's startDate; a group with no campaign row falls back
// to the earliest earnedAt of its ledger rows (every state, so it does not move
// as stock sells).

const KST_MS = 9 * 60 * 60 * 1000;
// "<gameNo>:<digits>" — groups named by a hashed title ("12:n…") or "12:none"
// have no campaign row to read.
const IDX_RE = /^[^:]*:(\d+)$/;

const text = (v) => (v === undefined || v === null ? "" : String(v));
const leanOf = (q) => (q && typeof q.lean === "function" ? q.lean() : q);

function toMs(v) {
  if (v === undefined || v === null || v === "") return null;
  const t = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

// A campaign row's real start, as ms, or null. Same rule as
// utils/soop/campaignStore.js: a v1 row has no `titleRaw` key and its dates
// were stored nine hours late.
function campaignStartMs(doc) {
  if (!doc || typeof doc !== "object") return null;
  const ms = toMs(doc.startDate);
  if (ms === null) return null;
  return Object.prototype.hasOwnProperty.call(doc, "titleRaw") ? ms : ms - KST_MS;
}

// models: { SoopCampaign, CodeStock } (either may be missing: that source is skipped).
// -> [Date], one per group with a known date, oldest first.
async function eventStarts(models, groupKeys) {
  const { SoopCampaign, CodeStock } = models || {};
  const keys = [...new Set((Array.isArray(groupKeys) ? groupKeys : []).map(text).filter(Boolean))];
  if (!keys.length) return [];

  const startOf = new Map(); // groupKey -> ms
  const idxOf = new Map();
  for (const k of keys) {
    const m = IDX_RE.exec(k);
    if (m) idxOf.set(k, m[1]);
  }
  if (idxOf.size && SoopCampaign) {
    const docs = await leanOf(
      SoopCampaign.find({ dropsIdx: { $in: [...new Set(idxOf.values())] } }, "dropsIdx startDate titleRaw"),
    );
    const byIdx = new Map((docs || []).map((d) => [text(d.dropsIdx), campaignStartMs(d)]));
    for (const [k, idx] of idxOf) {
      const ms = byIdx.get(idx);
      if (ms !== undefined && ms !== null) startOf.set(k, ms);
    }
  }

  const missing = keys.filter((k) => !startOf.has(k));
  if (missing.length && CodeStock) {
    const rows = await CodeStock.aggregate([
      { $match: { groupKey: { $in: missing }, earnedAt: { $ne: null } } },
      { $group: { _id: "$groupKey", at: { $min: "$earnedAt" } } },
    ]);
    for (const r of rows || []) {
      const ms = toMs(r && r.at);
      if (ms !== null) startOf.set(text(r._id), ms);
    }
  }

  return [...startOf.values()].sort((a, b) => a - b).map((ms) => new Date(ms));
}

module.exports = { eventStarts, campaignStartMs };
