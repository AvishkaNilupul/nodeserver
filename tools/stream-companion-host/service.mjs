import { mkdir, writeFile, chmod, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('.', import.meta.url)), label = 'local.stream-companion.host';
const folder = `${homedir()}/Library/LaunchAgents`, file = `${folder}/${label}.plist`, domain = `gui/${process.getuid()}`;
const action = process.argv[2] || 'status';
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const run = (...args) => spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
const required = (...args) => { const r = run(...args); if (r.status !== 0) throw Error(`launchctl ${args[0]} failed: ${r.stderr?.trim() || r.error?.message || r.status}`); return r; };
if (process.platform !== 'darwin') throw Error('Use npm start on this operating system.');
if (action === 'install') {
  await readFile(`${root}private/config.json`); await mkdir(folder, { recursive: true });
  for (const name of ['host.log', 'host-error.log']) { await writeFile(`${root}private/${name}`, '', { flag: 'a', mode: 0o600 }); await chmod(`${root}private/${name}`, 0o600); }
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(root)}server.mjs</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer><key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(root)}private/host.log</string><key>StandardErrorPath</key><string>${xml(root)}private/host-error.log</string>
</dict></plist>\n`;
  if (run('print', `${domain}/${label}`).status === 0) required('bootout', `${domain}/${label}`);
  await writeFile(file, plist, { mode: 0o600 }); await chmod(file, 0o600); required('bootstrap', domain, file);
  console.log('Central host installed. It restarts after a crash and starts at Mac login.');
} else if (action === 'status') {
  const r = run('print', `${domain}/${label}`); console.log(r.status === 0 ? r.stdout.split('\n').filter(x => /^\s*(state|pid|runs|last exit code) =/.test(x)).join('\n') : 'Central host service is not loaded.');
} else if (action === 'restart') { required('kickstart', '-k', `${domain}/${label}`); console.log('Central host restarted.'); }
else if (action === 'stop') { if (run('print', `${domain}/${label}`).status === 0) required('bootout', `${domain}/${label}`); console.log('Central host stopped; its installation and data are preserved.'); }
else if (action === 'start') { if (run('print', `${domain}/${label}`).status !== 0) { await readFile(file); required('bootstrap', domain, file); } console.log('Central host is started.'); }
else throw Error('Use install, start, stop, status or restart.');
