const axios = require('axios');
function verificationLink(messages, since) {
  for (const message of messages || []) {
    const sender = message.from?.emailAddress?.address || '';
    if (!/^[^@]+@steampowered\.com$/i.test(sender) ||
        !/new steam account email verification/i.test(message.subject || '') ||
        !(Date.parse(message.receivedDateTime) >= Date.parse(since))) continue;
    const body = typeof message.body === 'string' ? message.body : message.body?.content || '';
    const text = (body + ' ' + (message.bodyPreview || '')).replace(/&amp;/g, '&');
    for (const raw of text.match(/https:\/\/store\.steampowered\.com\/account\/newaccountverification\?[^\s<>"']+/g) || []) {
      const url = new URL(raw);
      if (/^[a-f0-9]{20,512}$/i.test(url.searchParams.get('stoken') || '') &&
          /^\d{1,30}$/.test(url.searchParams.get('creationid') || '')) return url.href;
    }
  }
  return null;
}
function createMail(base = 'http://127.0.0.1:3999') {
  const http = axios.create({baseURL:base, timeout:20000, proxy:false});
  return {
    async status() {
      const {data} = await http.get('/api/accounts');
      let exclusiveReady = false;
      try { const result = await http.get('/api/pool/capabilities'); exclusiveReady = result.data.authority === 'cloud' && result.data.exclusivePurposes?.includes('steam') === true; } catch {}
      return {authority:exclusiveReady?'cloud':'unverified',inboxes:data.length,unused:data.filter(a=>!Object.values(a.uses||{}).some(Boolean)).length, steamUsed:data.filter(a => a.uses?.steam).length, exclusiveReady};
    },
    async reserve() {
      // Fail before allocating if the reader cannot guarantee exclusive Steam ownership.
      const {data: capabilities} = await http.get('/api/pool/capabilities');
      if (capabilities.authority !== 'cloud' || !capabilities.exclusivePurposes?.includes('steam')) throw Error('Connect the cloud Outlook pool before starting a Steam signup');
      const {data} = await http.post('/api/pool/pick', {for:'steam'});
      if (!data.ok) throw Error(data.error || 'No unused Outlook inbox');
      return data.email;
    },
    async verify(session) {
      const {data} = await http.post('/api/accounts/' + encodeURIComponent(session.email) + '/read?top=10', {});
      if (!data.ok) throw Error('Outlook could not read this inbox; resume the same signup');
      return verificationLink(data.messages, session.lastResumedAt || session.createdAt);
    },
    async complete(session) {
      const {data} = await http.post('/api/pool/release', {email:session.email,for:'steam',status:'ok',detail:'Created by local Steam signup extension',extra:{exclusive:true,username:session.username,country:session.country}});
      if (!data.ok) throw Error('Could not finalize Outlook usage');
    }
  };
}
module.exports = {createMail,verificationLink};
