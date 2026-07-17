const mongoose = require("mongoose");

// Guest access codes for the public Japanese learning page (/learn). An admin
// generates a code for a friend; the code is both their login and the key
// their study progress is stored under (JapaneseProgress adminId "learn:<code>"),
// so the admin can watch each guest's progress from the Students tab.
const japaneseAccessCodeSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, index: true },
    label: { type: String, default: "" },
    active: { type: Boolean, default: true },
    createdBy: { type: String, default: "" },
    lastActiveAt: { type: Number, default: 0 },
  },
  { timestamps: true },
);

module.exports = mongoose.model("JapaneseAccessCode", japaneseAccessCodeSchema);
