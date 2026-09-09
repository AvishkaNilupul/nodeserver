// G2G buyer<->seller chat.
//
// G2G's chat is SendBird (app id below, recovered from the chat SPA's own
// bundle), not a REST endpoint on sls.g2g.com. A SendBird session token is
// minted from the SAME G2G seller session we already hold — the operator does
// not paste a second credential:
//
//   POST sls.g2g.com/chat/user  {user_id}      (authorization: <access token>)
//     -> { payload: { session_tokens: [ { session_token, expires_at } ] } }
//
// SendBird's REST API will NOT accept that token: it wants a *session key*,
// which only the SDK's connect() handshake issues. Every header variant was
// tried and all four fail (Session-Key / Access-Token / Api-Token /
// Authorization -> 400 400303 or 400401). We deliberately do not hold a
// SendBird master Api-Token; that is an application-wide admin credential
// belonging to G2G, not to us.
//
// So sending requires the official `@sendbird/chat` SDK, which is an optional
// dependency here. When it is absent — or when sending is switched off — this
// module reports that plainly and the fulfiller falls back to handing the
// credential to the operator over Telegram instead of pretending it shipped.
//
// One nuance that matters for the message text: a SendBird channel is a
// buyer<->seller DM, ONE PER COUNTERPARTY, not one per order. A repeat buyer
// shares a single channel across all their orders, so every message must name
// the order it belongs to.
const mp = require("./marketplaces");

const G2G_SENDBIRD_APP_ID = "34201740-152E-401E-AD8F-5C72EEABA386";

// The SendBird SDK is a BROWSER library: it opens its realtime connection with
// a bare `new WebSocket(...)` off the global. Node only exposes a global
// WebSocket from v22, and prod runs v20 — so `connect()` died with
// "WebSocket is not defined" on every single delivery.
//
// That error is not the `__g2gChatUnavailable` case the fulfiller treats as
// "no SDK, hand it to the operator". It fell through to the generic branch and
// returned `chat send failed: WebSocket is not defined`, which is why G2G order
// 1788892037419NTQU (Rocket League, $2.18) sat reserved-but-unsent while the
// SDK sat installed and working. Automatic G2G delivery had therefore never
// worked once on this host.
//
// `ws` is already a dependency, so the fix is to hand the SDK the global it
// expects. Assigned only when missing, so a future Node upgrade that provides a
// native one silently takes over.
function ensureWebSocket() {
  if (typeof globalThis.WebSocket !== "undefined") return true;
  try {
    globalThis.WebSocket = require("ws");
    return true;
  } catch {
    return false;
  }
}

// Mint a SendBird session token for our own seller account.
async function chatSessionToken() {
  const sellerId = String(mp.g2gSellerId());
  const p = await mp.g2gChatProfile(sellerId);
  const tokens = (p && p.session_tokens) || [];
  const token = tokens[0] && tokens[0].session_token;
  if (!token) {
    throw new Error(
      "G2G chat: no session_token in the chat profile response — the seller " +
        "session may be stale",
    );
  }
  return { sellerId, token, expiresAt: tokens[0].expires_at || 0 };
}

// Is the SDK actually installed? Kept as a function rather than a constant so
// installing the dependency takes effect without a restart of this module's
// require cache being reasoned about.
function sdkAvailable() {
  try {
    require.resolve("@sendbird/chat");
    return true;
  } catch {
    return false;
  }
}

// Send `text` to the DM channel we share with `buyerId`. Throws — loudly and
// specifically — when it cannot, because a silent failure here means a buyer
// paid and received nothing.
async function sendToBuyer(buyerId, text, { dryRun } = {}) {
  const buyer = String(buyerId || "");
  if (!buyer) throw new Error("G2G chat: no buyer id");
  const body = String(text || "");
  if (!body.trim()) throw new Error("G2G chat: refusing to send an empty message");

  if (dryRun) {
    return { dryRun: true, buyerId: buyer, chars: body.length };
  }
  if (!sdkAvailable()) {
    const e = new Error(
      "G2G chat: @sendbird/chat is not installed, so the credential cannot be " +
        "sent automatically. Run `npm i @sendbird/chat` to enable it.",
    );
    e.__g2gChatUnavailable = true;
    throw e;
  }

  // Without a global WebSocket the SDK's connect() throws "WebSocket is not
  // defined" — a failure that reads like a network fault but is a missing
  // browser global. Flag it as unavailable so the fulfiller hands the credential
  // to the operator instead of recording a mystery send failure.
  if (!ensureWebSocket()) {
    const e = new Error(
      "G2G chat: no WebSocket implementation available (Node " +
        process.version +
        " has no global WebSocket and the `ws` package is missing), so the " +
        "SendBird SDK cannot connect. Run `npm i ws` to enable it.",
    );
    e.__g2gChatUnavailable = true;
    throw e;
  }

  const { default: SendbirdChat } = require("@sendbird/chat");
  const { GroupChannelModule } = require("@sendbird/chat/groupChannel");
  const { sellerId, token } = await chatSessionToken();

  const sb = SendbirdChat.init({
    appId: G2G_SENDBIRD_APP_ID,
    modules: [new GroupChannelModule()],
    localCacheEnabled: false,
  });
  try {
    await sb.connect(sellerId, token);
    const query = sb.groupChannel.createMyGroupChannelListQuery({
      userIdsFilter: { userIds: [buyer], includeMode: true, queryType: "OR" },
      limit: 20,
    });
    const channels = await query.next();
    const channel = (channels || [])[0];
    if (!channel) {
      throw new Error(
        "G2G chat: no existing conversation with buyer " + buyer +
          " — G2G opens the channel when the buyer first messages, so this " +
          "order needs a manual hand-over",
      );
    }
    const sent = await channel.sendUserMessage({ message: body });

    // sendUserMessage RESOLVING IS NOT PROOF THE BUYER GOT IT.
    //
    // On order 1788892037419NTQU it resolved cleanly and the message never
    // appeared in the channel — read back afterwards, the last four messages
    // were all from the buyer. G2G moderates this chat (its own banner says
    // "only deliver account or product information through the order page using
    // our secure system. Do not share sensitive details in chat"), so a
    // credential-shaped message can be accepted by the SDK and dropped server
    // side. The caller stamped `messagedAt` on that resolve and recorded a
    // delivery that had not happened, while the buyer sat asking "when its gonna
    // be done?".
    //
    // So: read the channel back and require OUR message to actually be in it.
    // A send we cannot see is reported as a failure, because for the buyer it is.
    const messageId = sent && sent.messageId;
    // The read-back MUST use a fresh connection. Querying the channel on the
    // instance that just sent returns the SDK's own optimistic echo, so the
    // check passed while the channel genuinely contained nothing from us — it
    // was verifying our own hopefulness. Measured twice on order
    // 1788892037419NTQU: confirmed=true, and a separate session still showed
    // "messages FROM US: 0".
    let confirmed = false;
    try {
      const verifier = SendbirdChat.init({
        appId: G2G_SENDBIRD_APP_ID,
        modules: [new GroupChannelModule()],
        localCacheEnabled: false,
      });
      try {
        const fresh = await chatSessionToken();
        await verifier.connect(fresh.sellerId, fresh.token);
        const vq = verifier.groupChannel.createMyGroupChannelListQuery({
          userIdsFilter: { userIds: [buyer], includeMode: true, queryType: "OR" },
          limit: 5,
        });
        const vchans = await vq.next();
        const vchannel = (vchans || []).find((c) => c.url === channel.url) || (vchans || [])[0];
        if (vchannel) {
          const check = vchannel.createPreviousMessageListQuery({ limit: 10, reverse: true });
          const recent = await check.load();
          confirmed = (recent || []).some(
            (m) =>
              String((m.sender && m.sender.userId) || "") === String(sellerId) &&
              String(m.message || "") === body,
          );
        }
      } finally {
        try {
          await verifier.disconnect();
        } catch {
          /* the verdict is already decided */
        }
      }
    } catch {
      // Could not read back: not proof of failure, but not proof of delivery
      // either, and only one of those is safe to assume.
      confirmed = false;
    }
    if (!confirmed) {
      const e = new Error(
        "G2G chat: the message was accepted by the SDK but is NOT in the " +
          "channel on read-back — G2G moderates credential-shaped messages in " +
          "chat. The buyer has NOT received it; hand this order over through " +
          "the G2G order page.",
      );
      e.__g2gChatDropped = true;
      throw e;
    }
    return {
      buyerId: buyer,
      channelUrl: channel.url,
      messageId,
      confirmed: true,
      chars: body.length,
    };
  } finally {
    try {
      await sb.disconnect();
    } catch {
      /* a failed disconnect must never mask a successful send */
    }
  }
}

module.exports = {
  G2G_SENDBIRD_APP_ID,
  chatSessionToken,
  sdkAvailable,
  ensureWebSocket,
  // "Can we actually send?" is the SDK *and* a WebSocket to run it over. The
  // SDK alone was true on this host while every send failed.
  canSend: () => sdkAvailable() && ensureWebSocket(),
  sendToBuyer,
};
