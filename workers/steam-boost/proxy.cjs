// A residential exit in the account's own signup country, so Steam sees the
// account log in from where it was made. ProxyScrape only; credentials from the
// worker's env file (RES_HOST, RES_PORT, RES_USER, RES_PASS), never from git.
// 24-hour sticky session (ProxyScrape's maximum): an idle login stays connected
// for hours. No packages: the exit is checked with a plain HTTP CONNECT.
const crypto = require('crypto');
const http = require('http');
const tls = require('tls');
const net = require('net');

const LIFETIME_MINUTES = 1440;

function readProxy(env = process.env) {
  const host = env.RES_HOST || '';
  const port = Number(env.RES_PORT);
  const username = env.RES_USER || '';
  const password = env.RES_PASS || '';
  if (!/^[a-z0-9.-]+$/i.test(host) || !Number.isInteger(port) || port < 1 || port > 65535 || !username || !password) {
    throw Error('Residential proxy settings are missing (RES_HOST, RES_PORT, RES_USER, RES_PASS)');
  }
  return { host, port, username, password };
}

function countryProxy(country, { read = readProxy } = {}) {
  if (!/^[A-Z]{2}$/.test(country || '')) throw Error('The account has no signup country');
  const p = read();
  if (p.host.toLowerCase() !== 'rp.scrapegw.com') throw Error('Country proxies need the ProxyScrape residential provider');
  const base = p.username
    .replace(/-country-[a-z]{2}(?=-|$)/ig, '')
    .replace(/-(?:state|city)-[^-]+/ig, '')
    .replace(/-(?:sessid|session)-[a-z0-9]+/ig, '')
    .replace(/-lifetime-\d+/ig, '');
  const session = crypto.randomBytes(8).toString('hex');
  return { ...p, username: `${base}-country-${country.toLowerCase()}-session-${session}-lifetime-${LIFETIME_MINUTES}` };
}

function proxyUrl(p) {
  return `http://${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@${p.host}:${p.port}`;
}

// Where does this exit come out? GET https://ipwho.is/ through the proxy.
function lookupExit(p, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${p.username}:${p.password}`).toString('base64');
    const req = http.request({
      host: p.host, port: p.port, method: 'CONNECT', path: 'ipwho.is:443',
      headers: { Host: 'ipwho.is:443', 'Proxy-Authorization': 'Basic ' + auth },
      timeout: timeoutMs,
    });
    const fail = (e) => reject(e instanceof Error ? e : Error(String(e)));
    req.on('timeout', () => { req.destroy(); fail('exit check timed out'); });
    req.on('error', fail);
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return fail('proxy said ' + res.statusCode); }
      const s = tls.connect({ socket, servername: 'ipwho.is' }, () => {
        s.write('GET / HTTP/1.1\r\nHost: ipwho.is\r\nUser-Agent: steam-boost\r\nConnection: close\r\n\r\n');
      });
      let raw = '';
      s.setTimeout(timeoutMs, () => { s.destroy(); fail('exit check timed out'); });
      s.on('data', (d) => { raw += d; if (raw.length > 65536) s.destroy(); });
      s.on('error', fail);
      s.on('end', () => {
        try {
          const body = raw.slice(raw.indexOf('\r\n\r\n') + 4);
          const json = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1));
          if (json.success !== true || !net.isIP(json.ip) || !/^[A-Z]{2}$/.test(json.country_code || '')) throw Error('bad answer');
          resolve({ country: json.country_code, city: String(json.city || '').slice(0, 80) });
        } catch (e) {
          fail('exit check unreadable');
        }
      });
    });
    req.end();
  });
}

// Returns { url, location } once an exit in `country` is confirmed.
async function verifiedCountryProxy(country, { read = readProxy, lookup = lookupExit, attempts = 3 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const p = countryProxy(country, { read });
    try {
      const location = await lookup(p);
      if (location.country === country) return { url: proxyUrl(p), location };
    } catch { /* try a new session */ }
  }
  throw Error(`No ${country} proxy exit available right now`);
}

module.exports = { readProxy, countryProxy, proxyUrl, lookupExit, verifiedCountryProxy, LIFETIME_MINUTES };
