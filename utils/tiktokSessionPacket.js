const { createHash } = require('node:crypto');
const HOST = /^(?:webcast[a-z0-9-]*|aggr[0-9]+-normal|tnc[a-z0-9-]*|cp-rp[a-z0-9-]*|web-ttp2\.us)\.(?:tiktokv?\.com|tiktokv\.us|tiktokv\.eu)$/;
const SOCKET = /^webcast-frontier[a-z0-9-]*\.(?:tiktokv\.com|tiktokv\.us|tiktokv\.eu)$/;
const id = v => typeof v === 'string' && /^[0-9]{1,22}$/.test(v);
const headers = v => Array.isArray(v) && v.length > 0 && v.length <= 100 && v.every(r =>
  Array.isArray(r) && r.length === 2 && r.every(s => typeof s === 'string' && s.length <= 16000 && !/[\r\n\0]/.test(s)));
const b64 = v => typeof v === 'string' && v.length <= 32000 && /^[A-Za-z0-9+/]*={0,2}$/.test(v) && Buffer.from(v, 'base64').toString('base64') === v;
function parsePacket(packet, account) {
  if (!packet || packet.account !== account || !id(packet.seedRoom) || !id(packet.seedAnchor)) return null;
  const s = packet.seed;
  if (!s || !HOST.test(s.host) || !headers(s.headers) || !b64(s.body) || !s.body) return null;
  const h = Object.fromEntries(s.headers);
  if (!HOST.test(h[':authority']) || h[':method'] !== 'POST' ||
      !/^\/webcast\/room\/enter\/(?:\?|$)/.test(h[':path'] || '') || !h.cookie || !h['x-tt-token']) return null;
  if (!Array.isArray(packet.wire) || !packet.wire.length || packet.wire.length > 4 || !packet.wire.every(w =>
    SOCKET.test(w.host) && typeof w.path === 'string' && w.path.length <= 12000 &&
    /^\/webcast\/im\/ws_proxy\/(?:\?|$)/.test(w.path) && !/[\r\n\0]/.test(w.path) && headers(w.headers) &&
    Array.isArray(w.frames) && w.frames.length >= 1 && w.frames.length <= 4 && w.frames.every(f => b64(f) && f))) return null;
  const clean = { account, seedRoom: packet.seedRoom, seedAnchor: packet.seedAnchor,
    seed: { host: s.host, headers: s.headers, body: s.body },
    wire: packet.wire.map(w => ({ host: w.host, path: w.path, headers: w.headers, frames: w.frames })) };
  const text = JSON.stringify(clean);
  if (Buffer.byteLength(text) > 48000) return null;
  return { packet: clean, text, digest: createHash('sha256').update(text).digest('hex') };
}
module.exports = { parsePacket };
