const mongoose = require("mongoose");

const codeSchema = new mongoose.Schema({

  // Redeem code

  code: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true
  },

  // Account username

  account: {
    type: String,
    required: true,
    trim: true
  },

  // Account password

  password: {
    type: String,
    required: true,
    trim: true
  },

  // Locked IP

  allowedIP: {
    type: String,
    default: null,
    trim: true
  }

}, {

  timestamps: true

});

module.exports = mongoose.model(
  "Code",
  codeSchema
);