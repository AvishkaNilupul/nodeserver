const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function mountPhonePanel(app, {token, serverUrl, visible, request = fetch}) {
  if (!serverUrl) return;
  const base = new URL(serverUrl);
  if (base.protocol !== 'https:' || base.username || base.password) throw Error('Phone server URL must use HTTPS');
  const key = crypto.createHmac('sha256', token).update('epic-phone-controls-v1').digest('hex');
  const auth = (req, res, next) => {
    const a = Buffer.from(req.get('authorization') || ''), b = Buffer.from('Bearer ' + key);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.sendStatus(401);
    next();
  };
  // This app precedes the bridge, so retain its loopback Host restriction.
  app.use(['/phone', '/connect'], (req, res, next) => {
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.get('host') || '')) return res.sendStatus(403);
    res.set('Cache-Control', 'no-store');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });
  app.get(['/phone', '/connect'], (req, res) => {
    if (req.get('sec-fetch-site') === 'cross-site') return res.sendStatus(403);
    const html = fs.readFileSync(path.join(__dirname, 'phone-panel.html'), 'utf8');
    res.type('html').send(html.replace('__PHONE_CONTROL_TOKEN__', key));
  });
  app.get('/phone/awake.js', (_req, res) => res.sendFile(path.join(__dirname, 'phone-awake.js')));
  app.post('/phone/control/visible', auth, (_req, res) => { visible(); res.json({success: true}); });
  for (const [method, local, remote] of [
    ['get', '/phone/control/status', 'claims'],
    ['post', '/phone/control/start', 'claims/start'],
    ['post', '/phone/control/stop', 'claims/stop'],
  ]) app[method](local, auth, async (_req, res) => {
    try {
      const reply = await request(new URL('/api/epic/phone/' + remote, base), {
        method: method.toUpperCase(), headers: {Authorization: 'Bearer ' + key, Accept: 'application/json'},
        signal: AbortSignal.timeout(45000), redirect: 'error',
      });
      const data = await reply.json();
      if (reply.status === 429) {
        const seconds = Number(reply.headers?.get('retry-after'));
        data.retryAfterSeconds = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60;
        res.set('Retry-After', String(data.retryAfterSeconds));
      }
      res.status(reply.status).json(data);
    } catch { res.status(503).json({success: false, message: 'Server connection unavailable. Check the phone internet and try again.'}); }
  });
}
module.exports = {mountPhonePanel};
