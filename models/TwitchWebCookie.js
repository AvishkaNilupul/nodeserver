const mongoose = require("mongoose");

// One doc per Twitch login — the full twitch.tv cookie jar harvested via the
// Cookie-Editor hybrid userscript, encrypted via utils/secretBox. These jars
// drive id.twitch.tv/oauth2/authorize when auto-renewing a linked SOOP
// account. See utils/twitchOauthRefresher.js for consumer, utils/
// soopCookieRefresher.js for the periodic driver.
const twitchWebCookieSchema = new mongoose.Schema(
  {
    twitchLogin: {
      type: String,
      required: true,
      unique: true,
      index: true,
      lowercase: true,
      trim: true,
    },
    // Encrypted JSON array in cookie-editor shape. Never log plaintext.
    cookies: { type: String, required: true },
    cookieCount: { type: Number, default: 0 },
    // Session is "short-lived" when the httpOnly `persistent` cookie never
    // dropped — those captures authenticate but die in days instead of months.
    shortLived: { type: Boolean, default: false },
    // Cached timestamps lifted off the two cookies that gate real lifespan,
    // so the admin UI can colour an "expires in Xd" chip without decrypting.
    persistentExpiresAt: { type: Date, default: null },
    authTokenExpiresAt: { type: Date, default: null },
    harvestedAt: { type: Date, default: Date.now, index: true },
    source: { type: String, default: "" },
  },
  { timestamps: true },
);

module.exports = mongoose.model("TwitchWebCookie", twitchWebCookieSchema);
