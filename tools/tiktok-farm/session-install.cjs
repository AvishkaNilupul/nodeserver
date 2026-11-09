// Receive a new slot over stdin. Existing account state is never overwritten.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; if (input.length > 65536) process.exit(1); });
process.stdin.on('end', () => {
  let temporary;
  try {
    const { packet, digest } = JSON.parse(input), root = process.argv[2];
    if (!/^tiktok-(0[3-9]|[1-9][0-9])$/.test(packet.account) || !/^[a-f0-9]{64}$/.test(digest)) throw Error();
    const dest = path.join(root, packet.account);
    if (fs.existsSync(dest)) {
      const mark = JSON.parse(fs.readFileSync(path.join(dest, 'enrollment.json')));
      if (mark.digest !== digest) throw Error();
      process.stdout.write('{"ok":true}'); return;
    }
    temporary = fs.mkdtempSync(path.join(root, '.install-')); fs.chmodSync(temporary, 0o700);
    const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(packet)), cipher.final()]);
    const files = { 'session.key': key, 'session.enc': JSON.stringify({ iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), body: body.toString('base64') }),
      'enrollment.json': JSON.stringify({ digest }), 'known-rooms.json': '{}' };
    for (const [name, data] of Object.entries(files)) {
      const fd = fs.openSync(path.join(temporary, name), 'wx', 0o600);
      try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    fs.renameSync(temporary, dest); temporary = null;
    process.stdout.write('{"ok":true}');
  } catch {
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
    process.stderr.write('Session installation failed\n'); process.exitCode = 1;
  }
});
