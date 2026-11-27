import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountManager } from '../lib/accounts.mjs';

const now = 1_800_000_000_000;
const pairingToken = 'synthetic-pairing-token-for-command-tests';
function fixture(clientId, extra = {}) {
  const requestId = `verify-${clientId}-0123456789abcdef`;
  const command = { id: 'stable-command-identifier', requestId, action: 'stop', params: {}, state: 'completed', createdAt: now, expiresAt: now + 90_000 };
  const config = { extensionId: 'a'.repeat(32), pairingToken, relay: { clientId }, ...extra };
  const manager = createAccountManager({ sources: [{ id: 'fourth', configPath: 'synthetic.json' }], now: () => now,
    readFileImpl: async () => JSON.stringify(config), fetchImpl: async url => {
      assert.equal(new URL(url).origin, 'http://127.0.0.1:8797');
      return Response.json({ ok: true, authorized: false, connected: false,
        error: `A diagnostic ${pairingToken}`, controls: { pending: null, recent: [command] } });
    } });
  return { manager, requestId };
}

test('fixed public relay client selectors do not corrupt command confirmation identities', async () => {
  for (const clientId of ['primary', 'test', 'third', 'fourth']) {
    const { manager, requestId } = fixture(clientId);
    const snapshot = await manager.snapshot(), account = snapshot.instances[0];
    assert.equal(account.available, true);
    assert.equal(account.controls.recent[0].id, 'stable-command-identifier');
    assert.equal(account.controls.recent[0].requestId, requestId);
    assert.equal(account.controls.recent[0].state, 'completed');
    assert.equal(JSON.stringify(snapshot).includes(pairingToken), false);
    assert.match(account.error, /redacted/);
  }
});

test('opaque client identifiers and genuine secret fields remain redacted', async () => {
  for (const clientId of ['opaque-provider-client-identifier', 'unregistered-selector']) {
    const { manager } = fixture(clientId);
    const snapshot = await manager.snapshot();
    assert.equal(JSON.stringify(snapshot).includes(clientId), false);
    assert.match(snapshot.instances[0].controls.recent[0].requestId, /redacted/);
  }
  // A selector-looking value in a real secret field is still a secret.
  const { manager } = fixture('fourth', { apiKey: 'fourth' });
  const snapshot = await manager.snapshot();
  assert.match(snapshot.instances[0].controls.recent[0].requestId, /redacted/);
  assert.equal(JSON.stringify(snapshot).includes(pairingToken), false);
});
