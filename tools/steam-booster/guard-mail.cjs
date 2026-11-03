// Reads Steam Guard email codes from the Outlook reader (scripts/mail-dashboard.js on :3999).
// Each Steam account has its own @outlook.com inbox, so the newest Steam mail after the
// login attempt carries our code.
const axios = require('axios');

// Steam's email codes are 5 characters from this alphabet (no vowels, no 0/1/S).
// Ordinary words in the mail never match it in full upper case.
const CODE = /^[23456789BCDFGHJKMNPQRTVWXY]{5}$/;
// Mail that is never a login code (the signup verification mail has no code).
const NOT_A_CODE_MAIL = /new steam account email verification/i;

function htmlText(html) {
  return String(html || '')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ');
}

// messages: the reader's /read shape (Graph-like). since: ISO time of the login attempt.
// exclude: message ids whose code was already used.
function steamGuardCode(messages, since, exclude = []) {
  const after = Date.parse(since) - 60 * 1000; // allow a minute of clock skew
  const sorted = [...(messages || [])].sort((a, b) => Date.parse(b.receivedDateTime) - Date.parse(a.receivedDateTime));
  for (const m of sorted) {
    const sender = m.from?.emailAddress?.address || '';
    if (!/@steampowered\.com$/i.test(sender)) continue;
    if (NOT_A_CODE_MAIL.test(m.subject || '')) continue;
    if (!(Date.parse(m.receivedDateTime) >= after)) continue;
    if (exclude.includes(m.id)) continue;
    const body = typeof m.body === 'string' ? m.body : m.body?.content || '';
    const text = htmlText(body) + ' ' + (m.bodyPreview || '');
    const code = text.split(/[^A-Za-z0-9]+/).find(t => CODE.test(t));
    if (code) return { code, messageId: m.id, subject: m.subject || '', receivedAt: m.receivedDateTime };
  }
  return null;
}

function createGuardMail(base = 'http://127.0.0.1:3999', { sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const http = axios.create({ baseURL: base, timeout: 30000, proxy: false });
  return {
    async waitForCode(email, since, { timeoutMs = 4 * 60 * 1000, pollMs = 10 * 1000, exclude = [] } = {}) {
      const deadline = Date.now() + timeoutMs;
      let lastError = null;
      while (Date.now() < deadline) {
        await sleep(pollMs);
        try {
          const { data } = await http.post('/api/accounts/' + encodeURIComponent(email) + '/read?top=10', {});
          if (!data.ok) { lastError = data.error || 'read failed'; continue; }
          const hit = steamGuardCode(data.messages, since, exclude);
          if (hit) return hit;
        } catch (e) {
          lastError = e.message;
        }
      }
      throw Error('No Steam Guard mail arrived' + (lastError ? ' (' + lastError + ')' : ''));
    },
  };
}

module.exports = { createGuardMail, steamGuardCode, htmlText, CODE };
