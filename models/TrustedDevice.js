const mongoose = require("mongoose");

// A browser an admin chose to "remember" at login (utils/trustedDevices.js).
// The browser keeps a random secret in an httpOnly cookie; only the secret's
// SHA-256 hash is stored here, so a copy of this collection can't be replayed
// as a login.
const trustedDeviceSchema = new mongoose.Schema(
  {
    adminId: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true },
    // Fingerprint of the admin's password hash at the moment the device was
    // trusted. Changing the password changes it, which signs every remembered
    // device out.
    pwFingerprint: { type: String, required: true },
    // True when the login that trusted this device passed the 2FA code step.
    // A device trusted before 2FA was turned on is not let back in.
    viaTotp: { type: Boolean, default: false },
    label: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    createdIp: { type: String, default: "" },
    lastIp: { type: String, default: "" },
    lastUsedAt: { type: Date, default: Date.now },
    // Pushed forward every time the device signs in. Mongo's TTL monitor
    // deletes the row once it passes (an unused device is forgotten).
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true },
);

module.exports = mongoose.model("TrustedDevice", trustedDeviceSchema);
