const test = require('node:test');
const assert = require('node:assert/strict');
process.env.CRED_SECRET = 'epic-signup-tests-only';
const { encrypt, decrypt } = require('../utils/secretBox');
const sessions = new Map(); let written, inserted; let profileEmail = 'stock@outlook.com';
function stub(name, exports) { const id = require.resolve(name); require.cache[id] = { id, loaded: true, exports }; }
stub('../utils/epicClient', { REDIRECT_URL: 'https://www.epicgames.com/id/api/redirect', exchangeAuthCode: async () => ({ account_id: 'epic-account', access_token: 'access', refresh_token: 'refresh' }) });
stub('../utils/epicClaimer', { runOnce: async () => {} });
stub('../models/EpicSignupSession', { create: async data => {
  const s = { ...data, expiresAt: new Date(Date.now()+86400000), save: async () => {} }; sessions.set(data.sessionId, s); return s;
}, findOne: async ({sessionId}) => sessions.get(sessionId) });
stub('../models/EpicAccount', { findOneAndUpdate: async (q, data) => { written = data.$set; inserted = data.$setOnInsert; return { _id: 'saved', ...written }; } });
const axios = require('axios'); axios.get = async () => ({ data: { email: profileEmail } });
const router = require('../routes/epicSignupRoutes');
async function call(path, body = {}, { role = 'superadmin', bearer = '', sessionId } = {}) {
  const layer = router.stack.find(l => l.route?.path === path);
  const handlers = layer.route.stack.map(l => l.handle);
  return new Promise((resolve, reject) => {
    const req = { body, params: { sessionId }, session: role ? { admin: { role } } : {}, get: () => bearer ? 'Bearer ' + bearer : '', accepts: () => 'json' };
    const res = { code: 200, status(code) { this.code = code; return this; }, json(data) { resolve({ status: this.code, data }); } };
    let i = 0; const next = () => { try { Promise.resolve(handlers[i++](req, res, next)).catch(reject); } catch (e) { reject(e); } }; next();
  });
}
test('signup auth, encrypted storage, expiry and account identity guard', async () => {
  const mailbox = { address: profileEmail, provider: 'outlook-local', reservedAt: new Date().toISOString() };
  assert.equal((await call('/api/epic/signup/start', { mailbox }, { role: null })).status, 401);
  assert.equal((await call('/api/epic/signup/start', { mailbox }, { role: 'admin' })).status, 403);
  const started = await call('/api/epic/signup/start', { mailbox });
  assert.equal(started.status, 200);
  const s = started.data.session;
  const stored = sessions.get(s.sessionId);
  assert.notEqual(stored.password, s.identity.password);
  assert.equal(decrypt(stored.password), s.identity.password);
  let auth = { bearer: s.bearer, sessionId: s.sessionId };
  assert.equal((await call('/api/epic/signup/:sessionId/resume', {}, { ...auth, role: 'admin' })).status, 403);
  const resumed = await call('/api/epic/signup/:sessionId/resume', {}, auth);
  assert.equal(resumed.status, 200);
  assert.equal(resumed.data.session.identity.email, s.identity.email);
  assert.equal(resumed.data.session.identity.password, s.identity.password);
  assert.equal((await call('/api/epic/signup/:sessionId/status', { status: 'awaiting_otp' }, auth)).status, 401);
  auth = { ...auth, bearer: resumed.data.session.bearer };
  assert.equal((await call('/api/epic/signup/:sessionId/status', { status: 'verified' }, auth)).status, 400);
  assert.equal((await call('/api/epic/signup/:sessionId/status', { status: 'awaiting_otp' }, { ...auth, bearer: 'wrong' })).status, 401);
  stored.expiresAt = new Date(0);
  assert.equal((await call('/api/epic/signup/:sessionId/status', { status: 'awaiting_otp' }, auth)).status, 404);
  stored.expiresAt = new Date(Date.now()+86400000);
  profileEmail = 'different@outlook.com';
  const finish = { sessionId: s.sessionId, authorizationCode: 'a'.repeat(32) };
  assert.equal((await call('/api/epic/accounts/from-extension', finish, auth)).status, 500);
  assert.equal(written, undefined);
  profileEmail = mailbox.address;
  assert.equal((await call('/api/epic/accounts/from-extension', finish, auth)).status, 200);
  assert.equal(decrypt(written.password), s.identity.password);
  assert.equal(decrypt(written.email), mailbox.address);
  assert.equal(decrypt(written.refreshToken), 'refresh');
  const details=JSON.parse(decrypt(inserted.accountDetails));assert.ok(details.firstName);assert.ok(details.lastName);assert.match(details.dateOfBirth,/^\d{4}-\d{2}-\d{2}$/);
  assert.equal(stored.status, 'verified');
  assert.equal((await call('/api/epic/signup/:sessionId/resume', {}, auth)).status, 409);
  assert.equal((await call('/api/epic/accounts/from-extension', finish, auth)).status, 200);
});
