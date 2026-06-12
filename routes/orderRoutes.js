const express = require("express");

const router = express.Router();

const {
  getOrdersBySeller,
  addOrder,
  deleteOrder,
} = require("../utils/orderIds");

// GET ALL (scoped to the logged-in seller)
router.get("/orders/list", async (req, res) => {
  try {
    const orders = await getOrdersBySeller(req.session.admin.id);
    res.json(orders);
  } catch (err) {
    console.error("orders/list error:", err.message);
    res.status(500).json({ success: false });
  }
});

// ADD ORDER
router.post("/orders/add", async (req, res) => {
  try {
    const { orderId, username, password } = req.body;

    if (!orderId) {
      return res.status(400).json({ success: false });
    }

    await addOrder({
      sellerId: req.session.admin.id,
      sellerName: req.session.admin.username,
      orderId: String(orderId).trim(),
      username: String(username || "").trim(),
      password: String(password || "").trim(),
    });

    res.json({ success: true });
  } catch (err) {
    console.error("orders/add error:", err.message);
    res.status(500).json({ success: false });
  }
});

// DELETE (only the seller's own order)
router.delete("/orders/delete/:id", async (req, res) => {
  try {
    await deleteOrder(req.params.id, req.session.admin.id);
    res.json({ success: true });
  } catch (err) {
    console.error("orders/delete error:", err.message);
    res.status(500).json({ success: false });
  }
});

module.exports = router;