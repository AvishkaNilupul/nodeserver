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

// One row per buyer for the inbox list: last message + unread count, newest
// first. Computed in the DB so the admin page no longer downloads the entire
// message history just to render the conversation list.
async function getSellerConversations(sellerId) {
  const rows = await Message.aggregate([
    { $match: { sellerId } },
    { $sort: { createdAt: 1 } },
    {
      $group: {
        _id: "$userId",
        lastMessage: { $last: "$message" },
        lastSender: { $last: "$sender" },
        updatedAt: { $last: "$createdAt" },
        unread: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ["$sender", "user"] },
                  { $eq: ["$readByAdmin", false] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
    { $sort: { updatedAt: -1 } },
  ]);

  return rows.map((r) => ({
    userId: r._id,
    lastMessage: r.lastMessage,
    lastSender: r.lastSender,
    unread: r.unread,
    updatedAt: r.updatedAt,
  }));
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
  getSellerConversations,
};