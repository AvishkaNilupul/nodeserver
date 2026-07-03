const {
  getOrderByOrderId,
  getOrderByChatId,
  buildChatId,
  orderAccounts,
} = require("../utils/orderIds");
const {
  addMessage,
  userHasWelcome,
  getMessagesByUser,
  markSeen,
  conversationExists,
} = require("../utils/messages");
const { sendTelegramToSeller } = require("../utils/telegram");

const cooldowns = new Map();

// A chat id ("<gamerTag> #<orderId>") is already sanitized when the order is
// claimed, so it is only length-guarded here — re-escaping would corrupt the
// already-escaped value and break room/message matching.
function cleanChatId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim().slice(0, 120);
  return id || null;
}

function chatSocket(io) {
  // Deliver an event only to the admins who should see this seller's chat: the
  // seller's own sessions (room `seller:<id>`) and every superadmin (room
  // `supers`). Socket.IO de-duplicates a socket that is in both rooms.
  function emitToSeller(sellerId, event, payload) {
    io.to("seller:" + sellerId)
      .to("supers")
      .emit(event, payload);
  }

  io.on("connection", (socket) => {
    const session = socket.request.session;
    const admin = session?.admin || null;

    socket.data.isAdmin = !!admin;
    socket.data.isSuper = admin?.role === "superadmin";

    // Real-time chat events are scoped per seller so a normal admin only
    // receives messages for buyers that belong to them. Each admin joins their
    // own `seller:<id>` room; superadmins additionally join `supers` so they
    // still see every seller's chat. (Buyers never join these rooms.)
    if (admin) {
      socket.data.sellerId = admin.id;
      socket.join("seller:" + admin.id);
      if (socket.data.isSuper) socket.join("supers");
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
        // The buyer is identified by their order id (unique per purchase), so a
        // reused gamertag never resolves to the wrong order or shares a chat.
        const rawOrderId =
          typeof payload === "string" ? payload : payload?.orderId;
        const token =
          typeof payload === "object" && payload ? payload.token : null;

        const orderId =
          typeof rawOrderId === "string"
            ? rawOrderId.trim().slice(0, 100)
            : null;
        if (!orderId) return;

        const order = await getOrderByOrderId(orderId);
        if (!order) return;

        // Buyer auth. Once a token is bound to the order it is required and
        // must match — the order id alone is no longer enough to read or post
        // as that buyer. Until a token is bound the first one presented is
        // bound (first-come), so the normal buyer flow keeps working.
        if (order.chatToken) {
          if (token !== order.chatToken) {
            return;
          }
        } else if (token) {
          order.chatToken = token;
          await order.save();
        }

        // Canonical chat identity for this order. Backfilled for orders that
        // were claimed before the chatId field existed.
        let userId = order.chatId;
        if (!userId) {
          userId = buildChatId(order.gamerTag || "", order.orderId);
          order.chatId = userId;
          await order.save();
        }

        socket.data.userId = userId;
        socket.data.sellerId = order.sellerId;
        socket.join(userId);

        const hasWelcome = await userHasWelcome(order.sellerId, userId);

        const accounts = orderAccounts(order);
        if (!hasWelcome && order.used && accounts.length) {
          const loginBlock =
            accounts.length === 1
              ? `User: ${accounts[0].username}\nPass: ${accounts[0].password}`
              : accounts
                  .map(
                    (a, i) =>
                      `Account ${i + 1}\nUser: ${a.username}\nPass: ${a.password}`,
                  )
                  .join("\n\n");
          await addMessage(
            userId,
            order.sellerId,
            "admin",
            `📋TWITCH DROP GUIDE

🔑Login${accounts.length > 1 ? ` (${accounts.length} accounts)` : ""}

${loginBlock}

1. Log in → https://www.twitch.tv/drops/inventory

Scroll down to the "Received" section.

2. Press the purple "Connect" button below your item.

3. Follow the connection instructions shown on the linked site.

4. Some games require extra steps.

Rust:
• Activate Drops
• Check for missing drops`,
          );

          await addMessage(
            userId,
            order.sellerId,
            "admin",
            "If you have any issue please text here. Admin will help you.",
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

        // Fire-and-forget so the message broadcast isn't delayed by Telegram.
        sendTelegramToSeller(
          sellerId,
          `💬NEW CHAT MESSAGE

👤User:
${userId}

📝Message:
${message}

Time:
${new Date().toISOString()}`,
        ).catch((e) => console.error("telegram notify error:", e.message));

        // Notify only this seller's admins (and superadmins).
        emitToSeller(sellerId, "new-message", {
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

        const userId = cleanChatId(data.userId);
        const message = String(data.message).trim().slice(0, 1000);
        if (!userId || !message) return;

        // The admin may only message buyers that belong to them. A buyer
        // belongs to the seller if there is a live order with this chat id
        // under this sellerId, OR an existing conversation under this sellerId
        // (so replies to older chats keep working even after the order is
        // gone). The lookup is scoped to the seller so a chat id reused across
        // sellers can't resolve to another seller's order.
        const order = await getOrderByChatId(userId, sellerId);
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
        // Echo to this seller's admins (and superadmins) so other open panels
        // see the reply.
        emitToSeller(sellerId, "new-message", {
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
      const id = cleanChatId(userId);
      if (id) io.to(id).emit("support-typing");
    });

    socket.on("admin-stop-typing", (userId) => {
      if (!socket.data.isAdmin) return;
      const id = cleanChatId(userId);
      if (id) io.to(id).emit("support-stop-typing");
    });

    socket.on("user-typing", () => {
      const { userId, sellerId } = socket.data;
      if (!userId || !sellerId || socket.data.isAdmin) return;
      emitToSeller(sellerId, "user-typing", userId);
    });

    socket.on("user-stop-typing", () => {
      const { userId, sellerId } = socket.data;
      if (!userId || !sellerId || socket.data.isAdmin) return;
      emitToSeller(sellerId, "user-stop-typing", userId);
    });

    // =========================
    // Message Seen (buyer viewed admin messages)
    // =========================
    socket.on("message-seen", async () => {
      try {
        const { userId, sellerId } = socket.data;
        if (!userId || !sellerId || socket.data.isAdmin) return;

        await markSeen(sellerId, userId);
        emitToSeller(sellerId, "message-seen", userId);
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
