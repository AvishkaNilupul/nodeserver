// Persistence for the AI coworker's memory, investigation log, and proposals.
// All server-side (MongoDB) so state survives across sessions and devices and
// can be audited. Every write is best-effort: a store failure must never break
// an investigation.
const CoworkerMemory = require("../models/CoworkerMemory");
const CoworkerLog = require("../models/CoworkerLog");
const CoworkerProposal = require("../models/CoworkerProposal");

const trunc = (s, n) => (typeof s === "string" && s.length > n ? s.slice(0, n) + "…" : s);
const rx = (s) =>
  new RegExp(String(s).slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

// Compact block of the coworker's most relevant memories, injected into the
// system prompt each session: all pinned, plus the most recently updated.
async function loadPromptMemories(limit = 40) {
  const rows = await CoworkerMemory.find({})
    .sort({ pinned: -1, updatedAt: -1 })
    .limit(limit)
    .lean();
  if (!rows.length) return "";
  return rows
    .map((m) => `- [${m.topic || "note"}] ${m.text}`)
    .join("\n");
}

async function recallMemory(query, limit = 12) {
  const filter = query
    ? { $or: [{ text: rx(query) }, { topic: rx(query) }, { key: rx(query) }] }
    : {};
  const rows = await CoworkerMemory.find(filter)
    .sort({ pinned: -1, updatedAt: -1 })
    .limit(Math.min(limit, 40))
    .lean();
  return rows.map((m) => ({ key: m.key, topic: m.topic, text: m.text, pinned: m.pinned }));
}

async function saveMemory({ key, topic, text, pinned }) {
  if (!key || !text) return { error: "key and text are required" };
  const slug = String(key).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
  await CoworkerMemory.updateOne(
    { key: slug },
    {
      $set: {
        topic: String(topic || "").slice(0, 40),
        text: String(text).slice(0, 1200),
        updatedAt: new Date(),
        ...(typeof pinned === "boolean" ? { pinned } : {}),
        source: "coworker",
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true },
  );
  return { saved: slug };
}

async function readLog(limit = 10, query) {
  const filter = query ? { $or: [{ question: rx(query) }, { answer: rx(query) }] } : {};
  const rows = await CoworkerLog.find(filter).sort({ at: -1 }).limit(Math.min(limit, 30)).lean();
  return rows.map((r) => ({
    at: r.at,
    question: trunc(r.question, 160),
    tools: r.tools,
    answer: trunc(r.answer, 400),
    proposals: r.proposalCount,
  }));
}

async function logRun(entry) {
  try {
    await CoworkerLog.create({
      at: new Date(),
      question: String(entry.question || "").slice(0, 500),
      mode: entry.mode || "analyst",
      actor: entry.actor || "",
      tools: (entry.tools || []).slice(0, 60),
      toolCount: (entry.tools || []).length,
      answer: String(entry.answer || "").slice(0, 6000),
      proposalCount: entry.proposalCount || 0,
      durationMs: entry.durationMs || 0,
      error: String(entry.error || "").slice(0, 300),
    });
  } catch (err) {
    console.error("coworker logRun error:", err.message);
  }
}

async function addProposal({ kind, title, detail, targets, severity, fromQuestion, actor }) {
  if (!title || !detail) return { error: "title and detail are required" };
  const doc = await CoworkerProposal.create({
    kind: String(kind || "other").slice(0, 20),
    title: String(title).slice(0, 200),
    detail: String(detail).slice(0, 6000),
    targets: (Array.isArray(targets) ? targets : []).map((t) => String(t).slice(0, 120)).slice(0, 20),
    severity: ["low", "medium", "high"].includes(severity) ? severity : "medium",
    fromQuestion: String(fromQuestion || "").slice(0, 300),
    actor: actor || "",
  });
  return { proposed: String(doc._id), kind: doc.kind, title: doc.title };
}

async function readProposals(status = "open", limit = 20) {
  const filter = status && status !== "all" ? { status } : {};
  const rows = await CoworkerProposal.find(filter).sort({ at: -1 }).limit(Math.min(limit, 50)).lean();
  return rows.map((p) => ({
    id: String(p._id),
    at: p.at,
    kind: p.kind,
    title: p.title,
    severity: p.severity,
    status: p.status,
    detail: trunc(p.detail, 500),
    targets: p.targets,
  }));
}

module.exports = {
  loadPromptMemories,
  recallMemory,
  saveMemory,
  readLog,
  logRun,
  addProposal,
  readProposals,
};
