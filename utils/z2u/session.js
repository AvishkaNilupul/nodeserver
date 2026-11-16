'use strict';
const { CookieJar, Cookie } = require('tough-cookie');
const { randomUUID } = require('node:crypto');
const { ORIGIN, checkedUrl } = require('./client');
const { fault, readPrivate, writePrivate, acquireRuntimeLock } = require('./privateStore');

function browserCookieJar(exported) {
  if (!Array.isArray(exported) || !exported.length || exported.length > 300) throw fault('INVALID_COOKIE_EXPORT');
  const jar = new CookieJar();
  for (const entry of exported) {
    const domain = typeof entry?.domain === 'string' ? entry.domain.replace(/^\./, '').toLowerCase() : '';
    if (!['z2u.com', 'www.z2u.com'].includes(domain) || typeof entry.name !== 'string' || !entry.name || typeof entry.value !== 'string' || /[\r\n;]/.test(entry.name + entry.value) || /[=\s]/.test(entry.name) || typeof entry.path !== 'string' || !entry.path.startsWith('/') || /[\r\n;]/.test(entry.path)) throw fault('INVALID_COOKIE_EXPORT');
    let expires = 'Infinity';
    if (entry.session !== true && entry.expirationDate !== undefined) {
      if (!Number.isFinite(entry.expirationDate) || entry.expirationDate <= 0) throw fault('INVALID_COOKIE_EXPORT');
      expires = new Date(entry.expirationDate * 1000);
      if (!Number.isFinite(expires.getTime())) throw fault('INVALID_COOKIE_EXPORT');
    }
    const cookie = new Cookie({ key: entry.name, value: entry.value, domain, path: entry.path,
      hostOnly: entry.hostOnly === true, secure: entry.secure === true, httpOnly: entry.httpOnly === true, expires,
      sameSite: ['strict', 'lax', 'none'].includes(entry.sameSite) ? entry.sameSite : undefined });
    try { jar.setCookieSync(cookie, 'https://' + domain + entry.path); }
    catch { throw fault('INVALID_COOKIE_EXPORT'); }
  }
  if (!jar.getCookieStringSync(ORIGIN + '/userStorage/product')) throw fault('EMPTY_SESSION');
  return jar;
}
function transport(jar, { persist = async () => {}, assertCurrent = async () => {} } = {}) {
  return {
    snapshot: () => jar.serialize(),
    getHeaders: async url => {
      checkedUrl(url); await assertCurrent();
      const cookie = await jar.getCookieString(url);
      if (!cookie) throw fault('SESSION_EXPIRED');
      return { Cookie: cookie, 'User-Agent': 'Mozilla/5.0', Accept: 'text/html,application/json;q=0.9,*/*;q=0.8', Referer: ORIGIN + '/userStorage/product' };
    },
    acceptResponse: async (response, url) => {
      checkedUrl(url); await assertCurrent();
      const cookies = response.headers.getSetCookie?.() || [];
      if (!cookies.length) return;
      const candidate = await CookieJar.deserialize(await jar.serialize());
      for (const cookie of cookies) {
        try { await candidate.setCookie(cookie, url); } catch { throw fault('INVALID_RESPONSE_COOKIE'); }
      }
      await persist(candidate);
      jar = candidate;
    },
  };
}
async function importBrowserSession(filename, exported, validate) {
  if (typeof validate !== 'function') throw fault('SESSION_VALIDATOR_REQUIRED');
  const jar = browserCookieJar(exported);
  // Validate seller identity and the independently locked storage access before
  // replacing the last-good persisted session. This function never logs values.
  const candidate = transport(jar);
  const verified = await validate(candidate);
  if (verified?.sellerAccess !== true || verified?.storageAccess !== true) throw fault('SESSION_UNVERIFIED');
  const generation = randomUUID();
  const unlock = await acquireRuntimeLock(filename + '.write.lock');
  try { await writePrivate(filename, { version: 1, generation, updatedAt: new Date().toISOString(), jar: await candidate.snapshot() }); }
  finally { await unlock(); }
  return { imported: true, sellerAccess: true, storageAccess: true };
}
async function openSession(filename) {
  const record = await readPrivate(filename);
  if (record.version !== 1 || typeof record.generation !== 'string') throw fault('INVALID_SESSION_STORE');
  let jar;
  try { jar = await CookieJar.deserialize(record.jar); } catch { throw fault('INVALID_SESSION_STORE'); }
  const assertCurrent = async () => { if ((await readPrivate(filename)).generation !== record.generation) throw fault('SESSION_REPLACED'); };
  return transport(jar, { assertCurrent, persist: async next => {
    const unlock = await acquireRuntimeLock(filename + '.write.lock');
    try {
      await assertCurrent();
      await writePrivate(filename, { ...record, updatedAt: new Date().toISOString(), jar: await next.serialize() });
    } finally { await unlock(); }
  } });
}
module.exports = { browserCookieJar, importBrowserSession, openSession };
