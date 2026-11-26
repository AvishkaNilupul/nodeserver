import { generateKeyPairSync, createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, chmod, rename } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { INSTANCE } from './lib/instance.mjs';

const optional = async url => {
  let text;
  try { text = await readFile(url, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw Error('Local setup metadata could not be read.'); }
  try { return JSON.parse(text); }
  catch { throw Error('Local setup metadata is invalid; preserve it for inspection.'); }
};
const object = value => value && typeof value === 'object' && !Array.isArray(value);
async function privateJSON(url, value) {
  const temporary = new URL(`${url.href}.tmp`);
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await chmod(temporary, 0o600); await rename(temporary, url); await chmod(url, 0o600);
}

// Fresh local identity only. No account allocation, OAuth/provider request,
// host registration, service or Chrome profile operation occurs.
export async function prepareInstance({ root = new URL('./', import.meta.url) } = {}) {
  const manifestURL = new URL('./extension/manifest.json', root), configURL = new URL('./private/config.json', root);
  const manifest = await optional(manifestURL), old = await optional(configURL);
  if (!object(manifest) || manifest.name !== INSTANCE.extensionName
    || JSON.stringify(manifest.host_permissions) !== JSON.stringify([`http://127.0.0.1:${INSTANCE.helperPort}/*`])) throw Error('The fourth companion source identity does not match its fixed helper port.');
  if (old !== undefined && !object(old)) throw Error('Existing local setup is invalid; preserve it for inspection.');
  if (old && !manifest.key) throw Error('Existing private setup has no matching extension key. Preserve the installed identity before updating.');
  if (old?.hostClientId && old.hostClientId !== INSTANCE.clientId) throw Error('Another companion configuration cannot be reused for the fourth instance.');
  if (old?.pairingToken && (typeof old.pairingToken !== 'string' || !/^[a-f0-9]{64}$/.test(old.pairingToken))) throw Error('Existing local pairing needs inspection.');
  const intentURL = new URL('./private/control-intent.json', root), intent = await optional(intentURL);
  if (intent !== undefined && (!object(intent) || intent.version !== 1 || typeof intent.held !== 'boolean'
    || Object.keys(intent).length !== 2)) throw Error('Existing control intent needs inspection; it was not reset.');
  if (!manifest.key) {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'der' }, privateKeyEncoding: { type: 'pkcs8', format: 'der' } });
    manifest.key = publicKey.toString('base64');
  }
  if (typeof manifest.key !== 'string' || !/^[A-Za-z0-9+/=]{128,4096}$/.test(manifest.key)) throw Error('The extension identity is invalid.');
  const extensionId = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)
    .toString('hex').replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
  if (old?.extensionId && old.extensionId !== extensionId) throw Error('The existing extension identity differs from its private pairing.');
  const privateURL = new URL('./private/', root);
  await mkdir(privateURL, { recursive: true, mode: 0o700 }); await chmod(privateURL, 0o700);
  await writeFile(manifestURL, JSON.stringify(manifest, null, 2) + '\n');
  await privateJSON(configURL, { baseUrl: 'https://api.openai.com/v1', apiStyle: 'responses', model: '', apiKey: '',
    ...old, extensionId, hostClientId: INSTANCE.clientId, pairingToken: old?.pairingToken || randomBytes(32).toString('hex') });
  if (intent === undefined) await privateJSON(intentURL, { version: 1, held: true });
  return { extensionId, clientId: INSTANCE.clientId, helperPort: INSTANCE.helperPort, serviceLabel: INSTANCE.serviceLabel,
    held: intent?.held ?? true, accountBound: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await prepareInstance();
  console.log(`Prepared ${INSTANCE.extensionName} ${result.extensionId}; central client ${result.clientId}, helper port ${result.helperPort}. Account and host pairing remain separate.`);
}
