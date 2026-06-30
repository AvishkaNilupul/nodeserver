const validator = require("validator");

const Order = require("../models/Order");

function getOrderByOrderId(orderId) {
  return Order.findOne({ orderId });
}

// Build the stable per-order chat identity. The gamertag is already escaped by
// the caller (server-side, before the order is stored); the order id is escaped
// here so the composite is safe to render in the admin inbox. Because this is
// the single source of the format, the value stays consistent everywhere.
function buildChatId(gamerTag, orderId) {
  const tag = String(gamerTag || "").trim();
  const id = validator.escape(String(orderId || "")).trim();
  return `${tag} #${id}`;
}

// Look up an order by its chat identity (used to authorize an admin reply into
// a specific buyer's thread). Scoped to the seller when provided.
function getOrderByChatId(chatId, sellerId) {
  const query = sellerId ? { chatId, sellerId } : { chatId };
  return Order.findOne(query);
}

// Authorize a buyer for out-of-socket actions (e.g. image upload) by order id +
// chat token. The order id identifies the exact purchase (so a reused gamertag
// can't resolve to the wrong order); the token must match the one bound at
// claim time.
async function authorizeBuyerByOrder(orderId, token) {
  if (!orderId) return null;
  const order = await Order.findOne({ orderId: String(orderId).trim() });
  if (!order) return null;

  if (order.chatToken) {
    if (!token || token !== order.chatToken) return null;
  } else if (token) {
    order.chatToken = token;
    await order.save();
  }
  return order;
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
  getOrderByChatId,
  buildChatId,
  authorizeBuyer,
  authorizeBuyerByOrder,
  getOrdersBySeller,
  addOrder,
  deleteOrder,
};
