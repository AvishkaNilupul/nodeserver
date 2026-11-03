const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('events');
const {walletCountry,createCountryChecker}=require('../tools/steam-signup/store-country.cjs');
test('only the explicit wallet country counts; IP country and currency are never substitutes',()=>{
 assert.equal(walletCountry({wallet_country_code:'jp',user_country_code:'US',currency_code:1},{proto:{eresult:1}}),'JP');
 assert.throws(()=>walletCountry({user_country_code:'US',currency_code:1},{proto:{eresult:1}}),/not returned/);
 assert.throws(()=>walletCountry({wallet_country_code:'US'},{proto:{eresult:2}}),/could not read/);
});
const account={username:'fixture',password:'secret',email:'fixture@example.test',country:'JP'};
const prepare=async country=>{assert.equal(country,'JP');return {host:'proxy.example.test',port:8080,username:'proxy-user',password:'proxy-secret'};};
class Client extends EventEmitter{logOff(){this.stopped=true;}logOn(data){this.login=data;queueMicrotask(()=>this.emit('loggedOn'));}_send(header,args,callback){const schema=require('../tools/steam-signup/node_modules/steam-user/protobufs/generated/_load.js');assert.equal(header.proto.target_job_name,'UserAccount.GetClientWalletDetails#1');assert.equal(schema.CUserAccount_GetClientWalletDetails_Request.decode(args).wallet_region,1);callback(schema.CUserAccount_GetWalletDetails_Response.encode({wallet_country_code:'BR',user_country_code:'JP'}).finish(),{proto:{eresult:1}});}}
test('checker signs in through the regional proxy, reads country, and logs off without persisting credentials',async()=>{
 let options,client;const check=createCountryChecker({prepare,createClient:o=>{options=o;return client=new Client();}});
 const result=await check(account);assert.equal(result.country,'BR');assert.equal(result.source,'steam-wallet-country');assert.equal(client.stopped,true);assert.equal(options.dataDirectory,null);assert.equal(options.autoRelogin,false);assert.match(options.httpProxy,/proxy-user:proxy-secret@proxy.example.test:8080/);assert.deepEqual(client.login,{accountName:'fixture',password:'secret'});
});
test('checker reads Guard mail only for the assigned inbox and stops on failure or timeout',async()=>{
 class GuardClient extends Client{logOn(){queueMicrotask(()=>this.emit('steamGuard','example.test',code=>{assert.equal(code,'ABCDE');this.emit('loggedOn');},false));}}
 let client;const result=await createCountryChecker({prepare,guardMail:{waitForCode:async email=>{assert.equal(email,account.email);return {code:'ABCDE'};}},createClient:()=>client=new GuardClient()})(account);assert.equal(result.country,'BR');assert.equal(client.stopped,true);
 class SilentClient extends Client{logOn(){}}
 await assert.rejects(createCountryChecker({prepare,createClient:()=>client=new SilentClient(),timeoutMs:5})(account),/timed out/);assert.equal(client.stopped,true);
 class BadClient extends Client{logOn(){queueMicrotask(()=>this.emit('error',Error('proxy-secret')));}}
 await assert.rejects(createCountryChecker({prepare,createClient:()=>client=new BadClient()})(account),e=>!e.message.includes('proxy-secret')&&/sign-in failed/.test(e.message));assert.equal(client.stopped,true);
});
