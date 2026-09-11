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

// Which of our channels is the private DM with this buyer? Returns null when
// there is none yet.
//
// Only a 2-member `dm` channel whose members are us and the buyer ever
// qualifies. Our seller account is also a member of G2G's seller SUPERGROUPS
// (`g2g_sg_seller_game_items-2`, ~10,000 members), and a "channels that include
// the buyer" query is not guaranteed to leave those out — taking `channels[0]`
// blindly could post a credential to ten thousand strangers.
function dmUrls(sellerId, buyerId) {
  const me = String(sellerId);
  const them = String(buyerId);
  return ["g2g_dm_" + me + "_" + them, "g2g_dm_" + them + "_" + me];
}

function pickDmChannel(channels, sellerId, buyerId) {
  const me = String(sellerId || "");
  const them = String(buyerId || "");
  if (!me || !them) return null;
  const canonical = dmUrls(me, them);
  const ok = (channels || []).filter((c) => {
    if (!c || c.isSuper || c.isBroadcast) return false;
    if (String(c.customType || "") !== "dm") return false;
    if (Number(c.memberCount) !== 2) return false;
    const ids = Array.isArray(c.members)
      ? c.members.map((m) => String((m && m.userId) || "")).filter(Boolean)
      : [];
    // No member list to check: trust only G2G's own DM url shape.
    if (!ids.length) return canonical.includes(String(c.url || ""));
    return ids.includes(me) && ids.includes(them);
  });
  return ok.find((c) => canonical.includes(String(c.url || ""))) || ok[0] || null;
}

// Send and WAIT until SendBird has the message.
//
// `sendUserMessage` does not return a promise. In @sendbird/chat v4 it returns
// a MessageRequestHandler (onPending / onFailed / onSucceeded only), so
// `await channel.sendUserMessage(...)` came straight back with the handler
// before anything left the process — and the `finally` below then disconnected
// with the send still in flight. That, not chat moderation, is the likeliest
// reading of order 1788892037419NTQU's "accepted by the SDK, never in the
// channel": the owner has since confirmed with G2G support that chat hand-over
// is allowed for Twitch Drops.
const SEND_ACK_MS = 30000;

function sendAndWait(channel, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          "G2G chat: SendBird did not acknowledge the message within " +
            SEND_ACK_MS / 1000 + "s",
        ),
      );
    }, SEND_ACK_MS);
    try {
      channel
        .sendUserMessage(params)
        .onSucceeded((m) => {
          clearTimeout(timer);
          resolve(m);
        })
        .onFailed((err) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String((err && err.message) || err)));
        });
    } catch (e) {
      clearTimeout(timer);
      reject(e);
    }
  });
}

// Is OUR exact message already in the channel? A retry must not put the
// credential in front of the buyer twice: a send whose read-back failed may
// have landed after all, and both callers retry a "dropped" send on their next
// tick.
function ourMessageIn(messages, sellerId, body) {
  return (messages || []).some(
    (m) =>
      String((m && m.sender && m.sender.userId) || "") === String(sellerId) &&
      String((m && m.message) || "") === body,
  );
}

async function alreadyInChannel(channel, sellerId, body) {
  const recent = await channel
    .createPreviousMessageListQuery({ limit: 30, reverse: true })
    .load();
  return ourMessageIn(recent, sellerId, body);
}

// Messages SendBird acknowledged but that never showed up on read-back. Not
// sent again from this process: re-sending a credential into the same channel
// every 60s is worse than one human look. A restart allows one more try.
const droppedSends = new Set();

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
    // `includeEmpty` is load-bearing. SendBird's list query leaves out channels
    // with no messages by default, and a DM that exists but has never been
    // written in is exactly what a fresh order has. Order 1789095953271SGMG
    // (Sea of Thieves, $2.36) sat paid with `g2g_dm_5700688_1000423179` right
    // there, empty, while this reported "no existing conversation with buyer".
    // G2G's own chat client sets includeEmpty and filters by customType "dm" too.
    const query = sb.groupChannel.createMyGroupChannelListQuery({
      includeEmpty: true,
      customTypesFilter: ["dm"],
      userIdsFilter: { userIds: [buyer], includeMode: true, queryType: "OR" },
      limit: 20,
    });
    let channel = pickDmChannel(await query.next(), sellerId, buyer);
    if (!channel) {
      // No DM yet: open it the way G2G's own client does when the seller clicks
      // Chat on an order (see marketplaces.g2gOpenDmChannel), then re-check
      // that what came back really is a private 2-member DM before sending.
      const url = await mp.g2gOpenDmChannel(buyer);
      channel = pickDmChannel([await sb.groupChannel.getChannel(url)], sellerId, buyer);
      if (!channel) {
        throw new Error(
          "G2G chat: the channel G2G opened (" + url + ") is not a private DM " +
            "with buyer " + buyer + " — refusing to send a credential into it",
        );
      }
    }
    if (await alreadyInChannel(channel, sellerId, body).catch(() => false)) {
      return {
        buyerId: buyer,
        channelUrl: channel.url,
        messageId: null,
        confirmed: true,
        alreadySent: true,
        chars: body.length,
      };
    }
    const dropKey = channel.url + "\n" + body;
    if (droppedSends.has(dropKey)) {
      const e = new Error(
        "G2G chat: this exact message was acknowledged earlier but never " +
          "appeared in the channel — not sending it again; hand this order " +
          "over through the G2G order page.",
      );
      e.__g2gChatDropped = true;
      throw e;
    }
    const sent = await sendAndWait(channel, { message: body });

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
        // Fetch the exact channel we sent into, never "any channel with the
        // buyer in it".
        const vchannel = await verifier.groupChannel.getChannel(channel.url);
        if (vchannel) {
          const check = vchannel.createPreviousMessageListQuery({ limit: 10, reverse: true });
          confirmed = ourMessageIn(await check.load(), sellerId, body);
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
      droppedSends.add(dropKey);
      const e = new Error(
        "G2G chat: SendBird acknowledged the message but it is NOT in the " +
          "channel on read-back. Treat the buyer as NOT having it; hand this " +
          "order over through the G2G order page.",
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
  pickDmChannel,
  sendAndWait,
  sendToBuyer,
  __test: { ourMessageIn },
};
