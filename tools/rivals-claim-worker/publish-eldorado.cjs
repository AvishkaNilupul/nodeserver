// Operator-only publication using the established side-process cookie guards.
// Never prints delivery entries, inbox addresses, passwords or request bodies.
require("dotenv").config({ quiet: true });
const axios = require("axios");
const counts = { refreshBlocked: 0, cookiesStripped: 0, settingsWrites: 0 };
axios.interceptors.request.use((config) => {
  if (String(config.url).includes("/authentication/refreshTokens")) {
    counts.refreshBlocked++;
    throw Error("Session refresh is reserved to the main process");
  }
  return config;
});
axios.interceptors.response.use((response) => {
  if (
    String(response.config.url).includes("eldorado.gg") &&
    response.headers?.["set-cookie"]
  ) {
    counts.cookiesStripped++;
    delete response.headers["set-cookie"];
  }
  return response;
});
const settings = require("../../utils/settings");
settings.saveSettings = () => {
  counts.settingsWrites++;
  throw Error("Side-process settings writes are disabled");
};
async function main() {
  const [action, id] = process.argv.slice(2);
  if (
    !["--check", "--publish"].includes(action) ||
    !require("../../utils/rivalsAccounts").validId(id)
  )
    throw Error("Usage: publish-eldorado.cjs --check|--publish PREPARATION_ID");
  const mongoose = require("mongoose");
  await mongoose.connect(process.env.MONGO_URI, {
    autoIndex: false,
    serverSelectionTimeoutMS: 10000,
  });
  try {
    const sales = require("../../utils/rivalsSales");
    const result =
      action === "--publish"
        ? await sales.publish(id, "rivals-operator")
        : await sales.checkDelivery(id);
    console.log(JSON.stringify({ success: true, result, guards: counts }));
  } finally {
    await mongoose.disconnect();
  }
}
if (require.main === module)
  main().catch((e) => {
    console.error(
      JSON.stringify({
        success: false,
        message: e.user
          ? e.message
          : "Operation stopped; inspect preparation state before retrying",
        guards: counts,
      }),
    );
    process.exitCode = 1;
  });
