// Buyer-facing copy for PlayerAuctions.
//
// PlayerAuctions caps an order message at 300 characters (50 for a brand-new
// member). Every other marketplace we deliver on takes a ~500-character
// hand-over, so the copy cannot simply be reused — the Eldorado text is 494
// characters and would be rejected outright.
//
// The split this module enforces:
//
//   offer.instruction  — the long claim guide. PlayerAuctions shows it to the
//                        buyer up front ("Provide instructions or details to
//                        your buyer in advance"), it has no length problem, and
//                        it renders on their own page so a URL in it is safe.
//   order message      — the credential and a one-line pointer. Nothing else
//                        fits, and splitting a credential across two messages
//                        races and risks a half-delivered order.
//
// Both builders below hard-guarantee the limit: they drop optional trailing
// sentences until the text fits, rather than truncating mid-credential.
const LIMIT = 300;

// Assemble `head` (never dropped) plus as many `tail` sentences as fit.
// Returns the longest result within `limit`.
function fit(head, tail, limit = LIMIT) {
  let out = head;
  for (const s of tail) {
    // The head often ends in a deliberate blank line; only join with a space
    // when it does not already end in whitespace.
    const next = /\s$/.test(out) ? out + s : out + " " + s;
    if (next.length > limit) break;
    out = next;
  }
  return out;
}

function credLine(a) {
  return a.login + " / " + a.password;
}

// Credentials block. One account gets labelled lines; several get a compact
// numbered list, because five labelled pairs alone would blow the budget.
function credBlock(accounts) {
  if (accounts.length === 1) {
    return "Login: " + accounts[0].login + "\nPassword: " + accounts[0].password;
  }
  return accounts.map((a, i) => i + 1 + ") " + credLine(a)).join("\n");
}

// --- Bundle orders ------------------------------------------------------
// The buyer bought an account that already holds the drops, unclaimed.
function bundleDeliveryMessage(accounts) {
  const list = Array.isArray(accounts) ? accounts : [accounts];
  const head =
    (list.length > 1 ? list.length + " accounts:\n" : "") + credBlock(list);
  return fit(head + "\n\n", [
    "Log in on Twitch, open Drops & Rewards > Inventory, and press Connect under each item to link it to your own game account.",
    "Full steps are in this offer's delivery instructions.",
    "Any problem, reply here first and I will make it right.",
  ]);
}

// --- Rent-farm orders ---------------------------------------------------
// The buyer bought a window of automated farming on an account we keep running.
// The game is accepted (and ignored) so this matches farmInstruction's shape —
// naming it would not fit in 300 characters alongside the credential.
function farmDeliveryMessage(accounts, days, _game) {
  const list = Array.isArray(accounts) ? accounts : [accounts];
  const term = days === 365 ? "1 year" : days + " days";
  const head =
    (list.length > 1 ? list.length + " accounts:\n" : "") + credBlock(list);
  return fit(head + "\n\nYour " + term + " of automatic farming starts now.", [
    "Keep it linked to your game account and do not change the password or email, or the farm stops.",
    "Details are in this offer's delivery instructions.",
    "Any problem, reply here first.",
  ]);
}

// --- The long guide, for offer.instruction ------------------------------
// This is what the 300-char message points at. No length limit applies, and it
// is rendered on PlayerAuctions' own order page, so the twitch.tv link is fine
// here even though a URL inside a chat message is the kind of thing a
// marketplace filters.
function bundleInstruction() {
  return [
    "HOW TO CLAIM YOUR DROPS",
    "",
    "1. Log in to the Twitch account with the username and password sent to you in the order messages.",
    "2. Open https://www.twitch.tv/drops/inventory",
    '3. Scroll to the "Received" section at the bottom of the page.',
    '4. Click the purple "Connect" button under each item and follow the steps to link it to YOUR OWN game account.',
    "",
    "KEEP IT LINKED",
    "If the event is still running, more items can still land on this account — our farm keeps collecting them automatically. Leave it linked, check the drops inventory page again in a day or two, and claim anything new that has appeared.",
    "",
    "IMPORTANT",
    "Please do not change the account's password or email. Claim your items reasonably soon — drops stay claimable only for a limited time after an event ends.",
    "",
    "Any problem at all, message me here first and I will make it right. And if you are happy with the order, leaving feedback would genuinely mean a lot — it helps a small seller more than you would think. Thank you!",
  ].join("\n");
}

function farmInstruction(days, game) {
  const term = days === 365 ? "1 year" : days + " days";
  const forGame = game ? " for " + game : "";
  return [
    "AUTOMATIC TWITCH DROPS FARMING — " + term.toUpperCase(),
    "",
    "You will receive a Twitch account in the order messages. Our farm runs it for you: it watches every drop event" +
      forGame +
      " and claims the items automatically the moment they unlock. You do not have to watch any streams or do anything at all.",
    "",
    "TO COLLECT YOUR ITEMS",
    "1. Log in to the Twitch account with the credentials sent to you.",
    "2. Open https://www.twitch.tv/drops/inventory",
    '3. Under "Received", press Connect on each item to link it to your own game account.',
    "4. Repeat whenever a new event finishes — new items appear on their own.",
    "",
    "KEEP THE FARM RUNNING",
    "Do not change the account's password or email. If you do, the automatic farm stops working and the remaining term cannot be refunded.",
    "",
    "WHAT IS GUARANTEED",
    "All events running during your " +
      term +
      " are collected automatically. Items are guaranteed for events lasting at least 24 hours; shorter events and periods with no active events cannot be guaranteed. Each account is sold to one buyer only.",
    "",
    "Any problem at all, message me here first and I will make it right.",
  ].join("\n");
}

// --- Chunking, for orders too large for one message ---------------------
// A buyer can order several units at once, and past roughly nine accounts the
// credentials alone exceed 300 characters — at which point a single-message
// hand-over is impossible, not merely tight. Rather than fail the delivery,
// split the credentials across as few messages as possible and put the
// explanatory sentence on the last one.
//
// The caller MUST send every message before confirming delivery, and must
// reserve the accounts before sending, so that a failure part-way through
// resends the same credentials instead of claiming fresh ones.
function deliveryMessages(accounts, { kind = "bundle", days, game } = {}) {
  const list = Array.isArray(accounts) ? accounts : [accounts];
  const single =
    kind === "farm"
      ? farmDeliveryMessage(list, days, game)
      : bundleDeliveryMessage(list);
  if (single.length <= LIMIT) return [single];

  // Pack greedily: a header naming the range, then as many credentials as fit.
  const out = [];
  let i = 0;
  while (i < list.length) {
    const start = i;
    let body = "";
    let taken = 0;
    while (i < list.length) {
      const line = i + 1 + ") " + credLine(list[i]);
      const header =
        "Accounts " + (start + 1) + "-" + (i + 1) + " of " + list.length + ":\n";
      const next = body ? body + "\n" + line : line;
      if ((header + next).length > LIMIT) break;
      body = next;
      taken++;
      i++;
    }
    // A single credential longer than the whole budget cannot be sent at all.
    if (!taken) {
      throw new Error(
        "PlayerAuctions: credential for " + list[i].login +
          " does not fit in a " + LIMIT + "-character message",
      );
    }
    out.push(
      "Accounts " + (start + 1) + "-" + i + " of " + list.length + ":\n" + body,
    );
  }

  // Tail note on its own message when there is room for a useful one.
  const note =
    kind === "farm"
      ? "Your " + (days === 365 ? "1 year" : days + " days") +
        " of automatic farming starts now. Keep the accounts linked and do not " +
        "change any passwords or emails. Details are in this offer's delivery " +
        "instructions."
      : "Log in on Twitch, open Drops & Rewards > Inventory, and press Connect " +
        "under each item to link it to your own game account. Full steps are in " +
        "this offer's delivery instructions.";
  out.push(note.slice(0, LIMIT));
  return out;
}

module.exports = {
  LIMIT,
  fit,
  credLine,
  credBlock,
  bundleDeliveryMessage,
  farmDeliveryMessage,
  deliveryMessages,
  bundleInstruction,
  farmInstruction,
};
