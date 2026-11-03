const crypto = require('node:crypto');
const express = require('express');

function controlToken(secret) {
  return secret ? crypto.createHmac('sha256', secret).update('epic-phone-controls-v1').digest('hex') : '';
}
function authenticate(expected) {
  return (req, res, next) => {
    const actual = Buffer.from(req.get('authorization') || '');
    const wanted = Buffer.from('Bearer ' + expected);
    if (!expected || actual.length !== wanted.length || !crypto.timingSafeEqual(actual, wanted)) {
      return res.status(401).json({success: false, message: 'Phone connection required'});
    }
    res.set('Cache-Control', 'no-store');
    next();
  };
}
function summarize(jobs) {
  const games = new Map();
  for (const job of jobs) games.set(job.game, (games.get(job.game) || 0) + 1);
  return {pending: jobs.length, accounts: new Set(jobs.map(j => j.accountId)).size,
    games: [...games].map(([title, count]) => ({title, count}))};
}
function createPhoneControl({secret, plan, batch, claimerStatus, workerReady, singleRunning}) {
  const router = express.Router();
  router.use('/api/epic/phone', authenticate(controlToken(secret)));
  let cached, expiresAt = 0, preparing;
  async function preview() {
    if (cached && Date.now() < expiresAt) return cached;
    if (!preparing) preparing = Promise.resolve().then(plan).then(jobs => {
      cached = summarize(jobs); expiresAt = Date.now() + 10000; return cached;
    }).finally(() => { preparing = null; });
    return preparing;
  }
  async function snapshot() {
    const [summary, worker] = await Promise.all([preview(), workerReady()]);
    const status = claimerStatus();
    const raw = batch.status();
    return {success: true, ...summary, worker,
      rateLimitedUntil: status.rateLimitedUntil,
      nextCheckoutAt: status.nextCheckoutAt, checkoutGapMin: status.checkoutGapMin,
      batch: {id: raw.id, state: raw.state, total: raw.total, completed: raw.completed,
        reason: raw.reason || '', current: (raw.jobs || []).find(j => ['running','waiting','needs_captcha'].includes(j.state))?.game || ''}};
  }
  router.get('/api/epic/phone/claims', async (_req, res) => {
    try { res.json(await snapshot()); }
    catch { res.status(503).json({success: false, message: 'Could not read remaining claims. Try again.'}); }
  });
  router.post('/api/epic/phone/claims/start', async (_req, res) => {
    try {
      if (singleRunning()) return res.status(409).json({success: false, message: 'A single claim is still finishing'});
      const status = claimerStatus();
      if (!batch.isActive() && status.rateLimitedUntil) return res.status(409).json({success: false,
        rateLimitedUntil: status.rateLimitedUntil, message: 'Epic has paused checkouts. Wait until the cooldown ends.'});
      if (!batch.isActive()) {
        const worker = await workerReady();
        if (!worker.ready) return res.status(503).json({success: false, message: worker.reason || 'Open Firefox and keep the phone unlocked'});
      }
      await batch.start(); expiresAt = 0;
      res.status(202).json(await snapshot());
    } catch { res.status(503).json({success: false, message: 'Could not start claims. Try again.'}); }
  });
  router.post('/api/epic/phone/claims/stop', (_req, res) => {
    const status = batch.stop();
    res.json({success: true, state: status.state, message: 'Stopping after the current checkout'});
  });
  return router;
}
module.exports = {createPhoneControl, controlToken, summarize};
