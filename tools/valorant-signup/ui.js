const token = document.querySelector('meta[name="local-token"]').content;
const $ = id => document.getElementById(id);
let connected = false, current, countries = [], queue = null, loading = false, launching = false, secretTimer;
async function api(path, body) {
  const response = await fetch(path, {method: body === undefined ? 'GET' : 'POST',
    headers: {'X-Local-Token': token, 'Content-Type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});
  if (response.status === 403) throw Error('The creator restarted. Reload this page.');
  const data = await response.json();
  if (!response.ok || !data.ok) throw Error(data.error || 'Local request failed');
  return data;
}
function extension(type, options = {}) {
  return new Promise((resolve,reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {window.removeEventListener('message', receive); reject(Error('Valorant extension did not respond. Load it and enable Allow in Incognito.'));}, ['start','resume','status'].includes(type) ? 35000 : 6000);
    function receive(event) {
      if (event.source !== window || event.origin !== location.origin || event.data?.channel !== 'valorant-local-response' || event.data.id !== id) return;
      clearTimeout(timer); window.removeEventListener('message', receive);
      event.data.result?.ok ? resolve(event.data.result) : reject(Error(event.data.result?.error || 'Extension request failed'));
    }
    window.addEventListener('message', receive);
    window.postMessage({channel: 'valorant-local-request', id, type, token: type === 'connect' ? token : undefined, ...options}, location.origin);
  });
}
function controls() {
  const ready = connected && !launching && !current?.active && !queue && current?.pool.exclusiveReady;
  $('start').disabled = !ready; $('queue').disabled = !ready;
  $('resume').disabled = !connected || launching || !current?.active || !!queue;
  $('country').disabled = launching || !!queue; $('count').disabled = launching || !!queue;
  $('stop').disabled = !queue;
  $('queueStatus').textContent = queue ? `${queue.done} saved · ${queue.remaining.length} waiting${queue.current ? ' · current: ' + queue.current : ''}` : 'No queue running.';
}
function clearSecrets() {document.querySelectorAll('[data-secret]').forEach(el => el.remove()); clearTimeout(secretTimer);}
document.addEventListener('visibilitychange', () => {if (document.hidden) clearSecrets();});
function table() {
  const root = $('accounts'); if (root.querySelector('[data-secret]')) return;
  root.replaceChildren(); if (!current.accounts.length) {root.textContent = 'No saved Valorant accounts yet.'; return;}
  const table = document.createElement('table'), head = document.createElement('tr');
  for (const title of ['Username', 'Email', 'Signup / proxy', 'Expected shard', 'Status', '']) {const th = document.createElement('th'); th.textContent = title; head.append(th);} table.append(head);
  for (const account of current.accounts) {
    const row = document.createElement('tr');
    for (const value of [account.username, account.email, `${account.requestedCountry} / ${account.proxyCountry}`, `${account.expectedShard} · unverified`, account.mailPending ? 'Saved · mail sync pending' : 'Created · fresh']) {
      const td = document.createElement('td'); td.textContent = value; row.append(td);
    }
    const cell = document.createElement('td'), reveal = document.createElement('button'); reveal.textContent = 'Reveal';
    reveal.onclick = async () => {
      try {clearSecrets(); const data = await api('/api/accounts/' + account.id + '/reveal', {});
        const pre = document.createElement('pre'); pre.dataset.secret = 'true';
        pre.textContent = `${data.username}\n${data.password}\n${data.email}\nBirth date: ${data.birthDate}`;
        cell.append(pre); secretTimer = setTimeout(clearSecrets, 60000);
      } catch (e) {$('message').textContent = e.message;}
    }; cell.append(reveal);
    if (account.mailPending) {
      const retry = document.createElement('button'); retry.textContent = 'Retry mail sync';
      retry.onclick = async () => {try {retry.disabled = true; await api('/api/accounts/' + account.id + '/retry-mail', {}); await load();} catch (e) {$('message').textContent = e.message; retry.disabled = false;}};
      cell.append(retry);
    }
    row.append(cell); table.append(row);
  } root.append(table);
}
async function launch(type, country = $('country').value) {
  launching = true; controls();
  try {await extension(type, {country}); $('message').textContent = 'Checking the private browser proxy, then opening Riot signup.';}
  finally {launching = false; controls();}
}
function stop(message) {queue = null; controls(); if (message) $('message').textContent = message;}
async function advance(status) {
  if (!queue || launching) return;
  if (status?.lastError) {stop(status.lastError); return;}
  if (queue.current) {
    if (current.active && !status?.busy) {stop('Signup window closed. Resume the existing identity.'); return;}
    if (status?.busy || current.active) return;
    if (current.accounts.length <= queue.accountCount) {stop('Signup interrupted. Resume the existing identity.'); return;}
    if (current.accounts.some(a => a.mailPending)) {stop('Account saved; finish mail sync before continuing the queue.'); return;}
    queue.done++; queue.current = null;
  }
  if (!queue.remaining.length) {stop(`Regional queue finished · ${queue.done} saved.`); return;}
  if (!current.pool.exclusiveReady) {stop('Cloud Riot inbox reservations are unavailable.'); return;}
  queue.current = queue.remaining.shift(); queue.accountCount = current.accounts.length;
  try {await launch('start', queue.current);} catch (e) {stop(e.message);} controls();
}
async function load() {
  if (loading) return; loading = true;
  try {
    let status; if (connected) status = await extension('status');
    current = await api('/api/state');
    $('connection').textContent = current.pool.error || (!current.pool.exclusiveReady ? 'Cloud pool connected · exclusive Riot reservations need enabling.' : `Cloud Outlook · ${current.pool.unused} unused · ${current.pool.riotUsed} reserved for Riot`);
    $('active').textContent = current.active ? `Current: ${current.active.username} · ${current.active.requestedCountry} · ${current.active.stage === 'needs-action' ? 'Click Continue in the Riot window' : current.active.stage}` : '';
    if (status?.lastError) $('message').textContent = status.lastError;
    table(); controls(); await advance(status);
  } catch (e) {$('message').textContent = e.message; if (queue) stop(e.message);}
  finally {loading = false;}
}
async function connect() {
  try {const result = await extension('connect'); if (result.version !== '0.1.0') throw Error('Reload the current Valorant extension.');
    connected = true; $('extension').textContent = 'Valorant extension connected · ' + result.version; await load();
  } catch (e) {connected = false; $('extension').textContent = e.message; controls();}
}
$('connect').onclick = connect;
$('country').onchange = () => {$('regionNote').textContent = `Expected VALORANT shard: ${countries.find(c => c.code === $('country').value)?.expectedShard || 'unknown'}. The finished account still needs a region check.`;};
for (const type of ['start','resume']) $(type).onclick = async () => {try {await launch(type);} catch (e) {$('message').textContent = e.message;} await load();};
$('test').onclick = async () => {
  $('test').disabled = true;
  try {const data = await api('/api/proxy/prepare', {country: $('country').value}); $('proxyResult').textContent = `Proxy verified: ${data.proxy.location.country} · ${data.proxy.location.city || 'country matched'} · no inbox reserved.`;}
  catch (e) {$('proxyResult').textContent = e.message;} finally {$('test').disabled = false;}
};
$('queue').onclick = async () => {
  const count = Number($('count').value), selected = [...$('regions').selectedOptions].map(o => o.value);
  if (!Number.isInteger(count) || count < 1 || count > 10 || !selected.length) {$('message').textContent = 'Choose countries and 1 to 10 accounts per country.'; return;}
  const remaining = selected.flatMap(country => Array(count).fill(country));
  if (remaining.length > (current.pool.unused || 0)) {$('message').textContent = 'Not enough unused Outlook inboxes for this queue.'; return;}
  queue = {remaining, done: 0, current: null, accountCount: current.accounts.length}; controls(); await load();
};
$('stop').onclick = () => {if (queue) {queue.remaining = []; controls();}};
(async () => {
  try {({countries} = await api('/api/regions'));
    for (const id of ['country','regions']) for (const country of countries) {
      const option = document.createElement('option'); option.value = country.code; option.textContent = `${country.name} (${country.code}) · ${country.expectedShard}`;
      option.selected = id === 'country' && country.code === 'JP'; $(id).append(option);
    } $('country').onchange(); await load(); await connect();
  } catch (e) {$('message').textContent = e.message;}
})();
setInterval(load, 6000);
