import { validateBank, PROFILE_IDS, EVENT_CATEGORIES, digest } from './bank.mjs';

// Viewer-perspective acknowledgements only: no actor, recipient, amount,
// duration, payment, video/audio or broadcaster identity is invented.
const authored = {
  primary: {
    bits: ['nice cheer', 'cheers for the cheer'],
    sub: ['nice, welcome in', 'hey, welcome aboard'],
    resub: ['nice, welcome back', 'good to see the resub'],
    gift: ['nice gift', 'that’s generous'],
    gift_batch: ['that’s a generous batch', 'nice gifts, chat']
  },
  test: {
    bits: ['a cheer for chat, nice', 'nice bit of support'],
    sub: ['hello to the new sub', 'welcome to the sub crew'],
    resub: ['back for another round, nice', 'a returning sub, welcome back'],
    gift: ['a gift sub, nicely done', 'nice to see a gift come through'],
    gift_batch: ['a batch of gifts, nicely done', 'nice to see those gift subs']
  },
  third: {
    bits: ['nice to see that support', 'a cheer for the channel, nice'],
    sub: ['hey, welcome in', 'nice to see another sub'],
    resub: ['welcome back!', 'good to see you here again'],
    gift: ['that was kind', 'generous gift, nice'],
    gift_batch: ['nice gifts for the community', 'that was generous']
  },
  fourth: {
    bits: ['a cheer. nicely done.', 'solid cheer, that.'],
    sub: ['one more in the sub crew', 'a new sub. welcome in.'],
    resub: ['back again. good choice.', 'a return visit. welcome back.'],
    gift: ['a gift sub. very decent.', 'quietly generous, that.'],
    gift_batch: ['a whole batch. generous.', 'quite a batch of gifts.']
  }
};
for (const profile of Object.values(authored)) { for (const lines of Object.values(profile)) Object.freeze(lines); Object.freeze(profile); }
export const EVENT_WORDING = Object.freeze(authored);

/** Pure, idempotent proposal; never reads a controller or changes a bank. */
export function prepareEventBank(input) {
  validateBank(input);
  const bank = structuredClone(input), entries = structuredClone(bank.entries), changes = [];
  for (const id of PROFILE_IDS) for (const category of EVENT_CATEGORIES) {
    const entryId = `event:${id}:${category}`;
    const existing = entries.find(entry => entry.id === entryId);
    if (existing) {
      if (existing.kind !== 'event' || existing.category !== category) throw new Error('An event group identity is already used by another message kind.');
      changes.push({ id: entryId, action: 'preserved' });
      continue;
    }
    entries.push({ id: entryId, kind: 'event', category, lines: [...EVENT_WORDING[id][category]], accountIds: [id], enabled: true });
    changes.push({ id: entryId, action: 'added' });
  }
  const candidate = { entries, profiles: structuredClone(bank.profiles) };
  validateBank(candidate);
  return { bank: candidate, manifest: { sourceBankSha256: digest(JSON.stringify(bank)), candidateSha256: digest(JSON.stringify(candidate)), changes,
    added: changes.filter(x => x.action === 'added').length, preservedExistingBank: true, activation: 'A separate guarded bank save is required.' } };
}
