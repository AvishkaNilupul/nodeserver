const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    sellerId: { type: String, required: true, index: true },
    sender: { type: String, enum: ["user", "admin"], required: true },
    message: { type: String, required: true },
    readByAdmin: { type: Boolean, default: false },
    seen: { type: Boolean, default: false },
  },
  { timestamps: true }
);

messageSchema.index({ sellerId: 1, userId: 1, createdAt: 1 });

module.exports = mongoose.model("Message", messageSchema);
