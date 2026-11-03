// Distinguish a worker heartbeat from verified per-account Steam work.
const FRESH_MS = 3 * 60 * 1000;
function assess(b, now = Date.now()) {
  const games = b.games || [], licensed = new Set(b.licensed || []);
  const seen = b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0;
  const fresh = !!seen && now - seen < FRESH_MS;
  const values = games.map(g => Number(b.minutes?.[g]));
  const known = values.length > 0 && values.every(v => Number.isFinite(v) && v >= 0);
  const minMinutes = known ? Math.min(...values) : null;
  const goal = b.purpose === 'game' ? 2 : Number(b.targetHours || 1000) * 60;
  const licenseCount = games.filter(g => licensed.has(g)).length;
  const licensesReady = games.length > 0 && licenseCount === games.length;
  const loggedIn = ['playing', 'paused', 'giving-way', 'online'].includes(b.workerState);
  let health = 'waiting', message = 'Waiting for worker login';
  if (b.state === 'ready' && b.accountStage === 'listed') { health = 'listed'; message = 'Listed on Eldorado; worker logged out'; }
  else if (b.state === 'ready' && b.accountStage === 'sold') { health = 'sold'; message = 'Sold; worker logged out'; }
  else if (b.state === 'ready') { health = 'ready'; message = 'Verified and logged out; ready for Eldorado'; }
  else if (b.state === 'stopped') { message = 'Stopped by operator'; }
  else if (b.state === 'failed') { health = 'attention'; message = b.lastError || 'Steam login failed'; }
  else if (b.state === 'stopping') { message = 'Holding account until logout is confirmed'; }
  else if (!fresh && seen) { health = 'attention'; message = 'Account report is stale; reservation stays held'; }
  else if (b.workerState === 'retrying') { health = 'attention'; message = b.lastError || 'Retrying Steam connection'; }
  else if (b.workerState === 'waiting-code') { message = 'Reading Steam Guard email'; }
  else if (b.workerState === 'connecting' || b.workerState === 'reconnecting') { message = 'Connecting to Steam'; }
  else if (fresh && loggedIn && licensesReady) {
    health = 'healthy';
    message = b.workerState === 'paused' ? 'Settling session time with Steam' : b.workerState === 'giving-way' ? 'Waiting while account is used elsewhere' : known ? 'Idling; Steam minutes verified' : 'Idling; awaiting Steam-recorded minutes';
  } else if (fresh && loggedIn) { message = 'Checking game licenses'; }
  return { health, message, fresh, loggedIn: fresh && loggedIn && ['queued', 'boosting'].includes(b.state), licensesReady, licenseCount, targetGames: games.length, minMinutes, timeVerified: known, progress: minMinutes === null ? 0 : Math.min(100, minMinutes / goal * 100), targetMinutes: goal };
}
function summary(rows, now) {
  const out = { assigned: 0, preparing: 0, boosting: 0, idling: 0, waiting: 0, attention: 0, ready: 0, listed: 0, sold: 0, verified: 0, stopped: 0 };
  for (const b of rows) {
    const h = assess(b, now);
    if (['queued', 'boosting', 'stopping'].includes(b.state)) { out.assigned++; out[b.purpose === 'game' ? 'preparing' : 'boosting']++; }
    if (h.health === 'attention') out.attention++;
    if (h.health === 'waiting' && b.state !== 'stopped') out.waiting++;
    if (['ready', 'listed', 'sold'].includes(h.health)) out[h.health]++;
    if (b.state === 'stopped') out.stopped++;
    if (h.fresh && b.workerState === 'playing' && b.playing > 0) out.idling++;
    if (h.timeVerified && h.minMinutes > 0) out.verified++;
  }
  return out;
}
module.exports = { assess, summary };
