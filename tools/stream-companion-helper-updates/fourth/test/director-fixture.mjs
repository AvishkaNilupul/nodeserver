import { createHash, randomUUID } from 'node:crypto';
import { messageKey } from '../extension/message-policy.js';

/** Legacy transport tests receive an explicit test-issued central offer so
 * they continue exercising their original provider/Stop/restriction paths.
 * Missing/altered authority is tested without this fixture in director-client.
 */
export function installDirectorFixture(twitch) {
  const send = twitch.send.bind(twitch);
  twitch.send = async input => {
    const binding = { generation: 'fixture-generation', sessionId: 'fixture-browser', settingsRevision: 1 };
    const planId = randomUUID(), authorityEpoch = 'fixture-authority';
    const plan = { planId, authorityEpoch, account: input.account, channel: input.channel, text: input.text,
      textKey: messageKey(input.text), exactKey: createHash('sha256').update(String(input.text)).digest('hex'),
      category: input.category || '', kind: input.kind || '', streamId: input.streamId || '',
      participationKey: input.participationKey || '', replyId: input.replyTo || '', replyAuthor: input.replyAuthor || '',
      notBefore: twitch.now(), expiresAt: twitch.now() + 45_000, binding };
    twitch.coordinator ||= { snapshot: () => ({ available: true, paused: false, accounts: [] }),
      reserve: async () => ({ ok: true, reservationId: randomUUID() }), begin: async () => ({ ok: true }), finish: async () => {} };
    twitch.coordinator.fixturePlan = plan;
    twitch.coordinator.currentPlan = (id, current) => {
      const value = twitch.coordinator.fixturePlan;
      return value?.planId === id && value.expiresAt > twitch.now() && current?.generation === binding.generation ? value : null;
    };
    return send({ ...input, planId, authorityEpoch, binding });
  };
  return twitch;
}
