const express = require("express");

const router = express.Router();

const {
  getOrdersBySeller,
  getAllOrders,
  addOrder,
  deleteOrder,
  deleteAnyOrder,
} = require("../utils/orderIds");

// GET ALL — a superadmin sees every seller's orders; a regular seller sees
// only their own.
router.get("/orders/list", async (req, res) => {
  try {
    const admin = req.session.admin;
    const orders =
      admin.role === "superadmin"
        ? await getAllOrders()
        : await getOrdersBySeller(admin.id);
    res.json(orders);
  } catch (err) {
    console.error("orders/list error:", err.message);
    res.status(500).json({ success: false });
  }
});

// ADD ORDER
router.post("/orders/add", async (req, res) => {
  try {
    const { orderId, username, password, accounts } = req.body;

    if (!orderId) {
      return res.status(400).json({ success: false });
    }

    // Optional list of accounts for multi-account orders (a buyer purchasing
    // 2+ at once). Falls back to the legacy single username/password pair.
    const accountList = Array.isArray(accounts)
      ? accounts
          .slice(0, 20)
          .map((a) => ({
            username: String((a && a.username) || "").trim(),
            password: String((a && a.password) || "").trim(),
          }))
          .filter((a) => a.username || a.password)
      : [];

    await addOrder({
      sellerId: req.session.admin.id,
      sellerName: req.session.admin.username,
      orderId: String(orderId).trim(),
      username: String(username || "").trim(),
      password: String(password || "").trim(),
      accounts: accountList,
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
    const admin = req.session.admin;
    if (admin.role === "superadmin") {
      await deleteAnyOrder(req.params.id);
    } else {
      await deleteOrder(req.params.id, admin.id);
    }
    res.json({ success: true });
  } catch (err) {
    console.error("orders/delete error:", err.message);
    res.status(500).json({ success: false });
  }
});

module.exports = router;