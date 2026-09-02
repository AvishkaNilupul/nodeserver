// AI chatbot proxy.
//
// A thin, server-side proxy in front of an OpenAI-compatible chat API
// (AgentRouter → DeepSeek by default; see config.AI). The browser never sees
// the API key: the page POSTs the running conversation to /ai-chat/send and we
// forward it upstream with the key attached, then stream the reply straight
// back so the UI can render tokens as they arrive.
//
// Mounted behind requireAdmin + enforce2fa in server.js, so only a logged-in
// operator can spend the key's credits.
const express = require("express");
const config = require("../config/config");
const { SCHEMAS, runTool, toolNames } = require("../utils/aiTools");
const store = require("../utils/coworkerStore");

const router = express.Router();

// Shared headers for every upstream call. AgentRouter fingerprints its clients
// and 401s anything that doesn't look like the Codex CLI (see config.AI).
function upstreamHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.AI.apiKey}`,
    "User-Agent": config.AI.userAgent,
    originator: config.AI.originator,
  };
}

// Guard against a runaway prompt: cap how much we accept and forward.
const MAX_MESSAGES = 40;
const MAX_CHARS = 24000; // total characters across all message contents

function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return null;
  const allowed = new Set(["system", "user", "assistant"]);
  const msgs = [];
  let chars = 0;
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const role = allowed.has(m.role) ? m.role : "user";
    const content = typeof m.content === "string" ? m.content : "";
    if (!content) continue;
    chars += content.length;
    if (chars > MAX_CHARS) break;
    msgs.push({ role, content });
    if (msgs.length >= MAX_MESSAGES) break;
  }
  return msgs.length ? msgs : null;
}

// Lightweight config for the page header (never exposes the key).
router.get("/ai-chat/config", (req, res) => {
  res.json({ model: config.AI.model, configured: Boolean(config.AI.apiKey) });
});

// Streams the model reply back to the client as Server-Sent Events. We simply
// relay the upstream SSE bytes (OpenAI-style `data: {...}` chunks); the page
// parses them. On any upstream failure we emit one `event: error` frame.
router.post("/ai-chat/send", async (req, res) => {
  if (!config.AI.apiKey) {
    return res.status(503).json({
      success: false,
      message:
        "AI chat is not configured. Set AGENTROUTER_API_KEY in .env and restart.",
    });
  }

  const messages = sanitizeMessages(req.body?.messages);
  if (!messages) {
    return res
      .status(400)
      .json({ success: false, message: "No messages provided." });
  }

  // Prepend a system prompt if the client didn't send one.
  if (messages[0]?.role !== "system") {
    messages.unshift({
      role: "system",
      content:
        "You are a helpful, concise assistant. Answer directly and use " +
        "Markdown for code and lists.",
    });
  }

  const controller = new AbortController();
  // If the browser hangs up, stop billing the upstream request.
  res.on("close", () => controller.abort());

  let upstream;
  try {
    upstream = await fetch(`${config.AI.baseUrl}/chat/completions`, {
      method: "POST",
      headers: upstreamHeaders(),
      body: JSON.stringify({
        model: config.AI.model,
        messages,
        stream: true,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) return;
    console.error("ai-chat upstream error:", err.message);
    return res
      .status(502)
      .json({ success: false, message: "Could not reach the AI provider." });
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    console.error("ai-chat upstream status:", upstream.status, detail.slice(0, 500));
    return res.status(502).json({
      success: false,
      message: `AI provider returned ${upstream.status}.`,
    });
  }

  // Relay the stream verbatim to the browser.
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // stop nginx buffering the stream
  res.flushHeaders?.();

  try {
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      console.error("ai-chat stream error:", err.message);
      res.write(`event: error\ndata: ${JSON.stringify(err.message)}\n\n`);
    }
  } finally {
    res.end();
  }
});

// ---- Analyst mode: a read-only, tool-using agent loop ----------------------
//
// Unlike /ai-chat/send (a pure streaming relay), this runs a function-calling
// loop server-side: the model may call the read-only tools in utils/aiTools.js
// to investigate the live system, and we feed the results back until it answers.
// It CANNOT act on prod — only the read-only tool set is exposed. Non-streaming
// so the tool round-trips stay simple; the page shows a tool trace then the
// answer.
// The coworker's standing brief. Kept explicit and concrete because the model
// is a smaller/cheaper one — clear guidance makes it perform well.
const ANALYST_BASE = [
  "You are the ops coworker for RedeemHub — a Twitch drop-farming and game-account",
  "selling operation running on this Node/Express + MongoDB server. You are a sharp,",
  "skeptical analyst who investigates with tools before answering and reasons across",
  "subsystems the way a human operator would.",
  "",
  "THE OPERATION (pipeline): bots on hosts (server + a Raspberry Pi 'pi') farm Twitch",
  "drops on pooled accounts → farmed drops become sellable sets/bundles → those get",
  "listed & priced across many marketplaces (plati, ggsel, zeusx, digiseller, g2g,…)",
  "→ buyers order and accounts are delivered. An auto-farm engine decides which games",
  "to farm from demand/coverage; there are existing FAILSAFES (auto-heal, park-when-",
  "farmed, Stream Scout, bot-health) that you must respect and never second-guess.",
  "",
  "YOUR TOOLS:",
  "- recall_memory / read_log FIRST — reuse what you already know and found before.",
  "- event_summary then query_events — the SystemEvent audit trail (what happened).",
  "- fleet_trend — counts over time (drops? bans? pool draining?).",
  "- pm2_status — process health.",
  "- db_query / db_count / db_group — read marketplaces, pricing (drop_sets,",
  "  marketplace_listings), farming (autofarm_tasks), demand (market_research,",
  "  sale_signals), pool_accounts, bot_accounts, drops, orders. db_group is your",
  "  COMPARE tool (per marketplace / game / host / status).",
  "- read_code / search_code — inspect the actual source to explain behavior or",
  "  prepare a fix. Never invent how the code works — read it.",
  "- save_memory — when you learn something durable (a recurring failure, a pricing",
  "  quirk), save it so next time is easier. Use stable short keys.",
  "",
  "HOW YOU WORK: investigate broadly — cost is not a concern, so use as many tool",
  "calls as needed to actually compare and verify. Be concrete: cite timestamps,",
  "counts, marketplaces, prices, hosts. Known-routine noise (telegram poll errors,",
  "gameflip relist retries, campaignWatcher integrity checks, Mongoose deprecations)",
  "is NOT a failure — ignore unless asked.",
  "",
  "YOU DO NOT CHANGE ANYTHING (propose-only). You cannot edit code, reprice, or touch",
  "prod. When you'd recommend a change (a code fix, a price move, a bot action), call",
  "the `propose` tool with a concrete, reviewable recommendation (for code: exact file",
  "+ before/after). The operator reviews and applies it. Never claim you changed",
  "something — you propose, they apply.",
].join("\n");

async function buildAnalystSystem() {
  let mem = "";
  try { mem = await store.loadPromptMemories(); } catch { /* best effort */ }
  return mem
    ? ANALYST_BASE + "\n\nWHAT YOU'VE LEARNED (your memory — trust but re-verify if stale):\n" + mem
    : ANALYST_BASE;
}

const MAX_ROUNDS = 12;

async function callModel(messages, { noTools = false } = {}) {
  const resp = await fetch(`${config.AI.baseUrl}/chat/completions`, {
    method: "POST",
    headers: upstreamHeaders(),
    body: JSON.stringify({
      model: config.AI.model,
      messages,
      // noTools forces a plain text answer (used to recover an empty final turn
      // — DeepSeek is a reasoning model and occasionally returns empty content).
      ...(noTools ? { tool_choice: "none" } : { tools: SCHEMAS, tool_choice: "auto" }),
      stream: false,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`provider ${resp.status}: ${t.slice(0, 200)}`);
  }
  return resp.json();
}

// Background-job turn runner. Runs an assistant turn (analyst tool loop, or a
// plain chat reply) DETACHED from any HTTP request, writing progress and the
// final answer straight into the saved chat doc. Because it's server-side, the
// investigation keeps going and the answer is waiting even if the browser tab is
// closed — the client just polls the chat until the running turn is done.
async function runTurn(chatId) {
  const doc = await store.getChatDoc(chatId).catch(() => null);
  if (!doc) return;
  const idx = doc.messages.length - 1;
  const turn = doc.messages[idx];
  if (!turn || turn.role !== "assistant" || turn.status !== "running") return;
  const mode = turn.mode === "chat" ? "chat" : "analyst";
  const t0 = Date.now();

  // Reconstruct the model conversation from the saved messages (excluding this
  // running placeholder). Only completed turns with content are included.
  const prior = doc.messages
    .slice(0, idx)
    .filter((m) => m.content)
    .map((m) => ({ role: m.role, content: m.content }));
  const question = [...prior].reverse().find((m) => m.role === "user")?.content || "";

  const trace = [];
  let finalAnswer = "";
  let errMsg = "";
  try {
    if (mode === "chat") {
      const messages = [
        { role: "system", content: "You are a helpful, concise assistant. Use Markdown for code and lists." },
        ...prior,
      ];
      const data = await callModel(messages, { noTools: true });
      finalAnswer = data?.choices?.[0]?.message?.content || "(no answer)";
    } else {
      const messages = [{ role: "system", content: await buildAnalystSystem() }, ...prior];
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const data = await callModel(messages);
        const choice = data.choices?.[0];
        const msg = choice?.message || {};
        const calls = msg.tool_calls || [];
        if (choice?.finish_reason === "tool_calls" && calls.length) {
          messages.push({ role: "assistant", content: msg.content || "", tool_calls: calls });
          for (const call of calls) {
            let args = {};
            try { args = JSON.parse(call.function?.arguments || "{}"); } catch { /* keep {} */ }
            const result = await runTool(call.function?.name, args);
            trace.push({ tool: call.function?.name, ok: !result?.error });
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result).slice(0, 6000) });
            // Persist progress so a polling client sees live tool chips.
            turn.trace = trace.map((x) => x.tool);
            turn.beatAt = new Date();
            doc.markModified("messages");
            await doc.save().catch(() => {});
          }
          continue;
        }
        let answer = msg.content || "";
        if (!answer) {
          messages.push({ role: "user", content: "Give your final answer now, as plain text." });
          try { answer = (await callModel(messages, { noTools: true }))?.choices?.[0]?.message?.content || ""; }
          catch { /* keep empty */ }
        }
        finalAnswer = answer || "(no answer)";
        break;
      }
      if (!finalAnswer) finalAnswer = "(stopped after several investigation steps — ask me to continue or narrow the question)";
    }
  } catch (err) {
    console.error("runTurn error:", err.message);
    errMsg = err.message;
  }

  turn.content = finalAnswer;
  turn.trace = trace.map((x) => x.tool);
  turn.status = errMsg ? "error" : "done";
  turn.error = errMsg;
  turn.beatAt = new Date();
  if (doc.title === "New chat" && question) doc.title = store.titleFrom(question);
  doc.updatedAt = new Date();
  doc.markModified("messages");
  await doc.save().catch(() => {});

  store.logRun({
    question,
    actor: doc.actor,
    mode,
    tools: trace.map((x) => x.tool),
    answer: finalAnswer,
    proposalCount: trace.filter((x) => x.tool === "propose" && x.ok).length,
    durationMs: Date.now() - t0,
    error: errMsg,
  });
}

// Streamed as Server-Sent Events. A tool loop can run well past a reverse
// proxy's default 60s read timeout, and the answer only exists at the very end
// — so we emit a frame per tool (live progress) plus a 15s heartbeat to keep the
// connection from ever idling, and set X-Accel-Buffering:no so nginx forwards
// bytes immediately instead of buffering the whole response.
router.post("/ai-chat/agent", async (req, res) => {
  if (!config.AI.apiKey) {
    return res.status(503).json({
      success: false,
      message: "AI chat is not configured. Set AGENTROUTER_API_KEY in .env and restart.",
    });
  }
  const incoming = sanitizeMessages(req.body?.messages);
  if (!incoming) {
    return res.status(400).json({ success: false, message: "No messages provided." });
  }

  // Rebuild the message list with our analyst system prompt (which folds in the
  // coworker's saved memory) at the front, dropping any client-sent system msg.
  const messages = [{ role: "system", content: await buildAnalystSystem() }];
  for (const m of incoming) if (m.role !== "system") messages.push(m);

  // For the audit log.
  const t0 = Date.now();
  const actor = req.session?.admin?.id ? "admin:" + req.session.admin.id : "admin";
  const question = [...incoming].reverse().find((m) => m.role === "user")?.content || "";
  let finalAnswer = "";
  let errMsg = "";

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  const emit = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
  };
  let closed = false;
  const heartbeat = setInterval(() => { if (!closed) { try { res.write(": ping\n\n"); } catch {} } }, 15000);
  res.on("close", () => { closed = true; clearInterval(heartbeat); });

  const trace = [];
  try {
    for (let round = 0; round < MAX_ROUNDS && !closed; round++) {
      const data = await callModel(messages);
      const choice = data.choices?.[0];
      const msg = choice?.message || {};
      const calls = msg.tool_calls || [];

      if (choice?.finish_reason === "tool_calls" && calls.length) {
        // Record the assistant's tool-call turn verbatim (required by the API
        // before the matching tool results).
        messages.push({ role: "assistant", content: msg.content || "", tool_calls: calls });
        for (const call of calls) {
          if (closed) break;
          let args = {};
          try { args = JSON.parse(call.function?.arguments || "{}"); } catch { /* keep {} */ }
          emit("tool", { tool: call.function?.name });
          const result = await runTool(call.function?.name, args);
          trace.push({ tool: call.function?.name, args, ok: !result?.error });
          emit("tool_done", { tool: call.function?.name, ok: !result?.error });
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(result).slice(0, 6000),
          });
        }
        continue; // let the model read the results
      }

      // No (more) tool calls — this is the final answer.
      let answer = msg.content || "";
      if (!answer && !closed) {
        // Empty final turn (reasoning model quirk): ask once more for the text,
        // with tools disabled so it must answer rather than call another tool.
        messages.push({ role: "user", content: "Give your final answer now, as plain text." });
        try { answer = (await callModel(messages, { noTools: true }))?.choices?.[0]?.message?.content || ""; }
        catch { /* keep empty */ }
      }
      finalAnswer = answer || "(no answer — please ask again)";
      emit("done", { answer: finalAnswer, trace });
      clearInterval(heartbeat);
      return res.end();
    }
    finalAnswer =
      "(stopped after several investigation steps — ask me to continue or narrow the question)";
    emit("done", { answer: finalAnswer, trace });
  } catch (err) {
    console.error("ai-chat agent error:", err.message);
    errMsg = err.message;
    emit("error", err.message);
  } finally {
    clearInterval(heartbeat);
    if (!closed) res.end();
    // Persist the investigation for continuity + audit (best-effort).
    store.logRun({
      question,
      actor,
      tools: trace.map((t) => t.tool),
      answer: finalAnswer,
      proposalCount: trace.filter((t) => t.tool === "propose" && t.ok).length,
      durationMs: Date.now() - t0,
      error: errMsg,
    });
  }
});

// Lets the page list which tools the analyst has (for the UI hint).
router.get("/ai-chat/tools", (req, res) => res.json({ tools: toolNames }));

// ---- Saved chats (server-side) + background-job turns ----------------------
const actorOf = (req) => (req.session?.admin?.id ? "admin:" + req.session.admin.id : "admin");

router.get("/ai-chat/chats", async (req, res) => {
  try {
    res.json({ chats: await store.listChats(actorOf(req), 60) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/ai-chat/chats", async (req, res) => {
  try {
    const id = await store.createChat(actorOf(req), req.body?.title);
    res.json({ id });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/ai-chat/chats/:id", async (req, res) => {
  try {
    const doc = await store.getChatDoc(req.params.id).catch(() => null);
    if (!doc) return res.status(404).json({ success: false, message: "not found" });
    // Recover a turn orphaned by a server restart / crash (stuck "running").
    const last = doc.messages[doc.messages.length - 1];
    if (last && last.role === "assistant" && last.status === "running" &&
        Date.now() - new Date(last.beatAt).getTime() > 180000) {
      last.status = "error";
      last.error = "interrupted (the server restarted while this was running) — ask again";
      doc.markModified("messages");
      await doc.save().catch(() => {});
    }
    res.json({ chat: await store.getChatPublic(req.params.id) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete("/ai-chat/chats/:id", async (req, res) => {
  try {
    res.json(await store.deleteChat(req.params.id));
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Append a user message and kick off a background turn. Returns immediately;
// the client polls GET /ai-chat/chats/:id for the running turn's result.
router.post("/ai-chat/chats/:id/ask", async (req, res) => {
  if (!config.AI.apiKey) {
    return res.status(503).json({ success: false, message: "AI chat is not configured (set AGENTROUTER_API_KEY)." });
  }
  try {
    const text = String(req.body?.content || "").slice(0, 8000).trim();
    if (!text) return res.status(400).json({ success: false, message: "empty message" });
    const mode = req.body?.mode === "chat" ? "chat" : "analyst";
    const doc = await store.getChatDoc(req.params.id).catch(() => null);
    if (!doc) return res.status(404).json({ success: false, message: "chat not found" });
    // Don't start a second turn while one is still running.
    const last = doc.messages[doc.messages.length - 1];
    if (last && last.role === "assistant" && last.status === "running") {
      return res.status(409).json({ success: false, message: "a turn is already running" });
    }
    if (!doc.actor) doc.actor = actorOf(req);
    const now = new Date();
    doc.messages.push({ role: "user", content: text, at: now, status: "done" });
    doc.messages.push({ role: "assistant", content: "", mode, trace: [], status: "running", at: now, beatAt: now });
    if (doc.title === "New chat") doc.title = store.titleFrom(text);
    doc.updatedAt = now;
    await doc.save();
    // Fire the background job (NOT awaited) — survives this request ending.
    runTurn(String(doc._id)).catch((err) => console.error("runTurn(fire) error:", err.message));
    res.json({ ok: true, chatId: String(doc._id) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Open change proposals the coworker has filed for the operator to review.
router.get("/ai-chat/proposals", async (req, res) => {
  try {
    const status = ["open", "applied", "dismissed", "all"].includes(req.query.status)
      ? req.query.status
      : "open";
    res.json({ proposals: await store.readProposals(status, 50) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Recent investigations (audit trail of the coworker itself).
router.get("/ai-chat/log", async (req, res) => {
  try {
    res.json({ log: await store.readLog(Number(req.query.limit) || 20, req.query.q) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
