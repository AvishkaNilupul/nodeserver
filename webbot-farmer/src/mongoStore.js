// Thin Mongo layer for the webbot manager. Uses the same connection the
// nodeserver process would (MONGO_URI env), keeps the WebBotAccount model
// definition local so this project doesn't have to import nodeserver source.

import mongoose from "mongoose";

const webBotAccountSchema = new mongoose.Schema(
  {
    webToken: { type: String, required: true, unique: true, index: true },
    login: { type: String, default: "", index: true },
    twitchId: { type: String, default: "" },
    credUsername: { type: String, default: "" },
    credPasswordEnc: { type: String, default: "" },
    hasPassword: { type: Boolean, default: false },
    enabled: { type: Boolean, default: true, index: true },
    host: { type: String, default: "webbot", index: true },
    lastStatus: {
      type: String,
      enum: ["pending", "ok", "attaching", "dead", "idle", "error"],
      default: "pending",
      index: true,
    },
    lastStatusMessage: { type: String, default: "" },
    lastCheckedAt: { type: Date, default: null, index: true },
    currentGame: { type: String, default: "" },
    currentChannel: { type: String, default: "" },
    currentDropId: { type: String, default: "" },
    currentMinutes: { type: Number, default: 0 },
    requiredMinutes: { type: Number, default: 0 },
    totalMinutesWatched: { type: Number, default: 0 },
    dropsClaimed: { type: Number, default: 0 },
    lastClaimAt: { type: Date, default: null },

    // Web tokens can't clear Twitch's integrity gate on ClaimDropRewards, so
    // this farmer progresses drops but can't claim them. When that's detected
    // the account is flagged here and the ready-but-unclaimed count recorded,
    // so an integrity-valid rig (or a human) can claim them externally.
    claimBlocked: { type: Boolean, default: false, index: true },
    dropsReadyUnclaimed: { type: Number, default: 0 },
    fromPool: { type: Boolean, default: false, index: true },

    pinnedGame: { type: String, default: "" },
  },
  { timestamps: true },
);

export const WebBotAccount =
  mongoose.models.WebBotAccount ||
  mongoose.model("WebBotAccount", webBotAccountSchema);

let connected = false;
export async function connect(uri = process.env.MONGO_URI) {
  if (connected) return mongoose.connection;
  if (!uri) throw new Error("MONGO_URI not set");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  connected = true;
  return mongoose.connection;
}

export async function disconnect() {
  if (!connected) return;
  await mongoose.disconnect();
  connected = false;
}

export async function loadActiveAccounts() {
  return WebBotAccount.find({
    enabled: true,
    lastStatus: { $ne: "dead" },
  }).lean();
}

export async function importAccountsFromLines(lines) {
  // Accept "user:pass:webtoken", "user:webtoken", or bare "webtoken".
  const created = [];
  const updated = [];
  const skipped = [];
  for (const raw of lines) {
    const line = String(raw || "").trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(":");
    let user = "";
    let pass = "";
    let token = "";
    if (parts.length >= 3) {
      user = parts[0];
      pass = parts[1];
      token = parts[2];
    } else if (parts.length === 2) {
      user = parts[0];
      token = parts[1];
    } else {
      token = parts[0];
    }
    if (!token || token.length < 20) {
      skipped.push({ line, reason: "bad token" });
      continue;
    }
    const existing = await WebBotAccount.findOne({ webToken: token });
    if (existing) {
      updated.push(token.slice(-6));
      continue;
    }
    await WebBotAccount.create({
      webToken: token,
      credUsername: user,
      credPasswordEnc: pass ? "plain:" + pass : "",
      hasPassword: !!pass,
      enabled: true,
    });
    created.push(token.slice(-6));
  }
  return { created, updated, skipped };
}

export async function writeState(webToken, patch) {
  if (!connected) return; // no-op when run without a DB (e.g. load tests)
  patch.lastCheckedAt = new Date();
  await WebBotAccount.updateOne({ webToken }, { $set: patch });
}

export async function bumpClaim(webToken) {
  if (!connected) return; // no-op when run without a DB (e.g. load tests)
  await WebBotAccount.updateOne(
    { webToken },
    { $inc: { dropsClaimed: 1 }, $set: { lastClaimAt: new Date() } },
  );
}
