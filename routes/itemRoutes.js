const express = require("express");

const router = express.Router();

const validator = require("validator");

const {
  loadItems,
  addItem,
  deleteItem,
  getNextItem,
} = require("../utils/items");

// GET ALL
router.get("/items/list", async (req, res) => {
  try {
    res.json(await loadItems());
  } catch (err) {
    console.error("items/list error:", err.message);
    res.status(500).json({ success: false });
  }
});

// ADD ITEM
router.post("/items/add", async (req, res) => {
  try {
    let { category, username, password, notes, value } = req.body;

    category = validator.escape(String(category || "")).trim();
    username = validator.escape(String(username || "")).trim();
    password = validator.escape(String(password || "")).trim();
    notes = validator.escape(String(notes || "")).trim();

    if (!category || !username || !password) {
      return res
        .status(400)
        .json({ success: false, message: "Missing fields" });
    }

    await addItem(category, username, password, notes, value);

    res.json({ success: true });
  } catch (err) {
    console.error("items/add error:", err.message);
    res.status(500).json({ success: false });
  }
});

// DELETE ITEM
router.delete("/items/delete/:id", async (req, res) => {
  try {
    await deleteItem(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error("items/delete error:", err.message);
    res.status(500).json({ success: false });
  }
});

// GET NEXT ITEM (atomically claims it)
router.get("/items/next/:category", async (req, res) => {
  try {
    const item = await getNextItem(req.params.category);

    if (!item) {
      return res
        .status(404)
        .json({ success: false, message: "No available items" });
    }

    res.json({ success: true, item });
  } catch (err) {
    console.error("items/next error:", err.message);
    res.status(500).json({ success: false });
  }
});

module.exports = router;