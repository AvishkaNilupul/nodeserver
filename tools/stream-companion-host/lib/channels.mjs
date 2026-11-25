const GQL_URL = 'https://gql.twitch.tv/gql';
// Public Twitch client identifier already used by nodeserver's read-only
// account/liveness probes. No account authorization or cookies are sent.
const PUBLIC_CLIENT_ID = 'kd1unb4b3q4t58fwlpcbzcbnm76a8fp';
const LOGIN = /^[a-z0-9_]{3,25}$/;
const MAX_RESPONSE = 196608;
const PINNED = 'aviskarex';
const DIRECTORY_LIMIT = 12;
const CHANNEL_QUERY = 'query CompanionChannel($login:String!){user(login:$login){login displayName broadcastSettings{title game{name}} stream{id viewersCount game{name}}}}';
const DIRECTORY_QUERY = 'query CompanionDirectory($first:Int!){streams(first:$first,options:{sort:VIEWER_COUNT}){edges{node{id viewersCount game{name} broadcaster{login displayName broadcastSettings{title}}}}}}';
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
const viewers = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 100000000) : null;
const invalid = () => Object.assign(new Error('Enter a Twitch channel login with 3–25 letters, numbers or underscores.'), { status: 400 });
const unknown = (login, checkedAt, error = 'Live status is temporarily unavailable.') => ({
  login, displayName: login, title: '', game: '', viewers: null, isLive: null, checkedAt, error
});

async function boundedJSON(response) {
  if (!response || response.status !== 200 || !response.body?.getReader
      || Number(response.headers.get('content-length')) > MAX_RESPONSE) throw Error('Unavailable');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE) { await reader.cancel(); throw Error('Unavailable'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!record(body) || !record(body.data) || body.errors !== undefined && (!Array.isArray(body.errors) || body.errors.length)) throw Error('Unavailable');
  return body.data;
}

function channelFromUser(user, expected, checkedAt) {
  if (user === null) return unknown(expected, checkedAt, 'This Twitch channel was not found.');
  if (!record(user) || user.login !== expected || !Object.hasOwn(user, 'stream')) throw Error('Unavailable');
  const stream = user.stream;
  if (stream !== null && (!record(stream) || typeof stream.id !== 'string' || !/^\d{1,32}$/.test(stream.id))) throw Error('Unavailable');
  return { login: expected, displayName: text(user.displayName, 60) || expected,
    title: text(user.broadcastSettings?.title, 180), game: text(stream?.game?.name ?? user.broadcastSettings?.game?.name, 100),
    viewers: stream ? viewers(stream.viewersCount) : 0, isLive: stream !== null, checkedAt };
}

function directoryFromData(data, checkedAt) {
  if (!Array.isArray(data.streams?.edges) || data.streams.edges.length > 30) throw Error('Unavailable');
  const result = [], seen = new Set();
  for (const edge of data.streams.edges) {
    const stream = edge?.node, broadcaster = stream?.broadcaster;
    if (!record(stream) || typeof stream.id !== 'string' || !/^\d{1,32}$/.test(stream.id)
        || !record(broadcaster) || !LOGIN.test(broadcaster.login || '') || seen.has(broadcaster.login)) continue;
    seen.add(broadcaster.login);
    result.push({ login: broadcaster.login, displayName: text(broadcaster.displayName, 60) || broadcaster.login,
      title: text(broadcaster.broadcastSettings?.title, 180), game: text(stream.game?.name, 100),
      viewers: viewers(stream.viewersCount), isLive: true, checkedAt });
    if (result.length === DIRECTORY_LIMIT) break;
  }
  return result;
}

export function createChannelDirectory({ fetchImpl = fetch, now = Date.now, timeoutMs = 3500, cacheMs = 30000 } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000
      || !Number.isFinite(cacheMs) || cacheMs < 0 || cacheMs > 60000) throw Error('Invalid live channel directory configuration.');
  let snapshotCache = null, snapshotFlight = null;
  const lookupCache = new Map(), lookupFlights = new Map();
  const fresh = entry => entry && now() >= entry.at && now() - entry.at < entry.ttl;
  const request = async (query, variables) => {
    // Only these two fixed read queries can reach this fixed HTTPS origin.
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => boundedJSON(await fetchImpl(GQL_URL, {
          method: 'POST', redirect: 'error', credentials: 'omit', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'Client-Id': PUBLIC_CLIENT_ID },
          body: JSON.stringify({ query, variables })
        })))(),
        new Promise((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('Unavailable')); }, timeoutMs); })
      ]);
    } finally { clearTimeout(timer); }
  };
  const lookup = async login => {
    if (typeof login !== 'string' || !LOGIN.test(login)) throw invalid();
    const cached = lookupCache.get(login);
    if (fresh(cached)) return structuredClone(cached.value);
    if (lookupFlights.has(login)) return structuredClone(await lookupFlights.get(login));
    const flight = (async () => {
      let value;
      try {
        const data = await request(CHANNEL_QUERY, { login });
        if (!Object.hasOwn(data, 'user')) throw Error('Unavailable');
        value = channelFromUser(data.user, login, now());
      } catch { value = unknown(login, now()); }
      lookupCache.delete(login);
      lookupCache.set(login, { at: now(), ttl: value.isLive === null ? Math.min(cacheMs, 5000) : cacheMs, value });
      while (lookupCache.size > 32) lookupCache.delete(lookupCache.keys().next().value);
      return value;
    })();
    lookupFlights.set(login, flight);
    try { return structuredClone(await flight); }
    finally { if (lookupFlights.get(login) === flight) lookupFlights.delete(login); }
  };
  const snapshot = async () => {
    if (fresh(snapshotCache)) return structuredClone(snapshotCache.value);
    if (snapshotFlight) return structuredClone(await snapshotFlight);
    const flight = (async () => {
      const [pinned, directory] = await Promise.all([
        lookup(PINNED),
        request(DIRECTORY_QUERY, { first: DIRECTORY_LIMIT }).then(data => ({ channels: directoryFromData(data, now()) }))
          .catch(() => ({ channels: [], error: 'Live channels are temporarily unavailable. You can still check a channel by name.' }))
      ]);
      const at = now(), value = { updatedAt: new Date(at).toISOString(), channels: [pinned, ...directory.channels.filter(channel => channel.login !== PINNED)],
        ...(directory.error ? { error: directory.error } : {}) };
      snapshotCache = { at, ttl: directory.error ? Math.min(cacheMs, 5000) : cacheMs, value };
      return value;
    })();
    snapshotFlight = flight;
    try { return structuredClone(await flight); }
    finally { if (snapshotFlight === flight) snapshotFlight = null; }
  };
  return { snapshot, lookup };
}
