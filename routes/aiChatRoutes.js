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

const router = express.Router();

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
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.AI.apiKey}`,
        // Required — AgentRouter rejects unrecognized clients (see config.AI).
        "User-Agent": config.AI.userAgent,
        originator: config.AI.originator,
      },
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

module.exports = router;
