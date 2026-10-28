// Read the existing local residential configuration without copying secrets
// into the repo or exposing them to the hosted nodeserver panel.
const fs = require('fs');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');
function readProxy(env = process.env, filename = path.join(os.homedir(), 'epic-claim', '.env')) {
  let saved = {};
  if (fs.existsSync(filename)) saved = dotenv.parse(fs.readFileSync(filename));
  const get = key => env[key] || saved[key] || '';
  const host = get('RES_HOST');
  const port = Number(get('RES_PORT'));
  const username = get('RES_USER');
  const password = get('RES_PASS');
  if (!/^[a-z0-9.-]+$/i.test(host) || !Number.isInteger(port) || port < 1 || port > 65535 || !username || !password) {
    throw new Error('Residential proxy configuration is missing RES_HOST, RES_PORT, RES_USER or RES_PASS in ~/epic-claim/.env');
  }
  const sessionId = require('crypto').randomBytes(8).toString('hex');
  // Regular ProxyScrape uses -session- and -lifetime-, not -sessid-.
  // https://docs.proxyscrape.com/proxies/residential/sticky-sessions
  // Keep country/region targeting while replacing stale session parameters.
  const proxyScrape = host.toLowerCase() === 'rp.scrapegw.com';
  const base = proxyScrape
    ? username.replace(/-(?:sessid|session)-[a-z0-9]+/ig, '').replace(/-lifetime-\d+/ig, '')
    : username.replace(/-sessid-[a-z0-9]+/ig, '');
  const sticky = base + (proxyScrape ? '-session-' + sessionId + '-lifetime-30' : '-sessid-' + sessionId);
  return { scheme: 'http', host, port, username: sticky, password };
}
module.exports = { readProxy };
