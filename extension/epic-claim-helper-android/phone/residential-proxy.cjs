// Firefox-only loopback proxy. Credentials live in a mode-600 file on the
// phone, never in the add-on. Upstream failure never falls back to home Wi-Fi.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

function createProxy(config) {
  if (!config.host || !Number.isInteger(config.port) || !config.username || !config.password) {
    throw Error('Residential proxy configuration is incomplete');
  }
  const auth = 'Basic ' + Buffer.from(config.username + ':' + config.password).toString('base64');
  const options = (method, target, headers = {}) => ({
    host: config.host, port: config.port, method, path: target,
    headers: { ...headers, 'proxy-authorization': auth },
    timeout: 30000, agent: false,
  });
  const server = http.createServer((req, res) => {
    let target;
    try { target = new URL(req.url); } catch { res.writeHead(400).end(); return; }
    if (target.protocol !== 'http:') { res.writeHead(400).end(); return; }
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const upstream = http.request(options(req.method, target.href, headers), reply => {
      res.writeHead(reply.statusCode, reply.headers);
      reply.pipe(res);
      reply.on('error', () => res.destroy());
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end('Residential proxy unavailable');
    });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on('connect', (req, client, head) => {
    // CONNECT carries encrypted TLS without decrypting browser traffic.
    if (!/^[a-z0-9.-]+:443$/i.test(req.url)) {
      client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return;
    }
    const upstream = http.request(options('CONNECT', req.url, { host: req.url }));
    let tunnel;
    const failed = () => {
      if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    };
    upstream.on('connect', (reply, socket, upstreamHead) => {
      if (reply.statusCode !== 200) { socket.destroy(); failed(); return; }
      tunnel = socket;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) socket.write(head);
      if (upstreamHead.length) client.write(upstreamHead);
      socket.on('error', () => client.destroy());
      socket.on('close', () => client.destroy());
      client.pipe(socket).pipe(client);
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', failed);
    client.on('error', () => { upstream.destroy(); tunnel?.destroy(); });
    client.on('close', () => { upstream.destroy(); tunnel?.destroy(); });
    upstream.end();
  });
  server.on('clientError', (_err, socket) => socket.destroy());
  return server;
}

if (require.main === module) {
  const filename = process.env.EPIC_PHONE_PROXY_CONFIG || path.join(__dirname, 'residential-proxy.json');
  const config = JSON.parse(fs.readFileSync(filename, 'utf8'));
  createProxy(config).listen(8124, '127.0.0.1', () => console.log('Firefox residential proxy listening on loopback:8124'));
}
module.exports = { createProxy };
