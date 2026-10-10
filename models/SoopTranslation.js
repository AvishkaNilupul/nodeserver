const mongoose = require("mongoose");

// A hand-written English text for one exact SOOP string (a campaign title, an
// item name, a category). Checked before the glossary in utils/soop/i18n.js.
const soopTranslationSchema = new mongoose.Schema(
  {
    source: { type: String, required: true, unique: true },
    english: { type: String, default: "" },
  },
  { timestamps: true },
);

module.exports = mongoose.model("SoopTranslation", soopTranslationSchema);
