const Message = require("../models/Message");

function getMessagesBySeller(sellerId) {
  return Message.find({ sellerId }).sort({ createdAt: 1 }).lean();
}

function getMessagesByUser(sellerId, userId) {
  return Message.find({ sellerId, userId }).sort({ createdAt: 1 }).lean();
}

function userHasWelcome(sellerId, userId) {
  return Message.exists({
    sellerId,
    userId,
    sender: "admin",
    message: { $regex: "TWITCH DROP GUIDE" },
  });
}

function addMessage(userId, sellerId, sender, message) {
  return Message.create({
    userId,
    sellerId,
    sender,
    message,
    readByAdmin: sender === "admin",
    seen: false,
  });
}

function clearChat(sellerId, userId) {
  return Message.deleteMany({ sellerId, userId });
}

function markRead(sellerId, userId) {
  return Message.updateMany(
    { sellerId, userId, sender: "user" },
    { $set: { readByAdmin: true } }
  );
}

function markSeen(sellerId, userId) {
  return Message.updateMany(
    { sellerId, userId, sender: "admin" },
    { $set: { seen: true } }
  );
}

function getSellerUserIds(sellerId) {
  return Message.distinct("userId", { sellerId });
}

// True when an admin already has a conversation with this buyer, so replies to
// existing threads work even if the original order has since been removed.
function conversationExists(sellerId, userId) {
  return Message.exists({ sellerId, userId });
}

module.exports = {
  getMessagesBySeller,
  getMessagesByUser,
  userHasWelcome,
  addMessage,
  clearChat,
  markRead,
  markSeen,
  getSellerUserIds,
  conversationExists,
};