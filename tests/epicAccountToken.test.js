const test = require('node:test');
const assert = require('node:assert/strict');
process.env.CRED_SECRET ||= 'test-epic-token';
process.env.MONGO_URI ||= 'mongodb://localhost/test';
process.env.ADMIN_KEY ||= 'test';
const { createTokenStore } = require('../utils/epicAccountToken');
function setup(refresh) {
  const row = {_id:'one',accountId:'account',refreshToken:'initial'};
  const collection = {
    async findOneAndUpdate(_filter,update) {
      if (row.tokenRefreshLease) return null;
      Object.assign(row,update.$set);return structuredClone(row);
    },
    async updateOne(filter,update) {
      if (filter['tokenRefreshLease.owner'] !== row.tokenRefreshLease?.owner ||
          (filter.refreshToken !== undefined && filter.refreshToken !== row.refreshToken)) return {matchedCount:0};
      Object.assign(row,update.$set);
      for (const key of Object.keys(update.$unset || {})) delete row[key];
      return {matchedCount:1};
    },
  };
  const deps = {collection,refresh,encrypt:v=>v,decrypt:v=>v};
  return {row,deps,get:createTokenStore(deps)};
}
const bundle = (n=1) => ({access_token:'access'+n,refresh_token:'rotated'+n,account_id:'account',expires_in:3600});
test('rapid claim requests reuse one access token and persist rotation immediately',async()=>{
  let calls=0;const s=setup(async()=>{calls++;await new Promise(r=>setTimeout(r,5));return bundle();});
  const stale={_id:'one',refreshToken:'initial'};
  const results=await Promise.all(Array.from({length:8},()=>s.get(stale)));
  assert.equal(calls,1);assert.ok(results.every(v=>v==='access1'));
  assert.equal(s.row.refreshToken,'rotated1');assert.equal(stale.refreshToken,'initial');assert.equal(s.row.tokenRefreshLease,undefined);
});
test('independent processes read latest persisted token under the database lease',async()=>{
  const used=[];const s=setup(async t=>{used.push(t);await new Promise(r=>setTimeout(r,5));return bundle(used.length);});
  const other=createTokenStore(s.deps);
  await Promise.all([s.get({_id:'one'}),other({_id:'one'})]);
  assert.deepEqual(used,['initial','rotated1']);assert.equal(s.row.refreshToken,'rotated2');
});
test('token survives subsequent library failure',async()=>{
  const s=setup(async()=>bundle());
  await assert.rejects(async()=>{await s.get({_id:'one'});throw Error('library unavailable');});
  assert.equal(s.row.refreshToken,'rotated1');
});
test('revoked token sets needs_login without exposing token text',async()=>{
  const s=setup(async()=>{throw Error("refresh token 'secret' invalid: TOKEN_NOT_FOUND");});
  await assert.rejects(s.get({_id:'one'}),e=>e.epicCode==='invalid_grant'&&!e.message.includes('secret'));
  assert.equal(s.row.status,'needs_login');assert.equal(s.row.tokenRefreshLease,undefined);
});
test('network failures release lease without declaring token broken',async()=>{
  const s=setup(async()=>{throw Error('network unavailable');});
  await assert.rejects(s.get({_id:'one'}),/network unavailable/);
  assert.equal(s.row.status,undefined);assert.equal(s.row.refreshToken,'initial');assert.equal(s.row.tokenRefreshLease,undefined);
});
test('concurrent fresh login cannot be overwritten by older refresh',async()=>{
  let s;s=setup(async()=>{s.row.refreshToken='fresh-login';return bundle();});
  await assert.rejects(s.get({_id:'one'}),/login changed/);assert.equal(s.row.refreshToken,'fresh-login');
});
