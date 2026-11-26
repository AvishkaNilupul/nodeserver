// Non-security fingerprint for public outgoing text. Case, punctuation and
// spacing differences must not turn an echo into a new contribution.
export function messageKey(text) {
  if (typeof text !== 'string') return '';
  const value = text.replace(/^\[bot\]\s*/i, '').normalize('NFKC').toLowerCase()
    .replace(/['’‘]/g, '').replace(/[\p{P}\p{Z}\p{C}]+/gu, ' ').trim();
  if (!value) return '';
  let hash = 0xcbf29ce484222325n;
  for (const character of value) hash = BigInt.asUintN(64, (hash ^ BigInt(character.codePointAt(0))) * 0x100000001b3n);
  return hash.toString(16).padStart(16, '0');
}

export function phraseSample(seed) {
  // Stable selection across polling/reloads, with different starting points
  // for accounts and broadcasts. This is variation, not a timing mechanism.
  return Number(BigInt(`0x${messageKey(seed) || '0'}`) % 1_000_003n) / 1_000_003;
}

export function distinctPhrase(choices, { seed, excludedKeys = [] } = {}) {
  const excluded = new Set(excludedKeys);
  const start = Math.floor(phraseSample(seed || '') * choices.length);
  for (let i = 0; i < choices.length; i++) {
    const text = choices[(start + i) % choices.length];
    if (!excluded.has(messageKey(text))) return text;
  }
  return '';
}
