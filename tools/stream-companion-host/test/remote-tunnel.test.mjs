import test from 'node:test';
import assert from 'node:assert/strict';
import { tunnelArguments, tunnelPlist } from '../remote-service.mjs';

const config = { sshHost: 'controller.example', sshUser: 'operator', sshKey: '/private/key & one' };

test('remote connection pins loopback endpoints and uses host verification without shell expansion', () => {
  const args = tunnelArguments(config);
  assert.equal(args[args.indexOf('-R') + 1], '127.0.0.1:18795:127.0.0.1:8795');
  for (const option of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'ForwardAgent=no', 'ExitOnForwardFailure=yes']) assert.ok(args.includes(option));
  assert.ok(args.includes(config.sshKey));
  assert.equal(args.at(-1), 'operator@controller.example');
  const plist = tunnelPlist(config, '/private/host & test/');
  assert.match(plist, /key &amp; one/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key><integer>15<\/integer>/);
  assert.doesNotMatch(plist, /0\.0\.0\.0|\[::\]/);
});

test('invalid targets and extra forwarding settings cannot expand the remote connection', () => {
  for (const change of [{ sshHost: '-oProxyCommand=anything' }, { sshHost: 'host\nextra' }, { sshUser: 'user@other' },
    { sshKey: 'relative-key' }, { sshKey: '/key\nextra' }, { remotePort: 80 }, { bindAddress: '0.0.0.0' }]) {
    assert.throws(() => tunnelArguments({ ...config, ...change }), /Invalid private/);
  }
});
