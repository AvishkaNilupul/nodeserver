const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class Store {
  constructor(directory) {
    this.directory = directory;
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    fs.chmodSync(directory, 0o700);
    this.file = path.join(directory, 'queue.vault');
    this.keyfile = path.join(directory, 'queue.key');
    this.lockfile = path.join(directory, 'queue.lock');
    if (!fs.existsSync(this.keyfile)) {
      if (fs.existsSync(this.file)) throw Error('Queue key missing; restore the key before continuing');
      try { fs.writeFileSync(this.keyfile, crypto.randomBytes(32), {flag: 'wx', mode: 0o600}); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    this.key = fs.readFileSync(this.keyfile);
    if (this.key.length !== 32) throw Error('Invalid queue key');
    fs.chmodSync(this.keyfile, 0o600);
    this.read();
  }
  read() {
    if (!fs.existsSync(this.file)) return {version: 1, jobs: [], observations: [], config: {enabled: true}};
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(raw.iv, 'base64'));
    d.setAuthTag(Buffer.from(raw.tag, 'base64'));
    const data = JSON.parse(Buffer.concat([d.update(Buffer.from(raw.data, 'base64')), d.final()]).toString());
    if (data.version !== 1 || !Array.isArray(data.jobs) || !Array.isArray(data.observations)) throw Error('Invalid queue contents');
    return data;
  }
  write(data) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([c.update(JSON.stringify(data)), c.final()]);
    const temporary = this.file + '.' + crypto.randomUUID() + '.tmp';
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({version: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: encrypted.toString('base64')}));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, this.file);
    const dirfd = fs.openSync(this.directory, 'r');
    try { fs.fsyncSync(dirfd); } finally { fs.closeSync(dirfd); }
  }
  transact(fn) {
    let fd;
    try { fd = fs.openSync(this.lockfile, 'wx', 0o600); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let owner;
      try { owner = JSON.parse(fs.readFileSync(this.lockfile, 'utf8')); } catch {}
      let alive = true;
      if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); } catch (err) { alive = err.code !== 'ESRCH'; }
      } else if (Date.now() - fs.statSync(this.lockfile).mtimeMs > 30000) alive = false;
      if (alive) throw Object.assign(Error('Queue busy; retry the same operation'), {status: 409});
      fs.unlinkSync(this.lockfile);
      return this.transact(fn);
    }
    const owner = {pid: process.pid, nonce: crypto.randomUUID()};
    try {
      fs.writeFileSync(fd, JSON.stringify(owner)); fs.fsyncSync(fd);
      const data = this.read();
      const result = fn(data);
      if (result && typeof result.then === 'function') throw Error('Queue transactions must be synchronous');
      this.write(data);
      return result;
    } finally {
      fs.closeSync(fd);
      try { if (JSON.parse(fs.readFileSync(this.lockfile, 'utf8')).nonce === owner.nonce) fs.unlinkSync(this.lockfile); } catch {}
    }
  }
}
module.exports = {Store};
