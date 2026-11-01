/* The server owns the queue; this page only starts it and displays progress. */
window.initEpicClaimBatch = function ({api, load, toast, pausedUntil}) {
  var start = document.getElementById('btnClaimAll');
  var stop = document.getElementById('btnStopClaims');
  var output = document.getElementById('claimBatchProgress');
  var last = '', polling = false, submitting = false;
  function draw(batch) {
    var active = ['preparing', 'running'].includes(batch.state);
    // Epic's HTTP 429 pause: every claim would stop at once, so wait it out.
    var paused = !active && pausedUntil ? pausedUntil() : '';
    start.disabled = active || submitting || !!paused;
    stop.hidden = !active;
    start.textContent = active ? 'Claims running on Mac…' : paused ? 'Paused until ' + paused : 'Claim all missing';
    if (batch.state === 'idle') return;
    var names = {preparing: 'Preparing claims', running: 'Running on Mac', complete: 'Batch finished',
      stopped: 'Batch stopped', paused: 'Batch paused', error: 'Batch failed'};
    output.replaceChildren();
    var summary = document.createElement('p');
    summary.textContent = (names[batch.state] || batch.state) + ' · ' + batch.completed + '/' + batch.total +
      ' processed' + (batch.reason ? ' · ' + batch.reason : '');
    output.appendChild(summary);
    if (batch.jobs.length) {
      var details = document.createElement('details'), title = document.createElement('summary');
      title.textContent = 'Claim results'; details.appendChild(title);
      var list = document.createElement('ul');
      batch.jobs.forEach(function (job) {
        var item = document.createElement('li');
        item.textContent = job.account + ' — ' + job.game + ': ' + job.state.replace(/_/g, ' ') +
          (job.message ? ' · ' + job.message : '');
        list.appendChild(item);
      });
      details.appendChild(list); output.appendChild(details);
    }
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
  start.addEventListener('click', async function () {
    if (submitting) return; submitting = true; start.disabled = true;
    try { var result = await api('/api/epic/claims/batch', {method: 'POST', body: '{}'});
      submitting = false; draw(result.batch);
      toast(result.batch.total ? 'All missing claims queued on the Mac.' : 'No eligible missing games to claim.');
    } catch (error) { toast(error.message, true); }
    finally { submitting = false; await poll(); }
  });
  stop.addEventListener('click', async function () {
    try { draw((await api('/api/epic/claims/batch/stop', {method: 'POST', body: '{}'})).batch);
      toast('Stopping after the current claim finishes.'); }
    catch (error) { toast(error.message, true); }
  });
  poll(); setInterval(poll, 3000);
};
