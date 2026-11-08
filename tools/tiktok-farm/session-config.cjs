// Private phone-local encryption key; never the production encryption master key.
const fs = require('node:fs');
const { createDecipheriv } = require('node:crypto');
try {
  const cipher = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const key = fs.readFileSync(process.argv[3]);
  const decrypt = createDecipheriv('aes-256-gcm', key, Buffer.from(cipher.iv, 'base64'));
  decrypt.setAuthTag(Buffer.from(cipher.tag, 'base64'));
  process.stdout.write(Buffer.concat([decrypt.update(Buffer.from(cipher.body, 'base64')), decrypt.final()]));
} catch {
  process.stderr.write('Private session could not be opened\n');
  process.exitCode = 1;
}
