// Thin captcha-solving client for the Epic auto-claim path.
//
// Epic wraps the free-game checkout in Talon, their in-house hCaptcha frame.
// When epicClient's orderPreview/confirmOrder returns a captcha challenge we
// need a solved hCaptcha token to feed back into confirmOrder. Two providers
// are supported over their plain HTTP APIs — no SDK / dep required:
//
//   - 2Captcha  (https://2captcha.com)  — 32-char lowercase-hex API key
//   - CapSolver (https://capsolver.com) — starts with "CAP-" then hex
//
// Auto-detected from the key format unless the operator sets provider
// explicitly in settings. Empty key = solver disabled; caller then falls
// back to the existing Telegram tap-link.
const axios = require("axios");

const EPIC_TALON_SITEKEY = "91e4137f-95af-4bc9-97af-cdcedce21c8c";
const EPIC_TALON_PAGE_URL = "https://www.epicgames.com/id/login";

function detectProvider(key) {
  const k = String(key || "").trim();
  if (!k) return "";
  if (/^cap-/i.test(k)) return "capsolver";
  return "2captcha";
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 2Captcha: POST /in.php → get id → poll /res.php until GET_CAPTCHA returns
// the token. Free hCaptcha submissions usually resolve in 15–60s.
async function solveVia2Captcha({ apiKey, sitekey, pageUrl }) {
  const inRes = await axios.post(
    "https://2captcha.com/in.php",
    null,
    {
      params: {
        key: apiKey,
        method: "hcaptcha",
        sitekey,
        pageurl: pageUrl,
        json: 1,
      },
      timeout: 20000,
      validateStatus: () => true,
    },
  );
  if (!inRes.data || inRes.data.status !== 1) {
    throw new Error("2captcha submit failed: " + JSON.stringify(inRes.data));
  }
  const id = inRes.data.request;
  const started = Date.now();
  // Poll for up to 3 minutes — Talon solves rarely take longer.
  while (Date.now() - started < 180000) {
    await sleep(5000);
    const out = await axios.get("https://2captcha.com/res.php", {
      params: { key: apiKey, action: "get", id, json: 1 },
      timeout: 20000,
      validateStatus: () => true,
    });
    if (!out.data) continue;
    if (out.data.status === 1) return out.data.request;
    if (out.data.request && out.data.request !== "CAPCHA_NOT_READY") {
      throw new Error("2captcha error: " + out.data.request);
    }
  }
  throw new Error("2captcha timed out after 3 min");
}

// CapSolver: POST /createTask → GET /getTaskResult with taskId until READY.
async function solveViaCapSolver({ apiKey, sitekey, pageUrl }) {
  const create = await axios.post(
    "https://api.capsolver.com/createTask",
    {
      clientKey: apiKey,
      task: {
        type: "HCaptchaTaskProxyless",
        websiteURL: pageUrl,
        websiteKey: sitekey,
      },
    },
    { timeout: 20000, validateStatus: () => true },
  );
  if (!create.data || create.data.errorId !== 0) {
    throw new Error(
      "capsolver submit failed: " +
        (create.data && create.data.errorDescription) +
      "",
    );
  }
  const taskId = create.data.taskId;
  const started = Date.now();
  while (Date.now() - started < 180000) {
    await sleep(4000);
    const out = await axios.post(
      "https://api.capsolver.com/getTaskResult",
      { clientKey: apiKey, taskId },
      { timeout: 20000, validateStatus: () => true },
    );
    if (!out.data || out.data.errorId !== 0) {
      throw new Error(
        "capsolver poll failed: " +
          (out.data && out.data.errorDescription),
      );
    }
    if (out.data.status === "ready") {
      return out.data.solution && out.data.solution.gRecaptchaResponse;
    }
  }
  throw new Error("capsolver timed out after 3 min");
}

// Public: solve one hCaptcha challenge. sitekey/pageUrl default to Epic's
// Talon values so callers can just pass { provider, apiKey }.
async function solveHCaptcha({ provider, apiKey, sitekey, pageUrl }) {
  const p = provider || detectProvider(apiKey);
  const site = sitekey || EPIC_TALON_SITEKEY;
  const url = pageUrl || EPIC_TALON_PAGE_URL;
  if (!apiKey) throw new Error("captcha solver key not configured");
  if (p === "capsolver") {
    return solveViaCapSolver({ apiKey, sitekey: site, pageUrl: url });
  }
  if (p === "2captcha") {
    return solveVia2Captcha({ apiKey, sitekey: site, pageUrl: url });
  }
  throw new Error("unknown captcha provider: " + p);
}

module.exports = {
  solveHCaptcha,
  detectProvider,
  EPIC_TALON_SITEKEY,
  EPIC_TALON_PAGE_URL,
};
