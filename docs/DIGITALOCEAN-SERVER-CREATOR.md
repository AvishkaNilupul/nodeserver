# DigitalOcean server creator

Admin-panel port of the standalone `twitch-dupe` tool (was FastAPI
`web/app.py` + `deploy.sh`). Lets a superadmin spin up a DigitalOcean droplet
whose cloud-init auto-installs the Twitch claim bot, watch the deploy progress
live, list every droplet on the account, and destroy any of them.

- **Page:** `/do-servers.html` (superadmin-only, behind 2FA)
- **API:** `/admin/do/*` — `routes/digitalOceanRoutes.js`
- **Logic:** `utils/digitalOcean.js`
- **Tests:** `tests/digitalOcean.test.js` (DO API mocked; never hits the network)

## Why superadmin

Creating and destroying droplets spends real money and is irreversible, so it
sits in the same tier as the Bots page (`requireSuperadmin`), not the ordinary
admin tier. Every route self-guards, and the page is served through a
`requireSuperadmin` route in `server.js`.

## Configuration (all via env, all optional)

`config.DIGITALOCEAN` reads these. When `DO_TOKEN` is empty the feature is
disabled: the page shows a "not configured" banner and the API returns 503.

| Env var              | Meaning                                                        | Default              |
| -------------------- | ------------------------------------------------------------- | -------------------- |
| `DO_TOKEN`           | DigitalOcean API token. Empty → feature off.                  | *(unset)*            |
| `DO_SSH_KEY_ID`      | SSH key id on the DO account; stamped on every new droplet.   | *(none — no key)*    |
| `DO_SSH_KEY_PATH`    | Local private key used ONLY for the deploy-progress SSH probe. | *(none — phases 3–5 stay dark)* |
| `DO_BOT_SCRIPT_PATH` | Absolute path to the claim bot's source on this host.         | *(none — see below)* |
| `DO_DEFAULT_REGION`  | Region when the request omits one.                            | `nyc1`               |
| `DO_DEFAULT_SIZE`    | Size when the request omits one.                              | `s-2vcpu-4gb`        |
| `DO_DEFAULT_IMAGE`   | Image when the request omits one.                             | `ubuntu-24-04-x64`   |

## Secrets: the bot script stays OUT of this repo

The original `bot.py` carries **live secrets** (a Telegram `BOT_TOKEN`, an
`OWNER_CHAT_ID`, and the `acct_…` account-API token). Per the project rule,
those must never be committed here.

So the port mirrors the Python exactly: at create time the server reads the bot
source from `DO_BOT_SCRIPT_PATH` (an absolute path **outside** this repo),
base64-embeds it into the cloud-init user-data, and ships it to DigitalOcean.
The repo only ever references the path, never the bytes. The server never logs
the user-data.

- **Deploy the bot** (default): the create call needs `DO_BOT_SCRIPT_PATH` set
  and readable, or it fails with an actionable error.
- **Bare droplet**: uncheck "deploy claim bot" in the UI (or send
  `deployBot:false`) to provision a plain Ubuntu box with no bot and no secrets.

## Deploy-progress phases

The status endpoint reports five phases. Phases 1–2 come from the DO API alone.
Phases 3–5 need to reach the box:

3. SSH port open — TCP probe from the server to `:22`.
4. Cloud-init done — SSH check for `/root/twitch-deploy-DONE`.
5. Bot online — SSH check that pm2 shows `twitch-claim` online.

Phases 3–5 only light when the server can SSH to the droplet, which needs
`DO_SSH_KEY_PATH` present on the host. On a box without the key (e.g. a prod
server that only holds the API token) the droplet still gets created and the bot
still deploys — the UI just won't tick phases 3–5. This matches the Python's
behaviour when SSH is unavailable.

## Production notes

- Set the `DO_*` env vars in the prod environment (they live in the gitignored
  `.env` locally; they are NOT in git).
- Put the bot source somewhere outside the repo on prod and point
  `DO_BOT_SCRIPT_PATH` at it, or leave it unset and create bare droplets.
- Files changed for this feature: `utils/digitalOcean.js`,
  `routes/digitalOceanRoutes.js`, `public/do-servers.html`,
  `config/config.js`, `server.js`.
