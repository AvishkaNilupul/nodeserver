import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateOperatorDraft } from '../lib/operator-model.mjs';
import { loadReviewedDraftProvider } from '../lib/reviewed-provider.mjs';

async function temporaryKey(t) {
  const dir = await mkdtemp(join(tmpdir(), 'reviewed-provider-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'draft.key');
}

test('an unconfigured host preserves its existing platform draft provider', async t => {
  const credentialFile = await temporaryKey(t);
  const local = await loadReviewedDraftProvider({ credentialFile, platform: 'darwin' });
  assert.equal(local.name, 'local');
  assert.equal(local.generate, generateOperatorDraft);
  assert.deepEqual(await loadReviewedDraftProvider({ credentialFile, platform: 'linux' }), { name: 'helper', generate: undefined });
});

test('a configured Gemini key is used only when an operator requests a draft', async t => {
  const credentialFile = await temporaryKey(t);
  const apiKey = 'synthetic-example-for-the-provider-test';
  await writeFile(credentialFile, apiKey + '\n', { mode: 0o600 });
  let calls = 0;
  const provider = await loadReviewedDraftProvider({ credentialFile, fetchImpl: async (url, request) => {
    calls++;
    assert.equal(new Headers(request.headers).get('x-goog-api-key'), apiKey);
    assert.ok(!url.includes(apiKey) && !request.body.includes(apiKey));
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ reply: 'hey, welcome in!' }) }] } }] });
  } });
  assert.equal(provider.name, 'gemini');
  assert.ok(!JSON.stringify(provider).includes(apiKey));
  assert.equal(calls, 0);
  const context = { account: 'operator_fixture', channel: 'channel_fixture', target: { author: 'viewer_fixture', text: 'hey chat!' }, messages: [] };
  assert.equal(await provider.generate(context), 'hey, welcome in!');
  assert.equal(calls, 1);
});

test('malformed, shared and symlinked credential files report a draft configuration error', async t => {
  const credentialFile = await temporaryKey(t);
  const fetchImpl = () => assert.fail('unexpected external request');
  async function expectUnavailable(file) {
    const provider = await loadReviewedDraftProvider({ credentialFile: file, platform: 'darwin', fetchImpl });
    assert.equal(provider.name, 'unavailable');
    await assert.rejects(provider.generate({}), { code: 'model_unavailable' });
  }
  await writeFile(credentialFile, 'invalid', { mode: 0o600 });
  await expectUnavailable(credentialFile);
  await writeFile(credentialFile, 'synthetic-example-for-the-provider-test');
  await chmod(credentialFile, 0o644);
  await expectUnavailable(credentialFile);
  await chmod(credentialFile, 0o600);
  await symlink(credentialFile, credentialFile + '.link');
  await expectUnavailable(credentialFile + '.link');
});
