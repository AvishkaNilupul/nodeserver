(function (root) {
  'use strict';
  function plan(text, accounts = []) {
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    if (!lines.length || lines.length > 20) throw new Error('Paste between 1 and 20 accounts.');
    const seen = new Set(accounts.map((a) => a.setup?.handle?.replace(/^@/, '').toLowerCase()).filter(Boolean));
    const occupied = new Set(accounts.map((a) => a.account));
    const free = Array.from({ length: 97 }, (_, n) => 'tiktok-' + String(n + 3).padStart(2, '0')).filter((a) => !occupied.has(a));
    if (free.length < lines.length) throw new Error('There are not enough free account slots.');
    return lines.map((line, index) => {
      const fields = line.split(':'), username = fields[0].trim(), password = fields[1];
      if (![2, 4].includes(fields.length) || !username || username.length > 254 || !password || password.length > 512 ||
          /[\u0000-\u001f\u007f]/.test(username + password) ||
          (fields.length === 4 && (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fields[2]) || !fields[3]))) {
        throw new Error('Row ' + (index + 1) + ': use username:password, optionally followed by :email:email-password.');
      }
      const identity = username.replace(/^@/, '').toLowerCase();
      if (seen.has(identity)) throw new Error('Row ' + (index + 1) + ': this account is duplicated or already enrolled.');
      seen.add(identity);
      // Linked mailbox credentials are not sent to the farm or retained here.
      return { account: free[index], credential: { username, password }, row: index + 1 };
    });
  }
  if (typeof module === 'object' && module.exports) module.exports = { plan };
  else root.TikTokAccountInput = { plan };
})(typeof window === 'object' ? window : globalThis);
