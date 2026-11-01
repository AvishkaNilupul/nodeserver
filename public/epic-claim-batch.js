/* The server owns the queue; this page only starts it and displays progress.
   epic-claims.js calls start()/stop() as the Claims tab shows and hides: the poll runs
   every 3 s while a batch is running, every 15 s otherwise, never while hidden. */
window.initEpicClaimBatch = function ({api, load, toast, pausedUntil, idleLabel}) {
  var start = document.getElementById('btnClaimAll');
  var stop = document.getElementById('btnStopClaims');
  var output = document.getElementById('claimBatchProgress');
  var last = '', polling = false, submitting = false;
  var running = false, timer = null, active = false, lastBatch = null;
  var names = {preparing: 'Preparing claims', running: 'Running on Mac', complete: 'Batch finished',
    stopped: 'Batch stopped', paused: 'Batch paused', error: 'Batch failed'};
  var tones = {preparing: 'is-accent', running: 'is-accent', complete: 'is-ok', paused: 'is-warn', error: 'is-error'};
  function draw(batch) {
    if (batch) lastBatch = batch;
    batch = lastBatch || {state: 'idle', total: 0, completed: 0, jobs: []};
    active = ['preparing', 'running'].includes(batch.state);
    // Epic's HTTP 429 pause: every claim would stop at once, so wait it out.
    var paused = !active && pausedUntil ? pausedUntil() : '';
    start.disabled = active || submitting || !!paused;
    stop.hidden = !active;
    start.textContent = active ? 'Claims running on Mac…' : paused ? 'Paused until ' + paused
      : idleLabel ? idleLabel() : 'Claim all missing';
    if (batch.state === 'idle') { output.replaceChildren(); return; }
    var wasOpen = !!output.querySelector('details[open]');
    output.replaceChildren();
    var box = document.createElement('div'); box.className = 'batch-box';
    var head = document.createElement('div'); head.className = 'batch-head';
    var badge = document.createElement('span');
    badge.className = 'ep-badge ' + (tones[batch.state] || '');
    badge.textContent = names[batch.state] || batch.state;
    var count = document.createElement('span');
    count.textContent = batch.completed + '/' + batch.total + ' processed' + (batch.reason ? ' · ' + batch.reason : '');
    var bar = document.createElement('span'); bar.className = 'ep-progress';
    var fill = document.createElement('i');
    fill.style.width = (batch.total ? Math.round(100 * batch.completed / batch.total) : 0) + '%';
    bar.appendChild(fill);
    head.append(badge, count, bar); box.appendChild(head);
    if (batch.jobs.length) {
      var details = document.createElement('details'), title = document.createElement('summary');
      title.textContent = 'Claim results'; details.appendChild(title); details.open = wasOpen;
      var list = document.createElement('ul');
      batch.jobs.forEach(function (job) {
        var item = document.createElement('li');
        item.textContent = job.account + ' — ' + job.game + ': ' + job.state.replace(/_/g, ' ') +
          (job.message ? ' · ' + job.message : '');
        list.appendChild(item);
      });
      details.appendChild(list); box.appendChild(details);
    }
    output.appendChild(box);
    var key = batch.id + ':' + batch.state;
    if (last && last !== key && !active) load();
    last = key;
  }
  async function poll() {
    if (polling) return; polling = true;
    try { draw((await api('/api/epic/claims/batch')).batch); }
    catch { output.textContent = 'Claim progress unavailable. Reconnecting…'; }
    finally { polling = false; }
  }
  function schedule() {
    clearTimeout(timer);
    if (running && !document.hidden) timer = setTimeout(tick, active ? 3000 : 15000);
  }
  async function tick() { await poll(); schedule(); }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) clearTimeout(timer); else if (running) tick();
  });
  start.addEventListener('click', async function () {
    if (submitting) return; submitting = true; start.disabled = true;
    try { var result = await api('/api/epic/claims/batch', {method: 'POST', body: '{}'});
      submitting = false; draw(result.batch);
      toast(result.batch.total ? 'All missing claims queued on the Mac.' : 'No eligible missing games to claim.');
    } catch (error) { toast(error.message, true); }
    finally { submitting = false; await poll(); schedule(); }
  });
  stop.addEventListener('click', async function () {
    try { draw((await api('/api/epic/claims/batch/stop', {method: 'POST', body: '{}'})).batch);
      toast('Stopping after the current claim finishes.'); }
    catch (error) { toast(error.message, true); }
  });
  return {
    start: function () { if (!running) { running = true; tick(); } },
    stop: function () { running = false; clearTimeout(timer); },
    redraw: function () { draw(); },
  };
};
