// Shared by the local mail dashboard and its tests. Reject undated mail,
// lookalike domains, other platforms' codes, and mail predating this signup.
function findEpicOtp(messages, since) {
  const after = new Date(since).getTime();
  if (!Number.isFinite(after)) return null;
  const sorted = [...messages].sort((a, b) =>
    Date.parse(b.receivedDateTime) - Date.parse(a.receivedDateTime));
  for (const m of sorted) {
    const from = String(m.from?.emailAddress?.address || '').trim();
    const address = from.match(/<([^<>]+)>$/)?.[1] || from;
    if (!/^[^@\s]+@(?:[a-z0-9-]+\.)*epicgames\.com$/i.test(address)) continue;
    const received = Date.parse(m.receivedDateTime);
    if (!Number.isFinite(received) || received < after || received > Date.now() + 60000) continue;
    const body = typeof m.body === 'string' ? m.body : m.body?.content || '';
    const content = `${m.subject || ''}\n${body}\n${m.bodyPreview || ''}`
      .replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ');
    const code = content.match(/\b(\d{6})\b/)?.[1];
    if (code) return { code, receivedAt: new Date(received).toISOString() };
  }
  return null;
}
module.exports = { findEpicOtp };
