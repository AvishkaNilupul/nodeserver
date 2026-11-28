import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { generateOperatorDraft } from './operator-model.mjs';
import { generateGeminiDraft } from './operator-gemini.mjs';

const defaultCredential = new URL('../private/gemini-draft.key', import.meta.url);

// A malformed configured key should affect only Draft. The rest of the host
// can still start, and a configuration problem never silently changes models.
function unavailable() {
  return { name: 'unavailable', generate: async () => {
    throw Object.assign(new Error('Check the private Gemini draft key on the host.'), { code: 'model_unavailable' });
  } };
}

export async function loadReviewedDraftProvider({ credentialFile = defaultCredential, platform = process.platform, fetchImpl = globalThis.fetch } = {}) {
  let file;
  try {
    file = await open(credentialFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) || info.size < 30 || info.size > 260) return unavailable();
    const apiKey = (await file.readFile('utf8')).trim();
    if (!/^[A-Za-z0-9_.-]{30,256}$/.test(apiKey)) return unavailable();
    return { name: 'gemini', generate: (context, options) => generateGeminiDraft(context, { ...options, apiKey, fetchImpl }) };
  } catch (error) {
    if (error.code !== 'ENOENT') return unavailable();
    if (platform === 'darwin') return { name: 'local', generate: generateOperatorDraft };
    return { name: 'helper', generate: undefined };
  } finally {
    if (file) await file.close();
  }
}
