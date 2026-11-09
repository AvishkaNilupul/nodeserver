const test = require('node:test');
const assert = require('node:assert/strict');
const { plan } = require('../public/tiktok/account-input');

test('batch planning reserves free slots and excludes linked mailbox credentials', () => {
  const result = plan('alpha:tik-pass:mail@example.test:mail-secret\r\nbeta:other-pass', [{account:'tiktok-03'},{account:'tiktok-05'}]);
  assert.deepEqual(result.map((r) => r.account), ['tiktok-04','tiktok-06']);
  assert.deepEqual(result[0].credential, {username:'alpha',password:'tik-pass'});
  assert(!JSON.stringify(result).includes('mail-secret'));
  assert(!JSON.stringify(result).includes('mail@example.test'));
});
test('the complete batch is validated before anything can be queued', () => {
  assert.throws(() => plan('alpha:pass\nbad-row'), /Row 2/);
  assert.throws(() => plan('alpha:pass\n@ALPHA:other'), /duplicated/);
  assert.throws(() => plan('Alpha:pass', [{account:'tiktok-03',setup:{handle:'@alpha'}}]), /already enrolled/);
  assert.throws(() => plan(''), /1 and 20/);
  assert.throws(() => plan(Array.from({length:21},(_,i)=>'user'+i+':pass').join('\n')), /1 and 20/);
  assert.throws(() => plan('alpha:pass',Array.from({length:97},(_,i)=>({account:'tiktok-'+String(i+3).padStart(2,'0')}))), /free account slots/);
});
