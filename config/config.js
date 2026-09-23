require("dotenv").config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

module.exports = {
  // Server
  PORT: process.env.PORT || 3000,

  // Admin key used to gate redeem-code generation (/generate)
  ADMIN_KEY: required("ADMIN_KEY"),

  // Bearer token for the external account API (routes/accountApiRoutes.js).
  // Optional: when unset the whole API is disabled (returns 503) rather than
  // falling open — it hands out account credentials, so it must fail closed.
  ACCOUNT_API_TOKEN: process.env.ACCOUNT_API_TOKEN || "",

  // MongoDB connection string
  MONGO_URI: required("MONGO_URI"),

  // AI chatbot (OpenAI-compatible provider — currently AgentRouter → DeepSeek).
  // Optional: the /ai-chat page reports a clear error if the key is unset
  // rather than crashing the whole server on boot.
  AI: {
    apiKey: process.env.AGENTROUTER_API_KEY || "",
    baseUrl: process.env.AGENTROUTER_BASE_URL || "https://agentrouter.org/v1",
    model: process.env.AGENTROUTER_MODEL || "deepseek-v4-flash",
    // AgentRouter fingerprints its clients: it rejects any request whose
    // User-Agent / originator don't look like the Codex CLI ("unauthorized
    // client detected"). We must present the same identity the ChatGPT/Codex
    // app does, or every call 401s. Override via env if AgentRouter changes it.
    userAgent: process.env.AGENTROUTER_USER_AGENT || "codex_cli_rs/0.20.0",
    originator: process.env.AGENTROUTER_ORIGINATOR || "codex_cli_rs",
  },
};