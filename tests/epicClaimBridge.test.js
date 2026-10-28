const test=require('node:test'),assert=require('node:assert/strict');
const {createBridge}=require('../tools/epic-claim-worker/extension-worker.cjs');
function fakeExpress(){const routes={};const app={routes,disable(){},use(){},get(p,...handlers){routes['GET '+p]=handlers;},post(p,...handlers){routes['POST '+p]=handlers;}};return app;}
fakeExpress.json=()=>()=>{};
function res(){return{code:200,status(v){this.code=v;return this;},json(v){this.body=v;return this;},sendStatus(v){this.code=v;return this;}};}
function call(app,key,token,body){const r=res(),req={get:k=>k==='authorization'?'Bearer '+token:'127.0.0.1:8123',body};const handlers=app.routes[key];let index=0;const next=()=>handlers[index++]?.(req,r,next);next();return r;}
const token='server-secret',job={exchangeCode:'a'.repeat(32),namespace:'b'.repeat(32),offerId:'c'.repeat(32),accountKey:'d'.repeat(32),displayName:'test'};
test('unpaired browser cannot accept work; extension cannot use server auth',()=>{
 const {app,extensionToken}=createBridge({express:fakeExpress,token});
 assert.equal(call(app,'POST /claim',token,job).code,503);
 assert.equal(call(app,'POST /claim',extensionToken,job).code,401);
});
test('job is assigned once, matched by lease, and completed without exposing server token',()=>{
 const {app,extensionToken}=createBridge({express:fakeExpress,token});
 call(app,'GET /extension/status',extensionToken);
 const submitted=call(app,'POST /claim',token,job);
 const assigned=call(app,'GET /extension/next',extensionToken).body.job;
 assert.equal(assigned.displayName,'test');assert.equal(assigned.token,undefined);
 assert.equal(call(app,'GET /extension/next',extensionToken).body.job,null);
 assert.equal(call(app,'POST /extension/result',extensionToken,{...assigned,lease:'wrong',status:'submitted'}).code,409);
 assert.equal(call(app,'POST /extension/result',extensionToken,{...assigned,status:'submitted'}).code,200);
 assert.equal(submitted.body.status,'submitted');
});
