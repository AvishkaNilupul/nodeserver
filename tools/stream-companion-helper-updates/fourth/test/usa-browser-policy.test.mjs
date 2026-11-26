import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFetch, validateSocket, MAX_HTTP_BODY, MAX_REQUEST } from '../extension/usa-policy.js';
const app = 'appclientid123456', headers = [['Authorization', 'Bearer test-token'], ['Client-Id', app]], scopes = 'user:read:chat user:write:chat clips:edit';
const form = body => ({ method: 'POST', headers: [['Content-Type', 'application/x-www-form-urlencoded']], body: new URLSearchParams(body).toString() });

test('finite policy accepts the complete existing Twitch request inventory and canonicalizes headers', () => {
  for (const [path, query] of [['users','login=companion_test'],['streams','user_id=123'],['chat/settings','broadcaster_id=123'],['shared_chat/session','broadcaster_id=123'],['clips','id=Clip-id_123']]) {
    assert.deepEqual(validateFetch(`https://api.twitch.tv/helix/${path}?${query}`, { headers }).headers, [['authorization','Bearer test-token'],['client-id',app]]);
  }
  for (const [path, body] of [['chat/messages', { broadcaster_id:'123',sender_id:'456',message:'hello there',reply_parent_message_id:'message-id' }], ['eventsub/subscriptions',{ type:'channel.chat.message',version:'1',condition:{broadcaster_user_id:'123',user_id:'456'},transport:{method:'websocket',session_id:'session-id'} }]]) {
    const value=validateFetch(`https://api.twitch.tv/helix/${path}`,{method:'POST',headers:[...headers,['Content-Type','application/json']],body:JSON.stringify(body)}); assert.equal(value.method,'POST');
  }
  validateFetch('https://api.twitch.tv/helix/clips?broadcaster_id=123&duration=30',{method:'POST',headers});
  validateFetch('https://id.twitch.tv/oauth2/validate',{headers:[['Authorization','OAuth test-token']]});
  validateFetch('https://id.twitch.tv/oauth2/device',form({client_id:app,scopes}));
  validateFetch('https://id.twitch.tv/oauth2/token',form({client_id:app,scopes,device_code:'device-test',grant_type:'urn:ietf:params:oauth:grant-type:device_code'}));
  validateFetch('https://id.twitch.tv/oauth2/token',form({client_id:app,refresh_token:'refresh-test',grant_type:'refresh_token'}));
});

test('finite policy denies arbitrary URL/query/method/header/body authority before dispatch', () => {
  const base='https://api.twitch.tv/helix/users?login=companion_test';
  for (const url of [base.replace('https:','http:'),base.replace('api.twitch.tv','api.twitch.tv.evil.example'),base.replace('api.twitch.tv','other.example'),base+'#secret',base+'&login=other',base+'&arbitrary=1',base.replace('/users','/users/../users'),base.replace('api.twitch.tv','user:pass@api.twitch.tv'),base.replace('api.twitch.tv','api.twitch.tv:444'),base.replace('login=companion_test','login=x'),base.replace('/users','/channels')]) assert.throws(()=>validateFetch(url,{headers}));
  for (const options of [{method:'DELETE',headers},{headers:[...headers,['Cookie','secret']]},{headers:[...headers,['authorization','Bearer duplicate']]},{headers:[...headers,['Accept','text/plain']]},{headers:[['Authorization','Bearer bad\r\nInjected: value'],['Client-Id',app]]},{headers,body:'bad'},{method:'POST',headers,body:'{}'}]) assert.throws(()=>validateFetch(base,options));
  assert.throws(()=>validateFetch('https://api.twitch.tv/helix/chat/messages',{method:'POST',headers:[...headers,['Content-Type','application/json']],body:JSON.stringify({broadcaster_id:'123',sender_id:'456',message:'/ban other'})}));
  assert.throws(()=>validateFetch('https://api.twitch.tv/helix/chat/messages',{method:'POST',headers:[...headers,['Content-Type','application/json']],body:'x'.repeat(MAX_REQUEST+1)}));
  assert.equal(MAX_HTTP_BODY,262144);
});

test('OAuth form keys, scopes and grants are finite, duplicate-safe and contain no secret extras', () => {
  const device='https://id.twitch.tv/oauth2/device', token='https://id.twitch.tv/oauth2/token';
  for (const value of [{client_id:app,scopes,client_secret:'no'}, {client_id:app,scopes:'user:read:chat user:write:chat moderator:manage:banned_users'},{client_id:app,scopes:'user:read:chat user:read:chat'},{client_id:'bad',scopes}]) assert.throws(()=>validateFetch(device,form(value)));
  const valid=form({client_id:app,scopes});assert.throws(()=>validateFetch(device,{...valid,body:valid.body+'&client_id='+app}));
  assert.throws(()=>validateFetch(token,form({client_id:app,grant_type:'password',username:'test',password:'bad'})));
  assert.throws(()=>validateFetch(token,form({client_id:app,refresh_token:'has newline\n',grant_type:'refresh_token'})));
});

test('EventSub socket policy accepts only the fixed host/path and bounded reconnect query', () => {
  for (const url of ['wss://eventsub.wss.twitch.tv/ws','wss://eventsub.wss.twitch.tv/ws?session_id=opaque-session&x=abc%2Bdef']) assert.equal(validateSocket(url),url);
  for (const url of ['ws://eventsub.wss.twitch.tv/ws','wss://other.example/ws','wss://eventsub.wss.twitch.tv/ws#fragment','wss://eventsub.wss.twitch.tv/ws/','wss://user@eventsub.wss.twitch.tv/ws','wss://eventsub.wss.twitch.tv:444/ws','wss://eventsub.wss.twitch.tv/ws?'+ 'x'.repeat(2050)]) assert.throws(()=>validateSocket(url));
});
