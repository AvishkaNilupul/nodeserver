"use strict";

// Which bot host runs the no-claim farm (its noclaim-bot-* containers and
// /home/ubuntu/twitchbot-noclaim). One place for it: noclaimFleet,
// unclaimedAutoList, noclaimWatcher and systemHealth all read it from here.
//
// Set with NOCLAIM_HOST_ID in .env (a host id from config/botHosts.json).
// .env is loaded here too, with an explicit path, so a one-off script run
// without server.js sees the same host as the app instead of falling back to
// the default and acting on the wrong machine.
//
// The default "contabo" is where the farm lived from 2026-09-14 to 2026-10-21.
const path = require("path");

try {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
} catch {
  /* no dotenv: the environment is used as it is */
}

const DEFAULT_HOST_ID = "contabo";

function noclaimHostId(env = process.env) {
  const v = String((env && env.NOCLAIM_HOST_ID) || "").trim();
  return v || DEFAULT_HOST_ID;
}

const HOST_ID = noclaimHostId();

module.exports = { HOST_ID, DEFAULT_HOST_ID, noclaimHostId };
