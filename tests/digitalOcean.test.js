// Unit tests for utils/digitalOcean — the DigitalOcean droplet creator ported
// from the standalone twitch-dupe tool. The network is always stubbed via
// __setRequestForTests, so these never touch the real DO API and never create
// or destroy a real droplet.

// Config load has to be hermetic — config.js reads the environment when first
// required (it throws on a missing ADMIN_KEY / MONGO_URI), so mirror the other
// unit tests and provide them before requiring anything.
process.env.ADMIN_KEY = process.env.ADMIN_KEY || "test-admin-key";
process.env.MONGO_URI = process.env.MONGO_URI || "mongodb://localhost/test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const config = require("../config/config");
const doTool = require("../utils/digitalOcean");

// Give every test a known DO config, restored afterwards.
function withConfig(overrides, fn) {
  const before = { ...config.DIGITALOCEAN };
  Object.assign(config.DIGITALOCEAN, overrides);
  return (async () => {
    try {
      return await fn();
    } finally {
      // Restore each key we know about.
      for (const k of Object.keys(config.DIGITALOCEAN)) {
        delete config.DIGITALOCEAN[k];
      }
      Object.assign(config.DIGITALOCEAN, before);
    }
  })();
}

// ---------------------------- buildUserData ------------------------------

test("buildUserData with a bot deploys node/pm2/venv and runs the bot", () => {
  const script = doTool.buildUserData("QkFTRTY0Qk9EWQ=="); // "BASE64BODY"
  assert.match(script, /^#!\/bin\/bash/, "starts with a shebang");
  assert.match(script, /QkFTRTY0Qk9EWQ==/, "embeds the base64 bot body");
  assert.match(script, /npm install -g pm2/);
  assert.match(script, /pip install --quiet 'python-telegram-bot'/);
  assert.match(script, /pm2 start \.\/start\.sh --name twitch-claim/);
  assert.match(script, /touch \/root\/twitch-deploy-DONE/, "drops the sentinel");
});

test("buildUserData without a bot is a bare box (sentinel, no pm2/pip)", () => {
  const script = doTool.buildUserData(null);
  assert.match(script, /^#!\/bin\/bash/);
  assert.match(script, /touch \/root\/twitch-deploy-DONE/, "still lights phase 4");
  assert.doesNotMatch(script, /pm2/, "no pm2 on a bare box");
  assert.doesNotMatch(script, /pip install/, "no python deps on a bare box");
});

// ---------------------------- publicIp / mapDroplet ----------------------

test("publicIp returns the public v4 and null when there is none", () => {
  const withPublic = {
    networks: {
      v4: [
        { type: "private", ip_address: "10.0.0.2" },
        { type: "public", ip_address: "203.0.113.7" },
      ],
    },
  };
  assert.equal(doTool.publicIp(withPublic), "203.0.113.7");
  assert.equal(doTool.publicIp({ networks: { v4: [] } }), null);
  assert.equal(doTool.publicIp({}), null);
});

test("mapDroplet flattens the DO shape to the UI shape", () => {
  const mapped = doTool.mapDroplet({
    id: 123,
    name: "twitch-dupe-0923-101112",
    status: "active",
    region: { slug: "nyc1" },
    size_slug: "s-2vcpu-4gb",
    created_at: "2026-09-23T10:11:12Z",
    tags: ["twitch-dupe"],
    networks: { v4: [{ type: "public", ip_address: "203.0.113.7" }] },
  });
  assert.deepEqual(mapped, {
    id: 123,
    name: "twitch-dupe-0923-101112",
    status: "active",
    region: "nyc1",
    size: "s-2vcpu-4gb",
    ip: "203.0.113.7",
    created_at: "2026-09-23T10:11:12Z",
    tags: ["twitch-dupe"],
  });
});

// ---------------------------- readBotScriptBase64 ------------------------

test("readBotScriptBase64 base64-encodes the file at the given path", () => {
  const tmp = path.join(os.tmpdir(), `do-bot-${Date.now()}.py`);
  fs.writeFileSync(tmp, "print('hi')\n");
  try {
    assert.equal(
      doTool.readBotScriptBase64(tmp),
      Buffer.from("print('hi')\n").toString("base64"),
    );
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("readBotScriptBase64 throws an actionable error when unset or missing", () => {
  assert.throws(() => doTool.readBotScriptBase64(""), /DO_BOT_SCRIPT_PATH/);
  assert.throws(
    () => doTool.readBotScriptBase64("/no/such/bot.py"),
    /Cannot read bot script/,
  );
});

// ---------------------------- isConfigured -------------------------------

test("isConfigured reflects whether a token is set", async () => {
  await withConfig({ token: "" }, () => assert.equal(doTool.isConfigured(), false));
  await withConfig({ token: "dop_v1_x" }, () =>
    assert.equal(doTool.isConfigured(), true),
  );
});

test("an API call with no token fails closed (NOT_CONFIGURED)", async () => {
  await withConfig({ token: "" }, async () => {
    doTool.__setRequestForTests(null); // real request path — token check first
    await assert.rejects(doTool.listDroplets(), /not configured/i);
  });
});

// ---------------------------- createDroplet ------------------------------

test("createDroplet builds the right body and returns id/name (bare box)", async (t) => {
  await withConfig(
    {
      token: "dop_v1_x",
      sshKeyId: "12345678",
      defaultRegion: "nyc1",
      defaultSize: "m-2vcpu-16gb",
      defaultImage: "ubuntu-24-04-x64",
    },
    async () => {
      let captured = null;
      doTool.__setRequestForTests(async (method, apiPath, { body } = {}) => {
        captured = { method, apiPath, body };
        return { status: 202, data: { droplet: { id: 999, name: body.name } } };
      });
      t.after(() => doTool.__setRequestForTests(null));

      const out = await doTool.createDroplet({ deployBot: false });
      assert.equal(out.id, 999);
      assert.equal(out.deployedBot, false);
      assert.equal(captured.method, "POST");
      assert.equal(captured.apiPath, "/droplets");
      assert.equal(captured.body.region, "nyc1");
      assert.equal(captured.body.size, "m-2vcpu-16gb");
      assert.equal(captured.body.image, "ubuntu-24-04-x64");
      assert.deepEqual(captured.body.ssh_keys, [12345678], "ssh key id coerced to number");
      assert.deepEqual(captured.body.tags, ["twitch-dupe"]);
      assert.equal(captured.body.monitoring, true);
      assert.match(captured.body.name, /^twitch-dupe-\d{4}-\d{6}$/);
      assert.match(captured.body.user_data, /twitch-deploy-DONE/);
      assert.doesNotMatch(captured.body.user_data, /pm2/, "bare box has no bot");
    },
  );
});

test("createDroplet honours explicit overrides and embeds the bot", async (t) => {
  const tmp = path.join(os.tmpdir(), `do-bot-${Date.now()}.py`);
  fs.writeFileSync(tmp, "print('bot')\n");
  await withConfig(
    { token: "dop_v1_x", sshKeyId: "1", botScriptPath: tmp },
    async () => {
      let captured = null;
      doTool.__setRequestForTests(async (method, apiPath, { body } = {}) => {
        captured = { body };
        return { status: 202, data: { droplet: { id: 7, name: body.name } } };
      });
      t.after(() => {
        doTool.__setRequestForTests(null);
        fs.unlinkSync(tmp);
      });

      const out = await doTool.createDroplet({
        region: "fra1",
        size: "s-2vcpu-2gb",
        name: "my-box",
        deployBot: true,
      });
      assert.equal(out.name, "my-box");
      assert.equal(out.deployedBot, true);
      assert.equal(captured.body.region, "fra1");
      assert.equal(captured.body.size, "s-2vcpu-2gb");
      assert.equal(captured.body.name, "my-box");
      const b64 = Buffer.from("print('bot')\n").toString("base64");
      assert.ok(captured.body.user_data.includes(b64), "user_data embeds the bot b64");
    },
  );
});

test("createDroplet with deployBot and no script path rejects clearly", async (t) => {
  await withConfig({ token: "dop_v1_x", botScriptPath: "" }, async () => {
    doTool.__setRequestForTests(async () => {
      throw new Error("network must not be reached");
    });
    t.after(() => doTool.__setRequestForTests(null));
    await assert.rejects(
      doTool.createDroplet({ deployBot: true }),
      /DO_BOT_SCRIPT_PATH/,
    );
  });
});

test("createDroplet surfaces a DO 4xx as an error", async (t) => {
  await withConfig({ token: "dop_v1_x" }, async () => {
    doTool.__setRequestForTests(async () => ({
      status: 422,
      data: { message: "invalid size" },
    }));
    t.after(() => doTool.__setRequestForTests(null));
    await assert.rejects(doTool.createDroplet({ deployBot: false }), /HTTP 422/);
  });
});

// ---------------------------- listDroplets -------------------------------

test("listDroplets maps and sorts newest-first", async (t) => {
  await withConfig({ token: "dop_v1_x" }, async () => {
    doTool.__setRequestForTests(async () => ({
      status: 200,
      data: {
        droplets: [
          {
            id: 1,
            name: "old",
            status: "active",
            region: { slug: "nyc1" },
            size_slug: "s-2vcpu-4gb",
            created_at: "2026-09-20T00:00:00Z",
            networks: { v4: [] },
          },
          {
            id: 2,
            name: "new",
            status: "new",
            region: { slug: "fra1" },
            size_slug: "s-2vcpu-2gb",
            created_at: "2026-09-23T00:00:00Z",
            networks: { v4: [{ type: "public", ip_address: "203.0.113.9" }] },
          },
        ],
      },
    }));
    t.after(() => doTool.__setRequestForTests(null));

    const list = await doTool.listDroplets();
    assert.equal(list.length, 2);
    assert.equal(list[0].name, "new", "newest first");
    assert.equal(list[0].ip, "203.0.113.9");
    assert.equal(list[1].name, "old");
  });
});

// ---------------------------- destroyDroplet -----------------------------

test("destroyDroplet treats 204 and 404 as success, 5xx as error", async (t) => {
  await withConfig({ token: "dop_v1_x" }, async () => {
    doTool.__setRequestForTests(async () => ({ status: 204, data: "" }));
    assert.deepEqual(await doTool.destroyDroplet(1), { ok: true, statusCode: 204 });

    doTool.__setRequestForTests(async () => ({ status: 404, data: "" }));
    assert.deepEqual(await doTool.destroyDroplet(2), { ok: true, statusCode: 404 });

    doTool.__setRequestForTests(async () => ({
      status: 500,
      data: { message: "boom" },
    }));
    t.after(() => doTool.__setRequestForTests(null));
    await assert.rejects(doTool.destroyDroplet(3), /HTTP 500/);
  });
});

// ---------------------------- getAccount ---------------------------------

test("getAccount returns header fields and tolerates a balance failure", async (t) => {
  await withConfig({ token: "dop_v1_x" }, async () => {
    doTool.__setRequestForTests(async (method, apiPath) => {
      if (apiPath === "/account") {
        return {
          status: 200,
          data: {
            account: {
              email: "ops@example.com",
              droplet_limit: 25,
              status: "active",
            },
          },
        };
      }
      // balance endpoint blows up — must not blank the whole header
      return { status: 500, data: { message: "no billing scope" } };
    });
    t.after(() => doTool.__setRequestForTests(null));

    const acct = await doTool.getAccount();
    assert.equal(acct.email, "ops@example.com");
    assert.equal(acct.droplet_limit, 25);
    assert.deepEqual(acct.balance, {}, "balance failure degrades to {}");
  });
});
