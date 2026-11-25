import { mkdir, writeFile, chmod, readFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';

export const REMOTE_SERVICE_LABEL = 'local.stream-companion.remote-tunnel';
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

export function tunnelArguments(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)
      || Object.keys(config).sort().join(',') !== 'sshHost,sshKey,sshUser'
      || typeof config.sshHost !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/.test(config.sshHost)
      || typeof config.sshUser !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/i.test(config.sshUser)
      || typeof config.sshKey !== 'string' || !isAbsolute(config.sshKey) || /[\u0000-\u001f\u007f]/.test(config.sshKey)) {
    throw Error('Invalid private remote-tunnel configuration.');
  }
  return ['/usr/bin/caffeinate', '-is', '/usr/bin/ssh', '-F', '/dev/null', '-N', '-T',
    '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ForwardAgent=no', '-o', 'ControlMaster=no', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3',
    '-o', 'LogLevel=ERROR', '-i', config.sshKey,
    '-R', '127.0.0.1:18795:127.0.0.1:8795', `${config.sshUser}@${config.sshHost}`];
}

export function tunnelPlist(config, root) {
  const args = tunnelArguments(config);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${REMOTE_SERVICE_LABEL}</string>
<key>ProgramArguments</key><array>${args.map(x => `<string>${xml(x)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(root)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>15</integer><key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(root)}private/remote-tunnel.log</string>
<key>StandardErrorPath</key><string>${xml(root)}private/remote-tunnel-error.log</string>
</dict></plist>\n`;
}

async function main() {
  if (process.platform !== 'darwin') throw Error('The remote tunnel service requires macOS.');
  const root = fileURLToPath(new URL('.', import.meta.url));
  const folder = `${homedir()}/Library/LaunchAgents`, file = `${folder}/${REMOTE_SERVICE_LABEL}.plist`;
  const domain = `gui/${process.getuid()}`, target = `${domain}/${REMOTE_SERVICE_LABEL}`;
  const run = (...args) => spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
  const required = (...args) => { const r = run(...args); if (r.status !== 0) throw Error(`Remote connection service ${args[0]} failed.`); return r; };
  const action = process.argv[2] || 'status';
  if (action === 'install') {
    let config;
    try { config = JSON.parse(await readFile(`${root}private/tunnel.json`, 'utf8')); } catch { throw Error('Configure private/tunnel.json before installing the remote connection.'); }
    const plist = tunnelPlist(config, root); await access(config.sshKey);
    await mkdir(folder, { recursive: true });
    for (const name of ['remote-tunnel.log', 'remote-tunnel-error.log']) {
      await writeFile(`${root}private/${name}`, '', { flag: 'a', mode: 0o600 }); await chmod(`${root}private/${name}`, 0o600);
    }
    if (run('print', target).status === 0) required('bootout', target);
    await writeFile(file, plist, { mode: 0o600 }); await chmod(file, 0o600);
    required('bootstrap', domain, file);
    console.log('Private controller connection installed. It starts at Mac login and reconnects without restarting companions.');
  } else if (action === 'status') {
    const r = run('print', target);
    console.log(r.status === 0 ? r.stdout.split('\n').filter(x => /^\s*(state|pid|runs|last exit code) =/.test(x)).join('\n') : 'Private controller connection is not loaded.');
  } else if (action === 'stop') {
    if (run('print', target).status === 0) required('bootout', target);
    console.log('Private controller connection stopped; companion state is unchanged.');
  } else if (action === 'start') {
    if (run('print', target).status !== 0) { await access(file); required('bootstrap', domain, file); }
    console.log('Private controller connection started.');
  } else if (action === 'restart') {
    required('kickstart', '-k', target); console.log('Private controller connection restarted.');
  } else throw Error('Use install, start, stop, restart or status.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
