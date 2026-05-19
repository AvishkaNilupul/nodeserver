module.exports = {

  // =========================
  // Server
  // =========================

  PORT:
    process.env.PORT || 3000,

  // =========================
  // Admin Keys
  // =========================

  ADMIN_KEY:
    "Avishka123",

  ADMIN_PANEL_PASSWORD:
    "AvishkaAdmin",

  // =========================
  // MongoDB
  // =========================

  MONGO_URI:

    "mongodb://avishka:Avishka123@ac-ufnccre-shard-00-00.vsigmq3.mongodb.net:27017,ac-ufnccre-shard-00-01.vsigmq3.mongodb.net:27017,ac-ufnccre-shard-00-02.vsigmq3.mongodb.net:27017/codesDB?ssl=true&replicaSet=atlas-ur8a1h-shard-0&authSource=admin&appName=redeemer"

};