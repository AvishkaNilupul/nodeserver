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
  let base = proxyScrape
    ? username.replace(/-(?:sessid|session)-[a-z0-9]+/ig, '').replace(/-lifetime-\d+/ig, '')
    : username.replace(/-sessid-[a-z0-9]+/ig, '');
  // Default an untargeted/Russian route to US; preserve existing non-RU targeting.
  if (proxyScrape && (!/-country-[a-z]{2}(?:-|$)/i.test(base) || /-country-ru(?:-|$)/i.test(base))) {
    base = base.replace(/-country-[a-z]{2}(?=-|$)/ig, '').replace(/-(?:state|city)-[^-]+/ig, '') + '-country-us';
  }
  const sticky = base + (proxyScrape ? '-session-' + sessionId + '-lifetime-30' : '-sessid-' + sessionId);
  return { scheme: 'http', host, port, username: sticky, password };
}
async function lookupExit(proxy) {
  const { HttpsProxyAgent } = require('https-proxy-agent');
  const url = new URL('http://' + proxy.host + ':' + proxy.port);
  url.username = proxy.username; url.password = proxy.password;
  try {
    const {data} = await require('axios').get('https://ipwho.is/', {
      httpsAgent: new HttpsProxyAgent(url.toString()), proxy: false, timeout: 8000,
      maxRedirects: 0, maxContentLength: 16384,
    });
    if (data.success !== true || !require('net').isIP(data.ip) || !/^[A-Z]{2}$/.test(data.country_code || '')) throw Error();
    return {country:data.country_code,ip:data.ip,city:String(data.city||'').slice(0,120),region:String(data.region||'').slice(0,120),observedAt:new Date().toISOString(),source:'proxy-ip'};
  } catch { throw Error('Could not verify the residential exit country. No inbox was reserved.'); }
}
async function verifiedProxy({read=readProxy,lookup=lookupExit,attempts=3}={}) {
  for(let i=0;i<attempts;i++) {
    const proxy=read();
    const location=await lookup(proxy);
    if(location.country==='RU')continue;
    if(!/^[A-Z]{2}$/.test(location.country||'') || !require('net').isIP(location.ip))throw Error('Residential exit location is unknown. No inbox was reserved.');
    return {...proxy,location};
  }
  throw Error('Russian residential exits are blocked. No inbox was reserved.');
}
module.exports = { readProxy, lookupExit, verifiedProxy };
