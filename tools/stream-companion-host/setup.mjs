import { mkdir, readFile, writeFile, chmod, rename } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const root = new URL('./', import.meta.url), configFile = new URL('./private/config.json', root);
const definitions = [
  { id: 'primary', name: 'Stream Companion', account: 'qumaris_2489', project: '../stream-companion/' },
  { id: 'test', name: 'Stream Companion Test', account: 'lastherodarkfire7', project: '../stream-companion-test/' }
];
await mkdir(new URL('./private/', root), { recursive: true, mode: 0o700 });
let config;
try { config = JSON.parse(await readFile(configFile, 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
if (!config) {
  config = { clients: definitions.map(({ project, ...client }) => ({ ...client, token: randomBytes(32).toString('base64url') })) };
  await writeFile(configFile, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
await chmod(configFile, 0o600);
for (const definition of definitions) {
  const client = config.clients?.find(x => x.id === definition.id && x.account === definition.account);
  if (!client || typeof client.token !== 'string' || client.token.length < 32) throw Error('Existing host pairing is invalid. It was not replaced.');
  const project = new URL(definition.project, root), privateDir = new URL('./private/', project);
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  const file = new URL('./host.json', privateDir), temporary = new URL('./host.json.tmp', privateDir);
  const value = { url: 'http://127.0.0.1:8795', clientId: client.id, account: client.account, token: client.token };
  try {
    const existing = JSON.parse(await readFile(file, 'utf8'));
    if (Object.keys(value).some(key => existing[key] !== value[key])) throw Error('Existing helper host pairing differs; it was not overwritten.');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, file);
  }
  await chmod(file, 0o600);
}
console.log('Central host paired to the two existing helpers. Twitch credentials were not read or copied.');
