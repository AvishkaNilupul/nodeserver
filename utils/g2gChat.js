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
    return {
      buyerId: buyer,
      channelUrl: channel.url,
      messageId: sent && sent.messageId,
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
  sendToBuyer,
};
