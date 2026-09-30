// Headless Chromium claim driver for Epic free games.
//
// The direct-API path can't get past Cloudflare on /id/exchange, and the
// payment-website-pci session cookie only lands via the browser JS flow.
// So we drive a real Chromium: navigate via the exchange-code tap link
// Epic's own Telegram tap-links go through, wait for the /store/purchase
// SPA to render, click Place Order, and — if hCaptcha shows up — ship
// its sitekey to CapSolver and inject the solved token.
const { chromium } = require("playwright");
const axios = require("axios");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const CAPSOLVER_ENDPOINT = "https://api.capsolver.com";

async function solveHCaptcha({ apiKey, sitekey, pageUrl }) {
  const create = await axios.post(
    CAPSOLVER_ENDPOINT + "/createTask",
    {
      clientKey: apiKey,
      task: {
        type: "HCaptchaTaskProxyless",
        websiteURL: pageUrl,
        websiteKey: sitekey,
      },
    },
    { timeout: 30000, validateStatus: () => true },
  );
  if (!create.data || create.data.errorId !== 0) {
    throw new Error(
      "capsolver create: " +
        JSON.stringify(create.data).slice(0, 300),
    );
  }
  const taskId = create.data.taskId;
  const started = Date.now();
  while (Date.now() - started < 180000) {
    await new Promise((r) => setTimeout(r, 4000));
    const poll = await axios.post(
      CAPSOLVER_ENDPOINT + "/getTaskResult",
      { clientKey: apiKey, taskId },
      { timeout: 20000, validateStatus: () => true },
    );
    if (!poll.data || poll.data.errorId !== 0) {
      throw new Error(
        "capsolver poll: " + JSON.stringify(poll.data).slice(0, 300),
      );
    }
    if (poll.data.status === "ready") {
      return poll.data.solution && poll.data.solution.gRecaptchaResponse;
    }
  }
  throw new Error("capsolver timed out after 3 min");
}

// Extract the hCaptcha sitekey by walking every iframe on the page.
async function findHCaptchaSitekey(page) {
  for (const frame of page.frames()) {
    const url = frame.url();
    // hCaptcha widget iframes look like:
    //   https://newassets.hcaptcha.com/captcha/v1/…/static/hcaptcha.html#…&sitekey=<key>&…
    const m = url.match(/[?&#]sitekey=([0-9a-f-]+)/i);
    if (m) return m[1];
  }
  // Fallback: look for the hCaptcha script's data-sitekey attribute.
  return page.evaluate(() => {
    const el = document.querySelector("[data-sitekey]");
    return el ? el.getAttribute("data-sitekey") : null;
  });
}

async function injectHCaptchaToken(page, token) {
  await page.evaluate((tok) => {
    // hCaptcha exposes each widget's callback under window.hcaptcha. When we
    // inject the token via the textarea + fire the callback, the store UI
    // re-submits the order with the token included.
    if (window.hcaptcha && window.hcaptcha.callbacks) {
      for (const cbId of Object.keys(window.hcaptcha.callbacks)) {
        try {
          window.hcaptcha.callbacks[cbId](tok);
        } catch {}
      }
    }
    const inputs = document.querySelectorAll(
      'textarea[name="h-captcha-response"], textarea[name="g-recaptcha-response"]',
    );
    for (const i of inputs) {
      i.value = tok;
      i.innerHTML = tok;
      i.dispatchEvent(new Event("change", { bubbles: true }));
    }
    // Also fire the global hCaptcha "callback" the JS integrator wired up.
    if (window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients) {
      // no-op for hcaptcha, but silence undefined
    }
  }, token);
}

// Public entry. Returns { status, orderId?, error? } — same shape as the
// direct-API path so the orchestrator can be swapped 1:1.
async function headlessClaim({
  exchangeCode,
  namespace,
  offerId,
  capSolverKey,
  logDir,
}) {
  const checkoutUrl =
    "https://www.epicgames.com/store/purchase?highlightColor=0078f2" +
    "&offers=1-" + namespace + "-" + offerId +
    "&orderId&purchaseToken&showNavigation=true";
  const exchangeUrl =
    "https://www.epicgames.com/id/exchange?exchangeCode=" +
    encodeURIComponent(exchangeCode) +
    "&redirectUrl=" + encodeURIComponent(checkoutUrl);

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
  });
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    timezoneId: "America/New_York",
  });
  // Mask the automation flag some sites check.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await context.newPage();
  const log = (msg) => console.log("[" + new Date().toISOString() + "] " + msg);

  async function snap(name) {
    if (!logDir) return;
    try {
      await page.screenshot({
        path: logDir + "/" + name + ".png",
        fullPage: true,
      });
    } catch {}
  }

  try {
    log("navigating to exchange -> checkout");
    await page.goto(exchangeUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    // The exchange URL redirects through /id and /store; wait for the final URL.
    await page.waitForURL(/\/store\//, { timeout: 60000 });
    log("landed at " + page.url());
    await snap("01-landed");
    // Wait for the checkout SPA — the "Place Order" or "Get" button, or the
    // "You Own This" state, or the sign-in wall.
    await page.waitForLoadState("networkidle", { timeout: 45000 }).catch(() => {});
    await snap("02-networkidle");
    const url = page.url();
    if (/\/id\/login/i.test(url)) {
      return { status: "session_failed", error: "bounced to /id/login" };
    }
    // Check for the "Already in library" state (belt-and-suspenders).
    const bodyText = (await page.textContent("body").catch(() => "")) || "";
    if (/in library|you own|owned/i.test(bodyText)) {
      return { status: "already_owned" };
    }
    // Find the primary CTA. Try several selectors — Epic changes these.
    const ctaSelectors = [
      'button:has-text("Place Order")',
      'button:has-text("Get")',
      'button:has-text("Continue")',
      'button[data-testid="purchase-cta-button"]',
      'button[aria-label="Place Order"]',
    ];
    let cta = null;
    for (const sel of ctaSelectors) {
      const b = await page.$(sel);
      if (b) { cta = { sel, el: b }; break; }
    }
    if (!cta) {
      await snap("03-no-cta");
      return { status: "error", error: "no purchase CTA found" };
    }
    log("clicking CTA: " + cta.sel);
    await cta.el.click();
    // EULA modal sometimes appears — click "I Agree" if it does.
    try {
      await page.waitForSelector('button:has-text("I Agree"), button:has-text("Agree")', { timeout: 5000 });
      log("EULA modal appeared, clicking Agree");
      await page.click('button:has-text("I Agree"), button:has-text("Agree")');
    } catch {}
    await snap("04-post-cta");
    // Now watch for either a captcha frame, a confirmation, or an error.
    let solved = false;
    const started = Date.now();
    while (Date.now() - started < 60000) {
      await new Promise((r) => setTimeout(r, 1500));
      const cur = page.url();
      if (/order-confirmation|thank|download|receipt/i.test(cur)) {
        log("confirmed via URL: " + cur);
        return { status: "claimed", orderId: cur };
      }
      const txt = (await page.textContent("body").catch(() => "")) || "";
      if (/thank you|order (complete|placed|confirmation)/i.test(txt)) {
        log("confirmed via body text");
        return { status: "claimed" };
      }
      if (/error|declined|failed|try again/i.test(txt) &&
          !/hcaptcha/i.test(txt)) {
        await snap("05-error-text");
        return { status: "error", error: txt.slice(0, 240) };
      }
      // hCaptcha iframe present?
      const sitekey = await findHCaptchaSitekey(page).catch(() => null);
      if (sitekey && !solved) {
        log("hCaptcha detected, sitekey=" + sitekey);
        await snap("06-captcha-visible");
        const token = await solveHCaptcha({
          apiKey: capSolverKey,
          sitekey,
          pageUrl: page.url(),
        });
        log("captcha solved by capsolver, token len=" + token.length);
        await injectHCaptchaToken(page, token);
        solved = true;
        await snap("07-token-injected");
        // Try clicking the CTA again to submit with the token.
        try {
          await page.click(cta.sel, { timeout: 5000 });
        } catch {}
      }
    }
    await snap("08-timeout");
    return { status: "error", error: "timed out waiting for confirmation" };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

module.exports = { headlessClaim };

// CLI shim for live testing: node epicHeadlessClaim.js <accountId?>
if (require.main === module) {
  (async () => {
    require("dotenv").config();
    const mongoose = require("mongoose");
    process.chdir("/var/www/redeemer/nodeserver");
    await mongoose.connect(process.env.MONGO_URI);
    const EpicAccount = require("/var/www/redeemer/nodeserver/models/EpicAccount");
    const EpicFreebie = require("/var/www/redeemer/nodeserver/models/EpicFreebie");
    const epic = require("/var/www/redeemer/nodeserver/utils/epicClient");
    const settings = require("/var/www/redeemer/nodeserver/utils/settings");
    const { decrypt } = require("/var/www/redeemer/nodeserver/utils/secretBox");
    const cfg = settings.getEpicAutoClaim();
    const capKey = cfg.captchaKey ? decrypt(cfg.captchaKey) : "";
    if (!capKey) {
      console.error("no CapSolver key configured in settings");
      process.exit(1);
    }
    const acctId = process.argv[2];
    const acc = acctId
      ? await EpicAccount.findOne({ accountId: acctId })
      : await EpicAccount.findOne({ sold: false });
    if (!acc) { console.error("no account"); process.exit(1); }
    const tok = await epic.refresh(decrypt(acc.refreshToken));
    const freebie = await EpicFreebie.findOne({
      active: true,
      upcoming: false,
    });
    if (!freebie) { console.error("no live freebie"); process.exit(1); }
    console.log("account=" + acc.label + " freebie=" + freebie.title);
    const code = await epic.exchangeCode(tok.access_token);
    const fs = require("fs");
    const logDir = "/tmp/epic-claim-" + Date.now();
    fs.mkdirSync(logDir, { recursive: true });
    console.log("logDir=" + logDir);
    const result = await headlessClaim({
      exchangeCode: code,
      namespace: freebie.namespace,
      offerId: freebie.offerId,
      capSolverKey: capKey,
      logDir,
    });
    console.log("RESULT:", JSON.stringify(result, null, 2));
    await mongoose.disconnect();
  })().catch((e) => { console.error("FATAL", e.stack || e.message); process.exit(1); });
}
