// One operator-requested batch allowance. Run from the production app root
// under a restarting supervisor; the lease file is private runtime state.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function makeLease(snapshot, config, batchId, now = Date.now()) {
  if (!snapshot.success || snapshot.batch?.id !== batchId || snapshot.batch.state !== 'running')
    throw Error('Requested batch is not running');
  if (!Number.isSafeInteger(config.dailyCap) || config.dailyCap <= 0)
    throw Error('A finite existing daily cap is required');
  const total = snapshot.batch.total;
  if (!Number.isSafeInteger(total) || total <= 0 || total > 500) throw Error('Invalid batch size');
  return {batchId, originalCap: config.dailyCap, allowedCap: config.dailyCap + total,
    expiresAt: now + 8 * 3600000, state: 'active'};
}
function finished(lease, snapshot, now = Date.now()) {
  return now >= lease.expiresAt || snapshot?.batch?.id !== lease.batchId ||
    !['preparing', 'running'].includes(snapshot?.batch?.state);
}
async function restoreCap(settings, lease) {
  // Preserve a later operator change instead of replacing it with our snapshot.
  if (settings.getEpicAutoClaim().dailyCap === lease.allowedCap) {
    await settings.setEpicAutoClaim({dailyCap: lease.originalCap});
    return 'restored';
  }
  return 'preserved-later-setting';
}
async function main() {
  const [leasePath, batchId] = process.argv.slice(2);
  if (!path.isAbsolute(leasePath || '') || !batchId) throw Error('Supply absolute lease path and batch id');
  const root = process.cwd();
  require(path.join(root, 'node_modules/dotenv')).config({path: path.join(root, '.env'), quiet: true});
  const settings = require(path.join(root, 'utils/settings.js'));
  const secret = process.env.EPIC_CLAIM_WORKER_TOKEN;
  if (!secret) throw Error('Worker token is not configured');
  const key = crypto.createHmac('sha256', secret).update('epic-phone-controls-v1').digest('hex');
  const snapshot = async () => {
    const r = await fetch('http://127.0.0.1:3000/api/epic/phone/claims', {
      headers: {Authorization: 'Bearer ' + key}, signal: AbortSignal.timeout(45000)});
    const d = await r.json(); if (!r.ok || !d.success) throw Error('Claim status unavailable'); return d;
  };
  const save = lease => {
    fs.writeFileSync(leasePath + '.tmp', JSON.stringify(lease) + '\n', {mode: 0o600});
    fs.renameSync(leasePath + '.tmp', leasePath);
  };
  let lease;
  if (fs.existsSync(leasePath)) {
    lease = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
    if (lease.batchId !== batchId) throw Error('Lease belongs to another batch');
    if (lease.state !== 'active') return;
  } else {
    lease = makeLease(await snapshot(), settings.getEpicAutoClaim(), batchId);
    save(lease); // Recovery state exists before changing settings.
    await settings.setEpicAutoClaim({dailyCap: lease.allowedCap});
    console.log('Temporary batch cap:', lease.originalCap, '->', lease.allowedCap);
  }
  for (;;) {
    let done = Date.now() >= lease.expiresAt;
    if (!done) {
      try { done = finished(lease, await snapshot()); }
      catch { /* Keep the bounded allowance during transient status outages. */ }
    }
    if (done) {
      lease.state = await restoreCap(settings, lease); lease.finishedAt = new Date().toISOString();
      save(lease); console.log('Batch allowance ended:', lease.state); return;
    }
    if (settings.getEpicAutoClaim().dailyCap !== lease.allowedCap) {
      lease.state = 'preserved-later-setting'; save(lease); return;
    }
    await new Promise(resolve => setTimeout(resolve, 30000));
  }
}
if (require.main === module) main().then(() => process.exit(0), () => {
  console.error('Batch cap supervisor failed; restart to recover the saved lease'); process.exit(1);
});
module.exports = {makeLease, finished, restoreCap};
