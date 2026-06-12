require("dotenv").config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

module.exports = {
  // Server
  PORT: process.env.PORT || 3000,

  // Admin key used to gate redeem-code generation (/generate)
  ADMIN_KEY: required("ADMIN_KEY"),

  // MongoDB connection string
  MONGO_URI: required("MONGO_URI"),
};