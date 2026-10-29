const test = require('node:test'), assert = require('node:assert/strict');
const {createClaimBatch, planClaims, eligible, live} = require('../utils/epicClaimBatch');
const offer = {offerId:'one',namespace:'game',title:'Game',active:true,upcoming:false};
const account = {_id:'a',displayName:'Account',status:'ok',library:[]};
const jobs = () => [{accountId:'a',offerId:'one',state:'pending'}, {accountId:'b',offerId:'one',state:'pending'}];

test('plans only unsold connected accounts and current missing games, once per namespace', () => {
  const result = planClaims([account, {...account,_id:'sold',sold:true}, {...account,_id:'login',status:'needs_login'},
    {...account,_id:'owned',library:[{namespace:'game'}]}], [offer, {...offer,offerId:'duplicate'},
    {...offer,namespace:'expired',endDate:new Date(1)}, {...offer,namespace:'future',startDate:new Date(9999999)}], 1000);
  assert.deepEqual(result.map(j=>[j.accountId,j.offerId]), [['a','one']]);
  assert.equal(eligible({...account,sold:true}),false);
  assert.equal(live({...offer,endDate:new Date(1000)},1000),false);
});
test('repeated starts join one detached serial queue and public state is isolated', async () => {
  let finishPlan, run, plans=0, executing=0, max=0;
  const batch=createClaimBatch({plan:()=>{plans++;return new Promise(r=>finishPlan=r);},schedule:f=>run=f,
    execute:async()=>{max=Math.max(max,++executing);await Promise.resolve();executing--;return {status:'claimed'};}});
  const first=batch.start(); const second=await batch.start();
  assert.equal(second.state,'preparing');assert.equal(plans,1);
  finishPlan(jobs());await first; assert.equal(batch.status().state,'running');
  const snapshot=batch.status();snapshot.jobs[0].state='tampered';
  await run();assert.equal(max,1);assert.equal(batch.status().completed,2);assert.equal(batch.status().state,'complete');
});
test('captcha and unavailable Mac pause before the next account', async () => {
  for(const status of ['needs_captcha','worker_unavailable','busy','daily_cap','rate_limited']) {
    let run,calls=0;const batch=createClaimBatch({plan:async()=>jobs(),schedule:f=>run=f,
      execute:async()=>{calls++;return {status,error:'Needs attention'};}});
    await batch.start();await run();assert.equal(calls,1);assert.equal(batch.status().state,'paused');
    assert.equal(batch.status().jobs[1].state,'pending');
  }
});
test('stop finishes the active claim, then leaves later claims pending', async () => {
  let run,finish,calls=0;const batch=createClaimBatch({plan:async()=>jobs(),schedule:f=>run=f,
    execute:()=>{calls++;return new Promise(r=>finish=r);}});
  await batch.start();const running=run();batch.stop();finish({status:'claimed'});await running;
  assert.equal(calls,1);assert.equal(batch.status().state,'stopped');assert.equal(batch.status().jobs[1].state,'pending');
});
test('failed accounts do not prevent other accounts and retry rebuilds ownership plan', async () => {
  let run,calls=0;const batch=createClaimBatch({plan:async()=>calls?[]:jobs(),schedule:f=>run=f,
    execute:async()=>{if(++calls===1)throw Error('Secret token must not leak');return {status:'already_owned'};}});
  await batch.start();await run();assert.equal(batch.status().completed,2);
  assert.doesNotMatch(JSON.stringify(batch.status()),/Secret token/);
  await batch.start();await run();assert.equal(batch.status().total,0);assert.equal(batch.status().state,'complete');
});
