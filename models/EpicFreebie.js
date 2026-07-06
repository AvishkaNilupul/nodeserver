const mongoose = require("mongoose");

const epicFreebieSchema = new mongoose.Schema(
  {
    offerId: { type: String, required: true, unique: true, index: true },
    namespace: { type: String, default: "" },
    title: { type: String, default: "" },
    description: { type: String, default: "" },
    image: { type: String, default: "" },
    url: { type: String, default: "" },
    originalPrice: { type: String, default: "" },
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null, index: true },
    upcoming: { type: Boolean, default: false, index: true },
    active: { type: Boolean, default: true, index: true },
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    notifiedAt: { type: Date, default: null },
    liveNotifiedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model("EpicFreebie", epicFreebieSchema);
