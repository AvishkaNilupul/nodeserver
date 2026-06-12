const express = require("express");

const router = express.Router();

const {
  loadInventory,
  addInventory,
  setUsed,
  deleteInventory,
} = require("../utils/inventory");

// GET ALL
router.get("/inventory/list", async (req, res) => {
  try {
    res.json(await loadInventory());
  } catch (err) {
    console.error("inventory/list error:", err.message);
    res.status(500).json({ success: false });
  }
});

// ADD ACCOUNT
router.post("/inventory/add", async (req, res) => {
  try {
    const { category, username, password } = req.body;
    await addInventory(category, username, password);
    res.json({ success: true });
  } catch (err) {
    console.error("inventory/add error:", err.message);
    res.status(500).json({ success: false });
  }
});

// MARK USED
router.post("/inventory/mark-used/:id", async (req, res) => {
  try {
    const item = await setUsed(req.params.id, true);
    if (!item) {
      return res.status(404).json({ success: false });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("inventory/mark-used error:", err.message);
    res.status(500).json({ success: false });
  }
});

// MARK UNUSED
router.post("/inventory/mark-unused/:id", async (req, res) => {
  try {
    const item = await setUsed(req.params.id, false);
    if (!item) {
      return res.status(404).json({ success: false });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("inventory/mark-unused error:", err.message);
    res.status(500).json({ success: false });
  }
});

// DELETE ACCOUNT
router.delete("/inventory/delete/:id", async (req, res) => {
  try {
    await deleteInventory(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error("inventory/delete error:", err.message);
    res.status(500).json({ success: false });
  }
});

module.exports = router;