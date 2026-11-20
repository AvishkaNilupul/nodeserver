const router = require("express").Router();
const farm = require("../utils/twitchRewardFarm");
router.use((req, res, next) => {
  if (!req.path.startsWith("/farm")) return next();
  if (!req.session?.admin?.id) return res.status(401).json({ message: "Sign in again." });
  next();
});
router.get("/farm", async (req, res) => res.json(await farm.status(String(req.session.admin.id))));
router.post("/farm", async (req, res) => {
  const count = req.body?.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 20)
    return res.status(400).json({ message: "Choose 1–20 accounts per bot." });
  try { res.status(201).json({ id: await farm.create(String(req.session.admin.id), { count }) }); }
  catch (e) { res.status(409).json({ message: e.message }); }
});
router.post("/farm/:id/:action", async (req, res) => {
  if (!/^[a-f0-9]{24}$/.test(req.params.id) || !["start", "stop"].includes(req.params.action))
    return res.status(400).json({ message: "Choose a reward bot and action." });
  try {
    await farm.action(String(req.session.admin.id), req.params.id, req.params.action);
    res.json({ ok: true });
  } catch (e) { res.status(409).json({ message: e.message }); }
});
farm.start();
module.exports = router;
