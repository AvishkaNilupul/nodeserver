// Outlook credentials and inbox reads stay on the owner's Mac. The extension
// supplies only a reserved address and timestamp to the authenticated panel.
function allocate(mailbox) {
  const address = String(mailbox?.address || '').trim().toLowerCase();
  const reservedAt = new Date(mailbox?.reservedAt);
  if (mailbox?.provider !== 'outlook-local' ||
      !/^[a-z0-9._-]+@(outlook|hotmail|live)\.(com|jp|co\.jp|co\.uk|fr|de|it|es|com\.au)$/i.test(address) ||
      !Number.isFinite(reservedAt.getTime()) ||
      Math.abs(Date.now() - reservedAt.getTime()) > 10 * 60 * 1000) {
    throw new Error('Reserve an Outlook inbox through the Chrome extension first');
  }
  return { address, provider: 'outlook-local', providerMeta: { reservedAt: reservedAt.toISOString() } };
}
async function release() { /* Persistent Outlook inboxes must never be deleted. */ }
module.exports = { allocate, release };
