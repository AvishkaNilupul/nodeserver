const mongoose = require("mongoose");

const codeSchema = new mongoose.Schema({

  code: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true
  },

  account: {
    type: String,
    required: true,
    trim: true
  },

  password: {
    type: String,
    required: true,
    trim: true
  },

  // First redeem timestamp

  redeemedAt: {
    type: Date,
    default: null
  }

}, {
  timestamps: true
});

module.exports = mongoose.model(
  "Code",
  codeSchema
);