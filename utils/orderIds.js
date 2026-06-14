const Order = require("../models/Order");

function getOrderByOrderId(orderId) {
  return Order.findOne({ orderId });
}

// When sellerId is provided the lookup is scoped to that seller, so a
// gamertag reused across two sellers' orders can't resolve to the wrong one.
function getOrderByGamerTag(gamerTag, sellerId) {
  const query = sellerId ? { gamerTag, sellerId } : { gamerTag };
  return Order.findOne(query);
}

// Authorize a buyer for out-of-socket actions (e.g. image upload). The buyer
// is identified by gamertag and must present the chat token bound to their
// order. If the order has no token bound yet, the first token seen is bound
// (mirrors the socket join handshake). Returns the order when allowed, else
// null.
async function authorizeBuyer(gamerTag, token) {
  if (!gamerTag) return null;
  const order = await Order.findOne({ gamerTag });
  if (!order) return null;

  if (order.chatToken) {
    if (!token || token !== order.chatToken) return null;
  } else if (token) {
    order.chatToken = token;
    await order.save();
  }
  return order;
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
  authorizeBuyer,
  getOrdersBySeller,
  addOrder,
  deleteOrder,
};
