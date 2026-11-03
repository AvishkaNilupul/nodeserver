// Epic claim bridge on the phone (Termux): the old Mac's bridge
// (extension-worker.cjs, copied unchanged next to this file) with two phone
// changes:
//  - "screen locked" means no helper page on screen. The Android add-on posts
//    /phone/visible every few seconds while the pairing page or an Epic tab is
//    visible. With none for VISIBLE_MS (phone locked, or Firefox in the
//    background), new claims are refused as worker_unavailable, which the
//    server does not count as a try. Tested 2026-11-03: a hidden Firefox picks
//    jobs up but never loads the claim tab, so they only failed.
//  - The bridge's Mac/Chrome wording reads phone/Firefox in answers and logs.
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { createBridge } = require(path.join(__dirname, 'extension-worker.cjs'));

const VISIBLE_MS = 20000;
const phoneWords = s => String(s)
  .replace('Mac screen is locked; unlock it so Chrome can run claims',
    'Firefox is not on the phone screen (phone locked or Firefox in the background); open it so claims can run')
  .replace(/\bMac\b/g, 'phone')
  .replace(/\bChrome\b/g, 'Firefox');
const equal = (a, b) => {
  const x = Buffer.from(a || ''), y = Buffer.from(b || '');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function createPhoneBridge({ token, serverUrl, now = Date.now, visibleMs = VISIBLE_MS, log = () => {} } = {}) {
  let visibleAt = 0;
  const hidden = () => now() - visibleAt > visibleMs;
  const { app: bridge, extensionToken } = createBridge({ express, token, now, screenLocked: hidden, log });
  // Added after the bridge's own routes, so its host check and JSON parser run first.
  bridge.post('/phone/visible', (req, res) => {
    if (!equal(req.get('authorization'), 'Bearer ' + extensionToken)) return res.sendStatus(401);
    visibleAt = now();
    res.json({ ok: true });
  });
  const app = express();
  app.disable('x-powered-by');
  // Only the error/reason texts are reworded; a job (which carries the
  // account's display name) passes through untouched.
  app.use((req, res, next) => {
    const json = res.json.bind(res);
    res.json = body => {
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        for (const key of ['error', 'reason']) if (typeof body[key] === 'string') body[key] = phoneWords(body[key]);
        if (req.path === '/health') body.firefoxOnScreenSecondsAgo = visibleAt ? Math.round((now() - visibleAt) / 1000) : null;
      }
      return json(body);
    };
    next();
  });
  if (serverUrl) {
    app.get('/pair', (req, res, next) => { req.url = '/connect'; bridge(req, res, next); });
    require('./phone-panel.cjs').mountPhonePanel(app, {
      token, serverUrl, visible: () => { visibleAt = now(); },
    });
  }
  app.use(bridge);
  return { app, extensionToken, hidden };
}

function start() {
  const log = line => console.log(new Date().toISOString() + ' ' + phoneWords(line));
  const { app, hidden } = createPhoneBridge({ token: process.env.CLAIM_WORKER_TOKEN, serverUrl: process.env.EPIC_PHONE_SERVER_URL, log });
  let wasHidden = true;
  setInterval(() => {
    const h = hidden();
    if (h !== wasHidden) log(h ? 'Firefox left the screen' : 'Firefox on screen');
    wasHidden = h;
  }, 5000).unref();
  app.listen(Number(process.env.PORT || 8123), '127.0.0.1', () => log('Epic claim bridge (phone) ready'));
}

if (require.main === module) start();
module.exports = { createPhoneBridge, phoneWords, VISIBLE_MS };
