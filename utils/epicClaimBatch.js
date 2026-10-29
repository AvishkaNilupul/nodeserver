const crypto = require('crypto');

function eligible(account) {
  return account && !account.sold && account.status === 'ok';
}
const {live} = require('./epicOfferWindow');
function planClaims(accounts, offers, now = Date.now()) {
  const jobs = [], seen = new Set();
  for (const account of accounts.filter(eligible)) {
    const owned = new Set((account.library || []).map(game => game.namespace));
    for (const offer of offers.filter(offer => live(offer, now))) {
      const key = account._id + ':' + offer.namespace;
      if (!offer.namespace || owned.has(offer.namespace) || seen.has(key)) continue;
      seen.add(key);
      jobs.push({accountId: String(account._id), offerId: offer.offerId,
        account: account.displayName || account.label || String(account._id),
        game: offer.title, state: 'pending'});
    }
  }
  return jobs;
}

// One detached queue per server process. No credentials enter its public state.
// A server restart ends this queue; starting again rechecks current ownership.
function createClaimBatch({plan, execute, schedule = setImmediate}) {
  let batch = null, active = false, stopRequested = false;
  function status() {
    if (!batch) return {state: 'idle', total: 0, completed: 0, jobs: []};
    return JSON.parse(JSON.stringify({...batch, completed: batch.jobs.filter(j =>
      ['claimed', 'already_owned', 'skipped', 'error'].includes(j.state)).length}));
  }
  async function run() {
    try {
      for (const job of batch.jobs) {
        if (stopRequested) { batch.state = 'stopped'; break; }
        job.state = 'running';
        let result;
        try { result = await execute(job); }
        catch { result = {status: 'error', error: 'Claim failed; check this account before retrying'}; }
        result = result || {};
        job.state = result.status || 'error';
        job.message = String(result.error || '').slice(0, 300);
        if (result.tokenNeedsLogin) job.message = 'Account needs reconnection';
        if (['needs_captcha', 'worker_unavailable', 'busy', 'daily_cap'].includes(job.state)) {
          batch.state = 'paused'; batch.reason = job.message || job.state; break;
        }
        if (!['claimed', 'already_owned', 'skipped', 'error'].includes(job.state)) {
          job.message = job.message || job.state; job.state = 'error';
        }
      }
      if (batch.state === 'running') batch.state = stopRequested ? 'stopped' : 'complete';
    } catch {
      batch.state = 'error'; batch.reason = 'Batch interrupted; start again to recheck remaining games';
    } finally { active = false; batch.finishedAt = new Date().toISOString(); }
  }
  return {
    status,
    isActive: () => active,
    stop() { if (active) stopRequested = true; return status(); },
    async start() {
      // Set this before the first await: repeated phone taps join the same batch.
      if (active) return status();
      active = true; stopRequested = false;
      batch = {id: crypto.randomUUID(), state: 'preparing', startedAt: new Date().toISOString(), jobs: [], total: 0};
      try {
        batch.jobs = await plan(); batch.total = batch.jobs.length;
        batch.state = 'running'; schedule(() => run());
        return status();
      } catch (error) { active = false; batch.state = 'error'; batch.reason = 'Could not prepare claims'; throw error; }
    },
  };
}
module.exports = {createClaimBatch, planClaims, eligible, live};
