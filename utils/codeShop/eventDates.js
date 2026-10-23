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
// as stock sells). "<gameNo>:none" holds every code that matched no campaign:
// it is not one event, so it never gets a date.

const KST_MS = 9 * 60 * 60 * 1000;
// "<gameNo>:<digits>" — groups named by a hashed title ("12:n…") or "12:none"
// have no campaign row to read.
const IDX_RE = /^[^:]*:(\d+)$/;
const NO_EVENT_RE = /^[^:]*:none$/;
// "<gameNo>:chzzk-<campaignNo>" — a CHZZK campaign (sources.js); its startAt is UTC.
const CHZZK_RE = /^[^:]*:chzzk-(\d+)$/;

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

// models: { SoopCampaign, ChzzkCampaign, CodeStock } (any may be missing: that source is skipped).
// -> one entry per distinct group: its start Date, or null when it has none
// (dates oldest first, nulls last). The length is the number of events, so a
// caller never calls two events "this event" because they share a day.
async function eventStarts(models, groupKeys) {
  const { SoopCampaign, ChzzkCampaign, CodeStock } = models || {};
  const all = [...new Set((Array.isArray(groupKeys) ? groupKeys : []).map(text).filter(Boolean))];
  if (!all.length) return [];
  const keys = all.filter((k) => !NO_EVENT_RE.test(k));

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

  const chzzkOf = new Map();
  for (const k of keys) {
    const m = CHZZK_RE.exec(k);
    if (m) chzzkOf.set(k, Number(m[1]));
  }
  if (chzzkOf.size && ChzzkCampaign) {
    const docs = await leanOf(ChzzkCampaign.find({ campaignNo: { $in: [...new Set(chzzkOf.values())] } }, "campaignNo startAt"));
    const byNo = new Map((docs || []).map((d) => [Number(d.campaignNo), toMs(d.startAt)]));
    for (const [k, no] of chzzkOf) {
      const ms = byNo.get(no);
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

  const known = [...startOf.values()].sort((a, b) => a - b).map((ms) => new Date(ms));
  return [...known, ...Array(all.length - known.length).fill(null)];
}

module.exports = { eventStarts, campaignStartMs };
