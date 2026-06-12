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
  ADMIN_KEY: required("Avishka123"),

  // MongoDB connection string
  MONGO_URI: required("mongodb://avishka:Avishka123@ac-ufnccre-shard-00-00.vsigmq3.mongodb.net:27017,ac-ufnccre-shard-00-01.vsigmq3.mongodb.net:27017,ac-ufnccre-shard-00-02.vsigmq3.mongodb.net:27017/codesDB?ssl=true&replicaSet=atlas-ur8a1h-shard-0&authSource=admin&appName=redeemer"),
};