#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const STATUS_URL = "https://comm-api.game.naver.com/nng_main/v1/user/getUserStatus";
const LOGIN_URL = "https://nid.naver.com/nidlogin.login";
const REQUIRED = ["NID_AUT", "NID_SES"];
const NAVER_HOST = (host) => host === "naver.com" || host.endsWith(".naver.com");

function cookieExport(cookies, now = Date.now()) {
  const rows = (cookies || []).filter((c) => {
    const domain = String(c.domain || "").replace(/^\./, "").toLowerCase();
    return NAVER_HOST(domain) && c.value && (!c.expires || c.expires < 0 || c.expires * 1000 > now);
  });
  if (!REQUIRED.every((name) => rows.some((c) => c.name === name))) {
    throw new Error("Naver did not provide both required login cookies; no export was written.");
  }
  return rows.map((c) => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path || "/",
    secure: !!c.secure, httpOnly: !!c.httpOnly,
    sameSite: ({ None: "no_restriction", Lax: "lax", Strict: "strict" })[c.sameSite] || "unspecified",
    session: !(c.expires > 0),
    ...(c.expires > 0 ? { expirationDate: c.expires } : {}),
    hostOnly: !c.domain.startsWith("."), storeId: null,
  }));
}

async function writeExport(filename, cookies) {
  const target = path.resolve(filename);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(cookies, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await fs.rename(temp, target);
  } finally {
    await fs.unlink(temp).catch(() => {});
  }
  return target;
}

async function userStatus(context) {
  let res;
  try {
    res = await context.request.get(STATUS_URL, { timeout: 15_000, failOnStatusCode: false });
    if ([401, 403].includes(res.status())) return null;
    if (!res.ok()) throw new Error("http");
    const body = await res.json();
    if (Number(body.code) !== 200) throw new Error("api");
    const who = body.content;
    return who && who.loggedIn && who.userIdHash ? { userIdHash: who.userIdHash } : null;
  } catch (_) {
    // Do not echo response bodies, request headers, or authentication details.
    throw new Error("Naver's login check did not answer successfully. No export was written.");
  } finally {
    if (res) await res.dispose().catch(() => {});
  }
}

async function submitCredentials(page, id, password) {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.locator("#id").fill(id);
  await page.locator("#pw").fill(password);
  const keep = page.locator("#keep");
  if (!(await keep.count())) throw new Error("The Stay signed in control changed; finish sign-in in the browser.");
  await keep.check({ force: true, timeout: 5000 });
  if (!(await keep.isChecked())) throw new Error("Stay signed in could not be selected.");
  const primary = page.locator('[id="log.login"]');
  const button = (await primary.count()) ? primary : page.getByRole("button", { name: /^(Sign in|로그인)$/i }).first();
  await button.click({ timeout: 10_000 });
}

async function login({
  chromium,
  id = process.env.NAVER_ID,
  password = process.env.NAVER_PW,
  profile = process.env.PROFILE_DIR || path.join(os.homedir(), ".playwright-naver-profile"),
  output = process.env.OUT || path.join(os.homedir(), ".local/share/nodeserver/chzzk-login/naver-cookies.json"),
  timeoutMs = 10 * 60_000,
  pollMs = 3000,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console.log,
  save = writeExport,
} = {}) {
  if (!chromium) throw new Error("Playwright is required to open the login browser.");
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: "chrome", headless: false, locale: "en-US",
      viewport: { width: 1280, height: 900 },
    });
    const page = context.pages()[0] || await context.newPage();
    let who = await userStatus(context);
    if (!who) {
      if (!id || !password) throw new Error("Set NAVER_ID and NAVER_PW before starting the helper.");
      try {
        await submitCredentials(page, id, password);
      } catch (_) {
        log("The login form needs attention. Finish sign-in in the Chrome window.");
      }
      log("Complete any Naver CAPTCHA or two-step verification in Chrome. Waiting for a verified login...");
      const deadline = now() + timeoutMs;
      while (!who && now() < deadline) {
        if (page.isClosed()) throw new Error("The login window was closed; no export was written.");
        who = await userStatus(context);
        if (!who) await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
      }
      if (!who) throw new Error("Sign-in was not completed within ten minutes; no export was written.");
    }
    // APIRequestContext shares this browser's jar and keeps Set-Cookie.
    // Read AFTER the verified check so the export includes its renewal.
    const exported = cookieExport(await context.cookies([
      "https://chzzk.naver.com/", "https://comm-api.game.naver.com/",
    ]), now());
    const filename = await save(output, exported);
    const persistent = exported.find((c) => c.name === "NID_AUT").session === false;
    log(`Verified Naver login. Saved ${exported.length} cookies to ${filename}`);
    log(persistent ? "Stay signed in is active." : "This login is still session-only; no long-lived expiry was issued.");
    log("Import the JSON from CHZZK → Accounts → Import logins. The server then maintains renewed cookies.");
    return { filename, persistent, count: exported.length };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

async function main({ chromium } = {}) {
  if (process.argv.includes("--help")) {
    console.log("NAVER_ID / NAVER_PW: login credentials. PROFILE_DIR / OUT: optional paths.\nRun with installed Google Chrome. Complete any verification in the browser.\nExisting signed-in profiles are reused. Cookie values are never printed.");
    return;
  }
  if (!chromium) ({ chromium } = require("playwright"));
  await login({ chromium });
}

if (require.main === module) main().catch(() => {
  console.error("Naver login did not finish. Check the browser or close any other helper using the same profile, then retry. No cookie values were printed.");
  process.exitCode = 1;
});

module.exports = { cookieExport, writeExport, userStatus, submitCredentials, login, main };
