const crypto = require('crypto');

function eligible(account) {
  return account && !account.sold && account.status === 'ok';
}
const {live} = require('./epicOfferWindow');
const {regionBlock} = require('./epicRegion');
// blocked: offerId -> refused countries (utils/epicRegion). Region-locked
// pairs are left out: Epic would refuse them, and the page lists them apart.
function planClaims(accounts, offers, now = Date.now(), blocked = null) {
  const jobs = [], seen = new Set();
  for (const account of accounts.filter(eligible)) {
    const owned = new Set((account.library || []).map(game => game.namespace));
    for (const offer of offers.filter(offer => live(offer, now))) {
      const key = account._id + ':' + offer.namespace;
      if (!offer.namespace || owned.has(offer.namespace) || seen.has(key)) continue;
      if (regionBlock(account, offer, blocked)) continue;
      seen.add(key);
      jobs.push({accountId: String(account._id), offerId: offer.offerId,
        account: account.displayName || account.label || String(account._id),
        game: offer.title, state: 'pending'});
    }
  }
  return jobs;
}

const FINISHED = ['claimed', 'already_owned', 'skipped', 'region_blocked', 'error'];
const MAX_SPACING_WAITS = 20;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// One detached queue per server process. No credentials enter its public state.
// A server restart ends this queue; starting again rechecks current ownership.
// A "spacing" answer (the gap between two Epic checkouts) is waited out.
function createClaimBatch({plan, execute, schedule = setImmediate, wait = sleep}) {
  let batch = null, active = false, stopRequested = false;
  function status() {
    if (!batch) return {state: 'idle', total: 0, completed: 0, jobs: []};
    return JSON.parse(JSON.stringify({...batch, completed: batch.jobs.filter(j =>
      FINISHED.includes(j.state)).length}));
  }
  async function run() {
    try {
      for (const job of batch.jobs) {
        if (stopRequested) { batch.state = 'stopped'; break; }
        job.state = 'running';
        let result;
        for (let waits = 0; ; waits++) {
          try { result = await execute(job); }
          catch { result = {status: 'error', error: 'Claim failed; check this account before retrying'}; }
          result = result || {};
          if (result.status !== 'spacing' || stopRequested || waits >= MAX_SPACING_WAITS) break;
          job.state = 'waiting'; job.message = 'Waiting between Epic checkouts';
          const until = Date.parse(result.retryAt);
          await wait(Math.max(1000, (Number.isFinite(until) ? until : 0) - Date.now() + 1000));
          if (stopRequested) break;
          job.state = 'running'; job.message = '';
        }
        if (result.status === 'spacing') {
          job.state = 'pending'; job.message = '';
          if (stopRequested) batch.state = 'stopped';
          else { batch.state = 'paused'; batch.reason = 'Waiting between Epic checkouts took too long; start again'; }
          break;
        }
        job.state = result.status || 'error';
        job.message = String(result.error || '').slice(0, 300);
        // Epic refusing this account's region is an answer, not a failure.
        if (job.state === 'region_unavailable') job.state = 'region_blocked';
        if (result.tokenNeedsLogin) job.message = 'Account needs reconnection';
        if (['needs_captcha', 'worker_unavailable', 'busy', 'daily_cap', 'rate_limited'].includes(job.state)) {
          batch.state = 'paused'; batch.reason = job.message || job.state; break;
        }
        if (!FINISHED.includes(job.state)) {
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
