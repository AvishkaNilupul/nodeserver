const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {configure}=require('../tools/epic-signup/yescaptcha-config.cjs');
const fixture=`const config={clientKey:'',endTimes:'20',hcaptchaConfig:{isRealClick:false},funcaptchaConfig:{isOpen:true},recaptchaConfig:{isOpen:true},awsCaptchaConfig:{isOpen:true},whiteListConfig:{isOpen:false,urlList:[]\n},isHideKey:false};globalThis.settings=config;`;
test('companion uses the existing key, bounds retries, and restricts recognition to Epic',()=>{
 const context={};vm.runInNewContext(configure(fixture,'a'.repeat(32)),context);const s=context.settings;
 assert.equal(s.clientKey,'a'.repeat(32));assert.equal(s.endTimes,'8');assert.equal(s.hcaptchaConfig.isRealClick,true);assert.equal(s.isHideKey,true);
 for(const k of ['funcaptchaConfig','recaptchaConfig','awsCaptchaConfig'])assert.equal(s[k].isOpen,false);
 const pattern=new RegExp(s.whiteListConfig.urlList[0].slice(1,-1));
 for(const url of ['https://www.epicgames.com/id/register','https://store.epicgames.com/'])assert.ok(pattern.test(url));
 for(const url of ['https://epicgames.com.evil.test/','https://example.test/?epicgames.com','http://www.epicgames.com/'])assert.equal(pattern.test(url),false);
});
test('changed vendor configuration and malformed keys fail closed',()=>{
 assert.throws(()=>configure(fixture,'bad'));
 assert.throws(()=>configure(fixture.replace("endTimes:'20'","endTimes:'21'"),'a'.repeat(32)));
});
