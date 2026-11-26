import { mkdir, writeFile, chmod, readFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { INSTANCE, validateHostPairing } from './lib/instance.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const label = INSTANCE.serviceLabel;
const folder = `${homedir()}/Library/LaunchAgents`;
const file = `${folder}/${label}.plist`;
const domain = `gui/${process.getuid()}`;
const action = process.argv[2] || 'status';
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const run = (...args) => spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
const required = (...args) => {
  const result = run(...args);
  if (result.status !== 0) throw new Error(`launchctl ${args[0]} failed: ${result.error?.message || result.stderr?.trim() || `exit ${result.status ?? result.signal ?? 'unknown'}`}`);
  return result;
};
const loaded = () => {
  const result = run('print', `${domain}/${label}`);
  if (result.error) throw new Error(`Could not check the fourth helper: ${result.error.message}`);
  const detail = result.stderr?.trim();
  if (result.status !== 0 && detail && !/could not find (?:specified )?service|service not found|no such process/i.test(detail)) {
    throw new Error(`Could not check the fourth helper: ${detail}`);
  }
  return result.status === 0;
};
if (process.platform !== 'darwin') throw new Error('Automatic startup currently supports macOS. Use npm start on other systems.');
if (action === 'install') {
  await readFile(`${root}private/config.json`); // Setup must exist; never print credentials.
  validateHostPairing(JSON.parse(await readFile(`${root}private/host.json`, 'utf8')));
  const intent = JSON.parse(await readFile(`${root}private/control-intent.json`, 'utf8'));
  if (!intent || intent.version !== 1 || typeof intent.held !== 'boolean') throw Error('Prepare this helper’s independent control intent before installing its service.');
  await mkdir(folder, { recursive: true });
  for (const name of ['helper.log', 'helper-error.log']) {
    await writeFile(`${root}private/${name}`, '', { flag: 'a', mode: 0o600 });
    await chmod(`${root}private/${name}`, 0o600);
  }
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(root)}server.mjs</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer><key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(root)}private/helper.log</string>
<key>StandardErrorPath</key><string>${xml(root)}private/helper-error.log</string>
</dict></plist>\n`;
  if (run('print', `${domain}/${label}`).status === 0) required('bootout', `${domain}/${label}`);
  await writeFile(file, plist, { mode: 0o600 }); await chmod(file, 0o600);
  required('bootstrap', domain, file);
  console.log('Helper installed and started. It restarts after a crash and starts at macOS login. Chrome must remain open for replies.');
} else if (action === 'start') {
  if (loaded()) console.log('Fourth helper is already started.');
  else {
    try { await readFile(file); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error('Fourth helper is not installed. Run npm run service:install first.');
      throw new Error(`Cannot read the installed fourth helper service: ${error.message}`);
    }
    required('bootstrap', domain, file);
    console.log('Fourth helper started from its existing installation.');
  }
} else if (action === 'stop') {
  if (loaded()) {
    required('bootout', `${domain}/${label}`);
    console.log('Fourth helper stopped. Its login service, project and private data are preserved.');
  } else console.log('Fourth helper is already stopped. Its installation and private data are preserved.');
} else if (action === 'status') {
  const result = run('print', `${domain}/${label}`);
  console.log(result.status === 0 ? result.stdout.split('\n').filter(line => /^\s*(state|pid|runs|last exit code) =/.test(line)).join('\n') : 'Helper startup service is not loaded.');
} else if (action === 'restart') {
  required('kickstart', '-k', `${domain}/${label}`); console.log('Helper restarted.');
} else if (action === 'uninstall') {
  if (run('print', `${domain}/${label}`).status === 0) required('bootout', `${domain}/${label}`);
  await unlink(file).catch(e => { if (e.code !== 'ENOENT') throw e; });
  console.log('Helper startup service removed. Project and private data preserved.');
} else throw new Error('Use install, start, stop, status, restart, or uninstall.');
