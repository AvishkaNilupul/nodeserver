import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const IDS = new Set(['primary', 'test']);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE = /^(?:Default|Profile [1-9][0-9]{0,2})$/;
const REQUEST_ID = /^[A-Za-z0-9:_-]{1,160}$/;
const CACHE_MS = 120000;
const CACHE_LIMIT = 128;
const failure = (message, status = 503) => Object.assign(new Error(message), { status });
const invalidConfig = () => Error('Browser profile setup is invalid.');

function validatedProfiles(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'primary,test'
      || [...IDS].some(id => typeof value[id] !== 'string' || !PROFILE.test(value[id]))
      || value.primary === value.test) throw invalidConfig();
  return Object.freeze({ primary: value.primary, test: value.test });
}

// This optional file is written from the two existing, verified Chrome profile
// directories. No Chrome profile contents or credentials are read by this module.
export async function loadBrowserProfiles({ file = new URL('../private/browser-profiles.json', import.meta.url), readFileImpl = readFile } = {}) {
  let source;
  try { source = await readFileImpl(file, { encoding: 'utf8', signal: AbortSignal.timeout(1500) }); }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw invalidConfig();
  }
  try {
    if (typeof source !== 'string' || Buffer.byteLength(source) > 4096) throw invalidConfig();
    return validatedProfiles(JSON.parse(source));
  } catch { throw invalidConfig(); }
}

function browserEnvironment() {
  // Do not copy application tokens, proxy settings or runtime injection flags
  // into a newly launched browser. Keep the ordinary macOS session variables.
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  for (const key of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_CTYPE', '__CF_USER_TEXT_ENCODING']) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  return env;
}

export function createBrowserLauncher({ profiles, spawnImpl = spawn, platform = process.platform, now = Date.now,
  cooldownMs = 20000, spawnTimeoutMs = 1500 } = {}) {
  const mapping = profiles === undefined ? undefined : validatedProfiles(profiles);
  if (typeof spawnImpl !== 'function' || typeof now !== 'function'
      || !Number.isFinite(cooldownMs) || cooldownMs < 1 || cooldownMs > 60000
      || !Number.isFinite(spawnTimeoutMs) || spawnTimeoutMs < 1 || spawnTimeoutMs > 5000) throw Error('Invalid browser launcher configuration.');
  const recent = new Map(), flights = new Map(), lastAttempt = new Map();
  const available = id => IDS.has(id) && platform === 'darwin' && !!mapping;
  const prune = at => {
    for (const [key, entry] of recent) if (!entry.pending && at >= entry.at && at - entry.at >= CACHE_MS) recent.delete(key);
    // Active per-account flights remain in their own two-entry map, so even
    // evicting an old in-flight request alias cannot create another process.
    while (recent.size > CACHE_LIMIT) recent.delete(recent.keys().next().value);
  };
  const launch = id => new Promise((resolve, reject) => {
    let child, settled = false, timer;
    const done = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(failure('Chrome could not be opened. Check that the Mac is signed in and Chrome is installed.'));
      else resolve({ ok: true, state: 'opening' });
    };
    try {
      child = spawnImpl(CHROME,
        [`--profile-directory=${mapping[id]}`, '--new-window', `http://127.0.0.1:8795/accounts/${id}`],
        { detached: true, stdio: 'ignore', shell: false, env: browserEnvironment() });
      if (!child || typeof child.once !== 'function' || typeof child.unref !== 'function') return done(true);
      child.once('error', () => done(true));
      child.once('spawn', () => {
        try { child.unref(); done(false); } catch { done(true); }
      });
      // A late or unconfirmed launch may still open a window. Never kill Chrome
      // or retry here: the caller waits for the paired browser heartbeat.
      timer = setTimeout(() => done(true), spawnTimeoutMs);
    } catch { done(true); }
  });
  async function open(id, requestId) {
    if (!IDS.has(id)) throw failure('Unknown companion browser.', 404);
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) throw failure('Invalid browser request.', 400);
    if (!available(id)) throw failure('Automatic browser opening is unavailable on this Mac. Open the selected Chrome profile first.');
    const at = now(), key = `${id}:${requestId}`;
    prune(at);
    if (recent.has(key)) return recent.get(key).promise;
    const current = flights.get(id);
    if (current) {
      recent.set(key, current); prune(at);
      return current.promise;
    }
    if (lastAttempt.has(id) && at - lastAttempt.get(id) < cooldownMs) {
      throw failure('A browser open was just requested. Wait for its connection before trying again.', 429);
    }
    lastAttempt.set(id, at);
    const entry = { at, pending: true, promise: null };
    const promise = launch(id).finally(() => {
      entry.pending = false;
      if (flights.get(id) === entry) flights.delete(id);
      prune(now());
    });
    entry.promise = promise;
    recent.set(key, entry); flights.set(id, entry); prune(at);
    return promise;
  }
  return { available, open };
}
