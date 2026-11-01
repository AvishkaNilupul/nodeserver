// Private SSH import command for Steam accounts made on the Mac. The Mac's
// upload queue (tools/steam-signup/cloud-sync.cjs) runs this on the server with
// one account as JSON on stdin. No HTTP route or website session is involved.
// Contract: docs/STEAM-ACCOUNTS.md.
const COUNTRY = /^[A-Z]{2}$/;
const LIMITS = { localId: 64, accountName: 64, password: 256, email: 254, proxyCity: 100 };

function country(value) {
  return typeof value === "string" && COUNTRY.test(value) ? value : null;
}

function validate(payload) {
  const a = payload?.account;
  if (payload?.version !== 1 || !a || typeof a !== "object") throw Error("Invalid account");
  for (const [key, max] of Object.entries(LIMITS)) {
    const v = a[key];
    if (v !== undefined && v !== null && (typeof v !== "string" || v.length > max || v.includes("\0") || v.startsWith("enc:")))
      throw Error("Invalid field");
  }
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(a.localId || "")) throw Error("Invalid account id");
  if (!/^[A-Za-z0-9_]{3,64}$/.test(a.accountName || "")) throw Error("Invalid account name");
  if (!a.password) throw Error("Incomplete account");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email || "")) throw Error("Invalid email");
  const signedUpAt = a.signedUpAt && !Number.isNaN(Date.parse(a.signedUpAt)) ? new Date(a.signedUpAt) : null;
  return {
    localId: a.localId,
    accountName: a.accountName,
    password: a.password,
    email: a.email.toLowerCase(),
    signupCountry: country(a.signupCountry),
    requestedCountry: country(a.requestedCountry),
    proxyCountry: country(a.proxyCountry),
    proxyCity: typeof a.proxyCity === "string" ? a.proxyCity : "",
    signedUpAt,
  };
}

async function importAccount({ payload, collection, encrypt, now = () => new Date() }) {
  const a = validate(payload);
  const time = now();
  // Only an insert may set anything. A retry or a second upload of the same
  // account must never overwrite games, region checks, stage or notes that
  // were edited on the server.
  const document = {
    localId: a.localId,
    accountName: a.accountName,
    password: encrypt(a.password),
    email: encrypt(a.email),
    signupCountry: a.signupCountry,
    requestedCountry: a.requestedCountry,
    proxyCountry: a.proxyCountry,
    proxyCity: a.proxyCity,
    storeCountry: null,
    steamId64: "",
    games: [],
    stage: "stock",
    notes: "",
    soldAt: null,
    soldNote: "",
    source: "generator",
    signedUpAt: a.signedUpAt,
    importedAt: time,
    createdAt: time,
    updatedAt: time,
  };
  let result;
  try {
    result = await collection.updateOne({ localId: a.localId }, { $setOnInsert: document }, { upsert: true });
  } catch (e) {
    if (e.code !== 11000) throw e;
    result = { upsertedCount: 0 };
  }
  const saved = await collection.findOne({ localId: a.localId }, { projection: { _id: 1, accountName: 1 } });
  if (!saved) throw Error("Import not persisted");
  return {
    success: true,
    localId: a.localId,
    cloudId: String(saved._id),
    accountName: saved.accountName,
    inserted: result.upsertedCount === 1,
  };
}

if (require.main === module) {
  const mongoose = require("mongoose");
  (async () => {
    try {
      require("dotenv").config({ quiet: true });
      let text = "";
      for await (const chunk of process.stdin) {
        text += chunk;
        if (Buffer.byteLength(text) > 65536) throw Error("Payload too large");
      }
      const payload = JSON.parse(text);
      validate(payload);
      await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      const result = await importAccount({
        payload,
        collection: mongoose.connection.db.collection("steamaccounts"),
        encrypt: require("../../utils/secretBox").encrypt,
      });
      console.log(JSON.stringify(result));
    } catch {
      console.log(JSON.stringify({ success: false, message: "Steam import could not be completed" }));
      process.exitCode = 1;
    } finally {
      await mongoose.disconnect();
    }
  })();
}

module.exports = { importAccount, validate };
