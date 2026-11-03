const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function browser({elapsed=10000,code=null}={}){
  const trace=[],clock=100000,store={active:{id:'signup-1',token:'token',tabId:7,windowId:3,number:{country:'canada'},sentAt:clock-elapsed,requestedAt:clock-elapsed-1000}};
  const page={smsPopup:true,phoneReady:true,terms:false,challenge:false,authenticated:false};
  const chrome={storage:{session:{get:async()=>structuredClone(store),set:async o=>Object.assign(store,structuredClone(o)),remove:async()=>{}},local:{set:async()=>{}}},
    tabs:{update:async(_id,opts)=>{trace.push('navigate:'+opts.url);},sendMessage:async(_id,m)=>{trace.push('browser:'+m.type);if(m.type==='inspect')return{...page};if(m.type==='identity')return{ready:false};if(m.type==='back')page.smsPopup=false;return{ok:true};}},
    runtime:{onMessage:{addListener:()=>{}}},action:{onClicked:{addListener:()=>{}}}};
  const context=vm.createContext({chrome,URL,AbortSignal,Date:class extends Date{static now(){return clock;}},fetch:async(url,opts)=>{
    const action=url.split('/').at(-1);trace.push('api:'+action);
    const data=action==='identity'?{identity:{username:'assigned'}}:action==='sms'?{result:{code,status:'RECEIVED'}}:action==='number'?{result:{phone:'+351555123456',prefix:'+351',country:'portugal'}}:{};
    return{ok:true,json:async()=>({ok:true,...data})};
  }});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension/chzzk-signup/background.js'),'utf8'),context);
  return{trace,store,page,tick:()=>vm.runInContext('handle({type:"tick"},{tab:{id:7,windowId:3,incognito:true}})',context),wrongSender:()=>vm.runInContext('handle({type:"tick"},{tab:{id:8,windowId:3,incognito:true}})',context)};
}
test('ten-second SMS expiry closes popup before cancellation, then reuses signup for a new number',async()=>{
  const b=browser();await b.tick();
  assert.ok(b.trace.indexOf('browser:back')<b.trace.indexOf('api:replace'));
  assert.equal(b.store.active.id,'signup-1');assert.equal(b.store.active.number,null);assert.equal(b.page.smsPopup,false);
  await b.tick();assert.ok(b.trace.includes('api:number'));assert.equal(b.store.active.number.country,'portugal');assert.equal(b.store.active.id,'signup-1');
});
test('before ten seconds the order is polled without replacing it',async()=>{
  const b=browser({elapsed:9000});await b.tick();assert.ok(b.trace.includes('api:sms'));assert.ok(!b.trace.includes('api:replace'));
});
test('a received code wins over the ten-second timeout',async()=>{
  const b=browser({elapsed:11000,code:'1234'});await b.tick();assert.ok(b.trace.includes('browser:sms'));assert.ok(!b.trace.includes('api:replace'));assert.equal(b.store.active.smsCode,'1234');
});
test('unassigned tabs cannot poll, buy, or replace numbers',async()=>{
  const b=browser();const r=await b.wrongSender();assert.equal(r.ok,false);assert.deepEqual(b.trace,[]);
});
test('manual demonstration mode never fills, submits, polls SMS, or buys',async()=>{
  const b=browser();b.store.active.manual=true;await b.tick();assert.deepEqual(b.trace,[]);
});
test('signup completion binds the Naver-issued ID before opening its authenticated home',async()=>{
  const b=browser();b.page.createdUsername='alex_morgan_248';await b.tick();assert.ok(b.trace.includes('api:account-name'));assert.ok(b.trace.includes('navigate:https://www.naver.com/'));assert.ok(!b.trace.includes('api:replace'));
});
test('optional passkey prompt returns to its supplied signup completion destination',async()=>{
  const b=browser();b.page.signupReturn='https://nid.naver.com/account/signup/complete?session=test';await b.tick();assert.ok(b.trace.includes('navigate:'+b.page.signupReturn));assert.ok(!b.trace.includes('api:sms'));
});
test('number fill focuses and blurs the actual input so Naver validates it',async()=>{
  class Input {
    constructor(){Object.assign(this,{tagName:'INPUT',id:'phoneNumber',name:'phoneNumber',type:'tel',labels:[],offsetWidth:100,offsetHeight:20,_value:'',focused:false,validated:false});}
    get value(){return this._value;}set value(v){this._value=v;}
    focus(){this.focused=true;}blur(){if(this.focused)this.validated=true;this.focused=false;}
    getAttribute(){return null;}getClientRects(){return[{}];}dispatchEvent(){}
  }
  class Select extends Input{get value(){return this._value;}set value(v){this._value=v;}}
  const phone=new Input(),country=new Select();Object.assign(country,{tagName:'SELECT',options:[{value:'48',text:'+48'}]});let listener;
  const context=vm.createContext({document:{body:{},addEventListener:()=>{},querySelector:()=>null,querySelectorAll:selector=>selector==='input'?[phone]:selector==='select'?[country]:[]},
    location:{hostname:'nid.naver.com',pathname:'/account/signup/info'},HTMLInputElement:Input,HTMLSelectElement:Select,getComputedStyle:()=>({visibility:'visible'}),Event:class{},KeyboardEvent:class{},MutationObserver:class{observe(){}},setInterval:()=>{},setTimeout,
    chrome:{runtime:{sendMessage:async()=>({ok:true}),onMessage:{addListener:f=>{listener=f;}}}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension/chzzk-signup/content.js'),'utf8'),context);
  const result=await new Promise(resolve=>listener({type:'number',number:{phone:'+48794365102',prefix:'+48'}},{},resolve));
  assert.equal(result.ok,true);assert.equal(phone.value,'794365102');assert.equal(phone.validated,true);
});
test('demonstration journal excludes credentials, SMS values and URL session tokens',()=>{
  const {eventRecord}=require('../tools/chzzk-signup/logger.cjs');
  const e=eventRecord('signup',{kind:'input',page:'https://nid.naver.com/account/signup/pw?session=private',target:'input#password',value:'private-password'});
  assert.equal(e.value,'[redacted]');assert.ok(!JSON.stringify(e).includes('private'));
  const c=eventRecord('signup',{kind:'cookies-meta',cookies:[{name:'NID_SES',domain:'.naver.com',value:'private-cookie'}]});assert.ok(!JSON.stringify(c).includes('private-cookie'));
});
