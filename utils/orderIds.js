const Order = require("../models/Order");

function getOrderByOrderId(orderId) {
  return Order.findOne({ orderId });
}

function getOrderByGamerTag(gamerTag) {
  return Order.findOne({ gamerTag });
}

async function getOrdersBySeller(sellerId) {
  const orders = await Order.find({ sellerId }).sort({ createdAt: -1 }).lean();
  return orders.map(({ _id, ...rest }) => ({ id: _id.toString(), ...rest }));
}

function addOrder({ sellerId, sellerName, orderId, username, password }) {
  return Order.create({
    sellerId,
    sellerName,
    orderId,
    username,
    password,
    used: false,
    gamerTag: null,
    usedAt: null,
  });
}

function deleteOrder(id, sellerId) {
  return Order.deleteOne({ _id: id, sellerId });
}

module.exports = {
  getOrderByOrderId,
  getOrderByGamerTag,
  getOrdersBySeller,
  addOrder,
  deleteOrder,
};