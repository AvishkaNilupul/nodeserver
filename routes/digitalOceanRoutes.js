// DigitalOcean droplet creator — admin API (Node port of twitch-dupe web/app.py).
// Backs public/do-servers.html. Every route is superadmin-only: creating and
// destroying droplets spends real money and is irreversible, so it sits in the
// same tier as the Bots infra page, not the ordinary-admin tier.
//
// server.js mounts this behind enforce2fa; each route also self-guards with
// requireSuperadmin so an early mount can never expose it.

const express = require("express");

const { requireSuperadmin } = require("../middleware/auth");
const digitalOcean = require("../utils/digitalOcean");

const router = express.Router();

const KNOWN_REGIONS = new Set([
  "nyc1",
  "nyc3",
  "sfo3",
  "atl1",
  "tor1",
  "ams3",
  "fra1",
  "lon1",
  "sgp1",
  "blr1",
  "syd1",
]);

function fail(res, err) {
  const status = err && err.status ? err.status : 400;
  return res
    .status(status)
    .json({ success: false, message: (err && err.message) || String(err) });
}

// GET /admin/do/health — the page pings this on load so the operator sees
// whether the token is configured before they try to create anything.
router.get("/admin/do/health", requireSuperadmin, (req, res) => {
  res.json({ success: true, configured: digitalOcean.isConfigured() });
});

// GET /admin/do/account — account email, droplet limit, balance for the header.
router.get("/admin/do/account", requireSuperadmin, async (req, res) => {
  try {
    const account = await digitalOcean.getAccount();
    res.json({ success: true, account });
  } catch (err) {
    fail(res, err);
  }
});

// GET /admin/do/droplets — every droplet on the account, newest first.
router.get("/admin/do/droplets", requireSuperadmin, async (req, res) => {
  try {
    const droplets = await digitalOcean.listDroplets();
    res.json({ success: true, droplets });
  } catch (err) {
    fail(res, err);
  }
});

// POST /admin/do/droplets — create + (by default) auto-deploy the claim bot.
router.post("/admin/do/droplets", requireSuperadmin, async (req, res) => {
  const body = req.body || {};
  const who = req.session?.admin?.username || "?";

  const region = String(body.region || "").trim();
  if (region && !KNOWN_REGIONS.has(region)) {
    return fail(res, { message: `unknown region '${region}'`, status: 400 });
  }
  const size = String(body.size || "").trim();
  const name = String(body.name || "").trim();
  const deployBot = body.deployBot !== false;

  try {
    const result = await digitalOcean.createDroplet({
      region: region || undefined,
      size: size || undefined,
      name: name || undefined,
      deployBot,
    });
    // Rare, money-spending, admin-triggered — always log (never the user_data,
    // which carries the bot's secrets).
    console.log(
      `[do] create id=${result.id} name=${result.name} ` +
        `region=${region || "default"} size=${size || "default"} ` +
        `bot=${deployBot} user=${who}`,
    );
    res.json({ success: true, ...result });
  } catch (err) {
    fail(res, err);
  }
});

// DELETE /admin/do/droplets/:id — destroy one droplet (irreversible).
router.delete("/admin/do/droplets/:id", requireSuperadmin, async (req, res) => {
  const id = String(req.params.id || "").trim();
  const who = req.session?.admin?.username || "?";
  if (!/^\d+$/.test(id)) return fail(res, { message: "bad droplet id", status: 400 });
  try {
    const out = await digitalOcean.destroyDroplet(id);
    console.log(`[do] destroy id=${id} http=${out.statusCode} user=${who}`);
    res.json({ success: true, ...out });
  } catch (err) {
    fail(res, err);
  }
});

// GET /admin/do/droplets/:id/status — compact packet for the deploy poll loop.
router.get(
  "/admin/do/droplets/:id/status",
  requireSuperadmin,
  async (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!/^\d+$/.test(id))
      return fail(res, { message: "bad droplet id", status: 400 });
    try {
      const status = await digitalOcean.deployStatus(id);
      res.json({ success: true, ...status });
    } catch (err) {
      fail(res, err);
    }
  },
);

module.exports = router;
