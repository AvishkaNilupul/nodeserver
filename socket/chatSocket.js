const validator = require("validator");

const { getOrderByGamerTag } = require("../utils/orderIds");
const {
  addMessage,
  userHasWelcome,
  getMessagesByUser,
  markSeen,
  conversationExists,
} = require("../utils/messages");
const { sendTelegram } = require("../utils/telegram");

const cooldowns = new Map();

function cleanUserId(value) {
  if (typeof value !== "string") return null;
  const userId = validator.escape(value.trim().slice(0, 50));
  return userId || null;
}

function chatSocket(io) {
  io.on("connection", (socket) => {
    const session = socket.request.session;
    const admin = session?.admin || null;

    socket.data.isAdmin = !!admin;
    socket.data.isSuper = admin?.role === "superadmin";

    // All authenticated admins share one support inbox: they see every
    // buyer conversation, regardless of which admin created the order. So
    // every admin joins a single shared `admins` room that buyer/admin chat
    // events are delivered to. (Buyers never join this room, so they still
    // can't see each other's messages.)
    if (admin) {
      socket.data.sellerId = admin.id;
      socket.join("admins");
    }

    // Lets the admin page confirm its socket is still authenticated after a
    // reconnect. If the session was lost (e.g. server restart on the old
    // in-memory store) the page can prompt a re-login instead of silently
    // failing to send.
    socket.on("admin-check", () => {
      socket.emit("admin-auth", { isAdmin: !!socket.data.isAdmin });
    });

    // =========================
    // Join User (buyer)
    // =========================
    socket.on("join-user", async (payload) => {
      try {
        const rawUserId =
          typeof payload === "string" ? payload : payload?.userId;
        const token =
          typeof payload === "object" && payload ? payload.token : null;

        const userId = cleanUserId(rawUserId);
        if (!userId) return;

        const order = await getOrderByGamerTag(userId);
        if (!order) return;

        // Buyer auth. Once a token is bound to the order it is required and
        // must match — a gamertag alone is no longer enough to read or post as
        // that buyer. Until a token is bound the first one presented is bound
        // (first-come), so the normal buyer flow keeps working.
        if (order.chatToken) {
          if (token !== order.chatToken) {
            return;
          }
        } else if (token) {
          order.chatToken = token;
          await order.save();
        }

        socket.data.userId = userId;
        socket.data.sellerId = order.sellerId;
        socket.join(userId);

        const hasWelcome = await userHasWelcome(order.sellerId, userId);

        if (!hasWelcome && order.used && order.username && order.password) {
          await addMessage(
            userId,
            order.sellerId,
            "admin",
            `📋TWITCH DROP GUIDE

🔑Login

User: ${order.username}
Pass: ${order.password}

1. Log in → https://www.twitch.tv/drops/inventory

Scroll down to the "Received" section.

2. Press the purple "Connect" button below your item.

3. Follow the connection instructions shown on the linked site.

4. Some games require extra steps.

Rust:
• Activate Drops
• Check for missing drops`
          );

          await addMessage(
            userId,
            order.sellerId,
            "admin",
            "If you have any issue please text here. Admin will help you."
          );
        }

        const userMessages = await getMessagesByUser(order.sellerId, userId);
        socket.emit("chat-history", userMessages);
      } catch (err) {
        console.error("join-user error:", err.message);
      }
    });

    // =========================
    // User Message
    // =========================
    socket.on("user-message", async (data) => {
      try {
        const userId = socket.data.userId;
        const sellerId = socket.data.sellerId;

        // Only an authenticated (joined) buyer can post.
        if (!userId || !sellerId || socket.data.isAdmin) return;
        if (!data || typeof data.message !== "string") return;

        const message = String(data.message).trim().slice(0, 1000);
        if (!message) return;

        const now = Date.now();
        const last = cooldowns.get(socket.id);
        if (last && now - last < 1000) return;
        cooldowns.set(socket.id, now);

        await addMessage(userId, sellerId, "user", message);

        await sendTelegram(
          `💬NEW CHAT MESSAGE

👤User:
${userId}

📝Message:
${message}

Time:
${new Date().toISOString()}`
        );

        // Notify every admin (shared inbox) so whoever is online sees it.
        io.to("admins").emit("new-message", {
          userId,
          sellerId,
          sender: "user",
          message,
        });
      } catch (err) {
        console.error("user-message error:", err.message);
      }
    });

    // =========================
    // Admin Message
    // =========================
    socket.on("admin-message", async (data) => {
      try {
        if (!socket.data.isAdmin) {
          socket.emit("admin-auth", { isAdmin: false });
          return;
        }
        // A superadmin may reply into any seller's conversation by naming the
        // target seller; a normal admin is always pinned to their own seller.
        let sellerId = socket.data.sellerId;
        if (
          socket.data.isSuper &&
          typeof data?.sellerId === "string" &&
          data.sellerId
        ) {
          sellerId = data.sellerId;
        }
        if (!data || typeof data.userId !== "string") return;
        if (typeof data.message !== "string") return;

        const userId = cleanUserId(data.userId);
        const message = String(data.message).trim().slice(0, 1000);
        if (!userId || !message) return;

        // The admin may only message buyers that belong to them. A buyer
        // belongs to the seller if there is a live order tagged with this
        // sellerId, OR an existing conversation under this sellerId (so
        // replies to older chats keep working even after the order is gone).
        // The order lookup is scoped to the seller so a gamertag reused across
        // sellers can't resolve to another seller's order.
        const order = await getOrderByGamerTag(userId, sellerId);
        if (!order && !(await conversationExists(sellerId, userId))) {
          return;
        }

        const key = `admin-${socket.id}`;
        const now = Date.now();
        const last = cooldowns.get(key);
        if (last && now - last < 300) return;
        cooldowns.set(key, now);

        await addMessage(userId, sellerId, "admin", message);

        io.to(userId).emit("admin-reply", { message });
        // Echo to every admin's panel so other logged-in admins see the reply.
        io.to("admins").emit("new-message", {
          userId,
          sellerId,
          sender: "admin",
          message,
        });
      } catch (err) {
        console.error("admin-message error:", err.message);
      }
    });

    // =========================
    // Typing Indicators
    // =========================
    socket.on("admin-typing", (userId) => {
      if (!socket.data.isAdmin) return;
      const id = cleanUserId(userId);
      if (id) io.to(id).emit("support-typing");
    });

    socket.on("admin-stop-typing", (userId) => {
      if (!socket.data.isAdmin) return;
      const id = cleanUserId(userId);
      if (id) io.to(id).emit("support-stop-typing");
    });

    socket.on("user-typing", () => {
      const { userId, sellerId } = socket.data;
      if (!userId || !sellerId || socket.data.isAdmin) return;
      io.to("admins").emit("user-typing", userId);
    });

    socket.on("user-stop-typing", () => {
      const { userId, sellerId } = socket.data;
      if (!userId || !sellerId || socket.data.isAdmin) return;
      io.to("admins").emit("user-stop-typing", userId);
    });

    // =========================
    // Message Seen (buyer viewed admin messages)
    // =========================
    socket.on("message-seen", async () => {
      try {
        const { userId, sellerId } = socket.data;
        if (!userId || !sellerId || socket.data.isAdmin) return;

        await markSeen(sellerId, userId);
        io.to("admins").emit("message-seen", userId);
      } catch (err) {
        console.error("message-seen error:", err.message);
      }
    });

    // =========================
    // Disconnect
    // =========================
    socket.on("disconnect", () => {
      cooldowns.delete(socket.id);
      cooldowns.delete(`admin-${socket.id}`);
    });
  });
}

module.exports = chatSocket;
