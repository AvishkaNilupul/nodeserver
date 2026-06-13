# Marketplace tab — deploy steps

The marketplace runs as a **separate Python (FastAPI) process** bound to
`127.0.0.1:8001`. The Node admin panel reverse-proxies `/marketplace` to it,
behind the existing admin login. A **Marketplace** tab is shown to every admin
(normal + superadmin).

All paths below assume the repo lives at `/var/www/redeemer/nodeserver`.

## 1. Files to add / replace

New:
- `marketplace/` folder (main.py, funpay.py, markets.py, resale.py, index.html, requirements.txt)
- `public/marketplace.html`

Replace:
- `server.js`            (adds the `/marketplace` proxy + wrapper page route)
- `public/admin-nav.js`  (adds the Marketplace nav link for all admins)
- `package.json` + `package-lock.json` (adds the `http-proxy-middleware` dep)

(Also included: `routes/adminManageRoutes.js` and `routes/botConfigRoutes.js` —
the per-route guard fix for the redirect loop, in case you haven't applied it.)

## 2. Install the new Node dependency

```bash
cd /var/www/redeemer/nodeserver
npm install            # picks up http-proxy-middleware from package.json
```

## 3. Set up the Python sidecar

```bash
cd /var/www/redeemer/nodeserver/marketplace
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## 4. Run the sidecar under PM2 (127.0.0.1:8001)

```bash
cd /var/www/redeemer/nodeserver/marketplace
pm2 start main.py --name marketplace \
  --interpreter ./.venv/bin/python \
  --env MARKETPLACE_PORT=8001
pm2 save
```

Verify it's up locally:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8001/api/games   # -> 200
```

## 5. Restart the Node app

```bash
pm2 restart redeemer
pm2 save
```

## 6. Verify

- Log in, you should see a **Marketplace** tab in the left nav (both normal
  admins and the superadmin).
- It opens the storefront embedded under the admin sidebar.
- Direct/unauthenticated access to `https://redeemhub.lets.game/marketplace/`
  redirects to the login page (the app is never exposed on its own port).

## Optional config (env vars for the marketplace process)

Pass via `--env` on the `pm2 start` line, e.g. `--env MARKUP=2.00`:

| Variable           | Default     | Meaning                                  |
| ------------------ | ----------- | ---------------------------------------- |
| `MARKETPLACE_PORT` | `8001`      | Port the sidecar binds (localhost only)  |
| `MARKUP`           | `2.00`      | Amount added to every price              |
| `SITE_NAME`        | `Game Marketplace` | Store name shown in the UI        |

If you ever run the sidecar on a different host/port, set `MARKETPLACE_URL`
in the Node app's `.env` (e.g. `MARKETPLACE_URL=http://127.0.0.1:8001`).
