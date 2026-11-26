import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { USA_ACCESS } from '../extension/usa-transport.js';

test('network access stays optional and mandatory host access remains exactly the own loopback helper',async()=>{
 const manifest=JSON.parse(await readFile(new URL('../extension/manifest.json',import.meta.url)));
 assert.deepEqual(manifest.host_permissions,['http://127.0.0.1:8797/*']);assert.deepEqual(manifest.optional_host_permissions,USA_ACCESS.origins);assert.equal(manifest.key,undefined);
 assert.match(manifest.content_security_policy.extension_pages,/wss:\/\/eventsub\.wss\.twitch\.tv/);assert.doesNotMatch(manifest.content_security_policy.extension_pages,/https:\/\/\*|<all_urls>/);
});
test('native access button requests all optional access inside click before awaiting any message and stays usable while paused',async t=>{
 const html=await readFile(new URL('../extension/panel.html',import.meta.url),'utf8'),dom=new JSDOM(html,{url:'chrome-extension://fixture/panel.html'});
 const saved={document:globalThis.document,chrome:globalThis.chrome,setInterval:globalThis.setInterval};const calls=[];
 const state={settings:{account:'companion_fourth',allowedChannel:'test_channel',pairingToken:'existing-own-pairing',paused:true,autoReply:false,autoResume:false,replySource:'local',chatMode:'mentions'},chat:{connected:false,messages:[],digest:{messages:0,people:0,topics:[]}},sent:[],usa:{ready:false,country:null,heldReason:'Enable USA & Twitch access first.',lastCheckAt:0}};
 globalThis.document=dom.window.document;globalThis.setInterval=()=>0;let inClick=false;
 globalThis.chrome={permissions:{request(access){assert.equal(inClick,true);assert.deepEqual(access,USA_ACCESS);calls.push('permission');state.usa={ready:true,country:'US',heldReason:'',lastCheckAt:1800000000000};return Promise.resolve(true);}},runtime:{async sendMessage(message){calls.push(message.type);if(message.type==='getState')return structuredClone(state);if(message.type==='usaStatus')return state.usa;throw Error('Unexpected action');}}};
 t.after(()=>{globalThis.document=saved.document;globalThis.chrome=saved.chrome;globalThis.setInterval=saved.setInterval;dom.window.close();});
 await import(`../extension/panel.js?usa-ui=${Date.now()}`);await new Promise(resolve=>setImmediate(resolve));const button=dom.window.document.getElementById('enableUsa');assert.equal(button.disabled,false);
 inClick=true;button.click();inClick=false;for(let i=0;i<15;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.ok(calls.indexOf('permission')<calls.indexOf('usaStatus'));assert.match(dom.window.document.getElementById('usaState').textContent,/USA connection ready.*US.*Checked/);assert.equal(dom.window.document.getElementById('authorize').disabled,false,'OAuth remains available while chat stays paused');
 assert.equal(state.settings.paused,true);assert.equal(calls.some(c=>['connect','send','saveSettings'].includes(c)),false);assert.doesNotMatch(dom.window.document.getElementById('usaState').textContent,/pairing|203\.0\.113|access_token|device_code/);
});
