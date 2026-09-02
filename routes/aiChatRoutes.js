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
const ANALYST_SYSTEM =
  "You are the site's ops coworker — an analyst embedded in a Node/Express app " +
  "that runs a Twitch drop-farming / account-selling operation. Investigate " +
  "using the provided READ-ONLY tools before answering; never guess when a tool " +
  "can tell you. Prefer event_summary first to see where problems are, then " +
  "query_events to drill in, fleet_trend for count changes, pm2_status for " +
  "process health. Be concise and concrete: cite timestamps, categories, hosts, " +
  "and counts from the data. Known-routine noise (telegram poll errors, gameflip " +
  "relist retries, campaignWatcher integrity checks, Mongoose deprecations) is " +
  "NOT a failure — don't raise it unless asked. If the data is insufficient, say " +
  "so. You cannot change anything; you observe and explain.";

const MAX_ROUNDS = 6;

async function callModel(messages) {
  const resp = await fetch(`${config.AI.baseUrl}/chat/completions`, {
    method: "POST",
    headers: upstreamHeaders(),
    body: JSON.stringify({
      model: config.AI.model,
      messages,
      tools: SCHEMAS,
      tool_choice: "auto",
      stream: false,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`provider ${resp.status}: ${t.slice(0, 200)}`);
  }
  return resp.json();
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

  // Rebuild the message list with our analyst system prompt at the front
  // (drop any client-sent system message).
  const messages = [{ role: "system", content: ANALYST_SYSTEM }];
  for (const m of incoming) if (m.role !== "system") messages.push(m);

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
      emit("done", { answer: msg.content || "", trace });
      clearInterval(heartbeat);
      return res.end();
    }
    emit("done", {
      answer: "(stopped after several investigation steps — ask me to continue or narrow the question)",
      trace,
    });
  } catch (err) {
    console.error("ai-chat agent error:", err.message);
    emit("error", err.message);
  } finally {
    clearInterval(heartbeat);
    if (!closed) res.end();
  }
});

// Lets the page list which tools the analyst has (for the UI hint).
router.get("/ai-chat/tools", (req, res) => res.json({ tools: toolNames }));

module.exports = router;
