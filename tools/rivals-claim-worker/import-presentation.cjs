const fs = require("node:fs/promises"),
  path = require("node:path");
async function main() {
  require("dotenv").config({ quiet: true });
  const [id, assets, auditPath] = process.argv.slice(2);
  if (
    !require("../../utils/rivalsAccounts").validId(id) ||
    !assets ||
    !auditPath
  )
    throw Error(
      "Usage: import-presentation.cjs ID ASSET_DIR TWITCH_AUDIT_JSON",
    );
  const m = require("mongoose");
  await m.connect(process.env.MONGO_URI, {
    autoIndex: false,
    serverSelectionTimeoutMS: 10000,
  });
  try {
    const audit = JSON.parse(await fs.readFile(auditPath, "utf8"));
    const result =
      await require("../../utils/rivalsPresentation").importPresentation(
        m.connection.db,
        id,
        assets,
        audit,
        process.env.RIVALS_PROOF_DIR ||
          path.resolve(__dirname, "../../.rivals-proof"),
      );
    console.log(JSON.stringify(result));
  } finally {
    await m.disconnect();
  }
}
if (require.main === module)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
