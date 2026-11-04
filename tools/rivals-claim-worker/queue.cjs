const crypto = require('node:crypto');
const {Store} = require('./store.cjs');
const PHASES = ['queued', 'signed-in', 'linked', 'collected', 'verified', 'logged-out'];
const fail = (message, status = 400) => { throw Object.assign(Error(message), {status}); };
const text = (value, max = 300) => typeof value === 'string' && value.length <= max && !value.includes('\0') ? value.trim() : '';
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN;
function publicJob(job) {
  const {secrets, lease, ...safe} = job;
  return {...safe, lease: lease ? {owner: lease.owner, expiresAt: lease.expiresAt, active: lease.expiresAt > Date.now()} : null};
}
class Queue {
  constructor(directory, {now = Date.now} = {}) { this.store = new Store(directory); this.now = now; }
  status() {
    const d = this.store.read();
    return {enabled: d.config.enabled, jobs: d.jobs.map(publicJob), observations: d.observations.slice(-100), phases: PHASES};
  }
  import(input) {
    const steam = input?.steam, twitch = input?.twitch;
    const id = text(input?.id, 100), holdId = text(input?.holdId, 100);
    if (!/^[\w-]{8,100}$/.test(id) || !holdId || !/^[a-z0-9_]{3,64}$/i.test(steam?.login || '') || !/^[a-z0-9_]{3,30}$/i.test(twitch?.login || '')) fail('Incomplete account pair');
    if (!text(steam.password, 256) || !text(twitch.password, 256)) fail('Both account credentials are required');
    if (input?.holdVerified !== true || !Number.isFinite(stamp(input.holdCheckedAt)) || Math.abs(this.now() - stamp(input.holdCheckedAt)) > 300000) fail('A fresh exclusive stock hold is required');
    if (!Array.isArray(input.expectedRewards) || !input.expectedRewards.length || input.expectedRewards.length > 100) fail('Expected game rewards are required');
    const rewards = input.expectedRewards.map(r => ({id: text(r.id, 200), name: text(r.name, 200)}));
    if (rewards.some(r => !r.id || !r.name) || new Set(rewards.map(r => r.id)).size !== rewards.length) fail('Invalid reward manifest');
    return this.store.transact(d => {
      const old = d.jobs.find(j => j.id === id);
      if (old) {
        if (old.steamLogin !== steam.login || old.twitchLogin !== twitch.login || old.holdId !== holdId) fail('A job cannot be reassigned to another account pair', 409);
        return publicJob(old);
      }
      if (d.jobs.some(j => j.steamLogin === steam.login || j.twitchLogin === twitch.login || j.holdId === holdId)) fail('An account or stock hold is already assigned', 409);
      const job = {id, holdId, holdCheckedAt: input.holdCheckedAt, steamLogin: steam.login, twitchLogin: twitch.login,
        steamAccountId: text(steam.id, 100), twitchAccountId: text(twitch.id, 100), rivalsUid: null,
        expectedRewards: rewards, verifiedRewards: [], phase: 'queued', state: 'pending', revision: 0,
        createdAt: new Date(this.now()).toISOString(), updatedAt: new Date(this.now()).toISOString(),
        attempts: 0, nextAttemptAt: 0, lease: null, block: null, mailExpiresAt: null, events: [], eventDigests: {},
        secrets: {steamPassword: steam.password, twitchPassword: twitch.password, steamEmail: text(steam.email, 254)}};
      d.jobs.push(job); return publicJob(job);
    });
  }
  acquire(owner, id) {
    if (!text(owner, 80)) fail('Worker identity is required');
    return this.store.transact(d => {
      if (!d.config.enabled) fail('Queue paused', 409);
      const active=d.jobs.find(j=>j.id===d.config.activeJobId);
      if (active?.state==='blocked'||d.jobs.some(j => j.state === 'blocked' && j.phase !== 'queued' && j.phase !== 'logged-out')) fail('Resolve the blocked game session before starting another account', 409);
      const live = d.jobs.find(j => j.state === 'running' && j.phase !== 'logged-out');
      const j = active&&['pending','running'].includes(active.state)?active:live || d.jobs.find(j => (!id || j.id === id) && j.state === 'pending' && j.nextAttemptAt <= this.now());
      if (!j) return null;
      if(j.state==='pending'&&j.nextAttemptAt>this.now())return null;
      if (j.attempts >= 5 && j.state !== 'running') fail('Attempt limit reached; review this account',409);
      if (id && j.id !== id) fail('Finish the active account before changing jobs', 409);
      if (j.lease && j.lease.expiresAt > this.now() && j.lease.owner !== owner) fail('Another worker holds this game session', 409);
      const recovered = j.state === 'running';
      j.state = 'running';
      d.config.activeJobId=j.id;
      if (!recovered) j.attempts++;
      j.lease = {owner, token: crypto.randomBytes(32).toString('base64url'), expiresAt: this.now() + 900000};
      j.revision++; j.updatedAt = new Date(this.now()).toISOString();
      return {job: publicJob(j), leaseToken: j.lease.token, recovered};
    });
  }
  owned(d, id, token) {
    const j = d.jobs.find(j => j.id === id);
    if (!j) fail('Unknown job', 404);
    if (j.state !== 'running' || !j.lease || j.lease.expiresAt <= this.now() || j.lease.token !== token) fail('Worker lease expired or does not match', 409);
    return j;
  }
  record(id, token, revision, e) {
    if (!/^[\w-]{8,100}$/.test(e?.id || '')) fail('Unique observation id is required');
    return this.store.transact(d => {
      const j = this.owned(d, id, token);
      const digest=crypto.createHash('sha256').update(JSON.stringify(e)).digest('hex');
      if (j.events.includes(e.id)) {
        if(j.eventDigests?.[e.id]!==digest)fail('Observation id was reused with different evidence',409);
        return publicJob(j);
      }
      if (j.revision !== revision) fail('Job changed; read its current revision', 409);
      if (!PHASES.includes(e.phase) || PHASES.indexOf(e.phase) !== PHASES.indexOf(j.phase) + 1) fail('Observe each phase in order', 409);
      const when = stamp(e.observedAt);
      if (!Number.isFinite(when) || when < stamp(j.createdAt) || Math.abs(this.now() - when) > 300000 || !text(e.screen, 2000)) fail('Fresh game-screen evidence is required');
      if (Object.values(j.secrets).some(s => s && e.screen.includes(s))) fail('Do not put credentials in observation notes');
      if (e.steamLogin !== j.steamLogin) fail('Steam account identity mismatch', 409);
      const uid = text(e.rivalsUid, 80);
      if (!/^[\w-]{3,80}$/.test(uid) || j.rivalsUid && j.rivalsUid !== uid) fail('Rivals UID mismatch', 409);
      if (e.phase === 'signed-in' && e.kind !== 'game-profile') fail('Verify the game profile before linking');
      if (e.phase === 'linked' && (e.kind !== 'linked-profile' || e.twitchLogin !== j.twitchLogin)) fail('Verify both sides of the exact Twitch pairing');
      if (e.phase === 'collected') {
        if (e.kind !== 'game-mailbox' || !Number.isInteger(e.collectedCount) || e.collectedCount < 0) fail('Observe mailbox collection');
        if (e.mailExpiresAt) {
          if (!Number.isFinite(stamp(e.mailExpiresAt)) || stamp(e.mailExpiresAt) <= when) fail('Mailbox rewards have expired');
          j.mailExpiresAt = e.mailExpiresAt;
        }
      }
      if (e.phase === 'verified') {
        if (e.kind !== 'game-inventory' || !Array.isArray(e.rewardIds)) fail('Game inventory evidence is required');
        const actual = new Set(e.rewardIds);
        if (actual.size !== j.expectedRewards.length || j.expectedRewards.some(r => !actual.has(r.id))) fail('Every promised reward must be verified in the game inventory');
        j.verifiedRewards = [...actual]; j.verifiedAt = e.observedAt;
      }
      if (e.phase === 'logged-out' && (e.kind !== 'signed-out-screen' || e.identityCleared !== true)) fail('Verify sign-out before releasing the game session');
      j.rivalsUid = uid; j.phase = e.phase; j.events.push(e.id); j.eventDigests[e.id]=digest;
      j.revision++; j.updatedAt = new Date(this.now()).toISOString();
      j.lease.expiresAt = this.now() + 900000;
      if (j.phase === 'logged-out') { j.state = 'ready'; j.lease = null; j.completedAt = j.updatedAt; d.config.activeJobId=null; }
      // Whitelist observations: a caller cannot accidentally store passwords in metadata.
      d.observations.push({id: e.id, jobId: j.id, phase: e.phase, kind: e.kind, observedAt: e.observedAt,
        steamLogin: j.steamLogin, rivalsUid: uid, screen: e.screen, rewardIds: e.phase === 'verified' ? [...e.rewardIds] : [],
        collectedCount: e.phase === 'collected' ? e.collectedCount : undefined});
      return publicJob(j);
    });
  }
  heartbeat(id, token) {
    return this.store.transact(d => { const j = this.owned(d,id,token); j.lease.expiresAt = this.now()+900000; return publicJob(j); });
  }
  releaseLease(id, token) {
    return this.store.transact(d => {
      const j = this.owned(d,id,token);
      // Handoff the same signed-in account without changing phase, readiness,
      // attempts, stock holds, or the exclusive active account selection.
      j.lease=null;j.revision++;j.updatedAt=new Date(this.now()).toISOString();
      return publicJob(j);
    });
  }
  acquireRetainedTest(owner,id,{rivalsUid,holdId,confirmedAt,authorizedUntil}={}) {
    const until=authorizedUntil?stamp(authorizedUntil):stamp(confirmedAt)+10800000;
    if(!text(owner,80)||!text(holdId,100)||!Number.isFinite(stamp(confirmedAt))||!Number.isFinite(until)||until<=this.now()||until>stamp(confirmedAt)+28800000||stamp(confirmedAt)>this.now()+60000)fail('Explicit current owner handoff is required');
    return this.store.transact(d=>{
      const j=d.jobs.find(x=>x.id===id);
      if(!j||d.config.activeJobId!==id||j.state!=='running'||j.phase!=='verified'||j.rivalsUid!==rivalsUid||j.verifiedRewards.length!==j.expectedRewards.length)fail('Only the exact verified retained session can be tested',409);
      if(j.lease&&j.lease.expiresAt>this.now())fail('Another worker still holds this game session',409);
      // Leave the global queue paused. This exception owns only the explicitly
      // retained account, with a separate remote paused-offer hold checked by IO.
      j.lease={owner,token:crypto.randomBytes(32).toString('base64url'),expiresAt:this.now()+900000};
      j.levelingHandoff={holdId,confirmedAt,...(authorizedUntil?{authorizedUntil}: {})};j.revision++;j.updatedAt=new Date(this.now()).toISOString();
      return {job:publicJob(j),leaseToken:j.lease.token,recovered:true};
    });
  }
  beginLogin(id,token) {
    return this.store.transact(d=>{
      const j=this.owned(d,id,token);
      if(j.phase==='logged-out')fail('A completed game session cannot sign in again',409);
      if(!j.loginStartedAt||this.now()-stamp(j.loginStartedAt)>900000){j.loginStartedAt=new Date(this.now()).toISOString();j.revision++;}
      return publicJob(j);
    });
  }
  loginContext(id) {
    const j=this.store.read().jobs.find(j=>j.id===id);
    if(!j||j.state!=='running'||!j.loginStartedAt||this.now()-stamp(j.loginStartedAt)>900000)fail('Prepare this account sign-in before requesting its email code',409);
    return {email:j.secrets.steamEmail,since:j.loginStartedAt};
  }
  block(id, token, reason) {
    if (!text(reason, 500)) fail('Explain the exact observed blocker');
    return this.store.transact(d => {
      const j = this.owned(d,id,token);
      if(Object.values(j.secrets).some(s=>s&&reason.includes(s)))fail('Do not put credentials in blocker notes');
      j.state = 'blocked'; j.block = text(reason,500); j.lease=null;
      j.revision++; j.updatedAt = new Date(this.now()).toISOString(); return publicJob(j);
    });
  }
  resume(id) {
    return this.store.transact(d => {
      const j = d.jobs.find(j => j.id === id); if (!j) fail('Unknown job',404);
      if (j.state !== 'blocked') fail('Only blocked jobs can resume',409);
      if (j.attempts >= 5) fail('Five attempts reached; review the recorded failure before continuing',409);
      j.state='pending';j.block=null;j.nextAttemptAt=this.now()+30000;j.revision++;return publicJob(j);
    });
  }
  secret(id, key) {
    if (!['steamPassword','twitchPassword','steamEmail'].includes(key)) fail('Unknown credential');
    const j=this.store.read().jobs.find(j=>j.id===id);if(!j)fail('Unknown job',404);
    return j.secrets[key] || '';
  }
  pause(enabled) { return this.store.transact(d=>{d.config.enabled=enabled===true;return{enabled:d.config.enabled};}); }
}
module.exports={Queue,PHASES,publicJob};
