export const INSTANCE = Object.freeze({
  clientId: 'fourth', helperPort: 8797, serviceLabel: 'local.stream-companion.fourth-helper',
  extensionName: 'Stream Companion Fourth', hostURL: 'http://127.0.0.1:8795'
});

export function validateHostPairing(value) {
  if (!value || value.clientId !== INSTANCE.clientId || value.url !== INSTANCE.hostURL
    || !/^[a-z0-9_]{3,25}$/.test(value.account || '') || typeof value.token !== 'string'
    || !/^\S{32,1024}$/.test(value.token)) throw Error('The fourth companion requires its own account-bound central host pairing.');
  return value;
}
