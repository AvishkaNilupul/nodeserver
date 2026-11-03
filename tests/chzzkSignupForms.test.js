const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');

// Form shapes from the 2026-11-03 manual journal: separate birthday/gender
// screens, ordinary country buttons, and an unnamed SMS input in a popup.
function form({heading='',popup=false,pathname='/account/signup/info'}={}){
  let listener;const elements=[];
  class Element {
    constructor(tagName,attrs={},text='') {Object.assign(this,{tagName,id:'',name:'',placeholder:'',type:'text',labels:[],offsetWidth:100,offsetHeight:20,innerText:text,textContent:text,_value:'',attrs,clicks:0},attrs);elements.push(this);}
    get value(){return this._value;}set value(v){this._value=v;}
    focus(){this.focused=true;}blur(){this.focused=false;this.blurred=true;}
    getAttribute(k){return this.attrs[k]??null;}getClientRects(){return[{}];}dispatchEvent(){}
    click(){this.clicks++;this.onClick?.();}
  }
  class Input extends Element {constructor(attrs){super('INPUT',attrs);}get value(){return this._value;}set value(v){this._value=v;}}
  class Select extends Element{}
  const queryAll=selector=>{
    if(selector==='input')return elements.filter(e=>e.tagName==='INPUT');
    if(selector==='select')return elements.filter(e=>e.tagName==='SELECT');
    if(selector==='iframe')return[];
    return elements.filter(e=>selector.split(',').some(s=>s==='button'&&e.tagName==='BUTTON'||s==='a'&&e.tagName==='A'||s==='[role="button"]'&&e.attrs.role==='button'||s==='[role="option"]'&&e.attrs.role==='option'||s==='input[type="checkbox"]'&&e.type==='checkbox'||s==='[role="checkbox"]'&&e.attrs.role==='checkbox'));
  };
  const document={body:{innerText:popup?'Please enter the verification code sent to':heading},addEventListener:()=>{},querySelectorAll:queryAll,querySelector:s=>s.includes('h2')?{textContent:heading}:elements.find(e=>s===`button#${e.id}`)||null};
  vm.runInNewContext(fs.readFileSync(require.resolve('../extension/chzzk-signup/content.js'),'utf8'),{
    document,location:{hostname:'nid.naver.com',pathname,href:'https://nid.naver.com'+pathname},
    HTMLInputElement:Input,HTMLSelectElement:Select,getComputedStyle:()=>({visibility:'visible'}),Event:class{},KeyboardEvent:class{},MutationObserver:class{observe(){}},setInterval:()=>{},setTimeout:fn=>{fn();},
    chrome:{runtime:{sendMessage:async()=>({ok:true}),onMessage:{addListener:f=>{listener=f;}}}},
  });
  return{Input,button:(attrs,text)=>new Element('BUTTON',attrs,text),send:m=>new Promise(resolve=>listener(m,{},resolve))};
}
const identity={username:'test_candidate',password:'test-password',name:'Test Name',birthday:'19950102'};
test('birthday-only screen becomes ready after filling and blurring',async()=>{
  const f=form({heading:'Please enter your date of birth'}),birth=new f.Input({id:'birthdate',placeholder:'0000.00.00'});
  const r=await f.send({type:'identity',identity});assert.equal(birth.value,'19950102');assert.equal(birth.blurred,true);assert.equal(r.ready,true);
});
test('gender step selects the demonstrated ordinary Other button',async()=>{
  const f=form({heading:'Please select your gender'}),other=f.button({},'Other');
  assert.equal((await f.send({type:'identity',identity})).ready,true);assert.equal(other.clicks,1);
});
test('persistent gender control on the phone screen does not reopen its dialog',async()=>{
  const f=form({heading:'Please proceed with mobile verification via SMS'});new f.Input({id:'phoneNumber',type:'tel'});const gender=f.button({id:'gender'},'Other');
  await f.send({type:'identity',identity});assert.equal(gender.clicks,0);
});
test('country selection matches country name as well as shared +1 prefix',async()=>{
  const f=form(),phone=new f.Input({id:'phoneNumber',type:'tel'}),country=f.button({id:'countryCode'},'United States +1');
  const us=f.button({},'United States +1'),canada=f.button({},'Canada +1');
  const r=await f.send({type:'number',number:{country:'canada',label:'Canada',prefix:'+1',phone:'+15551234567'}});
  assert.equal(r.ok,true);assert.equal(country.clicks,1);assert.equal(canada.clicks,1);assert.equal(us.clicks,0);assert.equal(phone.value,'5551234567');assert.equal(phone.blurred,true);
});
test('unknown country leaves the phone unchanged and reports a recoverable failure',async()=>{
  const f=form(),phone=new f.Input({id:'phoneNumber',type:'tel'});f.button({id:'countryCode'},'Country');f.button({},'United States +1');
  const r=await f.send({type:'number',number:{country:'canada',label:'Canada',prefix:'+1',phone:'+15551234567'}});
  assert.equal(r.ok,false);assert.equal(phone.value,'');
});
test('unnamed popup SMS field is filled without touching the phone',async()=>{
  const f=form({popup:true}),phone=new f.Input({id:'phoneNumber',type:'tel'}),sms=new f.Input({});
  assert.equal((await f.send({type:'sms',code:'123456'})).ok,true);assert.equal(sms.value,'123456');assert.equal(phone.value,'');
});
test('revealed password input still receives the assigned password',async()=>{
  const f=form({heading:'Please enter your password'}),pw=new f.Input({id:'password_input',name:'password',type:'text'});
  assert.equal((await f.send({type:'identity',identity})).ready,true);assert.equal(pw.value,identity.password);
});
test('Naver recommended ID step advances while preserving its provided ID',async()=>{
  const f=form({heading:'Please enter your Naver ID'}),id=new f.Input({id:'idInput',type:'text'});id.value='farm_test';
  assert.equal((await f.send({type:'identity',identity})).ready,true);assert.equal(id.value,'farm_test');
});
test('empty Naver ID field receives the reserved candidate',async()=>{
  const f=form({heading:'Please enter your Naver ID'}),id=new f.Input({id:'idInput',type:'text'});
  assert.equal((await f.send({type:'identity',identity})).ready,true);assert.equal(id.value,identity.username);
});
test('separate Naver sign-in fills the saved account and submits its visible login form',async()=>{
  const f=form({pathname:'/nidlogin.login'}),id=new f.Input({id:'id'}),pw=new f.Input({type:'password'}),submit=f.button({},'Sign in');
  assert.equal((await f.send({type:'naver-signin',identity})).ok,true);assert.equal(id.value,identity.username);assert.equal(pw.value,identity.password);assert.equal(submit.clicks,1);
});
test('receipt security challenge blocks the sign-in helper from filling or submitting',async()=>{
  const f=form({pathname:'/nidlogin.login',heading:'Please complete additional security verification'}),id=new f.Input({id:'id'}),pw=new f.Input({type:'password'}),submit=f.button({},'Sign in');
  assert.equal((await f.send({type:'naver-signin',identity})).ok,false);assert.equal(id.value,'');assert.equal(pw.value,'');assert.equal(submit.clicks,0);
});
test('terms automation selects required choices only and confirms on the next settled tick',async()=>{
  const f=form({pathname:'/account/signup/term'}),required=f.button({role:'checkbox','aria-checked':'false'},'[Required] Terms of Service'),optional=f.button({role:'checkbox','aria-checked':'false'},'[Optional] Privacy Policy'),all=f.button({role:'checkbox','aria-checked':'false'},'Agree with all terms and conditions'),confirm=f.button({},'Confirm');
  required.onClick=()=>{required.attrs['aria-checked']='true';};
  const first=await f.send({type:'accept-terms'});assert.equal(first.ok,true);assert.equal(first.submitted,false);assert.equal(required.clicks,1);assert.equal(optional.clicks,0);assert.equal(all.clicks,0);assert.equal(confirm.clicks,0);
  assert.equal((await f.send({type:'accept-terms'})).submitted,true);assert.equal(required.clicks,1);assert.equal(confirm.clicks,1);
});
test('unknown agreement layout does not select optional or blanket consent',async()=>{
  const f=form({pathname:'/account/signup/term'}),optional=f.button({role:'checkbox'},'[Optional] Privacy Policy'),all=f.button({role:'checkbox'},'Agree with all terms and conditions'),confirm=f.button({},'Confirm');
  assert.equal((await f.send({type:'accept-terms'})).ok,false);assert.equal(optional.clicks,0);assert.equal(all.clicks,0);assert.equal(confirm.clicks,0);
});
