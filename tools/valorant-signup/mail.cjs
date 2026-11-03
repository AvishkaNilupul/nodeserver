const axios = require('axios');

function verificationCode(messages, since) {
  const cutoff = Date.parse(since);
  if (!Number.isFinite(cutoff)) return null;
  const recent = (messages || []).filter(message => {
    const sender = message.from?.emailAddress?.address || '';
    return /^[^@]+@(?:[a-z0-9-]+\.)*riotgames\.com$/i.test(sender) &&
      /verif|security|sign.?in|login|authentication/i.test(message.subject || '') &&
      Date.parse(message.receivedDateTime) >= cutoff;
  }).sort((a,b) => Date.parse(b.receivedDateTime) - Date.parse(a.receivedDateTime));
  for (const message of recent) {
    const body = typeof message.body === 'string' ? message.body : message.body?.content || '';
    const text = (body + ' ' + (message.bodyPreview || '')).replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;|&#160;/g, ' ');
    const codes = [...new Set(text.match(/\b\d{6}\b/g) || [])];
    // Do not guess among unrelated numbers in a message.
    if (codes.length === 1) return codes[0];
  }
  return null;
}

function createMail(base = 'http://127.0.0.1:3999') {
  const http = axios.create({baseURL: base, timeout: 20000, proxy: false});
  async function capabilities() {
    const {data} = await http.get('/api/pool/capabilities');
    return data.authority === 'cloud' && data.exclusivePurposes?.includes('riot');
  }
  return {
    async status() {
      const [{data}, exclusiveReady] = await Promise.all([http.get('/api/accounts'), capabilities()]);
      return {authority: 'cloud', exclusiveReady, inboxes: data.length,
        riotUsed: data.filter(a => a.uses?.riot).length,
        unused: data.filter(a => !Object.values(a.uses || {}).some(Boolean)).length};
    },
    async reserve() {
      if (!await capabilities()) throw Error('Cloud Outlook needs exclusive Riot reservations enabled');
      const {data} = await http.post('/api/pool/pick', {for: 'riot'});
      if (!data.ok || !/^[^\s@]+@[^\s@]+$/.test(data.email || '')) throw Error('No unused Outlook inbox');
      return data.email;
    },
    async verify(session) {
      const {data} = await http.post('/api/accounts/' + encodeURIComponent(session.email) + '/read?top=15', {});
      if (!data.ok) throw Error('Outlook could not read this inbox');
      return verificationCode(data.messages, session.lastResumedAt || session.createdAt);
    },
    async complete(session) {
      const {data} = await http.post('/api/pool/release', {email: session.email, for: 'riot', status: 'ok',
        detail: 'Created by local Valorant signup extension', extra: {exclusive: true, username: session.username,
          requestedCountry: session.requestedCountry}});
      if (!data.ok) throw Error('Could not finalize Outlook usage');
    },
  };
}
module.exports = {createMail, verificationCode};
