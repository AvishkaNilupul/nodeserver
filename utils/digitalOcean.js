// DigitalOcean droplet creator — Node port of the standalone twitch-dupe tool
// (was FastAPI web/app.py + deploy.sh). It lets the admin panel:
//   - create a fresh droplet whose cloud-init auto-installs the twitch claim bot
//   - watch the deploy progress live (5 phases)
//   - list droplets on the DO account, and destroy any of them
//
// All state lives on DigitalOcean — there is no local DB. The one thing the
// original tool needs that must NOT live in this repo is the claim bot's source
// (bot.py carries live Telegram + account-API secrets). We mirror the Python:
// the bot script is read from an absolute path on disk at create time and
// base64-embedded into the cloud-init user-data. The repo only ever references
// the PATH (config.DIGITALOCEAN.botScriptPath), never the bytes.
//
// The API token gates everything and is optional: when it is unset the whole
// feature reports "not configured" rather than throwing on boot, matching the
// ACCOUNT_API_TOKEN / AI blocks in config/config.js.

const fs = require("fs");
const net = require("net");
const { execFile } = require("child_process");
const axios = require("axios");

const config = require("../config/config");

const DO_API = "https://api.digitalocean.com/v2";

// Every droplet this tool makes is stamped with this tag so `list` and the DO
// dashboard can tell them apart from anything else on the account.
const DROPLET_TAG = "twitch-dupe";

function cfg() {
  return config.DIGITALOCEAN || {};
}

function isConfigured() {
  return Boolean(cfg().token);
}

class DoError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "DoError";
    this.status = status || 500;
  }
}

// ── HTTP layer ─────────────────────────────────────────────────────────────
// A single choke-point so tests can swap the network out with
// __setRequestForTests(). Returns { status, data } and NEVER throws on a 4xx/5xx
// (callers decide) — mirroring the python's validate-status-ourselves style.
async function defaultRequest(method, apiPath, { body } = {}) {
  const token = cfg().token;
  if (!token) {
    const e = new DoError("DigitalOcean API token not configured", 503);
    e.code = "NOT_CONFIGURED";
    throw e;
  }
  const res = await axios.request({
    method,
    url: `${DO_API}${apiPath}`,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    data: body,
    timeout: 30000,
    // We inspect status codes by hand (the DELETE path treats 404 as success),
    // so never let axios throw on a non-2xx.
    validateStatus: () => true,
  });
  return { status: res.status, data: res.data };
}

let _request = defaultRequest;
function __setRequestForTests(fn) {
  _request = fn || defaultRequest;
}

// GET/POST helper: throw on >= 400 with a trimmed body, like the python _do().
async function apiOk(method, apiPath, body) {
  const { status, data } = await _request(method, apiPath, { body });
  if (status >= 400) {
    const detail =
      typeof data === "string" ? data : JSON.stringify(data || {});
    throw new DoError(
      `DigitalOcean ${method} ${apiPath} → HTTP ${status}: ${detail.slice(0, 500)}`,
      status,
    );
  }
  return data || {};
}

// ── cloud-init ───────────────────────────────────────────────────────────
// Read the claim bot's source and base64 it so arbitrary bytes survive JSON
// encoding to the DO API. `p` is overridable for tests; production reads the
// configured path. Throws an actionable error when the path is unset/unreadable
// so the operator sees "set DO_BOT_SCRIPT_PATH" instead of a broken box.
function readBotScriptBase64(p = cfg().botScriptPath) {
  if (!p) {
    throw new DoError(
      "Bot deploy requested but no bot script is configured. Set " +
        "DO_BOT_SCRIPT_PATH to the absolute path of bot.py on this host " +
        "(or create with deployBot=false for a bare droplet).",
      400,
    );
  }
  let bytes;
  try {
    bytes = fs.readFileSync(p);
  } catch (err) {
    throw new DoError(
      `Cannot read bot script at ${p}: ${err.message}. Fix ` +
        "DO_BOT_SCRIPT_PATH or create with deployBot=false.",
      400,
    );
  }
  if (!bytes.length) {
    throw new DoError(`Bot script at ${p} is empty.`, 400);
  }
  return bytes.toString("base64");
}

// Assemble the first-boot bash script. When `botB64` is given, the box installs
// node/pm2/venv, drops the decoded bot.py and runs it under pm2 (the faithful
// port). When it is null, the box just marks cloud-init done — a bare Ubuntu
// droplet with nothing extra installed.
function buildUserData(botB64) {
  const head = `#!/bin/bash
set -eux
export DEBIAN_FRONTEND=noninteractive
exec > >(tee -a /var/log/twitch-deploy.log) 2>&1
echo "== twitch-claim cloud-init boot: $(date -u) =="
`;

  if (!botB64) {
    // Bare box: no bot, just the sentinel so the "cloud-init done" phase lights.
    return `${head}
apt-get update -qq
touch /root/twitch-deploy-DONE
echo "== bare droplet ready (no bot deployed): $(date -u) =="
`;
  }

  return `${head}
apt-get update -qq
apt-get install -y -qq python3-venv python3-pip curl
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y -qq nodejs
npm install -g pm2

mkdir -p /opt/twitch-claim-bot
cd /opt/twitch-claim-bot

cat > bot.py.b64 <<'B64EOF'
${botB64}
B64EOF
base64 -d bot.py.b64 > bot.py && rm bot.py.b64

cat > start.sh <<'STARTEOF'
#!/bin/bash
cd /opt/twitch-claim-bot
source venv/bin/activate
exec python3 bot.py
STARTEOF
chmod +x start.sh

python3 -m venv venv
source venv/bin/activate
pip install --quiet --upgrade pip
pip install --quiet 'python-telegram-bot' 'httpx[http2]'

pm2 start ./start.sh --name twitch-claim --time
pm2 save
pm2 startup systemd -u root --hp /root | tail -1 | bash || true

touch /root/twitch-deploy-DONE
echo "== twitch-claim deploy finished: $(date -u) =="
`;
}

// ── pure helpers ───────────────────────────────────────────────────────────
function publicIp(droplet) {
  const v4 = ((droplet || {}).networks || {}).v4 || [];
  for (const n of v4) {
    if (n && n.type === "public") return n.ip_address || null;
  }
  return null;
}

function mapDroplet(d) {
  return {
    id: d.id,
    name: d.name,
    status: d.status,
    region: (d.region || {}).slug,
    size: d.size_slug,
    ip: publicIp(d),
    created_at: d.created_at,
    tags: d.tags || [],
  };
}

// ── network probes (best effort) ────────────────────────────────────────────
// Both silently report "not reachable" on any failure. On a host without the DO
// private key (e.g. prod that only has the API token) the SSH-backed phases
// simply never light — exactly how the python behaves when SSH is unavailable.
function tcpOpen(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (!host) return resolve(false);
    const sock = new net.Socket();
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(val);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    sock.connect(port, host);
  });
}

function sshProbe(ip, cmd, timeoutSec = 10) {
  return new Promise((resolve) => {
    const keyPath = cfg().sshKeyPath;
    if (!ip || !keyPath || !fs.existsSync(keyPath)) {
      return resolve({ ok: false, out: "" });
    }
    const args = [
      "-i",
      keyPath,
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      `ConnectTimeout=${timeoutSec}`,
      "-o",
      "BatchMode=yes",
      "-o",
      "LogLevel=ERROR",
      `root@${ip}`,
      cmd,
    ];
    const child = execFile(
      "ssh",
      args,
      { timeout: (timeoutSec + 5) * 1000, maxBuffer: 1 << 20 },
      (err, stdout) => {
        resolve({ ok: !err, out: (stdout || "").toString().trim() });
      },
    );
    child.on("error", () => resolve({ ok: false, out: "" }));
  });
}

// ── high-level API ───────────────────────────────────────────────────────
async function getAccount() {
  const acct = (await apiOk("GET", "/account")).account || {};
  let balance = {};
  try {
    balance = await apiOk("GET", "/customers/my/balance");
  } catch {
    // Balance is a nice-to-have; a token without billing scope shouldn't blank
    // the whole header.
    balance = {};
  }
  return {
    email: acct.email,
    droplet_limit: acct.droplet_limit,
    status: acct.status,
    balance,
  };
}

async function listDroplets() {
  const data = await apiOk("GET", "/droplets?per_page=100");
  const out = (data.droplets || []).map(mapDroplet);
  out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return out;
}

async function createDroplet(payload = {}) {
  const c = cfg();
  const stamp = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const defaultName =
    `twitch-dupe-${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-` +
    `${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;

  const deployBot = payload.deployBot !== false; // default: deploy the bot
  const botB64 = deployBot ? readBotScriptBase64() : null;

  const body = {
    name: payload.name || defaultName,
    region: payload.region || c.defaultRegion || "nyc1",
    size: payload.size || c.defaultSize || "s-2vcpu-4gb",
    image: payload.image || c.defaultImage || "ubuntu-24-04-x64",
    ssh_keys: c.sshKeyId ? [Number(c.sshKeyId)] : [],
    backups: false,
    ipv6: false,
    monitoring: true,
    tags: [DROPLET_TAG],
    user_data: buildUserData(botB64),
  };

  const data = await apiOk("POST", "/droplets", body);
  const d = data.droplet || {};
  return { id: d.id, name: d.name, deployedBot: deployBot };
}

async function destroyDroplet(id) {
  // DELETE tolerates 404 (already gone) — everything else >= 400 is an error.
  const { status, data } = await _request("DELETE", `/droplets/${id}`, {});
  if (status !== 204 && status !== 404 && status >= 400) {
    const detail =
      typeof data === "string" ? data : JSON.stringify(data || {});
    throw new DoError(
      `Destroy droplet ${id} failed → HTTP ${status}: ${detail.slice(0, 200)}`,
      status,
    );
  }
  return { ok: true, statusCode: status };
}

async function deployStatus(id) {
  const data = await apiOk("GET", `/droplets/${id}`);
  const d = data.droplet || {};
  const ip = publicIp(d);

  const phases = {
    created: d.status === "active",
    ip_assigned: Boolean(ip),
    ssh_reachable: false,
    cloud_init_done: false,
    bot_polling: false,
  };

  if (ip) {
    phases.ssh_reachable = await tcpOpen(ip, 22, 2000);
  }

  if (phases.ssh_reachable) {
    // One SSH round-trip gets both remaining phases.
    const { ok, out } = await sshProbe(
      ip,
      "test -f /root/twitch-deploy-DONE && echo DONE || echo PENDING ; " +
        "pm2 describe twitch-claim 2>/dev/null | grep -c 'status.*online' || echo 0",
      8,
    );
    if (ok && out) {
      const lines = out.split("\n");
      if (lines[0] && lines[0].trim() === "DONE") {
        phases.cloud_init_done = true;
      }
      const last = (lines[lines.length - 1] || "").trim();
      if (/^\d+$/.test(last) && Number(last) > 0) {
        phases.bot_polling = true;
      }
    }
  }

  return {
    droplet: {
      id: d.id,
      name: d.name,
      status: d.status,
      ip,
      created_at: d.created_at,
      region: (d.region || {}).slug,
      size: d.size_slug,
    },
    phases,
    all_ready: Object.values(phases).every(Boolean),
  };
}

module.exports = {
  isConfigured,
  getAccount,
  listDroplets,
  createDroplet,
  destroyDroplet,
  deployStatus,
  DoError,
  DROPLET_TAG,
  // exported for tests
  buildUserData,
  readBotScriptBase64,
  mapDroplet,
  publicIp,
  __setRequestForTests,
};
