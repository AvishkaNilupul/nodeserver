#!/usr/bin/env node
// Standalone localhost dashboard for the outlook mail fleet.
//
// Reads scripts/outlooks.txt (same file the harvester writes), lists every
// account, and lets you check token health + read the inbox via Microsoft
// Graph live from the browser. Zero Mongo dependency — this is the preview
// surface while the fleet is still small. Once we move to DB-backed
// MailAccount we flip the data source and keep the same UI.
//
// Usage:
//   node scripts/mail-dashboard.js            # port 3999
//   PORT=4100 node scripts/mail-dashboard.js  # pick another port

const fs = require("fs");
const path = require("path");
const express = require("express");
const axios = require("axios");
const { PublicClientApplication } = require("@azure/msal-node");

const { findEpicOtp } = require("../utils/epicMailOtp");

const PORT = Number(process.env.PORT || 3999);
const OUT_FILE = path.resolve(__dirname, "outlooks.txt");
const AUTHORITY = "https://login.microsoftonline.com/common";
const SCOPES = ["Mail.ReadWrite", "Mail.Send", "User.Read"];
const GRAPH = "https://graph.microsoft.com/v1.0";
// Third-party fallback reader — vendor-run mailbox checker. Public API (no
// key). Uses the same Microsoft Graph calls under the hood, so it only helps
// when (a) the token is alive, or (b) their server has a cached message from
// when the token WAS alive. See /api/accounts/:email/read-vendor.
const VENDOR_API = "https://read.tmailmmo.qzz.io/api/read";

// ----- credentials file -----

// Accepts both delimiters we have in the wild:
//   colon  → `email:pass:refresh:client`                  (our harvester writes this)
//   pipe   → `email|pass|refresh|client[|recovery]`       (vendor-shipped format)
// The 5th field (recovery email) is optional and used only for the vendor API.
function readAccounts() {
  if (!fs.existsSync(OUT_FILE)) return [];
  const lines = fs
    .readFileSync(OUT_FILE, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const out = [];
  for (const line of lines) {
    const delim = line.includes("|") ? "|" : ":";
    const parts = line.split(delim);
    if (parts.length < 4) continue;
    out.push({
      email: parts[0].trim(),
      pass: parts[1],
      refreshToken: parts[2],
      clientId: parts[3].trim(),
      recoveryEmail: (parts[4] || "").trim(),
      // Pipe delimiter = vendor-shipped (reads route through tmailmmo's token
      // cache). Colon delimiter = we harvested the token ourselves via the
      // device-code flow. The UI uses this to split accounts into two
      // sections so operator can tell at a glance which are self-owned.
      source: delim === "|" ? "vendor" : "harvested",
    });
  }
  return out;
}

// ----- Usage tracking (file-backed, server-side source of truth) -----
// Shape: { "email@outlook.com": { "soop": { status, at, detail, extra } } }
// `status` ∈ 'reserved' | 'ok' | 'fail'. Clients (userscripts) call
// /api/pool/pick for atomic reservation + /api/pool/release for the verdict.
// Also surfaced in /api/accounts.uses so the dashboard can badge rows.
const USAGE_FILE = path.resolve(__dirname, "mail-usage.json");

function readUsage() {
  try {
    if (!fs.existsSync(USAGE_FILE)) return {};
    return JSON.parse(fs.readFileSync(USAGE_FILE, "utf8") || "{}");
  } catch {
    return {};
  }
}

function writeUsage(obj) {
  fs.writeFileSync(USAGE_FILE, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
}

function markUsage(email, forPurpose, status, detail, extra) {
  const usage = readUsage();
  const key = String(email).toLowerCase();
  if (!usage[key]) usage[key] = {};
  const prev = usage[key][forPurpose] || {};
  usage[key][forPurpose] = {
    status, // 'reserved' | 'ok' | 'fail'
    at: Date.now(),
    detail: detail || "",
    // An inbox picked for an EXCLUSIVE purpose stays that purpose's alone
    // through every later release (see /api/pool/pick).
    ...(prev.exclusive ? { exclusive: true } : {}),
    ...(extra || {}),
  };
  writeUsage(usage);
  return usage[key][forPurpose];
}

// ----- Graph helpers -----

async function mintAccessToken(acct) {
  const pca = new PublicClientApplication({
    auth: { clientId: acct.clientId, authority: AUTHORITY },
  });
  const result = await pca.acquireTokenByRefreshToken({
    refreshToken: acct.refreshToken,
    scopes: SCOPES,
  });
  return result.accessToken;
}

async function listMessages(accessToken, top = 10) {
  const url =
    `${GRAPH}/me/messages` +
    `?$top=${top}` +
    `&$orderby=receivedDateTime desc` +
    `&$select=id,subject,from,receivedDateTime,bodyPreview,isRead,body`;
  const { data } = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      // Ask Graph for plain-text bodies — way easier to regex for codes than
      // escaping HTML. Microsoft converts server-side.
      Prefer: 'outlook.body-content-type="text"',
    },
    timeout: 15000,
  });
  return data.value || [];
}

// Pull likely verification codes out of a message. Pattern covers the common
// shapes: a 4-8 digit numeric code appearing with keywords (code/verify/pin),
// standalone 6-digit blocks (classic OTP), and dash-separated 3-3 blocks.
function extractCodes(text) {
  if (!text) return [];
  const codes = new Set();
  const t = String(text);
  // 4-10 digit numeric blocks near keyword
  const kw = /(?:code|verif(?:y|ication)|pin|password|otp|security)[\s:]{0,30}?(\d{4,10})/gi;
  let m;
  while ((m = kw.exec(t))) codes.add(m[1]);
  // standalone 5-8 digit tokens on their own line/boundary
  const bare = /(?:^|[^\d])(\d{5,8})(?:[^\d]|$)/g;
  while ((m = bare.exec(t))) codes.add(m[1]);
  // "123-456" style
  const dashed = /\b(\d{3}[-\s]\d{3})\b/g;
  while ((m = dashed.exec(t))) codes.add(m[1].replace(/[-\s]/g, ""));
  // Filter obvious noise: years, zip codes we don't want
  return [...codes].filter((c) => c.length >= 4 && c.length <= 10 && !/^(19|20)\d{2}$/.test(c));
}

// ----- the HTML -----

const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>Outlook Fleet</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px;
    font: 14px/1.4 -apple-system, system-ui, 'Segoe UI', sans-serif;
    background: #0e0f12; color: #e6e8ec;
  }
  h1 { margin: 0 0 4px; font-size: 20px; font-weight: 600; }
  .sub { color: #8a8f98; margin-bottom: 24px; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; background: #15171c; border-radius: 8px; overflow: hidden; }
  th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid #22252c; vertical-align: top; }
  th { background: #1a1d23; color: #8a8f98; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  tr:last-child td { border-bottom: none; }
  td.email { font-family: ui-monospace, 'SF Mono', Menlo, monospace; }
  td.client { font-family: ui-monospace, 'SF Mono', Menlo, monospace; color: #8a8f98; font-size: 12px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 500; }
  .badge-unknown { background: #2a2d33; color: #8a8f98; }
  .badge-live { background: #0f2d1e; color: #4ade80; }
  .badge-dead { background: #2d0f0f; color: #f87171; }
  button { background: #2563eb; color: white; border: none; padding: 6px 12px; border-radius: 5px; cursor: pointer; font-size: 12px; margin-right: 6px; }
  button:hover { background: #1d4ed8; }
  button:disabled { background: #2a2d33; color: #666; cursor: not-allowed; }
  button.ghost { background: transparent; border: 1px solid #2a2d33; color: #8a8f98; }
  button.ghost:hover { background: #1a1d23; }
  .inbox { background: #0a0b0e; margin: 0; }
  .inbox td { padding: 0; }
  .msg-list { padding: 12px 20px; }
  .msg { padding: 8px 0; border-bottom: 1px solid #1a1d23; display: grid; grid-template-columns: 160px 240px 1fr; gap: 12px; font-size: 12px; }
  .msg:last-child { border-bottom: none; }
  .msg-date { color: #8a8f98; font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 11px; }
  .msg-from { color: #c5c8cf; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .msg-body { color: #e6e8ec; }
  .msg-subj { font-weight: 500; }
  .msg-preview { color: #8a8f98; margin-top: 2px; }
  .empty { padding: 20px; color: #8a8f98; font-style: italic; }
  .err { padding: 12px 20px; color: #f87171; background: #1a0f0f; font-size: 12px; font-family: ui-monospace, 'SF Mono', Menlo, monospace; }
  .otp-row { margin-top: 6px; display: flex; gap: 6px; flex-wrap: wrap; }
  .otp-chip { display: inline-flex; align-items: center; gap: 8px; padding: 4px 4px 4px 10px; border-radius: 999px; background: #0f2d1e; color: #4ade80; font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 12px; font-weight: 600; border: 1px solid #1a4a30; }
  .otp-chip button { background: #1a4a30; color: #4ade80; border: none; padding: 2px 10px; border-radius: 999px; cursor: pointer; font-size: 11px; margin: 0; }
  .otp-chip button:hover { background: #4ade80; color: #0a1a0f; }
  .otp-chip.copied { background: #1a4a30; color: #a7f3d0; animation: pulse 0.3s ease; }
  @keyframes pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.05); } }
  .view-btn { background: transparent; border: 1px solid #2a2d33; color: #8a8f98; padding: 2px 10px; font-size: 11px; border-radius: 4px; margin-top: 6px; cursor: pointer; }
  .view-btn:hover { background: #1a1d23; color: #c5c8cf; }
  .body-full { margin-top: 10px; padding: 12px; background: #0a0b0e; border: 1px solid #22252c; border-radius: 6px; max-height: 400px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-size: 12px; color: #c5c8cf; font-family: ui-monospace, 'SF Mono', Menlo, monospace; }
  .hint { color: #8a8f98; font-size: 12px; margin-top: 20px; padding: 16px; background: #15171c; border-radius: 8px; border-left: 3px solid #2563eb; }
  .hint code { background: #0a0b0e; padding: 1px 6px; border-radius: 3px; font-size: 11px; }
  .reload { float: right; }
  .section-head { display: flex; align-items: baseline; gap: 12px; margin: 24px 0 10px; color: #c5c8cf; font-size: 13px; font-weight: 600; }
  .section-head .count { color: #8a8f98; font-weight: 400; font-size: 12px; }
  .section-head .tag { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; padding: 2px 8px; border-radius: 4px; font-weight: 500; }
  .section-head .tag-harvested { background: #0f1d2d; color: #60a5fa; border: 1px solid #1e3a5f; }
  .section-head .tag-vendor { background: #2d1a0f; color: #fb923c; border: 1px solid #5a3418; }
  .use-badge { display: inline-block; padding: 2px 7px; margin-right: 4px; border-radius: 10px; font-size: 10px; font-weight: 600; letter-spacing: 0.4px; cursor: pointer; user-select: none; border: 1px solid transparent; }
  .use-ok { background: #0f2d1e; color: #4ade80; border-color: #1a4a30; }
  .use-fail { background: #2d0f0f; color: #f87171; border-color: #5a1818; }
  .use-reserved { background: #2d2a0f; color: #facc15; border-color: #5a521a; }
  .use-badge:hover { filter: brightness(1.3); }
  .pool-summary { display: flex; gap: 12px; margin: 20px 0 0; flex-wrap: wrap; }
  .pool-card { background: #15171c; border: 1px solid #22252c; border-radius: 8px; padding: 10px 14px; min-width: 200px; }
  .pool-name { font-size: 11px; font-weight: 700; color: #c5c8cf; letter-spacing: 1px; margin-bottom: 6px; }
  .pool-stats { display: flex; gap: 6px; align-items: center; font-size: 12px; color: #8a8f98; flex-wrap: wrap; }
  .pool-free { color: #60a5fa; font-weight: 600; }
  .pool-actions { margin-top: 8px; display: flex; gap: 4px; }
  .pool-actions button { font-size: 10px; padding: 3px 8px; margin: 0; }
  .section-sub { margin: 0 0 10px; color: #6b7280; font-size: 11px; font-style: italic; }
</style>
</head><body>
<h1>Outlook Fleet <button class="ghost reload" onclick="load()">↻ reload</button></h1>
<div class="sub">reads <code style="font-family:ui-monospace,'SF Mono',monospace">scripts/outlooks.txt</code> — add rows with <code style="font-family:ui-monospace,'SF Mono',monospace">node scripts/harvest-outlook-tokens.js</code></div>

<div id="sections">loading…</div>

<div class="hint">
  <b>Add more accounts →</b> run <code>node scripts/harvest-outlook-tokens.js --email X@outlook.com --pass '…'</code>, approve the device code, then hit ↻ reload up top. The <b>Read</b> button mints a fresh access_token on demand and pulls the last 10 messages live via Microsoft Graph.
</div>

<script>
const state = {}; // email -> { status, lastCheck, msgs, err, open }

async function load() {
  const res = await fetch('/api/accounts');
  const accounts = await res.json();
  const root = document.getElementById('sections');
  if (!accounts.length) {
    root.innerHTML = '<div class="empty">no accounts yet — run the harvester</div>';
    return;
  }
  const harvested = accounts.filter(a => a.source === 'harvested');
  const vendor = accounts.filter(a => a.source === 'vendor');
  root.innerHTML = '';
  // Pool summary per known purpose — currently only 'soop' but survives any
  // future purpose automatically (counts whatever shows up in uses[]).
  const purposes = new Set();
  for (const a of accounts) for (const p of Object.keys(a.uses || {})) purposes.add(p);
  if (purposes.size) root.appendChild(buildPoolSummary(accounts, [...purposes]));
  if (harvested.length) root.appendChild(buildSection('harvested', harvested));
  if (vendor.length) root.appendChild(buildSection('vendor', vendor));
}

function buildPoolSummary(accounts, purposes) {
  const wrap = document.createElement('div');
  wrap.className = 'pool-summary';
  const cards = purposes.map(p => {
    const uses = accounts.map(a => (a.uses || {})[p]);
    const ok = uses.filter(u => u && u.status === 'ok').length;
    const fail = uses.filter(u => u && u.status === 'fail').length;
    const reserved = uses.filter(u => u && u.status === 'reserved').length;
    const consumed = ok + fail + reserved;
    const free = accounts.length - consumed;
    return \`
      <div class="pool-card">
        <div class="pool-name">\${p.toUpperCase()}</div>
        <div class="pool-stats">
          <span class="pool-free" title="pickable">\${free} free</span>
          <span>·</span>
          <span class="use-ok" style="padding:1px 6px;border-radius:8px;">\${ok} ✓</span>
          <span class="use-fail" style="padding:1px 6px;border-radius:8px;">\${fail} ✗</span>
          <span class="use-reserved" style="padding:1px 6px;border-radius:8px;">\${reserved} ⏳</span>
        </div>
        <div class="pool-actions">
          <button class="ghost" onclick="poolReset('\${p}', 'fail')">Clear fails</button>
          <button class="ghost" onclick="poolReset('\${p}', 'reserved')">Clear reserved</button>
        </div>
      </div>\`;
  }).join('');
  wrap.innerHTML = cards;
  return wrap;
}

async function poolReset(purpose, status) {
  const label = status ? \`\${status} entries\` : 'all entries';
  if (!confirm(\`Clear all \${purpose.toUpperCase()} \${label}? They'll be pickable again.\`)) return;
  await fetch('/api/pool/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ for: purpose, status }),
  });
  load();
}

function buildSection(kind, accounts) {
  const wrap = document.createElement('div');
  const sub = kind === 'harvested'
    ? 'tokens minted via our device-code flow — reads use direct Microsoft Graph.'
    : 'tokens shipped by vendor — reads route through tmailmmo\\'s cache (recovery email required).';
  const title = kind === 'harvested' ? 'Harvested (ours)' : 'Vendor-shipped';
  wrap.innerHTML = \`
    <div class="section-head">
      <span class="tag tag-\${kind}">\${kind}</span>
      <span>\${title}</span>
      <span class="count">· \${accounts.length} account\${accounts.length === 1 ? '' : 's'}</span>
    </div>
    <div class="section-sub">\${sub}</div>
    <table>
      <thead>
        <tr><th>Email</th><th>Client</th><th>Status</th><th>Uses</th><th>Last Check</th><th></th></tr>
      </thead>
      <tbody></tbody>
    </table>\`;
  const tb = wrap.querySelector('tbody');
  accounts.forEach((a) => {
    const s = state[a.email] || {};
    const row = document.createElement('tr');
    row.innerHTML = \`
      <td class="email">\${a.email}</td>
      <td class="client">\${a.clientId.slice(0, 8)}…</td>
      <td><span class="badge badge-\${s.status || 'unknown'}">\${s.status || 'unknown'}</span></td>
      <td>\${renderUses(a)}</td>
      <td class="client">\${s.lastCheck ? new Date(s.lastCheck).toLocaleTimeString() : '—'}</td>
      <td>
        <button onclick="check('\${a.email}')">Check</button>
        <button onclick="read('\${a.email}', 'graph')">Read</button>
        <button class="ghost" onclick="read('\${a.email}', 'vendor')">Vendor</button>
      </td>\`;
    tb.appendChild(row);
    if (s.open) {
      const panel = document.createElement('tr');
      panel.className = 'inbox';
      panel.innerHTML = \`<td colspan="6">\${renderInbox(s)}</td>\`;
      tb.appendChild(panel);
    }
  });
  return wrap;
}

function renderUses(a) {
  const uses = a.uses || {};
  const purposes = Object.keys(uses);
  if (!purposes.length) return '<span style="color:#555;font-size:11px;">—</span>';
  return purposes.map(p => {
    const u = uses[p] || {};
    const sym = u.status === 'ok' ? '✓' : u.status === 'fail' ? '✗' : '⏳';
    const title = \`\${p}/\${u.status}\${u.detail ? '\\n' + u.detail : ''}\${u.at ? '\\n' + new Date(u.at).toLocaleString() : ''}\\n(click to clear)\`;
    return \`<span class="use-badge use-\${u.status}" title="\${title.replace(/"/g,'&quot;')}" onclick="clearUse('\${a.email}', '\${p}')">\${p.toUpperCase()} \${sym}</span>\`;
  }).join(' ');
}

async function clearUse(email, forPurpose) {
  if (!confirm(\`Clear \${forPurpose} usage for \${email}? It'll be pickable again next time.\`)) return;
  await fetch('/api/pool/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, for: forPurpose }),
  });
  load();
}

function renderInbox(s) {
  const header = s.via ? '<div style="padding:6px 20px;color:#8a8f98;font-size:11px;">backend: ' + s.via + '</div>' : '';
  if (s.err) return header + \`<div class="err">\${s.err}</div>\`;
  if (!s.msgs) return header + '<div class="empty">loading…</div>';
  if (!s.msgs.length) return header + '<div class="empty">(inbox is empty)</div>';
  return header + '<div class="msg-list">' + s.msgs.map((m, i) => {
    const mid = (s.via || 'x') + '-' + i;
    const codes = m.codes || [];
    const expanded = state._expanded && state._expanded[mid];
    const otpChips = codes.length
      ? '<div class="otp-row">' + codes.map(c =>
          '<span class="otp-chip" id="chip-' + mid + '-' + c + '">' + c +
          '<button onclick="copyOtp(\\'' + c + '\\', \\'' + mid + '\\')">Copy</button></span>'
        ).join('') + '</div>'
      : '';
    const bodyBtn = m.body
      ? '<button class="view-btn" onclick="toggleBody(\\'' + mid + '\\')">' + (expanded ? '− Hide full' : '+ View full') + '</button>'
      : '';
    const bodyPanel = expanded && m.body
      ? '<pre class="body-full">' + escape(m.body) + '</pre>'
      : '';
    return \`
    <div class="msg">
      <div class="msg-date">\${new Date(m.receivedDateTime).toISOString().replace('T',' ').slice(0,16)}</div>
      <div class="msg-from">\${(m.from && m.from.emailAddress && m.from.emailAddress.address) || '(unknown)'}</div>
      <div class="msg-body">
        <div class="msg-subj">\${escape(m.subject || '(no subject)')}</div>
        <div class="msg-preview">\${escape((m.bodyPreview || '').slice(0,160))}</div>
        \${otpChips}
        \${bodyBtn}
        \${bodyPanel}
      </div>
    </div>\`;
  }).join('') + '</div>';
}

async function copyOtp(code, mid) {
  try { await navigator.clipboard.writeText(code); } catch (e) {}
  // Flash the chip to confirm.
  document.querySelectorAll('#chip-' + mid + '-' + code).forEach(el => {
    el.classList.add('copied');
    setTimeout(() => el.classList.remove('copied'), 400);
  });
}

function toggleBody(mid) {
  if (!state._expanded) state._expanded = {};
  state._expanded[mid] = !state._expanded[mid];
  load();
}

function escape(s) { return (s || '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' })[c]); }

async function check(email) {
  state[email] = { ...(state[email] || {}), status: 'unknown', lastCheck: Date.now() };
  load();
  try {
    const r = await fetch('/api/accounts/' + encodeURIComponent(email) + '/check', { method: 'POST' });
    const d = await r.json();
    state[email] = { ...state[email], status: d.ok ? 'live' : 'dead', err: d.ok ? null : d.error, lastCheck: Date.now() };
  } catch (e) {
    state[email] = { ...state[email], status: 'dead', err: String(e), lastCheck: Date.now() };
  }
  load();
}

async function read(email, backend) {
  backend = backend || 'graph';
  const s = state[email] || {};
  // Same button pressed twice collapses the panel.
  if (s.open && s.via === backend) { state[email] = { ...s, open: false }; load(); return; }
  state[email] = { ...s, open: true, via: backend, msgs: null, err: null };
  load();
  const path = backend === 'vendor' ? '/read-vendor?top=5' : '/read?top=10';
  try {
    const r = await fetch('/api/accounts/' + encodeURIComponent(email) + path, { method: 'POST' });
    const d = await r.json();
    if (d.ok) {
      state[email] = { ...state[email], msgs: d.messages, err: null, via: d.via || backend, status: backend === 'graph' ? 'live' : (state[email].status || 'unknown'), lastCheck: Date.now() };
    } else {
      state[email] = { ...state[email], err: d.error, via: d.via || backend, status: backend === 'graph' ? 'dead' : (state[email].status || 'unknown'), lastCheck: Date.now() };
    }
  } catch (e) {
    state[email] = { ...state[email], err: String(e), via: backend };
  }
  load();
}

load();
</script>
</body></html>`;

// ----- server -----

const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  // Never cache the dashboard HTML — a stale layout from a previous schema
  // version (e.g. missing Uses column) is the single most common "it doesn't
  // show the new thing" source. The /api/* responses are tiny; always fresh.
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.type("html").send(PAGE);
});

app.get("/api/accounts", (_req, res) => {
  const accounts = readAccounts();
  const usage = readUsage();
  // Never leak the secret bits to the client.
  res.json(
    accounts.map((a) => ({
      email: a.email,
      clientId: a.clientId,
      source: a.source,
      hasRecovery: !!a.recoveryEmail,
      uses: usage[a.email.toLowerCase()] || {},
    })),
  );
});

// Atomic "give me a free outlook for purpose X and reserve it on the way out".
// Picks the first account whose uses[forPurpose] is unset. Marks it 'reserved'
// before returning so a concurrent caller can't grab the same row. The caller
// MUST call /api/pool/release when done so the stamp is finalized.
// Used only by the local extension; no proxy configuration crosses to prod.
app.post("/api/epic/proxy", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try { res.json({ ok: true, proxy: await require("../utils/epicLocalProxy").verifiedProxy() }); }
  catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});

// Purposes that take an inbox nothing else uses and keep it to themselves.
const EXCLUSIVE_PURPOSES = new Set(["epic"]);

app.post("/api/pool/pick", (req, res) => {
  const forPurpose = String(req.query.for || req.body?.for || "").toLowerCase();
  if (!forPurpose) return res.status(400).json({ ok: false, error: "missing ?for= query (e.g. ?for=soop)" });
  const accounts = readAccounts();
  if (!accounts.length) return res.json({ ok: false, error: "fleet is empty" });
  const usage = readUsage();
  // Epic accounts get an inbox NOTHING else uses, and keep it to themselves:
  // the buyer of an Epic account may be handed the whole mailbox, so it must
  // never also be a SOOP (or any other) account's email. Every other purpose
  // skips inboxes another purpose holds exclusively. (2026-10-29, owner.)
  const exclusive = EXCLUSIVE_PURPOSES.has(forPurpose);
  const free = accounts.find((a) => {
    const row = usage[a.email.toLowerCase()] || {};
    if (row[forPurpose]) return false;
    const owner = Object.keys(row).find((p) => row[p] && row[p].exclusive);
    if (owner && owner !== forPurpose) return false;
    if (exclusive && Object.keys(row).some((p) => row[p])) return false;
    return true;
  });
  if (!free) {
    return res.json({
      ok: false,
      error: exclusive
        ? `no unused inbox left for '${forPurpose}' — it only takes inboxes nothing else uses (${accounts.length} outlook(s) in the pool)`
        : `fleet exhausted for '${forPurpose}' — ${accounts.length} outlook(s), all consumed`,
      total: accounts.length,
      used: accounts.length,
    });
  }
  markUsage(free.email, forPurpose, "reserved", "picked via /api/pool/pick", exclusive ? { exclusive: true } : null);
  res.json({
    ok: true,
    email: free.email,
    source: free.source,
    clientId: free.clientId,
    hasRecovery: !!free.recoveryEmail,
    for: forPurpose,
  });
});

// Finalize a reservation. Body: { email, for, status: 'ok'|'fail', detail?, extra? }
// Both 'ok' and 'fail' leave the row consumed — SOOP never forgets an email
// so neither do we. Use /api/pool/reset to recycle.
app.post("/api/pool/release", (req, res) => {
  const { email, for: forPurpose, status, detail, extra } = req.body || {};
  if (!email || !forPurpose || !status) {
    return res.status(400).json({ ok: false, error: "need { email, for, status }" });
  }
  if (!["ok", "fail", "reserved"].includes(status)) {
    return res.status(400).json({ ok: false, error: "status must be ok|fail|reserved" });
  }
  const row = markUsage(email, forPurpose, status, detail || "", extra || null);
  res.json({ ok: true, email, for: forPurpose, usage: row });
});

// Recycle usage. Body: { for?: string, status?: 'ok'|'fail'|'reserved', email?: string }
// With no filters, wipes the entire usage file. With for+status, selectively
// clears (e.g. {for:'soop', status:'fail'} = reclaim just failed signups).
app.post("/api/pool/reset", (req, res) => {
  const { for: forPurpose, status, email } = req.body || {};
  const usage = readUsage();
  let cleared = 0;
  const next = {};
  for (const [addr, uses] of Object.entries(usage)) {
    if (email && addr !== String(email).toLowerCase()) {
      next[addr] = uses;
      continue;
    }
    const kept = {};
    for (const [p, meta] of Object.entries(uses)) {
      const matchesPurpose = !forPurpose || p === forPurpose;
      const matchesStatus = !status || meta.status === status;
      if (matchesPurpose && matchesStatus) {
        cleared++;
      } else {
        kept[p] = meta;
      }
    }
    if (Object.keys(kept).length) next[addr] = kept;
  }
  writeUsage(next);
  res.json({ ok: true, cleared, remaining: Object.keys(next).length });
});

function findAccount(email) {
  const accounts = readAccounts();
  return accounts.find((a) => a.email.toLowerCase() === String(email || "").toLowerCase());
}

app.post("/api/accounts/:email/check", async (req, res) => {
  const acct = findAccount(req.params.email);
  if (!acct) return res.status(404).json({ ok: false, error: "unknown account" });
  try {
    const token = await mintAccessToken(acct);
    res.json({ ok: true, tokenLen: token.length });
  } catch (err) {
    res.json({ ok: false, error: err.errorMessage || err.message || String(err) });
  }
});

app.post("/api/accounts/:email/read", async (req, res) => {
  const acct = findAccount(req.params.email);
  if (!acct) return res.status(404).json({ ok: false, error: "unknown account" });
  const top = Math.min(50, Math.max(1, Number(req.query.top) || 10));
  try {
    const token = await mintAccessToken(acct);
    const raw = await listMessages(token, top);
    // Add extracted codes + flatten body.content into a plain body field so
    // the frontend doesn't have to know Graph's shape.
    const messages = raw.map((m) => {
      const body = (m.body && m.body.content) || m.bodyPreview || "";
      return {
        id: m.id,
        subject: m.subject,
        from: m.from,
        receivedDateTime: m.receivedDateTime,
        bodyPreview: m.bodyPreview,
        body,
        isRead: m.isRead,
        codes: extractCodes(`${m.subject || ""}\n${body}`),
      };
    });
    res.json({ ok: true, via: "graph", messages });
  } catch (err) {
    const detail =
      err.response?.data?.error?.message ||
      err.errorMessage ||
      err.message ||
      String(err);
    res.json({ ok: false, via: "graph", error: detail });
  }
});

// Dual-backend fallback: proxy through the vendor's public mailbox reader.
// Returns their shape, normalized into the same {messages:[...]} as /read so
// the UI can render identically. Useful when the token is cache-only or when
// we want a batched read for many accounts.
app.post("/api/accounts/:email/read-vendor", async (req, res) => {
  const acct = findAccount(req.params.email);
  if (!acct) return res.status(404).json({ ok: false, error: "unknown account" });
  const limit = Math.min(5, Math.max(1, Number(req.query.top) || 5));
  // 5-field block when we have the recovery (vendor's cache key); 4-field
  // otherwise. The vendor's tool CAN serve from cache when it recognizes the
  // recovery address, which is often what unlocks a "dead" refresh token.
  const line = acct.recoveryEmail
    ? `${acct.email}|${acct.pass}|${acct.refreshToken}|${acct.clientId}|${acct.recoveryEmail}`
    : `${acct.email}|${acct.pass}|${acct.refreshToken}|${acct.clientId}`;
  try {
    const { data } = await axios.post(
      VENDOR_API,
      {
        accounts: line,
        limit: String(limit),
        concurrency: "1",
        mailbox: "INBOX",
        mode: "auto",
        onlyUnread: false,
      },
      {
        headers: { "content-type": "application/json" },
        timeout: 45000,
      },
    );
    const row = (data.results && data.results[0]) || {};
    if (!row.ok) {
      return res.json({ ok: false, via: "vendor", error: row.error || "vendor returned !ok" });
    }
    // Normalize their message shape into Graph-ish so the UI renders the
    // same panel. Their fields vary a bit by backend; map the common ones.
    // Prefer their pre-extracted `codes` array when present (they parse it
    // on their server), fall back to our own regex when they don't.
    const messages = (row.messages || row.mails || []).map((m) => {
      const body = m.body || m.html || "";
      const codes = (m.codes && m.codes.length) ? m.codes : extractCodes(`${m.subject || ""}\n${body}`);
      return {
        id: m.id || m.uid || m.messageId,
        subject: m.subject || m.title || "(no subject)",
        from: {
          emailAddress: {
            address:
              m.from ||
              m.sender ||
              (m.fromAddress && m.fromAddress.address) ||
              "(unknown)",
          },
        },
        receivedDateTime: m.date || m.receivedDateTime || m.received || null,
        bodyPreview: m.preview || m.bodyPreview || m.snippet || body.slice(0, 200),
        body,
        isRead: m.seen !== undefined ? !!m.seen : m.isRead !== false,
        codes,
      };
    });
    res.json({ ok: true, via: "vendor", messages });
  } catch (err) {
    const detail = err.response?.data?.error || err.message || String(err);
    res.json({ ok: false, via: "vendor", error: detail });
  }
});

// Convenience API: "give me the most recent OTP code for this account".
// Default backend is vendor (works for vendor-shipped accounts even on dead
// tokens, since the vendor has its own fresh token cache). Falls back to
// direct Graph if vendor fails or ?via=graph is passed. Bots hit this.
//
//   POST /api/accounts/<email>/otp?via=vendor|graph&top=5
//   → { ok: true, code: "521839", from: "...", subject: "...", allCodes: [...], source: "vendor" }
//   → { ok: false, error: "no code found in last N messages", via: "vendor" }
app.post("/api/accounts/:email/otp", async (req, res) => {
  const acct = findAccount(req.params.email);
  if (!acct) return res.status(404).json({ ok: false, error: "unknown account" });
  if (req.query.for === "epic" && !Number.isFinite(Date.parse(req.query.since))) {
    return res.status(400).json({ ok: false, error: "Epic OTP requires a valid since timestamp" });
  }
  const top = Math.min(5, Math.max(1, Number(req.query.top) || 5));
  const preferred = (req.query.via || "vendor").toLowerCase();
  const tryBackends = preferred === "graph" ? ["graph", "vendor"] : ["vendor", "graph"];

  const errors = [];
  for (const via of tryBackends) {
    try {
      const path = via === "vendor" ? "/read-vendor" : "/read";
      // Self-request to re-use the normalization + extraction already done
      // in the main handlers. Keep the code paths single-source-of-truth.
      const { data } = await axios.post(
        `http://127.0.0.1:${PORT}/api/accounts/${encodeURIComponent(acct.email)}${path}?top=${top}`,
        {},
        { timeout: req.query.for === "epic" ? 10000 : 45000 },
      );
      if (!data.ok) { errors.push(`${via}: ${data.error}`); continue; }
      if (req.query.for === "epic") {
        const hit = findEpicOtp(data.messages || [], req.query.since);
        if (hit) return res.json({ ok: true, ...hit, source: via });
        errors.push(`${via}: no fresh Epic verification code`);
        continue;
      }
      // Walk messages (newest first) and return the first that carries a code.
      for (const m of data.messages || []) {
        if (m.codes && m.codes.length) {
          return res.json({
            ok: true,
            code: m.codes[0],
            allCodes: m.codes,
            from: (m.from && m.from.emailAddress && m.from.emailAddress.address) || "",
            subject: m.subject,
            receivedDateTime: m.receivedDateTime,
            source: via,
          });
        }
      }
      errors.push(`${via}: no code in last ${(data.messages || []).length} messages`);
    } catch (err) {
      errors.push(`${via}: ${err.message || err}`);
    }
  }
  res.json({ ok: false, error: errors.join(" | ") });
});

app.listen(PORT, "127.0.0.1", () => {
  const n = readAccounts().length;
  console.log(
    `\n  Outlook Fleet dashboard  →  http://localhost:${PORT}\n` +
      `  accounts in outlooks.txt: ${n}\n`,
  );
});
