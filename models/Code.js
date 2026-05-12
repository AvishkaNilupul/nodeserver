const mongoose = require("mongoose");

const codeSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },

  account: String,
  password: String,

  allowedIP: { type: String, default: null }
});

module.exports = mongoose.model("Code", codeSchema);